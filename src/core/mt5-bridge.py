print("script started")

# -- Redirect stdout/stderr to dashboard logger (MUST be first!) --
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from dashboard_logger import setup_dashboard_logging
setup_dashboard_logging('python-bridge')

import MetaTrader5 as mt5
from flask import Flask, request, jsonify
from datetime import datetime, timedelta
from flask_cors import CORS
import time
import json
import threading

# -- optional dashboard logging helper (non-blocking, best-effort) --
LOG_SERVER_URL = os.environ.get('LOG_SERVER_URL', 'http://localhost:3001')

def _send_log(payload):
    try:
        # try requests if available
        import requests
        requests.post(f"{LOG_SERVER_URL}/api/log", json=payload, timeout=0.5)
        return
    except Exception:
        pass

    try:
        # fallback to urllib
        from urllib import request as _ur
        import json as _json
        _r = _ur.Request(f"{LOG_SERVER_URL}/api/log", data=_json.dumps(payload).encode('utf8'), headers={'Content-Type': 'application/json'})
        _ur.urlopen(_r, timeout=0.5)
    except Exception:
        pass

def log_dashboard(message, level='info'):
    payload = {'service': 'python-bridge', 'message': str(message), 'level': level}
    # fire-and-forget
    try:
        import threading as _threading
        _threading.Thread(target=_send_log, args=(payload,), daemon=True).start()
    except Exception:
        _send_log(payload)

app = Flask(__name__)
CORS(app)

# Load configuration
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

def load_config():
    """Load account configuration from config.json"""
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ Config file not found at {CONFIG_PATH}")
        return None
    
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ Failed to load config: {e}")
        return None

def get_current_mode():
    """Get current trading mode from trading_mode.json"""
    mode_file = os.path.join(os.path.dirname(__file__), "..", "..", "data", "config", "trading_mode.json")
    if os.path.exists(mode_file):
        try:
            with open(mode_file, 'r') as f:
                mode_data = json.load(f)
                return mode_data.get("mode", "DEMO")
        except Exception:
            return "DEMO"
    return "DEMO"

config = load_config()
if not config:
    print("❌ Failed to load configuration, exiting")
    sys.exit(1)

# Get current mode
CURRENT_MODE = get_current_mode()
print(f"📋 Current trading mode: {CURRENT_MODE}")
log_dashboard(f"Current trading mode: {CURRENT_MODE}")

# Load account info based on current mode
account_config = config["accounts"].get(CURRENT_MODE)
if not account_config:
    print(f"❌ Account configuration not found for mode: {CURRENT_MODE}")
    sys.exit(1)

