// src/core/data-feed.ts
import { MT5Connector } from "./mt5-connector";
import { Candle } from "../utils/types";

interface CacheEntry {
  candles: Candle[];
  timestamp: number;
}

export class DataFeed {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTTL = 30000; // 30 seconds cache

  constructor(private connector: MT5Connector) {}

  async getRecentCandles(symbol: string, timeframe = "M15", count = 500): Promise<Candle[]> {
    const cacheKey = `${symbol}_${timeframe}_${count}`;
    const now = Date.now();
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this.cacheTTL) {
      return cached.candles;
    }
    
    // Fetch fresh data
    const candles = await this.connector.getCandles(symbol, timeframe, count);
    // Ensure they are sorted oldest->newest
    const sorted = candles.sort((a: Candle, b: Candle) => a.time - b.time);
    
    // Update cache
    this.cache.set(cacheKey, { candles: sorted, timestamp: now });
    
    return sorted;
  }
}
