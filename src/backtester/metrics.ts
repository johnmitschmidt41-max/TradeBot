// src/backtester/metrics.ts
import { Trade } from "./backtest-runner";

export function computeMetrics(trades: Trade[]) {
  const wins = trades.filter(t => (t.profit ?? 0) > 0);
  const losses = trades.filter(t => (t.profit ?? 0) <= 0);
  const net = trades.reduce((s, t) => s + (t.profit ?? 0), 0);

  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.profit ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.profit ?? 0), 0) / losses.length : 0;
  const winRate = trades.length ? (wins.length / trades.length) : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    net,
    avgWin,
    avgLoss,
    profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity
  };
}
