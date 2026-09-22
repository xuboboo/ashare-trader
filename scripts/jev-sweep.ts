/**
 * Jev 鲁棒性扫描：单趟问 Jev、离线扫多组 (hold × 阈值 × 分窗)，看"Jev≈随机"稳不稳。
 * 每个交易日只真调一次 Jev（候选池 top-N），概率缓存后，持有期和采纳阈值都在本地重算，
 * 不重复烧额度。随机基线同池、按日期定种、与 Jev 同数量。净收益均扣往返成本。
 *
 * 用法：bun scripts/jev-sweep.ts [--days=260] [--conc=8]
 */
import { join } from "node:path";
import { config } from "../src/config";
import { researchRoot, loadDailyBars, dateInRange, type ResearchDailyBar, type ResearchManifest, type ResearchSplitName } from "../src/research";
import { defaultFactorParams, featuresFromDaily, scoreStock, type Scored } from "../src/factors";
import { roundTrip } from "../src/costs";
import { buildState, buildQuestions, defaultAsk, eligible } from "../src/jev";
import { cannotAffordLot } from "../src/symbols";
import type { SignalState } from "../src/model";
import { drawRandom, fwdNetBps, rng, seedFromDate } from "./jev-vs-random";

const argNum = (n: string, f: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${n}=`));
  const v = a ? Number(a.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : f;
};
const DAYS = argNum("days", 260);
const CONC = argNum("conc", 8);
const HOLDS = [3, 5, 10];
const THRS = [0.4, 0.45, 0.5, 0.55];
const MAXH = Math.max(...HOLDS);

const root = researchRoot(config.dataDir);
const manifest = (await Bun.file(join(root, "manifest.json")).json()) as ResearchManifest;
const costBps = roundTrip(config.sizeCny).bps;
const fp = defaultFactorParams();

const dailyByCode = new Map<string, ResearchDailyBar[]>();
const idxOf = new Map<string, Map<string, number>>();
const vol5 = new Map<string, (number | undefined)[]>();
{
  const codes: string[] = [];
  for await (const f of new Bun.Glob("*.json").scan({ cwd: join(root, "daily") })) codes.push(f.replace(/\.json$/, ""));
  for (const code of codes.sort()) {
    let bars;
    try {
      bars = await loadDailyBars(code, manifest);
    } catch {
      continue;
    }
    dailyByCode.set(code, bars);
    const m = new Map<string, number>();
    bars.forEach((b, i) => m.set(b.date, i));
    idxOf.set(code, m);
    vol5.set(code, bars.map((_, i) => (i < 5 ? undefined : (bars[i - 5]!.volumeHands + bars[i - 4]!.volumeHands + bars[i - 3]!.volumeHands + bars[i - 2]!.volumeHands + bars[i - 1]!.volumeHands) / 5)));
  }
}
const allDates = [...new Set([...dailyByCode.values()].flatMap((b) => b.map((x) => x.date)))].sort();
const dates = allDates.slice(-DAYS);

function candidatesOn(date: string): Scored[] {
  const out: Scored[] = [];
  for (const [code, bars] of dailyByCode) {
    const bi = idxOf.get(code)?.get(date);
    if (bi === undefined || bi < 5) continue;
    const f = featuresFromDaily(bars[bi]!, bars[bi - 1], vol5.get(code)?.[bi], code, code);
    if (f.oneLineUp || f.suspended) continue;
    const sc = scoreStock(f, {}, false, fp);
    if (sc.rejects.length || !(sc.score > 0) || cannotAffordLot(f.price, config.sizeCny)) continue;
    out.push(sc);
  }
  return out.sort((a, b) => b.score - a.score || a.features.code.localeCompare(b.features.code));
}

interface Cell {
  code: string;
  prob: number | null;
  fwd: Record<number, number | null>;
}
interface Day {
  date: string;
  cells: Cell[];
}

async function askDay(date: string): Promise<Day | null> {
  const all = candidatesOn(date);
  if (!all.length) return null;
  const state: SignalState = {
    date, time: "14:45", horizon: "sweep", gate: { allowed: true, status: "open", reasons: [], skipped: [] } as SignalState["gate"],
    index: null, candidates: all, heldCodes: [], allowed: { buy: true, sell: false }, vetoes: {}, openSlots: config.k, decisionMode: "buy",
  };
  const list = eligible(state, config.sizeCny);
  if (!list.length) return null;
  let reply;
  try {
    reply = await defaultAsk({ state: buildState(state, list, costBps, []), questions: buildQuestions(state, list, costBps), timeoutMs: config.jevTimeoutMs });
  } catch {
    return null;
  }
  const cells: Cell[] = list.map((c, i) => {
    const bars = dailyByCode.get(c.features.code)!;
    const fwd: Record<number, number | null> = {};
    for (const h of HOLDS) fwd[h] = fwdNetBps(bars, date, h, costBps);
    return { code: c.features.code, prob: reply.answers[`q${i}`]?.probability ?? null, fwd };
  });
  return { date, cells };
}

const days: Day[] = [];
for (let i = 0; i < dates.length; i += CONC) {
  const res = await Promise.all(dates.slice(i, i + CONC).map(askDay));
  for (const r of res) if (r && r.cells.some((c) => c.prob != null)) days.push(r);
  process.stdout.write(`\r问 Jev ${Math.min(i + CONC, dates.length)}/${dates.length}`);
}
console.log();

function score(daySubset: Day[], hold: number, thr: number) {
  const jev: number[] = [];
  const rand: number[] = [];
  for (const d of daySubset) {
    const picks = d.cells.filter((c) => (c.prob ?? 0) >= thr);
    for (const c of picks) { const v = c.fwd[hold]; if (v != null) jev.push(v); }
    const rand2 = rng(seedFromDate(d.date));
    const drawn = drawRandom(d.cells.filter((c) => c.fwd[hold] != null).map((c) => c.code), Math.max(picks.length, 1), rand2);
    for (const code of drawn) {
      const cell = d.cells.find((c) => c.code === code)!;
      const v = cell.fwd[hold];
      if (v != null) rand.push(v);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const win = (xs: number[]) => (xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : NaN);
  return { jev: mean(jev), rand: mean(rand), gap: mean(jev) - mean(rand), jevWin: win(jev), n: jev.length };
}

const splits: [string, (d: string) => boolean][] = [
  ["all", () => true],
  ["train", (d) => dateInRange(d, manifest.splits.train)],
  ["valid", (d) => dateInRange(d, manifest.splits.validation)],
  ["test", (d) => dateInRange(d, manifest.splits.test)],
];

console.log(`\n=== 单趟问 Jev ${days.length} 天 · 成本 ${costBps.toFixed(0)}bp · 每格 (Jev − 随机) bp [Jev样本n] ===`);
const fmtCell = (s: { gap: number; n: number }) => (s.n === 0 ? "  —   [0]" : `${s.gap.toFixed(0).padStart(4)} [${s.n}]`);
console.log("hold\\阈值   0.40     0.45     0.50     0.55");
for (const h of HOLDS) {
  console.log(`  ${String(h).padStart(2)}日   ` + THRS.map((t) => fmtCell(score(days, h, t))).join("  "));
}
console.log(`\n=== 分窗稳健性（hold=5, thr=0.45 = 当前实盘阈值）===`);
console.log("窗口     Jev净bp  随机净bp   gap      Jev胜率  样本");
for (const [name, pred] of splits) {
  const sub = days.filter((d) => pred(d.date));
  const s = score(sub, 5, 0.45);
  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "n/a");
  console.log(`  ${name.padEnd(7)} ${f2(s.jev).padStart(5)}   ${f2(s.rand).padStart(5)}   ${f2(s.gap).padStart(5)}   ${Number.isFinite(s.jevWin) ? s.jevWin.toFixed(0) + "%" : "n/a"}    ${s.n}`);
}
const cells = HOLDS.flatMap((h) => THRS.map((t) => score(days, h, t))).filter((s) => s.n > 0);
const maxAbs = cells.length ? Math.max(...cells.map((s) => Math.abs(s.gap))) : NaN;
const totalJev = score(days, 5, 0.45).n;
console.log(`\n判读：thr≥0.50 时 Jev 几乎无样本（它概率上不去）；有样本的组合 |Jev−随机| 最大 ${Number.isFinite(maxAbs) ? maxAbs.toFixed(0) : "n/a"}bp，0.45 档 Jev 样本 ${totalJev}。${
  Number.isFinite(maxAbs) && maxAbs <= 60 ? "\n→ 结论稳健：无论怎么调 hold/阈值，Jev 选股与随机差异都在噪声带内 —— 日线信息下 Jev 无可证实的超额能力。"
    : "\n→ 个别组合偏离较大，需看方向是否一致；但高阈值下 Jev 基本不出手，本身说明它不确信。"
}`);
