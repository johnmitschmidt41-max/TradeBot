/**
 * Correct Exness position sizing for FX, Gold, Indices
 * 
 * @param balance Account balance in USD
 * @param riskPercent Risk percentage (e.g., 10 for 10%), NOT decimal (0.10)
 * @param stopLossPips Stop loss in pips
 * @param symbol Trading symbol
 * @returns Volume in lots
 */
export function computeVolume(
    balance: number,
    riskPercent: number,
    stopLossPips: number,
    symbol: string
): number {

    const riskUSD = balance * (riskPercent / 100);
    // Safety: if the configured risk percent or computed risk in USD is zero or negative, return 0 lots
    // This prevents the system from silently trading non-zero lots when risk is 0.
    if (riskUSD <= 0 || stopLossPips <= 0) return 0;

    const s = symbol.replace("z", "").toUpperCase();

    const contractSize =
        s === "XAUUSD" ? 100 :
        s === "XAGUSD" ? 5000 :
        s.includes("USD") || s.includes("JPY") ? 100000 :
        100000;

    const pipSize =
        s.includes("JPY") ? 0.01 :
        // Align pip size with src/utils/pip.priceToPip: XAU uses 0.01 pip granularity
        s === "XAUUSD" ? 0.01 :
        // Use default forex pip for metals like XAG as 0.0001 (consistent with priceToPip default)
        s === "XAGUSD" ? 0.0001 :
        0.0001;

    const pipValuePerLot = contractSize * pipSize;

    const riskPerLotUSD = stopLossPips * pipValuePerLot;

    if (riskPerLotUSD <= 0) return 0.01;

    const rawLots = riskUSD / riskPerLotUSD;

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
