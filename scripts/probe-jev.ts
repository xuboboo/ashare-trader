/**
 * Jev key 连通性探针：验证 TYPESAFE_AI_API_KEY 是否可用。
 * 只打印状态与延迟，绝不打印 key 本身。
 * 用法：在 .env 配好 TYPESAFE_AI_API_KEY 后运行 bun run scripts/probe-jev.ts
 */
import { config } from "../src/config";
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";

if (!config.typesafeApiKey) {
  console.error("!! TYPESAFE_AI_API_KEY 未配置");
  process.exit(1);
}
console.log(`key 已配置（长度 ${config.typesafeApiKey.length}，不回显）`);

const provider = createTypeSafeAi({ apiKey: config.typesafeApiKey, baseURL: config.typesafeBaseUrl });
const t0 = performance.now();
try {
  const r = await experimental_evaluate({
    model: provider.evaluationModel(config.jevModelId),
    state: { probe: "连通性测试" },
    questions: { q0: { type: "boolean", instructions: "1 加 1 等于 2。" } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(15_000),
  });
  const a = r.answers.q0 as { probability?: number } | undefined;
  console.log(
    `连通成功: model=${r.response?.modelId ?? config.jevModelId} 延迟 ${Math.round(performance.now() - t0)}ms 概率=${a?.probability ?? "?"}`,
  );
} catch (e) {
  console.error("连通失败:", (e as Error).message.slice(0, 300));
  process.exit(1);
}
