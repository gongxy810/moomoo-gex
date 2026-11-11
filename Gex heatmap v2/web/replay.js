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
