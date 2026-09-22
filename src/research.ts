/**
 * 研究数据协议。
 *
 * 这套协议故意不兼容旧的 data/daily：旧日线没有 point-in-time 股票池，
 * 也没有 14:45 可见截面和分钟级成交路径，不能再被当作策略回测输入。
 * v2 manifest 只描述 Jev 自主退出所需的可见数据与观测边界；
 * 不再把固定 10:00 写进生产研究协议。旧 v1 是 legacy，禁止混入新标签。
 */
import { join, isAbsolute, sep } from "node:path";
import { config } from "./config";
import type { DailyBar } from "./quotes";

export const RESEARCH_SCHEMA_VERSION = 2;
export const RESEARCH_DIR_NAME = "research";

export interface DateRange {
  from: string;
  to: string;
}

export interface ResearchManifest {
  schemaVersion: 2;
  dataset: string;
  timezone: "Asia/Shanghai";
  priceBasis: "raw";
  universe: {
    path: string;
    format: "date-json";
    pointInTime: true;
    asOfTime: "14:45";
    source: string;
  };
  daily: {
    path: string;
    format: "code-json";
    pointInTime: true;
    source: string;
  };
  minutes: {
    path: string;
    format: "date-code-json";
    intervalMinutes: 1;
    source: string;
  };
  execution: {
    entryTime: "14:45";
    entryPrice: "ask";
    exitPrice: "bid";
    maxBarAgeSeconds: number;
    decisionIntervalMinutes: 1;
  };
  labels: {
    policy: "jev-autonomous";
    censoring: "right";
  };
  splits: {
    train: DateRange;
    validation: DateRange;
    test: DateRange;
  };
}

export interface ResearchUniverseEntry {
  code: string;
  name: string;
  active: boolean;
  rank?: number;
  listedDate?: string;
  delistedDate?: string;
  floatShares?: number;
  prevClose?: number;
  mcapYi?: number;
  floatMcapYi?: number;
}

export interface ResearchUniverseSnapshot {
  date: string;
  asOf: "14:45";
  source: string;
  capturedAt?: number;
  entries: ResearchUniverseEntry[];
}

/** 研究目录中的原始日线。它只负责提供历史上下文，不能被当作 14:45 收盘价。 */
export type ResearchDailyBar = DailyBar;

export interface ResearchMinuteBar {
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeShares: number;
  amountYuan: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  /** 以下字段必须是该分钟收盘时可见的派生值，不得使用收盘后回填。 */
  volumeRatio: number;
  turnoverPct: number;
  mcapYi: number;
  floatMcapYi: number;
  suspended: boolean;
  oneLineUp: boolean;
  oneLineDown: boolean;
}

export interface ResearchInspection {
  manifestPath: string;
  manifest: ResearchManifest | null;
  errors: string[];
  universeSnapshots: number;
  invalidUniverseSnapshots: number;
  dailyFiles: number;
  minuteDateDirs: number;
  minuteFiles: number;
}

export type ResearchSplitName = "train" | "validation" | "test";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const d = new Date(s + "T12:00:00+08:00");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function validRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || !p || isAbsolute(p)) return false;
  const normalized = p.split(/[\\/]+/).join(sep);
  return !normalized.split(sep).includes("..");
}

function rangeError(name: string, r: unknown, errors: string[]) {
  const x = r as Partial<DateRange> | null;
  if (!x || !validDate(x.from) || !validDate(x.to)) {
    errors.push(name + " 必须是 YYYY-MM-DD 日期范围");
    return;
  }
  if (x.from > x.to) errors.push(name + ".from 不能晚于 " + name + ".to");
}

