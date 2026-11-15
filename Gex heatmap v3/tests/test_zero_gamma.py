import unittest,math,copy
from zero_gamma import oi_gamma_flip as zero_gamma,bs_gamma,stamp,YEAR
from snapshots import SnapshotStore
from tempfile import TemporaryDirectory
from pathlib import Path

AT='2026-11-13T15:00:00+00:00'
EXP='2026-12-18'
END='2026-12-18T21:00:00+00:00'

def fixture():
    cells=[]
    for strike,call,put in [(90,0,100),(100,50,50),(110,100,0)]:
        cell={'strike':strike,'expiry':EXP,'callOi':call,'putOi':put,'call':100,'put':-50,'complete':True}
        for side in ('call','put'):cell[side+'Quote']={'side':side,'strike':strike,'expiry':EXP,'optionRoot':'US.SPY',
            'iv':.2,'ivRaw':20,'ivUnit':'fraction','at':AT,'multiplier':100}
        cells.append(cell)
    return {'symbol':'SPY','optionRoot':'US.SPY','collectedAt':AT,'spot':{'value':100,'status':'RTH'},'dates':[EXP],
        'cells':cells,'price':{'sessions':{EXP:END}},'usable':6,'sessionDate':'2026-11-13'}

class ZeroGammaTests(unittest.TestCase):
    def test_store_pins_snapshot_and_refuses_a_future_capture(self):
        with TemporaryDirectory() as temp:
            from test_volume_zero_gamma import volume_fixture
            store=SnapshotStore(Path(temp)/'s.db');store.save(volume_fixture(AT))
            r=store.zero_gamma('SPXW',[EXP],AT,AT)
            self.assertTrue(r['available']);self.assertEqual(r['capture_at'],AT)
            self.assertIs(store.zero_gamma('SPXW',[EXP],AT,AT),r)
            with self.assertRaises(ValueError):store.zero_gamma('SPXW',[EXP],'2026-11-13T14:59:00+00:00',AT)
            with self.assertRaises(ValueError):store.zero_gamma('SPXW',[EXP],AT,'2026-11-13T15:00:00')
    def test_gamma_matches_independent_price_finite_difference(self):
        def price(s):
            t=.1;vol=.2;d1=math.log(s/100)/(vol*math.sqrt(t))+vol*math.sqrt(t)/2;d2=d1-vol*math.sqrt(t)
            normal=lambda z:(1+math.erf(z/math.sqrt(2)))/2
            return s*normal(d1)-100*normal(d2)
        h=.01;numeric=(price(100+h)-2*price(100)+price(100-h))/h**2
        self.assertAlmostEqual(bs_gamma(100,100,.2,.1),numeric,delta=1e-7)

    def test_analytical_sign_changing_root_and_current_scope(self):
        frame=fixture();result=zero_gamma(frame,[EXP],AT)
        expected=math.sqrt(90*110)*math.exp(-.5*.2**2*(stamp(END)-stamp(AT))/YEAR)
        self.assertTrue(result['available'],result)
        self.assertAlmostEqual(result['price'],expected,delta=1e-6)
        self.assertLess(result['relative_residual'],1e-7)
        self.assertEqual((result['below_sign'],result['above_sign']),(-1,1))
        self.assertEqual(result['contracts'],4)

    def test_multiple_roots_are_reported_and_nearest_is_selected(self):
        f=fixture()
        for c,(call,put) in zip(f['cells'],[(100,0),(0,200),(100,0)]):c['callOi']=call;c['putOi']=put
        r=zero_gamma(f,[EXP],AT)
        self.assertTrue(r['available'],r);self.assertEqual(len(r['roots']),2)
        self.assertEqual(r['price'],min(r['roots'],key=lambda x:abs(x-100)))

    def test_incomplete_stale_invalid_and_future_data_are_not_silently_dropped(self):
        for change in ('iv','oi','complete','time','multiplier','future'):
            f=fixture();c=f['cells'][-1];q=c['callQuote']
            if change=='iv':q['iv']=None
            if change=='oi':c['callOi']=None
            if change=='complete':c['complete']=False
            if change=='time':q['at']='2026-11-13T14:00:00+00:00'
            if change=='multiplier':q['multiplier']=10
            if change=='future':q['at']='2026-11-13T15:01:00+00:00'
            self.assertFalse(zero_gamma(f,[EXP],AT,allow_surface=False)['available'],change)
        self.assertFalse(zero_gamma(fixture(),[EXP],'2026-11-13T14:59:00+00:00')['available'])
        self.assertFalse(zero_gamma(fixture(),[EXP],END)['available'])

    def test_balanced_identically_zero_and_single_direction_have_no_unique_line(self):
        f=fixture()
        for c in f['cells']:c['callOi']=c['putOi']=100
        self.assertFalse(zero_gamma(f,[EXP],AT)['available'])

    def test_surface_reconstructs_missing_side_iv_without_dropping_positive_oi(self):
        f=fixture();f['cells'][-1]['callQuote']['iv']=None
        r=zero_gamma(f,[EXP],AT)
        self.assertTrue(r['available'],r);self.assertEqual(r['contracts'],4)
        self.assertEqual(r['iv_reconstructed_contracts'],1)
        self.assertEqual(r['iv_surfaces'][EXP]['anchors'],3)
        for c in f['cells']:c['putOi']=0
        self.assertFalse(zero_gamma(f,[EXP],AT)['available'])

if __name__=='__main__':unittest.main()
