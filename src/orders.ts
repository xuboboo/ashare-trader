/**
 * 建议单与纸面撮合。本系统不向券商下真实委托（PAPER 恒为 true 的唯一执行路径就是这里），
 * 产出的是"给你在券商 App 里手工下单的一行字"，以及影子成交用于记账与滑点统计。
 */
import { config } from "./config";
import { buyCosts, minCommissionWarn, sellCosts, slipFillPrice } from "./costs";
import { stopLevel } from "./exit";
import type { Scored } from "./factors";
import type { Snapshot } from "./quotes";
import { makeFill, round2, type Fill, type Position } from "./state";
import { sharesForBudget, tickPrice, type Side } from "./symbols";

export type OrderStatus = "pending" | "filled" | "expired" | "cancelled" | "rejected";

export interface SuggestedOrder {
  signalId: string;
  date: string;
  time: string;
  code: string;
  name: string;
  side: Side;
  qty: number;
  /** 参考价（决策瞬间的现价） */
  priceRef: number;
  /** 建议限价区间：手工下单就挂在这个区间内 */
  limitLow: number;
  limitHigh: number;
  stopPrice: number | null;
  /** 次日必须清仓的时间 */
  mustExitAt: string | null;
  amountCny: number;
  costCny: number;
  costBps: number;
  /** 最低佣金等提醒，不影响下单，只影响你是否值得下 */
  warn: string | null;
  /** 为什么出这一单（通过项） */
  reason: string;
  /** 反事实：STOP_MODE=atr 时记录"假如 fixed 3% 的止损价"，供影子盘对照审计 */
  stopFixedAlt?: number | null;
  /** 为什么不出单（否决项），仅诊断用 */
  rejectReason: string | null;
  score: number;
  status: OrderStatus;
  /** 影子成交价，人工成交后由回填覆盖 */
  fill: Fill | null;
  /** 挂单生效后的现价区间（不含挂单前的全天历史）。L1 只有 3s 切片，这就是能做到的粒度。 */
  seenLow: number;
  seenHigh: number;
  /** 开始挂着的时刻（epoch ms），用于区分“挂单前的下影线” */
  restingSince: number;
}

export interface Clock {
  date: string;
  time: string;
}

let seq = 0;
const nextId = (date: string) => `S${date.replace(/-/g, "")}-${(++seq).toString().padStart(4, "0")}`;

/** 新建建议单时，只看得到创建那一刻的现价；之后的极值由 updateResting 累加。 */
const resting = (price: number) => ({ seenLow: price, seenHigh: price, restingSince: Date.now() });

/** 尾盘/盘中开仓建议单。不可买（买不起一手 / 全否决）时返回 null。
 *  sizeCny / atr 可注入（测试用）：STOP_MODE=atr 且提供 atr 时，
 *  止损 = 买入价 − ATR_K×ATR（封底买入价×90%），并记录 fixed 止损作反事实。 */
export function makeBuyOrder(
  scored: Scored,
  clock: Clock,
  vetoReason?: string,
  sizeCny: number = config.sizeCny,
  atr?: number | null,
): SuggestedOrder | null {
  const f = scored.features;
  const rejects = vetoReason ? [...scored.rejects, vetoReason] : scored.rejects;
  if (rejects.length) return null;
  const qty = sharesForBudget(f.price, sizeCny);
  if (qty < 100) {
    return null; // 一手都买不起，直接不出单
  }
  const priceRef = f.price;
  const useAtr = config.stopMode === "atr";
  const stop = stopLevel(priceRef, { mode: useAtr ? "atr" : "fixed", atr, k: config.atrK });
  const stopFixedAlt = useAtr ? stopLevel(priceRef, { mode: "fixed" }) : null;
  const amountCny = round2(priceRef * qty);
  const costCny = round2(buyCosts(amountCny).total + sellCosts(amountCny).total);
  return {
    signalId: nextId(clock.date),
    date: clock.date,
    time: clock.time,
    code: f.code,
    name: f.name,
    side: "buy",
    qty,
    priceRef,
    limitLow: round2(Math.max(tickPrice(priceRef, -2), priceRef * 0.995)),
    limitHigh: round2(Math.min(tickPrice(priceRef, 2), f.limitUp)),
    stopPrice: stop,
    stopFixedAlt,
    mustExitAt: "次日 " + hhmm(config.forceExitMin),
    amountCny,
    costCny,
    costBps: amountCny > 0 ? (costCny / amountCny) * 10_000 : 0,
    warn: minCommissionWarn(amountCny),
    reason: scored.reasons.join("；") || `因子分 ${scored.score.toFixed(2)}`,
    rejectReason: null,
    score: scored.score,
    status: "pending",
    fill: null,
    ...resting(f.price),
  };
}

