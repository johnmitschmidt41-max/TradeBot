// src/strategy/jusdtt-m15.ts
import { DataFeed } from "../core/data-feed";
import { OrderManager } from "../core/order-manager";
import { MT5Connector } from "../core/mt5-connector";
import { STRATEGY_CONFIG } from "../config/strategy";
import { detectPOI } from "../detectors/poi-detector";
import { detectFVG, FVG } from "../detectors/fvg-detector";
import { detectSweeps } from "../detectors/sweep-detector";
import { detectRejection } from "../detectors/rejection-detector";
import { computeVolume, pipValuePerLot, getSymbolMeta } from "../core/position-sizing";
import { persistTradeSignal, persistTradeSignalWithCid, updateSignalByCid, markSignalClosedByDeal } from "../core/trade-storage";
import { scoreWithRemoteModel } from '../core/ai-client';
import { ML_CONFIG } from '../config/strategy';
import { canOpenTrade, logTrade, markOpenPosition, markClosePosition, getTradesTodayCount } from "../core/trade-filter";
import { info, warn, modelDecision } from "../utils/logger";
import { priceToPip } from "../utils/pip";
import { atr, sma, ema } from "../utils/math";
import { Candle } from "../utils/types";
import path from 'path';

const SYMBOLS = ["GBPUSDz", "EURUSDz", "XAUUSDz"];

function mlModeToThreshold(mode?: string | null): number | null {
  if (!mode) return null;
  const m = (mode || '').toString().toLowerCase();
  switch (m) {
    case 'strict': return 0.50;
    case 'medium': return 0.60;
    case 'loose': return 0.70;
    default: return null;
  }
}

export class Strategy {
  dataFeed: DataFeed;
  orderManager: OrderManager;
  private lastDealTimestamp = 0; // epoch seconds - used by deal watcher
  // trading sleep state to avoid spamming logs and to schedule retrains while sleeping
  private isSleeping = false;
  private lastSleepLog = 0; // epoch seconds
  private lastRetrainTriggeredAt = 0; // epoch seconds

  constructor(private connector: MT5Connector) {
    this.dataFeed = new DataFeed(connector);
    this.orderManager = new OrderManager(connector);
  }

  private pickNearestValidFVG(fvgs: FVG[], currentPrice: number, symbol: string, maxDistancePips?: number): (FVG & { distancePips: number; mid: number }) | null {
    if (!fvgs || fvgs.length === 0) return null;

    const scored = fvgs.map(fvg => {
      const mid = (fvg.low + fvg.high) / 2;
      const distancePips = priceToPip(symbol, Math.abs(mid - currentPrice));
      return { ...fvg, mid, distancePips };
    });

    let nearby = scored;
    if (typeof maxDistancePips === "number") {
      nearby = scored.filter(s => s.distancePips <= maxDistancePips);
    }

    if (!nearby || nearby.length === 0) {
      scored.sort((a, b) => a.distancePips - b.distancePips);
      return scored.length > 0 ? scored[0] : null;
    }

    nearby.sort((a, b) => a.distancePips - b.distancePips);
    return nearby[0];
  }

  // --- Helpers for 3-confirmation checks ---
  private isStructureBreak(candles: Candle[], side: 'BUY'|'SELL', lookback = 40): boolean {
    if (!candles || candles.length < 6) return false;
    const recent = candles.slice(-Math.min(candles.length, lookback + 2));
    const latest = recent[recent.length - 1];
    const prev = recent.slice(0, -1);
    if (!prev || prev.length === 0) return false;
    const prevMaxClose = Math.max(...prev.map(c => c.close));
    const prevMinClose = Math.min(...prev.map(c => c.close));
    if (side === 'BUY') {
      // require close beyond the previous closes (not only wick)
      return latest.close > prevMaxClose;
    } else {
      return latest.close < prevMinClose;
    }
  }

  private isLiquidityGrab(recentSweeps: any[], side: 'BUY'|'SELL', minWickPips = 10): boolean {
    if (!recentSweeps || recentSweeps.length === 0) return false;
    
    // liquidity grab detection (improved):
    // 1. Opposite-side sweep with large wick (traditional)
    const opposite = recentSweeps.find(s => s.side !== side && (s.wickLengthPips || 0) >= minWickPips);
    if (opposite) return true;
    
    // 2. Recent sweep on same side with strong wick = liquidity grab
    // This captures scenarios where price draws in opposite-side liquidity then sweeps same-side
    const strongWickSameSide = recentSweeps.slice(-3).find(s => 
      s.side === side && (s.wickLengthPips || 0) >= minWickPips * 1.5
    );
    if (strongWickSameSide) return true;
    
    return false;
  }

  private isFVGDisplacement(candles: Candle[], side: 'BUY'|'SELL', symbol: string, minGapPips = 10): { found: boolean; confidence: number } {
    if (!candles || candles.length < 5) return { found: false, confidence: 0 };
    
    const pipSize = symbol.includes('XAU') || symbol.includes('JPY') ? 0.01 : 0.0001;
    
    // FVG detection: 3-candle pattern with a gap
    // BUY FVG: Close of candle[i] < Low of candle[i+2] (imbalance/gap)
    // SELL FVG: High of candle[i] < Close of candle[i+2] (gap down)
    let bestGapPips = 0;
    let foundFvg = false;
    
    for (let i = Math.max(0, candles.length - 50); i < candles.length - 2; i++) {
      const c1 = candles[i];
      const c2 = candles[i + 1];
      const c3 = candles[i + 2];
      
      if (side === 'BUY') {
        // BUY FVG: gap up (c3.low > c1.high = bullish imbalance)
        if (c3.low > c1.high) {
          const gapSize = c3.low - c1.high;
          const gapPips = gapSize / pipSize;
          if (gapPips >= minGapPips) {
            foundFvg = true;
            bestGapPips = Math.max(bestGapPips, gapPips);
          }
        }
      } else {
        // SELL FVG: gap down (c1.low > c3.high = bearish imbalance)
        if (c1.low > c3.high) {
          const gapSize = c1.low - c3.high;
          const gapPips = gapSize / pipSize;
          if (gapPips >= minGapPips) {
            foundFvg = true;
            bestGapPips = Math.max(bestGapPips, gapPips);
          }
        }
      }
    }
    
    // Confidence increases with gap size
    const confidence = Math.min(1.0, (bestGapPips / 100));
    return { found: foundFvg, confidence };
  }

  private async checkThirdConfirmation(candles: Candle[], side: 'BUY'|'SELL', symbol: string): Promise<boolean> {
    // third confirmation choice per-symbol (EMA or MOMENTUM)
    const symbolKey = symbol; // keys use trailing 'z'
    const confThird = STRATEGY_CONFIG.confirmations.perSymbolThird as any;
    const third = confThird[symbolKey] || 'EMA';
    try {
      if (third === 'EMA') {
        // require EMA9 > EMA20 > EMA50 (bull) or reverse and price beyond EMA200
        const ema9 = ema(candles, 9);
        const ema20 = ema(candles, 20);
        const ema50 = ema(candles, 50);
        const ema200 = ema(candles, 200);
        const last = candles[candles.length - 1].close;
        if (ema9 === 0 || ema20 === 0 || ema50 === 0 || ema200 === 0) return false;
        if (side === 'BUY') return ema9 > ema20 && ema20 > ema50 && last > ema200;
        return ema9 < ema20 && ema20 < ema50 && last < ema200;
      } else {
        // MOMENTUM weakening — check MACD hist trend decreasing and volume declining
        // compute MACD-style histogram (EMA12-EMA26) now and 2 steps back
        if (candles.length < 40) return false;
        const macdNow = ema(candles, 12) - ema(candles, 26);
        const macdPrev = ema(candles.slice(0, -1), 12) - ema(candles.slice(0, -1), 26);
        const macdPrev2 = ema(candles.slice(0, -2), 12) - ema(candles.slice(0, -2), 26);
        // for BUY: momentum weakening = hist decreasing (less positive), for SELL reverse
        const histWeakening = side === 'BUY' ? (macdNow < macdPrev && macdPrev < macdPrev2) : (macdNow > macdPrev && macdPrev > macdPrev2);
        if (!histWeakening) return false;
        // check volume declining in recent bars
        const recentVol = candles.slice(-10).map(c => c.volume || 0);
        const avgVol = recentVol.reduce((a,b) => a + b, 0) / Math.max(1, recentVol.length);
        const lastVol = (candles[candles.length - 1].volume || 0);
        return lastVol <= avgVol * 0.85; // volume has dropped at least 15%
      }
    } catch (e) {
      return false;
    }
  }

