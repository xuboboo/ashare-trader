import { describe, expect, test } from "bun:test";
import { featuresFromSnapshot, scoreStock } from "../src/factors";
import { FactorModel, LlmAdvisory } from "../src/model";
import { mkSnap } from "./helpers";

const candidates = () => [
  scoreStock(featuresFromSnapshot(mkSnap({ code: "600000", name: "甲" }), "2026-09-18")),
  scoreStock(featuresFromSnapshot(mkSnap({ code: "000001", name: "乙", volumeRatio: 2.6, vwap: 10.2 }), "2026-09-18")),
];

const base = {
  date: "2026-09-18",
  time: "14:45",
  horizon: "尾盘买入、次日 10:00 前清仓",
  heldCodes: [] as string[],
  vetoes: {} as Record<string, string>,
  openSlots: 3,
  allowed: { buy: true, sell: false },
  index: { price: 3900, pct: 0.5, amountYi: 9000, ma5: 3850 },
  gate: { allowed: true, reasons: ["闸门通过"] },
};

describe("FactorModel", () => {
  test("闸门通过时按分数从高到低出候选，概率和为 1", async () => {
    const d = await new FactorModel().decide({ ...base, candidates: candidates() });
    expect(d.action).toBe("buy");
    expect(d.picks.length).toBeGreaterThan(0);
    expect(d.picks.length).toBeLessThanOrEqual(3);
    const sum = d.picks.reduce((s, p) => s + p.probability, 0);
    expect(sum).toBeCloseTo(d.probabilities.buy, 6);
    expect(d.probabilities.buy + d.probabilities.hold).toBeCloseTo(1, 6);
    expect(d.late).toBe(false);
  });

  test("分数必须真的排序，别把 2.5 分的排在 2.7 分前面", async () => {
    const c = candidates();
    const d = await new FactorModel().decide({ ...base, candidates: c });
    const scores = d.picks.map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("大盘闸门关掉 = 强制空仓，不选任何票", async () => {
    const d = await new FactorModel().decide({
      ...base,
      gate: { allowed: false, reasons: ["上证跌破 5 日线"] },
      candidates: candidates(),
    });
    expect(d.action).toBe("hold");
    expect(d.picks).toHaveLength(0);
    expect(d.probabilities.hold).toBe(1);
  });

  test("allowed.buy=false 或没有开仓额度时不出单", async () => {
    expect((await new FactorModel().decide({ ...base, allowed: { buy: false, sell: true }, candidates: candidates() })).picks).toHaveLength(0);
    expect((await new FactorModel().decide({ ...base, openSlots: 0, candidates: candidates() })).picks).toHaveLength(0);
  });

  test("LLM veto 的股票被剔除，其余照常出单", async () => {
    const c = candidates();
    const top = [...c].sort((a, b) => b.score - a.score)[0]!.features.code;
    const d = await new FactorModel().decide({ ...base, candidates: c, vetoes: { [top]: "有大额减持" } });
    expect(d.picks.map((p) => p.code)).not.toContain(top);
    expect(d.picks.length).toBeGreaterThan(0);
  });

  test("预算买不起一手时不出推荐（1 万本金口径）", async () => {
    const poor = new FactorModel(330); // 330 元连 10.5 元股的一手都买不起
    const d = await poor.decide({ ...base, candidates: candidates() });
    expect(d.picks).toHaveLength(0);
    expect(d.action).toBe("hold");
    const rich = await new FactorModel(50_000).decide({ ...base, candidates: candidates() });
    expect(rich.picks.length).toBeGreaterThan(0);
  });

  test("候选全被否决时是 hold，而不是硬凑一单", async () => {
    const dead = [scoreStock(featuresFromSnapshot(mkSnap({ volumeRatio: 0.2, price: 9.9 }), "2026-09-18"))];
    expect(dead[0]!.rejects.length).toBeGreaterThan(0);
    const d = await new FactorModel().decide({ ...base, candidates: dead });
    expect(d.action).toBe("hold");
    expect(d.picks).toHaveLength(0);
  });
});

describe("LlmAdvisory 降级", () => {
  test("没配 LLM_API_KEY 时不否决、不失败，只标注未启用", async () => {
    const a = new LlmAdvisory();
    expect(a.enabled).toBe(false); // 测试环境没有 key
    const bias = await a.dailyBias({
      date: "2026-09-18",
      index: { price: 3900, pct: 0.5, amountYi: 9000 },
      ztCount: 60,
      maxLianBan: 4,
      topCandidates: [],
      headlines: [],
    });
    expect(bias.enabled).toBe(false);
    expect(bias.llmFailed).toBe(false);
    expect(bias.allowOpen).toBe(true);
    expect(bias.vetoes).toEqual({});
    expect(bias.emotionScore).toBe(0.5);
  });
});
