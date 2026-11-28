// =========================================================================
// 模块 3D: 多代理协作中枢 · 独立全视角「编队」视图 (renderAgentCollabInto) + 兼容旧驾驶舱组件
// =========================================================================

const COLLAB_STATUS_COLORS = {
  running: 'var(--ag-host-accent, var(--primary, #3274f6))',
  in_progress: 'var(--ag-host-accent, var(--primary, #3274f6))',
  pending: '#F59E0B',
  completed: '#10B981',
  failed: '#F43F5E'
};

const OM_COLLAB_STYLE_ID = 'ag-om-agent-collab-view-style';

const OM_COLLAB_I18N = {
  'zh-CN': {
    bannerTitle: '多 Agent 编队',
    bannerSub: '在同一时间线上观察主 Agent 与子 Agent 的实时上下文、协作泳道与委派任务',
    statAgents: 'Agent 数',
    statRunning: '运行中',
    statTasks: '工作项',
    statMessages: '消息数',
    networkTitle: 'Agent 网络',
    networkSub: '点击节点高亮并联动右侧协作记录与事件检查',
    currentTag: '当前',
    stepsSuffix: '步',
    turnsSuffix: '轮',
    emptySubagent: '还没有子 Agent · 当 Agent 通过 subagent 工具委派任务时，网络会在这里展开',
    crossTitle: '跨 Agent 协作',
    recordsLabel: '条记录',
    lanesLabel: '条泳道',
    sortOldest: '最早',
    sortNewest: '最新',
    searchAgent: '搜索 Agent',
    emptyCross: '这个编队还没有跨 Agent 事件',
    tasksTitle: '协作任务',
    tasksTotalSuffix: '个工作项',
    filterAll: '全部',
    statusRunning: '进行中',
    statusPending: '待处理',
    statusDone: '已完成',
    emptyTasks: '暂无任务 · 团队任务与子 Agent 委派会在这里出现',
    eventsTitle: '事件检查',
    filterMsg: '消息',
    filterReport: '回报',
    filterDelegate: '委派',
    searchEvent: '搜索事件',
    emptyEvents: '这个编队还没有跨 Agent 事件',
    selectEventHint: '选择左侧事件节点查看完整记录',
    mainAgentFallback: '主 Agent'
  },
  'zh-TW': {
    bannerTitle: '多 Agent 編隊',
    bannerSub: '在同一時間線上觀察主 Agent 與子 Agent 的即時上下文、協作泳道與委派任務',
    statAgents: 'Agent 數',
    statRunning: '執行中',
    statTasks: '工作項',
    statMessages: '訊息數',
    networkTitle: 'Agent 網路',
    networkSub: '點擊節點高亮並聯動右側協作記錄與事件檢查',
    currentTag: '目前',
    stepsSuffix: '步',
    turnsSuffix: '輪',
    emptySubagent: '還沒有子 Agent · 當 Agent 透過 subagent 工具委派任務時，網路會在這裡展開',
    crossTitle: '跨 Agent 協作',
    recordsLabel: '筆記錄',
    lanesLabel: '條泳道',
    sortOldest: '最早',
    sortNewest: '最新',
    searchAgent: '搜尋 Agent',
    emptyCross: '這個編隊還沒有跨 Agent 事件',
    tasksTitle: '協作任務',
    tasksTotalSuffix: '個工作項',
    filterAll: '全部',
    statusRunning: '進行中',
    statusPending: '待處理',
    statusDone: '已完成',
    emptyTasks: '暫無任務 · 團隊任務與子 Agent 委派會在這裡出現',
    eventsTitle: '事件檢查',
    filterMsg: '訊息',
    filterReport: '回報',
    filterDelegate: '委派',
    searchEvent: '搜尋事件',
    emptyEvents: '這個編隊還沒有跨 Agent 事件',
    selectEventHint: '選擇左側事件節點查看完整記錄',
    mainAgentFallback: '主 Agent'
  },
  en: {
    bannerTitle: 'Multi-Agent Squad',
    bannerSub: 'Observe live context, collaboration lanes, and delegated tasks on one timeline',
    statAgents: 'Agents',
    statRunning: 'Running',
    statTasks: 'Work Items',
    statMessages: 'Messages',
    networkTitle: 'Agent Network',
    networkSub: 'Click any node to highlight and filter collaboration panels',
    currentTag: 'Active',
    stepsSuffix: 'steps',
    turnsSuffix: 'turns',
    emptySubagent: 'No subagents yet · The network expands here when the agent delegates via subagent tools',
    crossTitle: 'Cross-Agent Collaboration',
    recordsLabel: 'records',
    lanesLabel: 'lanes',
    sortOldest: 'Oldest',
    sortNewest: 'Newest',
    searchAgent: 'Search agent',
    emptyCross: 'No cross-agent events in this squad yet',
    tasksTitle: 'Collaboration Tasks',
    tasksTotalSuffix: 'items',
    filterAll: 'All',
    statusRunning: 'In Progress',
    statusPending: 'Pending',
    statusDone: 'Completed',
    emptyTasks: 'No tasks yet · Delegated work items appear here',
    eventsTitle: 'Event Inspector',
    filterMsg: 'Message',
    filterReport: 'Report',
    filterDelegate: 'Delegate',
    searchEvent: 'Search events',
    emptyEvents: 'No cross-agent events in this squad yet',
    selectEventHint: 'Select an event on the left to inspect full details',
    mainAgentFallback: 'Main Agent'
  }
};

function omCollabResolveLang(lang) {
  const raw = String(lang || (typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : 'zh-CN') || 'zh-CN').toLowerCase();
  if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('en')) return 'en';
  return 'zh-CN';
}

