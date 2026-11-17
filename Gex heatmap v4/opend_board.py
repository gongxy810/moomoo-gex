"""Read-only localhost OpenD GEX Board; never binds to public interfaces."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
from urllib.parse import parse_qs, urlsplit
import webbrowser
from time import monotonic
import os
import hashlib
import gzip
import faulthandler
import signal
from datetime import date,datetime
from zoneinfo import ZoneInfo
from contextlib import closing
from threading import Lock
from market import symbol_code
from relay import OpenDFeed, SnapshotManager
from providers import tempest_payload
from cloud_analysis import CloudAnalysis

LOOPBACK = '127.0.0.1'
WEB_PORT = 8766
PRIVATE_ORIGIN = 'https://opend-gex-board.super-fir-5013.chatgpt.site'
VERSION = '2026-11-16-live-expiry-refresh-v1'
def source_revision():
    root=Path(__file__).resolve().parent
    return hashlib.sha256(b''.join((root/name).read_bytes() for name in
        ['opend_board.py','relay.py','market.py','providers.py','snapshots.py','spx_calibration.py','strike_history.py','exposures.py','zero_gamma.py','cloud_analysis.py'])).hexdigest()[:16]

LOADED_REVISION=source_revision()


def handler(feed, origin, web_port=WEB_PORT, manager=None):
    analysis=CloudAnalysis(feed.store)
    response_cache={};response_lock=Lock()
    allowed_hosts={f'{LOOPBACK}:{web_port}',urlsplit(origin).netloc}
    class Handler(SimpleHTTPRequestHandler):
        def json_response(self, result, code=200, store_ms=None, cache_key=None):
            started=monotonic()
            accepts_gzip='gzip' in self.headers.get('Accept-Encoding','').lower()
            key=(cache_key,accepts_gzip)
            def encode():
                body=json.dumps(result,allow_nan=False).encode('utf-8')
                encoded=len(body)>4096 and accepts_gzip
                return (gzip.compress(body,compresslevel=1) if encoded else body),encoded
            if cache_key:
                with response_lock:
                    if key not in response_cache:
                        response_cache[key]=encode()
                        while len(response_cache)>32:response_cache.pop(next(iter(response_cache)))
                    body,encoded=response_cache[key]
            else:body,encoded=encode()
            self.send_response(code)
            self.cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            if encoded:self.send_header('Content-Encoding','gzip')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            timings=f'json;dur={(monotonic()-started)*1000:.1f}'
            if store_ms is not None:timings=f'store;dur={store_ms:.1f}, '+timings
            self.send_header('Server-Timing',timings)
            try:
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def end_headers(self):
            self.send_header('X-GEX-Version',VERSION)
            if not self.path.startswith('/api/'):
                self.send_header('Cache-Control','no-store')
            super().end_headers()

        def cors(self):
            if origin and self.headers.get('Origin') == origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Private-Network', 'true')

        def allowed(self):
            return self.headers.get('Origin') in {None, f'http://{LOOPBACK}:{web_port}', origin}

        def do_OPTIONS(self):
            if self.headers.get('Host') not in allowed_hosts or not self.allowed():
                return self.json_response({'error': 'Origin or Host denied'}, 403)
            self.send_response(204)
            self.cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.end_headers()

        def do_GET(self):
            if self.headers.get('Host') not in allowed_hosts or not self.allowed():
                return self.json_response({'error': 'Origin or Host denied'}, 403)
            path = urlsplit(self.path)
            if path.path.startswith('/api/'):
                if path.path == '/api/health':
                    try:
                        with socket.create_connection((LOOPBACK, feed.port), timeout=1):
                            pass
                        reachable = True
                    except OSError:
                        reachable = False
                    return self.json_response({'relay': True, 'openDPort': reachable,'version':VERSION,
                                               'pid':os.getpid(),'webRoot':str(Path(self.directory).resolve()),
                                               'loadedRevision':LOADED_REVISION,'currentOnDisk':LOADED_REVISION==source_revision()})
                try:
                    symbol, _ = symbol_code(parse_qs(path.query).get('symbol', [''])[0])
                    started=monotonic()
                    print(json.dumps({'event':'request-start','path':path.path,'symbol':symbol}),flush=True)
                    if path.path == '/api/term':
                        expiry=parse_qs(path.query).get('expiry',[''])[0]
                        date.fromisoformat(expiry)
                        if expiry<datetime.now(ZoneInfo('America/New_York')).date().isoformat():
                            raise ValueError('Term capture requires a current or future expiry')
                        return self.json_response(manager.request_term(symbol,expiry))
                    if path.path == '/api/watchlist':
                        quotes={}
                        with closing(feed.store.connect()) as db:
                            for key,raw in db.execute('SELECT symbol,meta FROM price_meta'):
                                meta=json.loads(raw)
                                quotes[key]={k:meta.get(k) for k in ('spot','previousClose','previousCloseDate','priceSymbol')}
                            for key,raw in db.execute('SELECT symbol,frame FROM captures WHERE (symbol,at) IN (SELECT symbol,MAX(at) FROM captures GROUP BY symbol)'):
                                if not quotes.get(key,{}).get('spot'):
                                    f=json.loads(raw);quotes[key]={k:f.get(k) for k in ('spot','previousClose','previousCloseDate','priceSymbol')}
                        if manager:
                            # Re-evaluate timestamps at request time. Saved quote
                            # metadata must never stay labeled live after a close.
                            for key in tuple(quotes):
                                latest=manager.peek_price(key,quotes[key])
                                if latest:
                                    quotes[key]={k:latest.get(k) for k in ('spot','previousClose','previousCloseDate','priceSymbol')}
                        cash=quotes.get('SPXW',{})
                        quotes['SPX']=cash if cash.get('priceSymbol')=='SPX' and cash.get('spot') and not cash['spot'].get('estimated') and cash['spot'].get('source','').find('option')<0 else {}
                        return self.json_response({'quotes':quotes})
                    if path.path == '/api/replay-frame':
                        q=parse_qs(path.query);cutoff=datetime.fromisoformat(q['asof'][0].replace('Z','+00:00'))
                        if cutoff.tzinfo is None:raise ValueError('Replay cutoff needs timezone')
                        day=cutoff.astimezone(ZoneInfo('America/New_York')).date().isoformat()
                        with closing(feed.store.connect()) as db:
                            row=db.execute("SELECT frame FROM captures WHERE symbol=? AND json_extract(frame,'$.sessionDate')=? AND julianday(at)<=julianday(?) AND julianday(COALESCE(json_extract(frame,'$.optionLastAt'),at))<=julianday(?) ORDER BY at DESC LIMIT 1",(symbol,day,q['asof'][0],q['asof'][0])).fetchone()
                        frame=json.loads(row[0]) if row else None
                        if frame:frame.pop('price',None);frame.pop('bars',None)
                        return self.json_response({'frame':frame,'asof':q['asof'][0]})
                    if path.path == '/api/analysis':
                        q=parse_qs(path.query);dates=q.get('expiries',[''])[0].split(',')
                        if len(dates)>12:raise ValueError('Too many expiries')
                        for expiry in dates:date.fromisoformat(expiry)
                        return self.json_response(analysis.request(symbol,dates,q['asof'][0],q['capture'][0],q.get('metric',['GEX'])[0],int(q.get('minutes',['5'])[0]),int(q.get('top',['5'])[0]),float(q.get('threshold',['10'])[0]),q.get('session',['ALL'])[0],q.get('scope',['chart'])[0],q.get('replay',['0'])[0]=='1',q.get('client',['default'])[0]))
                    if path.path == '/api/zero-gamma':
                        query=parse_qs(path.query);expiries=query.get('expiries',[''])[0].split(',')
                        if len(expiries)>12:raise ValueError('Too many expiries')
                        for expiry in expiries:date.fromisoformat(expiry)
                        result=feed.store.zero_gamma(symbol,expiries,query.get('asof',[''])[0],query.get('capture',[None])[0])
                        return self.json_response(result,store_ms=(monotonic()-started)*1000)
                    if path.path == '/api/strike-history':
                        query=parse_qs(path.query)
                        dates=query.get('expiries',[''])[0].split(',')
                        for value in dates:date.fromisoformat(value)
                        result=feed.store.strike_history(symbol,dates,float(query.get('strike',['nan'])[0]),
                            query.get('date',[''])[0],query.get('asof',[''])[0],query.get('metric',['GEX'])[0])
                        return self.json_response(result,store_ms=(monotonic()-started)*1000)
                    if path.path == '/api/validate':
                        result=feed.validate(symbol)
                        print(json.dumps({'event':'validate-complete','symbol':symbol,'seconds':round(monotonic()-started,3)}),flush=True)
                        return self.json_response(result)
                    if path.path == '/api/price-history':
                        query=parse_qs(path.query)
                        result=feed.store.price_history(symbol,query.get('from',[None])[0],query.get('to',[None])[0])
                        return self.json_response(result,store_ms=(monotonic()-started)*1000)
                    if path.path == '/api/expected-provider':
                        return self.json_response(tempest_payload(symbol))
                    if path.path == '/api/history':
                        query=parse_qs(path.query)
                        raw_history=query.get('raw',['0'])[0]=='1'
                        requested_day=query.get('date',[None])[0]
                        if requested_day:date.fromisoformat(requested_day)
                        start=query.get('from',[None])[0];end=query.get('to',[None])[0]
                        if start or end:
                            if not start or not end:raise ValueError('History range needs from and to')
                            for value in [start,end]:
                                if datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None:raise ValueError('History range needs timezone')
                            frames=feed.store.window(symbol,start,end,int(query.get('bucket',['5'])[0]),
                                full=query.get('full',['0'])[0]=='1',metadata=os.environ.get('GEX_CLOUD')=='1' and not raw_history)
                        else:frames=feed.store.history(symbol,day=requested_day)
                        if os.environ.get('GEX_CLOUD')=='1' and not raw_history:
                            for f in frames:
                                if f is not frames[-1] and not (0<=(datetime.fromisoformat(f['sessionClose'].replace('Z','+00:00'))-datetime.fromisoformat(f['collectedAt'].replace('Z','+00:00'))).total_seconds()<=90):
                                    f['cells']=[];f['cloudMeta']=True
                                f.pop('listedStrikes',None);f.pop('price',None)
                        return self.json_response({'symbol': symbol, 'frames':frames},store_ms=(monotonic()-started)*1000)
                    if path.path == '/api/price':
                        result=manager.request_price(symbol) if manager else feed.price(symbol)
                        if os.environ.get('GEX_CLOUD')=='1':result={**result,'bars':result.get('bars',[])[-3:]}
                        last=(result.get('bars') or [{}])[-1]
                        return self.json_response(result,cache_key=('price',symbol,result.get('collectedAt'),len(result.get('bars',[])),(result.get('bars') or [{}])[0].get('at'),(result.get('spot') or {}).get('at'),(result.get('spot') or {}).get('value'),last.get('at'),last.get('h'),last.get('l'),last.get('c'),json.dumps(result.get('service',{}),sort_keys=True)))
                    if path.path in ('/api/snapshot','/api/refresh'):
                        force=path.path=='/api/refresh'
                        expiry=parse_qs(path.query).get('expiry',[None])[0]
                        if expiry:
                            date.fromisoformat(expiry)
                            if expiry < datetime.now(ZoneInfo('America/New_York')).date().isoformat():
                                raise ValueError('Expired option chains require recorded Replay history')
                            with feed.expiry_lock:
                                changed=feed.requested_expiries.get(symbol)!=expiry
                                feed.requested_expiries[symbol]=expiry
                            force=force or changed
                        result=manager.request(symbol,force=force) if manager else feed.collect(symbol,force=force)
                        since=parse_qs(path.query).get('since',[None])[0]
                        if since and result.get('collectedAt')==since:
                            return self.json_response({'source':'opend','symbol':symbol,'status':'unchanged',
                                'collectedAt':since,'service':result.get('service',{})})
                        if os.environ.get('GEX_CLOUD')=='1':
                            result={k:v for k,v in result.items() if k!='bars'}
                            if result.get('price'):result['price']={**result['price'],'bars':result['price'].get('bars',[])[-3:]}
                        return self.json_response(result,cache_key=('snapshot',symbol,result.get('collectedAt'),json.dumps(result.get('service',{}),sort_keys=True)))
                    return self.json_response({'error': 'Unknown API'}, 404)
                except ValueError as error:
                    return self.json_response({'error': str(error),'category':'INVALID_CODE'}, 400)
                except (RuntimeError, OSError) as error:
                    message=str(error)
                    category='TIMEOUT' if isinstance(error,TimeoutError) or any(x in message.lower() for x in ['timeout','timed out','超时']) else 'INVALID_CODE' if any(x in message.lower() for x in ['未知股票','unknown stock','unknown security','invalid stock']) else 'PERMISSION' if any(x in message.lower() for x in ['权限','permission','entitlement']) else 'NO_OPTIONS' if '期权链' in message else 'UNAVAILABLE'
                    print(json.dumps({'event':'request-error','path':path.path,'symbol':symbol,'error':message,'seconds':round(monotonic()-started,3)},ensure_ascii=True),flush=True)
                    return self.json_response({'error':message,'category':category}, 504 if category=='TIMEOUT' else 400 if category=='INVALID_CODE' else 502)
            assets = {'/', '/index.html', '/app.js', '/model.js', '/chart.js', '/replay.js', '/spx-proxy.js', '/tools.js','/expected.js','/gex-export.js','/style.css','/structure.js','/v3-ui.js','/cloud-client.js','/symbol-list.js',
                      '/vendor/lightweight-charts.standalone.production.js', '/vendor/NOTICE', '/vendor/LICENSE',
                      '/opend-gex-relay.zip'}
            if path.path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            if path.path not in assets:
                return self.send_error(404)
            return super().do_GET()

        def log_message(self, fmt, *args):
            if len(args)>1 and str(args[1]) not in {'200', '204', '304'}:
                super().log_message(fmt, *args)
    return Handler


class BoardHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        if os.name == 'nt':
            self.allow_reuse_address=False
            self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        super().server_bind()


def main():
    if hasattr(signal,'SIGUSR1'):
        faulthandler.register(signal.SIGUSR1, all_threads=True)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--opend-port', type=int, default=11111)
    parser.add_argument('--web-port', type=int, default=WEB_PORT)
    parser.add_argument('--origin', default=PRIVATE_ORIGIN)
    parser.add_argument('--web', type=Path, default=Path(__file__).resolve().parent/'web')
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    parsed = urlsplit(args.origin)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
        parser.error('--origin requires an exact HTTPS origin')
    # Bind before starting any collector threads. A second launch must exit
    # cleanly instead of leaving collectors alive after a port-in-use error.
    try:
        server=BoardHTTPServer((LOOPBACK, args.web_port), SimpleHTTPRequestHandler)
    except OSError as error:
        parser.exit(1, f'Cannot start board on {LOOPBACK}:{args.web_port}: {error}\n'
                    'Close the existing board command window before starting the updated version.\n')
    with server:
        feed = OpenDFeed(args.opend_port)
        manager=SnapshotManager(feed)
        server.RequestHandlerClass=partial(handler(feed, args.origin, args.web_port, manager), directory=str(args.web))
        print(f'OpenD GEX Board http://{LOOPBACK}:{args.web_port} · OpenD {args.opend_port}', flush=True)
        if args.open_browser:
            webbrowser.open(f'http://{LOOPBACK}:{args.web_port}')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            manager.close()
            if feed.ctx:
                feed.ctx.close()
            if feed.price_feed and feed.price_feed.ctx:
                feed.price_feed.ctx.close()
            if feed.validation_feed and feed.validation_feed.ctx:
                feed.validation_feed.ctx.close()


if __name__ == '__main__':
    main()
