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

4. **实时请求来源图标**
   - Antigravity 原版彩色 SVG 由维护者提供，用于实时请求列表标识来源。Antigravity 标识归其权利人所有。

---

## 4. 本轮与近期 PR / Issue 社区贡献采用明细（按 GitHub 账号去重）

| GitHub 账号 | 关联 PR / Issue | 参考提交 (HEAD) | 本仓库采用范围与代码归属 |
| :--- | :--- | :--- | :--- |
| `@Tswatery` | [PR #38](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/38), [PR #53](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/53), [PR #32](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/32) | `5f5c08ee`, `6cbcf013`, `ca562e1f` | 原提交已合入发布分支：取消归类中性中断（#38）、浅色热力图颜色与图例方向修正（#53）；跨平台环境变量与 `local-api.js` 安全加固方案（#32） |
| `@Kisaragi-Mio-0127` | [PR #47](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/47), [PR #45](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/45), [Issue #46](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/46), [Issue #44](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/44) | `476d558b` | 原提交已合入发布分支：推荐配置复选框按磁盘实际开/关状态同步显示（#47） |
| `@feizaodemon` | [PR #52](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/52), [PR #72](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/72) | `1dfeabcf`, `944ada57` | 原提交已合入发布分支：Gemini 4 Neon 识别与 Antigravity 2.33 统一配额池匹配（#52）；免 TUN 独立代理启动器 `proxy:launch` / `proxy:launcher`（#72） |
| `@yuanyang749` | [PR #57](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/57) | `f730f6d5` | 原提交已合入发布分支：过滤内置浏览器第三方本地预览页并强化多 origin 容错连接（#57） |
| `@riandycandra` | [Issue #17](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/17) | — | 采纳方案：`cli-window-helper` 溯源透明化、Git 零预编译二进制、CI/本地源码编译 SHA-256 校验与无助手控制台降级（#17） |
| `@JYPYYy` | [PR #35](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/35), [PR #36](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/36), [PR #37](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/37) | `79fe46f3`, `97741067`, `ba71f1ed` | 采纳方案：`agy` CLI 128K 解锁与 `~/.gemini/bin` 探测（#35）、WebP 尺寸/内联图片缓存/JSONL 增量扫描（#36）、缓存命中率/纯流式速度/墙钟耗时遥测（#37） |
| `@Nymph-Beta` | [Issue #42](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/42), [PR #43](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/43), [PR #48](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/48), [PR #71](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/71) | `a759299a`, `f6885970`, `2f823f97` | 采纳方案：无 CDP 时 `live`/`watch` 端口发现与挂载引导（#42/#43）、`/compact` 压缩态反馈与容量同步回落（#48）、Split 分屏与 Side Chat 支线切换（#71） |
| `@Staaaying` | [PR #70](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/70), [PR #74](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/74), [PR #79](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/79) | `32241960`, `846c0edf`, `3636fab6` | 采纳方案：分屏聚焦会话上下文/速度显示（#70）、带前缀模型标签及 Orchestrator/Neon 映射与未知清理（#74）、Shadow DOM 防分屏失焦隔离（#79） |
| `@paojiaoleshenghuo` | [PR #27](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/27) | `4f435ee3` | 采纳方案：命名空间精确权限与可用性分组逻辑（#27） |
| `@MoiraToki` | [PR #34](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/34) | `2b257bc8` | 采纳方案：压缩后上下文可选摘要恢复架构与自研 `meter-rehydrate.js`（#34） |
| `@Fengsuid` | [PR #55](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/55) | `d00a09b3` | 采纳方案：实时请求明细表与多源动态费率目录同步（#55） |
| `@1-pluto1` | [PR #60](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/60) | `ed849e5c` | 采纳方案：账本幂等备份去重与过期副本轮转清理（#60） |
| `@lllhhhh` | [PR #63](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/63) | `a7af9397` | 采纳方案：会话平均生成速率指标与双入口展示（#63） |
| `@unie774` | [PR #64](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/64) | `b785a5a2` | 采纳方案：5h/周限额防双倍重复计数、占位模型归池与校准自愈（#64） |
| `@XiangZheng2283` | [Issue #75](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/75), [PR #76](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/76) | `86f1176f` | 采纳方案：Windows 显式 `System32\tar.exe` 解压、PowerShell 回退与防半解压污染（#75/#76） |
| `@BetterThanAny` | [Issue #77](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/77) | — | 问题定位与方案：当天删会话账本守恒与回退重发防撞（#77） |
| `@jinyue806` | [Issue #78](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/78) | — | 问题定位与方案：Windows WMI `Win32_ProcessStartup` 隐藏启动黑框（#78） |
| `@Jeffgithub0029` | [Issue #80](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/80) | — | 兼容性分析：Antigravity 2.34.0 加载锚点与 macOS `ElectronAsarIntegrity` / 签名预检（#80） |
| `@x1051445024` | [PR #61](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/61), [Issue #50](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/50) | `a90c9e57` | 2.34.0 窗口加载锚点与空 HTML `csrfToken` 鉴权方案（#61），归属备份堆积问题定位（#50） |
| `@Hirasawa8` | [PR #66](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/66) | `8af3af49` | Antigravity 2.34.0 安装恢复与桌面额度兼容方案（#66） |
| `@shixin08052` | [PR #67](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/67) | `4911494c` | Antigravity 2.34.0 窗口加载与 Hub 同源会话适配方案（#67） |
| `@Xuhang0607` | [PR #68](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/68) | `2b43ca57` | Antigravity 2.34.0 桌面额度本地鉴权失败修复与精确同源主进程令牌方案（#68） |
| `@Jemiking` | [PR #69](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/69) | `9b5fc6f4` | Antigravity 2.34.0 窗口加载与 bootstrap CSRF 兼容方案（#69） |
| `@awu5425` | [PR #73](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/73) | `54704311` | 安装器对 Antigravity 2.34.0 `loadHubWindowUrl` 锚点适配方案（#73） |
| `@LC9999216` | [PR #65](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/65) | `58b3235c` | 独立提交同题 2.34.0 窗口加载与 bootstrap CSRF 兼容方案（与上述已采纳方案重叠，#65） |
