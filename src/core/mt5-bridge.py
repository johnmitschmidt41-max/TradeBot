print("script started")

import MetaTrader5 as mt5
from flask import Flask, request, jsonify
from datetime import datetime, timedelta
from flask_cors import CORS
import sys
import time

app = Flask(__name__)
CORS(app)

ACCOUNT = 81531507
PASSWORD = "underSTOOD224#"
SERVER = "Exness-MT5Trial10"
MT5_PATH = r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"

mt5_initialized = False


def init_mt5():
    global mt5_initialized

    print("Initializing MT5…")

    if not mt5.initialize(MT5_PATH):
        print("❌ MT5 initialize() FAILED:", mt5.last_error())
        return False

    authorized = mt5.login(ACCOUNT, password=PASSWORD, server=SERVER)

    if not authorized:
        print("❌ MT5 login FAILED:", mt5.last_error())
        return False

    print("✅ MT5 connected:", mt5.account_info())
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
    return jsonify({
        "status": "connected" if mt5_initialized else "disconnected",
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


if __name__ == "__main__":
    print("Starting MT5 Bridge on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000)