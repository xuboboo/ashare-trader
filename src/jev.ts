/**
 * JevModel：把 TypeSafe 的 System One 模型 Jev 用作 A 股尾盘买入选股的决策模型。
 *
 * Jev 不生成文本：给它一份 state 和若干问题，它并行返回带概率的结构化答案。
 * 所以我们问的问题必须是**可判定的陈述**，而不是"你怎么看这只票"：
 *   "在 14:45 以对手价买入 X，并按规则于次日 10:00 前退出，扣除约 11.6bp 往返成本后本笔期望为正"
 * 返回的 probability 就是该陈述为真的概率（boolean 型问题映射到 TypeSafe 的 noul）。
 *
 * 三条硬约束：
 *  1. 模型看到的 state 与规则层完全相同（同一份 StockFeatures + 同一个成本口径），
 *     不允许给模型额外的"内幕字段"，否则回测/实盘一致性就破了；
 *  2. 大盘闸门、T+1、涨跌停、流动性这些**不交给模型**，仍然是代码里的硬否决；
 *     Jev 只在已经通过筛选的候选里排序并给胜率；
 *  3. 没配 key、超时、返回解析失败 → 立刻降级回 FactorModel，并在事件里标 modelFailed，
 *     绝不让"模型挂了"变成"今天不出单"或"编一个概率"。
 */
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { roundTrip } from "./costs";
import type { Scored } from "./factors";
import { FactorModel, type Decision, type Model, type Pick, type SignalState } from "./model";
import { hhmmOf } from "./session";

export interface JevAnswer {
  type: string;
  probability?: number;
  choice?: string;
  probabilities?: Record<string, number>;
}

export interface JevReply {
  answers: Record<string, JevAnswer>;
  inputTokens: number;
}

export type JevAsk = (args: { state: unknown; questions: Record<string, unknown>; timeoutMs: number }) => Promise<JevReply>;

