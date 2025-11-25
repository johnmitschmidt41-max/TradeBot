// src/utils/time.ts
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
