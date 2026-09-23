"use client";

import { fmtPct, fmtPrice } from "@/lib/format";
import type { Meta, TickEvent } from "@/lib/types";

/**
 * 模型买卖决策面板（版式对齐 jev-trader 的 STANDING ORDER + WHICH SIDE THIS BLOCK）：
 *  - 常设命令：这套系统的规则口径（全程决策 / 概率阈值 / T+1 / 本金）；
 *  - 这一轮怎么操作：最近一次模型决策的大字结论 + 概率条 + 入选清单 + 决策流水。
 * 心跳轮没有 decision（比如纯退出管理轮），所以取的是最近一条带 decision 的事件。
 */

interface Props {
  /** 最近一条带 decision 的事件（可为 null：还没跑过决策） */
  event: TickEvent | null;
  /** 最近的决策事件流，旧的在前；面板取最后 8 条做流水 */
  history: TickEvent[];
  /** 最新一轮（拿闸门与触发点做上下文） */
  latest: TickEvent | null;
  meta: Meta | null;
  nowMs: number;
}

function BarRow({ label, active, value, fill, pct }: { label: string; active: boolean; value: number; fill: string; pct: string }) {
  return (
    <div className="barRow">
      <span className="barLabel" style={{ opacity: active ? 1 : 0.38 }}>
        {label}
      </span>
      <div className="barTrack">
        <div className="barFill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: fill }} />
      </div>
      <span className="barPct">{pct}</span>
    </div>
  );
}

const DASH = "-";

