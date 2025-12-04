# TradeBot — System Flow (Top → Bottom) — UPDATED (strict M3/M5, HTF filter, detector hardening)

This file documents the complete end-to-end flow from data ingestion through trade placement and post-trade persistence — updated to reflect the new M5-bias + M3-entry timing architecture, hardened sweep/FVG detectors, M15 HTF trend gating, corrected SL logic (entry-to-sweep + buffer, ATR fallback), strict per-symbol parameter defaults, and global safety limits that block live risk until the system passes the testing protocol.

Summary: the bot now enforces a conservative, multi-stage gating pipeline (M15 HTF → M5 sweep+FVG → M3 stabilization) and strict SL/TP checks; these changes reduce noise and prevent tiny wicks from creating indiscriminate entries.

---

## 1) High-level architecture

- Components:
  - Node/TypeScript mainbot (strategy, detectors, backtester, order-management) — src/
  - Python MT5 bridge (order execution & account calls) — src/core/mt5-bridge.py
  - Scorer / microservice (scoring gating, model gates) — scripts/scorer_server.py
  - Frontend dashboard (React + SSE) for logs, metrics and canary pages — frontend/
  - Backtesting & analysis (replays, grid-search, sampling) — src/backtester/

- Key runtime responsibilities:
  - Detection & entry logic: src/strategy/jusdtt-m15.ts
  - Low-level detectors: src/detectors/{sweep-detector.ts,fvg-detector.ts,poi-detector.ts}
  - HTF trend helper: src/indicators/htf-trend.ts (M15 gating)
  - SL/TP and risk: src/config/strategy.ts and src/core/position-sizing.ts
  - Live order execution: OrderManager + MT5 connector + mt5-bridge

---

## 2) Full signal flow (Top → Bottom)

1) Market data & readiness
   - DataFeed pulls candles from the MT5 connector (live) or the backtester (replay). The mainbot always requests the proper timeframes (M3 & M5) and an HTF series (M15) when HTF checks are enabled.
   - Backtests use the exact same detectors and config paths so behavior is consistent between offline runs and live operation.

2) HTF Trend gating (M15) — NEW, strict gate
   - Before attempting M5 → M3 checks, the strategy uses `getM15Trend()` (src/indicators/htf-trend.ts).
   - If HTF = neutral → the symbol / candidate is skipped (hard skip).
   - If HTF direction differs from candidate side → candidate is skipped.
   - Rationale: HTF is intentionally strict so only trades aligned with structural trend are allowed.

3) M5 bias and structure (bias detection & quality gates)
   - Detect M5 sweeps with improved rules (src/detectors/sweep-detector.ts): sweep must poke beyond recent structure extremes, close back beyond a buffer, and show substantial displacement relative to the average candle range. This prevents tiny wicks from being treated as full liquidity hunts.
   - Detect FVGs with improved rules (src/detectors/fvg-detector.ts): require an explicit 3-candle pattern and a displacement in the middle candle (c2 range significantly larger than recent average) so gaps formed by noise are ignored.
   - M5 checks also enforce per-symbol amplitude requirements (min displacement pips, MA separation, ATR gateway) and optional session/time gating.

4) Enforce 2-signal minimum (MANDATORY) and optional bonuses
   - Mandatory: Liquidity Grab (valid sweep) AND FVG/displacement found on M5.
   - Optional bonuses (raise confidence): BOS (structure break), third confirmation (EMA / momentum depending on symbol).

5) Create pending candidate and M3 entry timing (stabilization)
   - If M5 bias passes, a pending candidate is queued and monitored on the M3 timeframe (pendingSignals). This implements the entry-timing checks (minCandlesAfterSignal, minConsecutiveCandles, candleReductionFactor).
   - Strict pullback requirement: the queued entry requires price to retrace into the FVG by a configurable percentage (pullbackPercentage) — implemented in shouldProceedWithEntry(). If pullback is not satisfied the candidate is denied.
   - M1 is NOT a veto. M1 (milliseconds-level) is only advisory; HTF M15 and M5 remain the decisive gates.

6) SL/TP calculation & validation
   - SL is calculated as: entry-to-sweep distance (in pips) + configured pips-below-sweep buffer (per symbol). This fixes the previous bug that used the buffer alone.
   - ATR fallback: the system computes M5 ATR and will choose an ATR-derived SL (ATR * 1.5) if that yields a larger, safer SL distance. This prevents extremely tight SLs that are unrealistic for the current volatility.
   - SL hard checks: per-symbol min/max SL caps are enforced. If SL is outside allowed bounds the trade is rejected (no silent capping). FX SLs also require being inside a sane hard range (e.g., 40–100 pips by default) to prevent overtrading with tiny SLs.
   - TP uses per-symbol TP values (slTp.perSymbol) or explicit RR checks (minRR, maxRR). TP is intentionally constrained so the strategy can't pick absurd RR multipliers.

