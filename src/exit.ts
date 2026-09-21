/**
 * 次日出场判定 —— 回测引擎与本地模型训练共用这同一条规则。
 * 口径与引擎的 exitOrders 一致（到点清仓 > 高开减半 > 止损），
 * 日线近似：止损按当日是否触及、"10:00 前清仓"记为收盘价。
 * 规则一旦调整必须同时过 backtest.test.ts 的出场用例，防止两边口径漂移。
 */
import { config } from "./config";
import { round2 } from "./symbols";

/**
 * 止损价：atr 模式 = entry − k×ATR（封底 entry×(1−10%)，防高波动票单笔风险失控）；
 * fixed 模式或 ATR 缺失 = entry×(1−fixedPct%)。回测与实盘共用，口径不许分叉。
 */
export function stopLevel(
  entry: number,
  opts: { mode?: "fixed" | "atr"; atr?: number | null; k?: number; fixedPct?: number },
): number {
  const fixedPct = opts.fixedPct ?? config.stopLossPct;
  if (opts.mode === "atr" && opts.atr && opts.atr > 0) {
    const k = opts.k ?? 2.5;
    const floor = entry * (1 - 0.10);
    return Math.max(round2(entry - k * opts.atr), round2(floor));
  }
  return round2(entry * (1 - fixedPct / 100));
}

export interface ExitLeg {
  qty: number;
  price: number;
  note: string;
}

export interface ExitOutcome {
  /** 成交腿；空数组 = 一字跌停卖不出（规则上"无法按计划退出"） */
  legs: ExitLeg[];
  /** 按数量加权的出场价；卖不出为 null */
  blended: number | null;
  note: string;
}

/**
 * 反事实对照：这笔已实现的往返，如果当初用“另一种止损口径”，价差上会怎样。
 *
 * 为什么需要它：ATR 止损现在真的生效了，但"ATR 比固定 3% 好多少"不能靠同一段
 * 历史扫参反复回答（那是 6 重比较，而且一换数据窗口结论就变，实测从 +22.8bp 变成 +6.3bp）。
 * 只有拿真实发出的每一笔单做双口径对照，才能在不拍新参数的情况下累积证据。
 *
 * 口径与限制（写清楚，不假装精确）：
 *  - 触发判据用“建仓后观察到的最低价 lowWater”，不是分钟级路径；L1 只有 3s 切片，
 *    错过一个瞬时下影线的概率存在，两边的偏差方向一致，所以比较本身成立、绝对值别当真；
 *  - 触发就按那条止损价成交（与回测同一假设），未触发则沿用真实出场价；
 *  - 不算费用差异：同一笔 qty、同一费率，两边相减后费用项抵消。
 */
export interface StopCounterfactual {
  code: string;
  name: string;
  entryDate: string;
  exitDate: string;
  exitTime: string;
  qty: number;
  entry: number;
  exit: number;
  lowWater: number;
  stopFixed: number;
  stopAtr: number;
  activeMode: "fixed" | "atr";
  fixedTriggered: boolean;
  atrTriggered: boolean;
  /** 正数 = 当时用 ATR 会卖得更高；负数 = 固定 3% 更好 */
  diffBps: number;
}

export function stopCounterfactual(a: {
  code: string;
  name: string;
  entryDate: string;
  exitDate: string;
  exitTime: string;
  qty: number;
  entry: number;
  exit: number;
  lowWater: number;
  stopFixed: number;
  stopAtr: number;
  activeMode: "fixed" | "atr";
}): StopCounterfactual {
  const fixedTriggered = a.lowWater <= a.stopFixed;
  const atrTriggered = a.lowWater <= a.stopAtr;
  // 未触发的那个口径，结局与真实一致（同一个出场点）；触发了就按那条线成交
  const exitFixed = fixedTriggered ? a.stopFixed : a.exit;
  const exitAtr = atrTriggered ? a.stopAtr : a.exit;
  const diffBps = a.entry > 0 ? round2(((exitAtr - exitFixed) / a.entry) * 10_000) : 0;
  return { ...a, fixedTriggered, atrTriggered, diffBps };
}

