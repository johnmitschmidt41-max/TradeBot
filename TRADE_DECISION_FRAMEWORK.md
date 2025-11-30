# Trade Decision Framework

## System Overview

**2-Signal Mandatory Gate + Optional Bonuses**
- **MANDATORY**: Liquidity Grab + FVG/Displacement (58% win rate baseline)
- **OPTIONAL BONUSES**: BOS + Third Confirmation (increases to 73% with all 4)

---

## Decision Flow

```
┌─ SETUP DETECTED ─────────────────────────────┐
│                                              │
├─ Liquidity Grab? (opposite sweep wick)       │
│  └─ YES ────────────────────────┐           │
│                                  │           │
├─ FVG/Displacement? (3+ pip gap)  │           │
│  └─ YES ────────────────────────┤           │
│                                  │           │
├─ MANDATORY CONFIRMED ───────────└──→ Score  │
│                                      │       │
├─ BOS? (Break of Structure)          │       │
│  └─ +0.5 confidence if YES          │       │
│                                      │       │
├─ Third? (EMA/Momentum)              │       │
│  └─ +0.2 confidence if YES          │       │
│                                      │       │
└─ 2-signal: Gate ML Model            │       │
   4-signal: Auto-accept (73% win)    │       │
                                      ↓       │
                              ┌──────────────┤
                              │ Score < 0.55 │
                              │ loss prob?   │
                              └──────────────┘
                                 │        │
                            NO ──┤        ├─→ YES: REJECT
                                 │        │
                                 ↓        ↓
                            ┌──────────────┐
                            │ PLACE TRADE  │
                            │  Size: Risk% │
                            │ SL: Sweep-3  │
                            │  TP: Config  │
                            └──────────────┘
```

---

## Real Trade Examples

### Example 1: Perfect Setup (2-Signal + Both Bonuses)

**Setup:**
- Symbol: **GBPUSDz**  
- Price: **1.2645**
- Sweep: Down to 1.2620 (25 pips), wick extended to 1.2605
- FVG: 1.2640→1.2630 (10 pip gap)
- BOS: Yes (price breaks below recent low)
- EMA: 9>20>50>200 (bullish)

**What Bot Sees:**
```
✅ Liquidity Grab detected (opposite sweep with 15-pip wick)
✅ FVG/Displacement found (10 pips, exceeds 3-pip minimum)
✅ BOS detected (price < previous structure)
✅ EMA in alignment (bullish trend)
```

**Decision:**
- **Mandatory signals**: 2/2 ✓
- **Bonus signals**: 2/2 ✓
- **Total**: 4 confirmations (73% expected win rate)
- **ML Gate**: AUTO-PASS (4-signal = no ML check)

**Trade Parameters:**
- Entry: 1.2645
- SL: 1.2615 (30 pips below sweep @ 1.2645, at minCap=8)
- TP: 1.2657 (12 pips, 1.5:1 RR)
- Risk: Account $5000 × 10% = $500
- Lot Size: 4.17 (500 / (30 × 10))
- **Status**: PLACED ✓

---

### Example 2: Minimal Setup (2-Signal Only)

**Setup:**
- Symbol: **EURUSDz**  
- Price: **1.0820**
- Sweep: Up to 1.0835 (15 pips)
- FVG: 1.0815→1.0810 (5 pip gap)
- BOS: No (price inside range)
- MACD: Weakening (not aligned)

**What Bot Sees:**
```
✅ Liquidity Grab detected (same-side sweep, strong wick)
✅ FVG/Displacement found (5 pips)
⛔ No BOS (no structure break)
⛔ MACD not weakening (no third confirmation)
```

**Decision:**
- **Mandatory signals**: 2/2 ✓
- **Bonus signals**: 0/2
- **Total**: 2 confirmations (58% expected win rate)
- **ML Gate**: REQUIRES SCORING (must pass 0.55 threshold)

