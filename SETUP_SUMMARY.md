# TradeBot Logs Dashboard - Complete Setup

## ✅ What Was Created

Your new logs dashboard consists of:

### Frontend (React + TypeScript + Tailwind)
```
frontend/
├── src/
│   ├── App.tsx                 # Main dashboard component
│   ├── main.tsx                # Entry point
│   └── index.css               # Global Tailwind styles
├── index.html                  # HTML template
├── vite.config.ts              # Vite configuration
├── tailwind.config.js          # Tailwind configuration
├── postcss.config.js           # PostCSS configuration
├── tsconfig.json               # TypeScript configuration
├── package.json                # Frontend dependencies
└── README.md                   # Full documentation
```

### Backend (Express.js)
```
frontend/server/
├── simple-server.js            # Main server (recommended to start)
├── server-sse.js               # Alternative SSE-based server
├── server.js                   # Process spawning server (advanced)
├── logBridge.js                # Client library for sending logs
└── package.json                # Server dependencies
```

### Documentation & Setup
```
frontend/
├── QUICKSTART.md               # 5-minute setup guide
├── README.md                   # Full documentation
├── setup.ps1                   # Windows setup script
├── setup.sh                    # Linux/Mac setup script
├── .env.example                # Environment configuration
└── .gitignore                  # Git ignore rules
```

## 🎯 How It Works

1. **Backend Server** (`simple-server.js`)
   - Listens on `http://localhost:3001`
   - Provides REST endpoint `/api/log` to receive logs
   - Maintains WebSocket/SSE connections with frontend
   - Stores last 500 logs per service

2. **Frontend Dashboard** (React)
   - Displays 3 log boxes (MainBot, Python Bridge, Scorer)
   - Connects via SSE (Server-Sent Events)
   - Auto-scrolls to latest logs
   - Shows connection status (green/red indicator)
   - Real-time updates

3. **Log Flow**
   ```
   Your Service → POST /api/log → Server stores log → SSE broadcast → Frontend displays
   ```

## 🚀 Quick Start (5 steps)

### 1. Install dependencies (Windows)
```powershell
cd frontend
.\setup.ps1
```

### 2. Start backend server
```powershell
cd frontend/server
npm start
# Output: Server running on http://localhost:3001
```

### 3. Start frontend (new PowerShell)
```powershell
cd frontend
npm run dev
# Output: ➜ Local: http://localhost:5173/
```

### 4. Open dashboard
Visit: `http://localhost:5173`

### 5. Send test logs
```powershell
curl -X POST http://localhost:3001/api/demo/mainbot
```

You should see logs appearing in real-time! 🎉

## 📡 How to Send Logs

### Option 1: Using curl (testing)
```bash
curl -X POST http://localhost:3001/api/log \
  -H "Content-Type: application/json" \
  -d '{
    "service": "mainbot",
    "message": "Trade executed successfully",
    "level": "info"
  }'
```

### Option 2: TypeScript/JavaScript
```typescript
async function sendLog(service: string, message: string) {
  await fetch('http://localhost:3001/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, message, level: 'info' })
  }).catch(() => {}); // Ignore if server is down
}

// In your mainbot code:
await sendLog('mainbot', '🚀 Service started');
```

### Option 3: Python
```python
import requests

def log_to_dashboard(service, message):
    try:
        requests.post('http://localhost:3001/api/log',
            json={'service': service, 'message': message, 'level': 'info'},
            timeout=1
        )
    except:
        pass  # Silently ignore if server is down

# Usage
log_to_dashboard('python-bridge', '🐍 Connected to MT5')
log_to_dashboard('scorer', '⚡ Model loaded')
```

## 🎨 Dashboard Features

### Real-time Streaming
- Logs appear instantly as they're sent
- Uses efficient SSE (Server-Sent Events) protocol
- Single persistent connection per service

### Three Separate Boxes
- **MainBot** 🤖 (blue border)
- **Python Bridge** 🐍 (yellow border)
- **Scorer** ⚡ (green border)

### Status Indicators
- Green dot = Connected and receiving logs
- Red dot = Disconnected or no connection

### Auto-scroll
- Automatically scrolls to show latest logs
- Disabled when you scroll up to read older logs
- Shows total log count at bottom

