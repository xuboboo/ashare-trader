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

describe("撤销成交（重放重建账本）", () => {
  const sell = (over = {}) =>
    makeFill({
      code: "600000",
      name: "浦发银行",
      side: "sell",
      price: 9.5,
      qty: 1000,
      date: "2026-09-21",
      time: "10:00",
      kind: "manual",
      ...over,
    });

  test("重放结果与顺序应用完全一致", () => {
    const a = new Book(100_000);
    a.rollover("2026-09-18");
    a.applyFill(buy({ qty: 1000 }));
    a.rollover("2026-09-21");
    a.applyFill(sell({ qty: 400, time: "09:40" }));
    const b = new Book(100_000);
    b.rebuild(a.fills);
    expect(b.cash).toBe(a.cash);
    expect(b.realizedTotal).toBe(a.realizedTotal);
    const pa = a.positions.get("600000")!;
    const pb = b.positions.get("600000")!;
    expect(pb.qty).toBe(pa.qty);
    expect(pb.sellable).toBe(pa.sellable);
    expect(pb.frozen).toBe(pa.frozen);
    expect(pb.feesPaid).toBe(pa.feesPaid);
  });

  test("撤销唯一一笔买入 → 回到初始现金、空仓", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy());
    expect(book.positions.size).toBe(1);
    book.rebuild(book.fills.filter((f) => f.id !== book.fills[0]!.id));
    expect(book.positions.size).toBe(0);
    expect(book.cash).toBe(100_000);
    expect(book.realizedTotal).toBe(0);
    expect(book.fills).toHaveLength(0);
  });

  test("撤销中间一笔：剩下的重放仍然自洽", () => {
    const book = new Book(100_000);
    book.rollover("2026-09-18");
    book.applyFill(buy({ qty: 1000 })); // 1000 股 @9.07
    book.rollover("2026-09-21");
    book.applyFill(sell({ qty: 400, price: 9.5, time: "09:40" }));
    book.applyFill(sell({ qty: 600, price: 8.6, time: "10:00" }));
    expect(book.positions.size).toBe(0);

    const last = book.fills[2]!;
    book.rebuild(book.fills.filter((f) => f.id !== last.id));
    const p = book.positions.get("600000")!;
    expect(book.fills).toHaveLength(2);
    expect(p.qty).toBe(600);
    expect(p.sellable).toBe(600); // 跨日已解锁
    expect(p.frozen).toBe(0);
    // 全账自洽：权益 = 本金 + 已实现 + 浮动
    p.lastPrice = 9.07;
    const t = book.totals();
    expect(t.equity).toBeCloseTo(t.cash + 600 * 9.07, 2);
    expect(t.realized).toBeCloseTo(book.realizedTotal, 2);
  });
});
