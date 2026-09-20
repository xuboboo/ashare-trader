/** A 股交易规则：市场前缀、涨跌幅限制、最小申报单位、价格档位。 */

export type Side = "buy" | "sell";

/** 6 位代码 -> 交易所前缀。东财 secid 用 1=沪、0=深。 */
export const exchange = (code: string): "sh" | "sz" | "bj" =>
  code.startsWith("6") ? "sh" : code.startsWith("4") || code.startsWith("8") || code.startsWith("9") ? "bj" : "sz";

export const tencentSymbol = (code: string) => `${exchange(code)}${code}`;
export const eastmoneySecid = (code: string) => `${exchange(code) === "sh" ? 1 : 0}.${code}`;

/**
 * 本项目只交易沪深主板 + 创业板：
 * 688（科创板 20%）、4/8（北交所 30%）直接排除，避免涨跌幅与流动性差异污染回测。
 */
export const inScope = (code: string) =>
  /^(000|001|002|003|600|601|603|605|300|301)/.test(code);

export const isSt = (name: string) => /ST/i.test(name);

/** 涨跌停幅度（小数）。创业板 20%，ST 5%，其余主板 10%。 */
export function limitPct(code: string, name: string): number {
  if (isSt(name)) return 0.05;
  if (code.startsWith("300") || code.startsWith("301")) return 0.2;
  return 0.1;
}

/** 涨跌停价：昨收 * (1±pct) 四舍五入到分。 */
export function limitUp(prevClose: number, code: string, name: string) {
  return round2(prevClose * (1 + limitPct(code, name)));
}
export function limitDown(prevClose: number, code: string, name: string) {
  return round2(prevClose * (1 - limitPct(code, name)));
}

export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** 价格档位：A 股股票一律 0.01 元。 */
export const TICK = 0.01;
export const tickPrice = (price: number, ticks: number) => round2(price + ticks * TICK);

/** 最小申报 100 股，买入必须是 100 的整数倍。 */
export const LOT = 100;
export function sharesForBudget(price: number, budgetCny: number): number {
  if (!(price > 0) || !(budgetCny > 0)) return 0;
  return Math.floor(budgetCny / price / LOT) * LOT;
}

/** 该价格按预算是否连一手都买不起。买不起的候选不进模型提问，免得推荐了也执行不了。 */
export const cannotAffordLot = (price: number, budgetCny: number): boolean =>
  sharesForBudget(price, budgetCny) < LOT;

/** 距涨停/跌停还有多少 bps，用于判断"还能不能买到"。 */
export function distanceBps(price: number, ref: number) {
  return ref > 0 ? ((ref - price) / price) * 10_000 : 0;
}
