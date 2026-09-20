"use client";

import { useEffect, useState } from "react";
import { phaseCn } from "@/lib/format";
import type { ConnectionState, Meta, TickEvent } from "@/lib/types";

/** 北京时间秒表：浏览器不在 +8 时区也要显示对的盘面时间。 */
const bjFmt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function useBeijingClock(): string {
  const [t, setT] = useState<string>("");
  useEffect(() => {
    const tick = () => setT(bjFmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

export default function Header({
  meta,
  latest,
  connection,
}: {
  meta: Meta | null;
  latest: TickEvent | null;
  connection: ConnectionState;
}) {
  const clock = useBeijingClock();
  const live = latest?.phase === "continuous";
  return (
    <header className="header">
      <span className="title">A 股 T+1 决策台</span>
      <span className={`badge ${live ? "" : "badgeWarn"}`}>
        <span className={`dot ${connection === "live" ? "" : "dotOff"}`} />
        {connection === "live" ? "在线" : connection === "reconnecting" ? "重连中" : "连接中"}
      </span>
      <span className="badge">{phaseCn(latest?.phase)}</span>
      {latest ? <span className="badge">{latest.trigger}</span> : null}
      {meta?.paper !== false ? <span className="badge badgeDown">PAPER 影子成交</span> : <span className="badge badgeUp">真实下单</span>}
      <span className="spacer" />
      <span className="mono small muted">
        {latest?.date ?? ""} {clock}
      </span>
      <span className="sub">下次触发 {latest?.trigger === "尾盘选股" ? "14:57 收盘前" : "14:40 尾盘选股"}</span>
    </header>
  );
}
