# Bridge Mode Switching Guide

## Startup Logging

When you restart the MT5 bridge, it will log:

```
📋 Current trading mode: REAL
🔐 Logging in to REAL account: 409847667 @ Exness-MT5Real10
✅ MT5 connected: {...account info...}
```

If on DEMO mode:
```
📋 Current trading mode: DEMO
🔐 Logging in to DEMO account: 81538976 @ Exness-MT5Trial10
```

## Switch Modes (From Another Terminal)

**Check current mode:**
```powershell
npm run mode-check
```

**Switch to REAL:**
```powershell
npm run mode-switch -- real
```
Requires confirmation: `confirm-real-mode`. Bridge will auto-reconnect on next check.

**Switch to DEMO:**
```powershell
npm run mode-switch -- demo
```
Immediately switches to DEMO account.

## Auto-Switch from Bridge

Once you switch modes from another terminal:
1. Mode file (`data/config/trading_mode.json`) is updated immediately
2. Bridge will detect the mode change on its **next health check** (every 10-30 seconds)
3. Bridge auto-reconnects to the new account without restarting

## Notes
- Mode stored in `data/config/trading_mode.json`
- Bridge reads this file on startup AND periodically during runtime
- Auto-switch happens after 3 consecutive losses (REAL → DEMO)
- Daily restart at 03:00 UTC+1 restores REAL mode

