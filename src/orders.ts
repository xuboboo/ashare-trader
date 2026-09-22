/**
 * 建议单与纸面撮合。本系统不向券商下真实委托（PAPER 恒为 true 的唯一执行路径就是这里），
 * 产出的是"给你在券商 App 里手工下单的一行字"，以及影子成交用于记账与滑点统计。
 */
import { config } from "./config";
import { buyCosts, minCommissionWarn, sellCosts, slipFillPrice } from "./costs";
import { stopLevel } from "./exit";
import type { Scored } from "./factors";
import type { Level, Snapshot, TickTrade } from "./quotes";
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
  /** 兼容旧接口；当前 Jev 模式不预设固定清仓时点。 */
  mustExitAt: string | null;
  amountCny: number;
  costCny: number;
  costBps: number;
  /** 最低佣金等提醒，不影响下单，只影响你是否值得下 */
  warn: string | null;
  /** 为什么出这一单（通过项） */
  reason: string;
  /** 反事实：STOP_MODE=atr 时记录“假如 fixed 3% 的止损价”，供影子盘对照审计 */
  stopFixedAlt?: number | null;
  /** 两条止损线都记下来（同一参考价算出），才能事后比较哪种口径当时该走 */
  stopFixed?: number;
  stopAtr?: number;
  /** 为什么不出单（否决项），仅诊断用 */
  rejectReason: string | null;
  score: number;
  status: OrderStatus;
  /** 影子成交价，人工成交后由回填覆盖 */
  fill: Fill | null;
  /** 已成交的累计股数（部分成交时用）；qty 是尚未成交的余量 */
  filledQty?: number;
  /** 挂单生效后的现价区间（不含挂单前的全天历史）。L1 只有 3s 切片，这就是能做到的粒度。 */
  seenLow: number;
  seenHigh: number;
  /** 开始挂着的时刻（epoch ms），用于区分“挂单前的下影线” */
  restingSince: number;
  /** 市价连续低于卖单限价下沿的轮数（死单改价检测用，买入侧不用） */
  staleBelowRounds?: number;
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
  // 两条线都算：active 走配置选的，另一条作为反事实（对照不是事后猜的，必须在建仓那一刻就定下来）
  const stopFixed = stopLevel(priceRef, { mode: "fixed" });
  const stopAtr = atr && atr > 0 ? stopLevel(priceRef, { mode: "atr", atr, k: config.atrK }) : null;
  const stop = useAtr ? (stopAtr ?? stopFixed) : stopFixed;
  const stopFixedAlt = useAtr ? stopFixed : stopAtr;
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
    stopFixed,
    stopAtr: stopAtr ?? undefined,
    mustExitAt: null,
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

/** 卖出建议单（止损 / 高开减仓 / Jev 自主离场）。qty 受 T+1 可卖数量限制。
 *  priceHint = 模型（Jev）定的卖出限价：钳在 [现价, 涨停] 之间（模型要求挂高价等待，
 *  但不允许荒谬值，也不会低于市价 —— 那等于市价离场）；缺省用触发瞬间市价。
 *  硬规则卖出（止损/弱势）不传 hint：它们是保护性离场，按市价走，不等价格。 */