  private async attemptHighFreq(symbol: string, timeframe: string) {
    const candles: Candle[] = await this.dataFeed.getRecentCandles(symbol, timeframe, 300);
    if (!candles || candles.length < 50) return;

    const recentSweeps = detectSweeps(candles, STRATEGY_CONFIG.sweep.thresholdPips, symbol).slice(-8);
    if (!recentSweeps || recentSweeps.length === 0) return;

    const latest = recentSweeps[recentSweeps.length - 1];
    const side = latest.side;

    const perCapMap = STRATEGY_CONFIG.highFrequency.perSymbolDailyCap as any;
    const defaultCap = STRATEGY_CONFIG.highFrequency.perSymbolDailyCap?.default || 30;
    const perCap = (perCapMap && perCapMap[symbol]) || defaultCap;
    const todayCount = getTradesTodayCount(symbol);
    if (todayCount >= perCap) {
      info(`${timeframe} skipping ${symbol} because cap reached (${todayCount} >= ${perCap})`);
      return;
    }

    const htf = STRATEGY_CONFIG.highFrequency.htfConfirm || 'M15';
    try {
      const htfCandles = await this.dataFeed.getRecentCandles(symbol, htf, 200);
      if (htfCandles && htfCandles.length > 20 && STRATEGY_CONFIG.filters.trendEnabled) {
        const maShort = sma(htfCandles, STRATEGY_CONFIG.filters.maShort || 50);
        const maLong = sma(htfCandles, STRATEGY_CONFIG.filters.maLong || 200);
        if (maShort === 0 || maLong === 0) return;
        if (side === 'BUY' && maShort <= maLong) return;
        if (side === 'SELL' && maShort >= maLong) return;
      }
    } catch (e:any) {
      const errMsg = e?.message ? e.message : String(e);
      warn(`${timeframe} HTF fetch failed`, errMsg);
      return;
    }

    const currentPrice = candles[candles.length - 1].close;

    if (!await canOpenTrade(this.connector, symbol, side)) return;

    const fvgs = detectFVG(candles, STRATEGY_CONFIG.fvg.minGapPips, symbol);
    const atrVal = atr(candles, 20) || (symbol.includes('XAU') || symbol.includes('JPY') ? 0.01 : 0.0001) * 100;
    const dynamicMaxDistance = Math.max(symbol.includes('XAU') ? 80 : 50, Math.round(priceToPip(symbol, atrVal) * (symbol.includes('XAU') ? 2.5 : 2.0)));
    const candidate = this.pickNearestValidFVG(fvgs, currentPrice, symbol, dynamicMaxDistance);
    if (!candidate) return;

    let entry = (currentPrice >= candidate.low && currentPrice <= candidate.high) ? currentPrice : (side === 'BUY' ? candidate.low : candidate.high);
    const useMarketEntry = (entry === currentPrice);

    const pipSize = (symbol.includes('XAU') || symbol.includes('JPY')) ? 0.01 : 0.0001;
    // Use the exact symbol key (includes trailing 'z'), config keys use 'XAUUSDz', 'GBPUSDz' etc.
    const symbolKey = symbol;
    
    // Find opposite sweep for proper SL placement (NO FALLBACK)
    const oppositeSweepSide = side === 'BUY' ? 'SELL' : 'BUY';
    const oppositeSweep = recentSweeps.find(s => s.side === oppositeSweepSide);
    if (!oppositeSweep) {
      modelDecision(`⛔ ${timeframe} NO OPPOSITE SWEEP FOUND`, { symbol, side, availableSweeps: recentSweeps.map(s => ({ side: s.side, extreme: s.wickExtreme })) });
      return; // Skip if no opposite sweep
    }
    
    const sweepExtreme = oppositeSweep.wickExtreme;
    const configuredBufferPipsHF = (STRATEGY_CONFIG.sl?.pipsBelowSweep && (STRATEGY_CONFIG.sl?.pipsBelowSweep as any)[symbolKey]);
    if (typeof configuredBufferPipsHF !== 'number') {
      info(`${timeframe} missing sl.pipsBelowSweep config for ${symbolKey} — skipping`);
      return;
    }
    const liquidityBuffer = configuredBufferPipsHF * pipSize;
    info(`${timeframe} using sweep SL buffer ${configuredBufferPipsHF} pips (${liquidityBuffer.toFixed(4)} price) for ${symbol}; sweepExtreme=${sweepExtreme.toFixed(symbol.includes('XAU') ? 2 : 5)}`);
    let sl = side === 'BUY' ? sweepExtreme - liquidityBuffer : sweepExtreme + liquidityBuffer;
    
    // --- Enforce 2-signal minimum: MANDATORY = Liquidity Grab + FVG/Displacement
    // BONUS = BOS + Third Confirmation (if present, increases confidence but not required)
    const conf = STRATEGY_CONFIG.confirmations;
    let liquidityConfidence = 0; // 0.5 if liquidity grab found
    let fvgConfidence = 0; // up to 0.3 if FVG/displacement found
    let bosConfidence = 0; // bonus: 0.5 if BOS present
    let thirdConfidenceBonus = 0; // bonus: 0.2 if third confirmation present
    
    if (conf) {
      const sweepThreshold = STRATEGY_CONFIG.sweep.thresholdPips || 10;
      const fvgGapMinPips = STRATEGY_CONFIG.fvg.minGapPips || 10;
      const liqu = this.isLiquidityGrab(recentSweeps, side, sweepThreshold);
      const fvgData = this.isFVGDisplacement(candles, side, symbol, fvgGapMinPips);
      
      // MANDATORY: BOTH Liquidity Grab AND FVG/Displacement required to proceed
      if (!liqu || !fvgData.found) {
        modelDecision('⛔ TRADE SKIPPED - need Liquidity Grab + FVG/Displacement', { 
          symbol, side, 
          liquidityGrab: liqu, 
          fvgDisplacement: fvgData.found
        });
        return;
      }
      
      // Set mandatory signal confidence
      liquidityConfidence = 0.5; // Liquidity Grab found
      fvgConfidence = Math.min(0.3, fvgData.confidence * 0.3); // FVG found
      
      // BONUS signals (optional, increase confidence if present)
      const bos = this.isStructureBreak(candles, side);
      const thirdOk = await this.checkThirdConfirmation(candles, side, symbolKey);
      
      if (bos) {
        bosConfidence = 0.5;
        modelDecision('🟢 BONUS: BOS DETECTED - +0.50 confidence', { symbol, side });
      }
      
      if (thirdOk) {
        thirdConfidenceBonus = 0.2;
        modelDecision('🟢 BONUS: Third Confirmation DETECTED - +0.20 confidence', { symbol, side });
      }
      
      modelDecision('✅ TRADE READY - 2/2 mandatory signals + optional bonuses', { 
        symbol, side,
        mandatory: { liquidity: true, fvg: true },
        bonuses: { bos: bosConfidence > 0, thirdConfirmation: thirdConfidenceBonus > 0 },
        totalConfidence: liquidityConfidence + fvgConfidence + bosConfidence + thirdConfidenceBonus
      });
    }

    const slTpPerSymbol = STRATEGY_CONFIG.slTp.perSymbol as any;
    const slTpConfig = slTpPerSymbol[symbolKey];
    if (!slTpConfig) {
      info(`M5 missing slTp.perSymbol config for ${symbolKey} — skipping`);
      return;
    }
    let slDistance = priceToPip(symbol, Math.abs(entry - sl));
    // Use FIXED TP from config, not derived from SL distance (prevents runaway TP)
    let tpDistancePips = slTpConfig.tpPips;
    let tp = side === 'BUY' ? entry + (tpDistancePips * pipSize) : entry - (tpDistancePips * pipSize);
    // enforce per-symbol min/max SL caps (don't silently fall back if there's no sweep)
    try {
      const slCapsConfig = STRATEGY_CONFIG.sl.perSymbolCaps as any;
      const caps = slCapsConfig[symbolKey] || {};
      const minCap = Math.max(configuredBufferPipsHF, (caps.minPips || configuredBufferPipsHF));
      const maxCap = caps.maxPips || Number.POSITIVE_INFINITY;

      if (slDistance < minCap) {
        // widen SL to minimum cap rather than skipping entirely
        modelDecision('🔧 M5 SL ADJUSTED - widened to min cap', { symbol, side, oldSl: slDistance, newSl: minCap });
        slDistance = minCap;
        sl = side === 'BUY' ? entry - (slDistance * pipSize) : entry + (slDistance * pipSize);
      }

      if (slDistance > maxCap) {
        // cap excessive SLs so we don't produce runaway SLs
        modelDecision('🔧 M5 SL CAPPED - reduced to max cap', { symbol, side, oldSl: slDistance, newSl: maxCap });
        slDistance = maxCap;
        sl = side === 'BUY' ? entry - (slDistance * pipSize) : entry + (slDistance * pipSize);
      }

      // Update TP calculation to respect configured minRR and an optional maxRR bound
      const minRR = STRATEGY_CONFIG.tp.minRR || 1.5;
      const maxRR = STRATEGY_CONFIG.tp.maxRR || 10;
      tpDistancePips = Math.max(slTpConfig.tpPips, slDistance * minRR);
      tpDistancePips = Math.min(tpDistancePips, slDistance * maxRR);
      tp = side === 'BUY' ? entry + (tpDistancePips * pipSize) : entry - (tpDistancePips * pipSize);
    } catch (e:any) {
      // if caps lookup fails, continue using calculated distances
    }

    const accountInfo = await this.connector.getAccountInfo();
    const accountBalance = accountInfo?.balance || 100;
    let lots = computeVolume(accountBalance, STRATEGY_CONFIG.risk.riskPercent, slDistance, symbol);
    const scalingFactor = STRATEGY_CONFIG.risk.scalingFactor || 1;
    const m5ScalingFactor = STRATEGY_CONFIG.highFrequency.m5ScalingFactor || 0.3;
    lots = Math.round((lots * scalingFactor * m5ScalingFactor) * 100) / 100;
    if (lots < 0.01) return;

    if (ML_CONFIG?.enabled) {
      try {
        // Enhanced payload with confidence signals from Liquidity Grab + FVG/Displacement
        const enhancedPayload = {
          symbol, side, entry, sl, tp, lots, accountBalance, slPips: slDistance,
          // NEW: Confidence signals (used by Gemini 3 Pro as additional context)
          technicalConfidence: Math.min(1.0, bosConfidence + liquidityConfidence + fvgConfidence),
          hasLiquidityGrab: liquidityConfidence > 0,
          hasFVGDisplacement: fvgConfidence > 0,
          hasBOS: bosConfidence > 0
        };
        
        const score = await scoreWithRemoteModel(enhancedPayload);
        const modeThr = mlModeToThreshold(ML_CONFIG.gatingMode);
        const hfMax = STRATEGY_CONFIG.highFrequency.mlMaxLossProb || modeThr || ML_CONFIG.declineLossProb || 0.6;
        const thr = hfMax;

        // If model flags high loss prob, attempt SL refinement using historical data
        if (!score || typeof score.lossProb !== 'number') return;
        if (score.lossProb > thr) {
          // attempt entry refinement first (for LIMIT-style entries) to see if moving entry closer
          // or using FVG midpoint would improve model score
          if (!useMarketEntry) {
            try {
              const closerEntry = entry + (currentPrice - entry) * 0.5;
              const closerSlDistance = priceToPip(symbol, Math.abs(closerEntry - sl));
              const minRRVal = STRATEGY_CONFIG.tp.minRR || 1.5;
              const closerTpDistance = Math.max(slTpConfig.tpPips, closerSlDistance * minRRVal);
              const closerTp = side === 'BUY' ? closerEntry + (closerTpDistance * pipSize) : closerEntry - (closerTpDistance * pipSize);
              const closerScore = await scoreWithRemoteModel({ 
                symbol, side, entry: closerEntry, sl, tp: closerTp, lots, accountBalance, slPips: closerSlDistance,
                technicalConfidence: Math.min(1.0, bosConfidence + liquidityConfidence + fvgConfidence),
                hasLiquidityGrab: liquidityConfidence > 0,
                hasFVGDisplacement: fvgConfidence > 0,
                hasBOS: bosConfidence > 0
              });
              if (closerScore && typeof closerScore.lossProb === 'number' && closerScore.lossProb <= thr) {
                modelDecision('🔧 M5 ENTRY REFINED - closerEntry accepted', { symbol, side, oldEntry: entry, newEntry: closerEntry, oldLoss: score.lossProb, newLoss: closerScore.lossProb });
                entry = closerEntry; slDistance = closerSlDistance; tp = closerTp; tpDistancePips = closerTpDistance;
              } else if (typeof candidate?.mid === 'number') {
                const midEntry = candidate.mid;
                const midSlDistance = priceToPip(symbol, Math.abs(midEntry - sl));
                const midTpDistance = Math.max(slTpConfig.tpPips, midSlDistance * minRRVal);
                const midTp = side === 'BUY' ? midEntry + (midTpDistance * pipSize) : midEntry - (midTpDistance * pipSize);
                const midScore = await scoreWithRemoteModel({ 
                  symbol, side, entry: midEntry, sl, tp: midTp, lots, accountBalance, slPips: midSlDistance,
                  technicalConfidence: Math.min(1.0, bosConfidence + liquidityConfidence + fvgConfidence),
                  hasLiquidityGrab: liquidityConfidence > 0,
                  hasFVGDisplacement: fvgConfidence > 0,
                  hasBOS: bosConfidence > 0
                });
                if (midScore && typeof midScore.lossProb === 'number' && midScore.lossProb <= thr) {
                  modelDecision('🔧 M5 ENTRY REFINED - midEntry accepted', { symbol, side, oldEntry: entry, newEntry: midEntry, oldLoss: score.lossProb, newLoss: midScore.lossProb });
                  entry = midEntry; slDistance = midSlDistance; tp = midTp; tpDistancePips = midTpDistance;
                }
              }
            } catch (e:any) {
              const errMsg = e?.message ? e.message : String(e);
              warn('M5 entry refinement failed', errMsg);
            }
          }
          // load analyzer
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { analyzeSlHitPattern } = require('../core/trade-storage');
            const fastSecs = 3 * 60 * 5; // for M5: 3 * 5min bars = 15min
            const stats = analyzeSlHitPattern(symbol, side, slDistance, { tolerancePercent: 0.2, lookback: 300, fastSecs, minSample: 6 });
            modelDecision('🔎 M5 model flagged; SL pattern stats', { symbol, side, lossProb: score.lossProb, thr, slDistance, stats });

            // if many similar SLs were hit quickly historically, try widening instead of immediate reject
            if (stats.sampleCount >= 6 && stats.fastHitRate >= 0.5) {
              const widenFactor = 1 + Math.min(1.0, stats.fastHitRate); // up to x2
              const newSlDistance = Math.max(Math.ceil(slDistance * widenFactor), slDistance + 1);
              const newSl = side === 'BUY' ? entry - (newSlDistance * pipSize) : entry + (newSlDistance * pipSize);
              const minRRVal = STRATEGY_CONFIG.tp.minRR || 1.5;
              const newTpDistancePips = Math.max(slTpConfig.tpPips, newSlDistance * minRRVal);
              const newTp = side === 'BUY' ? entry + (newTpDistancePips * pipSize) : entry - (newTpDistancePips * pipSize);

              // re-score with widened SL
              const secondScore = await scoreWithRemoteModel({ 
                symbol, side, entry, sl: newSl, tp: newTp, lots, accountBalance, slPips: newSlDistance,
                technicalConfidence: Math.min(1.0, bosConfidence + liquidityConfidence + fvgConfidence),
                hasLiquidityGrab: liquidityConfidence > 0,
                hasFVGDisplacement: fvgConfidence > 0,
                hasBOS: bosConfidence > 0
              });
              if (secondScore && typeof secondScore.lossProb === 'number' && secondScore.lossProb <= thr) {
                // adopt widened SL
                modelDecision('🔧 M5 SL REFINED - accepted after widening', { symbol, side, oldLossProb: score.lossProb, newLossProb: secondScore.lossProb, oldSl: slDistance, newSl: newSlDistance });
                // adopt refined values locally for this placement
                sl = newSl;
                slDistance = newSlDistance;
                tp = newTp;
                tpDistancePips = newTpDistancePips;
              } else {
                modelDecision('❌ M5 REJECTED - high lossProb even after refinement', { symbol, side, lossProb: score.lossProb, thr, sampleStats: stats });
                return;
              }
            } else {
              modelDecision('❌ M5 REJECTED - high lossProb', { symbol, side, lossProb: score.lossProb, thr, sampleStats: stats });
              return;
            }
          } catch (e:any) {
            // if analyzer fails, fall back to rejecting to be safe
            const errMsg = e?.message ? e.message : String(e);
            modelDecision('❌ M5 REJECTED - scoring and analyzer failed or returned no conf', { symbol, side, lossProb: score.lossProb, thr, error: errMsg });
            return;
          }
        }
      } catch (e:any) {
        const errMsg = e?.message ? e.message : String(e);
        warn('M5 scoring failed', errMsg);
        return;
      }
    }

