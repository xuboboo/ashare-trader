import { describe, expect, test } from "bun:test";
import { sharesYiFrom } from "../src/shares";

/** 总股本回推的纯函数：总股本(亿股) = 总市值(亿元) / 现价(元)。 */
describe("总股本回推（日线市值门槛的数据来源）", () => {
  test("正常输入：100 亿市值 / 10 元 = 10 亿股", () => {
    expect(sharesYiFrom(100, 10)).toBe(10);
  });

  test("市值或价格缺失/非正 → undefined（宁可让门槛显式不生效，也不猜一个股本）", () => {
    expect(sharesYiFrom(0, 10)).toBeUndefined();
    expect(sharesYiFrom(100, 0)).toBeUndefined();
    expect(sharesYiFrom(-1, 10)).toBeUndefined();
    expect(sharesYiFrom(Number.NaN, 10)).toBeUndefined();
  });

  test("与回测里的回推口径一致：shares × 收盘价 = 当日总市值", () => {
    const shares = sharesYiFrom(52.5, 10.5)!;
    expect(shares * 10.5).toBeCloseTo(52.5, 6);
  });
});
