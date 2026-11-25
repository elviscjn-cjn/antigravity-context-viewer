// =========================================================================
// 模块 3C: 会话执行轨迹 · 5 泳道甘特时间线与可展开执行流
// =========================================================================

const TRACE_TRACK_DEFS = [
  { key: 'user', color: '#22C55E', labelKey: 'session.trace.catUser' },
  { key: 'thinking', color: '#8B5CF6', labelKey: 'session.trace.catThinking' },
  { key: 'tool', color: '#F59E0B', labelKey: 'session.trace.catTool' },
  { key: 'assistant', color: '#EC4899', labelKey: 'session.trace.catAssistant' },
  { key: 'subagent', color: '#C084FC', labelKey: 'session.widget.agentCollab' }
];

const TRACE_CAT_COLORS = {
  system: '#64748B',
  user: '#22C55E',
  injection: '#A855F7',
  thinking: '#8B5CF6',
  tool: '#F59E0B',
  assistant: '#EC4899'
};

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

  // 1. 绘制 5 泳道甘特图 SVG
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

  // 2. 渲染过滤后的节点时间流
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
