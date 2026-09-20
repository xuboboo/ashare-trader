import { describe, expect, test } from "bun:test";
import { qmtCode, QmtBroker } from "../src/brokers/qmt";

describe("QMT 适配层", () => {
  test("代码映射：沪深加后缀，北交所直接拒绝", () => {
    expect(qmtCode("600000")).toBe("600000.SH");
    expect(qmtCode("002156")).toBe("002156.SZ");
    expect(qmtCode("300475")).toBe("300475.SZ");
    expect(() => qmtCode("830799")).toThrow("不在本系统交易范围");
  });

  test("本地兜底校验：非法单不发网络请求", async () => {
    const b = new QmtBroker({ baseUrl: "http://127.0.0.1:9" });
    expect((await b.submit({ signalId: "S1", code: "60000", side: "buy", price: 10, qty: 100 })).error).toContain("6 位");
    expect((await b.submit({ signalId: "S1", code: "600000", side: "hold" as "buy", price: 10, qty: 100 })).error).toContain("buy/sell");
    expect((await b.submit({ signalId: "S1", code: "600000", side: "buy", price: 0, qty: 100 })).error).toContain("为正");
    expect((await b.submit({ signalId: "S1", code: "600000", side: "buy", price: 10, qty: 150 })).error).toContain("100 的正整数倍");
  });

  test("sidecar 在线：status 与 submit 走通，鉴权头与代码映射正确", async () => {
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenAuth = req.headers.get("x-auth") ?? "";
        if (new URL(req.url).pathname === "/order") {
          seenBody = (await req.json()) as Record<string, unknown>;
          return Response.json({ accepted: true, mode: "dry", brokerOrderId: "DRY-123" });
        }
        return Response.json({ mode: "dry", xtquant: false, connected: false, account: null });
      },
    });
    const b = new QmtBroker({ baseUrl: `http://127.0.0.1:${server.port}`, token: "tok", timeoutMs: 1000 });
    const st = await b.status();
    expect(st.reachable).toBe(true);
    expect(st.mode).toBe("dry");
    expect(seenAuth).toBe("tok");
    const ack = await b.submit({ signalId: "S20260921-0001", code: "600000", side: "buy", price: 10.5, qty: 300 });
    expect(ack.accepted).toBe(true);
    expect(ack.mode).toBe("dry");
    expect(ack.brokerOrderId).toBe("DRY-123");
    expect(seenBody).toMatchObject({ code: "600000.SH", side: "buy", price: 10.5, qty: 300, signalId: "S20260921-0001" });
    server.stop(true);
  });

  test("sidecar 不在线：reachable=false、submit 报错而不是抛异常", async () => {
    const b = new QmtBroker({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 });
    const st = await b.status();
    expect(st.reachable).toBe(false);
    const ack = await b.submit({ signalId: "S1", code: "600000", side: "buy", price: 10, qty: 100 });
    expect(ack.accepted).toBe(false);
    expect(ack.error).toBeTruthy();
  });

  test("sidecar 拒绝（超限等）：透传 error", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({ accepted: false, mode: "dry", error: "单笔 30000 元超过上限 20000 元" }, { status: 400 });
      },
    });
    const b = new QmtBroker({ baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 1000 });
    const ack = await b.submit({ signalId: "S1", code: "600000", side: "buy", price: 30, qty: 1000 });
    expect(ack.accepted).toBe(false);
    expect(ack.error).toContain("上限");
    server.stop(true);
  });
});
