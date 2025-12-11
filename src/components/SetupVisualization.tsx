// frontend/src/components/SetupVisualization.tsx
// Live visualization of what V2 bot sees

import React, { useEffect, useState, useRef } from 'react';

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
  // Pending order info
  pendingOrderTicket?: number;
  pendingOrderType?: string;
  pendingOrderPlacedAt?: string;
}

interface OpenTrade {
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice?: number;
  unrealizedPips?: number;
  sl: number;
  tp: number;
  status: string;
}

interface LiveSetups {
  [symbol: string]: Setup | null;
}

// Use empty string for relative URLs (works with Vite proxy)
const SERVER_URL = '';

const statusColors: Record<string, string> = {
  scanning: 'bg-gray-700/30 text-gray-400 border-gray-600/50',
  sweep_detected: 'bg-amber-900/20 text-amber-400/80 border-amber-700/40',
  fvg_formed: 'bg-purple-900/20 text-purple-400/80 border-purple-700/40',
  waiting_entry: 'bg-orange-900/20 text-orange-400/80 border-orange-700/40',
  ready: 'bg-orange-900/20 text-orange-400/80 border-orange-700/40',
  continuation: 'bg-cyan-900/20 text-cyan-400/80 border-cyan-700/40',
  trend_entry: 'bg-indigo-900/20 text-indigo-400/80 border-indigo-700/40',
  pattern_entry: 'bg-pink-900/20 text-pink-400/80 border-pink-700/40',
  pending_order: 'bg-lime-900/20 text-lime-400/80 border-lime-700/40',
  triggered: 'bg-emerald-900/20 text-emerald-400/80 border-emerald-700/40',
  expired: 'bg-gray-800/30 text-gray-500 border-gray-700/40',
  skipped: 'bg-red-900/20 text-red-400/70 border-red-800/40',
  invalidated: 'bg-red-900/20 text-red-400/70 border-red-800/40',
};

const statusLabels: Record<string, string> = {
  scanning: 'Scanning',
  sweep_detected: 'Sweep',
  fvg_formed: 'FVG',
  waiting_entry: 'Entry',
  ready: 'Entry',
  continuation: 'Cont.',
  trend_entry: 'Trend',
  pattern_entry: 'Pattern',
  pending_order: 'Pending',
  triggered: 'Live',
  expired: 'Expired',
  skipped: 'Skip',
  invalidated: 'Invalid',
};

