// src/utils/pip.ts
export function pipToPrice(symbol: string, pips: number): number {
  // simple assumptions:
  // - For XAUUSD (gold) and JPY pairs, pip considered 0.01
  // - For FX majors (non-JPY), pip = 0.0001
  if (symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('JPY')) {
    return pips * 0.01;
  }
  return pips * 0.0001;
}

export function priceToPip(symbol: string, priceDiff: number): number {
  // XAUUSD and JPY pairs use 0.01 as the pip price; everything else uses 0.0001
  if (symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('JPY')) return priceDiff / 0.01;
  return priceDiff / 0.0001;
}
