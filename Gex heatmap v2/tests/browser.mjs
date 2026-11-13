// Real Chromium/CDP integration, using only Node built-ins and an installed browser.
// All market responses below are explicit test fixtures, never production data.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {demoFrame} from '../web/model.js';
import {runAcceptance} from './acceptance.mjs';
import {runDesign} from './design-acceptance.mjs';
import {runCorner} from './corner-acceptance.mjs';

const artifacts=resolve('tests/browser-artifacts');await mkdir(artifacts,{recursive:true});
const live=process.argv.includes('--live');
const extended=process.argv.includes('--extended');
const dragOnly=process.argv.includes('--drag-only');
const labelsOnly=process.argv.includes('--labels');
const corner=process.argv.includes('--corner');
const derivedOnly=process.argv.includes('--derived');
const cashOnly=process.argv.includes('--spx-cash');
const exportLive=process.argv.includes('--export-live');
const matrixOnly=process.argv.includes('--matrix');
const rangeOnly=process.argv.includes('--range');
const axisOnly=process.argv.includes('--axis');
const tvOnly=process.argv.includes('--tv');
const focusSwitch=process.argv.includes('--focus-switch');
const design=process.argv.includes('--design');
const compareOnly=process.argv.includes('--compare');
const designData=design?JSON.parse(await readFile('tests/browser-artifacts/design-market.json','utf8')):null;
const profile=resolve(artifacts,'profile-'+Date.now());await mkdir(profile);
const browserPath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!browserPath)throw new Error('No installed Chromium browser; no download attempted');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let cashIndex=derivedOnly||cashOnly,sequence=0;
const counts={snapshot:0,price:0};
function frame(symbol,index=41){
  const base=demoFrame(['SPXW','SPY','QQQ'].includes(symbol)?symbol:'SPY',index);
  if(cashOnly&&symbol==='SPXW')base.cells=base.cells.map(cell=>cell.strike===7520?{...cell,call:9e9,put:-1e8}:cell);
  const now='2026-11-09T18:00:00Z',spot=base.spot.value;
  const bars=Array.from({length:300},(_,i)=>({at:new Date(Date.parse(now)-(299-i)*60000).toISOString(),
    o:spot+Math.sin(i/7),h:spot+Math.sin(i/7)+.7,l:spot+Math.sin(i/7)-.7,c:spot+Math.sin(i/7)+.2,phase:'RTH'}));
  const cash=symbol!=='SPXW'||cashIndex;
  if(symbol==='NVDA'){
    const dates=['2026-11-11','2026-11-13','2026-11-16','2026-11-18'];
    base.cells=base.cells.map(cell=>({...cell,expiry:dates[base.dates.indexOf(cell.expiry)]}));base.dates=dates;
  }
  base.cells=base.cells.map(cell=>({...cell,...Object.fromEntries(['call','put'].map(side=>[side+'Quote',{
    code:`US.${symbol}${cell.expiry.slice(2).replaceAll('-','')}${side==='call'?'C':'P'}${cell.strike*1000}`,side,strike:cell.strike,expiry:cell.expiry,optionRoot:symbol,
    bid:2,ask:2.1,ivRaw:cell[side+'Iv']*100,iv:cell[side+'Iv'],ivUnit:'fraction',at:base.collectedAt,source:'TEST FIXTURE'
  }]))}));
  const quote={...base.spot,at:base.collectedAt,current:cash,comparable:cash,phase:'RTH',status:cash?'RTH':'REF',source:'TEST FIXTURE',estimated:!cash};
  return {...base,symbol,source:'opend',model:'test-v1',optionRoot:symbol,previousCloseDate:'2026-11-06',
    sessionClose:'2026-11-09T21:00:00Z',previousSession:'2026-11-06',previousSessionClose:'2026-11-06T21:00:00Z',
    collectedAt:new Date(Date.parse(base.collectedAt)+sequence*1000).toISOString(),spot:quote,bars:cash?bars:[],
    price:{symbol,collectedAt:new Date(Date.parse(base.collectedAt)+sequence*1000).toISOString(),previousClose:base.previousClose,previousCloseDate:'2026-11-06',priceSymbol:symbol==='SPXW'?'SPX':symbol,bars:cash?bars:[],barMinutes:1,source:'TEST FIXTURE',spot:cash?quote:null,
      sessions:{'2026-11-06':'2026-11-06T21:00:00Z','2026-11-09':'2026-11-09T21:00:00Z'},dailyCloses:[{date:'2026-11-06',close:base.previousClose}]}};
}
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    if(design){
      const route=url.pathname.split('/').at(-1),symbol=url.searchParams.get('symbol');
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(designData.responses[route+'|'+symbol]??{}));return;
    }
    if(url.pathname==='/api/snapshot')counts.snapshot++;
    if(url.pathname==='/api/price')counts.price++;
    const symbol=url.searchParams.get('symbol');res.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/history'){
      const frames=[5,6,7,10,40].map(i=>frame(symbol,i));
      if(extended&&symbol==='SPY'){
        const prior=frame(symbol,0);prior.sessionDate='2026-11-06';prior.collectedAt='2026-11-06T20:59:30Z';
        prior.spot={...prior.spot,value:prior.previousClose,at:prior.collectedAt,current:true,phase:'RTH'};
        prior.cells=prior.cells.map(c=>({...c,...Object.fromEntries(['call','put'].map(side=>[side+'Quote',{...c[side+'Quote'],at:prior.collectedAt}]))}));frames.unshift(prior);
      }
      res.end(JSON.stringify({symbol,frames}));return;
    }
    if(url.pathname==='/api/price-history'){res.end(JSON.stringify(frame(symbol).price));return;}
    if(url.pathname==='/api/expected-provider'){res.end(JSON.stringify({configured:false,provider:'Tempest'}));return;}
    if(url.pathname==='/api/validate'){
      if(symbol==='LATE')await wait(800);
      if(symbol==='BAD'){res.statusCode=400;res.end(JSON.stringify({error:'代码无法识别 / 没有期权链 · TEST FIXTURE'}));return;}
      const data=frame(symbol);res.end(JSON.stringify({symbol,code:'US.'+symbol,priceSymbol:symbol==='SPXW'?'SPX':symbol,optionRoot:symbol,dates:data.dates,quote:data.spot}));return;
    }
    if(url.pathname==='/api/price'){res.end(JSON.stringify(frame(symbol).price));return;}
    if(symbol==='BAD'){res.statusCode=502;res.end(JSON.stringify({error:'没有期权链 · TEST FIXTURE'}));return;}
    if(symbol==='LATE')await wait(800);
    if(extended&&url.pathname==='/api/snapshot'&&symbol==='NVDA')await wait(600);
    sequence++;res.end(JSON.stringify(frame(symbol)));return;
  }
  try{
    const path=url.pathname==='/'?'/index.html':url.pathname;
    if(path.includes('..'))throw new Error('path');
    const types={'.js':'text/javascript','.css':'text/css','.html':'text/html'};
    let data=design&&process.argv.includes('--before')&&designData.assets[path.slice(1)]?Buffer.from(designData.assets[path.slice(1)]):await readFile(resolve('web','.'+path));
    if(design&&process.argv.includes('--before')&&path==='/chart.js')data=Buffer.from(data.toString()+'\nPriceChart.prototype.setControlZones=function(){};\n');
    if((design||corner||derivedOnly||rangeOnly||cashOnly||axisOnly)&&path==='/app.js')data=Buffer.from(data.toString().replace("const chart=new PriceChart($('plot'));","const chart=new PriceChart($('plot'));globalThis.__designChart=chart;globalThis.__testState=state;globalThis.__testRender=()=>render();"));
    if(design&&process.argv.includes('--before')&&path==='/index.html')data=Buffer.from(data.toString().replace('<option>20</option><option>30</option><option selected>40</option><option>50</option><option>60</option>','<option>20</option><option selected>39</option><option>60</option>'));
    if(design&&compareOnly&&path==='/index.html')data=Buffer.from(data.toString().replace('</head>','<style>#plot{width:690px!important;height:480px!important;min-height:480px!important;max-height:480px!important;flex:none!important}</style></head>'));
    if(path==='/app.js')data=Buffer.from(data.toString().replace("const relay = 'http://127.0.0.1:8766';","const relay = location.origin;"));
    res.setHeader('Content-Type',types[extname(path)]??'text/plain');res.end(data);
  }catch{res.statusCode=404;res.end('Not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=spawn(browserPath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,
  '--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync',
  '--window-size=1500,1000','about:blank'],{stdio:'ignore',windowsHide:true});
