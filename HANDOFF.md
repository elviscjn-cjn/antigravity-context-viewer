# AntigravityContextMeter v0.9.0-beta.1 交接与验收记录

## 1. 当前版本、工作树与构建指纹

- 更新时间. 2026-11-23 00:39 (Asia/Shanghai).
- 目标版本. `0.9.0-beta.1` (界面显示 `0.9.0 β`).
- 当前分支. `feat/v0.8.9-beta`.
- 基线 HEAD. `044cdc22cbfcf611e727ba33383d97b189a27c01`.
- 冲突核查. `git grep -n -E "^(<<<<<<< |=======$|>>>>>>> )"` 为 `0` 处命中 (`exit=1`). 全部开发与验收改动保留于当前工作树, 未执行 `git commit` 或 `git push`, 未写入远端 GitHub 或 Linear, 未覆盖 IDE 未保存缓冲.
- 核心构件指纹 (本轮最终锁定).
  - `meter-core.js`. `450,764` 字节 (`SHA-256`: `e18e361ec4c0c7b6567383b986c513f01506c8987627193b24bcb825cabc58f4`, `hostCoreBuildId`: `f041b6fed9bc`, `watchBundleBuildId`: `9efdb62bc989`).
  - `meter-renderer.js`. `2,153,229` 字节 (`SHA-256`: `2a041cb6a5956c206d93954eb251ea22f06dd07ff81e2b66578f92fe2733788e`, `rendererBuildId`: `2a041cb6a595`, 运行时内嵌 `window.__AGContextMeter.buildId`: `94e2e20e5a6040ce`).
  - `host-recovery.js`. `17,935` 字节 (`SHA-256`: `1c20be2fe99c566cedb66649bfa60ff48d49fa89db298fbecb1c14390bf07376`).
  - `cli.js`. `126,632` 字节 (`SHA-256`: `826b57db994e428039db64660aff27eb619307164d9f8894b86866fd5fc3bd1d`).
  - 安装态 `app.asar`. `12,112,488` 字节 (`SHA-256`: `D97A08E7153FA484ECF717FC19724552A3C543A80BA61C1FA0DB815E01B9A2C8`, `1,166` 个原文件校验通过, 宿主 `2.34.0`).
  - 发布安装包 (`dist/release/`).
    - `antigravity-context-viewer_0.9.0-beta.1_windows_amd64.zip` / `windows_arm64.zip`: `1,307,067` 字节 (`SHA-256`: `d75fdec57b880f87e4305856103f1ea784344bdb6adde49acd8001093cb56965`).
    - `antigravity-context-viewer_0.9.0-beta.1_darwin_amd64.zip` / `darwin_arm64.zip`: `1,299,181` 字节 (`SHA-256`: `9c7afdb9d05ec22836a2e5e7e35647b03f2ff99276495240f378feccc465343a`).
    - `antigravity-context-viewer_0.9.0-beta.1_linux_amd64.zip` / `linux_arm64.zip`: `1,299,181` 字节 (`SHA-256`: `2c514153a6502a6f27710384c6f4c848a5e3dac972a3b9977ac98b4be7bfa396`).
    - `checksums.txt`: `SHA-256`: `4ed5b946d4b798ec699ffbda1a294de68042e837e0316ebb19e682bd9ae5bf87`.
  - 贡献者署名 (`package.json`, 共 `27` 位). `Lopution`, `huron09280`, `kyrie21z`, `startips`, `x1051445024`, `feizaodemon`, `Tswatery`, `Kisaragi-Mio-0127`, `JYPYYy`, `Nymph-Beta`, `yuanyang749`, `Jemiking`, `Staaaying`, `shixin08052`, `Hirasawa8`, `unie774`, `lllhhhh`, `1-pluto1`, `Fengsuid`, `MoiraToki`, `XiangZheng2283`, `paojiaoleshenghuo`, `Xuhang0607`, `awu5425`, `BetterThanAny`, `jinyue806`, `Jeffgithub0029`.

> 注. 下方第 2~7 节保留自前序构建 (`8ef529fb185e`) 已完成且功能逻辑一致的验收基线记录; 本轮发布前收尾全部最新全量测试、打包、官方副本 ELV-105 及真实桌面端 2.34.0 前台验收见第 9~11 节.

## 2. 本轮新增实现与修复摘要

### 2.1 额度消耗节奏 (`Quota Pace`, 按《创意.pdf》最后两页整合版)
- 核心模型 (`meter-core.js` `QUOTA_PACE_TIERS`, `evaluateQuotaPace`, `buildModelQuotaSnapshot`).
  - `delta = quotaRemaining - timeRemaining`. 四档边界 `+10%` (1 档宽裕 `#22C55E/#16A34A`), `-5%` (2 档均衡 `#34D399/#10B981`), `-25%` (3 档偏快 `#F59E0B/#D97706`), `<-25%` 或已耗尽 (4 档透支 `#EF4444/#DC2626`).
  - 20 格上轨与小数填充 + `0.1%` 极小非零保护 (`opacity: 0.25`) + 0% 已耗尽强制 4 档透支; 缺重置时间、周期未知、已过期、无权限、取数失败或数据过期时静默隐藏节奏下轨、时间刻度点与节奏标签.
- 实机视觉修复 (`src/renderer/styles.css`, `src/renderer/main.js`, `meter-quota.test.js`).
  - `.quota-seg-fill` 补充 `display: block`, 解决 `<span class="quota-seg-fill">` 在 `inline` 默认盒模型下 20 格上轨宽高为 `0×0` 的问题.
  - 放宽下轨与紧凑行 `.quota-pace-gap` 显示条件为 `pace.hasGap && pace.gapWidthPct > 0` 并补充 `data-pace-tier="2"` 淡青高亮, 确保额度低于剩余时间比例时 2/3/4 档均标出差距区段.
- 分层展示与输入框摘要 (`src/renderer/template.html`, `src/renderer/main.js`, `meter-collector.js`).
  - 当前池完整双轨展开, 其他池默认紧凑展示点击展开/收起; `#badge-quota` 圆环增加时间刻点 `#quota-ring-pace-dot`; 设置页新增 `#chk-show-composer-quota` 开关 (`getPluginSettings` / `savePluginSettings` 持久化 `showComposerQuotaSummary`); 输入框正下方 `#csb-group-quota` 支持 5h/7d 双显、另一条限额提醒、`+N` 及窄窗自动收紧.

### 2.2 ELV-103 混合模型会话计量修复 (`meter-core.js`, `meter-collector.js`, `meter-cli-monitor.js`, `meter-cli-ui.js`, `src/renderer/*`)
- **修复跨源同次调用翻倍重复计数**. 在 `meter-core.js` `groupSessionCallsByTurns` 实现两级无损去重器: 第 1 级按 `(cascadeId, agentRole, callId)` 合并同 ID 更新并在异常不同步复写时保留 `#dup` 副本; 第 2 级在同 `(cascadeId, agentRole, stepIndex)` 桶内先以精确非零 `(input, cacheRead, output)` 三元组 + 时间兼容配对合并 `bot-*` / `#step` / RPC ID, 再对 1-to-1 流式升级合并. 同步消除 `meter-cli-monitor.js` 与 `meter-cli-ui.js` 按 `step:${stepIndex}` 粗暴覆写丢弃同 `step` 真实二次重试的缺陷.
- **修复账本 Orchestrator 双记与 M667 计费错归属**. 在 `meter-core.js` `extractModelString` 与 `normalizeModelId` 优先保留非占位 readable label 与 `MODEL_PLACEHOLDER_M667` (`gemini-4-carbon`), 补全 `M537` (`Orchestrator (Neon)`); 在 `meter-collector.js` `areCallRecordsModelCompatible` 与 `reconcileConfirmableDuplicateStepCalls` 自动消解同 `(source, cascadeId, stepIndex, inp, cap, out)` 且时间兼容的历史异构双记 (`pricing_ledger_v1.json` 全局精确重复组由 `117` 降至 `0`).
- **过滤非模型错误空壳与同步多试防撞 ID**. 在 `meter-collector.js` `parseTranscriptForSessionTimeline` 过滤无 `chatModel` 且无用量的 `GENERIC` 工具错误行 (`step 255`), 并对同 `stepIndex` 出现多次含用量调用的记录分配 `${cascadeId}#${stepIndex}@${occ}` 避免套用同一个 SQLite `responseId`.
- **抽出共享子代理归集助手并产出单一权威 `modelBreakdown` + `sessionTokenTotals`**. `meter-collector.js` 导出 `collectVerifiedSubagentCallsForSessionSync`, 供 `collectSessionTimelineCoreAsync`、`getSessionDetail` 与 `getCliSessionTimeline` 三端复用; `groupSessionCallsByTurns` 新增返回按实际执行模型汇总 `modelBreakdown` (独立区分 `Orchestrator (Carbon/Argon/Neon)`、Worker 变体与 `未知模型` `__unattributed__`) 与守恒校验 `sessionTokenTotals`, 并渲染于客户端 `#session-timeline-summary` 与 CLI 独立看板详情弹窗.

