/**
 * 总股本缓存（data/cache/shares.json）：code -> 总股本（亿股）。
 *
 * 为什么需要它：日线只有价格、没有股本，`MIN_MCAP_YI` 在日线口径下算不出来。
 * 旧实现直接写 mcapYi=0，让这个门槛**静默失效**（实盘却按市值过滤），回测/实盘
 * 因此不等价。这里存的是从实时快照回推的真实总股本：
 *
 *     shares(亿股) = 总市值(亿元) / 现价(元)
 *
 * 历史总市值 = shares × 前复权收盘价。送转/拆股已被前复权因子吸收，这一项在送转
 * 口径下是对的；增发/回购会让它偏小/偏大。另外前复权基准会随取数区间变化
 * （docs/DATA.md 的已知局限），缓存 asOf 与日线取数时刻差得越远越不准，
 * 所以 fetch-shares 应与 fetch-daily 一起定期重跑。
 */
import { join } from "node:path";
import { config } from "./config";

export interface SharesCache {
  /** ISO 时间戳：这份总股本是哪一刻的实时快照 */
  asOf: string;
  source: string;
  /** code -> 总股本（亿股） */
  entries: Record<string, number>;
}

export const sharesCachePath = () => join(config.dataDir, "cache", "shares.json");

export async function loadSharesCache(): Promise<SharesCache | null> {
  const j = (await Bun.file(sharesCachePath())
    .json()
    .catch(() => null)) as SharesCache | null;
  if (!j || typeof j.entries !== "object" || j.entries === null) return null;
  return j;
}

export async function saveSharesCache(cache: SharesCache): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(config.dataDir, "cache"), { recursive: true });
  await Bun.write(sharesCachePath(), JSON.stringify(cache, null, 1));
}

/** 由实时快照回推总股本（亿股）：总市值(亿) / 现价(元)。价格或市值无效返回 undefined。 */
export function sharesYiFrom(mcapYi: number, price: number): number | undefined {
  if (!(mcapYi > 0) || !(price > 0)) return undefined;
  return mcapYi / price;
}
