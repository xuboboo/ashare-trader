import { describe, expect, test } from "bun:test";
import { cancelStaleSells, makeExitOrder } from "../src/orders";
import type { Position } from "../src/state";
import { Book, makeFill } from "../src/state";
import { mkSnap } from "./helpers";

/**
 * 死单改价与账本硬规则。这组用例给审计发现的两个真实缺陷上锁：
 *  1) 在途卖单被市价击穿后永远挂着不成交，又占住唯一的卖坑，
 *     止损/到点清仓全部被挡 —— 持仓裸奔一整天；
 *  2) 账本接受超过持仓（或 T+1 不可卖）的卖出成交，给没持有的股票记现金。
 */

const DAY1 = "2026-09-21";
const clock = { date: DAY1, time: "09:35" };

function heldPos(over: Partial<Position> = {}): Position {
  return {
    code: "600000",
    name: "测试股份",
    qty: 200,
    sellable: 200,
    frozen: 0,
    avgPrice: 10.5,
    feesPaid: 5,
    openDate: "2026-09-18",
    stopPrice: 9.5,
    lastPrice: 10.5,
    ...over,
  };
}

describe("死单改价 cancelStaleSells", () => {
  test("市价连续跌穿限价下沿达到轮数 → 撤单并写明原因", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.5, prevClose: 10 }), clock, "开盘浮盈先卖一半", 100)!;
    const pending = new Map([[o.signalId, o]]);
    const below = new Map([["600000", mkSnap({ price: 10.2, prevClose: 10 })]]);
    expect(o.limitLow).toBe(10.48);
    // 第 1 轮：不到轮数，单还在，计数 +1
    expect(cancelStaleSells(pending, below, 2).changed).toBe(false);
    expect(pending.size).toBe(1);
    expect(o.staleBelowRounds).toBe(1);
    // 第 2 轮：撤
    const r = cancelStaleSells(pending, below, 2);
    expect(r.changed).toBe(true);
    expect(r.cancelled).toHaveLength(1);
    expect(r.cancelled[0]!.status).toBe("cancelled");
    expect(r.cancelled[0]!.rejectReason).toContain("撤单改价");
    expect(pending.size).toBe(0);
  });

  test("市价回到限价带内 → 计数清零，噪声不触发撤单", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.5, prevClose: 10 }), clock, "止损", 100)!;
    const pending = new Map([[o.signalId, o]]);
    const below = new Map([["600000", mkSnap({ price: 10.2, prevClose: 10 })]]);
    const back = new Map([["600000", mkSnap({ price: 10.55, prevClose: 10 })]]);
    cancelStaleSells(pending, below, 2);
    expect(o.staleBelowRounds).toBe(1);
    cancelStaleSells(pending, back, 2);
    expect(o.staleBelowRounds).toBe(0);
    expect(pending.size).toBe(1);
  });

  test("市价在限价带上方（更好价）不撤：限价卖单会按带内价成交", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.5, prevClose: 10 }), clock, "止损", 100)!;
    const pending = new Map([[o.signalId, o]]);
    const above = new Map([["600000", mkSnap({ price: 11.0, prevClose: 10 })]]);
    const r = cancelStaleSells(pending, above, 2);
    expect(r.changed).toBe(false);
    expect(pending.size).toBe(1);
  });

  test("买入单不受影响：错过就错过，不追价", () => {
    const pending = new Map<string, ReturnType<typeof makeExitOrder> & object>();
    const fakeBuy = {
      ...makeExitOrder(heldPos(), mkSnap(), clock, "x", 100)!,
      side: "buy" as const,
    };
    pending.set(fakeBuy.signalId, fakeBuy);
    const below = new Map([["600000", mkSnap({ price: 5, prevClose: 10 })]]);
    const r = cancelStaleSells(pending as never, below, 2);
    expect(r.changed).toBe(false);
    expect(pending.size).toBe(1);
  });
});

