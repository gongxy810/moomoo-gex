import { symbols, pollMs, finite, datesFor, nearest, sum, net, groups, king, velocity, nodeCandidates,
  baseline, palette, demoFrame, rowVelocity, dayChange, walls, retainHistory, strikeView, viewSettings } from './model.js';
import {PriceChart} from './chart.js';
import {ChartTools,DarkSelect} from './tools.js';
import {ReplayClock,frameAt,marketDate,spotLabel,spotPosition,snapshotTrail,etTimestamp} from './replay.js';
import {openDExpected,fixedDayRange,outsideDayRange,coneHeld,pinScore,tempestExpected,tempestDayRange,tempestRunningSigma} from './expected.js';
import {gexSnapshot} from './gex-export.js';

const $ = id => document.getElementById(id);
const state = {symbol:'SPXW', source:'opend', expiry:'0dte', limit:40, frames:[], index:null,
  derived:true, cone:false, pinned:null, errors:{}, busy:false, center:'Spot', speed:5};
let timer, controller, priceTimer, priceGeneration=0;
let renderQueued=false,detailView=null,detailsVisible=false;
try{Object.assign(state,viewSettings(JSON.parse(localStorage.getItem('gex-view')??'{}')));}catch{}
const saveView=()=>{try{localStorage.setItem('gex-view',JSON.stringify({limit:state.limit,speed:state.speed}));}catch{}};
saveView();
const defaults=[{id:'left',symbol:'SPXW'},{id:'middle',symbol:'SPY'},{id:'right',symbol:'QQQ'}];
try {const saved=JSON.parse(localStorage.getItem('gex-columns'));state.columns=Array.isArray(saved)&&saved.length===3&&saved.every((c,i)=>c.id===defaults[i].id&&typeof c.symbol==='string'&&/^[A-Z0-9._-]{1,25}$/.test(c.symbol))?saved:defaults.map(c=>({...c}));}catch{state.columns=defaults.map(c=>({...c}));}
state.symbol=state.columns[0].symbol;
Object.assign(state,{focusId:'left',histories:{},prices:{},candleMinutes:5,chartMode:'gex',chartModeBySymbol:{},nodes:true,top:5,threshold:10,walls:true,dayRange:false,twoSigma:false});
Object.assign(state,{replayCursor:null,replayHistories:{},replayPending:new Set(),replayDateOrder:[],priceHistory:{},placeholders:{},columnStatus:{},columnVersions:{},
  chartSession:'ALL',drawingsVisible:true,nodeMin:2,nodeMax:8,nodeAlphaMin:.10,nodeAlphaMax:.65,supportedPeriods:[1,2,5,15],requests:[],sourceGeneration:0,captureStatus:{},priceStatus:{},replayRequestVersions:{},replayWindowBounds:{},historyBounds:{},historyPending:{}});
Object.assign(state,{expectedProvider:'OpenD',expectedHorizon:'today',tempest:{},fixedRanges:[],chartAutoScale:true,candleStyle:'classic'});
try{const records=JSON.parse(localStorage.getItem('gex-fixed-ranges-v1')??'[]');if(Array.isArray(records))state.fixedRanges=records.filter(r=>r&&r.available&&finite(r.at)&&finite(r.until)).slice(-1000);}catch{}
const selectedSymbols=()=>[...new Set(state.columns.map(c=>c.symbol))];
const historyFor=symbol=>{
  const regular=state.histories[symbol]??state.frames.map(r=>r[symbol]).filter(Boolean);
  const dated=state.replayCursor!==null?state.replayHistories[`${symbol}|${marketDate(state.replayCursor)}`]:null;
  return dated?[...new Map([...regular,...dated].map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt)):regular;
};
const latestPrice=(frame,symbol)=>{
  const live=state.prices[symbol],snapshot=frame?.price;
  if(!live)return snapshot;
  return Date.parse(live.collectedAt??0)>=Date.parse(snapshot?.collectedAt??frame?.collectedAt??0)?live:snapshot??live;
};
const chart=new PriceChart($('plot'));
chart.onNeedHistory=(from,to)=>{if(state.source==='opend')void extendHistory(state.symbol,from,to);};
let tvMounted=false;
function mountTvWidget(){
  if(tvMounted)return;tvMounted=true;
  const status=$('tv-status'),container=$('tv-widget');
  status.textContent='TradingView · FOREXCOM:SPXUSD · 1m 加载中…';
  const script=document.createElement('script');script.async=true;
  script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.dataset.interval='1';script.dataset.symbol='FOREXCOM:SPXUSD';
  script.textContent=JSON.stringify({autosize:true,symbol:'FOREXCOM:SPXUSD',interval:'1',timezone:'America/New_York',theme:'dark',style:'1',locale:'en',hide_top_toolbar:false,hide_side_toolbar:false,hide_legend:false,hide_volume:true,allow_symbol_change:false,save_image:true,withdateranges:true,backgroundColor:'#0B0B0D',gridColor:'rgba(90,90,105,0.08)'});
  script.onerror=()=>{status.textContent='TradingView 组件脚本加载失败；可使用上方链接在 TradingView 打开。';status.dataset.state='error';};
  script.onload=()=>{status.textContent='TradingView 组件已载入；CFD 行情状态以图内提示为准。';
    const iframe=container.querySelector('iframe');if(iframe)iframe.addEventListener('load',()=>{status.dataset.state='embedded';},{once:true});};
  container.append(script);
  setTimeout(()=>{if(!container.querySelector('iframe')&&status.dataset.state!=='error'){status.textContent='TradingView 图表未能嵌入；可使用上方链接在 TradingView 打开。';status.dataset.state='error';}},15000);
}
function hasSpxCashCandles(frame){
  const price=state.replayCursor===null?latestPrice(frame,'SPXW'):(state.priceHistory.SPXW??frame?.price);
  return price?.priceSymbol==='SPX'&&Array.isArray(price.bars)&&price.bars.some(bar=>
    [bar.o,bar.h,bar.l,bar.c].every(finite)&&Date.parse(bar.at)<= (state.replayCursor??Infinity));
}
function syncChartMode(frame){
  const available=state.symbol==='SPXW',replay=state.replayCursor!==null;
  const preferred=state.chartModeBySymbol[state.symbol]??(available&&state.source==='opend'&&!hasSpxCashCandles(frame)?'tradingview':'gex');
  const tv=available&&!replay&&preferred==='tradingview';
  state.chartMode=tv?'tradingview':'gex';
  $('chart-mode-switch').hidden=!available;
  $('mode-gex').disabled=replay;$('mode-tv').disabled=replay;
  $('mode-tv').title=replay?'Replay 使用 GEX 自绘图':'';
  $('mode-gex').setAttribute('aria-pressed',String(!tv));$('mode-tv').setAttribute('aria-pressed',String(tv));
  document.querySelector('.chart-panel').dataset.chartMode=state.chartMode;
  document.querySelector('.chart-panel').dataset.activeSymbol=state.symbol;
  $('tv-panel').hidden=!tv;$('chart-source').textContent=tv?'TradingView · FOREXCOM:SPXUSD':'OpenD · GEX 图';
  $('tv-app-cone').hidden=!tv;$('tv-app-spot').hidden=!tv;
  if(tv){$('plot').dataset.candles='0';$('plot').dataset.chartDataMode='hidden-tradingview';$('plot').dataset.nodeAuditCount='0';$('plot').__gexNodeAudit=[];mountTvWidget();}
  return tv;
}
$('mode-gex').onclick=()=>{if(state.replayCursor!==null)return;state.chartModeBySymbol[state.symbol]='gex';render();};
$('mode-tv').onclick=()=>{if(state.replayCursor!==null)return;state.chartModeBySymbol[state.symbol]='tradingview';render();};
$('empty-tv').onclick=()=>{if(state.replayCursor!==null)return;state.chartModeBySymbol.SPXW='tradingview';render();};
const scheduleRender=()=>{if(renderQueued)return;renderQueued=true;(globalThis.requestAnimationFrame??(fn=>setTimeout(fn,0)))(()=>{renderQueued=false;render();});};
if(globalThis.IntersectionObserver){const observer=new IntersectionObserver(entries=>{detailsVisible=entries.some(e=>e.isIntersecting);if(detailsVisible&&detailView){details(detailView);detailView=null;}},{rootMargin:'160px'});observer.observe(document.querySelector('.detail'));}
const clock=new ReplayClock(cursor=>{
  if(cursor!==null&&state.replayMax&&cursor>state.replayMax){clock.pause();cursor=state.replayMax;clock.cursor=cursor;}
  state.replayCursor=cursor;state.index=cursor===null?null:0;render();chart.latest();if(cursor!==null)void loadReplayDay(cursor);
});
const tools=new ChartTools({chart,panel:document.querySelector('.chart-panel'),target:$('plot'),getState:()=>state,
  setState:(key,value)=>{state[key]=value;if(key==='candleMinutes')clock.stepMs=value*60000;render();},
  onLatest:()=>{if(state.replayCursor===null)refreshPrice();}});
