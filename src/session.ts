/**
 * 交易日历 + 时段状态机。
 *
 * 交易日不靠猜节假日表：直接看上证指数有没有日线（有成交的日期即交易日），
 * 由 calendar 模块从东财 kline 拉最近 250 根缓存下来。拿不到时退化成"只看周一到周五"
 * 并在事件里打 calendarStale，让人看见而不是静默错。
 */
import { config } from "./config";

export type Phase =
  | "closed" // 非交易日
  | "pre-open" // 交易日 00:00-09:15
  | "call-auction" // 09:15-09:25 集合竞价（可申报可撤单）
  | "no-cancel" // 09:25-09:30 不可撤单
  | "continuous" // 09:30-11:30、13:00-14:57 连续竞价
  | "lunch" // 11:30-13:00
  | "close-auction" // 14:57-15:00 收盘集合竞价
  | "after-hours"; // 15:00 之后

const bjFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 北京时间拆解。en-CA 给 YYYY-MM-DD，且 hourCycle h23 下 24 只在午夜出现。 */
export function bj(d: Date = new Date()) {
  const p: Record<string, string> = {};
  for (const part of bjFmt.formatToParts(d)) p[part.type] = part.value;
  const ymd = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const second = Number(p.second);
  return { ymd, compact: ymd.replace(/-/g, ""), hour, minute, second, minutes: hour * 60 + minute };
}

export interface Session {
  phase: Phase;
  ymd: string;
  minutes: number;
  /** 距下一次决策触发的可读说明 */
  next: string;
}

const S = config.session;

export function phaseOf(ymd: string, minutes: number, tradingDay: boolean): Phase {
  if (!tradingDay) return "closed";
  if (minutes < S.callAuctionStart) return "pre-open";
  if (minutes < S.callAuctionEnd) return "call-auction";
  if (minutes < S.noCancelEnd) return "no-cancel";
  if (minutes <= S.morningEnd) return "continuous";
  if (minutes < S.afternoonStart) return "lunch";
  if (minutes <= S.afternoonEnd) return "continuous";
  if (minutes < S.closeAuctionEnd) return "close-auction";
  return "after-hours";
}

/** 连续竞价或集合竞价：允许产出/撮合建议单的时段。 */
export const canTrade = (p: Phase) =>
  p === "continuous" || p === "call-auction" || p === "close-auction";

/** 只有连续竞价才做止损/退出判定（竞价期间价格不可靠）。 */
export const liveQuotes = (p: Phase) => p === "continuous";

export function sessionNow(d: Date = new Date(), tradingDay = true): Session {
  const { ymd, minutes } = bj(d);
  const phase = phaseOf(ymd, minutes, tradingDay);
  let next = "-";
  if (phase === "after-hours") next = "次日 09:05 盘前扫描";
  else if (minutes < S.tailStart) next = `${pad(S.tailStart)} 尾盘选股`;
  else if (minutes < S.afternoonEnd) next = `${pad(S.afternoonEnd)} 收盘前最后窗口`;
  return { phase, ymd, minutes, next };
}

const pad = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const hhmmOf = pad;
