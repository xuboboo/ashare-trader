/**
 * 事件驱动回测：严格 T+1、涨停买不进、一字跌停卖不出、最低佣金与印花税。
 *
 * 与实盘共用同一份 factors.scoreStock / costs / Book，所以"回测好看、实盘亏钱"
 * 这类差异只能来自行情口径（日线 vs 尾盘快照），不会来自账务和打分。
 *
 * 已知的日线近似（诚实写在脸上）：
 *  - 尾盘买入价 = 当日收盘 + 1 tick
 *  - "次日 10:00 前清仓" = 次日收盘卖出（没有分钟线，只能用收盘价代理）
 *  - 止损 = 次日最低价触及止损价则按止损价成交；若开盘已跳空低于止损价则按开盘价
 *  - 大盘闸门的成交额用上证指数日线，实盘用当日累计，两者一致
 *
 * 用法：
 *   bun run scripts/backtest.ts
 *   bun run scripts/backtest.ts --from=2025-01-01 --k=3 --gain-min=3
 *   bun run scripts/backtest.ts --sweep
 */
import { join } from "node:path";
import { config, hhmm } from "../src/config";
import { roundTrip } from "../src/costs";
import { nextDayExit, stopLevel } from "../src/exit";
import { featuresFromDaily, marketGate, scoreStock, type FactorParams, type Scored } from "../src/factors";
import { fetchIndexDaily, type DailyBar } from "../src/quotes";
import { riskBrake } from "../src/risk";
import { Book, makeFill, round2 } from "../src/state";
import { inScope, limitPct } from "../src/symbols";
import { hhmmOf, tradingElapsedMin } from "../src/session";

/** 回测模拟的入场时刻：尾盘下单。闸门的时间折算与成交时间都用它，不再写死两处。 */
const ENTRY_AT = hhmm("14:45", 885);
const ENTRY_LABEL = hhmmOf(ENTRY_AT);

interface Args {
  from: string;
  to: string;
  k: number;
  gainMin: number;
  gainMax: number;
  vrMin: number;
  minAmountYi: number;
  sizeCny: number;
  /** 止损口径写进命令行，不隐式跟着 .env 走：--stop=fixed|atr（atr 用 ATR_K） */
  stopMode: "fixed" | "atr";
  /** 选股方式：--select=score|random|reverse（后两个是排序有效性的对照基准） */
  select: "score" | "random" | "reverse";
  /**
   * 是否开组合风控闸（--risk-gate=true 才开）。
   * 默认关：门槛回答的是“这个策略本身有没有正期望”，而风控闸只决定“什么时候不再下注”。
   * 对负期望策略，开闸会因为提前停手而把数字变“好看”（并且截断样本），
   * 那是资金保护效果，不是 edge 变好了 —— 两者必须分开量。
   */
  riskGate: boolean;
  sweep: boolean;
}

function parseArgs(argv: string[]): Args {
  const g = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
  return {
    from: g("from", ""),
    to: g("to", ""),
    k: Number(g("k", String(config.k))) || config.k,
    gainMin: Number(g("gain-min", String(config.gainMinPct))),
    gainMax: Number(g("gain-max", String(config.gainMaxPct))),
    vrMin: Number(g("vr-min", String(config.volumeRatioMin))),
    minAmountYi: Number(g("min-amount", String(config.minAmountYi))),
    sizeCny: Number(g("size", String(config.sizeCny))),
    stopMode: g("stop", config.stopMode) === "atr" ? "atr" : "fixed",
    select: (g("select", "score") === "random" ? "random" : g("select", "score") === "reverse" ? "reverse" : "score"),
    riskGate: g("risk-gate", "false") === "true",
    sweep: argv.includes("--sweep"),
  };
}

export interface Stock {
  code: string;
  bars: DailyBar[];
  byDate: Map<string, DailyBar>;
}

/** 读本地日线（data/daily/*.json），训练脚本与回测共用。 */
export async function loadStocks(): Promise<Stock[]> {
  const dir = join(config.dataDir, "daily");
  const out: Stock[] = [];
  let estimated = 0;
  for await (const f of new Bun.Glob("*.json").scan({ cwd: dir })) {
    const code = f.replace(/\.json$/, "");
    if (code.startsWith("_") || !inScope(code)) continue;
    const j = await Bun.file(join(dir, f)).json().catch(() => null);
    const bars: DailyBar[] = j?.bars ?? [];
    if (bars.length < 70) continue;
    if (j?.amountEst) estimated++;
    out.push({ code, bars, byDate: new Map(bars.map((b) => [b.date, b])) });
  }
  if (estimated) console.log(`注意：${estimated}/${out.length} 支的成交额是用 (高+低+收)/3 估算的（腾讯/新浪没有这个字段）`);
  out.sort((a, b) => b.bars.length - a.bars.length);
  return out;
}

