$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$key = Join-Path $root 'data\cloud-tunnel\id_ed25519'
$log = Join-Path $root 'data\cloud-tunnel\tunnel.log'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
# Dedicated forwarding-only key; no shell access and no public OpenD listener.
while ($true) {
    try {
        & $ssh -N -T -i $key -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R '127.0.0.1:11111:127.0.0.1:11111' 'sylviagong2019@instance-20261115-035258.tail29d8e5.ts.net' 2>> $log
    } catch { $_ | Out-File -FilePath $log -Append }
    Start-Sleep -Seconds 10
}
