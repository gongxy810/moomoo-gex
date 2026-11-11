import {finite} from './model.js';
import {marketDate,closedCandles} from './replay.js';

export const MODEL_VERSION='opend-atm-paired-iv-act365-v1';
const YEAR=365*86400000;
const ms=value=>typeof value==='number'?value:Date.parse(value);
const iso=value=>finite(value)?new Date(value).toISOString():null;
const unavailable=(reason,extra={})=>({available:false,quality:'Unavailable',reason,...extra});
export const impliedWidth=(spot,iv,yearFraction)=>spot*iv*Math.sqrt(yearFraction);
const rootFor=frame=>frame.symbol==='SPXW'?'SPXW':'US.'+frame.symbol;
const rootMatches=(frame,root)=>frame.symbol==='SPXW'?['SPXW','US.SPXW'].includes(root):[frame.symbol,'US.'+frame.symbol].includes(root);

function usableQuote(q,side,frame,strike,expiry,at,policy){
  if(!q||q.side!==side||q.strike!==strike||q.expiry!==expiry||!rootMatches(frame,q.optionRoot))return {reason:'missing / mismatched contract quote'};
  if(frame.symbol==='SPXW'&&!/^US\.\.?SPXW\d{6}[CP]/i.test(q.code??''))return {reason:'not an SPXW PM contract'};
  const time=ms(q.at),age=at-time;
  if(!finite(time)||age<0||age>policy.ivMaxAge)return {reason:'stale / future option quote'};
  if(![q.bid,q.ask,q.iv].every(finite)||!(q.bid>0)||!(q.ask>0)||q.ask<q.bid)return {reason:'invalid / crossed bid-ask'};
  const mid=(q.bid+q.ask)/2;
  if((q.ask-q.bid)/mid>policy.maxSpreadRatio)return {reason:'bid-ask spread exceeds quality limit'};
  if(!(q.iv>0)||q.iv>5||q.ivUnit!=='fraction'||!finite(q.ivRaw)||Math.abs(q.ivRaw/100-q.iv)>1e-8)return {reason:'invalid vendor IV / percent normalization'};
  return {quote:{...q,mid,ageMs:age},reason:null};
}

