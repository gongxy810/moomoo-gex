"""Read-only acceptance against the currently running OpenD; no orders or credentials."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from relay import OpenDFeed

feed=OpenDFeed()
results=[]
try:
    for symbol in ['SPY','QQQ','SPXW']:
        try:
            f=feed.collect(symbol)
            result={'symbol':symbol,'ok':True,'contracts':f['contracts'],'usable':f['usable'],
                    'dates':f['dates'],'spotStatus':f['spot'].get('status'),'bars':len(f['bars']),
                    'warnings':f['warnings'],'collectedAt':f['collectedAt']}
        except Exception as error:
            result={'symbol':symbol,'ok':False,'error':str(error)}
        results.append(result)
        print(json.dumps(result,ensure_ascii=True),flush=True)
finally:
    if feed.ctx:feed.ctx.close()
Path('tests/live-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
