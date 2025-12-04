import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { 
  connectDB, 
  saveTrade, 
  updateTrade, 
  getTrades, 
  getTradeStats 
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
const ALL_SYMBOLS = ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz'];

// Live setup state (what the bot currently sees)
let liveSetups = {};
ALL_SYMBOLS.forEach(s => liveSetups[s] = null);

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

// POST endpoint to update a setup (called by bot)
app.post('/api/setup', (req, res) => {
  const { symbol, setup } = req.body;
  if (symbol && liveSetups.hasOwnProperty(symbol)) {
    liveSetups[symbol] = setup;
    // Broadcast to all SSE clients
    const data = JSON.stringify({ timestamp: new Date().toISOString(), setups: liveSetups });
    clients.setups.connections.forEach((client) => {
      try { client.write(`data: ${data}\n\n`); } catch {}
    });
  }
  res.json({ ok: true });
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
    const trades = await getTrades(filter, parseInt(limit), parseInt(skip));
    res.json(trades || []);
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
    res.json(stats || { error: 'No data' });
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
  
  if (runningProcesses[name]) {
    return res.status(400).json({ error: `${name} is already running` });
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

// Stop a service
app.post('/api/service/:name/stop', (req, res) => {
  const { name } = req.params;
  
  if (!serviceConfigs[name]) {
    return res.status(404).json({ error: `Unknown service: ${name}` });
  }
  
  const proc = runningProcesses[name];
  if (!proc) {
    return res.status(400).json({ error: `${name} is not running` });
  }
  
  try {
    // Kill the process tree on Windows
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', proc.pid, '/f', '/t'], { shell: true });
    } else {
      proc.kill('SIGTERM');
    }
    
    runningProcesses[name] = null;
    
    broadcastLog(name, { 
      timestamp: new Date().toLocaleTimeString(), 
      level: 'WARN', 
      message: `${name} stopped by user`,
      data: null
    });
    
    res.json({ ok: true, message: `${name} stopped` });
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
    // Stop if running
    const proc = runningProcesses[name];
    if (proc) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid, '/f', '/t'], { shell: true });
      } else {
        proc.kill('SIGTERM');
      }
      runningProcesses[name] = null;
      
      // Wait a bit for process to die
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
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

// Start server and connect to MongoDB
app.listen(port, async () => {
  console.log(`\n🚀 TradeBot Server running on http://localhost:${port}`);
  console.log(`📊 Setup visualization: http://localhost:${port}/api/setups/live`);
  console.log(`📈 Trade journal: http://localhost:${port}/api/trades\n`);

  // Connect to MongoDB
  await connectDB();

  console.log('\nServices are configured but not auto-started.');
  console.log('Run them separately in other terminals and they will stream logs here.');
});
