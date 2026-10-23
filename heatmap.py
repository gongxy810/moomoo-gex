"""Expiry/strike GEX grid and local, observed-snapshot replay (no synthetic history)."""
from __future__ import annotations
import hashlib
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from streamlit_autorefresh import st_autorefresh

DB_PATH = Path(__file__).resolve().parent / '.gex-data' / 'history.sqlite3'
NY = ZoneInfo('America/New_York')


def scope_key(symbol, days, host, port):
    # Histories from different sources and expiry windows must not be mixed.
    return hashlib.sha256(f'{symbol}|{days}|{host}|{port}|gex-v1'.encode()).hexdigest()


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute('CREATE TABLE IF NOT EXISTS snapshots (scope TEXT, ts REAL, spot REAL, cells TEXT, PRIMARY KEY(scope, ts))')
    return con


def save_snapshot(scope, spot, cells, ts):
    with connect() as con:
        con.execute('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?)',
                    (scope, float(ts), float(spot), pd.DataFrame(cells).to_json(orient='records')))


def load_snapshots(scope):
    with connect() as con:
        rows = con.execute('SELECT ts, spot, cells FROM snapshots WHERE scope=? ORDER BY ts', (scope,)).fetchall()
    return [{'ts': ts, 'spot': spot, 'cells': json.loads(cells)} for ts, spot, cells in rows]


def money(value):
    if value is None or pd.isna(value):
        return '—'
    sign = '−' if value < 0 else ''
    for scale, suffix in [(1e9, 'B'), (1e6, 'M'), (1e3, 'K')]:
        if abs(value) >= scale:
            return f'{sign}${abs(value)/scale:,.2f}{suffix}'
    return f'{sign}${abs(value):,.0f}'


def stamp(ts):
    return datetime.fromtimestamp(ts, NY).strftime('%m-%d %H:%M:%S ET')


def cell_color(value, limit):
    if pd.isna(value):
        return '#10151d'
    t = min(abs(value) / max(limit, 1), 1) ** .5
    target = (20, 169, 107) if value >= 0 else (215, 48, 65)
    return '#' + ''.join(f'{int(17+(channel-17)*t):02x}' for channel in target)


def cell_history(snapshots, strike, expiry, until):
    result = []
    for snap in snapshots:
        if snap['ts'] > until:
            continue
        for cell in snap['cells']:
            if cell['strike'] == strike and cell['expiry'] == expiry:
                result.append((snap['ts'], cell['gex']))
                break
    return result


def change_at(history, until, seconds, current):
    # Never substitute a recent sample for a missing hour-old observation.
    candidates = [(ts, value) for ts, value in history if ts <= until-seconds]
    if not candidates:
        return None, None
    ts, previous = candidates[-1]
    if until-seconds-ts > 120:
        return None, None
    delta = current-previous
    return delta, (delta/abs(previous)*100 if previous else None)


def structure(frame, snapshots, selected):
    st.caption('指标只覆盖当前到期日筛选；King = 最大绝对净 GEX。Active 按成交量定义。')
    grouped = frame.groupby('strike')[['gex', 'call_gex', 'put_gex']].sum()
    pos, neg = grouped[grouped.gex > 0], grouped[grouped.gex < 0]
    metrics = [('King', f'{grouped.gex.abs().idxmax():,.2f}'),
               ('Major Positive', f'{pos.gex.idxmax():,.2f}' if not pos.empty else '—'),
               ('Major Negative', f'{neg.gex.idxmin():,.2f}' if not neg.empty else '—'),
               ('Total GEX', money(grouped.gex.sum())),
               ('Call Wall', f'{grouped.call_gex.idxmax():,.2f}' if grouped.call_gex.max() > 0 else '—'),
               ('Put Wall', f'{grouped.put_gex.idxmin():,.2f}' if grouped.put_gex.min() < 0 else '—')]
    for side in ['call', 'put']:
        col = side+'_volume'
        volumes = frame.groupby('strike')[col].sum(min_count=1) if col in frame else pd.Series(dtype=float)
        metrics.append(('Active '+side.title(), f'{volumes.idxmax():,.2f}' if not volumes.empty and volumes.max() > 0 else '—'))
    for minutes in [1, 5]:
        earlier = [s for s in snapshots if s['ts'] <= selected['ts']-minutes*60]
        delta = None
        if earlier and selected['ts']-minutes*60-earlier[-1]['ts'] <= 120:
            # Compare only contracts present in both observations.
            previous = pd.DataFrame(earlier[-1]['cells'])
            both = frame.merge(previous, on=['strike','expiry'], suffixes=('', '_old'))
            if len(both) == len(frame) == len(previous):
                changes = both.gex-both.gex_old
                delta = changes.loc[changes.abs().idxmax()]
        metrics.append((f'Max Change {minutes} Min', money(delta)))
    cols = st.columns(2)
    for i, (label, value) in enumerate(metrics):
        cols[i % 2].metric(label, value)
    st.caption('Max Change 为单个 strike × 到期日格子的最大绝对变化（保留正负号），要求前后覆盖完全一致；不是总 GEX 变化。缺少历史或成交量时显示 —。')


