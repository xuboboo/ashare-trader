import { config } from "./config";
import { clockNow, Engine } from "./engine";
import { sessionNow } from "./session";
import { startServer } from "./server";
import { join } from "node:path";

// 单实例锁：两个引擎共写同一份账本会互相覆盖（真实发生过）。
// 锁里记录持有者的 PID；持有者进程已死则自动接管。
const lockFile = join(config.dataDir, ".engine.lock");
try {
  const prev = JSON.parse(await Bun.file(lockFile).text());
  let alive = false;
  try {
    process.kill(prev.pid, 0);
    alive = true; // 还活着（EPERM 也算活着，进不了这个分支）
  } catch (e) {
    alive = (e as Error).name === "EPERM";
  }
  if (alive) {
    console.error(`!! 已有实例在运行（PID ${prev.pid}，启动于 ${new Date(prev.at).toLocaleString()}），拒绝双开。`);
    console.error("   确认旧实例已停止后再启动，否则两份引擎会互踩账本。");
    process.exit(1);
  }
  console.log(`[lock] 旧锁持有者 PID ${prev.pid} 已不存在，接管。`);
} catch {
  /* 无锁文件：首次运行 */
}
await Bun.write(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));

const engine = new Engine();
await engine.init();
startServer(engine);

const now = clockNow();
const s = sessionNow(new Date(), engine.calendar.isTradingDay(now.date));
const m = engine.meta();
console.log(
  `ashare-trader · model=${m.model} · LLM=${m.llm} · ${m.paper ? "PAPER（影子成交，不下真实委托）" : "!! 需要真实下单通道"} · ` +
    `股票池 ${m.universe} · 日历${m.calendarStale ? "退化(周一~五)" : `已加载(${engine.calendar.size}天)`} · ${s.phase} · ${s.next} · :${config.port}`,
);

// 定期落盘，Ctrl+C 或崩溃前不至于丢账
const persistTimer = setInterval(() => void engine.persist(), 60_000);
persistTimer.unref?.();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    engine.stop();
    await engine.persist();
    console.log(`\n已保存账本到 ${config.dataDir}/positions.json，退出。`);
    process.exit(0);
  });
}

await engine.run();
