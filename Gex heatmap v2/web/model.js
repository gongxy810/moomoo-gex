export const symbols = ['SPXW', 'SPY', 'QQQ'];
export const pollMs = 30000;
export const finite = value => typeof value === 'number' && Number.isFinite(value);
const colors = [[65, 15, 88], [53, 83, 124], [43, 142, 129], [117, 193, 112], [252, 231, 83]];

export function datesFor(frame, filter) {
  const dates = frame?.dates ?? [];
  if (filter === '0dte') return dates.filter(date => date === frame.sessionDate);
  if (filter === 'front') return dates.slice(0, 1);
  if (filter === 'week') return dates.filter(date=>date>=frame.sessionDate && Date.parse(date)-Date.parse(frame.sessionDate)<=7*86400000);
  return dates.filter(date => date === filter);
}

export function nearest(strikes, spot, limit) {
  const available=[...new Set(strikes)].filter(finite).sort((a,b)=>a-b);
  const count=Math.min(available.length,Math.max(0,Math.trunc(limit)));
  if(!count)return [];
  let anchor=0;
  available.forEach((value,i)=>{if(Math.abs(value-spot)<Math.abs(available[anchor]-spot))anchor=i;});
  const start=Math.max(0,Math.min(available.length-count,anchor-Math.floor((count-1)/2)));
  return available.slice(start,start+count).reverse();
}

export function strikeView(frame,dates,limit,center='Spot'){
  const rows=groups(frame,dates),pivot=center==='King'?king(rows)?.strike:frame?.spot?.value;
  const strikes=nearest(rows.map(r=>r.strike),pivot??frame?.spot?.value??0,limit);
  const map=new Map(rows.map(r=>[r.strike,r]));
  const shown=strikes.map(s=>map.get(s));
  return {frame,dates,strikes,shown,peak:king(shown)};
}

export function viewSettings(saved={}){
  const limit=Number(saved.limit)===39?40:Number(saved.limit),speed=Number(saved.speed);
  return {limit:[20,30,40,50,60].includes(limit)?limit:40,speed:[1,5,15,30].includes(speed)?speed:5};
}

export function sum(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
}

export function net(cell) {
  return finite(cell?.call)&&finite(cell?.put)?cell.call+cell.put:null;
}

export function groups(frame, dates, strikes = null) {
  const byStrike = new Map();
  const dateSet = new Set(dates);
  const strikeSet = strikes && new Set(strikes);
  for (const cell of frame?.cells ?? []) {
    if (!dateSet.has(cell.expiry) || (strikeSet && !strikeSet.has(cell.strike))) continue;
    if (!byStrike.has(cell.strike)) byStrike.set(cell.strike, []);
    byStrike.get(cell.strike).push(cell);
  }
  return [...byStrike.entries()].map(([strike, cells]) => {
    const entry = {strike};
    for (const key of ['call', 'put', 'callOi', 'putOi']) entry[key] = sum(cells.map(cell => cell[key]));
    entry.complete = dates.every(date=>cells.some(c=>c.expiry===date)) && cells.every(c => c.complete !== false && finite(c.call) && finite(c.put));
    entry.callComplete=dates.every(date=>cells.some(c=>c.expiry===date&&finite(c.call)));
    entry.putComplete=dates.every(date=>cells.some(c=>c.expiry===date&&finite(c.put)));
    entry.contracts = cells.flatMap(c => c.contracts ?? [c.expiry+'|'+c.strike]).sort();
    entry.value = entry.complete ? net(entry) : null;
    entry.oi = sum([entry.callOi, finite(entry.putOi) ? -entry.putOi : null]);
    return entry;
  });
}

export function king(rows) {
  return [...rows].filter(row => finite(row.value) && row.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.strike - b.strike)[0] ?? null;
}

