/**
 * 引擎：一次只有一个在途轮次（沿用 jev-trader 的范式），迟到就什么都不做。
 *
 * 节奏不是"每 300ms 一单"，而是 A 股能落地的三个触发点：
 *   09:05 盘前扫描（LLM 情绪闸门 + 事件 veto）
 *   09:30-10:00 持仓退出（高开减半 / 止损 / 到点无条件清仓）
 *   14:40-14:57 尾盘选股（因子打分 + 大盘闸门 -> 建议单）
 * 其余时段只做行情心跳、影子撮合与净值标记。
 */
import { config } from "./config";
import { TradingCalendar } from "./calendar";
import { featuresFromSnapshot, ma5CloseBefore, marketGate, scoreStock, type Gate, type Scored } from "./factors";
import { createModel, type Decision, type DailyBias, LlmAdvisory } from "./model";
import { makeBuyOrder, makeExitOrder, tryPaperFill, type Clock, type SuggestedOrder } from "./orders";
import { fetchIndexDaily, fetchIndex, fetchZtPool, fetchSnapshots, type DailyBar, type Snapshot } from "./quotes";
import { bj, canTrade, hhmmOf, liveQuotes, phaseOf, type Phase, sessionNow } from "./session";
import { Book, makeFill, round2, type Fill } from "./state";
import { Universe } from "./universe";

/** 决策用的一刻：日期、时间、当日分钟数 */
export type EngineClock = Clock & { minutes: number };

export interface PositionView {
  code: string;
  name: string;
  qty: number;
  sellable: number;
  frozen: number;
  avgPrice: number;
  lastPrice: number;
  stopPrice: number;
  openDate: string;
  unrealized: number;
  unrealizedPct: number;
}

export interface TickEvent {
  seq: number;
  ts: number;
  date: string;
  time: string;
  phase: Phase;
  tradingDay: boolean;
  /** 本轮的触发点说明 */
  trigger: string;
  index: { price: number; pct: number; amountYi: number; ma5: number | null };
  gate: Gate;
  bias: { emotionScore: number; allowOpen: boolean; reason: string; vetoes: number; llmFailed: boolean; enabled: boolean } | null;
  universe: number;
  quotes: { ok: number; fails: number; stale: boolean; eodOnly: boolean; quoteDay: string };
  scan: { scored: number; rejected: number; top: { code: string; name: string; score: number; gainPct: number; volumeRatio: number; priceVsVwapBps: number; reasons: string[] }[] };
  decision: Decision | null;
  orders: SuggestedOrder[];
  fills: Fill[];
  positions: PositionView[];
  totals: ReturnType<Book["totals"]>;
  note?: string;
}

export interface EngineOpts {
  /** 注入历史日线时用（回测/盘前算 MA5），实盘只算指数 */
  quiet?: boolean;
}

export class Engine {
  readonly book = new Book();
  readonly universe = new Universe();
  readonly calendar = new TradingCalendar();
  private model = createModel();
  private advisory = new LlmAdvisory();

  private history: TickEvent[] = [];
  private listeners = new Set<(e: TickEvent) => void>();
  private seq = 0;
  private inFlight = false;
  private stopped = false;

  private snapshots = new Map<string, Snapshot>();
  private quoteFails = 0;
  private stale = true;
  private eodOnly = config.eodOnly;
  private pending = new Map<string, SuggestedOrder>();
  private ordersToday: SuggestedOrder[] = [];
  private indexMa5: number | null = null;
  private indexBars: DailyBar[] = [];
  private bias: DailyBias | null = null;
  private biasDate = "";
  private zt = { count: 0, maxLianBan: 0, industries: new Map<string, number>() };
  private opts: EngineOpts;

  constructor(opts: EngineOpts = {}) {
    this.opts = opts;
  }

  attach(e: TickEvent) {
    this.history.push(e);
    if (this.history.length > config.historySize) this.history.shift();
    for (const l of this.listeners) l(e);
    if (!this.opts.quiet) this.log(e);
  }

