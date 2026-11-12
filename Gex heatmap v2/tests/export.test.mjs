import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gexSnapshot,pineSnapshot} from '../web/gex-export.js';

const at=Date.parse('2026-11-11T15:00:00Z');
const base={symbol:'SPY',date:'2026-11-11',frameDate:'2026-11-11',putWall:750,callWall:770,king:760,at};
const range={available:true,kind:'fixed-day',symbol:'SPY',rangeDate:'2026-11-11',at:Date.parse('2026-11-10T21:00:00Z'),anchor:760,
  impliedLow1:748,impliedHigh1:772};

test('GEX snapshot exports exact TradingView field order and New York date',()=>{
  assert.equal(gexSnapshot({...base,range}).line,'SPY,20261111,750,770,748,772,760');
});
test('a displayed ± point move becomes absolute lower and upper prices',()=>{
  assert.equal(gexSnapshot({...base,range:{...range,impliedLow1:null,impliedHigh1:null,movePoints:12.25}}).line,
    'SPY,20261111,750,770,747.75,772.25,760');
});
test('missing, previous-day and future ranges never produce a pasteable row',()=>{
  assert.equal(gexSnapshot({...base,range:null}).line,null);
  assert.equal(gexSnapshot({...base,range:{...range,rangeDate:'2026-11-10'}}).line,null);
  assert.equal(gexSnapshot({...base,range:{...range,at:at+1000}}).line,null);
  assert.equal(gexSnapshot({...base,frameDate:'2026-11-10',range}).line,null);
});
test('SPXW uses its own GEX levels and a matching SPX cash range',()=>{
  assert.equal(gexSnapshot({...base,symbol:'SPXW',putWall:7520,callWall:7600,king:7520,
    range:{...range,symbol:'SPX',anchor:7570,impliedLow1:7520,impliedHigh1:7620}}).line,
    'SPXW,20261111,7520,7600,7520,7620,7520');
});

const frame={sessionDate:'2026-11-11',captureAt:'2026-11-11T15:00:00Z',spot:{value:751,status:'REF'}};
const rows=[{strike:750,value:-100,call:20,put:-120,complete:true},
  {strike:755,value:50,call:60,put:-10,complete:true},
  {strike:760,value:5,call:10,put:-5,complete:true}];
test('Pine export includes signed nodes, strength, board levels and reference provenance',()=>{
  const value=pineSnapshot({...base,king:750,frame,dates:['2026-11-11'],rows,range,referenceKind:'REF',top:2,threshold:10});
  assert.equal(value.split('\n')[0],
    'GEX2|SPY|20261111|750|770|748|772|750|2026-11-11T15:00:00Z|2026-11-11|-45|90|-135|751|REF');
  assert.deepEqual(value.split('\n').slice(1),['L|750|-100|100','L|755|50|50']);
});
test('Pine export keeps valid GEX when fixed range is missing, but rejects old capture',()=>{
  const value=pineSnapshot({...base,king:750,frame,dates:['2026-11-11'],rows,range:null,referenceKind:'REF'});
  assert.match(value,/^GEX2\|SPY\|20261111\|750\|770\|na\|na\|750\|/);
  assert.equal(pineSnapshot({...base,frame:{...frame,sessionDate:'2026-11-10'},dates:['2026-11-11'],rows,range}),null);
  assert.equal(pineSnapshot({...base,frame:{...frame,captureAt:'2026-11-11T15:01:00Z'},dates:['2026-11-11'],rows,range}),null);
});

