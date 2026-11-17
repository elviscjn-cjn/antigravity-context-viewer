# Antigravity 对话上下文查看器与 Token 用量看板

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

给 Antigravity 桌面客户端补上上下文和用量信息. 方便查看当前会话用了多少上下文. 各模型还剩多少额度. 以及历史 Token 消耗.

## 演示

https://github.com/user-attachments/assets/46e3a6f9-5127-4470-a2ef-01525736ec5b

[下载高清 MP4](https://raw.githubusercontent.com/elviscjn-cjn/antigravity-context-viewer/main/assets/demo.mp4)

## 功能

- **上下文监控.** 查看当前会话已用 Token 和剩余空间. 按模型分别保存上下文长度. 支持预设和自定义设置及恢复默认. 展示已保存设置与实际请求预算的区别.
- **模型额度.** 顶栏圆环展示剩余额度. 展开查看共享额度池. 可获取的 5 小时及每周额度和重置时间. 支持刷新及低额度提醒.
- **模型列表额度联动.** 设置上下文时可以直接查看各模型余量. 区分额度耗尽和无权限及未知状态.
- **生成速度.** 查看输出速度. 首字延迟. 生成耗时及本次输出 Token. 支持基于本地历史记录的速度对比.
- **会话明细.** 查看提示词和回复及思考和工具调用的统计. 展示可读取附件的估算及覆盖情况.
- **历史用量.** 查看桌面端与 CLI 的已采集用量. 提供不同周期统计和活跃热力图.
- **费用参考.** 根据已记录用量提供 API 预估费用和订阅对比. 不代表实际订阅扣费.
- **语言与外观.** 插件面板支持简体中文. 繁体中文和 English. 支持主题及配色调整.
- **可选增强.** 提供客户端汉化. 免 TUN 本地代理. 提示词档位和中文会话标题等设置. 按平台及客户端能力提供支持.
- **CLI 和更新.** 从顶栏启动已安装的 Antigravity CLI. 支持在插件面板检查更新. 安装器提供备份和完整性校验及还原.

上下文设置的实际效果取决于模型和客户端及服务端限制. 不代表所有模型都能无限扩容. 模型设置列表用于配置上下文. 不会替代客户端切换实际聊天模型.

免 TUN 功能需要可用的本地代理. 不是免费网络服务.

目前主要在 Windows 桌面客户端验证. Mac 兼容问题会继续跟进. IDE 专属支持正在规划开发.

## 界面语言

- **插件面板三语言**：面板内置 **简体中文**、**繁體中文**、**English** 即时切换与持久保存，覆盖全部页签、图表、价格账单与系统增强页（`src/renderer/i18n.js`）。
- **客户端语言与授权说明**：桌面端界面语言支持切换 **简体中文**（内置自主整理的 `i18n/zh-CN.json` 与 `i18n/i18n-runtime.js`）或 **英文原版**。因外部繁体词典仓库 `qqxpee/antigravity2-cn` 未声明开源许可证，本版本未内置客户端繁體词典；繁體中文选项仅作用于插件自身面板。

---

## 🤖 给 AI 智能体的一键安装指令 (For AI Agents)

如果你将本仓库交给 AI 助手安装，只需对 AI 说：**“读取仓库里的 `AGENTS.md` 或 `README.md`，帮我安装这个上下文查看器与 Token 看板”**。

AI 智能体只需在仓库根目录执行以下命令完成持久化安装，**涉及主进程/预加载/新模块升级（如 0.8.5）必须完全重启客户端**：

```bash
# 1. 持久化写入 ASAR 与全部插件模块
node cli.js install

# 2. 完全退出所有 Antigravity 窗口（含系统托盘图标中的“退出”）并重新打开

# 3. 重启后验证安装与模块运行状态
node cli.js status
```

> [!IMPORTANT] **AI 智能体执行与验证边界规范（见 [`AGENTS.md`](AGENTS.md)）**：
> - **零外部依赖**：内置原生 Node.js ASAR 解包/封包引擎（[`asar-engine.js`](asar-engine.js)），无需执行 `npm install`。
> - **`node cli.js live` 验证范围说明**：CDP 免改盘热注入（以及安装器附带的热挂载）**仅能加载前端渲染层，用来检查 UI 排版与静态/渲染文案**；无法更新运行中进程的主进程钩子 (`meter-main.js`)、预加载桥接接口 (`preload`) 或新后台模块 (`meter-enhance.js`)，切勿把 `live` 热注入当作完整升级验收。
> - **严禁在对话内强杀宿主进程**：在 Antigravity 会话内执行时，切勿关闭或杀死 `Antigravity.exe`；持久化安装后需由用户手动完全退出并重启客户端后再核查 `status`。
> - **汉化与上下文边界**：安装器检查未修改文件的 SHA-256，以检测对其他补丁内容的意外修改。显示预算变更与补丁加载均不等于真实超长请求已被服务端通过。

---

## 🚀 快速开始 (Quick Start)

### 方式一：一键脚本（适合日常手动安装）

- **Windows**：
  - 安装 / 更新：双击运行 [`install.bat`](install.bat)
  - 卸载 / 还原：双击运行 [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**：
  - 安装 / 更新：`./install.sh`
  - 卸载 / 还原：`./uninstall.sh`

### 方式二：CLI 命令行管理器

```bash
# 1. 环境健康预检（自动探测 Node、Antigravity 安装路径、CDP 端口与 Python）
node cli.js check

# 2. 一键安装（ASAR 持久化注入 + 当前运行窗口 CDP 即时热生效）
node cli.js install

# 3. 仅对当前运行窗口进行 CDP 免改盘热挂载
node cli.js live

# 4. 查看当前安装状态与实时会话上下文用量
node cli.js status

# 5. 一键无损还原安装前的原始 app.asar
node cli.js restore

# 6. 指定自定义客户端路径安装
node cli.js install --path "<path-to-app.asar>"

# 7. 查看 / 应用 / 还原系统增强（提示词档位、中文标题、客户端语言与品牌展示）
node cli.js enhance-status
node cli.js enhance --tier 3 --chinese-title on --brand-title english
node cli.js enhance-restore
```

---

## 🧪 自动化测试 (Testing)

```bash
npm test
```

测试覆盖 Token 去重、服务端超限、会话切换、存储失败、代理配置、订阅设置与渲染层状态. 附件扫描测试可单独运行 `python -m unittest attachment_scan_test.py`. 单测不替代宿主客户端中的安装与界面验证.

---

## 📁 仓库结构 (Repository Structure)

```text
antigravity-context-viewer/
├── assets/                                 # 演示动图、高清录屏与实拍截图
│   ├── demo-01-context-audit.gif / .mp4    # 演示 1：会话上下文监控与底层技术参数附件审计
│   ├── demo-02-token-heatmap.gif / .mp4    # 演示 2：Token 历史用量统计与 52 周活跃热力图交互
│   ├── demo-03-panel-switching.gif / .mp4  # 演示 3：独立双面板平滑切换与侧边栏防遮挡自适应
│   ├── demo-04-responsive-collapse.gif/.mp4# 演示 4：顶栏胶囊多级响应式折叠与窄屏自适应
│   ├── panel-context-main.png              # 实拍 1：会话上下文与生成监控主视图
│   ├── panel-context-audit-expanded.png    # 实拍 2：会话上下文全展开：外观调色与底层审计
│   ├── capsule-speed-and-tooltip.png       # 实拍 3：顶栏环形胶囊、实时速度与原生气泡提示
│   └── panel-token-heatmap-customizer.png  # 实拍 4：Token 用量总览与 5 档热力图逐格独立自定义
├── asar-engine.js                          # 零外部依赖的纯原生 Node.js ASAR 打包/解包引擎
├── cli.js                                  # 统一命令行接口 (install / live / status / check / restore / enhance*)
├── install.js                              # ASAR 注入与运行时热挂载调度器
├── restore.js                              # 原始备份校验与无损还原调度器
├── meter-main.js                           # Electron 主进程窗口钩子与只读 IPC 通道
├── meter-core.js                           # 上下文估算、Token 统计与分词引擎
├── meter-context-unlock.js                 # 桌面端/CLI 上下文长度模式改写与安全还原引擎
├── meter-enhance.js                        # 系统提示词 0~4 档、防幻觉与中文标题等长替换引擎
├── i18n/                                   # 客户端简体中文化词典与运行时 (zh-CN.json / i18n-runtime.js)
├── unlock/                                 # PR #3 跨平台解锁工具与文档 (language-server & agy-cli)
├── meter-renderer.js                       # 渲染层构建产物 (0.8.5)
├── src/renderer/                           # 渲染层源码
├── scripts/                                # 构建、发布打包与基准测试
├── meter-collector.js                      # 本地会话归档读取与附件提取收集器
├── attachment_scan.py                      # 全格式附件只读分析核心脚本 (Office / PDF / Code)
├── AGENTS.md                               # AI 智能体专用一键安装与校验指南
├── install.bat / install.sh                # 一键安装入口脚本
└── uninstall.bat / .sh                     # 一键卸载与还原入口脚本
```

---

## 🛡️ 安全说明与原生窗口辅助程序 (Security & Transparency)

- **用途说明**：Windows 安装包中的可选组件 `scripts/cli-window-helper.exe`（源码 [scripts/cli-window-helper.cs](scripts/cli-window-helper.cs)）仅用于在从插件弹窗一键启动 `agy` CLI 时定位新控制台窗口、按当前工作区居中并激活前台焦点，不包含任何联网、持久化或后台驻留逻辑。
- **工具链与构建命令**：基于 Windows 自带 `.NET Framework 4.0` 编译，可随时自行审计源码并本地重编：
  ```powershell
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu /optimize+ /out:scripts\cli-window-helper.exe scripts\cli-window-helper.cs
  ```
- **当前随附二进制 SHA-256**：`e6a62cbb03163107db889e6accf7c05049ecf949c89f29afaf072c66fe09eac9`（注：.NET Framework `csc.exe` 默认嵌入 PE 时间戳/MVID，自行本地或由 `.github/workflows/release.yml` 在 `windows-latest` 上从同份源码重编会生成有效功能等价但哈希值不同的二进制；CI 现场编译旨在提升构建来源透明度，但**不代表所有杀软引擎一定会停止触发告警**）。
- **常见安全软件检测说明**：由于该程序是约 15 KB 的未数字签名原生辅助二进制且调用了 `keybd_event`、`AttachThreadInput`、`AllowSetForegroundWindow`、`CreateToolhelp32Snapshot` 与 `Process.Start("cmd.exe")`，部分杀毒引擎可能报启发式可疑告警。
- **无需关闭杀软的可选降级**：如果您不希望保留任何预编译 `.exe` 或其被安全软件拦截，无需关闭安全软件，也无需购买签名证书，可直接删除 `scripts/cli-window-helper.exe`。`meter-cli-launcher.js` 检测到 helper 缺失或失败时会自动降级为直接启动标准 Windows 控制台 `cmd.exe /d /k`，CLI 启动与对话能力完全正常（仅不再自动居中或强制置顶窗口）。

---

## 🤝 社区、贡献署名与支持 (Community & Acknowledgements)

- **[LINUX DO](https://linux.do/)**：本项目支持并认可 LINUX DO 社区，欢迎各位社区佬友交流探讨。
- **上下文解锁原方案**：感谢 **Linux.do @23375** 公布的上下文长度限制分析与修补思路（<https://linux.do/t/topic/3117832>）。
- **PR #3（多模式上下文解锁 & agy CLI 工具链）**：感谢 **[@anyu0804](https://github.com/anyu0804)** 贡献 `ORIG / CONST / DYN` 模式、实验覆盖门禁分析、`cli_serializer_max_ctx` 对齐及跨平台 `unlock/` 工具与文档。
- **PR #4（系统增强中心与防幻觉提示词）**：感谢 **[@Jia131313](https://github.com/Jia131313)** 贡献系统提示词 `0~4` 档位精简、防幻觉约束、中文会话标题、品牌展示与推荐配置体系。
- **PR #7 / #12（模型剩余配额圆环、双窗口与主题/Opt-in 保护）**：感谢 **[@Azreal2021](https://github.com/Azreal2021)** 与 **[@Andrew-liu](https://github.com/Andrew-liu)**。
- **PR #9（2.31+ 模型计价、共享池匹配与三源账本实时同步）**：感谢 **[@MoiraToki](https://github.com/MoiraToki)**。
- **PR #11（沙箱 Preload 汉化配置门禁安全读取）**：感谢 **[@yinshengphy](https://github.com/yinshengphy)**。
- **PR #13（弹窗动态锚点定位与展开防抖动）**：感谢 **[@nocoo](https://github.com/nocoo)**。
- **PR #14（macOS 兼容适配评估参考）**：感谢 **[@nokiy](https://github.com/nokiy)**。
- **Issue #17（`cli-window-helper` VirusTotal 检测溯源、文档透明度与 Windows CI 源码构建建议）**：感谢 **[@riandycandra](https://github.com/riandycandra)**。
- **PR #21（繁体中文面板译文精细优化）**：感谢 **[@U1tr0n-Lee](https://github.com/U1tr0n-Lee)**。
- **Issue #22（GitHub API 限流时官方 Atom/Web 更新回退方案）**：感谢 **[@zhao33079-zhao](https://github.com/zhao33079-zhao)**。


## 作者

[ELVISCHEN](https://github.com/elviscjn-cjn).
