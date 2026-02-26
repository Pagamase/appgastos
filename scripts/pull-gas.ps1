Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-FailAndExit([string]$Message) {
  Write-Error $Message
  exit 1
}

if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Write-FailAndExit "clasp no esta instalado. Instala con: npm i -g @google/clasp"
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ClaspConfigPath = Join-Path $ProjectRoot ".clasp.json"

if (-not (Test-Path $ClaspConfigPath)) {
  Write-FailAndExit "No existe .clasp.json. Primero enlaza el proyecto con scripts\\push-gas.ps1 -ScriptId TU_SCRIPT_ID"
}

Push-Location $ProjectRoot
try {
  clasp pull
  if ($LASTEXITCODE -ne 0) {
    Write-FailAndExit "clasp pull fallo con codigo $LASTEXITCODE"
  }
  Write-Host "Pull completado."
} finally {
  Pop-Location
}
