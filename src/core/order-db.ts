// src/core/order-db.ts
// JSON-based database for tracking pending orders and triggered trades

import * as fs from 'fs';
import * as path from 'path';
import { info, warn } from '../utils/logger';

const DATA_DIR = path.join(__dirname, '../../data/output');
const PENDING_ORDERS_FILE = path.join(DATA_DIR, 'pending_orders.json');
const TRIGGERED_TRADES_FILE = path.join(DATA_DIR, 'triggered_trades.json');

export interface PendingOrderRecord {
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;  // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
  entryPrice: number;
  sl: number;
  tp: number;
  volume: number;
  placedAt: string;   // ISO timestamp
  setupType: string;  // reversal, continuation, trend, etc.
}

export interface TriggeredTradeRecord {
  ticket: number;
  originalOrderTicket?: number;  // Original pending order ticket if converted
  symbol: string;
  type: string;  // MARKET
  side: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  volume: number;
  placedAt: string;   // ISO timestamp when order was originally placed
  triggeredAt: string; // ISO timestamp when order was triggered/filled
  setupType: string;
  status: 'open' | 'closed';
  closedAt?: string;
  closePrice?: number;
  pnlPips?: number;
  result?: 'win' | 'loss' | 'be';
}

export class OrderDatabase {
  private pendingOrders: Map<string, PendingOrderRecord> = new Map();  // key: symbol
  private triggeredTrades: Map<string, TriggeredTradeRecord> = new Map();  // key: symbol

  constructor() {
    this.ensureDataDir();
    this.load();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private load(): void {
    // Load pending orders
    try {
      if (fs.existsSync(PENDING_ORDERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PENDING_ORDERS_FILE, 'utf-8'));
        for (const [symbol, record] of Object.entries(data)) {
          this.pendingOrders.set(symbol, record as PendingOrderRecord);
        }
        info('ORDER_DB', `Loaded ${this.pendingOrders.size} pending orders from file`);
      }
    } catch (err) {
      warn('ORDER_DB', `Failed to load pending orders: ${err}`);
    }

    // Load triggered trades
    try {
      if (fs.existsSync(TRIGGERED_TRADES_FILE)) {
        const data = JSON.parse(fs.readFileSync(TRIGGERED_TRADES_FILE, 'utf-8'));
        for (const [symbol, record] of Object.entries(data)) {
          this.triggeredTrades.set(symbol, record as TriggeredTradeRecord);
        }
        info('ORDER_DB', `Loaded ${this.triggeredTrades.size} triggered trades from file`);
      }
    } catch (err) {
      warn('ORDER_DB', `Failed to load triggered trades: ${err}`);
    }
  }

  private savePendingOrders(): void {
    try {
      const data: Record<string, PendingOrderRecord> = {};
      this.pendingOrders.forEach((record, symbol) => {
        data[symbol] = record;
      });
      fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      warn('ORDER_DB', `Failed to save pending orders: ${err}`);
    }
  }

