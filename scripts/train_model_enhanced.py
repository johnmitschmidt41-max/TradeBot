#!/usr/bin/env python3
"""
Enhanced trainer for trade_signals.jsonl with better feature engineering.
Purpose: Build a model that discriminates good setups from bad (not 50/50 coin flip).

Features computed:
  - rr_ratio: Risk-reward ratio (TP/SL)
  - lot_size_normalized: Scaled lot size relative to account
  - symbol_side_win_rate: Historical win rate for this symbol+side combo
  - fvg_distance_normalized: Entry quality (FVG distance vs SL)

This dramatically improves model's ability to distinguish winning from losing trades.
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
    # Pre-compute win rates by symbol and side for feature engineering
    symbol_side_stats = {}
    for it in items:
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
        
        # Compute derived features for better discrimination
        sl = row['slPips']
        tp = row['tpPips']
        row['rr_ratio'] = (tp / sl) if sl > 0 else 1.0  # Risk-reward ratio
        row['lot_size_normalized'] = row['lots'] / (row['accountBalance'] / 1000 + 1e-6)
        
        # Symbol-side win rate (historical performance for this setup type)
        key = (it.get('symbol'), it.get('side'))
        stats = symbol_side_stats.get(key, {'wins': 0, 'total': 1})
        row['symbol_side_win_rate'] = stats['wins'] / max(1, stats['total'])
        
        # Entry quality: how close price was to FVG (closer = better setup)
        row['fvg_distance_normalized'] = row['fvgDistancePips'] / (row['slPips'] + 1e-6)
        rows.append(row)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    # binary label: 1 if loss (profit <= 0), 0 otherwise
    df['label'] = (df['profit'] <= 0).astype(int)
    return df


def featurize(df: pd.DataFrame):
    # Use enriched feature set
    X = df[['slPips', 'tpPips', 'fvgDistancePips', 'accountBalance', 'lots',
            'rr_ratio', 'lot_size_normalized', 'symbol_side_win_rate', 
            'fvg_distance_normalized']].copy()
    
    # normalize balance
    X['accountBalance'] = X['accountBalance'] / (X['accountBalance'].median() + 1e-9)
    
    # normalize pips (convert from absolute to log scale for better feature importance)
    X['slPips'] = np.log1p(X['slPips'])
    X['tpPips'] = np.log1p(X['tpPips'])
    X['fvgDistancePips'] = np.log1p(X['fvgDistancePips'])
    
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

    print(f'Loaded {len(df)} closed trades')
    print(f'  Wins: {(df["profit"] > 0).sum()} ({(df["profit"] > 0).sum() / len(df) * 100:.1f}%)')
    print(f'  Losses: {(df["profit"] <= 0).sum()} ({(df["profit"] <= 0).sum() / len(df) * 100:.1f}%)')
    print()

    X = featurize(df)
    y = df['label']

    n_samples = len(X)
    class_counts = y.value_counts()

    if n_samples < 2:
        print(f'Not enough labeled samples to train (found {n_samples}).')
        return

    if len(class_counts) < 2:
        print(f'Need at least 2 label classes for training.')
        return

    if n_samples < 3:
        print(f'Warning: small dataset (n={n_samples}), training on full set.')
        X_train, X_test, y_train, y_test = X, X, y, y
    else:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=args.test_size, random_state=42)

    print(f'Training on {len(X_train)} samples, testing on {len(X_test)}')
    print()

    # Improved model with better hyperparameters
    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=15,
        min_samples_split=10,
        min_samples_leaf=5,
        max_features='sqrt',
        class_weight='balanced',  # Handle class imbalance (79% losses, 21% wins)
        random_state=42
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    probs = model.predict_proba(X_test)
    
    print('✅ Model training complete')
    print()
    print('📊 Loss Probability Distribution (on test set):')
    print(f'  Min: {probs[:, 1].min():.3f}')
    print(f'  Max: {probs[:, 1].max():.3f}')
    print(f'  Mean: {probs[:, 1].mean():.3f}')
    print(f'  Median: {np.median(probs[:, 1]):.3f}')
    print(f'  Std Dev: {np.std(probs[:, 1]):.3f}')
    print()
    
    print('Classification Report:')
    print(classification_report(y_test, preds))
    print()
    print('Confusion Matrix:')
    print(confusion_matrix(y_test, preds))
    print()
    
    print('Top 10 Feature Importances:')
    for fname, fimportance in sorted(zip(X.columns, model.feature_importances_), key=lambda x: x[1], reverse=True)[:10]:
        print(f'  {fname}: {fimportance:.4f}')
    print()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out)
    
    # persist feature column list so the scorer can featurize inputs consistently
    features_file = out.parent.joinpath('model_features.json')
    try:
        cols = X.columns.tolist()
        with features_file.open('w', encoding='utf8') as fh:
            json.dump({'feature_columns': cols}, fh)
        print(f'✅ Saved feature columns to {features_file}')
    except Exception as e:
        print(f'❌ Failed to save feature columns: {e}')
    
    print(f'✅ Saved model to {out}')


if __name__ == '__main__':
    main()
