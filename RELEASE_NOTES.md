# v0.8.10

**简体中文** · [English](#english)

<details open>
<summary><b>简体中文</b></summary>

### Antigravity v2.34.0 紧急兼容热修
- 兼容新版窗口加载锚点. modular-installer.js 与 install.js 统一支持旧版 void win.loadURL 与 Antigravity v2.34.0 的 void loadHubWindowUrl 调用. 严格保持唯一锚点 fail-closed 校验与原位重装还原能力.
- 多层 CSRF 鉴权回退. 适配 v2.34.0 引导鉴权下未认证 HTML 返回空 csrfToken 的变更. local-api.js 按同源校验优先读取主进程 authBootstrap 内存凭据. 其次精确匹配存活进程对应的 daemon/hub_*.json. 并修复 CDP 在 hasConfig 为 true 且 token 为空时跳过提取的问题. 补充 localStorage.agy_session_csrf_token 回退.
- 令牌轮换重试与扫描修复. connectOrigin 的 call 方法与 meter-collector.js 的会话扫描支持遇到 HTTP 401 或 HTTP 403 时自动重新解析 CSRF 令牌并执行单次重试. 渲染层同步适配 getRendererCsrfToken 避免额度看板与后台轮询报本地鉴权失败.
- 回归测试补齐. 新增 meter-v234-compat.test.js 覆盖窗口加载锚点匹配. 歧义拒绝. 安装卸载还原. authBootstrap 同源与跨端口隔离. 无 CDP 回退以及会话扫描回归.

### 版本与致谢
- 版本说明. 内部语义化版本号 0.8.10. 界面展示 0.8.10. 升级前请先完全退出 Antigravity 客户端后执行 node cli.js install.
- 贡献者致谢. 感谢 @Jemiking 提交 PR #69 贡献 Antigravity v2.34.0 窗口加载与引导鉴权完整兼容修复. 感谢 @locking-main-163 与社区用户在 Issue #62 及时反馈并协助定位问题.

</details>

<details id="english">
<summary><b>English</b></summary>

### Antigravity v2.34.0 Compatibility Hotfix
- Window loader anchor compatibility. modular-installer.js and install.js share findWindowLoadHookTarget and injectWindowLoadHook to support both legacy void win.loadURL and Antigravity v2.34.0 void loadHubWindowUrl statements with strict fail-closed uniqueness checks and clean in-place reinstall/restore.
- Multi-tier CSRF auth fallback. Adapts to authenticated UI bootstrap where unauthenticated HTML returns an empty csrfToken. local-api.js resolves credentials via same-origin verified main-process authBootstrap first. then live daemon/hub_*.json files. fixes CDP extraction skipping when hasConfig is true with an empty token. and falls back to localStorage.agy_session_csrf_token.
- Token refresh retry and collector fixes. connectOrigin and meter-collector.js automatically refresh the CSRF token once on HTTP 401 or HTTP 403. Renderer requests use getRendererCsrfToken to prevent local authentication failures in quota and trajectory polling.
- Regression suite coverage. Added meter-v234-compat.test.js covering loadHubWindowUrl anchoring. ambiguity rejection. install/reinstall/restore flows. authBootstrap origin isolation. CDP-free daemon discovery. and collector/quota integration.

### Version & Acknowledgments
- Release info. Semantic version 0.8.10. display version 0.8.10. Fully quit Antigravity desktop before running node cli.js install.
- Contributor credits. Thanks to @Jemiking for PR #69 fixing Antigravity v2.34.0 window loader and bootstrap CSRF authentication. Thanks to @locking-main-163 and community contributors on Issue #62 for timely bug reports and diagnostics.

</details>
