// src/utils/pip.ts
export function pipToPrice(symbol: string, pips: number): number {
  // simple assumptions:
  // - For XAUUSD (gold), pip considered 0.01
  // - For FX majors, pip = 0.0001
  if (symbol.toUpperCase().includes('XAU')) {
    return pips * 0.01;
  }
  return pips * 0.0001;
}

export function priceToPip(symbol: string, priceDiff: number): number {
  if (symbol.toUpperCase().includes('XAU')) return priceDiff / 0.01;
  return priceDiff / 0.0001;
}
