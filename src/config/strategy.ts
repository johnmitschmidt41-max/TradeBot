// src/config/strategy.ts
// Simplified config for SweepFVG Strategy

export const STRATEGY_CONFIG = {
  // Symbols to trade
  symbols: ['GBPUSDz', 'EURUSDz', 'XAUUSDz'],
  
  // Entry timeframe
  entryTimeframe: 'M5',
  
  // Risk management
  riskPercent: 1.0,
  maxTradesPerDay: 12,
  maxTradesPerSymbol: 4,
  
  // FX settings (GBPUSD, EURUSD)
  fx: {
    minSweepPips: 5,
    maxSlPips: 25,
    targetRR: 2.5,
    maxSpreadPips: 2.5
  },
  
  // XAU settings
  xau: {
    minSweepPips: 15,
    maxSlPips: 30,
    targetRR: 2.5,
    maxSpreadCents: 35
  },
  
  // FVG detection
  fvg: {
    minSizePips: 3,
    maxAgeBars: 8,
    retestBuffer: 0.3
  },
  
  // Session settings
  sessions: {
    tradeLondon: true,   // 07:00-16:00 UTC
    tradeNY: true,       // 13:00-21:00 UTC
    tradeAsian: false    // 00:00-08:00 UTC (skip for now)
  },
  
  // Position sizing
  sizing: {
    defaultBalance: 10000,  // For demo/testing
    maxPositionSize: 5.0,   // Max lots
    minPositionSize: 0.01   // Min lots
  },
  
  // Pip values
  pips: {
    GBPUSDz: 0.0001,
    EURUSDz: 0.0001,
    XAUUSDz: 0.1
  }
};

// Symbol metadata for position sizing
export const SYMBOL_META: Record<string, { pipSize: number; pipValue: number; minLot: number }> = {
  GBPUSDz: { pipSize: 0.0001, pipValue: 10, minLot: 0.01 },
  EURUSDz: { pipSize: 0.0001, pipValue: 10, minLot: 0.01 },
  XAUUSDz: { pipSize: 0.1, pipValue: 1, minLot: 0.01 }
};

export default STRATEGY_CONFIG;
