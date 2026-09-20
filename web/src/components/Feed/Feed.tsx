"use client";

import { fmtPrice } from "@/lib/format";
import type { TickEvent } from "@/lib/types";

/** 心跳流：每一轮做了什么，一眼能回溯。最新的在上面。 */
export default function Feed({ events }: { events: TickEvent[] }) {
  const rows = events.slice(-60).reverse();
  return (
    <section className="panel">
      <div className="panelHead">心跳流</div>
      <div className="feed">
        {rows.map((e) => (
          <div key={e.seq} className="row">
            <span className="rowTime">
              {e.time} #{e.seq}
            </span>
            <span className="rowMain">
              上证 {fmtPrice(e.index.price)} · {e.trigger} · 闸门{e.gate.allowed ? "开" : "关"} · 快照
              {e.quotes.ok}/{e.universe} · 出单{e.orders.length} · 成交{e.fills.length}
            </span>
            <span className={`badge ${e.note?.includes("降级") || e.note?.includes("失败") ? "badgeWarn" : ""}`}>
              {e.positions.length} 持仓
            </span>
          </div>
        ))}
        {rows.length === 0 ? <div className="muted small">还没收到心跳</div> : null}
      </div>
    </section>
  );
}