7) Position sizing, safety checks & order placement
   - Position sizing uses `computeVolume()` to derive lots from risk USD; if riskUSD <= 0 or stopLossPips <= 0 then lots = 0; this prevents accidental live orders.
   - Global and per-symbol daily caps are checked (getTradesTodayCount + canOpenTrade). In addition we have introduced dailyStats (src/core/trade-filter.ts) to track consecutive losses, daily P&L%, and to pause trading automatically when thresholds are crossed (globalLimits in config).
   - If featureFlags.dryRun = true, orders are simulated only. Otherwise orders go through OrderManager → MT5 connector → Python bridge (mt5-bridge.py).

8) Lifecycle & closed-deal persistence
   - After a trade closes the bridge reports deals; the strategy tries to match deals to persisted signals and persists closed trades (persistTradeSignal/markSignalClosedByDeal). Now, whenever we detect a closed deal we update daily stats (recordTradeClose) so global limits and consecutive loss counts are enforced.

---

## 3) Files changed / important locations (concise mapping)

- Strategy & gating
  - src/strategy/jusdtt-m15.ts — main gate + entry timing, M3/M5 flow, SL/TP logic (entry-to-sweep + buffer + ATR fallback), pullback enforcement, pendingSignals queue
  - src/indicators/htf-trend.ts — M15 trend helper (strict HTF gating)

- Detection
  - src/detectors/sweep-detector.ts — improved sweep detection logic (structure-aware + displacement checks)
  - src/detectors/fvg-detector.ts — strengthened FVG detection (requires displacement in middle candle)

- Safety / backtesting / config
  - src/config/strategy.ts — strict per-symbol defaults, strictMode flags, globalLimits (daily caps & pause duration), sl/pips caps
  - src/core/trade-filter.ts — new dailyStats (pause state, consecutive losses) and recordTradeClose() to automatically pause trading when thresholds reached
  - src/core/position-sizing.ts — defensive sizing (0 lots if risk <= 0)

- Backtesting tools
  - src/backtester/entry-timing-replay.ts
  - src/backtester/param-sweep-entry-timing.ts
  - src/backtester/sample-candidates.ts
  These run with the same detectors & config defaults used by live to avoid out-of-sample mismatches.

---

## 4) Testing, validation & rollout checklist (what to run before deploying to live)

Priority sequence to prove the system is trustworthy before any real-money rollout:

1) Parameter reduction & small sweep
   - Run narrow parameter sweep on GBPUSD/XAUUSD with M3 timing + M5 bias enabled and strict defaults. Use `param-sweep-entry-timing.ts` and focus on tighter minCandles / minConsecutiveCandles / fvgMinGap ranges.

2) Candidate inspection
   - For the top sweep candidates, run `sample-candidates.ts` and manually inspect losing / winning trades to ensure detectors & SL geometry look correct.

3) Walk-forward validation
   - Run multi-window walk-forward backtests (non-overlapping OOS windows) for the chosen parameter sets.

4) Demo / paper trading (dry-run true)
   - Run the strategy on a demo account for 1–2 weeks. Confirm fills, slippage, latency, and that live fills match simulated backtests.

5) Canary small allocation
   - Move to a live small allocation with strict daily limits & lot caps. Monitor behavior for at least 2–4 weeks before scaling.

6) Continuous monitoring
   - Keep the dashboard live, use logs + canary page for gating, run weekly param sweeps and revalidate.

---

## 5) Commands & how to validate locally

Run replays, sweeps, and samplers from the `mainbot` root.

```powershell
# Replay entry timing (replay M3/M5):
npm run replay:entryTiming

# Narrow parameter sweep (grid search using current strict config):
npm run sweep:entryTiming

# Sample candidates for human inspection (example):
npx ts-node src/backtester/sample-candidates.ts --symbol GBPUSDz --limit 25
```

Notes: the backtester and sweep scripts read the strategy config and detectors, so tests here match the live algorithm as closely as possible.

---

## 6) Monitoring & acceptance metrics (what to measure during canary/paper)

- Quality targets (aim, not guaranteed):
  - Entries / day (per user request): approximate 8–12 trades/day combined by the collection of tracked symbols
  - Win rate: 60–75%+ on top-confluence setups after walk-forward validation
  - Max daily loss: within configured globalLimits (e.g., stop trading at -3%)
  - Avg win / avg loss, reward-to-risk, max drawdown (walk-forward and live)

- Operational alerts:
  - SL/TP mismatch or invalid calculations (should be caught by modelDecision logs)
  - Unusual fills/slippage in MT5 bridge
  - Daily pause triggered due to consecutive losses or daily drawdown

---

If you'd like I'll:
- Run a focused narrow sweep for GBPUSD with the exact strict defaults we just added and present the top 5 parameter sets with trade-level samples and equity curves.
- Add a `CHECKLIST.md` in the repo that maps these acceptance criteria into automated checks (CI & dashboard) and a dashboard canary gating page.

File updated at: `DOCS/SYSTEM_FLOW.md` — let me know if you'd like the doc tuned further for operator checklists, a short A/B harness, or a canary dashboard page. 
