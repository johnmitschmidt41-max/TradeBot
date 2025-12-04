import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Store active SSE connections and logs
const clients = {
  'mainbot': { connections: new Set(), logs: [], lastLine: 0 },
  'python-bridge': { connections: new Set(), logs: [], lastLine: 0 },
  'scorer': { connections: new Set(), logs: [], lastLine: 0 }
};

const MAX_LOGS = 500;
const LOG_CHECK_INTERVAL = 500; // Check for new logs every 500ms

// Helper to broadcast logs
function broadcastLog(service, log) {
  // Normalize incoming log (string or object) into a structured object
  let structured = null;
  if (typeof log === 'object' && log !== null) {
    structured = log;
  } else if (typeof log === 'string') {
    // if it's a serialized JSON we can parse it
    try {
      structured = JSON.parse(log);
    } catch (_e) {
      // Try to split line content into timestamp/level/message and optional JSON
      const lines = log.split('\n');
      const first = lines[0] || '';
      const m = first.match(/^\[(.*?)\]\s*(\w+)?:?\s*(.*)$/);
      const timestamp = m ? m[1] : new Date().toLocaleTimeString('en-US');
      const level = m && m[2] ? m[2].toUpperCase() : 'INFO';
      const message = m ? m[3] : log;
      let data = null;
      if (lines.length > 1) {
        try { data = JSON.parse(lines.slice(1).join('\n')); } catch (e) { data = null; }
      }
      structured = { timestamp, level, message, data };
    }
  }

  // push structured log
  clients[service].logs.push(structured);
  if (clients[service].logs.length > MAX_LOGS) {
    clients[service].logs.shift();
  }

  // Broadcast structured JSON to each connection
  clients[service].connections.forEach((res) => {
    try {
      res.write(`data: ${JSON.stringify(structured)}\n\n`);
    } catch (e) {
      // fallback
      res.write(`data: ${String(log)}\n\n`);
    }
  });
}

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

  // Send existing logs (already normalized to structured objects)
  clients[service].logs.forEach((log) => {
    try {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch (e) {
      res.write(`data: ${String(log)}\n\n`);
    }
  });

  // Send initial connection message as structured object
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toLocaleTimeString('en-US'), level: 'INFO', message: `Connected to ${service} logs`, data: null })}\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(`: keep-alive\n\n`);
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    clients[service].connections.delete(res);
    clearInterval(keepAlive);
    res.end();
  });
});

// Monitor log files and pipes - adapt paths as needed
function monitorService(service, logPath) {
  const checkInterval = setInterval(() => {
    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        
        // Only send new lines since last check
        if (lines.length > clients[service].lastLine) {
          for (let i = clients[service].lastLine; i < lines.length; i++) {
            if (lines[i].trim()) {
              broadcastLog(service, lines[i]);
            }
          }
          clients[service].lastLine = lines.length;
        }
      }
    } catch (err) {
      console.error(`Error reading ${service} logs:`, err.message);
    }
  }, LOG_CHECK_INTERVAL);

  return checkInterval;
}

// POST endpoint to receive logs from services
app.post('/api/log', (req, res) => {
  const { service, message, level, data } = req.body;

  if (!service || !message) {
    res.status(400).json({ error: 'Missing service or message' });
    return;
  }

  // Normalize service name (remove dashes, convert to camelCase)
  let serviceKey = service.toLowerCase();
  if (serviceKey === 'python-bridge' || serviceKey === 'pythonbridge') {
    serviceKey = 'python-bridge';
  } else if (serviceKey === 'mainbot') {
    serviceKey = 'mainbot';
  } else if (serviceKey === 'scorer') {
    serviceKey = 'scorer';
  }

  if (!clients[serviceKey]) {
    console.error(`Unknown service: ${service}`);
    res.status(400).json({ error: `Unknown service: ${service}` });
    return;
  }

  // Format the log entry
  const timestamp = new Date().toLocaleTimeString('en-US', { 
    hour12: true, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
  
  // Build structured log object
  const logEntry = { timestamp, level: (level || 'info').toUpperCase(), message, data: data || null };

  console.log(`[${serviceKey}] ${message} (data: ${data ? 'yes' : 'no'})`);
  broadcastLog(serviceKey, logEntry);
  res.json({ success: true, service: serviceKey });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      mainbot: {
        connected: clients.mainbot.connections.size,
        logs: clients.mainbot.logs.length
      },
      'python-bridge': {
        connected: clients['python-bridge'].connections.size,
        logs: clients['python-bridge'].logs.length
      },
      scorer: {
        connected: clients.scorer.connections.size,
        logs: clients.scorer.logs.length
      }
    }
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    services: {
      mainbot: clients.mainbot.logs.length,
      'python-bridge': clients['python-bridge'].logs.length,
      scorer: clients.scorer.logs.length
    }
  });
});

// Start server
app.listen(port, () => {
  console.log(`\n📊 TradeBot Log Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend: http://localhost:5173`);
  console.log(`\n📝 Log Source Configuration:`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ Ready to receive logs from running services`);
  console.log(`✓ Logs are captured via SSE (Server-Sent Events)`);
  console.log(`✓ Max ${MAX_LOGS} logs per service in memory`);
  console.log(`\n🚀 To get started:`);
  console.log(`1. Run the frontend: npm run dev`);
  console.log(`2. Start your services (mainbot, python bridge, scorer) in separate terminals`);
  console.log(`3. Configure their output to send logs here`);
  console.log(`4. Open http://localhost:5173 in your browser\n`);

  // Optional: Monitor log files if they exist
  const mainbotLogPath = join(__dirname, '..', '..', 'mainbot', 'data', 'logs', 'app.log');
  const pythonLogPath = join(__dirname, '..', '..', 'mainbot', 'data', 'logs', 'python.log');
  const scorerLogPath = join(__dirname, '..', '..', 'mainbot', 'data', 'logs', 'scorer.log');

  // These are optional - uncomment if you want file-based log monitoring
  // monitorService('mainbot', mainbotLogPath);
  // monitorService('python-bridge', pythonLogPath);
  // monitorService('scorer', scorerLogPath);
});
