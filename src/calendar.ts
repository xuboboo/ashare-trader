/**
 * 交易日历：从上证指数日线里读“哪些日期真的有交易”，不内置节假日表。
 * 日线走 quotes 的多源回退（东财→腾讯→新浪），单一源被限流也不会把日历打掉。
 * 拿不到时退化为周一~周五，并置 stale 让仪表盘显示横幅。
 */
import { fetchIndexDaily } from "./quotes";
import { bj } from "./session";

/** 周一~周五。 */
export function isWeekday(ymd: string): boolean {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * "今天晚于最后一个已知交易日"时的投射规则：周一~五视为交易日。
 * 节假日会被误报为交易日 —— 无节假日表前提下这是最小的错误方向
 * （错过交易日比在节假日空转更糟）。
 */
export function projectWeekdayTradingDay(ymd: string, lastKnown: string): boolean {
  if (ymd <= lastKnown) return false;
  return isWeekday(ymd);
}

export class TradingCalendar {
  private dates = new Set<string>();
  /** 升序日期数组，用于取“上一交易日” */
  private ordered: string[] = [];
  stale = true;
  updatedAt = 0;

  async refresh(): Promise<void> {
    try {
      const bars = await fetchIndexDaily(250);
      const dates = bars.map((b) => b.date).filter(Boolean);
      if (dates.length < 30) throw new Error(`日线太短: ${dates.length}`);
      this.dates = new Set(dates);
      this.ordered = [...dates].sort();
      this.stale = false;
      this.updatedAt = Date.now();
    } catch (e) {
      this.stale = true;
      console.error(`[calendar] 拉取失败，退化为周一~周五: ${(e as Error).message}`);
    }
  }

  /** 是否交易日。stale 时按工作日猜；日历健康但日期晚于最后已知日线（比如"今天"，
   *  日线要交易后才生成）时，按周一~五投射 —— 否则每个交易日都会被当成节假日。 */
  isTradingDay(ymd: string = bj().ymd): boolean {
    if (this.stale) return isWeekday(ymd);
    if (this.dates.has(ymd)) return true;
    const last = this.ordered[this.ordered.length - 1];
    if (last && ymd > last) return projectWeekdayTradingDay(ymd, last);
    return false; // 已知历史区间里的日期不在集合 = 真非交易日（节假日/周末）
  }

  /** ymd 之前的最后一个交易日（不含 ymd）。 */
  prevTradingDay(ymd: string): string | undefined {
    const list = this.stale ? [] : this.ordered;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]! < ymd) return list[i];
    // 退化：往前找最多 10 天
    for (let k = 1; k <= 10; k++) {
      const d = new Date(`${ymd}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - k);
      const cand = d.toISOString().slice(0, 10);
      if (this.isTradingDay(cand) && cand < ymd) return cand;
    }
    return undefined;
  }

  nextTradingDay(ymd: string): string | undefined {
    for (const d of this.ordered) if (d > ymd) return d;
    return undefined;
  }

  /** 日历里最近一个有数据的交易日（可能就是今天）。 */
  latest(ymd: string = bj().ymd): string {
    for (let i = this.ordered.length - 1; i >= 0; i--) if (this.ordered[i]! <= ymd) return this.ordered[i]!;
    return ymd;
  }

  get size() {
    return this.dates.size;
  }
}
