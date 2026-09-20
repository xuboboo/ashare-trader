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
ashare-trader · model=factor · LLM=off · PAPER（影子成交，不下真实委托） · 股票池 300 ·
日历已加载(250天) · continuous · 14:40 尾盘选股 · :3005
```

- `日历退化(周一~五)` → 上证指数日线三个源都没拉到，交易日判定在猜，别信当日信号
- `LLM=off` → 没配 `LLM_API_KEY`，情绪闸门与个股 veto 不生效（规则层照常工作）
- 时段显示 `closed` → 非交易日/非交易时段，引擎每 60s 一次心跳，不会去拉 300 支快照

## 盘中怎么用

| 时刻 | 看哪里 | 动作 |
| --- | --- | --- |
| 09:05 | 「大盘与候选」的闸门徽章 | 显示"关"→ 今天什么都不做，横幅会写原因 |
| 09:30-10:00 | 「建议单」里的卖出单 | 按卡片提示执行（止损 / 高开减半 / 到点清仓） |
| 14:40-14:57 | 「建议单」里的买入单 | 点"复制下单指令" → 打开券商 App 照抄 → 回填 |
| 收盘后 | 「心跳流」+ 持仓表 | 核对今天的成交是否都已回填，看含成本盈亏 |

**下单前必看的两个数**：卡片上的 `往返成本 bp` 与 `warn`。
出现"触发最低佣金"警告说明这笔太小，固定成本已经吃掉半个预期收益 —— 要么加大金额要么别做。

## 回填真实成交（三种入口，效果完全一样）

```powershell
# 1) 命令行（服务在跑就走 HTTP、账本与仪表盘同步；没在跑就直接写本地账本）
bun run scripts/fill.ts 002156 buy 800 "@61.40"
bun run scripts/fill.ts 002156 sell 800 "@62.10" --signal=S20260920-0001 --note="次日10点清仓"
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

成交 id 格式为 `YYYYMMDD-HHMM-代码-方向`，由 `GET /fills` 返回（在仪表盘上点「撤销」不需要手填 id）；
命令行要用 `--undo` 时先 `Invoke-RestMethod http://localhost:3005/fills | % { $_.fills.id }` 拿。

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
| `GAP_TRIM_PCT` | 3 | 次日高开超过该值先卖一半 |
| `FORCE_EXIT_AT` | 10:00 | 次日无条件清仓时刻 |
| `COMMISSION_RATE` / `COMMISSION_MIN` | 0.00025 / 5 | 佣金，**按你券商真实档位改** |
| `STAMP_TAX_RATE` | 0.0005 | 印花税（卖出单边） |
| `TRANSFER_FEE_RATE` / `EXCHANGE_FEE_RATE` | 0.00001 / 0.000068 | 过户费、经手+证管 |
| `SLIPPAGE_TICKS` | 1 | 影子成交的滑点档数 |
| `GAIN_MIN_PCT` / `GAIN_MAX_PCT` | 3 / 7 | 涨幅区间 |
| `VOLUME_RATIO_MIN` | 1.5 | 量比下限 |
| `MIN_AMOUNT_YI` / `MIN_MCAP_YI` | 2 / 60 | 成交额与市值门槛（市值只在实盘快照路径生效，日线口径没有该字段） |
| `MIN_LIST_DAYS` | 60 | **回测数据层**生效：日线不够这个根数的股票直接不进样本（`fetch-daily`） |
| `INDEX_MIN_AMOUNT_YI` | 3000 | 大盘闸门的上证成交额下限 |
| `MODEL` | factor | 决策模型 |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | deepseek | 留空 key 即完全关闭 LLM 分支 |
| `PORT` | 3005 | 后端端口（前端在 `web/.env.local` 的 `NEXT_PUBLIC_API_URL` 同步） |

## 回测与复盘

```powershell
bun run scripts/fetch-daily.ts --sample=100 --days=750   # 已有文件会跳过，--force 重下
bun run scripts/backtest.ts --from=2024-01-01            # 输出 data/backtest.txt + .json
bun run scripts/backtest.ts --from=2024-01-01 --sweep    # 36 组参数 → data/sweep.tsv
bun run scripts/backtest.ts --k=1 --gain-min=4 --vr-min=1.5 --size=200000   # 单组
bun run scripts/probe-latency.ts                         # 行情源往返与新鲜度
bun run scripts/once.ts                                  # 只跑一轮，看链路
```

`backtest.json` 里的 `trips` 是逐笔明细（建仓日、退出日、成交价、数量、净 bps、退出原因），
可以直接审计"有没有当天买卖"这类问题。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 日志反复出现 `批量快照失败(1..3)` 然后横幅"已降级为日频" | 免费源限流或封 IP。等几分钟自动恢复不了就换网络；`eodOnly=true` 期间只有盘前一次信号 |
| `日线三个源全部失败` | 东财熔断 + 腾讯/新浪也不通；`fetch-daily` 支持断点续跑（已下载的会跳过） |
| 启动横幅 `日历退化` | 同上，日线拿不到。交易日判定不可靠，别信当天信号 |
| 建议单为空但候选表有票 | 看闸门徽章与横幅；或 `MAX_DAILY_OPENS` / `K` 额度已用完 |
| 持仓表"可卖 0、冻结 N" | 正常，T+1。当天买的必须明天才能卖 |
| 收盘后 `行情延迟` 显示 `收盘 09/18` | 正常。盘中才会显示秒级新鲜度 |
| 中文在终端里是乱码 | PowerShell 控制台是 GBK，而 Bun 输出 UTF-8。改用 `Get-Content <file> -Encoding utf8`，或直接读 `data/*.txt` |
| `git log` / GitHub 上中文变 `?` | 用 UTF-8 文件传中文：`git commit -F msg.txt`；调 GitHub API 时把 body 转成 `[Text.Encoding]::UTF8.GetBytes($json)` 再发 |
| 端口被占用 | `Get-NetTCPConnection -LocalPort 3005,3006 -State Listen` 反查 `OwningProcess` 后 `Stop-Process` |

## 重置环境

撤一笔或清账本都用上面的入口，不必手动删文件。确实要重置到空目录：

```powershell
Remove-Item data\positions.json, data\trades.jsonl     # 先自己归档一份再删更稳
Remove-Item data\cache -Recurse                        # 重新拉股票池
Remove-Item data\llm -Recurse                          # 让 LLM 重新判断（当天缓存会复用）
```

`data/daily/` 是回测数据，删了要重新下载（约 13 秒/100 支）。全部 `data/` 已被 gitignore。
