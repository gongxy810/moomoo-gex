// Watchlist layout; values always come from observed application quotes.
export function symbolRows(target,{groups,quotes,current,query='',choose}){
  const make=(tag,text,cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
  const header=make('div','','symbol-list-head');
  for(const label of ['Symbol','Last','Chg','Chg%'])header.append(make('span',label));
  target.replaceChildren(header);let count=0;
  for(const [title,items] of groups){
    const filtered=items.filter(s=>s.toUpperCase().includes(query.trim().toUpperCase().replace(/^US\./,'')));
    if(!filtered.length)continue;
    target.append(make('div',title,'symbol-list-group'));
    for(const symbol of filtered){
      const f=quotes[symbol]??{},spot=f.spot,valid=Number.isFinite(spot?.value),prev=f.previousClose;
      const comparable=valid&&Number.isFinite(prev)&&prev>0&&spot?.comparable!==false;
      const change=comparable?spot.value-prev:null,percent=comparable?100*change/prev:null;
      const signed=n=>n===null?'—':(n>0?'+':'')+n.toFixed(2);
      const row=make('button','','symbol-list-row');row.type='button';row.dataset.symbolChoice=symbol;
      row.setAttribute('aria-pressed',String(symbol===current));
      const name=make('span','','symbol-list-name'),icon=make('span',symbol==='SPX'||symbol==='SPXW'?'500':symbol.slice(0,1),'symbol-list-icon');
      const text=make('span',symbol),desc=make('small',symbol==='SPX'?'Cash index · SPXW GEX':symbol==='SPXW'?'PM options · REF':title);
      text.append(desc);name.append(icon,text);row.append(name);
      row.append(make('span',valid?(spot.status==='REF'?'REF ':'')+spot.value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—','symbol-list-last'));
      for(const [i,value] of [change,percent].entries())row.append(make('span',signed(value)+(value!==null&&i===1?'%':''),value===null?'quiet':value>=0?'pos':'neg'));
      row.title=`${symbol} · ${spot?.source??'行情不可用'} · ${spot?.at??'无有效时间戳'} · ${spot?.status??'Unavailable'}`;
      row.onclick=()=>choose(symbol);target.append(row);count++;
    }
  }
  if(!count)target.append(make('p','没有匹配的预设标的；可输入 OpenD 代码并确认。','quiet'));
}
