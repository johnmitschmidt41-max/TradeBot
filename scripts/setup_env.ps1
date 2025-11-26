# PowerShell convenience script - creates a virtualenv and installs Python dependencies
# Usage: .\scripts\setup_env.ps1

$venvPath = "./.venv"
if (-Not (Test-Path $venvPath)) {
  Write-Host "Creating virtualenv at $venvPath..."
  python -m venv $venvPath
} else {
  Write-Host "Virtualenv already exists at $venvPath"
}

# Activate the venv for this shell (pwsh)
$activate = "$venvPath\Scripts\Activate.ps1"
if (Test-Path $activate) {
  Write-Host "Activating virtualenv..."
  . $activate
} else {
  Write-Host "Activate script not found. Make sure Python and venv are available.\nYou can activate manually with: .\$venvPath\Scripts\Activate.ps1" -ForegroundColor Yellow
}

# Install requirements for scripts (trainer/scorer)
if (Test-Path "./scripts/requirements.txt") {
  Write-Host "Installing Python dependencies from scripts/requirements.txt..."
  pip install --upgrade pip
  pip install -r scripts/requirements.txt
} else {
  Write-Host "scripts/requirements.txt not found - nothing to install." -ForegroundColor Yellow
}

Write-Host "Setup complete. To run the scorer: python scripts/scorer_server.py --model data/output/model.pkl --port 5100" -ForegroundColor Green
