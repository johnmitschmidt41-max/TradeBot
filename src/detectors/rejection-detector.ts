// src/detectors/rejection-detector.ts
import { Candle } from "../utils/types";

export type Rejection = {
  side: 'BUY' | 'SELL';
  candleIndex: number;
  wickPercent: number;
  bodyPercent: number;
};

export function detectRejection(candles: Candle[], wickPercentThreshold = 0.6, bodyPercentThreshold = 0.3): Rejection[] {
  const rejections: Rejection[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    const upperWickPct = upperWick / range;
    const lowerWickPct = lowerWick / range;
    const bodyPct = body / range;

    if (upperWickPct >= wickPercentThreshold && bodyPct <= bodyPercentThreshold) {
      rejections.push({ side: 'SELL', candleIndex: i, wickPercent: upperWickPct, bodyPercent: bodyPct });
    } else if (lowerWickPct >= wickPercentThreshold && bodyPct <= bodyPercentThreshold) {
      rejections.push({ side: 'BUY', candleIndex: i, wickPercent: lowerWickPct, bodyPercent: bodyPct });
    }
  }
  return rejections;
}