export interface BtResult {
  params: string;
  trades: number;
  wins: number;
  winRate: number;
  grossBps: number;
  netBps: number;
  costBps: number;
  meanTripBps: number;
  /**
   * 逐笔净期望的标准差与 t 统计量（等权口径，不是本金加权）。
   * 没有它们，36 组参数里挑出来的最大值只是噪声；|t| < 2 就是“与零不可区分”。
   */
  sdTripBps: number;
  tStat: number;
  notionalYuan: number;
  costYuan: number;
  grossProfitYuan: number;
  profitOverCost: number;
  finalEquity: number;
  totalReturnPct: number;
  annualizedPct: number;
  maxDrawdownPct: number;
  skippedAtLimit: number;
  /** 因日亏损/回撤风控闸而没开仓的交易日数（实盘会空仓、旧回测照买的那部分） */
  blockedByRiskDays: number;
  /** 数据结束时还持着的仓（当日买入 T+1 卖不掉）：买入成本已计、本金未进分母，净期望因此偏保守 */
  openAtEnd: number;
  days: number;
  /** 每一笔往返，用于审计 T+1 与逐笔归因 */
  trips: { code: string; entryDate: string; exitDate: string; entry: number; exit: number; qty: number; bps: number; note: string }[];
  passed: boolean;
  verdict: string;
}

export interface SimInput {
  stocks: Stock[];
  indexBars: DailyBar[];
  from?: string;
  to?: string;
  k?: number;
  /** 显式传参；默认取 config.bankrollCny。回测结果必须与 .env 无关才可复现、可对比 */
  bankrollCny?: number;
  sizeCny?: number;
  /** 止损模式：fixed = 固定百分比（默认）；atr = 买入价 − k×ATR₁₄（封底 entry×90%） */
  stopMode?: "fixed" | "atr";
  atrK?: number;
  atrN?: number;
  /** 以下四项旧实现直读全局 config —— 扫参与实盘不可复现的根源，现在全部可注入 */
  stopLossPct?: number;
  gapTrimPct?: number;
  maxDailyOpens?: number;
  /** 风控闸阈值：传 0 = 关闭（与 config 的 0=关闭 同一语义）；不传取 .env */
  dayLossPct?: number;
  drawdownPct?: number;
  /** 默认关闸（测策略本身）；要看实盘那套风控对资金曲线的效果就传 true */
  riskGate?: boolean;
  /**
   * 选股方式：score = 按因子分取前 K（默认，与实盘一致）；random = 同日同候选集里确定性随机取 K；
   * reverse = 取分数最低的 K。
   * 后两个是基准：只跟“空仓”比不能证明排序有效，必须跟“乱选”比。
   * 如果 random 与 score 差不多，那得分本身就没有信息量。
   */
  select?: "score" | "random" | "reverse";
  gainMin?: number;
  gainMax?: number;
  vrMin?: number;
  minAmountYi?: number;
  quiet?: boolean;
}

