# TradeBot

## MT5 Connector: account info caching

The Node/TS `MT5Connector` performs HTTP requests to the Python MT5 bridge for account information (`/account`). To prevent rapid repeated polling from different parts of the app we added an in-memory cache with a short TTL.

You can configure the TTL (milliseconds) using the environment variable `MT5_ACCOUNT_CACHE_TTL_MS`. Default: 2000 (2s).

If callers need fresh information they can call `getAccountInfo(true)` to bypass the cache.

## Centralized risk configuration (strict mode)

Risk is driven from a single source of truth: `src/config/strategy.ts`. Change the `risk.riskPercent` value there (percentage, not decimal) and the entire bot will use the new risk percent. The strategy config runs a runtime validation and will throw on startup if required risk fields are missing or invalid — this prevents silent fallbacks and enforces strict safety checks.
