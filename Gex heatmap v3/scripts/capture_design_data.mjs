import {writeFile,mkdir} from 'node:fs/promises';
const root='http://127.0.0.1:8766';
const data={at:Date.now(),health:await (await fetch(root+'/api/health')).json(),responses:{},assets:{}};
await Promise.all(['SPXW','SPY','QQQ'].map(async symbol=>{
  for(const route of ['snapshot','price','history','price-history']){
    const response=await fetch(`${root}/api/${route}?symbol=${symbol}`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`${route} ${symbol}: ${response.status}`);
    data.responses[`${route}|${symbol}`]=await response.json();
  }
}));
for(const name of ['app.js','chart.js','model.js','style.css'])data.assets[name]=await (await fetch(root+'/'+name)).text();
await mkdir('tests/browser-artifacts',{recursive:true});
await writeFile('tests/browser-artifacts/design-market.json',JSON.stringify(data));
console.log(JSON.stringify({at:data.at,health:data.health,symbols:['SPXW','SPY','QQQ'].map(s=>({symbol:s,frames:data.responses['history|'+s].frames.length,usable:data.responses['snapshot|'+s].usable,bars:data.responses['price|'+s].bars.length}))}));
