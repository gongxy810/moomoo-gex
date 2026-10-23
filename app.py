from __future__ import annotations

import os
import time
from datetime import date, timedelta
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from moomoo import OpenQuoteContext
from streamlit_autorefresh import st_autorefresh


st.set_page_config(page_title="Moomoo GEX", page_icon="📊", layout="wide")

GREEN = "#00c8a0"
RED = "#ff5263"
CYAN = "#00c7e8"
BG = "#091017"


def _field(data: pd.DataFrame, names: tuple[str, ...]) -> str | None:
    for name in names:
        if name in data.columns:
            return name
    return None


def _value(row: pd.Series, names: tuple[str, ...], default: float = 0.0) -> float:
    for name in names:
        if name in row.index and pd.notna(row[name]):
            try:
                return float(row[name])
            except (TypeError, ValueError):
                continue
    return default


@st.cache_resource
def get_quote_context(host: str, port: int) -> OpenQuoteContext:
    return OpenQuoteContext(host=host, port=port)


@st.cache_data(ttl=60, show_spinner=False)
def fetch_gex(
    symbol: str, days_out: int, host: str, port: int
) -> tuple[float, pd.DataFrame, pd.DataFrame]:
    from moomoo import KLType, RET_OK, SubType

    quote = get_quote_context(host, port)
    code = symbol.strip().upper()
    if not code.startswith("US."):
        code = f"US.{code}"

    ret, underlying = quote.get_market_snapshot([code])
    if ret != RET_OK:
        raise RuntimeError(f"读取标的行情失败：{underlying}")
    if underlying.empty:
        raise RuntimeError(f"没有取得 {code} 的标的行情。")
    spot = _value(underlying.iloc[0], ("last_price", "close_price"))
    if spot <= 0:
        raise RuntimeError(f"{code} 的最新价格无效。")

    ret, result = quote.subscribe([code], [SubType.K_1M])
    if ret != RET_OK:
        raise RuntimeError(f"订阅标的 K 线失败：{result}")
    ret, candles = quote.get_cur_kline(code, num=120, ktype=KLType.K_1M)
    if ret != RET_OK:
        raise RuntimeError(f"读取标的 K 线失败：{candles}")

    today = date.today()
    expiry_end = today + timedelta(days=days_out)
    ret, chain = quote.get_option_chain(
        code,
        start=today.strftime("%Y-%m-%d"),
        end=expiry_end.strftime("%Y-%m-%d"),
    )
    if ret != RET_OK:
        raise RuntimeError(f"读取期权链失败：{chain}")
    if chain.empty or "code" not in chain.columns:
        raise RuntimeError(f"{code} 在所选到期范围内没有期权合约。")

    records: list[pd.DataFrame] = []
    contract_codes = chain["code"].dropna().astype(str).tolist()
    for offset in range(0, len(contract_codes), 200):
        ret, snapshot = quote.get_market_snapshot(contract_codes[offset : offset + 200])
        if ret != RET_OK:
            raise RuntimeError(f"读取期权快照失败：{snapshot}")
        if not snapshot.empty:
            records.append(snapshot)
    if not records:
        raise RuntimeError("没有取得期权快照数据；请检查 OpenD 行情权限和连接状态。")

    options = pd.concat(records, ignore_index=True)
    gamma_col = _field(options, ("option_gamma", "gamma"))
    oi_col = _field(options, ("option_open_interest", "open_interest"))
    if not all((gamma_col, oi_col)):
        missing = [
            label
            for label, col in (
                ("Gamma", gamma_col),
                ("未平仓量", oi_col),
            )
            if col is None
        ]
        raise RuntimeError(
            "moomoo 快照没有返回计算 GEX 所需字段："
            + "、".join(missing)
            + "。请确认 OpenD/API 版本与账户行情权限。"
        )

    merged = chain.merge(options, on="code", how="inner", suffixes=("_chain", ""))
    strike_col = _field(merged, ("strike_price", "strike_price_chain"))
    gamma_col = _field(merged, ("option_gamma", "gamma"))
    oi_col = _field(merged, ("option_open_interest", "open_interest"))
    type_col = _field(merged, ("option_type", "option_type_chain"))
    if not all((strike_col, gamma_col, oi_col, type_col)):
        raise RuntimeError("期权链和快照无法匹配出行权价、Gamma、未平仓量或期权类型。")

    merged["strike"] = pd.to_numeric(merged[strike_col], errors="coerce")
    merged["gamma"] = pd.to_numeric(merged[gamma_col], errors="coerce")
    merged["open_interest"] = pd.to_numeric(merged[oi_col], errors="coerce")
    merged = merged.dropna(subset=["strike", "gamma", "open_interest"])

    if merged.empty:
        raise RuntimeError("没有有效的 Gamma / 未平仓量数据。")

    # This common dealer-position convention treats calls as positive and puts as negative.
    # It is an estimate, not a view of market-maker books.
    option_types = merged[type_col].astype(str).str.lower()
    merged["sign"] = option_types.map(
        lambda value: 1.0
        if "call" in value or value in {"c", "1"}
        else -1.0
        if "put" in value or value in {"p", "2"}
        else None
    )
    if merged["sign"].isna().any():
        raise RuntimeError("moomoo 返回了无法识别的期权类型，无法安全计算 Call/Put GEX。")
    merged["gex"] = (
        merged["sign"]
        * merged["gamma"].abs()
        * merged["open_interest"]
        * 100
        * spot**2
        * 0.01
    )
    merged["call_gex"] = merged["gex"].where(merged["sign"] > 0, 0)
    merged["put_gex"] = merged["gex"].where(merged["sign"] < 0, 0)
    by_strike = merged.groupby("strike", as_index=False).agg(
        gex=("gex", "sum"), call_gex=("call_gex", "sum"), put_gex=("put_gex", "sum")
    )
    expiry_col = _field(merged, ("strike_time", "strike_time_chain", "option_expiry_date", "expiry_date"))
    if expiry_col is not None:
        merged["expiry"] = pd.to_datetime(merged[expiry_col], errors="coerce").dt.strftime("%Y-%m-%d")
        if merged["expiry"].isna().any():
            raise RuntimeError("部分合约到期日无效，无法安全生成到期日热力图。")
        cells = merged.groupby(["strike", "expiry"], as_index=False).agg(
            gex=("gex", "sum"), call_gex=("call_gex", "sum"), put_gex=("put_gex", "sum")
        )
        volume_col = _field(merged, ("volume",))
        if volume_col:
            merged["call_volume"] = pd.to_numeric(merged[volume_col], errors="coerce").where(merged["sign"] > 0, 0)
            merged["put_volume"] = pd.to_numeric(merged[volume_col], errors="coerce").where(merged["sign"] < 0, 0)
            volumes = merged.groupby(["strike", "expiry"], as_index=False)[["call_volume", "put_volume"]].sum(min_count=1)
            cells = cells.merge(volumes, on=["strike", "expiry"])
        by_strike.attrs["cells"] = cells.to_dict("records")
    by_strike.attrs["captured_at"] = time.time()
    return spot, by_strike.sort_values("strike"), candles