const saveColumns=()=>{try{localStorage.setItem('gex-columns',JSON.stringify(state.columns));}catch{}};

const relay = location.hostname==='127.0.0.1'&&location.protocol==='http:'?location.origin:'http://127.0.0.1:8766';
const px = n => finite(n) ? n.toLocaleString('en-US', {maximumFractionDigits:4, useGrouping:false}) : '—';
const count = n => finite(n) ? n.toLocaleString('en-US') : '—';
const cash = n => {
  if (!finite(n)) return '—';
  const a = Math.abs(n), prefix = n < 0 ? '−$' : '$';
  if (a >= 1e9) return prefix + (a/1e9).toFixed(3) + 'B';
  if (a >= 1e6) return prefix + (a/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return prefix + Math.round(a/1e3).toLocaleString('en-US') + 'K';
  return prefix + Math.round(a);
};
const exactCash = n => finite(n) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n) : '—';
const etTime = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
const stamp = value => Number.isFinite(Date.parse(value)) ? etTime.format(new Date(value)) + ' ET' : '—';
const pct = v => !finite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('en-US',{maximumFractionDigits:1}) + '%';
const tone = n => finite(n) && n !== 0 ? n > 0 ? 'pos' : 'neg' : '';
const element = (tag, value = '', cls = '') => {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = value;
  return node;
};
const empty = (target, message) => target.replaceChildren(element('div', message, 'empty'));
function active() {
  if(state.replayCursor!==null)return Object.fromEntries(selectedSymbols().map(symbol=>[symbol,
    frameAt(symbol,historyFor(symbol),state.priceHistory[symbol]??state.prices[symbol]??state.frames.at(-1)?.[symbol]?.price,state.replayCursor)]));
  const bundle = {...state.placeholders,...state.frames.at(-1)};
  if (!bundle || state.source !== 'opend') return bundle;
  return Object.fromEntries(Object.entries(bundle).map(([symbol, frame]) => {
    const live=state.prices[symbol],freshSpot=live?.spot;
    const updated=freshSpot&&Date.parse(freshSpot.at)>Date.parse(frame.spot?.at??0)
      ?{...frame,captureSpot:frame.spot,spot:freshSpot,previousClose:live.previousClose??frame.previousClose,
        previousCloseDate:live.previousCloseDate??frame.previousCloseDate}:frame;
    const stale=Date.now()-Date.parse(updated.spot?.at)>120000;
    return [symbol,stale&&updated.spot?.current?
      {...updated,spot:{...updated.spot,current:false,status:'Delayed',label:'Delayed OpenD print'}}:updated];
  }));
}

function viewFor(frame, expiry = state.expiry) {
  const dates = datesFor(frame, expiry);
  return strikeView(frame,dates,state.limit,state.center);
}

function renderLadder(column, data, previous) {
  const symbol=column.symbol;
  const {frame, dates, strikes, shown, peak} = viewFor(data);
  const before = new Map(groups(previous, dates).map(row => [row.strike, row]));
  const old = document.querySelector(`[data-ladder="${column.id}"] .ladder-body`);
  const ladder = element('article', '', 'ladder' + (state.focusId === column.id ? ' selected' : ''));
  ladder.dataset.ladder = column.id;
  ladder.dataset.symbol=symbol;
  ladder.dataset.phase=state.columnStatus[column.id]?.phase??(frame?.usable?'ready':'idle');
  const top = element('div', '', 'ladder-top');
  const button = element('button', '', 'symbol-picker');
  button.append(element('span',symbol+' ⌄'));
  button.type = 'button';
  button.setAttribute('aria-label',`选择 ${symbol} 标的`);
  button.addEventListener('click', () => openPicker(column));
  const focus=element('button','Focus','focus-column');focus.onclick=()=>{state.focusId=column.id;select(symbol);};
  top.addEventListener('click',event=>{if(event.target===top){state.focusId=column.id;select(symbol);}});
  const price = frame?.spot;
  const daily = dayChange(frame), change=daily?.percent;
  const quote = element('span', (spotLabel(symbol,price)==='REF' ? 'REF ' : price?.status==='Delayed'?'DLY ':'') + (finite(price?.value)?'$'+Number(price.value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4}):'—'),'header-spot');
  quote.dataset.value=price?.value??'';
  if (price) quote.title = `${price.source??price.label} · ${price.at} · 前收 ${frame?.previousCloseDate??'未核验'}`;
  const badge=element('span',finite(change)?`${daily.estimated&&symbol!=='SPXW'?'估算 ':''}${change>=0?'+':''}${change.toFixed(2)}%`:'—','day-change '+tone(change));
  badge.title=`${daily?.estimated?'参考价相对已核验前收的估算变化，非现金指数实时涨跌幅 · ':''}价格 ${px(price?.value)} · 点数 ${px(daily?.points)} · 前收 ${px(frame?.previousClose)} (${frame?.previousCloseDate??'未核验'}) · 前收来源 ${frame?.previousCloseSource??'OpenD'} ${frame?.previousCloseUrl??''} · ${price?.source??price?.label??'—'} · ${price?.at??'—'} · ${price?.status??'REF'} / ${price?.phase??'—'}`;
  const prices=element('div','','header-prices');prices.append(quote,badge);
  top.append(button, prices);
  const status=element('details','','column-status');
  const statusToggle=element('summary','行情与 Focus');status.append(statusToggle,element('span',symbol==='SPXW'?'价格 SPX / 期权 SPXW':symbol));
  status.append(element('span',`${price?.phase??'—'} · ${price?.status??'REF'}`),focus);
  status.title=`${price?.source??price?.label??'—'} · ${price?.at??'—'} · ${price?.status??'—'} / ${price?.phase??'—'} · 前收 ${frame?.previousCloseDate??'未核验'} · Focus 聚焦该列图表 · ${state.errors[symbol]??''}`;
  top.title=status.title+' · 点击标的选择；双击价格聚焦图表';
  prices.ondblclick=()=>focus.click();
  const kingRow = element('div', '', 'king-row');
  const distance=peak&&price?.value?(peak.strike/price.value-1)*100:null;
  const kingName=element('span','','king-name');kingName.append(element('i','','king-dot'),element('span','King'));
  kingRow.append(kingName,element('span',finite(distance)?`${Math.abs(distance).toFixed(1)}% ${distance>=0?'↑':'↓'}`:'—','king-distance '+tone(distance)));
  kingRow.title=`King ${peak?px(peak.strike):'—'} · 相对 ${spotLabel(symbol,price)} 距离 · 当前 ${shown.length} 个行权价 / ${dates.join(', ')} · ${frame?.captureAt??frame?.collectedAt??'—'}`;
  const body = element('div', '', 'ladder-body');
  const values = shown.map(row => row.value).filter(finite);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const atSpot = nearest(strikes, price?.value ?? 0, 1)[0];
  const contents=element('div','','ladder-contents');
  for (const row of shown) {
    const isKing = peak?.strike === row.strike;
    const line = element('div','', 'strike-row' + (isKing ? ' king' : '') + (atSpot === row.strike ? ' nearest' : ''));
    line.tabIndex = 0;
    const metric=rowVelocity(row,before.get(row.strike),dates,previous?dates.filter(d=>previous.dates.includes(d)):[]);
    const move=metric.value;
    line.title=`${symbol} ${px(row.strike)} · 前值 ${exactCash(metric.before)} · 现值 ${exactCash(row.value)} · signed Δ ${exactCash(metric.delta)} · |GEX| Δ ${exactCash(metric.magnitude)} · 实际比较 ${previous?.collectedAt??'—'} → ${frame?.captureAt??frame?.collectedAt??'—'} · 基准目标 ${new Date((state.replayCursor??Date.now())-state.speed*60000).toISOString()} · 到期 ${dates.join(', ')} · ${metric.flipped?'Flipped':'无翻号'} · ${state.speed}m · ${metric.reason??''}${!previous?' · 同一交易时段内无目标时刻之前的有效基准，或基准超过允许偏差（最多90秒）':''}`;
    const exposure = element('div', '', 'strike-value');
    Object.assign(exposure.style, palette(row.value, min, max));
    exposure.append(element('span',metric.label+(metric.flipped?' ↔':''),'velocity '+tone(move))); 
    exposure.append(element('span', cash(row.value) + (isKing ? ' ★' : ''),'gex-amount'));
    line.append(element('span', px(row.strike), 'strike-price'), exposure);
    contents.append(line);
  }
  body.append(contents);
  const position=spotPosition(strikes,price?.value,20);
  if(position!==null){const marker=element('div','','spot-marker');marker.style.top=position+'px';
    marker.append(element('span',`${spotLabel(symbol,price)} ${px(price.value)}`));
    marker.title=`${price.source??price.label} · ${price.at}`;contents.append(marker);}
  const progress=state.replayCursor===null?state.columnStatus[column.id]:null;
  if(progress?.symbol===symbol&&progress.phase==='loading')status.append(element('span','加载期权链…','loading-column'));
  if(!shown.length){
    const message=(state.replayCursor===null?state.errors[symbol]:null)??(frame?.historyUnavailable?'历史 GEX 不可用':!dates.length?(state.expiry==='0dte'?`${symbol} 无 0DTE`:'该到期日无数据'):
      progress?.phase==='loading'?'正在加载该到期日的期权快照…':'该到期日期权快照不可用，请检查期权行情权限');
    empty(body,message);
    if(state.expiry==='0dte'&&!dates.length){const front=element('button','Front 最近到期');front.onclick=()=>{state.expiry='front';render();};body.append(front);}
    if(state.replayCursor===null&&state.errors[symbol]){const retry=element('button','重试加载');retry.onclick=()=>loadColumn(column.id,symbol,state.columnVersions[column.id]??0);body.append(retry);}
  }
  const legend = element('div','','ladder-legend');
  legend.append(element('span',cash(min)),element('span','','gradient'),element('span',cash(max)));
  top.append(status);
  ladder.append(top,kingRow,body,legend);
  return {ladder, body, scroll: old?.querySelector('.strike-row') ? old.scrollTop : null};
}

