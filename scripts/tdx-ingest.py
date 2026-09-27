"""TDX(通达信) -> data/research/daily/<code>.json  (raw / 不复权)

为什么需要它：research 协议要 raw 日线，而免费东财源会限流（实测 41 支后就被拒）。
eltdx 直连通达信服务器，不用 key，正好补这块。字段单位已实测：
  KlineItem.volume  = 手(100 股)；KlineItem.amount = 元
  换手率 = volumeHands*100 / float_shares * 100 （get_equity 取流通股本）
写出的 JSON 必须能被 src/research.ts 的 loadDailyBars 通过：日期严格递增、
OHLC>0、amountYuan 有限且非估值(amountEst)。
"""
import argparse, json, sys
from pathlib import Path
from eltdx import TdxClient


def to_symbol(code: str) -> str:
    return ("sh" if code[0] == "6" else "sz") + code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default="", help="逗号分隔 6 位代码；为空则读 --universe")
    ap.add_argument("--universe", default="data/cache/universe-2026-09-28.json")
    ap.add_argument("--days", type=int, default=800)
    ap.add_argument("--out", default="data/research/daily")
    ap.add_argument("--skip-existing", action="store_true")
    a = ap.parse_args()

    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)

    codes = [c.strip() for c in a.codes.split(",") if c.strip()]
    if not codes:
        import re
        txt = Path(a.universe).read_text(encoding="utf-8")
        codes = list(dict.fromkeys(re.findall(r'"code"\s*:\s*"(\d{6})"', txt)))
    if not codes:
        print("[tdx] no codes"); return 2

    client = TdxClient()
    client.connect()
    wrote, skipped, failed = 0, 0, []
    try:
        for i, code in enumerate(codes, 1):
            dst = outdir / (code + ".json")
            if a.skip_existing and dst.exists():
                skipped += 1
                continue
            try:
                sym = to_symbol(code)
                items = list(client.get_kline("day", sym, count=a.days).items)
                if not items:
                    raise RuntimeError("empty kline")
                try:
                    fs = float(client.get_equity(sym).float_shares or 0)
                except Exception:
                    fs = 0.0
                bars, prev = [], None
                for it in items:
                    close = float(it.close_price)
                    lc = it.last_close_price or prev
                    pct = ((close / lc - 1) * 100) if lc else 0.0
                    vh = int(it.volume)
                    tp = (vh * 100.0 / fs * 100.0) if fs else 0.0
                    bars.append({
                        "date": it.time.strftime("%Y-%m-%d"),
                        "open": float(it.open_price), "close": close,
                        "high": float(it.high_price), "low": float(it.low_price),
                        "volumeHands": vh, "amountYuan": float(it.amount),
                        "turnoverPct": round(tp, 6), "pct": round(pct, 4),
                    })
                    prev = close
                bars.sort(key=lambda b: b["date"])
                for j in range(1, len(bars)):
                    if bars[j]["date"] <= bars[j - 1]["date"]:
                        raise RuntimeError("dates not ascending")
                dst.write_text(json.dumps(bars, ensure_ascii=False), encoding="utf-8")
                wrote += 1
            except Exception as e:
                failed.append(f"{code}:{e}")
            if i % 25 == 0:
                print(f"[tdx] progress {i}/{len(codes)} (wrote {wrote}, failed {len(failed)})", flush=True)
    finally:
        client.close()
    print(f"[tdx] done: wrote={wrote} skipped={skipped} failed={len(failed)}")
    if failed:
        print("[tdx] fails:", "; ".join(failed[:10]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
