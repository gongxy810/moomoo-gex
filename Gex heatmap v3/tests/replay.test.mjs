import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closedCandles,frameAt,spotPosition,spotLabel,snapshotTrail,etTimestamp,ReplayClock} from '../web/replay.js';
const base=Date.parse('2026-11-09T15:00:00Z');
const bars=Array.from({length:15},(_,i)=>({at:new Date(base+i*60000).toISOString(),o:100+i,h:200+i,l:90+i,c:101+i,phase:'RTH'}));
test('10:07 replay excludes the final HLC of 10:05–10:10, including source-bar end boundary',()=>{
  const data=closedCandles(bars,5,1,base+7*60000);
  assert.equal(data.length,1);assert.equal(data[0].close,105);assert.equal(data[0].high,204);
  const later=closedCandles(bars,5,1,base+11*60000);assert.equal(later.length,2);
  assert.deepEqual(closedCandles(bars,5,1,base+7*60000),data);
  assert.equal(closedCandles([{at:bars[0].at,o:1,h:999,l:0,c:999,phase:'RTH'}],5,5,base+4*60000).length,0);
});
test('Replay rejects future chains, future quotes and never backfills current GEX into historical prices',()=>{
  const history=[{symbol:'SPY',sessionDate:'2026-11-09',collectedAt:new Date(base+10*60000).toISOString(),cells:[{strike:999}],dates:['2026-11-09'],spot:{value:999,at:new Date(base+10*60000).toISOString()}}];
  const frame=frameAt('SPY',history,{source:'OpenD',barMinutes:1,bars},base+7*60000);
  assert.equal(frame.historyUnavailable,true);assert.deepEqual(frame.cells,[]);assert.equal(frame.spot.value,107);
  assert.equal(Date.parse(frame.spot.at),base+7*60000);
  assert.ok(frame.bars.every(b=>Date.parse(b.at)+60000<=base+7*60000));
});
test('all historical fields use the last known capture and prior trading close',()=>{
  const old={symbol:'SPY',sessionDate:'2026-11-09',collectedAt:new Date(base).toISOString(),cells:[{strike:100}],dates:['2026-11-09'],spot:{value:100,at:new Date(base).toISOString(),current:true,phase:'RTH'}};
  const price={source:'OpenD',barMinutes:1,bars:[],sessions:{'2026-11-06':'2026-11-06T21:00:00Z','2026-11-09':'2026-11-09T21:00:00Z'},dailyCloses:[{date:'2026-11-06',close:90},{date:'2026-11-09',close:999}]};
  const frame=frameAt('SPY',[old],price,base+60000);
  assert.equal(frame.spot.value,100);assert.deepEqual(frame.cells,old.cells);assert.equal(frame.previousClose,90);
  assert.equal(frame.captureAt,old.collectedAt);assert.equal(frameAt('SPY',[old],price,base-60000).spot,null);
  const dated={...price,dailyCloses:[],previousClose:90,previousCloseDate:'2026-11-06',previousCloseSource:'verified daily fixture'};
  assert.equal(frameAt('SPY',[old],dated,base+60000).previousClose,90);
  assert.equal(frameAt('SPY',[old],{...dated,previousCloseDate:'2026-11-09'},base+60000).previousClose,null);
});
test('Spot interpolates between strikes; REF never becomes live SPX Spot',()=>{
  assert.equal(spotPosition([110,100],105,20),20);assert.equal(spotPosition([110,100],110,20),10);
  assert.equal(spotPosition([110,100],120,20),null);
  assert.equal(spotLabel('SPXW',{value:100,current:false,estimated:true,status:'REF'}),'REF');
  assert.equal(spotLabel('SPXW',{value:100,current:true,source:'OpenD snapshot',status:'RTH'}),'Spot');
  assert.equal(spotLabel('SPXW',{value:100,current:true,source:'cash candle close'}),'REF');
});
test('one actual last capture per candle bucket; no future or synthetic gap filling',()=>{
  const history=[0,1,4,6,11].map(minute=>({collectedAt:new Date(base+minute*60000).toISOString(),minute}));
  assert.deepEqual(snapshotTrail(history,5,base+7*60000).map(f=>f.minute),[4,6]);
  assert.deepEqual(snapshotTrail(history,5,base+2*60000).map(f=>f.minute),[1]);
});
test('ET start-time selection honors winter and summer offsets',()=>{
  assert.equal(etTimestamp('2026-11-09','10:00'),Date.parse('2026-11-09T15:00:00Z'));
  assert.equal(etTimestamp('2026-07-09','10:00'),Date.parse('2026-07-09T14:00:00Z'));
});
test('single replay cursor steps, seeks backward and exits without live mutation',()=>{
  const values=[],clock=new ReplayClock(v=>values.push(v));clock.seek(base);clock.step();clock.seek(base);clock.exit();
  assert.deepEqual(values,[base,base+300000,base,null]);assert.equal(clock.playing,false);
});
test('replay speed reschedules immediately and the last full step pauses at the candle limit',t=>{
  const waits=[];t.mock.method(globalThis,'setTimeout',(fn,ms)=>{waits.push(ms);return waits.length;});t.mock.method(globalThis,'clearTimeout',()=>{});
  const clock=new ReplayClock(()=>{});clock.seek(base);clock.stepMs=120000;clock.maximum=base+240000;
  clock.play();assert.equal(waits.at(-1),1000);clock.setSpeed(10);assert.equal(waits.at(-1),100);
  clock.setSpeed(.5);assert.equal(waits.at(-1),2000);clock.step();assert.equal(clock.cursor,base+120000);
  clock.step();assert.equal(clock.cursor,clock.maximum);assert.equal(clock.playing,false);
  clock.step();assert.equal(clock.cursor,clock.maximum);clock.exit();assert.equal(clock.cursor,null);
});