function omCollabShort(n) {
  if (typeof short === 'function') return short(n);
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function omCollabDur(sec) {
  const v = Number(sec || 0);
  if (!Number.isFinite(v) || v <= 0) return '0s';
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)}s`;
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function omCollabEnsureStyles(containerEl) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const root = typeof containerEl.getRootNode === 'function' ? containerEl.getRootNode() : doc;
  const target = root && root.nodeType === 11 ? root : (doc.head || containerEl);
  if (!target || target.querySelector?.(`#${OM_COLLAB_STYLE_ID}`)) return;
  const st = doc.createElement('style');
  st.id = OM_COLLAB_STYLE_ID;
  st.setAttribute('data-om-view-style', 'collab');
  st.textContent = `
    .om-collab-scroll {
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
    .om-collab-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--om-accent) 30%, var(--om-border));
      background: linear-gradient(120deg, color-mix(in srgb, var(--om-accent) 12%, transparent), var(--om-card));
    }
    .om-collab-banner-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--om-text);
    }
    .om-collab-banner-sub {
      font-size: 11.5px;
      color: var(--om-muted);
      margin-top: 3px;
    }
    .om-collab-stat-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(66px, auto));
      gap: 8px;
    }
    .om-collab-stat-card {
      padding: 7px 12px;
      border-radius: 8px;
      border: 1px solid var(--om-border);
      background: var(--om-card);
      text-align: center;
    }
    .om-collab-stat-lbl {
      font-size: 10.5px;
      color: var(--om-muted);
    }
    .om-collab-stat-val {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--om-text);
    }
    .om-collab-mid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
      gap: 12px;
      min-width: 0;
    }
    @media (max-width: 880px) {
      .om-collab-mid { grid-template-columns: minmax(0, 1fr); }
    }
    .om-collab-card {
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
    .om-collab-card-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .om-collab-card-title {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--om-text);
    }
    .om-collab-subtle {
      font-size: 11px;
      color: var(--om-muted);
      font-variant-numeric: tabular-nums;
    }
    .om-collab-canvas {
      flex: 1 1 auto;
      min-height: 210px;
      border-radius: 8px;
      border: 1px dashed var(--om-border);
      background: rgba(148, 163, 184, 0.025);
      padding: 18px 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }
    .om-collab-nodes-grid {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
      width: 100%;
    }
    .om-collab-node {
      width: 230px;
      max-width: 100%;
      padding: 10px 12px;
      border-radius: 9px;
      border: 1px solid var(--om-border);
      background: var(--om-bg);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .om-collab-node:hover {
      border-color: color-mix(in srgb, var(--om-accent) 55%, transparent);
    }
    .om-collab-node.is-selected {
      border-color: var(--om-accent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--om-accent) 45%, transparent);
    }
    .om-collab-node-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .om-collab-node-title {
      font-weight: 600;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .om-collab-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--om-accent) 16%, transparent);
      color: var(--om-accent);
      flex-shrink: 0;
    }
    .om-collab-mini-bar {
      width: 100%;
      height: 5px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      overflow: hidden;
      display: flex;
    }
    .om-collab-right-stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .om-collab-seg {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex-wrap: wrap;
    }
    .om-collab-pill {
      appearance: none;
      border: 1px solid var(--om-border);
      background: transparent;
      color: var(--om-muted);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
    }
    .om-collab-pill.is-active {
      background: color-mix(in srgb, var(--om-accent) 18%, transparent);
      border-color: color-mix(in srgb, var(--om-accent) 48%, transparent);
      color: var(--om-text);
      font-weight: 600;
    }
    .om-collab-input {
      height: 25px;
      width: 150px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--om-border);
      background: var(--om-surface);
      color: var(--om-text);
      font-size: 11px;
      outline: none;
      box-sizing: border-box;
    }
    .om-collab-input:focus { border-color: var(--om-accent); }
    .om-collab-empty {
      padding: 18px 12px;
      text-align: center;
      color: var(--om-muted);
      font-size: 11.5px;
    }
    .om-collab-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 180px;
      overflow-y: auto;
    }
    .om-collab-row {
      padding: 7px 9px;
      border-radius: 7px;
      background: var(--om-surface);
      border: 1px solid transparent;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .om-collab-row.is-active {
      border-color: color-mix(in srgb, var(--om-accent) 55%, transparent);
      background: color-mix(in srgb, var(--om-accent) 12%, transparent);
    }
    .om-collab-events-split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
      gap: 12px;
      min-height: 150px;
    }
    @media (max-width: 820px) {
      .om-collab-events-split { grid-template-columns: minmax(0, 1fr); }
    }
    .om-collab-detail-box {
      border-radius: 8px;
      border: 1px solid var(--om-border);
      background: rgba(148, 163, 184, 0.03);
      padding: 12px;
      min-height: 130px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .om-collab-pre {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--om-text);
      max-height: 220px;
      overflow-y: auto;
    }
  `;
  target.appendChild(st);
}

function omCollabNormalizeData(data, copy) {
  const src = data && typeof data === 'object' ? data : {};
  const tl = src.timeline || src.tl || src;
  const hub = src.agentCollabHub || tl?.agentCollabHub || tl?.agentFleetSummary || null;
  const latest = src.latest || tl?.latest || null;
  const turns = Array.isArray(tl?.turns) ? tl.turns : [];
  const subagents = Array.isArray(hub?.subagents) ? hub.subagents.filter(Boolean) : [];
  const delegatedTasks = Array.isArray(hub?.delegatedTasks) ? hub.delegatedTasks.filter(Boolean) : [];
  const receipts = Array.isArray(hub?.interactionReceipts) ? hub.interactionReceipts.filter(Boolean) : [];
  const rawTimeline = Array.isArray(hub?.collaborationTimeline) ? hub.collaborationTimeline.filter(Boolean) : [];
  const crossEvents = rawTimeline.filter(e => e.kind !== 'main_call' || subagents.length > 0);

  const used = Number(latest?.actual ?? latest?.postCompactEstimate ?? src.contextUsed ?? 0);
  const budget = Number(latest?.budget ?? latest?.serviceLimit ?? src.contextBudget ?? 0);
  const mainCtxPct = budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : null;

  const mainRaw = hub?.mainAgent || null;
  const mainNode = {
    id: 'main',
    role: 'main',
    title: String(src.sessionTitle || tl?.sessionTitle || mainRaw?.title || copy.mainAgentFallback),
    modelLabel: String(mainRaw?.modelLabel || latest?.modelLabel || 'Main'),
    status: String(mainRaw?.status || 'completed'),
    totalTokens: Number(mainRaw?.totalTokens ?? tl?.sessionTokenTotals?.totalTokens ?? 0),
    inputTokens: Number(mainRaw?.inputTokens ?? tl?.sessionTokenTotals?.inputTokens ?? 0),
    cacheReadTokens: Number(mainRaw?.cacheReadTokens ?? tl?.sessionTokenTotals?.cacheReadTokens ?? 0),
    outputTokens: Number(mainRaw?.outputTokens ?? tl?.sessionTokenTotals?.outputTokens ?? 0),
    turnCount: Number(mainRaw?.turnCount ?? turns.length ?? 0),
    stepCount: Number(mainRaw?.callCount ?? mainRaw?.stepCount ?? 0),
    durationSec: mainRaw?.durationSec ?? null,
    ctxPct: mainCtxPct,
    isMain: true
  };

  const subNodes = subagents.map((s, idx) => ({
    id: String(s.childCid || s.role || `sub-${idx}`),
    role: String(s.role || s.type || `subagent-${idx + 1}`),
    title: String(s.title || s.role || s.type || `subagent-${idx + 1}`),
    modelLabel: String(s.modelLabel || s.type || 'Subagent'),
    status: String(s.status || 'completed'),
    totalTokens: Number(s.totalTokens || 0),
    inputTokens: Number(s.inputTokens || 0),
    cacheReadTokens: Number(s.cacheReadTokens || 0),
    outputTokens: Number(s.outputTokens || 0),
    turnCount: Number(s.turnCount || 0),
    stepCount: Number(s.callCount || s.stepCount || 0),
    durationSec: s.durationSec ?? null,
    ctxPct: s.contextPct != null ? Number(s.contextPct) : null,
    isMain: false
  }));

  const nodes = [mainNode, ...subNodes];
  const runningCount = nodes.filter(n => n.status === 'running' || n.status === 'in_progress').length;

  return {
    nodes,
    subagents: subNodes,
    hasSubagents: subNodes.length > 0,
    runningCount,
    delegatedTasks,
    receipts,
    crossEvents
  };
}

