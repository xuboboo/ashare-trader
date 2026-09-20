import { describe, expect, test } from "bun:test";
import { buyCosts, commission, minCommissionWarn, roundTrip, sellCosts, slipFillPrice } from "../src/costs";

describe("A 股成本模型", () => {
  test("佣金按万2.5计提，但不低于 5 元", () => {
    expect(commission(200_000)).toBe(50); // 正好等于最低佣金临界点
    expect(commission(50_000)).toBe(12.5);
    expect(commission(10_000)).toBe(5); // 2.5 元被抬到 5 元
    expect(commission(1_000)).toBe(5);
  });

  test("印花税只在卖出单边", () => {
    expect(buyCosts(100_000).stampTax).toBe(0);
    expect(sellCosts(100_000).stampTax).toBe(50);
  });

  test("过户费与经手费双边都收", () => {
    expect(buyCosts(100_000).transferFee).toBe(1);
    expect(buyCosts(100_000).exchangeFee).toBe(6.8);
    expect(sellCosts(100_000).transferFee).toBe(1);
  });

  test("成本占比：5 万元已是 11.6bp，5 千元因最低佣金飙到 26bp", () => {
    const mid = roundTrip(50_000);
    expect(mid.total).toBeCloseTo(57.8, 1);
    expect(mid.bps).toBeCloseTo(11.6, 1);
    const tiny = roundTrip(5_000);
    expect(tiny.bps).toBeGreaterThan(mid.bps * 2); // 5 元最低佣金直接翻倍
    const big = roundTrip(200_000);
    expect(big.bps).toBeCloseTo(11.6, 1); // 过了最低佣金区后与金额无关
  });

  test("最低佣金侵蚀被明确警告，大额单不警告", () => {
    expect(minCommissionWarn(5_000)).toStartWith("单笔");
    expect(minCommissionWarn(20_000)).toBeNull();
    expect(minCommissionWarn(200_000)).toBeNull();
    expect(minCommissionWarn(0)).toBeNull();
  });

  test("滑点：买更贵、卖更便宜，按 0.01 一档", () => {
    expect(slipFillPrice(10, "buy")).toBe(10.01);
    expect(slipFillPrice(10, "sell")).toBe(9.99);
    expect(slipFillPrice(10, "buy", 3)).toBe(10.03);
  });
});
