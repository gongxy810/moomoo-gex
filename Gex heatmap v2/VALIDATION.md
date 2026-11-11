# 2026-11-10 OpenD GEX Board 刷新与首屏性能验收

同一台 Windows 主机、同一个 OpenD 和 SQLite 数据库，Chrome 无头浏览器采用全新独立
profile；比较文件为 `tests/browser-artifacts/performance-before.json` 和
`performance-after.json`。这些是本机实测，不代表行情源在所有时段都同速。此前浏览器
每次加载 95–163 MB 的整段历史，且页面请求会等待 OpenD 全链采集；现在后台为多个标签
共享两条任务队列（期权和 Spot），HTTP 立即返回内存或 SQLite 中最近完整快照。

| 场景 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 首次打开，三列有可用数据 | 15,451 ms | 299 ms |
| 连续三次网页刷新 | 16,084 / 15,490 / 15,321 ms | 135 / 139 / 129 ms |
| 手动 Refresh 返回可用旧快照 | 8,657 ms | 170 ms |
| 手动 Refresh 三列均显示新快照 | 原链路与请求绑定，未单独记录 | 11,789 ms |
| 切换至 NVDA，列先出现 / 数据 ready | 235 / 13,860 ms | 555 / 967 ms |
| 切换到期日完成绘制 | 610 ms | 286 ms |

首屏目标“已有缓存约 1 秒内可用”在本环境达成。首开时浏览器 FCP 约 0.25 秒，
三列首绘主线程 33.4 ms、右图更新 2.6 ms；热缓存刷新主线程约 20 ms、右图
1.3–1.6 ms。到期日切换三列主线程 212.9 ms、右图 135.5 ms，仍是可继续优化的
浏览器工作。测试中的“首次打开”指新浏览器 profile、已有 SQLite 快照；进程冷启会
同时复用持久快照并在后台采新数据。

进程冷启实测两条 QuoteContext 建连各约 0.7 秒。SPY 的首次完整采集 4.59 秒，
QQQ 2.55 秒，SPXW 约 4 秒，按单条期权队列先后完成，总计约 10 秒；
首次 SPY 采集内：交易日历 0.04 秒、合约/到期日 0.7 秒、期权快照约 2.9 秒、
GEX 计算约 0.02 秒、存储约 0.05 秒。Spot 独立采集首次 SPY 1.12 秒，
后续热采集约 0.1 秒。主要后台成本是 OpenD 快照批次及调用间隔，计算不是瓶颈。

网页初始六个快照/价格接口约 13–30 ms/个，压缩后的 GEX 每列约 66–118 KB；
首绘之前不查询历史。延迟加载的可见时段历史约 4.1–5.2 MB/列，
请求耗时 0.79 / 1.71 / 3.85 秒；`Server-Timing` 将其中的 SQLite 取数与解析
区分为 0.58 / 1.40 / 3.26 秒，JSON 编码及 gzip 为 0.17 / 0.21 / 0.47 秒，
余下为 HTTP 与浏览器处理。查询使用 `(symbol, at)` 索引；收盘锚点使用表达式索引。
历史在首绘后请求，向左拖动才补取更早区间。每个 GEX 快照原子替换，Spot 时间戳独立。

