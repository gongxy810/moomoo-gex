import unittest,copy
from tempfile import TemporaryDirectory
from pathlib import Path
from snapshots import SnapshotStore
from cloud_analysis import CloudAnalysis
from test_zero_gamma import fixture,AT,EXP,END

class CloudTests(unittest.TestCase):
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
