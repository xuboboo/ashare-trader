"""全历史（826 天）验证：入场当日大盘跌幅 与 策略次日净收益的关系。

起因：60 天窗口曾显示「大盘跌超 1% 时次日 -83bp(t=-6.13)」，但全历史复现失败
（-38.8bp，t=-0.49，不显著）——窗口选择产物，不能据此改闸门规则。
真正跨全历史稳定的是：只有「入场当日大盘涨超 1%」的桶为正（+76bp，t=6.62）。
""";
"""全历史验证：入场当日大盘跌幅 与 策略次日净收益 的关系（826 天，不只 60 天）"""
import json, math, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
from eltdx import TdxClient

# 1) 上证指数日线（900 根）
c = TdxClient(); c.connect()
k = c.get_kline("day", "sh000001", count=900, kind="index")
c.close()
idx = [{"date": it.time.strftime("%Y-%m-%d"), "close": float(it.close_price)} for it in k.items]
idx.sort(key=lambda x: x["date"])
pct = {}
for i in range(1, len(idx)):
    pct[idx[i]["date"]] = (idx[i]["close"] / idx[i-1]["close"] - 1) * 1e4
print(f"指数日线 {len(idx)} 根（{idx[0]['date']}..{idx[-1]['date']}）")

# 2) 策略池全历史样本（与 amp-factor-study.py 同一口径）
daily_dir = Path("data/research/daily")
COST = 36.86
rows = []
for f in sorted(daily_dir.glob("*.json")):
    bars = json.loads(f.read_text(encoding="utf-8"))
    if len(bars) < 16: continue
    for i in range(10, len(bars) - 5):
        b = bars[i]; pc = bars[i-1]["close"]
        if not pc: continue
        gain = (b["close"] - pc) / pc * 100
        if not (3.0 <= gain <= 7.0): continue
        avg5 = sum(bars[j]["volumeHands"] for j in range(i-5, i)) / 5.0
        if not avg5 or b["volumeHands"] / avg5 < 1.5: continue
        vwap = b["amountYuan"] / (b["volumeHands"] * 100) if b["volumeHands"] else 0
        if b["close"] < vwap: continue
        if b["close"] * 100 > 3300: continue
        ip = pct.get(b["date"])
        if ip is None: continue
        f1 = (bars[i+1]["close"] - b["close"]) / b["close"] * 1e4 - COST
        f5 = (bars[i+5]["close"] - b["close"]) / b["close"] * 1e4 - COST
        rows.append({"sp": b["date"], "ip": ip, "f1": f1, "f5": f5})

print(f"策略池样本 {len(rows)} 个")

def stat(xs):
    n = len(xs)
    if not n: return None
    m = sum(xs)/n
    sd = math.sqrt(sum((x-m)**2 for x in xs)/(n-1)) if n > 1 else 0
    return (n, m, 100.0*sum(1 for x in xs if x>0)/n, (m/(sd/math.sqrt(n)) if sd>0 else 0))

print("\n=== 全历史：按入场当日大盘涨跌分桶（次日收盘出场，扣成本）===")
print("大盘当日涨跌      样本n   次日净bp    胜率%     t值")
buckets = [(-9999, -150), (-150, -100), (-100, -50), (-50, 0), (0, 100), (100, 9999)]
for lo, hi in buckets:
    xs = [r["f1"] for r in rows if lo <= r["ip"] < hi]
    s = stat(xs)
    if s: print(f"  {lo:+5d}~{hi:+5d}bp   {s[0]:7d}   {s[1]:8.1f}   {s[2]:6.1f}   {s[3]:7.2f}")

print("\n=== 分段稳健性：大盘跌超 1% 时（次日净bp）===")
print("  段位       1日样本   1日净bp     t      5日样本   5日净bp     t")
for sp_name in ["train", "valid", "test"]:
    xs1 = [r["f1"] for r in rows if r["sp"] == sp_name and r["ip"] <= -100]
    xs5 = [r["f5"] for r in rows if r["sp"] == sp_name and r["ip"] <= -100]
    s1, s5 = stat(xs1), stat(xs5)
    r1 = f"{s1[0]:7d}  {s1[1]:9.1f}  {s1[3]:7.2f}" if s1 else "      0         —       —"
    r5 = f"{s5[0]:7d}  {s5[1]:9.1f}  {s5[3]:7.2f}" if s5 else "      0         —       —"
    print(f"  {sp_name:8s} {r1}   {r5}")
all1 = [r["f1"] for r in rows if r["ip"] <= -100]
all5 = [r["f5"] for r in rows if r["ip"] <= -100]
s1, s5 = stat(all1), stat(all5)
print(f"  {'ALL':8s} {s1[0]:7d}  {s1[1]:9.1f}  {s1[3]:7.2f}   {s5[0]:7d}  {s5[1]:9.1f}  {s5[3]:7.2f}")