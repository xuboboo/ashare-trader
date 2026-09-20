import { describe, expect, test } from "bun:test";
import { featuresFromSnapshot, scoreStock } from "../src/factors";
import { makeBuyOrder, makeExitOrder, tryPaperFill } from "../src/orders";
import { Book, makeFill } from "../src/state";
import { mkSnap } from "./helpers";

const clock = { date: "2026-09-18", time: "14:45" };
const scored = (over = {}) => scoreStock(featuresFromSnapshot(mkSnap(over), clock.date));

describe("建议单", () => {
  test("通过筛选时给出可手工执行的限价区间", () => {
    const o = makeBuyOrder(scored(), clock)!;
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

describe("纸面撮合", () => {
  test("价格穿过限价区间才成交，且吃一个滑点", () => {
    const o = makeBuyOrder(scored(), clock)!;
    const fill = tryPaperFill(o, mkSnap({ low: 10.4, high: 10.6 }), clock)!;
    expect(fill).toBeTruthy();
    expect(fill.qty).toBe(o.qty);
    expect(fill.price).toBeGreaterThanOrEqual(o.priceRef);
    expect(fill.price).toBeLessThanOrEqual(o.limitHigh);
    expect(fill.costs.total).toBeGreaterThan(0);
  });

  test("今天没跌到限价区间就不成交", () => {
    const o = makeBuyOrder(scored(), clock)!;
    expect(tryPaperFill(o, mkSnap({ low: o.limitHigh + 0.05, high: o.limitHigh + 0.2 }), clock)).toBeNull();
  });

  test("一字涨停买不进、一字跌停卖不出", () => {
    const o = makeBuyOrder(scored(), clock)!;
    expect(tryPaperFill(o, mkSnap({ oneLineUp: true, low: 11, high: 11, price: 11 }), clock)).toBeNull();

    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    book.rollover("2026-09-21");
    const pos = book.positions.get("600000")!;
    const sell = makeExitOrder(pos, mkSnap({ price: 10, prevClose: 10.5 }), { date: "2026-09-21", time: "09:35" }, "止损", 1000)!;
    expect(sell.limitLow).toBe(9.98); // 10 - 2 tick
    expect(tryPaperFill(sell, mkSnap({ price: 9.45, prevClose: 10.5, oneLineDown: true, high: 9.45, low: 9.45 }), clock)).toBeNull();
    // 当日最高价没碰到限价区间 → 不成交
    expect(tryPaperFill(sell, mkSnap({ price: 9.6, prevClose: 10.5, high: 9.7, low: 9.4 }), clock)).toBeNull();
    const fill = tryPaperFill(sell, mkSnap({ price: 9.99, prevClose: 10.5, high: 10.05, low: 9.4 }), clock)!;
    expect(fill).toBeTruthy();
    expect(fill.price).toBeGreaterThanOrEqual(sell.limitLow);
    expect(fill.price).toBeLessThanOrEqual(sell.priceRef);
  });

  test("T+1：今日买入的仓位不会被要求卖出", () => {
    const book = new Book(200_000);
    book.rollover("2026-09-18");
    book.applyFill(makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10.5, qty: 1000, date: "2026-09-18", time: "14:45", kind: "paper" }));
    const pos = book.positions.get("600000")!;
    expect(makeExitOrder(pos, mkSnap(), { date: "2026-09-18", time: "14:50" }, "到点清仓", 1000)).toBeNull();
  });
});
