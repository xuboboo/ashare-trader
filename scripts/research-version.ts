/**
 * 为已通过 readiness 的研究集生成可复核版本清单。
 * 大文件仍留在本机/对象存储，不塞进代码仓库；清单记录每个文件的大小和 SHA-256。
 */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { mkdir } from "node:fs/promises";
import { config } from "../src/config";
import { assertResearchReady, researchRoot } from "../src/research";
import { writeFileAtomic } from "../src/state";

const root = researchRoot(config.dataDir);
const manifestPath = join(root, "manifest.json");
const outputPath = join(root, "checksums.json");

await assertResearchReady(config.dataDir);

const files: { path: string; bytes: number; sha256: string }[] = [];
for await (const file of new Bun.Glob("**/*.json").scan({ cwd: root, onlyFiles: true })) {
  if (file === "checksums.json" || file === "backtest-report.json" || file === "daily-baseline-report.json") continue;
  const absolute = join(root, file);
  const bytes = Buffer.from(await Bun.file(absolute).arrayBuffer());
  files.push({
    path: file.replaceAll("\\", "/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
files.sort((a, b) => a.path.localeCompare(b.path));

const aggregate = createHash("sha256");
for (const file of files) aggregate.update(`${file.path}\0${file.sha256}\n`);

await mkdir(root, { recursive: true });
await writeFileAtomic(outputPath, JSON.stringify({
  dataset: (await Bun.file(manifestPath).json()).dataset,
  createdAt: new Date().toISOString(),
  algorithm: "sha256",
  aggregateSha256: aggregate.digest("hex"),
  files,
}, null, 2));

console.log(`[research] versioned ${files.length} files`);
console.log(`[research] aggregateSha256=${JSON.parse(await Bun.file(outputPath).text()).aggregateSha256}`);
console.log(`[research] manifest=${relative(process.cwd(), manifestPath)}`);
console.log(`[research] checksums=${relative(process.cwd(), outputPath)}`);
