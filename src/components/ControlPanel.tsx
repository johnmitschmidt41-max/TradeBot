// frontend/src/components/ControlPanel.tsx
// Trading mode switch and account info panel

import { useEffect, useState } from 'react';

interface AccountInfo {
  status: string;
  trading_mode: string;
  account: number | null;
  server: string | null;
  terminal_info?: {
    name?: string;
    company?: string;
    connected?: boolean;
  } | null;
  error?: string;
}

const SERVER_URL = '';

export default function ControlPanel() {
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [currentMode, setCurrentMode] = useState<string>('DEMO');
  const [isLoading, setIsLoading] = useState(false);
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);

  // Fetch account info from bridge
  const fetchAccountInfo = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/account`);
      const data = await response.json();
      setAccountInfo(data);
    } catch (e) {
      setAccountInfo({
        status: 'disconnected',
        trading_mode: 'UNKNOWN',
        account: null,
        server: null,
        error: 'Failed to fetch account info'
      });
    }
  };

  // Fetch current mode from config file
  const fetchCurrentMode = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/mode`);
      const data = await response.json();
      setCurrentMode(data.mode || 'DEMO');
    } catch (e) {
      console.error('Failed to fetch mode:', e);
    }
  };

  // Switch trading mode
  const switchMode = async (newMode: string) => {
    if (newMode === currentMode) return;
    
    setIsLoading(true);
    setSwitchMessage(null);
    
    try {
      const response = await fetch(`${SERVER_URL}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      
      const data = await response.json();
      
      if (response.ok && data.ok) {
        setCurrentMode(newMode);
        setSwitchMessage(data.message);
        
        // Clear message after 5 seconds
        setTimeout(() => setSwitchMessage(null), 5000);
        
        // Refresh account info
        setTimeout(fetchAccountInfo, 1000);
      } else {
        setSwitchMessage(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      console.error('Switch mode error:', e);
      setSwitchMessage(`Failed to switch mode: ${e.message || 'Network error'}`);
    }
    
    setIsLoading(false);
  };

  // Restart Python Bridge after mode switch
  const restartBridge = async () => {
    setIsLoading(true);
    setSwitchMessage('Restarting Python Bridge...');
    
    try {
      await fetch(`${SERVER_URL}/api/service/python-bridge/restart`, { method: 'POST' });
      setSwitchMessage('Python Bridge restarting... Please wait.');
      
      // Wait and refresh
      setTimeout(() => {
        fetchAccountInfo();
        setSwitchMessage(null);
      }, 5000);
    } catch (e) {
      setSwitchMessage('Failed to restart bridge');
    }
    
    setIsLoading(false);
  };

  useEffect(() => {
    fetchAccountInfo();
    fetchCurrentMode();
    
    // Refresh every 10 seconds
    const interval = setInterval(() => {
      fetchAccountInfo();
      fetchCurrentMode();
    }, 10000);
    
    return () => clearInterval(interval);
  }, []);

  const isConnected = accountInfo?.status === 'connected';
  const bridgeMode = accountInfo?.trading_mode || 'UNKNOWN';
  const modeMatches = bridgeMode === currentMode;

  return (
    <div className="bg-gray-900/60 backdrop-blur-sm rounded-xl border border-gray-700/50 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800/50 px-4 py-3 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold bg-gray-700 px-2 py-1 rounded text-gray-300">CONTROL</span>
          <h2 className="text-lg font-semibold text-gray-200">Trading Mode & Account</h2>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Mode Switcher */}
          <div className="bg-gray-800/30 rounded-lg p-4 border border-gray-700/30">
            <h3 className="text-sm font-medium text-gray-500 mb-3">Trading Mode</h3>
            
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => switchMode('DEMO')}
                disabled={isLoading}
                className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all border ${
                  currentMode === 'DEMO'
                    ? 'bg-amber-600/80 text-white border-amber-500/50'
                    : 'bg-gray-800/50 text-gray-500 hover:bg-gray-700/50 hover:text-gray-300 border-gray-700/50'
                } disabled:opacity-50`}
              >
                DEMO
              </button>
              <button
                onClick={() => switchMode('REAL')}
                disabled={isLoading}
                className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all border ${
                  currentMode === 'REAL'
                    ? 'bg-emerald-600/80 text-white border-emerald-500/50'
                    : 'bg-gray-800/50 text-gray-500 hover:bg-gray-700/50 hover:text-gray-300 border-gray-700/50'
                } disabled:opacity-50`}
              >
                REAL
              </button>
            </div>

            {/* Mode Status */}
            <div className="text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">Config Mode:</span>
                <span className={`font-bold ${currentMode === 'REAL' ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {currentMode}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Bridge Mode:</span>
                <span className={`font-bold ${
                  bridgeMode === 'REAL' ? 'text-emerald-400' : 
                  bridgeMode === 'DEMO' ? 'text-amber-400' : 'text-gray-500'
                }`}>
                  {bridgeMode}
                </span>
              </div>
            </div>

            {/* Mode mismatch warning */}
            {!modeMatches && isConnected && (
              <div className="mt-3 p-2 bg-orange-900/20 border border-orange-700/50 rounded-lg">
                <p className="text-xs text-orange-400">
                  Mode mismatch! Restart Python Bridge to apply new mode.
                </p>
                <button
                  onClick={restartBridge}
                  disabled={isLoading}
                  className="mt-2 w-full py-1.5 bg-orange-600/80 hover:bg-orange-600 disabled:bg-gray-700 text-white text-xs font-bold rounded transition-colors"
                >
                  Restart Bridge
                </button>
              </div>
            )}

            {/* Switch message */}
            {switchMessage && (
              <div className="mt-3 p-2 bg-blue-900/20 border border-blue-700/50 rounded-lg">
                <p className="text-xs text-blue-400">{switchMessage}</p>
              </div>
            )}
          </div>

          {/* Account Info */}
          <div className="bg-gray-800/30 rounded-lg p-4 border border-gray-700/30">
            <h3 className="text-sm font-medium text-gray-500 mb-3">Account Status</h3>
            
            {/* Connection Status */}
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-red-500'}`}></div>
              <span className={`text-sm font-medium ${isConnected ? 'text-emerald-400' : 'text-red-400'}`}>
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            {/* Account Details */}
            {accountInfo && (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-600">Account:</span>
                  <span className="text-gray-300 font-mono">
                    {accountInfo.account ? `#${accountInfo.account}` : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Server:</span>
                  <span className="text-gray-300 font-mono truncate max-w-[150px]" title={accountInfo.server || '-'}>
                    {accountInfo.server || '-'}
                  </span>
                </div>
                {accountInfo.terminal_info && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Terminal:</span>
                      <span className="text-gray-300 truncate max-w-[150px]">
                        {accountInfo.terminal_info.name || '-'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Broker:</span>
                      <span className="text-gray-300 truncate max-w-[150px]">
                        {accountInfo.terminal_info.company || '-'}
                      </span>
                    </div>
                  </>
                )}
                {accountInfo.error && (
                  <div className="mt-2 p-2 bg-red-900/20 border border-red-700/50 rounded">
                    <p className="text-red-400">{accountInfo.error}</p>
                  </div>
                )}
              </div>
            )}

            {/* Refresh Button */}
            <button
              onClick={fetchAccountInfo}
              className="mt-3 w-full py-1.5 bg-gray-700/50 hover:bg-gray-600/50 text-gray-400 text-xs rounded border border-gray-600/50 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
