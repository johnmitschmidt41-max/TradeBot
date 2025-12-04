#!/bin/bash
# Setup script for TradeBot Logs Dashboard

echo "🚀 TradeBot Logs Dashboard Setup"
echo "=================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    exit 1
fi

echo "✓ Node.js $(node -v) detected"
echo "✓ npm $(npm -v) detected"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
echo ""

echo "📁 Frontend dependencies..."
cd "$(dirname "$0")"
npm install

echo ""
echo "📁 Server dependencies..."
cd server
npm install
cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Next steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1️⃣  Start the backend server (Terminal 1):"
echo "   cd frontend/server && npm start"
echo ""
echo "2️⃣  Start the frontend (Terminal 2):"
echo "   cd frontend && npm run dev"
echo ""
echo "3️⃣  Open your browser:"
echo "   http://localhost:5173"
echo ""
echo "4️⃣  Send test logs:"
echo "   curl -X POST http://localhost:3001/api/demo/mainbot"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
