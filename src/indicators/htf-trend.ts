import { Candle } from "../utils/types";
import { ema, sma } from "../utils/math";

export type HTFTrend = 'bullish' | 'bearish' | 'neutral';

/**
 * Evaluate a simple MA-based HTF trend (M15) — returns bullish/bearish/neutral.
 * Criteria are intentionally strict: require MA20 > MA50 and higher highs/lows to be bullish.
 */
export function getM15Trend(candles: Candle[]): HTFTrend {
  if (!candles || candles.length < 60) return 'neutral';

  // compute fast/slow MA on M15
  const ma20 = sma(candles.slice(-50), 20); // use sma for HTF smoothing
  const ma50 = sma(candles.slice(-60), 50);
  if (!Number.isFinite(ma20) || !Number.isFinite(ma50)) return 'neutral';

  const lastClose = candles[candles.length - 1].close;

  // bullish: price > ma20 > ma50 and direction making higher highs
  if (lastClose > ma20 && ma20 > ma50) {
    const highs = candles.slice(-10).map(c => c.high);
    if (highs[highs.length - 1] > highs[0]) return 'bullish';
  }

  // bearish: price < ma20 < ma50 and making lower lows
  if (lastClose < ma20 && ma20 < ma50) {
    const lows = candles.slice(-10).map(c => c.low);
    if (lows[lows.length - 1] < lows[0]) return 'bearish';
  }

  return 'neutral';
}

export default getM15Trend;
