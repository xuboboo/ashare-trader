import { config } from "./config";
import { clockNow, Engine } from "./engine";
import { sessionNow } from "./session";
import { startServer } from "./server";

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
