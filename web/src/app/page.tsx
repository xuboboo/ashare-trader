"use client";

import { useEffect, useState } from "react";
import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import EquityStrip from "@/components/EquityStrip/EquityStrip";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import Ledger from "@/components/Ledger/Ledger";
import Positions from "@/components/Positions/Positions";
import Signals from "@/components/Signals/Signals";
import StatsRow from "@/components/StatsRow/StatsRow";
import { useFeed, API_URL } from "@/lib/useFeed";
import type { BrokerStatus, SuggestedOrder } from "@/lib/types";

export default function Page() {
  const feed = useFeed();
  const latest = feed.latest;
  const [error, setError] = useState<string | null>(null);
  const [broker, setBroker] = useState<BrokerStatus | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 决策的"Xs 前"标签每秒刷新一次就够
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // QMT sidecar 状态：30s 轮询一次（不可达时按钮自然隐藏）。地址统一走 API_URL（http/https 已校验）
  useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/broker`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setBroker(j as BrokerStatus))
        .catch(() => setBroker(null));
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // 建议单散落在各个心跳里，按 signalId 汇总；成交状态以最新一次上报为准。
  // 键带上日期与时刻：后端重启后 signalId 会从 0001 重新计数，只用 id 会撞车
  const byId = new Map<string, SuggestedOrder>();
  for (const e of feed.events) for (const o of e.orders) byId.set(`${o.signalId}@${o.date} ${o.time}`, o);
  const orders = [...byId.values()];

  // 决策面板的数据：最近一条带 decision 的事件 + 决策事件流（旧→新）
  const withDecision = feed.events.filter((e) => e.decision);
  const lastDecisionEvent = withDecision.at(-1) ?? null;

  const banners: string[] = [];
  if (latest?.quotes.eodOnly) banners.push("实时链路已降级为日频：只在盘前出一次信号");
  else if (latest && latest.quotes.fails > 0) banners.push(`行情接口失败 ${latest.quotes.fails} 次，连续 3 次将降级`);
  if (latest?.quotes.stale) banners.push(`行情已老化 ${latest.quotes.ageSec}s（阈值内才算活价），本轮不出单也不判成交`);
  if (feed.meta?.calendarStale) banners.push("交易日历不可用，按周一~周五猜测交易日");
  if (latest && !latest.tradingDay) banners.push(`非交易日（${latest.date}），下面是最近一个交易日的复盘快照`);
  if (latest?.decision?.modelFailed) banners.push("模型本轮失败，已按规则层执行");
  if (latest?.risk?.buyBlocked) banners.push(`风控闸：${latest.risk.reasons.join("；")}`);
  if (latest && latest.totals.cash < 0) banners.push(`现金为负（${latest.totals.cash.toFixed(0)} 元）：回填金额超过了本金，请核对是否多记了一笔（可在"成交与账本"区撤销）`);
  if (error) banners.push(`操作未完成：${error}`);

  return (
    <div className="card">
      <Header meta={feed.meta} latest={latest} connection={feed.connection} />
      <StatsRow latest={latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      {banners.map((b) => (
        <div className="banner" key={b}>
          {b}
        </div>
      ))}
      <div className="cols">
        <div className="col">
          <DecisionPanel
            event={lastDecisionEvent}
            history={withDecision}
            latest={latest}
            meta={feed.meta}
            nowMs={nowMs}
          />
        </div>
        <div className="col">
          <FlowChart events={feed.events} latest={latest} />
          <EquityStrip totals={latest?.totals ?? null} />
        </div>
      </div>
      <Signals allOrders={orders} onFilled={() => void 0} broker={broker} />
      <Positions positions={latest?.positions ?? []} totals={latest?.totals ?? null} />
      <Ledger fillCount={latest?.totals.fills ?? 0} onError={setError} />
      <div className="cols">
        <div className="col">
          <Feed events={feed.events} />
        </div>
      </div>
    </div>
  );
}
