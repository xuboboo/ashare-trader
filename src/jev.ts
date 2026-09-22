/**
 * JevModel：唯一的买卖判断源。
 *
 * FactorModel 只负责代码硬筛选后的候选输入，不负责排序结论、不负责概率、不负责降级。
 * Jev 未配置、远端失败、缓存/回复无效时一律 HOLD，并把原因写进 Decision.trace；
 * 绝不把 FactorModel 的 rank-share 冒充成 Jev 的 model-prompt 概率。
 *
 * 止损、T+1、涨跌停、券商 submit 开关仍是系统安全边界，不交给模型绕过。
 */
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { roundTrip } from "./costs";
import type { Scored } from "./factors";
import type { Decision, DecisionTrace, HeldPositionInput, Model, Pick, SignalState } from "./model";
import { cannotAffordLot } from "./symbols";

export interface JevAnswer {
  type: string;
  probability?: number;
  choice?: string;
  score?: number;
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

/** 只过滤系统硬否决；score 只用于在超过请求上限时做确定性截断，不是最终排序/概率。 */
export function eligible(s: SignalState, budgetCny: number = config.sizeCny): Scored[] {
  return s.candidates
    .filter(
      (c) =>
        c.rejects.length === 0 &&
        !cannotAffordLot(c.features.price, budgetCny) &&
        !(c.features.code in s.vetoes),
    )
    .sort((a, b) => b.score - a.score || a.features.code.localeCompare(b.features.code))
    .slice(0, config.jevMaxQuestions);
}

/** 共享 state：买入候选与卖出持仓在同一次 Jev 请求中各自使用清晰的上下文。 */
export function buildState(
  s: SignalState,
  list: Scored[],
  costBps: number,
  positions: HeldPositionInput[] = s.positions ?? [],
) {
  return {
    market: "A 股 沪深主板 + 创业板",
    date: s.date,
    decideAt: s.time,
    decisionMode: s.decisionMode ?? "buy",
    holdPeriod: "持仓期由 Jev 自主判断；T+1、止损与交易规则是硬约束",
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
      preScreenScore: Number(c.score.toFixed(2)),
    })),
    positions: positions.map((p) => ({ ...p })),
  };
}

export function buildQuestions(s: SignalState, list: Scored[], costBps: number): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  list.forEach((c, i) => {
    questions[`q${i}`] = {
      type: "boolean",
      instructions:
        `在 ${s.date} ${s.time} 以对手价买入 ${c.features.name}(${c.features.code})，` +
        `在不违反 T+1、止损、涨跌停与交易时段等系统硬约束的前提下，` +
        `由 Jev 自主判断退出时点与方式，` +
        `在扣除约 ${costBps.toFixed(1)}bp 的往返成本后，这笔交易的收益为正。` +
        `请独立判断该陈述，不要把候选的预筛分数当作概率。`,
    };
  });
  return questions;
}

