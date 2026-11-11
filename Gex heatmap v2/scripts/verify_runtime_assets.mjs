import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8766';
const health=await (await fetch(base+'/api/health')).json(),assets=[];
assert.equal(health.webRoot.toLowerCase(),'C:\\Users\\gxy\\Downloads\\opend-gex-relay\\web'.toLowerCase());
assert.equal(health.currentOnDisk,true,'restart required: running Python source is stale');
for(const name of ['index.html','app.js','model.js','chart.js','tools.js','replay.js','expected.js','style.css']){
  const response=await fetch(base+'/'+name),body=Buffer.from(await response.arrayBuffer()),local=await readFile('web/'+name);
  assert.equal(response.status,200);assert.deepEqual(body,local);assert.equal(response.headers.get('cache-control'),'no-store');
  assets.push({name,matchesWorkspace:true,sha256:createHash('sha256').update(body).digest('hex')});
}
await writeFile('tests/browser-artifacts/design-runtime.json',JSON.stringify({health,assets},null,2));
console.log(JSON.stringify({pid:health.pid,webRoot:health.webRoot,currentOnDisk:health.currentOnDisk,assets:assets.length,allMatch:true}));
