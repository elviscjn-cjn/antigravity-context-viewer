// =========================================================================
// 模块 3B: 上下文解剖台 · 独立五行业务全视角视图 (renderContextInspectorInto) + 兼容旧驾驶舱组件
// =========================================================================

const INSPECTOR_SOURCE_LABEL_KEYS = {
  builtin: 'session.inspector.sourceBuiltin',
  mcp: 'session.inspector.sourceMcp',
  skill: 'session.inspector.sourceSkill'
};

let inspectorCopyResetTimer = null;

const OM_CTX_STYLE_ID = 'ag-om-context-inspector-view-style';

const OM_CTX_CAT_META = [
  { key: 'system', color: '#3B82F6' },
  { key: 'tools', color: '#F59E0B' },
  { key: 'user', color: '#10B981' },
  { key: 'injection', color: '#14B8A6' },
  { key: 'skills', color: '#F97316' },
  { key: 'assistant', color: 'var(--ag-host-accent, var(--primary, #3274f6))' },
  { key: 'toolResults', color: '#06B6D4' }
];

const OM_CTX_I18N = {
  'zh-CN': {
    overviewTitle: '上下文统计',
    turns: '轮次',
    steps: '步数',
    skillsLoaded: '技能加载',
    modelReplies: '模型回复',
    ctxEvents: '上下文事件',
    evInject: '注入',
    evWrite: '写入',
    evCompact: '压缩',
    evRefresh: '刷新',
    ioTitle: '输入输出',
    ioUser: '用户',
    ioModel: '模型',
    ioBlocks: '内容块',
    toolsTitle: '工具调用',
    commandsTitle: '命令执行',
    othersLabel: '其它',
    mainAgent: '当前 Agent',
    subAgent: '子 Agent',
    pluginInfoTitle: '插件信息',
    pluginVersion: '版本',
    pluginBudget: '模型与预算',
    openBudget: '预算设置',
    openSettings: '打开插件设置',
    tokenStatsTitle: 'Token 统计',
    totalUsage: '总用量',
    cacheHit: '缓存命中',
    latencyStatsTitle: '耗时统计',
    activeTime: '活跃时长',
    outputSpeed: '输出速度',
    latWait: '模型等待',
    latGen: '模型输出',
    latTool: '工具执行',
    latUnavailable: '暂无可采集耗时明细',
    currentCtxTitle: '当前上下文',
    usedLabel: '上下文已用',
    timelineTitle: '上下文时间线',
    byStep: '按步',
    byTurn: '按轮',
    modeTotal: '总量',
    modeDelta: '增量',
    stepDetailTitle: '第 {turn} 轮 · 第 {step} 步',
    actualCtx: '实际上下文',
    outputTok: '输出',
    timestamp: '时间戳',
    userSummary: '用户输入',
    replySummary: '回复摘要',
    browserTitle: '上下文浏览器',
    currentReq: '当前请求构成',
    estTotal: '估算合计',
    actualTotal: '实际总量',
    itemsSuffix: '项',
    eventsCardTitle: '上下文事件',
    filesCardTitle: '文件活动',
    filesSuffix: '个文件',
    filterAll: '全部',
    filterRead: '读取',
    filterWrite: '写入',
    filterSearch: '搜索',
    cmdCardTitle: '命令执行',
    cmdRuns: '执行次数',
    cmdTotalDur: '合计耗时',
    cmdFailed: '失败',
    cmdBackground: '后台',
    cmdPrograms: '高频程序',
    cmdSearchPlaceholder: '过滤命令或程序',
    cmdFilterFailed: '失败',
    cmdFilterSlow: '慢命令',
    cmdFilterBg: '后台',
    emptySection: '暂无记录',
    cats: {
      system: '系统提示词',
      tools: '工具定义',
      user: '用户消息',
      injection: '注入内容',
      skills: '技能注入',
      assistant: '助手消息',
      toolResults: '工具结果'
    }
  },
  'zh-TW': {
    overviewTitle: '上下文統計',
    turns: '輪次',
    steps: '步數',
    skillsLoaded: '技能載入',
    modelReplies: '模型回覆',
    ctxEvents: '上下文事件',
    evInject: '注入',
    evWrite: '寫入',
    evCompact: '壓縮',
    evRefresh: '重新整理',
    ioTitle: '輸入輸出',
    ioUser: '使用者',
    ioModel: '模型',
    ioBlocks: '內容區塊',
    toolsTitle: '工具呼叫',
    commandsTitle: '命令執行',
    othersLabel: '其他',
    mainAgent: '目前 Agent',
    subAgent: '子 Agent',
    pluginInfoTitle: '外掛資訊',
    pluginVersion: '版本',
    pluginBudget: '模型與預算',
    openBudget: '預算設定',
    openSettings: '開啟外掛設定',
    tokenStatsTitle: 'Token 統計',
    totalUsage: '總用量',
    cacheHit: '快取命中',
    latencyStatsTitle: '耗時統計',
    activeTime: '活躍時長',
    outputSpeed: '輸出速度',
    latWait: '模型等待',
    latGen: '模型輸出',
    latTool: '工具執行',
    latUnavailable: '暫無可採集耗時明細',
    currentCtxTitle: '目前上下文',
    usedLabel: '上下文已用',
    timelineTitle: '上下文時間線',
    byStep: '按步',
    byTurn: '按輪',
    modeTotal: '總量',
    modeDelta: '增量',
    stepDetailTitle: '第 {turn} 輪 · 第 {step} 步',
    actualCtx: '實際上下文',
    outputTok: '輸出',
    timestamp: '時間戳',
    userSummary: '使用者輸入',
    replySummary: '回覆摘要',
    browserTitle: '上下文瀏覽器',
    currentReq: '目前請求構成',
    estTotal: '估算合計',
    actualTotal: '實際總量',
    itemsSuffix: '項',
    eventsCardTitle: '上下文事件',
    filesCardTitle: '檔案活動',
    filesSuffix: '個檔案',
    filterAll: '全部',
    filterRead: '讀取',
    filterWrite: '寫入',
    filterSearch: '搜尋',
    cmdCardTitle: '命令執行',
    cmdRuns: '執行次數',
    cmdTotalDur: '合計耗時',
    cmdFailed: '失敗',
    cmdBackground: '背景',
    cmdPrograms: '高頻程式',
    cmdSearchPlaceholder: '過濾命令或程式',
    cmdFilterFailed: '失敗',
    cmdFilterSlow: '慢命令',
    cmdFilterBg: '背景',
    emptySection: '暫無記錄',
    cats: {
      system: '系統提示詞',
      tools: '工具定義',
      user: '使用者訊息',
      injection: '注入內容',
      skills: '技能注入',
      assistant: '助手訊息',
      toolResults: '工具結果'
    }
  },
  en: {
    overviewTitle: 'Context Summary',
    turns: 'Turns',
    steps: 'Steps',
    skillsLoaded: 'Skills Loaded',
    modelReplies: 'Model Replies',
    ctxEvents: 'Context Events',
    evInject: 'Inject',
    evWrite: 'Write',
    evCompact: 'Compact',
    evRefresh: 'Refresh',
    ioTitle: 'Input Output',
    ioUser: 'User',
    ioModel: 'Model',
    ioBlocks: 'Blocks',
    toolsTitle: 'Tool Calls',
    commandsTitle: 'Commands',
    othersLabel: 'Others',
    mainAgent: 'Main Agent',
    subAgent: 'Sub Agent',
    pluginInfoTitle: 'Plugin Info',
    pluginVersion: 'Version',
    pluginBudget: 'Model Budget',
    openBudget: 'Budget',
    openSettings: 'Open Settings',
    tokenStatsTitle: 'Token Breakdown',
    totalUsage: 'Total',
    cacheHit: 'Cache Hit',
    latencyStatsTitle: 'Latency Stats',
    activeTime: 'Active Time',
    outputSpeed: 'Speed',
    latWait: 'Model Wait',
    latGen: 'Model Output',
    latTool: 'Tool Exec',
    latUnavailable: 'No exported latency breakdown',
    currentCtxTitle: 'Current Context',
    usedLabel: 'Context Used',
    timelineTitle: 'Context Timeline',
    byStep: 'Step',
    byTurn: 'Turn',
    modeTotal: 'Total',
    modeDelta: 'Delta',
    stepDetailTitle: 'Turn {turn} · Step {step}',
    actualCtx: 'Actual Context',
    outputTok: 'Output',
    timestamp: 'Time',
    userSummary: 'User Input',
    replySummary: 'Reply Summary',
    browserTitle: 'Context Browser',
    currentReq: 'Current Request Mix',
    estTotal: 'Estimated',
    actualTotal: 'Actual',
    itemsSuffix: 'items',
    eventsCardTitle: 'Context Events',
    filesCardTitle: 'File Activity',
    filesSuffix: 'files',
    filterAll: 'All',
    filterRead: 'Read',
    filterWrite: 'Write',
    filterSearch: 'Search',
    cmdCardTitle: 'Command Executions',
    cmdRuns: 'Runs',
    cmdTotalDur: 'Total Duration',
    cmdFailed: 'Failed',
    cmdBackground: 'Background',
    cmdPrograms: 'Top Programs',
    cmdSearchPlaceholder: 'Filter commands or programs',
    cmdFilterFailed: 'Failed',
    cmdFilterSlow: 'Slow',
    cmdFilterBg: 'Background',
    emptySection: 'No records yet',
    cats: {
      system: 'System Prompt',
      tools: 'Tool Definitions',
      user: 'User Messages',
      injection: 'Injected Content',
      skills: 'Skill Injections',
      assistant: 'Assistant Replies',
      toolResults: 'Tool Results'
    }
  }
};

function omCtxResolveLang(lang) {
  const raw = String(lang || (typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : 'zh-CN') || 'zh-CN').toLowerCase();
  if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('en')) return 'en';
  return 'zh-CN';
}

