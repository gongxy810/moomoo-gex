"""Finite local-only history. Missing collection periods are never synthesized."""
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock


class SnapshotStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        with closing(self.connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS captures (symbol TEXT, at TEXT, frame TEXT, PRIMARY KEY(symbol, at))')
            db.execute("CREATE INDEX IF NOT EXISTS captures_close_idx ON captures(symbol, (julianday(json_extract(frame, '$.sessionClose'))-julianday(at)))")
            db.execute('CREATE TABLE IF NOT EXISTS price_bars (symbol TEXT, at TEXT, bar TEXT, PRIMARY KEY(symbol,at))')
            db.execute('CREATE TABLE IF NOT EXISTS price_meta (symbol TEXT PRIMARY KEY, meta TEXT)')

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def save(self, frame):
        if not frame.get('usable'):
            return
        # Keep every successfully observed contract/expiry/strike in its original capture.
        compact = {k: v for k, v in frame.items() if k not in {'bars'}}
        if 'price' in compact:
            compact['price'] = {k: v for k, v in compact['price'].items() if k != 'bars'}
        with self.lock, closing(self.connect()) as db, db:
            db.execute('INSERT OR IGNORE INTO captures VALUES (?,?,?)',
                       (frame['symbol'], frame['collectedAt'], json.dumps(compact, allow_nan=False)))
            cutoff = (datetime.now(timezone.utc)-timedelta(days=10)).isoformat(timespec='seconds')
            db.execute('DELETE FROM captures WHERE at < ?', (cutoff,))

    def history(self, symbol, limit=2000, day=None):
        with self.lock, closing(self.connect()) as db:
            if day:
                rows=db.execute("SELECT frame FROM captures WHERE symbol=? AND json_extract(frame, '$.sessionDate')=? ORDER BY at LIMIT 4000",(symbol,day)).fetchall()
            else:
                rows = db.execute('SELECT frame FROM captures WHERE symbol=? ORDER BY at DESC LIMIT ?', (symbol, limit)).fetchall()
            # Preserve observed close captures even if weekend/overnight polling fills the recent window.
            closes = db.execute("""SELECT frame FROM captures WHERE symbol=?
                AND julianday(json_extract(frame, '$.sessionClose'))-julianday(at) BETWEEN 0 AND 90.0/86400
                ORDER BY at""", (symbol,)).fetchall()
        frames = {f['collectedAt']: f for row in [*closes, *rows] if (f := json.loads(row[0]))}
        return [frames[key] for key in sorted(frames)]

    def latest(self, symbol):
        with self.lock, closing(self.connect()) as db:
            row=db.execute('SELECT frame FROM captures WHERE symbol=? ORDER BY at DESC LIMIT 1',(symbol,)).fetchone()
        return json.loads(row[0]) if row else None

    def latest_price(self,symbol):
        with self.lock, closing(self.connect()) as db:
            row=db.execute('SELECT meta FROM price_meta WHERE symbol=?',(symbol,)).fetchone()
            bars=db.execute('SELECT bar FROM price_bars WHERE symbol=? ORDER BY at DESC LIMIT 1000',(symbol,)).fetchall()
        if not row:return None
        return {**json.loads(row[0]),'bars':[json.loads(b[0]) for b in reversed(bars)]}

    def window(self, symbol, start, end, bucket_minutes=5, recent_minutes=40, include_closes=True, full=False):
        """Only actual captures; one last capture per older chart bucket plus all recent Velocity inputs."""
        if bucket_minutes not in (1,2,5,15) or not start or not end or start>end:
            raise ValueError('Invalid history window')
        newest=datetime.fromisoformat(end.replace('Z','+00:00'))
        recent=(newest-timedelta(minutes=recent_minutes)).isoformat()
        with self.lock, closing(self.connect()) as db:
            rows=db.execute('''SELECT frame FROM captures WHERE symbol=? AND at IN (
                SELECT MAX(at) FROM captures WHERE symbol=? AND at>=? AND at<=?
                GROUP BY CAST(strftime('%s',at)/(?*60) AS INTEGER))
                UNION SELECT frame FROM captures WHERE symbol=? AND at>=? AND at<=?''',
                (symbol,symbol,start,end,bucket_minutes,symbol,recent,end)).fetchall()
            if include_closes:
                closes=db.execute('''SELECT frame FROM captures WHERE symbol=? AND
                    julianday(json_extract(frame,'$.sessionClose'))-julianday(at) BETWEEN 0 AND 90.0/86400
                    ORDER BY at''',(symbol,)).fetchall()
                rows.extend(closes)
        frames={f['collectedAt']:f for row in rows if (f:=json.loads(row[0]))}
        result=[]
        for key in sorted(frames):
            frame=frames[key]
            if not full and frame['collectedAt']>=start and frame['collectedAt']<=end:
                # Cone needs full quotes only for previous-close anchors and explicit Replay fetches.
                frame={k:v for k,v in frame.items() if k!='price'}
                frame['cells']=[{k:v for k,v in cell.items() if not k.endswith('Quote')} for cell in frame.get('cells',[])]
            result.append(frame)
        return result

    def save_price(self, symbol, bars, meta):
        with self.lock, closing(self.connect()) as db, db:
            db.executemany('INSERT OR REPLACE INTO price_bars VALUES (?,?,?)',
                           [(symbol,b['at'],json.dumps(b,allow_nan=False)) for b in bars])
            db.execute('INSERT OR REPLACE INTO price_meta VALUES (?,?)',(symbol,json.dumps(meta,allow_nan=False)))
            cutoff=(datetime.now(timezone.utc)-timedelta(days=10)).isoformat(timespec='seconds')
            db.execute('DELETE FROM price_bars WHERE at < ?',(cutoff,))

    def price_history(self, symbol, start=None, end=None):
        with self.lock, closing(self.connect()) as db:
            bars=db.execute('SELECT bar FROM price_bars WHERE symbol=? AND at>=? AND at<=? ORDER BY at',
                (symbol,start or '',end or '9999')).fetchall()
            row=db.execute('SELECT meta FROM price_meta WHERE symbol=?',(symbol,)).fetchone()
        return {**(json.loads(row[0]) if row else {'symbol':symbol,'barMinutes':1,'source':'OpenD'}),
                'bars':[json.loads(b[0]) for b in bars]}
