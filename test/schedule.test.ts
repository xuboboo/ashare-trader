import { describe, expect, test } from "bun:test";
import { buyDecisionDue } from "../src/engine";

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
};

describe("买入决策调度（盘前预选 + 全程节奏）", () => {
  test("连续竞价：首次必跑，之后按 DECIDE_EVERY_MS 节奏", () => {
    expect(buyDecisionDue(base)).toBe(true); // lastBuyMs=0 → 从未跑过
    const ran = { ...base, lastBuyMs: 1_000_000 };
    expect(buyDecisionDue(ran)).toBe(false); // 刚跑过
    expect(buyDecisionDue({ ...ran, nowMs: ran.lastBuyMs + 59_999 })).toBe(false);
    expect(buyDecisionDue({ ...ran, nowMs: ran.lastBuyMs + 60_000 })).toBe(true);
  });

  test("盘前预选：竞价定型后（09:25-09:30）每日只跑一次", () => {
    const pre = { ...base, minutes: 566 }; // 09:26，竞价已定型
    expect(buyDecisionDue(pre)).toBe(true);
    expect(buyDecisionDue({ ...pre, preBuyDone: true })).toBe(false);
    expect(buyDecisionDue({ ...pre, minutes: 568, preBuyDone: true })).toBe(false); // 09:28 也不再跑
    expect(buyDecisionDue({ ...base, minutes: 545, liveNow: false })).toBe(false); // 09:05 竞价未定型，无活价
  });

  test("开盘稳定期：09:30-09:45 不出新买入单（09:38 那种开盘脉冲单不再出现）", () => {
    expect(buyDecisionDue({ ...base, minutes: 571 })).toBe(false); // 09:31 稳定期内
    expect(buyDecisionDue({ ...base, minutes: 584 })).toBe(false); // 09:44 仍在稳定期
    expect(buyDecisionDue({ ...base, minutes: 586 })).toBe(true); // 09:46 起恢复按节奏决策
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

  test("force 无视一切节奏（手动 /scan 随时可看一轮决策）", () => {
    expect(buyDecisionDue({ ...base, lastBuyMs: 1_000_000, force: true })).toBe(true);
    expect(buyDecisionDue({ ...base, usable: false, force: true })).toBe(true);
  });
});