/** 纯计算：不碰磁盘也不碰网络，测试直接喂合成数据。 */
export function simulate(input: SimInput): { result: BtResult; log: string[] } {
  const stocks = input.stocks;
  const indexBars = input.indexBars;
  const a: Args = {
    ...parseArgs([]),
    from: input.from ?? "",
    to: input.to ?? "",
    k: input.k ?? config.k,
    sizeCny: input.sizeCny ?? config.sizeCny,
    gainMin: input.gainMin ?? config.gainMinPct,
    gainMax: input.gainMax ?? config.gainMaxPct,
    vrMin: input.vrMin ?? config.volumeRatioMin,
    minAmountYi: input.minAmountYi ?? config.minAmountYi,
  };
  const fp: FactorParams = {
    gainMinPct: a.gainMin,
    gainMaxPct: a.gainMax,
    volumeRatioMin: a.vrMin,
    minAmountYi: a.minAmountYi,
    minMcapYi: config.minMcapYi,
  };
  const log: string[] = [];
  const P = (s: string) => {
    log.push(s);
    if (!input.quiet) console.log(s);
  };

  // 出场/风控参数全部显式化：以前这几个直读全局 config，扫参结果会跟着 .env 静默变
  const stopLossPct = input.stopLossPct ?? config.stopLossPct;
  const gapTrimPct = input.gapTrimPct ?? config.gapTrimPct;
  const maxDailyOpens = input.maxDailyOpens ?? config.maxDailyOpens;
  // --risk-gate=false 与 input.riskGate=false 两条路都要认：0 = 闸关闭
  const riskGateOn = input.riskGate !== false;
  const dayLossPct = input.dayLossPct ?? (riskGateOn ? config.maxDayLossPct : 0);
  const drawdownPct = input.drawdownPct ?? (riskGateOn ? config.maxDrawdownPct : 0);

  const bankrollCny = input.bankrollCny ?? config.bankrollCny;
  const book = new Book(bankrollCny);
  const dates = indexBars.map((b) => b.date).filter((d) => (!a.from || d >= a.from) && (!a.to || d <= a.to));
  const heldUntil = new Map<string, string>(); // code -> 计划退出日（次日）
  const openPositions = new Map<string, { qty: number; entry: number; entryDate: string; stop: number }>();
  let skippedAtLimit = 0;
  let blockedByRisk = 0;
  let costYuan = 0;
  let grossProfitYuan = 0;
  let notionalYuan = 0; // 每笔卖出时压在风险上的本金
  const roundTrips: { code: string; bps: number; date: string }[] = [];
  const trips: BtResult["trips"] = [];

  // 预先把每支股的 日期->下标 与 前 5 日均量算好：否则 36 组参数扫描会跑到天荒地老
  const stockByCode = new Map(stocks.map((s) => [s.code, s]));
  const idxOf = new Map<string, Map<string, number>>();
  const vol5 = new Map<string, (number | undefined)[]>();
  // ATR₁₄（简单均值版）：stopMode=atr 时决定止损距离；不足 14 根为 undefined → 回退 fixed
  const atrK = input.atrK ?? 2.5;
  const atrN = input.atrN ?? 14;
  const atr14 = new Map<string, (number | undefined)[]>();
  const indexIdx = new Map(indexBars.map((b, i) => [b.date, i]));
  for (const s of stocks) {
    const m = new Map<string, number>();
    s.bars.forEach((b, i) => m.set(b.date, i));
    idxOf.set(s.code, m);
    vol5.set(
      s.code,
      s.bars.map((_, i) => {
        if (i < 5) return undefined;
        let sum = 0;
        for (let j = i - 5; j < i; j++) sum += s.bars[j]!.volumeHands;
        return sum / 5;
      }),
    );
    const tr = s.bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = s.bars[i - 1]!.close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
    atr14.set(
      s.code,
      s.bars.map((_, i) => {
        if (i < atrN) return undefined;
        let sum = 0;
        for (let j = i - atrN + 1; j <= i; j++) sum += tr[j]!;
        return sum / atrN;
      }),
    );
  }
  /** 标的是今天有价，还是沿用上一个已知价（停牌） */
  const lastPrice = new Map<string, number>();

  const priceOf = (code: string): number | undefined => lastPrice.get(code);

  for (const date of dates) {
    // ---- T+1 日切：昨日买入今日解锁可卖 ----
    book.rollover(date);

    // ---- 1) 先处理昨日持仓的退出（次日行为）----
    for (const [code, pos] of [...openPositions]) {
      const s = stockByCode.get(code);
      const bar = s?.byDate.get(date);
      if (!bar) continue; // 停牌：卖不掉，继续持有
      const p = book.positions.get(code);
      if (!p || p.sellable <= 0) continue; // T+1 兜底（正常不会发生）
      const bi = idxOf.get(code)?.get(date) ?? 0;
      const prevBar = s!.bars[bi - 1];
      const outcome = nextDayExit({
        next: bar,
        prevClose: prevBar?.close ?? bar.open,
        entry: pos.entry,
        stop: pos.stop,
        qty: p.sellable,
        gapTrimPct,
        limitPctFrac: limitPct(code, ""),
      });
      if (!outcome.legs.length) {
        skippedAtLimit++;
        continue; // 一字跌停卖不出
      }
      const legs = outcome.legs;
      const exitPrice = legs[0]!.price;
      const note = outcome.note;
      for (const leg of legs) {
        const qty = leg.qty;
        if (qty < 100) continue;
        const legNotional = round2(pos.entry * qty);
        notionalYuan += legNotional;
        const fill = makeFill({
          code,
          name: code,
          side: "sell",
          price: leg.price,
          qty,
          date,
          time: "15:00",
          kind: "paper",
          note: leg.note,
        });
        const realized = book.applyFill(fill);
        costYuan += fill.costs.total;
        grossProfitYuan += (leg.price - pos.entry) * qty;
        roundTrips.push({ code, bps: round2(((realized ?? 0) / legNotional) * 10_000), date });
        trips.push({
          code,
          entryDate: pos.entryDate,
          exitDate: date,
          entry: pos.entry,
          exit: leg.price,
          qty,
          bps: round2(((realized ?? 0) / legNotional) * 10_000),
          note: leg.note,
        });
      }
      openPositions.delete(code);
      heldUntil.delete(code);
    }

    // ---- 2) 大盘闸门 + 组合风控 ----
    const ii = indexIdx.get(date) ?? 0;
    const idxBar = indexBars[ii]!;
    let ma5: number | null = null;
    if (ii >= 5) {
      let sum = 0;
      for (let j = ii - 5; j < ii; j++) sum += indexBars[j]!.close;
      ma5 = sum / 5;
    }
    // 闸门口径与实盘对齐：实盘在 14:45 下单，那里看到的成交额就是这根日线的全天累计值，
    // 所以折算用的已交易时长也必须取同一个时刻 —— 不传就变成“全天阈值 vs 尾盘成交”，两边差 6%。
    const gate = marketGate(
      { price: idxBar.close, amountYi: idxBar.amountYuan / 1e8 },
      ma5,
      null, // 涨停家数没有历史可回测，与实盘同一个已知缺口（实盘只在 09:30 后采得到）
      tradingElapsedMin(ENTRY_AT),
    );
    // 组合级风控闸（与实盘同一个 riskBrake）：旧回测没接入，于是“实盘会空仓的日子”回测照买。
    // 此时仓位还按昨日收盘价盯市，没有未来信息。
    const risk = riskBrake({
      equity: book.totals().equity,
      dayStartEquity: book.dayStartEquity,
      peakEquity: book.peakEquity,
      dayLossLimitPct: dayLossPct,
      drawdownLimitPct: drawdownPct,
    });
    if (risk.buyBlocked) blockedByRisk++;

    // ---- 3) 打分并开新仓（尾盘买入）----
    if (gate.allowed && !risk.buyBlocked) {
      const scored: Scored[] = [];
      for (const s of stocks) {
        const bi = idxOf.get(s.code)?.get(date);
        if (bi === undefined) continue;
        const bar = s.bars[bi]!;
        const prevBar = s.bars[bi - 1];
        const av5 = vol5.get(s.code)?.[bi];
        const f = featuresFromDaily(bar, prevBar, av5, s.code, s.code);
        const sc = scoreStock(f, {}, false, fp);
        if (sc.rejects.length) continue;
        scored.push(sc);
      }
      const ranked = [...scored];
      if (input.select === "random") {
        // 确定性洗牌（按日期做种子）：同一天的候选在任何参数组下都抽到同一批，可复现
        let seed = 0;
        for (const ch of date) seed = (seed * 131 + ch.charCodeAt(0)) >>> 0;
        for (let i = ranked.length - 1; i > 0; i--) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const j = seed % (i + 1);
          [ranked[i], ranked[j]] = [ranked[j]!, ranked[i]!];
        }
      } else if (input.select === "reverse") {
        ranked.reverse();
      } else {
        ranked.sort((x, y) => y.score - x.score);
      }
      const picks = ranked.slice(0, a.k);
      for (const pick of picks) {
        const code = pick.features.code;
        if (openPositions.has(code)) continue;
        if (book.openDateCount(date) >= maxDailyOpens) break;
        if (openPositions.size >= a.k) break;
        const bar = pick.features;
        if (bar.oneLineUp || bar.price >= bar.limitUp) {
          skippedAtLimit++;
          continue; // 封板买不进
        }
        const entryPrice = round2(bar.price + 0.01);
        if (entryPrice > bar.limitUp) {
          skippedAtLimit++;
          continue;
        }
        const atr = input.stopMode === "atr" ? atr14.get(code)?.[idxOf.get(code)?.get(date) ?? -1] : undefined;
        const stop = stopLevel(entryPrice, {
          mode: input.stopMode === "atr" ? "atr" : "fixed",
          atr,
          k: atrK,
          fixedPct: stopLossPct,
        });
        const qty = Math.floor(a.sizeCny / entryPrice / 100) * 100;
        if (qty < 100) continue;
        const amount = round2(entryPrice * qty);
        // 现金闸直接读账本：旧实现读的是一天开始时拷出来的局部 cash，当日买一笔不递减，
        // 三笔单每笔都拿全量现金去比 → 一天内可以把账本买穿，而实盘读的是实时 cash。
        if (amount + 50 > book.cash) continue; // 现金不够
        const fill = makeFill({
          code,
          name: code,
          side: "buy",
          price: entryPrice,
          qty,
          date,
          time: ENTRY_LABEL,
          kind: "paper",
          stopPrice: stop,
          note: "尾盘买入",
        });
        book.applyFill(fill);
        costYuan += fill.costs.total;
        openPositions.set(code, { qty, entry: entryPrice, entryDate: date, stop });
        heldUntil.set(code, date);
      }
    }

    // 先刷新最后已知价，再盯市（停牌的日子沿用上一日价）
    for (const s of stocks) {
      const bar = s.byDate.get(date);
      if (bar) lastPrice.set(s.code, bar.close);
    }
    const marks = new Map<string, number>();
    for (const code of book.positions.keys()) {
      const px = priceOf(code);
      if (px && px > 0) marks.set(code, px);
    }
    book.markToMarket(marks);
    // 权益曲线交给 Book.recordEquity：它同时维护 peakEquity（回撤闸的基准），
    // 这样风控闸与面板/实盘用的是同一个峰值。
    book.recordEquity(date);
  }

  // ---- 收尾：数据结束仍在持有的，按最后价平掉（计入逐笔明细，否则权益与明细对不上）----
  const lastDate = dates.at(-1) ?? "";
  for (const [code, pos] of [...openPositions]) {
    const p = book.positions.get(code);
    if (!p || p.sellable <= 0) continue;
    const px = priceOf(code) ?? pos.entry;
    const qty = p.sellable;
    const legNotional = round2(pos.entry * qty);
    notionalYuan += legNotional;
    const fill = makeFill({ code, name: code, side: "sell", price: px, qty, date: lastDate, time: "15:00", kind: "paper", note: "回测结束平仓" });
    const realized = book.applyFill(fill);
    costYuan += fill.costs.total;
    grossProfitYuan += (px - pos.entry) * qty;
    const bps = round2(((realized ?? 0) / legNotional) * 10_000);
    roundTrips.push({ code, bps, date: lastDate });
    trips.push({ code, entryDate: pos.entryDate, exitDate: lastDate, entry: pos.entry, exit: px, qty, bps, note: "回测结束平仓" });
    openPositions.delete(code);
  }

  const t = book.totals();
  const wins = roundTrips.filter((r) => r.bps > 0).length;
  const trades = roundTrips.length;
  // 本金加权：真的赚到的钱 / 压在风险上的本金。
  // 算术平均会被“小仓位 + 低股价”那种高 bps 腿带偏（它们分母小），所以门槛看加权值。
  const grossBps = notionalYuan > 0 ? round2((grossProfitYuan / notionalYuan) * 10_000) : 0;
  const costBps = notionalYuan > 0 ? round2((costYuan / notionalYuan) * 10_000) : 0;
  const netBps = round2(grossBps - costBps);
  const meanTripBps = trades ? round2(roundTrips.reduce((s, r) => s + r.bps, 0) / trades) : 0;
  // 等权 t：用于判断“每笔期望”能不能与 0 区分。本金加权是金额口径，不适合做检验。
  const sdTripBps =
    trades > 1
      ? round2(Math.sqrt(roundTrips.reduce((s, r) => s + (r.bps - meanTripBps) ** 2, 0) / (trades - 1)))
      : 0;
  const tStat = trades > 1 && sdTripBps > 0 ? round2(meanTripBps / (sdTripBps / Math.sqrt(trades))) : 0;
  const years = Math.max(0.25, dates.length / 244);
  const growth = t.equity / bankrollCny;
  const totalReturnPct = (growth - 1) * 100;
  const annualized = growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : -100;
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of book.equityCurve) {
    peak = Math.max(peak, e.equity);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - e.equity) / peak) * 100 : 0);
  }
  const profitOverCost = costYuan > 0 ? grossProfitYuan / costYuan : 0;
  const passed = annualized > 0 && netBps > 0 && profitOverCost > 2.5;

  const sizeLabel = a.sizeCny >= 10000 ? `${(a.sizeCny / 10000).toFixed(1)}万` : `${Math.round(a.sizeCny)}元`;
  // 名义往返成本（按预算整数算）：与下面实测的 costBps 并排打印，两者差多少
  // 就是“一手取整 + 高价股买不满预算”吃掉的 —— 3300 元这一档两者差 8bp 以上。
  const roundTripBps = roundTrip(a.sizeCny).bps;
  const params =
    `K=${a.k} 涨幅 ${a.gainMin}-${a.gainMax}% 量比≥${a.vrMin} 成交额≥${a.minAmountYi}亿 ` +
    `选股${input.select ?? "score"} 单笔${sizeLabel} 入场${ENTRY_LABEL} 止损${input.stopMode === "atr" ? `ATR×${atrK}(封底10%)` : `${stopLossPct}%`} ` +
    `高开减半≥${gapTrimPct}% 日开仓≤${maxDailyOpens} 往返成本名义${roundTripBps.toFixed(1)}bp ` +
    `风控闸${dayLossPct > 0 || drawdownPct > 0 ? `开(日亏${dayLossPct}%/回撤${drawdownPct}%)` : "关"}`;
  const result: BtResult = {
    params,
    trades,
    wins,
    winRate: trades ? round2((wins / trades) * 100) : 0,
    grossBps,
    netBps,
    costBps,
    meanTripBps,
    sdTripBps,
    tStat,
    notionalYuan: round2(notionalYuan),
    costYuan: round2(costYuan),
    grossProfitYuan: round2(grossProfitYuan),
    profitOverCost: round2(profitOverCost),
    finalEquity: t.equity,
    totalReturnPct: round2(totalReturnPct),
    annualizedPct: round2(annualized),
    maxDrawdownPct: round2(maxDd),
    skippedAtLimit,
    blockedByRiskDays: blockedByRisk,
    openAtEnd: book.positions.size,
    days: dates.length,
    trips,
    passed,
    verdict: passed
      ? "通过：进 Phase 3/4"
      : `不通过：每笔本金加权净期望 ${netBps}bp（毛利 ${grossBps}bp - 成本 ${costBps}bp），在真实成本下没有正期望，停在回测层`,
  };

  P("");
  P(`回测样本：${stocks.length} 支，指数日线 ${indexBars.length} 根（${indexBars[0]?.date} ~ ${indexBars.at(-1)?.date}）`);
  P(`参数      ${params}`);
  P(`交易日    ${result.days}   成交腿 ${result.trades}   胜率 ${result.winRate}%`);
  P(`每笔期望  毛利 ${result.grossBps}bp - 成本 ${result.costBps}bp = 净 ${result.netBps}bp（本金加权；算术平均 ${result.meanTripBps}bp，σ=${result.sdTripBps}bp，t=${result.tStat}${Math.abs(result.tStat) < 2 ? " → 与零不可区分" : ""}）`);
  P(`金额      毛利 ${result.grossProfitYuan} 元   总成本 ${result.costYuan} 元   累计本金 ${result.notionalYuan} 元   收益/成本 ${result.profitOverCost}`);
  P(`期末权益  ${result.finalEquity} 元   总收益 ${result.totalReturnPct}%   年化 ${result.annualizedPct}%   最大回撤 ${result.maxDrawdownPct}%`);
  P(`封板跳过  ${result.skippedAtLimit} 次（涨停买不进 / 一字跌停卖不出）`);
  P(`风控空仓  ${result.blockedByRiskDays} 个交易日因日亏损/回撤闸停止开仓；期末尚持 ${result.openAtEnd} 仓（T+1 卖不掉，买入成本已计但本金未进分母 → 净期望偏保守）`);
  if (result.blockedByRiskDays > 0)
    P(`        ⚠ 本轮是开闸口径：${result.blockedByRiskDays}/${result.days} 天没下注，成交腿只是完整样本的一部分 —— 上面的净期望不能当策略期望读（那要 --risk-gate=false 的数）`);
  P(`门槛      ${result.verdict}`);
  return { result, log };
}