/** 一批对照的结论：哪种口径赢、平均差多少。这就是"实盘证据"本身。 */
export function summarizeStopCounterfactuals(rows: StopCounterfactual[]): {
  n: number;
  atrBetter: number;
  fixedBetter: number;
  tie: number;
  meanDiffBps: number;
  /** 只有两口径都未触发时，这笔对结论没有信息量（分母应该是"至少一个触发"的数） */
  neitherTriggered: number;
} {
  const n = rows.length;
  const atrBetter = rows.filter((r) => r.diffBps > 0).length;
  const fixedBetter = rows.filter((r) => r.diffBps < 0).length;
  const neither = rows.filter((r) => !r.atrTriggered && !r.fixedTriggered).length;
  const mean = n ? round2(rows.reduce((s, r) => s + r.diffBps, 0) / n) : 0;
  return { n, atrBetter, fixedBetter, tie: n - atrBetter - fixedBetter, meanDiffBps: mean, neitherTriggered: neither };
}

/**
 * 单位数量（qty=1）的判定结果足够算盈亏；qty 只影响高开减半能不能凑出一手。
 *
 * 阶梯顺序与引擎 exitOrders() 一致（日线只能近似到这个粒度）：
 *   1) 开盘浮盈达标 → 先卖一半（整手约束下凑不出一手就不分批），好仓留下继续跑后面的规则；
 *   2) 跳空开在止损下方 → 按开盘价；盘中触及止损 → 按止损价；
 *   3) 否则到点清仓（没有分钟线，用收盘价代理）。
 * 旧实现把止损开在高开减半前面，于是“高开 +3% 之后又跌到止损”这段行情下，
 * 回测把全部仓位算在止损价，而实盘已经在开盘卖掉了一半 —— 两边跑的不是同一个策略。
 */
export function nextDayExit(args: {
  next: { open: number; high: number; low: number; close: number };
  prevClose: number;
  entry: number;
  stop: number;
  gapTrimPct?: number;
  qty?: number;
  limitPctFrac: number;
}): ExitOutcome {
  const { next, prevClose, entry, stop } = args;
  const gapTrimPct = args.gapTrimPct ?? config.gapTrimPct;
  const qty = args.qty ?? 1;
  const ld = round2(prevClose * (1 - args.limitPctFrac));
  const oneLineDown = next.high === next.low && next.close <= ld;
  if (oneLineDown) return { legs: [], blended: null, note: "一字跌停卖不出" };

  const legs: ExitLeg[] = [];
  let remaining = qty;

  // ---- 1) 开盘浮盈止盈：以今日开盘价对成本计，卖整手约束下的一半 ----
  const gapPct = entry > 0 ? ((next.open - entry) / entry) * 100 : 0;
  if (remaining >= 200 && gapPct >= gapTrimPct) {
    const half = Math.floor(remaining / 2 / 100) * 100;
    if (half >= 100) {
      legs.push({ qty: half, price: next.open, note: `开盘浮盈 ${gapPct.toFixed(1)}% 减半` });
      remaining -= half;
    }
  }

  // ---- 2) 跳空/触及止损，3) 否则到点清仓 ----
  if (remaining > 0) {
    if (next.open <= stop) {
      legs.push({ qty: remaining, price: next.open, note: `跳空开在止损下 ${next.open}` });
    } else if (next.low <= stop) {
      legs.push({ qty: remaining, price: stop, note: `止损 ${stop}` });
    } else {
      legs.push({ qty: remaining, price: next.close, note: "到点清仓(收盘近似)" });
    }
  }
  const totalQty = legs.reduce((s, l) => s + l.qty, 0);
  const blended = totalQty > 0 ? legs.reduce((s, l) => s + l.price * l.qty, 0) / totalQty : null;
  return { legs, blended, note: legs.map((l) => l.note).join(" + ") };
}
