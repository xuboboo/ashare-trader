/**
 * 引擎：一次只有一个在途轮次，上一轮没跑完就直接复用上一次结果，绝不并发打接口。
 *
 * 节奏是 A 股能落地的三个触发点（不做盘中高频）：
 *   09:05 盘前扫描（LLM 情绪闸门 + 事件 veto）
 *   09:30-14:57 Jev 全程买卖判断（止损/T+1 是系统硬边界）
 *   因子只做硬筛选输入，不再作为 Jev 失败时的决策替代
 * 其余时段只做行情心跳、影子撮合与净值标记。
 */
import { config } from "./config";
import { loadAtrMap } from "./atr";
import { stopCounterfactual, summarizeStopCounterfactuals, type StopCounterfactual } from "./exit";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { TradingCalendar } from "./calendar";
import { defaultFactorParams, featuresFromSnapshot, gateLabel, ma5CloseBefore, marketGate, scoreStock, type Gate, type Scored } from "./factors";
import { FactorModel, type Decision, type DailyBias, type Model, type SignalState, LlmAdvisory } from "./model";
import { JevModel } from "./jev";
import { LocalModel } from "./local";
import { availableCash, cancelStaleSells, makeBuyOrder, makeExitOrder, restingKey, restingKeys, settlePending, type Clock, type SuggestedOrder } from "./orders";
import { fetchIndexDaily, fetchIndex, fetchTickTrades, fetchZtPool, fetchSnapshots, quoteAgeSec, type DailyBar, type Snapshot, type TickTrade } from "./quotes";
import { riskBrake, type RiskBrake } from "./risk";
import { bj, canTrade, hhmmOf, liveQuotes, phaseOf, type Phase, sessionNow, tradingElapsedMin } from "./session";
import { Book, makeFill, round2, writeFileAtomic, type Fill } from "./state";
import { cannotAffordLot, inScope, lotAwareHalfQty } from "./symbols";
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
  /** 同一轮可能同时有 Jev 买入/卖出判断；decision 保持最后一条供旧面板兼容。 */
  decisions?: { buy?: Decision; sell?: Decision };
  /** 组合级风控闸（日亏损/回撤），只在调用过 decide 的轮次有值 */
  risk: RiskBrake | null;
  orders: SuggestedOrder[];
  fills: Fill[];
  positions: PositionView[];
  totals: ReturnType<Book["totals"]>;
  /**
   * 本轮墙钟分解（毫秒）。加它是因为"10s 节奏"实测是 16s，而光看轮次间隔定不了责任：
   * 主循环是 `sleep(pollMs - elapsed)`，一轮跑 13s 就意味着周期被轮次本身撑开，
   * 与 DECIDE_EVERY_MS 无关。不归因清楚，改节流参数就是盲改。
   */
  timing?: { roundMs: number; quotesMs: number; tapesMs: number; modelMs: number };
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
  private eodOnly = config.eodOnly;
  private pending = new Map<string, SuggestedOrder>();
  private indexMa5: number | null = null;
  private indexBars: DailyBar[] = [];
  private bias: DailyBias | null = null;
  private biasDate = "";
  private zt = { count: 0, maxLianBan: 0, known: false, industries: new Map<string, number>() };
  /** 上一次采涨停池的时刻（毫秒）：闸门用的情绪数必须是今天的，隔夜值不能泄进来 */
  private lastZtMs = 0;
  /** 本轮的大盘上下文，传给决策模型的 state 用 */
  private lastIndex: { price: number; pct: number; amountYi: number; ma5: number | null } | null = null;
  /** 盘前预选已做过的交易日（每日一次） */
  private preBuyDate = "";
  /** 上一次盘中买入决策时刻（epoch ms），配合 DECIDE_EVERY_MS 控制节奏 */
  private lastBuyMs = 0;
  /** 上一次真正开新仓的时刻（epoch ms）：两笔新仓之间强制隔 minOpenGapMs，防同一分钟无脑冲多只 */
  private lastOpenMs = 0;
  /** 上一轮的可买候选代码集（事件触发的比较基准） */
  private lastEligibleKey = "";
  /** Jev 卖出决策节奏；买卖都必须留下真实调用 trace。 */
  private lastSellMs = 0;
  /** 上一次 eodOnly 恢复探测时刻 */
  private lastEodProbeMs = 0;
  /** 个股 ATR₁₄（STOP_MODE=atr 用），init 与每日日切时各加载一次 */
  private atrMap: Map<string, number> = new Map();
  /** 最近一次风控闸判定（挂到事件上，面板可见） */
  private lastRisk: RiskBrake | null = null;
  /**
   * 止损口径的反事实对照行（每平一笔仓一条）。这是用手上真实成交回答
   * “ATR 比固定 3% 好吗”，而不是拿同一段历史再扫一次参数。
   */
  private stopCf: StopCounterfactual[] = [];
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
        `闸门${gateLabel(e.gate)} 池${e.universe} 快照${e.quotes.ok} ` +
        `出单${e.orders.length} 成交${e.fills.length} 持仓${e.totals.positions} 浮亏盈${pnl} ${e.trigger}` +
        (picks !== "-" ? ` | ${picks}` : "") +
        // 轮次拉长时先看这三个数：是行情、是分笔，还是模型
        (e.timing && e.decision && !e.decision.late
          ? ` | 拆: 行情${e.timing.quotesMs} 分笔${e.timing.tapesMs} 模型${e.timing.modelMs}`
          : "") +
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
    await this.loadStopCounterfactuals();
    await this.calendar.refresh();
    const today = bj().ymd;
    this.book.rollover(today);
    await this.loadPending(today);
    if (config.stopMode === "atr") this.atrMap = await loadAtrMap(today);
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

  /** Jev-vs-随机对照实验的原始决策流水（只旁路追加，不影响交易）。 */
  private journalFile(): string {
    return join(config.dataDir, "jev-journal.jsonl");
  }

  /**
   * 对照实验的原始样本行。`executable` 标的是"这一轮的判断真的可以落成委托"：
   * 盘后 /scan 与 once.ts 的 force-scan 也会真调 Jev（那是链路验证，该花钱），
   * 但它拿的是隔夜快照、且永远不可能成交 —— 混进实验就等于用不可执行的样本给模型打分。
   */
  private async appendJournal(entry: {
    date: string; time: string; phase: string; executable: boolean;
    model: string; threshold: number; pool: string[]; picked: string[];
  }): Promise<void> {
    await appendFile(this.journalFile(), JSON.stringify(entry) + "\n", "utf8");
  }

  /** Jev 调用成本流水：只记真打了远端/命中缓存的轮次（call!==none），用于"这钱花得值不值"。 */
  private costFile(): string {
    return join(config.dataDir, "jev-cost.jsonl");
  }

  private async appendCost(clock: EngineClock, side: "buy" | "sell", d: Decision | null): Promise<void> {
    const call = d?.trace?.call;
    if (!call || call === "none" || !d.trace) return;
    await appendFile(
      this.costFile(),
      JSON.stringify({
        date: clock.date,
        time: clock.time,
        side,
        model: d.trace.source,
        call,
        tokens: d.inputTokens ?? 0,
        latencyMs: Math.round(d.latencyMs),
      }) + "\n",
      "utf8",
    );
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
    // 整本重写：写坏一次就丢掉当天所有在途单，所以走原子替换
    await writeFileAtomic(
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
      // 阀门：交易时段全速（3s），午休/盘前/盘后 1 分钟心跳，非交易日 10 分钟心跳
      const idle = trading ? 60_000 : 600_000;
      await Bun.sleep(Math.max(200, (busy ? config.pollMs : idle) - elapsed));
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
    /** 本轮开始时刻：用来判定“这张单是不是本轮才挂出来的” */
    const roundStartMs = Date.now();
    const trading = this.calendar.isTradingDay(clock.date);
    const phase = phaseOf(clock.date, clock.minutes, trading);
    // 日切：刷新交易日历与指数日线 —— 今天的日线盘后才生成，“今天是交易日”靠投射；
    // 指数 MA5 的窗口也必须每天跟进，长跑才不会拿一周前的旧数据算闸门
    if (this.book.rollover(clock.date)) {
      void this.calendar.refresh();
      // 股票池同样得每天新：旧实现只在 init 拉一次，长跑进程的池子会停在启动那天
      void this.universe.get(clock.date);
      // 隔夜涨停家数对今天没有意义，作废掉等盘中现采（采到之前闸门不用它）
      this.zt = { count: 0, maxLianBan: 0, known: false, industries: new Map() };
      if (config.stopMode === "atr") {
        try {
          this.atrMap = await loadAtrMap(clock.date);
        } catch {
          /* ATR 表沿用旧的；个股缺失时 makeBuyOrder 自动回退 fixed */
        }
      }
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
    // eodOnly 是实时链路降级开关，降级期间只能观察/复盘，不能把旧快照
    // 当成可下单行情。显式 fail-closed，避免故障后的短窗口继续注册新单。
    const usable = trading && !this.eodOnly && canTrade(phase) && ok > 0 && quotesFresh;
    /** 行情段（指数快照 + 全池 L1）的累计耗时 —— t0 是行情块开头 */
    const quotesMs = Math.round(performance.now() - t0);

    // ---- 大盘闸门 ----
    this.indexMa5 = this.indexBars.length >= 5 ? (ma5CloseBefore(this.indexBars, clock.date) ?? null) : this.indexMa5;
    if (!this.indexBars.length) {
      try {
        this.indexBars = await fetchIndexDaily(40);
      } catch {
        /* 闸门退化处理：没有 MA5 就不因它否决 */
      }
    }
    // 涨停池：只在连续竞价时段现采，与决策同节奏（每 DECIDE_EVERY_MS 一次，纯规则不花模型）。
    // 旧实现每天只盘前跑一次，而 09:05 当日涨停数必然是 0 → 该否决项永远不生效。
    if (trading && liveQuotes(phase) && Date.now() - this.lastZtMs >= config.decideEveryMs) await this.refreshZt(clock.date);
    const gate = marketGate(
      { price: index.price, amountYi: index.amountYi },
      this.indexMa5,
      trading && this.zt.known ? this.zt.count : null,
      // 累计交易分钟（跨过午休不清零）：成交额是当日累计值，分母也必须是累计时长
      tradingElapsedMin(clock.minutes),
      // 时效：只有“交易日 + 可交易时段 + 行情新鲜”时这个结论才是现在能用的开关
      { live: usable },
    );
    this.lastIndex = { price: index.price, pct: index.pct, amountYi: index.amountYi, ma5: this.indexMa5 };

    // ---- 选股打分 ----
    // 成交额门槛按开盘时长折算：早盘 8 分钟不要求全天累计 2 亿
    const sessionElapsedMin = clock.minutes >= config.session.afternoonStart
      ? clock.minutes - config.session.afternoonStart + 120 // 下午 = 上午 120 分钟 + 下午已过
      : clock.minutes - config.session.morningStart;
    const fp = defaultFactorParams();
    if (sessionElapsedMin > 0) fp.minAmountYi = config.minAmountYi * Math.max(0.05, Math.min(1, sessionElapsedMin / 240));
    const scored: Scored[] = [];
    for (const sn of this.snapshots.values()) {
      if (!this.universe.entries.some((e) => e.code === sn.code)) continue;
      scored.push(scoreStock(featuresFromSnapshot(sn, clock.date), {}, false, fp));
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
    //   可卖持仓先跑止损保护，再按 DECIDE_EVERY_MS 交给 Jev 判断其余卖出。
    const trigger = forceTrigger ?? triggerOf(phase, clock.minutes);
    const force = forceTrigger === "force-scan";
    const newOrders: SuggestedOrder[] = [];
    const cancelledOrders: SuggestedOrder[] = [];
    let decision: Decision | null = null;
    let sellDecision: Decision | null = null;

    if (force || trading) {
      if ((trading || force) && clock.minutes >= config.session.premarketMin && this.biasDate !== clock.date) {
        await this.refreshBias(clock, index);
      }

      const hasSellable = [...this.book.positions.values()].some((p) => p.sellable > 0);
      if (trading && liveQuotes(phase) && usable && hasSellable) {
        // ---- 死单改价：先撤掉被市价击穿的在途卖单，退出阶梯/模型卖出才能按现价重出 ----
        const stale = cancelStaleSells(this.pending, this.snapshots);
        if (stale.changed) {
          cancelledOrders.push(...stale.cancelled);
          await this.persistPending();
        }
        // ---- 硬安全边界：止损与 T+1。Jev 自主决定其余卖出。----
        const exits = this.exitOrders(clock);
        for (const o of exits) o.decidedBy = "hard-rule"; // 止损是保护性硬规则，不经模型（Jev 模式下高开减仓已交还 Jev）
        newOrders.push(...exits);
        for (const o of exits) this.pending.set(o.signalId, o);
        if (exits.length) await this.persistPending();

        // ---- Jev 唯一卖出决策：每个决策周期评估全部可卖持仓。----
        const sellNow = Date.now();
        if (config.model === "jev" && sellNow - this.lastSellMs >= config.decideEveryMs) {
          sellDecision = await this.decide(clock, scored, gate, "sell");
          if (!decision) decision = sellDecision;
          this.lastSellMs = sellNow;
          try {
            await this.appendCost(clock, "sell", sellDecision);
          } catch {
            /* 成本记录失败不影响主流程 */
          }
          const hasSellOrder = new Set(newOrders.filter((o) => o.side === "sell").map((o) => o.code));
          for (const o of this.pending.values()) if (o.side === "sell") hasSellOrder.add(o.code);
          for (const pick of sellDecision.picks) {
            if (hasSellOrder.has(pick.code)) continue;
            const pos = this.book.positions.get(pick.code);
            const sn = this.snapshots.get(pick.code);
            if (!pos || !sn || pos.sellable <= 0) continue;
            const offset = pick.priceOffsetPct ?? 0;
            const hint = offset > 0 ? round2(sn.price * (1 + offset / 100)) : null;
            const o = makeExitOrder(
              pos,
              sn,
              clock,
              `Jev 全程卖出决策（p=${(pick.probability * 100).toFixed(0)}%）${hint ? `，Jev 价格意图 +${offset.toFixed(1)}%` : "，按对手价"}`,
              pos.sellable,
              0,
              hint,
            );
            if (o) {
              o.decidedBy = sellDecision?.trace?.source ?? "jev";
              o.decisionProb = pick.probability;
              newOrders.push(o);
              this.pending.set(o.signalId, o);
            }
          }
          if (sellDecision.picks.length) await this.persistPending();
        }
      }

      const nowMs = Date.now();
      // 可买候选集（过硬筛选+买得起）的代码集：与上轮比较，"看情况冲"的事件源
      const eligibleCodes = scored
        .filter((c) => c.rejects.length === 0 && c.score > 0 && !cannotAffordLot(c.features.price, config.sizeCny))
        .map((c) => c.features.code)
        .sort();
      const codesKey = eligibleCodes.join(",");
      const codesChanged = codesKey !== this.lastEligibleKey;
      this.lastEligibleKey = codesKey;
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
          codesChanged,
        })
      ) {
        decision = await this.decide(clock, scored, gate, "buy");
        const preMarket = clock.minutes >= config.session.callAuctionEnd && clock.minutes < config.session.morningStart;
        if (trading && preMarket) this.preBuyDate = clock.date;
        else this.lastBuyMs = nowMs;

        // "能落成委托"的唯一判据：连续竞价 + 行情新鲜可用。usable 已含 trading/canTrade/非降级。
        // 凡是要拿来做对照评分的落盘（影子、journal）都必须带上它 —— 盘后 force-scan 也会真调模型，
        // 但它拿的是隔夜快照、永远不可能成交，混进去就是拿噪声给模型打分。
        const actionable = liveQuotes(phase) && usable;

        // 影子对照：其余模型对同一状态的判断也落盘（防"三选一"的模型挑选偏差）。
        // 只记录，不出单；失败静默跳过，不会拖累主链路。
        if (decision) {
          try {
            await this.recordShadow(clock, scored, gate, decision, { phase, executable: actionable });
          } catch {
            /* 影子记录失败不影响主流程 */
          }
        }

        // Jev-vs-随机对照实验的原始记录：只要真调了模型（非 hard-rule 跳过）就把“候选池 + Jev 选中”追加落盘。
        // 哪怕本轮 picked 为空（Jev 决定不买）也要记——那是关键信息。失败静默，绝不拖累交易。
        try {
          await this.appendCost(clock, "buy", decision);
        } catch {
          /* 成本记录失败不影响主流程 */
        }
        if (decision?.trace && decision.trace.source !== "hard-rule" && eligibleCodes.length) {
          try {
            await this.appendJournal({
              date: clock.date,
              time: clock.time,
              phase,
              executable: actionable,
              model: decision.trace.source,
              threshold: config.jevMinProb,
              pool: eligibleCodes,
              picked: (decision.picks ?? []).map((p) => p.code),
            });
          } catch {
            /* 记录失败不影响主流程 */
          }
        }

        // 盘前预选只出观点；连续竞价与 force（复盘）出建议单
        if (force || actionable) {
          const resting = restingKeys(this.pending);
          // 只有行情可用的窗口里才把单注册成在途单；否则 force（收盘后 /scan）只是
          // 复盘用的“本轮观点”，不能直接进 pending —— 不然面板上会看到一弹出单然后被作废。
          const register = actionable;
          // 每轮最多执行 maxBuysPerRound 个新买入（默认 1）：picks 按置信度排序，
          // 只执行最前面的那个；其余的要等下一轮模型用新鲜行情重新确认。
          // 真人不会同一分钟无脑连买三只 —— 每笔入场都该是当下独立确认的判断。
          let buysThisRound = 0;
          for (const pick of decision?.picks ?? []) {
            if (buysThisRound >= config.maxBuysPerRound) break;
            // 新仓冷却：距上一笔开仓不足 MIN_OPEN_GAP_MS 就不开新仓（一轮只动一个决定，贴近人）。
            if (!canOpenNewPosition(nowMs, this.lastOpenMs, config.minOpenGapMs)) break;
            const s = scored.find((x) => x.features.code === pick.code);
            if (!s) continue;
            // 同一标的同时只留一张在途买单：决策每 60s 一轮，不去重就会把同一只股堆成几仓
            if (resting.has(restingKey({ code: s.features.code, side: "buy" }))) continue;
            // 已持仓的不重复加仓（与回测的 openPositions.has(code) 同一口径）
            if (this.book.positions.has(s.features.code)) continue;
            const vetoReason = this.bias?.vetoes[s.features.code];
            const order = makeBuyOrder(s, clock, vetoReason, config.sizeCny, this.atrMap.get(s.features.code));
            if (!order) continue;
            order.decidedBy = decision?.trace?.source ?? "unknown";
            order.decisionProb = pick.probability;
            // 资金闸：按"可用资金"判断（现金减去在途买单冻结占用，与券商同口径），
            // 账本不允许被买穿成负数 —— 多张在途单不能再共用同一笔现金
            if (order.amountCny + 50 > availableCash(this.book.cash, this.pending)) continue;
            newOrders.push(order);
            buysThisRound++;
            resting.add(restingKey(order));
            if (register) {
              this.pending.set(order.signalId, order);
              this.lastOpenMs = nowMs; // 只有真注册成在途单（会开仓）才重置冷却计时
            }
          }
          if (register && newOrders.length) await this.persistPending();
        }
      }
    }

    // ---- 影子撮合 + 净值 ----
    // 撮合只在连续竞价时段进行：集合竞价（09:15-09:25 申报、14:57-15:00 收盘竞价）不连续
    // 撮合，真实市场里委托在那儿排队等一次性竞价，对着 L1 盘口逐轮成交是假的。
    // 当日单到期作废不受此限（dayOver 在 settlePending 里先于 usable 判断）。
    const matching = usable && liveQuotes(phase);
    // 分笔成交（排队证据）：只拉挂着在途单的代码，每轮几个请求；拉不到的代码退回快照口径
    const tapes = new Map<string, TickTrade[]>();
    const tapesT0 = performance.now();
    if (matching && config.paper) {
      for (const code of new Set([...this.pending.values()].filter((o) => o.status === "pending").map((o) => o.code))) {
        try {
          tapes.set(code, await fetchTickTrades(code));
        } catch {
          /* 分笔失败不阻塞撮合：该代码退回快照口径 */
        }
      }
    }
    /** 分笔是逐代码串行拉的，有在途单时这一段很容易吃掉整个轮次预算 —— 单独计时看着它。 */
    const tapesMs = Math.round(performance.now() - tapesT0);
    // 当日单、隔日作废、本轮挂的不本轮成交 —— 具体口径在 orders.settlePending（有单测）
    const { fills, changed } = settlePending(this.pending, {
      snapshots: this.snapshots,
      clock,
      usable: matching,
      paper: config.paper,
      roundStartMs,
      dayOver: phase === "after-hours" || phase === "closed",
      tapes,
    });
    for (const fill of fills) {
      // 平仓腿：先拿建仓时存下的两条止损线与观察水位算反事实对照，再落账
      //（Position 在全平后会被删掉，事后再也算不了）
      if (fill.side === "sell") await this.recordStopCounterfactual(fill, clock.date);
      this.book.applyFill(fill);
      await this.book.appendFill(fill);
    }
    if (changed) await this.persistPending();
    this.book.markToMarket(new Map([...this.snapshots].map(([c, s]) => [c, s.price])));
    if (usable) this.trackWaters(clock);

    const roundMs = Math.round(performance.now() - t0);
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
      decisions: decision || sellDecision ? { buy: decision ?? undefined, sell: sellDecision ?? undefined } : undefined,
      risk: this.lastRisk,
      // 事件带全量订单视图：新建的 + 本轮撤销的 + 当前全部在途。
      // 在途单每轮重发不是浪费 —— 重启后内存事件流清空，UI 靠它恢复真实挂单视图；
      // 撤单也要出现在事件里，否则面板上那张单永远停在“挂单中”。
      orders: [...newOrders, ...cancelledOrders, ...this.pending.values()],
      fills,
      positions: this.positionView(),
      totals: this.book.totals(),
      timing: {
        roundMs,
        quotesMs,
        tapesMs,
        modelMs: Math.round((decision?.latencyMs ?? 0) + (sellDecision?.latencyMs ?? 0)),
      },
      note: this.note(trading, phase, ok, roundMs, ageSec, quotesFresh, this.zt.known),
    };
    this.attach(event);
    return event;
  }

  private riskNow(): RiskBrake {
    const totals = this.book.totals();
    return riskBrake({
      equity: totals.equity,
      dayStartEquity: this.book.dayStartEquity,
      peakEquity: this.book.peakEquity,
      dayLossLimitPct: config.maxDayLossPct,
      drawdownLimitPct: config.maxDrawdownPct,
    });
  }

  private signalState(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "sell", risk: RiskBrake): SignalState {
    const held = [...this.book.positions.values()];
    const buysToday = this.book.openDateCount(clock.date);
    const openSlots = Math.max(0, config.maxDailyOpens - buysToday);
    const positions = held.flatMap((p) => {
      const sn = this.snapshots.get(p.code);
      if (p.sellable <= 0 || !sn || !(sn.price > 0)) return [];
      return [{
        code: p.code,
        name: p.name,
        entry: p.avgPrice,
        price: sn.price,
        unrealizedPct: p.avgPrice > 0 ? ((sn.price - p.avgPrice) / p.avgPrice) * 100 : 0,
        stop: p.stopPrice,
        heldDays: Math.max(1, Math.round((Date.parse(`${clock.date}T12:00:00Z`) - Date.parse(`${p.openDate}T12:00:00Z`)) / 86_400_000)),
        sellable: p.sellable,
      }];
    });
    return {
      date: clock.date,
      time: clock.time,
      horizon: mode === "buy" ? "Jev 买入判断；退出时点由 Jev 自主决定" : "Jev 全程卖出判断；T+1/止损为硬边界",
      gate,
      index: this.lastIndex,
      candidates: scored,
      heldCodes: held.map((p) => p.code),
      allowed: {
        buy: mode === "buy" && gate.allowed && (this.bias?.allowOpen ?? true) && openSlots > 0 && !risk.buyBlocked,
        sell: positions.length > 0,
      },
      vetoes: this.bias?.vetoes ?? {},
      openSlots: Math.min(openSlots, config.k - held.length),
      decisionMode: mode,
      positions,
    };
  }

  private async decide(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "sell"): Promise<Decision> {
    // 组合级风控闸：只封新开仓，不封退出（止损/清仓在亏损状态也必须走得掉）
    this.lastRisk = this.riskNow();
    const st = this.signalState(clock, scored, gate, mode, this.lastRisk);
    return this.model.decide(st);
  }

  /**
   * 影子对照：同一份状态喂给其余模型，把它们的判断追加落盘到 data/shadow/<date>.jsonl。
   * 目的：factor / local / jev 三选一容易变成"挑表现最好的"（回测过拟合）；
   * 从现在开始让它们在同一个状态上并行产出 forward 记录，未来对比才有资格。
   * `sample` 把本轮样本的出处与否可执行性一起落盘，与 journal 同一口径。
   */
  private async recordShadow(
    clock: EngineClock,
    scored: Scored[],
    gate: Gate,
    active: Decision,
    sample: { phase: Phase; executable: boolean },
  ): Promise<void> {
    const models: Model[] = [];
    if (config.model !== "factor") models.push(new FactorModel());
    if (config.model !== "local") models.push(new LocalModel());
    if (config.model !== "jev" && config.typesafeApiKey) models.push(new JevModel());
    if (!models.length) return;
    const st = this.signalState(clock, scored, gate, "buy", this.riskNow());
    const shadow: ShadowOpinion[] = [];
    for (const m of models) {
      try {
        const d = await m.decide(st);
        shadow.push({ model: m.name, action: d.action, modelFailed: d.modelFailed, trace: d.trace, picks: d.picks.map((p) => ({ code: p.code, probability: p.probability })) });
      } catch {
        shadow.push({ model: m.name, action: "error", picks: [] });
      }
    }
    const row = buildShadowRow({ time: clock.time, phase: sample.phase, executable: sample.executable, decision: active, shadow });
    const dir = join(config.dataDir, "shadow");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${clock.date}.jsonl`);
    const prev = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    await writeFileAtomic(file, prev + JSON.stringify(row) + "\n");
  }

  /**
   * 持仓退出阶梯（每轮评估，规则间互斥触发、谁先命中执行谁）：
   *   1. Jev 模式由 Jev 自主判断高开减仓与 VWAP 弱势离场
   *   2. 非 Jev 兼容模式保留高开减仓与 VWAP 弱势离场
   *   3. 跌破止损价全走（唯一生产级价格保护）
   *   不再设置固定时间清仓；Jev 可以自主决定持仓时长。
   * 触发价只是"发单信号"，不是保证成交价 —— 成交以 PAPER 撮合的对手价为准。
   */
  private exitOrders(clock: EngineClock): SuggestedOrder[] {
    const out: SuggestedOrder[] = [];
    const resting = restingKeys(this.pending);
    for (const p of this.book.positions.values()) {
      if (p.sellable <= 0) continue;
      const sn = this.snapshots.get(p.code);
      if (!sn) continue;
      // 同一标的已有一张在途卖单：等它成交或作废，绝不叠加。
      // 否则“开盘减半”与“止损”两张单会同时挂着，然后双双成交，卖出量超过持仓量。
      if (resting.has(restingKey({ code: p.code, side: "sell" }))) continue;

      // 决定要走了就先掉同一标的的在途买单：一卖一买同时挂着手是矛盾指令
      for (const [id, o] of [...this.pending]) {
        if (o.code === p.code && o.side === "buy" && o.status === "pending") {
          o.status = "cancelled";
          this.pending.delete(id);
          resting.delete(restingKey(o));
        }
      }
      const emit = (reason: string, qty: number): boolean => {
        const o = makeExitOrder(p, sn, clock, reason, qty);
        if (!o) return false;
        out.push(o);
        resting.add(restingKey(o));
        return true;
      };

      // Jev 模式下，高开减半是可裁量决策，交给 Jev；非 Jev 模式保留旧规则。
      if (config.model !== "jev" && !p.openingTpDone && sn.open > 0 && p.avgPrice > 0) {
        p.openingTpDone = true;
        const openPnlPct = ((sn.open - p.avgPrice) / p.avgPrice) * 100;
        if (openPnlPct >= config.gapTrimPct) {
          const half = lotAwareHalfQty(p.sellable);
          if (half >= 100 && emit(`开盘浮盈 ${openPnlPct.toFixed(2)}% ≥ ${config.gapTrimPct}%，先卖一半`, half)) continue;
        }
      }

      // ---- 唯一硬性价格保护：止损。固定时间清仓已移除，持仓期限由 Jev 决定。----
      if (sn.price <= p.stopPrice) {
        emit(`跌破止损 ${p.stopPrice}`, p.sellable);
        continue;
      }

      // Jev 模式下，VWAP 弱势也进入 Jev 的全程判断；止损仍是硬边界。
      if (config.model !== "jev" && clock.minutes >= config.session.morningStart + 15 && sn.vwap > 0) {
        if (sn.price < sn.vwap) p.vwapBelowRounds = (p.vwapBelowRounds ?? 0) + 1;
        else p.vwapBelowRounds = 0;
        if ((p.vwapBelowRounds ?? 0) >= config.vwapConfirmRounds) emit("跌破分时均线，弱势离场", p.sellable);
      }
    }
    return out;
  }

  /**
   * 采当日涨停池（大盘闸门的情绪项）。采到才算 known：
   * 采失败时宁可不否决，也不能拿默认 0 家把系统锁在空仓（那会把“没数据”当成“情绪冰点”）。
   */
  private async refreshZt(date: string): Promise<void> {
    this.lastZtMs = Date.now();
    try {
      const pool = await fetchZtPool(date.replace(/-/g, ""));
      this.zt.count = pool.length;
      this.zt.maxLianBan = pool.reduce((m, p) => Math.max(m, p.lianBan), 0);
      this.zt.industries = new Map();
      for (const p of pool) this.zt.industries.set(p.industry, (this.zt.industries.get(p.industry) ?? 0) + 1);
      this.zt.known = true;
    } catch (e) {
      this.zt.known = false;
      console.error(`[engine] 涨停池失败（本轮不用情绪否决）: ${(e as Error).message}`);
    }
  }

  private async refreshBias(clock: EngineClock, index: { price: number; pct: number; amountYi: number }): Promise<void> {
    await this.refreshZt(clock.date);
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
    if (!/^\d{6}$/.test(args.code)) throw new Error("code 需要 6 位数字");
    if (!inScope(args.code)) throw new Error(`代码不在本系统交易范围：${args.code}`);
    if (!Number.isInteger(args.qty) || args.qty <= 0) throw new Error("qty 必须是正整数");
    if (args.side === "buy" && args.qty % 100 !== 0) throw new Error("买入 qty 必须是 100 的整数倍");
    if (args.price !== undefined && (!Number.isFinite(args.price) || args.price <= 0)) throw new Error("price 必须为正数");
    if (args.price !== undefined && Math.abs(args.price * 100 - Math.round(args.price * 100)) > 1e-7)
      throw new Error("price 必须精确到 0.01 元");

    const clock = clockNow();
    const sn = this.snapshots.get(args.code);
    const name = sn?.name ?? this.universe.nameOf(args.code);
    const price = args.price ?? sn?.price ?? 0;
    if (!(price > 0)) throw new Error(`不知道 ${args.code} 的价格，请显式给 price`);
    if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-7) throw new Error("price 必须精确到 0.01 元");

    const matched = args.signalId ? this.pending.get(args.signalId) : undefined;
    if (matched && (matched.code !== args.code || matched.side !== args.side))
      throw new Error("signalId 与 code/side 不匹配");
    if (args.side === "sell") {
      const position = this.book.positions.get(args.code);
      const sellable = position?.sellable ?? 0;
      if (args.qty > sellable) throw new Error(`卖出数量超过 T+1 可卖数量：${args.qty} > ${sellable}`);
      if (args.qty >= 100 && args.qty % 100 !== 0) throw new Error("卖出 qty 必须是 100 的整数倍（零股只能作为不足 100 股的残余单）");
    }
    const b1 = sn?.bids[0]?.p ?? 0;
    const a1 = sn?.asks[0]?.p ?? 0;
    // 先找到它对应的那张建议单：回填的真实成交必须沿用建议单算好的止损线（含 ATR 口径），
    // 否则“人工回填”这一条路会把 STOP_MODE 弄成装饰。
    const fill = makeFill({
      code: args.code,
      name,
      side: args.side,
      price,
      qty: args.qty,
      date: args.date ?? clock.date,
      time: args.time ?? clock.time,
      kind: "manual",
      // 人工回填的是一笔真实交易：若它对应某张建议单，沿用那张单的决策源（你执行的是谁的信号），否则标 manual
      decidedBy: matched?.decidedBy ?? "manual",
      decisionProb: matched?.decisionProb,
      signalId: args.signalId,
      stopPrice: args.side === "buy" ? matched?.stopPrice ?? undefined : undefined,
      slippageBps: sn && sn.price > 0 ? ((price - sn.price) / sn.price) * 10_000 : undefined,
      spreadBps: b1 > 0 && a1 > 0 ? ((a1 - b1) / ((a1 + b1) / 2)) * 10_000 : undefined,
      note: args.note ?? "人工回填",
    });
    if (matched) {
      matched.status = "filled";
      matched.fill = fill;
      this.pending.delete(args.signalId!);
      await this.persistPending();
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

  /* ------------------------------------------------- 止损口径的反事实对照 */

  private stopCfFile(): string {
    return join(config.dataDir, "stopcounter.jsonl");
  }

  /** 逐轮更新“建仓后最低价”水位。只在行情可用的轮次调（调用方保证）。 */
  private trackWaters(clock: EngineClock): void {
    const todayCompact = clock.date.replace(/-/g, "");
    this.book.trackLowWater(new Map([...this.snapshots].map(([c, s]) => [c, s.price])));
    // 建仓次日起，当日最低价整段都在建仓之后 → 可以用它收紧水位（3s 采样会漏掉针尖）。
    // 建仓当日绝对不能用：那个 low 包含我们建仓之前的下影线，用了就是把假低点当成我们抗过的亏。
    for (const [code, p] of this.book.positions) {
      const sn = this.snapshots.get(code);
      if (!sn || p.openDate === clock.date || sn.quoteDay !== todayCompact || !(sn.low > 0)) continue;
      p.lowWater = Math.min(p.lowWater ?? sn.low, sn.low);
    }
  }

  /**
   * 平仓时把另一条止损线的结局算出来并追写一行。
   * 没存两条线（旧流水、人工回填无 signalId、ATR 缺失回退固定）就跳过，不编数字。
   */
  private async recordStopCounterfactual(fill: Fill, exitDate: string): Promise<void> {
    const p = this.book.positions.get(fill.code);
    if (!p || !(p.stopFixed ?? 0) || !(p.stopAtr ?? 0)) return;
    const activeMode: "fixed" | "atr" = p.stopPrice === p.stopAtr ? "atr" : "fixed";
    const row = stopCounterfactual({
      code: fill.code,
      name: p.name,
      entryDate: p.openDate,
      exitDate,
      exitTime: fill.time,
      qty: fill.qty,
      entry: p.avgPrice,
      exit: fill.price,
      lowWater: Math.min(p.lowWater ?? fill.price, fill.price),
      stopFixed: p.stopFixed!,
      stopAtr: p.stopAtr!,
      activeMode,
    });
    this.stopCf.push(row);
    await mkdir(config.dataDir, { recursive: true });
    const prev = (await Bun.file(this.stopCfFile()).exists()) ? await Bun.file(this.stopCfFile()).text() : "";
    await writeFileAtomic(this.stopCfFile(), prev + JSON.stringify(row) + "\n");
    console.log(
      `[stop] ${fill.code} 对照：固定线 ${row.stopFixed} ${row.fixedTriggered ? "触发" : "未触发"}、` +
        `ATR 线 ${row.stopAtr} ${row.atrTriggered ? "触发" : "未触发"}，ATR 相对固定差 ${row.diffBps}bp（正=ATR 更好）`,
    );
  }

  private async loadStopCounterfactuals(): Promise<void> {
    try {
      const text = await Bun.file(this.stopCfFile()).text();
      this.stopCf = text
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            const r = JSON.parse(l) as StopCounterfactual;
            return r && typeof r.diffBps === "number" ? [r] : [];
          } catch {
            return []; // 单行坏了不拖垮整本（以前整本一个 try/catch，一行坏就当没发生过）
          }
        });
    } catch {
      this.stopCf = [];
    }
  }

  /** GET /stops 用：逐笔对照 + 汇总。汇总只看"至少一个口径触发"的子集，那才是有信息量的样本。 */
  stopComparison(): { rows: StopCounterfactual[]; summary: ReturnType<typeof summarizeStopCounterfactuals>; decisive: ReturnType<typeof summarizeStopCounterfactuals> } {
    const rows = this.stopCf;
    const decided = rows.filter((r) => r.atrTriggered || r.fixedTriggered);
    return {
      rows: rows.slice(-200),
      summary: summarizeStopCounterfactuals(rows),
      decisive: summarizeStopCounterfactuals(decided),
    };
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
    await writeFileAtomic(file, prev + `${c.date} ${c.time}  ${line}\n`);
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
      modelTransport:
        config.model === "jev"
          ? config.typesafeApiKey
            ? "jev-remote-configured"
            : "jev-fail-closed-not-configured"
          : config.model === "local"
            ? "local-file"
            : "rules-factor",
      llm: this.advisory.enabled ? config.llmModel : "off",
      paper: config.paper,
      universe: this.universe.entries.length,
      universeDate: this.universe.date,
      calendarStale: this.calendar.stale,
      eodOnly: this.eodOnly,
      startedAt: this.startedAtMs,
      port: config.port,
      // 决策口径（面板"常设命令"卡用）：节奏、单笔预算、本金与采纳阈值
      decideEveryMs: config.decideEveryMs,
      bankrollCny: config.bankrollCny,
      sizeCny: config.sizeCny,
      minProb: config.jevMinProb,
      stopLabel:
        config.stopMode === "atr"
          ? `次日止损触发线 −ATR×${config.atrK}（封底 −10%）`
          : `次日止损触发线 −${config.stopLossPct}%`,
      maxPositions: config.k,
      entryRule:
        config.model === "factor"
          ? `规则打分排序，取前 ${config.k} 只`
          : config.model === "jev"
            ? `Jev 净胜概率 ≥${Math.round(config.jevMinProb * 100)}%（未校准）`
            : `本地模型净胜概率 ≥${Math.round(config.jevMinProb * 100)}%（留出集校准）`,
      openWindow: `${hhmmOf(config.session.morningStart + config.openDelayMin)}–${hhmmOf(config.session.afternoonEnd)}`,
    };
  }

  private note(
    trading: boolean,
    phase: Phase,
    quotes: number,
    ms: number,
    ageSec: number,
    fresh: boolean,
    ztKnown: boolean,
  ): string {
    if (!trading) return `非交易日（${phase}），数据为最近收盘快照 ${Math.round(ms)}ms`;
    if (this.eodOnly) return "实时链路降级：只用日频，盘前出一次信号";
    if (phase === "lunch") return "午休";
    // 没快照与“快照老化”是两件事，说反了会把人引到错方向（收盘后本来就没活价）
    if (quotes === 0)
      return canTrade(phase) ? "还没有可用快照" : `${phase}：非盘中时段，本轮不拉实时快照`;
    if (ageSec < 0) return "拿不到行情自带的时间戳，新鲜度未知 → 本轮不出单不撮合";
    if (!fresh) return `行情已老化 ${ageSec}s > ${config.quoteStaleSec}s，本轮不出单不撮合`;
    // 情绪项拿不到时必须看得见：静默跳过一个否决项比关掉系统更危险
    if (liveQuotes(phase) && !ztKnown) return `${Math.round(ms)}ms · 涨停池未采到，情绪否决本轮跳过`;
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
  /** 通过硬筛选的可买候选集是否变化（新票进/出区间）→ 15 秒内立即响应 */
  codesChanged: boolean;
}): boolean {
  if (a.scoredCount <= 0) return false;
  if (a.force) return true;
  if (!a.trading) return false;
  // 盘前预选窗口：集合竞价 09:25 定型后到开盘前（此时开盘价已确定，竞价信息真实可得）
  const preMarket = a.minutes >= config.session.callAuctionEnd && a.minutes < config.session.morningStart;
  if (preMarket) return !a.preBuyDone;
  // 开盘稳定期：连续竞价开始后的前 OPEN_DELAY_MIN 分钟不开新仓（退出管理照常）
  if (a.minutes < config.session.morningStart + config.openDelayMin) return false;
  // 事件触发：可买候选集一变化就在 15 秒内响应（"看情况冲"），15s 下限防 API 哄抢。
  // 与常规节奏一样要求行情新鲜：拿隔夜/断流快照去问模型，得到的是一张落不了地的单，
  // 还会往对照实验的样本里注入不可执行轮次（journal 已会标 executable=false，但白问一次模型）。
  if (a.codesChanged && a.liveNow && a.usable && a.nowMs - a.lastBuyMs >= 15_000) return true;
  return a.liveNow && a.usable && a.nowMs - a.lastBuyMs >= config.decideEveryMs;
}

/** 两笔新仓之间是否已过最短间隔。抽成纯函数便于单测（防“同一分钟无脑冲多只”）。 */
export function canOpenNewPosition(nowMs: number, lastOpenMs: number, gapMs: number): boolean {
  return nowMs - lastOpenMs >= gapMs;
}

/** 影子对照里单个模型的判断结果（只留可比字段，理由/延迟这类不进流水）。 */
export interface ShadowOpinion {
  model: string;
  action: string;
  modelFailed?: boolean;
  trace?: Decision["trace"];
  picks: { code: string; probability: number }[];
}

/**
 * 影子对照的一行。`phase` 与 `executable` 必须显式写出来（false 也写），
 * 否则日后做“哪个模型更强”的对比时，盘后 force-scan 的隔夜快照会被当成有效样本 ——
 * 与对照实验同源的缺陷，抽成纯函数便于单测。
 */
export function buildShadowRow(a: {
  time: string;
  phase: Phase;
  executable: boolean;
  decision: Pick<Decision, "action" | "trace" | "picks">;
  shadow: ShadowOpinion[];
  ts?: number;
}): {
  ts: number;
  time: string;
  phase: Phase;
  executable: boolean;
  active: string;
  action: string;
  activeTrace: Decision["trace"];
  picks: { code: string; probability: number }[];
  shadow: ShadowOpinion[];
} {
  return {
    ts: a.ts ?? Date.now(),
    time: a.time,
    phase: a.phase,
    executable: a.executable,
    active: config.model,
    action: a.decision.action,
    activeTrace: a.decision.trace,
    picks: a.decision.picks.map((p) => ({ code: p.code, probability: p.probability })),
    shadow: a.shadow,
  };
}

export function clockNow(d: Date = new Date()): EngineClock {
  const b = bj(d);
  return { date: b.ymd, time: `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`, minutes: b.minutes };
}

export { sessionNow };
