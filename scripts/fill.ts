/**
 * 命令行回填一笔你在券商 App 里真实成交的单。
 * 用法：
 *   bun run scripts/fill.ts 600000 buy 3000 @12.34
 *   bun run scripts/fill.ts 600000 sell 3000 @12.90 --note="次日10点清仓"
 *   bun run scripts/fill.ts 002156 buy 800            # 不给价则用引擎的最新快照
 * 服务在跑时走 POST /fill（账本与仪表盘同步）；没在跑则直接改本地账本。
 */
import { config } from "../src/config";
import { Book, makeFill } from "../src/state";
import type { Side } from "../src/symbols";
import { clockNow } from "../src/engine";

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const opt = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");

  const code = positional[0]?.trim();
  const side = positional[1]?.trim().toLowerCase() as Side | undefined;
  const qtyArg = positional[2]?.replace(/[股,]/g, "");
  const priceArg = positional.find((p) => p.startsWith("@"))?.slice(1) ?? opt("price");
  const signalId = opt("signal");
  const note = opt("note") ?? "命令行回填";

  if (!code || !/^\d{6}$/.test(code) || !side || !["buy", "sell"].includes(side) || !qtyArg) {
    console.log('用法: bun run scripts/fill.ts <6位代码> <buy|sell> <股数> [@成交价] [--signal=S...] [--note="..."]');
    process.exit(1);
  }
  const qty = Number(qtyArg);
  const price = priceArg ? Number(priceArg) : undefined;
  if (!Number.isFinite(qty) || qty <= 0) {
    console.log(`股数不对: ${qtyArg}`);
    process.exit(1);
  }
  if (side === "buy" && qty % 100 !== 0) {
    console.log(`买入必须是 100 的整数倍，收到 ${qty} 股`);
    process.exit(1);
  }

  const payload = JSON.stringify({ code, side, qty, price, signalId, note });
  try {
    const r = await fetch(`http://localhost:${config.port}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as any;
    if (!r.ok) throw new Error(String(j?.error ?? `HTTP ${r.status}`));
    console.log(`已记账（同步到服务）: ${j.fill.code} ${j.fill.side} ${j.fill.qty} @ ${j.fill.price} 费用 ${j.fill.costs.total} 元`);
    if (j.fill.realizedPnl !== undefined) console.log(`本笔实现盈亏 ${j.fill.realizedPnl} 元`);
    console.log(`账本: 权益 ${j.totals.equity} 元，持仓 ${j.totals.positions} 只，现金 ${j.totals.cash} 元`);
    return;
  } catch (e) {
    const msg = (e as Error).message;
    if (!/connect|refused|ECONN|timeout/i.test(msg)) throw e;
    console.log(`服务没在跑（${msg}），直接写本地账本`);
  }

  const book = new Book();
  await book.load();
  if (!price) {
    console.log("离线模式下拿不到快照价，请用 @价格 显式给出成交价");
    process.exit(1);
  }
  const now = clockNow();
  // 离线模式下没有快照，从当日股票池缓存里把中文名补上，账本里不留光溜溜的代码
  let name = opt("name") ?? "";
  if (!name) {
    try {
      const { Universe } = await import("../src/universe");
      const u = new Universe();
      await u.get(now.date);
      name = u.nameOf(code);
    } catch {
      name = code;
    }
  }
  book.rollover(now.date);
  const fill = makeFill({
    code,
    name: name || code,
    side,
    price,
    qty,
    date: now.date,
    time: now.time,
    kind: "manual",
    signalId,
    note,
  });
  const realized = book.applyFill(fill);
  await book.appendFill(fill);
  await book.save();
  console.log(`已记账: ${fill.code} ${fill.side} ${fill.qty} @ ${fill.price} 费用 ${fill.costs.total} 元`);
  if (realized !== undefined) console.log(`本笔实现盈亏 ${realized} 元`);
  const t = book.totals();
  console.log(`账本: 权益 ${t.equity} 元，持仓 ${t.positions} 只，现金 ${t.cash} 元，可卖 ${[...book.positions.values()].reduce((s, p) => s + p.sellable, 0)} 股`);
}

await main();
