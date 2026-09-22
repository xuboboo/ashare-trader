/**
 * 研究数据引导：把"能免费回溯的部分"一次性灌进 data/research/，按 v2 协议落地。
 *
 * 覆盖范围（全部 0 成本、无需券商账户）：
 *   - raw 日线（不复权，东财 fqt=0）        -> research/daily/<code>.json
 *   - manifest.json（train/validation/test 切分）
 *   - 数据完整性封存                          -> research/provenance.json（各层 sha256）
 *
 * 关键边界（与"绝不伪造补齐"一致）：
 *   - 不写 research/universe/：14:45 股票池只能由采集器在真实现场抓到 14:45 截面才存在。
 *     用全天收盘成交额"重建"出一个 14:45 池 = 拿收盘后才知道的信息冒充决策时点可见截面，
 *     和用收盘价补 bid/ask 是同一类作佯。所以历史缺失就是缺失，不补。
 *   - 不回填分钟盘口（同理）。readiness 会如实报"无池/无分钟文件"，这是正确状态。
 *   - 不动旧 data/daily（那是前复权，只服务实盘因子，不是研究输入）。
 *
 * 用法：
 *   bun scripts/fetch-research.ts            # 用当前股票池（榜单 top-N）
 *   bun scripts/fetch-research.ts --days=800 # 每票回溯多少根 raw 日线
 *   bun scripts/fetch-research.ts --codes="600000,000001"   # PowerShell 逗号要加引号
 *   bun scripts/fetch-research.ts --re-seal-only # 不联网，仅用已有日线重算 splits + manifest + 封存
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { bj } from "../src/session";
import { fetchRawDaily, type DailyBar } from "../src/quotes";
import { Universe } from "../src/universe";
import { writeFileAtomic } from "../src/state";
import {
  RESEARCH_SCHEMA_VERSION,
  researchRoot,
  collectResearchDates,
  type ResearchManifest,
} from "../src/research";
import { computeResearchSeal, writeResearchSeal, type SealDirs } from "../src/research-integrity";

const argNum = (name: string, fallback: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const argList = (name: string): string[] => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const days = argNum("days", 800);
const root = researchRoot(config.dataDir);
const universeDir = join(root, "universe");
const dailyDir = join(root, "daily");
const minuteDir = join(root, "minutes");

function assertAscending(code: string, bars: DailyBar[]): void {
  let prev = "";
  for (const b of bars) {
    if (!b.date || b.date <= prev) throw new Error(`${code} 日线日期非严格递增（${prev} -> ${b.date}）`);
    if (!(b.open > 0) || !(b.high > 0) || !(b.low > 0) || !(b.close > 0)) throw new Error(`${code} ${b.date} 含非正 OHLC`);
    if (!Number.isFinite(b.amountYuan) || b.amountEst === true) throw new Error(`${code} ${b.date} 成交额缺失/为估值，非 raw`);
    prev = b.date;
  }
}

/** 当前工作区 commit（取不到不致命，置 null）；封存在哪次代码上，事后可溯源。 */
async function headCommit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", config.dataDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** 按观察到的交易日把 train/validation/test 切成 60/20/20，边界留 1 个交易日的右删失缺口。 */
function buildSplits(dates: string[]): ResearchManifest["splits"] {
  const n = dates.length;
  const at = (idx: number): string => dates[Math.max(0, Math.min(n - 1, idx))] ?? dates[0]!;
  const gap = n > 6 ? 1 : 0;
  const trainToIdx = Math.floor(n * 0.6);
  const valToIdx = Math.floor(n * 0.8);
  return {
    train: { from: at(0), to: at(trainToIdx) },
    validation: { from: at(trainToIdx + gap), to: at(valToIdx) },
    test: { from: at(valToIdx + gap), to: at(n - 1) },
  };
}

