// =========================================================================
// 模块 3C: 会话执行轨迹 · 独立全视角视图 (renderExecutionTraceInto) + 兼容旧驾驶舱组件
// =========================================================================

const TRACE_TRACK_DEFS = [
  { key: 'user', color: '#10B981', labelKey: 'session.trace.catUser' },
  { key: 'thinking', color: 'var(--ag-host-accent, var(--primary, #3274f6))', labelKey: 'session.trace.catThinking' },
  { key: 'tool', color: '#F59E0B', labelKey: 'session.trace.catTool' },
  { key: 'assistant', color: '#0EA5E9', labelKey: 'session.trace.catAssistant' },
  { key: 'subagent', color: '#14B8A6', labelKey: 'session.widget.agentCollab' }
];

const TRACE_CAT_COLORS = {
  system: '#64748B',
  user: '#10B981',
  injection: '#14B8A6',
  thinking: 'var(--ag-host-accent, var(--primary, #3274f6))',
  tool: '#F59E0B',
  assistant: '#0EA5E9',
  subagent: '#06B6D4'
};

const OM_TRACE_STYLE_ID = 'ag-om-execution-trace-view-style';

const OM_TRACE_I18N = {
  'zh-CN': {
    modeDuration: '时长',
    modeTurn: '轮次',
    modeCall: '调用',
    modeSubcall: '子调用',
    searchPlaceholder: '搜索工具、命令或摘要',
    laneInput: '输入',
    laneModel: '模型',
    laneTool: '工具',
    roleAssistant: '助手',
    roleTool: '工具',
    roleContext: '上下文',
    emptyTitle: '暂无执行轨迹记录',
    emptyDesc: '当前会话产生新的对话或工具调用后，这里会实时展示泳道与流水',
    emptyFilter: '没有匹配当前筛选条件的轨迹记录',
    argsLabel: '参数',
    outLabel: '输出预览',
    detailLabel: '详情',
    timeRangePrefix: '起止',
    durationPrefix: '耗时',
    countSuffix: '条',
    jumpInspector: '定位到上下文步骤'
  },
  'zh-TW': {
    modeDuration: '時長',
    modeTurn: '輪次',
    modeCall: '呼叫',
    modeSubcall: '子呼叫',
    searchPlaceholder: '搜尋工具、命令或摘要',
    laneInput: '輸入',
    laneModel: '模型',
    laneTool: '工具',
    roleAssistant: '助手',
    roleTool: '工具',
    roleContext: '上下文',
    emptyTitle: '暫無執行軌跡記錄',
    emptyDesc: '目前工作階段產生新的對話或工具呼叫後，這裡會即時顯示泳道與流水',
    emptyFilter: '沒有符合目前篩選條件的軌跡記錄',
    argsLabel: '參數',
    outLabel: '輸出預覽',
    detailLabel: '詳情',
    timeRangePrefix: '起迄',
    durationPrefix: '耗時',
    countSuffix: '筆',
    jumpInspector: '定位至上下文步驟'
  },
  en: {
    modeDuration: 'Duration',
    modeTurn: 'Turn',
    modeCall: 'Call',
    modeSubcall: 'Subcall',
    searchPlaceholder: 'Search tools, commands or summary',
    laneInput: 'Input',
    laneModel: 'Model',
    laneTool: 'Tool',
    roleAssistant: 'Assistant',
    roleTool: 'Tool',
    roleContext: 'Context',
    emptyTitle: 'No execution trace records',
    emptyDesc: 'Timeline lanes and trace entries appear here once turns or tool calls run',
    emptyFilter: 'No trace entries match the active filter',
    argsLabel: 'Args',
    outLabel: 'Output Preview',
    detailLabel: 'Details',
    timeRangePrefix: 'Window',
    durationPrefix: 'Duration',
    countSuffix: 'items',
    jumpInspector: 'Locate in Context'
  }
};

function omTraceResolveLang(lang) {
  const raw = String(lang || (typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : 'zh-CN') || 'zh-CN').toLowerCase();
  if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('en')) return 'en';
  return 'zh-CN';
}

