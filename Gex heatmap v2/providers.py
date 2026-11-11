"""Price adapters are independent of the OpenD option collector."""
from typing import Protocol
from pathlib import Path
import json


def tempest_payload(symbol):
    """Optional locally supplied authorized payload; never reads browser sessions."""
    path=Path(__file__).resolve().parent/'data'/'tempest-authorized.json'
    try:
        records=json.loads(path.read_text(encoding='utf-8'))
        expected='SPX' if symbol=='SPXW' else symbol
        record=records.get(expected) if isinstance(records,dict) else None
        if isinstance(record,dict) and record.get('symbol')==expected:
            allowed={'symbol','session','horizons','levels','sigma','coverage','events','tail_src'}
            return {'configured':True,'provider':'Tempest','source':'locally supplied authorized payload (no live API polling)',
                    'payload':{k:v for k,v in record.items() if k in allowed}}
    except (OSError,ValueError,TypeError):
        pass
    return {'configured':False,'provider':'Tempest','reason':'Tempest 未配置：无获授权 payload；未调用付费接口'}


class PriceDataProvider(Protocol):
    def get(self, symbol: str) -> dict:
        """Return symbol, OHLC, quoteAt, session, delayed and source metadata."""
        ...


class OpenDPriceProvider:
    def __init__(self, feed):
        self.feed = feed

    def get(self, symbol):
        return self.feed._opend_price(symbol)


class RoutedPriceProvider:
    """Explicit SPX cash adapter slot; never reads browser credentials or buys data."""
    def __init__(self, fallback, spx_cash=None):
        self.fallback, self.spx_cash = fallback, spx_cash

    def get(self, symbol):
        if symbol == 'SPXW' and self.spx_cash:
            result = self.spx_cash.get('SPX')
            if result.get('priceSymbol') != 'SPX' or not result.get('bars'):
                return self.fallback.get(symbol)
            return {**result, 'symbol': 'SPXW'}
        return self.fallback.get(symbol)
