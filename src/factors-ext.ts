/**
 * 近 10 日振幅（A10）与 10 日区间位置（RPOS10）：给 Jev 的参考特征。
 *
 * 2026-09-28 因子研究结论（scripts/amp-factor-study.py + data/factor_oos_test.py）：
 * 在策略候选池（涨幅3-7% + 量比>=1.5 + 站上VWAP）内，
 *   - 低振幅（A10 <= 当日池内中位数）与贴近 10 日高点（RPOS10 >= 0.8）
 *     在 train/valid/test 三段全部为正（5 日持有，净 +78~+151bp）；
 *   - 而 1 日持有在所有段位都为负 —— 高换手在此成本结构下不可行。
 * 因此把这两个量作为特征交给 Jev 参考，而不是硬编码成筛选项。
 *
 * 数据源：data/research/daily/*.json（通达信 raw 日线，裸数组）。
 * 新鲜度放宽到 7 个自然日（研究数据每日收盘后才更新，比 data/daily 慢一天）。
 */
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { config } from "./config";
import type { DailyBar } from "./quotes";

export interface Momentum {
  amp10: number;
  rpos10: number;
}

const existsDir = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

function fresh(bars: DailyBar[], today: string, maxDays: number): boolean {
  const last = bars[bars.length - 1]?.date;
  if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last)) return false;
  const days = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 86_400_000;
  return days >= 0 && days <= maxDays;
}

export async function loadMomentumMap(today: string, maxAgeDays = 7): Promise<Map<string, Momentum>> {
  const dir = join(config.dataDir, "research", "daily");
  const out = new Map<string, Momentum>();
  if (!(await existsDir(dir))) return out;
  const glob = new Bun.Glob("*.json");
  for await (const f of glob.scan({ cwd: dir })) {
    const code = f.replace(/\.json$/, "");
    if (!/^\d{6}$/.test(code)) continue;
    const bars: DailyBar[] = (await Bun.file(join(dir, f)).json().catch(() => null)) ?? [];
    if (bars.length < 11 || !fresh(bars, today, maxAgeDays)) continue;
    const amps: number[] = [];
    for (let i = bars.length - 10; i < bars.length; i++) {
      const b = bars[i]!;
      const pc = bars[i - 1]!.close;
      amps.push(pc > 0 ? (b.high - b.low) / pc : 0);
    }
    const amp10 = amps.reduce((a, b) => a + b, 0) / amps.length;
    const window = bars.slice(-10);
    const hi = Math.max(...window.map((b) => b.high));
    const lo = Math.min(...window.map((b) => b.low));
    const close = bars[bars.length - 1]!.close;
    const rpos10 = hi > lo ? (close - lo) / (hi - lo) : 0.5;
    if (Number.isFinite(amp10) && Number.isFinite(rpos10)) out.set(code, { amp10, rpos10 });
  }
  return out;
}
