"""三个执行风险问题的实证检验（2026-09-28）

Q1 14:45 会不会买到全天最高价？  Q3 入场当日大盘涨跌对次日收益的影响。
数据：research/entry-timing/ladder.json（7542 个 date,code）+ index_daily.json。
结论见运行输出；Q2（隔夜跳空）属结构性风险，无数据可解。
""";
import json, math, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")

base = Path("data/research/entry-timing")
ladder = json.loads((base / "ladder.json").read_text(encoding="utf-8"))
idx = json.loads((base / "index_daily.json").read_text(encoding="utf-8"))
idx.sort(key=lambda x: x["date"])
iclose = {x["date"]: x["close"] for x in idx}
idates = [x["date"] for x in idx]
daily_dir = Path("data/research/daily")
COST = 36.86

dist_high = []
recs = []
for date, codes in sorted(ladder.items()):
    if date not in iclose: continue
    i = idates.index(date)
    ipct = ((iclose[date] / iclose[idates[i-1]]) - 1) * 1e4 if i > 0 else 0.0
    for code, pxmap in codes.items():
        px = pxmap.get("14:45")
        if not px or px <= 0: continue
        f = daily_dir / (code + ".json")
        if not f.exists(): continue
        bars = json.loads(f.read_text(encoding="utf-8"))
        ds = [b["date"] for b in bars]
        if date not in ds: continue
        k = ds.index(date)
        if k + 1 >= len(bars): continue
        hi = bars[k]["high"]
        dist_high.append((hi - px) / px * 1e4)
        net = (bars[k+1]["close"] - px) / px * 1e4 - COST
        recs.append((net, ipct))

dist_high.sort()
def q(p): return dist_high[min(int(len(dist_high) * p), len(dist_high) - 1)]
print("=== Q1: 14:45 买价距「当日最高价」还有多远 (bp) ===")
print(f"  中位={q(0.5):.0f}  平均={sum(dist_high)/len(dist_high):.0f}  P10={q(0.1):.0f}  P25={q(0.25):.0f}  P75={q(0.75):.0f}  P90={q(0.9):.0f}  n={len(dist_high)}")
near = sum(1 for d in dist_high if d < 30)
print(f"  距最高 <30bp（≈就是买在最高）占比: {100*near/len(dist_high):.1f}%")

def stat(xs):
    n = len(xs)
    if not n: return None
    m = sum(xs)/n
    sd = math.sqrt(sum((x-m)**2 for x in xs)/(n-1)) if n > 1 else 0
    return (n, m, 100.0*sum(1 for x in xs if x>0)/n, (m/(sd/math.sqrt(n)) if sd>0 else 0))

print("\n=== Q3: 按「入场当日大盘涨跌」分组的次日净收益 ===")
down = [n for n, ip in recs if ip < 0]
up = [n for n, ip in recs if ip >= 0]
for label, xs in [("入场当日大盘跌", down), ("入场当日大盘涨", up)]:
    s = stat(xs)
    if s: print(f"  {label}: n={s[0]}  平均净bp={s[1]:.1f}  胜率={s[2]:.1f}%  t={s[3]:.2f}")

print("\n=== 补充: 当日大盘跌幅分组（越跌越差吗） ===")
buckets = [(-9999, -100), (-100, -50), (-50, 0), (0, 9999)]
for lo, hi in buckets:
    xs = [n for n, ip in recs if lo <= ip < hi]
    s = stat(xs)
    if s: print(f"  大盘 {lo}~{hi}bp: n={s[0]}  平均净bp={s[1]:.1f}  胜率={s[2]:.1f}%  t={s[3]:.2f}")