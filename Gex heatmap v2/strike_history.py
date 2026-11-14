"""Observed strike exposures; missing minutes are never interpolated."""
from datetime import datetime
from zoneinfo import ZoneInfo
from bisect import bisect_right

def hover_payload(symbol, expiries, strike, day, asof, observations):
    times=[t for t,v in observations]
    current=observations[-1] if observations else None
    opened=int(datetime.fromisoformat(day+'T09:30:00').replace(tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
    first_open=next((p for p in observations if p[0]>=opened),observations[0] if observations else None)
    changes=[]
    for label,minutes in [('15M',15),('1H',60),('4H',240),('OPEN',None)]:
        target=opened if minutes is None else asof-minutes*60000;index=bisect_right(times,target)-1
        base=first_open if minutes is None else observations[index] if index>=0 and target-times[index]<=15*60000 else None
        fallback=False
        if minutes is None:fallback=base is not None
        elif minutes!=240 and current and first_open and base is None and target<opened:
            base=first_open;fallback=True
        delta=current[1]-base[1] if current and base else None
        changes.append({'window':label,'label':label,'target_at':target,
            'baseline_at':base[0] if base else None,'baseline_value':base[1] if base else None,
            'signed_delta':delta,'pct_change':delta/abs(base[1])*100 if base and base[1]!=0 else None,
            'reason':None if base else 'No prior sample within 15 minutes of target',
            'zero_baseline':bool(base and base[1]==0),'fallback_open':fallback})
    buckets={}
    for t,v in observations:buckets[t//60000]={'timestamp':t,'net_gex':v}
    return {'symbol':symbol,'expiries':expiries,'strike':strike,'session_date':day,'asof':asof,
        'net_gex':current[1] if current else None,'snapshot_at':current[0] if current else None,
        'direction':('NET LONG γ' if current[1]>=0 else 'NET SHORT γ') if current else None,
        'sparkline_points':list(buckets.values()),'sample_interval':'1M','changes':changes,
        'quality':'Observed OI-based signed GEX; not verified dealer holdings',
        'lookup_tolerance_minutes':15,'reason':None if current else 'No complete strike history before cutoff'}
