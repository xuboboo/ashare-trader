/**
 * 一次性探针：把两个免费行情源的原始字段和实际取值打出来，用来锁定解析器。
 * 用法：bun run scripts/probe.ts   （结果写 data/probe.txt，避免控制台中文乱码）
 */
import { mkdir } from "node:fs/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const HEADERS = { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" };

const out: string[] = [];
const log = (s: string) => {
  out.push(s);
};

async function getJson(url: string, tries = 3): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      return JSON.parse(await r.text());
    } catch (e) {
      last = e;
      await Bun.sleep(600 * (i + 1));
    }
  }
  log(`!! fetch 失败 (${tries} 次): ${(last as Error)?.message ?? last}\n   ${url}`);
  return null;
}

async function main() {
  log("=== TextDecoder gbk ===");
  try {
    log(`gbk ok: ${new TextDecoder("gbk").encoding}`);
  } catch (e) {
    log(`gbk 不支持: ${(e as Error).message}`);
  }

  log("\n=== 东财 ulist.np/get 批量快照 ===");
  log(
    JSON.stringify(
      (await getJson(
        "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.600000,0.000001,0.300750" +
          "&fields=f12,f13,f14,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f15,f16,f17,f18,f20,f21,f22,f23,f24,f25,f62,f184",
      ))?.data?.diff,
      null,
      1,
    ),
  );

  log("\n=== 东财 clist/get 全市场按成交额排行（多种参数组合）===");
  const variants = [
    "pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f6,f8,f10,f20,f21,f62,f184",
    "pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:0+t:6+m:0+t:80+m:1+t:2+m:1+t:23&fields=f12,f14,f2,f3,f6,f8,f10,f20,f21,f62,f184&source=EBWEB",
    "pn=1&pz=5&po=1&dpt=wc&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f6,f8,f10,f20,f21,f62,f184",
  ];
  for (const [i, q] of variants.entries()) {
    const j = await getJson(`https://push2.eastmoney.com/api/qt/clist/get?${q}`);
    log(`variant#${i}: total=${j?.data?.total} diff=${JSON.stringify(j?.data?.diff)?.slice(0, 600)}`);
  }

  log("\n=== 东财 stock/get 单票（找五档与涨跌停字段）===");
  log(
    JSON.stringify(
      (await getJson(
        "https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&secid=1.600000" +
          "&fields=f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f71,f84,f85,f107,f110,f111,f116,f117,f152,f161,f162,f163,f164,f167,f168,f169,f170,f171,f191,f192",
      ))?.data,
      null,
      1,
    ),
  );

  log("\n=== 东财 kline 日线 近5根 ===");
  log(
    JSON.stringify(
      (await getJson(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&klt=101&fqt=1&lmt=5&end=20500101" +
          "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      ))?.data?.klines,
      null,
      1,
    ),
  );

  log("\n=== 东财 涨停池 getTopicZTPool ===");
  log(
    JSON.stringify(
      (await getJson(
        "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=3&sort=fbt%3Aasc&date=20260918",
      ))?.data?.pool,
      null,
      1,
    ),
  );

  log("\n=== 腾讯 qt.gtimg.cn 带五档（GBK，带字段序号）===");
  try {
    const r = await fetch("http://qt.gtimg.cn/q=sh600000,sz000001", { headers: { "User-Agent": UA } });
    const text = new TextDecoder("gbk").decode(new Uint8Array(await r.arrayBuffer()));
    for (const line of text.trim().split("\n")) {
      log(
        line
          .split("~")
          .map((p, i) => `${i}=${p}`)
          .join(" | "),
      );
      log("");
    }
  } catch (e) {
    log(`腾讯失败: ${(e as Error).message}`);
  }

  await mkdir("data", { recursive: true });
  await Bun.write("data/probe.txt", out.join("\n"));
  console.log(`written data/probe.txt (${out.length} sections)`);
}

main();
