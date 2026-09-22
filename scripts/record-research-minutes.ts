/**
 * 分钟盘口记录器：从今天起逐日累积 research 协议要求的 1 分钟 bar + 真实 bid/ask。
 *
 * 为什么必须"攒"而不是"下"：
 *   研究协议 execution 用 entry=ask / exit=bid，而任何免费源都不给历史逐分钟盘口。
 *   唯一真实的 bid/ask 来自腾讯 L1 五档快照 —— 引擎每 3s 就在拉，只是用完就扔。
 *   这个脚本把同一份快照按分钟聚合成 bar，落成 research/minutes/<date>/<code>.json。
 *   跑一个交易日就多一个交易日，日积月累就是别人花钱都买不到的 PIT 分钟资产。
 *
 * 同时每个交易日开跑时存一份 research/universe/<date>.json：那天真实可见的股票池
 * 快照（成交额排名 + 市值 + 昨收），这就是"版本化股票池"的逐日版本。
 *
 * 设计取舍：
 *   - 独立进程，绝不注入 engine 热循环 —— 采集挂了不能拖累实盘。
 *   - 复用 src/http 的全进程限流；poll 间隔默认与引擎一致（3s）。
 *   - 只在交易时段写盘；午休不产条；收盘后定稿当天再退出（--loop 则等明天）。
 *
 * 用法：
 *   bun scripts/record-research-minutes.ts            # 跑今天一个交易日
 *   bun scripts/record-research-minutes.ts --loop     # 常驻，每天自动跑
 *   bun scripts/record-research-minutes.ts --codes=600000
 *   bun scripts/record-research-minutes.ts --poll-ms=5000
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { bj, canTrade, phaseOf } from "../src/session";
import { TradingCalendar } from "../src/calendar";
import { fetchSnapshots, type Snapshot } from "../src/quotes";
import { Universe } from "../src/universe";
import { writeFileAtomic } from "../src/state";
import { researchRoot, type ResearchMinuteBar, type ResearchUniverseEntry } from "../src/research";
import { computeResearchSeal, writeResearchSeal, type SealDirs } from "../src/research-integrity";

const argNum = (name: string, fallback: number) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const argList = (name: string): string[] => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const pollMs = argNum("poll-ms", config.pollMs);
const root = researchRoot(config.dataDir);
const minuteDir = join(root, "minutes");
const universeDir = join(root, "universe");
const dailyDir = join(root, "daily");

/** 当前工作区 commit（取不到置 null，不致命）。 */
async function headCommit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", config.dataDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** 收盘后封存：对当前 universe/daily/minutes 算 sha256 写 provenance.json。 */
async function sealDataset(): Promise<void> {
  const dirs: SealDirs = { researchRoot: root, universeDir, dailyDir, minutesDir: minuteDir };
  const seal = await computeResearchSeal(dirs, await headCommit());
  await writeResearchSeal(dirs, seal);
  console.log(`[rec] 已封存 universe=${seal.counts.universe} daily=${seal.counts.daily} minuteFiles=${seal.counts.minuteFiles}`);
}

/** 进行中的一分钟聚合桶。cum* 是快照自带的当日累计量，用它做分钟增量。 */
interface Bucket {
  date: string;
  minute: string;
  open: number;
  high: number;
  low: number;
  close: number;
  cumHandsAtStart: number;
  cumAmtAtStart: number;
  cumHandsLast: number;
  cumAmtLast: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  volumeRatio: number;
  turnoverPct: number;
  mcapYi: number;
  floatMcapYi: number;
  suspended: boolean;
  oneLineUp: boolean;
  oneLineDown: boolean;
}

const buckets = new Map<string, Bucket>();
const barsByCode = new Map<string, ResearchMinuteBar[]>();
const lastCumByCode = new Map<string, { hands: number; amount: number }>();

/** 交易所时间（用快照自带 quoteAt，避免本机时区/网络抖动污染分钟归属）。 */
function minuteOf(s: Snapshot): { date: string; time: string } | null {
  const b = s.quoteAt ? bj(new Date(s.quoteAt)) : bj();
  if (!s.quoteDay || s.quoteDay.length < 8) return null;
  const ymd = `${s.quoteDay.slice(0, 4)}-${s.quoteDay.slice(4, 6)}-${s.quoteDay.slice(6, 8)}`;
  return { date: ymd, time: `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}` };
}

