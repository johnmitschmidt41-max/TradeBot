#!/usr/bin/env python3
"""
Simple scoring server for the trained model (model.pkl produced by scripts/train_model.py).
Accepts a POST /score with a JSON object matching the signal shape and returns { lossProb: float }.

Usage: python scripts/scorer_server.py --model data/output/model.pkl --port 5000
"""
import argparse
import joblib
import json
from flask import Flask, request, jsonify
import numpy as np
import pandas as pd

app = Flask('scorer')

model = None

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

    for key in ['sym_GBPUSDz', 'sym_EURUSDz', 'sym_XAUUSDz']:
        df[key] = 1 if key.replace('sym_', '') == sym else 0

    for key in ['side_BUY', 'side_SELL']:
        df[key] = 1 if key.replace('side_', '') == side else 0

    for key in ['ord_MARKET', 'ord_LIMIT']:
        df[key] = 1 if key.replace('ord_', '') == ordt else 0

    return df


@app.route('/score', methods=['POST'])
def score():
    global model
    if model is None:
        return jsonify({'error': 'model not loaded'}), 500

    payload = request.get_json() or {}
    try:
        X = featurize_single(payload)
        # ensure feature ordering matches training script (this is a simple heuristic)
        probs = model.predict_proba(X)
        loss_prob = float(probs[0][1]) if probs.shape[1] > 1 else float(probs[0][0])
        return jsonify({'lossProb': loss_prob})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='data/output/model.pkl')
    parser.add_argument('--port', type=int, default=5000)
    args = parser.parse_args()

    global model
    model = joblib.load(args.model)
    print('Model loaded from', args.model)
    app.run(host='0.0.0.0', port=args.port)


if __name__ == '__main__':
    main()
