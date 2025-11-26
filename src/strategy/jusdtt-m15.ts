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
import { info, warn } from "../utils/logger";
import { priceToPip } from "../utils/pip";
import { atr, sma } from "../utils/math";
import { Candle } from "../utils/types";
import path from 'path';

const SYMBOLS = ["GBPUSDz", "EURUSDz", "XAUUSDz", "USDJPYz"];

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
      return scored[0] ?? null;
    }

    nearby.sort((a, b) => a.distancePips - b.distancePips);
    return nearby[0];
  }

  private async attemptHighFreq(symbol: string, timeframe: string) {
    const candles: Candle[] = await this.dataFeed.getRecentCandles(symbol, timeframe, 300);
    if (!candles || candles.length < 50) return;

    const recentSweeps = detectSweeps(candles, STRATEGY_CONFIG.sweep.thresholdPips, symbol).slice(-8);
    if (!recentSweeps || recentSweeps.length === 0) return;

    const latest = recentSweeps[recentSweeps.length - 1];
    const side = latest.side;

    const perCap = (STRATEGY_CONFIG.highFrequency?.perSymbolDailyCap && (STRATEGY_CONFIG.highFrequency?.perSymbolDailyCap as any)[symbol]) ?? STRATEGY_CONFIG.highFrequency?.perSymbolDailyCap?.default ?? 30;
    const todayCount = getTradesTodayCount(symbol);
    if (todayCount >= perCap) {
      info(`M5 skipping ${symbol} because cap reached (${todayCount} >= ${perCap})`);
      return;
    }

    const htf = STRATEGY_CONFIG.highFrequency?.htfConfirm ?? 'M15';
    try {
      const htfCandles = await this.dataFeed.getRecentCandles(symbol, htf, 200);
      if (htfCandles && htfCandles.length > 20 && STRATEGY_CONFIG.filters?.trendEnabled) {
        const maShort = sma(htfCandles, STRATEGY_CONFIG.filters?.maShort || 50);
        const maLong = sma(htfCandles, STRATEGY_CONFIG.filters?.maLong || 200);
        if (maShort === 0 || maLong === 0) return;
        if (side === 'BUY' && maShort <= maLong) return;
        if (side === 'SELL' && maShort >= maLong) return;
      }
    } catch (e:any) {
      warn('M5 HTF fetch failed', e?.message ?? e);
      return;
    }

    const currentPrice = candles[candles.length - 1].close;

    if (!await canOpenTrade(this.connector, symbol, side)) return;

    const fvgs = detectFVG(candles, STRATEGY_CONFIG.fvg.minGapPips, symbol);
    const atrVal = atr(candles, 20) || (symbol.includes('XAU') || symbol.includes('JPY') ? 0.01 : 0.0001) * 100;
    const dynamicMaxDistance = Math.max(symbol.includes('XAU') ? 80 : 50, Math.round(priceToPip(symbol, atrVal) * (symbol.includes('XAU') ? 2.5 : 2.0)));
    const candidate = this.pickNearestValidFVG(fvgs, currentPrice, symbol, dynamicMaxDistance);
    if (!candidate) return;

    const entry = (currentPrice >= candidate.low && currentPrice <= candidate.high) ? currentPrice : (side === 'BUY' ? candidate.low : candidate.high);

    const pipSize = (symbol.includes('XAU') || symbol.includes('JPY')) ? 0.01 : 0.0001;
    const slBuffer = symbol.includes('XAU') ? 200 : 10;
    const sl = side === 'BUY' ? entry - (slBuffer * pipSize) : entry + (slBuffer * pipSize);
    const tp = side === 'BUY' ? entry + (STRATEGY_CONFIG.tp.minRR * Math.abs(entry - sl)) : entry - (STRATEGY_CONFIG.tp.minRR * Math.abs(sl - entry));
    const slDistance = priceToPip(symbol, Math.abs(entry - sl));
    if (slDistance < 2) return;

    const accountInfo = await this.connector.getAccountInfo();
    const accountBalance = accountInfo?.balance ?? 100;
    let lots = computeVolume(accountBalance, STRATEGY_CONFIG.risk.riskPercent, slDistance, symbol);
    lots = Math.round((lots * (STRATEGY_CONFIG.risk?.scalingFactor ?? 1) * (STRATEGY_CONFIG.highFrequency?.m5ScalingFactor ?? 0.3)) * 100) / 100;
    if (lots < 0.01) return;

    if (ML_CONFIG?.enabled) {
      try {
        const score = await scoreWithRemoteModel({ symbol, side, entry, sl, tp, lots, accountBalance, slPips: slDistance });
        const modeThr = mlModeToThreshold(ML_CONFIG?.gatingMode);
        const thr = STRATEGY_CONFIG.highFrequency?.mlMaxLossProb ?? modeThr ?? ML_CONFIG.declineLossProb ?? 0.6;
        if (!score || typeof score.lossProb !== 'number' || score.lossProb > thr) return;
      } catch (e:any) {
        warn('M5 scoring failed', e?.message ?? e);
        return;
      }
    }

    let cid: string | null = null;
    try {
      cid = persistTradeSignalWithCid({ time: Math.floor(Date.now()/1000), symbol, side, orderType: 'MARKET', entry: +entry, price: +entry, sl: +sl, tp: +tp, lots, status: 'placed' });
    } catch (e) {}

    try {
      const params: any = { symbol, type: side as 'BUY'|'SELL', volume: lots, sl, tp };
      if (cid) params.comment = cid;
      const res = await this.orderManager.placeMarketOrder(params);
      if (res?.success) {
        try {
          if (cid) updateSignalByCid(cid, { order: res.order, deal: res.deal });
        } catch (e:any) {
          warn('Failed to attach order id for M5 signal', e?.message ?? e);
        }
        markOpenPosition(symbol, side);
        logTrade(symbol, side);
        info(`M5 placed ${symbol} ${side} lots=${lots}`);
      }
    } catch (e:any) {
      warn('M5 place order failed', e?.message ?? e);
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
    for (const symbol of SYMBOLS) {
      try {
        // If high-frequency M5 mode is enabled, attempt a fast M5 pass first
        if (STRATEGY_CONFIG.highFrequency?.enabled) {
          try {
            await this.attemptHighFreq(symbol, STRATEGY_CONFIG.highFrequency.timeframe || 'M5');
          } catch (err:any) {
            warn('M5 pass error', err?.message ?? err);
          }
        }

        const candles: Candle[] = await this.dataFeed.getRecentCandles(symbol, STRATEGY_CONFIG.timeframe, 500);
        if (!candles || candles.length < 50) {
          info(`Insufficient candles for ${symbol} (have=${candles?.length ?? 0}). Skipping.`);
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
        const filters = STRATEGY_CONFIG.filters ?? {} as any;
        
        // Determine preferred side based on trend (uptrend=BUY, downtrend=SELL)
        let preferredSide: 'BUY' | 'SELL' | null = null;
        if (filters.trendEnabled) {
          const maShort = sma(candles, filters.maShort || 50);
          const maLong = sma(candles, filters.maLong || 200);
          if (maShort > maLong) {
            preferredSide = 'BUY';  // Uptrend: prefer BUYs
          } else if (maShort < maLong) {
            preferredSide = 'SELL'; // Downtrend: prefer SELLs
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

          const minAtr = symbol.includes('XAU') ? (filters.minAtrPipsXAU ?? 30) : (filters.minAtrPipsFX ?? 2.5);
          if (atrPips < minAtr) {
            info(`Low liquidity (ATR ${atrPips.toFixed(1)} pips < min ${minAtr}) — skipping ${symbol}`);
            continue;
          }

          const volThresh = Math.max(1, (filters.minVolumeMultiplier ?? 0.8) * avgVol);
          const perAllow = (filters.perSymbolAllowLowVolume && (filters.perSymbolAllowLowVolume as any)[symbol]) ?? false;
          if (currVol < volThresh && !(filters.allowLowVolume || perAllow)) {
            info(`Low tick volume (${currVol} < avg*mult ${volThresh.toFixed(1)}) — skipping ${symbol}`);
            continue;
          } else if (currVol < volThresh && (filters.allowLowVolume || perAllow)) {
            info(`Low tick volume (${currVol} < avg*mult ${volThresh.toFixed(1)}) — OVERRIDDEN (allowLowVolume) — continuing ${symbol}`);
          }
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
          if (bias === 'BULL') {
            entry = fvgLow;
            if (entry >= currentPrice) {
              warn(`BUY limit invalid: entry ${entry} >= current ${currentPrice}. Skipping.`);
              continue;
            }
          } else {
            entry = fvgHigh;
            if (entry <= currentPrice) {
              warn(`SELL limit invalid: entry ${entry} <= current ${currentPrice}. Skipping.`);
              continue;
            }
          }

          const distanceToEntry = priceToPip(symbol, Math.abs(entry - currentPrice));

          if (distanceToEntry > dynamicMaxDistance) {
            info(`🕐 Nearest FVG too far (${distanceToEntry.toFixed(1)} pips, limit ${dynamicMaxDistance}). Waiting.`);
            continue;
          }

          info(`📍 Nearest FVG ${distanceToEntry.toFixed(1)} pips away. Placing LIMIT order.`);
        }

        // ✅ DYNAMIC SL: Symbol-specific SL buffer for fast trading
        // XAU is expressed in 'pips' where 1 pip = 0.1 (so 200 pips = 20 price units)
        // For XAU use 200 pips (sl) / 400 pips (tp). For FX majors keep tight 10 pips (sl) / 20 pips (tp).
        const slBuffer = symbol.includes('XAU') ? 200 : 10; // pips
        
        let slPrice: number;
        if (side === 'BUY') {
          // SL below entry
          slPrice = entry - (slBuffer * pipSize);
        } else {
          // SL above entry
          slPrice = entry + (slBuffer * pipSize);
        }

        const tpPrice = side === 'BUY'
          ? entry + (STRATEGY_CONFIG.tp.minRR * Math.abs(entry - slPrice))
          : entry - (STRATEGY_CONFIG.tp.minRR * Math.abs(slPrice - entry));

        const slDistance = priceToPip(symbol, Math.abs(entry - slPrice));
        const tpDistance = priceToPip(symbol, Math.abs(entry - tpPrice));

        if (slDistance < 2) {
          warn(`SL too close: ${slDistance.toFixed(1)} pips`);
          continue;
        }

        // ✅ FIX: Use real account balance for position sizing
        const accountInfo = await this.connector.getAccountInfo();
        const accountBalance = accountInfo?.balance ?? 100;
        
        // ✅ Calculate base lot size using configured risk
        const baseLots = computeVolume(accountBalance, STRATEGY_CONFIG.risk.riskPercent, slDistance, symbol);
        const scaleFactor = STRATEGY_CONFIG.risk?.scalingFactor ?? 1;
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
        let freeMargin = (accountInfo?.free_margin ?? accountInfo?.freeMargin);
        if (typeof freeMargin !== 'number') {
          // fallback: try equity - margin (both commonly available)
          const equity = (accountInfo?.equity ?? accountInfo?.Equity ?? accountInfo?.balance ?? 0) as number;
          const usedMargin = (accountInfo?.margin ?? accountInfo?.used_margin ?? accountInfo?.Margin ?? 0) as number;
          freeMargin = Math.max(0, equity - usedMargin);
        }
        freeMargin = freeMargin ?? 0;
        const leverage = (accountInfo?.leverage) ?? (STRATEGY_CONFIG.risk?.defaultLeverage ?? 100);

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
        const globalMax = STRATEGY_CONFIG.risk?.maxLots ?? 50;
        lots = Math.min(Math.max(lots, 0.01), globalMax);

        // Persist the proposed signal (with a client id) before trying to place —
        // we will attach broker order/deal ids after placement to enable
        // deterministic matching later.
        let cid: string | null = null;
        try {
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
            status: 'placed'
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

            // compute threshold for normal pass: check explicit HF perf override first,
            // then derive from gatingMode and fall back to numeric declineLossProb value.
            const modeThrMain = mlModeToThreshold(ML_CONFIG?.gatingMode);
            const allowedThr = STRATEGY_CONFIG.highFrequency?.mlMaxLossProb ?? modeThrMain ?? (ML_CONFIG?.declineLossProb ?? 0.6);
            if (modelScore && modelScore.lossProb > allowedThr) {
              // persist that we skipped this signal due to model
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
                result: { profit: 0, reason: 'skipped_by_model', closedTime: Math.floor(Date.now() / 1000) }
              });

              info('Model declined signal', { symbol, side, lossProb: modelScore.lossProb });
              continue; // skip sending order
            }
          } catch (e) {
            // scoring failed — proceed normally (we don't want scoring to block trading)
          }
        }

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
        if (useMarketOrder) {
          const params: any = { symbol, type: side, volume: lots, sl: slPrice, tp: tpPrice };
          if (cid) params.comment = cid;
          placeRes = await this.orderManager.placeMarketOrder(params);
        } else {
          const params: any = { symbol, type: side, volume: lots, price: entry, sl: slPrice, tp: tpPrice };
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
          const tol = perSymAny[dealSymbol] ?? perSymAny[dealSymbol?.replace('z','')] ?? defaultTol;
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