import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if(!existsSync('web/vendor/lightweight-charts.standalone.production.js'))throw new Error('Official chart bundle missing; run npm install then npm run vendor before packaging.');
const result=spawnSync('.venv/Scripts/python.exe',['scripts/package.py'],{stdio:'inherit'});
process.exit(result.status??1);
