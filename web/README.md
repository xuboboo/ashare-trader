# ashare-trader — web

A 股 T+1 决策台前端：Next.js（App Router、TypeScript、全局样式 + 设计变量，无 Tailwind）。
它只读后端 SSE 并提供两个写操作：立即扫描、回填真实成交。不下单。

## Run

```bash
bun install
bun run dev      # http://localhost:3006
```

后端默认在 3005（见 `../.env` 的 `PORT`）。改端口要同步 `NEXT_PUBLIC_API_URL`。

## Config

`.env.local`（模板 `.env.example`）：

- `NEXT_PUBLIC_API_URL` —— 后端地址，前端在 `$NEXT_PUBLIC_API_URL/events` 上开 EventSource

## Layout

- `src/lib/types.ts` —— 与后端 `src/engine.ts` 的 `TickEvent` 一一对应的线上类型
- `src/lib/useFeed.ts` —— SSE hook：`snapshot` / `tick` / `ping`、1000 条窗口、**按 seq 去重**、
  1s→10s 退避重连、`connection` 状态、`avgLatencyMs`；`useApi()` 封装 `POST /scan` 与 `POST /fill`
- `src/lib/format.ts` —— 金额/百分比/bps 格式化，`orderLine()` 出可复制的下单指令，`fillCommand()` 出可复制的回填命令，
  `phaseCn()` 时段中文化
- `src/app/globals.css` —— 设计变量与全部组件样式。注意 A 股习惯 **红涨绿跌**，与美股相反
- `src/components/Header` —— 标题 + 一行元信息（连接灯、时段、触发点、PAPER、模型、股票池、北京时间）
- `src/components/StatsRow` —— 一行密排数字：指数、成交额、权益、盈亏、持仓、成交、快照覆盖、**行情延迟**、运行时长
- `src/components/Signals` —— 建议单表格（一行一单）+ 底部内联回填表单
- `src/components/Positions` —— 持仓表格：可卖 / 今日买入分列，止损与浮动盈亏
- `src/components/FlowChart` —— 上证折线 + MA5、大盘闸门否决理由、候选排名表
- `src/components/Feed` —— 心跳流，一行一轮

## 视觉约定（为什么长这样）

**扁平编辑式：整页只有一块白板，其余全部是发丝线分区，没嵌套卡片。**

- 区块用 `.section` + `.head`（小字重标题在左、文字按钮在右），相邻区块之间只一条 `1px --hair`
- 数据一律表格，`th/td` 只有横线；数字右对齐 + `font-variant-numeric: tabular-nums`，
  文本列（`.txt`）左对齐，长文本列（`.why`）省略号截断
- 按钮是**无边框文字 + 下划线**（`.btn` / `.btnPrimary`），不做圆角胶囊
- 提示（`.banner`）是一行琥珀色文字 + 发丝线，不是黄色圆角块
- 两栏中间只有一条竖发丝线；宽度 < 900px 时自动堆叠成单栏
- 时间统一按 `Asia/Shanghai` 计算，不依赖浏览器时区

改样式只需改 `src/app/globals.css`：组件里没有 CSS Modules，也没有内联颜色。

## 相关文档

后端与全局：[../README.md](../README.md)、[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)、
[docs/DATA.md](../docs/DATA.md)（L1 与延迟实测）、[docs/STRATEGY.md](../docs/STRATEGY.md)（回测结论）、
[docs/USAGE.md](../docs/USAGE.md)、[docs/COMPLIANCE.md](../docs/COMPLIANCE.md)。

前端约定：无 CSS Modules，组件样式集中在 `src/app/globals.css` 的设计变量与类名里；
颜色按 **A 股习惯红涨绿跌**；时间统一按 `Asia/Shanghai` 计算，不依赖浏览器时区。