/** 读本地日线 + 指数，再交给 simulate。 */
export async function runBacktest(args: Partial<Args> = {}): Promise<{ result: BtResult; log: string[] }> {
  const a: Args = { ...parseArgs([]), ...args };
  const log: string[] = [];
  const P = (s: string) => {
    log.push(s);
    console.log(s);
  };

  const stocks = await loadStocks();
  if (stocks.length < 5) {
    P(`!! 只有 ${stocks.length} 支日线，先跑 bun run scripts/fetch-daily.ts --sample=60`);
    return { result: emptyResult("no-data"), log };
  }
  const indexBars = await fetchIndexDaily(800).catch(() => [] as DailyBar[]);
  if (indexBars.length < 30) {
    P("!! 上证指数日线拉不到，闸门无法计算，回测中止");
    return { result: emptyResult("no-index"), log };
  }
  const r = await Promise.resolve(
    simulate({
      stocks,
      indexBars,
      from: a.from,
      to: a.to,
      k: a.k,
      sizeCny: a.sizeCny,
      stopMode: a.stopMode,
      riskGate: a.riskGate,
      select: a.select,
      atrK: config.atrK,
      gainMin: a.gainMin,
      gainMax: a.gainMax,
      vrMin: a.vrMin,
      minAmountYi: a.minAmountYi,
    }),
  );
  return { result: r.result, log: [...log, ...r.log] };
}

