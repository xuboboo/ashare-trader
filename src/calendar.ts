/**
 * 交易日历：从上证指数日线里读“哪些日期真的有交易”，不内置节假日表。
 * 日线走 quotes 的多源回退（东财→腾讯→新浪），单一源被限流也不会把日历打掉。
 * 拿不到时退化为周一~周五，并置 stale 让仪表盘显示横幅。
 */
import { fetchIndexDaily } from "./quotes";
import { bj } from "./session";

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

  /** 是否交易日。stale 时按工作日猜。 */
  isTradingDay(ymd: string = bj().ymd): boolean {
    if (!this.stale) return this.dates.has(ymd);
    const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5;
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
