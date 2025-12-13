/**
 * Order Block (OB) Detector
 * 
 * Order blocks represent the last opposing candle before a strong impulsive move.
 * They indicate institutional order flow and often act as strong S/R zones.
 * 
 * BULLISH OB: Last red (bearish) candle before a big bullish explosion
 *   - Institutions were accumulating during that bearish candle
 *   - Price often returns to retest this zone before continuing up
 * 
 * BEARISH OB: Last green (bullish) candle before a big bearish dump
 *   - Institutions were distributing during that bullish candle
 *   - Price often returns to retest this zone before continuing down
 * 
 * Usage: When a sweep is detected but no FVG forms, look for an OB as alternative entry.
 */

import { Candle } from '../utils/types';
import { priceToPip } from '../utils/pip';

export interface OrderBlock {
  side: 'BULL' | 'BEAR';      // Bullish OB = buy setup, Bearish OB = sell setup
  high: number;                // Top of OB zone (candle high)
  low: number;                 // Bottom of OB zone (candle low)
  bodyHigh: number;            // Top of candle body (better entry)
  bodyLow: number;             // Bottom of candle body (better entry)
  index: number;               // Candle index where OB formed
  strength: number;            // 0-100 based on impulse strength
  impulsePips: number;         // Size of the impulse move after OB
}

/**
 * Detect Order Blocks in price data
 * 
 * @param candles - Array of candles (M5 timeframe)
 * @param symbol - Symbol for pip calculation
 * @param minImpulsePips - Minimum impulse size to qualify as OB (default 15 pips for FX)
 * @param lookback - How many candles back to search (default 30)
 */
export function detectOrderBlock(
  candles: Candle[],
  symbol: string = 'GBPUSD',
  minImpulsePips: number = 15,
  lookback: number = 30
): OrderBlock | null {
  if (candles.length < 5) return null;
  
  const isXAU = symbol.toUpperCase().includes('XAU');
  const isJPY = symbol.toUpperCase().includes('JPY');
  
  // Adjust impulse requirement for different instruments
  const requiredImpulse = isXAU ? 30 : isJPY ? 15 : minImpulsePips;
  
  // Calculate average candle range for context
  const recentCandles = candles.slice(-lookback);
  const avgRange = recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length;
  
  // We need an impulse candle that's significantly larger than average (2x+)
  const minImpulseRange = avgRange * 2.0;
  
  // Search for order blocks in recent candles
  const searchStart = Math.max(0, candles.length - lookback);
  
  // Track best OB found (most recent and strongest)
  let bestOB: OrderBlock | null = null;
  
  for (let i = searchStart; i < candles.length - 2; i++) {
    const potentialOB = candles[i];
    const impulseCandle = candles[i + 1];
    const confirmCandle = candles[i + 2];
    
    // Determine if potential OB is bullish or bearish candle
    const obIsBullish = potentialOB.close > potentialOB.open;
    const obIsBearish = potentialOB.close < potentialOB.open;
    
    // Impulse candle should be opposite direction and strong
    const impulseIsBullish = impulseCandle.close > impulseCandle.open;
    const impulseIsBearish = impulseCandle.close < impulseCandle.open;
    const impulseRange = impulseCandle.high - impulseCandle.low;
    
    // BULLISH OB: Bearish candle followed by bullish impulse
    if (obIsBearish && impulseIsBullish && impulseRange >= minImpulseRange) {
      const impulsePips = priceToPip(symbol, impulseCandle.close - impulseCandle.open);
      
      if (impulsePips >= requiredImpulse) {
        // Confirm the impulse continued (not just a wick)
        const continuedUp = confirmCandle.close > impulseCandle.close * 0.998; // Within 0.2%
        
        if (continuedUp || confirmCandle.close > impulseCandle.open) {
          const strength = calculateOBStrength(potentialOB, impulseCandle, confirmCandle, avgRange, true);
          
          if (strength >= 50 && (!bestOB || i > bestOB.index)) {
            bestOB = {
              side: 'BULL',
              high: potentialOB.high,
              low: potentialOB.low,
              bodyHigh: Math.max(potentialOB.open, potentialOB.close),
              bodyLow: Math.min(potentialOB.open, potentialOB.close),
              index: i,
              strength,
              impulsePips
            };
          }
        }
      }
    }
    
    // BEARISH OB: Bullish candle followed by bearish impulse
    if (obIsBullish && impulseIsBearish && impulseRange >= minImpulseRange) {
      const impulsePips = priceToPip(symbol, impulseCandle.open - impulseCandle.close);
      
      if (impulsePips >= requiredImpulse) {
        // Confirm the impulse continued (not just a wick)
        const continuedDown = confirmCandle.close < impulseCandle.close * 1.002; // Within 0.2%
        
        if (continuedDown || confirmCandle.close < impulseCandle.open) {
          const strength = calculateOBStrength(potentialOB, impulseCandle, confirmCandle, avgRange, false);
          
          if (strength >= 50 && (!bestOB || i > bestOB.index)) {
            bestOB = {
              side: 'BEAR',
              high: potentialOB.high,
              low: potentialOB.low,
              bodyHigh: Math.max(potentialOB.open, potentialOB.close),
              bodyLow: Math.min(potentialOB.open, potentialOB.close),
              index: i,
              strength,
              impulsePips
            };
          }
        }
      }
    }
  }
  
  return bestOB;
}

