#!/usr/bin/env python3
"""
Simple scoring server for the trained model (model.pkl produced by scripts/train_model.py).
Accepts a POST /score with a JSON object matching the signal shape and returns { lossProb: float }.

Usage: python scripts/scorer_server.py --model data/output/model.pkl --port 5000
"""
import argparse
import joblib
import json
from pathlib import Path
from flask import Flask, request, jsonify
import numpy as np
import pandas as pd

app = Flask('scorer')

model = None
# feature columns saved by the trainer (used to conform incoming inputs to model expectations)
feature_columns = None

def featurize_single(signal: dict):
    # match features used by train_model.py
    sl = float(signal.get('slPips', 0) or 0)
    tp = float(signal.get('tpPips', 0) or 0)
    fvg = float(signal.get('fvgDistancePips', 0) or 0)
    balance = float(signal.get('accountBalance', 0) or 0)
    lots = float(signal.get('lots', 0) or 0)

    df = pd.DataFrame([{ 'slPips': sl, 'tpPips': tp, 'fvgDistancePips': fvg, 'accountBalance': balance, 'lots': lots }])
    df['accountBalance'] = df['accountBalance'] / (df['accountBalance'].median() + 1e-9)

    # one-hot for a few common fields
    sym = signal.get('symbol') or ''
    side = signal.get('side') or ''
    ordt = signal.get('orderType') or ''

    # include a realistic superset of expected symbol columns (trainer may have seen more)
    for key in ['sym_GBPUSDz', 'sym_EURUSDz', 'sym_XAUUSDz', 'sym_US30_x10z', 'sym_USTECz', 'sym_']:
        df[key] = 1 if key.replace('sym_', '') == sym else 0

    for key in ['side_BUY', 'side_SELL']:
        df[key] = 1 if key.replace('side_', '') == side else 0

    for key in ['ord_MARKET', 'ord_LIMIT']:
        df[key] = 1 if key.replace('ord_', '') == ordt else 0

    return df


@app.route('/score', methods=['POST'])
def score():
    global model, feature_columns
    if model is None:
        return jsonify({'error': 'model not loaded'}), 500

    payload = request.get_json() or {}
    try:
        X = featurize_single(payload)
        # If the server didn't load feature metadata at startup, try again
        # (this helps when you retrain without restarting the scorer server).
        if feature_columns is None:
            try:
                features_path = Path(__file__).parent.parent.joinpath('data', 'output', 'model_features.json')
                if features_path.exists():
                    with features_path.open('r', encoding='utf8') as fh:
                        obj = json.load(fh)
                        cols = obj.get('feature_columns')
                        if isinstance(cols, list) and cols:
                            feature_columns = cols
                            print('Loaded feature_columns at runtime (len=%d)' % len(cols))
            except Exception as e:
                print('Runtime feature metadata load failed:', e)
        # If the trainer saved an explicit column list, ensure we supply the exact
        # set and column ordering the model expects. For any missing column, add
        # it as zeros.
        if feature_columns is not None:
            for c in feature_columns:
                if c not in X.columns:
                    X[c] = 0
            X = X.reindex(columns=feature_columns)
            # debug: log if we had to fill any columns
            missing = [c for c in feature_columns if c not in X.columns]
            if missing:
                print('Added missing columns to X at runtime:', missing)

        # now call the model
        probs = model.predict_proba(X)
        loss_prob = float(probs[0][1]) if probs.shape[1] > 1 else float(probs[0][0])
        return jsonify({'lossProb': loss_prob})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='data/output/model.pkl')
    parser.add_argument('--port', type=int, default=5100)
    args = parser.parse_args()

    global model
    model = joblib.load(args.model)
    # attempt to load feature metadata next to the model file
    try:
        features_path = Path(args.model).parent.joinpath('model_features.json')
        if features_path.exists():
            with features_path.open('r', encoding='utf8') as fh:
                obj = json.load(fh)
                cols = obj.get('feature_columns')
                if isinstance(cols, list) and cols:
                    global feature_columns
                    feature_columns = cols
                    print('Loaded feature_columns (len=%d) from' % len(cols), features_path)
                else:
                    print('Invalid feature_columns in', features_path)
        else:
            print('No feature metadata file found at', features_path)
    except Exception as e:
        print('Failed to load feature metadata:', e)
    print('Model loaded from', args.model)
    app.run(host='0.0.0.0', port=args.port)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model_loaded': bool(model)}), 200


if __name__ == '__main__':
    main()
