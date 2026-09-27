"""按 entry-timing/requests.json 抓通达信历史分钟线 -> ladder_pit.json（point-in-time 版）

比 v1 多存两样东西，专门为了"在每个时刻只能用当时可见信息"：
  px = 该分钟收盘价（近似成交价）
  cv = 从 09:30 累计到该分钟的成交量（手）
  ca = 从 09:30 累计到该分钟的成交额（元）
有了 cv/ca，才能算出 T 时刻的 VWAP 与量比，而不用偷看全天数据。

增量可续跑；连续失败 60 次视为连接断，保存退出。
诚实边界：分钟线没有 bid/ask，px 用分钟收盘价近似。
"""
import json
import sys
from pathlib import Path

from eltdx import TdxClient

base = Path("data/research/entry-timing")
req = json.loads((base / "requests.json").read_text(encoding="utf-8"))
entries = req["entries"]
pairs = req["pairs"]
out_path = base / "ladder_pit.json"
ladder = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}

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
                cv = 0.0
                ca = 0.0
                row = {}
                want = set(entries)
                for it in items:
                    cv += float(it.volume)
                    ca += float(it.amount)
                    hm = it.time.strftime("%H:%M")
                    if hm in want:
                        row[hm] = {"px": float(it.close_price), "cv": cv, "ca": ca}
                if len(row) != len(entries):
                    raise RuntimeError(f"missing entry minutes ({len(row)}/{len(entries)})")
                ladder.setdefault(date, {})[code] = row
                done += 1
                consec_fail = 0
            except Exception:
                failed += 1
                consec_fail += 1
                if consec_fail >= 60:
                    out_path.write_text(json.dumps(ladder), encoding="utf-8")
                    print(f"[pit] 连续失败 {consec_fail} 次，疑似连接断，已保存退出", flush=True)
                    sys.exit(3)
        out_path.write_text(json.dumps(ladder), encoding="utf-8")
        print(f"[pit] {date} done wrote={done} skipped={skipped} failed={failed}/{total}", flush=True)
finally:
    client.close()
print(f"[pit] 完成 wrote={done} skipped={skipped} failed={failed}")
