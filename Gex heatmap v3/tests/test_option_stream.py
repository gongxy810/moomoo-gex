import unittest
from datetime import datetime, timedelta
from market import ET
from option_stream import OptionStream


class OptionStreamTests(unittest.TestCase):
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

