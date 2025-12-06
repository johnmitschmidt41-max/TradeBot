// src/core/order-manager.ts
import { MT5Connector } from "./mt5-connector";
import { OrderRequest } from "../utils/types";
import { info, warn, error } from "../utils/logger";

// Order types for MT5
export type OrderType = 
  | 'BUY'           // Market buy
  | 'SELL'          // Market sell
  | 'BUY_LIMIT'     // Buy below current price (wait for dip)
  | 'SELL_LIMIT'    // Sell above current price (wait for rally)
  | 'BUY_STOP'      // Buy above current price (breakout)
  | 'SELL_STOP';    // Sell below current price (breakout)

export class OrderManager {
  constructor(private connector: MT5Connector) {}

  /**
   * Determine the correct order type based on current price and entry
   */
  getOrderType(side: 'BUY' | 'SELL', entryPrice: number, currentPrice: number, tolerance: number): OrderType {
    if (side === 'BUY') {
      // Check if we can execute at market (within tolerance)
      if (Math.abs(currentPrice - entryPrice) <= tolerance) {
        return 'BUY';  // Market order
      }
      // Entry below current price = wait for dip = BUY LIMIT
      if (entryPrice < currentPrice) {
        return 'BUY_LIMIT';
      }
      // Entry above current price = breakout = BUY STOP
      return 'BUY_STOP';
    } else {
      // Check if we can execute at market (within tolerance)
      if (Math.abs(currentPrice - entryPrice) <= tolerance) {
        return 'SELL';  // Market order
      }
      // Entry above current price = wait for rally = SELL LIMIT
      if (entryPrice > currentPrice) {
        return 'SELL_LIMIT';
      }
      // Entry below current price = breakout = SELL STOP
      return 'SELL_STOP';
    }
  }

  /**
   * Place a pending order (limit or stop)
   */
  async placePendingOrder(req: {
    symbol: string;
    type: OrderType;
    volume: number;
    price: number;
    sl: number;
    tp: number;
    comment?: string;
  }) {
    try {
      info('ORDER', `Placing ${req.type} order`, req);
      
      if (!isFinite(req.sl) || !isFinite(req.tp) || !isFinite(req.price)) {
        throw new Error(`Invalid order params: price=${req.price}, sl=${req.sl}, tp=${req.tp}`);
      }
      
      const res = await this.connector.placeOrder({
        symbol: req.symbol,
        type: req.type as any,  // MT5 bridge accepts all order types
        volume: req.volume,
        price: req.price,
        sl: req.sl,
        tp: req.tp,
        comment: req.comment
      });
      
      info('ORDER', 'Order result', res);
      return res;
    } catch (err: any) {
      const { formatError } = require('../utils/error');
      error('ORDER', 'Order error', err?.response?.data ?? formatError(err));
      throw err;
    }
  }

  async placeLimitOrder(req: OrderRequest) {
    try {
      info('Placing LIMIT order', req);
      // SL and TP must be provided for limit orders
      if (typeof req.sl !== 'number' || typeof req.tp !== 'number') {
        throw new Error('SL and TP are required for limit orders');
      }
      const res = await this.connector.placeOrder({
        symbol: req.symbol,
        type: req.type,
        volume: req.volume,
        price: req.price,
        sl: req.sl,
        tp: req.tp,
        comment: req.comment
      });
      info('Order result', res);
      return res;
    } catch (err: any) {
      // use format helper for robust error messages
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatError } = require('../utils/error');
      error('Order error', err?.response?.data ?? formatError(err));
      throw err;
    }
  }

  async placeMarketOrder(req: {
    symbol: string;
    type: 'BUY' | 'SELL';
    volume: number;
    sl: number;
    tp: number;
    comment?: string;
  }) {
    try {
      info('Placing MARKET order', req);
      // Validate SL and TP are actual numbers (not NaN or undefined)
      if (!isFinite(req.sl) || !isFinite(req.tp)) {
        throw new Error(`Invalid SL or TP: sl=${req.sl}, tp=${req.tp}`);
      }
      const res = await this.connector.placeOrder({
        symbol: req.symbol,
        type: req.type,
        volume: req.volume,
        price: 0, // 0 = market order
        sl: req.sl,
        tp: req.tp,
        comment: req.comment
      });
      info('Order result', res);
      return res;
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatError } = require('../utils/error');
      error('Order error', err?.response?.data ?? formatError(err));
      throw err;
    }
  }
}