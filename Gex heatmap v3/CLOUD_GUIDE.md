# V3 hybrid cloud deployment

The private board is https://instance-20261115-035258.tail29d8e5.ts.net/ .
The legacy Windows URL http://127.0.0.1:8766/ redirects to this cloud board;
the local redirect process performs no financial calculations or data reads.
Source auto-sync and the tested-release cloud timer are enabled for this v3 project.
Connect the viewing computer/phone to the same Tailscale network. The API and
website share this origin. The server still listens only on 127.0.0.1:8766.

## Responsibilities

Underlying TICKER and official K_1M subscriptions push into a bounded memory
cache, independent of chain collection and SQLite writes. The cloud price API
merges these observed trades/candles and polls every2 seconds; Spot retains its
own real trade timestamp. Unchanged historical candles are not rewritten to
SQLite. Visible roots get foreground collection priority while other default
roots continue archival collection. Replay excludes these live overlays.

The symbol picker is a dark watchlist with observed Last/Chg/Chg%, search and
the original validated OpenD-code input. Structural ladder markers share the
underlying price positions with the Spot marker, and combine coincident roles.
Replay playback waits for historical frames and focused-chart analysis before
advancing; missing recorded chains or prior-close IV remain explicitly missing.

Expiry menus use the entire OpenD expiration directory, rather than six sampled
dates. Recent six expiries retain automatic collection. Selecting a dated expiry
adds that expiry's chain and snapshots for that root; at most one additional
selected expiry per root is retained in the active collection set. Far-expiry
history starts when selected, and no uncollected earlier GEX is synthesized.
This bounds the 1 GB server workload while allowing any listed expiry to load.

Option QUOTE push subscriptions select up to six paired ATM strikes from the
nearest unexpired sampled expiry per root (12 contracts/root, global cap156).
Live quote timestamps within120 seconds mark that root dirty; repeated events
coalesce, with a minimum10-second post-completion delay before triggering a
fresh full-chain snapshot. Existing snapshot rate limits and single-worker
queue still apply. No partial Greek overlay or historical backfill is performed.
Subscription failures preserve periodic snapshots. `optionStream` in each new
snapshot reports subscribed contracts, accepted push count/time and errors.

Cloud history collection runs without an open browser for SPXW, SPY, QQQ,
IWM, AAPL, MSFT, NVDA, AMZN, GOOGL, META and TSLA. SPX uses the same SPXW
option archive, not a duplicate collector; unavailable cash-index quotes are
not fabricated. Optional server-only `GEX_HISTORY_SYMBOLS` is a comma-separated
override. Collection remains serial with shared rate limits; 30 seconds is the
minimum delay after completion, not a guaranteed per-symbol interval. Price bars,
option captures and strike samples retain the existing rolling 10-calendar-day
window in cloud SQLite; Supabase mirrors the latest snapshot only. New symbols
accumulate history from activation, with no invented earlier option snapshots.

- Windows: logged-in OpenD on 127.0.0.1:11111 and a forwarding-only SSH tunnel.
- Cloud: shared collection, SQLite history, GEX/VEX, Zero Gamma, historical
  nodes, Velocity/Halo, touch counts and exposure center. Cloud analysis uses
  exactly the same pure JS calculation modules as local mode, through bounded
  Node subprocesses, with cached/coalesced results.
- Browser: current display formatting, price-coordinate conversion, chart
  drawing and interaction. Rendering is still local; zero browser memory usage
  is impossible. Heavy history calculations and raw historical chains are no
  longer required by the cloud viewer. Small current-frame calculations remain.
- Supabase: only latest structured snapshots; raw chains/history stay in cloud
  SQLite. Table `public.gex_latest_snapshots` uses RLS and no browser-role grants.

The Windows task `GEX v3 OpenD private tunnel` runs a console-free Python
supervisor at user logon and retries the tunnel automatically. It uses an ignored private key under
`data/cloud-tunnel`, never a key in GitHub. The dedicated cloud SSH listener is
Tailscale-address-only port 2222 and permits only forwarding to loopback 11111,
not shells or arbitrary ports. OpenD, Windows and Tailscale must remain online.
Existing cached cloud data survives a disconnected laptop, but cannot update.

## Development and deployment

Open this original local v3 folder in VS Code. Tasks:

Automatic source synchronization is enabled by the background Windows task
`GEX v3 source auto-sync` (also starts at user logon). Saving source changes
starts a 20-second debounce, then creates a commit and pushes it. Generated data,
credentials, databases, dependencies and logs are excluded. Logs are available
at `data/autosync.log`. Pause that Windows task to work without publishing.
The VS Code tasks below are optional manual controls; do not launch a second
watcher unless the background task is paused.

1. `GEX v3: Publish to GitHub and cloud` (default build task): copy only tracked
   source candidates into `data/git-workspace`, commit and push to GitHub.
2. `GEX v3: Auto-sync saved changes`: watch source files, debounce saves by
   20 seconds, and commit/push automatically. The first push requires signing
   into the correct GitHub account through Git Credential Manager. Credentials
   belong in Windows Credential Manager, never in this project.

GitHub Actions must live at the repository-root path
`.github/workflows/gex-v3.yml`; its source template is
`Gex heatmap v3/cloud/github-actions.yml`. Only v3 business code is changed;
v2 is preserved. CI tests first and then advances the `gex-v3-tested` tag.
The cloud checks this tested ref every two minutes, verifies again, switches
the release symlink, restarts the service and rolls back on health failure.
Python dependencies are pinned and cached in separate virtual environments by
the requirements hash. A release failure restores both code and interpreter.
No GitHub or Google Cloud SSH secrets are needed in Actions.

Cloud layout: `~/gex-cloud/releases`, `current`, `data`, `runtime`, `cloud.env`.
Only source releases change during deployment. Database, connection credentials
and tunnel authorization live outside releases. The pre-existing
`~/moomoo-gex` checkout, its local edits and `.env` are preserved.

`gex-board.service` has a 650MB memory-high threshold, 850MB hard limit, and
1GB swap allowance; BLAS worker counts are limited to one. This is a free-tier
resource guard, not a promise that all future workloads fit in 1GB. Monitor
CPU, storage and outbound traffic; free plans have usage limits.

## Historical coverage

A streamed one-time import preserves 552 sampled captures, 3962 price bars and
recorded SPX basis anchors for Nov 13, 2026. This is a subset of the original
local archive, not a claim that every old 1-minute capture was migrated.
Older periods remain in the original local database. Import/export scripts
preserve original timestamps and values; no missing samples are synthesized.
New cloud captures accumulate independently. Replay fetches its exact latest
eligible complete capture separately from lightweight chart history, preventing
seek-back from selecting an empty metadata-only snapshot. Future option data is
excluded. Initial empty-history or expired-IV states stay explicitly unavailable.

Supabase `DATABASE_URL` is read from the server-only `~/gex-cloud/cloud.env`
(mode 600). Never copy this file, the original `.env`, or local data into GitHub.
