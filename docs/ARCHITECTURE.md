# 架构

设计目标：一个**日频**的 A 股决策台 —— 可插拔的决策模型、单轮在途的事件循环、
含真实成本的影子撮合与会计、SSE 实时仪表盘。四个部件都得经得起审计：
行情只从一个入口进，成本只从一个函数出，账本只有一份，所有破坏性操作留痕迹。

## 数据流

```
东财榜单 ──日频一次──> Universe(300 支) ──代码表──┐
                                                  ├─> Engine.round()  ← 每 3s 一轮
腾讯五档快照 ─盘中每轮─> Map<code, Snapshot> ───────┘        │
东财涨停池 ──盘前一次──> 情绪/连板高度 ─────────────────────┤
东财/腾讯/新浪日线 ─回测与 MA5─> DailyBar ───────────────────┤
                                                            ├─ factors.scoreStock()      打分 + 否决
                                                            ├─ marketGate()             大盘闸门
                                                            ├─ LlmAdvisory.dailyBias()  日频情绪 + veto
                                                            ├─ orders.makeBuyOrder()    建议单
                                                            ├─ orders.tryPaperFill()    影子撮合
                                                            └─ state.Book               T+1 账本 / 权益
                                                                    │
                                                                    └─> TickEvent → 环形历史(1000) + SSE
```

关键点：**行情只从 `quotes.ts` 进，成本只从 `costs.ts` 出，账本只有 `state.ts` 一份**。
回测脚本 `scripts/backtest.ts` 复用后三者，所以"回测赚钱、实盘对不上账"这类问题在结构上不可能出现。

## 模块职责

| 模块 | 职责 | 为什么这样切 |
| --- | --- | --- |
| `config.ts` | 唯一的环境变量入口，含成本与因子阈值 | 参数不散落，回测/实盘读同一份 |
| `http.ts` | 限流 HTTP：进程级 3 req/s、单 URL 1s 去重、指数退避 + 抖动、按 content-type 决定 GBK/UTF-8 | 免费源会打人，限流必须是全局的而不是各模块自觉 |
| `session.ts` | 时段状态机（集合竞价/不可撤单/连续竞价/午休/收盘竞价/盘后）+ 北京时间拆解 | 用 `Intl` 固定 `Asia/Shanghai`，本机时区错了也不会算错盘口时刻 |
| `calendar.ts` | 交易日判定：读上证指数日线里有成交的日期 | 内置节假日表每年要维护且会错；日线自带真值。失败退化为周一~五并置 `stale` |
| `quotes.ts` | 快照 / 榜单 / 日线（三源回退 + 熔断）/ 涨停池 / 指数 | 所有对外部接口的知识集中在这里 |
| `symbols.ts` | 板别涨跌幅、涨跌停价四舍五入、100 股一手、secid/前缀换算 | A 股规则的单一事实来源，回测与实盘共用 |
| `costs.ts` | 佣金 `max(5, 0.025%)` 双边、印花税 0.05% 卖出单边、过户费、经手证管、滑点 | 成本是本项目最重要的数字，必须只有一处定义 |
| `factors.ts` | `StockFeatures`（两口径共同的最小输入）+ `scoreStock()` + `marketGate()` | 见下方"一致性契约" |
| `model.ts` | `FactorModel`（出概率与 picks）、`LlmAdvisory`（日频情绪闸门 + 个股 veto） | LLM 不进热路径，所以它不是 `Model` 而是旁路顾问 |
| `jev.ts` | `JevModel`：把候选装进一份共享 state，逐只问 boolean，按概率阈值与排序出 picks；失败降级回 `FactorModel` 并标 `modelFailed` | 模型只参与"在合法候选里排序与给胜率"，硬约束仍在代码里；`ask`/`apiKey`/`dataDir` 可注入，因此能离线测试 |
| `orders.ts` | 建议单生成、`updateResting` 逐轮观察区间、`tryPaperFill` 影子撮合 | 撮合的保守性全在这一个函数里，便于审计 |
| `state.ts` | `Book`：T+1 `sellable`/`frozen`、买入费用按比例结转、权益曲线、`rebuild()` 重放、JSON 持久化 | 账本必须能被回测、CLI 回填、HTTP 回填三条路共用；撤销靠重放而不是反向数学 |
| `engine.ts` | 主循环、三个调度点、新鲜度门控、降级、心跳事件 | 唯一有状态与时序的地方 |
| `server.ts` | `GET /`、`/history`、`/positions`、`/fills`、`/orders`、`/events`(SSE)、`POST /scan`、`POST /fill`、`POST /fill/remove`、`POST /reset` | 写接口只改本地账本，不碰任何券商通道；`/reset` 必须带显式 confirm |

## 心跳事件 `TickEvent`

一轮一条，前端与回测都消费它：

