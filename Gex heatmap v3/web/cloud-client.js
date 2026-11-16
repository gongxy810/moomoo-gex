export const cloudEnabled=location.hostname.endsWith('.ts.net');
const cache=new Map(),pending=new Set();
export function cloudFor(frame,dates,state,request,render,metric){
  if(!frame?.cells?.length||!dates.length)return null;
  const capture=frame.captureAt??frame.collectedAt,asof=new Date(state.replayCursor??Date.parse(capture)).toISOString();
  const args={capture,asof,expiries:dates.join(','),metric,minutes:state.candleMinutes,top:state.top,threshold:state.threshold,session:state.chartSession};
  const key=JSON.stringify([frame.symbol,args]);
  if(cache.has(key))return cache.get(key);
  if(!pending.has(key)){
    pending.add(key);request('analysis',frame.symbol,AbortSignal.timeout(70000),args).then(data=>{
      if(data.available){data.roles.roles=new Map(data.roles.roles);cache.set(key,data);}else cache.set(key,{available:false,reason:data.reason??'Cloud analysis unavailable'});
    }).catch(error=>cache.set(key,{available:false,reason:error.message})).finally(()=>{pending.delete(key);while(cache.size>12)cache.delete(cache.keys().next().value);render();});
  }
  return null;
}
