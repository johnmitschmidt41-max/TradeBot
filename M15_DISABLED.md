# ✅ M15 TRADING DISABLED

## Change Made

**File**: `src/strategy/jusdtt-m15.ts` (Line 614)

```typescript
// Skip M15 trading (disabled - only M1, M3, M5 enabled)
if (STRATEGY_CONFIG.timeframe === 'M15') {
  continue;
}
```

## Effect

- ✅ M15 trading is now **completely disabled**
- ✅ M1, M3, M5 trading continues as normal
- ✅ No errors, clean code
- ✅ Ready to deploy immediately

## Why This Works

The main trading loop processes each symbol. When the timeframe is M15, it now skips to the next symbol immediately, before any candle data is fetched or processed.

## Deploy

```bash
npm run build
npm start
```

Bot will now trade only on **1-minute, 3-minute, and 5-minute timeframes**. 

M15 is completely skipped. ✅
