import test from 'node:test';
import assert from 'node:assert/strict';
import {compactCloudHistory,cloudFor} from '../web/cloud-client.js';
test('seeking Replay releases obsolete analysis slots immediately and ignores old responses',async()=>{
  const calls=[];
  const request=(path,symbol,signal,args)=>new Promise((resolve,reject)=>{
    calls.push({signal,args,resolve});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  });
  const frame={symbol:'SPY',collectedAt:'2026-11-13T15:00:00Z',cells:[{}]};
  const state={symbol:'SPY',replayCursor:Date.parse('2026-11-13T20:30:00Z'),candleMinutes:5,top:5,threshold:10,chartSession:'ALL'};
  cloudFor(frame,['2026-11-13'],state,request,()=>{},'GEX','ladder');
  cloudFor(frame,['2026-11-13'],state,request,()=>{},'GEX','chart');
  state.replayCursor=Date.parse('2026-11-13T17:00:00Z');
  cloudFor(frame,['2026-11-13'],state,request,()=>{},'GEX','chart');
  assert.equal(calls.length,3);assert.ok(calls[0].signal.aborted&&calls[1].signal.aborted);
  assert.equal(calls[2].args.asof,'2026-11-13T17:00:00.000Z');
  calls[2].resolve({available:true,roles:{roles:[]},nodes:[]});
  await new Promise(resolve=>setImmediate(resolve));
});
test('cloud polling bounds full-chain history and preserves original records and basis anchors',()=>{
  const frames=Array.from({length:1200},(_,i)=>({collectedAt:new Date(Date.parse('2026-11-13T10:00:00Z')+i*30000).toISOString(),cells:[{strike:100,call:1,put:-2}],price:{bars:[1]},bars:[1],listedStrikes:{d:[100]},...(i===0?{basisHistory:[{at:'2026-11-13T09:30:00Z',basis:20}]}:{})}));
  const slim=compactCloudHistory(frames);
  assert.ok(slim.length<=403);assert.equal(slim.filter(f=>f.cells.length).length,1);
  assert.equal(slim[0].basisHistory.length,1);assert.equal(frames[0].cells.length,1);
  assert.equal(slim.at(-1).collectedAt,frames.at(-1).collectedAt);
  assert.ok(slim.slice(0,-1).every(f=>f.cloudMeta&&!f.price&&!f.bars));
});
test('rapid Replay changes start at most two analysis requests and then admit latest context',async()=>{
  const waiting=[];const request=()=>new Promise(resolve=>waiting.push(resolve));
  const frame={symbol:'SPY',collectedAt:'2026-11-13T15:00:00Z',cells:[{}]};
  const base={replayCursor:null,candleMinutes:5,threshold:10,chartSession:'ALL'};
  for(const top of [3,5,10])cloudFor(frame,['2026-11-13'],{...base,top},request,()=>{},'GEX');
  assert.equal(waiting.length,2);
  waiting[0]({available:true,roles:{roles:[]}});waiting[1]({available:true,roles:{roles:[]}});
  await new Promise(resolve=>setImmediate(resolve));
  cloudFor(frame,['2026-11-13'],{...base,top:10},request,()=>{},'GEX');assert.equal(waiting.length,3);
  waiting[2]({available:true,roles:{roles:[]}});await new Promise(resolve=>setImmediate(resolve));
});
