# v0.9.4 Beta 1 · Mac 兼容性测试版

之前开发重心确实更多放在 Windows 上. 因为新功能大部分都是我在 Windows 上开发和测试的. Mac 的兼容性确实做得不太好. 我自己用下来都觉得很答辩. 这次先发一个 Mac 兼容性 Beta. 把之前容易出问题的启动挂载. 免 TUN. 汉化. 切号和分屏都实际测了一遍. 能复现的问题也修了一轮.

这次先发 Apple Silicon Mac 安装包. 已在 Antigravity 2.36.0 上实测. 开了 Beta 通道的 Mac 用户可以在插件里检查更新. 遇到问题的话. 欢迎把 macOS 版本. Antigravity 版本和复现步骤发给我.

Windows 这边还有不少新功能在开发. 有些也还没移植到 Mac. Windows 后面预计会是一波比较大的更新. 正式版还是发 0.9.4. 更新内容多也一样按顺序发版本.

后续我会平衡 Mac 和 Windows 的开发和测试. 新功能尽量同步. 两端都做实机回归. 尽可能让两边用户的体感一致. Windows 的更新还请大家继续耐心等一下. 谢谢大家的等待和反馈.

## 安装

下载 `antigravity-context-viewer_0.9.4-beta.1_darwin_arm64.zip` 并解压. 使用 Node.js 22.4 或更新版本. 在解压目录运行 `node cli.js launcher:install --add-to-dock`. 完全退出 Antigravity 后，从 Dock 的 `Antigravity (Context Meter)` 启动.

Antigravity 界面汉化基于 Antigravity-Chinese-Localization. 感谢 aabbWei 与 antigravity-cn-community 贡献者.
贡献来源和采纳范围见 [Contributors](https://github.com/elviscjn-cjn/antigravity-context-viewer/blob/v0.9.4-beta.1/CONTRIBUTORS.md).