/**
 * 阶段四统一契约：将完整「编队」视图渲染到任意独立滚动容器。
 * 对照参考图 2026-11-27_09-25-47.png 与任务书 5.5 节。
 */
function renderAgentCollabInto(containerEl, data, opts = {}) {
  if (!containerEl) return null;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  if (containerEl.__omCollabCtrl && typeof containerEl.__omCollabCtrl.update === 'function') {
    containerEl.__omCollabCtrl.update(data, opts);
    return containerEl.__omCollabCtrl;
  }

  omCollabEnsureStyles(containerEl);

  const st = {
    lang: omCollabResolveLang(opts.lang),
    active: opts.active !== false,
    disposed: false,
    data: data || null,
    opts: { ...opts },
    selectedAgentId: null,
    crossSort: 'oldest',    // 'oldest' | 'newest'
    crossQuery: '',
    taskFilter: 'all',      // 'all' | 'in_progress' | 'pending' | 'completed'
    eventFilter: 'all',     // 'all' | 'message' | 'report' | 'delegate'
    eventQuery: '',
    selectedEventId: null
  };

  const scrollRoot = doc.createElement('div');
  scrollRoot.className = 'om-collab-scroll';
  scrollRoot.setAttribute('data-om-session-view-body', 'collab');
  scrollRoot.setAttribute('data-om-view-scroll', 'collab');
  containerEl.replaceChildren(scrollRoot);

  function classifyEventKind(ev) {
    const k = String(ev?.kind || ev?.type || '').toLowerCase();
    if (k.includes('delegate') || k.includes('spawn') || k.includes('dispatch')) return 'delegate';
    if (k.includes('report') || k.includes('result') || k.includes('return')) return 'report';
    return 'message';
  }

  function classifyTaskStatus(tk) {
    const s = String(tk?.status || '').toLowerCase();
    if (s === 'in_progress' || s === 'running') return 'in_progress';
    if (s === 'pending' || s === 'queued') return 'pending';
    return 'completed';
  }

  function renderAll() {
    if (st.disposed) return;
    const copy = OM_COLLAB_I18N[st.lang] || OM_COLLAB_I18N['zh-CN'];
    const snap = omCollabNormalizeData(st.data, copy);
    const prevTop = scrollRoot.scrollTop;

    const frag = doc.createDocumentFragment();

    // 1. 顶部多 Agent 编队概览条（4 计数：Agent 数 / 运行中 / 工作项 / 消息数）
    const banner = doc.createElement('section');
    banner.className = 'om-collab-banner';
    banner.setAttribute('data-om-collab-banner', 'true');
    const bLeft = doc.createElement('div');
    const bTitle = doc.createElement('div');
    bTitle.className = 'om-collab-banner-title';
    bTitle.textContent = copy.bannerTitle;
    const bSub = doc.createElement('div');
    bSub.className = 'om-collab-banner-sub';
    bSub.textContent = copy.bannerSub;
    bLeft.appendChild(bTitle);
    bLeft.appendChild(bSub);

    const statGrid = doc.createElement('div');
    statGrid.className = 'om-collab-stat-grid';
    for (const [k, v] of [
      [copy.statAgents, snap.nodes.length],
      [copy.statRunning, snap.runningCount],
      [copy.statTasks, snap.delegatedTasks.length],
      [copy.statMessages, snap.receipts.length]
    ]) {
      const sc = doc.createElement('div');
      sc.className = 'om-collab-stat-card';
      const l = doc.createElement('div');
      l.className = 'om-collab-stat-lbl';
      l.textContent = k;
      const val = doc.createElement('div');
      val.className = 'om-collab-stat-val';
      val.textContent = String(v);
      sc.appendChild(l);
      sc.appendChild(val);
      statGrid.appendChild(sc);
    }
    banner.appendChild(bLeft);
    banner.appendChild(statGrid);
    frag.appendChild(banner);

    // 2. 中部左右双列
    const mid = doc.createElement('div');
    mid.className = 'om-collab-mid';

    // 2A. 中部左：Agent 网络拓扑画布
    const netCard = doc.createElement('section');
    netCard.className = 'om-collab-card';
    netCard.setAttribute('data-om-collab-network', 'true');
    const netHdr = doc.createElement('div');
    netHdr.className = 'om-collab-card-hdr';
    const netT = doc.createElement('div');
    netT.className = 'om-collab-card-title';
    netT.textContent = copy.networkTitle;
    const netSub = doc.createElement('span');
    netSub.className = 'om-collab-subtle';
    netSub.textContent = copy.networkSub;
    netHdr.appendChild(netT);
    netHdr.appendChild(netSub);
    netCard.appendChild(netHdr);

    const canvas = doc.createElement('div');
    canvas.className = 'om-collab-canvas';
    const nodesGrid = doc.createElement('div');
    nodesGrid.className = 'om-collab-nodes-grid';

    for (const ag of snap.nodes) {
      const isSel = st.selectedAgentId === ag.id || st.selectedAgentId === ag.role;
      const card = doc.createElement('div');
      card.className = `om-collab-node${isSel ? ' is-selected' : ''}`;
      card.setAttribute('data-om-collab-node', ag.id);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      const top = doc.createElement('div');
      top.className = 'om-collab-node-top';
      const ttl = doc.createElement('span');
      ttl.className = 'om-collab-node-title';
      ttl.textContent = ag.title;
      ttl.title = ag.title;
      top.appendChild(ttl);
      if (ag.isMain) {
        const badge = doc.createElement('span');
        badge.className = 'om-collab-badge';
        badge.textContent = copy.currentTag;
        top.appendChild(badge);
      }

      const usageLine = doc.createElement('div');
      usageLine.className = 'om-collab-subtle';
      usageLine.textContent = `${omCollabShort(ag.totalTokens)} tok · ${ag.modelLabel}`;

      const bar = doc.createElement('div');
      bar.className = 'om-collab-mini-bar';
      const tot = Math.max(1, ag.inputTokens + ag.cacheReadTokens + ag.outputTokens);
      for (const [col, val] of [
        ['#10B981', ag.inputTokens],
        ['#F59E0B', ag.cacheReadTokens],
        ['var(--ag-host-accent, var(--primary, #3274f6))', ag.outputTokens]
      ]) {
        if (val <= 0) continue;
        const seg = doc.createElement('div');
        seg.style.width = `${Math.max(3, (val / tot) * 100).toFixed(1)}%`;
        seg.style.background = col;
        bar.appendChild(seg);
      }

      const foot = doc.createElement('div');
      foot.className = 'om-collab-node-top om-collab-subtle';
      const leftF = doc.createElement('span');
      const durTxt = ag.durationSec != null ? `${omCollabDur(ag.durationSec)} · ` : '';
      leftF.textContent = `${durTxt}${ag.turnCount} ${copy.turnsSuffix} · ${ag.stepCount} ${copy.stepsSuffix}`;
      const rightF = doc.createElement('span');
      rightF.style.color = '#10B981';
      rightF.textContent = ag.ctxPct != null ? `${ag.ctxPct}%` : '--%';
      foot.appendChild(leftF);
      foot.appendChild(rightF);

      card.appendChild(top);
      card.appendChild(usageLine);
      card.appendChild(bar);
      card.appendChild(foot);
      card.addEventListener('click', () => {
        st.selectedAgentId = isSel ? null : ag.role;
        renderAll();
      });
      nodesGrid.appendChild(card);
    }
    canvas.appendChild(nodesGrid);

    if (!snap.hasSubagents) {
      const hint = doc.createElement('div');
      hint.className = 'om-collab-empty';
      hint.setAttribute('data-om-collab-empty-subagent', 'true');
      hint.textContent = copy.emptySubagent;
      canvas.appendChild(hint);
    }
    netCard.appendChild(canvas);

    // 2B. 中部右上下叠：跨 Agent 协作 + 协作任务
    const rightStack = doc.createElement('div');
    rightStack.className = 'om-collab-right-stack';

    // Top: 跨 Agent 协作
    const crossCard = doc.createElement('section');
    crossCard.className = 'om-collab-card';
    crossCard.setAttribute('data-om-collab-swimlane', 'true');
    const cHdr = doc.createElement('div');
    cHdr.className = 'om-collab-card-hdr';
    const cTitle = doc.createElement('div');
    cTitle.className = 'om-collab-card-title';
    cTitle.textContent = copy.crossTitle;

    const cTools = doc.createElement('div');
    cTools.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const cMeta = doc.createElement('span');
    cMeta.className = 'om-collab-subtle';
    cMeta.textContent = `${snap.crossEvents.length} ${copy.recordsLabel} · ${snap.nodes.length} ${copy.lanesLabel}`;
    const cSearch = doc.createElement('input');
    cSearch.type = 'search';
    cSearch.className = 'om-collab-input';
    cSearch.placeholder = copy.searchAgent;
    cSearch.value = st.crossQuery;
    cSearch.addEventListener('input', () => {
      st.crossQuery = String(cSearch.value || '');
      renderAll();
    });
    const sortSeg = doc.createElement('div');
    sortSeg.className = 'om-collab-seg';
    for (const [sv, sl] of [['oldest', copy.sortOldest], ['newest', copy.sortNewest]]) {
      const sb = doc.createElement('button');
      sb.type = 'button';
      sb.className = `om-collab-pill${st.crossSort === sv ? ' is-active' : ''}`;
      sb.textContent = sl;
      sb.addEventListener('click', () => {
        st.crossSort = sv;
        renderAll();
      });
      sortSeg.appendChild(sb);
    }
    cTools.appendChild(cMeta);
    cTools.appendChild(cSearch);
    cTools.appendChild(sortSeg);
    cHdr.appendChild(cTitle);
    cHdr.appendChild(cTools);
    crossCard.appendChild(cHdr);

    const cq = st.crossQuery.trim().toLowerCase();
    let visCross = snap.crossEvents.filter(ev => {
      if (st.selectedAgentId && ev.role !== st.selectedAgentId && ev.agentId !== st.selectedAgentId) return false;
      if (!cq) return true;
      return `${ev.role || ''} ${ev.detail || ''}`.toLowerCase().includes(cq);
    });
    if (st.crossSort === 'newest') visCross = visCross.slice().reverse();

    if (!visCross.length) {
      const em = doc.createElement('div');
      em.className = 'om-collab-empty';
      em.textContent = copy.emptyCross;
      crossCard.appendChild(em);
    } else {
      const list = doc.createElement('div');
      list.className = 'om-collab-list';
      for (const ev of visCross.slice(0, 40)) {
        const row = doc.createElement('div');
        row.className = 'om-collab-row';
        const top = doc.createElement('div');
        top.className = 'om-collab-node-top';
        const l = doc.createElement('strong');
        l.textContent = `S${ev.stepIndex ?? '?'} · ${ev.role || 'agent'}`;
        const r = doc.createElement('span');
        r.className = 'om-collab-subtle';
        r.textContent = ev.totalTokens > 0 ? `${omCollabShort(ev.totalTokens)} tok` : (ev.durationSec ? omCollabDur(ev.durationSec) : String(ev.status || ''));
        top.appendChild(l);
        top.appendChild(r);
        const det = doc.createElement('div');
        det.className = 'om-collab-subtle';
        det.textContent = ev.detail || '—';
        row.appendChild(top);
        row.appendChild(det);
        list.appendChild(row);
      }
      crossCard.appendChild(list);
    }

    // Bottom: 协作任务（进行中 / 待处理 / 已完成 三态计数）
    const tasksCard = doc.createElement('section');
    tasksCard.className = 'om-collab-card';
    tasksCard.setAttribute('data-om-collab-tasks', 'true');
    const tHdr = doc.createElement('div');
    tHdr.className = 'om-collab-card-hdr';
    const tTitle = doc.createElement('div');
    tTitle.className = 'om-collab-card-title';
    tTitle.textContent = copy.tasksTitle;
    const tTotal = doc.createElement('span');
    tTotal.className = 'om-collab-subtle';
    tTotal.textContent = `${snap.delegatedTasks.length} ${copy.tasksTotalSuffix}`;
    tHdr.appendChild(tTitle);
    tHdr.appendChild(tTotal);
    tasksCard.appendChild(tHdr);

    const taskCounts = { in_progress: 0, pending: 0, completed: 0 };
    for (const tk of snap.delegatedTasks) taskCounts[classifyTaskStatus(tk)]++;
    const tFilterSeg = doc.createElement('div');
    tFilterSeg.className = 'om-collab-seg';
    for (const [fk, fl, fc] of [
      ['all', copy.filterAll, snap.delegatedTasks.length],
      ['in_progress', copy.statusRunning, taskCounts.in_progress],
      ['pending', copy.statusPending, taskCounts.pending],
      ['completed', copy.statusDone, taskCounts.completed]
    ]) {
      const pb = doc.createElement('button');
      pb.type = 'button';
      pb.className = `om-collab-pill${st.taskFilter === fk ? ' is-active' : ''}`;
      pb.setAttribute('data-om-task-filter', fk);
      pb.textContent = `${fl} ${fc}`;
      pb.addEventListener('click', () => {
        st.taskFilter = fk;
        renderAll();
      });
      tFilterSeg.appendChild(pb);
    }
    tasksCard.appendChild(tFilterSeg);

    const visTasks = snap.delegatedTasks.filter(tk => {
      if (st.selectedAgentId && tk.role !== st.selectedAgentId) return false;
      if (st.taskFilter !== 'all' && classifyTaskStatus(tk) !== st.taskFilter) return false;
      return true;
    });
    if (!visTasks.length) {
      const em = doc.createElement('div');
      em.className = 'om-collab-empty';
      em.textContent = copy.emptyTasks;
      tasksCard.appendChild(em);
    } else {
      const tList = doc.createElement('div');
      tList.className = 'om-collab-list';
      for (const tk of visTasks.slice(0, 30)) {
        const row = doc.createElement('div');
        row.className = 'om-collab-row';
        const top = doc.createElement('div');
        top.className = 'om-collab-node-top';
        const l = doc.createElement('strong');
        l.textContent = `${tk.role || 'task'} · ${tk.type || ''}`;
        const stKey = classifyTaskStatus(tk);
        const pill = doc.createElement('span');
        pill.className = 'om-collab-badge';
        pill.textContent = stKey === 'in_progress' ? copy.statusRunning : (stKey === 'pending' ? copy.statusPending : copy.statusDone);
        top.appendChild(l);
        top.appendChild(pill);
        const sum = doc.createElement('div');
        sum.className = 'om-collab-subtle';
        sum.textContent = tk.summary || '—';
        row.appendChild(top);
        row.appendChild(sum);
        tList.appendChild(row);
      }
      tasksCard.appendChild(tList);
    }

    rightStack.appendChild(crossCard);
    rightStack.appendChild(tasksCard);
    mid.appendChild(netCard);
    mid.appendChild(rightStack);
    frag.appendChild(mid);

    // 3. 底部通栏：事件检查（左 4 筛选 + 列表，右详情预览）
    const evCard = doc.createElement('section');
    evCard.className = 'om-collab-card';
    evCard.setAttribute('data-om-collab-events', 'true');
    const eHdr = doc.createElement('div');
    eHdr.className = 'om-collab-card-hdr';
    const eTitle = doc.createElement('div');
    eTitle.className = 'om-collab-card-title';
    eTitle.textContent = copy.eventsTitle;

    const evCounts = { message: 0, report: 0, delegate: 0 };
    for (const rc of snap.receipts) evCounts[classifyEventKind(rc)]++;
    const eSeg = doc.createElement('div');
    eSeg.className = 'om-collab-seg';
    for (const [ek, elbl, ec] of [
      ['all', copy.filterAll, snap.receipts.length],
      ['message', copy.filterMsg, evCounts.message],
      ['report', copy.filterReport, evCounts.report],
      ['delegate', copy.filterDelegate, evCounts.delegate]
    ]) {
      const eb = doc.createElement('button');
      eb.type = 'button';
      eb.className = `om-collab-pill${st.eventFilter === ek ? ' is-active' : ''}`;
      eb.setAttribute('data-om-event-filter', ek);
      eb.textContent = `${elbl} ${ec}`;
      eb.addEventListener('click', () => {
        st.eventFilter = ek;
        renderAll();
      });
      eSeg.appendChild(eb);
    }
    const eSearch = doc.createElement('input');
    eSearch.type = 'search';
    eSearch.className = 'om-collab-input';
    eSearch.placeholder = copy.searchEvent;
    eSearch.value = st.eventQuery;
    eSearch.addEventListener('input', () => {
      st.eventQuery = String(eSearch.value || '');
      renderAll();
    });
    const eTools = doc.createElement('div');
    eTools.style.cssText = 'display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;';
    eTools.appendChild(eSeg);
    eTools.appendChild(eSearch);
    eHdr.appendChild(eTitle);
    eHdr.appendChild(eTools);
    evCard.appendChild(eHdr);

    const eq = st.eventQuery.trim().toLowerCase();
    const visReceipts = snap.receipts.filter(rc => {
      if (st.selectedAgentId && rc.fromAgent !== st.selectedAgentId && rc.toAgent !== st.selectedAgentId) return false;
      if (st.eventFilter !== 'all' && classifyEventKind(rc) !== st.eventFilter) return false;
      if (!eq) return true;
      return `${rc.fromAgent || ''} ${rc.toAgent || ''} ${rc.summary || ''} ${rc.detail || ''}`.toLowerCase().includes(eq);
    });

    const evSplit = doc.createElement('div');
    evSplit.className = 'om-collab-events-split';

    const evLeft = doc.createElement('div');
    if (!visReceipts.length) {
      const em = doc.createElement('div');
      em.className = 'om-collab-empty';
      em.textContent = copy.emptyEvents;
      evLeft.appendChild(em);
    } else {
      const eList = doc.createElement('div');
      eList.className = 'om-collab-list';
      for (const rc of visReceipts.slice(0, 50)) {
        const rid = String(rc.id || `${rc.fromAgent}-${rc.toAgent}-${rc.stepIndex}`);
        const isSel = st.selectedEventId === rid || (!st.selectedEventId && visReceipts[0] === rc);
        const row = doc.createElement('div');
        row.className = `om-collab-row${isSel ? ' is-active' : ''}`;
        row.setAttribute('data-om-collab-event-row', rid);
        const top = doc.createElement('div');
        top.className = 'om-collab-node-top';
        const route = doc.createElement('strong');
        route.textContent = `${rc.fromAgent || 'main'} -> ${rc.toAgent || 'subagent'}`;
        const meta = doc.createElement('span');
        meta.className = 'om-collab-subtle';
        meta.textContent = `S${rc.stepIndex ?? '?'} · ${rc.kind || 'msg'}`;
        top.appendChild(route);
        top.appendChild(meta);
        const sum = doc.createElement('div');
        sum.className = 'om-collab-subtle';
        sum.textContent = rc.summary || '—';
        row.appendChild(top);
        row.appendChild(sum);
        row.addEventListener('click', () => {
          st.selectedEventId = rid;
          renderAll();
        });
        eList.appendChild(row);
      }
      evLeft.appendChild(eList);
    }

    const evRight = doc.createElement('div');
    evRight.className = 'om-collab-detail-box';
    evRight.setAttribute('data-om-collab-event-detail', 'true');
    const activeRc = visReceipts.find(rc => String(rc.id || `${rc.fromAgent}-${rc.toAgent}-${rc.stepIndex}`) === st.selectedEventId) || visReceipts[0] || null;
    if (!activeRc) {
      const em = doc.createElement('div');
      em.className = 'om-collab-empty';
      em.textContent = copy.selectEventHint;
      evRight.appendChild(em);
    } else {
      const dTop = doc.createElement('strong');
      dTop.textContent = `${activeRc.fromAgent || 'main'} -> ${activeRc.toAgent || 'subagent'} · S${activeRc.stepIndex ?? '?'}`;
      const pre = doc.createElement('pre');
      pre.className = 'om-collab-pre';
      pre.textContent = activeRc.detail || activeRc.summary || '—';
      evRight.appendChild(dTop);
      evRight.appendChild(pre);
    }

    evSplit.appendChild(evLeft);
    evSplit.appendChild(evRight);
    evCard.appendChild(evSplit);
    frag.appendChild(evCard);

    scrollRoot.replaceChildren(frag);
    scrollRoot.scrollTop = prevTop;
  }

  function setActive(active) {
    st.active = Boolean(active);
    if (st.active && !st.disposed) renderAll();
  }

  function setLang(nextLang) {
    st.lang = omCollabResolveLang(nextLang);
    if (!st.disposed) renderAll();
  }

  function update(nextData, nextOpts = {}) {
    if (st.disposed) return;
    st.data = nextData;
    if (nextOpts && typeof nextOpts === 'object') {
      st.opts = { ...st.opts, ...nextOpts };
      if (nextOpts.lang) st.lang = omCollabResolveLang(nextOpts.lang);
      if (typeof nextOpts.active === 'boolean') st.active = nextOpts.active;
    }
    if (st.active) renderAll();
  }

  function cleanup() {
    if (st.disposed) return;
    st.disposed = true;
    st.active = false;
    if (containerEl.__omCollabCtrl === handle) {
      delete containerEl.__omCollabCtrl;
    }
  }

  const handle = {
    update,
    setActive,
    setLang,
    cleanup,
    destroy: cleanup,
    getState: () => ({
      lang: st.lang,
      active: st.active,
      selectedAgentId: st.selectedAgentId,
      taskFilter: st.taskFilter,
      eventFilter: st.eventFilter
    })
  };

  containerEl.__omCollabCtrl = handle;
  renderAll();
  return handle;
}

