OpenD GEX Board — local, read-only

启动（Windows）
1. 打开并登录 Moomoo OpenD，默认行情端口 11111。
2. 双击 start-windows.cmd。若旧程序仍在运行，先在旧终端 Ctrl+C。
3. 看板 http://127.0.0.1:8766 ，保持终端打开。
   也可在项目终端执行：
   .\.venv\Scripts\python.exe opend_board.py --open-browser

已有 .venv 无需重装依赖。Python 3.10+，requirements.txt 为行情依赖。
图表库已随 web/vendor 一起打包；正常使用不需要 Node/npm 或 CDN。
--opend-port 可指定 OpenD 端口；--web-port 可指定本地网页端口。

访问范围
始终只监听 127.0.0.1。保留现有私密网站的精确 Origin：
https://opend-gex-board.super-fir-5013.chatgpt.site
没有公开部署或改变网站访问权限。此文件夹更新不会自动更新远端网站的界面；
新增功能请使用本地看板。原私密来源仍可读取 relay 的兼容 API。

功能与数据规则
- 三列独立选择，默认 SPXW / SPY / QQQ；保存配置与最近成功验证的标的。
- NVDA 快捷 / 输入确认 / Enter 共用轻量验证接口；验证后立即切列，再异步加载。
  无 0DTE 时显式选择 Front。选择失败保留旧列，取消/超时不会一直验证。
- 白色 Spot / REF 标记显示实际价格，在两档 Strike 之间按位置插入；King 独立。
- 当前实现美国股票/ETF/指数时段；其他市场保留代码格式，需扩展市场时段适配器。
- SPXW 只采 PM 期权根；SPX 价格失败不阻断期权链。
- SPX 期权隐含远期明确标 REF，不作为现金指数 K 线。
- 前收由 OpenD 日线与交易日历核对，使用 NONE 价格调整口径。
  没有可验证前收时显示 —，不根据未标日期的 snapshot 字段猜测。
- Velocity = (|当前 Net GEX| - |基准 Net GEX|) / |基准 Net GEX| × 100。
  合约/到期日/计算口径不一致、部分报价缺失时留空；New/Fading 仅用于真实零。
- 成功采集的快照保存在 data/captures.sqlite3，保留 10 天。
  重启可读回历史；程序关闭期间没有数据，不能补造。
- 1D 必须有前一交易日收盘前 90 秒内的同口径快照。
  Day Range 必须有前收附近实际采集的有效 ATM IV；缺少时明确不可用。
- IV Cone 为简化的年化时间平方根估算，Pin 冻结其现价、IV、采集时点和终点。
- Replay 先选历史日期和美东起点，可播放/暂停、单步、调速度、回拖、退出。
  只显示游标之前已收盘的 K 线；没有历史期权就明确留空，不用当前链回填。
  10:07 的 5m 图最多显示截止 10:05 的 K 线。后台 Live 更新不会覆盖 Replay。
- 图表右下工具栏：全屏、适配、设置、图层、回到当前头、复制 PNG、下载 PNG。
  铅笔可画横线/两点趋势线和删除选中线；手柄可拖动，方向键也可移动。
  剪贴板权限失败时提供下载。Live / Replay 导出都遵守当前显示的截断。
- TVC:SPX 链接仅在 TradingView 独立打开；本地图表不读其内部行情。
- GEX 30 秒后重采；价格 15 秒后独立刷新，OpenD 限流/采集耗时会延长实际间隔。
  行情时间、采集时间、轮询间隔分别显示，不能把轮询间隔当成报价延迟。
- 只读行情，不下单，不读取 TradingView 账户/Cookie，不购买行情套餐。
- providers.py 预留独立 SPX 现金行情适配器，当前没有配置外部付费来源。

维护与验收（仅开发目录；连接运行包不含测试工具）
  .\.venv\Scripts\python.exe -m unittest discover -s tests -v
  npm test
  npm run test:browser
  node tests\browser.mjs --extended
  node tests\browser.mjs --live --extended
  npm run package
  .\.venv\Scripts\python.exe scripts\check_local_http.py

浏览器测试使用已安装的 Chrome/Edge、独立临时浏览器配置和合成行情。
真实 OpenD 验收：
  .\.venv\Scripts\python.exe scripts\check_live.py
详细验证范围与限制见 VALIDATION.md。

如需更新图表依赖：npm ci --ignore-scripts，再 npm run vendor。
版本锁定 Lightweight Charts 5.2.1，保留 LICENSE、NOTICE 和页面 attribution。
打包结果 dist/opend-gex-relay.zip；网页下载链接同步到 web/。
ZIP 不包含 .venv、个人配置、凭据、测试行情或本地 SQLite 数据库。

Expected Move / 图表工具（2026-11-10 续接）
右下角 Live Cone 开关、Pin 和 Cone held 详情已经接入。
设置中可选择 Today / Front、自动价轴与蜡烛样式；绘图增加矩形、端点拖动与数值编辑。
OpenD Cone 需要新鲜真实 Spot，以及同到期日 ATM bid/ask / IV；REF、过期、缺失数据不生成边界。
模型是本地 ACT/365 平方根近似，详情提供来源、时间、合约和质量原因。
Day Range 只用真实前收捕获；Cone held 只计已结束且有真实收盘的有效日级配对。
Pin 冻结完整曲线，Live / Replay 相互隔离；评分只使用游标前已收盘 K 线。
没有历史样本时显示 n=0，不填充示例百分比。浏览器固定区间记录可随清除站点数据而丢失。

可选 Tempest 适配
本版本没有连接或轮询 Tempest 网络 API。需要自行提供已获授权且映射到以下本地格式的
data/tempest-authorized.json；此文件不会打进 ZIP，也不会通过静态资源目录公开。
它是本项目的适配格式，不声称与 Tempest 原始 API schema 相同。
顶层对象按 SPY / QQQ / SPX 等价格标的索引，SPXW 使用 SPX。
每条记录需要 symbol、session（美东 YYYY-MM-DD）和 horizons 数组。
horizons 项需要 name（today/front）、priced_at、until（带时区 ISO 时间），以及
hi1 / lo1 的价格边界；hi2 / lo2 可选。iv 可选，单位为小数，例如20%写0.2。
也可提供 skew.unit（percent/fraction）与 up1_pct / dn1_pct 等明确单位的偏离百分比。
缺少2σ不推算供应商2σ。Spot 与 priced_at 最多偏离30秒，数据必须在120秒内且不晚于游标。
可选 levels 中 name=day 的冻结区间需要 frozen=true、anchor、hi1、lo1、priced_at、until；
priced_at 必须早于该交易日；没有真实结束日收盘就不计入日级统计。
只读取允许的数据字段；不要在这个文件中存放 API key 或其他凭据。
写入新授权数据后等待下一轮刷新即可；没有配置时选择器禁用 Tempest。

专项验证：node tests/browser.mjs --corner；真实盘后状态：node tests/browser.mjs --live --corner。
