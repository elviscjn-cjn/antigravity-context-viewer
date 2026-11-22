# v0.9.0 beta1

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
### 贡献者致谢

- @Tswatery 将上下文取消归类为中性中断. [PR #38](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/38)
- @Kisaragi-Mio-0127 修复推荐配置复选框与磁盘状态不同步的问题. [PR #47](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/47)
- @feizaodemon 添加 Gemini 4 Neon 识别并适配 Antigravity 2.33 的统一 Gemini 配额池. [PR #52](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/52)
- @Tswatery 修复浅色主题下紫色热力图与图例方向相反的问题. [PR #53](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/53)
- @yuanyang749 过滤内置浏览器中的第三方本地预览页，并改进多 origin 连接容错. [PR #57](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/57)

#### 挂载与兼容性相关贡献

- @x1051445024 提供 2.34.0 窗口加载锚点与空 HTML 场景的鉴权方案. [PR #61](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/61)
- @Hirasawa8 提供 2.34.0 安装与桌面额度恢复方案. [PR #66](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/66)
- @shixin08052 提供 2.34.0 窗口加载与 Hub 同源会话适配. [PR #67](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/67)
- @Xuhang0607 协助解决 2.34.0 桌面额度鉴权失败. [PR #68](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/68)
- @Jemiking 提供 2.34.0 窗口加载与 bootstrap CSRF 兼容方案. [PR #69](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/69)
- @awu5425 提供安装器对新版 loadHubWindowUrl 锚点的适配. [PR #73](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/73)
- @LC9999216 独立提交同一窗口加载与鉴权问题的修复方案，与本版采用的方案重叠. [PR #65](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/65)
- @Nymph-Beta 协助定位 macOS 未开启 CDP 时的 live / watch 挂载问题，本版部分采用. [PR #43](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/43)

### macOS 使用反馈

用 macOS 的朋友请多反馈这个版本的使用情况. 安装、升级或日常使用遇到问题，请附上 macOS 和 Antigravity 的版本，以及出现问题的操作. 运行正常也可以留个反馈，方便我确认不同机型和系统版本的兼容性.

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
### Contributors

- @Tswatery classified context cancellations as neutral interruptions. [PR #38](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/38)
- @Kisaragi-Mio-0127 fixed recommended settings checkboxes to reflect the saved configuration. [PR #47](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/47)
- @feizaodemon added Gemini 4 Neon detection and support for the unified Gemini quota pool in Antigravity 2.33. [PR #52](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/52)
- @Tswatery corrected the light-theme heatmap colors to match the legend. [PR #53](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/53)
- @yuanyang749 filtered third-party local previews in the built-in browser and made connections more resilient across origins. [PR #57](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/57)

#### Attachment and compatibility contributions

- @x1051445024 Proposed fixes for the 2.34.0 window loader and authentication when the HTML contains no token. [PR #61](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/61)
- @Hirasawa8 Proposed 2.34.0 installation and desktop quota fixes. [PR #66](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/66)
- @shixin08052 Proposed 2.34.0 window loading and same-origin Hub session support. [PR #67](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/67)
- @Xuhang0607 Helped address 2.34.0 desktop quota authentication failures. [PR #68](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/68)
- @Jemiking Proposed 2.34.0 window loader and bootstrap CSRF compatibility fixes. [PR #69](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/69)
- @awu5425 Proposed installer support for the new loadHubWindowUrl anchor. [PR #73](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/73)
- @LC9999216 Independently submitted an overlapping fix for the same window loading and authentication issue. [PR #65](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/65)
- @Nymph-Beta Helped diagnose macOS live / watch attachment without CDP, with parts of the proposal adopted. [PR #43](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/43)

### macOS Feedback

If you use macOS, please tell me how this release works for you. If you run into problems installing, updating, or using it, include your macOS and Antigravity versions and what you were doing when the issue occurred. Reports that everything works also help me confirm compatibility across Macs and macOS versions.

</details>
