# 架构

设计目标：一个**日频**的 A 股决策台 —— 可插拔的决策模型、单轮在途的事件循环、
含真实成本的影子撮合与会计、SSE 实时仪表盘。四个部件都得经得起审计：
行情只从一个入口进，成本只从一个函数出，账本只有一份，所有破坏性操作留痕迹。

## 数据流

```
东财榜单 ─日切一次─> Universe(300 支) ─代码表──┐
                                                  ├─> Engine.round()  ← 每 3s 一轮
腾讯五档快照 ─盘中每轮─> Map<code, Snapshot> ───────┘        │
东财涨停池 ─盘中现采(与决策同节奏)─> 情绪/连板高度 ────────┤
东财/腾讯/新浪日线 ─回测与 MA5─> DailyBar ───────────────┤
                                                            ├─ factors.scoreStock()      打分 + 否决
                                                            ├─ marketGate()             大盘闸门（累计交易分钟折算）
                                                            ├─ LlmAdvisory.dailyBias()  日频情绪 + veto
                                                            ├─ orders.makeBuyOrder/makeExitOrder  建议单
                                                            ├─ orders.settlePending()   影子撮合（买卖双向）
                                                            ├─ exit.nextDayExit()       次日出场阶梯（回测/训练共用）
                                                            └─ state.Book               T+1 账本 / 权益
                                                                    │
                                                                    └─> TickEvent → 环形历史(1000) + SSE
```

关键点：**行情只从 `quotes.ts` 进，成本只从 `costs.ts` 出，账本只有 `state.ts` 一份，
出场规则只有 `exit.ts` 一份，写 `data/` 的入口必须先拿 `lock.ts` 的单实例锁**。
回测脚本 `scripts/backtest.ts` 复用后几者，所以"回测赚钱、实盘对不上账"这类问题在结构上不可能出现
—— 前提是它调的真是同一个函数（本轮审计修的就是“看着同一份、其实各自一套”）。

## 模块职责

| 模块 | 职责 | 为什么这样切 |
| --- | --- | --- |
| `config.ts` | 唯一的环境变量入口，含成本与因子阈值 | 参数不散落，回测/实盘读同一份 |
| `http.ts` | 限流 HTTP：进程级 3 req/s、单 URL 1s 去重、指数退避 + 抖动、按 content-type 决定 GBK/UTF-8 | 免费源会打人，限流必须是全局的而不是各模块自觉 |
| `session.ts` | 时段状态机（集合竞价/不可撤单/连续竞价/午休/收盘竞价/盘后）+ 北京时间拆解 + `tradingElapsedMin()` 累计交易分钟 | 用 `Intl` 固定 `Asia/Shanghai`，本机时区错了也不会算错盘口时刻；累计分钟是成交额节奏闸门的分母，跨午休不能清零 |
| `calendar.ts` | 交易日判定：读上证指数日线里有成交的日期 | 内置节假日表每年要维护且会错；日线自带真值。失败退化为周一~五并置 `stale` |
| `quotes.ts` | 快照 / 榜单 / 日线（三源回退 + 熔断）/ 涨停池 / 指数 | 所有对外部接口的知识集中在这里 |
| `symbols.ts` | 板别涨跌幅、涨跌停价四舍五入、100 股一手、secid/前缀换算 | A 股规则的单一事实来源，回测与实盘共用 |
| `costs.ts` | 佣金 `max(5, 0.025%)` 双边、印花税 0.05% 卖出单边、过户费、经手证管、滑点 | 成本是本项目最重要的数字，必须只有一处定义 |
| `factors.ts` | `StockFeatures`（两口径共同的最小输入）+ `scoreStock()` + `marketGate()` | 见下方"一致性契约" |
| `exit.ts` | `stopLevel()`（fixed/ATR 封底）与 `nextDayExit()`（次日出场阶梯） | 回测、训练标签、实盘退出三条路必须用同一个函数，否则评的不是同一个策略 |
| `model.ts` | `FactorModel`（兼容/研究用）、`LlmAdvisory`（日频情绪闸门 + 个股 veto） | Jev 全程模式下 FactorModel 不得作为决策降级；每个决策都必须有 trace |
| `jev.ts` | `JevModel`：买入与可裁量卖出统一调用远端 Jev，返回 `model-prompt` 概率和 `Decision.trace`；失败只 HOLD | 因子只提供硬筛选候选，Jev 决定是否买/卖、卖出时点及价格意图；止损、T+1、涨跌停、券商开关仍是硬边界 |
| `orders.ts` | 建议单生成、`updateResting` 逐轮观察区间、`settlePending` 在途单结算、`tryPaperFill` 影子成交 | 撮合的保守性（对手价、限价钳制、本轮挂的下轮才成交、当日有效、买卖双向）全在这一个可测的入口里 |
| `state.ts` | `Book`：T+1 `sellable`/`frozen`、买入费用按比例结转、止损线随成交落账、权益曲线、`rebuild()/verify()`、原子持久化 | 账本必须能被回测、CLI 回填、HTTP 回填三条路共用；撤销靠重放而不是反向数学；快照与流水不平就以流水为准重建 |
| `lock.ts` | 账本单实例锁（`index.ts` / `once.ts` / `fill.ts` 共用） | `data/` 里全是"整份读入再整份写回"的文件，双写必互相覆盖 |
| `engine.ts` | 主循环、调度点、新鲜度门控、降级、影子撮合驱动、心跳事件 | 唯一有状态与时序的地方 |
| `server.ts` | `GET /`、`/history`、`/positions`、`/fills`、`/orders`、`/equity`、`/events`(SSE)、`POST /scan`、`/fill`、`/fill/remove`、`/reset`、`/broker/order` | 默认只绑回环；写接口要 `writeAllowed()`（非回环/跨源必须带 `API_TOKEN`）；`/broker/order` 幂等且需 `confirm=SUBMIT`；`/reset` 需 `confirm=CLEAR` |

