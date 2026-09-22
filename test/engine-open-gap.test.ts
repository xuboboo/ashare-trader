import { describe, expect, test } from "bun:test";
import { canOpenNewPosition } from "../src/engine";

describe("新仓冷却（防同一分钟无脑冲多只）", () => {
  const GAP = 300_000; // 5 分钟
  test("距上一笔开仓不足间隔 -> 不许再开", () => {
    expect(canOpenNewPosition(1_000_000, 1_000_000 - 15_000, GAP)).toBe(false); // 15s 前刚开
    expect(canOpenNewPosition(1_000_000, 1_000_000 - 299_999, GAP)).toBe(false);
  });
  test("达到/超过间隔 -> 允许开下一笔", () => {
    expect(canOpenNewPosition(1_000_000, 1_000_000 - GAP, GAP)).toBe(true);
    expect(canOpenNewPosition(1_000_000, 1_000_000 - GAP - 1, GAP)).toBe(true);
  });
  test("首笔（lastOpen=0）永远可开", () => {
    expect(canOpenNewPosition(1_000_000, 0, GAP)).toBe(true);
  });
});
