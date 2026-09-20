# ashare-trader — A 股 T+1 决策台

**A 股 T+1 决策台**：把 [Jev](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)（TypeSafe 的 System One 模型）接进 A 股的选股决策，
配上严格到难看的成本核算、日线 T+1 回测，以及"AI 说了不算、硬约束说了算"的执行层。
它不自动下单 —— **交易时段全程决策**：09:05 盘前预选一次；09:30 起连续竞价时段每 `DECIDE_EVERY_MS`（默认 60s）做一轮买入决策；持仓退出（止损 / 高开减半 / 到点清仓）只要持仓可卖就每轮评估。

> **当前状态：策略未通过自己的回测门槛，停在回测层。**
> 36 组参数全部净期望为负，最好的一组是 `毛利 +11bp − 成本 11.6bp = 净 −0.58bp`。
> 代码是完整可跑的，结论是"这条 edge 不存在"。全部数据与推导见
> [docs/STRATEGY.md](docs/STRATEGY.md)。

## 三路决策模型

| MODEL | 是什么 | 什么时候用 |
| --- | --- | --- |
| `factor`（默认） | 确定性规则打分，毫秒级，完全可回测 | 想要稳定出单、跑通全流程 |
| `local` | 本地概率模型：`bun run train` 用本地日线 + 与回测同一条出场规则训练的逻辑回归，输出"扣成本后为正"的概率 | 想要概率化的排序与阈值；零 API、零费用、可复现 |
| `jev` | TypeSafe System One 远端评估模型（需 `TYPESAFE_AI_API_KEY`，无 key 自动降级 factor） | 有 key 且愿意接受外部依赖 |

`local` 的训练报告会如实写进 `data/model.json`（留出集 AUC、按阈值采纳后的净期望 bp）。
以 2026-09 全池日线（295 支）训练的结果：留出集 AUC 0.532、0.55 阈值下 781 条留出样本 0 条采纳——
**当前因子集对"隔夜+成本"口径没有可用的预测力**，与 docs/STRATEGY.md 的结论一致。
要让它真的出单需要调低 `JEV_MIN_PROB`（例如 0.3，见面板"本地模型判定"），但请先读上面的数字。

```
# 训练与重训（每次抓完新日线后跑一次即可，完全确定性）
bun run fetch:daily
bun run train
```

## 它能做什么 / 不能做什么

| 能 | 不能 |
| --- | --- |
| 用真实行情跑通"选股 → 建议单 → 影子成交 → 含成本盈亏"全链路 | **不会也不会替你下单**：没有券商量化接口时人工执行是唯一合规路径 |
| 告诉你每一单的往返成本是多少 bp、止损价、次日必须几点走 | 做不了日内挂撤单吃价差（T+1 + 涨跌停 + 程序化报备） |
| 用日线严格 T+1 回测，并给"过 / 不过"的判定 | 给不了正期望的日内策略（数据是 L1 三秒快照，见 [docs/DATA.md](docs/DATA.md)） |
| 记录你手工回填的真实成交，统计建议价与成交价之差 | 保证回测结论可外推（样本有选择偏差，README 下方明确写了） |
| 让 Jev 给每只候选一个可审计的胜率（`decision.picks[].probability`，带 `inputTokens` 计费口径） | 让模型决定"能不能买"—— 闸门、T+1、涨跌停、流动性仍是代码里的硬否决 |

## 关于 Jev（以及"首个"这个说法）

Jev 是 TypeSafe 在 2026-09-16 发布的 "System One 模型"：它不生成文本，而是输入一份 state 与若干问题，
**并行**返回带概率的结构化判断（boolean / choice / score 三类）。官方口径的分类任务上比对照大模型快约 194–200 倍、
便宜约 444 倍，端到端延迟 70–500ms，输入 $0.042/百万 token（这些数字来自 TypeSafe 与 LangChain 的公开介绍，
**我们未独立复测**，本项目也不靠它们成立）。

本项目的用法（`src/jev.ts`）：

- 问的是**可判定的陈述**，不是"你怎么看这只票"：
  *"在 14:45 以对手价买入 X，按规则于次日 10:00 前退出，扣除约 11.6bp 往返成本后本笔收益为正"*