/**
 * Calculate OB strength based on impulse characteristics
 */
function calculateOBStrength(
  obCandle: Candle,
  impulseCandle: Candle,
  confirmCandle: Candle,
  avgRange: number,
  isBullish: boolean
): number {
  let strength = 50; // Base
  
  const impulseRange = impulseCandle.high - impulseCandle.low;
  const impulseBody = Math.abs(impulseCandle.close - impulseCandle.open);
  const bodyRatio = impulseBody / impulseRange;
  
  // 1. Impulse body ratio - full body candles are stronger (+15)
  if (bodyRatio > 0.7) {
    strength += 15;
  } else if (bodyRatio > 0.5) {
    strength += 10;
  }
  
  // 2. Impulse size vs average (+15 for 3x+ avg range)
  if (impulseRange > avgRange * 3) {
    strength += 15;
  } else if (impulseRange > avgRange * 2.5) {
    strength += 10;
  }
  
  // 3. Continuation confirmation (+10)
  if (isBullish) {
    if (confirmCandle.close > impulseCandle.high) {
      strength += 10; // Closed above impulse high = strong continuation
    } else if (confirmCandle.close > impulseCandle.close) {
      strength += 5;
    }
  } else {
    if (confirmCandle.close < impulseCandle.low) {
      strength += 10; // Closed below impulse low = strong continuation
    } else if (confirmCandle.close < impulseCandle.close) {
      strength += 5;
    }
  }
  
  // 4. OB candle size - smaller OB = tighter zone = better (+10)
  const obRange = obCandle.high - obCandle.low;
  if (obRange < avgRange * 0.8) {
    strength += 10;
  } else if (obRange < avgRange) {
    strength += 5;
  }
  
  return Math.min(100, Math.max(0, strength));
}

/**
 * Detect ALL Order Blocks in price data (returns multiple)
 * 
 * @param candles - Array of candles (M5 timeframe)
 * @param symbol - Symbol for pip calculation
 * @param minImpulsePips - Minimum impulse size to qualify as OB
 * @param lookback - How many candles back to search
 */
export function detectOrderBlocks(
  candles: Candle[],
  symbol: string = 'GBPUSD',
  minImpulsePips: number = 15,
  lookback: number = 30
): OrderBlock[] {
  if (candles.length < 5) return [];
  
  const isXAU = symbol.toUpperCase().includes('XAU');
  const isJPY = symbol.toUpperCase().includes('JPY');
  
  // Adjust impulse requirement for different instruments
  const requiredImpulse = isXAU ? 30 : isJPY ? 15 : minImpulsePips;
  
  // Calculate average candle range for context
  const recentCandles = candles.slice(-lookback);
  const avgRange = recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length;
  
  // We need an impulse candle that's significantly larger than average (2x+)
  const minImpulseRange = avgRange * 2.0;
  
  // Search for order blocks in recent candles
  const searchStart = Math.max(0, candles.length - lookback);
  
  const orderBlocks: OrderBlock[] = [];
  
  for (let i = searchStart; i < candles.length - 2; i++) {
    const potentialOB = candles[i];
    const impulseCandle = candles[i + 1];
    const confirmCandle = candles[i + 2];
    
    // Determine if potential OB is bullish or bearish candle
    const obIsBullish = potentialOB.close > potentialOB.open;
    const obIsBearish = potentialOB.close < potentialOB.open;
    
    // Impulse candle should be opposite direction and strong
    const impulseIsBullish = impulseCandle.close > impulseCandle.open;
    const impulseIsBearish = impulseCandle.close < impulseCandle.open;
    const impulseRange = impulseCandle.high - impulseCandle.low;
    
    // BULLISH OB: Bearish candle followed by bullish impulse
    if (obIsBearish && impulseIsBullish && impulseRange >= minImpulseRange) {
      const impulsePips = priceToPip(symbol, impulseCandle.close - impulseCandle.open);
      
      if (impulsePips >= requiredImpulse) {
        const continuedUp = confirmCandle.close > impulseCandle.close * 0.998;
        
        if (continuedUp || confirmCandle.close > impulseCandle.open) {
          const strength = calculateOBStrength(potentialOB, impulseCandle, confirmCandle, avgRange, true);
          
          if (strength >= 50) {
            orderBlocks.push({
              side: 'BULL',
              high: potentialOB.high,
              low: potentialOB.low,
              bodyHigh: Math.max(potentialOB.open, potentialOB.close),
              bodyLow: Math.min(potentialOB.open, potentialOB.close),
              index: i,
              strength,
              impulsePips
            });
          }
        }
      }
    }
    
    // BEARISH OB: Bullish candle followed by bearish impulse
    if (obIsBullish && impulseIsBearish && impulseRange >= minImpulseRange) {
      const impulsePips = priceToPip(symbol, impulseCandle.open - impulseCandle.close);
      
      if (impulsePips >= requiredImpulse) {
        const continuedDown = confirmCandle.close < impulseCandle.close * 1.002;
        
        if (continuedDown || confirmCandle.close < impulseCandle.open) {
          const strength = calculateOBStrength(potentialOB, impulseCandle, confirmCandle, avgRange, false);
          
          if (strength >= 50) {
            orderBlocks.push({
              side: 'BEAR',
              high: potentialOB.high,
              low: potentialOB.low,
              bodyHigh: Math.max(potentialOB.open, potentialOB.close),
              bodyLow: Math.min(potentialOB.open, potentialOB.close),
              index: i,
              strength,
              impulsePips
            });
          }
        }
      }
    }
  }
  
  return orderBlocks;
}

