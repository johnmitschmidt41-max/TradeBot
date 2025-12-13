/**
 * Zone Manager - Unified Zone Detection and Management
 * 
 * Handles continuous scanning for all zone types (FVG, OB, Breaker) and provides
 * intelligent zone selection based on:
 * - Distance from price (20-100 pips valid range)
 * - Zone clustering (zones <20 pips apart treated as one)
 * - Zone ranking (FVG=3, Breaker=2, OB=1)
 * - Reaction quality (strong rejection = enter, weak/break = skip)
 * 
 * Flow:
 * 1. Continuously scan for all zones in range
 * 2. Cluster nearby zones together
 * 3. Track market reaction at each zone
 * 4. Enter on strong rejection, skip on weak reaction or break
 * 5. When all zones fail, structure is broken - stop looking
 */

import { Candle } from '../utils/types';
import { priceToPip } from '../utils/pip';
import { FVG, detectFVG } from './fvg-detector';
import { OrderBlock, detectOrderBlocks, findRelevantOB } from './ob-detector';
import { BreakerZone, detectBreakerBlocks } from './breaker-detector';

// Helper function to get pip size for a symbol
function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('XAU')) return 0.1;        // Gold: $0.10 per pip
  if (s.includes('JPY')) return 0.01;       // JPY pairs: 0.01 per pip
  if (s.includes('US30') || s.includes('DJ')) return 1.0;   // Dow: 1 point per pip
  if (s.includes('NAS') || s.includes('NDX')) return 1.0;   // Nasdaq: 1 point per pip
  return 0.0001;                             // Standard FX: 0.0001 per pip
}

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type ZoneType = 'fvg' | 'order_block' | 'breaker';

export interface Zone {
  id: string;                  // Unique identifier
  type: ZoneType;              // Type of zone
  side: 'BULL' | 'BEAR';       // Bullish zone = buy on touch, Bearish = sell
  tradeSide: 'BUY' | 'SELL';   // Trade direction at this zone
  high: number;                // Top of zone
  low: number;                 // Bottom of zone
  midpoint: number;            // Middle of zone (for distance calc)
  rank: number;                // Priority: FVG=3, Breaker=2, OB=1
  distancePips: number;        // Current distance from price
  createdAt: number;           // Timestamp when detected
  status: 'active' | 'testing' | 'rejected' | 'broken' | 'invalidated';
  testCount: number;           // How many times price has touched
  lastTestTime?: number;       // When last touched
  rejectionStrength?: number;  // 0-100 strength of rejection if tested
  clusterId?: string;          // ID of cluster this zone belongs to
  
  // Original zone data for reference
  originalFVG?: FVG;
  originalOB?: OrderBlock;
  originalBreaker?: BreakerZone;
}

export interface ZoneCluster {
  id: string;
  zones: Zone[];               // All zones in this cluster
  high: number;                // Highest zone boundary
  low: number;                 // Lowest zone boundary
  midpoint: number;
  bestZone: Zone;              // Highest ranked zone in cluster
  avgRank: number;             // Average rank of all zones
  distancePips: number;        // Distance from current price
  tradeSide: 'BUY' | 'SELL';   // Trade direction (from majority)
}

export interface ReactionResult {
  hasReaction: boolean;
  isRejection: boolean;        // True = rejection (enter), False = break (skip)
  strength: number;            // 0-100 strength
  entryPrice?: number;         // Price to enter if rejection
  reason?: string;             // Description of the reaction
}

// ═══════════════════════════════════════════════════════════════════
// ZONE MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════

export class ZoneManager {
  // Zone storage per symbol
  private zones: Map<string, Zone[]> = new Map();
  private clusters: Map<string, ZoneCluster[]> = new Map();
  
  // Configuration
  private readonly MIN_DISTANCE_PIPS = 10;   // Zones must be at least 10 pips away
  private readonly MAX_DISTANCE_PIPS = 80;   // Zones beyond 80 pips are too far
  private readonly CLUSTER_DISTANCE_PIPS = 20; // Zones within 20 pips = same cluster
  private readonly MAX_ZONE_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours max zone age
  
  // Zone rankings
  private readonly RANK_FVG = 3;
  private readonly RANK_BREAKER = 2;
  private readonly RANK_OB = 1;

  constructor() {}

