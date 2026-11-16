"""Background save-to-GitHub watcher; logs stay in ignored data, not a console."""
import sys,runpy,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    (ROOT/'data').mkdir(exist_ok=True)
    if os.name=='nt':
        import msvcrt
        guard=(ROOT/'data/watch.lock').open('a+b');guard.seek(0)
        try:msvcrt.locking(guard.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:sys.exit(0)
    with (ROOT/'data/autosync.log').open('a',encoding='utf-8',buffering=1) as log:
        sys.stdout=sys.stderr=log
        sys.argv=[str(ROOT/'cloud/publish.py'),'--watch']
        runpy.run_path(sys.argv[0],run_name='__main__')
