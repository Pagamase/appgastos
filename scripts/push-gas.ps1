param(
  [string]$ScriptId = ""
)

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

if ($ScriptId) {
  $Config = @{
    scriptId = $ScriptId
    rootDir = "backend/google-apps-script"
    scriptExtensions = @(".js", ".gs")
    htmlExtensions = @(".html")
    jsonExtensions = @(".json")
    filePushOrder = @()
    skipSubdirectories = $true
  }
  $Config | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaspConfigPath -Encoding UTF8
  Write-Host "Config .clasp.json actualizada para scriptId $ScriptId"
}

if (-not (Test-Path $ClaspConfigPath)) {
  Write-FailAndExit "No existe .clasp.json. Ejecuta: .\\scripts\\push-gas.ps1 -ScriptId TU_SCRIPT_ID"
}

Push-Location $ProjectRoot
try {
  clasp push -f
  if ($LASTEXITCODE -ne 0) {
    Write-FailAndExit "clasp push fallo con codigo $LASTEXITCODE"
  }
  Write-Host "Push completado."
} finally {
  Pop-Location
}
