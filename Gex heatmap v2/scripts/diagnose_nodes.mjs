import {readFile,writeFile} from 'node:fs/promises';
import {groups,nearest,king,finite} from '../web/model.js';
import {snapshotTrail} from '../web/replay.js';
const data=JSON.parse(await readFile('tests/browser-artifacts/design-market.json','utf8'));
const results=[];
for(const cursor of ['2026-11-10T19:37:07Z','2026-11-10T20:08:12Z']){
  const frames=data.responses['history|SPY'].frames.filter(f=>Date.parse(f.collectedAt)<=Date.parse(cursor));
  const trail=snapshotTrail(frames,5,Date.parse(cursor));
  let eligibleBuckets=0,candidates=0,selectedNodes=0;
  for(const frame of trail){
    const rows=groups(frame,['2026-11-10']),strikes=nearest(rows.map(r=>r.strike),frame.spot?.value,39);
    const shown=rows.filter(r=>strikes.includes(r.strike)),peak=king(shown);if(!peak)continue;
    eligibleBuckets++;
    const chosen=shown.filter(r=>finite(r.value)&&Math.abs(r.value)>=Math.abs(peak.value)*.1).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    candidates+=chosen.length;selectedNodes+=chosen.slice(0,5).length;
  }
  results.push({cursor,rawSnapshots:frames.length,eligibleBuckets,candidates,selectedNodes,source:'SPY only, 0DTE 2026-11-10, 39 rows, 5m, Top5, >= King10%'});
}
await writeFile('tests/browser-artifacts/design-node-audit.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
