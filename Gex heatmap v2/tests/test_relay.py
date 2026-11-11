from datetime import datetime, timezone
from threading import Event
from time import monotonic, sleep
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from functools import partial
from unittest.mock import patch
from market import Calendar, quote, symbol_code
from relay import contracts_from_chain, summarize, implied_reference, OpenDFeed, SnapshotManager, MODEL, cache_identity, supplemental_close
from snapshots import SnapshotStore
from opend_board import handler, PRIVATE_ORIGIN
from providers import RoutedPriceProvider

def dt(s):
    return datetime.fromisoformat(s).astimezone(timezone.utc)

class MarketTests(unittest.TestCase):
    def test_shared_capture_serves_persisted_frame_and_joins_inflight_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            store=SnapshotStore(Path(folder)/'captures.sqlite3')
            frame={'symbol':'SPY','source':'opend','optionRoot':'US.SPY','model':MODEL,'dates':['2026-11-09'],
                   'cells':[{'expiry':'2026-11-09','strike':100,'call':1,'put':-1}],
                   'collectedAt':'2026-11-09T20:59:50+00:00','sessionDate':'2026-11-09','usable':2,'contracts':2}
            frame['cacheKey']=cache_identity(frame);store.save(frame)
            gate=Event()
            class Feed:
                def __init__(self):self.store=store;self.calls=0;self.forced=[]
                def collect(self,symbol,force=False):
                    self.calls+=1;self.forced.append(force);gate.wait(3)
                    return {**frame,'collectedAt':'2026-11-10T20:00:00+00:00'}
            feed=Feed();manager=SnapshotManager(feed,watched=())
            try:
                first=manager.request('SPY');self.assertEqual(first['collectedAt'],frame['collectedAt'])
                self.assertTrue(first['service']['stale'])
                for _ in range(5):self.assertEqual(manager.request('SPY',force=True)['collectedAt'],frame['collectedAt'])
                gate.set();deadline=monotonic()+3
                while manager.request('SPY')['service']['phase']!='ready' and monotonic()<deadline:sleep(.01)
                self.assertEqual(feed.calls,1);self.assertEqual(manager.request('SPY')['collectedAt'],'2026-11-10T20:00:00+00:00')
                manager.request('SPY',force=True)
                deadline=monotonic()+3
                while feed.calls<2 and monotonic()<deadline:sleep(.01)
                self.assertEqual(feed.calls,2);self.assertEqual(feed.forced,[False,True])
            finally:manager.close()

    def test_window_keeps_bucket_last_and_all_recent_velocity_captures(self):
        with tempfile.TemporaryDirectory() as folder:
            store=SnapshotStore(Path(folder)/'captures.sqlite3')
            for minute in [0,1,2,4,5,6,9,10,54,55,56,57,58,59]:
                frame={'symbol':'SPY','optionRoot':'US.SPY','model':MODEL,'dates':['2026-11-10'],
                       'collectedAt':f'2026-11-10T19:{minute:02d}:00+00:00','sessionDate':'2026-11-10',
                       'sessionClose':'2026-11-10T21:00:00+00:00','usable':1,'contracts':1,
                       'cells':[{'expiry':'2026-11-10','strike':100,'call':minute,'put':-1,
                                 'complete':True,'contracts':['C','P'],'validContracts':['C','P'],
                                 'callQuote':{'bid':1}}]}
                store.save(frame)
            rows=store.window('SPY','2026-11-10T19:00:00+00:00','2026-11-10T19:59:30+00:00',5)
            minutes=[int(f['collectedAt'][14:16]) for f in rows]
            self.assertEqual(minutes,[4,9,10,54,55,56,57,58,59])
            self.assertEqual(rows[-1]['cells'][0]['call'],59)
            self.assertEqual(rows[-1]['cells'][0]['contracts'],['C','P'])
            self.assertNotIn('callQuote',rows[-1]['cells'][0])
            full=store.window('SPY','2026-11-10T19:00:00+00:00','2026-11-10T19:59:30+00:00',5,full=True)
            self.assertIn('callQuote',full[-1]['cells'][0])

    def test_supplemental_index_close_requires_matching_symbol_date_and_source(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'closes.json'
            self.assertIsNone(supplemental_close(path,'SPXW','2026-11-09'))
            row={'symbol':'SPX','date':'2026-11-09','close':7549.94,'source':'verified fixture','url':'https://example.test/close'}
            path.write_text(json.dumps([row]),encoding='utf-8')
            self.assertEqual(supplemental_close(path,'SPXW','2026-11-09')['close'],7549.94)
            self.assertIsNone(supplemental_close(path,'SPXW','2026-11-10'))
            self.assertIsNone(supplemental_close(path,'SPY','2026-11-09'))
            path.write_text(json.dumps([{**row,'close':0}]),encoding='utf-8')
            self.assertIsNone(supplemental_close(path,'SPXW','2026-11-09'))
            path.write_text('{}',encoding='utf-8')
            self.assertIsNone(supplemental_close(path,'SPXW','2026-11-09'))

    def setUp(self):
        self.cal=Calendar([{'time':'2026-11-06'},{'time':'2026-11-09'}, {'time':'2026-11-25'},
                           {'time':'2026-11-27','trade_date_type':'HALF'},{'time':'2026-11-30'}])
        self.daily=[{'time_key':'2026-11-06','close':100}]

    def test_calendar_weekend_holiday_half_day(self):
        self.assertEqual(self.cal.previous('2026-11-09'),'2026-11-06')
        self.assertEqual(self.cal.previous('2026-11-27'),'2026-11-25')
        self.assertEqual(self.cal.phase(dt('2026-11-27T18:01:00Z')),'POST')
        self.assertEqual(self.cal.phase(dt('2026-11-26T16:00:00Z')),'Closed')

    def test_quote_delayed_pre_post_missing_and_stale(self):
        now=dt('2026-11-09T15:00:00Z')
        q=quote('SPY',{'last_price':110,'update_time':'2026-11-09 09:45:00'},[],now,self.cal,self.daily)
        self.assertFalse(q['current']);self.assertEqual(q['status'],'Delayed');self.assertEqual(q['previousClose'],100)
        for at,phase in [('2026-11-09T13:00:00Z','PRE'),('2026-11-09T22:00:00Z','POST')]:
            q=quote('SPY',{},[{'time':at,'price':110}],dt(at),self.cal,self.daily)
            self.assertEqual(q['status'],phase)
        q=quote('SPY',{'last_price':110,'update_time':'2026-11-06 15:59:00'},[],now,self.cal,self.daily)
        self.assertFalse(q['comparable']);self.assertIsNone(q['previousClose'])
        q=quote('SPY',{'last_price':110,'update_time':'2026-11-09 09:59:59'},[],now,self.cal,[])
        self.assertIsNone(q['previousClose'])

    def test_close_requires_daily_verification(self):
        q=quote('SPY',{'last_price':110,'update_time':'2026-11-09 16:00:00'},[],dt('2026-11-09T22:00:00Z'),self.cal,
                self.daily+[{'time_key':'2026-11-09','close':110}])
        self.assertEqual(q['status'],'Close');self.assertEqual(q['previousClose'],100)

    def test_symbol_validation(self):
        for code in ['NVDA','IWM','AAPL','MSFT','AMZN','GOOGL','META','TSLA','QQQ','SPY','US.NVDA']:
            self.assertTrue(symbol_code(code)[1].startswith('US.'))
        self.assertEqual(symbol_code('SPX')[0],'SPXW')
        self.assertEqual(symbol_code('HK.00700'),('HK.00700','HK.00700'))
        for code in ['../secret','A<script>','', 'US.A/B']:
            with self.assertRaises(ValueError):symbol_code(code)

    def test_spxw_root_and_partial_zero(self):
        chain=contracts_from_chain('SPXW',[{'code':code,'option_type':side,'strike_time':'2026-11-09','strike_price':100}
               for code,side in [('US.SPXW261109C100000','CALL'),('US.SPXW261109P100000','PUT'),('US.SPX261109C100000','CALL')]])
        self.assertEqual(len(chain),2)
        c,p=chain
        row={'code':c,'option_contract_multiplier':100,'option_open_interest':0,'option_gamma':.1,'update_time':'2026-11-09 10:00:00'}
        cells,*_=summarize(chain,[row],100)
        self.assertEqual(cells[0]['call'],0);self.assertIsNone(cells[0]['put']);self.assertFalse(cells[0]['complete'])
        cells,*_=summarize(chain,[row,{**row,'code':p}],100)
        self.assertTrue(cells[0]['complete'])

    def test_expected_inputs_preserve_vendor_quotes_even_without_gex(self):
        contracts={'US.SPY261109C100000':('2026-11-09',100,'call')}
        row={'code':next(iter(contracts)),'bid_price':2,'ask_price':2.1,'option_implied_volatility':20,
             'update_time':'2026-11-09 10:00:00','option_contract_multiplier':100}
        cells,_,_,usable=summarize(contracts,[row],100)
        self.assertEqual(usable,0)
        q=cells[0]['callQuote']
        self.assertEqual((q['bid'],q['ask'],q['ivRaw'],q['iv']),(2,2.1,20,.2))
        self.assertEqual(q['at'],'2026-11-09T15:00:00+00:00')
        self.assertEqual(q['optionRoot'],'US.SPY')
        self.assertIsNone(cells[0]['call'])

    def test_implied_forward_not_real_cash(self):
        contracts={};rows=[]
        for k in [99,100,101]:
            for side in ['call','put']:
                code=f'{k}{side}';contracts[code]=('2026-11-09',k,side)
                mid=5+(100-k)/2 if side=='call' else 5-(100-k)/2
                rows.append({'code':code,'bid_price':mid-.1,'ask_price':mid+.1,'update_time':'2026-11-09 10:00:00'})
        q=implied_reference(contracts,rows,dt('2026-11-09T15:00:00Z'),self.cal)
        self.assertEqual(q['value'],100);self.assertEqual(q['status'],'REF');self.assertFalse(q['current'])

    def test_sqlite_restart_and_missing_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'history.sqlite3'
            store=SnapshotStore(path)
            self.assertEqual(store.history('SPY'),[])
            now=datetime.now(timezone.utc).isoformat(timespec='seconds')
            f={'symbol':'SPY','collectedAt':now,'usable':2,'cells':[{'strike':100,'expiry':'x'}],'bars':[1]}
            store.save(f);store.save(f)
            rows=SnapshotStore(path).history('SPY')
            self.assertEqual(len(rows),1);self.assertNotIn('bars',rows[0])

    def test_spx_cash_source_recovery_is_independent(self):
        class Provider:
            def __init__(self, result):self.result=result
            def get(self, symbol):return self.result
        fallback=Provider({'symbol':'SPXW','priceSymbol':'SPX','bars':[],'source':'OpenD'})
        cash=Provider({'priceSymbol':'SPX','bars':[{'o':1,'h':2,'l':1,'c':2}],'source':'authorized cash adapter'})
        route=RoutedPriceProvider(fallback,cash)
        self.assertEqual(route.get('SPXW')['source'],'authorized cash adapter')
        self.assertEqual(route.get('SPY')['source'],'OpenD')
        cash.result={'priceSymbol':'SPY','bars':[1]}
        self.assertEqual(route.get('SPXW')['bars'],[])

    def test_chain_success_survives_index_quote_failure(self):
        from market import ET, iso
        now=datetime.now(timezone.utc);day=now.astimezone(ET).date()
        expiry=str(day+__import__('datetime').timedelta(days=1))
        calendar=Calendar([{'time':str(day)},{'time':expiry}])
        chain={f'US.SPXW{day.strftime("%y%m%d")}{side[0].upper()}{strike}':(expiry,strike,side)
               for strike in [999,1000,1001] for side in ['call','put']}
        class Feed(OpenDFeed):
            def connect(self):pass
            def calendar(self,code,at):return calendar
            def chain(self,symbol,code,day):return chain,[expiry]
            def price(self,symbol):
                return {'spot':{'value':100} if symbol=='SPY' else None,'warnings':['cash index unavailable'],
                        'priceSymbol':'SPX','previousClose':None,'previousCloseDate':None,'bars':[]}
            def snapshots(self,codes):
                rows=[]
                for code in codes:
                    _,strike,side=chain[code]
                    mid=5+(1000-strike)/2 if side=='call' else 5-(1000-strike)/2
                    rows.append({'code':code,'bid_price':mid-.1,'ask_price':mid+.1,'update_time':iso(now),
                                 'option_contract_multiplier':100,'option_open_interest':10,'option_gamma':.01})
                return rows
        with tempfile.TemporaryDirectory() as tmp:
            feed=Feed(store=SnapshotStore(Path(tmp)/'s.db'))
            f=feed.collect('SPX')
            self.assertEqual(f['symbol'],'SPXW');self.assertEqual(f['spot']['value'],1000)
            self.assertEqual(f['spot']['status'],'REF');self.assertEqual(f['usable'],6);self.assertEqual(f['bars'],[])
            self.assertIs(feed.collect('SPXW'),f)

class HttpTests(unittest.TestCase):
    def test_loopback_origin_and_asset_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed=OpenDFeed(store=SnapshotStore(Path(tmp)/'s.db'))
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(handler(feed,PRIVATE_ORIGIN),directory='web'))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            def get(path,origin=None,host='127.0.0.1:8766'):
                conn=HTTPConnection('127.0.0.1',server.server_port);headers={'Host':host}
                if origin:headers['Origin']=origin
                conn.request('GET',path,headers=headers);r=conn.getresponse();r.read();conn.close();return r
            try:
                self.assertEqual(get('/').status,200)
                self.assertEqual(get('/',host='evil.example').status,403)
                self.assertEqual(get('/api/history?symbol=SPY',origin='https://evil.example').status,403)
                self.assertEqual(get('/api/history?symbol=SPY',origin=PRIVATE_ORIGIN).getheader('Access-Control-Allow-Origin'),PRIVATE_ORIGIN)
                self.assertEqual(get('/api/snapshot?symbol=../x').status,400)
                self.assertEqual(get('/data/captures.sqlite3').status,404)
            finally:server.shutdown();server.server_close();thread.join()

