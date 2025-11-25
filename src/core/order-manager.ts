// src/core/order-manager.ts
import { MT5Connector } from "./mt5-connector";
import { OrderRequest } from "../utils/types";
import { info, warn, error } from "../utils/logger";

export class OrderManager {
  constructor(private connector: MT5Connector) {}

  async placeLimitOrder(req: OrderRequest) {
    try {
      info('Placing LIMIT order', req);
      const res = await this.connector.placeOrder({
        symbol: req.symbol,
        type: req.type,
        volume: req.volume,
        price: req.price,
        sl: req.sl ?? 0,
        tp: req.tp ?? 0,
      });
      info('Order result', res);
      return res;
    } catch (err: any) {
      error('Order error', err?.response?.data ?? err?.message ?? err);
      throw err;
    }
  }

  async placeMarketOrder(req: {
    symbol: string;
    type: 'BUY' | 'SELL';
    volume: number;
    sl: number;
    tp: number;
  }) {
    try {
      info('Placing MARKET order', req);
      const res = await this.connector.placeOrder({
        symbol: req.symbol,
        type: req.type,
        volume: req.volume,
        price: 0, // 0 = market order
        sl: req.sl ?? 0,
        tp: req.tp ?? 0,
      });
      info('Order result', res);
      return res;
    } catch (err: any) {
      error('Order error', err?.response?.data ?? err?.message ?? err);
      throw err;
    }
  }
}