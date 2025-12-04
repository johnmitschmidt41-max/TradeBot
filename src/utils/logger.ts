// src/utils/logger.ts
import axios from 'axios';

const LOG_SERVER_URL = process.env.LOG_SERVER_URL || 'http://localhost:3001';

// Remove all emojis and special characters for frontend display
function stripEmojis(text: string): string {
  // Remove emoji ranges and common symbols used in logging
  return text
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // emoji unicode range
    .replace(/[\u{2600}-\u{27BF}]/gu, '') // misc symbols
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // emoticons
    .replace(/[⚙️➡️✅❌🔧🔎📊⭐⛔]/g, '') // specific symbols
    .trim();
}

async function postToDashboard(service: string, message: string, level = 'info') {
  try {
    // Strip emojis from message for frontend display
    const cleanMessage = stripEmojis(message);
    // fire-and-forget; do not block main flow
    axios.post(`${LOG_SERVER_URL}/api/log`, { service, message: cleanMessage, level }).catch(() => {});
  } catch (e) {
    // ignore failures — logging should not crash the app
  }
}

function formatArg(a: any) {
  try {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    return JSON.stringify(a);
  } catch (_e) {
    try { return String(a); } catch { return '[unserializable]'; }
  }
}

export const info = (...args: any[]) => {
  const msg = args.map(formatArg).join(' ');
  console.log(new Date().toISOString(), '[INFO]', msg);
  postToDashboard('mainbot', msg, 'info');
};

export const warn = (...args: any[]) => {
  const msg = args.map(formatArg).join(' ');
  console.warn(new Date().toISOString(), '[WARN]', msg);
  postToDashboard('mainbot', msg, 'warn');
};

export const error = (...args: any[]) => {
  const msg = args.map(formatArg).join(' ');
  console.error(new Date().toISOString(), '[ERROR]', msg);
  postToDashboard('mainbot', msg, 'error');
};

export const modelDecision = (message: string, data: any) => {
  console.log(`\x1b[36m${'═'.repeat(80)}\x1b[0m`);
  console.log(`\x1b[35mMODEL DECISION\x1b[0m`);
  console.log(`\x1b[36m${'─'.repeat(80)}\x1b[0m`);
  console.log(`\x1b[33m${message}\x1b[0m`);
  const detail = JSON.stringify(data, null, 2);
  console.log(`\x1b[36m${detail}\x1b[0m`);
  console.log(`\x1b[36m${'═'.repeat(80)}\x1b[0m\n`);
  
  // Send to dashboard with emoji stripped and structured format
  try {
    const cleanMessage = stripEmojis(message);
    axios.post(`${LOG_SERVER_URL}/api/log`, { 
      service: 'mainbot', 
      message: `[MODEL] ${cleanMessage}`,
      level: 'decision',
      data: data // send full data object for frontend to display
    }).catch(() => {});
  } catch (e) {
    // ignore dashboard send failures
  }
  
  try {
    // ensure output directory exists
    const fs = require('fs');
    const outDir = require('path').join(process.cwd(), 'data', 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const logPath = require('path').join(outDir, 'decision_logs.jsonl');
    // Structured decision object (auditable)
    const entry = {
      time: new Date().toISOString(),
      id: `dec_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      source: 'strategy',
      stage: (data && data.stage) ? data.stage : 'decision',
      verdict: (data && typeof data.verdict === 'string') ? data.verdict : (data && data.result) ? String(data.result) : 'info',
      message: stripEmojis(message),
      data
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (e) {
    // logging must not crash
  }
};