def detail(snapshots, selected, strike, expiry):
    rows = [c for c in selected['cells'] if c['strike'] == strike and c['expiry'] == expiry]
    if not rows:
        st.info('该格子在当前快照不存在。')
        return
    cell = rows[0]
    st.markdown(f'### Strike {strike:,.2f} · {expiry}')
    st.caption(('NET LONG γ' if cell['gex'] > 0 else 'NET SHORT γ' if cell['gex'] < 0 else 'NEUTRAL γ')+' · 模型符号约定')
    st.metric('CURRENT VALUE', money(cell['gex']))
    st.caption(f"快照 {stamp(selected['ts'])} · 标的 ${selected['spot']:,.2f}")
    history = cell_history(snapshots, strike, expiry, selected['ts'])
    hours = st.radio('历史窗口', [1,4,24], horizontal=True, format_func=lambda h:f'{h}H', key='detail_hours')
    points = [(ts,v) for ts,v in history if ts >= selected['ts']-hours*3600]
    if len(points) >= 2:
        fig = go.Figure(go.Scatter(x=[datetime.fromtimestamp(t, NY) for t,v in points],
                                  y=[v for t,v in points], mode='lines+markers', line_color='#f2d66b',
                                  connectgaps=False, hovertemplate='%{x}<br>$%{y:,.0f}<extra></extra>'))
        fig.update_layout(height=240, template='plotly_dark', paper_bgcolor='#111b25', plot_bgcolor='#111b25',
                          margin=dict(l=5,r=5,t=10,b=10),yaxis_title='GEX ($ / 1%)')
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info('至少采集两次该合约快照后显示变化曲线。')
    for hours in [1,4]:
        delta, pct = change_at(history, selected['ts'], hours*3600, cell['gex'])
        st.metric(f'{hours}H CHANGE', money(delta), f'{pct:+.1f}%' if pct is not None else None)
    st.caption('百分比 = 金额变化 ÷ 历史值绝对值；历史值为零时不计算百分比。')


