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
- Bar Replay supports chart selection, ET date/time entry, Play/Pause, interval stepping, 0.5x/1x/2x/5x/10x speeds and Live exit. ET inputs show the replay cutoff; chart candles are shown only after their full period closes. Space toggles playback and Right Arrow steps when focus is outside controls. The frontend suspends live polling while replaying, discards earlier in-flight live responses, and resumes on Live exit; shared backend collection continues. GEX uses only the last stored capture at or before the cursor, with missing history shown explicitly.
- Replay's Update Interval is independent of the chart timeframe. Its dark menu offers 1 minute / 5 minutes and Auto select interval (follow chart timeframe). Tick and second choices are disabled because this store has no archived tick/second price bars.
- Strike rows show a dark hover card with the signed OI-model value, an observed session sparkline and 15M / 1H / 4H changes. `GET /api/strike-history?symbol=SPY&strike=756&expiries=2026-11-12&date=2026-11-12&asof=2026-11-12T20:30:00Z` returns the structure. The SQLite index preserves original capture timestamps, selects the last observed sample per minute only after applying the cutoff, and sums selected expiries only at a common complete capture. Existing captures are indexed lazily once per symbol/session; the initial recovery can take longer than later indexed lookups.
- Hover comparisons use `current − prior` and percentage `delta / abs(prior) × 100`; a zero prior produces no percentage. The nearest prior baseline must be within 15 minutes of the target. CHANGE has separate 15M, 1H, 4H and OPEN rows. The 4H row compares the actual four-hour target and stays unavailable if no valid baseline exists; OPEN separately compares the first observed open sample. Gaps remain missing, and Replay cannot consume future captures. These hover changes are separate from the board's magnitude-based Velocity calculation.
- The price chart compresses closed overnight periods: background GEX captures between 20:00 and 04:00 cannot create empty time-axis slots. Actual candle timestamps and OHLC stay unchanged. PRE is shaded pale orange and POST pale blue beneath candles/nodes, including PNG exports; New York DST, trading dates and calendar early closes determine the bands.
- Historical price responses merge into the candle cache and never replace the current price payload. The Live chart reads the complete cached series; prepending older bars preserves the dragged view using a stable candle reference and keeps a manual price range. Empty history responses keep existing candles visible. PRE shading uses 13.2% opacity and POST 15.6% (10% and 30% stronger respectively than the initial 12%).
- The hover sparkline connects actual observations at equal horizontal spacing, compressing missing intervals instead of leaving blank sections or breaking the path. No synthetic samples are inserted; original timestamps still determine 15M / 1H / 4H comparisons and Replay cutoffs.
- The hover value font is 21.7px (30% smaller than 31px). Its `1M / 4H` graph shows only actual minute samples in the four hours ending at the displayed snapshot cutoff, or the Replay cursor. The full session index remains available for change baselines and OPEN fallback.
- `GET /api/zero-gamma?symbol=SPY&expiries=2026-11-13&asof=2026-11-13T19:08:50Z` reads an exact `capture` or the latest snapshot at/before the cutoff. The active model is `0dte-volume-linear-v1`: always uses the cutoff's New York date expiry, independently of the heatmap expiry filter and SPX proxy basis expiry. Each strike nets `gamma * session cumulative volume * multiplier * reference_price^2 * .01` (calls positive, puts negative). Adjacent negative-to-positive strikes are interpolated linearly, choosing the crossing nearest the snapshot price reference (REF for SPXW); ties prefer larger combined endpoint magnitude. Missing/future/prior-day inputs and old captures without Volume/Gamma report unavailable; OI is never substituted. Multiple crossings and endpoint exposures are returned for inspection. This is a local linear estimate, not an exact reproduction of gex.bot's documented spline. Historical replay never reads later snapshots. All captured 0DTE strikes are used independently of visible strike cropping. Backend results are cached per snapshot/selection/cutoff. The earlier repriced OI implementation remains available only as the internal `oi_gamma_flip` function and is not the chart's Zero Gamma.

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
