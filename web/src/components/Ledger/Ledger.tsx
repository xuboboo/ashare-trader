"use client";

import { useEffect, useState } from "react";
import { fmtCny, fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import { API_TOKEN, API_URL } from "@/lib/useFeed";
import type { Fill, Totals } from "@/lib/types";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(API_TOKEN ? { "x-auth": API_TOKEN } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(String((j as { error?: string })?.error ?? `HTTP ${r.status}`));
  return j as T;
}

/**
 * 成交与账本：回填错了要能撤销，整本想重来要能清空。
 * 两个动作都是破坏性的，所以都要 confirm；后端另外还要求 /reset 显式带 confirm 字段。
 */
export default function Ledger({ fillCount, onError }: { fillCount: number; onError: (msg: string) => void }) {
  const [fills, setFills] = useState<Fill[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const r = (await (await fetch(`${API_URL}/fills?n=80`)).json()) as { fills: Fill[]; totals: Totals };
        if (!dead) {
          setFills(r.fills ?? []);
          setTotals(r.totals ?? null);
        }
      } catch (e) {
        if (!dead) onError((e as Error).message);
      }
    })();
    return () => {
      dead = true;
    };
  }, [fillCount]);

  const remove = async (f: Fill) => {
    if (!confirm(`撤销这笔成交？\n\n${f.date} ${f.time} ${f.name}(${f.code}) ${f.side === "buy" ? "买入" : "卖出"} ${f.qty} @ ${f.price}\n\n撤销后账本会用剩下的成交重放重建，原流水归档到 data/voids.log。`))
      return;
    setBusy(true);
    try {
      await post("/fill/remove", { id: f.id });
      const r = (await (await fetch(`${API_URL}/fills?n=80`)).json()) as { fills: Fill[]; totals: Totals };
      setFills(r.fills ?? []);
      setTotals(r.totals ?? null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!confirm(`清空整个账本？\n\n将移除 ${fills.length} 笔成交、全部持仓与权益曲线，现金回到参考本金。`)) return;
    if (!confirm("再确认一次：trades.jsonl 与 positions.json 会先归档到 data/archive/，然后账本清零。继续？")) return;
    setBusy(true);
    try {
      const r = await post<{ ok: true; removed: number; archived: string | null }>("/reset", { confirm: "CLEAR" });
      alert(r.archived ? `已清空 ${r.removed} 笔，旧账本归档到 ${r.archived}` : `已清空 ${r.removed} 笔`);
      const next = (await (await fetch(`${API_URL}/fills?n=80`)).json()) as { fills: Fill[]; totals: Totals };
      setFills(next.fills ?? []);
      setTotals(next.totals ?? null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <div className="head">
        <h2>成交与账本</h2>
        <span className="hint">
          {totals ? `现金 ${fmtCny(totals.cash)} · 已实现 ${fmtCny(totals.realized)} · 权益 ${fmtCny(totals.equity)}` : ""}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => void reset()} disabled={busy || fills.length === 0}>
          清空账本
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>时刻</th>
            <th>标的</th>
            <th>方向</th>
            <th>数量</th>
            <th>成交价</th>
            <th>金额</th>
            <th>费用</th>
            <th>盈亏</th>
            <th>来源</th>
            <th>备注</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fills.length === 0 ? (
            <tr className="empty">
              <td colSpan={12}>没有成交。回填一笔真实成交，或等影子撮合。</td>
            </tr>
          ) : (
            fills
              .slice()
              .reverse()
              .map((f, i) => (
                <tr key={`${f.id}-${i}`}>
                  <td className="muted">{f.date.slice(5)}</td>
                  <td className="muted">{f.time}</td>
                  <td className="txt">
                    {f.name} <span className="muted">{f.code}</span>
                  </td>
                  <td className={f.side === "buy" ? "up" : "down"}>{f.side === "buy" ? "买入" : "卖出"}</td>
                  <td>{fmtInt(f.qty)}</td>
                  <td>{fmtPrice(f.price)}</td>
                  <td>{fmtCny(f.amount)}</td>
                  <td>{fmtCny(f.costs.total, 2)}</td>
                  <td className={f.realizedPnl !== undefined ? (f.realizedPnl >= 0 ? "up" : "down") : "muted"}>
                    {f.realizedPnl !== undefined
                      ? `${fmtCny(f.realizedPnl)}${f.realizedPnlPct !== undefined ? ` ${fmtPct(f.realizedPnlPct, 2)}` : ""}`
                      : "—"}
                  </td>
                  <td className="txt muted">{f.kind === "manual" ? "人工回填" : "影子"}</td>
                  <td className="why">{f.note ?? ""}</td>
                  <td>
                    <button className="btn" onClick={() => void remove(f)} disabled={busy}>
                      撤销
                    </button>
                  </td>
                </tr>
              ))
          )}
        </tbody>
      </table>
    </section>
  );
}
