"""Smoke test the actual entry point and the runnable ZIP without external writes."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from zipfile import ZipFile

root=Path(__file__).resolve().parent.parent
with socket.socket() as probe:
    probe.bind(('127.0.0.1',0))
    port=probe.getsockname()[1]
base=f'http://127.0.0.1:{port}'
log_path=root/'tests'/'local-http.log'
with log_path.open('w',encoding='utf-8') as log:
    process=subprocess.Popen([sys.executable,str(root/'opend_board.py'),'--web-port',str(port)],cwd=root,stdout=log,stderr=log,
                             creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        for _ in range(80):
            try:
                with urlopen(base+'/api/health',timeout=2) as r:health=json.load(r)
                break
            except OSError:
                if process.poll() is not None:raise RuntimeError(log_path.read_text(encoding='utf-8'))
                time.sleep(.1)
        else:raise RuntimeError('Local entry did not become ready')
        assert health['relay']
        for path in ['/', '/app.js','/chart.js','/expected.js','/api/expected-provider?symbol=SPY','/vendor/lightweight-charts.standalone.production.js','/opend-gex-relay.zip']:
            with urlopen(base+path,timeout=5) as r:
                assert r.status==200 and r.read(),path
        history={}
        for symbol in ['SPY','QQQ','SPXW']:
            with urlopen(base+'/api/history?symbol='+symbol,timeout=10) as r:
                rows=json.load(r)['frames'];history[symbol]=len(rows)
        with ZipFile(root/'dist'/'opend-gex-relay.zip') as archive:
            names=archive.namelist()
            assert 'web/vendor/lightweight-charts.standalone.production.js' in names
            # The sole public, dated index-close record ships with the companion.
            # Captures, databases, logs, environments and other data files stay excluded.
            assert all(not name.startswith(('.venv/','node_modules/')) and
                       (not name.startswith('data/') or name=='data/verified-index-closes.json') for name in names)
            for name in ['opend_board.py','relay.py','market.py','providers.py','snapshots.py','web/app.js','web/chart.js','web/expected.js','web/tools.js','web/style.css']:
                assert archive.read(name)==(root/name).read_bytes(),name
        result={'entry':str(root/'opend_board.py'),'health':health,'persistedHistoryCounts':history,'archiveVerified':True}
        (root/'tests'/'local-http-results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=True))
    finally:
        process.terminate()
        process.wait(timeout=10)
