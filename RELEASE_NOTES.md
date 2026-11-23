# v0.9.2

[English](#english)

### 性能与应用内更新

- 更新包解压在后台子进程执行，校验仍使用官方 SHA-256。桌面应用内更新写入磁盘后提示重启，避免当前窗口同时换渲染器和后台服务。
- 隐藏的历史子页等打开后再绘制，后台降低历史轮询和空闲会话扫描频率。历史更新按账号核对，避免用当前缓存覆盖切换后的账号。
- 宿主更新移除插件后，更新检查按磁盘实际状态识别旧安装记录。

### 首次安装

- 核心看板可从顶栏打开。汉化、中文标题、上下文解锁、压缩恢复、免 TUN、三个径向入口、输入框底栏、回复尾部统计和自动检查更新默认关闭。提示词增强默认 0 档。可在配置页按需手动启用。
- 首装不会挂载宿主汉化运行时。已有统一配置中的手动选择会随升级保留。
- 实时请求列表恢复 Antigravity 原版彩色图标。

感谢 [@ltppp](https://github.com/ltppp)、[@tihonovaaybeniz-code](https://github.com/tihonovaaybeniz-code)、[@Nymph-Beta](https://github.com/Nymph-Beta)、[@lllhhhh](https://github.com/lllhhhh) 和 [@Staaaying](https://github.com/Staaaying)。贡献来源和采纳范围见 [Contributors](https://github.com/elviscjn-cjn/antigravity-context-viewer/blob/v0.9.2/CONTRIBUTORS.md)。

Antigravity 界面汉化基于 Antigravity-Chinese-Localization，感谢 aabbWei 与 antigravity-cn-community 贡献者。

## English

- Update extraction runs in a child process. The desktop updater writes the verified package to disk and asks for a restart before loading the new version.
- Hidden history views render on demand. Idle sessions poll less often. History revisions are checked against the account, and stale installation records are ignored when the patch is missing.
- Optional modules and display extensions start off on first install. Host translation requires manual opt-in. Prompt enhancement starts at level 0. Explicit existing settings are preserved.
- Restored the original Antigravity icon in Live Requests.
