import { useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import SetupVisualization from './components/SetupVisualization';
import TradeJournal from './components/TradeJournal';
import ControlPanel from './components/ControlPanel';
import { ToastProvider, useToast, ToastType } from './components/Toast';

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  data?: Record<string, any> | null;
  raw?: string;
}

const parseLog = (eventData: string): LogEntry => {
  // eventData can be:
  // 1) a JSON string of an object: '{"timestamp":"...","message":"...","data":{}}'
  // 2) a JSON string of a string (double-encoded): '"[time] MSG\n{...}"'
  // 3) a plain string: '[time] MSG\n{...}' (older behavior)

  try {
    const parsed = JSON.parse(eventData);

    // If parsing produced an object, return it (structured log)
    if (parsed && typeof parsed === 'object') return parsed as LogEntry;

    // If parsed is a string, we need to parse its content
    if (typeof parsed === 'string') {
      const raw = parsed;
      // If the string looks like JSON again, try to parse it
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed);
        } catch (_e) {
          // fallthrough to textual parsing
        }
      }

      // Textual parsing: split into first line and optional JSON body
      const lines = raw.split('\n');
      const first = lines[0] || raw;
      const m = first.match(/^\[(.*?)\]\s*(\w+):?\s*(.*)$/);
      const timestamp = m ? m[1] : undefined;
      const level = m && m[2] ? m[2].toUpperCase() : undefined;
      const message = m ? m[3] : first;
      let data = null;
      if (lines.length > 1) {
        try { data = JSON.parse(lines.slice(1).join('\n')); } catch { data = lines.slice(1).join('\n'); }
      }
      return { timestamp, level, message, data };
    }

    return { raw: String(parsed) };
  } catch (e) {
    // eventData was not JSON; parse as plain text (old behavior)
    const raw = eventData;
    const lines = raw.split('\n');
    const first = lines[0] || raw;
    const m = first.match(/^\[(.*?)\]\s*(\w+):?\s*(.*)$/);
    const timestamp = m ? m[1] : undefined;
    const level = m && m[2] ? m[2].toUpperCase() : undefined;
    const message = m ? m[3] : first;
    let data = null;
    if (lines.length > 1) {
      try { data = JSON.parse(lines.slice(1).join('\n')); } catch { data = lines.slice(1).join('\n'); }
    }
    return { timestamp, level, message, data };
  }
};

