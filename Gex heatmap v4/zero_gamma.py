"""Zero of a repriced signed OI gamma profile; never a cumulative-strike zero.

Model: European Black-Scholes, sticky contract IV, explicit r=q=0,
ACT/365, call-positive/put-negative OI. ETF exercise/dividend effects and
uncollected chain wings are not observable here: the output is Estimated.
"""
from datetime import datetime
from math import exp, log, sqrt, isfinite, fsum, pi
from bisect import bisect_left
from zoneinfo import ZoneInfo

VERSION='bs-sticky-iv-surface-zero-carry-v2'
YEAR=365*86400

def stamp(value):
    try:
        result=datetime.fromisoformat(value.replace('Z','+00:00'))
        return result.timestamp() if result.tzinfo else None
    except (ValueError,AttributeError,TypeError):return None

def number(value):return isinstance(value,(float,int)) and not isinstance(value,bool) and isfinite(value)

def bs_gamma(spot,strike,iv,years,rate=0,dividend=0):
    if min(spot,strike,iv,years)<=0:return None
    width=iv*sqrt(years)
    d1=(log(spot/strike)+(rate-dividend)*years)/width+width/2
    return exp(-dividend*years-d1*d1/2)/(sqrt(2*pi)*spot*width)

def zero_gamma(frame,expiries,asof):
    """0DTE session-volume GEX, adjacent negative-to-positive linear crossing.

    Expiry is deliberately independent of the heatmap filter and proxy basis.
    No OI fallback, fabricated historical volume, or gex.bot parity claim.
    """
    at,captured=stamp(asof),stamp(frame.get('collectedAt'))
    day=datetime.fromtimestamp(at,ZoneInfo('America/New_York')).date().isoformat() if at is not None else None
    symbol=frame.get('symbol');spot=(frame.get('spot') or {}).get('value')
    result={'available':False,'quality':'Estimated','model':'0dte-volume-linear-v1','symbol':symbol,
        'asof':asof,'capture_at':frame.get('collectedAt'),'expiries':[day] if day else [],'roots':[],
        'definition':'adjacent 0DTE strike net Volume GEX negative-to-positive linear zero',
        'assumptions':{'weight':'session cumulative option volume; never OI + volume','call_sign':1,'put_sign':-1,
            'expiry':'New York cutoff date only; independent of heatmap expiry / proxy calibration',
            'interpolation':'linear between adjacent observed strikes; no bridging missing quotes',
            'scope':'all captured 0DTE strikes, not the full exchange chain',
            'gamma':'OpenD snapshot option_gamma, without hypothetical-spot repricing'},
        'root_selection':'nearest price reference; ties prefer larger combined absolute endpoint GEX',
        'price_reference':spot,'price_reference_kind':(frame.get('spot') or {}).get('status'),
        'requested_heatmap_expiries':sorted(set(expiries))}
    def fail(reason):return {**result,'reason':reason}
    if at is None or captured is None or captured>at:return fail('快照晚于截止时间或时间戳无效')
    if datetime.fromtimestamp(captured,ZoneInfo('America/New_York')).date().isoformat()!=day:
        return fail('没有回放截止日期当天采集的 Volume 快照')
    if not number(spot) or spot<=0:return fail('缺少有效价格参考；无法选择最近的翻转点')
    cells=sorted((c for c in frame.get('cells',[]) if c.get('expiry')==day),key=lambda c:c.get('strike') or 0)
    if not cells:return fail(f'没有 {day} 当日 0DTE 快照；不会改用下一到期日')
    profile=[];missing=[];ages=[];contracts=0
    expected_roots={'SPXW','US.SPXW'} if symbol=='SPXW' else {symbol,'US.'+str(symbol)}
    for cell in cells:
        k=cell.get('strike');amounts=[]
        if not number(k) or k<=0:return fail('无效行权价')
        for side,sign in [('call',1),('put',-1)]:
            q=cell.get(side+'Quote') or {};v,g,m=q.get('volume'),q.get('gamma'),q.get('multiplier');quoted=stamp(q.get('at'))
            if (q.get('side')!=side or q.get('strike')!=k or q.get('expiry')!=day or q.get('optionRoot') not in expected_roots
                or not number(v) or v<0 or v!=int(v) or not number(g) or g<0 or m!=100 or quoted is None or quoted>at
                or datetime.fromtimestamp(quoted,ZoneInfo('America/New_York')).date().isoformat()!=day):
                missing.append(f'{k:g} {side}');continue
            amount=sign*g*v*m*spot**2*.01
            if not isfinite(amount):return fail('Volume GEX 数值无效')
            amounts.append(amount);ages.append(at-quoted);contracts+=1
        if len(amounts)==2:profile.append({'strike':k,'net_gex':fsum(amounts)})
    result.update({'contracts':contracts,'invalid_contracts':len(missing),'profile':profile,
        'search_range':[cells[0]['strike'],cells[-1]['strike']],
        'max_quote_age_seconds':max(ages) if ages else None})
    if missing:return fail(f'0DTE Volume / Gamma / 同日时间戳缺失或无效（{len(missing)} 项）；旧存档无法回填成交量')
    if len({p['strike'] for p in profile})!=len(profile):return fail('重复 strike；需要先对齐唯一标准合约')
    candidates=[]
    for a,b in zip(profile,profile[1:]):
        x,y=a['net_gex'],b['net_gex']
        if x<0<y:
            price=a['strike']+(b['strike']-a['strike'])*abs(x)/(abs(x)+abs(y))
            candidates.append({'price':price,'lower':a,'upper':b,'strength':abs(x)+abs(y)})
    # An exact observed zero is valid only when bracketed by negative / positive
    # neighbors. Multiple zero-volume strikes do not invent a unique crossing.
    for a,b,c in zip(profile,profile[1:],profile[2:]):
        if a['net_gex']<0 and b['net_gex']==0 and c['net_gex']>0:
            candidates.append({'price':b['strike'],'lower':a,'upper':c,'strength':abs(a['net_gex'])+abs(c['net_gex'])})
    if not candidates:return fail('当日已采集 Volume GEX 中没有下负上正的相邻翻转点')
    chosen=min(candidates,key=lambda c:(abs(c['price']-spot),-c['strength'],c['price']))
    return {**result,'available':True,'reason':None,'price':chosen['price'],
        'roots':sorted(c['price'] for c in candidates),'candidates':candidates,'selected':chosen,
        'below_sign':-1,'above_sign':1,'brackets':[[c['lower']['strike'],c['upper']['strike']] for c in candidates],
        'sampling':'observed adjacent strikes; linear interpolation'}


