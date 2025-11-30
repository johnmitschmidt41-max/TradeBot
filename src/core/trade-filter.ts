// src/core/trade-filter.ts
import { STRATEGY_CONFIG } from "../config/strategy";
import { nowSec } from "../utils/time";
import { info, warn } from "../utils/logger";
import { persistTradeSignal } from "./trade-storage";
import { MT5Connector } from "../core/mt5-connector";

type TradeLog = { symbol: string; time: number; side: 'BUY' | 'SELL' };

const tradesLog: TradeLog[] = [];

const activePositions: Record<string, Set<'BUY' | 'SELL'>> = {};

// daily drawdown tracking
let startOfDayISO: string | null = null;
let startEquity = 0;

const DEFAULT_DAILY_DRAWDOWN = STRATEGY_CONFIG.risk.dailyDrawdownPercent;
const DEFAULT_MAX_SIMULTANEOUS = STRATEGY_CONFIG.risk.maxSimultaneousTradesGlobal;
const DIRECTION_COOLDOWN_SECONDS = STRATEGY_CONFIG.risk.directionCooldownSeconds;

function isoDateNow() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Async check if a trade may be opened now.
 * Validates: daily limit, direction cooldown, max simultaneous, opposite-side positions, and drawdown
 */
export async function canOpenTrade(connector: MT5Connector, symbol: string, side: 'BUY' | 'SELL'): Promise<boolean> {
  const today = isoDateNow();
  const tradesToday = tradesLog.filter(t => new Date(t.time * 1000).toISOString().slice(0, 10) === today);
  if (tradesToday.length >= STRATEGY_CONFIG.risk.maxTradesPerDay) {
    info(`Reached max trades per day (${STRATEGY_CONFIG.risk.maxTradesPerDay}).`);
    return false;
  }

  const recentSameSide = tradesLog.find(t =>
    t.symbol === symbol &&
    t.side === side &&
    nowSec() - t.time < DIRECTION_COOLDOWN_SECONDS
  );
  if (recentSameSide) {
    info(`Direction cooldown active for ${symbol} ${side}.`);
    return false;
  }

  try {
    const openPositions = await connector.getAllOpenPositions();
    const maxSim = DEFAULT_MAX_SIMULTANEOUS;
    if (openPositions && openPositions.length >= maxSim) {
      info(`Max simultaneous trades reached (${openPositions.length} >= ${maxSim}).`);
      return false;
    }
  } catch (err: any) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { formatError } = require('../utils/error');
    warn('Could not fetch open positions for max-sim check:', formatError(err));
  }

  try {
    const active = activePositions[symbol] || new Set();
    const oppositeExists = Array.from(active).some(s => s !== side);
    if (oppositeExists) {
      info(`Opposite-side running position present (in memory) for ${symbol}. Blocked.`);
      return false;
    }

    const symbolPositions = await connector.getOpenPositions(symbol);
    if (symbolPositions && symbolPositions.some((p:any) => p.type !== side)) {
      info(`Opposite-side running position present (MT5) for ${symbol}. Blocked.`);
      return false;
    }

    const pending = await connector.getPendingOrders(symbol);
    if (pending && pending.some((o:any) => o.type !== side)) {
      info(`Opposite-side pending order present for ${symbol}. Blocked.`);
      return false;
    }
  } catch (err:any) {
    warn('Error while checking opposite-side positions:', err?.message ?? err);
  }

  try {
    const account = await connector.getAccountInfo();
    const equity = account?.equity ?? (account?.balance ?? null);

    if (equity === null || typeof equity === 'undefined') {
      warn('Could not read account equity for drawdown check; allowing trade.');
      return true;
    }

    const currentISO = isoDateNow();
    if (startOfDayISO !== currentISO) {
      startOfDayISO = currentISO;
      startEquity = equity;
      info(`Start-of-day equity set: ${startEquity}`);
    }

    const drawdownPercent = ((startEquity - equity) / startEquity) * 100;
    const limit = DEFAULT_DAILY_DRAWDOWN;

    if (drawdownPercent >= limit) {
      warn(`Daily drawdown ${drawdownPercent.toFixed(2)}% >= limit ${limit}%. Blocking trades for the day.`);
      return false;
    }
  } catch (err: any) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { formatError } = require('../utils/error');
    warn('Error computing daily drawdown:', formatError(err));
  }

  return true;
}

export function logTrade(symbol: string, side: 'BUY' | 'SELL') {
  tradesLog.push({ symbol, side, time: nowSec() });
    try {
      persistTradeSignal({
        time: nowSec(),
        symbol,
        side,
        orderType: 'SIGNAL' as any,
        entry: 0,
        sl: 0,
        tp: 0,
        lots: 0,
        status: 'signal',
        confirmations: { count: 0 },
        modelFeatures: {}
      });
    } catch (e) {}
}

export function getTradesTodayCount(symbol: string) {
  const today = isoDateNow();
  return tradesLog.filter(t => t.symbol === symbol && new Date(t.time * 1000).toISOString().slice(0, 10) === today).length;
}

export function markOpenPosition(symbol: string, side: 'BUY' | 'SELL') {
  if (!activePositions[symbol]) activePositions[symbol] = new Set();
  activePositions[symbol].add(side);
  info(`Marking open position: ${symbol} ${side} (activePositions=${JSON.stringify(Object.keys(activePositions))})`);
}

export function markClosePosition(symbol: string, side: 'BUY' | 'SELL') {
  const s = activePositions[symbol];
  if (!s) return;
  s.delete(side);
  if (s.size === 0) delete activePositions[symbol];
  info(`Marked closed: ${symbol} ${side}`);
}