function SetupCard({ symbol, setup, openTrade, isDisabled }: { symbol: string; setup: Setup | null; openTrade?: OpenTrade | null; isDisabled?: boolean }) {
  // If symbol is disabled, show disabled overlay
  if (isDisabled) {
    return (
      <div className="bg-gray-800/20 rounded-lg p-4 border border-gray-700/30 min-h-[120px] relative overflow-hidden">
        {/* Disabled overlay */}
        <div className="absolute inset-0 bg-gray-900/80 flex flex-col items-center justify-center z-10">
          <div className="text-gray-500 font-semibold text-sm">DISABLED</div>
          <div className="text-gray-600 text-xs mt-1">Until January 2025</div>
        </div>
        {/* Background card */}
        <div className="opacity-20">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-gray-400">{symbol.replace('z', '')}</h3>
            <span className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-500">Paused</span>
          </div>
          <div className="text-gray-700 text-sm">Trading paused for December</div>
        </div>
      </div>
    );
  }
  
  // If there's an open trade (must have ticket to be valid), show that instead
  if (openTrade && openTrade.ticket) {
    const pnlColor = (openTrade.unrealizedPips || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
    return (
      <div className={`bg-gray-800/30 rounded-lg p-2 border min-h-[120px] border-gray-600/40`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-gray-200">{symbol.replace('z', '')}</h3>
            <span className={`px-1.5 py-0.5 text-xs font-bold rounded ${openTrade.side === 'BUY' ? 'bg-gray-600/50 text-gray-300' : 'bg-gray-600/50 text-gray-300'}`}>
              {openTrade.side}
            </span>
          </div>
          <span className="px-2 py-1 text-xs rounded bg-gray-700/50 text-gray-400 border border-gray-600/50">
            ● LIVE
          </span>
        </div>
        
        {/* Live P/L */}
        <div className="bg-black/20 rounded p-3 mb-2">
          <div className="flex justify-between items-center mb-2">
            <span className="text-gray-600 text-sm">Unrealized P/L</span>
            <span className={`text-xl font-bold ${pnlColor}`}>
              {(openTrade.unrealizedPips || 0) >= 0 ? '+' : ''}{(openTrade.unrealizedPips || 0).toFixed(1)} pips
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-600">Entry:</span>
              <span className="text-gray-400 ml-1">{openTrade.entryPrice?.toFixed(5)}</span>
            </div>
            <div>
              <span className="text-gray-600">Current:</span>
              <span className="text-gray-400 ml-1">{openTrade.currentPrice?.toFixed(5)}</span>
            </div>
            <div>
              <span className="text-gray-600">SL:</span>
              <span className="text-gray-500 ml-1">{openTrade.sl?.toFixed(5)}</span>
            </div>
            <div>
              <span className="text-gray-600">TP:</span>
              <span className="text-gray-500 ml-1">{openTrade.tp?.toFixed(5)}</span>
            </div>
          </div>
        </div>
        
        {/* Ticket */}
        <div className="text-xs text-gray-600">
          Ticket: #{openTrade.ticket}
        </div>
      </div>
    );
  }
  
  if (!setup) {
    return (
      <div className="bg-gray-800/30 rounded-lg p-4 border border-gray-700/30 min-h-[120px]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-gray-300">{symbol.replace('z', '')}</h3>
          <span className="px-2 py-1 text-xs rounded bg-gray-800/50 text-gray-500 border border-gray-700/50">No Setup</span>
        </div>
        <div className="text-gray-600 text-sm">Waiting for signal...</div>
      </div>
    );
  }

  const statusColor = statusColors[setup.status] || statusColors.scanning;
  const statusLabel = statusLabels[setup.status] || setup.status;
  const isSweepMode = setup.tradingMode === 'sweep';
  const isTrendMode = setup.tradingMode === 'trend';

  return (
    <div className={`bg-gray-800/30 rounded-lg p-2 border backdrop-blur-md min-h-[120px] border-gray-600/40`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-gray-200">{symbol.replace('z', '')}</h3>
          {setup.side && (
            <span className={`px-1.5 py-0.5 text-xs font-bold rounded bg-gray-600/50 text-gray-300`}>
              {setup.side}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Trading Mode Badge */}
          {isSweepMode && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-black-700/30 text-yellow-400 border border-gray-600/40">
              SWEEP {setup.sweepTimeRemaining ? `${setup.sweepTimeRemaining}m` : ''}
            </span>
          )}
          {isTrendMode && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-yellow-700/30 text-gray-400 border border-gray-600/40">
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
          <div className="text-xs text-gray-600 mb-2">Price Levels</div>
          <div className="bg-black/20 rounded p-3 space-y-2">
            {/* TP */}
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">TP</span>
              <span className="text-gray-400 font-mono text-sm">{setup.tp.toFixed(5)}</span>
              {setup.tpPips && <span className="text-gray-500 text-xs">+{setup.tpPips.toFixed(1)} pips</span>}
            </div>
            
            {/* Entry */}
            <div className="flex justify-between items-center border-y border-gray-800/50 py-2">
              <span className="text-gray-500 text-xs">ENTRY</span>
              <span className="text-gray-300 font-mono text-sm font-bold">{setup.entryPrice.toFixed(5)}</span>
              <span className="text-gray-600 text-xs">→</span>
            </div>
            
            {/* Current Price */}
            {setup.currentPrice && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-xs">NOW</span>
                <span className="text-gray-400 font-mono text-sm">{setup.currentPrice.toFixed(5)}</span>
              </div>
            )}
            
            {/* SL */}
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">SL</span>
              <span className="text-gray-400 font-mono text-sm">{setup.sl.toFixed(5)}</span>
              {setup.slPips && <span className="text-gray-500 text-xs">-{setup.slPips.toFixed(1)} pips</span>}
            </div>
          </div>
        </div>
      )}

      {/* FVG Zone */}
      {setup.fvgHigh && setup.fvgLow && (
        <div className="mb-3">
          <div className="text-xs text-gray-600 mb-1">FVG Zone ({setup.fvgSide})</div>
          <div className="bg-gray-800/30 rounded px-3 py-2 border border-gray-700/30">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">High: {setup.fvgHigh.toFixed(5)}</span>
              <span className="text-gray-400">Low: {setup.fvgLow.toFixed(5)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Sweep Info */}
      {setup.sweepLevel && (
        <div className="mb-3">
          <div className="text-xs text-gray-600 mb-1">Sweep</div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Level: {setup.sweepLevel.toFixed(5)}</span>
            {setup.sweepPips && <span className="text-gray-500">{setup.sweepPips.toFixed(1)} pips</span>}
          </div>
          {setup.sweepCandlesAgo !== undefined && (
            <div className="text-xs text-gray-600 mt-1">
              {setup.sweepCandlesAgo} candles ago (max: {setup.maxCandlesToWait})
            </div>
          )}
        </div>
      )}

      {/* Pending Order Info */}
      {setup.pendingOrderTicket && (
        <div className="mb-3">
          <div className="text-xs text-gray-600 mb-1">Pending Order</div>
          <div className="bg-gray-800/30 rounded px-3 py-2 border border-gray-700/30">
            <div className="flex justify-between text-sm">
              <span className="text-gray-300 font-bold">{setup.pendingOrderType}</span>
              <span className="text-gray-400">#{setup.pendingOrderTicket}</span>
            </div>
            {setup.pendingOrderPlacedAt && (
              <div className="text-xs text-gray-500 mt-1">
                Placed: {new Date(setup.pendingOrderPlacedAt).toLocaleTimeString()}
              </div>
            )}
            <div className="text-xs text-gray-600 mt-1">
              Waiting for price to reach entry...
            </div>
          </div>
        </div>
      )}

      {/* Asian Range (XAU) */}
      {setup.asianHigh && setup.asianLow && (
        <div className="mb-3">
          <div className="text-xs text-gray-600 mb-1">Asian Range</div>
          <div className="bg-gray-800/30 rounded px-3 py-2 border border-gray-700/30">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">High: {setup.asianHigh.toFixed(2)}</span>
              <span className="text-gray-400">Low: {setup.asianLow.toFixed(2)}</span>
            </div>
            {setup.asianRangePips && (
              <div className="text-xs text-gray-500 mt-1">Range: {setup.asianRangePips.toFixed(1)} pips</div>
            )}
          </div>
        </div>
      )}

      {/* Trend Info */}
      {setup.trend && (
        <div className="flex items-center gap-2 text-xs text-gray-600 mb-2">
          <span>Trend:</span>
          <span className="text-gray-400">
            {setup.trend} {setup.emaSeparationPips && `(${setup.emaSeparationPips.toFixed(1)} pips sep)`}
          </span>
        </div>
      )}

      {/* Skip Reason */}
      {setup.skipReason && (
        <div className="text-xs text-gray-500 mt-2">
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

// All symbols the bot tracks (including disabled ones for display)
const ALL_SYMBOLS = ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'USDJPYz', 'AUDUSDz', 'NZDUSDz', 'USDCADz', 'EURJPYz', 'US30z', 'NAS100z'];

// Symbols temporarily disabled (XAU and indices until January)
const DISABLED_SYMBOLS = ['XAUUSDz', 'US30z', 'NAS100z'];

// RiskInput Component - MUST be defined outside RiskControl to prevent recreation on every render
function RiskInput({ 
  label, 
  value, 
  category, 
  disabled = false,
  loading,
  onUpdate
}: { 
  label: string; 
  value: number; 
  category: 'riskFX' | 'riskXAU' | 'riskIndices';
  disabled?: boolean;
  loading: boolean;
  onUpdate: (category: 'riskFX' | 'riskXAU' | 'riskIndices', val: number) => void;
}) {
  const [inputValue, setInputValue] = useState(value.toString());
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    // Only update from parent if not currently editing AND input is not focused
    if (!isEditing && document.activeElement !== inputRef.current) {
      setInputValue(value.toString());
    }
  }, [value, isEditing]);
  
  const handleApply = () => {
    const val = parseFloat(inputValue);
    if (!isNaN(val) && val !== value) {
      onUpdate(category, val);
    }
    setIsEditing(false);
  };
  
  return (
    <div className={`flex items-center gap-2 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-gray-400 text-xs w-16">{label}</span>
      <button
        onClick={() => !disabled && onUpdate(category, Math.round(Math.max(0.5, value - 0.1) * 10) / 10)}
        disabled={loading || disabled || value <= 0.5}
        className="w-6 h-6 flex items-center justify-center bg-gray-700/50 hover:bg-gray-600/50 border border-gray-600 rounded text-gray-300 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
      >
        -
      </button>
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={() => setIsEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !disabled) {
            handleApply();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setInputValue(value.toString());
            setIsEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => {
          // Small delay to allow the value to be properly set before applying
          setTimeout(() => {
            handleApply();
          }, 100);
        }}
        disabled={disabled}
        className="w-14 px-2 py-1 bg-black/30 border border-gray-600 rounded text-center text-white text-sm disabled:cursor-not-allowed"
      />
      <span className="text-gray-500 text-xs">%</span>
      <button
        onClick={() => !disabled && onUpdate(category, Math.round(Math.min(20, value + 0.1) * 10) / 10)}
        disabled={loading || disabled || value >= 20}
        className="w-6 h-6 flex items-center justify-center bg-gray-700/50 hover:bg-gray-600/50 border border-gray-600 rounded text-gray-300 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
      >
        +
      </button>
      {disabled && <span className="text-gray-500 text-xs ml-1">Disabled</span>}
    </div>
  );
}

// Risk Control Component - supports per-category risk
function RiskControl() {
  const [riskFX, setRiskFX] = useState<number>(5.0);
  const [riskXAU, setRiskXAU] = useState<number>(3.0);
  const [riskIndices, setRiskIndices] = useState<number>(3.0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Fetch current risk on mount
  useEffect(() => {
    const fetchRisk = async () => {
      try {
        const response = await fetch('/api/risk');
        const data = await response.json();
        setRiskFX(data.riskFX || 5.0);
        setRiskXAU(data.riskXAU || 3.0);
        setRiskIndices(data.riskIndices || 3.0);
      } catch (err) {
        console.error('Failed to fetch risk:', err);
      }
    };
    fetchRisk();
  }, []);

  const updateRisk = async (category: 'riskFX' | 'riskXAU' | 'riskIndices', newRisk: number) => {
    if (newRisk < 0.5 || newRisk > 20) {
      setMessage('Risk must be 0.5% - 20%');
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    
    setLoading(true);
    try {
      const response = await fetch('/api/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [category]: newRisk })
      });
      const data = await response.json();
      
      if (data.success) {
        setRiskFX(data.riskFX);
        setRiskXAU(data.riskXAU);
        setRiskIndices(data.riskIndices);
        const label = category === 'riskFX' ? 'FX' : category === 'riskXAU' ? 'XAU' : 'Indices';
        setMessage(`${label} risk set to ${newRisk}%`);
      } else {
        setMessage(data.error || 'Failed to update');
      }
    } catch (err) {
      console.error('Risk update error:', err);
      setMessage('Server offline');
    }
    setLoading(false);
    setTimeout(() => setMessage(null), 3000);
  };

  return (
    <div className="bg-gray-800/30 backdrop-blur-sm rounded-lg p-3 border border-gray-700/50">
      <div className="flex items-center justify-between mb-3">
        <span className="text-gray-300 text-sm font-medium">Risk Per Trade</span>
        {message && (
          <span className={`text-xs ${message.includes('set') ? 'text-green-400' : 'text-yellow-400'}`}>
            {message}
          </span>
        )}
      </div>
      <div className="space-y-2">
        <RiskInput label="FX" value={riskFX} category="riskFX" loading={loading} onUpdate={updateRisk} />
        <RiskInput label="Gold" value={riskXAU} category="riskXAU" disabled loading={loading} onUpdate={updateRisk} />
        <RiskInput label="Indices" value={riskIndices} category="riskIndices" disabled loading={loading} onUpdate={updateRisk} />
      </div>
      <div className="mt-2 text-xs text-gray-500">
        Gold & Indices disabled
      </div>
    </div>
  );
}

export default function SetupVisualization() {
  const [setups, setSetups] = useState<LiveSetups>(() => {
    // Initialize with all symbols
    const initial: LiveSetups = {};
    ALL_SYMBOLS.forEach(s => initial[s] = null);
    return initial;
  });
  const [openTrades, setOpenTrades] = useState<Record<string, OpenTrade | null>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Track recently closed trades to prevent poll from re-adding stale data
  const recentlyClosedRef = useRef<Set<string>>(new Set());
  
  // Debounce ref to prevent rapid state updates causing flicker
  const pendingSetupsRef = useRef<LiveSetups | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Debounced setups update to prevent flicker
  const updateSetupsDebounced = (newSetups: LiveSetups) => {
    pendingSetupsRef.current = newSetups;
    
    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    // Set new timer - update after 100ms of no new updates
    debounceTimerRef.current = setTimeout(() => {
      if (pendingSetupsRef.current) {
        setSetups(pendingSetupsRef.current);
        pendingSetupsRef.current = null;
      }
    }, 100);
  };

  // Fetch setups (backup polling ONLY when SSE is disconnected)
  const fetchSetups = async () => {
    try {
      const response = await fetch('/api/setups');
      const data = await response.json();
      if (data.setups) {
        // Use immediate update for polling (only runs when disconnected)
        setSetups(prev => {
          const merged: LiveSetups = {};
          ALL_SYMBOLS.forEach(symbol => {
            merged[symbol] = data.setups[symbol] ?? prev[symbol] ?? null;
          });
          return merged;
        });
      }
    } catch (e) {
      console.error('Failed to fetch setups:', e);
    }
  };

  // Fetch open positions from MT5 bridge
  const fetchOpenPositions = async () => {
    try {
      const response = await fetch('/api/positions');
      const data = await response.json();
      
      // Check if we actually have positions (array with items)
      const positions = data.positions || [];
      
      setOpenTrades(prev => {
        const newOpenTrades: Record<string, OpenTrade | null> = {};
        
        // Track which symbols have positions
        const symbolsWithPositions = new Set<string>();
        
        // Add/update positions we found
        for (const pos of positions) {
          if (ALL_SYMBOLS.includes(pos.symbol)) {
            // Skip if this symbol was recently closed (prevents stale data race)
            if (recentlyClosedRef.current.has(pos.symbol)) {
              continue;
            }
            
            symbolsWithPositions.add(pos.symbol);
            const existingTrade = prev[pos.symbol];
            
            newOpenTrades[pos.symbol] = {
              ticket: pos.ticket,
              symbol: pos.symbol,
              side: pos.side,
              entryPrice: pos.entryPrice,
              currentPrice: pos.currentPrice ?? existingTrade?.currentPrice,
              // Keep existing unrealizedPips if new value not provided
              unrealizedPips: pos.unrealizedPips ?? existingTrade?.unrealizedPips ?? 0,
              sl: pos.sl,
              tp: pos.tp,
              status: 'open'
            };
          }
        }
        
        // For all tracked symbols, set to null if no position found
        ALL_SYMBOLS.forEach(s => {
          if (!symbolsWithPositions.has(s)) {
            newOpenTrades[s] = null;
          }
        });
        
        // Clear recently closed ref if those symbols have no position anymore
        recentlyClosedRef.current.forEach(symbol => {
          if (!symbolsWithPositions.has(symbol)) {
            recentlyClosedRef.current.delete(symbol);
          }
        });
        
        return newOpenTrades;
      });
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }
  };

  // Poll for open positions every 5 seconds
  useEffect(() => {
    fetchOpenPositions(); // Initial fetch
    const positionInterval = setInterval(fetchOpenPositions, 5000);
    return () => clearInterval(positionInterval);
  }, []);

  // Backup polling for setups ONLY when SSE is disconnected
  useEffect(() => {
    // Only poll when not connected to SSE
    if (connected) {
      return; // SSE is working, no need to poll
    }
    
    fetchSetups(); // Initial fetch when disconnected
    const setupInterval = setInterval(fetchSetups, 3000);
    return () => clearInterval(setupInterval);
  }, [connected]); // Re-run when connection status changes

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
            
            // Handle setup updates - use debounced update to prevent flicker
            if (data.setups) {
              // Merge incoming setups, keeping all symbols
              const merged: LiveSetups = {};
              ALL_SYMBOLS.forEach(symbol => {
                merged[symbol] = data.setups[symbol] ?? null;
              });
              updateSetupsDebounced(merged);
            }
            
            // Handle trade updates (live P/L)
            if (data.type === 'trade_update' && data.trade) {
              // Remove from recently closed since we have an active update
              recentlyClosedRef.current.delete(data.trade.symbol);
              setOpenTrades(prev => ({
                ...prev,
                [data.trade.symbol]: data.trade
              }));
            }
            
            // Handle trade closed
            if (data.type === 'trade_closed' && data.trade) {
              // Mark as recently closed to prevent poll from re-adding stale data
              recentlyClosedRef.current.add(data.trade.symbol);
              // Clear after 10 seconds (enough time for poll to sync)
              setTimeout(() => {
                recentlyClosedRef.current.delete(data.trade.symbol);
              }, 10000);
              
              setOpenTrades(prev => ({
                ...prev,
                [data.trade.symbol]: null
              }));
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
    <div className="bg-gray-900/60 backdrop-blur-sm rounded-xl border border-gray-700/50 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800/50 px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold bg-gray-700 px-2 py-1 rounded text-gray-300">LIVE</span>
          <h2 className="text-lg font-semibold text-gray-200">Live Setups</h2>
        </div>
        <div className={`flex items-center gap-2 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {/* Risk Control Panel */}
      <div className="px-4 pt-4">
        <RiskControl />
      </div>

      {/* Setup Cards */}
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 auto-rows-fr">
        {Object.entries(setups).map(([symbol, setup]) => (
          <SetupCard 
            key={symbol} 
            symbol={symbol} 
            setup={setup} 
            openTrade={openTrades[symbol]} 
            isDisabled={DISABLED_SYMBOLS.includes(symbol)}
          />
        ))}
      </div>
    </div>
  );
}