## 心跳事件 `TickEvent`

一轮一条，前端与回测都消费它：

```ts
{ seq, ts, date, time, phase, tradingDay, trigger,
  index:  { price, pct, amountYi, ma5 },
  gate:   { allowed, reasons[] },                       // 大盘闸门，关了就什么都不做
  bias:   { emotionScore, allowOpen, reason, vetoes, llmFailed, enabled } | null,
  universe, quotes: { ok, fails, stale, eodOnly, quoteDay, ageSec },
  scan:   { scored, rejected, top[{code,name,score,gainPct,volumeRatio,priceVsVwapBps,reasons}] },
  decision: { action, probabilities{buy,sell,hold}, probabilitySemantics, picks[], latencyMs, late, modelFailed, trace } | null,
  decisions: { buy?, sell? },                         // 同轮买卖判断分开留证
  orders:   SuggestedOrder[],   // 本轮新产生的建议单
  fills:    Fill[],             // 本轮影子成交
  positions:PositionView[], totals: Totals, note }
```

`note` 是人话状态（`"45ms"` / `"行情已老化 120s > 30s，本轮不出单不撮合"` /
`"…· 涨停池未采到，情绪否决本轮跳过"`），既进日志也进仪表盘，出问题时第一眼看它。

`probabilitySemantics` 不是装饰：`rank-share` 意思是“这是候选间的排序占比，不是概率”
（FactorModel 把打分离 softmax，有 picks 时 buy 恒为 1）；`calibrated` / `model-prompt` 才是概率。
面板必须根据这个字段标清楚，否则“买入 100%”会被当成胜算读。

## 调度点

| 时刻 | 做什么 | 不满足什么就不做 |
| --- | --- | --- |
| 09:05 起每日一次 | 调 LLM 出当日 `allowOpen` 与 veto 名单；用最近快照做一次盘前预选（只出观点不出单） | 非交易日 |
| 09:30–14:57 每轮 | 系统先执行止损保护；其余持仓卖出时点、方向与价格意图由 Jev 判断 | 行情不新鲜、无可卖数量、该标的已有在途卖单 |
| 09:30–14:57 每 `DECIDE_EVERY_MS` | 买入决策：硬筛选 → 闸门/风控/额度 → Jev 逐候选判断 → 建议单 | 闸门关、额度用完、行情不新鲜、该标的已有在途买单或已持仓 |
| 每轮 | 在途单结算（隔日作废、收盘作废、本轮挂的下轮才成交）+ 盯市 + 心跳事件 | 非当日快照不参与撮合 |

卖出评估在整个连续竞价时段只要持仓可卖就按 `DECIDE_EVERY_MS` 跑 Jev（不再使用 SellAdvisor）。涨停池也在这个窗口里
按决策节奏现采（采到才能当否决项）。`POST /scan` 是人工复盘入口：收盘后可以强制跑一次选股，
但**不会伪造成交** —— 撮合要求“当日 + 新鲜 + 连续竞价”三个条件同时成立，而且收盘会把当日单作废。

## 一致性契约

`factors.ts` 暴露两个构造函数，把不同数据源压成同一个 `StockFeatures`：

- `featuresFromSnapshot(snap, date)` —— 盘中：量比、分时均价直接来自接口
- `featuresFromDaily(bar, prevBar, avgVol5, name, code)` —— 回测：量比 = 当日量 / 前 5 日均量，
  VWAP = 成交额 / (成交量 × 100)，涨跌停价按板别规则自己算

`scoreStock(features, boosters, useBoosters, params)` 只吃 `StockFeatures`，
所以**喂同样的输入必然得到同样的分数与否决理由** —— `test/consistency.test.ts` 钉的就是这一条。

它保证的是“函数同一份”，**不保证“输入同一天同一含义”**：日线口径的 gainPct/VWAP/成交额是全天值，
快照口径是“截至目前”的累计值；回退源（腾讯/新浪）根本没有换手率字段（直接当 0）。
所以这个契约的真实边界是：**入场时点与数据源一致时，两边可比**；尾盘对尾盘成立，
尾盘回测对盘中入场不成立（见 `docs/STRATEGY.md` 的入场时刻一节）。把上面的测试当“回测=实盘”的
护身符就是自欺，它是函数层的防弹衣，不是口径层的。
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

端口：后端 `3005`（默认只绑 `127.0.0.1`）、前端 `3006`。
`data/` 下全部是本地状态：`positions.json`（账本快照）、`trades.jsonl`（成交流水，唯一事实）、
`.engine.lock`（单实例锁）、`voids.log`（撤销/清空痕迹）、`archive/<时间戳>/`（清空前的旧账本）、
`shadow/<date>.jsonl`（其余模型的 forward 对照记录）、`cache/universe-<date>.json`、
`daily/<code>.json`、`llm/<date>.json`；结论证据 `backtest.txt/json`、`sweep.tsv`、`model.json` 入库。
所有写入走“写临时文件 + rename”的原子替换，避免半份文件把整本流水带走。

两个破坏性操作都要求显式确认且留痕迹：

- **撤销一笔成交**：`Book.rebuild(剩下的)` 重放重建 → 现金/可卖/冻结/已实现盈亏永远自洽；
  原成交整行追写到 `data/voids.log`
- **清空账本**：先把 `trades.jsonl` + `positions.json` 复制进 `data/archive/<时间戳>/`，再重建空账本；
  HTTP 层不带 `{"confirm":"CLEAR"}` 直接 400

删文件只是最后手段，不再是唯一选项。