export function makeExitOrder(
  pos: Position,
  snap: Snapshot,
  clock: Clock,
  reason: string,
  qtyWanted: number,
  score = 0,
  priceHint?: number | null,
): SuggestedOrder | null {
  const qty = Math.min(qtyWanted, pos.sellable);
  if (qty < 100 || snap.price <= 0) {
    if (pos.frozen > 0 && pos.sellable <= 0) return null; // 今日买入，T+1 卖不掉
    return null;
  }
  const hintOk = priceHint != null && Number.isFinite(priceHint) && priceHint > 0;
  const priceRef = hintOk ? round2(Math.min(Math.max(priceHint, snap.price), snap.limitUp)) : snap.price;
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

/**
 * 可用资金：现金减去全部在途买单冻结的估算占用。
 *
 * 真实券商在**下单那一刻**就冻结资金（可用资金减少），不是等成交 —— 否则多张
 * 在途买单共用同一笔现金，全部成交时账户买穿（本项目真实发生过 -191.8 事故）。
 * 冻结额 = 限价参考金额 × 剩余比例 + 按比例的买入费用估算；部分成交后按剩余
 * 股数折算。成交时按实际成交额与真实费用扣款（冻结只是闸门，不是账）。
 * 撤单/作废/全成后订单离开 pending，冻结自动解除 —— 派生值，零状态、重放安全。
 */
export function availableCash(cash: number, pending: Map<string, SuggestedOrder>): number {
  let frozen = 0;
  for (const o of pending.values()) {
    if (o.side !== "buy" || o.status !== "pending" || o.amountCny <= 0) continue;
    const remaining = o.qty + (o.filledQty ?? 0);
    const estAmount = remaining > 0 ? (o.amountCny * o.qty) / remaining : o.amountCny;
    frozen += estAmount + buyCosts(estAmount).total;
  }
  return round2(cash - frozen);
}

/**
 * 死单改价：市价连续跌穿在途卖单限价下沿 rounds 轮就撤掉这张单。
 *
 * 真人不会让一张永远成交不了的委托占着卖坑 —— 本系统同一标的同时只允许一张
 * 在途卖单（防重复卖出），死单不清，止损/Jev 卖出就全部被挡住，
 * 持仓等于没有保护。撤掉之后退出阶梯同一轮就会按现价重新出单：继续阴跌就
 * 逐轮跟随下移，等价于触发止损后的市价卖出；价格回来则按新限价带正常挂。
 * 反方向（市价高于限价带）不用管：限价卖单会按带内对手价成交，真实市场同理。
 * 市价在带内或高于带内时清零计数，防 3 秒切片噪声反复触发。
 */
export function cancelStaleSells(
  pending: Map<string, SuggestedOrder>,
  snapshots: Map<string, Snapshot>,
  rounds = config.sellRepriceRounds,
): { cancelled: SuggestedOrder[]; changed: boolean } {
  if (rounds <= 0) return { cancelled: [], changed: false };
  const cancelled: SuggestedOrder[] = [];
  for (const [id, o] of [...pending]) {
    if (o.side !== "sell" || o.status !== "pending") continue;
    const sn = snapshots.get(o.code);
    if (!sn || !(sn.price > 0)) continue;
    if (sn.price >= o.limitLow) {
      o.staleBelowRounds = 0;
      continue;
    }
    o.staleBelowRounds = (o.staleBelowRounds ?? 0) + 1;
    if (o.staleBelowRounds < rounds) continue;
    o.status = "cancelled";
    o.rejectReason = `撤单改价：现价 ${sn.price} 低于限价下沿 ${o.limitLow} 连续 ${o.staleBelowRounds} 轮，撤单重挂`;
    pending.delete(id);
    cancelled.push(o);
  }
  return { cancelled, changed: cancelled.length > 0 };
}

/** 每轮心跳把挂单生效后的价格区间往前推一格。 */
export function updateResting(order: SuggestedOrder, snap: Snapshot): SuggestedOrder {
  if (order.status !== "pending" || !(snap.price > 0)) return order;
  order.seenLow = Math.min(order.seenLow, snap.price);
  order.seenHigh = Math.max(order.seenHigh, snap.price);
  return order;
}

/**
 * 可见盘口能吸收多少股，以及吃掉这些量之后的加权均价。
 *
 * L1 给五档与每档量（单位：手 = 100 股）。“按卖一全部成交”是在假设排队优先权
 * 归我们、且对手不会跑 —— 那是不存在的免费午餐。这里做两件保守的事：
 *  1) 只吃在我们限价以内的档位，按价格从优到劣逐档吃；
 *  2) 成交价 = 被吃掉档量的加权均价（不是最优档价）—— 把冲击成本真实计入。
 * 超过可见深度的部分拿不到成交 → 部分成交，余量继续挂。
 */
export function bookEating(levels: Level[], limit: number, buy: boolean): { shares: number; vwap: number | null } {
  let shares = 0;
  let notional = 0;
  for (const l of levels ?? []) {
    if (!(l.p > 0) || !(l.v > 0)) continue;
    if (buy ? l.p > limit : l.p < limit) break; // 超出我们愿意付的价：这一档及以下都不吃
    const s = l.v * 100;
    shares += s;
    notional += l.p * s;
  }
  return { shares, vwap: shares > 0 ? notional / shares : null };
}

/**
 * 纸面撮合 —— 两条路径，对应真实委托的两种命运：
 *
 *  1) **主动成交**：本轮快照里对手价还在限价内（卖单遇买一 ≥ 限价 / 买单遇卖一 ≤ 限价），
 *     真实市场里这就是立即按对手价成交 —— 吃可见档位、逐档加权、深度不足部分成交。
 *  2) **被动排队**：对手价已经离开，我们的单真实世界里在挂价队列里排队，只有挂价
 *     这个价位上**对手主动方向**的真实成交量大到轮得到我们，才成交。证据源是分笔
 *     成交（3 秒聚合的真实逐笔，fetchTickTrades）：挂价上对手主动量累计 ≥ 已成交量 +
 *     本次数量（最后排队假设 —— 排在我们前面的量不超过该价位已成交的量），按挂价成交。
 *     这解决了 L1 快照的两个盲区：价格瞬时冲过挂价又回来（快照拍不到）我们照样能
 *     按真实成交证据成交；挂价上量被排在前面的单吃掉，我们不会凭空成交。
 *
 * 分笔拉不到时退回快照口径（没有被动成交机会 —— 对手不在限价内就不成交）。
 * 整本盘口缺失（数据残缺）且无分笔时按 last±tick 兜底，受挂单后极值门保护。
 * 一字涨停买不进、一字跌停卖不出。
 */
export function tryPaperFill(order: SuggestedOrder, snap: Snapshot, clock: Clock, tape?: TickTrade[]): Fill | null {
  if (snap.suspended) return null;
  const buy = order.side === "buy";
  if (buy && snap.oneLineUp) return null;
  if (!buy && snap.oneLineDown) return null;
  const hasBook = (snap.bids?.length ?? 0) > 0 && (snap.asks?.length ?? 0) > 0;

  // ---- 主动成交：对手价在限价内，立即按对手价成交（限价卖 ≤ 买一 / 限价买 ≥ 卖一）----
  if (hasBook) {
    const eat = bookEating(buy ? snap.asks : snap.bids, buy ? order.limitHigh : order.limitLow, buy);
    if (eat.vwap !== null && eat.shares > 0) {
      // 向下取整到手：申报单位就是 100 股，不假设能拿到零股成交
      const qty = Math.min(order.qty, Math.floor(eat.shares / 100) * 100);
      if (qty >= 100) {
        const px = round2(eat.vwap); // 逐档加权已经被限价过滤，无需再钳（限价外的档根本没吃）
        return makeFill({
          code: order.code,
          name: order.name,
          side: order.side,
          price: px,
          qty,
          date: clock.date,
          time: clock.time,
          kind: "paper",
          signalId: order.signalId,
          // 建议单算好的两条止损线（fixed 与 ATR）必须跟着成交走，否则 Book 只能拿默认百分比反推，
          // 而且“哪种止损更好”这个对照永远做不了
          stopPrice: order.stopPrice ?? undefined,
          stopFixed: order.stopFixed,
          stopAtr: order.stopAtr,
          slippageBps: order.priceRef > 0 ? ((px - order.priceRef) / order.priceRef) * 10_000 : 0,
          spreadBps: spreadBpsOf(snap),
          note:
            qty < order.qty
              ? `部分成交 ${qty}/${order.qty} 股：限价内可见盘口只有 ${eat.shares} 股，余量继续挂着`
              : undefined,
        });
      }
    }
  }

  // ---- 被动排队：挂价上对手主动成交的分笔证据 ----
  const level = buy ? order.limitHigh : order.limitLow;
  const tapeQty = tapeQualifiedQty(order, tape, buy, level);
  if (tapeQty >= 100) {
    return makeFill({
      code: order.code,
      name: order.name,
      side: order.side,
      price: level,
      qty: tapeQty,
      date: clock.date,
      time: clock.time,
      kind: "paper",
      signalId: order.signalId,
      stopPrice: order.stopPrice ?? undefined,
      stopFixed: order.stopFixed,
      stopAtr: order.stopAtr,
      slippageBps: order.priceRef > 0 ? ((level - order.priceRef) / order.priceRef) * 10_000 : 0,
      spreadBps: spreadBpsOf(snap),
      note: `排队成交 ${tapeQty} 股 @ ${level}：挂价上对手主动成交 ${tapeVolume(order, tape, buy, level)} 股（最后排队假设），余量继续挂着`,
    });
  }

  // ---- 兜底：整本盘口缺失且无分笔，按 last±tick 成交（未校深度，受极值门保护）----
  if (!hasBook && !tape?.length) {
    if (buy ? order.seenLow > order.limitHigh : order.seenHigh < order.limitLow) return null;
    const px = round2(buy ? Math.min(slipFillPrice(snap.price, order.side), order.limitHigh) : Math.max(slipFillPrice(snap.price, order.side), order.limitLow));
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
      stopPrice: order.stopPrice ?? undefined,
      stopFixed: order.stopFixed,
      stopAtr: order.stopAtr,
      slippageBps: order.priceRef > 0 ? ((px - order.priceRef) / order.priceRef) * 10_000 : 0,
      note: "盘口缺失：按 last±tick 兜底成交（未校盘口深度）",
    });
  }
  return null;
}

