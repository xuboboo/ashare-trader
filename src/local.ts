/**
 * LocalModel：本地概率模型，填补 Jev（TypeSafe System One）的同一个插槽。
 *
 * 和 Jev 回答同一个可判定问题：
 *   "此刻按规则买入 X、次日按固定规则退出、扣除全部成本后，本笔收益为正"的概率是多少？
 * 区别在于参数不是远端模型给的，而是 scripts/train-model.ts 用本地日线 + 与回测完全
 * 相同的出场规则（src/exit.ts）训练出来的逻辑回归。三条硬约束与 JevModel 一致：
 *  1. 只看与规则层同源的 StockFeatures（日线和快照都能算出的字段），不给内幕字段；
 *  2. 硬否决（闸门/T+1/涨跌停/流动性/预算）不交给模型，模型只给通过筛选的候选排序；
 *  3. 没有模型文件、schema 不符、特征异常 → 降级回 FactorModel 并标 modelFailed。
 *
 * 诚实条款：模型文件里带着训练时的留出集指标（AUC、采纳后的净期望 bp）。
 * 指标差就是差，面板和本注释都不粉饰——这个项目已经证明过一次"这条 edge 不存在"，
 * 本地模型的全部意义是把"有没有料"变成一个可测量的数字。
 */
import { join } from "node:path";
import { config } from "./config";
import { roundTrip } from "./costs";
import type { Scored } from "./factors";
import { FactorModel, type Decision, type Model, type Pick, type SignalState } from "./model";
import { eligible as pickEligible } from "./jev";

/** 大盘上下文：实盘来自 SignalState.index，训练来自指数日线 —— 两边算出同一个数。 */
export interface MarketContext {
  indexPct: number;
  indexVsMa5Bp: number;
}

/** 特征表：训练与推理共用同一份定义，顺序即权重向量的顺序。 */
export const LOCAL_FEATURES: {
  name: string;
  get: (c: { features: Scored["features"]; score: number }, m?: MarketContext) => number;
}[] = [
  { name: "gainPct", get: (c) => c.features.gainPct },
  { name: "volumeRatio", get: (c) => c.features.volumeRatio },
  { name: "vwapDevBp", get: (c) => c.features.priceVsVwapBps / 100 },
  { name: "turnoverPct", get: (c) => c.features.turnoverPct },
  { name: "logAmountYi", get: (c) => Math.log10(Math.max(0.01, c.features.amountYuan / 1e8)) },
  { name: "distToLimitBp", get: (c) => ((c.features.limitUp - c.features.price) / c.features.price) * 1e4 / 100 },
  { name: "factorScore", get: (c) => c.score },
  // ---- v2：日内结构 ----
  { name: "gapPct", get: (c) => (c.features.prevClose > 0 ? ((c.features.open - c.features.prevClose) / c.features.prevClose) * 100 : 0) },
  {
    name: "dayRangePos",
    get: (c) => {
      const range = c.features.high - c.features.low;
      return range > 0 ? (c.features.price - c.features.low) / range : 0.5;
    },
  },
  // ---- v2：大盘上下文（缺指数时取 0 = 中性）----
  { name: "indexPct", get: (_c, m) => m?.indexPct ?? 0 },
  { name: "indexVsMa5Bp", get: (_c, m) => m?.indexVsMa5Bp ?? 0 },
  // ---- v2：交互项（放量×强度、大盘×个股动量）----
  { name: "gain_x_volume", get: (c) => c.features.gainPct * Math.max(0, c.features.volumeRatio) },
  {
    name: "index_x_gain",
    get: (c, m) => (m ? (m?.indexPct ?? 0) * Math.sign(c.features.gainPct) : 0),
  },
  // ---- v3：K 线微观形态（实体比例 + 上下影线，两路径均可算）----
  {
    name: "bodyRatio",
    get: (c) => {
      const range = c.features.high - c.features.low;
      if (range <= 0) return 0;
      return (c.features.price - c.features.open) / range;
    },
  },
  {
    name: "upperShadowPct",
    get: (c) => {
      const body = Math.max(c.features.price, c.features.open);
      const range = c.features.high - body;
      return range > 0 ? (range / Math.max(c.features.prevClose, 0.01)) * 100 : 0;
    },
  },
  {
    name: "lowerShadowPct",
    get: (c) => {
      const body = Math.min(c.features.price, c.features.open);
      const range = body - c.features.low;
      return range > 0 ? (range / Math.max(c.features.prevClose, 0.01)) * 100 : 0;
    },
  },
];

