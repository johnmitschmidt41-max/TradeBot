import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { 
  connectDB, 
  saveTrade, 
  updateTrade, 
  getTrades, 
  getTradeStats,
  getDB
} from './db/mongodb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Store active SSE connections and logs
const clients = {
  'mainbot': { connections: new Set(), logs: [] },
  'python-bridge': { connections: new Set(), logs: [] },
  'scorer': { connections: new Set(), logs: [] },
  'setups': { connections: new Set(), logs: [] }  // Live setup visualization
};

const MAX_LOGS = 500;

// All symbols the bot tracks
const ALL_SYMBOLS = ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz', 'EURJPYz'];

// File path for persisting setups state
const SETUPS_STATE_FILE = join(__dirname, '../../mainbot/data/output/live_setups_state.json');

// File path for trading mode config
const TRADING_MODE_FILE = join(__dirname, '../../mainbot/data/config/trading_mode.json');

// Load persisted setups state or initialize fresh
function loadSetupsState() {
  try {
    if (fs.existsSync(SETUPS_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETUPS_STATE_FILE, 'utf-8'));
      console.log('📂 Loaded persisted setups state from file');
      // Ensure all symbols are present
      const state = {};
      ALL_SYMBOLS.forEach(s => state[s] = data[s] ?? null);
      return state;
    }
  } catch (err) {
    console.warn('⚠️ Failed to load setups state:', err.message);
  }
  // Initialize fresh
  const state = {};
  ALL_SYMBOLS.forEach(s => state[s] = null);
  return state;
}

// Save setups state to file
function saveSetupsState() {
  try {
    fs.writeFileSync(SETUPS_STATE_FILE, JSON.stringify(liveSetups, null, 2));
  } catch (err) {
    console.warn('⚠️ Failed to save setups state:', err.message);
  }
}

// Live setup state (what the bot currently sees) - load from file or initialize
let liveSetups = loadSetupsState();

// Helper to broadcast logs to all connected clients
function broadcastLog(service, log) {
  // Normalize and store as structured object
  let structured = null;
  if (typeof log === 'object' && log !== null) structured = log;
  else if (typeof log === 'string') {
    try { structured = JSON.parse(log); } catch (_e) {
      const m = log.match(/^\[(.*?)\]\s*(\w+)?:?\s*(.*)$/);
      const timestamp = m ? m[1] : new Date().toLocaleTimeString();
      const level = m && m[2] ? m[2].toUpperCase() : 'INFO';
      const message = m ? m[3] : log;
      structured = { timestamp, level, message, data: null };
    }
  }

  clients[service].logs.push(structured);
  if (clients[service].logs.length > MAX_LOGS) {
    clients[service].logs.shift();
  }

  clients[service].connections.forEach((res) => {
    try { res.write(`data: ${JSON.stringify(structured)}\n\n`); } catch { res.write(`data: ${String(log)}\n\n`); }
  });
}

// POST endpoint to receive logs from mainbot/services
app.post('/api/log', (req, res) => {
  const { service, message, level, data } = req.body;
  
  // Default to mainbot if no service specified
  const targetService = service || 'mainbot';
  
  if (!clients[targetService]) {
    res.status(404).json({ error: 'Service not found' });
    return;
  }
  
  // Build structured log object
  const structured = {
    timestamp: new Date().toLocaleTimeString(),
    level: (level || 'INFO').toUpperCase(),
    message: message || '',
    data: data || null
  };
  
  // Broadcast to all connected clients
  broadcastLog(targetService, structured);
  
  res.json({ ok: true });
});

// SSE endpoint for logs
app.get('/api/logs/:service', (req, res) => {
  const service = req.params.service;

  if (!clients[service]) {
    res.status(404).json({ error: 'Service not found' });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Register client
  clients[service].connections.add(res);

  // Send existing logs
  clients[service].logs.forEach((log) => {
    try { res.write(`data: ${JSON.stringify(log)}\n\n`); } catch { res.write(`data: ${String(log)}\n\n`); }
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toLocaleTimeString(), level: 'INFO', message: `Connected to ${service}`, data: null })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    clients[service].connections.delete(res);
    res.end();
  });
});

