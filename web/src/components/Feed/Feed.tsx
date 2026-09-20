"use client";

import { fmtPrice } from "@/lib/format";
import type { TickEvent } from "@/lib/types";

/** 心跳流：一轮一行，最新在上。 */
export default function Feed({ events }: { events: TickEvent[] }) {
  const rows = events.slice(-80).reverse();
  return (
    <section className="section">
      <div className="head">
        <h2>心跳流</h2>
        <span className="hint">每行 = 一轮：指数 · 触发点 · 闸门 · 快照 · 出单 · 成交</span>
      </div>
      <div className="feed">
        {rows.length === 0 ? <div className="muted small" style={{ padding: "10px 0" }}>还没收到心跳</div> : null}
        {rows.map((e) => (
          <div className="row" key={e.seq}>
            <span className="rowTime">
              {e.time} #{e.seq}
            </span>
            <span className="rowMain">
              {fmtPrice(e.index.price)} · {e.trigger} · 闸门{e.gate.allowed ? "开" : "关"} · 快照{e.quotes.ok}/{e.universe} · 出单
              {e.orders.length} · 成交{e.fills.length}
            </span>
            <span className="muted tiny nowrap">{e.note}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
