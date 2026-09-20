import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { collapseJevPrefix } from "../src/config";
import { featuresFromSnapshot, scoreStock, type Scored } from "../src/factors";
import { buildState, eligible, type JevAsk, JevModel } from "../src/jev";
import { roundTrip } from "../src/costs";
import type { SignalState } from "../src/model";
import { mkSnap } from "./helpers";

const TMP = "test/tmp-jev";
const costBps = roundTrip(50_000).bps;

const cand = (code: string, name: string, over = {}): Scored =>
  scoreStock(featuresFromSnapshot(mkSnap({ code, name, ...over }), "2026-09-21"));

const state = (candidates: Scored[], over: Partial<SignalState> = {}): SignalState => ({
  date: "2026-09-21",
  time: "14:45",
  horizon: "尾盘买入、次日 10:00 前清仓",
  gate: { allowed: true, reasons: ["ok"] },
  index: { price: 3900, pct: 0.5, amountYi: 9000, ma5: 3850 },
  candidates,
  heldCodes: [],
  allowed: { buy: true, sell: false },
  vetoes: {},
  openSlots: 3,
  ...over,
});

/** 假模型：按 code 给定的概率回答，不联网。 */
function fakeAsk(
  table: Record<string, number>,
  seen: { calls: number; questions?: Record<string, unknown>; state?: unknown } = { calls: 0 },
): JevAsk {
  return async ({ state: st, questions }) => {
    seen.calls++;
    seen.questions = questions;
    seen.state = st;
    const answers: Record<string, { type: string; probability: number }> = {};
    for (const [id, q] of Object.entries(questions as Record<string, { instructions: string }>)) {
      const code = /\((\d{6})\)/.exec(q.instructions)?.[1] ?? "";
      answers[id] = { type: "boolean", probability: table[code] ?? 0.5 };
    }
    return { answers, inputTokens: 1234 };
  };
}

const model = (ask: JevAsk, apiKey: string | null = "test-key") => new JevModel(ask, { apiKey, dataDir: TMP });

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("Jev 模型接入", () => {
  test("只问通过硬约束的候选，被 veto 的不浪费一次提问", () => {
    const list = [cand("002156", "甲"), cand("603986", "乙"), cand("000001", "丙", { volumeRatio: 0.4 })];
    const got = eligible(state(list, { vetoes: { "603986": "大额减持" } })).map((c) => c.features.code);
    expect(got).toEqual(["002156"]); // 乙被 veto、丙量比不达标
  });

  test("没配 key → 降级回规则层并标 modelFailed，但不是不出单", async () => {
    const seen = { calls: 0 };
    const d = await model(fakeAsk({ "002156": 0.99 }, seen), null).decide(state([cand("002156", "甲")]));
    expect(seen.calls).toBe(0);
    expect(d.modelFailed).toBe(true);
    expect(d.picks.map((p) => p.code)).toEqual(["002156"]); // 规则层结论仍然有效
  });

  test("按概率过滤与排序，并把胜率写进理由", async () => {
    const a = cand("002156", "甲");
    const b = cand("603986", "乙", { volumeRatio: 2.6 });
    const d = await model(fakeAsk({ "002156": 0.62, "603986": 0.81 })).decide(state([a, b]));
    expect(d.modelFailed).toBe(false);
    expect(d.action).toBe("buy");
    expect(d.picks.map((p) => p.code)).toEqual(["603986", "002156"]); // 概率高的在前
    expect(d.picks[0]!.probability).toBeCloseTo(0.81, 6);
    expect(d.picks[0]!.reasons.some((r) => r.includes("Jev 判定 81%"))).toBe(true);
    expect(d.inputTokens).toBe(1234);
    expect(d.probabilities.buy + d.probabilities.hold).toBeCloseTo(1, 6);
  });

  test("低于 JEV_MIN_PROB 就不采纳；全部不及格是 hold，不硬凑一单", async () => {
    // 专用日期：否则会命中上一个用例写下的缓存（相同输入不重复计费是故意的）
    const d = await model(fakeAsk({ "002156": 0.42, "603986": 0.31 })).decide(
      state([cand("002156", "甲"), cand("603986", "乙", { volumeRatio: 2.6 })], { date: "2026-09-22" }),
    );
    expect(d.picks).toHaveLength(0);
    expect(d.action).toBe("hold");
    expect(d.modelFailed).toBe(false); // 模型正常回答、只是不够确定，两件事不能混为一谈
    expect(d.probabilities.hold).toBe(1);
  });

  test("调用失败/超时 → 降级规则层，不抛异常打断心跳", async () => {
    const boom: JevAsk = async () => {
      throw new Error("timeout");
    };
    const d = await model(boom).decide(state([cand("002156", "甲")]));
    expect(d.modelFailed).toBe(true);
    expect(d.picks).toHaveLength(1);
  });

  test("返回里没有可用概率 → 降级，而不是拿 0 当结论", async () => {
    const junk: JevAsk = async () => ({ answers: { q0: { type: "boolean" } as never }, inputTokens: 0 });
    const d = await model(junk).decide(state([cand("002156", "甲")]));
    expect(d.modelFailed).toBe(true);
  });

  test("同样的 state 命中缓存，不重复计费", async () => {
    const seen = { calls: 0 };
    const m = model(fakeAsk({ "002156": 0.9 }, seen));
    const s = state([cand("002156", "甲")], { date: "2026-09-23" });
    await m.decide(s);
    await m.decide(s);
    expect(seen.calls).toBe(1);
  });

  test("模型看到的 state 与规则层同源，且问题里写明成本与退出规则", async () => {
    const seen: { calls: number; questions?: Record<string, unknown>; state?: unknown } = { calls: 0 };
    await model(fakeAsk({ "002156": 0.9 }, seen)).decide(state([cand("002156", "甲")], { date: "2026-09-24" }));
    const st = seen.state as ReturnType<typeof buildState>;
    expect(st.roundTripCostBps).toBeCloseTo(costBps, 1);
    expect(st.candidates[0]!.code).toBe("002156");
    expect(st.candidates[0]!.gainPct).toBeCloseTo(5, 0);
    expect(st.gate.allowed).toBe(true);
    const q = (seen.questions as Record<string, { type: string; instructions: string }>).q0!;
    expect(q.type).toBe("boolean");
    expect(q.instructions).toContain("扣除约");
    expect(q.instructions).toContain("10:00");
  });

  test("闸门关闭时不花模型调用", async () => {
    const seen = { calls: 0 };
    const d = await model(fakeAsk({}, seen)).decide(
      state([cand("002156", "甲")], { gate: { allowed: false, reasons: ["跌破 5 日线"] } }),
    );
    expect(seen.calls).toBe(0);
    expect(d.action).toBe("hold");
  });
});

describe("collapseJevPrefix：环境变量写重前缀时收敛", () => {
  test("jev-jev-latest → jev-latest", () => {
    expect(collapseJevPrefix("jev-jev-latest")).toBe("jev-latest");
  });
  test("正常 id 原样保留", () => {
    expect(collapseJevPrefix("jev-latest")).toBe("jev-latest");
    expect(collapseJevPrefix("jev-1.13.0")).toBe("jev-1.13.0");
  });
  test("不带 jev- 前缀的 id 不强加前缀，只去空白", () => {
    expect(collapseJevPrefix("latest")).toBe("latest");
    expect(collapseJevPrefix("  jev-latest ")).toBe("jev-latest");
  });
});
