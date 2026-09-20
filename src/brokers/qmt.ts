/**
 * QMT/miniQMT 券商通道适配层 —— 与本地 sidecar（brokers/qmt-sidecar/qmt_bridge.py）通信的客户端。
 *
 * 职责边界（与 docs/COMPLIANCE.md 一致）：
 *  - 本适配层只跟 127.0.0.1 上的 sidecar 说话，绝不直接连券商；
 *  - 是否真的下委托由 sidecar 的模式决定（mock / dry / live），本层如实透传并在状态里带回；
 *  - 引擎不会自动调用这里 —— 只有人通过 POST /broker/order 显式触发，且 body 里必须带 confirm。
 *
 * 代码映射：A 股 6 位代码 → QMT 的 code.SUFFIX（6 开头 .SH，其余在范围内 .SZ）。
 */
import { config } from "../config";
import { exchange } from "../symbols";

export type SidecarMode = "mock" | "dry" | "live";

export interface BrokerStatus {
  reachable: boolean;
  mode: SidecarMode | null;
  xtquant: boolean;
  connected: boolean;
  account: string | null;
  error?: string;
}

export interface BrokerOrderRequest {
  signalId: string;
  code: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  remark?: string;
}

export interface BrokerOrderAck {
  accepted: boolean;
  mode: SidecarMode | null;
  brokerOrderId: string | null;
  error?: string;
}

/** QMT 代码格式：600000 → 600000.SH。范围外前缀不属于本项目交易范围，直接拒绝。 */
export function qmtCode(code: string): string {
  const ex = exchange(code);
  if (ex === "bj") throw new Error(`北交所代码 ${code} 不在本系统交易范围`);
  return `${code}.${ex.toUpperCase()}`;
}

export class QmtBroker {
  constructor(
    private opts: { baseUrl?: string; token?: string; timeoutMs?: number } = {},
  ) {}

  private get baseUrl(): string {
    const raw = (this.opts.baseUrl ?? config.qmtSidecarUrl).replace(/\/+$/, "");
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("QMT_SIDECAR_URL 只允许 http/https");
    return raw;
  }

  async status(): Promise<BrokerStatus> {
    try {
      const r = await fetch(`${this.baseUrl}/status`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
      });
      if (!r.ok) return { reachable: false, mode: null, xtquant: false, connected: false, account: null, error: `HTTP ${r.status}` };
      const j = (await r.json()) as Record<string, unknown>;
      return {
        reachable: true,
        mode: (j.mode as SidecarMode) ?? null,
        xtquant: Boolean(j.xtquant),
        connected: Boolean(j.connected),
        account: typeof j.account === "string" ? j.account : null,
      };
    } catch (e) {
      return { reachable: false, mode: null, xtquant: false, connected: false, account: null, error: (e as Error).message };
    }
  }

  async submit(req: BrokerOrderRequest): Promise<BrokerOrderAck> {
    // 本地兜底校验（sidecar 还会再验一次，两边不互信）
    if (!/^\d{6}$/.test(req.code)) return { accepted: false, mode: null, brokerOrderId: null, error: "code 需要 6 位数字" };
    if (req.side !== "buy" && req.side !== "sell") return { accepted: false, mode: null, brokerOrderId: null, error: "side 只能是 buy/sell" };
    if (!(req.price > 0)) return { accepted: false, mode: null, brokerOrderId: null, error: "price 必须为正" };
    if (req.qty <= 0 || req.qty % 100 !== 0) return { accepted: false, mode: null, brokerOrderId: null, error: "qty 必须是 100 的正整数倍" };
    try {
      const r = await fetch(`${this.baseUrl}/order`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          signalId: req.signalId,
          code: qmtCode(req.code),
          side: req.side,
          price: req.price,
          qty: req.qty,
          remark: req.remark ?? "",
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        return { accepted: false, mode: (j.mode as SidecarMode) ?? null, brokerOrderId: null, error: String(j.error ?? `HTTP ${r.status}`) };
      }
      return {
        accepted: Boolean(j.accepted),
        mode: (j.mode as SidecarMode) ?? null,
        brokerOrderId: typeof j.brokerOrderId === "string" ? j.brokerOrderId : null,
      };
    } catch (e) {
      return { accepted: false, mode: null, brokerOrderId: null, error: (e as Error).message };
    }
  }

  private headers(base: Record<string, string> = {}): Record<string, string> {
    const token = this.opts.token ?? config.qmtToken;
    return token ? { ...base, "x-auth": token } : { ...base };
  }
}
