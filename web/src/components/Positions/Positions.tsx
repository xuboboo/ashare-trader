"use client";

import { fmtCny, fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import type { PositionView, Totals } from "@/lib/types";

/** 持仓：可卖 / 今日买入冻结分列，T+1 一眼看得见。无外框，只有发丝横线。 */
export default function Positions({ positions, totals }: { positions: PositionView[]; totals: Totals | null }) {
  return (
    <section className="section">
      <div className="head">
        <h2>持仓</h2>
        <span className="hint">
          {totals ? `现金 ${fmtCny(totals.cash)} · 仓位 ${fmtPct(totals.exposurePct * 100, 0)} · 已实现 ${fmtCny(totals.realized)}` : ""}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>标的</th>
            <th>数量</th>
            <th>可卖</th>
            <th>今日买入</th>
            <th>成本</th>
            <th>现价</th>
            <th>浮动</th>
            <th>止损</th>
            <th>建仓日</th>
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 ? (
            <tr className="empty">
              <td colSpan={9}>空仓</td>
            </tr>
          ) : (
            positions.map((p) => (
              <tr key={p.code}>
                <td className="txt">
                  {p.name} <span className="muted">{p.code}</span>
                </td>
                <td>{fmtInt(p.qty)}</td>
                <td className={p.sellable > 0 ? undefined : "muted"}>{fmtInt(p.sellable)}</td>
                <td className={p.frozen > 0 ? "down" : "muted"}>{fmtInt(p.frozen)}</td>
                <td>{fmtPrice(p.avgPrice)}</td>
                <td>{fmtPrice(p.lastPrice)}</td>
                <td className={p.unrealized >= 0 ? "up" : "down"}>
                  {fmtCny(p.unrealized)} <span className="muted">{fmtPct(p.unrealizedPct, 2)}</span>
                </td>
                <td className="muted">{fmtPrice(p.stopPrice)}</td>
                <td className="muted">{p.openDate.slice(5)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