export default function DecisionPanel({ event, history, latest, meta, nowMs }: Props) {
  const d = event?.decision ?? null;
  const action = d?.action ?? null;
  const degraded = d?.modelFailed ?? false;
  const probs = d?.probabilities ?? { buy: 0, sell: 0, hold: 0 };
  const trace = d?.trace;
  const hardRuleSkip = trace?.source === "hard-rule";
  // 规则层的 probabilities 是打分离 softmax，有 picks 时 buy 恒为 100% —— 那不是胜率，必须标出来
  const rankShare = !hardRuleSkip && (d?.probabilitySemantics ?? "rank-share") === "rank-share";
  const traceLabel = !trace
    ? "调用证据未知"
    : trace.source === "jev" && trace.call === "remote" && trace.status === "ok"
      ? "Jev 远端已调用"
      : trace.source === "jev" && trace.call === "cache" && trace.status === "ok"
        ? "Jev 成功缓存（本轮未远端调用）"
        : trace.source === "jev"
          ? `Jev ${trace.status} · HOLD`
          : trace.source === "hard-rule"
            ? "硬规则短路（未调用模型）"
            : `${trace.source} · ${trace.status}`;

  const headline =
    action === "buy" ? "买入" : action === "sell" ? "卖出" : d ? "观望" : "等待";
  const headlineColor =
    action === "buy" ? "var(--up)" : action === "sell" ? "var(--down)" : "var(--muted)";
  const headlinePct = action === "buy" || action === "sell" ? fmtPct(probs[action] * 100, 0) : "";

  // 决策的"新鲜度"：心跳轮不产生新决策，把最近一条的时刻标出来，别让 stale 决策冒充当前结论
  const ageSec = event ? Math.max(0, Math.round((nowMs - event.ts) / 1000)) : null;
  const ageLabel =
    ageSec === null ? "" : ageSec < 60 ? `${ageSec}s 前` : ageSec < 3600 ? `${Math.round(ageSec / 60)} 分钟前` : `${Math.round(ageSec / 3600)} 小时前`;

  const cadence = meta?.decideEveryMs ? `${Math.round(meta.decideEveryMs / 1000)}s` : "60s";
  const bankroll = meta?.bankrollCny !== undefined ? `${(meta.bankrollCny / 10000).toFixed(0)} 万` : "1 万";
  const size = meta?.sizeCny !== undefined ? `${Math.round(meta.sizeCny).toLocaleString()}` : "3,300";
  const stop = meta?.stopLabel ?? "次日止损触发线 −3%";
  const entryRule = meta?.entryRule ?? `规则打分排序，取前 ${meta?.maxPositions ?? 3} 只`;
  const window = meta?.openWindow ?? "09:30–14:57";
  const maxPos = meta?.maxPositions ?? 3;
  // MAX_POSITIONS=0 表示不限仓：直说"持仓不限"，不要显示"最多 0 仓"这种自相矛盾的文案
  const maxPosLabel = maxPos > 0 ? `最多 ${maxPos} 仓` : "持仓不限";

  const recent = history.slice(-8).reverse();
  return (
    <section className="section">
      <div className="head">
        <h2>模型决策</h2>
        <span className="hint">
          {meta ? `${meta.model} · ${meta.modelTransport ?? "transport-unknown"} · 每 ${cadence} 一轮` : "等待后端"}
          {` · ${traceLabel}`}
        </span>
      </div>

      <div className="decisionLabel">常设命令 · STANDING ORDER</div>
      <div className="decisionOrder">
        {`> 盘前预选一次；开仓窗口 ${window}，全程按节奏决策。${entryRule}。
> 普通 A 股 T+1；退出时点由 Jev 自主判断。本金 ¥${bankroll} · 单笔上限 ¥${size} · ${maxPosLabel} · ${stop}。
> Jev 全程判断买入与可裁量卖出；止损、T+1、涨跌停和交易时段是系统硬边界，不允许模型绕过。`}
      </div>

      <div className="decisionLabel" style={{ marginTop: 14 }}>
        这一轮怎么操作？ · WHICH SIDE THIS ROUND?
      </div>
      <div className="decisionHeadline">
        <span className="decisionWord" style={{ color: headlineColor }}>
          {headline}
        </span>
        {headlinePct ? (
          <span className="decisionPct" style={{ color: headlineColor }}>
            {headlinePct}
          </span>
        ) : null}
        {event ? (
          <span className="muted tiny" style={{ marginLeft: "auto" }}>
            {event.time} · {event.trigger} · {ageLabel}
          </span>
        ) : null}
      </div>

      <BarRow label="买入" active={action === "buy"} value={probs.buy} fill="var(--up)" pct={d ? fmtPct(probs.buy * 100, 0) : DASH} />
      <BarRow
        label="观望"
        active={action === "hold" || !action}
        value={probs.hold}
        fill="var(--hair-2)"
        pct={d ? fmtPct(probs.hold * 100, 0) : DASH}
      />
      <BarRow label="卖出" active={action === "sell"} value={probs.sell} fill="var(--down)" pct={d ? fmtPct(probs.sell * 100, 0) : DASH} />

      {/* 概率语义：别让“100% 买入”冒充胜率 */}
      <div className="muted tiny" style={{ marginTop: 6 }}>
        {hardRuleSkip
          ? "本轮被系统硬规则短路，未调用模型"
          : rankShare
          ? "上面是候选间的排序占比（规则层无概率含义），不是胜算"
          : `上面是模型判定的“扣成本后为正”概率（${d?.probabilitySemantics === "calibrated" ? "本地模型，带训练集校准" : "Jev 远端判定，校准未独立验证"}）`}
      </div>

      <div className="muted tiny" style={{ marginTop: 8 }}>
        {!latest
          ? "闸门未知"
          : latest.gate.status === "idle"
            ? `闸门待命 · ${latest.gate.reasons.at(-1) ?? "不在交易窗口"}` // 最后一条就是时效说明
            : latest.gate.allowed
              ? `闸门开 · ${latest.gate.reasons[0] ?? ""}${
                  latest.gate.skipped?.length ? ` · 本轮未评估：${latest.gate.skipped.join("、")}` : ""
                }`
              : `闸门关 · ${latest.gate.reasons.join("；")}`}
        {degraded ? " · 本轮未获得 Jev 结果，未使用 FactorModel" : ""}
      </div>

      {d && d.picks.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div className="decisionLabel">本轮入选</div>
          {d.picks.map((p) => (
            <div className="pickRow" key={p.code}>
              <span className="pickName">
                {p.name} <span className="muted">({p.code})</span>
              </span>
              <span className="pickProb up mono">{fmtPct(p.probability * 100, 0)}</span>
              <span className="pickWhy muted tiny">{p.reasons[p.reasons.length - 1] ?? ""}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <div className="decisionLabel">决策流水</div>
        <div className="miniFeed">
          {recent.length === 0 ? (
            <div className="muted small" style={{ padding: "8px 0" }}>
              还没有决策记录（开盘后每 {cadence} 一轮）
            </div>
          ) : null}
          {recent.map((e) => {
            const dec = e.decision!;
            const a = dec.action;
            return (
              <div className="row" key={e.seq}>
                <span className="rowTime mono">{e.time}</span>
                <span className="rowMain">
                  <b className={a === "buy" ? "up" : a === "sell" ? "down" : "muted"}>{a === "buy" ? "买入" : a === "sell" ? "卖出" : "观望"}</b>
                  <span className="muted"> · {e.trigger}</span>
                  {dec.picks[0] ? (
                    <span className="muted">
                      {" "}
                      · {dec.picks[0].name}({dec.picks[0].code}) {fmtPct(dec.picks[0].probability * 100, 0)}
                    </span>
                  ) : null}
                </span>
                <span className="muted tiny nowrap">{fmtPrice(e.index.price)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
