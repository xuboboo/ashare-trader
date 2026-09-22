# 使用手册

## 启动

```powershell
cd ashare-trader
bun install
Copy-Item .env.example .env      # 第一次才需要
bun run start                    # 后端 :3005

cd web ; bun install ; bun run dev   # 仪表盘 :3006
```

启动横幅就是体检报告：

```
ashare-trader · model=factor · transport=rules-factor · advisory=off · PAPER（影子成交，不下真实委托） · 股票池 300 ·
日历已加载(250天) · continuous · 全程决策中（盘中+尾盘同规则） · :3005
```

- 默认只监听 `127.0.0.1`。要从局域网/手机直接访问，设 `API_HOST=0.0.0.0` **并且同时设 `API_TOKEN`**；
  远程面板用 `?api=http://…&token=…`
- `日历退化(周一~五)` → 上证指数日线三个源都没拉到，交易日判定在猜，别信当日信号
- `advisory=off` → 没配 `LLM_API_KEY`，情绪闸门与个股 veto 不生效；`transport=jev-remote-configured` 才表示 Jev 已配置远端通道
- 时段显示 `closed` → 非交易日/非交易时段，引擎每 60s 一次心跳，不会去拉 300 支快照

## 盘中怎么用

| 时刻 | 看哪里 | 动作 |
| --- | --- | --- |
| 09:05 | 「模型决策」面板的常设命令与闸门徽章 | 显示"关"→ 今天什么都不做，横幅会写原因 |
| 09:30-14:57 | 「模型决策」与「建议单」里的卖出单 | Jev 自主判断卖出；止损、T+1、涨跌停仍由系统硬规则约束 |
| 09:30-14:57 | 「模型决策」大字结论 + 「建议单」里的买入单 | 每 `DECIDE_EVERY_MS`（默认 30s）一轮新决策；出单后点"复制下单指令" → 券商 App 照抄 → 回填 |
| 收盘后 | 「心跳流」+ 持仓表 | 核对今天的成交是否都已回填，看含成本盈亏 |

**下单前必看的两个数**：卡片上的 `往返成本 bp` 与 `warn`。
出现"触发最低佣金"警告说明这笔太小，固定成本已经吃掉半个预期收益 —— 要么加大金额要么别做。

## 回填真实成交（三种入口，效果完全一样）

```powershell
# 1) 命令行（服务在跑就走 HTTP、账本与仪表盘同步；没在跑就直接写本地账本）
bun run scripts/fill.ts 002156 buy 800 "@61.40"
bun run scripts/fill.ts 002156 sell 800 "@62.10" --signal=S20260920-0001 --note="Jev 卖出判断"
```

```powershell
# 2) HTTP
Invoke-RestMethod -Method Post http://localhost:3005/fill -ContentType 'application/json' `
  -Body '{"code":"002156","side":"buy","qty":800,"price":61.40,"signalId":"S20260920-0001"}'
