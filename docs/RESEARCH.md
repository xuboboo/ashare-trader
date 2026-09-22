# 研究回测数据链路

旧的 data/daily 回测已经不再是可上线的研究输入。它缺少历史时点股票池、14:45 截面和分钟级成交路径，因此 CLI 回测、训练和 ATR 扫描在研究数据协议未通过前会直接退出。

## 目录协议

data/research/manifest.json 负责声明数据来源、价格口径、执行时点和严格切分：

    data/research/
      manifest.json
      universe/YYYY-MM-DD.json
      daily-raw/600000.json
      minutes-1m/YYYY-MM-DD/600000.json

每个 universe/YYYY-MM-DD.json 必须是该日可见的股票池，不能用今天的成交额排名回填历史。

分钟文件必须覆盖：

- 入场：14:45，买入按 ask；
- 次日 09:30 到 10:00，卖出按 bid；
- 每条记录必须有 OHLC、成交量、成交额、bid/ask 及对应盘口量；
- 使用未复权成交价。

样例 manifest 见 docs/RESEARCH_MANIFEST.example.json。执行：

    bun run research:check

只有检查通过后，才允许接入新的分钟级回测 runner。标签跨越 train/validation/test 边界的交易必须丢弃，而不是按入场日期强行归类。

## 运行顺序

`research:check` 只做结构闸门；runner 还会逐个 active 股票校验昨收、14:45 分钟和 T+1 raw 日线：

    bun run research:check
    bun run research:backtest --split=train
    bun run research:backtest --split=validation
    bun run research:backtest --split=test

runner 固定使用 factor 规则和 manifest 的三段切分，不提供 sweep、任意日期窗口或模型切换参数。报告写入 `data/research/backtest-report.json`；`censored` 是分钟路径无法完成退出的样本，不能当作盈利样本。

历史 1 分钟数据必须来自可复现的供应商导出或版本化原始快照。当前免费行情接口只能提供近期/实时分钟片段，不能作为多年测试集的替代品。没有真实数据集时，命令应失败，不能用旧 `data/daily` 回填。
