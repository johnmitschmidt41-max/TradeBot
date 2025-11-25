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

    // Convert percentage to decimal (10 → 0.10)
    const riskUSD = balance * (riskPercent / 100);
    if (riskUSD <= 0 || stopLossPips <= 0) return 0.01;

    const s = symbol.replace("z", "").toUpperCase();

    // 1️⃣ Contract sizes (verified with Exness)
    const contractSize =
        s === "XAUUSD" ? 100 :
        s === "XAGUSD" ? 5000 :
        s.includes("USD") || s.includes("JPY") ? 100000 :
        100000;

    // 2️⃣ Pip size definition
    const pipSize =
        s.includes("JPY") ? 0.01 :
        s === "XAUUSD" ? 0.01 :
        s === "XAGUSD" ? 0.01 :
        0.0001;

    // 3️⃣ Pip value per lot (USD earned/lost per pip per 1 lot)
    const pipValuePerLot = contractSize * pipSize;

    // 4️⃣ Risk per 1 lot
    const riskPerLotUSD = stopLossPips * pipValuePerLot;

    if (riskPerLotUSD <= 0) return 0.01;

    // 5️⃣ Proper lot size
    const rawLots = riskUSD / riskPerLotUSD;

    // 6️⃣ Clamp to safe min/max
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
        s === "XAGUSD" ? 0.01 :
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
        s === "XAGUSD" ? 0.01 :
        0.0001;

    return { contractSize, pipSize };
}
