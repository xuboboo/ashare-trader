"""按 entry-timing/requests.json 抓通达信历史分钟线，抽出各入场时刻的成交价 -> ladder.json

用 get_history_trade_minute_kline（241 根/天，09:30~15:00，含 OHLC）。
只保留 requests 里列出的入场时刻，避免把 4M+ 根分钟线落盘。
增量可续跑：ladder.json 里已有的 (date,code) 直接跳过。
诚实边界：这些分钟线**没有 bid/ask**，用该分钟 close 近似成交价；不能当作 research/minutes 协议数据。
"""
import json
import sys
from pathlib import Path

from eltdx import TdxClient

base = Path("data/research/entry-timing")
req = json.loads((base / "requests.json").read_text(encoding="utf-8"))
entries = req["entries"]
pairs = req["pairs"]
ladder_path = base / "ladder.json"
ladder = json.loads(ladder_path.read_text(encoding="utf-8")) if ladder_path.exists() else {}

by_date = {}
for p in pairs:
    by_date.setdefault(p["date"], []).append(p["code"])

total = len(pairs)
done = skipped = failed = 0
consec_fail = 0
client = TdxClient()
client.connect()
try:
    for date, codes in sorted(by_date.items()):
        compact = date.replace("-", "")
        for code in codes:
            if code in ladder.get(date, {}):
                skipped += 1
                continue
            try:
                items = list(client.get_history_trade_minute_kline(("sh" if code[0] == "6" else "sz") + code, compact).items)
                m = {it.time.strftime("%H:%M"): float(it.close_price) for it in items}
                row = {t: m[t] for t in entries if t in m}
                if not row:
                    raise RuntimeError("no entry times")
                ladder.setdefault(date, {})[code] = row
                done += 1
                consec_fail = 0
            except Exception:
                failed += 1
                consec_fail += 1
                if consec_fail >= 60:
                    ladder_path.write_text(json.dumps(ladder), encoding="utf-8")
                    print(f"[ladder] 连续失败 {consec_fail} 次，疑似连接断，已保存并退出", flush=True)
                    sys.exit(3)
        ladder_path.write_text(json.dumps(ladder), encoding="utf-8")
        print(f"[ladder] {date} done 累计 wrote={done} skipped={skipped} failed={failed}/{total}", flush=True)
finally:
    client.close()
print(f"[ladder] 完成 wrote={done} skipped={skipped} failed={failed}")
