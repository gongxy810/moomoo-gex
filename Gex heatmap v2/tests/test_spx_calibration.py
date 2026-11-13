import unittest
from spx_calibration import calibration_reference, advance_basis
from snapshots import SnapshotStore
from tempfile import TemporaryDirectory
from pathlib import Path
from contextlib import closing

class CalibrationTests(unittest.TestCase):
    def cells(self, expiry='2026-11-13', spread=.2):
        return [{'expiry':expiry,'strike':k,**{side+'Quote':{'optionRoot':'SPXW','bid':20+(7600-k if side=='call' else 0),
            'ask':20+(7600-k if side=='call' else 0)+spread,'at':'2026-11-12T15:00:00+00:00'} for side in ('call','put')}} for k in (7595,7600,7605)]
    def test_next_expiry_filters_and_forward_provenance(self):
        closes={'2026-11-13':'2026-11-13T21:00:00+00:00'}
        r=calibration_reference(self.cells(),'2026-11-12T15:00:10+00:00',closes)
        self.assertTrue(r['available']);self.assertEqual(r['pairs'],3)
        self.assertEqual(r['expiry'],'2026-11-13');self.assertAlmostEqual(r['value'],7600)
        self.assertFalse(calibration_reference(self.cells(spread=.41),'2026-11-12T15:00:10+00:00',closes)['available'])
        self.assertFalse(calibration_reference(self.cells(),'2026-11-12T15:02:00+00:00',closes)['available'])
        self.assertFalse(calibration_reference(self.cells('2026-11-12'),'2026-11-12T15:00:10+00:00',closes)['available'])
    def test_calendar_weekend_and_missing_settlement(self):
        cells=self.cells('2026-11-16')
        for c in cells:
            for side in ('call','put'):c[side+'Quote']['at']='2026-11-13T15:00:00+00:00'
        self.assertTrue(calibration_reference(cells,'2026-11-13T15:00:10+00:00',{'2026-11-16':'2026-11-16T21:00:00+00:00'})['available'])
        self.assertFalse(calibration_reference(cells,'2026-11-13T15:00:10+00:00',{})['available'])

    def test_causal_filter_step_and_preclose_lock(self):
        frame={'collectedAt':'2026-11-12T15:00:10+00:00','sessionClose':'2026-11-12T21:00:00+00:00',
               'calibration':{'available':True,'value':7603,'at':'2026-11-12T15:00:05+00:00','expiry':'2026-11-13'}}
        bars=[{'at':'2026-11-12T14:59:00+00:00','c':760}]
        initial=advance_basis(frame,bars,{})
        self.assertEqual(initial['basis'],3)
        jump={**frame,'collectedAt':'2026-11-12T15:00:20+00:00','calibration':{**frame['calibration'],'at':'2026-11-12T15:00:15+00:00','value':7700}}
        newer=advance_basis(jump,bars,initial);self.assertAlmostEqual(newer['basis'],3.2)
        self.assertEqual(initial['anchor']['basis'],3)  # no mutation of historical anchor
        late={**jump,'collectedAt':'2026-11-12T20:56:00+00:00'}
        self.assertEqual(advance_basis(late,bars,newer)['anchor'],newer['anchor'])

    def test_close_archive_survives_rolling_capture_removal(self):
        with TemporaryDirectory() as temp:
            store=SnapshotStore(Path(temp)/'test.sqlite3')
            frame={'symbol':'SPY','usable':1,'collectedAt':'2026-11-12T20:58:00+00:00','sessionDate':'2026-11-12',
                   'sessionClose':'2026-11-12T21:00:00+00:00','spot':{'status':'REF','value':750},'cells':[]}
            store.save(frame)
            with closing(store.connect()) as db, db:db.execute('DELETE FROM captures')
            saved=store.history('SPY')[0]
            self.assertEqual(saved['archiveKind'],'pre-close observed snapshot')
            self.assertEqual(saved['spot']['status'],'REF')

if __name__=='__main__':unittest.main()