function omTraceFormatTok(n) {
  if (typeof short === 'function') return short(n);
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function omTraceFormatDur(sec) {
  const v = Number(sec || 0);
  if (!Number.isFinite(v) || v <= 0) return '0ms';
  if (v < 1) return `${Math.round(v * 1000)}ms`;
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)}s`;
  const mins = Math.floor(v / 60);
  const rem = Math.round(v % 60);
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

function omTraceFormatClock(ms, fallbackOffsetSec) {
  const n = Number(ms);
  if (Number.isFinite(n) && n > 946684800000) {
    const d = new Date(n);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const off = Number(fallbackOffsetSec);
  if (Number.isFinite(off) && off >= 0) {
    return `+${omTraceFormatDur(off)}`;
  }
  return '--:--:--';
}

function omTraceMapLane(node) {
  const cat = String(node?.category || node?.subKind || '').toLowerCase();
  if (cat === 'user' || cat === 'injection' || cat === 'system' || cat === 'context') return 'input';
  if (cat === 'tool' || cat === 'subagent' || cat === 'command') return 'tool';
  return 'model';
}

function omTraceMapRole(node, copy) {
  const lane = omTraceMapLane(node);
  if (lane === 'input') return { key: 'context', label: copy.roleContext, color: '#10B981' };
  if (lane === 'tool') return { key: 'tool', label: copy.roleTool, color: '#F59E0B' };
  return { key: 'assistant', label: copy.roleAssistant, color: 'var(--ag-host-accent, var(--primary, #3274f6))' };
}

function omTraceSanitizeText(text, maxLen = 1800) {
  const raw = String(text || '');
  if (!raw) return '';
  if (typeof sanitizeCompositionPreview === 'function') {
    return sanitizeCompositionPreview(raw, maxLen);
  }
  return raw
    .replace(/(?:sk|pk|ghp|AIza)[A-Za-z0-9_\-]{12,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/gi, 'Bearer [REDACTED]')
    .slice(0, maxLen);
}

function omTraceEnsureStyles(containerEl) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const root = typeof containerEl.getRootNode === 'function' ? containerEl.getRootNode() : doc;
  const target = root && root.nodeType === 11 ? root : (doc.head || containerEl);
  if (!target || target.querySelector?.(`#${OM_TRACE_STYLE_ID}`)) return;
  const style = doc.createElement('style');
  style.id = OM_TRACE_STYLE_ID;
  style.setAttribute('data-om-view-style', 'trace');
  style.textContent = `
    .om-trace-root {
      --om-accent: var(--ag-host-accent, var(--primary, #3274f6));
      --om-bg: var(--background, #141416);
      --om-card: var(--card, rgba(255, 255, 255, 0.035));
      --om-border: var(--border, rgba(148, 163, 184, 0.18));
      --om-text: var(--foreground, #ececef);
      --om-muted: var(--muted-foreground, #94a3b8);
      --om-lane-input: #10B981;
      --om-lane-model: var(--om-accent);
      --om-lane-tool: #F59E0B;
      --om-lane-err: #F43F5E;
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      min-height: 0;
      box-sizing: border-box;
      background: var(--om-bg);
      color: var(--om-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
      font-size: 12px;
      line-height: 1.45;
    }
    .om-trace-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--om-border);
      background: var(--om-card);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .om-trace-modes {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .om-trace-pill {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: var(--om-muted);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .om-trace-pill:hover {
      color: var(--om-text);
      background: rgba(148, 163, 184, 0.12);
    }
    .om-trace-pill.is-active {
      color: var(--om-text);
      background: color-mix(in srgb, var(--om-accent) 18%, transparent);
      border-color: color-mix(in srgb, var(--om-accent) 46%, transparent);
    }
    .om-trace-right-tools {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }
    .om-trace-count {
      font-size: 11px;
      color: var(--om-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .om-trace-search {
      height: 26px;
      width: 190px;
      max-width: 44vw;
      padding: 0 9px;
      border-radius: 7px;
      border: 1px solid var(--om-border);
      background: rgba(148, 163, 184, 0.08);
      color: var(--om-text);
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
    }
    .om-trace-search:focus {
      border-color: var(--om-accent);
    }
    .om-trace-swimlane-wrap {
      position: relative;
      padding: 8px 14px 6px;
      border-bottom: 1px solid var(--om-border);
      background: rgba(148, 163, 184, 0.025);
      flex-shrink: 0;
    }
    .om-trace-swimlane-svg {
      display: block;
      width: 100%;
      height: 58px;
      overflow: visible;
    }
    .om-trace-hover-tip {
      position: absolute;
      right: 14px;
      top: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--om-bg) 92%, var(--om-text) 8%);
      border: 1px solid var(--om-border);
      color: var(--om-text);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
      white-space: nowrap;
      max-width: 72%;
      overflow: hidden;
      text-overflow: ellipsis;
      z-index: 4;
    }
    .om-trace-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px 10px 18px;
      box-sizing: border-box;
    }
    .om-trace-row {
      position: relative;
      border-radius: 6px;
      margin-bottom: 2px;
      border-left: 3px solid var(--om-lane-model);
      background: transparent;
      transition: background-color 120ms ease;
    }
    .om-trace-row:hover {
      background: rgba(148, 163, 184, 0.08);
    }
    .om-trace-row.is-expanded {
      background: rgba(148, 163, 184, 0.09);
      margin-bottom: 6px;
    }
    .om-trace-row[data-lane="input"] { border-left-color: var(--om-lane-input); }
    .om-trace-row[data-lane="model"] { border-left-color: var(--om-lane-model); }
    .om-trace-row[data-lane="tool"] { border-left-color: var(--om-lane-tool); }
    .om-trace-row[data-status="error"] { border-left-color: var(--om-lane-err); }
    .om-trace-row-hdr {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding: 4px 8px;
      cursor: pointer;
      user-select: none;
    }
    .om-trace-ts {
      flex: 0 0 auto;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 10.5px;
      color: var(--om-muted);
      font-variant-numeric: tabular-nums;
      min-width: 54px;
    }
    .om-trace-role {
      flex: 0 0 auto;
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      line-height: 1.35;
      white-space: nowrap;
    }
    .om-trace-role[data-role="context"] {
      background: rgba(16, 185, 129, 0.16);
      color: #34D399;
    }
    .om-trace-role[data-role="assistant"] {
      background: color-mix(in srgb, var(--om-accent) 18%, transparent);
      color: var(--om-accent);
    }
    .om-trace-role[data-role="tool"] {
      background: rgba(245, 158, 11, 0.16);
      color: #FBBF24;
    }
    .om-trace-label {
      flex: 0 0 auto;
      font-weight: 600;
      color: var(--om-text);
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .om-trace-summary {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--om-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .om-trace-meta {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      color: var(--om-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .om-trace-err-badge {
      color: #F43F5E;
      font-weight: 700;
    }
    .om-trace-detail {
      padding: 8px 12px 10px 14px;
      border-top: 1px dashed var(--om-border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .om-trace-detail-sec-title {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--om-muted);
      margin-bottom: 3px;
    }
    .om-trace-pre {
      margin: 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.24);
      border: 1px solid var(--om-border);
      color: var(--om-text);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow-y: auto;
    }
    .om-trace-jump-btn {
      align-self: flex-start;
      appearance: none;
      border: 1px solid color-mix(in srgb, var(--om-accent) 42%, transparent);
      background: color-mix(in srgb, var(--om-accent) 14%, transparent);
      color: var(--om-text);
      border-radius: 6px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
    }
    .om-trace-empty {
      padding: 36px 20px;
      text-align: center;
      color: var(--om-muted);
    }
    .om-trace-empty-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--om-text);
      margin-bottom: 4px;
    }
  `;
  target.appendChild(style);
}

