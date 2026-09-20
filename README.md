# ashare-trader — A 股 T+1 决策台

每个交易日三个触发点：09:05 盘前闸门、09:30-10:00 持仓退出、14:40-14:57 尾盘选股。
系统产出**建议单**，你在券商 App 里手工下单，再回填成交；未回填前一切按影子成交记账。

**它不会下单，也不能下单。** 没有券商量化接口（QMT/PTrade）的前提下，人工执行是唯一合规路径；
"由人下达委托"不属于交易所程序化交易报备范围。将来若接自动下单，必须先经券商做程序化信息报备。

## Run

    cp .env.example .env
    bun install
    bun run start                    # 后端 :3005（Bun + TS）
    cd web && bun install && bun run dev   # 仪表盘 :3006

不在交易时段也会起来：用最近一个交易日的收盘快照做心跳与复盘，仪表盘顶部有横幅说明。

## 命令行

    bun run scripts/once.ts                       # 跑一轮，看链路是否通
    bun run scripts/fetch-daily.ts --sample=100   # 下日线，回测数据源
    bun run scripts/backtest.ts --from=2024-01-01 # 回测（含 --sweep 参数扫描）
    bun run scripts/fill.ts 002156 buy 800 @61.40 # 回填一笔真实成交
    bun test                                      # 56 个测试

## Endpoints

- `GET /` 元信息 + 最新一次心跳
- `GET /history` 最近 1000 次心跳
- `GET /positions` 持仓（可卖/冻结）、汇总、待执行建议单
- `GET /events` SSE：连接时 `snapshot`，之后每个心跳一个 `tick`，15s 一个 `ping`
- `POST /scan` 立刻跑一次选股（收盘后也能跑，用于复盘）
- `POST /fill` 回填成交：`{code, side, qty, price?, signalId?, note?}`

一次 `tick`（形状见 `src/engine.ts` 的 `TickEvent`）：

    { "seq": 2, "date": "2026-09-20", "time": "22:22", "phase": "closed", "trigger": "force-scan",
      "index": { "price": 3911.87, "pct": 0.94, "amountYi": 9942, "ma5": 3885.7 },
      "gate": { "allowed": true, "reasons": ["上证 3911.87 (9942 亿) 闸门通过"] },
      "scan": { "scored": 60, "rejected": 53, "top": [ ... ] },
      "orders": [ { "signalId": "S20260920-0001", "code": "002156", "name": "通富微电",
                    "side": "buy", "qty": 800, "limitLow": 61.36, "limitHigh": 61.4,
                    "amountCny": 49104, "costBps": 11.56, "stopPrice": 59.54,
                    "mustExitAt": "次日 10:00", "reason": "涨幅 5.26% 落在 3-7% 强势区间；量比 2.34 放量 …" } ],
      "fills": [], "positions": [], "totals": { "equity": 150000, "pnlCny": 0, "exposurePct": 0 } }

## Layout

    src/config.ts     全部环境变量，含成本与因子阈值
    src/session.ts    时段状态机（集合竞价/连续竞价/午休/收盘竞价）+ 北京时间
    src/calendar.ts   交易日历：读上证指数日线，不内置节假日表；失败退化为周一~五
    src/http.ts       限流行情 HTTP（3 req/s、单 URL 1s 去重、指数退避 + 抖动）
    src/quotes.ts     快照(腾讯 GBK 五档) / 榜单(东财) / 日线(东财→腾讯→新浪) / 涨停池
    src/symbols.ts    A 股规则：板别涨跌幅、涨跌停价四舍五入、100 股一手
    src/costs.ts      佣金 max(5, 0.025%)、印花税 0.05% 卖出、过户费、经手证管、滑点
    src/factors.ts    因子打分 + 大盘闸门；日线口径与快照口径共用同一个 scoreStock
    src/model.ts      FactorModel（默认，毫秒级）+ LlmAdvisory（仅日频：情绪闸门 + 个股 veto）
    src/orders.ts     建议单生成与纸面撮合（一字板不可成交）
    src/state.ts      Book：T+1 可卖/冻结、费用分摊、权益曲线、JSON 持久化
    src/engine.ts     主循环：单轮在途、迟到即什么都不做、三个调度点、影子撮合、心跳事件
    src/server.ts     Bun.serve：快照 / 历史 / 持仓 / SSE / scan / fill
    scripts/          once、probe、fetch-daily、backtest、fill
    web/              Next.js 仪表盘（见 web/README.md）

