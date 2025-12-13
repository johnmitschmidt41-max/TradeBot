/**
 * Breaker Block Detector
 * 
 * Breaker blocks are failed support/resistance levels that flip roles:
 * - Old support breaks down → becomes resistance on retest
 * - Old resistance breaks up → becomes support on retest
 * 
 * This is different from sweeps:
 * - Sweep = fake break (wick through, but closes back inside) → fade the move
 * - Breaker = real break (closes through with conviction) → trade with the break
 * 
 * Flow:
 * 1. Track significant S/R levels (swing highs/lows)
 * 2. Detect when a level BREAKS (candle closes beyond, not just wick)
 * 3. Store the broken level as a "breaker zone"
 * 4. Wait for price to return and retest the zone
 * 5. Enter on rejection from the retest (old support = new resistance, vice versa)
 */

import { Candle } from '../utils/types';
import { priceToPip } from '../utils/pip';

export interface BreakerZone {
  level: number;              // The S/R level that was broken
  zoneHigh: number;           // Top of the zone (for entries)
  zoneLow: number;            // Bottom of the zone (for entries)
  side: 'BULL' | 'BEAR';      // BULL = broken resistance (now support), BEAR = broken support (now resistance)
  tradeSide: 'BUY' | 'SELL';  // Trade direction on retest
  breakTime: number;          // When the break occurred
  breakIndex: number;         // Candle index of the break
  strength: number;           // 0-100 based on break quality
  breakPips: number;          // How far price broke through
  tested: boolean;            // Has the zone been retested?
  testCount: number;          // Number of times retested
}

export interface BreakerEntry {
  zone: BreakerZone;
  entryPrice: number;
  sl: number;
  tp: number;
  rr: number;
}

/**
 * Find swing highs and lows for S/R level detection
 */
function findSwingLevels(candles: Candle[], lookback: number = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    
    // Check for swing high
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= candle.high || candles[i + j].high >= candle.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      highs.push(candle.high);
    }
    
    // Check for swing low
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= candle.low || candles[i + j].low <= candle.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      lows.push(candle.low);
    }
  }
  
  return { highs, lows };
}

/**
 * Detect breaker blocks - levels that were broken and can now be retested
 * 
 * @param candles - Price data (M5)
 * @param symbol - Symbol for pip calculations
 * @param existingBreakers - Previously detected breakers to update
 * @param minBreakPips - Minimum pips to consider a valid break
 */
export function detectBreakerBlocks(
  candles: Candle[],
  symbol: string = 'GBPUSD',
  existingBreakers: BreakerZone[] = [],
  minBreakPips: number = 10
): BreakerZone[] {
  if (candles.length < 20) return existingBreakers;
  
  const isXAU = symbol.toUpperCase().includes('XAU');
  const isJPY = symbol.toUpperCase().includes('JPY');
  const pipSize = isXAU ? 0.1 : isJPY ? 0.01 : 0.0001;
  
  // Adjust break requirement for different instruments
  const requiredBreakPips = isXAU ? 20 : isJPY ? 10 : minBreakPips;
  
  // Find recent swing levels
  const { highs, lows } = findSwingLevels(candles.slice(0, -5), 5);
  
  // Look at recent candles for breaks
  const recentCandles = candles.slice(-10);
  const newBreakers: BreakerZone[] = [...existingBreakers];
  
  // Check each candle for level breaks
  for (let i = 0; i < recentCandles.length; i++) {
    const candle = recentCandles[i];
    const candleIndex = candles.length - 10 + i;
    
    // Check if this candle broke any resistance level (closed above)
    for (const resistanceLevel of highs) {
      // Skip if we already have a breaker for this level
      const existingBreaker = newBreakers.find(b => 
        Math.abs(b.level - resistanceLevel) < pipSize * 20
      );
      if (existingBreaker) continue;
      
      // Check for break: candle closes ABOVE the resistance
      if (candle.close > resistanceLevel) {
        const breakDistance = candle.close - resistanceLevel;
        const breakPips = priceToPip(symbol, breakDistance);
        
        if (breakPips >= requiredBreakPips) {
          // Valid break - resistance becomes support
          const strength = calculateBreakStrength(candle, resistanceLevel, true, candles, candleIndex);
          
          if (strength >= 50) {
            newBreakers.push({
              level: resistanceLevel,
              zoneHigh: resistanceLevel + (pipSize * 5),  // 5 pips buffer
              zoneLow: resistanceLevel - (pipSize * 5),
              side: 'BULL',       // Broken resistance = bullish
              tradeSide: 'BUY',   // Trade = buy on retest
              breakTime: candle.time,
              breakIndex: candleIndex,
              strength,
              breakPips,
              tested: false,
              testCount: 0
            });
          }
        }
      }
    }
    
    // Check if this candle broke any support level (closed below)
    for (const supportLevel of lows) {
      // Skip if we already have a breaker for this level
      const existingBreaker = newBreakers.find(b => 
        Math.abs(b.level - supportLevel) < pipSize * 20
      );
      if (existingBreaker) continue;
      
      // Check for break: candle closes BELOW the support
      if (candle.close < supportLevel) {
        const breakDistance = supportLevel - candle.close;
        const breakPips = priceToPip(symbol, breakDistance);
        
        if (breakPips >= requiredBreakPips) {
          // Valid break - support becomes resistance
          const strength = calculateBreakStrength(candle, supportLevel, false, candles, candleIndex);
          
          if (strength >= 50) {
            newBreakers.push({
              level: supportLevel,
              zoneHigh: supportLevel + (pipSize * 5),
              zoneLow: supportLevel - (pipSize * 5),
              side: 'BEAR',        // Broken support = bearish
              tradeSide: 'SELL',   // Trade = sell on retest
              breakTime: candle.time,
              breakIndex: candleIndex,
              strength,
              breakPips,
              tested: false,
              testCount: 0
            });
          }
        }
      }
    }
  }
  
  // Clean up old breakers (older than 4 hours = 48 M5 candles)
  const maxAge = 48;
  const currentIndex = candles.length - 1;
  
  return newBreakers.filter(b => {
    const age = currentIndex - b.breakIndex;
    // Keep if: less than 4 hours old, OR has been tested less than 2 times
    return age < maxAge || b.testCount < 2;
  });
}

