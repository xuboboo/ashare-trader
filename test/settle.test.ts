import { describe, expect, test } from "bun:test";
import { featuresFromSnapshot, scoreStock } from "../src/factors";
import {
  makeBuyOrder,
  makeExitOrder,
  restingKey,
  restingKeys,
  settlePending,
  tryPaperFill,
  type SuggestedOrder,
} from "../src/orders";
import { Book, makeFill } from "../src/state";
import type { TickTrade } from "../src/quotes";
import { mkSnap } from "./helpers";

/**
 * 影子撮合的整条闭环。这一组用例是给一次审计里发现的三个缺陷上的锁：
 *  1) 退出建议单从来没进 pending —— 影子盘只买不买，退出阶梯从未被执行过；
 *  2) 本轮刚建的单本轮就按同一份快照成交 —— 把人工下单的延迟免掉了，成交率 100%；
 *  3) 未成交的当日单跨到第二天照样能成交 —— 一张有效期一天的策略指令实际活了 1.5 天。
 */

const DAY1 = "2026-09-18";
const DAY2 = "2026-09-21";
const clock1 = { date: DAY1, time: "14:45", minutes: 885 };
const clock2 = { date: DAY2, time: "09:35", minutes: 575 };

const scored = (over = {}) => scoreStock(featuresFromSnapshot(mkSnap(over), DAY1));

function settle(
  pending: Map<string, SuggestedOrder>,
  snapshots: Map<string, ReturnType<typeof mkSnap>>,
  opts: Partial<{ clock: { date: string; time: string; minutes: number }; usable: boolean; roundStartMs: number; dayOver: boolean; tapes: Map<string, TickTrade[]> }> = {},
) {
  return settlePending(pending, {
    snapshots: snapshots as never,
    clock: opts.clock ?? clock2,
    usable: opts.usable ?? true,
    paper: true,
    roundStartMs: opts.roundStartMs ?? Date.now() + 60_000, // 默认：本轮开始于挂单之后
    dayOver: opts.dayOver ?? false,
    tapes: opts.tapes,
  });
}

/** 一笔已成交的买单 + 日切后的持仓（撮合的起点状态） */
function heldBook() {
  const book = new Book(100_000);
  book.rollover(DAY1);
  book.applyFill(
    makeFill({
      code: "600000",
      name: "测试股份",
      side: "buy",
      price: 10.5,
      qty: 1000,
      date: DAY1,
      time: "14:45",
      kind: "paper",
      stopPrice: 10.19,
    }),
  );
  book.rollover(DAY2);
  return book;
}

