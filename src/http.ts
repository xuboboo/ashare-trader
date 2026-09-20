/**
 * 限流的行情 HTTP。免费源（东财/腾讯/新浪）都会打人不客气：
 * 进程级 5 请求/秒 + 单 URL 1 秒内不重复 + 指数退避。所有行情模块都必须走这里。
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const RATE = 3; // 每秒请求数（实测东财 push2his 在 ~2/s 以上会 ECONNRESET）
const stamps: number[] = [];
const lastHit = new Map<string, number>();

async function gate(url: string) {
  const now = Date.now();
  const prev = lastHit.get(url);
  if (prev && now - prev < 1000) await Bun.sleep(1000 - (now - prev));

  // 令牌桶：保留最近 1 秒内的请求时间戳
  for (;;) {
    const t = Date.now();
    while (stamps.length && t - stamps[0]! > 1000) stamps.shift();
    if (stamps.length < RATE) {
      stamps.push(t);
      break;
    }
    await Bun.sleep(200);
  }
  lastHit.set(url, Date.now());
}

export interface GetOpts {
  referer?: string;
  headers?: Record<string, string>;
  tries?: number;
  timeoutMs?: number;
}

export async function httpGet(url: string, opts: GetOpts = {}): Promise<string> {
  const { referer, headers = {}, tries = 4, timeoutMs = 8000 } = opts;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    await gate(url);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      // 腾讯行情是 GBK，其余是 UTF-8。按内容类型判断，避免中文名称变问号。
      const ct = r.headers.get("content-type") ?? "";
      return /gbk|gb2312|gb18030/i.test(ct)
        ? new TextDecoder("gbk").decode(buf)
        : new TextDecoder().decode(buf);
    } catch (e) {
      last = e;
      // 退避带抖动，避免多线程同时重试把对方彻底惹毛
      await Bun.sleep((600 + Math.random() * 400) * 2 ** i);
    }
  }
  throw new Error(`${url.split("?")[0]}: ${(last as Error)?.message ?? last}`);
}

export async function httpJson<T = any>(url: string, opts: GetOpts = {}): Promise<T> {
  const text = await httpGet(url, opts);
  // 部分接口带 jsonp 包裹，剥掉
  const json = text.startsWith("{") || text.startsWith("[") ? text : text.replace(/^[^((]+\(/, "").replace(/\);?\s*$/, "");
  return JSON.parse(json) as T;
}
