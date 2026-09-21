/**
 * 账簿：持仓、T+1 可卖/冻结、现金与已实现盈亏。影子盘、人工回填、回测三条路共用它，
 * 所以"回测赚钱、实盘对不上账"这种坑不存在。
 */
import { mkdir, rename } from "node:fs/promises";
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
  /**
   * 买入时：这张单当初算好的止损触发线（fixed 或 ATR 口径）。
   * 成交记录里必须带着它，否则持仓只能拿默认百分比反推 ——
   * STOP_MODE=atr 就会在成交那一刻静默变回 fixed（审计过一次的真实缺陷）。
   * 流水是唯一事实，rebuild() 靠这个字段重现同样的止损线。
   */
  stopPrice?: number;
  /**
   * 建仓时两条口径的止损线也随成交落盘（与 stopPrice 同一参考价算出）。
   * active 那条决定真实退出；另一条只为事后对照存在 —— 没有它，
   * “ATR 到底比固定 3% 好多少”只能靠同一段历史扫参回答，不能用手上这些成交回答。
   */
  stopFixed?: number;
  stopAtr?: number;
  /** 人工回填相对建议价的滑点 bps */
  slippageBps?: number;
  /** 成交瞬间的盘口价差（(卖一-买一)/中间价，bps）：审计影子成交价真实性的原始证据 */
  spreadBps?: number;
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
  /** 建议单的止损触发线（fixed 或 ATR）；成交时由 Fill.stopPrice 带入 */
  stopPrice: number;
  /** 建仓时的固定止损与 ATR 止损（两条都存，用于反事实对照） */
  stopFixed?: number;
  stopAtr?: number;
  /**
   * 建仓之后观察到的最低价。只在行情新鲜且属于今天的快照上更新；
   * 建仓当日只用逐轮现价（不能把建仓前的下影线算进来），次日起可以用当日最低价。
   */
  lowWater?: number;
  lastPrice: number;
  /** 开盘浮盈止盈：当日已评估过一次（无论触发与否），不重复执行 */
  openingTpDone?: boolean;
  /** 分时均线弱势确认：连续跌破 VWAP 的轮数 */
  vwapBelowRounds?: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  marketValue: number;
  cash: number;
}

const posFile = () => join(config.dataDir, "positions.json");
const tradeFile = () => join(config.dataDir, "trades.jsonl");

