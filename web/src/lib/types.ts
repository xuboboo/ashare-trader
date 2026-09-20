export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
export type Phase =
  | "closed"
  | "pre-open"
  | "call-auction"
  | "no-cancel"
  | "continuous"
  | "lunch"
  | "close-auction"
  | "after-hours";

export type OrderStatus = "pending" | "filled" | "expired" | "cancelled" | "rejected";

export interface Costs {
  commission: number;
  stampTax: number;
  transferFee: number;
  exchangeFee: number;
  total: number;
}

export interface Fill {
  id: string;
  ts: number;
  date: string;
  time: string;
  code: string;
  name: string;
  side: Side;
  price: number;
  qty: number;
  amount: number;
  costs: Costs;
  kind: "paper" | "manual";
  signalId?: string;
  realizedPnl?: number;
  slippageBps?: number;
  note?: string;
}

export interface SuggestedOrder {
  signalId: string;
  date: string;
  time: string;
  code: string;
  name: string;
  side: Side;
  qty: number;
  priceRef: number;
  limitLow: number;
  limitHigh: number;
  stopPrice: number | null;
  mustExitAt: string | null;
  amountCny: number;
  costCny: number;
  costBps: number;
  warn: string | null;
  reason: string;
  rejectReason: string | null;
  score: number;
  status: OrderStatus;
  fill: Fill | null;
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  picks: { code: string; name: string; probability: number; score: number; reasons: string[] }[];
  latencyMs: number;
  late: boolean;
  inputTokens: number;
  modelFailed: boolean;
}

export interface PositionView {
  code: string;
  name: string;
  qty: number;
  sellable: number;
  frozen: number;
  avgPrice: number;
  lastPrice: number;
  stopPrice: number;
  openDate: string;
  unrealized: number;
  unrealizedPct: number;
}

export interface Totals {
  positions: number;
  cash: number;
  initialCash: number;
  marketValue: number;
  unrealized: number;
  realized: number;
  equity: number;
  pnlCny: number;
  pnlPct: number;
  exposurePct: number;
  fills: number;
}

export interface TickEvent {
  seq: number;
  ts: number;
  date: string;
  time: string;
  phase: Phase;
  tradingDay: boolean;
  trigger: string;
  index: { price: number; pct: number; amountYi: number; ma5: number | null };
  gate: { allowed: boolean; reasons: string[] };
  bias: {
    emotionScore: number;
    allowOpen: boolean;
    reason: string;
    vetoes: number;
    llmFailed: boolean;
    enabled: boolean;
  } | null;
  universe: number;
  quotes: { ok: number; fails: number; stale: boolean; eodOnly: boolean; quoteDay: string };
  scan: {
    scored: number;
    rejected: number;
    top: {
      code: string;
      name: string;
      score: number;
      gainPct: number;
      volumeRatio: number;
      priceVsVwapBps: number;
      reasons: string[];
    }[];
  };
  decision: Decision | null;
  orders: SuggestedOrder[];
  fills: Fill[];
  positions: PositionView[];
  totals: Totals;
  note?: string;
}

export interface Meta {
  name: string;
  model: string;
  llm: string;
  paper: boolean;
  universe: number;
  universeDate: string;
  calendarStale: boolean;
  eodOnly: boolean;
  startedAt: number;
  port: number;
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface FeedState {
  meta: Meta | null;
  events: TickEvent[];
  latest: TickEvent | null;
  connection: ConnectionState;
  avgLatencyMs: number;
}
