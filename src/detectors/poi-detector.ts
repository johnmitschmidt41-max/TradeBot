// src/detectors/poi-detector.ts
// Point of Interest (POI) / Order Block Detector
// POIs are consolidation zones before strong moves - better for trend continuation

import { Candle } from "../utils/types";

export type POI = {
  top: number;
  bottom: number;
  side: 'BULL' | 'BEAR';  // BULL = demand zone (buy), BEAR = supply zone (sell)
  strength: number;       // How strong the impulse move was
  age: number;            // Candles since POI formed
  midpoint: number;
};

/**
 * Detect Order Block / POI zones
 * An Order Block is: consolidation (small range candles) → impulse move
 * The consolidation zone becomes support/resistance for retest
 */
export function detectPOI(candles: Candle[], lookback = 50): POI[] {
  const pois: POI[] = [];
  
  if (candles.length < 10) return pois;
  
  const startIdx = Math.max(0, candles.length - lookback);
  
  // Calculate average range for comparison
  let avgRange = 0;
  for (let i = startIdx; i < candles.length; i++) {
    avgRange += candles[i].high - candles[i].low;
  }
  avgRange /= (candles.length - startIdx);
  
  // Look for consolidation zones followed by impulse
  for (let i = startIdx + 2; i < candles.length - 3; i++) {
    // Check if this is a consolidation zone (2-4 small candles)
    const zone = findConsolidationZone(candles, i, avgRange);
    if (!zone) continue;
    
    // Check for impulse after consolidation
    const impulse = findImpulse(candles, zone.endIdx + 1, zone, avgRange);
    if (!impulse) continue;
    
    // Found a valid POI!
    pois.push({
      top: zone.high,
      bottom: zone.low,
      side: impulse.direction === 'UP' ? 'BULL' : 'BEAR',
      strength: impulse.strength,
      age: candles.length - 1 - zone.endIdx,
      midpoint: (zone.high + zone.low) / 2
    });
  }
  
  // Return recent POIs, deduplicated by proximity
  return deduplicatePOIs(pois, avgRange).slice(-5);
}

function findConsolidationZone(
  candles: Candle[], 
  startIdx: number, 
  avgRange: number
): { high: number; low: number; endIdx: number } | null {
  const minBars = 2;
  const maxBars = 4;
  
  let high = candles[startIdx].high;
  let low = candles[startIdx].low;
  let endIdx = startIdx;
  
  // Consolidation = tight range candles
  for (let i = startIdx; i < Math.min(startIdx + maxBars, candles.length - 1); i++) {
    const c = candles[i];
    const range = c.high - c.low;
    
    // Small candle (less than 1.2x average)
    if (range > avgRange * 1.2) {
      if (i - startIdx < minBars) return null;
      break;
    }
    
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    endIdx = i;
  }
  
  if (endIdx - startIdx + 1 < minBars) return null;
  
  // Zone shouldn't be too wide
  if (high - low > avgRange * 2.5) return null;
  
  return { high, low, endIdx };
}

function findImpulse(
  candles: Candle[],
  startIdx: number,
  zone: { high: number; low: number },
  avgRange: number
): { direction: 'UP' | 'DOWN'; strength: number } | null {
  if (startIdx >= candles.length) return null;
  
  // Look at next 1-3 candles for impulse
  let maxUp = 0;
  let maxDown = 0;
  
  for (let i = startIdx; i < Math.min(startIdx + 3, candles.length); i++) {
    const c = candles[i];
    const range = c.high - c.low;
    
    // Need a big candle (impulse)
    if (range < avgRange * 0.8) continue;
    
    // How far past the zone did it go?
    maxUp = Math.max(maxUp, c.close - zone.high);
    maxDown = Math.max(maxDown, zone.low - c.close);
  }
  
  const zoneSize = zone.high - zone.low || avgRange;
  const upStrength = maxUp / zoneSize;
  const downStrength = maxDown / zoneSize;
  
  // Need at least 1.5x zone size move
  if (upStrength >= 1.5 && upStrength > downStrength) {
    return { direction: 'UP', strength: upStrength };
  }
  if (downStrength >= 1.5 && downStrength > upStrength) {
    return { direction: 'DOWN', strength: downStrength };
  }
  
  return null;
}

function deduplicatePOIs(pois: POI[], avgRange: number): POI[] {
  const result: POI[] = [];
  
  for (const poi of pois) {
    // Check if too close to existing POI
    const tooClose = result.some(existing => 
      Math.abs(existing.midpoint - poi.midpoint) < avgRange
    );
    
    if (!tooClose) {
      result.push(poi);
    } else {
      // Keep the stronger one
      const idx = result.findIndex(existing => 
        Math.abs(existing.midpoint - poi.midpoint) < avgRange
      );
      if (idx >= 0 && poi.strength > result[idx].strength) {
        result[idx] = poi;
      }
    }
  }
  
  return result;
}

/**
 * Find the best POI for trend continuation entry
 */
export function findBestPOI(
  pois: POI[], 
  currentPrice: number, 
  trendDirection: 'UP' | 'DOWN'
): POI | null {
  if (pois.length === 0) return null;
  
  // Filter by trend direction
  const valid = pois.filter(poi => {
    if (trendDirection === 'UP') {
      // Uptrend: want BULL POI below current price (demand zone to buy from)
      return poi.side === 'BULL' && poi.top < currentPrice;
    } else {
      // Downtrend: want BEAR POI above current price (supply zone to sell from)
      return poi.side === 'BEAR' && poi.bottom > currentPrice;
    }
  });
  
  if (valid.length === 0) return null;
  
  // Return closest to current price
  return valid.reduce((best, poi) => {
    const bestDist = trendDirection === 'UP' 
      ? currentPrice - best.top 
      : best.bottom - currentPrice;
    const poiDist = trendDirection === 'UP'
      ? currentPrice - poi.top
      : poi.bottom - currentPrice;
    
    return poiDist < bestDist ? poi : best;
  });
}
