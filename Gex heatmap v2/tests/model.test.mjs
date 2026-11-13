import {test} from 'node:test';
import assert from 'node:assert/strict';
import {velocity,baseline,rowVelocity,groups,dayChange,aggregateBars,walls,dayRange,expectedMove,retainHistory,net,nearest,strikeView,viewSettings,nodeCandidates,termPalette} from '../web/model.js';
import {nodeGeometry} from '../web/chart.js';
const at='2026-11-09T15:00:00Z';
const frame=(extra={})=>({symbol:'SPY',optionRoot:'US.SPY',model:'v1',sessionDate:'2026-11-09',collectedAt:at,
  previousSession:'2026-11-06',previousSessionClose:'2026-11-06T21:00:00Z',sessionClose:'2026-11-09T21:00:00Z',
  spot:{value:100,phase:'RTH',current:true,comparable:true,at},...extra});
const row=value=>({value,complete:true,contracts:['C','P']});
test('term-structure colors separate positive and negative peaks while dimming weak cells',()=>{
  assert.equal(termPalette(100,100,100).background,'rgb(252 231 83)');
  assert.equal(termPalette(-100,100,100).background,'rgb(135 56 209)');
  assert.notEqual(termPalette(1,100,100).background,termPalette(100,100,100).background);
  assert.notEqual(termPalette(-1,100,100).background,termPalette(-100,100,100).background);
  assert.equal(termPalette(null,100,100).background,'#161620');
});
test('absolute-magnitude velocity, shrink, expansion, flip and real zeros',()=>{
  assert.equal(velocity(-150,-100),50);assert.equal(velocity(75,100),-25);
  assert.equal(rowVelocity(row(150),row(-100),['x'],['x']).flipped,true);
  assert.equal(rowVelocity(row(1),row(0),[],[]).label,'—');
  assert.equal(rowVelocity(row(0),row(1),[],[]).value,-100);
  assert.equal(rowVelocity(row(0),row(0),[],[]).label,'—');
  assert.ok(rowVelocity(row(0),row(0),[],[]).reason.includes('零'));
  assert.equal(rowVelocity(row(-100),row(-150),[],[]).label,'−33.3%');
});

test('total strike rows stay continuous, balanced around nearest, and fill at edges',()=>{
  const chain=Array.from({length:80},(_,i)=>100+i);
  for(const count of [20,30,40,50,60]){
    for(const spot of [90,100,139.6,179,200]){
      const rows=nearest(chain,spot,count);assert.equal(rows.length,count);
      assert.ok(rows.includes(nearest(chain,spot,1)[0]));
      assert.ok(rows.every((value,i)=>i===0||rows[i-1]-value===1));
    }
  }
  assert.deepEqual(nearest([1,2,3],2,60),[3,2,1]);
  const f={spot:{value:102},cells:chain.map(strike=>({strike,expiry:'a',call:strike===170?100:1,put:-.1}))};
  const view=strikeView(f,['a'],20,'King');assert.equal(view.peak.strike,170);assert.equal(view.shown.length,20);
});

test('view settings migrate 39, retain valid choices, reject obsolete lookbacks',()=>{
  assert.deepEqual(viewSettings({limit:39,speed:60}),{limit:40,speed:5});
  assert.deepEqual(viewSettings({limit:50,speed:30}),{limit:50,speed:30});
});

test('30m uses last valid capture before the exact target in the same session, never a later poll',()=>{
  const now=frame({collectedAt:'2026-11-09T16:00:00Z'});
  const make=(at,extra={})=>frame({collectedAt:'2026-11-09T'+at+'Z',...extra});
  const selected=make('15:29:40');
  assert.equal(baseline([make('15:30:01'),selected,make('15:29:00')],now,30),selected);
  assert.equal(baseline([make('15:28:00')],now,30),null);
  assert.equal(baseline([make('15:29:40',{spot:{phase:'PRE'}})],now,30),null);
  assert.equal(baseline([],now,30),null);
});

