$ErrorActionPreference = 'Stop'
$boardRoot = Split-Path -Parent $PSScriptRoot
$observerPath = Join-Path $PSScriptRoot 'observe_tv_open.ps1'
$taskName = 'OpenD-GEX-FOREXCOM-SPXUSD-20261111'
$runAt = Get-Date '2026-11-11T09:31:00'
if ((Get-Date) -ge $runAt) { throw 'The requested market-open observation time has passed.' }
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $observerPath + '"') -WorkingDirectory $boardRoot
$trigger = New-ScheduledTaskTrigger -Once -At $runAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Observe FOREXCOM:SPXUSD 1m embedded widget near 09:30 ET in OpenD GEX Board' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
[pscustomobject]@{task=$taskName;state=$task.State.ToString();runAt=$runAt.ToString('o');script=$observerPath} | ConvertTo-Json -Compress
