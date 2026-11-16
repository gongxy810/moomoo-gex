# V4 checkpoint and hosted runtime

V4 starts from commit `e9a63370cfecf168af5dba1b13e19c2fbc37857d`, selected from the screenshot labeled Saturday 8:01 PM. The V4 browser files preserve that version's appearance and calculations. Their history requests include `raw=1` so the current cloud API supplies the stored GEX captures needed for browser-side history, VEX, and chart bubbles.

The hosted runtime keeps the current backend because it owns the existing OpenD connection and cloud SQLite database. The V4 release workflow creates a deployment-only Git commit that overlays `Gex heatmap v4/web` onto the current backend's release directory. It updates the existing `gex-v3-tested` deployment tag; it does not modify the V3 source directory on GitHub main or the database.
