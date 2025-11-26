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

export default { persistTradeSignal, readSignals, markSignalClosedByDeal, persistTradeSignalWithCid, updateSignalByCid };
