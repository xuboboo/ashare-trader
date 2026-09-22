/**
 * 封存当前研究数据集：算出各层 sha256 + 记录 git commit，写入 research/provenance.json。
 *
 * 由 fetch-research / research-accumulate / 采集器收盘时自动调用；也可手动跑：
 *   bun scripts/research-seal.ts
 * 之后任何一次数据被事后改动，research-readiness 的 verify 都会报 drift 而拒绝放行。
 */
import { join } from "node:path";
import { config } from "../src/config";
import { researchRoot, type ResearchManifest } from "../src/research";
import { computeResearchSeal, writeResearchSeal, type SealDirs } from "../src/research-integrity";

export function sealDirsFromManifest(manifest: ResearchManifest, root: string): SealDirs {
  return {
    researchRoot: root,
    universeDir: join(root, manifest.universe.path),
    dailyDir: join(root, manifest.daily.path),
    minutesDir: join(root, manifest.minutes.path),
  };
}

async function headCommit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", config.dataDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

const root = researchRoot(config.dataDir);
const manifestPath = join(root, "manifest.json");
if (!(await Bun.file(manifestPath).exists())) {
  console.error("[seal] 没有 manifest.json —— 先运行 fetch-research.ts。");
  process.exit(2);
}
const manifest = (await Bun.file(manifestPath).json()) as ResearchManifest;
const dirs = sealDirsFromManifest(manifest, root);
const seal = await computeResearchSeal(dirs, await headCommit());
const path = await writeResearchSeal(dirs, seal);
console.log(`[seal] 已封存 -> ${path}`);
console.log(`[seal] counts universe=${seal.counts.universe} daily=${seal.counts.daily} minuteFiles=${seal.counts.minuteFiles} git=${seal.gitCommit ?? "n/a"}`);
