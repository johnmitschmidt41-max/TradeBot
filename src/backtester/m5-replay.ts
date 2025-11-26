import { MT5Connector } from "../core/mt5-connector";
import { DataFeed } from "../core/data-feed";
import { detectFVG } from "../detectors/fvg-detector";
import { detectSweeps } from "../detectors/sweep-detector";
import { sma, atr } from "../utils/math";
import { priceToPip } from "../utils/pip";

async function run() {
  const connector = new MT5Connector();
  const feed = new DataFeed(connector);

  const SYMBOLS = ["GBPUSDz","EURUSDz","XAUUSDz","USDJPYz"];
  const timeframe = 'M5';
  const htfConfirm = 'M15';

  for (const symbol of SYMBOLS) {
    console.log(`\n=== Replay ${symbol} ${timeframe} ===`);
    const all = await feed.getRecentCandles(symbol, timeframe, 5000);
    if (!all || all.length === 0) {
      console.warn('No candles for', symbol);
      continue;
    }

    let totalCandidates = 0;
    let passedFilters = 0;

    // sliding-window style: simulate scanning each new candle
    for (let i = 200; i < all.length; i++) {
      const window = all.slice(0, i + 1); // last bars until i
      const sweeps = detectSweeps(window);
      const recentSweeps = sweeps.slice(-5);
      if (recentSweeps.length === 0) continue;
      const latest = recentSweeps[recentSweeps.length - 1];
      const side = latest.side;

      // find FVG after sweep index
      const fvgs = detectFVG(window);
      const candidates = fvgs.filter(f => (side === 'BUY' ? f.side === 'BULL' : f.side === 'BEAR') && f.index >= latest.index);
      if (candidates.length === 0) continue;

      totalCandidates++;
      // apply simple filters: HTF trend check
      try {
        const htfCandles = await feed.getRecentCandles(symbol, htfConfirm, 200);
        const maShort = sma(htfCandles, 50);
        const maLong = sma(htfCandles, 200);
        if (maShort === 0 || maLong === 0) continue;
        if (side === 'BUY' && maShort <= maLong) continue;
        if (side === 'SELL' && maShort >= maLong) continue;
      } catch {
        continue;
      }

      // liquidity check (ATR)
      const pipSize = (symbol.includes('XAU') || symbol.includes('JPY')) ? 0.01 : 0.0001;
      const atrVal = atr(window, 20) || pipSize * 100;
      const atrPips = priceToPip(symbol, atrVal);
      const minAtr = symbol.includes('XAU') ? 30 : 2.5;
      if (atrPips < minAtr) continue;

      passedFilters++;
    }

    console.log({ totalCandidates, passedFilters, candidateRate: `${((passedFilters/totalCandidates)||0*100).toFixed(2)}%` });
  }
}

run().catch(err => {
  console.error('Replay failed', err);
  process.exit(1);
});