describe("Jev 定价的卖出单 makeExitOrder(priceHint)", () => {
  test("hint 高于市价：限价带以 hint 为中心挂出（等更好的价）", () => {
    // 现价 10.2，Jev 定价 +1% ≈ 10.30
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.2, prevClose: 10 }), clock, "Jev 卖出辅助", 100, 0, 10.3)!;
    expect(o.priceRef).toBe(10.3);
    expect(o.limitLow).toBe(10.28);
    expect(o.limitHigh).toBe(10.32);
  });
  test("hint 低于市价：钳到市价（低于市价的卖单等于市价离场）", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.2, prevClose: 10 }), clock, "Jev 卖出辅助", 100, 0, 9.9)!;
    expect(o.priceRef).toBe(10.2);
  });
  test("hint 超过涨停：钳到涨停", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.2, prevClose: 10 }), clock, "Jev 卖出辅助", 100, 0, 12)!;
    expect(o.priceRef).toBe(mkSnap({ prevClose: 10 }).limitUp);
  });
  test("硬规则卖出不传 hint：维持触发瞬间市价带", () => {
    const o = makeExitOrder(heldPos(), mkSnap({ price: 10.2, prevClose: 10 }), clock, "跌破止损", 100)!;
    expect(o.priceRef).toBe(10.2);
    expect(o.limitLow).toBe(10.18);
    expect(o.limitHigh).toBe(10.22);
  });
});

describe("账本硬规则：T+1 与不可超卖", () => {
  test("卖出超过持仓：只有持有的部分进现金，note 写明", () => {
    const book = new Book(10_000);
    book.rollover(DAY1);
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10, qty: 100, date: DAY1, time: "09:30", kind: "paper" }),
    );
    // 当日买入 frozen：卖 200 只有 0 股可卖（T+1）
    const cashAfterBuy = book.cash;
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "sell", price: 11, qty: 200, date: DAY1, time: "09:40", kind: "manual" }),
    );
    expect(book.cash).toBe(cashAfterBuy); // 一分钱也不进：T+1 当日买入不可卖
    expect(book.fills.at(-1)!.note).toContain("T+1");
  });

  test("次日起卖出超过持仓：持仓部分有效，超出部分不计现金", () => {
    const book = new Book(10_000);
    book.rollover(DAY1);
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10, qty: 100, date: DAY1, time: "09:30", kind: "paper" }),
    );
    book.rollover("2026-09-22");
    const cashBeforeSell = book.cash;
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "sell", price: 11, qty: 300, date: "2026-09-22", time: "09:40", kind: "manual" }),
    );
    // 100 股有效：现金增加 100×11 − 卖出费用；绝不会把没持有的 200 股也记成现金
    expect(book.cash).toBeGreaterThan(cashBeforeSell);
    expect(book.cash).toBeLessThan(cashBeforeSell + 300 * 11);
    expect(book.positions.size).toBe(0);
    expect(book.fills.at(-1)!.note).toContain("100/300");
  });
});

describe("成交流水带盈亏口径", () => {
  test("卖出成交记录成本价与盈亏比例（A 股 App 口径，已扣费）", () => {
    const book = new Book(10_000);
    book.rollover(DAY1);
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "buy", price: 10, qty: 200, date: DAY1, time: "09:30", kind: "paper" }),
    );
    book.rollover("2026-09-22");
    book.applyFill(
      makeFill({ code: "600000", name: "测试股份", side: "sell", price: 11, qty: 200, date: "2026-09-22", time: "09:40", kind: "paper" }),
    );
    const f = book.fills.at(-1)!;
    expect(f.costAvg).toBe(10);
    expect(f.realizedPnl).toBeDefined();
    // 盈亏比例 = 已实现盈亏 / (成本价 × 数量)
    expect(f.realizedPnlPct).toBeCloseTo((f.realizedPnl! / 2000) * 100, 2);
  });
});
