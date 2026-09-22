/**
 * 日频基线回测 —— 一条透明规则，作为 Jev 之前的参考线。
 *
 * 与生产研究 runner 的区别：runner 用真 14:45 股票池（只能实时采）；本基线用
 * "当日收盘 EOD 成交额排名"在内存里选股，因为它的入场在 D+1 开盘——收盘后才可知的
 * 排名对次日开盘决策无前视。重建成的是 EOD 上下文池，绝不冒充 14:45 快照写盘。
 *
 * 规则（透明可复算）：
 *   信号日 D 涨幅 >= --gain%  ->  D+1 开盘买（含滑点）  ->  持有 --hold 个交易日 -> 收盘卖
 *   严格 split 隔离：D+1 与卖出日都落在同一 split 内，跨边界一律丢弃。
 *   同时算 naive/gross/net 三套，量化"收盘价幻觉"与"成本"各吃掉多少。
 *
 * 用法：bun scripts/research-daily-baseline.ts [--split=all] [--gain=5] [--hold=5]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import {
  researchRoot,
  loadDailyBars,
  dateInRange,
  collectResearchDates,
  reconstructPitUniverse,
  type DateRange,
  type ResearchDailyBar,
  type ResearchManifest,
  type ResearchSplitName,
} from "../src/research";
import { buyCosts, sellCosts, slipFillPrice } from "../src/costs";
import { sharesForBudget } from "../src/symbols";

const argNum = (name: string, fallback: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const GAIN_MIN_PCT = argNum("gain", 5);
const HOLD_DAYS = Math.max(1, Math.floor(argNum("hold", 5)));
const SIZE_CNY = config.sizeCny;
const root = researchRoot(config.dataDir);

const manifest = (await Bun.file(join(root, "manifest.json")).json()) as ResearchManifest;
const splitArg = process.argv.find((a) => a.startsWith("--split="))?.slice("--split=".length) ?? "all";
const SPLITS: ResearchSplitName[] = ["train", "validation", "test"];
const toRun: ResearchSplitName[] = splitArg === "all" ? SPLITS : (SPLITS.filter((s) => s === splitArg) as ResearchSplitName[]);
if (!toRun.length) {
  console.error("--split 必须是 train/validation/test/all");
  process.exit(2);
}

interface Daily {
  bars: ResearchDailyBar[];
  index: Map<string, number>;
}
const dailyCache = new Map<string, Daily>();
async function getDaily(code: string): Promise<Daily | null> {
  const hit = dailyCache.get(code);
  if (hit) return hit;
  let bars: ResearchDailyBar[];
  try {
    bars = await loadDailyBars(code, manifest);
  } catch {
    return null;
  }
  const index = new Map<string, number>();
  bars.forEach((b, i) => index.set(b.date, i));
  const d: Daily = { bars, index };
  dailyCache.set(code, d);
  return d;
}

interface Trade {
  code: string;
  signalDate: string;
  entryDate: string;
  naiveBps: number;
  grossBps: number;
  netBps: number;
  netCny: number;
}

async function runSplit(name: ResearchSplitName, range: DateRange, dates: string[]) {
  const trades: Trade[] = [];
  let boundaryExcluded = 0;
  let prevCloseMismatch = 0;
  const universeDays = dates.filter((d) => dateInRange(d, range));

  for (const date of universeDays) {
    const snap = pools.get(date);
    if (!snap) continue;
    for (const entry of snap.entries.filter((e) => e.active)) {
      const daily = await getDaily(entry.code);
      if (!daily) continue;
      const idx = daily.index.get(date);
      if (idx === undefined || idx <= 0) continue;
      const sig = daily.bars[idx]!;
      // PIT 交叉校验：股票池记录的昨收必须与 raw 日线一致，否则数据串了
      const prev = daily.bars[idx - 1]!;
      if (entry.prevClose && Math.abs(entry.prevClose - prev.close) > 0.011) {
        prevCloseMismatch++;
        continue;
      }
      if (!(sig.pct >= GAIN_MIN_PCT)) continue;
      const ebar = daily.bars[idx + 1];
      const xbar = daily.bars[idx + 1 + HOLD_DAYS];
      if (!ebar || !xbar) continue;
      // split 隔离：买入与卖出都不得越界借未来数据
      if (ebar.date > range.to || xbar.date > range.to) {
        boundaryExcluded++;
        continue;
      }
      const qty = sharesForBudget(ebar.open, SIZE_CNY);
      if (qty <= 0) continue;
      const naiveBps = ((xbar.close - sig.close) / sig.close) * 10_000;
      const buyFill = slipFillPrice(ebar.open, "buy");
      const sellFill = slipFillPrice(xbar.close, "sell");
      const buyAmt = buyFill * qty;
      const sellAmt = sellFill * qty;
      const cost = buyCosts(buyAmt).total + sellCosts(sellAmt).total;
      const netCny = sellAmt - buyAmt - cost;
      trades.push({
        code: entry.code,
        signalDate: date,
        entryDate: ebar.date,
        naiveBps,
        grossBps: ((sellAmt - buyAmt) / buyAmt) * 10_000,
        netBps: (netCny / buyAmt) * 10_000,
        netCny,
      });
    }
  }

  trades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    eq += t.netCny;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const avg = (key: "naiveBps" | "grossBps" | "netBps") =>
    trades.length ? trades.reduce((s, t) => s + t[key], 0) / trades.length : 0;
  const win = trades.length ? (trades.filter((t) => t.netBps > 0).length / trades.length) * 100 : 0;

  return {
    split: name,
    range,
    universeDays: universeDays.length,
    trades: trades.length,
    boundaryExcluded,
    prevCloseMismatch,
    naiveAvgBps: r1(avg("naiveBps")),
    grossAvgBps: r1(avg("grossBps")),
    netAvgBps: r1(avg("netBps")),
    netWinPct: r1(win),
    costDragBps: r1(avg("grossBps") - avg("netBps")),
    lookaheadInflBps: r1(avg("naiveBps") - avg("grossBps")),
    cumNetCny: Math.round(eq),
    maxDDCny: Math.round(maxDD),
    detail: trades.slice(0, 500),
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// 内存内重建 EOD 上下文池：仅用于"当日收盘排名→次日开盘买"的日频基线，绝不冒充 14:45 池写盘
const dailyDir = join(root, manifest.daily.path);
const dailyByCode = new Map<string, ResearchDailyBar[]>();
for await (const f of new Bun.Glob("*.json").scan({ cwd: dailyDir })) {
  const code = f.replace(/\.json$/, "");
  try {
    dailyByCode.set(code, await loadDailyBars(code, manifest));
  } catch {
    /* 非 raw / 空文件跳过 */
  }
}
if (!dailyByCode.size) {
  console.error("research/daily 为空，请先运行 fetch-research.ts");
  process.exit(2);
}
const dates = collectResearchDates(dailyByCode);
const pools = reconstructPitUniverse(dates, {
  topN: config.universeSize,
  dailyByCode,
  source: "daily-baseline-eod-context-ranking",
});

