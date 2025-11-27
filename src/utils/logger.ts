// src/utils/logger.ts
export const info = (...args: any[]) => {
  console.log(new Date().toISOString(), '[INFO]', ...args);
};

export const warn = (...args: any[]) => {
  console.warn(new Date().toISOString(), '[WARN]', ...args);
};

export const error = (...args: any[]) => {
  console.error(new Date().toISOString(), '[ERROR]', ...args);
};

export const modelDecision = (message: string, data: any) => {
  console.log(`\x1b[36m${'═'.repeat(80)}\x1b[0m`);
  console.log(`\x1b[35m⚙️  MODEL DECISION\x1b[0m`);
  console.log(`\x1b[36m${'─'.repeat(80)}\x1b[0m`);
  console.log(`\x1b[33m${message}\x1b[0m`);
  console.log(`\x1b[36m${JSON.stringify(data, null, 2)}\x1b[0m`);
  console.log(`\x1b[36m${'═'.repeat(80)}\x1b[0m\n`);
};
