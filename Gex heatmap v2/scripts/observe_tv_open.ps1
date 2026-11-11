$ErrorActionPreference = 'Stop'
$boardRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $boardRoot
$artifactRoot = Join-Path $boardRoot 'tests\browser-artifacts'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$logPath = Join-Path $artifactRoot 'tv-open-run.log'
Set-Content -LiteralPath $logPath -Value "Started $(Get-Date -Format o)" -Encoding UTF8
try {
    $nowEt = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::Now, 'Eastern Standard Time')
    if ($nowEt.ToString('yyyy-MM-dd') -ne '2026-11-11' -or $nowEt.Hour -ne 9 -or $nowEt.Minute -gt 45) {
        throw "Observation skipped outside 2026-11-11 09:30–09:45 ET; actual $nowEt"
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { 'E:\node\node.exe' }
    if (-not (Test-Path -LiteralPath $nodePath)) { throw "Node runtime unavailable: $nodePath" }
    & $nodePath 'tests/browser.mjs' '--live' '--tv' '--observe' '--open-check' *>> $logPath
    if ($LASTEXITCODE -ne 0) { throw "Browser check exited with code $LASTEXITCODE" }
    Add-Content -LiteralPath $logPath -Value "Finished $(Get-Date -Format o)" -Encoding UTF8
} catch {
    Add-Content -LiteralPath $logPath -Value "Failed $(Get-Date -Format o): $($_.Exception.Message)" -Encoding UTF8
    exit 1
}
