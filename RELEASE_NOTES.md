# v0.8.9 β

**简体中文** · [English](#english)

<details open>
<summary><b>简体中文</b></summary>

本次测试版本聚焦稳定性修复. 终端 CLI 用量与会话监视主线能力. 以及客户端插件界面精简与停靠定制升级.

- 修复账本归属纠偏无限生成 .bak 备份问题. 仅在账本语义内容或版本号变更时备份. 单账本最多轮转保留最近 3 份. 并在升级安装时清理历史堆积仅保留最新 1 份.
- 将账本与设置目录文件锁改为异步非阻塞机制. 支持超时控制. 空锁保护与过期或死进程锁自动回收. 消除事件循环阻塞.
- 修复 CLI 启动器传递无效 `-keyring-unavailable` 参数问题. 改为无损凭据交接启动.
- 修复顶栏胶囊缩略或开关右侧辅助面板时乱飞与卡顿（Issue #54）. 顶栏组件始终内联锚定在会话标题栏右侧打开 IDE 按钮左侧同一水平线上. 彻底移除延迟瞬移的 flow 与 fixed 定时器切换. 停靠位置收口为顶栏默认显示并自动安全回退历史配置. 移除试验性未成熟入口避免操作锁死.
- 适配 Antigravity 2.33 的 Customizations 等非会话全屏子视图顶栏避让（Issue #59）. 确保绝不遮挡原生返回. 搜索与操作按钮.
- 修复顶栏配额窗口切换无反应问题. 点击任一窗口选项或右键切换时立即从 buckets 重算并当场刷新.
- 合入 PR #57 过滤内置浏览器打开的第三方本地预览页并支持多 origin 容错连接.
- 新增免 CDP 主进程 origin 探测复用能力. 客户端未开启调试端口时不再误报未运行. 而是提供对应系统的手动重启命令指引且绝不强杀用户进程.
- 新增终端用量查询命令 `node cli.js usage`. 支持按日. 周. 月. 全量以及按账号与模型筛选输出. 数据与面板严格共用同一账本且全程 `readOnly` 零写入零删档.
- 新增终端多会话实时监视 `node cli.js monitor`. 一键拉起 CLI 终端 `node cli.js launch-cli`. 以及按模型上下文预算管理 `node cli.js context-set` 与 `context-status`. 支持 Antigravity CLI 128K 与 256K Gate 3A 解锁控制.
- 弹窗顶栏操作区布局回迁. 面板语言切换（简 繁 EN）. GitHub 仓库入口与检查更新按钮统一置于顶部标题栏右侧与主题切换紧凑并排. 并清理配置页中重复区块保持清爽.
- 新增顶栏配额圆环四态窗口模式切换. 支持通过右键或配置标签页在 `auto` / `5h` / `weekly` / `both` 间切换并持久化. 双窗口池下支持 5h 与 7d 双行微缩展示.
- 将请求首字等待阶段的顶栏状态改为纯 SVG 沙漏动效. 消除每秒跳秒文字导致的横向宽度抖动.
- 新增 Gemini 4 Neon 模型识别与 Antigravity 2.33 统一 Gemini 配额池匹配. 修复浅色主题连续热力图配色方向. 同步推荐配置复选框真实磁盘状态. 并将上下文取消归类为中性中断.
- 内部语义化版本号为 `0.8.9-beta.1`. 界面展示为 `0.8.9 β`. 支持预发布版本号对比与测试版更新通道开关. 安装或升级前请先完全退出 Antigravity 桌面客户端后执行 `node cli.js install`.
- 感谢 @yuanyang749 提交 PR #57 贡献过滤内置浏览器本地第三方预览页与多 origin 容错探测支持.
- 感谢 @feizaodemon 提交 PR #52 贡献 Gemini 4 Neon 支持与 2.33 统一 Gemini 配额池匹配实现.
- 感谢 @Tswatery 提交 PR #53 与 PR #38 贡献浅色主题热力图配色修复及上下文取消中性中断归类实现.
- 感谢 @Kisaragi-Mio-0127 提交 PR #47 修复推荐配置复选框与磁盘实际持久化状态的同步.
- 感谢 @JYPYYy 提交 PR #35 贡献 Antigravity CLI 上下文解锁定位思路与 128K Gate 3A 机制参考.
- 感谢 @Nymph-Beta 提交 Issue #42 与 PR #43 协助定位 macOS 2.33 无 CDP 窗口探测问题与解决方向.

</details>

<details id="english">
<summary><b>English</b></summary>

This beta release focuses on storage reliability fixes. full terminal CLI usage and live session monitoring workflows. and streamlined client UI with customizable docking and quota display modes.

- Fixed unbounded `.bak` accumulation during ledger attribution repair. Backups now trigger only on actual ledger content or repair-version changes. retain the latest 3 copies per ledger. and prune historical backlog to the latest 1 copy on upgrade.
- Replaced blocking lock waits with an asynchronous non-blocking file lock featuring timeout handling. empty-lock grace protection. and stale or dead-process reclamation.
- Fixed CLI launcher passing invalid `-keyring-unavailable` argument. switched to lossless credential handoff.
- Fixed top bar badge shifting and jitter when collapsing or toggling the auxiliary sidebar (Issue #54). The top bar host is inline-anchored directly to the left of the Open IDE button on the session titlebar line. Docking position is streamlined to the verified default top bar inline mode with automatic safe rollback of legacy configurations. Experimental unverified docking options have been removed to prevent interface lockouts.
- Adapted top bar layout for non-conversation full-screen subviews in Antigravity 2.33 such as Customizations (Issue #59). preventing overlap with native back. search. or action buttons.
- Fixed quota badge window switching responsiveness. Selecting any window option or right-clicking immediately recalculates from pool buckets and updates the badge.
- Merged PR #57 to ignore third-party preview webviews opened in the built-in browser and support resilient multi-origin discovery.
- Reused CDP-free main-process origin discovery when debugging ports are disabled in Antigravity 2.33. Reports clear manual launch instructions without killing running user processes.
- Added `node cli.js usage` for terminal token and cost queries across day. week. month. all-time. account. and model filters. Reads the shared ledger under strict `readOnly` zero-write guarantees.
- Added `node cli.js monitor` for live terminal session monitoring. `node cli.js launch-cli` to open external CLI sessions. and `node cli.js context-set` / `context-status` with per-model context budgets and 128K / 256K CLI Gate 3A unlock support.
- Restored top bar action layout in panel header. Panel language switches (SC. TC. EN). GitHub repo link. and check updates entry are compactly arranged alongside theme toggle on the top right. with duplicate sections in the Settings tab cleanly pruned.
- Added 4-mode quota badge window switching across `auto`. `5h`. `weekly`. and `both` via right-click or Settings. displaying compact 5h/7d dual rows on dual-window pools.
- Replaced per-second waiting text in the top bar speed badge with a pure SVG hourglass animation to eliminate horizontal jitter.
- Added Gemini 4 Neon model matching and unified 2.33 Gemini quota pool detection. fixed light-theme heatmap polarity. synced recommended settings checkboxes with disk state. and classified context cancellations as neutral interruptions.
- Semantic version is `0.8.9-beta.1` and display version is `0.8.9 β` with prerelease comparison and beta update channel support. Fully quit Antigravity desktop before running `node cli.js install`.
- Thanks to @yuanyang749 for PR #57 filtering third-party local preview pages in built-in browser and adding resilient multi-origin discovery.
- Thanks to @feizaodemon for PR #52 adding Gemini 4 Neon support and 2.33 unified Gemini quota pool matching.
- Thanks to @Tswatery for PR #53 and PR #38 fixing light-theme continuous heatmap colors and classifying context cancellations as neutral interruptions.
- Thanks to @Kisaragi-Mio-0127 for PR #47 syncing recommended settings checkboxes with actual on-disk state.
- Thanks to @JYPYYy for PR #35 contributing Antigravity CLI context unlock analysis and 128K Gate 3A references.
- Thanks to @Nymph-Beta for Issue #42 and PR #43 helping diagnose CDP-free window discovery on macOS 2.33.

</details>