/** 卖出建议单（止损 / 次日清仓 / 高开减仓）。qty 受 T+1 可卖数量限制。 */
export function makeExitOrder(
  pos: Position,
  snap: Snapshot,
  clock: Clock,
  reason: string,
  qtyWanted: number,
  score = 0,
): SuggestedOrder | null {
  const qty = Math.min(qtyWanted, pos.sellable);
  if (qty < 100 || snap.price <= 0) {
    if (pos.frozen > 0 && pos.sellable <= 0) return null; // 今日买入，T+1 卖不掉
    return null;
  }
  const priceRef = snap.price;
  const amountCny = round2(priceRef * qty);
  const costCny = sellCosts(amountCny).total;
  return {
    signalId: nextId(clock.date),
    date: clock.date,
    time: clock.time,
    code: pos.code,
    name: pos.name,
    side: "sell",
    qty,
    priceRef,
    limitLow: round2(Math.max(tickPrice(priceRef, -2), snap.limitDown)),
    limitHigh: round2(tickPrice(priceRef, 2)),
    stopPrice: null,
    mustExitAt: null,
    amountCny,
    costCny,
    costBps: amountCny > 0 ? (costCny / amountCny) * 10_000 : 0,
    warn: minCommissionWarn(amountCny),
    reason,
    rejectReason: null,
    score,
    status: "pending",
    fill: null,
    ...resting(snap.price),
  };
}

export function rejectOrder(order: SuggestedOrder, why: string): SuggestedOrder {
  return { ...order, status: "rejected", rejectReason: why };
}

/** 每轮心跳把挂单生效后的价格区间往前推一格。 */
export function updateResting(order: SuggestedOrder, snap: Snapshot): SuggestedOrder {
  if (order.status !== "pending" || !(snap.price > 0)) return order;
  order.seenLow = Math.min(order.seenLow, snap.price);
  order.seenHigh = Math.max(order.seenHigh, snap.price);
  return order;
}

/**
 * 纸面撮合。我们的建议单是“对手价 ± 2 tick”的可成交限价单，所以不是排队等成交，
 * 而是下一轮就能看到价。保守在三处：
 *  1) 成交价用**下一轮观测到的现价**加滑点，不是下单那一刻的参考价（L1 3s 一切片，这几秒里跑掉的价必须付）；
 *  2) 只用挂单之后观察到的极值（seenLow/seenHigh）判“能不能成交”，不用全天累计高低点
 *     ——全天最低价可能在挂单前很久就走掉了，拿它判成交会把每一张单都秒成；
 *  3) 价格已经跑到限价之上（买）或跌穿限价之下（卖）时，成交价被限价钳住，不拿之后的好价占便宜。
 * 一字涨停买不进、一字跌停卖不出。
 */
export function tryPaperFill(order: SuggestedOrder, snap: Snapshot, clock: Clock): Fill | null {
  if (snap.suspended) return null;
  const buy = order.side === "buy";
  if (buy && snap.oneLineUp) return null;
  if (!buy && snap.oneLineDown) return null;
  // 挂单之后的观察价有没有到过我们的限价
  if (buy ? order.seenLow > order.limitHigh : order.seenHigh < order.limitLow) return null;
  // 成交价用真实对手价：买吃卖一、卖打买一（last 只是"刚才别人成交在哪"）。
  // 盘口缺失时回退 last±1tick。无论哪条路，都被限价带钳住，不追价。
  const ask1 = snap.asks[0]?.p ?? 0;
  const bid1 = snap.bids[0]?.p ?? 0;
  const raw =
    buy ? (ask1 > 0 ? ask1 : slipFillPrice(snap.price, "buy")) : bid1 > 0 ? bid1 : slipFillPrice(snap.price, "sell");
  const px = round2(buy ? Math.min(raw, order.limitHigh) : Math.max(raw, order.limitLow));
  // 成交瞬间的盘口价差：事后审计"影子成交价够不够真实"的原始证据
  const b1 = snap.bids[0]?.p ?? 0;
  const a1 = snap.asks[0]?.p ?? 0;
  const mid = (a1 + b1) / 2;
  const spreadBps = b1 > 0 && a1 > 0 && mid > 0 ? ((a1 - b1) / mid) * 10_000 : undefined;
  return makeFill({
    code: order.code,
    name: order.name,
    side: order.side,
    price: px,
    qty: order.qty,
    date: clock.date,
    time: clock.time,
    kind: "paper",
    signalId: order.signalId,
    slippageBps: order.priceRef > 0 ? ((px - order.priceRef) / order.priceRef) * 10_000 : 0,
    spreadBps,
  });
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
