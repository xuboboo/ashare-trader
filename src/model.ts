/** 决策模型的可审计来源；jev 的 trace 必须说明是远端调用还是缓存。 */
export interface DecisionTrace {
  source: "jev" | "factor" | "local" | "hard-rule";
  model: string;
  call: "remote" | "cache" | "none";
  status: "ok" | "skipped-hard-rule" | "not-configured" | "failed" | "invalid-response";
  requestKey?: string;
  answerCount?: number;
  inputTokens?: number;
  reason?: string;
}

/** Jev 做卖出判断时看到的持仓状态；硬规则字段只用于边界和风险事实。 */
export interface HeldPositionInput {
  code: string;
  name: string;
  entry: number;
  price: number;
  unrealizedPct: number;
  stop: number;
  heldDays: number;
  sellable: number;
}

/** 决策模型。买入和卖出都必须返回同一份结构，失败时只能 HOLD。 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import type { Gate, Scored } from "./factors";
import { cannotAffordLot } from "./symbols";

export type Action = "buy" | "sell" | "hold";

export interface Pick {
  code: string;
  name: string;
  probability: number;
  score: number;
  reasons: string[];
  /** Jev 卖出时的价格意图；0 = 对手价，正数 = 相对现价挂高。 */
  priceOffsetPct?: number | null;
}

export interface SignalState {
  date: string;
  time: string;
  /** 决策口径说明，例如"尾盘买入、次日 10:00 前清仓" */
  horizon: string;
  gate: Gate;
  /** 大盘上下文（给模型的 state 与闸门判断用同一份数据） */
  index: { price: number; pct: number; amountYi: number; ma5: number | null } | null;
  candidates: Scored[];
  heldCodes: string[];
  allowed: { buy: boolean; sell: boolean };
  /** 每股 veto 理由（来自 LLM 或本地规则） */
  vetoes: Record<string, string>;
  openSlots: number;
  /** 未设置时兼容旧测试，生产引擎会显式设置。 */
  decisionMode?: "buy" | "sell";
  positions?: HeldPositionInput[];
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  /**
   * probabilities 到底是什么：
   *  - "rank-share"：FactorModel 把打分离 softmax 归一，它是排序占比，不是概率；
   *    拿着它当"55% 胜率"看就是误导（面板上必须标清楚）；
   *  - "calibrated"：本地模型输出的 P(扣成本后为正)，带训练集的校准表；
   *  - "model-prompt"：Jev 返回的结构化判定概率，校准质量由外部模型保证（本项目无法验证）。
   */
  probabilitySemantics?: "rank-share" | "calibrated" | "model-prompt";
  picks: Pick[];
  latencyMs: number;
  /** 本轮模型没赶上/没出结果；规则层恒为 false，字段留给未来的盘中模型 */
  late: boolean;
  inputTokens: number;
  modelFailed: boolean;
  /** 证明本轮到底由谁决定、是否真的调用了远端。 */
  trace?: DecisionTrace;
}

export interface Model {
  readonly name: string;
  decide(state: SignalState): Promise<Decision>;
}

/** 确定性规则打分：毫秒级，可回测，也是 Jev 不可用时的降级目标。 */
export class FactorModel implements Model {
  readonly name = "factor";

  /**
   * budgetCny 可注入（测试用），默认取配置的单笔预算。
   * 买不起一手的候选不进 picks —— 推荐了也执行不了的建议是噪声。
   */
  constructor(private budgetCny: number = config.sizeCny) {}

  async decide(state: SignalState): Promise<Decision> {
    const t0 = performance.now();
    const probabilities: Record<Action, number> = { buy: 0, sell: 0, hold: 1 };
    const picks: Pick[] = [];

    if (state.allowed.buy && state.gate.allowed && state.openSlots > 0) {
      const ok = state.candidates
        .filter(
          (c) =>
            c.rejects.length === 0 &&
            c.score > 0 &&
            !cannotAffordLot(c.features.price, this.budgetCny) &&
            !(c.features.code in state.vetoes),
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(state.openSlots, config.k));
      const sum = ok.reduce((s, c) => s + Math.exp(c.score), 0) || 1;
      for (const c of ok) {
        picks.push({
          code: c.features.code,
          name: c.features.name,
          probability: Math.exp(c.score) / sum,
          score: c.score,
          reasons: [...c.reasons, ...(state.vetoes[c.features.code] ? [state.vetoes[c.features.code]!] : [])],
        });
      }
    }
    if (picks.length) {
      probabilities.buy = picks.reduce((s, p) => s + p.probability, 0);
      probabilities.hold = Math.max(0, 1 - probabilities.buy);
    } else if (state.allowed.buy && state.gate.allowed) {
      probabilities.hold = 1; // 有资格开仓但今天没有一只通过筛选，这本身就是信息
    }

    return {
      action: picks.length ? "buy" : "hold",
      probabilities,
      // 有 picks 时 buy 的 softmax 归一后恒为 1：这不是“100% 看涨”，而是“本轮回给了这几只”。
      // 语义必须随结论一起下发，由面板标出来。
      probabilitySemantics: "rank-share",
      picks,
      latencyMs: performance.now() - t0,
      late: false,
      inputTokens: 0,
      modelFailed: false,
      trace: { source: "factor", model: this.name, call: "none", status: "ok" },
    };
  }
}

