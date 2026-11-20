# v0.8.9

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
- 版本说明. 内部语义化版本号 0.8.9. 界面展示 0.8.9. 升级前请先完全退出 Antigravity 客户端后执行 node cli.js install.
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
- Release info. Semantic version 0.8.9. display version 0.8.9. Fully quit Antigravity desktop before running node cli.js install.
- Contributor credits. Thanks to @yuanyang749 for PR #57 filtering third-party local preview pages and adding multi-origin discovery. Thanks to @feizaodemon for PR #52 adding Gemini 4 Neon and 2.33 unified quota pool matching. Thanks to @Tswatery for PR #53 and PR #38 fixing light-theme heatmap colors and classifying context cancellations as neutral interruptions. Thanks to @Kisaragi-Mio-0127 for PR #47 syncing recommended settings checkboxes with on-disk state. Thanks to @JYPYYy for PR #35 contributing CLI context unlock analysis and 128K Gate 3A references. Thanks to @Nymph-Beta for Issue #42 and PR #43 helping diagnose CDP-free window discovery on macOS 2.33.

</details>
