/**
 * A 股真实交易成本。回测与影子盘共用这一份，别在两边各写一套然后对不上。
 *
 * 费率档（普通股，2026）：
 *  - 佣金 max(5 元, 成交额 * rate)：**双边**，5 元最低佣金是小单的隐形杀手
 *  - 印花税 0.05%：仅**卖出**单边
 *  - 过户费 0.001%：**双边**
 *  - 经手费 + 证管费 约 0.0068%：**双边**（按券商公示口径近似，写死可配）
 */
import { config } from "./config";
import type { Side } from "./symbols";

export interface Costs {
  commission: number;
  stampTax: number;
  transferFee: number;
  exchangeFee: number;
  total: number;
}

export const commission = (amount: number) =>
  Math.max(config.commissionMin, amount * config.commissionRate);

function build(amount: number, side: Side): Costs {
  const commission_ = commission(amount);
  const stampTax = side === "sell" ? amount * config.stampTaxRate : 0;
  const transferFee = amount * config.transferFeeRate;
  const exchangeFee = amount * config.exchangeFeeRate;
  const total = commission_ + stampTax + transferFee + exchangeFee;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    commission: r2(commission_),
    stampTax: r2(stampTax),
    transferFee: r2(transferFee),
    exchangeFee: r2(exchangeFee),
    total: r2(total),
  };
}

export const buyCosts = (amount: number) => build(amount, "buy");
export const sellCosts = (amount: number) => build(amount, "sell");

/** 一买一卖的完整往返成本（元）与占比（bps）。 */
export function roundTrip(amountCny: number) {
  const buy = buyCosts(amountCny);
  const sell = sellCosts(amountCny);
  const total = Math.round((buy.total + sell.total) * 100) / 100;
  return { buy, sell, total, bps: amountCny > 0 ? (total / amountCny) * 10_000 : 0 };
}

/**
 * 最低佣金警告：当 5 元最低佣金在单笔里占比超过阈值时，明确告诉使用者
 * "这单的固定成本已经把预期收益吃掉一半"。
 */
export function minCommissionWarn(amountCny: number): string | null {
  if (amountCny <= 0) return null;
  const noMin = amountCny * config.commissionRate * 2; // 双边按比例应付
  const actual = buyCosts(amountCny).commission + sellCosts(amountCny).commission;
  const excess = actual - noMin;
  const bps = (excess / amountCny) * 10_000;
  if (bps < 5) return null;
  return `单笔 ${Math.round(amountCny / 1000)}k 元触发最低佣金，多出 ${excess.toFixed(2)} 元 = ${bps.toFixed(1)}bp 固定成本（需涨 ${bps.toFixed(0)}bp 才回本）`;
}

/** 单边滑点：按 tick 数计价，买更贵卖更便宜。 */
export function slipFillPrice(price: number, side: Side, ticks = config.slippageTicks) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return r2(side === "buy" ? price + ticks * 0.01 : price - ticks * 0.01);
}
