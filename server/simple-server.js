import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// In-memory log storage
const services = {
  'mainbot': { logs: [], queue: [] },
  'python-bridge': { logs: [], queue: [] },
  'scorer': { logs: [], queue: [] }
};

const MAX_LOGS = 500;

// Store connected clients for streaming
const clients = {
  'mainbot': new Set(),
  'python-bridge': new Set(),
  'scorer': new Set()
};

// POST endpoint to receive logs
app.post('/api/log', (req, res) => {
  const { service, message, level = 'info', data } = req.body;

  if (!services[service]) {
    return res.status(400).json({ error: `Unknown service: ${service}` });
  }

  // Create structured log object
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    level: level.toUpperCase(),
    message,
    data
  };

  // Store structured object (not a double-encoded string)
  services[service].logs.push(logEntry);
  if (services[service].logs.length > MAX_LOGS) {
    services[service].logs.shift();
  }

  // Broadcast to all connected clients as JSON
  clients[service].forEach((res) => {
    res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });

  res.json({ success: true });
});

// GET endpoint for SSE
app.get('/api/logs/:service', (req, res) => {
  const service = req.params.service;

  if (!services[service]) {
    return res.status(404).json({ error: 'Service not found' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Register client
  clients[service].add(res);

  // Send all existing logs (they are structured objects)
  services[service].logs.forEach((log) => {
    try {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch (e) {
      // fallback to plain string
      res.write(`data: ${String(log)}\n\n`);
    }
  });

  // Send connection message
  res.write(`data: ${JSON.stringify({ 
    timestamp: new Date().toLocaleTimeString(),
    level: 'INFO',
    message: `✓ Connected to ${service}`,
    data: null
  })}\n\n`);

  // Keep-alive ping
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clients[service].delete(res);
    clearInterval(keepAlive);
    res.end();
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      mainbot: { logs: services.mainbot.logs.length, clients: clients.mainbot.size },
      'python-bridge': { logs: services['python-bridge'].logs.length, clients: clients['python-bridge'].size },
      scorer: { logs: services.scorer.logs.length, clients: clients.scorer.size }
    }
  });
});

// Clear logs
app.post('/api/clear/:service', (req, res) => {
  const service = req.params.service;
  if (services[service]) {
    services[service].logs = [];
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Service not found' });
  }
});

// Demo endpoint to test logs
app.post('/api/demo/:service', (req, res) => {
  const service = req.params.service;
  const demoMessages = [
    '🚀 Service started',
    '📊 Initializing connections...',
    '✓ Connected to database',
    '⚙️ Loading configuration',
    '📈 Market data stream active',
    '🤖 AI model loaded',
    '💹 Ready to trade'
  ];

  if (services[service]) {
    let delay = 0;
    demoMessages.forEach((msg, idx) => {
      setTimeout(() => {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = { timestamp, level: 'INFO', message: msg, data: null };
        services[service].logs.push(logEntry);
        if (services[service].logs.length > MAX_LOGS) {
          services[service].logs.shift();
        }
        clients[service].forEach((res) => {
          res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
        });
      }, delay);
      delay += 300;
    });
    res.json({ success: true, message: 'Demo logs scheduled' });
  } else {
    res.status(404).json({ error: 'Service not found' });
  }
});

app.listen(port, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`📊 TradeBot Log Dashboard Server`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`\n🌐 Server running on http://localhost:${port}`);
  console.log(`🎨 Frontend runs on   http://localhost:5173`);
  console.log(`\n📡 API Endpoints:`);
  console.log(`  POST   /api/log              - Send a log`);
  console.log(`  GET    /api/logs/:service    - Stream logs (SSE)`);
  console.log(`  GET    /api/health           - Health check`);
  console.log(`  POST   /api/demo/:service    - Send demo logs`);
  console.log(`  POST   /api/clear/:service   - Clear logs`);
  console.log(`\n💡 Quick test: curl -X POST http://localhost:3001/api/demo/mainbot`);
  console.log(`${'═'.repeat(50)}\n`);
});
