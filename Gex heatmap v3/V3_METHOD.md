# V3 methods and validation boundaries

V3 is the active development directory. V2 remains frozen.

## Metrics

GEX/VEX (Shift+G / Shift+V) share the signed OI convention across ladders, matrix,
historical nodes and gravity. VEX is a local r=q=0 ACT/365 estimate per one
absolute volatility percentage point. It uses immutable capture price, observed
IV and exact expiry close. Missing IV/time inputs are unavailable, including old
archives with insufficient settlement metadata. Neither sign convention proves
dealer inventory. Formula reference:
https://strata.opengamma.io/apidocs/com/opengamma/strata/pricer/impl/option/BlackFormulaRepository.html

Sampling uses 96 nearest strikes in each of the first two expiries and 68 in
later expiries, plus listed 50-point SPXW / 10-dollar other-symbol strikes within
8% of reference. Listing directories distinguish unlisted expiry strikes from
known missing samples. Older archives have no verified listing directory.
Velocity still requires identical contract sets; widening sampling cannot
recover strikes never collected historically.

## Local descriptive roles

- King: maximum absolute exposure.
- Gatekeeper: nearest strike with at least 10% of full-universe King.
- Ceiling / Floor: strongest strike above / below reference.
- Air Pocket: at least two contiguous observed strikes below 3% of King.
- Pika / Barney: positive / negative exposure.
- Profile Flip: adjacent-strike signed exposure linear crossing; distinct from
  the independent 0DTE Volume Zero Gamma.
- Halo: at least two valid 1/5/15/30-minute magnitude changes of at least 3% in
  one direction. Top Movers ranks 5-minute magnitude changes. Growing exposure
  is not proven new positioning.

These are documented local heuristics, not Skylit proprietary definitions.

Touch counts measure distinct observed closed 1m RTH encounters, merging
consecutive touching candles. Coarser bars and missing RTH session start cannot
establish Fresh. Sparse data cannot establish unobserved touches.

GEX VWAP is a display name for absolute-exposure-weighted strike center with
plus/minus one weighted standard-deviation band, not traded-volume VWAP.
Every historical sample obeys the Replay cutoff. Open/Noon/Close jumps use ET.

% King, Dim Low, Track, Draw and Hide are display controls and do not change raw
calculations. Right-click a strike to inspect roles and raw dollar exposure.
Export remains GEX-only and is disabled while viewing VEX. VEX hover history is
derived from original archived snapshots without loading the entire day into
memory. SQLite uses WAL, retention timestamp indexes and cleanup once per
30 minutes. Market history stays local and is excluded from GitHub.
