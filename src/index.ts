import 'dotenv/config';
import { MT5Connector } from "./core/mt5-connector";
import { SweepFVGStrategy } from "./strategy/sweep-fvg-strategy";
import { info, error } from "./utils/logger";
import axios from "axios";

const BRIDGE = process.env.MT5_BRIDGE || "http://163.5.210.176:5000";

async function run() {
  
  const connector = new MT5Connector();

  try {
    const health = await axios.get(`${BRIDGE}/health`).then(r => r.data).catch(() => null);
    info('STARTUP', 'Bridge health check', health);
  } catch (e) {
    error('STARTUP', 'Bridge unreachable - ensure mt5-bridge.py is running');
  }

  // New SweepFVG Strategy
  const strategy = new SweepFVGStrategy(connector, {
    riskPercent: 5.0,
    maxTradesPerDay: 12,
    maxTradesPerSymbol: 4
  });

  info('STARTUP', 'Bot started - SweepFVG Strategy', {
    symbols: ['GBPUSDz', 'EURUSDz', 'XAUUSDz'],
    sessions: 'London + NY'
  });

  // Run the strategy
  await strategy.run();
}

run().catch(err => {
  error('FATAL', 'Startup error', err);
  process.exit(1);
});
