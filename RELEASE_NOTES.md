# v0.8.4 更新日志（本地发布候选）

## 核心功能与修复效果

1. **免 TUN 本地代理直连与配置持久化闭环（ELV-44 / ELV-61 / ELV-62）**
   - 在客户端内置启用、保存和关闭免 TUN 本地代理（支持 HTTP / SOCKS5 与 `bypassList` 绕过列表），并通过主进程拦截与 Electron Session / 子进程环境变量注入生效。
   - 修复默认或半完整安装场景下组件检测与启用提示不一致的问题，明确区分“组件未注入 / 不完整 / 已保存待重启 / 运行中已生效 / 模型请求待通过真实会话验证”，并提供准确的外部命令行补装步骤，避免陷入退出重装死循环。
   - 修复旧版 `proxy.json` 覆盖新保存的 `modules.json` 代理配置、配置异常时静默回退旧值以及冷启动未重新加载新配置的问题。
   - 注：本版本已在 Windows 真实桌面客户端（`Antigravity.exe` v2.32.1）完成“TUN 关闭 + 插件免 TUN 开启（Windows 系统代理同步开启环境）”下的真实对话收发验证；关闭 Windows 系统代理时的独立路径与更多用户机器环境仍待按需核验。

2. **客户端汉化开关、英文恢复与独立面板语言闭环（ELV-47 / ELV-60）**
   - 支持在插件面板“配置”页与 CLI 中一键开启客户端简体中文或恢复官方英文，CLI 开关与 `modules.json` 中的 `language` 字段保持严格同步，冷启动不被反向覆盖。
   - 修复 Electron 沙箱（`contextIsolation: true`）环境下因读取不到 preload 全局配置或侧边栏项目名包含中文关键词而误判英文宿主已汉化的问题；开启或关闭汉化时准确提示待重启状态，重启后不反复要求重装。
   - 修复汉化关闭时切换左上角品牌名称误触发整页翻译或误报已汉化的问题；确保插件面板自身语言（简 / 繁 / EN）与客户端宿主语言完全独立，测试结果与保存反馈等动态文案随面板语言即时切换。
   - 配置文件缺失、损坏或沙箱读取失败时严格遵循默认关闭策略，绝不暗中强制启用汉化。

3. **模型剩余配额圆环与计价账本对齐**
   - 顶部状态栏新增模型剩余配额圆环，支持 5 小时与每周双配额窗口、同名变体合并显示以及参考剩余 Token 估算。
   - 适配 Antigravity 2.31.2+ 模型计价规则与本地账本（`pricing_ledger_v1.json`）时间戳校准。
   - 提示：面板展示的美元估算与参考剩余额度仅作本地用量参考，不代表官方 API 账单。

4. **性能隔离与交互细节改进**
   - 将全量 Token 历史扫描与账本归档迁移至后台 Worker 隔离执行，优化大账本索引去重，降低主线程卡顿与频繁刷新对输入框草稿的干扰。
   - SPA 路由切换时在微任务内即时清理旧会话缓存与显示，防止快速切换会话时短暂串显上一会话的上下文数值。
   - 修复弹窗边缘对齐、展开抖动、主题背景自适应与繁体中文面板翻译。

5. **CLI 启动增强、更新限流回退与构建透明化**
   - 修复 Windows 下多路径、`agy` 包装脚本与残缺 `PATH` 环境启动 CLI 失败的问题。
   - 检查与在线更新在 GitHub API 匿名限流（`HTTP 403` / `429`）时自动回退至官方 Web `releases.atom` 与 `expanded_assets` 通道，严格校验下载域名、体积上限与 SHA-256。
   - 打包流程支持从源码构建 `scripts/cli-window-helper.exe` 并校验完整发布清单（16 项安装依赖与 SHA-256）；如实声明第三方杀毒引擎可能仍存在误报（参见 Issue #17），本版本不宣称杀毒告警已完全消失。
   - 合入 macOS 相关兼容性适配并区分平台能力提示，在 Mac / 非支持平台上诚实标注不受支持的推荐配置项，本版本不宣称已完成完整 Mac 实机支持。

---

## 社区代码采用与 PR 关联说明

