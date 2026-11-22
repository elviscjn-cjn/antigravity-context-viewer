# v0.9.0 beta1 (0.9.0-beta.1)

**简体中文** · [English](#v090-beta1-en)

<details open>
<summary><b>简体中文</b></summary>

### 当前会话交互式分析页与宽屏多栏重构
- 升级「当前会话」分页为 4 行响应式 Bento 工作台 (`wide >=860px` / `medium 540~859px` / `narrow <540px` 三档容器自适应，支持右侧辅助栏停靠与顶部原位浮层双模式同源交互).
- 严格区分单次上下文已用与会话累计 Token、单步缓存读取与累计缓存、插件配置预算与宿主确认窗口上限; 拆分 9 维上下文构成并如实标注宿主实报、本地估算与未归类残差 (`unaccountedTokens`).
- 上下文趋势支持总量/增量 Δ、按步/按轮切换、键盘方向键切步、`Esc` 返回最新与固定历史步骤对比 (`比前一步` / `比前一轮`); 缺乏压缩/剪枝证据的突降标为「占用下降，原因未知」.
- 耗时统计增加多色环形图与并发墙钟 vs 累计任务时长对照; 宿主未导出思考/正文/工具参数独立时间戳时仅展示 TTFT、模型流式与工具执行三段并如实注明边界.
- 工作台下端接入上下文事件、文件活动、命令执行与基于可核实父子关系的子 Agent 汇总，默认对路径与令牌脱敏.

### 界面修正与自定义扩展避让
- 修复正常未固定状态下「当前会话」`#ctx-ov-pinned-banner` 与「配置 → 外观与停靠」`#dock-fallback-note` / `#dock-open-feedback` 因 `[hidden]` CSS 优先级缺失导致的细长蓝色空框残留，仅在实际存在提示文本时显示并在状态解除后完整收起.
- 修复进入「自定义扩展 / 插件市场 / 插件详情页」的面板与右侧辅助栏避让回归，并防止无输入框的已归档历史会话 (`/c/...`) 被侧栏导航与全局后退按钮误锁.
- 实时请求列表 `Antigravity` 行改用 `antigravity-color.svg` 静态矢量图标（分发许可待核实，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 第 3.4 节）; 保留 Claude/OpenAI 图标与统计口径.

### 兼容性、安装安全与 CLI 助手收尾
- 新增 Antigravity `2.34.0` 加载锚点 (`loadHubWindowUrl`) 与同源 `authBootstrap` 鉴权兼容，以及宿主更新覆盖后的隔离备份恢复与 macOS `ElectronAsarIntegrity` 写前预检 (`host-recovery.js`).
- 收尾 GitHub Issue #17 Windows CLI 窗口助手: 将预编译 `scripts/cli-window-helper.exe` 移出 Git 跟踪，Windows 打包与安装改为临时目录从 `scripts/cli-window-helper.cs` 现场编译并校验 SHA-256，保留标准控制台 (`cmd.exe /d /k`) 无助手回退路径与 `@riandycandra` 署名.
- 宿主界面汉化升级: Antigravity 界面汉化基于 Antigravity-Chinese-Localization，感谢 aabbWei 与 antigravity-cn-community 贡献者. 上游仓库 `<https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization>`, 采用本地工具包 Release `v2.34.0`, 完整 MIT 许可与第三方声明见随包 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- 已知未完成/待验证边界: `antigravity-color.svg` 公开随包再分发许可待核实; macOS 物理真机签名安装与 `watch` 守护及真实左右双分屏/Side Question 场景仍待实机补验.

</details>

<details id="v090-beta1-en">
<summary><b>English</b></summary>

### Interactive Session Analysis & Responsive Bento Layout
- Upgraded the Session view into a 4-row responsive Bento workbench (`wide >=860px` / `medium 540-859px` / `narrow <540px`) shared across both right-sidebar dock and topbar popover modes.
- Separated single-call context occupancy vs session cumulative tokens, per-step cache vs cumulative cache, and user configured budget vs host-confirmed context window limit. Split 9 composition categories while preserving actual reported totals, visible estimates, and unattributed residuals.
- Added total/delta and per-step/per-turn trend toggles, keyboard step navigation (`Left`/`Right` and `Esc`), pinned step comparison, and conservative `unknown_drop` classification when compaction evidence is absent.
- Added timing breakdown donut with concurrent wall-clock vs cumulative task duration while explicitly noting that independent thinking/body/tool-arg streaming sub-timestamps are not exported by Antigravity 2.34.0.
- Integrated context change events, file activity filters, command execution telemetry, and verified parent-child subagent summaries with redacted paths and secrets.

### UI Fixes & Customizations Avoidance
- Fixed lingering thin blue empty bars (`#ctx-ov-pinned-banner` and `#dock-fallback-note` / `#dock-open-feedback`) caused by `[hidden]` CSS specificity overrides. Banners now collapse completely when hidden or empty and appear only with active message text.
- Fixed Customizations / Marketplace / plugin detail panel avoidance and prevented archived `/c/...` conversation routes without a composer from being mislocked.
- Updated `Antigravity` rows in the Live Requests table to render `antigravity-color.svg` (redistribution license pending verification in `THIRD_PARTY_NOTICES.md` §3.4) while keeping existing source text, models, and other icons unchanged.

### Host Compatibility, Recovery & Issue #17 Helper Closure
- Added Antigravity `2.34.0` window loader anchor (`loadHubWindowUrl`), same-origin `authBootstrap` fallback, version-isolated ASAR backup/recovery (`host-recovery.js`), and macOS `ElectronAsarIntegrity` preflight guards.
- Removed tracked prebuilt `scripts/cli-window-helper.exe` from Git. Windows local packaging and installation now compile from `scripts/cli-window-helper.cs` in a temporary directory with SHA-256 verification and automatic fallback to standard console (`cmd.exe /d /k`), preserving attribution to `@riandycandra`.
- Client UI localization upstream: Antigravity UI localization is based on Antigravity-Chinese-Localization (`v2.34.0`), thanks to aabbWei and antigravity-cn-community contributors (MIT License; see `THIRD_PARTY_NOTICES.md`).
- Known pending items: redistribution license for `antigravity-color.svg` remains to be verified; physical macOS signed install/`watch` and live split-pane/Side Question visual capture remain pending physical hardware validation.

</details>

---

# v0.8.9 β

**简体中文** · [English](#english)

<details open>
<summary><b>简体中文</b></summary>

### 存储与底层稳定性
- 账本 .bak 轮转防堆积. 仅在语义内容或版本变更时备份. 单账本最多保留 3 份. 升级安装自动清理历史堆积仅留最新 1 份.
- 异步非阻塞文件锁. 账本与设置目录锁支持超时控制. 空锁保护与死进程锁自动回收. 彻底消除事件循环阻塞.
- 修复 CLI 启动器传参. 移除无效的 -keyring-unavailable 参数. 改为无损凭据交接启动.

### 界面与顶栏交互精炼
- 顶栏内联锚定防抖动. 顶栏组件始终内联锚定在会话标题栏右侧打开 IDE 按钮左侧同一水平线上. 彻底移除延迟瞬移的 flow 与 fixed 定时器切换. 停靠位置默认内联并安全回退历史配置.
- Antigravity 2.33 全屏子视图避让. 适配 Customizations 自定义扩展等非会话子视图顶栏避让. 绝不遮挡原生返回. 搜索与操作按钮.
- 配额圆环四态切换. 支持 auto. 5h. weekly. both 四态切换与右键即时刷新. 双窗口池支持 5h 与 7d 双行微缩展示.
- 首字等待纯 SVG 沙漏. 首字等待动效改为纯 SVG 沙漏. 消除每秒跳秒文字导致的宽度抖动.
- 弹窗顶栏操作区回迁. 简繁 EN 语言切换. GitHub 入口与检查更新按钮紧凑并排于顶部标题栏右侧. 配置页精简去重.

### CLI 终端能力拓展
- node cli.js usage 严格只读. 终端用量查询支持日. 周. 月. 全量及账号与模型筛选. 共享账本且全程 readOnly 零写零删.
- CLI 实时监视与会话拉起. node cli.js monitor 多会话实时监视. node cli.js launch-cli 一键拉起终端.
- 上下文预算与 Gate 3A 解锁. node cli.js context-set 与 context-status 支持 Antigravity CLI 128K 与 256K Gate 3A 解锁控制.

### 模型识别与网络容错
- 模型识别与配额匹配. 新增 Gemini 4 Neon 模型识别与 Ultra 5x/20x 支持. 适配 Antigravity 2.33 统一 Gemini 配额池.
- PR #57 过滤预览页. 过滤内置浏览器打开的第三方本地预览页并支持多 origin 容错连接.
- 免 CDP 探测复用. 调试端口关闭时复用主进程 origin 探测. 提供手动重启指引且绝不强杀用户进程.
- 主题与中断修复. 修复浅色主题热力图配色方向. 同步推荐配置磁盘真实状态. 上下文取消归类为中性中断.

### 版本与致谢
- 版本说明. 语义化版本 0.8.9-beta.1. 界面展示 0.8.9 β. 支持预发布版本对比与测试更新通道. 安装或升级前请退出 Antigravity 客户端后执行 node cli.js install.
- 贡献者致谢. 感谢 @yuanyang749 提交 PR #57 贡献过滤第三方本地预览页与多 origin 容错探测. 感谢 @feizaodemon 提交 PR #52 贡献 Gemini 4 Neon 与 2.33 统一配额池匹配. 感谢 @Tswatery 提交 PR #53 与 PR #38 贡献浅色主题热力图配色修复及上下文取消中性中断归类. 感谢 @Kisaragi-Mio-0127 提交 PR #47 修复推荐配置复选框磁盘状态同步. 感谢 @JYPYYy 提交 PR #35 贡献 CLI 上下文解锁分析与 128K Gate 3A 参考. 感谢 @Nymph-Beta 提交 Issue #42 与 PR #43 协助定位 macOS 2.33 无 CDP 窗口探测.

</details>

<details id="english">
<summary><b>English</b></summary>

### Storage & Core Stability
- Ledger .bak rotation. Backups trigger only on semantic content or version changes. Retains up to 3 copies per ledger and prunes historical backlog to 1 copy on upgrade.
- Asynchronous non-blocking file locks. Ledger and config directory locks support timeout handling. empty-lock grace protection. and dead-process reclamation without blocking the event loop.
- CLI launcher parameter fix. Removed invalid -keyring-unavailable flag and switched to lossless credential handoff.

### UI & Top Bar Streamlining
- Top bar inline anchor without jitter. The top bar host is inline-anchored directly to the left of the Open IDE button on the session titlebar line. Flow and fixed timer switching eliminated. Docking defaults to verified top bar inline mode with safe legacy rollback.
- Antigravity 2.33 subview avoidance. Adapted layout for non-conversation full-screen subviews like Customizations. never overlapping native back. search. or action controls.
- Quota ring 4-mode switching. Supports auto. 5h. weekly. and both modes with right-click instant bucket recalculation. Dual-window pools render compact 5h/7d dual rows.
- Pure SVG hourglass waiting indicator. Replaced per-second waiting text with an animated SVG hourglass. eliminating horizontal width jitter.
- Header action layout restored. SC. TC. EN language toggles. GitHub repo link. and check updates button compactly arranged on the top right alongside theme toggle. Duplicate sections in Settings removed.

### Terminal CLI Capabilities
- Strictly read-only node cli.js usage. Terminal usage queries support day. week. month. all-time. account. and model filters. Fully shared ledger under readOnly zero-write guarantees.
- CLI session monitor and launcher. node cli.js monitor for multi-session live monitoring and node cli.js launch-cli to spawn external CLI sessions.
- Context budget and Gate 3A unlock. node cli.js context-set and context-status manage context budgets and toggle 128K / 256K Gate 3A unlocks.

### Model Detection & Network Resilience
- Model detection and quota matching. Added Gemini 4 Neon detection and Ultra 5x/20x support. adapted to Antigravity 2.33 unified Gemini quota pool.
- PR #57 preview webview filtering. Ignores third-party preview webviews opened in the built-in browser and adds resilient multi-origin discovery.
- CDP-free discovery reuse. Reuses main-process origin discovery when debugging ports are disabled. providing manual launch instructions without killing running processes.
- Theme and interruption fixes. Fixed light-theme heatmap polarity. synced recommended settings checkboxes with on-disk state. and classified context cancellations as neutral interruptions.

### Version & Acknowledgments
- Client UI localization upstream. Antigravity UI localization is based on [Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) (`v2.34.0`), thanks to **aabbWei** and **antigravity-cn-community contributors** (MIT License; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
- Release info. Semantic version 0.8.9-beta.1. display version 0.8.9 β. Supports prerelease comparison and beta update channel. Fully quit Antigravity desktop before running node cli.js install.
- Contributor credits. Thanks to @yuanyang749 for PR #57 filtering third-party local preview pages and adding multi-origin discovery. Thanks to @feizaodemon for PR #52 adding Gemini 4 Neon and 2.33 unified quota pool matching. Thanks to @Tswatery for PR #53 and PR #38 fixing light-theme heatmap colors and classifying context cancellations as neutral interruptions. Thanks to @Kisaragi-Mio-0127 for PR #47 syncing recommended settings checkboxes with on-disk state. Thanks to @JYPYYy for PR #35 contributing CLI context unlock analysis and 128K Gate 3A references. Thanks to @Nymph-Beta for Issue #42 and PR #43 helping diagnose CDP-free window discovery on macOS 2.33.

</details>
