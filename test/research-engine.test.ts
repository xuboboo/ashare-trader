import { describe, expect, test } from "bun:test";
import { buildResearchSnapshot, simulateMinuteExit } from "../src/research-engine";
import type { ResearchMinuteBar } from "../src/research";

const base = (time: string, over: Partial<ResearchMinuteBar> = {}): ResearchMinuteBar => ({
  date: "2026-09-22",
  time,
  open: 10,
  high: 10.2,
  low: 9.9,
  close: 10.1,
  volumeShares: 10_000,
  amountYuan: 100_000,
  bid: 10.09,
  ask: 10.11,
  bidSize: 2_000,
  askSize: 2_000,
  volumeRatio: 2,
  turnoverPct: 1.5,
  mcapYi: 100,
  floatMcapYi: 80,
  suspended: false,
  oneLineUp: false,
  oneLineDown: false,
  ...over,
});

describe("分钟级研究执行口径", () => {
  test("14:45 快照只聚合此前可见的分钟，并用当时 ask", () => {
    const s = buildResearchSnapshot({
      date: "2026-09-22",
      code: "600000",
      entry: { code: "600000", name: "测试", active: true, prevClose: 10 },
      bars: [
        base("09:30", { close: 10.1, ask: 10.11 }),
        base("14:44", { close: 10.2, ask: 10.21, volumeShares: 20_000 }),
        base("14:45", { close: 10.3, ask: 10.31, volumeShares: 30_000, amountYuan: 309_000 }),
        base("14:46", { close: 10.4, ask: 10.41 }),
      ],
    });
    expect(s.price).toBe(10.3);
    expect(s.asks[0]!.p).toBe(10.31);
    expect(s.volumeHands).toBe(600);
    expect(s.quoteAt).toBe(Date.parse("2026-09-22T14:45:00+08:00"));
  });

  test("分钟退出先处理高开减半，再用 bid 触发止损", () => {
    const r = simulateMinuteExit({
      bars: [
        base("09:30", { open: 10.6, close: 10.5, bid: 10.59, low: 10.4 }),
        base("09:31", { open: 10.4, low: 9.7, bid: 9.68 }),
        base("10:00", { open: 9.8, low: 9.75, bid: 9.76 }),
      ],
      entry: 10,
      stop: 9.8,
      qty: 400,
      gapTrimPct: 3,
    });
    expect(r.censored).toBe(false);
    expect(r.legs.map((x) => [x.qty, x.price])).toEqual([[200, 10.59], [200, 9.68]]);
  });

  test("10:00 用最后一分钟 bid，不使用收盘后的日线 close", () => {
    const r = simulateMinuteExit({
      bars: [
        base("09:30", { open: 10.1, close: 10.2, bid: 10.19 }),
        base("10:00", { open: 10.3, close: 10.4, bid: 10.35 }),
      ],
      entry: 10,
      stop: 9.5,
      qty: 100,
      gapTrimPct: 3,
    });
    expect(r.legs).toEqual([{ qty: 100, price: 10.35, time: "10:00", note: "10:00 分钟截止清仓" }]);
  });
});