let socket;
try{
  let port;
  for(let i=0;i<100;i++){try{port=Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await wait(100);}}
  if(!port)throw new Error('Browser DevTools did not start');
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page=pages.find(p=>p.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let next=0;const pending=new Map(),exceptions=[],network=new Map(),tvNetwork=[];
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p.reject(new Error(msg.error.message));else p.resolve(msg.result);}
    if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails.exception?.description??msg.params.exceptionDetails.text);
    if(msg.method==='Network.requestWillBeSent'&&msg.params.request.url.includes('/api/'))network.set(msg.params.requestId,{url:msg.params.request.url,start:msg.params.timestamp});
    if(msg.method==='Network.responseReceived'&&network.has(msg.params.requestId))network.get(msg.params.requestId).status=msg.params.response.status;
    if(msg.method==='Network.loadingFinished'&&network.has(msg.params.requestId))network.get(msg.params.requestId).ms=Math.round((msg.params.timestamp-network.get(msg.params.requestId).start)*1000);
    if(msg.method==='Network.responseReceived'&&/tradingview\.com/.test(msg.params.response.url))tvNetwork.push({url:msg.params.response.url,status:msg.params.response.status});
    if(msg.method==='Network.loadingFailed'&&/tradingview\.com/.test(network.get(msg.params.requestId)?.url??''))tvNetwork.push({url:network.get(msg.params.requestId).url,error:msg.params.errorText});
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
  const until=async expression=>{for(let i=0;i<(live?1200:100);i++){if(await evaluate(expression))return;await wait(50);}throw new Error('Timed out: '+expression+' '+JSON.stringify({exceptions,state:await evaluate("({state:document.querySelector('#feed-state')?.textContent,notice:document.querySelector('#notice')?.textContent,rows:document.querySelectorAll('.strike-row').length})")}));};
  await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
  if(!live)await send('Page.addScriptToEvaluateOnNewDocument',{source:design?`Date.now=()=>${designData.at};`:"Date.now=()=>Date.parse('2026-11-09T18:01:00Z');"});
  await send('Page.navigate',{url:live?'http://127.0.0.1:8766/':`http://127.0.0.1:${server.address().port}`});
  await until("document.querySelectorAll('.ladder').length===3 && document.querySelectorAll('#plot canvas').length>0 && document.querySelector('#feed-state').textContent!=='Refreshing'");
  if(cashOnly){
    await until("document.querySelector('.chart-panel').dataset.activeSymbol==='SPXW' && document.querySelector('.chart-panel').dataset.chartMode==='gex' && +document.querySelector('#plot').dataset.candles>0");
    await evaluate("document.querySelector('#derived').click();document.querySelector('#candle-period').value='1';document.querySelector('#candle-period').dispatchEvent(new Event('change'))");
    await until("+document.querySelector('#plot').dataset.candles>=200 && document.querySelector('#candle-period').value==='1'");
    const snap=async name=>{const rect=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");const shot=await send('Page.captureScreenshot',{format:'png',clip:rect});await writeFile(resolve(artifacts,`spx-cash-fixture-${name}.png`),Buffer.from(shot.data,'base64'));};
    const one=await evaluate("({candles:+document.querySelector('#plot').dataset.candles,mode:document.querySelector('.chart-panel').dataset.chartMode,king:__designChart.levels.find(l=>l.label.includes('King'))?.price,native:document.querySelector('#plot').__gexNodeAudit?.filter(n=>n.source==='SPXW'&&n.shape==='ellipse').slice(0,8),source:document.querySelector('#layer-meta').textContent})");
    assert.equal(one.king,7520);assert.ok(one.native?.length&&one.native.every(n=>n.rawStrike===n.mappedPrice));await snap('1m');
    await evaluate("document.querySelector('#candle-period').value='5';document.querySelector('#candle-period').dispatchEvent(new Event('change'))");
    const five=await evaluate("({candles:+document.querySelector('#plot').dataset.candles,mode:document.querySelector('.chart-panel').dataset.chartMode,king:__designChart.levels.find(l=>l.label.includes('King'))?.price})");
    assert.ok(five.candles>0&&five.candles<one.candles&&five.king===one.king);await snap('5m');
    await evaluate("document.querySelector('#candle-period').value='1';document.querySelector('#candle-period').dispatchEvent(new Event('change'))");
    const refresh=await evaluate("(()=>{const scale=__designChart.chart.timeScale();scale.setVisibleLogicalRange({from:10,to:30});const before=scale.getVisibleLogicalRange();const p=__testState.prices.SPXW??__testState.frames.at(-1).SPXW.price;p.bars.push({at:'2026-11-09T18:01:00Z',o:7548,h:7549,l:7547,c:7548.5,phase:'RTH'});p.collectedAt='2026-11-09T18:01:00Z';__testRender();const after=scale.getVisibleLogicalRange();return{before,after,dataMode:document.querySelector('#plot').dataset.chartDataMode,candles:+document.querySelector('#plot').dataset.candles}})()");
    assert.ok(Math.abs((refresh.before.to-refresh.before.from)-(refresh.after.to-refresh.after.from))<.1);assert.ok(Math.abs(refresh.after.to-refresh.before.to)<=1.1);assert.equal(refresh.dataMode,'append');assert.equal(refresh.candles,one.candles+1);
    await evaluate("__testState.replayCursor=Date.parse('2026-11-09T17:30:00Z');__testRender()");
    const replay=await evaluate("({cursor:+document.querySelector('#plot').dataset.cursor,lastCandle:+document.querySelector('#plot').dataset.lastCandleClose,lastNode:+document.querySelector('#plot').dataset.nodeLastAt,mode:document.querySelector('.chart-panel').dataset.chartMode})");
    assert.equal(replay.mode,'gex');assert.ok(replay.lastCandle<=replay.cursor&&(!replay.lastNode||replay.lastNode<=replay.cursor));
    const report={source:'synthetic SPX cash fixture; no live cash index claim',one,five,refresh,replay,exceptions};
    await writeFile(resolve(artifacts,'spx-cash-fixture.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }
  else if(matrixOnly){
    await evaluate("document.querySelector('#symbols button[data-symbol=SPY]').click();document.querySelector('.detail').scrollIntoView({block:'start'})");
    await until("document.querySelector('#matrix table tbody tr') && document.querySelector('#matrix').getBoundingClientRect().width>0");
    await evaluate("document.querySelector('.detail').scrollIntoView({block:'start'})");await wait(250);
    const info=await evaluate("(()=>{const rows=[...document.querySelectorAll('#matrix tbody tr')],cells=rows.flatMap(r=>[...r.cells].slice(1));return{rows:rows.length,columns:rows[0]?.cells.length,colors:[...new Set(cells.map(c=>getComputedStyle(c).backgroundColor))],positiveTop:cells.filter(c=>c.classList.contains('matrix-top-positive')).length,negativeTop:cells.filter(c=>c.classList.contains('matrix-top-negative')).length,topTitles:cells.filter(c=>c.className.includes('matrix-top')).map(c=>c.title),minText:cells.map(c=>c.textContent).filter(Boolean).slice(0,8),legend:document.querySelector('#matrix-legend')?.textContent??'',summary:document.querySelector('#matrix-extremes')?.textContent??''}})()");
    const name=process.argv.includes('--before')?'before':'after';const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,`matrix-${name}.png`),Buffer.from(shot.data,'base64'));
    if(name==='after'){await evaluate("document.querySelector('#matrix').scrollTop=document.querySelector('#matrix').scrollHeight");await wait(150);const lower=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'matrix-after-negative.png'),Buffer.from(lower.data,'base64'));}
    await writeFile(resolve(artifacts,`matrix-${name}.json`),JSON.stringify({info,exceptions},null,2));assert.deepEqual(exceptions,[]);if(name==='after'){assert.equal(info.positiveTop,3);assert.equal(info.negativeTop,3);assert.ok(info.colors.includes('rgb(252, 231, 83)')&&info.colors.includes('rgb(135, 56, 209)'));assert.ok(info.summary.includes('+1')&&info.summary.includes('−1'));}console.log(JSON.stringify(info));
  }
  else if(exportLive){
    await evaluate("document.querySelector('#symbols button[data-symbol=SPY]').click();document.querySelector('#export-gex-levels').click()");
    const result=await evaluate("(()=>({open:document.querySelector('#gex-export-dialog').open,row:document.querySelector('#gex-snapshot').value,pine:document.querySelector('#gex-pine-snapshot').value,pineCopyEnabled:!document.querySelector('#copy-gex-pine-snapshot').disabled,status:document.querySelector('#gex-export-status').textContent,copyEnabled:!document.querySelector('#copy-gex-snapshot').disabled,buttonLeft:document.querySelector('#export-gex-levels').getBoundingClientRect().left,refreshLeft:document.querySelector('#refresh').getBoundingClientRect().left}))()");
    assert.ok(result.open&&result.buttonLeft<result.refreshLeft&&result.row.startsWith('SPY,'));
    assert.ok(result.copyEnabled?result.row.split(',').length===7:result.status.includes('不能生成完整记录'));
    assert.ok(result.pineCopyEnabled&&result.pine.startsWith('GEX3|SPY|'));
    assert.ok(result.pine.includes('\nN|')||result.status.includes('历史仍在加载'));
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'gex-export-live.png'),Buffer.from(shot.data,'base64'));
    await writeFile(resolve(artifacts,'gex-export-live.json'),JSON.stringify({result,exceptions},null,2));assert.deepEqual(exceptions,[]);console.log(JSON.stringify(result));
  }
  else if(focusSwitch){
    const before=process.argv.includes('--before'),tag=before?'before':'after';
    const stateOf=()=>evaluate("(()=>{const p=document.querySelector('.chart-panel'),mode=document.querySelector('#chart-mode-switch'),title=document.querySelector('#chart-title');return {activeSymbol:p.dataset.activeSymbol??document.querySelector('#symbols button[aria-pressed=true]')?.dataset.symbol,chartMode:p.dataset.chartMode,candles:Number(document.querySelector('#plot').dataset.candles??0),iframe:document.querySelector('#tv-widget iframe')?.src??null,iframeVisible:!document.querySelector('#tv-panel').hidden,modeButtonVisible:getComputedStyle(mode).display!=='none',modeButtonDistance:Math.round(mode.getBoundingClientRect().left-title.getBoundingClientRect().right),replayCursor:document.querySelector('#plot').dataset.cursor,title:title.textContent,levels:document.querySelector('#spx-levels').hidden?'':document.querySelector('#spx-levels').textContent,message:document.querySelector('#chart-message').textContent,leftQuote:document.querySelector('[data-ladder=left] .header-spot').textContent,leftMarker:document.querySelector('[data-ladder=left] .spot-marker span')?.textContent}})()");
    const snap=async name=>{const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,`focus-${tag}-${name}.png`),Buffer.from(shot.data,'base64'));};
    await evaluate("document.querySelector('#symbols button[data-symbol=SPY]').click()");await wait(350);
    const spyStart=await stateOf();await snap('spy-start');
    await evaluate("document.querySelector('#symbols button[data-symbol=SPXW]').click()");
    if(!before)await until("document.querySelector('.chart-panel').dataset.chartMode==='tradingview' && !!document.querySelector('#tv-widget iframe')");
    await wait(before?400:2500);const spxButton=await stateOf();await snap('spx-button');
    await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");await wait(350);
    const spyReturn=await stateOf();await snap('spy-return');
    await evaluate("document.querySelector('[data-ladder=left] .focus-column').click()");
    if(!before)await until("document.querySelector('.chart-panel').dataset.chartMode==='tradingview' && !!document.querySelector('#tv-widget iframe')");
    await wait(350);const spxFocus=await stateOf();await snap('spx-focus');
    let replayCheck=null,manualCheck=null;
    if(!before){
      await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click();document.querySelector('#replay-date').value='2026-11-10';document.querySelector('#replay-time').value='13:07';document.querySelector('#replay-form').requestSubmit()");
      await until("document.querySelector('#plot').dataset.cursor!=='live' && document.querySelector('.chart-panel').dataset.activeSymbol==='SPY'");
      const spyReplay=await stateOf();
      await evaluate("document.querySelector('[data-ladder=left] .focus-column').click()");await wait(350);
      const spxReplay=await stateOf();
      await evaluate("document.querySelector('#latest').click()");await until("document.querySelector('.chart-panel').dataset.chartMode==='tradingview'");
      replayCheck={spyReplay,spxReplay,afterExit:await stateOf()};
      await evaluate("document.querySelector('#mode-gex').click()");const manualGex=await stateOf();await snap('spx-manual-gex');
      await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click();document.querySelector('[data-ladder=left] .focus-column').click()");
      manualCheck={manualGex,afterRoundtrip:await stateOf()};
    }
    const report={address:live?'http://127.0.0.1:8766/':`http://127.0.0.1:${server.address().port}/`,spyStart,spxButton,spyReturn,spxFocus,replayCheck,manualCheck,exceptions};
    await writeFile(resolve(artifacts,`focus-${tag}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    if(!before){assert.equal(spyStart.activeSymbol,'SPY');assert.equal(spyStart.chartMode,'gex');assert.equal(spxButton.activeSymbol,'SPXW');assert.equal(spxButton.chartMode,'tradingview');assert.ok(spxButton.iframeVisible&&spxButton.iframe?.includes('FOREXCOM'));assert.equal(spyReturn.activeSymbol,'SPY');assert.equal(spyReturn.chartMode,'gex');assert.equal(spxFocus.activeSymbol,'SPXW');assert.equal(spxFocus.chartMode,'tradingview');assert.ok(spxFocus.modeButtonVisible&&spxFocus.modeButtonDistance<80);
      assert.equal(replayCheck.spyReplay.chartMode,'gex');assert.equal(replayCheck.spxReplay.chartMode,'gex');assert.equal(replayCheck.spyReplay.replayCursor,replayCheck.spxReplay.replayCursor);assert.equal(replayCheck.afterExit.chartMode,'tradingview');
      assert.equal(manualCheck.manualGex.chartMode,'gex');assert.equal(manualCheck.manualGex.candles,0);assert.ok(manualCheck.manualGex.message.includes('暂不支持美股指数'));assert.equal(manualCheck.afterRoundtrip.chartMode,'gex');
      assert.ok(spxButton.levels.includes('King')&&spxButton.levels.includes('REF'));assert.ok(spxButton.leftQuote.startsWith('REF ')&&spxButton.leftMarker.startsWith('REF '));assert.deepEqual(exceptions,[]);}
  }
  else if(tvOnly){
    await evaluate("document.querySelector('#mode-tv').click()");
    await wait(18000);
    const active=await evaluate("(()=>({mode:document.querySelector('.chart-panel').dataset.chartMode,source:document.querySelector('#chart-source').textContent,title:document.querySelector('#chart-title').textContent,spot:document.querySelector('#tv-app-spot').textContent,cone:document.querySelector('#tv-app-cone').textContent,status:document.querySelector('#tv-status').textContent,statusState:document.querySelector('#tv-status').dataset.state??'',iframe:document.querySelector('#tv-widget iframe')?.src??null,script:document.querySelector('#tv-widget script')?.src,minute:document.querySelector('#tv-widget script')?.dataset.interval,gexControlsVisible:getComputedStyle(document.querySelector('.layer-controls')).display!=='none',replayVisible:getComputedStyle(document.querySelector('.replay')).display!=='none',openLink:document.querySelector('#tv-open').href}))()");
    const captureStem=process.argv.includes('--open-check')?'tv-open':`tv-${live?'live':'fixture'}`,observing=process.argv.includes('--observe');
    const startFile=`${captureStem}${observing?'-observe-start':''}.png`;
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,startFile),Buffer.from(shot.data,'base64'));
    let observation=null;
    if(observing){
      const startedAt=new Date().toISOString();await wait(70000);
      const endFile=`${captureStem}-observe-end.png`;
      const later=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,endFile),Buffer.from(later.data,'base64'));
      observation={startedAt,finishedAt:new Date().toISOString(),screenshots:[startFile,endFile]};
    }
    await evaluate("document.querySelector('#mode-gex').click()");await wait(300);
    const restored=await evaluate("({mode:document.querySelector('.chart-panel').dataset.chartMode,canvas:document.querySelectorAll('#plot canvas').length,replayVisible:getComputedStyle(document.querySelector('.replay')).display!=='none'})");
    console.log('tv-browser-state',JSON.stringify(active));
    assert.equal(active.mode,'tradingview');assert.equal(active.title,'S&P 500 CFD 参考图 · FOREXCOM:SPXUSD');assert.equal(active.source,'TradingView · FOREXCOM:SPXUSD');assert.ok(decodeURIComponent(active.iframe??'').includes('"interval":"1"'));assert.ok(decodeURIComponent(active.iframe??'').includes('"symbol":"FOREXCOM:SPXUSD"'));assert.equal(active.gexControlsVisible,false);assert.equal(active.replayVisible,false);
    assert.equal(restored.mode,'gex');assert.ok(restored.canvas>0&&restored.replayVisible);
    const report={active,restored,observation,tvNetwork:tvNetwork.slice(0,30),exceptions,checkedAt:new Date().toISOString()};
    await writeFile(resolve(artifacts,`${captureStem}${observing?'-observe':''}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }
  else if(compareOnly){
    await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");
    await wait(600);
    await evaluate("__designChart.chart.timeScale().setVisibleRange({from:Date.parse('2026-11-10T16:00:00Z')/1000,to:Date.parse('2026-11-10T20:10:00Z')/1000})");
    await wait(200);
    const rect=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
    assert.equal(Math.round(rect.width),690);assert.equal(Math.round(rect.height),480);
    const name=process.argv.includes('--before')?'before':'after';
    const shot=await send('Page.captureScreenshot',{format:'png',clip:rect});await writeFile(resolve(artifacts,`compare-${name}-chart.png`),Buffer.from(shot.data,'base64'));
    const desktop=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,`compare-${name}-desktop.png`),Buffer.from(desktop.data,'base64'));
    const report={name,rect,source:'same frozen OpenD frames; SPY; ALL; 5m; 16:00–20:10 UTC; 690×480 CSS pixels',exceptions};
    await writeFile(resolve(artifacts,`compare-${name}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }
  else if(corner){await runCorner({send,evaluate,until,wait,artifacts,before:process.argv.includes('--before'),live});assert.deepEqual(exceptions,[]);}
  else if(axisOnly){
    await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");
    await until("document.querySelector('.chart-panel').dataset.activeSymbol==='SPY' && +document.querySelector('#plot').dataset.candles>0");
    await wait(250);
    const coords=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect(),p=__designChart.chart.paneSize();return {axis:{x:r.x+p.width+12,y:r.y+p.height*.4},pane:{x:r.x+p.width*.25,y:r.y+p.height*.4}}})()");
    const state=()=>evaluate("({range:__designChart.chart.priceScale('right').getVisibleRange(),auto:__designChart.chart.priceScale('right').options().autoScale,prefAuto:__testState.chartAutoScale,time:__designChart.chart.timeScale().getVisibleLogicalRange()})");
    const before=await state();
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:coords.axis.x,y:coords.axis.y,deltaX:0,deltaY:-450});await wait(180);
    const wheel=await state();
    const drag=async(point,dx,dy)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});for(let i=1;i<=4;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx*i/4,y:point.y+dy*i/4,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',buttons:0,clickCount:1});await wait(180);};
    await drag(coords.pane,0,-80);const pane=await state();
    await drag(coords.axis,0,80);const axis=await state();
    await drag(coords.pane,-80,0);const horizontal=await state();
    await evaluate('__testRender()');const refreshed=await state();
    for(const clickCount of [1,2]){await send('Input.dispatchMouseEvent',{type:'mousePressed',x:coords.axis.x,y:coords.axis.y,button:'left',buttons:1,clickCount});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:coords.axis.x,y:coords.axis.y,button:'left',buttons:0,clickCount});}
    await wait(120);const reset=await state();
    const span=value=>value.range.to-value.range.from;
    assert.ok(span(wheel)<span(before)&&!wheel.auto&&!wheel.prefAuto);
    assert.deepEqual(wheel.time,before.time);
    assert.ok(pane.range.from<wheel.range.from&&Math.abs(span(pane)-span(wheel))<.001);
    assert.deepEqual(pane.time,wheel.time);
    assert.ok(Math.abs(span(axis)-span(pane))>.01);
    assert.ok(Math.abs(horizontal.time.from-axis.time.from)>1);
    assert.ok(Math.abs(span(refreshed)-span(horizontal))<.001&&!refreshed.auto);
    assert.ok(reset.auto&&reset.prefAuto);
    assert.deepEqual(exceptions,[]);
    console.log(JSON.stringify({coords,before,wheel,pane,axis,horizontal,refreshed,reset,exceptions}));
  }
  else if(rangeOnly){
    await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");
    await until("__testState.prices.SPY?.spot&&__testState.frames.at(-1)?.SPY");
    const sample=await evaluate("(()=>{const s=__testState;const f=s.frames.at(-1).SPY;return {capture:f.collectedAt,spot:f.spot.value,iv:f.cells.find(c=>c.callQuote?.iv)?.callQuote.iv}})()");
    await evaluate("(()=>{const s=__testState;s.fixedRanges=[{symbol:'SPY',optionRoot:'SPY',provider:'OpenD',available:true,kind:'fixed-day',quality:'Estimated',rangeDate:'2026-11-09',modelVersion:'opend-atm-paired-iv-act365-v1',spot:750,anchor:750,asOf:'2026-11-06T21:00:00Z',at:Date.parse('2026-11-06T21:00:00Z'),until:Date.parse('2026-11-09T21:00:00Z'),settleAt:'2026-11-09T21:00:00Z',impliedHigh1:752,impliedLow1:748,impliedHigh2:754,impliedLow2:746}];s.dayRange=true;s.cone=true;__testRender()})()");
    const setSpot=async value=>evaluate(`(()=>{const p=__testState.prices.SPY;p.spot={...p.spot,value:${value},at:'2026-11-09T18:00:59Z',current:true,status:'RTH'};p.collectedAt='2026-11-09T18:00:59Z';__testRender();return {outside:document.querySelector('#chart-message').textContent,cone:JSON.parse(document.querySelector('#plot').dataset.cone||'null'),dayLines:__designChart.levels.filter(l=>l.label.includes('Day')).map(l=>({price:l.price,label:l.label}))}})()`);
    const capture=async name=>{await wait(120);const r=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");const shot=await send('Page.captureScreenshot',{format:'png',clip:r});await writeFile(resolve(artifacts,name+'.png'),Buffer.from(shot.data,'base64'));};
    const above=await setSpot(753);assert.ok(above.outside.includes('Above')&&above.outside.includes('+1.50σ'));await capture('range-above');
    const inside=await setSpot(750);assert.ok(!inside.outside.includes("today's expected range"));await capture('range-inside');
    const axis=await evaluate("(()=>({focus:JSON.parse(document.querySelector('#plot').dataset.priceFocus),visible:__designChart.chart.priceScale('right').getVisibleRange()}))()");
    assert.deepEqual(axis.focus,{low:748,high:752});
    assert.ok(axis.visible&&axis.visible.to-axis.visible.from<12,`Day ±1σ axis remains too wide: ${JSON.stringify(axis.visible)}`);
    const exported=await evaluate("(()=>{document.querySelector('#export-gex-levels').click();const row=document.querySelector('#gex-snapshot').value,status=document.querySelector('#gex-export-status').textContent,copyEnabled=!document.querySelector('#copy-gex-snapshot').disabled;document.querySelector('#gex-export-dialog').close();return {row,status,copyEnabled}})()");
    const fields=exported.row.split(',');assert.equal(fields.length,7);assert.equal(fields[0],'SPY');assert.equal(fields[1],'20261109');assert.equal(fields[4],'748');assert.equal(fields[5],'752');assert.ok(exported.copyEnabled);
    const below=await setSpot(747);assert.ok(below.outside.includes('Below')&&below.outside.includes('-1.50σ'));await capture('range-below');
    assert.deepEqual(above.dayLines,inside.dayLines);assert.deepEqual(inside.dayLines,below.dayLines);
    assert.ok(above.cone&&inside.cone&&below.cone&&above.cone.spot!==inside.cone.spot);
    await evaluate("document.querySelector('[data-action=pin]').click()");const pinned=await evaluate("document.querySelector('#plot').dataset.cone");
    await setSpot(753);assert.equal(await evaluate("document.querySelector('#plot').dataset.cone"),pinned);
    await capture('range-pinned');
    await evaluate("__testState.replayCursor=Date.parse('2026-11-09T15:35:00Z');__testRender()");
    const replay=await evaluate("({cursor:+document.querySelector('#plot').dataset.cursor,lastNode:+document.querySelector('#plot').dataset.nodeLastAt,cone:document.querySelector('#plot').dataset.cone,pin:__testState.pinActive})");
    assert.ok(!replay.cone&&!replay.pin&&(!replay.lastNode||replay.lastNode<=replay.cursor));await capture('range-replay');
    await evaluate("__testState.replayCursor=Date.parse('2026-11-09T18:07:00Z');__testRender()");
    const replayLater=await evaluate("({cursor:+document.querySelector('#plot').dataset.cursor,lastNode:+document.querySelector('#plot').dataset.nodeLastAt,cone:document.querySelector('#plot').dataset.cone,pin:__testState.pinActive})");
    assert.ok(!replayLater.pin&&(!replayLater.lastNode||replayLater.lastNode<=replayLater.cursor));await capture('range-replay-later');
    const report={marketData:'synthetic fixture',sample,axis,above,inside,below,exported,pinned:JSON.parse(pinned),replay,replayLater,exceptions};
    await writeFile(resolve(artifacts,'range-scenarios.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,sample,above:above.outside,inside:inside.outside,below:below.outside,pinFrozen:true,replay}));
  }
  else if(derivedOnly){
    await until("document.querySelector('#plot').__gexNodeAudit?.some(n=>n.shape==='diamond')");
    const audit=await evaluate("document.querySelector('#plot').__gexNodeAudit");
    const summary={native:audit.filter(n=>n.shape==='ellipse').length,derived:audit.filter(n=>n.shape==='diamond').length,
      sample:audit.find(n=>n.shape==='diamond'),exceptions};
    assert.ok(summary.derived>0&&summary.sample.mapping.includes('paired-spot'));
    const crop=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
    const shot=await send('Page.captureScreenshot',{format:'png',clip:crop});
    await writeFile(resolve(artifacts,'derived-fixture-chart.png'),Buffer.from(shot.data,'base64'));
    await writeFile(resolve(artifacts,'derived-fixture-audit.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
  }
  else if(labelsOnly){
    await evaluate("document.querySelector('#expiry').value='front';document.querySelector('#expiry').dispatchEvent(new Event('change'))");
    await until("document.querySelector('[data-ladder=left] .spot-marker span')&&/^[+−-]?[0-9]+\\.[0-9]{2}%$/.test(document.querySelector('[data-ladder=left] .day-change').textContent)");
    const result=await evaluate("(()=>{const l=document.querySelector('[data-ladder=left]');return {header:l.querySelector('.header-spot').textContent,marker:l.querySelector('.spot-marker span').textContent,percent:l.querySelector('.day-change').textContent,explanation:l.querySelector('.day-change').title,status:l.querySelector('.column-status').textContent,chart:document.querySelector('#chart-title').textContent}})()");
    assert.ok(!result.header.includes('REF'));assert.ok(result.marker.startsWith('Spot '));
    assert.ok(!result.chart.includes('REF'));assert.ok(result.status.includes('REF'));
    assert.ok(result.explanation.includes('估算'));
    assert.deepEqual(exceptions,[]);
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'spxw-labels.png'),Buffer.from(shot.data,'base64'));
    await writeFile(resolve(artifacts,'spxw-labels.json'),JSON.stringify({passed:true,live,result,exceptions},null,2));console.log(JSON.stringify({passed:true,live,result,exceptions}));
  }
  else if(design){await runDesign({send,evaluate,until,wait,artifacts,before:process.argv.includes('--before')});assert.deepEqual(exceptions,[]);}
  else if(dragOnly){
    const point=await evaluate("(()=>{const h=document.querySelector('[data-action=drag]');h.focus();window.dragEvents=[];for(const type of ['pointerdown','pointermove','pointerup'])h.addEventListener(type,e=>window.dragEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,id:e.pointerId}),true);const r=h.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,right:getComputedStyle(document.querySelector('.chart-tools')).right}})()");
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});await wait(100);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x-30,y:point.y-15,buttons:1});await wait(100);
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x-30,y:point.y-15,button:'left',buttons:0,clickCount:1});await wait(100);
    const result=await evaluate("({events:window.dragEvents,right:document.querySelector('.chart-tools').style.right,bottom:document.querySelector('.chart-tools').style.bottom})");
    console.log(JSON.stringify({point,result,exceptions}));
    assert.ok(parseFloat(result.right)>parseFloat(point.right));assert.deepEqual(exceptions,[]);
  }
  else if(extended){await runAcceptance({send,evaluate,until,wait,artifacts,live,network,exceptions});}
  else if(live){
    await until("document.querySelectorAll('.strike-row').length>0");
    const status=await evaluate("({ladders:document.querySelectorAll('.ladder').length,rows:document.querySelectorAll('.strike-row').length,status:document.querySelector('#feed-state').textContent,notice:document.querySelector('#notice').textContent})");
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'live-desktop.png'),Buffer.from(shot.data,'base64'));
    assert.deepEqual(exceptions,[]);console.log(JSON.stringify({realLocalBrowser:status,exceptions}));
  }else{
  assert.ok(await evaluate("document.querySelector('#chart-message').textContent.includes('SPX K 线源')"));
  assert.equal(await evaluate('LightweightCharts.version()'),'5.2.1');
  await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");
  await until("document.querySelector('#chart-title').textContent.startsWith('SPY')");
  assert.ok(await evaluate("/^[+−-]?[0-9]+\\.[0-9]{2}%$/.test(document.querySelector('[data-ladder=middle] .day-change').textContent)"));
  await evaluate("document.querySelector('#candle-period').value='1';document.querySelector('#candle-period').dispatchEvent(new Event('change'))");
  await evaluate("document.querySelector('#cone').click();document.querySelector('#pin').click()");
  assert.equal(await evaluate("document.querySelector('#pin').textContent"),'Unpin cone');
  await evaluate("document.querySelector('#day-range').click()");
  assert.ok(await evaluate("document.querySelector('#chart-message').textContent.includes('Day Range 不可用')"));
  await evaluate("document.querySelector('[data-ladder=middle] .ladder-top button').click();document.querySelector('#symbol-input').value='NVDA';document.querySelector('#symbol-form').requestSubmit()");
  await until("!document.querySelector('#symbol-dialog').open && document.querySelector('[data-ladder=middle]').textContent.includes('NVDA')");
  assert.ok(await evaluate("localStorage.getItem('gex-columns').includes('NVDA')"));
  await evaluate("document.querySelector('[data-ladder=right] .ladder-top button').click();document.querySelector('#symbol-input').value='BAD';document.querySelector('#symbol-form').requestSubmit()");
  await until("document.querySelector('#symbol-error').textContent.includes('没有期权链')");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until("!document.querySelector('#symbol-dialog').open");
  await evaluate("document.querySelector('#timeline').value='0';document.querySelector('#timeline').dispatchEvent(new Event('input'));document.querySelector('#latest').click()");
  cashIndex=true;await evaluate("document.querySelector('#refresh').click()");
  await until("document.querySelector('#feed-state').textContent!=='Refreshing'");
  await evaluate("document.querySelector('[data-ladder=left] .focus-column').click()");
  assert.ok(!(await evaluate("document.querySelector('#chart-message').textContent.includes('SPX K 线源')")));
  await evaluate("document.querySelector('[data-ladder=middle] .ladder-top button').click();document.querySelector('#symbol-input').value='SPY';document.querySelector('#symbol-form').requestSubmit()");
  await until("!document.querySelector('#symbol-dialog').open && document.querySelector('[data-ladder=middle]').textContent.includes('SPY')");
  await evaluate("document.querySelector('[data-ladder=left] .focus-column').click()");
  await until("document.querySelector('#derived').textContent==='Derived 1/1'");
  await evaluate("document.querySelector('#derived').click()");assert.equal(await evaluate("document.querySelector('#derived').textContent"),'Derived 0/1');
  await evaluate("document.querySelector('#derived').click();document.querySelector('#nodes').click()");
  assert.ok(await evaluate("document.querySelector('#layer-meta').textContent.startsWith('0 nodes')"));
  await evaluate("document.querySelector('#nodes').click();document.querySelector('#walls').click();document.querySelector('#walls').click();document.querySelector('#two-sigma').click()");
  await evaluate("document.querySelector('[data-ladder=middle] .ladder-top button').click();document.querySelector('#symbol-input').value='NVDA';document.querySelector('#symbol-form').requestSubmit()");
  await until("!document.querySelector('#symbol-dialog').open && document.querySelector('[data-ladder=middle]').textContent.includes('NVDA')");
  await evaluate("document.querySelector('[data-ladder=left] .focus-column').click()");
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:330});
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:1100,y:330,deltaX:0,deltaY:-120});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:1100,y:330,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1180,y:330,buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:1180,y:330,button:'left',clickCount:1});
  await wait(150);
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'desktop.png'),Buffer.from(shot.data,'base64'));
  await send('Page.reload');await until("document.querySelector('[data-ladder=middle]')?.textContent.includes('NVDA')");
  await until("document.querySelector('#feed-state').textContent!=='Refreshing'");await wait(200);
  const priorCounts={...counts};await wait(15500);
  assert.ok(counts.price>=priorCounts.price+3,'independent price polling must refresh all three unique symbols');
  assert.equal(counts.snapshot,priorCounts.snapshot,'price polling must not recapture GEX');
  await send('Emulation.setDeviceMetricsOverride',{width:430,height:920,deviceScaleFactor:1,mobile:true});await wait(200);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'));
  const mobile=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'mobile.png'),Buffer.from(mobile.data,'base64'));
  assert.deepEqual(exceptions,[]);
  await writeFile(resolve(artifacts,'result.json'),JSON.stringify({passed:true,marketData:'synthetic fixtures',chart:'Lightweight Charts 5.2.1',checks:['render','selectors','invalid symbol','Escape','persistence','K timeframe','cone','Pin','missing range','SPX cash recovery','replay','crosshair/zoom/drag','mobile layout'],exceptions},null,2));
  console.log('Browser/CDP passed: actual chart render, interactions and screenshots; synthetic market fixtures.');
  }
}finally{
  socket?.close();browser.kill();await new Promise(r=>server.close(r));
}

