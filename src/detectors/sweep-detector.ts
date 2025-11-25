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
  
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const bodyTop = Math.max(c.open, c.close);
    const bodyBottom = Math.min(c.open, c.close);
    
    const upperWick = c.high - bodyTop;
    const lowerWick = bodyBottom - c.low;
    
    const upperPips = priceToPip(symbol, upperWick);
    const lowerPips = priceToPip(symbol, lowerWick);
    
    // ✅ CORRECTED LOGIC
    // Upper wick = rejection from above = BULLISH sweep (BUY setup)
    if (upperPips >= thresholdPips) {
      sweeps.push({ 
        side: 'BUY',  // ← FIXED: was SELL
        wickExtreme: c.high, 
        wickLengthPips: upperPips, 
        index: i 
      });
    }
    
    // Lower wick = rejection from below = BEARISH sweep (SELL setup)
    if (lowerPips >= thresholdPips) {
      sweeps.push({ 
        side: 'SELL',  // ← FIXED: was BUY
        wickExtreme: c.low, 
        wickLengthPips: lowerPips, 
        index: i 
      });
    }
  }
  
  return sweeps;
}