import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const pkg=JSON.parse(await readFile(new URL('node_modules/lightweight-charts/package.json',root)));
if(pkg.version!=='5.2.1')throw new Error('Expected lightweight-charts 5.2.1');
await mkdir(new URL('web/vendor/',root),{recursive:true});
for(const [from,to] of [['dist/lightweight-charts.standalone.production.js','lightweight-charts.standalone.production.js'],['LICENSE','LICENSE']])
  await copyFile(new URL('node_modules/lightweight-charts/'+from,root),new URL('web/vendor/'+to,root));
// NOTICE at the pinned upstream v5.2.1 tag; npm omits this file.
await writeFile(new URL('web/vendor/NOTICE',root),'TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/\n');
console.log('Vendored Lightweight Charts 5.2.1, LICENSE and NOTICE');