export function openDExpected(frame,{at=Date.now(),horizon='today',expiry,settleAt,spotMaxAge=120000,ivMaxAge=120000,maxSpreadRatio=.35}={}){
  const symbol=frame?.symbol,spot=frame?.spot;
  const meta={provider:frame?.source==='demo'?'Synthetic':'OpenD',symbol:symbol==='SPXW'?'SPX':symbol,optionRoot:frame?.optionRoot??(symbol?rootFor(frame):null),asOf:iso(at),horizon,modelVersion:MODEL_VERSION};
  if(!frame||!symbol||!finite(at))return unavailable('Expected Move unavailable：没有行情快照或有效时点',meta);
  if(ms(frame.captureAt??frame.collectedAt)>at)return unavailable('Expected Move unavailable：快照晚于游标',meta);
  if(!rootMatches(frame,meta.optionRoot))return unavailable('Expected Move unavailable：价格标的与期权根不匹配',meta);
  if(!spot?.current||spot.estimated||spot.status==='REF'||!finite(spot.value)||!(spot.value>0)||!finite(ms(spot.at))||at-ms(spot.at)<0||at-ms(spot.at)>spotMaxAge)
    return unavailable(symbol==='SPXW'?'SPX unavailable：需要真实、有效的 SPX Spot，参考价不能生成现金指数边界':'Expected Move stale / unavailable：缺少新鲜有效 Spot',meta);
  const sessions={...frame.price?.sessions,...frame.sessions};
  if(frame.sessionDate&&frame.sessionClose)sessions[frame.sessionDate]=frame.sessionClose;
  const today=marketDate(at),dates=[...(frame.dates??[])].sort();
  if(horizon==='today')expiry=today;
  else if(horizon==='front')expiry=dates.find(d=>d>=today&&ms(sessions[d])>at);
  const end=ms(settleAt??sessions[expiry]);
  if(!expiry||!dates.includes(expiry)||!finite(end)||end<=at||marketDate(end)!==expiry||!finite(ms(sessions[expiry]))||end!==ms(sessions[expiry]))
    return unavailable(horizon==='today'?'Today unavailable：没有匹配今天收盘结算的有效合约，或已收盘':'Front unavailable：没有可核验的对应到期日 / 结算时点',{...meta,expiry:expiry??null,settleAt:finite(end)?iso(end):null});
  const policy={spotMaxAge,ivMaxAge,maxSpreadRatio};
  const forward=frame.forward;
  const reliableForward=forward?.current&&forward.value>0&&at-ms(forward.at)>=0&&at-ms(forward.at)<=spotMaxAge&&forward.expiry===expiry;
  const target=reliableForward?forward.value:spot.value;
  const candidates=[],rejected=[];
  for(const cell of frame.cells??[]){
    if(cell.expiry!==expiry||Math.abs(cell.strike/target-1)>.03)continue;
    const call=usableQuote(cell.callQuote,'call',frame,cell.strike,expiry,at,policy),put=usableQuote(cell.putQuote,'put',frame,cell.strike,expiry,at,policy);
    if(call.quote||put.quote)candidates.push({cell,quotes:[call.quote,put.quote].filter(Boolean),distance:Math.abs(cell.strike-target),reasons:[call.reason,put.reason].filter(Boolean)});
    else rejected.push({strike:cell.strike,reasons:[call.reason,put.reason]});
  }
  candidates.sort((a,b)=>b.quotes.length-a.quotes.length||a.distance-b.distance||a.cell.strike-b.cell.strike);
  const chosen=candidates[0];
  if(!chosen)return unavailable('Expected Move unavailable：ATM bid/ask、IV 或报价时间缺失 / 过旧 / 价差过宽',{...meta,expiry,settleAt:iso(end),rejected});
  const iv=chosen.quotes.reduce((total,q)=>total+q.iv,0)/chosen.quotes.length;
  const yearFraction=(end-at)/YEAR,move=impliedWidth(spot.value,iv,yearFraction);
  const cone={...meta,available:true,quality:chosen.quotes.length===2?'Estimated':'Approximate',qualityReasons:chosen.reasons,
    spot:spot.value,spotAsOf:spot.at,spotSource:spot.source??spot.label,sessionDate:today,expiry,settleAt:iso(end),iv,
    ivSource:'OpenD option_implied_volatility: vendor percent / 100',ivAsOf:iso(Math.min(...chosen.quotes.map(q=>ms(q.at)))),
    ivTimestampKind:'OpenD market-snapshot update_time; IV has no independent timestamp',
    yearFraction,timeBasis:'calendar ACT/365 approximation; vendor IV day-count not exposed',
    impliedHigh1:spot.value+move,impliedLow1:spot.value-move,impliedHigh2:spot.value+2*move,impliedLow2:spot.value-2*move,
    move,at,until:end,contracts:chosen.quotes,strike:chosen.cell.strike,
    selectionRule:`closest ${chosen.quotes.length===2?'paired call+put':'single valid side'} strike within 3% of ${reliableForward?'verified forward':'Spot'}; equal IV weights`,
    quotePolicy:policy,straddlePremium:chosen.quotes.length===2?chosen.quotes.reduce((sum,q)=>sum+q.mid,0):null,
    interpolation:'local square-root calendar-time interpolation; not a provider price path',captureAt:frame.captureAt??frame.collectedAt};
  cone.curves=coneCurves(cone);
  return cone;
}

