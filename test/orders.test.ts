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
  test("成交用下一轮观测价 + 滑点，不拿下单那一刻的参考价占便宜", () => {
    const o = makeBuyOrder(scored(), clock)!; // priceRef 10.5, limitHigh 10.52
    updateResting(o, mkSnap({ price: 10.51, low: 10.4, high: 10.6 }));
    const fill = tryPaperFill(o, mkSnap({ price: 10.51, low: 10.4, high: 10.6 }), clock)!;
    expect(fill.price).toBe(10.52); // 10.51 + 1 tick 被限价钳住
    expect(fill.spreadBps).toBeGreaterThan(0); // 成交瞬间记录了盘口价差
    expect(fill.price).toBeGreaterThan(o.priceRef);
  });

  test("价格跑到限价之上就是追价失败，不成交（也不拿之后的好价补）", () => {
    const o = makeBuyOrder(scored({ price: 10.5 }), clock)!;
    // 挂单前的全天低点不能替我们成交：只更新“挂单之后”的观察价
    o.seenLow = o.seenHigh = o.priceRef;
    updateResting(o, mkSnap({ price: 10.9, low: 10.85, high: 10.95 }));
    // seenLow 仍等于创建时的现价，低于限价 → 可成交，但成交价取当前观测价并被限价钳住
    const fill = tryPaperFill(o, mkSnap({ price: 10.9, low: 10.85, high: 10.95 }), clock)!;
    expect(fill.price).toBe(o.limitHigh);
    // 而挂单后价格一路向上、从未回到限价：把 seenLow 推高就该判不成交
    o.seenLow = 10.95;
    expect(tryPaperFill(o, mkSnap({ price: 10.95, low: 10.9, high: 11 }), clock)).toBeNull();
  });

  test("卖单跌穿限价：按限价成交，不美化成更高的价", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    book.rollover("2026-09-21");
    const pos = book.positions.get("600000")!;
    const sell = makeExitOrder(pos, mkSnap({ price: 10, prevClose: 10.5 }), { date: "2026-09-21", time: "09:35" }, "止损", 1000)!;
    expect(sell.limitLow).toBe(9.98);
    const fill = tryPaperFill(sell, mkSnap({ price: 9.5, prevClose: 10.5, high: 10.5, low: 9.4 }), clock)!;
    expect(fill.price).toBe(sell.limitLow); // 被限价托住，不会记成 10.4 那种好看价
  });

  test("停牌与一字板不成交", () => {
    const o = makeBuyOrder(scored(), clock)!;
    expect(tryPaperFill(o, mkSnap({ suspended: true, price: 10.5 }), clock)).toBeNull();
    expect(tryPaperFill(o, mkSnap({ oneLineUp: true, price: 11, high: 11, low: 11 }), clock)).toBeNull();
    // 一字跌停的卖单：即使 seenHigh 满足条件也不给成交
    expect(tryPaperFill({ ...o, side: "sell", seenHigh: 12 }, mkSnap({ oneLineDown: true, price: 9, low: 9, high: 9 }), clock)).toBeNull();
  });

  test("T+1：今日买入的仓位不会被要求卖出", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    const pos = book.positions.get("600000")!;
    expect(makeExitOrder(pos, mkSnap(), { date: "2026-09-18", time: "14:50" }, "到点清仓", 1000)).toBeNull();
  });
});