def make_chart(data: pd.DataFrame, spot: float) -> go.Figure:
    colors = [GREEN if value >= 0 else RED for value in data["gex"]]
    fig = go.Figure(
        go.Bar(
            x=data["gex"] / 1_000_000,
            y=data["strike"],
            orientation="h",
            marker_color=colors,
            customdata=data[["call_gex", "put_gex"]].to_numpy() / 1_000_000,
            hovertemplate=(
                "Strike: $%{y:.2f}<br>Net GEX: %{x:.2f}M"
                "<br>Call GEX: %{customdata[0]:.2f}M"
                "<br>Put GEX: %{customdata[1]:.2f}M<extra></extra>"
            ),
        )
    )
    fig.add_hline(y=spot, line_color=CYAN, line_dash="dash", annotation_text=f"现价 ${spot:.2f}")
    fig.add_vline(x=0, line_color="#73808c", line_width=1)
    fig.update_layout(
        height=600,
        template="plotly_dark",
        paper_bgcolor=BG,
        plot_bgcolor=BG,
        margin=dict(l=10, r=20, t=20, b=30),
        xaxis_title="估算 GEX（百万美元 / 标的变动 1%）",
        yaxis_title="行权价",
        yaxis=dict(autorange="reversed" if data["strike"].iloc[-1] < spot else True),
        showlegend=False,
    )
    return fig


