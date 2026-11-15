// Repeatable real-browser timing in a fresh, isolated Chrome profile.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';

const base='http://127.0.0.1:8766/',out=resolve('tests/browser-artifacts'),profile=resolve(out,'perf-profile-'+Date.now());
await mkdir(profile,{recursive:true});
const browserPath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!browserPath)throw new Error('Chrome or Edge unavailable');
const browser=spawn(browserPath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-extensions','--disable-background-networking','--disable-sync','--window-size=1500,1000','about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let socket;
try{
  let port;for(let i=0;i<100;i++){try{port=Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await sleep(100);}}
  if(!port)throw new Error('Browser DevTools unavailable');
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),page=pages.find(p=>p.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let next=0;const pending=new Map(),network=new Map(),exceptions=[];
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.text);
    if(m.method==='Network.requestWillBeSent'){const url=m.params.request.url;if(url.startsWith(base))network.set(m.params.requestId,{url:url.slice(base.length-1),start:m.params.timestamp});}
    if(m.method==='Network.responseReceived'&&network.has(m.params.requestId)){const r=network.get(m.params.requestId);r.status=m.params.response.status;r.mime=m.params.response.mimeType;r.serverTiming=m.params.response.headers['Server-Timing']??m.params.response.headers['server-timing'];}
    if(m.method==='Network.loadingFinished'&&network.has(m.params.requestId)){const r=network.get(m.params.requestId);r.ms=Math.round((m.params.timestamp-r.start)*1000);r.bytes=m.params.encodedDataLength;}
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const reply=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(reply.exceptionDetails)throw new Error(reply.exceptionDetails.text);return reply.result.value;};
  const until=async(expression,timeout=150000)=>{const started=performance.now();while(performance.now()-started<timeout){try{const value=await evaluate(expression);if(value)return {ms:Math.round(performance.now()-started),value};}catch{}await sleep(50);}throw new Error('Timed out: '+expression);};
  await Promise.all([send('Page.enable'),send('Runtime.enable'),send('Network.enable')]);
  const results=[];
  for(let i=0;i<4;i++){
    network.clear();const start=performance.now();await send('Page.navigate',{url:base});
    const paint=await until("document.querySelector('#trinity')&&document.querySelectorAll('.strike-row').length>0");
    const ready=await until("document.querySelector('#feed-state')?.textContent!=='Refreshing'&&document.querySelector('#feed-state')?.textContent!=='Connecting'");
    const state=await evaluate("(()=>({rows:document.querySelectorAll('.strike-row').length,feed:document.querySelector('#feed-state').textContent,capture:[...document.querySelectorAll('.king-row')].map(e=>e.title.split(' · ').at(-1)),renderMs:Number(document.querySelector('#trinity').dataset.renderMs||0),chartRenderMs:Number(document.querySelector('#plot').dataset.chartRenderMs||0),paint:performance.getEntriesByType('paint').map(e=>({name:e.name,ms:Math.round(e.startTime)})),navigation:performance.getEntriesByType('navigation').map(e=>({dom:Math.round(e.domContentLoadedEventEnd),load:Math.round(e.loadEventEnd)}))}))()");
    results.push({case:i?'reload-'+i:'cold-page',firstRowsMs:Math.round(performance.now()-start-ready.ms),refreshDoneMs:Math.round(performance.now()-start),state,requests:[...network.values()]});
  }
  network.clear();const prior=await evaluate("[...document.querySelectorAll('.king-row')].map(e=>e.title.split(' · ').at(-1))");let start=performance.now();await evaluate("document.querySelector('#refresh').click()");await until("document.querySelector('#feed-state')?.textContent==='Refreshing'",3000).catch(()=>{});
  await until("document.querySelector('#feed-state')?.textContent!=='Refreshing'");const returnedMs=Math.round(performance.now()-start);
  const fresh=await until("[...document.querySelectorAll('.king-row')].every((e,i)=>e.title.split(' · ').at(-1)!=="+JSON.stringify(prior)+"[i])",60000).catch(()=>null);
  results.push({case:'manual-refresh',doneMs:returnedMs,freshMs:fresh?Math.round(performance.now()-start):null,renderMs:await evaluate("Number(document.querySelector('#trinity').dataset.renderMs||0)"),chartRenderMs:await evaluate("Number(document.querySelector('#plot').dataset.chartRenderMs||0)"),requests:[...network.values()]});
  network.clear();start=performance.now();await evaluate("document.querySelector('[data-ladder=middle] .symbol-picker').click();document.querySelector('#symbol-input').value='NVDA';document.querySelector('#symbol-form').requestSubmit()");
  await until("document.querySelector('[data-ladder=middle]')?.dataset.symbol==='NVDA'");const commitMs=Math.round(performance.now()-start);
  await until("document.querySelector('[data-ladder=middle]')?.dataset.phase==='ready'");results.push({case:'switch-NVDA',commitMs,completeMs:Math.round(performance.now()-start),requests:[...network.values()]});
  network.clear();start=performance.now();await evaluate("document.querySelector('#expiry').value='front';document.querySelector('#expiry').dispatchEvent(new Event('change'))");
  await until("document.querySelector('#expiry')?.value==='front'");results.push({case:'switch-expiry',renderMs:Math.round(performance.now()-start),mainThreadMs:await evaluate("Number(document.querySelector('#trinity').dataset.renderMs||0)"),chartRenderMs:await evaluate("Number(document.querySelector('#plot').dataset.chartRenderMs||0)"),requests:[...network.values()]});
  const report={at:new Date().toISOString(),results,exceptions};const output=resolve(out,process.argv.includes('--before')?'performance-before.json':'performance-after.json');
  await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,results:results.map(r=>({case:r.case,firstRowsMs:r.firstRowsMs,refreshDoneMs:r.refreshDoneMs,doneMs:r.doneMs,freshMs:r.freshMs,commitMs:r.commitMs,completeMs:r.completeMs,renderMs:r.renderMs,chartRenderMs:r.chartRenderMs,requests:r.requests.map(q=>({url:q.url,ms:q.ms,bytes:q.bytes,status:q.status}))})),exceptions}));
}finally{socket?.close();browser.kill();}
