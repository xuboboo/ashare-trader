import { describe, expect, test } from "bun:test";
import { bj, canTrade, liveQuotes, phaseOf, tradingElapsedMin, tradingMinutesTotal } from "../src/session";
import { exchange, inScope, isSt, limitDown, limitUp, sharesForBudget, tencentSymbol } from "../src/symbols";

const M = (h: number, m: number) => h * 60 + m;

describe("交易时段", () => {
  test("边界一分钟都不许错", () => {
    expect(phaseOf("2026-09-18", M(9, 14), true)).toBe("pre-open");
    expect(phaseOf("2026-09-18", M(9, 15), true)).toBe("call-auction");
    expect(phaseOf("2026-09-18", M(9, 24), true)).toBe("call-auction");
    expect(phaseOf("2026-09-18", M(9, 25), true)).toBe("no-cancel");
    expect(phaseOf("2026-09-18", M(9, 29), true)).toBe("no-cancel");
    expect(phaseOf("2026-09-18", M(9, 30), true)).toBe("continuous");
    expect(phaseOf("2026-09-18", M(11, 30), true)).toBe("lunch");
    expect(phaseOf("2026-09-18", M(11, 31), true)).toBe("lunch");
    expect(phaseOf("2026-09-18", M(12, 59), true)).toBe("lunch");
    expect(phaseOf("2026-09-18", M(13, 0), true)).toBe("continuous");
    expect(phaseOf("2026-09-18", M(14, 57), true)).toBe("close-auction");
    expect(phaseOf("2026-09-18", M(14, 58), true)).toBe("close-auction");
    expect(phaseOf("2026-09-18", M(15, 0), true)).toBe("after-hours");
    expect(phaseOf("2026-09-18", M(3, 0), true)).toBe("pre-open");
  });

  test("非交易日整天都是 closed", () => {
    expect(phaseOf("2026-09-20", M(10, 0), false)).toBe("closed");
  });

  test("集合竞价可出单，但只有连续竞价算活价", () => {
    expect(canTrade("call-auction")).toBe(true);
    expect(canTrade("continuous")).toBe(true);
    expect(canTrade("lunch")).toBe(false);
    expect(canTrade("closed")).toBe(false);
    expect(liveQuotes("call-auction")).toBe(false);
    expect(liveQuotes("continuous")).toBe(true);
  });

  test("北京时间换算不受本机时区影响", () => {
    // 01:30Z 即北京 09:30
    const a = bj(new Date("2026-09-18T01:30:00Z"));
    expect(a.ymd).toBe("2026-09-18");
    expect(a.minutes).toBe(M(9, 30));
    // 16:30Z 已是北京次日 00:30
    const b = bj(new Date("2026-09-17T16:30:00Z"));
    expect(b.ymd).toBe("2026-09-18");
    expect(b.minutes).toBe(M(0, 30));
  });

  /**
   * 成交节奏折算用的分母：当日累计成交额是跨过午休继续增长的，所以已交易时长也不能清零。
   * 旧实现下午从 13:00 重算，导致 13:00 那一分钟反而要求全天阈值，而整个午后阈值只有应达值一半。
   */
  test("累计交易分钟：上午连续、午休定格、下午接着长、收盘封顶", () => {
    expect(tradingElapsedMin(M(9, 14))).toBeNull(); // 盘前：没有当日累计可言，用全天阈值
    expect(tradingElapsedMin(M(9, 30))).toBe(0);
    expect(tradingElapsedMin(M(10, 0))).toBe(30);
    expect(tradingElapsedMin(M(11, 30))).toBe(120);
    expect(tradingElapsedMin(M(12, 0))).toBe(120); // 午休：上午全长，不掉回 0
    expect(tradingElapsedMin(M(13, 0))).toBe(120); // 13:00 与 11:30 同一个值：没有突刺
    expect(tradingElapsedMin(M(13, 1))).toBe(121);
    expect(tradingElapsedMin(M(14, 40))).toBe(220);
    expect(tradingElapsedMin(M(14, 57))).toBe(tradingMinutesTotal()); // 全天封顶
    expect(tradingElapsedMin(M(15, 30))).toBe(tradingMinutesTotal());
  });

  test("累计分钟单调不降（闸门阈值不可能中途突然变严）", () => {
    let prev = -1;
    for (let m = M(9, 30); m <= M(15, 0); m++) {
      const e = tradingElapsedMin(m)!;
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });
});

describe("A 股交易规则", () => {
  test("涨跌停价按四舍五入到分，与交易所一致", () => {
    // 实测浦发银行 9.06 昨收 -> 涨停 9.97、跌停 8.15
    expect(limitUp(9.06, "600000", "浦发银行")).toBe(9.97);
    expect(limitDown(9.06, "600000", "浦发银行")).toBe(8.15);
    expect(limitUp(11.61, "000001", "平安银行")).toBe(12.77);
    expect(limitDown(11.61, "000001", "平安银行")).toBe(10.45);
  });

  test("创业板 20%、ST 5%、主板 10%", () => {
    expect(limitUp(10, "300223", "君正股份")).toBe(12);
    expect(limitUp(10, "600000", "ST 某某")).toBe(10.5);
    expect(limitUp(10, "600000", "某某")).toBe(11);
  });

  test("范围外板块直接排除", () => {
    expect(inScope("600000")).toBe(true);
    expect(inScope("300223")).toBe(true);
    expect(inScope("688001")).toBe(false); // 科创板
    expect(inScope("830799")).toBe(false); // 北交所
    expect(isSt("ST康美")).toBe(true);
  });

  test("代码前缀与 secid", () => {
    expect(exchange("600000")).toBe("sh");
    expect(exchange("000001")).toBe("sz");
    expect(exchange("830799")).toBe("bj");
    expect(tencentSymbol("600000")).toBe("sh600000");
  });

  test("一手起买：预算买不起 100 股就不出单", () => {
    expect(sharesForBudget(61.38, 50_000)).toBe(800);
    expect(sharesForBudget(388.18, 50_000)).toBe(100);
    expect(sharesForBudget(600, 50_000)).toBe(0); // 中际旭创这类高价股，5 万开不了一手
    expect(sharesForBudget(0, 50_000)).toBe(0);
    expect(sharesForBudget(10, 0)).toBe(0);
  });
});
