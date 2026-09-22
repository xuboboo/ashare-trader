import { inspectResearchDataset } from "../src/research";

const report = await inspectResearchDataset();
console.log(JSON.stringify({
  manifestPath: report.manifestPath,
  universeSnapshots: report.universeSnapshots,
  dailyFiles: report.dailyFiles,
  minuteDateDirs: report.minuteDateDirs,
  minuteFiles: report.minuteFiles,
  errors: report.errors,
}, null, 2));

if (report.errors.length) {
  console.error("研究数据链路未就绪：禁止运行旧日线回测、旧训练和参数扫描。");
  process.exit(2);
}

console.log("研究数据链路已通过结构校验；下一步才能运行分钟级回测。");
