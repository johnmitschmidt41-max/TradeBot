// src/detectors/sweep-detector.ts
import { Candle } from "../utils/types";
import { priceToPip } from "../utils/pip";

export type Sweep = {
  side: 'BUY' | 'SELL';
  wickExtreme: number;
  wickLengthPips: number;
  index: number;
};

export function detectSweeps(candles: Candle[], thresholdPips = 10, symbol = 'GBPUSD'): Sweep[] {
  const sweeps: Sweep[] = [];

  // Stricter sweep detection:
  // - Require wick beyond recent structure low/high (last 20 candles)
  // - Require the candle to close back beyond the structure level by a small buffer
  // - Require displacement relative to average candle range to avoid tiny noisy wicks
  const windowSize = 20;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const start = Math.max(0, i - windowSize);
    const recent = candles.slice(start, i); // exclude current candle
    if (!recent || recent.length === 0) continue;

    const highs = recent.map(r => r.high);
    const lows = recent.map(r => r.low);
    const structureHigh = Math.max(...highs);
    const structureLow = Math.min(...lows);
    const avgRange = recent.map(r => r.high - r.low).reduce((a,b) => a + b, 0) / recent.length;

    const bodyTop = Math.max(c.open, c.close);
    const bodyBottom = Math.min(c.open, c.close);
    const upperWick = c.high - bodyTop;
    const lowerWick = bodyBottom - c.low;
    const upperPips = priceToPip(symbol, upperWick);
    const lowerPips = priceToPip(symbol, lowerWick);
    const pipSize = symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
    const bufferPips = 10; // require closing back beyond structure by at least 10 pips

    // Bullish sweep (BUY setup): wick below recent structure low, then close back above structure low + buffer
    if (lowerPips >= thresholdPips && c.low < structureLow) {
      const closedAboveStructure = c.close > (structureLow + (bufferPips * pipSize));
      const displacement = c.close - c.low;
      if (closedAboveStructure && displacement > avgRange * 1.5) {
        sweeps.push({ side: 'BUY', wickExtreme: c.low, wickLengthPips: lowerPips, index: i });
      }
    }

    // Bearish sweep (SELL setup): wick above recent structure high, then close back below structure high - buffer
    if (upperPips >= thresholdPips && c.high > structureHigh) {
      const closedBelowStructure = c.close < (structureHigh - (bufferPips * pipSize));
      const displacement = c.high - c.close;
      if (closedBelowStructure && displacement > avgRange * 1.5) {
        sweeps.push({ side: 'SELL', wickExtreme: c.high, wickLengthPips: upperPips, index: i });
      }
    }
  }

  return sweeps;
}