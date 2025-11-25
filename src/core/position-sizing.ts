import { STRATEGY_CONFIG } from "../config/strategy";
import { pipToPrice } from "../utils/pip";

export function computeVolume(accountBalance: number, riskPercent: number, stopLossPips: number, symbol: string, pricePerLotUSD = 100000): number {
  // Very simple: risk $ = balance * riskPercent
  const riskUSD = accountBalance * riskPercent;
  // Convert stopLossPips to price difference
  const slPrice = pipToPrice(symbol, stopLossPips);
  // For FX majors, 1 standard lot ~ $100k not precise (depends on pair). We'll use 100k notional.
  // volume (lots) = riskUSD / (slPrice * notionalPerPip)
  // For simplicity: assume pip value per lot = 10 USD for majors (for 0.0001 pip and 100k)
  // XAU is different; user should tune this.
  const pipValuePerLot = symbol.toUpperCase().includes('XAU') ? 1 : 10;
  const riskPerLot = stopLossPips * pipValuePerLot;
  if (riskPerLot <= 0) return 0.01;
  const lots = Math.max(0.01, Math.min(10, +(riskUSD / riskPerLot).toFixed(2)));
  return lots;
}
