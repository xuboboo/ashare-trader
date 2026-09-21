import { describe, expect, test } from "bun:test";
import { marketGate, ZT_ICE_AGE } from "../src/factors";
import { lotAwareHalfQty } from "../src/symbols";
import { tradingElapsedMin } from "../src/session";

const alive = { price: 3926, amountYi: 900 };
const above = 3900;

describe("大盘闸门：盘中成交额按节奏折算", () => {
  test("早盘 5 分钟成交 900 亿远低于全天阈值，但按节奏折算后通过", () => {
    const r = marketGate(alive, above, 28, 5);
    expect(r.allowed).toBe(true);
    expect(r.reasons[0]).toContain("闸门通过");
  });

  test("同额收盘口径（不传开盘分钟数）维持原行为：低于 3000 亿即关", () => {
    const r = marketGate(alive, above, 28);
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toContain("成交额");
  });

  test("开盘 60 分钟阈值折算到 750 亿；节奏过慢照样关", () => {
    expect(marketGate({ price: 3926, amountYi: 800 }, above, 28, 60).allowed).toBe(true);
    expect(marketGate({ price: 3926, amountYi: 500 }, above, 28, 60).allowed).toBe(false);
  });

  test("下午 13:00 起重新计节奏；超过 240 分钟封顶为全天阈值", () => {
    expect(marketGate({ price: 3926, amountYi: 1200 }, above, 28, 30).allowed).toBe(true);
    expect(marketGate({ price: 3926, amountYi: 2500 }, above, 28, 300).allowed).toBe(false); // 300 分钟已封顶 3000 亿
  });

  test("其他否决项不受折算影响：跌破 5 日线照关（哪怕刚刚开盘）", () => {
    expect(marketGate({ price: 3800, amountYi: 900 }, 3885, 28, 5).allowed).toBe(false);
  });

  /**
   * 涨停家数同样是当日累计量（一天里只会单调增多）。固定 20 家在 09:31 几乎不可能达到，
   * 那会把"今天能不能买"变成"每天开盘后一小时不准买" —— 永久假阳性。
   * 同一个 10 家：早盘该开，尾盘该关。
   */
  test("同一个涨停数，该开的时候开、该关的时候关", () => {
    const open931 = marketGate({ price: 3926, amountYi: 900 }, above, 10, tradingElapsedMin(571)!); // 09:31
    expect(open931.allowed).toBe(true);
    const at1440 = marketGate({ price: 3926, amountYi: 900 }, above, 10, tradingElapsedMin(880)!); // 14:40
    expect(at1440.allowed).toBe(false);
    expect(at1440.reasons.join()).toContain("此时应达");
    // 冰点就是冰点：哪怕刚开盘，0 家也该关
    expect(marketGate({ price: 3926, amountYi: 900 }, above, 0, tradingElapsedMin(575)!).allowed).toBe(false);
    // 全天口径（回测/盘前）维持原设计：不足 ZT_ICE_AGE 家就关
    expect(marketGate({ price: 3926, amountYi: 900 }, above, ZT_ICE_AGE - 1).allowed).toBe(false);
  });

  test("没能评估的否决项必须说出来，绝不静默跳过", () => {
    // 成交额给足（9000 亿 > 此时折算阈值），只留下“没数据”的两项
    const g = marketGate({ price: 3926, amountYi: 9000 }, null, null, 220);
    expect(g.allowed).toBe(true); // 无数据时不否决（fail-open）
    expect(g.skipped!.join()).toContain("5 日线缺失");
    expect(g.skipped!.join()).toContain("涨停家数未采集");
    // 但“不知道”必须可见：尾盘应达家数一并报出，方便人工判断要不要自己再看一眼
    expect(g.skipped!.join()).toContain("当前应达");
    // 成交额自己也缺失时，同样要报出来而不是默默通过
    expect(marketGate({ price: 3926, amountYi: 0 }, 3900, 60, 220).skipped!.join()).toContain("指数成交额缺失");
  });

  test("收盘后的结论是 idle：不能显示成“闸门开”骗人", () => {
    const idle = marketGate({ price: 3926, amountYi: 9468 }, above, 60, tradingElapsedMin(999)!, { live: false });
    expect(idle.status).toBe("idle");
    expect(idle.allowed).toBe(true); // allowed 仍然可用（盘前预选靠它），但时效已经标掉
    expect(idle.reasons.at(-1)).toContain("仅作复盘");
    // 同样的数据在窗口内才是 open；否决命中时是 closed
    expect(marketGate({ price: 3926, amountYi: 9468 }, above, 60, 220, { live: true }).status).toBe("open");
    expect(marketGate({ price: 3800, amountYi: 9468 }, above, 60, 220, { live: true }).status).toBe("closed");
    // 不传 ctx 时默认看 allowed，保持旧行为（回测等离线调用不需要时效）
    expect(marketGate({ price: 3926, amountYi: 9468 }, above, 60, 220).status).toBe("open");
  });
});

describe("整手约束的卖一半（lotAwareHalfQty）", () => {
  test("向下取整到手；300 卖 100；100 无法分批返回 0", () => {
    expect(lotAwareHalfQty(200)).toBe(100);
    expect(lotAwareHalfQty(400)).toBe(200);
    expect(lotAwareHalfQty(300)).toBe(100);
    expect(lotAwareHalfQty(100)).toBe(0);
  });
});
