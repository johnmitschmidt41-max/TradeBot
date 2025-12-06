// frontend/src/components/TradeJournal.tsx
// Trade history and statistics from MongoDB

import { useEffect, useState } from 'react';

interface Trade {
  _id: string;
  ticket?: string | number;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice?: number;
  sl?: number;
  tp?: number;
  volume?: number;
  slPips?: number;
  tpPips?: number;
  pnlPips?: number;
  riskPercent?: number;
  strategy?: string;
  openTime?: string;
  closeTime?: string;
  closePrice?: number;
  status: 'open' | 'closed';
  pnl?: number;
  profit?: number;
  result?: 'win' | 'loss' | 'breakeven';
  notes?: string;
}

interface Stats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnl: string;
  avgPnl: string;
}

// Use empty string for relative URLs (works with Vite proxy)
const SERVER_URL = '';

export default function TradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [tradingMode, setTradingMode] = useState<'DEMO' | 'REAL' | null>(null);

  // Fetch trading mode
  const fetchTradingMode = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/mode`);
      const data = await response.json();
      setTradingMode(data.mode || 'DEMO');
    } catch (e) {
      console.error('Failed to fetch trading mode:', e);
      setTradingMode('DEMO');
    }
  };

  // Sync history from MT5 bridge (less frequent - every 60 seconds)
  const syncHistory = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/history?hours=24`);
      const data = await response.json();
      if (data.synced > 0) {
        console.log(`Synced ${data.synced} trades from MT5 history`);
        setLastSync(new Date().toLocaleTimeString());
        // Refresh trades after sync
        fetchTrades();
        fetchStats();
      }
    } catch (e) {
      console.error('Failed to sync history:', e);
    }
  };

  useEffect(() => {
    // Fetch trading mode first
    fetchTradingMode();
    
    // Check mode periodically (every 30 seconds)
    const modeInterval = setInterval(fetchTradingMode, 30000);

    return () => {
      clearInterval(modeInterval);
    };
  }, []);

  useEffect(() => {
    // Only fetch trades if in REAL mode
    if (tradingMode !== 'REAL') {
      setLoading(false);
      return;
    }

    // Initial sync from MT5 history
    syncHistory();
    fetchTrades();
    fetchStats();
    
    // Sync history every 60 seconds (less frequent)
    const historyInterval = setInterval(syncHistory, 60000);
    
    // Refresh display every 30 seconds
    const displayInterval = setInterval(() => {
      fetchTrades();
      fetchStats();
    }, 30000);

    return () => {
      clearInterval(historyInterval);
      clearInterval(displayInterval);
    };
  }, [filter, tradingMode]);

  const fetchTrades = async () => {
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      params.set('limit', '50');
      
      const response = await fetch(`${SERVER_URL}/api/trades?${params}`);
      const data = await response.json();
      setTrades(data);
    } catch (e) {
      console.error('Failed to fetch trades:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/trades/stats?days=30`);
      const data = await response.json();
      if (!data.error) {
        setStats(data);
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800 px-4 py-3 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold bg-green-700 px-2 py-1 rounded text-white">JOURNAL</span>
            <h2 className="text-lg font-semibold text-white">Trade Journal</h2>
            {tradingMode && (
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                tradingMode === 'REAL' ? 'bg-green-600 text-white' : 'bg-yellow-600 text-white'
              }`}>
                {tradingMode}
              </span>
            )}
            {lastSync && tradingMode === 'REAL' && (
              <span className="text-xs text-gray-500">
                (MT5 synced: {lastSync})
              </span>
            )}
          </div>
          
          {/* Filter Tabs - only show in REAL mode */}
          {tradingMode === 'REAL' && (
            <div className="flex gap-1 bg-gray-700 rounded-lg p-1">
              {(['all', 'open', 'closed'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 text-xs rounded ${
                    filter === f 
                      ? 'bg-blue-600 text-white' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* DEMO Mode Message */}
      {tradingMode !== 'REAL' && (
        <div className="p-12 text-center">
          <div className="text-6xl mb-4">🧪</div>
          <h3 className="text-xl font-semibold text-white mb-2">Demo Mode Active</h3>
          <p className="text-gray-400 max-w-md mx-auto">
            Trade history is only displayed when the bot is running in <span className="text-green-400 font-bold">REAL</span> mode.
            Switch to real mode to view and track your actual trades.
          </p>
        </div>
      )}

      {/* Stats Row - only show in REAL mode */}
      {tradingMode === 'REAL' && stats && (
        <div className="bg-gray-800/50 px-4 py-3 border-b border-gray-700 grid grid-cols-6 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-white">{stats.totalTrades}</div>
            <div className="text-xs text-gray-400">Trades</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-green-400">{stats.wins}</div>
            <div className="text-xs text-gray-400">Wins</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-400">{stats.losses}</div>
            <div className="text-xs text-gray-400">Losses</div>
          </div>
          <div>
            <div className={`text-2xl font-bold ${parseFloat(stats.winRate) >= 50 ? 'text-green-400' : 'text-red-400'}`}>
              {stats.winRate}%
            </div>
            <div className="text-xs text-gray-400">Win Rate</div>
          </div>
          <div>
            <div className={`text-2xl font-bold ${parseFloat(stats.totalPnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${stats.totalPnl}
            </div>
            <div className="text-xs text-gray-400">Total PnL</div>
          </div>
          <div>
            <div className={`text-2xl font-bold ${parseFloat(stats.avgPnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${stats.avgPnl}
            </div>
            <div className="text-xs text-gray-400">Avg PnL</div>
          </div>
        </div>
      )}

      {/* Trade List - only show in REAL mode */}
      {tradingMode === 'REAL' && (
        <div className="max-h-96 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading trades...</div>
          ) : trades.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No trades recorded yet. Start the V2 bot to begin trading.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left">Time</th>
                  <th className="px-4 py-2 text-left">Symbol</th>
                  <th className="px-4 py-2 text-left">Side</th>
                  <th className="px-4 py-2 text-right">Entry</th>
                  <th className="px-4 py-2 text-right">Close</th>
                  <th className="px-4 py-2 text-right">Volume</th>
                  <th className="px-4 py-2 text-center">Result</th>
                  <th className="px-4 py-2 text-right">PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {trades.map((trade, index) => {
                const pnlValue = trade.pnl ?? trade.profit;
                const timeStr = trade.closeTime || trade.openTime;
                const displayTime = timeStr ? new Date(timeStr).toLocaleString() : 'Unknown';
                
                return (
                <tr key={trade._id || `trade-${index}`} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-400">
                    {displayTime}
                  </td>
                  <td className="px-4 py-3 text-white font-medium">
                    {trade.symbol?.replace('z', '') || 'Unknown'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-xs font-bold rounded ${
                      trade.side === 'BUY' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                    }`}>
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">
                    {trade.entryPrice ? trade.entryPrice.toFixed(trade.symbol?.includes('JPY') ? 3 : trade.symbol?.includes('XAU') ? 2 : 5) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">
                    {trade.closePrice ? trade.closePrice.toFixed(trade.symbol?.includes('JPY') ? 3 : trade.symbol?.includes('XAU') ? 2 : 5) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">
                    {trade.volume?.toFixed(2) || '-'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {trade.result ? (
                      <span className={`px-2 py-0.5 text-xs font-bold rounded ${
                        trade.result === 'win' ? 'bg-green-600 text-white' : 
                        trade.result === 'loss' ? 'bg-red-600 text-white' : 
                        'bg-gray-600 text-white'
                      }`}>
                        {trade.result.toUpperCase()}
                      </span>
                    ) : (
                      <span className={`px-2 py-0.5 text-xs rounded ${
                        trade.status === 'open' 
                          ? 'bg-blue-600/30 text-blue-300 border border-blue-600' 
                          : 'bg-gray-600/30 text-gray-300 border border-gray-600'
                      }`}>
                        {trade.status}
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono font-bold ${
                    pnlValue === undefined ? 'text-gray-500' :
                    pnlValue >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {pnlValue !== undefined ? `${pnlValue >= 0 ? '+' : ''}$${pnlValue.toFixed(2)}` : '-'}
                  </td>
                </tr>
              )})}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Footer */}
      {tradingMode === 'REAL' && (
        <div className="bg-gray-800 px-4 py-2 border-t border-gray-700 text-xs text-gray-500">
          Last 30 days • {trades.length} trades shown
        </div>
      )}
    </div>
  );
}
