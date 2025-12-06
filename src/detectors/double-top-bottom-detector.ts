/**
 * Double/Triple Top and Bottom Pattern Detector
 * 
 * Detects reversal patterns where price tests a level multiple times
 * and fails, indicating trend exhaustion and potential reversal.
 * 
 * DOUBLE TOP: Price makes two highs at similar level, fails to break higher
 * TRIPLE TOP: Price makes three highs at similar level (stronger signal)
 * DOUBLE BOTTOM: Price makes two lows at similar level, fails to break lower  
 * TRIPLE BOTTOM: Price makes three lows at similar level (stronger signal)
 */

import { Candle } from '../utils/types';

export interface PatternPeak {
  price: number;
  index: number;
  time: number;
}

export interface ReversalPattern {
  type: 'DOUBLE_TOP' | 'TRIPLE_TOP' | 'DOUBLE_BOTTOM' | 'TRIPLE_BOTTOM';
  side: 'BUY' | 'SELL';  // Trade direction after pattern confirms
  peaks: PatternPeak[];  // The tops or bottoms that form the pattern
  neckline: number;      // Support/resistance level to break for confirmation
  patternHigh: number;   // Highest point of pattern (for SL on sells)
  patternLow: number;    // Lowest point of pattern (for SL on buys)
  height: number;        // Pattern height (for TP projection)
  strength: number;      // 0-100 score based on symmetry and momentum
  confirmed: boolean;    // Has neckline been broken?
  entryPrice: number;    // Suggested entry (neckline or retest)
  sl: number;            // Suggested SL
  tp: number;            // Suggested TP (1:1 pattern height projection)
  age: number;           // Candles since pattern started forming
}

interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  index: number;
  time: number;
}

/**
 * Find swing highs and lows in price data
 */
function findSwingPoints(candles: Candle[], lookback: number = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  
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
      swings.push({
        type: 'high',
        price: candle.high,
        index: i,
        time: candle.time
      });
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
      swings.push({
        type: 'low',
        price: candle.low,
        index: i,
        time: candle.time
      });
    }
  }
  
  return swings;
}

/**
 * Check if two prices are at "similar" level (within tolerance)
 */
function pricesMatch(price1: number, price2: number, tolerance: number): boolean {
  return Math.abs(price1 - price2) <= tolerance;
}

/**
 * Calculate pattern strength based on:
 * - Peak divergence (second peak failing = stronger signal)
 * - Triple pattern bonus
 * - Volume/momentum decline (later peaks with less momentum = stronger)
 */
function calculateStrength(peaks: PatternPeak[], candles: Candle[], isTop: boolean): number {
  let strength = 50;  // Base strength
  
  if (peaks.length < 2) return 0;
  
  const firstPeak = peaks[0];
  const lastPeak = peaks[peaks.length - 1];
  
  // 1. Divergence bonus - if second peak shows weakness, it's STRONGER signal
  // For TOPS: second high slightly LOWER = bearish divergence = +15 points
  // For BOTTOMS: second low slightly HIGHER = bullish divergence = +15 points
  if (isTop) {
    // Double top: second peak lower than first = exhaustion
    if (lastPeak.price < firstPeak.price) {
      strength += 15;  // Bearish divergence bonus
    }
  } else {
    // Double bottom: second peak higher than first = support holding
    if (lastPeak.price > firstPeak.price) {
      strength += 15;  // Bullish divergence bonus
    }
  }
  
  // 2. Peaks at EXACT same level is also valid (classic pattern) - up to 10 points
  const priceRange = Math.max(...peaks.map(p => p.price)) - Math.min(...peaks.map(p => p.price));
  const avgPrice = peaks.reduce((sum, p) => sum + p.price, 0) / peaks.length;
  const deviationPct = (priceRange / avgPrice) * 100;
  
  if (deviationPct < 0.5) {
    strength += 10;  // Very tight = classic double top/bottom
  } else if (deviationPct < 1.0) {
    strength += 5;   // Reasonably close
  }
  
  // 3. Triple pattern bonus (+15 points)
  if (peaks.length >= 3) {
    strength += 15;
  }
  
  // 4. Momentum decline check - later peaks should have smaller candle bodies
  // This indicates exhaustion
  if (peaks.length >= 2) {
    const firstPeakCandle = candles[peaks[0].index];
    const lastPeakCandle = candles[peaks[peaks.length - 1].index];
    
    const firstBody = Math.abs(firstPeakCandle.close - firstPeakCandle.open);
    const lastBody = Math.abs(lastPeakCandle.close - lastPeakCandle.open);
    
    // If last peak has smaller body (less momentum), add strength
    if (lastBody < firstBody * 0.8) {
      strength += 10;
    }
  }
  
  return Math.min(100, Math.max(0, strength));
}

