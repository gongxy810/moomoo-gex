const valid=n=>Number.isFinite(n)&&n>0;
const price=n=>String(Number(n.toFixed(4)));

export function gexSnapshot({symbol,date,frameDate,putWall,callWall,king,range,at=Infinity}){
  const missing=[];
  if(!/^[A-Z][A-Z0-9._-]*$/.test(symbol??''))missing.push('标的');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||frameDate!==date)missing.push('纽约日期与 GEX 快照不匹配');
  if(!valid(putWall))missing.push('Put Wall');
  if(!valid(callWall))missing.push('Call Wall');
  if(!valid(king))missing.push('King Node');
  const expectedSymbol=symbol==='SPXW'?'SPX':symbol;
  const rangeValid=range?.available&&range.kind==='fixed-day'&&range.rangeDate===date&&range.symbol===expectedSymbol&&
    Number.isFinite(range.at)&&range.at<=at;
  const anchor=range?.anchor??range?.spot;
  const points=range?.movePoints;
  const low=rangeValid?(valid(range.impliedLow1)?range.impliedLow1:valid(anchor)&&valid(points)?anchor-points:null):null;
  const high=rangeValid?(valid(range.impliedHigh1)?range.impliedHigh1:valid(anchor)&&valid(points)?anchor+points:null):null;
  if(!valid(low)||!valid(high)||low>=high)missing.push('固定 Expected Move ±1σ 上下沿');
  const parts=[symbol??'—',date?.replaceAll('-','')??'—',putWall,callWall,low,high,king];
  const preview=parts.map((value,i)=>i<2?value:valid(value)?price(value):'—').join(',');
  return {line:missing.length?null:preview,preview,missing,low,high};
}

// Manual Pine input. GEX2 is intentionally separate from the legacy seven-field row.
// Only a real, same-session capture can be exported; missing range fields stay "na".
export function pineSnapshot({symbol,date,frame,dates=[],rows=[],putWall,callWall,king,range,at=Infinity,top=5,threshold=10,referenceKind='Unavailable'}){
  if(!/^[A-Z][A-Z0-9._-]*$/.test(symbol??'')||!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||
      frame?.sessionDate!==date||!Array.isArray(dates)||!dates.length||!rows.length)return null;
  const captured=frame.captureAt??frame.collectedAt;
  if(!Number.isFinite(Date.parse(captured))||Date.parse(captured)>at)return null;
  const current=gexSnapshot({symbol,date,frameDate:frame.sessionDate,putWall,callWall,king,range,at});
  const candidates=rows.filter(row=>valid(row.strike)&&Number.isFinite(row.value)&&row.complete!==false);
  const strongest=Math.max(0,...candidates.map(row=>Math.abs(row.value)));
  if(!strongest||!valid(king)||!valid(putWall)||!valid(callWall))return null;
  const selected=candidates.filter(row=>Math.abs(row.value)>=strongest*Math.max(0,threshold)/100)
    .sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)||a.strike-b.strike).slice(0,Math.max(1,Math.min(20,top)));
  const field=n=>Number.isFinite(n)?price(n):'na';
  const all=candidates.reduce((sum,row)=>sum+row.value,0);
  const call=candidates.reduce((sum,row)=>sum+(Number.isFinite(row.call)?row.call:0),0);
  const put=candidates.reduce((sum,row)=>sum+(Number.isFinite(row.put)?row.put:0),0);
  const rangeOK=valid(current.low)&&valid(current.high)&&current.low<current.high;
  const header=['GEX2',symbol,date.replaceAll('-',''),field(putWall),field(callWall),
    rangeOK?field(current.low):'na',rangeOK?field(current.high):'na',field(king),captured,dates.join('+'),field(all),field(call),field(put),
    valid(frame.spot?.value)?field(frame.spot.value):'na',['Spot','REF','Delayed'].includes(referenceKind)?referenceKind:'Unavailable'];
  const levels=selected.map(row=>['L',price(row.strike),field(row.value),field(100*Math.abs(row.value)/strongest)].join('|'));
  return [header.join('|'),...levels].join('\n');
}

