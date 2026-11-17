"""Optional latest-result mirror. Bounded queue, no credentials in logs/browser."""
import os,json,urllib.request
from threading import Thread,Condition

class LatestMirror:
    def __init__(self):
        self.url=os.environ.get('SUPABASE_URL','').rstrip('/')
        self.key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_SECRET_KEY')
        self.database=os.environ.get('DATABASE_URL')
        self.pending={};self.condition=Condition()
        if self.database or (self.url and self.key):Thread(target=self.run,daemon=True).start()
    def submit(self,frame):
        if not self.database and (not self.url or not self.key):return
        payload={'symbol':frame['symbol'],'captured_at':frame['collectedAt'],'payload':{
            'model':frame.get('model'),'spot':frame.get('spot'),'dates':frame.get('dates'),
            'sessionDate':frame.get('sessionDate'),'optionLastAt':frame.get('optionLastAt'),
            'levels':[{k:v for k,v in c.items() if k in ('expiry','strike','call','put','callVex','putVex','complete')} for c in frame.get('cells',[])]}}
        with self.condition:
            if len(self.pending)<12 or frame['symbol'] in self.pending:self.pending[frame['symbol']]=payload
            self.condition.notify()
    def run(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda:bool(self.pending));symbol=next(iter(self.pending));payload=self.pending.pop(symbol)
            try:
                if self.database:
                    import psycopg
                    from psycopg.types.json import Jsonb
                    with psycopg.connect(self.database,connect_timeout=10) as db:
                        with db.cursor() as cur:
                            cur.execute('INSERT INTO public.gex_latest_snapshots(symbol,captured_at,payload) VALUES (%s,%s,%s) ON CONFLICT(symbol) DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload WHERE excluded.captured_at>=gex_latest_snapshots.captured_at',(symbol,payload['captured_at'],Jsonb(payload['payload'])))
                    continue
                req=urllib.request.Request(self.url+'/rest/v1/gex_latest_snapshots?on_conflict=symbol',data=json.dumps(payload,allow_nan=False).encode(),headers={'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},method='POST')
                with urllib.request.urlopen(req,timeout=10):pass
            except Exception as error:print(json.dumps({'event':'supabase-mirror','ok':False,'error_type':type(error).__name__}),flush=True)
