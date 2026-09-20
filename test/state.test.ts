import { describe, expect, test } from "bun:test";
import { Book, makeFill } from "../src/state";

const buy = (over = {}) =>
  makeFill({
    code: "600000",
    name: "浦发银行",
    side: "buy",
    price: 9.07,
    qty: 1000,
    date: "2026-09-18",
    time: "14:45",
    kind: "paper",
    ...over,
  });

describe("T+1 与账本", () => {
  test("当日买入全部冻结，可卖为 0", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy());
    const p = book.positions.get("600000")!;
    expect(p.qty).toBe(1000);
    expect(p.frozen).toBe(1000);
    expect(p.sellable).toBe(0);
  });

  test("日切把昨日冻结转为可卖，重复日切不重复解锁", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy());
    expect(book.rollover("2026-09-21")).toBe(true); // 跨周末
    const p = book.positions.get("600000")!;
    expect(p.sellable).toBe(1000);
    expect(p.frozen).toBe(0);
    expect(book.rollover("2026-09-21")).toBe(false);
    expect(p.sellable).toBe(1000);
  });

  test("同一天先买后卖：新买入的那部分不能卖", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy({ qty: 1000 }));
    book.rollover("2026-09-21");
    book.applyFill(buy({ qty: 500, date: "2026-09-21" }));
    const p = book.positions.get("600000")!;
    expect(p.qty).toBe(1500);
    expect(p.sellable).toBe(1000);
    expect(p.frozen).toBe(500);
    expect(p.avgPrice).toBeCloseTo((1000 * 9.07 + 500 * 9.07) / 1500, 4);
  });

  test("卖出实现的盈亏已扣掉双边全部费用，且权益守恒", () => {
    const start = 100_000;
    const book = new Book(start);
    book.rollover("2026-09-18");
    book.applyFill(buy()); // 9.07 买入
    book.rollover("2026-09-21");
    const realized = book.applyFill(
      makeFill({
        code: "600000",
        name: "浦发银行",
        side: "sell",
        price: 9.5,
        qty: 1000,
        date: "2026-09-21",
        time: "10:00",
        kind: "paper",
      }),
    )!;
    // 毛利 430，双边费用合计应在 10~20 元之间（最低佣金生效）
    expect(realized).toBeGreaterThan(410);
    expect(realized).toBeLessThan(430);
    expect(book.positions.size).toBe(0);
    expect(book.realizedTotal).toBeCloseTo(realized, 2);
    // 全平后权益 = 现金 = 本金 + 实现盈亏
    const t = book.totals();
    expect(t.marketValue).toBe(0);
    expect(t.equity).toBeCloseTo(start + realized, 2);
    expect(t.pnlCny).toBeCloseTo(realized, 2);
  });

  test("部分卖出时买入费用按比例结转", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy({ qty: 2000 }));
    book.rollover("2026-09-21");
    const p = book.positions.get("600000")!;
    const feesBefore = p.feesPaid;
    book.applyFill(
      makeFill({
        code: "600000",
        name: "浦发银行",
        side: "sell",
        price: 9.5,
        qty: 1000,
        date: "2026-09-21",
        time: "10:00",
        kind: "paper",
      }),
    );
    expect(p.feesPaid).toBeCloseTo(feesBefore / 2, 2);
    expect(p.qty).toBe(1000);
    expect(p.sellable).toBe(1000);
  });

  test("止损价按买入价与 STOP_LOSS_PCT 生成", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy());
    expect(book.positions.get("600000")!.stopPrice).toBe(8.8); // 9.07 * 0.97
  });
});