function emptyResult(params: string, bankrollCny = config.bankrollCny): BtResult {
  return {
    params,
    trades: 0,
    wins: 0,
    winRate: 0,
    grossBps: 0,
    netBps: 0,
    costBps: 0,
    meanTripBps: 0,
    sdTripBps: 0,
    tStat: 0,
    notionalYuan: 0,
    costYuan: 0,
    grossProfitYuan: 0,
    profitOverCost: 0,
    finalEquity: bankrollCny,
    totalReturnPct: 0,
    annualizedPct: 0,
    maxDrawdownPct: 0,
    skippedAtLimit: 0,
    blockedByRiskDays: 0,
    openAtEnd: 0,
    days: 0,
    trips: [],
    passed: false,
    verdict: "没有数据",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sweep) {
    const { result, log } = await runBacktest(args);
    await Bun.write(join(config.dataDir, "backtest.txt"), log.join("\n"));
    await Bun.write(join(config.dataDir, "backtest.json"), JSON.stringify(result, null, 1));
    return;
  }
  const rows: BtResult[] = [];
  for (const k of [1, 2, 3, 5]) {
    for (const gainMin of [2, 3, 4]) {
      for (const vrMin of [1.2, 1.5, 2.0]) {
        const { result } = await runBacktestQuiet({ ...args, k, gainMin, vrMin });
        rows.push(result);
      }
    }
  }
  const lines = [
    "K\t涨幅下限\t量比下限\t成交腿\t胜率%\t净bps\t毛利bps\t成本bps\t等均bps\tσbps\tt值\t收益/成本\t年化%\t回撤%\t通过",
  ];
  for (const r of rows) {
    const m = r.params.match(/K=(\d+) 涨幅 ([\d.]+)-(\d+)% 量比≥([\d.]+)/);
    const [k, gm, , vm] = m?.slice(1) ?? ["", "", "", ""];
    lines.push(
      `${k}\t${gm}\t${vm}\t${r.trades}\t${r.winRate}\t${r.netBps}\t${r.grossBps}\t${r.costBps}\t${r.meanTripBps}\t${r.sdTripBps}\t${r.tStat}\t${r.profitOverCost}\t${r.annualizedPct}\t${r.maxDrawdownPct}\t${r.passed ? "Y" : "N"}`,
    );
  }
  lines.push("# 口径：单笔与本金取 .env；风控闸默认关（测策略本身）；止损取 --stop；t 值是等权口径，|t|<2 即与零不可区分");
  await mkdirOut();
  await Bun.write(join(config.dataDir, "sweep.tsv"), lines.join("\n"));
  console.log(lines.join("\n"));
}

async function runBacktestQuiet(a: Args): Promise<{ result: BtResult; log: string[] }> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await runBacktest(a);
  } finally {
    console.log = orig;
  }
}

async function mkdirOut() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(config.dataDir, { recursive: true });
}

if (import.meta.main) await main();