describe("影子撮合 settlePending", () => {
  test("本轮挂出去的单本轮不成交：至少付一个行情切片的延迟", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const pending = new Map([[o.signalId, o]]);
    const snaps = new Map([["600000", mkSnap()]]);
    // roundStartMs 早于挂单时刻 = 这一轮就是创建它的那一轮
    const r = settle(pending, snaps, { clock: clock1, roundStartMs: o.restingSince - 10 });
    expect(r.fills).toHaveLength(0);
    expect(r.changed).toBe(false);
    expect(pending.size).toBe(1);
    expect(o.status).toBe("pending");
  });

  test("下一轮按当时对手价成交：买吃卖一，成交记录带着建议单的止损线", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const pending = new Map([[o.signalId, o]]);
    // 卖一 10.51 在限价 10.52 以内，盘口量足够 → 全部成交
    const snaps = new Map([["600000", mkSnap({ price: 10.51, asks: [{ p: 10.51, v: 100 }], bids: [{ p: 10.49, v: 100 }] })]]);
    const r = settle(pending, snaps, { clock: clock1 });
    expect(r.fills).toHaveLength(1);
    const fill = r.fills[0]!;
    expect(fill.price).toBe(10.51);
    expect(fill.qty).toBe(o.qty);
    expect(fill.price).toBeLessThanOrEqual(o.limitHigh); // 被限价带钳住
    expect(fill.stopPrice).toBeDefined();
    expect(fill.stopPrice).toBe(o.stopPrice ?? undefined); // ATR/fixed 口径的止损线跟着成交走
    expect(fill.stopFixed).toBe(o.stopFixed);
    expect(o.stopFixed).toBe(10.19); // 10.5 × 0.97（fixed）
    expect(pending.size).toBe(0);
    expect(o.status).toBe("filled");
  });

  test("部分成交：单留在在途队列，qty 递减，不会把单标成已成交", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!; // 4700 股
    const pending = new Map([[o.signalId, o]]);
    const snaps = new Map([["600000", mkSnap({ price: 10.5, asks: [{ p: 10.51, v: 15 }], bids: [{ p: 10.49, v: 100 }] })]]);
    const r = settle(pending, snaps, { clock: clock1 });
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(1500); // 限价内只有 15 手
    expect(pending.size).toBe(1); // 余量继续挂着
    expect(o.status).toBe("pending");
    expect(o.qty).toBe(4700 - 1500);
    expect(o.filledQty).toBe(1500);
    // 下一轮换到更厚的盘口：剩下的全部成交
    snaps.set("600000", mkSnap({ price: 10.5, asks: [{ p: 10.51, v: 100 }], bids: [{ p: 10.49, v: 100 }] }));
    const r2 = settle(pending, snaps, { clock: clock1 });
    expect(r2.fills[0]!.qty).toBe(3200);
    expect(pending.size).toBe(0);
    expect(o.status).toBe("filled");
    expect(o.filledQty).toBe(4700);
  });

  test("卖出腿同样能被撮合（旧实现退出单从不进 pending，这条全链路是断的）", () => {
    const book = heldBook();
    const pos = book.positions.get("600000")!;
    const sell = makeExitOrder(pos, mkSnap({ price: 9.8, prevClose: 10.5, quoteDay: "20260921" }), clock2, "跌破止损 10.19", pos.sellable)!;
    const pending = new Map([[sell.signalId, sell]]);
    const snaps = new Map([["600000", mkSnap({ price: 9.8, prevClose: 10.5, quoteDay: "20260921", bids: [{ p: 9.79, v: 100 }], asks: [{ p: 9.81, v: 100 }] })]]);
    const r = settle(pending, snaps);
    expect(r.fills).toHaveLength(1);
    book.applyFill(r.fills[0]!);
    expect(book.positions.size).toBe(0);
    expect(book.realizedTotal).toBeLessThan(0); // 10.5 买、~9.8 卖，必须是负的
    expect(r.fills[0]!.realizedPnl).toBe(book.realizedTotal);
  });

  test("隔日单一律作废；收盘后今天的单也作废（A 股本就是当日有效）", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const stale = new Map([[o.signalId, o]]);
    const snaps = new Map([["600000", mkSnap()]]);
    const r1 = settle(stale, snaps, { clock: clock2 }); // 昨天的单拿到今天的快照
    expect(r1.fills).toHaveLength(0);
    expect(o.status).toBe("expired");
    expect(stale.size).toBe(0);

    const today = makeBuyOrder(scored(), clock2, undefined, 50_000)!;
    const pending = new Map([[today.signalId, today]]);
    const r2 = settle(pending, snaps, { clock: clock2, dayOver: true });
    expect(r2.fills).toHaveLength(0);
    expect(today.status).toBe("expired");
    expect(pending.size).toBe(0);
  });

  test("行情不可用的轮次绝不撮合（拿隔夜价当活价是最贵的错）", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const pending = new Map([[o.signalId, o]]);
    const r = settle(pending, new Map([["600000", mkSnap()]]), { clock: clock1, usable: false });
    expect(r.fills).toHaveLength(0);
    expect(pending.size).toBe(1);
  });

  test("停牌与隔日行情都挡在撮合之外：quoteDay 不是今天的快照不参与", () => {
    const o = makeBuyOrder(scored(), clock2, undefined, 50_000)!;
    const pending = new Map([[o.signalId, o]]);
    const r = settle(pending, new Map([["600000", mkSnap({ quoteDay: "20260918" })]]), { clock: clock2 });
    expect(r.fills).toHaveLength(0);
    expect(pending.size).toBe(1);
  });

  test("同一标的同一方向只留一张在途单（决策每 60s 一轮，不去重会堆成几仓）", () => {
    const a = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const b = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const pending = new Map([[a.signalId, a]]);
    const keys = restingKeys(pending);
    expect(keys.has(restingKey(b))).toBe(true); // 同 code 同 side = 同一个坑
    const c = makeExitOrder(heldBook().positions.get("600000")!, mkSnap(), clock2, "到点清仓", 1000)!;
    expect(keys.has(restingKey(c))).toBe(false); // 反向是另一个坑
    void b;
  });

  test("成交记录里的止损线能被重放重现（流水是唯一事实）", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!;
    const pending = new Map([[o.signalId, o]]);
    const fills = settle(pending, new Map([['600000', mkSnap()]]), { clock: clock1 }).fills;
    const book = new Book(100_000);
    book.rollover(DAY1);
    for (const f of fills) book.applyFill(f);
    expect(book.positions.get("600000")!.stopPrice).toBe(o.stopPrice!);
    const replay = new Book(100_000);
    replay.rebuild(fills);
    expect(replay.positions.get("600000")!.stopPrice).toBe(o.stopPrice!);
  });
});

