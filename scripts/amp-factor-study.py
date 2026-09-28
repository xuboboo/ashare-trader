"""振幅因子研究：近 5/10 日振幅与 10 日区间位置能否预测未来收益（2026-09-28）

用户提议：看 5-10 日振幅找「潜力股」。本脚本用 research/daily（300 支 × 826 天 raw 日线）做
五分位检验。结论见 docs/STRATEGY.md 或运行输出；注意 raw 价未除权、池子有幸存者偏差。
""";
"""因子研究：近 5/10 日振幅能否预测未来收益（用户 2026-09-28 提议）

定义（全部用 raw 日线，不复权）：
  单日振幅 amp(k) = (high_k - low_k) / close_{k-1}
  A5  = 近 5 日 amp 均值      A10 = 近 10 日 amp 均值
  RPOS10 = (今收 - 近10日最低) / (近10日最高 - 近10日最低)   # 处在 10 日区间什么位置

检验：按因子分五分位，看未来 1 日 / 5 日收益是否单调。
若"高振幅=潜力股"成立，高价位的未来收益应显著更高。

诚实边界：raw 价未做除权处理，除权日的前瞻收益会被压低（对 1/5 日窗口影响有限但存在）；
股票池是今日成交额 top300（幸存者偏差）；本表是因子研究，不代表实盘可执行。
"""
import json, math, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
daily_dir = Path("data/research/daily")
samples = []          # (a5, a10, rpos10, gain, fwd1, fwd5, affordable)
n_bars_total = 0

def amp(b, prev): return (b["high"] - b["low"]) / prev["close"] if prev["close"] else 0.0

for f in sorted(daily_dir.glob("*.json")):
    code = f.stem
    bars = json.loads(f.read_text(encoding="utf-8"))
    n_bars_total += len(bars)
    if len(bars) < 16: continue
    for i in range(10, len(bars) - 5):
        b = bars[i]
        pc = bars[i-1]["close"]
        if not pc: continue
        a5 = sum(amp(bars[j], bars[j-1]) for j in range(i-4, i+1)) / 5.0
        a10 = sum(amp(bars[j], bars[j-1]) for j in range(i-9, i+1)) / 10.0
        lo = min(x["low"] for x in bars[i-9:i+1])
        hi = max(x["high"] for x in bars[i-9:i+1])
        rpos = (b["close"] - lo) / (hi - lo) if hi > lo else 0.5
        gain = (b["close"] - pc) / pc * 100
        f1 = (bars[i+1]["close"] - b["close"]) / b["close"]
        f5 = (bars[i+5]["close"] - b["close"]) / b["close"]
        vol_ratio = b["volumeHands"] / (sum(bars[j]["volumeHands"] for j in range(i-5, i)) / 5.0) if sum(x["volumeHands"] for x in bars[i-5:i]) else 0.0
        vwap = b["amountYuan"] / (b["volumeHands"] * 100) if b["volumeHands"] else 0.0
        affordable = b["close"] * 100 <= 3300
        strat = (3.0 <= gain <= 7.0) and vol_ratio >= 1.5 and b["close"] >= vwap and affordable
        samples.append((a5, a10, rpos, gain, f1 * 1e4, f5 * 1e4, strat))

print(f"股票 300 支 / K线 {n_bars_total} 根 / 样本 {len(samples)} 个（未来 1 日与 5 日）")

def bucket(samples, idx, name, nb=5, label="全部样本"):
    xs = sorted(s[idx] for s in samples)
    n = len(xs)
    if n < nb * 20:
        print(f"  {name}: 样本太少 ({n})"); return
    cuts = [xs[int(k * n / nb)] for k in range(1, nb)]
    groups = [[] for _ in range(nb)]
    for s in samples:
        v = s[idx]
        g = 0
        for c in cuts:
            if v >= c: g += 1
        groups[g].append(s)
    print(f"\n  [{name}]  样本={label}")
    print("  五分位(低->高)     n    未来1日bp     t     未来5日bp     t")
    for gi, g in enumerate(groups, 1):
        for col, tag in [(4, "f1"), (5, "f5")]:
            pass
        f1 = [s[4] for s in g]; f5 = [s[5] for s in g]
        m1 = sum(f1)/len(f1); sd1 = math.sqrt(sum((x-m1)**2 for x in f1)/(len(f1)-1)); t1 = m1/(sd1/math.sqrt(len(f1)))
        m5 = sum(f5)/len(f5); sd5 = math.sqrt(sum((x-m5)**2 for x in f5)/(len(f5)-1)); t5 = m5/(sd5/math.sqrt(len(f5)))
        print(f"    Q{gi}            {len(g):6d}   {m1:9.1f}   {t1:6.2f}   {m5:10.1f}   {t5:6.2f}")

print("\n========== A10：近 10 日平均振幅 ==========")
print("  [全部样本]")
bucket(samples, 1, "A10")
strat_samples = [s for s in samples if s[6]]
print(f"\n========== 策略近似池（涨幅3-7% + 量比>=1.5 + 站上VWAP + 买得起一手）: {len(strat_samples)} 个 ==========")
bucket(strat_samples, 1, "A10")
print("\n========== RPOS10：收盘在 10 日区间内的位置（0=贴底 1=贴顶）==========")
bucket(strat_samples, 2, "RPOS10")