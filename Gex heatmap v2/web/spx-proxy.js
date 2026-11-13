import {finite} from './model.js';
import {marketDate} from './replay.js';

// SPXW parity is an option-implied forward, not a cash-index print. This is a
// display-only proxy; one observed ratio maps each day's SPY OHLC, so the
// earlier bars are historical approximations rather than reconstructed SPX.
export function spxProxy(spyPrice, spxFrames, cutoff){
  const sourceMinutes=spyPrice?.barMinutes??1;
  const spyBars=(spyPrice?.bars??[]).filter(bar=>[bar.o,bar.h,bar.l,bar.c].every(finite)&&
    Number.isFinite(Date.parse(bar.at))&&Date.parse(bar.at)<=cutoff).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(!spyBars.length)return {available:false,reason:'缺少 SPY 分钟 K 线'};
  const candidates=[];
  for(const frame of spxFrames??[]){
    const ref=frame?.spot,received=Date.parse(frame?.collectedAt),quoted=Date.parse(ref?.at);
    if(frame?.optionRoot!=='SPXW'||ref?.status!=='REF'||!ref?.source?.includes('call/put mids')||
      !finite(ref.value)||ref.value<=0||!Number.isFinite(received)||!Number.isFinite(quoted)||
      received>cutoff||quoted>cutoff||received<quoted||received-quoted>180000||
      marketDate(quoted)!==marketDate(received))continue;
    const spy=spyBars.filter(bar=>Date.parse(bar.at)+sourceMinutes*60000<=quoted&&
      quoted-Date.parse(bar.at)-sourceMinutes*60000<=120000&&marketDate(Date.parse(bar.at))===marketDate(quoted)).at(-1);
    if(!spy||spy.c<=0)continue;
    const ratio=ref.value/spy.c;
    if(!finite(ratio)||ratio<9||ratio>11)continue;
    candidates.push({day:marketDate(quoted),ratio,refAt:quoted,capturedAt:received,
      expiry:ref.referenceExpiry??null,refPrice:ref.value,spyPrice:spy.c});
  }
  if(!candidates.length)return {available:false,reason:'缺少与 SPY 分钟 K 线同交易日、同时间附近的 SPXW 配对报价'};
  const byDay=new Map();
  for(const item of candidates){
    const old=byDay.get(item.day),sameDay=item.expiry===item.day,oldSameDay=old?.expiry===old?.day;
    if(!old||(sameDay&&!oldSameDay)||(sameDay===oldSameDay&&item.refAt>old.refAt))byDay.set(item.day,item);
  }
  const bars=spyBars.flatMap(bar=>{
    const anchor=byDay.get(marketDate(Date.parse(bar.at)));
    if(!anchor)return [];
    const ratio=anchor.ratio;
    return [{...bar,o:bar.o*ratio,h:bar.h*ratio,l:bar.l*ratio,c:bar.c*ratio}];
  });
  if(!bars.length)return {available:false,reason:'当前交易日缺少可配对的 SPXW 参考报价'};
  const anchor=byDay.get(marketDate(cutoff))??byDay.get(marketDate(Date.parse(bars.at(-1)?.at)));
  if(!anchor)return {available:false,reason:'当前交易日缺少可配对的 SPXW 参考报价'};
  return {available:true,bars,barMinutes:sourceMinutes,priceSymbol:'SPX_PROXY',ratio:anchor.ratio,
    refAt:new Date(anchor.refAt).toISOString(),capturedAt:new Date(anchor.capturedAt).toISOString(),
    refPrice:anchor.refPrice,spyPrice:anchor.spyPrice,referenceExpiry:anchor.expiry,
    stale:cutoff-anchor.refAt>300000,model:'SPY OHLC × same-day SPXW parity / SPY close ratio',
    quality:anchor.expiry===anchor.day?'0DTE parity forward':'future-expiry parity forward',
    source:'OpenD SPY + SPXW parity proxy'};
}