```

3) 仪表盘「建议单」面板：卡片上的"按参考价回填"，或底部表单（成交价留空 = 用最新快照价）。

回填后账本会立刻反映：现金减少、新买入的部分进 `frozen`（今日不可卖）、买入费用累计并在卖出时
按比例结转进已实现盈亏。

> PowerShell 里 `@61.40` 必须加引号，否则被当成 splatting 运算符报错。

## 改错：撤销一笔 / 清空账本

回填错了、或者昨天手滑造了一个不存在的持仓，不必去删文件：

| 入口 | 撤销一笔 | 清空账本 |
| --- | --- | --- |
| 仪表盘 | 「成交与账本」每行末尾的「撤销」（有 confirm） | 该区右上角「清空账本」（两次 confirm） |
| 命令行 | `bun run scripts/fill.ts --undo=<成交id>` | `bun run scripts/fill.ts --reset` |
| HTTP | `POST /fill/remove {"id":"..."}` | `POST /reset {"confirm":"CLEAR"}` |

**为什么不会把账算歪**：撤销不是做反向数学，而是 `Book.rebuild()` —— 把**剩下的**成交按时间重放一遍，
现金、可卖/冻结、费用分摊、已实现盈亏全部从头推演，因此始终自洽
（`test/state.test.ts` 的"撤销成交（重放重建账本）"三个用例钉住了这一点，包括撤销中间那笔部分卖出）。

**不会隐式硬删**：
- 撤销的原流水追写到 `data/voids.log`（一行一条，含完整 JSON）
- 清空前 `trades.jsonl` 与 `positions.json` 会先复制到 `data/archive/<时间戳>/`
- `/reset` 不带 `{"confirm":"CLEAR"}` 直接返回 400，防一个 curl 误伤

成交 id 格式为 `YYYYMMDD-HHMM-代码-方向-序号`（末尾序号保证同一分钟的两笔同向单不会撞 id，
否则「撤销」会撤错一笔），由 `GET /fills` 返回（在仪表盘上点「撤销」不需要手填 id）；
命令行要用 `--undo` 时先 `Invoke-RestMethod http://localhost:3005/fills | % { $_.fills.id }` 拿。

## 启用 Jev 作为决策模型

```powershell
# .env
MODEL=jev
TYPESAFE_AI_API_KEY=ts_xxx...
bun run start
```

行为要点：

- 只在**大盘闸门开着**且有可买候选时调用；闸门关着或没额度不会花一次调用。连续竞价时段按 `DECIDE_EVERY_MS` 节奏触发（不再只限尾盘）
- 一次请求把最多 `JEV_MAX_QUESTIONS` 只候选问完；问题文本里写死了退出规则与往返成本
- 返回的概率低于 `JEV_MIN_PROB` 的候选直接不采纳；全部不及格就是 hold，不硬凑一单
- 同一轮输入相同会命中 `data/llm/jev-<date>-<hash>.json` 缓存，不重复计费
- 没 key / 超时 / 返回不可用 → Jev fail-closed HOLD，绝不冒充规则模型（`decision.modelFailed`）

验证降级与出单逻辑不需要 key：`bun test test/jev.test.ts`（用注入的假回答跑完九种情形）。

## local 训练状态

旧 `bun run train` 已停用。它基于 `data/daily` 和固定持有期标签，不能与 Jev 自主持仓研究混用；
当前 `MODEL=local` 不应作为研究结论或生产切换目标。先按 [研究链路](RESEARCH.md) 生成并审计 v2 Jev holding labels，
再单独设计只使用这些标签的训练器。