  /**
   * Update zones for a symbol with latest candle data
   * Returns all valid zones within tradeable range
   */
  public updateZones(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    tradeSide: 'BUY' | 'SELL',  // What direction are we looking to trade?
    existingBreakers: BreakerZone[] = []
  ): Zone[] {
    const now = Date.now();
    const pipSize = getPipSize(symbol);
    
    // Get existing zones or initialize
    let symbolZones = this.zones.get(symbol) || [];
    
    // Remove expired/old zones
    symbolZones = symbolZones.filter(z => now - z.createdAt < this.MAX_ZONE_AGE_MS);
    symbolZones = symbolZones.filter(z => z.status !== 'invalidated' && z.status !== 'broken');
    
    // Detect new FVGs
    const fvgs = detectFVG(candles, 10, symbol);
    for (const fvg of fvgs) {
      const zoneSide = fvg.side === 'BULL' ? 'BUY' : 'SELL';
      
      // Only add zones that match our trade direction
      if (zoneSide !== tradeSide) continue;
      
      // Check if this FVG already exists (by index and range)
      const exists = symbolZones.some(z => 
        z.type === 'fvg' && 
        Math.abs(z.high - fvg.high) < pipSize * 2 &&
        Math.abs(z.low - fvg.low) < pipSize * 2
      );
      
      if (!exists) {
        const midpoint = (fvg.high + fvg.low) / 2;
        const distancePips = this.calculateDistance(currentPrice, midpoint, pipSize, zoneSide);
        
        symbolZones.push({
          id: `fvg_${symbol}_${now}_${fvg.index}`,
          type: 'fvg',
          side: fvg.side,
          tradeSide: zoneSide,
          high: fvg.high,
          low: fvg.low,
          midpoint,
          rank: this.RANK_FVG,
          distancePips,
          createdAt: now,
          status: 'active',
          testCount: 0,
          originalFVG: fvg
        });
      }
    }
    
    // Detect Order Blocks
    const obs = detectOrderBlocks(candles, symbol, 15, 30);
    for (const ob of obs) {
      const zoneSide: 'BUY' | 'SELL' = ob.side === 'BULL' ? 'BUY' : 'SELL';
      
      // Only add zones that match our trade direction
      if (zoneSide !== tradeSide) continue;
      
      // Check if this OB already exists
      const exists = symbolZones.some(z => 
        z.type === 'order_block' && 
        Math.abs(z.high - ob.high) < pipSize * 5 &&
        Math.abs(z.low - ob.low) < pipSize * 5
      );
      
      if (!exists) {
        const midpoint = (ob.bodyHigh + ob.bodyLow) / 2;
        const distancePips = this.calculateDistance(currentPrice, midpoint, pipSize, zoneSide);
        
        symbolZones.push({
          id: `ob_${symbol}_${now}_${ob.index}`,
          type: 'order_block',
          side: ob.side,
          tradeSide: zoneSide,
          high: ob.high,
          low: ob.low,
          midpoint,
          rank: this.RANK_OB,
          distancePips,
          createdAt: now,
          status: 'active',
          testCount: 0,
          originalOB: ob
        });
      }
    }
    
    // Add existing breaker zones
    for (const breaker of existingBreakers) {
      // Only add zones that match our trade direction
      if (breaker.tradeSide !== tradeSide) continue;
      
      // Check if this breaker already exists
      const exists = symbolZones.some(z => 
        z.type === 'breaker' && 
        Math.abs(z.midpoint - breaker.level) < pipSize * 5
      );
      
      if (!exists) {
        const distancePips = this.calculateDistance(currentPrice, breaker.level, pipSize, breaker.tradeSide);
        
        symbolZones.push({
          id: `breaker_${symbol}_${breaker.breakTime}`,
          type: 'breaker',
          side: breaker.side,
          tradeSide: breaker.tradeSide,
          high: breaker.zoneHigh,
          low: breaker.zoneLow,
          midpoint: breaker.level,
          rank: this.RANK_BREAKER,
          distancePips,
          createdAt: breaker.breakTime,
          status: 'active',
          testCount: breaker.testCount,
          originalBreaker: breaker
        });
      }
    }
    
    // Update distances for all zones
    for (const zone of symbolZones) {
      zone.distancePips = this.calculateDistance(currentPrice, zone.midpoint, pipSize, zone.tradeSide);
    }
    
    // Filter to valid range (20-100 pips)
    const validZones = symbolZones.filter(z => 
      z.distancePips >= this.MIN_DISTANCE_PIPS && 
      z.distancePips <= this.MAX_DISTANCE_PIPS
    );
    
    // Sort by distance (closest first), then by rank (highest first)
    validZones.sort((a, b) => {
      if (a.distancePips !== b.distancePips) return a.distancePips - b.distancePips;
      return b.rank - a.rank;
    });
    
    // Store updated zones
    this.zones.set(symbol, symbolZones);
    
    return validZones;
  }