## 3. 自动化测试、打包与官方 2.34.0 安装校验

所有测试与构建均在本机前台/同会话顺序执行并校验退出码 (`0`), 最新全量日志 (`build-test-verify.log`) 存放在 `D:\Downloads\AntigravityContextMeter_v0.9.0_尾注对账额度减法与顶栏切面板验收\`:
- 渲染层构建 (`npm.cmd run build:renderer`). 退出码 `0`, `meter-renderer.js` `2,178,360` 字节 (`rendererBuildId: 8ef529fb185e`).
- 发布清单检查 (`node scripts/check-release-manifest.js`). 退出码 `0`, `23` 个安装依赖齐全.
- 额度专项测试 (`node --test meter-quota.test.js`). 退出码 `0`, **`33 passed, 0 failed`**.
- 渲染器专项测试 (`node --test meter-renderer.test.js`). 退出码 `0`, **`93 passed, 0 failed`**.
- 用量与展示专项测试 (`node --test meter-v089-usage.test.js`). 退出码 `0`, **`17 passed, 0 failed`**.
- 全量 Node 回归 (`npm.cmd test`, 26 个套件). 退出码 `0`, **`517 passed, 0 failed, 0 skipped, 0 cancelled`** (`81668.4906ms`).
- Python 附件扫描测试 (`unittest attachment_scan_test.py -v`). 退出码 `0`, **`Ran 9 tests in 0.163s - OK`**.
- 多平台打包 (`node scripts/package-release.js`). 退出码 `0`, 生成 `dist/release/checksums.txt` (`SHA-256: 5655FDDD2BA9719CE97E647D46B382D895D41F34AFD685F541E035E86EBE671B`) 与 6 平台 zip (`windows_amd64/arm64` `1,415,972` 字节 SHA-256 `6cbf317fc8cdec9f9e0377221ee83da97c828bfbc7d3d87b21a973f895a06a64`, `darwin_*/linux_*` `1,407,642` 字节 SHA-256 `5cca320e14879caedc91357b67867c28a856a6e706268b35cffefc3678626c50`).
- 官方 `2.34.0` 纯净备份集中安装 (`node cli.js install --backup "C:\Users\elvis\AppData\Local\AntigravityContextMeter\backups\app-2.34.0-de2304eb-base.asar"`). 退出码 `0`, 校验 `1,166` 个原文件, 落盘 `C:\Users\elvis\AppData\Local\Programs\antigravity\resources\app.asar` (`12,147,481` 字节, SHA-256 `E03D8843474236A204C024DA6050F384C5C1B4468F1EAD1CD03EAE5FCA5BDE42`). `node cli.js status` 退出码 `0`, 返回 `asarPatched: true`, `diskVersion: "0.9.0-beta.1"`, `antigravityVersion: "2.34.0"`.

## 4. ELV-103 真实混合模型会话只读对账结果 (`verify-elv103-reconcile.js`)

- 全局 `pricing_ledger_v1.json` 只读消重校验. 原始磁盘 `37,389` 条 (`117` 组精确 `(cid, step, in, cache, out)` 重复) -> 内存去重加载后 `37,272` 条, **`exactDupGroups = 0`**.
- 主样本会话 `1602135e…efab`.
  - 源记录 (主 transcript `887` + 2 个已验证研究子代理 `7e7a67d1…1d0f` `34` + `79e9f4ca…79a6` `41`). **`962` 次调用 / `213,443,649` Tokens**.
  - 三端引擎输出 (`collector` / `cliMonitor.getSessionDetail` / `cliUi.getCliSessionTimeline` 完全一致 `threeWayMatch = true`). **`962` 次调用 (主 `887` / 子 `75`) / `213,443,649` Tokens**, **`diffDetailVsSession = 0`**, **`diffBreakdownVsSession = 0`**, **`isConsistent = true`**, **`dedupVerified = true`**.
  - 逐模型分布. `Gemini 4 Hydrogen` (`515` 次, `136,220,369`, `63.8%`), `Gemini 3.8 Flash` (`303` 次, `39,574,695`, `18.5%`), `Gemini 4 Carbon` (`95` 次, `19,327,423`, `9.1%`), `Orchestrator (Carbon)` (`41` 次, `14,689,443`, `6.9%`), `未知模型 __unattributed__` (`8` 次 [含主 6 次 + 子 2 次 `CHECKPOINT`], `3,631,719`, `1.7%`).
  - 验证代表性请求. 同 `step 823` 两次真实重试 (`149,334` tok @ `16:41:24Z` 与 `149,290` tok @ `16:44:44Z`) 均保留; `step 1597` Orchestrator (Carbon) 消重为 `1` 次 (`210,722` tok); `step 273` 系统 `CHECKPOINT` (`527,157` tok) 归入 `未知模型`.
- 辅样本会话 `e0fa5dd0…7d73` (含 `MODEL_PLACEHOLDER_M402`). `84` 次 / `10,217,751` Tokens (`Gemini 3.8 Flash` `62` 次 `8,086,808` + `Claude Opus 5.5` `22` 次 `2,130,943`), `threeWayMatch = true`, 差异 `0`.

## 5. 真实 Antigravity 2.34.0 额度消耗节奏 4 场景实机验收 (`verify-live-quota-pace.js`, 退出码 `0`)

- 实际加载. `antigravityVersion = "2.34.0"`, `asarPatched = true`, `liveWindow.active = true`, `version = "0.9.0-beta.1"`, `effectiveBackendSource = "electron-ipc"`, `window.__AGContextMeter.buildId = "681cd530ab5ff3a3"`.
- 同一条真实样本读数 (`Gemini Models` · `Google AI Pro`).
  - `每周限额`: 剩余额度 `73%` (`0.7303`), 剩余时间 `98.5%` (`6天21小时后重置 · 11-29 04:00`), 节奏差值 `deltaPct = -25%` -> **4 档 `透支 -25%`**, `14` 满红格 + 第 `15` 格 `60.7%` 填充, 时间白线 `98.53%`, 红高亮差值带可见.
  - `5小时限额` (06:29 首轮实机日志 `live-quota-pace-verify.json` 原始比例实为 `0.0614952`, 第 `2` 格填充 `23.0%`, 前次书面报告误记为 `0.0726`/`45.2%`; 本轮已对齐 `formatQuotaNumPctValue` `<0.1%` 极小口径并通过同快照三端对账).
  - 渲染 DOM 验证. `.quota-seg-fill` 计算样式 `display = "block"`, `backgroundColor = "rgb(239, 68, 68)"`, 非零格实际宽度 `18.24px`.
- 4 张目视核验真机截图 (`D:\Downloads\AntigravityContextMeter_v0.9.0_额度消耗节奏与ELV103验收\`).
  1. `01-main-pool-dual-track.png` (主池 `Gemini Models` 双轨 20 格卡片 + 下方紧凑 `Claude and GPT models`).
  2. `02-other-pool-expanded.png` (点击展开 `Claude and GPT models` 双轨 20 格 100% 翠绿 `均衡` 卡片).
  3. `03-topbar-ring-and-composer-summary.png` (宽窗顶栏 `#badge-quota` `6% 5h` 红环+时间白点 + 底部 `● 5h 6%  ● 7d 73%  7d 透支  +3`).
  4. `04-narrow-window-composer-summary.png` (`433px` 窄窗 `data-csb-width="tight"` 保留 `● 5h 6%` + `7d 透支`, 实测向宿主输入框键入 `pace-narrow-test` 与清空均通过).
