"use client";

import { useState } from "react";
import { fmtCny, fmtInt, fmtPrice, orderLine } from "@/lib/format";
import { useApi } from "@/lib/useFeed";
import type { SuggestedOrder } from "@/lib/types";

const rowKey = (o: SuggestedOrder) => `${o.signalId}@${o.date} ${o.time}`;

/**
 * 建议单：系统的最终产物就是一行行可执行的字段 + 一个回填入口。
 * 一行一单，不用卡片；按钮是文字，不是盒子。
 */
export default function Signals({ allOrders, onFilled }: { allOrders: SuggestedOrder[]; onFilled: () => void }) {
  const api = useApi();
  const [copied, setCopied] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", side: "buy", qty: "", price: "" });

  const copy = (text: string, key: string) => {
    try {
      void navigator.clipboard?.writeText(text)?.catch(() => {});
    } catch {
      /* 浏览器不给剪贴板权限时，字仍然在行里，可手抄 */
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const prefill = (o: SuggestedOrder) =>
    setForm({ code: o.code, side: o.side, qty: String(o.qty), price: String(o.priceRef) });

  const submit = () => {
    if (!form.code || !form.qty) return;
    void api
      .fill({
        code: form.code,
        side: form.side,
        qty: Number(form.qty),
        price: form.price ? Number(form.price) : undefined,
        note: "仪表盘手工回填",
      })
      .then(onFilled);
  };

  const orders = allOrders.slice(-14).reverse();

  return (
    <section className="section">
      <div className="head">
        <h2>建议单</h2>
        <span className="hint">人工在券商 App 执行，本系统不下达委托</span>
        <span className="spacer" />
        <button className="btn" onClick={() => void api.scan().then(onFilled)} disabled={api.busy}>
          {api.busy ? "扫描中…" : "立即扫描"}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>时刻</th>
            <th>标的</th>
            <th>方向</th>
            <th>股数</th>
            <th>限价区间</th>
            <th>金额</th>
            <th>往返成本</th>
            <th>止损</th>
            <th>依据</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 ? (
            <tr className="empty">
              <td colSpan={10}>暂无建议单。交易时段 14:40 自动选股，或点右上"立即扫描"用最近收盘价复盘。</td>
            </tr>
          ) : (
            orders.map((o) => (
              <tr key={rowKey(o)} title={o.warn ?? undefined}>
                <td className="muted">
                  {o.date.slice(5)} {o.time}
                </td>
                <td className="txt">
                  {o.name} <span className="muted">{o.code}</span>
                </td>
                <td className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "买入" : "卖出"}</td>
                <td>{fmtInt(o.qty)}</td>
                <td>
                  {fmtPrice(o.limitLow)}–{fmtPrice(o.limitHigh)}
                </td>
                <td>{fmtCny(o.amountCny)}</td>
                <td className={o.costBps > 15 ? "up" : undefined}>
                  {o.costBps.toFixed(1)}bp <span className="muted">/ {fmtCny(o.costCny)}</span>
                </td>
                <td>{o.stopPrice ? fmtPrice(o.stopPrice) : "—"}</td>
                <td className="why">{o.reason}</td>
                <td>
                  <span className="acts">
                    <button className="btn" onClick={() => copy(orderLine(o), rowKey(o))}>
                      {copied === rowKey(o) ? "已复制" : "复制"}
                    </button>
                    {o.status === "pending" ? (
                      <button className="btn btnPrimary" onClick={() => prefill(o)}>
                        回填
                      </button>
                    ) : (
                      <span className="muted tiny">
                        {o.status === "filled" ? `已成交 ${o.fill ? fmtPrice(o.fill.price) : ""}` : o.status}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {orders.some((o) => o.warn) ? (
        <div className="error" style={{ color: "var(--warn)" }}>
          有建议单触发了最低佣金警告（行悬停可见），这类单的固定成本可能吃掉大半预期收益。
        </div>
      ) : null}
      {api.error ? <div className="error">{api.error}</div> : null}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          代码
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="600000" maxLength={6} />
        </label>
        <label className="field">
          方向
          <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}>
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
          </select>
        </label>
        <label className="field">
          股数
          <input value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} placeholder="800" inputMode="numeric" />
        </label>
        <label className="field">
          成交价（留空=最新快照）
          <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="61.40" inputMode="decimal" />
        </label>
        <button className="btn btnPrimary" type="submit" disabled={api.busy}>
          记一笔真实成交
        </button>
      </form>
    </section>
  );
}
