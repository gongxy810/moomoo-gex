import {aggregateBars, finite} from './model.js';

export const marketDate=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
export const lastBefore=(items,at,key='collectedAt')=>items.filter(v=>Date.parse(v[key])<=at).sort((a,b)=>Date.parse(a[key])-Date.parse(b[key])).at(-1)??null;
export function etTimestamp(date,time){
  const desired=Date.parse(`${date}T${time}:00Z`);let guess=desired;
  const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<3;i++){const local=Date.parse(fmt.format(guess).replace(' ','T')+'Z');guess+=desired-local;}
  return guess;
}

// Provider bars are stamped at OPEN. Replay never consumes an unfinished source bar.
// We deliberately show only completed target candles, even when 1m partial reconstruction is possible.
export function closedCandles(bars,minutes,sourceMinutes,cursor,session='ALL'){
  const eligible=bars.filter(b=>Date.parse(b.at)+sourceMinutes*60000<=cursor &&
    (session==='ALL'||(session==='EXT'?['PRE','POST'].includes(b.phase):b.phase===session)));
  return aggregateBars(eligible,minutes,sourceMinutes).filter(b=>(b.time+minutes*60)*1000<=cursor);
}

export function spotLabel(symbol,spot){
  if(!spot||!finite(spot.value))return '—';
  if(spot.estimated||spot.status==='REF'||spot.status==='Close'||
    (symbol==='SPXW'&&(!spot.current||/candle|close|forward/i.test(spot.source??spot.label??''))))return 'REF';
  return spot.current?'Spot':spot.status==='Delayed'?'Delayed':'REF';
}

export function frameAt(symbol,history,price,cursor){
  const day=marketDate(cursor);
  const capture=lastBefore(history.filter(f=>f.sessionDate===day&&(!f.optionLastAt||Date.parse(f.optionLastAt)<=cursor)),cursor);
  const sourceMinutes=price?.barMinutes??1;
  const closed=(price?.bars??[]).filter(b=>Date.parse(b.at)+sourceMinutes*60000<=cursor&&marketDate(Date.parse(b.at))===day);
  const lastBar=closed.at(-1);
  const snapshotSpot=capture?.spot&&Date.parse(capture.spot.at)<=cursor?capture.spot:null;
  let spot=snapshotSpot;
  if(lastBar&&(!spot||Date.parse(lastBar.at)+sourceMinutes*60000>Date.parse(spot.at))){
    const quoteAt=Date.parse(lastBar.at)+sourceMinutes*60000;
    spot={value:lastBar.c,at:new Date(quoteAt).toISOString(),phase:lastBar.phase,
      current:symbol!=='SPXW'&&cursor-quoteAt<=120000&&['RTH','PRE','POST'].includes(lastBar.phase),comparable:true,status:symbol==='SPXW'?'REF':'Replay',
      source:price.source+' historical OHLC close',label:'Historical candle close · Replay'};
  }
  if(spot&&cursor-Date.parse(spot.at)>120000)spot={...spot,current:false,status:spot.estimated?'REF':'Delayed'};
  const days=Object.keys(price?.sessions??{}).sort();
  const previous=days.filter(d=>d<day).at(-1)??(capture?.sessionDate===day?capture.previousSession:null);
  const prior=(price?.dailyCloses??[]).find(d=>d.date===previous)?.close??(price?.previousCloseDate===previous?price.previousClose:null)??(capture?.previousCloseDate===previous?capture.previousClose:null);
  return {...(capture??{}),symbol,source:capture?.source??'opend',priceSymbol:symbol==='SPXW'?'SPX':symbol,
    optionRoot:capture?.optionRoot??(symbol==='SPXW'?'SPXW':'US.'+symbol),sessionDate:day,
    collectedAt:new Date(cursor).toISOString(),captureAt:capture?.collectedAt??null,
    previousSession:previous,previousSessionClose:price?.sessions?.[previous]??capture?.previousSessionClose,
    sessionClose:price?.sessions?.[day]??capture?.sessionClose,
    previousClose:prior,previousCloseDate:prior?previous:null,
    previousCloseSource:price?.previousCloseDate===previous?price.previousCloseSource:capture?.previousCloseSource,
    previousCloseUrl:price?.previousCloseDate===previous?price.previousCloseUrl:capture?.previousCloseUrl,spot:spot??null,
    dates:capture?.dates??[],cells:capture?.cells??[],bars:closed,price,
    usable:capture?.usable??0,contracts:capture?.contracts??0,duration:capture?.duration??0,
    warnings:[...(capture?.warnings??[]),...(capture?[]:['历史 GEX 不可用：回放时点之前未采集期权快照'])],
    historyUnavailable:!capture};
}