test('node marks obey spacing/strike bounds, merge collisions without losing sources',()=>{
  const scale={min:2,max:8,alphaMin:.08,alphaMax:.5};
  const n=(source,weight,price=100,derived=false)=>({source,root:source,time:1,price,weight,value:-100,derived,title:source});
  const marks=nodeGeometry([n('SPY',1),n('SPXW',.5),n('SPY',.1,110),n('SPY',.8,120,true)],t=>t*10,p=>p,6,scale);
  assert.equal(marks.length,3);assert.equal(marks[0].others[0].source,'SPXW');
  assert.ok(marks.every(m=>m.w<=6*.72&&m.alpha<=.6));
  assert.ok(marks.find(m=>m.derived).h>marks.find(m=>m.derived).w);
  assert.ok(nodeGeometry([n('X',1)],t=>t,p=>p,2,scale)[0].w<=1.44);
});
test('board node opacity rises by twenty points without changing node geometry',()=>{
  const node={time:1,price:100,strike:100,source:'SPY',weight:.5,value:50,king:100};
  const geometry=scale=>nodeGeometry([node],t=>t*10,p=>p,16,scale)[0];
  const before=geometry({min:2,max:8,alphaMin:.10,alphaMax:.65});
  const after=geometry({min:2,max:8,alphaMin:.30,alphaMax:.85});
  assert.ok(Math.abs(after.alpha-before.alpha-.20)<1e-10);
  assert.equal(after.w,before.w);assert.equal(after.h,before.h);
  const oldZoomAlpha=(.10+(.65-.10)*Math.pow(.5,.75));
  const far=nodeGeometry([node],t=>t*10,p=>p,2,{min:2,max:8,alphaMin:.30,alphaMax:.85})[0];
  assert.ok(Math.abs(far.alpha-oldZoomAlpha*.5-.20)<1e-10);
});
test('node strength uses the complete source strike set and preserves shape through sign flips',()=>{
  const cells=[{expiry:'d',strike:100,call:20,put:0},{expiry:'d',strike:101,call:80,put:0},
    {expiry:'d',strike:102,call:100,put:0}];
  const source=frame({cells,spot:{value:100}}),sample=nodeCandidates(source,['d'],2,10);
  assert.equal(strikeView(source,['d'],1).shown[0].strike,100);
  assert.equal(sample.peak.strike,102);assert.deepEqual(sample.selected.map(r=>r.strike),[102,101]);
  const scale={min:2,max:8,alphaMin:.10,alphaMax:.65};
  const mark=(weight,value,king=100,derived=false)=>nodeGeometry([{time:1,price:100,strike:100,
    source:'SPY',root:'US.SPY',at,weight,value,king,derived,shape:derived?'diamond':'ellipse'}],t=>t*10,p=>p,16,scale)[0];
  const weak=mark(.2,20),strong=mark(.8,80),flip=mark(.8,-80),largerKing=mark(.2,80,400);
  assert.equal(weak.shape,strong.shape);assert.equal(strong.shape,flip.shape);
  assert.equal(strong.color,weak.color);assert.notEqual(strong.color,flip.color);
  assert.ok(strong.w>weak.w&&strong.h>weak.h&&strong.alpha>weak.alpha);
  assert.ok(largerKing.w<strong.w&&largerKing.alpha<strong.alpha);
  const diamond=mark(.8,80,100,true);assert.ok(diamond.h>diamond.w*2);
  const audit=nodeGeometry([{time:1,price:100,strike:100,source:'SPY',root:'US.SPY',at,weight:.8,value:80,king:100}],t=>t*10,p=>p,16,scale).audit;
  assert.deepEqual([audit[0].rawStrike,audit[0].mappedPrice,audit[0].gex,audit[0].king,audit[0].shape],[100,100,80,100,'ellipse']);
});
test('missing, partial or changed contracts and expiries never fade',()=>{
  for(const before of [null,{...row(10),complete:false},{...row(10),contracts:['X']}])assert.equal(rowVelocity(row(0),before,[],[]).value,null);
  assert.equal(rowVelocity(row(0),row(1),['today'],['yesterday']).value,null);
  assert.equal(groups({cells:[{expiry:'a',strike:100,call:2,put:null}]},['a'])[0].value,null);
  assert.equal(net({call:0,put:null}),null);assert.equal(net({call:0,put:0}),0);
  const partial=groups({cells:[{expiry:'a',strike:100,call:200,put:-10},{expiry:'b',strike:100,call:null,put:-20}]},['a','b']);
  assert.equal(walls(partial,100).call,undefined);assert.equal(walls(partial,100).put.strike,100);
});
test('5m cannot use last poll or a future-of-target capture',()=>{
  const now=frame();const old=time=>frame({collectedAt:`2026-11-09T${time}Z`});
  assert.equal(baseline([old('14:59:30'),old('14:55:01')],now,5),null);
  assert.equal(baseline([old('14:54:45')],now,5).collectedAt,'2026-11-09T14:54:45Z');
  assert.equal(baseline([old('14:50:00')],now,5),null);
  assert.equal(baseline([old('14:54:45')],frame({spot:{phase:'PRE'}}),5),null);
});
test('1D uses prior calendar close across weekend and respects half days',()=>{
  const close=frame({sessionDate:'2026-11-06',collectedAt:'2026-11-06T20:59:45Z'});
  assert.equal(baseline([close],frame(),1440),close);
  assert.equal(baseline([{...close,collectedAt:'2026-11-06T18:00:00Z'}],frame(),1440),null);
  const half=frame({sessionDate:'2026-11-27',collectedAt:'2026-11-27T17:59:30Z'});
  assert.equal(baseline([half],frame({previousSession:'2026-11-27',previousSessionClose:'2026-11-27T18:00:00Z'}),1440),half);
  const protectedClose={...close,sessionClose:'2026-11-06T21:00:00Z'};
  const overnight=Array.from({length:2100},(_,i)=>frame({collectedAt:new Date(Date.parse('2026-11-07T00:00:00Z')+i*30000).toISOString()}));
  assert.ok(retainHistory([protectedClose,...overnight]).includes(protectedClose));
});
test('daily changes require verified close; delayed and estimated remain labeled',()=>{
  assert.equal(dayChange(frame()),null);
  const f=frame({previousClose:80,previousCloseDate:'2026-11-06',spot:{value:100,current:false,comparable:true,status:'Delayed'}});
  assert.equal(dayChange(f).percent,25);
  assert.equal(dayChange({...f,spot:{...f.spot,estimated:true}}).estimated,true);
  assert.equal(dayChange({...f,spot:{...f.spot,comparable:false}}),null);
});
test('aggregation preserves OHLC, phases, ordering and never splits coarser candles',()=>{
  const bars=[0,1,2,3,4].map(i=>({at:`2026-11-09T14:3${i}:00Z`,o:100+i,h:103+i,l:99+i,c:102+i,phase:'RTH'}));
  assert.deepEqual(aggregateBars(bars,5),[{time:Date.parse(bars[0].at)/1000,open:100,high:107,low:99,close:106}]);
  assert.equal(aggregateBars(bars,1,5).length,0);
  assert.equal(aggregateBars(bars,2).length,3);
});
test('walls distinct from King and stable ties',()=>{
  const rows=[{strike:99,call:10,put:-90},{strike:101,call:10,put:-5},{strike:102,call:null,put:null}];
  assert.equal(walls(rows,101).call.strike,101);assert.equal(walls(rows,101).put.strike,99);
});
test('fixed range refuses intraday IV backfill; cone uses calendar half-day end',()=>{
  const f=frame({previousClose:100,previousCloseDate:'2026-11-06',cells:[{expiry:'2026-11-09',strike:100,callIv:.2,putIv:.2}]});
  assert.equal(dayRange(f,[f]),null);
  assert.equal(expectedMove({...f,spot:{...f.spot,phase:'Regular'},sessionClose:'2026-11-09T18:00:00Z'}).expiry,Date.parse('2026-11-09T18:00:00Z'));
  const captured=frame({sessionDate:'2026-11-06',collectedAt:'2026-11-06T20:59:30Z',spot:{value:100,current:true,at:'2026-11-06T20:59:30Z'},
    cells:[{expiry:'2026-11-09',strike:100,callIv:.2,putIv:.2}]});
  const range=dayRange(f,[captured]);assert.ok(range.move>0);assert.equal(range.iv,.2);
  assert.deepEqual(dayRange({...f,spot:{...f.spot,value:110}},[captured]),range);
});

