# Gex heatmap v2 for TradingView

1. Open a TradingView chart's Pine Editor, paste [`GexHeatmapV2.pine`](./GexHeatmapV2.pine), save, and add it to the chart.
2. In the OpenD board, set the symbol, expiry, strike count, Top N and `% King`; click **Export gex levels** → **Copy for TradingView indicator**.
3. Paste the complete multiline `GEX2` block into the indicator's **Snapshot input (GEX2)** setting.
4. Use a chart with the same symbol and New York date. `SPXW` option strikes display only on a cash `SPX` chart, such as `TVC:SPX`; they are deliberately hidden on the `FOREXCOM:SPXUSD` CFD chart because the board has no verified cash to CFD mapping.

The gold and purple bubbles show the selected positive and negative net GEX strikes. Bubble opacity and size use each selected strike's absolute GEX as a percentage of the strongest valid strike in the board's current visible strike range. The King line is gold; Call Wall is cyan, Put Wall is pink, and a coincident wall is combined. The fixed Day Expected Range is blue dashed when the board has a verified value. The reference line is labeled `Spot`, `Delayed`, or `REF` from the captured board data.

The old seven-field `GEX snapshot` row remains available in the same dialog. `GEX2` is a separate format because seven fields cannot contain signed GEX node values. The indicator is a pasted, time-stamped snapshot. Pine does not read the local OpenD service or automatically refresh when the board changes. A missing fixed Day Range is `na`; it is never filled from the Live Cone. This script does not fabricate historical node trails, Velocity, Replay state, derived SPX to CFD nodes, or a Live Cone from one static snapshot.

