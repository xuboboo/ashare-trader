/**
 * 探针 2：全市场榜单（universe 来源）备选方案。结果写 data/probe2.txt
 * 用法：bun run scripts/probe2.ts
 */
import { mkdir } from "node:fs/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const out: string[] = [];
const log = (s: string) => out.push(s);

async function tryGet(url: string, headers: Record<string, string>, label: string, cut = 700) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    const text = await r.text();
    log(`--- ${label} [${r.status}] ${Math.round(performance.now() - t0)}ms ${text.length}B`);
    log(text.replace(/\s+/g, " ").slice(0, cut));
  } catch (e) {
    log(`--- ${label} 失败 ${Math.round(performance.now() - t0)}ms: ${(e as Error).message}`);
  }
  log("");
}

const EM = { Referer: "https://quote.eastmoney.com/" };
const SINA = { Referer: "https://finance.sina.com.cn/" };

async function main() {
  const fields = "f12,f14,f2,f3,f6,f8,f10,f20,f21,f62";
  await tryGet(
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:1+t:2&fields=${fields}`,
    EM,
    "东财 clist 只有沪市主板 fs",
  );
  await tryGet(
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fid=f6&wbp2=2050688&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=${fields}`,
    EM,
    "东财 clist 带 ut/wbp2 去掉 np",
  );
  await tryGet(
    `https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=${fields}`,
    EM,
    "东财 82.push2 编号子域",
  );
  await tryGet(
    `https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=${fields}`,
    EM,
    "东财 push2delay",
  );
  await tryGet(
    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=5&sort=amount&asc=0&node=hs_a&symbol=&_s_r_a=init",
    SINA,
    "新浪 Market_Center 按成交额",
  );
  await tryGet(
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=5&p=1&t=01/averatio&ordertype=desc",
    { Referer: "https://gu.qq.com/" },
    "腾讯 appstock rank",
  );
  await tryGet(
    "https://qt.gtimg.cn/q=sh600000,sz000001,sz300750",
    { Referer: "https://gu.qq.com/" },
    "腾讯批量（GBK 走 arrayBuffer 解码，这里看原始长度）",
  );

  await mkdir("data", { recursive: true });
  await Bun.write("data/probe2.txt", out.join("\n"));
  console.log("written data/probe2.txt");
}

main();