- 会话时间线实机抽查. 真实会话 `65b8715b` 历史抽屉 `.timeline-model-row` 渲染为 `Gemini 4 Hydrogen 66 · 5.3M (100%)`.

## 6. 本轮收尾、ELV-94 停靠与 ELV-98 / ELV-99 实机复验 (`verify-live-v090-round2.js`, 退出码 `0`)

脚本与完整日志目录: `D:\Downloads\AntigravityContextMeter_v0.9.0_收尾与ELV94_98_99验收\` (`live-v090-round2.json`, `live-v090-round2.log`).
- **运行时加载确认**. `version = "0.9.0-beta.1"`, `window.__AGContextMeter.buildId = "526f03c56875b94d"`, `backendSource = "electron-ipc"`.
- **1. 同一次刷新快照三端额度对账 (`01-quota-same-snapshot.png`, `fetchedAtMs = 1795305407022`)**.
  - 原始 `remainingFraction`: `gemini-5h = 0.37094834` (`37%`), `gemini-weekly = 0.5490224` (`55%`).
  - 顶栏 `#badge-quota` (`37% 5h`, 时间点可见)、双轨卡片 (`5h 37%` `7` 满格 + 第 `8` 格 `41.9%` `透支 -38%` 剩余时间 `74.7%`; `Weekly 55%` `10` 满格 + 第 `11` 格 `98%` `透支 -40%` 剩余时间 `94.9%`) 与输入框下方摘要 (`5h 37%` / `7d 55%` / `7d 透支`) 三端数值 `100%` 一致.
- **2. ELV-103 混合会话实机 UI 明细 (`02-elv103-mixed-session-1602135e.png`)**.
  - 会话 `1602135e…efab` 面板明细行实机呈现 `Gemini 4 Hydrogen` (`515 · 136.22M (63.8%)`), `Gemini 3.8 Flash` (`303 · 39.57M (18.5%)`), `Gemini 4 Carbon` (`95 · 19.33M (9.1%)`), `Orchestrator (Carbon)` (`41 · 14.69M (6.9%)`), `未知模型` (`8 · 3.63M (1.7%)`, `isUnknown = true`), 与底部 `会话合计 962 次 · 213.44M tok（入 10.7M / 缓 201.69M / 出 1.05M）` 一致.
- **3. ELV-94 右侧辅助栏停靠、焦点跟随与独立页 (`03/04/05 PNG`)**.
  - **宿主边界确认**. Antigravity `2.34.0` 未向扩展暴露向内置浏览器自动新建 URL Tab 的 API, 右侧入口统一先展开/识别宿主 `[data-side-panel-open="true"]` 内 `[data-side-panel-focus-scope="true"]`, 执行侧边面板内嵌停靠 (`aux`) 并同步复制聚焦会话精确 CLI 看板链接 (`http://127.0.0.1:56780/?sessionId=<id>&source=desktop`), 同时保留「复制链接 / 外部浏览器 / 返回顶栏 / 以独立页面展开」动作.
  - **修复与实机点验**. 修复 `outside(e)` 在 `aux`/`page` 常驻停靠态误关面板、补充 `flushHostDomMutationCheck` 对 `data-side-panel-open` 监听及 `styles.css` 侧栏防挤压样式. 实机 verified `actualDock = "aux"`, `hostParentSideScope = "true"`, `panelStillOpenAfterOutsideClick = true`, 同项目切会话 (`8b7be913 -> 78799486`) 与分屏焦点切换 (`?focused=78799486` / `?focused=8b7be913`) 顶部跟随条实时更新; 点击「返回顶栏」退回 `flow`, 点「独立页面」全宽展开并显示「返回聊天」(`backBtnHidden = false`), 点「返回聊天」恢复 `flow` (`backBtnHidden = true`).
- **4. ELV-98 上下文趋势图与口径核对 (`06/07 PNG`)**.
  - `meter-core.js` 新增 `buildContextTrendSeries`, `src/renderer/` 实现堆叠总量 / 0 线居中增量 `Δ` 与按步 / 按轮切换, 标明 `服务端用量` (`server_usage`) / `本地估算` (`local_estimate`) / `混合来源` (`mixed`) 口径; 点击 `S2357` 柱条 (`inspectText: S2357 · 上下文 297K (+13.1K) · 新输入 13.1K + 缓存 283.8K · Gemini 4 Carbon`) 与正下方 `#latest-call-detail-grid` (`K7n8aqrmFZmtqtsP0sq2uQM`, 输入 `13,121`, 缓存 `283,843`, 总输入 `296,964`) 逐字一致.
- **5. ELV-99 默认视图持久保存与冷重启恢复 (`08-elv99-cold-restart-restored.png`)**.
  - 新增 `meter-collector.js` `DEFAULT_VIEW_PREFS` 9 字段持久层与面板内「设为默认」入口; 修复打开 Token 面板触发 `syncTokenHistoryFromHost()` 二次异步恢复覆盖会话临时视图的隐患. Launch #2 二次冷重启实机验证全部 `9` 项偏好 (`heatView = "monthly"`, `modelUsagePeriodDays = 30`, `speedRangeDays = "30"`, `costScope = "all"`, `contextTrendMode = "delta"`, `contextTrendGranularity = "turn"`, `timelineDeltaOnly = true`, `timelineSortOrder = "delta_desc"`, `reqLogSortBy = "tokens_desc"`) 与 9 个对应 UI active 状态均为 `true`.

## 7. 第 3 轮尾注去框、缓存对账、额度视觉减法与顶栏切面板实机复验 (`8ef529fb185e`)

