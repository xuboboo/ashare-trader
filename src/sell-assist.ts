/**
 * 已弃用的兼容模块：生产引擎不再导入 SellAdvisor。
 * 当前 Jev 全程模式由 JevModel.decide({ decisionMode: "sell" }) 统一负责卖出判断；
 * 此文件仅保留给旧测试和外部兼容调用，不能作为生产卖出决策源。
 *
 * 历史实现：对已持有的可卖仓位，向 Jev 提出两个可判定的问题——
 *   1)（boolean）"立即按盘口卖出并持有现金，净收益高于按卖出规则持有到下一交易日10:00清仓"的概率；
 *   2)（score）若卖出，挂出的限价相对现价的位置：0 = 立即按市价对手价成交，
 *      6 = 挂高约 3% 等更好的价。分数插值成具体限价（offsetPct = score/6 × 3%）。
 * 定位是**辅助**而非接管：止损、10:00 期限这些硬规则永远是底线，它们按触发瞬间
 * 市价出单不等模型；只有 Jev 自己建议的提前离场单才用 Jev 定的价。
 * 评估随决策轮进行，概率与定价逐次落盘 data/shadow/<日期>-sell-assist.jsonl
 * （engine.persistSellAdvice），两周后用"Jev 建议提前离场的仓位 vs 纯规则持有"
 * 的实际结果对比裁决去留。
 */
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

/** 卖出限价评分档：offsetPct = score / (PX_LEVELS - 1) × PX_MAX_PCT */
export const PX_LEVELS = 7;
export const PX_MAX_PCT = 3;

export const pxOffsetPctOf = (score: number): number =>
  (Math.min(Math.max(score, 0), PX_LEVELS - 1) / (PX_LEVELS - 1)) * PX_MAX_PCT;

export interface SellAssistInput {
  code: string;
  name: string;
  /** 成本价 */
  entry: number;
  /** 现价 */
  price: number;
  /** 浮动盈亏 % */
  unrealizedPct: number;
  /** 止损触发价 */
  stop: number;
  /** 已持有交易日数 */
  heldDays: number;
}

export interface SellAdvice {
  code: string;
  /** "立即卖出更优"的概率；null = 本次无法评估 */
  pExitBetter: number | null;
  suggestExit: boolean;
  /** Jev 定价的限价相对现价的加价幅度（%，0 = 市价离场）；null = 未给出 */
  priceOffsetPct?: number | null;
  note?: string;
}

export interface SellAnswer {
  /** "立即卖出更优"的概率；NaN = 不可评估 */
  p: number;
  /** 限价加价幅度 %；null = 模型没给出 */
  offsetPct: number | null;
}

export type SellAssistAsk = (
  inputs: SellAssistInput[],
) => Promise<Record<string, SellAnswer>>;

/** 真实调用：一次请求批量评估所有仓位（state 共享，问题按 code 索引，每仓两问）。 */
export const defaultSellAssistAsk: SellAssistAsk = async (inputs) => {
  const provider = createTypeSafeAi({ apiKey: config.typesafeApiKey, baseURL: config.typesafeBaseUrl });
  const questions: Record<string, unknown> = {};
  inputs.forEach((p, i) => {
    questions[`q${i}`] = {
      type: "boolean",
      instructions:
        `持仓 ${p.name}(${p.code})：成本 ${p.entry} 元，现价 ${p.price} 元（浮动 ${p.unrealizedPct.toFixed(1)}%），` +
        `已持有 ${p.heldDays} 个交易日，止损触发线 ${p.stop} 元。两种选择：` +
        `A 立即按盘口卖出并持有现金；B 按既定规则继续持有（跌破 ${p.stop} 元止损，` +
        `否则到下一交易日 10:00 无条件清仓）。` +
        `A 的净收益（含全部税费）高于 B 的概率是多少？`,
    };
    questions[`q${i}px`] = {
      type: "score",
      instructions:
        `若立即卖出 ${p.name}(${p.code})（现价 ${p.price} 元），你希望挂出的卖出限价相对现价的位置？` +
        `0 = 立即按市价对手价成交（优先保证卖掉）；最高档 = 挂高约 ${PX_MAX_PCT}% 等更好的价（有卖不掉的风险）。` +
        `只表达价格意图，不考虑是否应该卖。`,
      criteria: Array.from({ length: PX_LEVELS }, (_, lv) => {
        const pct = (lv / (PX_LEVELS - 1)) * PX_MAX_PCT;
        return lv === 0 ? "立即按市价对手价成交" : `现价上方约 ${pct.toFixed(1)}% 挂限价`;
      }),
    };
  });
  const r = await experimental_evaluate({
    model: provider.evaluationModel(config.jevModelId),
    state: { positions: inputs, rules: "T+1；次日10:00前无条件清仓；含佣金/印花税/过户费" } as never,
    questions: questions as never,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.jevTimeoutMs),
  });
  const out: Record<string, SellAnswer> = {};
  inputs.forEach((p, i) => {
    const a = (r.answers as Record<string, { type?: string; probability?: number; score?: number }>)[`q${i}`];
    const px = (r.answers as Record<string, { type?: string; probability?: number; score?: number }>)[`q${i}px`];
    out[p.code] = {
      p: typeof a?.probability === "number" ? a.probability : Number.NaN,
      offsetPct: typeof px?.score === "number" ? pxOffsetPctOf(px.score) : null,
    };
  });
  return out;
};

export class SellAdvisor {
  constructor(
    private ask: SellAssistAsk = defaultSellAssistAsk,
    private opts: { threshold?: number } = {},
  ) {}

  private get threshold(): number {
    return this.opts.threshold ?? config.jevMinProb;
  }

  /**
   * 批量评估：返回每个仓位的建议。概率 ≥ 阈值 → 建议提前离场（附模型定价）；
   * 无法评估（NaN）的仓位标记但不建议。
   */
  async advise(inputs: SellAssistInput[]): Promise<SellAdvice[]> {
    if (!inputs.length) return [];
    let answers: Record<string, SellAnswer>;
    try {
      answers = await this.ask(inputs);
    } catch (e) {
      return inputs.map((p) => ({ code: p.code, pExitBetter: Number.NaN, suggestExit: false, note: `评估失败: ${(e as Error).message.slice(0, 80)}` }));
    }
    return inputs.map((p) => {
      const a = answers[p.code];
      const pExitBetter = a?.p;
      const ok = Number.isFinite(pExitBetter);
      return {
        code: p.code,
        pExitBetter: ok ? (pExitBetter as number) : Number.NaN,
        suggestExit: ok && (pExitBetter as number) >= this.threshold,
        priceOffsetPct: a?.offsetPct ?? null,
        note: ok ? undefined : "评估失败",
      };
    });
  }
}