/** 真实调用。测试里换成假实现，逻辑就能离线验证。 */
export const defaultAsk: JevAsk = async ({ state, questions, timeoutMs }) => {
  const provider = createTypeSafeAi({ apiKey: config.typesafeApiKey, baseURL: config.typesafeBaseUrl });
  const r = await experimental_evaluate({
    model: provider.evaluationModel(config.jevModelId),
    state: state as never,
    questions: questions as never,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return {
    answers: r.answers as unknown as Record<string, JevAnswer>,
    inputTokens: r.usage?.inputTokens ?? 0,
  };
};

/** 只问那些已经通过硬约束的候选；按规则分从高到低取前 N。 */
export function eligible(s: SignalState): Scored[] {
  return s.candidates
    .filter((c) => c.rejects.length === 0 && c.score > 0 && !(c.features.code in s.vetoes))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.jevMaxQuestions);
}

/** 共享 state：一次请求里所有问题都对着它判定。 */
export function buildState(s: SignalState, list: Scored[], costBps: number) {
  return {
    market: "A 股 沪深主板 + 创业板",
    date: s.date,
    decideAt: s.time,
    holdPeriod: "隔夜，次日 10:00 前必须清仓（T+1）",
    roundTripCostBps: costBps,
    index: s.index,
    gate: s.gate,
    held: s.heldCodes,
    candidates: list.map((c) => ({
      code: c.features.code,
      name: c.features.name,
      price: c.features.price,
      gainPct: Number(c.features.gainPct.toFixed(2)),
      volumeRatio: Number(c.features.volumeRatio.toFixed(2)),
      priceVsVwapBps: Math.round(c.features.priceVsVwapBps),
      turnoverPct: Number(c.features.turnoverPct.toFixed(2)),
      amountYi: Number((c.features.amountYuan / 1e8).toFixed(2)),
      distanceToLimitUpBps: Math.round(((c.features.limitUp - c.features.price) / c.features.price) * 10_000),
      factorScore: Number(c.score.toFixed(2)),
    })),
  };
}

export function buildQuestions(s: SignalState, list: Scored[], costBps: number): Record<string, unknown> {
  const exitAt = hhmmOf(config.forceExitMin);
  const questions: Record<string, unknown> = {};
  list.forEach((c, i) => {
    questions[`q${i}`] = {
      type: "boolean",
      instructions:
        `在 ${s.date} ${s.time} 以对手价买入 ${c.features.name}(${c.features.code})，` +
        `并按固定规则于次日 ${exitAt} 前退出（高开超 ${config.gapTrimPct}% 先减半、跌破止损即走、到点无条件清仓），` +
        `在扣除约 ${costBps.toFixed(1)}bp 的往返成本后，这笔交易的收益为正。`,
    };
  });
  return questions;
}

export class JevModel implements Model {
  /** 模型 id 本身就是 "jev-latest"，不要再加前缀 */
  readonly name = config.jevModelId;
  private fallback = new FactorModel();

  /**
   * apiKey / dataDir 可注入，为了能在测试里验证"没 key 降级"与"正常出单"两条路径，
   * 而不用去改进程环境变量（config 在首次 import 时就固定了）。
   */
  constructor(
    private ask: JevAsk = defaultAsk,
    private opts: { apiKey?: string | null; dataDir?: string } = {},
  ) {}

  private get apiKey(): string | undefined | null {
    return this.opts.apiKey === undefined ? config.typesafeApiKey : this.opts.apiKey;
  }

  async decide(s: SignalState): Promise<Decision> {
    const t0 = performance.now();
    const list = eligible(s);
    const dir = this.opts.dataDir ?? config.dataDir;

    if (!s.allowed.buy || !s.gate.allowed || s.openSlots <= 0 || list.length === 0) {
      // 闸门关着或没额度：这是规则层的结论，不需要花一次模型调用
      return this.fallback.decide(s);
    }

    if (!this.apiKey) {
      console.warn("[jev] 未配置 TYPESAFE_AI_API_KEY，降级为 FactorModel");
      const d = await this.fallback.decide(s);
      return { ...d, modelFailed: true, latencyMs: performance.now() - t0 };
    }

    const costBps = roundTrip(config.sizeCny).bps;
    const state = buildState(s, list, costBps);
    const questions = buildQuestions(s, list, costBps);
    const cacheKey = join(dir, "llm", `jev-${s.date}-${Bun.hash(JSON.stringify({ state, questions })).toString(36)}.json`);

    let reply: JevReply | null = null;
    try {
      const cached = await Bun.file(cacheKey).json().catch(() => null);
      if (cached?.answers) reply = cached as JevReply;
      else {
        reply = await this.ask({ state, questions, timeoutMs: config.jevTimeoutMs });
        await mkdir(join(dir, "llm"), { recursive: true });
        await Bun.write(cacheKey, JSON.stringify({ date: s.date, answers: reply.answers, inputTokens: reply.inputTokens }));
      }
    } catch (e) {
      console.error(`[jev] 调用失败，降级为 FactorModel: ${(e as Error).message}`);
      const d = await this.fallback.decide(s);
      return { ...d, modelFailed: true, latencyMs: performance.now() - t0 };
    }

    const probs = new Map<string, number>();
    list.forEach((c, i) => {
      const a = reply!.answers[`q${i}`];
      const p = typeof a?.probability === "number" ? a.probability : Number.NaN;
      if (Number.isFinite(p)) probs.set(c.features.code, Math.max(0, Math.min(1, p)));
    });

    if (!probs.size) {
      console.error("[jev] 返回里没有任何可用概率，降级为 FactorModel");
      const d = await this.fallback.decide(s);
      return { ...d, modelFailed: true, latencyMs: performance.now() - t0 };
    }

    const picks: Pick[] = list
      .filter((c) => (probs.get(c.features.code) ?? 0) >= config.jevMinProb)
      .sort((a, b) => (probs.get(b.features.code) ?? 0) - (probs.get(a.features.code) ?? 0))
      .slice(0, Math.min(s.openSlots, config.k))
      .map((c) => ({
        code: c.features.code,
        name: c.features.name,
        probability: probs.get(c.features.code) ?? 0,
        score: c.score,
        reasons: [...c.reasons, `Jev 判定 ${(100 * (probs.get(c.features.code) ?? 0)).toFixed(0)}%`],
      }));

    const best = Math.max(...probs.values());
    const probabilities = { buy: picks.length ? best : 0, sell: 0, hold: picks.length ? 1 - best : 1 };

    return {
      action: picks.length ? "buy" : "hold",
      probabilities,
      picks,
      latencyMs: performance.now() - t0,
      late: false,
      inputTokens: reply.inputTokens,
      modelFailed: false,
    };
  }
}
