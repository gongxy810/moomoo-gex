"""Bounded, coalesced cloud analysis. Original JS math runs on the server."""
import json,subprocess,os
from pathlib import Path
from contextlib import closing
from datetime import datetime,timedelta,timezone
from threading import RLock

class CloudAnalysis:
    def __init__(self,store):self.store=store;self.lock=RLock();self.cache={}
    def compute(self,symbol,dates,asof,capture,metric,minutes,top,threshold,session,scope='chart'):
        key=(symbol,tuple(dates),asof,capture,metric,minutes,top,threshold,session,scope)
        # Completed immutable answers remain readable while another context runs.
        cached=self.cache.get(key)
        if cached is not None:return cached
        # No queue of obsolete Replay computations behind the one CPU worker.
        if not self.lock.acquire(blocking=False):return {'available':False,'reason':'Cloud calculation busy; retry shortly'}
        try:return self._compute(symbol,dates,asof,capture,metric,minutes,top,threshold,session,scope)
        finally:self.lock.release()
    def _compute(self,symbol,dates,asof,capture,metric,minutes,top,threshold,session,scope='chart'):
        at=datetime.fromisoformat(asof.replace('Z','+00:00'))
        if at.tzinfo is None or metric not in ('GEX','VEX') or minutes not in (1,2,5,15) or top not in (3,5,10) or not 0<=threshold<=100:raise ValueError('Invalid analysis context')
        if session not in ('ALL','EXT','PRE','RTH','POST'):raise ValueError('Invalid session')
        if scope not in ('chart','ladder'):raise ValueError('Invalid analysis scope')
        key=(symbol,tuple(dates),asof,capture,metric,minutes,top,threshold,session,scope)
        with self.lock:
            if key in self.cache:return self.cache[key]
            with closing(self.store.connect()) as db:
                record=db.execute('SELECT frame FROM captures WHERE symbol=? AND at=? AND julianday(at)<=julianday(?)',(symbol,capture,asof)).fetchone()
                if not record:return {'available':False,'reason':'No complete capture before cutoff'}
                frame=json.loads(record[0])
                if frame.get('optionLastAt') and datetime.fromisoformat(frame['optionLastAt'].replace('Z','+00:00'))>at:
                    return {'available':False,'reason':'Option data is after the Replay cutoff'}
                history_end=at
                if frame.get('optionLastAt'):
                    quoted=datetime.fromisoformat(frame['optionLastAt'].replace('Z','+00:00'))
                    if (at-quoted).total_seconds()>900:history_end=min(at,quoted+timedelta(seconds=90))
                start=(history_end-(timedelta(minutes=32) if scope=='ladder' else timedelta(hours=12))).isoformat()
                # Cursor iteration avoids materializing raw quote frames as a list.
                records=db.execute('SELECT frame FROM captures WHERE symbol=? AND at IN (SELECT MAX(at) FROM captures WHERE symbol=? AND at>=? AND julianday(at)<=julianday(?) GROUP BY CAST(strftime(\'%s\',at)/60 AS INTEGER)) ORDER BY at',(symbol,symbol,start,history_end.isoformat()))
                history=[]
                for raw, in records:
                    f=json.loads(raw)
                    if f.get('optionLastAt') and datetime.fromisoformat(f['optionLastAt'].replace('Z','+00:00'))>at:continue
                    f.pop('price',None);f.pop('bars',None);f.pop('listedStrikes',None)
                    f['cells']=[{k:v for k,v in c.items() if k in ('strike','expiry','call','put','callOi','putOi','callIv','putIv','complete','contracts')} for c in f.get('cells',[]) if c['expiry'] in dates]
                    history.append(f)
            price=self.store.price_history(symbol,(at-timedelta(days=1)).isoformat() if scope=='ladder' else start,asof)
            payload={'frame':frame,'dates':dates,'history':history,'bars':price['bars'],'at':at.timestamp()*1000,'metric':metric,'minutes':minutes,'top':top,'threshold':threshold,'session':session,'scope':scope}
            # Quotes only needed by current IV/Zero Gamma endpoints, not analysis.
            frame.pop('price',None)
            result=subprocess.run([os.environ.get('GEX_NODE','node'),'--max-old-space-size=256',str(Path(__file__).parent/'cloud'/'analysis.mjs')],input=json.dumps(payload,allow_nan=False).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
            if result.returncode:raise RuntimeError('Cloud calculation failed; previous snapshot retained')
            answer=json.loads(result.stdout);self.cache[key]=answer
            while len(self.cache)>12:self.cache.pop(next(iter(self.cache)))
            return answer