/**
 * Detect Double/Triple Top patterns
 */
function detectTops(
  candles: Candle[], 
  swingHighs: SwingPoint[], 
  tolerance: number,
  pipSize: number
): ReversalPattern | null {
  if (swingHighs.length < 2) return null;
  
  // Get recent swing highs (last 5)
  const recentHighs = swingHighs.slice(-5);
  
  // Find matching highs (at similar price levels)
  const matchingPeaks: PatternPeak[] = [];
  
  for (let i = 0; i < recentHighs.length; i++) {
    const currentHigh = recentHighs[i];
    
    // Check if this high matches any existing peak group
    let matchFound = false;
    for (const peak of matchingPeaks) {
      if (pricesMatch(currentHigh.price, peak.price, tolerance)) {
        // Update to use the higher of the two
        if (currentHigh.price > peak.price) {
          peak.price = currentHigh.price;
        }
        matchFound = true;
        break;
      }
    }
    
    if (!matchFound) {
      // Start new potential pattern
      matchingPeaks.length = 0;  // Reset
      matchingPeaks.push({
        price: currentHigh.price,
        index: currentHigh.index,
        time: currentHigh.time
      });
    } else {
      matchingPeaks.push({
        price: currentHigh.price,
        index: currentHigh.index,
        time: currentHigh.time
      });
    }
  }
  
  // Need at least 2 matching peaks for double top
  if (matchingPeaks.length < 2) return null;
  
  // Find neckline (lowest low between the peaks)
  const firstPeakIdx = matchingPeaks[0].index;
  const lastPeakIdx = matchingPeaks[matchingPeaks.length - 1].index;
  
  let neckline = Infinity;
  for (let i = firstPeakIdx; i <= lastPeakIdx; i++) {
    if (candles[i].low < neckline) {
      neckline = candles[i].low;
    }
  }
  
  const patternHigh = Math.max(...matchingPeaks.map(p => p.price));
  const patternLow = neckline;
  const height = patternHigh - patternLow;
  
  // Check if neckline has been broken (confirmation)
  const currentPrice = candles[candles.length - 1].close;
  const confirmed = currentPrice < neckline;
  
  // Calculate strength
  const strength = calculateStrength(matchingPeaks, candles, true);
  
  // Pattern must be reasonably strong
  if (strength < 40) return null;
  
  const patternType = matchingPeaks.length >= 3 ? 'TRIPLE_TOP' : 'DOUBLE_TOP';
  
  // Entry at neckline break or slight retest
  const entryBuffer = height * 0.1;  // 10% of pattern height
  const entryPrice = neckline - entryBuffer;
  
  // SL above pattern high + buffer
  const slBuffer = pipSize * 10;  // 10 pips buffer
  const sl = patternHigh + slBuffer;
  
  // TP = pattern height projection below neckline (1:1)
  const tp = neckline - height;
  
  return {
    type: patternType,
    side: 'SELL',
    peaks: matchingPeaks,
    neckline,
    patternHigh,
    patternLow,
    height,
    strength,
    confirmed,
    entryPrice,
    sl,
    tp,
    age: candles.length - firstPeakIdx
  };
}

/**
 * Detect Double/Triple Bottom patterns
 */