function omTraceExtractNormalized(data) {
  const src = data && typeof data === 'object' ? data : {};
  const tl = src.timeline || src.tl || src;
  const trace = src.executionTrace || tl?.executionTrace || null;
  let nodes = Array.isArray(trace?.nodes) ? trace.nodes.filter(Boolean) : [];

  if (!nodes.length && Array.isArray(tl?.turns)) {
    const derived = [];
    for (const turn of tl.turns) {
      if (!turn) continue;
      if (turn.preview) {
        derived.push({
          id: `turn-u-${turn.turnIndex ?? derived.length}`,
          stepIndex: turn.stepIndex ?? derived.length,
          turnIndex: turn.turnIndex ?? 1,
          category: 'user',
          label: 'user',
          summary: String(turn.preview),
          detail: String(turn.preview),
          status: 'ok',
          startMs: turn.timestamp || null,
          endMs: turn.timestamp || null,
          durationSec: 0,
          tokens: 0,
          agentRole: 'main'
        });
      }
      for (const c of Array.isArray(turn.calls) ? turn.calls : []) {
        if (!c) continue;
        const dur = Number(c.durationSec || 0);
        const endMs = Number(c.timestamp || 0) || null;
        const startMs = endMs && dur > 0 ? endMs - Math.round(dur * 1000) : endMs;
        derived.push({
          id: c.callId || `turn-c-${c.stepIndex ?? derived.length}`,
          stepIndex: c.stepIndex ?? null,
          turnIndex: turn.turnIndex ?? 1,
          category: c.agentRole === 'subagent' ? 'subagent' : 'assistant',
          label: c.modelLabel || c.model || 'model',
          summary: `${omTraceFormatTok(c.totalTokens || 0)} tok · ${omTraceFormatDur(dur)}`,
          detail: '',
          argsSummary: '',
          outputSummary: '',
          status: c.status === 'error' ? 'error' : 'ok',
          startMs,
          endMs,
          durationSec: dur,
          tokens: Number(c.totalTokens || 0),
          modelLabel: c.modelLabel || '',
          agentRole: c.agentRole || 'main'
        });
      }
    }
    nodes = derived;
  }

  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const n of nodes) {
    const s = Number(n.startMs);
    const e = Number(n.endMs ?? n.startMs);
    if (Number.isFinite(s) && s > 0 && s < minMs) minMs = s;
    if (Number.isFinite(e) && e > 0 && e > maxMs) maxMs = e;
  }
  const derivedSpanSec = (Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs > minMs)
    ? (maxMs - minMs) / 1000
    : nodes.reduce((acc, n) => acc + Math.max(0.15, Number(n.durationSec || 0)), 0);
  const totalSpanSec = Math.max(0.5, Number(trace?.totalSpanSec || derivedSpanSec || 1));

  let runningOffset = 0;
  const enriched = nodes.map((n, idx) => {
    const dur = Math.max(0, Number(n.durationSec || 0));
    const hasStart = Number.isFinite(Number(n.startMs)) && Number(n.startMs) > 0;
    const startOffsetSec = Number.isFinite(Number(n.startOffsetSec))
      ? Number(n.startOffsetSec)
      : (hasStart && Number.isFinite(minMs) ? Math.max(0, (Number(n.startMs) - minMs) / 1000) : runningOffset);
    runningOffset = Math.max(runningOffset + Math.max(0.15, dur), startOffsetSec + dur);
    return {
      ...n,
      id: String(n.id || `om-trace-node-${idx}`),
      lane: omTraceMapLane(n),
      durationSec: dur,
      startOffsetSec,
      isSubcall: Boolean(
        n.agentRole === 'subagent'
        || n.category === 'subagent'
        || n.parentStepIndex != null
        || n.parentCallId
        || n.isSubcall
      )
    };
  });

  return {
    nodes: enriched,
    totalSpanSec: Math.max(totalSpanSec, runningOffset || 1)
  };
}

/**
 * 阶段四统一契约：将完整「轨迹」视图渲染到任意独立滚动容器。
 * 对照参考图 2026-11-27_09-25-39.png 与任务书 5.3 节。
 */
