import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { nextDayExit } from "../src/exit";
import { featuresFromSnapshot, scoreStock, type Scored } from "../src/factors";
import { LOCAL_FEATURES, LocalModel, featureVec, sigmoid, type LocalWeights } from "../src/local";
import type { SignalState } from "../src/model";
import { mkSnap } from "./helpers";

const TMP = "test/tmp-local";

const cand = (code: string, name: string, over = {}): Scored =>
  scoreStock(featuresFromSnapshot(mkSnap({ code, name, ...over }), "2026-09-21"));

const state = (candidates: Scored[], over: Partial<SignalState> = {}): SignalState => ({
  date: "2026-09-21",
  time: "14:45",
  horizon: "尾盘买入；退出时点由 Jev 自主决定",
  gate: { allowed: true, reasons: ["ok"] },
  index: { price: 3900, pct: 0.5, amountYi: 9000, ma5: 3850 },
  candidates,
  heldCodes: [],
  allowed: { buy: true, sell: false },
  vetoes: {},
  openSlots: 3,
  ...over,
});

/** 人造权重：按特征名给偏好（其余 0），可预测地操纵概率，且对特征表扩展稳健。 */
const weights = (byName: Record<string, number>, b = 0): LocalWeights => ({
  trainedAt: "test",
  costBps: 37,
  featureNames: LOCAL_FEATURES.map((f) => f.name),
  mean: LOCAL_FEATURES.map(() => 0),
  std: LOCAL_FEATURES.map(() => 1),
  w: LOCAL_FEATURES.map((f) => byName[f.name] ?? 0),
  b,
  metrics: {
    trainSamples: 1,
    valSamples: 1,
    trainBaseRate: 0.5,
    valBaseRate: 0.5,
    valAuc: 0.5,
    valBrier: 0.25,
    valAcceptedNetBps: null,
    valAcceptedCount: 0,
    valMinProb: 0.55,
  },
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("共享出场规则 nextDayExit（回测与训练同一口径）", () => {
  const next = { open: 10.6, high: 10.9, low: 10.2, close: 10.8 };
  test("触及止损按止损价走", () => {
    const o = nextDayExit({ next: { ...next, low: 10.18 }, prevClose: 10, entry: 10.51, stop: 10.19, limitPctFrac: 0.1 });
    expect(o.legs).toHaveLength(1);
    expect(o.legs[0]!.price).toBe(10.19);
    expect(o.blended).toBe(10.19);
  });
  test("跳空开在止损之下按开盘价走，不假装还能止损价卖出", () => {
    const o = nextDayExit({ next: { ...next, open: 10.0, low: 9.8 }, prevClose: 10, entry: 10.51, stop: 10.19, limitPctFrac: 0.1 });
    expect(o.legs[0]!.price).toBe(10.0);
  });
  test("高开超阈值两腿减半：一半开盘价、一半收盘价，blended 是加权价", () => {
    const gapOpen = { open: 10.9, high: 11.2, low: 10.3, close: 11.0 }; // 高开 3.7%
    const o = nextDayExit({ next: gapOpen, prevClose: 10, entry: 10.51, stop: 10.19, gapTrimPct: 3, qty: 1000, limitPctFrac: 0.1 });
    expect(o.legs).toHaveLength(2);
    expect(o.legs[0]).toMatchObject({ qty: 500, price: 10.9 });
    expect(o.legs[1]).toMatchObject({ qty: 500, price: 11.0 });
    expect(o.blended!).toBeCloseTo(10.95, 6);
  });
  test("一字跌停卖不出：空腿，blended 为 null", () => {
    const o = nextDayExit({ next: { open: 9, high: 9, low: 9, close: 9 }, prevClose: 10, entry: 10.51, stop: 10.19, limitPctFrac: 0.1 });
    expect(o.legs).toHaveLength(0);
    expect(o.blended).toBeNull();
  });
});

describe("本地概率模型 LocalModel", () => {
  test("sigmoid 与特征向量的基本性质", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(10)).toBeGreaterThan(0.999);
    const c = cand("002156", "甲");
    const x = featureVec(c);
    expect(x).toHaveLength(LOCAL_FEATURES.length);
    expect(x.every(Number.isFinite)).toBe(true);
  });

  test("人造权重下：分高的候选概率高、被采纳；低于阈值的不硬凑", async () => {
    const a = cand("002156", "甲");
    const b = cand("603986", "乙", { volumeRatio: 2.6 });
    // factorScore 权重给大正值、其余 0：分高者概率趋近 1（不预设谁分高，动态判断）
    const w = weights({ factorScore: 8 }, -1);
    const higher = a.score >= b.score ? "002156" : "603986";
    const d = await new LocalModel({ weights: w, budgetCny: 50_000 }).decide(state([a, b]));
    expect(d.action).toBe("buy");
    expect(d.modelFailed).toBe(false);
    expect(d.picks[0]!.code).toBe(higher);
    expect(d.picks[0]!.probability).toBeGreaterThan(0.55);
    expect(d.picks[0]!.reasons.some((r) => r.includes("本地模型判定"))).toBe(true);
    expect(d.probabilities.buy + d.probabilities.hold).toBeCloseTo(1, 6);
  });

  test("权重把所有候选压到阈值之下时是 hold，且不是模型失败", async () => {
    const w = weights({ factorScore: -8 }, -4); // 全部概率趋近 0
    const d = await new LocalModel({ weights: w, budgetCny: 50_000 }).decide(state([cand("002156", "甲")]));
    expect(d.action).toBe("hold");
    expect(d.picks).toHaveLength(0);
    expect(d.modelFailed).toBe(false); // 模型正常工作、只是不看好
    expect(d.probabilities.hold).toBeCloseTo(1, 6);
  });

  test("没有模型文件 → 降级规则层并标 modelFailed", async () => {
    const d = await new LocalModel({ weights: null, budgetCny: 50_000 }).decide(state([cand("002156", "甲")]));
    expect(d.modelFailed).toBe(true);
    expect(d.picks).toHaveLength(1); // 规则层结论仍有效
  });

  test("闸门关闭不花模型；同一输入概率完全确定", async () => {
    const w = weights({ factorScore: 8 }, -1);
    const m = new LocalModel({ weights: w, budgetCny: 50_000 });
    const closed = await m.decide(state([cand("002156", "甲")], { gate: { allowed: false, reasons: ["跌破 5 日线"] } }));
    expect(closed.action).toBe("hold");
    const p1 = (await m.decide(state([cand("002156", "甲")]))).picks[0]!.probability;
    const p2 = (await m.decide(state([cand("002156", "甲")]))).picks[0]!.probability;
    expect(p1).toBe(p2);
  });

  test("日线口径与快照口径的同一状态给出同一概率（回测/实盘同一性）", async () => {
    const { featuresFromDaily } = await import("../src/factors");
    // 字段刻意对齐：vwap = amount/volume = 3.12e8/3e7 = 10.4、量比 = 300000/166666.7 = 1.8
    const bar = {
      date: "2026-09-18", open: 10.1, close: 10.5, high: 10.6, low: 10.05,
      volumeHands: 300_000, amountYuan: 3.12e8, turnoverPct: 5, pct: 5,
    };
    const prevBar = { ...bar, close: 10, date: "2026-09-17" };
    const daily = scoreStock(featuresFromDaily(bar, prevBar, 166_666.666_7, "002156", "002156"));
    const live = cand("002156", "测试股份", { code: "002156", amountYuan: 3.12e8 });
    expect(daily.rejects).toEqual(live.rejects); // 两口径同一套硬筛选结论
    const vd = featureVec(daily);
    const vl = featureVec(live);
    vd.forEach((v, i) => expect(v).toBeCloseTo(vl[i]!, 6)); // 全部特征一一对应
    const w = weights({ factorScore: 8 }, -1);
    const pd = await new LocalModel({ weights: w, budgetCny: 50_000 }).decide(state([daily]));
    const pl = await new LocalModel({ weights: w, budgetCny: 50_000 }).decide(state([live]));
    expect(pd.action).toBe(pl.action);
    expect(pd.picks[0]!.probability).toBeCloseTo(pl.picks[0]!.probability, 9);
  });
});
