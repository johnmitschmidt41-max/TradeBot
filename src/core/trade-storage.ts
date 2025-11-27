import fs from 'fs';
import path from 'path';

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'output');
const FILE = path.join(OUT_DIR, 'trade_signals.jsonl');

function ensureDir() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

export type TradeSignal = {
  time: number; // epoch seconds
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  entry: number;
  price?: number;
  sl: number;
  tp: number;
  lots: number;
  accountBalance?: number;
  fvgDistancePips?: number;
  slPips?: number;
  tpPips?: number;
  // New fields: snapshot of features passed to the model and confirmation metadata
  modelFeatures?: Record<string, any>;
  confirmations?: {
    count?: number;
    list?: string[];
    bos?: boolean;
    liquidityGrab?: boolean;
    third?: { type?: string; ok?: boolean };
  };
  dynamicMaxDistance?: number;
  detectors?: Record<string, any>;
  status?: string; // 'signal'|'placed'|'closed' etc
  result?: { profit?: number; closedTime?: number; reason?: string } | null;
  // client-generated ID used to link open/placed signals ↔ orders/deals
  cid?: string;
  // broker-side ids (if known)
  order?: number | string;
  deal?: number | string;
};

export function persistTradeSignal(signal: TradeSignal) {
  try {
    ensureDir();
    const line = JSON.stringify(signal) + '\n';
    fs.appendFileSync(FILE, line, { encoding: 'utf8' });

    // Also insert into local SQLite DB (best-effort)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { insertSignal } = require('./trade-db');
      insertSignal(signal);
    } catch (e) {
      // ignore DB errors for now
    }
  } catch (err) {
    // Do not crash the bot for persistence failures
    // eslint-disable-next-line no-console
      // use formatter to avoid TypeScript errors accessing `.message` on unknown
      // (we intentionally don't rethrow)
      // import locally to avoid circular deps at top-level
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatError } = require('../utils/error');
      console.warn('persistTradeSignal failed', formatError(err));
  }
}

