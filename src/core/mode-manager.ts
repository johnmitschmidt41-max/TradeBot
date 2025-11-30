// src/core/mode-manager.ts
// Manages trading mode (DEMO/REAL) with auto-switch logic

import * as fs from 'fs';
import * as path from 'path';
import { MODE_CONFIG, ModeState, DEFAULT_MODE_STATE, TradingMode } from '../config/mode';
import { info, warn, error } from '../utils/logger';

const MODE_STATE_FILE = path.join(process.cwd(), 'data/config/trading_mode.json');
const MODE_LOG_FILE = path.join(process.cwd(), 'data/logs/mode_changes.log');

export class ModeManager {
  private currentState: ModeState = DEFAULT_MODE_STATE;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.loadState();
  }

  /**
   * Load mode state from file
   */
  private loadState(): void {
    try {
      if (fs.existsSync(MODE_STATE_FILE)) {
        const data = fs.readFileSync(MODE_STATE_FILE, 'utf-8');
        this.currentState = JSON.parse(data);
        info(`✅ Mode state loaded: ${this.currentState.mode}`);
      } else {
        this.currentState = DEFAULT_MODE_STATE;
        this.saveState();
        info(`📝 Created default mode state: ${this.currentState.mode}`);
      }
    } catch (e) {
      error('Failed to load mode state', e);
      this.currentState = DEFAULT_MODE_STATE;
    }
  }

  /**
   * Save mode state to file
   */
  private saveState(): void {
    try {
      const dir = path.dirname(MODE_STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(MODE_STATE_FILE, JSON.stringify(this.currentState, null, 2));
    } catch (e) {
      error('Failed to save mode state', e);
    }
  }

  /**
   * Log mode change to audit trail
   */
  private logModeChange(message: string, details?: any): void {
    try {
      const dir = path.dirname(MODE_LOG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const timestamp = new Date().toISOString();
      const logLine = `${timestamp} [MODE] ${message} ${details ? JSON.stringify(details) : ''}\n`;
      fs.appendFileSync(MODE_LOG_FILE, logLine);
    } catch (e) {
      error('Failed to log mode change', e);
    }
  }

  /**
   * Get current mode (DEMO or REAL)
   */
  getMode(): TradingMode {
    return this.currentState.mode;
  }

  /**
   * Get full mode state
   */
  getState(): ModeState {
    return { ...this.currentState };
  }

  /**
   * Switch mode manually
   */
  async switchMode(newMode: TradingMode, reason: 'manual' | 'auto_3_losses' | 'daily_restart'): Promise<boolean> {
    if (newMode === this.currentState.mode) {
      warn(`Already in ${newMode} mode, no switch needed`);
      return false;
    }

    // Check if locked
    if (this.currentState.lockedUntil) {
      const lockUntil = new Date(this.currentState.lockedUntil);
      if (new Date() < lockUntil) {
        error(`Mode switch locked until ${this.currentState.lockedUntil}`);
        return false;
      }
    }

    this.currentState.mode = newMode;
    this.currentState.lastSwitched = new Date().toISOString();
    this.currentState.reason = reason;

    // Set lock duration if auto-switch
    if (reason === 'auto_3_losses') {
      const lockUntil = new Date();
      lockUntil.setSeconds(lockUntil.getSeconds() + MODE_CONFIG.autoSwitch.lockDurationAfterAutoSwitch);
      this.currentState.lockedUntil = lockUntil.toISOString();
    }

    // If switching to REAL, reset loss counter
    if (newMode === 'REAL') {
      this.currentState.consecutiveLosses = {
        count: 0,
        startedAt: null,
        trades: []
      };
      this.currentState.autoRules.demoLearningMode = false;
    }

    // If switching to DEMO from loss trigger
    if (newMode === 'DEMO' && reason === 'auto_3_losses') {
      this.currentState.autoRules.demoLearningMode = true;
    }

    this.saveState();
    this.logModeChange(`Switched to ${newMode} mode`, { reason, lockedUntil: this.currentState.lockedUntil });
    info(`🔄 Mode switched to ${newMode} (reason: ${reason})`);

    return true;
  }

  /**
   * Record a trade result
   * Only counts CONSECUTIVE losses (win breaks the streak)
   */
  recordTradeResult(orderId: string, profit: number): void {
    if (this.currentState.mode === 'REAL') {
      if (profit < 0) {
        // LOSS on REAL account
        if (this.currentState.consecutiveLosses.count === 0) {
          this.currentState.consecutiveLosses.startedAt = new Date().toISOString();
        }

        this.currentState.consecutiveLosses.count++;
        this.currentState.consecutiveLosses.trades.push({
          orderId,
          profit,
          timestamp: new Date().toISOString()
        });

        const lossNum = this.currentState.consecutiveLosses.count;
        const threshold = MODE_CONFIG.autoSwitch.consecutiveLossThreshold;

        warn(`❌ Loss #${lossNum}/${threshold} consecutive (${profit < 0 ? '-' : ''}$${Math.abs(profit).toFixed(2)})`);
        this.logModeChange(`Loss recorded`, { orderId, profit, count: lossNum });

        // Check if threshold hit
        if (lossNum >= threshold) {
          info(`⛔ LOSS THRESHOLD HIT: ${lossNum} consecutive losses`);
          this.switchMode('DEMO', 'auto_3_losses');
        }

        this.saveState();
      } else if (profit >= 0) {
        // WIN on REAL - breaks the consecutive loss streak
        if (this.currentState.consecutiveLosses.count > 0) {
          const wasCount = this.currentState.consecutiveLosses.count;
          info(`✅ Win recorded - consecutive loss streak broken (was ${wasCount}/3, now reset)`);
          this.logModeChange(`Win - loss streak reset`, { orderId, profit, wasCount });
          
          this.currentState.consecutiveLosses = {
            count: 0,
            startedAt: null,
            trades: []
          };
          this.saveState();
        }
      }
    }
  }

  /**
   * Check for daily restart and restore REAL mode if needed
   */
  async checkDailyRestart(): Promise<void> {
    const now = new Date();
    const currentHourUTC1 = now.getUTCHours() + 1; // Convert to UTC+1
    const currentMinute = now.getMinutes();

    // Check if it's the restart hour (03:00 UTC+1)
    if (currentHourUTC1 === MODE_CONFIG.autoSwitch.dailyRestartHourUTC1 && currentMinute === 0) {
      if (this.currentState.mode === 'DEMO' && this.currentState.autoRules.demoLearningMode) {
        info(`🌅 Daily restart at 03:00 UTC+1 - restoring REAL mode`);
        await this.switchMode('REAL', 'daily_restart');
      }
    }
  }

  /**
   * Start monitoring for daily restart
   */
  startDailyRestartMonitor(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      await this.checkDailyRestart();
    }, 60000); // Check every minute

    info('📊 Daily restart monitor started');
  }

  /**
   * Stop monitoring
   */
  stopDailyRestartMonitor(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      info('⏸ Daily restart monitor stopped');
    }
  }

  /**
   * Get consecutive losses info
   */
  getConsecutiveLossesInfo(): { count: number; remaining: number; trades: any[] } {
    return {
      count: this.currentState.consecutiveLosses.count,
      remaining: MODE_CONFIG.autoSwitch.consecutiveLossThreshold - this.currentState.consecutiveLosses.count,
      trades: this.currentState.consecutiveLosses.trades
    };
  }
}

export const modeManager = new ModeManager();