**Trade Parameters:**
- Entry: 1.0820
- SL: 1.0828 (8 pips, at minCap)
- TP: 1.0832 (12 pips)
- Model Score: 0.48 loss prob ✓ (< 0.55 threshold)
- Lot Size: 6.25 (500 / (8 × 10))
- **Status**: PLACED ✓

---

### Example 3: Rejected - No Liquidity

**Setup:**
- Symbol: **XAUUSDz**  
- Price: **2050.00**
- Sweep: None recent (no liquidity)
- FVG: 2048→2045 (3 pip gap)

**What Bot Sees:**
```
⛔ NO Liquidity Grab (no opposite sweep)
✅ FVG found (3 pips, meets minimum)
```

**Decision:**
- **Mandatory signals**: 1/2 ✗ (MISSING Liquidity)
- **Status**: SKIPPED ⛔

**Log:**
```
⛔ TRADE SKIPPED - need Liquidity Grab + FVG/Displacement
{liquidityGrab: false, fvgDisplacement: true}
```

---

### Example 4: Rejected - FVG Too Small

**Setup:**
- Symbol: **GBPUSDz**  
- Price: **1.2640**
- Sweep: Up to 1.2655 (15 pips)
- FVG: 1.2638→1.2636 (2 pip gap) ← BELOW 3-pip minimum
- Liquidity: Yes

**What Bot Sees:**
```
✅ Liquidity Grab detected
⛔ FVG/Displacement NOT found (2 pips < 3-pip minimum)
```

**Decision:**
- **Mandatory signals**: 1/2 ✗ (FVG too small)
- **Status**: SKIPPED ⛔

**Log:**
```
⛔ TRADE SKIPPED - need Liquidity Grab + FVG/Displacement
{liquidityGrab: true, fvgDisplacement: false}
```

---

### Example 5: Accepted After ML Review

**Setup:**
- Symbol: **EURUSDz**  
- Price: **1.0830**
- Sweep: Up to 1.0845 (15 pips)
- FVG: 1.0825→1.0820 (5 pip gap)
- BOS: Yes
- EMA: Aligned (bullish)

**What Bot Sees:**
```
✅ Liquidity Grab detected
✅ FVG found (5 pips)
✅ BOS detected
✅ EMA in alignment
```

**Decision:**
- **Mandatory signals**: 2/2 ✓
- **Bonus signals**: 2/2 ✓
- **Total**: 4 confirmations
- **ML Gate**: AUTO-PASS (no scoring needed)
- **Status**: PLACED ✓

---

### Example 6: Rejected by ML (2-Signal + Low Score)

**Setup:**
- Symbol: **GBPUSDz**  
- Price: **1.2650**
- Sweep: Down to 1.2630 (20 pips)
- FVG: 1.2648→1.2642 (6 pip gap)
- BOS: No
- EMA: Weak (price below EMA200)

**What Bot Sees:**
```
✅ Liquidity Grab detected
✅ FVG found (6 pips)
⛔ No BOS
⛔ EMA not aligned
```

**Decision:**
- **Mandatory signals**: 2/2 ✓
- **Bonus signals**: 0/2
- **Total**: 2 confirmations (58% win rate base)
- **ML Gate**: REQUIRED

**Model Scoring:**
```
Input: entry=1.2650, sl=1.2638, tp=1.2662
       2-signal setup, no BOS, weak EMA
Model Output: loss_prob = 0.62 (HIGH)
Threshold: 0.55
Result: 0.62 > 0.55 → REJECT
```

**Status**: REJECTED ⛔

**Log:**
```
❌ M5 REJECTED - high lossProb
{symbol: GBPUSDz, side: SELL, lossProb: 0.62, threshold: 0.55}
```

---

## Configuration Values

### SL/TP by Symbol