OpenD 快照按 400 合约批量、全局约 1 秒限流；合约目录和交易日缓存，连接与订阅复用。
依据：[Moomoo 快照 API](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-market-snapshot.html)
及 [行情权限与限频](https://openapi.moomoo.com/moomoo-api-doc/en/intro/authority.html)。
采集失败保留最近有效快照并标记 stale 和错误。手动刷新加入正在运行的同标的任务；
完成后才发布新的一致数据集合。

验证：27 项 JS 测试、17 项 Python 测试通过；合成数据的完整 Chrome 回归覆盖 GEX、
King/Walls、四档 Velocity、20–60 行权价、Replay 10:07 截断与异步旧响应；
真实 OpenD Chrome 显示三列 120 行、无 JS 异常；`--live --corner` 通过盘后
Spot/Pin/Cone 状态验收。盘后 SPX 现金指数权限仍不可用，
因此 SPXW Spot 仍以 REF 期权隐含价标注，不能把它当成真实现金指数。

---

# 2026-11-10 Expected Move / Tempest 与右下角工具续接

本轮补齐先前未接完的 `expected.js`、`tools.js` 与图表 / 应用之间的连接。
实际入口仍是 `http://127.0.0.1:8766/`，后台已重启；8个前端资源逐字节匹配工作区，
`/api/health.currentOnDisk=true`。本轮没有更新远端网站。

## 行为与数据口径

- OpenD Expected Move：同标的、同到期日、同根的 ATM Call/Put，优先选择现价或
  已核验远期价附近3%内最近的双侧有效报价；单侧有效标为 Approximate。
  必须有正 bid/ask、未交叉且相对价差不超过35%、有效 IV 与不超过120秒的报价 / Spot。
  IV 按供应商百分数除100；时间采用到已核验交易日收盘的日历 ACT/365 近似，
  支持 Today / Front。半日市、周末与时间戳均有测试。SPX 参考价不能生成现金指数边界。
  快照 update_time 不是独立 IV 时间戳，此限制保留在详情中。
- Day Range 使用前收90秒内实际采到的、对应下一交易日到期的合约数据冻结。
  不从盘中 IV 回填。有效记录保存在本浏览器 `gex-fixed-ranges-v1`，不包含 Demo。
  Cone held 仅统计同 provider / 同模型、已有真实常规收盘的已结束交易日，最多252个
  有效配对；无样本显示 `— · n=0`。浏览器记录从本次功能启用后累积，不代表已补齐252天。
- Pin 深复制价格、IV、时间、合约和完整曲线；轮询不能改变已冻结曲线。
  Live / Replay、标的、provider、horizon 与交易日隔离；回拖到 Pin 之前隐藏。
  已收盘 K 线相对冻结曲线的评分与日级 Cone held 分开显示；没有未来 K 线参与评分。
- Tempest 仅支持可选的本地授权 JSON 适配文件（见 README），未配置实时网络接口。
  未配置时设置项禁用。输入校验标的、交易日、数据时点、边界与单位；过期或晚于
  回放游标的 payload 不显示。使用供应商实际非对称边界；没有2σ就留空。
  曲线是本地平方根插值，不声称是供应商官方价格路径。
- 工具栏使用本地 SVG 图标；Cone / Pin / 统计 / 绘图组位于价轴和时间轴以内。
  支持整组拖动与键盘移动、全屏视图恢复、Reset view、Auto Scale、三种蜡烛样式、
  图层、横线 / 趋势线 / 矩形、端点拖动、数值编辑和删除。
  绘图编辑 / 删除按时间留存版本，回放不会看到后来修改的形状。
  PNG 沿用相同图层与冻结曲线，保留价格轴、时间轴及 Live / Replay 标记。

## 本轮验证与实际限制

- `npm test`：27项通过；Python unittest：15项通过。
- `node tests/browser.mjs --extended`：合成数据的完整浏览器回归通过，
  包括 NVDA 三入口、工具、PNG 下载 / 剪贴板分支、10:07回放截断，无JS异常。
- `node tests/browser.mjs --corner`：额外验证 Pin 轮询冻结、无重复 pin ID、
  手动价轴 / 时间范围全屏恢复、矩形端点拖动与编辑、Tempest 非对称边界、
  Replay 拒绝未来 payload、850px / 430px 控件不重叠及无页面横向溢出。
  证据：`tests/browser-artifacts/corner-fixture-result.json`、`corner-after-fixture.png`。
- 真实 OpenD SPY 实测720份期权报价记录，其中655份带非零 bid/ask；这是盘后采样，
  不代表这些报价都满足新鲜度、价差或 IV 要求。
- `node tests/browser.mjs --live --corner`：真实盘后显示 Today unavailable，Pin禁用，
  Cone held `— · 1σ · n=0`，Tempest未配置；浏览器无JS异常。
  证据：`corner-real-result.json`、`corner-after-real.png`。
- 本轮 `--live --extended` 在必须取得有效 SPXW 快照的旧断言处停止：
  当前 OpenD 返回“SPX 行情不可用，SPXW 配对报价也不足以计算参考值”。
  NVDA 三入口已运行，但不宣称此次完整真实行情验收通过。SPX现金权限和有效的盘中
  实时 IV 仍依赖行情源；当前有效 Cone / Tempest 成功分支由明确的合成行情验证。

接口依据：[OpenD snapshot bid/ask 与 IV 百分数定义](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-market-snapshot.html)、
[Lightweight Charts 价格范围 API](https://tradingview.github.io/lightweight-charts/docs/5.1/api/interfaces/IPriceScaleApi)。

---

# 2026-11-10 SPXW 显示文字与日变化补充

按最新要求，SPXW 标题与价格图标题不再加 REF 前缀，热图标签显示 Spot + 数字。
底层参考价标识、期权隐含来源和非现金实时报价说明仍保留在悬停 / ⋯ 详情中，
不更改 `current=false`、IV / Cone 的有效价限制或 SPX 现金行情权限。

OpenD 的 SPX 前收为空。本次从 Yahoo Finance ^SPX 历史数据记录独立核验
2026-11-09 收盘7549.94，存入 `data/verified-index-closes.json`（公开、按日期匹配）。
仅在 OpenD 无前收且恰好需要该交易日时使用，不把同一数值滚动到下一交易日。
这是一个日期明确的补充记录，不代表接通了自动更新的 SPX 实时 / 历史行情源。
后续日期若 OpenD 仍无前收且没有匹配补充记录，百分比继续留空，不伪造。
来源：[Yahoo Finance ^SPX history](https://finance.yahoo.com/quote/%5ESPX/history/)。

百分比公式仍为（显示价格 / 已核验前收 − 1）×100；当前SPXW显示价格来自
期权隐含参考价，因此该百分比是估算而非现金指数正式日涨跌幅，悬停明确说明。
真实浏览器验收示例：标题 `$7,535.30`、标签 `Spot 7535.3`、变化 `-0.19%`；
底层来源仍为 SPXW call/put mids、状态 REF，JS异常为0。
证据：`tests/browser-artifacts/spxw-labels.json`、`spxw-labels.png`。
修改：`relay.py`、`web/app.js`、`web/replay.js`、公开前收记录、对应测试与打包脚本。
20项JS测试及14项Python测试通过；日期不匹配不会泄漏到Replay前收。

---

# 2026-11-10 三列与节点样式验收（上一轮更新）

实际服务仍为 `127.0.0.1:8766`，PID 4932，webRoot 为当前项目的 `web`。
Python relay、行情权限、私密 Origin 与持久化数据库保持原样；未公开部署。
浏览器实际加载的 app/chart/model/style 在修改前已保存，与本地旧版本对应。

## 改动范围与口径

- `web/model.js`：连续可用行权价按总数选取，Spot/King 两种中心，边缘补足；
  20/30/40/50/60，默认40，保存值39迁移40。`gex-view` 保留有效行数与回看窗口。
  King、Walls、汇总及节点分母继续使用所选到期日与所选行数范围，没有暗改成全链。
  King 居中先从当前到期日采样链定位 King，再取相同总行数。
- `web/app.js`：独立的1m/5m/15m/30m Velocity；基准不晚于目标时刻，
  同标的、模型、期权根、交易日、时段和到期/合约集合，偏差最多90秒；
  零、缺失、过旧均显示—并说明。Replay 的基准目标从 replayCursor 计算。
  稳定三列和现有选择/Focus 保留；共享最新报价状态，K周期不改变Spot。
- `web/index.html`、`web/style.css`、`web/tools.js`：36px标题与32px King横栏，
  去圆徽标，价格/日涨跌同行，REF/DLY明确标识；来源与Focus放进⋯详情。
  白色Spot/REF标签按实际价差插值，水平居中，保留左侧最近strike箭头、右侧金额/星标。
  两个视图下拉使用暗色ARIA combobox/listbox，支持方向键、Enter、Esc、Tab和外部点击。
  窄于1200px时三列在上、图表在下，避免把金额压得过小。
- `web/chart.js`、`web/replay.js`：节点按K桶最后有效快照及来源/根/到期日/strike去重，
  放入官方v5 primitive的bottom层；曲线/绘图/说明仍在top层。金#E9BB48、紫#8739CE，
  原生椭圆、派生窄菱形；尺寸受8px、K间距65%及相邻strike距离限制。
  碰撞只绘最强主标记，其他来源保留在悬停详情，原始快照不删。
  暗底#0B0B0D、网格#1B1B20、青绿/鲑红边框影线与较暗实体。
  图例下报告原始快照、桶、候选、唯一节点、实际可见绘制/合并数。
  PNG使用同一渲染器和相同图层顺序。

## 770 nodes 的真实来源

根据本机保存的真实SPY历史，复算截图的 `2026-11-10T19:37:07Z` 截止时点：
860条原始快照 → 154个有数据的5m桶 → 2373个达到King10%的候选 → Top5共770点。
这是154×5个跨时段历史节点；该SPY主图没有跨来源Derived重复。
后续15:08 ET保存的数据对应902条快照、160桶、2448候选和800个唯一节点。
同一11:00–15:10 ET可见窗口，最终绘制255个小节点、0个碰撞合并；
缩小全范围时会进行屏幕碰撞合并，悬停仍保留所有源数据。
复算脚本：`scripts/diagnose_nodes.mjs`；证据：`tests/browser-artifacts/design-node-audit.json`。

## 行情来源与未完成项

| 标的列 | 价格/前收与K线 | 期权 |
|---|---|---|
| SPY | 本机OpenD ticker，验证过的未复权上一交易日常规收盘；OpenD真实1m OHLC聚合 | OpenD US.SPY |
| QQQ | 本机OpenD ticker，同源已验证前收；OpenD真实1m OHLC聚合 | OpenD US.QQQ |
| NVDA（切换测试） | 本机OpenD ticker/已验证前收；999条真实1m OHLC | OpenD US.NVDA，704/704可用 |
| SPXW | **SPX实时现金报价与授权现金OHLC尚未接通**；现金K线0条。现有值为SPXW配对Call/Put中价K+C−P的REF（忽略利率），不是现金Spot | OpenD SPXW，720可用 |

TVC:SPX保持独立外链，没有从TradingView取价。缺少现金指数源、前收IV或历史GEX时明确提示，
不使用参考图价格，不以SPY/ES填充SPX K线。

## 验收结果与截图

- `npm test`：20项JS/DOM/模型/Replay测试通过，包括负GEX绝对值、30m缺失/过旧/
  跨时段、39迁移、链边缘补足、节点碰撞和尺寸上限。
- 真实OpenD浏览器：NVDA快捷/确认/Enter三种入口通过，提交到切换约1.99/6.06/6.12秒；
  五档行数均实际显示对应行数，四档Velocity均运行真实历史链路。
  盘后现场15m/30m无同POST时段基准，180/180徽标为—，没有偷用RTH快照。
  同日RTH真实留存数据中30m有基准的行正确显示数值。
- 当前OpenD数据请求存在延时：本轮部分price请求约19–27秒；请求耗时记录在
  `tests/browser-artifacts/real-acceptance.json`，不把轮询周期视为行情延迟保证。
- 测试数据浏览器：Day Range/有效IV Cone/Pin、工具栏所有保留按钮、横线/趋势线/删除、
  键盘和鼠标拖动、PNG下载及剪贴板失败提示通过。剪贴板成功分支使用隔离mock；
  不声称已验证真实系统剪贴板写入。真实盘后Cone正确提示不可用并禁用Pin。
- 本机Chrome/CDP：方向键/Enter/Esc/外部关闭/持久化、1500/1120/850px居中与金额
  不重叠检查通过。真实OpenD数据固定保存后，仅用于可重复的前后截图比较；没有写回行情。
- 同日13:07 Replay：最后已收盘5m K线13:05，最后节点13:06:38，顶部Spot/热图/
  Velocity均截止游标；暂停中触发实时刷新不改变回放可见状态，退出恢复Live。
  既有真实10:00→10:07→回拖、Replay PNG导出和工具栏回归通过，无JS异常。

固定真实数据、同标的SPY、同5m、同可见时间窗口的截图：

- [修改前](tests/browser-artifacts/design-before-desktop.png)
- [修改后](tests/browser-artifacts/design-after-desktop.png)
- [蜡烛穿过强节点的局部](tests/browser-artifacts/design-after-chart.png)
- [1120px窄窗口](tests/browser-artifacts/design-after-1120.png)
- [850px窄窗口](tests/browser-artifacts/design-after-850.png)
- [暗色下拉](tests/browser-artifacts/design-dark-dropdown.png)
- [同日Replay](tests/browser-artifacts/design-after-replay.png)

辅助改动：`tests/model.test.mjs`、`tests/acceptance.mjs`、`tests/browser.mjs`、
`tests/design-acceptance.mjs`、`scripts/capture_design_data.mjs`、`scripts/diagnose_nodes.mjs`。
下方保留上一轮relay/NVDA/Replay修复验收记录，数值属于当时的采样。

---


# OpenD GEX Board 验收记录 · 2026-11-10

## 实际入口与访问范围

服务浏览器的目录为 `C:\Users\gxy\Downloads\opend-gex-relay`，入口为根目录
`opend_board.py`，前端为 `web/`。修改前从 8766 读取的 `app.js`、`chart.js`
与本目录逐字节匹配；实际监听进程的命令行也指向该目录的 `.venv`。
`/api/health` 现在返回 PID、webRoot、loadedRevision、currentOnDisk；可区分磁盘
已更新但后台仍在运行旧代码的情况。静态文件使用 no-store。

仅绑定 127.0.0.1，保留原精确私密 Origin：
`https://opend-gex-board.super-fir-5013.chatgpt.site`。
没有公开部署，没有改变线上私密站点访问权限；新增界面使用本地看板。
三张截图只用于布局、图层和工具栏参考，没有从截图提取市场数值。

## NVDA 排查证据与修复

修改前的真实 HTTP 记录保存在 `data/runtime-before.json`：

| 请求 | 状态 | 实测耗时 |
| --- | --- | --- |
| `/api/price?symbol=NVDA` | 200 | 11.674 秒 |
| `/api/snapshot?symbol=NVDA` | 200 | 6.768 秒 |

这证明 NVDA 没有被固定三标的白名单拒绝。未将截图中的等待认定为永久死锁。
旧选择流程确实把“验证”绑定到全量期权采集，且价格、采集共享全局锁；并发
真实日志也记录到排队。修复为独立 SDK 连接/锁的轻量 `/api/validate`：
解析代码 → 订阅/读取基础报价 → 可用到期日。这里不取期权链、Greeks 或 K 线。
验证成功即提交 columnId 对应的列、关闭菜单，再异步加载期权和价格。
验证超时、取消、失败均退出 busy；失败保留原列。完整采集按标的去重。

前端 console 的 `gex-switch`、`gex-request` 分别记录提交、规范化、验证提交、
列写入、错误及耗时。relay 日志记录请求、SDK 方法、代码、耗时与排队时间。

## 真实 OpenD / 实际 Chrome 验收

首轮完整真实验收结果：`tests/browser-artifacts/real-acceptance-initial-v2.json`；
最近一轮结果：`tests/browser-artifacts/real-acceptance.json`。下表为首轮实测。
使用独立 Chrome 配置，访问用户实际的 `http://127.0.0.1:8766/`，没有读取用户
浏览器配置、Cookie 或 TradingView 登录信息。

| NVDA 入口 | 实际输入 | 前端规范化 / 后端代码 | 验证并切列耗时 |
| --- | --- | --- | --- |
| 快捷按钮 | NVDA | NVDA / US.NVDA | 1.327 秒 |
| 输入后确认 | nvda | NVDA / US.NVDA | 0.120 秒 |
| 输入后 Enter | nvda | NVDA / US.NVDA | 0.198 秒 |

这些是本次测量，后两次可命中验证缓存，不是延迟保证。
后续 RTH 真实复验同样通过，三入口分别为 1.585、2.431、4.448 秒；鼠标拖拽
手柄、有效 Cone / Pin 以及完整 Replay / PNG 也通过，详见最近一轮报告。
三次均保持另外两列不变，标题、39 档热图、下方明细与价格图一起切换。
真实 NVDA 采到 704 / 704 个可用合约、999 根源分钟 K 线；价格来自 OpenD
ticker，状态 PRE，前收日期 2026-11-09。首次完整期权加载约 2.654 秒，后续
可命中采集缓存。NVDA 最近到期日为 11 月 11 日，因此 11 月 10 日显示
“NVDA 无 0DTE”，显式选择 Front 后显示热图，不冒充 0DTE。

SPXW 真实取得 720 个可用合约，现金指数 K 线为 0，显示 REF。期权根 SPXW
与价格标的 SPX 分开保存，现金行情失败不阻断期权链。TVC:SPX 提供独立
TradingView 打开链接；未嵌入 Widget，未读入 TradingView 内部价格。

真实浏览器逐项通过：全屏/Esc、适配自动缩放、周期/时段/泡泡设置、六个
图层开关、回到当前头、折叠/展开、工具区移动、横线、趋势线、删除选中绘图、
复制失败后的下载入口、实际 Live/Replay PNG 下载。复制成功分支使用隔离的
mock clipboard 验证，未替换用户系统剪贴板；系统权限拒绝时真实 fallback 可用。

本轮还修复了真实数据触发的画布高度反馈增长：图表挂在绝对定位容器中，
与 flex 固有尺寸隔离；真实验收最终 plot 高度为 480px，未继续增长。

## Replay 真实截断

同一个 replayCursor 控制三列、价格头、K 线、GEX、Walls、Day Range、Cone、
Derived 和绘图。后台 Live 继续缓存，不能覆盖 Replay 的可见数据。

- 回到 2026-11-09 10:00 ET：SPY 显示 6 根已收盘的 RTH 5 分钟 K 线，最后
  一根结束于 10:00。该时点没有采集过历史期权，明确显示“历史 GEX 不可用”。
- 单步、播放/暂停后回拖到 10:00：未来 K 线、节点和后来绘图被删除/隐藏。
- 10:07 ET：最后一根 K 线截止 10:05，不使用 10:05–10:10 的最终 H/L/C。
  当前实现保守地不显示未收盘目标周期，不伪造部分 K 线。
- 退出后恢复 Live；工具栏向右箭头在 Replay 中只回到回放头，不退出模式。
- 实际下载了带 Replay 文件名的 PNG，检查了 PNG 签名/尺寸，并人工查看：
  无未来价格、当前链或后来绘图。导出前刷新渲染，包含当前图层和价格/时间轴。

截图为 `real-replay.png`、`real-v2.png`；实际导出目录记录在验收 JSON 的
`exportDirectory` 中。历史价格由独立 price_bars 表保留，GEX captures 单独
保存；不会把当前期权链回填到仅有历史价格的时段。

## 测试数据验证

- Python：13 项通过，含验证不等待全局采集锁、验证不下载全链、错误/代码、
  日历/前收/时段、SPX 失败但 SPXW 成功、SQLite 重启与价格/GEX 独立保存、
  Host/Origin/文件边界，以及超出近期窗口后的指定日期历史读取。
- Node：16 项通过，含 Velocity、缺失值与真实零、合约/到期日一致性、Wall
  并列与不完整侧处理、日涨跌、K 线聚合、10:07 截断、回拖、单一时钟、
  Spot 插值/REF、按 K 线选择真实快照、ET 夏令时、过期响应忽略。
- 独立合成行情的完整 Chrome 验收通过，结果为
  `tests/browser-artifacts/fixture-acceptance.json`。覆盖实际有前收 IV 的固定
  Day Range、边界旁的超出 pts / 相对中心 σ 标签、有效 Cone / Pin、所有
  工具、剪贴板两个分支、图层及导出。不使用设计稿数值。
- 图层节点按真实采集时间，原生圆点 / Derived 菱形；金额保留来源标的。
  每个 K 线桶只保留截止可见时点的最后快照，不填补采集空白。
- 量化模型仍为 OI-based Gamma × OI × multiplier × spot² × 0.01，Call 正、
  Put 负；不是已知 dealer 仓位。缺失侧不按零参与 Net / Wall 计算。

## 仍依赖外部权限或真实历史的项目

OpenD 本账户仍返回“暂不支持美股指数”，没有配置其他授权 SPX 现金 OHLC
provider。独立适配入口保留在 providers.py；未购买套餐、未抓私有接口。
SPX 现金 K 线恢复和配对 Derived 的数值由测试行情覆盖。
没有前收附近的真实 IV / 同口径 GEX 快照时，Day Range / 1D Velocity 留空。
当前真实盘前没有适合的有效同日 IV 时，Cone/Pin 显示原因；有效输入和冻结
由测试行情验证。没有可复算的长期统计，不显示 73% 或 n=252。

## 重跑与打包

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
npm test
node tests\browser.mjs --extended
node tests\browser.mjs --live --extended
npm run package
.\.venv\Scripts\python.exe scripts\check_local_http.py
```

最终连接包：`dist/opend-gex-relay.zip`，网页下载链接同步到 `web/`。归档包含
运行所需 Python、前端模块及官方 Lightweight Charts 5.2.1/许可证；不包含
用户数据库、环境、测试行情、个人配置或凭据。现有 .venv 无需重装。

官方接口依据：
[Moomoo get_stock_quote](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-stock-quote.html)、
[get_market_snapshot 限额](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-market-snapshot.html)、
[Lightweight Charts 5.2 API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi)。

---

## 2026-11-11 右图节点、Expected Move 与 TradingView 切换复验

本轮沿用同一批已归档的真实 OpenD SPY 数据、同一 5m 时段（16:00–20:10 UTC）和 690×480 CSS 像素图框，保存了 [修改前](tests/browser-artifacts/compare-before-chart.png) 与 [修改后](tests/browser-artifacts/compare-after-chart.png)。用户提供的完整 Skylit Atlas 截图为 `C:\Users\gxy\Pictures\Screenshots\屏幕截图 2026-11-10 164258.png`；它的左半是 SPXW，右半是旧版 SPY Replay，价格轴和数据不同，只用于比较形状、层级与布局，不作逐点数值比较。

- 节点改用每个来源、快照时间、到期日集合中的**完整有效 strike 集合**先求绝对 GEX 最大值，再叠加 Top N 与 ≥ King % 筛选；热图 King、Walls 与汇总仍按选定的 20–60 行计算。原生节点是圆/横椭圆，真实成对来源映射得到的派生节点才是纵菱形。派生映射使用采集时同步的来源/目标 Spot 比率，报价缺失或过旧则跳过，标为本地近似。固定数据的 20%/80% King、正负翻转与不同 King 测试通过。
- 绘图配置集中于 `web/chart.js`：原生宽 2.4–8、高 2.3–7 像素；派生宽 2–6.5、高 3–22 像素；alpha 从 0.10 到 0.65 按强度的 0.75 次幂变化，King 上限 0.72。Lightweight Charts 5.2.1 的底层 primitive 使节点位于 K 线之下。实际归档样本为 902 份原始采集、160 个 5m 桶、800 个唯一节点，255 个可见/已画、0 个合并；节点审计见 [JSON](tests/browser-artifacts/design-node-audit-after.json)。真实样本没有有效派生来源，因此图中只有原生点；合成成对来源验收见 [派生节点审计](tests/browser-artifacts/derived-fixture-audit.json)。
- 固定 Day Range 和 Live Cone 分别保留锚点、定价时间、结算时间与来源。OpenD Day Range 只接受上一个常规收盘的有效 ATM IV，不用盘中 IV 回填；Live Cone 以当前应用 Spot/IV 估算。浏览器数值场景：锚点 750、固定边界 748/752，Spot 753/750/747 分别显示高出 1.00、区间内隐藏、低于 1.00，并得到 +1.50σ/−1.50σ；固定边界不移动，Live Cone 随 Spot 变化，Pin 冻结。证据见 [场景数据](tests/browser-artifacts/range-scenarios.json)、[上破](tests/browser-artifacts/range-above.png)、[区间内](tests/browser-artifacts/range-inside.png)、[下破](tests/browser-artifacts/range-below.png)、[Pin](tests/browser-artifacts/range-pinned.png)、[Replay 10:35](tests/browser-artifacts/range-replay.png) 与 [Replay 13:07](tests/browser-artifacts/range-replay-later.png)。Replay 只用游标之前的数据，历史 Day Range 标为 `Hist Day`。
- 真实 SPY 归档扫描 1352 次采集，931 次有当时 Spot，262 次有部分双边报价，80 次出现 IV，但没有一次同时满足有效 ATM/报价时间/价差/结算时刻要求；首个含 IV 的样本在对应交易日收盘后。因此实际 OpenD 样本不能给出可靠的 Day Range 或 Live Cone，界面显示不可用，不把合成边界当作真实行情。记录见 [real-expected-sample.json](tests/browser-artifacts/real-expected-sample.json)。本地 Cone held 当前有效日样本 `n=0`，不显示硬编码百分比。
- SPXW 右图现可在 GEX 图和 TradingView 间切换。官方 Advanced Chart Widget 配置为 `FOREXCOM:SPXUSD`、`1` 分钟、`America/New_York`、深色；标题为“S&P 500 CFD 参考图 · FOREXCOM:SPXUSD”，仍保留“在 TradingView 打开 TVC:SPX”链接。CFD 报价不写入 OpenD 热图、顶部 SPX Spot 或 Expected Move；本机现金指数 Spot/有效 IV 缺失时两处显示不可用。TradingView 模式隐藏不能联动的 GEX 节点、图层、Pin 和 Replay 控件；切回 GEX 后恢复。
- 实际 `http://127.0.0.1:8766/` 的 [Widget 首图](tests/browser-artifacts/tv-live-observe-start.png) 显示 `S&P 500 Index · 1 · FOREXCOM` 的分钟 K 线，无拒绝弹窗；[70 秒后的截图](tests/browser-artifacts/tv-live-observe-end.png) 显示最右侧分钟蜡烛继续推进。这是在 2026-11-11 00 时 ET 的 CFD 盘时观察，尚不代表 09:30 ET 现金市场开市验证。此前 TVC:SPX 的官方 Widget 在同一本地看板显示弹窗原文 `This symbol is only available on TradingView.`，因此改用独立的 CFD 参考图。实际切换报告见 [tv-live-observe.json](tests/browser-artifacts/tv-live-observe.json)。
- 09:31 ET 开市复查已注册一次性本机计划任务 `OpenD-GEX-FOREXCOM-SPXUSD-20261111`，确认 `NextRunTime=2026-11-11 09:31:00`、状态 Ready。届时运行 `scripts/observe_tv_open.ps1`，在 `tests/browser-artifacts/` 留下 `tv-open-observe-start.png`、`tv-open-observe-end.png`、`tv-open-observe.json` 和 `tv-open-run.log`。若机器未在 09:30–09:45 ET 运行，脚本会注明跳过，不能预先声明开市结果。

本轮复验：`npm test` 30 项、Python unittest 17 项；浏览器 `--range`、`--design`、`--live --tv --observe` 通过且无 JS 异常。`npm run package` 已重新生成 ZIP，本地服务的 `/api/health.currentOnDisk=true`，`verify_runtime_assets.mjs` 确认 8 个资源与磁盘一致。TradingView Widget 按[官方 Advanced Chart 文档](https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/)嵌入；其内部行情和数据权限由 TradingView 提供。
