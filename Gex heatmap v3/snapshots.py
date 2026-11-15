"""Finite local-only history. Missing collection periods are never synthesized."""
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from spx_calibration import calibration_reference, advance_basis
from strike_history import hover_payload
from math import isfinite
from zero_gamma import zero_gamma


class SnapshotStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        self.zero_lock,self.zero_cache=Lock(),{}
        with closing(self.connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS captures (symbol TEXT, at TEXT, frame TEXT, PRIMARY KEY(symbol, at))')
            db.execute("CREATE INDEX IF NOT EXISTS captures_close_idx ON captures(symbol, (julianday(json_extract(frame, '$.sessionClose'))-julianday(at)))")
            db.execute('CREATE TABLE IF NOT EXISTS price_bars (symbol TEXT, at TEXT, bar TEXT, PRIMARY KEY(symbol,at))')
            db.execute('CREATE TABLE IF NOT EXISTS price_meta (symbol TEXT PRIMARY KEY, meta TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS close_archives (symbol TEXT, day TEXT, at TEXT, frame TEXT, PRIMARY KEY(symbol,day))')
            db.execute('CREATE TABLE IF NOT EXISTS spx_basis_states (day TEXT PRIMARY KEY, state TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS spx_basis_anchors (at TEXT PRIMARY KEY, anchor TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS strike_samples (symbol TEXT, day TEXT, expiry TEXT, strike REAL, at INTEGER, net REAL, PRIMARY KEY(symbol,expiry,strike,at))')
            db.execute('CREATE INDEX IF NOT EXISTS strike_samples_lookup ON strike_samples(symbol,day,strike,expiry,at)')
            db.execute('CREATE INDEX IF NOT EXISTS strike_samples_retention ON strike_samples(at)')
            db.execute('CREATE TABLE IF NOT EXISTS strike_backfill (symbol TEXT, day TEXT, through TEXT, PRIMARY KEY(symbol,day))')
            db.execute('CREATE TABLE IF NOT EXISTS strike_indexed_captures (symbol TEXT, at TEXT, PRIMARY KEY(symbol,at))')
            db.execute("CREATE INDEX IF NOT EXISTS captures_day_idx ON captures(symbol,json_extract(frame,'$.sessionDate'),at)")

    def index_strikes(self, db, frame):
        if db.execute('SELECT 1 FROM strike_indexed_captures WHERE symbol=? AND at=?',(frame['symbol'],frame['collectedAt'])).fetchone():return
        at=int(datetime.fromisoformat(frame['collectedAt'].replace('Z','+00:00')).timestamp()*1000)
        if frame.get('optionLastAt'):
            at=max(at,int(datetime.fromisoformat(frame['optionLastAt'].replace('Z','+00:00')).timestamp()*1000))
        rows=[]
        for cell in frame.get('cells',[]):
            c,p,k=cell.get('call'),cell.get('put'),cell.get('strike')
            if cell.get('complete') is False or not all(isinstance(v,(int,float)) and isfinite(v) for v in (c,p,k)):continue
            rows.append((frame['symbol'],frame.get('sessionDate',frame['collectedAt'][:10]),cell['expiry'],k,at,c+p))
        db.executemany('INSERT OR IGNORE INTO strike_samples VALUES (?,?,?,?,?,?)',rows)
        db.execute('INSERT OR IGNORE INTO strike_indexed_captures VALUES (?,?)',(frame['symbol'],frame['collectedAt']))

    def strike_history(self,symbol,expiries,strike,day,asof):
        expiries=sorted(set(expiries))
        if not expiries or len(expiries)>12 or not isfinite(strike) or strike<=0:raise ValueError('Invalid strike or expiry selection')
        date=datetime.fromisoformat(day).date()
        cutoff=datetime.fromisoformat(asof.replace('Z','+00:00'))
        if cutoff.tzinfo is None:raise ValueError('Strike history cutoff needs timezone')
        limit=int(cutoff.timestamp()*1000)
        with self.lock,closing(self.connect()) as db,db:
            progress=db.execute('SELECT through FROM strike_backfill WHERE symbol=? AND day=?',(symbol,day)).fetchone()
            rows=db.execute("SELECT at,frame FROM captures WHERE symbol=? AND json_extract(frame,'$.sessionDate')=? AND at>? AND NOT EXISTS(SELECT 1 FROM strike_indexed_captures i WHERE i.symbol=captures.symbol AND i.at=captures.at) ORDER BY at",(symbol,day,progress[0] if progress else ''))
            through=None
            for at,payload in rows:self.index_strikes(db,json.loads(payload));through=at
            if through:db.execute('INSERT OR REPLACE INTO strike_backfill VALUES (?,?,?)',(symbol,day,through))
            placeholders=','.join('?' for _ in expiries)
            values=db.execute(f'''SELECT at,SUM(net) FROM strike_samples
                WHERE symbol=? AND day=? AND strike=? AND expiry IN ({placeholders}) AND at<=?
                GROUP BY at HAVING COUNT(DISTINCT expiry)=? ORDER BY at''',
                [symbol,day,strike,*expiries,limit,len(expiries)]).fetchall()
        return hover_payload(symbol,expiries,strike,day,limit,values)

    def basis_day(self, db, day):
        saved=db.execute('SELECT state FROM spx_basis_states WHERE day=?',(day,)).fetchone()
        state=json.loads(saved[0]) if saved else {}
        rows=db.execute("SELECT frame FROM captures WHERE symbol='SPXW' AND json_extract(frame,'$.sessionDate')=? AND at>? ORDER BY at",(day,state.get('processedAt',''))).fetchall()
        if not rows:return
        bars=[json.loads(r[0]) for r in db.execute("SELECT bar FROM price_bars WHERE symbol='SPY' AND at>=? AND at<? ORDER BY at",(day, (datetime.fromisoformat(day)+timedelta(days=2)).date().isoformat()))]
        for row in rows:
            frame=json.loads(row[0]);state=advance_basis(frame,bars,state)
            db.execute('INSERT OR REPLACE INTO spx_basis_anchors VALUES (?,?)',(frame['collectedAt'],json.dumps(state.get('anchor'))))
        db.execute('INSERT OR REPLACE INTO spx_basis_states VALUES (?,?)',(day,json.dumps(state,allow_nan=False)))

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def zero_gamma(self,symbol,expiries,asof,capture=None):
        cutoff=datetime.fromisoformat(asof.replace('Z','+00:00'))
        if cutoff.tzinfo is None:raise ValueError('Zero Gamma cutoff needs timezone')
        if capture:
            captured=datetime.fromisoformat(capture.replace('Z','+00:00'))
            if captured.tzinfo is None or captured>cutoff:raise ValueError('Capture is after cutoff or lacks timezone')
        with closing(self.connect()) as db:
            if capture:row=db.execute('SELECT frame FROM captures WHERE symbol=? AND at=?',(symbol,capture)).fetchone()
            else:row=db.execute('SELECT frame FROM captures WHERE symbol=? AND at<=? ORDER BY at DESC LIMIT 1',
                (symbol,cutoff.astimezone(timezone.utc).isoformat(timespec='seconds'))).fetchone()
        if not row:return {'available':False,'reason':'没有该截止时刻之前的完整期权快照','asof':asof,'roots':[]}
        frame=json.loads(row[0]);key=(symbol,frame['collectedAt'],tuple(sorted(set(expiries))),asof)
        with self.zero_lock:
            if key not in self.zero_cache:
                self.zero_cache[key]=zero_gamma(frame,expiries,asof)
                if len(self.zero_cache)>64:self.zero_cache.pop(next(iter(self.zero_cache)))
            return self.zero_cache[key]

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
            self.index_strikes(db,frame)
            if frame['symbol']=='SPXW':
                self.basis_day(db,frame['sessionDate'])
                row=db.execute('SELECT anchor FROM spx_basis_anchors WHERE at=?',(frame['collectedAt'],)).fetchone()
                if row:frame['basisAnchor']=json.loads(row[0])
            close=datetime.fromisoformat(frame['sessionClose'].replace('Z','+00:00')) if frame.get('sessionClose') else None
            captured=datetime.fromisoformat(frame['collectedAt'].replace('Z','+00:00'))
            if close and 0 <= (close-captured).total_seconds() <= 300:
                # Calendar close handles DST and half days. Preserve original
                # quotes and provenance; this is never promoted to cash SPX.
                archived={**compact,'archiveKind':'pre-close observed snapshot','archivedAt':frame['collectedAt']}
                db.execute('INSERT INTO close_archives VALUES (?,?,?,?) ON CONFLICT(symbol,day) DO UPDATE SET at=excluded.at,frame=excluded.frame WHERE excluded.at>close_archives.at',
                    (frame['symbol'],frame['sessionDate'],frame['collectedAt'],json.dumps(archived,allow_nan=False)))
            cutoff = (datetime.now(timezone.utc)-timedelta(days=10)).isoformat(timespec='seconds')
            db.execute('DELETE FROM captures WHERE at < ?', (cutoff,))
            db.execute('DELETE FROM strike_samples WHERE at < ?',(int((datetime.now(timezone.utc)-timedelta(days=10)).timestamp()*1000),))

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
            closes += db.execute('SELECT frame FROM close_archives WHERE symbol=? ORDER BY day DESC LIMIT 252',(symbol,)).fetchall()
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
                rows.extend(db.execute('SELECT frame FROM close_archives WHERE symbol=? AND at<=? ORDER BY day DESC LIMIT 2',(symbol,end)).fetchall())
        frames={f['collectedAt']:f for row in rows if (f:=json.loads(row[0]))}
        basis_history=[]
        if symbol=='SPXW':
            with self.lock, closing(self.connect()) as db, db:
                for day in sorted({f['sessionDate'] for f in frames.values()}):
                    self.basis_day(db,day)
                    basis_history.extend(json.loads(r[0]) for r in db.execute("SELECT DISTINCT anchor FROM spx_basis_anchors WHERE json_extract(anchor,'$.day')=? AND julianday(json_extract(anchor,'$.at'))<=julianday(?)",(day,end)) if r[0]!='null')
                for at,frame in frames.items():
                    row=db.execute('SELECT anchor FROM spx_basis_anchors WHERE at=?',(at,)).fetchone()
                    frame['basisAnchor']=json.loads(row[0]) if row else None
        result=[]
        for key in sorted(frames):
            frame=frames[key]
            if symbol == 'SPXW' and 'calibration' not in frame:
                # Reconstruct only from quotes actually saved in this capture.
                frame['calibration'] = calibration_reference(frame.get('cells', []),frame['collectedAt'],
                    (frame.get('price') or {}).get('sessions', {}))
            if not full and frame['collectedAt']>=start and frame['collectedAt']<=end:
                # Cone needs full quotes only for previous-close anchors and explicit Replay fetches.
                frame={k:v for k,v in frame.items() if k!='price'}
                frame['cells']=[{k:v for k,v in cell.items() if not k.endswith('Quote')} for cell in frame.get('cells',[])]
            result.append(frame)
        if result and basis_history:result[0]['basisHistory']=basis_history
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
