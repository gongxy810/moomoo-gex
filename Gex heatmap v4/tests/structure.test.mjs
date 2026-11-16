import test from 'node:test';
import assert from 'node:assert/strict';
import {setMetric,groups,metricCell,rowVelocity} from '../web/model.js';
import {gravity,classifyNodes,nodeTouches,gravityTrail,velocityBoard} from '../web/structure.js';
const day='2026-11-13',at=day+'T15:30:00Z',end=day+'T21:00:00Z';
const cell={expiry:day,strike:100,call:1000,put:-600,callIv:.2,putIv:.2,complete:true,contracts:['C','P']};
const frame={symbol:'SPY',optionRoot:'SPY',model:'m',sessionDate:day,sessionClose:end,collectedAt:at,spot:{value:100,phase:'RTH'},dates:[day],cells:[cell]};
test('VEX identity agrees with independent derivative of delta; snapshot spot is immutable',()=>{
  setMetric('VEX');const years=(Date.parse(end)-Date.parse(at))/(365*86400000),iv=.2;
  const d1=iv*Math.sqrt(years)/2,gamma=Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI)/(100*iv*Math.sqrt(years));
  const h=1e-5,normal=x=>{ // numerical integral near zero, sufficient for this ATM test
    return .5+(x-x**3/6+x**5/40)/Math.sqrt(2*Math.PI);
  };
  const delta=v=>normal(v*Math.sqrt(years)/2),vanna=(delta(iv+h)-delta(iv-h))/(2*h);
  const out=metricCell({...cell,call:gamma*100**2*.01},frame);
  assert.ok(Math.abs(out.call-vanna*100*.01)<1e-7);
  assert.equal(metricCell(cell,{...frame,captureSpot:{value:100},spot:{value:110}}).call,metricCell(cell,frame).call);
  assert.equal(metricCell({...cell,callIv:null},frame).call,null);
  setMetric('GEX');
});
test('unlisted expiry can aggregate; listed-but-missing and incomplete pairs cannot',()=>{
  setMetric('GEX');const f={...frame,listedStrikes:{[day]:[100],later:[105]}};
  assert.equal(groups(f,[day,'later'])[0].value,400);
  assert.equal(groups({...f,listedStrikes:{later:[100]}},[day,'later'])[0].value,null);
  assert.equal(groups({...f,cells:[{...cell,complete:false}]},[day])[0].value,null);
  assert.equal(rowVelocity({...groups(f,[day])[0]}, {...groups(f,[day])[0],contracts:['other']},[day],[day]).value,null);
});
test('roles and gravity use full signed candidates, independent of visible rows',()=>{
  const rows=[{strike:90,value:-100},{strike:100,value:300},{strike:110,value:2},{strike:120,value:1}];
  const roles=classifyNodes(rows,99);assert.equal(roles.peak.strike,100);assert.equal(roles.floor.strike,90);assert.equal(roles.flip,92.5);assert.equal(roles.air.length,1);
  const g=gravity(rows);assert.ok(g.low<g.center&&g.center<g.high);
  assert.equal(gravityTrail([frame,{...frame,collectedAt:day+'T16:00:00Z'}],[day],Date.parse(at)).length,1);
});
test('touches count separate encounters, only closed 1m RTH bars at cutoff',()=>{
  const bars=[0,1,2,3].map((i)=>({at:new Date(Date.parse(day+'T14:30:00Z')+i*60000).toISOString(),l:i===2?101:99,h:102,phase:'RTH'}));
  assert.equal(nodeTouches(100,bars,Date.parse(day+'T14:33:00Z'),day),1);
  assert.equal(nodeTouches(100,bars,Date.parse(day+'T14:34:00Z'),day),2);
  assert.equal(nodeTouches(100,bars,Date.parse(day+'T14:34:00Z'),day,5),null);
});
test('Halo requires real same-contract baselines and never later samples',()=>{
  const hist=[1,5,15,30].map(m=>({...frame,collectedAt:new Date(Date.parse(at)-m*60000).toISOString(),cells:[{...cell,call:900,put:-600}]}));
  assert.equal(velocityBoard(frame,[day],hist).entries[0].halo,true);
  assert.equal(velocityBoard(frame,[day],[{...frame,collectedAt:day+'T16:00:00Z'}]).entries[0].halo,false);
});