export function buildSellQuestions(_s: SignalState, positions: HeldPositionInput[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  positions.forEach((p, i) => {
    questions[`q${i}`] = {
      type: "boolean",
      instructions:
        `持仓 ${p.name}(${p.code})：成本 ${p.entry.toFixed(2)} 元，当前可成交价约 ${p.price.toFixed(2)} 元，` +
        `浮动盈亏 ${p.unrealizedPct.toFixed(2)}%，已持有 ${p.heldDays} 个交易日，止损线 ${p.stop.toFixed(2)} 元。` +
        `在不违反止损、T+1、涨跌停与交易时段等系统硬约束的前提下，` +
        `现在按盘口卖出并持有现金，相比继续持有并由 Jev 自主决定退出时点，净收益更高的概率是多少？` +
        `请独立判断，不要把系统硬规则当成可取消的建议。`,
    };
    questions[`q${i}px`] = {
      type: "score",
      instructions:
        `若你决定现在卖出 ${p.name}(${p.code})，请给出价格意图：0 = 立即按买一/对手价成交，` +
        `最高档 = 当前价上方约 ${PX_MAX_PCT}% 挂限价等待更好价格。` +
        `只表达卖出价格意图，不改变是否卖出的判断。`,
      criteria: Array.from({ length: PX_LEVELS }, (_, lv) => {
        const pct = (lv / (PX_LEVELS - 1)) * PX_MAX_PCT;
        return lv === 0 ? "立即按买一/对手价成交" : `当前价上方约 ${pct.toFixed(1)}% 挂限价`;
      }),
    };
  });
  return questions;
}

export const PX_LEVELS = 7;
export const PX_MAX_PCT = 3;
export const pxOffsetPctOf = (score: number): number =>
  (Math.min(Math.max(score, 0), PX_LEVELS - 1) / (PX_LEVELS - 1)) * PX_MAX_PCT;

function holdDecision(t0: number, trace: DecisionTrace, inputTokens = 0): Decision {
  return {
    action: "hold",
    probabilities: { buy: 0, sell: 0, hold: 1 },
    probabilitySemantics: trace.source === "jev" ? "model-prompt" : undefined,
    picks: [],
    latencyMs: performance.now() - t0,
    late: false,
    inputTokens,
    modelFailed: trace.status === "not-configured" || trace.status === "failed" || trace.status === "invalid-response",
    trace,
  };
}

export class JevModel implements Model {
  readonly name = config.jevModelId;

  constructor(
    private ask: JevAsk = defaultAsk,
    private opts: { apiKey?: string | null; dataDir?: string; budgetCny?: number } = {},
  ) {}

  private get apiKey(): string | undefined | null {
    return this.opts.apiKey === undefined ? config.typesafeApiKey : this.opts.apiKey;
  }

  private get budgetCny(): number {
    return this.opts.budgetCny ?? config.sizeCny;
  }

  async decide(s: SignalState): Promise<Decision> {
    const t0 = performance.now();
    const isSell = s.decisionMode === "sell";
    const list = isSell ? [] : eligible(s, this.budgetCny);
    const positions = isSell ? (s.positions ?? []) : [];

    if (isSell && (!s.allowed.sell || positions.length === 0)) {
      return holdDecision(t0, { source: "hard-rule", model: this.name, call: "none", status: "skipped-hard-rule", reason: "无可卖 T+1 持仓" });
    }
    if (!isSell && (!s.allowed.buy || !s.gate.allowed || s.openSlots <= 0 || list.length === 0)) {
      return holdDecision(t0, { source: "hard-rule", model: this.name, call: "none", status: "skipped-hard-rule", reason: "硬闸门关闭或没有可执行候选" });
    }
    if (!this.apiKey) {
      const trace: DecisionTrace = { source: "jev", model: this.name, call: "none", status: "not-configured", reason: "TYPESAFE_AI_API_KEY 未配置" };
      console.error("[jev] 未配置 TYPESAFE_AI_API_KEY，本轮 fail-closed HOLD，不降级 FactorModel");
      return holdDecision(t0, trace);
    }

    const costBps = roundTrip(this.budgetCny).bps;
    const state = buildState(s, list, costBps, positions);
    const questions = isSell ? buildSellQuestions(s, positions) : buildQuestions(s, list, costBps);
    const requestHash = Bun.hash(JSON.stringify({ model: config.jevModelId, state, questions })).toString(36);
    const root = this.opts.dataDir ?? config.dataDir;
    const cacheKey = join(root, "llm", `jev-${s.date}-${s.decisionMode ?? "buy"}-${requestHash}.json`);
    let reply: JevReply | null = null;
    let call: DecisionTrace["call"] = "remote";
    try {
      const cached = await Bun.file(cacheKey).json().catch(() => null);
      if (cached?.answers && typeof cached.answers === "object") {
        reply = cached as JevReply;
        call = "cache";
      } else {
        reply = await this.ask({ state, questions, timeoutMs: config.jevTimeoutMs });
        await mkdir(join(root, "llm"), { recursive: true });
        await Bun.write(cacheKey, JSON.stringify({ date: s.date, mode: s.decisionMode ?? "buy", answers: reply.answers, inputTokens: reply.inputTokens }));
      }
    } catch (e) {
      const trace: DecisionTrace = {
        source: "jev",
        model: this.name,
        call: "remote",
        status: "failed",
        requestKey: requestHash,
        reason: (e as Error).message.slice(0, 160),
      };
      console.error(`[jev] 调用失败，本轮 fail-closed HOLD，不降级 FactorModel: ${trace.reason}`);
      return holdDecision(t0, trace);
    }

    const probs = new Map<string, number>();
    if (isSell) {
      positions.forEach((p, i) => {
        const a = reply!.answers[`q${i}`];
        const probability = typeof a?.probability === "number" ? a.probability : Number.NaN;
        if (Number.isFinite(probability)) probs.set(p.code, Math.max(0, Math.min(1, probability)));
      });
    } else {
      list.forEach((c, i) => {
        const a = reply!.answers[`q${i}`];
        const probability = typeof a?.probability === "number" ? a.probability : Number.NaN;
        if (Number.isFinite(probability)) probs.set(c.features.code, Math.max(0, Math.min(1, probability)));
      });
    }

    const trace: DecisionTrace = {
      source: "jev",
      model: this.name,
      call,
      status: probs.size ? "ok" : "invalid-response",
      requestKey: requestHash,
      answerCount: probs.size,
      inputTokens: reply?.inputTokens ?? 0,
      reason: call === "cache" ? "使用此前成功的 Jev 回复缓存" : "本轮已完成远端 Jev 调用",
    };
    if (!probs.size) {
      console.error("[jev] 返回没有可用概率，本轮 fail-closed HOLD，不降级 FactorModel");
      return holdDecision(t0, trace, reply?.inputTokens ?? 0);
    }

    if (isSell) {
      const ranked = positions
        .filter((p) => (probs.get(p.code) ?? 0) >= config.jevMinProb)
        .sort((a, b) => (probs.get(b.code) ?? 0) - (probs.get(a.code) ?? 0) || a.code.localeCompare(b.code));
      const picks: Pick[] = ranked.map((p) => {
        const i = positions.findIndex((x) => x.code === p.code);
        const a = reply!.answers[`q${i}px`];
        return {
          code: p.code,
          name: p.name,
          probability: probs.get(p.code) ?? 0,
          score: 0,
          priceOffsetPct: typeof a?.score === "number" ? pxOffsetPctOf(a.score) : 0,
          reasons: [`Jev 卖出判定 ${(100 * (probs.get(p.code) ?? 0)).toFixed(0)}%`],
        };
      });
      const best = Math.max(...probs.values());
      return {
        action: picks.length ? "sell" : "hold",
        probabilities: { buy: 0, sell: picks.length ? best : 0, hold: picks.length ? 1 - best : 1 },
        probabilitySemantics: "model-prompt",
        picks,
        latencyMs: performance.now() - t0,
        late: false,
        inputTokens: reply!.inputTokens,
        modelFailed: false,
        trace,
      };
    }

    const picks: Pick[] = list
      .filter((c) => (probs.get(c.features.code) ?? 0) >= config.jevMinProb)
      .sort((a, b) => (probs.get(b.features.code) ?? 0) - (probs.get(a.features.code) ?? 0) || a.features.code.localeCompare(b.features.code))
      .slice(0, Math.min(s.openSlots, config.k))
      .map((c) => ({
        code: c.features.code,
        name: c.features.name,
        probability: probs.get(c.features.code) ?? 0,
        score: c.score,
        reasons: [...c.reasons, `Jev 买入判定 ${(100 * (probs.get(c.features.code) ?? 0)).toFixed(0)}%`],
      }));
    const best = Math.max(...probs.values());
    return {
      action: picks.length ? "buy" : "hold",
      probabilities: { buy: picks.length ? best : 0, sell: 0, hold: picks.length ? 1 - best : 1 },
      probabilitySemantics: "model-prompt",
      picks,
      latencyMs: performance.now() - t0,
      late: false,
      inputTokens: reply!.inputTokens,
      modelFailed: false,
      trace,
    };
  }
}