### Log History
- Keeps last 500 logs per service
- Prevents memory issues
- Older logs automatically discarded

## 🔌 Integration Checklist

To integrate with your services, add log calls to:

### MainBot (TypeScript)
- [ ] `src/strategy/jusdtt-m15.ts` - Trade signals
- [ ] `src/core/order-manager.ts` - Order execution
- [ ] `src/core/mt5-connector.ts` - Connection events
- [ ] `src/backtester/backtest-runner.ts` - Backtest progress

### Python Bridge
- [ ] `src/core/mt5-bridge.py` - Connection status
- [ ] `scripts/scorer_server.py` - Model predictions
- [ ] `scripts/train_model.py` - Training progress

### Scorer
- [ ] Model training status
- [ ] Prediction results
- [ ] Performance metrics

## 📊 Dashboard View

When running, you'll see:

```
┌─────────────────────────────────────────────────────────────┐
│           📊 TradeBot Logs Dashboard                        │
│     Real-time terminal output monitoring                   │
└─────────────────────────────────────────────────────────────┘

┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ 🤖 MainBot       │ │ 🐍 Python Bridge │ │ ⚡ Scorer        │
│ ● Connected      │ │ ● Connected      │ │ ● Connected      │
├──────────────────┤ ├──────────────────┤ ├──────────────────┤
│ [12:34:56] START │ │ [12:34:56] Ready │ │ [12:34:56] Init  │
│ [12:35:01] Trade │ │ [12:35:02] Data  │ │ [12:35:03] Train │
│ [12:35:05] Order │ │ [12:35:07] MT5   │ │ [12:35:10] Score │
│ ...more logs...  │ │ ...more logs...  │ │ ...more logs...  │
│                  │ │                  │ │                  │
│ 150 logs         │ │ 142 logs         │ │ 165 logs         │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

## 🌐 Access from Anywhere

Once set up, you can access the dashboard from:

1. **Same PC** - `http://localhost:5173`
2. **Other PC on network** - `http://YOUR_PC_IP:5173`
3. **Mobile phone** - `http://YOUR_PC_IP:5173` (same network)
4. **Internet** - Deploy to cloud server

### To find your PC IP:
```powershell
# Windows
ipconfig

# Linux/Mac
ifconfig
```

Then use: `http://YOUR_IP:5173`

## 🛠️ Troubleshooting

### Issue: "Cannot GET /api/logs/mainbot"
- Backend server not running
- Start it: `cd frontend/server && npm start`

### Issue: Logs not appearing
1. Check server: `curl http://localhost:3001/api/health`
2. Test demo: `curl -X POST http://localhost:3001/api/demo/mainbot`
3. Check DevTools: F12 → Network → look for SSE connections

### Issue: Port 3001 already in use
- Edit `frontend/server/simple-server.js`
- Change: `const port = 3001;` to `const port = 3002;`
- Update frontend `vite.config.ts` proxy URL

### Issue: CORS errors
- Already configured, but if issues persist:
- Check if frontend and backend URLs match
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## 📈 Next Steps

1. ✅ Run `setup.ps1` (or `setup.sh` on Linux/Mac)
2. ✅ Start backend and frontend
3. ✅ Test with demo logs
4. ✅ Integrate into your services
5. ✅ Monitor logs in real-time!
6. 🚀 Deploy to cloud for remote access

## 📚 Full Documentation

For complete details, see:
- **Setup Guide**: `frontend/QUICKSTART.md`
- **Full API Docs**: `frontend/README.md`

## 💡 Pro Tips

1. **Keep dashboard open** - Always have it running while developing
2. **Use emojis** - Makes logs easier to scan visually
3. **Include timestamps** - Server automatically adds them
4. **Use log levels** - 'info', 'warn', 'error' help filtering
5. **Send on important events** - Trades, connections, errors

Example:
```typescript
await sendLog('mainbot', '🚀 BUY signal on GBPUSD M5', 'info');
await sendLog('mainbot', '❌ Connection failed to MT5', 'error');
await sendLog('scorer', '✓ Model inference: 92% confidence', 'info');
```

Happy monitoring! 🎉
