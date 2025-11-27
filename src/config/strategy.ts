// config/strategy.ts
export const STRATEGY_CONFIG = {
  symbol: "GBPUSDz",
  timeframe: "M15",
  lookback: 100,
  poi: {
    minTouches: 1,
    zoneThicknessATR: 0.25
  },
  // Filters used by strategy to control trend / liquidity behaviour
  filters: {
    trendEnabled: true,
    trendTimeframe: 'M5',
    maShort: 50,
    maLong: 200,
    liquidityEnabled: true,
    // minimum ATR thresholds (in pips) for liquidity checks
    minAtrPipsXAU: 30,
    minAtrPipsFX: 2.5,
    // spread limits (pips) used to filter out wide-spread conditions per-symbol
    spreadLimits: {
      GBPUSDz: 2.5,
      EURUSDz: 2.5,
      XAUUSDz: 30
    }
  },
  sweep: {
    thresholdPips: 10,
    closeBackWithin: 2
  },
  fvg: {
    minGapPips: 3,
    entryMode: "close"
  },
  rejection: {
    wickPercent: 0.6,
    bodyPercent: 0.3
  },
  risk: {
    // STRICT MODE: 10% per trade (viable with 80-85% win rate from 3-confirmation system)
    riskPercent: 10,
    scalingFactor: 1,
    defaultLeverage: 100,
    maxLots: 50,
    dailyDrawdownPercent: 300,
    maxSimultaneousTrades: 4,
    directionCooldownSeconds: 300,
    // Max 30 trades per day overall (cap to manage risk)
    maxTradesPerDay: 30,
    allowNonZeroLotsEvenIfRiskZero: true
  },

  // required sweep-based buffers (don't rely on fragile small fixed pips)
  sl: {
    pipsBelowSweep: {
      GBPUSDz: 3,
      EURUSDz: 3,
      XAUUSDz: 30
    },
    // Per-symbol SL caps: ensure SL distances stay within reasonable bounds
    perSymbolCaps: {
      GBPUSDz: { minPips: 8, maxPips: 40 },
      EURUSDz: { minPips: 8, maxPips: 40 },
      XAUUSDz: { minPips: 30, maxPips: 500 }
    }
  },

  tp: {
    minRR: 1.5,
    // cap TP to avoid absurd RR (e.g. 50x). Set a maximum RR multiplier applied to SL.
    maxRR: 10,
    useTrailingStop: true,
  },

  trailingStop: {
    enabled: true,
    trailingAtBreakeven: 5,
    trailingAtHalfTP: 3
  },

  slTp: {
    perSymbol: {
      GBPUSDz: { slPips: 8, tpPips: 12 },
      EURUSDz: { slPips: 8, tpPips: 12 },
      XAUUSDz: { slPips: 30, tpPips: 90 }
    }
  },

  // 2-confirmation mandatory (Liquidity Grab + FVG/Displacement) + optional bonuses (BOS + Third)
  confirmations: {
    minimumConfirmations: 2,
    mandatory: ['LIQUIDITY_GRAB', 'FVG'],
    perSymbolThird: {
      GBPUSDz: 'EMA',
      EURUSDz: 'EMA',
      XAUUSDz: 'MOMENTUM'
    }
  },
  // Spread limits integrated into filters (defined earlier)
  // (spreadLimits was merged into the primary filters block near the top)

  matching: {
    defaultTolerancePips: 3,
    perSymbolTolerance: { XAUUSDz: 30 }
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
  ,
  highFrequency: {
    enabled: true,
    timeframes: ['M1', 'M3', 'M5'],  // All high-frequency timeframes
    htfConfirm: 'M15',
    mlMaxLossProb: 0.55,
    m5ScalingFactor: 1.0,
    globalDailyCap: 30,
    // Per-currency daily cap: 30 trades max per currency per day
    // Rationale: Quality over quantity; each trade filtered through 2-3 gates
    perSymbolDailyCap: {
      default: 30,
      GBPUSDz: 30,
      EURUSDz: 30,
      XAUUSDz: 30
    }
  }
  ,
  // Trading schedule controls — useful to pause trading overnight for this strategy
  tradingSchedule: {
    enabled: true,
    // timezone offset hours relative to UTC (Nigeria = UTC+1)
    timezoneOffsetHours: 1,
    // sleep window (strings HH:MM, 24-hour). This window is inclusive and can cross midnight.
    sleepFrom: '21:30',
    sleepTo: '03:00',
    // messages
    sleepMessage: 'Bot is sleeping but resumption in %s',
    resumeMessage: 'Bot Trading is Back on'
  }
};


export const ML_CONFIG = {
  // GATING MODE: Model gates 2-confirmation setups, passes 4-confirmation setups
  // Rationale: 2-signal system requires ML validation (58% base win rate)
  // 4-signal perfect setups auto-pass (73% win rate, no ML needed)
  enabled: true,
  provider: 'gemini',
  apiUrlEnv: 'GEMINI_API_URL',
  apiKeyEnv: 'GEMINI_API_KEY',
  gatingMode: 'strict',
  // Threshold tuned for 2-signal gate: decline if loss prob > 55%
  // 4-signal setups skip this check entirely (auto-accept)
  declineLossProb: 0.55
};

export const AUTO_TRAINING_CONFIG = {
  enabled: true,
  pythonCommand: 'python',
  trainScript: 'scripts/train_model_enhanced.py',
  modelOutput: 'data/output/model.pkl',
  minSamples: 5
};