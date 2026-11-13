const node=(tag,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;};
const paths={
  fullscreen:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  fit:'M12 3v18M3 12h18m-12-6 3-3 3 3m-9 3-3 3 3 3m12-6 3 3-3 3m-9 3 3 3 3-3',
  settings:'M6 3v18m-3-9h6m6-9v18m-3-14h6m3-4v18m-3-6h6',
  layers:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  latest:'M3 12h14m-5-5 5 5-5 5m8-13v16',
  copy:'M8 8h13v13H8z M4 16H2V2h14v2',
  download:'M12 2v13m-5-5 5 5 5-5M4 17v5h16v-5',
  collapse:'m6 9 6 6 6-6',draw:'m4 16-1 5 5-1L21 7l-4-4L4 16ZM14 6l4 4',
  drag:'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01'
};

// Keep the native select as the single value/change interface, but never open
// the Windows system popup. Focus stays on the button; arrows use active-descendant.
export class DarkSelect{
  constructor(select,label){
    if(!select?.after)return;
    this.select=select;this.label=label;
    this.root=node('div','','dark-select');this.button=node('button','','dark-select-button');
    this.button.type='button';this.button.id=select.id+'-button';this.button.setAttribute('role','combobox');
    this.button.setAttribute('aria-label',label);this.button.setAttribute('aria-haspopup','listbox');
    this.button.setAttribute('aria-controls',select.id+'-listbox');this.button.setAttribute('aria-expanded','false');
    this.list=node('div','','dark-options');this.list.id=select.id+'-listbox';this.list.hidden=true;
    this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label',label);
    this.options=[...select.options];
    this.items=this.options.map((option,i)=>{
      const item=node('div',option.textContent,'dark-option');item.id=select.id+'-option-'+i;
      item.setAttribute('role','option');item.dataset.value=option.value;
      item.onpointerdown=e=>e.preventDefault();item.onclick=()=>{this.commit(i);this.button.focus();};
      item.onpointermove=()=>this.activate(i);this.list.append(item);return item;
    });
    select.hidden=true;select.after(this.root);this.root.append(this.button,this.list);
    this.button.onclick=()=>this.list.hidden?this.open():this.close();
    this.button.onkeydown=event=>{
      const key=event.key;
      if(['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape'].includes(key))event.preventDefault();
      if(key==='Escape'){this.close();return;}
      if(key==='Tab'){this.close();return;}
      if(key==='Enter'||key===' '){if(this.list.hidden)this.open();else this.commit(this.active);return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(key)){
        if(this.list.hidden){this.open();return;}
        this.activate(key==='Home'?0:key==='End'?this.items.length-1:Math.max(0,Math.min(this.items.length-1,this.active+(key==='ArrowDown'?1:-1))));
      }
    };
    document.addEventListener('pointerdown',event=>{if(!this.root.contains(event.target))this.close();});
    this.root.addEventListener('focusout',event=>{if(!this.root.contains(event.relatedTarget))this.close();});
    select.addEventListener('change',()=>this.sync());this.sync();
  }
  sync(){this.button.textContent=(this.options.find(o=>o.value===this.select.value)?.textContent??this.select.value)+' ⌄';
    this.items.forEach((item,i)=>item.setAttribute('aria-selected',this.options[i].value===this.select.value?'true':'false'));}
  activate(index){this.active=index;this.items.forEach((item,i)=>item.dataset.active=String(i===index));this.button.setAttribute('aria-activedescendant',this.items[index].id);}
  open(){this.list.hidden=false;this.button.setAttribute('aria-expanded','true');this.activate(Math.max(0,this.options.findIndex(o=>o.value===this.select.value)));}
  close(){this.list.hidden=true;this.button.setAttribute('aria-expanded','false');this.button.removeAttribute('aria-activedescendant');}
  commit(index){this.select.value=this.options[index].value;this.select.dispatchEvent(new Event('change',{bubbles:true}));this.sync();this.close();}
}

