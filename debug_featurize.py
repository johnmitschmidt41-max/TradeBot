import json
from pathlib import Path
import numpy as np

signals_file = Path('data/output/trade_signals.jsonl')
trades = []

with signals_file.open('r') as f:
    for line in f:
        try:
            it = json.loads(line.strip())
            res = it.get('result')
            if not res:
                continue
            
            profit = float(res.get('profit', 0))
            
            # ONLY include winning trades (profit > 0)
            if profit <= 0:
                continue
            
            trades.append(it)
        except:
            pass

print(f"Loaded {len(trades)} winning trades")

# Now featurize
features_list = []
for i, trade in enumerate(trades[:10]):  # First 10
    sl = float(trade.get('slPips', 0) or 0)
    tp = float(trade.get('tpPips', 0) or 0)
    fvg = float(trade.get('fvgDistancePips', 0) or 0)
    balance = float(trade.get('accountBalance', 0) or 0)
    lots = float(trade.get('lots', 0) or 0)
    
    print(f"Trade {i+1}: sl={sl} tp={tp} fvg={fvg} balance={balance} lots={lots}")
    
    if sl <= 0 or tp <= 0 or balance <= 0 or lots <= 0:
        print(f"  SKIPPED (invalid values)")
        continue
    
    print(f"  OK")