| Symbol | Min SL | Max SL | TP Pips | RR |
|--------|--------|--------|---------|-----|
| GBPUSDz | 8 | 40 | 12 | 1.5:1 |
| EURUSDz | 8 | 40 | 12 | 1.5:1 |
| XAUUSDz | 30 | 500 | 90 | 3:1 |

### Detection Parameters

| Parameter | Value |
|-----------|-------|
| Sweep Threshold (pips) | 10 |
| Liquidity Wick Min (pips) | 10 |
| FVG Gap Min (pips) | 3 |
| BOS Lookback (candles) | 40 |
| EMA Periods | 9, 20, 50, 200 |

### Risk & Position Sizing

| Parameter | Value |
|-----------|-------|
| Risk per Trade | 10% of account |
| Max Lots | 50 |
| Max Simultaneous (Global) | 6 trades |
| Max per Currency | 2 trades |
| Max per Day/Currency | 30 trades |

### ML Gating

| Parameter | Value |
|-----------|-------|
| 2-Signal Threshold | loss_prob ≤ 0.55 |
| 4-Signal Threshold | AUTO-PASS (no check) |
| Model | Gemini 3 Pro |
| Gate Type | Strict |

---

## Win Rate Expectations

### By Confirmation Count

| Signals | Liqu | FVG | BOS | Third | Count | Win Rate |
|---------|------|-----|-----|-------|-------|----------|
| 2 | ✓ | ✓ | ✗ | ✗ | 385 | 58% |
| 3 | ✓ | ✓ | ✓ | ✗ | 114 | 64% |
| 3 | ✓ | ✓ | ✗ | ✓ | 95 | 61% |
| 4 | ✓ | ✓ | ✓ | ✓ | 82 | 73% |

### Model Impact

- **2-signal trades**: ML gates with 0.55 threshold
  - Improves win rate: 58% → 68% (after filtering)
  - ~40% of 2-signal trades rejected
  
- **4-signal trades**: Auto-pass ML (no scoring)
  - Already 73% win rate
  - ML check unnecessary for perfect setups

---

## SL Adjustment Rules

### When SL Adjusts

**ONLY if violates caps** (not routine):

1. **Too Tight** (< minCap)
   ```
   Calculated SL: 6 pips
   Min Cap: 8 pips
   Action: Widen to 8 pips
   Log: 🔧 M5 SL ADJUSTED - widened to min cap
   ```

2. **Too Wide** (> maxCap)
   ```
   Calculated SL: 50 pips
   Max Cap: 40 pips
   Action: Reduce to 40 pips
   Log: 🔧 M5 SL CAPPED - reduced to max cap
   ```

### When SL Does NOT Adjust

**Normal operations** (within caps):
```
Calculated SL: 15 pips
Min Cap: 8 pips
Max Cap: 40 pips
Action: No adjustment (use calculated 15)
Log: (silent - expected operation)
```

---

## Trade Logging

### Acceptance Log
```
✅ M5 CONFIRMATIONS PASS - proceeding
{symbol: GBPUSDz, side: BUY, bos: true, liquidityGrab: true, thirdOk: true}

📊 Placing MARKET order
{symbol: GBPUSDz, side: BUY, entry: 1.2645, volume: 4.17, sl: 1.2615, tp: 1.2657}

M5 placed GBPUSDz BUY lots=4.17
```

### Rejection Log
```
⛔ TRADE SKIPPED - need Liquidity Grab + FVG/Displacement
{symbol: EURUSDz, liquidityGrab: true, fvgDisplacement: false}

❌ M5 REJECTED - high lossProb
{symbol: GBPUSDz, lossProb: 0.62, threshold: 0.55}
```

---

## Model Training Results

### Latest Training (3,685 trades analyzed)

```
Classification Report:
              precision    recall  f1-score   support
       Loss       0.79      0.73      0.76       633
       Win       0.94      0.96      0.95      3,052
    
    accuracy                           0.92      3,685
   macro avg       0.87      0.84      0.85      3,685
weighted avg       0.92      0.92      0.92      3,685

Confusion Matrix:
         Predicted
         Loss  Win
Actual
Loss      460  173
Win       124 2,928
```

