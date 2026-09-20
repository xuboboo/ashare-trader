/**
 * 股票池：全市场按成交额降序的前 N 只（主板+创业板），外加 WATCHLIST 自选。
 * 每天缓存一次到 data/cache/universe-<date>.json，盘中不重复打榜单接口。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { fetchTopByAmount } from "./quotes";
import { inScope, isSt } from "./symbols";

export interface UniverseEntry {
  code: string;
  name: string;
  amountYuan: number;
  rank: number;
}

export class Universe {
  entries: UniverseEntry[] = [];
  date = "";
  refreshedAt = 0;
  lastError: string | null = null;

  private path(date: string) {
    return join(config.dataDir, "cache", `universe-${date}.json`);
  }

  async get(date: string): Promise<UniverseEntry[]> {
    if (this.date === date && this.entries.length) return this.entries;
    try {
      const cached = await Bun.file(this.path(date)).json();
      if (Array.isArray(cached?.entries) && cached.entries.length) {
        this.entries = cached.entries;
        this.date = date;
        this.refreshedAt = cached.refreshedAt ?? 0;
        return this.entries;
      }
    } catch {
      /* 无缓存，去拉 */
    }
    await this.refresh(date);
    return this.entries;
  }

  async refresh(date: string): Promise<void> {
    try {
      // 多取一些，留出被 ST/停牌挤掉的名额
      const top = await fetchTopByAmount(Math.max(config.universeSize * 2, 100));
      const seen = new Set<string>();
      const entries: UniverseEntry[] = [];
      const push = (code: string, name: string, amountYuan: number) => {
        if (!inScope(code) || isSt(name) || seen.has(code)) return;
        seen.add(code);
        entries.push({ code, name, amountYuan, rank: entries.length + 1 });
      };
      for (const t of top) push(t.code, t.name, t.amountYuan);
      for (const code of config.watchlist) push(code, "", 0);
      this.entries = entries.slice(0, config.universeSize);
      this.date = date;
      this.refreshedAt = Date.now();
      this.lastError = null;

      await mkdir(join(config.dataDir, "cache"), { recursive: true });
      await Bun.write(this.path(date), JSON.stringify({ date, refreshedAt: this.refreshedAt, entries: this.entries }));
    } catch (e) {
      this.lastError = (e as Error).message;
      // 榜单拉不到时退回上一日的缓存，宁可股票池旧一点也不要空转
      if (!this.entries.length) {
        const prev = await Bun.file(this.path(date)).json().catch(() => null);
        this.entries = Array.isArray(prev?.entries) ? prev.entries : [];
      }
      console.error(`[universe] ${this.lastError}`);
    }
  }

  codes(): string[] {
    return this.entries.map((e) => e.code);
  }

  nameOf(code: string): string {
    return this.entries.find((e) => e.code === code)?.name ?? code;
  }
}