> 注：下列标注“远端仍为 open”的 PR 为本候选在本地开发分支独立适配与重构集成，未擅自操作远端主线合并。

- **PR #3**（已合并主线）：[feat(unlock): 上下文解锁工具集](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/3) —— 贡献者 [`@anyu0804`](https://github.com/anyu0804)，采用并融合桌面端三档上下文切换与 `agy` CLI 上下文选择器。
- **PR #4**（已合并主线）：[新增: 客户端界面汉化与系统增强面板](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/4) —— 贡献者 [`@Jia131313`](https://github.com/Jia131313)，采用客户端汉化词典及系统增强模块架构。
- **PR #7**（远端仍为 open，本地候选独立适配集成）：[feat(quota): 顶部新增模型剩余配额圆环](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/7) —— 贡献者 [`@Azreal2021`](https://github.com/Azreal2021)，采用双配额窗口圆环、变体合并与剩余 Token 参考估算方案。
- **PR #8**（远端仍为 open，本地候选独立适配集成）：[fix(cli): 修复 Windows 下 agy CLI 探测与残缺 PATH 启动问题](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/8) —— 贡献者 [`@Azreal2021`](https://github.com/Azreal2021)，采用多路径与注册表探测逻辑。
- **PR #9**（远端仍为 open，本地候选独立适配集成）：[fix(usage): 适配 2.31.2 模型计价与配额，修复账本对齐和实时同步](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/9) —— 贡献者 [`@MoiraToki`](https://github.com/MoiraToki)，采用计价规则与账本时间戳对齐方案。
- **PR #11**（已合并主线）：[fix(chinese): respect modules.json gate in sandboxed Electron preload](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/11) —— 贡献者 [`@yinshengphy`](https://github.com/yinshengphy)，采用沙箱 preload `modules.json` 汉化门禁并拓展主进程启动快照同步。
- **PR #12**（远端仍为 open，本地候选独立适配集成）：[fix: theme bg sync, i18n opt-in guard & add model quota ring panel](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/12) —— 贡献者 [`@Andrew-liu`](https://github.com/Andrew-liu)，采用主题色同步及按需开启（opt-in）保护思路。
- **PR #13**（已合并主线）：[fix: 修复弹窗右侧边缘对齐与展开微抖动问题](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/13) —— 贡献者 [`@nocoo`](https://github.com/nocoo)，采用面板定位与防抖方案。
- **PR #14**（远端仍为 open，本地候选独立适配集成）：[feat(macos): 支持免改盘 watch 守护挂载、无 Origin 头 CDP 客户端及 macOS 全链路适配](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/14) —— 贡献者 [`@nokiy`](https://github.com/nokiy)，采用 macOS `agy` 探测、AppleScript 启动与无 Origin CDP 兼容代码。
- **PR #21**（已合并主线）：[i18n: refine Traditional Chinese panel translations](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/21) —— 贡献者 [`@U1tr0n-Lee`](https://github.com/U1tr0n-Lee)，采用繁体中文用语优化。

---

## 反馈与排查感谢名单

- 感谢 **lvmin**（#34 / #37，对应 ELV-44）、**iiyo / 烟花闪烁的夜晚**（#41，对应 ELV-60）与 **littlegrey**（#89，对应 ELV-61）协助提供实机故障描述、复现步骤与关键日志线索。
- 感谢 GitHub 社区提交和排查相关 Issue 的开发者：
  - [`@joyshan1986`](https://github.com/joyshan1986)：[Issue #1](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/1)（CLI 全局用量统计）、[Issue #19](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/19)（发布包依赖完整性检查）
  - [`@BradleyFord`](https://github.com/BradleyFord)：[Issue #15](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/15)（内置面板语言切换诉求）
  - [`@riandycandra`](https://github.com/riandycandra)：[Issue #17](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/17)（`cli-window-helper.exe` 源码编译透明化与安全说明）
  - [`@zhao33079-zhao`](https://github.com/zhao33079-zhao)：[Issue #22](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/22)（GitHub API 限流下 Web 回退更新方案）
  - [`@git-aa12138`](https://github.com/git-aa12138)：[Issue #23](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/23)（macOS 不支持项显式提示与禁止误勾选）
