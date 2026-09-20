"use client";

import { useEffect, useState } from "react";
import { fmtCny, fmtInt, fmtPct, fmtPrice, fmtSignedPct, uptime } from "@/lib/format";
import type { Meta, TickEvent } from "@/lib/types";

const DASH = "-";

function ageLabel(latest: TickEvent | null): string {
  if (!latest) return DASH;
  const live = latest.tradingDay && (latest.phase === "continuous" || latest.phase === "call-auction" || latest.phase === "close-auction");
  if (!live) return latest.quotes.quoteDay ? `收盘 ${latest.quotes.quoteDay.slice(4, 6)}/${latest.quotes.quoteDay.slice(6, 8)}` : "非盘中";
  if (latest.quotes.ageSec < 0) return "未知";
  return latest.quotes.ageSec >= 60 ? `${Math.round(latest.quotes.ageSec / 60)}分钟` : `${latest.quotes.ageSec}s`;
}

export default function StatsRow({
  latest,
  avgLatencyMs,
  meta,
}: {
  latest: TickEvent | null;
  avgLatencyMs: number;
  meta: Meta | null;
}) {
  const [up, setUp] = useState<string | null>(null);
  const startedAt = meta?.startedAt ?? null;
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setUp(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const t = latest?.totals ?? null;
  const idx = latest?.index ?? null;
  const pnl = t?.pnlCny ?? 0;
  const cls = pnl > 0 ? "up" : pnl < 0 ? "down" : "muted";

  return (
    <div className="stats">
      <span className="stat">
        上证指数<b className={idx && idx.pct >= 0 ? "up" : "down"}>{idx ? fmtPrice(idx.price) : DASH}</b>
        <span className={idx && idx.pct >= 0 ? "up" : "down"}>{idx ? ` ${fmtSignedPct(idx.pct)}` : ""}</span>
      </span>
      <span className="stat">
        成交额<b>{idx ? `${fmtInt(idx.amountYi)}亿` : DASH}</b>
      </span>
      <span className="stat">
        权益<b>{t ? fmtCny(t.equity) : DASH}</b>
      </span>
      <span className="stat">
        盈亏<b className={cls}>{t ? `${fmtCny(pnl)} (${fmtPct(t.pnlPct * 100, 2)})` : DASH}</b>
      </span>
      <span className="stat">
        持仓<b>{t ? fmtInt(t.positions) : DASH}</b>
      </span>
      <span className="stat">
        成交<b>{t ? fmtInt(t.fills) : DASH}</b>
      </span>
      <span className="stat">
        快照<b>{latest ? `${fmtInt(latest.quotes.ok)}/${fmtInt(latest.universe)}` : DASH}</b>
      </span>
      {/* 行情新鲜度：L1 本身 3s 一个切片，盘中最关键；收盘后拿这个数没意义，改显快照日期 */}
      <span className="stat">
        行情延迟
        <b className={latest?.quotes.stale ? "up" : undefined}>{ageLabel(latest)}</b>
      </span>
      <span className="spacer" />
      <span>本轮 {Number.isFinite(avgLatencyMs) && avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : DASH}</span>
      <span>运行 {up ?? "00:00:00"}</span>
    </div>
  );
}
