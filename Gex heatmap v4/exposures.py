"""Local signed-OI Vanna estimate, per one absolute volatility percentage point.

Uses the supplied Gamma identity with explicit r=q=0, ACT/365 and observed IV.
It preserves the application's call+/put- inventory convention, not actual
dealer holdings. Missing exact expiry times are never replaced by calendar days.
"""
from datetime import datetime
from math import log,isfinite

def vex_cell(cell,frame):
    out=dict(cell)
    try:
        at=datetime.fromisoformat(frame['collectedAt'].replace('Z','+00:00'))
        end=(frame.get('expiryCloses') or {}).get(cell['expiry']) or (frame.get('price',{}).get('sessions') or {}).get(cell['expiry']) or (frame.get('sessionClose') if cell['expiry']==frame.get('sessionDate') else None)
        years=(datetime.fromisoformat(end.replace('Z','+00:00'))-at).total_seconds()/(365*86400)
        spot=frame['spot']['value'];strike=cell['strike']
    except (KeyError,TypeError,ValueError,AttributeError):years=-1;spot=strike=0
    for side in ('call','put'):
        iv=cell.get(side+'Iv') or (cell.get(side+'Quote') or {}).get('iv');gex=cell.get(side)
        valid=all(isinstance(v,(float,int)) and isfinite(v) for v in (iv,gex,spot,strike,years))
        out[side]=gex*(-(log(spot/strike)-.5*iv*iv*years)/iv) if valid and min(spot,strike,iv,years)>0 else None
    out['complete']=cell.get('complete') is not False and all(out[s] is not None for s in ('call','put'))
    return out
