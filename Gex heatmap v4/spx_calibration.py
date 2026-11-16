"""Display-only SPXW forward calibration, independent of the GEX expiry filter."""
from datetime import datetime, timedelta
from statistics import median
from math import exp, isfinite
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
MODEL = 'spy10-next-expiry-basis-v1'

def parse(value):
    try:
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return at if at.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None

def calibration_reference(cells, received, closes=None, rate=.043):
    now = parse(received)
    unavailable = {'available':False, 'model':MODEL, 'reason':'No fresh next-expiry ATM call/put pairs with spread <= 0.40'}
    if now is None:
        return unavailable
    day = now.astimezone(ET).date().isoformat()
    readings = {}
    for cell in cells:
        expiry = cell.get('expiry', '')
        if expiry <= day or not isinstance(cell.get('strike'), (int, float)):
            continue
        sides = []
        for side in ('call', 'put'):
            q = cell.get(side+'Quote') or {}
            bid, ask, at = q.get('bid'), q.get('ask'), parse(q.get('at'))
            if q.get('optionRoot') != 'SPXW' or not all(isinstance(v, (float, int)) and isfinite(v) for v in (bid, ask)):
                break
            if bid <= 0 or ask < bid or ask-bid > .400001 or at is None or not -3 <= (now-at).total_seconds() <= 90:
                break
            sides.append(((bid+ask)/2, at, ask-bid))
        if len(sides) != 2 or abs((sides[0][1]-sides[1][1]).total_seconds()) > 30:
            continue
        close = parse((closes or {}).get(expiry))
        if close is None or not 0 < (close-now).total_seconds() <= 7*86400:
            continue
        c, p = sides
        years = (close-min(c[1],p[1])).total_seconds()/(365*86400)
        value = cell['strike']+(c[0]-p[0])*exp(rate*years)
        readings.setdefault(expiry, []).append((abs(c[0]-p[0]), cell['strike'], value, min(c[1],p[1])))
    for expiry, pairs in sorted(readings.items()):
        center = median(p[2] for p in sorted(pairs)[:5])
        pairs = [p for p in pairs if abs(p[1]-center) <= 15]
        if len(pairs) < 3 or max(p[2] for p in pairs)-min(p[2] for p in pairs) > 1.0:
            continue
        return {'available':True,'model':MODEL,'value':median(p[2] for p in pairs),
                'at':min(p[3] for p in pairs).isoformat(), 'receivedAt':received,
                'expiry':expiry,'pairs':len(pairs),'strikes':[p[1] for p in pairs],
                'rate':rate,'annualization':'ACT/365','quality':'Estimated option-implied forward; not cash SPX',
                'source':'SPXW next-expiry ATM call/put mids', 'maxSpread':.40}
    return unavailable

def advance_basis(frame, bars, state):
    """Causal per-session filter. Call once in capture order; persist its result."""
    received=parse(frame['collectedAt']);close=parse(frame.get('sessionClose'))
    state={**state,'processedAt':frame['collectedAt']}
    ref=frame.get('calibration') or calibration_reference(frame.get('cells',[]),frame['collectedAt'],(frame.get('price') or {}).get('sessions',{}))
    at=parse(ref.get('at'))
    if not ref.get('available') or not close or not at or received >= close - timedelta(minutes=5):
        return state
    if not 0 <= (received-at).total_seconds() <= 90 or at.astimezone(ET).date()!=received.astimezone(ET).date():return state
    ident=ref['at']+'|'+ref['expiry']
    if ident==state.get('quoteId'):return state
    spy=next((b for b in reversed(bars) if 0 <= (at-parse(b['at'])).total_seconds()-60 <= 90),None)
    if not spy:return state
    raw=ref['value']-10*spy['c']
    if not isfinite(raw) or abs(raw)>200:return state
    window=(state.get('window',[])+[raw])[-12:];target=median(window);previous=state.get('basis')
    basis=target if previous is None else max(previous-.2,min(previous+.2,target))
    anchor={'day':received.astimezone(ET).date().isoformat(),'basis':basis,'rawBasis':raw,'at':frame['collectedAt'],
            'quoted':ref['at'],'close':frame['sessionClose'],'ref':ref,'spy':spy['c']}
    return {**state,'basis':basis,'window':window,'quoteId':ident,'anchor':anchor}