const report: Record<string, unknown> = { dataset: manifest.dataset, rule: `涨幅>=${GAIN_MIN_PCT}% 次日开盘买 持${HOLD_DAYS}日`, sizeCny: SIZE_CNY, splits: {} };
console.log(`\n=== 逐日 PIT 日频基线：${manifest.dataset} ===`);
console.log(`规则：日涨幅≥${GAIN_MIN_PCT}% -> 次日开盘买 -> 持${HOLD_DAYS}日收盘卖 · 单笔 ${SIZE_CNY} 元`);
console.log(`可用交易日（含逐日池）：${dates[0]} .. ${dates.at(-1)}（${dates.length} 天）\n`);
console.log("split        池天数  笔数   naive    gross     net   净胜率  成本拖累  前视虚高   累计净   最大回撤");

for (const name of toRun) {
  const m = await runSplit(name, manifest.splits[name], dates);
  (report.splits as Record<string, unknown>)[name] = m;
  console.log(
    `${name.padEnd(11)} ${String(m.universeDays).padStart(5)}  ${String(m.trades).padStart(5)}` +
      `  ${String(m.naiveAvgBps).padStart(6)}  ${String(m.grossAvgBps).padStart(6)}  ${String(m.netAvgBps).padStart(6)}` +
      `  ${String(m.netWinPct).padStart(5)}%  ${String(m.costDragBps).padStart(6)}  ${String(m.lookaheadInflBps).padStart(6)}` +
      `  ${String(m.cumNetCny).padStart(7)}  ${String(m.maxDDCny).padStart(7)}`,
  );
  if (m.prevCloseMismatch) console.log(`             （${m.prevCloseMismatch} 次昨收不一致被剔除，数据交叉校验生效）`);
}

await mkdir(root, { recursive: true });
await Bun.write(join(root, "daily-baseline-report.json"), JSON.stringify(report, null, 2));

if (splitArg === "all" && report.splits) {
  const tr = (report.splits as any).train;
  const te = (report.splits as any).test;
  if (tr && te && tr.trades && te.trades) {
    console.log(`\nRESULT trainNetAvg=${tr.netAvgBps} testNetAvg=${te.netAvgBps} overfitGapBps=${r1(tr.netAvgBps - te.netAvgBps)}`);
    console.log("（train 与 test 的净收益差 = 过拟合程度；差越大，规则越可能是拟合噪声）");
  }
}
console.log(`\n报告：research/daily-baseline-report.json`);
