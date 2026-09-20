/**
 * 建议单与纸面撮合。本系统不向券商下真实委托（PAPER 恒为 true 的唯一执行路径就是这里），
 * 产出的是"给你在券商 App 里手工下单的一行字"，以及影子成交用于记账与滑点统计。
 */
import { config } from "./config";
import { buyCosts, minCommissionWarn, sellCosts, slipFillPrice } from "./costs";
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
  /** 为什么不出单（否决项），仅诊断用 */
  rejectReason: string | null;
  score: number;
  status: OrderStatus;
  /** 影子成交价，人工成交后由回填覆盖 */
  fill: Fill | null;
}

export interface Clock {
  date: string;
  time: string;
}

let seq = 0;
const nextId = (date: string) => `S${date.replace(/-/g, "")}-${(++seq).toString().padStart(4, "0")}`;

/** 尾盘开仓建议单。不可买（买不起一手 / 全否决）时返回 null。 */
export function makeBuyOrder(scored: Scored, clock: Clock, vetoReason?: string): SuggestedOrder | null {
  const f = scored.features;
  const rejects = vetoReason ? [...scored.rejects, vetoReason] : scored.rejects;
  if (rejects.length) return null;
  const qty = sharesForBudget(f.price, config.sizeCny);
  if (qty < 100) {
    return null; // 一手都买不起，直接不出单
  }
  const priceRef = f.price;
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
    stopPrice: round2(priceRef * (1 - config.stopLossPct / 100)),
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
  };
}

export function rejectOrder(order: SuggestedOrder, why: string): SuggestedOrder {
  return { ...order, status: "rejected", rejectReason: why };
}

/**
 * 纸面撮合：限价单被真实价格穿过才成交，并吃一个滑点。
 * 一字涨停买不进、一字跌停卖不出，与实盘一致。
 */
export function tryPaperFill(order: SuggestedOrder, snap: Snapshot, clock: Clock): Fill | null {
  if (snap.suspended) return null;
  if (order.side === "buy") {
    if (snap.oneLineUp || snap.high === snap.limitUp && snap.low === snap.limitUp) return null;
    if (snap.low > order.limitHigh) return null;
    const px = round2(Math.min(order.limitHigh, Math.max(slipFillPrice(order.priceRef, "buy"), snap.low)));
    return makeFill({
      code: order.code,
      name: order.name,
      side: "buy",
      price: px,
      qty: order.qty,
      date: clock.date,
      time: clock.time,
      kind: "paper",
      signalId: order.signalId,
      slippageBps: order.priceRef > 0 ? ((px - order.priceRef) / order.priceRef) * 10_000 : 0,
    });
  }
  if (snap.oneLineDown) return null;
  if (snap.high < order.limitLow) return null;
  const px = round2(Math.max(order.limitLow, Math.min(slipFillPrice(order.priceRef, "sell"), snap.high)));
  return makeFill({
    code: order.code,
    name: order.name,
    side: "sell",
    price: px,
    qty: order.qty,
    date: clock.date,
    time: clock.time,
    kind: "paper",
    signalId: order.signalId,
    slippageBps: order.priceRef > 0 ? ((px - order.priceRef) / order.priceRef) * 10_000 : 0,
  });
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
