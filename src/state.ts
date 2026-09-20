/**
 * 账簿：持仓、T+1 可卖/冻结、现金与已实现盈亏。影子盘、人工回填、回测三条路共用它，
 * 所以"回测赚钱、实盘对不上账"这种坑不存在。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { buyCosts, sellCosts, type Costs } from "./costs";
import type { Side } from "./symbols";

export interface Fill {
  id: string;
  ts: number;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM 北京时间 */
  time: string;
  code: string;
  name: string;
  side: Side;
  price: number;
  qty: number;
  amount: number;
  costs: Costs;
  /** 影子成交还是人工回填的真实成交 */
  kind: "paper" | "manual";
  signalId?: string;
  /** 卖出时才有：这一笔实现的盈亏（元，已扣双边费用） */
  realizedPnl?: number;
  /** 人工回填相对建议价的滑点 bps */
  slippageBps?: number;
  note?: string;
}

export interface Position {
  code: string;
  name: string;
  qty: number;
  /** T+1：昨天及更早买入的，今天可卖 */
  sellable: number;
  /** 今日买入，冻结 */
  frozen: number;
  avgPrice: number;
  /** 已发生的买入费用，卖出时按比例结转进已实现盈亏 */
  feesPaid: number;
  openDate: string;
  stopPrice: number;
  lastPrice: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  marketValue: number;
  cash: number;
}

const posFile = () => join(config.dataDir, "positions.json");
const tradeFile = () => join(config.dataDir, "trades.jsonl");

export class Book {
  cash: number;
  /** 账本的参考本金：权益相对它算盈亏，而不是直接拿环境变量（否则换个本金测试就错） */
  initialCash: number;
  positions = new Map<string, Position>();
  fills: Fill[] = [];
  equityCurve: EquityPoint[] = [];
  /** 已完成的交易日（日切用） */
  lastDate = "";
  realizedTotal = 0;

  constructor(cash = config.bankrollCny) {
    this.cash = cash;
    this.initialCash = cash;
  }