  private saveTriggeredTrades(): void {
    try {
      const data: Record<string, TriggeredTradeRecord> = {};
      this.triggeredTrades.forEach((record, symbol) => {
        data[symbol] = record;
      });
      fs.writeFileSync(TRIGGERED_TRADES_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      warn('ORDER_DB', `Failed to save triggered trades: ${err}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PENDING ORDERS
  // ═══════════════════════════════════════════════════════════════════

  hasPendingOrder(symbol: string): boolean {
    return this.pendingOrders.has(symbol);
  }

  getPendingOrder(symbol: string): PendingOrderRecord | undefined {
    return this.pendingOrders.get(symbol);
  }

  getPendingOrderByTicket(ticket: number): PendingOrderRecord | undefined {
    for (const record of this.pendingOrders.values()) {
      if (record.ticket === ticket) {
        return record;
      }
    }
    return undefined;
  }

  addPendingOrder(record: PendingOrderRecord): void {
    this.pendingOrders.set(record.symbol, record);
    this.savePendingOrders();
    info('ORDER_DB', `Added pending order for ${record.symbol}`, {
      ticket: record.ticket,
      type: record.type,
      entry: record.entryPrice
    });
  }

  removePendingOrder(symbol: string, reason: string): PendingOrderRecord | undefined {
    const record = this.pendingOrders.get(symbol);
    if (record) {
      this.pendingOrders.delete(symbol);
      this.savePendingOrders();
      info('ORDER_DB', `Removed pending order for ${symbol}: ${reason}`, {
        ticket: record.ticket
      });
    }
    return record;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRIGGERED TRADES
  // ═══════════════════════════════════════════════════════════════════

  hasOpenTrade(symbol: string): boolean {
    const trade = this.triggeredTrades.get(symbol);
    return trade !== undefined && !trade.closedAt;
  }

  getOpenTrade(symbol: string): TriggeredTradeRecord | undefined {
    const trade = this.triggeredTrades.get(symbol);
    if (trade && !trade.closedAt) {
      return trade;
    }
    return undefined;
  }

  addTriggeredTrade(record: TriggeredTradeRecord): void {
    this.triggeredTrades.set(record.symbol, record);
    this.saveTriggeredTrades();
    info('ORDER_DB', `Added triggered trade for ${record.symbol}`, {
      ticket: record.ticket,
      entry: record.entryPrice
    });
  }

  closeTrade(symbol: string, closePrice: number, pnlPips: number, result: 'win' | 'loss' | 'be'): void {
    const trade = this.triggeredTrades.get(symbol);
    if (trade) {
      trade.closedAt = new Date().toISOString();
      trade.closePrice = closePrice;
      trade.pnlPips = pnlPips;
      trade.result = result;
      this.saveTriggeredTrades();
      info('ORDER_DB', `Closed trade for ${symbol}`, {
        ticket: trade.ticket,
        pnlPips,
        result
      });
    }
  }

  removeOpenTrade(symbol: string): void {
    this.triggeredTrades.delete(symbol);
    this.saveTriggeredTrades();
  }

  // ═══════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════

  // Clean up stale pending orders (older than 30 mins)
  cleanupStale(): void {
    const cutoff = Date.now() - 30 * 60 * 1000;  // 30 mins ago
    let removed = 0;

    this.pendingOrders.forEach((order, symbol) => {
      const placedTime = new Date(order.placedAt).getTime();
      if (placedTime < cutoff) {
        this.pendingOrders.delete(symbol);
        removed++;
        info('ORDER_DB', `Cleaned up stale pending order for ${symbol}`, {
          ticket: order.ticket,
          placedAt: order.placedAt
        });
      }
    });

    if (removed > 0) {
      this.savePendingOrders();
    }
  }

  // Get all pending orders for a symbol (returns array for compatibility)
  getSymbolPendingOrders(symbol: string): PendingOrderRecord[] {
    const order = this.pendingOrders.get(symbol);
    return order ? [order] : [];
  }

  // Clean up old closed trades (keep last 24 hours)
  cleanupOldTrades(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;

    this.triggeredTrades.forEach((trade, symbol) => {
      if (trade.closedAt) {
        const closedTime = new Date(trade.closedAt).getTime();
        if (closedTime < cutoff) {
          this.triggeredTrades.delete(symbol);
          removed++;
        }
      }
    });

    if (removed > 0) {
      this.saveTriggeredTrades();
      info('ORDER_DB', `Cleaned up ${removed} old closed trades`);
    }
  }

  // Get all pending orders (for debugging)
  getAllPendingOrders(): PendingOrderRecord[] {
    return Array.from(this.pendingOrders.values());
  }

  // Get all open trades (for debugging)
  getAllOpenTrades(): TriggeredTradeRecord[] {
    return Array.from(this.triggeredTrades.values()).filter(t => !t.closedAt);
  }
}

// Singleton instance
export const orderDb = new OrderDatabase();
