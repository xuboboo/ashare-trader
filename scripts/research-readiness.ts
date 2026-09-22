import { join } from "node:path";
import { config } from "../src/config";
import { inspectResearchDataset, researchRoot } from "../src/research";
import { verifyResearchSeal } from "../src/research-integrity";

const report = await inspectResearchDataset();

// 完整性校验：provenance.json 缺失或与当前数据漂移 => 数据不可信（可能事后补造/篡改）
const integrity = report.manifest
  ? await verifyResearchSeal({
      researchRoot: researchRoot(config.dataDir),
      universeDir: join(researchRoot(config.dataDir), report.manifest.universe.path),
      dailyDir: join(researchRoot(config.dataDir), report.manifest.daily.path),
      minutesDir: join(researchRoot(config.dataDir), report.manifest.minutes.path),
    })
  : { status: "missing", drift: [], seal: null, message: "无 manifest，无从校验封存" };

const errors = [...report.errors];
if (integrity.status !== "ok") errors.push(`[integrity:${integrity.status}] ${integrity.message}`);

console.log(
  JSON.stringify(
    {
      manifestPath: report.manifestPath,
      universeSnapshots: report.universeSnapshots,
      invalidUniverseSnapshots: report.invalidUniverseSnapshots,
      dailyFiles: report.dailyFiles,
      minuteDateDirs: report.minuteDateDirs,
      minuteFiles: report.minuteFiles,
      integrity: { status: integrity.status, drift: integrity.drift, sealedAt: integrity.seal?.generatedAt ?? null },
      errors,
    },
    null,
    2,
  ),
);

if (errors.length) {
  console.error("研究数据链路未就绪：缺数据或未封存/漂移时，禁止回测（绝不用收盘价/估值补造缺失盘口）。");
  process.exit(2);
}

console.log("研究数据链路已通过结构校验 + sha256 封存校验；可运行分钟级回测。");
