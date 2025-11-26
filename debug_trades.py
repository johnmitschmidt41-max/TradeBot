import json
from pathlib import Path

signals_file = Path('data/output/trade_signals.jsonl')
count = 0

with signals_file.open('r') as f:
    for line in f:
        try:
            it = json.loads(line.strip())
            if it.get('status') == 'closed':
                res = it.get('result', {})
                profit = float(res.get('profit', 0) or 0)
                if profit > 0 and count < 3:
                    count += 1
                    print(f"Trade {count}:")
                    print(f"  slPips={it.get('slPips')} tpPips={it.get('tpPips')} lots={it.get('lots')} balance={it.get('accountBalance')}")
                    print(f"  profit={profit}")
        except:
            pass
