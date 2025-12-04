// frontend/src/components/SetupVisualization.tsx
// Live visualization of what V2 bot sees

import { useEffect, useState } from 'react';

interface Setup {
  status: string;
  symbol: string;
  timeframe?: string;
  side: 'BUY' | 'SELL' | null;
  currentPrice?: number;
  sweepLevel?: number;
  sweepPips?: number;
  fvgHigh?: number;
  fvgLow?: number;
  fvgSide?: 'BULL' | 'BEAR';
  entryPrice?: number;
  sl?: number;
  tp?: number;
  slPips?: number;
  tpPips?: number;
  asianHigh?: number;
  asianLow?: number;
  asianRangePips?: number;
  trend?: 'BUY' | 'SELL' | null;
  emaShort?: number;
  emaLong?: number;
  emaSeparationPips?: number;
  sweepCandlesAgo?: number;
  maxCandlesToWait?: number;
  skipReason?: string;
  detectedAt?: string;
  updatedAt?: string;
  setupType?: 'reversal' | 'continuation' | 'trend';
  tradingMode?: 'sweep' | 'trend';
  sweepTimeRemaining?: number;
}

interface LiveSetups {
  [symbol: string]: Setup | null;
}

// Use empty string for relative URLs (works with Vite proxy)
const SERVER_URL = '';

const statusColors: Record<string, string> = {
  scanning: 'bg-blue-500/20 text-blue-300 border-blue-500',
  sweep_detected: 'bg-yellow-500/20 text-yellow-300 border-yellow-500',
  fvg_formed: 'bg-purple-500/20 text-purple-300 border-purple-500',
  waiting_entry: 'bg-orange-500/20 text-orange-300 border-orange-500',
  continuation: 'bg-cyan-500/20 text-cyan-300 border-cyan-500',
  trend_entry: 'bg-indigo-500/20 text-indigo-300 border-indigo-500',
  triggered: 'bg-green-500/20 text-green-300 border-green-500',
  expired: 'bg-gray-500/20 text-gray-300 border-gray-500',
  skipped: 'bg-red-500/20 text-red-300 border-red-500',
};

const statusLabels: Record<string, string> = {
  scanning: 'Scanning',
  sweep_detected: 'Sweep Detected',
  fvg_formed: 'FVG Formed',
  waiting_entry: 'Wait..Entry',
  continuation: 'Continuation',
  trend_entry: 'Entry',
  triggered: 'Triggered',
  expired: 'Expired',
  skipped: 'Skipped',
};

