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

export default { persistTradeSignal, readSignals };
