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

const CONN: Record<ConnectionState, string> = {
  connecting: "连接中",
  live: "在线",
  reconnecting: "重连中",
};

/** 标题一行 + 元信息一行，没有徽章盒子。 */
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
  const parts = [
    CONN[connection],
    phaseCn(latest?.phase),
    latest?.trigger,
    meta?.paper === false ? "真实下单" : "PAPER 影子成交",
    `模型 ${meta?.model ?? "—"}`,
    meta?.llm && meta.llm !== "off" ? `LLM ${meta.llm}` : "LLM 未启用",
    `股票池 ${meta?.universe ?? 0}`,
  ].filter(Boolean);

  return (
    <header className="header">
      <span className="title">A 股 T+1 决策台</span>
      <span className="spacer" />
      <span className="mono meta">
        {latest?.date ?? ""} {clock}
      </span>
      <div style={{ flexBasis: "100%" }} />
      <span className="meta">
        <span className={`dot ${connection === "live" ? "" : "dotOff"}`} />
        {parts.join(" · ")}
      </span>
    </header>
  );
}
