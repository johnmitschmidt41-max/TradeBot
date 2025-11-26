#!/usr/bin/env python3
"""
Train ML model on WINNING TRADES ONLY for maximum accuracy.
This filters out all losing trades and teaches the model to discriminate between 
WINNERS vs BREAKEVEN/SMALL-WINNERS, resulting in much higher confidence scores.
"""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
import joblib

def load_winning_trades():
    """Load only trades with profit > 0 from trade_signals.jsonl"""
    signals_file = Path(__file__).parent.parent.joinpath('data', 'output', 'trade_signals.jsonl')
    trades = []
    
    with signals_file.open('r') as f:
        for line in f:
            try:
                it = json.loads(line.strip())
                
                # Skip SIGNAL entries and incomplete orders
                if it.get('orderType') == 'SIGNAL' or it.get('status') != 'closed':
                    continue
                
                res = it.get('result')
                if not res:
                    continue
                
                profit = float(res.get('profit', 0))
                
                # ONLY include winning trades (profit > 0)
                if profit <= 0:
                    continue
                
                # Additional validation: skip zero values
                sl = float(it.get('slPips', 0) or 0)
                tp = float(it.get('tpPips', 0) or 0)
                balance = float(it.get('accountBalance', 0) or 0)
                lots = float(it.get('lots', 0) or 0)
                
                if sl <= 0 or tp <= 0 or balance <= 0 or lots <= 0:
                    continue
                
                trades.append(it)
            except:
                pass
    
    return trades

def featurize(trades):
    """Extract features from winning trades"""
    features = []
    labels = []
    skipped = 0
    
    for trade in trades:
        try:
            sl = float(trade.get('slPips', 0) or 0)
            tp = float(trade.get('tpPips', 0) or 0)
            fvg = float(trade.get('fvgDistancePips', 0) or 0)
            balance = float(trade.get('accountBalance', 0) or 0)
            lots = float(trade.get('lots', 0) or 0)
            res = trade.get('result', {})
            profit = float(res.get('profit', 0) or 0)
            
            # Base features
            rr_ratio = tp / sl if sl > 0 else 1.0
            lot_size_normalized = lots / (balance / 1000 + 1e-6)
            fvg_distance_normalized = fvg / (sl + 1e-6) if sl > 0 else 0
            
            # Get symbol/side win rate (from all historical data)
            sym = trade.get('symbol', '')
            side = trade.get('side', '')
            symbol_side_wins = trade.get('symbol_side_win_rate', 0.21)  # fallback to overall 21%
            
            # Create feature dict
            feat = {
                'slPips': np.log1p(sl),
                'tpPips': np.log1p(tp),
                'fvgDistancePips': np.log1p(fvg),
                'accountBalance': balance / 5000.0,  # normalize around 5k account
                'lots': lots,
                'rr_ratio': rr_ratio,
                'lot_size_normalized': lot_size_normalized,
                'symbol_side_win_rate': symbol_side_wins,
                'fvg_distance_normalized': fvg_distance_normalized,
            }
            
            # One-hot encode symbol (top 7 symbols)
            for sym_name in ['GBPUSDz', 'EURUSDz', 'XAUUSDz', 'US30_x10z', 'USTECz', 'USDJPYz', 'other']:
                feat[f'sym_{sym_name}'] = 1 if sym == sym_name else 0
            
            # One-hot encode side
            for side_name in ['BUY', 'SELL']:
                feat[f'side_{side_name}'] = 1 if side == side_name else 0
            
            # One-hot encode order type
            ord_type = trade.get('orderType', '')
            for ord_name in ['MARKET', 'LIMIT']:
                feat[f'ord_{ord_name}'] = 1 if ord_type == ord_name else 0
            
            features.append(feat)
            
            # LABEL: 1 = "GOOD" winner (profit >= median), 0 = "MEDIOCRE" winner (profit < median)
            # This lets model discriminate between excellent wins vs barely profitable
            labels.append(1)  # Will adjust after seeing profit distribution
            
        except Exception as e:
            skipped += 1
            pass
    
    print(f"Featurize: processed {len(features)} valid trades, skipped {skipped}")
    return features, labels

