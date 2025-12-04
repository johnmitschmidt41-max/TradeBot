/**
 * Log Bridge Utility
 * Use this to send logs from your services to the dashboard
 * 
 * Example usage:
 * import { sendLog } from '../logBridge.js';
 * sendLog('mainbot', 'Trade executed successfully');
 */

import fetch from 'node-fetch';

const LOG_SERVER_URL = process.env.LOG_SERVER_URL || 'http://localhost:3001';

/**
 * Send a log to the dashboard
 * @param {string} service - Service name ('mainbot', 'python-bridge', 'scorer')
 * @param {string} message - Log message
 * @param {string} level - Log level ('info', 'warn', 'error', 'debug')
 */
export async function sendLog(service, message, level = 'info') {
  try {
    await fetch(`${LOG_SERVER_URL}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service,
        message,
        level,
        timestamp: new Date().toISOString()
      })
    });
  } catch (err) {
    console.error('Failed to send log:', err.message);
  }
}

/**
 * Stream logs from stdout
 * Use this to intercept process output
 */
export function captureOutput(service) {
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    const message = args.join(' ');
    originalLog(...args);
    sendLog(service, message, 'info').catch(() => {});
  };

  console.error = (...args) => {
    const message = args.join(' ');
    originalError(...args);
    sendLog(service, message, 'error').catch(() => {});
  };
}
