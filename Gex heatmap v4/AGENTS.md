# Gex heatmap v4

This is the active project version. Make future code changes in this folder and publish them to `Gex heatmap v4` in `gongxy810/moomoo-gex`.

- The application baseline is the full `Gex heatmap v3` tree at GitHub commit `e9a63370cfecf168af5dba1b13e19c2fbc37857d` (the version shown as `e9a6337` in the user's Saturday 8:01 PM screenshot).
- Keep the v2 and v3 GitHub folders unchanged.
- `data/`, local databases, credentials, virtual environments, and generated browser artifacts are excluded from GitHub.
- The hosted board uses the V4 `web/` application with the currently deployed backend. Release overlays change only `Gex heatmap v3/web` in a deployment-only commit; the `main` branch's V3 source remains unchanged.
- The cloud SQLite database is stored outside release directories. Deployments must never migrate, replace, prune, or copy it.
