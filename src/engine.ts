/**
 * 引擎：一次只有一个在途轮次，上一轮没跑完就直接复用上一次结果，绝不并发打接口。
 *
 * 节奏是 A 股能落地的三个触发点（不做盘中高频）：
 *   09:05 盘前扫描（LLM 情绪闸门 + 事件 veto）
 *   09:30-10:00 持仓退出（高开减半 / 止损 / 到点无条件清仓）
 *   14:40-14:57 尾盘选股（因子打分 + 大盘闸门 -> 建议单）
 * 其余时段只做行情心跳、影子撮合与净值标记。
 */
import { config } from "./config";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { TradingCalendar } from "./calendar";
import { featuresFromSnapshot, ma5CloseBefore, marketGate, scoreStock, type Gate, type Scored } from "./factors";
import { FactorModel, type Decision, type DailyBias, type Model, LlmAdvisory } from "./model";
import { JevModel } from "./jev";
import { LocalModel } from "./local";
import { makeBuyOrder, makeExitOrder, tryPaperFill, updateResting, type Clock, type SuggestedOrder } from "./orders";
import { fetchIndexDaily, fetchIndex, fetchZtPool, fetchSnapshots, quoteAgeSec, type DailyBar, type Snapshot } from "./quotes";
import { riskBrake, type RiskBrake } from "./risk";
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
  quotes: { ok: number; fails: number; stale: boolean; eodOnly: boolean; quoteDay: string; ageSec: number };
  scan: { scored: number; rejected: number; top: { code: string; name: string; score: number; gainPct: number; volumeRatio: number; priceVsVwapBps: number; reasons: string[] }[] };
  decision: Decision | null;
  /** 组合级风控闸（日亏损/回撤），只在调用过 decide 的轮次有值 */
  risk: RiskBrake | null;
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
  /** 可以被清空重建，所以不是 readonly */
  book = new Book();
  readonly universe = new Universe();
  readonly calendar = new TradingCalendar();
  private model: Model =
    config.model === "jev" ? new JevModel() : config.model === "local" ? new LocalModel() : new FactorModel();
  private advisory = new LlmAdvisory();

  private history: TickEvent[] = [];
  private listeners = new Set<(e: TickEvent) => void>();
  private seq = 0;
  /** 在途轮次的 promise；null = 空闲。round() 靠它串行化。 */
  private inFlight: Promise<TickEvent> | null = null;
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
  /** 本轮的大盘上下文，传给决策模型的 state 用 */
  private lastIndex: { price: number; pct: number; amountYi: number; ma5: number | null } | null = null;
  /** 盘前预选已做过的交易日（每日一次） */
  private preBuyDate = "";
  /** 上一次盘中买入决策时刻（epoch ms），配合 DECIDE_EVERY_MS 控制节奏 */
  private lastBuyMs = 0;
  /** 上一次 eodOnly 恢复探测时刻 */
  private lastEodProbeMs = 0;
  /** 最近一次风控闸判定（挂到事件上，面板可见） */
  private lastRisk: RiskBrake | null = null;
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
    await this.loadPending(today);
    await this.universe.get(today);
    try {
      this.indexBars = await fetchIndexDaily(40); // 上证指数日线，算闸门用的 MA5
    } catch {
      this.indexBars = [];
    }
  }

  /**
   * 建议单持久化：pending Map 只活在内存，重启会把当天未成交的建议单丢掉。
   * 只恢复"今天 + pending"的单（隔日单按规则本就该过期）。
   */
  private pendingFile(): string {
    return join(config.dataDir, "pending.json");
  }

  private async loadPending(today: string): Promise<void> {
    try {
      const j = await Bun.file(this.pendingFile()).json();
      for (const o of (j?.orders ?? []) as SuggestedOrder[]) {
        if (o.status === "pending" && o.date === today && !this.pending.has(o.signalId)) {
          this.pending.set(o.signalId, o);
        }
      }
      if (this.pending.size) console.log(`[engine] 恢复了 ${this.pending.size} 张重启前的在途建议单`);
    } catch {
      /* 没有 pending.json：首次运行 */
    }
  }

  private async persistPending(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await Bun.write(
      this.pendingFile(),
      JSON.stringify({ savedAt: Date.now(), orders: [...this.pending.values()] }, null, 1),
    );
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

  /** 一轮：拉行情 -> 算因子 -> 按调度点出单 -> 影子撮合 -> 发事件。
   *  单在途：上一轮没跑完就等它结束，再排自己的一轮，绝不并发打接口；
   *  也绝不把上一轮的旧事件当本轮结果返回 —— 否则 /scan 会拿到 decision 为空的心跳，
   *  降级（modelFailed）这类信息就"看不见"了。 */
  async round(forceTrigger?: string): Promise<TickEvent> {
    while (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* 上一轮失败也照常排自己 */
      }
    }
    this.inFlight = this.roundInner(clockNow(), forceTrigger);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async roundInner(clock: EngineClock, forceTrigger?: string): Promise<TickEvent> {
    const trading = this.calendar.isTradingDay(clock.date);
    const phase = phaseOf(clock.date, clock.minutes, trading);
    // 日切：刷新交易日历与指数日线 —— 今天的日线盘后才生成，"今天是交易日"靠投射；
    // 指数 MA5 的窗口也必须每天跟进，长跑才不会拿一周前的旧数据算闸门
    if (this.book.rollover(clock.date)) {
      void this.calendar.refresh();
      try {
        this.indexBars = await fetchIndexDaily(40);
      } catch {
        /* 保留旧日线，闸门退化处理 */
      }
    }

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
      // 降级自恢复：eodOnly 不是单行道。每隔 EOD_RECOVER_MS 用小批量探测一次实时链路，
      // 成功就恢复实时（整段拉全池），失败的行情源不该把系统永远锁在日频模式。
      if (trading && canTrade(phase) && this.eodOnly && Date.now() - this.lastEodProbeMs >= config.eodRecoverMs) {
        this.lastEodProbeMs = Date.now();
        try {
          const probe = await fetchSnapshots(codes.slice(0, 30));
          if (probe.size > 0) {
            this.snapshots = probe;
            ok = probe.size;
            this.eodOnly = false;
            this.quoteFails = 0;
            this.stale = false;
            console.log(`[engine] 实时链路恢复（探测 ${probe.size} 支），退出日频降级`);
          }
        } catch {
          /* 探测失败：继续降级，下个周期再试 */
        }
      }
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

    // ---- 行情新鲜度 ----
    // L1 本身 3 秒一个切片；超过 QUOTE_STALE_SEC 没更新就是源真断了，不能拿它出单/判成交。
    const ageSec = Math.round(quoteAgeSec(this.snapshots.values()));
    const quotesFresh = ageSec >= 0 && ageSec <= config.quoteStaleSec;
    /** 这一轮的行情能不能拿来做决策与撮合 */
    const usable = trading && canTrade(phase) && ok > 0 && quotesFresh;

    // ---- 大盘闸门 ----
    this.indexMa5 = this.indexBars.length >= 5 ? (ma5CloseBefore(this.indexBars, clock.date) ?? null) : this.indexMa5;
    if (!this.indexBars.length) {
      try {
        this.indexBars = await fetchIndexDaily(40);
      } catch {
        /* 闸门退化处理：没有 MA5 就不因它否决 */
      }
    }
    const gate = marketGate(
      { price: index.price, amountYi: index.amountYi },
      this.indexMa5,
      trading ? this.zt.count || null : null,
      phase === "continuous" ? (clock.minutes >= config.session.afternoonStart ? clock.minutes - config.session.afternoonStart : clock.minutes - config.session.morningStart) : null,
    );
    this.lastIndex = { price: index.price, pct: index.pct, amountYi: index.amountYi, ma5: this.indexMa5 };

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
    // 交易时段全程决策（不再只限尾盘）：
    //   盘前 09:05 起每日一次预选（用最近收盘快照，只出观点不下单）；
    //   连续竞价全程按 DECIDE_EVERY_MS 节奏做买入决策并出建议单；
    //   退出管理只要持仓可卖、行情可用就每轮评估（纯规则，不花模型调用）。
    const trigger = forceTrigger ?? triggerOf(phase, clock.minutes);
    const force = forceTrigger === "force-scan";
    const newOrders: SuggestedOrder[] = [];
    let decision: Decision | null = null;

    if (force || trading) {
      if ((trading || force) && clock.minutes >= config.session.premarketMin && this.biasDate !== clock.date) {
        await this.refreshBias(clock, index);
      }

      const hasSellable = [...this.book.positions.values()].some((p) => p.sellable > 0);
      if (trading && liveQuotes(phase) && usable && hasSellable) {
        newOrders.push(...this.exitOrders(clock));
      }

      const nowMs = Date.now();
      if (
        buyDecisionDue({
          force,
          trading,
          liveNow: liveQuotes(phase),
          usable,
          scoredCount: scored.length,
          minutes: clock.minutes,
          preBuyDone: this.preBuyDate === clock.date,
          lastBuyMs: this.lastBuyMs,
          nowMs,
        })
      ) {
        decision = await this.decide(clock, scored, gate, "buy");
        const preMarket = clock.minutes >= config.session.premarketMin && clock.minutes < config.session.morningStart;
        if (trading && preMarket) this.preBuyDate = clock.date;
        else this.lastBuyMs = nowMs;

        // 盘前预选只出观点；连续竞价与 force（复盘）出建议单
        if (force || (trading && liveQuotes(phase) && usable)) {
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
          if (newOrders.length) await this.persistPending();
        }
      }
    }

    // ---- 影子撮合 + 净值 ----
    // 只用当日、且新鲜度合格的连续竞价快照撮合；挂单后的极值由 updateResting 逐轮累加
    const fills: Fill[] = [];
    const todayCompact = clock.date.replace(/-/g, "");
    const fillable = usable;
    for (const [id, order] of [...this.pending]) {
      const sn = this.snapshots.get(order.code);
      if (!sn || !fillable || sn.quoteDay !== todayCompact) continue;
      updateResting(order, sn);
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
    if (fills.length) await this.persistPending();
    if (phase === "after-hours" || phase === "closed") {
      let expired = 0;
      for (const [id, order] of [...this.pending]) {
        if (order.date !== clock.date) {
          order.status = "expired";
          this.pending.delete(id);
          expired++;
        }
      }
      if (expired) await this.persistPending();
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
        stale: (trading && canTrade(phase) && !quotesFresh) || (trading && canTrade(phase) && ok === 0),
        eodOnly: this.eodOnly,
        quoteDay: [...this.snapshots.values()][0]?.quoteDay ?? index.quoteDay ?? "",
        ageSec,
      },
      scan: { scored: scored.length, rejected, top },
      decision,
      risk: this.lastRisk,
      orders: newOrders,
      fills,
      positions: this.positionView(),
      totals: this.book.totals(),
      note: this.note(trading, phase, ok, performance.now() - t0, ageSec, quotesFresh),
    };
    this.attach(event);
    return event;
  }

  private async decide(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "manage"): Promise<Decision> {
    const held = [...this.book.positions.values()];
    const buysToday = this.book.openDateCount(clock.date);
    const openSlots = Math.max(0, config.maxDailyOpens - buysToday);
    // 组合级风控闸：只封新开仓，不封退出（止损/清仓在亏损状态也必须走得掉）
    const totals = this.book.totals();
    this.lastRisk = riskBrake({
      equity: totals.equity,
      dayStartEquity: this.book.dayStartEquity,
      peakEquity: this.book.peakEquity,
      dayLossLimitPct: config.maxDayLossPct,
      drawdownLimitPct: config.maxDrawdownPct,
    });
    const buyAllowed =
      mode === "buy" && gate.allowed && (this.bias?.allowOpen ?? true) && openSlots > 0 && !this.lastRisk.buyBlocked;
    return this.model.decide({
      date: clock.date,
      time: clock.time,
      horizon: mode === "buy" ? "尾盘买入、次日 10:00 前清仓" : "持仓退出",
      gate,
      index: this.lastIndex,
      candidates: scored,
      heldCodes: held.map((p) => p.code),
      allowed: {
        buy: buyAllowed,
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
        await this.persistPending();
      }
    }
    this.book.applyFill(fill);
    await this.book.appendFill(fill);
    await this.book.save();
    // round() 自己会把心跳 attach 到历史与 SSE，这里再 attach 一次就是重复播报
    await this.round("已回填成交");
    return fill;
  }

  /** 成交流水（最新的在后），给仪表盘的“成交与账本”区用 */
  fillLog(limit = 50): Fill[] {
    return this.book.fills.slice(-limit);
  }

  /**
   * 撤销一笔成交（误回填、或想清掉一个不存在的持仓）。重放剩下的成交重建账本，
   * 所以现金/可卖/冻结/已实现盈亏始终自洽；原流水归档到 data/voids.log，不隐式硬删。
   */
  async removeFill(id: string): Promise<Fill | null> {
    const idx = this.book.fills.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    const removed = this.book.fills[idx]!;
    const rest = this.book.fills.filter((_, i) => i !== idx);
    this.book.rebuild(rest);
    await this.book.rewriteTrades();
    await this.book.save();
    await this.appendVoid(`撤销 ${removed.id} :: ${JSON.stringify(removed)}`);
    await this.round(`已撤销成交 ${removed.code} ${removed.side} ${removed.qty}@${removed.price}`);
    return removed;
  }

  /**
   * 清空账本：先把 trades.jsonl / positions.json 归档到 data/archive/<时间戳>/，
   * 再重建一个空账本（现金回到参考本金）。归档不是可选项 —— 留痕迹比删干净重要。
   */
  async clearBook(): Promise<{ removed: number; archived: string | null }> {
    const removed = this.book.fills.length;
    const files = [join(config.dataDir, "trades.jsonl"), join(config.dataDir, "positions.json")];
    const exists = await Promise.all(files.map((f) => Bun.file(f).exists()));
    const present = files.filter((_, i) => exists[i]);
    let archived: string | null = null;
    if (present.length) {
      const stamp = clockNow().date.replace(/-/g, "") + "-" + String(Date.now());
      const dir = join(config.dataDir, "archive", stamp);
      await mkdir(dir, { recursive: true });
      for (const f of present) await Bun.write(join(dir, basename(f)), await Bun.file(f).arrayBuffer());
      archived = dir;
    }
    this.book = new Book(config.bankrollCny);
    this.book.rollover(clockNow().date);
    this.pending.clear();
    await this.book.rewriteTrades();
    await this.book.save();
    await this.persistPending();
    await this.appendVoid(`清空账本 ${removed} 笔成交${archived ? `，已归档到 ${archived}` : ""}`);
    await this.round(`账本已清空（${removed} 笔）`);
    return { removed, archived };
  }

  /** 不可逆操作都要在这里留一行本地痕迹 */
  private async appendVoid(line: string): Promise<void> {
    const file = join(config.dataDir, "voids.log");
    await mkdir(config.dataDir, { recursive: true });
    const prev = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    const c = clockNow();
    await Bun.write(file, prev + `${c.date} ${c.time}  ${line}\n`);
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
      // 决策口径（面板"常设命令"卡用）：节奏、单笔预算、本金、采纳阈值、清仓时点
      decideEveryMs: config.decideEveryMs,
      bankrollCny: config.bankrollCny,
      sizeCny: config.sizeCny,
      minProb: config.jevMinProb,
      forceExitAt: hhmmOf(config.forceExitMin),
    };
  }

  private note(trading: boolean, phase: Phase, quotes: number, ms: number, ageSec: number, fresh: boolean): string {
    if (!trading) return `非交易日（${phase}），数据为最近收盘快照 ${Math.round(ms)}ms`;
    if (this.eodOnly) return "实时链路降级：只用日频，盘前出一次信号";
    if (phase === "lunch") return "午休";
    if (quotes === 0 && canTrade(phase)) return "还没有可用快照";
    if (!fresh) return `行情已老化 ${ageSec}s > ${config.quoteStaleSec}s，本轮不出单不撮合`;
    return `${Math.round(ms)}ms`;
  }
}

