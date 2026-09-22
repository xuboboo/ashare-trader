import { describe, expect, test } from "bun:test";
import { collectResearchDates, reconstructPitUniverse, type ResearchDailyBar } from "../src/research";

const bar = (date: string, close: number, amountYuan: number): ResearchDailyBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volumeHands: 1000,
  amountYuan,
  turnoverPct: 1,
  pct: 1,
});

const daily: Record<string, ResearchDailyBar[]> = {
  // A 三天都在，成交额居中
  "600000": [bar("2026-01-02", 10, 5_000), bar("2026-01-05", 11, 9_000), bar("2026-01-06", 12, 7_000)],
  // B 首日 01-02，次日起才可入池
  "000001": [bar("2026-01-02", 20, 99_000), bar("2026-01-05", 21, 50_000)],
  // C 首日 01-02（无前收不入池），01-05 起可入且当日成交额最高
  "300750": [bar("2026-01-02", 30, 10_000), bar("2026-01-05", 33, 100_000)],
};

const map = new Map(Object.entries(daily));

describe("逐日 PIT 股票池重建", () => {
  test("collectResearchDates 给升序去重的并集", () => {
    expect(collectResearchDates(map)).toEqual(["2026-01-02", "2026-01-05", "2026-01-06"]);
  });

  test("首日（无前收）不进池，即便它成交额最高", () => {
    const pools = reconstructPitUniverse(["2026-01-02"], { topN: 10, dailyByCode: map, source: "t" });
    const snap = pools.get("2026-01-02")!;
    // 01-02 当天所有票都是各自首日 -> 无前收 -> 全被剔除 -> 该日无快照
    expect(snap).toBeUndefined();
  });

  test("按当日成交额降序排名，并取昨收为前一日收盘", () => {
    const pools = reconstructPitUniverse(["2026-01-05"], { topN: 10, dailyByCode: map, source: "t" });
    const snap = pools.get("2026-01-05")!;
    expect(snap.entries.map((e) => e.code)).toEqual(["300750", "000001", "600000"]); // 100k>50k>9k
    const a = snap.entries.find((e) => e.code === "600000")!;
    expect(a.prevClose).toBe(10); // 600000 在 01-02 的收盘
    expect(a.active).toBe(true);
    const c = snap.entries.find((e) => e.code === "300750")!;
    expect(c.prevClose).toBe(30); // 300750 在 01-02 的收盘
    expect(snap.source).toBe("t");
  });

  test("topN 截断保留成交额最高者", () => {
    const pools = reconstructPitUniverse(["2026-01-05"], { topN: 2, dailyByCode: map, source: "t" });
    const snap = pools.get("2026-01-05")!;
    expect(snap.entries.map((e) => e.code)).toEqual(["300750", "000001"]);
  });

  test("names 表用于展示但不影响排名", () => {
    const names = new Map<string, string>([["300750", "宁德时代"]]);
    const pools = reconstructPitUniverse(["2026-01-05"], { topN: 10, dailyByCode: map, names, source: "t" });
    const c = pools.get("2026-01-05")!.entries.find((e) => e.code === "300750")!;
    expect(c.name).toBe("宁德时代");
  });

  test("无 bar 的日期不产出快照", () => {
    const pools = reconstructPitUniverse(["2099-01-01"], { topN: 10, dailyByCode: map, source: "t" });
    expect(pools.size).toBe(0);
  });
});