// Chart-node strength is measured against every valid strike in this source and
// expiry set. The ladder's 20–60 visible rows only control the heatmap display.
export function nodeCandidates(frame, dates, top=5, threshold=10) {
  const rows=groups(frame,dates),peak=king(rows);
  if(!peak)return {peak:null,eligible:[],selected:[]};
  const eligible=rows.filter(row=>finite(row.value)&&Math.abs(row.value)>=Math.abs(peak.value)*threshold/100);
  const selected=[...eligible].sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)||a.strike-b.strike).slice(0,top);
  return {peak,eligible,selected};
}

export function velocity(now, before) {
  return finite(now) && finite(before) && before !== 0 ? (Math.abs(now) / Math.abs(before) - 1) * 100 : null;
}

export function baseline(history, frame, minutes = 5) {
  if (!frame) return null;
  const time = Date.parse(frame.collectedAt);
  const target = minutes === 1440 ? Date.parse(frame.previousSessionClose) : time-minutes*60000;
  if (!Number.isFinite(target)) return null;
  const tolerance = minutes === 1440 ? 90000 : Math.min(90000, minutes*30000);
  return history.filter(old => old.symbol === frame.symbol && old.optionRoot === frame.optionRoot && old.model === frame.model &&
      (!old.optionLastAt || (Date.parse(old.optionLastAt)<=Date.parse(old.collectedAt)&&Date.parse(old.collectedAt)-Date.parse(old.optionLastAt)<=900000)) &&
      (minutes === 1440 ? old.sessionDate === frame.previousSession : old.sessionDate === frame.sessionDate && old.spot?.phase === frame.spot?.phase) &&
      Date.parse(old.collectedAt) <= target && target-Date.parse(old.collectedAt) <= tolerance)
    .sort((a,b) => Date.parse(b.collectedAt)-Date.parse(a.collectedAt))[0] ?? null;
}

export function rowVelocity(current, before, dates, oldDates) {
  if (!current?.complete || !before?.complete || !finite(current.value) || !finite(before.value) ||
      JSON.stringify([...dates].sort()) !== JSON.stringify([...oldDates].sort()) ||
      JSON.stringify(current.contracts) !== JSON.stringify(before.contracts)) return {value:null,label:'—',flipped:false,reason:'缺少有效快照，或行权价 / 到期日集合 / 合约不一致'};
  const a=current.value,b=before.value, value=velocity(a,b), flipped=a*b<0;
  if(b===0)return {value:null,label:'—',flipped,reason:'基准 |GEX| 为零，百分比无定义',before:b};
  return {value, flipped, label:
    `${value>=0?'+':'−'}${Math.abs(value).toFixed(1)}%`, delta:a-b, magnitude:Math.abs(a)-Math.abs(b), before:b};
}

export function retainHistory(history, limit=2000) {
  const closes=history.filter(frame=>{
    const age=Date.parse(frame.sessionClose)-Date.parse(frame.collectedAt);
    return age>=0&&age<=90000;
  });
  return [...new Map([...closes,...history.slice(-limit)].map(f=>[f.collectedAt,f])).values()]
    .sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt));
}

export function dayChange(frame) {
  const spot=frame?.spot, previous=frame?.previousClose;
  if (!spot || !(previous>0) || !frame.previousCloseDate || !spot.comparable) return null;
  return {points:spot.value-previous,percent:(spot.value/previous-1)*100,estimated:!!spot.estimated};
}

export function walls(rows, spot) {
  const tie=(a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)||a.strike-b.strike;
  return {call:[...rows].filter(r=>r.callComplete!==false&&finite(r.call)&&r.call>0).sort((a,b)=>b.call-a.call||tie(a,b))[0],
    put:[...rows].filter(r=>r.putComplete!==false&&finite(r.put)&&r.put<0).sort((a,b)=>a.put-b.put||tie(a,b))[0]};
}

