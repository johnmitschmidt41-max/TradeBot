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
    riskPercent: 3,
    scalingFactor: 1,
    defaultLeverage: 100,
    maxLots: 50,
    dailyDrawdownPercent: 300,
    maxSimultaneousTrades: 3,
    directionCooldownSeconds: 300,
    maxTradesPerDay: 50,
    allowNonZeroLotsEvenIfRiskZero: true
  },
  sl: {
    pipsBelowSweep: {
      GBPUSD: 20,
      EURUSD: 20,
      XAUUSD: 250
    }
  },
  tp: {
    minRR: 2.5,
    useTrailingStop: true
  },
  trailingStop: {
    enabled: true,
    trailingAtBreakeven: 5,
    trailingAtHalfTP: 3
  },
  filters: {
    trendEnabled: true,
    maShort: 50,
    maLong: 200,
    liquidityEnabled: true,
    minAtrPipsFX: 2.5,
    minAtrPipsXAU: 30,
    minVolumeMultiplier: 0.5,
    allowLowVolume: false,
    perSymbolAllowLowVolume: {}
  },
  matching: {
    defaultTolerancePips: 3,
    perSymbolTolerance: {
      XAUUSDz: 30
    }
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
    timeframe: 'M5',
    htfConfirm: 'M15',
    mlMaxLossProb: 0.30,
    m5ScalingFactor: 0.25,
    globalDailyCap: 150,
    perSymbolDailyCap: {
      default: 30,
      XAUUSDz: 10
    }
  }
};


export const ML_CONFIG = {
  enabled: true,
  provider: 'gemini',
  apiUrlEnv: 'GEMINI_API_URL',
  apiKeyEnv: 'GEMINI_API_KEY',
  gatingMode: 'medium',
  declineLossProb: 0.6
};

export const AUTO_TRAINING_CONFIG = {
  enabled: true,
  pythonCommand: 'python',
  trainScript: 'scripts/train_model_winners_only.py',
  modelOutput: 'data/output/model_winners.pkl',
  minSamples: 5
};