export function coneCurves(cone){
  return [1,2].flatMap(sigma=>['high','low'].map(side=>{
    const end=cone[`implied${side==='high'?'High':'Low'}${sigma}`],distance=end-cone.spot;
    if(!finite(end))return null;
    return {sigma,side,points:Array.from({length:49},(_,i)=>{const ratio=i/48;return {time:Math.floor((cone.at+(cone.until-cone.at)*ratio)/1000),price:cone.spot+distance*Math.sqrt(ratio)};})};
  }).filter(Boolean));
}

export function frozenBoundary(cone,time,side,sigma=1){
  if(time<cone.at||time>cone.until)return null;
  const points=cone.curves.find(c=>c.side===side&&c.sigma===sigma)?.points??[];
  const t=time/1000;
  for(let i=1;i<points.length;i++)if(t<=points[i].time){const a=points[i-1],b=points[i],r=(t-a.time)/(b.time-a.time||1);return a.price+(b.price-a.price)*Math.max(0,Math.min(1,r));}
  return points.at(-1)?.price??null;
}

export function fixedDayRange(frame,history,at,stored=[]){
  if(!frame)return null;
  const close=ms(frame.previousSessionClose),end=ms(frame.sessionClose),day=frame.sessionDate;
  const cached=stored.find(r=>r.symbol===(frame.symbol==='SPXW'?'SPX':frame.symbol)&&r.rangeDate===day&&r.optionRoot===frame.optionRoot&&r.at===close&&r.until===end&&r.at<=at&&r.available&&r.modelVersion===MODEL_VERSION);
  if(cached)return cached;
  if(!finite(close)||!finite(end)||close>at||end<=close)return null;
  const snapshots=history.filter(f=>f.symbol===frame.symbol&&f.sessionDate===frame.previousSession&&ms(f.collectedAt)<=close&&close-ms(f.collectedAt)<=90000).sort((a,b)=>ms(b.collectedAt)-ms(a.collectedAt));
  for(const captured of snapshots){
    const input={...captured,price:{...captured.price,sessions:{...captured.price?.sessions,...frame.price?.sessions,[day]:frame.sessionClose}}};
    const cone=openDExpected(input,{at:close,horizon:'date',expiry:day,settleAt:frame.sessionClose});
    if(cone.available)return {...cone,rangeDate:day,kind:'fixed-day',pricedAt:cone.asOf,anchor:cone.spot,sourceCaptureAt:captured.collectedAt};
  }
  return null;
}

export function outsideDayRange(price,range,runningSigma=null){
  if(!range||!finite(price))return null;
  const upper=price>range.impliedHigh1,lower=price<range.impliedLow1;if(!upper&&!lower)return null;
  const boundary=upper?range.impliedHigh1:range.impliedLow1,distance=Math.abs(price-boundary);
  const width=upper?range.impliedHigh1-range.spot:range.spot-range.impliedLow1;
  const sigma=finite(runningSigma)?runningSigma:range.provider==='Tempest'?null:width>0?(price-range.spot)/width:null;
  return {side:upper?'Above':'Below',boundary,distance,sigma};
}

export function tempestRunningSigma(payload,{symbol,sessionDate,at}){
  const expected=symbol==='SPXW'?'SPX':symbol;
  const entries=Array.isArray(payload?.sigma)?payload.sigma:[payload?.sigma];
  const matches=entries.filter(item=>item?.symbol===expected&&item.session===sessionDate&&
    finite(item.running_sigma)&&finite(ms(item.asOf))&&ms(item.asOf)<=at&&at-ms(item.asOf)<=120000);
  return matches.sort((a,b)=>ms(b.asOf)-ms(a.asOf))[0]?.running_sigma??null;
}