if (typeof window !== 'undefined') {
  window.renderAgentCollabInto = renderAgentCollabInto;
}

// =========================================================================
// 兼容旧驾驶舱 Widget 导出（保留以保障既有单测 100% 通过）
// =========================================================================

/**
 * 格式化多代理节点状态文案，保持无括号简洁语义。
 */
function resolveCollabTaskStatusLabel(statusVal) {
  const s = String(statusVal || '').toLowerCase();
  if (s === 'in_progress' || s === 'running') return t('session.collab.taskInProgress');
  if (s === 'pending' || s === 'queued') return t('session.collab.taskPending');
  if (s === 'failed' || s === 'error') return 'ERR';
  return t('session.collab.taskCompleted');
}

/**
 * 构建轻量内联输入/缓存/输出三段微条，直观对比主代理与子代理上下文形态。
 */
function buildCollabMiniBar(inpTok, cacheTok, outTok) {
  const bar = document.createElement('div');
  bar.className = 'csi-archive-bar';
  const tot = Math.max(1, Number(inpTok || 0) + Number(cacheTok || 0) + Number(outTok || 0));
  const segs = [
    ['#10B981', (Number(inpTok || 0) / tot) * 100],
    ['#FB923C', (Number(cacheTok || 0) / tot) * 100],
    ['var(--ag-host-accent, var(--primary, #3274f6))', (Number(outTok || 0) / tot) * 100]
  ];
  for (const [col, pct] of segs) {
    if (pct <= 0) continue;
    const d = document.createElement('div');
    d.style.cssText = `width:${Math.max(2, pct).toFixed(1)}%;background:${col};height:100%;`;
    bar.appendChild(d);
  }
  return bar;
}