// Start mainbot process
function startMainBot() {
  const mainbotPath = join(__dirname, '..', 'mainbot');
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: mainbotPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  proc.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] ${line}`);
      }
    });
  });

  proc.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        // Check if it's a successful HTTP request or normal info - don't mark as error
        const isHttpSuccess = /"\s*(GET|POST|PUT|DELETE|PATCH)\s+[^"]+"\s+(200|201|204)\s+/.test(line);
        const isNormalLog = /\[INFO\]|\[DEBUG\]|ts-node-dev/.test(line);
        if (isHttpSuccess || isNormalLog) {
          broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] ${line}`);
        } else {
          broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] ERROR ${line}`);
        }
      }
    });
  });

  proc.on('error', (err) => {
    broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] Process error: ${err.message}`);
  });

  proc.on('close', (code) => {
    broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] Process exited with code ${code}`);
  });
}

// Start Python bridge process
function startPythonBridge() {
  const pythonPath = join(__dirname, '..', 'mainbot', 'src', 'core');
  const proc = spawn('python', ['mt5-bridge.py'], {
    cwd: pythonPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  proc.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        broadcastLog('python-bridge', `[${new Date().toLocaleTimeString()}] ${line}`);
      }
    });
  });

  proc.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        // Check if it's a successful HTTP request (200, 201, etc.) - don't mark as error
        // Also check for common success patterns in Python Flask logs
        const isSuccess = 
          line.includes('" 200') || 
          line.includes('" 201') || 
          line.includes('" 204') ||
          line.includes('Fetched') || 
          line.includes('request:') ||
          line.includes('candles for') ||
          line.includes('Running on') ||
          line.includes('Serving Flask');
        
        if (isSuccess) {
          broadcastLog('python-bridge', `[${new Date().toLocaleTimeString()}] ${line}`);
        } else {
          broadcastLog('python-bridge', `[${new Date().toLocaleTimeString()}] ERROR ${line}`);
        }
      }
    });
  });

  proc.on('error', (err) => {
    broadcastLog('python-bridge', `[${new Date().toLocaleTimeString()}] Process error: ${err.message}`);
  });

  proc.on('close', (code) => {
    broadcastLog('python-bridge', `[${new Date().toLocaleTimeString()}] Process exited with code ${code}`);
  });
}

// Start scorer process
function startScorer() {
  const mainbotPath = join(__dirname, '..', 'mainbot');
  const proc = spawn('python', ['scripts/scorer_server.py'], {
    cwd: mainbotPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  proc.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        broadcastLog('scorer', `[${new Date().toLocaleTimeString()}] ${line}`);
      }
    });
  });

  proc.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        // Check if it's a successful HTTP request - don't mark as error
        const isHttpSuccess = /HTTP\/[0-9.]+"\s+(200|201|204)/.test(line) || /Fetched|request:|Running|Loaded/.test(line);
        if (isHttpSuccess) {
          broadcastLog('scorer', `[${new Date().toLocaleTimeString()}] ${line}`);
        } else {
          broadcastLog('scorer', `[${new Date().toLocaleTimeString()}] ERROR ${line}`);
        }
      }
    });
  });

  proc.on('error', (err) => {
    broadcastLog('scorer', `[${new Date().toLocaleTimeString()}] Process error: ${err.message}`);
  });

  proc.on('close', (code) => {
    broadcastLog('scorer', `[${new Date().toLocaleTimeString()}] Process exited with code ${code}`);
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      mainbot: clients.mainbot.connections.size,
      'python-bridge': clients['python-bridge'].connections.size,
      scorer: clients.scorer.connections.size
    }
  });
});

// Trading mode endpoint - returns current mode (DEMO/REAL)
app.get('/api/mode', (req, res) => {
  try {
    if (fs.existsSync(TRADING_MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRADING_MODE_FILE, 'utf-8'));
      return res.json({ mode: data.mode || 'DEMO' });
    }
    res.json({ mode: 'DEMO' });
  } catch (err) {
    console.warn('⚠️ Failed to read trading mode:', err.message);
    res.json({ mode: 'DEMO' });
  }
});

// Switch trading mode endpoint - POST to change mode
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  if (!mode || !['DEMO', 'REAL'].includes(mode.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid mode. Must be DEMO or REAL' });
  }
  
  try {
    let data = { mode: 'DEMO', lastSwitchTime: null, consecutiveLosses: 0 };
    
    // Read existing file if it exists
    if (fs.existsSync(TRADING_MODE_FILE)) {
      data = JSON.parse(fs.readFileSync(TRADING_MODE_FILE, 'utf-8'));
    }
    
    // Update mode and timestamp
    data.mode = mode.toUpperCase();
    data.lastSwitchTime = new Date().toISOString();
    
    // Write back
    fs.writeFileSync(TRADING_MODE_FILE, JSON.stringify(data, null, 2));
    
    console.log(`🔄 Trading mode switched to: ${data.mode}`);
    
    res.json({ 
      ok: true, 
      mode: data.mode, 
      message: `Trading mode switched to ${data.mode}. Restart Python Bridge to apply.` 
    });
  } catch (err) {
    console.error('Failed to switch mode:', err.message);
    res.status(500).json({ error: `Failed to switch mode: ${err.message}` });
  }
});

// Account info endpoint - proxies to Python bridge
app.get('/api/account', async (req, res) => {
  try {
    const response = await fetch(`${MT5_BRIDGE_URL}/health`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ 
      status: 'disconnected', 
      trading_mode: 'UNKNOWN',
      account: null,
      server: null,
      error: 'Python bridge not reachable'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// LIVE SETUP VISUALIZATION
// ═══════════════════════════════════════════════════════════════════

// SSE endpoint for live setups
app.get('/api/setups/live', (req, res) => {
  console.log('New SSE connection for live setups');
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  clients.setups.connections.add(res);
  console.log(`Live setups connections: ${clients.setups.connections.size}`);

  // Send current state immediately
  const initialData = JSON.stringify({ timestamp: new Date().toISOString(), setups: liveSetups });
  res.write(`data: ${initialData}\n\n`);

  // Send keepalive every 15 seconds to prevent timeout
  const keepalive = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch (e) {
      clearInterval(keepalive);
    }
  }, 15000);

  req.on('close', () => {
    console.log('SSE connection closed for live setups');
    clearInterval(keepalive);
    clients.setups.connections.delete(res);
    res.end();
  });
});

// GET endpoint to fetch current setups (for polling fallback)
app.get('/api/setups', (req, res) => {
  res.json({ timestamp: new Date().toISOString(), setups: liveSetups });
});

// POST endpoint to update a setup (called by bot)
app.post('/api/setup', (req, res) => {
  const { symbol, setup } = req.body;
  if (symbol && liveSetups.hasOwnProperty(symbol)) {
    liveSetups[symbol] = setup;
    
    // Persist state to file (survives server restart)
    saveSetupsState();
    
    // Broadcast to all SSE clients
    const data = JSON.stringify({ timestamp: new Date().toISOString(), setups: liveSetups });
    clients.setups.connections.forEach((client) => {
      try { client.write(`data: ${data}\n\n`); } catch {}
    });
  }
  res.json({ ok: true });
});

// TEST endpoint to inject a fake setup for testing the dashboard display
app.post('/api/test-setup', (req, res) => {
  const { symbol, side, action } = req.body;
  
  if (action === 'clear') {
    // Clear test setup
    if (symbol && liveSetups.hasOwnProperty(symbol)) {
      liveSetups[symbol] = { status: 'scanning', symbol, updatedAt: new Date().toISOString() };
    }
    return res.json({ ok: true, message: `Cleared ${symbol}` });
  }
  
  // Default test symbol
  const testSymbol = symbol || 'GBPUSDz';
  const testSide = side || 'BUY';
  
  // Create a fake setup to test the dashboard
  const fakeSetup = {
    status: 'fvg_formed',
    symbol: testSymbol,
    side: testSide,
    currentPrice: testSide === 'BUY' ? 1.2650 : 1.2750,
    sweepLevel: testSide === 'BUY' ? 1.2600 : 1.2800,
    fvgHigh: testSide === 'BUY' ? 1.2680 : 1.2780,
    fvgLow: testSide === 'BUY' ? 1.2660 : 1.2760,
    fvgSide: testSide === 'BUY' ? 'BULL' : 'BEAR',
    entryPrice: testSide === 'BUY' ? 1.2665 : 1.2775,
    sl: testSide === 'BUY' ? 1.2590 : 1.2810,
    tp: testSide === 'BUY' ? 1.2815 : 1.2625,
    sweepCandlesAgo: 3,
    maxCandlesToWait: 15,
    detectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    setupType: 'reversal',
    tradingMode: 'sweep',
    sweepTimeRemaining: 45
  };
  
  liveSetups[testSymbol] = fakeSetup;
  
  // Broadcast to all SSE clients
  const data = JSON.stringify({ timestamp: new Date().toISOString(), setups: liveSetups });
  clients.setups.connections.forEach((client) => {
    try { client.write(`data: ${data}\n\n`); } catch {}
  });
  
  res.json({ ok: true, setup: fakeSetup });
});

// ═══════════════════════════════════════════════════════════════════
// OPEN POSITIONS (from MT5 Bridge)
// ═══════════════════════════════════════════════════════════════════

const MT5_BRIDGE_URL = process.env.MT5_BRIDGE || 'http://127.0.0.1:5000';

// Get all open positions from MT5
app.get('/api/positions', async (req, res) => {
  try {
    const symbol = req.query.symbol;
    const url = symbol 
      ? `${MT5_BRIDGE_URL}/positions?symbol=${symbol}`
      : `${MT5_BRIDGE_URL}/positions`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    // Transform to frontend format
    const positions = (data.positions || []).map(pos => ({
      ticket: pos.ticket,
      symbol: pos.symbol,
      side: pos.type === 'BUY' || pos.type === 0 ? 'BUY' : 'SELL',
      entryPrice: pos.price_open || pos.openPrice,
      currentPrice: pos.price_current,
      sl: pos.sl,
      tp: pos.tp,
      volume: pos.volume,
      profit: pos.profit,
      status: 'open'
    }));
    
    res.json({ positions });
  } catch (e) {
    console.error('Error fetching positions from bridge:', e.message);
    res.json({ positions: [] });
  }
});

// Get trade history from MT5 (limited to recent trades)
app.get('/api/history', async (req, res) => {
  try {
    // Default to last 24 hours, max 7 days
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const since = Math.floor(Date.now() / 1000) - (hours * 3600);
    
    console.log(`📡 Fetching MT5 history since ${new Date(since * 1000).toISOString()}`);
    
    const response = await fetch(`${MT5_BRIDGE_URL}/deals?since=${since}`);
    const data = await response.json();
    
    if (!data.deals || data.deals.length === 0) {
      console.log('📡 No deals returned from MT5 bridge');
      return res.json({ trades: [], synced: 0 });
    }
    
    console.log(`📡 Got ${data.deals.length} deals from MT5`);
    
    // MT5 deals structure:
    // - Entry deals: have order > 0, profit = 0, type 0/1 (BUY/SELL entry)
    // - Exit deals: have order = 0 (for SL/TP) or order > 0 (manual close), profit != 0, type 0/1 (close direction)
    // Exit deals for SL/TP have comment like "[sl xxx]" or "[tp xxx]"
    
    const closedTrades = [];
    const entryDeals = new Map(); // order -> entry deal
    
    // First pass: collect entry deals (profit = 0, order > 0, has symbol)
    for (const deal of data.deals) {
      if (!deal.symbol || deal.symbol === '') continue;
      if (deal.profit === 0 && deal.order > 0 && deal.volume > 0) {
        entryDeals.set(deal.order, deal);
      }
    }
    
    // Second pass: find exit deals and match with entries
    for (const deal of data.deals) {
      if (!deal.symbol || deal.symbol === '') continue;
      if (deal.profit === 0) continue; // Skip entry deals
      
      // This is a closed trade (has profit != 0)
      // For SL/TP hits, deal.order = 0, so we need to match by symbol/volume/time
      // For manual closes, deal.order > 0 and matches the entry
      
      let entryDeal = null;
      
      if (deal.order > 0) {
        // Manual close - order matches entry
        entryDeal = entryDeals.get(deal.order);
      }
      
      // Create trade record from the exit deal (it has all the info we need)
      // The deal.price is the close price, deal.type tells us direction
      const trade = {
        ticket: deal.order > 0 ? deal.order : `${deal.symbol}_${deal.time}`,
        symbol: deal.symbol,
        // For exits: type 0 = closed a SELL (so original was SELL), type 1 = closed a BUY (original was BUY)  
        // Wait, that's backwards. Let me check the data again...
        // Looking at the data: entry type 0 = BUY entry, exit type 1 = SELL to close (so original was BUY)
        // So exit type 1 means original position was BUY, exit type 0 means original was SELL
        side: deal.type === 1 ? 'BUY' : 'SELL',
        entryPrice: entryDeal ? entryDeal.price : 0,
        closePrice: deal.price,
        volume: deal.volume,
        profit: deal.profit,
        pnl: deal.profit,
        pnlPips: 0, // Calculate below
        openTime: entryDeal ? new Date(entryDeal.time * 1000).toISOString() : new Date((deal.time - 300) * 1000).toISOString(),
        closeTime: new Date(deal.time * 1000).toISOString(),
        status: 'closed',
        result: deal.profit > 0 ? 'win' : deal.profit < 0 ? 'loss' : 'breakeven',
        strategy: deal.comment || (entryDeal ? entryDeal.comment : 'Unknown')
      };
      
      // Calculate pips if we have both prices
      if (trade.entryPrice > 0 && trade.closePrice > 0) {
        const isXAU = deal.symbol.includes('XAU');
        const isJPY = deal.symbol.includes('JPY');
        const pipSize = isXAU ? 0.1 : isJPY ? 0.01 : 0.0001;
        if (trade.side === 'BUY') {
          trade.pnlPips = Math.round((trade.closePrice - trade.entryPrice) / pipSize);
        } else {
          trade.pnlPips = Math.round((trade.entryPrice - trade.closePrice) / pipSize);
        }
      }
      
      closedTrades.push(trade);
    }
    
    console.log(`📡 Processed ${closedTrades.length} closed trades`);
    
    // Sync to MongoDB (upsert each trade)
    let synced = 0;
    const db = getDB();
    if (db && closedTrades.length > 0) {
      for (const trade of closedTrades) {
        try {
          await db.collection('trades').updateOne(
            { ticket: trade.ticket },
            { $set: { ...trade, updatedAt: new Date() } },
            { upsert: true }
          );
          synced++;
        } catch (e) {
          console.error('Error upserting trade:', e.message);
        }
      }
      console.log(`📊 Synced ${synced} trades to MongoDB`);
    } else if (!db) {
      console.warn('⚠️ MongoDB not connected - trades not saved');
    }
    
    res.json({ trades: closedTrades, synced });
  } catch (e) {
    console.error('Error fetching history from bridge:', e.message);
    res.json({ trades: [], synced: 0, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TRADE JOURNAL (MongoDB)
// ═══════════════════════════════════════════════════════════════════

// Save a new trade
app.post('/api/trades', async (req, res) => {
  try {
    const trade = req.body;
    const result = await saveTrade(trade);
    res.json(result || { error: 'MongoDB not connected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get trades with optional filters
app.get('/api/trades', async (req, res) => {
  try {
    const { symbol, status, limit = 50, skip = 0 } = req.query;
    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (status) filter.status = status;
    
    // Try MongoDB first
    const trades = await getTrades(filter, parseInt(limit), parseInt(skip));
    
    // If MongoDB returned trades, use them
    if (trades && trades.length > 0) {
      return res.json(trades);
    }
    
    // Fallback: get trades directly from MT5 history (only for closed trades)
    if (!status || status === 'closed' || status === 'all') {
      console.log('📡 MongoDB empty or not connected, fetching from MT5...');
      try {
        const historyResponse = await fetch(`${MT5_BRIDGE_URL}/deals?since=${Math.floor(Date.now() / 1000) - 86400 * 7}`);
        const historyData = await historyResponse.json();
        
        if (historyData.deals && historyData.deals.length > 0) {
          // Parse deals into trades (same logic as /api/history)
          const closedTrades = [];
          const entryDeals = new Map();
          
          for (const deal of historyData.deals) {
            if (!deal.symbol || deal.symbol === '') continue;
            if (deal.profit === 0 && deal.order > 0 && deal.volume > 0) {
              entryDeals.set(deal.order, deal);
            }
          }
          
          for (const deal of historyData.deals) {
            if (!deal.symbol || deal.symbol === '') continue;
            if (deal.profit === 0) continue;
            if (symbol && !deal.symbol.includes(symbol)) continue;
            
            const entryDeal = deal.order > 0 ? entryDeals.get(deal.order) : null;
            
            closedTrades.push({
              _id: `mt5_${deal.order || deal.time}_${deal.symbol}`,
              ticket: deal.order > 0 ? deal.order : `${deal.symbol}_${deal.time}`,
              symbol: deal.symbol,
              side: deal.type === 1 ? 'BUY' : 'SELL',
              entryPrice: entryDeal ? entryDeal.price : 0,
              closePrice: deal.price,
              volume: deal.volume,
              profit: deal.profit,
              pnl: deal.profit,
              openTime: entryDeal ? new Date(entryDeal.time * 1000).toISOString() : new Date((deal.time - 300) * 1000).toISOString(),
              closeTime: new Date(deal.time * 1000).toISOString(),
              status: 'closed',
              result: deal.profit > 0 ? 'win' : deal.profit < 0 ? 'loss' : 'breakeven',
              strategy: deal.comment || 'Unknown'
            });
          }
          
          // Sort by closeTime descending
          closedTrades.sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());
          
          return res.json(closedTrades.slice(parseInt(skip), parseInt(skip) + parseInt(limit)));
        }
      } catch (mt5Error) {
        console.error('MT5 history fetch failed:', mt5Error.message);
      }
    }
    
    res.json([]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a trade (e.g., close it)
app.patch('/api/trades/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const result = await updateTrade(id, updates);
    res.json(result || { error: 'Trade not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get trade statistics
app.get('/api/trades/stats', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const stats = await getTradeStats(parseInt(days));
    
    // If MongoDB has stats, return them
    if (stats && stats.totalTrades > 0) {
      return res.json(stats);
    }
    
    // Fallback: calculate stats from MT5 history
    console.log('📡 Calculating stats from MT5 history...');
    try {
      const since = Math.floor(Date.now() / 1000) - (parseInt(days) * 86400);
      const historyResponse = await fetch(`${MT5_BRIDGE_URL}/deals?since=${since}`);
      const historyData = await historyResponse.json();
      
      if (historyData.deals && historyData.deals.length > 0) {
        // Count trades with profit != 0 (closed trades)
        const closedDeals = historyData.deals.filter(d => d.symbol && d.profit !== 0);
        const wins = closedDeals.filter(d => d.profit > 0).length;
        const losses = closedDeals.filter(d => d.profit < 0).length;
        const totalPnl = closedDeals.reduce((sum, d) => sum + d.profit, 0);
        
        return res.json({
          totalTrades: closedDeals.length,
          wins,
          losses,
          winRate: closedDeals.length > 0 ? (wins / closedDeals.length * 100).toFixed(1) : '0',
          totalPnl: totalPnl.toFixed(2),
          avgPnl: closedDeals.length > 0 ? (totalPnl / closedDeals.length).toFixed(2) : '0'
        });
      }
    } catch (mt5Error) {
      console.error('MT5 stats calculation failed:', mt5Error.message);
    }
    
    res.json({ totalTrades: 0, wins: 0, losses: 0, winRate: '0', totalPnl: '0', avgPnl: '0' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close a trade (from bot when trade closes)
app.post('/api/trades/close', async (req, res) => {
  try {
    const { ticket, symbol, side, entryPrice, closePrice, pnlPips, result, closeTime, status } = req.body;
    
    // Save/update trade in MongoDB if connected (upsert = create if not exists)
    const db = getDB();
    if (db) {
      await db.collection('trades').updateOne(
        { ticket },
        { 
          $set: { 
            ticket,
            symbol,
            side,
            entryPrice,
            closePrice, 
            pnlPips, 
            result, 
            closeTime,
            openTime: closeTime, // Use closeTime as openTime if we don't know
            status: 'closed',
            strategy: 'SweepFVG',
            updatedAt: new Date()
          } 
        },
        { upsert: true }  // Create if doesn't exist
      );
      console.log(`✅ Trade saved to MongoDB: ${symbol} ${side} - ${result}`);
    }
    
    // Broadcast to all connected clients
    const closeData = { ticket, symbol, side, entryPrice, closePrice, pnlPips, result, closeTime, status: 'closed' };
    clients.setups.connections.forEach((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'trade_closed', trade: closeData })}\n\n`);
      } catch (e) { /* ignore */ }
    });
    
    // Also broadcast as a log event
    broadcastLog('mainbot', `[${new Date().toLocaleTimeString()}] TRADE_CLOSED ${symbol} ${side} | Entry: ${entryPrice?.toFixed(5)} | Close: ${closePrice?.toFixed(5)} | P/L: ${pnlPips?.toFixed(1)} pips | ${result?.toUpperCase()}`);
    
    res.json({ success: true, ticket });
  } catch (e) {
    console.error('Error saving trade:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update open trade (live P/L updates)
app.post('/api/trades/update', async (req, res) => {
  try {
    const { ticket, symbol, side, entryPrice, currentPrice, unrealizedPips, sl, tp, status } = req.body;
    
    // Broadcast to all connected clients
    const updateData = { ticket, symbol, side, entryPrice, currentPrice, unrealizedPips, sl, tp, status };
    clients.setups.connections.forEach((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'trade_update', trade: updateData })}\n\n`);
      } catch (e) { /* ignore */ }
    });
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE CONTROL (Start/Stop/Restart)
// ═══════════════════════════════════════════════════════════════════

// Track running processes
const runningProcesses = {
  'mainbot': null,
  'python-bridge': null,
  'scorer': null
};

// Service configurations
const serviceConfigs = {
  'mainbot': {
    command: 'npm',
    args: ['run', 'dev'],
    cwd: join(__dirname, '../../mainbot')
  },
  'python-bridge': {
    command: 'python',
    args: ['mt5-bridge.py'],
    cwd: join(__dirname, '../../mainbot/src/core')
  },
  'scorer': {
    command: 'python',
    args: ['scorer_server.py'],
    cwd: join(__dirname, '../../mainbot/scripts')
  }
};

// Start a service
app.post('/api/service/:name/start', (req, res) => {
  const { name } = req.params;
  
  if (!serviceConfigs[name]) {
    return res.status(404).json({ error: `Unknown service: ${name}` });
  }
  
  // Check if tracked process is actually still alive
  if (runningProcesses[name]) {
    try {
      // Check if process is still running by sending signal 0
      process.kill(runningProcesses[name].pid, 0);
      return res.status(400).json({ error: `${name} is already running (PID: ${runningProcesses[name].pid})` });
    } catch (e) {
      // Process is dead, clear the reference
      console.log(`Tracked process for ${name} is dead, clearing reference`);
      runningProcesses[name] = null;
    }
  }
  
  const config = serviceConfigs[name];
  
  try {
    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    runningProcesses[name] = proc;
    
    // Pipe stdout/stderr to log stream
    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => broadcastLog(name, line));
    });
    
    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => broadcastLog(name, line));
    });
    
    proc.on('close', (code) => {
      runningProcesses[name] = null;
      broadcastLog(name, { 
        timestamp: new Date().toLocaleTimeString(), 
        level: 'WARN', 
        message: `Process exited with code ${code}`,
        data: null
      });
    });
    
    proc.on('error', (err) => {
      runningProcesses[name] = null;
      broadcastLog(name, { 
        timestamp: new Date().toLocaleTimeString(), 
        level: 'ERROR', 
        message: `Failed to start: ${err.message}`,
        data: null
      });
    });
    
    broadcastLog(name, { 
      timestamp: new Date().toLocaleTimeString(), 
      level: 'INFO', 
      message: `Starting ${name}...`,
      data: null
    });
    
    res.json({ ok: true, message: `${name} started` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper to kill a process by PID on Windows (synchronous)
function killProcess(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch (e) {
    console.warn(`Failed to kill PID ${pid}:`, e.message);
    return false;
  }
}

// Helper to find processes by name (Windows)
function findProcessesByName(processName) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`wmic process where "CommandLine like '%${processName}%'" get ProcessId`, { encoding: 'utf-8' });
      const pids = result.split('\n')
        .map(line => parseInt(line.trim()))
        .filter(pid => !isNaN(pid) && pid > 0);
      return pids;
    }
    return [];
  } catch (e) {
    return [];
  }
}

// Stop a service
app.post('/api/service/:name/stop', (req, res) => {
  const { name } = req.params;
  
  if (!serviceConfigs[name]) {
    return res.status(404).json({ error: `Unknown service: ${name}` });
  }
  
  try {
    let killed = false;
    
    // First try the tracked process
    const proc = runningProcesses[name];
    if (proc && proc.pid) {
      killed = killProcess(proc.pid);
      runningProcesses[name] = null;
    }
    
    // Also try to find and kill by process name patterns
    const config = serviceConfigs[name];
    const searchPatterns = {
      'mainbot': ['ts-node-dev', 'mainbot'],
      'python-bridge': ['mt5-bridge.py', 'mt5_bridge'],
      'scorer': ['scorer_server.py', 'scorer']
    };
    
    const patterns = searchPatterns[name] || [];
    for (const pattern of patterns) {
      const pids = findProcessesByName(pattern);
      for (const pid of pids) {
        if (killProcess(pid)) {
          killed = true;
          console.log(`Killed process ${pid} matching ${pattern}`);
        }
      }
    }
    
    if (killed) {
      broadcastLog(name, { 
        timestamp: new Date().toLocaleTimeString(), 
        level: 'WARN', 
        message: `${name} stopped by user`,
        data: null
      });
      res.json({ ok: true, message: `${name} stopped` });
    } else {
      res.json({ ok: true, message: `${name} was not running or already stopped` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restart a service
app.post('/api/service/:name/restart', async (req, res) => {
  const { name } = req.params;
  
  if (!serviceConfigs[name]) {
    return res.status(404).json({ error: `Unknown service: ${name}` });
  }
  
  try {
    // Stop if running - use same logic as stop endpoint
    const proc = runningProcesses[name];
    if (proc && proc.pid) {
      killProcess(proc.pid);
      runningProcesses[name] = null;
    }
    
    // Also try to find and kill by process name patterns
    const searchPatterns = {
      'mainbot': ['ts-node-dev', 'mainbot'],
      'python-bridge': ['mt5-bridge.py', 'mt5_bridge'],
      'scorer': ['scorer_server.py', 'scorer']
    };
    
    const patterns = searchPatterns[name] || [];
    for (const pattern of patterns) {
      const pids = findProcessesByName(pattern);
      for (const pid of pids) {
        killProcess(pid);
        console.log(`Killed process ${pid} matching ${pattern} for restart`);
      }
    }
    
    // Wait a bit for processes to die
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Start again
    const config = serviceConfigs[name];
    const newProc = spawn(config.command, config.args, {
      cwd: config.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    runningProcesses[name] = newProc;
    
    newProc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => broadcastLog(name, line));
    });
    
    newProc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => broadcastLog(name, line));
    });
    
    newProc.on('close', (code) => {
      runningProcesses[name] = null;
      broadcastLog(name, { 
        timestamp: new Date().toLocaleTimeString(), 
        level: 'WARN', 
        message: `Process exited with code ${code}`,
        data: null
      });
    });
    
    broadcastLog(name, { 
      timestamp: new Date().toLocaleTimeString(), 
      level: 'INFO', 
      message: `Restarting ${name}...`,
      data: null
    });
    
    res.json({ ok: true, message: `${name} restarted` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get service status
app.get('/api/service/:name/status', (req, res) => {
  const { name } = req.params;
  
  if (!serviceConfigs[name]) {
    return res.status(404).json({ error: `Unknown service: ${name}` });
  }
  
  const running = runningProcesses[name] !== null;
  res.json({ name, running, pid: running ? runningProcesses[name].pid : null });
});

// Get all services status
app.get('/api/services/status', (req, res) => {
  const status = {};
  for (const name of Object.keys(serviceConfigs)) {
    status[name] = {
      running: runningProcesses[name] !== null,
      pid: runningProcesses[name]?.pid || null
    };
  }
  res.json(status);
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

// Keep process alive
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
});

// Start server and connect to MongoDB
const server = app.listen(port, async () => {
  console.log(`\n🚀 TradeBot Server running on http://localhost:${port}`);
  console.log(`📊 Setup visualization: http://localhost:${port}/api/setups/live`);
  console.log(`📈 Trade journal: http://localhost:${port}/api/trades\n`);

  // Connect to MongoDB
  await connectDB();

  console.log('\nServices are configured but not auto-started.');
  console.log('Run them separately in other terminals and they will stream logs here.');
});
