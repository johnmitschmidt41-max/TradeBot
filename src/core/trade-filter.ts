// src/core/trade-filter.ts
import { STRATEGY_CONFIG } from "../config/strategy";
import { nowSec } from "../utils/time";

const tradesLog: { symbol: string; time: number; side: 'BUY' | 'SELL' }[] = [];

export function canOpenTrade(symbol: string, side: 'BUY' | 'SELL'): boolean {
  // Check max trades per day
  const today = new Date().toISOString().slice(0, 10);
  const tradesToday = tradesLog.filter(t => 
    new Date(t.time * 1000).toISOString().slice(0, 10) === today
  );
  
  if (tradesToday.length >= STRATEGY_CONFIG.risk.maxTradesPerDay) {
    return false;
  }
  
  // ✅ NEW: Check if we already opened this direction recently (5 minutes)
  const recentSameSide = tradesLog.find(t => 
    t.symbol === symbol && 
    t.side === side &&
    nowSec() - t.time < 5 * 60 // 5 minutes cooldown per direction
  );
  
  if (recentSameSide) {
    return false;
  }
  
  return true;
}

export function logTrade(symbol: string, side: 'BUY' | 'SELL') {
  tradesLog.push({ symbol, side, time: nowSec() });
}