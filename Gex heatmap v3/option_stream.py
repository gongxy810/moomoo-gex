"""Bounded option quote subscriptions; pushes trigger coherent full-chain refreshes."""
from threading import Lock
from datetime import datetime, timezone
from market import stamp, ET


class PriceTickerStream:
    """Small independent cache of actual underlying trades, no DataFrames."""
    def __init__(self,sdk,ctx):
        self.lock=Lock();self.ticks={};owner=self
        class Handler(sdk.TickerHandlerBase):
            def on_recv_rsp(self,rsp_pb):
                if rsp_pb.retType!=sdk.RET_OK:return rsp_pb.retType,rsp_pb.retMsg
                from moomoo.common.utils import merge_qot_mkt_stock_str
                code=merge_qot_mkt_stock_str(int(rsp_pb.s2c.security.market),rsp_pb.s2c.security.code)
                owner.receive(code,[{'time':t.time,'price':t.price} for t in rsp_pb.s2c.tickerList])
                return sdk.RET_OK,None
        self.handler=Handler();ctx.set_handler(self.handler)

    def receive(self,code,ticks):
        now=datetime.now(timezone.utc)
        valid=[(at,t) for t in ticks if (at:=stamp(t.get('time'))) is not None and
               isinstance(t.get('price'),(int,float)) and t['price']>0 and at<=now]
        if not valid:return
        at,tick=max(valid,key=lambda item:item[0])
        with self.lock:
            old=self.ticks.get(code)
            if old is None or at>=old[0]:self.ticks[code]=(at,dict(tick))
            while len(self.ticks)>64:self.ticks.pop(next(iter(self.ticks)))

    def get(self,code):
        with self.lock:
            record=self.ticks.get(code)
            return dict(record[1]) if record else None


class OptionStream:
    def __init__(self, sdk, ctx):
        self.sdk, self.ctx = sdk, ctx
        self.lock = Lock()
        self.owners, self.pools, self.pending = {}, {}, {}
        self.count, self.last_at, self.error = 0, None, None
        owner = self

        class Handler(sdk.StockQuoteHandlerBase):
            def on_recv_rsp(self, rsp_pb):
                # Only instrument identity and quote time are needed to schedule
                # a coherent snapshot. Building a 100-column pandas DataFrame
                # for every push can consume an entire shared cloud CPU.
                if rsp_pb.retType != sdk.RET_OK:
                    return rsp_pb.retType, rsp_pb.retMsg
                from moomoo.common.utils import merge_qot_mkt_stock_str
                rows=[]
                for quote in rsp_pb.s2c.basicQotList:
                    parts=quote.updateTime.split()
                    if len(parts)!=2:continue
                    rows.append({'code':merge_qot_mkt_stock_str(int(quote.security.market),quote.security.code),
                                 'data_date':parts[0],'data_time':parts[1]})
                owner.receive(rows)
                return sdk.RET_OK, rows

        self.handler = Handler()
        ctx.set_handler(self.handler)

    def receive(self, rows):
        with self.lock:
            for row in rows:
                symbol = self.owners.get(row.get('code'))
                # Initial/empty SDK pushes must not trigger repeated recomputation.
                if not symbol or not row.get('data_date') or not row.get('data_time'):
                    continue
                at = stamp(str(row['data_date']) + ' ' + str(row['data_time']))
                if at is None or not 0 <= (datetime.now(timezone.utc)-at).total_seconds() <= 120:
                    continue
                self.pending[symbol] = self.pending.get(symbol, 0) + 1
                self.count += 1
                self.last_at = str(row['data_date']) + ' ' + str(row['data_time'])

    def version(self, symbol):
        with self.lock:
            return self.pending.get(symbol, 0)

    def configure(self, symbol, chosen, spot):
        # 12 contracts per root, max 132 for the 11 default roots, global cap156.
        # Call and put at the same strike stay together; no full-chain subscription.
        today = datetime.now(ET).date().isoformat()
        dates = sorted({spec[0] for spec in chosen.values() if spec[0] >= today})
        if not dates:
            return
        strikes = sorted({spec[1] for spec in chosen.values() if spec[0] == dates[0]},
                         key=lambda k: (abs(k-spot), k))[:6]
        desired = {code for code, spec in chosen.items() if spec[0] == dates[0] and spec[1] in strikes}
        old = self.pools.get(symbol, set())
        try:
            removed = old - desired
            if removed:
                ret, msg = self.ctx.unsubscribe(sorted(removed), [self.sdk.SubType.QUOTE])
                if ret != self.sdk.RET_OK:
                    raise RuntimeError(str(msg))
                with self.lock:
                    for code in removed:
                        self.owners.pop(code, None)
                old -= removed
                self.pools[symbol] = old
            added = desired - old
            with self.lock:
                if len(self.owners) + len(added) > 156:
                    raise RuntimeError('Option stream local cap156; full snapshots remain active')
                for code in added:
                    self.owners[code] = symbol
            if added:
                ret, msg = self.ctx.subscribe(sorted(added), [self.sdk.SubType.QUOTE],
                                              subscribe_push=True, is_first_push=True)
                if ret != self.sdk.RET_OK:
                    with self.lock:
                        for code in added:
                            self.owners.pop(code, None)
                    raise RuntimeError(str(msg))
            self.pools[symbol] = desired
            self.error = None
        except Exception as error:
            self.error = str(error)[:300]

    def status(self, symbol):
        with self.lock:
            return {'subscribedContracts': len(self.pools.get(symbol, ())),
                    'totalContracts': len(self.owners), 'receivedPushes': self.count,
                    'lastQuoteTimeET': self.last_at, 'error': self.error,
                    'mode': 'quote-triggered full snapshot; no partial Greek overlay'}