function renderExecutionTraceInto(containerEl, data, opts = {}) {
  if (!containerEl) return null;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!doc) return null;

  if (containerEl.__omTraceCtrl && typeof containerEl.__omTraceCtrl.update === 'function') {
    containerEl.__omTraceCtrl.update(data, opts);
    return containerEl.__omTraceCtrl;
  }

  omTraceEnsureStyles(containerEl);

  const st = {
    lang: omTraceResolveLang(opts.lang),
    mode: opts.initialMode || 'duration',
    query: '',
    expandedIds: new Set(),
    selectedId: null,
    active: opts.active !== false,
    disposed: false,
    rafId: null,
    data: data || null,
    opts: { ...opts },
    filteredNodes: [],
    totalSpanSec: 1
  };

  const root = doc.createElement('div');
  root.className = 'om-trace-root';
  root.setAttribute('data-om-session-view-body', 'trace');

  // 顶部筛选条：时长 / 轮次 / 调用 / 子调用 + 搜索框
  const toolbar = doc.createElement('div');
  toolbar.className = 'om-trace-toolbar';
  toolbar.setAttribute('data-om-trace-toolbar', 'true');

  const modesWrap = doc.createElement('div');
  modesWrap.className = 'om-trace-modes';
  modesWrap.setAttribute('role', 'group');

  const modeButtons = new Map();
  const modeKeys = ['duration', 'turn', 'call', 'subcall'];
  for (const mk of modeKeys) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'om-trace-pill';
    btn.setAttribute('data-om-trace-mode', mk);
    btn.addEventListener('click', () => {
      st.mode = mk;
      renderAll();
    });
    modeButtons.set(mk, btn);
    modesWrap.appendChild(btn);
  }

  const rightTools = doc.createElement('div');
  rightTools.className = 'om-trace-right-tools';
  const countEl = doc.createElement('span');
  countEl.className = 'om-trace-count';
  const searchInput = doc.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'om-trace-search';
  searchInput.setAttribute('data-om-trace-search', 'true');
  searchInput.addEventListener('input', () => {
    st.query = String(searchInput.value || '');
    renderAll();
  });
  rightTools.appendChild(countEl);
  rightTools.appendChild(searchInput);

  toolbar.appendChild(modesWrap);
  toolbar.appendChild(rightTools);

  // 贯通全宽三轨彩色泳道（输入 / 模型 / 工具）
  const swimWrap = doc.createElement('div');
  swimWrap.className = 'om-trace-swimlane-wrap';
  swimWrap.setAttribute('data-om-trace-swimlane', 'true');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const swimSvg = doc.createElementNS(SVG_NS, 'svg');
  swimSvg.setAttribute('class', 'om-trace-swimlane-svg');
  swimSvg.setAttribute('role', 'img');
  const hoverTip = doc.createElement('div');
  hoverTip.className = 'om-trace-hover-tip';
  hoverTip.hidden = true;
  swimWrap.appendChild(swimSvg);
  swimWrap.appendChild(hoverTip);

  // 独立滚动流水列表区（支持长会话虚拟滚动）
  const scrollBox = doc.createElement('div');
  scrollBox.className = 'om-trace-scroll';
  scrollBox.setAttribute('data-om-view-scroll', 'trace');
  scrollBox.setAttribute('data-om-trace-stream', 'true');

  const topSpacer = doc.createElement('div');
  topSpacer.className = 'om-trace-spacer-top';
  const itemsHost = doc.createElement('div');
  itemsHost.className = 'om-trace-items-host';
  const botSpacer = doc.createElement('div');
  botSpacer.className = 'om-trace-spacer-bot';
  scrollBox.appendChild(topSpacer);
  scrollBox.appendChild(itemsHost);
  scrollBox.appendChild(botSpacer);

  root.appendChild(toolbar);
  root.appendChild(swimWrap);
  root.appendChild(scrollBox);

  containerEl.replaceChildren(root);

  const ROW_EST_PX = 31;
  const VIRTUAL_THRESHOLD = 100;

  function scheduleVirtualRender() {
    if (st.disposed || !st.active) return;
    if (st.rafId != null) return;
    if (win && typeof win.requestAnimationFrame === 'function') {
      st.rafId = win.requestAnimationFrame(() => {
        st.rafId = null;
        renderVisibleRows();
      });
    } else {
      renderVisibleRows();
    }
  }

  const onScroll = () => {
    if (st.filteredNodes.length > VIRTUAL_THRESHOLD) {
      scheduleVirtualRender();
    }
  };
  scrollBox.addEventListener('scroll', onScroll, { passive: true });

  function getCopy() {
    return OM_TRACE_I18N[st.lang] || OM_TRACE_I18N['zh-CN'];
  }

  function renderSwimlane(nodes, totalSpanSec, copy) {
    const lanes = [
      { key: 'input', label: copy.laneInput, color: '#10B981' },
      { key: 'model', label: copy.laneModel, color: 'var(--ag-host-accent, var(--primary, #3274f6))' },
      { key: 'tool', label: copy.laneTool, color: '#F59E0B' }
    ];
    const width = 920;
    const padL = 44;
    const padR = 8;
    const padT = 4;
    const laneH = 17;
    const height = padT + lanes.length * laneH + 4;
    const plotW = width - padL - padR;
    swimSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const frag = [];
    const maxTurn = Math.max(1, ...nodes.map(n => Number(n.turnIndex || 1)));
    const totalCount = Math.max(1, nodes.length);

    lanes.forEach((ln, idx) => {
      const y = padT + idx * laneH;
      const track = doc.createElementNS(SVG_NS, 'rect');
      track.setAttribute('x', String(padL));
      track.setAttribute('y', String(y + 2));
      track.setAttribute('width', String(plotW));
      track.setAttribute('height', String(laneH - 5));
      track.setAttribute('rx', '3');
      track.setAttribute('fill', 'rgba(148, 163, 184, 0.08)');
      frag.push(track);

      const lbl = doc.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', String(padL - 6));
      lbl.setAttribute('y', String(y + 11.5));
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('fill', 'var(--muted-foreground, #94a3b8)');
      lbl.setAttribute('font-size', '9.5');
      lbl.textContent = ln.label;
      frag.push(lbl);
    });

    nodes.forEach((n, idx) => {
      const laneIdx = n.lane === 'input' ? 0 : (n.lane === 'tool' ? 2 : 1);
      const y = padT + laneIdx * laneH;
      let bx = padL;
      let bw = 6;

      if (st.mode === 'turn') {
        const tIdx = Math.max(0, Number(n.turnIndex || 1) - 1);
        const slot = plotW / maxTurn;
        bx = padL + tIdx * slot + 1;
        bw = Math.max(4, slot - 2);
      } else if (st.mode === 'call' || st.mode === 'subcall') {
        const slot = plotW / totalCount;
        bx = padL + idx * slot;
        bw = Math.max(4, slot * 0.84);
      } else {
        const startRatio = Math.min(0.985, Math.max(0, Number(n.startOffsetSec || 0) / totalSpanSec));
        const durRatio = Math.max(0.008, Math.min(1 - startRatio, Math.max(0.12, Number(n.durationSec || 0.2)) / totalSpanSec));
        bx = padL + startRatio * plotW;
        bw = Math.max(4, durRatio * plotW);
      }

      const rect = doc.createElementNS(SVG_NS, 'rect');
      const isErr = n.status === 'error';
      const isSel = st.selectedId === n.id;
      const fill = isErr ? '#F43F5E' : lanes[laneIdx].color;
      rect.setAttribute('x', bx.toFixed(1));
      rect.setAttribute('y', String(y + 3));
      rect.setAttribute('width', bw.toFixed(1));
      rect.setAttribute('height', String(laneH - 7));
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', fill);
      rect.setAttribute('opacity', isSel ? '1' : '0.86');
      rect.setAttribute('data-om-lane', n.lane);
      rect.setAttribute('data-om-node-id', n.id);
      rect.style.cursor = 'pointer';

      const startStr = omTraceFormatClock(n.startMs, n.startOffsetSec);
      const endStr = omTraceFormatClock(n.endMs, n.startOffsetSec + n.durationSec);
      const durStr = omTraceFormatDur(n.durationSec);
      const tipText = `${n.label || lanes[laneIdx].label} · ${copy.timeRangePrefix} ${startStr} - ${endStr} · ${copy.durationPrefix} ${durStr}`;
      const titleEl = doc.createElementNS(SVG_NS, 'title');
      titleEl.textContent = tipText;
      rect.appendChild(titleEl);

      rect.addEventListener('mouseenter', () => {
        hoverTip.textContent = tipText;
        hoverTip.hidden = false;
      });
      rect.addEventListener('mouseleave', () => {
        hoverTip.hidden = true;
      });
      rect.addEventListener('click', () => {
        st.selectedId = n.id;
        st.expandedIds.add(n.id);
        renderAll();
        if (st.filteredNodes.length > VIRTUAL_THRESHOLD) {
          scrollBox.scrollTop = Math.max(0, idx * ROW_EST_PX - 60);
          renderVisibleRows();
        }
        const rowNode = itemsHost.querySelector?.(`[data-om-trace-row="${CSS?.escape ? CSS.escape(n.id) : n.id}"]`);
        rowNode?.scrollIntoView?.({ block: 'nearest' });
      });

      frag.push(rect);
    });

    swimSvg.replaceChildren(...frag);
  }

  function buildRowElement(node, copy) {
    const isExp = st.expandedIds.has(node.id);
    const roleInfo = omTraceMapRole(node, copy);
    const row = doc.createElement('div');
    row.className = `om-trace-row${isExp ? ' is-expanded' : ''}`;
    row.setAttribute('data-om-trace-row', node.id);
    row.setAttribute('data-lane', node.lane);
    row.setAttribute('data-status', node.status || 'ok');
    row.setAttribute('data-expanded', isExp ? 'true' : 'false');
    row.setAttribute('aria-expanded', isExp ? 'true' : 'false');

    const hdr = doc.createElement('div');
    hdr.className = 'om-trace-row-hdr';
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('tabindex', '0');
    hdr.setAttribute('aria-expanded', isExp ? 'true' : 'false');

    const tsEl = doc.createElement('span');
    tsEl.className = 'om-trace-ts';
    tsEl.textContent = omTraceFormatClock(node.startMs, node.startOffsetSec);

    const roleEl = doc.createElement('span');
    roleEl.className = 'om-trace-role';
    roleEl.setAttribute('data-role', roleInfo.key);
    roleEl.textContent = roleInfo.label;

    const lblEl = doc.createElement('span');
    lblEl.className = 'om-trace-label';
    lblEl.textContent = String(node.label || roleInfo.label);

    const sumEl = doc.createElement('span');
    sumEl.className = 'om-trace-summary';
    sumEl.textContent = omTraceSanitizeText(node.summary || node.argsSummary || node.outputSummary || '', 180);

    const metaEl = doc.createElement('span');
    metaEl.className = 'om-trace-meta';
    const metaParts = [];
    if (node.stepIndex != null) metaParts.push(`S${node.stepIndex}`);
    if (node.durationSec > 0) metaParts.push(omTraceFormatDur(node.durationSec));
    if (node.tokens > 0) metaParts.push(`${omTraceFormatTok(node.tokens)} tok`);
    metaEl.textContent = metaParts.join(' · ');
    if (node.status === 'error') {
      const errSpan = doc.createElement('span');
      errSpan.className = 'om-trace-err-badge';
      errSpan.textContent = 'ERR';
      metaEl.appendChild(errSpan);
    }

    hdr.appendChild(tsEl);
    hdr.appendChild(roleEl);
    hdr.appendChild(lblEl);
    hdr.appendChild(sumEl);
    hdr.appendChild(metaEl);

    const toggleExpand = () => {
      if (st.expandedIds.has(node.id)) {
        st.expandedIds.delete(node.id);
      } else {
        st.expandedIds.add(node.id);
        st.selectedId = node.id;
      }
      renderVisibleRows();
    };
    const handleToggleClick = (ev) => {
      if (ev && ev.__omTraceRowHandled) return;
      if (ev?.target?.closest?.('[data-om-trace-detail]')) return;
      if (ev) ev.__omTraceRowHandled = true;
      toggleExpand();
    };
    row.addEventListener('click', handleToggleClick);
    hdr.addEventListener('click', handleToggleClick);
    hdr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault?.();
        toggleExpand();
      }
    });
    row.appendChild(hdr);

    if (isExp) {
      const detail = doc.createElement('div');
      detail.className = 'om-trace-detail';
      detail.setAttribute('data-om-trace-detail', node.id);

      const argsClean = omTraceSanitizeText(node.argsSummary || '', 1600);
      const outClean = omTraceSanitizeText(node.outputSummary || '', 1600);
      const bodyClean = omTraceSanitizeText(node.detail || node.summary || '', 2000);

      if (argsClean) {
        const sec = doc.createElement('div');
        const stitle = doc.createElement('div');
        stitle.className = 'om-trace-detail-sec-title';
        stitle.textContent = copy.argsLabel;
        const pre = doc.createElement('pre');
        pre.className = 'om-trace-pre';
        pre.textContent = argsClean;
        sec.appendChild(stitle);
        sec.appendChild(pre);
        detail.appendChild(sec);
      }
      if (outClean) {
        const sec = doc.createElement('div');
        const stitle = doc.createElement('div');
        stitle.className = 'om-trace-detail-sec-title';
        stitle.textContent = copy.outLabel;
        const pre = doc.createElement('pre');
        pre.className = 'om-trace-pre';
        pre.textContent = outClean;
        sec.appendChild(stitle);
        sec.appendChild(pre);
        detail.appendChild(sec);
      }
      if (!argsClean && !outClean) {
        const sec = doc.createElement('div');
        const stitle = doc.createElement('div');
        stitle.className = 'om-trace-detail-sec-title';
        stitle.textContent = copy.detailLabel;
        const pre = doc.createElement('pre');
        pre.className = 'om-trace-pre';
        pre.textContent = bodyClean || '—';
        sec.appendChild(stitle);
        sec.appendChild(pre);
        detail.appendChild(sec);
      }

      if (node.stepIndex != null && typeof st.opts.onJumpStep === 'function') {
        const jumpBtn = doc.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'om-trace-jump-btn';
        jumpBtn.textContent = `${copy.jumpInspector} · S${node.stepIndex}`;
        jumpBtn.addEventListener('click', (ev) => {
          ev.stopPropagation?.();
          st.opts.onJumpStep({ stepIndex: node.stepIndex, turnIndex: node.turnIndex });
        });
        detail.appendChild(jumpBtn);
      }

      row.appendChild(detail);
    }

    return row;
  }

  function renderVisibleRows() {
    if (st.disposed) return;
    const copy = getCopy();
    const list = st.filteredNodes;
    if (!list.length) {
      topSpacer.style.height = '0px';
      botSpacer.style.height = '0px';
      const empty = doc.createElement('div');
      empty.className = 'om-trace-empty';
      const title = doc.createElement('div');
      title.className = 'om-trace-empty-title';
      title.textContent = st.query || st.mode === 'subcall' ? copy.emptyFilter : copy.emptyTitle;
      const desc = doc.createElement('div');
      desc.textContent = copy.emptyDesc;
      empty.appendChild(title);
      empty.appendChild(desc);
      itemsHost.replaceChildren(empty);
      return;
    }

    let startIdx = 0;
    let endIdx = list.length;
    if (list.length > VIRTUAL_THRESHOLD) {
      const viewH = Number(scrollBox.clientHeight || 0) || 640;
      const scrollTop = Number(scrollBox.scrollTop || 0);
      const visibleCount = Math.max(40, Math.ceil(viewH / ROW_EST_PX) + 20);
      startIdx = Math.max(0, Math.floor(scrollTop / ROW_EST_PX) - 10);
      endIdx = Math.min(list.length, startIdx + visibleCount);
      topSpacer.style.height = `${startIdx * ROW_EST_PX}px`;
      botSpacer.style.height = `${Math.max(0, (list.length - endIdx) * ROW_EST_PX)}px`;
    } else {
      topSpacer.style.height = '0px';
      botSpacer.style.height = '0px';
    }

    const frag = doc.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      frag.appendChild(buildRowElement(list[i], copy));
    }
    itemsHost.replaceChildren(frag);
  }

  function renderAll() {
    if (st.disposed) return;
    const copy = getCopy();
    const labels = {
      duration: copy.modeDuration,
      turn: copy.modeTurn,
      call: copy.modeCall,
      subcall: copy.modeSubcall
    };
    for (const [mk, btn] of modeButtons.entries()) {
      btn.textContent = labels[mk];
      const act = st.mode === mk;
      btn.classList.toggle('is-active', act);
      btn.setAttribute('aria-pressed', act ? 'true' : 'false');
    }
    searchInput.placeholder = copy.searchPlaceholder;

    const norm = omTraceExtractNormalized(st.data);
    st.totalSpanSec = norm.totalSpanSec;

    const q = st.query.trim().toLowerCase();
    st.filteredNodes = norm.nodes.filter((n) => {
      if (st.mode === 'subcall' && !n.isSubcall) return false;
      if (!q) return true;
      const hay = `${n.label || ''} ${n.summary || ''} ${n.argsSummary || ''} ${n.outputSummary || ''} ${n.modelLabel || ''} S${n.stepIndex ?? ''}`.toLowerCase();
      return hay.includes(q);
    });

    countEl.textContent = `${st.filteredNodes.length} / ${norm.nodes.length} ${copy.countSuffix}`;
    renderSwimlane(st.filteredNodes, st.totalSpanSec, copy);
    renderVisibleRows();
  }

  function setActive(active) {
    st.active = Boolean(active);
    if (!st.active && st.rafId != null) {
      win?.cancelAnimationFrame?.(st.rafId);
      st.rafId = null;
    } else if (st.active && !st.disposed) {
      renderAll();
    }
  }

  function setLang(nextLang) {
    st.lang = omTraceResolveLang(nextLang);
    if (!st.disposed) renderAll();
  }

  function update(nextData, nextOpts = {}) {
    if (st.disposed) return;
    st.data = nextData;
    if (nextOpts && typeof nextOpts === 'object') {
      st.opts = { ...st.opts, ...nextOpts };
      if (nextOpts.lang) st.lang = omTraceResolveLang(nextOpts.lang);
      if (typeof nextOpts.active === 'boolean') st.active = nextOpts.active;
    }
    if (st.active) renderAll();
  }

  function cleanup() {
    if (st.disposed) return;
    st.disposed = true;
    st.active = false;
    if (st.rafId != null) {
      win?.cancelAnimationFrame?.(st.rafId);
      st.rafId = null;
    }
    scrollBox.removeEventListener('scroll', onScroll);
    if (containerEl.__omTraceCtrl === handle) {
      delete containerEl.__omTraceCtrl;
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
      mode: st.mode,
      query: st.query,
      active: st.active,
      totalCount: st.filteredNodes.length,
      expandedCount: st.expandedIds.size
    })
  };

  containerEl.__omTraceCtrl = handle;
  renderAll();
  return handle;
}

