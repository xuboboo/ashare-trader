/**
 * Jev 自主持仓标签：把 T+1 之后的分钟路径按时间顺序喂给 Jev。
 *
 * 这不是固定持有期回测：
 * - 每个可见分钟先执行硬止损；
 * - 未触发硬边界时才询问 Jev 是否卖出；
 * - Jev 失败不回退 Factor，也不拿收盘价/10:00 伪造退出；
 * - 观测窗口结束仍未退出 = right-censored，交给上层决定是否排除。
 */
import type { Decision, DecisionTrace, HeldPositionInput, Model, SignalState } from "./model";
import type { Gate } from "./factors";
import { buildResearchSnapshot } from "./research-engine";
import type { ResearchMinuteBar, ResearchUniverseEntry } from "./research";
import { round2 } from "./symbols";

export type ResearchExitStatus = "sold-by-jev" | "hard-stop" | "right-censored" | "jev-failed" | "no-observation";

export interface ResearchMinuteDay {
  date: string;
  bars: ResearchMinuteBar[];
  /** 该交易日按前一交易日 raw close 计算的跌停价。 */
  limitDown?: number;
}

export interface ResearchJevExitInput {
  entryDate: string;
  entryTime: "14:45";
  entry: number;
  qty: number;
  stop: number;
  limitDown?: number;
  code: string;
  entryInfo: ResearchUniverseEntry;
  future: ResearchMinuteDay[];
  model: Model;
  decisionIntervalMinutes?: 1;
}

export interface ResearchJevExitResult {
  status: ResearchExitStatus;
  exitDate?: string;
  exitTime?: string;
  exitPrice?: number;
  exitQty?: number;
  exitNote?: string;
  exitTrace?: DecisionTrace;
  decisionRounds: number;
  remoteCalls: number;
  cacheHits: number;
  jevFailures: number;
  lastObservation?: { date: string; time: string };
}

function emptyResult(status: ResearchExitStatus, counters: Pick<ResearchJevExitResult, "decisionRounds" | "remoteCalls" | "cacheHits" | "jevFailures">): ResearchJevExitResult {
  return { status, ...counters };
}

function heldDays(entryDate: string, date: string): number {
  const start = Date.parse(`${entryDate}T12:00:00+08:00`);
  const now = Date.parse(`${date}T12:00:00+08:00`);
  return Math.max(1, Math.round((now - start) / 86_400_000));
}

function gate(): Gate {
  return { allowed: true, status: "open", reasons: ["研究标签只在已通过入口硬筛选的持仓上评估"], skipped: [] };
}

function sellState(args: {
  input: ResearchJevExitInput;
  day: ResearchMinuteDay;
  bar: ResearchMinuteBar;
}): SignalState {
  const snapshot = buildResearchSnapshot({
    date: args.day.date,
    code: args.input.code,
    entry: args.input.entryInfo,
    bars: args.day.bars,
    asOf: args.bar.time,
  });
  const bid = snapshot.bids[0]?.p ?? 0;
  const position: HeldPositionInput = {
    code: args.input.code,
    name: args.input.entryInfo.name,
    entry: args.input.entry,
    price: bid > 0 ? bid : snapshot.price,
    unrealizedPct: args.input.entry > 0 ? (((bid > 0 ? bid : snapshot.price) - args.input.entry) / args.input.entry) * 100 : 0,
    stop: args.input.stop,
    heldDays: heldDays(args.input.entryDate, args.day.date),
    sellable: args.input.qty,
  };
  return {
    date: args.day.date,
    time: args.bar.time,
    horizon: "研究标签：Jev 自主决定持仓退出；T+1、止损、涨跌停与可成交盘口是硬边界",
    gate: gate(),
    index: null,
    candidates: [],
    heldCodes: [args.input.code],
    allowed: { buy: false, sell: true },
    vetoes: {},
    openSlots: 0,
    decisionMode: "sell",
    positions: [position],
  };
}