## 为什么不是 jev-trader 那样

| | jev-trader（Monad/Kuru） | 这里 |
| --- | --- | --- |
| 节奏 | 每 ~300ms 一个区块 | 每天 3 个触发点 |
| 盈利来源 | post-only 挂单吃价差 | 隔夜动量（目前不成立，见下） |
| 下单 | 链上 batchUpdate 自动 | 人工在券商 App 执行 |
| 持仓 | 可多可空、随时平 | 只能做多、T+1 才能卖 |
| 模型 | TypeSafe Jev 出概率 | 规则打分出概率；LLM 只做日频否决 |

A 股个股做不了那套：T+1、涨跌停、程序化报备（现行高频线为单账户每秒申报/撤单 ≥300 笔或单日 ≥2 万笔），
再加上 5 元最低佣金 —— 2 万元单笔就是 25bp。

## 回测结论（2026-09-20 跑，样本 = 当前成交额前 100 支 × 2024-01 ~ 2026-09）

36 组参数全部不通过门槛（`年化 > 0` 且 `净期望 > 0` 且 `收益/成本 > 2.5`）：

    K=3 涨幅3-7% 量比≥1.5:  403 腿  胜率 42.2%  毛利 -1.7bp - 成本 11.6bp = 净 -13.2bp  年化 -6.4%  回撤 39.4%
    K=1 涨幅4-7% 量比≥1.5:  244 腿  胜率 42.6%  毛利 +11.0bp - 成本 11.6bp = 净 -0.6bp   年化 -0.2%  回撤 18.1%
    K=3 涨幅3-7% 量比≥1.2:  488 腿  胜率 42.0%  毛利  +2.3bp - 成本 11.6bp = 净  -9.3bp   年化 -5.4%  回撤 43.0%

**结论**：尾盘追强势股 + 次日退出，毛利期望约 0~11bp，而零售往返成本 11.6bp（万2.5 佣金双边 5bp +
印花税 5bp + 过户/经手 1.5bp）。**手续费吃光全部 edge**，参数怎么调都翻不了身。
按方案设定的门槛，停在回测层，不进实盘辅助。

要往下走只有三条路，都不是"再调调参数"：

1. 把成本打掉：佣金谈到万 1（成本降到 ~8.5bp）——仍然不够；换 **可转债/跨境 ETF**（无印花税、tick 相对更小、T+0）才有正的空间
2. 把毛利做大：从"日频强势"换到分钟级/资金流/龙虎榜/事件驱动，需要分钟线数据
3. 拉长持有：把换手降下来，让 11.6bp 摊到 5-20 天的波动里

已知样本缺陷（结论方向不变，但别把它当精确数字）：

- **选择偏差**：股票池是"今天"的成交额前 100，它们过去两年本来就更可能强势
- 日线近似：`次日 10:00 前清仓` 用收盘价代理；止损按触价成交，不含盘中滑点放大
- 31/99 支的成交额由 `(高+低+收)/3 × 成交量` 估算（东财日线被限流时走腾讯/新浪），影响 2 亿流动性门槛与 VWAP 因子

## 数据源

全部免费非官方接口，只用于研究与盘辅助：**东财** 榜单/日线/涨停池、**腾讯** 实时快照（GBK，含五档、
涨停价、量比、分时均价）、**新浪** 日线兜底。进程级 3 req/s、单 URL 1s 去重、指数退避。
连续 3 轮快照失败会自动降级为 `eodOnly`（只在盘前出一次信号），仪表盘顶部有黄色横幅。
要上真正的盘中执行，必须换成券商柜台行情（QMT/PTrade 内置）。

## 合规红线（写死在代码里的部分）

- 不生成、不下达委托：`orders.ts` 只产出建议单文本，纸面撮合不碰任何券商接口
- 报撤单量级：一天最多 `MAX_DAILY_OPENS=4` 次开仓，与 300 笔/秒的高频线无关
- 涨跌停/停牌/一字板在 `factors.scoreStock` 与 `orders.tryPaperFill` 里双重否决
- 账本与日志留在 `data/`，已 gitignore；`PAPER=true` 是不可绕过的默认