function renderSpxLevels(view,frame,spot,tv){
  const target=$('spx-levels');
  const separate=state.symbol==='SPXW'&&(tv||!hasSpxCashCandles(frame));
  target.hidden=!separate;
  if(!separate){target.replaceChildren();return;}
  const wall=walls(view.shown,spot?.value??0);
  const items=[element('strong','SPXW Levels · 原始 strike')];
  items.push(element('span',`King ${px(view.peak?.strike)}`));
  items.push(element('span',`Call Wall ${px(wall.call?.strike)}`));
  items.push(element('span',`Put Wall ${px(wall.put?.strike)}`));
  if(finite(spot?.value)&&spotLabel('SPXW',spot)==='REF')items.push(element('span',`REF ${px(spot.value)}`));
  items.push(element('span',tv?'未映射到 CFD 图价格轴':'无可用 SPX 现金 1m K 线，价位暂不绘制到价格轴','quality'));
  target.replaceChildren(...items);
  target.title=`OpenD SPXW · GEX ${frame?.captureAt??frame?.collectedAt??'—'} · 到期 ${view.dates.join(', ')||'无'} · 原始 strike；CFD 与 SPX 未验证同时点映射`;
}

function renderChart(view) {
  const chartStarted=performance.now();
  const frame=view.frame,spot=frame?.spot,at=state.replayCursor??(state.source==='demo'?Date.parse(frame?.collectedAt):Date.now()),replay=state.replayCursor!==null;
  const daily=dayChange(frame),label=spotLabel(state.symbol,spot);
  $('chart-title').textContent=`${state.symbol==='SPXW'?'SPX / SPXW GEX':state.symbol} ${label==='REF'?'REF ':''}${px(spot?.value)}  ${daily?`${daily.points>=0?'+':''}${px(daily.points)} (${daily.percent>=0?'+':''}${daily.percent.toFixed(2)}%)`:''}`;
  $('chart-title').title=`${spot?.source??spot?.label??'—'} · ${spot?.at??'—'} · 前收 ${frame?.previousCloseDate??'未核验'}`;
  $('chart-phase').textContent=`${replay?'Replay · ':''}${spot?.phase??'—'} / ${spot?.status??'REF'}`;
  const tv=syncChartMode(frame);renderSpxLevels(view,frame,spot,tv);
  if(tv){
    $('chart-title').textContent='S&P 500 CFD 参考图 · FOREXCOM:SPXUSD';
    $('tv-app-spot').textContent=`SPX Spot ${spot?.current?px(spot.value):'不可用'}`;
    $('tv-app-spot').title=spot?.current?`${spot.source??'OpenD'} · ${spot.at??'—'}`:'应用未取得有效 SPX 现金指数报价；CFD 参考价只在 Widget 内';
    const payload=state.source==='opend'?state.tempest[state.symbol]?.payload:null;
    const cone=state.expectedProvider==='Tempest'?tempestExpected(payload,{symbol:state.symbol,at,horizon:state.expectedHorizon,spot,spotAsOf:spot?.at,sessionDate:frame?.sessionDate}):openDExpected(frame,{at,horizon:state.expectedHorizon});
    $('tv-app-cone').textContent=cone.available?`App Live Cone ${px(cone.impliedLow1)}–${px(cone.impliedHigh1)}`:'App Live Cone 不可用';
    $('tv-app-cone').title=cone.available?`${cone.provider} · ${cone.asOf} → ${cone.settleAt}`:(cone.reason??'应用行情或有效 IV 不可用');
    return;
  }
  $('cone').setAttribute('aria-pressed',state.cone);$('derived').setAttribute('aria-pressed',state.derived);
  for(const [id,key] of [['nodes','nodes'],['walls','walls'],['day-range','dayRange'],['two-sigma','twoSigma']])$(id).checked=!!state[key];
  const payload=state.source==='opend'?state.tempest[state.symbol]?.payload:null;
  const result=state.expectedProvider==='Tempest'?tempestExpected(payload,{symbol:state.symbol,at,horizon:state.expectedHorizon,spot,spotAsOf:spot?.at,sessionDate:frame?.sessionDate}):openDExpected(frame,{at,horizon:state.expectedHorizon});
  const candidate=result.available?result:null;
  state.coneReason=candidate?null:result.reason;
  const pinForFrame=state.pinned?.symbol===state.symbol&&state.pinned.source===state.source&&state.pinned.replay===replay&&state.pinned.cone.provider===(state.source==='demo'?'Synthetic':state.expectedProvider)&&state.pinned.cone.horizon===state.expectedHorizon&&state.pinned.cone.at<=at&&state.pinned.cone.sessionDate===marketDate(at);
  state.pinActive=!!pinForFrame;
  $('pin').disabled=!state.cone||(!pinForFrame&&!candidate);$('pin').title=state.coneReason??'冻结价格、IV、时间与锥形终点';
  $('pin').textContent=pinForFrame?'Unpin cone':'Pin cone';$('cone').title=state.coneReason??'独立于 Day Range 的动态 IV 锥形';
  state.coneCandidate=candidate;
  const history=historyFor(state.symbol).filter(f=>Date.parse(f.collectedAt)<=at);
  const related=state.symbol==='SPXW'&&state.derived?historyFor('SPY'):[];
  const nodeKey=JSON.stringify([state.symbol,view.dates,state.limit,state.center,state.chartSession,state.candleMinutes,state.nodes,state.derived,state.top,state.threshold,
    replay?at:'live',history.length,history.at(-1)?.collectedAt,related.length,related.at(-1)?.collectedAt]);
  let sampled=state.nodeCache;
  if(sampled?.key!==nodeKey){
    const validHistory=history.filter(f=>(!f.optionLastAt||Date.parse(f.optionLastAt)<=at)&&
      groups(f,view.dates).some(row=>finite(row.value)&&row.value!==0)&&
      (state.chartSession==='ALL'||(state.chartSession==='EXT'?['PRE','POST'].includes(f.spot?.phase):f.spot?.phase===state.chartSession)));
    const trail=snapshotTrail(validHistory,state.candleMinutes,at),nodeMap=new Map(),loaded=new Set();let candidates=0;
    for(const snap of trail){
    const sources=[[snap,1,false]];
    if(state.derived&&state.symbol==='SPXW'&&snap.spot?.current&&Date.parse(snap.spot.at)<=Date.parse(snap.collectedAt)){
      for(const related of selectedSymbols().filter(s=>s==='SPY')){
        const pair=historyFor(related).filter(f=>Date.parse(f.collectedAt)<=Date.parse(snap.collectedAt)&&
          Date.parse(snap.collectedAt)-Date.parse(f.collectedAt)<=30000&&f.spot?.current&&f.spot.phase===snap.spot.phase&&
          groups(f,view.dates.filter(d=>f.dates?.includes(d))).some(row=>finite(row.value)&&row.value!==0)&&
          Math.abs(Date.parse(f.spot.at)-Date.parse(snap.spot.at))<=30000&&marketDate(Date.parse(f.spot.at))===marketDate(Date.parse(snap.spot.at))).at(-1);
        if(pair){sources.push([pair,snap.spot.value/pair.spot.value,true]);loaded.add(related);}
      }
    }
    if(!state.nodes)continue;
    for(const [source,ratio,derived] of sources){
      const dates=view.dates.filter(d=>source.dates.includes(d));
      const {peak,eligible,selected}=nodeCandidates(source,dates,state.top,state.threshold);
      if(!peak||!dates.length)continue;
      candidates+=eligible.length;
      for(const row of selected){
        const weight=Math.abs(row.value/peak.value);
        const time=Math.floor(Date.parse(snap.collectedAt)/(state.candleMinutes*60000))*state.candleMinutes*60;
        const key=[time,source.symbol,source.optionRoot,dates.join(','),row.strike,derived].join('|');
        const previous=nodeMap.get(key);
        if(previous&&Date.parse(previous.at)>Date.parse(source.collectedAt))continue;
        nodeMap.set(key,{time,price:row.strike*ratio,value:row.value,king:peak.value,weight,derived,
          shape:derived?'diamond':'ellipse',mapping:derived?'local paired-spot ratio at capture':'native strike',
          at:source.collectedAt,source:source.symbol,root:source.optionRoot,strike:row.strike,dates,
          title:`源 ${source.symbol} / ${source.optionRoot??source.symbol} · 原始 Strike ${row.strike} · 映射价 ${px(row.strike*ratio)} · ${dates.join(', ')} · Net GEX ${cash(row.value)} · 当时 King ${cash(peak.value)} · ${((weight)*100).toFixed(1)}% King · ${source.collectedAt}${derived?' · 同时点双边 Spot 比例，本地近似':''}`});
      }
    }
    }
    sampled={key:nodeKey,nodes:[...nodeMap.values()],trailCount:trail.length,candidates,loadedSize:loaded.size};state.nodeCache=sampled;
  }
  const {nodes,trailCount,candidates,loadedSize}=sampled;
  $('derived').textContent=`Derived ${loadedSize}/${selectedSymbols().filter(s=>s==='SPY'&&state.symbol==='SPXW').length}`;
  const levels=[],annotations=[];
  if(finite(spot?.value))levels.push({price:spot.value,color:label==='Spot'?'#ce8d88':'#bfa56a',label});
  if(view.peak)levels.push({price:view.peak.strike,color:'#d5b754',label:'★ King',style:1});
  const wall=walls(view.shown,spot?.value??0);
  if(state.walls){
    if(wall.call&&wall.put&&wall.call.strike===wall.put.strike)
      levels.push({price:wall.call.strike,color:'#a88eb8',label:'C/P Wall',style:2,
        detail:`Call Wall / Put Wall · ${px(wall.call.strike)} · Call ${cash(wall.call.call)} / Put ${cash(wall.put.put)}`});
    else {if(wall.call)levels.push({price:wall.call.strike,color:'#55bace',label:'Call Wall',style:2});
      if(wall.put)levels.push({price:wall.put.strike,color:'#d579b5',label:'Put Wall',style:3});}
  }
  const fixed=state.expectedProvider==='Tempest'?tempestDayRange(payload,{symbol:state.symbol,sessionDate:frame?.sessionDate,at}):fixedDayRange(frame,history,at,state.source==='opend'?state.fixedRanges:[]);
  if(fixed&&state.source==='opend'&&!state.fixedRanges.some(r=>r.symbol===fixed.symbol&&r.rangeDate===fixed.rangeDate&&r.modelVersion===fixed.modelVersion)){
    const {curves,...record}=fixed;state.fixedRanges.push(structuredClone(record));state.fixedRanges=state.fixedRanges.slice(-1000);
    try{localStorage.setItem('gex-fixed-ranges-v1',JSON.stringify(state.fixedRanges));}catch{}
  }
  const range=state.dayRange?fixed:null;
  if(range)for(const mult of state.twoSigma?[1,2]:[1])for(const side of ['High','Low']){const value=range[`implied${side}${mult}`];if(finite(value))levels.push({price:value,color:'#699bd0',label:`${replay?'Hist Day':'Day'} ${side==='High'?'+':'−'}${mult}σ`,
    detail:`${replay?'Historical · ':''}${range.provider} fixed Day Range · anchor ${px(range.spot)} · priced ${range.asOf} · settle ${range.settleAt} · ${range.timeBasis??range.modelVersion} · ${range.quality}`});}
  const cone=state.cone?(pinForFrame?state.pinned.cone:candidate):null;
  if(cone)for(const mult of state.twoSigma?[1,2]:[1])for(const side of ['High','Low']){const value=cone[`implied${side}${mult}`];if(finite(value))levels.push({price:value,color:'#72d6ae',label:`Implied ${side} ${mult}σ`,style:2,
    detail:`${cone.provider} ${pinForFrame?'Pinned':'Live'} Cone · ${side} ${mult}σ ${px(value)} · anchor ${px(cone.spot)} · IV ${finite(cone.iv)?(cone.iv*100).toFixed(2)+'%':'provider'} · ${cone.asOf} → ${cone.settleAt}`});}
  const mergedLevels=new Map();
  for(const level of levels){const prior=mergedLevels.get(level.price);if(prior){prior.label+=` / ${level.label}`;prior.detail=`${prior.detail??prior.label} | ${level.detail??level.label}`;}
    else mergedLevels.set(level.price,{...level});}
  const priceLevels=[...mergedLevels.values()];
  for(const level of priceLevels)level.title=level.detail??`${level.label} · ${px(level.price)} · sampled strikes ${view.strikes.length} · ${view.dates.join(', ')} · GEX ${frame?.captureAt??frame?.collectedAt??'—'}`;
  const price=replay?(state.priceHistory[state.symbol]??frame?.price):latestPrice(frame,state.symbol);
  const bars=price?.bars??frame?.bars??[],sourceMinutes=price?.barMinutes??5;
  const chartHasPrice=state.symbol!=='SPXW'||hasSpxCashCandles(frame);
  state.coneVisible=chartHasPrice?cone:null;
  if(!chartHasPrice)$('pin').disabled=true;
  $('chart-empty').hidden=chartHasPrice;$('empty-tv').disabled=replay;
  state.heldStats=coneHeld(state.source==='opend'?state.fixedRanges:[],price?.dailyCloses??[],price?.sessions??{},at,state.symbol==='SPXW'?'SPX':state.symbol,{provider:state.expectedProvider,...(state.expectedProvider==='Tempest'?{modelVersion:'tempest-fixed-provider-v1'}:{})});
  state.supportedPeriods=[1,2,5,15].filter(v=>v>=sourceMinutes&&v%sourceMinutes===0);
  if(!state.supportedPeriods.includes(state.candleMinutes)&&state.supportedPeriods.length)state.candleMinutes=state.supportedPeriods[0];
  clock.stepMs=state.candleMinutes*60000;
  $('candle-period').value=String(state.candleMinutes);
  for(const option of $('candle-period').options??[])option.disabled=!state.supportedPeriods.includes(Number(option.value));
  const messages=[];
  if(state.historyPending[state.symbol])messages.push('历史节点加载中；价格与热图独立可用');
  if(replay&&state.replayPending.has(`${state.symbol}|${marketDate(at)}`))messages.push('Replay 历史数据加载中');
  const runningSigma=state.expectedProvider==='Tempest'?tempestRunningSigma(payload,{symbol:state.symbol,sessionDate:frame?.sessionDate,at}):null;
  const outside=outsideDayRange(spot?.value,range,runningSigma);
  if(outside){const text=`${outside.side} today's expected range by ${outside.distance.toFixed(2)} ${state.symbol==='SPXW'?'pts':'USD'}`+
      (finite(outside.sigma)?` · ${outside.sigma>=0?'+':''}${outside.sigma.toFixed(2)}σ from center`:'');
    annotations.push({price:outside.boundary,text,color:'#b9cee9'});messages.push(text);}
  state.pinStats=pinForFrame&&chartHasPrice?pinScore(state.pinned.cone,bars,state.candleMinutes,sourceMinutes,at):null;
  chart.update({symbol:state.symbol,bars:chartHasPrice?bars:[],minutes:state.candleMinutes,sourceMinutes,at,nodes:chartHasPrice?nodes:[],cone:chartHasPrice&&cone?{...cone,sigmas:state.twoSigma?[1,2]:[1]}:null,
    levels:chartHasPrice?priceLevels:[],spot:chartHasPrice?spot:null,replay,session:state.chartSession,annotations:chartHasPrice?annotations:[],nodeScale:{min:state.nodeMin,max:state.nodeMax,alphaMin:state.nodeAlphaMin,alphaMax:state.nodeAlphaMax},drawingsVisible:state.drawingsVisible,autoScale:state.chartAutoScale,candleStyle:state.candleStyle});
  if(state.symbol==='SPXW'&&!chartHasPrice)messages.push('SPX 现金指数 1m K 线不可用（OpenD：暂不支持美股指数）；原始 SPXW Levels 单列，REF 不是真实指数 Spot');
  if(frame?.historyUnavailable)messages.push('历史 GEX 不可用：该时点之前没有期权快照');
  if(state.dayRange&&!range)messages.push('Day Range 不可用：缺少前收时可验证的 ATM IV 快照');
  if(state.cone&&!cone)messages.push(state.coneReason);
  if(cone)messages.push(`${cone.provider} ${cone.quality} IV Cone · ${pinForFrame?'Pinned':'Live'}${at>=cone.until?' · Ended':''} · IV ${finite(cone.iv)?(cone.iv*100).toFixed(2)+'%':'—'} · 1σ ${px(cone.impliedLow1)}–${px(cone.impliedHigh1)} · ${cone.asOf} → ${cone.settleAt}`);
  $('chart-message').textContent=messages.join(' | ');
  $('chart-message').title=range?`${range.provider} · ATM IV ${range.iv??'—'} · ${range.asOf} → ${range.settleAt} · ${range.modelVersion}`:'';
  state.nodeCounts={rawSnapshots:history.length,bucketSnapshots:trailCount,candidates,unique:nodes.length};
  $('plot').dataset.nodeSampling=JSON.stringify(state.nodeCounts);
  $('layer-meta').textContent=`${nodes.length} nodes · ${history.length} loaded captures → ${trailCount} K buckets → ${candidates} candidates → ${nodes.length} unique · 价格 ${price?.source??'—'} ${spot?.at??'—'} / ${sourceMinutes}m source · GEX capture ${frame?.captureAt??frame?.collectedAt??'—'} · quotes ${frame?.optionLastAt??'—'}`;
  $('layer-meta').title=`热图 King / Walls 按所选 ${state.limit} 行计算；图表节点按各来源、到期日的完整有效 strike 先求 King，再叠加 ≥ King ${state.threshold}% 与 Top ${state.top}；屏幕相撞时只显示最强标记，悬停保留全部来源。 | `+priceLevels.map(l=>l.title).join(' | ');tools.sync();
  $('plot').dataset.chartRenderMs=(performance.now()-chartStarted).toFixed(1);
}