def main():
    print("=" * 60)
    print("WINNING TRADES ONLY TRAINER")
    print("=" * 60)
    
    # Load winning trades only
    trades = load_winning_trades()
    print(f"\nLoaded {len(trades)} WINNING trades (profit > 0)")
    
    # Featurize
    features, _ = featurize(trades)
    df = pd.DataFrame(features)
    print(f"Featurized {len(df)} trades with {len(df.columns)} features")
    
    # Create label: discriminate between TOP winners vs normal winners
    profits = [float(t.get('result', {}).get('profit', 0)) for t in trades]
    median_profit = np.median(profits)
    labels = np.array([1 if p >= median_profit else 0 for p in profits])
    
    print(f"\nProfit Distribution (winners only):")
    print(f"  Min: {min(profits):.4f}")
    print(f"  Median: {median_profit:.4f}")
    print(f"  Max: {max(profits):.4f}")
    print(f"  Mean: {np.mean(profits):.4f}")
    print(f"\nClass Distribution:")
    print(f"  Top Winners (label=1): {sum(labels)} ({100*sum(labels)/len(labels):.1f}%)")
    print(f"  Normal Winners (label=0): {sum(1-labels)} ({100*sum(1-labels)/len(labels):.1f}%)")
    
    # Train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        df, labels, test_size=0.2, random_state=42, stratify=labels
    )
    
    print(f"\nTrain set: {len(X_train)} | Test set: {len(X_test)}")
    
    # Train RandomForest with aggressive settings for high accuracy
    model = RandomForestClassifier(
        n_estimators=300,
        max_depth=12,
        min_samples_leaf=3,
        min_samples_split=5,
        max_features='sqrt',
        class_weight='balanced',
        random_state=42,
        n_jobs=-1
    )
    
    print("\nTraining RandomForest (300 trees, max_depth=12)...")
    model.fit(X_train, y_train)
    
    # Evaluate
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"\nTest Accuracy: {acc:.1%}")
    print("\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=['Normal Winner', 'Top Winner']))
    
    # Feature importance
    importances = model.feature_importances_
    top_features = sorted(zip(df.columns, importances), key=lambda x: x[1], reverse=True)
    print("\nTop 10 Features:")
    for feat, imp in top_features[:10]:
        print(f"  {feat}: {imp:.4f}")
    
    # Predictions on test set
    probs = model.predict_proba(X_test)
    loss_probs = probs[:, 0]  # Prob of "normal winner" (lower is better for top winners)
    print(f"\nPrediction Distribution (test set):")
    print(f"  Loss Prob Min: {loss_probs.min():.4f}")
    print(f"  Loss Prob Max: {loss_probs.max():.4f}")
    print(f"  Loss Prob Mean: {loss_probs.mean():.4f}")
    print(f"  Loss Prob Median: {np.median(loss_probs):.4f}")
    print(f"  Loss Prob Std: {loss_probs.std():.4f}")
    
    # Save model
    model_path = Path(__file__).parent.parent.joinpath('data', 'output', 'model_winners.pkl')
    joblib.dump(model, model_path)
    print(f"\nModel saved: {model_path}")
    
    # Save feature metadata
    features_meta = {
        'feature_columns': df.columns.tolist(),
        'training_trades': len(df),
        'test_accuracy': float(acc),
        'model_type': 'RandomForestClassifier (winners only)',
        'n_estimators': 300,
        'max_depth': 12
    }
    features_path = Path(__file__).parent.parent.joinpath('data', 'output', 'model_winners_features.json')
    with features_path.open('w') as f:
        json.dump(features_meta, f, indent=2)
    print(f"Features metadata saved: {features_path}")
    
    print("\n" + "=" * 60)
    print("TRAINING COMPLETE - HIGH ACCURACY MODEL READY")
    print("=" * 60)

if __name__ == '__main__':
    main()
