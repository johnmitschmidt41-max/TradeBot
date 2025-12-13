// src/strategy/sweep-fvg-strategy.ts
// New modular strategy: Liquidity Sweep + FVG Entry
// Targets 7-12 trades/day with ~70% win rate

import * as fs from 'fs';
import * as path from 'path';
import { DataFeed } from "../core/data-feed";
import { OrderManager } from "../core/order-manager";
import { MT5Connector } from "../core/mt5-connector";
import { detectFVG, FVG } from "../detectors/fvg-detector";
import { detectReversalPattern, isMomentumFading, ReversalPattern } from "../detectors/double-top-bottom-detector";
import { detectOrderBlock, findRelevantOB, OrderBlock } from "../detectors/ob-detector";
import { BreakerZone, detectBreakerBlocks, checkBreakerRetest, sweepToBreaker, updateBreakerZones } from "../detectors/breaker-detector";
import { ZoneManager, Zone, ZoneCluster, ReactionResult } from "../detectors/zone-manager";
import { computeVolume } from "../core/position-sizing";
import { getSessionManager, SessionManager, SessionName } from "../core/session-manager";
import { info, warn } from "../utils/logger";
import { Candle } from "../utils/types";
import { OrderDatabase, PendingOrderRecord } from "../core/order-db";

// ═══════════════════════════════════════════════════════════════════
// HELPER: Get correct pip size for symbol
// ═══════════════════════════════════════════════════════════════════

// Path to trading config (risk, mode, etc.)
const TRADING_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'config', 'trading_mode.json');

// Symbols disabled until properly configured (indices not yet ready)
const DISABLED_SYMBOLS = ['US30z', 'NAS100z'];

// Helper to get risk percent for a specific symbol category
function getRiskForSymbol(symbol: string): number {
  try {
    if (fs.existsSync(TRADING_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(TRADING_CONFIG_PATH, 'utf8'));
      const s = symbol.toUpperCase();
      
      // Determine category
      if (s.includes('XAU') || s.includes('GOLD')) {
        const risk = parseFloat(config.riskXAU);
        if (!isNaN(risk) && risk >= 0.5 && risk <= 20) return risk;
      } else if (s.includes('US30') || s.includes('NAS') || s.includes('SPX') || s.includes('DJ')) {
        const risk = parseFloat(config.riskIndices);
        if (!isNaN(risk) && risk >= 0.5 && risk <= 20) return risk;
      } else {
        // FX pairs
        const risk = parseFloat(config.riskFX);
        if (!isNaN(risk) && risk >= 0.5 && risk <= 20) return risk;
      }
    }
  } catch (err) {
    // Silent fail - use default
  }
  return 5.0;  // Default risk percent
}

// Legacy helper - kept for compatibility but now uses category-based risk
function getRiskPercent(): number {
  return getRiskForSymbol('EURUSD');  // Returns FX risk as default
}

function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('XAU')) return 0.1;        // Gold: $0.10 per pip
  if (s.includes('JPY')) return 0.01;       // JPY pairs: 0.01 per pip
  if (s.includes('US30') || s.includes('DJ')) return 1.0;   // Dow: 1 point per pip
  if (s.includes('NAS') || s.includes('NDX')) return 1.0;   // Nasdaq: 1 point per pip
  return 0.0001;                             // Standard FX: 0.0001 per pip
}

function isXAUSymbol(symbol: string): boolean {
  return symbol.toUpperCase().includes('XAU');
}

function isJPYSymbol(symbol: string): boolean {
  return symbol.toUpperCase().includes('JPY');
}

function isIndicesSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s.includes('US30') || s.includes('NAS') || s.includes('NDX') || s.includes('SPX') || s.includes('DJ');
}

// ═══════════════════════════════════════════════════════════════════
// REJECTION CANDLE DETECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a candle shows rejection from a zone (FVG)
 * Rejection = wick into zone, but body closed back out in trade direction
 */
