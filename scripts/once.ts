/**
 * 跑一轮就退出，用来看链路是否通（不启动 HTTP 服务）。
 * 用法：bun run scripts/once.ts
 */
import { Engine, clockNow } from "../src/engine";
import { sessionNow } from "../src/session";

const engine = new Engine();
const lines: string[] = [];
const p = (...a: unknown[]) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 1))).join(" ");
  lines.push(s);
  console.log(s);
};
await engine.init();
const now = clockNow();
p(
  `init: 日历${engine.calendar.stale ? "stale" : `ok(${engine.calendar.size}天)`} 股票池 ${engine.universe.entries.length} ` +
    `(刷新 ${engine.universe.date}) 时段 ${sessionNow(new Date(), engine.calendar.isTradingDay(now.date)).phase}`,
);
p(`池内前 5: ${engine.universe.entries.slice(0, 5).map((e) => `${e.name}/${e.code}`).join(", ")}`);

const t0 = performance.now();
const e = await engine.round("force-scan");
p(
  `round ${Math.round(performance.now() - t0)}ms: seq=${e.seq} phase=${e.phase} 指数=${e.index.price}(${e.index.pct}%, ${e.index.amountYi.toFixed(0)}亿) ` +
    `MA5=${e.index.ma5} 快照=${e.quotes.ok} 打分=${e.scan.scored} 否决=${e.scan.rejected} 出单=${e.orders.length} 持仓=${e.positions.length}`,
);
p(`闸门: allowed=${e.gate.allowed} ${e.gate.reasons.join(" / ")}`);
p(`note: ${e.note}`);
p("top:", e.scan.top.slice(0, 5));
p("orders:", e.orders);
p("totals:", e.totals);
await Bun.write("data/once.txt", lines.join("\n"));
engine.stop();