function profile(view) {
  const panel = $('profile');
  if (!view.shown.length) return empty(panel, 'No strikes');
  const cap = Math.max(1,...view.shown.map(row => Math.abs(row.value ?? 0)));
  panel.replaceChildren(...view.shown.map(row => {
    const line = element('div','','profile-line'), track = element('div','','profile-bar'), bar = element('i');
    if (finite(row.value)) {
      const width = Math.abs(row.value)/cap*50;
      Object.assign(bar.style,{left:`${row.value >= 0 ? 50 : 50-width}%`,width:`${width}%`,background:row.value >= 0 ? '#ddbf53' : '#9454cb'});
      track.append(bar);
    }
    line.title = `Call ${cash(row.call)} · Put ${cash(row.put)}`;
    line.append(element('span',px(row.strike)),track,element('span',cash(row.value),tone(row.value)));
    return line;
  }));
}

function table(target, headings, rows) {
  const t=element('table'), head=element('thead'), body=element('tbody'), tr=element('tr');
  tr.append(...headings.map(h => {const th=element('th',h);th.scope='col';return th;}));
  head.append(tr);
  for (const row of rows) {
    const line=element('tr');
    for (const field of row) {
      const td=element('td',field.text,field.cls);
      if (field.style) Object.assign(td.style,field.style);
      if (field.title) td.title=field.title;
      line.append(td);
    }
    body.append(line);
  }
  t.append(head,body);target.replaceChildren(t);
}

