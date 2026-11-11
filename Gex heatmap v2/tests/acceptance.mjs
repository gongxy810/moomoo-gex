import assert from 'node:assert/strict';
import {mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runAcceptance({send,evaluate,until,wait,artifacts,live,network,exceptions}){
  const report={marketData:live?'real OpenD':'synthetic fixtures',selection:[],tools:[],replay:{}};
  const downloads=resolve(artifacts,(live?'real-downloads-':'fixture-downloads-')+Date.now());await mkdir(downloads,{recursive:true});report.exportDirectory=downloads;
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key=async(name,code,number,text)=>{
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:number,...(text?{text}:{})});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:number});
  };
  const tool=action=>click(`[data-action="${action}"]`);
  const openMiddle=()=>click('[data-ladder="middle"] .symbol-picker');
  const value=async(selector,text)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(text)}`);
  const choose=async(symbol,mode)=>{
    await openMiddle();const before=Date.now();
    if(mode==='shortcut')await click(`[data-symbol-choice="${symbol}"]`);
    else{
      await value('#symbol-input',symbol.toLowerCase());
      if(mode==='enter'){await evaluate("document.querySelector('#symbol-input').focus()");await key('Enter','Enter',13,'\r');}
      else await click('#symbol-form button[type="submit"]');
    }
    await until(`!document.querySelector('#symbol-dialog').open&&document.querySelector('[data-ladder=middle]').dataset.symbol===${JSON.stringify(symbol)}`);
    const elapsed=Date.now()-before;
    assert.equal(await evaluate("document.querySelector('[data-ladder=left]').dataset.symbol"),'SPXW');
    assert.equal(await evaluate("document.querySelector('[data-ladder=right]').dataset.symbol"),'QQQ');
    return elapsed;
  };
  try{
    assert.equal(await evaluate('LightweightCharts.version()'),'5.2.1');
    assert.ok(await evaluate("document.querySelector('#plot').clientHeight<1200"),'chart container must not grow through a ResizeObserver/flex feedback loop');
    assert.ok(await evaluate("document.querySelector('#tv-open').href.includes('TVC%3ASPX')"));
    assert.ok(await evaluate("document.querySelector('#chart-message').textContent.includes('SPX K 线源未配置')"));
    for(const mode of ['shortcut','confirm','enter']){
      await evaluate("document.querySelector('#expiry').value='0dte';document.querySelector('#expiry').dispatchEvent(new Event('change'))");
      const commitMs=await choose('NVDA',mode);
      assert.ok(await evaluate("document.querySelector('#chart-title').textContent.startsWith('NVDA')"));
      await until("document.querySelector('[data-ladder=middle]').dataset.phase==='ready'");
      assert.ok(await evaluate("document.querySelector('[data-ladder=middle]').textContent.includes('NVDA 无 0DTE')"));
      await evaluate("[...document.querySelectorAll('[data-ladder=middle] button')].find(b=>b.textContent.includes('Front')).click()");
      await until("document.querySelectorAll('[data-ladder=middle] .strike-row').length>0&&Number(document.querySelector('#plot').dataset.candles)>0");
      report.selection.push({mode,input:mode==='shortcut'?'NVDA':'nvda',normalized:'NVDA',commitMs,
        header:await evaluate("document.querySelector('#chart-title').textContent"),rows:await evaluate("document.querySelectorAll('[data-ladder=middle] .strike-row').length")});
      assert.ok(await evaluate("document.querySelector('[data-ladder=middle] .spot-marker').textContent.includes('178')||document.querySelector('[data-ladder=middle] .spot-marker').textContent.length>5"));
    }
    const payload=await evaluate("fetch(location.origin+'/api/snapshot?symbol=NVDA').then(r=>r.json()).then(f=>({symbol:f.symbol,root:f.optionRoot,priceSymbol:f.priceSymbol,usable:f.usable,contracts:f.contracts,dates:f.dates,bars:f.bars?.length,spot:f.spot}))");
    assert.equal(payload.symbol,'NVDA');assert.ok(payload.usable>0);report.nvda=payload;
    await openMiddle();await value('#symbol-input','<>');await click('#symbol-form button[type=submit]');
    await until("document.querySelector('#symbol-dialog').getAttribute('aria-busy')==='false'");
    assert.ok(await evaluate("document.querySelector('#symbol-error').textContent.includes('格式无效')"));
    assert.equal(await evaluate("document.querySelector('[data-ladder=middle]').dataset.symbol"),'NVDA');
    await key('Escape','Escape',27);await until("!document.querySelector('#symbol-dialog').open");
    await click('[data-ladder=left] .focus-column');
    const spx=await evaluate("fetch(location.origin+'/api/snapshot?symbol=SPXW').then(r=>r.json()).then(f=>({symbol:f.symbol,root:f.optionRoot,priceSymbol:f.priceSymbol,usable:f.usable,bars:f.bars?.length,status:f.spot?.status}))");
    assert.ok(spx.usable>0);assert.equal(spx.bars,0);report.spx=spx;
    assert.ok(await evaluate("document.querySelector('[data-ladder=left] .spot-marker').textContent.startsWith('Spot')"));
    await choose('SPY','confirm');await until("document.querySelector('[data-ladder=middle]').dataset.phase==='ready'");
    report.viewControls={counts:[],lookbacks:[]};
    for(const total of [20,30,40,50,60]){
      await click('#range-button');await click(`#range-listbox [data-value="${total}"]`);
      const counts=await evaluate("[...document.querySelectorAll('.ladder')].map(l=>l.querySelectorAll('.strike-row').length)");
      assert.deepEqual(counts,[total,total,total]);report.viewControls.counts.push({total,actual:counts});
    }
    for(const minutes of [1,5,15,30]){
      await click('#speed-button');await click(`#speed-listbox [data-value="${minutes}"]`);
      const labels=await evaluate("[...document.querySelectorAll('.velocity')].map(n=>n.textContent)");
      assert.ok(await evaluate(`[...document.querySelectorAll('.strike-row')].every(n=>n.title.includes(' · ${minutes}m · '))`));
      report.viewControls.lookbacks.push({minutes,available:labels.filter(v=>v!=='—').length,missing:labels.filter(v=>v==='—').length});
    }
    await evaluate("document.querySelector('#range').value='40';document.querySelector('#range').dispatchEvent(new Event('change'));document.querySelector('#speed').value='5';document.querySelector('#speed').dispatchEvent(new Event('change'))");
    await until("Number(document.querySelector('#plot').dataset.candles)>0");
    await tool('fullscreen');await until("!!document.fullscreenElement||document.querySelector('.chart-panel').classList.contains('fullscreen-fallback')");
    await key('Escape','Escape',27);await until("!document.fullscreenElement&&!document.querySelector('.chart-panel').classList.contains('fullscreen-fallback')");report.tools.push('fullscreen + Esc');
    await tool('fit');report.tools.push('fit autoscale');
    await tool('settings');
    await evaluate("const p=document.querySelector('[data-setting=candleMinutes]');p.value='5';p.dispatchEvent(new Event('change'));const s=document.querySelector('[data-setting=chartSession]');s.value='RTH';s.dispatchEvent(new Event('change'));const n=document.querySelector('[data-setting=nodeMax]');n.value='6';n.dispatchEvent(new Event('change'))");
    await click('[data-action=close-tools]');assert.equal(await evaluate("document.querySelector('#candle-period').value"),'5');report.tools.push('settings period/session/node scale');
    await tool('layers');
    for(const layer of ['nodes','derived','walls','dayRange','cone','drawingsVisible']){
      await click(`[data-layer=${layer}]`);await click(`[data-layer=${layer}]`);
    }
    await click('[data-layer=nodes]');assert.ok(await evaluate("document.querySelector('#layer-meta').textContent.startsWith('0 nodes')"));
    await click('[data-layer=nodes]');await click('[data-action=close-tools]');report.tools.push('all six layer switches');
    await click('#day-range');
    if(!live)assert.ok(await evaluate("document.querySelector('#chart-message').textContent.includes(\"Above today's expected range\")&&document.querySelector('#chart-message').textContent.includes('pts')&&document.querySelector('#chart-message').textContent.includes('σ from center')"));
    else assert.ok(await evaluate("document.querySelector('#chart-message').textContent.includes('Day Range 不可用')"));
    await click('#day-range');
    await tool('live-cone');
    if(await evaluate("!document.querySelector('[data-action=pin]').disabled")){
      await tool('pin');assert.equal(await evaluate("document.querySelector('[data-action=pin]').textContent"),'Unpin cone');report.tools.push('Cone + Pin frozen inputs');
    }else{
      assert.ok((await evaluate("document.querySelector('[data-action=pin]').title")).length>8);report.tools.push('Cone unavailable reason / Pin disabled');
    }
    await tool('collapse');assert.ok(await evaluate("document.querySelector('.chart-tools').classList.contains('collapsed')"));await tool('collapse');report.tools.push('collapse/expand');
    await evaluate("document.querySelector('[data-action=drag]').focus()");await key('ArrowLeft','ArrowLeft',37);
    assert.ok(await evaluate("parseFloat(document.querySelector('.chart-tools').style.right)>74"));report.tools.push('keyboard tool handle');
    const handle=await evaluate("(()=>{const r=document.querySelector('[data-action=drag]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,right:parseFloat(document.querySelector('.chart-tools').style.right)}})()");
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:handle.x,y:handle.y,button:'left',buttons:1,clickCount:1});
    await wait(70);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x-25,y:handle.y-15,buttons:1});
    await wait(70);
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x-25,y:handle.y-15,button:'left',buttons:0,clickCount:1});
    await wait(100);
    assert.ok(await evaluate(`parseFloat(document.querySelector('.chart-tools').style.right)>${handle.right}`));report.tools.push('pointer drag tool handle');
    const rect=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()");
    const chartClick=async(fx,fy)=>{const current=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()");const x=current.x+current.width*fx,y=current.y+Math.min(current.height,600)*fy;
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});};
    await tool('draw');await tool('draw-horizontal');await chartClick(.35,.45);
    await until("Number(document.querySelector('#plot').dataset.drawings)===1");
    await tool('draw');await tool('delete-drawing');await until("Number(document.querySelector('#plot').dataset.drawings)===0");
    // The full-range fit may include historical GEX before the OHLC provider's
    // first bar. Use the data-bearing portion, not blank time-axis whitespace.
    await tool('draw');await tool('draw-trend');await chartClick(.60,.5);await wait(350);await chartClick(.70,.35);
    await until("Number(document.querySelector('#plot').dataset.drawings)===1");report.tools.push('horizontal, delete selected, two-point trend');
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:()=>Promise.reject(new Error('test clipboard denied'))}})");
    await tool('copy');await until("!!document.querySelector('.export-status a[download]')");report.tools.push('copy PNG fallback download');
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:items=>{window.__pngCopied=items[0].types.includes('image/png');return Promise.resolve()}}})");
    await tool('copy');await until('window.__pngCopied===true');report.tools.push('copy API success branch (isolated mock clipboard)');
    await tool('download');await wait(300);report.tools.push('download actual PNG');
    await value('#replay-date','2026-11-09');await value('#replay-time','10:00');await click('#replay-form button[type=submit]');
    await until("document.querySelector('#plot').dataset.cursor!=='live'");
    const origin=Date.parse('2026-11-09T15:00:00Z');
    const cut=await evaluate("({cursor:Number(document.querySelector('#plot').dataset.cursor),last:Number(document.querySelector('#plot').dataset.lastCandleClose),bars:Number(document.querySelector('#plot').dataset.candles),drawings:Number(document.querySelector('#plot').dataset.drawings),header:document.querySelector('#chart-title').textContent,notice:document.querySelector('#chart-message').textContent})");
    assert.equal(cut.cursor,origin);assert.ok(cut.last<=origin);assert.ok(cut.bars>0);assert.equal(cut.drawings,0);report.replay.start=cut;
    await tool('latest');assert.equal(await evaluate("Number(document.querySelector('#plot').dataset.cursor)"),origin);
    await click('#replay-step');assert.equal(await evaluate("Number(document.querySelector('#plot').dataset.cursor)"),origin+300000);
    await click('#replay-play');await wait(1150);await click('#replay-play');
    assert.ok((await evaluate("Number(document.querySelector('#plot').dataset.cursor)"))>=origin+600000);
    await evaluate(`const slider=document.querySelector('#timeline');slider.value=${origin};slider.dispatchEvent(new Event('input'))`);
    assert.equal(await evaluate("Number(document.querySelector('#plot').dataset.cursor)"),origin);
    assert.equal(await evaluate("Number(document.querySelector('#plot').dataset.lastCandleClose)"),cut.last);
    await tool('download');await wait(300);
    await value('#replay-time','10:07');await click('#replay-form button[type=submit]');
    assert.ok((await evaluate("Number(document.querySelector('#plot').dataset.lastCandleClose)"))<=origin+300000);
    report.replay.tenOhSeven=await evaluate("({cursor:document.querySelector('#plot').dataset.cursor,lastCandleClose:document.querySelector('#plot').dataset.lastCandleClose})");
    const replayShot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,live?'real-replay.png':'fixture-replay.png'),Buffer.from(replayShot.data,'base64'));
    await click('#latest');assert.equal(await evaluate("document.querySelector('#plot').dataset.cursor"),'live');report.replay.exit='Live restored';
    const files=(await readdir(downloads)).filter(name=>name.endsWith('.png'));
    assert.ok(files.some(name=>name.includes('_Live.png')));assert.ok(files.some(name=>name.includes('_Replay.png')));
    for(const file of files){const png=await readFile(resolve(downloads,file));assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.readUInt32BE(16)>300);}
    report.exports=files;
    report.requests=[...network.values()].filter(r=>/\/api\/(validate|snapshot|price)/.test(r.url));
    assert.ok(report.requests.filter(r=>r.url.includes('/api/validate?symbol=NVDA')&&r.status===200).length>=3);
    assert.deepEqual(exceptions,[]);report.exceptions=exceptions;report.passed=true;
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,live?'real-v2.png':'fixture-v2.png'),Buffer.from(shot.data,'base64'));
    console.log(JSON.stringify(report));
  }finally{
    report.lastState=await evaluate("({plot:{...document.querySelector('#plot').dataset},rect:(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})(),modal:document.querySelector('#chart-tool-dialog').open})");
    const diagnostic=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,live?'real-last.png':'fixture-last.png'),Buffer.from(diagnostic.data,'base64'));
    await writeFile(resolve(artifacts,live?'real-acceptance.json':'fixture-acceptance.json'),JSON.stringify(report,null,2));
  }
}