/**
 * Check if current price is retesting an Order Block zone
 * 
 * @param ob - The order block to check
 * @param currentPrice - Current market price
 * @param candle - Current candle for wick analysis
 * @returns true if price is in the OB zone
 */
export function isPriceInOBZone(ob: OrderBlock, currentPrice: number, candle?: Candle): boolean {
  // For entries, we use the body zone (tighter, better R:R)
  // But check wicks for confirmation
  
  if (ob.side === 'BULL') {
    // Bullish OB - look for price to dip INTO the zone
    const inBodyZone = currentPrice >= ob.bodyLow && currentPrice <= ob.bodyHigh;
    const inWickZone = currentPrice >= ob.low && currentPrice <= ob.high;
    
    // Prefer body zone but accept wick zone with candle rejection
    if (inBodyZone) return true;
    if (inWickZone && candle) {
      // Check if candle shows rejection (wick into zone but close above)
      const bodyLow = Math.min(candle.open, candle.close);
      return bodyLow > ob.bodyLow; // Body stayed above OB body
    }
  } else {
    // Bearish OB - look for price to rally INTO the zone
    const inBodyZone = currentPrice >= ob.bodyLow && currentPrice <= ob.bodyHigh;
    const inWickZone = currentPrice >= ob.low && currentPrice <= ob.high;
    
    if (inBodyZone) return true;
    if (inWickZone && candle) {
      const bodyHigh = Math.max(candle.open, candle.close);
      return bodyHigh < ob.bodyHigh; // Body stayed below OB body
    }
  }
  
  return false;
}

/**
 * Find the most relevant OB for a given trade direction
 * Searches for OB that hasn't been "used" (price already retested and bounced)
 */
export function findRelevantOB(
  candles: Candle[],
  side: 'BUY' | 'SELL',
  symbol: string = 'GBPUSD'
): OrderBlock | null {
  const ob = detectOrderBlock(candles, symbol);
  
  if (!ob) return null;
  
  // For BUY setup, we need a BULLISH OB (support zone)
  // For SELL setup, we need a BEARISH OB (resistance zone)
  if (side === 'BUY' && ob.side !== 'BULL') return null;
  if (side === 'SELL' && ob.side !== 'BEAR') return null;
  
  // Check if OB has already been tested and failed
  // Look at candles after the OB formed
  const candlesAfterOB = candles.slice(ob.index + 3);
  let retestCount = 0;
  
  for (const candle of candlesAfterOB) {
    const testedZone = 
      (ob.side === 'BULL' && candle.low <= ob.bodyHigh && candle.low >= ob.low) ||
      (ob.side === 'BEAR' && candle.high >= ob.bodyLow && candle.high <= ob.high);
    
    if (testedZone) {
      retestCount++;
    }
  }
  
  // If OB has been tested 2+ times already, it may be "used up"
  if (retestCount >= 2) {
    return null;
  }
  
  return ob;
}