function details(view) {
  profile(view);
  if (!view.shown.length) {
    empty($('matrix'),'No matching expirations');empty($('oi'),'No matching contracts');
    return;
  }
  const dates = view.frame.dates;
  const map = new Map(view.frame.cells.map(cell => [cell.expiry+'|'+cell.strike,cell]));
  const max = Math.max(1,...view.frame.cells.map(cell => Math.abs(net(cell) ?? 0)));
  table($('matrix'),['Strike',...dates.map(date=>date.slice(5)+(view.dates.includes(date) ? ' •' : ''))],
    view.strikes.map(strike => [{text:px(strike)},...dates.map(expiry => {
      const cell = map.get(expiry+'|'+strike), value = cell ? net(cell) : null;
      return {text:cash(value), style:palette(value,-max,max),title:`${expiry} / ${strike} · Net ${cash(value)} · Call ${cash(cell?.call)} · Put ${cash(cell?.put)}`};
    })]));
  table($('oi'),['Strike','Call OI','Put OI','Call–Put'],view.shown.map(row=>[
    {text:px(row.strike)},{text:count(row.callOi)},{text:count(row.putOi)},{text:count(row.oi),cls:tone(row.oi)}]));
}

function render(recenter = false) {
  const renderStarted=performance.now();
  const original=active();
  const bundle=original&&Object.fromEntries(Object.entries(original).map(([symbol,frame])=>{
    const live=state.index===null?latestPrice(frame,symbol):null;
    let result=live?.spot?{...frame,spot:live.spot,previousClose:live.previousClose,previousCloseDate:live.previousCloseDate}:frame;
    if(live&&live.previousCloseDate&&live.previousCloseDate===result.previousCloseDate)result={...result,previousClose:live.previousClose??result.previousClose,previousCloseSource:live.previousCloseSource,previousCloseUrl:live.previousCloseUrl};
    if(state.index===null&&state.source==='opend'){
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
      const quoteDate=result.spot?.at?new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.parse(result.spot.at)):null;
      if(quoteDate!==date)result={...result,spot:{...result.spot,current:false,comparable:false,status:'REF',label:'Old session reference'}};
      else if(result.spot?.current&&Date.now()-Date.parse(result.spot.at)>120000)result={...result,spot:{...result.spot,current:false,status:'Delayed'}};
    }
    return [symbol,result];
  }));
  const view=viewFor(bundle?.[state.symbol]),frame=view.frame;
  $('center').textContent=state.center;
  const expiryMenu=$('expiry');
  const fixed=[['0dte','0DTE'],['front','Front'],['week','Next 7 days']];
  const days=[...(frame?.dates ?? [])];
  if (!fixed.some(([key]) => key===state.expiry) && !days.includes(state.expiry)) days.push(state.expiry);
  expiryMenu.replaceChildren(...[...fixed,...days.map(date=>[date,date])].map(([value,label])=>new Option(label,value)));
  expiryMenu.value=state.expiry;
  $('symbols').replaceChildren(...state.columns.map(column=>{const b=element('button',column.symbol);b.dataset.symbol=column.symbol;b.dataset.column=column.id;b.setAttribute('aria-pressed',column.id===state.focusId);return b;}));
  const ladders=state.columns.map(column=>{
    const data=bundle?.[column.symbol];
    // Baselines use immutable option capture prices, not a later price-provider tick.
    const originalFrame=original?.[column.symbol],capture=originalFrame?{...originalFrame,collectedAt:new Date(state.replayCursor??(state.source==='demo'?Date.parse(originalFrame.collectedAt):Date.now())).toISOString()}:null;
    return renderLadder(column,data,baseline(historyFor(column.symbol),capture,state.speed));
  });
  $('trinity').replaceChildren(...ladders.map(x=>x.ladder));
  for (const entry of ladders) {
    if (entry.scroll !== null && !recenter) entry.body.scrollTop=entry.scroll;
    else {
      const row=entry.body.querySelector(state.center==='King'?'.king':'.nearest');
      if (row) entry.body.scrollTop=row.offsetTop+row.offsetHeight/2-entry.body.clientHeight/2;
    }
  }
  renderChart(view);
  if(globalThis.IntersectionObserver&&!detailsVisible){detailView=view;}else details(view);
  const spot=frame?.spot;
  const data=[['SPOT / REFERENCE',spot ? (spot.current?'':'REF ')+px(spot.value) : '—'],
    ['NET GEX',cash(sum(view.shown.map(row=>row.value)))],['CALL GEX',cash(sum(view.shown.map(row=>row.call)))],
    ['PUT GEX',cash(sum(view.shown.map(row=>row.put)))],['KING STRIKE',view.peak ? '★ '+px(view.peak.strike) : '—']];
  $('metrics').replaceChildren(...data.map(([label,value])=>{
    const card=element('div','','metric');
    card.append(element('small',label),element('strong',value,label==='KING STRIKE'?'gold':''));
    return card;
  }));
  const issues=state.replayCursor===null?Object.entries(state.errors).filter(([key])=>selectedSymbols().includes(key)).map(([key,value])=>`${key} · ${value}`):[];
  const flags=[...issues,...(frame?.warnings??[])];
  if (state.source==='opend' && state.index===null && Number.isFinite(Date.parse(frame?.optionLastAt)) && Date.now()-Date.parse(frame.optionLastAt)>900000) flags.push('Latest available option quote is over 15 minutes old.');
  const service=state.captureStatus[state.symbol];
  if(service?.stale&&frame?.source==='opend')flags.unshift(`GEX stale · 采集 ${stamp(frame.captureAt??frame.collectedAt)}`);
  if(service?.phase==='error')flags.push(`GEX 更新失败 · ${service.error??'OpenD unavailable'}；继续显示上次有效快照`);
  if(service?.phase==='collecting')flags.push('GEX 后台采集中；当前显示最近完整快照');
  if(state.priceStatus[state.symbol]?.phase==='collecting')flags.push('价格独立更新中');
  if (state.source==='demo') flags.unshift('DEMO · Synthetic prices, exposures and candles');
  if (frame?.source==='opend' && !spot?.current) flags.unshift(`${state.symbol} · ${spot?.label??'等待有效价格'}`);
  if (state.expiry==='0dte' && frame && !view.dates.length) flags.push('No same-day expiry in this capture. Choose Front to see the nearest listed date.');
  if (!frame && !state.busy && !flags.length) flags.push('Start the local companion to view OpenD data.');
  $('notice').textContent=flags.join('  |  ');
  const feed=$('feed-state');
  feed.className='pill '+(frame?.source==='opend'&&spot?.current&&!flags.length?'good':'warn');
  feed.textContent=state.source==='demo'?'Synthetic demo':state.index!==null?'Replay':
    state.busy?'Refreshing':frame ? flags.length ? 'OpenD · Check data' : 'OpenD connected' : bundle && Object.keys(bundle).length ? 'OpenD · Partial data' : 'OpenD disconnected';
  const inputs=frame ? [`Spot ${stamp(spot?.at)}`,`Option quotes ${stamp(frame.optionFirstAt)} – ${stamp(frame.optionLastAt)}`,
    `GEX collected ${stamp(frame.captureAt??frame.collectedAt)}`,`${frame.usable}/${frame.contracts} usable · ${(frame.duration??0).toFixed(1)}s capture`,
    'OI daily · as-of unknown','GEX 30s after capture · price 15s (poll frequency ≠ quote delay)','OI-based GEX · USD / 1% move'] :
    ['OpenD quotes via loopback','GEX 30s after capture · price 15s (poll frequency ≠ quote delay)','OI-based GEX · USD / 1% move'];
  $('freshness').replaceChildren(...inputs.map(input=>element('span',input)));
  renderReplayControls();
  $('trinity').dataset.renderMs=(performance.now()-renderStarted).toFixed(1);
}

