# v0.9.1

[English](#english)

### 会话看板

- 调整卡片尺寸或拖动卡片时，四边会显示对齐参考线。接近两张卡片刚好并排的宽度时会吸附，再拖过临界位置即可继续调整。
- 修复 Skyline 松手后卡片偶发消失，以及窄浮层的右侧裁切、重叠和尺寸提示残留。
- 「速度与成本」新增单次请求费用卡，展示本会话估算费用、缓存节省和每条请求的 Token 与金额。没有公开费率的请求会标记为未计价。
- 保留五套内置布局。个人布局可另存、切换、改名、覆盖或删除，顺序、显隐和尺寸保存在本地。
- 分屏切换栏可悬停定位，右键聚焦或关闭单个窗格、其他窗格或右侧窗格，也可多选批量关闭。关闭操作通过宿主按钮执行并保留至少一个窗格。

### 速度对比

- 支持今日、三日、五日、一周、近 30 天、全量历史和自定义起止日期。
- 使用可核验的本地测速记录画出各模型折线。图表会按时间跨度改变聚合粒度，显示时间刻度，并区分同名模型。缺少真实耗时的历史请求无法补画。

### Antigravity 2.34.0 与免 TUN

- 明确显式代理启动配置的优先级，确保安装插件的客户端在合并登录 Shell 环境后，继续把代理传给 Language Server。
- 独立启动器提示先完整退出已运行的客户端，修正 Windows 中文路径编码，并对状态里的代理凭据脱敏。
- Windows 已验证启动链路。macOS 关闭 Clash TUN 后的真实模型收发仍待验证。

感谢社区贡献者提交的修复、测试反馈和方案。完整署名见 [CONTRIBUTORS.md](https://github.com/elviscjn-cjn/antigravity-context-viewer/blob/v0.9.1/CONTRIBUTORS.md)。

Antigravity 界面汉化基于 Antigravity-Chinese-Localization，感谢 aabbWei 与 antigravity-cn-community 贡献者。 [上游仓库](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization)

## English

- Card edges show alignment guides during resize and drag. The side-by-side guide snaps at the last width that fits. Keep dragging to pass it.
- Fixed invisible cards after drop, clipped and overlapping cards in narrow popovers, and lingering resize labels.
- The Speed and Cost preset adds per-request cost and cache savings. Keep the five built-in layouts and create, rename, update or delete your own.
- Hover to locate split panes. The pane menu can focus or close a pane, close others, or close panes to its right. Batch close uses native actions and always leaves one pane open.
- Compare model speeds for today, 3 days, 5 days, a week, 30 days, all history or a custom range. The chart uses verifiable timing from local records and adapts its time scale to the selected range.
- Improved no-TUN launcher precedence, Windows Unicode paths and proxy credential redaction. A real model round trip with Clash TUN disabled on macOS remains unverified.