  /**
   * Calculate distance from current price to zone
   * For BUY zones, measure down to zone
   * For SELL zones, measure up to zone
   */
  private calculateDistance(currentPrice: number, zonePrice: number, pipSize: number, tradeSide: 'BUY' | 'SELL'): number {
    if (tradeSide === 'BUY') {
      // BUY zones are below price
      return (currentPrice - zonePrice) / pipSize;
    } else {
      // SELL zones are above price
      return (zonePrice - currentPrice) / pipSize;
    }
  }

  /**
   * Cluster zones that are within 20 pips of each other
   * Returns clusters sorted by distance then by best rank
   */
  public clusterZones(symbol: string, zones: Zone[]): ZoneCluster[] {
    if (zones.length === 0) return [];
    
    const pipSize = getPipSize(symbol);
    const clusterThreshold = this.CLUSTER_DISTANCE_PIPS * pipSize;
    
    const clusters: ZoneCluster[] = [];
    const assignedZones = new Set<string>();
    
    for (const zone of zones) {
      if (assignedZones.has(zone.id)) continue;
      
      // Find all zones within cluster threshold
      const clusterMembers = zones.filter(z => {
        if (assignedZones.has(z.id)) return false;
        if (z.tradeSide !== zone.tradeSide) return false;
        
        const distance = Math.abs(z.midpoint - zone.midpoint);
        return distance <= clusterThreshold;
      });
      
      if (clusterMembers.length === 0) continue;
      
      // Mark all as assigned
      clusterMembers.forEach(z => assignedZones.add(z.id));
      
      // Calculate cluster bounds
      const high = Math.max(...clusterMembers.map(z => z.high));
      const low = Math.min(...clusterMembers.map(z => z.low));
      const midpoint = (high + low) / 2;
      
      // Find best zone (highest rank)
      const bestZone = clusterMembers.reduce((best, z) => z.rank > best.rank ? z : best, clusterMembers[0]);
      
      // Calculate average rank
      const avgRank = clusterMembers.reduce((sum, z) => sum + z.rank, 0) / clusterMembers.length;
      
      // Average distance
      const avgDistance = clusterMembers.reduce((sum, z) => sum + z.distancePips, 0) / clusterMembers.length;
      
      clusters.push({
        id: `cluster_${zone.id}`,
        zones: clusterMembers,
        high,
        low,
        midpoint,
        bestZone,
        avgRank,
        distancePips: avgDistance,
        tradeSide: zone.tradeSide
      });
    }
    
    // Sort clusters by distance
    clusters.sort((a, b) => a.distancePips - b.distancePips);
    
    this.clusters.set(symbol, clusters);
    return clusters;
  }

  /**
   * Check for market reaction at a zone
   * Returns reaction details including whether to enter or skip
   */
  public checkReaction(
    symbol: string,
    zone: Zone,
    candles: Candle[],
    currentPrice: number
  ): ReactionResult {
    if (candles.length < 3) {
      return { hasReaction: false, isRejection: false, strength: 0 };
    }
    
    const pipSize = getPipSize(symbol);
    const currentCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    
    // Check if price is touching the zone
    const isInZone = this.isPriceInZone(currentPrice, zone) || 
                     this.isCandleTouchingZone(currentCandle, zone);
    
    if (!isInZone) {
      return { hasReaction: false, isRejection: false, strength: 0 };
    }
    
    // Price is at zone - check for reaction
    zone.testCount++;
    zone.lastTestTime = Date.now();
    zone.status = 'testing';
    
    // Check for rejection
    const rejection = this.detectRejection(zone, candles, pipSize);
    
    if (rejection.isRejection) {
      zone.rejectionStrength = rejection.strength;
      zone.status = 'rejected';
      
      return {
        hasReaction: true,
        isRejection: true,
        strength: rejection.strength,
        entryPrice: rejection.entryPrice,
        reason: `${zone.type.toUpperCase()} rejection (strength: ${rejection.strength})`
      };
    }
    
    // Check if zone is broken (price closes through)
    const isBroken = this.isZoneBroken(zone, currentCandle);
    
    if (isBroken) {
      zone.status = 'broken';
      
      return {
        hasReaction: true,
        isRejection: false,
        strength: 0,
        reason: `${zone.type.toUpperCase()} broken - price closed through zone`
      };
    }
    
    // Still testing, no decision yet
    return {
      hasReaction: true,
      isRejection: false,
      strength: 0,
      reason: `Testing ${zone.type.toUpperCase()} - awaiting reaction`
    };
  }

