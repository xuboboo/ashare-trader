/**
 * Legacy entrypoint intentionally disabled.
 *
 * The former ATR sweep used data/daily plus a fixed holding-period label. It
 * is not a Jev autonomous policy evaluation and cannot run against v2 data.
 */
throw new Error(
  "旧 data/daily ATR 扫描已停用：它使用固定持有期标签，不能作为 Jev 自主持仓研究。请使用 research:backtest 的 v2 Jev 标签链路。",
);
