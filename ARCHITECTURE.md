# Architecture & Flow Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Your Services (Running in Terminals)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  MainBot     │  │  Python      │  │  Scorer      │          │
│  │  (npm run    │  │  Bridge      │  │  (Python     │          │
│  │   dev)       │  │  (python)    │  │   script)    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                  │
│         │   HTTP POST: /api/log             │                  │
│         │                                   │                  │
└─────────┼───────────────────────────────────┼──────────────────┘
          │                                   │
          └─────────────────────┬─────────────┘
                                │
          ┌─────────────────────▼─────────────────────┐
          │                                           │
          │  🌐 Express.js Backend Server             │
          │  (http://localhost:3001)                  │
          │                                           │
          │  ┌─────────────────────────────────────┐  │
          │  │ /api/log endpoint                   │  │
          │  │ - Receives POST requests            │  │
          │  │ - Stores in memory (500 max/svc)    │  │
          │  │ - Broadcasts to connected clients   │  │
          │  └─────────────────────────────────────┘  │
          │                                           │
          │  ┌─────────────────────────────────────┐  │
          │  │ /api/logs/:service SSE endpoint     │  │
          │  │ - Server-Sent Events stream         │  │
          │  │ - Persistent connection             │  │
          │  │ - Real-time log delivery            │  │
          │  └─────────────────────────────────────┘  │
          │                                           │
          └─────────────────────┬─────────────────────┘
                                │
                    SSE Stream (EventSource)
                                │
          ┌─────────────────────▼─────────────────────┐
          │                                           │
          │  🎨 React Dashboard (Frontend)            │
          │  (http://localhost:5173)                  │
          │                                           │
          │  ┌──────────┬──────────┬──────────┐      │
          │  │MainBot   │Python    │Scorer    │      │
          │  │🤖 Blue   │🐍 Yellow │⚡ Green  │      │
          │  │          │          │          │      │
          │  │150 logs  │142 logs  │165 logs  │      │
          │  └──────────┴──────────┴──────────┘      │
          │                                           │
          │  Real-time display of all logs           │
          │                                           │
          └───────────────────────────────────────────┘
                          ▲
                          │
                    Browser/Phone
```

## Data Flow Sequence

```
1. Your Service sends log
   ┌──────────────┐
   │ MainBot code │
   │ sends POST   │
   └──────┬───────┘
          │
          ▼
   ┌──────────────────────────────────────────┐
   │ POST /api/log                            │
   │ {                                        │
   │   "service": "mainbot",                  │
   │   "message": "Trade executed",           │
   │   "level": "info"                        │
   │ }                                        │
   └──────┬───────────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────────┐
   │ Express Server                           │
   │ 1. Receives POST                         │
   │ 2. Stores log in memory                  │
   │ 3. Finds all connected SSE clients       │
   │ 4. Sends to each SSE connection          │
   └──────┬───────────────────────────────────┘
          │
          ├─────────────────────────────────────┐
          │                                     │
          ▼                                     ▼
   ┌──────────────────┐          ┌──────────────────┐
   │ Browser Client 1 │          │ Browser Client 2 │
   │ (User on PC)     │          │ (User on Phone)  │
   │                  │          │                  │
   │ Receives SSE     │          │ Receives SSE     │
   │ event with log   │          │ event with log   │
   │                  │          │                  │
   │ Updates DOM      │          │ Updates DOM      │
   │ Shows new log    │          │ Shows new log    │
   │ Auto-scrolls     │          │ Auto-scrolls     │
   └──────────────────┘          └──────────────────┘
```

## Multi-Client Scenario

When multiple browsers connect to the same dashboard:

```
Service A ─┐
           ├─► Express Server ─┬─► Browser 1 (User at desk)
Service B ─┤                   ├─► Browser 2 (User on phone)
Service C ─┤                   └─► Browser 3 (User on laptop)
           └─► All logs broadcast to ALL connected clients
               simultaneously
```

## Installation Flow

```
┌─────────────────────────────────────────┐
│ Run setup script                        │
│ (setup.ps1 or setup.sh)                 │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Install frontend dependencies           │
│ npm install                             │
│ (React, TypeScript, Vite, Tailwind)     │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Install server dependencies             │
│ cd server && npm install                │
│ (Express, CORS)                         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ ✅ Installation Complete                │
│                                         │
│ Ready to start:                         │
│ - Backend: npm start (server folder)    │
│ - Frontend: npm run dev (root folder)   │
└─────────────────────────────────────────┘
```

## Connection Status Indicators

```
Connected State (Green dot ●):
┌─────────────────────────────────┐
│ 🤖 MainBot              ● Green  │
├─────────────────────────────────┤
│ Browser connected to SSE stream │
│ Receiving logs in real-time     │
│ Service responding              │
└─────────────────────────────────┘

Disconnected State (Red dot ●):
┌─────────────────────────────────┐
│ 🐍 Python Bridge        ● Red    │
├─────────────────────────────────┤
│ No SSE connection                │
│ OR service not sending logs      │
│ Need to send logs to reconnect  │
└─────────────────────────────────┘
```

## Log Message Lifecycle

```
Time 1: Service creates log
        │
        ▼
        "Trade executed successfully"

Time 2: Service sends POST to server
        │
        ▼
        {
          "service": "mainbot",
          "message": "Trade executed successfully",
          "level": "info"
        }

Time 3: Server receives and timestamps
        │
        ▼
        [12:34:56] INFO: Trade executed successfully

Time 4: Server stores in memory (up to 500 per service)
        │
        ▼
        clients.mainbot.logs = [
          "[12:34:55] INFO: Previous log",
          "[12:34:56] INFO: Trade executed successfully"
        ]

Time 5: Server broadcasts to all SSE clients
        │
        ▼
        data: "[12:34:56] INFO: Trade executed successfully"\n\n

Time 6: Frontend receives SSE event
        │
        ▼
        Update React state with new log

Time 7: DOM updates with new log
        │
        ▼
        User sees log in dashboard

Time 8: Auto-scroll if user at bottom
        │
        ▼
        Dashboard scrolls to show latest log
```

## Performance Characteristics

```
Memory Usage:
┌──────────────────────────────────┐
│ Max 500 logs/service             │
│ ~4KB per log                     │
│ Total: ~2MB per service          │
│ All 3 services: ~6MB             │
└──────────────────────────────────┘

Network Usage:
┌──────────────────────────────────┐
│ Per log: ~100-500 bytes          │
│ 100 logs/sec = 10-50 KB/sec      │
│ Typical: 1-10 logs/sec           │
│ Very efficient!                  │
└──────────────────────────────────┘

Latency:
┌──────────────────────────────────┐
│ Server processing: <1ms          │
│ Network latency: 1-50ms          │
│ Frontend rendering: <10ms        │
│ Total: <100ms typical            │
│ Real-time ✓                      │
└──────────────────────────────────┘
```

## File Structure

```
frontend/
├── src/
│   ├── App.tsx              ← Main component (3 log boxes)
│   ├── main.tsx             ← Entry point
│   └── index.css            ← Tailwind styles
│
├── server/
│   ├── simple-server.js     ← Main server (use this!)
│   ├── server-sse.js        ← Alternative SSE server
│   ├── server.js            ← Process spawning server
│   ├── logBridge.js         ← Client library
│   └── package.json         ← Server dependencies
│
├── index.html               ← HTML template
├── vite.config.ts           ← Vite build config
├── tailwind.config.js       ← Tailwind CSS config
├── tsconfig.json            ← TypeScript config
├── postcss.config.js        ← PostCSS config
├── package.json             ← Frontend dependencies
│
└── Documentation:
    ├── README.md            ← Full documentation
    ├── QUICKSTART.md        ← 5-minute guide
    ├── SETUP_SUMMARY.md     ← This setup guide
    ├── setup.ps1            ← Windows setup script
    └── setup.sh             ← Linux/Mac setup script
```

## Tech Stack

```
Frontend:
├── React 18.2         - UI library
├── TypeScript 5.3     - Type safety
├── Vite 5.0          - Build tool
├── Tailwind CSS 3.3  - Styling
└── Node-Fetch        - HTTP requests

Backend:
├── Express.js 4.18   - Server framework
├── CORS 2.8         - Cross-origin support
└── Node.js 16+      - Runtime

Deployment:
├── Docker (optional)  - Containerization
├── PM2 (optional)    - Process manager
└── Nginx (optional)  - Reverse proxy
```

## Scaling Considerations

For high-volume logging:

```
Current (500 logs/service):
├── Memory: ~2MB per service
├── CPU: Minimal
└── Network: Very efficient

For 10,000 logs/service:
├── Memory: ~40MB per service
├── Consider: Circular buffer
└── Or: Database storage (MongoDB, SQLite)

For 100,000 logs/service:
├── Use: Time-based rotation
├── Archive: Old logs to file
└── Option: Elasticsearch for search
```

This dashboard is designed to scale from development to production!
