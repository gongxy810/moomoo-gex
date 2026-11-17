import {finite,king,groups,baseline,rowVelocity,datesFor} from './model.js';

// Local descriptive rules, not inferred dealer positions or Skylit algorithms.
export function classifyNodes(rows,spot){
  const valid=rows.filter(r=>finite(r.value)).sort((a,b)=>a.strike-b.strike),peak=king(valid);
  const strongest=list=>[...list].sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)||a.strike-b.strike)[0]??null;
  const ceiling=strongest(valid.filter(r=>r.strike>spot)),floor=strongest(valid.filter(r=>r.strike<spot));
  const gatekeeper=[...valid].filter(r=>peak&&Math.abs(r.value)>=Math.abs(peak.value)*.1).sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))[0]??null;
  const flips=[];for(let i=1;i<valid.length;i++){const a=valid[i-1],b=valid[i];if(a.value*b.value<0)flips.push(a.strike+(b.strike-a.strike)*Math.abs(a.value)/(Math.abs(a.value)+Math.abs(b.value)));}
  const flip=flips.sort((a,b)=>Math.abs(a-spot)-Math.abs(b-spot))[0]??null;
  const roles=new Map(valid.map(r=>[r.strike,[r.value>=0?'Pika (+)':'Barney (−)']]));
  for(const [row,name] of [[peak,'★ King'],[gatekeeper,'◈ Gatekeeper'],[ceiling,'⤒ Ceiling'],[floor,'⤓ Floor']])if(row)roles.get(row.strike).push(name);
  const pockets=[];let pocket=null;
  for(const r of valid){if(peak&&Math.abs(r.value)<Math.abs(peak.value)*.03){if(!pocket){pocket={low:r.strike,high:r.strike,count:0};pockets.push(pocket);}pocket.high=r.strike;pocket.count++;}else pocket=null;}
  const air=pockets.filter(p=>p.count>=2);for(const p of air)for(const r of valid)if(r.strike>=p.low&&r.strike<=p.high)roles.get(r.strike).push('≋ Air Pocket');
  return {peak,gatekeeper,ceiling,floor,flip,flips,roles,air};
}
export function velocityBoard(frame,dates,history){
  const rows=groups(frame,dates),windows=[1,5,15,30],maps=windows.map(m=>{const f=baseline(history,frame,m);return {m,f,map:new Map(groups(f,dates).map(r=>[r.strike,r]))};});
  const entries=rows.map(row=>{const periods=maps.map(({m,f,map})=>({minutes:m,...rowVelocity(row,map.get(row.strike),dates,f?dates.filter(d=>f.dates.includes(d)):[])}));
    const up=periods.filter(p=>p.value>=3).length,down=periods.filter(p=>p.value<=-3).length;
    return {strike:row.strike,periods,halo:Math.max(up,down)>=2,direction:up>=2?'growing':down>=2?'shrinking':null};});
  const ranked=entries.filter(e=>finite(e.periods[1].magnitude));
  return {entries,up:[...ranked].filter(e=>e.periods[1].magnitude>0).sort((a,b)=>b.periods[1].magnitude-a.periods[1].magnitude).slice(0,3),
    down:[...ranked].filter(e=>e.periods[1].magnitude<0).sort((a,b)=>a.periods[1].magnitude-b.periods[1].magnitude).slice(0,3)};
}
const touchCache=new WeakMap();
const touchDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const touchTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function nodeTouches(strike,bars,cutoff,day,sourceMinutes=1){
  if(sourceMinutes!==1)return null;
  let cached=touchCache.get(bars);
  if(!cached||cached.cutoff!==cutoff||cached.day!==day){
    const candles=bars.filter(b=>b.phase==='RTH'&&Date.parse(b.at)+60000<=cutoff&&touchDay.format(Date.parse(b.at))===day).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    cached={cutoff,day,candles,valid:!!candles.length&&touchTime.format(Date.parse(candles[0].at))==='09:30'};touchCache.set(bars,cached);
  }
  if(!cached.valid)return null;
  let count=0,inside=false,prior=null;
  for(const b of cached.candles){const t=Date.parse(b.at);if(prior===t)continue;
    const hit=b.l<=strike&&b.h>=strike;if(hit&&(!inside||t-prior>60000))count++;inside=hit;prior=t;
  }return count;
}
export function gravity(rows){
  const r=rows.filter(r=>finite(r.value)&&r.value!==0),total=r.reduce((s,r)=>s+Math.abs(r.value),0);if(!total)return null;
  const center=r.reduce((s,r)=>s+r.strike*Math.abs(r.value),0)/total;
  const sigma=Math.sqrt(r.reduce((s,r)=>s+(r.strike-center)**2*Math.abs(r.value),0)/total);
  return {center,low:center-sigma,high:center+sigma};
}
export function gravityTrail(history,dates,cutoff,minutes=5){
  const buckets=new Map();for(const f of history){const at=Date.parse(f.collectedAt);if(at>cutoff||Date.parse(f.optionLastAt??f.collectedAt)>cutoff)continue;const g=gravity(groups(f,dates));if(g)buckets.set(Math.floor(at/(minutes*60000)),{time:Math.floor(at/(minutes*60000))*minutes*60,...g});}
  return [...buckets.values()].sort((a,b)=>a.time-b.time);
}
