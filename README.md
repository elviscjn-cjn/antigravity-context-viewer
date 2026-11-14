# Antigravity 对话上下文查看器与 Token 用量看板

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

在 Google Antigravity 2.x 顶栏查看当前对话用了多少上下文、模型生成有多快，以及桌面端和 CLI 一共用了多少 Token.

## 演示

https://github.com/user-attachments/assets/46e3a6f9-5127-4470-a2ef-01525736ec5b

[下载高清 MP4](https://raw.githubusercontent.com/elviscjn-cjn/antigravity-context-viewer/main/assets/demo.mp4)

## 功能

- **上下文和速度**. 查看本轮上下文占用、模型预算、首字延迟（TTFT）、输出速度和总耗时。服务端用量与本地估算分别显示。
- **会话明细**. 展开提示词、回复、思考、工具调用和附件统计。可读取的附件会列出估算和覆盖情况，图片可显示像素尺寸。面板区分上下文溢出、限流和网络等常见问题。
- **Token 历史**. 汇总本地可读取的桌面端和 CLI 用量，可按来源筛选。查看日历热力图、周柱状图、月日历、年度气泡和累计曲线。
- **API 参考金额和订阅**. 按支持的模型费率估算输入、缓存和输出金额，并列出未计价的用量。可比较地区参考价、自定义实付和 API 等值金额，支持币种选择及人民币折算。API 等值金额仅供比较，实际账单以服务商为准。
- **模型设置与上下文调整**：按模型产品管理上下文偏好（恢复官方默认原有行为、固定 512,000 [512K] / 900,000 / 983,040 / 1,000,000 [1M] 或动态跟随模型），明确区分“按模型保存的偏好”与“客户端全部会话共用的当前应用值”，支持桌面端与 agy CLI 联动改写、安全备份恢复与结果框重启触发；完整融合 PR #3 跨平台解锁文档与 CLI 工具（`unlock/`）。
- **速度对比图表**：基于本地真实历史记录（每准确模型 ID 与推理力度最多 200 条）绘制柱状中位数图与时间折线图，不足 3 条自动标注样本偏少，支持 tokens/s、TTFT 与总耗时单位切换。说明：当前模型选择器仅支持“查看模型配置”，**真实聊天模型切换未实现**。
- **系统增强中心（PR #4 融合）**：提供 0~4 档系统提示词精简与防幻觉/工具契约约束（逐档明确保留/清空/替换范围）、自动中文会话标题、客户端简体中文/英文切换、三态品牌显示（Antigravity / 隐藏 / 反重力）、免 TUN 代理集成及可选“推荐配置”一键应用与恢复（默认安装不暗中启用任何改动）。
- **外观**：顶栏随可用空间收起，两个面板独立展开。支持深浅主题、热力图预设和逐档配色。
- **CLI 和更新**：从顶栏启动已安装的 Antigravity CLI，尽量沿用当前工作区和代理。可在面板内检查更新。安装器提供备份、完整性校验和还原。

## 界面语言

- **插件面板三语言**：面板内置 **简体中文**、**繁體中文**、**English** 即时切换与持久保存，覆盖全部页签、图表、价格账单与系统增强页（`src/renderer/i18n.js`）。
- **客户端语言与授权说明**：桌面端界面语言支持切换 **简体中文**（内置自主整理的 `i18n/zh-CN.json` 与 `i18n/i18n-runtime.js`）或 **英文原版**。因外部繁体词典仓库 `qqxpee/antigravity2-cn` 未声明开源许可证，本版本未内置客户端繁體词典；繁體中文选项仅作用于插件自身面板。

---

## 🤖 给 AI 智能体的一键安装指令 (For AI Agents)

如果你将本仓库交给 AI 助手安装，只需对 AI 说：**“读取仓库里的 `AGENTS.md` 或 `README.md`，帮我安装这个上下文查看器与 Token 看板”**。

AI 智能体只需在仓库根目录执行以下命令完成持久化安装，**涉及主进程/预加载/新模块升级（如 0.8.3）必须完全重启客户端**：

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
├── meter-renderer.js                       # 渲染层构建产物 (0.8.3)
├── src/renderer/                           # 渲染层源码
├── scripts/                                # 构建、发布打包与基准测试
├── meter-collector.js                      # 本地会话归档读取与附件提取收集器
├── attachment_scan.py                      # 全格式附件只读分析核心脚本 (Office / PDF / Code)
├── AGENTS.md                               # AI 智能体专用一键安装与校验指南
├── install.bat / install.sh                # 一键安装入口脚本
└── uninstall.bat / .sh                     # 一键卸载与还原入口脚本
```

---

## 🤝 社区、贡献署名与支持 (Community & Acknowledgements)

- **[LINUX DO](https://linux.do/)**：本项目支持并认可 LINUX DO 社区，欢迎各位社区佬友交流探讨。
- **上下文解锁原方案**：感谢 **Linux.do @23375** 公布的上下文长度限制分析与修补思路（<https://linux.do/t/topic/3117832>）。
- **PR #3（多模式上下文解锁 & agy CLI 工具链）**：感谢 **[@anyu0804](https://github.com/anyu0804)** 贡献 `ORIG / CONST / DYN` 模式、实验覆盖门禁分析、`cli_serializer_max_ctx` 对齐及跨平台 `unlock/` 工具与文档。
- **PR #4（系统增强中心与防幻觉提示词）**：感谢 **[@Jia131313](https://github.com/Jia131313)** 贡献系统提示词 `0~4` 档位精简、防幻觉约束、中文会话标题、品牌展示与推荐配置体系。
