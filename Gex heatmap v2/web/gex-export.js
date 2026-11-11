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
