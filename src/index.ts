// src/index.ts
import { MT5Connector } from "./core/mt5-connector";
import { Strategy } from "./strategy/jusdtt-m15";
import { info, error } from "./utils/logger";
import axios from "axios";

const BRIDGE = process.env.MT5_BRIDGE || "http://163.5.210.176:5000"; // replace <RDP_IP> with your VPS/RDP IP or use env var

// patch MT5Connector URL at runtime by editing the module constant
// simpler: create connector instance with the default URL and don't hardcode (we used constant earlier).
// If you want to override, set MT5_BRIDGE_URL env var and edit mt5-connector.ts accordingly.

async function run() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MT5Connector } = require("./core/mt5-connector") as typeof import("./core/mt5-connector");
  const connector = new MT5Connector();

  // Optional health check
  try {
    const health = await axios.get(`${BRIDGE}/health`).then(r => r.data).catch(() => null);
    info('Bridge health', health);
  } catch (e) {
    error('Bridge unreachable, ensure mt5-bridge.py is running on RDP and BRIDGE env var is set');
  }

  const strategy = new Strategy(connector);

  // Main loop: run every 30s, but we only act on completed candles (15m).
  setInterval(async () => {
    try {
      await strategy.scanAndAct();
    } catch (err) {
      error('Main loop error', err);
    }
  }, 30_000);

  info('Bot started. Monitoring symbols: GBPUSD, EURUSD, XAUUSD on M15');
}

run().catch(err => {
  error('Fatal', err);
  process.exit(1);
});
