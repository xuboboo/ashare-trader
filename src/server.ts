/**
 * Bun.serve：GET / 快照、GET /history、GET /positions、GET /fills、GET /events(SSE)，
 * 以及几个"人来操作"的写接口：POST /scan（立即选股）、POST /fill（回填真实成交）、
 * POST /fill/remove（撤销一笔误回填）、POST /reset（清空账本，需显式 confirm）。
 * 没有任何路径会向券商下真实委托。
 */
import { config } from "./config";
import { QmtBroker } from "./brokers/qmt";
import type { Engine, TickEvent } from "./engine";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export function startServer(engine: Engine) {
  const qmt = new QmtBroker();
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
      const url = new URL(req.url);
      const { pathname } = url;
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/" && req.method === "GET") return json(meta());
      if (pathname === "/history" && req.method === "GET") return json(engine.getHistory());
      if (pathname === "/positions" && req.method === "GET")
        return json({ positions: engine.positionView(), totals: engine.book.totals(), pending: engine.pendingOrders });
      if (pathname === "/orders" && req.method === "GET") return json(engine.pendingOrders);
      // 券商通道：只有人在浏览器/命令行显式触发才会推送 sidecar；引擎循环里没有任何调用点
      if (pathname === "/broker" && req.method === "GET")
        return json({ sidecarUrl: config.qmtSidecarUrl, ...(await qmt.status()) });
      if (pathname === "/broker/order" && req.method === "POST") {
        const body = ((await req.json().catch(() => null)) ?? {}) as { signalId?: string; confirm?: string };
        if (body.confirm !== "SUBMIT") return json({ error: '需要 body {"signalId":"...","confirm":"SUBMIT"}；这是真实委托方向的开关' }, 400);
        const o = engine.pendingOrders.find((x) => x.signalId === body.signalId);
        if (!o) return json({ error: `找不到在途建议单 ${body.signalId}` }, 404);
        if (o.side !== "buy" && o.side !== "sell") return json({ error: "订单方向异常" }, 400);
        // 用最新快照价（钳在建议限价带内），避免人工确认的间隔里价格走远后拿旧参考价挂单
        const fresh = engine.latestSnapshot(o.code);
        const rawPrice = fresh && fresh.price > 0 ? fresh.price : o.priceRef;
        const price = Math.min(Math.max(rawPrice, o.limitLow), o.limitHigh);
        const ack = await qmt.submit({
          signalId: o.signalId,
          code: o.code,
          side: o.side,
          price,
          qty: o.qty,
          remark: `ashare-trader ${o.date} ${o.time}`,
        });
        return json({ ok: ack.accepted, ack, order: { signalId: o.signalId, code: o.code, side: o.side, price, qty: o.qty } });
      }
      if (pathname === "/fills" && req.method === "GET")
        return json({ fills: engine.fillLog(Number(url.searchParams.get("n")) || 50), totals: engine.book.totals() });
      // 权益曲线（每个交易日一个点，落盘在 positions.json）：面板的"一周盈亏"视图用
      if (pathname === "/equity" && req.method === "GET")
        return json({ points: engine.book.equityCurve, totals: engine.book.totals() });

      if (pathname === "/scan" && req.method === "POST") {
        const e = await engine.round("force-scan");
        // model + decision 一并返回：用的是哪个模型、有没有降级（modelFailed），
        // 这类信息不能只活在 SSE 里，否则命令行看不到
        return json({
          ok: true,
          model: engine.meta().model,
          seq: e.seq,
          orders: e.orders,
          gate: e.gate,
          scan: e.scan,
          decision: e.decision,
          quotes: e.quotes,
        });
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

      if (pathname === "/fill/remove" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return json({ error: "body 必须是 JSON" }, 400);
        }
        const id = String(body?.id ?? "").trim();
        if (!id) return json({ error: "id 必填（成交流水里的 id）" }, 400);
        const removed = await engine.removeFill(id);
        if (!removed) return json({ error: `找不到成交 ${id}` }, 404);
        return json({ ok: true, removed, totals: engine.book.totals(), positions: engine.positionView() });
      }

      if (pathname === "/reset" && req.method === "POST") {
        const body = ((await req.json().catch(() => null)) ?? {}) as { confirm?: string };
        // 清账本是破坏性操作：必须显式带 confirm，不能一个 curl 误伤
        if (body.confirm !== "CLEAR") return json({ error: '需要 body {"confirm":"CLEAR"}' }, 400);
        const { removed, archived } = await engine.clearBook();
        return json({ ok: true, removed, archived, totals: engine.book.totals() });
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
