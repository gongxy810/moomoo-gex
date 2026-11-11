// Reproducible audit of an actual archived OpenD capture; never substitutes demo IV.
import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {openDExpected} from '../web/expected.js';

const db=new DatabaseSync('data/captures.sqlite3',{readOnly:true});
const rows=db.prepare("SELECT frame FROM captures WHERE symbol='SPY' ORDER BY at DESC LIMIT 3000").all();
let result,rawCandidate,firstIv;const reasons=new Map(),frontReasons=new Map();let current=0,quoted=0,withIv=0,todayWithIv=0;
for(const row of rows){
  const frame=JSON.parse(row.frame),at=Date.parse(frame.collectedAt);
  if(frame.spot?.current)current++;
  if(frame.cells?.some(c=>c.callQuote?.bid>0&&c.putQuote?.bid>0))quoted++;
  if(frame.spot?.current&&frame.cells?.some(c=>c.callQuote?.iv>0||c.putQuote?.iv>0)){
    withIv++;firstIv??={at:frame.collectedAt,sessionClose:frame.sessionClose,sessionDate:frame.sessionDate,dates:frame.dates};}
  if(frame.spot?.current&&frame.cells?.some(c=>c.expiry===frame.sessionDate&&(c.callQuote?.iv>0||c.putQuote?.iv>0)))todayWithIv++;
  const cone=openDExpected(frame,{at});
  if(!cone.available)reasons.set(cone.reason,(reasons.get(cone.reason)??0)+1);
  const front=openDExpected(frame,{at,horizon:'front'});
  if(!front.available)frontReasons.set(front.reason,(frontReasons.get(front.reason)??0)+1);
  if(!rawCandidate&&frame.spot?.current&&Date.parse(frame.sessionClose)>at&&frame.dates?.includes(frame.sessionDate)){
    const cells=(frame.cells??[]).filter(c=>c.expiry===frame.sessionDate&&
      (c.callQuote?.iv>0||c.putQuote?.iv>0)).sort((a,b)=>Math.abs(a.strike-frame.spot.value)-Math.abs(b.strike-frame.spot.value));
    const cell=cells[0];if(cell){const ivs=[cell.callQuote?.iv,cell.putQuote?.iv].filter(v=>v>0);
      const iv=ivs.reduce((a,b)=>a+b,0)/ivs.length,yearFraction=(Date.parse(frame.sessionClose)-at)/(365*86400000);
      const width=frame.spot.value*iv*Math.sqrt(yearFraction);
      rawCandidate={frameAt:frame.collectedAt,spot:frame.spot,optionRoot:frame.optionRoot,
        expiry:cell.expiry,settleAt:frame.sessionClose,strike:cell.strike,
        callQuote:cell.callQuote,putQuote:cell.putQuote,iv,yearFraction,
        hypotheticalFromUnvalidatedVendorIV:{high:frame.spot.value+width,low:frame.spot.value-width,width},
        displayStatus:cone.reason};}
  }
  const valid=cone.available?cone:front;
  if(valid.available){
    result={frameAt:frame.collectedAt,sessionDate:frame.sessionDate,spot:frame.spot,
      optionRoot:frame.optionRoot,optionFirstAt:frame.optionFirstAt,optionLastAt:frame.optionLastAt,
      cone:{...valid,curves:undefined},calc:{width:valid.spot*valid.iv*Math.sqrt(valid.yearFraction),
        high:valid.spot+valid.spot*valid.iv*Math.sqrt(valid.yearFraction),
        low:valid.spot-valid.spot*valid.iv*Math.sqrt(valid.yearFraction)}};break;
  }
}
db.close();
const output='tests/browser-artifacts/real-expected-sample.json';
await writeFile(output,JSON.stringify({checked:rows.length,current,quoted,withIv,todayWithIv,firstIv,reasons:Object.fromEntries(reasons),frontReasons:Object.fromEntries(frontReasons),result:result??null,rawCandidate:rawCandidate??null},null,2));
console.log(JSON.stringify({output,checked:rows.length,current,quoted,withIv,todayWithIv,firstIv,reasons:Object.fromEntries(reasons),frontReasons:Object.fromEntries(frontReasons),available:!!result,
  sample:result?{frameAt:result.frameAt,horizon:result.cone.horizon,spot:result.cone.spot,iv:result.cone.iv,yearFraction:result.cone.yearFraction,
    high:result.cone.impliedHigh1,low:result.cone.impliedLow1,quality:result.cone.quality}:rawCandidate}));