ACCOUNT = account_config["accountNumber"]
PASSWORD = account_config["password"]
SERVER = account_config["server"]
MT5_PATH = config.get("mt5Path", r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe")

print(f"🔐 Logging in to {CURRENT_MODE} account: {ACCOUNT} @ {SERVER}")
log_dashboard(f"Logging in to {CURRENT_MODE} account: {ACCOUNT} @ {SERVER}")

mt5_initialized = False
last_known_mode = CURRENT_MODE  # Track mode changes


def check_mode_change():
    """Check if trading mode has changed and reconnect if needed"""
    global CURRENT_MODE, ACCOUNT, PASSWORD, SERVER, last_known_mode, mt5_initialized
    
    new_mode = get_current_mode()
    if new_mode != last_known_mode:
        print(f"\n{'='*60}")
        print(f"🔄 MODE CHANGE DETECTED: {last_known_mode} → {new_mode}")
        print(f"{'='*60}")
        last_known_mode = new_mode
        
        # Reload account config for new mode
        account_config = config["accounts"].get(new_mode)
        if not account_config:
            print(f"❌ Account config not found for {new_mode}")
            return False
        
        CURRENT_MODE = new_mode
        ACCOUNT = account_config["accountNumber"]
        PASSWORD = account_config["password"]
        SERVER = account_config["server"]
        
        print(f"📋 Current trading mode: {CURRENT_MODE}")
        print(f"🔐 Logging in to {CURRENT_MODE} account: {ACCOUNT} @ {SERVER}")
        
        # Disconnect and reconnect
        if mt5_initialized:
            try:
                mt5.shutdown()
                mt5_initialized = False
                print("✅ Disconnected from previous account")
                time.sleep(1)
            except Exception as e:
                print(f"⚠️  Error disconnecting: {e}")
        
        # Reconnect to new account
        if init_mt5():
            print(f"✅ Connected to {CURRENT_MODE} account: {ACCOUNT}")
            print(f"{'='*60}\n")
            return True
        else:
            print(f"❌ Failed to connect to {CURRENT_MODE} account")
            print(f"{'='*60}\n")
            return False
    
    return True


def init_mt5():
    global mt5_initialized

    print("Initializing MT5…")
    log_dashboard("Initializing MT5…")

    if not mt5.initialize(MT5_PATH):
        err = mt5.last_error()
        print("❌ MT5 initialize() FAILED:", err)
        log_dashboard(f"MT5 initialize FAILED: {err}", level='error')
        return False

    authorized = mt5.login(ACCOUNT, password=PASSWORD, server=SERVER)

    if not authorized:
        err = mt5.last_error()
        print("❌ MT5 login FAILED:", err)
        log_dashboard(f"MT5 login FAILED: {err}", level='error')
        return False

    acc_info = mt5.account_info()
    print("✅ MT5 connected:", acc_info)
    log_dashboard(f"MT5 connected: {acc_info}")
    mt5_initialized = True
    return True


# AUTO-START MT5 CONNECTION
print("Attempting MT5 connection…")
for i in range(5):
    if init_mt5():
        break
    print("Retrying in 3 seconds…")
    time.sleep(3)


@app.route('/health', methods=['GET'])
def health():
    # Check for mode changes on every health check
    check_mode_change()
    
    return jsonify({
        "status": "connected" if mt5_initialized else "disconnected",
        "trading_mode": CURRENT_MODE,
        "account": ACCOUNT,
        "server": SERVER,
        "terminal_info": mt5.terminal_info()._asdict() if mt5_initialized else None
    })


@app.route('/candles', methods=['POST'])
def candles():
    if not mt5_initialized:
        return jsonify({"error": "MT5 not connected"}), 500

    data = request.json
    symbol = data.get("symbol")
    timeframe = data.get("timeframe", "M15")
    count = data.get("count", 200)

    print(f"📊 Candle request: {symbol} | {timeframe} | {count} bars")

    tf_map = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }

    tf = tf_map.get(timeframe, mt5.TIMEFRAME_M15)

    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)

    if rates is None:
        error = mt5.last_error()
        print(f"❌ Failed to fetch {symbol}: {error}")
        return jsonify({
            "error": f"Failed to fetch candles for {symbol}",
            "mt5_error": error
        }), 500

    print(f"✅ Fetched {len(rates)} candles for {symbol}")

    candles = []
    for r in rates:
        candles.append({
            "time": int(r['time']),
            "open": float(r['open']),
            "high": float(r['high']),
            "low": float(r['low']),
            "close": float(r['close']),
            "volume": int(r['tick_volume'])
        })

    return jsonify({"candles": candles})


@app.route('/positions', methods=['GET'])
def get_positions():
    """Get open positions"""
    if not mt5_initialized:
        return jsonify({"positions": []})
    
    symbol = request.args.get('symbol')
    
    try:
        if symbol:
            positions = mt5.positions_get(symbol=symbol)
        else:
            positions = mt5.positions_get()
        
        if positions is None:
            print(f"⚠️ No positions returned for {symbol if symbol else 'all symbols'}")
            return jsonify({"positions": []})
        
        pos_list = []
        for pos in positions:
            pos_list.append({
                "ticket": pos.ticket,
                "symbol": pos.symbol,
                "type": "BUY" if pos.type == 0 else "SELL",
                "volume": pos.volume,
                "price_open": pos.price_open,
                "sl": pos.sl,
                "tp": pos.tp,
                "profit": pos.profit
            })
        
        return jsonify({"positions": pos_list})
    
    except Exception as e:
        print(f"❌ Error fetching positions for {symbol}: {e}")
        return jsonify({"positions": []}), 500

@app.route('/orders', methods=['GET'])
def get_orders():
    """Get pending orders"""
    if not mt5_initialized:
        return jsonify({"orders": []})
    
    symbol = request.args.get('symbol')
    
    try:
        if symbol:
            orders = mt5.orders_get(symbol=symbol)
        else:
            orders = mt5.orders_get()
        
        if orders is None:
            print(f"⚠️ No orders returned for {symbol if symbol else 'all symbols'}")
            return jsonify({"orders": []})
        
        order_list = []
        for order in orders:
            order_list.append({
                "ticket": order.ticket,
                "symbol": order.symbol,
                "type": "BUY" if order.type in [mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP] else "SELL",
                "volume": order.volume_initial,  # ← FIXED
                "price_open": order.price_open,
                "sl": order.sl,
                "tp": order.tp,
                "comment": getattr(order, 'comment', None)
            })
        
        return jsonify({"orders": order_list})
    
    except Exception as e:
        print(f"❌ Error fetching orders for {symbol}: {e}")
        return jsonify({"orders": []}), 500

@app.route('/account', methods=['GET'])
def account():
    if not mt5_initialized:
        return jsonify({"account": None}), 200
    
    info = mt5.account_info()
    return jsonify({"account": info._asdict()})



