"use client";

import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import Positions from "@/components/Positions/Positions";
import Signals from "@/components/Signals/Signals";
import StatsRow from "@/components/StatsRow/StatsRow";
import { useFeed } from "@/lib/useFeed";
import type { SuggestedOrder } from "@/lib/types";

export default function Page() {
  const feed = useFeed();
  const latest = feed.latest;

  // 建议单散落在各个心跳里，按 signalId 汇总；成交状态以最新一次上报为准。
  // 键带上日期与时刻：后端重启后 signalId 会从 0001 重新计数，只用 id 会撞车
  const byId = new Map<string, SuggestedOrder>();
  for (const e of feed.events) for (const o of e.orders) byId.set(`${o.signalId}@${o.date} ${o.time}`, o);
  const orders = [...byId.values()];

  const banners: string[] = [];
  if (latest?.quotes.eodOnly) banners.push("实时链路已降级为日频：只在盘前出一次信号");
  else if (latest && latest.quotes.fails > 0) banners.push(`行情接口失败 ${latest.quotes.fails} 次，连续 3 次将降级`);
  if (latest?.quotes.stale) banners.push(`行情已老化 ${latest.quotes.ageSec}s（阈值内才算活价），本轮不出单也不判成交`);
  if (feed.meta?.calendarStale) banners.push("交易日历不可用，按周一~周五猜测交易日");
  if (latest && !latest.tradingDay) banners.push(`非交易日（${latest.date}），下面是最近一个交易日的复盘快照`);
  if (latest?.decision?.modelFailed) banners.push("模型本轮失败，已按 hold 处理");

  return (
    <div className="card">
      <Header meta={feed.meta} latest={latest} connection={feed.connection} />
      <StatsRow latest={latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      {banners.map((b) => (
        <div className="banner" key={b}>
          {b}
        </div>
      ))}
      <Signals allOrders={orders} onFilled={() => void 0} />
      <Positions positions={latest?.positions ?? []} totals={latest?.totals ?? null} />
      <div className="cols">
        <div className="col">
          <FlowChart events={feed.events} latest={latest} />
        </div>
        <div className="col">
          <Feed events={feed.events} />
        </div>
      </div>
    </div>
  );
}
