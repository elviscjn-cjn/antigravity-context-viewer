# AntigravityContextMeter 待办台账 (TASK_LEDGER)

- 快照时间. 2026-11-22 08:12 (Asia/Shanghai).
- 仓库. `D:\AI_plugin\AntigravityContextMeter` | 分支 `feat/v0.8.9-beta` | 基线 HEAD `044cdc2`.
- 版本. `0.9.0-beta.1` | renderer `buildId 7fb303e49dcc` | 工作树 59 项未提交.
- 未提交补充. `meter-rehydrate.js` / `meter-rehydrate.test.js` 已进索引但**不在 HEAD 树**; `meter-elv98-99.test.js` / `meter-v234-compat.test.js` 仍为未跟踪文件.
- 本轮范围. 只更新本台账. 不改代码, 不写 GitHub / Linear, 不动远端.

---

## 1. Linear 总账

### 1.1 编号统计（去重前）

| 分类 | 数量 | 说明 |
|---|---:|---|
| 活跃 | **44** | In Review 9 + Backlog 35 |
| 归档 Backlog | **10** | ELV-5 ~ ELV-14, 全部 Backlog 状态, 归档于 2026-11-12T11:21Z |
| 已收口 | 51 | Done 27 / Duplicate 16 / Canceled 8 |
| 编号合计 | **105** | 95 可见 + 10 归档 |

### 1.2 去重后唯一事项 = 75

`44 活跃 + 27 Done + 4 取消示例` = 75. 取消示例 ELV-1~4 与 ELV-37~40 同义, 按 4 条计.

Duplicate 16 条 → 主单

- ELV-15 → ELV-29
- ELV-16 → ELV-27
- ELV-17 / ELV-18 / ELV-23 / ELV-30 / ELV-35 / ELV-36 → ELV-41
- ELV-19 / ELV-21 / ELV-32 → ELV-34
- ELV-20 / ELV-42 → ELV-58 / ELV-59
- ELV-22 → ELV-31
- ELV-26 → ELV-24
- ELV-28 → ELV-25

归档 10 条（英文原单）→ 中文主单

- ELV-5 → ELV-29
- ELV-6 → ELV-27
- ELV-7 → ELV-48（更新弹窗被遮挡, 归属待核）
- ELV-8 / ELV-9 / ELV-10 → ELV-41
- ELV-11 → ELV-34
- ELV-12 → ELV-58 / ELV-59
- ELV-13 → ELV-53
- ELV-14 → ELV-31

### 1.3 活跃 44 条逐条

#### In Review 9 条

| 编号 | 事项 | 状态 | 本地证据 | 剩余动作 |
|---|---|---|---|---|
| ELV-88 | WSL 用量采集整合 PR #26 | 已实现待验收 | PR #26 已 merge 进 HEAD | 实机补验收 |
| ELV-86 | 免重启热加载链路与更新超时诊断 (v0.8.7) | 已实现待验收 | v0.8.7 链路已在 HEAD | 实机验收 |
| ELV-84 | Windows 外接屏混合 DPI 字体发虚 | 已实现待验收 | `meter-renderer.test.js`「ELV-84: …混合 DPI 坐标对齐像素网格」 | 外接屏实机截图 |
| ELV-81 | Mac 上下文设置失效/反复重设 | 已实现待验收 | `meter-model-context-isolation.test.js`「ELV-81 回归」 | Mac 实机 |
| ELV-72 | CDP 无 Origin 握手与多端口发现 | 已实现待验收 | `local-api.js` 多 origin 候选 + daemon hub 回退 | 实机验收 |
| ELV-71 | 跨平台路径 Mac 配置目录与 CLI 启动 | 已实现待验收 | runtime-check / macos 适配分支 | Mac 实机 |
| ELV-70 | Mac 配置应用无法保存/推荐配置 | **部分** | 无 ELV-70 专属实现标记, 对应 GitHub #23 未通过 | 先定位, 不建议标 Done |
| ELV-55 | 子代理用量与父子归属 | 已实现待验收 | `collectVerifiedSubagentCallsForSessionSync` 三端复用 | 验收 |
| ELV-49 | Mac 免改盘挂载 watch 守护 | 已实现待验收 | `meter-macos-watch.test.js` | Mac 实机 |

