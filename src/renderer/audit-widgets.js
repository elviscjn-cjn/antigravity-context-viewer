// =========================================================================
// 模块 3E: KPI 联动跳转条 / Token 构成环形图 / 异动日志 / 文件变更雷达 / 终端命令审计
// =========================================================================

const EVENT_TYPE_COLORS = {
  compaction: '#FACC15',
  prune: '#22E09B',
  inject: '#F472B6',
  error: '#F43F5E',
  model: '#10B981',
  mode: '#A855F7',
  unknown_drop: '#FB923C'
};

/**
 * 1. 渲染「总览与双轨健康」底部 KPI 联动跳转胶囊，点击直达对应驾驶舱 Widget。
 */
function renderKpiLinkagePills(tl, breakdown) {
  const wrap = el('ctx-kpi-link-pills');
  if (!wrap) return;
  wrap.replaceChildren();

  const items = Array.isArray(breakdown?.items) ? breakdown.items : [];
  const userCount = items.find(i => i.key === 'user')?.count || 0;
  const toolCount = (items.find(i => i.key === 'tools')?.count || 0) + (items.find(i => i.key === 'toolCalls')?.count || 0);
  const fileCount = tl?.fileActivitySummary?.uniqueFiles ?? (Array.isArray(tl?.fileActivities) ? tl.fileActivities.length : 0);
  const cmdCount = tl?.commandSummary?.totalCount ?? (Array.isArray(tl?.commandExecutions) ? tl.commandExecutions.length : 0);
  const evCount = Array.isArray(tl?.contextChangeEvents) ? tl.contextChangeEvents.length : 0;
  const subCount = Array.isArray(tl?.agentFleetSummary?.subagents) ? tl.agentFleetSummary.subagents.length : 0;

  const pills = [
    { key: 'inputs', label: t('session.kpi.inputs'), count: userCount, widgetId: 'context-inspector', treeCat: 'user' },
    { key: 'files', label: t('session.kpi.files'), count: fileCount, widgetId: 'file-radar' },
    { key: 'tools', label: t('session.kpi.tools'), count: toolCount, widgetId: 'context-inspector', treeCat: 'tools' },
    { key: 'commands', label: t('session.kpi.commands'), count: cmdCount, widgetId: 'command-audit' },
    { key: 'events', label: t('session.kpi.events'), count: evCount, widgetId: 'context-events' },
    { key: 'subagents', label: t('session.kpi.subagents'), count: subCount, widgetId: 'agent-collab' }
  ];

  for (const p of pills) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-kpi-link-pill';
    btn.setAttribute('data-kpi-link', p.key);
    btn.textContent = `${p.label} ${p.count}`;
    btn.addEventListener('click', () => {
      if (p.treeCat && typeof focusCompositionTreeCategory === 'function') {
        state.ctxFocusedTreeCat = p.treeCat;
      }
      if (typeof revealAndScrollToCockpitWidget === 'function') {
        revealAndScrollToCockpitWidget(p.widgetId, { flash: true });
      }
    });
    wrap.appendChild(btn);
  }
}

/**
 * 2. 渲染 Token 构成环形图与缓存命中成本摘要。
 */
