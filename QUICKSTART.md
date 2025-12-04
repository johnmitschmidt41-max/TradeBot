# 🚀 Quick Start Guide - TradeBot Logs Dashboard

## 1. Installation (2 minutes)

### Windows PowerShell:
```powershell
cd frontend
.\setup.ps1
```

### Linux/Mac:
```bash
cd frontend
bash setup.sh
```

### Manual:
```bash
cd frontend
npm install
cd server
npm install
cd ../..
```

## 2. Start the Services

### Terminal 1 - Backend Server:
```bash
cd frontend/server
npm start
# You'll see: 📊 TradeBot Log Dashboard Server
#            🌐 Server running on http://localhost:3001
```

### Terminal 2 - Frontend:
```bash
cd frontend
npm run dev
# You'll see: ➜  Local:   http://localhost:5173/
```

## 3. Open Dashboard

Open your browser and go to: **http://localhost:5173**

You should see 3 boxes: MainBot, Python Bridge, and Scorer (all gray, waiting for logs)

## 4. Send Test Logs

In a new terminal, send test logs to see it work:

```bash
# Test MainBot logs
curl -X POST http://localhost:3001/api/demo/mainbot

# Test Python Bridge logs
curl -X POST http://localhost:3001/api/demo/python-bridge

# Test Scorer logs
curl -X POST http://localhost:3001/api/demo/scorer
```

You should see logs appearing in real-time in the dashboard! 🎉

## Expose remotely with ngrok (optional)

If you want to view the dashboard from anywhere, using ngrok is easy. Either use the Node helper (already provided) or the ngrok CLI.

Node helper (recommended):

```powershell
# Ensure dependencies installed in server folder
cd frontend/server
npm install

# Start backend and frontend in separate terminals as above

# In a third terminal run the helper (powershell)
cd frontend\server
npm run tunnel
```

ngrok CLI:

```powershell
ngrok http 5173   # frontend (or whichever port Vite printed)
ngrok http 3001   # backend server
```

Use the public URL(s) printed by ngrok to open the dashboard and make sure the frontend can reach the backend URL when using the public endpoint(s).

## 5. Integrate with Your Services

### For MainBot (TypeScript):

Add this helper function anywhere in your code:

```typescript
async function dashboardLog(message: string, level = 'info') {
  try {
    await fetch('http://localhost:3001/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'mainbot', message, level })
    });
  } catch (e) {}
}

// Usage:
await dashboardLog('🚀 Trade signal detected');
await dashboardLog('❌ Connection failed', 'error');
```

### For Python Bridge:

```python
import requests

def log_dashboard(message, service='python-bridge', level='info'):
    try:
        requests.post('http://localhost:3001/api/log',
            json={'service': service, 'message': message, 'level': level},
            timeout=1
        )
    except:
        pass

# Usage:
log_dashboard('🐍 Connected to MT5')
log_dashboard('📊 Data stream started')
```

### For Scorer:

```python
# Same as Python Bridge
log_dashboard('⚡ Model training started', 'scorer')
log_dashboard('✓ Predictions ready', 'scorer')
```

## 6. View from Anywhere

Once deployed to the internet:

1. Set environment variable or update config:
   ```bash
   export LOG_SERVER_URL=https://logs.yourdomain.com
   ```

2. Any browser can access it: `https://logs.yourdomain.com`

3. Services send logs from anywhere using the same endpoint

## Troubleshooting

### "Connection refused" on http://localhost:3001

- Make sure Terminal 1 is running the backend server
- Check if port 3001 is available: `netstat -an | grep 3001` (Windows) or `lsof -i :3001` (Mac/Linux)

### Dashboard not showing logs

1. Check DevTools (F12) → Network → look for `/api/logs/...` connections
2. Try the demo endpoint: `curl -X POST http://localhost:3001/api/demo/mainbot`
3. Check server terminal for errors

### CORS errors

- This is already handled - CORS is enabled
- If you still get errors, the server might not be running

## Features Overview

✅ **Real-time streaming** - See logs as they happen  
✅ **3 separate services** - Each in its own box  
✅ **Auto-scroll** - Always shows latest  
✅ **Status indicator** - Green = connected, Red = disconnected  
✅ **Auto-scroll toggle** - Sticky at bottom  
✅ **Connection status** - See how many clients connected  

## API Quick Reference

```bash
# Send a log
curl -X POST http://localhost:3001/api/log \
  -H "Content-Type: application/json" \
  -d '{"service":"mainbot","message":"Hello","level":"info"}'

# Health check
curl http://localhost:3001/api/health

# Send demo logs (for testing)
curl -X POST http://localhost:3001/api/demo/scorer

# Clear all logs for a service
curl -X POST http://localhost:3001/api/clear/python-bridge
```

## Next Steps

1. ✅ Dashboard is running
2. 🔌 Integrate logging into your services
3. 📱 Access from your phone/tablet by using your PC's IP: `http://YOUR_PC_IP:5173`
4. 🚀 Deploy to cloud for remote monitoring

Enjoy real-time monitoring! 🎉