function detectBottoms(
  candles: Candle[], 
  swingLows: SwingPoint[], 
  tolerance: number,
  pipSize: number
): ReversalPattern | null {
  if (swingLows.length < 2) return null;
  
  // Get recent swing lows (last 5)
  const recentLows = swingLows.slice(-5);
  
  // Find matching lows (at similar price levels)
  const matchingPeaks: PatternPeak[] = [];
  
  for (let i = 0; i < recentLows.length; i++) {
    const currentLow = recentLows[i];
    
    // Check if this low matches any existing peak group
    let matchFound = false;
    for (const peak of matchingPeaks) {
      if (pricesMatch(currentLow.price, peak.price, tolerance)) {
        // Update to use the lower of the two
        if (currentLow.price < peak.price) {
          peak.price = currentLow.price;
        }
        matchFound = true;
        break;
      }
    }
    
    if (!matchFound) {
      matchingPeaks.length = 0;  // Reset
      matchingPeaks.push({
        price: currentLow.price,
        index: currentLow.index,
        time: currentLow.time
      });
    } else {
      matchingPeaks.push({
        price: currentLow.price,
        index: currentLow.index,
        time: currentLow.time
      });
    }
  }
  
  // Need at least 2 matching peaks for double bottom
  if (matchingPeaks.length < 2) return null;
  
  // Find neckline (highest high between the peaks)
  const firstPeakIdx = matchingPeaks[0].index;
  const lastPeakIdx = matchingPeaks[matchingPeaks.length - 1].index;
  
  let neckline = -Infinity;
  for (let i = firstPeakIdx; i <= lastPeakIdx; i++) {
    if (candles[i].high > neckline) {
      neckline = candles[i].high;
    }
  }
  
  const patternLow = Math.min(...matchingPeaks.map(p => p.price));
  const patternHigh = neckline;
  const height = patternHigh - patternLow;
  
  // Check if neckline has been broken (confirmation)
  const currentPrice = candles[candles.length - 1].close;
  const confirmed = currentPrice > neckline;
  
  // Calculate strength
  const strength = calculateStrength(matchingPeaks, candles, false);
  
  // Pattern must be reasonably strong
  if (strength < 40) return null;
  
  const patternType = matchingPeaks.length >= 3 ? 'TRIPLE_BOTTOM' : 'DOUBLE_BOTTOM';
  
  // Entry at neckline break or slight retest
  const entryBuffer = height * 0.1;
  const entryPrice = neckline + entryBuffer;
  
  // SL below pattern low + buffer
  const slBuffer = pipSize * 10;
  const sl = patternLow - slBuffer;
  
  // TP = pattern height projection above neckline (1:1)
  const tp = neckline + height;
  
  return {
    type: patternType,
    side: 'BUY',
    peaks: matchingPeaks,
    neckline,
    patternHigh,
    patternLow,
    height,
    strength,
    confirmed,
    entryPrice,
    sl,
    tp,
    age: candles.length - firstPeakIdx
  };
}

/**
 * Main detection function - finds Double/Triple Tops and Bottoms
 * 
 * @param candles - Price candles (need at least 30 for good detection)
 * @param symbol - Symbol name (for pip size calculation)
 * @returns Best reversal pattern found, or null
 */
export function detectReversalPattern(
  candles: Candle[],
  symbol: string
): ReversalPattern | null {
  if (candles.length < 30) return null;
  
  // Determine tolerance based on symbol
  const isXAU = symbol.includes('XAU');
  const isJPY = symbol.includes('JPY');
  
  // Tolerance for "similar level" - WIDER to catch unequal peaks
  // Double tops/bottoms often have peaks at slightly different levels
  // e.g., second top slightly lower (weakness) or second bottom slightly higher (support)
  const pipSize = isXAU ? 0.1 : isJPY ? 0.01 : 0.0001;
  const tolerance = isXAU ? 15.0 : isJPY ? 0.30 : 0.0030;  // ~30 pips tolerance - much wider!
  
  // Find swing points
  const swings = findSwingPoints(candles, 3);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');
  
  // Detect both patterns
  const topPattern = detectTops(candles, swingHighs, tolerance, pipSize);
  const bottomPattern = detectBottoms(candles, swingLows, tolerance, pipSize);
  
  // Return the stronger pattern, or the confirmed one
  if (topPattern && bottomPattern) {
    // Prefer confirmed patterns
    if (topPattern.confirmed && !bottomPattern.confirmed) return topPattern;
    if (bottomPattern.confirmed && !topPattern.confirmed) return bottomPattern;
    
    // Otherwise return stronger
    return topPattern.strength >= bottomPattern.strength ? topPattern : bottomPattern;
  }
  
  return topPattern || bottomPattern || null;
}

/**
 * Quick check if momentum is fading (good for reversal patterns)
 * Compares recent candle sizes to earlier ones
 */
export function isMomentumFading(candles: Candle[], lookback: number = 10): boolean {
  if (candles.length < lookback * 2) return false;
  
  // Compare average body size of recent vs earlier candles
  const recentCandles = candles.slice(-lookback);
  const earlierCandles = candles.slice(-lookback * 2, -lookback);
  
  const recentAvgBody = recentCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / lookback;
  const earlierAvgBody = earlierCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / lookback;
  
  // Momentum fading if recent bodies are 30%+ smaller
  return recentAvgBody < earlierAvgBody * 0.7;
}
