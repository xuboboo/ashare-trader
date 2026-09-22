import { describe, expect, test } from "bun:test";
import { analyzeJournal, drawRandom, fwdNetBps, rng, seedFromDate, type JournalEntry } from "../scripts/jev-vs-random";
import type { ResearchDailyBar } from "../src/research";

const bar = (date: string, close: number): ResearchDailyBar => ({
  date, open: close, high: close, low: close, close, volumeHands: 1, amountYuan: 1, turnoverPct: 1, pct: 0,
});

describe("Jev vs 随机对照", () => {
  test("按日期定种的随机抽样可复现", () => {
    const pool = ["A", "B", "C", "D", "E"];
    const a = drawRandom(pool, 2, rng(seedFromDate("2026-09-22")));
    const b = drawRandom(pool, 2, rng(seedFromDate("2026-09-22")));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2); // 无重复
  });

  test("未来收益 = 次日开盘买入、持有 hold 日后收盘卖出，扣成本", () => {
    const bars = [bar("d0", 10), bar("d1", 10), bar("d2", 11), bar("d3", 11), bar("d4", 11)];
    // 信号 d0 -> 次日 d1 开盘(10)买，持2日到 d3 收盘(11) = +1000bp，扣 100 = 900
    expect(fwdNetBps(bars, "d0", 2, 100)).toBeCloseTo(900, 0);
    // 未来不足（d3 之后无 d5）-> null
    expect(fwdNetBps(bars, "d3", 2, 100)).toBeNull();
  });

  test("Jev 明显选到涨得好的票时 jevVsRandom 为正、样本不足时给保守结论", () => {
    const daily = new Map<string, ResearchDailyBar[]>();
    // 好票持续涨，差票横盘
    daily.set("GOOD", [bar("2026-09-01", 10), bar("2026-09-02", 10.5), bar("2026-09-03", 11), bar("2026-09-04", 11.5)]);
    daily.set("BAD", [bar("2026-09-01", 20), bar("2026-09-02", 20), bar("2026-09-03", 20), bar("2026-09-04", 20)]);
    const entries: JournalEntry[] = [
      { date: "2026-09-01", time: "14:50", model: "jev", threshold: 0.45, pool: ["GOOD", "BAD"], picked: ["GOOD"] },
      { date: "2026-09-02", time: "14:50", model: "jev", threshold: 0.45, pool: ["GOOD", "BAD"], picked: ["GOOD"] },
    ];
    const r = analyzeJournal(entries, daily, 2, 0); // 成本置 0 便于看方向
    expect(r.days).toBe(2);
    expect(r.jev.avg).toBeGreaterThan(0); // Jev 选好票
    expect(r.verdict).toContain("样本"); // <10 天 -> 不给结论
    // 同一天多条只取最后一条
    const r2 = analyzeJournal(
      [
        { date: "2026-09-01", time: "10:00", model: "jev", threshold: 0.45, pool: ["GOOD"], picked: [] },
        { date: "2026-09-01", time: "14:50", model: "jev", threshold: 0.45, pool: ["GOOD"], picked: ["GOOD"] },
      ],
      daily, 2, 0,
    );
    expect(r2.days).toBe(1);
    expect(r2.jev.n).toBe(1); // 采用 14:50 那条
  });
});