function select(symbol) {
  state.symbol=symbol;
  if (!['0dte','front','week'].includes(state.expiry)) state.expiry='0dte';
  render();
  refreshPrice();
}

function updateBundle(bundle) {
  const previous=state.frames.at(-1);
  for(const [symbol,frame] of Object.entries(bundle))if(previous?.[symbol]&&Date.parse(frame.collectedAt)<Date.parse(previous[symbol].collectedAt))bundle[symbol]=previous[symbol];
  if (!Object.keys(bundle).some(symbol=>bundle[symbol].collectedAt!==previous?.[symbol]?.collectedAt)) return;
  state.frames.push(bundle);
  for(const [symbol,frame] of Object.entries(bundle)){
    const h=state.histories[symbol]??=[];
    if(!h.some(old=>old.collectedAt===frame.collectedAt))h.push(frame);
    h.sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
    if(h.length>2000)state.histories[symbol]=retainHistory(h);
  }
  if (state.frames.length>2000) {
    state.frames.shift();
    if (state.index!==null) state.index=Math.max(0,state.index-1);
  }
}

const inflight=new Map();
async function requestJson(path,symbol,signal,day){
  const start=performance.now();let status;
  try{
    const params=new URLSearchParams({symbol,...(typeof day==='string'?{date:day}:day??{})});
    const reply=await fetch(`${relay}/api/${path}?${params}`,{signal,cache:'no-store'});status=reply.status;
    const data=await reply.json();if(!reply.ok){const categories={INVALID_CODE:'代码无法识别',PERMISSION:'行情权限不足',TIMEOUT:'请求超时',NO_OPTIONS:'无期权链'};
      const error=new Error((categories[data.category]?categories[data.category]+'：':'')+(data.error??'OpenD response unavailable'));error.category=data.category;throw error;}return data;
  }finally{const trace={stage:path,symbol,status,ms:Math.round(performance.now()-start)};state.requests.push(trace);state.requests=state.requests.slice(-100);console.info('gex-request',JSON.stringify(trace));}
}
async function fetchSymbol(symbol,force=false){
  if(inflight.has(symbol))return inflight.get(symbol);
  const pending=requestJson(force?'refresh':'snapshot',symbol,AbortSignal.timeout(15000)).then(data=>{
    if(data.source!=='opend'||data.symbol!==symbol||(!Array.isArray(data.cells)&&data.status!=='loading'))throw new Error('Invalid OpenD response');return data;
  }).finally(()=>inflight.delete(symbol));inflight.set(symbol,pending);return pending;
}
async function loadColumn(id,symbol,version){
  const started=performance.now();
  const sourceGeneration=state.sourceGeneration;
  state.columnStatus[id]={symbol,phase:'loading'};render();
  try{
    const data=await fetchSymbol(symbol);
    const column=state.columns.find(c=>c.id===id);
    if(state.source!=='opend'||state.sourceGeneration!==sourceGeneration||column?.symbol!==symbol||(state.columnVersions[id]??0)!==version)return;
    state.captureStatus[symbol]=data.service??{};
    if(data.status==='loading'){state.columnStatus[id]={symbol,phase:'loading'};scheduleRender();setTimeout(()=>loadColumn(id,symbol,version),1000);return;}
    updateBundle({...state.frames.at(-1),[symbol]:data});delete state.placeholders[symbol];
    if(data.service?.phase==='error')state.errors[symbol]=data.service.error;else delete state.errors[symbol];
    state.columnStatus[id]={symbol,phase:'ready'};
    console.info('gex-switch',JSON.stringify({stage:'column-ready',columnId:id,symbol,ms:Math.round(performance.now()-started),usable:data.usable,bars:data.bars?.length}));
    if(data.price)mergePrice(symbol,data.price);scheduleRender();void hydrate(symbol);
    if(data.service?.phase==='collecting')setTimeout(()=>loadColumn(id,symbol,version),1000);
  }catch(error){
    const column=state.columns.find(c=>c.id===id);
    if(state.source!=='opend'||state.sourceGeneration!==sourceGeneration||column?.symbol!==symbol||(state.columnVersions[id]??0)!==version)return;
    state.errors[symbol]=error.name==='TimeoutError'?'期权加载超时，可重试':error.message;
    state.columnStatus[id]={symbol,phase:'error'};render();
  }
}
async function refresh(force=false){
  clearTimeout(timer);if(state.source==='demo')return;
  if(force)for(const symbol of selectedSymbols())void refreshExpectedProvider(symbol);
  const local={};controller=local;state.busy=true;render();
  let collecting=false;
  await Promise.all(selectedSymbols().map(async symbol=>{
    try{const data=await fetchSymbol(symbol,force);if(controller!==local||!selectedSymbols().includes(symbol))return;
      state.captureStatus[symbol]=data.service??{};
      if(data.service?.phase==='collecting'||data.status==='loading')collecting=true;
      if(data.status==='loading'){for(const column of state.columns.filter(c=>c.symbol===symbol))state.columnStatus[column.id]={symbol,phase:'loading'};return;}
      updateBundle({...state.frames.at(-1),[symbol]:data});delete state.placeholders[symbol];
      if(data.service?.phase==='error')state.errors[symbol]=data.service.error;else delete state.errors[symbol];
      if(data.price)mergePrice(symbol,data.price);
      for(const column of state.columns.filter(c=>c.symbol===symbol))state.columnStatus[column.id]={symbol,phase:'ready'};
    }catch(error){if(controller===local&&selectedSymbols().includes(symbol))state.errors[symbol]=error.message;}
  }));
  if(controller===local){state.busy=false;scheduleRender();timer=setTimeout(refresh,collecting?1000:pollMs);}
}

function source(name) {
  $('connect-dialog').close();
  if (state.source!==name) {
    state.sourceGeneration++;priceGeneration++;clearTimeout(priceTimer);
    clock.pause();clock.cursor=null;
    if(name==='demo')state.savedLiveColumns=state.columns.map(c=>({...c}));
    else if(state.savedLiveColumns){state.columns=state.savedLiveColumns;state.symbol=state.columns.find(c=>c.id===state.focusId)?.symbol??state.columns[0].symbol;}
    controller=null;
    clearTimeout(timer);
    Object.assign(state,{source:name,frames:[],histories:{},prices:{},priceHistory:{},replayHistories:{},replayPending:new Set(),replayDateOrder:[],replayWindowBounds:{},replayRequestVersions:{},historyBounds:{},historyPending:{},placeholders:{},columnStatus:{},captureStatus:{},priceStatus:{},replayCursor:null,index:null,busy:false,errors:{},pinned:null});
  }
  if (name==='demo') {
    state.columns=defaults.map(c=>({...c}));state.symbol='SPXW';state.focusId='left';state.histories={};
    state.frames=Array.from({length:42},(_,i)=>Object.fromEntries(symbols.map(symbol=>[symbol,demoFrame(symbol,i)])));
    for(const symbol of symbols){
      state.histories[symbol]=state.frames.map(b=>b[symbol]);
      const frame=state.frames.at(-1)[symbol];
      state.priceHistory[symbol]={symbol,source:'Synthetic demo',barMinutes:5,bars:frame.bars,spot:frame.spot};
    }
    render();
  } else {void refresh();void refreshPrice();}
}

