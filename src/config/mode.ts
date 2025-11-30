// src/config/mode.ts
// Trading mode configuration: DEMO vs REAL with auto-switch rules

export const MODE_CONFIG = {
  // Initial mode on startup
  initialMode: 'DEMO' as const,
  
  // Auto-switch rules for loss protection
  autoSwitch: {
    enabled: true,
    consecutiveLossThreshold: 3,      // Switch to DEMO after 3 consecutive losses on REAL
    demoLearningOnTrigger: true,      // Stay in DEMO for learning after loss trigger
    restoreAtDailyRestart: true,      // Auto-restore to REAL at daily restart (03:00 UTC+1)
    dailyRestartHourUTC1: 3,          // Hour in UTC+1 timezone when bot wakes up
    lockDurationAfterAutoSwitch: 300  // 5 minutes (300 seconds) lock after auto-switch
  },
  
  // Safety confirmations
  requireConfirmationForManualSwitch: true,  // User must confirm before switching
  confirmationPhrase: 'confirm-real-mode'    // Required confirmation phrase
};

export type TradingMode = 'DEMO' | 'REAL';

export interface ModeState {
  mode: TradingMode;
  lastSwitched: string;                      // ISO timestamp
  reason: 'manual' | 'auto_3_losses' | 'daily_restart' | 'startup';
  consecutiveLosses: {
    count: number;
    startedAt: string | null;                // ISO timestamp
    trades: Array<{orderId: string; profit: number; timestamp: string}>;
  };
  autoRules: {
    enabled: boolean;
    lossThreshold: number;
    demoLearningMode: boolean;                // True if in DEMO from loss trigger
    restoreAtDailyRestart: boolean;
  };
  lockedUntil?: string;                      // ISO timestamp for lock duration
}

export const DEFAULT_MODE_STATE: ModeState = {
  mode: 'DEMO',
  lastSwitched: new Date().toISOString(),
  reason: 'startup',
  consecutiveLosses: {
    count: 0,
    startedAt: null,
    trades: []
  },
  autoRules: {
    enabled: MODE_CONFIG.autoSwitch.enabled,
    lossThreshold: MODE_CONFIG.autoSwitch.consecutiveLossThreshold,
    demoLearningMode: false,
    restoreAtDailyRestart: MODE_CONFIG.autoSwitch.restoreAtDailyRestart
  }
};
