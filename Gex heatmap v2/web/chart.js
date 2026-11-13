import {aggregateBars,finite} from './model.js';
import {closedCandles} from './replay.js';

const et=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export const NODE_STYLE={
  ellipse:{minWidth:2.4,maxWidth:8,minHeight:2.3,maxHeight:7},
  diamond:{minWidth:2,maxWidth:6.5,minHeight:3,maxHeight:22},
  alphaMin:.30,alphaRange:.55,alphaPower:.75,kingAlpha:.92,maxSpacingRatio:.72,
  positive:'#E9BA48',negative:'#8738D1'
};

// The chart owns scale conversion and clipping. Node geometry is in CSS pixels;
// source exposures remain separate even when a collision has one visual marker.
export function nodeGeometry(nodes,x,y,spacing,scale){
  const positions=nodes.map(node=>({...node,x:x(node.time),y:y(node.price)})).filter(n=>n.x!==null&&n.y!==null);
  const result=[],grid=new Map(),audit=[];
  for(const n of positions.sort((a,b)=>b.weight-a.weight)){
    const s=Math.max(0,Math.min(1,n.weight)),shape=n.shape??(n.derived?'diamond':'ellipse');
    const style=NODE_STYLE[shape]??NODE_STYLE.ellipse,power=Math.pow(s,.75);
    const idealWidth=Math.min(style.maxWidth,scale.max,Math.max(style.minWidth,scale.min)+(style.maxWidth-Math.max(style.minWidth,scale.min))*power);
    const w=Math.max(.5,Math.min(idealWidth,spacing*NODE_STYLE.maxSpacingRatio));
    const idealHeight=style.minHeight+(style.maxHeight-style.minHeight)*power;
    const h=shape==='diamond'?idealHeight:Math.min(idealHeight,Math.max(2,w*.95));
    const alphaMin=finite(scale.alphaMin)?scale.alphaMin:NODE_STYLE.alphaMin;
    const alphaMax=finite(scale.alphaMax)?scale.alphaMax:NODE_STYLE.alphaMin+NODE_STYLE.alphaRange;
    const spacingFactor=Math.min(1,Math.max(.35,spacing/4));
    const baseAlpha=s>=.999?Math.min(.95,alphaMax+.07):alphaMin+(alphaMax-alphaMin)*power;
    // Preserve the +20 percentage-point lift even when distant zoom dims nodes.
    const alpha=Math.min(.95,baseAlpha*spacingFactor+.20*(1-spacingFactor));
    const color=n.value>=0?NODE_STYLE.positive:NODE_STYLE.negative;
    const gx=Math.floor(n.x/8),gy=Math.floor(n.y/8);let hit;
    for(let dx=-1;dx<=1&&!hit;dx++)for(let dy=-1;dy<=1&&!hit;dy++)
      hit=grid.get(`${gx+dx}|${gy+dy}`)?.find(a=>Math.abs(a.x-n.x)<(a.w+w)/2+1&&Math.abs(a.y-n.y)<Math.min(4,(a.h+h)/2));
    const entry={time:n.time,rawStrike:n.strike,mappedPrice:n.price,source:n.source,root:n.root,expiryDates:n.dates,
      snapshotAt:n.at,gex:n.value,king:n.king,strength:s,shape,width:w,height:h,alpha,color,
      mapping:n.mapping??(n.derived?'paired spot ratio':'native strike'),drawn:!hit};
    audit.push(entry);
    if(hit){hit.others.push(n);continue;}
    const mark={...n,shape,color,w,h,r:Math.max(w,h)/2,alpha,others:[]};
    result.push(mark);const key=`${gx}|${gy}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(mark);
  }
  Object.defineProperty(result,'audit',{value:audit});
  return result;
}

// A v5 series primitive: nodes use bottom, annotations/drawings use top.
class ExposureLayer {
  constructor(){this.nodes=[];this.curves=[];this.hits=[];this.annotations=[];this.drawings=[];this.scale={min:2,max:8,alphaMin:.30,alphaMax:.85};this.focusRange=null;}
  attached({chart,series,requestUpdate}){Object.assign(this,{chart,series,requestUpdate});}
  detached(){this.chart=null;this.series=null;}
  paneViews(){return ['bottom','top'].map(pass=>({zOrder:()=>pass,renderer:()=>({draw:target=>target.useMediaCoordinateSpace(({context:ctx})=>this.draw(ctx,pass))})}));}
  update(nodes,curves,annotations=[],drawings=[]){this.nodes=nodes;this.curves=curves;this.annotations=annotations;this.drawings=drawings;this.requestUpdate?.();}
  autoscaleInfo(){
    const range=this.focusRange;
    return range?{priceRange:{minValue:range.low,maxValue:range.high}}:null;
  }
  draw(ctx,pass){
    if(!this.chart)return;
    const x=t=>this.chart.timeScale().timeToCoordinate(t),y=p=>this.series.priceToCoordinate(p);
    ctx.save();
    // Leave the floating control regions clear, in both live rendering and PNG.
    const paneBounds=this.chart.paneSize();ctx.beginPath();ctx.rect(0,0,paneBounds.width,paneBounds.height);
    for(const r of this.controlZones??[])ctx.rect(r.x-4,r.y-4,r.width+8,r.height+8);
    ctx.clip('evenodd');
    if(pass==='bottom'){
      const pane=this.chart.paneSize(),spacing=this.chart.timeScale().options().barSpacing;
      const visible=this.nodes.filter(n=>{const cx=x(n.time),cy=y(n.price);return cx!==null&&cy!==null&&cx>=-8&&cx<=pane.width+8&&cy>=-22&&cy<=pane.height+22;});
      this.hits=nodeGeometry(visible,x,y,spacing,this.scale);
      this.target.__gexNodeAudit=this.hits.audit;
      this.target.dataset.nodeAuditCount=String(this.hits.audit.length);
      for(const node of this.hits){
        const cx=node.x,cy=node.y,rx=node.w/2,ry=node.h/2;
        ctx.fillStyle=node.color;ctx.globalAlpha=node.alpha;ctx.beginPath();
        if(node.shape==='diamond'){ctx.moveTo(cx,cy-ry);ctx.lineTo(cx+rx,cy);ctx.lineTo(cx,cy+ry);ctx.lineTo(cx-rx,cy);}
        else ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);
        ctx.closePath();ctx.fill();
      }
      this.onStats?.({visible:visible.length,drawn:this.hits.length,merged:visible.length-this.hits.length,maxWidth:Math.max(0,...this.hits.map(n=>n.w)),spacing,zOrder:'bottom'});
      ctx.restore();return;
    }
    ctx.globalAlpha=1;ctx.strokeStyle='#72d6ae';ctx.setLineDash([4,4]);
    for(const curve of this.curves){
      ctx.beginPath();let started=false;
      for(const point of curve){const cx=x(point.time),cy=y(point.price);if(cx===null||cy===null)continue;
        if(!started){ctx.moveTo(cx,cy);started=true;}else ctx.lineTo(cx,cy);}
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for(const drawing of this.drawings){
      const a=drawing.type==='horizontal'?{x:0,y:y(drawing.price)}:{x:x(drawing.start.time),y:y(drawing.start.price)};
      const b=drawing.type==='horizontal'?{x:ctx.canvas.width/(globalThis.devicePixelRatio??1),y:a.y}:{x:x(drawing.end.time),y:y(drawing.end.price)};
      if(a.x===null||a.y===null||b.x===null||b.y===null)continue;
      ctx.strokeStyle=drawing.selected?'#ffffff':'#6da8ed';ctx.lineWidth=drawing.selected?2:1;
      ctx.beginPath();
      if(drawing.type==='rectangle'){ctx.rect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.fillStyle='#6da8ed16';ctx.fill();}
      else{ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.stroke();
      if(drawing.selected)for(const p of [a,b]){ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();}
    }
    ctx.font='11px Consolas, monospace';
    for(const label of this.annotations){const cy=y(label.price);if(cy===null)continue;
      const text=label.text,width=ctx.measureText(text).width+16,cx=12;
      ctx.fillStyle='#24232fee';ctx.fillRect(cx,cy-24,width,20);ctx.fillStyle=label.color??'#c9d4ea';ctx.fillText(text,cx+8,cy-10);
    }
    ctx.restore();
  }
}

export class PriceChart {
  constructor(target){
    this.target=target;this.lines=[];this.key=null;this.drawings=[];this.drawingMode=null;this.drawingsVisible=true;
    try{this.savedDrawings=JSON.parse(localStorage.getItem('gex-drawings')??'[]');}catch{this.savedDrawings=[];}
    const L=globalThis.LightweightCharts;
    if(!L){target.textContent='图表依赖尚未安装。热图仍可使用；Lightweight Charts 本地依赖缺失。';return;}
    const mount=document.createElement('div');mount.className='chart-canvas';target.append(mount);
    this.chart=L.createChart(mount,{autoSize:true,layout:{background:{type:'solid',color:'#0B0B0D'},textColor:'#aaa6b5',attributionLogo:true},
      grid:{vertLines:{color:'#1B1B20'},horzLines:{color:'#1B1B20'}},rightPriceScale:{borderColor:'#292932',scaleMargins:{top:.08,bottom:.08}},
      timeScale:{timeVisible:true,secondsVisible:false,borderColor:'#33313c',tickMarkFormatter:t=>et.format(new Date(Number(t)*1000))},
      localization:{timeFormatter:t=>et.format(new Date(Number(t)*1000))+' ET'},
      crosshair:{mode:L.CrosshairMode.Normal},handleScroll:true,handleScale:true});
    this.series=this.chart.addSeries(L.CandlestickSeries,{upColor:'#28584e',downColor:'#63383f',borderVisible:true,
      borderUpColor:'#65CCB4',borderDownColor:'#E57D85',wickUpColor:'#65CCB4',wickDownColor:'#E57D85',priceLineStyle:L.LineStyle.Dashed});
    this.anchor=this.chart.addSeries(L.LineSeries,{color:'transparent',lineVisible:false,lastValueVisible:false,priceLineVisible:false,
      crosshairMarkerVisible:false});
    this.layer=new ExposureLayer();this.layer.target=target;this.anchor.attachPrimitive(this.layer);
    this.target.dataset.nodeLayer='bottom';
    this.layer.onStats=stats=>{
      this.target.dataset.nodeRendering=JSON.stringify(stats);
      const meta=document.getElementById('layer-meta');
      if(meta)meta.textContent=meta.textContent.replace(/(\d+ nodes)(?: · \d+ drawn \/ \d+ merged)?/,`$1 · ${stats.drawn} drawn / ${stats.merged} merged`);
    };
    this.tooltip=document.createElement('div');this.tooltip.className='chart-tooltip';this.tooltip.hidden=true;target.append(this.tooltip);
    target.tabIndex=0;
    // Drawing endpoints use pointer-up directly: the chart library coalesces quick
    // clicks as a double-click, which must not swallow a trend-line endpoint.
    target.addEventListener('pointerup',event=>{
      if(!this.drawingMode||event.target.closest?.('.chart-tools,.corner-cone,.drawing-tools,.export-status'))return;
      const rect=target.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top};
      const pane=this.chart.paneSize();if(point.x<0||point.y<0||point.x>pane.width||point.y>pane.height)return;
      this.suppressChartClick=performance.now()+200;
      this.drawingClick({point,time:this.chart.timeScale().coordinateToTime(point.x)});
    });
    this.chart.subscribeClick(param=>{if(this.drawingMode||performance.now()<(this.suppressChartClick??0))return;this.drawingClick(param);});
    target.addEventListener('keydown',event=>{if(event.key==='Delete'&&!['INPUT','SELECT'].includes(event.target.tagName)){this.deleteDrawing();event.preventDefault();}});
    this.chart.subscribeCrosshairMove(param=>{
      const hit=param.point&&this.layer.hits.find(n=>Math.hypot(n.x-param.point.x,n.y-param.point.y)<n.r+5);
      const levels=param.point?(this.levels??[]).filter(l=>Math.abs(this.anchor.priceToCoordinate(l.price)-param.point.y)<5):[];
      this.tooltip.hidden=!hit&&!levels.length;
      if(hit||levels.length)this.tooltip.textContent=hit?[hit,...hit.others].map(n=>n.title).join(' | 同位置来源：'):levels.map(l=>l.title??l.label).join(' | ');
    });
    target.addEventListener('pointerdown',event=>this.beginEdit(event),true);
    globalThis.addEventListener('pointermove',event=>this.dragEdit(event),true);
    globalThis.addEventListener('pointerup',()=>this.endEdit(),true);
    globalThis.addEventListener('pointercancel',()=>this.endEdit(),true);
    this.chart.timeScale().subscribeSizeChange(()=>this.onControlsLayout?.());
    // Initial fit and series updates also emit visible-range changes. Fetch older
    // candles only after a real pan/scroll gesture, not during page hydration.
    target.addEventListener('wheel',()=>{this.historyInteractionAt=performance.now();},{passive:true});
    target.addEventListener('pointerdown',()=>{this.historyInteractionAt=performance.now();},{passive:true});
    this.chart.timeScale().subscribeVisibleTimeRangeChange(range=>{
      if(!range||!this.onNeedHistory||performance.now()-(this.historyInteractionAt??-Infinity)>2000)return;
      clearTimeout(this.historyTimer);
      this.historyTimer=setTimeout(()=>this.onNeedHistory(Number(range.from)*1000,Number(range.to)*1000),120);
    });
    this.installPriceGestures(target);
  }
  installPriceGestures(target){
    const scale=this.chart.priceScale('right');
    const excluded=event=>event.target.closest?.('.chart-tools,.corner-cone,.drawing-tools,.export-status');
    target.addEventListener('wheel',event=>{
      if(excluded(event)||this.drawingMode||this.editing)return;
      const rect=target.getBoundingClientRect(),pane=this.chart.paneSize();
      const x=event.clientX-rect.left,y=event.clientY-rect.top;
      if(x<pane.width||x>pane.width+scale.width()||y<0||y>pane.height)return;
      const range=scale.getVisibleRange(),at=this.anchor.coordinateToPrice(y);
      if(!range||!finite(at)||range.to<=range.from)return;
      event.preventDefault();event.stopImmediatePropagation();
      const factor=Math.exp(Math.max(-600,Math.min(600,event.deltaY))*.0012);
      const span=Math.max(.0001,(range.to-range.from)*factor),fraction=(at-range.from)/(range.to-range.from);
      scale.setAutoScale(false);scale.setVisibleRange({from:at-fraction*span,to:at+(1-fraction)*span});
      this.onManualScale?.();
    },{capture:true,passive:false});
    let pan=null;
    target.addEventListener('mousedown',event=>{
      if(event.button!==0||excluded(event)||this.drawingMode||this.editing)return;
      const rect=target.getBoundingClientRect(),pane=this.chart.paneSize();
      const x=event.clientX-rect.left,y=event.clientY-rect.top,range=scale.getVisibleRange();
      if(x<0||x>=pane.width||y<0||y>=pane.height||!range)return;
      pan={x:event.clientX,y:event.clientY,range,height:pane.height,active:false};
    },true);
    const move=event=>{
      if(!pan||this.drawingMode||this.editing)return;
      if('buttons' in event&&!(event.buttons&1)){pan=null;return;}
      const dx=event.clientX-pan.x,dy=event.clientY-pan.y;
      if(!pan.active){if(Math.abs(dy)<7||Math.abs(dy)<=Math.abs(dx)*1.2)return;pan.active=true;scale.setAutoScale(false);this.onManualScale?.();}
      event.preventDefault();event.stopImmediatePropagation();this.tooltip.hidden=true;
      const shift=dy*(pan.range.to-pan.range.from)/pan.height;
      scale.setVisibleRange({from:pan.range.from+shift,to:pan.range.to+shift});
    };
    globalThis.addEventListener('pointermove',move,true);
    globalThis.addEventListener('mousemove',move,true);
    globalThis.addEventListener('mouseup',()=>{pan=null;},true);
    globalThis.addEventListener('pointerup',()=>{pan=null;},true);
    globalThis.addEventListener('blur',()=>{pan=null;});
    target.addEventListener('mouseup',()=>{if(!scale.options().autoScale)this.onManualScale?.();});
    target.addEventListener('dblclick',event=>{
      const rect=target.getBoundingClientRect(),pane=this.chart.paneSize(),x=event.clientX-rect.left;
      if(x>=pane.width&&x<=pane.width+scale.width()){scale.setAutoScale(true);this.onAutoScale?.();}
    });
  }
  update({symbol,bars,minutes,sourceMinutes,at,nodes,cone,levels,spot,focusRange=null,replay=false,session='ALL',annotations=[],nodeScale,drawingsVisible=true,autoScale=true,candleStyle='classic'}){
    if(!this.chart)return false;
    const renderStarted=performance.now();
    const key=symbol+'|'+minutes;
    this.levels=levels;
    const changed=key!==this.key;this.key=key;
    if(this.context&&(this.context.symbol!==symbol||this.context.replay!==replay||(replay&&at<this.context.at)))this.setDrawingMode(null);
    this.context={symbol,minutes,at,replay};this.drawingsVisible=drawingsVisible;
    if(autoScale!==this.autoScale){this.chart.priceScale('right').applyOptions({autoScale});this.autoScale=autoScale;}
    const mono=candleStyle==='mono',hollow=candleStyle==='hollow';
    this.series.applyOptions({upColor:hollow?'transparent':mono?'#69717a':'#28584e',downColor:mono?'#424850':'#63383f',borderUpColor:mono?'#bac0c8':'#65CCB4',borderDownColor:mono?'#8a929c':'#E57D85',wickUpColor:mono?'#bac0c8':'#65CCB4',wickDownColor:mono?'#8a929c':'#E57D85'});
    this.tooltip.hidden=true;this.layer.hits=[];
    const eligible=bars.filter(b=>session==='ALL'||(session==='EXT'?['PRE','POST'].includes(b.phase):b.phase===session));
    const candles=replay?closedCandles(eligible,minutes,sourceMinutes,at):aggregateBars(eligible.filter(b=>Date.parse(b.at)<=at),minutes,sourceMinutes);
    this.visibleCandles=candles;
    this.layer.focusRange=focusRange&&finite(focusRange.low)&&finite(focusRange.high)&&focusRange.high>focusRange.low?focusRange:null;
    this.target.dataset.priceFocus=this.layer.focusRange?JSON.stringify(this.layer.focusRange):'candles';
    this.target.dataset.nodeLastAt=nodes.length?String(Math.max(...nodes.map(n=>Date.parse(n.at)))):'';
    this.target.dataset.candles=String(candles.length);
    this.target.dataset.lastCandleClose=candles.length?String((candles.at(-1).time+minutes*60)*1000):'';
    this.target.dataset.cursor=replay?String(at):'live';
    const previous=this.previousCandles??[],sameAxis=this.dataKey===key+'|'+session+'|'+replay;
    let prefix=sameAxis&&candles.length>=previous.length&&(!previous.length||candles[0]?.time===previous[0]?.time);
    if(prefix)for(let i=0;i<Math.max(0,previous.length-1);i++)if(JSON.stringify(candles[i])!==JSON.stringify(previous[i])){prefix=false;break;}
    let dataMode='unchanged';
    if(!prefix){this.series.setData(candles);dataMode='setData';}
    else if(candles.length===previous.length){if(candles.length&&JSON.stringify(candles.at(-1))!==JSON.stringify(previous.at(-1))){this.series.update(candles.at(-1));dataMode='update';}}
    else{for(const candle of candles.slice(Math.max(0,previous.length-1)))this.series.update(candle);dataMode='append';}
    this.previousCandles=candles;this.dataKey=key+'|'+session+'|'+replay;
    this.target.dataset.chartDataMode=dataMode;
    this.series.applyOptions({lastValueVisible:candles.length>0,priceLineVisible:candles.length>0});
    const curves=[];
    if(cone)for(const curve of cone.curves??[])if(cone.sigmas.includes(curve.sigma))curves.push(curve.points);
    this.target.dataset.cone=cone?JSON.stringify({provider:cone.provider,at:cone.at,until:cone.until,spot:cone.spot,iv:cone.iv,curves}):'';
    // Keep every node/cone time on the chart's time axis without letting remote
    // GEX strikes or future cone prices expand the candle price axis.
    const anchorPrice=this.layer.focusRange?(this.layer.focusRange.low+this.layer.focusRange.high)/2:
      (candles.at(-1)?.close??(finite(spot?.value)?spot.value:nodes.at(-1)?.price));
    const anchors=new Map();
    if(finite(anchorPrice)){
      for(const node of nodes)anchors.set(node.time,anchorPrice);
      for(const c of curves)for(const p of c)anchors.set(p.time,anchorPrice);
      if(candles.length)anchors.set(candles.at(-1).time,anchorPrice);
      if(!candles.length&&finite(spot?.value))anchors.set(Math.floor(at/1000),anchorPrice);
    }
    const anchorData=[...anchors].sort((a,b)=>a[0]-b[0]).map(([time,value])=>({time,value})),anchorKey=JSON.stringify(anchorData);
    if(anchorKey!==this.anchorKey){this.anchor.setData(anchorData);this.anchorKey=anchorKey;}
    const levelKey=JSON.stringify(levels.map(l=>[l.price,l.color,l.style,l.label]));
    if(levelKey!==this.levelKey){for(const line of this.lines)this.anchor.removePriceLine(line);
      this.lines=levels.filter(l=>finite(l.price)&&l.price>0).map(l=>this.anchor.createPriceLine({price:l.price,color:l.color,
        lineStyle:l.style??2,lineWidth:1,axisLabelVisible:true,title:l.label}));this.levelKey=levelKey;}
    if(nodeScale)this.layer.scale=nodeScale;
    this.lastLayers={nodes,curves,annotations};this.refreshDrawings();
    if(changed){
      this.defaultRange();
    }
    this.onControlsLayout?.();
    this.target.dataset.chartUpdateMs=(performance.now()-renderStarted).toFixed(1);
    return true;
  }

  fit(){if(!this.chart)return;this.chart.priceScale('right').applyOptions({autoScale:true});this.chart.timeScale().fitContent();}
  defaultRange(){
    const scale=this.chart.timeScale();scale.fitContent();
    const head=this.visibleCandles.at(-1)?.time??this.lastLayers?.nodes.at(-1)?.time;
    const coordinate=head===undefined?null:scale.timeToCoordinate(head),logical=coordinate===null?null:scale.coordinateToLogical(coordinate);
    if(logical!==null)scale.setVisibleLogicalRange({from:logical-85,to:logical+6});
  }
  resetView(){if(!this.chart)return;this.chart.priceScale('right').applyOptions({autoScale:true});this.defaultRange();}
  captureView(){if(!this.chart)return null;const price=this.chart.priceScale('right');return {time:this.chart.timeScale().getVisibleLogicalRange(),price:price.getVisibleRange(),autoScale:price.options().autoScale};}
  restoreView(view){if(!this.chart||!view)return;if(view.time)this.chart.timeScale().setVisibleLogicalRange(view.time);const price=this.chart.priceScale('right');price.applyOptions({autoScale:view.autoScale});if(!view.autoScale&&view.price)price.setVisibleRange(view.price);}
  setControlZones(zones){if(this.layer&&JSON.stringify(zones)!==JSON.stringify(this.layer.controlZones)){this.layer.controlZones=zones;this.layer.requestUpdate?.();}}
  latest(){
    if(!this.chart||!this.context)return;
    const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();
    const target=this.context.replay?Math.floor(this.context.at/1000):(this.visibleCandles.at(-1)?.time??Math.floor(this.context.at/1000));
    const coordinate=scale.timeToCoordinate(target)??scale.timeToCoordinate(this.visibleCandles.at(-1)?.time??target);
    if(coordinate===null||!range){scale.scrollToRealTime();return;}
    const logical=scale.coordinateToLogical(coordinate),width=Math.max(15,range.to-range.from);
    if(logical!==null)scale.setVisibleLogicalRange({from:logical-width*.85,to:logical+width*.15});
  }
  refreshDrawings(){
    if(!this.layer||!this.context||!this.lastLayers)return;
    const {symbol,at}=this.context;
    this.drawings=this.drawingsVisible?this.savedDrawings.filter(d=>d.symbol===symbol&&d.createdAt<=at&&(d.removedAt==null||at<d.removedAt)):[];
    this.layer.update(this.lastLayers.nodes,this.lastLayers.curves,this.lastLayers.annotations,this.drawings);
    try{localStorage.setItem('gex-drawings',JSON.stringify(this.savedDrawings));}catch{}
    this.target.dataset.drawings=String(this.drawings.length);
  }
  setDrawingMode(mode){this.drawingMode=mode;this.target.dataset.drawingMode=mode??'';this.firstPoint=null;this.target.style.cursor=mode?'crosshair':'';}
  drawingClick(param){
    if(!this.context||!param.point)return;
    const price=this.anchor.coordinateToPrice(param.point.y),rawTime=param.time??this.chart.timeScale().coordinateToTime(param.point.x);
    if(['trend','rectangle'].includes(this.drawingMode)&&rawTime===null){this.onDrawingStatus?.('请选择图表已有时间点作为绘图端点');return;}
    const time=rawTime===null?Math.floor(this.context.at/1000):Number(rawTime);
    this.target.dataset.lastDrawingPoint=JSON.stringify({price,time});
    this.drawingEvents??=[];this.drawingEvents.push({mode:this.drawingMode,point:param.point,price,time,first:!!this.firstPoint});
    this.target.dataset.drawingEvents=JSON.stringify(this.drawingEvents.slice(-6));
    if(!finite(price)||!finite(time))return;
    const point={price,time};
    if(['trend','rectangle'].includes(this.drawingMode)&&!this.firstPoint){this.firstPoint=point;return;}
    if(this.drawingMode){
      this.savedDrawings.forEach(d=>d.selected=false);
      this.savedDrawings.push({id:crypto.randomUUID(),symbol:this.context.symbol,type:this.drawingMode,price,
        start:this.firstPoint??point,end:point,createdAt:this.context.at,selected:true});
      this.setDrawingMode(null);this.refreshDrawings();return;
    }
    let nearest=null,distance=9;
    for(const d of this.drawings){
      let expected;
      if(d.type==='horizontal')expected=this.anchor.priceToCoordinate(d.price);
      else{const ax=this.chart.timeScale().timeToCoordinate(d.start.time),bx=this.chart.timeScale().timeToCoordinate(d.end.time);
        const ay=this.anchor.priceToCoordinate(d.start.price),by=this.anchor.priceToCoordinate(d.end.price);
        if(ax===null||bx===null||param.point.x<Math.min(ax,bx)-5||param.point.x>Math.max(ax,bx)+5)continue;
        if(d.type==='rectangle'){
          const distances=[Math.abs(param.point.y-ay),Math.abs(param.point.y-by)];
          if(param.point.y>=Math.min(ay,by)-5&&param.point.y<=Math.max(ay,by)+5)distances.push(Math.abs(param.point.x-ax),Math.abs(param.point.x-bx));
          expected=param.point.y-Math.min(...distances);
        }else expected=ay+(by-ay)*(param.point.x-ax)/(bx-ax||1);}
      const delta=Math.abs(expected-param.point.y);if(delta<distance){distance=delta;nearest=d;}
    }
    this.savedDrawings.forEach(d=>d.selected=d.id===nearest?.id);this.refreshDrawings();
  }
  deleteDrawing(){for(const d of this.drawings.filter(d=>d.selected))d.removedAt=this.context.at;this.refreshDrawings();}
  drawingVersion(d){
    if(d.createdAt>=this.context.at)return d;
    const copy={...structuredClone(d),id:crypto.randomUUID(),createdAt:this.context.at,selected:true};
    delete copy.removedAt;d.removedAt=this.context.at;d.selected=false;this.savedDrawings.push(copy);return copy;
  }
  editDrawing(key,value){
    if(!finite(value)||value<=0)return;const selected=this.drawings.find(d=>d.selected);if(!selected)return;const d=this.drawingVersion(selected);
    if(key==='price'&&d.type==='horizontal')d.price=value;
    else if(['start.price','end.price'].includes(key)&&d.type!=='horizontal')d[key.split('.')[0]].price=value;
    this.refreshDrawings();
  }
  beginEdit(event){
    if(this.drawingMode||event.target.closest?.('.chart-tools,.corner-cone,.drawing-tools,.export-status'))return;
    const r=this.target.getBoundingClientRect(),p={x:event.clientX-r.x,y:event.clientY-r.y};
    for(const d of this.drawings.filter(d=>d.selected)){
      const endpoints=d.type==='horizontal'?['price']:['start','end'];
      for(const key of endpoints){const x=key==='price'?p.x:this.chart.timeScale().timeToCoordinate(d[key].time),y=this.anchor.priceToCoordinate(key==='price'?d.price:d[key].price);
        if(x!==null&&y!==null&&Math.hypot(p.x-x,p.y-y)<9){this.editing={d:this.drawingVersion(d),key};event.preventDefault();event.stopImmediatePropagation();this.chart.applyOptions({handleScroll:false,handleScale:false});return;}
      }
    }
  }
  dragEdit(event){
    if(!this.editing)return;event.preventDefault();event.stopImmediatePropagation();const r=this.target.getBoundingClientRect(),pane=this.chart.paneSize();
    const x=Math.max(0,Math.min(pane.width,event.clientX-r.x)),y=Math.max(0,Math.min(pane.height,event.clientY-r.y));
    const price=this.anchor.coordinateToPrice(y),time=this.chart.timeScale().coordinateToTime(x),{d,key}=this.editing;
    if(finite(price)&&price>0){if(key==='price')d.price=price;else if(finite(time))d[key]={time,price};this.refreshDrawings();}
  }
  endEdit(){if(!this.editing)return;this.editing=null;this.suppressChartClick=performance.now()+250;this.chart.applyOptions({handleScroll:true,handleScale:true});this.refreshDrawings();}
  async exportPng(){
    if(!this.chart)throw new Error('图表尚未加载');
    // Flush the newly truncated series and primitives before exporting; never
    // capture the previous Live canvas immediately after a Replay seek.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const image=this.chart.takeScreenshot(true,false),canvas=document.createElement('canvas');
    canvas.width=image.width;canvas.height=image.height+40;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#0B0B0D';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,40);
    const {symbol,minutes,replay,at}=this.context,mode=replay?'Replay':'Live';
    ctx.fillStyle='#e7e5ef';ctx.font='13px Consolas';ctx.fillText(`${symbol==='SPXW'?'SPX / options SPXW':symbol} · ${minutes}m · ${mode} · ${new Date(at).toISOString()}`,12,25);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 导出失败')),'image/png'));
    return {blob,filename:`${symbol}_${minutes}m_${new Date(at).toISOString().replace(/[:.]/g,'-')}_${mode}.png`};
  }
}

