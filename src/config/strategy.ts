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
    riskPercent: 3,  // 3% risk per trade (user requested)
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
    ,
    // If enabled (and combined with PAPER_MODE or DEBUG_RISK_OVERRIDE env var),
    // the bot will allow opening a trade when the risk-based cap is zero but
    // other constraints (e.g., margin) allow a positive lot size. Use cautiously.
    // Allow demo or PAPER_MODE runs to proceed even when the strict risk cap
    // computes to zero (helps with small balance/demo or broker rounding quirks).
    // This should be used cautiously in live trading. The strategy logic will
    // also allow DEBUG_RISK_OVERRIDE or PAPER_MODE env vars to bypass risk.
    allowNonZeroLotsEvenIfRiskZero: true
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
    minRR: 2.5,
    useTrailingStop: true
  },
  // Trailing stop configuration: activate at 1:1 and 1:2 milestones
  trailingStop: {
    enabled: true,
    // At 1:1 (breakeven + slippage), activate trailing stop with this pip distance
    trailingAtBreakeven: 5,      // 5 pips trailing at 1:1
    // At 1:2 (TP/2), tighten trailing to this distance
    trailingAtHalfTP: 3         // 3 pips trailing at 1:2
  },
  filters: {
    // Trend filter toggles and MA lengths (short MA must be above long MA for buys)
    trendEnabled: true,
    maShort: 50,
    maLong: 200,
    // Liquidity checks: require ATR (pips) to be above a minimum to consider a trade
    liquidityEnabled: true,
    minAtrPipsFX: 2.5,   // FX pairs minimum ATR in pips
    minAtrPipsXAU: 30,   // Gold minimum ATR in pips
    // volume: require current bar volume to be >= avgVolume * multiplier
    minVolumeMultiplier: 0.8,
    // allowLowVolume: globally allow trading even when tick-volume < avg*mult
    // NOT recommended for live accounts, useful for paper/demo or high-frequency
    // testing. You can also set perSymbolAllowLowVolume to tune specific symbols.
    allowLowVolume: false,
    perSymbolAllowLowVolume: {
      // e.g. GBPUSDz: true
    }
  },
  // Matching options used when trying to stitch closed deals back to earlier
  // placed signals in `trade_signals.jsonl`. Default is small (3 pips) for FX
  // pairs; XAU tends to require a much larger tolerance because its price
  // precision & move scale differs.
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
  // High-frequency scanning options (M5). Disabled by default — enable when you
  // want higher throughput with stricter gating (HTF confirmation and stricter
  // ML thresholds). Keep M5 smaller lot sizing to maintain overall daily risk.
  highFrequency: {
    // ENABLED: M5 high-frequency scanning (HTF confirm + stricter ML gating)
    enabled: true,
    timeframe: 'M5',
    // require the higher timeframe trend be aligned (M15 or H1) for M5-triggered signals
    htfConfirm: 'M15',
    // reduce allowable ML loss probability for M5 signals (stricter gating)
    // Stricter ML threshold for M5 (lower == harder to get a pass)
    mlMaxLossProb: 0.30,
    // scale lots when trading in M5 (so M5 doesn't increase daily risk)
    // smaller lot sizing for M5 so overall daily risk is preserved
    m5ScalingFactor: 0.25,
    // global daily cap across all symbols for M5 mode and per-symbol overrides
    globalDailyCap: 150,
    perSymbolDailyCap: {
      default: 30,
      // tighter cap for gold (avoid overexposure while testing M5)
      XAUUSDz: 10
    }
  }
};


// ML scoring configuration (optional) — disabled by default
export const ML_CONFIG = {
  enabled: true, // set to true to enable model scoring before placing orders
  provider: 'gemini', // provider label for future extension
  // environment variable names for provider URL / key
  apiUrlEnv: 'GEMINI_API_URL',
  apiKeyEnv: 'GEMINI_API_KEY',
  // Quick gating mode to control ML strictness. Choose one of:
  // 'strict' -> allow trades when lossProb <= 0.50 (higher volume, ~35-40% win rate)
  // 'medium' -> allow trades when lossProb <= 0.60 (10-15 trades/day, ~30% win rate)
  // 'loose' -> allow trades when lossProb <= 0.70 (very high volume, ~25% win rate)
  // The computed numeric threshold will be used unless overridden by
  // higher-priority config (e.g., STRATEGY_CONFIG.highFrequency.mlMaxLossProb)
  gatingMode: 'medium',
  // legacy numeric fallback (used when explicit gating mode is not provided)
  declineLossProb: 0.6
};

// Auto-training options (when enabled, retrains after each closed trade)
export const AUTO_TRAINING_CONFIG = {
  enabled: true, // set to true to run retraining after every closed trade
  // path to python interpreter/command to run the trainer
  pythonCommand: 'python',
  // script to run (relative to project root) — use winners-only trainer for better accuracy
  trainScript: 'scripts/train_model_winners_only.py',
  // model output path (trainer will write here) — saves to model_winners.pkl
  modelOutput: 'data/output/model_winners.pkl',
  // minimum number of closed trades required before training runs (avoid tiny samples)
  minSamples: 5  // retrain after every 5 closed trades
};