export function validateResearchManifest(raw: unknown): string[] {
  const errors: string[] = [];
  const m = raw as Partial<ResearchManifest> | null;
  if (!m || m.schemaVersion !== RESEARCH_SCHEMA_VERSION) errors.push("schemaVersion 必须为 " + RESEARCH_SCHEMA_VERSION);
  if (typeof m?.dataset !== "string" || !m.dataset.trim()) errors.push("dataset 必须是非空字符串");
  if (m?.timezone !== "Asia/Shanghai") errors.push("timezone 必须是 Asia/Shanghai");
  if (m?.priceBasis !== "raw") errors.push("priceBasis 必须是 raw，禁止把复权价当成交价");
  if (!m?.universe?.pointInTime || m.universe.format !== "date-json" || m.universe.asOfTime !== "14:45")
    errors.push("universe 必须是 14:45 的 point-in-time date-json");
  if (!m?.daily?.pointInTime || m.daily.format !== "code-json") errors.push("daily 必须标记 point-in-time 且使用 code-json");
  if (m?.minutes?.format !== "date-code-json" || m.minutes.intervalMinutes !== 1)
    errors.push("minutes 必须使用 1 分钟 date-code-json");
  for (const [name, source] of [
    ["universe.source", m?.universe?.source],
    ["daily.source", m?.daily?.source],
    ["minutes.source", m?.minutes?.source],
  ] as const) {
    if (typeof source !== "string" || !source.trim()) errors.push(name + " 必须记录来源和版本");
  }
  if (typeof m?.universe?.source === "string" && /reconstructed|bootstrap|eod/i.test(m.universe.source)) {
    errors.push("universe.source 不能使用全天收盘重建或 bootstrap 数据");
  }
  for (const [name, section] of [
    ["universe.path", m?.universe?.path],
    ["daily.path", m?.daily?.path],
    ["minutes.path", m?.minutes?.path],
  ] as const) {
    if (!validRelativePath(section)) errors.push(name + " 必须是安全的相对路径");
  }
  if (m?.execution?.entryTime !== "14:45") errors.push("execution.entryTime 必须是 14:45");
  if (m?.execution?.entryPrice !== "ask" || m.execution.exitPrice !== "bid")
    errors.push("执行价格必须使用 entry=ask、exit=bid");
  if (!(m?.execution?.maxBarAgeSeconds && m.execution.maxBarAgeSeconds <= 60))
    errors.push("maxBarAgeSeconds 必须为 1-60 秒");
  if (m?.execution?.decisionIntervalMinutes !== 1) errors.push("execution.decisionIntervalMinutes 必须为 1");
  if (m?.labels?.policy !== "jev-autonomous") errors.push("labels.policy 必须是 jev-autonomous");
  if (m?.labels?.censoring !== "right") errors.push("labels.censoring 必须是 right");

  const train = m?.splits?.train;
  const validation = m?.splits?.validation;
  const test = m?.splits?.test;
  rangeError("splits.train", train, errors);
  rangeError("splits.validation", validation, errors);
  rangeError("splits.test", test, errors);
  if (train && validation && test && validDate(train.to) && validDate(validation.from) && validDate(validation.to) && validDate(test.from)) {
    if (train.to >= validation.from) errors.push("train 与 validation 日期重叠或顺序错误");
    if (validation.to >= test.from) errors.push("validation 与 test 日期重叠或顺序错误");
  }
  return errors;
}

export function researchRoot(dataDir = config.dataDir): string {
  return join(dataDir, RESEARCH_DIR_NAME);
}

export function dateInRange(date: string, range: DateRange): boolean {
  return validDate(date) && date >= range.from && date <= range.to;
}

/** 返回 manifest 所声明的 split 名称，供 runner 做严格隔离。 */
export function splitRange(manifest: ResearchManifest, split: ResearchSplitName): DateRange {
  return manifest.splits[split];
}

/** 只有入场和标签退出都落在同一段内，样本才允许进入该 split。 */
export function splitForTrade(
  manifest: ResearchManifest,
  entryDate: string,
  exitDate: string,
): ResearchSplitName | null {
  if (!validDate(entryDate) || !validDate(exitDate) || entryDate > exitDate) return null;
  const entries: [ResearchSplitName, DateRange][] = [
    ["train", manifest.splits.train],
    ["validation", manifest.splits.validation],
    ["test", manifest.splits.test],
  ];
  for (const [name, range] of entries) {
    if (entryDate >= range.from && exitDate <= range.to) return name;
  }
  return null;
}

export async function inspectResearchDataset(dataDir = config.dataDir): Promise<ResearchInspection> {
  const root = researchRoot(dataDir);
  const manifestPath = join(root, "manifest.json");
  const errors: string[] = [];
  let manifest: ResearchManifest | null = null;
  try {
    const raw = await Bun.file(manifestPath).json();
    errors.push(...validateResearchManifest(raw));
    if (!errors.length) manifest = raw as ResearchManifest;
  } catch {
    errors.push("缺少 " + manifestPath);
  }

  let universeSnapshots = 0;
  let invalidUniverseSnapshots = 0;
  let dailyFiles = 0;
  let minuteDateDirs = 0;
  let minuteFiles = 0;
  if (manifest) {
    const universeRoot = join(root, manifest.universe.path);
    const dailyRoot = join(root, manifest.daily.path);
    const minuteRoot = join(root, manifest.minutes.path);
    for await (const f of new Bun.Glob("*.json").scan({ cwd: universeRoot, onlyFiles: true })) {
      if (!validDate(f.replace(/\.json$/, ""))) continue;
      try {
        const snapshot = await Bun.file(join(universeRoot, f)).json() as Partial<ResearchUniverseSnapshot>;
        if (snapshot.date !== f.replace(/\.json$/, "") || snapshot.asOf !== "14:45" || !Array.isArray(snapshot.entries)) {
          invalidUniverseSnapshots++;
          continue;
        }
        universeSnapshots++;
      } catch {
        invalidUniverseSnapshots++;
      }
    }
    for await (const _ of new Bun.Glob("*.json").scan({ cwd: dailyRoot, onlyFiles: true })) dailyFiles++;
    const minuteDates = new Set<string>();
    for await (const f of new Bun.Glob("*/*.json").scan({ cwd: minuteRoot, onlyFiles: true })) {
      minuteFiles++;
      const date = f.split(/[\\/]/)[0];
      if (date) minuteDates.add(date);
    }
    minuteDateDirs = minuteDates.size;
    if (invalidUniverseSnapshots > 0) errors.push(`有 ${invalidUniverseSnapshots} 份股票池快照不是 14:45 PIT`);
    if (universeSnapshots === 0) errors.push("没有 point-in-time universe snapshot");
    if (dailyFiles === 0) errors.push("没有 point-in-time raw daily 文件");
    if (minuteDateDirs === 0 || minuteFiles === 0) errors.push("没有分钟级数据文件");
  }
  return { manifestPath, manifest, errors, universeSnapshots, invalidUniverseSnapshots, dailyFiles, minuteDateDirs, minuteFiles };
}

