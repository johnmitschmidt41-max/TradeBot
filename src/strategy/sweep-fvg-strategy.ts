// src/strategy/sweep-fvg-strategy.ts
// New modular strategy: Liquidity Sweep + FVG Entry
// Targets 7-12 trades/day with ~70% win rate

import { DataFeed } from "../core/data-feed";
import { OrderManager } from "../core/order-manager";
import { MT5Connector } from "../core/mt5-connector";
import { detectFVG, FVG } from "../detectors/fvg-detector";
import { computeVolume } from "../core/position-sizing";
import { getSessionManager, SessionManager, SessionName } from "../core/session-manager";
import { info, warn } from "../utils/logger";
import { Candle } from "../utils/types";

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

const DEFAULT_CONFIG: StrategyConfig = {
  symbols: ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz'],
  entryTimeframe: 'M5',
  riskPercent: 1.0,
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

type SetupType = 'reversal' | 'continuation' | 'trend';

interface PendingSetup {
  symbol: string;
  side: 'BUY' | 'SELL';
  sweepLevel: number;
  sweepTime: Date;
  sweepSession: SessionName;
  fvg: FVG | null;
  candlesSinceSweep: number;
  lastCandleTime: number;      // Track candle time to only count new candles
  entryPrice: number | null;
  sl: number | null;
  tp: number | null;
  status: 'waiting_fvg' | 'waiting_entry' | 'ready' | 'continuation' | 'trend_entry';
  setupType: SetupType;
  highestAfterSweep?: number;  // Track momentum after sweep
  lowestAfterSweep?: number;
  failedAttempts?: number;     // Track failed sweep/reversal attempts
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
  
  // Config for mode switching
  private readonly SWEEP_WINDOW_MINUTES = 120;  // 2 hours to find sweeps
  private readonly MAX_SWEEP_FAILURES = 3;      // Switch after 3 failures

  constructor(private connector: MT5Connector, config?: Partial<StrategyConfig>) {
    this.dataFeed = new DataFeed(connector);
    this.orderManager = new OrderManager(connector);
    this.sessionManager = getSessionManager(DEFAULT_CONFIG.symbols);
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize all symbols in sweep mode
    for (const symbol of this.config.symbols) {
      this.tradingMode.set(symbol, 'sweep');
    }
    
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
          } else if (pending.status === 'continuation' && pending.entryPrice) {
            analysis.push(`${symbol} ${modeTag}: CONTINUATION ${pending.side}! Entry at ${pending.entryPrice.toFixed(5)}`);
          } else if (pending.status === 'trend_entry' && pending.entryPrice) {
            analysis.push(`${symbol} ${modeTag}: TREND ${pending.side}! Entry at ${pending.entryPrice.toFixed(5)}`);
          } else if (pending.status === 'waiting_entry' && pending.entryPrice) {
            analysis.push(`${symbol} ${modeTag}: REVERSAL ${pending.side}! Entry at ${pending.entryPrice.toFixed(5)}`);
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
    
    // Log status every 30 seconds
    this.logStatusUpdate(now);
    
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
    // Check trade limits
    if (!this.canTrade(symbol)) {
      return;
    }
    
    // Skip if not in valid session for this symbol
    if (!this.sessionManager.isTradingTime(symbol, now)) {
      // Send scanning status when outside trading hours
      await this.sendSetupToAPI(symbol, null);
      return;
    }
    
    // Get candle data
    const candles = await this.dataFeed.getRecentCandles(symbol, this.config.entryTimeframe, 50);
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
      // Process existing setup and send update to dashboard
      await this.processPendingSetup(symbol, pending, candles, currentPrice);
      await this.sendSetupToAPI(symbol, pending, currentPrice);
    } else {
      // Check trading mode for this symbol
      const mode = this.getTradingMode(symbol);
      const isXAU = symbol.includes('XAU');
      const pipSize = isXAU ? 0.1 : 0.0001;
      
      if (mode === 'sweep') {
        // SWEEP MODE: Look for session level sweeps
        await this.lookForSweep(symbol, candles, activeSessions);
      } else {
        // TREND MODE: Look for trend continuation entries
        await this.lookForTrendEntry(symbol, candles, currentPrice, isXAU, pipSize);
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
    activeSessions: SessionName[]
  ): Promise<void> {
    const isXAU = symbol.includes('XAU');
    const pipSize = isXAU ? 0.1 : 0.0001;
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
          // High swept = look for SELL
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
          // Low swept = look for BUY
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
    // Only increment candle count when we see a NEW candle (different time)
    const currentCandleTime = candles[candles.length - 1].time;
    if (currentCandleTime !== setup.lastCandleTime) {
      setup.candlesSinceSweep++;
      setup.lastCandleTime = currentCandleTime;
    }
    
    // Track price extremes after sweep for continuation detection
    if (setup.highestAfterSweep === undefined) setup.highestAfterSweep = currentPrice;
    if (setup.lowestAfterSweep === undefined) setup.lowestAfterSweep = currentPrice;
    setup.highestAfterSweep = Math.max(setup.highestAfterSweep, currentPrice);
    setup.lowestAfterSweep = Math.min(setup.lowestAfterSweep, currentPrice);
    
    const isXAU = symbol.includes('XAU');
    const pipSize = isXAU ? 0.1 : 0.0001;
    const config = isXAU ? this.config.xau : this.config.fx;
    
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
        setup.status = 'waiting_entry';
        setup.setupType = 'reversal';
        
        // Calculate entry, SL, TP
        this.calculateLevels(setup, isXAU, pipSize);
        
        info('FVG', `${symbol} reversal FVG detected`, {
          side: setup.side,
          fvgHigh: validFVG.high,
          fvgLow: validFVG.low,
          entry: setup.entryPrice,
          sl: setup.sl,
          tp: setup.tp
        });
      } else {
        // No reversal FVG - check for CONTINUATION pattern
        // If price continues strongly in sweep direction, look for continuation entry
        const continuationDetected = this.checkContinuation(setup, currentPrice, pipSize, config);
        
        if (continuationDetected) {
          setup.setupType = 'continuation';
          setup.status = 'continuation';
          
          // Calculate continuation entry levels
          this.calculateContinuationLevels(setup, currentPrice, isXAU, pipSize);
          
          info('CONTINUATION', `${symbol} continuation detected - no reversal, going with trend`, {
            originalSide: setup.side,
            newSide: setup.side === 'BUY' ? 'SELL' : 'BUY',  // Flip direction
            entry: setup.entryPrice,
            sl: setup.sl,
            tp: setup.tp
          });
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
    
    // Step 2: Check for entry (reversal, continuation, or trend)
    if ((setup.status === 'waiting_entry' || setup.status === 'continuation' || setup.status === 'trend_entry') && 
        setup.entryPrice && setup.sl && setup.tp) {
      const shouldEnter = this.checkEntry(setup, currentPrice);
      
      if (shouldEnter) {
        await this.executeEntry(setup);
        // Reset failed attempts on successful entry
        this.failedSweepAttempts.set(symbol, 0);
      }
    }
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
    pipSize: number
  ): Promise<void> {
    // Calculate EMAs for trend direction
    const emaFast = this.calculateEMA(candles, 9);
    const emaSlow = this.calculateEMA(candles, 21);
    
    if (!emaFast || !emaSlow) return;
    
    const emaSeparation = Math.abs(emaFast - emaSlow) / pipSize;
    const minSeparation = isXAU ? 10 : 5; // Minimum EMA separation in pips
    
    // Determine trend direction
    let trendDirection: 'BUY' | 'SELL' | null = null;
    if (emaFast > emaSlow && emaSeparation >= minSeparation) {
      trendDirection = 'BUY';
    } else if (emaFast < emaSlow && emaSeparation >= minSeparation) {
      trendDirection = 'SELL';
    }
    
    if (!trendDirection) {
      info('TREND', `${symbol} no clear trend - EMA separation ${emaSeparation.toFixed(1)} pips (need ${minSeparation})`, {});
      return;
    }
    
    // Update trend state
    this.trendStates.set(symbol, {
      direction: trendDirection,
      emaFast,
      emaSlow,
      strength: emaSeparation,
      lastUpdate: new Date()
    });
    
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
      
      // Create trend entry setup
      const setup: PendingSetup = {
        symbol,
        side: trendDirection,
        sweepLevel: trendDirection === 'BUY' ? trendFVG.low : trendFVG.high,
        sweepTime: new Date(),
        sweepSession: 'london',
        fvg: trendFVG,
        candlesSinceSweep: 0,
        lastCandleTime: currentCandleTime,  // Use actual candle time
        entryPrice: null,
        sl: null,
        tp: null,
        status: 'trend_entry',
        setupType: 'trend',
        failedAttempts: 0
      };
      
      // Calculate entry levels for trend trade
      const fvgSize = trendFVG.high - trendFVG.low;
      const buffer = fvgSize * 0.3;
      
      if (trendDirection === 'BUY') {
        setup.entryPrice = trendFVG.low + buffer;
        setup.sl = trendFVG.low - (config.maxSlPips * pipSize);
        const slDistance = setup.entryPrice - setup.sl;
        setup.tp = setup.entryPrice + (slDistance * config.minRR);
      } else {
        setup.entryPrice = trendFVG.high - buffer;
        setup.sl = trendFVG.high + (config.maxSlPips * pipSize);
        const slDistance = setup.sl - setup.entryPrice;
        setup.tp = setup.entryPrice - (slDistance * config.minRR);
      }
      
      this.pendingSetups.set(symbol, setup);
      
      info('TREND', `${symbol} TREND ${trendDirection} setup created`, {
        emaFast: emaFast.toFixed(5),
        emaSlow: emaSlow.toFixed(5),
        separation: emaSeparation.toFixed(1),
        fvgHigh: trendFVG.high,
        fvgLow: trendFVG.low,
        entry: setup.entryPrice?.toFixed(5),
        sl: setup.sl?.toFixed(5),
        tp: setup.tp?.toFixed(5)
      });
    } else {
      info('TREND', `${symbol} trend is ${trendDirection} but no FVG for entry yet`, {
        emaFast: emaFast.toFixed(5),
        emaSlow: emaSlow.toFixed(5),
        separation: emaSeparation.toFixed(1)
      });
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
   * Check if price is continuing in sweep direction instead of reversing
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

  /**
   * Calculate entry levels for continuation trade (retest of sweep level)
   */
  private calculateContinuationLevels(
    setup: PendingSetup,
    currentPrice: number,
    isXAU: boolean,
    pipSize: number
  ): void {
    const config = isXAU ? this.config.xau : this.config.fx;
    
    if (setup.side === 'BUY') {
      // Continuation UP - enter on retest of sweep level (now support)
      setup.entryPrice = setup.sweepLevel + (2 * pipSize); // Slightly above sweep level
      setup.sl = setup.sweepLevel - (config.maxSlPips * pipSize);
      const slDistance = setup.entryPrice - setup.sl;
      setup.tp = setup.entryPrice + (slDistance * config.minRR);
    } else {
      // Continuation DOWN - enter on retest of sweep level (now resistance)
      setup.entryPrice = setup.sweepLevel - (2 * pipSize); // Slightly below sweep level
      setup.sl = setup.sweepLevel + (config.maxSlPips * pipSize);
      const slDistance = setup.sl - setup.entryPrice;
      setup.tp = setup.entryPrice - (slDistance * config.minRR);
    }
    
    setup.status = 'waiting_entry';
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
    
    setup.status = 'ready';
  }

  private checkEntry(setup: PendingSetup, currentPrice: number): boolean {
    if (!setup.entryPrice) return false;
    
    const isXAU = setup.symbol.includes('XAU');
    const pipSize = isXAU ? 0.1 : 0.0001;
    const tolerance = isXAU ? 0.5 : 0.00005;
    
    if (setup.side === 'BUY') {
      // Price should come down to entry
      const pipsAway = (currentPrice - setup.entryPrice) / pipSize;
      
      if (pipsAway > 0 && pipsAway < 20) {
        info('ENTRY', `${setup.symbol} BUY waiting - price ${pipsAway.toFixed(1)} pips above entry`, {
          current: currentPrice.toFixed(5),
          entry: setup.entryPrice.toFixed(5),
          sl: setup.sl?.toFixed(5),
          tp: setup.tp?.toFixed(5)
        });
      }
      
      return currentPrice <= setup.entryPrice + tolerance;
    } else {
      // Price should come up to entry
      const pipsAway = (setup.entryPrice - currentPrice) / pipSize;
      
      if (pipsAway > 0 && pipsAway < 20) {
        info('ENTRY', `${setup.symbol} SELL waiting - price ${pipsAway.toFixed(1)} pips below entry`, {
          current: currentPrice.toFixed(5),
          entry: setup.entryPrice.toFixed(5),
          sl: setup.sl?.toFixed(5),
          tp: setup.tp?.toFixed(5)
        });
      }
      
      return currentPrice >= setup.entryPrice - tolerance;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ORDER EXECUTION
  // ═══════════════════════════════════════════════════════════════════

  private async executeEntry(setup: PendingSetup): Promise<void> {
    if (!setup.entryPrice || !setup.sl || !setup.tp) return;
    
    const { symbol, side, entryPrice, sl, tp } = setup;
    
    // Check if we already have an open position on this symbol
    const openPositions = await this.connector.getOpenPositions(symbol);
    if (openPositions && openPositions.length > 0) {
      warn('ENTRY', `${symbol} already has ${openPositions.length} open position(s) - skipping`);
      this.pendingSetups.delete(symbol);
      return;
    }
    
    // Check spread
    const tick = await this.connector.getTick(symbol);
    if (!tick) {
      warn('ENTRY', `${symbol} no tick data`);
      return;
    }
    
    const spread = tick.ask - tick.bid;
    const isXAU = symbol.includes('XAU');
    const maxSpread = isXAU 
      ? this.config.xau.maxSpreadCents / 100 
      : this.config.fx.maxSpreadPips * 0.0001;
    
    if (spread > maxSpread) {
      warn('ENTRY', `${symbol} spread too high: ${spread}`, { maxSpread });
      return;
    }
    
    // Get real account balance from MT5
    const accountInfo = await this.connector.getAccountInfo();
    const balance = accountInfo?.balance ?? 10000; // Fallback to 10k if unavailable
    
    if (!accountInfo) {
      warn('ENTRY', `${symbol} could not get account info - using fallback balance`);
    }
    
    // Calculate volume
    const slPips = Math.abs(entryPrice - sl) / (isXAU ? 0.1 : 0.0001);
    const volume = computeVolume(balance, this.config.riskPercent, slPips, symbol);
    
    // Place order
    info('ENTRY', `Placing ${side} order for ${symbol}`, {
      entry: entryPrice,
      sl,
      tp,
      volume,
      slPips: slPips.toFixed(1)
    });
    
    try {
      const result = await this.orderManager.placeMarketOrder({
        symbol,
        type: side,
        volume,
        sl,
        tp,
        comment: `SweepFVG_${setup.sweepSession}`
      });
      
      if (result && result.ticket) {
        info('TRADE', `${symbol} ${side} opened`, {
          ticket: result.ticket,
          entry: result.price,
          sl,
          tp,
          volume
        });
        
        // Update trade count
        this.incrementTradeCount(symbol);
        
        // Send to dashboard
        await this.sendTradeToAPI({
          symbol,
          side,
          entry: result.price || entryPrice,
          sl,
          tp,
          volume,
          ticket: result.ticket
        });
      }
    } catch (err: any) {
      warn('ENTRY', `Failed to open ${symbol}: ${err.message}`);
    }
    
    // Clear pending setup
    this.pendingSetups.delete(symbol);
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
    
    return true;
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
                setup.status === 'continuation' ? 'continuation' :
                setup.status === 'trend_entry' ? 'trend_entry' :
                setup.status === 'ready' ? 'waiting_entry' : 'scanning',
        symbol,
        side: setup.side,
        currentPrice: currentPrice || 0,
        sweepLevel: setup.sweepLevel,
        fvgHigh: setup.fvg?.high,
        fvgLow: setup.fvg?.low,
        fvgSide: setup.fvg?.side,
        entryPrice: setup.entryPrice,
        sl: setup.sl,
        tp: setup.tp,
        sweepCandlesAgo: setup.candlesSinceSweep,
        maxCandlesToWait: this.config.fvg.maxAgeBars,
        detectedAt: setup.sweepTime.toISOString(),
        updatedAt: new Date().toISOString(),
        setupType: setup.setupType || 'reversal',
        tradingMode: mode,
        sweepTimeRemaining: mode === 'sweep' ? sweepTimeRemaining : 0
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

  private async sendTradeToAPI(trade: TradeResult): Promise<void> {
    try {
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
          strategy: 'SweepFVG'
        })
      });
    } catch (err) {
      // Silent fail - don't block trading
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
