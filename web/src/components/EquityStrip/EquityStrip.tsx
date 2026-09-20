"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtCny, fmtPct } from "@/lib/format";
import { useApi } from "@/lib/useFeed";
import type { EquityPoint, Totals } from "@/lib/types";

/**
 * 一周盈亏视图：/equity 的权益曲线（每交易日一个点，后端每 60s 落盘一次）。
 * 曲线只画最近 7 个交易日；当前权益与总盈亏直接读最新一轮的 totals（SSE 实时）。
 */
export default function EquityStrip({ totals }: { totals: Totals | null }) {
  const api = useApi();
  // useApi 每次渲染给新的函数身份；轮询的 loader 必须稳定，否则 effect 会反复重建
  const eqRef = useRef(api.equity);
  eqRef.current = api.equity;
  const [points, setPoints] = useState<EquityPoint[]>([]);

  const load = useCallback(() => {
    eqRef.current().then((r) => r && setPoints(r.points)).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const week = points.slice(-7);
  const base = totals?.initialCash ?? week[0]?.equity ?? 0;
  const pnl = totals?.pnlCny ?? 0;
  const cls = pnl > 0 ? "up" : pnl < 0 ? "down" : "muted";

  // 每天的柱高：权益在最近 7 日里的相对位置（4..36）
  const vals = week.map((p) => p.equity);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const span = hi - lo || 1;
  const bar = (v: number) => 4 + ((v - lo) / span) * 32;

  const signed = (x: number | undefined) =>
    x === undefined ? "-" : `${(x ?? 0) >= 0 ? "+" : ""}${fmtCny(x)}`;
  const pnlCls = (x: number | undefined) =>
    x === undefined ? "muted" : x > 0 ? "up" : x < 0 ? "down" : "muted";

  return (
    <section className="section">
      <div className="head">
        <h2>一周盈亏</h2>
        <span className="hint">每个交易日一个点 · 服务端每 60s 落盘</span>
      </div>
      <div className="equityRow">
        <div className="equityNow">
          <span className="muted small">当前权益</span>
          <b className="mono" style={{ fontSize: 24 }}>
            {totals ? fmtCny(totals.equity) : "-"}
          </b>
          <span className={`mono ${cls}`} style={{ fontSize: 14 }}>
            {totals ? `${pnl >= 0 ? "+" : ""}${fmtCny(pnl)} (${fmtPct(totals.pnlPct * 100, 2)})` : "-"}
          </span>
        </div>
        <div className="equityChart">
          {week.length === 0 ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              还没有权益记录：跑满一个交易日后，这里会出现第一个点
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${Math.max(week.length * 44, 132)} 44`}
              style={{ width: Math.max(week.length * 44, 132), height: 48, display: "block" }}
            >
              {week.map((p, i) => {
                const dayPnl = p.equity - base;
                const c = dayPnl > 0 ? "var(--up)" : dayPnl < 0 ? "var(--down)" : "var(--muted-2)";
                return (
                  <g key={p.date}>
                    <rect x={i * 44 + 12} y={44 - bar(p.equity)} width={20} height={bar(p.equity)} rx={2} fill={c} opacity={0.85} />
                    <text x={i * 44 + 22} y={43} textAnchor="middle" fontSize={9} fill="var(--muted)">
                      {p.date.slice(5).replace("-", "/")}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <div className="equitySide">
          <div className="row">
            <span className="muted small">已实现</span>
            <span className={`mono small ${pnlCls(totals?.realized)}`}>{signed(totals?.realized)}</span>
          </div>
          <div className="row">
            <span className="muted small">浮动</span>
            <span className={`mono small ${pnlCls(totals?.unrealized)}`}>{signed(totals?.unrealized)}</span>
          </div>
          <div className="row">
            <span className="muted small">仓位</span>
            <span className="mono small">{totals ? fmtPct(totals.exposurePct * 100, 0) : "-"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
