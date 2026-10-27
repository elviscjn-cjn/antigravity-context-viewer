# 🚀 Antigravity Context & Token Viewer v2.7.2 更新日志

本次发布紧急修复并彻底解决了**“Token 看板总使用量锁死为 670.0M / 20.06M 假数据、数值不随真实会话变动”**的核心缺陷，并实装了跨机器 100% 纯净日志扫描与全量动态联动。

---

## ⚡ 核心修复与改进 (Bug Fixes & Improvements)

### 1. 彻底剔除前端硬编码历史数据（解决 670.0M 死值根因）
- **根因分析**：旧版本在 `meter-renderer.js` 第 14 行预埋了开发测试主机的历史基准表（`ANTIGRAVITY_TOKEN_DATA`，包含 `669,964,744` 总用量与 `20,057,882` 今日用量）。而在前端数据合并时执行了 `rec.total >= cur.total` 判断，导致新设备或真实用量较小（如 17.99M / 5.57M）的机器永远无法战胜写死的 670M，数字被永久锁死。
- **重构方案**：
  - 前端基准表改为完全纯净的零基初始状态（`dailyMap: {}`）；
  - `applyTokenHistoryPayload` 彻底改为直接以本机实际扫描到的 `transcript.jsonl` 日志实测数据为准；
  - 模板中的占位文本统一由写死数字清理为动态加载状态。

### 2. 支持小数值宽动态范围格式化 (K / M / B 自适应)
- **宽量程自适应**：
  - `≥ 1,000,000,000`：以 `1.23B` 呈现；
  - `≥ 1,000,000`：以 `17.9M` / `846.8M` 呈现；
  - `≥ 1,000`：以 `50.0K` / `85.2K` 呈现（避免小于 1M 时被粗暴四舍五入为 `0.0M`）；
  - `< 1,000`：以精确整数呈现。

### 3. 实装 15 秒静默轮询与会话切换热联动 (Real-time Live Sync)
- 前端 `tick()` 循环新增 15 秒静默轮询与切换会话立即强制重算机制；
- 每次对话完成并生成新日志后，Token 计数胶囊与详情面板将在 15 秒内自动更新，无需手动重启或刷新窗口。

### 4. 彻底解决 Windows 下批处理文件字节偏移错位闪退
- `install.bat` 与 `uninstall.bat` 启动器已全面重构为 **100% 纯 7-bit ASCII 字符**，彻底杜绝 Windows CMD（代码页 936）在解析 UTF-8 多字节中文时因 `fseek` 字节漂移把命令拆成 `'f'`、`'ot'`、`'N_RUN_AS_NODE'`、`'cho.'` 的致命语法崩溃；
- 中文交互界面统一由 Node.js 运行时（V8 原生 Unicode）渲染呈现。

---

## 📦 跨平台 Release 安装包

所有安装包均已自动化编译并打包于 GitHub Release 资产中：
- Windows: `antigravity-context-viewer_2.7.2_windows_amd64.zip` / `_arm64.zip`
- macOS: `antigravity-context-viewer_2.7.2_darwin_amd64.zip` / `_arm64.zip`
- Linux: `antigravity-context-viewer_2.7.2_linux_amd64.zip` / `_arm64.zip`
- SHA256 校验和: `checksums.txt`