function SetupCard({ symbol, setup }: { symbol: string; setup: Setup | null }) {
  if (!setup) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700 min-h-[120px]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-white">{symbol.replace('z', '')}</h3>
          <span className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-400">No Setup</span>
        </div>
        <div className="text-gray-500 text-sm">Waiting for signal...</div>
      </div>
    );
  }

  const statusColor = statusColors[setup.status] || statusColors.scanning;
  const statusLabel = statusLabels[setup.status] || setup.status;
  const isSweepMode = setup.tradingMode === 'sweep';
  const isTrendMode = setup.tradingMode === 'trend';

  return (
    <div className={`bg-gray-800/50 rounded-lg p-2 border min-h-[120px] ${setup.side === 'BUY' ? 'border-green-600' : setup.side === 'SELL' ? 'border-red-600' : 'border-gray-700'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-white">{symbol.replace('z', '')}</h3>
          {setup.side && (
            <span className={`px-1.5 py-0.5 text-xs font-bold rounded ${setup.side === 'BUY' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
              {setup.side}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Trading Mode Badge */}
          {isSweepMode && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-amber-600/30 text-amber-300 border border-amber-600">
              SWEEP {setup.sweepTimeRemaining ? `${setup.sweepTimeRemaining}m` : ''}
            </span>
          )}
          {isTrendMode && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-violet-600/30 text-violet-300 border border-violet-600">
              TREND
            </span>
          )}
          <span className={`px-1.5 py-1 text-xs rounded border ${statusColor}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Price Levels Visualization */}
      {setup.entryPrice && setup.sl && setup.tp && (
        <div className="mb-4 relative">
          <div className="text-xs text-gray-400 mb-2">Price Levels</div>
          <div className="bg-gray-900 rounded p-3 space-y-2">
            {/* TP */}
            <div className="flex justify-between items-center">
              <span className="text-green-400 text-xs">TP</span>
              <span className="text-green-400 font-mono text-sm">{setup.tp.toFixed(5)}</span>
              {setup.tpPips && <span className="text-green-300 text-xs">+{setup.tpPips.toFixed(1)} pips</span>}
            </div>
            
            {/* Entry */}
            <div className="flex justify-between items-center border-y border-gray-700 py-2">
              <span className="text-yellow-400 text-xs">ENTRY</span>
              <span className="text-yellow-400 font-mono text-sm font-bold">{setup.entryPrice.toFixed(5)}</span>
              <span className="text-gray-400 text-xs">→</span>
            </div>
            
            {/* Current Price */}
            {setup.currentPrice && (
              <div className="flex justify-between items-center">
                <span className="text-blue-400 text-xs">NOW</span>
                <span className="text-blue-400 font-mono text-sm">{setup.currentPrice.toFixed(5)}</span>
              </div>
            )}
            
            {/* SL */}
            <div className="flex justify-between items-center">
              <span className="text-red-400 text-xs">SL</span>
              <span className="text-red-400 font-mono text-sm">{setup.sl.toFixed(5)}</span>
              {setup.slPips && <span className="text-red-300 text-xs">-{setup.slPips.toFixed(1)} pips</span>}
            </div>
          </div>
        </div>
      )}

      {/* FVG Zone */}
      {setup.fvgHigh && setup.fvgLow && (
        <div className="mb-3">
          <div className="text-xs text-gray-400 mb-1">FVG Zone ({setup.fvgSide})</div>
          <div className="bg-purple-900/30 rounded px-3 py-2 border border-purple-700">
            <div className="flex justify-between text-sm">
              <span className="text-purple-300">High: {setup.fvgHigh.toFixed(5)}</span>
              <span className="text-purple-300">Low: {setup.fvgLow.toFixed(5)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Sweep Info */}
      {setup.sweepLevel && (
        <div className="mb-3">
          <div className="text-xs text-gray-400 mb-1">Sweep</div>
          <div className="flex justify-between text-sm">
            <span className="text-orange-300">Level: {setup.sweepLevel.toFixed(5)}</span>
            {setup.sweepPips && <span className="text-orange-300">{setup.sweepPips.toFixed(1)} pips</span>}
          </div>
          {setup.sweepCandlesAgo !== undefined && (
            <div className="text-xs text-gray-500 mt-1">
              {setup.sweepCandlesAgo} candles ago (max: {setup.maxCandlesToWait})
            </div>
          )}
        </div>
      )}

      {/* Asian Range (XAU) */}
      {setup.asianHigh && setup.asianLow && (
        <div className="mb-3">
          <div className="text-xs text-gray-400 mb-1">Asian Range</div>
          <div className="bg-cyan-900/30 rounded px-3 py-2 border border-cyan-700">
            <div className="flex justify-between text-sm">
              <span className="text-cyan-300">High: {setup.asianHigh.toFixed(2)}</span>
              <span className="text-cyan-300">Low: {setup.asianLow.toFixed(2)}</span>
            </div>
            {setup.asianRangePips && (
              <div className="text-xs text-cyan-400 mt-1">Range: {setup.asianRangePips.toFixed(1)} pips</div>
            )}
          </div>
        </div>
      )}

      {/* Trend Info */}
      {setup.trend && (
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <span>Trend:</span>
          <span className={setup.trend === 'BUY' ? 'text-green-400' : 'text-red-400'}>
            {setup.trend} {setup.emaSeparationPips && `(${setup.emaSeparationPips.toFixed(1)} pips sep)`}
          </span>
        </div>
      )}

      {/* Skip Reason */}
      {setup.skipReason && (
        <div className="text-xs text-red-400 mt-2">
          Skip: {setup.skipReason}
        </div>
      )}

      {/* Timestamp */}
      {setup.updatedAt && (
        <div className="text-xs text-gray-600 mt-3">
          Updated: {new Date(setup.updatedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// All symbols the bot tracks
const ALL_SYMBOLS = ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz'];

export default function SetupVisualization() {
  const [setups, setSetups] = useState<LiveSetups>(() => {
    // Initialize with all symbols
    const initial: LiveSetups = {};
    ALL_SYMBOLS.forEach(s => initial[s] = null);
    return initial;
  });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isMounted = true;

    const connect = () => {
      if (!isMounted) return;
      
      console.log('SetupVisualization: Attempting to connect to /api/setups/live');
      eventSource = new EventSource('/api/setups/live');

      eventSource.onopen = () => {
        console.log('SetupVisualization: Connection opened');
        if (isMounted) {
          setConnected(true);
          setError(null);
        }
      };

      eventSource.onmessage = (event) => {
        console.log('SetupVisualization: Received message', event.data);
        if (isMounted) {
          setConnected(true);
          try {
            const data = JSON.parse(event.data);
            if (data.setups) {
              // Merge incoming setups with existing state, keeping all symbols
              setSetups(prev => {
                const merged: LiveSetups = {};
                ALL_SYMBOLS.forEach(symbol => {
                  merged[symbol] = data.setups[symbol] ?? prev[symbol] ?? null;
                });
                return merged;
              });
            }
          } catch (e) {
            console.error('Failed to parse setup data:', e);
          }
        }
      };

      eventSource.onerror = (e) => {
        console.error('SetupVisualization: Connection error', e);
        if (isMounted) {
          setConnected(false);
          setError('Connection failed');
          
          // Close and reconnect after delay
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          
          reconnectTimeout = setTimeout(() => {
            console.log('SetupVisualization: Attempting reconnect...');
            connect();
          }, 3000);
        }
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800 px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold bg-purple-700 px-2 py-1 rounded text-white">LIVE</span>
          <h2 className="text-lg font-semibold text-white">Live Setups</h2>
        </div>
        <div className={`flex items-center gap-2 text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}></span>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {/* Setup Cards */}
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 auto-rows-fr">
        {Object.entries(setups).map(([symbol, setup]) => (
          <SetupCard key={symbol} symbol={symbol} setup={setup} />
        ))}
      </div>
    </div>
  );
}