## 参数表（`.env`，全部有代码内默认值）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `UNIVERSE_SIZE` | 300 | 按成交额取前 N 支作股票池 |
| `WATCHLIST` | 空 | 逗号分隔 6 位代码，无论排名强制入池 |
| `POLL_MS` | 3000 | 交易时段轮询间隔 |
| `QUOTE_STALE_SEC` | 30 | 行情超过这个年龄就不出单、不撮合 |
| `EOD_ONLY` | false | 只用日频（盘中实时链路故障时自动置 true） |
| `PAPER` | true | 影子成交。本方案不会改成自动下单 |
| `CNY_BANKROLL` | 150000 | 参考本金（盈亏与仓位百分比的分母） |
| `SIZE_CNY` | 50000 | 单笔金额 |
| `K` | 3 | 同时最多持有几只 |
| `MAX_DAILY_OPENS` | 4 | 每日最多开仓次数 |
| `STOP_LOSS_PCT` | 3 | 止损百分比 |
| `STOP_MODE` | fixed | fixed = 固定百分比；atr = 买入价 − ATR_K×ATR₁₄（封底买入价×90%），ATR 缺失自动回退 fixed |
| `ATR_K` / `ATR_N` | 2.5 / 14 | atr 模式的止损倍数与回看窗口；回测对比 `bun run scripts/atr-sweep.ts` |
| `GAP_TRIM_PCT` | 3 | 次日高开超过该值先卖一半 |
| `FORCE_EXIT_AT` | 已移除 | 生产 Jev 模式不设置固定清仓时刻，退出时点由 Jev 决定 |
| `MAX_DAY_LOSS_PCT` | 3 | 当日亏损（相对日初权益）达到此值停止开仓，次日自动恢复；0 关闭 |
| `MAX_DRAWDOWN_PCT` | 10 | 权益自峰值回撤达到此值停止开仓，创新高自动恢复；0 关闭 |
| `COMMISSION_RATE` / `COMMISSION_MIN` | 0.00025 / 5 | 佣金，**按你券商真实档位改** |
| `STAMP_TAX_RATE` | 0.0005 | 印花税（卖出单边） |
| `TRANSFER_FEE_RATE` / `EXCHANGE_FEE_RATE` | 0.00001 / 0.000068 | 过户费、经手+证管 |
| `SLIPPAGE_TICKS` | 1 | 只在盘口整本缺失时兜底；正常影子成交直接吃对手价（买吃卖一、卖打买一） |
| `GAIN_MIN_PCT` / `GAIN_MAX_PCT` | 3 / 7 | 涨幅区间 |
| `VOLUME_RATIO_MIN` | 1.5 | 量比下限 |
| `MIN_AMOUNT_YI` / `MIN_MCAP_YI` | 2 / 60 | 成交额与市值门槛（市值只在实盘快照路径生效，日线口径没有该字段） |
| `MIN_LIST_DAYS` | 60 | **回测数据层**生效：日线不够这个根数的股票直接不进样本（`fetch-daily`） |
| `INDEX_MIN_AMOUNT_YI` | 3000 | 大盘闸门的上证成交额下限 |
| `MODEL` | factor | `factor` = 规则打分；`local` = 本地概率模型（`bun run train`）；`jev` = 用 Jev 给每只候选出概率（失败 fail-closed HOLD，不降级 factor） |
| `TYPESAFE_AI_API_KEY` | 空 | Jev 的 key。**不配也能跑**，只是 `MODEL=jev` 会立刻降级并在事件里标 `modelFailed` |
| `TYPESAFE_BASE_URL` / `JEV_MODEL_ID` | api.typesafe.ai/v1 / jev-latest | Jev 接入点 |
| `JEV_MIN_PROB` | 0.55 | 胜率阈值：jev 用它筛；local 有校准表时改用“期望>0”，没校准表才退回这个阈值 |
| `JEV_MAX_QUESTIONS` | 20 | 一次请求问几只（共享 state、并行判定，多问几乎不增加延迟） |
| `JEV_TIMEOUT_MS` | 15000 | 超过就降级，不卡心跳 |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | deepseek | 另一个东西：盘前情绪闸门与个股事件 veto；留空 key 即关闭 |
| `PORT` | 3005 | 后端端口（前端在 `web/.env.local` 的 `NEXT_PUBLIC_API_URL` 同步） |
| `API_HOST` | 127.0.0.1 | 监听地址。面板有“清空账本”与“推给券商”两个写接口，不要在无口令时绑 0.0.0.0 |
| `API_TOKEN` | 空 | 写接口口令（`x-auth` 头）。非回环请求与陌生站点发起的跨源写请求都需要；留空 = 只允许本机非跨源 |
| `DATA_DIR` | data | 本地目录。相对路径永远相对仓库根解析，不跟 cwd 跑（避免从别的目录启动静默换一套账本） |

## 回测与复盘

