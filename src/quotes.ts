/**
 * 实时快照。主源腾讯 qt.gtimg.cn（GBK，一次可批量几十支，带完整五档、涨停/跌停价、量比、均价）。
 * 字段序号是 2026-09 实测锁定的（见 scripts/probe.ts 与 data/probe.txt），改动会由 quotes.test.ts 的
 * 契约测试先炸掉，而不是静默算错因子。
 */
import { httpGet, httpJson } from "./http";
import { eastmoneySecid, inScope, limitDown as calcLimitDown, limitUp as calcLimitUp, tencentSymbol } from "./symbols";

export interface Level {
  p: number;
  v: number; // 手
}

export interface Snapshot {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volumeHands: number;
  amountYuan: number;
  /** 分时均价（VWAP），腾讯字段 51 */
  vwap: number;
  turnoverPct: number;
  volumeRatio: number;
  floatMcapYi: number;
  mcapYi: number;
  limitUp: number;
  limitDown: number;
  bids: Level[];
  asks: Level[];
  /** 行情自带时间 YYYYMMDDHHMMSS，用于判断拿到的是不是上一交易日快照 */
  quoteDay: string;
  /** 上面那个时间戳换算成 epoch 毫秒（固定按 +08:00 解）。解不出为 0 */
  quoteAt: number;
  suspended: boolean;
  /** 一字涨停（开=高=低=涨停价），买不进去 */
  oneLineUp: boolean;
  oneLineDown: boolean;
}

const IDX = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  volume: 6,
  bid1p: 9,
  ask1p: 19,
  time: 30,
  pct: 32,
  high: 33,
  low: 34,
  amountWan: 37,
  turnover: 38,
  floatMcapYi: 44,
  mcapYi: 45,
  limitUp: 47,
  limitDown: 48,
  volumeRatio: 49,
  vwap: 51,
} as const;

const f = (parts: string[], i: number): number => {
  const v = Number(parts[i]);
  return Number.isFinite(v) ? v : 0;
};
const s = (parts: string[], i: number): string => (parts[i] ?? "").trim();

export function parseTencentRow(line: string): Snapshot | null {
  const eq = line.indexOf('="');
  if (eq < 0) return null;
  const parts = line.slice(eq + 2).split("~");
  if (parts.length < 52) return null;
  const code = s(parts, IDX.code);
  if (!/^\d{6}$/.test(code)) return null;
  const name = s(parts, IDX.name);
  const price = f(parts, IDX.price);
  const prevClose = f(parts, IDX.prevClose);
  if (!code || !prevClose) return null;

  const lvls = (start: number): Level[] =>
    [0, 1, 2, 3, 4].map((k) => ({ p: f(parts, start + k * 2), v: f(parts, start + k * 2 + 1) }));

  const limitUp = f(parts, IDX.limitUp) || calcLimitUp(prevClose, code, name);
  const limitDown = f(parts, IDX.limitDown) || calcLimitDown(prevClose, code, name);
  const high = f(parts, IDX.high);
  const open = f(parts, IDX.open);
  const low = f(parts, IDX.low);
  const suspended = price <= 0 || (high === 0 && f(parts, IDX.volume) === 0);

  return {
    code,
    name,
    price: suspended ? prevClose : price,
    prevClose,
    open,
    high: high || price,
    low: low || price,
    volumeHands: f(parts, IDX.volume),
    amountYuan: f(parts, IDX.amountWan) * 10_000,
    vwap: f(parts, IDX.vwap) || price,
    turnoverPct: f(parts, IDX.turnover),
    volumeRatio: f(parts, IDX.volumeRatio),
    floatMcapYi: f(parts, IDX.floatMcapYi),
    mcapYi: f(parts, IDX.mcapYi),
    limitUp,
    limitDown,
    bids: lvls(IDX.bid1p),
    asks: lvls(IDX.ask1p),
    quoteDay: s(parts, IDX.time).slice(0, 8),
    quoteAt: parseQuoteAt(s(parts, IDX.time)),
    suspended,
    oneLineUp: !suspended && high === low && high === limitUp,
    oneLineDown: !suspended && high === low && high === limitDown,
  };
}

const BATCH = 60;

/**
 * 腾讯的时间形如 20260918161458，是北京时间。用固定 +08:00 偏移解析，
 * 不受本机时区影响（本机不在东八区时也能算对新鲜度）。
 */
