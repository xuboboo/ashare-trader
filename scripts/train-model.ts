/**
 * 训练本地概率模型（MODEL=local 的"本地 Jev"）：
 * 用本地日线回放历史，每一条样本 = 某日某股通过了与实盘完全相同的硬筛选后，
 * 按 src/exit.ts 的同一条出场规则（与回测共享）走完"次日退出"，扣掉全部成本后是否为正。
 *
 * v2 评估协议（不依赖记忆、每次训练现场重算）：
 *  - walk-forward 3 折交叉验证：按时间向前滚动，后段做验证 —— 报告每折 AUC，看稳定性；
 *  - 留出集（最后 15%）：AUC / Brier / 按 minProb 采纳后的平均净期望 bp；
 *  - 概率分桶校准表：预测概率 vs 实际频率，一眼看出模型"自信得对不对"。
 * 全部指标如实写进 data/model.json。指标差就是差，本脚本不粉饰。
 *
 * 用法：
 *   bun run scripts/train-model.ts                 # 全部本地日线
 *   bun run scripts/train-model.ts --split=0.8     # 最终模型的留出集比例
 */
import { join } from "node:path";
import { config } from "../src/config";
import { roundTrip } from "../src/costs";
import { nextDayExit } from "../src/exit";
import { featuresFromDaily, scoreStock } from "../src/factors";
import { LOCAL_FEATURES, featureVec, type LocalWeights, type MarketContext } from "../src/local";
import { fetchIndexDaily, type DailyBar } from "../src/quotes";
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

interface Model {
  mean: number[];
  std: number[];
  w: number[];
  b: number;
}

const dim = LOCAL_FEATURES.length;
const costBps = roundTrip(config.sizeCny).bps;

// ---- 指数上下文（与实盘 SignalState.index 同口径）----
const indexBars = await fetchIndexDaily(800).catch(() => [] as DailyBar[]);
const indexCtx = new Map<string, MarketContext>();
{
  const byDate = new Map(indexBars.map((b, i) => [b.date, i] as const));
  for (let i = 1; i < indexBars.length; i++) {
    const b = indexBars[i]!;
    const prev = indexBars[i - 1]!;
    let ma5: number | null = null;
    if (i >= 5) {
      let s = 0;
      for (let j = i - 5; j < i; j++) s += indexBars[j]!.close;
      ma5 = s / 5;
    }
    indexCtx.set(b.date, {
      indexPct: prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : 0,
      indexVsMa5Bp: ma5 ? ((b.close / ma5 - 1) * 1e4) / 100 : 0,
    });
  }
  void byDate;
}

// ---- 样本构建 ----
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
    {
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
    const m = indexCtx.get(bar.date);
    samples.push({ date: bar.date, x: featureVec({ features: f, score: sc.score }, m), label: netBps > 0 ? 1 : 0, netBps });
  }
}
if (samples.length < 500) {
  console.error(`!! 样本只有 ${samples.length} 条，训练无意义。多拉些日线：bun run scripts/fetch-daily.ts`);
  process.exit(1);
}
samples.sort((a, b) => a.date.localeCompare(b.date));

// ---- 逻辑回归：零初始化 + 全量批梯度下降 + L2（完全确定性）----
function fit(train: Sample[]): Model {
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const s of train) for (let i = 0; i < dim; i++) mean[i]! += s.x[i]! / train.length;
  for (const s of train) for (let i = 0; i < dim; i++) std[i]! += (s.x[i]! - mean[i]!) ** 2 / train.length;
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i]!) || 1;
  const z = (x: number[]) => x.map((v, i) => (v - mean[i]!) / std[i]!);
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
  return { mean, std, w, b };
}

function predict(model: Model, set: Sample[]): number[] {
  return set.map((s) => {
    let z = model.b;
    for (let i = 0; i < dim; i++) {
      const sd = model.std[i]!;
      if (sd > 0) z += model.w[i]! * ((s.x[i]! - model.mean[i]!) / sd);
    }
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  });
}