function omCtxShort(n) {
  if (typeof short === 'function') return short(n);
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function omCtxDur(sec) {
  const v = Number(sec || 0);
  if (!Number.isFinite(v) || v <= 0) return '0s';
  if (v < 1) return `${Math.round(v * 1000)}ms`;
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)}s`;
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function omCtxClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 946684800000) return '--:--:--';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function omCtxEnsureStyles(containerEl) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const root = typeof containerEl.getRootNode === 'function' ? containerEl.getRootNode() : doc;
  const target = root && root.nodeType === 11 ? root : (doc.head || containerEl);
  if (!target || target.querySelector?.(`#${OM_CTX_STYLE_ID}`)) return;
  const st = doc.createElement('style');
  st.id = OM_CTX_STYLE_ID;
  st.setAttribute('data-om-view-style', 'context');
  st.textContent = `
    .om-ctx-scroll {
      --om-accent: var(--ag-host-accent, var(--primary, #3274f6));
      --om-bg: var(--background, #141416);
      --om-card: var(--card, rgba(255, 255, 255, 0.035));
      --om-surface: rgba(148, 163, 184, 0.06);
      --om-border: var(--border, rgba(148, 163, 184, 0.18));
      --om-text: var(--foreground, #ececef);
      --om-muted: var(--muted-foreground, #94a3b8);
      height: 100%;
      width: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      box-sizing: border-box;
      padding: 12px 14px 28px;
      background: var(--om-bg);
      color: var(--om-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
      font-size: 12px;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .om-ctx-row {
      display: grid;
      gap: 12px;
      width: 100%;
      min-width: 0;
    }
    .om-ctx-row-1 {
      grid-template-columns: minmax(0, 1fr) 260px;
    }
    .om-ctx-row-2,
    .om-ctx-row-3,
    .om-ctx-row-4 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .om-ctx-row-5 {
      grid-template-columns: minmax(0, 1fr);
    }
    @media (max-width: 920px) {
      .om-ctx-row-1,
      .om-ctx-row-2,
      .om-ctx-row-3,
      .om-ctx-row-4 {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .om-ctx-card {
      background: var(--om-card);
      border: 1px solid var(--om-border);
      border-radius: 10px;
      padding: 12px 14px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .om-ctx-card-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .om-ctx-card-title {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--om-text);
    }
    .om-ctx-subtle {
      font-size: 11px;
      color: var(--om-muted);
      font-variant-numeric: tabular-nums;
    }
    .om-ctx-kpi-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(180px, 1.4fr);
      gap: 8px;
    }
    @media (max-width: 780px) {
      .om-ctx-kpi-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .om-ctx-kpi-box {
      background: var(--om-surface);
      border: 1px solid var(--om-border);
      border-radius: 8px;
      padding: 8px 10px;
      min-width: 0;
    }
    .om-ctx-kpi-num {
      font-size: 17px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--om-text);
      line-height: 1.2;
    }
    .om-ctx-kpi-lbl {
      font-size: 10.5px;
      color: var(--om-muted);
      margin-top: 2px;
    }
    .om-ctx-ev-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .om-ctx-meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      padding-top: 6px;
      border-top: 1px solid rgba(148, 163, 184, 0.12);
    }
    .om-ctx-chip-list {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .om-ctx-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--om-surface);
      border: 1px solid var(--om-border);
      font-size: 11px;
      color: var(--om-text);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .om-ctx-dot {
      width: 7px;
      height: 7px;
      border-radius: 2px;
      display: inline-block;
      flex-shrink: 0;
    }
    .om-ctx-info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      padding: 4px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }
    .om-ctx-info-row:last-of-type { border-bottom: none; }
    .om-ctx-btn {
      appearance: none;
      border: 1px solid var(--om-border);
      background: var(--om-surface);
      color: var(--om-text);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    .om-ctx-btn:hover {
      border-color: var(--om-accent);
      background: color-mix(in srgb, var(--om-accent) 14%, transparent);
    }
    .om-ctx-btn-primary {
      border-color: color-mix(in srgb, var(--om-accent) 48%, transparent);
      background: color-mix(in srgb, var(--om-accent) 18%, transparent);
    }
    .om-ctx-donut-layout {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .om-ctx-donut-svg {
      width: 82px;
      height: 82px;
      flex: 0 0 82px;
    }
    .om-ctx-legend-grid {
      flex: 1 1 auto;
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 12px;
    }
    .om-ctx-legend-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
    }
    .om-ctx-legend-left {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .om-ctx-segbar {
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      overflow: hidden;
      display: flex;
    }
    .om-ctx-seg {
      height: 100%;
      min-width: 2px;
    }
    .om-ctx-left-stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .om-ctx-seg-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 7px;
      border: 1px solid var(--om-border);
      background: var(--om-surface);
    }
    .om-ctx-seg-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--om-muted);
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .om-ctx-seg-btn.is-active {
      background: color-mix(in srgb, var(--om-accent) 20%, transparent);
      color: var(--om-text);
      font-weight: 600;
    }
    .om-ctx-timeline-chart {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 112px;
      padding: 8px 4px 2px;
      border-bottom: 1px solid var(--om-border);
      overflow-x: auto;
    }
    .om-ctx-tbar {
      flex: 1 0 10px;
      max-width: 24px;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      align-items: center;
      cursor: pointer;
      padding: 0 1px;
      border-radius: 3px;
    }
    .om-ctx-tbar.is-selected {
      background: color-mix(in srgb, var(--om-accent) 18%, transparent);
      outline: 1px solid color-mix(in srgb, var(--om-accent) 55%, transparent);
    }
    .om-ctx-tbar-stack {
      width: 100%;
      display: flex;
      flex-direction: column-reverse;
      border-radius: 2px 2px 0 0;
      overflow: hidden;
      min-height: 3px;
    }
    .om-ctx-tbar-lbl {
      font-size: 9px;
      color: var(--om-muted);
      margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .om-ctx-step-fields {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .om-ctx-step-box {
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--om-surface);
      font-size: 11.5px;
      color: var(--om-text);
      word-break: break-word;
    }
    .om-ctx-tree {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 410px;
      overflow-y: auto;
    }
    .om-ctx-tree-node {
      border: 1px solid var(--om-border);
      border-radius: 7px;
      overflow: hidden;
    }
    .om-ctx-tree-hdr {
      width: 100%;
      appearance: none;
      border: none;
      background: var(--om-surface);
      color: var(--om-text);
      padding: 7px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      font-size: 11.5px;
      text-align: left;
    }
    .om-ctx-tree-hdr:hover {
      background: rgba(148, 163, 184, 0.12);
    }
    .om-ctx-tree-body {
      padding: 6px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-top: 1px solid var(--om-border);
    }
    .om-ctx-tree-entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: var(--om-muted);
    }
    .om-ctx-tree-entry-txt {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--om-text);
    }
    .om-ctx-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 240px;
      overflow-y: auto;
    }
    .om-ctx-list-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 6px;
      background: var(--om-surface);
      font-size: 11.5px;
      min-width: 0;
    }
    .om-ctx-diff-add { color: #10B981; font-variant-numeric: tabular-nums; font-weight: 600; }
    .om-ctx-diff-del { color: #F43F5E; font-variant-numeric: tabular-nums; font-weight: 600; }
    .om-ctx-cmd-split {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 14px;
      min-width: 0;
    }
    @media (max-width: 860px) {
      .om-ctx-cmd-split { grid-template-columns: minmax(0, 1fr); }
    }
    .om-ctx-prog-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }
    .om-ctx-prog-track {
      flex: 1 1 auto;
      height: 6px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      overflow: hidden;
    }
    .om-ctx-prog-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--om-accent);
    }
    .om-ctx-cmd-table {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 260px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
    }
    .om-ctx-cmd-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: 5px;
      background: var(--om-surface);
      min-width: 0;
    }
    .om-ctx-cmd-text {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .om-ctx-input {
      height: 26px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--om-border);
      background: var(--om-surface);
      color: var(--om-text);
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
    }
    .om-ctx-input:focus { border-color: var(--om-accent); }
  `;
  target.appendChild(st);
}

function omCtxNormalizeCategoryKey(rawKey) {
  const k = String(rawKey || '').toLowerCase();
  if (k === 'system' || k === 'systemprompt') return 'system';
  if (k === 'tools' || k === 'tooldefs' || k === 'tooldefinitions') return 'tools';
  if (k === 'user' || k === 'usermessages') return 'user';
  if (k === 'injection' || k === 'injected') return 'injection';
  if (k === 'skills' || k === 'skill') return 'skills';
  if (k === 'toolresults' || k === 'tool_result' || k === 'toolcalls') return 'toolResults';
  return 'assistant';
}

function omCtxBuildSnapshot(data, opts = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const tl = src.timeline || src.tl || src;
  const breakdown = src.breakdown || tl?.breakdown || null;
  const latest = src.latest || tl?.latest || null;
  const turns = Array.isArray(tl?.turns) ? tl.turns : [];
  const allCalls = turns.length
    ? turns.flatMap((tr, tIdx) => (Array.isArray(tr?.calls) ? tr.calls.map(c => ({ ...c, _turnNum: tr.turnIndex || tIdx + 1, _turnPreview: tr.preview || '' })) : []))
    : (Array.isArray(src.calls) ? src.calls : []);
  const events = Array.isArray(tl?.contextChangeEvents) ? tl.contextChangeEvents : (Array.isArray(src.contextChangeEvents) ? src.contextChangeEvents : []);
  const files = Array.isArray(tl?.fileActivities) ? tl.fileActivities : (Array.isArray(src.fileActivities) ? src.fileActivities : []);
  const fileSummary = tl?.fileActivitySummary || src.fileActivitySummary || {
    uniqueFiles: files.length,
    totalAddedLines: files.reduce((s, f) => s + Number(f?.addedLines || 0), 0),
    totalRemovedLines: files.reduce((s, f) => s + Number(f?.removedLines || 0), 0),
    readCount: files.filter(f => Number(f?.readCount || 0) > 0).length,
    writeCount: files.filter(f => Number(f?.writeCount || 0) > 0).length,
    searchCount: files.filter(f => Number(f?.searchCount || 0) > 0).length
  };
  const commands = Array.isArray(tl?.commandExecutions) ? tl.commandExecutions : (Array.isArray(src.commandExecutions) ? src.commandExecutions : []);
  const cmdSummary = tl?.commandSummary || src.commandSummary || {
    totalCount: commands.length,
    failedCount: commands.filter(c => c?.status === 'failed' || c?.status === 'error').length,
    slowCount: commands.filter(c => Boolean(c?.isSlow)).length,
    backgroundCount: commands.filter(c => Boolean(c?.isBackground)).length,
    topPrograms: []
  };

  // Build 7-category map from breakdown or compositionFromSteps
  const catBuckets = {};
  for (const m of OM_CTX_CAT_META) {
    catBuckets[m.key] = { key: m.key, color: m.color, tokens: 0, count: 0, deltaTokens: 0, entries: [] };
  }
  const rawItems = Array.isArray(breakdown?.items) ? breakdown.items : [];
  for (const it of rawItems) {
    if (!it) continue;
    const nk = omCtxNormalizeCategoryKey(it.key);
    const b = catBuckets[nk];
    b.tokens += Math.max(0, Number(it.median ?? it.tokens ?? 0));
    b.count += Math.max(0, Number(it.count ?? (Array.isArray(it.entries) ? it.entries.length : 0)));
    if (it.deltaTokens != null && Number.isFinite(Number(it.deltaTokens))) {
      b.deltaTokens += Number(it.deltaTokens);
    }
    if (Array.isArray(it.entries)) b.entries.push(...it.entries);
  }
  const categories = OM_CTX_CAT_META.map(m => catBuckets[m.key]);
  const estimatedSum = categories.reduce((s, c) => s + c.tokens, 0);

  const usedTokens = Number(
    latest?.actual ?? latest?.postCompactEstimate ?? src.contextUsed ?? breakdown?.actualTotal ?? estimatedSum ?? 0
  );
  const budgetTokens = Number(
    latest?.budget ?? latest?.serviceLimit ?? src.contextBudget ?? 200000
  );

  // Event 4-type counts
  const evCounts = { inject: 0, write: 0, compact: 0, refresh: 0 };
  for (const ev of events) {
    const tp = String(ev?.type || '').toLowerCase();
    if (tp.includes('inject')) evCounts.inject++;
    else if (tp.includes('write') || tp.includes('prune')) evCounts.write++;
    else if (tp.includes('compact')) evCounts.compact++;
    else evCounts.refresh++;
  }

  // Tool call frequency from executionTrace nodes or breakdown
  const toolMap = new Map();
  const traceNodes = Array.isArray(tl?.executionTrace?.nodes) ? tl.executionTrace.nodes : [];
  for (const n of traceNodes) {
    if (n && (n.category === 'tool' || n.subKind === 'tool_call')) {
      const tn = String(n.label || 'tool').trim();
      toolMap.set(tn, (toolMap.get(tn) || 0) + 1);
    }
  }
  const topTools = Array.from(toolMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const progMap = new Map();
  for (const c of commands) {
    const p = String(c?.program || c?.command?.split?.(/\s+/)?.[0] || 'cmd').trim();
    if (p) progMap.set(p, (progMap.get(p) || 0) + 1);
  }
  const topPrograms = Array.isArray(cmdSummary.topPrograms) && cmdSummary.topPrograms.length
    ? cmdSummary.topPrograms.slice().sort((a, b) => b.count - a.count)
    : Array.from(progMap.entries()).map(([program, count]) => ({ program, count })).sort((a, b) => b.count - a.count);

  // Totals & cache & latency (real exportable dimensions only)
  const totals = tl?.sessionTokenTotals || {};
  const freshIn = Number(totals.freshInputTokens ?? totals.inputTokens ?? allCalls.reduce((s, c) => s + Number(c.inputTokens || 0), 0));
  const cacheRead = Number(totals.cacheReadTokens ?? allCalls.reduce((s, c) => s + Number(c.cacheReadTokens || 0), 0));
  const outputTok = Number(totals.outputTokens ?? allCalls.reduce((s, c) => s + Number(c.outputTokens || 0), 0));
  const totalTok = Math.max(Number(totals.totalTokens || 0), freshIn + cacheRead + outputTok, estimatedSum);
  const cacheHitPct = (freshIn + cacheRead) > 0
    ? Math.round((cacheRead / (freshIn + cacheRead)) * 1000) / 10
    : (latest?.cacheHitPct != null ? Number(latest.cacheHitPct) : null);

  let waitSec = 0;
  let genSec = 0;
  let toolSec = 0;
  let tpsSum = 0;
  let tpsCnt = 0;
  for (const c of allCalls) {
    const ttft = Number(c?.ttftSec || 0);
    const dur = Number(c?.durationSec || 0);
    const stream = Number(c?.streamingSec || (dur > ttft ? dur - ttft : 0));
    if (ttft > 0) waitSec += ttft;
    if (stream > 0) genSec += stream;
    const tps = Number(c?.streamingTps ?? c?.tps ?? 0);
    if (tps > 0) { tpsSum += tps; tpsCnt++; }
  }
  for (const n of traceNodes) {
    if (n?.category === 'tool' && Number(n.durationSec || 0) > 0) {
      toolSec += Number(n.durationSec || 0);
    }
  }
  const avgTps = tpsCnt > 0 ? Math.round((tpsSum / tpsCnt) * 10) / 10 : (Number(latest?.streamingTps ?? latest?.tps ?? 0) || null);

  // Build timeline step points
  const stepPoints = allCalls.map((c, idx) => {
    const prevActual = idx > 0 ? Number(allCalls[idx - 1]?.totalInputTokens ?? allCalls[idx - 1]?.inputTokens ?? 0) : 0;
    const curActual = Number(c.totalInputTokens ?? ((Number(c.inputTokens || 0) + Number(c.cacheReadTokens || 0)) || c.totalTokens || 0));
    const stepCacheDenom = Number(c.inputTokens || 0) + Number(c.cacheReadTokens || 0);
    return {
      idx,
      turnIndex: Number(c._turnNum || c.turnIndex || 1),
      stepIndex: c.stepIndex != null ? Number(c.stepIndex) : idx + 1,
      actualTokens: curActual,
      deltaTokens: curActual - prevActual,
      outputTokens: Number(c.outputTokens || 0),
      cacheHitPct: stepCacheDenom > 0 ? Math.round((Number(c.cacheReadTokens || 0) / stepCacheDenom) * 1000) / 10 : null,
      timestamp: c.timestamp || null,
      userSummary: String(c._turnPreview || turns.find(tr => tr.turnIndex === c._turnNum)?.preview || ''),
      replySummary: String(c.responsePreview || c.summary || c.modelLabel || ''),
      inputTokens: Number(c.inputTokens || 0),
      cacheReadTokens: Number(c.cacheReadTokens || 0)
    };
  });

  const subagentCount = Array.isArray(tl?.agentCollabHub?.subagents)
    ? tl.agentCollabHub.subagents.length
    : (Array.isArray(tl?.agentFleetSummary?.subagents) ? tl.agentFleetSummary.subagents.length : 0);

  return {
    turnsCount: turns.length || (stepPoints.length ? Math.max(...stepPoints.map(p => p.turnIndex)) : 0),
    stepsCount: stepPoints.length || traceNodes.length,
    skillsCount: catBuckets.skills.count,
    repliesCount: allCalls.length,
    userMsgCount: catBuckets.user.count || turns.length,
    modelBlocksCount: catBuckets.assistant.count || allCalls.length,
    evCounts,
    topTools,
    totalToolCalls: topTools.reduce((s, x) => s + x.count, 0),
    topPrograms,
    totalCommands: commands.length,
    subagentCount,
    version: String(opts.version || src.version || (typeof METER_DISPLAY_VERSION !== 'undefined' ? METER_DISPLAY_VERSION : '0.9.3')),
    modelLabel: String(opts.modelLabel || src.modelLabel || latest?.modelLabel || allCalls[allCalls.length - 1]?.modelLabel || '—'),
    usedTokens,
    budgetTokens,
    estimatedSum,
    categories,
    totalTok,
    freshIn,
    cacheRead,
    outputTok,
    cacheHitPct,
    waitSec,
    genSec,
    toolSec,
    avgTps,
    stepPoints,
    events,
    files,
    fileSummary,
    commands,
    cmdSummary
  };
}

function omCtxBuildDonutSvg(doc, slices, centerTop, centerBot) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'om-ctx-donut-svg');
  svg.setAttribute('viewBox', '0 0 84 84');
  const r = 31;
  const circ = 2 * Math.PI * r;

  const track = doc.createElementNS(NS, 'circle');
  track.setAttribute('cx', '42');
  track.setAttribute('cy', '42');
  track.setAttribute('r', String(r));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'rgba(148, 163, 184, 0.16)');
  track.setAttribute('stroke-width', '9');
  svg.appendChild(track);

  const sum = slices.reduce((s, x) => s + Math.max(0, Number(x.val || 0)), 0);
  if (sum > 0) {
    let off = 0;
    for (const sl of slices) {
      const v = Math.max(0, Number(sl.val || 0));
      if (v <= 0) continue;
      const len = (v / sum) * circ;
      const arc = doc.createElementNS(NS, 'circle');
      arc.setAttribute('cx', '42');
      arc.setAttribute('cy', '42');
      arc.setAttribute('r', String(r));
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', sl.color);
      arc.setAttribute('stroke-width', '9');
      arc.setAttribute('stroke-dasharray', `${len.toFixed(2)} ${circ.toFixed(2)}`);
      arc.setAttribute('stroke-dashoffset', (-off).toFixed(2));
      arc.setAttribute('transform', 'rotate(-90 42 42)');
      svg.appendChild(arc);
      off += len;
    }
  }

  const t1 = doc.createElementNS(NS, 'text');
  t1.setAttribute('x', '42');
  t1.setAttribute('y', '40');
  t1.setAttribute('text-anchor', 'middle');
  t1.setAttribute('fill', 'var(--foreground, #ececef)');
  t1.setAttribute('font-size', '12');
  t1.setAttribute('font-weight', '700');
  t1.textContent = centerTop;
  svg.appendChild(t1);

  const t2 = doc.createElementNS(NS, 'text');
  t2.setAttribute('x', '42');
  t2.setAttribute('y', '53');
  t2.setAttribute('text-anchor', 'middle');
  t2.setAttribute('fill', 'var(--muted-foreground, #94a3b8)');
  t2.setAttribute('font-size', '8.5');
  t2.textContent = centerBot;
  svg.appendChild(t2);

  return svg;
}

