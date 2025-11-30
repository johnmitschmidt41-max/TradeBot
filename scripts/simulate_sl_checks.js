// scripts/simulate_sl_checks.js
// Quick simulation runner for SL / TP checks (M5/M15 behavior) — prints decisions.

function priceToPip(symbol, priceDiff){
  if (symbol.includes('XAU') || symbol.includes('JPY')) return priceDiff / 0.01;
  return priceDiff / 0.0001;
}

const config = {
  sl: {
    pipsBelowSweep: { GBPUSDz: 3, EURUSDz: 3, XAUUSDz: 30 },
    perSymbolCaps: { GBPUSDz: { minPips: 8, maxPips: 40 }, EURUSDz: { minPips: 8, maxPips: 40 }, XAUUSDz: { minPips: 20, maxPips: 200 } }
  },
  slTp: { perSymbol: { GBPUSDz: { slPips: 8, tpPips: 12 }, EURUSDz: { slPips: 8, tpPips: 12 }, XAUUSDz: { slPips: 30, tpPips: 90 } } }
};

function evaluateCandidate({symbol, side, entry, proposedSl, proposedTp, timeframe}){
  // returns {accepted: boolean, reason, action}
  const symbolKey = symbol;
  const pipSize = (symbol.includes('XAU') || symbol.includes('JPY')) ? 0.01 : 0.0001;
  const slDistance = priceToPip(symbol, Math.abs(entry - proposedSl));
  const tpDistance = priceToPip(symbol, Math.abs(proposedTp - entry));

  // per-symbol caps
  const caps = config.sl.perSymbolCaps[symbolKey] || {};
  const minCap = (typeof caps.minPips === 'number') ? caps.minPips : (config.sl.pipsBelowSweep[symbolKey] || 3);
  const maxCap = caps.maxPips || Infinity;

  // Decision logic copied from strategy (M5 / M15 differences handled by timeframe param)
  if (slDistance >= tpDistance){
    return {accepted:false, reason: 'SL >= TP (bad RR)', action:'reject'};
  }

  if (timeframe === 'M5'){
    // M5: for XAU reject if sl < min; for others widen
    if (slDistance < minCap){
      if (symbol.includes('XAU')) return {accepted:false, reason:'SL < minPips for XAU', action:'reject'};
      return {accepted:true, reason:'SL widened to minPips', action:'widen', newSL: (side==='BUY') ? entry - (minCap * pipSize) : entry + (minCap * pipSize), newSLpips:minCap };
    }
    // else accept
    return {accepted:true, reason:'ok', action:'accept', slPips:slDistance, tpPips:tpDistance };
  } else {
    // M15: similar but earlier logic used; for this simulation keep same rules
    if (slDistance < minCap){
      if (symbol.includes('XAU')) return {accepted:false, reason:'SL < minPips for XAU', action:'reject'};
      return {accepted:true, reason:'SL widened to minPips', action:'widen', newSL: (side==='BUY') ? entry - (minCap * pipSize) : entry + (minCap * pipSize), newSLpips:minCap };
    }
    return {accepted:true, reason:'ok', action:'accept', slPips:slDistance, tpPips:tpDistance };
  }
}

const scenarios = [
  // XAU: too-tight SL
  { symbol: 'XAUUSDz', side: 'BUY', entry: 4175.502, proposedSl: 4174.599, proposedTp: 4176.8565, timeframe: 'M5', desc: 'XAU M5 tiny SL (0.903 price diff) -- CAUTION: pip unit 0.01 -> 90.3 pips (accepted) '},
  // XAU: truly tiny SL in pips (5 pips -> should be rejected for XAU)
  { symbol: 'XAUUSDz', side: 'BUY', entry: 4175.502, proposedSl: 4175.452, proposedTp: 4176.8565, timeframe: 'M5', desc: 'XAU M5 very tight SL (5 pips) - expected reject'},
  // XAU: slightly larger SL (25 pips -> should be accepted)
  { symbol: 'XAUUSDz', side: 'BUY', entry: 4175.502, proposedSl: 4175.252, proposedTp: 4177.002, timeframe: 'M5', desc: 'XAU M5 reasonable SL 25 pips - expected accept'},
  // XAU: SL >= TP
  { symbol: 'XAUUSDz', side: 'BUY', entry: 4168.900, proposedSl: 4160.900, proposedTp: 4166.296, timeframe: 'M15', desc: 'XAU M15 SL >= TP (reject) - SL distance 800 vs TP 4' },
  // GBP: SL too small - widen
  { symbol: 'GBPUSDz', side: 'BUY', entry: 1.23456, proposedSl: 1.23406, proposedTp: 1.23656, timeframe: 'M5', desc: 'GBP M5 SL 5 pips (<8) should widen to 8' },
  // EUR: SL >= TP
  { symbol: 'EURUSDz', side: 'SELL', entry: 1.10000, proposedSl: 1.10120, proposedTp: 1.10100, timeframe: 'M15', desc: 'EUR SL >= TP -> reject' }
];

console.log('\nSimulating SL/TP checks for several scenarios\n');
for (const s of scenarios){
  console.log('---');
  console.log('scenario:', s.desc);
  const res = evaluateCandidate(s);
  console.log('symbol', s.symbol, 'side', s.side, 'entry', s.entry, 'sl', s.proposedSl, 'tp', s.proposedTp, 'timeframe', s.timeframe);
  console.log('result:', res);
}
console.log('\nDone.');
