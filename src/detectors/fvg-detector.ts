// src/detectors/fvg-detector.ts
import { Candle } from "../utils/types";
import { priceToPip } from "../utils/pip";

export type FVG = {
  side: 'BULL' | 'BEAR';
  high: number;
  low: number;
  index: number;
};

export function detectFVG(candles: Candle[], minGapPips = 10, symbol = 'GBPUSD'): FVG[] {
  const fvgs: FVG[] = [];
  
  // ✅ CORRECT FVG LOGIC: 3-candle pattern
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];
    
    // Bullish FVG: gap between c1.high and c3.low
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const gapPips = priceToPip(symbol, gapSize);

      if (gapPips >= minGapPips) {
        // Require displacement in the middle candle (c2) — it should be a strong move
        const recent = candles.slice(Math.max(0, i - 20), i + 3);
        const avgRange = recent.map(r => r.high - r.low).reduce((a,b) => a + b, 0) / recent.length;
        const c2Range = c2.high - c2.low;
        if (c2Range < avgRange * 1.5) {
          // probably noise — skip
        } else {
          fvgs.push({
            side: 'BULL',
            low: c1.high,
            high: c3.low,
            index: i
          });
        }
      }
    }
    
    // Bearish FVG: gap between c1.low and c3.high
    if (c3.high < c1.low) {
      const gapSize = c1.low - c3.high;
      const gapPips = priceToPip(symbol, gapSize);

      if (gapPips >= minGapPips) {
        const recent = candles.slice(Math.max(0, i - 20), i + 3);
        const avgRange = recent.map(r => r.high - r.low).reduce((a,b) => a + b, 0) / recent.length;
        const c2Range = c2.high - c2.low;
        if (c2Range < avgRange * 1.5) {
          // skip noisy gaps
        } else {
          fvgs.push({
            side: 'BEAR',
            low: c3.high,
            high: c1.low,
            index: i
          });
        }
      }
    }
  }
  
  return fvgs;
}