/**
 * 阶段四统一契约：将完整 5 行业务「上下文」视图渲染到任意独立滚动容器。
 * 对照参考图 2026-11-28_04-14-19.png / 2026-11-27_09-25-12.png 与任务书 5.4 节。
 */
function renderContextInspectorInto(containerEl, data, opts = {}) {
  if (!containerEl) return null;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  if (containerEl.__omCtxCtrl && typeof containerEl.__omCtxCtrl.update === 'function') {
    containerEl.__omCtxCtrl.update(data, opts);
    return containerEl.__omCtxCtrl;
  }

  omCtxEnsureStyles(containerEl);

  const st = {
    lang: omCtxResolveLang(opts.lang),
    active: opts.active !== false,
    disposed: false,
    data: data || null,
    opts: { ...opts },
    timelineGroup: 'step',   // 'step' | 'turn'
    timelineMetric: 'total', // 'total' | 'delta'
    selectedStepIdx: null,
    browserMode: 'total',    // 'total' | 'delta'
    expandedCats: new Set(),
    eventFilter: 'all',
    fileFilter: 'all',
    cmdFilter: 'all',
    cmdQuery: ''
  };

  const scrollRoot = doc.createElement('div');
  scrollRoot.className = 'om-ctx-scroll';
  scrollRoot.setAttribute('data-om-session-view-body', 'context');
  scrollRoot.setAttribute('data-om-view-scroll', 'context');
  containerEl.replaceChildren(scrollRoot);

  function renderAll() {
    if (st.disposed) return;
    const copy = OM_CTX_I18N[st.lang] || OM_CTX_I18N['zh-CN'];
    const snap = omCtxBuildSnapshot(st.data, st.opts);
    const prevScrollTop = scrollRoot.scrollTop;

    const frag = doc.createDocumentFragment();

    // =========================================================
    // 第 1 行：左通栏「上下文统计」概览卡 + 右「紧凑插件信息卡」
    // =========================================================
    const row1 = doc.createElement('div');
    row1.className = 'om-ctx-row om-ctx-row-1';
    row1.setAttribute('data-om-ctx-row', '1');

    const ovCard = doc.createElement('section');
    ovCard.className = 'om-ctx-card';
    ovCard.setAttribute('data-om-ctx-card', 'overview');
    const ovHdr = doc.createElement('div');
    ovHdr.className = 'om-ctx-card-hdr';
    const ovTitle = doc.createElement('div');
    ovTitle.className = 'om-ctx-card-title';
    ovTitle.textContent = copy.overviewTitle;
    ovHdr.appendChild(ovTitle);
    ovCard.appendChild(ovHdr);

    // Sub-row 1: 4 KPIs + Context Events 4 counts
    const kpiStrip = doc.createElement('div');
    kpiStrip.className = 'om-ctx-kpi-strip';
    const kpiDefs = [
      [copy.turns, snap.turnsCount],
      [copy.steps, snap.stepsCount],
      [copy.skillsLoaded, snap.skillsCount],
      [copy.modelReplies, snap.repliesCount]
    ];
    for (const [lbl, val] of kpiDefs) {
      const box = doc.createElement('div');
      box.className = 'om-ctx-kpi-box';
      const n = doc.createElement('div');
      n.className = 'om-ctx-kpi-num';
      n.textContent = String(val);
      const l = doc.createElement('div');
      l.className = 'om-ctx-kpi-lbl';
      l.textContent = lbl;
      box.appendChild(n);
      box.appendChild(l);
      kpiStrip.appendChild(box);
    }
    const evBox = doc.createElement('div');
    evBox.className = 'om-ctx-kpi-box';
    const evLbl = doc.createElement('div');
    evLbl.className = 'om-ctx-kpi-lbl';
    evLbl.textContent = copy.ctxEvents;
    const evRow = doc.createElement('div');
    evRow.className = 'om-ctx-ev-counts';
    for (const [elbl, eVal, eCol] of [
      [copy.evInject, snap.evCounts.inject, '#10B981'],
      [copy.evWrite, snap.evCounts.write, '#0EA5E9'],
      [copy.evCompact, snap.evCounts.compact, '#F59E0B'],
      [copy.evRefresh, snap.evCounts.refresh, '#64748B']
    ]) {
      const sp = doc.createElement('span');
      sp.style.color = eVal > 0 ? eCol : 'var(--om-muted)';
      sp.textContent = `${elbl} ${eVal}`;
      evRow.appendChild(sp);
    }
    evBox.appendChild(evLbl);
    evBox.appendChild(evRow);
    kpiStrip.appendChild(evBox);
    ovCard.appendChild(kpiStrip);

    // Sub-row 2: 输入输出
    const ioRow = doc.createElement('div');
    ioRow.className = 'om-ctx-meta-row';
    const ioLeft = doc.createElement('div');
    ioLeft.className = 'om-ctx-chip-list';
    const ioTitle = doc.createElement('span');
    ioTitle.className = 'om-ctx-subtle';
    ioTitle.textContent = copy.ioTitle;
    ioLeft.appendChild(ioTitle);
    for (const [cLbl, cVal, cCol] of [
      [copy.ioUser, snap.userMsgCount, '#10B981'],
      [copy.ioModel, snap.repliesCount, 'var(--om-accent)'],
      [copy.ioBlocks, snap.modelBlocksCount, '#06B6D4']
    ]) {
      const chip = doc.createElement('span');
      chip.className = 'om-ctx-chip';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = cCol;
      chip.appendChild(dot);
      chip.appendChild(doc.createTextNode(`${cLbl} ${cVal}`));
      ioLeft.appendChild(chip);
    }
    const ioTotal = doc.createElement('span');
    ioTotal.className = 'om-ctx-subtle';
    ioTotal.textContent = String(snap.userMsgCount + snap.repliesCount);
    ioRow.appendChild(ioLeft);
    ioRow.appendChild(ioTotal);
    ovCard.appendChild(ioRow);

    // Sub-row 3: 工具调用高频胶囊
    const toolRow = doc.createElement('div');
    toolRow.className = 'om-ctx-meta-row';
    const toolChips = doc.createElement('div');
    toolChips.className = 'om-ctx-chip-list';
    const toolTitle = doc.createElement('span');
    toolTitle.className = 'om-ctx-subtle';
    toolTitle.textContent = copy.toolsTitle;
    toolChips.appendChild(toolTitle);
    const topToolSlice = snap.topTools.slice(0, 5);
    const shownToolCount = topToolSlice.reduce((s, x) => s + x.count, 0);
    for (const it of topToolSlice) {
      const chip = doc.createElement('span');
      chip.className = 'om-ctx-chip';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = '#F59E0B';
      chip.appendChild(dot);
      chip.appendChild(doc.createTextNode(`${it.name} ${it.count}`));
      toolChips.appendChild(chip);
    }
    if (snap.totalToolCalls > shownToolCount) {
      const oth = doc.createElement('span');
      oth.className = 'om-ctx-chip';
      oth.textContent = `${copy.othersLabel} ${snap.totalToolCalls - shownToolCount}`;
      toolChips.appendChild(oth);
    }
    const toolTot = doc.createElement('span');
    toolTot.className = 'om-ctx-subtle';
    toolTot.textContent = String(snap.totalToolCalls);
    toolRow.appendChild(toolChips);
    toolRow.appendChild(toolTot);
    ovCard.appendChild(toolRow);

    // Sub-row 4: 命令执行高频胶囊 + 当前 Agent / 子 Agent 两计数
    const cmdOvRow = doc.createElement('div');
    cmdOvRow.className = 'om-ctx-meta-row';
    const cmdChips = doc.createElement('div');
    cmdChips.className = 'om-ctx-chip-list';
    const cmdOvTitle = doc.createElement('span');
    cmdOvTitle.className = 'om-ctx-subtle';
    cmdOvTitle.textContent = copy.commandsTitle;
    cmdChips.appendChild(cmdOvTitle);
    const topProgSlice = snap.topPrograms.slice(0, 4);
    const shownProgCount = topProgSlice.reduce((s, x) => s + x.count, 0);
    for (const pr of topProgSlice) {
      const chip = doc.createElement('span');
      chip.className = 'om-ctx-chip';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = '#10B981';
      chip.appendChild(dot);
      chip.appendChild(doc.createTextNode(`${pr.program} ${pr.count}`));
      cmdChips.appendChild(chip);
    }
    if (snap.totalCommands > shownProgCount) {
      const oth = doc.createElement('span');
      oth.className = 'om-ctx-chip';
      oth.textContent = `${copy.othersLabel} ${snap.totalCommands - shownProgCount}`;
      cmdChips.appendChild(oth);
    }
    const agWrap = doc.createElement('span');
    agWrap.className = 'om-ctx-subtle';
    agWrap.textContent = `${copy.mainAgent} 1 · ${copy.subAgent} ${snap.subagentCount}`;
    cmdOvRow.appendChild(cmdChips);
    cmdOvRow.appendChild(agWrap);
    ovCard.appendChild(cmdOvRow);

    // Right compact Plugin Info Card (ZERO external brands / ads)
    const infoCard = doc.createElement('section');
    infoCard.className = 'om-ctx-card';
    infoCard.setAttribute('data-om-ctx-card', 'plugin-info');
    const infoHdr = doc.createElement('div');
    infoHdr.className = 'om-ctx-card-hdr';
    const infoTitle = doc.createElement('div');
    infoTitle.className = 'om-ctx-card-title';
    infoTitle.textContent = copy.pluginInfoTitle;
    infoHdr.appendChild(infoTitle);
    infoCard.appendChild(infoHdr);

    const verRow = doc.createElement('div');
    verRow.className = 'om-ctx-info-row';
    const verK = doc.createElement('span');
    verK.className = 'om-ctx-subtle';
    verK.textContent = copy.pluginVersion;
    const verV = doc.createElement('strong');
    verV.textContent = `Antigravity Context Meter ${snap.version}`;
    verRow.appendChild(verK);
    verRow.appendChild(verV);
    infoCard.appendChild(verRow);

    const modRow = doc.createElement('div');
    modRow.className = 'om-ctx-info-row';
    const modK = doc.createElement('span');
    modK.className = 'om-ctx-subtle';
    modK.textContent = copy.pluginBudget;
    const modV = doc.createElement('span');
    modV.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;font-weight:500;';
    modV.textContent = `${snap.modelLabel} · ${omCtxShort(snap.budgetTokens)}`;
    modRow.appendChild(modK);
    modRow.appendChild(modV);
    infoCard.appendChild(modRow);

    const infoActions = doc.createElement('div');
    infoActions.style.cssText = 'display:flex;gap:8px;margin-top:auto;flex-wrap:wrap;';
    const budgetBtn = doc.createElement('button');
    budgetBtn.type = 'button';
    budgetBtn.className = 'om-ctx-btn';
    budgetBtn.setAttribute('data-om-ctx-action', 'open-budget');
    budgetBtn.textContent = copy.openBudget;
    budgetBtn.addEventListener('click', () => st.opts.onOpenBudget?.());
    const setBtn = doc.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'om-ctx-btn om-ctx-btn-primary';
    setBtn.setAttribute('data-om-ctx-action', 'open-settings');
    setBtn.textContent = copy.openSettings;
    setBtn.addEventListener('click', () => st.opts.onOpenSettings?.());
    infoActions.appendChild(budgetBtn);
    infoActions.appendChild(setBtn);
    infoCard.appendChild(infoActions);

    row1.appendChild(ovCard);
    row1.appendChild(infoCard);
    frag.appendChild(row1);

    // =========================================================
    // 第 2 行：等高双卡 — 左「Token 统计」 / 右「耗时统计」
    // =========================================================
    const row2 = doc.createElement('div');
    row2.className = 'om-ctx-row om-ctx-row-2';
    row2.setAttribute('data-om-ctx-row', '2');

    // Left: Token stats
    const tokCard = doc.createElement('section');
    tokCard.className = 'om-ctx-card';
    tokCard.setAttribute('data-om-ctx-card', 'token-stats');
    const tokHdr = doc.createElement('div');
    tokHdr.className = 'om-ctx-card-hdr';
    const tokT = doc.createElement('div');
    tokT.className = 'om-ctx-card-title';
    tokT.textContent = copy.tokenStatsTitle;
    const tokHit = doc.createElement('span');
    tokHit.className = 'om-ctx-subtle';
    tokHit.textContent = snap.cacheHitPct != null ? `${copy.cacheHit} ${snap.cacheHitPct}%` : `${copy.cacheHit} --`;
    tokHdr.appendChild(tokT);
    tokHdr.appendChild(tokHit);
    tokCard.appendChild(tokHdr);

    const tokSlices = snap.categories.some(c => c.tokens > 0)
      ? snap.categories.map(c => ({ label: copy.cats[c.key], color: c.color, val: c.tokens }))
      : [
        { label: copy.cats.user, color: '#10B981', val: snap.freshIn },
        { label: copy.cats.injection, color: '#F59E0B', val: snap.cacheRead },
        { label: copy.cats.assistant, color: 'var(--ag-host-accent, var(--primary, #3274f6))', val: snap.outputTok }
      ];
    const tokSum = Math.max(1, tokSlices.reduce((s, x) => s + x.val, 0));
    const tokBody = doc.createElement('div');
    tokBody.className = 'om-ctx-donut-layout';
    tokBody.appendChild(omCtxBuildDonutSvg(doc, tokSlices, omCtxShort(snap.totalTok), copy.totalUsage));
    const tokLegend = doc.createElement('div');
    tokLegend.className = 'om-ctx-legend-grid';
    for (const sl of tokSlices) {
      const item = doc.createElement('div');
      item.className = 'om-ctx-legend-item';
      const lft = doc.createElement('span');
      lft.className = 'om-ctx-legend-left';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = sl.color;
      lft.appendChild(dot);
      lft.appendChild(doc.createTextNode(sl.label));
      const rgt = doc.createElement('span');
      rgt.className = 'om-ctx-subtle';
      const pct = sl.val > 0 ? `${((sl.val / tokSum) * 100).toFixed(1)}%` : '0%';
      rgt.textContent = `${omCtxShort(sl.val)} · ${pct}`;
      item.appendChild(lft);
      item.appendChild(rgt);
      tokLegend.appendChild(item);
    }
    tokBody.appendChild(tokLegend);
    tokCard.appendChild(tokBody);

    // Right: Latency stats (strictly real exportable dimensions only)
    const latCard = doc.createElement('section');
    latCard.className = 'om-ctx-card';
    latCard.setAttribute('data-om-ctx-card', 'latency-stats');
    const latHdr = doc.createElement('div');
    latHdr.className = 'om-ctx-card-hdr';
    const latT = doc.createElement('div');
    latT.className = 'om-ctx-card-title';
    latT.textContent = copy.latencyStatsTitle;
    const latSpeed = doc.createElement('span');
    latSpeed.className = 'om-ctx-subtle';
    latSpeed.textContent = snap.avgTps != null ? `${copy.outputSpeed} ${snap.avgTps} tok/s` : `${copy.outputSpeed} --`;
    latHdr.appendChild(latT);
    latHdr.appendChild(latSpeed);
    latCard.appendChild(latHdr);

    const latDims = [];
    if (snap.waitSec > 0) latDims.push({ label: copy.latWait, color: '#3B82F6', val: snap.waitSec });
    if (snap.genSec > 0) latDims.push({ label: copy.latGen, color: 'var(--ag-host-accent, var(--primary, #3274f6))', val: snap.genSec });
    if (snap.toolSec > 0) latDims.push({ label: copy.latTool, color: '#10B981', val: snap.toolSec });
    const latTotalSec = latDims.reduce((s, d) => s + d.val, 0);

    if (latDims.length) {
      const latBody = doc.createElement('div');
      latBody.className = 'om-ctx-donut-layout';
      latBody.appendChild(omCtxBuildDonutSvg(doc, latDims, omCtxDur(latTotalSec), copy.activeTime));
      const latLegend = doc.createElement('div');
      latLegend.className = 'om-ctx-legend-grid';
      for (const dim of latDims) {
        const item = doc.createElement('div');
        item.className = 'om-ctx-legend-item';
        const lft = doc.createElement('span');
        lft.className = 'om-ctx-legend-left';
        const dot = doc.createElement('i');
        dot.className = 'om-ctx-dot';
        dot.style.background = dim.color;
        lft.appendChild(dot);
        lft.appendChild(doc.createTextNode(dim.label));
        const rgt = doc.createElement('span');
        rgt.className = 'om-ctx-subtle';
        const pct = latTotalSec > 0 ? `${((dim.val / latTotalSec) * 100).toFixed(1)}%` : '0%';
        rgt.textContent = `${omCtxDur(dim.val)} · ${pct}`;
        item.appendChild(lft);
        item.appendChild(rgt);
        latLegend.appendChild(item);
      }
      latBody.appendChild(latLegend);
      latCard.appendChild(latBody);

      const phaseBar = doc.createElement('div');
      phaseBar.className = 'om-ctx-segbar';
      for (const dim of latDims) {
        const seg = doc.createElement('div');
        seg.className = 'om-ctx-seg';
        seg.style.width = `${Math.max(2, (dim.val / latTotalSec) * 100).toFixed(1)}%`;
        seg.style.background = dim.color;
        phaseBar.appendChild(seg);
      }
      latCard.appendChild(phaseBar);
    } else {
      const em = doc.createElement('div');
      em.className = 'om-ctx-subtle';
      em.style.padding = '18px 0';
      em.textContent = copy.latUnavailable;
      latCard.appendChild(em);
    }

    row2.appendChild(tokCard);
    row2.appendChild(latCard);
    frag.appendChild(row2);

    // =========================================================
    // 第 3 行：左右分栏联动 — 左三叠（当前上下文 / 上下文时间线 / 单步详情卡）+ 右「上下文浏览器」
    // =========================================================
    const row3 = doc.createElement('div');
    row3.className = 'om-ctx-row om-ctx-row-3';
    row3.setAttribute('data-om-ctx-row', '3');

    const leftStack = doc.createElement('div');
    leftStack.className = 'om-ctx-left-stack';

    // 3A. 当前上下文卡
    const curCard = doc.createElement('section');
    curCard.className = 'om-ctx-card';
    curCard.setAttribute('data-om-ctx-card', 'current-context');
    const curPct = snap.budgetTokens > 0 ? Math.min(100, Math.round((snap.usedTokens / snap.budgetTokens) * 1000) / 10) : 0;
    const curHdr = doc.createElement('div');
    curHdr.className = 'om-ctx-card-hdr';
    const curTitle = doc.createElement('div');
    curTitle.className = 'om-ctx-card-title';
    curTitle.textContent = `${copy.currentCtxTitle} · ${omCtxShort(snap.usedTokens)} / ${omCtxShort(snap.budgetTokens)}`;
    const curPctEl = doc.createElement('strong');
    curPctEl.style.fontVariantNumeric = 'tabular-nums';
    curPctEl.textContent = `${curPct}% ${copy.usedLabel}`;
    curHdr.appendChild(curTitle);
    curHdr.appendChild(curPctEl);
    curCard.appendChild(curHdr);

    const curBar = doc.createElement('div');
    curBar.className = 'om-ctx-segbar';
    const catSum = Math.max(1, snap.estimatedSum);
    for (const c of snap.categories) {
      if (c.tokens <= 0) continue;
      const seg = doc.createElement('div');
      seg.className = 'om-ctx-seg';
      seg.style.width = `${Math.max(1.5, (c.tokens / catSum) * 100).toFixed(1)}%`;
      seg.style.background = c.color;
      curBar.appendChild(seg);
    }
    curCard.appendChild(curBar);

    const curLeg = doc.createElement('div');
    curLeg.className = 'om-ctx-chip-list';
    for (const c of snap.categories) {
      const chip = doc.createElement('span');
      chip.className = 'om-ctx-chip';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = c.color;
      const pct = snap.estimatedSum > 0 ? Math.round((c.tokens / snap.estimatedSum) * 100) : 0;
      chip.appendChild(dot);
      chip.appendChild(doc.createTextNode(`${copy.cats[c.key]} ${omCtxShort(c.tokens)} ${pct}%`));
      curLeg.appendChild(chip);
    }
    curCard.appendChild(curLeg);
    leftStack.appendChild(curCard);

    // 3B. 上下文时间线（按步/按轮 + 总量/增量 + 点击联动单步卡）
    const tlCard = doc.createElement('section');
    tlCard.className = 'om-ctx-card';
    tlCard.setAttribute('data-om-ctx-card', 'timeline');
    const tlHdr = doc.createElement('div');
    tlHdr.className = 'om-ctx-card-hdr';
    const tlTitle = doc.createElement('div');
    tlTitle.className = 'om-ctx-card-title';
    tlTitle.textContent = copy.timelineTitle;

    const tlControls = doc.createElement('div');
    tlControls.style.cssText = 'display:inline-flex;gap:6px;flex-wrap:wrap;';
    const mkSeg = (pairs, curVal, onPick) => {
      const grp = doc.createElement('div');
      grp.className = 'om-ctx-seg-group';
      for (const [val, txt] of pairs) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = `om-ctx-seg-btn${curVal === val ? ' is-active' : ''}`;
        b.textContent = txt;
        b.addEventListener('click', () => onPick(val));
        grp.appendChild(b);
      }
      return grp;
    };
    tlControls.appendChild(mkSeg([['step', copy.byStep], ['turn', copy.byTurn]], st.timelineGroup, (v) => {
      st.timelineGroup = v;
      st.selectedStepIdx = null;
      renderAll();
    }));
    tlControls.appendChild(mkSeg([['total', copy.modeTotal], ['delta', copy.modeDelta]], st.timelineMetric, (v) => {
      st.timelineMetric = v;
      renderAll();
    }));
    tlHdr.appendChild(tlTitle);
    tlHdr.appendChild(tlControls);
    tlCard.appendChild(tlHdr);

    let series = snap.stepPoints;
    if (st.timelineGroup === 'turn') {
      const byTurn = new Map();
      for (const p of snap.stepPoints) {
        byTurn.set(p.turnIndex, p);
      }
      series = Array.from(byTurn.values());
    }
    if (series.length && (st.selectedStepIdx == null || !series.some(p => p.stepIndex === st.selectedStepIdx))) {
      st.selectedStepIdx = series[series.length - 1].stepIndex;
    }

    const chart = doc.createElement('div');
    chart.className = 'om-ctx-timeline-chart';
    chart.setAttribute('data-om-ctx-timeline-chart', 'true');
    const barEntries = [];

    // 3C. 常驻单步详情检查卡（原地刷新，不销毁既有节点引用与焦点）
    const stepCard = doc.createElement('section');
    stepCard.className = 'om-ctx-card om-ctx-step-detail';
    stepCard.setAttribute('data-om-ctx-card', 'step-detail');
    stepCard.setAttribute('data-om-step-detail', 'true');

    let brCmpVal = null;

    const renderStepCardInPlace = (activePt) => {
      stepCard.setAttribute('data-selected-step', activePt ? String(activePt.stepIndex) : '');
      const stepHdr = doc.createElement('div');
      stepHdr.className = 'om-ctx-card-hdr';
      const stepTitle = doc.createElement('div');
      stepTitle.className = 'om-ctx-card-title';
      stepTitle.setAttribute('data-om-step-detail-title', 'true');
      stepTitle.textContent = activePt
        ? copy.stepDetailTitle.replace('{turn}', String(activePt.turnIndex)).replace('{step}', String(activePt.stepIndex))
        : copy.stepDetailTitle.replace('{turn}', '0').replace('{step}', '0');
      const stepTs = doc.createElement('span');
      stepTs.className = 'om-ctx-subtle';
      stepTs.textContent = activePt ? omCtxClock(activePt.timestamp) : '--:--:--';
      stepHdr.appendChild(stepTitle);
      stepHdr.appendChild(stepTs);

      const stepFields = doc.createElement('div');
      stepFields.className = 'om-ctx-step-fields';
      for (const [fLbl, fVal] of [
        [copy.actualCtx, activePt ? omCtxShort(activePt.actualTokens) : '—'],
        [copy.outputTok, activePt ? omCtxShort(activePt.outputTokens) : '—'],
        [copy.cacheHit, activePt && activePt.cacheHitPct != null ? `${activePt.cacheHitPct}%` : '—']
      ]) {
        const fWrap = doc.createElement('span');
        fWrap.appendChild(doc.createTextNode(`${fLbl} `));
        const fStrong = doc.createElement('strong');
        fStrong.textContent = fVal;
        fWrap.appendChild(fStrong);
        stepFields.appendChild(fWrap);
      }

      const uBox = doc.createElement('div');
      uBox.className = 'om-ctx-step-box';
      uBox.textContent = `${copy.userSummary} · ${activePt?.userSummary || copy.emptySection}`;
      const rBox = doc.createElement('div');
      rBox.className = 'om-ctx-step-box';
      rBox.textContent = `${copy.replySummary} · ${activePt?.replySummary || copy.emptySection}`;

      const stepBar = doc.createElement('div');
      stepBar.className = 'om-ctx-segbar';
      if (activePt) {
        const sDen = Math.max(1, activePt.inputTokens + activePt.cacheReadTokens + activePt.outputTokens);
        for (const [col, v] of [['#10B981', activePt.inputTokens], ['#06B6D4', activePt.cacheReadTokens], ['var(--ag-host-accent, var(--primary, #3274f6))', activePt.outputTokens]]) {
          if (v <= 0) continue;
          const seg = doc.createElement('div');
          seg.className = 'om-ctx-seg';
          seg.style.width = `${Math.max(2, (v / sDen) * 100).toFixed(1)}%`;
          seg.style.background = col;
          stepBar.appendChild(seg);
        }
      }

      stepCard.replaceChildren(stepHdr, stepFields, uBox, rBox, stepBar);

      if (brCmpVal) {
        const targetActual = activePt && activePt.actualTokens > 0 ? activePt.actualTokens : snap.usedTokens;
        brCmpVal.textContent = `${copy.estTotal} ${omCtxShort(snap.estimatedSum)} · ${copy.actualTotal} ${omCtxShort(targetActual)}`;
      }
    };

    const syncSelectedStepInPlace = (nextStepIdx) => {
      st.selectedStepIdx = nextStepIdx;
      for (const item of barEntries) {
        const isSel = item.pt.stepIndex === nextStepIdx;
        item.col.classList.toggle('is-selected', isSel);
        item.col.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      }
      const nextPt = series.find(p => p.stepIndex === nextStepIdx) || series[series.length - 1] || null;
      renderStepCardInPlace(nextPt);
    };
    st.syncSelectedStepInPlace = syncSelectedStepInPlace;

    if (!series.length) {
      const em = doc.createElement('div');
      em.className = 'om-ctx-subtle';
      em.textContent = copy.emptySection;
      chart.appendChild(em);
    } else {
      const vals = series.map(p => Math.abs(st.timelineMetric === 'delta' ? p.deltaTokens : p.actualTokens));
      const maxV = Math.max(1, ...vals);
      for (const pt of series.slice(-48)) {
        const val = Math.abs(st.timelineMetric === 'delta' ? pt.deltaTokens : pt.actualTokens);
        const hPct = Math.max(6, Math.round((val / maxV) * 86));
        const isSel = st.selectedStepIdx === pt.stepIndex;
        const col = doc.createElement('div');
        col.className = `om-ctx-tbar om-ctx-bar${isSel ? ' is-selected' : ''}`;
        col.setAttribute('data-om-timeline-bar', 'true');
        col.setAttribute('data-om-step-idx', String(pt.stepIndex));
        col.setAttribute('data-step-index', String(pt.stepIndex));
        col.setAttribute('role', 'button');
        col.setAttribute('tabindex', '0');
        col.setAttribute('aria-pressed', isSel ? 'true' : 'false');

        const stack = doc.createElement('div');
        stack.className = 'om-ctx-tbar-stack';
        stack.style.height = `${hPct}%`;
        const denom = Math.max(1, pt.inputTokens + pt.cacheReadTokens + pt.outputTokens);
        for (const [scol, sv] of [
          ['#10B981', pt.inputTokens],
          ['#06B6D4', pt.cacheReadTokens],
          ['var(--ag-host-accent, var(--primary, #3274f6))', pt.outputTokens]
        ]) {
          if (sv <= 0) continue;
          const seg = doc.createElement('div');
          seg.style.height = `${Math.max(8, Math.round((sv / denom) * 100))}%`;
          seg.style.background = scol;
          stack.appendChild(seg);
        }
        if (!stack.childNodes.length) {
          const seg = doc.createElement('div');
          seg.style.height = '100%';
          seg.style.background = 'var(--ag-host-accent, var(--primary, #3274f6))';
          stack.appendChild(seg);
        }

        const lbl = doc.createElement('span');
        lbl.className = 'om-ctx-tbar-lbl';
        lbl.textContent = st.timelineGroup === 'turn' ? `T${pt.turnIndex}` : String(pt.stepIndex);

        col.appendChild(stack);
        col.appendChild(lbl);
        col.addEventListener('click', () => {
          syncSelectedStepInPlace(pt.stepIndex);
        });
        col.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault?.();
            syncSelectedStepInPlace(pt.stepIndex);
          }
        });
        barEntries.push({ col, pt });
        chart.appendChild(col);
      }
    }
    tlCard.appendChild(chart);
    leftStack.appendChild(tlCard);

    const activePt = series.find(p => p.stepIndex === st.selectedStepIdx) || series[series.length - 1] || null;
    renderStepCardInPlace(activePt);
    leftStack.appendChild(stepCard);

    // 3D. 右侧「上下文浏览器」
    const browserCard = doc.createElement('section');
    browserCard.className = 'om-ctx-card';
    browserCard.setAttribute('data-om-ctx-card', 'browser');
    const brHdr = doc.createElement('div');
    brHdr.className = 'om-ctx-card-hdr';
    const brTitle = doc.createElement('div');
    brTitle.className = 'om-ctx-card-title';
    brTitle.textContent = copy.browserTitle;
    brHdr.appendChild(brTitle);
    brHdr.appendChild(mkSeg([['total', copy.modeTotal], ['delta', copy.modeDelta]], st.browserMode, (v) => {
      st.browserMode = v;
      renderAll();
    }));
    browserCard.appendChild(brHdr);

    const brCompare = doc.createElement('div');
    brCompare.className = 'om-ctx-card-hdr';
    const brReqLbl = doc.createElement('span');
    brReqLbl.className = 'om-ctx-subtle';
    brReqLbl.textContent = copy.currentReq;
    brCmpVal = doc.createElement('span');
    brCmpVal.className = 'om-ctx-subtle';
    const initialActual = activePt && activePt.actualTokens > 0 ? activePt.actualTokens : snap.usedTokens;
    brCmpVal.textContent = `${copy.estTotal} ${omCtxShort(snap.estimatedSum)} · ${copy.actualTotal} ${omCtxShort(initialActual)}`;
    brCompare.appendChild(brReqLbl);
    brCompare.appendChild(brCmpVal);
    browserCard.appendChild(brCompare);

    const brBar = curBar.cloneNode(true);
    browserCard.appendChild(brBar);

    const treeBox = doc.createElement('div');
    treeBox.className = 'om-ctx-tree';
    treeBox.setAttribute('data-om-ctx-browser-tree', 'true');
    for (const c of snap.categories) {
      const isOpen = st.expandedCats.has(c.key);
      const node = doc.createElement('div');
      node.className = 'om-ctx-tree-node';
      node.setAttribute('data-om-ctx-tree-cat', c.key);

      const hdr = doc.createElement('button');
      hdr.type = 'button';
      hdr.className = 'om-ctx-tree-hdr';
      hdr.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

      const lft = doc.createElement('span');
      lft.className = 'om-ctx-legend-left';
      const dot = doc.createElement('i');
      dot.className = 'om-ctx-dot';
      dot.style.background = c.color;
      lft.appendChild(dot);
      lft.appendChild(doc.createTextNode(`${copy.cats[c.key]} · ${c.count} ${copy.itemsSuffix}`));

      const rgt = doc.createElement('span');
      rgt.className = 'om-ctx-subtle';
      const pct = snap.estimatedSum > 0 ? Math.round((c.tokens / snap.estimatedSum) * 100) : 0;
      const deltaTxt = c.deltaTokens ? ` ${c.deltaTokens > 0 ? '+' : ''}${omCtxShort(c.deltaTokens)}` : '';
      rgt.textContent = st.browserMode === 'delta'
        ? `${deltaTxt || '0'} · ${omCtxShort(c.tokens)} ${isOpen ? '▴' : '▾'}`
        : `${omCtxShort(c.tokens)} · ${pct}%${deltaTxt} ${isOpen ? '▴' : '▾'}`;

      hdr.appendChild(lft);
      hdr.appendChild(rgt);
      hdr.addEventListener('click', () => {
        if (st.expandedCats.has(c.key)) st.expandedCats.delete(c.key);
        else st.expandedCats.add(c.key);
        renderAll();
      });
      node.appendChild(hdr);

      if (isOpen) {
        const body = doc.createElement('div');
        body.className = 'om-ctx-tree-body';
        const ents = Array.isArray(c.entries) ? c.entries : [];
        if (!ents.length) {
          const em = doc.createElement('div');
          em.className = 'om-ctx-subtle';
          em.textContent = copy.emptySection;
          body.appendChild(em);
        } else {
          for (const e of ents.slice(0, 20)) {
            const row = doc.createElement('div');
            row.className = 'om-ctx-tree-entry';
            const txt = doc.createElement('span');
            txt.className = 'om-ctx-tree-entry-txt';
            txt.textContent = `${e.stepIndex != null ? `S${e.stepIndex} · ` : ''}${e.preview || e.label || copy.cats[c.key]}`;
            const val = doc.createElement('span');
            val.className = 'om-ctx-subtle';
            val.textContent = omCtxShort(e.tokens || 0);
            row.appendChild(txt);
            row.appendChild(val);
            body.appendChild(row);
          }
        }
        node.appendChild(body);
      }

      treeBox.appendChild(node);
    }
    browserCard.appendChild(treeBox);

    row3.appendChild(leftStack);
    row3.appendChild(browserCard);
    frag.appendChild(row3);

    // =========================================================
    // 第 4 行：左右双卡 — 左「上下文事件」 / 右「文件活动」
    // =========================================================
    const row4 = doc.createElement('div');
    row4.className = 'om-ctx-row om-ctx-row-4';
    row4.setAttribute('data-om-ctx-row', '4');

    // 4A. 上下文事件
    const evCard = doc.createElement('section');
    evCard.className = 'om-ctx-card';
    evCard.setAttribute('data-om-ctx-card', 'events');
    const evCardHdr = doc.createElement('div');
    evCardHdr.className = 'om-ctx-card-hdr';
    const evCardTitle = doc.createElement('div');
    evCardTitle.className = 'om-ctx-card-title';
    evCardTitle.textContent = `${copy.eventsCardTitle} · ${snap.events.length}`;
    const evTypes = ['all', ...Array.from(new Set(snap.events.map(e => String(e?.type || '')).filter(Boolean)))];
    evCardHdr.appendChild(evCardTitle);
    evCardHdr.appendChild(mkSeg(evTypes.map(tp => [tp, tp === 'all' ? copy.filterAll : tp]), st.eventFilter, (v) => {
      st.eventFilter = v;
      renderAll();
    }));
    evCard.appendChild(evCardHdr);

    const evList = doc.createElement('div');
    evList.className = 'om-ctx-list';
    const visEv = snap.events.filter(e => st.eventFilter === 'all' || String(e?.type || '') === st.eventFilter);
    if (!visEv.length) {
      const em = doc.createElement('div');
      em.className = 'om-ctx-subtle';
      em.textContent = copy.emptySection;
      evList.appendChild(em);
    } else {
      for (const ev of visEv.slice(-40).reverse()) {
        const r = doc.createElement('div');
        r.className = 'om-ctx-list-row';
        const lft = doc.createElement('span');
        lft.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;';
        lft.textContent = `${ev.type || 'event'} · ${ev.summary || ev.label || ev.detail || '—'}`;
        const rgt = doc.createElement('span');
        rgt.className = 'om-ctx-subtle';
        const deltaStr = ev.tokensSaved > 0
          ? `-${omCtxShort(ev.tokensSaved)}`
          : (ev.deltaTokens != null ? `${ev.deltaTokens > 0 ? '+' : ''}${omCtxShort(ev.deltaTokens)}` : '');
        rgt.textContent = [deltaStr, omCtxClock(ev.timestamp)].filter(Boolean).join(' · ');
        r.appendChild(lft);
        r.appendChild(rgt);
        evList.appendChild(r);
      }
    }
    evCard.appendChild(evList);

    // 4B. 文件活动
    const fileCard = doc.createElement('section');
    fileCard.className = 'om-ctx-card';
    fileCard.setAttribute('data-om-ctx-card', 'files');
    const fHdr = doc.createElement('div');
    fHdr.className = 'om-ctx-card-hdr';
    const fTitle = doc.createElement('div');
    fTitle.className = 'om-ctx-card-title';
    fTitle.textContent = `${copy.filesCardTitle} · ${snap.fileSummary.uniqueFiles || snap.files.length} ${copy.filesSuffix} +${snap.fileSummary.totalAddedLines || 0} -${snap.fileSummary.totalRemovedLines || 0}`;
    fHdr.appendChild(fTitle);
    fHdr.appendChild(mkSeg([
      ['all', copy.filterAll],
      ['read', copy.filterRead],
      ['write', copy.filterWrite],
      ['search', copy.filterSearch]
    ], st.fileFilter, (v) => {
      st.fileFilter = v;
      renderAll();
    }));
    fileCard.appendChild(fHdr);

    const fileList = doc.createElement('div');
    fileList.className = 'om-ctx-list';
    const visFiles = snap.files.filter(f => {
      if (!f) return false;
      if (st.fileFilter === 'read') return Number(f.readCount || 0) > 0;
      if (st.fileFilter === 'write') return Number(f.writeCount || 0) > 0;
      if (st.fileFilter === 'search') return Number(f.searchCount || 0) > 0;
      return true;
    });
    if (!visFiles.length) {
      const em = doc.createElement('div');
      em.className = 'om-ctx-subtle';
      em.textContent = copy.emptySection;
      fileList.appendChild(em);
    } else {
      for (const f of visFiles.slice(0, 50)) {
        const r = doc.createElement('div');
        r.className = 'om-ctx-list-row';
        const nm = doc.createElement('span');
        nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;';
        nm.textContent = f.path || f.basename || 'file';
        nm.title = f.path || '';
        const diff = doc.createElement('span');
        diff.style.cssText = 'display:inline-flex;gap:6px;flex-shrink:0;';
        if (f.addedLines > 0) {
          const a = doc.createElement('span');
          a.className = 'om-ctx-diff-add';
          a.textContent = `+${f.addedLines}`;
          diff.appendChild(a);
        }
        if (f.removedLines > 0) {
          const d = doc.createElement('span');
          d.className = 'om-ctx-diff-del';
          d.textContent = `-${f.removedLines}`;
          diff.appendChild(d);
        }
        const cnt = doc.createElement('span');
        cnt.className = 'om-ctx-subtle';
        cnt.textContent = `${f.totalCount || 1}x`;
        diff.appendChild(cnt);
        r.appendChild(nm);
        r.appendChild(diff);
        fileList.appendChild(r);
      }
    }
    fileCard.appendChild(fileList);

    row4.appendChild(evCard);
    row4.appendChild(fileCard);
    frag.appendChild(row4);

    // =========================================================
    // 第 5 行：通栏「命令执行」
    // =========================================================
    const row5 = doc.createElement('div');
    row5.className = 'om-ctx-row om-ctx-row-5';
    row5.setAttribute('data-om-ctx-row', '5');

    const cmdCard = doc.createElement('section');
    cmdCard.className = 'om-ctx-card';
    cmdCard.setAttribute('data-om-ctx-card', 'commands');
    const cHdr = doc.createElement('div');
    cHdr.className = 'om-ctx-card-hdr';
    const cTitle = doc.createElement('div');
    cTitle.className = 'om-ctx-card-title';
    cTitle.textContent = `${copy.cmdCardTitle} · ${snap.commands.length}`;

    const cTools = doc.createElement('div');
    cTools.style.cssText = 'display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;';
    const cmdInp = doc.createElement('input');
    cmdInp.type = 'search';
    cmdInp.className = 'om-ctx-input';
    cmdInp.placeholder = copy.cmdSearchPlaceholder;
    cmdInp.value = st.cmdQuery;
    cmdInp.addEventListener('input', () => {
      st.cmdQuery = String(cmdInp.value || '');
      renderAll();
    });
    cTools.appendChild(cmdInp);
    cTools.appendChild(mkSeg([
      ['all', copy.filterAll],
      ['failed', copy.cmdFilterFailed],
      ['slow', copy.cmdFilterSlow],
      ['bg', copy.cmdFilterBg]
    ], st.cmdFilter, (v) => {
      st.cmdFilter = v;
      renderAll();
    }));
    cHdr.appendChild(cTitle);
    cHdr.appendChild(cTools);
    cmdCard.appendChild(cHdr);

    const cmdSplit = doc.createElement('div');
    cmdSplit.className = 'om-ctx-cmd-split';

    // Left summary + top programs horizontal proportion bars
    const cmdLeft = doc.createElement('div');
    cmdLeft.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const totalCmdDur = snap.commands.reduce((s, c) => s + Number(c?.durationSec || 0), 0);
    const failRate = snap.commands.length > 0 ? Math.round(((snap.cmdSummary.failedCount || 0) / snap.commands.length) * 1000) / 10 : 0;
    const sumGrid = doc.createElement('div');
    sumGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;';
    for (const [slbl, sval] of [
      [copy.cmdRuns, String(snap.commands.length)],
      [copy.cmdTotalDur, omCtxDur(totalCmdDur)],
      [copy.cmdFailed, `${snap.cmdSummary.failedCount || 0} · ${failRate}%`],
      [copy.cmdBackground, String(snap.cmdSummary.backgroundCount || 0)]
    ]) {
      const b = doc.createElement('div');
      b.className = 'om-ctx-kpi-box';
      const bn = doc.createElement('div');
      bn.className = 'om-ctx-kpi-num';
      bn.style.fontSize = '14px';
      bn.textContent = sval;
      const bl = doc.createElement('div');
      bl.className = 'om-ctx-kpi-lbl';
      bl.textContent = slbl;
      b.appendChild(bn);
      b.appendChild(bl);
      sumGrid.appendChild(b);
    }
    cmdLeft.appendChild(sumGrid);

    const progTitle = doc.createElement('div');
    progTitle.className = 'om-ctx-subtle';
    progTitle.textContent = copy.cmdPrograms;
    cmdLeft.appendChild(progTitle);

    const maxProg = Math.max(1, ...snap.topPrograms.map(p => Number(p.count || 0)));
    for (const pr of snap.topPrograms.slice(0, 8)) {
      const prRow = doc.createElement('div');
      prRow.className = 'om-ctx-prog-row';
      const nm = doc.createElement('span');
      nm.style.cssText = 'width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nm.textContent = pr.program;
      const track = doc.createElement('span');
      track.className = 'om-ctx-prog-track';
      const fill = doc.createElement('span');
      fill.className = 'om-ctx-prog-fill';
      fill.style.width = `${Math.max(8, Math.round((pr.count / maxProg) * 100))}%`;
      track.appendChild(fill);
      const cnt = doc.createElement('span');
      cnt.className = 'om-ctx-subtle';
      cnt.textContent = String(pr.count);
      prRow.appendChild(nm);
      prRow.appendChild(track);
      prRow.appendChild(cnt);
      cmdLeft.appendChild(prRow);
    }

    // Right monospace command stream table
    const cmdTable = doc.createElement('div');
    cmdTable.className = 'om-ctx-cmd-table';
    const cq = st.cmdQuery.trim().toLowerCase();
    const visCmds = snap.commands.filter(c => {
      if (!c) return false;
      if (st.cmdFilter === 'failed' && c.status !== 'failed' && c.status !== 'error') return false;
      if (st.cmdFilter === 'slow' && !c.isSlow) return false;
      if (st.cmdFilter === 'bg' && !c.isBackground) return false;
      if (!cq) return true;
      return `${c.program || ''} ${c.command || ''}`.toLowerCase().includes(cq);
    });
    if (!visCmds.length) {
      const em = doc.createElement('div');
      em.className = 'om-ctx-subtle';
      em.textContent = copy.emptySection;
      cmdTable.appendChild(em);
    } else {
      for (const c of visCmds.slice(-80).reverse()) {
        const cr = doc.createElement('div');
        cr.className = 'om-ctx-cmd-row';
        const stDot = doc.createElement('span');
        const isErr = c.status === 'failed' || c.status === 'error';
        stDot.style.color = isErr ? '#F43F5E' : '#10B981';
        stDot.textContent = isErr ? '×' : '✓';
        const txt = doc.createElement('span');
        txt.className = 'om-ctx-cmd-text';
        txt.textContent = String(c.command || c.program || '');
        txt.title = String(c.command || '');
        const meta = doc.createElement('span');
        meta.className = 'om-ctx-subtle';
        meta.textContent = [
          c.durationSec != null ? omCtxDur(c.durationSec) : '',
          c.stepIndex != null ? `T${c.turnNumber || 1} S${c.stepIndex}` : '',
          omCtxClock(c.timestamp)
        ].filter(Boolean).join(' · ');
        cr.appendChild(stDot);
        cr.appendChild(txt);
        cr.appendChild(meta);
        cmdTable.appendChild(cr);
      }
    }

    cmdSplit.appendChild(cmdLeft);
    cmdSplit.appendChild(cmdTable);
    cmdCard.appendChild(cmdSplit);
    row5.appendChild(cmdCard);
    frag.appendChild(row5);

    scrollRoot.replaceChildren(frag);
    scrollRoot.scrollTop = prevScrollTop;
  }

  function setActive(active) {
    st.active = Boolean(active);
    if (st.active && !st.disposed) renderAll();
  }

  function setLang(nextLang) {
    st.lang = omCtxResolveLang(nextLang);
    if (!st.disposed) renderAll();
  }

  function update(nextData, nextOpts = {}) {
    if (st.disposed) return;
    st.data = nextData;
    if (nextOpts && typeof nextOpts === 'object') {
      st.opts = { ...st.opts, ...nextOpts };
      if (nextOpts.lang) st.lang = omCtxResolveLang(nextOpts.lang);
      if (typeof nextOpts.active === 'boolean') st.active = nextOpts.active;
    }
    if (st.active) renderAll();
  }

  function cleanup() {
    if (st.disposed) return;
    st.disposed = true;
    st.active = false;
    if (containerEl.__omCtxCtrl === handle) {
      delete containerEl.__omCtxCtrl;
    }
  }

  const handle = {
    update,
    setActive,
    setLang,
    cleanup,
    destroy: cleanup,
    selectStep: (stepIndex) => {
      const idx = Number(stepIndex);
      st.selectedStepIdx = idx;
      if (st.disposed) return;
      if (typeof st.syncSelectedStepInPlace === 'function') st.syncSelectedStepInPlace(idx);
      else renderAll();
    },
    getState: () => ({
      lang: st.lang,
      active: st.active,
      timelineGroup: st.timelineGroup,
      timelineMetric: st.timelineMetric,
      selectedStepIdx: st.selectedStepIdx,
      expandedCats: Array.from(st.expandedCats)
    })
  };

  containerEl.__omCtxCtrl = handle;
  renderAll();
  return handle;
}

