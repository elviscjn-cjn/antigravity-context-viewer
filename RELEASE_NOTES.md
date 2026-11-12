### 🌟 Antigravity Context & Token Viewer v0.8.2

- 修复在线更新完成后仍重复提示有新版本的问题，完善已安装版本与运行版本的状态显示.
- 修复汉化已生效时，首次打开面板仍显示待重启的问题.
- 本版不包含其他功能扩展.

---

### 🌟 Antigravity Context & Token Viewer v0.8.1

- 修复 Windows 顶栏右上角最小化/最大化/关闭按钮被插件栏遮挡问题（PR #5，致谢 @x1051445024）。
- 适配 Antigravity 2.x BaseWindow 架构，修复窗口关闭/托盘唤醒后无法自动注入问题（PR #6，致谢 @x1051445024）。
- 优化托盘常驻原会话保留与退出保护，后台常驻时最小化保留原界面与上下文（ELV-25）。
- 新增实验性 983K 上下文扩展补丁引擎（仅限 Windows x86-64 架构验证与安全回滚）。
- 新增交互式 CLI 终端启动器配套 Windows 原生窗口居中置顶辅助工具（cli-window-helper）。
- 优化网络免 TUN 代理与连接错误判定，修正超时与网关中断时的错误分类。

---

#### 🛠️ 详细更新说明

1. **Windows 顶栏控制按钮避让（PR #5）**
   - 兼容 Antigravity 2.x 顶部右上角容器类名（`.tabs-and-actions-container`），动态注入 WCO 弹性占位容器与有效安全避让边距。
   - 彻底解决 Windows 原生及自定义标题栏下最小化、最大化和关闭三键被插件浮层遮挡的交互问题。
   - 特别感谢社区贡献者 **@x1051445024** 提交的 [PR #5](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/5)！

2. **BaseWindow 架构生命周期自愈与注入加固（PR #6 & ELV-15）**
   - 深入适配 Antigravity 2.x 全新 `BaseWindow` / `WebContentsView` 架构，消除窗口关闭重建后插件失效的现象。
   - 针对冷启动与托盘重新唤起场景，增加 WeakMap 句柄防泄漏与周期性探测；严格过滤 `data:text/html` 纯色遮罩层（`curtainView`），优先匹配挂载本机主聊天视图。
   - 特别感谢社区贡献者 **@x1051445024** 提交的 [PR #6](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/6)！

3. **托盘常驻原会话界面保持（ELV-25）**
   - 优化窗口关闭拦截机制（`shouldInterceptWindowClose`）：当宿主开启后台常驻模式时，关闭主窗口默认隐藏至托盘，保留用户当前聊天的会话上下文与滚动位置；
   - 监听 `before-quit` 与 `will-quit` 生命周期事件，在宿主真正退出时放行销毁，杜绝僵尸进程。

4. **983K 上下文请求预算补丁（实验性能力）**
   - 针对 Windows x86-64 平台的官方 `language_server_windows_x64.exe` 提供 983,040 (960KB) 上下文请求预算支持；
   - 提供状态自检、幂等应用与 SHA-256 防篡改原子回滚；macOS / Linux 受系统代码签名与动态安全机制限制，当前版本自动拦截写入以保障稳定性。
   - *注意：实际生效上下文上限取决于服务端模型后端最终接受与分配的预算配额。*

5. **CLI 启动器与原生居中置顶辅助**
   - 优化一键唤起交互式 CLI 终端流程，Windows 端内置原生辅助工具（`cli-window-helper.exe`），消除启动阻塞并居中置顶显示；其他平台支持标准 POSIX Shell 调用。

6. **免 TUN 代理与网络层错误判定**
   - 完善统一代理检测与自愈回退逻辑；
   - 精准区分网络层瞬态错误（如 Go context deadline exceeded、网关 EOF）与真实上下文超限，避免错误上报。

---

#### 📦 资产校验与平台说明

- **windows_amd64**：实机测试通过，包含原生窗口辅助与上下文补丁支持。
- **windows_arm64**：提供标准安装包，基础功能同 amd64，上下文补丁与原生辅助未在 ARM64 硬件实机验证。
- **darwin / linux (amd64 / arm64)**：提供标准脚本安装包，支持核心监控与用量统计；上下文补丁因代码签名策略暂未开放写入。
