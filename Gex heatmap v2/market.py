"""Session and quote rules. Calendars come from OpenD, never weekday guesses."""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
import re

ET = ZoneInfo('America/New_York')


def symbol_code(value):
    value = value.strip().upper()
    if value in {'SPX', 'SPXW', 'US.SPX', 'US..SPX', 'US.SPXW'}:
        return 'SPXW', 'US..SPX'
    if not re.fullmatch(r'(?:[A-Z]{2}\.)?[A-Z0-9][A-Z0-9_-]{0,19}', value):
        raise ValueError('代码无法识别：请输入 SPY、NVDA 或 US.NVDA 等 OpenD 代码')
    code = value if '.' in value else 'US.' + value
    return (code[3:] if code.startswith('US.') else code), code


def stamp(value):
    try:
        value = re.sub(r':(\d{3})$', r'.\1', str(value))
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=parsed.tzinfo or ET).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def iso(value):
    return value.isoformat(timespec='seconds') if value else None


class Calendar:
    def __init__(self, rows):
        self.days = {r['time'][:10]: ('HALF' in str(r.get('trade_date_type', '')).upper()) for r in rows}

    def close(self, day):
        if day not in self.days:
            return None
        return datetime.combine(datetime.fromisoformat(day).date(), time(13 if self.days[day] else 16), ET)

    def previous(self, day):
        return max((d for d in self.days if d < day), default=None)

    def session(self, at):
        day = at.astimezone(ET).date().isoformat()
        return day if day in self.days else max((d for d in self.days if d <= day), default=None)

    def phase(self, at, index=False):
        local = at.astimezone(ET)
        close = self.close(local.date().isoformat())
        if close is None:
            return 'Closed'
        if time(9, 30) <= local.time() < close.time():
            return 'RTH'
        if not index and time(4) <= local.time() < time(9, 30):
            return 'PRE'
        if not index and close.time() <= local.time() < time(20):
            return 'POST'
        return 'Closed'

    def payload(self, at):
        day = self.session(at)
        prior = self.previous(day) if day else None
        return {'sessionDate': day, 'previousSession': prior, 'sessionClose': iso(self.close(day)) if day else None,
                'previousSessionClose': iso(self.close(prior)) if prior else None, 'calendarSource': 'OpenD trading calendar'}


def verified_close(daily, day):
    """Unadjusted daily history matches unadjusted snapshot/option strikes."""
    for row in daily:
        if str(row.get('time_key', ''))[:10] == day:
            try:
                value = float(row['close'])
                if value > 0:
                    return value
            except (ValueError, TypeError, KeyError):
                pass
    return None


def quote(symbol, row, ticks, now, calendar, daily):
    index = symbol == 'SPXW'
    session = calendar.session(now)
    candidates = []
    for tick in ticks:
        candidates.append((stamp(tick.get('time')), tick.get('price'), 'OpenD ticker'))
    candidates.append((stamp(row.get('update_time')), row.get('last_price'), 'OpenD snapshot'))
    valid = []
    for at, raw, source in candidates:
        try:
            price = float(raw)
        except (ValueError, TypeError):
            continue
        if at and price > 0 and at <= now + timedelta(seconds=3):
            valid.append((at, price, source))
    if not valid:
        raise RuntimeError('行情不可用或缺少可信报价时间；请检查行情权限')
    at, price, source = max(valid)
    day = at.astimezone(ET).date().isoformat()
    phase = calendar.phase(at, index)
    age = (now - at).total_seconds()
    same = day == session and day in calendar.days
    fresh = same and age <= 120 and phase != 'Closed' and calendar.phase(now, index) == phase
    label = phase if fresh else 'Delayed' if same and phase != 'Closed' else 'REF'
    # A stale regular print is a close only when verified by the daily close and timestamp.
    close = calendar.close(day)
    daily_close = verified_close(daily, day)
    if same and close and now >= close and at >= close - timedelta(minutes=5) and daily_close is not None and abs(daily_close-price) < 1e-6:
        label = 'Close'
    previous_day = calendar.previous(day) if same else None
    previous = verified_close(daily, previous_day) if previous_day else None
    return {'value': price, 'at': iso(at), 'phase': phase, 'status': label, 'current': fresh,
            'source': source, 'label': source + ' · ' + label, 'previousClose': previous,
            'previousCloseDate': previous_day if previous is not None else None,
            'adjustment': 'NONE', 'comparable': same and label != 'REF', 'delayed': not fresh}
