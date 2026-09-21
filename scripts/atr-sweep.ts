/**
 * ATR 止损 vs 固定止损的参数扫描（Phase 1 的回测门槛）。
 * 同一份日线数据，6 组配置各跑一遍，输出对比表与三门槛判定。
 *
 * 门槛（三条全部从 simulate 的结果现场算）：
 *  1. 至少 3 个**相邻**的 k 值净期望优于 fixed 基线（"相邻"很关键：散点赢不算鲁棒）
 *  2. 最大回撤不比基线恶化超过 5 个百分点
 *  3. 止损触发率不高于基线 1.5 倍（旧实现把这条直接写成"天然满足"，等于没测）
 *
 * 口径提醒：本脚本读 .env 的 SIZE_CNY/CNY_BANKROLL —— 跨时间对比必须在同一档资金下跑，
 * 而 3300 元档的往返成本是 5 万档的 3 倍以上。表头会把这一档的名义成本打印出来。
 */
import { loadStocks, simulate } from "./backtest";
import { config } from "../src/config";
import { roundTrip } from "../src/costs";
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

/** 止损触发率：出场说明里提到止损（含跳空开在止损下方）的占比 */
const stopRate = (trips: { note: string }[]): number =>
  trips.length ? trips.filter((t) => t.note.includes("止损")).length / trips.length : 0;

console.log(
  `数据 ${stocks.length} 支 · 同一份日线 · 同一套硬筛选与出场规则 · ` +
    `资金档 ${config.bankrollCny} 元 / 单笔 ${config.sizeCny} 元（名义往返 ${roundTrip(config.sizeCny).bps.toFixed(1)}bp）\n`,
);
const rows = configs.map((c) => {
  // 刻意关掉风控闸：开闸后每组参数的成交集不同（风控会提前停手），就不是同一个样本上的对比了。
  // 止盈损机制的边际效果必须在同一批交易上量；风控自成一档，单独用 backtest 评估。
  const { result } = simulate({ stocks, indexBars, k: 3, quiet: true, riskGate: false, stopMode: c.stopMode, atrK: c.atrK });
  return { label: c.label, k: c.atrK, r: result, sr: stopRate(result.trips) };
});

const base = rows[0]!;
const atrRows = rows.slice(1);
console.log("配置            交易日  交易数  胜率    每笔净期望  止损触发率   总收益    最大回撤");
for (const { label, r, sr } of rows) {
  console.log(
    label.padEnd(14) +
      String(r.days).padStart(5) +
      String(r.trades).padStart(7) +
      (r.trades ? r.winRate.toFixed(1) + "%" : "    -").padStart(8) +
      (r.trades ? (r.netBps.toFixed(1) + "bp").padStart(12) : "        -") +
      (r.trades ? (sr.toFixed(2) + "×").padStart(9) : "      -") +
      (r.totalReturnPct.toFixed(1) + "%").padStart(10) +
      (r.maxDrawdownPct.toFixed(1) + "%").padStart(10),
  );
}

// ---- 三门槛判定 ----
// 门槛 1："≥3 个相邻 k" —— 按 k 升序找最长的连续胜过段，不是数总共几个胜过
const ks = atrRows.filter((x) => x.k !== undefined).sort((a, b) => a.k! - b.k!);
let bestRun = 0;
let run = 0;
for (const x of ks) {
  if (x.r.trades > 0 && x.r.netBps > base.r.netBps) run++;
  else run = 0;
  bestRun = Math.max(bestRun, run);
}
const ddOk = atrRows.filter((x) => x.r.maxDrawdownPct <= base.r.maxDrawdownPct + 5);
const srOk = atrRows.filter((x) => x.sr <= base.sr * 1.5);
const g1 = bestRun >= 3;
const g2 = ddOk.length === atrRows.length;
const g3 = srOk.length === atrRows.length;
console.log(`\n门槛1（≥3 个相邻 k 优于基线）：最长连胜段 ${bestRun}（胜过 ${ks.filter((x) => x.r.netBps > base.r.netBps).length}/${ks.length}）-> ${g1 ? "通过" : "不通过"}`);
console.log(`门槛2（回撤恶化 ≤ 5pp）：${ddOk.length}/${atrRows.length} -> ${g2 ? "通过" : "不通过"}`);
console.log(`门槛3（止损触发率 ≤ 1.5× 基线 ${base.sr.toFixed(2)}）：${srOk.length}/${atrRows.length} -> ${g3 ? "通过" : "不通过"}`);
console.log(`\n结论：${g1 && g2 && g3 ? "通过，可进 Phase 2" : "未通过 —— 默认保持 fixed"}`);
console.log("提醒：6 组参数在同一份数据上比较，本身就是多重比较；胜出幅度小于标准误的应当当作噪声。");
console.log("另外：ATR 是减损器不是盈利来源 —— 门槛通过只说明『亏得少一点』，不代表期望转正。");
