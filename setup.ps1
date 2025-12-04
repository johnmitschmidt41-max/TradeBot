# Setup script for TradeBot Logs Dashboard (Windows)

Write-Host "🚀 TradeBot Logs Dashboard Setup" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
try {
    $nodeVersion = node -v
    Write-Host "✓ Node.js $nodeVersion detected" -ForegroundColor Green
    $npmVersion = npm -v
    Write-Host "✓ npm $npmVersion detected" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js is not installed. Please install Node.js 16+ first." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
Write-Host ""

Write-Host "📁 Frontend dependencies..." -ForegroundColor Yellow
npm install

Write-Host ""
Write-Host "📁 Server dependencies..." -ForegroundColor Yellow
cd server
npm install
cd ..

Write-Host ""
Write-Host "✅ Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "📊 Next steps:" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""
Write-Host "1️⃣  Start the backend server (PowerShell 1):" -ForegroundColor Yellow
Write-Host "   cd frontend\server; npm start" -ForegroundColor White
Write-Host ""
Write-Host "2️⃣  Start the frontend (PowerShell 2):" -ForegroundColor Yellow
Write-Host "   cd frontend; npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "3️⃣  Open your browser:" -ForegroundColor Yellow
Write-Host "   http://localhost:5173" -ForegroundColor White
Write-Host ""
Write-Host "4️⃣  Send test logs:" -ForegroundColor Yellow
Write-Host "   curl -X POST http://localhost:3001/api/demo/mainbot" -ForegroundColor White
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