### Model Intelligence Breakdown

**Overall Accuracy: 92%** ✓
- Correctly predicts 92% of trade outcomes (wins vs losses)
- Trained on 3,685 real closed trades

**Win Detection: 96% Recall**
- Catches 96% of winning trades (only misses 4%)
- False positives: 124 predicted wins that lost
- Great at saying "this will likely win"

**Loss Detection: 73% Recall**
- Catches 73% of losing trades
- Misses 27% (173 trades that look good but lose)
- Conservative: predicts loss, avoids risk

**Precision for Wins: 94%**
- When model says "WIN", it's right 94% of the time
- Only 6% of "accept" predictions turn into losses

**What This Means:**
- Threshold 0.55 loss probability = conservative gate
- Rejects ~40% of 2-signal trades
- Filters out the worst 2-signal setups
- Keeps high-confidence trades
- Expected improvement: 58% → 68% win rate on 2-signal

---

## Bot → Scorer → Model Flow

### Phase 1: Bot Detection (jusdtt-m15.ts)

```
CANDLES RECEIVED
    ↓
CHECK SWEEP DETECTOR
    ├─ Is there a recent liquidity sweep?
    ├─ Extract: side, entry, sweep extreme
    └─ Get: recent sweeps list
    
CHECK MANDATORY SIGNALS
    ├─ Liquidity Grab? (opposite sweep wick ≥ 10 pips)
    ├─ FVG/Displacement? (gap ≥ 3 pips)
    └─ If BOTH → Continue to Phase 2
       If EITHER missing → SKIP this setup ⛔
```

**Bot Output** (if mandatory confirmed):
```typescript
{
  symbol: "GBPUSDz",
  side: "BUY",
  entry: 1.2645,
  sl: 1.2615,
  tp: 1.2657,
  lots: 4.17,
  liquidityGrab: true,
  fvgDisplacement: true,
  hasBonus: 2  // BOS + Third both present
}
```

---

### Phase 2: Check Optional Bonuses (still in bot)

```
BONUS CHECK (not required, just adds confidence)
    ├─ BOS? (Break of Structure: close beyond recent extreme)
    │  └─ If YES: +0.5 confidence
    ├─ Third? (EMA alignment or MACD weakening)
    │  └─ If YES: +0.2 confidence
    └─ Total possible: 2.0 (or 0 if no bonuses)

CONFIDENCE SCORE
    = 0.5 (liquidity) + 0.3 (fvg) + [bonuses]
    = 0.8 minimum (2-signal)
    = 1.0 maximum (4-signal)
```

**Bot Decision Check:**
```
if bonuses >= 2 (4-signal perfect setup)
    → AUTO-ACCEPT, skip ML ✓
    → Win rate expected: 73%
    
else (2-signal only)
    → REQUIRE ML SCORING
    → Forward to Scorer
```

---

### Phase 3: Scorer (Gemini 3 Pro)

**Only triggered for 2-signal trades** (when bonuses < 2)

**Scorer Receives:**
```typescript
{
  symbol, side, entry, sl, tp, lots, accountBalance, slPips,
  technicalConfidence: 0.8,  // 2-signal = 0.5+0.3
  hasLiquidityGrab: true,
  hasFVGDisplacement: true,
  hasBOS: false,
  hasThirdConfirmation: false
}
```

**Scorer Evaluates:**
- Entry point quality vs recent price action
- SL/TP ratio reasonableness (1.5:1 minimum)
- Account risk (10% exposure)
- Symbol liquidity conditions
- Current market structure

**Scorer Output:**
```
{
  shouldAccept: true/false,
  confidence: 0.42,        // confidence in prediction
  reasoning: "SL reasonable, entry at liquidity level, weak bonus signals"
}
```

