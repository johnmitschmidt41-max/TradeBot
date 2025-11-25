
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SymbolConfig = {
  symbol: string;
  timeframe: string; 
};

export type OrderSide = 'BUY' | 'SELL';

export type OrderRequest = {
  symbol: string;
  type: OrderSide;
  volume: number;
  price: number;
  sl?: number;
  tp?: number;
};
