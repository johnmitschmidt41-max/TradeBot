// Test script to trigger toast notifications
// Run with: node test-toast.js

const events = [
  {
    delay: 1000,
    log: {
      timestamp: new Date().toISOString(),
      level: 'ORDER',
      message: 'EURUSDz BUY Pending limit placed',
      data: { symbol: 'EURUSDz', side: 'BUY', entry: '1.04850', sl: '1.04650', tp: '1.05250' }
    }
  },
  {
    delay: 4000,
    log: {
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      message: 'EURUSDz BUY MARKET order opened',
      data: { symbol: 'EURUSDz', side: 'BUY', entry: '1.04855', ticket: 12345 }
    }
  },
  {
    delay: 7000,
    log: {
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      message: 'EURUSDz trade closed TP hit',
      data: { symbol: 'EURUSDz', pips: 25.5, profit: 127.50 }
    }
  },
  {
    delay: 10000,
    log: {
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      message: 'GBPUSDz SELL MARKET order opened',
      data: { symbol: 'GBPUSDz', side: 'SELL', entry: '1.27450', ticket: 12346 }
    }
  },
  {
    delay: 13000,
    log: {
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      message: 'GBPUSDz trade closed SL hit',
      data: { symbol: 'GBPUSDz', pips: -15, profit: -75.00 }
    }
  }
];

// Send to SSE endpoint
const http = require('http');

console.log('🧪 Toast Test Script');
console.log('====================');
console.log('This will send test events to trigger toast notifications.');
console.log('Make sure your frontend is running and connected.\n');

events.forEach(({ delay, log }) => {
  setTimeout(() => {
    const data = JSON.stringify(log);
    console.log(`📤 Sending: ${log.level} - ${log.message}`);
    
    // POST to server to inject into log stream
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/test-log',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      if (res.statusCode === 200) {
        console.log(`✅ Sent successfully`);
      } else {
        console.log(`❌ Failed: ${res.statusCode}`);
      }
    });
    
    req.on('error', (e) => {
      console.log(`❌ Error: ${e.message}`);
      console.log('   Make sure the server has the /api/test-log endpoint');
    });
    
    req.write(data);
    req.end();
  }, delay);
});

console.log('Events scheduled. Waiting...\n');