export class ChartTools{
  constructor({chart,panel,target,getState,setState,onLatest}){
    Object.assign(this,{chart,panel,target,getState,setState,onLatest});
    try{const saved=JSON.parse(localStorage.getItem('gex-chart-prefs')??'{}');for(const key of ['nodes','derived','walls','dayRange','cone','drawingsVisible','chartAutoScale','candleStyle'])if(key in saved)getState()[key]=saved[key];this.collapsed=!!saved.collapsed;}catch{}
    this.root=node('div','','chart-tools');this.root.setAttribute('aria-label','图表工具栏');
    this.status=node('div','','export-status');this.status.setAttribute('role','status');target.append(this.status);
    chart.onDrawingStatus=text=>this.message(text);
    this.actions=node('div','','tool-actions');this.root.append(this.actions);
    const definitions=[
      ['fullscreen','⛶','全屏 / 恢复图表；Shift+F；Esc 退出并恢复视图',()=>this.fullscreen()],
      ['fit','✥','Reset view：默认时间范围与自动价轴，保留绘图',()=>{this.setState('chartAutoScale',true);chart.resetView();this.savePrefs();this.message('已恢复默认视图与自动价轴');}],
      ['settings','▥','图表设置：周期、交易时段与泡泡大小',()=>this.settings()],
      ['layers','◉','图层显隐：Nodes / Derived / Walls / Day Range / Cone / 绘图',()=>this.layers()],
      ['latest','⇥','Live 回到最新行情；Replay 回到回放头并保持回放',()=>{onLatest();chart.latest();}],
      ['copy','▣','复制包含当前图层、价格轴和时间轴的 PNG；失败提供下载',()=>this.copy()],
      ['download','⇩','下载当前 Live / Replay 图表 PNG，不包含未来行情',()=>this.download()]
    ];
    this.buttons={};
    for(const [id,icon,title,action] of definitions)this.buttons[id]=this.button(id,icon,title,action,this.actions);
    this.button('collapse','⌄','折叠 / 展开图表工具列（本机保存）',()=>{this.collapsed=!this.collapsed;this.root.classList.toggle('collapsed',this.collapsed);this.savePrefs();},this.root);
    this.root.classList.toggle('collapsed',this.collapsed);
    this.drawingBox=node('div','','drawing-tools');
    this.button('draw','✎','快速绘图：横线 / 趋势线 / 矩形 / 调整 / 删除；Esc退出',()=>this.drawMenu(),this.drawingBox);
    const drag=this.button('drag','⠿','移动工具栏；拖动或使用方向键',()=>this.message('拖动移动工具栏，也可用方向键'),this.drawingBox);
    drag.setAttribute('aria-label','移动工具栏');this.installDrag(drag);
    this.coneBox=node('div','','corner-cone');
    this.held=this.button('cone-details','Cone held — · 1σ · n=0','Expected Move / Cone held / Pin 详情',()=>this.expectedDetails(),this.coneBox);
    this.coneActions=node('div','','cone-actions');this.coneBox.append(this.coneActions);
    this.coneButton=this.button('live-cone','Live Cone','动态 IV 锥形，与 Day Range 独立',()=>{this.setState('cone',!getState().cone);this.savePrefs();},this.coneActions);
    this.pinButton=this.button('pin','Pin','冻结完整锥体与曲线',()=>document.getElementById('pin').click(),this.coneActions);
    target.append(this.root,this.coneBox,this.drawingBox);
    this.dialog=node('dialog','','chart-tool-dialog');this.dialog.id='chart-tool-dialog';document.body.append(this.dialog);
    document.addEventListener?.('keydown',event=>{
      if(event.key==='Escape'){chart.setDrawingMode(null);if(this.dialog.open)this.dialog.close();if(document.fullscreenElement)void document.exitFullscreen();else if(panel.classList.contains('fullscreen-fallback')){panel.classList.remove('fullscreen-fallback');this.restoreFullscreenView();}}
      if(event.shiftKey&&event.key.toLowerCase()==='f'&&!['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)){event.preventDefault();void this.fullscreen();}
    });
    document.addEventListener?.('fullscreenchange',()=>{if(!document.fullscreenElement)this.restoreFullscreenView();});
    if(globalThis.ResizeObserver){this.resize=new ResizeObserver(()=>this.layout());this.resize.observe(target);}
    chart.onControlsLayout=()=>this.layout();this.layout();
  }
  button(id,text,title,action,parent){
    const b=node('button',text);b.type='button';b.dataset.action=id;b.title=title;b.setAttribute('aria-label',title);
    if(paths[id])b.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[id]}"/></svg>`;
    b.onclick=()=>Promise.resolve(action()).catch(error=>this.message(error.message));parent.append(b);return b;
  }
  message(text,download){
    this.status.replaceChildren(node('span',text));
    if(download){const a=node('a','下载 PNG');a.download=download.filename;a.href=URL.createObjectURL(download.blob);this.status.append(a);}
  }
  async fullscreen(){
    if(document.fullscreenElement){await document.exitFullscreen();return;}
    if(this.panel.classList.contains('fullscreen-fallback')){this.panel.classList.remove('fullscreen-fallback');this.restoreFullscreenView();return;}
    this.fullscreenView=this.chart.captureView();
    try{await this.panel.requestFullscreen();}catch{this.panel.classList.add('fullscreen-fallback');}
  }
  restoreFullscreenView(){if(!this.fullscreenView)return;const view=this.fullscreenView;this.fullscreenView=null;requestAnimationFrame(()=>requestAnimationFrame(()=>{this.chart.restoreView(view);this.layout();}));}
  savePrefs(){const state=this.getState(),saved={collapsed:!!this.collapsed};for(const key of ['nodes','derived','walls','dayRange','cone','drawingsVisible','chartAutoScale','candleStyle'])saved[key]=state[key];try{localStorage.setItem('gex-chart-prefs',JSON.stringify(saved));}catch{}}
  layout(){
    if(!this.chart.chart)return;
    const pane=this.chart.chart.paneSize(),axis=this.target.clientWidth-pane.width,time=this.target.clientHeight-pane.height;
    this.root.classList.toggle('compact',pane.height<600||pane.width<540);
    // Reserve a stable strip for price-line titles. The vertical tools remain
    // inside the pane but cannot cover Wall, King or Spot labels at the axis.
    this.root.style.right=Math.max(axis+10,Math.min(this.target.clientWidth-this.coneBox.offsetWidth-48,axis+130+(this.dragOffset?.x??0)))+'px';
    this.root.style.bottom=Math.max(time+42,Math.min(this.target.clientHeight-this.root.clientHeight-10,time+42+(this.dragOffset?.y??0)))+'px';
    const dx=parseFloat(this.root.style.right)-(axis+130),dy=parseFloat(this.root.style.bottom)-(time+42);
    this.coneBox.style.right=axis+168+dx+'px';this.coneBox.style.bottom=time+42+dy+'px';
    this.drawingBox.style.right=axis+168+dx+'px';this.drawingBox.style.bottom=time+5+dy+'px';
    const rect=this.target.getBoundingClientRect();
    const zones=[this.root,this.coneBox,this.drawingBox].map(e=>{const r=e.getBoundingClientRect();return {x:r.x-rect.x,y:r.y-rect.y,width:r.width,height:r.height};});
    this.chart.setControlZones(zones);this.target.dataset.controlZones=JSON.stringify(zones);
  }
  open(title){
    this.dialog.replaceChildren();const head=node('div','','dialog-head');head.append(node('h2',title));
    this.button('close-tools','×','关闭工具菜单',()=>this.dialog.close(),head);this.dialog.append(head);this.dialog.showModal();
  }
  layers(){
    this.open('图层显隐');const s=this.getState();
    for(const [key,label] of [['nodes','GEX Nodes · 原始标的 OI 模型'],['derived','Derived · 配对价格投影'],['walls','Call / Put Walls · sampled strikes'],['dayRange','Day Expected Range · 前收 IV'],['cone','Live Expected IV Cone'],['drawingsVisible','绘图']]){
      const row=node('label','','tool-setting'),input=node('input');input.type='checkbox';input.checked=!!s[key];input.dataset.layer=key;
      input.onchange=()=>{this.setState(key,input.checked);this.savePrefs();};row.append(input,node('span',label));this.dialog.append(row);
    }
  }
  settings(){
    this.open('图表设置');const s=this.getState();
    for(const [key,label,values] of [
      ['candleMinutes','K 线周期',(s.supportedPeriods??[1,2,5,15]).map(v=>[v,v+'m'])],
      ['chartSession','交易时段',[['ALL','ETH 全部可用时段（含RTH）'],['RTH','RTH 常规盘'],['EXT','仅 PRE / POST']]],
      ['candleStyle','蜡烛样式',[['classic','Classic 暗实体亮边'],['hollow','Hollow 空心'],['mono','Mono 单色']]],
      ['expectedProvider','Expected Move provider',[['OpenD','OpenD · 本地 Estimated IV Cone'],['Tempest','Tempest · 已授权数据（可选）']]],
      ['expectedHorizon','结算期限',[['today','Today to close'],['front','Front available expiry']]],
      ['nodeMin','节点最小宽度（px）',[[1,'1'],[2,'2'],[3,'3']]],
      ['nodeMax','节点最大宽度（仍受间距限制）',[[4,'4'],[6,'6'],[8,'8']]],
      ['nodeAlphaMin','最弱节点基础不透明度',[[.10,'10%'],[.20,'20%'],[.30,'30%'],[.40,'40%']]],
      ['nodeAlphaMax','强节点基础不透明度',[[.65,'65%'],[.75,'75%'],[.85,'85%'],[.95,'95%']]]]){
      const row=node('label',label,'tool-setting'),select=node('select');select.dataset.setting=key;
      for(const [value,text] of values){const o=node('option',text);o.value=String(value);if(key==='expectedProvider'&&value==='Tempest'&&!s.tempest?.[s.symbol]?.configured)o.disabled=true;select.append(o);}select.value=String(s[key]);
      select.onchange=()=>{this.setState(key,['chartSession','candleStyle','expectedProvider','expectedHorizon'].includes(key)?select.value:Number(select.value));this.savePrefs();};row.append(select);this.dialog.append(row);
    }
    const auto=node('label','价格轴 Auto Scale','tool-setting'),box=node('input');box.type='checkbox';box.checked=s.chartAutoScale!==false;box.dataset.setting='chartAutoScale';box.onchange=()=>{this.setState('chartAutoScale',box.checked);this.savePrefs();};auto.append(box);this.dialog.append(auto);
    this.dialog.append(node('p','GEX 节点在基础不透明度上额外增加 30 个百分点，最高 99%。','quiet'));
    this.dialog.append(node('p','图内上下拖动平移价格；在右侧价格轴滚轮缩放。Reset view 恢复自动缩放。','quiet'));
    if(!s.tempest?.[s.symbol]?.configured)this.dialog.append(node('p','Tempest 未配置：没有已授权数据；未调用或购买付费行情。','quiet'));
    this.button('open-layers','图层设置','切换至图层菜单',()=>this.layers(),this.dialog);
  }
  drawMenu(){
    this.open('绘图工具');this.dialog.append(node('p','横线点击一次；趋势线 / 矩形点击两个端点。点击选中，拖动端点调整；Esc退出。'));
    for(const [mode,text] of [['horizontal','横线'],['trend','趋势线'],['rectangle','矩形']])this.button('draw-'+mode,text,text,()=>{
      this.chart.setDrawingMode(mode);this.dialog.close();this.message(mode==='horizontal'?'请点击图表价位放置横线':`请依次点击${mode==='rectangle'?'矩形':'趋势线'}的两个端点`);
    },this.dialog);
    this.button('delete-drawing','删除选中绘图','删除选中绘图（也可按 Delete）',()=>{this.chart.deleteDrawing();this.dialog.close();this.message('已删除选中绘图');},this.dialog);
    const selected=this.chart.drawings.find(d=>d.selected);
    if(selected){
      for(const [key,label] of selected.type==='horizontal'?[['price','价格']]:[['start.price','起点价格'],['end.price','终点价格']]){
        const row=node('label',label,'tool-setting'),input=node('input');input.type='number';input.step='any';input.dataset.drawingField=key;input.value=key==='price'?selected.price:selected[key.split('.')[0]].price;
        input.onchange=()=>this.chart.editDrawing(key,Number(input.value));row.append(input);this.dialog.append(row);
      }
    }
  }
  expectedDetails(){
    this.open('Expected Move · Cone held · Pin');const s=this.getState(),c=s.coneVisible??s.coneCandidate;
    this.dialog.append(node('p',c?.available?`${c.provider} · ${c.quality} · ${c.horizon} · ${c.expiry} · ${c.timeBasis??c.interpolation}`:s.coneReason??'Expected Move unavailable'));
    if(c?.available)this.dialog.append(node('pre',JSON.stringify(c,null,2),'expected-proof'));
    const held=s.heldStats;this.dialog.append(node('h3','日级 Cone held'));
    this.dialog.append(node('p',held?.count?`${held.hits}/${held.count} = ${held.percent.toFixed(1)}% · ${held.rule}`:'历史不足：没有可配对的前收固定区间与次日真实常规收盘；n=0'));
    if(held?.count)this.dialog.append(node('pre',JSON.stringify(held.samples,null,2),'expected-proof'));
    if(s.pinStats){this.dialog.append(node('h3','Pin K线评分（与日级统计分开）'),node('pre',JSON.stringify(s.pinStats,null,2),'expected-proof'));}
  }
  installDrag(handle){
    let origin;
    handle.onpointerdown=event=>{event.preventDefault();origin={x:event.clientX,y:event.clientY,right:parseFloat(this.root.style.right)||74,bottom:parseFloat(this.root.style.bottom)||72};};
    // Listen on the owning window, so moving off the small handle or across the
    // chart canvas cannot lose the drag. No canvas pointer-capture competition.
    globalThis.addEventListener?.('pointermove',event=>{if(origin){event.preventDefault();this.move(origin.right-(event.clientX-origin.x),origin.bottom-(event.clientY-origin.y));}},true);
    globalThis.addEventListener?.('pointerup',event=>{if(origin)this.move(origin.right-(event.clientX-origin.x),origin.bottom-(event.clientY-origin.y));origin=null;},true);
    globalThis.addEventListener?.('pointercancel',()=>{origin=null;},true);
    globalThis.addEventListener?.('blur',()=>{origin=null;});
    handle.onkeydown=event=>{const offsets={ArrowLeft:[10,0],ArrowRight:[-10,0],ArrowUp:[0,10],ArrowDown:[0,-10]};
      if(offsets[event.key]){event.preventDefault();const [x,y]=offsets[event.key];this.move((parseFloat(this.root.style.right)||74)+x,(parseFloat(this.root.style.bottom)||72)+y);}};
  }
  move(right,bottom){const pane=this.chart.chart.paneSize(),axis=this.target.clientWidth-pane.width,time=this.target.clientHeight-pane.height;this.dragOffset={x:Math.max(0,right-axis-130),y:Math.max(0,bottom-time-42)};this.layout();}
  async download(){const image=await this.chart.exportPng(),a=node('a');a.href=URL.createObjectURL(image.blob);a.download=image.filename;a.click();this.message('已下载 '+image.filename);}
  async copy(){
    const image=await this.chart.exportPng();
    try{if(!navigator.clipboard?.write)throw new Error('Clipboard API unavailable');await navigator.clipboard.write([new ClipboardItem({'image/png':image.blob})]);this.message('图表 PNG 已复制');}
    catch{this.message('剪贴板不可用；可下载当前图片。',image);}
  }
  sync(){
    const s=this.getState();this.coneButton.setAttribute('aria-pressed',String(s.cone));
    this.coneButton.title=s.coneReason??'Live Cone：当前有效价、ATM IV 和目标收盘时间';
    const pin=document.getElementById('pin');this.pinButton.disabled=pin.disabled;this.pinButton.textContent=pin.textContent;
    this.pinButton.title=pin.disabled?(s.coneReason??'需要先开启有效 IV Cone'):'冻结或释放当时的价格、IV、时间及终点';
    const h=s.heldStats;this.held.textContent=`Cone held ${h?.count?h.percent.toFixed(1)+'%':'—'} · 1σ · n=${h?.count??0}`;
    this.held.title=h?.count?`${h.hits}/${h.count} · ${h.rule} · ${h.samples.map(x=>x.date).join(', ')}`:'历史不足：无有效前收区间 / 次日常规收盘配对，点击查看规则';
    this.root.classList?.toggle('drawing-active',!!this.chart.drawingMode);this.drawingBox.classList?.toggle('drawing-active',!!this.chart.drawingMode);this.layout();
  }
}