function renderTokenBreakdownWidget(tl, activeCall) {
  const donutSvg = el('ctx-token-donut-svg');
  const listEl = el('ctx-token-breakdown-list');
  const stripEl = el('ctx-token-cache-cost-strip');
  if (!donutSvg || !listEl || !stripEl) return;

  const totals = tl?.sessionTokenTotals || null;
  const freshIn = activeCall ? Math.max(0, Number(activeCall.inputTokens || 0)) : Math.max(0, Number(totals?.freshInputTokens || totals?.inputTokens || 0));
  const cacheRead = activeCall ? Math.max(0, Number(activeCall.cacheReadTokens || 0)) : Math.max(0, Number(totals?.cacheReadTokens || 0));
  const output = activeCall ? Math.max(0, Number(activeCall.outputTokens || 0)) : Math.max(0, Number(totals?.outputTokens || 0));
  const thinking = activeCall ? Math.max(0, Number(activeCall.thinkingTokens || 0)) : Math.max(0, Number(totals?.thinkingTokens || 0));

  const parts = [
    { key: 'fresh', label: t('session.dual.cacheFresh'), color: '#10B981', val: freshIn },
    { key: 'cache', label: t('session.dual.cacheRead'), color: '#FB923C', val: cacheRead },
    { key: 'output', label: t('heat.output'), color: '#C084FC', val: output },
    ...(thinking > 0 ? [{ key: 'thinking', label: t('session.comp.cat.thinking'), color: '#8B5CF6', val: thinking }] : [])
  ];
  const sum = parts.reduce((acc, p) => acc + p.val, 0);

  const r = 30;
  const circ = 2 * Math.PI * r;
  const svgNodes = [];
  const track = createSvgEl('circle', {
    cx: '44', cy: '44', r: String(r), fill: 'none',
    stroke: 'rgba(148,163,184,0.20)', 'stroke-width': '10'
  });
  if (track) svgNodes.push(track);

  if (sum > 0) {
    let offset = 0;
    for (const p of parts) {
      if (p.val <= 0) continue;
      const ratio = p.val / sum;
      const len = ratio * circ;
      const arc = createSvgEl('circle', {
        cx: '44', cy: '44', r: String(r), fill: 'none',
        stroke: p.color, 'stroke-width': '10',
        'stroke-dasharray': `${len.toFixed(2)} ${circ.toFixed(2)}`,
        'stroke-dashoffset': (-offset).toFixed(2),
        transform: 'rotate(-90 44 44)'
      });
      if (arc) svgNodes.push(arc);
      offset += len;
    }
  }
  const cTxt = createSvgEl('text', {
    x: '44', y: '48', 'text-anchor': 'middle',
    fill: 'var(--ctx-ck-text, #ececef)', 'font-size': '11', 'font-weight': '700'
  });
  if (cTxt) {
    cTxt.textContent = sum > 0 ? short(sum) : '—';
    svgNodes.push(cTxt);
  }
  if (typeof donutSvg.replaceChildren === 'function') donutSvg.replaceChildren(...svgNodes);
  else {
    donutSvg.innerHTML = '';
    svgNodes.forEach(n => donutSvg.appendChild?.(n));
  }

  listEl.replaceChildren();
  const sortedParts = parts.slice().sort((a, b) => b.val - a.val);
  for (const p of sortedParts) {
    const pct = sum > 0 ? Math.round((p.val / sum) * 1000) / 10 : 0;
    const row = document.createElement('div');
    row.className = 'ctx-token-bk-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-token-bk-lbl';
    const dot = document.createElement('i');
    dot.className = 'key-seg-swatch';
    dot.style.background = p.color;
    const txt = document.createElement('span');
    txt.textContent = p.label;
    lbl.appendChild(dot);
    lbl.appendChild(txt);
    const valEl = document.createElement('span');
    valEl.style.fontVariantNumeric = 'tabular-nums';
    valEl.textContent = `${short(p.val)} · ${pct}%`;
    row.appendChild(lbl);
    row.appendChild(valEl);
    listEl.appendChild(row);
  }

  stripEl.replaceChildren();
  const cacheHitPct = (freshIn + cacheRead) > 0 ? Math.round((cacheRead / (freshIn + cacheRead)) * 1000) / 10 : null;
  const costVal = tl?.sessionCostSummary?.totalCostUSD ?? activeCall?.costUSD ?? null;
  const stripParts = [];
  if (cacheHitPct != null) stripParts.push(`${t('session.ov.cacheHitLabel')} ${cacheHitPct}%`);
  if (costVal != null && Number.isFinite(Number(costVal)) && Number(costVal) > 0) {
    stripParts.push(`${t('session.ov.costLabel')} ${formatUsdMetricDisplay(Number(costVal), { detail: true })}`);
  }
  stripEl.textContent = stripParts.join(' · ') || '—';
}