describe("排队撮合（分笔证据）", () => {
  /** 挂出一张 300 股卖单（限价下沿 10.48），盘口已离开限价（买一 10.40）→ 只能被动排队 */
  function restingSell(qty = 300) {
    const book = heldBook();
    const pos = book.positions.get("600000")!;
    const snap = mkSnap({ price: 10.5, quoteDay: "20260921", bids: [{ p: 10.4, v: 100 }], asks: [{ p: 10.55, v: 100 }] });
    const o = makeExitOrder(pos, snap, clock2, "跌破分时均线，弱势离场", qty)!;
    const pending = new Map([[o.signalId, o]]);
    return { o, pending, snap };
  }
  const tape = (rows: TickTrade[]): Map<string, TickTrade[]> => new Map([["600000", rows]]);

  test("主动成交不受分笔影响：买一回到限价内就按对手价吃", () => {
    const { o, pending } = restingSell();
    // 买一 10.49 ≥ 限价下沿 10.48，量只有 1 手 → 按对手价吃 100 股，余量继续挂
    const snap = mkSnap({ quoteDay: "20260921", bids: [{ p: 10.49, v: 1 }], asks: [{ p: 10.55, v: 100 }] });
    const { fills } = settle(pending, new Map([["600000", snap]]), { tapes: tape([]) });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(10.49);
    expect(fills[0]!.qty).toBe(100);
    void o;
  });

  test("被动成交：挂价上对手主动量 ≥ 余量 → 按挂价成交", () => {
    const { o, pending, snap } = restingSell();
    const tapes = tape([{ time: "09:35:03", price: 10.48, shares: 50_000, buyerAggressor: true }]);
    const { fills } = settle(pending, new Map([["600000", snap]]), { tapes });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(10.48); // 同价同价
    expect(fills[0]!.qty).toBe(300);
    expect(fills[0]!.note).toContain("排队成交");
    void o;
  });

  test("方向不对不成交：挂价上是主动卖（砸买盘），卖单队列没被消耗", () => {
    const { pending, snap } = restingSell();
    const tapes = tape([{ time: "09:35:03", price: 10.48, shares: 50_000, buyerAggressor: false }]);
    expect(settle(pending, new Map([["600000", snap]]), { tapes }).fills).toHaveLength(0);
  });

  test("挂单之前的成交量不算（队列在你挂单前就形成了）", () => {
    const { pending, snap } = restingSell();
    const tapes = tape([{ time: "09:34:59", price: 10.48, shares: 50_000, buyerAggressor: true }]);
    expect(settle(pending, new Map([["600000", snap]]), { tapes }).fills).toHaveLength(0);
  });

  test("价位不同不成交：10.50 的成交轮不到挂在 10.48 的单", () => {
    const { pending, snap } = restingSell();
    const tapes = tape([{ time: "09:35:03", price: 10.5, shares: 50_000, buyerAggressor: true }]);
    expect(settle(pending, new Map([["600000", snap]]), { tapes }).fills).toHaveLength(0);
  });

  test("量不够就部分成交，余量继续挂：50000 股里只有 200 股在我们价位主动成交", () => {
    const { o, pending, snap } = restingSell(300);
    const tapes = tape([{ time: "09:35:03", price: 10.48, shares: 200, buyerAggressor: true }]);
    const { fills } = settle(pending, new Map([["600000", snap]]), { tapes });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.qty).toBe(200);
    expect(o.qty).toBe(100); // 余量
    expect(o.filledQty).toBe(200);
  });

  test("无分笔数据：对手不在限价内就不成交（退回快照口径）", () => {
    const { pending, snap } = restingSell();
    expect(settle(pending, new Map([["600000", snap]]), { tapes: undefined }).fills).toHaveLength(0);
  });

  test("买单对称：挂价上主动卖（buyerAggressor=false）的量成交买单", () => {
    const o = makeBuyOrder(scored(), clock1, undefined, 50_000)!; // priceRef 10.5 → limitHigh 10.52
    const pending = new Map([[o.signalId, o]]);
    // 卖一 10.53 > 10.52 → 不构成主动成交
    const snap = mkSnap({ bids: [{ p: 10.49, v: 100 }], asks: [{ p: 10.53, v: 100 }] });
    const tapes = tape([{ time: "14:45:03", price: 10.52, shares: 5_000, buyerAggressor: false }]);
    const { fills } = settle(pending, new Map([["600000", snap]]), { clock: clock1, tapes });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(10.52);
    expect(fills[0]!.side).toBe("buy");
  });

  test("隔日分笔不充当今天的排队证据（早盘拉到的 1500 条全是昨天的）", () => {
    const { pending, snap } = restingSell();
    // 真实形态：昨天尾盘挂在 10.48 的卖单被大量主动买吃掉（14:45），今天 09:31 才开盘。
    // 没 todayTape 这一刀，“挂单时刻之后”的字符串比较挡不住昨天的 14:45（09:35 < 14:45），
    // 那 50000 股会被当成今天的排队量 → 凭空按 10.48 成交，还是个高于市价、对我们有利的好价。
    const tapes = tape([
      { time: "14:45:03", price: 10.48, shares: 50_000, buyerAggressor: true },
      { time: "09:31:00", price: 10.42, shares: 100, buyerAggressor: true },
    ]);
    expect(settle(pending, new Map([["600000", snap]]), { tapes }).fills).toHaveLength(0);
  });

  test("反证：绕过 todayTape 就会凭空成交（说明这一刀确实在挡东西）", () => {
    const { o, snap } = restingSell();
    const fill = tryPaperFill(o, snap, clock2, [
      { time: "14:45:03", price: 10.48, shares: 50_000, buyerAggressor: true },
    ]);
    expect(fill).toBeTruthy(); // 同一批行、不经剪切，它真的能成交
    expect(fill!.price).toBe(10.48);
    expect(fill!.qty).toBe(300);
  });
});