export function parseQuoteAt(stamp: string): number {
  if (!/^\d{14}$/.test(stamp)) return 0;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+08:00`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 一批快照里最旧的那份距今多少秒（负值 = 行情时间在未来的异常，归 0）。 */
export function quoteAgeSec(snapshots: Iterable<Snapshot>, now: number = Date.now()): number {
  let oldest = 0;
  for (const s of snapshots) {
    if (!s.quoteAt) continue;
    oldest = oldest ? Math.min(oldest, s.quoteAt) : s.quoteAt;
  }
  if (!oldest) return -1; // 一个时间戳都没有，未知
  return Math.max(0, (now - oldest) / 1000);
}

/** 批量快照。失败抛错，由引擎计入 quoteFails 并决定降级。 */
export async function fetchSnapshots(codes: string[]): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const uniq = [...new Set(codes)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += BATCH) {
    const chunk = uniq.slice(i, i + BATCH);
    const q = chunk.map(tencentSymbol).join(",");
    const text = await httpGet(`https://qt.gtimg.cn/q=${q}`, { referer: "https://gu.qq.com/" });
    for (const line of text.split("\n")) {
      const sn = parseTencentRow(line);
      if (sn) out.set(sn.code, sn);
    }
  }
  return out;
}

export async function fetchSnapshot(code: string): Promise<Snapshot | null> {
  const m = await fetchSnapshots([code]);
  return m.get(code) ?? null;
}

/**
 * 分笔成交（3 秒聚合的真实成交记录，东财 details 接口）。
 * 这是排队模拟的证据源：挂单价这个价位上真实成交了多少量、哪个方向主动，直接可读 ——
 * L1 快照给不了这个（它只说"现在簿子上挂着什么"，不说"刚才什么价成交了多少"）。
 * f55 实测与价格变动强相关：上涨窗口 type2 占 67/70 → **2 = 主动买，1 = 主动卖**。
 * 只对挂着在途单的代码调用（每轮几个请求），别刷全池 —— 限频是全进程共享的。
 */
export interface TickTrade {
  /** HH:MM:SS */
  time: string;
  price: number;
  /** 股（接口单位是手，×100） */
  shares: number;
  /** true = 主动买（买方吃卖方） */
  buyerAggressor: boolean;
}

/** 最近 pos 条分笔成交（按时间升序）。-1500 ≈ 覆盖挂单后 75 分钟的成交。 */
export async function fetchTickTrades(code: string, pos = -1500): Promise<TickTrade[]> {
  const url =
    `https://push2.eastmoney.com/api/qt/stock/details/get?secid=${eastmoneySecid(code)}` +
    `&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=${pos}`;
  const j = await httpJson<{ data?: { details?: string[] } }>(url, { referer: "https://quote.eastmoney.com/" });
  const rows = j.data?.details ?? [];
  const out: TickTrade[] = [];
  for (const r of rows) {
    const p = r.split(",");
    const price = Number(p[1]);
    const hands = Number(p[2]);
    if (!(price > 0) || !(hands > 0) || !p[0]) continue;
    out.push({ time: p[0]!, price, shares: hands * 100, buyerAggressor: p[4] === "2" });
  }
  return out;
}

/**
 * 把分笔剪成"只剩今天"。`f51` 只有 HH:MM:SS 没有日期，而接口只回最近 N 条：
 * 实测 1500 条在活跃票上只覆盖尾盘两小时（600000：13:27~15:29），所以早盘拉到的
 * 一整批全部是昨天的。两道闸：
 *   1) 序列里最后一次"时间回落"就是换日边界（昨天 15:30 -> 今天 09:15），只留最后一段；
 *   2) 时间戳比现在晚的行必然不是今天的（早盘时昨天的下午尾巴全靠这一条掉）。
 * 今天还没有成交时返回空集 —— 比"拿昨天的量当今天的排队证据"好。
 */
export function todayTape(rows: TickTrade[], nowHms: string): TickTrade[] {
  if (!rows.length) return rows;
  let start = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.time < rows[i - 1]!.time) start = i;
  return rows.slice(start).filter((t) => t.time <= nowHms);
}

