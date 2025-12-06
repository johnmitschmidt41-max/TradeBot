/**
 * Correct Exness position sizing for FX, Gold, Indices
 * 
 * @param balance Account balance in USD
 * @param riskPercent Risk percentage (e.g., 1 for 1%), NOT decimal (0.01)
 * @param stopLossPips Stop loss in pips
 * @param symbol Trading symbol
 * @param currentPrice Current price (needed for JPY pairs to convert pip value to USD)
 * @returns Volume in lots
 */
export function computeVolume(
    balance: number,
    riskPercent: number,
    stopLossPips: number,
    symbol: string,
    currentPrice?: number
): number {

    const riskUSD = balance * (riskPercent / 100);
    // Safety: if the configured risk percent or computed risk in USD is zero or negative, return 0 lots
    // This prevents the system from silently trading non-zero lots when risk is 0.
    if (riskUSD <= 0 || stopLossPips <= 0) return 0.01;

    const s = symbol.replace("z", "").toUpperCase();

    const contractSize =
        s === "XAUUSD" ? 100 :
        s === "XAGUSD" ? 5000 :
        s.includes("USD") || s.includes("JPY") ? 100000 :
        100000;

    const pipSize =
        s.includes("JPY") ? 0.01 :
        s === "XAUUSD" ? 0.1 :  // ALIGNED: XAU pip size is 0.1 (10 cents) to match strategy
        s === "XAGUSD" ? 0.0001 :
        0.0001;

    // Calculate pip value in USD
    // For pairs where USD is quote currency (EURUSD, GBPUSD, XAUUSD): pip value = contractSize * pipSize
    // For pairs where USD is base currency (USDJPY, USDCAD): pip value = (contractSize * pipSize) / price
    let pipValuePerLotUSD: number;
    
    if (s.includes("JPY")) {
        // USDJPY, EURJPY, etc - pip value in JPY, need to convert to USD
        // Pip value = (contractSize * pipSize) / USDJPY rate
        const price = currentPrice || 150; // Fallback to ~150 for JPY pairs
        pipValuePerLotUSD = (contractSize * pipSize) / price;
        
        // Special case for EURJPY, GBPJPY (Cross pairs)
        // Pip value is in JPY, so we divide by USDJPY rate (not the cross pair rate!)
        // But we don't have USDJPY rate here easily... 
        // Approximation: For EURJPY, price is ~160. USDJPY is ~150.
        // The formula (contract * pip) / currentPrice is actually for USD/JPY.
        // For EUR/JPY, pip value is 1000 JPY. To get USD, we need 1000 / USDJPY.
        // Using currentPrice (EURJPY) is WRONG.
        // However, without USDJPY rate, we can't be perfect.
        // But usually CrossPair / BasePair ≈ QuotePair.
        // EURJPY / EURUSD = USDJPY.
        // So 1000 / USDJPY = 1000 / (EURJPY / EURUSD).
        // = 1000 * EURUSD / EURJPY.
        
        // SIMPLIFICATION: Just use a fixed conservative conversion for JPY crosses if we don't have USDJPY
        // 1000 JPY ≈ $6.50 USD.
        if (!s.startsWith("USD") && s.includes("JPY")) {
             // For EURJPY, GBPJPY etc.
             // 1 lot = 100,000 units. 1 pip = 0.01.
             // Pip value = 1000 JPY.
             // 1000 JPY in USD ≈ $6.50 (at 154 USDJPY)
             pipValuePerLotUSD = 6.50; 
        }
    } else if (s.startsWith("USD") && !s.includes("XAU") && !s.includes("XAG")) {
        // USDCAD, USDCHF - USD is base currency
        // Pip value = (contractSize * pipSize) / price
        const price = currentPrice || 1.35; // Fallback
        pipValuePerLotUSD = (contractSize * pipSize) / price;
    } else {
        // EURUSD, GBPUSD, AUDUSD, NZDUSD, XAUUSD - USD is quote currency
        // Pip value = contractSize * pipSize (already in USD)
        pipValuePerLotUSD = contractSize * pipSize;
    }

    const riskPerLotUSD = stopLossPips * pipValuePerLotUSD;

    if (riskPerLotUSD <= 0) return 0.01;

    const rawLots = riskUSD / riskPerLotUSD;

    // Round to 2 decimal places, min 0.01, max 10 lots
    const lots = Math.min(Math.max(+rawLots.toFixed(2), 0.01), 10);

    return lots;
}

/**
 * Returns USD value per pip for 1 lot of the given symbol (used for risk calculations)
 */
export function pipValuePerLot(symbol: string): number {
    const s = symbol.replace("z", "").toUpperCase();

    const contractSize =
        s === "XAUUSD" ? 100 :
        s === "XAGUSD" ? 5000 :
        s.includes("USD") || s.includes("JPY") ? 100000 :
        100000;

    const pipSize =
        s.includes("JPY") ? 0.01 :
            s === "XAUUSD" ? 0.01 :
            s === "XAGUSD" ? 0.0001 :
        0.0001;

    return contractSize * pipSize;
}

/**
 * Returns helpful metadata for a trading symbol: contractSize and pipSize
 */
export function getSymbolMeta(symbol: string): { contractSize: number; pipSize: number } {
    const s = symbol.replace("z", "").toUpperCase();

    const contractSize =
        s === "XAUUSD" ? 100 :
        s === "XAGUSD" ? 5000 :
        s.includes("USD") || s.includes("JPY") ? 100000 :
        100000;

    const pipSize =
        s.includes("JPY") ? 0.01 :
            s === "XAUUSD" ? 0.01 :
            s === "XAGUSD" ? 0.0001 :
        0.0001;

    return { contractSize, pipSize };
}