export function snapshotTrail(history,minutes,cursor){
  const buckets=new Map();
  for(const frame of history){
    const at=Date.parse(frame.collectedAt);
    if(!Number.isFinite(at)||at>cursor||Date.parse(frame.optionLastAt)>cursor)continue;
    const bucket=[Math.floor(at/(minutes*60000)),frame.symbol,frame.optionRoot].join('|');
    const old=buckets.get(bucket);
    if(!old||Date.parse(old.collectedAt)<at)buckets.set(bucket,frame);
  }
  return [...buckets.values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
}

export function spotPosition(strikes,value,rowHeight){
  if(!strikes.length||!finite(value))return null;
  if(value>strikes[0]||value<strikes.at(-1))return null;
  for(let i=0;i<strikes.length;i++){
    if(value===strikes[i])return (i+.5)*rowHeight;
    if(i+1<strikes.length&&value<strikes[i]&&value>strikes[i+1])
      return (i+.5+(strikes[i]-value)/(strikes[i]-strikes[i+1]))*rowHeight;
  }
  return null;
}

export class ReplayClock{
  constructor(onChange){this.cursor=null;this.playing=false;this.speed=1;this.stepMs=300000;this.timer=null;this.onChange=onChange;}
  seek(at){this.pause();this.cursor=at;this.onChange(at);}
  step(){if(this.cursor===null)return;this.cursor+=this.stepMs;this.onChange(this.cursor);}
  play(){if(this.cursor===null||this.playing)return;this.playing=true;this.tick();}
  tick(){if(!this.playing)return;this.timer=setTimeout(()=>{this.step();this.tick();},1000/this.speed);}
  pause(){this.playing=false;clearTimeout(this.timer);}
  exit(){this.pause();this.cursor=null;this.onChange(null);}
}

// Each bar uses the most recent calibration already observed at its start.
// Persisted captures supply the rolling window after restart; no future anchor
// may translate the day's earlier candles or a Replay frame.
export function spxProxy(spyPrice, spxFrames, cutoff){
  const sourceMinutes=spyPrice?.barMinutes??1;
  const spyBars=(spyPrice?.bars??[]).filter(b=>[b.o,b.h,b.l,b.c].every(finite)&&Date.parse(b.at)<=cutoff)
    .sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(!spyBars.length)return {available:false,reason:'缺少 SPY 分钟 K 线'};
  const median=items=>{const s=[...items].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  const states=new Map(),anchors=[],seen=new Set();
  for(const frame of spxFrames??[])for(const saved of frame.basisHistory??[]){
    if(Date.parse(saved.at)<=cutoff&&!seen.has(saved.at)){
      seen.add(saved.at);anchors.push({...saved,at:Date.parse(saved.at),quoted:Date.parse(saved.quoted),close:Date.parse(saved.close)});
    }
  }
  for(const frame of [...(spxFrames??[])].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt))){
    if(Object.hasOwn(frame,'basisAnchor')){
      const saved=frame.basisAnchor;
      if(saved&&Date.parse(frame.collectedAt)<=cutoff&&Date.parse(saved.at)<=cutoff&&!seen.has(saved.at)){
        seen.add(saved.at);anchors.push({...saved,at:Date.parse(saved.at),quoted:Date.parse(saved.quoted),close:Date.parse(saved.close)});
      }
      continue;
    }
    const ref=frame.calibration,received=Date.parse(frame.collectedAt),quoted=Date.parse(ref?.at);
    if(frame.optionRoot!=='SPXW'||!ref?.available||ref.model!=='spy10-next-expiry-basis-v1'||
      !finite(ref.value)||!finite(received)||!finite(quoted)||received>cutoff||quoted>received||received-quoted>90000)continue;
    const day=marketDate(quoted),close=Date.parse(frame.sessionClose??spyPrice?.sessions?.[day]);
    if(day!==marketDate(received)||ref.expiry<=day||!finite(close)||received>=close-5*60000)continue;
    const id=`${quoted}|${ref.expiry}`;if(seen.has(id))continue;seen.add(id);
    const spy=spyBars.filter(b=>{const end=Date.parse(b.at)+sourceMinutes*60000;return end<=quoted&&quoted-end<=90000&&marketDate(end-1)===day;}).at(-1);
    if(!spy)continue;
    const raw=ref.value-10*spy.c;if(!finite(raw)||Math.abs(raw)>200)continue;
    let state=states.get(day);if(!state){state={values:[],basis:null};states.set(day,state);}
    // Median raw samples first, then limit movement per new observed sample.
    state.values.push(raw);state.values=state.values.slice(-12);
    const target=median(state.values),basis=state.basis===null?target:Math.max(state.basis-.20,Math.min(state.basis+.20,target));state.basis=basis;
    anchors.push({day,basis,rawBasis:raw,at:received,quoted,close,ref,spy:spy.c});
  }
  anchors.sort((a,b)=>a.at-b.at);
  const bars=[];let anchor=null,index=0,latest=null;
  for(const b of spyBars){
    const at=Date.parse(b.at),day=marketDate(at);
    while(index<anchors.length&&anchors[index].at<=at){anchor=anchors[index++];}
    if(!anchor||anchor.day!==day)continue;
    const basis=anchor.basis;
    bars.push({...b,o:b.o*10+basis,h:b.h*10+basis,l:b.l*10+basis,c:b.c*10+basis});latest=anchor;
  }
  if(!bars.length||!latest)return {available:false,reason:'缺少在该 K 线之前已记录的非当日到期 ATM 校准（双边价差 ≤0.40；不再回填 0DTE 比例）'};
  const locked=cutoff>=latest.close-5*60000||cutoff-latest.quoted>90000;
  const eth=cutoff>=latest.close;
  return {available:true,bars,barMinutes:sourceMinutes,priceSymbol:'SPX_PROXY',basis:latest.basis,
    refAt:new Date(latest.quoted).toISOString(),capturedAt:new Date(latest.at).toISOString(),
    refPrice:latest.ref.value,spyPrice:latest.spy,referenceExpiry:latest.ref.expiry,
    stale:cutoff-latest.quoted>90000,locked,quality:locked?(eth?'ETH · Locked Basis':'Locked Basis'):'Rolling Basis',
    model:'SPY × 10 + observed next-expiry basis · median 12 · max step 0.20 · lock RTH close−5m',
    source:'OpenD SPY + SPXW next-expiry basis proxy',calibrations:anchors.length,
    lastBarAt:bars.at(-1).at,reason:locked?'Calibration locked; SPY bars continue independently':null};
}


