/**
 * 下载日线到 data/daily/<code>.json，回测的唯一数据源。
 * 用法：
 *   bun run scripts/fetch-daily.ts                 # 当前股票池全部
 *   bun run scripts/fetch-daily.ts --sample=30     # 只拉前 30 支（快速试跑）
 *   bun run scripts/fetch-daily.ts --codes=600000,000001
 *   bun run scripts/fetch-daily.ts --days=750 --force
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { fetchDaily, type DailyBar } from "../src/quotes";
import { Universe } from "../src/universe";
import { clockNow } from "../src/engine";

interface Args {
  sample: number;
  codes: string[];
  days: number;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return {
    sample: Number(get("sample") ?? 0) || 0,
    codes: (get("codes") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    days: Number(get("days") ?? 750) || 750,
    force: argv.includes("--force"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const universe = new Universe();
  let codes = args.codes;
  if (!codes.length) {
    await universe.get(clockNow().date);
    codes = universe.codes();
    if (args.sample) codes = codes.slice(0, args.sample);
  }
  const dir = join(config.dataDir, "daily");
  await mkdir(dir, { recursive: true });

  const t0 = Date.now();
  let done = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const [i, code] of codes.entries()) {
    const file = Bun.file(join(dir, `${code}.json`));
    if (!args.force && (await file.exists())) {
      const cached = await file.json().catch(() => null);
      const bars: DailyBar[] = cached?.bars ?? [];
      if (bars.length >= Math.min(args.days, 200)) {
        skipped++;
        continue;
      }
    }
    try {
      const bars = await fetchDaily(code, args.days);
      if (bars.length < 60) {
        failed.push(`${code}(${bars.length}根，可能上市太短)`);
        continue;
      }
      await Bun.write(
        join(dir, `${code}.json`),
        JSON.stringify({ code, fetchedAt: Date.now(), amountEst: !!bars[0]?.amountEst, bars }),
      );
      done++;
    } catch (e) {
      failed.push(`${code}: ${(e as Error).message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${codes.length} 完成 ${done} 跳过 ${skipped} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`日线下载完成：新增 ${done}，跳过 ${skipped}，失败 ${failed.length}，共 ${codes.length} 支，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed.length) console.log(`失败样本：${failed.slice(0, 10).join("; ")}`);
}

await main();
