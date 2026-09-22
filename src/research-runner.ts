/**
 * 严格研究 runner：只读 research/ 协议，不读取旧 data/daily，也不调用任何模型。
 *
 * 每个样本的时间顺序是：
 *   T 日 PIT 股票池 -> T 日 14:45 之前的 1m -> ask 入场 -> T+1 09:30~10:00 bid 出场。
 * 训练、验证、测试只按 manifest 切分；跨边界的标签直接丢弃。
 */
import { buyCosts, sellCosts } from "./costs";
import { defaultFactorParams, scoreStock, type FactorParams, type Scored } from "./factors";
import { buildResearchSnapshot, researchFeatures, simulateMinuteExit } from "./research-engine";
import {
  dateInRange,
  listResearchDates,
  loadDailyBars,
  loadMinuteBars,
  loadUniverseSnapshot,
  splitForTrade,
  type DateRange,
  type ResearchDailyBar,
  type ResearchManifest,
  type ResearchMinuteBar,
  type ResearchSplitName,
  type ResearchUniverseSnapshot,
} from "./research";
import { config } from "./config";
import { limitDown, round2, sharesForBudget } from "./symbols";

export type ResearchRunSplit = ResearchSplitName | "all";

export interface ResearchRunnerOptions {
  split?: ResearchRunSplit;
  k?: number;
  sizeCny?: number;
  gapTrimPct?: number;
  stopLossPct?: number;
  factorParams?: FactorParams;
}

export interface ResearchRunnerLoader {
  listDates(): Promise<string[]>;
  loadUniverse(date: string): Promise<ResearchUniverseSnapshot>;
  loadDaily(code: string): Promise<ResearchDailyBar[]>;
  loadMinutes(date: string, code: string): Promise<ResearchMinuteBar[]>;
}

export interface ResearchTrade {
  split: ResearchSplitName;
  code: string;
  name: string;
  entryDate: string;
  exitDate: string;
  entryTime: "14:45";
  exitTime: string;
  score: number;
  entry: number;
  exit: number;
  qty: number;
  grossBps: number;
  netBps: number;
  costYuan: number;
  exitNote: string;
}

export interface ResearchSplitMetrics {
  split: ResearchSplitName;
  entryDays: number;
  candidates: number;
  selected: number;
  trades: number;
  censored: number;
  boundaryExcluded: number;
  grossBps: number;
  netBps: number;
  winRate: number;
  totalCostYuan: number;
  notionalYuan: number;
  tradesDetail: ResearchTrade[];
}

export interface ResearchBacktestReport {
  dataset: string;
  entryTime: "14:45";
  exitDeadline: "10:00";
  parameters: {
    k: number;
    sizeCny: number;
    gapTrimPct: number;
    stopLossPct: number;
    factor: FactorParams;
  };
  splits: Record<ResearchSplitName, ResearchSplitMetrics>;
}

function emptySplit(split: ResearchSplitName): ResearchSplitMetrics {
  return {
    split,
    entryDays: 0,
    candidates: 0,
    selected: 0,
    trades: 0,
    censored: 0,
    boundaryExcluded: 0,
    grossBps: 0,
    netBps: 0,
    winRate: 0,
    totalCostYuan: 0,
    notionalYuan: 0,
    tradesDetail: [],
  };
}

function previousBar(bars: ResearchDailyBar[], date: string): ResearchDailyBar | undefined {
  return bars.filter((b) => b.date < date).at(-1);
}

function exactBar(bars: ResearchDailyBar[], date: string): ResearchDailyBar | undefined {
  return bars.find((b) => b.date === date);
}

function assertPreviousClose(entryCode: string, entryDate: string, expected: number, bars: ResearchDailyBar[]) {
  const prev = previousBar(bars, entryDate);
  if (!prev || !(prev.close > 0)) throw new Error(`${entryCode} ${entryDate} 缺少 PIT 昨收日线`);
  if (!(expected > 0) || Math.abs(prev.close - expected) > 0.011)
    throw new Error(`${entryCode} ${entryDate} 股票池昨收与 raw daily 不一致：${expected} != ${prev.close}`);
}

