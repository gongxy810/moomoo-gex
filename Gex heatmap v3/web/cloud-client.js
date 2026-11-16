export const cloudEnabled=globalThis.location?.hostname?.endsWith('.ts.net')??false;
const cache=new Map(),pending=new Map();
export function compactCloudHistory(frames,limit=400){
  const sorted=[...new Map(frames.map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
  const closes=new Map();
  for(const f of sorted){const age=Date.parse(f.sessionClose)-Date.parse(f.collectedAt);if(f.cells?.length&&age>=0&&age<=90000)closes.set(f.sessionDate,f);}
  const saved=[...closes.values()].slice(-3),keep=new Set([...saved.map(f=>f.collectedAt),sorted.at(-1)?.collectedAt]);
  const basis=[...new Map(sorted.flatMap(f=>f.basisHistory??[]).map(a=>[a.at,a])).values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-3000);
  const result=[...new Map([...saved,...sorted.slice(-limit)].map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt)).map(f=>{
    const {basisHistory,...body}=f;
    if(keep.has(f.collectedAt))return body;
    const {price,bars,listedStrikes,...meta}=body;return {...meta,cells:[],cloudMeta:true};
  });
  if(basis.length&&result.length)result[0].basisHistory=basis;
  return result;
}
export function cloudFor(frame,dates,state,request,render,metric,scope='chart'){
  if(!frame?.cells?.length||!dates.length)return null;
  const capture=frame.captureAt??frame.collectedAt,asof=new Date(state.replayCursor??Date.parse(capture)).toISOString();
  const args={capture,asof,expiries:dates.join(','),metric,minutes:state.candleMinutes,top:state.top,threshold:state.threshold,session:state.chartSession,scope};
  const key=JSON.stringify([frame.symbol,args]);
  if(cache.has(key)){const value=cache.get(key);if(value.available||Date.now()<(value.retryAt??Infinity))return value;cache.delete(key);}
  if(!pending.has(key)&&pending.size<2){
    const job=request('analysis',frame.symbol,AbortSignal.timeout(70000),args).then(data=>{
      if(data.available){data.roles.roles=new Map(data.roles.roles);cache.set(key,data);}else cache.set(key,{available:false,reason:data.reason??'Cloud analysis unavailable',retryAt:Date.now()+2000});
    }).catch(error=>cache.set(key,{available:false,reason:error.message,retryAt:Date.now()+2000})).finally(()=>{pending.delete(key);while(cache.size>12)cache.delete(cache.keys().next().value);render();if(!cache.get(key)?.available)setTimeout(render,2100);});
    pending.set(key,job);
  }
  return null;
}
export async function prepareCloudFrame(frame,dates,state,request,render,metric){
  if(!frame?.cells?.length||!dates.length)return;
  // Let bounded requests finish before the clock advances to another context.
  for(let attempt=0;attempt<3;attempt++){
    const ready=cloudFor(frame,dates,state,request,render,metric);
    if(ready)return ready;
    const jobs=[...pending.values()];if(!jobs.length)return;
    await Promise.all(jobs);
  }
}
