"""Measure the indexed capture window and its actual SQLite access path."""
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import monotonic
root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root))
from snapshots import SnapshotStore
started=monotonic();store=SnapshotStore(root/'data'/'captures.sqlite3')
index_seconds=monotonic()-started
end=datetime.now(timezone.utc);start=end-timedelta(hours=10)
started=monotonic();rows=store.window('SPY',start.isoformat(),end.isoformat())
window_seconds=monotonic()-started
with sqlite3.connect(root/'data'/'captures.sqlite3') as db:
    close_plan=db.execute("""EXPLAIN QUERY PLAN SELECT frame FROM captures WHERE symbol='SPY' AND
        julianday(json_extract(frame,'$.sessionClose'))-julianday(at) BETWEEN 0 AND 90.0/86400""").fetchall()
    latest_plan=db.execute("EXPLAIN QUERY PLAN SELECT frame FROM captures WHERE symbol='SPY' ORDER BY at DESC LIMIT 1").fetchall()
print(json.dumps({'indexSeconds':round(index_seconds,3),'windowSeconds':round(window_seconds,3),
                  'windowRows':len(rows),'windowBytes':len(json.dumps(rows)),'closePlan':close_plan,'latestPlan':latest_plan}))
