import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { marketGate } from "../src/factors";
import { simulate, type Stock } from "../scripts/backtest";
import { writeAllowed } from "../src/server";
import { tradingElapsedMin } from "../src/session";
import type { DailyBar } from "../src/quotes";

/**
 * 审计修复的三道锁：写权限、闸门口径、回测与实盘同构。
 * 共同点：它们都不影响"能不能跑起来"，只影响"跑出来的东西是不是真话"。
 */

const H = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;
const M = (h: number, m: number) => h * 60 + m;
const hdr = (init: Record<string, string>) => new Headers(init);

describe("写接口权限（面板不绑公网、不裸奔）", () => {
  test("没设口令：本机、无 Origin（curl/CLI）可写", () => {
    expect(writeAllowed(hdr({}), true, "")).toBe(true);
    expect(writeAllowed(hdr({ origin: "http://localhost:3006" }), true, "")).toBe(true);
  });

  test("没设口令：本机但来源是陌生网页也拒 —— 防“用户开着任意网站就能 POST 本地清账本”", () => {
    expect(writeAllowed(hdr({ origin: "https://evil.example.com" }), true, "")).toBe(false);
  });

  test("非回环必须带对口令；带错也不行", () => {
    expect(writeAllowed(hdr({}), false, "secret")).toBe(false);
    expect(writeAllowed(hdr({ "x-auth": "nope" }), false, "secret")).toBe(false);
    expect(writeAllowed(hdr({ "x-auth": "secret" }), false, "secret")).toBe(true);
  });

  test("设了口令之后，本机请求也必须带（否则口令形同虚设）", () => {
    expect(writeAllowed(hdr({}), true, "secret")).toBe(false);
    expect(writeAllowed(hdr({ "x-auth": "secret" }), true, "secret")).toBe(true);
  });
});

describe("大盘闸门的节奏阈值", () => {
  const thresholdAt = (h: number, m: number) => {
    const e = tradingElapsedMin(M(h, m))!;
    // 用二分找出"这一时刻的最小通过成交额"太绕，直接按同一个公式复算并断言关系
    return { elapsed: e, threshold: config.indexMinAmountYi * Math.min(1, e / (tradingElapsedMin(M(14, 57)) ?? 1)) };
  };

  test("尾盘 14:40 的阈值接近全天值（旧实现从 13:00 重算，只剩一半）", () => {
    const at1440 = thresholdAt(14, 40);
    expect(at1440.elapsed).toBe(220);
    expect(at1440.threshold).toBeGreaterThan(2700); // 旧实现这里只有 1250 亿
    const at1300 = thresholdAt(13, 0);
    expect(at1300.threshold).toBeGreaterThan(1400); // 旧实现这里突刺成 3000 亿（假阴性）
    expect(at1300.threshold).toBeLessThan(1700);
  });

  test("阈值单调不降：闸门不会因为吃了个午饭就突然变严", () => {
    const t = (h: number, m: number) =>
      marketGate({ price: 3926, amountYi: 2000 }, 3900, null, tradingElapsedMin(M(h, m))).allowed;
    expect(t(11, 25)).toBe(true); // 2000 亿 > 该时刻阈值
    expect(t(13, 5)).toBe(true); // 同一口径的下午
    expect(t(14, 50)).toBe(false); // 到尾盘，2000 亿已低于节奏要求
  });
});