```ts
{ seq, ts, date, time, phase, tradingDay, trigger,
  index:  { price, pct, amountYi, ma5 },
  gate:   { allowed, reasons[] },                       // 大盘闸门，关了就什么都不做
  bias:   { emotionScore, allowOpen, reason, vetoes, llmFailed, enabled } | null,
  universe, quotes: { ok, fails, stale, eodOnly, quoteDay, ageSec },
  scan:   { scored, rejected, top[{code,name,score,gainPct,volumeRatio,priceVsVwapBps,reasons}] },
  decision: { action, probabilities{buy,sell,hold}, picks[], latencyMs, late, modelFailed } | null,
  orders:   SuggestedOrder[],   // 本轮新产生的建议单
  fills:    Fill[],             // 本轮影子成交
  positions:PositionView[], totals: Totals, note }
```

`note` 是人话状态（`"45ms"` / `"行情已老化 120s > 30s，本轮不出单不撮合"` / `"非交易日…"`），
既进日志也进仪表盘，出问题时第一眼看它。

## 三个调度点

| 时刻 | 做什么 | 不满足什么就不做 |
| --- | --- | --- |
| 09:05 | 拉涨停池算情绪、调 LLM 出当日 `allowOpen` 与 veto 名单；用最近收盘快照做一次盘前预选 | 非交易日 |
| 09:30-10:00 | 持仓退出：到点清仓 > 高开减半 > 跌破止损 > 跌破分时均线 | 行情不新鲜、无可卖数量 |
| 09:30-14:57 | 全程买入决策：每 `DECIDE_EVERY_MS`（默认 60s）一轮 全池打分 → 闸门 → top-K 建议单 | 闸门关、额度用完、行情不新鲜 |

退出评估在整个连续竞价时段只要持仓可卖就每轮跑（不再限 09:30-10:00）；其余时段只做心跳 + 影子撮合 + 盯市。`POST /scan` 是第四个入口：允许在收盘后强制跑一次
选股用于复盘，但**不会伪造成交**（撮合要求当日 + 新鲜 + 连续竞价三个条件同时成立）。

## 一致性契约

`factors.ts` 暴露两个构造函数，把不同数据源压成同一个 `StockFeatures`：

- `featuresFromSnapshot(snap, date)` —— 盘中：量比、分时均价直接来自接口
- `featuresFromDaily(bar, prevBar, avgVol5, name, code)` —— 回测：量比 = 当日量 / 前 5 日均量，
  VWAP = 成交额 / (成交量 × 100)，涨跌停价按板别规则自己算

`scoreStock(features, boosters, useBoosters, params)` 只吃 `StockFeatures`，
所以同一天喂两条路径必然得到同样的分数与同样的否决理由 —— `test/consistency.test.ts`
就是在钉这件事（断言两条路径 `score` 严格相等、`rejects` 文本一致、`FactorModel` 选出同一只）。
情绪类 booster（行业涨停家数、主力净流入）在日线上不可得，因此**默认关闭**；
开启后回测与实盘就不再等价，这点写在代码注释里。

## 四个扩展点

1. **换决策源**：实现 `Model.decide(state) => Decision`（保持概率与 `late`/`modelFailed` 语义），
   在 `engine.ts` 里按 `MODEL` 切换。`JevModel`（`src/jev.ts`）就是现成的例子：
   它的 `ask` 可注入，所以接入一个新模型时先写假回答把逻辑测完，再挂真 key。
   旁路顾问（日频、不进 tick 循环）走 `LlmAdvisory`
2. **换成本**：`costs.ts` 全部来自 config；换标的（可转债 / ETF）主要就是改这里 + `symbols.limitPct()`
3. **换因子**：`scoreStock()` 里加 reject 或改 `WEIGHTS`；阈值走 `FactorParams` 以便回测做参数扫描时逐组传入
4. **接真实通道**（Phase 5，需先做券商程序化报备）：把 `orders.ts` 的纸面撮合换成
   `brokers/qmt.ts` 适配层，`state.ts` 的账本改为以券商成交回报为准 —— 账本与会计层不用动

## 本地状态与可逆性

端口：后端 `3005`、前端 `3006`（都可配置，默认避开常用的 `3000`/`3001`）。
`data/` 下全部是本地状态且已 gitignore：`positions.json`（账本）、`trades.jsonl`（成交流水）、
`voids.log`（撤销/清空痕迹）、`archive/<时间戳>/`（清空前的旧账本）、`cache/universe-<date>.json`、
`daily/<code>.json`、`llm/<date>.json`、`backtest.*`、`sweep.tsv`。

两个破坏性操作都要求显式确认且留痕迹：

- **撤销一笔成交**：`Book.rebuild(剩下的)` 重放重建 → 现金/可卖/冻结/已实现盈亏永远自洽；
  原成交整行追写到 `data/voids.log`
- **清空账本**：先把 `trades.jsonl` + `positions.json` 复制进 `data/archive/<时间戳>/`，再重建空账本；
  HTTP 层不带 `{"confirm":"CLEAR"}` 直接 400

删文件只是最后手段，不再是唯一选项。
