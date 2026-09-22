/**
 * Legacy entrypoint intentionally disabled.
 *
 * The previous trainer read data/daily and used a fixed holding-period label.
 * That protocol cannot train a model for Jev's autonomous holding decisions,
 * so it must not be reachable after the research protocol was upgraded to v2.
 */
throw new Error(
  "旧 data/daily local 训练已停用：它使用固定持有期标签，不能混入 Jev 自主持仓研究。请先用 research:backtest 生成并审计 v2 Jev 标签，再单独实现基于该标签的训练器。",
);
