import { describe, expect, test } from "bun:test";
import { avgVolumeBefore, featuresFromDaily, featuresFromSnapshot, scoreStock } from "../src/factors";
import { FactorModel } from "../src/model";
import type { DailyBar } from "../src/quotes";
import { mkSnap } from "./helpers";

/**
 * 回测与实盘一致性：同一天的数据，日线口径与快照口径必须给出同样的分数、同样的否决、
 * 同样的选股结果。否则回测结论不能外推到实盘。
 */
const avg5 = 166_666.666_666_666_66;
const bar: DailyBar = {
  date: "2026-09-18",
  open: 10.1,
  close: 10.5,
  high: 10.6,
  low: 10.05,
  volumeHands: 300_000,
  amountYuan: 3.12e8, // vwap = 3.12e8 / 3e7 = 10.4
  turnoverPct: 5,
  pct: 5,
};
const prevBar: DailyBar = { ...bar, date: "2026-09-17", close: 10, open: 10, high: 10.1, low: 9.9, amountYuan: 1e8, turnoverPct: 1.5, pct: 0 };

const vr = bar.volumeHands / avg5;
const snap = mkSnap({
  code: "600000",
  name: "测试股份",
  price: bar.close,
  prevClose: prevBar.close,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  volumeHands: bar.volumeHands,
  amountYuan: bar.amountYuan,
  vwap: 10.4,
  turnoverPct: bar.turnoverPct,
  volumeRatio: vr,
  limitUp: 11,
  limitDown: 9,
});

describe("回测/实盘同一口径", () => {
  const daily = scoreStock(featuresFromDaily(bar, prevBar, avg5, "测试股份", "600000"));
  const live = scoreStock(featuresFromSnapshot(snap, bar.date));

  test("两条路径都通过筛选", () => {
    expect(daily.rejects).toEqual([]);
    expect(live.rejects).toEqual([]);
  });

  test("分数完全相等", () => {
    expect(live.score).toBe(daily.score);
  });

  test("否决项文本也一致", () => {
    const bad = { volumeRatio: 0.8 };
    const d = scoreStock(featuresFromDaily({ ...bar, volumeHands: 100_000, amountYuan: 1.04e7 }, prevBar, 125_000, "测试股份", "600000"));
    const l = scoreStock(featuresFromSnapshot({ ...snap, volumeRatio: 100_000 / 125_000, amountYuan: 1.04e7, volumeHands: 100_000 }, bar.date));
    expect(d.rejects.sort()).toEqual(l.rejects.sort());
    expect(d.rejects.join()).toContain("量比");
    void bad;
  });

  test("FactorModel 在两条路径上选出同一只", async () => {
    const model = new FactorModel();
    const base = {
      date: bar.date,
      time: "14:45",
      horizon: "尾盘买入",
      gate: { allowed: true, reasons: [] },
      heldCodes: [],
      allowed: { buy: true, sell: false },
      vetoes: {},
      openSlots: 3,
    };
    const a = await model.decide({ ...base, candidates: [daily] });
    const b = await model.decide({ ...base, candidates: [live] });
    expect(a.picks.map((p) => p.code)).toEqual(b.picks.map((p) => p.code));
    expect(a.picks).toHaveLength(1);
    expect(a.action).toBe("buy");
  });

  test("日线不足 5 根时不算量比（返回 undefined 而不是猜）", () => {
    expect(avgVolumeBefore([bar, prevBar], "2026-09-18", 5)).toBeUndefined();
    const many = Array.from({ length: 6 }, (_, i) => ({ ...bar, date: `2026-09-0${i + 1}` }));
    expect(avgVolumeBefore(many, "2026-09-18", 5)).toBeCloseTo(bar.volumeHands, 6);
  });
});
