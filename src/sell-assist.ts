/**
 * Jev 卖出辅助：对已持有的可卖仓位，向 Jev 提出一个可判定的布尔问题——
 *   "立即按盘口卖出并持有现金，净收益高于按卖出规则持有到下一交易日10:00清仓"
 * 定位是**辅助**而非接管：止损、10:00 期限这些硬规则永远是底线，Jev 只能
 * 在规则触发之前给出"提前离场"的建议。每仓位每交易日最多评估一次。
 *
 * 可测量性：每次评估的概率与建议全部落盘（data/shadow/ 同目录 sellAssist 行），
 * 两周后用"Jev 建议提前离场的仓位 vs 纯规则持有"的实际结果对比裁决去留。
 */
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

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
  note?: string;
}

export type SellAssistAsk = (
  inputs: SellAssistInput[],
) => Promise<Record<string, number>>;

/** 真实调用：一次请求批量评估所有仓位（state 共享，问题按 code 索引）。 */
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
  });
  const r = await experimental_evaluate({
    model: provider.evaluationModel(config.jevModelId),
    state: { positions: inputs, rules: "T+1；次日10:00前无条件清仓；含佣金/印花税/过户费" } as never,
    questions: questions as never,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.jevTimeoutMs),
  });
  const out: Record<string, number> = {};
  inputs.forEach((p, i) => {
    const a = (r.answers as Record<string, { probability?: number }>)[`q${i}`];
    out[p.code] = typeof a?.probability === "number" ? a.probability : Number.NaN;
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
   * 批量评估：返回每个仓位的建议。概率 ≥ 阈值 → 建议提前离场；
   * 无法评估（NaN）的仓位标记但不建议。
   */
  async advise(inputs: SellAssistInput[]): Promise<SellAdvice[]> {
    if (!inputs.length) return [];
    let answers: Record<string, number>;
    try {
      answers = await this.ask(inputs);
    } catch (e) {
      return inputs.map((p) => ({ code: p.code, pExitBetter: Number.NaN, suggestExit: false, note: `评估失败: ${(e as Error).message.slice(0, 80)}` }));
    }
    return inputs.map((p, i) => {
      const pExitBetter = answers[p.code];
      const ok = Number.isFinite(pExitBetter);
      return {
        code: p.code,
        pExitBetter: ok ? (pExitBetter as number) : Number.NaN,
        suggestExit: ok && (pExitBetter as number) >= config.jevMinProb,
        note: ok ? undefined : "评估失败",
      };
    });
  }
}
