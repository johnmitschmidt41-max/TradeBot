// src/strategy/jusdtt-m15.ts
import { DataFeed } from "../core/data-feed";
import { OrderManager } from "../core/order-manager";
import { MT5Connector } from "../core/mt5-connector";
import { STRATEGY_CONFIG, getSLPips } from "../config/strategy";
import { detectPOI } from "../detectors/poi-detector";
import { detectFVG, FVG } from "../detectors/fvg-detector";
import { detectSweeps } from "../detectors/sweep-detector";
import { detectRejection } from "../detectors/rejection-detector";
import { computeVolume } from "../core/position-sizing";
import { canOpenTrade, logTrade } from "../core/trade-filter";
import { info, warn } from "../utils/logger";
import { priceToPip } from "../utils/pip";
import { atr } from "../utils/math";
import { Candle } from "../utils/types";

const SYMBOLS = ["GBPUSDz", "EURUSDz", "XAUUSDz"];

export class Strategy {
  dataFeed: DataFeed;
  orderManager: OrderManager;

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

        // ✅ FIX: Use symbol-specific SL distance
        const slPips = getSLPips(symbol);
        
        const slPrice = side === 'BUY' 
          ? entry - slPips * pipSize
          : entry + slPips * pipSize;

        const tpPrice = side === 'BUY'
          ? entry + (STRATEGY_CONFIG.tp.minRR * Math.abs(entry - slPrice))
          : entry - (STRATEGY_CONFIG.tp.minRR * Math.abs(slPrice - entry));

        const slDistance = priceToPip(symbol, Math.abs(entry - slPrice));
        const tpDistance = priceToPip(symbol, Math.abs(entry - tpPrice));

        if (slDistance < 5) {
          warn(`SL too close: ${slDistance.toFixed(1)} pips`);
          continue;
        }

        // ✅ FIX: Use real account balance for position sizing
        const accountInfo = await this.connector.getAccountInfo();
        const accountBalance = accountInfo?.balance ?? 100;
        
        // ✅ FIX: Pass symbol to computeVolume for accurate pip value calculation
        const lots = computeVolume(accountBalance, STRATEGY_CONFIG.risk.riskPercent, slPips, symbol);

        info('📊 Placing order', { 
          symbol, 
          side, 
          orderType: useMarketOrder ? 'MARKET' : 'LIMIT',
          entry: entry.toFixed(symbol.includes('XAU') ? 2 : 5),
          currentPrice: currentPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          sl: slPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          tp: tpPrice.toFixed(symbol.includes('XAU') ? 2 : 5),
          lots,
          slPips: slDistance.toFixed(1),
          tpPips: tpDistance.toFixed(1),
          fvgDistancePips: distanceToFVG.toFixed(1),
          dynamicMaxDistance,
          accountBalance: accountBalance.toFixed(2),
          riskAmount: (accountBalance * STRATEGY_CONFIG.risk.riskPercent / 100).toFixed(2)
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
        warn('Strategy error for symbol', symbol, err?.message ?? err);
      }
    }
  }
}