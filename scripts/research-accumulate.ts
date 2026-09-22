/**
 * 研究数据每日增量自攒 —— bootstrap 之后每天跑一次（或挂定时任务），系统就自己长数据。
 *
 * 做三件事，且都幂等（重复跑不会写坏）：
 *   1) 给已有代码集刷新 raw 日线：读旧 + 拉最近 + 按日期合并去重。
 *      只有 raw（不复权）价能这么干 —— 历史价不随未来除权被回填改写，合并才安全。
 *   2) 重新封存：raw 日线变了就重算 sha256 写 provenance.json（供闸门验证漂移）。
 *      不写 14:45 股票池 —— 那只能由采集器在真实现场抓到，历史不补造。
 *   3) 绝不改 manifest 的 train/validation/test 边界 —— 已锁的 test 不能被悄悄往后挪。
 *      新增日期落在 test.to 之外，runner 按 dateInRange 自然忽略，留待下次重新锁窗口。
 *
 * 用法：bun scripts/research-accumulate.ts [--lookback=120]
 *   --lookback 每次往回拉多少根（覆盖最近补数据 + 周末/停盘补齐），默认 120。
 */
import { join } from "node:path";
import { config } from "../src/config";
import { fetchRawDaily, type DailyBar } from "../src/quotes";
import { writeFileAtomic } from "../src/state";
import {
  researchRoot,
  collectResearchDates,
  type ResearchManifest,
} from "../src/research";
import { computeResearchSeal, writeResearchSeal } from "../src/research-integrity";

/** 当前工作区 commit（取不到置 null，不致命）。 */
async function headCommit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", config.dataDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

const argNum = (name: string, fallback: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const lookback = argNum("lookback", 120);

const root = researchRoot(config.dataDir);
const dailyDir = join(root, "daily");

const manifestPath = join(root, "manifest.json");
if (!(await Bun.file(manifestPath).exists())) {
  console.error("[accumulate] 没有 manifest.json —— 请先运行 fetch-research.ts 完成引导。");
  process.exit(2);
}
const manifest = (await Bun.file(manifestPath).json()) as ResearchManifest;

// 已有代码集（稳定候选池；不主动加新票，避免把"今天的赢家"再次注入历史）
const codes: string[] = [];
for await (const f of new Bun.Glob("*.json").scan({ cwd: dailyDir })) codes.push(f.replace(/\.json$/, ""));
codes.sort();
if (!codes.length) {
  console.error("[accumulate] research/daily 为空 —— 请先运行 fetch-research.ts。");
  process.exit(2);
}

function mergeBars(oldBars: DailyBar[], fresh: DailyBar[]): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const b of oldBars) if (!b.amountEst) byDate.set(b.date, b);
  for (const b of fresh) if (!b.amountEst) byDate.set(b.date, b); // 新数据覆盖同旧日（除权/复牌修正）
  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let prev = "";
  for (const b of merged) {
    if (b.date <= prev) throw new Error(`合并后日期非递增 @${b.date}`);
    prev = b.date;
  }
  return merged;
}

const dailyByCode = new Map<string, DailyBar[]>();
let updated = 0;
let grew = 0;
const failed: string[] = [];
for (const code of codes) {
  const file = join(dailyDir, `${code}.json`);
  let oldBars: DailyBar[] = [];
  try {
    oldBars = (await Bun.file(file).json()) as DailyBar[];
  } catch {
    /* 读不到就当作空，全量重写 */
  }
  try {
    const fresh = await fetchRawDaily(code, lookback);
    const merged = mergeBars(oldBars, fresh);
    if (merged.length > oldBars.length) grew++;
    await writeFileAtomic(file, JSON.stringify(merged));
    dailyByCode.set(code, merged);
    updated++;
  } catch (e) {
    failed.push(`${code}: ${(e as Error).message}`);
    if (oldBars.length) dailyByCode.set(code, oldBars); // 拉取失败仍保留旧数据参与重建
  }
}

const allDates = collectResearchDates(dailyByCode);

// 重新封存：日线刷新后各层 sha256 变了，重算写 provenance.json
const sealDirs = {
  researchRoot: root,
  universeDir: join(root, manifest.universe.path),
  dailyDir,
  minutesDir: join(root, manifest.minutes.path),
};
const seal = await computeResearchSeal(sealDirs, await headCommit());
await writeResearchSeal(sealDirs, seal);

console.log(`[accumulate] 刷新 ${updated}/${codes.length} 支（日线增长 ${grew} 支）；已重新封存 sha256`);
console.log(`[accumulate] 数据现覆盖 ${allDates[0]} .. ${allDates.at(-1)}（${allDates.length} 天）；splits 边界保持不变`);
console.log(`[accumulate] 14:45 股票池与分钟盘口只增不改，由 record-research-minutes.ts 实时采集`);
if (failed.length) console.log(`[accumulate] 失败样本（已保留旧数据）：${failed.slice(0, 10).join("; ")}`);
