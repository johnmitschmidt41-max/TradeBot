// frontend/src/components/TradeJournal.tsx
// Trade history and statistics from MongoDB

import { useEffect, useState } from 'react';

interface Trade {
  _id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  sl: number;
  tp: number;
  volume: number;
  slPips: number;
  tpPips?: number;
  riskPercent: number;
  strategy: string;
  openTime: string;
  closeTime?: string;
  closePrice?: number;
  status: 'open' | 'closed';
  pnl?: number;
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

  useEffect(() => {
    fetchTrades();
    fetchStats();
    
    // Refresh every 30 seconds
    const interval = setInterval(() => {
      fetchTrades();
      fetchStats();
    }, 30000);

    return () => clearInterval(interval);
  }, [filter]);

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
          </div>
          
          {/* Filter Tabs */}
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
        </div>
      </div>

      {/* Stats Row */}
      {stats && (
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

      {/* Trade List */}
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
                <th className="px-4 py-2 text-right">SL</th>
                <th className="px-4 py-2 text-right">TP</th>
                <th className="px-4 py-2 text-right">Volume</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2 text-right">PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {trades.map((trade) => (
                <tr key={trade._id} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-400">
                    {new Date(trade.openTime).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-white font-medium">
                    {trade.symbol.replace('z', '')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-xs font-bold rounded ${
                      trade.side === 'BUY' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                    }`}>
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">
                    {trade.entryPrice.toFixed(5)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-red-400">
                    {trade.sl.toFixed(5)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-green-400">
                    {trade.tp.toFixed(5)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">
                    {trade.volume.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      trade.status === 'open' 
                        ? 'bg-blue-600/30 text-blue-300 border border-blue-600' 
                        : 'bg-gray-600/30 text-gray-300 border border-gray-600'
                    }`}>
                      {trade.status}
                    </span>
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${
                    trade.pnl === undefined ? 'text-gray-500' :
                    trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {trade.pnl !== undefined ? `$${trade.pnl.toFixed(2)}` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="bg-gray-800 px-4 py-2 border-t border-gray-700 text-xs text-gray-500">
        Last 30 days • {trades.length} trades shown
      </div>
    </div>
  );
}