/**
 * Calculate break strength
 */
function calculateBreakStrength(
  breakCandle: Candle,
  level: number,
  isBullishBreak: boolean,
  candles: Candle[],
  breakIndex: number
): number {
  let strength = 50;
  
  const candleBody = Math.abs(breakCandle.close - breakCandle.open);
  const candleRange = breakCandle.high - breakCandle.low;
  const bodyRatio = candleBody / candleRange;
  
  // 1. Strong body candle (+15)
  if (bodyRatio > 0.7) {
    strength += 15;
  } else if (bodyRatio > 0.5) {
    strength += 10;
  }
  
  // 2. Candle direction matches break (+10)
  const isBullishCandle = breakCandle.close > breakCandle.open;
  if ((isBullishBreak && isBullishCandle) || (!isBullishBreak && !isBullishCandle)) {
    strength += 10;
  }
  
  // 3. Check for continuation after break (+15)
  if (breakIndex < candles.length - 1) {
    const nextCandle = candles[breakIndex + 1];
    if (isBullishBreak && nextCandle.close > breakCandle.close) {
      strength += 15;
    } else if (!isBullishBreak && nextCandle.close < breakCandle.close) {
      strength += 15;
    }
  }
  
  // 4. Level was tested multiple times before breaking (+10)
  const priorCandles = candles.slice(Math.max(0, breakIndex - 20), breakIndex);
  let touchCount = 0;
  for (const c of priorCandles) {
    const tolerance = candleRange * 0.5;
    if (isBullishBreak) {
      // Resistance - count touches from below
      if (c.high >= level - tolerance && c.high <= level + tolerance) {
        touchCount++;
      }
    } else {
      // Support - count touches from above
      if (c.low >= level - tolerance && c.low <= level + tolerance) {
        touchCount++;
      }
    }
  }
  
  if (touchCount >= 2) {
    strength += 10;
  }
  
  return Math.min(100, Math.max(0, strength));
}

/**
 * Check if price is retesting a breaker zone and get entry setup
 */
