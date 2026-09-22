import { describe, expect, test } from "bun:test";
import { pxOffsetPctOf, SellAdvisor, type SellAnswer, type SellAssistAsk, type SellAssistInput } from "../src/sell-assist";

const pos = (code: string, unrealizedPct: number): SellAssistInput => ({
  code,
  name: "测试" + code,
  entry: 10,
  price: 10 * (1 + unrealizedPct / 100),
  unrealizedPct,
  stop: 9.7,
  heldDays: 1,
});

const advisor = (
  answers: Record<string, SellAnswer>,
  calls: { inputs?: SellAssistInput[] }[] = [],
) =>
  new SellAdvisor(
    async (inputs) => {
      calls.push({ inputs });
      const out: Record<string, SellAnswer> = {};
      inputs.forEach((p, i) => (out[p.code] = answers[`q${i}`] ?? { p: Number.NaN, offsetPct: null }));
      return out;
    },
    { threshold: 0.55 },
  );

describe("Jev 卖出辅助顾问", () => {
  test("批量：一次 ask 覆盖全部仓位，按 code 映射答案（概率 + 定价）", async () => {
    const calls: { inputs?: SellAssistInput[] }[] = [];
    const a = advisor(
      { q0: { p: 0.7, offsetPct: 1.0 }, q1: { p: 0.3, offsetPct: null } },
      calls,
    );
    const advices = await a.advise([pos("600000", 2), pos("000001", -1)]);
    expect(advices).toHaveLength(2);
    expect(advices[0]).toMatchObject({ code: "600000", suggestExit: true, priceOffsetPct: 1.0 });
    expect(advices[1]).toMatchObject({ code: "000001", suggestExit: false });
    expect(calls[0]!.inputs).toHaveLength(2);
    expect(calls[0]!.inputs![0]!.code).toBe("600000");
  });

  test("注入的阈值生效（不再直读全局配置）：0.5 阈值下 p=0.55 建议离场", async () => {
    const a = new SellAdvisor(
      async () => ({ "600000": { p: 0.55, offsetPct: 0 } }),
      { threshold: 0.5 },
    );
    expect((await a.advise([pos("600000", 2)]))[0]!.suggestExit).toBe(true);
    const b = new SellAdvisor(async () => ({ "600000": { p: 0.55, offsetPct: 0 } }), { threshold: 0.6 });
    expect((await b.advise([pos("600000", 2)]))[0]!.suggestExit).toBe(false);
  });

  test("ask 抛异常 → 全部不建议且带失败标注，不炸主流程", async () => {
    const a = new SellAdvisor(
      async () => {
        throw new Error("网络超时");
      },
    );
    const advices = await a.advise([pos("600000", 2)]);
    expect(advices[0]!.suggestExit).toBe(false);
    expect(advices[0]!.note).toContain("网络超时");
  });

  test("空仓位列表：不调用 ask 直接返回空", async () => {
    const calls: { inputs?: SellAssistInput[] }[] = [];
    const a = advisor({}, calls);
    expect(await a.advise([])).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("卖价评分档 pxOffsetPctOf", () => {
  test("score 插值成加价百分比：0=市价，顶格=+3%，分数线性", () => {
    expect(pxOffsetPctOf(0)).toBe(0);
    expect(pxOffsetPctOf(6)).toBeCloseTo(3);
    expect(pxOffsetPctOf(3)).toBeCloseTo(1.5);
    expect(pxOffsetPctOf(2)).toBeCloseTo(1.0);
  });
  test("越界钳制", () => {
    expect(pxOffsetPctOf(-2)).toBe(0);
    expect(pxOffsetPctOf(99)).toBeCloseTo(3);
  });
});
