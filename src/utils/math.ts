// src/utils/math.ts
import { Candle } from "./types";

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i <= period; i++) {
    const cur = candles[candles.length - 1 - (i - 1)];
    const prev = candles[candles.length - 1 - i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const sum = trs.reduce((s, v) => s + v, 0);
  return sum / trs.length;
}

export function highest(candles: Candle[], lookback: number) {
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map(c => c.high));
}

export function lowest(candles: Candle[], lookback: number) {
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map(c => c.low));
}