function aucOf(set: Sample[], ps: number[]): number {
  const n = set.length;
  if (!n) return Number.NaN;
  const pairs = set.map((s, i) => ({ label: s.label, p: ps[i]! })).sort((a, b) => a.p - b.p);
  const ranks = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && pairs[j + 1]!.p === pairs[i]!.p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  const nPos = pairs.reduce((s, x) => s + x.label, 0);
  const nNeg = n - nPos;
  if (!nPos || !nNeg) return Number.NaN;
  let posRank = 0;
  pairs.forEach((x, k) => {
    if (x.label) posRank += ranks[k]!;
  });
  return (posRank - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function evalModel(model: Model, set: Sample[]): { auc: number; brier: number; base: number } {
  const ps = predict(model, set);
  const base = set.reduce((s, x) => s + x.label, 0) / (set.length || 1);
  const brier = ps.reduce((s, pp, i) => s + (pp - set[i]!.label) ** 2, 0) / (set.length || 1);
  return { auc: aucOf(set, ps), brier, base };
}

// ---- walk-forward 3 折：时间上向前滚动，永远"用过去预测未来" ----
const dates = [...new Set(samples.map((s) => s.date))].sort();
const seg = (k: number) => dates.slice(Math.floor((dates.length * k) / 4), Math.floor((dates.length * (k + 1)) / 4));
const segments = [seg(0), seg(1), seg(2), seg(3)];
const at = (segDates: string[]) => samples.filter((s) => segDates.includes(s.date));
console.log(`样本 ${samples.length}（正例率 ${(samples.reduce((s, x) => s + x.label, 0) / samples.length).toFixed(3)}）` +
  ` 特征 ${dim} 成本口径 ${costBps.toFixed(1)}bp 跳过：一字跌停 ${skippedOneLineDown}、次日停牌 ${skippedSuspNext}`);

for (let f = 1; f <= 3; f++) {
  const train = samples.filter((s) => s.date < segments[f]![0]!);
  const val = at(segments[f]!);
  if (!train.length || !val.length) continue;
  const m = fit(train);
  const r = evalModel(m, val);
  console.log(`walk-forward 折${f}: 训练 ${train.length}（< ${segments[f]![0]}） 验证 ${val.length}  AUC ${r.auc.toFixed(3)}  Brier ${r.brier.toFixed(4)}  正例率 ${r.base.toFixed(3)}`);
}

// ---- 最终模型：前 85% 训练，后 15% 留出 ----
const splitDate = dates[Math.floor(dates.length * splitFrac)]!;
const train = samples.filter((s) => s.date < splitDate);
const val = samples.filter((s) => s.date >= splitDate);
const model = fit(train);
const valP = predict(model, val);
const valBase = val.reduce((s, x) => s + x.label, 0) / (val.length || 1);
const valBrier = valP.reduce((s, pp, i) => s + (pp - val[i]!.label) ** 2, 0) / (val.length || 1);
const trainR = evalModel(model, train);

console.log(`最终模型  训练 ${train.length}（< ${splitDate}）  训练集 AUC ${trainR.auc.toFixed(3)}`);
console.log(`留出集    AUC ${aucOf(val, valP).toFixed(3)}  Brier ${valBrier.toFixed(4)}  正例率 ${valBase.toFixed(3)}`);
console.log(`留出集    全体平均净期望 ${(val.reduce((s, x) => s + x.netBps, 0) / (val.length || 1)).toFixed(1)}bp（不带筛选的基线）`);

// 概率分桶校准表
const buckets = [0, 0.2, 0.4, 0.6, 0.8, 1.001];
console.log("校准      预测概率桶 -> 实际频率（桶内样本数）");
for (let i = 0; i < buckets.length - 1; i++) {
  const idx: number[] = [];
  valP.forEach((pp, k) => {
    if (pp >= buckets[i]! && pp < buckets[i + 1]!) idx.push(k);
  });
  if (!idx.length) continue;
  const freq = idx.reduce((s, k) => s + val[k]!.label, 0) / idx.length;
  console.log(`  [${buckets[i]!.toFixed(1)}, ${buckets[i + 1]!.toFixed(1)})  ${(buckets[i]! + buckets[i + 1]!) / 2 >= 0 ? "" : ""}实际 ${freq.toFixed(3)}（${idx.length}）`);
}

const minProb = config.jevMinProb;
const acceptedIdx = valP.map((pp, i) => (pp >= minProb ? i : -1)).filter((i) => i >= 0);
const valAcceptedNetBps = acceptedIdx.length ? acceptedIdx.reduce((s, k) => s + val[k]!.netBps, 0) / acceptedIdx.length : null;
console.log(`留出集    p ≥ ${minProb} 采纳 ${acceptedIdx.length}/${val.length}` +
  ` 平均净期望 ${valAcceptedNetBps === null ? "n/a" : valAcceptedNetBps.toFixed(1) + "bp"}`);

// 阈值扫描：MODEL=local 的采纳阈值该定在哪，看这张表而不是拍脑袋
console.log("阈值扫描  阈值 -> 采纳数 / 平均净期望 bp（留出集）");
const thresholdSweep: { p: number; n: number; netBps: number | null }[] = [];
for (let p = 0.3; p <= 0.7001; p += 0.05) {
  const idx = valP.map((pp, i) => (pp >= p ? i : -1)).filter((i) => i >= 0);
  const net = idx.length ? idx.reduce((s, k) => s + val[k]!.netBps, 0) / idx.length : null;
  thresholdSweep.push({ p: Math.round(p * 100) / 100, n: idx.length, netBps: net });
  console.log(`  p ≥ ${p.toFixed(2)}  ${String(idx.length).padStart(5)}  ${net === null ? "n/a" : net.toFixed(1)}`);
}
console.log("权重（标准化尺度）：");
LOCAL_FEATURES.forEach((f, i) => console.log(`  ${f.name.padEnd(14)} ${model.w[i]!.toFixed(4)}`));
console.log(`  ${"bias".padEnd(14)} ${model.b.toFixed(4)}`);

const weights: LocalWeights = {
  trainedAt: new Date().toISOString(),
  costBps,
  featureNames: LOCAL_FEATURES.map((f) => f.name),
  mean: model.mean,
  std: model.std,
  w: model.w,
  b: model.b,
  metrics: {
    trainSamples: train.length,
    valSamples: val.length,
    trainBaseRate: trainR.base,
    valBaseRate: valBase,
    valAuc: aucOf(val, valP),
    valBrier,
    valAcceptedNetBps,
    valAcceptedCount: acceptedIdx.length,
    valMinProb: minProb,
    thresholdSweep,
  },
};
await Bun.write(join(config.dataDir, "model.json"), JSON.stringify(weights, null, 1));
console.log(`已写入 ${join(config.dataDir, "model.json")}`);
