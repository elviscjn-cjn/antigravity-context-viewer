# 模型配额模块修复与 20 格原生充能重构提示词

> **目标工作区**：`D:\AI_plugin\AntigravityContextMeter`  
> **执行环境**：Windows（PowerShell），所有 npm 操作必须使用 `npm.cmd`（严禁执行 `npm.ps1`）。  
> **核心规范**：
> 1. 渲染层只修改 `src/renderer/` 下源码，严禁手改 `meter-renderer.js`，修改后执行 `npm.cmd run build:renderer` 重新打包；
> 2. 新增与修改的三语可见文案**严格遵守零中英文括号规范**；
> 3. 保证全套测试 100% 绿灯通过（`npm.cmd test`）。

---

## 一、代码级根因诊断表（已对齐本地真实路径与代码行号）

| 序号 | 痛点现象 | 本地实际代码路径与行号 | 核心技术根因与机理 |
| :--- | :--- | :--- | :--- |
| 1 | **刷新键点完纹丝不动，必须手动点官方 UI 查看可用额度才更新** | `meter-collector.js:4893`、`4906`、`4937-4938`<br>`src/renderer/main.js:27258-27266` | ① `meter-collector.js:4937-4938` 向 Language Server 发送的 RPC 载荷为空对象 `api.call('RetrieveUserQuotaSummary', {})`，导致宿主服务直接返回本地旧内存快照；<br>② `meter-collector.js:4893` 存在 15 秒短缓存硬拦截 `(nowMs - prevCachedQuota.fetchedAtMs < 15000)`；<br>③ `src/renderer/main.js:27258` 的 `quotaInFlightPromise` 会直接复用已在途的旧请求，点击并未真正下发新 RPC。 |
| 2 | **百分比差 1%（98% vs 99%）且重置倒计时差整整 2 小时** | `meter-core.js:283-313`<br>`meter-collector.js:5058` | 并非算法或时区误差，而是刷新未穿透导致插件持续展示 2 小时前的陈旧缓存（当时剩余 99%、倒计时 4h27m）；两小时后官方底层实际已消耗至 98% 且倒计时剩 2h30m，用户点官方 UI 触发底层拉取后插件才被动刷出正确数据。 |
| 3 | **首次打开显示 `Google AI Pro`、刷新抢跑显示「已刷新」1.3 秒后跳变 `Ultra`** | `src/renderer/main.js:6097`、`26731`、`27391` | ① `main.js:6097` 硬编码了 `ps.tierName || 'Google AI Pro'` 占位，导致冷启动在 `GetUserStatus` 返回前先闪现 Pro；<br>② `showQuotaUpToDateFeedback()` 未等待 `GetUserStatus` 与 `RetrieveUserQuotaSummary` 两个 Promise 全部 Resolve 并在内存落盘，就提前向 UI 将按钮置为「已刷新」。 |
| 4 | **顶部额度查看入口被误删（反人类交互）** | `src/renderer/main.js:8714` | `#badge-quota` 的点击事件被单一只绑定给 `cycleQuotaBadgeWindowMode()`，剥夺了普通点击打开 `#panel-quota` 面板的能力，关上面板后无法抬手重新打开。 |
| 5 | **20 格进度条充能被纯色绿条盖住格间距，生硬突兀** | `src/renderer/styles.css`<br>`src/renderer/main.js:26933` | `.quota-bar-charge-fill` 和 `.quota-bar-charge-sheen` 是整块覆盖在 20 格栅格上的实体线性渐变条，把 1px 格子缝隙完全抹平；刷新时直接瞬跳或盖一层假动画，缺乏原生格子的预缓冲与递进充能感。 |
| 6 | **模型列表中新模型标签显示为「新建」而非「NEW」** | `meter-core.js:316`<br>`src/renderer/main.js:26856-26863` | 宿主或汉化词典回传的 `tagTitle` 为「新建」，在 `renderQuotaModelChips` 中未被规范化为「NEW」；且 `meter-core.js:316` 的装饰标签正则漏掉了「新建」，可能干扰故障判定。 |

---

## 二、详细重构与实施任务

### 任务 1：彻底重构 20 格进度条原生充能动效（拒绝贴皮动画，实现原生格子两阶段律动）

#### 核心诉求：
1. **绝对不准直接归零**：点击刷新时，已有点亮的格子不能瞬间清空或暴跌归零，防止界面出现断崖式闪烁；
2. **彻底删除盖在上面的虚假动画层**：移除 `.quota-bar-charge-fill` 与 `.quota-bar-charge-sheen` 等浮在格子上方盖住 1px 间距的纯色遮罩层，让动画直接发生在 20 个 `.quota-cell` 原生 DOM 节点本身；
3. **两阶段原生格子动效状态机**：
   - **Phase 1（预缓冲加载态 `data-refresh-phase="buffering"`）**：
     - 点击刷新后，刷新按钮细线图标保持匀速旋转，**绝对禁止提前跳出「已刷新」字样**；
     - 当前已点亮的 20 格保持原有电量显示，每个亮起的 cell 自身触发原生「能量脉冲循环」（例如通过 CSS 关键帧 `agCellPulse`：沿着已有点亮的格子自左向右掠过一道电流般的微光波，每个格子自身透明度微动，但 **每个 cell 之间的 1px 物理缝隙始终清晰锐利**，绝不被任何色块盖住）；
   - **Phase 2（数据到达后的逐格充能态 `data-refresh-phase="charging"`）**：
     - 真实最新配额数据返回后，预缓冲波平滑收尾；
     - 如果新额度与旧额度存在差异：
       - **若额度发生消耗（减少）**：被消耗掉的格子从右往左以微弱暗红/橙光瞬间消退（200ms），提供真实的消耗反馈；
       - **若额度充足或恢复**：从第 0 格开始，按目标剩余格数 `N`，通过每个 cell 的 `--cell-idx` 变量以 `clamp(Math.round(380 / N), 20, 38)` ms 的步进延迟，**一格一格从左向右依次点亮填满**；
       - 每一格点亮瞬间带有微小的弹簧回弹与高亮锁定反馈（如 `transform: scaleY(1.12)` 瞬回 `1.0`）；
     - 百分比数字与重置倒计时随着逐格点亮同步顺滑滚入最新数值；
     - 最后一格充能完成并锁定时，刷新按钮才切换为「✓ 已刷新」并保持 900ms，随后平滑归位至 idle；
     - 降级保护：在额度为 0%、后台静默轮询、或系统开启 `prefers-reduced-motion` 时，跳过动画直接静态更新。

