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
      { date: "2026-09-01", time: "14:50", phase: "continuous", executable: true, model: "jev", threshold: 0.45, pool: ["GOOD", "BAD"], picked: ["GOOD"] },
      { date: "2026-09-02", time: "14:50", phase: "continuous", executable: true, model: "jev", threshold: 0.45, pool: ["GOOD", "BAD"], picked: ["GOOD"] },
    ];
    const r = analyzeJournal(entries, daily, 2, 0); // 成本置 0 便于看方向
    expect(r.days).toBe(2);
    expect(r.excluded).toBe(0);
    expect(r.jev.avg).toBeGreaterThan(0); // Jev 选好票
    expect(r.verdict).toContain("样本"); // <10 天 -> 不给结论
    // 同一天多条只取最后一条
    const r2 = analyzeJournal(
      [
        { date: "2026-09-01", time: "10:00", phase: "continuous", executable: true, model: "jev", threshold: 0.45, pool: ["GOOD"], picked: [] },
        { date: "2026-09-01", time: "14:50", phase: "continuous", executable: true, model: "jev", threshold: 0.45, pool: ["GOOD"], picked: ["GOOD"] },
      ],
      daily, 2, 0,
    );
    expect(r2.days).toBe(1);
    expect(r2.jev.n).toBe(1); // 采用 14:50 那条
  });

  test("盘后 force-scan 与旧格式记录不进对照实验，也不会顶掉同一天盘内那条", () => {
    const daily = new Map<string, ResearchDailyBar[]>();
    daily.set("GOOD", [bar("2026-09-01", 10), bar("2026-09-02", 10.5), bar("2026-09-03", 11), bar("2026-09-04", 11.5)]);
    daily.set("BAD", [bar("2026-09-01", 20), bar("2026-09-02", 20), bar("2026-09-03", 20), bar("2026-09-04", 20)]);
    const r = analyzeJournal(
      [
        // 盘内真样本
        { date: "2026-09-01", time: "14:50", phase: "continuous", executable: true, model: "jev", threshold: 0.45, pool: ["GOOD", "BAD"], picked: ["GOOD"] },
        // 同一天盘后的复盘轮：time 更晚，“取当天最后一条”会选中它 —— 正是这次修的污染路径
        { date: "2026-09-01", time: "23:16", phase: "closed", executable: false, model: "jev", threshold: 0.45, pool: ["BAD"], picked: ["BAD"] },
        // 旧格式（无 executable 字段）：无法证明来自新鲜行情，一并剔除
        { date: "2026-09-02", time: "14:50", model: "jev", threshold: 0.45, pool: ["BAD"], picked: ["BAD"] },
      ],
      daily, 2, 0,
    );
    expect(r.excluded).toBe(2);
    expect(r.days).toBe(1); // 只剩 09-01 的盘内那条
    expect(r.jev.n).toBe(1);
    expect(r.jev.avg).toBeGreaterThan(0); // 统计的是 GOOD，不是被盘后记录顶掉的 BAD
  });
});
