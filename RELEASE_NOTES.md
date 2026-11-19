# v0.8.8 α

**简体中文** · [English](#english)

<details open>
<summary><b>简体中文</b></summary>

本次版本重点新增多账号隔离与可控切号. 按模型每日堆叠统计. 累计总量图表改版. 请求时间线与速度体验评分. 并完善跨平台兼容与三语界面本地化.

- 新增多账号与分账号用量隔离. 历史未归属请求统一保留在未归属账本. 绝不默认计入当前账号.
- 新增受控手动与阈值自动切号及配额对照. 内置防抖. 冷却. 生成中等待. 多窗口锁与无 CDP 主进程核验失败回滚保护.
- 新增按模型每日堆叠柱图. 支持 7 天或 30 天视图. 思考档位与来源筛选. 从会话数据库回填缺失模型显示名. 并支持 Orchestrator 与后台 worker 映射清洗.
- 统一用量图表与年度气泡混合对数-幂律连续刻度. 修正跨档变小问题. 大于 1B 年度气泡封顶 58px 并保留外环提示.
- 新增累计总量看板. 支持摘要卡片. 量级尺. 比例时间带. 零用量日标记与 460px 以下窄窗口自适应.
- 新增缓存读取占比统计. 可折叠会话请求时间线. 最新调用动态替换与首字等待及纯流式速度评分.
- 统一中简. 中繁与英文三语界面及货币显示规则. 英文下仅显示美元并支持预设地区自动转换. 替换日期输入为统一主题自定义日历选择器.
- 界面展示版本为 0.8.8 α. 内部语义化版本号保持 0.8.8. 已安装 0.8.8 测试版的用户请先完全退出 Antigravity 客户端后执行 node cli.js install 覆盖安装. 也可运行 node cli.js watch 启用免改盘守护模式.
- 感谢 @Lopution 提交 PR #26 贡献 Windows 下 WSL 发行版桌面端与 CLI 用量采集方案.
- 感谢 @huron09280 提交 PR #28 贡献 macOS Apple Silicon arm64 的 Mach-O 增强. 上下文解锁与本地 API 适配.
- 感谢 @kyrie21z 提交 PR #30 贡献按模型每日堆叠统计. 模型显示名回填. Orchestrator 与 worker 映射及旧归档清洗方案.
- 感谢 @startips 提交 PR #31 贡献 runtime-check.js 跨平台端口路径修复与预发布测试期间问题反馈.
- 感谢 @x1051445024 提交 PR #40 贡献 builtinAsar.createPackage 标准接口兼容与测试沙箱 ASAR 路径隔离.

</details>

<details id="english">
<summary><b>English</b></summary>

This release introduces multi-account usage isolation with controlled account switching. daily stacked per-model usage charts. a redesigned cumulative usage view. collapsible turn timelines with speed scoring. cross-platform enhancements. and full trilingual localization.

- Added multi-account and per-account usage isolation. Historical unattributed calls remain in the unattributed ledger and are never assigned to the active account by default.
- Added controlled manual and threshold-based automatic account switching alongside quota interval comparison. Includes debounce. cooldown. busy-generation wait. multi-window lock. and non-CDP main-process rollback protection on verification failure.
- Added daily stacked per-model usage bars with 7-day and 30-day ranges. effort and source filters. missing model display name backfill from conversation databases. and Orchestrator plus background worker bucket normalization.
- Unified chart bar heights and yearly bubble diameters with a continuous hybrid log-power scale to fix cross-tier shrinking. Yearly bubbles above 1B are capped at 58px with an outer glow ring.
- Added the Cumulative Usage view featuring summary cards. a logarithmic magnitude ruler. proportional time strips. zero-usage day markers. and responsive layout below 460px.
- Added weighted cache-read ratio telemetry. collapsible per-turn request timelines. dynamic latest-call card transitions. and TTFT plus pure-streaming speed scoring.
- Unified Simplified Chinese. Traditional Chinese. and English UI copy plus currency display rules. English displays USD only for API estimates and converts preset regions automatically. Replaced native date inputs with a custom theme-matched calendar picker.
- Displayed version is 0.8.8 α while internal semantic version remains 0.8.8. Users on 0.8.8 pre-release builds should fully quit Antigravity first and run node cli.js install to upgrade cleanly. You can also run node cli.js watch for patch-free background monitoring.
- Thanks to @Lopution for PR #26 adding WSL desktop and CLI usage collection on Windows.
- Thanks to @huron09280 for PR #28 adding macOS Apple Silicon arm64 Mach-O prompt enhancement. context unlock. and local API adaptation.
- Thanks to @kyrie21z for PR #30 adding daily per-model stacked charts. database model label backfill. Orchestrator and worker mappings. and legacy archive cleanup.
- Thanks to @startips for PR #31 fixing cross-platform port path resolution in runtime-check.js and reporting issues during pre-release testing.
- Thanks to @x1051445024 for PR #40 implementing builtinAsar.createPackage compatibility and test sandbox ASAR path isolation.

</details>