/**
 * 3. 渲染上下文异动日志 Widget。
 */
function renderContextEventsWidget(tl) {
  const countPill = el('ctx-events-count-pill');
  const filterBar = el('ctx-events-filter-bar');
  const listEl = el('ctx-events-list');
  if (!listEl) return;

  const allEvents = Array.isArray(tl?.contextChangeEvents) ? tl.contextChangeEvents : [];
  const activeFilter = state.eventsTypeFilter || 'all';
  if (countPill) countPill.textContent = String(allEvents.length);

  if (filterBar) {
    filterBar.replaceChildren();
    const types = ['all', ...Array.from(new Set(allEvents.map(e => e?.type).filter(Boolean)))];
    for (const tp of types) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tl-filter-chip${activeFilter === tp ? ' active' : ''}`;
      btn.setAttribute('data-ev-filter', tp);
      btn.textContent = tp === 'all' ? t('session.radar.filterAll') : tp;
      btn.addEventListener('click', () => {
        state.eventsTypeFilter = tp;
        renderContextEventsWidget(tl);
      });
      filterBar.appendChild(btn);
    }
  }

  const visibleEvents = allEvents.filter(ev => activeFilter === 'all' || ev?.type === activeFilter);
  listEl.replaceChildren();
  if (!visibleEvents.length) {
    const em = document.createElement('div');
    em.className = 'timeline-turn-meta';
    em.textContent = t('session.trace.empty');
    listEl.appendChild(em);
    return;
  }

  for (const ev of visibleEvents.slice(-60)) {
    const row = document.createElement('div');
    row.className = 'ctx-radar-row';
    const top = document.createElement('div');
    top.className = 'ctx-radar-top';
    const left = document.createElement('span');
    left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
    const dot = document.createElement('i');
    dot.className = 'key-seg-swatch';
    dot.style.background = EVENT_TYPE_COLORS[ev.type] || '#FACC15';
    const tpSp = document.createElement('strong');
    tpSp.textContent = ev.type || 'event';
    left.appendChild(dot);
    left.appendChild(tpSp);
    if (ev.stepIndex != null) {
      const sPill = document.createElement('span');
      sPill.className = 'ctx-ov-meta-pill';
      sPill.textContent = `S${ev.stepIndex}`;
      left.appendChild(sPill);
    }
    const deltaEl = document.createElement('span');
    deltaEl.style.fontVariantNumeric = 'tabular-nums';
    if (ev.tokensSaved > 0) deltaEl.textContent = `-${short(ev.tokensSaved)}`;
    else if (ev.deltaTokens != null) deltaEl.textContent = `${ev.deltaTokens > 0 ? '+' : ''}${short(ev.deltaTokens)}`;
    else deltaEl.textContent = '—';
    top.appendChild(left);
    top.appendChild(deltaEl);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:10.5px;color:var(--ctx-ck-subtext);margin-top:2px;';
    desc.textContent = ev.summary || ev.label || ev.detail || '—';

    row.appendChild(top);
    row.appendChild(desc);
    row.addEventListener('click', () => {
      if (typeof jumpToStepOrTurn === 'function') {
        jumpToStepOrTurn({ stepIndex: ev.stepIndex, turnIndex: ev.turnIndex, callId: ev.callId });
      }
    });
    listEl.appendChild(row);
  }
}

/**
 * 4. 渲染文件变更雷达 Widget：按读/写/搜/图过滤、行增删数与可展开操作链。
 */
function renderFileRadarWidget(tl) {
  const countEl = el('ctx-file-radar-count');
  const filterWrap = el('ctx-file-radar-filters');
  const listEl = el('ctx-file-radar-list');
  if (!listEl) return;

  const opFilter = state.radarOpFilter || 'all';
  const query = String(state.radarSearchQuery || '').trim().toLowerCase();
  if (filterWrap) {
    for (const b of Array.from(filterWrap.querySelectorAll?.('[data-radar-op]') || [])) {
      const act = b.getAttribute('data-radar-op') === opFilter;
      b.classList?.toggle?.('active', act);
      b.setAttribute?.('aria-pressed', act ? 'true' : 'false');
    }
  }

  const allFiles = Array.isArray(tl?.fileActivities) ? tl.fileActivities : [];
  const visible = allFiles.filter(f => {
    if (!f) return false;
    if (opFilter === 'read' && !(f.readCount > 0)) return false;
    if (opFilter === 'write' && !(f.writeCount > 0)) return false;
    if (opFilter === 'search' && !(f.searchCount > 0)) return false;
    if (opFilter === 'image' && !(f.imageCount > 0)) return false;
    if (!query) return true;
    return `${f.path || ''} ${f.basename || ''}`.toLowerCase().includes(query);
  });

  if (countEl) countEl.textContent = String(visible.length);

  listEl.replaceChildren();
  if (!visible.length) {
    const em = document.createElement('div');
    em.className = 'timeline-turn-meta';
    em.textContent = t('session.radar.empty');
    listEl.appendChild(em);
    return;
  }

  for (const f of visible.slice(0, 80)) {
    const isExp = state.radarExpandedPath === f.path;
    const row = document.createElement('div');
    row.className = 'ctx-radar-row';
    const top = document.createElement('div');
    top.className = 'ctx-radar-top';

    const left = document.createElement('span');
    left.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;';
    left.textContent = f.basename || f.path;
    left.title = f.path || '';

    const right = document.createElement('span');
    right.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-shrink:0;';
    if (f.addedLines > 0) {
      const aSp = document.createElement('span');
      aSp.className = 'ctx-diff-add';
      aSp.textContent = `+${f.addedLines}`;
      right.appendChild(aSp);
    }
    if (f.removedLines > 0) {
      const dSp = document.createElement('span');
      dSp.className = 'ctx-diff-del';
      dSp.textContent = `-${f.removedLines}`;
      right.appendChild(dSp);
    }
    const cntPill = document.createElement('span');
    cntPill.className = 'ctx-ov-meta-pill';
    cntPill.textContent = `${f.totalCount || 1}x`;
    right.appendChild(cntPill);

    top.appendChild(left);
    top.appendChild(right);
    row.appendChild(top);

    const pathSub = document.createElement('div');
    pathSub.style.cssText = 'font-size:10px;color:var(--ctx-ck-subtext);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;';
    pathSub.textContent = f.path || '';
    row.appendChild(pathSub);

    if (isExp && Array.isArray(f.operations) && f.operations.length) {
      const opWrap = document.createElement('div');
      opWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;padding-top:5px;border-top:1px dashed var(--ctx-ck-border);';
      for (const op of f.operations) {
        const opBtn = document.createElement('button');
        opBtn.type = 'button';
        opBtn.className = 'ctx-mini-link-btn';
        opBtn.textContent = `S${op.stepIndex ?? '?'} · ${op.kind} · ${op.toolName}`;
        opBtn.addEventListener('click', (ev) => {
          ev?.stopPropagation?.();
          if (op.stepIndex != null && typeof jumpToStepOrTurn === 'function') {
            jumpToStepOrTurn({ stepIndex: op.stepIndex });
            if (typeof revealAndScrollToCockpitWidget === 'function') {
              revealAndScrollToCockpitWidget('context-inspector', { flash: true });
            }
          }
        });
        opWrap.appendChild(opBtn);
      }
      row.appendChild(opWrap);
    }

    row.addEventListener('click', () => {
      state.radarExpandedPath = isExp ? null : f.path;
      renderFileRadarWidget(tl);
    });
    listEl.appendChild(row);
  }
}

/**
 * 5. 渲染双栏联动终端命令审计 Widget：左侧程序分布柱与状态卡，右侧可展开脱敏命令流。
 */
function renderCommandAuditWidget(tl) {
  const countEl = el('ctx-cmd-audit-count');
  const statsEl = el('ctx-cmd-audit-stats');
  const progsEl = el('ctx-cmd-audit-programs');
  const clearBtn = el('btn-cmd-prog-clear');
  const filtersWrap = el('ctx-cmd-audit-filters');
  const listEl = el('ctx-cmd-audit-list');
  if (!listEl || !statsEl || !progsEl) return;

  const summary = tl?.commandSummary || { totalCount: 0, failedCount: 0, slowCount: 0, backgroundCount: 0, topPrograms: [] };
  const commands = Array.isArray(tl?.commandExecutions) ? tl.commandExecutions : [];
  const statusFilter = state.cmdAuditFilter || 'all';
  const query = String(state.cmdAuditQuery || '').trim().toLowerCase();
  const progFilter = state.cmdAuditProgramFilter || null;

  if (countEl) countEl.textContent = String(commands.length);
  if (clearBtn) clearBtn.hidden = !progFilter;

  if (filtersWrap) {
    for (const b of Array.from(filtersWrap.querySelectorAll?.('[data-cmd-filter]') || [])) {
      const act = b.getAttribute('data-cmd-filter') === statusFilter;
      b.classList?.toggle?.('active', act);
      b.setAttribute?.('aria-pressed', act ? 'true' : 'false');
    }
  }

  statsEl.replaceChildren();
  const statPairs = [
    [t('session.cmdAudit.totalLabel'), summary.totalCount || commands.length],
    [t('session.cmdAudit.failedLabel'), summary.failedCount || 0],
    [t('session.cmdAudit.slowLabel'), summary.slowCount || 0],
    [t('session.cmdAudit.bgLabel'), summary.backgroundCount || 0]
  ];
  for (const [lbl, val] of statPairs) {
    const box = document.createElement('div');
    box.className = 'ctx-cmd-stat-box';
    box.textContent = `${lbl} · ${val}`;
    statsEl.appendChild(box);
  }

  progsEl.replaceChildren();
  const topProgs = Array.isArray(summary.topPrograms) ? summary.topPrograms : [];
  const maxProg = Math.max(1, ...topProgs.map(p => Number(p.count || 0)));
  for (const p of topProgs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctx-cmd-prog-row${progFilter === p.program ? ' is-active' : ''}`;
    btn.setAttribute('data-cmd-prog', p.program);
    const nameSp = document.createElement('span');
    nameSp.style.cssText = 'min-width:48px;font-weight:600;white-space:nowrap;';
    nameSp.textContent = p.program;
    const bar = document.createElement('span');
    bar.className = 'ctx-cmd-prog-bar';
    const fill = document.createElement('span');
    fill.className = 'ctx-cmd-prog-fill';
    fill.style.display = 'block';
    fill.style.width = `${Math.max(8, (Number(p.count || 0) / maxProg) * 100).toFixed(1)}%`;
    bar.appendChild(fill);
    const cntSp = document.createElement('span');
    cntSp.textContent = String(p.count || 0);
    btn.appendChild(nameSp);
    btn.appendChild(bar);
    btn.appendChild(cntSp);
    btn.addEventListener('click', () => {
      state.cmdAuditProgramFilter = progFilter === p.program ? null : p.program;
      renderCommandAuditWidget(tl);
    });
    progsEl.appendChild(btn);
  }

  const visibleCmds = commands.filter(c => {
    if (!c) return false;
    if (progFilter && c.program !== progFilter) return false;
    if (statusFilter === 'failed' && c.status !== 'failed') return false;
    if (statusFilter === 'slow' && !c.isSlow) return false;
    if (statusFilter === 'bg' && !c.isBackground) return false;
    if (!query) return true;
    return `${c.command || ''} ${c.program || ''} ${c.summary || ''}`.toLowerCase().includes(query);
  });

  listEl.replaceChildren();
  if (!visibleCmds.length) {
    const em = document.createElement('div');
    em.className = 'timeline-turn-meta';
    em.textContent = t('session.cmdAudit.empty');
    listEl.appendChild(em);
    return;
  }

  for (const cmd of visibleCmds.slice(-80)) {
    const isExp = state.cmdAuditExpandedId === cmd.id;
    const row = document.createElement('div');
    row.className = 'ctx-cmd-row';
    const top = document.createElement('div');
    top.className = 'ctx-cmd-top';

    const left = document.createElement('span');
    left.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;';
    left.textContent = cmd.command || cmd.program || 'cmd';
    left.title = cmd.command || '';

    const right = document.createElement('span');
    right.style.cssText = 'display:inline-flex;align-items:center;gap:5px;flex-shrink:0;font-size:10px;';
    if (cmd.exitCode != null) {
      const ec = document.createElement('span');
      ec.className = 'ctx-ov-meta-pill';
      if (Number(cmd.exitCode) !== 0) ec.style.color = '#F43F5E';
      ec.textContent = `exit ${cmd.exitCode}`;
      right.appendChild(ec);
    }
    if (cmd.durationSec != null) {
      const dur = document.createElement('span');
      dur.style.color = 'var(--ctx-ck-subtext)';
      dur.textContent = `${cmd.durationSec}s`;
      right.appendChild(dur);
    }

    top.appendChild(left);
    top.appendChild(right);
    row.appendChild(top);

    if (isExp && cmd.outputPreview) {
      const pre = document.createElement('pre');
      pre.className = 'ctx-comp-preview-code';
      pre.style.marginTop = '6px';
      pre.textContent = cmd.outputPreview;
      row.appendChild(pre);
    }

    row.addEventListener('click', () => {
      state.cmdAuditExpandedId = isExp ? null : cmd.id;
      renderCommandAuditWidget(tl);
    });
    listEl.appendChild(row);
  }
}