```powershell
bun run scripts/fetch-daily.ts --sample=100 --days=750   # 已有文件会跳过，--force 重下
bun run scripts/backtest.ts --from=2024-01-01            # 输出 data/backtest.txt + .json
bun run scripts/backtest.ts --from=2024-01-01 --sweep    # 36 组参数 → data/sweep.tsv
bun run scripts/backtest.ts --k=1 --gain-min=4 --vr-min=1.5 --size=200000   # 单组
bun run scripts/backtest.ts --stop=atr                   # 止损口径写在命令行，不隐式跟 .env
bun run scripts/backtest.ts --select=random              # 对照：因子排序 vs 乱选（reverse 也行）
bun run scripts/backtest.ts --risk-gate=true             # 开风控闸，看资金曲线（注意会截断样本）
bun run scripts/atr-sweep.ts                             # 止损机制对比 + 三门槛实量
Invoke-RestMethod http://localhost:3005/stops            # 双口径反事实对照（每平一笔仓一条）
bun run scripts/probe-latency.ts                         # 行情源往返与新鲜度
bun run scripts/once.ts                                  # 只跑一轮，看链路
```

口径约定：`--sweep` 与净期望相关的结论一律用**关风控闸**的数（测策略本身）；开闸只用来评估
风控对资金曲线的保护，它会提前停手从而截断样本。`--size` / `CNY_BANKROLL` 改变成本量级
（3300 元档往返 36.9bp 名义、实测 44.6bp），不同档的结果不可互相引用。

`backtest.json` 里的 `trips` 是逐笔明细（建仓日、退出日、成交价、数量、净 bps、退出原因），
可以直接审计"有没有当天买卖"这类问题。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 日志反复出现 `批量快照失败(1..3)` 然后横幅"已降级为日频" | 免费源限流或封 IP。等几分钟自动恢复不了就换网络；`eodOnly=true` 期间只有盘前一次信号 |
| `日线三个源全部失败` | 东财熔断 + 腾讯/新浪也不通；`fetch-daily` 支持断点续跑（已下载的会跳过） |
| 启动横幅 `日历退化` | 同上，日线拿不到。交易日判定不可靠，别信当天信号 |
| `[book] …发现快照与流水不平…已按流水重建` | 曾有双写/手改文件。现在每次落盘都会自检，`trades.jsonl` 是唯一事实；反复出现就查是不是两个引擎在跑 |
| `[lock] 已有实例在运行` | 单实例锁拒了双开。要跑 `scripts/once.ts` 就直接用它（会自动改走 `POST /scan`），或先停掉服务 |
| 写接口返回 401 | 非回环请求或陌生站点跨源，没带 `x-auth`。本地面板用 `?token=xxx` 传入口令 |
| 建议单为空但候选表有票 | 看闸门徽章与横幅；或 `MAX_DAILY_OPENS` / `K` 额度已用完；或该标的已有在途单/已持仓（同一标的同方向只留一张） |
| 持仓表"可卖 0、冻结 N" | 正常，T+1。当天买的必须明天才能卖 |
| 收盘后 `行情延迟` 显示 `收盘 09/18` | 正常。盘中才会显示秒级新鲜度 |
| 收盘后还有昨日建议单挂着 | 不会：隔日作废 + 收盘作废（当日单当日清） |
| 中文在终端里是乱码 | PowerShell 控制台是 GBK，而 Bun 输出 UTF-8。先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，或 `Get-Content <file> -Encoding utf8` |
| `git log` / GitHub 上中文变 `?` | 用 UTF-8 文件传中文：`git commit -F msg.txt`；调 GitHub API 时把 body 转成 `[Text.Encoding]::UTF8.GetBytes($json)` 再发 |
| 端口被占用 | `Get-NetTCPConnection -LocalPort 3005,3006 -State Listen` 反查 `OwningProcess` 后 `Stop-Process` |

## 重置环境

撤一笔或清账本都用上面的入口，不必手动删文件。确实要重置到空目录：

```powershell
Remove-Item data\positions.json, data\trades.jsonl     # 先自己归档一份再删更稳
Remove-Item data\cache -Recurse                        # 重新拉股票池
Remove-Item data\llm -Recurse                          # 让 LLM 重新判断（当天缓存会复用）
```

`data/daily/` 是回测数据，删了要重新下载（约 13 秒/100 支）。`data/` 整体被 gitignore，
但结论证据 `sweep.tsv`、`backtest.txt/json`、`model.json` 是例外（它们入库才能被别人复核）。