$('symbols').addEventListener('click',event=>{if(event.target.dataset.symbol){state.focusId=event.target.dataset.column;select(event.target.dataset.symbol);}});
$('expiry').onchange=event=>{state.expiry=event.target.value;render();};
$('range').onchange=event=>{state.limit=viewSettings({limit:event.target.value,speed:state.speed}).limit;saveView();render(true);};
$('speed').onchange=event=>{state.speed=viewSettings({limit:state.limit,speed:event.target.value}).speed;saveView();render();};
$('center').onclick=()=>{state.center=state.center==='Spot'?'King':'Spot';render(true);};
$('derived').onclick=()=>{state.derived=!state.derived;render();};
$('cone').onclick=()=>{state.cone=!state.cone;render();};
$('pin').onclick=()=>{
  const cone=state.coneCandidate;
  state.pinned=state.pinActive ? null : cone ? {symbol:state.symbol,source:state.source,replay:state.replayCursor!==null,cone:structuredClone(cone)} : state.pinned;
  render();
};
$('timeline').oninput=event=>clock.seek(Number(event.target.value));
$('latest').onclick=()=>clock.exit();
$('connect').onclick=()=>$('connect-dialog').showModal();
$('method').onclick=()=>$('method-dialog').showModal();
function openGexExport(){
  const at=state.replayCursor??Date.now(),date=marketDate(at),symbol=state.symbol;
  const frame=active()?.[symbol],view=viewFor(frame),wall=walls(view.shown,frame?.spot?.value??0);
  const history=historyFor(symbol).filter(f=>Date.parse(f.collectedAt)<=at);
  const payload=state.source==='opend'?state.tempest[symbol]?.payload:null;
  const range=state.expectedProvider==='Tempest'?tempestDayRange(payload,{symbol,sessionDate:frame?.sessionDate,at}):
    fixedDayRange(frame,history,at,state.source==='opend'?state.fixedRanges:[]);
  const result=gexSnapshot({symbol,date,frameDate:frame?.sessionDate,putWall:wall.put?.strike,
    callWall:wall.call?.strike,king:view.peak?.strike,range,at});
  const valid=state.source==='opend'&&!!result.line;
  $('gex-snapshot').value=result.preview;
  $('copy-gex-snapshot').disabled=!valid;
  $('gex-export-status').textContent=state.source!=='opend'?'Demo 是合成数据，不能导出到真实 TradingView 指标。':
    valid?`可复制 · ${symbol} · 到期 ${view.dates.join(', ')||'—'} · GEX ${frame?.captureAt??frame?.collectedAt??'—'} · 固定 Day Range ${range.provider} ${range.asOf??'—'}。Expected Move 为绝对价格，非 Live Cone。`:
    `不能生成完整记录：${result.missing.join('、')}。缺失值显示为 —，请勿把预览粘贴到指标。`;
  $('gex-export-dialog').showModal();
}
$('export-gex-levels').onclick=openGexExport;
$('copy-gex-snapshot').onclick=async()=>{
  const text=$('gex-snapshot').value;
  if($('copy-gex-snapshot').disabled||!text)return;
  try{await navigator.clipboard.writeText(text);$('gex-export-status').textContent='已复制 GEX snapshot，可粘贴到 TradingView 指标。';}
  catch{$('gex-snapshot').focus();$('gex-snapshot').select();$('gex-export-status').textContent='剪贴板权限不可用；已选中记录，请按 Ctrl+C 复制。';}
};
$('demo').onclick=()=>source('demo');
$('retry').onclick=()=>source('opend');
$('refresh').onclick=()=>state.source==='demo'?render():refresh(true);
let pickerColumn,validationController,choiceGeneration=0;
function openPicker(column){
  validationController?.abort();choiceGeneration++;pickerColumn=column.id;
  $('symbol-input').value='';$('symbol-error').textContent='';
  const groups=[['指数与 ETF',['SPX','SPXW','SPY','QQQ','IWM']],['Magnificent 7',['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA']]];
  try{groups.push(['Recent',JSON.parse(localStorage.getItem('gex-recent')??'[]')]);}catch{}
  $('symbol-options').replaceChildren(...groups.map(([name,items])=>{const div=element('div','','picker-group');div.append(element('h3',name));
    for(const item of items){const b=element('button',item+(item==='SPX'?' · 现金指数 → SPXW GEX':item==='SPXW'?' · PM 结算期权':''));b.type='button';b.dataset.symbolChoice=item;b.onclick=()=>choose(item);div.append(b);}return div;}));
  $('symbol-dialog').showModal();$('symbol-input').focus();
}
function validationFinished(){
  $('symbol-dialog').setAttribute('aria-busy','false');
  const submit=$('symbol-form').querySelector('button[type=submit]');if(submit)submit.disabled=false;
}
async function choose(raw){
  const started=performance.now();
  validationController?.abort();validationController=new AbortController();
  const generation=++choiceGeneration,id=pickerColumn,column=state.columns.find(c=>c.id===id);
  const normalized=raw.trim().toUpperCase();
  console.info('gex-switch',JSON.stringify({stage:'submit',columnId:id,raw,normalized}));
  $('symbol-error').textContent='验证行情与可用到期日中…';$('symbol-dialog').setAttribute('aria-busy','true');
  const deadline=setTimeout(()=>validationController?.abort('验证超时，请重试'),20000);
  try{
    const aliases=['SPX','SPXW','US.SPX','US..SPX','US.SPXW'];
    if(!aliases.includes(normalized)&&!/^(?:[A-Z]{2}\.)?[A-Z0-9][A-Z0-9_-]{0,19}$/.test(normalized))throw new Error('代码无法识别：格式无效');
    const symbol=aliases.includes(normalized)?'SPXW':normalized.startsWith('US.')?normalized.slice(3):normalized;
    if(state.source==='demo')throw new Error('请先连接 OpenD 再验证新标的');
    const validated=await requestJson('validate',symbol,validationController.signal);
    if(generation!==choiceGeneration||!column)return;
    const version=(state.columnVersions[id]??0)+1;state.columnVersions[id]=version;
    column.symbol=validated.symbol;column.priceSymbol=validated.priceSymbol;column.optionRoot=validated.optionRoot;
    console.info('gex-switch',JSON.stringify({stage:'validated-commit',columnId:id,symbol:validated.symbol,code:validated.code,ms:Math.round(performance.now()-started)}));
    state.focusId=id;state.symbol=validated.symbol;state.pinned=null;saveColumns();
    const quote=validated.quote;
    state.placeholders[validated.symbol]={symbol:validated.symbol,source:'opend',sessionDate:marketDate(Date.now()),
      priceSymbol:validated.priceSymbol,optionRoot:validated.optionRoot,dates:validated.dates,cells:[],
      spot:finite(quote?.value)?{...quote,current:false,comparable:false,status:'REF',phase:'—',label:'已验证报价 · 待加载价格源'}:null,
      collectedAt:new Date().toISOString(),usable:0,contracts:0,duration:0,warnings:[]};
    state.columnStatus[id]={symbol:validated.symbol,phase:'loading'};delete state.errors[validated.symbol];
    try{const recent=JSON.parse(localStorage.getItem('gex-recent')??'[]');localStorage.setItem('gex-recent',JSON.stringify([validated.symbol,...recent.filter(s=>s!==validated.symbol)].slice(0,8)));}catch{}
    validationFinished();$('symbol-dialog').close();render();
    void loadColumn(id,validated.symbol,version);void refreshPrice();void hydrate(validated.symbol);
  }catch(error){console.info('gex-switch',JSON.stringify({stage:'validation-error',columnId:id,normalized,error:error.message,ms:Math.round(performance.now()-started)}));if(generation===choiceGeneration)$('symbol-error').textContent=validationController.signal.aborted?'验证已取消或超时，请重试':error.message;}
  finally{clearTimeout(deadline);if(generation===choiceGeneration)validationFinished();}
}
$('symbol-form').onsubmit=event=>{event.preventDefault();return choose($('symbol-input').value);};
$('symbol-dialog').addEventListener('close',()=>{validationController?.abort();choiceGeneration++;validationFinished();});
$('candle-period').onchange=event=>{state.candleMinutes=Number(event.target.value);clock.stepMs=state.candleMinutes*60000;render();};
for(const [id,key] of [['nodes','nodes'],['walls','walls'],['day-range','dayRange'],['two-sigma','twoSigma']])$(id).onchange=event=>{state[key]=event.target.checked;render();};
$('node-top').onchange=event=>{state.top=Number(event.target.value);render();};
$('node-threshold').onchange=event=>{state.threshold=Number(event.target.value);render();};
function mergePrice(symbol,price){
  state.prices[symbol]=price;
  const previous=state.priceHistory[symbol]??{},bars=[...new Map([...(previous.bars??[]),...(price.bars??[])].map(b=>[b.at,b])).values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-20000);
  state.priceHistory[symbol]={...previous,...price,bars,sessions:{...previous.sessions,...price.sessions},
    dailyCloses:[...new Map([...(previous.dailyCloses??[]),...(price.dailyCloses??[])].map(d=>[d.date,d])).values()]};
}
const hydrating=new Map();
async function hydrate(symbol){
  if(hydrating.has(symbol))return hydrating.get(symbol);
  const pending=hydrateWindow(symbol,Date.now());hydrating.set(symbol,pending);
  try{return await pending;}finally{hydrating.delete(symbol);}
}
async function hydrateWindow(symbol,at){
  const generation=state.sourceGeneration;
  const end=new Date(at).toISOString(),start=new Date(at-10*3600000).toISOString();
  state.historyPending[symbol]=true;
  try{await Promise.all([
    refreshExpectedProvider(symbol),
    (async()=>{try{const data=await requestJson('history',symbol,AbortSignal.timeout(30000),{from:start,to:end,bucket:state.candleMinutes});
      if(state.source!=='opend'||generation!==state.sourceGeneration)return;
      state.histories[symbol]=[...new Map([...(data.frames??[]),...(state.histories[symbol]??[])].map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
      state.historyBounds[symbol]={start:Date.parse(start),end:Date.parse(end)};
    }catch{}})(),
    (async()=>{try{const data=await requestJson('price-history',symbol,AbortSignal.timeout(30000),{from:start,to:end});
      if(state.source!=='opend'||generation!==state.sourceGeneration)return;
      const live=state.prices[symbol];mergePrice(symbol,data);if(live)state.prices[symbol]=live;
    }catch{}})()
  ]);}finally{delete state.historyPending[symbol];scheduleRender();}
}
async function extendHistory(symbol,from,to){
  const bound=state.replayCursor!==null?state.replayWindowBounds[`${symbol}|${marketDate(state.replayCursor)}`]:state.historyBounds[symbol];
  if(!bound||state.historyPending[symbol]||from>=bound.start+3600000)return;
  const start=new Date(from-2*3600000).toISOString(),end=new Date(Math.min(bound.start,to,state.replayCursor??Infinity)).toISOString();
  if(Date.parse(start)>=Date.parse(end))return;
  state.historyPending[symbol]=true;const generation=state.sourceGeneration;
  try{const [history,price]=await Promise.all([
    requestJson('history',symbol,AbortSignal.timeout(30000),{from:start,to:end,bucket:state.candleMinutes,full:state.replayCursor!==null?'1':'0'}),
    requestJson('price-history',symbol,AbortSignal.timeout(30000),{from:start,to:end})]);
    if(generation!==state.sourceGeneration||state.source!=='opend')return;
    state.histories[symbol]=[...new Map([...(history.frames??[]),...(state.histories[symbol]??[])].map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
    mergePrice(symbol,price);bound.start=Date.parse(start);scheduleRender();
  }catch(error){console.info('gex-history',error.message);}finally{delete state.historyPending[symbol];}
}
async function refreshExpectedProvider(symbol){
  const generation=state.sourceGeneration;
  try{const data=await requestJson('expected-provider',symbol,AbortSignal.timeout(5000));
    if(state.source==='opend'&&generation===state.sourceGeneration){state.tempest[symbol]=data;render();}
  }catch{if(generation===state.sourceGeneration)state.tempest[symbol]={configured:false};}
}
async function refreshPrice(){
  clearTimeout(priceTimer);const generation=++priceGeneration;
  if(state.source!=='opend'){priceTimer=setTimeout(refreshPrice,15000);return;}
  let collecting=false;
  try{await Promise.all(selectedSymbols().map(async symbol=>{
    try{const price=await requestJson('price',symbol,AbortSignal.timeout(90000));
      if(generation===priceGeneration&&selectedSymbols().includes(symbol)&&state.source==='opend'){
        state.priceStatus[symbol]=price.service??{};
        if(price.status==='loading'||price.service?.phase==='collecting')collecting=true;
        if(price.status!=='loading')mergePrice(symbol,price);
      }
    }catch{}
  }));if(generation===priceGeneration)scheduleRender();
  }finally{if(generation===priceGeneration)priceTimer=setTimeout(refreshPrice,collecting?1000:15000);}
}
function renderReplayControls(){
  const times=selectedSymbols().flatMap(symbol=>[
    ...(state.priceHistory[symbol]?.bars??[]).map(b=>Date.parse(b.at)+(state.priceHistory[symbol]?.barMinutes??1)*60000),
    ...historyFor(symbol).map(f=>Date.parse(f.collectedAt))]).filter(Number.isFinite);
  const minimum=Math.floor((times.length?Math.min(...times):Date.now())/60000)*60000,
    maximum=Math.floor((times.length?Math.min(Date.now(),Math.max(...times)):Date.now())/60000)*60000;
  state.replayMin=minimum;state.replayMax=maximum;
  const slider=$('timeline');slider.min=String(minimum);slider.max=String(maximum);slider.step='60000';slider.value=String(state.replayCursor??maximum);slider.disabled=!times.length;
  $('timeline-time').textContent=state.replayCursor===null?'Live':new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(state.replayCursor)+' ET';
  if(!$('replay-date').value)$('replay-date').value=marketDate(maximum);
  $('replay-play').textContent=clock.playing?'暂停':'播放';$('replay-play').disabled=state.replayCursor===null;
  $('replay-step').disabled=state.replayCursor===null;
}
async function loadReplayDay(at){
  if(state.source!=='opend')return;
  const day=marketDate(at),generation=state.sourceGeneration;
  state.replayDateOrder=[...state.replayDateOrder.filter(d=>d!==day),day].slice(-2);
  for(const key of Object.keys(state.replayHistories))if(!state.replayDateOrder.includes(key.split('|').at(-1)))delete state.replayHistories[key];
  const pending=state.replayPending;
  await Promise.all(selectedSymbols().map(async symbol=>{
    const key=`${symbol}|${day}`,bounds=state.replayWindowBounds[key];
    if(bounds&&at>=bounds.start&&at<=bounds.end||pending.has(key))return;
    pending.add(key);const from=new Date(bounds&&at>bounds.end?bounds.end-40*60000:at-10*3600000).toISOString(),to=new Date(at).toISOString();
    try{const [data,price]=await Promise.all([
      requestJson('history',symbol,AbortSignal.timeout(30000),{from,to,bucket:state.candleMinutes,full:'1'}),
      requestJson('price-history',symbol,AbortSignal.timeout(30000),{from,to})]);
      if(generation!==state.sourceGeneration||state.source!=='opend'||!state.replayDateOrder.includes(day))return;
      state.replayHistories[key]=[...new Map([...(state.replayHistories[key]??[]),...(data.frames??[])].map(f=>[f.collectedAt,f])).values()].sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
      mergePrice(symbol,price);
      state.replayWindowBounds[key]={start:Math.min(bounds?.start??Infinity,Date.parse(from)),end:Math.max(bounds?.end??0,at)};
    }catch(error){console.info('gex-replay-history',error.message);}finally{pending.delete(key);}
  }));if(generation===state.sourceGeneration&&state.replayCursor!==null){render();if(state.replayCursor!==at)setTimeout(()=>loadReplayDay(state.replayCursor),0);}
}
$('replay-form').onsubmit=event=>{event.preventDefault();
  const at=etTimestamp($('replay-date').value,$('replay-time').value);
  if(!Number.isFinite(at)||at>Date.now()){tools.message('回放起点无效或晚于当前时间');return;}
  clock.stepMs=state.candleMinutes*60000;clock.seek(at);chart.fit();
};
$('replay-play').onclick=()=>{if(clock.playing)clock.pause();else clock.play();render();};
$('replay-step').onclick=()=>{clock.pause();clock.step();};
$('replay-speed').onchange=event=>{clock.speed=Number(event.target.value);};
async function start(){
  render();void refresh();void refreshPrice();
  setTimeout(()=>{for(const symbol of [state.symbol,...selectedSymbols().filter(s=>s!==state.symbol)])void hydrate(symbol);},1200);
}
$('range').value=String(state.limit);$('speed').value=String(state.speed);
new DarkSelect($('range'),'Strikes');new DarkSelect($('speed'),'GEX Velocity');
start();