function triggerOf(phase: Phase, minutes: number): string {
  if (phase === "pre-open") return minutes >= config.session.premarketMin ? "盘前预选" : "盘前等待";
  if (phase === "call-auction" || phase === "no-cancel") return "集合竞价";
  if (!canTrade(phase)) return phase === "lunch" ? "午休" : "心跳";
  if (minutes < config.session.morningStart + 30) return "退出窗口";
  if (minutes >= config.session.tailStart) return "尾盘决策";
  return "盘中决策";
}

/**
 * 买入决策这一轮该不该跑。纯函数，单测覆盖：
 *  - 盘前（09:05 到开盘）每个交易日一次预选，用最近收盘快照；
 *  - 连续竞价全程按 DECIDE_EVERY_MS 节奏决策（不再只限尾盘）；
 *  - 集合竞价/午休/收盘竞价/非交易日不跑（价格不可靠或没有意义）；
 *  - force（手动 /scan）无视节奏。
 */
export function buyDecisionDue(a: {
  force: boolean;
  trading: boolean;
  /** liveQuotes(phase)：只有连续竞价的价格适合做买入判定 */
  liveNow: boolean;
  usable: boolean;
  scoredCount: number;
  minutes: number;
  preBuyDone: boolean;
  lastBuyMs: number;
  nowMs: number;
}): boolean {
  if (a.scoredCount <= 0) return false;
  if (a.force) return true;
  if (!a.trading) return false;
  const preMarket = a.minutes >= config.session.premarketMin && a.minutes < config.session.morningStart;
  if (preMarket) return !a.preBuyDone;
  return a.liveNow && a.usable && a.nowMs - a.lastBuyMs >= config.decideEveryMs;
}

export function clockNow(d: Date = new Date()): EngineClock {
  const b = bj(d);
  return { date: b.ymd, time: `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`, minutes: b.minutes };
}

export { sessionNow };
