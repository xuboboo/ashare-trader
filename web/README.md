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
- `src/lib/useFeed.ts` —— SSE hook：`snapshot` / `tick` / `ping`、1000 条窗口、1s→10s 退避重连、
  `connection` 状态、`avgLatencyMs`；`useApi()` 封装 `POST /scan` 与 `POST /fill`
- `src/lib/format.ts` —— 金额/百分比/bps 格式化，`orderLine()` 出可复制的下单指令，`fillCommand()` 出可复制的回填命令，
  `phaseCn()` 时段中文化
- `src/app/globals.css` —— 设计变量与组件样式。注意 A 股习惯 **红涨绿跌**，与美股相反
- `src/components/Header` —— 标题、连接灯、时段、PAPER 标记、北京时间
- `src/components/StatsRow` —— 指数、成交额、权益、盈亏、持仓、成交、快照覆盖、运行时长
- `src/components/FlowChart` —— 上证折线 + MA5、大盘闸门否决理由、LLM 情绪、候选排名表
- `src/components/Positions` —— 持仓：可卖 / 今日买入冻结分列，止损与浮动盈亏
- `src/components/Signals` —— 建议单卡片 + 复制下单指令 + 手工回填表单
- `src/components/Feed` —— 心跳流

## 相关文档

后端与全局：[../README.md](../README.md)、[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)、
[docs/DATA.md](../docs/DATA.md)（L1 与延迟实测）、[docs/STRATEGY.md](../docs/STRATEGY.md)（回测结论）、
[docs/USAGE.md](../docs/USAGE.md)、[docs/COMPLIANCE.md](../docs/COMPLIANCE.md)。

前端约定：无 CSS Modules，组件样式集中在 `src/app/globals.css` 的设计变量与类名里；
颜色按 **A 股习惯红涨绿跌**；时间统一按 `Asia/Shanghai` 计算，不依赖浏览器时区。