    let cid: string | null = null;
    try {
      const modelFeatures = {
        entry: +entry,
        price: +entry,
        sl: +sl,
        tp: +tp,
        lots,
        accountBalance,
        slPips: priceToPip(symbol, Math.abs(entry - sl)),
        tpPips: priceToPip(symbol, Math.abs(tp - entry)),
        fvgDistancePips: +(candidate?.distancePips || 0),
        dynamicMaxDistance: +dynamicMaxDistance
      } as any;

      // confirmation state if available
      const confirmations = {
        count: undefined as number | undefined,
        list: [] as string[],
        bos: undefined as boolean | undefined,
        liquidityGrab: undefined as boolean | undefined,
        third: undefined as any
      };
      try {
        const confCfg = STRATEGY_CONFIG.confirmations;
        if (confCfg && (confCfg.minimumConfirmations || 0) >= 3) {
          const bos = this.isStructureBreak(candles, side);
          const sweepThreshold = STRATEGY_CONFIG.sweep.thresholdPips || 10;
          const liqu = this.isLiquidityGrab(recentSweeps, side, sweepThreshold);
          const perSymbolThird = confCfg.perSymbolThird as any;
          const thirdType = (perSymbolThird && perSymbolThird[symbol]) || 'EMA';
          const thirdOk = await this.checkThirdConfirmation(candles, side, symbol);
          confirmations.count = (bos ? 1 : 0) + (liqu ? 1 : 0) + (thirdOk ? 1 : 0);
          confirmations.list = [];
          if (bos) { confirmations.list.push('BOS'); confirmations.bos = true; }
          if (liqu) { confirmations.list.push('LIQUIDITY_GRAB'); confirmations.liquidityGrab = true; }
          confirmations.third = { type: thirdType, ok: thirdOk };
        }
      } catch (e) {}

      cid = persistTradeSignalWithCid({ time: Math.floor(Date.now()/1000), symbol, side, orderType: 'MARKET', entry: +entry, price: +entry, sl: +sl, tp: +tp, lots, status: 'placed', modelFeatures, confirmations });
    } catch (e) {}

