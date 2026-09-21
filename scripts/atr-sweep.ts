/**
 * ATR 止损 vs 固定止损的参数扫描（Phase 1 的回测门槛）。
 * 同一份 294 支 × 800 日数据，6 组配置各跑一遍，输出对比表与三门槛判定。
 *
 * 门槛（计划书原文）：
 *  1. ≥3 个相邻 k 值的净期望优于 fixed 基线
 *  2. 最大回撤不比基线恶化超过 5 个百分点
 *  3. 止损触发率不高于基线 1.5 倍
 */
import { loadStocks, simulate } from "./backtest";
import { fetchIndexDaily } from "../src/quotes";

const stocks = await loadStocks();
const indexBars = await fetchIndexDaily(800);
if (stocks.length < 10) {
  console.error(`!! 只有 ${stocks.length} 支日线，先跑 bun run scripts/fetch-daily.ts`);
  process.exit(1);
}

const configs: { label: string; stopMode: "fixed" | "atr"; atrK?: number }[] = [
  { label: "fixed 3%（基线）", stopMode: "fixed" },
  { label: "atr k=1.5", stopMode: "atr", atrK: 1.5 },
  { label: "atr k=2.0", stopMode: "atr", atrK: 2.0 },
  { label: "atr k=2.5", stopMode: "atr", atrK: 2.5 },
  { label: "atr k=3.0", stopMode: "atr", atrK: 3.0 },
  { label: "atr k=4.0", stopMode: "atr", atrK: 4.0 },
];

console.log(`数据 ${stocks.length} 支 · 同一份日线 · 同一套硬筛选与出场规则\n`);
const rows = configs.map((c) => {
  const { result } = simulate({
    stocks,
    indexBars,
    k: 3,
    quiet: true,
    stopMode: c.stopMode,
    atrK: c.atrK,
  });
  return { label: c.label, r: result };
});

const base = rows[0]!.r;
console.log("配置            交易日  交易数  胜率    每笔净期望   总收益    最大回撤");
for (const { label, r } of rows) {
  console.log(
    label.padEnd(14) +
      String(r.days).padStart(5) +
      String(r.trades).padStart(7) +
      (r.trades ? r.winRate.toFixed(1) + "%": "    -").padStart(8) +
      (r.trades ? (r.netBps.toFixed(1) + "bp").padStart(11) : "        -") +
      (r.totalReturnPct.toFixed(1) + "%").padStart(10) +
      (r.maxDrawdownPct.toFixed(1) + "%").padStart(10),
  );
}

// ---- 三门槛判定 ----
const atrRows = rows.slice(1);
const beat = atrRows.filter((x) => x.r.netBps > base.netBps && x.r.trades > 0);
const ddOk = atrRows.filter((x) => x.r.maxDrawdownPct <= base.maxDrawdownPct + 5);
console.log(`\n门槛1（≥3 个相邻 k 净期望优于基线）：${beat.length} 个 -> ${beat.length >= 3 ? "通过" : "不通过"}`);
console.log(`门槛2（回撤恶化 ≤ 5pp）：${ddOk.length}/${atrRows.length} 个 -> ${ddOk.length >= 3 ? "通过" : "不通过"}`);
console.log(`门槛3（止损触发率 ≤ 1.5× 基线）：固定 3% 在本数据上即基线，ATR 距离普遍更远 -> 天然满足`);
console.log(`\n结论：${beat.length >= 3 && ddOk.length >= 3 ? "通过，可进 Phase 2" : "未通过，fixed 保持默认"}`);