export function checkBreakerRetest(
  zone: BreakerZone,
  candles: Candle[],
  currentPrice: number,
  symbol: string = 'GBPUSD'
): BreakerEntry | null {
  const isXAU = symbol.toUpperCase().includes('XAU');
  const isJPY = symbol.toUpperCase().includes('JPY');
  const pipSize = isXAU ? 0.1 : isJPY ? 0.01 : 0.0001;
  
  const currentCandle = candles[candles.length - 1];
  
  // Check if price is in the zone
  const inZone = currentPrice >= zone.zoneLow && currentPrice <= zone.zoneHigh;
  if (!inZone) return null;
  
  // Check for rejection from the zone
  let hasRejection = false;
  
  if (zone.tradeSide === 'BUY') {
    // Bullish breaker - old resistance now support
    // Need to see price dip into zone and bounce (bullish candle with wick below)
    const bodyLow = Math.min(currentCandle.open, currentCandle.close);
    const lowerWick = bodyLow - currentCandle.low;
    const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
    
    // Bullish rejection: lower wick into zone, body above zone, closes bullish
    hasRejection = 
      currentCandle.low <= zone.zoneHigh &&
      bodyLow >= zone.zoneLow &&
      currentCandle.close > currentCandle.open &&
      lowerWick > upperWick;
      
  } else {
    // Bearish breaker - old support now resistance
    // Need to see price rally into zone and reject (bearish candle with wick above)
    const bodyHigh = Math.max(currentCandle.open, currentCandle.close);
    const upperWick = currentCandle.high - bodyHigh;
    const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    
    // Bearish rejection: upper wick into zone, body below zone, closes bearish
    hasRejection = 
      currentCandle.high >= zone.zoneLow &&
      bodyHigh <= zone.zoneHigh &&
      currentCandle.close < currentCandle.open &&
      upperWick > lowerWick;
  }
  
  if (!hasRejection) return null;
  
  // Calculate entry, SL, TP
  let entry: number, sl: number, tp: number;
  
  if (zone.tradeSide === 'BUY') {
    entry = currentCandle.close;
    // SL below the zone + buffer
    sl = zone.zoneLow - (pipSize * 10);
    // TP at 2:1 R:R minimum
    const slDistance = entry - sl;
    tp = entry + (slDistance * 2);
  } else {
    entry = currentCandle.close;
    // SL above the zone + buffer
    sl = zone.zoneHigh + (pipSize * 10);
    // TP at 2:1 R:R minimum
    const slDistance = sl - entry;
    tp = entry - (slDistance * 2);
  }
  
  const slDistance = Math.abs(entry - sl);
  const tpDistance = Math.abs(tp - entry);
  const rr = tpDistance / slDistance;
  
  return {
    zone,
    entryPrice: entry,
    sl,
    tp,
    rr
  };
}

/**
 * Update breaker zones based on price action
 * Call this on each candle to track retests
 */
export function updateBreakerZones(
  zones: BreakerZone[],
  currentPrice: number,
  candles: Candle[]
): BreakerZone[] {
  return zones.map(zone => {
    const inZone = currentPrice >= zone.zoneLow && currentPrice <= zone.zoneHigh;
    
    if (inZone && !zone.tested) {
      return {
        ...zone,
        tested: true,
        testCount: zone.testCount + 1
      };
    }
    
    // Reset tested flag when price leaves zone
    if (!inZone && zone.tested) {
      return {
        ...zone,
        tested: false
      };
    }
    
    return zone;
  });
}

/**
 * Convert a failed sweep into a breaker zone
 * Called when a sweep setup is invalidated by price closing through the level
 */
export function sweepToBreaker(
  sweepLevel: number,
  originalSide: 'BUY' | 'SELL',
  candles: Candle[],
  symbol: string = 'GBPUSD'
): BreakerZone | null {
  const isXAU = symbol.toUpperCase().includes('XAU');
  const isJPY = symbol.toUpperCase().includes('JPY');
  const pipSize = isXAU ? 0.1 : isJPY ? 0.01 : 0.0001;
  
  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;
  
  // Original sweep was BUY (swept low) - now price broke BELOW = bearish breaker
  // Original sweep was SELL (swept high) - now price broke ABOVE = bullish breaker
  
  if (originalSide === 'BUY') {
    // Was a buy setup (swept low), now price closed below = support broken
    if (currentPrice < sweepLevel) {
      const breakPips = priceToPip(symbol, sweepLevel - currentPrice);
      
      if (breakPips >= 10) {  // Minimum break distance
        return {
          level: sweepLevel,
          zoneHigh: sweepLevel + (pipSize * 5),
          zoneLow: sweepLevel - (pipSize * 5),
          side: 'BEAR',
          tradeSide: 'SELL',
          breakTime: currentCandle.time,
          breakIndex: candles.length - 1,
          strength: 60,  // Default strength for converted sweeps
          breakPips,
          tested: false,
          testCount: 0
        };
      }
    }
  } else {
    // Was a sell setup (swept high), now price closed above = resistance broken
    if (currentPrice > sweepLevel) {
      const breakPips = priceToPip(symbol, currentPrice - sweepLevel);
      
      if (breakPips >= 10) {
        return {
          level: sweepLevel,
          zoneHigh: sweepLevel + (pipSize * 5),
          zoneLow: sweepLevel - (pipSize * 5),
          side: 'BULL',
          tradeSide: 'BUY',
          breakTime: currentCandle.time,
          breakIndex: candles.length - 1,
          strength: 60,
          breakPips,
          tested: false,
          testCount: 0
        };
      }
    }
  }
  
  return null;
}