if (typeof window !== 'undefined') {
  window.renderExecutionTraceInto = renderExecutionTraceInto;
}

// =========================================================================
// 兼容旧驾驶舱 Widget 导出（保留以保障既有单测 100% 通过）
// =========================================================================

/**
 * 在执行轨迹组件内同步按钮状态并渲染五泳道甘特图与步骤明细流。
 */
function renderExecutionTraceWidget(tl) {
  const segWrap = el('ctx-trace-view-segs');
  const catWrap = el('ctx-trace-cat-filters');
  const badgeEl = el('ctx-trace-summary-badge');
  const svg = el('ctx-trace-gantt-svg');
  const streamEl = el('ctx-trace-stream-list');
  if (!svg || !streamEl) return;

  const mode = state.traceMode || 'duration';
  const catFilter = state.traceCatFilter || 'all';
  const query = String(state.traceSearchQuery || '').trim().toLowerCase();

  if (segWrap) {
    for (const b of Array.from(segWrap.querySelectorAll?.('[data-trace-mode]') || [])) {
      const act = b.getAttribute('data-trace-mode') === mode;
      b.classList?.toggle?.('active', act);
      b.setAttribute?.('aria-pressed', act ? 'true' : 'false');
    }
  }
  if (catWrap) {
    for (const b of Array.from(catWrap.querySelectorAll?.('[data-trace-cat]') || [])) {
      const act = b.getAttribute('data-trace-cat') === catFilter;
      b.classList?.toggle?.('active', act);
      b.setAttribute?.('aria-pressed', act ? 'true' : 'false');
    }
  }

  const trace = tl?.executionTrace || null;
  const rawNodes = Array.isArray(trace?.nodes) ? trace.nodes : [];
  const filteredNodes = rawNodes.filter(n => {
    if (!n) return false;
    if (catFilter !== 'all' && n.category !== catFilter) return false;
    if (!query) return true;
    const hay = `${n.label || ''} ${n.summary || ''} ${n.argsSummary || ''} ${n.modelLabel || ''} S${n.stepIndex ?? ''}`.toLowerCase();
    return hay.includes(query);
  });

  if (badgeEl) {
    const spanTxt = trace?.totalSpanSec ? ` · ${trace.totalSpanSec}s` : '';
    badgeEl.textContent = `${filteredNodes.length} / ${rawNodes.length}${spanTxt}`;
  }

  const width = 620;
  const laneH = 22;
  const padL = 74;
  const padR = 14;
  const padT = 8;
  const height = padT + TRACE_TRACK_DEFS.length * laneH + 8;
  const plotW = width - padL - padR;
  svg.setAttribute?.('viewBox', `0 0 ${width} ${height}`);

  const svgNodes = [];
  const ganttTracks = trace?.ganttTracks || {};
  const visibleNodeIds = new Set(filteredNodes.map(n => n.id));
  const totalSpanSec = Math.max(0.5, Number(trace?.totalSpanSec || 1));
  const maxTurn = Math.max(1, ...rawNodes.map(n => Number(n.turnIndex || 1)));
  const totalCallCount = Math.max(1, rawNodes.length);

  TRACE_TRACK_DEFS.forEach((tr, rowIdx) => {
    const cy = padT + rowIdx * laneH;
    const bgRect = createSvgEl('rect', {
      x: padL,
      y: cy + 2,
      width: plotW,
      height: laneH - 5,
      rx: 4,
      fill: 'rgba(148,163,184,0.08)'
    });
    if (bgRect) svgNodes.push(bgRect);

    const lbl = createSvgEl('text', {
      x: padL - 6,
      y: cy + 14,
      'text-anchor': 'end',
      fill: 'var(--ctx-ck-subtext, #8a8a94)',
      'font-size': '9.5'
    });
    if (lbl) {
      lbl.textContent = t(tr.labelKey);
      svgNodes.push(lbl);
    }

    const laneBars = Array.isArray(ganttTracks[tr.key]) ? ganttTracks[tr.key] : [];
    laneBars.forEach((bar, bIdx) => {
      if (!visibleNodeIds.has(bar.nodeId)) return;
      let bx = padL;
      let bw = 6;
      if (mode === 'turn') {
        const tIdx = Math.max(0, Number(bar.turnIndex || 1) - 1);
        const turnSlot = plotW / maxTurn;
        bx = padL + tIdx * turnSlot + 2;
        bw = Math.max(4, turnSlot - 4);
      } else if (mode === 'call') {
        const nodeIdx = Math.max(0, rawNodes.findIndex(rn => rn.id === bar.nodeId));
        const cSlot = plotW / totalCallCount;
        bx = padL + nodeIdx * cSlot;
        bw = Math.max(4, cSlot * 0.85);
      } else {
        const startRatio = Math.min(0.98, Math.max(0, Number(bar.startOffsetSec || 0) / totalSpanSec));
        const durRatio = Math.max(0.015, Math.min(1 - startRatio, Number(bar.durationSec || 0.25) / totalSpanSec));
        bx = padL + startRatio * plotW;
        bw = Math.max(4, durRatio * plotW);
      }

      const isErr = bar.status === 'error';
      const rect = createSvgEl('rect', {
        x: bx.toFixed(1),
        y: (cy + 4).toFixed(1),
        width: bw.toFixed(1),
        height: String(laneH - 9),
        rx: '3',
        fill: isErr ? '#F43F5E' : tr.color,
        opacity: state.traceSelectedNodeId === bar.nodeId ? '1' : '0.82',
        stroke: state.traceSelectedNodeId === bar.nodeId ? '#FFFFFF' : 'none',
        'stroke-width': state.traceSelectedNodeId === bar.nodeId ? '1.2' : '0',
        style: 'cursor:pointer',
        'data-trace-node-id': bar.nodeId || `lane-${tr.key}-${bIdx}`
      });
      const tip = createSvgEl('title', {});
      if (tip) {
        tip.textContent = `${bar.label || ''} · S${bar.stepIndex ?? '?'} · ${bar.durationSec ?? 0}s · ${bar.summary || ''}`;
        rect?.appendChild?.(tip);
      }
      if (rect) {
        rect.addEventListener?.('click', () => {
          state.traceSelectedNodeId = bar.nodeId;
          renderExecutionTraceWidget(tl);
          const rowEl = streamEl.querySelector?.(`[data-trace-row-id="${bar.nodeId}"]`);
          rowEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        });
        svgNodes.push(rect);
      }
    });
  });

  if (typeof svg.replaceChildren === 'function') svg.replaceChildren(...svgNodes);
  else {
    svg.innerHTML = '';
    svgNodes.forEach(n => svg.appendChild?.(n));
  }

  streamEl.replaceChildren();
  if (!filteredNodes.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'timeline-turn-meta';
    emptyEl.textContent = t('session.trace.empty');
    streamEl.appendChild(emptyEl);
    return;
  }

  for (const node of filteredNodes.slice(-140)) {
    const isSel = state.traceSelectedNodeId === node.id;
    const row = document.createElement('div');
    row.className = `ctx-trace-row${isSel ? ' is-active' : ''}`;
    row.setAttribute('data-trace-row-id', node.id);

    const hdr = document.createElement('div');
    hdr.className = 'ctx-trace-row-hdr';
    const left = document.createElement('span');
    left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;';
    const dot = document.createElement('i');
    dot.className = 'key-seg-swatch';
    dot.style.background = node.status === 'error' ? '#F43F5E' : (TRACE_CAT_COLORS[node.category] || '#94A3B8');
    const stepTag = document.createElement('span');
    stepTag.className = 'ctx-ov-meta-pill';
    stepTag.textContent = node.stepIndex != null ? `S${node.stepIndex}` : '#';
    const lblSp = document.createElement('span');
    lblSp.style.cssText = 'font-weight:600;white-space:nowrap;';
    lblSp.textContent = node.label || node.category;
    const sumSp = document.createElement('span');
    sumSp.style.cssText = 'color:var(--ctx-ck-subtext);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    sumSp.textContent = node.summary || '';
    left.appendChild(dot);
    left.appendChild(stepTag);
    left.appendChild(lblSp);
    left.appendChild(sumSp);

    const right = document.createElement('span');
    right.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-shrink:0;font-size:10px;color:var(--ctx-ck-subtext);';
    const metricParts = [];
    if (node.durationSec > 0) metricParts.push(`${node.durationSec}s`);
    if (node.tokens > 0) metricParts.push(`${short(node.tokens)} tok`);
    if (node.status === 'error') metricParts.push('ERR');
    right.textContent = metricParts.join(' · ') || '—';

    hdr.appendChild(left);
    hdr.appendChild(right);
    row.appendChild(hdr);

    if (isSel) {
      const det = document.createElement('div');
      det.className = 'ctx-trace-row-detail';
      const textWrap = document.createElement('div');
      textWrap.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin-bottom:6px;';
      const chunks = [];
      if (node.argsSummary) chunks.push(`Args · ${node.argsSummary}`);
      if (node.outputSummary) chunks.push(`Out · ${node.outputSummary}`);
      if (!chunks.length && node.detail) chunks.push(node.detail);
      textWrap.textContent = chunks.join('\n\n') || node.summary || '—';
      det.appendChild(textWrap);

      if (node.stepIndex != null) {
        const jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'ctx-mini-link-btn';
        jumpBtn.textContent = `${t('session.trace.jumpInspector')} · S${node.stepIndex}`;
        jumpBtn.addEventListener('click', (ev) => {
          ev?.stopPropagation?.();
          if (typeof jumpToStepOrTurn === 'function') jumpToStepOrTurn({ stepIndex: node.stepIndex });
          if (typeof revealAndScrollToCockpitWidget === 'function') revealAndScrollToCockpitWidget('context-inspector', { flash: true });
        });
        det.appendChild(jumpBtn);
      }
      row.appendChild(det);
    }

    row.addEventListener('click', () => {
      state.traceSelectedNodeId = isSel ? null : node.id;
      renderExecutionTraceWidget(tl);
    });
    streamEl.appendChild(row);
  }
}

