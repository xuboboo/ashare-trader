/**
 * 研究数据集完整性封存：内容寻址的 sha256 指纹 + 防篡改校验。
 *
 * 为什么存在（与"绝不伪造补齐"这条边界直接绑定）：
 *   分钟 bid/ask、14:45 股票池这类数据只能实时采集，历史上不存在的就是不存在。
 *   代码层面我们已经禁止采集器用收盘价/估值补造；但"事后有人手改了一个分钟文件、
 *   塞进假盘口"这类注入，光靠写入端管不住。封存 = 对每一层数据算稳定 sha256 并落到
 *   provenance.json（入库当防篡改锚点）；验收闸门每次重算比对，漂移即拒绝。
 *   于是"补造"要么当场被哈希对不上抓包，要么得连 provenance.json 一起改 —— 而那会在
 *   git 里留下痕迹。把不可见的诚信问题，变成可检测的证据链。
 *
 * 本模块刻意只依赖 node:crypto/node:path，不 import research.ts，避免循环依赖。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

export const RESEARCH_SEAL_FILE = "provenance.json";
export const RESEARCH_SEAL_VERSION = 1;

export interface ResearchSeal {
  algorithm: "sha256";
  version: number;
  generatedAt: number;
  /** 封存时的工作区 commit；null 表示不在 git 环境或取不到（不致命） */
  gitCommit: string | null;
  counts: { universe: number; daily: number; minuteFiles: number };
  /** 每层一个聚合摘要：对"相对路径 + 单文件 sha256"排序后再哈希，目录增删改都能反映 */
  hashes: { universe: string; daily: string; minutes: string };
}

export interface SealDirs {
  researchRoot: string;
  universeDir: string;
  dailyDir: string;
  minutesDir: string;
}

async function hashComponentDir(root: string, glob: string): Promise<{ digest: string; count: number }> {
  const files: string[] = [];
  try {
    for await (const f of new Bun.Glob(glob).scan({ cwd: root, onlyFiles: true })) files.push(f);
  } catch {
    return { digest: emptyDigest(), count: 0 }; // 目录不存在：当成空集，仍给确定值
  }
  files.sort();
  const combiner = createHash("sha256");
  for (const rel of files) {
    const buf = await Bun.file(join(root, rel)).arrayBuffer();
    const fileHash = createHash("sha256").update(new Uint8Array(buf)).digest("hex");
    // 路径归一成正斜杠，避免 Windows/Unix 分隔符差异导致同一份数据算出不同摘要
    combiner.update(`${rel.split(/[\\/]+/).join("/")}\u0000${fileHash}\n`);
  }
  return { digest: combiner.digest("hex"), count: files.length };
}

/** 空目录的稳定摘要（无文件时也确定，便于区分"空"与"未封存"）。 */
function emptyDigest(): string {
  return createHash("sha256").update("").digest("hex");
}

export async function computeResearchSeal(dirs: SealDirs, gitCommit: string | null): Promise<ResearchSeal> {
  const universe = await hashComponentDir(dirs.universeDir, "*.json");
  const daily = await hashComponentDir(dirs.dailyDir, "*.json");
  const minutes = await hashComponentDir(dirs.minutesDir, "*/*.json");
  return {
    algorithm: "sha256",
    version: RESEARCH_SEAL_VERSION,
    generatedAt: Date.now(),
    gitCommit,
    counts: { universe: universe.count, daily: daily.count, minuteFiles: minutes.count },
    hashes: { universe: universe.digest, daily: daily.digest, minutes: minutes.digest },
  };
}

export async function writeResearchSeal(dirs: SealDirs, seal: ResearchSeal): Promise<string> {
  const path = join(dirs.researchRoot, RESEARCH_SEAL_FILE);
  await Bun.write(path, JSON.stringify(seal, null, 2));
  return path;
}

export interface SealVerification {
  status: "missing" | "ok" | "drift";
  /** 漂移项：universe / daily / minutes 中哪些层与封存不符 */
  drift: string[];
  seal: ResearchSeal | null;
  message: string;
}

/** 重算当前数据指纹并与已落地的 provenance.json 比对。缺封存、任一摘要不符都算不可信。 */
export async function verifyResearchSeal(dirs: SealDirs): Promise<SealVerification> {
  const path = join(dirs.researchRoot, RESEARCH_SEAL_FILE);
  let seal: ResearchSeal;
  try {
    seal = (await Bun.file(path).json()) as ResearchSeal;
  } catch {
    return { status: "missing", drift: [], seal: null, message: "未封存：缺 provenance.json，无法证明数据未被事后补造/篡改" };
  }
  const now = await computeResearchSeal(dirs, seal.gitCommit ?? null);
  const drift: string[] = [];
  if (now.hashes.universe !== seal.hashes.universe) drift.push("universe");
  if (now.hashes.daily !== seal.hashes.daily) drift.push("daily");
  if (now.hashes.minutes !== seal.hashes.minutes) drift.push("minutes");
  if (drift.length) {
    return { status: "drift", drift, seal, message: `封存后数据被改动：${drift.join("、")} 层与 provenance.json 不符（疑似事后注入/补造）` };
  }
  return { status: "ok", drift: [], seal, message: `封存校验通过（${new Date(seal.generatedAt).toISOString()}）` };
}
