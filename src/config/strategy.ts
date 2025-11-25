// config/strategy.ts
export const STRATEGY_CONFIG = {
  symbol: "GBPUSD",
  timeframe: "M15",
  lookback: 100,
  poi: {
    minTouches: 1,
    zoneThicknessATR: 0.25
  },
  sweep: {
    thresholdPips: 10,
    closeBackWithin: 2
  },
  fvg: {
    minGapPips: 10,
    entryMode: "close"
  },
  rejection: {
    wickPercent: 0.6,
    bodyPercent: 0.3
  },
  risk: {
    riskPercent: 10,  // 10% risk per trade
    dailyDrawdownPercent: 300, //base is 20-30%
    maxSimultaneousTrades: 3,
    directionCooldownSeconds: 300,
    maxTradesPerDay: 50 // base is 5-10 max
  },
  sl: {
    // ✅ FIXED: Symbol-specific SL distances
    pipsBelowSweep: {
      GBPUSD: 20,
      EURUSD: 20,
      XAUUSD: 250  // ← THIS PREVENTS XAUUSD OVER-RISKING
    }
  },
  tp: {
    minRR: 2.0,
    useTrailingStop: true
  },
  news: {
    blockBeforeMinutes: 30,
    blockAfterMinutes: 30,
    events: ["NFP", "FOMC", "CPI", "Jobless Claims"]
  },
  order: {
    useLimitOrders: true,
    limitOffsetPips: 0.5
  }
};

// ✅ HELPER FUNCTION: Get SL pips based on symbol
export function getSLPips(symbol: string): number {
  const config = STRATEGY_CONFIG.sl.pipsBelowSweep;
  
  if (symbol.includes('XAU')) {
    return config.XAUUSD;
  }
  if (symbol.includes('GBP')) {
    return config.GBPUSD;
  }
  if (symbol.includes('EUR')) {
    return config.EURUSD;
  }
  
  return 20; // default fallback
}