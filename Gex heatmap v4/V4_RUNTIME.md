# GEX Heatmap V4

V4 source is restored to the V3 baseline at commit `4fb022b40acb0949241dd4b668289099cf265a90`. The browser defaults to local calculation and migrates an existing browser preference from Cloud to Local once. Cloud mode remains an explicit opt-in for later testing.

The local board reads and writes its local SQLite database. Cloud data imports are additive: existing local records win duplicate keys, and the cloud source database is kept intact. Do not replace the local database file during imports. V4 deployment scripts remain available for a later cloud test.