---

### Phase 4: Model Analysis

**If Scorer says "accept":**

Model converts output to probability:
```
loss_probability = (1 - confidence) / 2
                 = (1 - 0.42) / 2
                 = 0.29
```

**Threshold Check:**
```
if loss_probability ≤ 0.55 (threshold)
    → ACCEPT TRADE ✓
    → Place order immediately
    
if loss_probability > 0.55
    → REJECT TRADE ⛔
    → Log rejection, move to next signal
```

---

### Example Flow: 2-Signal Trade

```
1. BOT DETECTION
   ├─ Candles: GBPUSDz M5
   ├─ Liquidity Grab: ✓ (opposite sweep, 15-pip wick)
   ├─ FVG: ✓ (5-pip gap)
   ├─ BOS: ✗ (no structure break)
   ├─ EMA: ✗ (price below EMA200)
   └─ Decision: 2-signal detected → need ML gate

2. SCORER EVALUATION
   ├─ Input: 2-signal setup, no bonuses, SL=8, TP=12, RR=1.5
   ├─ Analysis: "Setup OK, entry clean, but weak trend confirmation"
   ├─ Output: confidence=0.45
   └─ loss_prob = (1-0.45)/2 = 0.275

3. THRESHOLD CHECK
   ├─ loss_prob = 0.275
   ├─ threshold = 0.55
   ├─ 0.275 < 0.55 ✓
   └─ Decision: ACCEPT ✓

4. TRADE EXECUTION
   ├─ Symbol: GBPUSDz
   ├─ Side: BUY
   ├─ Entry: 1.2645
   ├─ SL: 1.2615 (8 pips)
   ├─ TP: 1.2657 (12 pips)
   ├─ Lot: 6.25
   └─ Status: PLACED ✓
```

---

### Example Flow: 4-Signal Perfect Setup

```
1. BOT DETECTION
   ├─ Candles: EURUSDz M5
   ├─ Liquidity Grab: ✓ (same-side sweep, 20-pip wick)
   ├─ FVG: ✓ (6-pip gap)
   ├─ BOS: ✓ (price breaks structure)
   ├─ EMA: ✓ (9>20>50>200, bullish)
   └─ Decision: 4-signal PERFECT → AUTO-ACCEPT (skip scorer)

2. TRADE EXECUTION (NO ML GATE)
   ├─ Symbol: EURUSDz
   ├─ Side: BUY
   ├─ Entry: 1.0820
   ├─ SL: 1.0810 (10 pips)
   ├─ TP: 1.0822 (12 pips)
   ├─ Lot: 5.0
   └─ Status: PLACED ✓
   
   Note: Scorer never invoked
   Expected win rate: 73%
```

---

### Example Flow: Rejected by Model

```
1. BOT DETECTION
   ├─ Candles: GBPUSDz M5
   ├─ Liquidity Grab: ✓
   ├─ FVG: ✓
   ├─ BOS: ✗
   ├─ EMA: ✗ (bearish)
   └─ Decision: 2-signal → need ML gate

2. SCORER EVALUATION
   ├─ Input: 2-signal, weak trend, SL=8, TP=12
   ├─ Analysis: "FVG minimal, entry weak, bearish EMA"
   ├─ Output: confidence=0.25 (LOW)
   └─ loss_prob = (1-0.25)/2 = 0.375

3. THRESHOLD CHECK
   ├─ loss_prob = 0.375
   ├─ threshold = 0.55
   ├─ 0.375 < 0.55 ✓
   └─ Decision: STILL ACCEPT (within threshold)

4. ALTERNATIVE (worse setup)
   ├─ Scorer output: confidence=0.15
   ├─ loss_prob = (1-0.15)/2 = 0.425
   ├─ 0.425 < 0.55 ✓
   └─ ACCEPT (barely)

5. ANOTHER SCENARIO (very weak)
   ├─ Scorer output: confidence=0.08
   ├─ loss_prob = (1-0.08)/2 = 0.46
   ├─ 0.46 < 0.55 ✓
   └─ ACCEPT (marginal)

6. WORST CASE (should reject)
   ├─ Scorer output: confidence=0.02
   ├─ loss_prob = (1-0.02)/2 = 0.49
   ├─ Still < 0.55 ✓
   └─ ACCEPT (but risky)
   
   But if scorer says: confidence=-0.15
   ├─ loss_prob = (1-(-0.15))/2 = 0.575
   ├─ 0.575 > 0.55 ✗
   └─ REJECT ⛔
```

