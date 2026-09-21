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

/** 全天连续竞价总时长（分钟）：上午 + 下午。成交节奏折算的分母。 */
export const tradingMinutesTotal = () =>
  S.morningEnd - S.morningStart + (S.afternoonEnd - S.afternoonStart);

/**
 * 某一刻累计交易了多少分钟 —— 用于把"当日累计成交额"折算成节奏阈值。
 *
 * 关键点：跨过午休**不清零**。成交额是全天累计值，下午 13:01 已经交易了 121 分钟
 * （上午 120 + 下午 1），旧实现从 13:00 重新起算，导致午后阈值只有真实应达值的约一半，
 * 而 13:00 整点那一分钟又反过来要求全天阈值。
 *   盘前（含集合竞价）→ null：累计成交额还没有当日增量，按全天阈值处理（保守）；
 *   午休 → 定格为上午全长；收盘后 → 封顶为全天时长。
 */
export function tradingElapsedMin(minutes: number): number | null {
  const morning = S.morningEnd - S.morningStart;
  if (minutes < S.morningStart) return null;
  if (minutes <= S.morningEnd) return minutes - S.morningStart;
  if (minutes < S.afternoonStart) return morning;
  if (minutes <= S.afternoonEnd) return morning + (minutes - S.afternoonStart);
  return tradingMinutesTotal();
}

export function sessionNow(d: Date = new Date(), tradingDay = true): Session {
  const { ymd, minutes } = bj(d);
  const phase = phaseOf(ymd, minutes, tradingDay);
  let next = "-";
  if (phase === "after-hours") next = "次日 09:25 竞价定型后盘前预选";
  else if (phase === "pre-open") next = "09:25 竞价定型后盘前预选";
  else if (minutes < S.tailStart) next = "全程决策中（盘中+尾盘同规则）";
  else if (minutes < S.afternoonEnd) next = `${pad(S.afternoonEnd)} 收盘前最后窗口`;
  return { phase, ymd, minutes, next };
}

const pad = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const hhmmOf = pad;
