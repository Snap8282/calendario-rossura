# Run from the Google Drive workspace without installing node_modules on that drive.
# Copies only test/UI source files into a fresh local directory; never copies exports or credentials.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerRoot = Join-Path $env:LOCALAPPDATA 'RossuraReview'
$runnerPath = Join-Path $runnerRoot ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $runnerPath -Force | Out-Null
foreach ($directory in @('tests','e2e','supabase','supabase/migrations','backup','vendor','assets')) {
    New-Item -ItemType Directory -Path (Join-Path $runnerPath $directory) | Out-Null
}
foreach ($file in @('package.json','package-lock.json','playwright.config.cjs','index.html','app.js','style.css')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $runnerPath
}
foreach ($pattern in @('tests/*.cjs','e2e/*.cjs','supabase/*.sql','vendor/*.js')) {
    $target = ($pattern -split '/')[0]
    Copy-Item -Path (Join-Path $repoRoot $pattern) -Destination (Join-Path $runnerPath $target)
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'backup/Code.gs') -Destination (Join-Path $runnerPath 'backup')
Copy-Item -LiteralPath (Join-Path $repoRoot 'backup/build-restore.cjs') -Destination (Join-Path $runnerPath 'backup')
Copy-Item -Path (Join-Path $repoRoot 'supabase/migrations/*.sql') -Destination (Join-Path $runnerPath 'supabase/migrations')
Copy-Item -LiteralPath (Join-Path $repoRoot 'assets/rossura.webp') -Destination (Join-Path $runnerPath 'assets')
Write-Output "Running isolated checks in $runnerPath"
Push-Location $runnerPath
try {
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed' }
    npm test
    $domainResult = $LASTEXITCODE
    npm run test:e2e
    $browserResult = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($domainResult -ne 0 -or $browserResult -ne 0) { exit 1 }