function ingest(s: Snapshot, today: string): void {
  const m = minuteOf(s);
  if (!m || m.date !== today) return; // 隔夜/非今天的陈旧快照一律不写
  const price = s.price;
  if (!(price > 0)) return;
  const cur = buckets.get(s.code);
  const cumHands = s.volumeHands;
  const cumAmt = s.amountYuan;
  const previousCum = lastCumByCode.get(s.code);

  if (!cur || cur.minute !== m.time) {
    if (cur) finalize(s.code, cur); // 上一分钟定稿
    buckets.set(s.code, {
      date: m.date,
      minute: m.time,
      open: price,
      high: price,
      low: price,
      close: price,
      // 新的一分钟从上一帧累计值起算增量；若第一帧就是 09:30，基线为 0。
      // 旧实现把第一帧当成基线，导致 09:30 的成交量/成交额永远少一截。
      cumHandsAtStart: previousCum?.hands ?? (m.time === "09:30" ? 0 : cumHands),
      cumAmtAtStart: previousCum?.amount ?? (m.time === "09:30" ? 0 : cumAmt),
      cumHandsLast: cumHands,
      cumAmtLast: cumAmt,
      bid: s.bids[0]?.p ?? 0,
      ask: s.asks[0]?.p ?? 0,
      bidSize: (s.bids[0]?.v ?? 0) * 100,
      askSize: (s.asks[0]?.v ?? 0) * 100,
      volumeRatio: s.volumeRatio,
      turnoverPct: s.turnoverPct,
      mcapYi: s.mcapYi,
      floatMcapYi: s.floatMcapYi,
      suspended: s.suspended,
      oneLineUp: s.oneLineUp,
      oneLineDown: s.oneLineDown,
    });
    lastCumByCode.set(s.code, { hands: cumHands, amount: cumAmt });
    return;
  }

  cur.high = Math.max(cur.high, price);
  cur.low = Math.min(cur.low, price);
  cur.close = price;
  cur.cumHandsLast = Math.max(cur.cumHandsLast, cumHands);
  cur.cumAmtLast = Math.max(cur.cumAmtLast, cumAmt);
  // 盘口/派生字段取"该分钟收盘时最后可见"的那一帧
  cur.bid = s.bids[0]?.p ?? cur.bid;
  cur.ask = s.asks[0]?.p ?? cur.ask;
  cur.bidSize = (s.bids[0]?.v ?? 0) * 100 || cur.bidSize;
  cur.askSize = (s.asks[0]?.v ?? 0) * 100 || cur.askSize;
  cur.volumeRatio = s.volumeRatio;
  cur.turnoverPct = s.turnoverPct;
  cur.mcapYi = s.mcapYi;
  cur.floatMcapYi = s.floatMcapYi;
  cur.suspended = s.suspended;
  cur.oneLineUp = s.oneLineUp;
  cur.oneLineDown = s.oneLineDown;
  lastCumByCode.set(s.code, { hands: cumHands, amount: cumAmt });
}

function finalize(code: string, b: Bucket): void {
  const bar: ResearchMinuteBar = {
    date: b.date,
    time: b.minute,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volumeShares: Math.max(0, Math.round((b.cumHandsLast - b.cumHandsAtStart) * 100)),
    amountYuan: Math.max(0, Math.round(b.cumAmtLast - b.cumAmtAtStart)),
    bid: b.bid,
    ask: b.ask,
    bidSize: Math.max(0, b.bidSize),
    askSize: Math.max(0, b.askSize),
    volumeRatio: b.volumeRatio,
    turnoverPct: b.turnoverPct,
    mcapYi: b.mcapYi,
    floatMcapYi: b.floatMcapYi,
    suspended: b.suspended,
    oneLineUp: b.oneLineUp,
    oneLineDown: b.oneLineDown,
  };
  const arr = barsByCode.get(code) ?? [];
  if (!arr.length || arr[arr.length - 1]!.time < bar.time) arr.push(bar);
  barsByCode.set(code, arr);
}

async function flush(date: string, codes: string[]): Promise<number> {
  let n = 0;
  const dir = join(minuteDir, date);
  await mkdir(dir, { recursive: true });
  for (const code of codes) {
    const arr = barsByCode.get(code);
    if (!arr || !arr.length) continue;
    await writeFileAtomic(join(dir, `${code}.json`), JSON.stringify(arr));
    n++;
  }
  return n;
}

