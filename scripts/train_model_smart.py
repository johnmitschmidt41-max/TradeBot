#!/usr/bin/env python3
"""
Smart trainer: Extract win/loss patterns from existing trades and use them to weight features.
Instead of uniform RandomForest, compute win rates by feature bins and create synthetic
feature importance that reflects actual trade outcomes.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
import joblib


def load_jsonl(path: Path):
    """Load JSONL file."""
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


def make_dataframe_smart(items):
    """
    Build DataFrame with win/loss labels from trade outcomes.
    Extract features that actually correlate with wins.
    """
    rows = []
    wins = 0
    losses = 0
    
    for it in items:
        res = it.get('result')
        if not res or 'profit' not in res:
            continue
        
        profit = float(res.get('profit') or 0)
        is_win = 1 if profit > 0 else 0
        if is_win:
            wins += 1
        else:
            losses += 1
        
        # Extract core features
        symbol = it.get('symbol', '').replace('z', '')
        side = it.get('side', 'BUY')
        order_type = it.get('orderType', 'MARKET')
        
        sl_pips = float(it.get('slPips') or 0)
        tp_pips = float(it.get('tpPips') or 0)
        fvg_dist = float(it.get('fvgDistancePips') or 0)
        balance = float(it.get('accountBalance') or 1000)
        lots = float(it.get('lots') or 0.1)
        
        # Compute derived features that might correlate with wins
        rr_ratio = (tp_pips / sl_pips) if sl_pips > 0 else 1.0
        lot_risk = lots * sl_pips  # Risk exposure
        fvg_quality = 1.0 / (1.0 + fvg_dist / 50.0)  # Closer FVG = better entry
        balance_ratio = (balance / 5000.0)  # Normalized balance
        
        row = {
            'symbol': symbol,
            'side': side,
            'orderType': order_type,
            'slPips': sl_pips,
            'tpPips': tp_pips,
            'fvgDistancePips': fvg_dist,
            'accountBalance': balance,
            'lots': lots,
            'rr_ratio': rr_ratio,
            'lot_risk': lot_risk,
            'fvg_quality': fvg_quality,
            'balance_ratio': balance_ratio,
            'profit': profit,
            'is_win': is_win
        }
        rows.append(row)
    
    df = pd.DataFrame(rows)
    if len(df) == 0:
        return df
    
    print(f'Loaded {len(df)} trades: {wins} wins ({100*wins/len(df):.1f}%), {losses} losses ({100*losses/len(df):.1f}%)')
    
    # Compute win rates by symbol/side/orderType to create bias features
    for col in ['symbol', 'side', 'orderType']:
        if col in df.columns:
            win_rates = df.groupby(col)['is_win'].mean()
            df[f'{col}_win_rate'] = df[col].map(win_rates)
    
    return df


def featurize_smart(df: pd.DataFrame):
    """One-hot encode categorical features and normalize numerics."""
    X = df[[
        'slPips', 'tpPips', 'fvgDistancePips', 'accountBalance', 'lots',
        'rr_ratio', 'lot_risk', 'fvg_quality', 'balance_ratio',
        'symbol_win_rate', 'side_win_rate', 'orderType_win_rate'
    ]].copy()
    
    # One-hot encode
    X = pd.concat([X, pd.get_dummies(df['symbol'], prefix='sym')], axis=1)
    X = pd.concat([X, pd.get_dummies(df['side'], prefix='side')], axis=1)
    X = pd.concat([X, pd.get_dummies(df['orderType'], prefix='ord')], axis=1)
    
    # Fill NaN (e.g., new symbols not seen in training)
    X = X.fillna(0)
    
    # Normalize
    scaler = StandardScaler()
    numeric_cols = X.select_dtypes(include=[np.number]).columns
    X[numeric_cols] = scaler.fit_transform(X[numeric_cols])
    
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
    df = make_dataframe_smart(items)
    if df.empty:
        print('No completed trades found.')
        return

    X = featurize_smart(df)
    y = df['is_win']

    n_samples = len(X)
    print(f'\nTraining on {n_samples} samples with {X.shape[1]} features')

    if n_samples < 2:
        print(f'Not enough samples (need >= 2, got {n_samples})')
        return

    # Train with class weights to handle imbalance
    from sklearn.utils.class_weight import compute_class_weight
    class_weights = compute_class_weight('balanced', classes=np.unique(y), y=y)
    class_weight_dict = {i: w for i, w in enumerate(class_weights)}
    
    print(f'Class weights: {class_weight_dict}')

    X_train = X
    y_train = y
    
    # Train RandomForest with class weighting to balance win/loss learning
    model = RandomForestClassifier(
        n_estimators=150,
        max_depth=12,
        min_samples_split=5,
        min_samples_leaf=2,
        class_weight=class_weight_dict,
        random_state=42
    )
    model.fit(X_train, y_train)

    # Evaluate on training set
    train_acc = model.score(X_train, y_train)
    preds = model.predict(X_train)
    print(f'\nTraining accuracy: {train_acc:.2%}')
    
    from sklearn.metrics import classification_report, confusion_matrix
    print('Classification report:')
    print(classification_report(y_train, preds, target_names=['Loss', 'Win']))
    print('Confusion matrix:')
    print(confusion_matrix(y_train, preds))

    # Save model
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out)
    
    # Save feature column list
    features_file = out.parent.joinpath('model_features.json')
    try:
        cols = X.columns.tolist()
        with features_file.open('w', encoding='utf8') as fh:
            json.dump({'feature_columns': cols}, fh)
        print(f'Saved feature columns ({len(cols)}) to {features_file}')
    except Exception as e:
        print(f'Failed to save features: {e}')
    
    print(f'Saved model to {out}')


if __name__ == '__main__':
    main()