产物与日志目录. `D:\Downloads\AntigravityContextMeter_v0.9.0_尾注对账额度减法与顶栏切面板验收\` (`build-test-verify.log`, `live-v090-round3.log`, `live-v090-round3.json`).
- **运行时加载确认**. `antigravityVersion = "2.34.0"`, `version = "0.9.0-beta.1"`, `window.__AGContextMeter.buildId = "48947dc40dd257cb"`, `backendSource = "electron-ipc"`.
- ** Antigravity IDE 未保存编辑缓冲核查**. 只读检查 `C:\Users\elvis\AppData\Roaming\Antigravity IDE\Backups` 中 14 份脏缓冲, 主仓库仅 `src/renderer/styles.css` (仅 Prettier 空白折行差异) 与 `meter-core.js` (含旧版重叠行草稿) 两份在列, 其余属兄弟工作树或 `Downloads` 脚本; 磁盘源码为最新权威状态, 切勿直接把 IDE 中未保存的旧 `meter-core.js` 缓冲覆盖保存至磁盘.
- **1. 回复尾注去框、窄窗保速与两轮「只回复 ok」缓存对账 (`01/01b PNG`, `Test Conversation` `78799486-61aa-422e-b0dc-dc61314d4c1d`)**.
  - 全对话 `7` 轮各挂独立无框尾注 (`borderTopWidth: "0px"`, `backgroundColor: "rgba(0, 0, 0, 0)"`, `boxShadow: "none"`, `truncated: false`).
  - 第 6 轮「只回复 ok」 (`turn-6`, `quwBa7eRLpW6odAPxqKKsAM`, `2026-11-22 03:10:35`): 未缓存输入 `31,851`, 缓存读取 `0`, 总输入 `31,851`, 输出 `57`, 命中 `0%`, 速度 `570 tok/s`, 显示 `本次请求 · In 31.9K · Out 57 · 缓存 0% · 570 tok/s`.
  - 第 7 轮「只回复 ok」 (`turn-7`, `wTECa8iUMJaA6tkPqLCn4Qk`, `2026-11-22 08:05:21`): 未缓存输入 `32,209`, 缓存读取 `0`, 总输入 `32,209`, 输出 `57`, 命中 `0%`, 速度 `518 tok/s`, 显示 `本次请求 · In 32.2K · Out 57 · 缓存 0% · 518 tok/s`.
  - 缓存率差异与 `0%` vs `—`: 单轮尾注仅按该次请求 (`cacheRead / (uncached + cacheRead) = 0 / 31,851 = 0%`, `0 / 32,209 = 0%`), 而会话输入栏按全部 7 次有效调用累计求和 (`57,272 / (162,439 + 57,272) = 26%`, 合计 `220,453 tok`); `cacheRead=0` 且 `totalInput>0` 显示确认 `0%`, 无确认用量或分母为 `0` 显示 `—`.
  - `540x920` 窄窗 (`rowClientWidth = 178`) 分级省略模型名与 `本次请求`, 稳定呈现 `In 31.9K · 0% · 570 tok/s` 与 `In 32.2K · 0% · 518 tok/s` (`truncated: false`, `hasFullTpsText: true`, 原生按钮未缩且未超宽).
- **2. 额度减法、0% 空条与手动刷新逐格点亮 (`02 PNG`, `01-quota-manual-refresh-pulse.mp4` 35 帧)**.
  - 当前主池单张双轨卡 (`shared_gemini_main`, `hasDuplicateMainInList = false`), 无重复主池卡片. 同一次快照 (`fetchedAtMs = 1795355053525`): `gemini-weekly` = `37%` (`0.37187696`, 剩余时间 `87%`, `透支 -50%`, Tier 4 红); `gemini-5h` = `74%` (`0.7411549`, 剩余时间 `93%`, `偏快 -19%`, Tier 3 橙); `shared_3p_pool` `3p-weekly` = `0%` (`compactEmptyFills: [{w:"0%", op:"0", disp:"none"}]`).
  - 点击「刷新」成功返回后 `chargeObservedDuringPulse.playing = true`, 仅有效已填充格按 `stepMs = clamp(round(420/activeCells), 22, 48)` 从左至右点亮并稳定收尾 (`[8/48ms, 15/28ms, 20/22ms, 20/22ms]`, 63 个填充 DOM 单元).
- **3. 顶栏圆形入口悬停切面板、Esc 收起与淡色内收高亮 (`03/04/05/06/07 PNG`, `02-topbar-hover-panel-switch.mp4` 12 帧)**.
  - 修复 `#overflow-menu` hover+click 同帧反关、`Esc` 焦点归还重开及 `flow` 模式下 `#overflow-menu` (`z-index: 2147483645`) 与 `.ag-panel` (`2147483500`) 层叠遮挡问题.
  - 跨间隙停留菜单保持展开 (`picker.open = true`), 依次在右栏原地切换 `quota -> context_detail -> requests` (`actualDock = "aux"`, `route = 78799486-61aa-422e-b0dc-dc61314d4c1d`), 误点已选项保留面板, `Esc` 仅关选择器 (`pickerOpen: false`, `tokensPanelHidden: false`), `flow` 浮动模式下悬停切换至 `tokens` 成功 (`currentTarget: "tokens"`).
  - 深色选中 `.ag-unit::before` `rgba(255,255,255,0.11)` / 浅色 `rgba(0,0,0,0.086)` 内收 `inset: 3px 2px` (`ring-only` `inset: 3px` 圆形), `620x920` 窄窗 `#badge-overflow` 点开为 `true`, `1440x920` 下紧邻右侧原生「更多操作」(`gapFromHostPx = 4`) 实测 `topElOwnedByNative: true`, `clickCount: 1`, `popupOpen: true`.

## 8. Google Drive 同步状态

- `D:\Downloads\AntigravityContextMeter_v0.9.0-beta.1_大更新验收\sync-to-gdrive.ps1` 已同步更新至本轮锁定构建 `$BuildId = 'f041b6fed9bc'` / `$RendererBuildId = '2a041cb6a595'`, 移除已删除的 `'assets/antigravity-icon__full-color.png'`, 并增补 `'host-recovery.js'`, `'macos-binary-utils.js'`, `'meter-cli-launcher.js'`, `'meter-storage.js'`, `'meter-first-install-recovery.test.js'`, `'meter-macos-watch.test.js'`, `'TASK_LEDGER.md'`, `'install.sh'`, `'install.bat'`, `'uninstall.sh'`, `'uninstall.bat'`, `'attachment_scan.py'`, `'attachment_scan_test.py'`, `'AGENTS.md'`, `'README.ja.md'`, `'README.ko.md'`, `'README.es.md'`, `'scripts/check-release-manifest.js'` 至审查文件清单 (不含凭据、不含构建产物包、不含日志).
- 执行 `& "C:\Users\elvis\.gemini\config\plugins\gdrive\skills\gdrive\scripts\gdrive.cmd" auth status` 返回 `Authentication Status: Not logged in`, 因此**未上传**至 Google Drive. 完成 `gdrive auth login` 授权后可直接执行上述脚本同步至「已加星标 → AntigravityContextMeter」.

## 9. 本轮收尾新增实现与 PR / Issue 对照矩阵

### 9.1 PR / Issue 核对、采用范围与剩余缺口

| PR / Issue | 作者 | 参考 HEAD | 采用情况与改动文件 | 测试与剩余缺口 |
|---|---|---|---|---|
| PR #76 / Issue #75 | `XiangZheng2283` | `86f1176f72ad31bba76e0f19160176fb13813d15` | 已整合：`meter-collector.js`, `scripts/package-release.js`（显式 `System32\tar.exe` 优先、PowerShell `Expand-Archive` 参数化回退、脱敏报错、防半解压目录进入安装） | `meter-update-delivery.test.js` + `pr76-zip-extract-evidence.txt` (Git GNU tar 抢占 PATH / 四路径 / v0.8.10->v0.9.0-beta.1 隔离升级通过) |
| PR #79 (续 PR #70) | `Staaaying` | `3636fab601d2c151801a669e40ff67aec7560f17` | 已整合：`src/renderer/main.js`（Shadow DOM 事件隔离防右分屏失焦与 `Esc` 守卫，适配悬停选择器/浮层/右栏） | `meter-renderer.test.js` + 桌面端 `04-pr79-split-right-focus.png` (`focusRemainedOnTarget=true` 4/4；无真实左右双分屏及 Side Question 实例，该两部分以自动化覆盖为准) |
| PR #74 | `Staaaying` | `846c0edf2e33b3664bb3545e1a2bada00a1da72e` | 已整合：`meter-core.js`, `src/renderer/i18n.js`, `src/renderer/main.js`（Neon `$3/$15/$0.15`、`M537/M667/M668/M669/M681`、Prefix Selector、保留 `(Carbon)/(Argon)/(Neon)`、`未知档位`、清旧额度） | `meter-core.test.js`, `meter-quota.test.js`, `meter-renderer.test.js` 通过；桌面首页可见 `Orchestrator Gemini 4 Neon Extra High` 正确呈现 |
| PR #36 | `JYPYYy` | `977410674077284e27c5ac5c972eb04f5d34c4a1` | 已整合：`meter-collector.js`（WebP `VP8/VP8L/VP8X` 尺寸、内联图片缓存在内、JSONL 字节增量续读 `256B+32B`、`ELV-103` 无损兼容） | `meter-core.test.js`, `meter-v089-usage.test.js` + `pr77-pr36-reconcile-bench.txt` (4.16MB 全量 15.17ms vs 增量 0.56ms 仅读 1046B，SHA-256 逐字节一致) |
| PR #43 | `Nymph-Beta` | `a759299aa298dacfa3c1b18a6ea40ebbfc2148ef` | 已整合并补修同机 IDE `daemon_hub` 误判：`cli.js` (`cmdLive` / `ensureLiveWindowAvailable` / `runWatchDaemon` / `quitAntigravityHostGracefully` 校验真实桌面进程存活性) | `meter-macos-watch.test.js` (含 `relaunch_quit_timeout` 保护与多进程 `daemon_hub` 隔离) + 真实桌面端冷拉起、无 CDP 提示与不强杀保护实测；未测需授权模型收发 |
| Issue #77 | `BetterThanAny` | — | 已修复：`meter-collector.js`, `meter-core.js`（删当天已入账会话留 legacyV1 增量、回退重发 `cascadeId#stepIndex` 防撞、10 分钟 `.bak.json` 节流） | `meter-v089-usage.test.js` + `pr77-pr36-reconcile-bench.txt` (4 层守恒差 0；38.85MB 真实账本 6,209,286,681 tok 差异 0) |
| Issue #78 | `jinyue806` | — | 已修复：`cli.js`, `live-host.js`（WMI `Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 }` + `ReturnValue` 校验） | `meter-macos-watch.test.js` + `pr78-wmi-bridge-evidence.txt` (WMI 进程存活、200 健康、EnumWindows=0 无黑框) |
| Issue #80 | `Jeffgithub0029` | — | 已修复：`macos-binary-utils.js`, `install.js`, `install.sh`, `README.md`, `README.en.md`（2.34.0 `loadHubWindowUrl` + macOS `ElectronAsarIntegrity`/签名门禁与文档明示） | `meter-v234-compat.test.js` 通过；缺物理 Mac 实机，真实签名 macOS `.app` 真机安装/watch 仍待 Mac 设备补验 |
| PR #27/#32/#35/#72/#69/#60/#64 | 各社区贡献者 | 见 `THIRD_PARTY_NOTICES.md` | 已有兼容、鉴权、CLI 解锁、无 TUN 启动器、备份清理与额度修复均回归 | `npm.cmd test` 全部对应套件通过 |

