// src/core/position-limiter.ts
// Enforces max simultaneous trades: 6 global, 2 per currency

import { STRATEGY_CONFIG } from '../config/strategy';
import { info, warn } from '../utils/logger';

interface PositionCount {
  GBPUSDz: number;
  EURUSDz: number;
  XAUUSDz: number;
  total: number;
}

export class PositionLimiter {
  private openPositions = new Map<string, { symbol: string; side: string; openTime: number }>();

  /**
   * Check if we can open a new trade
   */
  canOpenTrade(symbol: string): boolean {
    const counts = this.getPositionCounts();
    const maxGlobal = STRATEGY_CONFIG.risk.maxSimultaneousTradesGlobal;
    const maxPerCurrencyConfig = STRATEGY_CONFIG.risk.maxSimultaneousTradesPerCurrency as any;
    const maxPerCurrency = maxPerCurrencyConfig[symbol];

    // Check global limit
    if (counts.total >= maxGlobal) {
      warn(`🚫 Global limit reached: ${counts.total}/${maxGlobal} simultaneous trades`);
      return false;
    }

    // Check per-currency limit
    const currencyCount = counts[symbol as keyof PositionCount] || 0;
    if (currencyCount >= maxPerCurrency) {
      warn(`🚫 ${symbol} limit reached: ${currencyCount}/${maxPerCurrency} simultaneous trades`);
      return false;
    }

    return true;
  }

  /**
   * Register a new open position
   */
  registerOpenPosition(orderId: string, symbol: string, side: string): void {
    this.openPositions.set(orderId, {
      symbol,
      side,
      openTime: Date.now()
    });
    const counts = this.getPositionCounts();
    info(`📈 Position opened: ${symbol} ${side} | Open: ${counts.total}/${STRATEGY_CONFIG.risk.maxSimultaneousTradesGlobal}`);
  }

  /**
   * Unregister a closed position
   */
  unregisterClosedPosition(orderId: string): void {
    const pos = this.openPositions.get(orderId);
    if (pos) {
      this.openPositions.delete(orderId);
      const counts = this.getPositionCounts();
      info(`📉 Position closed: ${pos.symbol} ${pos.side} | Open: ${counts.total}/${STRATEGY_CONFIG.risk.maxSimultaneousTradesGlobal}`);
    }
  }

  /**
   * Get current position counts
   */
  getPositionCounts(): PositionCount {
    const counts: PositionCount = {
      GBPUSDz: 0,
      EURUSDz: 0,
      XAUUSDz: 0,
      total: 0
    };

    this.openPositions.forEach((pos) => {
      counts[pos.symbol as keyof PositionCount]++;
      counts.total++;
    });

    return counts;
  }

  /**
   * Get open positions for a symbol
   */
  getOpenPositionsForSymbol(symbol: string): Array<{ orderId: string; side: string; openTime: number }> {
    return Array.from(this.openPositions.entries())
      .filter(([_, pos]) => pos.symbol === symbol)
      .map(([orderId, pos]) => ({
        orderId,
        side: pos.side,
        openTime: pos.openTime
      }));
  }

  /**
   * Get all open positions
   */
  getAllOpenPositions(): Array<{ orderId: string; symbol: string; side: string; openTime: number }> {
    return Array.from(this.openPositions.entries()).map(([orderId, pos]) => ({
      orderId,
      ...pos
    }));
  }

  /**
   * Get position count status string
   */
  getStatusString(): string {
    const counts = this.getPositionCounts();
    const maxGlobal = STRATEGY_CONFIG.risk.maxSimultaneousTradesGlobal || 6;
    return `Positions: GBP=${counts.GBPUSDz}/2 | EUR=${counts.EURUSDz}/2 | XAU=${counts.XAUUSDz}/2 | Total=${counts.total}/${maxGlobal}`;
  }
}

export const positionLimiter = new PositionLimiter();
