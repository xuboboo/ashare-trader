/**
 * 历史 Jev 大规模回放：把"额度不限"变成"统计显著的结论"。
 *
 * 对 research/daily 里的每个历史交易日，用生产同款口径复现候选池
 *   （featuresFromDaily + scoreStock，与 legacy 回测/实盘共用），
 *   再把候选喂给 Jev（buildState/buildQuestions/defaultAsk，同一个问题），
 *   拿它给的概率做与实盘一致的阈值筛选，然后用真实未来 N 日 raw 日线结算净收益，
 *   与"同日同池随机抽样"和"全体候选"对照。
 *
 * 一次回答：Jev 用日线信息挑的股票，扣成本后到底比随机强不强（胜率 + 净期望，两个都给）。
 *
 * 诚实边界：
 *   - 喂给 Jev 的是日线特征（缺盘中量比/VWAP 实时性），是"日线版 Jev"能力体检，不等于盘中引擎。
 *   - 候选池来自今天的股票池回溯，含幸存者偏差；只用于"Jev vs 随机同池对照"（同池内公平），不外推绝对收益。
 *
 * 用法：bun scripts/jev-replay-backtest.ts [--days=120] [--hold=5] [--thr=0.45] [--conc=6] [--jitter=0]
 */
import { join } from "node:path";
import { config } from "../src/config";
import { researchRoot, loadDailyBars, type ResearchDailyBar, type ResearchManifest } from "../src/research";
import { defaultFactorParams, featuresFromDaily, scoreStock, type Scored } from "../src/factors";
import { roundTrip, buyCosts, sellCosts } from "../src/costs";
import { buildState, buildQuestions, defaultAsk, eligible } from "../src/jev";
import { cannotAffordLot } from "../src/symbols";
import type { SignalState } from "../src/model";
import { drawRandom, fwdNetBps, rng, seedFromDate } from "./jev-vs-random";

