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
