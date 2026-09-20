"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import type { ConnectionState, FeedState, Fill, Meta, PositionView, TickEvent, Totals } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005").replace(/\/+$/, "");

const CAP = 1000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
/** 服务端每 15s 一次 ping；超过这个时间没动静就判定掉线并重连。 */
const STALE_MS = 45_000;

type Action =
  | { type: "snapshot"; meta: Meta | null; events: TickEvent[] }
  | { type: "tick"; event: TickEvent }
  | { type: "connection"; connection: ConnectionState };

const initialState: FeedState = {
  meta: null,
  events: [],
  latest: null,
  connection: "connecting",
  avgLatencyMs: 0,
};

function avgLatency(events: TickEvent[]): number {
  const last = events.slice(-50).filter((e) => e.decision && e.decision.latencyMs > 0);
  if (!last.length) return 0;
  return last.reduce((s, e) => s + (e.decision?.latencyMs ?? 0), 0) / last.length;
}

function reducer(state: FeedState, action: Action): FeedState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.connection };
    case "snapshot": {
      // 服务端历史可能因为重复上报出现同 seq，先按 seq 去重（保留最后一条），
      // 否则 React 会拿到重复 key
      const seen = new Map<number, TickEvent>();
      for (const e of action.events) if (e && typeof e.seq === "number") seen.set(e.seq, e);
      const events = [...seen.values()].slice(-CAP);
      return {
        meta: action.meta,
        events,
        latest: events.at(-1) ?? null,
        connection: "live",
        avgLatencyMs: avgLatency(events),
      };
    }
    case "tick": {
      const e = action.event;
      if (!e || typeof e.seq !== "number") return state;
      let events = state.events;
      const idx = events.findIndex((x) => x.seq === e.seq);
      if (idx >= 0) events = events.slice(0, idx).concat(e, events.slice(idx + 1));
      else {
        events = events.length >= CAP ? events.slice(events.length - CAP + 1).concat(e) : events.concat(e);
      }
      return { ...state, events, latest: e, avgLatencyMs: avgLatency(events) };
    }
    default:
      return state;
  }
}

function parseMeta(raw: Record<string, unknown>): Meta | null {
  if (typeof raw?.model !== "string") return null;
  return {
    name: typeof raw.name === "string" ? raw.name : "ashare-trader",
    model: raw.model,
    llm: typeof raw.llm === "string" ? raw.llm : "off",
    paper: raw.paper !== false,
    universe: Number(raw.universe) || 0,
    universeDate: typeof raw.universeDate === "string" ? raw.universeDate : "",
    calendarStale: Boolean(raw.calendarStale),
    eodOnly: Boolean(raw.eodOnly),
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
    port: Number(raw.port) || 3005,
  };
}

/**
 * SSE 心跳流：连 `${API_URL}/events`，处理 `snapshot` / `tick` / `ping`。
 * 1s→10s 指数退避重连，45s 无消息主动重连，connection 状态给顶部指示灯。
 */
export function useFeed(apiUrl: string = API_URL): FeedState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };

    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStaleTimer();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        try {
          fn(JSON.parse(payload));
        } catch {
          /* 忽略坏帧 */
        }
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${apiUrl}/events`);
      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStaleTimer();
      };
      es.onerror = () => {
        if (!closed) scheduleReconnect();
      };
      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        dispatch({
          type: "snapshot",
          meta: parseMeta(d),
          events: Array.isArray(d.history) ? (d.history as TickEvent[]) : [],
        });
      });
      handle("tick", (data) => dispatch({ type: "tick", event: data as TickEvent }));
      handle("ping", () => dispatch({ type: "connection", connection: "live" }));
    }

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [apiUrl]);

  return state;
}

/** 写接口的一层薄封装：手动回填成交、强制扫描一次。 */
export function useApi() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, body?: unknown, method: "POST" | "GET" = "POST"): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch(`${API_URL}${path}`, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(String((j as { error?: string })?.error ?? `HTTP ${r.status}`));
        return j as T;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return {
    busy,
    error,
    clearError: () => setError(null),
    scan: () => call<TickEvent>("/scan"),
    fill: (body: { code: string; side: string; qty: number; price?: number; signalId?: string; note?: string }) =>
      call<{ ok: true; fill: Fill; totals: Totals }>("/fill", body),
    removeFill: (id: string) =>
      call<{ ok: true; removed: Fill; totals: Totals }>("/fill/remove", { id }),
    resetBook: () => call<{ ok: true; removed: number; archived: string | null }>("/reset", { confirm: "CLEAR" }),
    fills: () => call<{ fills: Fill[]; totals: Totals }>("/fills", undefined, "GET"),
    positions: () => call<{ positions: PositionView[]; totals: Totals }>("/positions", undefined, "GET"),
  };
}

export default useFeed;
