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
import { config } from "../src/config";
import { featuresFromDaily, marketGate, scoreStock, type FactorParams, type Scored } from "../src/factors";
import { fetchIndexDaily, type DailyBar } from "../src/quotes";
import { Book, makeFill, round2 } from "../src/state";
import { inScope, limitPct } from "../src/symbols";

interface Args {
  from: string;
  to: string;
  k: number;
  gainMin: number;
  gainMax: number;
  vrMin: number;
  minAmountYi: number;
  sizeCny: number;
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
    sweep: argv.includes("--sweep"),
  };
}

export interface Stock {
  code: string;
  bars: DailyBar[];
  byDate: Map<string, DailyBar>;
}

async function loadStocks(): Promise<Stock[]> {
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
  notionalYuan: number;
  costYuan: number;
  grossProfitYuan: number;
  profitOverCost: number;
  finalEquity: number;
  totalReturnPct: number;
  annualizedPct: number;
  maxDrawdownPct: number;
  skippedAtLimit: number;
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
  sizeCny?: number;
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

  const book = new Book(config.bankrollCny);
  let cash = book.cash;
  const dates = indexBars.map((b) => b.date).filter((d) => (!a.from || d >= a.from) && (!a.to || d <= a.to));
  const heldUntil = new Map<string, string>(); // code -> 计划退出日（次日）
  const openPositions = new Map<string, { qty: number; entry: number; entryDate: string; stop: number }>();
  const equitySeries: { date: string; equity: number }[] = [];
  let skippedAtLimit = 0;
  let costYuan = 0;
  let grossProfitYuan = 0;
  let notionalYuan = 0; // 每笔卖出时压在风险上的本金
  const roundTrips: { code: string; bps: number; date: string }[] = [];
  const trips: BtResult["trips"] = [];

  // 预先把每支股的 日期->下标 与 前 5 日均量算好：否则 36 组参数扫描会跑到天荒地老
  const stockByCode = new Map(stocks.map((s) => [s.code, s]));
  const idxOf = new Map<string, Map<string, number>>();
  const vol5 = new Map<string, (number | undefined)[]>();
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
  }
  /** 标的是今天有价，还是沿用上一个已知价（停牌） */
  const lastPrice = new Map<string, number>();

  const priceOf = (code: string): number | undefined => lastPrice.get(code);

  for (const date of dates) {
    // ---- T+1 日切：昨日买入今日解锁可卖 ----
    book.rollover(date);
    cash = book.cash;

    // ---- 1) 先处理昨日持仓的退出（次日行为）----
    for (const [code, pos] of [...openPositions]) {
      const s = stockByCode.get(code);
      const bar = s?.byDate.get(date);
      if (!bar) continue; // 停牌：卖不掉，继续持有
      const p = book.positions.get(code);
      if (!p || p.sellable <= 0) continue; // T+1 兜底（正常不会发生）
      const bi = idxOf.get(code)?.get(date) ?? 0;
      const prevBar = s!.bars[bi - 1];
      const ld = prevBar ? round2(prevBar.close * (1 - limitPct(code, ""))) : 0;
      const oneLineDown = bar.high === bar.low && bar.close <= ld;

      let exitPrice: number | null = null;
      let qty = p.sellable;
      let note = "";
      const gapPct = ((bar.open - pos.entry) / pos.entry) * 100;
      // 一次退出可能有两腿：高开先减半、剩下那部分仍然要在当日走完“到点清仓”
      const legs: { qty: number; price: number; note: string }[] = [];
      if (bar.low <= pos.stop && bar.open > pos.stop) {
        legs.push({ qty, price: pos.stop, note: `止损 ${pos.stop}` });
      } else if (bar.open <= pos.stop) {
        legs.push({ qty, price: bar.open, note: `跳空开在止损下 ${bar.open}` });
      } else if (gapPct >= config.gapTrimPct && Math.floor(qty / 2 / 100) * 100 >= 100) {
        const half = Math.floor(qty / 2 / 100) * 100;
        legs.push({ qty: half, price: bar.open, note: `高开 ${gapPct.toFixed(1)}% 减半` });
        legs.push({ qty: p.sellable - half, price: bar.close, note: "剩仓到点清仓(收盘近似)" });
      } else {
        legs.push({ qty, price: bar.close, note: "到点清仓(收盘近似)" }); // 日线口径：把“10:00 前清仓”记为收盘价
      }
      if (oneLineDown) {
        skippedAtLimit++;
        continue; // 一字跌停卖不出
      }
      exitPrice = legs[0]!.price;
      note = legs.map((l) => l.note).join(" + ");
      for (const leg of legs) {
        qty = leg.qty;
        exitPrice = leg.price;
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

    // ---- 2) 大盘闸门 ----
    const ii = indexIdx.get(date) ?? 0;
    const idxBar = indexBars[ii]!;
    let ma5: number | null = null;
    if (ii >= 5) {
      let sum = 0;
      for (let j = ii - 5; j < ii; j++) sum += indexBars[j]!.close;
      ma5 = sum / 5;
    }
    const gate = marketGate({ price: idxBar.close, amountYi: idxBar.amountYuan / 1e8 }, ma5, null);

    // ---- 3) 打分并开新仓（尾盘买入）----
    if (gate.allowed) {
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
      const picks = scored.sort((x, y) => y.score - x.score).slice(0, a.k);
      for (const pick of picks) {
        const code = pick.features.code;
        if (openPositions.has(code)) continue;
        if (book.openDateCount(date) >= config.maxDailyOpens) break;
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
        const qty = Math.floor(a.sizeCny / entryPrice / 100) * 100;
        if (qty < 100) continue;
        const amount = round2(entryPrice * qty);
        if (amount + 50 > cash) continue; // 现金不够
        const fill = makeFill({
          code,
          name: code,
          side: "buy",
          price: entryPrice,
          qty,
          date,
          time: "14:45",
          kind: "paper",
          note: "尾盘买入",
        });
        book.applyFill(fill);
        costYuan += fill.costs.total;
        openPositions.set(code, { qty, entry: entryPrice, entryDate: date, stop: round2(entryPrice * (1 - config.stopLossPct / 100)) });
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
    equitySeries.push({ date, equity: book.totals().equity });
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
  const years = Math.max(0.25, dates.length / 244);
  const growth = t.equity / config.bankrollCny;
  const totalReturnPct = (growth - 1) * 100;
  const annualized = growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : -100;
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equitySeries) {
    peak = Math.max(peak, e.equity);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - e.equity) / peak) * 100 : 0);
  }
  const profitOverCost = costYuan > 0 ? grossProfitYuan / costYuan : 0;
  const passed = annualized > 0 && netBps > 0 && profitOverCost > 2.5;

  const params = `K=${a.k} 涨幅 ${a.gainMin}-${a.gainMax}% 量比≥${a.vrMin} 成交额≥${a.minAmountYi}亿 单笔${(a.sizeCny / 10000).toFixed(0)}万 止损${config.stopLossPct}%`;
  const result: BtResult = {
    params,
    trades,
    wins,
    winRate: trades ? round2((wins / trades) * 100) : 0,
    grossBps,
    netBps,
    costBps,
    meanTripBps,
    notionalYuan: round2(notionalYuan),
    costYuan: round2(costYuan),
    grossProfitYuan: round2(grossProfitYuan),
    profitOverCost: round2(profitOverCost),
    finalEquity: t.equity,
    totalReturnPct: round2(totalReturnPct),
    annualizedPct: round2(annualized),
    maxDrawdownPct: round2(maxDd),
    skippedAtLimit,
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
  P(`每笔期望  毛利 ${result.grossBps}bp - 成本 ${result.costBps}bp = 净 ${result.netBps}bp（本金加权；算术平均 ${result.meanTripBps}bp 仅供参考）`);
  P(`金额      毛利 ${result.grossProfitYuan} 元   总成本 ${result.costYuan} 元   累计本金 ${result.notionalYuan} 元   收益/成本 ${result.profitOverCost}`);
  P(`期末权益  ${result.finalEquity} 元   总收益 ${result.totalReturnPct}%   年化 ${result.annualizedPct}%   最大回撤 ${result.maxDrawdownPct}%`);
  P(`封板跳过  ${result.skippedAtLimit} 次（涨停买不进 / 一字跌停卖不出）`);
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
      gainMin: a.gainMin,
      gainMax: a.gainMax,
      vrMin: a.vrMin,
      minAmountYi: a.minAmountYi,
    }),
  );
  return { result: r.result, log: [...log, ...r.log] };
}

