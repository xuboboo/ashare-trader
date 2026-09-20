"use client";

import { fmtCny, fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import type { PositionView, Totals } from "@/lib/types";

/** 持仓：可卖 / 今日买入冻结 分列显示，T+1 这件事必须一眼看得见。 */
export default function Positions({ positions, totals }: { positions: PositionView[]; totals: Totals | null }) {
  return (
    <section className="panel">
      <div className="panelHead">
        持仓（T+1）
        <span className="spacer" />
        <span className="badge mono">
          现金 {totals ? fmtCny(totals.cash) : "-"} / 仓位 {totals ? fmtPct(totals.exposurePct * 100, 0) : "-"}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>股票</th>
            <th>数量</th>
            <th>可卖</th>
            <th>冻结</th>
            <th>成本</th>
            <th>现价</th>
            <th>浮动</th>
            <th>止损</th>
            <th>建仓</th>
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 ? (
            <tr>
              <td className="name" colSpan={9} style={{ textAlign: "center", color: "var(--muted)" }}>
                空仓
              </td>
            </tr>
          ) : (
            positions.map((p) => (
              <tr key={p.code}>
                <td className="name">
                  {p.name} <span className="muted">{p.code}</span>
                </td>
                <td>{fmtInt(p.qty)}</td>
                <td className={p.sellable > 0 ? "up" : "muted"}>{fmtInt(p.sellable)}</td>
                <td className={p.frozen > 0 ? "down" : "muted"}>{fmtInt(p.frozen)}</td>
                <td>{fmtPrice(p.avgPrice)}</td>
                <td>{fmtPrice(p.lastPrice)}</td>
                <td className={p.unrealized >= 0 ? "up" : "down"}>
                  {fmtCny(p.unrealized)} ({fmtPct(p.unrealizedPct, 2)})
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
