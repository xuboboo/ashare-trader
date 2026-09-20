/**
 * 训练本地概率模型（MODEL=local 的"本地 Jev"）：
 * 用本地日线回放历史，每一条样本 = 某日某股通过了与实盘完全相同的硬筛选后，
 * 按 src/exit.ts 的同一条出场规则（与回测共享）走完"次日退出"，扣掉全部成本后是否为正。
 *
 * 诚实评估：按时间切 85/15 留出集，报告 AUC / Brier / 按 minProb 采纳后的平均净期望 bp。
 * 指标会连同权重一起写进 data/model.json，面板与使用者看到的和训练看到的是同一份。
 *
 * 用法：
 *   bun run scripts/train-model.ts                 # 全部本地日线
 *   bun run scripts/train-model.ts --split=0.8     # 留出集比例
 */
import { join } from "node:path";
import { config } from "../src/config";
import { roundTrip } from "../src/costs";
import { nextDayExit } from "../src/exit";
import { featuresFromDaily, scoreStock } from "../src/factors";
import { LOCAL_FEATURES, featureVec, type LocalWeights } from "../src/local";
import { limitPct } from "../src/symbols";
import { loadStocks } from "./backtest";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? "true"];
  }),
);
const splitFrac = Number(args.split ?? 0.85) || 0.85;
const lr = Number(args.lr ?? 0.15) || 0.15;
const epochs = Number(args.epochs ?? 4000) || 4000;
const l2 = Number(args.l2 ?? 1e-4) || 1e-4;

interface Sample {
  date: string;
  x: number[];
  label: number;
  netBps: number;
}

const costBps = roundTrip(config.sizeCny).bps;
const stocks = await loadStocks();
if (stocks.length < 10) {
  console.error(`!! 只有 ${stocks.length} 支日线，先跑 bun run scripts/fetch-daily.ts`);
  process.exit(1);
}

const samples: Sample[] = [];
let skippedOneLineDown = 0;
let skippedSuspNext = 0;
for (const s of stocks) {
  const bars = s.bars;
  for (let i = 5; i < bars.length - 1; i++) {
    const bar = bars[i]!;
    const prevBar = bars[i - 1]!;
    const next = bars[i + 1]!;
    let av5: number | undefined;
    if (i >= 5) {
      let sum = 0;
      for (let j = i - 5; j < i; j++) sum += bars[j]!.volumeHands;
      av5 = sum / 5;
    }
    const f = featuresFromDaily(bar, prevBar, av5, s.code, s.code);
    const sc = scoreStock(f);
    if (sc.rejects.length) continue; // 与实盘同一套硬筛选
    const entry = Math.round((bar.close + 0.01) * 100) / 100;
    const stop = Math.round(entry * (1 - config.stopLossPct / 100) * 100) / 100;
    const outcome = nextDayExit({
      next,
      prevClose: prevBar.close,
      entry,
      stop,
      limitPctFrac: limitPct(s.code, ""),
    });
    if (!outcome.legs.length || outcome.blended === null) {
      skippedOneLineDown++;
      continue;
    }
    if (next.volumeHands <= 0) {
      skippedSuspNext++;
      continue;
    }
    const grossBps = ((outcome.blended - entry) / entry) * 10_000;
    const netBps = grossBps - costBps;
    samples.push({ date: bar.date, x: featureVec({ features: f, score: sc.score }), label: netBps > 0 ? 1 : 0, netBps });
  }
}
if (samples.length < 500) {
  console.error(`!! 样本只有 ${samples.length} 条，训练无意义。多拉些日线：bun run scripts/fetch-daily.ts`);
  process.exit(1);
}

// ---- 按时间切分：早 85% 训练、晚 15% 留出 ----
const dates = [...new Set(samples.map((s) => s.date))].sort();
const splitDate = dates[Math.floor(dates.length * splitFrac)]!;
const train = samples.filter((s) => s.date < splitDate);
const val = samples.filter((s) => s.date >= splitDate);
console.log(
  `样本 ${samples.length}（正例率 ${(samples.reduce((s, x) => s + x.label, 0) / samples.length).toFixed(3)}）` +
    ` 训练 ${train.length}（< ${splitDate}） 留出 ${val.length}` +
    ` 跳过：一字跌停 ${skippedOneLineDown}、次日停牌 ${skippedSuspNext}；成本口径 ${costBps.toFixed(1)}bp`,
);