export function coneHeld(records,dailyCloses,sessions,asOf,symbol,{provider='OpenD',modelVersion=MODEL_VERSION}={}){
  const byDay=new Map();
  for(const range of [...records].sort((a,b)=>a.at-b.at)){
    const date=range.rangeDate,end=ms(sessions?.[date]);
    if(range.symbol!==symbol||range.provider!==provider||range.modelVersion!==modelVersion||!date||range.kind!=='fixed-day'||!range.available||!finite(range.at)||range.at>=end||marketDate(range.at)>=date||end>asOf||!finite(end)||range.until!==end||byDay.has(date)||!(range.impliedHigh1>range.spot)||!(range.impliedLow1<range.spot))continue;
    const actual=dailyCloses.find(d=>d.date===date&&d.close>0);if(!actual)continue;
    byDay.set(date,{date,close:actual.close,high:range.impliedHigh1,low:range.impliedLow1,pricedAt:range.asOf,settleAt:range.settleAt,source:range.provider,hit:actual.close>=range.impliedLow1&&actual.close<=range.impliedHigh1});
  }
  const samples=[...byDay.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-252),hits=samples.filter(s=>s.hit).length;
  return {count:samples.length,hits,percent:samples.length?hits/samples.length*100:null,samples,rule:'up to 252 completed sessions; prior-close fixed ±1σ vs next RTH close; inclusive bounds; missing pairs omitted'};
}

export function pinScore(cone,bars,minutes,sourceMinutes,cursor){
  const eligible=closedCandles(bars,minutes,sourceMinutes,Math.min(cursor,cone.until)).filter(b=>(b.time+minutes*60)*1000>cone.at);
  let hits=0,firstOutside=null,firstTwoSigma=null;
  const samples=[];
  for(const bar of eligible){const time=(bar.time+minutes*60)*1000,hi=frozenBoundary(cone,time,'high'),lo=frozenBoundary(cone,time,'low');
    if(!finite(hi)||!finite(lo))continue;
    const inside=bar.close>=lo&&bar.close<=hi;if(inside)hits++;else firstOutside??=iso(time);
    const hi2=frozenBoundary(cone,time,'high',2),lo2=frozenBoundary(cone,time,'low',2);
    if((finite(hi2)&&bar.close>hi2)||(finite(lo2)&&bar.close<lo2))firstTwoSigma??=iso(time);
    samples.push({at:iso(time),close:bar.close,high:hi,low:lo,inside});
  }
  return {count:samples.length,hits,percent:samples.length?hits/samples.length*100:null,firstOutside,firstTwoSigma,ended:cursor>=cone.until,samples};
}

