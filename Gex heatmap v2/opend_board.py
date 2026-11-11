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
from datetime import date
from market import symbol_code
from relay import OpenDFeed, SnapshotManager
from providers import tempest_payload

LOOPBACK = '127.0.0.1'
WEB_PORT = 8766
PRIVATE_ORIGIN = 'https://opend-gex-board.super-fir-5013.chatgpt.site'
VERSION = '2026-11-10-replay-validation-v2'
def source_revision():
    root=Path(__file__).resolve().parent
    return hashlib.sha256(b''.join((root/name).read_bytes() for name in
        ['opend_board.py','relay.py','market.py','providers.py','snapshots.py'])).hexdigest()[:16]

LOADED_REVISION=source_revision()


def handler(feed, origin, web_port=WEB_PORT, manager=None):
    class Handler(SimpleHTTPRequestHandler):
        def json_response(self, result, code=200, store_ms=None):
            started=monotonic()
            body = json.dumps(result, allow_nan=False).encode('utf-8')
            encoded=(len(body)>4096 and 'gzip' in self.headers.get('Accept-Encoding','').lower())
            if encoded:body=gzip.compress(body,compresslevel=1)
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
            if self.headers.get('Host') != f'{LOOPBACK}:{web_port}' or not self.allowed():
                return self.json_response({'error': 'Origin or Host denied'}, 403)
            self.send_response(204)
            self.cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.end_headers()

        def do_GET(self):
            if self.headers.get('Host') != f'{LOOPBACK}:{web_port}' or not self.allowed():
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
                        requested_day=query.get('date',[None])[0]
                        if requested_day:date.fromisoformat(requested_day)
                        start=query.get('from',[None])[0];end=query.get('to',[None])[0]
                        if start or end:
                            if not start or not end:raise ValueError('History range needs from and to')
                            from datetime import datetime
                            for value in [start,end]:
                                if datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None:raise ValueError('History range needs timezone')
                            frames=feed.store.window(symbol,start,end,int(query.get('bucket',['5'])[0]),
                                full=query.get('full',['0'])[0]=='1')
                        else:frames=feed.store.history(symbol,day=requested_day)
                        return self.json_response({'symbol': symbol, 'frames':frames},store_ms=(monotonic()-started)*1000)
                    if path.path == '/api/price':
                        return self.json_response(manager.request_price(symbol) if manager else feed.price(symbol))
                    if path.path == '/api/snapshot':
                        return self.json_response(manager.request(symbol) if manager else feed.collect(symbol))
                    if path.path == '/api/refresh':
                        return self.json_response(manager.request(symbol,force=True) if manager else feed.collect(symbol))
                    return self.json_response({'error': 'Unknown API'}, 404)
                except ValueError as error:
                    return self.json_response({'error': str(error),'category':'INVALID_CODE'}, 400)
                except (RuntimeError, OSError) as error:
                    message=str(error)
                    category='TIMEOUT' if isinstance(error,TimeoutError) or 'timeout' in message.lower() else 'INVALID_CODE' if any(x in message.lower() for x in ['未知股票','unknown stock','unknown security','invalid stock']) else 'PERMISSION' if any(x in message.lower() for x in ['权限','permission','entitlement']) else 'NO_OPTIONS' if '期权链' in message else 'UNAVAILABLE'
                    print(json.dumps({'event':'request-error','path':path.path,'symbol':symbol,'error':message,'seconds':round(monotonic()-started,3)},ensure_ascii=True),flush=True)
                    return self.json_response({'error':message,'category':category}, 504 if category=='TIMEOUT' else 400 if category=='INVALID_CODE' else 502)
            assets = {'/', '/index.html', '/app.js', '/model.js', '/chart.js', '/replay.js', '/tools.js','/expected.js','/gex-export.js','/style.css',
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


def main():
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
    feed = OpenDFeed(args.opend_port)
    manager=SnapshotManager(feed)
    with ThreadingHTTPServer((LOOPBACK, args.web_port), partial(handler(feed, args.origin, args.web_port, manager), directory=str(args.web))) as server:
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
