/**
 * 入场时刻研究：**同一批候选，只换入场时刻**，看净期望怎么变。
 *
 * 目的：把「14:45 尾盘买入」从信仰变成结论。ENTRY_START 目前写死 14:45，
 * 依据只是"历史回测恰好是 14:45"；这里直接问：换时刻到底差多少。
 *
 * 两阶段（分钟线由 Python 从通达信取，见 scripts/tdx-minute-ladder.py）：
 *   bun run scripts/entry-timing-study.ts --emit --days=60     # 产出 (date,code) 请求清单
 *   bun run scripts/tdx-minute-ladder.py                       # 抓分钟线 -> ladder.json
 *   bun run scripts/entry-timing-study.ts --report             # 出对照表
 *
 * 诚实边界（必须连结论一起读）：
 *  - 筛选用的是**当日全天**日线特征，所以早于收盘的入场时刻含前视偏差
 *    （09:45 的人不可能知道当天涨幅 3-7%）。本表回答的是
 *    "在已知它是候选的前提下，几点进场更好"，不是"实时能不能选出来"。
 *  - 通达信分钟线没有 bid/ask，成交价用该分钟收盘价近似；协议 v2 要求 entry=ask，
 *    所以这份数据**不能**当作 research/minutes 用，只是入场时刻的对照研究。
 *  - 出场固定为入场后第 EXIT_DAYS 个交易日收盘（生产是 Jev 自主退出），
 *    这里固定出场是为了隔离"入场时刻"这一个变量。
 */
import { join } from "node:path";
import { config } from "../src/config";
import { roundTrip } from "../src/costs";
import { defaultFactorParams, featuresFromDaily, scoreStock, type Scored } from "../src/factors";
import { loadDailyBars, researchRoot, type ResearchDailyBar, type ResearchManifest } from "../src/research";
import { cannotAffordLot } from "../src/symbols";

