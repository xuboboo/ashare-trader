/**
 * 量三件事：① 各行情源的传输往返耗时（RTT）② 快照自带的时间戳与当前时刻的差（数据新鲜度）
 * ③ 引擎一轮端到端耗时（读 /history）。收盘后跑的话，②会显示为上一交易日，属预期。
 * 用法：bun run scripts/probe-latency.ts
 */
import { config } from "../src/config";
import { bj } from "../src/session";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const H = { "User-Agent": UA };

interface Sample {
  label: string;
  ms: number[];
  stamp?: string;
  note: string;
}

async function timeIt(label: string, url: string, referer: string, pickStamp?: (t: string) => string | undefined) {
  const ms: number[] = [];
  let stamp: string | undefined;
  let note = "";
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { headers: { ...H, Referer: referer } });
      const buf = new Uint8Array(await r.arrayBuffer());
      const dt = performance.now() - t0;
      if (r.ok) ms.push(dt);
      else note = `HTTP ${r.status}`;
      if (i === 0 && pickStamp) {
        const text = /gbk|gb2312/i.test(r.headers.get("content-type") ?? "")
          ? new TextDecoder("gbk").decode(buf)
          : new TextDecoder().decode(buf);
        stamp = pickStamp(text);
      }
    } catch (e) {
      note = (e as Error).message.slice(0, 40);
    }
    await Bun.sleep(400);
  }
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    label,
    ms,
    stamp,
    note: note || `n=${sorted.length} min ${sorted[0]?.toFixed(0)} 中位 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} max ${sorted.at(-1)?.toFixed(0)} ms`,
  } satisfies Sample;
}

const out: string[] = [];
const p = (s: string) => {
  out.push(s);
  console.log(s);
};

p(`本机北京时间 ${bj().ymd} ${String(bj().hour).padStart(2, "0")}:${String(bj().minute).padStart(2, "0")}:${String(bj().second).padStart(2, "0")}`);

const rows = await Promise.all([
  timeIt(
    "腾讯 实时快照(L1, 五档)",
    "https://qt.gtimg.cn/q=sh600000,sz000001",
    "https://gu.qq.com/",
    (t) => t.split("\n")[0]?.split("~")[30]?.trim(),
  ),
  timeIt("东财 批量快照(ulist.np)", "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.600000,0.000001&fields=f12,f2,f124", "https://quote.eastmoney.com/", (t) => {
    try {
      return new Date((JSON.parse(t)?.data?.diff?.[0]?.f124 ?? 0) * 1000).toISOString();
    } catch {
      return undefined;
    }
  }),
  timeIt("东财 延时榜单(push2delay)", "https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:1+t:2&fields=f12,f14,f6", "https://quote.eastmoney.com/"),
  timeIt("东财 涨停池(push2ex)", "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=3&sort=fbt%3Aasc&date=" + bj().compact, "https://quote.eastmoney.com/"),
  timeIt("东财 日线(push2his)", "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&klt=101&fqt=1&lmt=5&end=20500101&fields1=f1&fields2=f51,f53", "https://quote.eastmoney.com/"),
  timeIt("新浪 实时快照(L1)", "https://hq.sinajs.cn/list=sh600000", "https://finance.sina.com.cn/", (t) => t.split(",")[30] ?? ""),
]);

for (const r of rows) {
  p(`\n### ${r.label}\n    ${r.note}${r.stamp ? `\n    快照内时间戳: ${r.stamp}` : ""}`);
}

p("\n### 引擎一轮端到端（来自 /history，含指数 + 60~300 支快照 + 打分 + 撮合）");
try {
  const h = (await (await fetch(`http://localhost:${config.port}/history`)).json()) as {
    ts: number;
    quotes: { ok: number };
    note?: string;
  }[];
  const durs = h
    .slice(-40)
    .map((e) => Number(e.note?.match(/(\d+)ms$/)?.[1]))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (durs.length) {
    p(
      `    样本 ${durs.length} 轮：min ${durs[0]}ms · 中位 ${durs[Math.floor(durs.length / 2)]}ms · max ${durs.at(-1)}ms` +
        ` · 轮询间隔 ${config.pollMs}ms`,
    );
  }
  p(`    最近一轮：${h.at(-1)?.note}`);
} catch (e) {
  p(`    后端没在跑（${(e as Error).message}），起 ` + "`bun run start`" + " 后再测");
}

await Bun.write("data/probe-latency.txt", out.join("\n"));
