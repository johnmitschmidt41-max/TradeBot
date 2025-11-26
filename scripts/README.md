# Python scripts setup & usage

This folder contains the trainer and scorer helper scripts.

Dependencies (already listed): scripts/requirements.txt

Quick setup (PowerShell):

```powershell
# create & activate venv + install deps
.
\scripts\setup_env.ps1

# run trainer (requires labeled trades in data/output/trade_signals.jsonl)
python scripts/train_model.py --input data/output/trade_signals.jsonl --output data/output/model.pkl

Shortcuts (from repository root)
-------------------------------
You can also run these convenience wrappers from the project root if you prefer:

PowerShell (activate venv & run):
```powershell
.
\scripts\start-train.ps1
\scripts\start-scorer.ps1
```

NPM shortcuts (from repo root):
```powershell
npm run train
npm run scorer
```

# run the scorer server (default port 5100)
python scripts/scorer_server.py --model data/output/model.pkl --port 5100
```

Tips:
- If you see ModuleNotFoundError, run the PowerShell setup script above or manually create a venv and `pip install -r scripts/requirements.txt`.
- The scorer exposes a `/health` endpoint for quick checks (e.g. `curl http://127.0.0.1:5100/health`).
- The default MT5 bridge runs on 5000; keep the scorer on a different port (e.g., 5100) to avoid port collisions.
