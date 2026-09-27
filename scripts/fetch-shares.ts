/**
 * 采集总股本缓存（data/cache/shares.json），让日线回测/训练能真正执行 MIN_MCAP_YI。
 *
 * 用法：bun run scripts/fetch-shares.ts
 *
 * 只打腾讯 L1 批量快照（股票池一次约 5~10 个请求），不下单、不落账本。
 * 依赖 src/shares.ts 说明书里的口径：总股本 = 总市值 / 现价。
 * 股票池来源：优先东财成交额榜单；榜单拉不到（限流/断连）就退回最近一份
 * data/cache/universe-*.json，不让一次接口抖动把整个缓存更新打断。
 */
import { join } from "node:path";
import { config } from "../src/config";
import { fetchSnapshots, fetchTopByAmount } from "../src/quotes";
import { saveSharesCache, sharesYiFrom } from "../src/shares";
import { inScope, isSt } from "../src/symbols";

/** 榜单拉不到时的兜底：读最近一份股票池缓存（Universe 落盘的格式）。 */
async function codesFromCache(): Promise<string[]> {
  const dir = join(config.dataDir, "cache");
  const files: string[] = [];
  try {
    for await (const f of new Bun.Glob("universe-*.json").scan({ cwd: dir })) files.push(f);
  } catch {
    return [];
  }
  files.sort();
  for (const f of files.reverse()) {
    const j = await Bun.file(join(dir, f)).json().catch(() => null);
    if (Array.isArray(j?.entries) && j.entries.length) return j.entries.map((e: { code: string }) => e.code);
  }
  return [];
}

async function universeCodes(): Promise<string[]> {
  try {
    const top = await fetchTopByAmount(Math.max(config.universeSize * 2, 100));
    return top.filter((t) => inScope(t.code) && !isSt(t.name)).map((t) => t.code);
  } catch (e) {
    console.warn(`榜单拉不到（${(e as Error).message.slice(0, 80)}），改用最近一份股票池缓存`);
    return (await codesFromCache()).filter(inScope);
  }
}

async function main() {
  const codes = await universeCodes();
  if (!codes.length) {
    console.error("没有可用的股票池（榜单失败且没有 universe 缓存），先跑 bun run start 或 scripts/fetch-daily 生成缓存");
    process.exitCode = 1;
    return;
  }
  const snaps = await fetchSnapshots(codes);
  const entries: Record<string, number> = {};
  for (const [code, s] of snaps) {
    const shares = sharesYiFrom(s.mcapYi, s.price);
    if (shares) entries[code] = Math.round(shares * 1e4) / 1e4; // 0.0001 亿股精度
  }
  const asOf = new Date().toISOString();
  await saveSharesCache({ asOf, source: "tencent-l1:总市值/现价", entries });
  console.log(`总股本缓存：${Object.keys(entries).length}/${codes.length} 支 -> data/cache/shares.json（asOf ${asOf}）`);
  const missing = codes.filter((c) => !(c in entries));
  if (missing.length) console.log(`没拿到市值的：${missing.slice(0, 10).join(",")}${missing.length > 10 ? " ..." : ""}`);
}

if (import.meta.main) await main();