const argNum = (n: string, f: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${n}=`));
  const v = a ? Number(a.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : f;
};
const argStr = (n: string, f: string) => {
  const a = process.argv.find((s) => s.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : f;
};
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

const DAYS = argNum("days", 60);
const EXIT_DAYS = argNum("exit-days", 1);
const SCREEN = argStr("screen", "safety") as "strict" | "safety";
const SAFETY_REJECT = /停牌|一字涨停|已封涨停/;
/** 入场时刻（分钟，HH:MM）。14:45 = 当前实盘 ENTRY_START，作为基准列。 */
const ENTRIES = ["09:45", "10:30", "11:30", "13:30", "14:00", "14:30", "14:45", "14:57"];

const root = researchRoot(config.dataDir);
const manifest = (await Bun.file(join(root, "manifest.json")).json()) as ResearchManifest;
const costBps = roundTrip(config.sizeCny).bps;
const fp = defaultFactorParams();

const dailyByCode = new Map<string, ResearchDailyBar[]>();
const idxOf = new Map<string, Map<string, number>>();
const vol5 = new Map<string, (number | undefined)[]>();
for await (const f of new Bun.Glob("*.json").scan({ cwd: join(root, "daily") })) {
  const code = f.replace(/\.json$/, "");
  if (!/^\d{6}$/.test(code)) continue;
  let bars: ResearchDailyBar[];
  try {
    bars = await loadDailyBars(code, manifest);
  } catch {
    continue;
  }
  dailyByCode.set(code, bars);
  const m = new Map<string, number>();
  bars.forEach((b, i) => m.set(b.date, i));
  idxOf.set(code, m);
  vol5.set(
    code,
    bars.map((_, i) =>
      i < 5 ? undefined : (bars[i - 5]!.volumeHands + bars[i - 4]!.volumeHands + bars[i - 3]!.volumeHands + bars[i - 2]!.volumeHands + bars[i - 1]!.volumeHands) / 5,
    ),
  );
}

const allDates = [...new Set([...dailyByCode.values()].flatMap((b) => b.map((x) => x.date)))].sort();
/** 只保留"入场后还能凑齐 EXIT_DAYS 根"的日期 */
const usableDates = allDates.filter((d) => {
  let n = 0;
  for (const [code, bars] of dailyByCode) {
    const i = idxOf.get(code)?.get(d);
    if (i !== undefined && i + EXIT_DAYS < bars.length) n++;
    if (n >= 20) return true;
  }
  return false;
});
const dates = usableDates.slice(-DAYS);

function candidatesOn(date: string): Scored[] {
  const out: Scored[] = [];
  for (const [code, bars] of dailyByCode) {
    const bi = idxOf.get(code)?.get(date);
    if (bi === undefined || bi < 5) continue;
    const f = featuresFromDaily(bars[bi]!, bars[bi - 1], vol5.get(code)?.[bi], code, code);
    if (f.oneLineUp || f.suspended) continue;
    if (cannotAffordLot(f.price, config.sizeCny)) continue;
    const sc = scoreStock(f, {}, false, fp);
    if (SCREEN === "strict") {
      if (sc.rejects.length || !(sc.score > 0)) continue;
      out.push(sc);
    } else {
      if (sc.rejects.some((r) => SAFETY_REJECT.test(r))) continue;
      out.push({ ...sc, rejects: [], score: Math.max(0, sc.score) });
    }
  }
  return out;
}

const ladderPath = join(root, "entry-timing", "ladder.json");
const ladderPitPath = join(root, "entry-timing", "ladder_pit.json");

/** T 时刻对应的已交易分钟数（09:30 起算，跨午休累加）。成交额/量比按它折算。 */
function elapsedTradingMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  const mins = h! * 60 + m!;
  const open = 9 * 60 + 30;
  const noon = 11 * 60 + 30;
  const pm = 13 * 60;
  return mins <= noon ? mins - open : noon - open + (mins - pm);
}

interface PitCell {
  px: number;
  cv: number;
  ca: number;
}

type PitLadder = Record<string, Record<string, Record<string, PitCell>>>;

if (hasFlag("emit")) {
  const pairs: { date: string; code: string }[] = [];
  for (const d of dates) for (const c of candidatesOn(d)) pairs.push({ date: d, code: c.features.code });
  const outDir = join(root, "entry-timing");
  await Bun.write(join(outDir, "requests.json"), JSON.stringify({ entries: ENTRIES, pairs }, null, 1));
  console.log(`候选窗口 ${dates.length} 天（${dates[0]}..${dates.at(-1)}），筛选=${SCREEN}，请求 ${pairs.length} 个 (date,code)`);
  console.log(`已写出 ${join(outDir, "requests.json")}`);
} else if (hasFlag("pit")) {
  // point-in-time：每个时刻 T 只用 T 之前（含）的数据重算特征，因此**每个 T 有自己的候选集**。
  // 这才是「入场时刻值不值钱」的正确问法；旧的 --report 用全天日线特征，含前视偏差。
  const ladder = (await Bun.file(ladderPitPath).json()) as PitLadder;
  const per = new Map<string, number[]>();
  const pool = new Map<string, number>();
  for (const t of ENTRIES) {
    per.set(t, []);
    pool.set(t, 0);
  }
  for (const d of dates) {
    const dayLadder = ladder[d];
    if (!dayLadder) continue;
    for (const [code, row] of Object.entries(dayLadder)) {
      const bars = dailyByCode.get(code);
      const bi = idxOf.get(code)?.get(d);
      if (!bars || bi === undefined || bi < 5) continue;
      const exitBar = bars[bi + EXIT_DAYS];
      if (!exitBar) continue;
      const base = featuresFromDaily(bars[bi]!, bars[bi - 1], vol5.get(code)?.[bi], code, code);
      const prevClose = bars[bi - 1]!.close;
      const avg5 = vol5.get(code)?.[bi];
      for (const t of ENTRIES) {
        const cell = row[t];
        if (!cell || !(cell.px > 0) || !(cell.cv > 0)) continue;
        const elapsed = elapsedTradingMinutes(t);
        if (!(elapsed > 0)) continue;
        pool.set(t, pool.get(t)! + 1);
        const vwap = cell.ca / (cell.cv * 100);
        const vr = avg5 && avg5 > 0 ? cell.cv / (avg5 * (elapsed / 240)) : 0;
        const f = {
          ...base,
          date: d,
          price: cell.px,
          high: cell.px,
          low: cell.px,
          gainPct: ((cell.px - prevClose) / prevClose) * 100,
          volumeRatio: vr,
          vwap,
          priceVsVwapBps: vwap > 0 ? ((cell.px - vwap) / vwap) * 10_000 : 0,
          amountYuan: cell.ca,
          turnoverPct: 0, // PIT 拿不到换手；只影响排序分，不影响否决项
        };
        const params = { ...fp, sessionElapsedMin: elapsed };
        const sc = scoreStock(f, {}, false, params);
        if (sc.rejects.length || !(sc.score > 0) || cannotAffordLot(cell.px, config.sizeCny)) continue;
        per.get(t)!.push(((exitBar.close - cell.px) / cell.px) * 10_000 - costBps);
      }
    }
  }
  const stat = (xs: number[]) => {
    const n = xs.length;
    if (!n) return { n: 0, mean: 0, sd: 0, t: 0, win: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, win: (xs.filter((x) => x > 0).length / n) * 100 };
  };
  console.log("");
  console.log("=== point-in-time 入场时刻对照（窗口 " + dates.length + " 天，出场=第 " + EXIT_DAYS + " 个交易日收盘，成本 " + costBps.toFixed(1) + "bp）===");
  console.log("每个时刻都用当时可见数据重筛，故各列样本数不同。");
  console.log("入场时刻  候选n   平均净bp     胜率%      t值    σ(bp)");
  for (const t of ENTRIES) {
    const s = stat(per.get(t)!);
    const mark = t === "14:45" ? "  <- 当前实盘" : "";
    console.log("  " + t + "   " + String(s.n).padStart(5) + "   " + s.mean.toFixed(1).padStart(8) + "   " + s.win.toFixed(1).padStart(6) + "   " + s.t.toFixed(2).padStart(6) + "   " + s.sd.toFixed(0).padStart(5) + mark + "   (池 " + pool.get(t) + ")");
  }
  console.log("");
  console.log("注意：早时刻的候选数天然更少（信息更少），这是正确行为，不是漏数。");
} else if (hasFlag("report")) {
  const ladder = (await Bun.file(ladderPath).json()) as Record<string, Record<string, Record<string, number>>>;
  const per = new Map<string, number[]>();
  for (const t of ENTRIES) per.set(t, []);
  let pairs = 0;
  for (const d of dates) {
    for (const c of candidatesOn(d)) {
      const code = c.features.code;
      const px = ladder[d]?.[code];
      if (!px) continue;
      const bars = dailyByCode.get(code)!;
      const bi = idxOf.get(code)!.get(d)!;
      const exitBar = bars[bi + EXIT_DAYS];
      if (!exitBar) continue;
      for (const t of ENTRIES) {
        const entry = px[t];
        if (!entry || !(entry > 0)) continue;
        const net = ((exitBar.close - entry) / entry) * 10_000 - costBps;
        per.get(t)!.push(net);
      }
      pairs++;
    }
  }
  const stat = (xs: number[]) => {
    const n = xs.length;
    if (!n) return { n: 0, mean: 0, sd: 0, t: 0, win: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
    const win = (xs.filter((x) => x > 0).length / n) * 100;
    return { n, mean, sd, t, win };
  };
  console.log(`\n=== 入场时刻对照（筛选=${SCREEN}，窗口 ${dates.length} 天，出场=第 ${EXIT_DAYS} 个交易日收盘，成本 ${costBps.toFixed(1)}bp）===`);
  console.log("入场时刻  样本n   平均净bp     胜率%      t值    σ(bp)");
  for (const t of ENTRIES) {
    const s = stat(per.get(t)!);
    const mark = t === "14:45" ? "  <- 当前实盘" : "";
    console.log(
      `  ${t}   ${String(s.n).padStart(5)}   ${s.mean.toFixed(1).padStart(8)}   ${s.win.toFixed(1).padStart(6)}   ${s.t.toFixed(2).padStart(6)}   ${s.sd.toFixed(0).padStart(5)}${mark}`,
    );
  }
  if (pairs === 0) console.log("\n没有命中任何 ladder 样本 —— 先跑 --emit 与 tdx-minute-ladder.py。");
} else {
  console.log("用法：--emit 产出请求清单；--report 读 ladder.json 出表。");
}