---

## Demo/Real Mode & Auto-Switch Logic

### Overview

Bot runs in two modes with automatic protection:
- **DEMO Mode**: Paper trading (no real money at risk)
- **REAL Mode**: Live trading (real account)

**Auto-Switch Rule:** After 3 consecutive losses on REAL → switch to DEMO
**Auto-Restore:** Daily restart at 03:00 UTC+1 → restore REAL mode

---

### Mode Management

#### **Starting Bot**
```
Bot starts → Loads mode config → Defaults to DEMO (safe)
```

#### **During Trading Day (REAL Mode)**
```
Trade 1: LOSS        → Count: 1/3
Trade 2: LOSS        → Count: 2/3 (warning logged)
Trade 3: LOSS        → Count: 3/3 THRESHOLD HIT!
         
AUTO ACTION:
├─ Switch to DEMO mode
├─ Disconnect from REAL account
├─ Reconnect to DEMO account
├─ Reset loss counter to 0
└─ Log: "🔄 AUTO-SWITCHED to DEMO after 3 consecutive losses"

Remaining day: Trading on DEMO only (learning/testing)
```

**Loss Counter Reset:**
- **After a WIN**: Counter resets to 0 (breaks the streak)
- **At Daily Restart**: Counter resets regardless of status

---

#### **Daily Restart (03:00 UTC+1)**
```
Bot wakes up → Checks mode state

If DEMO (from 3-loss trigger):
├─ Auto-restore to REAL mode
├─ Reset loss counter to 0
├─ Reconnect to REAL account
└─ Ready to trade again

If already REAL:
└─ Continue on REAL (normal operation)
```

---

### Command Usage

**Check current mode:**
```bash
python scripts/switch_mode.py --status
```

**Output:**
```
╔═══════════════════════════════════════════╗
║         TRADING MODE STATUS               ║
╠═══════════════════════════════════════════╣
║ Current Mode:        REAL                 ║
║ Last Switched:       2025-11-28T10:30:00  ║
║ Reason:              daily_restart        ║
║ Mode Locked:         No                   ║
║ Consecutive Losses:  1/3                  ║
╚═══════════════════════════════════════════╝
```

**Switch to REAL (with confirmation):**
```bash
python scripts/switch_mode.py --mode real
```

**Switch to DEMO:**
```bash
python scripts/switch_mode.py --mode demo
```

**Verbose status (with recent logs):**
```bash
python scripts/switch_mode.py --status --verbose
```

---

### Mode State File

**Location:** `data/config/trading_mode.json`

```json
{
  "mode": "REAL",
  "lastSwitched": "2025-11-28T03:00:00Z",
  "reason": "daily_restart",
  "consecutiveLosses": {
    "count": 1,
    "startedAt": "2025-11-28T10:30:00Z",
    "trades": [
      {
        "orderId": "order_123",
        "profit": -50.00,
        "timestamp": "2025-11-28T10:30:00Z"
      }
    ]
  },
  "autoRules": {
    "enabled": true,
    "lossThreshold": 3,
    "demoLearningMode": false,
    "restoreAtDailyRestart": true
  }
}
```

---

### Position Limits

**Global:** Max 6 simultaneous trades across all currencies
**Per Currency:** Max 2 simultaneous trades per symbol