/** 成交瞬间的盘口价差：事后审计"影子成交价够不够真实"的原始证据 */
function spreadBpsOf(snap: Snapshot): number | undefined {
  const b1 = snap.bids?.[0]?.p ?? 0;
  const a1 = snap.asks?.[0]?.p ?? 0;
  const mid = (a1 + b1) / 2;
  return b1 > 0 && a1 > 0 && mid > 0 ? ((a1 - b1) / mid) * 10_000 : undefined;
}

/**
 * 挂价上对手主动方向的累计成交量（自挂单时刻起）。
 * 卖单等**主动买**（买方吃进卖队），买单等**主动卖**（卖方砸向买队）——
 * 同价位上自己方向的主动量不消耗我们面对的队列。
 */
export function tapeVolume(order: SuggestedOrder, tape: TickTrade[] | undefined, buy: boolean, level: number): number {
  if (!tape?.length) return 0;
  const since = `${order.time}:00`;
  let vol = 0;
  for (const t of tape) {
    // 被动成交价就是挂价本身：同价同价（A 股同价位同价成交），价不同量再大也轮不到我们
    if (t.price !== level || t.time < since) continue;
    if (t.buyerAggressor === buy) continue; // 卖单(buy=false)要主动买(true)；买单要主动卖(false)
    vol += t.shares;
  }
  return vol;
}

