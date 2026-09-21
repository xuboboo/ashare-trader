import { describe, expect, test } from "bun:test";
import { SellAdvisor, type SellAssistAsk, type SellAssistInput } from "../src/sell-assist";

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
  answers: Record<string, number>,
  calls: { inputs?: SellAssistInput[] }[] = [],
) =>
  new SellAdvisor(
    async (inputs) => {
      calls.push({ inputs });
      const out: Record<string, number> = {};
      inputs.forEach((p, i) => (out[p.code] = answers[`q${i}`] ?? Number.NaN));
      return out;
    },
    { threshold: 0.55 },
  );

describe("Jev 卖出辅助顾问", () => {
  test("批量：一次 ask 覆盖全部仓位，按 code 映射答案", async () => {
    const calls: { inputs?: SellAssistInput[] }[] = [];
    const a = advisor({ q0: 0.7, q1: 0.3 }, calls);
    const advices = await a.advise([pos("600000", 2), pos("000001", -1)]);
    expect(advices).toHaveLength(2);
    expect(advices[0]).toMatchObject({ code: "600000", suggestExit: true });
    expect(advices[1]).toMatchObject({ code: "000001", suggestExit: false });
    expect(calls[0]!.inputs).toHaveLength(2);
    expect(calls[0]!.inputs![0]!.code).toBe("600000");
  });

  test("阈值 0.55：达到才建议提前离场", async () => {
    const a = advisor({ q0: 0.6, q1: 0.5 });
    const advices = await a.advise([pos("600000", 2), pos("000001", 2)]);
    expect(advices[0]!.suggestExit).toBe(true);
    expect(advices[1]!.suggestExit).toBe(false);
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