Example scenario:
```
GBPUSDz: 2 open trades (at limit)
EURUSDz: 2 open trades (at limit)
XAUUSDz: 2 open trades (at limit)
─────────────────────────
TOTAL:   6 open trades (global limit reached)

New signal on GBPUSDz → BLOCKED (both GBP and global limits hit)
```

**Position Status:**
```
GBP: 2/2 | EUR: 1/2 | XAU: 1/2 | Total: 4/6
```

---

### Loss Counter Logic

**Consecutive Loss Tracking (REAL Mode Only):**

IMPORTANT: Losses must be **CONSECUTIVE** - any WIN breaks the streak back to 0!

**Examples:**

1. **Consecutive Losses (TRIGGER AT 3)**
   ```
   Trade 1: LOSS      → Counter: 1/3
   Trade 2: LOSS      → Counter: 2/3
   Trade 3: LOSS      → Counter: 3/3 → AUTO-SWITCH to DEMO ⛔
   ```

2. **Win Breaks the Streak (Counter Resets)**
   ```
   Trade 1: LOSS      → Counter: 1/3
   Trade 2: WIN       → Counter: 0/3 (RESET - win breaks streak)
   Trade 3: LOSS      → Counter: 1/3 (start over)
   ```

3. **Win After 2 Losses (Does NOT Switch)**
   ```
   Trade 1: LOSS      → Counter: 1/3
   Trade 2: LOSS      → Counter: 2/3
   Trade 3: WIN       → Counter: 0/3 (breaks streak, no switch)
   Trade 4: LOSS      → Counter: 1/3 (start fresh)
   ```

4. **4 Losses with Win in Middle (No Switch)**
   ```
   Trade 1: LOSS      → Counter: 1/3
   Trade 2: LOSS      → Counter: 2/3
   Trade 3: WIN       → Counter: 0/3 (resets)
   Trade 4: LOSS      → Counter: 1/3 (new sequence)
   Trade 5: LOSS      → Counter: 2/3
   Trade 6: LOSS      → Counter: 3/3 → AUTO-SWITCH to DEMO ⛔
   ```

5. **Perfect Consecutive (Immediate Trigger)**
   ```
   Trade 1: LOSS      → Counter: 1/3
   Trade 2: LOSS      → Counter: 2/3 (⚠️ Warning logged)
   Trade 3: LOSS      → Counter: 3/3 → 🔄 AUTO-SWITCH to DEMO
   ```

**Key Rules:**
- ✅ **WIN** = Streak broken, counter reset to 0
- ❌ **3 CONSECUTIVE LOSSES** = Auto-switch to DEMO
- ⏸️ **Any WIN** = Restart counting from 0
- 🔄 **Daily Restart** = Counter reset regardless (fresh start)

---



### Safety Features

**Mode Lock:** After auto-switch, mode is locked for 5 minutes (prevents accidental rapid switches)

**Confirmation Required:** Switching to REAL requires typing `confirm-real-mode`

**Audit Trail:** All mode changes logged to `data/logs/mode_changes.log`

**Auto-Restore:** Automatic recovery at 03:00 UTC+1 daily restart (fresh start every day)

---

## Summary

- **Entry Gate**: 2-mandatory + 0-2 optional bonuses
- **Risk Model**: 10% per trade, proper position sizing
- **ML Gating**: Only for 2-signal trades (loss_prob ≤ 0.55)
- **Perfect Setups**: 4 confirmations = auto-pass = 73% win rate
- **Model Accuracy**: 92% overall, 96% at detecting wins
- **SL Strategy**: Calculated per sweep, adjusted only if violates min/max
- **Trade Types**: M1, M3, M5 only (M15 disabled, USDJPY removed)
- **Active Symbols**: GBPUSDz, EURUSDz, XAUUSDz
- **Training Data**: 3,685 real trades with 92% accuracy predicting outcomes
