// src/detectors/poi-detector.ts
import { Candle } from "../utils/types";
import { atr, highest, lowest } from "../utils/math";

export type POI = {
  top: number;
  bottom: number;
  touches: number;
  atr: number;
};

export function detectPOI(candles: Candle[], lookback = 100, zoneThicknessATR = 0.25, minTouches = 1): POI | null {
  if (candles.length < lookback) return null;
  const h = highest(candles, lookback);
  const l = lowest(candles, lookback);
  const mid = (h + l) / 2;
  const atrVal = atr(candles, 20) || (h - l) / lookback;
  const halfWidth = atrVal * zoneThicknessATR;
  const top = mid + halfWidth;
  const bottom = mid - halfWidth;

  // Count touches — wick or close enters zone
  let touches = 0;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    const c = candles[i];
    if (c.low <= top && c.high >= bottom) touches++;
  }

  if (touches < minTouches) return null;

  return { top, bottom, touches, atr: atrVal };
}