class ValidationTests(unittest.TestCase):
    def test_validation_never_waits_for_global_capture_lock_or_downloads_chain(self):
        from types import SimpleNamespace
        methods=[]
        class Validator:
            sdk=SimpleNamespace(SubType=SimpleNamespace(QUOTE='QUOTE'))
            ctx=SimpleNamespace(get_stock_quote='quote',get_option_expiration_date='dates')
            def connect(self):pass
            def subscribe(self,code,subtype):methods.append(('subscribe',code,subtype))
            def records(self,method,*args):
                methods.append((method,args))
                return [{'code':'US.NVDA','data_date':'2026-11-09','data_time':'16:00:00','last_price':200}] if method=='quote' else [{'strike_time':'2026-11-11'}]
        with tempfile.TemporaryDirectory() as tmp:
            feed=OpenDFeed(store=SnapshotStore(Path(tmp)/'s.db'));feed.validation_feed=Validator()
            values=[];feed.lock.acquire()
            worker=threading.Thread(target=lambda:values.append(feed.validate('nvda')))
            try:
                worker.start();worker.join(1)
                self.assertFalse(worker.is_alive(),'validation blocked by unrelated full capture')
            finally:feed.lock.release();worker.join(2)
            self.assertEqual(values[0]['symbol'],'NVDA');self.assertEqual(values[0]['code'],'US.NVDA')
            self.assertEqual(values[0]['dates'],['2026-11-11'])
            self.assertEqual([m[0] for m in methods],['subscribe','quote','dates'])
            self.assertTrue(feed.validate('US.NVDA')['cached'])

    def test_price_history_survives_restart_without_polluting_gex_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'s.db';store=SnapshotStore(path)
            now=datetime.now(timezone.utc).isoformat(timespec='seconds')
            store.save_price('NVDA',[{'at':now,'o':1,'h':2,'l':1,'c':2,'phase':'RTH'}],{'symbol':'NVDA','barMinutes':1,'source':'OpenD'})
            reopened=SnapshotStore(path)
            self.assertEqual(reopened.price_history('NVDA')['bars'][0]['c'],2)
            self.assertEqual(reopened.history('NVDA'),[])

    def test_requested_replay_date_is_available_beyond_recent_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=SnapshotStore(Path(tmp)/'s.db')
            now=datetime.now(timezone.utc)
            for i,day in enumerate(['2026-11-09','2026-11-10']):
                store.save({'symbol':'NVDA','collectedAt':(now+__import__('datetime').timedelta(seconds=i)).isoformat(),'usable':1,'sessionDate':day,'cells':[]})
            self.assertEqual(len(store.history('NVDA',limit=1)),1)
            historical=store.history('NVDA',limit=1,day='2026-11-09')
            self.assertEqual(len(historical),1);self.assertEqual(historical[0]['sessionDate'],'2026-11-09')

if __name__=='__main__':unittest.main()