/**
 * 绑定会话执行轨迹视图分段、分类筛选胶囊及搜索框。
 */
function initExecutionTraceControls() {
  const segWrap = el('ctx-trace-view-segs');
  if (segWrap && !segWrap._traceBound) {
    segWrap._traceBound = true;
    segWrap.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-trace-mode]');
      if (!btn) return;
      state.traceMode = btn.getAttribute('data-trace-mode') || 'duration';
      renderExecutionTraceWidget(typeof resolveTrendTimelineSource === 'function' ? resolveTrendTimelineSource() : state.sessionTimeline);
    });
  }

  const catWrap = el('ctx-trace-cat-filters');
  if (catWrap && !catWrap._traceBound) {
    catWrap._traceBound = true;
    catWrap.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-trace-cat]');
      if (!btn) return;
      state.traceCatFilter = btn.getAttribute('data-trace-cat') || 'all';
      renderExecutionTraceWidget(typeof resolveTrendTimelineSource === 'function' ? resolveTrendTimelineSource() : state.sessionTimeline);
    });
  }

  const searchInp = el('inp-trace-search');
  if (searchInp && !searchInp._traceBound) {
    searchInp._traceBound = true;
    searchInp.addEventListener('input', () => {
      state.traceSearchQuery = searchInp.value || '';
      renderExecutionTraceWidget(typeof resolveTrendTimelineSource === 'function' ? resolveTrendTimelineSource() : state.sessionTimeline);
    });
  }
}
