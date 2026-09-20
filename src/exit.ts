/**
 * 次日出场判定 —— 回测引擎与本地模型训练共用这同一条规则。
 * 口径与引擎的 exitOrders 一致（到点清仓 > 高开减半 > 止损），
 * 日线近似：止损按当日是否触及、"10:00 前清仓"记为收盘价。
 * 规则一旦调整必须同时过 backtest.test.ts 的出场用例，防止两边口径漂移。
 */
import { config } from "./config";
import { round2 } from "./symbols";

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

/** 单位数量（qty=1）的判定结果足够算盈亏；qty 只影响高开减半能不能凑出一手。 */
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
  const gapPct = ((next.open - entry) / entry) * 100;
  if (next.low <= stop && next.open > stop) {
    legs.push({ qty, price: stop, note: `止损 ${stop}` });
  } else if (next.open <= stop) {
    legs.push({ qty, price: next.open, note: `跳空开在止损下 ${next.open}` });
  } else if (gapPct >= gapTrimPct && Math.floor(qty / 2 / 100) * 100 >= 100) {
    const half = Math.floor(qty / 2 / 100) * 100;
    legs.push({ qty: half, price: next.open, note: `高开 ${gapPct.toFixed(1)}% 减半` });
    legs.push({ qty: qty - half, price: next.close, note: "剩仓到点清仓(收盘近似)" });
  } else {
    legs.push({ qty, price: next.close, note: "到点清仓(收盘近似)" });
  }
  const totalQty = legs.reduce((s, l) => s + l.qty, 0);
  const blended = totalQty > 0 ? legs.reduce((s, l) => s + l.price * l.qty, 0) / totalQty : null;
  return { legs, blended, note: legs.map((l) => l.note).join(" + ") };
}
