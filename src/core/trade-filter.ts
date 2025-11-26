// src/core/trade-filter.ts
import { STRATEGY_CONFIG } from "../config/strategy";
import { nowSec } from "../utils/time";
import { info, warn } from "../utils/logger";
import { persistTradeSignal } from "./trade-storage";
import { MT5Connector } from "../core/mt5-connector";

type TradeLog = { symbol: string; time: number; side: 'BUY' | 'SELL' };

const tradesLog: TradeLog[] = [];

// Tracks currently running/open trades per symbol in memory to avoid opening
// simultaneous opposite-side positions. Updated on order success and on deal
// close events. This is a best-effort optimization — the bridge is still the
// source of truth but checking this map avoids racey duplicate attempts.
const activePositions: Record<string, Set<'BUY' | 'SELL'>> = {};

// daily drawdown tracking
let startOfDayISO: string | null = null;
let startEquity = 0;

// settings (fallbacks if not present in config)
const DEFAULT_DAILY_DRAWDOWN = (STRATEGY_CONFIG.risk?.dailyDrawdownPercent) ?? 5; // percent
const DEFAULT_MAX_SIMULTANEOUS = (STRATEGY_CONFIG.risk?.maxSimultaneousTrades) ?? 3;
const DIRECTION_COOLDOWN_SECONDS = (STRATEGY_CONFIG.risk?.directionCooldownSeconds) ?? (5 * 60); // 5 min

function isoDateNow() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * canOpenTrade - async check if a trade may be opened now.
 * - connector: MT5Connector instance (required)
 * - symbol, side: trade details
 */
export async function canOpenTrade(connector: MT5Connector, symbol: string, side: 'BUY' | 'SELL'): Promise<boolean> {
  // 1) max trades per day (count logged trades)
  const today = isoDateNow();
  const tradesToday = tradesLog.filter(t => new Date(t.time * 1000).toISOString().slice(0, 10) === today);
  if (tradesToday.length >= STRATEGY_CONFIG.risk.maxTradesPerDay) {
    info(`Reached max trades per day (${STRATEGY_CONFIG.risk.maxTradesPerDay}).`);
    return false;
  }

  // 2) per-direction cooldown
  const recentSameSide = tradesLog.find(t =>
    t.symbol === symbol &&
    t.side === side &&
    nowSec() - t.time < DIRECTION_COOLDOWN_SECONDS
  );
  if (recentSameSide) {
    info(`Direction cooldown active for ${symbol} ${side}.`);
    return false;
  }

  // 3) max simultaneous trades (global)
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
    // if we can't fetch positions, be conservative and allow trading (or you can choose to block)
  }

  // 4) check per-symbol: avoid opening an opposite-side when there's an active
  // running position on the same symbol. We consult both in-memory map and the
  // actual MT5 bridge to be conservative.
  try {
    // fast in-memory check
    const active = activePositions[symbol] || new Set();
    const oppositeExists = Array.from(active).some(s => s !== side);
    if (oppositeExists) {
      info(`Opposite-side running position present (in memory) for ${symbol}. Blocked.`);
      return false;
    }

    // authoritative check against MT5 bridge for the symbol
    const symbolPositions = await connector.getOpenPositions(symbol);
    if (symbolPositions && symbolPositions.some((p:any) => p.type !== side)) {
      info(`Opposite-side running position present (MT5) for ${symbol}. Blocked.`);
      return false;
    }

    // also check pending orders for opposite side
    const pending = await connector.getPendingOrders(symbol);
    if (pending && pending.some((o:any) => o.type !== side)) {
      info(`Opposite-side pending order present for ${symbol}. Blocked.`);
      return false;
    }
  } catch (err:any) {
    // fail-safe: if a check errored, we allow the trade (but log)
    warn('Error while checking opposite-side positions:', err?.message ?? err);
  }

  // 4) daily drawdown (compute using account equity)
  try {
    const account = await connector.getAccountInfo();
    const equity = account?.equity ?? (account?.balance ?? null);

    if (equity === null || typeof equity === 'undefined') {
      warn('Could not read account equity for drawdown check; allowing trade.');
      return true;
    }

    const currentISO = isoDateNow();
    if (startOfDayISO !== currentISO) {
      // reset start-of-day equity at first call each day
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
    // if error fetching account, allow (or block); we choose to allow but log
  }

  return true;
}

export function logTrade(symbol: string, side: 'BUY' | 'SELL') {
  tradesLog.push({ symbol, side, time: nowSec() });
  try {
    // persist a minimal signal record for later analysis
    persistTradeSignal({
      time: nowSec(),
      symbol,
      side,
      orderType: 'SIGNAL' as any,
      entry: 0,
      sl: 0,
      tp: 0,
      lots: 0,
      status: 'signal'
    });
  } catch (e) {
    // non-fatal
  }
}

// Return how many trades for `symbol` were logged today
export function getTradesTodayCount(symbol: string) {
  const today = isoDateNow();
  return tradesLog.filter(t => t.symbol === symbol && new Date(t.time * 1000).toISOString().slice(0, 10) === today).length;
}

// Mark a symbol as having an open running position (best-effort). Use this right
// after an order is confirmed to have been sent/accepted by the broker.
export function markOpenPosition(symbol: string, side: 'BUY' | 'SELL') {
  if (!activePositions[symbol]) activePositions[symbol] = new Set();
  activePositions[symbol].add(side);
  info(`Marking open position: ${symbol} ${side} (activePositions=${JSON.stringify(Object.keys(activePositions))})`);
}

// Mark a symbol/side as closed (trade ended). Should be called after deal
// history indicates a close for that symbol/side.
export function markClosePosition(symbol: string, side: 'BUY' | 'SELL') {
  const s = activePositions[symbol];
  if (!s) return;
  s.delete(side);
  if (s.size === 0) delete activePositions[symbol];
  info(`Marked closed: ${symbol} ${side}`);
}