- 一次请求把最多 20 只候选一起问完（共享同一 state），boolean 返回的概率即该陈述为真的概率
- 模型看到的 state 与规则层**同一份数据**（同一 `StockFeatures`、同一 `costs.ts` 口径），不给它任何额外字段，
  否则回测/实盘一致性就破了
- 大盘闸门、T+1、涨跌停、流动性、一手门槛**不交给模型**；Jev 只在已经通过筛选的候选里给胜率与排序
- 没配 key / 超时 / 返回不可用 → 立即降级回规则打分并在事件里标 `modelFailed`，**绝不编一个概率出来**

**关于"首个"**：据我们所知，这是第一个把 Jev 用作 A 股选股决策模型的开源实现（截至 2026-09-21；
在 GitHub 检索 `Jev` + `A股/ashare/china stock` 未见到同类，公开的 Jev 交易案例集中在加密市场）。
这是一个**可证伪的说法**：如果你知道反例，开个 issue，我们当天改这段措辞。

启用：

```powershell
# .env
MODEL=jev
TYPESAFE_AI_API_KEY=你的 key
bun run start
```

不配 key 也照跑：自动降级为 `MODEL=factor`，功能不缺失，只是不用模型。

## Quickstart

```powershell
cd ashare-trader
bun install
Copy-Item .env.example .env      # 默认 PAPER=true、本金 15 万、单笔 5 万
bun run start                    # 后端 http://localhost:3005

cd web
bun install
bun run dev                      # 仪表盘 http://localhost:3006
```

跑起来就能看到：真实股票池 300 支、上证指数与 MA5、大盘闸门判定、候选排名表。
**非交易时段也能跑**：用最近一个交易日的收盘快照做复盘，仪表盘顶部有横幅说明数据来源时刻。

三条验证命令：

```powershell
bun test                                     # 72 pass / 0 fail
bun run scripts/probe-latency.ts             # 各行情源的往返延迟与数据新鲜度
bun run scripts/backtest.ts --from=2024-01-01 --sweep   # 36 组参数扫描
```

## 日常怎么用

1. **开盘后**看"模型决策"面板：大字结论（买入/观望）与概率条，闸门关着就不动手
2. 出建议单后，**在券商 App 里手工下单**（行里点"复制"，一行字直接可粘）
3. 成交了立刻回填：仪表盘表单、`bun run scripts/fill.ts 002156 buy 800 "@61.40"`、或 `POST /fill`
4. 次日 9:30-10:00 按系统提示的退出动作走（高开减半 / 跌破止损 / 到点清仓）
5. 收盘后 `POST /scan` 复盘，或 `bun run scripts/backtest.ts` 重跑统计
6. **回填错了不要紧**："成交与账本"区里每行有"撤销"（重放剩下的成交重建账本），
   整本想重来就点"清空账本"（先归档到 `data/archive/` 再清零）；CLI 对应 `--undo=<id>` 与 `--reset`

细节（参数含义、故障排查、常见误操作）见 [docs/USAGE.md](docs/USAGE.md)。

## 接口

只读：`GET /`（元信息 + 最新心跳）、`/history`、`/positions`、`/fills`、`/orders`、`/equity`（权益曲线）、`/broker`（QMT sidecar 状态）、`/events`（SSE）。
写（只改本地账本，不产生任何委托）：

| 方法 | 作用 | 备注 |
| --- | --- | --- |
| `POST /scan` | 立即跑一次选股 | 收盘后也能跑（复盘），但**不会伪造成交** |
| `POST /fill` | 回填一笔真实成交 | `{code, side, qty, price?, signalId?, note?}` |
| `POST /fill/remove` | 撤销一笔误回填 | `{id}`；重放剩下的成交，原流水进 `data/voids.log` |
| `POST /reset` | 清空账本 | 必须带 `{"confirm":"CLEAR"}`；旧 `trades.jsonl`/`positions.json` 先归档 |
| `POST /broker/order` | 把一张在途建议单推给 QMT sidecar | 必须带 `{"signalId":"...","confirm":"SUBMIT"}`；sidecar 处于 `mock`/`dry` 时只记录不下单，`live` 前置条件见 `docs/COMPLIANCE.md` |

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块职责、数据流、`TickEvent` 结构、四个扩展点 |
| [docs/DATA.md](docs/DATA.md) | 数据源与字段映射、GBK/限流/多源回退、**L1 与延迟实测**、新鲜度硬规则 |
| [docs/STRATEGY.md](docs/STRATEGY.md) | 因子与闸门定义、回测方法、**36 组参数全表与为什么必然失败**、下一步三条路 |
| [docs/USAGE.md](docs/USAGE.md) | 启动、三个触发点、回填三种入口、参数表、故障排查 |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | A 股规则如何落到代码里、程序化交易报备边界、接 QMT 前要做什么 |
| [web/README.md](web/README.md) | 仪表盘组件与 SSE hook |

