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
    // scalingFactor multiplies computed lots (use 1 for no scaling). Keep small (1-3) for safety.
    scalingFactor: 1,
    // fallback leverage used if account info doesn't include it
    defaultLeverage: 100,
    // global maximum lots allowed (safety cap)
    maxLots: 50,
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

// ML scoring configuration (optional) — disabled by default
export const ML_CONFIG = {
  enabled: true, // set to true to enable model scoring before placing orders
  provider: 'gemini', // provider label for future extension
  // environment variable names for provider URL / key
  apiUrlEnv: 'GEMINI_API_URL',
  apiKeyEnv: 'GEMINI_API_KEY',
  // if model predicts a loss probability >= this value, skip the trade
  declineLossProb: 0.6
};

// Auto-training options (when enabled, retrains after each closed trade)
export const AUTO_TRAINING_CONFIG = {
  enabled: true, // set to true to run retraining after every closed trade
  // path to python interpreter/command to run the trainer
  pythonCommand: 'python',
  // script to run (relative to project root)
  trainScript: 'scripts/train_model.py',
  // model output path (trainer will write here)
  modelOutput: 'data/output/model.pkl',
  // minimum number of closed trades required before training runs (avoid tiny samples)
  minSamples: 1
};