function hardStop(input: ResearchJevExitInput, bar: ResearchMinuteBar): boolean {
  return bar.open <= input.stop || bar.low <= input.stop;
}

function lockedDown(input: ResearchJevExitInput, day: ResearchMinuteDay, bar: ResearchMinuteBar): boolean {
  const limit = day.limitDown ?? input.limitDown ?? 0;
  return bar.oneLineDown || (limit > 0 && bar.low === bar.high && bar.low <= limit);
}

function continuousMinute(time: string): boolean {
  return (time >= "09:30" && time <= "11:30") || (time >= "13:00" && time <= "14:57");
}

function countTrace(result: ResearchJevExitResult, decision: Decision): void {
  if (decision.trace?.call === "remote") result.remoteCalls++;
  if (decision.trace?.call === "cache") result.cacheHits++;
  if (decision.modelFailed || decision.trace?.source !== "jev" || decision.trace.status !== "ok") result.jevFailures++;
}

/** 按分钟重放一笔持仓；不会因为观测结束而生成虚假的卖出成交。 */
export async function simulateJevExit(input: ResearchJevExitInput): Promise<ResearchJevExitResult> {
  if (input.decisionIntervalMinutes !== undefined && input.decisionIntervalMinutes !== 1) {
    throw new Error("Jev 研究标签只允许 1 分钟决策间隔");
  }
  const result: ResearchJevExitResult = {
    status: "no-observation",
    decisionRounds: 0,
    remoteCalls: 0,
    cacheHits: 0,
    jevFailures: 0,
  };
  const future = input.future.flatMap((day) =>
    [...day.bars]
      .filter((bar) => bar.date === day.date && continuousMinute(bar.time))
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((bar) => ({ day, bar })),
  );
  if (!future.length) return emptyResult("no-observation", result);

  for (const { day, bar } of future) {
    result.lastObservation = { date: day.date, time: bar.time };
    if (bar.suspended) continue;

    // 与生产一致：止损是唯一价格硬保护，无法成交时不假装成交，继续观察后续盘口。
    if (hardStop(input, bar)) {
      if (lockedDown(input, day, bar) || !(bar.bid > 0)) continue;
      const price = round2(Math.min(bar.bid, input.stop));
      return {
        ...result,
        status: "hard-stop",
        exitDate: day.date,
        exitTime: bar.time,
        exitPrice: price,
        exitQty: input.qty,
        exitNote: bar.open <= input.stop ? "分钟开盘跌破止损，按当时 bid 成交" : "分钟最低价触发止损，按止损价与 bid 的保守值成交",
        exitTrace: { source: "hard-rule", model: input.model.name, call: "none", status: "skipped-hard-rule", reason: "研究路径硬止损先于 Jev" },
      };
    }

    // 没有可成交 bid 时既不问模型，也不拿 close 冒充卖出价。
    if (!(bar.bid > 0)) continue;
    const decision = await input.model.decide(sellState({ input, day, bar }));
    result.decisionRounds++;
    countTrace(result, decision);
    if (decision.modelFailed || decision.trace?.source !== "jev" || decision.trace.status !== "ok") {
      return { ...result, status: "jev-failed", exitNote: decision.trace?.reason ?? "Jev 研究决策失败" };
    }
    const pick = decision.picks.find((p) => p.code === input.code);
    if (decision.action === "sell" && pick) {
      return {
        ...result,
        status: "sold-by-jev",
        exitDate: day.date,
        exitTime: bar.time,
        exitPrice: round2(bar.bid),
        exitQty: input.qty,
        exitNote: `Jev 自主卖出（p=${(pick.probability * 100).toFixed(0)}%，研究按当时 bid 成交）`,
        exitTrace: decision.trace,
      };
    }
  }
  return { ...result, status: "right-censored", exitNote: "观测窗口结束时 Jev 未退出；不生成固定时间卖出标签" };
}
