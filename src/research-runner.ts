/**
 * 严格研究 runner：只读 research/ 协议，不读取旧 data/daily；买入与持仓退出都走注入的 Jev 模型。
 *
 * 每个样本的时间顺序是：
 *   Jev 自主研究口径：T 日 PIT 股票池 -> T 日 14:45 可见 1m -> Jev 买入 ->
 *   T+1 起逐分钟先过硬止损、再由 Jev 判断卖出；未退出只记右删失。
 * 训练、验证、测试只按 manifest 切分；跨边界的标签直接丢弃。
 */
import { buyCosts, sellCosts } from "./costs";
import { defaultFactorParams, scoreStock, type FactorParams, type Scored } from "./factors";
import { buildResearchSnapshot, researchFeatures } from "./research-engine";
import { simulateJevExit } from "./research-jev";
import {
  dateInRange,
  listResearchDates,
  loadDailyBars,
  loadMinuteBars,
  loadUniverseSnapshot,
  type DateRange,
  type ResearchDailyBar,
  type ResearchManifest,
  type ResearchMinuteBar,
  type ResearchSplitName,
  type ResearchUniverseSnapshot,
} from "./research";
import { config } from "./config";
import { limitDown, round2, sharesForBudget } from "./symbols";
import type { Decision, DecisionTrace, Model, SignalState } from "./model";

export type ResearchRunSplit = ResearchSplitName | "all";

export interface ResearchRunnerOptions {
  split?: ResearchRunSplit;
  k?: number;
  sizeCny?: number;
  stopLossPct?: number;
  factorParams?: FactorParams;
  /** 研究 runner 必须显式注入 Jev；缺失时拒绝运行，绝不偷偷改用 Factor。 */
  jevModel?: Model;
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
  exitSource: "jev" | "hard-rule";
  entryTrace: DecisionTrace;
  exitTrace: DecisionTrace;
  score: number;
  entry: number;
  exit: number;
  qty: number;
  grossBps: number;
  netBps: number;
  costYuan: number;
  exitNote: string;
}

export type ResearchHoldingLabelStatus = "sold-by-jev" | "hard-stop" | "boundary-excluded" | "right-censored" | "jev-failed";

export interface ResearchHoldingLabel {
  split: ResearchSplitName;
  code: string;
  name: string;
  entryDate: string;
  entryTime: "14:45";
  entry: number;
  qty: number;
  status: ResearchHoldingLabelStatus;
  exitDate?: string;
  exitTime?: string;
  exitPrice?: number;
  exitNote?: string;
  entryTrace: DecisionTrace;
  exitTrace?: DecisionTrace;
  decisionRounds: number;
  remoteCalls: number;
  cacheHits: number;
  jevFailures: number;
  netBps?: number;
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
  labelsDetail: ResearchHoldingLabel[];
  decisionRounds: number;
  remoteCalls: number;
  cacheHits: number;
  jevFailures: number;
}