export function aggregateBars(bars, minutes, sourceMinutes=1) {
  if (minutes<sourceMinutes || minutes%sourceMinutes) return [];
  const map=new Map();
  for (const bar of [...bars].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
    const at=Date.parse(bar.at), parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(at);
    const hour=Number(parts.find(p=>p.type==='hour').value), minute=Number(parts.find(p=>p.type==='minute').value);
    // Anchor to the start of the reported market phase; never merge PRE and RTH.
    const anchor=bar.phase==='RTH'?570:bar.phase==='PRE'?240:0;
    const offset=((hour*60+minute-anchor)%minutes+minutes)%minutes;
    const time=Math.floor(at/60000)*60-offset*60, key=bar.phase+'|'+time;
    const old=map.get(key);
    if (old) {old.high=Math.max(old.high,bar.h);old.low=Math.min(old.low,bar.l);old.close=bar.c;}
    else map.set(key,{time,open:bar.o,high:bar.h,low:bar.l,close:bar.c});
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

export function atmIv(frame, targetDate=frame?.sessionDate) {
  const valid=(frame?.cells??[]).filter(c=>c.expiry>=targetDate && [c.callIv,c.putIv].some(v=>finite(v)&&v>0));
  const expiry=valid.map(c=>c.expiry).sort()[0];
  const cells=valid.filter(c=>c.expiry===expiry);
  cells.sort((a,b)=>Math.abs(a.strike-frame.spot.value)-Math.abs(b.strike-frame.spot.value));
  if (!cells.length) return null;
  const iv=[cells[0].callIv,cells[0].putIv].filter(v=>finite(v)&&v>0);
  return sum(iv)/iv.length;
}

export function dayRange(frame, history) {
  const close=Date.parse(frame?.previousSessionClose), end=Date.parse(frame?.sessionClose);
  if (!(frame?.previousClose>0) || frame.previousCloseDate!==frame.previousSession || !Number.isFinite(close) || !Number.isFinite(end)) return null;
  const captured=history.filter(old=>old.symbol===frame.symbol && Date.parse(old.collectedAt)<=close &&
    close-Date.parse(old.collectedAt)<=90000 && old.spot?.current && Date.parse(old.spot.at)<=close && close-Date.parse(old.spot.at)<=120000)
    .sort((a,b)=>Date.parse(b.collectedAt)-Date.parse(a.collectedAt))[0];
  const iv=atmIv(captured,frame.sessionDate);
  if (!iv) return null;
  return {spot:frame.previousClose,iv,at:captured.collectedAt,expiry:end,
    move:frame.previousClose*iv*Math.sqrt((end-close)/(365*86400000))};
}

export function palette(value, min, max) {
  if (!finite(value)) return { background: '#161620', color: '#828493' };
  const level = max > min ? (value - min) / (max - min) : .5;
  const p = Math.max(0, Math.min(1, level)) * (colors.length - 1);
  const base = colors[Math.min(colors.length - 2, Math.floor(p))];
  const next = colors[Math.min(colors.length - 1, Math.floor(p) + 1)];
  const rgb = base.map((a, i) => Math.round(a + (next[i] - a) * (p % 1)));
  return { background: p === colors.length - 1 ? '#fce753' : `rgb(${rgb.join(' ')})`, color: level >= .72 ? '#13120b' : '#f3f0ff' };
}

export function demoFrame(symbol, index) {
  const anchors = {SPXW: 7550, SPY: 753, QQQ: 679};
  const pivot = anchors[symbol], step = symbol === 'SPXW' ? 5 : 1;
  const scale = {SPXW: 1.6e9, SPY: 7.4e8, QQQ: 1.9e8}[symbol];
  const start = Date.parse('2026-11-09T14:30:00Z');
  const sessionDate = '2026-11-09', at = start + (index + 1) * 300000;
  const dates = [sessionDate, '2026-11-10', '2026-11-11', '2026-11-13'];
  const wave = i => pivot + step * (.6 * Math.sin(i * .37) + 1.35 * Math.sin(i * .13) + i * .022);
  const bars = Array.from({length: index + 1}, (_, i) => {
    const o = wave(i), c = wave(i + 1) + step * Math.sin(i * 7.3) * .34;
    return {at: new Date(start + i * 300000).toISOString(), o, c,
      h: Math.max(o, c) + step * (.1 + .38 * Math.abs(Math.sin(i * 3.5))),
      l: Math.min(o, c) - step * (.12 + .27 * Math.abs(Math.cos(i * 2.7)))};
  });
  const cells = dates.flatMap((expiry, d) => Array.from({length: 61}, (_, i) => {
    const n = i - 30;
    const noise = .02 * Math.sin(n * 15.5 + d + index * .045);
    const peaks = n === 0 ? (symbol === 'QQQ' ? -1 : 1) :
      n === 1 ? (symbol === 'SPY' ? -.56 : symbol === 'QQQ' ? .46 : .16) :
      n === 2 ? (symbol === 'SPY' ? -.16 : .042) :
      n === -1 ? (symbol === 'QQQ' ? .38 : .075) : 0;
    const value = scale * (peaks * (.78 + .22 * Math.sin(index * .24 + n)) + noise) / (1 + d * 2.4);
    const base = scale * .07 / (1 + Math.abs(n));
    return {expiry, strike: pivot + n * step, call: Math.max(0, value) + base,
      put: Math.min(0, value) - base, callOi: Math.round((Math.max(0, value) + base) / 12340),
      putOi: Math.round((Math.max(0, -value) + base) / 11010), callIv: .21, putIv: .23};
  }));
  for(const cell of cells)for(const side of ['call','put'])cell[side+'Quote']={side,strike:cell.strike,expiry:cell.expiry,optionRoot:symbol,
    code:`US.${symbol}${cell.expiry.slice(2).replaceAll('-','')}${side==='call'?'C':'P'}${cell.strike*1000}`,
    bid:2,ask:2.1,iv:cell[side+'Iv'],ivRaw:cell[side+'Iv']*100,ivUnit:'fraction',at:new Date(at).toISOString(),source:'Synthetic demo'};
  return {source: 'demo', symbol, sessionDate, dates, sessionClose:sessionDate+'T21:00:00Z',sessions:Object.fromEntries(dates.map(d=>[d,d+'T21:00:00Z'])),collectedAt: new Date(at).toISOString(),
    optionFirstAt: new Date(at - 9000).toISOString(), optionLastAt: new Date(at).toISOString(),
    duration: 0, previousClose: pivot / 1.0235, warnings: [], contracts: cells.length * 2, usable: cells.length * 2,
    spot: {value: bars.at(-1).c, at: new Date(at).toISOString(), phase: 'Regular', current: true, label: 'Synthetic'}, bars, cells};
}

export function expectedMove(frame) {
  if (!frame?.spot?.current || !['Regular','RTH','PRE','Premarket'].includes(frame.spot.phase)) return null;
  const candidates = frame.cells.filter(c => c.expiry === frame.sessionDate && [c.callIv, c.putIv].some(finite));
  const cell = candidates.sort((a, b) => Math.abs(a.strike - frame.spot.value) - Math.abs(b.strike - frame.spot.value))[0];
  if (!cell) return null;
  const iv = [cell.callIv, cell.putIv].filter(finite);
  const at = Date.parse(frame.collectedAt);
  const utcHour = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', hour:'numeric', hourCycle:'h23'}).format(at);
  const offset = (new Date(at).getUTCHours() - Number(utcHour) + 24) % 24;
  const expiry = Date.parse(frame.sessionClose ?? `${frame.sessionDate}T${16 + offset}:00:00Z`);
  const minutes = (expiry - at) / 60000;
  if (minutes <= 0) return null;
  const averageIv=sum(iv)/iv.length;
  return {at, expiry, iv:averageIv, spot: frame.spot.value, move: frame.spot.value * averageIv * Math.sqrt(minutes / (365 * 1440))};
}