function paramsFor14h45(options: ResearchRunnerOptions): FactorParams {
  // 09:30~11:30 120 分钟 + 13:00~14:45 105 分钟，不能把午休重复计入节奏。
  return { ...defaultFactorParams(), sessionElapsedMin: 225, ...options.factorParams };
}

function splitRanges(manifest: ResearchManifest, requested: ResearchRunSplit): [ResearchSplitName, DateRange][] {
  if (requested === "all") {
    const names: ResearchSplitName[] = ["train", "validation", "test"];
    return names.map((name): [ResearchSplitName, DateRange] => [name, manifest.splits[name]]);
  }
  return [[requested, manifest.splits[requested]]];
}

function addTradeMetrics(result: ResearchSplitMetrics, trade: ResearchTrade) {
  result.trades++;
  result.totalCostYuan = round2(result.totalCostYuan + trade.costYuan);
  result.notionalYuan = round2(result.notionalYuan + trade.entry * trade.qty);
  result.tradesDetail.push(trade);
  if (trade.netBps > 0) result.winRate = round2((result.tradesDetail.filter((t) => t.netBps > 0).length / result.trades) * 100);
  result.grossBps = result.notionalYuan > 0
    ? round2(result.tradesDetail.reduce((sum, t) => sum + (t.exit - t.entry) * t.qty, 0) / result.notionalYuan * 10_000)
    : 0;
  result.netBps = result.notionalYuan > 0
    ? round2(result.tradesDetail.reduce((sum, t) => sum + t.netBps * t.entry * t.qty / 10_000, 0) / result.notionalYuan * 10_000)
    : 0;
}

export function fileResearchLoader(manifest: ResearchManifest, dataDir = config.dataDir): ResearchRunnerLoader {
  return {
    listDates: () => listResearchDates(manifest, dataDir),
    loadUniverse: (date) => loadUniverseSnapshot(date, manifest, dataDir),
    loadDaily: (code) => loadDailyBars(code, manifest, dataDir),
    loadMinutes: (date, code) => loadMinuteBars(date, code, manifest, dataDir),
  };
}

/**
 * 运行固定参数的研究回测。这里没有 sweep/自动选参入口，避免把 test 当验证集使用。
 * 需要调参时只能先在 train 上形成版本，再锁定参数跑 validation，最后单独跑 test。
 */
