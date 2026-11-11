"""Read-only OpenD SPX cash quote and 1m OHLC capability check."""
import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import moomoo

ET = ZoneInfo('America/New_York')


def summarize(ret, data):
    if ret != moomoo.RET_OK:
        return {'ok': False, 'error': str(data)[:300]}
    rows = data.to_dict('records') if hasattr(data, 'to_dict') else []
    last = rows[-1] if rows else {}
    return {'ok': True, 'rows': len(rows), 'lastAt': str(last.get('time_key') or last.get('update_time') or ''),
            'lastValue': last.get('close') or last.get('last_price'),
            'fields': list(last)[:12]}


def main():
    code = 'US..SPX'
    day = datetime.now(ET).date()
    report = {'code': code, 'checkedAt': datetime.now(ET).isoformat(), 'calls': {}}
    ctx = moomoo.OpenQuoteContext(host='127.0.0.1', port=11111)
    try:
        ret, data = ctx.get_market_snapshot([code])
        report['calls']['snapshot'] = summarize(ret, data)
        ret, data, *_ = ctx.request_history_kline(code, start=str(day-timedelta(days=1)), end=str(day),
                                                   ktype=moomoo.KLType.K_1M, autype=moomoo.AuType.NONE,
                                                   max_count=500)
        report['calls']['history1m'] = summarize(ret, data)
        ret, data = ctx.subscribe([code], [moomoo.SubType.K_1M], subscribe_push=False)
        report['calls']['subscribe1m'] = {'ok': ret == moomoo.RET_OK, 'error': None if ret == moomoo.RET_OK else str(data)[:300]}
        if ret == moomoo.RET_OK:
            ret, data = ctx.get_cur_kline(code, 500, ktype=moomoo.KLType.K_1M, autype=moomoo.AuType.NONE)
            report['calls']['current1m'] = summarize(ret, data)
    finally:
        ctx.close()
    path = Path(__file__).resolve().parent.parent/'tests'/'browser-artifacts'/'spx-cash-source-check.json'
    path.write_text(json.dumps(report, indent=2, default=str), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