/**
 * 渲染多代理协作中枢：含顶部聚合条、主子拓扑卡片、跨代理泳道、委派任务列表与回执双栏详情。
 */
function renderAgentCollabHubWidget(tl) {
  const countPill = el('ctx-collab-count-pill');
  const summaryStrip = el('ctx-collab-summary-strip');
  const emptyBox = el('ctx-collab-empty');
  const workspaceBox = el('ctx-collab-workspace');
  const topoList = el('ctx-collab-topology-list');
  const swimlaneBox = el('ctx-collab-swimlane');
  const tasksBox = el('ctx-collab-tasks');
  const receiptStream = el('ctx-collab-receipt-stream');
  const receiptDetail = el('ctx-collab-receipt-detail');
  if (!summaryStrip || !workspaceBox) return;

  const hub = tl?.agentCollabHub || tl?.agentFleetSummary || null;
  const subagents = Array.isArray(hub?.subagents) ? hub.subagents : [];
  const collabEvents = Array.isArray(hub?.collaborationTimeline) ? hub.collaborationTimeline : [];
  const delegatedTasks = Array.isArray(hub?.delegatedTasks) ? hub.delegatedTasks : [];
  const receipts = Array.isArray(hub?.interactionReceipts) ? hub.interactionReceipts : [];
  const mainAgent = hub?.mainAgent || null;

  const totalAgents = mainAgent ? (1 + subagents.length) : subagents.length;
  const activeAgents = (mainAgent && mainAgent.status === 'running' ? 1 : 0)
    + subagents.filter(s => s?.status === 'running' || s?.status === 'in_progress').length
    + delegatedTasks.filter(d => d?.status === 'in_progress').length;

  if (countPill) {
    countPill.textContent = `${totalAgents}`;
  }

  summaryStrip.replaceChildren();
  const statSpecs = [
    [t('session.collab.agentsTotal'), String(totalAgents)],
    [t('session.collab.agentsActive'), String(activeAgents)],
    [t('session.collab.tasksTotal'), String(delegatedTasks.length)],
    [t('session.collab.receiptsTotal'), String(receipts.length)]
  ];
  for (const [kTxt, vTxt] of statSpecs) {
    const p = document.createElement('div');
    p.className = 'ctx-collab-stat-pill';
    const kSp = document.createElement('span');
    kSp.style.color = 'var(--ctx-ck-subtext)';
    kSp.textContent = kTxt;
    const vSp = document.createElement('strong');
    vSp.textContent = vTxt;
    p.appendChild(kSp);
    p.appendChild(vSp);
    summaryStrip.appendChild(p);
  }

  const hasCollabActivity = subagents.length > 0 || delegatedTasks.length > 0 || receipts.length > 0 || collabEvents.some(e => e.kind !== 'main_call');
  if (!hasCollabActivity) {
    if (emptyBox) {
      emptyBox.hidden = false;
      emptyBox.replaceChildren();
      const tDiv = document.createElement('div');
      tDiv.style.cssText = 'font-weight:600;color:var(--ctx-ck-text);margin-bottom:4px;';
      tDiv.textContent = t('session.collab.emptyTitle');
      const dDiv = document.createElement('div');
      dDiv.textContent = t('session.collab.emptyDesc');
      emptyBox.appendChild(tDiv);
      emptyBox.appendChild(dDiv);
    }
    workspaceBox.hidden = true;
    return;
  }

  if (emptyBox) emptyBox.hidden = true;
  workspaceBox.hidden = false;

  const agentNodes = [];
  if (mainAgent) {
    agentNodes.push({
      id: 'main',
      role: 'main',
      modelLabel: mainAgent.modelLabel || 'Main',
      status: mainAgent.status || 'completed',
      callCount: Number(mainAgent.callCount || 0),
      totalTokens: Number(mainAgent.totalTokens || 0),
      inputTokens: Number(mainAgent.inputTokens || 0),
      cacheReadTokens: Number(mainAgent.cacheReadTokens || 0),
      outputTokens: Number(mainAgent.outputTokens || 0),
      durationSec: mainAgent.durationSec ?? null
    });
  }
  subagents.forEach((s, idx) => {
    agentNodes.push({
      id: s.childCid || s.role || `sub-${idx}`,
      role: s.role || s.type || `subagent-${idx + 1}`,
      modelLabel: s.modelLabel || s.type || 'Subagent',
      status: s.status || 'completed',
      callCount: Number(s.callCount || 0),
      totalTokens: Number(s.totalTokens || 0),
      inputTokens: Number(s.inputTokens || 0),
      cacheReadTokens: Number(s.cacheReadTokens || 0),
      outputTokens: Number(s.outputTokens || 0),
      durationSec: s.durationSec ?? null
    });
  });

  if (topoList) {
    topoList.replaceChildren();
    for (const ag of agentNodes) {
      const isSel = state.collabSelectedAgent === ag.id || state.collabSelectedAgent === ag.role;
      const card = document.createElement('div');
      card.className = `ctx-collab-node-card${isSel ? ' is-selected' : ''}`;
      card.setAttribute('data-collab-agent', ag.id);

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';
      const left = document.createElement('span');
      left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-width:0;';
      const dot = document.createElement('i');
      dot.className = 'key-seg-swatch';
      dot.style.background = COLLAB_STATUS_COLORS[ag.status] || '#10B981';
      const roleSp = document.createElement('strong');
      roleSp.style.cssText = 'font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      roleSp.textContent = ag.role;
      left.appendChild(dot);
      left.appendChild(roleSp);

      const statusPill = document.createElement('span');
      statusPill.className = 'ctx-ov-meta-pill';
      statusPill.textContent = ag.modelLabel || ag.status;
      top.appendChild(left);
      top.appendChild(statusPill);

      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;justify-content:space-between;font-size:10.5px;color:var(--ctx-ck-subtext);';
      const durTxt = ag.durationSec != null ? ` · ${ag.durationSec}s` : '';
      const langCode = typeof currentLang !== 'undefined' ? currentLang : 'zh-CN';
      const callsUnit = langCode === 'en' ? 'calls' : (langCode === 'zh-TW' ? '次呼叫' : '次调用');
      meta.textContent = `${short(ag.totalTokens)} Token · ${ag.callCount} ${callsUnit}${durTxt}`;

      card.appendChild(top);
      card.appendChild(buildCollabMiniBar(ag.inputTokens, ag.cacheReadTokens, ag.outputTokens));
      card.appendChild(meta);

      card.addEventListener('click', () => {
        state.collabSelectedAgent = isSel ? null : ag.role;
        renderAgentCollabHubWidget(tl);
      });
      card.addEventListener('mouseenter', () => {
        if (!swimlaneBox) return;
        for (const elNode of Array.from(swimlaneBox.querySelectorAll?.('[data-swim-agent]') || [])) {
          const match = elNode.getAttribute('data-swim-agent') === ag.role || elNode.getAttribute('data-swim-agent') === ag.id;
          elNode.classList?.toggle?.('is-linked', match);
        }
      });
      card.addEventListener('mouseleave', () => {
        if (!swimlaneBox) return;
        for (const elNode of Array.from(swimlaneBox.querySelectorAll?.('.is-linked') || [])) {
          elNode.classList?.remove?.('is-linked');
        }
      });
      topoList.appendChild(card);
    }
  }

  const activeFilter = state.collabSelectedAgent || null;

  if (swimlaneBox) {
    swimlaneBox.replaceChildren();
    const laneEvents = collabEvents.filter(ev => !activeFilter || ev.role === activeFilter || ev.agentId === activeFilter);
    if (!laneEvents.length) {
      const m = document.createElement('div');
      m.className = 'timeline-turn-meta';
      m.textContent = '—';
      swimlaneBox.appendChild(m);
    } else {
      for (const ev of laneEvents.slice(0, 40)) {
        const row = document.createElement('div');
        row.className = 'ctx-radar-row';
        row.setAttribute('data-swim-agent', ev.role || ev.agentId || '');
        const top = document.createElement('div');
        top.className = 'ctx-radar-top';
        const lSp = document.createElement('span');
        lSp.textContent = `S${ev.stepIndex ?? '?'} · ${ev.role || 'agent'}`;
        const rSp = document.createElement('span');
        rSp.style.color = 'var(--ctx-ck-subtext)';
        rSp.textContent = ev.totalTokens > 0 ? `${short(ev.totalTokens)} tok` : (ev.durationSec ? `${ev.durationSec}s` : ev.status);
        top.appendChild(lSp);
        top.appendChild(rSp);
        const det = document.createElement('div');
        det.style.cssText = 'font-size:10px;color:var(--ctx-ck-subtext);margin-top:2px;';
        det.textContent = ev.detail || '—';
        row.appendChild(top);
        row.appendChild(det);
        row.addEventListener('click', () => {
          if (ev.stepIndex != null && typeof jumpToStepOrTurn === 'function') {
            jumpToStepOrTurn({ stepIndex: ev.stepIndex });
          }
        });
        swimlaneBox.appendChild(row);
      }
    }
  }

  if (tasksBox) {
    tasksBox.replaceChildren();
    const visibleTasks = delegatedTasks.filter(d => !activeFilter || d.role === activeFilter);
    if (!visibleTasks.length) {
      const m = document.createElement('div');
      m.className = 'timeline-turn-meta';
      m.textContent = '—';
      tasksBox.appendChild(m);
    } else {
      for (const tk of visibleTasks.slice(0, 24)) {
        const row = document.createElement('div');
        row.className = 'ctx-radar-row';
        const top = document.createElement('div');
        top.className = 'ctx-radar-top';
        const left = document.createElement('span');
        left.style.fontWeight = '600';
        left.textContent = `${tk.role || tk.type || 'task'} · ${tk.type || ''}`;
        const pill = document.createElement('span');
        pill.className = 'ctx-ov-meta-pill';
        pill.style.borderColor = COLLAB_STATUS_COLORS[tk.status] || 'var(--ctx-ck-border)';
        pill.textContent = resolveCollabTaskStatusLabel(tk.status);
        top.appendChild(left);
        top.appendChild(pill);
        const sum = document.createElement('div');
        sum.style.cssText = 'font-size:10.5px;color:var(--ctx-ck-subtext);margin-top:2px;';
        sum.textContent = tk.summary || '—';
        row.appendChild(top);
        row.appendChild(sum);
        tasksBox.appendChild(row);
      }
    }
  }

  if (receiptStream && receiptDetail) {
    receiptStream.replaceChildren();
    receiptDetail.replaceChildren();
    const visibleReceipts = receipts.filter(r =>
      !activeFilter || r.fromAgent === activeFilter || r.toAgent === activeFilter
    );
    if (!visibleReceipts.length) {
      const emptyR = document.createElement('div');
      emptyR.className = 'timeline-turn-meta';
      emptyR.textContent = t('session.collab.receiptDetailEmpty');
      receiptDetail.appendChild(emptyR);
      return;
    }

    let selectedReceipt = visibleReceipts.find(r => r.id === state.collabSelectedReceiptId) || visibleReceipts[0];
    for (const rc of visibleReceipts.slice(0, 40)) {
      const isSel = selectedReceipt && selectedReceipt.id === rc.id;
      const item = document.createElement('div');
      item.className = `ctx-trace-row${isSel ? ' is-active' : ''}`;
      item.setAttribute('data-receipt-id', rc.id);
      const top = document.createElement('div');
      top.className = 'ctx-trace-row-hdr';
      const route = document.createElement('span');
      route.style.fontWeight = '600';
      route.textContent = `${rc.fromAgent || 'main'} -> ${rc.toAgent || 'subagent'}`;
      const meta = document.createElement('span');
      meta.style.cssText = 'font-size:10px;color:var(--ctx-ck-subtext);';
      meta.textContent = `S${rc.stepIndex ?? '?'} · ${rc.kind || 'msg'}`;
      top.appendChild(route);
      top.appendChild(meta);
      const sum = document.createElement('div');
      sum.style.cssText = 'font-size:10.5px;color:var(--ctx-ck-subtext);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      sum.textContent = rc.summary || '—';
      item.appendChild(top);
      item.appendChild(sum);
      item.addEventListener('click', () => {
        state.collabSelectedReceiptId = rc.id;
        renderAgentCollabHubWidget(tl);
      });
      receiptStream.appendChild(item);
    }

    if (selectedReceipt) {
      const dTop = document.createElement('div');
      dTop.style.cssText = 'font-weight:700;margin-bottom:6px;color:var(--ctx-ck-text);';
      dTop.textContent = `${selectedReceipt.fromAgent || 'main'} -> ${selectedReceipt.toAgent || 'subagent'} · S${selectedReceipt.stepIndex ?? '?'}`;
      const dBody = document.createElement('pre');
      dBody.className = 'ctx-comp-preview-code';
      dBody.textContent = selectedReceipt.detail || selectedReceipt.summary || '—';
      receiptDetail.appendChild(dTop);
      receiptDetail.appendChild(dBody);
    }
  }
}

function initAgentCollabHubControls() {
  // 多代理协作中枢交互均随动态节点即时绑定，此入口保留作初始化对齐钩子
}
