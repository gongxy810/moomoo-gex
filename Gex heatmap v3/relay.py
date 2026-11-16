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
import os
from market import Calendar, ET, iso, quote, stamp, symbol_code, verified_close
from snapshots import SnapshotStore
from exposures import vex_cell
from supabase_sink import LatestMirror
from spx_calibration import calibration_reference
from providers import OpenDPriceProvider, RoutedPriceProvider
from option_stream import OptionStream, PriceTickerStream

MODEL = 'OI-gamma-100-unadjusted-v1'
CAPTURE_VERSION = 'gex-collection-wide-v3'
CLOUD_HISTORY_SYMBOLS = ('SPY', 'QQQ', 'SPXW', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA')


def default_history_symbols():
    if os.environ.get('GEX_CLOUD') != '1':
        return ('SPY', 'QQQ', 'SPXW')
    configured = os.environ.get('GEX_HISTORY_SYMBOLS')
    values = configured.split(',') if configured is not None else CLOUD_HISTORY_SYMBOLS
    # SPX and SPXW are two UI entries for the same option root.
    return tuple(dict.fromkeys(symbol_code(value.strip())[0] for value in values if value.strip()))


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
        volume = number(row.get('volume'))
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
            'multiplier':mult,'source':'OpenD get_market_snapshot',
            'gamma':gamma,'volume':volume,'volumeKind':'session cumulative contracts'
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
        self.option_stream = None
        self.price_ticks = None
        self.intraday_repairs = {}
        self.expiry_lock = Lock()
        self.requested_expiries = {}
        self.store = store or SnapshotStore(Path(os.environ.get('GEX_DATA_DIR',str(Path(__file__).parent/'data')))/'captures.sqlite3')
        self.mirror=LatestMirror() if not price_only else None
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
            # SDK defaults to an unlimited wait for reconnection. A dropped
            # tunnel must fail a job and retry, never hold both collectors forever.
            self.ctx = moomoo.OpenQuoteContext(host='127.0.0.1', port=self.port,is_async_connect=True)
            self.ctx.set_sync_query_connect_timeout(8)
            if self.price_feed is not None:
                self.option_stream = OptionStream(moomoo, self.ctx)
            else:self.price_ticks = PriceTickerStream(moomoo,self.ctx)
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
            if attempt==0 and any(w in message.lower() for w in ['disconnected','connection closed','broken pipe','timeout','连接断开','连接失败']):
                self.reconnect();method=getattr(self.ctx,method.__name__);continue
            raise RuntimeError(message)

    def reconnect(self):
        if self.ctx:
            try:self.ctx.close()
            except Exception:pass
        self.ctx=None;self.option_stream=None;self.price_ticks=None;self.subscriptions.clear();self.intraday_repairs.clear();self.connect()

    def repair_intraday(self,code,rows,now):
        """Recover actual minute candles missed while the SDK was disconnected."""
        if code=='US..SPX':return rows,None
        day=now.astimezone(ET).date().isoformat()
        previous=self.intraday_repairs.get(code)
        if previous and previous[0]==day and (previous[2] or monotonic()-previous[1]<300):return rows,None
        self.intraday_repairs[code]=(day,monotonic(),False)
        try:
            history=self.records(self.ctx.request_history_kline,code,start=day,end=day,
                ktype=self.sdk.KLType.K_1M,autype=self.sdk.AuType.NONE,max_count=1000,extended_time=True)
            merged={r['time_key']:r for r in rows}
            merged.update({r['time_key']:r for r in history})
            # Keep the newest official push for the still-open minute only.
            for row in rows:
                at=stamp(row.get('time_key'))
                if at and at>=now.replace(second=0,microsecond=0):merged[row['time_key']]=row
            self.intraday_repairs[code]=(day,monotonic(),bool(history))
            return sorted(merged.values(),key=lambda r:r['time_key']),None
        except RuntimeError as error:return rows,'Minute history repair unavailable: '+str(error)

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

    def subscribe(self, code, subtype, push=False):
        key = (code, subtype, bool(push))
        if key not in self.subscriptions:
            self.records(self.ctx.subscribe,[code],[subtype],subscribe_push=push,extended_time=True)
            self.subscriptions.add(key)

    def spot(self, symbol, code, now, calendar, daily):
        try:
            self.subscribe(code,self.sdk.SubType.TICKER,push=True)
            tick=self.price_ticks.get(code) if self.price_ticks else None
            if tick and 0<=(now-stamp(tick['time'])).total_seconds()<=5:
                result=quote(symbol,{},[tick],now,calendar,daily)
                result['source']='OpenD ticker push';return result
        except RuntimeError:pass
        rows = self.snapshots([code])
        ticks = []
        try:
            self.subscribe(code, self.sdk.SubType.TICKER,push=True)
            ticks = self.records(self.ctx.get_rt_ticker, code, num=100)
        except RuntimeError:
            pass
        return quote(symbol, rows[0] if rows else {}, ticks, now, calendar, daily)

    def price(self, raw):
        symbol, _ = symbol_code(raw)
        return self.push_price(self.price_provider.get(symbol),symbol)

    def push_price(self,price,symbol):
        feed=self.price_feed or self
        ticks=getattr(feed,'price_ticks',None)
        _,code=symbol_code(symbol);now=datetime.now(timezone.utc)
        tick=ticks.get(code) if ticks else None
        calendar=feed.calendars.get((code.split('.')[0],str(now.astimezone(ET).date())))
        daily=feed.daily_cache.get(code)
        if ticks and calendar:
            live_bars=[{**bar,'phase':calendar.phase(stamp(bar['at']))} for bar in ticks.get_bars(code)]
            if live_bars:
                merged=sorted({bar['at']:bar for bar in [*price.get('bars',[]),*live_bars]}.values(),key=lambda bar:bar['at'])[-2000:]
                price={**price,'bars':merged,'barAt':merged[-1]['at'],'barMinutes':1,'candleSource':'OpenD subscribed K_1M'}
        if tick and calendar and 0<=(now-stamp(tick['time'])).total_seconds()<=15:
            spot=quote(symbol,{},[tick],now,calendar,daily[1] if daily else [])
            if spot['current'] and (not price.get('spot') or stamp(spot['at'])>=stamp(price['spot']['at'])):
                spot['source']='OpenD ticker push';spot['label']='OpenD ticker push · '+spot['status']
                return {**price,'spot':spot,'quoteAt':spot['at'],'delayed':False,
                        'previousClose':spot['previousClose'],'previousCloseDate':spot['previousCloseDate']}
        return price

    def _opend_price(self, raw):
        symbol, code = symbol_code(raw)
        cached=self.price_cache.get(symbol)
        if cached and monotonic()-cached[0]<15:
            return cached[1]
        # Reuse subscribed trades/candles between periodic full repairs. Reading
        # 1000 SDK candles for every root every 15s wastes the small cloud CPU.
        if cached:
            now=datetime.now(timezone.utc)
            updated=self.push_price(cached[1],symbol)
            spot=updated.get('spot') or {}
            bars=updated.get('bars',[])
            if (symbol!='SPXW' and spot.get('source')=='OpenD ticker push' and bars and
                0<=(now-stamp(spot.get('at'))).total_seconds()<=15 and
                0<=(now-stamp(bars[-1]['at'])).total_seconds()<=120 and
                0<=(now-stamp(cached[1]['collectedAt'])).total_seconds()<120):
                self.store.save_price(symbol,bars[-2:],{k:v for k,v in updated.items() if k!='bars'})
                self.price_cache[symbol]=(monotonic(),updated)
                return updated
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
                self.subscribe(code, self.sdk.SubType.K_1M,push=True)
                raw_bars = self.records(self.ctx.get_cur_kline, code, 1000, ktype=self.sdk.KLType.K_1M, autype=self.sdk.AuType.NONE)
                raw_bars,repair_error=self.repair_intraday(code,raw_bars,now)
                if repair_error:warnings.append(repair_error)
                for b in raw_bars:
                    at = stamp(b.get('time_key'))
                    values = [positive(b.get(key)) for key in ['open', 'high', 'low', 'close']]
                    if at and at <= now and all(values):
                        bars.append(dict(at=iso(at), o=values[0], h=values[1], l=values[2], c=values[3], phase=calendar.phase(at, symbol=='SPXW')))
            except RuntimeError as error:
                warnings.append('K 线不可用 · '+str(error))
            pipeline['bars']=round(monotonic()-stage,3)
            if cached:
                # A short OpenD subscription buffer must never erase candles
                # already recovered from official minute history.
                bars=list({b['at']:b for b in [*cached[1].get('bars',[]),*bars]}.values())
            bars.sort(key=lambda b: b['at'])
            bars=bars[-2000:]
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
            supplement = supplemental_close(Path(os.environ.get('GEX_DATA_DIR',str(Path(__file__).parent/'data')))/'verified-index-closes.json', symbol, meta['previousSession']) if previous is None else None
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
        with self.expiry_lock:
            requested = self.requested_expiries.get(symbol)
        cached = self.chains.get(symbol)
        if cached and cached[3]==day and len(cached)>4 and cached[4]==requested and monotonic()-cached[0] < 3600:
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
                    try:
                        dates = sorted(set(dates) | {str(r['strike_time'])[:10] for r in self.records(self.ctx.get_option_expiration_date, owner)})
                    except RuntimeError:
                        pass
                    if requested and requested not in {spec[0] for spec in contracts.values()}:
                        extra = self.records(self.ctx.get_option_chain, owner, start=requested, end=requested)
                        contracts.update(contracts_from_chain(symbol, extra))
                    self.chains[symbol] = (monotonic(), contracts, dates, day, requested)
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
            available_sampled = sorted({spec[0] for spec in chain.values()})
            with self.expiry_lock:
                requested = self.requested_expiries.get(symbol)
            dates = sorted(set(available_sampled[:6]) | ({requested} if requested in available_sampled else set()))
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
            for expiry_index, expiry in enumerate(dates):
                strikes = {s for e, s, _ in chain.values() if e==expiry}
                near = set(sorted(strikes, key=lambda s: (abs(s-spot['value']), s))[:96 if expiry_index < 2 else 68])
                step = 50 if symbol == 'SPXW' else 10
                near.update(k for k in strikes if abs(k/spot['value']-1)<=.08 and abs(k/step-round(k/step))<1e-8)
                chosen.update({c: spec for c, spec in chain.items() if spec[0]==expiry and spec[1] in near})
            rows = []
            if self.option_stream:
                self.option_stream.configure(symbol, chosen, spot['value'])
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
            frame['expiryCloses']={d:iso(calendar.close(d)) for d in dates if calendar.close(d)}
            for d in dates:
                if not frame['expiryCloses'].get(d):
                    # Ask OpenD for that expiry's actual session, including half days.
                    expiry_calendar = self.calendar(code, datetime.fromisoformat(d).replace(tzinfo=ET))
                    frame['expiryCloses'][d] = iso(expiry_calendar.close(d)) if expiry_calendar.close(d) else None
            if self.option_stream:
                frame['optionStream'] = self.option_stream.status(symbol)
            frame['listedStrikes']={d:sorted({k for e,k,_ in chain.values() if e==d}) for d in dates}
            for cell in cells:
                vex=vex_cell(cell,frame)
                cell['callVex'],cell['putVex']=vex['call'],vex['put']
            frame['cacheKey']=cache_identity(frame)
            if symbol == 'SPXW':
                frame['calibration'] = calibration_reference(cells, frame['collectedAt'],
                    {d:iso(calendar.close(d)) for d in dates if calendar.close(d)})
            stage=monotonic()
            self.cache[symbol] = (monotonic(), frame)
            self.store.save(frame)
            if self.mirror:self.mirror.submit(frame)
            pipeline['save']=round(monotonic()-stage,3)
            return frame


class SnapshotManager:
    """Shared per-process capture owner. HTTP readers never wait for the OpenD option chain."""
    def __init__(self, feed, interval=30, watched=None):
        watched = default_history_symbols() if watched is None else watched
        self.feed,self.interval=feed,interval
        self.lock=RLock();self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='gex-capture')
        # Interactive work can bypass queued archival roots. OpenDFeed.lock still
        # serializes SDK chain reads; a running capture is always joined.
        self.priority_pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='gex-focus')
        self.latest={};self.jobs={};self.status={};self.price_latest={};self.price_jobs={};self.price_status={}
        self.stream_versions={}
        self.visible={}
        self.price_pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='gex-price')
        self.always=set(watched) if os.environ.get('GEX_CLOUD')=='1' else set()
        self.watched={symbol:monotonic() for symbol in watched}
        self.closed=False
        self.timer=Thread(target=self._poll,name='gex-scheduler',daemon=True);self.timer.start()
        for symbol in watched:self.request_price(symbol,observe=False)
        for symbol in watched:self.request(symbol,observe=False)

    def _poll(self):
        while not self.closed:
            sleep(1)
            if self.closed:return
            with self.lock:active=[s for s,t in self.watched.items() if s in self.always or monotonic()-t<1800]
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
            if price and hasattr(self.feed,'push_price'):price=self.feed.push_price(price,symbol)
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
            if observe:self.watched[symbol]=monotonic();self.visible[symbol]=monotonic()
            interactive=monotonic()-self.visible.get(symbol,float('-inf'))<10
            if symbol not in self.latest:
                frame=self.feed.store.latest(symbol)
                if frame and frame.get('model')==MODEL and frame.get('symbol')==symbol and frame.get('optionRoot') and frame.get('dates') and all(frame.get('cacheKey',cache_identity(frame)).get(k)==cache_identity(frame).get(k) for k in ('symbol','optionRoot','dates','model')):
                    self.latest[symbol]=frame
                    mirror=getattr(self.feed,'mirror',None)
                    if mirror:mirror.submit(frame)
            job=self.jobs.get(symbol)
            state=self.status.get(symbol,{})
            requested=getattr(self.feed,'requested_expiries',{}).get(symbol)
            frame=self.latest.get(symbol,{})
            needs_expiry=bool(requested and requested in frame.get('availableDates',[]) and requested not in frame.get('dates',[]))
            if state.get('phase')=='error' and monotonic()-state.get('finishedMono',0)<30:needs_expiry=False
            if job and not job.done():
                if (force or needs_expiry or interactive) and not job.running() and job.cancel():
                    self._submit_capture(symbol,True,self.priority_pool)
                return self._response(symbol)
            force=force or needs_expiry
            stream=getattr(self.feed,'option_stream',None)
            version=stream.version(symbol) if stream else 0
            elapsed=monotonic()-state.get('finishedMono',0)
            triggered=version!=self.stream_versions.get(symbol,0) and elapsed>=10
            if force or triggered or not state or elapsed>=self.interval:
                self.stream_versions[symbol]=version
                self.status[symbol]={**state,'phase':'collecting','startedAt':iso(datetime.now(timezone.utc))}
                pool=self.priority_pool if force or interactive else self.pool
                self._submit_capture(symbol,force or triggered,pool)
            return self._response(symbol)

    def _submit_capture(self,symbol,force,pool):
        future=pool.submit(self._collect,symbol,force)
        self.jobs[symbol]=future
        future.add_done_callback(lambda done:self._capture_finished(symbol,done))

    def _capture_finished(self,symbol,future):
        if future.cancelled():return
        frame,status=future.result()
        with self.lock:
            if self.jobs.get(symbol) is not future:return
            if frame:self.latest[symbol]=frame
            self.status[symbol]=status

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
            status={'phase':'ready','finishedAt':iso(datetime.now(timezone.utc)),
                'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3)}
        except Exception as error:
            frame=None
            status={'phase':'error','finishedAt':iso(datetime.now(timezone.utc)),
                'finishedMono':monotonic(),'captureSeconds':round(monotonic()-started,3),'error':str(error)}
        print(json.dumps({'event':'background-capture','symbol':symbol,**{k:v for k,v in status.items() if k!='finishedMono'}},ensure_ascii=True),flush=True)
        sleep(.01)  # Yield the shared SDK lock to a waiting foreground/archive worker.
        return frame,status

    def close(self):
        self.closed=True;self.timer.join();self.pool.shutdown(wait=True,cancel_futures=True);self.priority_pool.shutdown(wait=True,cancel_futures=True);self.price_pool.shutdown(wait=True,cancel_futures=True)