async function main() {
  const today = bj().ymd;
  await mkdir(universeDir, { recursive: true });
  await mkdir(dailyDir, { recursive: true });
  await mkdir(minuteDir, { recursive: true });

  const dailyByCode = new Map<string, DailyBar[]>();
  let wrote = 0;
  const failed: string[] = [];

  if (hasFlag("re-seal-only") || hasFlag("reconstruct-only")) {
    // 不联网：从已落地的 raw 日线重算 splits / manifest / 封存
    const files: string[] = [];
    for await (const f of new Bun.Glob("*.json").scan({ cwd: dailyDir })) files.push(f);
    for (const f of files.sort()) {
      const code = f.replace(/\.json$/, "");
      try {
        const bars = (await Bun.file(join(dailyDir, f)).json()) as DailyBar[];
        assertAscending(code, bars);
        dailyByCode.set(code, bars);
        wrote++;
      } catch (e) {
        failed.push(`${code}: ${(e as Error).message}`);
      }
    }
    console.log(`[research] 离线：从 ${wrote} 份已落地的 raw 日线重算切分与封存`);
  } else {
    // 股票池：优先手动 --codes，否则用引擎同款榜单 top-N（只为确定要拉哪些票的 raw 日线）
    let codes = argList("codes");
    if (!codes.length) {
      const uni = new Universe();
      await uni.get(today);
      codes = uni.codes();
    }
    if (!codes.length) throw new Error("股票池为空，无法引导研究数据");
    console.log(`[research] 目标 ${codes.length} 支，回溯 ${days} 根 raw 日线`);

    for (const code of codes) {
      let bars: DailyBar[];
      try {
        bars = await fetchRawDaily(code, days);
        assertAscending(code, bars);
      } catch (e) {
        failed.push(`${code}: ${(e as Error).message}`);
        continue;
      }
      await writeFileAtomic(join(dailyDir, `${code}.json`), JSON.stringify(bars));
      dailyByCode.set(code, bars);
      wrote++;
    }
  }

  if (dailyByCode.size === 0) throw new Error("没有任何 raw 日线可用，检查 --codes / 数据源，或先跑一次非 --re-seal-only");

  // 仅用于切分边界；14:45 股票池不在此生成（只能由采集器实时抓）
  const sortedDates = collectResearchDates(dailyByCode);
  if (sortedDates.length < 5) throw new Error(`可用交易日太少（${sortedDates.length}），先扩大 --days 或检查数据源`);

  const manifest: ResearchManifest = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    dataset: `ashare-daily-${today}`,
    timezone: "Asia/Shanghai",
    priceBasis: "raw",
    // universe 声明为实时 14:45 采集口径；bootstrap 不写池，待采集器逐日补真 14:45 快照。
    universe: { path: "universe", format: "date-json", pointInTime: true, asOfTime: "14:45", source: "record-research-minutes/tencent-l1/top-amount-at-14:45" },
    daily: { path: "daily", format: "code-json", pointInTime: true, source: "eastmoney-push2his/fqt=0" },
    minutes: { path: "minutes", format: "date-code-json", intervalMinutes: 1, source: "self-recorded/tencent-l1" },
    execution: { entryTime: "14:45", entryPrice: "ask", exitPrice: "bid", maxBarAgeSeconds: 60, decisionIntervalMinutes: 1 },
    labels: { policy: "jev-autonomous", censoring: "right" },
    splits: buildSplits(sortedDates),
  };
  await writeFileAtomic(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 封存：对当前各层算 sha256 落 provenance.json（事后注入/改写会被 readiness 判为漂移）
  const dirs: SealDirs = { researchRoot: root, universeDir, dailyDir, minutesDir: minuteDir };
  const seal = await computeResearchSeal(dirs, await headCommit());
  await writeResearchSeal(dirs, seal);

  console.log(`[research] raw 日线写入 ${wrote} 支；已封存 sha256（daily=${seal.counts.daily}）`);
  console.log(`[research] 观测交易日 ${sortedDates[0]} .. ${sortedDates.at(-1)}（${sortedDates.length} 天）`);
  console.log(`[research] splits: train ${manifest.splits.train.from}~${manifest.splits.train.to} | ` +
    `val ${manifest.splits.validation.from}~${manifest.splits.validation.to} | ` +
    `test ${manifest.splits.test.from}~${manifest.splits.test.to}`);
  if (failed.length) console.log(`[research] 失败样本：${failed.slice(0, 10).join("; ")}`);
  console.log(`[research] 完成。14:45 股票池与分钟盘口只能由 record-research-minutes.ts 逐日实时采集，历史不补。`);
}

await main().catch((e) => {
  console.error(`[research] 引导失败：${(e as Error).message}`);
  process.exit(2);
});
