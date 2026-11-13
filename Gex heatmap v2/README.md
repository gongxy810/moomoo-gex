# Gex heatmap v2

Local, read-only OpenD GEX heatmap and price chart for SPXW, SPY, QQQ and selectable US option symbols. The board uses Moomoo OpenD for options and supported prices. It never places orders and binds only to `127.0.0.1`.

## Start on Windows

1. Install Python 3.10+ and Moomoo OpenD. Log in to OpenD and enable its local quote service (default port `11111`).
2. Install dependencies: `py -m venv .venv` and `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`.
3. Run `start-windows.cmd` and open `http://127.0.0.1:8766/`.

The official Lightweight Charts 5.2.1 bundle and its license are in `web/vendor`. Node is needed only for development tests or packaging. Run `npm ci`, then `npm test` and `npm run package` as needed. Packaging creates `dist/opend-gex-relay.zip` and the local web download file.

## Data boundaries

- SPXW options use OpenD's SPXW chain. The option-implied forward is labeled **REF** and is not treated as the SPX cash index.
- When cash SPX bars are unavailable, SPXW uses **SPY × 10 + Basis**. Calibration uses the nearest non-today SPXW expiry, ATM ±15 around the preliminary implied-forward center, at least three pairs, bid > 0, spread ≤0.40, quote age ≤90s and pair skew ≤30s. The forward uses an explicit assumed rate 4.3%, ACT/365. It remains an estimated forward proxy, with no verified cash-index accuracy guarantee. GEX expiry selection is independent.
- Basis is the rolling median of 12 raw observations, limited to 0.20 points per new observation. Each accepted value and its capture time are persisted in SQLite. Each candle uses only a Basis known by its start; changing chart windows does not recompute the filter. At calendar RTH close minus five minutes, the final valid Basis locks. SPY extended-session candles continue with **ETH · Locked Basis**; SPY's own feed limitations still apply. Replay excludes future calibrations. Missing calibration leaves gaps rather than applying a later value to earlier bars.
- The collector archives original option IV and price snapshots during the five minutes before calendar RTH close, including early closes and DST. These records survive the rolling capture retention. Fixed Day Range still requires a fresh, verifiable cash-price/IV observation near the prior close; pre-close proxy records cannot manufacture a cash SPX range.
- A valid authorized SPX cash price provider can be connected through `providers.py`; the existing self-drawn chart then uses native SPXW strikes on the SPX price axis.
- Day Range and Live Cone require valid, time-matched cash prices and option IV. Missing inputs are shown as unavailable. Replay excludes data after its cursor.
- `Export gex levels` beside Refresh opens a copyable `GEX snapshot` CSV row for the focused symbol. It uses the selected heatmap's Put Wall, Call Wall and King, plus the fixed prior-close Day Range ±1σ prices. If any field or the New York date is missing, copying is disabled so an old range cannot be pasted as today's level.
- The `GEX by expiration` matrix colors displayed cells by positive and negative GEX separately. Gold and purple outlines mark each side's three largest cells; the labels above the matrix show their expiration and strike. The underlying GEX calculation is unchanged.

The `data/` directory contains local captures and configuration and is intentionally excluded from version control. Browser test profiles, generated screenshots, local logs, virtual environments, and package ZIPs are excluded as well. No market data, credentials, or personal browser state are required to clone this source.

## Verify

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
npm test
node tests/browser.mjs --spx-cash
node tests/browser.mjs --live --focus-switch
```

The `--spx-cash` browser check uses a clearly labeled synthetic cash index fixture to verify the native cash path. The `--focus-switch` check covers the SPY → SPXW → SPY self-drawn proxy path. Neither fixture establishes that live SPX cash bars are available. The `--live` check uses your running local OpenD board.