const argNum = (n: string, f: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${n}=`));
  const v = a ? Number(a.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : f;
};

const MAX_DAYS = argNum("days", 120);
const HOLD = argNum("hold", 5);
const THR = argNum("thr", config.jevMinProb);
const CONC = argNum("conc", 6);
const JITTER = argNum("jitter", 0); // 概率 ± 该值视为噪声带，测 Jev 输出稳定性

const root = researchRoot(config.dataDir);
const manifest = (await Bun.file(join(root, "manifest.json")).json()) as ResearchManifest;
const costBps = roundTrip(config.sizeCny).bps;
const fp = defaultFactorParams();

// 载入全部候选票的日线，预建 date->index 与 前5日均量
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

// 交易日全集（升序），只保留能凑齐未来 HOLD 根的；取最近 MAX_DAYS 个
const allDates = [...new Set([...dailyByCode.values()].flatMap((b) => b.map((x) => x.date)))].sort();
const lastDate: Record<string, string> = {};
for (const [code, bars] of dailyByCode) if (bars.length) lastDate[code] = bars[bars.length - 1]!.date;
const usableDates = allDates.filter((d) => {
  // 至少几只票在这天之后还有 HOLD 根，才有可结算样本
  let n = 0;
  for (const [code, bars] of dailyByCode) {
    const i = idxOf.get(code)?.get(d);
    if (i !== undefined && i + HOLD < bars.length) n++;
    if (n >= 20) return true;
  }
  return false;
});
const dates = usableDates.slice(-MAX_DAYS);
console.log(`载入 ${dailyByCode.size} 支 · 可回放交易日 ${dates.length}（近 ${MAX_DAYS}），hold=${HOLD}，成本=${costBps.toFixed(1)}bp，阈值=${THR}`);

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

async function oneDay(date: string) {
  const all = candidatesOn(date);
  if (!all.length) return null;
  const state: SignalState = {
    date, time: "14:45", horizon: "replay", gate: { allowed: true, status: "open", reasons: [], skipped: [] } as SignalState["gate"],
    index: null, candidates: all, heldCodes: [], allowed: { buy: true, sell: false }, vetoes: {}, openSlots: config.k, decisionMode: "buy",
  };
  const list = eligible(state, config.sizeCny);
  if (!list.length) return null;
  const st = buildState(state, list, costBps, []);
  const questions = buildQuestions(state, list, costBps);
  let reply;
  try {
    reply = await defaultAsk({ state: st, questions, timeoutMs: config.jevTimeoutMs });
  } catch {
    return null;
  }
  const fwd = (code: string) => {
    const bars = dailyByCode.get(code)!;
    return fwdNetBps(bars, date, HOLD, costBps);
  };
  const jevVals: number[] = [];
  const poolVals: number[] = [];
  const pickedCodes: string[] = [];
  const probs: number[] = [];
  list.forEach((c, i) => {
    const p = reply.answers[`q${i}`]?.probability;
    const v = fwd(c.features.code);
    if (v != null) poolVals.push(v);
    if (typeof p === "number") {
      probs.push(p + (JITTER ? (rng(seedFromDate(date + c.features.code))() * 2 - 1) * JITTER : 0));
      if (p >= THR && v != null) {
        jevVals.push(v);
        pickedCodes.push(c.features.code);
      }
    }
  });
  // 随机基线：同池、同数量（至少1），按日期定种
  const rand = rng(seedFromDate(date));
  const base = drawRandom(list.map((c) => c.features.code), Math.max(pickedCodes.length, 1), rand).map(fwd).filter((x): x is number => x != null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { jev: mean(jevVals), rand: mean(base), pool: mean(poolVals), jevN: jevVals.length, maxProb: probs.length ? Math.max(...probs) : null };
}

// 并发跑（额度不限，但按 CONC 限并保证稳定/可结算）
const acc = { jev: [] as number[], rand: [] as number[], pool: [] as number[], days: 0, maxProbs: [] as number[] };
for (let i = 0; i < dates.length; i += CONC) {
  const chunk = dates.slice(i, i + CONC);
  const res = await Promise.all(chunk.map(oneDay));
  for (const r of res) {
    if (!r || r.pool == null) continue;
    acc.days++;
    if (r.jev != null) acc.jev.push(r.jev);
    if (r.rand != null) acc.rand.push(r.rand);
    if (r.pool != null) acc.pool.push(r.pool);
    if (r.maxProb != null) acc.maxProbs.push(r.maxProb);
  }
  if (i % (CONC * 10) === 0) process.stdout.write(`\r进度 ${Math.min(i + CONC, dates.length)}/${dates.length}`);
}
console.log();

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const win = (xs: number[]) => (xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : 0);
const avgMaxProb = acc.maxProbs.length ? mean(acc.maxProbs) : 0;
console.log(`\n=== 历史回放结论（可结算交易日 ${acc.days}，hold=${HOLD}，成本=${costBps.toFixed(0)}bp，阈值=${THR}）===`);
console.log(`组别        平均净收益bp   胜率%    有样本的天数`);
console.log(`Jev 选中    ${mean(acc.jev).toFixed(0).padStart(6)}      ${win(acc.jev).toFixed(0).padStart(4)}%    ${acc.jev.length}`);
console.log(`随机基线    ${mean(acc.rand).toFixed(0).padStart(6)}      ${win(acc.rand).toFixed(0).padStart(4)}%    ${acc.rand.length}`);
console.log(`全体候选    ${mean(acc.pool).toFixed(0).padStart(6)}      ${win(acc.pool).toFixed(0).padStart(4)}%    ${acc.pool.length}`);
const gap = mean(acc.jev) - mean(acc.rand);
console.log(`\nJev − 随机 = ${gap.toFixed(0)} bp/笔`);
console.log(`各日 Jev 最高概率的均值 = ${avgMaxProb.toFixed(2)}（贴近 0.5 = 模型对这批候选本就没什么把握）`);
if (acc.days < 30) console.log(`样本 ${acc.days} 天偏少，--days 调大可提升统计功效`);
console.log(gap > 20 ? "→ 该窗口内 Jev 选股优于随机，值得继续验证（注意日线口径与幸存者偏差）"
  : Math.abs(gap) <= 20 ? "→ Jev 与随机差异≈噪声：日线信息下看不出 Jev 有超额能力"
  : "→ Jev 选股在本窗口劣于随机：这套选股逻辑当前无正期望信号");