def make_price_chart(candles: pd.DataFrame, spot: float, call_wall: float | None, put_wall: float | None, symbol: str = "QQQ") -> go.Figure:
    required = {"time_key", "open", "high", "low", "close"}
    if candles.empty or not required.issubset(candles.columns):
        raise RuntimeError("moomoo 返回的 K 线缺少时间或 OHLC 字段。")
    fig = go.Figure(
        go.Candlestick(
            x=candles["time_key"],
            open=candles["open"],
            high=candles["high"],
            low=candles["low"],
            close=candles["close"],
            increasing_line_color=GREEN,
            decreasing_line_color=RED,
            name=symbol,
        )
    )
    fig.add_hline(y=spot, line_color=CYAN, line_dash="dash", annotation_text=f"现价 ${spot:.2f}")
    if call_wall is not None:
        fig.add_hline(y=call_wall, line_color=GREEN, line_dash="dot", annotation_text=f"Call Wall ${call_wall:.2f}")
    if put_wall is not None:
        fig.add_hline(y=put_wall, line_color=RED, line_dash="dot", annotation_text=f"Put Wall ${put_wall:.2f}")
    fig.update_layout(
        height=420,
        template="plotly_dark",
        paper_bgcolor=BG,
        plot_bgcolor=BG,
        margin=dict(l=10, r=20, t=15, b=25),
        xaxis_rangeslider_visible=False,
        yaxis_title="价格（USD）",
        showlegend=False,
    )
    return fig


WATCHLIST = ["TSLA", "AAPL", "AMZN", "META", "GOOG", "MSFT", "INTC", "AMD", "IGV", "MU", "SNDK", "NOW", "NVDA"]
SYMBOLS = ["QQQ", "SPY", "IWM", *WATCHLIST]
NAMES = {
    "QQQ": "Invesco QQQ Trust", "SPY": "SPDR S&P 500 ETF Trust", "IWM": "iShares Russell 2000 ETF",
    "TSLA": "Tesla", "AAPL": "Apple", "AMZN": "Amazon", "META": "Meta Platforms",
    "GOOG": "Alphabet", "MSFT": "Microsoft", "INTC": "Intel", "AMD": "Advanced Micro Devices",
    "IGV": "iShares Expanded Tech-Software ETF", "MU": "Micron Technology",
    "SNDK": "Sandisk", "NOW": "ServiceNow", "NVDA": "NVIDIA",
}
PAGES = ["GEX", "资金流", "热力图", "动能雷达", "波动率", "报警", "自选列表", "笔记"]
ICONS = ["∿", "≋", "▦", "ϟ", "⌁", "♧", "☆", "▤"]

st.markdown("""
<style>
:root { color-scheme: dark; }
.stApp, [data-testid="stHeader"] { background:#090f15; color:#e6edf3; }
[data-testid="stSidebar"] { background:#080d12; border-right:1px solid #1d2a35; min-width:180px; max-width:220px; }
[data-testid="stSidebar"] [data-testid="stButton"] button { min-height:58px; justify-content:flex-start; }
[data-testid="stSidebar"] [data-testid="stButton"] button[kind="primary"] { background:#09202d; color:#17c9fc; border:1px solid #15516a; border-left:4px solid #17c9fc; }
.stApp p, .stApp label, [data-testid="stMetricLabel"] { color:#a7b8c8; }
.stApp h1, .stApp h2, .stApp h3 { color:#e6edf3; }
[data-testid="stMetric"] { background:#111b25; padding:14px; border-radius:10px; border:1px solid #1b2b38; }
[data-testid="stMetricValue"] { color:#e6edf3; }
[data-baseweb="select"] > div, [data-baseweb="input"], [data-baseweb="input"] input { background:#111b25; color:#e6edf3; }
[data-testid="stButton"] button { background:#101923; color:#b8c9d8; border:1px solid #253442; border-radius:8px; }
[data-testid="stButton"] button:hover { color:#17c9fc; border-color:#17c9fc; }
.block-container { padding-top:2rem; }
</style>
""", unsafe_allow_html=True)

