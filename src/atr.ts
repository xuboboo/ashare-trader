/**
 * 个股 ATR₁₄（简单均值版真实波幅）：STOP_MODE=atr 时决定止损距离。
 *
 * 数据源是 fetch-daily 落地的 data/daily/*.json（与回测同源），
 * 在 engine 启动与每日日切时各加载一次。股票不在缓存里 / 日线超过 3 个自然日
 * 未更新 / 数值异常 → 该股没有 ATR → makeBuyOrder 自动回退固定百分比止损，
 * 绝不因缺数据不设防。
 */
import { join } from "node:path";
import { config } from "./config";
import type { DailyBar } from "./quotes";

/** 最新 bar 距 today 不超过 3 个自然日才算新鲜（长周末正常，过期缓存不行）。 */
function fresh(bars: DailyBar[], today: string): boolean {
  const last = bars[bars.length - 1]?.date;
  if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last)) return false;
  const days = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 86_400_000;
  return days >= 0 && days <= 3;
}

export async function loadAtrMap(today: string, n: number = config.atrN): Promise<Map<string, number>> {
  const dir = join(config.dataDir, "daily");
  const out = new Map<string, number>();
  const glob = new Bun.Glob("*.json");
  for await (const f of glob.scan({ cwd: dir })) {
    const code = f.replace(/\.json$/, "");
    const j = await Bun.file(join(dir, f)).json().catch(() => null);
    const bars: DailyBar[] = j?.bars ?? [];
    if (bars.length < n + 1 || !fresh(bars, today)) continue;
    let sum = 0;
    for (let i = bars.length - n; i < bars.length; i++) {
      const b = bars[i]!;
      const pc = bars[i - 1]!.close;
      sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    const atr = sum / n;
    if (Number.isFinite(atr) && atr > 0) out.set(code, atr);
  }
  return out;
}
