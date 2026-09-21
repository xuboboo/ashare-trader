/**
 * 因子层。回测与实盘必须共用这一份打分，否则回测再漂亮也没用。
 *
 * 关键是 StockFeatures：它只包含"日线和快照都能算出来"的字段，
 * 所以同一天的数据喂给两边必然得到同样的建议单（test/consistency.test.ts 会证明这一点）。
 * 只有情绪类 booster（行业涨停家数、主力净流入）在日线上不可得，默认关闭。
 */
import { config } from "./config";
import { tradingMinutesTotal } from "./session";
import type { DailyBar, Snapshot } from "./quotes";
import { limitDown as calcLimitDown, limitUp as calcLimitUp } from "./symbols";

export interface StockFeatures {
  code: string;
  name: string;
  date: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  /** 当日涨跌幅 % */
  gainPct: number;
  /** 量比：当日量 / 过去 5 日均量（快照直接给，回测自己算） */
  volumeRatio: number;
  /** 分时均价 VWAP */
  vwap: number;
  /** (price/vwap - 1) * 1e4 */
  priceVsVwapBps: number;
  amountYuan: number;
  mcapYi: number;
  floatMcapYi: number;
  turnoverPct: number;
  limitUp: number;
  limitDown: number;
  oneLineUp: boolean;
  oneLineDown: boolean;
  suspended: boolean;
}

export interface Boosters {
  /** 所属行业当日涨停家数 */
  industryZtCount?: number;
  /** 主力净流入（元） */
  mainNetFlowYuan?: number;
}

export interface Scored {
  features: StockFeatures;
  score: number;
  /** 通过项，人话 */
  reasons: string[];
  /** 否决项，非空即不可买 */
  rejects: string[];
}

/** 权重可在 .env 用 FACTOR_WEIGHTS 覆盖（JSON）。 */
export const WEIGHTS = {
  gain: 1.0, // 涨幅落在区间中段的程度
  volumeRatio: 0.8,
  vwapDev: 0.6,
  turnover: 0.4,
  liquidity: 0.3,
  industryZt: 0.5, // booster，默认不参与
  mainFlow: 0.4, // booster，默认不参与
};

/** 阈值参数：默认从 config 取，回测做参数扫描时逐组传入，不改全局。 */
export interface FactorParams {
  gainMinPct: number;
  gainMaxPct: number;
  volumeRatioMin: number;
  minAmountYi: number;
  minMcapYi: number;
  /** 开盘以来经过的分钟数（连续竞价），用于按节奏折算成交额门槛；不传 = 用全天阈值 */
  sessionElapsedMin?: number;
}

