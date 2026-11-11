import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
export async function runCorner({send,evaluate,until,wait,artifacts,before,live}){
  await until("document.querySelectorAll('.strike-row').length>0");
  const checks=[];
  if(!before&&live){
    await evaluate("document.querySelector('[data-ladder=middle] .focus-column').click();document.querySelector('[data-action=live-cone]').click()");
    await wait(300);
    const status=await evaluate("({message:document.querySelector('#chart-message').textContent,pinDisabled:document.querySelector('[data-action=pin]').disabled,held:document.querySelector('[data-action=cone-details]').textContent,cone:document.querySelector('#plot').dataset.cone})");
    assert.ok(status.message.length>0);assert.ok(status.held.includes('n='));
    if(!status.cone)assert.equal(status.pinDisabled,true);
    await evaluate("document.querySelector('[data-action=settings]').click()");
    const configured=await evaluate("!document.querySelector('[data-setting=expectedProvider] option[value=Tempest]').disabled");
    await evaluate("document.querySelector('[data-action=close-tools]').click()");
    checks.push({realOpenD:status,tempestConfigured:configured});
  }
  if(!before&&!live){
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await click('[data-ladder=middle] .focus-column');
    await until("Number(document.querySelector('#plot').dataset.candles)>0");
    await click('[data-action=live-cone]');await until("!!document.querySelector('#plot').dataset.cone");
    await click('[data-action=pin]');
    const frozen=await evaluate("document.querySelector('#plot').dataset.cone");
    await click('#refresh');await until("document.querySelector('#feed-state').textContent!=='Refreshing'");
    assert.equal(await evaluate("document.querySelector('#plot').dataset.cone"),frozen);checks.push('Pin retains exact curves through refresh');
    assert.equal(await evaluate("document.querySelectorAll('#pin').length"),1);
    await click('[data-action=cone-details]');assert.ok(await evaluate("document.querySelector('.expected-proof').textContent.includes('ivTimestampKind')"));await click('[data-action=close-tools]');
    await click('[data-action=settings]');
    assert.equal(await evaluate("document.querySelector('[data-setting=expectedProvider] option[value=Tempest]').disabled"),true);
    await evaluate("const s=document.querySelector('[data-setting=candleStyle]');s.value='hollow';s.dispatchEvent(new Event('change'));document.querySelector('[data-setting=chartAutoScale]').click()");
    assert.equal(await evaluate("__designChart.series.options().upColor"),'transparent');assert.equal(await evaluate("__designChart.chart.priceScale('right').options().autoScale"),false);
    await click('[data-action=close-tools]');checks.push('style and Auto Scale applied; unconfigured Tempest disabled');
    const view=await evaluate("__designChart.chart.timeScale().setVisibleLogicalRange({from:100,to:145});__designChart.chart.priceScale('right').setVisibleRange({from:745,to:765});__designChart.captureView()");
    await click('[data-action=fullscreen]');await until("!!document.fullscreenElement||document.querySelector('.chart-panel').classList.contains('fullscreen-fallback')");
    await click('[data-action=fullscreen]');await until("!document.fullscreenElement&&!document.querySelector('.chart-panel').classList.contains('fullscreen-fallback')");await wait(150);
    const restored=await evaluate('__designChart.captureView()');assert.deepEqual(restored.time,view.time);assert.deepEqual(restored.price,view.price);checks.push('fullscreen restores manual time and price ranges');
    await click('[data-action=fit]');assert.equal(await evaluate("__designChart.chart.priceScale('right').options().autoScale"),true);
    await click('[data-action=draw]');await click('[data-action=draw-rectangle]');
    const point=async(fx,fy)=>evaluate(`(()=>{const c=__designChart,p=c.chart.paneSize(),r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x+p.width*${fx},y:r.y+p.height*${fy}}})()`);
    const mouse=async(type,p,buttons=0)=>send('Input.dispatchMouseEvent',{type,...p,...(type!=='mouseMoved'?{button:'left',clickCount:1}:{}),buttons});
    for(const p of [await point(.4,.3),await point(.65,.55)]){await mouse('mouseMoved',p);await mouse('mousePressed',p,1);await mouse('mouseReleased',p);await wait(250);}
    await until("__designChart.drawings.length===1");assert.equal(await evaluate('__designChart.drawings[0].type'),'rectangle');
    const endpoint=await evaluate("(()=>{const c=__designChart,d=c.drawings[0],r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x+c.chart.timeScale().timeToCoordinate(d.end.time),y:r.y+c.anchor.priceToCoordinate(d.end.price),price:d.end.price}})()");
    const pos={x:endpoint.x,y:endpoint.y};await mouse('mouseMoved',pos);await mouse('mousePressed',pos,1);await mouse('mouseMoved',{x:pos.x+20,y:pos.y-20},1);await mouse('mouseReleased',{x:pos.x+20,y:pos.y-20});
    assert.notEqual(await evaluate('__designChart.drawings[0].end.price'),endpoint.price);checks.push('rectangle creation and pointer endpoint editing');
    await click('[data-action=draw]');await evaluate("const input=document.querySelector('[data-drawing-field=\"start.price\"]');input.value='750';input.dispatchEvent(new Event('change'))");await click('[data-action=close-tools]');assert.equal(await evaluate('__designChart.drawings[0].start.price'),750);
    const zones=await evaluate("JSON.parse(document.querySelector('#plot').dataset.controlZones)");
    const overlap=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
    for(let i=0;i<zones.length;i++)for(let j=i+1;j<zones.length;j++)assert.equal(overlap(zones[i],zones[j]),false);
    await evaluate("document.querySelector('[data-action=drag]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
    const moved=await evaluate("JSON.parse(document.querySelector('#plot').dataset.controlZones)");
    for(let i=0;i<3;i++)assert.ok(Math.abs((zones[i].x-moved[i].x)-10)<1);checks.push('all corner controls move together without overlap');
    // Changing provider keeps a different provider's pinned cone out of this view.
    await evaluate("__testState.tempest.SPY={configured:true,payload:{symbol:'SPY',session:'2026-11-09',horizons:[{name:'today',priced_at:'2026-11-09T18:00:55Z',until:'2026-11-09T21:00:00Z',hi1:760,lo1:748}]}};__testState.prices.SPY.spot.at='2026-11-09T18:00:55Z'");
    await click('[data-action=settings]');await evaluate("{const s=document.querySelector('[data-setting=expectedProvider]');s.value='Tempest';s.dispatchEvent(new Event('change'))}");await click('[data-action=close-tools]');
    const tempest=await evaluate("JSON.parse(document.querySelector('#plot').dataset.cone)");assert.equal(tempest.provider,'Tempest');assert.equal(tempest.curves.length,2);checks.push('authorized test payload renders asymmetric provider boundaries');
    await evaluate("document.querySelector('#replay-date').value='2026-11-09';document.querySelector('#replay-time').value='12:00';document.querySelector('#replay-form').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#plot').dataset.cone"),'');checks.push('Replay refuses later Tempest payload and Live pin');
    await click('#latest');
    await click('[data-action=settings]');await evaluate("{const s=document.querySelector('[data-setting=expectedProvider]');s.value='OpenD';s.dispatchEvent(new Event('change'))}");await click('[data-action=close-tools]');
    for(const width of [850,430]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await wait(150);
      const layout=await evaluate("({pane:__designChart.chart.paneSize(),zones:JSON.parse(document.querySelector('#plot').dataset.controlZones),page:document.documentElement.scrollWidth,viewport:innerWidth})");
      assert.ok(layout.page<=layout.viewport+1);
      for(const zone of layout.zones)assert.ok(zone.x>=0&&zone.y>=0&&zone.x+zone.width<=layout.pane.width+1&&zone.y+zone.height<=layout.pane.height+1);
      for(let i=0;i<layout.zones.length;i++)for(let j=i+1;j<layout.zones.length;j++)assert.equal(overlap(layout.zones[i],layout.zones[j]),false);
    }
    checks.push('850px and 430px controls stay inside pane without overlap or page overflow');
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1400,deviceScaleFactor:1,mobile:false});
  await evaluate("document.querySelector('#expiry').value='front';document.querySelector('#expiry').dispatchEvent(new Event('change'));document.querySelector('[data-ladder=middle] .focus-column').click();document.querySelector('.chart-panel').classList.add('fullscreen-fallback');document.querySelector('#plot').style.cssText+=';height:900px;min-height:900px;flex:none' ");
  await wait(400);
  const bounds=await evaluate("(()=>{const r=document.querySelector('#plot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
  const shot=await send('Page.captureScreenshot',{format:'png',clip:bounds,captureBeyondViewport:true});
  await writeFile(resolve(artifacts,`corner-${before?'before':'after'}-${live?'real':'fixture'}.png`),Buffer.from(shot.data,'base64'));
  await writeFile(resolve(artifacts,`corner-${live?'real':'fixture'}-result.json`),JSON.stringify({passed:true,before,live,bounds,checks},null,2));
  console.log(JSON.stringify({before,live,bounds,checks}));
}
