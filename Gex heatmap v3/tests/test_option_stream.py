import unittest
from datetime import datetime, timedelta
from market import ET
from option_stream import OptionStream


class OptionStreamTests(unittest.TestCase):
    def test_pinned_sdk_push_protocol_avoids_dataframe_conversion(self):
        import moomoo
        from moomoo.common.pb import Qot_UpdateBasicQot_pb2
        from moomoo.common.utils import split_stock_str
        class Context:
            def set_handler(self,handler):self.handler=handler
        ctx=Context();stream=OptionStream(moomoo,ctx)
        code='US.SPY261120C760000';stream.owners[code]='SPY'
        message=Qot_UpdateBasicQot_pb2.Response();message.retType=0
        q=message.s2c.basicQotList.add();_,(market,stock)=split_stock_str(code)
        q.security.market=market;q.security.code=stock
        q.updateTime=(datetime.now(ET)-timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S')
        ret,rows=ctx.handler.on_recv_rsp(message)
        self.assertEqual(ret,0);self.assertEqual(rows[0]['code'],code)
        self.assertEqual(stream.version('SPY'),1)
    def test_bounded_pairs_subscription_rotation_and_stale_push(self):
        class SDK:
            RET_OK = 0
            class SubType:
                QUOTE = 'QUOTE'
            class StockQuoteHandlerBase:
                pass
        class Context:
            def set_handler(self, handler): self.handler = handler
            def subscribe(self, codes, types, **kwargs):
                self.added = codes
                return 0, ''
            def unsubscribe(self, codes, types):
                self.removed = codes
                return 0, ''
        ctx = Context()
        stream = OptionStream(SDK, ctx)
        expiry = (datetime.now(ET)+timedelta(days=2)).date().isoformat()
        chosen = {f'{k}{side}':(expiry,k,side) for k in range(90,111) for side in ('CALL','PUT')}
        stream.configure('SPY',chosen,100)
        self.assertEqual(len(ctx.added),12)
        code=ctx.added[0]
        now=datetime.now(ET)-timedelta(seconds=1)
        stream.receive([{'code':code,'data_date':now.strftime('%Y-%m-%d'),'data_time':now.strftime('%H:%M:%S')}])
        self.assertEqual(stream.version('SPY'),1)
        stream.receive([{'code':code,'data_date':'2020-01-01','data_time':'10:00:00'}])
        self.assertEqual(stream.version('SPY'),1)
        stream.configure('SPY',chosen,108)
        self.assertTrue(ctx.removed)
        self.assertEqual(stream.status('SPY')['totalContracts'],12)