const LogEntry = ({ entry }: { entry: LogEntry }) => {
  const isDecision = entry.level === 'DECISION';
  const isError = entry.level === 'ERROR';
  const isWarn = entry.level === 'WARN';
  
  // Terminal-style colors
  const levelBadgeColor = isDecision ? 'bg-purple-600/20 text-purple-300 border-purple-500/30' 
    : isError ? 'bg-red-600/20 text-red-300 border-red-500/30' 
    : isWarn ? 'bg-yellow-600/20 text-yellow-300 border-yellow-500/30' 
    : 'bg-blue-600/20 text-blue-300 border-blue-500/30';
  
  const renderJsonValue = (value: any, indent = 0): ReactNode => {
    const indentStr = '  '.repeat(indent);
    
    if (value === null || value === undefined) {
      return <span className="text-gray-500">null</span>;
    }
    
    if (Array.isArray(value)) {
      if (value.length === 0) return <span className="text-cyan-300">[]</span>;
      return (
        <>
          <span className="text-cyan-300">[</span>
          {value.map((item, idx) => (
            <div key={idx} style={{ paddingLeft: `${(indent + 1) * 16}px` }}>
              <span className="text-cyan-300">{'{'}</span>
              {typeof item === 'object' && item !== null && (
                <>
                  {Object.entries(item).map(([k, v], i) => (
                    <div key={k} style={{ paddingLeft: `${(indent + 2) * 16}px` }}>
                      <span className="text-green-300">"{k}"</span>
                      <span className="text-cyan-300">: </span>
                      {typeof v === 'string' ? (
                        <span className="text-green-300">"{v}"</span>
                      ) : typeof v === 'number' ? (
                        <span className="text-yellow-300">{v}</span>
                      ) : (
                        renderJsonValue(v, indent + 2)
                      )}
                      {i < Object.entries(item).length - 1 && <span className="text-cyan-300">,</span>}
                    </div>
                  ))}
                </>
              )}
              <div style={{ paddingLeft: `${(indent + 1) * 16}px` }}>
                <span className="text-cyan-300">{'}'}</span>
                {idx < value.length - 1 && <span className="text-cyan-300">,</span>}
              </div>
            </div>
          ))}
          <div style={{ paddingLeft: `${indent * 16}px` }}>
            <span className="text-cyan-300">]</span>
          </div>
        </>
      );
    }
    
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return <span className="text-cyan-300">{'{}'}</span>;
      return (
        <>
          <span className="text-cyan-300">{'{'}</span>
          {entries.map(([key, val], idx) => (
            <div key={key} style={{ paddingLeft: `${(indent + 1) * 16}px` }}>
              <span className="text-green-300">"{key}"</span>
              <span className="text-cyan-300">: </span>
              {typeof val === 'string' ? (
                <span className="text-green-300">"{val}"</span>
              ) : typeof val === 'number' ? (
                <span className="text-yellow-300">{val}</span>
              ) : typeof val === 'boolean' ? (
                <span className="text-pink-300">{String(val)}</span>
              ) : (
                renderJsonValue(val, indent + 1)
              )}
              {idx < entries.length - 1 && <span className="text-cyan-300">,</span>}
            </div>
          ))}
          <div style={{ paddingLeft: `${indent * 16}px` }}>
            <span className="text-cyan-300">{'}'}</span>
          </div>
        </>
      );
    }
    
    if (typeof value === 'string') {
      return <span className="text-green-300">"{value}"</span>;
    }
    
    if (typeof value === 'number') {
      return <span className="text-yellow-300">{value}</span>;
    }
    
    if (typeof value === 'boolean') {
      return <span className="text-pink-300">{String(value)}</span>;
    }
    
    return <span className="text-gray-300">{String(value)}</span>;
  };
  
  return (
    <div className="mb-3 font-mono text-xs text-left bg-gray-800/40 rounded p-3 border border-gray-700/40 overflow-x-auto max-w-full">
      {/* Decision header (terminal-like) */}
      {isDecision && (
        <div className="mb-2">
          <div className="text-gray-600">{String('═').repeat(60)}</div>
          <div className="text-purple-400 font-bold uppercase text-sm mt-1 mb-1">MODEL DECISION</div>
          <div className="text-gray-600">{String('─').repeat(60)}</div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-gray-600">[{entry.timestamp}]</span>
        <span className={`px-2 py-0.5 rounded border font-semibold text-xs ${levelBadgeColor}`}>
          {entry.level}
        </span>
        <span className="text-gray-300">{entry.message}</span>
      </div>
      
      {/* JSON Data */}
      {entry.data && Object.keys(entry.data).length > 0 && (
        <div className="mt-2 pl-4 border-l border-gray-700/50 text-gray-400 overflow-x-auto break-all max-w-full">
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(entry.data, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

// Helper to detect trade events from log entries
const detectTradeEvent = (entry: LogEntry): { type: ToastType; title: string; message: string; symbol?: string; pips?: number } | null => {
  const level = entry.level?.toUpperCase();
  const message = entry.message || '';
  const data = entry.data || {};
  
  // TRADE log - trade opened or closed
  if (level === 'TRADE') {
    // Check if it's a market order opened
    if (message.includes('MARKET order opened') || message.includes('opened')) {
      const symbol = data.symbol || message.split(' ')[0] || 'Unknown';
      const side = message.includes('BUY') ? 'BUY' : message.includes('SELL') ? 'SELL' : '';
      return {
        type: 'trade_open',
        title: `${symbol} ${side} Trade Opened`,
        message: `Entry: ${data.entry || data.price || 'N/A'}`,
        symbol,
      };
    }
    
    // Trade closed with profit/loss
    if (message.includes('closed') || message.includes('TP hit') || message.includes('SL hit')) {
      const symbol = data.symbol || message.split(' ')[0] || 'Unknown';
      const pips = data.pips || data.profit_pips;
      const isWin = pips > 0 || message.includes('TP hit') || message.includes('profit');
      return {
        type: isWin ? 'trade_win' : 'trade_loss',
        title: `${symbol} Trade ${isWin ? 'Won' : 'Lost'}`,
        message: isWin ? `Take Profit hit! 🎉` : `Stop Loss hit`,
        symbol,
        pips: typeof pips === 'number' ? pips : undefined,
      };
    }
  }
  
  // Pending order placed
  if (level === 'ORDER' || message.includes('pending') || message.includes('limit')) {
    if (message.includes('placed') || message.includes('Pending')) {
      const symbol = data.symbol || message.split(' ')[0] || 'Unknown';
      const side = message.includes('BUY') ? 'BUY' : message.includes('SELL') ? 'SELL' : '';
      const price = data.entry || data.price || 'N/A';
      return {
        type: 'order_placed',
        title: `${symbol} ${side} Limit Placed`,
        message: `Entry: ${price}`,
        symbol,
      };
    }
  }
  
  // Entry executed from pending
  if (message.includes('Entry executed') || message.includes('limit triggered')) {
    const symbol = data.symbol || message.split(' ')[0] || 'Unknown';
    return {
      type: 'trade_open',
      title: `${symbol} Limit Triggered`,
      message: `Pending order filled`,
      symbol,
    };
  }
  
  return null;
};

interface LogBoxProps {
  title: string;
  color: string;
  fullWidth?: boolean;
  onTradeEvent?: (event: { type: ToastType; title: string; message: string; symbol?: string; pips?: number }) => void;
}

const LogBox = ({ title, color, fullWidth = false, onTradeEvent }: LogBoxProps) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const maxLogs = 500;
  const boxHeight = isFullscreen ? 'fixed inset-4 z-50 h-auto' : fullWidth ? 'h-[500px]' : 'h-[400px]';
  
  // Map title to service name for API calls
  const serviceName = title.toLowerCase().replace(/\s+/g, '-');

  useEffect(() => {
    const eventSource = new EventSource(`/api/logs/${serviceName}`);

    eventSource.onopen = () => {
      setIsConnected(true);
      setLogs([]);
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = parseLog(event.data);
        console.log('Parsed log:', parsed);
        
        // Check for trade events and trigger toast
        if (onTradeEvent && serviceName === 'mainbot') {
          const tradeEvent = detectTradeEvent(parsed);
          if (tradeEvent) {
            onTradeEvent(tradeEvent);
          }
        }
        
        setLogs((prevLogs) => {
          const updated = [...prevLogs, parsed];
          return updated.length > maxLogs ? updated.slice(-maxLogs) : updated;
        });
      } catch (e) {
        console.error('Parse error:', e);
        // Fallback
        setLogs((prevLogs) => {
          const updated = [...prevLogs, { raw: event.data }];
          return updated.length > maxLogs ? updated.slice(-maxLogs) : updated;
        });
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      eventSource.close();
    };

    return () => eventSource.close();
  }, [serviceName, onTradeEvent]);

  // Smart auto-scroll: only scroll if user is already at the bottom
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);  // Track if auto-scroll is active
  
  // Update isAutoScroll when user scrolls
  const handleScroll = () => {
    if (logContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
      // Consider "at bottom" if within 50px of bottom
      const atBottom = scrollHeight - scrollTop - clientHeight < 50;
      setIsAutoScroll(atBottom);
    }
  };
  
  // Scroll to bottom (for manual resume)
  const scrollToBottom = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setIsAutoScroll(true);
    }
  };
  
  useEffect(() => {
    // Only auto-scroll if user was already at the bottom
    if (logContainerRef.current && isAutoScroll) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, isAutoScroll]);

  // Service control functions
  const handleStart = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/service/${serviceName}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) console.error('Start failed:', data.error);
    } catch (e) {
      console.error('Start error:', e);
    }
    setIsLoading(false);
  };

  const handleStop = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/service/${serviceName}/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) console.error('Stop failed:', data.error);
    } catch (e) {
      console.error('Stop error:', e);
    }
    setIsLoading(false);
  };

  const handleRestart = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/service/${serviceName}/restart`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) console.error('Restart failed:', data.error);
    } catch (e) {
      console.error('Restart error:', e);
    }
    setIsLoading(false);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  // Handle escape key to exit fullscreen
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isFullscreen]);

  const statusColor = isConnected ? 'bg-emerald-500' : 'bg-red-500';

  return (
    <>
      {/* Fullscreen backdrop - more transparent/reflective */}
      {isFullscreen && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" 
          onClick={() => setIsFullscreen(false)}
        />
      )}
      <div className={`flex flex-col bg-gray-900/60 backdrop-blur-sm rounded-lg border border-gray-700/50 overflow-hidden ${boxHeight}`}>
      {/* Header */}
      <div className="bg-gray-800/50 px-4 py-2 border-b border-gray-700/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
          <div className={`w-2 h-2 rounded-full ${statusColor}`}></div>
        </div>
        
        {/* Control Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleStart}
            disabled={isLoading}
            className="px-2 py-1 text-xs bg-emerald-600/80 hover:bg-emerald-600 disabled:bg-gray-700 text-white rounded transition-colors"
            title="Start"
          >
            Start
          </button>
          <button
            onClick={handleStop}
            disabled={isLoading}
            className="px-2 py-1 text-xs bg-red-600/80 hover:bg-red-600 disabled:bg-gray-700 text-white rounded transition-colors"
            title="Stop"
          >
            Stop
          </button>
          <button
            onClick={handleRestart}
            disabled={isLoading}
            className="px-2 py-1 text-xs bg-amber-600/80 hover:bg-amber-600 disabled:bg-gray-700 text-white rounded transition-colors"
            title="Restart"
          >
            Restart
          </button>
          <button
            onClick={handleClearLogs}
            className="px-2 py-1 text-xs bg-gray-700/80 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            title="Clear Logs"
          >
            Clear
          </button>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              isFullscreen 
                ? 'bg-blue-600/80 hover:bg-blue-600 text-white' 
                : 'bg-gray-700/80 hover:bg-gray-600 text-gray-300'
            }`}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? '⊟' : '⊞'}
          </button>
        </div>
      </div>

      {/* Log Container */}
      <div ref={logContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 bg-black/40">
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center py-8">
            {isConnected ? 'Waiting for logs...' : 'Connecting...'}
          </div>
        ) : (
          logs.map((log, idx) => {
            // If we have a raw string, try to parse it to structured before rendering.
            if (log.raw) {
              try {
                const parsed = parseLog(log.raw);
                if (!parsed.raw && (parsed.message || parsed.data)) {
                  return <LogEntry key={idx} entry={parsed} />;
                }
              } catch (_e) {
                // ignore and fallthrough to raw string rendering
              }

              return (
                <div
                  key={idx}
                  className="text-gray-400 text-xs mb-2 p-2 bg-gray-800/50 rounded whitespace-pre-wrap break-words"
                >
                  {log.raw}
                </div>
              );
            }

            return <LogEntry key={idx} entry={log} />;
          })
        )}
      </div>

      {/* Footer */}
      <div className="bg-gray-800/50 px-4 py-2 border-t border-gray-700/50 text-xs text-gray-500 flex items-center justify-between">
        <span>{logs.length} logs</span>
        {isAutoScroll ? (
          <span className="text-emerald-500">● Auto-scroll</span>
        ) : (
          <button 
            onClick={scrollToBottom}
            className="text-amber-400 hover:text-amber-300 flex items-center gap-1"
          >
            ● Paused - Click to resume ↓
          </button>
        )}
      </div>
    </div>
    </>
  );
};