export const defaultFactorParams = (): FactorParams => ({
  gainMinPct: config.gainMinPct,
  gainMaxPct: config.gainMaxPct,
  volumeRatioMin: config.volumeRatioMin,
  minAmountYi: config.minAmountYi,
  minMcapYi: config.minMcapYi,
});

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreStock(
  f: StockFeatures,
  b: Boosters = {},
  useBoosters = false,
  p: FactorParams = defaultFactorParams(),
): Scored {
  const rejects: string[] = [];
  const reasons: string[] = [];

  if (f.suspended) rejects.push("停牌");
  if (f.oneLineUp) rejects.push("一字涨停买不进");
  if (f.price >= f.limitUp) rejects.push("已封涨停");
  if (f.gainPct < p.gainMinPct) rejects.push(`涨幅 ${f.gainPct.toFixed(2)}% 低于 ${p.gainMinPct}%`);
  if (f.gainPct > p.gainMaxPct) rejects.push(`涨幅 ${f.gainPct.toFixed(2)}% 超 ${p.gainMaxPct}%（追高）`);
  // 成交额门槛按开盘时长折算（240 分钟 = 全天基准），早盘不因累计量不够而误杀
  const amountThreshold = p.sessionElapsedMin != null && p.sessionElapsedMin > 0
    ? Math.max(p.minAmountYi * 1e8 * Math.min(1, p.sessionElapsedMin / 240), 2_000_000) // 最低 200 万
    : p.minAmountYi * 1e8;
  if (f.amountYuan < amountThreshold)
    rejects.push(`成交额 ${(f.amountYuan / 1e8).toFixed(2)} 亿 < ${p.minAmountYi} 亿（盘中按节奏折算）`);
  if (f.mcapYi > 0 && f.mcapYi < p.minMcapYi) rejects.push(`总市值 ${f.mcapYi.toFixed(0)} 亿 < ${p.minMcapYi} 亿`);
  if (f.volumeRatio < p.volumeRatioMin) rejects.push(`量比 ${f.volumeRatio.toFixed(2)} < ${p.volumeRatioMin}`);
  if (f.priceVsVwapBps < 0) rejects.push(`跌破分时均线 ${f.priceVsVwapBps.toFixed(0)}bp`);

  // 涨幅落在区间中部的程度：越靠中间越安全（3% 起步、7% 封顶，最优在 ~5%）
  const lo = p.gainMinPct,
    hi = p.gainMaxPct,
    mid = (lo + hi) / 2;
  const gainScore = clamp01(1 - Math.abs(f.gainPct - mid) / Math.max(0.001, mid - lo));
  const vrScore = clamp01((f.volumeRatio - p.volumeRatioMin) / 3 + 0.5);
  const vwapScore = clamp01(f.priceVsVwapBps / 50);
  const turnoverScore = clamp01(f.turnoverPct / 10);
  const liqScore = clamp01(Math.log10(Math.max(1, f.amountYuan / 1e8)) / 2);

  if (gainScore > 0.5) reasons.push(`涨幅 ${f.gainPct.toFixed(2)}% 落在 ${lo}-${hi}% 强势区间`);
  if (f.open > 0 && f.prevClose > 0) {
    const openGap = ((f.open - f.prevClose) / f.prevClose) * 100;
    reasons.push(`开盘/竞价浮盈 ${openGap >= 0 ? "+" : ""}${openGap.toFixed(1)}%`);
  }
  if (vrScore > 0.5) reasons.push(`量比 ${f.volumeRatio.toFixed(2)} 放量`);
  if (vwapScore > 0) reasons.push(`站上分时均线 +${f.priceVsVwapBps.toFixed(0)}bp`);
  if (turnoverScore > 0.3) reasons.push(`换手 ${f.turnoverPct.toFixed(2)}% 活跃`);

  let score =
    WEIGHTS.gain * gainScore +
    WEIGHTS.volumeRatio * vrScore +
    WEIGHTS.vwapDev * vwapScore +
    WEIGHTS.turnover * turnoverScore +
    WEIGHTS.liquidity * liqScore;

  if (useBoosters) {
    const zt = clamp01((b.industryZtCount ?? 0) / 5);
    const flow = clamp01(((b.mainNetFlowYuan ?? 0) / 1e8 + 1) / 2);
    if (zt > 0.4) reasons.push(`同概念今日涨停 ${b.industryZtCount ?? 0} 家`);
    if (flow > 0.5) reasons.push(`主力净流入 ${((b.mainNetFlowYuan ?? 0) / 1e8).toFixed(2)} 亿`);
    score += WEIGHTS.industryZt * zt + WEIGHTS.mainFlow * flow;
  }

  return { features: f, score: rejects.length ? -1 : score, reasons, rejects };
}

export interface Gate {
  allowed: boolean;
  reasons: string[];
  /**
   * 这个结论有没有时效。闸门是"现在能不能买"的开关，它在盘外没有答案：
   *   open / closed —— 当前窗口内有效；
   *   idle —— 收盘后、非交易日或行情不新鲜，此时拿昨天（或盘前）的数据算出来的
   *   结论只能当复盘材料读，不能显示成"闸门开"骗人。
   * 可选是为了手造的用例（测试里的固定闸门）不必伪造这两个字段；
   * 读方（gateLabel / 面板）把缺失当作“按 allowed 说”，不会误报待命。
   */
  status?: "open" | "closed" | "idle";
  /** 本轮没能参与评估的否决项。静默跳过一个条件，比关掉系统更危险。 */
  skipped?: string[];
}

