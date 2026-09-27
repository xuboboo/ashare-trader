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

/** 榜单条目的最小形状（与 quotes.fetchTopByAmount 的返回一致）。 */
export interface TopEntry {
  code: string;
  name: string;
  amountYuan: number;
}

/**
 * 纯函数：把"成交额榜单 + 自选"合成股票池（不碰网络，测试直接喂数据）。
 *
 * 自选必须**先占位**。旧实现先填榜单、再把 WATCHLIST 追加到队尾，最后统一
 * `slice(0, UNIVERSE_SIZE)` —— 榜单通常已经填满，自选永远排在截断线之外，
 * 于是 `WATCHLIST` 成了一条永不生效的配置（没有测试覆盖，2026-09-28 发现）。
 * 这里改成：自选先入池，再用榜单补满。
 * 自选在榜单里时沿用榜单的名字与成交额（这样 ST 自选也能被 `isSt` 认出来），
 * 不在榜单里就用空名、成交额 0（仍然进得了池，只是照常受个股硬筛选约束）。
 */
export function buildUniverseEntries(top: TopEntry[], watchlist: string[], size: number): UniverseEntry[] {
  const topByCode = new Map(top.map((t) => [t.code, t]));
  const seen = new Set<string>();
  const entries: UniverseEntry[] = [];
  const push = (code: string, name: string, amountYuan: number) => {
    if (!inScope(code) || isSt(name) || seen.has(code)) return;
    seen.add(code);
    entries.push({ code, name, amountYuan, rank: entries.length + 1 });
  };
  for (const code of watchlist) {
    const t = topByCode.get(code);
    push(code, t?.name ?? "", t?.amountYuan ?? 0);
  }
  for (const t of top) push(t.code, t.name, t.amountYuan);
  return entries.slice(0, size);
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
      // 多取一些，留出被 ST/停牌挤掉的名额。自选先占位、榜单再补满（见 buildUniverseEntries）
      const top = await fetchTopByAmount(Math.max(config.universeSize * 2, 100));
      this.entries = buildUniverseEntries(top, config.watchlist, config.universeSize);
      this.date = date;
      this.refreshedAt = Date.now();
      this.lastError = null;

      await mkdir(join(config.dataDir, "cache"), { recursive: true });
      await Bun.write(this.path(date), JSON.stringify({ date, refreshedAt: this.refreshedAt, entries: this.entries }));
    } catch (e) {
      this.lastError = (e as Error).message;
      // 榜单拉不到时退回“最近一份落地的缓存”。旧实现读的是 this.path(date) —— 同一个刚失败
      // 的路径，注释说“退回上一日”但实际取不到任何东西，结果就是空池空转。
      if (!this.entries.length) {
        const prev = await this.loadNewestCached();
        if (prev.length) {
          this.entries = prev;
          // 把今天标成“已处理过”：否则每个心跳都去重拉一次榜单，把限流额度白耗光
          this.date = date;
        }
      }
      console.error(`[universe] ${this.lastError}`);
    }
  }

  /** 按文件名里的日期（YYYY-MM-DD，字典序即时间序）找最近一份可用缓存。 */
  private async loadNewestCached(): Promise<UniverseEntry[]> {
    const dir = join(config.dataDir, "cache");
    const files: string[] = [];
    try {
      for await (const f of new Bun.Glob("universe-*.json").scan({ cwd: dir })) files.push(f);
    } catch {
      return []; // 目录还不存在（首次运行）：Bun.Glob 抛 ENOENT 而不是给空集
    }
    files.sort();
    for (const f of files.reverse()) {
      const j = await Bun.file(join(dir, f)).json().catch(() => null);
      if (Array.isArray(j?.entries) && j.entries.length) {
        console.warn(`[universe] 今天的榜单拿不到，沿用 ${j.date ?? f} 的股票池（${j.entries.length} 支）——面板上股票池日期会跟着显示旧的`);
        this.refreshedAt = j.refreshedAt ?? 0;
        return j.entries as UniverseEntry[];
      }
    }
    return [];
  }

  codes(): string[] {
    return this.entries.map((e) => e.code);
  }

  nameOf(code: string): string {
    return this.entries.find((e) => e.code === code)?.name ?? code;
  }
}
