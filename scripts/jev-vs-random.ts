/**
 * Jev-vs-随机 对照实验分析。回答一个可证伪的问题：
 *   "Jev 挑的股票，扣成本后的未来收益，真的比从同一候选池里随机挑的强吗？"
 *
 * 数据来源：
 *   - data/jev-journal.jsonl：引擎每轮买入决策追加的 {date, picked, pool}。
 *   - research/daily/<code>.json：raw 日线（未来 N 日真实价格）。
 * 口径：以信号日 D 收盘价为买入参考，持有 HOLD 个交易日后收盘为卖出，扣往返成本 bps。
 *   Jev 组 = 该轮 picked；随机组 = 用 date 定种从 pool 里抽 picked.length 个（可复现）；
 *   全体 = 该轮 pool 均值。攒够样本才给结论，不足会如实标注。
 *
 * 用法：bun scripts/jev-vs-random.ts [--hold=5]
 */
import { join } from "node:path";
import { config } from "../src/config";
import { researchRoot, type ResearchDailyBar } from "../src/research";
import { roundTrip } from "../src/costs";

export interface JournalEntry {
  date: string;
  time: string;
  model: string;
  threshold: number;
  pool: string[];
  picked: string[];
}

/** date 字符串 -> 32bit 种子（djb2），保证同一天随机抽样可复现。 */
export function seedFromDate(date: string): number {
  let h = 5381;
  for (let i = 0; i < date.length; i++) h = ((h * 33) ^ date.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** mulberry32：小而确定的 PRNG。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 pool 里按 rng 无重复抽 k 个（Fisher-Yates 局部洗牌）。 */
export function drawRandom(pool: string[], k: number, rand: () => number): string[] {
  const arr = [...pool];
  const n = Math.min(k, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}

/**
 * 信号日 D 收盘价是"决策时已经看到的价"，拿它当成交价 = 同一根 K 线前视。
 * 改成：次日 D+1 开盘买入、持有 hold 个交易日后（D+1+hold）收盘卖出，扣往返成本。
 * 与日频基线的执行口径一致（隔天下单），拿不到未来数据则 null。
 */
export function fwdNetBps(bars: ResearchDailyBar[], signalDate: string, hold: number, costBps: number): number | null {
  const idx = bars.findIndex((b) => b.date === signalDate);
  if (idx < 0) return null;
  const entry = bars[idx + 1];
  const exit = bars[idx + 1 + hold];
  if (!entry || !exit || !(entry.open > 0)) return null;
  return ((exit.close - entry.open) / entry.open) * 10_000 - costBps;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const win = (xs: number[]) => (xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null);

export interface GroupStat {
  avg: number | null;
  winPct: number | null;
  n: number;
}
export interface AnalysisResult {
  days: number;
  costBps: number;
  hold: number;
  jev: GroupStat;
  random: GroupStat;
  allPool: GroupStat;
  jevVsRandom: number | null;
  verdict: string;
}

/** 纯函数：给定 journal + 日线表，产出对照结论（可单测）。 */
export function analyzeJournal(entries: JournalEntry[], dailyByCode: Map<string, ResearchDailyBar[]>, hold = 5, costBps = 36.9): AnalysisResult {
  // 每个交易日只取"当天最后一条"决策（收盘前最完整的判断），避免一天内 15s 一轮重复计入
  const byDate = new Map<string, JournalEntry>();
  for (const e of entries) {
    const cur = byDate.get(e.date);
    if (!cur || e.time >= cur.time) byDate.set(e.date, e);
  }
  const jevVals: number[] = [];
  const randVals: number[] = [];
  const allVals: number[] = [];
  for (const e of byDate.values()) {
    const rand = rng(seedFromDate(e.date));
    const baseline = drawRandom(e.pool, Math.max(e.picked.length, 1), rand);
    const fwd = (code: string) => {
      const bars = dailyByCode.get(code);
      return bars ? fwdNetBps(bars, e.date, hold, costBps) : null;
    };
    for (const c of e.picked) { const v = fwd(c); if (v != null) jevVals.push(v); }
    for (const c of baseline) { const v = fwd(c); if (v != null) randVals.push(v); }
    for (const c of e.pool) { const v = fwd(c); if (v != null) allVals.push(v); }
  }
  const jevAvg = mean(jevVals);
  const randAvg = mean(randVals);
  const diff = jevAvg != null && randAvg != null ? jevAvg - randAvg : null;
  const days = byDate.size;
  let verdict: string;
  if (days < 10) verdict = `样本仅 ${days} 个交易日，不足以下结论（建议 ≥10）；继续让引擎每天跑`;
  else if (diff != null && diff > 20 && (jevAvg ?? 0) > 0) verdict = `Jev 选股的净收益高出随机 ${diff.toFixed(0)}bp 且为正 —— 有正向信号，值得继续验证`;
  else if (diff != null && Math.abs(diff) <= 20) verdict = `Jev 与随机差 ${diff.toFixed(0)}bp（≈噪声）—— 目前看不出 Jev 比瞎猜强`;
  else verdict = `Jev 选股净收益 ${jevAvg?.toFixed(0)}bp vs 随机 ${randAvg?.toFixed(0)}bp —— 至少在本窗口没有优势`;
  return {
    days,
    costBps,
    hold,
    jev: { avg: jevAvg, winPct: win(jevVals), n: jevVals.length },
    random: { avg: randAvg, winPct: win(randVals), n: randVals.length },
    allPool: { avg: mean(allVals), winPct: win(allVals), n: allVals.length },
    jevVsRandom: diff,
    verdict,
  };
}

const argNum = (name: string, fallback: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

async function main(): Promise<void> {
  const hold = argNum("hold", 5);
  const costBps = roundTrip(config.sizeCny).bps;
  const journalPath = join(config.dataDir, "jev-journal.jsonl");
  const jf = Bun.file(journalPath);
  if (!(await jf.exists())) {
    console.log(`尚无 ${journalPath} —— 引擎还没在交易时段跑出决策记录。明早 09:00 计划任务起跑后会自动生成。`);
    return;
  }
  const entries: JournalEntry[] = (await jf.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // 载入 raw 日线（research/daily）；journal 里出现过的票才需要
  const need = new Set<string>(entries.flatMap((e) => [...e.pool, ...e.picked]));
  const dailyByCode = new Map<string, ResearchDailyBar[]>();
  const root = researchRoot(config.dataDir);
  for (const code of need) {
    const f = join(root, "daily", `${code}.json`);
    if (await Bun.file(f).exists()) {
      const arr = (await Bun.file(f).json()) as ResearchDailyBar[];
      if (Array.isArray(arr)) dailyByCode.set(code, arr);
    }
  }
  const r = analyzeJournal(entries, dailyByCode, hold, costBps);
  const fm = (x: number | null) => (x == null ? "n/a" : x.toFixed(0));
  console.log(`\n=== Jev vs 随机（hold=${r.hold}日, 成本=${r.costBps.toFixed(1)}bp, 交易日=${r.days}）===`);
  console.log(`组别        平均净收益bp   胜率%    样本笔数`);
  console.log(`Jev 选中    ${fm(r.jev.avg).padStart(8)}      ${fm(r.jev.winPct).padStart(5)}    ${r.jev.n}`);
  console.log(`随机基线    ${fm(r.random.avg).padStart(8)}      ${fm(r.random.winPct).padStart(5)}    ${r.random.n}`);
  console.log(`全体候选    ${fm(r.allPool.avg).padStart(8)}      ${fm(r.allPool.winPct).padStart(5)}    ${r.allPool.n}`);
  console.log(`\nJev − 随机 = ${fm(r.jevVsRandom)} bp`);
  console.log(`结论：${r.verdict}`);
  const missing = need.size - dailyByCode.size;
  if (missing > 0) console.log(`（${missing} 只票 research/daily 里没有，未纳入未来收益统计）`);
}

if (import.meta.main) await main();