if (typeof window !== 'undefined') {
  window.renderContextInspectorInto = renderContextInspectorInto;
}

// =========================================================================
// 兼容旧驾驶舱 Widget 导出（保留以保障既有单测 100% 通过）
// =========================================================================

/**
 * 将后端 sourceTag 映射为简洁本地化来源徽标文案，未知来源留空避免冗余文本。
 */
function resolveInspectorSourceLabel(sourceTag) {
  const norm = String(sourceTag || '').trim().toLowerCase();
  const key = INSPECTOR_SOURCE_LABEL_KEYS[norm];
  return key ? t(key) : '';
}

/**
 * 在预览区构造纯 DOM 安全渲染节点，杜绝原始 HTML 注入同时保留标题、列表与代码块层次。
 */
function appendSafeRenderedSnippet(container, text) {
  const lines = String(text || '').split(/\r?\n/);
  let inCode = false;
  let codeBuf = [];
  const flushCode = () => {
    if (!codeBuf.length) return;
    const pre = document.createElement('pre');
    pre.className = 'ctx-comp-preview-code';
    pre.textContent = codeBuf.join('\n');
    container.appendChild(pre);
    codeBuf = [];
  };

  for (const rawLine of lines.slice(0, 80)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }
    if (!trimmed) continue;
    const row = document.createElement('div');
    if (trimmed.startsWith('#')) {
      row.style.cssText = 'font-weight:700;font-size:11.5px;margin:2px 0;color:var(--ctx-ck-text);';
      row.textContent = trimmed.replace(/^#+\s*/, '');
    } else if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      row.style.cssText = 'padding-left:8px;font-size:11px;line-height:1.45;color:var(--ctx-ck-subtext);';
      row.textContent = `• ${trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, '')}`;
    } else {
      row.style.cssText = 'font-size:11px;line-height:1.45;color:var(--ctx-ck-subtext);word-break:break-word;';
      row.textContent = rawLine;
    }
    container.appendChild(row);
  }
  flushCode();
}