export async function runResearchBacktest(
  manifest: ResearchManifest,
  loader: ResearchRunnerLoader,
  options: ResearchRunnerOptions = {},
): Promise<ResearchBacktestReport> {
  const requested = options.split ?? "all";
  const ranges = splitRanges(manifest, requested);
  const selectedSplits = new Set(ranges.map(([name]) => name));
  const result: Record<ResearchSplitName, ResearchSplitMetrics> = {
    train: emptySplit("train"),
    validation: emptySplit("validation"),
    test: emptySplit("test"),
  };
  const k = Math.max(1, Math.floor(options.k ?? config.k));
  const sizeCny = options.sizeCny ?? config.sizeCny;
  const gapTrimPct = options.gapTrimPct ?? config.gapTrimPct;
  const stopLossPct = options.stopLossPct ?? config.stopLossPct;
  const factor = paramsFor14h45(options);
  const dates = [...new Set((await loader.listDates()).sort())];
  const universeCache = new Map<string, ResearchUniverseSnapshot>();
  const dailyCache = new Map<string, ResearchDailyBar[]>();
  const minuteCache = new Map<string, ResearchMinuteBar[]>();
  const getUniverse = async (date: string) => {
    const hit = universeCache.get(date);
    if (hit) return hit;
    const value = await loader.loadUniverse(date);
    universeCache.set(date, value);
    return value;
  };
  const getDaily = async (code: string) => {
    const hit = dailyCache.get(code);
    if (hit) return hit;
    const value = await loader.loadDaily(code);
    dailyCache.set(code, value);
    return value;
  };
  const getMinutes = async (date: string, code: string) => {
    const key = `${date}/${code}`;
    const hit = minuteCache.get(key);
    if (hit) return hit;
    const value = await loader.loadMinutes(date, code);
    minuteCache.set(key, value);
    return value;
  };

  for (let i = 0; i < dates.length; i++) {
    const entryDate = dates[i]!;
    const split = (Object.keys(result) as ResearchSplitName[]).find((name) => dateInRange(entryDate, manifest.splits[name]));
    if (!split || !selectedSplits.has(split)) continue;
    const nextDate = dates[i + 1];
    const bucket = result[split];
    bucket.entryDays++;
    if (!nextDate) {
      bucket.boundaryExcluded++;
      continue;
    }
    const labelSplit = splitForTrade(manifest, entryDate, nextDate);
    if (labelSplit !== split) {
      bucket.boundaryExcluded++;
      continue;
    }

    const universe = await getUniverse(entryDate);
    const scored: { scored: Scored; entry: (typeof universe.entries)[number]; bars: ResearchMinuteBar[]; daily: ResearchDailyBar[] }[] = [];
    for (const entry of universe.entries.filter((x) => x.active)) {
      const daily = await getDaily(entry.code);
      assertPreviousClose(entry.code, entryDate, entry.prevClose ?? 0, daily);
      const bars = await getMinutes(entryDate, entry.code);
      const features = researchFeatures({ date: entryDate, code: entry.code, entry, bars });
      const scoredStock = scoreStock(features, {}, false, factor);
      if (scoredStock.rejects.length || !(features.price > 0)) continue;
      const entryAsk = buildResearchSnapshot({ date: entryDate, code: entry.code, entry, bars }).asks[0]?.p ?? 0;
      if (!(features.price > 0) || !(entryAsk > 0)) continue;
      bucket.candidates++;
      scored.push({ scored: scoredStock, entry, bars, daily });
    }
    scored.sort((a, b) => b.scored.score - a.scored.score || a.entry.code.localeCompare(b.entry.code));
    const picks = scored.slice(0, Math.min(k, config.maxDailyOpens));
    bucket.selected += picks.length;
    for (const pick of picks) {
      const entrySnapshot = buildResearchSnapshot({ date: entryDate, code: pick.entry.code, entry: pick.entry, bars: pick.bars });
      const entryPrice = entrySnapshot.asks[0]?.p ?? 0;
      const qty = sharesForBudget(entryPrice, sizeCny);
      if (!(entryPrice > 0) || qty < 100) continue;
      const entryDaily = exactBar(pick.daily, entryDate);
      if (!entryDaily || entryDaily.amountEst === true) throw new Error(`${pick.entry.code} ${entryDate} 缺少 raw 当日收盘用于 T+1 涨跌停参考`);
      const nextBars = await getMinutes(nextDate, pick.entry.code);
      const exit = simulateMinuteExit({
        bars: nextBars,
        entry: entryPrice,
        stop: round2(entryPrice * (1 - stopLossPct / 100)),
        qty,
        gapTrimPct,
        deadline: manifest.execution.exitDeadline,
        limitDown: limitDown(entryDaily.close, pick.entry.code, pick.entry.name),
      });
      if (exit.censored || exit.legs.reduce((sum, leg) => sum + leg.qty, 0) !== qty) {
        bucket.censored++;
        continue;
      }
      const buyAmount = entryPrice * qty;
      const sellAmount = exit.legs.reduce((sum, leg) => sum + leg.price * leg.qty, 0);
      const cost = buyCosts(buyAmount).total + exit.legs.reduce((sum, leg) => sum + sellCosts(leg.price * leg.qty).total, 0);
      const gross = sellAmount - buyAmount;
      const net = gross - cost;
      addTradeMetrics(bucket, {
        split,
        code: pick.entry.code,
        name: pick.entry.name,
        entryDate,
        exitDate: nextDate,
        entryTime: "14:45",
        exitTime: exit.legs.at(-1)!.time,
        score: round2(pick.scored.score),
        entry: round2(entryPrice),
        exit: round2(sellAmount / qty),
        qty,
        grossBps: round2(gross / buyAmount * 10_000),
        netBps: round2(net / buyAmount * 10_000),
        costYuan: round2(cost),
        exitNote: exit.legs.map((leg) => `${leg.time} ${leg.note}`).join(" + "),
      });
    }
  }

  return {
    dataset: manifest.dataset,
    entryTime: manifest.execution.entryTime,
    exitDeadline: manifest.execution.exitDeadline,
    parameters: { k, sizeCny, gapTrimPct, stopLossPct, factor },
    splits: result,
  };
}
