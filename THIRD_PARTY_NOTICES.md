# 第三方开源许可与致谢声明 (Third-Party Notices)

## 1. Antigravity-Chinese-Localization（Antigravity 客户端界面汉化）

Antigravity 界面汉化基于 Antigravity-Chinese-Localization，感谢 aabbWei 与 antigravity-cn-community 贡献者。

- **上游仓库**：<https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization>
- **采用版本**：Release `v2.34.0`（2026-11-21 发布；以下登记采用组件及 SHA-256 哈希）
- **采用组件与 SHA-256**：
  - `toolkit/src/dictionary.js`（4,444 条界面词典与 122 条核心词表 `coreWords`，SHA-256：`076829a201ccfd6c59217e6a2ba2fd60ef59350337212d3f1ece8f9ecfa038a0`）
  - `toolkit/src/dom-translator.js`（DOM 物理隔离规则 `shouldSkipNode`、Issue #68 权限审批动态规则、Orchestrator / `Extra High` 修复、Side Question、分屏与 `v2.34.0` 动态正则，SHA-256：`85baa2f5f879d1e602080cfa29bfe1415cbd76183976a0ff8acd7bced86c9f86`）
  - `toolkit/LICENSE`（SHA-256：`e4fc6effec01f02f85f758ee2adb89e6a34e660e09d83a30f76371e76b788c39`）

### 完整 MIT 许可证原文

```text
MIT License

Copyright (c) 2026 aabbWei
Copyright (c) 2026 antigravity-cn-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 上游协议参考与授权声明

1. **vscode-antigravity-cockpit**
   - 仓库：<https://github.com/jlcodes99/vscode-antigravity-cockpit>
   - 作者：`jlcodes99` · 核对提交：`14d40df3771d399a0596221351852bcc721b423a`
   - 许可证：`MIT License`
   - 用途：`meter-accounts.js` 中 Google OAuth2 回环授权与 CloudCode 配额接口协议对齐参考

---

## 3. 技术方案参考、外部费率目录与社区致谢

1. **Linux.do @23375**
   - 用途：`meter-context-unlock.js` 中对客户端二进制上下文长度调整的技术分析思路参考
   - 说明：代码与跨平台二进制解析逻辑为本仓库独立实现

2. **AGY Post-Compact Rehydration**
   - 用途：`rehydrate/rehydrate_after_compact.py` 压缩后摘要恢复与会话续接适配参考
   - 说明：经本项目自主重整以适配 Antigravity 会话目录与编码约束

3. **models.dev & LiteLLM**
   - 仓库：<https://github.com/sst/models.dev> / <https://github.com/BerriAI/litellm>
   - 许可证：`MIT License`（LiteLLM 价格数据目录）
   - 用途：本地采集器动态补充模型费率清单的数据来源参考（优先使用本仓库内置核实官方定价表与用户自定义覆盖）

4. **Antigravity 彩色图标**
   - 来源：用户提供的 Google-Antigravity-Icon-Full-Color.svg。分发许可尚未核实。

---

## 4. 本轮与近期 PR / Issue 社区贡献采用明细

| PR / Issue | 作者 / 提出者 | 参考提交 (HEAD) | 本仓库采用范围 |
| :--- | :--- | :--- | :--- |
| PR #27 | `paojiaoleshenghuo` | `4f435ee3` | 命名空间精确权限与可用性分组逻辑（已进入并回归） |
| PR #32 | `Tswatery` | `ca562e1f` | 跨平台环境变量、`local-api.js` 安全加固与报错脱敏（已进入并回归） |
| PR #35 | `JYPYYy` | `79fe46f3` | `agy` CLI 上下文解锁与二进制探测兼容（已进入并回归） |
| PR #36 | `JYPYYy` | `977410674077284e27c5ac5c972eb04f5d34c4a1` | WebP (`VP8`/`VP8L`/`VP8X`)、内联图片缓存与 JSONL 按字节增量扫描 |
| PR #43 | `Nymph-Beta` | `a759299aa298dacfa3c1b18a6ea40ebbfc2148ef` | `live`/`watch` 自动启动、CDP 复用、宿主外重开与端口选择 |
| PR #60 | 社区反馈 / 内建 | — | 升级账本备份自动清理与高频同步复制节流 |
| PR #64 | 社区反馈 / 内建 | — | 1x 额度防双计与调用归属对齐 |
| PR #68 | `Xuhang0607` | — | 运行时权限审批动态翻译规则 |
| PR #69 | `Jemiking` | — | Antigravity 2.34.0 `loadHubWindowUrl` 兼容基础 |
| PR #70 / PR #79 | `Staaaying` | `3636fab601d2c151801a669e40ff67aec7560f17` | Shadow DOM 事件隔离防止右侧分屏焦点跳回左窗格及适配 |
| PR #72 | `feizaodemon` | `944ada57` | 免 TUN 本地代理独立启动器 `proxy:launch` / `proxy:launcher` |
| PR #73 | `awu5425` | — | 统计与兼容性细节反馈与贡献 |
| PR #74 | `Staaaying` | `846c0edf2e33b3664bb3545e1a2bada00a1da72e` | 带前缀模型选择器识别、Orchestrator/Neon 映射及未知模型清理 |
| Issue #75 / PR #76 | `XiangZheng2283` | `86f1176f72ad31bba76e0f19160176fb13813d15` | Windows 显式 `System32\tar.exe` 解压、PowerShell 回退与防半解压污染 |
| Issue #77 | `BetterThanAny` | — | 当天删会话账本守恒、遗留差额冻结与 `cascadeId#stepIndex` 回退重发防撞 |
| Issue #78 | `jinyue806` | — | Windows WMI `Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 }` 消除黑框 |
| Issue #80 | `Jeffgithub0029` | — | 2.34.0 加载锚点验证与 macOS `ElectronAsarIntegrity` / 签名预检 |
