// frontend/server/db/mongodb.js
// MongoDB connection and trade storage

import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Connect to MongoDB using MONGODB_URI from env
 */
export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  
  if (!uri) {
    console.warn('⚠️ MONGODB_URI not set in .env - trade storage disabled');
    return null;
  }

  // List of connection configurations to try
  const configs = [
    { name: 'default', options: { serverSelectionTimeoutMS: 10000 } },
    { name: 'legacy SSL', options: { serverSelectionTimeoutMS: 10000, ssl: true } },
    { name: 'TLS with CA', options: { serverSelectionTimeoutMS: 10000, tls: true, tlsInsecure: true } },
    { name: 'allow invalid', options: { serverSelectionTimeoutMS: 10000, tls: true, tlsAllowInvalidCertificates: true } },
  ];

  for (const config of configs) {
    try {
      console.log(`🔄 Trying MongoDB connection: ${config.name}...`);
      client = new MongoClient(uri, config.options);
      await client.connect();
      db = client.db(process.env.MONGODB_DB || 'tradebot');
      
      // Create indexes for efficient queries
      await db.collection('trades').createIndex({ symbol: 1, openTime: -1 });
      await db.collection('trades').createIndex({ status: 1 });
      await db.collection('trades').createIndex({ ticket: 1 }, { unique: false });
      await db.collection('setups').createIndex({ symbol: 1, time: -1 });
      await db.collection('setups').createIndex({ status: 1 });
      
      console.log(`✅ Connected to MongoDB (${config.name})`);
      return db;
    } catch (err) {
      console.error(`❌ MongoDB ${config.name} failed:`, err.message.split('\n')[0]);
      if (client) {
        try { await client.close(); } catch {}
        client = null;
      }
    }
  }
  
  console.error('❌ All MongoDB connection attempts failed');
  console.log('💡 The journal will work without MongoDB - trades will be fetched directly from MT5');
  return null;
}

/**
 * Get database instance
 */
export function getDB() {
  return db;
}

/**
 * Close MongoDB connection
 */
export async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRADE OPERATIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Save a new trade to database
 */
export async function saveTrade(trade) {
  if (!db) return null;
  
  const doc = {
    ...trade,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  
  const result = await db.collection('trades').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Update trade (e.g., when closed)
 */
export async function updateTrade(tradeId, updates) {
  if (!db) return null;
  
  const result = await db.collection('trades').updateOne(
    { _id: tradeId },
    { 
      $set: { 
        ...updates, 
        updatedAt: new Date() 
      } 
    }
  );
  return result.modifiedCount > 0;
}

/**
 * Get trades with optional filters
 */
export async function getTrades(filter = {}, limit = 100) {
  if (!db) return [];
  
  return await db.collection('trades')
    .find(filter)
    .sort({ openTime: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Get trade statistics
 */
export async function getTradeStats(days = 30) {
  if (!db) return null;
  
  const since = new Date();
  since.setDate(since.getDate() - days);
  
  const trades = await db.collection('trades')
    .find({ openTime: { $gte: since }, status: 'closed' })
    .toArray();
  
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  
  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0,
    totalPnl: totalPnl.toFixed(2),
    avgPnl: trades.length > 0 ? (totalPnl / trades.length).toFixed(2) : 0
  };
}

// ═══════════════════════════════════════════════════════════════════
// SETUP OPERATIONS (for visualization)
// ═══════════════════════════════════════════════════════════════════

/**
 * Save a setup (detected but not yet traded)
 */
export async function saveSetup(setup) {
  if (!db) return null;
  
  const doc = {
    ...setup,
    status: 'pending', // pending, triggered, expired, cancelled
    createdAt: new Date()
  };
  
  const result = await db.collection('setups').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Update setup status
 */
export async function updateSetup(setupId, updates) {
  if (!db) return null;
  
  const result = await db.collection('setups').updateOne(
    { _id: setupId },
    { $set: { ...updates, updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/**
 * Get recent setups for visualization
 */
export async function getRecentSetups(limit = 50) {
  if (!db) return [];
  
  return await db.collection('setups')
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Get active (pending) setups
 */
export async function getActiveSetups() {
  if (!db) return [];
  
  return await db.collection('setups')
    .find({ status: 'pending' })
    .sort({ createdAt: -1 })
    .toArray();
}

// ═══════════════════════════════════════════════════════════════════
// BACKTEST RESULTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Save backtest run results
 */
export async function saveBacktestRun(results) {
  if (!db) return null;
  
  const doc = {
    ...results,
    createdAt: new Date()
  };
  
  const result = await db.collection('backtests').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Get backtest history
 */
export async function getBacktestHistory(limit = 20) {
  if (!db) return [];
  
  return await db.collection('backtests')
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}
