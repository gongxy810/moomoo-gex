import copy
import unittest
from zero_gamma import zero_gamma
from relay import summarize

AT='2026-11-13T19:28:00+00:00'
DAY='2026-11-13'

def volume_fixture(at=AT):
    cells=[]
    # net gamma*volume values -1 and +18 => 7540 + 5/19.
    for k,c,p in [(7535,0,5),(7540,0,1),(7545,18,0),(7550,30,0)]:
        cell={'strike':k,'expiry':DAY,'complete':True,'callOi':999,'putOi':999}
        for side,v in [('call',c),('put',p)]:
            cell[side+'Quote']={'side':side,'strike':k,'expiry':DAY,'optionRoot':'SPXW',
                'gamma':.01,'volume':v,'multiplier':100,'at':at}
        cells.append(cell)
    return {'symbol':'SPXW','collectedAt':at,'spot':{'value':7555.67,'status':'REF'},'dates':[DAY],
        'cells':cells,'sessionDate':DAY,'usable':8}

class VolumeZeroTests(unittest.TestCase):
    def calc(self,f=None,at=AT):return zero_gamma(f or volume_fixture(),['2026-11-16'],at)

    def test_linear_crossing_0dte_independent_of_filter_and_oi(self):
        f=volume_fixture();r=self.calc(f)
        self.assertTrue(r['available'],r)
        self.assertAlmostEqual(r['price'],7540+5/19,places=8)
        self.assertEqual(r['expiries'],[DAY])
        for c in f['cells']:c['callOi']=0;c['putOi']=1e12
        self.assertEqual(self.calc(f)['price'],r['price'])

    def test_next_expiry_never_substituted(self):
        f=volume_fixture()
        for c in f['cells']:c['expiry']='2026-11-16'
        self.assertFalse(self.calc(f)['available'])

    def test_missing_volume_and_invalid_inputs_no_oi_fallback(self):
        for key,value in [('volume',None),('volume',-1),('volume',.5),('gamma',None),
                          ('multiplier',10),('at','2026-11-13T19:29:00Z'),('at','2026-11-12T19:00:00Z')]:
            f=volume_fixture();f['cells'][1]['callQuote'][key]=value
            self.assertFalse(self.calc(f)['available'],(key,value))
        f=volume_fixture();f['collectedAt']='2026-11-13T19:29:00Z'
        self.assertFalse(self.calc(f)['available'])

    def test_replay_ny_date_and_no_prior_day_carry(self):
        f=volume_fixture()
        self.assertFalse(self.calc(f,'2026-11-14T15:00:00Z')['available'])
        f=volume_fixture('2026-11-14T00:00:00Z') # NY is still Nov 13.
        self.assertTrue(self.calc(f,'2026-11-14T00:00:00Z')['available'])

    def test_multiple_crossings_nearest_reference_only_negative_to_positive(self):
        f=volume_fixture()
        for cell,value in zip(f['cells'],[-1,1,-1,1]):
            cell['callQuote']['volume']=max(value,0);cell['putQuote']['volume']=max(-value,0)
        r=self.calc(f)
        self.assertEqual(r['roots'],[7537.5,7547.5]);self.assertEqual(r['price'],7547.5)

    def test_zero_volume_does_not_invent_unique_line(self):
        f=volume_fixture()
        for cell in f['cells']:
            for side in ('call','put'):cell[side+'Quote']['volume']=0
        self.assertFalse(self.calc(f)['available'])

    def test_collector_retains_supplier_volume_without_changing_oi_gex(self):
        contracts={'US.SPXW261113C7540000':(DAY,7540,'call')}
        row={'code':next(iter(contracts)),'option_gamma':.01,'option_open_interest':10,
            'option_contract_multiplier':100,'volume':18,'update_time':'2026-11-13 14:28:00'}
        cells,_,_,_=summarize(contracts,[row],7555)
        q=cells[0]['callQuote']
        self.assertEqual((q['volume'],q['gamma']),(18,.01))
        self.assertEqual(cells[0]['call'],.01*10*100*7555**2*.01)

if __name__=='__main__':unittest.main()
