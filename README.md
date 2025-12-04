# TradeBot Logs Dashboard

A real-time terminal logs viewer for your TradeBot services. View logs from mainbot, Python bridge, and scorer in a beautiful dashboard - accessible from anywhere!

## Features

✅ **Real-time log streaming** - SSE (Server-Sent Events) for instant updates  
✅ **3 separate log boxes** - MainBot, Python Bridge, Scorer  
✅ **Beautiful UI** - Tailwind CSS styling with dark theme  
✅ **Auto-scroll** - Automatically scrolls to latest logs  
✅ **Responsive design** - Works on desktop, tablet, mobile  
✅ **Connection status** - Green/red indicator for each service  
✅ **Log history** - Keeps last 500 logs per service  

## Quick Start

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation

```bash
cd frontend
npm install
cd server
npm install
```

### Running the Dashboard

#### Terminal 1 - Start the backend server:
```bash
cd frontend/server
npm start
# Server runs on http://localhost:3001
```

#### Terminal 2 - Start the frontend:
```bash
cd frontend
npm run dev
# Frontend runs on http://localhost:5173
```

Then open http://localhost:5173 in your browser.

## Expose from anywhere with ngrok (optional)

If you want to access the dashboard remotely (e.g. from your phone or another machine), use ngrok to expose both the frontend and the backend.

Option A — Node helper (recommended):

1. Make sure you've run server `npm install` so `ngrok` is available as a dev dependency:

```bash
cd frontend/server
npm install
```

2. Start your backend and frontend locally (in separate terminals):

```bash
# Terminal 1 (backend)
cd frontend/server
npm start

# Terminal 2 (frontend)
cd frontend
npm run dev
```

3. In a third terminal run the tunnel helper (this will open two public URLs — one for frontend, one for backend):

```bash
cd frontend/server
npm run tunnel  # or `node start-ngrok.js 5174 3001` to specify ports
```

Option B — ngrok CLI (manual):

1. Install ngrok: https://ngrok.com/download and authenticate with your token.
2. Run two tunnels (replace ports with the ports your servers are running on):

```bash
ngrok http 5174
ngrok http 3001
```

Notes:
- If using Vite dev server it may pick a different port (5174) when 5173 is busy — use whatever it's showing in your terminal.
- Keep both tunnels open while you use the dashboard; ngrok will print the public URLs you can open anywhere.

## Sending Logs

There are multiple ways to send logs to the dashboard:

### Option 1: POST endpoint (Simple)

```bash
curl -X POST http://localhost:3001/api/log \
  -H "Content-Type: application/json" \
  -d '{
    "service": "mainbot",
    "message": "Trade executed",
    "level": "info"
  }'
```

### Option 2: JavaScript/Node.js

```javascript
// In your Node.js service
async function sendLog(service, message) {
  await fetch('http://localhost:3001/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service: service,
      message: message,
      level: 'info'
    })
  });
}

// Usage
sendLog('mainbot', 'Service started');
sendLog('scorer', 'Model predictions ready');
```

### Option 3: Pipe console output

```javascript
// Capture all console.log calls and send to dashboard
const originalLog = console.log;
console.log = (...args) => {
  originalLog(...args); // Still log to console
  
  // Send to dashboard
  fetch('http://localhost:3001/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service: 'mainbot',
      message: args.join(' '),
      level: 'info'
    })
  }).catch(() => {}); // Ignore errors
};
```

### Option 4: Python script

```python
import requests
import json
from datetime import datetime

def send_log(service, message, level='info'):
    """Send log to dashboard"""
    try:
        requests.post('http://localhost:3001/api/log', 
            headers={'Content-Type': 'application/json'},
            json={
                'service': service,
                'message': message,
                'level': level
            },
            timeout=1
        )
    except:
        pass  # Silently ignore if server is down

# Usage
send_log('python-bridge', 'Connected to MT5')
send_log('scorer', 'Training complete', 'info')
```

## API Reference

### POST /api/log
Send a log message

```bash
curl -X POST http://localhost:3001/api/log \
  -H "Content-Type: application/json" \
  -d '{
    "service": "mainbot|python-bridge|scorer",
    "message": "Your log message",
    "level": "info|warn|error|debug"
  }'
```

### GET /api/logs/:service
Stream logs via SSE (used by frontend)

```bash
# In your browser, the React component automatically connects to:
# /api/logs/mainbot
# /api/logs/python-bridge
# /api/logs/scorer
```

### GET /api/health
Check server status

```bash
curl http://localhost:3001/api/health
```

### POST /api/demo/:service
Send demo logs (for testing)

```bash
curl -X POST http://localhost:3001/api/demo/mainbot
```

### POST /api/clear/:service
Clear all logs for a service

```bash
curl -X POST http://localhost:3001/api/clear/scorer
```

## Architecture

### Frontend (React + TypeScript)
- `src/App.tsx` - Main dashboard component
- `src/main.tsx` - Entry point
- `src/index.css` - Global styles
- Three `LogBox` components for each service

### Backend (Express.js)
- `server/simple-server.js` - Main server with log endpoints
- `server/server-sse.js` - Alternative SSE-based server
- `server/server.js` - Process spawning server (advanced)

## Integration Examples

### Integrate with MainBot (TypeScript)

In your mainbot service:

```typescript
// src/strategy/jusdtt-m15.ts
async function sendLog(message: string) {
  try {
    await fetch('http://localhost:3001/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'mainbot',
        message,
        level: 'info'
      })
    });
  } catch (e) {} // Ignore
}

// Use it:
await sendLog('Trade signal detected');
```

### Integrate with Python Bridge

```python
# src/core/mt5-bridge.py
import requests

def log(message, level='info'):
    try:
        requests.post('http://localhost:3001/api/log', 
            json={'service': 'python-bridge', 'message': message, 'level': level},
            timeout=1
        )
    except:
        pass

# Use it:
log('Connected to MT5 account')
log('Order executed successfully')
```

## Troubleshooting

### Logs not appearing?

1. **Check server is running**
   ```bash
   curl http://localhost:3001/api/health
   ```

2. **Test with demo endpoint**
   ```bash
   curl -X POST http://localhost:3001/api/demo/mainbot
   ```

3. **Check frontend is connected**
   - Open browser DevTools (F12)
   - Look for EventSource connections in Network tab
   - You should see `/api/logs/mainbot`, `/api/logs/python-bridge`, `/api/logs/scorer`

4. **Verify CORS is enabled**
   - Server should have CORS enabled (it does by default)
   - Frontend at `http://localhost:5173` can access server at `http://localhost:3001`

### Port already in use?

Change the port in the server and update frontend proxy:

**server/simple-server.js:**
```javascript
const port = 3002; // Change from 3001
```

**frontend/vite.config.ts:**
```typescript
proxy: {
  '/api': {
    target: 'http://localhost:3002', // Update to match
    changeOrigin: true
  }
}
```

## Performance Notes

- **Max logs stored**: 500 per service (configurable)
- **Memory usage**: ~1-2MB per 500 logs
- **Network**: Very efficient with SSE (one persistent connection)
- **Auto-scroll**: Only when user is at bottom, prevents lag

## Deployment

For production deployment:

1. Build frontend:
   ```bash
   cd frontend
   npm run build
   # Creates dist/ folder
   ```

2. Serve with production server:
   ```bash
   # Use proper Node.js server with pm2 or systemd
   pm2 start frontend/server/simple-server.js
   ```

3. Update CORS if needed:
   ```javascript
   app.use(cors({
     origin: 'https://yourdomain.com'
   }));
   ```

## License

ISC