def oi_gamma_flip(frame,expiries,asof,allow_surface=True):
    at=stamp(asof);captured=stamp(frame.get('collectedAt'))
    selected=sorted(set(expiries));symbol=frame.get('symbol');spot=(frame.get('spot') or {}).get('value')
    result={'available':False,'quality':'Estimated','model':VERSION,'symbol':symbol,'expiries':selected,
        'asof':asof,'capture_at':frame.get('collectedAt'),'roots':[],
        'assumptions':{'rate':0,'dividend_yield':0,'day_count':'ACT/365','volatility':'sticky OTM-preferred expiry IV surface; log-strike total-variance interpolation; flat IV wings' if allow_surface else 'strict observed contract IV',
            'call_sign':1,'put_sign':-1,'scope':'all captured strikes in selected expiries; not the full exchange chain',
            'exercise':'European approximation; ETF American exercise/dividends not modeled'},
        'definition':'sum(sign * BS_gamma(S) * OI * multiplier * S^2 * 0.01) = 0'}
    def fail(reason):return {**result,'reason':reason}
    if at is None or captured is None or captured>at:return fail('快照晚于截止时间或时间戳无效')
    if not selected or not set(selected)<=set(frame.get('dates',[])):return fail('没有匹配的到期日快照')
    if not number(spot) or spot<=0:return fail('缺少有效价格锚点')
    sessions={**(frame.get('price') or {}).get('sessions',{}),**frame.get('sessions',{})}
    if frame.get('sessionDate') and frame.get('sessionClose'):sessions[frame['sessionDate']]=frame['sessionClose']
    active=[]
    for expiry in selected:
        end=stamp(sessions.get(expiry))
        if end is None:return fail('到期结算时间不可验证：'+expiry)
        if end>at:active.append(expiry)
    result['expired_excluded']=[d for d in selected if d not in active]
    if not active:return fail('所选合约均已到期，不能沿用到期前的零点')
    cells=[c for c in frame.get('cells',[]) if c.get('expiry') in active]
    if set(c.get('expiry') for c in cells)!=set(active):return fail('所选到期日合约不完整')
    def valid_iv(q):
        iv,raw,quoted=q.get('iv'),q.get('ivRaw'),stamp(q.get('at'))
        return number(iv) and 0<iv<=5 and number(raw) and q.get('ivUnit')=='fraction' and abs(raw/100-iv)<=1e-8 and quoted is not None and 0<=at-quoted<=900
    surfaces={}
    if allow_surface:
        for expiry in active:
            anchors=[];years=(stamp(sessions[expiry])-at)/YEAR
            for c in cells:
                if c['expiry']!=expiry or not number(c.get('strike')) or c['strike']<=0:continue
                preferred='put' if c['strike']<spot else 'call'
                for side in [preferred,'call' if preferred=='put' else 'put']:
                    q=c.get(side+'Quote') or {}
                    roots=['SPXW','US.SPXW'] if symbol=='SPXW' else [symbol,'US.'+str(symbol)]
                    if q.get('side')==side and q.get('strike')==c['strike'] and q.get('expiry')==expiry and q.get('optionRoot') in roots and q.get('multiplier')==100 and valid_iv(q):
                        anchors.append((log(c['strike']),q['iv']**2*years));break
            anchors=sorted(dict(anchors).items())
            if len(anchors)<3:return fail('新鲜 IV 曲线锚点不足：'+expiry)
            surfaces[expiry]=anchors
        result['iv_surfaces']={e:{'anchors':len(a),'strike_range':[exp(a[0][0]),exp(a[-1][0])]} for e,a in surfaces.items()}
    derived=0;wing=0
    terms=[];invalid=[];strikes=[]
    for cell in cells:
        strike=cell.get('strike');expiry=cell['expiry']
        if not number(strike) or strike<=0 or cell.get('complete') is False:
            invalid.append('incomplete cell');continue
        for side,sign in [('call',1),('put',-1)]:
            oi=cell.get(side+'Oi');q=cell.get(side+'Quote') or {}
            if not number(oi) or oi<0 or oi!=int(oi):invalid.append('invalid OI');continue
            if oi==0:continue
            iv=q.get('iv');raw=q.get('ivRaw');quoted=stamp(q.get('at'));mult=q.get('multiplier')
            root=q.get('optionRoot');expected=['SPXW','US.SPXW'] if symbol=='SPXW' else [symbol,'US.'+str(symbol)]
            if q.get('side')!=side or q.get('strike')!=strike or q.get('expiry')!=expiry or root not in expected:
                invalid.append('mismatched quote');continue
            if allow_surface:
                anchors=surfaces[expiry];xs=[x for x,v in anchors];x=log(strike);i=bisect_left(xs,x)
                if i==0:variance=anchors[0][1];wing+=int(x<xs[0])
                elif i==len(anchors):variance=anchors[-1][1];wing+=1
                else:
                    a,va=anchors[i-1];b,vb=anchors[i];variance=va+(vb-va)*(x-a)/(b-a)
                iv=sqrt(variance/((stamp(sessions[expiry])-at)/YEAR));derived+=int(not valid_iv(q))
            elif not number(iv) or not 0<iv<=5 or not number(raw) or q.get('ivUnit')!='fraction' or abs(raw/100-iv)>1e-8:
                invalid.append('missing/invalid IV');continue
            if not allow_surface and (quoted is None or quoted>at or at-quoted>900):
                invalid.append('stale/future IV');continue
            if not number(mult) or mult!=100:invalid.append('unsupported multiplier');continue
            years=(stamp(sessions[expiry])-at)/YEAR;width=iv*sqrt(years)
            if width<=1e-12:invalid.append('degenerate IV/time width');continue
            # Removing the common positive S*0.01/sqrt(2*pi) factor gives
            # the same zero. Log-sum-exp prevents underflow from creating roots.
            terms.append((sign,log(oi*mult/width),log(strike)-width*width/2,width))
            strikes.append(strike)
    result.update({'contracts':len(terms),'invalid_contracts':len(invalid),'active_expiries':active,
        'iv_reconstructed_contracts':derived,'flat_wing_contracts':wing,
        'price_reference':spot,'price_reference_kind':(frame.get('spot') or {}).get('status'),
        'diagnostics':{reason:invalid.count(reason) for reason in set(invalid)}})
    if invalid:return fail('正 OI 合约的 IV / 时间 / 完整性不足（'+str(len(invalid))+' 项）；不以部分集合伪造零点')
    if not terms or len(set(strikes))<3:return fail('有效合约或 Strike 覆盖不足')
    if len({t[0] for t in terms})<2:return fail('所选集合只有单方向 Gamma，没有变号零点')
    low=max(min(strikes),spot*.8);high=min(max(strikes),spot*1.2)
    if allow_surface:
        low=max(low,max(exp(a[0][0]) for a in surfaces.values()))
        high=min(high,min(exp(a[-1][0]) for a in surfaces.values()))
    result['search_range']=[low,high]
    if low>=high:return fail('采样 Strike 范围没有包围可搜索价格')
    lo,hi=log(low),log(high)
    def evaluate(x):
        logs=[weight-.5*((x-center)/width)**2 for sign,weight,center,width in terms]
        peak=max(logs);values=[exp(v-peak) for v in logs]
        signed=fsum(t[0]*v for t,v in zip(terms,values));gross=fsum(values)
        return signed/gross
    grid={lo+(hi-lo)*i/512 for i in range(513)}
    # Extra points resolve narrow near-expiry peaks that a uniform grid misses.
    for sign,weight,center,width in terms:
        for z in (-4,-2,-1,-.5,0,.5,1,2,4):
            x=center+z*width
            if lo<x<hi:grid.add(x)
    grid=sorted(grid);values=[evaluate(x) for x in grid]
    if max(abs(v) for v in values)<1e-10:return fail('模型在搜索区间内恒零，无法定义唯一 Zero Gamma')
    roots=[]
    brackets=[]
    nonzero=[(x,v) for x,v in zip(grid,values) if abs(v)>1e-12]
    for (a,fa),(b,fb) in zip(nonzero,nonzero[1:]):
        if fa*fb>=0:continue
        left,right=a,b
        for _ in range(80):
            mid=(left+right)/2;fm=evaluate(mid)
            if abs(fm)<1e-12: left=right=mid;break
            if fa*fm<0:right=mid
            else:left=mid;fa=fm
        root=exp((left+right)/2)
        if roots and abs(root-roots[-1])<max(.00001,root*1e-8):continue
        if abs(evaluate(log(root)))>1e-7:continue
        roots.append(root);brackets.append([exp(a),exp(b)])
    if not roots:return fail('已采集 Strike 范围内没有可信的 GEX 变号零交点')
    chosen=min(roots,key=lambda x:abs(x-spot));epsilon=max(chosen*1e-6,.0001)
    return {**result,'available':True,'reason':None,'roots':roots,'price':chosen,
        'brackets':brackets,'relative_residual':abs(evaluate(log(chosen))),
        'below_sign':1 if evaluate(log(max(low,chosen-epsilon)))>0 else -1,
        'above_sign':1 if evaluate(log(min(high,chosen+epsilon)))>0 else -1,
        'root_selection':'nearest price reference among all detected sign-changing roots',
        'sampling':'512 log-price intervals plus per-contract IV-width knots; bisection, residual <=1e-7'}