@app.route('/order', methods=['POST'])
def order():
    if not mt5_initialized:
        return jsonify({"error": "MT5 not connected"}), 500

    data = request.json
    symbol = data['symbol']
    order_type = data['type']
    volume = float(data['volume'])
    price = data.get('price', 0)
    sl = float(data['sl'])
    tp = float(data['tp'])

    if price == 0:
        type_map = {
            "BUY": mt5.ORDER_TYPE_BUY,
            "SELL": mt5.ORDER_TYPE_SELL
        }
        action = mt5.TRADE_ACTION_DEAL
    else:
        type_map = {
            "BUY": mt5.ORDER_TYPE_BUY_LIMIT,
            "SELL": mt5.ORDER_TYPE_SELL_LIMIT
        }
        action = mt5.TRADE_ACTION_PENDING

    request_data = {
        "action": action,
        "symbol": symbol,
        "volume": volume,
        "type": type_map[order_type],
        "sl": sl,
        "tp": tp,
        "magic": 889900,
        # allow caller to inject a comment (we use this for client-side CID matching)
        "comment": data.get('comment', 'mainbot'),
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    
    if price > 0:
        request_data["price"] = price

    result = mt5.order_send(request_data)

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            "error": "Order failed",
            "retcode": result.retcode,
            "comment": result.comment
        }), 400

    return jsonify({
        "success": True,
        "order": result.order,
        "deal": result.deal
    })


@app.route('/deals', methods=['GET'])
def get_deals():
    """Fetch history deals. Optional query parameter `since` as epoch seconds to fetch long-running history since that time."""
    if not mt5_initialized:
        return jsonify({"deals": []})

    since = request.args.get('since', default=None, type=int)
    try:
        if since:
            from_time = datetime.fromtimestamp(since)
        else:
            # default to a recent window to avoid requesting the entire history
            # (fetch last 30 days). Asking for everything (from epoch) can crash
            # the native MT5 API in some environments / versions.
            from_time = datetime.now() - timedelta(days=30)

        to_time = datetime.now()
        try:
            deals = mt5.history_deals_get(from_time, to_time)
        except Exception as e:
            # history_deals_get sometimes raises low-level exceptions in the
            # MetaTrader5 native binding (e.g. if the time range is too large).
            # Log the error from mt5 and return an empty list to callers.
            mt5_err = None
            try:
                mt5_err = mt5.last_error()
            except Exception:
                mt5_err = None

            print('❌ history_deals_get exception:', e, 'mt5.last_error():', mt5_err)
            return jsonify({"deals": []}), 500

        if deals is None:
            return jsonify({"deals": []})

        deal_list = []
        for d in deals:
            deal_list.append({
                "deal": getattr(d, 'deal', None),
                "order": getattr(d, 'order', None),
                "symbol": getattr(d, 'symbol', None),
                "time": int(getattr(d, 'time', 0)),
                "price": float(getattr(d, 'price', 0.0)),
                "volume": float(getattr(d, 'volume', 0.0)),
                "profit": float(getattr(d, 'profit', 0.0)),
                "type": getattr(d, 'type', None),
                "comment": getattr(d, 'comment', None),
                "magic": getattr(d, 'magic', None)
            })

        return jsonify({"deals": deal_list})

    except Exception as e:
        print('❌ Error fetching deals:', e)
        return jsonify({"deals": []}), 500


@app.route('/tick', methods=['GET'])
def get_tick():
        """Return current tick (bid/ask/spread) for a symbol (query param `symbol`)."""
        if not mt5_initialized:
            return jsonify({"error": "MT5 not connected"}), 500

        symbol = request.args.get('symbol')
        if not symbol:
            return jsonify({"error": "symbol required"}), 400

        try:
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                return jsonify({"error": f"no tick for {symbol}"}), 404

            bid = float(tick.bid)
            ask = float(tick.ask)
            spread = ask - bid
            return jsonify({"symbol": symbol, "bid": bid, "ask": ask, "spread": spread})
        except Exception as e:
            print(f"❌ Failed to fetch tick for {symbol}: {e}")
            return jsonify({"error": str(e)}), 500


def background_mode_checker():
    """Background thread that checks for mode changes every 5 seconds"""
    global last_known_mode
    check_count = 0
    while True:
        try:
            time.sleep(5)
            check_count += 1
            
            new_mode = get_current_mode()
            # Always call check_mode_change to let it handle the comparison
            check_mode_change()
            
            # Log every 60 checks (5 minutes) to show it's alive, reset counter
            if check_count >= 60:
                print(f"✅ Mode check: {CURRENT_MODE} account {ACCOUNT} @ {SERVER}")
                check_count = 0
        except Exception as e:
            print(f"⚠️  Mode checker error: {e}")


if __name__ == "__main__":
    print("Starting MT5 Bridge on http://localhost:5000")
    
    # Start background mode checker thread
    mode_checker_thread = threading.Thread(target=background_mode_checker, daemon=True)
    mode_checker_thread.start()
    print("✅ Background mode checker started")
    app.run(host="0.0.0.0", port=5000)