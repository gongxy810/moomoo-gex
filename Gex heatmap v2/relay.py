"""Read-only OpenD price provider and option collector."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from threading import RLock, Lock, Thread
from concurrent.futures import ThreadPoolExecutor
from time import monotonic, sleep
import math
import re
import socket
import json
from market import Calendar, ET, iso, quote, stamp, symbol_code, verified_close
from snapshots import SnapshotStore
from providers import OpenDPriceProvider, RoutedPriceProvider

MODEL = 'OI-gamma-100-unadjusted-v1'
CAPTURE_VERSION = 'gex-collection-v1'
SNAPSHOT_INTERVAL = 1.0  # Official quota: 60 calls / 30s, <=400 codes; keep 50% call headroom.
SNAPSHOT_LOCK = Lock()
LAST_SNAPSHOT_AT = 0.0


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def positive(value):
    value = number(value)
    return value if value is not None and value > 0 else None


def cache_identity(frame):
    return {'symbol':frame.get('symbol'),'optionRoot':frame.get('optionRoot'),
            'dates':sorted({c['expiry'] for c in frame.get('cells',[]) if c.get('expiry')}),
            'model':frame.get('model'),'version':CAPTURE_VERSION}


def supplemental_close(path, symbol, day):
    """A dated, sourced observation; never carry one day's close into another."""
    if symbol != 'SPXW':
        return None
    try:
        rows = json.loads(Path(path).read_text(encoding='utf-8'))
        if not isinstance(rows, list):
            return None
        for row in rows:
            if (isinstance(row, dict) and row.get('symbol') == 'SPX' and row.get('date') == day and
                    positive(row.get('close')) and row.get('source') and row.get('url')):
                return row
    except (OSError, ValueError, TypeError):
        pass
    return None


def contracts_from_chain(symbol, rows):
    result = {}
    for row in rows:
        code = str(row.get('code', ''))
        side = str(row.get('option_type', '')).lower().split('.')[-1]
        expiry, strike = str(row.get('strike_time', ''))[:10], positive(row.get('strike_price'))
        if not strike or side not in {'call', 'put'} or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', expiry):
            continue
        if symbol == 'SPXW' and not re.match(r'^US\.\.?SPXW\d{6}[CP]', code, re.I):
            continue
        if str(row.get('option_standard_type', '')).replace('_', '').upper().endswith('NONSTANDARD'):
            continue
        result[code] = (expiry, strike, side)
    return result


def summarize(contracts, rows, spot):
    cells, times, seen = {}, [], set()
    usable = 0
    for row in rows:
        code = row.get('code')
        if code not in contracts or code in seen or not row.get('option_valid', True):
            continue
        seen.add(code)
        expiry, strike, side = contracts[code]
        cell = cells.setdefault((expiry, strike), {'expiry': expiry, 'strike': strike, 'call': None, 'put': None,
                    'callOi': None, 'putOi': None, 'callIv': None, 'putIv': None, 'validContracts': []})
        at = stamp(row.get('update_time'))
        if at:
            times.append(at)
        mult = positive(row.get('option_contract_multiplier')) or positive(row.get('option_contract_size'))
        oi, gamma = number(row.get('option_open_interest')), number(row.get('option_gamma'))
        iv = positive(row.get('option_implied_volatility'))
        if iv:
            cell[side+'Iv'] = iv/100
        # Retain the actual supplier inputs independently of GEX completeness.
        # SDK/Qot_GetSnapshot OptionSnapshotExData documents percent units.
        cell[side+'Quote'] = {
            'code':code,'side':side,'strike':strike,'expiry':expiry,
            'optionRoot':'SPXW' if re.match(r'^US\.\.?SPXW\d{6}[CP]',code,re.I) else re.sub(r'\d{6}[CP].*$', '',code),
            'bid':number(row.get('bid_price')),'ask':number(row.get('ask_price')),
            'ivRaw':iv,'iv':iv/100 if iv else None,'ivUnit':'fraction',
            'at':iso(at),'timestampKind':'OpenD snapshot update_time (not an independent IV timestamp)',
            'settlement':'PM' if re.match(r'^US\.\.?SPXW',code,re.I) else 'equity expiry / calendar RTH close',
            'multiplier':mult,'source':'OpenD get_market_snapshot'
        }
        if mult != 100 or oi is None or oi < 0 or not oi.is_integer() or gamma is None or gamma < 0:
            continue
        cell[side+'Oi'] = (cell[side+'Oi'] or 0) + oi
        amount = gamma * oi * mult * spot**2 * .01
        cell[side] = (cell[side] or 0) + (amount if side=='call' else -amount)
        cell['validContracts'].append(code)
        usable += 1
    for cell in cells.values():
        expected = sorted(c for c, spec in contracts.items() if spec[:2] == (cell['expiry'], cell['strike']))
        cell['contracts'] = expected
        cell['complete'] = expected == sorted(cell['validContracts'])
    return list(cells.values()), iso(min(times)) if times else None, iso(max(times)) if times else None, usable


