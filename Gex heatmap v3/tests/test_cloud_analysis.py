import unittest,copy
from threading import Thread,Event
from tempfile import TemporaryDirectory
from pathlib import Path
from snapshots import SnapshotStore
from cloud_analysis import CloudAnalysis
from test_zero_gamma import fixture,AT,EXP,END

class CloudTests(unittest.TestCase):
    def test_queue_replaces_obsolete_cursor_and_prioritizes_replay_chart(self):
        engine=CloudAnalysis(None)
        # Suppress worker startup so admission and replacement are deterministic.
        engine.worker=object()
        args=['SPY',[EXP],AT,AT,'GEX',5,5,10,'ALL','chart']
        self.assertTrue(engine.request(*args,replay=True,client='tab')['pending'])
        args[2]='2026-11-13T16:30:00Z'
        engine.request(*args,replay=True,client='tab')
        self.assertEqual(len(engine.pending),1)
        self.assertEqual(next(iter(engine.pending.values()))[0][2],args[2])
        engine.running=next(iter(engine.pending.values()))[0]
        engine.request(*args,replay=True,client='tab')
        self.assertFalse(engine.pending)

    def test_old_archives_keep_verified_expiry_times_and_quote_iv_for_vex(self):
        with TemporaryDirectory() as folder:
            store=SnapshotStore(Path(folder)/'s.db');f=fixture()
            f.pop('expiryCloses',None);f['price']={'sessions':{EXP:END}}
            store.save(f)
            result=CloudAnalysis(store).compute('SPY',[EXP],AT,AT,'VEX',5,5,10,'ALL')
            self.assertTrue(result['available']);self.assertTrue(result['nodes'])
    def test_busy_analysis_has_no_obsolete_work_queue_and_cached_answers_stay_readable(self):
        engine=CloudAnalysis(None);entered=Event();release=Event()
        def slow(*args):entered.set();release.wait(2);return {'available':True}
        engine._compute=slow
        args=('SPY',[EXP],AT,AT,'GEX',5,5,10,'ALL')
        job=Thread(target=lambda:engine.compute(*args));job.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(engine.compute('QQQ',[EXP],AT,AT,'GEX',5,5,10,'ALL')['available'])
            key=('SPY',(EXP,),AT,AT,'VEX',5,5,10,'ALL','chart')
            engine.cache[key]={'available':True,'nodes':[1]}
            self.assertEqual(engine.compute('SPY',[EXP],AT,AT,'VEX',5,5,10,'ALL')['nodes'],[1])
        finally:release.set();job.join()
    def test_shared_engine_and_capture_cutoff_and_cache(self):
        with TemporaryDirectory() as folder:
            store=SnapshotStore(Path(folder)/'s.db');f=fixture();f['expiryCloses']={EXP:END}
            store.save(f);engine=CloudAnalysis(store)
            args=('SPY',[EXP],AT,AT,'GEX',5,5,10,'ALL')
            r=engine.compute(*args)
            self.assertTrue(r['available']);self.assertEqual(r['engine'],'shared-v3-cloud')
            self.assertTrue(r['nodes']);self.assertEqual(r['roles']['peak']['value'],50)
            self.assertIs(r,engine.compute(*args))
            self.assertFalse(engine.compute('SPY',[EXP],'2026-11-13T14:59:00Z',AT,'GEX',5,5,10,'ALL')['available'])
    def test_replay_never_returns_future_option_data(self):
        with TemporaryDirectory() as folder:
            store=SnapshotStore(Path(folder)/'s.db');f=fixture();f['optionLastAt']='2026-11-13T16:00:00Z';store.save(f)
            r=CloudAnalysis(store).compute('SPY',[EXP],AT,AT,'GEX',5,5,10,'ALL')
            self.assertFalse(r['available'])

if __name__=='__main__':unittest.main()
