# Moomoo GEX Dashboard

A local Windows dashboard that reads US options data from moomoo OpenD and estimates gamma exposure by strike.

## Requirements

- Windows with the moomoo desktop app and OpenD installed
- An active moomoo login and the relevant US options market-data permissions
- Python 3.10+

The application does not bypass a subscription or provide market data itself. Available fields and update rates depend on the account and OpenD access.

## Run

In PowerShell, from this folder:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
py -m streamlit run app.py
```

Keep OpenD running and logged in. The dashboard defaults to `127.0.0.1:11111`, QQQ, a 14-day expiration window, and a 15-second refresh interval. Settings can be changed in the sidebar.

## Calculation notes

Per-contract exposure is estimated as `signed gamma × open interest × 100 × underlying price² × 1%`. Calls are assigned positive and puts negative exposure, a commonly used dealer-position convention. This convention is an assumption; the calculation does not reveal dealer books. Call/Put Walls are the highest absolute exposure strike on the respective side in the selected expiration window.

Open interest is generally updated less frequently than prices and Greeks. Thus, refreshing the dashboard does not guarantee that every input is real-time. The app reports errors when OpenD does not return required data rather than substituting fabricated values.

## Navigation update

The left sidebar provides GEX, funds flow, heatmap, momentum, volatility, alerts, watchlist, and notes. Only GEX and the preset watchlist are implemented; other sections are explicitly marked as pending.

Select a ticker in the top bar or open one from the watchlist. Connection settings and refresh interval are under the gear button. Expiry presets retain calendar-day semantics (Weekly = next 7 days). No new dependencies are needed.

## Expiry heatmap and replay

Copy both app.py and heatmap.py into the same project directory. No additional packages are required. Select 热力图, an underlying and an expiry window (e.g. 14D), then keep live mode open. Option snapshots are cached for 60 seconds to avoid re-requesting the full chain for every click.

Rows are descending strikes near spot; columns are actual expiry dates with DTE calculated from the snapshot's New York date. Use the expiry multiselect and row-count control. Green is positive net GEX, red is negative; intensity is relative to the current matrix maximum. Missing strike/expiry combinations remain missing. Click a populated cell for details, observed history, and 1H/4H changes. Weekly continues to mean the next seven calendar days.

Snapshots are persisted in .gex-data/history.sqlite3 for the currently viewed ticker, connection and expiry window. Replay loads these snapshots without OpenD requests, supports previous/next, a time selector and automatic playback. It cannot recover data from before collection began, when the app was closed, or for unviewed symbols. Different expiry-window histories are isolated. Do not delete .gex-data if you want to retain history, and do not commit that directory to Git.

Structure metrics: King is the maximum absolute net GEX strike; Major Positive/Negative are extrema of signed net GEX by strike; Call/Put Walls use the respective side independently of net sign; Active Call/Put use reported snapshot volume. Max Change 1/5 Min is the largest absolute cell change, retaining its sign, only where both snapshot coverages match exactly and an adequately timed historical sample exists. Missing inputs display a dash. These definitions are explicit local conventions, not a claim of matching a proprietary vendor's model.
