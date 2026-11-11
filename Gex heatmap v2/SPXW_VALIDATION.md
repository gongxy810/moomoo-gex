# SPXW 右图验收（2026-11-11，America/New_York）

## 实际价格源

08:17:30 ET 对 OpenD 代码 `US..SPX` 分别调用最新快照、1 分钟历史 K 线、1 分钟订阅，三者均返回原文 `暂不支持美股指数`。历史返回 **0 根**，无最新现金指数价格、时间或延迟可报告。原始结果在 `tests/browser-artifacts/spx-cash-source-check.json`。同一看板的 `/api/price?symbol=SPXW` 返回 0 根 K 线、无 Spot；SPXW 期权快照仍有 720 个可用合约。项目没有 FOREX.com 官方 API 授权，不能独立读取其分钟 OHLC 或与 Widget 同时段逐根核对。不能把期权隐含远期 `REF` 或 Widget 内 CFD 价格冒充现金指数 Spot。

## 实际看板流程

在 `http://127.0.0.1:8766/` 从 SPY 开始，分别用标的按钮和热力图 Focus 切换至 SPXW，再切回 SPY：SPXW Live 自动显示 `FOREXCOM:SPXUSD` 的 TradingView 官方 Widget，画面中有 1 分钟蜡烛；SPY 恢复自己的 OpenD 自绘 GEX 图。SPXW Widget 旁单列未映射的原始 Levels：King 7520、Call Wall 7600、Put Wall 7520、REF 7593。SPXW 热力图和 GEX 仍用 OpenD；CFD 价只留在 Widget 内。手动选择 SPXW GEX 图时显示现金指数 K 线缺失的具体原因，且不沿用 SPY 的价格轴。Replay 保留自绘模式和同一游标；历史 SPX 现金 K 线及早于回放时点的 GEX 快照缺失时明确标注。实际流程报告：`tests/browser-artifacts/focus-after.json`。

截图：

- `tests/browser-artifacts/focus-after-spx-button.png`：实际 SPXW Widget 与真实 SPXW OpenD 热力图。
- `tests/browser-artifacts/focus-after-spy-start.png`：实际 SPY 自绘 GEX 图。
- `tests/browser-artifacts/focus-after-spx-manual-gex.png`：实际 SPXW 自绘图缺少现金指数 K 线时的原因。

## 自绘图价格源夹具

用**明确标为 TEST FIXTURE 的合成 SPX 现金指数 OHLC** 验证共用的 SPY 自绘组件接线，不作为真实 SPX 行情证据：1m 有 300 根、5m 有 61 根；原生 SPXW 节点的 `rawStrike=mappedPrice`，King 7520 正好在 7520 轴；增量追加第 301 根，`chartDataMode=append`，可见逻辑范围宽度保持不变、向前滚动一根；Replay 游标截断 K 线与节点。报告 `tests/browser-artifacts/spx-cash-fixture.json`，图 `spx-cash-fixture-1m.png` / `spx-cash-fixture-5m.png`。若以后接入授权现金指数分钟行情，当前路由和共用组件可以直接使用原始 SPXW strike，无需做 CFD 映射。

## 图层状态

真实 SPXW 自绘分钟蜡烛、贴合现金指数价格轴的节点/King/Walls/REF、盘中新增现金指数 K 线、现金指数驱动的 Live Cone 及真实价格轴拖拽验收，均因现金指数分钟 OHLC 缺失无法通过。Widget 有 CFD 蜡烛，但其内部坐标不可供本地 GEX 图层联动。Day Range 需要事先定价的有效 SPX 现金收盘及 SPXW IV；当前存档不足。Cone held 有效样本 `n=0`。没有足够同一时点 SPX 与 CFD 报价，因此没有做映射，也没有将原始 Levels 覆盖在 CFD 价格轴上。开市 Widget 继续更新的预定观察见 `scripts/observe_tv_open.ps1` 所生成的 `tv-open-*`，该观察仅证明参考 Widget 状态。

本轮 `npm test` 30 项、Python unittest 17 项通过；Chrome `--spx-cash` 与 `--live --focus-switch` 通过。Moomoo 官方文档也列出美国市场指数不受支持；独立 FOREX.com API 需要另行开通。
