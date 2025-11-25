// src/strategy/jusdtt-m15.ts
import { DataFeed } from "../core/data-feed";
import { OrderManager } from "../core/order-manager";
import { MT5Connector } from "../core/mt5-connector";
import { STRATEGY_CONFIG } from "../config/strategy";
import { detectPOI } from "../detectors/poi-detector";
import { detectFVG } from "../detectors/fvg-detector";
import { detectSweeps } from "../detectors/sweep-detector";
import { detectRejection } from "../detectors/rejection-detector";
import { computeVolume } from "../core/position-sizing";
import { canOpenTrade, logTrade } from "../core/trade-filter";
import { info, warn } from "../utils/logger";

const SYMBOLS = ["GBPUSDz", "EURUSDz", "XAUUSDz"];

export class Strategy {
  dataFeed: DataFeed;
  orderManager: OrderManager;

  constructor(private connector: MT5Connector) {
    this.dataFeed = new DataFeed(connector);
    this.orderManager = new OrderManager(connector);
  }

  async scanAndAct() {
    for (const symbol of SYMBOLS) {
      try {
        const candles = await this.dataFeed.getRecentCandles(symbol, STRATEGY_CONFIG.timeframe, 500);
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

        if (!canOpenTrade(symbol, side)) {
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

        const recentFVGs = fvgs.slice(-20);
        const candidateFVG = recentFVGs.reverse().find(f => 
          (bias === 'BULL' ? f.side === 'BULL' : f.side === 'BEAR')
        );
        
        if (!candidateFVG) continue;

        const nearbyRej = rejections.slice(-6).find(r => 
          (bias === 'BULL' ? r.side === 'BUY' : r.side === 'SELL')
        );
        
        if (!nearbyRej) continue;

        const fvgHigh = candidateFVG.high;
        const fvgLow = candidateFVG.low;
        const fvgMid = (fvgHigh + fvgLow) / 2;
        
        const distanceToFVG = Math.abs(currentPrice - fvgMid) / pipSize;
        const proximityThreshold = 30;

        let entry: number;
        let useMarketOrder = false;

        if (distanceToFVG <= proximityThreshold) {
          info(`✅ Price INSIDE FVG (${distanceToFVG.toFixed(1)} pips away). Using MARKET order.`);
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

          const distanceToEntry = Math.abs(entry - currentPrice) / pipSize;
          
          if (distanceToEntry > 100) {
            info(`🕐 FVG too far (${distanceToEntry.toFixed(1)} pips). Waiting for price to approach...`);
            continue;
          }

          info(`📍 Price approaching FVG (${distanceToEntry.toFixed(1)} pips away). Placing LIMIT order.`);
        }

        const slPips = STRATEGY_CONFIG.sl.pipsBelowSweep;
        
        const slPrice = side === 'BUY' 
          ? entry - slPips * pipSize
          : entry + slPips * pipSize;

        const tpPrice = side === 'BUY'
          ? entry + (STRATEGY_CONFIG.tp.minRR * Math.abs(entry - slPrice))
          : entry - (STRATEGY_CONFIG.tp.minRR * Math.abs(slPrice - entry));

        const slDistance = Math.abs(entry - slPrice) / pipSize;
        const tpDistance = Math.abs(entry - tpPrice) / pipSize;

        if (slDistance < 5) {
          warn(`SL too close: ${slDistance.toFixed(1)} pips`);
          continue;
        }

        const accountBalance = 1000;
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
          tpPips: tpDistance.toFixed(1)
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