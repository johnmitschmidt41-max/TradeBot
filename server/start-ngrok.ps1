param(
  [int]$frontendPort = 5173,
  [int]$backendPort = 3001
)

# Simple wrapper to call the Node helper script
Write-Host "Starting ngrok tunnels for frontend:$frontendPort and backend:$backendPort" -ForegroundColor Cyan

$env:FRONTEND_PORT = $frontendPort
$env:BACKEND_PORT = $backendPort

# Run the start-ngrok.js script (uses ngrok npm package). Keep console open.
npm run tunnel

Write-Host "ngrok has exited (tunnels closed)." -ForegroundColor Yellow