/** 开跑即落一份当天 PIT 股票池版本：那天真实可见的排名 + 市值 + 昨收。 */
async function snapshotUniverse(date: string, snaps: Map<string, Snapshot>, order: string[]): Promise<void> {
  await mkdir(universeDir, { recursive: true });
  const entries: ResearchUniverseEntry[] = [];
  for (const [i, code] of order.entries()) {
    const s = snaps.get(code);
    if (!s || !(s.prevClose > 0)) continue;
    entries.push({ rank: i + 1, code, name: s.name, active: !s.suspended, prevClose: s.prevClose, mcapYi: s.mcapYi, floatMcapYi: s.floatMcapYi });
  }
  await writeFileAtomic(
    join(universeDir, `${date}.json`),
    JSON.stringify({ date, asOf: "14:45", capturedAt: Date.now(), source: "record-research-minutes/tencent-l1/top-amount-at-14:45", entries }),
  );
}

async function runOnce(calendar: TradingCalendar): Promise<void> {
  const now = bj();
  if (!calendar.isTradingDay(now.ymd)) {
    console.log(`[rec] ${now.ymd} 非交易日，等待中…`);
    await Bun.sleep(60_000);
    return;
  }
  const codes = argList("codes");
  const uni = new Universe();
  await uni.get(now.ymd);
  const pool = codes.length ? codes : uni.codes();
  if (!pool.length) throw new Error("股票池为空");
  buckets.clear();
  barsByCode.clear();
  lastCumByCode.clear();
  const recordingCodes = [...pool];
  console.log(`[rec] ${now.ymd} 开始记录 ${recordingCodes.length} 支，poll=${pollMs}ms`);

  let universeSnapped = false;
  let lastFlush = 0;
  for (;;) {
    const t = bj();
    const phase = phaseOf(t.ymd, t.minutes, true);
    const done = phase === "after-hours" || !calendar.isTradingDay(t.ymd);
    if (canTrade(phase)) {
      try {
        const snaps = await fetchSnapshots(recordingCodes);
        const visible = new Map(snaps);
        // PIT 股票池只能在 14:45 截面落盘。收盘后重建的全天成交额榜单不再被当作历史 PIT。
        if (!universeSnapped && t.minutes >= 14 * 60 + 45) {
          const pit = new Universe();
          await pit.refresh(t.ymd);
          const pitCodes = pit.entries.slice(0, config.universeSize).map((e) => e.code);
          const pitSnaps = await fetchSnapshots(pitCodes);
          for (const [code, snap] of pitSnaps) visible.set(code, snap);
          for (const code of pitCodes) if (!recordingCodes.includes(code)) recordingCodes.push(code);
          if (pitSnaps.size) {
            await snapshotUniverse(t.ymd, pitSnaps, pitCodes);
            universeSnapped = true;
          }
        }
        for (const code of recordingCodes) {
          const s = visible.get(code);
          if (s) ingest(s, t.ymd);
        }
      } catch (e) {
        console.warn(`[rec] 快照失败（下轮重试）：${(e as Error).message}`);
      }
      // 每 20s 落一次盘，崩了最多丢 20s
      if (Date.now() - lastFlush > 20_000) {
        const n = await flush(t.ymd, recordingCodes);
        lastFlush = Date.now();
        if (n) console.log(`[rec] ${t.ymd} ${t.hour}:${String(t.minute).padStart(2, "0")} 已落 ${n} 支分钟条`);
      }
    }
    if (done) {
      // 收盘定稿：最后进行中的一分钟也写进去
      for (const [code, b] of buckets) finalize(code, b);
      buckets.clear();
      if (!universeSnapped) console.warn(`[rec] ${t.ymd} 未取得 14:45 PIT 股票池，拒绝写入伪造快照`);
      const n = await flush(t.ymd, recordingCodes);
      await sealDataset(); // 封存今天真实采到的数据，供闸门验证事后篡改
      console.log(`[rec] ${t.ymd} 收盘，定稿 ${n} 支。`);
      return;
    }
    await Bun.sleep(pollMs);
  }
}

const calendar = new TradingCalendar();
await calendar.refresh();
do {
  await runOnce(calendar).catch((e) => console.error(`[rec] 本轮异常：${(e as Error).message}`));
  await calendar.refresh();
} while (hasFlag("loop"));
