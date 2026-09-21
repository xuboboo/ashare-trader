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
import { loadAtrMap } from "./atr";
import { stopCounterfactual, summarizeStopCounterfactuals, type StopCounterfactual } from "./exit";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { TradingCalendar } from "./calendar";
import { featuresFromSnapshot, gateLabel, ma5CloseBefore, marketGate, scoreStock, type Gate, type Scored } from "./factors";
import { FactorModel, type Decision, type DailyBias, type Model, type SignalState, LlmAdvisory } from "./model";
import { JevModel } from "./jev";
import { LocalModel } from "./local";
import { SellAdvisor, type SellAssistInput } from "./sell-assist";
import { makeBuyOrder, makeExitOrder, restingKey, restingKeys, settlePending, type Clock, type SuggestedOrder } from "./orders";
import { fetchIndexDaily, fetchIndex, fetchZtPool, fetchSnapshots, quoteAgeSec, type DailyBar, type Snapshot } from "./quotes";
import { riskBrake, type RiskBrake } from "./risk";
import { bj, canTrade, hhmmOf, liveQuotes, phaseOf, type Phase, sessionNow, tradingElapsedMin } from "./session";
import { Book, makeFill, round2, writeFileAtomic, type Fill } from "./state";
import { cannotAffordLot, lotAwareHalfQty } from "./symbols";
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
  /** 上一轮的可买候选代码集（事件触发的比较基准） */
  private lastEligibleKey = "";
  /** Jev 卖出辅助：上次评估的交易日（每日一次） */
  private sellAssistDate = "";
  private sellAdvisor = new SellAdvisor();
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
        // 退出单也必须进 pending：影子撮合不覆盖卖出腿的话，账本只进不出，
        // 整套退出阶梯（止损 / 高开减半 / 到点清仓）在影子路径上从未被执行，也就从未被验证。
        const exits = this.exitOrders(clock);
        newOrders.push(...exits);
        for (const o of exits) this.pending.set(o.signalId, o);
        if (exits.length) await this.persistPending();

        // ---- Jev 全程卖出决策：每个决策轮（40s）对每个可卖仓位问
        //      "立即离场 vs 按规则持有到明早10:00，哪个净收益更高"。
        //      硬底线不变：止损触发和 10:00 期限由规则无条件执行，Jev 不可推迟。----
        if (
          config.sellAssist &&
          config.typesafeApiKey
        ) {
          const sellableNow = [...this.book.positions.values()].filter((p) => {
            if (p.sellable <= 0) return false;
            const sn = this.snapshots.get(p.code);
            return sn && sn.price > 0;
          });
          if (sellableNow.length) {
            const inputs: SellAssistInput[] = sellableNow.map((p) => {
              const sn = this.snapshots.get(p.code)!;
              return {
                code: p.code,
                name: p.name,
                entry: p.avgPrice,
                price: sn.price,
                unrealizedPct: ((sn.price - p.avgPrice) / p.avgPrice) * 100,
                stop: p.stopPrice,
                heldDays: Math.max(1, Math.round((Date.parse(`${clock.date}T12:00:00Z`) - Date.parse(`${p.openDate}T12:00:00Z`)) / 86_400_000)),
              };
            });
            const advices = await this.sellAdvisor.advise(inputs);
            const hasSellOrder = new Set(newOrders.filter((o) => o.side === "sell").map((o) => o.code));
            for (const a of advices) {
              if (!a.suggestExit || a.pExitBetter === null || !Number.isFinite(a.pExitBetter)) continue;
              if (hasSellOrder.has(a.code)) continue; // 本轮硬规则已为该仓位生成卖出单，不重复
              const pos = this.book.positions.get(a.code);
              const sn = this.snapshots.get(a.code);
              if (!pos || !sn) continue;
              const o = makeExitOrder(pos, sn, clock, `Jev 卖出辅助（p=${(a.pExitBetter * 100).toFixed(0)}%）：确认弱势提前离场`, pos.sellable);
              if (o) {
                newOrders.push(o);
                this.pending.set(o.signalId, o);
              }
            }
          }
        }
      }

      const nowMs = Date.now();
      // 可买候选集（过硬筛选+买得起）的代码集：与上轮比较，"看情况冲"的事件源
      const codesKey = scored
        .filter((c) => c.rejects.length === 0 && c.score > 0 && !cannotAffordLot(c.features.price, config.sizeCny))
        .map((c) => c.features.code)
        .sort()
        .join(",");
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

        // 影子对照：其余模型对同一状态的判断也落盘（防"三选一"的模型挑选偏差）。
        // 只记录，不出单；失败静默跳过，绝不影响主链路。
        if (decision) {
          try {
            await this.recordShadow(clock, scored, gate, decision);
          } catch {
            /* 影子记录失败不影响主流程 */
          }
        }

        // 盘前预选只出观点；连续竞价与 force（复盘）出建议单
        if (force || (trading && liveQuotes(phase) && usable)) {
          const resting = restingKeys(this.pending);
          // 只有行情可用的窗口里才把单注册成在途单；否则 force（收盘后 /scan）只是
          // 复盘用的“本轮观点”，不能直接进 pending —— 不然面板上会看到一弹出单然后被作废。
          const register = trading && liveQuotes(phase) && usable;
          for (const pick of decision?.picks ?? []) {
            const s = scored.find((x) => x.features.code === pick.code);
            if (!s) continue;
            // 同一标的同时只留一张在途买单：决策每 60s 一轮，不去重就会把同一只股堆成几仓
            if (resting.has(restingKey({ code: s.features.code, side: "buy" }))) continue;
            // 已持仓的不重复加仓（与回测的 openPositions.has(code) 同一口径）
            if (this.book.positions.has(s.features.code)) continue;
            const vetoReason = this.bias?.vetoes[s.features.code];
            const order = makeBuyOrder(s, clock, vetoReason, config.sizeCny, this.atrMap.get(s.features.code));
            if (!order) continue;
            // 现金闸：建议金额超过可用现金就不出单（与回测同口径），账本不允许被买穿成负数
            if (order.amountCny + 50 > this.book.cash) continue;
            newOrders.push(order);
            resting.add(restingKey(order));
            if (register) this.pending.set(order.signalId, order);
          }
          if (register && newOrders.length) await this.persistPending();
        }
      }
    }

    // ---- 影子撮合 + 净值 ----
    // 当日单、隔日作废、本轮挂的不本轮成交 —— 具体口径在 orders.settlePending（有单测）
    const { fills, changed } = settlePending(this.pending, {
      snapshots: this.snapshots,
      clock,
      usable,
      paper: config.paper,
      roundStartMs,
      dayOver: phase === "after-hours" || phase === "closed",
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
      note: this.note(trading, phase, ok, performance.now() - t0, ageSec, quotesFresh, this.zt.known),
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

  private signalState(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "manage", risk: RiskBrake): SignalState {
    const held = [...this.book.positions.values()];
    const buysToday = this.book.openDateCount(clock.date);
    const openSlots = Math.max(0, config.maxDailyOpens - buysToday);
    return {
      date: clock.date,
      time: clock.time,
      horizon: mode === "buy" ? "尾盘买入、次日 10:00 前清仓" : "持仓退出",
      gate,
      index: this.lastIndex,
      candidates: scored,
      heldCodes: held.map((p) => p.code),
      allowed: {
        buy: mode === "buy" && gate.allowed && (this.bias?.allowOpen ?? true) && openSlots > 0 && !risk.buyBlocked,
        sell: held.some((p) => p.sellable > 0),
      },
      vetoes: this.bias?.vetoes ?? {},
      openSlots: Math.min(openSlots, config.k - held.length),
    };
  }

  private async decide(clock: EngineClock, scored: Scored[], gate: Gate, mode: "buy" | "manage"): Promise<Decision> {
    // 组合级风控闸：只封新开仓，不封退出（止损/清仓在亏损状态也必须走得掉）
    this.lastRisk = this.riskNow();
    const st = this.signalState(clock, scored, gate, mode, this.lastRisk);
    return this.model.decide(st);
  }

  /**
   * 影子对照：同一份状态喂给其余模型，把它们的判断追加落盘到 data/shadow/<date>.jsonl。
   * 目的：factor / local / jev 三选一容易变成"挑表现最好的"（回测过拟合）；
   * 从现在开始让它们在同一个状态上并行产出 forward 记录，未来对比才有资格。
   */
  private async recordShadow(clock: EngineClock, scored: Scored[], gate: Gate, active: Decision): Promise<void> {
    const models: Model[] = [];
    if (config.model !== "factor") models.push(new FactorModel());
    if (config.model !== "local") models.push(new LocalModel());
    if (config.model !== "jev" && config.typesafeApiKey) models.push(new JevModel());
    if (!models.length) return;
    const st = this.signalState(clock, scored, gate, "buy", this.riskNow());
    const shadow: { model: string; action: string; modelFailed?: boolean; picks: { code: string; probability: number }[] }[] = [];
    for (const m of models) {
      try {
        const d = await m.decide(st);
        shadow.push({ model: m.name, action: d.action, modelFailed: d.modelFailed, picks: d.picks.map((p) => ({ code: p.code, probability: p.probability })) });
      } catch {
        shadow.push({ model: m.name, action: "error", picks: [] });
      }
    }
    const row = {
      ts: Date.now(),
      time: clock.time,
      active: config.model,
      action: active.action,
      picks: active.picks.map((p) => ({ code: p.code, probability: p.probability })),
      shadow,
    };
    const dir = join(config.dataDir, "shadow");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${clock.date}.jsonl`);
    const prev = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    await writeFileAtomic(file, prev + JSON.stringify(row) + "\n");
  }

  /**
   * 持仓退出阶梯（每轮评估，规则间互斥触发、谁先命中执行谁）：
   *   1. 开盘浮盈 ≥ GAP_TRIM_PCT（相对买入成本，只评估一次，卖整手约束下的一半）
   *   2. 到点 FORCE_EXIT_AT 无条件清仓（策略期限，非交易所规定）
   *   3. 跌破止损价全走
   *   4. 跌破分时均线连续 VWAP_CONFIRM_ROUNDS 轮 → 弱势离场
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
      // 否则“开盘减半”与“到点清仓/止损”两张单会同时挂着，然后双双成交，卖出量超过持仓量。
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

      // ---- 1) 开盘浮盈止盈：当日只评估一次，以今日开盘价对成本计（GPT 复核采纳：
      //         旧实现用 3 秒价变动当"高开"，实为永远打不中的死代码）----
      if (!p.openingTpDone && sn.open > 0 && p.avgPrice > 0) {
        p.openingTpDone = true; // 无论是否触发，当日只评估这一次
        const openPnlPct = ((sn.open - p.avgPrice) / p.avgPrice) * 100;
        if (openPnlPct >= config.gapTrimPct) {
          const half = lotAwareHalfQty(p.sellable);
          // 本轮只动作一张单；剩仓交给下一轮的止损/到点/弱势规则（人也就是这么做的）
          if (half >= 100 && emit(`开盘浮盈 ${openPnlPct.toFixed(2)}% ≥ ${config.gapTrimPct}%，先卖一半`, half)) continue;
          // half < 100：整手约束下无法分批，维持全仓交由止损/期限规则处理
        }
      }

      // ---- 2) 硬期限 / 3) 止损 ----
      if (clock.minutes >= config.forceExitMin) {
        emit(`到点 ${hhmmOf(config.forceExitMin)} 无条件清仓（策略期限）`, p.sellable);
        continue;
      }
      if (sn.price <= p.stopPrice) {
        emit(`跌破止损 ${p.stopPrice}`, p.sellable);
        continue;
      }

      // ---- 4) 分时均线弱势：连续确认轮数防 3 秒噪声 ----
      if (clock.minutes >= config.session.morningStart + 15 && sn.vwap > 0) {
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
    const clock = clockNow();
    const sn = this.snapshots.get(args.code);
    const name = sn?.name ?? this.universe.nameOf(args.code);
    const price = args.price ?? sn?.price ?? 0;
    if (!(price > 0)) throw new Error(`不知道 ${args.code} 的价格，请显式给 price`);
    const b1 = sn?.bids[0]?.p ?? 0;
    const a1 = sn?.asks[0]?.p ?? 0;
    // 先找到它对应的那张建议单：回填的真实成交必须沿用建议单算好的止损线（含 ATR 口径），
    // 否则“人工回填”这一条路会把 STOP_MODE 弄成装饰。
    const matched = args.signalId ? this.pending.get(args.signalId) : undefined;
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
  // 事件触发：可买候选集一变化就在 15 秒内响应（"看情况冲"）；否则按常规节奏
  if (a.codesChanged && a.nowMs - a.lastBuyMs >= 15_000) return true;
  return a.liveNow && a.usable && a.nowMs - a.lastBuyMs >= config.decideEveryMs;
}

export function clockNow(d: Date = new Date()): EngineClock {
  const b = bj(d);
  return { date: b.ymd, time: `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`, minutes: b.minutes };
}

export { sessionNow };
