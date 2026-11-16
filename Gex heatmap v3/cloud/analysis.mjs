// Uses the exact same pure calculation modules as the local board.
import {setMetric,groups,nodeCandidates,rowVelocity,baseline} from '../web/model.js';
import {classifyNodes,velocityBoard,nodeTouches,gravityTrail} from '../web/structure.js';
import {snapshotTrail} from '../web/replay.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const p=JSON.parse(input);setMetric(p.metric);
const rows=groups(p.frame,p.dates),roles=classifyNodes(rows,p.frame.spot?.value),velocity=velocityBoard(p.frame,p.dates,p.history);
const touches=Object.fromEntries(rows.map(r=>[r.strike,nodeTouches(r.strike,p.bars,p.at,p.frame.sessionDate,1)]));
const moves=Object.fromEntries([1,5,15,30].map(m=>{const old=baseline(p.history,p.frame,m),map=new Map(groups(old,p.dates).map(r=>[r.strike,r]));return[m,Object.fromEntries(rows.map(r=>[r.strike,rowVelocity(r,map.get(r.strike),p.dates,old?p.dates.filter(d=>old.dates.includes(d)):[])]))];}));
const nodes=[];let candidates=0;
const trail=snapshotTrail(p.history,p.minutes,p.at).filter(f=>p.session==='ALL'||(p.session==='EXT'?['PRE','POST'].includes(f.spot?.phase):f.spot?.phase===p.session));
for(const f of trail){const {peak,eligible,selected}=nodeCandidates(f,p.dates,p.top,p.threshold);if(!peak)continue;candidates+=eligible.length;
  for(const row of selected)nodes.push({time:Math.floor(Date.parse(f.collectedAt)/(p.minutes*60000))*p.minutes*60,price:row.strike,value:row.value,weight:Math.abs(row.value/peak.value),king:peak.value,
    shape:'ellipse',derived:false,at:f.collectedAt,source:f.symbol,root:f.optionRoot,strike:row.strike,dates:p.dates,
    title:`${p.metric} / ${f.symbol} / strike ${row.strike} / ${f.collectedAt} / raw ${row.value} / King ${peak.value} / ${(Math.abs(row.value/peak.value)*100).toFixed(1)}%`});
}
process.stdout.write(JSON.stringify({available:true,roles:{...roles,roles:[...roles.roles]},velocity,touches,moves,nodes,gravity:gravityTrail(p.history,p.dates,p.at,p.minutes),
  trailCount:trail.length,candidates,loadedSize:0,capture_at:p.frame.collectedAt,asof:new Date(p.at).toISOString(),metric:p.metric,engine:'shared-v3-cloud'}));
