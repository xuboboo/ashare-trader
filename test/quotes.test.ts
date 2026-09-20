import { describe, expect, test } from "bun:test";
import { parseKlines, parseTencentRow } from "../src/quotes";

/**
 * 契约测试：用 2026-09-18 真实录制的一行行情锁字段序号。
 * 上游一旦改字段顺序或含义，这里先炸，而不是让因子静默算错。
 */
const RECORDED = `v_sh600000="1~浦发银行~600000~9.07~9.06~9.05~517593~277236~240357~9.07~4467~9.06~11048~9.05~7788~9.04~5161~9.03~4586~9.08~2564~9.09~1316~9.10~2574~9.11~5680~9.12~6306~~20260918161458~0.01~0.11~9.15~9.00~9.07/517593/469969405~517593~46997~0.16~5.90~~9.15~9.00~1.66~3020.84~3020.84~0.40~9.97~8.15~0.74~14610~9.08~4.88~6.04~~~0.01~46996.9405~33.3776~368~   A~GP-A~-24.54~-2.05~4.63~6.14~0.50~13.11~8.07~-3.82~0.22~8.75~33305838300~33305838300~28.37~-20.51~33305838300~~~-26.44~-0.22~~CNY~0~___D__F__N~9.00~19524~";`;

describe("腾讯行情解析（契约）", () => {
  const s = parseTencentRow(RECORDED)!;

  test("基本价位与昨收", () => {
    expect(s).toBeTruthy();
    expect(s.code).toBe("600000");
    expect(s.name).toBe("浦发银行");
    expect(s.price).toBe(9.07);
    expect(s.prevClose).toBe(9.06);
    expect(s.open).toBe(9.05);
    expect(s.high).toBe(9.15);
    expect(s.low).toBe(9);
  });

  test("量额与均价", () => {
    expect(s.volumeHands).toBe(517593);
    expect(s.amountYuan).toBe(469_970_000); // 字段是万元
    expect(s.vwap).toBe(9.08);
    expect(s.turnoverPct).toBe(0.16);
    expect(s.volumeRatio).toBe(0.74);
  });

  test("市值与涨跌停", () => {
    expect(s.floatMcapYi).toBe(3020.84);
    expect(s.mcapYi).toBe(3020.84);
    expect(s.limitUp).toBe(9.97);
    expect(s.limitDown).toBe(8.15);
  });

  test("五档完整", () => {
    expect(s.bids).toHaveLength(5);
    expect(s.asks).toHaveLength(5);
    expect(s.bids[0]).toEqual({ p: 9.07, v: 4467 });
    expect(s.asks[0]).toEqual({ p: 9.08, v: 2564 });
    expect(s.bids[4]).toEqual({ p: 9.03, v: 4586 });
  });

  test("行情日期与状态", () => {
    expect(s.quoteDay).toBe("20260918");
    expect(s.suspended).toBe(false);
    expect(s.oneLineUp).toBe(false);
  });

  test("停牌与坏行", () => {
    expect(parseTencentRow(`v_sh600000="1~测试~600000~0~0~0~0";`)).toBeNull(); // 没昨收，弃用
    const susp = parseTencentRow(RECORDED.replace('"1~浦发银行~600000~9.07', '"1~浦发银行~600000~0'))!;
    expect(susp.suspended).toBe(true);
    expect(susp.price).toBe(9.06); // 停牌时用昨收，别让因子拿到 0 价
    expect(parseTencentRow("garbage")).toBeNull();
  });
});

describe("东财日线解析（契约）", () => {
  const bars = parseKlines([
    "2026-09-17,9.10,9.06,9.14,9.03,456711,414887057.00,1.21,-0.44,-0.04,0.14",
    "2026-09-18,9.05,9.07,9.15,9.00,517593,469969405.00,1.66,0.11,0.01,0.16",
  ]);

  test("字段顺序 日期,开,收,高,低,量,额,振幅,涨跌%,涨跌额,换手", () => {
    expect(bars[1]).toEqual({
      date: "2026-09-18",
      open: 9.05,
      close: 9.07,
      high: 9.15,
      low: 9,
      volumeHands: 517593,
      amountYuan: 469969405,
      turnoverPct: 0.16,
      pct: 0.11,
    });
  });

  test("与腾讯快照的收盘价一致", () => {
    expect(bars[1]!.close).toBe(parseTencentRow(RECORDED)!.price);
  });
});
