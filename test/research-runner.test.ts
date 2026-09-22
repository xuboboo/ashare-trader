import { describe, expect, test } from "bun:test";
import { runResearchBacktest, type ResearchRunnerLoader } from "../src/research-runner";
import type { ResearchDailyBar, ResearchManifest, ResearchMinuteBar, ResearchUniverseSnapshot } from "../src/research";
import type { Decision, Model } from "../src/model";

const manifest: ResearchManifest = {
  schemaVersion: 2,
  dataset: "runner-test",
  timezone: "Asia/Shanghai",
  priceBasis: "raw",
  universe: { path: "universe", format: "date-json", pointInTime: true, source: "fixture" },
  daily: { path: "daily-raw", format: "code-json", pointInTime: true, source: "fixture" },
  minutes: { path: "minutes-1m", format: "date-code-json", intervalMinutes: 1, source: "fixture" },
  execution: { entryTime: "14:45", entryPrice: "ask", exitPrice: "bid", maxBarAgeSeconds: 60, decisionIntervalMinutes: 1 },
  labels: { policy: "jev-autonomous", censoring: "right" },
  splits: {
    train: { from: "2026-01-01", to: "2026-01-05" },
    validation: { from: "2026-01-06", to: "2026-01-06" },
    test: { from: "2026-01-07", to: "2026-01-31" },
  },
};

const daily: ResearchDailyBar[] = [
  { date: "2026-01-01", open: 9.9, high: 10, low: 9.8, close: 10, volumeHands: 100_000, amountYuan: 100_000_000, turnoverPct: 1, pct: 0 },
  { date: "2026-01-02", open: 10, high: 10.6, low: 10, close: 10.5, volumeHands: 300_000, amountYuan: 315_000_000, turnoverPct: 3, pct: 5 },
  { date: "2026-01-05", open: 10.5, high: 10.8, low: 10.4, close: 10.7, volumeHands: 200_000, amountYuan: 214_000_000, turnoverPct: 2, pct: 1.9 },
];

const bar = (date: string, time: string, over: Partial<ResearchMinuteBar> = {}): ResearchMinuteBar => ({
  date,
  time,
  open: 10.5,
  high: 10.6,
  low: 10.4,
  close: 10.5,
  volumeShares: 50_000,
  amountYuan: 525_000,
  bid: 10.49,
  ask: 10.51,
  bidSize: 10_000,
  askSize: 10_000,
  volumeRatio: 2,
  turnoverPct: 3,
  mcapYi: 100,
  floatMcapYi: 80,
  suspended: false,
  oneLineUp: false,
  oneLineDown: false,
  ...over,
});

const universe = (date: string): ResearchUniverseSnapshot => ({
  date,
  source: "fixture",
  entries: [{ code: "600000", name: "测试股份", active: true, prevClose: 10, mcapYi: 100, floatMcapYi: 80 }],
});

describe("严格研究 runner", () => {
  test("Jev 决定买入与退出，只用 14:45 ask、未来分钟 bid，并丢弃 split 边界标签", async () => {
    const minutes: Record<string, ResearchMinuteBar[]> = {
      "2026-01-02/600000": [
        bar("2026-01-02", "09:30", { open: 10, close: 10.1, ask: 10.11, volumeShares: 10_000_000, amountYuan: 100_500_000 }),
        bar("2026-01-02", "14:45", { open: 10.4, close: 10.5, bid: 10.49, ask: 10.51, volumeShares: 10_000_000, amountYuan: 105_000_000 }),
      ],
      "2026-01-05/600000": [
        bar("2026-01-05", "09:30", { open: 10.8, close: 10.9, bid: 10.89 }),
        bar("2026-01-05", "10:00", { open: 10.9, close: 11, bid: 10.99 }),
      ],
    };
    const loader: ResearchRunnerLoader = {
      listDates: async () => ["2026-01-02", "2026-01-05", "2026-01-06"],
      loadUniverse: async (date) => universe(date),
      loadDaily: async () => daily,
      loadMinutes: async (date, code) => minutes[`${date}/${code}`] ?? [],
    };

    const jev: Model = {
      name: "jev-fixture",
      decide: async (state): Promise<Decision> => {
        if (state.decisionMode === "buy") {
          return {
            action: "buy",
            probabilities: { buy: 0.8, sell: 0, hold: 0.2 },
            probabilitySemantics: "model-prompt",
            picks: [{ code: "600000", name: "测试股份", probability: 0.8, score: 1, reasons: ["fixture"] }],
            latencyMs: 1,
            late: false,
            inputTokens: 1,
            modelFailed: false,
            trace: { source: "jev", model: "jev-fixture", call: "remote", status: "ok" },
          };
        }
        const p = state.positions?.[0];
        const sell = Boolean(p && p.price >= 10.95);
        return {
          action: sell ? "sell" : "hold",
          probabilities: { buy: 0, sell: sell ? 0.8 : 0, hold: sell ? 0.2 : 1 },
          probabilitySemantics: "model-prompt",
          picks: sell && p ? [{ code: p.code, name: p.name, probability: 0.8, score: 0, reasons: ["fixture"] }] : [],
          latencyMs: 1,
          late: false,
          inputTokens: 1,
          modelFailed: false,
          trace: { source: "jev", model: "jev-fixture", call: "remote", status: "ok" },
        };
      },
    };
    const report = await runResearchBacktest(manifest, loader, { split: "train", jevModel: jev });
    expect(report.parameters.k).toBeGreaterThan(0);
    expect(report.splits.train.trades).toBe(1);
    expect(report.splits.train.tradesDetail[0]!.entry).toBe(10.51);
    expect(report.splits.train.tradesDetail[0]!.exit).toBe(10.99);
    expect(report.splits.train.tradesDetail[0]!.exitSource).toBe("jev");
    expect(report.splits.train.labelsDetail[0]!.status).toBe("sold-by-jev");
    expect(report.splits.train.boundaryExcluded).toBe(1);
    expect(report.splits.validation.trades).toBe(0);
    expect(report.splits.test.trades).toBe(0);
  });
});
