// src/core/trailing-stop.ts
/**
 * Manages trailing stop orders as trades progress toward profitability milestones.
 * Activates at 1:1 (breakeven) and tightens at 1:2 (half TP) to lock in gains.
 */

import { MT5Connector } from './mt5-connector';
import { info, warn } from '../utils/logger';
import { STRATEGY_CONFIG } from '../config/strategy';
import { pipToPrice } from '../utils/pip';

export type TrailingStopMilestone = 'breakeven' | 'half-tp' | '3quarter-tp';

export class TrailingStopManager {
  constructor(private connector: MT5Connector) {}

  /**
   * Calculate current profit ratio: (currentPrice - entry) / (TP - entry)
   * 0 = entry, 1 = TP hit
   */
  private getProfitRatio(entry: number, currentPrice: number, tp: number, side: 'BUY' | 'SELL'): number {
    if (side === 'BUY') {
      const profit = currentPrice - entry;
      const maxProfit = tp - entry;
      return profit / (maxProfit + 1e-9);
    } else {
      const profit = entry - currentPrice;
      const maxProfit = entry - tp;
      return profit / (maxProfit + 1e-9);
    }
  }

  /**
   * Get current trailing stop distance based on profit milestone
   */
  private getTrailingDistance(ratio: number): number | null {
    const cfg = STRATEGY_CONFIG.trailingStop;
    if (!cfg || !cfg.enabled) return null;

    // 1/2 to TP: tighter trailing
    if (ratio >= 0.5) {
      return cfg.trailingAtHalfTP ?? 3;
    }
    // 1/1 (breakeven): looser trailing
    if (ratio >= 0) {
      return cfg.trailingAtBreakeven ?? 5;
    }

    return null;
  }

  /**
   * Update SL to trailing stop distance if trade is profitable
   * Never allows SL to move past entry price (safety check)
   */
  async updateTrailingStop(
    orderId: number,
    symbol: string,
    entry: number,
    currentSL: number,
    tp: number,
    side: 'BUY' | 'SELL',
    currentPrice: number
  ): Promise<boolean> {
    try {
      const ratio = this.getProfitRatio(entry, currentPrice, tp, side);
      const trailingDist = this.getTrailingDistance(ratio);

      if (!trailingDist) {
        return false; // No trailing yet
      }

      // Calculate new SL based on current price and trailing distance
      // Convert trailing distance (in pips) to price using the pip utility so JPY/XAU are correct
      const move = pipToPrice(symbol, trailingDist);
      const newSL = side === 'BUY'
        ? currentPrice - move // Move SL up by trailing distance
        : currentPrice + move; // Move SL down by trailing distance

      // SAFETY: Never allow SL to move past entry price
      const safeNewSL = side === 'BUY'
        ? Math.max(newSL, entry) // BUY: SL stays >= entry
        : Math.min(newSL, entry); // SELL: SL stays <= entry

      // Only move SL closer to target (never go backwards)
      const isImprovement = side === 'BUY'
        ? safeNewSL > currentSL
        : safeNewSL < currentSL;

      if (isImprovement) {
        info(`Trailing stop: order ${orderId} (${symbol} ${side}), profit ratio ${(ratio * 100).toFixed(1)}%, new SL: ${safeNewSL.toFixed(5)}`);
        // In real implementation, modify the order via MT5
        // await this.connector.modifyOrder(orderId, { sl: safeNewSL });
        return true;
      }

      return false;
    } catch (e) {
      warn(`Trailing stop error for order ${orderId}: ${e}`);
      return false;
    }
  }
}
