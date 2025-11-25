// src/core/data-feed.ts
import { MT5Connector } from "./mt5-connector";
import { Candle } from "../utils/types";

export class DataFeed {
  constructor(private connector: MT5Connector) {}

  async getRecentCandles(symbol: string, timeframe = "M15", count = 500): Promise<Candle[]> {
    const candles = await this.connector.getCandles(symbol, timeframe, count);
    // Ensure they are sorted oldest->newest
    return candles.sort((a: Candle, b: Candle) => a.time - b.time);
  }
}
