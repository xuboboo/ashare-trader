import { describe, expect, test } from "bun:test";
import { buildShadowRow, type ShadowOpinion } from "../src/engine";
import { config } from "../src/config";
import type { Decision } from "../src/model";

const opinion = (model: string, action: string): ShadowOpinion => ({ model, action, picks: [] });

/** 完整的一个决策，用来验证落盘行只保留可比字段。 */
const decision: Pick<Decision, "action" | "trace" | "picks"> = {
  action: "buy",
  trace: { source: "jev", model: "jev-latest", call: "remote", status: "ok" },
  picks: [
    {
      code: "300058",
      name: "蓝色光标",
      probability: 0.61,
      score: 42,
      reasons: ["放量", "站回均线"],
      priceOffsetPct: 1.5,
    },
  ],
};

describe("影子对照行的样本标记", () => {
  test("盘内可执行轮次：phase 与 executable=true 一起落盘", () => {
    const row = buildShadowRow({ time: "14:50", phase: "continuous", executable: true, decision, shadow: [opinion("factor", "hold")], ts: 1 });
    expect(row.phase).toBe("continuous");
    expect(row.executable).toBe(true);
    expect(row.active).toBe(config.model); // 记的是"当时哪个模型在生产位"，不写死
    expect(row.activeTrace?.source).toBe("jev");
    expect(row.shadow).toHaveLength(1);
  });

  test("盘后 force-scan：executable=false 必须显式写出来，不能被省略成 undefined", () => {
    const row = buildShadowRow({ time: "23:16", phase: "closed", executable: false, decision, shadow: [opinion("local", "hold")], ts: 1 });
    expect(row.executable).toBe(false);
    // 关键断言：JSON 里字段真的存在。省略字段 = 与旧行无法区分 = 过滤规则形同虚设
    const json = JSON.stringify(row);
    expect(json).toContain('"executable":false');
    expect(json).toContain('"phase":"closed"');
  });

  test("流水只留可比字段：name/score/reasons/价格意图不进 shadow 行", () => {
    const row = buildShadowRow({ time: "14:50", phase: "continuous", executable: true, decision, shadow: [], ts: 1 });
    expect(row.picks).toEqual([{ code: "300058", probability: 0.61 }]);
  });
});