st.session_state.setdefault("page", "GEX")
st.session_state.setdefault("ticker", "QQQ")
if "pending_ticker" in st.session_state:
    st.session_state.ticker = st.session_state.pop("pending_ticker")

with st.sidebar:
    st.markdown("### ◈ MOOMOO")
    st.caption("OPTIONS WORKSPACE")
    for page, icon in zip(PAGES, ICONS):
        if st.button(f"{icon}　{page}", key=f"nav_{page}", use_container_width=True,
                     type="primary" if st.session_state.page == page else "secondary"):
            st.session_state.page = page
            st.rerun()
    st.divider()
    st.caption("行情源 · moomoo OpenD")
    st.caption("本机连接 / 只读行情")

# All controls remain available even when OpenD is offline.
selector, quote_slot_col, expiry_col, pulse_col, refresh_col, help_col, settings_col = st.columns([1.4, 2.6, 2.3, 1.2, .7, .7, .7], vertical_alignment="center")
with selector:
    symbol = st.selectbox("标的", SYMBOLS, key="ticker", label_visibility="collapsed")
with quote_slot_col:
    quote_slot = st.empty()
    quote_slot.markdown(f"### {symbol} · —")
    st.caption(NAMES[symbol])
with expiry_col:
    expiry = st.selectbox("到期范围", ["0DTE", "1DTE", "Weekly", "14D", "30D", "60D"], index=3, label_visibility="collapsed")
    days_out = {"0DTE": 0, "1DTE": 1, "Weekly": 7, "14D": 14, "30D": 30, "60D": 60}[expiry]
with pulse_col:
    auto_refresh = st.toggle("自动刷新", value=True)
with refresh_col:
    st.button("↻", help="立即重新读取当前标的行情", use_container_width=True)
with help_col:
    with st.popover("？", use_container_width=True):
        st.markdown("**使用说明**")
        st.write("左侧切换分区，顶部下拉切换标的。到期范围按今天至未来日历天筛选；Weekly 表示未来 7 天，并非指定周到期日。")
        st.write("自动刷新在 GEX 和热力图实时页面运行；行情读取缓存约 60 秒，回放不请求新行情。价格与 GEX 成功读取后才显示；未连接时不使用模拟数据。")
        st.caption("GEX 是持仓方向假设下的模型估算，不代表做市商真实持仓。")
with settings_col:
    with st.popover("⚙", use_container_width=True):
        st.markdown("**行情连接设置**")
        host = st.text_input("OpenD 地址", value=os.getenv("MOOMOO_OPEND_HOST", "127.0.0.1"))
        port = st.number_input("OpenD 端口", min_value=1, max_value=65535, value=int(os.getenv("MOOMOO_OPEND_PORT", "11111")))
        refresh_seconds = st.selectbox("刷新间隔（秒）", [5, 10, 15, 30, 60], index=2)
        st.caption("Windows 上的 OpenD 需保持登录。本页不执行交易操作。")
st.divider()

page = st.session_state.page
if page == "自选列表":
    st.subheader("自选列表")
    st.caption("按参考图片顺序排列；点击标的进入 GEX。价格仅在进入 GEX 并成功读取后显示，不批量请求行情。")
    for ticker in WATCHLIST:
        ticker_col, name_col, action_col = st.columns([1, 4, 1])
        ticker_col.markdown(f"**{ticker}**")
        name_col.write(NAMES[ticker])
        if action_col.button("打开 GEX", key=f"watch_{ticker}"):
            st.session_state["pending_ticker"] = ticker
            st.session_state.page = "GEX"
            st.rerun()
    st.stop()
