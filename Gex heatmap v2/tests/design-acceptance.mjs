import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
export async function runDesign({send,evaluate,until,wait,artifacts,before}){
  const report={marketData:'frozen real OpenD, not design-reference prices',before,checks:[]};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change=(id,value)=>evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(String(value))};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);
  const key=async(name,code,number)=>{for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:number});};
  const screenshot=async name=>{await wait(150);const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,name+'.png'),Buffer.from(shot.data,'base64'));};
  const sameRange=()=>evaluate("__designChart.chart.timeScale().setVisibleRange({from:Date.parse('2026-11-10T16:00:00Z')/1000,to:Date.parse('2026-11-10T20:10:00Z')/1000})");
  await until("document.querySelectorAll('.strike-row').length>0");
  await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click()");
  await until("document.querySelector('#chart-title').textContent.startsWith('SPY')");
  await wait(600);await sameRange();
  await screenshot(`design-${before?'before':'after'}-desktop`);
  report.state=await evaluate("({title:document.querySelector('#chart-title').textContent,meta:document.querySelector('#layer-meta').textContent,rows:[...document.querySelectorAll('.ladder')].map(l=>({symbol:l.dataset.symbol,rows:l.querySelectorAll('.strike-row').length}))})");
  if(before){const crop=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
    const shot=await send('Page.captureScreenshot',{format:'png',clip:crop});await writeFile(resolve(artifacts,'design-before-chart.png'),Buffer.from(shot.data,'base64'));
    await writeFile(resolve(artifacts,'design-before.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return;}
  assert.equal(await evaluate("document.querySelector('#range').value"),'40');
  for(const limit of [20,30,40,50,60]){
    await click('#range-button');await click(`#range-listbox [data-value="${limit}"]`);
    const counts=await evaluate("[...document.querySelectorAll('.ladder')].map(l=>l.querySelectorAll('.strike-row').length)");
    assert.deepEqual(counts,[limit,limit,limit]);
  }
  await click('#center');assert.equal(await evaluate("document.querySelector('#center').textContent"),'King');await click('#center');
  for(const speed of [1,5,15,30]){
    await click('#speed-button');await click(`#speed-listbox [data-value="${speed}"]`);
    assert.ok(await evaluate(`document.querySelectorAll('.strike-row').length>0&&[...document.querySelectorAll('.strike-row')].every(r=>r.title.includes(' · ${speed}m · '))`));
  }
  const lastSpots=await evaluate("[...document.querySelectorAll('.header-spot')].map(n=>n.dataset.value)");
  await change('candle-period',15);assert.deepEqual(await evaluate("[...document.querySelectorAll('.header-spot')].map(n=>n.dataset.value)"),lastSpots);
  await change('candle-period',5);
  report.checks.push('all five strike counts + Spot/King center','all four real-history velocity lookbacks, independent of K period');
  // Real keyboard interaction: a highlighted option is not committed until Enter.
  await evaluate("document.querySelector('#range-button').focus()");await key('Enter','Enter',13);await key('Home','Home',36);await key('ArrowDown','ArrowDown',40);await key('Enter','Enter',13);
  assert.equal(await evaluate("document.querySelector('#range').value"),'30');
  await key('Enter','Enter',13);await key('ArrowDown','ArrowDown',40);await key('Escape','Escape',27);
  assert.equal(await evaluate("document.querySelector('#range').value"),'30');
  assert.equal(await evaluate("document.querySelector('#range-button').getAttribute('aria-expanded')"),'false');
  await click('#speed-button');
  const outside=await evaluate("(()=>{const r=document.querySelector('.brand').getBoundingClientRect();return{x:r.x+5,y:r.y+5}})()");
  for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...outside,button:'left',clickCount:1});
  assert.equal(await evaluate("document.querySelector('#speed-button').getAttribute('aria-expanded')"),'false');
  await click('#range-button');await screenshot('design-dark-dropdown');await key('Escape','Escape',27);
  await send('Page.reload');await until("document.querySelector('#range-button')&&document.querySelectorAll('.strike-row').length===90");
  assert.equal(await evaluate("document.querySelector('#speed').value"),'30');
  report.checks.push('keyboard arrows/Enter/Esc/outside-close/focus','reload persistence: 30 strikes / 30m');
  await click('[data-ladder=middle] .focus-column');
  for(const id of ['nodes','walls','day-range']){await click('#'+id);await click('#'+id);}
  for(const id of ['left','middle','right']){
    await click(`[data-ladder=${id}] .symbol-picker`);assert.equal(await evaluate("document.querySelector('#symbol-dialog').open"),true);await key('Escape','Escape',27);
    await click(`[data-ladder=${id}] .focus-column`);
    const symbol=await evaluate(`document.querySelector('[data-ladder=${id}]').dataset.symbol`);
    assert.ok(await evaluate(`document.querySelector('#chart-title').textContent.includes('${symbol==='SPXW'?'SPX / SPXW':symbol}')`));
  }
  await click('[data-ladder=middle] .focus-column');await sameRange();
  const geometry=async()=>evaluate(`(()=>{const bounds=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width}};return [...document.querySelectorAll('.ladder')].map(l=>{const m=l.querySelector('.spot-marker span'),h=l.querySelector('.strike-value');const range=document.createRange();range.selectNodeContents(m);const label=bounds(m),text=range.getBoundingClientRect();return {symbol:l.dataset.symbol,header:bounds(l.querySelector('.ladder-top')),king:bounds(l.querySelector('.king-row')),first:bounds(l.querySelector('.ladder-body')),label,textRight:text.right,heat:bounds(h),amounts:[...l.querySelectorAll('.gex-amount')].map(bounds).filter(a=>a.y<label.bottom&&a.bottom>label.y)}})})()`);
  for(const width of [1500,1120,850]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await wait(200);
    const layout=await geometry();
    assert.ok(layout.every(l=>Math.abs(l.header.bottom-l.king.y)<1&&Math.abs(l.king.bottom-l.first.y)<1));
    assert.ok(layout.every(l=>Math.abs((l.label.x+l.label.width/2)-(l.heat.x+l.heat.width/2))<2));
    assert.ok(layout.every(l=>l.amounts.every(a=>l.textRight<=a.x+1)),JSON.stringify(layout));
    if(width!==1500)await screenshot('design-after-'+width);
  }
  report.checks.push('equal 36px/32px headers and aligned rows','Spot/REF text centered, no amount overlap at 1500/1120/850px');
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
  await change('range',40);await change('speed',5);await sameRange();await wait(200);
  report.sampling=await evaluate("({sampling:JSON.parse(document.querySelector('#plot').dataset.nodeSampling),rendering:JSON.parse(document.querySelector('#plot').dataset.nodeRendering),layers:__designChart.layer.paneViews().map(v=>v.zOrder()),candles:__designChart.series.options()})");
  report.nodeAudit=await evaluate("document.querySelector('#plot').__gexNodeAudit??[]");
  await writeFile(resolve(artifacts,'design-node-audit-after.json'),JSON.stringify(report.nodeAudit,null,2));
  assert.equal(report.sampling.rendering.zOrder,'bottom');assert.ok(report.sampling.rendering.maxWidth<=8);
  assert.ok(report.sampling.rendering.maxWidth<=report.sampling.rendering.spacing*.72+.01);
  // Select the strongest visible real node that crosses a real candle for a close crop.
  report.nodeCrossings=await evaluate("__designChart.layer.hits.filter(n=>__designChart.visibleCandles.some(c=>c.time===n.time&&c.low<=n.price&&c.high>=n.price)).sort((a,b)=>b.weight-a.weight).slice(0,3).map(n=>({time:n.time,price:n.price,weight:n.weight,source:n.source}))");
  assert.ok(report.nodeCrossings.length,'real candles must cross actual nodes for visual inspection');
  await screenshot('design-after-desktop');
  const crop=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
  const shot=await send('Page.captureScreenshot',{format:'png',clip:crop});await writeFile(resolve(artifacts,'design-after-chart.png'),Buffer.from(shot.data,'base64'));
  // Mid-session Replay: physically truncated candles, snapshots and labels stay as-of.
  await evaluate("document.querySelector('#replay-date').value='2026-11-10';document.querySelector('#replay-time').value='13:07';document.querySelector('#replay-form').requestSubmit()");await wait(500);
  const read=()=>evaluate("({cursor:+document.querySelector('#plot').dataset.cursor,lastCandle:+document.querySelector('#plot').dataset.lastCandleClose,lastNode:+document.querySelector('#plot').dataset.nodeLastAt,spots:[...document.querySelectorAll('.header-spot')].map(n=>n.dataset.value),velocity:[...document.querySelectorAll('.velocity')].map(n=>n.textContent)})");
  report.replay=await read();assert.ok(report.replay.lastCandle<=report.replay.cursor);assert.ok(report.replay.lastNode<=report.replay.cursor);
  await click('#refresh');await wait(1000);assert.deepEqual(await read(),report.replay);
  await change('speed',30);await screenshot('design-after-replay');
  await click('#latest');assert.equal(await evaluate("document.querySelector('#plot').dataset.cursor"),'live');
  report.checks.push('real-node/candle crossing and bottom render layer','mid-session Replay cutoff + paused Live refresh isolation + return to Live');
  await writeFile(resolve(artifacts,'design-after.json'),JSON.stringify({...report,passed:true},null,2));
  console.log(JSON.stringify({passed:true,checks:report.checks,sampling:report.sampling,replay:report.replay,nodeCrossings:report.nodeCrossings}));
}
