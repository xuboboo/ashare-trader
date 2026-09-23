import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { buyDecisionDue, cheapestLotCost, premarketFullPool, remainingSlots } from "../src/engine";
import type { Scored } from "../src/factors";

/**
 * 全程决策调度：盘前每日一次预选，连续竞价全程按节奏，其余时段不跑。
 * 时钟全部显式注入，测试不依赖真实时间。
 */
const base = {
  force: false,
  trading: true,
  liveNow: true, // liveQuotes(phase) = continuous
  usable: true,
  scoredCount: 10,
  minutes: 600, // 10:00
  preBuyDone: false,
  lastBuyMs: 0,
  nowMs: 1_000_000,
  codesChanged: false,
};

describe("买入决策调度（盘前预选 + 全程节奏）", () => {
  test("连续竞价：首次必跑，之后按 DECIDE_EVERY_MS 节奏（随环境可变）", () => {
    expect(buyDecisionDue(base)).toBe(true); // lastBuyMs=0 → 从未跑过
    const ran = { ...base, lastBuyMs: 1_000_000 };
    expect(buyDecisionDue(ran)).toBe(false); // 刚跑过
    const cad = config.decideEveryMs;
    expect(buyDecisionDue({ ...ran, nowMs: ran.lastBuyMs + cad - 1 })).toBe(false);
    expect(buyDecisionDue({ ...ran, nowMs: ran.lastBuyMs + cad })).toBe(true);
  });

  test("盘前预选：竞价定型后（09:25-09:30）每日只跑一次", () => {
    const pre = { ...base, minutes: 566 }; // 09:26，竞价已定型
    expect(buyDecisionDue(pre)).toBe(true);
    expect(buyDecisionDue({ ...pre, preBuyDone: true })).toBe(false);
    expect(buyDecisionDue({ ...pre, minutes: 568, preBuyDone: true })).toBe(false); // 09:28 也不再跑
    expect(buyDecisionDue({ ...base, minutes: 545, liveNow: false })).toBe(false); // 09:05 竞价未定型，无活价
  });

  test("开盘稳定期：窗口内不出新买入单，窗口外恢复（随 OPEN_DELAY_MIN 可变）", () => {
    const delay = config.openDelayMin;
    if (delay > 0) {
      // 设了稳定期：09:31（开盘后 1 分钟）在窗口内 → 不出买入单
      expect(buyDecisionDue({ ...base, minutes: 571 })).toBe(false);
      expect(buyDecisionDue({ ...base, minutes: 570 + delay - 1 })).toBe(false);
    } else {
      // 稳定期=0（2026-09-23 用户拍板）：09:31 开盘即可按节奏决策
      expect(buyDecisionDue({ ...base, minutes: 571 })).toBe(true);
    }
    // 稳定期结束的那一分钟起，一定恢复决策
    expect(buyDecisionDue({ ...base, minutes: 570 + delay + 1 })).toBe(true);
  });

  test("集合竞价/午休/收盘竞价不跑买入（价格不可靠）", () => {
    // 午休：liveNow=false
    expect(buyDecisionDue({ ...base, liveNow: false })).toBe(false);
  });

  test("行情不新鲜不跑；没有候选不跑；非交易日只在 force 时跑（复盘）", () => {
    expect(buyDecisionDue({ ...base, usable: false })).toBe(false);
    expect(buyDecisionDue({ ...base, scoredCount: 0 })).toBe(false);
    expect(buyDecisionDue({ ...base, trading: false })).toBe(false);
    expect(buyDecisionDue({ ...base, trading: false, force: true })).toBe(true);
  });

  test("候选集变化（新票进区间）→ 15 秒内立即响应，不受常规节奏限制", () => {
    const ran = { ...base, lastBuyMs: 1_000_000 };
    // 20 秒前刚决策过，但有新票冲进区间 → "看情况"立即再决策（20s > 15s 下限）
    expect(buyDecisionDue({ ...ran, codesChanged: true, nowMs: ran.lastBuyMs + 20_000 })).toBe(true);
    // 候选集没变 → 守 DECIDE_EVERY_MS 节奏（具体值随 .env 变，所以只比阈值本身）
    const cad = config.decideEveryMs;
    expect(buyDecisionDue({ ...ran, codesChanged: false, nowMs: ran.lastBuyMs + cad })).toBe(true);
    expect(buyDecisionDue({ ...ran, codesChanged: false, nowMs: ran.lastBuyMs + cad - 1 })).toBe(false);
    // 事件触发也有 15 秒下限，防 API 哄抢
    expect(buyDecisionDue({ ...ran, codesChanged: true, nowMs: ran.lastBuyMs + 5_000 })).toBe(false);
  });

  test("事件触发不得绕过行情新鲜度（拿隔夜快照问模型 = 落不了地的单）", () => {
    const ran = { ...base, lastBuyMs: 1_000_000 };
    const late = { ...ran, codesChanged: true, nowMs: ran.lastBuyMs + 60_000 }; // 远超 15s 下限
    expect(buyDecisionDue(late)).toBe(true); // 前提：新鲜时确实会跑
    expect(buyDecisionDue({ ...late, usable: false })).toBe(false); // 行情不新鲜
    expect(buyDecisionDue({ ...late, liveNow: false })).toBe(false); // 不在连续竞价
  });

  test("盘前窗口需要全池行情（09:29 那次预选只看 60 支旧缓存，eligible 恒为空）", () => {
    expect(premarketFullPool(565)).toBe(true); // 09:25 竞价定型
    expect(premarketFullPool(569)).toBe(true); // 09:29
    expect(premarketFullPool(564)).toBe(false); // 09:24 竞价未定型
    expect(premarketFullPool(570)).toBe(false); // 09:30 已开盘，连续竞价分支全量拉
    expect(premarketFullPool(700)).toBe(false); // 午休
  });

describe("并发持仓上限（MAX_POSITIONS，0=不限）", () => {
  test("不限仓：只剩当日开仓余量在约束", () => {
    expect(remainingSlots(4, 3, 0)).toBe(4);
    expect(remainingSlots(0, 3, 0)).toBe(0);
  });

  test("设了上限：持仓已满 -> 0；未满 -> 当日余量与剩余槽位取小（旧的最多 3 仓行为）", () => {
    expect(remainingSlots(4, 3, 3)).toBe(0);
    expect(remainingSlots(4, 1, 3)).toBe(2);
    expect(remainingSlots(1, 1, 3)).toBe(1);
  });

  test("手工回填让持仓超过上限时不出负数", () => {
    expect(remainingSlots(4, 5, 3)).toBe(0);
  });
});

describe("现金闸（买不起最便宜的一手就不问模型）", () => {
  const cand = (price: number) =>
    ({ features: { price, code: "600000", name: "测" }, score: 1, reasons: [], rejects: [] }) as unknown as Scored;

  test("取可买候选的最低一手，另预留最低佣金", () => {
    expect(cheapestLotCost([cand(30), cand(3)])).toBe(305); // 3 元 × 100 股 + 5 元最低佣金
  });

  test("候选全被否决 -> 0（那种情况本来就会在别处跳过，不该拦住卖出）", () => {
    const rejected = { ...cand(3), rejects: ["停牌"] } as unknown as Scored;
    expect(cheapestLotCost([rejected])).toBe(0);
  });
});

  test("force 无视一切节奏（手动 /scan 随时可看一轮决策）", () => {
    expect(buyDecisionDue({ ...base, lastBuyMs: 1_000_000, force: true })).toBe(true);
    expect(buyDecisionDue({ ...base, usable: false, force: true })).toBe(true);
  });
});
