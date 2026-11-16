"""Bounded, coalesced cloud analysis. Original JS math runs on the server."""
import json,subprocess,os
from pathlib import Path
from contextlib import closing
from datetime import datetime,timedelta,timezone
from threading import RLock,Condition,Thread
from time import monotonic

class SupersededAnalysis(Exception):pass

class CloudAnalysis:
    def __init__(self,store):
        self.store=store;self.lock=RLock();self.cache={}
        self.condition=Condition();self.pending={};self.running=None;self.worker=None
        self.running_slot=None;self.running_replay=False

    def superseded(self):
        with self.condition:
            replacement=self.pending.get(self.running_slot)
            return bool(replacement and replacement[0]!=self.running) or (self.running is not None and not self.running_replay and any(v[2] for v in self.pending.values()))

    def request(self,symbol,dates,asof,capture,metric,minutes,top,threshold,session,scope='chart',replay=False,client='default'):
        at=datetime.fromisoformat(asof.replace('Z','+00:00'))
        if at.tzinfo is None or metric not in ('GEX','VEX') or minutes not in (1,2,5,15) or top not in (3,5,10) or not 0<=threshold<=100 or scope not in ('chart','ladder') or session not in ('ALL','EXT','PRE','RTH','POST'):
            raise ValueError('Invalid analysis context')
        args=(symbol,dates,asof,capture,metric,minutes,top,threshold,session,scope)
        key=(symbol,tuple(dates),asof,capture,metric,minutes,top,threshold,session,scope)
        cached=self.cache.get(key)
        if cached is not None:return cached
        slot=(str(client)[:64],symbol,scope)
        with self.condition:
            self.pending.pop(slot,None)
            if self.running!=key:
                self.pending[slot]=(key,args,bool(replay),scope=='chart')
                while len(self.pending)>24:
                    discard=min(self.pending,key=lambda k:(self.pending[k][2],self.pending[k][3]))
                    del self.pending[discard]
                if self.worker is None:
                    self.worker=Thread(target=self._work,name='gex-analysis',daemon=True);self.worker.start()
                self.condition.notify()
        return {'available':False,'pending':True,'reason':'Historical analysis queued; live prices remain independent'}

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda:bool(self.pending))
                slot=max(self.pending,key=lambda k:(self.pending[k][2],self.pending[k][3]))
                key,args,replay,_=self.pending.pop(slot);self.running=key;self.running_slot=slot;self.running_replay=replay
            started=monotonic()
            try:
                result=self.compute(*args)
                print(json.dumps({'event':'cloud-analysis','symbol':args[0],'scope':args[-1],'asof':args[2],'seconds':round(monotonic()-started,3),'available':result.get('available')}),flush=True)
                if not result.get('available'):
                    # Keep immutable data-quality errors; busy work will be retried.
                    if 'busy' not in result.get('reason','').lower():
                        self.cache[key]=result
                        while len(self.cache)>12:self.cache.pop(next(iter(self.cache)))
            except SupersededAnalysis:pass
            except Exception as error:
                print(json.dumps({'event':'cloud-analysis-error','symbol':args[0],'error_type':type(error).__name__}),flush=True)
            finally:
                with self.condition:self.running=None;self.running_slot=None
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
                frame['expiryCloses']={**(frame.get('price') or {}).get('sessions',{}),**frame.get('expiryCloses',{})}
                if frame.get('optionLastAt') and datetime.fromisoformat(frame['optionLastAt'].replace('Z','+00:00'))>at:
                    return {'available':False,'reason':'Option data is after the Replay cutoff'}
                history_end=at
                if frame.get('optionLastAt'):
                    quoted=datetime.fromisoformat(frame['optionLastAt'].replace('Z','+00:00'))
                    if (at-quoted).total_seconds()>900:history_end=min(at,quoted+timedelta(seconds=90))
                start=(history_end-(timedelta(minutes=32) if scope=='ladder' else timedelta(hours=12))).isoformat()
                # Cursor iteration avoids materializing raw quote frames as a list.
                records=db.execute('''SELECT json_remove(json_set(frame,'$.expiryCloses',
                    json_patch(COALESCE(json_extract(frame,'$.price.sessions'),'{}'),COALESCE(json_extract(frame,'$.expiryCloses'),'{}'))),
                    '$.price','$.bars','$.listedStrikes','$.basisHistory') FROM captures
                    WHERE symbol=? AND at IN (SELECT MAX(at) FROM captures WHERE symbol=? AND at>=? AND julianday(at)<=julianday(?)
                    GROUP BY CAST(strftime('%s',at)/(?*60) AS INTEGER)
                    UNION SELECT MAX(at) FROM captures WHERE symbol=? AND at>=? AND julianday(at)<=julianday(?)
                    GROUP BY CAST(strftime('%s',at)/60 AS INTEGER)) ORDER BY at''',
                    (symbol,symbol,start,history_end.isoformat(),minutes if scope=='chart' else 1,symbol,(history_end-timedelta(minutes=32)).isoformat(),history_end.isoformat()))
                history=[]
                for raw, in records:
                    if self.superseded():raise SupersededAnalysis()
                    f=json.loads(raw)
                    if f.get('optionLastAt') and datetime.fromisoformat(f['optionLastAt'].replace('Z','+00:00'))>at:continue
                    f['expiryCloses']={d:closing for d,closing in {**(f.get('price') or {}).get('sessions',{}),**f.get('expiryCloses',{})}.items() if d in dates}
                    f.pop('price',None);f.pop('bars',None);f.pop('listedStrikes',None)
                    cells=[]
                    for c in f.get('cells',[]):
                        if c['expiry'] not in dates:continue
                        cell={k:v for k,v in c.items() if k in ('strike','expiry','call','put','callOi','putOi','callIv','putIv','complete','contracts')}
                        for side in ('call','put'):cell[side+'Iv']=c.get(side+'Iv') or (c.get(side+'Quote') or {}).get('iv')
                        cells.append(cell)
                    f['cells']=cells
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