if page == "热力图":
    from heatmap import render_heatmap
    render_heatmap(symbol, days_out, host, int(port), fetch_gex, quote_slot, auto_refresh, refresh_seconds)
    st.stop()
if page != "GEX":
    st.subheader(page)
    st.info(f"{page}分区入口已建立，具体功能待后续需求接入。")
    st.stop()

st.subheader(f"{symbol} · Gamma Exposure")
st.caption("moomoo OpenD 期权链及快照估算 · Call 正 / Put 负 · 百万美元 / 标的价格变化 1%")
if auto_refresh:
    st_autorefresh(interval=refresh_seconds * 1000, key="gex-refresh")
try:
    price, gex, candles = fetch_gex(symbol, days_out, host, int(port))
    from heatmap import save_snapshot, scope_key
    if gex.attrs.get("cells"):
        save_snapshot(scope_key(symbol, days_out, host, int(port)), price,
                      gex.attrs["cells"], gex.attrs["captured_at"])
    quote_slot.metric(symbol, f"${price:,.2f}")
    total_gex = float(gex["gex"].sum())
    positive = gex.loc[gex["gex"] > 0]
    negative = gex.loc[gex["gex"] < 0]
    call_wall = float(positive.loc[positive["call_gex"].idxmax(), "strike"]) if not positive.empty else None
    put_wall = float(negative.loc[negative["put_gex"].idxmin(), "strike"]) if not negative.empty else None
    net_gex = gex.loc[gex["gex"].abs().idxmax(), "strike"] if not gex.empty else None

    metric_cols = st.columns(4)
    metric_cols[0].metric(f"{symbol} 现价", f"${price:.2f}")
    metric_cols[1].metric("总净 GEX", f"${total_gex / 1_000_000:,.2f}M")
    metric_cols[2].metric("Call Wall", f"${call_wall:.2f}" if call_wall is not None else "—")
    metric_cols[3].metric("Put Wall", f"${put_wall:.2f}" if put_wall is not None else "—")

    chart_col, levels_col = st.columns([3, 1])
    with chart_col:
        st.subheader("标的价格 · 1 分钟")
        st.plotly_chart(make_price_chart(candles, price, call_wall, put_wall, symbol), use_container_width=True)
        st.subheader("GEX 分布 · 按行权价")
        st.plotly_chart(make_chart(gex, price), use_container_width=True)
    with levels_col:
        st.subheader("重要价位")
        if net_gex is not None:
            st.metric("最大绝对 GEX 行权价", f"${net_gex:.2f}")
        st.caption("Call / Put Wall 是所选到期范围内绝对 GEX 最大的对应侧行权价。")
        st.subheader("GEX 热区")
        st.dataframe(
            gex.assign(abs_gex=gex["gex"].abs())
            .nlargest(10, "abs_gex")[["strike", "gex", "call_gex", "put_gex"]]
            .rename(
                columns={
                    "strike": "行权价",
                    "gex": "净 GEX ($)",
                    "call_gex": "Call GEX ($)",
                    "put_gex": "Put GEX ($)",
                }
            )
            .style.format({"行权价": "${:.2f}", "净 GEX ($)": "${:,.0f}", "Call GEX ($)": "${:,.0f}", "Put GEX ($)": "${:,.0f}"}),
            hide_index=True,
            use_container_width=True,
        )
    st.caption(f"行情快照时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(gex.attrs.get('captured_at', time.time())))} · OI 可能不是盘中实时更新。")
except (RuntimeError, OSError, ValueError, ConnectionError) as exc:
    st.error(f"行情加载失败：{exc}")
    st.info("请确认 OpenD 正在运行、已登录 moomoo，并且账户/API 权限支持美股期权行情。")
