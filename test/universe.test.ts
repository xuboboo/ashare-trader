import { describe, expect, test } from "bun:test";
import { buildUniverseEntries, type TopEntry } from "../src/universe";

/**
 * 股票池合成的纯函数测试（不碰网络）。
 * 这里钉住的是一次真实事故：榜单填满后自选被 slice 截掉，WATCHLIST 成了死配置。
 */
const top = (code: string, name: string, amountYuan: number): TopEntry => ({ code, name, amountYuan });

/** 300 支成交额递减的沪深主板票（代码全在 inScope 内）。 */
const filledTop = (n: number): TopEntry[] =>
  Array.from({ length: n }, (_, i) => top(String(600000 + i), `股票${i}`, 1e9 - i));

describe("股票池合成：WATCHLIST 必须能进池", () => {
  test("榜单占满 300 席时自选仍然进池（旧实现会被 slice 截掉）", () => {
    const entries = buildUniverseEntries(filledTop(300), ["000001"], 300);
    expect(entries).toHaveLength(300);
    expect(entries.map((e) => e.code)).toContain("000001");
    expect(entries[0]!.code).toBe("000001"); // 自选先占位，不用等榜单
  });

  test("多个自选全部保留，且仍在 inScope/非 ST 的规则内", () => {
    const entries = buildUniverseEntries(filledTop(300), ["000001", "688001", "600519"], 300);
    const codes = entries.map((e) => e.code);
    expect(codes).toContain("000001");
    expect(codes).toContain("600519");
    expect(codes).not.toContain("688001"); // 科创板不进池（既有规则）
  });

  test("自选在榜单里时沿用榜单名字：ST 自选能被识别并排除", () => {
    const entries = buildUniverseEntries([top("000001", "ST平安", 1e8), top("600000", "浦发银行", 2e8)], ["000001"], 10);
    expect(entries.map((e) => e.code)).not.toContain("000001");
    expect(entries.map((e) => e.code)).toContain("600000");
  });

  test("自选不在榜单里时用空名、成交额 0 进池，并受 size 上限约束", () => {
    const entries = buildUniverseEntries([top("600000", "浦发银行", 2e8)], ["000002"], 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ code: "000002", name: "", amountYuan: 0 });
  });

  test("无自选时就是榜单前 N（去重、过滤 ST 与科创板）", () => {
    const entries = buildUniverseEntries(
      [top("600000", "浦发银行", 3e8), top("688001", "科创", 2e8), top("600000", "浦发银行", 1e8), top("000001", "ST平安", 1e8)],
      [],
      10,
    );
    expect(entries.map((e) => e.code)).toEqual(["600000"]);
    expect(entries[0]!.rank).toBe(1);
  });
});
