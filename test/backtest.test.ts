import { describe, expect, test } from "bun:test";
import { simulate, type Stock } from "../scripts/backtest";
import type { DailyBar } from "../src/quotes";

const day = (i: number) => `2026-03-${String(i).padStart(2, "0")}`;

/** 20 个交易日的上证指数日线：稳步向上、成交额 4000 亿，保证闸门开着。 */
function indexBars(): DailyBar[] {
  return Array.from({ length: 20 }, (_, i) => ({
    date: day(i + 2),
    open: 3000 + i,
    close: 3000 + i,
    high: 3010 + i,
    low: 2990 + i,
    volumeHands: 0,
    amountYuan: 4e11,
    turnoverPct: 0,
    pct: 0.3,
  }));
}

function stock(bars: DailyBar[]): Stock {
  return { code: "600000", bars, byDate: new Map(bars.map((b) => [b.date, b])) };
}

const flat = (i: number, over: Partial<DailyBar> = {}): DailyBar => ({
  date: day(i),
  open: 10,
  close: 10,
  high: 10.1,
  low: 9.9,
  volumeHands: 166_666.666_666_666_66,
  amountYuan: 1.7e8,
  turnoverPct: 1.5,
  pct: 0,
  ...over,
});

/** 第 12 天强势 +5%、放量 1.8 倍、站上均线；第 13 天正常交易。 */
function setup(entry: Partial<DailyBar> = {}, exitDay: Partial<DailyBar> = {}) {
  const bars: DailyBar[] = [];
  for (let i = 2; i <= 21; i++) bars.push(flat(i));
  bars[10] = flat(12, { close: 10.5, open: 10.1, high: 10.6, low: 10.05, volumeHands: 300_000, amountYuan: 3.12e8, pct: 5, ...entry });
  bars[11] = flat(13, { close: 10.3, open: 10.6, high: 10.7, low: 10.2, ...exitDay });
  return bars;
}

describe("回测引擎", () => {
  test("尾盘买入、次日退出，严格 T+1", () => {
    const { result } = simulate({ stocks: [stock(setup())], indexBars: indexBars(), k: 1, quiet: true });
    expect(result.trades).toBe(1);
    const t = result.trips[0]!;
    expect(t.entryDate).toBe("2026-03-12");
    expect(t.exitDate).toBe("2026-03-13");
    expect(t.exitDate > t.entryDate).toBe(true); // T+1：绝不可能当天买卖
    expect(t.qty % 100).toBe(0);
    expect(t.entry).toBe(10.51); // 收盘 + 1 tick
  });

  test("最低佣金与印花税真的计进了成本", () => {
    // 预算与本金显式传参：不隐式依赖 .env（下面 qty/成本断言按 5 万预算、15 万本金写死）
    const { result } = simulate({ stocks: [stock(setup())], indexBars: indexBars(), k: 1, quiet: true, sizeCny: 50_000, bankrollCny: 150_000 });
    // 4700 股 * ~10.5 元 ≈ 4.9 万元，往返成本约 56 元（万2.5 佣金双边 + 印花税 + 过户 + 经手）
    expect(result.costYuan).toBeGreaterThan(40);
    expect(result.costYuan).toBeLessThan(80);
    expect(result.profitOverCost).toBeLessThan(0); // 这笔亏了：10.51 -> 10.30
    expect(totalsMatchEquity(result)).toBe(true);
  });

  test("一字跌停那天卖不出，顺延到下一个交易日", () => {
    const bars = setup({}, { open: 9.45, high: 9.45, low: 9.45, close: 9.45 }); // 13 日一字跌停
    const { result } = simulate({ stocks: [stock(bars)], indexBars: indexBars(), k: 1, quiet: true });
    expect(result.skippedAtLimit).toBeGreaterThanOrEqual(1);
    expect(result.trades).toBe(1);
    expect(result.trips[0]!.exitDate).toBe("2026-03-14"); // 拖到 14 日才走
  });

  test("跌破止损价按止损价成交", () => {
    const bars = setup({}, { open: 10.4, high: 10.45, low: 9.8, close: 9.9 });
    const { result } = simulate({ stocks: [stock(bars)], indexBars: indexBars(), k: 1, quiet: true });
    const t = result.trips[0]!;
    expect(t.exit).toBe(10.19); // 10.51 * 0.97
    expect(t.note).toContain("止损");
    expect(t.bps).toBeLessThan(-300);
  });

  test("高开超过阈值先卖一半", () => {
    const bars = setup({}, { open: 11.2, high: 11.4, low: 11.1, close: 11.3 });
    const { result } = simulate({ stocks: [stock(bars)], indexBars: indexBars(), k: 1, quiet: true, sizeCny: 50_000, bankrollCny: 150_000 });
    const trim = result.trips.find((x) => x.note.includes("高开"))!;
    expect(trim).toBeTruthy();
    expect(trim.qty).toBe(2300); // 4700 的一半按 100 股取整
  });

  test("高价股买不起一手，整笔跳过", () => {
    const bars = setup({ close: 926.43, open: 900, high: 930, low: 895, volumeHands: 300_000, amountYuan: 2.7e10, pct: 3.4 });
    const { result } = simulate({ stocks: [stock(bars)], indexBars: indexBars(), k: 1, quiet: true });
    expect(result.trades).toBe(0);
  });

  test("大盘闸门关掉时一股都不买", () => {
    // 上证成交额 1000 亿 < 阈值 3000 亿 → 强制空仓
    const idx = indexBars().map((b) => ({ ...b, amountYuan: 1e11 }));
    const { result } = simulate({ stocks: [stock(setup())], indexBars: idx, k: 1, quiet: true });
    expect(result.trades).toBe(0);
  });
});

/** 权益必须等于 本金 + 各笔已实现盈亏之和，不允许有暗账。 */
function totalsMatchEquity(r: { finalEquity: number; trips: { bps: number; entry: number; qty: number }[] }) {
  const realized = r.trips.reduce((s, t) => s + (t.bps / 10_000) * t.entry * t.qty, 0);
  return Math.abs(r.finalEquity - (150_000 + realized)) < 1;
}