export interface LocalWeights {
  /** 训练元信息，如实透出给使用者 */
  trainedAt: string;
  costBps: number;
  /** 训练时的止损口径与入场时刻：与实盘不一致时模型概率不适用 */
  stopMode?: string;
  entryAt?: string;
  sizeCny?: number;
  featureNames: string[];
  mean: number[];
  std: number[];
  w: number[];
  b: number;
  metrics: {
    trainSamples: number;
    valSamples: number;
    trainBaseRate: number;
    valBaseRate: number;
    valAuc: number;
    valBrier: number;
    /** 留出集上按 minProb 采纳后的平均净期望（bp）；这是"有没有料"的那个数字 */
    valAcceptedNetBps: number | null;
    valAcceptedCount: number;
    valMinProb: number;
    /** 出场被卡死（一字跌停/停牌）按强平定价的样本占比：真实无法按规则出场的频率 */
    censoredShare?: number;
    /** 按“校准期望>0”采纳的条数与平均净期望：真正该看的决策准则 */
    valAcceptedByEvCount?: number;
    valAcceptedByEvBps?: number | null;
    /** 阈值扫描：各阈值下的采纳数与平均净期望，用于选择 JEV_MIN_PROB */
    thresholdSweep?: { p: number; n: number; netBps: number | null }[];
    /** 概率校准桶：预测概率 -> 实际频率与桶内平均净期望（EV 估计的原始数据） */
    calibration?: { pMean: number; n: number; actualFreq: number; meanNetBps: number | null }[];
  };
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export function featureVec(c: { features: Scored["features"]; score: number }, m?: MarketContext): number[] {
  return LOCAL_FEATURES.map((f) => f.get(c, m));
}

/** 标准化 + 线性 + sigmoid。任何非有限值都返回 null，由调用方降级。 */
export function probability(x: number[], w: LocalWeights): number | null {
  if (x.length !== w.w.length) return null;
  let z = w.b;
  for (let i = 0; i < x.length; i++) {
    const sd = w.std[i]!;
    if (!Number.isFinite(sd) || sd <= 0) continue; // 常数特征：标准化后恒 0
    z += w.w[i]! * ((x[i]! - w.mean[i]!) / sd);
  }
  if (!Number.isFinite(z)) return null;
  return sigmoid(Math.max(-30, Math.min(30, z)));
}

export class LocalModel implements Model {
  readonly name = "local";
  private fallback = new FactorModel();
  private weightsCache: LocalWeights | null | undefined;
  private warnedNoWeights = false;

  constructor(
    private opts: { weights?: LocalWeights | null; dataDir?: string; budgetCny?: number; minProb?: number } = {},
  ) {}

  private get budgetCny(): number {
    return this.opts.budgetCny ?? config.sizeCny;
  }

  private get minProb(): number {
    return this.opts.minProb ?? config.jevMinProb;
  }

  /** 用校准桶把概率映射成 EV 估计（净期望 bp）；无校准数据返回 null，不编数字。 */
  private evEstimate(p: number, w: LocalWeights): number | null {
    const cal = w.metrics.calibration;
    if (!cal || !cal.length) return null;
    let best = cal[0]!;
    for (const c of cal) if (Math.abs(c.pMean - p) < Math.abs(best.pMean - p)) best = c;
    return best.meanNetBps;
  }

