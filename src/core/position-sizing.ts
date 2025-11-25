// Accurate EXNESS Position Sizing (No MetaSymbolInfo needed)

const CONTRACT_SIZES: Record<string, number> = {
    "XAUUSD": 100,   // 1 lot = 100 gold ounces
    "XAGUSD": 5000,  // 1 lot = 5000 silver ounces
    "US30": 1,
    "NAS100": 1,
    "SPX500": 1,
};

// Default FX contract size
const DEFAULT_FX_CONTRACT_SIZE = 100000;

/**
 * Calculates lot size based on balance, risk %, and stop loss size.
 */
export function computeVolume(
    balance: number,
    riskPercent: number,
    stopLossPips: number,
    symbol: string
): number {

    if (!stopLossPips || stopLossPips <= 0) return 0.01;

    // 1️⃣ TOTAL MONEY WE ARE WILLING TO RISK
    const riskUSD = balance * riskPercent;
    if (riskUSD <= 0) return 0.01;

    // 2️⃣ CLEAN SYMBOL FORMAT
    const clean = symbol.replace(".", "").replace("z", "").toUpperCase();

    // 3️⃣ EXNESS CONTRACT SIZE
    const contractSize = CONTRACT_SIZES[clean] || DEFAULT_FX_CONTRACT_SIZE;

    // 4️⃣ DIGITS → USED TO CALCULATE PIP SIZE
    const pipSize = clean.includes("JPY") ? 0.001 : 0.0001;

    // 5️⃣ PIP VALUE PER 1 LOT
    // Example: XAU (100 * 0.01 = $1 per pip)
    const pipValuePerLot = contractSize * pipSize;

    // 6️⃣ RISK PER LOT = SL * pipValue
    const riskPerLot = stopLossPips * pipValuePerLot;
    if (riskPerLot <= 0) return 0.01;

    // 7️⃣ FINAL LOT SIZE
    const lots = +(riskUSD / riskPerLot).toFixed(2);

    // 8️⃣ SAFETY LIMIT
    return Math.min(Math.max(lots, 0.01), 50);
}