// Dashboard component that uses toast
function Dashboard() {
  const [showJournal, setShowJournal] = useState(false);
  const [showControl, setShowControl] = useState(true);
  const { addToast } = useToast();

  // Handle trade events from log stream
  const handleTradeEvent = useCallback((event: { type: ToastType; title: string; message: string; symbol?: string; pips?: number }) => {
    addToast(event);
  }, [addToast]);

  return (
    <div className="min-h-screen bg-black p-6">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">
              TradeBot Dashboard
            </h1>
            <p className="text-gray-500 text-sm mt-1">Real-time monitoring | Live setups | Trade journal</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowControl(!showControl)}
              className={`px-4 py-2 rounded-lg font-medium transition-all border ${
                showControl
                  ? 'bg-gray-800/50 text-white border-gray-600'
                  : 'bg-transparent text-gray-500 border-gray-700 hover:bg-gray-800/30 hover:text-gray-300'
              }`}
            >
              {showControl ? 'Hide Control' : 'Control Panel'}
            </button>
            <button
              onClick={() => setShowJournal(!showJournal)}
              className={`px-4 py-2 rounded-lg font-medium transition-all border ${
                showJournal
                  ? 'bg-gray-800/50 text-white border-gray-600'
                  : 'bg-transparent text-gray-500 border-gray-700 hover:bg-gray-800/30 hover:text-gray-300'
              }`}
            >
              {showJournal ? 'Hide Journal' : 'Trade Journal'}
            </button>
          </div>
        </div>
      </div>

      {/* Control Panel (toggleable) */}
      {showControl && (
        <div className="max-w-7xl mx-auto mb-6">
          <ControlPanel />
        </div>
      )}

      {/* Trade Journal (toggleable) */}
      {showJournal && (
        <div className="max-w-7xl mx-auto mb-6">
          <TradeJournal />
        </div>
      )}

      {/* Live Setup Visualization - Always visible on top */}
      <div className="max-w-7xl mx-auto mb-6">
        <SetupVisualization />
      </div>

      {/* MainBot Log - Full width on top */}
      <div className="max-w-7xl mx-auto mb-4">
        <LogBox
          title="MainBot"
          color="border-blue-500"
          fullWidth={true}
          onTradeEvent={handleTradeEvent}
        />
      </div>

      {/* Bridge and Scorer Logs - Side by side below */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LogBox
          title="Python Bridge"
          color="border-yellow-500"
        />
        <LogBox
          title="Scorer"
          color="border-green-500"
        />
      </div>

      {/* Footer */}
      <div className="max-w-7xl mx-auto mt-6 text-center text-gray-600 text-sm">
        <p>SweepFVG Strategy | London + NY Sessions | MongoDB Trade Storage</p>
      </div>
    </div>
  );
}

// Main App with Toast Provider
export default function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
