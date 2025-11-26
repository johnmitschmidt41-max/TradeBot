# Start scorer server using the project's virtualenv
# Usage: .\scripts\start-scorer.ps1
$venv = "./.venv"
$activate = "$venv\Scripts\Activate.ps1"
if (Test-Path $activate) { . $activate } else { Write-Host "Could not find virtualenv activate script at $activate" -ForegroundColor Yellow; exit 1 }
python .\scorer_server.py --model ..\data\output\model.pkl --port 5100
