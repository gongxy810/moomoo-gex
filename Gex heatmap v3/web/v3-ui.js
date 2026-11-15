import {activeMetric,setMetric,groups,finite} from './model.js';
import {classifyNodes,velocityBoard,nodeTouches,gravityTrail} from './structure.js';
export const v3={metric:'GEX',percent:false,dim:false,gravity:false,gk:false,hidden:new Set(),tracked:new Set(),lines:new Map()};
const key=(symbol,strike)=>symbol+'|'+strike;
const make=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
let rerender;
export function installV3(render,jump){
  rerender=render;const toolbar=document.querySelector('.toolbar')??document.querySelector('#symbols').parentElement;
  if(!toolbar?.insertBefore)return;
  for(const [name,label,action] of [['metric','GEX / VEX',()=>{v3.metric=v3.metric==='GEX'?'VEX':'GEX';setMetric(v3.metric);}],['percent','% King',()=>v3.percent=!v3.percent],['dim','Dim Low',()=>v3.dim=!v3.dim]]){
    const b=make('button',label);b.id='v3-'+name;b.type='button';b.onclick=()=>{action();b.setAttribute('aria-pressed',name==='metric'?v3.metric==='VEX':v3[name]);render();};toolbar.insertBefore(b,document.querySelector('#export-gex-levels'));
  }
  for(const [name,label] of [['gravity','GEX VWAP'],['gk','GK / Flip']]){const b=make('button',label);b.type='button';b.id='v3-'+name;b.title=name==='gravity'?'Local absolute-exposure weighted strike center ±1 weighted standard deviation; not trade VWAP':'Local heuristic Gatekeeper and strike-profile sign crossing';b.onclick=()=>{v3[name]=!v3[name];b.setAttribute('aria-pressed',v3[name]);render();};document.querySelector('.layer-controls').append(b);}
  const show=make('button','Show hidden');show.type='button';show.onclick=()=>{v3.hidden.clear();render();};document.querySelector('.layer-controls').append(show);
  const board=make('div','');board.id='v3-structure';document.querySelector('.terminal').before(board);
  for(const [time,label] of [['09:30','09:30 Open'],['12:00','12:00 Noon'],['16:00','16:00 Close']]){const b=make('button',label);b.type='button';b.onclick=()=>jump(time);document.querySelector('#replay-form').append(b);}
  document.addEventListener('keydown',e=>{if(e.target.closest?.('input,textarea,select,[contenteditable=true]'))return;if(e.shiftKey&&['g','v'].includes(e.key.toLowerCase())){e.preventDefault();v3.metric=e.key.toLowerCase()==='v'?'VEX':'GEX';setMetric(v3.metric);render();}});
}
export function decorateRow(line,row,{symbol,frame,dates,history,bars,sourceMinutes,cutoff,threshold,peak,roles,velocities}){
  if(!line.querySelector)return;
  const id=key(symbol,row.strike);if(v3.hidden.has(id))line.hidden=true;
  if(v3.dim&&peak&&Math.abs(row.value)<Math.abs(peak.value)*threshold/100)line.style.opacity='.35';
  const amount=line.querySelector('.gex-amount');if(v3.percent&&peak&&finite(row.value))amount.textContent=(row.value<0?'-':'')+(100*Math.abs(row.value/peak.value)).toFixed(1)+'% King';
  const names=roles.roles.get(row.strike)??[],velocity=velocities.entries.find(e=>e.strike===row.strike),touch=nodeTouches(row.strike,bars,cutoff,frame.sessionDate,sourceMinutes);
  const info=make('span',(velocity?.halo?'◎ ':'')+(v3.tracked.has(id)?'⌖ ':'')+(touch===null?'':touch===0?'Fresh':touch>=3?'3×+ Delivered':touch+'×'));
  info.className='node-role';line.append(info);
  if(velocity?.halo){const badge=line.querySelector('.velocity');if(badge)badge.textContent='HALO '+badge.textContent;}
  line.dataset.metric=activeMetric;line.dataset.roles=names.join(', ');line.dataset.halo=String(!!velocity?.halo);
  line.oncontextmenu=e=>{e.preventDefault();document.querySelector('#v3-context')?.remove();const menu=make('div','');menu.id='v3-context';menu.className='v3-context';
    menu.append(make('strong',symbol+' '+row.strike+' · '+activeMetric),make('p',names.join(' · ')+(touch===null?' / Touch unavailable':' / observed RTH touches '+touch)),make('p','Raw '+(finite(row.value)?row.value.toLocaleString('en-US'):'unavailable')));
    for(const [label,action] of [[v3.tracked.has(id)?'Untrack':'Track',()=>v3.tracked.has(id)?v3.tracked.delete(id):v3.tracked.add(id)],['Draw horizontal line',()=>v3.lines.set(id,{symbol,price:row.strike,color:'#e9ba48',label:'Tracked '+row.strike,style:2})],['Hide strike',()=>v3.hidden.add(id)]]){const b=make('button',label);b.onclick=()=>{action();menu.remove();rerender();};menu.append(b);}
    document.body.append(menu);menu.style.left=Math.max(8,Math.min(e.clientX,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(e.clientY,innerHeight-menu.offsetHeight-8))+'px';
    const close=ev=>{if(ev.type==='keydown'&&ev.key!=='Escape')return;if(!menu.contains(ev.target)){menu.remove();document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);
  };
}
export function structures(view,history,cutoff){
  const rows=groups(view.frame,view.dates),roles=classifyNodes(rows,view.frame?.spot?.value),velocity=velocityBoard(view.frame,view.dates,history);
  const board=document.querySelector('#v3-structure');
  if(board){const names=[['King',roles.peak],['Gatekeeper',roles.gatekeeper],['Ceiling',roles.ceiling],['Floor',roles.floor]].map(([n,r])=>n+' '+(r?.strike??'—')).join(' · ');
    const legend=(document.querySelectorAll?.('.chart-key > span')??[]);if(legend[0])legend[0].innerHTML='<i class=yellow></i> +'+activeMetric;if(legend[1])legend[1].innerHTML='<i class=purple></i> -'+activeMetric;
    const toggle=document.querySelector('#v3-metric');if(toggle){toggle.textContent=activeMetric;toggle.title='VEX: local signed OI estimate per 1 absolute vol point; r=q=0 ACT/365. Missing expiry IV/time = unavailable';toggle.setAttribute('aria-pressed',activeMetric==='VEX');}
    const vw=document.querySelector('#v3-gravity');if(vw)vw.textContent=activeMetric+' VWAP';
    board.textContent=activeMetric+' · '+names+' · Profile Flip '+(roles.flip?.toFixed(2)??'—')+' | Top Movers | growing: '+velocity.up.map(e=>e.strike).join(', ')+' | shrinking: '+velocity.down.map(e=>e.strike).join(', ');
    board.title='Local rules: King=max absolute exposure; Gatekeeper=nearest ≥10% King; Ceiling/Floor=strongest above/below reference; Air Pocket=≥2 contiguous <3% King rows. Halo=at least 2 of 1/5/15/30m magnitude changes ≥3% in the same direction. Changes are exposure magnitude, not proven position additions.';}
  return {roles,velocity,gravity:v3.gravity?gravityTrail(history,view.dates,cutoff):[]};
}
