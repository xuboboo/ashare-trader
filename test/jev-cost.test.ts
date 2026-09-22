import { describe, expect, test } from "bun:test";
import { summarizeByDate, estUsd, type CostRow } from "../scripts/jev-cost";

const row = (date: string, call: "remote" | "cache", tokens: number): CostRow => ({
  date, side: "buy", call, tokens, latencyMs: 500,
});

describe("Jev 成本汇总", () => {
  test("按天分桶：分别计远端调用/缓存命中、累加 token、按日期升序", () => {
    const days = summarizeByDate([
      row("2026-09-23", "remote", 300),
      row("2026-09-23", "remote", 200),
      row("2026-09-23", "cache", 0),
      row("2026-09-22", "remote", 100),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-09-22", "2026-09-23"]);
    const d23 = days.find((d) => d.date === "2026-09-23")!;
    expect(d23.remoteCalls).toBe(2);
    expect(d23.cacheHits).toBe(1);
    expect(d23.tokens).toBe(500);
  });

  test("空输入 -> 空结果；估算按 $0.042/M", () => {
    expect(summarizeByDate([])).toEqual([]);
    expect(estUsd(1_000_000)).toBeCloseTo(0.042, 5);
    expect(estUsd(2885)).toBeGreaterThan(0.0001);
  });
});