#### 涉及文件：
- `D:\AI_plugin\AntigravityContextMeter\src\renderer\styles.css`：
  - 隐藏或清理全宽浮层 `.quota-bar-charge-fill` 和 `.quota-bar-charge-sheen`；
  - 为 `.quota-cell` 增加 `[data-refresh-phase="buffering"]` 的原生逐格波浪光效与 `[data-refresh-phase="charging"]` 的逐格按序填充关键帧。
- `D:\AI_plugin\AntigravityContextMeter\src\renderer\main.js`：
  - 在 `renderQuotaBucketsContainer` 及充能调度器中维护 `buffering` -> `charging` -> `settled` 三态转换，根据新老快照格数差值计算延迟与步进。

---

### 任务 2：根治底层额度刷新“点完没反应，必须点官方 UI 才有数据”

1. **修改 `D:\AI_plugin\AntigravityContextMeter\meter-collector.js`（`fetchQuotaSnapshotFromHost`）**：
   - 检查 `options.force === true`：
     - 立即清除内存作用域缓存：`cachedQuotaStateByOrigin.delete(originScope)`，彻底绕过 15 秒短缓存；
     - 遇到后台在途的非强制 Promise 不得直接复用，必须触发真实的穿透拉取；
     - 向宿主 Language Server 发送强制刷新 RPC 载荷（约 4936 行）：
       ```javascript
       const reqPayload = force ? { force: true, forceRefresh: true, force_refresh: true, refresh: true } : {};
       const [uRes, qRes] = await Promise.allSettled([
         api.call('GetUserStatus', reqPayload),
         api.call('RetrieveUserQuotaSummary', reqPayload)
       ]);
       ```
     - 确保 `GetUserStatus` 与 `RetrieveUserQuotaSummary` 两者的数据全部成功返回并完成快照构建后，才 resolve 结果。

2. **修改 `D:\AI_plugin\AntigravityContextMeter\src\renderer\main.js`（`syncQuotaFromHost`）**：
   - 手动触发入口一律传入 `{ force: true, manual: true }`；
   - 彻底消除 `Google AI Pro` 占位跳变：检查 6097 行及 26731 行，套餐状态未识别时绝不硬编码展示 `Google AI Pro`，必须继承已知账号套餐或保持骨架态，消除延迟 1.3 秒跳变 Ultra 的问题；
   - 必须等完整响应落盘后才解除按钮 loading 态。

---

### 任务 3：恢复顶部额度查看入口（消除反人类交互）

1. **修改 `D:\AI_plugin\AntigravityContextMeter\src\renderer\main.js`（约 8714 行 `#badge-quota` 监听）**：
   - 点击 `#badge-quota` 上的 SVG 圆环图标 `#quota-ring-svg` 或双击徽章：直接执行 `toggleQuota('badge-quota')`，一键打开/折叠 `#panel-quota` 面板，恢复抬手直达；
   - 单击 `#badge-quota` 文本区域：0ms 立即轮换显示周期（5h / 7d / 双显），同时触发后台防抖合并的真实强制额度刷新：
     `void syncQuotaFromHost(true, { manual: true, badgeTrigger: true });`
   - 连续快速点击时合并在途请求（Request Coalescing），返回后原子同步更新顶栏、底栏及面板各处；
   - 确保顶栏悬停菜单 `#overflow-menu` 内的「模型额度」项（`#overflow-quota-btn`）零闪烁平滑直达 `#panel-quota`。

---

### 任务 4：模型列表中新模型标签将「新建」改为「NEW」

1. **修改 `D:\AI_plugin\AntigravityContextMeter\meter-core.js`（第 316 行）**：
   - 在 `DECORATIVE_BADGE_TAG_RE` 正则中添加 `新建`，避免「新建」角标被当作模型不可用的错误原因。
2. **修改 `D:\AI_plugin\AntigravityContextMeter\src\renderer\main.js`（约 26856 行 `renderQuotaModelChips`）**：
   - 渲染 `quota-chip-notice` 标签时，若文案为 `新建` 或 `New`，统一规范化输出为 `NEW`（严格零中英文括号），保留蓝色胶囊样式。

---

## 三、本地验证与流水线验收

在 `D:\AI_plugin\AntigravityContextMeter` 根目录下依次执行：

```powershell
# 1. 重新打包渲染层
npm.cmd run build:renderer

# 2. 跑通额度模块单测（34 项必须全部通过）
node --test meter-quota.test.js

# 3. 跑通全量单测套件（616 项必须全部通过）
npm.cmd test

# 4. 安装到本地宿主客户端
node cli.js install
node cli.js status
```