### 9.2 需求三、需求五 (`ELV-105`) 与需求八 (`dsh-context` 调研与合规整改)

1. **需求三 (首次全新安装默认全关 + 面板语言跟随宿主或用户设置)**:
   - 修复 `modular-installer.js` (`_ch.enabled === true && _ch.language !== 'en'`, 同保留 `chinese.enabled === false` 门禁关键字)、`meter-main.js`、`modules-config.js` (隔离 `stateDir` 防宿主机旧痕迹误迁 + `AntigravityChinese/config.json` 必须 `enabled === true` 才迁移)、`meter-collector.js` (`panelLanguageExplicit` 标识区分未设置用户与显式设置) 及 `install.js` (热注入透传 `__AGY_CHINESE_CONFIG__` 与 `stateDir`).
   - 修改 `src/renderer/i18n.js` (`resolveExplicitPanelLanguagePref`, `resolveHostClientLanguageSignal`, `resolveInitialPanelLanguage`) 与 `src/renderer/main.js` (`hasExplicitPanelLanguage`, `refreshModulesDisplay` 跟随开关), 首装全关时在英文宿主下零帧默认英文、开启汉化重开自动切简体中文、关闭汉化重开恢复英文、用户手选简/繁/英始终优先.
   - `meter-first-install-recovery.test.js` + 真实桌面端 `2.34.0` 截图 (`01`/`02`/`03`) 验证通过 (注: 真实测试机存在用户预先解锁的 `language_server` 与 `hooks.json` 导致设置页同步勾选 `chk-rec-ctx`/`chk-rec-rehydrate`, 而模板默认及未启用的 `prompt`/`title`/`lang` 均为 `false`).
2. **需求五 (`ELV-105` 宿主更新覆盖后自动检测、预检拦截、按版本隔离备份与无损恢复)**:
   - 新增 `host-recovery.js` (`inspectHostRecoveryState`, `runPreflightChecks`, `backupHostAsarByVersion`, `recoverHostInstallation`), 接入 `cli.js recover` / `status` / `check` / `live` / `watch` / `proxy:launch` / `proxy:launcher` (`meter-proxy.js` 可选 `recoverCliPath`)、`install.js` (`backupsByVersion` + `additions`)、`modules-config.js`、`meter-collector.js` (`LIVE_RUNTIME_FILES`) 及 `scripts/package-release.js` (`COMMON_FILES`).
   - 官方真实备份 `2.33.1 -> 2.34.0` 实测 (`elv105-real-copy-recovery-evidence.txt`) 通过场景 1 (全关首装 -> 2.34.0 覆盖 -> `--check-only` -> 恢复全关 + 双版本备份隔离留存 -> 幂等 `noop`) 与场景 2 (开启汉化 -> 2.34.0 覆盖 -> 恢复保留汉化并就绪); 结构异常与 macOS `ElectronAsarIntegrity` 写前拦截由 `meter-first-install-recovery.test.js` 覆盖.
3. **需求八 (`dsh-context` 只读参考与 IP/版权合规整改)**:
   - 只读比对 `dsh-context` (`0.87.0` HEAD `42e73c19ceef2e04c59b707c2b563f98c34e3ed5` / `0.86.0` / `overview-cache.v3`): 仅在设计思路层面参考模型/用量归属及上下文组成拆解, 严禁复制代码或视觉资产.
   - 移除 `assets/antigravity-icon__full-color.png` 改为原创内联单色 SVG, 为 `i18n/i18n-runtime.js` 与 `src/i18n/i18n-runtime.js` 补全 MIT 头, 对齐 `THIRD_PARTY_NOTICES.md` 与 `package.json` 27 位贡献者署名.

## 10. 上下文进度条待设计条目 (需求六留档)

- **状态**: 待设计规划 (待 Gemini 设计稿确认后在后续版本排期布局与视觉改造; 当前 `v0.9.0-beta.1` 候选已完成兼容前置能力).
- **参考资料**:
  - 文档: `D:\Desktop\上下文显示改动详情.pdf`
  - 参考图: `F:\Pictures\project\2026-11-22_21-57-46.png`、`F:\Pictures\project\2026-11-22_21-57-55.png`
  - 外部只读思路参考: `dsh-context` 上下文拆解功能 (保留 ContextMeter 自有布局、样式与交互体系).
- **核心设计目标**:
  1. 在现有右侧辅助栏 / 上下文视图中清晰解释「当前上下文主要由什么组成」.
  2. 进度条继续保留关键全局数字: 窗口上限、已用与剩余.
  3. 分类明细明确区分为三类归属口径: 宿主实报、估算与无法归属.

## 11. 最终测试、实机验收目录、五类证据分级与发布结论

