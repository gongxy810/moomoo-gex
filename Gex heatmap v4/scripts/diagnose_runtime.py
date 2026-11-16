"""Read-only HTTP evidence from the server currently serving the user's browser."""
import hashlib
import json
from pathlib import Path
from time import monotonic
from urllib.request import urlopen
from urllib.error import HTTPError

root=Path(__file__).resolve().parent.parent
results=[]
for endpoint in ['/api/health','/app.js','/chart.js','/api/price?symbol=NVDA','/api/snapshot?symbol=NVDA']:
    start=monotonic()
    try:
        with urlopen('http://127.0.0.1:8766'+endpoint,timeout=120) as response:
            payload=response.read();status=response.status
        info={'endpoint':endpoint,'seconds':round(monotonic()-start,3),'status':status}
        if endpoint.endswith('.js'):
            info['matchesWorkspace']=payload==(root/'web'/endpoint[1:]).read_bytes()
            info['sha256']=hashlib.sha256(payload).hexdigest()
        else:
            data=json.loads(payload)
            info.update({k:data.get(k) for k in ['symbol','usable','dates','error','openDPort'] if k in data})
    except HTTPError as error:
        info={'endpoint':endpoint,'seconds':round(monotonic()-start,3),'status':error.code,'error':error.read().decode('utf-8')[:800]}
    except Exception as error:
        info={'endpoint':endpoint,'seconds':round(monotonic()-start,3),'error':str(error)}
    results.append(info);print(json.dumps(info,ensure_ascii=True),flush=True)
(root/'data'/'runtime-before.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
