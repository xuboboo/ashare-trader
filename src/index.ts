import { config } from "./config";
import { clockNow, Engine } from "./engine";
import { acquireEngineLock, releaseEngineLock } from "./lock";
import { sessionNow } from "./session";
import { startServer } from "./server";

// 单实例锁：两个引擎共写同一份账本会互相覆盖（真实发生过）。
// 同一个锁模块也被 scripts/once.ts 与 fill.ts 的离线路径使用。
try {
  await acquireEngineLock("bun run start");
} catch (e) {
  console.error(`!! ${(e as Error).message}`);
  process.exit(1);
}

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

// 定期落盘，Ctrl+C 或崩溃前不至于丢账。
// 写失败必须可见：以前这里用 void 把 rejection 吞了，Windows 上文件被占用的 EPERM
// 会表现为“服务一直在跑，但 positions.json 静静停在旧值”（就是这次审计现场看到的症状）。
const persistTimer = setInterval(() => {
  void engine.persist().catch((e) => console.error(`[book] 落盘失败（账本仍在内存，下轮重试）: ${(e as Error).message}`));
}, 60_000);
persistTimer.unref?.();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    engine.stop();
    try {
      await engine.persist();
      console.log(`\n已保存账本到 ${config.dataDir}/positions.json，退出。`);
    } catch (e) {
      console.error(`\n!! 账本落盘失败：${(e as Error).message}（trades.jsonl 仍是唯一事实，下次启动会按它重建）`);
    }
    await releaseEngineLock();
    process.exit(0);
  });
}

await engine.run();