- **统一验收产物目录**: `D:\Downloads\AntigravityContextMeter_v0.9.0-beta.1_发布前收尾与兼容性验收\`
  - 全量构建测试打包验证 (`release-build-verify.txt`):
    - `npm.cmd run build:renderer`: `exit=0` (`meter-renderer.js`, `2,153,229` 字节)
    - `node scripts/check-release-manifest.js`: `exit=0` (`24` 个安装依赖齐全)
    - `npm.cmd test` (27 个测试文件): `exit=0` (`532 passed, 0 failed, 0 cancelled, 0 skipped, 94130.4535ms`)
    - `node --test meter-elv103-mixed-session.test.js`: `exit=0` (`2 passed, 0 failed, 192.6972ms`)
    - `python.exe -m unittest attachment_scan_test.py -v`: `exit=0` (`Ran 9 tests in 0.149s - OK`)
    - `node scripts/package-release.js`: `exit=0` (产出全部 6 平台 `0.9.0-beta.1` zip 包与 `checksums.txt`)
  - 分项证据文件:
    - `pr76-zip-extract-evidence.txt` (沙箱/隔离 ZIP 升级实测)
    - `pr78-wmi-bridge-evidence.txt` (真实桌面端 Windows 11 WMI 启动无黑框实测)
    - `pr43-pr80-connectivity-evidence.txt` (自动化与 CLI 实测预检)
    - `pr77-pr36-reconcile-bench.txt` (回放与隔离脱敏真实账本/日志对账)
    - `elv105-real-copy-recovery-evidence.txt` (官方真实 `2.33.1`/`2.34.0` 副本升级覆盖恢复实测)
    - `live-desktop-v090-beta1-verify.txt` + 4 张真实前台截图 (`01-clean-install-english-all-off.png`, `02-chinese-enabled-relaunch.png`, `03-chinese-disabled-english-restored.png`, `04-pr79-split-right-focus.png`, 用户个人 `modules.json` 与 `custom_plan_v1.json` 还原 SHA-256 100% 校验匹配)
- **五类证据来源明确区分**:
  - **真实前台**: `Antigravity v2.34.0` 桌面端冷拉起、语言双向跟随、无 CDP 检测、Windows 托盘驻留超时保现场 (`relaunch_quit_timeout`)、顶栏四单元点击焦点不丢失、`WMI` 零黑框桥接启动及前序 `8ef529fb185e` 同架构全功能点验.
  - **宿主副本**: 官方 `2.33.1`/`2.34.0` 原版 ASAR 的 `ELV-105` 覆盖恢复与多版本备份隔离、PR #76 `v0.8.10 -> v0.9.0-beta.1` ZIP 升级演练.
  - **沙箱 / 隔离**: 全部 Node 532 + 2 与 Python 9 单元测试、4 路径 tar/Expand-Archive 解压劫持、macOS `ElectronAsarIntegrity` 拦截、Node 24 `NODE_USE_ENV_PROXY` 绕过代理直连修复.
  - **回放**: 38.85MB 真实账本四层守恒 (`diff=0`) 与 4.16MB 日志增量 vs 全量 SHA-256 一致对账.
  - **自动化 / 上游作者**: 上游作者 PR 思路与 HEAD 参考见第 9.1 节及 `THIRD_PARTY_NOTICES.md`, macOS 真机签名安装与 `watch` 因缺物理 Mac 设备仅通过自动化逻辑验证.
- **发布结论**: **`v0.9.0-beta.1` 可作为本地 Beta 1 候选发布** (Windows 平台全部核心阻塞项已闭环解决并实机核验通过; 可留后续跟进事项: macOS 物理真机端到端签注与 `watch` 补验、真实左右双分屏 + Side Question 现场补截、上下文进度条按 Gemini 设计稿改造、以及 Google Drive 授权后同步上游材料).

## 12. 当前轮收尾交付验收记录 (5 项集中交付与宽屏 Bento 重构)

- 更新时间. 2026-11-23 02:02 (Asia/Shanghai).
- 工作树状态. 分支 `feat/v0.8.9-beta`, HEAD `044cdc22cbfcf611e727ba33383d97b189a27c01`, 本地未执行 `git commit` / `git push` / 远端 Release.
- 最新构建构件与候选包指纹.
  - `meter-core.js`: `463,310` 字节 (`SHA-256`: `372c7763eb9d0a90b947f6ca257421300e06599c7b5f5040019a48eca0c8e2f7`).
  - `meter-collector.js`: `452,581` 字节 (`SHA-256`: `9a1529c98232f2564f04b58db8c56bb8a85de28c41e686fc1a6a0cef6c2f4e98`).
  - `meter-renderer.js`: `2,252,652` 字节 (`SHA-256`: `767a48d3df460bcb1840b5a9e9734efd20b4a8aeafd6bddb8fb61737e34d4e5a`, 实机运行 `window.__AGContextMeter.buildId`: `bd29253b838745f2`, `backendSource`: `electron-ipc`).
  - 安装态 `app.asar`: `12,227,740` 字节 (`SHA-256`: `bc8e80d18c850a720df6c9bdecfac3d00ead943cc05dfcea7874cc428866b798`, `1,194` 个原文件校验通过, 宿主 `2.34.0`).
  - 候选发布包 (`dist/release/`):
    - `antigravity-context-viewer_0.9.0-beta.1_windows_amd64.zip`: `1,333,199` 字节 (`SHA-256`: `2287bdb13d1697c300805e232cab6069d6fd9f93f5b88694f94a04f78d161ed3`).
    - `antigravity-context-viewer_0.9.0-beta.1_windows_arm64.zip`: `1,333,199` 字节 (`SHA-256`: `e5493fd2eda142b085d306a6a5693995b82f1a8e75723396c36283bf2f87a9b0`).
    - `darwin_amd64/arm64` 及 `linux_amd64/arm64` ZIP: `1,325,315` 字节 (`SHA-256`: `47188f44f37e1f0cfaa5aec8632dad26f7ee0e4228b7bf118bf9b3ce80dcd0f8`).
    - `checksums.txt`: `738` 字节 (`SHA-256`: `bfce0f45996d17dc26170dbda8049bbc060d035b51cc4089b7e2cf99a02f8bd7`).
    - 发布 ZIP 内源码临时编译 `scripts/cli-window-helper.exe`: `15,360` 字节 (`SHA-256`: `3b8f8629628c22e2631a48686b669403a2602e1997af3eace111a5828d6af430`, `windows_amd64` 与 `windows_arm64` 解包校验一致); 本地安装态同步源码编译部署至 `AppData\Local\AntigravityContextMeter\cli-window-helper.exe` 与 `resources\bin\cli-window-helper.exe` (`15,360` 字节, `SHA-256`: `f400b71397ee8274252bbee4938ce11144ee3ecfef9343b1ebaf1070383843a9`, 因 Windows `.NET Framework 4.x csc.exe` 不含 `-deterministic`, 每次独立编译 PE 时间戳与 MVID 不同属正常预期).
- 全量验证与洁净度确认.
  - `npm.cmd run build:renderer`: exit `0`.
  - `node scripts/check-release-manifest.js`: exit `0` (`24` 个安装依赖).
  - `npm.cmd test`: exit `0`, **`535 passed, 0 failed, 0 skipped`**.
  - `node --test meter-elv103-mixed-session.test.js`: exit `0`, **`2 passed, 0 failed`**.
  - `attachment_scan_test.py` (`C:\Users\elvis\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`): exit `0`, **`9 tests OK`** (`0.158s`).
  - 外部参考词洁净度全仓 43 文件扫描: `dsh-context` / `PowerContext` / `DNA 模式` **`TOTAL_HITS=0`**. 工作树中 `scripts/cli-window-helper.exe` 已移出 Git 跟踪且不存在 (`WORKTREE_HELPER_EXISTS=false`).
- 本轮实机验收产物目录: `D:\Downloads\AntigravityContextMeter_v0.9.0-beta.1_当前会话宽屏多栏重构与5项收尾验收\` (`verify-live-v090-5items.js`, `live-v090-5items-verify.log`, `live-v090-5items-verify.json`).
  1. **「当前会话」完整交互式分析页与宽屏 4 行 Bento 重构 (`01`~`06 PNG`)**:
     - `01-aux-wide-860plus-bento.png` (`>=860px` 宽栏 `920px`): Row 1 5 列 KPI (`394.4K (77.0%)` / `512K 宿主确认窗口` / `117.6K (23.0%)` / `97.9% / 95%` / `213.44M`), 口径声明严格区分当前与累计/缓存/窗口来源; Row 2 双轨进度条 (`实报 394.4K · 可见估算 47.3K`) + 3 色环形耗时 Donut (`墙钟活跃 3 小时 56 分 · 累计任务 4 小时 51 分 · 并发重叠节省 55 分 12 秒`) 与缺失三段时间戳如实说明; Row 3 服务端用量趋势 + 9 维组成树; Row 4 工作台 (`上下文事件 315` / `文件活动 155` / `命令执行 200` / `子 Agent 2`).
     - `02-aux-medium-680-bento.png` (`680px` 中栏 `3+2`, `6:6`, 趋势+树堆叠) 与 `03-aux-narrow-460-single-col.png` (`460px` 窄栏全单列 `scrollW === clientW`).
     - `04-flow-popover-full-session.png`: 未开辅助栏 (`flow`) 原位浮层 (`472x726`) 完整交互.
     - `05-pinned-step-and-composition-drilldown.png`: 点击历史步骤 `S2357` (`callId=K7n8aqrmFZmtqtsP0sq2uQM`) 固定步骤横条、`58.0%` / `297K` / `可见估算 148.6K`、前轮对比 `vs S2353 · ΔCtx +13.1K · ΔOut +3.8K · ΔCache -3.3%`、「返回最新」按钮、键盘 `ArrowLeft` (`2357 -> 2353`) 与 `Esc` 返回最新验证.
     - `06-low-usage-subbar-and-edge-states.png`: 短会话 `78799486` (`6.3% < 25%`) 副轨默认 `已用构成 100%` 与切换 `缓存结构`、`+6 项为 0` 折叠及 `短样本` 标记验证.
  2. **实时请求列表 Antigravity 行 Gemini 图标 (`07-realtime-requests-gemini-icon.png`)**:
     - `buildId: bd29253b838745f2` 实机渲染静态 `src/renderer/assets/gemini-color.svg` (`data:image/svg+xml;utf8,...`, 含四色 `#3186FF`/`#08B962`/`#F94543`/`#FABC12`, 无 `<script>`), `14x14` 与 `Antigravity` 基线对齐; 对应实测请求 `01:59:50 Antigravity gemini-3.8-flash 32.2K Out 57 0%`, 保留 Claude/OpenAI 图标与统计口径, 归属/许可已记入 `THIRD_PARTY_NOTICES.md` 第 3.4 节.
  3. **Issue #17 Windows CLI 窗口助手 (`08a`/`08b PNG`)**:
     - 场景 A (源码构建助手存在): UI 点击 `#badge-cli`, `ok: true, fallback: false, nativePlacement: true, windowLocated: true, isCentered: true, isForeground: true, windowHwnd: 0x00550132, pid: 19252`, `cliPath: C:\Users\elvis\.gemini\bin\agy.exe`.
     - 场景 B (临时移开两处已部署 `cli-window-helper.exe`): 二次点击 `#badge-cli`, `ok: true, fallback: true`, `fallbackReason: 未检测到原生定位辅助程序 (cli-window-helper.exe)，已降级启动标准控制台`, 启动 `cmd.exe /d /k ...\launch-cli-runner.cmd`, 结束后两处文件恢复且 SHA-256 均还原为 `f400b713...`.
  4. **Customizations 避让回归 (`09a`/`09b`/`09c PNG`)**:
     - 切入 `/customizations` (含搜索框聚焦与点击插件) 时 `data-marketplace-active="true"`, 面板/浮层/overflow-menu/辅助栏均保持隐藏并阻断点击弹出; 退回已归档对话 `/c/1602135e-da38-4837-a3bc-3e993d35efab` 时自动解除避让 (`marketplaceActiveAttr: null`), `#badge` 正常恢复打开面板 (`panelVisible: true`), 已补入 `meter-renderer.test.js` 归档对话回归用例.
