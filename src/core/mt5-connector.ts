// src/core/mt5-connector.ts
import axios from 'axios';

// Allow overriding the bridge URL with environment variable (use local fallback)
const MT5_BRIDGE_URL = (process.env.MT5_BRIDGE || process.env.MT5_BRIDGE_URL || 'http://127.0.0.1:5000').replace(/\/+$/,'');

function logConnectorError(context: string, err: any) {
  const msg = err?.response?.data ?? err?.message ?? String(err);
  console.warn(`[mt5-connector] ${context} failed:`, msg);
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AccountInfo {
  login?: number;
  balance?: number;
  equity?: number;
  margin?: number;
  free_margin?: number;
  [key: string]: any;
}

export class MT5Connector {
  private isConnected = false;
  // In-memory cache for account info requests to avoid rapid repeated /account calls
  private accountCache: { ts: number; data: AccountInfo | null } | null = null;
  // configurable TTL for account cache (milliseconds)
  private accountCacheTTL = Number(process.env.MT5_ACCOUNT_CACHE_TTL_MS || 2000);

  async login(account: number, password: string, server: string): Promise<void> {
    const response = await axios.post(`${MT5_BRIDGE_URL}/login`, {
      account,
      password,
      server
    });

    if (response.data.success) {
      this.isConnected = true;
      console.log('✅ Connected to MT5:', response.data.account_info);
    } else {
      throw new Error('MT5 login failed');
    }
  }

  async getCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    try {
      const response = await axios.post(`${MT5_BRIDGE_URL}/candles`, {
      symbol,
      timeframe,
      count
      });
      return response.data.candles;
    } catch (err:any) {
      logConnectorError('/candles', err);
      throw err;
    }
  }

  async placeOrder(params: {
    symbol: string;
    type: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
    volume: number;
    price?: number;
    sl: number;
    tp: number;
    comment?: string;
  }): Promise<any> {
    try {
      const response = await axios.post(`${MT5_BRIDGE_URL}/order`, params);
      return response.data;
    } catch (err:any) {
      logConnectorError('/order', err);
      throw err;
    }
  }

  // Backwards-compatible: returns all positions or positions for symbol
  async getPositions(): Promise<any[]> {
    try {
      const response = await axios.get(`${MT5_BRIDGE_URL}/positions`);
      return response.data.positions || [];
    } catch (err:any) {
      logConnectorError('/positions', err);
      throw err;
    }
  }

  async getOpenPositions(symbol?: string): Promise<any[]> {
    const url = symbol 
      ? `${MT5_BRIDGE_URL}/positions?symbol=${symbol}`
      : `${MT5_BRIDGE_URL}/positions`;
    
    try {
      const response = await axios.get(url);
      return response.data.positions || [];
    } catch (err:any) {
      logConnectorError('/positions?symbol', err);
      throw err;
    }
  }

  async getPendingOrders(symbol?: string): Promise<any[]> {
    const url = symbol 
      ? `${MT5_BRIDGE_URL}/orders?symbol=${symbol}`
      : `${MT5_BRIDGE_URL}/orders`;
    
    try {
      const response = await axios.get(url);
      return response.data.orders || [];
    } catch (err:any) {
      // If 503 or 500, throw error so we don't assume empty list
      if (err.response && (err.response.status === 503 || err.response.status === 500)) {
        console.warn(`[mt5-connector] MT5 Bridge error fetching orders: ${err.response.data?.error || err.message}`);
        throw new Error(`MT5 Bridge Error: ${err.response.data?.error || err.message}`);
      }
      logConnectorError('/orders?symbol', err);
      throw err;
    }
  }

  // NEW: account info (balance, equity, etc.)
  async getAccountInfo(forceRefresh = false): Promise<AccountInfo | null> {
    try {
      // honor in-memory cache to avoid hammering the MT5 bridge
      if (!forceRefresh && this.accountCache) {
        const age = Date.now() - this.accountCache.ts;
        if (age <= this.accountCacheTTL) {
          // Cache hit — return cached value
          // Note: use a shallow copy to avoid accidental modification
          return { ...this.accountCache.data } as AccountInfo | null;
        }
      }
      const response = await axios.get(`${MT5_BRIDGE_URL}/account`);
      const account = response.data.account ?? null;
      this.accountCache = { ts: Date.now(), data: account };
      return account;
    } catch (err:any) {
      logConnectorError('/account', err);
      return null;
    }
  }

  // Fetch closed deal history (optionally since epoch seconds)
  async getDeals(since?: number): Promise<any[]> {
    const url = typeof since === 'number' ? `${MT5_BRIDGE_URL}/deals?since=${since}` : `${MT5_BRIDGE_URL}/deals`;
    try {
      const response = await axios.get(url);
      return response.data.deals || [];
    } catch (err:any) {
      logConnectorError('/deals', err);
      throw err; // Let callers handle retries
    }
  }

  // Cancel/delete a pending order
  async cancelOrder(ticket: number): Promise<any> {
    try {
      const response = await axios.post(`${MT5_BRIDGE_URL}/cancel-order`, { ticket });
      return response.data;
    } catch (err:any) {
      logConnectorError('/cancel-order', err);
      throw err;
    }
  }

  // Fetch current tick (bid/ask/spread) for a symbol
  async getTick(symbol: string): Promise<{ bid: number; ask: number; spread: number } | null> {
    try {
      const response = await axios.get(`${MT5_BRIDGE_URL}/tick?symbol=${encodeURIComponent(symbol)}`);
      const data = response.data;
      if (data && typeof data.bid === 'number' && typeof data.ask === 'number') {
        return { bid: data.bid, ask: data.ask, spread: data.spread };
      }
      return null;
    } catch (err:any) {
      logConnectorError('/tick', err);
      return null;
    }
  }

  // NEW: convenience wrapper for all open positions (alias)
  async getAllOpenPositions(): Promise<any[]> {
    return this.getOpenPositions();
  }
}