// Persist a signal and return a client id (cid). Ensures each placed signal
// can be referenced deterministically by later updates.
export function persistTradeSignalWithCid(signal: TradeSignal): string {
  try {
    ensureDir();
    // generate a compact unique id (timestamp-rand)
    const cid = `cid-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    (signal as any).cid = cid;
    const line = JSON.stringify(signal) + '\n';
    fs.appendFileSync(FILE, line, { encoding: 'utf8' });

    // also attempt DB insert
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { insertSignal } = require('./trade-db');
      insertSignal(signal);
    } catch (e) {}

    return cid;
  } catch (err) {
    const { formatError } = require('../utils/error');
    console.warn('persistTradeSignalWithCid failed', formatError(err));
    throw err;
  }
}

// Update an existing persisted signal by matching its client id (cid).
// Returns true if an update was applied.
export function updateSignalByCid(cid: string, updates: Partial<TradeSignal>): boolean {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return false;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    let updated = false;
    const out = lines.map(l => {
      if (updated) return l;
      try {
        const obj: any = JSON.parse(l);
        if (obj && obj.cid === cid) {
          const merged = { ...obj, ...updates };
          updated = true;
          return JSON.stringify(merged);
        }
      } catch (e) {}
      return l;
    });

    if (updated) {
      fs.writeFileSync(FILE, out.join('\n') + '\n', 'utf8');
    }

    return updated;
  } catch (err) {
    const { formatError } = require('../utils/error');
    console.warn('updateSignalByCid failed', formatError(err));
    return false;
  }
}

/**
 * Attempt to mark a previously saved 'placed' signal as closed by matching
 * a deal object returned from the bridge. This will rewrite the JSONL file in
 *-place to update the first matching placed signal (best-effort).
 */
export function markSignalClosedByDeal(deal: any, opts?: { priceTolerancePips?: number }) {
  try {
    ensureDir();
    const tolPips = opts?.priceTolerancePips ?? 3; // default tolerance
    if (!fs.existsSync(FILE)) return false;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    let updated = false;

    const out: string[] = lines.map(l => {
      if (updated) return l; // we only update one entry per deal
      try {
        const obj: TradeSignal = JSON.parse(l);
        // only attempt to match placed signals without results
        if (obj.status === 'placed' && (!obj.result || typeof obj.result.profit === 'undefined')) {
          // symbol and side must match
          const sym = (obj.symbol || '').toUpperCase();
          const dealSym = (deal.symbol || deal.symbol_name || '').toUpperCase();
          if (sym !== dealSym) return l;

          const side = obj.side;
          const dealSide = (deal.type === 0 || String(deal.type).toUpperCase().includes('BUY')) ? 'BUY' : 'SELL';
          if (side !== dealSide) return l;

          // Prefer matching by order/deal id if present
          const dealId = deal.deal ?? deal.deal_id ?? deal.ticket ?? null;
          const orderId = deal.order ?? deal.order_id ?? null;
          const dealComment = deal.comment ?? deal.comment_text ?? null;

          // If deal/order ids exist, try to match a placed signal by those ids
          if (dealId || orderId || dealComment) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { readSignals } = require('./trade-storage');
            // try exact id matches first
            if (orderId && obj.order == orderId) {
              obj.status = 'closed';
              obj.result = { profit: Number(deal.profit || 0), closedTime: Math.floor(Number(deal.time || deal.dealtime || Date.now()/1000)) };
              if (deal.deal) (obj as any).deal = deal.deal;
              if (deal.order) (obj as any).order = deal.order;
              updated = true;
              return JSON.stringify(obj);
            }
            if (dealId && obj.deal == dealId) {
              obj.status = 'closed';
              obj.result = { profit: Number(deal.profit || 0), closedTime: Math.floor(Number(deal.time || deal.dealtime || Date.now()/1000)) };
              if (deal.deal) (obj as any).deal = deal.deal;
              if (deal.order) (obj as any).order = deal.order;
              updated = true;
              return JSON.stringify(obj);
            }
            // try matching by client id stored in comment
            if (dealComment && obj.cid && String(dealComment).includes(String(obj.cid))) {
              obj.status = 'closed';
              obj.result = { profit: Number(deal.profit || 0), closedTime: Math.floor(Number(deal.time || deal.dealtime || Date.now()/1000)) };
              if (deal.deal) (obj as any).deal = deal.deal;
              if (deal.order) (obj as any).order = deal.order;
              updated = true;
              return JSON.stringify(obj);
            }
          }

          // price match tolerance
          const entry = Number(obj.entry || obj.price || 0);
          const dealPrice = Number(deal.price || deal.entry || 0);
          if (!isFinite(entry) || !isFinite(dealPrice)) return l;

          // compute diff in pips
          // lazy require to avoid circular deps
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { priceToPip } = require('../utils/pip');
          const priceDiff = Math.abs(entry - dealPrice);
          const diffPips = priceToPip(sym, priceDiff);
          if (diffPips <= tolPips) {
            // update this object to include result/closedTime/profit and mark closed
            obj.status = 'closed';
            obj.result = { profit: Number(deal.profit || 0), closedTime: Math.floor(Number(deal.time || deal.dealtime || Date.now()/1000)) };
            // attach deal/order ids if provided
            if (deal.deal) (obj as any).deal = deal.deal;
            if (deal.order) (obj as any).order = deal.order;

            updated = true;
            return JSON.stringify(obj);
          }
        }
      } catch (e) {
        // ignore parse errors
      }
      return l;
    });

    if (updated) {
      fs.writeFileSync(FILE, out.join('\n') + '\n', 'utf8');
    }
    return updated;
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { formatError } = require('../utils/error');
    console.warn('markSignalClosedByDeal failed', formatError(err));
    return false;
  }
}

export function readSignals(): TradeSignal[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const data = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    return data.map(l => JSON.parse(l));
  } catch (err) {
    // eslint-disable-next-line no-console
      // use helper for unknown error shapes
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatError } = require('../utils/error');
      console.warn('readSignals failed', formatError(err));
    return [];
  }
}

/**
 * Analyze recent closed signals to decide whether SLs around targetSlPips
 * are frequently hit quickly (indicating a fragile SL pattern).
 * Returns aggregate stats that strategy can use to decide whether to widen SL.
 */
export function analyzeSlHitPattern(symbol: string, side: 'BUY' | 'SELL', targetSlPips: number, opts?: { tolerancePercent?: number; lookback?: number; fastSecs?: number; minSample?: number }) {
  try {
    const tolerancePercent = opts?.tolerancePercent ?? 0.25; // +/- 25%
    const lookback = opts?.lookback ?? 500;
    const fastSecs = opts?.fastSecs ?? 60 * 60; // default 1hr
    const minSample = opts?.minSample ?? 6;

    const all = readSignals().filter(s => s.symbol && s.side && s.result && typeof s.result.closedTime === 'number' && typeof s.slPips === 'number');
    // keep most recent first
    const recent = all.reverse().filter(s => s.symbol.toUpperCase() === symbol.toUpperCase() && s.side === side).slice(0, lookback);
    if (!recent || recent.length === 0) return { sampleCount: 0, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };

    // matching sl distances within tolerance
    const tol = Math.max(0.5, Math.abs(targetSlPips * tolerancePercent));
    const matched = recent.filter(s => Math.abs((s.slPips ?? 0) - targetSlPips) <= tol);
    const sampleCount = matched.length;
    if (sampleCount < minSample) return { sampleCount, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };

    const durations: number[] = [];
    let fastHitCount = 0;
    for (const s of matched) {
      const start = s.time || 0;
      const closed = (s.result && s.result.closedTime) || 0;
      const dur = Math.max(0, closed - start);
      durations.push(dur);
      // consider a fast SL hit when closed quickly with loss
      const profit = (s.result && typeof s.result.profit === 'number') ? (s.result.profit ?? 0) : 0;
      if (profit <= 0 && dur <= fastSecs) fastHitCount++;
    }

    const avgCloseSeconds = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0;
    const fastHitRate = sampleCount ? (fastHitCount / sampleCount) : 0;

    return { sampleCount, fastHitCount, fastHitRate, avgCloseSeconds };
  } catch (err) {
    return { sampleCount: 0, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };
  }
}

/**
 * Analyze recent entries (distance to edge/mid of FVG or distance-to-entry) to
 * determine whether a particular entry distance tends to be hit (lose) quickly
 * or performs well. Returns aggregated stats for strategy-driven entry refinement.
 */
export function analyzeEntryPattern(symbol: string, side: 'BUY' | 'SELL', entryDistancePips: number, opts?: { tolerancePercent?: number; lookback?: number; fastSecs?: number; minSample?: number }) {
  try {
    const tolerancePercent = opts?.tolerancePercent ?? 0.25; // +/- 25%
    const lookback = opts?.lookback ?? 500;
    const fastSecs = opts?.fastSecs ?? 60 * 60; // default 1hr
    const minSample = opts?.minSample ?? 6;

    const all = readSignals().filter(s => s.symbol && s.side && s.result && typeof s.result.closedTime === 'number' && typeof s.fvgDistancePips === 'number');
    const recent = all.reverse().filter(s => s.symbol.toUpperCase() === symbol.toUpperCase() && s.side === side).slice(0, lookback);
    if (!recent || recent.length === 0) return { sampleCount: 0, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };

    const tol = Math.max(0.5, Math.abs(entryDistancePips * tolerancePercent));
    const matched = recent.filter(s => Math.abs((s.fvgDistancePips ?? 0) - entryDistancePips) <= tol);
    const sampleCount = matched.length;
    if (sampleCount < minSample) return { sampleCount, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };

    const durations: number[] = [];
    let fastHitCount = 0;
    for (const s of matched) {
      const start = s.time || 0;
      const closed = (s.result && s.result.closedTime) || 0;
      const dur = Math.max(0, closed - start);
      durations.push(dur);
      const profit = (s.result && typeof s.result.profit === 'number') ? (s.result.profit ?? 0) : 0;
      if (profit <= 0 && dur <= fastSecs) fastHitCount++;
    }

    const avgCloseSeconds = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0;
    const fastHitRate = sampleCount ? (fastHitCount / sampleCount) : 0;

    return { sampleCount, fastHitCount, fastHitRate, avgCloseSeconds };
  } catch (err) {
    return { sampleCount: 0, fastHitCount: 0, fastHitRate: 0, avgCloseSeconds: 0 };
  }
}

export default { persistTradeSignal, readSignals, markSignalClosedByDeal, persistTradeSignalWithCid, updateSignalByCid };
