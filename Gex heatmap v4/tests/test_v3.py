import unittest,math,sqlite3
from contextlib import closing
from tempfile import TemporaryDirectory
from pathlib import Path
from exposures import vex_cell
from snapshots import SnapshotStore

class V3Tests(unittest.TestCase):
    def test_vex_inputs_and_no_expiry_time_guess(self):
        c={'expiry':'2026-11-13','strike':100,'call':1000,'put':-600,'callIv':.2,'putIv':.2,'complete':True}
        f={'collectedAt':'2026-11-13T15:30:00Z','sessionDate':'2026-11-13','sessionClose':'2026-11-13T21:00:00Z','spot':{'value':100}}
        r=vex_cell(c,f);self.assertTrue(r['complete']);self.assertAlmostEqual(r['call'],1000*.1*5.5/(365*24))
        self.assertFalse(vex_cell({**c,'expiry':'2026-11-16'},f)['complete'])
        self.assertFalse(vex_cell(c,{**f,'collectedAt':f['sessionClose']})['complete'])
    def test_wal_and_retention_indexes_and_throttle(self):
        with TemporaryDirectory() as tmp:
            store=SnapshotStore(Path(tmp)/'test.db')
            with closing(store.connect()) as db, db:
                self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0],'wal')
                names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
                self.assertTrue({'captures_at_idx','price_bars_at_idx'}<=names)
                store.cleanup(db);last=store.last_cleanup;store.cleanup(db);self.assertEqual(store.last_cleanup,last)

if __name__=='__main__':unittest.main()
