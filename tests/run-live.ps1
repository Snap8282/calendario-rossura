param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $repoRoot '.live-test-config.json' }
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$runnerPath = Join-Path (Join-Path $env:LOCALAPPDATA 'RossuraLiveTests') ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $runnerPath 'tests') -Force | Out-Null
foreach ($file in @('package.json','package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $runnerPath
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'live-user-actions.cjs') -Destination (Join-Path $runnerPath 'tests')
# Credentials stay in their original ignored file; do not copy them into the staging directory.
Write-Output "Live test reports will be saved under $runnerPath"
Push-Location $runnerPath
try {
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed' }
    node tests/live-user-actions.cjs $resolvedConfig
    if ($LASTEXITCODE -ne 0) { throw 'Live tests failed; inspect the report and cleanup status' }
} finally { Pop-Location }
