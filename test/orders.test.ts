import { describe, expect, test } from "bun:test";
import { featuresFromSnapshot, scoreStock } from "../src/factors";
import { makeBuyOrder, makeExitOrder, tryPaperFill, updateResting } from "../src/orders";
import { Book, makeFill } from "../src/state";
import { mkSnap } from "./helpers";

const clock = { date: "2026-09-18", time: "14:45" };
const scored = (over = {}) => scoreStock(featuresFromSnapshot(mkSnap(over), clock.date));

describe("建议单", () => {
  test("通过筛选时给出可手工执行的限价区间", () => {
    // 预算显式传参：不隐式依赖 .env 的 SIZE_CNY
    const o = makeBuyOrder(scored(), clock, undefined, 50_000)!;
    expect(o).toBeTruthy();
    expect(o.side).toBe("buy");
    expect(o.qty % 100).toBe(0);
    expect(o.qty).toBe(4700); // 50000 / 10.51 -> 4700 股
    expect(o.limitHigh).toBeLessThanOrEqual(o.priceRef + 0.02);
    expect(o.limitLow).toBeGreaterThan(0);
    expect(o.stopPrice).toBe(10.19); // 10.5 * 0.97
    expect(o.mustExitAt).toBe("次日 10:00");
    expect(o.costBps).toBeGreaterThan(10);
    expect(o.status).toBe("pending");
    expect(o.reason).toContain("涨幅");
  });

  test("1 万本金口径：3300 元预算在 10.5 元买 300 股，够不着的高价股不出单", () => {
    const o = makeBuyOrder(scored(), clock, undefined, 3_300)!;
    expect(o).toBeTruthy();
    expect(o.qty).toBe(300);
    expect(o.warn).toContain("最低佣金"); // 3300 元吃 5 元最低佣金，必须亮出来
    expect(makeBuyOrder(scored({ price: 33.5, prevClose: 32, vwap: 32.5, limitUp: 35.2 }), clock, undefined, 3_300)).toBeNull();
  });

  test("被否决的股票不出单", () => {
    expect(makeBuyOrder(scored({ gainPct: 0, price: 10.0 }), clock)).toBeNull(); // 涨幅不够
    expect(makeBuyOrder(scored({ oneLineUp: true, high: 11, low: 11, price: 11 }), clock)).toBeNull();
    expect(makeBuyOrder(scored({ volumeRatio: 0.5 }), clock)).toBeNull();
  });

  test("高价股一手都买不起时直接不出单，而不是出 0 股", () => {
    const o = makeBuyOrder(scored({ price: 926.43, prevClose: 896, vwap: 900, limitUp: 1075.2 }), clock);
    expect(o).toBeNull();
  });

  test("veto 理由会把建议单压掉", () => {
    expect(makeBuyOrder(scored(), clock, "有减持公告")).toBeNull();
  });
});

