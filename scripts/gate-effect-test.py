"""检验大盘 MA5 闸门是否真的提升期望（2026-09-28）

动机：用户质疑——「行情不好不买，行情好了买高了」，均线闸门是否天然追涨杀跌？

方法：同一批候选、同一入场时刻(14:45)、同一出场(次日收盘)，按「当日上证收盘
是否在其前 5 日均线上方」分成闸门开/关两组，比较净期望(bp)与胜率。

前置：需先跑 entry-timing-study.ts --emit 与 tdx-minute-ladder.py，以及
      data/research/entry-timing/index_daily.json（通达信上证日线）。
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
"""检验大盘 MA5 闸门是否真的提升期望。

方法：同一批候选、同一入场时刻(14:45)、同一出场(次日收盘)，
按「当天上证收盘 是否 在其前 5 日均线上方」分成闸门开/关两组，
比较各自的净期望(bp)、胜率与 t 值。若闸门有效，开仓日应显著更好。
"""
import json
import math
from pathlib import Path

base = Path("data/research/entry-timing")
ENTRY = "14:45"
COST_BPS = 36.86  # roundTrip(3300)

idx = json.loads((base / "index_daily.json").read_text(encoding="utf-8"))
idx.sort(key=lambda x: x["date"])
closes = {x["date"]: x["close"] for x in idx}
dates_sorted = [x["date"] for x in idx]

def ma5_before(d):
    i = dates_sorted.index(d)
    if i < 5:
        return None
    return sum(x["close"] for x in idx[i-5:i]) / 5.0

def gate_open(d):
    ma = ma5_before(d)
    if ma is None or d not in closes:
        return None
    return closes[d] >= ma

ladder = json.loads((base / "ladder.json").read_text(encoding="utf-8"))
daily_dir = Path("data/research/daily")

groups = {True: [], False: []}
days = {True: 0, False: 0}
used = 0
for date, codes in sorted(ladder.items()):
    g = gate_open(date)
    if g is None:
        continue
    days[g] += 1
    for code, pxmap in codes.items():
        px = pxmap.get(ENTRY)
        if not px or px <= 0:
            continue
        f = daily_dir / (code + ".json")
        if not f.exists():
            continue
        bars = json.loads(f.read_text(encoding="utf-8"))
        ds = [b["date"] for b in bars]
        if date not in ds:
            continue
        i = ds.index(date)
        if i + 1 >= len(bars):
            continue
        exitc = bars[i + 1]["close"]
        net = (exitc - px) / px * 1e4 - COST_BPS
        groups[g].append(net)
        used += 1

def stat(xs):
    n = len(xs)
    if not n:
        return (0, 0.0, 0.0, 0.0, 0.0)
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    t = m / (sd / math.sqrt(n)) if sd > 0 else 0.0
    win = 100.0 * sum(1 for x in xs if x > 0) / n
    return (n, m, win, t, sd)

print(f"样本(笔)={used}  闸门开的天数={days[True]}  闸门关的天数={days[False]}")
print("")
print("组别        笔数    平均净bp    胜率%      t值     σ(bp)")
for label, g in [("闸门开", True), ("闸门关", False)]:
    n, m, win, t, sd = stat(groups[g])
    print(f"{label}   {n:6d}   {m:8.1f}   {win:6.1f}   {t:7.2f}   {sd:6.0f}")

# 差异的 Welch t
a, b = groups[True], groups[False]
if a and b:
    ma_, mb_ = sum(a)/len(a), sum(b)/len(b)
    va = sum((x-ma_)**2 for x in a)/(len(a)-1)
    vb = sum((x-mb_)**2 for x in b)/(len(b)-1)
    se = math.sqrt(va/len(a) + vb/len(b))
    diff = ma_ - mb_
    t = diff/se if se > 0 else 0.0
    print("")
    print(f"闸门开 − 闸门关 = {diff:.1f} bp/笔，  Welch t = {t:.2f}")
    print("判读：|t| >= 2 才能说闸门真的改变了期望；否则它只是在调节参与度。")