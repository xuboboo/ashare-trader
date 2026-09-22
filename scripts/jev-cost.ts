/**
 * Jev 调用成本读数器：把 data/jev-cost.jsonl 按天汇总成"调用次数 / token 合计 / 估算费用"。
 * 回答"这钱花得值不值"的成本侧；和 jev-vs-random 的收益侧对照即是 ROI。
 * 只读，不写、不跑引擎。
 *
 * 用法：bun scripts/jev-cost.ts
 */
import { join } from "node:path";
import { config } from "../src/config";

export interface CostRow {
  date: string;
  side: string;
  call: "remote" | "cache";
  tokens: number;
  latencyMs: number;
}

export interface DayCost {
  date: string;
  remoteCalls: number;
  cacheHits: number;
  tokens: number;
}

/** TypeSafe 公示输入价（$0.042/百万 token，README 标注未独立复测）——只用于量级估算。 */
const USD_PER_MTOKEN = 0.042;

export function summarizeByDate(rows: CostRow[]): DayCost[] {
  const by = new Map<string, DayCost>();
  for (const r of rows) {
    const d = by.get(r.date) ?? { date: r.date, remoteCalls: 0, cacheHits: 0, tokens: 0 };
    if (r.call === "remote") d.remoteCalls++;
    else d.cacheHits++;
    d.tokens += r.tokens; // 只有 remote 计费；cache 命中 tokens 记 0（jev 回复缓存不落 inputTokens 到计费）
    by.set(r.date, d);
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export const estUsd = (tokens: number): number => (tokens / 1_000_000) * USD_PER_MTOKEN;

async function main(): Promise<void> {
  const f = join(config.dataDir, "jev-cost.jsonl");
  if (!(await Bun.file(f).exists())) {
    console.log("尚无 jev-cost.jsonl —— 引擎还没在交易时段真调 Jev。明早 09:00 起跑后自动生成。");
    return;
  }
  const rows: CostRow[] = (await Bun.file(f).text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const days = summarizeByDate(rows);
  const totalTokens = days.reduce((s, d) => s + d.tokens, 0);
  const totalRemote = days.reduce((s, d) => s + d.remoteCalls, 0);
  console.log(`\n=== Jev 调用成本（${days.length} 天，输入价估算 $${USD_PER_MTOKEN}/M token，未独立复测）===`);
  console.log("日期          远端调用  缓存命中   tokens      估算$");
  for (const d of days.slice(-20)) {
    console.log(`  ${d.date}   ${String(d.remoteCalls).padStart(5)}    ${String(d.cacheHits).padStart(5)}  ${String(d.tokens).padStart(8)}   $${estUsd(d.tokens).toFixed(4)}`);
  }
  console.log(`\n合计：远端调用 ${totalRemote} 次 · tokens ${totalTokens} · 估算 $${estUsd(totalTokens).toFixed(4)}`);
}

if (import.meta.main) await main();