export async function assertResearchReady(dataDir = config.dataDir): Promise<ResearchManifest> {
  const report = await inspectResearchDataset(dataDir);
  if (report.errors.length) {
    throw new Error(
      "研究回测数据链路未就绪，已阻止旧日线回测：\n- " + report.errors.join("\n- "),
    );
  }
  return report.manifest!;
}

export async function loadUniverseSnapshot(date: string, manifest: ResearchManifest, dataDir = config.dataDir): Promise<ResearchUniverseSnapshot> {
  if (!validDate(date)) throw new Error("非法研究日期：" + date);
  const path = join(researchRoot(dataDir), manifest.universe.path, date + ".json");
  const snapshot = (await Bun.file(path).json()) as ResearchUniverseSnapshot;
  if (snapshot.date !== date || snapshot.asOf !== manifest.universe.asOfTime || snapshot.source.length === 0 || !Array.isArray(snapshot.entries))
    throw new Error("股票池快照不符合协议：" + path);
  return snapshot;
}

export async function loadDailyBars(
  code: string,
  manifest: ResearchManifest,
  dataDir = config.dataDir,
): Promise<ResearchDailyBar[]> {
  if (!/^\d{6}$/.test(code)) throw new Error("非法日线数据键：" + code);
  const path = join(researchRoot(dataDir), manifest.daily.path, code + ".json");
  const bars = (await Bun.file(path).json()) as ResearchDailyBar[];
  if (!Array.isArray(bars) || bars.length === 0) throw new Error("原始日线为空或格式错误：" + path);
  let previous = "";
  for (const b of bars) {
    if (
      !b ||
      !validDate(b.date) ||
      b.date <= previous ||
      !(b.close > 0) ||
      !(b.open > 0) ||
      !(b.high > 0) ||
      !(b.low > 0) ||
      !Number.isFinite(b.volumeHands) ||
      !Number.isFinite(b.amountYuan) ||
      b.amountEst === true
    ) {
      throw new Error("原始日线包含非 raw/非递增行：" + path);
    }
    previous = b.date;
  }
  return bars;
}

export async function listResearchDates(
  manifest: ResearchManifest,
  dataDir = config.dataDir,
): Promise<string[]> {
  const cwd = join(researchRoot(dataDir), manifest.universe.path);
  const dates: string[] = [];
  for await (const file of new Bun.Glob("*.json").scan({ cwd, onlyFiles: true })) {
    const date = file.replace(/\.json$/, "");
    if (validDate(date)) dates.push(date);
  }
  return dates.sort();
}

export async function loadMinuteBars(
  date: string,
  code: string,
  manifest: ResearchManifest,
  dataDir = config.dataDir,
): Promise<ResearchMinuteBar[]> {
  if (!validDate(date) || !/^\d{6}$/.test(code)) throw new Error("非法分钟数据键：" + date + "/" + code);
  const path = join(researchRoot(dataDir), manifest.minutes.path, date, code + ".json");
  const bars = (await Bun.file(path).json()) as ResearchMinuteBar[];
  if (!Array.isArray(bars) || bars.length === 0) throw new Error("分钟数据为空或格式错误：" + path);
  let previous = "";
  for (const b of bars) {
    if (
      b.date !== date ||
      !HHMM.test(b.time) ||
      b.time < "09:30" ||
      b.time > "15:00" ||
      b.time <= previous ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      !(b.open > 0) ||
      !(b.high > 0) ||
      !(b.low > 0) ||
      !(b.close > 0) ||
      !Number.isFinite(b.volumeShares) ||
      b.volumeShares < 0 ||
      !Number.isFinite(b.amountYuan) ||
      b.amountYuan < 0 ||
      !Number.isFinite(b.ask) ||
      b.ask < 0 ||
      !Number.isFinite(b.bid) ||
      b.bid < 0 ||
      !Number.isFinite(b.askSize) ||
      b.askSize < 0 ||
      !Number.isFinite(b.bidSize) ||
      b.bidSize < 0 ||
      !Number.isFinite(b.volumeRatio) ||
      !Number.isFinite(b.turnoverPct) ||
      !Number.isFinite(b.mcapYi) ||
      !Number.isFinite(b.floatMcapYi) ||
      typeof b.suspended !== "boolean" ||
      typeof b.oneLineUp !== "boolean" ||
      typeof b.oneLineDown !== "boolean"
    )
      throw new Error("分钟数据包含不可执行行：" + path);
    previous = b.time;
  }
  return bars;
}