/** 情绪冰点：全天应有的涨停家数下限（盘中按已交易时长折算，见下） */
export const ZT_ICE_AGE = 20;

/** 闸门的可读状态：日志、面板、CLI 共用这一套措词，不要各处自己拼三元表达式。 */
export function gateLabel(g: Pick<Gate, "allowed" | "status"> & Partial<Gate>): string {
  if (g.status === "idle") return "待命";
  return g.allowed ? "开" : "关";
}

/**
 * 大盘闸门：指数在 5 日线上方 + 成交额节奏 + 情绪不差，否则强制空仓。
 *
 * sessionElapsedMin：**累计**交易分钟数（跨过午休不清零，见 session.tradingElapsedMin）。
 * 成交额与涨停家数都是"当日累计"量，早盘天然低 —— 阈值同步按已交易时长折算，
 * 检验的是节奏而不是绝对额；不传该参数即维持全天阈值（日频/盘前口径）。
 *
 * ctx.live=false 时结论只标记为 idle（不影响 allowed，盘前预选照用上一交易日数据），
 * 但面板与日志必须写“待命”而不是“开” —— 收盘后拿着全天成交额与昨日收盘位说“闸门开”，
 * 是对下一个交易日的无意义背书。
 */
export function marketGate(
  index: { price: number; amountYi: number },
  indexMa5: number | null,
  ztCount: number | null,
  sessionElapsedMin?: number | null,
  ctx: { live?: boolean } = {},
): Gate {
  const reasons: string[] = [];
  const skipped: string[] = [];
  let allowed = true;
  const total = tradingMinutesTotal();
  // 0 分钟（09:30 整）是合法值而不是“没传”：那时当日累计几乎只有集合竞价成交额，
  // 拿全天阈值去卡它就是把一个无意义的数当成否决。只有 null（盘前/日频口径）才用全天阈值。
  const paceRatio = sessionElapsedMin == null ? 1 : Math.min(1, Math.max(0, sessionElapsedMin) / total);

  if (indexMa5) {
    if (index.price < indexMa5) {
      allowed = false;
      reasons.push(`上证 ${index.price.toFixed(2)} 跌破 5 日线 ${indexMa5.toFixed(2)}`);
    }
  } else {
    skipped.push("5 日线缺失");
  }

  const amountThreshold = config.indexMinAmountYi * paceRatio;
  if (index.amountYi > 0) {
    if (index.amountYi < amountThreshold) {
      allowed = false;
      const scaled = sessionElapsedMin != null && paceRatio < 1 ? `（盘中 ${sessionElapsedMin} 分钟，阈值按节奏折算）` : "";
      reasons.push(`上证成交额 ${index.amountYi.toFixed(0)} 亿 < ${amountThreshold.toFixed(0)} 亿${scaled}`);
    }
  } else {
    skipped.push("指数成交额缺失");
  }

  /**
   * 涨停家数同样是当日累计量（一天里只会单调增多），阈值必须跟着节奏走。
   * 固定 20 家在 09:31 是几乎不可能达到的数 —— 那会把“今天能不能买”变成
   * “每天开盘后一小时不准买”，一个永久假阳性。现在：09:31 只要不是 0 家（真冰点）就过，
   * 尾盘 14:40 要求 19 家，跟原设计的盘中含义一致。
   */
  if (ztCount !== null) {
    const ztThreshold = Math.max(1, Math.ceil(ZT_ICE_AGE * paceRatio));
    if (ztCount < ztThreshold) {
      allowed = false;
      reasons.push(`涨停仅 ${ztCount} 家 < 此时应达 ${ztThreshold} 家，情绪冰点`);
    }
  } else {
    skipped.push(`涨停家数未采集（本项否决未生效，当前应达 ${Math.max(1, Math.ceil(ZT_ICE_AGE * paceRatio))} 家）`);
  }

  if (allowed) reasons.push(`上证 ${index.price.toFixed(2)} (${index.amountYi.toFixed(0)} 亿) 闸门通过`);
  const status: Gate["status"] = ctx.live === false ? "idle" : allowed ? "open" : "closed";
  if (status === "idle") reasons.push("非交易窗口（收盘/非交易日/行情不新鲜）：上面结论仅作复盘，不代表下一个交易日会开");
  return { allowed, reasons, status, skipped };
}