  private log(e: TickEvent) {
    const picks = e.decision?.picks.map((p) => `${p.name}(${p.code})`).join(" ") || "-";
    const pnl = e.totals.pnlCny.toFixed(0);
    console.log(
      `#${e.seq} ${e.date} ${e.time} ${e.phase} 上证${e.index.price.toFixed(2)}(${e.index.pct.toFixed(2)}%) ` +
        `闸门${e.gate.allowed ? "开" : "关"} 池${e.universe} 快照${e.quotes.ok} ` +
        `出单${e.orders.length} 成交${e.fills.length} 持仓${e.totals.positions} 浮亏盈${pnl} ${e.trigger}` +
        (picks !== "-" ? ` | ${picks}` : "") +
        (e.note ? ` | ${e.note}` : ""),
    );
  }

  subscribe(l: (e: TickEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getHistory(): TickEvent[] {
    return this.history;
  }

  latestSnapshot(code: string): Snapshot | undefined {
    return this.snapshots.get(code);
  }

  get pendingOrders(): SuggestedOrder[] {
    return [...this.pending.values()];
  }

  get startedAt() {
    return this.startedAtMs;
  }

  private startedAtMs = Date.now();

  async init(): Promise<void> {
    await this.book.load();
    await this.calendar.refresh();
    const today = bj().ymd;
    this.book.rollover(today);
    await this.universe.get(today);
    try {
      this.indexBars = await fetchIndexDaily(40); // 上证指数日线，算闸门用的 MA5
    } catch {
      this.indexBars = [];
    }
  }

  /** 主循环：交易时段密集，非交易时段每 60s 心跳一次（不拉 300 支快照，省额度）。 */
  async run(): Promise<void> {
    while (!this.stopped) {
      const t0 = performance.now();
      try {
        await this.round();
      } catch (e) {
        console.error(`[engine] 轮次异常: ${(e as Error).message}`);
      }
      const { ymd, minutes } = bj();
      const trading = this.calendar.isTradingDay(ymd);
      const phase = phaseOf(ymd, minutes, trading);
      const busy = trading && (canTrade(phase) || phase === "pre-open");
      const elapsed = performance.now() - t0;
      await Bun.sleep(Math.max(200, (busy ? config.pollMs : 60_000) - elapsed));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** 一轮：拉行情 -> 算因子 -> 按调度点出单 -> 影子撮合 -> 发事件。 */
  async round(forceTrigger?: string): Promise<TickEvent> {
    if (this.inFlight) {
      // 单在途：迟到即 hold，绝不并发打接口
      const last = this.history[this.history.length - 1];
      if (last) return last;
    }
    this.inFlight = true;
    const clock = clockNow();
    try {
      return await this.roundInner(clock, forceTrigger);
    } finally {
      this.inFlight = false;
    }
  }

  private async roundInner(clock: EngineClock, forceTrigger?: string): Promise<TickEvent> {
    const trading = this.calendar.isTradingDay(clock.date);
    const phase = phaseOf(clock.date, clock.minutes, trading);
    this.book.rollover(clock.date);

    // ---- 行情 ----
    const t0 = performance.now();
    let index: { price: number; pct: number; amountYi: number; quoteDay?: string } = { price: 0, pct: 0, amountYi: 0 };
    try {
      const ix = await fetchIndex();
      index = { price: ix.price, pct: ix.pct, amountYi: ix.amountYi, quoteDay: ix.snapshot.quoteDay };
    } catch (e) {
      console.error(`[engine] 指数快照失败: ${(e as Error).message}`);
    }
    let ok = 0;
    const codes = [...this.universe.codes(), ...[...this.book.positions.keys()]];
    if (trading && canTrade(phase) && !this.eodOnly) {
      try {
        this.snapshots = await fetchSnapshots(codes);
        ok = this.snapshots.size;
        this.quoteFails = 0;
        this.stale = false;
      } catch (e) {
        this.quoteFails++;
        if (this.quoteFails >= 3) this.eodOnly = true;
        console.error(`[engine] 批量快照失败(${this.quoteFails}): ${(e as Error).message}`);
      }
    } else {
      // 非连续竞价时段：只拉池内前 60 支（一次请求），让仪表盘与盘前复盘有东西看，不白耗额度
      if (!this.snapshots.size && codes.length) {
        try {
          this.snapshots = await fetchSnapshots(codes.slice(0, 60));
        } catch {
          /* 收盘后拉不到就算了，不影响心跳 */
        }
      }
      ok = this.snapshots.size;
    }

    // ---- 大盘闸门 ----
    this.indexMa5 = this.indexBars.length >= 5 ? (ma5CloseBefore(this.indexBars, clock.date) ?? null) : this.indexMa5;
    if (!this.indexBars.length) {
      try {
        this.indexBars = await fetchIndexDaily(40);
      } catch {
        /* 闸门退化处理：没有 MA5 就不因它否决 */
      }
    }
    const gate = marketGate({ price: index.price, amountYi: index.amountYi }, this.indexMa5, trading ? this.zt.count || null : null);

    // ---- 选股打分 ----
    const scored: Scored[] = [];
    for (const sn of this.snapshots.values()) {
      if (!this.universe.entries.some((e) => e.code === sn.code)) continue;
      scored.push(scoreStock(featuresFromSnapshot(sn, clock.date)));
    }
    const rejected = scored.filter((s) => s.rejects.length > 0).length;
    const top = [...scored]
      .filter((s) => s.rejects.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((s) => ({
        code: s.features.code,
        name: s.features.name,
        score: round2(s.score),
        gainPct: round2(s.features.gainPct),
        volumeRatio: round2(s.features.volumeRatio),
        priceVsVwapBps: Math.round(s.features.priceVsVwapBps),
        reasons: s.reasons,
      }));

    // ---- 决策与出单 ----
    const trigger = forceTrigger ?? triggerOf(phase, clock.minutes);
    const force = forceTrigger === "force-scan";
    const newOrders: SuggestedOrder[] = [];
    let decision: Decision | null = null;

    // force-scan 允许在收盘后跑：拿最近一个交易日的快照做复盘，看今天到底会出什么单
    if (force || (trading && canTrade(phase))) {
      if ((trigger === "盘前" || force) && this.biasDate !== clock.date) await this.refreshBias(clock, index);
      if ((trigger === "尾盘选股" || force) && scored.length) {
        decision = await this.decide(clock, scored, gate, "buy");
        for (const pick of decision?.picks ?? []) {
          const s = scored.find((x) => x.features.code === pick.code);
          if (!s) continue;
          const vetoReason = this.bias?.vetoes[s.features.code];
          const order = makeBuyOrder(s, clock, vetoReason);
          if (order) {
            newOrders.push(order);
            this.pending.set(order.signalId, order);
          }
        }
      } else if (trigger === "退出窗口" && liveQuotes(phase)) {
        decision = await this.decide(clock, scored, gate, "manage");
        newOrders.push(...this.exitOrders(clock));
      }
    }

    // ---- 影子撮合 + 净值 ----
    // 只用当日连续竞价/竞价时段的快照撮合，避免拿昨日收盘数据伪造成交
    const fills: Fill[] = [];
    const todayCompact = clock.date.replace(/-/g, "");
    const fillable = trading && canTrade(phase);
    for (const [id, order] of [...this.pending]) {
      const sn = this.snapshots.get(order.code);
      if (!sn || !fillable || sn.quoteDay !== todayCompact) continue;
      const fill = config.paper ? tryPaperFill(order, sn, clock) : null;
      if (fill) {
        this.book.applyFill(fill);
        await this.book.appendFill(fill);
        order.status = "filled";
        order.fill = fill;
        this.pending.delete(id);
        fills.push(fill);
      }
    }
    if (phase === "after-hours" || phase === "closed") {
      for (const [id, order] of [...this.pending]) {
        if (order.date !== clock.date) {
          order.status = "expired";
          this.pending.delete(id);
        }
      }
    }
    this.book.markToMarket(new Map([...this.snapshots].map(([c, s]) => [c, s.price])));

    for (const o of newOrders) this.ordersToday.push(o);
    const event: TickEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      date: clock.date,
      time: clock.time,
      phase,
      tradingDay: trading,
      trigger,
      index: { price: index.price, pct: index.pct, amountYi: index.amountYi, ma5: this.indexMa5 },
      gate,
      bias: this.bias
        ? {
            emotionScore: this.bias.emotionScore,
            allowOpen: this.bias.allowOpen,
            reason: this.bias.reason,
            vetoes: Object.keys(this.bias.vetoes).length,
            llmFailed: this.bias.llmFailed,
            enabled: this.bias.enabled,
          }
        : null,
      universe: this.universe.entries.length,
      quotes: {
        ok,
        fails: this.quoteFails,
        stale: this.stale,
        eodOnly: this.eodOnly,
        quoteDay: [...this.snapshots.values()][0]?.quoteDay ?? index.quoteDay ?? "",
      },
      scan: { scored: scored.length, rejected, top },
      decision,
      orders: newOrders,
      fills,
      positions: this.positionView(),
      totals: this.book.totals(),
      note: this.note(trading, phase, ok, performance.now() - t0),
    };
    this.attach(event);
    return event;
  }

  private async decide(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "manage"): Promise<Decision> {
    const held = [...this.book.positions.values()];
    const buysToday = this.book.openDateCount(clock.date);
    const openSlots = Math.max(0, config.maxDailyOpens - buysToday);
    return this.model.decide({
      date: clock.date,
      time: clock.time,
      horizon: mode === "buy" ? "尾盘买入、次日 10:00 前清仓" : "持仓退出",
      gate,
      candidates: scored,
      heldCodes: held.map((p) => p.code),
      allowed: {
        buy: mode === "buy" && gate.allowed && (this.bias?.allowOpen ?? true) && openSlots > 0,
        sell: held.some((p) => p.sellable > 0),
      },
      vetoes: this.bias?.vetoes ?? {},
      openSlots: Math.min(openSlots, config.k - held.length),
    });
  }

  /** 持仓退出建议单：次日到点清仓优先，其次高开减半，最后止损。 */
  private exitOrders(clock: EngineClock): SuggestedOrder[] {
    const out: SuggestedOrder[] = [];
    for (const p of this.book.positions.values()) {
      if (p.sellable <= 0) continue;
      const sn = this.snapshots.get(p.code);
      if (!sn) continue;
      const gapPct = ((sn.price - p.lastPrice) / p.lastPrice) * 100;
      let order: SuggestedOrder | null = null;
      if (clock.minutes >= config.forceExitMin) {
        order = makeExitOrder(p, sn, clock, `到点 ${hhmmOf(config.forceExitMin)} 无条件清仓（T+1 次日必须走）`, p.sellable);
      } else if (gapPct >= config.gapTrimPct) {
        const half = Math.floor(p.sellable / 2 / 100) * 100;
        if (half >= 100) order = makeExitOrder(p, sn, clock, `高开 ${gapPct.toFixed(2)}% ≥ ${config.gapTrimPct}%，先卖一半`, half);
      } else if (sn.price <= p.stopPrice) {
        order = makeExitOrder(p, sn, clock, `跌破止损 ${p.stopPrice}`, p.sellable);
      } else if (sn.vwap && sn.price < sn.vwap && clock.minutes >= config.session.morningStart + 15) {
        order = makeExitOrder(p, sn, clock, "跌破分时均线，弱势离场", p.sellable);
      }
      if (order) out.push(order);
    }
    return out;
  }

  private async refreshBias(clock: EngineClock, index: { price: number; pct: number; amountYi: number }): Promise<void> {
    try {
      const pool = await fetchZtPool(clock.date.replace(/-/g, ""));
      this.zt.count = pool.length;
      this.zt.maxLianBan = pool.reduce((m, p) => Math.max(m, p.lianBan), 0);
      this.zt.industries = new Map();
      for (const p of pool) this.zt.industries.set(p.industry, (this.zt.industries.get(p.industry) ?? 0) + 1);
    } catch (e) {
      console.error(`[engine] 涨停池失败: ${(e as Error).message}`);
    }
    this.bias = await this.advisory.dailyBias({
      date: clock.date,
      index: { price: index.price, pct: index.pct, amountYi: index.amountYi },
      ztCount: this.zt.count,
      maxLianBan: this.zt.maxLianBan,
      topCandidates: [],
      headlines: [],
    });
    this.biasDate = clock.date;
  }

  /** 手工回填一笔真实成交（也可用 scripts/fill.ts）。 */
  async recordManualFill(args: {
    code: string;
    side: "buy" | "sell";
    qty: number;
    price?: number;
    signalId?: string;
    date?: string;
    time?: string;
    note?: string;
  }): Promise<Fill> {
    const clock = clockNow();
    const sn = this.snapshots.get(args.code);
    const name = sn?.name ?? this.universe.nameOf(args.code);
    const price = args.price ?? sn?.price ?? 0;
    if (!(price > 0)) throw new Error(`不知道 ${args.code} 的价格，请显式给 price`);
    const fill = makeFill({
      code: args.code,
      name,
      side: args.side,
      price,
      qty: args.qty,
      date: args.date ?? clock.date,
      time: args.time ?? clock.time,
      kind: "manual",
      signalId: args.signalId,
      slippageBps: sn && sn.price > 0 ? ((price - sn.price) / sn.price) * 10_000 : undefined,
      note: args.note ?? "人工回填",
    });
    if (args.signalId) {
      const o = this.pending.get(args.signalId);
      if (o) {
        o.status = "filled";
        o.fill = fill;
        this.pending.delete(args.signalId);
      }
    }
    this.book.applyFill(fill);
    await this.book.appendFill(fill);
    await this.book.save();
    this.attach(await this.round("已回填成交"));
    return fill;
  }

  positionView(): PositionView[] {
    return [...this.book.positions.values()].map((p) => ({
      code: p.code,
      name: p.name,
      qty: p.qty,
      sellable: p.sellable,
      frozen: p.frozen,
      avgPrice: round2(p.avgPrice),
      lastPrice: p.lastPrice,
      stopPrice: p.stopPrice,
      openDate: p.openDate,
      unrealized: round2((p.lastPrice - p.avgPrice) * p.qty),
      unrealizedPct: p.avgPrice > 0 ? round2(((p.lastPrice - p.avgPrice) / p.avgPrice) * 100) : 0,
    }));
  }

  async persist(): Promise<void> {
    this.book.recordEquity(clockNow().date);
    await this.book.save();
  }

  meta() {
    return {
      name: "ashare-trader",
      model: this.model.name,
      llm: this.advisory.enabled ? config.llmModel : "off",
      paper: config.paper,
      universe: this.universe.entries.length,
      universeDate: this.universe.date,
      calendarStale: this.calendar.stale,
      eodOnly: this.eodOnly,
      startedAt: this.startedAtMs,
      port: config.port,
    };
  }

  private note(trading: boolean, phase: Phase, quotes: number, ms: number): string {
    if (!trading) return `非交易日（${phase}），数据为最近收盘快照 ${Math.round(ms)}ms`;
    if (this.eodOnly) return "实时链路降级：只用日频，盘前出一次信号";
    if (phase === "lunch") return "午休";
    if (quotes === 0 && canTrade(phase)) return "还没有可用快照";
    return `${Math.round(ms)}ms`;
  }
}

function triggerOf(phase: Phase, minutes: number): string {
  if (phase === "pre-open") return minutes >= config.session.premarketMin ? "盘前" : "盘前等待";
  if (!canTrade(phase)) return phase === "lunch" ? "午休" : "心跳";
  if (minutes < config.session.morningStart + 30) return "退出窗口";
  if (minutes >= config.session.tailStart) return "尾盘选股";
  return "盘中心跳";
}

export function clockNow(d: Date = new Date()): EngineClock {
  const b = bj(d);
  return { date: b.ymd, time: `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`, minutes: b.minutes };
}

export { sessionNow };
