import type { Snapshot } from "../src/quotes";
import type { DailyBar } from "../src/quotes";

/** 构造一个测试用快照，只覆盖你在乎的字段。 */
export function mkSnap(over: Partial<Snapshot> = {}): Snapshot {
  const prevClose = over.prevClose ?? 10;
  return {
    code: "600000",
    name: "测试股份",
    price: 10.5,
    prevClose,
    open: 10.1,
    high: 10.6,
    low: 10.05,
    volumeHands: 300_000,
    amountYuan: 3.15e8,
    vwap: 10.4,
    turnoverPct: 5,
    volumeRatio: 1.8,
    floatMcapYi: 80,
    mcapYi: 100,
    limitUp: +(prevClose * 1.1).toFixed(2),
    limitDown: +(prevClose * 0.9).toFixed(2),
    bids: [{ p: 10.49, v: 100 }],
    asks: [{ p: 10.51, v: 100 }],
    quoteDay: "20260918",
    suspended: false,
    oneLineUp: false,
    oneLineDown: false,
    ...over,
  };
}

export function mkBar(over: Partial<DailyBar> = {}): DailyBar {
  return {
    date: "2026-09-18",
    open: 10.1,
    close: 10.5,
    high: 10.6,
    low: 10.05,
    volumeHands: 300_000,
    amountYuan: 3.15e8,
    turnoverPct: 5,
    pct: 5,
    ...over,
  };
}