## 代码结构

```
src/
  config.ts     全部参数（含成本与因子阈值）
  http.ts       限流行情 HTTP（3 req/s、单 URL 1s 去重、退避带抖动）
  session.ts    时段状态机 + 北京时间（不依赖本机时区）
  calendar.ts   交易日历：读上证日线，不内置节假日表
  quotes.ts     快照(腾讯 GBK 五档) / 榜单(东财) / 日线(东财→腾讯→新浪) / 涨停池
  symbols.ts    A 股规则：板别涨跌幅、涨跌停价四舍五入、100 股一手
  costs.ts      佣金 max(5, 0.025%)、印花税卖出单边、过户、经手证管、滑点
  factors.ts    因子打分 + 大盘闸门；日线口径与快照口径共用同一个 scoreStock
  model.ts      FactorModel（默认，毫秒级）+ LlmAdvisory（仅日频：情绪闸门 + 个股 veto）
  jev.ts        JevModel：TypeSafe System One 模型接入，逐只候选问 boolean，失败自动降级
  orders.ts     建议单生成 + 纸面撮合（观测价成交、限价钳制、一字板不成交）
  state.ts      Book：T+1 可卖/冻结、费用按比例结转、权益曲线、rebuild 重放、JSON 持久化
  engine.ts     主循环：单轮在途、三个调度点、新鲜度门控、心跳事件
  server.ts     Bun.serve：/ /history /positions /fills /orders /scan /fill /fill/remove /reset /events(SSE)
scripts/        once · probe · probe-latency · fetch-daily · backtest · fill
test/           9 个文件 72 个用例（含契约测试、回测/实盘一致性、账本重放自洽、Jev 接入与降级）
web/            Next.js 仪表盘
data/           本地账本、日线、回测产物（全部 gitignore）
```

## 为什么是日频，不是高频

A 股个股上做不了高频挂撤单吃价差，四条约束叠加：

| 约束 | 后果 |
| --- | --- |
| T+1 | 当日买入不可卖 → 隔夜跳空风险无法回避，止损不是万能保护 |
| 涨跌停与停牌 | 一字涨停买不进、一字跌停卖不出；停牌期间只能拿着 |
| 程序化交易报备 | 现行高频认定线为单账户每秒申报/撤单合计 ≥300 笔或单日 ≥2 万笔（2026 年流传的"降到每秒 15 笔"不在任何条文中，已辟谣） |
| 成本结构 | 5 元最低佣金 + 印花税把零售往返成本钉在 **11.6bp** 附近；加大单笔金额也降不下来，超过 20 万后成本由比例费主导 |

所以本项目的定位是**日频决策 + 人工执行 + 严格记账**，不是低延迟交易机。
行情侧同理：用的是 L1 三秒快照，没有逐笔与委托队列（见 [docs/DATA.md](docs/DATA.md)）。

## 已知缺陷（写在这里，不让它藏在代码注释里）

- **选择偏差**：回测股票池是"今天"的成交额前 100，它们过去两年本来就更可能强势
- **日线近似**：`次日 10:00 前清仓` 用收盘价代理；止损按当日最低价触及判定
- **成交额估算**：东财日线被限流时改走腾讯/新浪，那两源没有成交额字段，
  用 `(高+低+收)/3 × 成交量` 估算并打 `amountEst` 标记（当前样本 31/99 支），
  影响 2 亿流动性门槛与 VWAP 因子
- **回测与实时撮合口径不完全一致**：实时路径用下一轮观测价 ± 滑点，回测用收盘价。
  要消除这个差异需要分钟线或券商委托回报

## 免责声明

研究用代码，不构成投资建议。数据来自免费非官方接口（东财 / 腾讯 / 新浪），
仅适合研究与盘面辅助，不保证准确、及时与可用；任何实盘决策请自行判断并承担后果。