def render_heatmap(symbol, days, host, port, fetch, quote_slot, auto_refresh, refresh_seconds):
    scope = scope_key(symbol, days, host, port)
    title, control = st.columns([4,1])
    title.subheader('Dealer GEX · HEATMAP')
    replay = control.toggle('↶ Replay', key='heat_replay')
    snapshots = load_snapshots(scope)
    if not replay:
        try:
            price, gex, _ = fetch(symbol, days, host, port)
            cells = gex.attrs.get('cells')
            if not cells:
                st.error('期权链缺少到期日字段，无法生成日期热力图。')
                return
            save_snapshot(scope, price, cells, gex.attrs['captured_at'])
            snapshots = load_snapshots(scope)
        except (RuntimeError, OSError, ValueError, ConnectionError) as exc:
            st.error(f'实时行情加载失败：{exc}')
            if snapshots:
                st.info('已保存历史仍可通过 Replay 查看；本页不把旧数据冒充实时数据。')
            return
        selected = snapshots[-1]
        if auto_refresh:
            st_autorefresh(interval=max(60, refresh_seconds)*1000, key='heat-live')
    else:
        if not snapshots:
            st.info('暂无历史。关闭 Replay，在实时模式保持页面运行以采集快照。')
            return
        # Slider indexes are scoped so different symbols/windows never share replay position.
        key = 'replay_index_'+scope
        st.session_state.setdefault(key, len(snapshots)-1)
        back, play_col, forward = st.columns([1,2,1])
        if back.button('◀ 上一帧'):
            st.session_state[key] = max(0, st.session_state[key]-1)
        playing = play_col.toggle('▶ 播放回放', key='playing_'+scope)
        if forward.button('下一帧 ▶'):
            st.session_state[key] = min(len(snapshots)-1, st.session_state[key]+1)
        if playing:
            tick = st_autorefresh(interval=1500, key='play_tick_'+scope)
            old_tick = st.session_state.get('old_tick_'+scope, tick)
            if tick != old_tick:
                st.session_state[key] = min(len(snapshots)-1, st.session_state[key]+1)
            st.session_state['old_tick_'+scope] = tick
        if len(snapshots) > 1:
            index = st.select_slider('历史时间（纽约时间）', options=list(range(len(snapshots))), key=key,
                                     format_func=lambda i: stamp(snapshots[i]['ts']))
        else:
            index = 0
            st.info('只有一帧已保存快照，继续采集后可拖动时间轴。')
        selected = snapshots[index]
    quote_slot.metric(symbol, f"${selected['spot']:,.2f}")
    st.caption(f"{'历史回放' if replay else '最近采集'} · {stamp(selected['ts'])} · {len(snapshots)} 帧 · 数据约每 60 秒更新，仅采集正在查看的标的/到期范围")
    st.caption('GEX ($ / 标的变化 1%) · 红色负值 / 绿色正值；深浅按当前矩阵最大绝对值缩放。缺失格子为 —，不等于零。')
    frame = pd.DataFrame(selected['cells'])
    if frame.empty:
        st.info('当前快照无有效合约。')
        return
    mode = st.radio('面板', ['Heatmap','Structure'], horizontal=True, label_visibility='collapsed')
    if mode == 'Structure':
        structure(frame, snapshots, selected)
        return
    strikes = sorted(frame.strike.unique(), reverse=True)
    count = st.select_slider('可见行数（以现价为中心）', options=[15,25,41,61], value=25)
    center = min(range(len(strikes)), key=lambda i:abs(strikes[i]-selected['spot']))
    start = max(0, min(center-count//2, len(strikes)-count))
    shown = strikes[start:start+count]
    expiries = sorted(frame.expiry.unique())
    chosen = st.multiselect('显示到期日（最多 8 列）', expiries, default=expiries[:6], max_selections=8, key='expiries_'+scope)
    if not chosen:
        st.info('请选择至少一个到期日。')
        return
    chosen = sorted(chosen)
    grid, panel = st.columns([3,1.25])
    limit = frame.gex.abs().max()
    lookup = {(r.strike,r.expiry):r.gex for r in frame.itertuples()}
    selected_key = 'cell_'+scope
    st.session_state.setdefault(selected_key, (float(strikes[center]), chosen[0]))
    with grid:
        header = st.columns([1.1]+[1.5]*len(chosen))
        header[0].markdown('**STRIKE**')
        today = datetime.fromtimestamp(selected['ts'], NY).date()
        for col, expiry in zip(header[1:], chosen):
            dte = (datetime.strptime(expiry,'%Y-%m-%d').date()-today).days
            col.markdown(f'**{expiry[5:]}**  \n`{dte}DTE`')
        for i,strike in enumerate(shown):
            cols = st.columns([1.1]+[1.5]*len(chosen))
            cols[0].markdown(f'**{strike:,.2f}**'+(' ◀' if strike == strikes[center] else ''))
            for j, (col, expiry) in enumerate(zip(cols[1:], chosen)):
                value = lookup.get((strike,expiry))
                key = f'grid_{i}_{j}'
                color = cell_color(value if value is not None else float('nan'), limit)
                border = '#f1d46a' if st.session_state[selected_key] == (strike,expiry) else color
                st.markdown(f'<style>.st-key-{key} button {{background:{color};border:1px solid {border};color:white;width:100%;min-height:43px;padding:3px;}}</style>', unsafe_allow_html=True)
                with col.container(key=key):
                    if st.button(money(value), key=f'pick_{scope}_{strike}_{expiry}', disabled=value is None, use_container_width=True):
                        st.session_state[selected_key] = (float(strike),expiry)
                        st.rerun()
        st.caption('◀ 表示最接近现价的行权价。矩阵保留各到期日实际合约分布，空缺形成阶梯边界。')
    with panel:
        strike, expiry = st.session_state[selected_key]
        detail(snapshots, selected, strike, expiry)
    st.caption('历史保存在项目 .gex-data/history.sqlite3；重启后保留。关闭程序期间不采集，未查看的标的不采集。回放无需 OpenD 在线。')