// Adapter for an already-authorized payload. No guessed vendor statistics or auth.
export function tempestExpected(payload,{symbol,at,horizon='today',spot,spotAsOf,sessionDate}){
  if(!payload)return unavailable('Tempest 未配置：没有获授权的数据',{provider:'Tempest'});
  const expected=symbol==='SPXW'?'SPX':symbol;
  if(!finite(at)||payload.symbol!==expected||payload.session!==sessionDate||!spot?.current||spot.estimated||spot.status==='REF'||!finite(spot.value)||spot.value<=0||!finite(ms(spotAsOf))||at-ms(spotAsOf)<0||at-ms(spotAsOf)>120000)
    return unavailable('Tempest unavailable：标的、会话或同时点真实 Spot 不匹配',{provider:'Tempest'});
  const item=Array.isArray(payload.horizons)?payload.horizons.find(h=>h?.name===horizon):null;
  if(!item||item.frozen||!finite(ms(item.priced_at))||!finite(ms(item.until))||ms(item.priced_at)>at||at-ms(item.priced_at)>120000||ms(item.until)<=at||Math.abs(ms(spotAsOf)-ms(item.priced_at))>30000||marketDate(ms(item.priced_at))!==sessionDate||(horizon==='today'&&marketDate(ms(item.until))!==sessionDate))
    return unavailable('Tempest stale / unavailable：horizon、时点或 frozen 状态无效',{provider:'Tempest'});
  const out={provider:'Tempest',symbol:expected,optionRoot:symbol==='SPXW'?'SPXW':'US.'+symbol,available:true,quality:'Provider',asOf:item.priced_at,at:ms(item.priced_at),until:ms(item.until),settleAt:item.until,
    sessionDate,horizon,expiry:marketDate(ms(item.until)),spot:spot.value,spotAsOf,iv:item.iv??null,ivSource:'Tempest authorized payload',ivAsOf:item.priced_at,yearFraction:(ms(item.until)-ms(item.priced_at))/YEAR,modelVersion:'tempest-provider-boundaries-v1',events:item.events??payload.events,tail_src:item.tail_src??payload.tail_src,
    interpolation:'local square-root interpolation between provider endpoints, not the official path'};
  for(const sigma of [1,2]){
    const up=item[`hi${sigma}`],dn=item[`lo${sigma}`],skew=item.skew??{};
    const unit=skew.unit==='percent'?.01:skew.unit==='fraction'?1:null;
    const upPct=skew[`up${sigma}_pct`],dnPct=skew[`dn${sigma}_pct`],symmetric=item[`sigma${sigma}_pct`];
    out[`impliedHigh${sigma}`]=finite(up)?up:unit!==null&&finite(upPct)?out.spot*(1+Math.abs(upPct)*unit):unit!==null&&finite(symmetric)?out.spot*(1+Math.abs(symmetric)*unit):null;
    out[`impliedLow${sigma}`]=finite(dn)?dn:unit!==null&&finite(dnPct)?out.spot*(1-Math.abs(dnPct)*unit):unit!==null&&finite(symmetric)?out.spot*(1-Math.abs(symmetric)*unit):null;
  }
  if(!(out.impliedHigh1>out.spot)||!(out.impliedLow1>0&&out.impliedLow1<out.spot))return unavailable('Tempest unavailable：1σ 边界 / 单位缺失',{provider:'Tempest'});
  // Missing provider 2σ stays missing; never fabricate vendor endpoints.
  if((out.impliedHigh2!==null&&out.impliedHigh2<out.impliedHigh1)||(out.impliedLow2!==null&&(out.impliedLow2>out.impliedLow1||out.impliedLow2<=0)))return unavailable('Tempest unavailable：2σ 边界顺序无效',{provider:'Tempest'});
  out.curves=coneCurves(out);return out;
}

export function tempestDayRange(payload,{symbol,sessionDate,at}){
  const s=symbol==='SPXW'?'SPX':symbol,item=Array.isArray(payload?.levels)?payload.levels.find(l=>l?.name==='day'):null;
  if(!finite(at)||payload?.symbol!==s||payload?.session!==sessionDate||!item||!item.frozen||!finite(ms(item.priced_at))||!finite(ms(item.until))||ms(item.priced_at)>at||marketDate(ms(item.until))!==sessionDate||marketDate(ms(item.priced_at))>=sessionDate||ms(item.priced_at)>=ms(item.until))return null;
  if(![item.anchor,item.hi1,item.lo1].every(v=>finite(v)&&v>0))return null;
  if(!(item.hi1>item.anchor&&item.lo1<item.anchor)||
    (item.hi2!=null&&(!finite(item.hi2)||item.hi2<item.hi1))||
    (item.lo2!=null&&(!finite(item.lo2)||item.lo2>item.lo1||item.lo2<=0)))return null;
  return {provider:'Tempest',symbol:s,optionRoot:symbol==='SPXW'?'SPXW':'US.'+symbol,available:true,kind:'fixed-day',quality:'Provider',rangeDate:sessionDate,spot:item.anchor,anchor:item.anchor,asOf:item.priced_at,at:ms(item.priced_at),until:ms(item.until),settleAt:item.until,
    impliedHigh1:item.hi1,impliedLow1:item.lo1,impliedHigh2:item.hi2??null,impliedLow2:item.lo2??null,modelVersion:'tempest-fixed-provider-v1',events:item.events??payload.events,tail_src:item.tail_src??payload.tail_src};
}
