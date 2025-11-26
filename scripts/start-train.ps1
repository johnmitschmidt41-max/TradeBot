# Start the training script using project's virtualenv
# Usage: .\scripts\start-train.ps1
$venv = "./.venv"
$activate = "$venv\Scripts\Activate.ps1"
if (Test-Path $activate) { . $activate } else { Write-Host "Could not find virtualenv activate script at $activate" -ForegroundColor Yellow; exit 1 }
python .\train_model.py --input ..\data\output\trade_signals.jsonl --output ..\data\output\model.pkl