export function featuresFromSnapshot(s: Snapshot, date: string): StockFeatures {
  const gainPct = s.prevClose > 0 ? ((s.price - s.prevClose) / s.prevClose) * 100 : 0;
  const vwap = s.vwap || s.price;
  return {
    code: s.code,
    name: s.name,
    date,
    price: s.price,
    prevClose: s.prevClose,
    open: s.open,
    high: s.high,
    low: s.low,
    gainPct,
    volumeRatio: s.volumeRatio,
    vwap,
    priceVsVwapBps: vwap > 0 ? ((s.price - vwap) / vwap) * 10_000 : 0,
    amountYuan: s.amountYuan,
    mcapYi: s.mcapYi,
    floatMcapYi: s.floatMcapYi,
    turnoverPct: s.turnoverPct,
    limitUp: s.limitUp,
    limitDown: s.limitDown,
    oneLineUp: s.oneLineUp,
    oneLineDown: s.oneLineDown,
    suspended: s.suspended,
  };
}

/**
 * 回测口径：只有日线时，VWAP 用 成交额/成交量(手*100) 近似，量比用 当日量/前 5 日均量。
 * 高低价只能给出一字板/触及的粗判，止损与退出用次日 OHLC 判断。
 */
export function featuresFromDaily(
  bar: DailyBar,
  prevBar: DailyBar | undefined,
  avgVolume5Hands: number | undefined,
  name = "",
  code = "",
): StockFeatures {
  const prevClose = prevBar?.close ?? bar.open;
  const volumeYuanShares = bar.volumeHands * 100;
  const vwap = volumeYuanShares > 0 ? bar.amountYuan / volumeYuanShares : bar.close;
  const volumeRatio = avgVolume5Hands && avgVolume5Hands > 0 ? bar.volumeHands / avgVolume5Hands : 1;
  // 涨跌幅必须按板别算（创业板 20%），不能写死 10%
  const limitUp = code ? calcLimitUp(prevClose, code, name) : round2(prevClose * 1.1);
  const limitDown = code ? calcLimitDown(prevClose, code, name) : round2(prevClose * 0.9);
  return {
    code,
    name,
    date: bar.date,
    price: bar.close,
    prevClose,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    gainPct: prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0,
    volumeRatio,
    vwap: round2(vwap),
    priceVsVwapBps: vwap > 0 ? ((bar.close - vwap) / vwap) * 10_000 : 0,
    amountYuan: bar.amountYuan,
    mcapYi: 0, // 日线口径没有市值，minMcapYi 在回测里靠 rank by amount 兜住
    floatMcapYi: 0,
    turnoverPct: bar.turnoverPct,
    limitUp,
    limitDown,
    oneLineUp: bar.high === bar.low && bar.close >= limitUp,
    oneLineDown: bar.high === bar.low && bar.close <= limitDown,
    suspended: bar.volumeHands <= 0,
  };
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** 从已排序日线里取 5 日均量（不含当日），不足返回 undefined。 */
export function avgVolumeBefore(bars: DailyBar[], date: string, n = 5): number | undefined {
  const prior = bars.filter((b) => b.date < date).slice(-n);
  if (prior.length < n) return undefined;
  return prior.reduce((s, b) => s + b.volumeHands, 0) / n;
}

export function ma5CloseBefore(bars: DailyBar[], date: string, n = 5): number | undefined {
  const prior = bars.filter((b) => b.date < date).slice(-n);
  if (prior.length < n) return undefined;
  return prior.reduce((s, b) => s + b.close, 0) / n;
}
