import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertResearchReady, researchRoot, type ResearchSplitName } from "../src/research";
import { fileResearchLoader, runResearchBacktest, type ResearchRunSplit } from "../src/research-runner";
import { config } from "../src/config";

const rawSplit = process.argv.find((arg) => arg.startsWith("--split="))?.slice("--split=".length) ?? "all";
const allowed = new Set<ResearchRunSplit>(["all", "train", "validation", "test"]);
if (!allowed.has(rawSplit as ResearchRunSplit)) {
  console.error("--split 必须是 all/train/validation/test");
  process.exit(2);
}
if (process.argv.some((arg) => arg === "--sweep" || arg.startsWith("--from=") || arg.startsWith("--to="))) {
  console.error("研究 runner 禁止 sweep 或自定义日期窗口；参数必须先在 train/validation 决定，再锁定后评估 test。");
  process.exit(2);
}

try {
  const manifest = await assertResearchReady();
  const report = await runResearchBacktest(manifest, fileResearchLoader(manifest), {
    split: rawSplit as ResearchRunSplit,
  });
  const output = join(researchRoot(config.dataDir), "backtest-report.json");
  await mkdir(researchRoot(config.dataDir), { recursive: true });
  await Bun.write(output, JSON.stringify(report, null, 2));
  const compact = Object.fromEntries(
    (Object.keys(report.splits) as ResearchSplitName[]).map((name) => {
      const s = report.splits[name];
      return [name, {
        entryDays: s.entryDays,
        candidates: s.candidates,
        selected: s.selected,
        trades: s.trades,
        censored: s.censored,
        boundaryExcluded: s.boundaryExcluded,
        grossBps: s.grossBps,
        netBps: s.netBps,
        winRate: s.winRate,
      }];
    }),
  );
  console.log(JSON.stringify({ dataset: report.dataset, output, splits: compact }, null, 2));
} catch (e) {
  console.error(String((e as Error).message));
  process.exit(2);
}
