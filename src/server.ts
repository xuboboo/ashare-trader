/**
 * Bun.serve：GET / 快照、GET /history、GET /positions、GET /events(SSE)，
 * 以及两个"人来操作"的写接口：POST /scan（立刻跑一次选股）、POST /fill（回填真实成交）。
 * 没有任何路径会向券商下单，写接口只改本地账本。
 */
import { config } from "./config";
import type { Engine, TickEvent } from "./engine";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export function startServer(engine: Engine) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try {
      c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      clients.delete(c);
    }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000).unref?.();

  const meta = () => ({ ...engine.meta(), totals: engine.book.totals(), latest: engine.getHistory().at(-1) ?? null });

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/" && req.method === "GET") return json(meta());
      if (pathname === "/history" && req.method === "GET") return json(engine.getHistory());
      if (pathname === "/positions" && req.method === "GET")
        return json({ positions: engine.positionView(), totals: engine.book.totals(), pending: engine.pendingOrders });
      if (pathname === "/orders" && req.method === "GET") return json(engine.pendingOrders);

      if (pathname === "/scan" && req.method === "POST") {
        const e = await engine.round("force-scan");
        return json({ ok: true, seq: e.seq, orders: e.orders, gate: e.gate, scan: e.scan });
      }

      if (pathname === "/fill" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return json({ error: "body 必须是 JSON" }, 400);
        }
        const code = String(body?.code ?? "").trim();
        const side = String(body?.side ?? "").trim();
        const qty = Number(body?.qty);
        const price = body?.price === undefined || body?.price === null || body?.price === "" ? undefined : Number(body.price);
        if (!/^\d{6}$/.test(code)) return json({ error: "code 需要 6 位数字" }, 400);
        if (side !== "buy" && side !== "sell") return json({ error: "side 只能是 buy / sell" }, 400);
        if (!Number.isFinite(qty) || qty <= 0) return json({ error: "qty 需要正数" }, 400);
        if (price !== undefined && !Number.isFinite(price)) return json({ error: "price 不是数字" }, 400);
        try {
          const fill = await engine.recordManualFill({
            code,
            side,
            qty: Math.round(qty),
            price,
            signalId: body?.signalId ? String(body.signalId) : undefined,
            note: body?.note ? String(body.note) : "仪表盘回填",
          });
          return json({ ok: true, fill, totals: engine.book.totals() });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }

      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            clients.add(c);
            send(c, "snapshot", { ...engine.meta(), history: engine.getHistory().slice(-200) });
          },
          cancel(c) {
            clients.delete(c);
          },
        });
        return new Response(stream, {
          headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }
      return json({ error: "not found" }, 404);
    },
  });

  engine.subscribe((e: TickEvent) => clients.forEach((c) => send(c, "tick", e)));
  return server;
}
