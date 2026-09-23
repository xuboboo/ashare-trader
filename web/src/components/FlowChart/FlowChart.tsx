"use client";

import { fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import type { TickEvent } from "@/lib/types";

/** 上证折线 + 大盘闸门 + 候选排名。闸门是文字状态，不是徽章盒子。 */
export default function FlowChart({ events, latest }: { events: TickEvent[]; latest: TickEvent | null }) {
  const pts = events.slice(-140).filter((e) => e.index?.price > 0);
  const w = 600;
  const h = 150;
  let path = "";
  let maPath = "";
  if (pts.length > 1) {
    const prices = pts.map((e) => e.index.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const x = (i: number) => (i / (pts.length - 1)) * w;
    const y = (v: number) => h - ((v - min) / span) * (h - 22) - 6;
    path = pts.map((e, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(e.index.price).toFixed(1)}`).join(" ");
    const withMa = pts.filter((e) => e.index.ma5 && e.index.ma5 > 0);
    maPath = withMa
      .map((e, i) => `${i === 0 ? "M" : "L"}${x(pts.indexOf(e)).toFixed(1)},${y(e.index.ma5!).toFixed(1)}`)
      .join(" ");
  }

  const gate = latest?.gate ?? null;
  const bias = latest?.bias ?? null;
  const top = latest?.scan.top ?? [];

  return (
    <section className="section">
      <div className="head">
        <h2>大盘与候选</h2>
        <span className="hint">
          闸门
          <span className={gate?.allowed ? "down" : "up"}> {gate?.allowed ? "开" : "关"}</span>
          {bias ? ` · 情绪 ${fmtPct(bias.emotionScore * 100, 0)}${bias.enabled ? "" : "（规则）"}${bias.llmFailed ? " · LLM 已降级" : ""}` : ""}
        </span>
      </div>

      {gate && !gate.allowed ? <div className="banner" style={{ padding: "0 0 10px", borderBottom: "none" }}>今天不开仓：{gate.reasons.join("；")}</div> : null}
      {bias && gate?.allowed && !bias.allowOpen ? (
        <div className="banner" style={{ padding: "0 0 10px", borderBottom: "none" }}>情绪闸门否决：{bias.reason}</div>
      ) : null}

      <div className="chart">
        {path ? (
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="上证指数走势">
            {maPath ? <path d={maPath} fill="none" stroke="var(--muted-2)" strokeWidth={1} strokeDasharray="4 3" /> : null}
            <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.4} />
          </svg>
        ) : (
          <div className="muted small" style={{ paddingTop: 40 }}>
            交易时段才有走势。现在可以点"立即扫描"用最近收盘价复盘。
          </div>
        )}
        <div className="chartLabel">
          上证 {latest ? fmtPrice(latest.index.price) : "—"} · MA5 {latest?.index.ma5 ? fmtPrice(latest.index.ma5) : "—"} ·{" "}
          {latest ? `${fmtInt(latest.index.amountYi)}亿` : ""}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>标的</th>
            <th>分(因子)</th>
            <th>现价</th>
            <th>涨幅</th>
            <th>量比</th>
            <th>vs均线</th>
            <th>依据</th>
          </tr>
        </thead>
        <tbody>
          {top.length === 0 ? (
            <tr className="empty">
              <td colSpan={7}>
                {latest ? `${fmtInt(latest.scan.scored)} 支打分，${fmtInt(latest.scan.rejected)} 支被否决` : "还没有数据"}
              </td>
            </tr>
          ) : (
            top.map((c) => (
              <tr key={c.code}>
                <td className="txt">
                  {c.name} <span className="muted">{c.code}</span>
                </td>
                <td>{c.score.toFixed(2)}</td>
                <td>{fmtPrice(c.price)}元</td>
                <td className="up">{c.gainPct.toFixed(2)}%</td>
                <td>{c.volumeRatio.toFixed(2)}</td>
                <td className={c.priceVsVwapBps >= 0 ? "up" : "down"}>
                  {c.priceVsVwapBps >= 0 ? "+" : ""}
                  {c.priceVsVwapBps}bp
                </td>
                <td className="why">{c.reasons.join("；")}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