    // Trade approved by 2-signal system (Liquidity + FVG). Logging removed to avoid confusion.

    // Round SL/TP to proper decimal places (JPY pairs=2, others=5)
    const decimalPlaces = symbol.includes('JPY') ? 2 : 5;
    const roundedSl = Math.round(sl * Math.pow(10, decimalPlaces)) / Math.pow(10, decimalPlaces);
    const roundedTp = Math.round(tp * Math.pow(10, decimalPlaces)) / Math.pow(10, decimalPlaces);

    try {
      const params: any = { symbol, type: side as 'BUY'|'SELL', volume: lots, sl: roundedSl, tp: roundedTp };
      if (cid) params.comment = cid;
      info('📊 Placing MARKET order', { symbol, side, entry: entry.toFixed(symbol.includes('JPY') ? 2 : 5), volume: lots, sl: roundedSl, tp: roundedTp, comment: cid });
      const res = await this.orderManager.placeMarketOrder(params);
      if (res?.success) {
        try {
          if (cid) updateSignalByCid(cid, { order: res.order, deal: res.deal });
        } catch (e:any) {
          const errMsg = e?.message ? e.message : String(e);
          warn('Failed to attach order id for M5 signal', errMsg);
        }
        markOpenPosition(symbol, side);
        logTrade(symbol, side);
        info(`M5 placed ${symbol} ${side} lots=${lots}`);
      }
    } catch (e:any) {
      const errMsg = e?.message ? e.message : String(e);
      warn('M5 place order failed', errMsg);
    }
  }

  async scanAndAct() {

    // Check for recently closed deals and persist their results for training data
    try {
      await this.checkAndPersistClosedDeals();
    } catch (err:any) {
      // swallow - we don't want to block scanning if deal watcher fails
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatError } = require('../utils/error');
      warn('Deal watcher error', formatError(err));
    }
    // Trading schedule gating (if enabled): pause trading during configured sleep window
    try {
      const sched = (STRATEGY_CONFIG as any).tradingSchedule;
      if (sched?.enabled) {
        const now = new Date();
        const offset = Number(sched.timezoneOffsetHours || 0);
        const local = new Date(now.getTime() + offset * 3600 * 1000);
        const mins = local.getUTCHours() * 60 + local.getUTCMinutes();

        const parseHHMM = (s: string) => {
          const parts = (s || '').split(':');
          const hh = Number(parts[0] || 0);
          const mm = Number(parts[1] || 0);
          return hh * 60 + mm;
        };

        const from = parseHHMM(String(sched.sleepFrom));
        const to = parseHHMM(String(sched.sleepTo));
        const inSleep = from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
        const nowSec = Math.floor(Date.now() / 1000);

        if (inSleep) {
          if (!this.isSleeping) {
            this.isSleeping = true;
            this.lastSleepLog = nowSec;
            const resumeMinutes = to >= mins ? (to - mins) : (24 * 60 - mins + to);
            const hours = Math.floor(resumeMinutes / 60);
            const minutes = resumeMinutes % 60;
            const countdown = `${hours}h ${minutes}m`;
            try { info(String(sched.sleepMessage || 'Bot is sleeping but resumption in %s').replace('%s', countdown)); } catch {}
            try {
              const { triggerRetrainIfNeeded } = require('../core/retrainer');
              if (nowSec - this.lastRetrainTriggeredAt > 60 * 60) {
                const signalsPath = path.join(__dirname, '..', '..', 'data', 'output', 'trade_signals.jsonl');
                triggerRetrainIfNeeded(signalsPath);
                this.lastRetrainTriggeredAt = nowSec;
              }
            } catch (_e:any) {}
          } else {
            if (nowSec - this.lastSleepLog > 60 * 10) {
              this.lastSleepLog = nowSec;
              const resumeMinutes = to >= mins ? (to - mins) : (24 * 60 - mins + to);
              const hours = Math.floor(resumeMinutes / 60);
              const minutes = resumeMinutes % 60;
              const countdown = `${hours}h ${minutes}m`;
              try { info(String(sched.sleepMessage || 'Bot is sleeping but resumption in %s').replace('%s', countdown)); } catch {}
            }
            if (nowSec - this.lastRetrainTriggeredAt > 60 * 60) {
              try {
                const { triggerRetrainIfNeeded } = require('../core/retrainer');
                const signalsPath = path.join(__dirname, '..', '..', 'data', 'output', 'trade_signals.jsonl');
                triggerRetrainIfNeeded(signalsPath);
                this.lastRetrainTriggeredAt = nowSec;
              } catch (_e:any) {}
            }
          }
        } else {
          if (this.isSleeping) {
            this.isSleeping = false;
            try { info(String(sched.resumeMessage || 'Bot Trading is Back on')); } catch {}
          }
        }

        // if currently sleeping -> skip trading operations (but we already processed closed deals above)
        if (this.isSleeping) return;
      }
    } catch (e) {
      // ignore schedule errors
    }

    for (const symbol of SYMBOLS) {
      try {
        // If high-frequency mode is enabled, attempt each timeframe (M1, M3, M5)
        if (STRATEGY_CONFIG.highFrequency.enabled) {
          const timeframes = (STRATEGY_CONFIG.highFrequency as any).timeframes || ['M5'];
          for (const tf of timeframes) {
            try {
              await this.attemptHighFreq(symbol, tf);
            } catch (err:any) {
              const errMsg = err?.message ? err.message : String(err);
              warn(`${tf} pass error`, errMsg);
            }
          }
        }

        // Skip M15 trading (disabled - only M1, M3, M5 enabled)
        if (STRATEGY_CONFIG.timeframe === 'M15') {
          continue;
        }

        const candles: Candle[] = await this.dataFeed.getRecentCandles(symbol, STRATEGY_CONFIG.timeframe, 500);
        if (!candles || candles.length < 50) {
          const candleLen = candles?.length || 0;
          info(`Insufficient candles for ${symbol} (have=${candleLen}). Skipping.`);
          continue;
        }

        const currentCandle = candles[candles.length - 1];
        const currentPrice = currentCandle.close;
        const pipSize = (symbol.includes('XAU') || symbol.includes('JPY')) ? 0.01 : 0.0001;

        const poi = detectPOI(candles, STRATEGY_CONFIG.lookback, STRATEGY_CONFIG.poi.zoneThicknessATR, STRATEGY_CONFIG.poi.minTouches);
        const fvgs = detectFVG(candles, STRATEGY_CONFIG.fvg.minGapPips, symbol);
        const sweeps = detectSweeps(candles, STRATEGY_CONFIG.sweep.thresholdPips, symbol);
        const rejections = detectRejection(candles, STRATEGY_CONFIG.rejection.wickPercent, STRATEGY_CONFIG.rejection.bodyPercent);

        // Early liquidity indicator — ATR in pips (used by liquidity filter below)
        const atrVal = atr(candles, 20) || pipSize * 100;
        const atrPips = priceToPip(symbol, atrVal);

        const recentSweeps = sweeps.slice(-10);
        if (recentSweeps.length === 0) {
          info(`No recent sweeps found for ${symbol} — strategy skipping.`);
          continue;
        }
        
        // --- Trend and Liquidity Filters ---
        const filters = STRATEGY_CONFIG.filters as any;
        
        // Determine preferred side based on trend (uptrend=BUY, downtrend=SELL)
        let preferredSide: 'BUY' | 'SELL' | null = null;
        if (filters.trendEnabled) {
          try {
            const trendTf = filters.trendTimeframe || 'M5';
            const trendCandles = await this.dataFeed.getRecentCandles(symbol, trendTf, 200);
            if (trendCandles && trendCandles.length > 50) {
              const maShort = sma(trendCandles, filters.maShort || 20);
              const maLong = sma(trendCandles, filters.maLong || 50);
              if (maShort > maLong) {
                preferredSide = 'BUY';  // Uptrend: prefer BUYs
              } else if (maShort < maLong) {
                preferredSide = 'SELL'; // Downtrend: prefer SELLs
              }
            }
          } catch (e: any) {
            const errMsg = e?.message ? e.message : String(e);
            warn(`Trend fetch failed for ${symbol}`, errMsg);
          }
        }

        // Find sweep matching preferred side, or fall back to latest sweep
        let latestSweep = recentSweeps[recentSweeps.length - 1];
        if (preferredSide) {
          const matchingSweep = recentSweeps.reverse().find(s => s.side === preferredSide);
          if (matchingSweep) {
            latestSweep = matchingSweep;
            info(`Trend-aligned: using ${preferredSide} sweep for ${symbol}`);
          } else {
            // Fall back if no matching sweep
            info(`No ${preferredSide} sweep available, using latest sweep (${latestSweep.side})`);
          }
        }
        
        const side = latestSweep.side;
        const bias = side === 'BUY' ? 'BULL' : 'BEAR';

        const allowed = await canOpenTrade(this.connector, symbol, side);
        if (!allowed) {
          info(`trade blocked by filter for ${symbol} ${side}`);
          continue;
        }

        if (filters.liquidityEnabled) {
          // require a minimum ATR and reasonable recent tick volume
          const recentVol = candles.slice(-50).map(c => c.volume);
          const avgVol = recentVol.reduce((a, b) => a + b, 0) / Math.max(1, recentVol.length);
          const currVol = currentCandle.volume || 0;

          const minAtrXau = filters.minAtrPipsXAU || 30;
          const minAtrFx = filters.minAtrPipsFX || 2.5;
          const minAtr = symbol.includes('XAU') ? minAtrXau : minAtrFx;
          if (atrPips < minAtr) {
            info(`Low liquidity (ATR ${atrPips.toFixed(1)} pips < min ${minAtr}) — skipping ${symbol}`);
            continue;
          }

          // Low volume check removed - let the model decide if low volume trades are profitable
        }

        // ✅ CHECK IF POSITION OR PENDING ORDER ALREADY EXISTS
        const openPositions = await this.connector.getOpenPositions(symbol);
        const pendingOrders = await this.connector.getPendingOrders(symbol);

        const hasOpenPosition = openPositions.some((pos: any) => pos.type === side);
        const hasPendingOrder = pendingOrders.some((order: any) => order.type === side);
        const oppositeOpen = openPositions.some((pos: any) => pos.type !== side);
        const oppositePending = pendingOrders.some((order: any) => order.type !== side);

        if (oppositeOpen) {
          info(`Opposite-side position already running for ${symbol}. Skipping.`);
          continue;
        }

        if (oppositePending) {
          info(`Opposite-side pending order already exists for ${symbol}. Skipping.`);
          continue;
        }

        if (hasOpenPosition) {
          info(`Already have open ${side} position on ${symbol}. Skipping.`);
          continue;
        }

        if (hasPendingOrder) {
          info(`Already have pending ${side} limit order on ${symbol}. Skipping.`);
          continue;
        }

        // --- ATR-based dynamic distance cap ---

        const baseMin = symbol.includes('XAU') ? 80 : 50;
        const scale = symbol.includes('XAU') ? 2.5 : 2.0;
        const dynamicMaxDistance = Math.max(baseMin, Math.round(atrPips * scale));

        const recentFVGs = fvgs.slice(-40);
        const sameBiasFVGs = recentFVGs.filter(f => (bias === 'BULL' ? f.side === 'BULL' : f.side === 'BEAR'));

        const candidate = this.pickNearestValidFVG(sameBiasFVGs, currentPrice, symbol, dynamicMaxDistance);
        if (!candidate) {
          info(`No nearby FVG within ${dynamicMaxDistance} pips for ${symbol}. Skipping.`);
          continue;
        }

        const candidateFVG = { high: candidate.high, low: candidate.low, index: candidate.index };
        const fvgHigh = candidateFVG.high;
        const fvgLow = candidateFVG.low;
        const fvgMid = candidate.mid;

        const distanceToFVG = candidate.distancePips;
        const insideTolerancePips = 3;
        const insideTolerancePrice = insideTolerancePips * pipSize;

        let entry: number;
        let useMarketOrder = false;

        if (currentPrice >= fvgLow - insideTolerancePrice && currentPrice <= fvgHigh + insideTolerancePrice) {
          info(`✅ Price INSIDE or very near FVG (${distanceToFVG.toFixed(1)} pips). Using MARKET order.`);
          entry = currentPrice;
          useMarketOrder = true;
        } else {
          // Check if FVG is in the right direction for a limit order
          if (bias === 'BULL') {
            // For BUY: FVG low should be below current price for a valid limit
            if (fvgLow >= currentPrice) {
              // FVG is above price - switch to MARKET order at current price
              entry = currentPrice;
              useMarketOrder = true;
            } else {
              entry = fvgLow;
            }
          } else {
            // For SELL: FVG high should be above current price for a valid limit
            if (fvgHigh <= currentPrice) {
              // FVG is below price - switch to MARKET order at current price
              entry = currentPrice;
              useMarketOrder = true;
            } else {
              entry = fvgHigh;
            }
          }

          if (!useMarketOrder) {
            const distanceToEntry = priceToPip(symbol, Math.abs(entry - currentPrice));

            if (distanceToEntry > dynamicMaxDistance) {
              info(`🕐 Nearest FVG too far (${distanceToEntry.toFixed(1)} pips, limit ${dynamicMaxDistance}). Waiting.`);
              continue;
            }

            info(`📍 Nearest FVG ${distanceToEntry.toFixed(1)} pips away. Placing LIMIT order.`);
          }
        }

          // Use the exact symbol key (config now uses keys with trailing 'z')
          const symbolKey = symbol;

        // --- Enforce 3-confirmation rule if configured
        const conf = STRATEGY_CONFIG.confirmations;
        if (conf && (conf.minimumConfirmations || 0) >= 3) {
          const bos = this.isStructureBreak(candles, side);
          const sweepThreshold = STRATEGY_CONFIG.sweep.thresholdPips || 10;
          const liqu = this.isLiquidityGrab(recentSweeps, side, sweepThreshold);
          const thirdOk = await this.checkThirdConfirmation(candles, side, symbolKey);
          if (!bos || !liqu || !thirdOk) {
            modelDecision('⛔ M15 SKIPPED - failing confirmations', { symbol, side, bos, liquidityGrab: liqu, thirdOk });
            continue;
          }
          // ✅ All confirmations passed - log the passing state for transparency
          modelDecision('✅ M15 CONFIRMATIONS PASS - proceeding', { symbol, side, bos, liquidityGrab: liqu, thirdOk });
        }
        const slTpPerSymbol = STRATEGY_CONFIG.slTp.perSymbol as any;
        const slTpConfig = slTpPerSymbol[symbolKey];
        if (!slTpConfig) {
          info(`Missing slTp.perSymbol config for ${symbolKey} — skipping`);
          continue;
        }
        
        // ✅ LIQUIDITY-BASED SL: REQUIRED - Place beyond the OPPOSITE sweep extreme
        let slPrice: number;
        let slDistance: number;
        
        // For SL, find the opposite sweep (SELL sweep for BUY trades, BUY sweep for SELL trades)
        const oppositeSweepSide = side === 'BUY' ? 'SELL' : 'BUY';
        const oppositeSweep = recentSweeps.find(s => s.side === oppositeSweepSide);
        
        // NO FALLBACK - Require opposite sweep to exist
        if (!oppositeSweep) {
          info(`No ${oppositeSweepSide} sweep found for SL placement on ${symbol} ${side}. Skipping.`);
          continue;
        }
        
        const sweepExtreme = oppositeSweep.wickExtreme;
        // use configured pips buffer for SL beyond sweep (per-symbol), fallback to sensible defaults
        const configuredBufferPips = (STRATEGY_CONFIG.sl?.pipsBelowSweep && (STRATEGY_CONFIG.sl?.pipsBelowSweep as any)[symbolKey]);
        if (typeof configuredBufferPips !== 'number') {
          info(`Missing sl.pipsBelowSweep config for ${symbolKey} — skipping`);
          continue;
        }
        const liquidityBuffer = configuredBufferPips * pipSize; // buffer based on config (pips)
        info(`Using sweep SL buffer ${configuredBufferPips} pips (${liquidityBuffer.toFixed(4)} price) for ${symbol}`);
        
        if (side === 'BUY') {
          // BUY: SL goes below the SELL sweep low (where sellers were trapped)
          slPrice = sweepExtreme - liquidityBuffer;
        } else {
          // SELL: SL goes above the BUY sweep high (where buyers were trapped)
          slPrice = sweepExtreme + liquidityBuffer;
        }
        slDistance = priceToPip(symbol, Math.abs(entry - slPrice));

        // ✅ TP: Use R:R ratio from SL distance
        const tpPips = slTpConfig.tpPips;
        const minRRVal = STRATEGY_CONFIG.tp.minRR || 1.5;
        const tpDistancePips = Math.max(tpPips, slDistance * minRRVal);
        
        let tpPrice = side === 'BUY'
          ? entry + (tpDistancePips * pipSize)
          : entry - (tpDistancePips * pipSize);

        let tpDistance = tpDistancePips;

        // Reject if SL would be too close; enforce per-symbol minimum using same configured value
        // enforce per-symbol min/max SL caps and prefer moderate SLs (not too tight, not runaway)
        try {
          const slCapsConfig = STRATEGY_CONFIG.sl.perSymbolCaps as any;
          const caps = slCapsConfig[symbolKey] || {};
          const minCap = Math.max(configuredBufferPips, (caps.minPips || configuredBufferPips));
          const maxCap = caps.maxPips || Number.POSITIVE_INFINITY;

          if (slDistance < minCap) {
            modelDecision('🔧 M15 SL ADJUSTED - widened to min cap', { symbol, side, oldSl: slDistance, newSl: minCap });
            slDistance = minCap;
            slPrice = side === 'BUY' ? entry - (slDistance * pipSize) : entry + (slDistance * pipSize);
          }

          if (slDistance > maxCap) {
            modelDecision('🔧 M15 SL CAPPED - reduced to max cap', { symbol, side, oldSl: slDistance, newSl: maxCap });
            slDistance = maxCap;
            slPrice = side === 'BUY' ? entry - (slDistance * pipSize) : entry + (slDistance * pipSize);
          }

          // cap TP by a maxRR so we don't produce absurd 50x RRs
          const minRRVal2 = STRATEGY_CONFIG.tp.minRR || 1.5;
          const maxRRVal = STRATEGY_CONFIG.tp.maxRR || 10;
          const computedTp = Math.max(slTpConfig.tpPips, slDistance * minRRVal2);
          const cappedTp = Math.min(computedTp, slDistance * maxRRVal);
          tpDistance = cappedTp;
          tpPrice = side === 'BUY' ? entry + (tpDistance * pipSize) : entry - (tpDistance * pipSize);
        } catch (e) {
          // if caps lookup fails use the previously calculated values
        }

        // ✅ FIX: Use real account balance for position sizing
        const accountInfo = await this.connector.getAccountInfo();
        const accountBalance = accountInfo?.balance || 100;
        
        // ✅ Calculate base lot size using configured risk
        const baseLots = computeVolume(accountBalance, STRATEGY_CONFIG.risk.riskPercent, slDistance, symbol);
        const scaleFactor = STRATEGY_CONFIG.risk.scalingFactor || 1;
        // apply scaling factor
        let lots = Math.round(baseLots * scaleFactor * 100) / 100;

        // Debug: show sizing inputs so operator can trace why some signals produce lots < 0.01
        info('sizing debug', { symbol, accountBalance, slDistance, tpDistance, baseLots, scaleFactor });

        // Safety clamp: ensure final risk (lots * riskPerLotUSD) never exceeds configured riskUSD
        const pipValue = pipValuePerLot(symbol);
        const riskUSD = accountBalance * (STRATEGY_CONFIG.risk.riskPercent / 100);
        const riskPerLotUSD = Math.max(0.0000001, slDistance * pipValue);
        const maxLotsByRisk = Math.floor((riskUSD / riskPerLotUSD) * 100) / 100;

        // ALSO clamp by broker margin availability (if available)
        // determine free margin robustly (bridge may use different field names)
        let freeMargin = (accountInfo?.free_margin || accountInfo?.freeMargin);
        if (typeof freeMargin !== 'number') {
          // fallback: try equity - margin (both commonly available)
          const equity = (accountInfo?.equity || accountInfo?.Equity || accountInfo?.balance || 0) as number;
          const usedMargin = (accountInfo?.margin || accountInfo?.used_margin || accountInfo?.Margin || 0) as number;
          freeMargin = Math.max(0, equity - usedMargin);
        }
        freeMargin = freeMargin || 0;
        const leverage = (accountInfo?.leverage) || (STRATEGY_CONFIG.risk.defaultLeverage || 100);

        // compute margin required per single lot: contractSize * entryPrice / leverage
        const { contractSize } = getSymbolMeta(symbol);
        const marginPerLot = Math.max(0.0000001, (contractSize * entry) / leverage);
        const maxLotsByMargin = Math.floor((freeMargin / marginPerLot) * 100) / 100 || 0;

        // if margin is insufficient to reach desired risk, we clamp and log a warning
        if (maxLotsByMargin < maxLotsByRisk) {
          warn(`Margin-limited: freeMargin=${freeMargin.toFixed(2)}, leverage=${leverage}, marginPerLot=${marginPerLot.toFixed(2)}, maxLotsByMargin=${maxLotsByMargin}`);
        }

        // clamp to risk-based maximum and margin-based maximum
        const beforeClamp = lots;
        lots = Math.min(lots, maxLotsByRisk, maxLotsByMargin || 0);

        // Debug: show detailed sizing values to diagnose why risk-based cap was zero
        info('sizing debug', { symbol, accountBalance, slDistance, tpDistance, baseLots, scaleFactor, beforeClamp, maxLotsByRisk, maxLotsByMargin, finalLotsBeforeMin: lots });

        // Optional override: allow opening when maxByRisk==0 but baseLots > 0
        const allowRiskOverride = STRATEGY_CONFIG.risk?.allowNonZeroLotsEvenIfRiskZero === true
          || process.env.DEBUG_RISK_OVERRIDE === 'true'
          || process.env.PAPER_MODE === 'true';

        if (lots <= 0 && allowRiskOverride && baseLots > 0) {
          // honor margin cap but ignore risk cap
          lots = Math.min(baseLots, maxLotsByMargin || baseLots);
          info('risk override applied - using baseLots despite maxByRisk=0', { symbol, baseLots, lots, maxLotsByMargin });
        }

        // If margin prevents any meaningful lot, skip the trade
        if (lots < 0.01) {
          warn(`Cannot meet risk target: computed lots < 0.01 (maxByRisk=${maxLotsByRisk}, maxByMargin=${maxLotsByMargin}). Skipping.`);
          continue;
        }

        // global cap from config (safety)
        const globalMax = STRATEGY_CONFIG.risk.maxLots || 50;
        lots = Math.min(Math.max(lots, 0.01), globalMax);

        // Persist the proposed signal (with a client id) before trying to place —
        // we will attach broker order/deal ids after placement to enable
        // deterministic matching later.
        let cid: string | null = null;
        try {
          // Build a modelFeatures snapshot and confirmation metadata for traceability / training
          const modelFeaturesMain = {
            entry: +entry,
            price: useMarketOrder ? currentPrice : entry,
            sl: +slPrice,
            tp: +tpPrice,
            lots,
            accountBalance: accountBalance,
            slPips: +slDistance,
            tpPips: +tpDistance,
            fvgDistancePips: +distanceToFVG,
            dynamicMaxDistance: +dynamicMaxDistance
          } as any;

          const confirmationsMain: any = ((): any => {
            try {
              const confCfg = (STRATEGY_CONFIG as any).confirmations ?? null;
              if (!confCfg || (confCfg.minimumConfirmations ?? 0) < 3) return {};
              const bos = this.isStructureBreak(candles, side);
              const liqu = this.isLiquidityGrab(recentSweeps, side, STRATEGY_CONFIG.sweep?.thresholdPips ?? 10);
              const thirdType = confCfg.perSymbolThird?.[symbol] ?? 'EMA';
              // NOTE: checkThirdConfirmation is async; for persistence we sample now synchronously using current check
              // (strategy already validated earlier) - call quickly
              return { count: (bos?1:0)+(liqu?1:0), list: [ bos ? 'BOS' : null, liqu ? 'LIQUIDITY_GRAB' : null ].filter(Boolean), bos, liquidityGrab: liqu, third: { type: thirdType } };
            } catch (e) { return {}; }
          })();

          cid = persistTradeSignalWithCid({
            time: Math.floor(Date.now() / 1000),
            symbol,
            side,
            orderType: useMarketOrder ? 'MARKET' : 'LIMIT',
            entry: +entry,
            price: useMarketOrder ? currentPrice : entry,
            sl: +slPrice,
            tp: +tpPrice,
            lots,
            accountBalance: accountBalance,
            fvgDistancePips: +distanceToFVG,
            slPips: +slDistance,
            tpPips: +tpDistance,
            dynamicMaxDistance: +dynamicMaxDistance,
            detectors: { poi: !!poi, fvgCount: fvgs.length, sweeps: recentSweeps.length, rejections: rejections.length },
            status: 'placed',
            modelFeatures: modelFeaturesMain,
            confirmations: confirmationsMain
          });
        } catch (e) {
          // ignore persistence failures
        }

        // Optional model scoring (disabled by default). If enabled, send features to remote model
        // provider (Gemini or similar). Model must return { lossProb: number } to act upon.
        let modelScore: { lossProb: number } | null = null;
        if (ML_CONFIG?.enabled) {
          try {
            modelScore = await scoreWithRemoteModel({
              symbol,
              side,
              entry,
              sl: slPrice,
              tp: tpPrice,
              lots,
              accountBalance,
              slPips: slDistance,
              tpPips: tpDistance,
              fvgDistancePips: distanceToFVG
            });

            // compute threshold for normal pass: use gatingMode first, then fall back to HF override, then declineLossProb.
            const modeThrMain = mlModeToThreshold(ML_CONFIG?.gatingMode);
            const allowedThr = modeThrMain ?? STRATEGY_CONFIG.highFrequency?.mlMaxLossProb ?? (ML_CONFIG?.declineLossProb ?? 0.6);
            if (modelScore && modelScore.lossProb > allowedThr) {
              // before we commit to skipping, try entry refinement (move entry closer or use FVG mid)
              if (!useMarketOrder) {
                try {
                  // try entry closer to price (50%)
                  const closerEntry = entry + (currentPrice - entry) * 0.5;
                  const closerSlDistance = priceToPip(symbol, Math.abs(closerEntry - slPrice));
                  const closerTpDistance = Math.max(slTpConfig.tpPips, closerSlDistance * (STRATEGY_CONFIG.tp?.minRR ?? 1.5));
                  const closerTpPrice = side === 'BUY' ? closerEntry + (closerTpDistance * pipSize) : closerEntry - (closerTpDistance * pipSize);

                  const closerScore = await scoreWithRemoteModel({ symbol, side, entry: closerEntry, sl: slPrice, tp: closerTpPrice, lots, accountBalance, slPips: closerSlDistance });
                  if (closerScore && typeof closerScore.lossProb === 'number' && closerScore.lossProb <= allowedThr) {
                    modelDecision('🔧 ENTRY REFINED - closerEntry accepted', { symbol, side, oldEntry: entry, newEntry: closerEntry, oldLoss: modelScore.lossProb, newLoss: closerScore.lossProb });
                    entry = closerEntry;
                    // update derived distances
                    slDistance = closerSlDistance;
                    tpPrice = closerTpPrice;
                    tpDistance = closerTpDistance;
                  } else if (typeof candidate?.mid === 'number') {
                    // try FVG midpoint entry
                    const midEntry = candidate.mid;
                    const midSlDistance = priceToPip(symbol, Math.abs(midEntry - slPrice));
                    const midTpDistance = Math.max(slTpConfig.tpPips, midSlDistance * (STRATEGY_CONFIG.tp?.minRR ?? 1.5));
                    const midTpPrice = side === 'BUY' ? midEntry + (midTpDistance * pipSize) : midEntry - (midTpDistance * pipSize);
                    const midScore = await scoreWithRemoteModel({ symbol, side, entry: midEntry, sl: slPrice, tp: midTpPrice, lots, accountBalance, slPips: midSlDistance });
                    if (midScore && typeof midScore.lossProb === 'number' && midScore.lossProb <= allowedThr) {
                      modelDecision('🔧 ENTRY REFINED - midEntry accepted', { symbol, side, oldEntry: entry, newEntry: midEntry, oldLoss: modelScore.lossProb, newLoss: midScore.lossProb });
                      entry = midEntry;
                      slDistance = midSlDistance;
                      tpPrice = midTpPrice;
                      tpDistance = midTpDistance;
                    }
                  }
                } catch (e:any) {
                  // refinement failed, continue to existing skip/refine flow
                  warn('Entry refinement attempt failed', e?.message ?? e);
                }
              }

              // persist that we skipped this signal due to model
                // persist that we skipped this signal due to model (include modelFeatures + confirmation snapshot)
                try {
                  const modelFeaturesSkip = {
                    entry: +entry,
                    price: useMarketOrder ? currentPrice : entry,
                    sl: +slPrice,
                    tp: +tpPrice,
                    lots,
                    accountBalance: accountBalance,
                    slPips: +slDistance,
                    tpPips: +tpDistance,
                    fvgDistancePips: +distanceToFVG,
                    dynamicMaxDistance: +dynamicMaxDistance
                  } as any;
                  const confCfg = (STRATEGY_CONFIG as any).confirmations ?? null;
                  const confirmationsSkip: any = {};
                  if (confCfg && (confCfg.minimumConfirmations ?? 0) >= 3) {
                    const bos = this.isStructureBreak(candles, side);
                    const liqu = this.isLiquidityGrab(recentSweeps, side, STRATEGY_CONFIG.sweep?.thresholdPips ?? 10);
                    const thirdType = confCfg.perSymbolThird?.[symbol] ?? 'EMA';
                    confirmationsSkip.count = (bos?1:0)+(liqu?1:0);
                    confirmationsSkip.list = [ bos ? 'BOS' : null, liqu ? 'LIQUIDITY_GRAB' : null ].filter(Boolean);
                    confirmationsSkip.bos = bos;
                    confirmationsSkip.liquidityGrab = liqu;
                    confirmationsSkip.third = { type: thirdType };
                  }

                  persistTradeSignal({
                    time: Math.floor(Date.now() / 1000),
                    symbol,
                    side,
                    orderType: useMarketOrder ? 'MARKET' : 'LIMIT',
                    entry: +entry,
                    price: useMarketOrder ? currentPrice : entry,
                    sl: +slPrice,
                    tp: +tpPrice,
                    lots,
                    accountBalance: accountBalance,
                    fvgDistancePips: +distanceToFVG,
                    slPips: +slDistance,
                    tpPips: +tpDistance,
                    dynamicMaxDistance: +dynamicMaxDistance,
                    detectors: { poi: !!poi, fvgCount: fvgs.length, sweeps: recentSweeps.length, rejections: rejections.length },
                    status: 'skipped_by_model',
                    modelFeatures: modelFeaturesSkip,
                    confirmations: confirmationsSkip,
                    result: { profit: 0, reason: 'skipped_by_model', closedTime: Math.floor(Date.now() / 1000) }
                  });
                } catch (e) { /* ignore persistence failures */ }

              // analyze pattern in history and attempt SL refinement instead of immediate reject
              try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { analyzeSlHitPattern } = require('../core/trade-storage');
                const fastSecs = 3 * 60 * 15; // for M15: 3 * 15min bars = 45min
                const stats = analyzeSlHitPattern(symbol, side, slDistance, { tolerancePercent: 0.2, lookback: 500, fastSecs, minSample: 6 });
                modelDecision('🔎 M15 model flagged; SL pattern stats', { symbol, side, lossProb: modelScore.lossProb, thr: allowedThr, slDistance, stats });

                if (stats.sampleCount >= 6 && stats.fastHitRate >= 0.5) {
                  // try widening SL
                  const widenFactor = 1 + Math.min(1.0, stats.fastHitRate);
                  const newSlDistance = Math.max(Math.ceil(slDistance * widenFactor), slDistance + 1, Math.max(2, configuredBufferPips));
                  const newSlPrice = side === 'BUY' ? entry - (newSlDistance * pipSize) : entry + (newSlDistance * pipSize);
                  const newTpDistancePips = Math.max(slTpConfig.tpPips, newSlDistance * (STRATEGY_CONFIG.tp?.minRR ?? 1.5));
                  const newTpPrice = side === 'BUY' ? entry + (newTpDistancePips * pipSize) : entry - (newTpDistancePips * pipSize);

                  // re-score with widened SL
                  const secondScore = await scoreWithRemoteModel({ symbol, side, entry, sl: newSlPrice, tp: newTpPrice, lots, accountBalance, slPips: newSlDistance });
                  if (secondScore && typeof secondScore.lossProb === 'number' && secondScore.lossProb <= allowedThr) {
                    modelDecision('🔧 M15 SL REFINED - accepted after widening', { symbol, side, oldLossProb: modelScore.lossProb, newLossProb: secondScore.lossProb, oldSl: slDistance, newSl: newSlDistance });
                    // adopt refined values
                    slPrice = newSlPrice;
                    slDistance = newSlDistance;
                    tpPrice = newTpPrice;
                    tpDistance = newTpDistancePips;
                  } else {
                    modelDecision('❌ M15 REJECTED - high lossProb even after refinement', { symbol, side, lossProb: modelScore.lossProb, thr: allowedThr, stats });
                    // persist that we skipped this signal due to model
                    try {
                      const modelFeaturesSkip2 = {
                        entry: +entry,
                        price: useMarketOrder ? currentPrice : entry,
                        sl: +slPrice,
                        tp: +tpPrice,
                        lots,
                        accountBalance: accountBalance,
                        slPips: +slDistance,
                        tpPips: +tpDistance,
                        fvgDistancePips: +distanceToFVG,
                        dynamicMaxDistance: +dynamicMaxDistance
                      } as any;
                      const confCfg2 = (STRATEGY_CONFIG as any).confirmations ?? null;
                      const confirmationsSkip2: any = {};
                      if (confCfg2 && (confCfg2.minimumConfirmations ?? 0) >= 3) {
                        const bos = this.isStructureBreak(candles, side);
                        const liqu = this.isLiquidityGrab(recentSweeps, side, STRATEGY_CONFIG.sweep?.thresholdPips ?? 10);
                        const thirdType = confCfg2.perSymbolThird?.[symbol] ?? 'EMA';
                        confirmationsSkip2.count = (bos?1:0)+(liqu?1:0);
                        confirmationsSkip2.list = [ bos ? 'BOS' : null, liqu ? 'LIQUIDITY_GRAB' : null ].filter(Boolean);
                        confirmationsSkip2.bos = bos;
                        confirmationsSkip2.liquidityGrab = liqu;
                        confirmationsSkip2.third = { type: thirdType };
                      }

                      persistTradeSignal({
                      time: Math.floor(Date.now() / 1000),
                      symbol,
                      side,
                      orderType: useMarketOrder ? 'MARKET' : 'LIMIT',
                      entry: +entry,
                      price: useMarketOrder ? currentPrice : entry,
                      sl: +slPrice,
                      tp: +tpPrice,
                      lots,
                      accountBalance: accountBalance,
                      fvgDistancePips: +distanceToFVG,
                      slPips: +slDistance,
                      tpPips: +tpDistance,
                      dynamicMaxDistance: +dynamicMaxDistance,
                      detectors: { poi: !!poi, fvgCount: fvgs.length, sweeps: recentSweeps.length, rejections: rejections.length },
                      status: 'skipped_by_model',
                      modelFeatures: modelFeaturesSkip2,
                      confirmations: confirmationsSkip2,
                      result: { profit: 0, reason: 'skipped_by_model', closedTime: Math.floor(Date.now() / 1000) }
                      });
                    } catch (e:any) {
                      // ignore persistence failures
                    }
                    continue;
                  }
                } else {
                  const potentialProfit = Math.abs(tpPrice - entry);
                  const profitPct = (potentialProfit / entry) * 100;
                  modelDecision('❌ REJECTED - High Loss Probability', { symbol, side, lossProb: modelScore.lossProb, threshold: allowedThr, profitPotential: `${profitPct.toFixed(2)}%`, stats });
                  continue;
                }
              } catch (e:any) {
                // analyzer failure — persist and skip conservatively
                modelDecision('❌ REJECTED - Analyzer failed', { symbol, side, lossProb: modelScore.lossProb, error: e?.message ?? e });
                continue;
              }
            } else if (modelScore) {
              const potentialProfit = Math.abs(tpPrice - entry);
              const profitPct = (potentialProfit / entry) * 100;
              modelDecision('✅ APPROVED - Low Loss Probability', { symbol, side, lossProb: modelScore.lossProb, threshold: allowedThr, profitPotential: `${profitPct.toFixed(2)}%` });
            }
          } catch (e) {
            // scoring failed — proceed normally (we don't want scoring to block trading)
          }
        }

        // Trade approved by 2-signal system (Liquidity + FVG). Logging removed to avoid confusion.

        info('📊 Placing order', { 
          symbol, 
          side, 
          orderType: useMarketOrder ? 'MARKET' : 'LIMIT',
          entry: entry.toFixed(symbol.includes('XAU') ? 2 : 5),
          currentPrice: currentPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          sl: slPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          tp: tpPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          lots,
          baseLots,
          scaleFactor,
          maxLotsByRisk,
          maxLotsByMargin,
          freeMargin,
          leverage,
          slPips: slDistance.toFixed(1),
          tpPips: tpDistance.toFixed(1),
          fvgDistancePips: distanceToFVG.toFixed(1),
          dynamicMaxDistance,
          accountBalance: accountBalance.toFixed(2),
          riskAmount: (accountBalance * STRATEGY_CONFIG.risk.riskPercent / 100).toFixed(2),
          modelScore
        });

        let placeRes: any = null;
        
        // Round SL/TP to proper decimal places to avoid floating point errors
        const decimals = symbol.includes('XAU') ? 2 : 5;
        const slPriceRounded = Math.round(slPrice * Math.pow(10, decimals)) / Math.pow(10, decimals);
        const tpPriceRounded = Math.round(tpPrice * Math.pow(10, decimals)) / Math.pow(10, decimals);
        const entryRounded = Math.round(entry * Math.pow(10, decimals)) / Math.pow(10, decimals);
        
        // Validate stops before placing
        if (side === 'BUY') {
          if (slPriceRounded >= entryRounded) {
            warn(`INVALID: BUY SL (${slPriceRounded}) >= entry (${entryRounded}). Skipping.`);
            continue;
          }
          if (tpPriceRounded <= entryRounded) {
            warn(`INVALID: BUY TP (${tpPriceRounded}) <= entry (${entryRounded}). Skipping.`);
            continue;
          }
        } else {
          if (slPriceRounded <= entryRounded) {
            warn(`INVALID: SELL SL (${slPriceRounded}) <= entry (${entryRounded}). Skipping.`);
            continue;
          }
          if (tpPriceRounded >= entryRounded) {
            warn(`INVALID: SELL TP (${tpPriceRounded}) >= entry (${entryRounded}). Skipping.`);
            continue;
          }
        }
        
        if (useMarketOrder) {
          const params: any = { symbol, type: side, volume: lots, sl: slPriceRounded, tp: tpPriceRounded };
          if (cid) params.comment = cid;
          placeRes = await this.orderManager.placeMarketOrder(params);
        } else {
          const params: any = { symbol, type: side, volume: lots, price: entryRounded, sl: slPriceRounded, tp: tpPriceRounded };
          if (cid) params.comment = cid;
          placeRes = await this.orderManager.placeLimitOrder(params);
        }

        // If order was successful, mark this symbol/side as running in memory
        try {
          if (placeRes?.success) {
            markOpenPosition(symbol, side);
            // attach returned order/deal ids back to the persisted signal (best-effort)
            try {
              if (cid) {
                updateSignalByCid(cid, { order: placeRes.order, deal: placeRes.deal });
              }
            } catch (e:any) {
              warn('Failed to update persisted signal with order id', e?.message ?? e);
            }
          }
        } catch (err:any) {
          // non-fatal - just log
          warn('Failed to mark open position in memory', err?.message ?? err);
        }
        

        logTrade(symbol, side);

      } catch (err: any) {
        // format error message safely
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { formatError } = require('../utils/error');
        warn('Strategy error for symbol', symbol, formatError(err));
      }
    }
  }

  // Polls the bridge for recent closed deals and persists them so training script gets labeled data
  private async checkAndPersistClosedDeals(): Promise<void> {
    // fetch deals since last timestamp
    const since = this.lastDealTimestamp || 0;
    const deals = await this.connector.getDeals(since);
    if (!deals || deals.length === 0) return;

    info(`Fetched ${deals.length} closed deals from bridge since=${since}`);
    let newSaved = 0;
    let updatedExisting = 0;

    for (const d of deals) {
      // Expected shape from bridge: {deal, order, symbol, time, price, volume, profit, type}
      try {
        const t = Math.floor((d.time ?? d.dealtime ?? Date.now()/1000));
        // only persist deals newer than lastDealTimestamp
        if (t <= (this.lastDealTimestamp || 0)) continue;

        const status = 'closed';
        const profit = typeof d.profit === 'number' ? d.profit : Number(d.profit) || 0;

        // try to update an existing placed signal (best-effort) based on deal price
        try {
          const dealSymbol = (d.symbol ?? d.symbol_name ?? 'UNKNOWN') as string;
          const defaultTol = STRATEGY_CONFIG.matching?.defaultTolerancePips ?? 3;
          const perSym = STRATEGY_CONFIG.matching?.perSymbolTolerance ?? {} as any;
          const perSymAny = perSym as any;
          // Try exact match with trailing 'z'; if deal symbol lacks the 'z' suffix then try appending it.
          const normDealSym = dealSymbol?.toString();
          const tol = perSymAny[normDealSym] ?? perSymAny[normDealSym?.endsWith('z') ? normDealSym : `${normDealSym}z`] ?? defaultTol;
          const didUpdate = markSignalClosedByDeal(d, { priceTolerancePips: tol });
          if (didUpdate) updatedExisting++;
        } catch (e) {
          // ignore
        }

        persistTradeSignal({
          time: t,
          symbol: d.symbol ?? d.symbol_name ?? 'UNKNOWN',
          side: (d.type === 0 || String(d.type).toUpperCase().includes('BUY')) ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          entry: d.price ?? d.entry ?? 0,
          price: d.price ?? d.entry ?? 0,
          sl: d.sl ?? 0,
          tp: d.tp ?? 0,
          lots: d.volume ?? d.lots ?? 0,
          accountBalance: undefined,
          fvgDistancePips: undefined,
          slPips: undefined,
          tpPips: undefined,
          dynamicMaxDistance: undefined,
          detectors: {},
          status,
          result: { profit, closedTime: t, reason: 'history_deal' }
        });

        // mark closed in-memory positions if any
        try {
          const closedSide = (d.type === 0 || String(d.type).toUpperCase().includes('BUY')) ? 'BUY' : 'SELL';
          markClosePosition(d.symbol ?? d.symbol_name ?? 'UNKNOWN', closedSide);
        } catch (e) {
          // ignore
        }

        newSaved++;
        // update last processed timestamp
        if (t > this.lastDealTimestamp) this.lastDealTimestamp = t;
      } catch (e) {
        // ignore per-deal errors
      }
    }
    info(`persisted ${newSaved} closed deals (updatedExisting=${updatedExisting})`);

    // After persisting close records, attempt to trigger retrain if enabled
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { triggerRetrainIfNeeded } = require('../core/retrainer');
      const signalsPath = path.join(__dirname, '..', '..', 'data', 'output', 'trade_signals.jsonl');
      if (updatedExisting > 0) {
        // only trigger retrain if we actually matched/updated placed signals
        triggerRetrainIfNeeded(signalsPath);
      } else {
        info('No placed signals were updated by deals — skipping retrain trigger.');
      }
    } catch (err:any) {
      // ignore retrain scheduling failures
    }
  }
}