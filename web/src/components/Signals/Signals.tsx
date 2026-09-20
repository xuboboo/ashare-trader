"use client";

import { useState } from "react";
import { fillCommand, fmtCny, fmtInt, fmtPrice, orderLine } from "@/lib/format";
import { useApi } from "@/lib/useFeed";
import type { SuggestedOrder, TickEvent } from "@/lib/types";

/**
 * 建议单：这一栏就是系统的最终产物——一行能在券商 App 里照着敲的字，
 * 以及"我已经按这个价成交了"的回填入口。系统不会、也不能替你下单。
 */
export default function Signals({
  latest,
  allOrders,
  onFilled,
}: {
  latest: TickEvent | null;
  allOrders: SuggestedOrder[];
  onFilled: () => void;
}) {
  const api = useApi();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    try {
      void navigator.clipboard?.writeText(text)?.catch(() => {});
    } catch {
      /* 浏览器不给剪贴板权限时，文案仍然看得见可手抄 */
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const orders = allOrders.slice(-8).reverse();

  return (
    <section className="panel">
      <div className="panelHead">
        建议单（人工执行）
        <span className="spacer" />
        <button className="btn" onClick={() => void api.scan().then(onFilled)} disabled={api.busy}>
          {api.busy ? "扫描中…" : "立即扫描"}
        </button>
      </div>

      {orders.length === 0 ? (
        <div className="muted small" style={{ padding: "10px 2px" }}>
          暂无建议单。交易时段 14:40 自动选股；也可点"立即扫描"用最近收盘价复盘。
        </div>
      ) : (
        orders.map((o) => (
          <article key={o.signalId} className={`order ${o.side === "sell" ? "orderSell" : ""}`}>
            <div className="orderTop">
              <span className="orderName">{o.name || o.code}</span>
              <span className="mono muted">{o.code}</span>
              <span className={`badge ${o.side === "buy" ? "badgeUp" : "badgeDown"}`}>
                {o.side === "buy" ? "买入" : "卖出"} {fmtInt(o.qty)} 股
              </span>
              <span className="badge">{o.status}</span>
              <span className="spacer" />
              <span className="mono muted tiny">
                {o.date} {o.time}
              </span>
            </div>

            <div className="orderGrid">
              <span className="kv">
                限价区间<b>
                  {fmtPrice(o.limitLow)} - {fmtPrice(o.limitHigh)}
                </b>
              </span>
              <span className="kv">
                金额<b>{fmtCny(o.amountCny)}</b>
              </span>
              <span className="kv">
                往返成本<b>{o.costBps.toFixed(1)}bp / {fmtCny(o.costCny)}</b>
              </span>
              <span className="kv">
                止损<b>{o.stopPrice ? fmtPrice(o.stopPrice) : "-"}</b>
              </span>
            </div>

            <div className="reason">{o.reason}</div>
            {o.mustExitAt ? <div className="reason muted">次日退出：{o.mustExitAt}</div> : null}
            {o.warn ? <div className="warn">⚠ {o.warn}</div> : null}
            {o.fill ? (
              <div className="reason">
                影子成交 {fmtPrice(o.fill.price)} × {fmtInt(o.fill.qty)}（{o.fill.kind === "paper" ? "纸面" : "人工回填"}）
                {o.fill.realizedPnl !== undefined ? ` 实现 ${fmtCny(o.fill.realizedPnl)}` : ""}
              </div>
            ) : null}

            <div className="actions">
              <button className="btn" onClick={() => copy(orderLine(o), o.signalId)}>
                {copied === o.signalId ? "已复制" : "复制下单指令"}
              </button>
              <button className="btn" onClick={() => copy(fillCommand(o), `c${o.signalId}`)}>
                复制回填命令
              </button>
              {o.status === "pending" ? (
                <button
                  className="btn btnPrimary"
                  disabled={api.busy}
                  onClick={() =>
                    void api
                      .fill({
                        code: o.code,
                        side: o.side,
                        qty: o.qty,
                        price: o.priceRef,
                        signalId: o.signalId,
                        note: "仪表盘按参考价回填",
                      })
                      .then(onFilled)
                  }
                >
                  按参考价回填
                </button>
              ) : null}
            </div>
          </article>
        ))
      )}

      <FillForm onDone={onFilled} busy={api.busy} submit={(b) => api.fill(b)} />
      {api.error ? <div className="error">{api.error}</div> : null}
    </section>
  );
}

function FillForm({
  onDone,
  busy,
  submit,
}: {
  onDone: () => void;
  busy: boolean;
  submit: (b: { code: string; side: string; qty: number; price?: number; note?: string }) => Promise<unknown>;
}) {
  const [code, setCode] = useState("");
  const [side, setSide] = useState("buy");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");

  return (
    <form
      className="form"
      style={{ marginTop: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!code || !qty) return;
        void submit({ code, side, qty: Number(qty), price: price ? Number(price) : undefined, note: "仪表盘手工回填" }).then(onDone);
        setQty("");
        setPrice("");
      }}
    >
      <label className="field">
        代码
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="600000" maxLength={6} />
      </label>
      <label className="field">
        方向
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="buy">买入</option>
          <option value="sell">卖出</option>
        </select>
      </label>
      <label className="field">
        股数
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="800" inputMode="numeric" />
      </label>
      <label className="field">
        成交价（留空=用最新快照）
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="61.40" inputMode="decimal" />
      </label>
      <button className="btn btnPrimary" type="submit" disabled={busy}>
        记账
      </button>
    </form>
  );
}
