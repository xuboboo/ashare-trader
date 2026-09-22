import { describe, expect, test } from "bun:test";
import { splitForTrade, validateResearchManifest } from "../src/research";

const good = {
  schemaVersion: 2,
  dataset: "test",
  timezone: "Asia/Shanghai",
  priceBasis: "raw",
  universe: { path: "universe", format: "date-json", pointInTime: true, source: "test" },
  daily: { path: "daily-raw", format: "code-json", pointInTime: true, source: "test" },
  minutes: { path: "minutes-1m", format: "date-code-json", intervalMinutes: 1, source: "test" },
  execution: { entryTime: "14:45", entryPrice: "ask", exitPrice: "bid", maxBarAgeSeconds: 60, decisionIntervalMinutes: 1 },
  labels: { policy: "jev-autonomous", censoring: "right" },
  splits: {
    train: { from: "2019-01-01", to: "2023-12-31" },
    validation: { from: "2024-01-01", to: "2024-12-31" },
    test: { from: "2025-01-01", to: "2026-09-30" },
  },
};

describe("研究数据协议", () => {
  test("接受严格的 point-in-time / 14:45 / 分钟数据 manifest", () => {
    expect(validateResearchManifest(good)).toEqual([]);
  });

  test("拒绝旧固定 10:00 协议，避免 legacy 标签混入 Jev 研究", () => {
    const old = structuredClone(good) as any;
    old.schemaVersion = 1;
    old.execution.exitDeadline = "10:00";
    delete old.execution.decisionIntervalMinutes;
    delete old.labels;
    expect(validateResearchManifest(old).join("\\n")).toContain("schemaVersion");
    expect(validateResearchManifest(old).join("\\n")).toContain("jev-autonomous");
  });

  test("拒绝复权价、错误入口时间和重叠切分", () => {
    const bad = structuredClone(good) as any;
    bad.priceBasis = "qfq";
    bad.execution.entryTime = "15:00";
    bad.splits.validation.from = "2023-12-01";
    expect(validateResearchManifest(bad).join("\\n")).toContain("priceBasis");
    expect(validateResearchManifest(bad).join("\\n")).toContain("14:45");
    expect(validateResearchManifest(bad).join("\\n")).toContain("train 与 validation");
  });

  test("拒绝绝对路径和非一分钟数据", () => {
    const bad = structuredClone(good) as any;
    bad.universe.path = "E:/outside";
    bad.minutes.intervalMinutes = 5;
    const errors = validateResearchManifest(bad).join("\\n");
    expect(errors).toContain("安全的相对路径");
    expect(errors).toContain("1 分钟");
  });

  test("标签跨越 split 边界时必须丢弃，不得污染验证集", () => {
    expect(splitForTrade(good as any, "2023-12-29", "2023-12-30")).toBe("train");
    expect(splitForTrade(good as any, "2023-12-29", "2024-01-02")).toBeNull();
    expect(splitForTrade(good as any, "2024-01-02", "2024-12-30")).toBe("validation");
  });
});
