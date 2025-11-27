#!/usr/bin/env python3
"""
Train RandomForest model on historical trades analyzed by confirmation patterns.
Analyzes: Liquidity Grab + FVG + BOS + Third Confirmation
"""

import json
import pickle
import sys
from pathlib import Path
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import numpy as np

# Paths
SCRIPT_DIR = Path(__file__).parent
MAINBOT_DIR = SCRIPT_DIR.parent
DATA_DIR = MAINBOT_DIR / "data" / "output"
TRADES_FILE = DATA_DIR / "trade_signals.jsonl"
MODEL_OUTPUT = DATA_DIR / "confirmation_model.pkl"

def load_trades():
    """Load trades from trade_signals.jsonl"""
    trades = []
    if not TRADES_FILE.exists():
        print(f"❌ Trade file not found: {TRADES_FILE}")
        return []
    
    try:
        with open(TRADES_FILE, 'r') as f:
            for line in f:
                if line.strip():
                    trades.append(json.loads(line))
        print(f"✅ Loaded {len(trades)} trades from {TRADES_FILE}")
        return trades
    except Exception as e:
        print(f"❌ Error loading trades: {e}")
        return []

def extract_features(trade):
    """Extract confirmation features from trade"""
    features = {
        'liquidity_grab': 0,
        'fvg_displacement': 0,
        'bos': 0,
        'third_confirmation': 0,
        'confirmation_count': 0,
        'profitable': 0
    }
    
    try:
        # Get confirmations
        confirmations = trade.get('confirmations', {})
        if isinstance(confirmations, dict):
            # Count confirmations
            features['liquidity_grab'] = 1 if confirmations.get('liquidityGrab', False) else 0
            features['fvg_displacement'] = 1 if confirmations.get('fvgDisplacement', False) else 0
            features['bos'] = 1 if confirmations.get('bos', False) else 0
            
            third = confirmations.get('third', {})
            if isinstance(third, dict):
                features['third_confirmation'] = 1 if third.get('ok', False) else 0
            
            features['confirmation_count'] = sum([
                features['liquidity_grab'],
                features['fvg_displacement'],
                features['bos'],
                features['third_confirmation']
            ])
        
        # Get profitability
        sl = float(trade.get('sl', 0))
        tp = float(trade.get('tp', 0))
        entry = float(trade.get('entry', trade.get('price', 0)))
        close_price = float(trade.get('closePrice', 0))
        status = trade.get('status', '')
        
        # Determine if trade was profitable
        if status == 'closed' and close_price > 0:
            profit = close_price - entry
            # For SELL: negative profit is good
            if trade.get('side') == 'SELL':
                features['profitable'] = 1 if profit < 0 else 0
            else:
                features['profitable'] = 1 if profit > 0 else 0
        elif tp > 0 and sl > 0:
            # For backtesting: assume hit TP if close_price moves toward TP more than SL
            if trade.get('side') == 'BUY':
                dist_to_tp = abs(tp - entry)
                dist_to_sl = abs(entry - sl)
                move = close_price - entry if close_price > 0 else 0
                features['profitable'] = 1 if move > dist_to_tp * 0.5 else 0
        
        return features
    except Exception as e:
        print(f"⚠️  Error extracting features: {e}")
        return None

def main():
    print("=" * 60)
    print("Training Confirmation Model on Historical Trades")
    print("=" * 60)
    
    # Load trades
    trades = load_trades()
    if not trades:
        print("❌ No trades to train on")
        return
    
    # Extract features
    X = []
    y = []
    feature_names = ['liquidity_grab', 'fvg_displacement', 'bos', 'third_confirmation', 'confirmation_count']
    
    for trade in trades:
        features = extract_features(trade)
        if features:
            X.append([
                features['liquidity_grab'],
                features['fvg_displacement'],
                features['bos'],
                features['third_confirmation'],
                features['confirmation_count']
            ])
            y.append(features['profitable'])
    
    if not X:
        print("❌ Failed to extract features from any trades")
        return
    
    X = np.array(X)
    y = np.array(y)
    
    print(f"\n📊 Feature Matrix Shape: {X.shape}")
    print(f"📊 Outcomes: {np.sum(y)} wins / {len(y) - np.sum(y)} losses")
    
    # Analyze by confirmation count
    print("\n" + "=" * 60)
    print("Win Rates by Confirmation Count")
    print("=" * 60)
    
    for count in [2, 3, 4]:
        mask = X[:, 4] == count  # confirmation_count column
        if np.sum(mask) > 0:
            wins = np.sum(y[mask])
            total = np.sum(mask)
            wr = 100 * wins / total
            print(f"{count}-Signal: {wins}/{total} wins ({wr:.1f}% win rate)")
    
    # Train model
    print("\n" + "=" * 60)
    print("Training RandomForest Classifier")
    print("=" * 60)
    
    try:
        model = RandomForestClassifier(
            n_estimators=100,
            max_depth=8,
            min_samples_split=5,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1
        )
        
        model.fit(X, y)
        
        # Feature importance
        print("\n📈 Feature Importance:")
        for name, importance in zip(feature_names, model.feature_importances_):
            print(f"  {name}: {importance:.3f} ({100*importance:.1f}%)")
        
        # Save model
        MODEL_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        with open(MODEL_OUTPUT, 'wb') as f:
            pickle.dump(model, f)
        print(f"\n✅ Model saved to {MODEL_OUTPUT}")
        
        # Score on training set
        train_score = model.score(X, y)
        print(f"✅ Training accuracy: {100*train_score:.1f}%")
        
        # Predict probabilities for different patterns
        print("\n" + "=" * 60)
        print("Loss Probability by Setup Pattern")
        print("=" * 60)
        
        patterns = [
            ([1, 1, 0, 0, 2], "2-Signal (Liqu+FVG)"),
            ([1, 1, 1, 0, 3], "3-Signal (+BOS)"),
            ([1, 1, 0, 1, 3], "3-Signal (+Third)"),
            ([1, 1, 1, 1, 4], "4-Signal (Perfect)"),
        ]
        
        for pattern, name in patterns:
            X_test = np.array([pattern])
            loss_prob = 1 - model.predict_proba(X_test)[0][1]
            print(f"  {name}: {loss_prob:.3f} loss prob")
        
        print("\n✅ Training complete!")
        
    except Exception as e:
        print(f"❌ Training failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    return True

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
