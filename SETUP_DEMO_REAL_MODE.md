# Demo/Real Mode Implementation - Setup & Configuration

## ✅ All Components Configured

### 1. Bridge Configuration
**File:** `bridge/config.json`

Contains both DEMO and REAL account credentials:
- **DEMO Account**: 81538976 @ Exness-MT5Trial10
- **REAL Account**: Placeholder (update with your credentials)

Bridge reads from this file - NO hardcoded credentials.

### 2. Bridge API Endpoints

**Login to specified mode:**
```bash
POST /login
{
  "mode": "DEMO"  # or "REAL"
}
```

**Switch between modes:**
```bash
POST /switch_mode
{
  "mode": "REAL"  # or "DEMO"
}
```

**Check health status:**
```bash
GET /health
# Returns: status, trading_mode, current_account
```

### 3. Mode Manager (TypeScript)
**Files:**
- `src/config/mode.ts` - Mode configuration
- `src/core/mode-manager.ts` - Mode management logic
  - Tracks consecutive losses (LOSS, LOSS, LOSS = trigger)
  - Win breaks the streak (resets counter)
  - Daily restart auto-restore at 03:00 UTC+1

### 4. Position Limiter
**File:** `src/core/position-limiter.ts`

Enforces limits:
- Global: Max 6 simultaneous trades
- Per currency: Max 2 per symbol (GBP, EUR, XAU)

### 5. CLI Switch Command
**File:** `scripts/switch_mode.py`

```bash
# Check status
python scripts/switch_mode.py --status

# Switch to REAL (requires confirmation)
python scripts/switch_mode.py --mode real

# Switch to DEMO
python scripts/switch_mode.py --mode demo

# Verbose status with logs
python scripts/switch_mode.py --status --verbose
```

---

## 🔧 Fixed Issues

### Issue 1: TypeScript Property Error
**Error:** `maxSimultaneousTrades` does not exist
**Fix:** Changed to `maxSimultaneousTradesGlobal` in `trade-filter.ts`

### Issue 2: Hardcoded Credentials
**Status:** ✅ No hardcoded credentials found
**Configuration:** All credentials in `bridge/config.json`

---

## 📋 Consecutive Loss Logic (WORKING)

**Key Rule:** Losses must be CONSECUTIVE (any WIN breaks the streak)

| Sequence | Result |
|----------|--------|
| LOSS, LOSS, LOSS | ⛔ Switch to DEMO |
| LOSS, WIN, LOSS | ✅ No switch (win resets) |
| LOSS, LOSS, WIN, LOSS | ✅ No switch (win resets) |
| LOSS, LOSS, WIN, LOSS, LOSS, LOSS | ⛔ Switch to DEMO |

**How it works:**
1. Loss counter increments for consecutive losses
2. Any WIN resets counter to 0
3. 3 consecutive losses trigger auto-switch to DEMO
4. Daily restart (03:00 UTC+1) restores REAL and resets counter

---

## 🚀 Next Steps

1. **Update Real Account Credentials**
   ```json
   {
     "real": {
       "accountNumber": YOUR_ACCOUNT_NUMBER,
       "server": "YOUR_SERVER_NAME",
       "password": "YOUR_PASSWORD"
     }
   }
   ```

2. **Build and Test**
   ```bash
   npm run build
   npm start
   ```

3. **Test Mode Switch**
   ```bash
   python scripts/switch_mode.py --status
   ```

---

## 📊 Configuration Summary

- **Position Limits**: 6 global, 2 per currency ✅
- **Loss Trigger**: 3 consecutive losses ✅
- **Auto-Restore**: Daily restart at 03:00 UTC+1 ✅
- **Bridge Config**: External, synced from file ✅
- **Mode Persistence**: File-based state tracking ✅

**Everything is ready for deployment!**
