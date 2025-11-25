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
import { persistTradeSignal } from "../core/trade-storage";
import { scoreWithRemoteModel } from '../core/ai-client';
import { ML_CONFIG } from '../config/strategy';
import { canOpenTrade, logTrade } from "../core/trade-filter";
import { info, warn } from "../utils/logger";
import { priceToPip } from "../utils/pip";
import { atr } from "../utils/math";
import { Candle } from "../utils/types";
import path from 'path';

const SYMBOLS = ["GBPUSDz", "EURUSDz", "XAUUSDz"];

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
        const candles: Candle[] = await this.dataFeed.getRecentCandles(symbol, STRATEGY_CONFIG.timeframe, 500);
        if (!candles || candles.length < 50) continue;

        const currentCandle = candles[candles.length - 1];
        const currentPrice = currentCandle.close;
        const pipSize = symbol.includes('XAU') ? 0.01 : 0.0001;

        const poi = detectPOI(candles, STRATEGY_CONFIG.lookback, STRATEGY_CONFIG.poi.zoneThicknessATR, STRATEGY_CONFIG.poi.minTouches);
        const fvgs = detectFVG(candles, STRATEGY_CONFIG.fvg.minGapPips, symbol);
        const sweeps = detectSweeps(candles, STRATEGY_CONFIG.sweep.thresholdPips, symbol);
        const rejections = detectRejection(candles, STRATEGY_CONFIG.rejection.wickPercent, STRATEGY_CONFIG.rejection.bodyPercent);

        const recentSweeps = sweeps.slice(-10);
        if (recentSweeps.length === 0) continue;
        
        const latestSweep = recentSweeps[recentSweeps.length - 1];
        const side = latestSweep.side;
        const bias = side === 'BUY' ? 'BULL' : 'BEAR';

        const allowed = await canOpenTrade(this.connector, symbol, side);
        if (!allowed) {
          info(`trade blocked by filter for ${symbol} ${side}`);
          continue;
        }

        // ✅ CHECK IF POSITION OR PENDING ORDER ALREADY EXISTS
        const openPositions = await this.connector.getOpenPositions(symbol);
        const pendingOrders = await this.connector.getPendingOrders(symbol);

        const hasOpenPosition = openPositions.some((pos: any) => pos.type === side);
        const hasPendingOrder = pendingOrders.some((order: any) => order.type === side);

        if (hasOpenPosition) {
          info(`Already have open ${side} position on ${symbol}. Skipping.`);
          continue;
        }

        if (hasPendingOrder) {
          info(`Already have pending ${side} limit order on ${symbol}. Skipping.`);
          continue;
        }

        // --- ATR-based dynamic distance cap ---
        const atrVal = atr(candles, 20) || pipSize * 100;
        const atrPips = priceToPip(symbol, atrVal);

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
        lots = Math.min(lots, maxLotsByRisk, maxLotsByMargin || 0);

        // If margin prevents any meaningful lot, skip the trade
        if (lots < 0.01) {
          warn(`Cannot meet risk target: computed lots < 0.01 (maxByRisk=${maxLotsByRisk}, maxByMargin=${maxLotsByMargin}). Skipping.`);
          continue;
        }

        // global cap from config (safety)
        const globalMax = STRATEGY_CONFIG.risk?.maxLots ?? 50;
        lots = Math.min(Math.max(lots, 0.01), globalMax);

        // Persist the proposed signal before trying to place — this helps build training data
        try {
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

            if (modelScore && modelScore.lossProb >= (ML_CONFIG?.declineLossProb ?? 0.6)) {
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

        if (useMarketOrder) {
          await this.orderManager.placeMarketOrder({
            symbol,
            type: side,
            volume: lots,
            sl: slPrice,
            tp: tpPrice
          });
        } else {
          await this.orderManager.placeLimitOrder({
            symbol,
            type: side,
            volume: lots,
            price: entry,
            sl: slPrice,
            tp: tpPrice
          });
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

    for (const d of deals) {
      // Expected shape from bridge: {deal, order, symbol, time, price, volume, profit, type}
      try {
        const t = Math.floor((d.time ?? d.dealtime ?? Date.now()/1000));
        // only persist deals newer than lastDealTimestamp
        if (t <= (this.lastDealTimestamp || 0)) continue;

        const status = 'closed';
        const profit = typeof d.profit === 'number' ? d.profit : Number(d.profit) || 0;

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

        // update last processed timestamp
        if (t > this.lastDealTimestamp) this.lastDealTimestamp = t;
      } catch (e) {
        // ignore per-deal errors
      }
    }

    // After persisting close records, attempt to trigger retrain if enabled
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { triggerRetrainIfNeeded } = require('../core/retrainer');
      const signalsPath = path.join(__dirname, '..', '..', 'data', 'output', 'trade_signals.jsonl');
      triggerRetrainIfNeeded(signalsPath);
    } catch (err:any) {
      // ignore retrain scheduling failures
    }
  }
}