function isRejectionCandle(
  candle: Candle,
  side: 'BUY' | 'SELL',
  fvgHigh: number,
  fvgLow: number
): boolean {
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  const candleRange = candle.high - candle.low;
  const bodySize = bodyHigh - bodyLow;
  
  // Minimum candle size to be valid
  if (candleRange === 0) return false;
  
  // Body should be less than 60% of total range (has decent wick)
  const bodyRatio = bodySize / candleRange;
  
  if (side === 'BUY') {
    // For BUY: wick went INTO the FVG (low touched or went below fvgHigh)
    // But candle CLOSED in upper half (bullish rejection)
    const wickedIntoFVG = candle.low <= fvgHigh;
    const closedBullish = candle.close > candle.open; // Green candle
    const closedInUpperHalf = candle.close > (candle.high + candle.low) / 2;
    
    // Strong rejection: long lower wick, closed near high
    const lowerWick = bodyLow - candle.low;
    const upperWick = candle.high - bodyHigh;
    const hasLongLowerWick = lowerWick > upperWick * 1.5; // Lower wick 1.5x upper
    
    return wickedIntoFVG && (closedBullish || closedInUpperHalf || hasLongLowerWick);
  } else {
    // For SELL: wick went INTO the FVG (high touched or went above fvgLow)
    // But candle CLOSED in lower half (bearish rejection)
    const wickedIntoFVG = candle.high >= fvgLow;
    const closedBearish = candle.close < candle.open; // Red candle
    const closedInLowerHalf = candle.close < (candle.high + candle.low) / 2;
    
    // Strong rejection: long upper wick, closed near low
    const lowerWick = bodyLow - candle.low;
    const upperWick = candle.high - bodyHigh;
    const hasLongUpperWick = upperWick > lowerWick * 1.5; // Upper wick 1.5x lower
    
    return wickedIntoFVG && (closedBearish || closedInLowerHalf || hasLongUpperWick);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

interface StrategyConfig {
  symbols: string[];
  
  // Entry timeframe
  entryTimeframe: string;  // M5
  
  // Risk management
  riskPercent: number;     // 1% per trade
  maxTradesPerDay: number; // 12
  maxTradesPerSymbol: number; // 4
  
  // FX settings
  fx: {
    minSweepPips: number;    // Minimum sweep to consider
    maxSlPips: number;       // Max SL allowed
    minRR: number;           // Minimum R:R (2.5)
    maxRR: number;           // Maximum R:R (4.0)
    maxSpreadPips: number;   // Skip if spread too high
  };
  
  // XAU settings
  xau: {
    minSweepPips: number;    // XAU needs bigger sweeps
    maxSlPips: number;
    minRR: number;
    maxRR: number;
    maxSpreadCents: number;
  };
  
  // FVG settings
  fvg: {
    minSizePips: number;     // Minimum FVG size
    maxAgeBars: number;      // Max bars after sweep to find FVG
    retestBuffer: number;    // Enter before FVG fully retested
  };
  
  // Session settings
  sessions: {
    tradeLondon: boolean;
    tradeNY: boolean;
    tradeAsian: boolean;    // Usually false
  };
}

// Correlated pairs that should not have opposing trades at the same time
// Format: if you're LONG pair A, don't go SHORT pair B (and vice versa)
const CORRELATION_PAIRS: { pairA: string; pairB: string; inverse: boolean }[] = [
  // Strongly correlated (move together) - don't take opposite directions
  { pairA: 'EURUSD', pairB: 'GBPUSD', inverse: false },   // Both move with USD weakness
  { pairA: 'AUDUSD', pairB: 'NZDUSD', inverse: false },   // Both commodity currencies
  { pairA: 'USDJPY', pairB: 'EURJPY', inverse: false },   // Both XXX/JPY - JPY is base, they move together
  // Inversely correlated (move opposite) - don't take same direction  
  { pairA: 'EURUSD', pairB: 'USDCHF', inverse: true },    // Almost perfect inverse
  { pairA: 'EURUSD', pairB: 'USDCAD', inverse: true },    // USD on opposite sides
  { pairA: 'GBPUSD', pairB: 'USDCAD', inverse: true },    // USD on opposite sides
  { pairA: 'GBPUSD', pairB: 'USDJPY', inverse: true },    // USD on opposite sides
  { pairA: 'EURUSD', pairB: 'USDJPY', inverse: true },    // USD on opposite sides
  { pairA: 'AUDUSD', pairB: 'USDCAD', inverse: true },    // USD on opposite sides
];

const DEFAULT_CONFIG: StrategyConfig = {
  // All tradeable symbols - disabled ones are filtered by DISABLED_SYMBOLS constant
  // US30z, NAS100z disabled until configured
  symbols: ['GBPUSDz', 'EURUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz', 'EURJPYz', 'XAUUSDz', 'US30z', 'NAS100z'],
  entryTimeframe: 'M5',
  riskPercent: 5.0,
  maxTradesPerDay: 20,  // Increased for more symbols
  maxTradesPerSymbol: 3,
  
  fx: {
    minSweepPips: 5,
    maxSlPips: 25,
    minRR: 2.5,
    maxRR: 4.0,
    maxSpreadPips: 2
  },
  
  xau: {
    minSweepPips: 15,
    maxSlPips: 30,
    minRR: 2.5,
    maxRR: 4.0,
    maxSpreadCents: 30
  },
  
  fvg: {
    minSizePips: 3,
    maxAgeBars: 8,
    retestBuffer: 0.3  // 30% into FVG
  },
  
  sessions: {
    tradeLondon: true,
    tradeNY: true,
    tradeAsian: false
  }
};

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

type SetupType = 'reversal' | 'continuation' | 'trend' | 'double_top' | 'double_bottom' | 'triple_top' | 'triple_bottom' | 'order_block' | 'breaker';

interface PendingSetup {
  symbol: string;
  side: 'BUY' | 'SELL';
  sweepLevel: number;
  sweepTime: Date;
  sweepSession: SessionName;
  fvg: FVG | null;
  orderBlock?: OrderBlock;             // Order block entry (alternative to FVG)
  breakerZone?: BreakerZone;           // Breaker block entry
  reversalPattern?: ReversalPattern;   // Double/Triple Top/Bottom pattern
  candlesSinceSweep: number;
  lastCandleTime: number;      // Track candle time to only count new candles
  entryPrice: number | null;
  sl: number | null;
  tp: number | null;
  status: 'waiting_fvg' | 'waiting_rejection' | 'waiting_entry' | 'ready' | 'pattern_entry' | 'waiting_ob' | 'waiting_breaker_retest' | 'invalidated' | 'pending_order' | 'waiting_continuation_retest' | 'waiting_trend_retest';
  setupType: SetupType;
  highestAfterSweep?: number;  // Track momentum after sweep
  lowestAfterSweep?: number;
  failedAttempts?: number;     // Track failed sweep/reversal attempts
  // M5 swing low/high for SL placement and invalidation (tighter, faster trades)
  m5SwingLow?: number;         // For BUY setups - SL below this, invalidate if broken
  m5SwingHigh?: number;        // For SELL setups - SL above this, invalidate if broken
  // M5 structure target for TP
  m5StructureTP?: number;      // Recent M5 swing high (for BUY) or low (for SELL)
  // Pending order tracking
  pendingOrderTicket?: number;
  pendingOrderType?: string;   // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
  pendingOrderPlacedAt?: Date;
}

// Track trend state per symbol
interface TrendState {
  direction: 'BUY' | 'SELL' | null;
  emaFast: number;
  emaSlow: number;
  strength: number;  // How strong is the trend (EMA separation)
  lastUpdate: Date;
}

interface TradeResult {
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  volume: number;
  ticket?: number;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY CLASS
// ═══════════════════════════════════════════════════════════════════

type TradingMode = 'sweep' | 'trend';

export class SweepFVGStrategy {
  private dataFeed: DataFeed;
  private orderManager: OrderManager;
  private sessionManager: SessionManager;
  private config: StrategyConfig;
  
  // Track pending setups per symbol
  private pendingSetups: Map<string, PendingSetup> = new Map();
  
  // Track daily trade counts
  private tradesToday: Map<string, number> = new Map();
  private lastResetDate: string = '';
  
  // Track trend state per symbol for trend continuation trades
  private trendStates: Map<string, TrendState> = new Map();
  
  // Track failed attempts to know when to switch to trend mode
  private failedSweepAttempts: Map<string, number> = new Map();
  
  // Track trading mode per symbol and session timing
  private tradingMode: Map<string, TradingMode> = new Map();
  private sessionStartTime: Map<string, Date> = new Map();  // When current session started
  private lastActiveSession: string = '';  // Track session changes
  
  // Track open positions to detect when they close
  private openTrades: Map<string, { ticket: number; symbol: string; side: 'BUY' | 'SELL'; entry: number; sl: number; tp: number; openTime: Date }> = new Map();
  
  // Track recently closed trades to prevent immediate re-entry
  // Key: symbol, Value: timestamp when trade closed
  private recentlyClosedTrades: Map<string, number> = new Map();
  private readonly COOLDOWN_MINUTES = 15;  // Wait 15 mins after trade closes before new setup
  
  // Track recently cancelled orders to prevent "loop of death"
  // Key: symbol, Value: timestamp when order was cancelled
  private recentlyCancelledOrders: Map<string, number> = new Map();
  private readonly CANCEL_COOLDOWN_MINUTES = 5;  // Wait 5 mins after order cancelled before new setup
  
  // Track recently used sweep levels to prevent re-entering same zone
  // Key: symbol, Value: { level: number, time: number, side: 'BUY' | 'SELL' }
  private recentlyUsedLevels: Map<string, { level: number; time: number; side: 'BUY' | 'SELL' }> = new Map();
  private readonly LEVEL_COOLDOWN_MINUTES = 60;  // Don't use same sweep level for 60 mins
  private readonly LEVELS_FILE = path.join(__dirname, '../../data/output/used_levels.json');
  
  // Track breaker zones per symbol (broken S/R levels waiting for retest)
  private breakerZones: Map<string, BreakerZone[]> = new Map();
  
  // Zone Manager for continuous zone detection and reaction-based entry
  private zoneManager: ZoneManager = new ZoneManager();
  
  // JSON database for persistent order tracking
  private orderDB: OrderDatabase;
  
  // Config for mode switching
  private readonly SWEEP_WINDOW_MINUTES = 120;  // 2 hours to find sweeps
  private readonly MAX_SWEEP_FAILURES = 3;      // Switch after 3 failures
  
  // Market hours config (UTC)
  // Rollover is typically 21:00-22:00 UTC (10pm-11pm UTC+1)
  // Weekend: Friday 21:00 UTC to Sunday 21:00 UTC
  private readonly ROLLOVER_START_UTC = 21;  // 9pm UTC = 10pm UTC+1
  private readonly ROLLOVER_END_UTC = 22;    // 10pm UTC = 11pm UTC+1
  private readonly WEEKEND_CLOSE_DAY = 5;    // Friday
  private readonly WEEKEND_CLOSE_HOUR = 21;  // 9pm UTC Friday
  private readonly WEEKEND_OPEN_DAY = 0;     // Sunday
  private readonly WEEKEND_OPEN_HOUR = 21;   // 9pm UTC Sunday
  
  // Track if we already cancelled orders for rollover/weekend (prevent repeated cancellations)
  private rolloverCancelledToday = false;
  private lastRolloverCancelDate = '';
  
  // Startup timestamp for grace period
  private readonly startTime: number = Date.now();

  constructor(private connector: MT5Connector, config?: Partial<StrategyConfig>) {
    this.dataFeed = new DataFeed(connector);
    this.orderManager = new OrderManager(connector);
    this.sessionManager = getSessionManager(DEFAULT_CONFIG.symbols);
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize order database for persistent tracking
    this.orderDB = new OrderDatabase();
    
    // Initialize all symbols in sweep mode
    for (const symbol of this.config.symbols) {
      this.tradingMode.set(symbol, 'sweep');
    }
    
    // Load persisted used levels from file (survives restarts)
    this.loadUsedLevels();
    
    // NOTE: recoverPendingOrders() is now called in run() since it's async
    
    info('STRATEGY', 'SweepFVG Strategy initialized', {
      symbols: this.config.symbols,
      riskPercent: this.config.riskPercent,
      maxTradesPerDay: this.config.maxTradesPerDay,
      sweepWindowMinutes: this.SWEEP_WINDOW_MINUTES
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ═══════════════════════════════════════════════════════════════════
  private lastStatusLog = 0;
  private readonly STATUS_INTERVAL = 30000; // Log status every 30 seconds

  async run(): Promise<void> {
    info('STRATEGY', 'Starting SweepFVG Strategy loop...');
    
    // Recover any pending orders from database (survives restarts)
    // This MUST happen before warm-up so frontend gets the state immediately
    await this.recoverPendingOrders();
    
    // Warm up session levels with historical data
    await this.warmUpSessionLevels();
    
    while (true) {
      try {
        await this.tick();
        await this.sleep(5000); // Check every 5 seconds
      } catch (err: any) {
        warn('STRATEGY', `Error in main loop: ${err.message}`);
        await this.sleep(10000);
      }
    }
  }

  /**
   * Log periodic status update with detailed analysis
   */
  private logStatusUpdate(now: Date): void {
    const currentTime = Date.now();
    if (currentTime - this.lastStatusLog < this.STATUS_INTERVAL) {
      return;
    }
    this.lastStatusLog = currentTime;

    const activeSessions = this.sessionManager.getActiveSessions(now);
    
    // Count pending setups and today's trades
    const pendingCount = this.pendingSetups.size;
    let todayTrades = 0;
    this.tradesToday.forEach(count => todayTrades += count);
    
    if (activeSessions.length === 0) {
      // Outside trading hours - calculate time to next session
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();
      let nextSession = 'London';
      let minutesUntil = 0;
      
      // London: 07:00-16:00 UTC, NY: 13:00-21:00 UTC
      if (hour < 7) {
        minutesUntil = (7 - hour) * 60 - minute;
        nextSession = 'London';
      } else if (hour >= 21) {
        minutesUntil = (24 - hour + 7) * 60 - minute;
        nextSession = 'London';
      } else if (hour >= 16 && hour < 21) {
        // After London, check if we can still trade NY
        nextSession = 'NY (overlap ends at 21:00)';
        minutesUntil = 0;
      }
      
      info('STATUS', `Waiting for session | Next: ${nextSession} in ${minutesUntil}min`, {
        time: now.toISOString(),
        utcHour: hour,
        todayTrades,
        maxTrades: this.config.maxTradesPerDay
      });
    } else {
      // Inside trading session - show what we're watching
      const sessionLevels: Record<string, any> = {};
      const analysis: string[] = [];
      
      for (const symbol of this.config.symbols) {
        const levels = this.sessionManager.getSessionLevels(symbol, activeSessions[0]);
        const prevLevels = this.sessionManager.getPreviousSessionLevels(symbol);
        const pending = this.pendingSetups.get(symbol);
        const failures = this.failedSweepAttempts.get(symbol) || 0;
        const trendState = this.trendStates.get(symbol);
        const mode = this.getTradingMode(symbol);
        const sessionStart = this.sessionStartTime.get(symbol);
        const minutesInSession = sessionStart ? Math.floor((now.getTime() - sessionStart.getTime()) / (1000 * 60)) : 0;
        
        if (levels) {
          sessionLevels[symbol] = { high: levels.high.toFixed(5), low: levels.low.toFixed(5) };
        }
        
        // Show mode and what we're looking for per symbol
        const modeTag = mode === 'trend' ? '[TREND]' : `[SWEEP ${minutesInSession}/${this.SWEEP_WINDOW_MINUTES}min]`;
        
        if (pending) {
          if (pending.status === 'waiting_fvg') {
            analysis.push(`${symbol} ${modeTag}: Sweep detected! Waiting for ${pending.side === 'BUY' ? 'bullish' : 'bearish'} FVG (${pending.candlesSinceSweep}/${this.config.fvg.maxAgeBars} bars)`);
          } else if (pending.status === 'waiting_continuation_retest') {
            analysis.push(`${symbol} ${modeTag}: CONTINUATION ${pending.side}! Waiting for FVG/OB retest (${pending.candlesSinceSweep}/12 bars)`);
          } else if (pending.status === 'waiting_trend_retest') {
            analysis.push(`${symbol} ${modeTag}: TREND ${pending.side}! Waiting for FVG/OB retest (${pending.candlesSinceSweep}/12 bars)`);
          } else if (pending.status === 'waiting_entry' && pending.entryPrice) {
            analysis.push(`${symbol} ${modeTag}: REVERSAL ${pending.side}! Entry at ${pending.entryPrice.toFixed(5)}`);
          } else if (pending.status === 'waiting_rejection') {
            analysis.push(`${symbol} ${modeTag}: FVG formed! Waiting for rejection candle`);
          } else if (pending.status === 'waiting_ob') {
            analysis.push(`${symbol} ${modeTag}: Waiting for Order Block retest`);
          } else if (pending.status === 'pending_order' && pending.entryPrice) {
            analysis.push(`${symbol} ${modeTag}: PENDING ORDER ${pending.side} at ${pending.entryPrice.toFixed(5)}`);
          }
        } else if (mode === 'trend') {
          const trendDir = trendState?.direction || 'calculating...';
          analysis.push(`${symbol} ${modeTag}: Looking for ${trendDir} FVG entry`);
        } else if (prevLevels) {
          const failInfo = failures > 0 ? ` [${failures}/3 fails]` : '';
          analysis.push(`${symbol} ${modeTag}: Watching H:${prevLevels.high.toFixed(5)} L:${prevLevels.low.toFixed(5)}${failInfo}`);
        }
      }
      
      info('STATUS', `Active: ${activeSessions.join(', ')} | Trades: ${todayTrades}/${this.config.maxTradesPerDay} | Pending: ${pendingCount}`, {
        time: now.toISOString(),
        sessionLevels
      });
      
      // Log detailed analysis
      for (const line of analysis) {
        info('ANALYSIS', line);
      }
    }
  }

  /**
   * Warm up session levels from historical candles
   */
  private async warmUpSessionLevels(): Promise<void> {
    info('STRATEGY', 'Warming up session levels from historical data...');
    
    for (const symbol of this.config.symbols) {
      try {
        // Get last 100 candles to build session levels
        const candles = await this.dataFeed.getRecentCandles(symbol, this.config.entryTimeframe, 100);
        
        if (candles && candles.length > 0) {
          this.sessionManager.warmUpFromCandles(symbol, candles);
          info('WARMUP', `${symbol}: loaded ${candles.length} candles for session levels`);
        } else {
          warn('WARMUP', `${symbol}: no historical candles available`);
        }
      } catch (err: any) {
        warn('WARMUP', `${symbol}: failed to load history - ${err.message}`);
      }
    }
    
    // Log warm-up status
    const status = this.sessionManager.getWarmUpStatus();
    info('WARMUP', 'Session levels ready', status);
  }

  async tick(): Promise<void> {
    const now = new Date();
    this.resetDailyCountsIfNeeded(now);
    this.resetRolloverFlagIfNeeded(now);
    
    // Log status every 30 seconds
    this.logStatusUpdate(now);
    
    // Monitor open trades - ALWAYS check (even during rollover/weekend)
    // Open trades should be left to hit TP/SL naturally
    await this.monitorOpenTrades();
    
    // ═══════════════════════════════════════════════════════════════════
    // MARKET CLOSED / ROLLOVER CHECKS
    // ═══════════════════════════════════════════════════════════════════
    
    // Check if market is closed (weekend)
    if (this.isMarketClosed(now)) {
      // Cancel any pending orders if approaching weekend close
      if (this.isApproachingWeekendClose(now)) {
        await this.cancelAllPendingOrdersForRollover('weekend');
      }
      
      const day = now.getUTCDay();
      const hour = now.getUTCHours();
      info('MARKET', `Market CLOSED (Weekend) - Day: ${day}, Hour: ${hour} UTC. Waiting for Sunday 21:00 UTC...`);
      return;  // Skip all trading actions
    }
    
    // Check if approaching rollover - cancel pending orders
    if (this.isApproachingRollover(now)) {
      await this.cancelAllPendingOrdersForRollover('rollover');
    }
    
    // Check if in rollover period - pause new actions
    if (this.isRolloverPeriod(now)) {
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();
      info('MARKET', `ROLLOVER period (${hour}:${minute.toString().padStart(2, '0')} UTC) - Pausing new actions until ${this.ROLLOVER_END_UTC}:00 UTC`);
      return;  // Skip trading actions but keep monitoring
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // NORMAL TRADING LOGIC
    // ═══════════════════════════════════════════════════════════════════
    
    // Monitor pending orders - check if filled, invalidated, or missed
    await this.monitorPendingOrders();
    
    // Check if we're in a trading session
    const activeSessions = this.sessionManager.getActiveSessions(now);
    if (activeSessions.length === 0) {
      return; // Outside trading hours
    }
    
    // Check for session change - reset to SWEEP mode at start of each session
    const currentSessionKey = activeSessions.join(',');
    if (currentSessionKey !== this.lastActiveSession) {
      this.onSessionChange(currentSessionKey, now);
    }
    
    // Check if sweep window has expired for each symbol
    this.checkSweepWindowExpiry(now);
    
    // Process each symbol
    for (const symbol of this.config.symbols) {
      await this.processSymbol(symbol, now, activeSessions);
    }
  }

  /**
   * Monitor open trades and detect when they close
   * Also detects trades opened externally (manually or by other EAs)
   */
  private async monitorOpenTrades(): Promise<void> {
    // Check ALL symbols for open positions (including manually opened)
    for (const symbol of this.config.symbols) {
      try {
        const openPositions = await this.connector.getOpenPositions(symbol);
        const trackedTrade = this.openTrades.get(symbol);
        const pendingSetup = this.pendingSetups.get(symbol);
        
        if (openPositions && openPositions.length > 0) {
          const position = openPositions[0]; // Take first position on this symbol
          
          // Handle both formats: price_open (from bridge) or openPrice
          const entryPrice = position.price_open || position.openPrice || 0;
          // Handle type as string "BUY"/"SELL" or number 0/1
          const side: 'BUY' | 'SELL' = (position.type === 'BUY' || position.type === 0) ? 'BUY' : 'SELL';
          
          // If we're not tracking this position yet, start tracking it
          if (!trackedTrade || trackedTrade.ticket !== position.ticket) {
            info('MONITOR', `Detected open position on ${symbol}`, {
              ticket: position.ticket,
              type: position.type,
              side,
              volume: position.volume,
              entryPrice
            });
            
            // Check if this trade matches a pending setup (manual entry of bot's setup)
            if (pendingSetup && pendingSetup.entryPrice) {
              const isXAU = isXAUSymbol(symbol);
              const isJPY = isJPYSymbol(symbol);
              const pipSize = getPipSize(symbol);
              
              // Tolerance: 10 pips for FX, $1 for XAU, 10 pips for JPY
              const tolerance = isXAU ? 10.0 : isJPY ? 0.10 : 0.0010;
              
              const entryClose = Math.abs(entryPrice - pendingSetup.entryPrice) <= tolerance;
              const sideMatch = pendingSetup.side === side;
              
              if (entryClose && sideMatch) {
                info('MONITOR', `Manual trade matches pending setup - clearing setup`, {
                  setupEntry: pendingSetup.entryPrice,
                  tradeEntry: entryPrice,
                  diff: Math.abs(entryPrice - pendingSetup.entryPrice).toFixed(isXAU ? 2 : 5)
                });
                // Mark the sweep level as used so we don't re-enter same zone
                this.markLevelUsed(symbol, pendingSetup.sweepLevel, side);
                this.pendingSetups.delete(symbol);
              }
            }
            
            // Add to tracking
            this.openTrades.set(symbol, {
              ticket: position.ticket,
              symbol,
              side,
              entry: entryPrice,
              sl: position.sl || 0,
              tp: position.tp || 0,
              openTime: new Date()
            });
          }
          
          // Send live P/L update
          const trade = this.openTrades.get(symbol)!;
          const tick = await this.connector.getTick(symbol);
          if (tick) {
            const currentPrice = trade.side === 'BUY' ? tick.bid : tick.ask;
            const isXAU = symbol.includes('XAU');
            const pipSize = getPipSize(symbol);
            const unrealizedPips = trade.side === 'BUY' 
              ? (currentPrice - trade.entry) / pipSize
              : (trade.entry - currentPrice) / pipSize;
            
            await this.sendOpenTradeUpdate(trade, currentPrice, unrealizedPips);
          }
        } else if (trackedTrade) {
          // Position was closed!
          const tick = await this.connector.getTick(symbol);
          const closePrice = tick?.bid || trackedTrade.entry;
          
          const isXAU = symbol.includes('XAU');
          const pipSize = getPipSize(symbol);
          
          let pnlPips = 0;
          let result: 'win' | 'loss' | 'breakeven' = 'breakeven';
          
          if (trackedTrade.side === 'BUY') {
            pnlPips = (closePrice - trackedTrade.entry) / pipSize;
          } else {
            pnlPips = (trackedTrade.entry - closePrice) / pipSize;
          }
          
          if (pnlPips > 5) {
            result = 'win';
          } else if (pnlPips < -5) {
            result = 'loss';
          }
          
          info('TRADE_CLOSED', `${symbol} ${trackedTrade.side} closed`, {
            ticket: trackedTrade.ticket,
            entry: trackedTrade.entry,
            closePrice,
            pnlPips: pnlPips.toFixed(1),
            result
          });
          
          // Send close update to frontend
          await this.sendTradeCloseToAPI(trackedTrade, closePrice, pnlPips, result);
          
          // Remove from tracking
          this.openTrades.delete(symbol);
          
          // Start cooldown to prevent immediate re-entry
          this.markTradeClosed(symbol);
          
          // Clear any pending setup for this symbol
          if (this.pendingSetups.has(symbol)) {
            this.pendingSetups.delete(symbol);
          }
          
          // Send scanning status to dashboard
          await this.sendSetupToAPI(symbol, null);
        }
      } catch (err: any) {
        // Silent - don't spam logs
      }
    }
  }

  /**
   * Synchronize database with MT5 - clean up orders that were manually deleted
   * This ensures we don't have stale entries in our database
   */
  private async syncDatabaseWithMT5(): Promise<void> {
    // Don't sync/delete in the first 30 seconds of bot startup
    // This gives MT5 bridge time to stabilize and ensures we don't falsely delete orders
    if (Date.now() - this.startTime < 30000) {
      return;
    }

    try {
      const dbOrders = this.orderDB.getAllPendingOrders();
      if (dbOrders.length === 0) return;
      
      // Get ALL pending orders from MT5 once to minimize API calls
      // If this fails, it will throw and we will skip the sync (SAFE)
      const mt5Orders = await this.connector.getPendingOrders();
      
      for (const dbOrder of dbOrders) {
        const symbol = dbOrder.symbol;
        
        // Check if this order still exists in MT5
        const existsInMT5 = mt5Orders?.some(o => o.ticket === dbOrder.ticket);
        
        // Also check if position was opened (order filled)
        // We can't easily get ALL positions efficiently if there are many, so check per symbol if needed
        // But for safety, if we can't find it in pending, we should check positions
        let hasPosition = false;
        if (!existsInMT5) {
           const positions = await this.connector.getOpenPositions(symbol);
           hasPosition = positions && positions.length > 0;
        }
        
        // Debug logging
        if (!existsInMT5 && !hasPosition) {
           // ... existing logic ...
        }
        
        if (!existsInMT5 && !hasPosition) {
          // Order was manually cancelled - clean up
          const orderAge = (Date.now() - new Date(dbOrder.placedAt).getTime()) / 1000;
          const botUptime = (Date.now() - this.startTime) / 1000;
          
          // Only clean up if:
          // 1. Order is old enough (give MT5 time to sync) - at least 30 seconds since placed
          // 2. AND bot has been running long enough (at least 30 seconds) to trust API responses
          // The bot uptime check is critical for recovered orders that are hours old
          if (orderAge > 30 && botUptime > 30) {
            warn('SYNC', `${symbol} order ${dbOrder.ticket} no longer in MT5 - removing from DB`, {
              age: `${orderAge.toFixed(0)}s`,
              uptime: `${botUptime.toFixed(0)}s`
            });
            this.orderDB.removePendingOrder(symbol, 'manually_cancelled');
            this.markOrderCancelled(symbol);  // CRITICAL: Prevent immediate re-placement loop
            
            // Also clean up the setup if it's tied to this order
            const setup = this.pendingSetups.get(symbol);
            if (setup && setup.pendingOrderTicket === dbOrder.ticket) {
              this.pendingSetups.delete(symbol);
              await this.sendSetupToAPI(symbol, null);
            }
          } else {
            info('SYNC', `${symbol} order ${dbOrder.ticket} not in MT5 but waiting (Age: ${orderAge.toFixed(0)}s, Uptime: ${botUptime.toFixed(0)}s)`, {});
          }
        }
      }
    } catch (err: any) {
      warn('SYNC', `Error syncing with MT5: ${err.message} - SKIPPING SYNC to protect DB`);
    }
  }

  /**
   * Monitor pending orders - check if they got filled, need cancellation due to invalidation, or missed
   * Also synchronizes with MT5 to detect manually cancelled orders
   */
  /**
   * Monitor pending orders - check if they got filled, need cancellation due to invalidation, or missed
   * Also synchronizes with MT5 to detect manually cancelled orders
   */
  private async monitorPendingOrders(): Promise<void> {
    // FIRST: Synchronize database with MT5 - clean up any orders that were manually deleted
    await this.syncDatabaseWithMT5();
    
    for (const symbol of this.config.symbols) {
      try {
        const setup = this.pendingSetups.get(symbol);
        if (!setup || setup.status !== 'pending_order' || !setup.pendingOrderTicket) {
          continue;
        }
        
        // Check if the pending order still exists
        const pendingOrders = await this.connector.getPendingOrders(symbol);
        const ourOrder = pendingOrders?.find(o => o.ticket === setup.pendingOrderTicket);
        
        // Debug logging
        if (pendingOrders && pendingOrders.length > 0) {
          info('PENDING_CHECK', `${symbol} found ${pendingOrders.length} pending orders`, {
            ourTicket: setup.pendingOrderTicket,
            foundTickets: pendingOrders.map(o => o.ticket).join(', ')
          });
        }
        
        // Check if we now have an open position (order got filled!)
        const openPositions = await this.connector.getOpenPositions(symbol);
        const hasPosition = openPositions && openPositions.length > 0;
        
        if (hasPosition) {
          // Order was filled! Track the trade
          const position = openPositions[0];
          info('PENDING_FILLED', `${symbol} pending order FILLED!`, {
            ticket: setup.pendingOrderTicket,
            orderType: setup.pendingOrderType,
            entry: position.price_open
          });
          
          // Remove from persistent database
          this.orderDB.removePendingOrder(symbol, 'filled');
          
          // Add to triggered trades database
          this.orderDB.addTriggeredTrade({
            ticket: position.ticket,
            originalOrderTicket: setup.pendingOrderTicket,
            symbol,
            type: 'MARKET',
            side: setup.side,
            entryPrice: position.price_open,
            sl: position.sl || setup.sl || 0,
            tp: position.tp || setup.tp || 0,
            volume: position.volume,
            placedAt: setup.pendingOrderPlacedAt?.toISOString() || new Date().toISOString(),
            triggeredAt: new Date().toISOString(),
            setupType: setup.setupType,
            status: 'open'
          });
          
          // Mark level as used
          this.markLevelUsed(symbol, setup.sweepLevel, setup.side);
          
          // Track as open trade
          this.openTrades.set(symbol, {
            ticket: position.ticket,
            symbol,
            side: setup.side,
            entry: position.price_open,
            sl: position.sl || setup.sl || 0,
            tp: position.tp || setup.tp || 0,
            openTime: new Date()
          });
          
          // Increment trade count
          this.incrementTradeCount(symbol);
          
          // Clear setup
          this.pendingSetups.delete(symbol);
          
          // Send trade to dashboard
          await this.sendTradeToAPI({
            symbol,
            side: setup.side,
            entry: position.price_open,
            sl: position.sl || setup.sl || 0,
            tp: position.tp || setup.tp || 0,
            volume: position.volume,
            ticket: position.ticket
          }, setup);
          continue;
        }
        
        if (!ourOrder) {
          // Order no longer exists and no position - it was cancelled or rejected
          
          // SAFETY CHECK: If OrderDB still has it, it means syncDatabaseWithMT5 found it (or failed safely).
          // In that case, this might be a temporary glitch with getPendingOrders(symbol).
          // Trust OrderDB over a single API call failure to prevent "Loop of Death".
          if (this.orderDB.hasPendingOrder(symbol)) {
             const dbOrder = this.orderDB.getPendingOrder(symbol);
             if (dbOrder && dbOrder.ticket === setup.pendingOrderTicket) {
                 info('PENDING_WARN', `${symbol} order missing from getPendingOrders but exists in DB - assuming API glitch`, {
                     ticket: setup.pendingOrderTicket
                 });
                 continue; // Skip deletion, assume it exists
             }
          }

          // BUT: Skip if order was just placed (give MT5 time to register it)
          const orderAge = setup.pendingOrderPlacedAt 
            ? (Date.now() - setup.pendingOrderPlacedAt.getTime()) / 1000
            : 999;
          
          // Also skip if bot just started (grace period for API connection)
          // This is critical for recovered orders that are hours old but bot just started
          const botUptime = (Date.now() - this.startTime) / 1000;

          if (orderAge < 10 || botUptime < 30) {
            // Order just placed or bot just started, give it time
            info('PENDING', `${symbol} order missing but waiting (Age: ${orderAge.toFixed(0)}s, Uptime: ${botUptime.toFixed(0)}s)`, {});
            continue;
          }
          
          info('PENDING_CANCELLED', `${symbol} pending order no longer exists`, {
            ticket: setup.pendingOrderTicket
          });
          // Remove from database and START CANCEL COOLDOWN to prevent loop
          this.orderDB.removePendingOrder(symbol, 'cancelled');
          this.markOrderCancelled(symbol);  // CRITICAL: Prevent immediate re-placement
          this.pendingSetups.delete(symbol);
          await this.sendSetupToAPI(symbol, null);
          continue;
        }
        
        // Order still pending - check for invalidation
        const tick = await this.connector.getTick(symbol);
        if (!tick) continue;
        
        const currentPrice = setup.side === 'BUY' ? tick.ask : tick.bid;
        const isXAU = isXAUSymbol(symbol);
        const isJPY = isJPYSymbol(symbol);
        const pipSize = getPipSize(symbol);
        
        // Check if SL has been hit (should cancel order)
        if (setup.sl) {
          const slHit = setup.side === 'BUY' 
            ? currentPrice <= setup.sl
            : currentPrice >= setup.sl;
          
          if (slHit) {
            warn('PENDING_INVALIDATED', `${symbol} pending order INVALIDATED - price hit SL level`, {
              sl: setup.sl,
              current: currentPrice
            });
            
            // Cancel the pending order
            await this.cancelPendingOrder(symbol, setup.pendingOrderTicket);
            // Remove from database and start cancel cooldown
            this.orderDB.removePendingOrder(symbol, 'invalidated_sl');
            this.markOrderCancelled(symbol);  // CRITICAL: Prevent immediate re-placement
            this.pendingSetups.delete(symbol);
            await this.sendSetupToAPI(symbol, null);
            continue;
          }
        }
        
        // Check if order has been pending too long (120 mins max - allow time for consolidation)
        const orderAge = setup.pendingOrderPlacedAt 
          ? (Date.now() - setup.pendingOrderPlacedAt.getTime()) / (1000 * 60)
          : 0;
        
        if (orderAge > 120) {
          warn('PENDING_EXPIRED', `${symbol} pending order EXPIRED - ${orderAge.toFixed(0)} mins old`, {
            ticket: setup.pendingOrderTicket
          });
          
          await this.cancelPendingOrder(symbol, setup.pendingOrderTicket);
          // Remove from database and start cancel cooldown
          this.orderDB.removePendingOrder(symbol, 'expired');
          this.markOrderCancelled(symbol);  // CRITICAL: Prevent immediate re-placement
          this.pendingSetups.delete(symbol);
          await this.sendSetupToAPI(symbol, null);
          continue;
        }
        
        // Check if price moved too far past entry in the WRONG direction (ran away without filling)
        // For BUY LIMIT: entry is below current price, only "missed" if price dropped FAR BELOW entry
        // For SELL LIMIT: entry is above current price, only "missed" if price rallied FAR ABOVE entry
        if (setup.entryPrice) {
          let missedPips = 0;
          let isMissed = false;
          
          if (setup.side === 'BUY') {
            // BUY LIMIT: missed if price dropped way below entry (ran away downward)
            if (currentPrice < setup.entryPrice) {
              missedPips = (setup.entryPrice - currentPrice) / pipSize;
              isMissed = missedPips > (isXAU ? 50 : 30);
            }
          } else {
            // SELL LIMIT: missed if price rallied way above entry (ran away upward)
            if (currentPrice > setup.entryPrice) {
              missedPips = (currentPrice - setup.entryPrice) / pipSize;
              isMissed = missedPips > (isXAU ? 50 : 30);
            }
          }
          
          if (isMissed) {
            warn('PENDING_MISSED', `${symbol} pending order MISSED - price ${missedPips.toFixed(1)} pips past entry (ran away)`, {
              entry: setup.entryPrice,
              current: currentPrice,
              side: setup.side
            });
            
            await this.cancelPendingOrder(symbol, setup.pendingOrderTicket);
            // Remove from database and start cancel cooldown
            this.orderDB.removePendingOrder(symbol, 'missed');
            this.markOrderCancelled(symbol);  // CRITICAL: Prevent immediate re-placement
            this.pendingSetups.delete(symbol);
            await this.sendSetupToAPI(symbol, null);
            continue;
          }
        }
        
        // Order still valid - send update to dashboard with current price
        await this.sendSetupToAPI(symbol, setup, currentPrice);
        
      } catch (err: any) {
        // Silent - don't spam logs
      }
    }
  }

  /**
   * Cancel a pending order
   */
  private async cancelPendingOrder(symbol: string, ticket: number): Promise<void> {
    try {
      await this.connector.cancelOrder(ticket);
      info('ORDER', `Cancelled pending order ${ticket} for ${symbol}`);
    } catch (err: any) {
      warn('ORDER', `Failed to cancel order ${ticket}: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MARKET HOURS & ROLLOVER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Check if market is closed (weekend)
   * Weekend: Friday 21:00 UTC to Sunday 21:00 UTC
   */
  private isMarketClosed(now: Date = new Date()): boolean {
    const day = now.getUTCDay();  // 0=Sunday, 5=Friday, 6=Saturday
    const hour = now.getUTCHours();
    
    // Saturday: always closed
    if (day === 6) return true;
    
    // Sunday: closed until 21:00 UTC
    if (day === 0 && hour < this.WEEKEND_OPEN_HOUR) return true;
    
    // Friday: closed after 21:00 UTC
    if (day === 5 && hour >= this.WEEKEND_CLOSE_HOUR) return true;
    
    return false;
  }

  /**
   * Check if we're in the daily rollover period
   * Rollover: 21:00-22:00 UTC (10pm-11pm UTC+1)
   */
  private isRolloverPeriod(now: Date = new Date()): boolean {
    const hour = now.getUTCHours();
    return hour >= this.ROLLOVER_START_UTC && hour < this.ROLLOVER_END_UTC;
  }

  /**
   * Check if we're approaching rollover (within 15 minutes)
   * Used to cancel pending orders before rollover starts
   */
  private isApproachingRollover(now: Date = new Date()): boolean {
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    // 15 minutes before rollover (20:45 UTC)
    if (hour === this.ROLLOVER_START_UTC - 1 && minute >= 45) return true;
    
    // Also true if already in rollover
    return this.isRolloverPeriod(now);
  }

  /**
   * Check if we're approaching weekend close (within 15 minutes)
   */
  private isApproachingWeekendClose(now: Date = new Date()): boolean {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    // Friday, 15 minutes before close (20:45 UTC)
    if (day === 5 && hour === this.WEEKEND_CLOSE_HOUR - 1 && minute >= 45) return true;
    
    // Also true if market already closed
    return this.isMarketClosed(now);
  }

  /**
   * Cancel all pending orders before rollover/weekend
   * This prevents getting filled during bad conditions (spread widening, gaps)
   */
  private async cancelAllPendingOrdersForRollover(reason: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    
    // Only cancel once per day for rollover
    if (reason === 'rollover' && this.lastRolloverCancelDate === today && this.rolloverCancelledToday) {
      return;  // Already cancelled today
    }
    
    const pendingOrders = this.orderDB.getAllPendingOrders();
    if (pendingOrders.length === 0) {
      info('ROLLOVER', `No pending orders to cancel for ${reason}`);
      return;
    }
    
    info('ROLLOVER', `Cancelling ${pendingOrders.length} pending orders before ${reason}...`);
    
    for (const order of pendingOrders) {
      try {
        await this.cancelPendingOrder(order.symbol, order.ticket);
        this.orderDB.removePendingOrder(order.symbol, `cancelled_${reason}`);
        this.pendingSetups.delete(order.symbol);
        await this.sendSetupToAPI(order.symbol, null);
        
        info('ROLLOVER', `Cancelled ${order.symbol} ${order.type} order #${order.ticket} for ${reason}`);
      } catch (err: any) {
        warn('ROLLOVER', `Failed to cancel ${order.symbol} order: ${err.message}`);
      }
    }
    
    // Mark as done for today (only for rollover, not weekend)
    if (reason === 'rollover') {
      this.rolloverCancelledToday = true;
      this.lastRolloverCancelDate = today;
    }
  }

  /**
   * Reset rollover cancel flag at start of new day
   */
  private resetRolloverFlagIfNeeded(now: Date): void {
    const today = now.toISOString().split('T')[0];
    if (today !== this.lastRolloverCancelDate) {
      this.rolloverCancelledToday = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SESSION & MODE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Calculate the actual session start time (not bot start time)
   * London: 07:00 UTC, NY: 13:00 UTC
   */
  private calculateActualSessionStart(now: Date, activeSessions: SessionName[]): Date {
    const hour = now.getUTCHours();
    const sessionStartDate = new Date(now);
    sessionStartDate.setUTCMinutes(0);
    sessionStartDate.setUTCSeconds(0);
    sessionStartDate.setUTCMilliseconds(0);
    
    // Determine earliest active session start
    if (activeSessions.includes('london')) {
      sessionStartDate.setUTCHours(7);  // London starts at 07:00 UTC
    } else if (activeSessions.includes('ny')) {
      sessionStartDate.setUTCHours(13); // NY starts at 13:00 UTC
    }
    
    return sessionStartDate;
  }

  /**
   * Called when session changes - reset all symbols to SWEEP mode
   */
  private onSessionChange(newSessionKey: string, now: Date): void {
    // Parse active sessions from the key
    const activeSessions = newSessionKey.split(',') as SessionName[];
    
    // Calculate actual session start time (not when bot started)
    const actualSessionStart = this.calculateActualSessionStart(now, activeSessions);
    
    const minutesSinceSessionStart = (now.getTime() - actualSessionStart.getTime()) / (1000 * 60);
    const isLateStart = minutesSinceSessionStart > 10;  // More than 10 minutes into session
    
    info('SESSION', `Session changed to: ${newSessionKey}`, {
      actualStart: actualSessionStart.toISOString(),
      minutesIn: Math.floor(minutesSinceSessionStart),
      isLateStart
    });
    
    this.lastActiveSession = newSessionKey;
    
    // Reset all symbols to sweep mode, using actual session start time
    for (const symbol of this.config.symbols) {
      const previousMode = this.tradingMode.get(symbol);
      
      // If we started late, check if we should be in trend mode already
      if (minutesSinceSessionStart >= this.SWEEP_WINDOW_MINUTES) {
        // Already past sweep window - go straight to trend mode
        this.tradingMode.set(symbol, 'trend');
        this.sessionStartTime.set(symbol, actualSessionStart);
        info('MODE', `${symbol}: Starting in TREND mode (${Math.floor(minutesSinceSessionStart)}min into session)`, {});
      } else {
        // Still in sweep window
        this.tradingMode.set(symbol, 'sweep');
        this.sessionStartTime.set(symbol, actualSessionStart);  // Use ACTUAL session start
        this.failedSweepAttempts.set(symbol, 0);
        
        if (previousMode === 'trend') {
          info('MODE', `${symbol}: TREND → SWEEP (new session)`, {});
        } else if (isLateStart) {
          info('MODE', `${symbol}: SWEEP mode (${Math.floor(this.SWEEP_WINDOW_MINUTES - minutesSinceSessionStart)}min remaining in sweep window)`, {});
        }
      }
      
      // Clear any pending setups from previous session
      if (this.pendingSetups.has(symbol)) {
        this.pendingSetups.delete(symbol);
      }
    }
  }

  /**
   * Check if sweep window has expired and switch to trend mode
   */
  private checkSweepWindowExpiry(now: Date): void {
    for (const symbol of this.config.symbols) {
      const mode = this.tradingMode.get(symbol);
      if (mode !== 'sweep') continue;  // Already in trend mode
      
      const sessionStart = this.sessionStartTime.get(symbol);
      if (!sessionStart) continue;
      
      const minutesSinceSessionStart = (now.getTime() - sessionStart.getTime()) / (1000 * 60);
      const failures = this.failedSweepAttempts.get(symbol) || 0;
      
      // Switch to trend mode if:
      // 1. Sweep window expired (2 hours into session) OR
      // 2. Too many failed sweep attempts
      if (minutesSinceSessionStart >= this.SWEEP_WINDOW_MINUTES || failures >= this.MAX_SWEEP_FAILURES) {
        const reason = minutesSinceSessionStart >= this.SWEEP_WINDOW_MINUTES 
          ? `sweep window expired (${Math.floor(minutesSinceSessionStart)}min)`
          : `${failures} failed sweep attempts`;
        
        info('MODE', `${symbol}: SWEEP → TREND (${reason})`, {
          minutesSinceSessionStart: Math.floor(minutesSinceSessionStart),
          failures
        });
        
        this.tradingMode.set(symbol, 'trend');
      }
    }
  }

  /**
   * Get current trading mode for a symbol
   */
  private getTradingMode(symbol: string): TradingMode {
    return this.tradingMode.get(symbol) || 'sweep';
  }

  // ═══════════════════════════════════════════════════════════════════
  // SYMBOL PROCESSING
  // ═══════════════════════════════════════════════════════════════════

  private async processSymbol(
    symbol: string, 
    now: Date, 
    activeSessions: SessionName[]
  ): Promise<void> {
    // Skip disabled symbols (XAU, indices until January)
    if (DISABLED_SYMBOLS.includes(symbol)) {
      return;
    }
    
    // Skip if this symbol has an open trade (let monitorOpenTrades handle it)
    if (this.openTrades.has(symbol)) {
      // Trade is running - don't look for new setups
      return;
    }
    
    // Skip if not in valid session for this symbol
    if (!this.sessionManager.isTradingTime(symbol, now)) {
      // Send scanning status when outside trading hours
      await this.sendSetupToAPI(symbol, null);
      return;
    }
    
    // Get candle data
    const candles = await this.dataFeed.getRecentCandles(symbol, this.config.entryTimeframe, 200);
    if (!candles || candles.length < 20) {
      return;
    }
    
    const currentCandle = candles[candles.length - 1];
    const currentPrice = currentCandle.close;
    
    // Update session levels
    this.sessionManager.updateSessionLevels(
      symbol,
      currentCandle.high,
      currentCandle.low,
      new Date(currentCandle.time)
    );
    
    // Check for existing pending setup
    const pending = this.pendingSetups.get(symbol);
    
    if (pending) {
      // Process existing setup
      await this.processPendingSetup(symbol, pending, candles, currentPrice);
      
      // Only send update to dashboard if NOT a pending_order
      // (pending_order updates are handled by monitorPendingOrders to avoid double-updates causing flicker)
      if (pending.status !== 'pending_order') {
        await this.sendSetupToAPI(symbol, pending, currentPrice);
      }
    } else {
      // No pending setup in memory - but check if there's one in the database
      // This handles edge cases where pendingSetups got cleared but orderDB still has the order
      if (this.orderDB.hasPendingOrder(symbol)) {
        const dbOrder = this.orderDB.getPendingOrder(symbol);
        if (dbOrder) {
          // Recreate the setup from the database order
          const recoveredSetup: PendingSetup = {
            symbol: dbOrder.symbol,
            side: dbOrder.side as 'BUY' | 'SELL',
            sweepLevel: dbOrder.entryPrice,
            sweepTime: new Date(dbOrder.placedAt),
            sweepSession: 'london',
            fvg: null,
            candlesSinceSweep: 0,
            lastCandleTime: 0,
            entryPrice: dbOrder.entryPrice,
            sl: dbOrder.sl,
            tp: dbOrder.tp,
            status: 'pending_order',
            setupType: dbOrder.setupType as any || 'reversal',
            pendingOrderTicket: dbOrder.ticket,
            pendingOrderType: dbOrder.type,
            pendingOrderPlacedAt: new Date(dbOrder.placedAt)
          };
          this.pendingSetups.set(symbol, recoveredSetup);
          await this.sendSetupToAPI(symbol, recoveredSetup, currentPrice);
          return;
        }
      }
      
      // Check if we can look for NEW setups (trade limits, cooldowns, etc.)
      if (!this.canTrade(symbol)) {
        // Can't trade - send scanning status
        await this.sendSetupToAPI(symbol, null, currentPrice);
        return;
      }
      
      // Check trading mode for this symbol
      const mode = this.getTradingMode(symbol);
      const isXAU = symbol.includes('XAU');
      const pipSize = getPipSize(symbol);
      
      // Get allowed directions based on M15/H1 trend alignment
      const mtfDirections = await this.getAllowedDirections(symbol);
      
      // First, check for breaker block retests (these have priority)
      // Breakers are broken S/R levels waiting for retest
      if (!this.pendingSetups.has(symbol)) {
        await this.checkBreakerEntries(symbol, candles, currentPrice, mtfDirections);
      }
      
      if (mode === 'sweep') {
        // SWEEP MODE: Look for session level sweeps
        if (!this.pendingSetups.has(symbol)) {
          await this.lookForSweep(symbol, candles, activeSessions, mtfDirections);
        }
        
        // Also check for Double/Triple Top/Bottom patterns when momentum is fading
        if (!this.pendingSetups.has(symbol) && isMomentumFading(candles)) {
          await this.lookForReversalPattern(symbol, candles, currentPrice, mtfDirections);
        }
      } else {
        // TREND MODE: Look for trend continuation entries
        if (!this.pendingSetups.has(symbol)) {
          await this.lookForTrendEntry(symbol, candles, currentPrice, isXAU, pipSize, mtfDirections);
        }
      }
      
      // Update breaker zones with new price data (detect new breaks)
      const existingBreakers = this.breakerZones.get(symbol) || [];
      const updatedBreakers = detectBreakerBlocks(candles, symbol, existingBreakers);
      if (updatedBreakers.length !== existingBreakers.length) {
        this.breakerZones.set(symbol, updatedBreakers);
        if (updatedBreakers.length > existingBreakers.length) {
          const newBreaker = updatedBreakers[updatedBreakers.length - 1];
          info('BREAKER_DETECTED', `${symbol} new breaker zone detected`, {
            level: newBreaker.level.toFixed(5),
            side: newBreaker.side,
            tradeSide: newBreaker.tradeSide
          });
        }
      }
      
      // Send scanning status if no setup found
      const newPending = this.pendingSetups.get(symbol);
      await this.sendSetupToAPI(symbol, newPending || null, currentPrice);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SWEEP DETECTION
  // ═══════════════════════════════════════════════════════════════════

  private async lookForSweep(
    symbol: string,
    candles: Candle[],
    activeSessions: SessionName[],
    allowedDirections?: { allowBuy: boolean; allowSell: boolean; m15Trend: string; h1Trend: string }
  ): Promise<void> {
    const isXAU = symbol.includes('XAU');
    const pipSize = getPipSize(symbol);
    const minSweepPips = isXAU ? this.config.xau.minSweepPips : this.config.fx.minSweepPips;
    
    // Check each active session for sweeps
    for (const session of activeSessions) {
      // Skip Asian for most symbols
      if (session === 'asian' && !this.config.sessions.tradeAsian) {
        continue;
      }
      
      // Get previous session levels to sweep
      const prevLevels = this.sessionManager.getPreviousSessionLevels(symbol);
      if (!prevLevels) continue;
      
      const currentCandle = candles[candles.length - 1];
      const currentPrice = currentCandle.close;
      const currentCandleTime = currentCandle.time;
      
      // Calculate distance to levels
      const pipsToHigh = (prevLevels.high - currentPrice) / pipSize;
      const pipsToLow = (currentPrice - prevLevels.low) / pipSize;
      
      // Check if we swept the previous session high
      if (currentPrice > prevLevels.high) {
        const sweepPips = (currentPrice - prevLevels.high) / pipSize;
        
        if (sweepPips >= minSweepPips) {
          // Check if this level was recently used
          if (this.isLevelRecentlyUsed(symbol, prevLevels.high, 'SELL', pipSize)) {
            info('SWEEP', `${symbol} swept ${session} high but level recently used - skipping`, {
              level: prevLevels.high
            });
            continue;
          }
          
          // High swept = look for SELL
          // Check if SELL is allowed by MTF trend
          if (allowedDirections && !allowedDirections.allowSell) {
            info('SWEEP', `${symbol} swept ${session} high but SELL blocked by MTF trend`, {
              m15: allowedDirections.m15Trend,
              h1: allowedDirections.h1Trend
            });
            continue;
          }
          
          info('SWEEP', `${symbol} swept ${session} high`, {
            level: prevLevels.high,
            current: currentPrice,
            pips: sweepPips.toFixed(1)
          });
          
          this.createPendingSetup(symbol, 'SELL', prevLevels.high, session, currentPrice, currentCandleTime);
          return;
        }
      }
      
      // Check if we swept the previous session low
      if (currentPrice < prevLevels.low) {
        const sweepPips = (prevLevels.low - currentPrice) / pipSize;
        
        if (sweepPips >= minSweepPips) {
          // Check if this level was recently used
          if (this.isLevelRecentlyUsed(symbol, prevLevels.low, 'BUY', pipSize)) {
            info('SWEEP', `${symbol} swept ${session} low but level recently used - skipping`, {
              level: prevLevels.low
            });
            continue;
          }
          
          // Low swept = look for BUY
          // Check if BUY is allowed by MTF trend
          if (allowedDirections && !allowedDirections.allowBuy) {
            info('SWEEP', `${symbol} swept ${session} low but BUY blocked by MTF trend`, {
              m15: allowedDirections.m15Trend,
              h1: allowedDirections.h1Trend
            });
            continue;
          }
          
          info('SWEEP', `${symbol} swept ${session} low`, {
            level: prevLevels.low,
            current: currentPrice,
            pips: sweepPips.toFixed(1)
          });
          
          this.createPendingSetup(symbol, 'BUY', prevLevels.low, session, currentPrice, currentCandleTime);
          return;
        }
      }
    }
  }
  
  /**
   * Check if a sweep level was recently used (within cooldown period)
   */
  private isLevelRecentlyUsed(symbol: string, level: number, side: 'BUY' | 'SELL', pipSize: number): boolean {
    const recent = this.recentlyUsedLevels.get(symbol);
    if (!recent) return false;
    
    const minutesSinceUsed = (Date.now() - recent.time) / (1000 * 60);
    if (minutesSinceUsed >= this.LEVEL_COOLDOWN_MINUTES) {
      // Expired
      this.recentlyUsedLevels.delete(symbol);
      return false;
    }
    
    // Check if same side and level is within 20 pips
    const isXAU = isXAUSymbol(symbol);
    const levelTolerance = isXAU ? 20.0 : 0.0020;  // 20 pips / $2
    const levelMatch = Math.abs(level - recent.level) <= levelTolerance;
    const sideMatch = recent.side === side;
    
    return levelMatch && sideMatch;
  }
  
  /**
   * Mark a sweep level as used
   */
  private markLevelUsed(symbol: string, level: number, side: 'BUY' | 'SELL'): void {
    this.recentlyUsedLevels.set(symbol, {
      level,
      side,
      time: Date.now()
    });
    info('LEVEL', `${symbol} marked level ${level.toFixed(5)} as used for ${side}`, {});
    
    // Persist to file so it survives restarts
    this.saveUsedLevels();
  }
  
  /**
   * Save used levels to file for persistence across restarts
   */
  private saveUsedLevels(): void {
    try {
      const data: Record<string, { level: number; time: number; side: string }> = {};
      this.recentlyUsedLevels.forEach((value, key) => {
        data[key] = value;
      });
      fs.writeFileSync(this.LEVELS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      warn('LEVEL', `Failed to save used levels: ${err}`);
    }
  }
  
  /**
   * Load used levels from file on startup
   */
  private loadUsedLevels(): void {
    try {
      if (fs.existsSync(this.LEVELS_FILE)) {
        const data = JSON.parse(fs.readFileSync(this.LEVELS_FILE, 'utf-8'));
        const now = Date.now();
        let loaded = 0;
        let expired = 0;
        
        for (const [symbol, value] of Object.entries(data)) {
          const entry = value as { level: number; time: number; side: 'BUY' | 'SELL' };
          const minutesSinceUsed = (now - entry.time) / (1000 * 60);
          
          // Only load if not expired
          if (minutesSinceUsed < this.LEVEL_COOLDOWN_MINUTES) {
            this.recentlyUsedLevels.set(symbol, entry);
            loaded++;
            info('LEVEL', `Restored ${symbol} level ${entry.level.toFixed(5)} (${entry.side}) - ${minutesSinceUsed.toFixed(0)}m ago`, {});
          } else {
            expired++;
          }
        }
        
        if (loaded > 0 || expired > 0) {
          info('LEVEL', `Loaded ${loaded} used levels, ${expired} expired`, {});
        }
      }
    } catch (err) {
      warn('LEVEL', `Failed to load used levels: ${err}`);
    }
  }

  /**
   * Sync pending orders from MT5 directly
   * This handles cases where the bot crashed after placing an order but before saving to DB
   */
  private async syncPendingOrdersFromMT5(): Promise<void> {
    try {
      // Get all pending orders from MT5
      const pendingOrders = await this.connector.getPendingOrders();
      
      if (!pendingOrders || pendingOrders.length === 0) {
        info('SYNC', 'No pending orders found in MT5', {});
        return;
      }
      
      info('SYNC', `Found ${pendingOrders.length} pending order(s) in MT5`, {});
      
      for (const order of pendingOrders) {
        const symbol = order.symbol;
        
        // Check if this order is for one of our symbols
        if (!this.config.symbols.includes(symbol)) continue;
        
        // Check if it's a SweepFVG order (by comment)
        const comment = order.comment || '';
        if (!comment.includes('SweepFVG')) {
          info('SYNC', `${symbol} order ${order.ticket} not a SweepFVG order - skipping`, { comment });
          continue;
        }
        
        // Check if we already have this in DB
        if (this.orderDB.hasPendingOrder(symbol)) {
          const dbOrder = this.orderDB.getPendingOrder(symbol);
          if (dbOrder && dbOrder.ticket === order.ticket) {
            // Already synced
            continue;
          }
        }
        
        // Determine side from order type
        const side: 'BUY' | 'SELL' = order.type_description?.includes('BUY') ? 'BUY' : 'SELL';
        
        // Create pending setup from MT5 order
        const setup: PendingSetup = {
          symbol,
          side,
          sweepLevel: order.price_open,
          sweepTime: new Date(),  // We don't know when it was placed
          sweepSession: 'london',
          fvg: null,
          candlesSinceSweep: 0,
          lastCandleTime: 0,
          entryPrice: order.price_open,
          sl: order.sl,
          tp: order.tp,
          status: 'pending_order',
          setupType: 'reversal',  // Default
          pendingOrderTicket: order.ticket,
          pendingOrderType: order.type_description || 'LIMIT',
          pendingOrderPlacedAt: new Date()
        };
        
        // Save to memory
        this.pendingSetups.set(symbol, setup);
        
        // Save to DB for persistence
        this.orderDB.addPendingOrder({
          ticket: order.ticket,
          symbol,
          type: order.type_description || 'LIMIT',
          side,
          entryPrice: order.price_open,
          sl: order.sl,
          tp: order.tp,
          volume: order.volume,
          placedAt: new Date().toISOString(),
          setupType: 'reversal'
        });
        
        info('SYNC', `Synced MT5 pending order for ${symbol}`, {
          ticket: order.ticket,
          type: order.type_description,
          entry: order.price_open,
          sl: order.sl,
          tp: order.tp
        });
        
        // Send to frontend
        await this.sendSetupToAPI(symbol, setup, order.price_open);
      }
    } catch (err) {
      warn('SYNC', `Failed to sync pending orders from MT5: ${err}`);
    }
  }

  // Recover pending orders from JSON database AND MT5 (survives restarts)
  private async recoverPendingOrders(): Promise<void> {
    try {
      // Clean up any stale orders first
      this.orderDB.cleanupStale();
      
      // FIRST: Check MT5 for any pending orders we might have missed
      // This handles cases where bot crashed after placing order but before saving to DB
      await this.syncPendingOrdersFromMT5();
      
      // SECOND: Get all pending orders from DB and recreate setups for them
      for (const symbol of this.config.symbols) {
        // Skip if we already have a pending setup (from MT5 sync)
        if (this.pendingSetups.has(symbol)) continue;
        
        const pendingOrders = this.orderDB.getSymbolPendingOrders(symbol);
        
        for (const order of pendingOrders) {
          // Create a pending setup for this order
          const side = order.side as 'BUY' | 'SELL';
          const setup: PendingSetup = {
            symbol: order.symbol,
            side,
            sweepLevel: order.entryPrice,
            sweepTime: new Date(order.placedAt),
            sweepSession: 'london', // Default
            fvg: null,
            candlesSinceSweep: 0,
            lastCandleTime: 0,
            entryPrice: order.entryPrice,
            sl: order.sl,
            tp: order.tp,
            status: 'pending_order',
            setupType: order.setupType as any || 'reversal',
            pendingOrderTicket: order.ticket,
            pendingOrderType: order.type,
            pendingOrderPlacedAt: new Date(order.placedAt)
          };
          
          this.pendingSetups.set(symbol, setup);
          info('RECOVERY', `Restored pending order for ${symbol}`, {
            ticket: order.ticket,
            type: order.type,
            entry: order.entryPrice
          });
          
          // CRITICAL: Send recovered setup to frontend API immediately
          await this.sendSetupToAPI(symbol, setup, order.entryPrice);
        }
      }
    } catch (err) {
      warn('RECOVERY', `Failed to recover pending orders: ${err}`);
    }
  }

  private createPendingSetup(
    symbol: string,
    side: 'BUY' | 'SELL',
    sweepLevel: number,
    session: SessionName,
    currentPrice: number,
    currentCandleTime: number
  ): void {
    const setup: PendingSetup = {
      symbol,
      side,
      sweepLevel,
      sweepTime: new Date(),
      sweepSession: session,
      fvg: null,
      candlesSinceSweep: 0,
      lastCandleTime: currentCandleTime,  // Use actual candle time
      entryPrice: null,
      sl: null,
      tp: null,
      status: 'waiting_fvg',
      setupType: 'reversal',  // Start as reversal, may convert to continuation
      highestAfterSweep: currentPrice,
      lowestAfterSweep: currentPrice
    };
    
    this.pendingSetups.set(symbol, setup);
    
    info('SETUP', `Created pending ${side} setup for ${symbol}`, {
      sweepLevel,
      session,
      status: 'waiting_fvg'
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // FVG DETECTION & ENTRY
  // ═══════════════════════════════════════════════════════════════════

  private async processPendingSetup(
    symbol: string,
    setup: PendingSetup,
    candles: Candle[],
    currentPrice: number
  ): Promise<void> {
    const isXAU = isXAUSymbol(symbol);
    const isJPY = isJPYSymbol(symbol);
    const pipSize = getPipSize(symbol);
    
    // If pending order is placed, skip processing - monitorPendingOrders handles it
    if (setup.status === 'pending_order') {
      // Just return - the monitorPendingOrders function handles pending orders
      return;
    }
    
    // CRITICAL: Also check if there's a pending order in the database
    // This handles cases where the setup status wasn't updated but order exists
    if (this.orderDB.hasPendingOrder(symbol)) {
      const dbOrder = this.orderDB.getPendingOrder(symbol);
      if (dbOrder) {
        info('PROCESS', `${symbol} has pending order in DB - syncing setup`, {
          ticket: dbOrder.ticket,
          currentStatus: setup.status
        });
        // Sync the setup with the database order
        setup.pendingOrderTicket = dbOrder.ticket;
        setup.pendingOrderType = dbOrder.type;
        setup.pendingOrderPlacedAt = new Date(dbOrder.placedAt);
        setup.status = 'pending_order';
        return;  // Let monitorPendingOrders handle it
      }
    }
    
    // Check for invalidation FIRST before any processing
    const invalidReason = this.checkInvalidation(setup, currentPrice, isXAU, isJPY, pipSize);
    if (invalidReason) {
      warn('INVALIDATED', `${symbol} setup invalidated: ${invalidReason}`, {
        side: setup.side,
        status: setup.status,
        age: setup.candlesSinceSweep,
        entry: setup.entryPrice?.toFixed(isXAU ? 2 : 5),
        sl: setup.sl?.toFixed(isXAU ? 2 : 5),
        current: currentPrice.toFixed(isXAU ? 2 : 5)
      });
      this.pendingSetups.delete(symbol);
      return;
    }
    
    // Only increment candle count when we see a NEW candle (different time)
    const currentCandleTime = candles[candles.length - 1].time;
    if (currentCandleTime !== setup.lastCandleTime) {
      setup.candlesSinceSweep++;
      setup.lastCandleTime = currentCandleTime;
      info('CANDLE', `${symbol} new candle - candlesSinceSweep: ${setup.candlesSinceSweep}`, {
        candleTime: new Date(currentCandleTime).toISOString()
      });
    }
    
    // Track price extremes after sweep for continuation detection
    if (setup.highestAfterSweep === undefined) setup.highestAfterSweep = currentPrice;
    if (setup.lowestAfterSweep === undefined) setup.lowestAfterSweep = currentPrice;
    setup.highestAfterSweep = Math.max(setup.highestAfterSweep, currentPrice);
    setup.lowestAfterSweep = Math.min(setup.lowestAfterSweep, currentPrice);
    
    const config = isXAU ? this.config.xau : this.config.fx;
    
    // Update Zone Manager with latest zones (continuous scanning)
    const breakers = this.breakerZones.get(symbol) || [];
    const allZones = this.zoneManager.updateZones(symbol, candles, currentPrice, setup.side, breakers);
    
    // Log zone summary every few candles for visibility
    if (setup.candlesSinceSweep % 3 === 0 && allZones.length > 0) {
      const summary = this.zoneManager.getZoneSummary(symbol);
      const detailed = this.zoneManager.getDetailedZoneSummary(symbol, isXAU);
      info('ZONE_SCAN', `${symbol} ${setup.side} ${summary}`, {
        zones: detailed,
        inRange: allZones.length,
        closest: allZones[0] ? `${allZones[0].type} at ${allZones[0].midpoint.toFixed(isXAU ? 2 : 5)} (${allZones[0].distancePips.toFixed(0)} pips)` : 'none'
      });
    }
    
    // Step 0: Check for sweep-to-breaker conversion
    // If price CLOSES beyond sweep level, the sweep failed - convert to breaker zone
    if (setup.status === 'waiting_fvg' || setup.status === 'waiting_ob') {
      const sweepBroken = this.checkSweepBroken(setup, candles, currentPrice, pipSize);
      if (sweepBroken) {
        // Convert to breaker zone
        const breakerZone = sweepToBreaker(setup.sweepLevel, setup.side, candles, symbol);
        if (breakerZone) {
          // Add to breaker zones for this symbol
          const existingBreakers = this.breakerZones.get(symbol) || [];
          existingBreakers.push(breakerZone);
          this.breakerZones.set(symbol, existingBreakers);
          
          info('SWEEP_TO_BREAKER', `${symbol} sweep failed - converted to ${breakerZone.tradeSide} breaker zone`, {
            level: breakerZone.level.toFixed(isXAU ? 2 : 5),
            originalSide: setup.side,
            newTradeSide: breakerZone.tradeSide
          });
        }
        
        // Remove the sweep setup
        this.pendingSetups.delete(symbol);
        await this.sendSetupToAPI(symbol, null);
        return;
      }
    }
    
    // Step 1: Look for FVG if we don't have one (reversal setup)
    if (setup.status === 'waiting_fvg') {
      const fvgs = detectFVG(candles);
      
      // Find FVG in correct direction for REVERSAL
      const validFVG = fvgs.find(fvg => {
        // For SELL setup (swept high), need bearish FVG (price drops into gap)
        // For BUY setup (swept low), need bullish FVG (price rises into gap)
        if (setup.side === 'SELL' && fvg.side === 'BEAR') return true;
        if (setup.side === 'BUY' && fvg.side === 'BULL') return true;
        return false;
      });
      
      if (validFVG) {
        setup.fvg = validFVG;
        setup.setupType = 'reversal';
        
        // Get M5 swing level for SL and invalidation (tighter, faster trades)
        const m5SwingLevel = await this.getM5SwingLevel(symbol, setup.side);
        if (m5SwingLevel) {
          if (setup.side === 'BUY') {
            setup.m5SwingLow = m5SwingLevel;
          } else {
            setup.m5SwingHigh = m5SwingLevel;
          }
        }
        
        // Get M5 structure TP (recent swing high/low on M5)
        const m5StructureTP = await this.getM5StructureTP(symbol, setup.side);
        if (m5StructureTP) {
          setup.m5StructureTP = m5StructureTP;
        }
        
        // Change to waiting_rejection - don't execute yet!
        setup.status = 'waiting_rejection';
        
        info('FVG', `${symbol} reversal FVG detected - waiting for rejection`, {
          side: setup.side,
          fvgHigh: validFVG.high,
          fvgLow: validFVG.low,
          m5SwingLevel: m5SwingLevel?.toFixed(isXAU ? 2 : 5),
          m5StructureTP: m5StructureTP?.toFixed(isXAU ? 2 : 5),
          currentPrice
        });
      } else {
        // No FVG yet - after 3 candles, look for Order Block as alternative
        if (setup.candlesSinceSweep >= 3 && !setup.orderBlock) {
          const ob = findRelevantOB(candles, setup.side, symbol);
          if (ob) {
            setup.orderBlock = ob;
            setup.status = 'waiting_ob';
            setup.setupType = 'order_block';
            
            info('ORDER_BLOCK', `${symbol} no FVG - found ${ob.side} Order Block as alternative`, {
              obHigh: ob.high.toFixed(isXAU ? 2 : 5),
              obLow: ob.low.toFixed(isXAU ? 2 : 5),
              strength: ob.strength,
              impulsePips: ob.impulsePips.toFixed(1)
            });
          }
        }
        
        // Check for CONTINUATION pattern (price ran away in sweep direction)
        if (setup.status === 'waiting_fvg') {
          const continuationDetected = this.checkContinuation(setup, currentPrice, pipSize, config);
          
          if (continuationDetected) {
            setup.setupType = 'continuation';
            setup.status = 'waiting_continuation_retest';  // Wait for FVG/OB retest, don't enter immediately!
            
            // Look for FVG or OB to use as entry zone
            const fvgs = detectFVG(candles);
            const validFVG = fvgs.find(fvg => {
              if (setup.side === 'BUY' && fvg.side === 'BULL') return true;
              if (setup.side === 'SELL' && fvg.side === 'BEAR') return true;
              return false;
            });
            
            if (validFVG) {
              setup.fvg = validFVG;
            }
            
            // Also look for Order Block
            const ob = findRelevantOB(candles, setup.side, symbol);
            if (ob) {
              setup.orderBlock = ob;
            }
            
            info('CONTINUATION', `${symbol} continuation detected - waiting for FVG/OB retest`, {
              side: setup.side,
              hasFVG: !!setup.fvg,
              hasOB: !!setup.orderBlock,
              fvgZone: setup.fvg ? `${setup.fvg.low.toFixed(isXAU ? 2 : 5)} - ${setup.fvg.high.toFixed(isXAU ? 2 : 5)}` : 'none',
              obZone: setup.orderBlock ? `${setup.orderBlock.low.toFixed(isXAU ? 2 : 5)} - ${setup.orderBlock.high.toFixed(isXAU ? 2 : 5)}` : 'none',
              currentPrice
            });
            
            // Don't enter yet - wait for retest!
            return;
          }
        }
      }
      
      // Expire if no FVG and no continuation after max bars
      if (setup.candlesSinceSweep > this.config.fvg.maxAgeBars && setup.status === 'waiting_fvg') {
        info('SETUP', `${symbol} setup expired - no FVG or continuation (${setup.candlesSinceSweep} bars)`, {
          side: setup.side
        });
        
        // Track failed attempt for this symbol
        const failures = (this.failedSweepAttempts.get(symbol) || 0) + 1;
        this.failedSweepAttempts.set(symbol, failures);
        
        info('SETUP', `${symbol} failed attempts: ${failures}/3 - ${failures >= 3 ? 'switching to TREND mode' : 'will try sweep again'}`, {});
        
        // If 3+ failed sweep attempts, switch to trend continuation mode
        if (failures >= 3) {
          this.lookForTrendEntry(symbol, candles, currentPrice, isXAU, pipSize);
        }
        
        this.pendingSetups.delete(symbol);
        return;
      }
    }
    
    // Step 1.3: Wait for Order Block retest (alternative to FVG)
    if (setup.status === 'waiting_ob' && setup.orderBlock) {
      const ob = setup.orderBlock;
      const currentCandle = candles[candles.length - 1];
      
      // Check if price is in the OB zone
      const inOBZone = (setup.side === 'BUY')
        ? (currentCandle.low <= ob.bodyHigh && currentCandle.low >= ob.low)
        : (currentCandle.high >= ob.bodyLow && currentCandle.high <= ob.high);
      
      if (inOBZone) {
        // Check for rejection at OB
        const hasRejection = this.checkOBRejection(currentCandle, ob, setup.side);
        
        if (hasRejection) {
          info('ORDER_BLOCK', `${symbol} rejection at Order Block!`, {
            side: setup.side,
            obZone: `${ob.bodyLow.toFixed(isXAU ? 2 : 5)} - ${ob.bodyHigh.toFixed(isXAU ? 2 : 5)}`
          });
          
          // Calculate entry levels same as FVG rejection
          setup.status = 'waiting_entry';
          setup.entryPrice = currentCandle.close;
          
          // Get M5 swing for SL if not already set
          if (!setup.m5SwingLow && !setup.m5SwingHigh) {
            const m5SwingLevel = await this.getM5SwingLevel(symbol, setup.side);
            if (m5SwingLevel) {
              if (setup.side === 'BUY') setup.m5SwingLow = m5SwingLevel;
              else setup.m5SwingHigh = m5SwingLevel;
            }
          }
          
          // SL calculation
          const slBuffer = isXAU ? 0.5 : isJPY ? 0.02 : 0.0002;
          if (setup.side === 'BUY' && setup.m5SwingLow) {
            setup.sl = setup.m5SwingLow - slBuffer;
          } else if (setup.side === 'SELL' && setup.m5SwingHigh) {
            setup.sl = setup.m5SwingHigh + slBuffer;
          } else {
            // Fallback to OB-based SL
            setup.sl = setup.side === 'BUY' ? ob.low - (pipSize * 5) : ob.high + (pipSize * 5);
          }
          
          // Get structure TP if not set
          if (!setup.m5StructureTP) {
            const structureTP = await this.getM5StructureTP(symbol, setup.side);
            if (structureTP) setup.m5StructureTP = structureTP;
          }
          
          // Calculate TP with 2RR minimum (same logic as FVG)
          const slDistance = Math.abs(setup.entryPrice - setup.sl);
          const slPips = slDistance / pipSize;
          
          if (slPips < 5 || slPips > config.maxSlPips) {
            warn('ORDER_BLOCK', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
            this.pendingSetups.delete(symbol);
            return;
          }
          
          // TP calculation with 2RR minimum
          let structureRR = 0;
          if (setup.m5StructureTP) {
            const structureDistance = Math.abs(setup.m5StructureTP - setup.entryPrice);
            structureRR = structureDistance / slDistance;
          }
          
          if (structureRR >= 2) {
            setup.tp = setup.m5StructureTP!;
          } else if (structureRR > 1) {
            setup.tp = setup.side === 'BUY'
              ? setup.entryPrice + (slDistance * 2.0)
              : setup.entryPrice - (slDistance * 2.0);
          } else if (structureRR <= 1 && setup.m5StructureTP) {
            warn('ORDER_BLOCK', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
            this.pendingSetups.delete(symbol);
            return;
          } else {
            setup.tp = setup.side === 'BUY'
              ? setup.entryPrice + (slDistance * 2.0)
              : setup.entryPrice - (slDistance * 2.0);
          }
          
          await this.executeEntry(setup);
          this.failedSweepAttempts.set(symbol, 0);
          return;
        }
      }
      
      // Expire OB setup after max bars
      if (setup.candlesSinceSweep > this.config.fvg.maxAgeBars + 3) {
        info('ORDER_BLOCK', `${symbol} OB setup expired - no retest (${setup.candlesSinceSweep} bars)`, {});
        this.pendingSetups.delete(symbol);
        return;
      }
    }
    
    // Step 1.4: Wait for CONTINUATION retest (FVG or OB retest + rejection)
    if (setup.status === 'waiting_continuation_retest') {
      const currentCandle = candles[candles.length - 1];
      
      // Check FVG retest first (if we have one)
      if (setup.fvg) {
        const fvg = setup.fvg;
        const priceInFVG = (setup.side === 'BUY')
          ? (currentCandle.low <= fvg.high && currentCandle.high >= fvg.low)
          : (currentCandle.high >= fvg.low && currentCandle.low <= fvg.high);
        
        if (priceInFVG) {
          const hasRejection = isRejectionCandle(currentCandle, setup.side, fvg.high, fvg.low);
          
          if (hasRejection) {
            info('CONTINUATION', `${symbol} FVG retest rejection - entering!`, {
              side: setup.side,
              fvgZone: `${fvg.low.toFixed(isXAU ? 2 : 5)} - ${fvg.high.toFixed(isXAU ? 2 : 5)}`
            });
            
            // Calculate entry levels with SL 5-10 pips beyond FVG
            setup.entryPrice = currentCandle.close;
            const slBufferPips = isXAU ? 7 : isJPY ? 0.07 : 0.0007;  // 7 pips buffer
            setup.sl = setup.side === 'BUY' ? fvg.low - slBufferPips : fvg.high + slBufferPips;
            
            // Calculate TP with dynamic RR (2RR minimum, use structure if better)
            const slDistance = Math.abs(setup.entryPrice - setup.sl);
            const slPips = slDistance / pipSize;
            
            if (slPips < 5 || slPips > config.maxSlPips) {
              warn('CONTINUATION', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            }
            
            // Get structure TP
            const structureTP = await this.getM5StructureTP(symbol, setup.side);
            let structureRR = 0;
            if (structureTP) {
              const structureDistance = Math.abs(structureTP - setup.entryPrice);
              structureRR = structureDistance / slDistance;
            }
            
            // Dynamic TP: <1RR skip, 1-2RR extend to 2RR, >=2RR use structure
            if (structureRR >= 2) {
              setup.tp = structureTP!;
            } else if (structureRR > 1) {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            } else if (structureRR <= 1 && structureTP) {
              warn('CONTINUATION', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            } else {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            }
            
            setup.status = 'waiting_entry';
            await this.executeEntry(setup);
            this.failedSweepAttempts.set(symbol, 0);
            return;
          }
        }
      }
      
      // Check OB retest (if we have one and FVG didn't trigger)
      if (setup.orderBlock) {
        const ob = setup.orderBlock;
        const inOBZone = (setup.side === 'BUY')
          ? (currentCandle.low <= ob.bodyHigh && currentCandle.low >= ob.low)
          : (currentCandle.high >= ob.bodyLow && currentCandle.high <= ob.high);
        
        if (inOBZone) {
          const hasRejection = this.checkOBRejection(currentCandle, ob, setup.side);
          
          if (hasRejection) {
            info('CONTINUATION', `${symbol} OB retest rejection - entering!`, {
              side: setup.side,
              obZone: `${ob.low.toFixed(isXAU ? 2 : 5)} - ${ob.high.toFixed(isXAU ? 2 : 5)}`
            });
            
            // Calculate entry levels with SL 5-10 pips beyond OB
            setup.entryPrice = currentCandle.close;
            const slBufferPips = isXAU ? 7 : isJPY ? 0.07 : 0.0007;  // 7 pips buffer
            setup.sl = setup.side === 'BUY' ? ob.low - slBufferPips : ob.high + slBufferPips;
            
            // Calculate TP with dynamic RR
            const slDistance = Math.abs(setup.entryPrice - setup.sl);
            const slPips = slDistance / pipSize;
            
            if (slPips < 5 || slPips > config.maxSlPips) {
              warn('CONTINUATION', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            }
            
            // Get structure TP
            const structureTP = await this.getM5StructureTP(symbol, setup.side);
            let structureRR = 0;
            if (structureTP) {
              const structureDistance = Math.abs(structureTP - setup.entryPrice);
              structureRR = structureDistance / slDistance;
            }
            
            // Dynamic TP: <1RR skip, 1-2RR extend to 2RR, >=2RR use structure
            if (structureRR >= 2) {
              setup.tp = structureTP!;
            } else if (structureRR > 1) {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            } else if (structureRR <= 1 && structureTP) {
              warn('CONTINUATION', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            } else {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            }
            
            setup.status = 'waiting_entry';
            await this.executeEntry(setup);
            this.failedSweepAttempts.set(symbol, 0);
            return;
          }
        }
      }
      
      // Expire continuation setup after 12 bars (give price time to retrace)
      if (setup.candlesSinceSweep > 12) {
        info('CONTINUATION', `${symbol} continuation setup expired - no retest (${setup.candlesSinceSweep} bars)`, {});;
        this.pendingSetups.delete(symbol);
        return;
      }
    }
    
    // Step 1.45: Wait for TREND retest (FVG or OB retest + rejection)
    if (setup.status === 'waiting_trend_retest') {
      const currentCandle = candles[candles.length - 1];
      
      // Check FVG retest first (if we have one)
      if (setup.fvg) {
        const fvg = setup.fvg;
        const priceInFVG = (setup.side === 'BUY')
          ? (currentCandle.low <= fvg.high && currentCandle.high >= fvg.low)
          : (currentCandle.high >= fvg.low && currentCandle.low <= fvg.high);
        
        if (priceInFVG) {
          const hasRejection = isRejectionCandle(currentCandle, setup.side, fvg.high, fvg.low);
          
          if (hasRejection) {
            info('TREND', `${symbol} FVG retest rejection - entering!`, {
              side: setup.side,
              fvgZone: `${fvg.low.toFixed(isXAU ? 2 : 5)} - ${fvg.high.toFixed(isXAU ? 2 : 5)}`
            });
            
            // Calculate entry levels with SL 5-10 pips beyond FVG
            setup.entryPrice = currentCandle.close;
            const slBufferPips = isXAU ? 7 : isJPY ? 0.07 : 0.0007;  // 7 pips buffer
            setup.sl = setup.side === 'BUY' ? fvg.low - slBufferPips : fvg.high + slBufferPips;
            
            // Calculate TP with dynamic RR (2RR minimum, use structure if better)
            const slDistance = Math.abs(setup.entryPrice - setup.sl);
            const slPips = slDistance / pipSize;
            
            if (slPips < 5 || slPips > config.maxSlPips) {
              warn('TREND', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            }
            
            // Get structure TP
            const structureTP = await this.getM5StructureTP(symbol, setup.side);
            let structureRR = 0;
            if (structureTP) {
              const structureDistance = Math.abs(structureTP - setup.entryPrice);
              structureRR = structureDistance / slDistance;
            }
            
            // Dynamic TP: <1RR skip, 1-2RR extend to 2RR, >=2RR use structure
            if (structureRR >= 2) {
              setup.tp = structureTP!;
            } else if (structureRR > 1) {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            } else if (structureRR <= 1 && structureTP) {
              warn('TREND', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            } else {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            }
            
            setup.status = 'waiting_entry';
            await this.executeEntry(setup);
            this.failedSweepAttempts.set(symbol, 0);
            return;
          }
        }
      }
      
      // Check OB retest (if we have one and FVG didn't trigger)
      if (setup.orderBlock) {
        const ob = setup.orderBlock;
        const inOBZone = (setup.side === 'BUY')
          ? (currentCandle.low <= ob.bodyHigh && currentCandle.low >= ob.low)
          : (currentCandle.high >= ob.bodyLow && currentCandle.high <= ob.high);
        
        if (inOBZone) {
          const hasRejection = this.checkOBRejection(currentCandle, ob, setup.side);
          
          if (hasRejection) {
            info('TREND', `${symbol} OB retest rejection - entering!`, {
              side: setup.side,
              obZone: `${ob.low.toFixed(isXAU ? 2 : 5)} - ${ob.high.toFixed(isXAU ? 2 : 5)}`
            });
            
            // Calculate entry levels with SL 5-10 pips beyond OB
            setup.entryPrice = currentCandle.close;
            const slBufferPips = isXAU ? 7 : isJPY ? 0.07 : 0.0007;  // 7 pips buffer
            setup.sl = setup.side === 'BUY' ? ob.low - slBufferPips : ob.high + slBufferPips;
            
            // Calculate TP with dynamic RR
            const slDistance = Math.abs(setup.entryPrice - setup.sl);
            const slPips = slDistance / pipSize;
            
            if (slPips < 5 || slPips > config.maxSlPips) {
              warn('TREND', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            }
            
            // Get structure TP
            const structureTP = await this.getM5StructureTP(symbol, setup.side);
            let structureRR = 0;
            if (structureTP) {
              const structureDistance = Math.abs(structureTP - setup.entryPrice);
              structureRR = structureDistance / slDistance;
            }
            
            // Dynamic TP: <1RR skip, 1-2RR extend to 2RR, >=2RR use structure
            if (structureRR >= 2) {
              setup.tp = structureTP!;
            } else if (structureRR > 1) {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            } else if (structureRR <= 1 && structureTP) {
              warn('TREND', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
              this.pendingSetups.delete(symbol);
              return;
            } else {
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
            }
            
            setup.status = 'waiting_entry';
            await this.executeEntry(setup);
            this.failedSweepAttempts.set(symbol, 0);
            return;
          }
        }
      }
      
      // Expire trend setup after 12 bars (give price time to retrace)
      if (setup.candlesSinceSweep > 12) {
        info('TREND', `${symbol} trend setup expired - no retest (${setup.candlesSinceSweep} bars)`, {});;
        this.pendingSetups.delete(symbol);
        return;
      }
    }
    
    // Step 1.5: Wait for rejection candle at FVG before entering
    if (setup.status === 'waiting_rejection' && setup.fvg) {
      const fvg = setup.fvg;
      const currentCandle = candles[candles.length - 1];
      
      // Check if M5 swing level is broken (invalidation)
      if (setup.side === 'BUY' && setup.m5SwingLow) {
        if (currentPrice < setup.m5SwingLow) {
          warn('INVALIDATED', `${symbol} M5 swing low broken - setup invalidated`, {
            m5SwingLow: setup.m5SwingLow.toFixed(isXAU ? 2 : 5),
            currentPrice: currentPrice.toFixed(isXAU ? 2 : 5)
          });
          this.pendingSetups.delete(symbol);
          return;
        }
      }
      if (setup.side === 'SELL' && setup.m5SwingHigh) {
        if (currentPrice > setup.m5SwingHigh) {
          warn('INVALIDATED', `${symbol} M5 swing high broken - setup invalidated`, {
            m5SwingHigh: setup.m5SwingHigh.toFixed(isXAU ? 2 : 5),
            currentPrice: currentPrice.toFixed(isXAU ? 2 : 5)
          });
          this.pendingSetups.delete(symbol);
          return;
        }
      }
      
      // Check if price has retested FVG zone AND shows rejection
      const priceInFVG = (setup.side === 'BUY') 
        ? (currentCandle.low <= fvg.high)  // For buy, low touched FVG
        : (currentCandle.high >= fvg.low); // For sell, high touched FVG
      
      if (priceInFVG) {
        // Check for rejection candle
        const hasRejection = isRejectionCandle(currentCandle, setup.side, fvg.high, fvg.low);
        
        if (hasRejection) {
          info('REJECTION', `${symbol} rejection candle confirmed at FVG!`, {
            side: setup.side,
            candleOpen: currentCandle.open.toFixed(isXAU ? 2 : 5),
            candleClose: currentCandle.close.toFixed(isXAU ? 2 : 5),
            candleLow: currentCandle.low.toFixed(isXAU ? 2 : 5),
            candleHigh: currentCandle.high.toFixed(isXAU ? 2 : 5)
          });
          
          // NOW calculate proper levels using M5 swing low for SL
          setup.status = 'waiting_entry';
          
          // Entry at current close (rejection confirmed)
          setup.entryPrice = currentCandle.close;
          
          // SL below M5 swing low (for buys) with small buffer - TIGHTER SL for faster trades
          const slBuffer = isXAU ? 0.5 : isJPY ? 0.02 : 0.0002; // ~2 pips buffer (tighter)
          if (setup.side === 'BUY' && setup.m5SwingLow) {
            setup.sl = setup.m5SwingLow - slBuffer;
          } else if (setup.side === 'SELL' && setup.m5SwingHigh) {
            setup.sl = setup.m5SwingHigh + slBuffer;
          } else {
            // Fallback to FVG-based SL if M5 not available
            setup.sl = setup.side === 'BUY' 
              ? fvg.low - (config.maxSlPips * pipSize)
              : fvg.high + (config.maxSlPips * pipSize);
          }
          
          // Calculate SL distance in pips
          const slDistance = Math.abs(setup.entryPrice - setup.sl);
          const slPips = slDistance / pipSize;
          
          // SKIP TRADE: SL too tight (< 5 pips) - not enough room
          if (slPips < 5) {
            warn('REJECTION', `${symbol} SL too tight (${slPips.toFixed(1)} pips < 5) - skipping`, {
              m5SwingLevel: setup.side === 'BUY' ? setup.m5SwingLow : setup.m5SwingHigh
            });
            this.pendingSetups.delete(symbol);
            return;
          }
          
          // SKIP TRADE: SL too wide
          if (slPips > config.maxSlPips) {
            warn('REJECTION', `${symbol} SL too wide (${slPips.toFixed(1)} pips) - skipping`, {
              maxAllowed: config.maxSlPips
            });
            this.pendingSetups.delete(symbol);
            return;
          }
          
          // TP CALCULATION: Use M5 structure TP with 2RR minimum
          // Step 1: Calculate structure-based TP (M5 swing high/low)
          let structureTP = setup.m5StructureTP;
          let structureRR = 0;
          
          if (structureTP && setup.entryPrice) {
            const structureDistance = Math.abs(structureTP - setup.entryPrice);
            structureRR = structureDistance / slDistance;
          }
          
          // Step 2: Determine final TP based on RR rules
          // - If structure >= 2RR → use structure TP
          // - If structure > 1RR but < 2RR → extend to 2RR
          // - If structure <= 1RR → skip trade
          
          let finalRR = 2.0; // Minimum RR
          
          if (structureRR > 1) {
            if (structureRR >= 2) {
              // Structure gives 2RR or better - use it
              setup.tp = structureTP!;
              finalRR = structureRR;
              info('TP', `${symbol} using structure TP (${structureRR.toFixed(1)}RR)`, {
                structureTP: structureTP?.toFixed(isXAU ? 2 : 5)
              });
            } else {
              // Structure gives 1.x RR - extend to 2RR
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
              finalRR = 2.0;
              info('TP', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - extending to 2RR`, {
                structureTP: structureTP?.toFixed(isXAU ? 2 : 5),
                extendedTP: setup.tp.toFixed(isXAU ? 2 : 5)
              });
            }
          } else {
            // Structure <= 1RR - SKIP TRADE
            if (structureTP) {
              warn('REJECTION', `${symbol} structure TP only ${structureRR.toFixed(1)}RR (<=1) - skipping`, {
                structureTP: structureTP?.toFixed(isXAU ? 2 : 5),
                entry: setup.entryPrice.toFixed(isXAU ? 2 : 5),
                sl: setup.sl.toFixed(isXAU ? 2 : 5)
              });
              this.pendingSetups.delete(symbol);
              return;
            } else {
              // No structure TP found - use default 2RR
              setup.tp = setup.side === 'BUY'
                ? setup.entryPrice + (slDistance * 2.0)
                : setup.entryPrice - (slDistance * 2.0);
              finalRR = 2.0;
              info('TP', `${symbol} no structure TP found - using default 2RR`);
            }
          }
          
          info('REJECTION', `${symbol} entry levels calculated`, {
            entry: setup.entryPrice.toFixed(isXAU ? 2 : 5),
            sl: setup.sl.toFixed(isXAU ? 2 : 5),
            tp: setup.tp.toFixed(isXAU ? 2 : 5),
            slPips: slPips.toFixed(1),
            rr: finalRR.toFixed(1)
          });
          
          // Execute entry immediately
          await this.executeEntry(setup);
          this.failedSweepAttempts.set(symbol, 0);
          return;
        }
      }
    }
    
    // Step 2: Execute entry when setup is ready (has entry, SL, TP)
    // We use pending orders (limit/stop) so we don't need to wait for price
    // Note: continuation and trend_entry now wait for retest via waiting_continuation_retest and waiting_trend_retest
    if ((setup.status === 'waiting_entry' || setup.status === 'ready' || setup.status === 'pattern_entry') && 
        setup.entryPrice && setup.sl && setup.tp) {
      
      // First check if we MISSED the entry (price moved too far past in profit direction)
      const missedEntry = this.checkMissedEntry(setup, currentPrice, isXAU, pipSize);
      if (missedEntry) {
        warn('ENTRY', `${symbol} MISSED entry - price moved ${missedEntry.pipsAway.toFixed(1)} pips past entry`, {
          side: setup.side,
          entry: setup.entryPrice.toFixed(isXAU ? 2 : 5),
          current: currentPrice.toFixed(isXAU ? 2 : 5),
          direction: missedEntry.direction
        });
        this.pendingSetups.delete(symbol);
        return;
      }
      
      // Execute immediately - the order type (market/limit/stop) will be determined
      // based on current price vs entry price
      await this.executeEntry(setup);
      // Reset failed attempts on successful entry
      this.failedSweepAttempts.set(symbol, 0);
    }
  }
  
  /**
   * Check if price has moved too far past the entry level (missed the trade)
   * Returns null if entry still valid, or info about how far price moved
   */
  private checkMissedEntry(
    setup: PendingSetup, 
    currentPrice: number, 
    isXAU: boolean,
    pipSize: number
  ): { pipsAway: number; direction: string } | null {
    if (!setup.entryPrice) return null;
    
    const isJPY = isJPYSymbol(setup.symbol);
    
    // Miss distance - how far past entry (on the PROFIT side) before we consider it "missed"
    // This means price went THROUGH our entry and kept going in profit direction
    // 15 pips for FX, $2.00 for XAU, 15 pips for JPY
    const maxMissDistance = isXAU ? 20.0 : isJPY ? 0.15 : 0.0015;
    
    if (setup.side === 'BUY') {
      // For BUY LIMIT: entry is BELOW current price (waiting for price to come DOWN)
      // Price being ABOVE entry is NORMAL - we're still waiting
      // Only "missed" if price went BELOW entry and is now far BELOW (ran away without filling)
      // This happens if price dipped to our level but we didn't get filled and it kept dropping
      if (currentPrice < setup.entryPrice - maxMissDistance) {
        const pipsAway = (setup.entryPrice - currentPrice) / pipSize;
        return { pipsAway, direction: 'below (price dropped through entry)' };
      }
    } else {
      // For SELL LIMIT: entry is ABOVE current price (waiting for price to come UP)
      // Price being BELOW entry is NORMAL - we're still waiting  
      // Only "missed" if price went ABOVE entry and is now far ABOVE (ran away without filling)
      // This happens if price rallied to our level but we didn't get filled and it kept rising
      if (currentPrice > setup.entryPrice + maxMissDistance) {
        const pipsAway = (currentPrice - setup.entryPrice) / pipSize;
        return { pipsAway, direction: 'above (price rallied through entry)' };
      }
    }
    
    return null;
  }
  
  /**
   * Check if a setup should be invalidated (remove and start fresh)
   * Returns the reason string if invalid, null if still valid
   */
  private checkInvalidation(
    setup: PendingSetup,
    currentPrice: number,
    isXAU: boolean,
    isJPY: boolean,
    pipSize: number
  ): string | null {
    // SKIP all invalidation for pending_order status - these are already placed orders
    // The order itself will be monitored by monitorPendingOrders for SL/expiry
    if (setup.status === 'pending_order') {
      return null;  // Never invalidate pending orders through this check
    }
    
    // SKIP sweep-level invalidation for waiting_rejection - it uses M15 level instead
    // (M15 level invalidation is handled in the main loop with m15SwingLow/m15SwingHigh)
    if (setup.status === 'waiting_rejection') {
      // Only check time limit for waiting_rejection (60 minutes max)
      const ageMinutes = (Date.now() - setup.sweepTime.getTime()) / (1000 * 60);
      if (ageMinutes > 60) {
        return `waiting for rejection too long (${Math.round(ageMinutes)} min)`;
      }
      return null;  // M15 level check is done in processPendingSetup
    }
    
    // SKIP sweep-level invalidation for retest waits - they have their own expiry
    if (setup.status === 'waiting_continuation_retest' || setup.status === 'waiting_trend_retest') {
      // Only check time limit (60 minutes max for retest)
      const ageMinutes = (Date.now() - setup.sweepTime.getTime()) / (1000 * 60);
      if (ageMinutes > 60) {
        return `waiting for retest too long (${Math.round(ageMinutes)} min)`;
      }
      return null;  // Candle-based expiry is done in processPendingSetup
    }
    
    // 1. Price hit SL level (would have been stopped out)
    if (setup.sl) {
      if (setup.side === 'BUY' && currentPrice <= setup.sl) {
        return 'price hit SL level';
      }
      if (setup.side === 'SELL' && currentPrice >= setup.sl) {
        return 'price hit SL level';
      }
    }
    
    // 2. Setup too old - max 30 minutes (6 M5 candles) waiting for entry
    const ageMinutes = (Date.now() - setup.sweepTime.getTime()) / (1000 * 60);
    const maxAgeMinutes = 30;  // 30 min max wait for entry
    if (setup.status !== 'waiting_fvg' && ageMinutes > maxAgeMinutes) {
      return `setup too old (${Math.round(ageMinutes)} min)`;
    }
    
    // 3. For waiting_fvg status, max 40 minutes (already has candle-based expiry but add time limit too)
    if (setup.status === 'waiting_fvg' && ageMinutes > 40) {
      return `waiting for FVG too long (${Math.round(ageMinutes)} min)`;
    }
    
    // 4. Price moved too far against entry direction (structure broken)
    // For BUY: if price breaks significantly below sweep level, structure is broken
    // For SELL: if price breaks significantly above sweep level, structure is broken
    if (setup.status !== 'waiting_fvg') {
      const breakThreshold = isXAU ? 20.0 : isJPY ? 0.20 : 0.0020;  // 20 pips
      
      if (setup.side === 'BUY') {
        // If price breaks well below the sweep low, BUY is invalidated
        if (currentPrice < setup.sweepLevel - breakThreshold) {
          const pipsBelow = (setup.sweepLevel - currentPrice) / pipSize;
          return `price broke ${pipsBelow.toFixed(1)} pips below sweep level`;
        }
      } else {
        // If price breaks well above the sweep high, SELL is invalidated
        if (currentPrice > setup.sweepLevel + breakThreshold) {
          const pipsAbove = (currentPrice - setup.sweepLevel) / pipSize;
          return `price broke ${pipsAbove.toFixed(1)} pips above sweep level`;
        }
      }
    }
    
    return null;  // Setup is still valid
  }
  
  /**
   * Look for trend continuation entry when sweeps aren't working
   * Uses EMA crossover for trend direction and FVG/imbalance for entry
   */
  private async lookForTrendEntry(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    isXAU: boolean,
    pipSize: number,
    allowedDirections?: { allowBuy: boolean; allowSell: boolean; m15Trend: string; h1Trend: string }
  ): Promise<void> {
    // Calculate EMAs for trend direction on M5
    const emaFast = this.calculateEMA(candles, 9);
    const emaSlow = this.calculateEMA(candles, 21);
    
    if (!emaFast || !emaSlow) return;
    
    // Calculate separation for logging/strength tracking (but not for filtering)
    const emaSeparation = Math.abs(emaFast - emaSlow) / pipSize;
    
    // Simple crossover - no separation required since 4H already confirms direction
    // EMA 9 > EMA 21 = bullish, EMA 9 < EMA 21 = bearish
    let trendDirection: 'BUY' | 'SELL' | null = null;
    if (emaFast > emaSlow) {
      trendDirection = 'BUY';
    } else if (emaFast < emaSlow) {
      trendDirection = 'SELL';
    }
    
    if (!trendDirection) {
      // EMAs are exactly equal (very rare)
      return;
    }
    
    // Check if this direction is allowed by 4H trend (MTF)
    if (allowedDirections) {
      if (trendDirection === 'BUY' && !allowedDirections.allowBuy) {
        info('TREND', `${symbol} M5 trend is BUY but blocked by 4H`, {
          h4Trend: allowedDirections.h1Trend
        });
        return;
      }
      if (trendDirection === 'SELL' && !allowedDirections.allowSell) {
        info('TREND', `${symbol} M5 trend is SELL but blocked by 4H`, {
          h4Trend: allowedDirections.h1Trend
        });
        return;
      }
    }
    
    // Update trend state
    this.trendStates.set(symbol, {
      direction: trendDirection,
      emaFast,
      emaSlow,
      strength: emaSeparation,
      lastUpdate: new Date()
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // ZONE MANAGER: Continuously scan ALL zones in trend direction
    // Runs every tick to detect new zones and check reactions
    // ═══════════════════════════════════════════════════════════════════
    
    // Get breakers for this symbol
    const breakers = this.breakerZones.get(symbol) || [];
    
    // Update Zone Manager with all zones in trend direction (runs every tick)
    const zones = this.zoneManager.updateZones(symbol, candles, currentPrice, trendDirection, breakers);
    
    // Log zone summary with prices (every tick for visibility)
    const zoneSummary = this.zoneManager.getZoneSummary(symbol);
    const detailedZones = this.zoneManager.getDetailedZoneSummary(symbol, isXAU);
    
    if (zones.length > 0) {
      info('TREND_SCAN', `${symbol} ${trendDirection}: ${zoneSummary}`, {
        zones: detailedZones,
        closestZone: `${zones[0].type} at ${zones[0].midpoint.toFixed(isXAU ? 2 : 5)} (${zones[0].distancePips.toFixed(0)} pips)`,
        priceToZone: `${zones[0].distancePips.toFixed(0)} pips`
      });
      
      // Check each zone for reaction (enter on first strong rejection)
      for (const zone of zones) {
        const reaction = this.zoneManager.checkReaction(symbol, zone, candles, currentPrice);
        
        if (reaction.hasReaction && reaction.isRejection && reaction.strength >= 50) {
          // Strong rejection at zone - prepare entry
          const entryPrice = reaction.entryPrice || currentPrice;
          const config = isXAU ? this.config.xau : this.config.fx;
          const isJPY = isJPYSymbol(symbol);
          
          info('TREND_ZONE_ENTRY', `${symbol} ${zone.type.toUpperCase()} rejection in trend mode!`, {
            side: trendDirection,
            strength: reaction.strength,
            entryPrice: entryPrice.toFixed(isXAU ? 2 : 5)
          });
          
          // Get M5 swing for SL
          const m5SwingLevel = await this.getM5SwingLevel(symbol, trendDirection);
          
          // Calculate SL
          let sl: number;
          const slBuffer = isXAU ? 0.5 : isJPY ? 0.02 : 0.0002;
          
          if (m5SwingLevel) {
            sl = trendDirection === 'BUY' ? m5SwingLevel - slBuffer : m5SwingLevel + slBuffer;
          } else {
            // Fallback to zone-based SL
            sl = trendDirection === 'BUY' ? zone.low - (pipSize * 5) : zone.high + (pipSize * 5);
          }
          
          // Validate SL distance
          const slPips = Math.abs(entryPrice - sl) / pipSize;
          if (slPips < 5 || slPips > config.maxSlPips) {
            info('TREND_ZONE', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - trying next zone`, {});
            continue;
          }
          
          // Calculate TP with 2RR minimum
          const slDistance = Math.abs(entryPrice - sl);
          const m5StructureTP = await this.getM5StructureTP(symbol, trendDirection);
          
          let tp: number;
          if (m5StructureTP) {
            const structureDistance = Math.abs(m5StructureTP - entryPrice);
            const structureRR = structureDistance / slDistance;
            
            if (structureRR >= 2) {
              tp = m5StructureTP;
            } else {
              tp = trendDirection === 'BUY' 
                ? entryPrice + (slDistance * 2.0) 
                : entryPrice - (slDistance * 2.0);
            }
          } else {
            tp = trendDirection === 'BUY' 
              ? entryPrice + (slDistance * 2.0) 
              : entryPrice - (slDistance * 2.0);
          }
          
          // Create setup
          const currentCandleTime = candles[candles.length - 1].time;
          const setup: PendingSetup = {
            symbol,
            side: trendDirection,
            sweepLevel: zone.midpoint,
            sweepTime: new Date(),
            sweepSession: 'london',
            fvg: zone.type === 'fvg' ? zone.originalFVG! : null,
            orderBlock: zone.type === 'order_block' ? zone.originalOB : undefined,
            breakerZone: zone.type === 'breaker' ? zone.originalBreaker : undefined,
            candlesSinceSweep: 0,
            lastCandleTime: currentCandleTime,
            entryPrice,
            sl,
            tp,
            status: 'waiting_entry',  // Zone rejection already confirmed, ready to enter
            setupType: 'trend',
            m5SwingLow: trendDirection === 'BUY' && m5SwingLevel ? m5SwingLevel : undefined,
            m5SwingHigh: trendDirection === 'SELL' && m5SwingLevel ? m5SwingLevel : undefined,
            m5StructureTP: m5StructureTP ?? undefined
          };
          
          this.pendingSetups.set(symbol, setup);
          await this.executeEntry(setup);
          
          // Mark zone as used
          this.zoneManager.invalidateZone(symbol, zone.id);
          
          info('TREND', `${symbol} TREND ${trendDirection} entry via ${zone.type.toUpperCase()}`, {
            entry: entryPrice.toFixed(isXAU ? 2 : 5),
            sl: sl.toFixed(isXAU ? 2 : 5),
            tp: tp.toFixed(isXAU ? 2 : 5),
            zoneType: zone.type,
            rejectionStrength: reaction.strength
          });
          
          return;  // Found entry, exit
        }
        
        // Zone broken - log and continue to next
        if (reaction.hasReaction && !reaction.isRejection) {
          info('TREND_ZONE', `${symbol} ${zone.type} zone broken - checking next zone`, {
            reason: reaction.reason
          });
        }
      }
      
      // No zone entry yet - check if structure is broken
      if (this.zoneManager.isStructureBroken(symbol, trendDirection)) {
        info('TREND_STRUCTURE', `${symbol} all ${trendDirection} zones broken - resetting`, {});
        this.zoneManager.clearZones(symbol);
      }
    } else {
      // No zones in valid range (20-100 pips) - log scanning status
      info('TREND_SCAN', `${symbol} ${trendDirection}: No zones in 20-100 pip range - scanning...`, {
        price: currentPrice.toFixed(isXAU ? 2 : 5),
        allZones: detailedZones || 'none'
      });
    }
    
    // Fallback: Also look for FVG the traditional way (for cases when zone manager doesn't trigger)
    // Look for FVG in trend direction for entry
    const fvgs = detectFVG(candles);
    const trendFVG = fvgs.find(fvg => {
      if (trendDirection === 'BUY' && fvg.side === 'BULL') return true;
      if (trendDirection === 'SELL' && fvg.side === 'BEAR') return true;
      return false;
    });
    
    if (trendFVG) {
      const config = isXAU ? this.config.xau : this.config.fx;
      const currentCandleTime = candles[candles.length - 1].time;
      
      // Also look for Order Block
      const ob = findRelevantOB(candles, trendDirection, symbol);
      
      // Create trend entry setup - WAIT for retest, don't enter immediately!
      const setup: PendingSetup = {
        symbol,
        side: trendDirection,
        sweepLevel: trendDirection === 'BUY' ? trendFVG.low : trendFVG.high,
        sweepTime: new Date(),
        sweepSession: 'london',
        fvg: trendFVG,
        orderBlock: ob || undefined,
        candlesSinceSweep: 0,
        lastCandleTime: currentCandleTime,
        entryPrice: null,
        sl: null,
        tp: null,
        status: 'waiting_trend_retest',  // Wait for FVG/OB retest, don't enter immediately!
        setupType: 'trend',
        failedAttempts: 0
      };
      
      this.pendingSetups.set(symbol, setup);
      
      info('TREND', `${symbol} TREND ${trendDirection} setup created - waiting for FVG/OB retest`, {
        emaFast: emaFast.toFixed(5),
        emaSlow: emaSlow.toFixed(5),
        separation: emaSeparation.toFixed(1),
        fvgZone: `${trendFVG.low.toFixed(isXAU ? 2 : 5)} - ${trendFVG.high.toFixed(isXAU ? 2 : 5)}`,
        hasOB: !!ob,
        obZone: ob ? `${ob.low.toFixed(isXAU ? 2 : 5)} - ${ob.high.toFixed(isXAU ? 2 : 5)}` : 'none'
      });
      
      // Don't enter yet - wait for retest!
    } else {
      // No FVG from traditional detection either
      const zoneSummary = this.zoneManager.getZoneSummary(symbol);
      const detailedZones = this.zoneManager.getDetailedZoneSummary(symbol, isXAU);
      info('TREND', `${symbol} trend is ${trendDirection} - waiting for zone reaction`, {
        emaFast: emaFast.toFixed(isXAU ? 2 : 5),
        emaSlow: emaSlow.toFixed(isXAU ? 2 : 5),
        separation: emaSeparation.toFixed(1),
        zones: detailedZones || zoneSummary
      });
    }
  }

  /**
   * Look for Double/Triple Top and Bottom reversal patterns
   * These indicate trend exhaustion and potential reversal
   * NOTE: These patterns BYPASS the 4H trend filter because they are reversal signals
   */
  private async lookForReversalPattern(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    allowedDirections?: { allowBuy: boolean; allowSell: boolean; m15Trend: string; h1Trend: string }
  ): Promise<void> {
    // Detect reversal pattern
    const pattern = detectReversalPattern(candles, symbol);
    
    if (!pattern) return;
    
    // Double/Triple Top/Bottom patterns bypass MTF trend filter
    // They are reversal signals by nature and have their own safety (SL at pattern extreme, RR checks)
    info('PATTERN', `${symbol} ${pattern.type} detected - bypassing trend filter (reversal pattern)`, {
      side: pattern.side,
      strength: pattern.strength
    });
    
    // Only trade patterns with strength >= 50
    if (pattern.strength < 50) {
      info('PATTERN', `${symbol} ${pattern.type} found but strength too low (${pattern.strength})`, {});
      return;
    }
    
    const isXAU = isXAUSymbol(symbol);
    const pipSize = getPipSize(symbol);
    const config = isXAU ? this.config.xau : this.config.fx;
    
    // Check if SL is within limits
    const slDistance = pattern.side === 'BUY' 
      ? Math.abs(pattern.entryPrice - pattern.sl)
      : Math.abs(pattern.sl - pattern.entryPrice);
    const slPips = slDistance / pipSize;
    
    if (slPips > config.maxSlPips) {
      info('PATTERN', `${symbol} ${pattern.type} SL too large (${slPips.toFixed(1)} pips)`, {});
      return;
    }
    
    // Calculate R:R
    const tpDistance = Math.abs(pattern.tp - pattern.entryPrice);
    const rr = tpDistance / slDistance;
    
    if (rr < config.minRR) {
      info('PATTERN', `${symbol} ${pattern.type} R:R too low (${rr.toFixed(1)})`, {});
      return;
    }
    
    const currentCandleTime = candles[candles.length - 1].time;
    
    // Create setup for reversal pattern
    const setup: PendingSetup = {
      symbol,
      side: pattern.side,
      sweepLevel: pattern.side === 'BUY' ? pattern.patternLow : pattern.patternHigh,
      sweepTime: new Date(),
      sweepSession: 'london',
      fvg: null,
      reversalPattern: pattern,
      candlesSinceSweep: pattern.age,
      lastCandleTime: currentCandleTime,
      entryPrice: pattern.entryPrice,
      sl: pattern.sl,
      tp: pattern.tp,
      status: pattern.confirmed ? 'pattern_entry' : 'waiting_entry',
      setupType: pattern.type.toLowerCase().replace('_', '_') as SetupType,
      failedAttempts: 0
    };
    
    this.pendingSetups.set(symbol, setup);
    
    const patternName = pattern.type.replace('_', ' ');
    info('PATTERN', `${symbol} ${patternName} detected! Strength: ${pattern.strength}`, {
      side: pattern.side,
      neckline: pattern.neckline.toFixed(isXAU ? 2 : 5),
      entry: pattern.entryPrice.toFixed(isXAU ? 2 : 5),
      sl: pattern.sl.toFixed(isXAU ? 2 : 5),
      tp: pattern.tp.toFixed(isXAU ? 2 : 5),
      rr: rr.toFixed(1),
      confirmed: pattern.confirmed
    });
    
    // IMMEDIATELY place pending order for pattern setup
    // The order type will be determined based on current price vs entry
    if (setup.entryPrice && setup.sl && setup.tp) {
      info('PATTERN', `${symbol} placing pending order for ${patternName}`, {
        entry: setup.entryPrice,
        current: currentPrice,
        confirmed: pattern.confirmed
      });
      await this.executeEntry(setup);
    }
  }
  
  /**
   * Calculate EMA for given period
   */
  private calculateEMA(candles: Candle[], period: number): number | null {
    if (candles.length < period) return null;
    
    const multiplier = 2 / (period + 1);
    let ema = candles[0].close;
    
    for (let i = 1; i < candles.length; i++) {
      ema = (candles[i].close - ema) * multiplier + ema;
    }
    
    return ema;
  }

  /**
   * Get M5 swing low (for BUY setups) or swing high (for SELL setups)
   * Looks back ~2 hours (24 M5 candles) to find the significant low/high
   * This is used for SL placement and invalidation - TIGHTER than M15 for faster trades
   */
  private async getM5SwingLevel(symbol: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    try {
      // Get last 24 M5 candles (~2 hours) - tighter lookback than M15
      const m5Candles = await this.dataFeed.getRecentCandles(symbol, 'M5', 24);
      if (!m5Candles || m5Candles.length < 3) return null;
      
      if (side === 'BUY') {
        // Find the lowest low in the lookback period
        let lowestLow = m5Candles[0].low;
        for (const candle of m5Candles) {
          if (candle.low < lowestLow) {
            lowestLow = candle.low;
          }
        }
        return lowestLow;
      } else {
        // Find the highest high in the lookback period
        let highestHigh = m5Candles[0].high;
        for (const candle of m5Candles) {
          if (candle.high > highestHigh) {
            highestHigh = candle.high;
          }
        }
        return highestHigh;
      }
    } catch (err) {
      warn('M5', `${symbol} failed to get M5 swing level: ${err}`);
      return null;
    }
  }

  /**
   * Get M5 structure TP - the recent swing high (for BUY) or swing low (for SELL)
   * This finds a realistic take profit based on M5 structure
   * Looks forward in the opposite direction of trade for the TP target
   */
  private async getM5StructureTP(symbol: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    try {
      // Get last 48 M5 candles (~4 hours) to find structure
      const m5Candles = await this.dataFeed.getRecentCandles(symbol, 'M5', 48);
      if (!m5Candles || m5Candles.length < 10) return null;
      
      // For BUY: find the recent swing HIGH (our TP target)
      // For SELL: find the recent swing LOW (our TP target)
      
      if (side === 'BUY') {
        // Find swing high - look for a high that's higher than surrounding candles
        // Start from recent candles and work backward to find a valid swing high
        let bestSwingHigh = 0;
        
        for (let i = m5Candles.length - 3; i >= 2; i--) {
          const candle = m5Candles[i];
          const prevCandle = m5Candles[i - 1];
          const prevPrevCandle = m5Candles[i - 2];
          const nextCandle = m5Candles[i + 1];
          const nextNextCandle = m5Candles[i + 2];
          
          // Swing high: current high is higher than 2 candles before and after
          if (candle.high > prevCandle.high && 
              candle.high > prevPrevCandle.high &&
              candle.high > nextCandle.high &&
              candle.high > nextNextCandle.high) {
            if (candle.high > bestSwingHigh) {
              bestSwingHigh = candle.high;
            }
          }
        }
        
        // Fallback: if no swing high found, use highest high in range
        if (bestSwingHigh === 0) {
          for (const candle of m5Candles) {
            if (candle.high > bestSwingHigh) {
              bestSwingHigh = candle.high;
            }
          }
        }
        
        return bestSwingHigh > 0 ? bestSwingHigh : null;
      } else {
        // Find swing low - look for a low that's lower than surrounding candles
        let bestSwingLow = Infinity;
        
        for (let i = m5Candles.length - 3; i >= 2; i--) {
          const candle = m5Candles[i];
          const prevCandle = m5Candles[i - 1];
          const prevPrevCandle = m5Candles[i - 2];
          const nextCandle = m5Candles[i + 1];
          const nextNextCandle = m5Candles[i + 2];
          
          // Swing low: current low is lower than 2 candles before and after
          if (candle.low < prevCandle.low && 
              candle.low < prevPrevCandle.low &&
              candle.low < nextCandle.low &&
              candle.low < nextNextCandle.low) {
            if (candle.low < bestSwingLow) {
              bestSwingLow = candle.low;
            }
          }
        }
        
        // Fallback: if no swing low found, use lowest low in range
        if (bestSwingLow === Infinity) {
          for (const candle of m5Candles) {
            if (candle.low < bestSwingLow) {
              bestSwingLow = candle.low;
            }
          }
        }
        
        return bestSwingLow < Infinity ? bestSwingLow : null;
      }
    } catch (err) {
      warn('M5', `${symbol} failed to get M5 structure TP: ${err}`);
      return null;
    }
  }

  /**
   * Check if price is continuing in sweep direction instead of reversing
  /**
   * Check if sweep level has been broken (price closed through)
   * This converts a failed sweep into a breaker zone opportunity
   */
  private checkSweepBroken(
    setup: PendingSetup,
    candles: Candle[],
    currentPrice: number,
    pipSize: number
  ): boolean {
    const currentCandle = candles[candles.length - 1];
    const breakThreshold = pipSize * 10; // Need 10+ pips break to confirm
    
    if (setup.side === 'BUY') {
      // BUY setup means we swept LOW - if price CLOSES below sweep low, it's broken
      if (currentCandle.close < setup.sweepLevel - breakThreshold) {
        return true;
      }
    } else {
      // SELL setup means we swept HIGH - if price CLOSES above sweep high, it's broken
      if (currentCandle.close > setup.sweepLevel + breakThreshold) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check for rejection at Order Block zone
   */
  private checkOBRejection(
    candle: Candle,
    ob: OrderBlock,
    side: 'BUY' | 'SELL'
  ): boolean {
    const bodyHigh = Math.max(candle.open, candle.close);
    const bodyLow = Math.min(candle.open, candle.close);
    const upperWick = candle.high - bodyHigh;
    const lowerWick = bodyLow - candle.low;
    const candleBody = bodyHigh - bodyLow;
    const candleRange = candle.high - candle.low;
    
    // Need some body size to be valid
    if (candleBody < candleRange * 0.2) return false;
    
    if (side === 'BUY') {
      // Bullish OB rejection: wick into OB zone, body above, bullish close
      const wickedIntoOB = candle.low <= ob.bodyHigh && candle.low >= ob.low;
      const bodyAboveOB = bodyLow >= ob.bodyLow;
      const bullishClose = candle.close > candle.open;
      const lowerWickDominant = lowerWick > upperWick;
      
      return wickedIntoOB && bodyAboveOB && bullishClose && lowerWickDominant;
    } else {
      // Bearish OB rejection: wick into OB zone, body below, bearish close
      const wickedIntoOB = candle.high >= ob.bodyLow && candle.high <= ob.high;
      const bodyBelowOB = bodyHigh <= ob.bodyHigh;
      const bearishClose = candle.close < candle.open;
      const upperWickDominant = upperWick > lowerWick;
      
      return wickedIntoOB && bodyBelowOB && bearishClose && upperWickDominant;
    }
  }

  /**
   * Check for breaker block retest and setup entry if valid
   */
  private async checkBreakerEntries(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    allowedDirections?: { allowBuy: boolean; allowSell: boolean; m15Trend: string; h1Trend: string }
  ): Promise<void> {
    const zones = this.breakerZones.get(symbol);
    if (!zones || zones.length === 0) return;
    
    const isXAU = isXAUSymbol(symbol);
    const isJPY = isJPYSymbol(symbol);
    const pipSize = getPipSize(symbol);
    const config = isXAU ? this.config.xau : this.config.fx;
    
    // Update zones based on current price action
    const updatedZones = updateBreakerZones(zones, currentPrice, candles);
    this.breakerZones.set(symbol, updatedZones);
    
    // Check each zone for retest entry
    for (const zone of updatedZones) {
      // Check trend alignment - breakers need 4H trend confirmation
      if (allowedDirections) {
        if (zone.tradeSide === 'BUY' && !allowedDirections.allowBuy) continue;
        if (zone.tradeSide === 'SELL' && !allowedDirections.allowSell) continue;
      }
      
      // Check for retest entry
      const entry = checkBreakerRetest(zone, candles, currentPrice, symbol);
      if (!entry) continue;
      
      // Validate SL distance
      const slPips = Math.abs(entry.entryPrice - entry.sl) / pipSize;
      if (slPips < 5 || slPips > config.maxSlPips) {
        continue;
      }
      
      // Valid breaker entry!
      info('BREAKER', `${symbol} valid breaker retest entry`, {
        side: entry.zone.tradeSide,
        entry: entry.entryPrice.toFixed(isXAU ? 2 : 5),
        sl: entry.sl.toFixed(isXAU ? 2 : 5),
        tp: entry.tp.toFixed(isXAU ? 2 : 5),
        rr: entry.rr.toFixed(1)
      });
      
      // Create pending setup for breaker
      const setup: PendingSetup = {
        symbol,
        side: entry.zone.tradeSide,
        sweepLevel: entry.zone.level,
        sweepTime: new Date(),
        sweepSession: 'london',
        fvg: null,
        breakerZone: entry.zone,
        candlesSinceSweep: 0,
        lastCandleTime: candles[candles.length - 1].time,
        entryPrice: entry.entryPrice,
        sl: entry.sl,
        tp: entry.tp,
        status: 'waiting_entry',
        setupType: 'breaker'
      };
      
      this.pendingSetups.set(symbol, setup);
      await this.executeEntry(setup);
      
      // Remove used zone
      const remainingZones = updatedZones.filter(z => z !== zone);
      this.breakerZones.set(symbol, remainingZones);
      
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ZONE-BASED ENTRY (CONTINUOUS ZONE SCANNING)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Check all zones (FVG, OB, Breaker) for reaction-based entry
   * This is the new continuous zone scanning approach:
   * - Scan ALL zones in valid range (20-100 pips)
   * - Cluster nearby zones (<20 pips apart)
   * - Enter on strong rejection at ANY zone
   * - Skip zone and move to next if weak reaction or break
   * - Stop looking when all zones break (structure failure)
   */
  private async checkZoneEntries(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    tradeSide: 'BUY' | 'SELL',
    allowedDirections?: { allowBuy: boolean; allowSell: boolean; m15Trend: string; h1Trend: string }
  ): Promise<boolean> {
    const isXAU = isXAUSymbol(symbol);
    const isJPY = isJPYSymbol(symbol);
    const pipSize = getPipSize(symbol);
    const config = isXAU ? this.config.xau : this.config.fx;
    
    // Check trend alignment
    if (allowedDirections) {
      if (tradeSide === 'BUY' && !allowedDirections.allowBuy) return false;
      if (tradeSide === 'SELL' && !allowedDirections.allowSell) return false;
    }
    
    // Get breakers for this symbol
    const breakers = this.breakerZones.get(symbol) || [];
    
    // Update zones with latest candle data
    const zones = this.zoneManager.updateZones(symbol, candles, currentPrice, tradeSide, breakers);
    
    if (zones.length === 0) {
      return false;
    }
    
    // Log zone summary periodically with prices
    const summary = this.zoneManager.getZoneSummary(symbol);
    const detailed = this.zoneManager.getDetailedZoneSummary(symbol, isXAU);
    info('ZONES', `${symbol} ${tradeSide}: ${summary}`, {
      zones: detailed,
      closestZone: zones[0] ? `${zones[0].type} at ${zones[0].midpoint.toFixed(isXAU ? 2 : 5)} (${zones[0].distancePips.toFixed(0)} pips)` : 'none'
    });
    
    // Cluster zones
    const clusters = this.zoneManager.clusterZones(symbol, zones);
    
    // Check each zone for reaction
    for (const zone of zones) {
      const reaction = this.zoneManager.checkReaction(symbol, zone, candles, currentPrice);
      
      if (!reaction.hasReaction) continue;
      
      // Check if zone is broken
      if (!reaction.isRejection) {
        info('ZONE_BROKEN', `${symbol} ${zone.type} zone broken - skipping to next zone`, {
          zoneMid: zone.midpoint.toFixed(isXAU ? 2 : 5),
          reason: reaction.reason
        });
        continue;
      }
      
      // REJECTION DETECTED - prepare entry
      if (reaction.isRejection && reaction.strength >= 50) {
        const entryPrice = reaction.entryPrice || currentPrice;
        
        info('ZONE_REJECTION', `${symbol} ${zone.type} rejection detected!`, {
          side: tradeSide,
          strength: reaction.strength,
          entryPrice: entryPrice.toFixed(isXAU ? 2 : 5),
          zone: `${zone.low.toFixed(isXAU ? 2 : 5)} - ${zone.high.toFixed(isXAU ? 2 : 5)}`
        });
        
        // Get M5 swing for SL
        const m5SwingLevel = await this.getM5SwingLevel(symbol, tradeSide);
        
        // Calculate SL
        let sl: number;
        const slBuffer = isXAU ? 0.5 : isJPY ? 0.02 : 0.0002;
        
        if (m5SwingLevel) {
          sl = tradeSide === 'BUY' ? m5SwingLevel - slBuffer : m5SwingLevel + slBuffer;
        } else {
          // Fallback to zone-based SL
          sl = tradeSide === 'BUY' ? zone.low - (pipSize * 5) : zone.high + (pipSize * 5);
        }
        
        // Validate SL distance
        const slPips = Math.abs(entryPrice - sl) / pipSize;
        if (slPips < 5 || slPips > config.maxSlPips) {
          warn('ZONE_ENTRY', `${symbol} SL invalid (${slPips.toFixed(1)} pips) - skipping`, {});
          continue;
        }
        
        // Get structure TP
        const m5StructureTP = await this.getM5StructureTP(symbol, tradeSide);
        const slDistance = Math.abs(entryPrice - sl);
        
        // Calculate TP with 2RR minimum
        let tp: number;
        if (m5StructureTP) {
          const structureDistance = Math.abs(m5StructureTP - entryPrice);
          const structureRR = structureDistance / slDistance;
          
          if (structureRR >= 2) {
            tp = m5StructureTP;
          } else if (structureRR > 1) {
            tp = tradeSide === 'BUY' 
              ? entryPrice + (slDistance * 2.0) 
              : entryPrice - (slDistance * 2.0);
          } else {
            warn('ZONE_ENTRY', `${symbol} structure TP only ${structureRR.toFixed(1)}RR - skipping`, {});
            continue;
          }
        } else {
          tp = tradeSide === 'BUY' 
            ? entryPrice + (slDistance * 2.0) 
            : entryPrice - (slDistance * 2.0);
        }
        
        // Create setup
        const setup: PendingSetup = {
          symbol,
          side: tradeSide,
          sweepLevel: zone.midpoint,
          sweepTime: new Date(),
          sweepSession: 'london',
          fvg: zone.type === 'fvg' ? zone.originalFVG! : null,
          orderBlock: zone.type === 'order_block' ? zone.originalOB : undefined,
          breakerZone: zone.type === 'breaker' ? zone.originalBreaker : undefined,
          candlesSinceSweep: 0,
          lastCandleTime: candles[candles.length - 1].time,
          entryPrice,
          sl,
          tp,
          status: 'waiting_entry',
          setupType: zone.type === 'fvg' ? 'reversal' : zone.type === 'order_block' ? 'order_block' : 'breaker',
          m5SwingLow: tradeSide === 'BUY' && m5SwingLevel ? m5SwingLevel : undefined,
          m5SwingHigh: tradeSide === 'SELL' && m5SwingLevel ? m5SwingLevel : undefined,
          m5StructureTP: m5StructureTP ?? undefined
        };
        
        this.pendingSetups.set(symbol, setup);
        await this.executeEntry(setup);
        
        // Mark zone as used
        this.zoneManager.invalidateZone(symbol, zone.id);
        
        return true;
      }
    }
    
    // Check if all zones are broken (structure failure)
    if (this.zoneManager.isStructureBroken(symbol, tradeSide)) {
      info('STRUCTURE_BROKEN', `${symbol} all ${tradeSide} zones broken - structure failure`, {});
      this.zoneManager.clearZones(symbol);
      return false;
    }
    
    return false;
  }

  /**
   * Check for continuation pattern after sweep
   * TWO ways to detect continuation:
   * 1. Price makes new highs/lows beyond sweep (strong momentum)
   * 2. Price retests sweep level and bounces in sweep direction (retest continuation)
   */
  private checkContinuation(
    setup: PendingSetup, 
    currentPrice: number, 
    pipSize: number,
    config: { minSweepPips: number; maxSlPips: number; minRR: number; maxRR: number }
  ): boolean {
    // Only check after 2+ bars (give some time for price action)
    if (setup.candlesSinceSweep < 2) return false;
    
    const continuationThreshold = config.minSweepPips; // Reduced threshold
    
    if (setup.side === 'SELL') {
      // Original was looking for sell (swept high)
      // CONTINUATION UP patterns:
      
      // Pattern 1: Price made new highs after sweep (strong momentum up)
      const newHighPips = (setup.highestAfterSweep! - setup.sweepLevel) / pipSize;
      if (newHighPips >= continuationThreshold) {
        info('CONTINUATION', `${setup.symbol} strong momentum UP after sweep high`, {
          newHighPips: newHighPips.toFixed(1),
          threshold: continuationThreshold
        });
        setup.side = 'BUY';
        return true;
      }
      
      // Pattern 2: Price came back to sweep level and bounced UP (retest continuation)
      // Check if price dipped to sweep level and is now above it
      const dippedToSweep = setup.lowestAfterSweep! <= setup.sweepLevel + (3 * pipSize);
      const bouncedUp = currentPrice > setup.sweepLevel + (config.minSweepPips * pipSize);
      
      if (dippedToSweep && bouncedUp && setup.candlesSinceSweep >= 3) {
        info('CONTINUATION', `${setup.symbol} retest bounce UP - swept high, retested, continuing up`, {
          sweepLevel: setup.sweepLevel,
          lowestAfterSweep: setup.lowestAfterSweep,
          currentPrice
        });
        setup.side = 'BUY';
        return true;
      }
    } else {
      // Original was looking for buy (swept low)
      // CONTINUATION DOWN patterns:
      
      // Pattern 1: Price made new lows after sweep (strong momentum down)
      const newLowPips = (setup.sweepLevel - setup.lowestAfterSweep!) / pipSize;
      if (newLowPips >= continuationThreshold) {
        info('CONTINUATION', `${setup.symbol} strong momentum DOWN after sweep low`, {
          newLowPips: newLowPips.toFixed(1),
          threshold: continuationThreshold
        });
        setup.side = 'SELL';
        return true;
      }
      
      // Pattern 2: Price came back to sweep level and bounced DOWN (retest continuation)
      const spikeedToSweep = setup.highestAfterSweep! >= setup.sweepLevel - (3 * pipSize);
      const bouncedDown = currentPrice < setup.sweepLevel - (config.minSweepPips * pipSize);
      
      if (spikeedToSweep && bouncedDown && setup.candlesSinceSweep >= 3) {
        info('CONTINUATION', `${setup.symbol} retest bounce DOWN - swept low, retested, continuing down`, {
          sweepLevel: setup.sweepLevel,
          highestAfterSweep: setup.highestAfterSweep,
          currentPrice
        });
        setup.side = 'SELL';
        return true;
      }
    }
    
    return false;
  }

  private calculateLevels(setup: PendingSetup, isXAU: boolean, pipSize: number): void {
    if (!setup.fvg) return;
    
    const config = isXAU ? this.config.xau : this.config.fx;
    const fvg = setup.fvg;
    
    // Entry: inside FVG with buffer
    const fvgSize = fvg.high - fvg.low;
    const buffer = fvgSize * this.config.fvg.retestBuffer;
    
    // Get session levels to target the opposite side
    const sessionLevels = this.sessionManager.getPreviousSessionLevels(setup.symbol);
    
    if (setup.side === 'BUY') {
      // Buy: enter near FVG low, target session high
      setup.entryPrice = fvg.low + buffer;
      setup.sl = fvg.low - (config.maxSlPips * pipSize);
      const slDistance = setup.entryPrice - setup.sl;
      
      // Target: session high (we swept low, so target high)
      // If session high available, use it; otherwise use max R:R
      let targetPrice = setup.entryPrice + (slDistance * config.maxRR);
      
      if (sessionLevels && sessionLevels.high > setup.entryPrice) {
        // Target the session high
        targetPrice = sessionLevels.high;
      }
      
      // Calculate actual R:R
      const tpDistance = targetPrice - setup.entryPrice;
      const actualRR = tpDistance / slDistance;
      
      // Clamp R:R between min and max
      if (actualRR < config.minRR) {
        // R:R too low, use minimum
        setup.tp = setup.entryPrice + (slDistance * config.minRR);
      } else if (actualRR > config.maxRR) {
        // R:R too high, cap at maximum
        setup.tp = setup.entryPrice + (slDistance * config.maxRR);
      } else {
        // Use session level as target
        setup.tp = targetPrice;
      }
    } else {
      // Sell: enter near FVG high, target session low
      setup.entryPrice = fvg.high - buffer;
      setup.sl = fvg.high + (config.maxSlPips * pipSize);
      const slDistance = setup.sl - setup.entryPrice;
      
      // Target: session low (we swept high, so target low)
      let targetPrice = setup.entryPrice - (slDistance * config.maxRR);
      
      if (sessionLevels && sessionLevels.low < setup.entryPrice) {
        // Target the session low
        targetPrice = sessionLevels.low;
      }
      
      // Calculate actual R:R
      const tpDistance = setup.entryPrice - targetPrice;
      const actualRR = tpDistance / slDistance;
      
      // Clamp R:R between min and max
      if (actualRR < config.minRR) {
        // R:R too low, use minimum
        setup.tp = setup.entryPrice - (slDistance * config.minRR);
      } else if (actualRR > config.maxRR) {
        // R:R too high, cap at maximum
        setup.tp = setup.entryPrice - (slDistance * config.maxRR);
      } else {
        // Use session level as target
        setup.tp = targetPrice;
      }
    }
    
    setup.status = 'waiting_entry';  // Ready to trigger when price hits entry
  }

  private checkEntry(setup: PendingSetup, currentPrice: number): boolean {
    if (!setup.entryPrice) return false;
    
    const symbol = setup.symbol;
    const isXAU = isXAUSymbol(symbol);
    const isJPY = isJPYSymbol(symbol);
    const pipSize = getPipSize(symbol);
    
    // Entry tolerance - how far past entry we'll still execute
    // This catches retests where price touches and bounces
    // 5 pips for FX, 50 cents for XAU, 5 pips for JPY
    const entryTolerance = isXAU ? 5.0 : isJPY ? 0.05 : 0.0005;
    
    // Max slip - don't enter if we're too far in profit direction already (missed the fill)
    const maxSlip = isXAU ? 8.0 : isJPY ? 0.08 : 0.0008;  // 8 pips max
    
    if (setup.side === 'BUY') {
      // For BUY: We want price to come DOWN to entry or slightly past
      // Entry zone: from (entry - entryTolerance) up to (entry + maxSlip)
      // So if entry is 1.1000, we enter between 1.0995 and 1.1008
      
      const lowerBound = setup.entryPrice - entryTolerance;  // Slightly below entry (touching it)
      const upperBound = setup.entryPrice + maxSlip;          // Allow some slip above entry
      
      const atEntry = currentPrice >= lowerBound && currentPrice <= upperBound;
      const pipsAway = (currentPrice - setup.entryPrice) / pipSize;
      
      // Log when close
      if (Math.abs(pipsAway) <= (isXAU ? 100 : 15)) {
        info('ENTRY_CHECK', `${setup.symbol} BUY check`, {
          current: currentPrice.toFixed(isXAU ? 2 : isJPY ? 3 : 5),
          entry: setup.entryPrice.toFixed(isXAU ? 2 : isJPY ? 3 : 5),
          pipsAway: pipsAway.toFixed(1),
          zone: `${lowerBound.toFixed(isXAU ? 2 : 5)} to ${upperBound.toFixed(isXAU ? 2 : 5)}`,
          atEntry,
          reason: atEntry ? '✅ IN ZONE - ENTERING!' : (currentPrice > upperBound ? 'ABOVE ZONE - missed' : 'BELOW ZONE - waiting')
        });
      }
      
      return atEntry;
    } else {
      // For SELL: We want price to come UP to entry or slightly past
      // Entry zone: from (entry - maxSlip) up to (entry + entryTolerance)
      // So if entry is 1.1000, we enter between 1.0992 and 1.1005
      
      const lowerBound = setup.entryPrice - maxSlip;          // Allow some slip below entry
      const upperBound = setup.entryPrice + entryTolerance;   // Slightly above entry (touching it)
      
      const atEntry = currentPrice >= lowerBound && currentPrice <= upperBound;
      const pipsAway = (setup.entryPrice - currentPrice) / pipSize;
      
      // Log when close
      if (Math.abs(pipsAway) <= (isXAU ? 100 : 15)) {
        info('ENTRY_CHECK', `${setup.symbol} SELL check`, {
          current: currentPrice.toFixed(isXAU ? 2 : isJPY ? 3 : 5),
          entry: setup.entryPrice.toFixed(isXAU ? 2 : isJPY ? 3 : 5),
          pipsAway: pipsAway.toFixed(1),
          zone: `${lowerBound.toFixed(isXAU ? 2 : 5)} to ${upperBound.toFixed(isXAU ? 2 : 5)}`,
          atEntry,
          reason: atEntry ? '✅ IN ZONE - ENTERING!' : (currentPrice < lowerBound ? 'BELOW ZONE - missed' : 'ABOVE ZONE - waiting')
        });
      }
      
      return atEntry;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ORDER EXECUTION
  // ═══════════════════════════════════════════════════════════════════

  private async executeEntry(setup: PendingSetup): Promise<void> {
    if (!setup.entryPrice || !setup.sl || !setup.tp) return;
    
    const { symbol, side, entryPrice, sl, tp } = setup;
    
    // CRITICAL: Check database first to prevent duplicate orders
    if (this.orderDB.hasPendingOrder(symbol)) {
      const existingOrder = this.orderDB.getPendingOrder(symbol);
      if (existingOrder) {
        info('ENTRY', `${symbol} already has pending order in DB - syncing setup`, {
          ticket: existingOrder.ticket
        });
        // CRITICAL FIX: Sync setup status with the existing order!
        setup.pendingOrderTicket = existingOrder.ticket;
        setup.pendingOrderType = existingOrder.type;
        setup.pendingOrderPlacedAt = new Date(existingOrder.placedAt);
        setup.status = 'pending_order';
      }
      return;
    }
    
    // Check if we already have an open position on this symbol
    const openPositions = await this.connector.getOpenPositions(symbol);
    if (openPositions && openPositions.length > 0) {
      warn('ENTRY', `${symbol} already has ${openPositions.length} open position(s) - skipping`);
      this.pendingSetups.delete(symbol);
      return;
    }
    
    // Check for conflicting correlated pair trades
    const correlationConflict = this.checkCorrelationConflict(symbol, side);
    if (correlationConflict) {
      warn('ENTRY', `${symbol} ${side} blocked - correlation conflict with ${correlationConflict.symbol} ${correlationConflict.side}`);
      this.pendingSetups.delete(symbol);
      return;
    }
    
    // Check multi-timeframe trend confirmation (M15 or H1 must agree)
    const mtfCheck = await this.checkMTFTrendAlignment(symbol, side);
    if (!mtfCheck.aligned) {
      warn('ENTRY', `${symbol} ${side} blocked - MTF trend not aligned`, {
        m15Trend: mtfCheck.m15Trend,
        h1Trend: mtfCheck.h1Trend,
        required: side
      });
      this.pendingSetups.delete(symbol);
      return;
    }
    info('ENTRY', `${symbol} ${side} MTF confirmed`, { m15: mtfCheck.m15Trend, h1: mtfCheck.h1Trend });
    
    // Also check for existing pending orders ON MT5
    const pendingOrders = await this.connector.getPendingOrders(symbol);
    if (pendingOrders && pendingOrders.length > 0) {
      // If this setup already has a pending order, that's fine - just return
      if (setup.status === 'pending_order' && setup.pendingOrderTicket) {
        // Our order is already placed, nothing to do
        return;
      }
      
      // Check if any of these orders match our entry (bot may have placed it previously)
      const matchingOrder = pendingOrders.find(o => {
        const priceDiff = Math.abs(o.price_open - entryPrice);
        const tolerance = isXAUSymbol(symbol) ? 1.0 : isJPYSymbol(symbol) ? 0.05 : 0.0005;
        return priceDiff <= tolerance;
      });
      
      if (matchingOrder) {
        // This looks like our order - sync with it
        info('ENTRY', `${symbol} found matching MT5 pending order - syncing`, {
          ticket: matchingOrder.ticket,
          price: matchingOrder.price_open,
          ourEntry: entryPrice
        });
        
        // Save to database
        this.orderDB.addPendingOrder({
          ticket: matchingOrder.ticket,
          symbol,
          type: matchingOrder.type_description || setup.pendingOrderType || 'LIMIT',
          side,
          entryPrice: matchingOrder.price_open,
          sl: matchingOrder.sl || sl,
          tp: matchingOrder.tp || tp,
          volume: matchingOrder.volume,
          placedAt: new Date().toISOString(),
          setupType: setup.setupType
        });
        
        // Update setup
        setup.pendingOrderTicket = matchingOrder.ticket;
        setup.pendingOrderType = matchingOrder.type_description || 'LIMIT';
        setup.pendingOrderPlacedAt = new Date();
        setup.status = 'pending_order';
        return;
      }
      
      // Otherwise, there's a conflicting order - don't create another
      warn('ENTRY', `${symbol} already has ${pendingOrders.length} pending order(s) - skipping`);
      this.pendingSetups.delete(symbol);
      return;
    }
    
    // Get current tick for spread check and order type determination
    const tick = await this.connector.getTick(symbol);
    if (!tick) {
      warn('ENTRY', `${symbol} no tick data`);
      return;
    }
    
    const spread = tick.ask - tick.bid;
    const isXAU = isXAUSymbol(symbol);
    const isJPY = isJPYSymbol(symbol);
    const pipSize = getPipSize(symbol);
    const maxSpread = isXAU 
      ? this.config.xau.maxSpreadCents / 100 
      : isJPY 
        ? this.config.fx.maxSpreadPips * 0.01   // JPY pairs: 0.01 per pip
        : this.config.fx.maxSpreadPips * 0.0001; // Standard FX: 0.0001 per pip
    
    if (spread > maxSpread) {
      warn('ENTRY', `${symbol} spread too high: ${spread}`, { maxSpread });
      return;
    }
    
    // Current price for order type determination
    const currentPrice = side === 'BUY' ? tick.ask : tick.bid;
    
    // Determine order type: Market, Limit, or Stop
    // Tolerance for "at market" execution - VERY tight, only if basically at entry
    const marketTolerance = isXAU ? 0.5 : isJPY ? 0.02 : 0.0002;  // 5 pips XAU ($0.50), 2 pips JPY, 2 pips FX
    const orderType = this.orderManager.getOrderType(side, entryPrice, currentPrice, marketTolerance);
    
    // Get real account balance from MT5
    const accountInfo = await this.connector.getAccountInfo();
    const balance = accountInfo?.balance ?? 10000;
    
    if (!accountInfo) {
      warn('ENTRY', `${symbol} could not get account info - using fallback balance`);
    }
    
    // Calculate volume - read risk from config file per symbol category (FX/XAU/Indices)
    const slPips = Math.abs(entryPrice - sl) / pipSize;
    const riskPercent = getRiskForSymbol(symbol);
    const volume = computeVolume(balance, riskPercent, slPips, symbol, currentPrice);
    
    info('ENTRY', `Placing ${orderType} for ${symbol}`, {
      entry: entryPrice.toFixed(isXAU ? 2 : 5),
      current: currentPrice.toFixed(isXAU ? 2 : 5),
      sl: sl.toFixed(isXAU ? 2 : 5),
      tp: tp.toFixed(isXAU ? 2 : 5),
      volume,
      slPips: slPips.toFixed(1),
      orderType,
      balance: balance.toFixed(2),
      riskPercent
    });
    
    try {
      let result;
      
      if (orderType === 'BUY' || orderType === 'SELL') {
        // Execute at market immediately
        result = await this.orderManager.placeMarketOrder({
          symbol,
          type: side,
          volume,
          sl,
          tp,
          comment: `SweepFVG_${setup.setupType}`
        });
        
        if (result && result.ticket) {
          // Build entry reason for logging
          const mode = this.getTradingMode(symbol);
          const zoneType = setup.fvg ? 'FVG' : setup.orderBlock ? 'OB' : setup.breakerZone ? 'Breaker' : 'unknown';
          const entryReason = setup.setupType.includes('double') || setup.setupType.includes('triple') 
            ? setup.setupType.replace('_', ' ') 
            : `${zoneType} in ${mode} mode`;
          
          info('TRADE', `${symbol} ${side} MARKET order opened`, {
            ticket: result.ticket,
            entry: result.price,
            sl,
            tp,
            volume,
            reason: entryReason,
            setupType: setup.setupType,
            mode
          });
          
          // Mark the sweep level as used so we don't re-enter same zone
          this.markLevelUsed(symbol, setup.sweepLevel, side);
          
          // Track open trade for monitoring
          this.openTrades.set(symbol, {
            ticket: result.ticket,
            symbol,
            side,
            entry: result.price || entryPrice,
            sl,
            tp,
            openTime: new Date()
          });
          
          // Update trade count
          this.incrementTradeCount(symbol);
          
          // Clear setup since trade is open
          this.pendingSetups.delete(symbol);
          
          // Send to dashboard
          await this.sendTradeToAPI({
            symbol,
            side,
            entry: result.price || entryPrice,
            sl,
            tp,
            volume,
            ticket: result.ticket
          }, setup);
        }
      } else {
        // Place pending order (limit or stop)
        info('ENTRY', `${symbol} attempting to place ${orderType} pending order...`, {
          entry: entryPrice,
          sl,
          tp,
          volume
        });
        
        result = await this.orderManager.placePendingOrder({
          symbol,
          type: orderType,
          volume,
          price: entryPrice,
          sl,
          tp,
          comment: `SweepFVG_${setup.setupType}`
        });
        
        info('ENTRY', `${symbol} pending order API response`, {
          success: result?.success,
          order: result?.order,
          deal: result?.deal,
          ticket: result?.ticket
        });
        
        if (result && result.order) {
          // Build entry reason for logging
          const mode = this.getTradingMode(symbol);
          const zoneType = setup.fvg ? 'FVG' : setup.orderBlock ? 'OB' : setup.breakerZone ? 'Breaker' : 'unknown';
          const entryReason = setup.setupType.includes('double') || setup.setupType.includes('triple') 
            ? setup.setupType.replace('_', ' ') 
            : `${zoneType} in ${mode} mode`;
          
          info('TRADE', `${symbol} ${orderType} pending order placed`, {
            ticket: result.order,
            entry: entryPrice,
            sl,
            tp,
            volume,
            reason: entryReason,
            setupType: setup.setupType,
            mode
          });
          
          // Save to persistent database FIRST (survives restarts)
          this.orderDB.addPendingOrder({
            ticket: result.order,
            symbol,
            type: orderType,
            side,
            entryPrice,
            sl,
            tp,
            volume,
            placedAt: new Date().toISOString(),
            setupType: setup.setupType
          });
          
          // Track pending order in setup - DON'T delete setup yet
          setup.pendingOrderTicket = result.order;
          setup.pendingOrderType = orderType;
          setup.pendingOrderPlacedAt = new Date();
          setup.status = 'pending_order';
          
          // Send updated setup to dashboard
          await this.sendSetupToAPI(symbol, setup, currentPrice);
        } else {
          // Order failed to place - mark setup as failed to prevent infinite retry loop
          warn('ENTRY', `${symbol} pending order returned no ticket - invalidating setup`, {
            result: JSON.stringify(result)
          });
          this.pendingSetups.delete(symbol);
        }
      }
    } catch (err: any) {
      warn('ENTRY', `${symbol} order failed: ${err.message}`);
      // On exception, also delete setup to prevent infinite retry
      this.pendingSetups.delete(symbol);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private canTrade(symbol: string): boolean {
    // Check daily limit
    const totalToday = Array.from(this.tradesToday.values()).reduce((a, b) => a + b, 0);
    if (totalToday >= this.config.maxTradesPerDay) {
      return false;
    }
    
    // Check per-symbol limit
    const symbolCount = this.tradesToday.get(symbol) || 0;
    if (symbolCount >= this.config.maxTradesPerSymbol) {
      return false;
    }
    
    // Check if we already have a pending setup for this symbol
    if (this.pendingSetups.has(symbol)) {
      return false;
    }
    
    // CRITICAL: Check if there's a pending order in the database (survives restarts)
    // This prevents placing duplicate orders after restart
    if (this.orderDB.hasPendingOrder(symbol)) {
      return false;
    }
    
    // Check cooldown - don't re-enter immediately after a trade closes
    const lastClosedTime = this.recentlyClosedTrades.get(symbol);
    if (lastClosedTime) {
      const minutesSinceClosed = (Date.now() - lastClosedTime) / (1000 * 60);
      if (minutesSinceClosed < this.COOLDOWN_MINUTES) {
        // Still in cooldown
        return false;
      } else {
        // Cooldown expired, remove from map
        this.recentlyClosedTrades.delete(symbol);
      }
    }
    
    // Check cancel cooldown - don't re-place orders immediately after cancellation (prevents loop)
    const lastCancelledTime = this.recentlyCancelledOrders.get(symbol);
    if (lastCancelledTime) {
      const minutesSinceCancelled = (Date.now() - lastCancelledTime) / (1000 * 60);
      if (minutesSinceCancelled < this.CANCEL_COOLDOWN_MINUTES) {
        // Still in cancel cooldown - this is the key to breaking the loop
        return false;
      } else {
        // Cooldown expired, remove from map
        this.recentlyCancelledOrders.delete(symbol);
      }
    }
    
    return true;
  }

  /**
   * Mark a symbol as recently closed (start cooldown)
   */
  private markTradeClosed(symbol: string): void {
    this.recentlyClosedTrades.set(symbol, Date.now());
    info('COOLDOWN', `${symbol} trade closed - cooldown for ${this.COOLDOWN_MINUTES} mins`, {});
  }
  
  /**
   * Check if a new trade would conflict with existing open trades on correlated pairs
   * Returns the conflicting trade info if blocked, null if OK to proceed
   */
  private checkCorrelationConflict(symbol: string, side: 'BUY' | 'SELL'): { symbol: string; side: 'BUY' | 'SELL' } | null {
    // Normalize symbol (remove suffix like 'z')
    const baseSymbol = symbol.replace(/z$/i, '').toUpperCase();
    
    // Check against all open trades
    for (const [openSymbol, trade] of this.openTrades) {
      const openBaseSymbol = openSymbol.replace(/z$/i, '').toUpperCase();
      
      // Find correlation rule
      for (const rule of CORRELATION_PAIRS) {
        const isMatch = 
          (rule.pairA === baseSymbol && rule.pairB === openBaseSymbol) ||
          (rule.pairB === baseSymbol && rule.pairA === openBaseSymbol);
        
        if (isMatch) {
          // Check for conflict based on correlation type
          if (rule.inverse) {
            // Inverse correlation: same direction = conflict
            // e.g., BUY EURUSD + BUY USDCHF = bad (they move opposite)
            if (side === trade.side) {
              return { symbol: openSymbol, side: trade.side };
            }
          } else {
            // Positive correlation: opposite direction = conflict
            // e.g., BUY EURUSD + SELL GBPUSD = bad (they move together)
            if (side !== trade.side) {
              return { symbol: openSymbol, side: trade.side };
            }
          }
        }
      }
    }
    
    return null;  // No conflict
  }
  
  /**
   * Check if 4H timeframe agrees with the entry direction using EMA 5/10 crossover
   * Simple logic: EMA 5 > EMA 10 = bullish (BUY), EMA 5 < EMA 10 = bearish (SELL)
   */
  private async checkMTFTrendAlignment(
    symbol: string, 
    side: 'BUY' | 'SELL'
  ): Promise<{ aligned: boolean; m15Trend: string; h1Trend: string }> {
    // Get H4 trend using EMA 5/10 crossover
    let h4Trend: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    try {
      const h4Candles = await this.dataFeed.getRecentCandles(symbol, 'H4', 20);
      if (h4Candles && h4Candles.length >= 10) {
        const ema5 = this.calculateEMA(h4Candles, 5);
        const ema10 = this.calculateEMA(h4Candles, 10);
        
        if (ema5 && ema10) {
          // Simple crossover: EMA 5 > EMA 10 = bullish, EMA 5 < EMA 10 = bearish
          if (ema5 > ema10) {
            h4Trend = 'BUY';
          } else if (ema5 < ema10) {
            h4Trend = 'SELL';
          }
        }
      }
    } catch (err) {
      warn('H4_TREND', `${symbol} failed to get H4 candles for alignment check: ${err}`);
    }
    
    // H4 trend must match entry direction
    const aligned = h4Trend === side;
    
    return {
      aligned,
      m15Trend: h4Trend,  // Using H4 value for logging compatibility
      h1Trend: h4Trend    // Using H4 value for logging compatibility
    };
  }
  
  /**
   * Determine which trade directions are allowed based on 4H EMA 5/10 crossover
   * SIMPLE LOGIC: 
   * - EMA 5 > EMA 10 = Bullish → Only BUYS allowed
   * - EMA 5 < EMA 10 = Bearish → Only SELLS allowed
   * This is used EARLY in the scanning process to filter what setups to look for
   */
  private async getAllowedDirections(symbol: string): Promise<{ 
    allowBuy: boolean; 
    allowSell: boolean; 
    m15Trend: string;  // Kept for logging compatibility, now shows H4 trend
    h1Trend: string    // Kept for logging compatibility, now shows H4 trend
  }> {
    // Get H4 trend using EMA 5/10 crossover
    let h4Trend: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    try {
      const h4Candles = await this.dataFeed.getRecentCandles(symbol, 'H4', 20);
      if (h4Candles && h4Candles.length >= 10) {
        const ema5 = this.calculateEMA(h4Candles, 5);
        const ema10 = this.calculateEMA(h4Candles, 10);
        
        if (ema5 && ema10) {
          // Simple crossover: EMA 5 > EMA 10 = bullish, EMA 5 < EMA 10 = bearish
          if (ema5 > ema10) {
            h4Trend = 'BUY';
          } else if (ema5 < ema10) {
            h4Trend = 'SELL';
          }
          
          info('H4_TREND', `${symbol} H4 EMA 5/10 trend: ${h4Trend}`, {
            ema5: ema5.toFixed(5),
            ema10: ema10.toFixed(5)
          });
        }
      }
    } catch (err) {
      warn('H4_TREND', `${symbol} failed to get H4 candles: ${err}`);
    }
    
    // Determine allowed directions based on H4 trend
    // STRICT: Only trade in direction of 4H EMA crossover
    let allowBuy = false;
    let allowSell = false;
    
    if (h4Trend === 'BUY') {
      // H4 bullish - only look for buys
      allowBuy = true;
      allowSell = false;
    } else if (h4Trend === 'SELL') {
      // H4 bearish - only look for sells
      allowBuy = false;
      allowSell = true;
    } else {
      // H4 neutral (EMAs equal or very close) - allow both but this is rare
      allowBuy = true;
      allowSell = true;
    }
    
    // Return with m15Trend and h1Trend set to h4Trend for logging compatibility
    return { allowBuy, allowSell, m15Trend: h4Trend, h1Trend: h4Trend };
  }
  
  /**
   * Mark a symbol as recently cancelled (start cancel cooldown to prevent loop)
   */
  private markOrderCancelled(symbol: string): void {
    this.recentlyCancelledOrders.set(symbol, Date.now());
    info('COOLDOWN', `${symbol} order cancelled - cooldown for ${this.CANCEL_COOLDOWN_MINUTES} mins to prevent loop`, {});
  }

  private incrementTradeCount(symbol: string): void {
    const current = this.tradesToday.get(symbol) || 0;
    this.tradesToday.set(symbol, current + 1);
  }

  private resetDailyCountsIfNeeded(now: Date): void {
    const today = now.toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.tradesToday.clear();
      this.lastResetDate = today;
      info('STRATEGY', 'Daily trade counts reset');
    }
  }

  /**
   * Send setup status to dashboard for live visualization
   */
  private async sendSetupToAPI(symbol: string, setup: PendingSetup | null, currentPrice?: number): Promise<void> {
    try {
      // Include mode and timer info
      const mode = this.getTradingMode(symbol);
      const sessionStart = this.sessionStartTime.get(symbol);
      const now = new Date();
      const minutesInSession = sessionStart ? Math.floor((now.getTime() - sessionStart.getTime()) / (1000 * 60)) : 0;
      const sweepTimeRemaining = Math.max(0, this.SWEEP_WINDOW_MINUTES - minutesInSession);
      
      const payload = setup ? {
        status: setup.status === 'waiting_fvg' ? 'sweep_detected' : 
                setup.status === 'waiting_entry' ? 'fvg_formed' : 
                setup.status === 'waiting_rejection' ? 'fvg_formed' :
                setup.status === 'waiting_continuation_retest' ? 'waiting_retest' :
                setup.status === 'waiting_trend_retest' ? 'waiting_retest' :
                setup.status === 'pending_order' ? 'pending_order' :
                setup.status === 'waiting_ob' ? 'waiting_ob' :
                setup.status === 'waiting_breaker_retest' ? 'waiting_breaker_retest' :
                setup.status === 'ready' ? 'waiting_entry' : 
                setup.setupType === 'order_block' ? 'order_block' :
                setup.setupType === 'breaker' ? 'breaker' : 'scanning',
        symbol,
        side: setup.side,
        currentPrice: currentPrice || 0,
        sweepLevel: setup.sweepLevel,
        fvgHigh: setup.fvg?.high,
        fvgLow: setup.fvg?.low,
        fvgSide: setup.fvg?.side,
        // Order Block info
        obHigh: setup.orderBlock?.high,
        obLow: setup.orderBlock?.low,
        obStrength: setup.orderBlock?.strength,
        // Breaker zone info
        breakerLevel: setup.breakerZone?.level,
        breakerSide: setup.breakerZone?.side,
        entryPrice: setup.entryPrice,
        sl: setup.sl,
        tp: setup.tp,
        sweepCandlesAgo: setup.candlesSinceSweep,
        maxCandlesToWait: this.config.fvg.maxAgeBars,
        detectedAt: setup.sweepTime.toISOString(),
        updatedAt: new Date().toISOString(),
        setupType: setup.setupType || 'reversal',
        tradingMode: mode,
        sweepTimeRemaining: mode === 'sweep' ? sweepTimeRemaining : 0,
        // Pending order info
        pendingOrderTicket: setup.pendingOrderTicket,
        pendingOrderType: setup.pendingOrderType,
        pendingOrderPlacedAt: setup.pendingOrderPlacedAt?.toISOString()
      } : {
        status: 'scanning',
        symbol,
        side: null,
        currentPrice: currentPrice || 0,
        updatedAt: new Date().toISOString(),
        tradingMode: mode,
        sweepTimeRemaining: mode === 'sweep' ? sweepTimeRemaining : 0
      };

      await fetch('http://localhost:3001/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, setup: payload })
      });
    } catch (err) {
      // Silent fail - don't block trading
    }
  }

  private async sendTradeToAPI(trade: TradeResult, setup?: PendingSetup): Promise<void> {
    try {
      // Build entry reason string
      let entryReason = 'Unknown';
      let zoneType = 'unknown';
      let zonePrice = 0;
      
      if (setup) {
        const mode = this.getTradingMode(trade.symbol);
        zoneType = setup.fvg ? 'fvg' : setup.orderBlock ? 'order_block' : setup.breakerZone ? 'breaker' : 'unknown';
        
        if (setup.fvg) {
          zonePrice = (setup.fvg.high + setup.fvg.low) / 2;
          entryReason = mode === 'sweep' ? 'FVG after sweep' : 'FVG in trend mode';
        } else if (setup.orderBlock) {
          zonePrice = (setup.orderBlock.bodyHigh + setup.orderBlock.bodyLow) / 2;
          entryReason = mode === 'sweep' ? 'Order Block after sweep' : 'Order Block in trend mode';
        } else if (setup.breakerZone) {
          zonePrice = setup.breakerZone.level;
          entryReason = mode === 'sweep' ? 'Breaker retest after sweep' : 'Breaker retest in trend mode';
        } else if (setup.setupType.includes('double') || setup.setupType.includes('triple')) {
          entryReason = `${setup.setupType.replace('_', ' ')} pattern`;
        } else if (setup.setupType === 'continuation') {
          entryReason = 'Continuation after failed reversal';
        } else if (setup.setupType === 'trend') {
          entryReason = 'Trend mode entry';
        }
      }
      
      const mode = this.getTradingMode(trade.symbol);
      
      const response = await fetch('http://localhost:3001/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry,
          sl: trade.sl,
          tp: trade.tp,
          volume: trade.volume,
          ticket: trade.ticket,
          openTime: new Date().toISOString(),
          status: 'open',
          strategy: 'SweepFVG',
          // Enhanced fields
          setupType: setup?.setupType || 'unknown',
          tradingMode: mode,
          entryReason,
          zoneType,
          zonePrice,
          patternType: setup?.reversalPattern?.type || null
        })
      });
    } catch (err) {
      // Silent fail - don't block trading
    }
  }

  private async sendTradeCloseToAPI(
    trade: { ticket: number; symbol: string; side: 'BUY' | 'SELL'; entry: number; sl: number; tp: number; openTime: Date },
    closePrice: number,
    pnlPips: number,
    result: 'win' | 'loss' | 'breakeven'
  ): Promise<void> {
    try {
      await fetch('http://localhost:3001/api/trades/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: trade.ticket,
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry,
          closePrice,
          pnlPips,
          result,
          closeTime: new Date().toISOString(),
          status: 'closed'
        })
      });
    } catch (err) {
      // Silent fail
    }
  }

  private async sendOpenTradeUpdate(
    trade: { ticket: number; symbol: string; side: 'BUY' | 'SELL'; entry: number; sl: number; tp: number },
    currentPrice: number,
    unrealizedPips: number
  ): Promise<void> {
    try {
      await fetch('http://localhost:3001/api/trades/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: trade.ticket,
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry,
          currentPrice,
          unrealizedPips,
          sl: trade.sl,
          tp: trade.tp,
          status: 'open'
        })
      });
    } catch (err) {
      // Silent fail
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS (for dashboard)
  // ═══════════════════════════════════════════════════════════════════

  getPendingSetups(): Map<string, PendingSetup> {
    return this.pendingSetups;
  }

  getTradeCountToday(): number {
    return Array.from(this.tradesToday.values()).reduce((a, b) => a + b, 0);
  }

  getConfig(): StrategyConfig {
    return this.config;
  }
}

export { StrategyConfig };