  async load(): Promise<void> {
    try {
      const j = await Bun.file(posFile()).json();
      this.cash = j.cash ?? this.cash;
      this.initialCash = j.initialCash ?? this.initialCash;
      this.lastDate = j.lastDate ?? "";
      this.realizedTotal = j.realizedTotal ?? 0;
      this.equityCurve = Array.isArray(j.equityCurve) ? j.equityCurve : [];
      for (const p of j.positions ?? []) this.positions.set(p.code, p);
    } catch {
      /* 首次运行 */
    }
    try {
      const text = await Bun.file(tradeFile()).text();
      this.fills = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Fill);
    } catch {
      /* 还没有成交 */
    }
  }

  async save(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await Bun.write(
      posFile(),
      JSON.stringify(
        {
          cash: this.cash,
          initialCash: this.initialCash,
          lastDate: this.lastDate,
          realizedTotal: this.realizedTotal,
          equityCurve: this.equityCurve.slice(-500),
          positions: [...this.positions.values()],
        },
        null,
        1,
      ),
    );
  }

  async appendFill(fill: Fill): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    const file = Bun.file(tradeFile());
    const prev = (await file.exists()) ? await file.text() : "";
    await Bun.write(file, prev + JSON.stringify(fill) + "\n");
  }

  /**
   * 日切：进入新交易日时，把昨日冻结的买入解锁为可卖（T+1）。
   * 跨年/跨周都无所谓，只看日期字符串是否变化。
   */
  rollover(date: string): boolean {
    if (!this.lastDate) {
      this.lastDate = date;
      return false;
    }
    if (this.lastDate === date) return false;
    for (const p of this.positions.values()) {
      if (p.frozen > 0) {
        p.sellable += p.frozen;
        p.frozen = 0;
      }
    }
    this.lastDate = date;
    return true;
  }

  /** 应用一笔成交，返回该笔卖出实现的盈亏（买入为 undefined）。 */
  applyFill(fill: Fill): number | undefined {
    const amount = round2(fill.price * fill.qty);
    const costs = fill.costs;
    this.fills.push(fill);

    if (fill.side === "buy") {
      const p =
        this.positions.get(fill.code) ??
        ({
          code: fill.code,
          name: fill.name,
          qty: 0,
          sellable: 0,
          frozen: 0,
          avgPrice: 0,
          feesPaid: 0,
          openDate: fill.date,
          stopPrice: round2(fill.price * (1 - config.stopLossPct / 100)),
          lastPrice: fill.price,
        } satisfies Position);
      const totalQty = p.qty + fill.qty;
      p.avgPrice = totalQty > 0 ? (p.avgPrice * p.qty + fill.price * fill.qty) / totalQty : fill.price;
      p.qty = totalQty;
      p.frozen += fill.qty; // T+1：今日买入今日不可卖
      p.feesPaid = round2(p.feesPaid + costs.total);
      p.name = fill.name || p.name;
      p.lastPrice = fill.price;
      this.positions.set(fill.code, p);
      this.cash = round2(this.cash - amount - costs.total);
      return undefined;
    }

    const p = this.positions.get(fill.code);
    const qtyBefore = p?.qty ?? 0;
    let realized: number | undefined;
    if (p && qtyBefore > 0) {
      const sold = Math.min(fill.qty, qtyBefore);
      const allocBuyFee = round2((p.feesPaid * sold) / qtyBefore);
      realized = round2((fill.price - p.avgPrice) * sold - costs.total - allocBuyFee);
      p.qty -= sold;
      p.sellable = Math.max(0, p.sellable - sold);
      p.feesPaid = round2(p.feesPaid - allocBuyFee);
      if (p.qty <= 0) this.positions.delete(fill.code);
      else p.lastPrice = fill.price;
      fill.realizedPnl = realized;
      this.realizedTotal = round2(this.realizedTotal + realized);
    }
    this.cash = round2(this.cash + amount - costs.total);
    return realized;
  }

  markToMarket(prices: Map<string, number>): void {
    for (const p of this.positions.values()) {
      const px = prices.get(p.code);
      if (px && px > 0) p.lastPrice = px;
    }
  }

  totals() {
    let marketValue = 0;
    let unrealized = 0;
    for (const p of this.positions.values()) {
      marketValue += p.qty * p.lastPrice;
      unrealized += (p.lastPrice - p.avgPrice) * p.qty;
    }
    const cash = this.cash;
    const equity = round2(cash + marketValue);
    const pnlCny = round2(equity - this.initialCash);
    return {
      positions: this.positions.size,
      cash,
      initialCash: this.initialCash,
      marketValue: round2(marketValue),
      unrealized: round2(unrealized),
      realized: this.realizedTotal,
      equity,
      pnlCny,
      pnlPct: this.initialCash > 0 ? pnlCny / this.initialCash : 0,
      exposurePct: equity > 0 ? marketValue / equity : 0,
      fills: this.fills.length,
    };
  }

  openDateCount(date: string): number {
    return this.fills.filter((f) => f.date === date && f.side === "buy").length;
  }

  recordEquity(date: string): EquityPoint {
    const t = this.totals();
    const point: EquityPoint = { date, equity: t.equity, marketValue: t.marketValue, cash: t.cash };
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || last.date !== date) this.equityCurve.push(point);
    else this.equityCurve[this.equityCurve.length - 1] = point;
    return point;
  }
}

export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function makeFill(args: {
  code: string;
  name: string;
  side: Side;
  price: number;
  qty: number;
  date: string;
  time: string;
  kind: "paper" | "manual";
  signalId?: string;
  slippageBps?: number;
  note?: string;
}): Fill {
  const amount = round2(args.price * args.qty);
  return {
    id: `${args.date.replace(/-/g, "")}-${args.time.replace(":", "")}-${args.code}-${args.side}`,
    ts: Date.now(),
    date: args.date,
    time: args.time,
    code: args.code,
    name: args.name,
    side: args.side,
    price: args.price,
    qty: args.qty,
    amount,
    costs: args.side === "buy" ? buyCosts(amount) : sellCosts(amount),
    kind: args.kind,
    signalId: args.signalId,
    slippageBps: args.slippageBps,
    note: args.note,
  };
}