def implied_reference(contracts, rows, now, calendar):
    pairs = {}
    for row in rows:
        spec = contracts.get(row.get('code'))
        bid, ask, at = positive(row.get('bid_price')), positive(row.get('ask_price')), stamp(row.get('update_time'))
        if not spec or not bid or not ask or not at or ask < bid or ask-bid > max(2, (ask+bid)*.125):
            continue
        if not -3 <= (now-at).total_seconds() <= 4*86400:
            continue
        expiry, strike, side = spec
        pairs.setdefault((expiry, strike), {})[side] = ((bid+ask)/2, at)
    readings = {}
    for (expiry, strike), sides in pairs.items():
        if not {'call', 'put'} <= sides.keys():
            continue
        call, ca = sides['call']; put, pa = sides['put']
        if abs((ca-pa).total_seconds()) <= 300:
            readings.setdefault(expiry, []).append((abs(call-put), strike+call-put, min(ca, pa)))
    for expiry, items in sorted(readings.items()):
        items = sorted(items)[:5]
        if len(items) < 3:
            continue
        prices = [item[1] for item in items]
        value = median(prices)
        if value <= 0 or max(prices)-min(prices) > value*.005:
            continue
        at = min(i[2] for i in items)
        same = at.astimezone(ET).date().isoformat() == calendar.session(now)
        return {'value': value, 'at': iso(at), 'phase': calendar.phase(at, True), 'status': 'REF', 'current': False,
                'source': 'SPXW call/put mids · K+C−P (rate omitted)', 'label': 'REF · option-implied forward',
                'estimated': True, 'comparable': same, 'referenceExpiry': expiry, 'delayed': True}
    raise RuntimeError('SPX 行情不可用，SPXW 配对报价也不足以计算参考值')