describe("纸面撮合（保守口径）", () => {
  test("成交价吃真实对手价：买吃卖一，不拿下单那一刻的参考价占便宜", () => {
    const o = makeBuyOrder(scored(), clock)!; // priceRef 10.5, limitHigh 10.52
    updateResting(o, mkSnap({ price: 10.51, low: 10.4, high: 10.6 }));
    const fill = tryPaperFill(o, mkSnap({ price: 10.51, low: 10.4, high: 10.6 }), clock)!;
    expect(fill.price).toBe(10.51); // 立即吃卖一：真实可得价，而非 last+1tick 的合成滑点
    expect(fill.spreadBps).toBeGreaterThan(0); // 成交瞬间记录了盘口价差
    expect(fill.price).toBeGreaterThan(o.priceRef);
  });

  test("价格跑到限价之上就是追价失败：限价内没有对手量就不成交", () => {
    const o = makeBuyOrder(scored({ price: 10.5 }), clock)!;
    // 挂单前的全天低点不能替我们成交：只更新“挂单之后”的观察价
    o.seenLow = o.seenHigh = o.priceRef;
    const far = mkSnap({ price: 10.9, low: 10.85, high: 10.95, bids: [{ p: 10.89, v: 100 }], asks: [{ p: 10.92, v: 100 }] });
    updateResting(o, far);
    // 卖一 10.92 高于我们愿意付的 10.52 → 我们的单挂在场上，不成交（而不是旧模型的“按限价成交”）
    expect(tryPaperFill(o, far, clock)).toBeNull();
    // 回到限价以内才成交，并且吃的是当时卖一
    const back = mkSnap({ price: 10.5, bids: [{ p: 10.49, v: 100 }], asks: [{ p: 10.51, v: 100 }] });
    const fill = tryPaperFill(o, back, clock)!;
    expect(fill.price).toBe(10.51);
    expect(fill.price).toBeLessThanOrEqual(o.limitHigh);
    // 挂单后价格一路向上、从未回到限价：seenLow 被推高就该判不成交
    o.seenLow = 10.95;
    expect(tryPaperFill(o, mkSnap({ price: 10.95, low: 10.9, high: 11, bids: [{ p: 10.95, v: 100 }], asks: [{ p: 10.96, v: 100 }] }), clock)).toBeNull();
  });

  test("卖单打不到买一：买一低于卖单限价就是不成交（单继续挂着）", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    book.rollover("2026-09-21");
    const pos = book.positions.get("600000")!;
    const sell = makeExitOrder(pos, mkSnap({ price: 10, prevClose: 10.5 }), { date: "2026-09-21", time: "09:35" }, "止损", 1000)!;
    expect(sell.limitLow).toBe(9.98);
    // 旧实现：买一 9.97 低于限价 9.98 → 强行按 9.98 成交（一笔根本不会发生的成交）
    const below = mkSnap({ price: 9.5, prevClose: 10.5, high: 10.5, low: 9.4, bids: [{ p: 9.97, v: 100 }], asks: [{ p: 9.99, v: 100 }] });
    expect(tryPaperFill(sell, below, clock)).toBeNull();
    // 买一回到限价之上才成交，并且打的是真实买一
    const at = mkSnap({ price: 10, prevClose: 10.5, high: 10.1, low: 9.9, bids: [{ p: 9.99, v: 100 }], asks: [{ p: 10.01, v: 100 }] });
    const fill = tryPaperFill(sell, at, clock)!;
    expect(fill.price).toBe(9.99);
  });

  /**
   * 可见深度限制成交量：L1 给五档量，“按卖一全部成交”是在假设排队优先权归我们。
   * 不建模部分成交，就会把“盘口只有 300 股、我们买 5000”当成全部成交 —— 那是不存在的流动性。
   */
  test("深度不够就只成交一部分：余量继续挂着，成交价是逐档加权价", () => {
    const o = makeBuyOrder(scored(), clock, undefined, 50_000)!; // 4700 股，limitHigh 10.52
    expect(o.qty).toBe(4700);
    // 只有 10 手（1000 股）在 10.51，下一档 10.52 还在限价内
    const shallow = mkSnap({ price: 10.5, asks: [{ p: 10.51, v: 10 }], bids: [{ p: 10.49, v: 100 }] });
    const fill = tryPaperFill(o, shallow, clock)!;
    expect(fill.qty).toBe(1000); // 只成交可见的那 10 手
    expect(fill.note ?? "").toContain("部分成交");
    expect(fill.note ?? "").toContain("1000/4700");
    // 逐档加权：四档全吃时均价比卖一差 → 冲击成本被计入
    const o2 = makeBuyOrder(scored(), clock, undefined, 50_000)!;
    const deep = mkSnap({ price: 10.5, asks: [{ p: 10.51, v: 10 }, { p: 10.52, v: 100 }], bids: [{ p: 10.49, v: 100 }] });
    const fill2 = tryPaperFill(o2, deep, clock)!;
    expect(fill2.qty).toBe(4700);
    expect(fill2.price).toBeGreaterThan(10.51); // (1000×10.51 + 3700×10.52)/4700 ≈ 10.518
    expect(fill2.price).toBeLessThanOrEqual(o2.limitHigh);
  });

  test("卖单跌穿限价：买一在限价之上时按真实买一成交，不美化成更高的价", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    book.rollover("2026-09-21");
    const pos = book.positions.get("600000")!;
    const sell = makeExitOrder(pos, mkSnap({ price: 10, prevClose: 10.5 }), { date: "2026-09-21", time: "09:35" }, "止损", 1000)!;
    // 买一 10.05 高于卖单限价 → 成交在 10.05，不会记成 10.4 那种好看价
    const fill = tryPaperFill(sell, mkSnap({ price: 10, prevClose: 10.5, high: 10.2, low: 9.9, bids: [{ p: 10.05, v: 100 }], asks: [{ p: 10.07, v: 100 }] }), clock)!;
    expect(fill.price).toBe(10.05);
    expect(fill.price).toBeGreaterThanOrEqual(sell.limitLow);
  });

  test("停牌与一字板不成交", () => {
    const o = makeBuyOrder(scored(), clock)!;
    expect(tryPaperFill(o, mkSnap({ suspended: true, price: 10.5 }), clock)).toBeNull();
    expect(tryPaperFill(o, mkSnap({ oneLineUp: true, price: 11, high: 11, low: 11 }), clock)).toBeNull();
    // 一字跌停的卖单：即使 seenHigh 满足条件也不给成交
    expect(tryPaperFill({ ...o, side: "sell", seenHigh: 12 }, mkSnap({ oneLineDown: true, price: 9, low: 9, high: 9 }), clock)).toBeNull();
  });

  test("无对手盘不成交：盘口存在但买一/卖一为 0，这轮放弃", () => {
    const o = makeBuyOrder(scored(), clock)!;
    // 买单：卖一为 0 = 没人卖，买不进
    expect(tryPaperFill(o, mkSnap({ price: 10.5, bids: [{ p: 10.49, v: 100 }], asks: [{ p: 0, v: 0 }] }), clock)).toBeNull();
    // 卖单：买一为 0 = 没人买，卖不出
    const s = { ...o, side: "sell" as const, seenHigh: 12 };
    expect(tryPaperFill(s, mkSnap({ price: 10.5, bids: [{ p: 0, v: 0 }], asks: [{ p: 10.51, v: 100 }] }), clock)).toBeNull();
    // 整本盘口缺失（数据残缺）才按 last±tick 兜底
    const fill = tryPaperFill(o, mkSnap({ price: 10.5, bids: [], asks: [] }), clock)!;
    expect(fill.price).toBe(10.51); // last 10.5 + 1 tick，被限价钳住
  });

  test("T+1：今日买入的仓位不会被要求卖出", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    const pos = book.positions.get("600000")!;
    expect(makeExitOrder(pos, mkSnap(), { date: "2026-09-18", time: "14:50" }, "到点清仓", 1000)).toBeNull();
  });
});
