#!/usr/bin/env python3
"""
Scoring server with losers-detector model auto-reload.
Loads model_losers_detector.pkl and reloads it on each request to pick up retraining updates.
Returns high lossProb (close to 1.0) for BAD patterns that lose money.
"""
import argparse
import joblib
import json
from pathlib import Path
from flask import Flask, request, jsonify
import numpy as np
import pandas as pd
import os

app = Flask('scorer')

model = None
feature_columns = None
model_path = None
last_model_mtime = None

# Symbol-side win rates (computed from all historical data if available)
symbol_side_stats = {}

def load_symbol_stats():
    """Load historical win rates from trade_signals.jsonl to improve feature engineering"""
    global symbol_side_stats
    try:
        signals_file = Path(__file__).parent.parent.joinpath('data', 'output', 'trade_signals.jsonl')
        if signals_file.exists():
            with signals_file.open() as f:
                for line in f:
                    try:
                        it = json.loads(line.strip())
                        res = it.get('result')
                        if not res or 'profit' not in res:
                            continue
                        sym = it.get('symbol', 'UNKNOWN')
                        side = it.get('side', 'BUY')
                        key = (sym, side)
                        if key not in symbol_side_stats:
                            symbol_side_stats[key] = {'wins': 0, 'total': 0}
                        symbol_side_stats[key]['total'] += 1
                        if float(res.get('profit', 0)) > 0:
                            symbol_side_stats[key]['wins'] += 1
                    except:
                        pass
            print(f'Loaded win rates for {len(symbol_side_stats)} symbol-side combos')
    except Exception as e:
        print(f'Could not load symbol stats: {e}')

def featurize_single(signal: dict):
    """Compute all features expected by the model from a trade signal"""
    # Base features
    sl = float(signal.get('slPips', 0) or 0)
    tp = float(signal.get('tpPips', 0) or 0)
    fvg = float(signal.get('fvgDistancePips', 0) or 0)
    balance = float(signal.get('accountBalance', 0) or 0)
    lots = float(signal.get('lots', 0) or 0)
    sym = signal.get('symbol') or ''
    side = signal.get('side') or ''
    ordt = signal.get('orderType') or ''

    # Create base dataframe
    df = pd.DataFrame([{
        'slPips': sl,
        'tpPips': tp,
        'fvgDistancePips': fvg,
        'accountBalance': balance,
        'lots': lots
    }])

    # Normalize account balance
    df['accountBalance'] = df['accountBalance'] / (df['accountBalance'].median() + 1e-9)

    # Apply log scaling to pips
    df['slPips'] = np.log1p(df['slPips'])
    df['tpPips'] = np.log1p(df['tpPips'])
    df['fvgDistancePips'] = np.log1p(df['fvgDistancePips'])

    # Compute derived features
    rr_ratio = (tp / sl) if sl > 0 else 1.0
    lot_size_normalized = lots / (balance / 1000 + 1e-6)
    
    key = (sym, side)
    stats = symbol_side_stats.get(key, {'wins': 0, 'total': 1})
    symbol_side_win_rate = stats['wins'] / max(1, stats['total'])
    
    # Use original (non-log) SL for normalization
    fvg_distance_normalized = fvg / (sl + 1e-6) if sl > 0 else 0
    
    # Add derived features
    df['rr_ratio'] = rr_ratio
    df['lot_size_normalized'] = lot_size_normalized
    df['symbol_side_win_rate'] = symbol_side_win_rate
    df['fvg_distance_normalized'] = fvg_distance_normalized

    # One-hot encode categorical features
    for key_name in ['sym_GBPUSDz', 'sym_EURUSDz', 'sym_XAUUSDz', 'sym_US30_x10z', 'sym_USTECz', 'sym_USDJPYz', 'sym_']:
        df[key_name] = 1 if key_name.replace('sym_', '') == sym else 0

    for key_name in ['side_BUY', 'side_SELL']:
        df[key_name] = 1 if key_name.replace('side_', '') == side else 0

    for key_name in ['ord_MARKET', 'ord_LIMIT']:
        df[key_name] = 1 if key_name.replace('ord_', '') == ordt else 0

    return df


@app.route('/score', methods=['POST'])
def score():
    global model, feature_columns, model_path, last_model_mtime
    
    # Auto-reload model if it has been updated (picks up retraining changes)
    if model_path and os.path.exists(model_path):
        current_mtime = os.path.getmtime(model_path)
        if last_model_mtime is None or current_mtime > last_model_mtime:
            try:
                model = joblib.load(model_path)
                last_model_mtime = current_mtime
                print(f'Reloaded model from {model_path}')
            except Exception as e:
                print(f'Failed to reload model: {e}')
    
    if model is None:
        return jsonify({'error': 'model not loaded'}), 500

    payload = request.get_json() or {}
    try:
        X = featurize_single(payload)
        
        # Reload feature metadata at runtime if not loaded (helps after retraining)
        if feature_columns is None:
            try:
                features_path = Path(__file__).parent.parent.joinpath('data', 'output', 'model_losers_features.json')
                if features_path.exists():
                    with features_path.open('r', encoding='utf8') as fh:
                        obj = json.load(fh)
                        cols = obj.get('feature_columns')
                        if isinstance(cols, list) and cols:
                            feature_columns = cols
                            print(f'Loaded feature_columns at runtime (len={len(cols)})')
            except Exception as e:
                print(f'Runtime feature metadata load failed: {e}')

        # Reorder/fill features to match model expectations
        if feature_columns is not None:
            for c in feature_columns:
                if c not in X.columns:
                    X[c] = 0
            X = X.reindex(columns=feature_columns)

        # Score with model
        probs = model.predict_proba(X)
        loss_prob = float(probs[0][1]) if probs.shape[1] > 1 else float(probs[0][0])
        return jsonify({'lossProb': loss_prob})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model_loaded': bool(model)}), 200


def main():
    parser = argparse.ArgumentParser()
    # Default to losers-detector model to avoid bad patterns
    parser.add_argument('--model', default='data/output/model_losers_detector.pkl')
    parser.add_argument('--port', type=int, default=5100)
    args = parser.parse_args()

    global model, model_path, last_model_mtime
    model_path = args.model
    model = joblib.load(model_path)
    last_model_mtime = os.path.getmtime(model_path) if os.path.exists(model_path) else None
    
    # Load feature metadata (use losers detector features by default)
    try:
        features_path = Path(model_path).parent.joinpath('model_losers_features.json')
        if features_path.exists():
            with features_path.open('r', encoding='utf8') as fh:
                obj = json.load(fh)
                cols = obj.get('feature_columns')
                if isinstance(cols, list) and cols:
                    global feature_columns
                    feature_columns = cols
                    print(f'Loaded feature_columns (len={len(cols)}) from {features_path}')
    except Exception as e:
        print(f'Failed to load feature metadata: {e}')
    
    # Load historical symbol-side win rates
    load_symbol_stats()
    
    print(f'Model loaded from {args.model}')
    app.run(host='0.0.0.0', port=args.port)


if __name__ == '__main__':
    main()
