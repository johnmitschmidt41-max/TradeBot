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
    riskPercent: 0.02,
    maxTradesPerDay: 5
  },

  sl: {
    pipsBelowSweep: 20
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