class OpenDFeed:
    def __init__(self, port=11111, store=None, spx_cash_provider=None, price_only=False):
        self.port, self.ctx, self.sdk = port, None, None
        self.cache, self.chains, self.price_cache, self.calendars, self.daily_cache = {}, {}, {}, {}, {}
        self.subscriptions, self.lock = set(), RLock()
        self.store = store or SnapshotStore(Path(__file__).parent/'data'/'captures.sqlite3')
        self.last_snapshot = 0
        self.price_feed = None if price_only else OpenDFeed(port,self.store,price_only=True)
        self.price_provider = RoutedPriceProvider(OpenDPriceProvider(self.price_feed or self), spx_cash_provider)
        self.validation_lock = Lock()
        self.validation_feed = None
        self.validation_cache = {}

    def connect(self):
        if self.ctx is None:
            started=monotonic()
            with socket.create_connection(('127.0.0.1', self.port), timeout=2):
                pass
            import moomoo
            self.sdk = moomoo
            self.ctx = moomoo.OpenQuoteContext(host='127.0.0.1', port=self.port)
            print(json.dumps({'event':'opend-connect','seconds':round(monotonic()-started,3),'role':'price' if self.price_feed is None else 'options'}),flush=True)

    def records(self, method, *args, **kwargs):
        for attempt in range(2):
            started = monotonic()
            try:
                result, data, *_ = method(*args, **kwargs)
            except (ConnectionError,OSError) as error:
                if attempt==0:
                    self.reconnect();method=getattr(self.ctx,method.__name__);continue
                raise RuntimeError(str(error)) from error
            print(json.dumps({'event':'sdk','method':method.__name__,'code':str(args[0])[:50] if args else None,
                              'seconds':round(monotonic()-started,3),'ok':result==self.sdk.RET_OK},ensure_ascii=True),flush=True)
            if result == self.sdk.RET_OK:
                return data.to_dict('records') if hasattr(data, 'to_dict') else data
            message = str(data)[:300]
            if attempt == 0 and any(w in message.lower() for w in ['frequency', '频率', 'too frequent']):
                sleep(3)
                continue
            if attempt==0 and any(w in message.lower() for w in ['disconnected','connection closed','broken pipe','连接断开','连接失败']):
                self.reconnect();method=getattr(self.ctx,method.__name__);continue
            raise RuntimeError(message)

    def reconnect(self):
        if self.ctx:
            try:self.ctx.close()
            except Exception:pass
        self.ctx=None;self.subscriptions.clear();self.connect()

    def validate(self, raw):
        """Separate SDK connection/lock. Never downloads a chain, Greeks or OHLC here."""
        symbol, code = symbol_code(raw)
        started = monotonic()
        if not self.validation_lock.acquire(timeout=5):
            raise TimeoutError('验证繁忙，请重试；其他列仍继续刷新')
        try:
            cached = self.validation_cache.get(symbol)
            if cached and monotonic()-cached[0] < 120:
                return {**cached[1], 'cached': True}
            if self.validation_feed is None:
                self.validation_feed = OpenDFeed(self.port, self.store)
            feed = self.validation_feed
            feed.connect()
            rows, warnings = [], []
            if symbol != 'SPXW':
                feed.subscribe(code, feed.sdk.SubType.QUOTE)
                rows = feed.records(feed.ctx.get_stock_quote, [code])
                if not rows:
                    raise ValueError('代码无法识别：'+code)
            else:
                warnings.append('价格 SPX / 期权 SPXW；现金指数权限独立检查')
            cached_chain = self.chains.get(symbol)
            if symbol=='SPXW' and cached_chain:
                dates = cached_chain[2]
            elif symbol=='SPXW' and self.store.history(symbol,1):
                dates = self.store.history(symbol,1)[-1].get('availableDates',[])
            else:
                dates = sorted({str(r['strike_time'])[:10] for r in feed.records(feed.ctx.get_option_expiration_date,code)})
            if not dates:
                raise RuntimeError('无期权链：'+code+' 没有可用期权到期日')
            row = rows[0] if rows else {}
            at = stamp(row.get('data_time')) or stamp(str(row.get('data_date',''))+' '+str(row.get('data_time','')))
            result = {'symbol':symbol,'code':code,'priceSymbol':'SPX' if symbol=='SPXW' else symbol,
                      'optionRoot':'SPXW' if symbol=='SPXW' else code,'name':str(row.get('name',symbol)),
                      'dates':dates,'warnings':warnings,'quote':{'value':positive(row.get('last_price')),'at':iso(at),
                      'source':'OpenD subscribed quote'},'seconds':round(monotonic()-started,3)}
            self.validation_cache[symbol] = (monotonic(),result)
            return result
        finally:
            self.validation_lock.release()

    def snapshots(self, codes):
        global LAST_SNAPSHOT_AT
        rows = []
        for offset in range(0, len(codes), 400):
            with SNAPSHOT_LOCK:
                wait = SNAPSHOT_INTERVAL-(monotonic()-LAST_SNAPSHOT_AT)
                if wait > 0:sleep(wait)
                rows.extend(self.records(self.ctx.get_market_snapshot, codes[offset:offset+400]))
                LAST_SNAPSHOT_AT = monotonic()
                self.last_snapshot = LAST_SNAPSHOT_AT
        return rows

    def calendar(self, code, now):
        if not code.startswith('US.'):
            raise RuntimeError('该市场尚未配置时段适配器：'+code.split('.')[0])
        day = now.astimezone(ET).date()
        key = (code.split('.')[0], str(day))
        if key not in self.calendars:
            rows = self.records(self.ctx.request_trading_days, market=self.sdk.TradeDateMarket.US,
                                start=str(day-timedelta(days=35)), end=str(day+timedelta(days=8)))
            self.calendars[key] = Calendar(rows)
        return self.calendars[key]

    def daily(self, code, now):
        day = now.astimezone(ET).date().isoformat()
        cached = self.daily_cache.get(code)
        if cached and cached[2]==day and monotonic()-cached[0] < 300:
            return cached[1]
        rows = self.records(self.ctx.request_history_kline, code,
                    start=str(now.astimezone(ET).date()-timedelta(days=35)), end=str(now.astimezone(ET).date()),
                    ktype=self.sdk.KLType.K_DAY, autype=self.sdk.AuType.NONE, max_count=60)
        self.daily_cache[code] = (monotonic(), rows, day)
        return rows

    def subscribe(self, code, subtype):
        key = (code, subtype)
        if key not in self.subscriptions:
            ret, message = self.ctx.subscribe([code], [subtype], subscribe_push=False, extended_time=True)
            if ret != self.sdk.RET_OK:
                raise RuntimeError(str(message))
            self.subscriptions.add(key)

    def spot(self, symbol, code, now, calendar, daily):
        rows = self.snapshots([code])
        ticks = []
        try:
            self.subscribe(code, self.sdk.SubType.TICKER)
            ticks = self.records(self.ctx.get_rt_ticker, code, num=100)
        except RuntimeError:
            pass
        return quote(symbol, rows[0] if rows else {}, ticks, now, calendar, daily)

    def price(self, raw):
        symbol, _ = symbol_code(raw)
        return self.price_provider.get(symbol)

    def _opend_price(self, raw):
        symbol, code = symbol_code(raw)
        cached=self.price_cache.get(symbol)
        if cached and monotonic()-cached[0]<15:
            return cached[1]
        queued=monotonic()
        with self.lock:
            pipeline={};stage=monotonic()
            print(json.dumps({'event':'price-lock','symbol':symbol,'queueSeconds':round(monotonic()-queued,3)}),flush=True)
            self.connect()
            pipeline['connect']=round(monotonic()-stage,3)
            cached = self.price_cache.get(symbol)
            if cached and monotonic()-cached[0] < 15:
                return cached[1]
            now = datetime.now(timezone.utc)
            stage=monotonic()
            calendar = self.calendar(code, now)
            pipeline['calendar']=round(monotonic()-stage,3)
            meta = calendar.payload(now)
            warnings, bars, daily, spot = [], [], [], None
            try:
                stage=monotonic()
                daily = self.daily(code, now)
            except RuntimeError as error:
                warnings.append('前收无法核验 · '+str(error))
            pipeline['daily']=round(monotonic()-stage,3)
            try:
                stage=monotonic()
                spot = self.spot(symbol, code, now, calendar, daily)
            except RuntimeError as error:
                warnings.append(str(error))
            pipeline['spot']=round(monotonic()-stage,3)
            try:
                stage=monotonic()
                self.subscribe(code, self.sdk.SubType.K_1M)
                raw_bars = self.records(self.ctx.get_cur_kline, code, 1000, ktype=self.sdk.KLType.K_1M, autype=self.sdk.AuType.NONE)
                for b in raw_bars:
                    at = stamp(b.get('time_key'))
                    values = [positive(b.get(key)) for key in ['open', 'high', 'low', 'close']]
                    if at and at <= now and all(values):
                        bars.append(dict(at=iso(at), o=values[0], h=values[1], l=values[2], c=values[3], phase=calendar.phase(at, symbol=='SPXW')))
            except RuntimeError as error:
                warnings.append('K 线不可用 · '+str(error))
            pipeline['bars']=round(monotonic()-stage,3)
            bars.sort(key=lambda b: b['at'])
            if spot is None and bars:
                last = bars[-1]
                spot = {'value': last['c'], 'at': last['at'], 'phase': last['phase'], 'status': 'REF',
                        'current': False, 'label': 'REF · OpenD cash candle close', 'source': 'OpenD cash 1m candle', 'comparable': False}
            if spot is None and daily:
                completed = [r for r in daily if calendar.close(str(r.get('time_key',''))[:10]) and
                             calendar.close(str(r['time_key'])[:10]) <= now and positive(r.get('close'))]
                if completed:
                    last = max(completed, key=lambda r: str(r['time_key']))
                    date = str(last['time_key'])[:10]
                    same = date == meta['sessionDate']
                    spot = {'value': float(last['close']), 'at': iso(calendar.close(date)), 'phase': 'RTH',
                            'status': 'Close' if same else 'REF', 'current': False, 'comparable': same,
                            'source': 'OpenD unadjusted daily close', 'label': 'Verified daily close' if same else 'REF · old daily close'}
            previous = verified_close(daily, meta['previousSession'])
            supplement = supplemental_close(Path(__file__).resolve().parent/'data'/'verified-index-closes.json', symbol, meta['previousSession']) if previous is None else None
            if supplement:
                previous = float(supplement['close'])
            result = {'symbol': symbol, 'priceSymbol': 'SPX' if symbol=='SPXW' else symbol, 'source': 'OpenD',
                      'collectedAt': iso(now), 'bars': bars, 'spot': spot, 'barMinutes': 1,
                      'quoteAt': spot['at'] if spot else None, 'barAt': bars[-1]['at'] if bars else None,
                      'delayed': spot.get('delayed', True) if spot else None, 'session': calendar.phase(now, symbol=='SPXW'),
                      'previousClose': spot.get('previousClose', previous) if spot else previous,
                      'previousCloseDate': spot.get('previousCloseDate', meta['previousSession']) if spot else meta['previousSession'],
                      'adjustment': 'NONE', 'warnings': warnings, **meta}
            if supplement:
                result['previousCloseSource'] = supplement['source']
                result['previousCloseUrl'] = supplement['url']
                result['previousCloseKind'] = 'verified cash index daily close'
            result['sessions'] = {d:iso(calendar.close(d)) for d in calendar.days}
            result['dailyCloses'] = [{'date':str(r.get('time_key',''))[:10],'close':positive(r.get('close'))} for r in daily]
            result['pipeline']={**pipeline,'queue':round(monotonic()-queued-sum(pipeline.values()),3)}
            self.store.save_price(symbol, bars, {k:v for k,v in result.items() if k!='bars'})
            self.price_cache[symbol] = (monotonic(), result)
            return result

    def chain(self, symbol, code, day):
        cached = self.chains.get(symbol)
        if cached and cached[3]==day and monotonic()-cached[0] < 300:
            return cached[1], cached[2]
        errors = []
        owners = [code, 'US.SPX', 'US.SPXW'] if symbol=='SPXW' else [code]
        for owner in dict.fromkeys(owners):
            try:
                rows = self.records(self.ctx.get_option_chain, owner, start=day,
                        end=str(datetime.fromisoformat(day).date()+timedelta(days=29)))
                contracts = contracts_from_chain(symbol, rows)
                if contracts:
                    dates = sorted({spec[0] for spec in contracts.values()})
                    # Some index servers support chain but time out on expiration listing.
                    # Never make that auxiliary endpoint a prerequisite for SPXW.
                    if symbol != 'SPXW':
                        try:
                            dates = sorted({str(r['strike_time'])[:10] for r in self.records(self.ctx.get_option_expiration_date, owner)})
                        except RuntimeError:
                            pass
                    self.chains[symbol] = (monotonic(), contracts, dates, day)
                    return contracts, dates
            except RuntimeError as error:
                errors.append(str(error))
        detail = ' | '.join(errors)
        if any(word in detail.lower() for word in ['未知股票', 'unknown stock', 'invalid stock', '不存在']):
            raise ValueError('代码无法识别 · '+detail)
        if any(word in detail.lower() for word in ['权限', 'permission', 'entitlement']):
            raise RuntimeError('缺行情权限 · '+detail)
        raise RuntimeError('该标的没有可用期权链 · '+detail)

    def collect(self, raw, force=False):
        symbol, code = symbol_code(raw)
        cached=self.cache.get(symbol)
        if not force and cached and monotonic()-cached[0]<30:
            return cached[1]
        queued=monotonic()
        with self.lock:
            pipeline={'queue':round(monotonic()-queued,3)};stage=monotonic()
            print(json.dumps({'event':'capture-lock','symbol':symbol,'queueSeconds':round(monotonic()-queued,3)}),flush=True)
            self.connect()
            pipeline['connect']=round(monotonic()-stage,3)
            cached = self.cache.get(symbol)
            if not force and cached and monotonic()-cached[0] < 30:
                return cached[1]
            start = datetime.now(timezone.utc)
            stage=monotonic()
            calendar = self.calendar(code, start)
            pipeline['calendar']=round(monotonic()-stage,3)
            day = calendar.session(start) or start.astimezone(ET).date().isoformat()
            stage=monotonic()
            chain, available = self.chain(symbol, code, day)
            pipeline['chain']=round(monotonic()-stage,3)
            stage=monotonic()
            price = self.price(symbol)
            pipeline['price']=round(monotonic()-stage,3)
            spot, warnings = price['spot'], list(price['warnings'])
            dates = sorted({spec[0] for spec in chain.values()})[:6]
            if spot is None and symbol=='SPXW':
                stage=monotonic()
                close = calendar.close(day)
                eligible = [d for d in dates if d > day or (d == day and close and start < close)]
                expiry = eligible[0] if eligible else dates[-1]
                all_strikes = sorted({s for e, s, _ in chain.values() if e==expiry})
                seed = median(all_strikes)
                try:
                    spy = self.price('SPY')['spot']
                    if spy:
                        seed = spy['value']*10  # Request locator only; NEVER exposed as SPX price.
                except RuntimeError:
                    pass
                strikes = set(sorted(all_strikes, key=lambda s: abs(s-seed))[:40])
                probes = {c: spec for c, spec in chain.items() if spec[0]==expiry and spec[1] in strikes}
                spot = implied_reference(probes, self.snapshots(list(probes)), datetime.now(timezone.utc), calendar)
                warnings.append('SPX 现金指数不可用；REF 为期权隐含远期，非真实指数行情')
                pipeline['reference']=round(monotonic()-stage,3)
            if spot is None:
                raise RuntimeError('缺少行情权限或有效参考价，无法计算 GEX')
            chosen = {}
            for expiry in dates:
                strikes = {s for e, s, _ in chain.values() if e==expiry}
                near = set(sorted(strikes, key=lambda s: (abs(s-spot['value']), s))[:60])
                chosen.update({c: spec for c, spec in chain.items() if spec[0]==expiry and spec[1] in near})
            rows = []
            stage=monotonic()
            for offset in range(0, len(chosen), 400):
                try:
                    rows.extend(self.snapshots(list(chosen)[offset:offset+400]))
                except RuntimeError as error:
                    warnings.append('期权批次失败 · '+str(error))
            pipeline['optionSnapshot']=round(monotonic()-stage,3)
            stage=monotonic()
            cells, first, last, usable = summarize(chosen, rows, spot['value'])
            pipeline['gex']=round(monotonic()-stage,3)
            received = datetime.now(timezone.utc)
            if usable < len(chosen):
                warnings.append(f'{usable}/{len(chosen)} sampled contracts usable；不完整快照不计算 Velocity')
            frame = {'source': 'opend', 'symbol': symbol, 'optionRoot': 'SPXW' if symbol=='SPXW' else code,
                    'priceSymbol': price['priceSymbol'], 'model': MODEL, 'sessionDate': day,
                    'collectedAt': iso(received), 'duration': (received-start).total_seconds(), 'spot': spot,
                    'previousClose': price['previousClose'], 'previousCloseDate': price['previousCloseDate'],
                    'optionFirstAt': first, 'optionLastAt': last, 'contracts': len(chosen), 'usable': usable,
                    'dates': dates, 'availableDates': available, 'cells': cells, 'bars': price['bars'],
                    'price': price, 'warnings': warnings, 'refreshSeconds': 30, 'pipeline':pipeline, **calendar.payload(start)}
            frame['cacheKey']=cache_identity(frame)
            stage=monotonic()
            self.cache[symbol] = (monotonic(), frame)
            self.store.save(frame)
            pipeline['save']=round(monotonic()-stage,3)
            return frame