  /**
   * Check if current price is inside the zone
   */
  private isPriceInZone(price: number, zone: Zone): boolean {
    return price >= zone.low && price <= zone.high;
  }

  /**
   * Check if candle wick touches the zone
   */
  private isCandleTouchingZone(candle: Candle, zone: Zone): boolean {
    // Candle touches zone if any part overlaps
    return candle.low <= zone.high && candle.high >= zone.low;
  }

  /**
   * Detect rejection at zone (wick rejection, engulfing, pin bar)
   */
  private detectRejection(
    zone: Zone,
    candles: Candle[],
    pipSize: number
  ): { isRejection: boolean; strength: number; entryPrice?: number } {
    const currentCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    
    const candleRange = currentCandle.high - currentCandle.low;
    const bodyHigh = Math.max(currentCandle.open, currentCandle.close);
    const bodyLow = Math.min(currentCandle.open, currentCandle.close);
    const bodySize = bodyHigh - bodyLow;
    
    let strength = 0;
    let isRejection = false;
    let entryPrice = currentCandle.close;
    
    if (zone.tradeSide === 'BUY') {
      // For BUY, look for rejection from below (bullish reaction)
      const lowerWick = bodyLow - currentCandle.low;
      const upperWick = currentCandle.high - bodyHigh;
      
      // Pin bar / hammer
      if (lowerWick > bodySize * 2 && lowerWick > upperWick * 2) {
        isRejection = true;
        strength = Math.min(100, 50 + (lowerWick / candleRange) * 50);
      }
      
      // Bullish engulfing
      if (currentCandle.close > currentCandle.open && 
          bodySize > Math.abs(prevCandle.close - prevCandle.open) * 1.5) {
        isRejection = true;
        strength = Math.max(strength, 60);
      }
      
      // Strong close above zone (clear rejection)
      if (currentCandle.close > zone.high && currentCandle.low <= zone.midpoint) {
        isRejection = true;
        strength = Math.max(strength, 70);
      }
    } else {
      // For SELL, look for rejection from above (bearish reaction)
      const upperWick = currentCandle.high - bodyHigh;
      const lowerWick = bodyLow - currentCandle.low;
      
      // Shooting star / inverted hammer
      if (upperWick > bodySize * 2 && upperWick > lowerWick * 2) {
        isRejection = true;
        strength = Math.min(100, 50 + (upperWick / candleRange) * 50);
      }
      
      // Bearish engulfing
      if (currentCandle.close < currentCandle.open && 
          bodySize > Math.abs(prevCandle.close - prevCandle.open) * 1.5) {
        isRejection = true;
        strength = Math.max(strength, 60);
      }
      
      // Strong close below zone (clear rejection)
      if (currentCandle.close < zone.low && currentCandle.high >= zone.midpoint) {
        isRejection = true;
        strength = Math.max(strength, 70);
      }
    }
    
    return { isRejection, strength, entryPrice };
  }

  /**
   * Check if zone is broken (candle closes through)
   */
  private isZoneBroken(zone: Zone, candle: Candle): boolean {
    if (zone.tradeSide === 'BUY') {
      // BUY zone is below price - broken if price closes below zone low
      return candle.close < zone.low;
    } else {
      // SELL zone is above price - broken if price closes above zone high
      return candle.close > zone.high;
    }
  }

  /**
   * Get the best zone for entry (closest with highest rank)
   */
  public getBestZone(symbol: string, tradeSide: 'BUY' | 'SELL'): Zone | null {
    const zones = this.zones.get(symbol) || [];
    
    const validZones = zones.filter(z => 
      z.tradeSide === tradeSide &&
      z.status === 'active' &&
      z.distancePips >= this.MIN_DISTANCE_PIPS &&
      z.distancePips <= this.MAX_DISTANCE_PIPS
    );
    
    if (validZones.length === 0) return null;
    
    // Sort by distance first, then rank
    validZones.sort((a, b) => {
      if (a.distancePips !== b.distancePips) return a.distancePips - b.distancePips;
      return b.rank - a.rank;
    });
    
    return validZones[0];
  }