/**
 * 从已有 raw 日线重建"逐交易日 point-in-time 股票池"。
 *
 * 为什么需要：研究 runner 是按 loader.loadUniverse(date) 逐日取池的，只有今天一份快照时，
 * 把今天的榜单回放历史 = 用"未来的赢家"选过去（幸存者偏差）。这里改成每一天只用
 * "当日收盘已可见"的成交额排名选池，买在次日 —— 时点正确。
 *
 * 诚实标注的残余偏差（无法用免费日线消除，只能靠 source 字符串显式记录）：
 *   - 退市股不在候选集里（我们只有当下这一批票的历史），所以仍是"有限幸存者"池；
 *   - 历史某日是否为 ST 无法还原（只有今天的名字），故当日 active 一律按"有 bar 即可交易"判。
 * 要彻底消除，需要全市场含退市的日线源（付费）；当前口径是免费能达到的最严 PIT。
 */
export interface PitUniverseReconstructOpts {
  /** 每个交易日取成交额最高的前 N 只 */
  topN: number;
  /** code -> 升序 raw 日线（必须已通过 loadDailyBars 的递增/正价校验） */
  dailyByCode: Map<string, ResearchDailyBar[]>;
  /** 可选 code -> 名称表（仅供面板展示，不参与排名） */
  names?: Map<string, string>;
  /** 写进快照 source 字段，说明这份池子怎么来的、有什么残余偏差 */
  source: string;
}

/** 所有出现过的交易日（升序、去重）。 */
export function collectResearchDates(dailyByCode: Map<string, ResearchDailyBar[]>): string[] {
  const set = new Set<string>();
  for (const bars of dailyByCode.values()) for (const b of bars) set.add(b.date);
  return [...set].sort();
}

/** 返回 date -> 该日 PIT 股票池快照。空池的日子（全市场无 bar）不会出现在结果里。 */
export function reconstructPitUniverse(
  dates: string[],
  opts: PitUniverseReconstructOpts,
): Map<string, ResearchUniverseSnapshot> {
  const { topN, dailyByCode, names, source } = opts;
  // 预建 code -> (date -> bar) 与 code -> 升序 dates，O(1) 取当日 bar 与昨收
  const byDate = new Map<string, Map<string, ResearchDailyBar>>();
  const ordered = new Map<string, string[]>();
  for (const [code, bars] of dailyByCode) {
    const m = new Map<string, ResearchDailyBar>();
    const ds: string[] = [];
    for (const b of bars) {
      m.set(b.date, b);
      ds.push(b.date);
    }
    byDate.set(code, m);
    ordered.set(code, ds);
  }
  const codes = [...dailyByCode.keys()];
  const out = new Map<string, ResearchUniverseSnapshot>();

  for (const date of dates) {
    type Cand = { code: string; amountYuan: number; prevClose: number };
    const cands: Cand[] = [];
    for (const code of codes) {
      const day = byDate.get(code)?.get(date);
      if (!day || !(day.amountYuan > 0)) continue; // 当日无成交/无 bar = 不可交易
      const ds = ordered.get(code)!;
      const idx = ds.indexOf(date);
      if (idx <= 0) continue; // 上市首日（无前收）不进池
      const prev = byDate.get(code)!.get(ds[idx - 1]!);
      if (!prev || !(prev.close > 0)) continue;
      cands.push({ code, amountYuan: day.amountYuan, prevClose: prev.close });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => b.amountYuan - a.amountYuan || a.code.localeCompare(b.code));
    const entries: ResearchUniverseEntry[] = cands.slice(0, topN).map((c) => ({
      code: c.code,
      name: names?.get(c.code) ?? "",
      active: true,
      prevClose: c.prevClose,
    }));
    // 这是收盘后重建的 bootstrap 结果，故意不伪装成 14:45 PIT；
    // 生产 loader 会拒绝它，真实快照必须由 14:45 现场采集或带历史版本的供应商导出。
    out.set(date, { date, asOf: "14:45", source, entries });
  }
  return out;
}
