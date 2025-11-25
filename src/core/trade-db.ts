import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'trades.db');

function ensureDir() {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch { /* ignore */ }
}

let db: any = null;
let usingSqlite = false;
let jsonFallbackPath = path.join(__dirname, '..', '..', 'data', 'trades.jsonl');

export function initDB() {
  if (db) return db;
  ensureDir();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER,
        symbol TEXT,
        side TEXT,
        orderType TEXT,
        entry REAL,
        price REAL,
        sl REAL,
        tp REAL,
        lots REAL,
        accountBalance REAL,
        metadata TEXT,
        result TEXT
      );
    `);
    usingSqlite = true;
  } catch (e) {
    // If better-sqlite3 isn't available (Windows w/o build tools), fall back to JSONL file.
    usingSqlite = false;
    try { fs.mkdirSync(path.dirname(jsonFallbackPath), { recursive: true }); } catch { }
    if (!fs.existsSync(jsonFallbackPath)) fs.writeFileSync(jsonFallbackPath, '');
  }
  return db;
}

export function insertSignal(signal: any) {
  try {
    initDB();
    if (usingSqlite && db) {
      const stmt = db.prepare(
        `INSERT INTO trades (time, symbol, side, orderType, entry, price, sl, tp, lots, accountBalance, metadata, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const metadata = JSON.stringify({ fvgDistancePips: signal.fvgDistancePips, slPips: signal.slPips, tpPips: signal.tpPips, dynamicMaxDistance: signal.dynamicMaxDistance, detectors: signal.detectors });
      const result = signal.result ? JSON.stringify(signal.result) : null;

      stmt.run(
        signal.time || Math.floor(Date.now()/1000),
        signal.symbol || null,
        signal.side || null,
        signal.orderType || null,
        signal.entry || null,
        signal.price || null,
        signal.sl || null,
        signal.tp || null,
        signal.lots || null,
        signal.accountBalance || null,
        metadata,
        result
      );
    } else {
      // JSONL fallback: append line
      const jsonLine = JSON.stringify(signal) + '\n';
      try { fs.appendFileSync(jsonFallbackPath, jsonLine, { encoding: 'utf8' }); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    // non-fatal
    // eslint-disable-next-line no-console
    console.warn('insertSignal DB failed', (err as any)?.message ?? err);
  }
}

export function countClosedTrades(): number {
  try {
    initDB();
    if (usingSqlite && db) {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM trades WHERE result IS NOT NULL`).get();
      return row?.cnt ?? 0;
    }
    // JSONL fallback: count lines with result
    if (!fs.existsSync(jsonFallbackPath)) return 0;
    const lines = fs.readFileSync(jsonFallbackPath, 'utf8').trim().split('\n').filter(Boolean);
    let cnt = 0;
    for (const l of lines) {
      try { const obj = JSON.parse(l); if (obj?.result && typeof obj.result.profit !== 'undefined') cnt++; } catch { }
    }
    return cnt;
  } catch (err) {
    return 0;
  }
}

export default { initDB, insertSignal, countClosedTrades };
