import { describe, expect, test } from "bun:test";
import { riskBrake } from "../src/risk";

const base = {
  equity: 10000,
  dayStartEquity: 10000,
  peakEquity: 10000,
  dayLossLimitPct: 3,
  drawdownLimitPct: 10,
};

describe("组合级风控闸（日亏损/回撤）", () => {
  test("正常状态不封仓", () => {
    const r = riskBrake(base);
    expect(r.buyBlocked).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  test("当日亏损触及上限停止开仓；是按日初权益算的绝对额", () => {
    const r = riskBrake({ ...base, equity: 9700 }); // -3.0%
    expect(r.buyBlocked).toBe(true);
    expect(r.reasons[0]).toContain("当日亏损");
    expect(r.dayLossLimitCny).toBeCloseTo(300, 6);
    expect(riskBrake({ ...base, equity: 9701 }).buyBlocked).toBe(false); // 差一点不封
  });

  test("回撤闸：从峰值回撤超限停止开仓", () => {
    const r = riskBrake({ ...base, peakEquity: 11000, equity: 9800 }); // 回撤 10.9%
    expect(r.buyBlocked).toBe(true);
    expect(r.reasons[0]).toContain("回撤");
    expect(riskBrake({ ...base, peakEquity: 11000, equity: 10000 }).buyBlocked).toBe(false); // 9.1% 未触限
  });

  test("两条同时触发，理由都列出", () => {
    const r = riskBrake({ ...base, equity: 9500, peakEquity: 11000 });
    expect(r.reasons).toHaveLength(2);
    expect(r.buyBlocked).toBe(true);
  });

  test("限制设 0 = 关闭该闸", () => {
    expect(riskBrake({ ...base, equity: 9000, dayLossLimitPct: 0, drawdownLimitPct: 0 }).buyBlocked).toBe(false);
  });

  test("亏损永远不封退出 —— buyBlocked 只管开仓，函数没有任何 sell 概念", () => {
    const r = riskBrake({ ...base, equity: 9000 });
    expect(r.buyBlocked).toBe(true);
    expect(r).not.toHaveProperty("sellBlocked");
  });
});
