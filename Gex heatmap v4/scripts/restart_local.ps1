$ErrorActionPreference = 'Stop'
$boardRoot = Split-Path -Parent $PSScriptRoot
$expectedPython = Join-Path $boardRoot '.venv\Scripts\python.exe'
$listeners = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue
foreach ($owner in @($listeners.OwningProcess | Sort-Object -Unique)) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
    if ($processInfo.CommandLine -notlike "*$expectedPython*opend_board.py*") {
        throw '8766 belongs to another application; no process was stopped.'
    }
    Stop-Process -Id $owner -ErrorAction Stop
}
$logRoot = Join-Path $boardRoot 'data'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
foreach ($stream in @('stdout', 'stderr')) {
    $priorLog = Join-Path $logRoot "relay.$stream.log"
    if (Test-Path -LiteralPath $priorLog) { Copy-Item -LiteralPath $priorLog -Destination (Join-Path $logRoot "relay-before-v2.$stream.log") -Force }
}
$launcher = Start-Process -FilePath $expectedPython -ArgumentList @('opend_board.py','--origin','https://opend-gex-board.super-fir-5013.chatgpt.site') -WorkingDirectory $boardRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'relay.stdout.log') -RedirectStandardError (Join-Path $logRoot 'relay.stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $logRoot 'relay-launcher.pid') -Value $launcher.Id
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/api/health' -TimeoutSec 2
        if ($health.version -eq '2026-11-10-replay-validation-v2') { $health | ConvertTo-Json -Compress; exit 0 }
    } catch {}
    Start-Sleep -Milliseconds 200
}
throw 'New relay failed to become ready; inspect data/relay.stderr.log.'