/** 上证指数：大盘闸门用。symbol 与平安银行撞码，必须带 sh 前缀走这里。 */
export async function fetchIndex(): Promise<{ price: number; pct: number; amountYi: number; snapshot: Snapshot }> {
  const text = await httpGet("https://qt.gtimg.cn/q=sh000001", { referer: "https://gu.qq.com/" });
  const parts = (text.split("\n")[0] ?? "").split('="')[1]?.split("~") ?? [];
  const snapshot: Snapshot = {
    code: "000001",
    name: "上证指数",
    price: f(parts, IDX.price),
    prevClose: f(parts, IDX.prevClose),
    open: f(parts, IDX.open),
    high: f(parts, IDX.high),
    low: f(parts, IDX.low),
    volumeHands: f(parts, IDX.volume),
    amountYuan: f(parts, IDX.amountWan) * 10_000,
    vwap: f(parts, IDX.vwap),
    turnoverPct: 0,
    volumeRatio: f(parts, IDX.volumeRatio),
    floatMcapYi: 0,
    mcapYi: 0,
    limitUp: 0,
    limitDown: 0,
    bids: [],
    asks: [],
    quoteDay: s(parts, IDX.time).slice(0, 8),
    quoteAt: parseQuoteAt(s(parts, IDX.time)),
    suspended: false,
    oneLineUp: false,
    oneLineDown: false,
  };
  return {
    price: snapshot.price,
    pct: f(parts, IDX.pct),
    amountYi: snapshot.amountYuan / 1e8,
    snapshot,
  };
}

export interface DailyBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volumeHands: number;
  amountYuan: number;
  turnoverPct: number;
  pct: number;
  /** 腾讯/新浪没有成交额，用 (高+低+收)/3 * 成交量 估算。回测会统计占比，不让它静默污染结论。 */
  amountEst?: boolean;
}

/** 日线字符串行 -> DailyBar。单独抽出来给契约测试用。 */
export function parseKlines(lines: string[]): DailyBar[] {
  return lines.map((k) => {
    const a = k.split(",");
    return {
      date: a[0]!,
      open: Number(a[1]),
      close: Number(a[2]),
      high: Number(a[3]),
      low: Number(a[4]),
      volumeHands: Number(a[5]),
      amountYuan: Number(a[6]),
      turnoverPct: Number(a[10]),
      pct: Number(a[8]),
    };
  });
}

type KlineSource = "em" | "tx" | "sina";
let emKlineDownUntil = 0;
/** 本次运行里实际用过的日线源，用于在报告里说清数据是从哪来的 */
export const klineSources = new Set<KlineSource>();

/** secid -> 腾讯/新浪的带市场前缀代码。1=沪、0=深，对指数同样成立（1.000001 = 上证）。 */
const symFromSecid = (secid: string) => `${secid.startsWith("1.") ? "sh" : "sz"}${secid.split(".")[1] ?? secid}`;

async function klineEastmoney(secid: string, limit: number): Promise<DailyBar[]> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&klt=101&fqt=1&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const j = await httpJson<{ data?: { klines?: string[] } }>(url, {
    referer: "https://quote.eastmoney.com/",
    tries: 2,
  });
  return parseKlines(j?.data?.klines ?? []);
}

async function klineTencent(secid: string, limit: number): Promise<DailyBar[]> {
  const sym = symFromSecid(secid);
  const j = await httpJson<any>(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${limit},qfq`, {
    referer: "https://gu.qq.com/",
  });
  const rows: any[] = j?.data?.[sym]?.qfqday ?? j?.data?.[sym]?.day ?? [];
  return rows.map((r) => {
    const [date, open, close, high, low, vol] = r;
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    const hands = Number(vol);
    return {
      date: String(date),
      open: Number(open),
      close: c,
      high: h,
      low: l,
      volumeHands: hands,
      amountYuan: Math.round(hands * 100 * ((h + l + c) / 3)),
      turnoverPct: 0,
      pct: 0,
      amountEst: true,
    };
  });
}

async function klineSina(secid: string, limit: number): Promise<DailyBar[]> {
  const sym = symFromSecid(secid);
  const j = await httpJson<any[]>(
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20d=/CN_MarketDataService.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${limit}`,
    { referer: "https://finance.sina.com.cn/" },
  );
  return (Array.isArray(j) ? j : []).map((r: any) => {
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    const hands = Number(r.volume) / 100; // 新浪给的是股
    return {
      date: String(r.day),
      open: Number(r.open),
      close: c,
      high: h,
      low: l,
      volumeHands: hands,
      amountYuan: Math.round(hands * 100 * ((h + l + c) / 3)),
      turnoverPct: 0,
      pct: 0,
      amountEst: true,
    };
  });
}

/**
 * 日线（前复权）。主源东财 fields2 实测为 日期,开,收,高,低,量,额,振幅,涨跌%,涨跌额,换手；
 * 被限流时自动退到腾讯 ifzq 再到新浪（后两者没有成交额，会打 amountEst 标记）。
 */
