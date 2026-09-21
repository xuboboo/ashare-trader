import { describe, expect, test } from "bun:test";
import { marketGate } from "../src/factors";
import { lotAwareHalfQty } from "../src/symbols";

const alive = { price: 3926, amountYi: 900 };
const above = 3900;

describe("大盘闸门：盘中成交额按节奏折算", () => {
  test("早盘 5 分钟成交 900 亿远低于全天阈值，但按节奏折算后通过", () => {
    const r = marketGate(alive, above, 28, 5);
    expect(r.allowed).toBe(true);
    expect(r.reasons[0]).toContain("闸门通过");
  });

  test("同额收盘口径（不传开盘分钟数）维持原行为：低于 3000 亿即关", () => {
    const r = marketGate(alive, above, 28);
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toContain("成交额");
  });

  test("开盘 60 分钟阈值折算到 750 亿；节奏过慢照样关", () => {
    expect(marketGate({ price: 3926, amountYi: 800 }, above, 28, 60).allowed).toBe(true);
    expect(marketGate({ price: 3926, amountYi: 500 }, above, 28, 60).allowed).toBe(false);
  });

  test("下午 13:00 起重新计节奏；超过 240 分钟封顶为全天阈值", () => {
    expect(marketGate({ price: 3926, amountYi: 1200 }, above, 28, 30).allowed).toBe(true);
    expect(marketGate({ price: 3926, amountYi: 2500 }, above, 28, 300).allowed).toBe(false); // 300 分钟已封顶 3000 亿
  });

  test("其他否决项不受折算影响：跌破 5 日线 / 涨停冰点照关", () => {
    expect(marketGate({ price: 3800, amountYi: 900 }, 3885, 28, 5).allowed).toBe(false);
    expect(marketGate(alive, above, 10, 5).allowed).toBe(false);
  });
});

describe("整手约束的卖一半（lotAwareHalfQty）", () => {
  test("向下取整到手；300 卖 100；100 无法分批返回 0", () => {
    expect(lotAwareHalfQty(200)).toBe(100);
    expect(lotAwareHalfQty(400)).toBe(200);
    expect(lotAwareHalfQty(300)).toBe(100);
    expect(lotAwareHalfQty(100)).toBe(0);
  });
});
