// src/core/session-manager.ts
// Tracks trading sessions (London, NY) and session highs/lows

export interface SessionLevel {
  high: number;
  low: number;
  highTime: Date;
  lowTime: Date;
  swept: 'high' | 'low' | null;
  sweptAt?: Date;
}

export interface SessionInfo {
  name: string;
  active: boolean;
  startHour: number;  // UTC
  endHour: number;    // UTC
  levels: SessionLevel | null;
}

export type SessionName = 'asian' | 'london' | 'ny' | 'ny_pm';

// Session times in UTC
const SESSION_TIMES: Record<SessionName, { start: number; end: number }> = {
  asian:  { start: 0, end: 8 },     // 00:00 - 08:00 UTC (7PM-3AM EST)
  london: { start: 7, end: 16 },    // 07:00 - 16:00 UTC (2AM-11AM EST)  
  ny:     { start: 13, end: 21 },   // 13:00 - 21:00 UTC (8AM-4PM EST)
  ny_pm:  { start: 18, end: 22 }    // 18:00 - 22:00 UTC (1PM-5PM EST)
};

export class SessionManager {
  private sessions: Map<string, Map<SessionName, SessionLevel>> = new Map();
  
  constructor(private symbols: string[]) {
    // Initialize session tracking for each symbol
    for (const symbol of symbols) {
      this.sessions.set(symbol, new Map());
    }
  }

  /**
   * Get current active session(s)
   */
  getActiveSessions(now: Date = new Date()): SessionName[] {
    const hour = now.getUTCHours();
    const active: SessionName[] = [];
    
    for (const [name, times] of Object.entries(SESSION_TIMES)) {
      if (times.start <= times.end) {
        // Normal case: start < end
        if (hour >= times.start && hour < times.end) {
          active.push(name as SessionName);
        }
      } else {
        // Overnight case: start > end (crosses midnight)
        if (hour >= times.start || hour < times.end) {
          active.push(name as SessionName);
        }
      }
    }
    
    return active;
  }

  /**
   * Check if we're in a tradeable session for a symbol
   */
  isTradingTime(symbol: string, now: Date = new Date()): boolean {
    const active = this.getActiveSessions(now);
    
    // XAU trades best in London and NY
    if (symbol.includes('XAU')) {
      return active.includes('london') || active.includes('ny');
    }
    
    // FX pairs trade London and NY
    return active.includes('london') || active.includes('ny');
  }

  /**
   * Get the primary session for current time
   */
  getPrimarySession(now: Date = new Date()): SessionName | null {
    const hour = now.getUTCHours();
    
    // Priority: NY > London > Asian
    if (hour >= 13 && hour < 21) return 'ny';
    if (hour >= 7 && hour < 16) return 'london';
    if (hour >= 0 && hour < 8) return 'asian';
    
    return null;
  }

  /**
   * Update session high/low from candle data
   */
  updateSessionLevels(
    symbol: string, 
    high: number, 
    low: number, 
    candleTime: Date
  ): void {
    const session = this.getPrimarySession(candleTime);
    if (!session) return;
    
    const symbolSessions = this.sessions.get(symbol);
    if (!symbolSessions) return;
    
    let levels = symbolSessions.get(session);
    
    // Check if we need to reset for new session
    if (levels && this.isNewSession(session, candleTime, levels)) {
      levels = undefined;
    }
    
    if (!levels) {
      // Start new session tracking
      levels = {
        high,
        low,
        highTime: candleTime,
        lowTime: candleTime,
        swept: null
      };
    } else {
      // Update levels
      if (high > levels.high) {
        levels.high = high;
        levels.highTime = candleTime;
      }
      if (low < levels.low) {
        levels.low = low;
        levels.lowTime = candleTime;
      }
    }
    
    symbolSessions.set(session, levels);
  }

