import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeResearchSeal,
  verifyResearchSeal,
  writeResearchSeal,
  RESEARCH_SEAL_FILE,
  type SealDirs,
} from "../src/research-integrity";

const root = join(import.meta.dir, "tmp-integrity");
const dirs: SealDirs = {
  researchRoot: root,
  universeDir: join(root, "universe"),
  dailyDir: join(root, "daily"),
  minutesDir: join(root, "minutes"),
};

async function seed() {
  await rm(root, { recursive: true, force: true });
  await mkdir(dirs.universeDir, { recursive: true });
  await mkdir(dirs.dailyDir, { recursive: true });
  await mkdir(join(dirs.minutesDir, "2026-01-02"), { recursive: true });
  await writeFile(join(dirs.universeDir, "2026-01-02.json"), JSON.stringify({ date: "2026-01-02", asOf: "14:45", source: "t", entries: [{ code: "600000", name: "x", active: true }] }));
  await writeFile(join(dirs.dailyDir, "600000.json"), JSON.stringify([{ date: "2026-01-02", open: 1, high: 1, low: 1, close: 1, volumeHands: 1, amountYuan: 1, turnoverPct: 1, pct: 1 }]));
  await writeFile(join(dirs.minutesDir, "2026-01-02", "600000.json"), JSON.stringify([{ date: "2026-01-02", time: "14:45", bid: 10.49, ask: 10.51 }]));
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("研究数据集 sha256 封存", () => {
  test("同一份数据两次计算摘要稳定", async () => {
    await seed();
    const a = await computeResearchSeal(dirs, "deadbeef");
    const b = await computeResearchSeal(dirs, "deadbeef");
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.minutes).toMatch(/^[0-9a-f]{64}$/);
  });

  test("封存后未改动 => verify ok", async () => {
    await seed();
    await writeResearchSeal(dirs, await computeResearchSeal(dirs, "c0ffee"));
    const v = await verifyResearchSeal(dirs);
    expect(v.status).toBe("ok");
    expect(v.drift).toEqual([]);
  });

  test("事后篡改分钟盘口文件 => 检出 minutes 漂移（这正是防补造的机制）", async () => {
    await seed();
    await writeResearchSeal(dirs, await computeResearchSeal(dirs, null));
    // 冒充"历史上不存在的 bid/ask"：塞一条假盘口进去
    await writeFile(join(dirs.minutesDir, "2026-01-02", "600000.json"), JSON.stringify([{ date: "2026-01-02", time: "14:45", bid: 999, ask: 999 }]));
    const v = await verifyResearchSeal(dirs);
    expect(v.status).toBe("drift");
    expect(v.drift).toContain("minutes");
    expect(v.drift).not.toContain("daily");
  });

  test("删除 provenance => 判为 missing（未封存不可信）", async () => {
    await seed();
    await writeResearchSeal(dirs, await computeResearchSeal(dirs, null));
    await rm(join(root, RESEARCH_SEAL_FILE), { force: true });
    const v = await verifyResearchSeal(dirs);
    expect(v.status).toBe("missing");
  });

  test("新增一个交易日的池 => universe 漂移", async () => {
    await seed();
    await writeResearchSeal(dirs, await computeResearchSeal(dirs, null));
    await writeFile(join(dirs.universeDir, "2026-01-03.json"), JSON.stringify({ date: "2026-01-03", asOf: "14:45", source: "t", entries: [] }));
    const v = await verifyResearchSeal(dirs);
    expect(v.status).toBe("drift");
    expect(v.drift).toContain("universe");
  });
});
