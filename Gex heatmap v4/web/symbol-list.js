// Watchlist layout; values always come from observed application quotes.
const marks={
  SPX:{bg:'#c8102e',fg:'#fff',svg:'<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700">500</text>'},
  SPXW:{bg:'#c8102e',fg:'#fff',svg:'<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700">500</text>'},
  SPY:{bg:'#1c6b46',fg:'#fff',svg:'<text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" font-size="17" font-weight="700">S</text>'},
  QQQ:{bg:'#1269b0',fg:'#fff',svg:'<path d="M4 17 9 7l3 6 2-4 6 8H4Z"/><circle cx="16.5" cy="16.5" r="2.2" fill="#fff"/>'},
  IWM:{bg:'#167aa6',fg:'#fff',svg:'<text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" font-size="16" font-weight="700">i</text>'},
  AAPL:{bg:'#24262b',fg:'#fff',svg:'<path d="M16.7 12.1c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.3.7-2.9.7-.6 0-1.5-.7-2.5-.7-1.3 0-2.5.8-3.2 1.9-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.7 2.6-.7s1.6.7 2.6.7c1.1 0 1.7-1 2.3-2 .7-1.1 1-2.1 1-2.2-.1 0-2.1-.8-2.1-3zM14.8 5.8c.6-.7 1-1.6.9-2.5-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.9 2.4.9.1 1.8-.4 2.4-1.1z"/>'},
  MSFT:{bg:'#f2f4f7',fg:'#fff',svg:'<rect x="4" y="4" width="7" height="7" fill="#f25022"/><rect x="13" y="4" width="7" height="7" fill="#7fba00"/><rect x="4" y="13" width="7" height="7" fill="#00a4ef"/><rect x="13" y="13" width="7" height="7" fill="#ffb900"/>'},
  NVDA:{bg:'#76b900',fg:'#fff',svg:'<path d="M3 12c5-6 11-7 18 0-6 6-12 6-18 0Zm4-1c3-3 6-3 9 0-3 3-6 3-9 0Zm4 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/>'},
  AMZN:{bg:'#232f3e',fg:'#ff9900',svg:'<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-size="15" font-weight="700">a</text><path d="M5 17c4 3 10 3 14-1" fill="none" stroke="#ff9900" stroke-width="1.8" stroke-linecap="round"/>'},
  GOOGL:{bg:'#f5f7fa',fg:'#4285f4',svg:'<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="17" font-weight="700" fill="#4285f4">G</text>'},
  META:{bg:'#e8f1ff',fg:'#0866ff',svg:'<path d="M3 15c2-8 5-9 8-2s5 8 7 1c1-5 3-5 4-1" fill="none" stroke="#0866ff" stroke-width="2.4" stroke-linecap="round"/>'},
  TSLA:{bg:'#cc0000',fg:'#fff',svg:'<path d="M4 5c5-2 11-2 16 0l-2 2c-3-1-9-1-12 0L4 5Zm4 4 4 2 4-2-2 10h-4L8 9Z"/>'}
};
function logo(symbol){
  const initial=/^[A-Z0-9]$/.test(symbol.slice(0,1))?symbol.slice(0,1):'?';
  const spec=marks[symbol]??{bg:'#373440',fg:'#e9ba48',svg:`<text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="700">${initial}</text>`};
  const icon=document.createElement('span');icon.className='symbol-list-icon';icon.style.background=spec.bg;icon.style.color=spec.fg;icon.setAttribute('role','img');icon.setAttribute('aria-label',`${symbol} logo`);
  icon.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${spec.svg}</svg>`;return icon;
}
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
      const name=make('span','','symbol-list-name'),icon=logo(symbol);
      const text=make('span',symbol),desc=make('small',symbol==='SPX'?'Cash index · SPXW GEX':symbol==='SPXW'?'PM options · REF':title);
      text.append(desc);name.append(icon,text);row.append(name);
      const status=spot?.status==='Delayed'?'DLY ':spot?.status==='Closed'?'CLOSED ':spot?.status==='REF'?'REF ':'';
      row.append(make('span',valid?status+spot.value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—','symbol-list-last'));
      for(const [i,value] of [change,percent].entries())row.append(make('span',signed(value)+(value!==null&&i===1?'%':''),value===null?'quiet':value>=0?'pos':'neg'));
      row.title=`${symbol} · ${spot?.source??'行情不可用'} · ${spot?.at??'无有效时间戳'} · ${spot?.status??'Unavailable'}`;
      row.onclick=()=>choose(symbol);target.append(row);count++;
    }
  }
  if(!count)target.append(make('p','没有匹配的预设标的；可输入 OpenD 代码并确认。','quiet'));
}
