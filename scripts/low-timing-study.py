"""当日最低点形成的时刻分布（通达信分钟线，2026-09-28）

用 get_history_trade_minute_kline 取 30 天 x 50 支的分钟收盘价，
统计当日最低点落在哪个时段，以及「到时刻 T 低点已确定」的累计概率。
结论：低点最常出现在尾盘 14:30-15:00（28.8%）；到 14:30 也只有 71% 的低点已确定 ——
「等低点确认再买」存在天然的确认-反弹两难。
""";
"""当日最低点形成的时刻分布（通达信分钟线）"""
import json, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
from eltdx import TdxClient

base = Path("data/research/entry-timing")
req = json.loads((base / "requests.json").read_text(encoding="utf-8"))
dates = sorted({p["date"] for p in req["pairs"]})[:30]
codes = sorted({p["code"] for p in req["pairs"]})[:50]

client = TdxClient(); client.connect()
buckets = [("09:30-10:00", 600, 630), ("10:00-10:30", 630, 660), ("10:30-11:30", 660, 720),
           ("13:00-14:00", 780, 840), ("14:00-14:30", 840, 870), ("14:30-15:00", 870, 901)]
cnt = [0]*len(buckets); n = 0; fails = 0
def m2s(m): return f"{m//60:02d}:{m%60:02d}"
try:
    for d in dates:
        d8 = d.replace("-", "")
        for code in codes:
            try:
                items = list(client.get_history_trade_minute_kline(("sh" if code[0]=="6" else "sz")+code, d8).items)
            except Exception:
                fails += 1; continue
            if len(items) < 10: fails += 1; continue
            lo = min(it.close_price for it in items)
            first_low = next((it for it in items if it.close_price == lo), None)
            if not first_low: continue
            mins = first_low.time.hour*60 + first_low.time.minute
            placed = False
            for bi, (name, a, b) in enumerate(buckets):
                if a <= mins < b or (bi == len(buckets)-1 and mins >= a):
                    cnt[bi] += 1; placed = True; break
            if placed: n += 1
        print(f"[进度] {d} 完成（累计 {n} 个低点样本，失败 {fails}）", flush=True)
finally:
    client.close()

print("\n=== 当日最低点形成的时刻分布 ===")
print("  时段            低点占比    累计「低点已确定」概率")
cum = 0
for (name, a, b), k in zip(buckets, cnt):
    share = 100.0*k/n if n else 0
    cum += share
    bar = "#" * int(share/2)
    print(f"  {name}   {share:5.1f}%   {cum:5.1f}%   {bar}")
print(f"\n样本={n} 个 (date,code)，失败 {fails}")
print("解读：累计概率越高 = 到那个时刻，当天的低点越可能已经出现（之后不会再创新低）。")