/**
 * 统一触发驾驶舱 KPI 联动条与 4 枚深度审计卡片刷新。
 */
function renderAuditWidgetsSection(tl, breakdown, activeCall) {
  renderKpiLinkagePills(tl, breakdown);
  renderTokenBreakdownWidget(tl, activeCall);
  renderContextEventsWidget(tl);
  renderFileRadarWidget(tl);
  renderCommandAuditWidget(tl);
}

/**
 * 绑定文件变更雷达与终端命令审计筛选搜索交互。
 */
function initAuditWidgetsControls() {
  const getTl = () => (typeof resolveTrendTimelineSource === 'function' ? resolveTrendTimelineSource() : state.sessionTimeline);

  const radarFilters = el('ctx-file-radar-filters');
  if (radarFilters && !radarFilters._auditBound) {
    radarFilters._auditBound = true;
    radarFilters.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-radar-op]');
      if (!btn) return;
      state.radarOpFilter = btn.getAttribute('data-radar-op') || 'all';
      renderFileRadarWidget(getTl());
    });
  }

  const radarInp = el('inp-file-radar-search');
  if (radarInp && !radarInp._auditBound) {
    radarInp._auditBound = true;
    radarInp.addEventListener('input', () => {
      state.radarSearchQuery = radarInp.value || '';
      renderFileRadarWidget(getTl());
    });
  }

  const clearProgBtn = el('btn-cmd-prog-clear');
  if (clearProgBtn && !clearProgBtn._auditBound) {
    clearProgBtn._auditBound = true;
    clearProgBtn.addEventListener('click', () => {
      state.cmdAuditProgramFilter = null;
      renderCommandAuditWidget(getTl());
    });
  }

  const cmdFilters = el('ctx-cmd-audit-filters');
  if (cmdFilters && !cmdFilters._auditBound) {
    cmdFilters._auditBound = true;
    cmdFilters.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-cmd-filter]');
      if (!btn) return;
      state.cmdAuditFilter = btn.getAttribute('data-cmd-filter') || 'all';
      renderCommandAuditWidget(getTl());
    });
  }

  const cmdInp = el('inp-cmd-audit-search');
  if (cmdInp && !cmdInp._auditBound) {
    cmdInp._auditBound = true;
    cmdInp.addEventListener('input', () => {
      state.cmdAuditQuery = cmdInp.value || '';
      renderCommandAuditWidget(getTl());
    });
  }
}
