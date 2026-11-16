"""One-time streaming migration of a trading day's observed history. No repricing."""
import argparse,json,gzip,sqlite3
from pathlib import Path
from datetime import datetime,timedelta,timezone
from contextlib import closing
p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--day',required=True);p.add_argument('--out',required=True);p.add_argument('--bucket-minutes',type=int,default=1);a=p.parse_args()
if not 1<=a.bucket_minutes<=15:raise ValueError('Invalid archive bucket')
day=datetime.fromisoformat(a.day);start=(day-timedelta(days=1)).date().isoformat();end=(day+timedelta(days=1)).date().isoformat()+'T02:00:00+00:00'
counts={}
with closing(sqlite3.connect(Path(a.db).resolve().as_uri()+'?mode=ro',uri=True)) as db,gzip.open(a.out,'wt',encoding='utf-8') as out:
    def write(kind,values):
        out.write(json.dumps({'kind':kind,'values':values},ensure_ascii=False)+'\n');counts[kind]=counts.get(kind,0)+1
    symbols=[r[0] for r in db.execute('SELECT DISTINCT symbol FROM captures')]
    for symbol in symbols:
        rows=db.execute("SELECT symbol,at,frame FROM captures WHERE symbol=? AND at IN (SELECT MAX(at) FROM captures WHERE symbol=? AND json_extract(frame,'$.sessionDate')=? AND at>=? AND at<? GROUP BY CAST(strftime('%s',at)/? AS INTEGER)) ORDER BY at",(symbol,symbol,a.day,a.day,end,a.bucket_minutes*60))
        for row in rows:write('capture',list(row))
        for row in db.execute('SELECT symbol,at,bar FROM price_bars WHERE symbol=? AND at>=? AND at<? ORDER BY at',(symbol,start,end)):write('bar',list(row))
        for row in db.execute('SELECT symbol,day,at,frame FROM close_archives WHERE symbol=? AND day<=? ORDER BY day DESC LIMIT 2',(symbol,a.day)):write('close',list(row));write('capture',[row[0],row[2],row[3]])
    for row in db.execute('SELECT day,state FROM spx_basis_states WHERE day=?',(a.day,)):write('basis_state',list(row))
    for row in db.execute("SELECT at,anchor FROM spx_basis_anchors WHERE json_extract(anchor,'$.day')=?",(a.day,)):write('basis_anchor',list(row))
print(json.dumps(counts))
