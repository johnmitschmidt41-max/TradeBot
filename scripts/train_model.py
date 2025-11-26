#!/usr/bin/env python3
"""
Simple trainer for trade_signals.jsonl.
Usage:
  python scripts/train_model.py --input data/output/trade_signals.jsonl --output model.pkl

This script is intentionally minimal: it builds a tabular dataset from appended JSONL signals, extracts a few features,
and trains a RandomForest classifier to predict losing trades (profit <= 0).
"""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd

from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
import joblib


def load_jsonl(path: Path):
    items = []
    with path.open('r', encoding='utf8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except Exception:
                continue
    return items


def make_dataframe(items):
    # Only include signals that have a result (closed trades)
    rows = []
    for it in items:
        res = it.get('result')
        if not res or 'profit' not in res:
            continue
        row = {
            'symbol': it.get('symbol'),
            'side': it.get('side'),
            'orderType': it.get('orderType'),
            'slPips': float(it.get('slPips') or 0),
            'tpPips': float(it.get('tpPips') or 0),
            'fvgDistancePips': float(it.get('fvgDistancePips') or 0),
            'accountBalance': float(it.get('accountBalance') or 0),
            'lots': float(it.get('lots') or 0),
            'profit': float(res.get('profit') or 0),
        }
        rows.append(row)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    # binary label: 1 if loss (profit <= 0), 0 otherwise
    df['label'] = (df['profit'] <= 0).astype(int)
    return df


def featurize(df: pd.DataFrame):
    # Basic processing: encode symbol and side/orderType one-hot, scale balance
    X = df[['slPips', 'tpPips', 'fvgDistancePips', 'accountBalance', 'lots']].copy()
    # normalize balance
    X['accountBalance'] = X['accountBalance'] / (X['accountBalance'].median() + 1e-9)
    # one-hot
    X = pd.concat([X, pd.get_dummies(df['symbol'], prefix='sym')], axis=1)
    X = pd.concat([X, pd.get_dummies(df['side'], prefix='side')], axis=1)
    X = pd.concat([X, pd.get_dummies(df['orderType'], prefix='ord')], axis=1)
    return X


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='data/output/trade_signals.jsonl')
    parser.add_argument('--output', default='data/output/model.pkl')
    parser.add_argument('--test-size', type=float, default=0.2)
    args = parser.parse_args()

    p = Path(args.input)
    if not p.exists():
        print('Input file not found:', p)
        return

    items = load_jsonl(p)
    df = make_dataframe(items)
    if df.empty:
        print('No completed trades with result found in file. Need labeled data.')
        return

    X = featurize(df)
    y = df['label']

    n_samples = len(X)
    class_counts = y.value_counts()

    # Guard: need at least two samples and at least two classes to build a classifier
    if n_samples < 2:
        print(f'Not enough labeled samples to train (found {n_samples}). Need at least 2 labeled trades with outcome).')
        return

    if len(class_counts) < 2:
        print(f'Need at least 2 label classes for training (found only {list(class_counts.index)}).')
        return

    # If dataset is tiny (e.g., 2 samples), avoid train_test_split creating empty sets.
    # For very small datasets we'll train on all available data (no separate test set).
    if n_samples < 3:
        print(f'Warning: small dataset (n={n_samples}), training on full set without a test split.')
        X_train, X_test, y_train, y_test = X, X, y, y
    else:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=args.test_size, random_state=42)

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print('Classification report:')
    print(classification_report(y_test, preds))
    print('Confusion matrix:')
    print(confusion_matrix(y_test, preds))

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out)
    # persist feature column list so the scorer can featurize inputs consistently
    features_file = out.parent.joinpath('model_features.json')
    try:
        import json
        cols = X.columns.tolist()
        with features_file.open('w', encoding='utf8') as fh:
            json.dump({'feature_columns': cols}, fh)
        print('Saved feature column list to', features_file)
    except Exception as e:
        print('Failed to save feature columns:', e)
    print('Saved model to', out)


if __name__ == '__main__':
    main()
