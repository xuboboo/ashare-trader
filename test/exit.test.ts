import { describe, expect, test } from "bun:test";
import { stopLevel } from "../src/exit";

const entry = 22.44;

describe("止损价 stopLevel（回测与实盘同一口径）", () => {
  test("fixed：买入价 × (1 − 3%)", () => {
    expect(stopLevel(entry, { mode: "fixed" })).toBe(21.77);
    expect(stopLevel(entry, {})).toBe(21.77); // 缺省 mode = fixed
  });

  test("atr 模式：entry − k×ATR", () => {
    expect(stopLevel(entry, { mode: "atr", atr: 0.3, k: 2.5 })).toBe(21.69); // 22.44 − 0.75
  });

  test("atr 模式封底 10%：高波动票的止损距离被钳住", () => {
    // 2.5×1.0 = 2.5 元 > 22.44×10% = 2.244 → 触发封底
    expect(stopLevel(entry, { mode: "atr", atr: 1.0, k: 2.5 })).toBe(20.2);
  });

  test("ATR 缺失/为 0 → 回退 fixed（绝不因缺数据不设防）", () => {
    expect(stopLevel(entry, { mode: "atr", atr: null, k: 2.5 })).toBe(21.77);
    expect(stopLevel(entry, { mode: "atr", atr: 0, k: 2.5 })).toBe(21.77);
    expect(stopLevel(entry, { mode: "atr", k: 2.5 })).toBe(21.77);
  });

  test("fixedPct 可自定义（ATR 回退时用它）", () => {
    expect(stopLevel(entry, { mode: "fixed", fixedPct: 5 })).toBe(21.32);
  });
});