/**
 * 对数组执行统一的关键字搜索与排序策略，兼容分类节点条目与顺序切片对象。
 */
function filterAndSortInspectorEntries(entries, { query = '', sortBy = 'size', asstSub = 'all' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const filtered = (Array.isArray(entries) ? entries : []).filter(ent => {
    if (!ent) return false;
    if (asstSub && asstSub !== 'all') {
      const cat = String(ent.category || '');
      const sub = String(ent.subKind || '');
      if (asstSub === 'thinking' && cat !== 'thinking' && sub !== 'thinking') return false;
      if (asstSub === 'tools' && cat !== 'toolCalls' && cat !== 'tools' && sub !== 'tool_call') return false;
      if (asstSub === 'text' && cat !== 'assistant' && sub !== 'assistant') return false;
    }
    if (!q) return true;
    const hay = `${ent.label || ''} ${ent.category || ''} ${ent.preview || ''} ${ent.fullSnippet || ''} ${ent.sourceTag || ''}`.toLowerCase();
    return hay.includes(q);
  });

  const sorted = filtered.slice();
  if (sortBy === 'order') {
    sorted.sort((a, b) => (Number(a.seqOrder || 0) - Number(b.seqOrder || 0)) || (Number(a.stepIndex ?? 0) - Number(b.stepIndex ?? 0)));
  } else if (sortBy === 'name') {
    sorted.sort((a, b) => String(a.label || a.category || '').localeCompare(String(b.label || b.category || '')));
  } else {
    sorted.sort((a, b) => Number(b.tokens || 0) - Number(a.tokens || 0));
  }
  return sorted;
}

/**
 * 同步工具条按钮状态，渲染分类树 / 顺序切片列表 / 预览区及多模态附件条带。
 */
function renderContextInspectorView(breakdown, ctxInfo = {}) {
  const { tl, unaccTok = 0, usedDenom = 1, targetStepIndex = null } = ctxInfo;
  const viewMode = state.inspectorViewMode === 'slices' ? 'slices' : 'tree';
  const searchQuery = String(state.inspectorSearchQuery || '');
  const sortBy = state.inspectorSortBy || 'size';
  const asstSub = state.inspectorAsstSubFilter || 'all';
  const previewMode = state.inspectorPreviewMode === 'rendered' ? 'rendered' : 'raw';

  setPillActive(el('btn-inspector-view-tree'), viewMode !== 'slices');
  setPillActive(el('btn-inspector-view-slices'), viewMode === 'slices');
  setPillActive(el('ctx-tree-mode-full'), state.ctxTreeMode !== 'delta');
  setPillActive(el('ctx-tree-mode-delta'), state.ctxTreeMode === 'delta');
  setPillActive(el('btn-inspector-sort-size'), sortBy === 'size');
  setPillActive(el('btn-inspector-sort-order'), sortBy === 'order');
  setPillActive(el('btn-inspector-sort-name'), sortBy === 'name');
  setPillActive(el('ctx-comp-preview-mode-raw'), previewMode !== 'rendered');
  setPillActive(el('ctx-comp-preview-mode-render'), previewMode === 'rendered');

  const asstWrap = el('ctx-inspector-asst-filters');
  if (asstWrap) {
    for (const btn of Array.from(asstWrap.querySelectorAll?.('[data-asst-sub]') || [])) {
      const active = btn.getAttribute('data-asst-sub') === asstSub;
      btn.classList?.toggle?.('active', active);
      btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    }
  }

  const treeCovBadge = el('ctx-tree-coverage-badge');
  const treeScopeNote = el('ctx-tree-scope-note');
  const treeListEl = el('ctx-composition-tree-list');
  const slicesListEl = el('ctx-slices-list');

  if (treeCovBadge) {
    const cov = breakdown?.coverageScope || 'unavailable';
    treeCovBadge.setAttribute('data-basis', cov === 'host_only' ? 'server_usage' : (cov === 'unavailable' ? 'empty' : 'local_estimate'));
    treeCovBadge.textContent = cov === 'host_only' ? t('session.dual.basisHostOnly') : (breakdown?.estimatedTotalMedian > 0 ? `≈ ${short(breakdown.estimatedTotalMedian)}` : '—');
  }
  if (treeScopeNote) {
    if (breakdown?.stepScope === 'step_bounded' && breakdown?.targetStepIndex != null) {
      treeScopeNote.textContent = t('session.tree.scopeStepBounded', { step: breakdown.targetStepIndex });
    } else if (breakdown?.stepScope === 'session_approx') {
      treeScopeNote.textContent = t('session.tree.scopeSessionApprox');
    } else {
      treeScopeNote.textContent = t('session.tree.scopeSessionFull');
    }
  }

  if (treeListEl) treeListEl.hidden = viewMode === 'slices';
  if (slicesListEl) slicesListEl.hidden = viewMode !== 'slices';

  const rawItems = Array.isArray(breakdown?.items) ? breakdown.items : [];
  const filteredItems = rawItems
    .map(it => {
      const matchedEntries = filterAndSortInspectorEntries(
        (it.entries || []).map(e => ({ ...e, category: e.category || it.key })),
        { query: searchQuery, sortBy, asstSub }
      );
      return { ...it, filteredEntries: matchedEntries };
    })
    .filter(it => {
      if (asstSub === 'thinking' && it.key !== 'thinking') return false;
      if (asstSub === 'tools' && it.key !== 'tools' && it.key !== 'toolCalls') return false;
      if (asstSub === 'text' && it.key !== 'assistant') return false;
      if (!searchQuery.trim()) return true;
      const catLabel = String(t(`session.comp.cat.${it.key}`) || it.key).toLowerCase();
      return catLabel.includes(searchQuery.trim().toLowerCase()) || it.filteredEntries.length > 0;
    });

  if (sortBy === 'name') {
    filteredItems.sort((a, b) => String(t(`session.comp.cat.${a.key}`)).localeCompare(String(t(`session.comp.cat.${b.key}`))));
  } else if (sortBy === 'size') {
    filteredItems.sort((a, b) => Number(b.median || 0) - Number(a.median || 0));
  }

  if (treeListEl && viewMode !== 'slices') {
    treeListEl.replaceChildren();
    if (!filteredItems.length && unaccTok <= 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'timeline-turn-meta';
      emptyDiv.textContent = t('session.tree.noEntries');
      treeListEl.appendChild(emptyDiv);
    } else {
      const renderTreeNode = (key, color, titleText, countVal, tokVal, pctVal, deltaTokVal, entriesList) => {
        const isOpen = state.expandedTreeCats?.has?.(key);
        const isFocused = state.ctxFocusedTreeCat === key;
        const wrap = document.createElement('div');
        wrap.className = `ctx-tree-node${isFocused ? ' is-focused' : ''}`;
        wrap.setAttribute('data-tree-cat', key);

        const hdr = document.createElement('button');
        hdr.type = 'button';
        hdr.className = 'ctx-tree-node-hdr';
        hdr.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        const left = document.createElement('span');
        left.className = 'ctx-tree-node-left';
        const sw = document.createElement('i');
        sw.className = 'key-seg-swatch';
        sw.style.background = color;
        const titleSp = document.createElement('span');
        titleSp.textContent = titleText;
        const cntSp = document.createElement('span');
        cntSp.className = 'ctx-ov-meta-pill';
        cntSp.textContent = t('session.tree.itemsCount', { n: countVal || 0 });
        left.appendChild(sw);
        left.appendChild(titleSp);
        left.appendChild(cntSp);

        const right = document.createElement('span');
        right.className = 'ctx-tree-node-right';
        if (state.ctxTreeMode === 'delta' && deltaTokVal != null) {
          right.textContent = `${deltaTokVal > 0 ? '+' : ''}${short(deltaTokVal)} · ${tokVal > 0 ? short(tokVal) : '0'} ${isOpen ? '▴' : '▾'}`;
        } else {
          right.textContent = `${tokVal > 0 ? short(tokVal) : '0'} · ${pctVal ?? 0}% ${isOpen ? '▴' : '▾'}`;
        }
        hdr.appendChild(left);
        hdr.appendChild(right);
        hdr.addEventListener('click', () => {
          if (!state.expandedTreeCats) state.expandedTreeCats = new Set();
          if (state.expandedTreeCats.has(key)) state.expandedTreeCats.delete(key);
          else state.expandedTreeCats.add(key);
          state.ctxFocusedTreeCat = key;
          state.inspectorSelectedSliceId = null;
          renderSessionBentoSections();
        });
        wrap.appendChild(hdr);

        if (isOpen) {
          const body = document.createElement('div');
          body.className = 'ctx-tree-node-body';
          const list = Array.isArray(entriesList) ? entriesList : [];
          if (!list.length) {
            const noE = document.createElement('div');
            noE.className = 'ctx-tree-entry';
            noE.textContent = t('session.tree.noEntries');
            body.appendChild(noE);
          } else {
            for (const ent of list.slice(0, 24)) {
              const row = document.createElement('div');
              row.className = 'ctx-tree-entry';
              const pEl = document.createElement('span');
              pEl.className = 'ctx-tree-entry-preview';
              const safePrev = typeof sanitizeCompositionPreview === 'function' ? sanitizeCompositionPreview(ent.preview || ent.label, 96) : (ent.preview || ent.label);
              pEl.textContent = `S${ent.stepIndex ?? '?'} · ${safePrev || ent.label}`;
              pEl.title = safePrev || ent.label;

              const srcLbl = resolveInspectorSourceLabel(ent.sourceTag);
              const metaWrap = document.createElement('span');
              metaWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;';
              if (srcLbl) {
                const srcBadge = document.createElement('span');
                srcBadge.className = 'ctx-ov-meta-pill';
                srcBadge.textContent = srcLbl;
                metaWrap.appendChild(srcBadge);
              }
              const vEl = document.createElement('span');
              vEl.textContent = `≈${short(ent.tokens || 0)}`;
              metaWrap.appendChild(vEl);
              if (ent.stepIndex != null) {
                const jBtn = document.createElement('button');
                jBtn.type = 'button';
                jBtn.className = 'ctx-jump-step-btn';
                jBtn.textContent = `S${ent.stepIndex}`;
                jBtn.addEventListener('click', (ev) => {
                  ev?.stopPropagation?.();
                  jumpToStepOrTurn({ stepIndex: ent.stepIndex });
                });
                metaWrap.appendChild(jBtn);
              }
              row.appendChild(pEl);
              row.appendChild(metaWrap);
              row.addEventListener('click', () => {
                state.ctxFocusedTreeCat = key;
                state.inspectorSelectedEntry = ent;
                renderSessionBentoSections();
              });
              body.appendChild(row);
            }
          }
          wrap.appendChild(body);
        }
        return wrap;
      };

      for (const it of filteredItems) {
        treeListEl.appendChild(renderTreeNode(
          it.key,
          CTX_COMP_COLOR_MAP[it.key] || '#94a3b8',
          t(`session.comp.cat.${it.key}`),
          it.filteredEntries.length || it.count,
          it.median,
          it.pctOfUsed ?? it.pct,
          it.deltaTokens,
          it.filteredEntries
        ));
      }
      if (unaccTok > 0 && !searchQuery.trim() && asstSub === 'all') {
        const uPct = usedDenom > 0 ? Math.round((unaccTok / usedDenom) * 1000) / 10 : 0;
        treeListEl.appendChild(renderTreeNode(
          'unaccounted',
          '#94a3b8',
          t('session.dual.unaccounted'),
          1,
          unaccTok,
          uPct,
          null,
          [{ stepIndex: targetStepIndex, label: 'overhead', tokens: unaccTok, preview: t('session.dual.unaccountedTip') }]
        ));
      }
    }
  }

  const rawSlices = Array.isArray(breakdown?.sequentialSlices) ? breakdown.sequentialSlices : [];
  let displaySlices = filterAndSortInspectorEntries(rawSlices, { query: searchQuery, sortBy, asstSub });
  if (sortBy === 'order') {
    displaySlices = displaySlices.slice().reverse();
  }
  if (slicesListEl && viewMode === 'slices') {
    slicesListEl.replaceChildren();
    if (!displaySlices.length) {
      const emptySl = document.createElement('div');
      emptySl.className = 'timeline-turn-meta';
      emptySl.textContent = t('session.tree.noEntries');
      slicesListEl.appendChild(emptySl);
    } else {
      for (let i = 0; i < Math.min(80, displaySlices.length); i++) {
        const sl = displaySlices[i];
        const card = document.createElement('div');
        const isSel = state.inspectorSelectedSliceId === sl.id;
        card.className = `ctx-slice-card${isSel ? ' is-selected' : ''}`;
        card.setAttribute('data-slice-id', sl.id || `slice-${i}`);

        const top = document.createElement('div');
        top.className = 'ctx-slice-top';
        const leftWrap = document.createElement('span');
        leftWrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;min-width:0;';
        const seqTag = document.createElement('span');
        seqTag.className = 'ctx-ov-meta-pill';
        seqTag.textContent = `#${sl.seqOrder || i + 1}`;
        const catDot = document.createElement('i');
        catDot.className = 'key-seg-swatch';
        catDot.style.background = CTX_COMP_COLOR_MAP[sl.category] || '#94a3b8';
        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = sl.label || t(`session.comp.cat.${sl.category}`);
        leftWrap.appendChild(seqTag);
        leftWrap.appendChild(catDot);
        leftWrap.appendChild(nameEl);

        const rightWrap = document.createElement('span');
        rightWrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;flex-shrink:0;';
        const srcTxt = resolveInspectorSourceLabel(sl.sourceTag);
        if (srcTxt) {
          const srcSp = document.createElement('span');
          srcSp.className = 'ctx-ov-meta-pill';
          srcSp.textContent = srcTxt;
          rightWrap.appendChild(srcSp);
        }
        const tokSp = document.createElement('span');
        tokSp.textContent = `≈${short(sl.tokens || 0)}`;
        rightWrap.appendChild(tokSp);

        top.appendChild(leftWrap);
        top.appendChild(rightWrap);
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:10.5px;color:var(--ctx-ck-subtext);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        sub.textContent = sl.preview || '—';

        card.appendChild(top);
        card.appendChild(sub);
        card.addEventListener('click', () => {
          state.inspectorSelectedSliceId = sl.id;
          state.inspectorSelectedEntry = sl;
          state.ctxFocusedTreeCat = sl.category || state.ctxFocusedTreeCat;
          renderSessionBentoSections();
        });
        slicesListEl.appendChild(card);
      }
    }
  }

  const prevTitleEl = el('ctx-comp-preview-title');
  const prevMetaEl = el('ctx-comp-preview-meta');
  const prevBodyEl = el('ctx-comp-preview-body');
  if (prevBodyEl) {
    const previewNodes = [...(breakdown?.items || [])];
    if (unaccTok > 0) {
      previewNodes.push({
        key: 'unaccounted',
        median: unaccTok,
        count: 1,
        entries: [{ stepIndex: targetStepIndex, label: 'overhead', tokens: unaccTok, preview: t('session.dual.unaccountedTip') }]
      });
    }
    const chosenCat = previewNodes.find(n => n.key === state.ctxFocusedTreeCat)
      || previewNodes.find(n => n.median > 0 || (Array.isArray(n.entries) && n.entries.length > 0))
      || previewNodes[0]
      || null;
    prevBodyEl.replaceChildren();

    let previewEntries = [];
    if (viewMode === 'slices' && displaySlices.length) {
      const pickedSlice = displaySlices.find(s => s.id === state.inspectorSelectedSliceId) || displaySlices[0];
      if (prevTitleEl) prevTitleEl.textContent = `${pickedSlice.label || t(`session.comp.cat.${pickedSlice.category}`)} · #${pickedSlice.seqOrder || 1}`;
      if (prevMetaEl) prevMetaEl.textContent = `≈${short(pickedSlice.tokens || 0)} · ${pickedSlice.lineCount || 0} L`;
      previewEntries = [pickedSlice];
    } else if (!chosenCat) {
      if (prevTitleEl) prevTitleEl.textContent = t('session.tree.previewPlaceholder');
      if (prevMetaEl) prevMetaEl.textContent = '—';
    } else {
      const catTitle = chosenCat.key === 'unaccounted' ? t('session.dual.unaccounted') : t(`session.comp.cat.${chosenCat.key}`);
      if (prevTitleEl) prevTitleEl.textContent = t('session.tree.selectedHeader', { name: catTitle });
      const entries = filterAndSortInspectorEntries(chosenCat.entries || [], { query: searchQuery, sortBy });
      if (prevMetaEl) prevMetaEl.textContent = t('session.tree.previewCount', { n: short(chosenCat.median || 0), count: chosenCat.count ?? entries.length });
      previewEntries = entries.slice(0, 12);
    }

    const copyChunks = [];
    if (!previewEntries.length) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'timeline-turn-meta';
      emptyMsg.textContent = t('session.tree.noEntries');
      prevBodyEl.appendChild(emptyMsg);
    } else {
      for (const ent of previewEntries) {
        const box = document.createElement('div');
        box.className = 'ctx-comp-preview-entry';
        const top = document.createElement('div');
        top.className = 'ctx-comp-preview-entry-top';
        const lblSp = document.createElement('span');
        lblSp.textContent = ent.label || t(`session.comp.cat.${ent.category || 'system'}`);
        const rightWrap = document.createElement('span');
        rightWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        const srcText = resolveInspectorSourceLabel(ent.sourceTag);
        if (srcText) {
          const srcPill = document.createElement('span');
          srcPill.className = 'ctx-ov-meta-pill';
          srcPill.textContent = srcText;
          rightWrap.appendChild(srcPill);
        }
        const tokSp = document.createElement('span');
        tokSp.textContent = `≈${short(ent.tokens || 0)}`;
        rightWrap.appendChild(tokSp);
        if (ent.stepIndex != null) {
          const jBtn = document.createElement('button');
          jBtn.type = 'button';
          jBtn.className = 'ctx-jump-step-btn';
          jBtn.textContent = `S${ent.stepIndex}`;
          jBtn.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            jumpToStepOrTurn({ stepIndex: ent.stepIndex });
          });
          rightWrap.appendChild(jBtn);
        }
        top.appendChild(lblSp);
        top.appendChild(rightWrap);
        box.appendChild(top);

        const snippetRaw = typeof sanitizeCompositionPreview === 'function'
          ? sanitizeCompositionPreview(ent.fullSnippet || ent.preview || ent.label || '', 1200)
          : String(ent.fullSnippet || ent.preview || ent.label || '').slice(0, 1200);
        copyChunks.push(snippetRaw);
        if (previewMode === 'rendered') {
          const renBox = document.createElement('div');
          renBox.className = 'ctx-comp-preview-rendered';
          appendSafeRenderedSnippet(renBox, snippetRaw);
          box.appendChild(renBox);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'ctx-comp-preview-code';
          pre.textContent = snippetRaw.slice(0, 420);
          box.appendChild(pre);
        }
        prevBodyEl.appendChild(box);
      }
    }
    state.inspectorCurrentPreviewText = copyChunks.join('\n\n---\n\n');
  }

  const attBox = el('ctx-inspector-attachments');
  if (attBox) {
    const attList = Array.isArray(tl?.attachmentsDetail) && tl.attachmentsDetail.length
      ? tl.attachmentsDetail
      : (Array.isArray(state.scan?.session?.attachmentsDetail) ? state.scan.session.attachmentsDetail : []);
    attBox.replaceChildren();
    if (!attList.length) {
      attBox.hidden = true;
    } else {
      attBox.hidden = false;
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:10.5px;font-weight:600;color:var(--ctx-ck-subtext);margin-bottom:4px;grid-column:1 / -1;';
      hdr.textContent = `${t('session.inspector.attachmentsTitle')} · ${attList.length}`;
      attBox.appendChild(hdr);
      for (const att of attList.slice(0, 12)) {
        const card = document.createElement('div');
        card.className = 'ctx-att-card';
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;color:var(--ctx-ck-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        titleEl.textContent = att.name || 'attachment';
        const metaParts = [];
        if (att.mime) metaParts.push(att.mime);
        if (att.dimensions) metaParts.push(att.dimensions);
        if (att.sizeBytes > 0) metaParts.push(`${Math.max(1, Math.round(att.sizeBytes / 1024))}KB`);
        if (att.estimatedTokens > 0) metaParts.push(`≈${short(att.estimatedTokens)} tok`);
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size:10px;color:var(--ctx-ck-subtext);';
        metaEl.textContent = metaParts.join(' · ') || '—';
        card.appendChild(titleEl);
        card.appendChild(metaEl);
        attBox.appendChild(card);
      }
    }
  }
}

