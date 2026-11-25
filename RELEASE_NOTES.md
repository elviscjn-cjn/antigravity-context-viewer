# v0.9.3

[English](#english)

### 原生设置与界面交互

- 插件设置以同级独立页接入 Antigravity 2.35.1 原生设置侧栏. 支持单击直达. 页签往返切换恢复与键盘操作.
- 统一原生设置页与面板内的下拉菜单和候选账号滑动开关视觉. 修复深色主题下原生下拉菜单白底白字与卡片裁切问题.
- 修复 Windows 桌面端标题栏空白区无法拖动窗口的问题. 补齐顶栏额度圆环左右键分工与输入框底栏隐藏规则.
- 客户端语言切换的重启确认升级为顶层原生弹窗. 解决设置弹窗打开时确认控件不可操作的问题.

### 多账号与体验改进

- 多账号自动切号监控项收敛为 Gemini 与 Claude / GPT 的 5 小时和周额度四项并按池分组.
- 持久化自动切号成功提示的消费记录. 修复历史切号提示在重启后重复弹出的问题.
- 移出自绘模型选择器并复用 Antigravity 原生模型菜单. 新增下一句预测建议. 默认关闭并可在设置中按需开启.
- 同步主分支代码与安装产物到 0.9.3. 修复直接从默认分支安装时的版本错配问题.

感谢 [@Evander-8](https://github.com/Evander-8). [@zhao33079-zhao](https://github.com/zhao33079-zhao). [@IpiggyI](https://github.com/IpiggyI) 和 [@jzPPP3333](https://github.com/jzPPP3333). 贡献来源和采纳范围见 [Contributors](https://github.com/elviscjn-cjn/antigravity-context-viewer/blob/v0.9.3/CONTRIBUTORS.md).

Antigravity 界面汉化基于 Antigravity-Chinese-Localization. 感谢 aabbWei 与 antigravity-cn-community 贡献者.

## English

- Integrated Context Meter as a peer page in Antigravity 2.35.1 native Settings with single-click navigation, tab switch recovery and keyboard support.
- Unified custom dropdown menus and candidate toggle switches across native Settings and the panel, fixing white-background native select popups and card clipping in dark mode.
- Fixed Windows titlebar drag regions when the title menu bar is present, and upgraded the language-switch restart prompt to a top-layer native dialog.
- Scoped auto-switch targets to Gemini and Claude / GPT 5-hour and weekly quotas, persisted consumed switch notice IDs across cold restarts, removed the custom model picker in favor of the native menu, and added opt-in next-prompt suggestions.
- Synced the default branch with 0.9.3 so repository-based installations match the latest release.
