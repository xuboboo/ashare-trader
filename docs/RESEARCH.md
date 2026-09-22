# Jev 自主持仓研究数据链路

旧的 data/daily 回测已经不再是可上线的研究输入。它缺少历史时点股票池、14:45 截面和分钟级成交路径，也无法重放 Jev 的自主退出。因此 v2 runner 只接受严格的分钟研究数据和显式 Jev 模型，不会回退到 FactorModel 或固定 10:00 标签。

## 目录协议

data/research/manifest.json 负责声明数据来源、价格口径、执行时点、Jev 标签协议和严格切分：

    data/research/
      manifest.json
      universe/YYYY-MM-DD.json
      daily-raw/600000.json
      minutes-1m/YYYY-MM-DD/600000.json

每个 universe/YYYY-MM-DD.json 必须是该日可见的股票池，不能用今天的成交额排名回填历史。

分钟文件必须覆盖：

- 入场：14:45，买入按 ask；
- T+1 起直到 split 边界或数据集末端的连续分钟，卖出按 bid；
- 每条记录必须有 OHLC、成交量、成交额、bid/ask 及对应盘口量；
- 使用未复权成交价。

v2 manifest 的 `execution.decisionIntervalMinutes` 必须为 1，`labels.policy` 必须为 `jev-autonomous`，`labels.censoring` 必须为 `right`。样例 manifest 见 docs/RESEARCH_MANIFEST.example.json。执行：

    bun run research:check

只有检查通过后，才允许接入新的分钟级 Jev runner。入口 14:45 只使用当时 ask；T+1 每分钟先检查硬止损，再把当前可成交 bid 和持仓状态交给 Jev。Jev 的 sell 结果按当时 bid 成交；没有 bid 不成交，也不拿 close 代替。标签跨越 train/validation/test 边界必须丢弃，而不是按入场日期强行归类。

Jev 超时、未配置、返回无效或 trace 不是 Jev 时，样本状态记为 `jev-failed`，绝不回退 Factor 或补一个固定时间退出。观测窗口结束仍未退出记为 `right-censored`；最后一个 split 之前仍有后续数据的样本记为 `boundary-excluded`。

## 运行顺序

`research:check` 只做结构闸门；runner 还会逐个 active 股票校验昨收、14:45 分钟和 T+1 raw 日线：

    bun run research:check
    bun run research:backtest --split=train
    bun run research:backtest --split=validation
    bun run research:backtest --split=test

runner 只使用 factor 做硬筛选和候选排序，最终买入与每分钟退出都由 Jev 决定，不提供 sweep、任意日期窗口或模型切换参数。没有 `TYPESAFE_AI_API_KEY` 时 CLI 直接拒绝运行。报告写入 `data/research/backtest-report.json`，其中 `labelsDetail` 保存每笔持仓标签、entry/exit trace、远端/缓存调用计数和删失状态；只有 `sold-by-jev` 与 `hard-stop` 才进入已实现交易统计。

历史 1 分钟数据必须来自可复现的供应商导出或版本化原始快照。当前免费行情接口只能提供近期/实时分钟片段，不能作为多年测试集的替代品。没有真实数据集时，命令应失败，不能用旧 `data/daily` 回填。
