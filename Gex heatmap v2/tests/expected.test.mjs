import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDExpected,impliedWidth,fixedDayRange,coneHeld,pinScore,tempestExpected,tempestDayRange,outsideDayRange,tempestRunningSigma,MODEL_VERSION} from '../web/expected.js';
import {PriceChart} from '../web/chart.js';
import {demoFrame} from '../web/model.js';

const at=Date.parse('2026-11-09T18:00:00Z'),end='2026-11-09T21:00:00Z';
function fixture(symbol='SPY',time=at,expiry='2026-11-09',settle=end){
  const stamp=new Date(time).toISOString(),root=symbol==='SPXW'?'SPXW':'US.'+symbol;
  const cell={expiry,strike:100};
  for(const side of ['call','put'])cell[side+'Quote']={side,strike:100,expiry,optionRoot:root,code:`US.${symbol}${expiry.slice(2).replaceAll('-','')}${side==='call'?'C':'P'}100000`,bid:2,ask:2.1,iv:.2,ivRaw:20,ivUnit:'fraction',at:stamp};
  return {symbol,optionRoot:root,sessionDate:stamp.slice(0,10),sessionClose:settle,collectedAt:stamp,dates:[expiry],spot:{value:100,current:true,at:stamp,status:'RTH'},cells:[cell],price:{sessions:{[expiry]:settle}}};
}

test('paired vendor IV uses percent normalization and verified calendar settlement',()=>{
  const c=openDExpected(fixture(),{at});assert.equal(c.available,true);assert.equal(c.quality,'Estimated');assert.equal(c.iv,.2);
  assert.equal(c.move,impliedWidth(100,.2,3/(365*24)));assert.equal(c.curves.length,4);
  assert.equal(c.curves[0].points.at(-1).price,c.impliedHigh1);
  assert.equal(c.contracts.length,2);assert.equal(c.straddlePremium,4.1);
  const half=Date.parse('2026-11-27T17:00:00Z');
  assert.equal(openDExpected(fixture('SPY',half,'2026-11-27','2026-11-27T18:00:00Z'),{at:half}).yearFraction,1/(365*24));
  const friday=Date.parse('2026-11-06T20:00:00Z');
  const front=openDExpected(fixture('SPY',friday),{at:friday,horizon:'front'});
  assert.equal(front.until,Date.parse(end));assert.equal(front.yearFraction,73/(365*24));
  assert.equal(openDExpected(fixture(),{at,settleAt:'2026-11-09T20:00:00Z'}).available,false);
});

test('missing, stale, future, crossed and wrong-root quotes cannot manufacture a cone',()=>{
  for(const mutate of [f=>f.spot.current=false,f=>f.spot.value=Infinity,f=>f.spot.estimated=true,f=>f.spot.at='bad',f=>f.collectedAt=new Date(at+1).toISOString(),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].at=new Date(at-120001).toISOString())),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].at=new Date(at+1).toISOString())),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].bid=3)),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].ask=5)),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].ivRaw=.2)),
    f=>f.cells.forEach(c=>['call','put'].forEach(s=>c[s+'Quote'].optionRoot='US.QQQ'))]){
    const f=fixture();mutate(f);assert.equal(openDExpected(f,{at}).available,false);
  }
  const f=fixture();f.cells[0].putQuote=null;assert.equal(openDExpected(f,{at}).quality,'Approximate');
  const spx=fixture('SPXW');assert.equal(openDExpected(spx,{at}).available,true);
  spx.cells[0].callQuote.code='US.SPX261109C100000';spx.cells[0].putQuote.code='US.SPX261109P100000';
  assert.equal(openDExpected(spx,{at}).available,false);
  assert.equal(openDExpected(fixture(),{at:Date.parse(end)}).available,false);
});

test('fixed range is built only from prior-close captures with next-expiry quotes',()=>{
  const close=Date.parse('2026-11-06T21:00:00Z');
  const f={...fixture(),previousSession:'2026-11-06',previousSessionClose:new Date(close).toISOString()};
  const previous=fixture('SPY',close-30000);
  const range=fixedDayRange(f,[previous],at);assert.ok(range);assert.equal(range.at,close);assert.equal(range.rangeDate,'2026-11-09');
  assert.equal(fixedDayRange(f,[fixture()],at),null);
  assert.equal(fixedDayRange(f,[{...previous,collectedAt:new Date(close+1).toISOString()}],at),null);
  assert.equal(fixedDayRange(f,[],at,[range]),range);
  assert.equal(fixedDayRange(f,[],close-1,[range]),null);
  assert.equal(fixedDayRange(f,[],at,[{...range,modelVersion:'old'}]),null);
  const out=outsideDayRange(range.impliedHigh1+2,range);assert.equal(out.distance,2);assert.equal(out.side,'Above');
});

test('fixed Day Range stays anchored while Live Cone moves, and outside sigma keeps direction',()=>{
  const fixed={provider:'OpenD',spot:100,impliedHigh1:102,impliedLow1:98};
  assert.deepEqual(outsideDayRange(103,fixed),{side:'Above',boundary:102,distance:1,sigma:1.5});
  assert.equal(outsideDayRange(100,fixed),null);
  assert.deepEqual(outsideDayRange(97,fixed),{side:'Below',boundary:98,distance:1,sigma:-1.5});
  const base=fixture(),live=openDExpected(base,{at});
  const moved=openDExpected({...base,spot:{...base.spot,value:101,at:new Date(at+30000).toISOString()}},{at:at+30000});
  assert.ok(live.available&&moved.available&&moved.impliedHigh1>live.impliedHigh1);
  assert.equal(fixed.impliedHigh1,102);
  assert.ok(Math.abs(impliedWidth(500,.2,.5/252)-4.45435403187374)<.01);
});

