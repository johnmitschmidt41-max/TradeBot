// src/config/strategy-v2.ts
// Clean configuration for Strategy V2 - Sweep + FVG for FX, Session Sweep for XAU

export const STRATEGY_V2_CONFIG = {
  // ==================== RISK MANAGEMENT ====================
  risk: {
    riskPercent: 2,              // % of balance to risk per trade
    maxLots: 10,                 // Maximum lot size per trade
    maxTradesPerDay: 20,         // Stop trading after this many trades
    maxSimultaneousTrades: 3,    // Max open positions at once
    maxConsecutiveLosses: 4,     // Pause trading after X consecutive losses
    defaultLeverage: 100,        // Default leverage if not from broker
  },

  // ==================== FX PAIRS (GBPUSD, EURUSD) ====================
  fx: {
    enabled: true,
    pairs: ['GBPUSDz', 'EURUSDz'],
    
    // Timeframes
    structureTimeframe: 'M5',    // For identifying swings/sweeps
    entryTimeframe: 'M3',        // For precise entry timing
    
    // Sweep Detection
    sweep: {
      lookbackCandles: 25,       // How far back to look for swing high/low
      minWickPips: 3,            // Minimum wick size to qualify as sweep
      maxAgeCandles: 10,         // Sweep must be recent (within X candles)
    },
    
    // FVG (Fair Value Gap)
    fvg: {
      minGapPips: 2,             // Minimum FVG size in pips
      maxDistancePips: 15,       // Max distance from current price to FVG
      entryZone: 0.5,            // Enter at 50% into FVG (0=low, 1=high)
    },
    
    // Displacement (strong move after sweep)
    displacement: {
      minBodyPercent: 60,        // Candle body must be 60%+ of total range
      minMovePips: 5,            // Minimum move size in pips
    },
    
    // Stop Loss & Take Profit
    slPipsBeyondSweep: 3,        // SL placed X pips beyond sweep wick
    minRR: 2.0,                  // Minimum risk:reward ratio
    maxSlPips: 25,               // Reject if SL would be larger than this
    
    // Session filter (optional)
    sessionFilter: {
      enabled: false,            // Set true to only trade during specific hours
      startHour: 7,              // UTC hour to start
      endHour: 17,               // UTC hour to stop
    },
  },

  // ==================== XAU (GOLD) ====================
  xau: {
    enabled: true,
    symbol: 'XAUUSDz',
    
    // Timeframes  
    structureTimeframe: 'M15',   // For identifying Asian range
    entryTimeframe: 'M5',        // For entry timing
    
    // Asian Session Range
    asianSession: {
      startHour: 0,              // UTC - Asian session start
      endHour: 7,                // UTC - Asian session end
      minRangePips: 30,          // Minimum Asian range to trade
      maxRangePips: 120,         // Skip if Asian range too large (choppy)
    },
    
    // Sweep of Asian Range
    sweep: {
      minPenetrationPips: 5,     // Must break Asian high/low by at least X pips
      maxPenetrationPips: 40,    // Reject if breaks too far (likely trend day)
    },
    
    // Entry
    entryOnReversal: true,       // Enter when price comes back inside range
    confirmationCandles: 1,      // Wait for X candles back inside range
    
    // Stop Loss & Take Profit
    slPipsBeyondSweep: 10,       // SL placed X pips beyond the sweep
    minRR: 2.0,                  // Minimum risk:reward
    targetOppositeRange: true,   // TP at opposite side of Asian range
    maxSlPips: 50,               // Reject if SL would be larger
    
    // Trading window (when to look for sweeps)
    tradingWindow: {
      startHour: 7,              // UTC - Start looking for sweeps (London open)
      endHour: 16,               // UTC - Stop looking (before Asia)
    },
  },

  // ==================== LOGGING ====================
  logging: {
    logSkippedTrades: true,      // Log why trades were skipped
    logEntryDetails: true,       // Log full entry details
    verboseMode: false,          // Extra debug logging
  },

  // ==================== SAFETY ====================
  safety: {
    minAccountBalance: 50,       // Don't trade if balance below this
    maxSpreadPips: {
      fx: 3,                     // Max spread for FX pairs
      xau: 40,                   // Max spread for gold
    },
    requireConfirmation: false,  // If true, log signal but don't execute (paper mode)
  },
};

// Type export for IDE support
export type StrategyV2Config = typeof STRATEGY_V2_CONFIG;