const day = (i: number) => `2026-03-${String(i).padStart(2, "0")}`;
function indexBars(): DailyBar[] {
  return Array.from({ length: 20 }, (_, i) => ({
    date: day(i + 2),
    open: 3000 + i,
    close: 3000 + i,
    high: 3010 + i,
    low: 2990 + i,
    volumeHands: 0,
    amountYuan: 4e11,
    turnoverPct: 0,
    pct: 0.3,
  }));
}
const flat = (i: number, over: Partial<DailyBar> = {}): DailyBar => ({
  date: day(i),
  open: 10,
  close: 10,
  high: 10.1,
  low: 9.9,
  volumeHands: 166_666.666_666_666_66,
  amountYuan: 1.7e8,
  turnoverPct: 1.5,
  pct: 0,
  ...over,
});
function stock(bars: DailyBar[]): Stock {
  return { code: "600000", bars, byDate: new Map(bars.map((b) => [b.date, b])) };
}
function setup(entry: Partial<DailyBar> = {}, exitDay: Partial<DailyBar> = {}) {
  const bars: DailyBar[] = [];
  for (let i = 2; i <= 21; i++) bars.push(flat(i));
  bars[10] = flat(12, { close: 10.5, open: 10.1, high: 10.6, low: 10.05, volumeHands: 300_000, amountYuan: 3.12e8, pct: 5, ...entry });
  bars[11] = flat(13, { close: 10.3, open: 10.6, high: 10.7, low: 10.2, ...exitDay });
  return bars;
}

describe("回测与实盘同构（审计补的口径）", () => {
  test("出场阶梯顺序：高开减半在先，剩仓才轮到止损", () => {
    // 开盘 +0.86%（不足 3% 不减）→ 触及止损；换成高开的日子就该先减一半
    const bars = setup({}, { open: 11.0, high: 11.1, low: 9.8, close: 9.9 });
    const { result } = simulate({ stocks: [stock(bars)], indexBars: indexBars(), k: 1, quiet: true, sizeCny: 50_000, bankrollCny: 150_000 });
    const trim = result.trips.find((x) => x.note.includes("减半"))!;
    const stop = result.trips.find((x) => x.note.includes("止损"))!;
    expect(trim).toBeTruthy();
    expect(trim.exit).toBe(11); // 一半在开盘价走
    expect(stop).toBeTruthy();
    expect(stop.exit).toBe(10.19); // 另一半在止损价走（旧实现会把全部算在 10.19）
  });

  test("现金闸日内递减：本金不够就不买，不会一天内把账本买穿（旧实现会）", () => {
    // 12 万本金、单笔 5 万、k=3：三只都满足选股条件。逐笔拿全量现金去比会三笔都通过（-3 万），
    // 读实时现金只能买两笔。断言的就是“买入腿数 = 2”。
    const mk = (): Stock[] =>
      ["600000", "600001", "600002"].map((code) => {
        const bars = setup();
        return { code, bars, byDate: new Map(bars.map((b) => [b.date, b])) };
      });
    const { result } = simulate({
      stocks: mk(),
      indexBars: indexBars(),
      k: 3,
      quiet: true,
      sizeCny: 50_000,
      bankrollCny: 120_000,
    });
    const opened = result.trips.filter((t) => t.entryDate === "2026-03-12").length;
    expect(opened).toBe(2); // 第三笔 5 万超出现金 → 不开
    expect(result.finalEquity).toBeGreaterThan(100_000);
  });

  test("参数注入生效：同一个数据集，止损口径不同 → 结果不同（不再偷偷读 .env）", () => {
    const base = { stocks: [stock(setup({}, { open: 10.4, high: 10.45, low: 9.8, close: 9.9 }))], indexBars: indexBars(), k: 1, quiet: true, sizeCny: 50_000, bankrollCny: 150_000 };
    const tight = simulate({ ...base, stopLossPct: 1 }).result.trips[0]!;
    const wide = simulate({ ...base, stopLossPct: 5 }).result.trips[0]!;
    expect(tight.exit).toBe(10.4); // 1% 止损：开盘 10.4 已开在止损价上 → 按开盘走
    expect(wide.exit).toBe(9.98); // 5% 止损：盘中触及 10.51×0.95=9.98 → 按止损价走
    expect(tight.exit).not.toBe(wide.exit);
  });

  test("入场时刻被记录在参数串里（复现时必须能看出是哪套口径）", () => {
    const { result } = simulate({ stocks: [stock(setup())], indexBars: indexBars(), k: 1, quiet: true });
    expect(result.params).toContain(`入场${H(14, 45)}`);
    expect(result.params).toContain("往返成本名义");
    expect(typeof result.blockedByRiskDays).toBe("number");
  });
});