// ---- 标准化（只用训练集统计）----
const dim = LOCAL_FEATURES.length;
const mean = new Array(dim).fill(0);
const std = new Array(dim).fill(0);
for (const s of train) for (let i = 0; i < dim; i++) mean[i]! += s.x[i]! / train.length;
for (const s of train) for (let i = 0; i < dim; i++) std[i]! += (s.x[i]! - mean[i]!) ** 2 / train.length;
for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i]!) || 1;
const z = (x: number[]) => x.map((v, i) => (v - mean[i]!) / std[i]!);

// ---- 逻辑回归：全量批梯度下降 + L2，零初始化（完全确定性）----
const w = new Array(dim).fill(0);
let b = 0;
const p = (zx: number[]) => {
  let zB = b;
  for (let i = 0; i < dim; i++) zB += w[i]! * zx[i]!;
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, zB))));
};
for (let e = 0; e < epochs; e++) {
  const gw = new Array(dim).fill(0);
  let gb = 0;
  for (const s of train) {
    const zx = z(s.x);
    const err = p(zx) - s.label;
    for (let i = 0; i < dim; i++) gw[i]! += (err * zx[i]!) / train.length;
    gb += err / train.length;
  }
  for (let i = 0; i < dim; i++) w[i] = w[i]! - lr * (gw[i]! + l2 * w[i]!);
  b = b - lr * gb;
}

const predict = (set: Sample[]) => set.map((s) => p(z(s.x)));
const auc = (set: Sample[]): number => {
  if (!set.length) return Number.NaN;
  const scoredSort = set.map((s, i) => ({ label: s.label, pp: predict([s])[0]!, i }))
    .sort((a, b2) => a.pp - b2.pp || a.i - b2.i);
  // 秩（并列取平均秩）
  const ranks = new Array(scoredSort.length).fill(0);
  let i = 0;
  while (i < scoredSort.length) {
    let j = i;
    while (j + 1 < scoredSort.length && scoredSort[j + 1]!.pp === scoredSort[i]!.pp) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  const nPos = scoredSort.reduce((s2, x) => s2 + x.label, 0);
  const nNeg = scoredSort.length - nPos;
  if (!nPos || !nNeg) return Number.NaN;
  let rankSumPos = 0;
  scoredSort.forEach((x, k) => {
    if (x.label) rankSumPos += ranks[k]!;
  });
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
};
const brier = (set: Sample[]): number => {
  const ps = predict(set);
  return ps.reduce((s2, pp, i) => s2 + (pp - set[i]!.label) ** 2, 0) / (set.length || 1);
};
const valAuc = auc(val);
const valBase = val.reduce((s2, x) => s2 + x.label, 0) / (val.length || 1);
const trainBase = train.reduce((s2, x) => s2 + x.label, 0) / (train.length || 1);
const valBrier = brier(val);

// ---- 关键数字：按阈值采纳后的净期望（留出集）----
const minProb = config.jevMinProb;
const valP = predict(val);
const accepted = val.filter((_, i) => valP[i]! >= minProb);
const valAcceptedNetBps = accepted.length ? accepted.reduce((s2, x) => s2 + x.netBps, 0) / accepted.length : null;
const allNetBps = val.reduce((s2, x) => s2 + x.netBps, 0) / (val.length || 1);

console.log(`训练集  AUC ${auc(train).toFixed(3)}  正例率 ${trainBase.toFixed(3)}`);
console.log(`留出集  AUC ${valAuc.toFixed(3)}  Brier ${valBrier.toFixed(4)}  正例率 ${valBase.toFixed(3)}`);
console.log(`留出集  全体平均净期望 ${allNetBps.toFixed(1)}bp（任何不带筛选的基线）`);
console.log(
  `留出集  p ≥ ${minProb} 采纳 ${accepted.length}/${val.length}` +
    ` 平均净期望 ${valAcceptedNetBps === null ? "n/a" : valAcceptedNetBps.toFixed(1) + "bp"}`,
);
console.log("权重（标准化尺度）：");
LOCAL_FEATURES.forEach((f, i) => console.log(`  ${f.name.padEnd(14)} ${w[i]!.toFixed(4)}`));
console.log(`  ${"bias".padEnd(14)} ${b.toFixed(4)}`);

const weights: LocalWeights = {
  trainedAt: new Date().toISOString(),
  costBps,
  featureNames: LOCAL_FEATURES.map((f) => f.name),
  mean,
  std,
  w,
  b,
  metrics: {
    trainSamples: train.length,
    valSamples: val.length,
    trainBaseRate: trainBase,
    valBaseRate: valBase,
    valAuc,
    valBrier,
    valAcceptedNetBps,
    valAcceptedCount: accepted.length,
    valMinProb: minProb,
  },
};
await Bun.write(join(config.dataDir, "model.json"), JSON.stringify(weights, null, 1));
console.log(`已写入 ${join(config.dataDir, "model.json")}`);