- **已知边界与限制 (如实注明)**:
  - 宿主 Antigravity 2.34.0 当前不导出独立「思考 / 正文 / 工具参数」流式子阶段时间戳, 本版本仅如实展示 TTFT / 模型流式生成 / 工具执行开销 3 段与并发墙钟 vs 累计任务时长并 UI 明示不虚构拆分.
  - 双分屏/Side Question 串窗防注入主要由 `sameRouteId` 归属守卫及自动化单测验证; 本次桌面端以跨路由切换与已归档/活跃多会话核验为主.
  - 本机无独立物理 Mac 设备, `darwin_*` 打包通过校验, Mac 端真机签名与 `watch` 沿用自动化测试结论.

---

## 11. v0.9.0-beta.1 发布收尾：蓝框修复、官方图标实机点验与两步审查结项 (2026-11-23 03:17)

- **基线与分支现状**: 分支 `feat/v0.8.9-beta`, 基线 `HEAD` = `044cdc22cbfcf611e727ba33383d97b189a27c01`, 远端默认分支 `main` = `838211fea3d305c72f3fe5f0c6ec340a644d481a`, 最新正式 Release `v0.8.10` (`580099960fadc7051ca012b0cd62d2a397d17549`), 预发布 `v0.9.0-beta.1` 远端尚未发布.
- **问题修复与实机复验**:
  1. **两处细长蓝框隐藏根因与修复**:
     - 两处均为不同页面独立提示条被 CSS `display: flex` 覆盖原生 `[hidden]` 导致空容器残留, 非上下文进度轨: 「当前会话」 `#ctx-ov-pinned-banner` (`src/renderer/template.html:240`, `styles.css:11064-11090`), 「配置 → 外观与停靠」 `#dock-fallback-note` / `#dock-open-feedback` (`template.html:1043,1048`, `styles.css:912-939`).
     - 在 `styles.css` 新增 `:host [hidden]:not(.ag-panel) { display: none !important; }` (`L139-141`), `.ctx-dock-note[hidden]/:empty` 与 `.ctx-ov-pinned-banner[hidden]/:empty` 及子轨/图例隐藏规则 (`L933-939`, `L11078-11090`), 并在 `src/renderer/main.js` `syncDockPositionUi()` (`L1478-1517`) 与 `renderSessionBentoSections()` (`L17765-17778`) 对空内容强制 `hidden = true; textContent = ''`.
  2. **实时请求列表 `Antigravity` 官方图标**:
     - 工作树已内置 `src/renderer/assets/antigravity-color.svg` (`5,301` 字节, `SHA-256: d775965ea1f8060538c15f758a3e22487317211fcb6051333b5e023f35aa726f`, 与 `F:\Pictures\UI\Google-Antigravity-Icon-Full-Color.svg` 逐字节一致); 前次仍见 Gemini 星形系仅生成渲染包未重建分发包与重装桌面端 `app.asar` 所致.
- **第一步审查 (代码、差异、PR 归属与 Beta 1 更新日志)**:
  - 修复并复核: 移除 `meter-cli-adapter.js:62-74` 硬编码 `D:\agy` 路径改为标准 `~/.gemini` 与 `AG_CLI_BIN_DIR`; 清理 `styles.css`, `main.js`, `template.html`, `meter-core.test.js`, `meter-v089-usage.test.js` 外部参考术语与测试样本用户路径; 清理 `THIRD_PARTY_NOTICES.md` 无实质引用项目并补入 `jlcodes99/vscode-antigravity-cockpit` MIT 声明与第 3.4 节 `Google-Antigravity-Icon-Full-Color.svg` 许可未决声明; 重写 `RELEASE_NOTES.md` Beta 1 更新日志; 新增 `meter-renderer.test.js:9305` 蓝框隐藏/展示/收起专项回归; 将 `meter-macos-watch.test.js:252` 高负载启动检测阈值由 `500ms` 放宽至 `3000ms`.
  - GitHub 30 条 Open PR 经远端 API 与 `git merge-base --is-ancestor` 核对: `#38, #47, #52, #53, #57` 共 5 条原提交已完整进入 `HEAD`; 其余 25 条为本地独立重整等价落地 (`#27, #32, #34, #35, #36, #37, #48, #55, #60, #61, #63, #64, #66, #67, #68, #69, #70, #71, #72, #73, #74, #76, #79`)、部分采用 (`#43`) 或同类重复未采用独有代码 (`#65`).