#### Backlog 35 条

| 编号 | 事项 | 状态 | 本地证据 | 剩余动作 |
|---|---|---|---|---|
| ELV-105 | 官方更新后自动检测并恢复插件 | 未实现 | 无对应代码 | 待排期 |
| ELV-104 | 防幻觉提示词对 Prompt Cache 命中率影响（调查） | 未实现 | 无实验数据 | 待排期 |
| ELV-103 | 混合模型会话按模型分别计量 | **已实现** | 三端对账 962 次 / 213,443,649 tok, `exactDupGroups=0`; `meter-elv103-mixed-session.test.js` | 改 Done |
| ELV-102 | 多账号 OAuth 超时且不弹浏览器 | **部分** | 有 `openExternal` + `timeoutMs 120000` + `prompt=select_account`, 超时根因未根治 | 复现后修 |
| ELV-101 | 归属纠偏备份无限生成 (=GitHub #50) | **已实现** | `#50` commit `49563ae`, 测试「PR #60 回归」相关 | 改 Done |
| ELV-100 | 同一会话自动压缩上下文并持续工作 | **部分** | rehydrate 覆盖「压缩后回填继续」, 「自动触发压缩」未做 | 拆分需求 |
| ELV-99 | 当前视图状态存成默认 | **已实现** | `DEFAULT_VIEW_PREFS` 9 字段 + 冷重启 9 项全恢复（HANDOFF §6.5） | 改 Done |
| ELV-98 | 逐步趋势图可切总量与增量 | **已实现** | `buildContextTrendSeries` + 实机柱条与明细逐字一致（HANDOFF §6.4） | 改 Done |
| ELV-97 | 明细设上限, 超量丢后台算 | **部分实现** | 请求日志已有分页（首屏 50 条 / 共 60 条可加载更多）; 后台分批计算未做 | 保留 Backlog, 注明已完成分页 |
| ELV-96 | 每个数字标明可信度 | **部分** | 额度侧 `estBasis` / `basisNote` / 过期与样本不足声明; 未全局化到所有数字 | 收敛为验收项 |
| ELV-95 | 上下文突然变少时告诉原因 | **已实现** | `detectContextChangeEvents` 五类事件 + `meter-core.test.js`「ELV-95」 | 改 Done |
| ELV-94 | 面板显示位置做成可选项 | **已实现** | 五态 `flow/fixed/aux/page/hide` + aux 实机验收（HANDOFF §6.3） | 改 Done（并入 ELV-73 条件） |
| ELV-93 | 顶栏等待改沙漏动效 | **已实现** | `ELV-93` 纯 SVG 沙漏 + 测试 | 改 Done |
| ELV-92 | 云端项目会话显示 `--%` 且一直等待 | **部分** | 远程/云端无本地轨迹时已给明确说明（Issue #56 分支）; `--%` 场景未逐验 | 补实机 |
| ELV-90 | 按会话统计累计 Token | **已实现** | `sessionTokenTotals` / `modelBreakdown` 会话聚合 | 改 Done |
| ELV-89 | 按账号统计 + 阈值自动切号 | **已实现** | `meter-accounts.js` autoSwitch + keepalive, 测试「ELV-89」多组 | 改 Done |
| ELV-85 | 仅查看模式（不改客户端） | **部分** | CLI 侧严格零写 `readOnly` 已落地; 客户端免改盘只读监控未做 | 保留 |
| ELV-82 | 一键安装受安全边界限制并改善提示 | 未实现 | 无对应实现 | 待排期 |
| ELV-79 | 录制新版功能 demo | 未实现 | 无新 demo | 待排期 |
| ELV-78 | 更新 Linux DO 原帖宣传 | 未实现 | 未更新 | 待排期 |
| ELV-77 | IDE 截图隐私遮罩与暂停刷新 | 未实现 | 无 IDE 实现 | 依赖 ELV-31 |
| ELV-76 | IDE 上下文容量/输出上限/压缩预算区分 | 未实现 | 无 IDE 实现 | 依赖 ELV-31 |
| ELV-75 | IDE 多窗口会话与工作区归属隔离 | 未实现 | 无 IDE 实现 | 依赖 ELV-31 |
| ELV-74 | IDE 上下文事件压缩/撤回提示 | 未实现 | 无 IDE 实现 | 依赖 ELV-31 |
| ELV-73 | 显示位置评估顶栏/侧栏切换 | **重复待关** | 主体已被 ELV-94 五态覆盖; 独有条件见 §4, 先移交再关 | 见 §4 |
| ELV-64 | 顶栏遮挡与窄窗口溢出 | **已实现** | `ELV-64` 标记 x2 + 商城避让测试 | 改 Done |
| ELV-59 | CLI 终端常驻显示上下文用量 | **已实现** | `meter-cli-monitor.js` / `meter-cli-ui.js`「ELV-59」 | 改 Done |
| ELV-58 | CLI 查询累计 Token | **已实现** | `node cli.js usage`, 测试「ELV-58」口径对账 | 改 Done |
| ELV-57 | 共享账号本机消耗与额度变化对照 | **已实现** | `quotaIntervals` 区间对账 + 面板对照表 + 测试「ELV-57」 | 改 Done |
| ELV-53 | 显示实际处理请求的模型 | **已实现** | `modelBreakdown` 按实际执行模型归属 | 改 Done |
| ELV-52 | 模型缓存保活与额度收益验证 | **已实现但默认禁用** | `meter-accounts.js` 第 2639 行「ELV-52 Prompt Cache 保活控制器（默认禁用 + 严格边界 + 未经维护者确认严禁发模型请求）」; 拦截提示第 2694 行 | 收益实验未验证, 保持 Backlog |
| ELV-51 | CLI helper 杀软检测与构建来源说明 | **部分** | `release.yml` 现场编译 + `.sha256`; README 两段说明; 二进制仍随包未签名 | 见 GitHub #17 |
| ELV-45 | 用量统计补齐 IDE 来源筛选 | 未实现 | 无 IDE 采集 | 依赖 ELV-31 |
| ELV-33 | CLI 安装启动检测并正确打开终端 | **已实现** | commit `62e751d`「ELV-33」+ 测试「ELV-33」 | 改 Done |
| ELV-31 | IDE 支持范围与可复用方案 | 未实现 | 仍在规划 | 待排期 |

**小计** 已实现 15 | 部分 8 | 未实现 11 | 重复待关 1（ELV-73）

- Backlog 35 = 15 + 8 + 11 + 1, 合计 35.
- 未实现 11. ELV-105 / 104 / 82（功能）, ELV-79 / 78（发布运营）, ELV-31 / 45 / 74 / 75 / 76 / 77（IDE 组）.
- 活跃 44 = In Review 9（8 已实现待验收 + 1 部分） + Backlog 35.

---

## 2. GitHub Issue 台账

### 2.1 open 15 条

| 编号 | 事项 | 状态 | 依据 |
|---|---|---|---|
| #17 | cli-window-helper 被杀软判毒, 要求透明化 | **部分** | CI 现场编译 + `.sha256` + README 两段说明 + 可删降级; 二进制未撤、未签名 |
| #23 | Mac 无法应用推荐配置 | **未解决** | 对应 ELV-70, 无专属实现证据 |
| #33 | 是否会被封号 | 非代码 | 无本地可改项 |
| #39 | Mac 上下文到量闪退 | **未解决** | 无对应修复 |
| #41 | 剩余额度可选 5h / weekly | 已解决 | commit `7f8deee`「#41 quota modes」四态 |
| #42 | macOS 2.33 live/watch 检测不到窗口 | 已解决 | commit `59aec30` |
| #46 | v0.8.8 推荐配置复选框静态全选 | 已解决 | commit `dfaac8b`（=PR #47） |
| #49 | Ultra 手动选 5x/20x 子档 | 已解决 | commit `075153f` |
| #50 | 备份无限堆积撑满磁盘 | 已解决 | commit `49563ae` |
| #51 | macOS 空账本锁阻塞 15 秒 | 已解决 | commit `b107df0` 异步锁 + 空锁宽限 |
| #54 | Win 2.33 窗口操作位置样式 | 已解决 | commit `f5fcb48`, 测试「Issue #54 & #59」 |
| #56 | remote 时耗时/速度显示异常 | **拆两条, 见 2.2** | — |
| #58 | 汉化后英文输出掺杂中文 | **部分** | i18n 隔离代码块/输入/工具输出 + Orchestrator 白名单; 个例未复验 |
| #59 | Customizations 界面被遮挡 | 已解决 | renderer 自动避让, 测试「Issue #59」 |
| #62 | 清洗后 utils.js 结构校验未通过 | 已解决 | `modular-installer` 锚点歧义拒绝 + `meter-v234-compat.test.js` |

### 2.2 #56 拆分

| 子项 | 状态 | 依据 |
|---|---|---|
| #56-a 无本地轨迹时不再报错, 改为明确"无法取得耗时与速度"提示 | **已修复** | `meter-core.js` 第 9647 行「远程/云端对话且本地无轨迹数据（Issue #56）」; `meter-elv91-speed.test.js`「远程/云端对话」断言 |
| #56-b 远程/云端会话的真实计量（耗时与输出速度可算） | **待实机** | 当前只做提示, 未实现远端计量; 需真实 remote 会话样本复验 |

### 2.3 closed 9 条

#1 #10 #15 #16 #19 #22 #24 #29 #44 — 已在各版本解决或关闭, 本轮不动.

---

## 3. PR 总账（open 28）

分类口径. **A** = 该 PR 分支 tip 已是 HEAD 祖先; **B** = 能力已落地但代码由本地重写并配测试; **C** = 同类修复由其他来源提供; **D** = 未采用.

### A. 原提交已进入 HEAD（5）

| PR | 作者 | 进入 HEAD 的提交 | 备注 |
|---|---|---|---|
| #38 | Tswatery | `5f5c08e` | 祖先校验通过 |
| #47 | Kisaragi_Mio | `476d558` | 祖先校验通过 |
| #52 | Xiaowei Rong | `1dfeabc` | 祖先校验通过 |
| #53 | Tswatery | `6cbcf01` | 祖先校验通过 |
| #57 | yuanyang | `f730f6d` + merge `0d80050` | 唯一真 merge commit |

### B. 采用部分实现或测试（15）

| PR | 本地落地形态 | 证据 |
|---|---|---|
| #27 | 自研权限矩阵 | `classifyModelQuotaAvailability` + Pro/Ultra/Free/企业版断言（ELV-83） |
| #32 | 自研多窗口保活 | 双窗口 csrf 场景 + local-api 失败回退 |
| #34 | clean-room 重写 | `meter-rehydrate.js` 已进索引（不在 HEAD 树）+ 76KB 测试 |
| #35 | 自研 128K Gate 3A | `ecx_edx_128k` clamp 变体 + `~/.gemini/bin/agy` 探测测试 |
| #37 | 自研遥测 | `cacheHitRate` 三端 + `summarizeTurnTiming` + 测试「PR #37」 |
| #43 | **部分** | 只生成带 `--remote-debugging-port` 的启动命令, 不自动结束客户端（`cli.js` 274-289） |
| #48 | 自研压缩状态机 | `beginCompactingTransition` 等 + `data-compacting` 动效 |
| #55 | 自研实时请求表 | 13 列表格 + `dynamicPricingCatalog` + 测试内注释「PR #55」 |
| #60 | 自研备份轮转 | commit `49563ae` + 测试「PR #60 回归」 |
| #63 | 自研均速 | `sessionAvgSpeed` + 测试「ELV-91 9 (PR #63)」 |
| #64 | 自研额度双计修复 | 测试「PR #64 回归: 5h/weekly 防双倍重复、占位模型归池、冷启动自愈」 |
| #70 | 自研分屏聚焦 | pane/sideChat 归集, 按聚焦路由取数 |
| #71 | 自研分屏与支线切换 | `parseConversationLayout` / `resolveEffectiveRoute` |
| #72 | 自研无 TUN 启动器 | `cli.js` `proxy:launch/proxy:launcher` + 参数测试 |
| #74 | 自研模型前缀归一 | `normalizeModelId` 保留 readable label + M537/M667/M668/M669/M681 映射 |

### C. 同类修复由其他来源提供（7）

同一问题（Antigravity 2.34.0 窗口加载锚点 + 空 HTML csrfToken 鉴权）有 7 份 PR, 本地由 v234-compat 自研实现统一覆盖, 未采用任何一份原提交:

#61 #65 #66 #67 #68 #69 #73

- 加载锚点. `modular-installer.js` `HUB_WINDOW_LOAD_RE` 兼容 `void/await/hub./（0, hub.）loadHubWindowUrl(win, url, {skipBootstrapMint})`, 锚点缺失或歧义直接拒绝写入.
- 鉴权. `local-api.js` 空 csrfToken 时走同进程 `authBootstrap`（仅接受精确活动 LS origin）→ 存活 `daemon/hub_*.json` → CDP 会话态; 渲染层回退 `agy_session_csrf_token`.
- 测试. `meter-v234-compat.test.js`（未跟踪文件）4 组.

### D. 未采用（1）

| PR | 结论 |
|---|---|
| #36 | collector WebP 尺寸解析 / 内联图片缓存 / JSONL 增量扫描 全库零命中, 未实现 |

---

## 4. ELV-73 独有验收条件移交

ELV-73 原描述（Linear 原文）要求评估 PR #14 的 `displayMode topbar/sidebar/both`, 并给出三条独有验收点. 本地 ELV-94 为 `flow/fixed/aux/page/hide` 五态, **不含 `both`**.

移交到 ELV-94 的验收条件

1. `topbar / sidebar / both` 三态语义评估结论（`both` 是否引入, 依据什么）.
2. 模式切换时**释放旧实例与监听**（防泄漏）.
3. **多窗口隔离**（两窗口各自停靠态互不影响）.
4. 证据要求. 模式切换 / 清理 / 持久化截图 + 测试 + 提交 SHA + 未验证范围.

移交后建议. ELV-73 可标 Duplicate → ELV-94, 但**必须在 ELV-94 描述里补上上述 1-4 条**, 否则会丢掉 `both` 与资源清理这两项独有要求.

---

## 5. #65 / #68 / #73 采用范围与署名

| PR | 作者 | 改动规模 | 实际采用范围 | 结论 |
|---|---|---|---|---|
| #65 | Cheng Luo | 5 文件 +393/−45 | 2.34 窗口加载 marker + bootstrap CSRF, 与 #67/#69 高度重叠; `Cheng Luo` 在 HEAD 提交数 = 0 | 无独有细节被采用 |
| #68 | Xuhang0607 | 3 文件 +33/−1 | 提出 `resolveHostAuthToken`: 只接受与活动 LS origin 精确匹配（同端口、仅回环）的主进程令牌, 并配 `local-api-auth.test.js` | 该安全边界已由本地 `resolveAuthBootstrapForOrigin` + `meter-v234-compat` 等价落地, 思路被采用 |
| #73 | awu5425 | 2 文件 +18/−4 | `install.js` / `modular-installer.js` 接受 `loadHubWindowUrl(win, url, …)` 锚点并放宽结构校验 | 本地 `HUB_WINDOW_LOAD_RE` 覆盖同一锚点且更宽（多写法 + 歧义拒绝）, 思路被采用 |

署名建议（本轮只记入台账, 未改 package.json）

1. **Xuhang0607（#68）**. 建议列入 `contributors`. 依据. 「只接受精确活动 origin 的主进程令牌」这一安全边界与其测试范式已在本地等价落地.
2. **awu5425（#73）**. 建议列入 `contributors`. 依据. `loadHubWindowUrl` 锚点这一关键发现与本地正则方向一致.
3. **LC9999216（#65）**. 暂不列入. 依据. 与 #67/#69 属同一问题的重复提交, 未见独有细节被采用; 若后续 2.34 复验采用其 `skipBootstrapMint` 变体再补.
4. 其余 2.34 组（#66 Hirasawa8 / #67 shixin08052 / #69 Jemiking）已在 `contributors` 中, 无需变动; #61 x1051445024 亦已在列.

现状. `package.json` `contributors` 共 20 位, 待补 2 位（Xuhang0607 / awu5425）, 暂缓 1 位（LC9999216）.

---

## 6. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-11-22 08:12 | 建台账. 修正 Linear 口径为 105 编号 / 75 唯一事项; ELV-97 记部分实现; ELV-52 记「实现默认禁用, 收益实验未验证」; #56 拆 a/b; ELV-73 独有条件移交 ELV-94; PR 按 A/B/C/D 分类; 给出 #65/#68/#73 署名建议 |