  /**
   * Get all active zones for a symbol
   */
  public getActiveZones(symbol: string): Zone[] {
    return (this.zones.get(symbol) || []).filter(z => z.status === 'active');
  }

  /**
   * Get all clusters for a symbol
   */
  public getClusters(symbol: string): ZoneCluster[] {
    return this.clusters.get(symbol) || [];
  }

  /**
   * Mark a zone as invalidated (don't use it anymore)
   */
  public invalidateZone(symbol: string, zoneId: string): void {
    const zones = this.zones.get(symbol) || [];
    const zone = zones.find(z => z.id === zoneId);
    if (zone) {
      zone.status = 'invalidated';
    }
  }

  /**
   * Mark a zone as broken (price closed through)
   */
  public markZoneBroken(symbol: string, zoneId: string): void {
    const zones = this.zones.get(symbol) || [];
    const zone = zones.find(z => z.id === zoneId);
    if (zone) {
      zone.status = 'broken';
    }
  }

  /**
   * Check if all zones in range are broken (structure failure)
   */
  public isStructureBroken(symbol: string, tradeSide: 'BUY' | 'SELL'): boolean {
    const zones = this.zones.get(symbol) || [];
    
    // Get zones for this trade side in valid range
    const relevantZones = zones.filter(z => 
      z.tradeSide === tradeSide &&
      z.distancePips >= this.MIN_DISTANCE_PIPS &&
      z.distancePips <= this.MAX_DISTANCE_PIPS
    );
    
    // If no zones exist, structure is not broken (just no zones)
    if (relevantZones.length === 0) return false;
    
    // If ALL zones are broken, structure is broken
    return relevantZones.every(z => z.status === 'broken' || z.status === 'invalidated');
  }

  /**
   * Clear all zones for a symbol (after trade or structure break)
   */
  public clearZones(symbol: string): void {
    this.zones.delete(symbol);
    this.clusters.delete(symbol);
  }

  /**
   * Get summary of zones for logging
   */
  public getZoneSummary(symbol: string): string {
    const zones = this.zones.get(symbol) || [];
    const active = zones.filter(z => z.status === 'active');
    const fvgs = active.filter(z => z.type === 'fvg').length;
    const obs = active.filter(z => z.type === 'order_block').length;
    const breakers = active.filter(z => z.type === 'breaker').length;
    
    return `Zones: ${fvgs} FVG, ${obs} OB, ${breakers} Breaker (${active.length} total active)`;
  }

  /**
   * Get detailed zone info with prices for logging
   */
  public getDetailedZoneSummary(symbol: string, isXAU: boolean = false): string {
    const zones = this.zones.get(symbol) || [];
    const active = zones.filter(z => z.status === 'active');
    
    if (active.length === 0) {
      return 'No active zones';
    }
    
    const decimals = isXAU ? 2 : 5;
    
    // Group by type and show prices
    const fvgs = active.filter(z => z.type === 'fvg');
    const obs = active.filter(z => z.type === 'order_block');
    const breakers = active.filter(z => z.type === 'breaker');
    
    const parts: string[] = [];
    
    if (fvgs.length > 0) {
      const fvgPrices = fvgs.map(z => `${z.midpoint.toFixed(decimals)} (${z.distancePips.toFixed(0)}p)`).join(', ');
      parts.push(`FVG: ${fvgPrices}`);
    }
    
    if (obs.length > 0) {
      const obPrices = obs.map(z => `${z.midpoint.toFixed(decimals)} (${z.distancePips.toFixed(0)}p)`).join(', ');
      parts.push(`OB: ${obPrices}`);
    }
    
    if (breakers.length > 0) {
      const breakerPrices = breakers.map(z => `${z.midpoint.toFixed(decimals)} (${z.distancePips.toFixed(0)}p)`).join(', ');
      parts.push(`Breaker: ${breakerPrices}`);
    }
    
    return parts.join(' | ');
  }
}

// Export singleton instance
export const zoneManager = new ZoneManager();