export async function fetchDailyBySecid(secid: string, limit = 250): Promise<DailyBar[]> {
  const providers: [KlineSource, (secid: string, limit: number) => Promise<DailyBar[]>][] = [
    ["em", klineEastmoney],
    ["tx", klineTencent],
    ["sina", klineSina],
  ];
  let lastErr: unknown;
  for (const [name, fn] of providers) {
    if (name === "em" && Date.now() < emKlineDownUntil) continue;
    try {
      const bars = await fn(secid, limit);
      if (!bars.length) throw new Error("空数据");
      klineSources.add(name);
      return bars;
    } catch (e) {
      lastErr = e;
      if (name === "em") emKlineDownUntil = Date.now() + 120_000; // 连续失败就歇 2 分钟，别硬撞
    }
  }
  throw new Error(`日线三个源全部失败 (${secid}): ${(lastErr as Error)?.message}`);
}

/**
 * 上证指数 secid。注意 000001 在东财既可能是上证指数(1.000001)也可能是平安银行(0.000001)，
 * 大盘相关的日线一律走这个常量，别用代码推。
 */
export const INDEX_SECID = "1.000001";

export const fetchIndexDaily = (limit = 60): Promise<DailyBar[]> => fetchDailyBySecid(INDEX_SECID, limit);

/** 按 6 位代码取个股日线（沪深主板/创业板）。 */
export const fetchDaily = (code: string, limit = 250): Promise<DailyBar[]> =>
  fetchDailyBySecid(eastmoneySecid(code), limit);

/**
 * 原始（不复权，fqt=0）日线 —— 研究协议 priceBasis=raw 专用。
 *
 * 不能复用 fetchDaily：那是前复权，会把历史成交价按后来的除权往下修，
 * 14:45 用这种价当买入价等于凭空多算了跌幅。研究侧的成交价、市值、换手
 * 全都依赖不复权原值，所以单独走 fqt=0。
 *
 * 只认东财源：腾讯/新浪兜底会给 amountEst（用均价*量估的成交额），
 * 而 loadDailyBars 明确拒收 amountEst 行。宁可这里直接抛错、让采集脚本跳过该票，
 * 也不要塞一条"看着像真的"的估值进 raw 池子。
 */
export async function fetchRawDaily(code: string, limit = 500): Promise<DailyBar[]> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneySecid(code)}` +
    `&klt=101&fqt=0&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const j = await httpJson<{ data?: { klines?: string[] } }>(url, {
    referer: "https://quote.eastmoney.com/",
    tries: 3,
  });
  const bars = parseKlines(j?.data?.klines ?? []);
  if (!bars.length) throw new Error(`raw 日线为空 (${code})`);
  return bars;
}

/** 股票池：全市场按成交额降序，取前 N 且在交易范围内的主板/创业板。 */
export async function fetchTopByAmount(count: number): Promise<{ code: string; name: string; amountYuan: number }[]> {
  const out: { code: string; name: string; amountYuan: number }[] = [];
  const per = 100;
  for (let pn = 1; out.length < count && pn <= Math.ceil(count / per) + 4; pn++) {
    const url =
      `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${per}&po=1&np=1&fltt=2&invt=2&fid=f6` +
      `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f6,f2,f3,f20,f21`;
    const j = await httpJson<{ data?: { diff?: any[] } }>(url, { referer: "https://quote.eastmoney.com/" });
    const diff = j?.data?.diff ?? [];
    if (!diff.length) break;
    for (const d of diff) {
      const code = String(d.f12 ?? "");
      if (!inScope(code)) continue;
      out.push({ code, name: String(d.f14 ?? ""), amountYuan: Number(d.f6) || 0 });
    }
  }
  return out.slice(0, count);
}

export interface ZtStock {
  code: string;
  name: string;
  /** 连板次数 */
  lianBan: number;
  industry: string;
  amountYuan: number;
}

/** 涨停池（当日），用来算连板高度与情绪温度。日期用 YYYYMMDD，缺省为今天。 */
export async function fetchZtPool(date?: string): Promise<ZtStock[]> {
  const d = date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const url =
    `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt` +
    `&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${d}`;
  const j = await httpJson<{ data?: { pool?: any[] } }>(url, { referer: "https://quote.eastmoney.com/" });
  return (j?.data?.pool ?? []).map((p) => ({
    code: String(p.c ?? ""),
    name: String(p.n ?? ""),
    lianBan: Number(p.lbc ?? 1),
    industry: String(p.hybk ?? ""),
    amountYuan: Number(p.amount ?? 0),
  }));
}
