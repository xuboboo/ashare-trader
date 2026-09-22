import type { Snapshot } from "./quotes";
import { featuresFromSnapshot, type StockFeatures } from "./factors";
import { limitDown, limitUp, round2 } from "./symbols";
import type { ResearchMinuteBar, ResearchUniverseEntry } from "./research";

export interface ResearchSnapshotInput {
  date: string;
  code: string;
  entry: ResearchUniverseEntry;
  bars: ResearchMinuteBar[];
  asOf?: string;
}

/** 从 1 分钟增量数据构造 14:45 当时真正可见的快照。 */
export function buildResearchSnapshot(input: ResearchSnapshotInput): Snapshot {
  const asOf = input.asOf ?? "14:45";
  const bars = [...input.bars]
    .filter((b) => b.date === input.date && b.time >= "09:30" && b.time <= asOf)
    .sort((a, b) => a.time.localeCompare(b.time));
  const visible = bars.at(-1);
  if (!visible || visible.time !== asOf) throw new Error(input.code + " 缺少 " + input.date + " " + asOf + " 分钟快照");
  const first = bars[0]!;
  const volumeShares = bars.reduce((sum, b) => sum + Math.max(0, b.volumeShares), 0);
  const amountYuan = bars.reduce((sum, b) => sum + Math.max(0, b.amountYuan), 0);
  const vwap = volumeShares > 0 ? amountYuan / volumeShares : visible.close;
  const prevClose = input.entry.prevClose ?? 0;
  const name = input.entry.name;
  return {
    code: input.code,
    name,
    price: visible.close,
    prevClose,
    open: first.open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    volumeHands: volumeShares / 100,
    amountYuan,
    vwap,
    turnoverPct: visible.turnoverPct,
    volumeRatio: visible.volumeRatio,
    floatMcapYi: visible.floatMcapYi || input.entry.floatMcapYi || 0,
    mcapYi: visible.mcapYi || input.entry.mcapYi || 0,
    limitUp: limitUp(prevClose, input.code, name),
    limitDown: limitDown(prevClose, input.code, name),
    bids: [{ p: visible.bid, v: visible.bidSize / 100 }],
    asks: [{ p: visible.ask, v: visible.askSize / 100 }],
    quoteDay: input.date.replace(/-/g, ""),
    quoteAt: Date.parse(input.date + "T" + asOf + ":00+08:00"),
    suspended: visible.suspended,
    oneLineUp: visible.oneLineUp,
    oneLineDown: visible.oneLineDown,
  };
}

export function researchFeatures(input: ResearchSnapshotInput): StockFeatures {
  return featuresFromSnapshot(buildResearchSnapshot(input), input.date);
}

export interface MinuteExitInput {
  bars: ResearchMinuteBar[];
  entry: number;
  stop: number;
  qty: number;
  gapTrimPct: number;
  deadline?: string;
  limitDown?: number;
}

export interface MinuteExitLeg {
  qty: number;
  price: number;
  time: string;
  note: string;
}

export interface MinuteExitResult {
  legs: MinuteExitLeg[];
  censored: boolean;
}

function executableBid(bar: ResearchMinuteBar, fallback: number): number {
  return bar.bid > 0 ? bar.bid : fallback;
}

/** 旧固定持有期研究口径：用分钟 OHLC + 当时 bid 模拟次日 10:00 前退出，不能回退到次日收盘。 */
export function simulateMinuteExit(input: MinuteExitInput): MinuteExitResult {
  const deadline = input.deadline ?? "10:00";
  const bars = [...input.bars].filter((b) => b.time >= "09:30" && b.time <= deadline).sort((a, b) => a.time.localeCompare(b.time));
  if (!bars.length || input.qty < 100) return { legs: [], censored: true };

  let remaining = input.qty;
  const legs: MinuteExitLeg[] = [];
  const first = bars[0]!;
  const gapPct = input.entry > 0 ? ((first.open - input.entry) / input.entry) * 100 : 0;
  if (gapPct >= input.gapTrimPct && remaining >= 200) {
    const half = Math.floor(remaining / 2 / 100) * 100;
    if (half >= 100) {
      const px = executableBid(first, first.open);
      const lockedDown = Boolean(input.limitDown && px <= input.limitDown && first.low === first.high);
      if (!lockedDown) {
        legs.push({ qty: half, price: round2(px), time: first.time, note: "分钟开盘高开减半" });
        remaining -= half;
      }
    }
  }

  for (const bar of bars) {
    if (remaining < 100) break;
    const lockedDown = Boolean(input.limitDown && bar.low === bar.high && bar.low <= input.limitDown);
    if (bar.open <= input.stop || bar.low <= input.stop) {
      if (lockedDown) continue;
      const px = executableBid(bar, Math.min(input.stop, bar.low));
      legs.push({
        qty: remaining,
        price: round2(Math.min(px, input.stop)),
        time: bar.time,
        note: bar.open <= input.stop ? "分钟跳空/开盘跌破止损" : "分钟最低价触发止损",
      });
      remaining = 0;
      break;
    }
  }

  if (remaining >= 100) {
    const last = bars.at(-1)!;
    const lockedDown = Boolean(input.limitDown && last.low === last.high && last.low <= input.limitDown);
    if (!lockedDown) {
      legs.push({ qty: remaining, price: round2(executableBid(last, last.close)), time: last.time, note: "10:00 分钟截止清仓" });
      remaining = 0;
    }
  }
  return { legs, censored: remaining >= 100 };
}
