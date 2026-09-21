/**
 * 跑一轮就退出，用来看链路是否通（不启动 HTTP 服务）。
 * 用法：bun run scripts/once.ts
 *
 * 这一轮会真写账本（建单 + 影子成交 + pending.json + positions.json），所以必须先拿到
 * 单实例锁；服务在跑时不再双写同一份 data/，而是改口请求它自己跑一轮（POST /scan）。
 */
import { config } from "../src/config";
import { join } from "node:path";
import { gateLabel } from "../src/factors";
import { Engine, clockNow } from "../src/engine";
import { acquireEngineLock, releaseEngineLock } from "../src/lock";
import { sessionNow } from "../src/session";

const lines: string[] = [];
const p = (...a: unknown[]) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 1))).join(" ");
  lines.push(s);
  console.log(s);
};

try {
  await acquireEngineLock("scripts/once.ts");
} catch (e) {
  console.log(`[once] 拿不到账本锁：${(e as Error).message}`);
  console.log(`[once] 改为请求在跑的服务立即跑一轮：POST /scan`);
  const r = await fetch(`http://localhost:${config.port}/scan`, { method: "POST", signal: AbortSignal.timeout(60_000) }).catch(
    () => null,
  );
  if (!r?.ok) {
    console.error(
      `[once] 服务也没在跑，但锁显示有人持有 —— 确认没有第二个引擎后删掉 ${config.dataDir}/.engine.lock 再试`,
    );
    process.exit(1);
  }
  p(`服务轮次结果：`, await r.json());
  await Bun.write(join(config.dataDir, "once.txt"), lines.join("\n"));
  process.exit(0);
}

const engine = new Engine();
await engine.init();
const now = clockNow();
const s = sessionNow(new Date(), engine.calendar.isTradingDay(now.date));
p(
  `init: 日历${engine.calendar.stale ? "stale" : `ok(${engine.calendar.size}天)`} 股票池 ${engine.universe.entries.length} ` +
    `(刷新 ${engine.universe.date}) 时段 ${s.phase}`,
);
p(`池内前 5: ${engine.universe.entries.slice(0, 5).map((e) => `${e.name}/${e.code}`).join(", ")}`);

const t0 = performance.now();
const e = await engine.round("force-scan");
p(
  `round ${Math.round(performance.now() - t0)}ms: seq=${e.seq} phase=${e.phase} 指数=${e.index.price}(${e.index.pct}%, ${e.index.amountYi.toFixed(0)}亿) ` +
    `MA5=${e.index.ma5} 快照=${e.quotes.ok} 打分=${e.scan.scored} 否决=${e.scan.rejected} 出单=${e.orders.length} 成交=${e.fills.length} 持仓=${e.positions.length}`,
);
p(`闸门: ${gateLabel(e.gate)}(allowed=${e.gate.allowed}, status=${e.gate.status}) ${e.gate.reasons.join(" / ")}`);
if (e.gate.skipped?.length) p(`  本轮未评估的否决项: ${e.gate.skipped.join("、")}`);
p(`note: ${e.note}`);
p("top:", e.scan.top.slice(0, 5));
p("orders:", e.orders);
p("totals:", e.totals);
// 落盘：这一轮可能改了持仓，不落盘就等于把快照留在旧值上（面板与账本两张皮的来源之一）
await engine.persist();
await Bun.write(join(config.dataDir, "once.txt"), lines.join("\n"));
engine.stop();
await releaseEngineLock();
