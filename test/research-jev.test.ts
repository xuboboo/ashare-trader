import { describe, expect, test } from "bun:test";
import { simulateJevExit } from "../src/research-jev";
import type { Decision, Model } from "../src/model";
import type { ResearchMinuteBar } from "../src/research";

const bar = (date: string, time: string, over: Partial<ResearchMinuteBar> = {}): ResearchMinuteBar => ({
  date,
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

const entryInfo = { code: "600000", name: "测试股份", active: true, prevClose: 10 };

const decision = (state: Parameters<Model["decide"]>[0], sell: boolean): Decision => {
  const p = state.positions?.[0];
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
};

describe("Jev 自主持仓标签", () => {
  test("不依赖 10:00：Jev 在可见分钟自主卖出并按 bid 成交", async () => {
    const model: Model = {
      name: "jev-fixture",
      decide: async (state) => decision(state, (state.positions?.[0]?.price ?? 0) >= 10.5),
    };
    const result = await simulateJevExit({
      entryDate: "2026-01-02",
      entryTime: "14:45",
      entry: 10,
      qty: 100,
      stop: 9,
      limitDown: 9,
      code: "600000",
      entryInfo,
      future: [{
        date: "2026-01-05",
        bars: [
          bar("2026-01-05", "09:30", { close: 10.2, bid: 10.19 }),
          bar("2026-01-05", "09:31", { close: 10.6, bid: 10.59 }),
        ],
      }],
      model,
    });
    expect(result.status).toBe("sold-by-jev");
    expect(result.exitTime).toBe("09:31");
    expect(result.exitPrice).toBe(10.59);
    expect(result.decisionRounds).toBe(2);
  });

  test("硬止损先于 Jev，触发时不调用模型", async () => {
    let calls = 0;
    const model: Model = {
      name: "jev-fixture",
      decide: async (state) => {
        calls++;
        return decision(state, true);
      },
    };
    const result = await simulateJevExit({
      entryDate: "2026-01-02",
      entryTime: "14:45",
      entry: 10,
      qty: 100,
      stop: 9.8,
      limitDown: 9,
      code: "600000",
      entryInfo,
      future: [{ date: "2026-01-05", bars: [bar("2026-01-05", "09:30", { open: 9.7, low: 9.6, bid: 9.69 })] }],
      model,
    });
    expect(result.status).toBe("hard-stop");
    expect(result.exitPrice).toBe(9.69);
    expect(calls).toBe(0);
  });

  test("Jev 失败只生成 jev-failed，不伪造退出价", async () => {
    const model: Model = {
      name: "jev-fixture",
      decide: async () => ({
        action: "hold",
        probabilities: { buy: 0, sell: 0, hold: 1 },
        picks: [],
        latencyMs: 1,
        late: false,
        inputTokens: 0,
        modelFailed: true,
        trace: { source: "jev", model: "jev-fixture", call: "remote", status: "failed", reason: "timeout" },
      }),
    };
    const result = await simulateJevExit({
      entryDate: "2026-01-02",
      entryTime: "14:45",
      entry: 10,
      qty: 100,
      stop: 9,
      limitDown: 9,
      code: "600000",
      entryInfo,
      future: [{ date: "2026-01-05", bars: [bar("2026-01-05", "09:30")] }],
      model,
    });
    expect(result.status).toBe("jev-failed");
    expect(result.exitPrice).toBeUndefined();
    expect(result.jevFailures).toBe(1);
  });
});