export interface ResearchBacktestReport {
  dataset: string;
  entryTime: "14:45";
  exitPolicy: "jev-autonomous";
  censoring: "right";
  parameters: {
    k: number;
    sizeCny: number;
    stopLossPct: number;
    decisionIntervalMinutes: 1;
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
    labelsDetail: [],
    decisionRounds: 0,
    remoteCalls: 0,
    cacheHits: 0,
    jevFailures: 0,
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

function buyState(date: string, candidates: Scored[], openSlots: number): SignalState {
  return {
    date,
    time: "14:45",
    horizon: "研究入口：Jev 自主决定是否买入与买入标的；T+1、涨跌停、流动性与成交价是硬边界",
    gate: { allowed: true, status: "open", reasons: ["候选已通过研究侧硬筛选"], skipped: [] },
    index: null,
    candidates,
    heldCodes: [],
    allowed: { buy: true, sell: false },
    vetoes: {},
    openSlots,
    decisionMode: "buy",
    positions: [],
  };
}

function countDecision(result: ResearchSplitMetrics, decision: Decision): void {
  result.decisionRounds++;
  if (decision.trace?.call === "remote") result.remoteCalls++;
  if (decision.trace?.call === "cache") result.cacheHits++;
  if (decision.modelFailed || decision.trace?.source !== "jev" || decision.trace.status !== "ok") result.jevFailures++;
}

function validJevDecision(decision: Decision): decision is Decision & { trace: DecisionTrace } {
  return !decision.modelFailed && decision.trace?.source === "jev" && decision.trace.status === "ok";
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
 * 运行固定参数的 Jev 自主研究回测。
 *
 * 没有 sweep/自动选参入口，避免把 test 当验证集使用；更重要的是 jevModel 必须显式传入，
 * 没有模型时直接失败，不会偷偷把 FactorModel 当成 Jev 标签生成器。
 */
export async function runResearchBacktest(
  manifest: ResearchManifest,
  loader: ResearchRunnerLoader,
  options: ResearchRunnerOptions = {},
): Promise<ResearchBacktestReport> {
  if (!options.jevModel) throw new Error("Jev 自主研究必须显式注入 jevModel；禁止回退 FactorModel 或固定退出规则");

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

  for (const entryDate of dates) {
    const split = (Object.keys(result) as ResearchSplitName[]).find((name) => dateInRange(entryDate, manifest.splits[name]));
    if (!split || !selectedSplits.has(split)) continue;
    const splitRange = manifest.splits[split];
    const bucket = result[split];
    bucket.entryDays++;
    // split 最后一个交易日没有同 split 的未来路径，不能为了凑样本去读取边界外数据。
    // 若边界外仍有数据，明确记 boundary；数据集在此结束则记右删失。
    if (!dates.some((date) => date > entryDate && date <= splitRange.to)) {
      if (dates.some((date) => date > splitRange.to)) bucket.boundaryExcluded++;
      else bucket.censored++;
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
      const entrySnapshot = buildResearchSnapshot({ date: entryDate, code: entry.code, entry, bars });
      if (!((entrySnapshot.asks[0]?.p ?? 0) > 0)) continue;
      bucket.candidates++;
      scored.push({ scored: scoredStock, entry, bars, daily });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.scored.score - a.scored.score || a.entry.code.localeCompare(b.entry.code));

    // Factor 只负责硬筛选后的候选排序/截断；最终是否买、买哪只由 Jev 决定。
    const entryDecision = await options.jevModel.decide(
      buyState(entryDate, scored.map((x) => x.scored), Math.min(k, config.maxDailyOpens)),
    );
    countDecision(bucket, entryDecision);
    if (!validJevDecision(entryDecision)) continue;
    const entryTrace = entryDecision.trace;
    const picks = entryDecision.picks
      .filter((pick) => scored.some((item) => item.scored.features.code === pick.code))
      .slice(0, Math.min(k, config.maxDailyOpens));
    bucket.selected += picks.length;

    for (const pick of picks) {
      const item = scored.find((x) => x.scored.features.code === pick.code);
      if (!item) continue;
      const entrySnapshot = buildResearchSnapshot({ date: entryDate, code: item.entry.code, entry: item.entry, bars: item.bars });
      const entryPrice = entrySnapshot.asks[0]?.p ?? 0;
      const qty = sharesForBudget(entryPrice, sizeCny);
      if (!(entryPrice > 0) || qty < 100) continue;
      const entryDaily = exactBar(item.daily, entryDate);
      if (!entryDaily || entryDaily.amountEst === true) throw new Error(`${item.entry.code} ${entryDate} 缺少 raw 当日收盘用于 T+1 涨跌停参考`);

      const futureDates = dates.filter((date) => date > entryDate && date <= splitRange.to);
      const future = [];
      for (const date of futureDates) {
        const dayBars = await getMinutes(date, item.entry.code);
        const prev = previousBar(item.daily, date);
        future.push({
          date,
          bars: dayBars,
          limitDown: prev ? limitDown(prev.close, item.entry.code, item.entry.name) : undefined,
        });
      }
      const exit = await simulateJevExit({
        entryDate,
        entryTime: "14:45",
        entry: entryPrice,
        qty,
        stop: round2(entryPrice * (1 - stopLossPct / 100)),
        code: item.entry.code,
        entryInfo: item.entry,
        future,
        model: options.jevModel,
        decisionIntervalMinutes: manifest.execution.decisionIntervalMinutes,
      });
      bucket.decisionRounds += exit.decisionRounds;
      bucket.remoteCalls += exit.remoteCalls;
      bucket.cacheHits += exit.cacheHits;
      bucket.jevFailures += exit.jevFailures;

      const boundaryHasFuture = dates.some((date) => date > splitRange.to);
      const status = exit.status === "right-censored" || exit.status === "no-observation"
        ? boundaryHasFuture ? "boundary-excluded" : "right-censored"
        : exit.status;
      const label: ResearchHoldingLabel = {
        split,
        code: item.entry.code,
        name: item.entry.name,
        entryDate,
        entryTime: "14:45",
        entry: round2(entryPrice),
        qty,
        status,
        exitDate: exit.exitDate,
        exitTime: exit.exitTime,
        exitPrice: exit.exitPrice,
        exitNote: exit.exitNote,
        entryTrace,
        exitTrace: exit.exitTrace,
        decisionRounds: 1 + exit.decisionRounds,
        remoteCalls: (entryDecision.trace.call === "remote" ? 1 : 0) + exit.remoteCalls,
        cacheHits: (entryDecision.trace.call === "cache" ? 1 : 0) + exit.cacheHits,
        jevFailures: exit.jevFailures,
      };
      bucket.labelsDetail.push(label);

      if (status === "boundary-excluded") {
        bucket.boundaryExcluded++;
        continue;
      }
      if (status === "right-censored") {
        bucket.censored++;
        continue;
      }
      if (!exit.exitDate || !exit.exitTime || !(exit.exitPrice && exit.exitPrice > 0) || !exit.exitTrace) continue;
      const buyAmount = entryPrice * qty;
      const sellAmount = exit.exitPrice * qty;
      const cost = buyCosts(buyAmount).total + sellCosts(sellAmount).total;
      const gross = sellAmount - buyAmount;
      const net = gross - cost;
      label.netBps = round2(net / buyAmount * 10_000);
      addTradeMetrics(bucket, {
        split,
        code: item.entry.code,
        name: item.entry.name,
        entryDate,
        exitDate: exit.exitDate,
        entryTime: "14:45",
        exitTime: exit.exitTime,
        exitSource: status === "hard-stop" ? "hard-rule" : "jev",
        entryTrace,
        exitTrace: exit.exitTrace,
        score: round2(pick.score),
        entry: round2(entryPrice),
        exit: round2(exit.exitPrice),
        qty,
        grossBps: round2(gross / buyAmount * 10_000),
        netBps: round2(net / buyAmount * 10_000),
        costYuan: round2(cost),
        exitNote: exit.exitNote ?? "",
      });
    }
  }

  return {
    dataset: manifest.dataset,
    entryTime: manifest.execution.entryTime,
    exitPolicy: manifest.labels.policy,
    censoring: manifest.labels.censoring,
    parameters: {
      k,
      sizeCny,
      stopLossPct,
      decisionIntervalMinutes: manifest.execution.decisionIntervalMinutes,
      factor,
    },
    splits: result,
  };
}
