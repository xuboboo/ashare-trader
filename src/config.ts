const env = (key: string, fallback?: string) => process.env[key] || fallback;
const num = (key: string, fallback: number) => {
  const v = env(key);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key: string, fallback = false) => (env(key) ? env(key) === "true" : fallback);
/** "HH:MM" -> 当日分钟数 */
export const hhmm = (s: string, fallback: number): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

/** Jev 模型 id 约定形如 jev-latest；环境变量里手滑写重前缀（jev-jev-…）时收敛成一个 */
export const collapseJevPrefix = (id: string): string => id.trim().replace(/^(?:jev-)+/, "jev-");

export const config = {
  /** 行情源 */
  universeSize: num("UNIVERSE_SIZE", 300),
  watchlist: (env("WATCHLIST", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pollMs: num("POLL_MS", 3000),
  /** 行情老化到多少秒就不再相信它（L1 本身 3s 一个切片，30s 意味着源真的断了）。 */
  quoteStaleSec: num("QUOTE_STALE_SEC", 30),
  /** true = 只用日频（盘前一次出信号）。实时链路连续故障时引擎会自动置为 true。 */
  eodOnly: bool("EOD_ONLY"),

  /** 账簿与风控 */
  paper: bool("PAPER", true),
  bankrollCny: num("CNY_BANKROLL", 150_000),
  sizeCny: num("SIZE_CNY", 50_000),
  k: num("K", 3),
  maxDailyOpens: num("MAX_DAILY_OPENS", 4),
  stopLossPct: num("STOP_LOSS_PCT", 3),
  /** 日亏损闸：当日亏损（相对日初权益）达到此百分比停止开仓，次日自动恢复；0 = 关闭 */
  maxDayLossPct: num("MAX_DAY_LOSS_PCT", 3),
  /** 回撤闸：权益自峰值回撤达到此百分比停止开仓，创新高后自动恢复；0 = 关闭 */
  maxDrawdownPct: num("MAX_DRAWDOWN_PCT", 10),
  gapTrimPct: num("GAP_TRIM_PCT", 3),
  /** 次日无条件清仓 */
  forceExitMin: hhmm(env("FORCE_EXIT_AT", "10:00")!, 600),

  /** 成本：全部双边/单边含义见 costs.ts，注释里的费率是 2026 年 A 股普通股默认档 */
  commissionRate: num("COMMISSION_RATE", 0.00025),
  commissionMin: num("COMMISSION_MIN", 5),
  stampTaxRate: num("STAMP_TAX_RATE", 0.0005), // 卖出单边
  transferFeeRate: num("TRANSFER_FEE_RATE", 0.00001), // 双边
  exchangeFeeRate: num("EXCHANGE_FEE_RATE", 0.000068), // 经手+证管，双边近似
  slippageTicks: num("SLIPPAGE_TICKS", 1),

  /** 选股因子 */
  gainMinPct: num("GAIN_MIN_PCT", 3),
  gainMaxPct: num("GAIN_MAX_PCT", 7),
  volumeRatioMin: num("VOLUME_RATIO_MIN", 1.5),
  minAmountYi: num("MIN_AMOUNT_YI", 2),
  minMcapYi: num("MIN_MCAP_YI", 60),
  minListDays: num("MIN_LIST_DAYS", 60),
  indexMinAmountYi: num("INDEX_MIN_AMOUNT_YI", 3000),

  /** 决策模型：factor = 规则打分（默认）；local = 本地概率模型（scripts/train-model.ts 训练）；jev = TypeSafe 远端 */
  model: env("MODEL", "factor") as "factor" | "local" | "jev",
  /** TypeSafe 的 System One 模型 Jev：不生成文本，输入 state + 问题，返回带概率的结构化判断 */
  typesafeApiKey: env("TYPESAFE_AI_API_KEY"),
  typesafeBaseUrl: env("TYPESAFE_BASE_URL", "https://api.typesafe.ai/v1")!,
  jevModelId: collapseJevPrefix(env("JEV_MODEL_ID", "jev-latest")!),
  /** 只采纳概率高于此值的候选；太低就是拿模型当噪声放大器 */
  jevMinProb: num("JEV_MIN_PROB", 0.55),
  /** 一次请求问几只（所有问题共享同一 state，并行判定，多问几乎不增加延迟） */
  jevMaxQuestions: num("JEV_MAX_QUESTIONS", 20),
  jevTimeoutMs: num("JEV_TIMEOUT_MS", 15_000),
  /** 买入决策节奏（毫秒）：连续竞价时段每隔这么久做一次买入决策。
   *  行情每 3s 一轮，但模型不必每轮都问；退出管理是纯规则，每轮都跑、不花模型。 */
  decideEveryMs: num("DECIDE_EVERY_MS", 60_000),
  /** LlmAdvisory（盘前情绪 + 个股事件 veto）用的通用 chat 模型，与 Jev 是两个东西 */
  llmBaseUrl: env("LLM_BASE_URL", "https://api.deepseek.com")!,
  llmModel: env("LLM_MODEL", "deepseek-chat")!,
  llmApiKey: env("LLM_API_KEY"),
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 20_000),
  port: num("PORT", 3005),
  historySize: 1000,
  dataDir: env("DATA_DIR", "data")!,

  /** 券商通道（QMT sidecar）。默认指向本机；sidecar 决定 mock/dry/live，本进程绝不自动下单。 */
  qmtSidecarUrl: env("QMT_SIDECAR_URL", "http://127.0.0.1:3011")!,
  qmtToken: env("QMT_TOKEN", "")!,

  /** 时段（Asia/Shanghai 本地分钟数） */
  session: {
    callAuctionStart: hhmm("09:15", 555),
    callAuctionEnd: hhmm("09:25", 565),
    noCancelStart: hhmm("09:25", 565),
    noCancelEnd: hhmm("09:30", 570),
    morningStart: hhmm("09:30", 570),
    morningEnd: hhmm("11:30", 690),
    afternoonStart: hhmm("13:00", 780),
    afternoonEnd: hhmm("14:57", 897),
    closeAuctionEnd: hhmm("15:00", 900),
    /** 尾盘选股窗口起点 */
    tailStart: hhmm(env("TAIL_START", "14:40")!, 880),
    premarketMin: hhmm(env("PREMARKET_AT", "09:05")!, 545),
  },
};

export type Config = typeof config;