/**
 * 排队假设下本轮能成交多少股：挂价上对手主动量 − 已成交量（含主动成交部分，
 * 它们消耗的是同一份市场流动性），向下取整到手，且不超过余量。
 */
export function tapeQualifiedQty(order: SuggestedOrder, tape: TickTrade[] | undefined, buy: boolean, level: number): number {
  if (!tape?.length) return 0;
  const vol = tapeVolume(order, tape, buy, level);
  const already = order.filledQty ?? 0;
  const fillable = Math.min(order.qty, Math.max(0, vol - already));
  return Math.floor(fillable / 100) * 100;
}

/** 一张单占住的坑：同一标的同一方向同时只允许一张在途单（否则每 60s 一轮会重复堆单）。 */
export const restingKey = (o: { code: string; side: Side }) => `${o.code}:${o.side}`;

export function restingKeys(pending: Map<string, SuggestedOrder>): Set<string> {
  return new Set([...pending.values()].map(restingKey));
}

/**
 * 把在途单跑一轮：逐出隔日单 → 推进观察价 → 尝试成交。
 *
 * 抽成纯函数是为了能被测：之前这段直接写在引擎轮次里，导致“退出单从不进
 * pending → 影子盘只买不买”这种整条链路缺失的缺陷能长期全绿潜行。
 *
 * 三条口径：
 *  1) 本轮刚建的单本轮不撮合 —— 人工下单总有秒级延迟，拿建单那一刻的卖一成交等于
 *     免掉了这段延迟（L1 3s 一片，至少付一个切片）；
 *  2) 当日单：隔日的一律作废，收盘后（dayOver）今天的也作废 ——  A 股本就是当日有效；
 *  3) 只用当日、新鲜度合格的连续竞价快照撮合（usable 由调用方算好）。
 */
export function settlePending(
  pending: Map<string, SuggestedOrder>,
  args: {
    snapshots: Map<string, Snapshot>;
    clock: Clock;
    usable: boolean;
    paper: boolean;
    roundStartMs: number;
    dayOver: boolean;
    /** 分笔成交（按代码）：被动排队的成交证据。缺该代码 = 退回快照口径（无被动成交）。 */
    tapes?: Map<string, TickTrade[]>;
  },
): { fills: Fill[]; changed: boolean } {
  const todayCompact = args.clock.date.replace(/-/g, "");
  const fills: Fill[] = [];
  let changed = false;
  for (const [id, order] of [...pending]) {
    if (order.date !== args.clock.date || args.dayOver) {
      order.status = "expired";
      pending.delete(id);
      changed = true;
      continue;
    }
    if (!args.usable) continue;
    const sn = args.snapshots.get(order.code);
    if (!sn || sn.quoteDay !== todayCompact) continue;
    if (order.restingSince >= args.roundStartMs) continue; // 本轮刚挂出去：下一轮才可能成交
    updateResting(order, sn);
    const fill = args.paper ? tryPaperFill(order, sn, args.clock, args.tapes?.get(order.code)) : null;
    if (!fill) continue;
    fills.push(fill);
    changed = true;
    // 部分成交：A 股支持成交一部分，剩下的继续挂着。
    // 旧模型假设一张单要么全部成交要么不成交，于是“盘口只有 300 股、我们买 5000”
    // 这种单子会被当成全部成交 —— 那是在拿不存在的流动性。
    if (fill.qty < order.qty) {
      order.filledQty = (order.filledQty ?? 0) + fill.qty;
      order.qty -= fill.qty;
      order.fill = fill; // 面板上看得见最近一笔；单仍留在在途队列
      continue;
    }
    order.status = "filled";
    order.fill = fill;
    order.filledQty = (order.filledQty ?? 0) + fill.qty;
    pending.delete(id);
  }
  return { fills, changed };
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