  /** 权重惰性加载一次；读取失败或 schema 不符都视为"没有模型"。 */
  private async weights(): Promise<LocalWeights | null> {
    if (this.weightsCache !== undefined) return this.weightsCache;
    if (this.opts.weights !== undefined) {
      this.weightsCache = this.opts.weights;
      return this.weightsCache;
    }
    try {
      const j = await Bun.file(join(this.opts.dataDir ?? config.dataDir, "model.json")).json();
      const w = j as LocalWeights;
      const ok =
        Array.isArray(w.w) &&
        Array.isArray(w.mean) &&
        Array.isArray(w.std) &&
        Array.isArray(w.featureNames) &&
        w.featureNames.length === LOCAL_FEATURES.length &&
        LOCAL_FEATURES.every((f, i) => f.name === w.featureNames[i]);
      this.weightsCache = ok ? w : null;
    } catch {
      this.weightsCache = null;
    }
    return this.weightsCache;
  }

  /** 测试与运维用：强制下次重新读文件。 */
  resetCache(): void {
    this.weightsCache = undefined;
  }

  async decide(s: SignalState): Promise<Decision> {
    const t0 = performance.now();
    const list = pickEligible(s, this.budgetCny);

    if (!s.allowed.buy || !s.gate.allowed || s.openSlots <= 0 || list.length === 0) {
      // 闸门关着或没额度：这是规则层的结论，不需要模型
      return this.fallback.decide(s);
    }

    const w = await this.weights();
    if (!w) {
      if (!this.warnedNoWeights) {
        this.warnedNoWeights = true;
        console.warn("[local] 没有可用的 model.json（先跑 bun run scripts/train-model.ts），降级为 FactorModel");
      }
      const d = await this.fallback.decide(s);
      return { ...d, modelFailed: true, latencyMs: performance.now() - t0 };
    }

    // 大盘上下文：与训练侧（指数日线）同一口径
    const m: MarketContext | undefined = s.index
      ? {
          indexPct: s.index.pct,
          indexVsMa5Bp: s.index.ma5 ? ((s.index.price / s.index.ma5 - 1) * 1e4) / 100 : 0,
        }
      : undefined;

    /**
     * 采纳准则：有校准表就用“校准后期望 > 0”，没校准表才退回 P(赢) ≥ minProb。
     * 拿胜率过阈当买入条件是错的：止损剪掉上行尾部，胜率赢不等于期望赢；
     * 而训练报告里已经落盘了每个概率桶的平均净期望，不用它没道理。
     */
    const hasCal = (w.metrics.calibration?.length ?? 0) > 0;
    const accept = (p: number, ww: LocalWeights): boolean => {
      if (hasCal) {
        const ev = this.evEstimate(p, ww);
        if (ev !== null) return ev > 0;
      }
      return p >= this.minProb;
    };

    const probs = new Map<string, number>();
    for (const c of list) {
      const p = probability(featureVec(c, m), w);
      if (p !== null) probs.set(c.features.code, p);
    }
    if (!probs.size) {
      console.error("[local] 特征全部异常，降级为 FactorModel");
      const d = await this.fallback.decide(s);
      return { ...d, modelFailed: true, latencyMs: performance.now() - t0 };
    }

    const picks: Pick[] = list
      .filter((c) => accept((probs.get(c.features.code) ?? 0), w))
      .sort((a, b) => (probs.get(b.features.code) ?? 0) - (probs.get(a.features.code) ?? 0))
      .slice(0, Math.min(s.openSlots, config.k))
      .map((c) => {
        const p = probs.get(c.features.code) ?? 0;
        const ev = this.evEstimate(p, w);
        const evNote = ev === null ? "" : ` 净期望≈${(ev / 100).toFixed(2)}%`;
        return {
          code: c.features.code,
          name: c.features.name,
          probability: p,
          score: c.score,
          reasons: [...c.reasons, `本地模型判定 ${(100 * p).toFixed(0)}%${evNote}`],
        };
      });

    const best = Math.max(...probs.values());
    return {
      action: picks.length ? "buy" : "hold",
      probabilities: { buy: picks.length ? best : 0, sell: 0, hold: picks.length ? 1 - best : 1 },
      probabilitySemantics: "calibrated",
      picks,
      latencyMs: performance.now() - t0,
      late: false,
      inputTokens: 0,
      modelFailed: false,
    };
  }
}
