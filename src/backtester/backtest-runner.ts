// src/backtester/backtest-runner.ts
import { Candle } from "../utils/types";
import { detectFVG } from "../detectors/fvg-detector";
import { pipToPrice } from "../utils/pip";
import { detectSweeps } from "../detectors/sweep-detector";
import { detectRejection } from "../detectors/rejection-detector";

/**
 * Minimal backtester: feeds candles through same detectors and simulates limit entry at mid-FVG.
 * This is intentionally simple — use for sanity checks and quick metrics only.
 */

export type Trade = {
  entryTime: number;
  exitTime?: number;
  entryPrice: number;
  exitPrice?: number;
  side: "BUY" | "SELL";
  profit?: number;
};

export function simpleBacktest(candles: Candle[], slPips = 20, rr = 2) {
  const trades: Trade[] = [];
  const fvgs = detectFVG(candles);
  const sweeps = detectSweeps(candles);
  const rejections = detectRejection(candles);

  // naive: for each sweep find matching FVG after it, simulate entry
  for (const s of sweeps) {
    const bias = s.side === "BUY" ? "BULL" : "BEAR";
    const f = fvgs.find(f => (bias === "BULL" ? f.side === "BULL" : f.side === "BEAR") && f.index > s.index);
    if (!f) continue;
    const entry = (f.high + f.low) / 2;
    const sl = s.side === "BUY" ? entry - pipToPrice((s as any).symbol ?? '', slPips) : entry + pipToPrice((s as any).symbol ?? '', slPips);
    const tp = s.side === "BUY" ? entry + (entry - sl) * rr : entry - (sl - entry) * rr;

    // simulate until hit TP/SL by scanning subsequent candles
    let result: Trade | null = {
      entryTime: candles[s.index].time,
      entryPrice: entry,
      side: s.side
    };
    for (let i = f.index; i < candles.length; i++) {
      const c = candles[i];
      if (s.side === "BUY") {
        if (c.low <= sl) { result.exitPrice = sl; result.exitTime = c.time; break; }
        if (c.high >= tp) { result.exitPrice = tp; result.exitTime = c.time; break; }
      } else {
        if (c.high >= sl) { result.exitPrice = sl; result.exitTime = c.time; break; }
        if (c.low <= tp) { result.exitPrice = tp; result.exitTime = c.time; break; }
      }
    }
    if (result.exitPrice) {
      result.profit = (result.side === "BUY" ? result.exitPrice - result.entryPrice : result.entryPrice - result.exitPrice);
      trades.push(result);
    }
  }

  return trades;
}
