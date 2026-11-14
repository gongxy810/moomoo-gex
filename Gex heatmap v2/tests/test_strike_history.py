import unittest,json
from pathlib import Path
from tempfile import TemporaryDirectory
from datetime import datetime
from contextlib import closing
from snapshots import SnapshotStore
from strike_history import hover_payload

def ms(time):return int(datetime.fromisoformat('2026-11-12T'+time+'-05:00').timestamp()*1000)

class StrikeHistoryTests(unittest.TestCase):
    def test_signed_change_open_fallback_and_tolerance(self):
        data=hover_payload('SPY',['2026-11-12'],750,'2026-11-12',ms('10:20:00'),
            [(ms('09:30:00'),1e9),(ms('10:00:00'),-2e9),(ms('10:20:00'),-6e9)])
        a,b,c,d=data['changes']
        self.assertEqual(a['signed_delta'],-4e9);self.assertEqual(a['pct_change'],-200)
        self.assertEqual(a['baseline_at'],ms('10:00:00'));self.assertEqual(c['label'],'4H')
        self.assertIsNone(c['signed_delta']);self.assertEqual(d['label'],'OPEN')
        self.assertEqual(d['signed_delta'],-7e9);self.assertEqual(data['direction'],'NET SHORT γ')
        later=hover_payload('SPY',['d'],750,'2026-11-12',ms('14:30:00'),[(ms('09:30:00'),10),(ms('10:30:00'),6),(ms('14:30:00'),2)])
        self.assertEqual(later['changes'][2]['signed_delta'],-4);self.assertEqual(later['changes'][3]['signed_delta'],-8)
        sparse=hover_payload('SPY',['d'],750,'2026-11-12',ms('11:30:00'),[(ms('09:30:00'),1),(ms('11:30:00'),2)])
        self.assertIsNone(sparse['changes'][0]['signed_delta'])
        zero=hover_payload('SPY',['d'],750,'2026-11-12',ms('09:45:00'),[(ms('09:30:00'),0),(ms('09:45:00'),2)])
        self.assertEqual(zero['changes'][0]['signed_delta'],2);self.assertIsNone(zero['changes'][0]['pct_change'])
        self.assertTrue(zero['changes'][0]['zero_baseline'])

    def test_index_backfill_expiry_scope_and_replay_inside_minute(self):
        with TemporaryDirectory() as temp:
            store=SnapshotStore(Path(temp)/'s.db')
            def frame(time,values):
                return {'symbol':'SPY','sessionDate':'2026-11-12','collectedAt':'2026-11-12T'+time+'-05:00','usable':1,
                    'cells':[{'expiry':expiry,'strike':750,'call':max(value,0),'put':min(value,0),'complete':True} for expiry,value in values]}
            old=frame('10:00:10',[('2026-11-12',10),('2026-11-13',-3)])
            with closing(store.connect()) as db,db:db.execute('INSERT INTO captures VALUES (?,?,?)',('SPY',old['collectedAt'],json.dumps(old)))
            store.save(frame('10:00:50',[('2026-11-12',20),('2026-11-13',-5)]))
            store.save(frame('10:01:00',[('2026-11-12',100)]))
            replay=store.strike_history('SPY',['2026-11-12','2026-11-13'],750,'2026-11-12','2026-11-12T10:00:30-05:00')
            self.assertEqual(replay['net_gex'],7);self.assertEqual(len(replay['sparkline_points']),1)
            live=store.strike_history('SPY',['2026-11-12','2026-11-13'],750,'2026-11-12','2026-11-12T10:02:00-05:00')
            self.assertEqual(live['net_gex'],15);self.assertEqual(len(live['sparkline_points']),1) # no partial expiry sum
            single=store.strike_history('SPY',['2026-11-12'],750,'2026-11-12','2026-11-12T10:02:00-05:00')
            self.assertEqual(single['net_gex'],100)
            restored=SnapshotStore(Path(temp)/'s.db').strike_history('SPY',['2026-11-12'],750,'2026-11-12','2026-11-12T10:00:30-05:00')
            self.assertEqual(restored['net_gex'],10)
            empty=store.strike_history('SPY',['2026-11-12'],750,'2026-11-12','2026-11-12T09:00:00-05:00')
            self.assertIsNone(empty['net_gex']);self.assertEqual(empty['sparkline_points'],[])

if __name__=='__main__':unittest.main()