test('Tempest running sigma requires matching symbol, session and fresh asOf',()=>{
  const payload={sigma:[{symbol:'SPY',session:'2026-11-09',asOf:new Date(at-30000).toISOString(),running_sigma:-1.5},
    {symbol:'SPY',session:'2026-11-08',asOf:new Date(at).toISOString(),running_sigma:9}]};
  assert.equal(tempestRunningSigma(payload,{symbol:'SPY',sessionDate:'2026-11-09',at}),-1.5);
  assert.equal(tempestRunningSigma(payload,{symbol:'SPXW',sessionDate:'2026-11-09',at}),null);
  assert.equal(tempestRunningSigma(payload,{symbol:'SPY',sessionDate:'2026-11-09',at:at+121000}),null);
  assert.equal(outsideDayRange(97,{provider:'Tempest',spot:100,impliedHigh1:102,impliedLow1:98}).sigma,null);
});

test('Cone held uses completed day pairs, deduplicates and separates models/providers',()=>{
  const close=Date.parse('2026-11-06T21:00:00Z'),until=Date.parse(end);
  const range={...openDExpected(fixture('SPY',close-30000),{at:close,horizon:'date',expiry:'2026-11-09'}),kind:'fixed-day',rangeDate:'2026-11-09'};
  const records=[range,range,{...range,modelVersion:'other'},{...range,provider:'Tempest'}],sessions={'2026-11-09':end},daily=[{date:'2026-11-09',close:100}];
  assert.equal(coneHeld(records,daily,sessions,until-1,'SPY').count,0);
  assert.equal(coneHeld(records,daily,sessions,until,'SPY').count,1);
  assert.equal(coneHeld(records,daily,sessions,until,'SPY').percent,100);
  assert.equal(coneHeld(records,[],sessions,until,'SPY').percent,null);
  assert.equal(coneHeld([{...range,at}],daily,sessions,until,'SPY').count,0);
});

test('Pin scoring uses frozen curves, completed candles and the replay cutoff',()=>{
  const cone=openDExpected(fixture(),{at}),original=structuredClone(cone);
  const bars=Array.from({length:10},(_,i)=>({at:new Date(at+i*60000).toISOString(),o:100,h:200,l:50,c:i<5?100:120,phase:'RTH'}));
  const early=pinScore(cone,bars,5,1,at+7*60000);assert.equal(early.count,1);assert.equal(early.hits,1);
  const later=pinScore(cone,bars,5,1,at+10*60000);assert.equal(later.count,2);assert.equal(later.hits,1);assert.ok(later.firstTwoSigma);
  assert.equal(pinScore(cone,bars,5,1,at).count,0);assert.deepEqual(cone,original);
});

test('Tempest local payload validates dates, units, asymmetry and missing 2σ without invention',()=>{
  const options={symbol:'SPY',at,horizon:'today',spot:{value:100,current:true},spotAsOf:new Date(at).toISOString(),sessionDate:'2026-11-09'};
  const item={name:'today',priced_at:options.spotAsOf,until:end,hi1:102,lo1:99};
  const payload={symbol:'SPY',session:options.sessionDate,horizons:[item]};
  let cone=tempestExpected(payload,options);assert.equal(cone.available,true);assert.equal(cone.curves.length,2);assert.equal(cone.impliedHigh2,null);
  for(const change of [{priced_at:'bad'},{until:'bad'},{frozen:true},{hi1:98},{lo1:0},{hi2:101},{priced_at:new Date(at+1).toISOString()}])assert.equal(tempestExpected({...payload,horizons:[{...item,...change}]},options).available,false);
  cone=tempestExpected({...payload,horizons:[{...item,hi1:null,lo1:null,skew:{unit:'percent',up1_pct:2,dn1_pct:1}}]},options);
  assert.equal(cone.impliedHigh1,102);assert.equal(cone.impliedLow1,99);
  assert.equal(tempestExpected({...payload,horizons:{}},options).available,false);
  assert.equal(tempestExpected(payload,{...options,spotAsOf:'bad'}).available,false);
  const day={name:'day',anchor:100,hi1:102,lo1:98,frozen:true,priced_at:'2026-11-06T21:00:00Z',until:end};
  assert.ok(tempestDayRange({...payload,levels:[day]},options));
  assert.equal(tempestDayRange({...payload,levels:[{...day,priced_at:options.spotAsOf}]},options),null);
  assert.equal(tempestDayRange({...payload,levels:[{...day,until:'bad'}]},options),null);
});

test('demo cone stays labeled synthetic; drawing edits and deletes do not rewrite Replay history',()=>{
  const f=demoFrame('SPY',41),cone=openDExpected(f,{at:Date.parse(f.collectedAt)});assert.equal(cone.available,true);assert.equal(cone.provider,'Synthetic');
  const c=Object.create(PriceChart.prototype);Object.assign(c,{savedDrawings:[{id:'a',symbol:'SPY',type:'horizontal',price:100,createdAt:10,selected:true}],context:{symbol:'SPY',at:20},drawingsVisible:true,target:{dataset:{}},lastLayers:{nodes:[],curves:[],annotations:[]},layer:{update(){}}});
  c.refreshDrawings();c.editDrawing('price',110);assert.equal(c.drawings[0].price,110);
  c.context.at=15;c.refreshDrawings();assert.equal(c.drawings[0].price,100);
  c.context.at=30;c.refreshDrawings();c.deleteDrawing();assert.equal(c.drawings.length,0);
  c.context.at=25;c.refreshDrawings();assert.equal(c.drawings[0].price,110);
});
