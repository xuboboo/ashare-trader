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
  /** 决策来源：哪个脑子下的这单（与后端 state.ts DecisionSource 同表） */
  decidedBy?: "jev" | "factor" | "local" | "hard-rule" | "manual" | "unknown";
  /** 驱动这笔的模型概率 */
  decisionProb?: number;
  signalId?: string;
  realizedPnl?: number;
  /** 卖出成交那一刻的成本价快照（盈亏比例的分母口径） */
  costAvg?: number;
  /** 实现盈亏 / 成本市值 ×100（A 股 App 的"盈亏比例"口径，已扣费） */
  realizedPnlPct?: number;
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
  /** STOP_MODE=atr 时记录的"假如 fixed 3%"反事实止损价 */
  stopFixedAlt?: number | null;
  mustExitAt: string | null;
  amountCny: number;
  costCny: number;
  costBps: number;
  warn: string | null;
  reason: string;
  /** 这张在途单由哪个决策源下达（jev/factor/local/hard-rule/manual）；旧记录无此字段 */
  decidedBy?: "jev" | "factor" | "local" | "hard-rule" | "manual" | "unknown";
  /** 驱动这张单的模型概率 */
  decisionProb?: number;
  rejectReason: string | null;
  score: number;
  status: OrderStatus;
  fill: Fill | null;
  /** 挂单生效后的现价区间（纸面撮合只能看这个，不能看全天累计极值） */
  seenLow: number;
  seenHigh: number;
  restingSince: number;
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  /** probabilities 的语义：rank-share = 排序占比（不是概率！）；calibrated/model-prompt 才是概率 */
  probabilitySemantics?: "rank-share" | "calibrated" | "model-prompt";
  picks: { code: string; name: string; probability: number; score: number; reasons: string[] }[];
  latencyMs: number;
  late: boolean;
  inputTokens: number;
  modelFailed: boolean;
  trace?: {
    source: "jev" | "factor" | "local" | "hard-rule";
    model: string;
    call: "remote" | "cache" | "none";
    status: "ok" | "skipped-hard-rule" | "not-configured" | "failed" | "invalid-response";
    requestKey?: string;
    answerCount?: number;
    inputTokens?: number;
    reason?: string;
  };
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
  /** 券商 App 口径当日盈亏：今日权益 − 昨收定格的日初权益（含持仓浮动变动） */
  dayPnlCny: number;
  dayPnlPct: number;
  /** 今日卖出成交已实现的盈亏合计（已扣费） */
  todayRealized: number;
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
  gate: { allowed: boolean; reasons: string[]; status?: "open" | "closed" | "idle"; skipped?: string[] };
  bias: {
    emotionScore: number;
    allowOpen: boolean;
    reason: string;
    vetoes: number;
    llmFailed: boolean;
    enabled: boolean;
  } | null;
  universe: number;
  quotes: { ok: number; fails: number; stale: boolean; eodOnly: boolean; quoteDay: string; ageSec: number };
  scan: {
    scored: number;
    rejected: number;
    top: {
      code: string;
      name: string;
      score: number;
      /** 现价：与因子分同屏两套数字，必须各有名字，别再混 */
      price: number;
      gainPct: number;
      volumeRatio: number;
      priceVsVwapBps: number;
      reasons: string[];
    }[];
  };
  decision: Decision | null;
  decisions?: { buy?: Decision; sell?: Decision };
  /** 组合级风控闸（日亏损/回撤），只在调用过 decide 的轮次有值 */
  risk: {
    buyBlocked: boolean;
    reasons: string[];
    dayPnlCny: number;
    dayLossLimitCny: number;
    drawdownPct: number;
    drawdownLimitPct: number;
  } | null;
  orders: SuggestedOrder[];
  fills: Fill[];
  positions: PositionView[];
  totals: Totals;
  note?: string;
}

export interface Meta {
  name: string;
  model: string;
  modelTransport?: string;
  llm: string;
  paper: boolean;
  universe: number;
  universeDate: string;
  calendarStale: boolean;
  eodOnly: boolean;
  startedAt: number;
  port: number;
  /** 决策口径（面板"常设命令"卡用）；旧后端没有这些字段时面板走回退文案 */
  decideEveryMs?: number;
  bankrollCny?: number;
  sizeCny?: number;
  minProb?: number;
  stopLabel?: string;
  maxPositions?: number;
  entryRule?: string;
  openWindow?: string;
}

/** /equity 的权益曲线点（每个交易日一个） */
export interface EquityPoint {
  date: string;
  equity: number;
  marketValue: number;
  cash: number;
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

/** /broker 的 QMT sidecar 状态 */
export interface BrokerStatus {
  reachable: boolean;
  mode: "mock" | "dry" | "live" | null;
  xtquant: boolean;
  connected: boolean;
  account: string | null;
  error?: string;
}

export interface FeedState {
  meta: Meta | null;
  events: TickEvent[];
  latest: TickEvent | null;
  connection: ConnectionState;
  avgLatencyMs: number;
}