class SnapshotManager:
    """Shared per-process capture owner. HTTP readers never wait for the OpenD option chain."""
    def __init__(self, feed, interval=30, watched=('SPY','QQQ','SPXW')):
        self.feed,self.interval=feed,interval
        self.lock=RLock();self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='gex-capture')
        self.latest={};self.jobs={};self.status={};self.price_latest={};self.price_jobs={};self.price_status={}
        self.price_pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='gex-price')
        self.watched={symbol:monotonic() for symbol in watched}
        self.closed=False
        self.timer=Thread(target=self._poll,name='gex-scheduler',daemon=True);self.timer.start()
        for symbol in watched:self.request_price(symbol)
        for symbol in watched:self.request(symbol)

    def _poll(self):
        while not self.closed:
            sleep(1)
            with self.lock:active=[s for s,t in self.watched.items() if monotonic()-t<1800]
            for symbol in active:
                self.request(symbol,observe=False)
                self.request_price(symbol,observe=False)

    def request_price(self,symbol,force=False,observe=True):
        with self.lock:
            if observe:self.watched[symbol]=monotonic()
            if symbol not in self.price_latest:
                cached=self.feed.store.latest_price(symbol)
                if cached:self.price_latest[symbol]=cached
            job=self.price_jobs.get(symbol)
            if not(job and not job.done()):
                state=self.price_status.get(symbol,{})
                if force or not state or monotonic()-state.get('finishedMono',0)>=15:
                    self.price_status[symbol]={**state,'phase':'collecting','startedAt':iso(datetime.now(timezone.utc))}
                    self.price_jobs[symbol]=self.price_pool.submit(self._collect_price,symbol)
            price=self.price_latest.get(symbol)
            status={k:v for k,v in self.price_status.get(symbol,{}).items() if k!='finishedMono'}
            status['stale']=(not price or not price.get('spot') or
                (datetime.now(timezone.utc)-datetime.fromisoformat(price['spot']['at'])).total_seconds()>120)
            return {**price,'service':status} if price else {'symbol':symbol,'source':'OpenD','status':'loading','bars':[],'service':status}

    def _collect_price(self,symbol):
        started=monotonic()
        try:
            price=self.feed.price(symbol)
            with self.lock:
                self.price_latest[symbol]=price
                self.price_status[symbol]={'phase':'ready','finishedAt':iso(datetime.now(timezone.utc)),
                    'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3)}
        except Exception as error:
            with self.lock:
                self.price_status[symbol]={'phase':'error','finishedAt':iso(datetime.now(timezone.utc)),
                    'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3),'error':str(error)}
        print(json.dumps({'event':'background-price','symbol':symbol,**{k:v for k,v in self.price_status[symbol].items() if k!='finishedMono'}},ensure_ascii=True),flush=True)

    def request(self, symbol, force=False, observe=True):
        with self.lock:
            if observe:self.watched[symbol]=monotonic()
            if symbol not in self.latest:
                frame=self.feed.store.latest(symbol)
                if frame and frame.get('model')==MODEL and frame.get('symbol')==symbol and frame.get('optionRoot') and frame.get('dates') and frame.get('cacheKey',cache_identity(frame))==cache_identity(frame):
                    self.latest[symbol]=frame
            job=self.jobs.get(symbol)
            if job and not job.done():return self._response(symbol)
            state=self.status.get(symbol,{})
            if force or not state or monotonic()-state.get('finishedMono',0)>=self.interval:
                self.status[symbol]={**state,'phase':'collecting','startedAt':iso(datetime.now(timezone.utc))}
                self.jobs[symbol]=self.pool.submit(self._collect,symbol,force)
            return self._response(symbol)

    def _response(self,symbol):
        frame=self.latest.get(symbol)
        status={k:v for k,v in self.status.get(symbol,{}).items() if k!='finishedMono'}
        status['stale']=not frame or (datetime.now(timezone.utc)-datetime.fromisoformat(frame['collectedAt'])).total_seconds()>90
        status['cached']=bool(frame)
        return {**frame,'service':status} if frame else {'symbol':symbol,'source':'opend','status':'loading','service':status}

    def _collect(self,symbol,force=False):
        started=monotonic()
        try:
            frame=self.feed.collect(symbol,force=force)
            with self.lock:
                self.latest[symbol]=frame
                self.status[symbol]={'phase':'ready','finishedAt':iso(datetime.now(timezone.utc)),
                    'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3)}
        except Exception as error:
            with self.lock:
                self.status[symbol]={'phase':'error','finishedAt':iso(datetime.now(timezone.utc)),
                    'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3),'error':str(error)}
        print(json.dumps({'event':'background-capture','symbol':symbol,**{k:v for k,v in self.status[symbol].items() if k!='finishedMono'}},ensure_ascii=True),flush=True)

    def close(self):
        self.closed=True;self.pool.shutdown(wait=True,cancel_futures=True);self.price_pool.shutdown(wait=True,cancel_futures=True)
