import { describe, expect, test } from "bun:test";
import { avgVolumeBefore, featuresFromDaily, featuresFromSnapshot, scoreStock } from "../src/factors";
import { FactorModel } from "../src/model";
import type { DailyBar } from "../src/quotes";
import { mkSnap } from "./helpers";

/**
 * 回测与实盘一致性：同一天的数据，日线口径与快照口径必须给出同样的分数、同样的否决、
 * 同样的选股结果。否则回测结论不能外推到实盘。
 *
 * 注意这份测试的边界：它证的是“打分函数只有一份”，不是“两条路的输入同义”。
 * 后者做不到 —— 快照里的 gainPct/成交额/量比是“截至目前”，日线是全天。下面
 * “同一只票在 10:00 与收盘不是同一个输入”那组用例就是把这层差异量化出来，
 * 免得有人拿上面的相等断言当“尾盘回测 = 盘中实盘”的护身符。
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
      gate: { allowed: true, reasons: [], status: "open" as const, skipped: [] },
      index: { price: 3900, pct: 0.5, amountYi: 9000, ma5: null },
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

  /**
   * 口径层的差异（不是 bug，是事实）：10:00 的快照与同一天的日线必然给出不同的结果。
   * 把这件事写成断言，是为了让它不能“靠巧合通过”，也能在有人把阈值改成更敏感时先炸。
   */
  test("同一只票在 10:00 与收盘不是同一个输入：成交额阈值早盘会误否", () => {
    // 10:00 左右：全天成交只跑了两成（0.62 亿 < 2 亿门槛），量比靠开盘 burst 到 2.4
    const morning = scoreStock(
      featuresFromSnapshot(
        mkSnap({ amountYuan: 0.62e8, volumeHands: 60_000, volumeRatio: 2.4, price: 10.42, vwap: 10.3 }),
        bar.date,
      ),
    );
    const close = scoreStock(featuresFromDaily(bar, prevBar, avg5, "测试股份", "600000"));
    expect(morning.rejects.join()).toContain("成交额"); // 早盘被流动性阈值误否
    expect(close.rejects).toEqual([]); // 收盘同一只票是合格候选
    // 阈值含义随时间漂移：同一个 scoreStock 在一天里不是同一个筛子
    expect(morning.score).not.toBe(close.score);
  });
});