/**
 * 原子写：先写同名 .tmp 再 rename。Windows 上 Bun.write 是就地截断重写，
 * 两个进程（或一个写一个读）撞上去就会得到半份文件 —— 而整份流水的解析
 * 是一个 try/catch，一行坏就全丢。这是真实发生过的账本事故。
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await Bun.write(tmp, text);
  try {
    await rename(tmp, file);
  } catch (e) {
    // rename 失败（Windows 上目标被临时占用）：留下 tmp 供人工合并，绝不静默丢
    console.error(`[book] 原子替换失败 ${file}: ${(e as Error).message}（数据保留在 ${tmp}）`);
    throw e;
  }
}

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
  /** 当前交易日的日初权益（日切时定格），日亏损闸以此为分母 */
  dayStartEquity = 0;
  /** 权益历史峰值（含今日），回撤闸以此为分母 */
  peakEquity = 0;

  constructor(cash = config.bankrollCny) {
    this.cash = cash;
    this.initialCash = cash;
    this.dayStartEquity = cash;
    this.peakEquity = cash;
  }

  async load(): Promise<void> {
    try {
      const j = await Bun.file(posFile()).json();
      this.cash = j.cash ?? this.cash;
      this.initialCash = j.initialCash ?? this.initialCash;
      this.lastDate = j.lastDate ?? "";
      this.realizedTotal = j.realizedTotal ?? 0;
      this.dayStartEquity = j.dayStartEquity ?? this.initialCash;
      this.peakEquity = j.peakEquity ?? this.initialCash;
      this.equityCurve = Array.isArray(j.equityCurve) ? j.equityCurve : [];
      for (const p of j.positions ?? []) this.positions.set(p.code, p);
    } catch {
      /* 首次运行 */
    }
    try {
      const text = await Bun.file(tradeFile()).text();
      // 逐行容错：历史上有一行被写坏过（半份写入），不能因此把整个账本当空
      let bad = 0;
      this.fills = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line) as Fill;
          if (f && f.id && f.code && f.side && f.qty > 0) this.fills.push(f);
          else bad++;
        } catch {
          bad++;
        }
      }
      if (bad) console.error(`[book] trades.jsonl 有 ${bad} 行不可用，已跳过（其余照常重放）`);
    } catch {
      /* 还没有成交 */
    }
    // 自愈校验：positions.json 若与流水重放不一致（多实例互踩/手改文件），
    // 以流水为准重建 —— trades.jsonl 是唯一事实，快照只是缓存。
    this.verify("启动加载");
  }

  /**
   * 用成交流水重放出现金/持仓/已实现，与内存里的快照比对；不平就地重建并返回说词。
   * 每次 save() 都跑一遍：自愈不应该只在启动时发生一次，长跑进程的快照同样会腐。
   */
  verify(when = "校验"): string | null {
    const replay = new Book(this.initialCash);
    replay.replayFrom(this.fills, this.initialCash);
    const cashGap = Math.abs(replay.cash - this.cash);
    if (cashGap <= 1 && replay.positions.size === this.positions.size) return null;
    const msg = `[book] ${when}发现快照与流水不平（cash ${this.cash} vs 重放 ${replay.cash}，持仓 ${this.positions.size} vs ${replay.positions.size}），已按流水重建`;
    console.error(msg);
    this.cash = replay.cash;
    this.realizedTotal = replay.realizedTotal;
    this.positions = replay.positions;
    return msg;
  }

  /** 只重放现金/持仓/已实现，不动权益曲线与日切基准（它们是市场标记历史，与成交无关）。 */
  replayFrom(fills: Fill[], cashAtStart = this.initialCash): void {
    const curve = this.equityCurve;
    const dayStart = this.dayStartEquity;
    const peak = this.peakEquity;
    const saved = fills; // applyFill 会往 this.fills 里 push，先把输入与输出分开
    this.cash = cashAtStart;
    this.positions = new Map();
    this.realizedTotal = 0;
    this.fills = [];
    this.lastDate = ""; // 让 T+1 解锁随重放自然发生（重放完停在最后一笔成交那天，下一次日切照常）
    const sorted = [...saved].sort(
      (a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.ts - b.ts,
    );
    for (const f of sorted) {
      this.rollover(f.date);
      this.applyFill(f);
    }
    this.equityCurve = curve;
    this.dayStartEquity = dayStart;
    this.peakEquity = peak;
  }

  async save(): Promise<void> {
    this.verify("落盘前");
    await mkdir(config.dataDir, { recursive: true });
    await writeFileAtomic(
      posFile(),
      JSON.stringify(
        {
          cash: this.cash,
          initialCash: this.initialCash,
          lastDate: this.lastDate,
          realizedTotal: this.realizedTotal,
          dayStartEquity: this.dayStartEquity,
          peakEquity: this.peakEquity,
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
    const file = tradeFile();
    const prev = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    await writeFileAtomic(file, prev + JSON.stringify(fill) + "\n");
  }

  /** 用内存里的成交重写流水（撤销一笔后用它保证流水与账本不会两张皮） */
  async rewriteTrades(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await writeFileAtomic(
      tradeFile(),
      this.fills.map((f) => JSON.stringify(f)).join("\n") + (this.fills.length ? "\n" : ""),
    );
  }

  /**
   * 从给定成交重建整个账本（现金、持仓、可卖/冻结、已实现盈亏）。
   * 撤销一笔成交的正确做法是“重放剩下的”，而不是做反向数学 —— 后者一旦
   * 遇到部分卖出、费用分摊就会算出不平的账。
   */
  rebuild(fills: Fill[], cashAtStart = this.initialCash): void {
    this.initialCash = cashAtStart;
    this.replayFrom(fills, cashAtStart);
    // 权益曲线不抹：历史点是当时盯市的结果，抹了就等于造一段空白历史。
    // 今天那个点会在下一次 recordEquity 时被覆盖（同日期替换末尾），不会留错账。
  }

  /**
   * 日切：进入新交易日时，把昨日冻结的买入解锁为可卖（T+1）。
   * 跨年/跨周都无所谓，只看日期字符串是否变化。
   * 日切瞬间把当前权益定格为 dayStartEquity（日亏损闸的基准）。
   */
  rollover(date: string): boolean {
    if (!this.lastDate) {
      this.lastDate = date;
      if (!this.dayStartEquity) this.dayStartEquity = this.totals().equity;
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
    this.dayStartEquity = this.totals().equity;
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
          stopPrice: this.stopFromFill(fill, fill.price),
          stopFixed: fill.stopFixed,
          stopAtr: fill.stopAtr,
          lowWater: fill.price,
          lastPrice: fill.price,
        } satisfies Position);
      const totalQty = p.qty + fill.qty;
      p.avgPrice = totalQty > 0 ? (p.avgPrice * p.qty + fill.price * fill.qty) / totalQty : fill.price;
      p.qty = totalQty;
      p.frozen += fill.qty; // T+1：今日买入今日不可卖
      p.feesPaid = round2(p.feesPaid + costs.total);
      p.name = fill.name || p.name;
      p.lastPrice = fill.price;
      p.lowWater = Math.min(p.lowWater ?? fill.price, fill.price);
      // 每一笔买入都把自己那张单的止损线当成当前持仓的止损线：
      // 退出阶梯只有一条线，它必须与面板/建议单上显示的那条一致，不能事后另算一套。
      p.stopPrice = this.stopFromFill(fill, p.avgPrice);
      if (fill.stopFixed) p.stopFixed = fill.stopFixed;
      if (fill.stopAtr) p.stopAtr = fill.stopAtr;
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

  /**
   * 持仓止损线：优先用成交记录里带的（建议单算出来的那条，含 ATR 口径），
   * 没带（人工回填、早期流水）才回退到“成交价 × (1 − STOP_LOSS_PCT%)”。
   * 回退是降级，不是默认路径 —— 降级时日志会说清楚。
   */
  private stopFromFill(fill: Fill, base: number): number {
    if (fill.stopPrice && fill.stopPrice > 0 && fill.stopPrice < base) return round2(fill.stopPrice);
    return round2(base * (1 - config.stopLossPct / 100));
  }

  markToMarket(prices: Map<string, number>): void {
    for (const p of this.positions.values()) {
      const px = prices.get(p.code);
      if (px && px > 0) p.lastPrice = px;
    }
  }

  /**
   * 逐轮更新持仓的“建仓后最低价”（反事实止损对照用的水位）。
   * 只在调用方确认行情新鲜、属于今天、且处于可交易时段时才调 —— 拿隔夜价或
   * 建仓前的下影线更新水位，会把对照做成假结果。
   */
  trackLowWater(prices: Map<string, number>): void {
    for (const p of this.positions.values()) {
      const px = prices.get(p.code);
      if (px && px > 0) p.lowWater = Math.min(p.lowWater ?? px, px);
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
    if (t.equity > this.peakEquity) this.peakEquity = t.equity;
    return point;
  }
}

export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** 成交 id 的单调后缀。进程内递增即可（重放读的是落盘的完整 id）。 */
let idSeq = 0;

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
  /** 建议单算好的止损触发线（买入侧有意义），随流水落盘以便重放重现 */
  stopPrice?: number;
  /** 同时落盘另一口径的止损线（反事实对照），与 stopPrice 同一参考价算出 */
  stopFixed?: number;
  stopAtr?: number;
  slippageBps?: number;
  spreadBps?: number;
  note?: string;
}): Fill {
  const amount = round2(args.price * args.qty);
  return {
    // id 必须唯一：同一分钟内的两笔同向同标的单（同日两次 /scan、影子单 + 人工回填）
    // 撞 id 会让 removeFill 撤错一笔，所以尾巴上加一个单调序号。
    id: `${args.date.replace(/-/g, "")}-${args.time.replace(":", "")}-${args.code}-${args.side}-${(++idSeq).toString(36)}`,
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
    stopPrice: args.stopPrice,
    stopFixed: args.stopFixed,
    stopAtr: args.stopAtr,
    slippageBps: args.slippageBps,
    spreadBps: args.spreadBps,
    note: args.note,
  };
}