  /**
   * Check if price swept a session level
   */
  checkSweep(
    symbol: string,
    currentPrice: number,
    session: SessionName
  ): { swept: 'high' | 'low'; level: number; pips: number } | null {
    const symbolSessions = this.sessions.get(symbol);
    if (!symbolSessions) return null;
    
    const levels = symbolSessions.get(session);
    if (!levels || levels.swept) return null; // Already swept or no levels
    
    const pipSize = symbol.includes('XAU') ? 0.1 : 0.0001;
    const sweepThreshold = symbol.includes('XAU') ? 1.0 : 0.0003; // 10 pips XAU, 3 pips FX
    
    // Check high sweep
    if (currentPrice > levels.high + sweepThreshold) {
      levels.swept = 'high';
      levels.sweptAt = new Date();
      const pips = (currentPrice - levels.high) / pipSize;
      return { swept: 'high', level: levels.high, pips };
    }
    
    // Check low sweep
    if (currentPrice < levels.low - sweepThreshold) {
      levels.swept = 'low';
      levels.sweptAt = new Date();
      const pips = (levels.low - currentPrice) / pipSize;
      return { swept: 'low', level: levels.low, pips };
    }
    
    return null;
  }

  /**
   * Get session levels for a symbol
   */
  getSessionLevels(symbol: string, session: SessionName): SessionLevel | null {
    return this.sessions.get(symbol)?.get(session) || null;
  }

  /**
   * Get previous session levels (for sweep targets)
   */
  getPreviousSessionLevels(symbol: string, now: Date = new Date()): SessionLevel | null {
    const current = this.getPrimarySession(now);
    
    // Map current session to previous
    const prevMap: Record<SessionName, SessionName> = {
      asian: 'ny_pm',
      london: 'asian',
      ny: 'london',
      ny_pm: 'ny'
    };
    
    if (!current) return null;
    const prev = prevMap[current];
    return this.getSessionLevels(symbol, prev);
  }

  /**
   * Reset sweep flag for new trading opportunity
   */
  resetSweep(symbol: string, session: SessionName): void {
    const levels = this.sessions.get(symbol)?.get(session);
    if (levels) {
      levels.swept = null;
      levels.sweptAt = undefined;
    }
  }

  /**
   * Warm up session levels from historical candles
   * Call this on startup to have levels immediately available
   */
  warmUpFromCandles(symbol: string, candles: Array<{ high: number; low: number; time: number | string }>): void {
    if (!candles || candles.length === 0) return;
    
    // Process candles to build session levels
    for (const candle of candles) {
      const time = typeof candle.time === 'number' 
        ? new Date(candle.time * 1000) 
        : new Date(candle.time);
      
      this.updateSessionLevels(symbol, candle.high, candle.low, time);
    }
  }

  /**
   * Check if we have session levels for a symbol (for warm-up status)
   */
  hasLevelsFor(symbol: string): boolean {
    const symbolSessions = this.sessions.get(symbol);
    if (!symbolSessions) return false;
    
    // Check if we have at least one session with levels
    for (const levels of symbolSessions.values()) {
      if (levels) return true;
    }
    return false;
  }

  /**
   * Get warm-up status for all symbols
   */
  getWarmUpStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const symbol of this.symbols) {
      status[symbol] = this.hasLevelsFor(symbol);
    }
    return status;
  }

  /**
   * Check if this is a new session (should reset levels)
   */
  private isNewSession(session: SessionName, candleTime: Date, levels: SessionLevel): boolean {
    const times = SESSION_TIMES[session];
    const candleHour = candleTime.getUTCHours();
    const levelHour = levels.highTime.getUTCHours();
    
    // If candle is at session start and levels are from session end, reset
    if (candleHour === times.start && levelHour >= times.end - 2) {
      return true;
    }
    
    // If more than 24 hours old, reset
    const age = candleTime.getTime() - levels.highTime.getTime();
    if (age > 24 * 60 * 60 * 1000) {
      return true;
    }
    
    return false;
  }

  /**
   * Get session info for display
   */
  getSessionInfo(now: Date = new Date()): SessionInfo[] {
    const active = this.getActiveSessions(now);
    
    return (Object.entries(SESSION_TIMES) as [SessionName, { start: number; end: number }][]).map(([name, times]) => ({
      name,
      active: active.includes(name),
      startHour: times.start,
      endHour: times.end,
      levels: null // Would need symbol to get levels
    }));
  }
}

// Singleton instance
let sessionManager: SessionManager | null = null;

export function getSessionManager(symbols: string[] = ['GBPUSDz', 'EURUSDz', 'XAUUSDz']): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(symbols);
  }
  return sessionManager;
}
