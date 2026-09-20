"use client";

import { fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import type { TickEvent } from "@/lib/types";

/**
 * 上证指数折线 + 大盘闸门 + 候选排名。
 * 折线只画最近 120 个心跳（3 秒一帧约 6 分钟），够用且不会被历史拉长压扁。
 */
export default function FlowChart({ events, latest }: { events: TickEvent[]; latest: TickEvent | null }) {
  const pts = events.slice(-120).filter((e) => e.index?.price > 0);
  const w = 600;
  const h = 160;
  let path = "";
  let maPath = "";
  if (pts.length > 1) {
    const prices = pts.map((e) => e.index.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const x = (i: number) => (i / (pts.length - 1)) * w;
    const y = (v: number) => h - ((v - min) / span) * (h - 16) - 8;
    path = pts.map((e, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(e.index.price).toFixed(1)}`).join(" ");
    maPath = pts
      .filter((e) => e.index.ma5 && e.index.ma5 > 0)
      .map((e, i) => {
        const idx = pts.indexOf(e);
        return `${i === 0 ? "M" : "L"}${x(idx).toFixed(1)},${y(e.index.ma5!).toFixed(1)}`;
      })
      .join(" ");
  }

  const gate = latest?.gate ?? null;
  const bias = latest?.bias ?? null;
  const top = latest?.scan.top ?? [];

  return (
    <section className="panel">
      <div className="panelHead">
        大盘与候选
        <span className="spacer" />
        <span className={`badge ${gate?.allowed ? "badgeUp" : "badgeWarn"}`}>闸门 {gate?.allowed ? "开" : "关"}</span>
        {bias ? (
          <span className="badge">
            情绪 {fmtPct(bias.emotionScore * 100, 0)} {bias.enabled ? "" : "·规则"}
            {bias.llmFailed ? " · LLM失败已降级" : ""}
          </span>
        ) : null}
      </div>

      <div className="chart">
        {path ? (
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="上证指数走势">
            {maPath ? <path d={maPath} fill="none" stroke="var(--muted-2)" strokeWidth={1} strokeDasharray="4 3" /> : null}
            <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.6} />
          </svg>
        ) : (
          <div className="muted small" style={{ padding: 24 }}>
            等行情：交易时段才会画。现在可以点"立即扫描"用最近收盘价复盘。
          </div>
        )}
        <div className="chartLabel mono">
          上证 {latest ? fmtPrice(latest.index.price) : "-"} / MA5 {latest?.index.ma5 ? fmtPrice(latest.index.ma5) : "-"}
        </div>
      </div>

      {gate && !gate.allowed ? <div className="banner">今天不开仓：{gate.reasons.join("；")}</div> : null}
      {bias && gate?.allowed && !bias.allowOpen ? <div className="banner">LLM 情绪闸门否决：{bias.reason}</div> : null}

      <div style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>股票</th>
              <th>分</th>
              <th>涨幅</th>
              <th>量比</th>
              <th>vs均线</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {top.length === 0 ? (
              <tr>
                <td className="name" colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>
                  {latest ? `今日 ${fmtInt(latest.scan.scored)} 支打分，${fmtInt(latest.scan.rejected)} 支被否决` : "无数据"}
                </td>
              </tr>
            ) : (
              top.map((c) => (
                <tr key={c.code}>
                  <td className="name">
                    {c.name} <span className="muted">{c.code}</span>
                  </td>
                  <td>{c.score.toFixed(2)}</td>
                  <td className="up">{c.gainPct.toFixed(2)}%</td>
                  <td>{c.volumeRatio.toFixed(2)}</td>
                  <td>{c.priceVsVwapBps >= 0 ? "+" : ""}
                    {c.priceVsVwapBps}bp</td>
                  <td className="muted name" style={{ textAlign: "left", whiteSpace: "normal" }}>
                    {c.reasons.slice(0, 2).join("；")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
