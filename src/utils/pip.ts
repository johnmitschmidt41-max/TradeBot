// src/utils/pip.ts
export function pipToPrice(symbol: string, pips: number): number {
  // Pip values for different symbols:
  // - XAUUSD (gold): 0.1 (1 pip = $0.10 move, so 4204.6 to 4205.6 = 10 pips)
  // - JPY pairs: 0.01 (standard for JPY)
  // - FX majors: 0.0001 (standard forex)
  if (symbol.toUpperCase().includes('XAU')) {
    return pips * 0.1;
  }
  if (symbol.toUpperCase().includes('JPY')) {
    return pips * 0.01;
  }
  return pips * 0.0001;
}

export function priceToPip(symbol: string, priceDiff: number): number {
  // Convert price difference to pips
  // XAUUSD: divide by 0.1 (1 pip = $0.10, so 0.994 price diff = 9.94 pips)
  // JPY pairs: divide by 0.01
  // FX majors: divide by 0.0001
  if (symbol.toUpperCase().includes('XAU')) return priceDiff / 0.1;
  if (symbol.toUpperCase().includes('JPY')) return priceDiff / 0.01;
  return priceDiff / 0.0001;
}
