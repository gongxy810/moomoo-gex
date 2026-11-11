// Dependency-free DOM integration tests. These do not claim canvas/browser coverage.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {demoFrame} from '../web/model.js';

class Node {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.style={};this.dataset={};this.value='';this.scrollTop=0;this.clientHeight=400;this.offsetTop=0;this.attributes={};this._text='';this.classList={toggle(){}};}
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent??'').join('');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=nodes;}
  setAttribute(k,v){this.attributes[k]=String(v);}
  addEventListener(k,fn){(this.events[k]??=[]).push(fn);}
  async dispatch(type,event={}){event={target:this,preventDefault(){},...event};for(const f of this.events[type]??[])await f(event);await this['on'+type]?.(event);}
  get childElementCount(){return this.children.length;}
  querySelector(){return null;}
  focus(){}
  showModal(){this.open=true;}
  close(){this.open=false;for(const f of this.events.close??[])f();}
}
const find=(node,predicate)=>predicate(node)?node:node.children.map(n=>find(n,predicate)).find(Boolean);
const settle=async()=>{for(let i=0;i<25;i++)await new Promise(resolve=>setImmediate(resolve));};

test('three stable columns, selector validation, persistence, duplicates, replay and late responses',async()=>{
  const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
  const ids=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Node()]));
  globalThis.document={body:new Node('body'),getElementById:id=>{assert.ok(ids.has(id),`missing HTML id ${id}`);return ids.get(id);},createElement:tag=>new Node(tag),querySelector:()=>new Node()};
  globalThis.location={hostname:'127.0.0.1',protocol:'http:',origin:'http://127.0.0.1:8766'};
  globalThis.Option=class extends Node{constructor(label,value){super('option');this.textContent=label;this.value=value;}};
  const saved=new Map();globalThis.localStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
  const timers=[];globalThis.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};globalThis.clearTimeout=()=>{};
  let lateResolve;const requests=[];
  const data=symbol=>({...demoFrame(['SPY','QQQ','SPXW'].includes(symbol)?symbol:'SPY',41),symbol,source:'opend',
    model:'v1',optionRoot:symbol,previousCloseDate:'2026-11-06',spot:{value:100,at:new Date().toISOString(),phase:'RTH',status:'RTH',current:true,comparable:true}});
  globalThis.fetch=async url=>{
    const parsed=new URL(url),symbol=parsed.searchParams.get('symbol');requests.push([parsed.pathname,symbol]);
    if(parsed.pathname==='/api/history')return {ok:true,json:async()=>({symbol,frames:[]})};
    if(parsed.pathname==='/api/price-history')return {ok:true,json:async()=>({symbol,source:'OpenD',bars:[],spot:null})};
    if(parsed.pathname==='/api/price')return {ok:true,json:async()=>({symbol,source:'OpenD',bars:[],spot:null})};
    if(symbol==='BAD')return {ok:false,json:async()=>({error:'代码无法识别 / 没有期权链'})};
    if(symbol==='LATE')return new Promise(resolve=>{lateResolve=()=>resolve({ok:true,json:async()=>data('LATE')});});
    return {ok:true,json:async()=>data(symbol)};
  };
  await import('../web/app.js');await settle();
  const $=id=>ids.get(id),ladder=id=>$('trinity').children.find(n=>n.dataset.ladder===id);
  assert.equal($('trinity').children.length,3);
  assert.deepEqual($('trinity').children.map(n=>n.dataset.ladder),['left','middle','right']);
  assert.ok($('plot').textContent.includes('依赖'));
  for(const symbol of ['SPXW','SPY','QQQ'])assert.equal(requests.filter(([path,s])=>path==='/api/snapshot'&&s===symbol).length,1);
  const open=async id=>{await ladder(id).children[0].children[0].dispatch('click');};
  await open('middle');assert.equal($('symbol-dialog').open,true);
  assert.ok($('symbol-options').textContent.includes('Magnificent 7'));
  $('symbol-input').value='NVDA';await $('symbol-form').dispatch('submit');await settle();
  assert.equal($('symbol-dialog').open,false);
  assert.ok(ladder('middle').textContent.includes('NVDA'));
  assert.ok(ladder('left').textContent.includes('SPXW'));
  assert.equal(JSON.parse(saved.get('gex-columns'))[1].symbol,'NVDA');
  assert.ok(saved.get('gex-recent').includes('NVDA'));
  await open('right');$('symbol-input').value='BAD';await $('symbol-form').dispatch('submit');await settle();
  assert.ok($('symbol-error').textContent.includes('没有期权链'));assert.ok(ladder('right').textContent.includes('QQQ'));
  $('symbol-dialog').close();await open('right');$('symbol-input').value='LATE';const late=$('symbol-form').dispatch('submit');await settle();
  $('symbol-dialog').close();await open('right');$('symbol-input').value='IWM';await $('symbol-form').dispatch('submit');await settle();
  lateResolve();await late;await settle();assert.ok(ladder('right').textContent.includes('IWM'));assert.ok(!ladder('right').textContent.includes('LATE'));
  $('speed').value='1440';await $('speed').dispatch('change');
  $('candle-period').value='1';await $('candle-period').dispatch('change');
  $('day-range').checked=true;await $('day-range').dispatch('change');assert.ok($('chart-message').textContent.includes('Day Range'));
  $('timeline').value='0';await $('timeline').dispatch('input');await $('latest').dispatch('click');
  assert.ok($('freshness').textContent.includes('price 15s'));
  await $('demo').dispatch('click');assert.equal($('feed-state').textContent,'Synthetic demo');
  await $('retry').dispatch('click');await settle();
  assert.ok(ladder('middle').textContent.includes('NVDA'));assert.ok(ladder('right').textContent.includes('IWM'));
  assert.notEqual($('feed-state').textContent,'Synthetic demo');
});