/**
 * 绑定上下文解剖台视图切换、搜索、排序、过滤、安全渲染与复制按钮事件。
 */
function initContextInspectorControls() {
  const bindBtn = (id, fn) => {
    const node = el(id);
    if (node && !node._inspectorBound) {
      node._inspectorBound = true;
      node.addEventListener('click', fn);
    }
  };

  bindBtn('btn-inspector-view-tree', () => {
    state.inspectorViewMode = 'tree';
    renderSessionBentoSections();
  });
  bindBtn('btn-inspector-view-slices', () => {
    state.inspectorViewMode = 'slices';
    renderSessionBentoSections();
  });
  bindBtn('btn-inspector-sort-size', () => {
    state.inspectorSortBy = 'size';
    renderSessionBentoSections();
  });
  bindBtn('btn-inspector-sort-order', () => {
    state.inspectorSortBy = 'order';
    renderSessionBentoSections();
  });
  bindBtn('btn-inspector-sort-name', () => {
    state.inspectorSortBy = 'name';
    renderSessionBentoSections();
  });
  bindBtn('ctx-comp-preview-mode-raw', () => {
    state.inspectorPreviewMode = 'raw';
    renderSessionBentoSections();
  });
  bindBtn('ctx-comp-preview-mode-render', () => {
    state.inspectorPreviewMode = 'rendered';
    renderSessionBentoSections();
  });

  const searchInp = el('inp-inspector-search');
  if (searchInp && !searchInp._inspectorBound) {
    searchInp._inspectorBound = true;
    searchInp.addEventListener('input', () => {
      state.inspectorSearchQuery = searchInp.value || '';
      renderSessionBentoSections();
    });
  }

  const asstWrap = el('ctx-inspector-asst-filters');
  if (asstWrap && !asstWrap._inspectorBound) {
    asstWrap._inspectorBound = true;
    asstWrap.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-asst-sub]');
      if (!btn) return;
      state.inspectorAsstSubFilter = btn.getAttribute('data-asst-sub') || 'all';
      renderSessionBentoSections();
    });
  }

  bindBtn('btn-comp-preview-copy', () => {
    const btn = el('btn-comp-preview-copy');
    const txt = String(state.inspectorCurrentPreviewText || '');
    if (!txt) return;
    try {
      navigator.clipboard?.writeText?.(txt);
    } catch { }
    if (btn) {
      btn.textContent = t('session.inspector.copiedBtn');
      if (inspectorCopyResetTimer) clearTimeout(inspectorCopyResetTimer);
      inspectorCopyResetTimer = setTimeout(() => {
        if (btn) btn.textContent = t('session.inspector.copyBtn');
      }, 1400);
    }
  });
}
