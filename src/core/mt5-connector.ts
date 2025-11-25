// src/core/mt5-connector.ts
import axios from 'axios';

const MT5_BRIDGE_URL = 'http://163.5.210.176:5000';

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
    const response = await axios.post(`${MT5_BRIDGE_URL}/candles`, {
      symbol,
      timeframe,
      count
    });
    return response.data.candles;
  }

  async placeOrder(params: {
    symbol: string;
    type: 'BUY' | 'SELL';
    volume: number;
    price?: number;
    sl: number;
    tp: number;
  }): Promise<any> {
    const response = await axios.post(`${MT5_BRIDGE_URL}/order`, params);
    return response.data;
  }

  // Backwards-compatible: returns all positions or positions for symbol
  async getPositions(): Promise<any[]> {
    const response = await axios.get(`${MT5_BRIDGE_URL}/positions`);
    return response.data.positions || [];
  }

  async getOpenPositions(symbol?: string): Promise<any[]> {
    const url = symbol 
      ? `${MT5_BRIDGE_URL}/positions?symbol=${symbol}`
      : `${MT5_BRIDGE_URL}/positions`;
    
    const response = await axios.get(url);
    return response.data.positions || [];
  }

  async getPendingOrders(symbol?: string): Promise<any[]> {
    const url = symbol 
      ? `${MT5_BRIDGE_URL}/orders?symbol=${symbol}`
      : `${MT5_BRIDGE_URL}/orders`;
    
    const response = await axios.get(url);
    return response.data.orders || [];
  }

  // NEW: account info (balance, equity, etc.)
  async getAccountInfo(): Promise<AccountInfo | null> {
    const response = await axios.get(`${MT5_BRIDGE_URL}/account`);
    return response.data.account ?? null;
  }

  // NEW: convenience wrapper for all open positions (alias)
  async getAllOpenPositions(): Promise<any[]> {
    return this.getOpenPositions();
  }
}
