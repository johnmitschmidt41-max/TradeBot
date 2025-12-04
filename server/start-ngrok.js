import ngrok from 'ngrok';

// Usage: node start-ngrok.js [frontendPort] [backendPort]
// Example: node start-ngrok.js 5174 3001

const argv = process.argv.slice(2);
const frontendPort = argv[0] ? Number(argv[0]) : Number(process.env.FRONTEND_PORT) || 5173;
const backendPort = argv[1] ? Number(argv[1]) : Number(process.env.BACKEND_PORT) || 3001;

(async () => {
  try {
    console.log(`Opening ngrok tunnels (frontend:${frontendPort}, backend:${backendPort})`);

    const connectOpts = { addr: frontendPort, proto: 'http' };
    // Use NGROK_AUTHTOKEN environment variable if provided
    if (process.env.NGROK_AUTHTOKEN) connectOpts.authtoken = process.env.NGROK_AUTHTOKEN;
    const frontendUrl = await ngrok.connect(connectOpts);
    console.log(`Frontend public URL: ${frontendUrl}`);

    const backendOpts = { addr: backendPort, proto: 'http' };
    if (process.env.NGROK_AUTHTOKEN) backendOpts.authtoken = process.env.NGROK_AUTHTOKEN;
    const backendUrl = await ngrok.connect(backendOpts);
    console.log(`Backend public URL:  ${backendUrl}`);

    console.log('Tunnels established. Press Ctrl+C to quit and close tunnels.');
  } catch (err) {
    console.error('Failed to start ngrok tunnels. Full error:');
    // Print full error to help debugging
    if (err && err.stack) {
      console.error(err.stack);
    } else {
      console.error(JSON.stringify(err, null, 2));
    }

    // Helpful next steps
    console.error('\nCommon causes:');
    console.error(' - ngrok CLI not installed or your ngrok account requires an auth token.');
    console.error(' - Your local network blocked ngrok or outbound connections.');
    console.error('\nTry these steps:');
    console.error(' 1) Install/authorize ngrok (CLI): https://ngrok.com/download');
    console.error(" 2) Set NGROK_AUTHTOKEN env variable if you have a token (Windows: $env:NGROK_AUTHTOKEN='YOUR_TOKEN')");
    console.error(' 3) As an alternative, run the ngrok CLI manually: ngrok http <port>');
    // Try a CLI fallback if ngrok binary is available in PATH.
    const { exec, spawn } = await import('child_process');

    function ngrokCliAvailable() {
      return new Promise((resolve) => {
        exec('ngrok version', (e, stdout, stderr) => {
          resolve(!e);
        });
      });
    }

    const hasCli = await ngrokCliAvailable();
    if (hasCli) {
      console.error('\nngrok CLI found — attempting CLI fallback.');
      console.error('If CLI needs auth, run: ngrok authtoken <YOUR_TOKEN>');

      // Spawn frontend tunnel
      const fProc = spawn('ngrok', ['http', String(frontendPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
      fProc.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[ngrok-frontend] ${text}`);
        // Look for the forwarded URL
        if (text.includes('Forwarding') || text.includes('https://')) {
          const match = text.match(/https?:\/\/[^\s]+/);
          if (match) console.log('Frontend public URL (detected):', match[0]);
        }
      });
      fProc.stderr.on('data', (d) => process.stderr.write(`[ngrok-frontend-err] ${d.toString()}`));

      // Spawn backend tunnel
      const bProc = spawn('ngrok', ['http', String(backendPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
      bProc.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[ngrok-backend] ${text}`);
        if (text.includes('Forwarding') || text.includes('https://')) {
          const match = text.match(/https?:\/\/[^\s]+/);
          if (match) console.log('Backend public URL (detected):', match[0]);
        }
      });
      bProc.stderr.on('data', (d) => process.stderr.write(`[ngrok-backend-err] ${d.toString()}`));

      console.log('\nCLI tunnels started — watch stdout for `Forwarding` lines and open the https URL.');
      return;
    }

    // no CLI — exit with error
    process.exit(1);
  }
})();
