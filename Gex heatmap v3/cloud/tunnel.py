"""Windows background-only tunnel supervisor; no calculations or account secrets."""
import os,subprocess,time,sys
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    import msvcrt
    folder=ROOT/'data/cloud-tunnel';folder.mkdir(parents=True,exist_ok=True)
    guard=(folder/'supervisor.lock').open('a+b');guard.seek(0)
    try:msvcrt.locking(guard.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:sys.exit(0)
    cmd=[str(Path(os.environ['WINDIR'])/'System32/OpenSSH/ssh.exe'),'-N','-T','-i',str(folder/'id_ed25519'),'-p','2222',
        '-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o','ExitOnForwardFailure=yes',
        '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-R','127.0.0.1:11111:127.0.0.1:11111',
        'sylviagong2019@instance-20261115-035258.tail29d8e5.ts.net']
    with (folder/'tunnel.log').open('ab',buffering=0) as log:
        while True:
            log.write(('\n'+datetime.now(timezone.utc).isoformat()+' tunnel connecting\n').encode())
            try:
                result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
                log.write(('tunnel exit '+str(result.returncode)+'\n').encode())
            except Exception as error:log.write((type(error).__name__+'\n').encode())
            time.sleep(10)
