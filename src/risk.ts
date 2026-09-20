/**
 * 组合级风控闸：日亏损上限 + 权益回撤上限。
 * 只封"新开仓"，永远不封退出 —— 止损/清仓在任何亏损状态下都必须走得掉。
 * 纯函数，单测覆盖；基准值（日初权益、权益峰值）由 Book 维护并随账本持久化。
 */

export interface RiskInput {
  equity: number;
  dayStartEquity: number;
  peakEquity: number;
  /** 当日亏损达到此百分比（相对日初权益）停止开仓，次日自动恢复 */
  dayLossLimitPct: number;
  /** 权益自峰值回撤达到此百分比停止开仓，创新高后自动恢复 */
  drawdownLimitPct: number;
}

export interface RiskBrake {
  buyBlocked: boolean;
  reasons: string[];
  dayPnlCny: number;
  dayLossLimitCny: number;
  drawdownPct: number;
  drawdownLimitPct: number;
}

export function riskBrake(a: RiskInput): RiskBrake {
  const reasons: string[] = [];
  const dayPnlCny = a.equity - a.dayStartEquity;
  const dayLossLimitCny = a.dayStartEquity * (a.dayLossLimitPct / 100);
  const drawdownPct = a.peakEquity > 0 ? ((a.peakEquity - a.equity) / a.peakEquity) * 100 : 0;

  if (a.dayLossLimitPct > 0 && a.dayStartEquity > 0 && dayPnlCny <= -dayLossLimitCny) {
    reasons.push(`当日亏损 ${dayPnlCny.toFixed(0)} 元触及上限 ${a.dayLossLimitPct}%（${dayLossLimitCny.toFixed(0)} 元），今日停止开仓`);
  }
  if (a.drawdownLimitPct > 0 && drawdownPct >= a.drawdownLimitPct) {
    reasons.push(`权益回撤 ${drawdownPct.toFixed(1)}% 触及上限 ${a.drawdownLimitPct}%，停止开仓直至创新高`);
  }

  return {
    buyBlocked: reasons.length > 0,
    reasons,
    dayPnlCny,
    dayLossLimitCny,
    drawdownPct,
    drawdownLimitPct: a.drawdownLimitPct,
  };
}