function emptyResult(params: string): BtResult {
  return {
    params,
    trades: 0,
    wins: 0,
    winRate: 0,
    grossBps: 0,
    netBps: 0,
    costBps: 0,
    meanTripBps: 0,
    notionalYuan: 0,
    costYuan: 0,
    grossProfitYuan: 0,
    profitOverCost: 0,
    finalEquity: config.bankrollCny,
    totalReturnPct: 0,
    annualizedPct: 0,
    maxDrawdownPct: 0,
    skippedAtLimit: 0,
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
  const lines = ["K\t涨幅下限\t量比下限\t成交腿\t胜率%\t净bps\t毛利bps\t成本bps\t收益/成本\t年化%\t回撤%\t通过"];
  for (const r of rows) {
    const m = r.params.match(/K=(\d+) 涨幅 ([\d.]+)-(\d+)% 量比≥([\d.]+)/);
    const [k, gm, , vm] = m?.slice(1) ?? ["", "", "", ""];
    lines.push(
      `${k}\t${gm}\t${vm}\t${r.trades}\t${r.winRate}\t${r.netBps}\t${r.grossBps}\t${r.costBps}\t${r.profitOverCost}\t${r.annualizedPct}\t${r.maxDrawdownPct}\t${r.passed ? "Y" : "N"}`,
    );
  }
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