/* ------------------------------------------------------------------ LLM 顾问 */

export interface DailyBias {
  /** 情绪温度 0-1 */
  emotionScore: number;
  allowOpen: boolean;
  reason: string;
  /** code -> 否决理由 */
  vetoes: Record<string, string>;
  llmFailed: boolean;
  enabled: boolean;
  latencyMs: number;
}

export interface BiasContext {
  date: string;
  index: { price: number; pct: number; amountYi: number };
  ztCount: number;
  maxLianBan: number;
  topCandidates: { code: string; name: string; reason: string }[];
  headlines: string[];
}

const NEUTRAL = (enabled: boolean, why: string, latencyMs = 0): DailyBias => ({
  emotionScore: 0.5,
  allowOpen: true,
  reason: why,
  vetoes: {},
  llmFailed: false,
  enabled,
  latencyMs,
});

/**
 * 日频 LLM 顾问：只回答两个问题——今天情绪能不能开仓、这几只有没有必须回避的事件。
 * 结果按日期缓存，重跑同一天必然一致；无 key / 超时 / 解析失败一律降级为不否决。
 */
export class LlmAdvisory {
  readonly enabled = Boolean(config.llmApiKey);

  private cachePath(date: string) {
    return join(config.dataDir, "llm", `${date}.json`);
  }

  async dailyBias(ctx: BiasContext): Promise<DailyBias> {
    if (!this.enabled) return NEUTRAL(false, "LLM 未配置，情绪闸门只用规则");
    try {
      const cached = await Bun.file(this.cachePath(ctx.date)).json();
      if (cached?.date === ctx.date) return { ...cached, enabled: true };
    } catch {
      /* 无缓存 */
    }
    const t0 = performance.now();
    try {
      const raw = await this.chat(JSON.stringify(ctx, null, 1));
      const parsed = extractJson(raw);
      const bias: DailyBias = {
        emotionScore: clamp01(Number(parsed.emotionScore ?? 0.5)),
        allowOpen: parsed.allowOpen !== false && clamp01(Number(parsed.emotionScore ?? 0.5)) >= 0.2,
        reason: String(parsed.reason ?? "").slice(0, 300),
        vetoes: sanitizeVetoes(parsed.vetoes),
        llmFailed: false,
        enabled: true,
        latencyMs: performance.now() - t0,
      };
      await mkdir(join(config.dataDir, "llm"), { recursive: true });
      await Bun.write(this.cachePath(ctx.date), JSON.stringify({ date: ctx.date, ...bias }, null, 1));
      return bias;
    } catch (e) {
      console.error(`[llm] 盘前判断失败，降级为不否决: ${(e as Error).message}`);
      const failed = NEUTRAL(true, "LLM 失败，降级", performance.now() - t0);
      return { ...failed, llmFailed: true };
    }
  }

  private async chat(user: string): Promise<string> {
    const controller = AbortSignal.timeout(config.llmTimeoutMs);
    const r = await fetch(`${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llmApiKey}` },
      signal: controller,
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是 A 股盘前风控助手。给你一个交易日的市场状态和候选股票，你只输出 JSON：" +
              '{"emotionScore":0到1,"allowOpen":bool,"reason":"一句话","vetoes":{"股票代码":"否决理由"}}。' +
              "veto 只用于确定的事件风险（立案调查、大额减持、商誉暴雷、临近解禁、退市风险），不要因为看不准就否决。",
          },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => "")}`.slice(0, 200));
    const j = (await r.json()) as any;
    return String(j?.choices?.[0]?.message?.content ?? "");
  }
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("没有 JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function sanitizeVetoes(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^\d{6}$/.test(k)) out[k] = String(val).slice(0, 120);
    }
  }
  return out;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5);
