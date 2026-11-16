"""Merge original timestamps and values; never replaces newer/current captures."""
import sys,json,gzip,sqlite3
from contextlib import closing
tables={'capture':('captures',3),'bar':('price_bars',3),'close':('close_archives',4),'basis_state':('spx_basis_states',2),'basis_anchor':('spx_basis_anchors',2)}
counts={}
with closing(sqlite3.connect(sys.argv[1],timeout=60)) as db,db,gzip.open(sys.argv[2],'rt',encoding='utf-8') as source:
    for line in source:
        row=json.loads(line);table,n=tables[row['kind']]
        db.execute(f'INSERT OR IGNORE INTO {table} VALUES ({",".join("?" for _ in range(n))})',row['values']);counts[row['kind']]=counts.get(row['kind'],0)+1
print(json.dumps(counts))