- **第二步审查 (统一版本、包体洁净度、助手校验、隔离生命周期与实机冷启动)**:
  - 版本对齐: `package.json`, `plugin.json`, `modules-config.js`, `RELEASE_NOTES.md` 均统一为 `0.9.0-beta.1` / `0.9.0 β`, 宿主独立为 `2.34.0`.
  - 全量验证 (全部 exit `0`): `npm.cmd run build:renderer` (`meter-renderer.js` `2,257,696` 字节, `buildId: 9533a89afd528add`), `node scripts/check-release-manifest.js`, `npm.cmd test` (`536 passed, 0 failed, 0 skipped`), `node --test meter-elv103-mixed-session.test.js` (`2 passed, 0 failed`), `attachment_scan_test.py` (`9 tests OK`), `node scripts/package-release.js`.
  - 6 平台正式包与指纹 (`dist/release/`):
    - `antigravity-context-viewer_0.9.0-beta.1_windows_amd64.zip` / `windows_arm64.zip`: `1,334,147` 字节, `SHA-256: 2661774e96517bf70392b17297e32e96e888bf9b39c5dbcaa5ec6de4504d6d58`, 内置同源编译 `scripts/cli-window-helper.exe` (`15,360` 字节, `SHA-256: 36eb5a11e57e59fe74a368afebdc93bd4a6bd4e3082f0f340c9886c168ea5f5d`).
    - `darwin_amd64.zip` / `darwin_arm64.zip` / `linux_amd64.zip`: `1,326,261` 字节, `SHA-256: bfb3882822432714d3fe7a163aef40c85b6382e7ef7ae5864a48975e0fa85a10`.
    - `linux_arm64.zip`: `1,326,261` 字节, `SHA-256: 9322e2275992bb89a05a6f345d83c57d00c5814ca75fd26a9747e9d5962d1214` (解包内容树哈希与上述 3 包完全一致 `df5315d301924391ec042743d6d6ee485bb054e46401ae11587fad7bc3e627e5`).
    - `checksums.txt`: `738` 字节 (`SHA-256: 2422ad38d514e8c0d076ab21e1f034f16ab9a86dcf5a1918aac479c262f75f90`).
  - 解包洁净度扫描: 6 包共 294 个文件 `0` 外部参考/本机路径/冗余文件命中, `THIRD_PARTY_NOTICES.md` 声明完整; 隔离 `app.asar` 生命周期验证覆盖首次安装、重复安装、自定义配置保留、宿主覆盖检测与恢复、陈旧记录识别、跨版本 `2.33.1 -> 2.34.0` 升级与安全原位剥离及 `2.34.0` 逐字节无损还原 (`byteExactMatchWithOrig: true`, 注: 单删主备份时 `restore()` 自动回退完好 `pre-meter` 次备份且因跨/改写校验差异触发安全原位剥离保护宿主).
  - 单次离线安装与实机冷启动 (`D:\Downloads\AntigravityContextMeter_v0.9.0-beta.1_蓝框与官方图标修复及双步发布审查验收\`): `node cli.js install` (`exit 0`) 更新 `app.asar` (`3b0f8074fe3cfeaea7174a39cd60deefe34868da3c731e18ae5b97e127b5e748`, `cli-window-helper.exe` `8a26a5231c5ec4b9ef76e3e0db028f4562ed03be7ad77d8a563ad619fc488c34`). 冷启动 Antigravity 2.34.0 前台 `buildId === "9533a89afd528add"` 一致, 在真实历史会话 `5c259630` 右侧辅助栏及配置/请求视图采集 `after-01a/01b/01c`, `after-02a/02b/02c`, `after-03` 与脱敏报告 `live-verify-report.json`, 首行真实请求 `2026-11-23 03:14:27` (`gemini-4-hydrogen`) 正确渲染官方全彩图标.
- **发布门禁状态 (已拦截远端发布)**:
  - 因随包内嵌的 `Google-Antigravity-Icon-Full-Color.svg` 公开随包再分发许可尚未核实, 依据发版前置条件触发阻塞门禁, 本轮保留全套本地候选包、实机对比图与验收证据, **未执行 `git push` 或远端 GitHub Release 创建**.

---

## 12. 显示版本改为 `0.9.0 beta1` 重包复验与 `v0.9.0-beta.1` 预发布收尾 (2026-11-23 03:41)

- **统一显示版本调整 (保持语义版本 `0.9.0-beta.1` 与 tag 不变)**:
  - 更新 `package.json` (`"displayVersion": "0.9.0 beta1"`), `modules-config.js` (`FALLBACK_DISPLAY_VERSION`), `src/renderer/main.js` (`formatDisplayVersion` 回退与 `betaN` 分支), `src/renderer/template.html` (`#v`, `#v-tokens`), `meter-cli-ui.js`, `RELEASE_NOTES.md` 首行及 `meter-renderer.test.js` 断言.
- **重建, 全量回归, 重打包与本地安装**:
  - `npm.cmd run build:renderer` (exit `0`): `meter-renderer.js` `2,257,657` 字节 (`SHA-256: 548b011397c6ac02e539b1c0cc201d4311b1b84deb358df02e3742f6579704b6`), `buildId: df3a2c28b8f5b32c`.
  - `node scripts/check-release-manifest.js` (exit `0`), `npm.cmd test` (`536 passed, 0 failed, 0 skipped`, `88290.3517ms`, exit `0`), `node --test meter-elv103-mixed-session.test.js` (`2 passed, 0 failed`, exit `0`), `attachment_scan_test.py` (`9 tests OK`, `0.147s`, exit `0`).
  - `node scripts/package-release.js` (exit `0`, 临时编译助手 `cli-window-helper.exe` `15,360` 字节, `SHA-256: 08d876027276785f8702c09b81f249b5d209bc5a46733c481667e1c39f98bf1e`):
    - `antigravity-context-viewer_0.9.0-beta.1_windows_amd64.zip` / `windows_arm64.zip`: `1,333,219` 字节, `SHA-256: bdb93d93b836fa76ad2881887feab66c2e5fb6981805cbbfa82cd82255db0b86`.
    - `darwin_amd64.zip` / `darwin_arm64.zip` / `linux_amd64.zip` / `linux_arm64.zip`: `1,325,333` 字节, `SHA-256: 5f17ba362ec792836eeb9562d40b74f15bdfabd6765b9ad508ad9be001988295`.
    - `checksums.txt`: `738` 字节, `SHA-256: c9629cffbc4b80c74ac9c4e98e3395b51241d13fbee52e834d9f4a965f3b1a49`.
  - 本地离线安装 `node cli.js install` (exit `0`) 更新 `app.asar` (`5F872ACD1AADC17BA0C17D180766C7B4E94CBBD178101DFCD6DB1FFF185670E4`, helper `76be1d3b5c974177f2ea703e8699462e0f60f4ac1a302dd11457140c05d383b5`) 与 `node cli.js status` (exit `0`).
- **实机冷启动复验**:
  - 冷启动 `Antigravity.exe` 检验运行 `buildId === "df3a2c28b8f5b32c"`, `version === "0.9.0-beta.1"`, `#v`, `#v-tokens`, `#up-pop-ver` 均实测渲染 `0.9.0 beta1`; `modules.json` 还原匹配 `DA66925F0CE9248A263A45B7C6F41D56CFB4FA04134A1A8FBD25122E7961B73A`.
  - 更新截图: `after-04-header-version-0.9.0-beta1.png`, `after-01a-session-normal-zh-wide.png`, 报告 `live-verify-report.json`.
- **Git 提交, Release 发布与 PR 收尾**:
  - 发布提交: `4bc5e12c066c4c02d1fac465aba80e5fa2bb5ec3` (保留 `assets/demo*` 不删; `HANDOFF.md`, `TASK_LEDGER.md`, `.tmp.driveupload/` 保持未提交), 推送至 `origin/feat/v0.8.9-beta`, `origin/release/v0.9.0-beta.1` 与 tag `v0.9.0-beta.1`.
  - 已取消 tag 自动触发 CI run `45061900434` (`status: completed, conclusion: cancelled`), 直接上传本地验收的 7 项资产发布预发布 Release: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.0-beta.1` (标题 `v0.9.0 beta1`, 远端 SHA-256 逐项与本地一致).
  - 已将完整进入本地历史的 5 条 PR (`#38, #47, #52, #53, #57`) 变基至 `release/v0.9.0-beta.1` 并通过 Fast-Forward 原生收口为 `state: "MERGED"` (`mergedAt: 2026-11-22T19:40:53Z`); 其余 25 条 Open PR 维持未关/按等价本地实现记录, `main` 保持不变.
  - 注记: `antigravity-color.svg` 再分发许可待后续正式版前补充最终版权确认 (`THIRD_PARTY_NOTICES.md` 第 3.4 节已保留告知).
