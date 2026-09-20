/**
 * 决策模型。保持 jev-trader 的 Model/Decision 形状：出概率、出 action、记延迟、迟到就 hold。
 *
 * 与 jev 的关键差别：LLM 不进热路径。这里 LlmAdvisory 只在每天盘前调用一次（情绪闸门 + 个股 veto），
 * tick 级的选择全部由 FactorModel 的确定性打分完成。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import type { Gate, Scored } from "./factors";

export type Action = "buy" | "sell" | "hold";

export interface Pick {
  code: string;
  name: string;
  probability: number;
  score: number;
  reasons: string[];
}

export interface SignalState {
  date: string;
  time: string;
  /** 决策口径说明，等价于 jev 的 horizonBlocks */
  horizon: string;
  gate: Gate;
  candidates: Scored[];
  heldCodes: string[];
  allowed: { buy: boolean; sell: boolean };
  /** 每股 veto 理由（来自 LLM 或本地规则） */
  vetoes: Record<string, string>;
  openSlots: number;
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  picks: Pick[];
  latencyMs: number;
  /** 模型没赶上有用（等价 jev 的 late），保留给未来的盘中模型 */
  late: boolean;
  inputTokens: number;
  modelFailed: boolean;
}

export interface Model {
  readonly name: string;
  decide(state: SignalState): Promise<Decision>;
}

/** 确定性规则打分：毫秒级，可回测，默认模型。 */
export class FactorModel implements Model {
  readonly name = "factor";

  async decide(state: SignalState): Promise<Decision> {
    const t0 = performance.now();
    const probabilities: Record<Action, number> = { buy: 0, sell: 0, hold: 1 };
    const picks: Pick[] = [];

    if (state.allowed.buy && state.gate.allowed && state.openSlots > 0) {
      const ok = state.candidates
        .filter((c) => c.rejects.length === 0 && c.score > 0 && !(c.features.code in state.vetoes))
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
      picks,
      latencyMs: performance.now() - t0,
      late: false,
      inputTokens: 0,
      modelFailed: false,
    };
  }
}

export const createModel = (): Model => new FactorModel();

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
