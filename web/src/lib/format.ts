/** 展示层格式化：全部纯函数、SSR 安全。金额一律人民币元。 */

const INT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function safe(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function fmtInt(n: number | null | undefined): string {
  return INT.format(Math.round(safe(n)));
}

/** 61.38 -> "61.38"（A 股价格两位小数） */
export function fmtPrice(n: number | null | undefined): string {
  return safe(n).toFixed(2);
}

/** 49104 -> "¥49,104"；125528.78 -> "¥125,529" */
export function fmtCny(n: number | null | undefined, d = 0): string {
  const v = safe(n);
  return `${v < 0 ? "-" : ""}¥${Math.abs(v).toLocaleString("zh-CN", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
}

/** 有符号金额：+¥413 / -¥56 */
export function fmtSignedCny(n: number | null | undefined, d = 0): string {
  const v = safe(n);
  return `${v >= 0 ? "+" : "-"}¥${Math.abs(v).toLocaleString("zh-CN", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
}

export function fmtPct(p: number | null | undefined, d = 2): string {
  return `${safe(p).toFixed(d)}%`;
}

/** 比率 0.32 -> "32%" */
export function fmtRatioPct(p: number | null | undefined, d = 0): string {
  return `${(safe(p) * 100).toFixed(d)}%`;
}

/** 有符号百分比：3.4 -> "+3.40%" */
export function fmtSignedPct(p: number | null | undefined, d = 2): string {
  const v = safe(p);
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(d)}%`;
}

export function fmtBps(n: number | null | undefined, d = 1): string {
  const v = safe(n);
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(d)}bp`;
}

export function fmtMs(n: number | null | undefined): string {
  return `${Math.round(safe(n))}ms`;
}

export function uptime(startedAt: number | null | undefined, now: number = Date.now()): string {
  if (!startedAt || !Number.isFinite(startedAt)) return "00:00:00";
  const startMs = startedAt < 1e12 ? startedAt * 1000 : startedAt;
  return hhmmss(Math.max(0, now - startMs));
}

export function hhmmss(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const PHASE_CN: Record<string, string> = {
  closed: "非交易日",
  "pre-open": "盘前",
  "call-auction": "集合竞价",
  "no-cancel": "不可撤单",
  continuous: "连续竞价",
  lunch: "午休",
  "close-auction": "收盘竞价",
  "after-hours": "已收盘",
};

export function phaseCn(phase: string | null | undefined): string {
  return PHASE_CN[phase ?? ""] ?? phase ?? "-";
}

/** 建议单转成可直接粘进券商 App 的一行人话。 */
export function orderLine(o: {
  name: string;
  code: string;
  side: string;
  qty: number;
  limitLow: number;
  limitHigh: number;
  stopPrice?: number | null;
}): string {
  const side = o.side === "buy" ? "买入" : "卖出";
  const stop = o.stopPrice ? ` 止损 ${o.stopPrice.toFixed(2)}` : "";
  return `${side} ${o.name}(${o.code}) ${o.qty} 股，限价 ${o.limitLow.toFixed(2)}-${o.limitHigh.toFixed(2)}${stop}`;
}

/** 回填命令，推送到手机上时能直接复制执行。 */
export function fillCommand(o: { code: string; side: string; qty: number; signalId: string }): string {
  return `bun run scripts/fill.ts ${o.code} ${o.side} ${o.qty} --signal=${o.signalId}`;
}
