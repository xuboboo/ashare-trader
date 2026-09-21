import { describe, expect, test } from "bun:test";
import { isWeekday, projectWeekdayTradingDay, TradingCalendar } from "../src/calendar";

/** 真实场景：2026-09-18（周五）是最后一个已知交易日，09-21（周一）开盘前日线还不存在。 */
const LAST = "2026-09-18";

describe("交易日历：未生成日线时的投射", () => {
  test("周一投射为交易日，周末不是", () => {
    expect(projectWeekdayTradingDay("2026-09-21", LAST)).toBe(true); // 周一
    expect(projectWeekdayTradingDay("2026-09-22", LAST)).toBe(true); // 周二
    expect(projectWeekdayTradingDay("2026-09-19", LAST)).toBe(false); // 周六
    expect(projectWeekdayTradingDay("2026-09-20", LAST)).toBe(false); // 周日
  });

  test("已知历史区间里的日期不走投射（节假日判断以真实集合为准）", () => {
    expect(projectWeekdayTradingDay("2026-09-18", LAST)).toBe(false);
    expect(projectWeekdayTradingDay("2026-09-17", LAST)).toBe(false);
  });

  test("isWeekday 边界", () => {
    expect(isWeekday("2026-09-21")).toBe(true);
    expect(isWeekday("2026-09-20")).toBe(false);
  });

  test("TradingCalendar：健康日历对今天投射、对历史节假日说否", () => {
    const cal = new TradingCalendar();
    // 注入已知历史（09-19/09-20 是周末，09-15 假设为节假日）
    (cal as unknown as { stale: boolean }).stale = false;
    (cal as unknown as { dates: Set<string> }).dates = new Set([
      "2026-09-14", "2026-09-16", "2026-09-17", "2026-09-18",
    ]);
    (cal as unknown as { ordered: string[] }).ordered = [
      "2026-09-14", "2026-09-16", "2026-09-17", "2026-09-18",
    ];
    expect(cal.isTradingDay("2026-09-21")).toBe(true); // 今天：投射为交易日
    expect(cal.isTradingDay("2026-09-19")).toBe(false); // 历史：周末不在集合 = 真非交易日
    expect(cal.isTradingDay("2026-09-15")).toBe(false); // 历史：不在集合 = 真非交易日（节假日）
    expect(cal.isTradingDay("2026-09-18")).toBe(true); // 历史交易日
  });

  test("stale 日历按周一~五猜", () => {
    const cal = new TradingCalendar();
    expect(cal.stale).toBe(true);
    expect(cal.isTradingDay("2026-09-21")).toBe(true);
    expect(cal.isTradingDay("2026-09-20")).toBe(false);
  });
});
