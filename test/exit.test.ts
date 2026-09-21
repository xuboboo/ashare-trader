import { describe, expect, test } from "bun:test";
import { nextDayExit, stopCounterfactual, stopLevel, summarizeStopCounterfactuals } from "../src/exit";

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

/**
 * 出场阶梯：必须与引擎 exitOrders() 同一个顺序（开盘浮盈减半 → 止损 → 到点清仓）。
 * 这两边一旦不一致，回测评估的就不是实盘在跑的那套规则。
 */
const exitCase = (over: { open: number; high: number; low: number; close: number }, entry = 10, stop = 9.7, qty = 1000) =>
  nextDayExit({
    next: { open: over.open, high: over.high, low: over.low, close: over.close },
    prevClose: entry,
    entry,
    stop,
    qty,
    gapTrimPct: 3,
    limitPctFrac: 0.1,
  });

describe("出场阶梯 nextDayExit（与实盘同序）", () => {
  test("高开 +5% 且全天不碰止损 → 开盘卖一半、剩仓收盘清", () => {
    const r = exitCase({ open: 10.5, high: 10.8, low: 10.4, close: 10.6 });
    expect(r.legs).toHaveLength(2);
    expect(r.legs[0]!.qty).toBe(500);
    expect(r.legs[0]!.price).toBe(10.5);
    expect(r.legs[1]!.price).toBe(10.6);
    expect(r.note).toContain("减半");
  });

  test("高开 +5% 之后又跌破止损 → 一半在开盘走、另一半在止损走（旧实现会把全部算在止损价）", () => {
    const r = exitCase({ open: 10.5, high: 10.55, low: 9.2, close: 9.3 });
    expect(r.legs).toHaveLength(2);
    expect(r.legs[0]!.note).toContain("减半");
    expect(r.legs[1]!.price).toBe(9.7); // 止损价，而不是收盘 9.3，也不是全部 9.7
    expect(r.legs[1]!.qty).toBe(500);
  });

  test("跳空开在止损下方 → 全部按开盘价（止损不是亏损上限）", () => {
    const r = exitCase({ open: 9.1, high: 9.4, low: 8.9, close: 9.2 });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.price).toBe(9.1);
    expect(r.note).toContain("跳空");
  });

  test("100 股凑不出一手分批 → 不拆单，整仓交给止损/到点规则", () => {
    const r = exitCase({ open: 10.5, high: 10.6, low: 10.4, close: 10.55 }, 10, 9.7, 100);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.qty).toBe(100);
    expect(r.legs[0]!.note).toContain("到点清仓");
  });

  test("一字跌停卖不出：零成交腿（回测据此顺延续持，训练集不得丢弃它）", () => {
    const r = exitCase({ open: 9, high: 9, low: 9, close: 9 }, 10, 9.7, 1000);
    expect(r.legs).toHaveLength(0);
    expect(r.blended).toBeNull();
  });
});

/**
 * 止损口径的反事实对照：用“手上这些成交”回答 ATR 比固定 3% 好吗，
 * 而不是拿同一段历史再扫一次参数（6 重比较，换窗口结论就飘）。
 */
const cf = (over: Partial<Parameters<typeof stopCounterfactual>[0]> = {}) =>
  stopCounterfactual({
    code: "600000",
    name: "测试股份",
    entryDate: "2026-09-18",
    exitDate: "2026-09-21",
    exitTime: "10:00",
    qty: 1000,
    entry: 10,
    exit: 9.9, // 真实出场价（固定线未触发，拿到收盘）
    lowWater: 9.5,
    stopFixed: 9.7,
    stopAtr: 9.2,
    activeMode: "atr",
    ...over,
  });

describe("止损反事实对照 stopCounterfactual", () => {
  test("固定线被击穿、ATR 线并没来到 → ATR 多撑一段，差值为正", () => {
    const r = cf();
    expect(r.fixedTriggered).toBe(true);
    expect(r.atrTriggered).toBe(false);
    // 固定线会卖在 9.7，ATR 会拿到真实出场 9.9 → ATR 更好 200bp
    expect(r.diffBps).toBe(200);
  });

  test("两个口径都击穿 → 更深的 ATR 卖得更低，差值为负", () => {
    const r = cf({ lowWater: 9.0, exit: 8.9 });
    expect(r.fixedTriggered).toBe(true);
    expect(r.atrTriggered).toBe(true);
    expect(r.diffBps).toBe(-500); // (9.2 - 9.7)/10 = -500bp
  });

  test("都没触发 → 两边结局相同，这笔对结论没有信息量", () => {
    const one = cf({ lowWater: 9.8, exit: 9.9 });
    expect(one.diffBps).toBe(0);
    expect(one.atrTriggered).toBe(false);
    expect(one.fixedTriggered).toBe(false);
    const s = summarizeStopCounterfactuals([one]);
    expect(s.n).toBe(1);
    expect(s.tie).toBe(1);
    expect(s.neitherTriggered).toBe(1); // 汇总时应把这笔排除在“谁更好”之外
  });

  test("汇总：胜负计数与均值都按“ATR 为正”的方向算", () => {
    const rows = [cf(), cf({ lowWater: 9.0, exit: 8.9 }), cf({ lowWater: 9.8, exit: 9.9 })];
    const s = summarizeStopCounterfactuals(rows);
    expect(s.n).toBe(3);
    expect(s.atrBetter).toBe(1);
    expect(s.fixedBetter).toBe(1);
    expect(s.tie).toBe(1);
    expect(s.meanDiffBps).toBe(-100); // (200 - 500 + 0)/3
  });
});
