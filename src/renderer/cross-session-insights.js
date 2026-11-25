// =========================================================================
// 模块 3F: 跨会话全局洞察大盘 · 热力图日期联动 / 近 7 天双指标 / 高频榜 / 会话档案流
// =========================================================================

/**
 * 热力图格点击回调：切换选中日期过滤状态，刷新热力图紫色外环并重绘跨会话洞察大盘。
 */
function handleHeatmapDaySelected(dateStr) {
  const clean = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())
    ? dateStr.trim()
    : null;
  if (!clean) return false;
  state.csiSelectedDate = state.csiSelectedDate === clean ? null : clean;
  if (typeof renderActiveHeatView === 'function') renderActiveHeatView(true);
  renderCrossSessionInsightsSection();
  return true;
}

/**
 * 从当前已加载历史载荷与 dailyMap 规范化提取近 7 天日期切片与榜单项。
 */
function buildEffectiveCrossSessionInsights() {
  const rawCsi = ANTIGRAVITY_TOKEN_DATA?.crossSessionInsights || null;
  const rawDailyInsights = (rawCsi && rawCsi.dailyInsights && typeof rawCsi.dailyInsights === 'object')
    ? rawCsi.dailyInsights
    : {};
  const fallbackDailyMap = ANTIGRAVITY_TOKEN_DATA?.dailyMap || {};
  const mergedDaily = { ...rawDailyInsights };
  for (const [dk, rec] of Object.entries(fallbackDailyMap)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !rec) continue;
    if (!mergedDaily[dk]) {
      const inp = Number(rec.input || 0) + Number(rec.cache || 0);
      mergedDaily[dk] = {
        tokens: Number(rec.total || 0),
        input: Number(rec.input || 0),
        cache: Number(rec.cache || 0),
        output: Number(rec.output || 0),
        costUSD: 0,
        calls: Number(rec.steps || 0),
        sessions: 0,
        cacheReadPct: inp > 0 ? Math.round((Number(rec.cache || 0) / inp) * 1000) / 10 : 0
      };
    }
  }
  return {
    dailyInsights: mergedDaily,
    topTools: Array.isArray(rawCsi?.topTools) ? rawCsi.topTools : [],
    topCommands: Array.isArray(rawCsi?.topCommands) ? rawCsi.topCommands : [],
    topSkills: Array.isArray(rawCsi?.topSkills) ? rawCsi.topSkills : [],
    sessionArchives: Array.isArray(rawCsi?.sessionArchives) ? rawCsi.sessionArchives : []
  };
}

/**
 * 渲染高频工具 / 高频命令 / 技能加载榜，支持按热力图选中日期过滤计数。
 */
function renderCsiRankBoard(containerEl, list, selectedDate, kind) {
  if (!containerEl) return;
  containerEl.replaceChildren();
  const rows = (Array.isArray(list) ? list : [])
    .map(item => {
      const count = selectedDate
        ? Number(item?.byDate?.[selectedDate] || 0)
        : Number(item?.count || 0);
      const name = kind === 'cmd' ? (item?.program || item?.command || item?.name || 'cmd') : (item?.name || 'item');
      return { name, count, raw: item };
    })
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  if (!rows.length) {
    const em = document.createElement('div');
    em.className = 'timeline-turn-meta';
    em.textContent = t('tokens.insights.empty');
    containerEl.appendChild(em);
    return;
  }

  const maxCnt = Math.max(1, ...rows.map(r => r.count));
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'csi-board-row';
    const left = document.createElement('span');
    left.style.cssText = 'min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    left.textContent = r.name;
    const barWrap = document.createElement('span');
    barWrap.className = 'ctx-cmd-prog-bar';
    barWrap.style.maxWidth = '64px';
    const barFill = document.createElement('span');
    barFill.className = 'ctx-cmd-prog-fill';
    barFill.style.display = 'block';
    barFill.style.width = `${Math.max(8, (r.count / maxCnt) * 100).toFixed(1)}%`;
    barWrap.appendChild(barFill);
    const valEl = document.createElement('strong');
    valEl.style.fontVariantNumeric = 'tabular-nums';
    valEl.textContent = String(r.count);
    row.appendChild(left);
    row.appendChild(barWrap);
    row.appendChild(valEl);
    containerEl.appendChild(row);
  }
}

/**
 * 渲染近 7 天成对 Token 与估算费用图，支持点击日柱反向筛选日期。
 */
function renderCsi7dChart(svg, dailyInsights, selectedDate) {
  if (!svg) return;
  const allDates = Object.keys(dailyInsights).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  let windowDates = [];
  if (allDates.length > 0) {
    if (selectedDate && allDates.includes(selectedDate)) {
      const idx = allDates.indexOf(selectedDate);
      const start = Math.max(0, Math.min(allDates.length - 7, idx - 3));
      windowDates = allDates.slice(start, start + 7);
    } else {
      windowDates = allDates.slice(-7);
    }
  }

  const width = 640;
  const height = 110;
  const padL = 36;
  const padR = 38;
  const padT = 14;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  svg.setAttribute?.('viewBox', `0 0 ${width} ${height}`);

  const nodes = [];
  if (!windowDates.length) {
    const em = createSvgEl('text', {
      x: String(width / 2), y: String(height / 2),
      'text-anchor': 'middle', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '11'
    });
    if (em) {
      em.textContent = t('tokens.insights.empty');
      nodes.push(em);
    }
    if (typeof svg.replaceChildren === 'function') svg.replaceChildren(...nodes);
    return;
  }

  const items = windowDates.map(dk => ({
    date: dk,
    tokens: Number(dailyInsights[dk]?.tokens || 0),
    costUSD: Number(dailyInsights[dk]?.costUSD || 0)
  }));
  const maxTok = Math.max(1000, ...items.map(i => i.tokens));
  const maxCost = Math.max(0.01, ...items.map(i => i.costUSD));
  const slotW = plotW / items.length;
  const subBarW = Math.max(6, Math.min(18, slotW * 0.28));

  [0, 1].forEach(r => {
    const y = padT + plotH * (1 - r);
    const gl = createSvgEl('line', {
      x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
      stroke: 'rgba(148,163,184,0.18)', 'stroke-width': '1'
    });
    if (gl) nodes.push(gl);
    if (r === 1) {
      const lt = createSvgEl('text', {
        x: padL - 4, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: '#10B981', 'font-size': '8.5'
      });
      if (lt) { lt.textContent = short(maxTok); nodes.push(lt); }
      const rt = createSvgEl('text', {
        x: width - padR + 4, y: (y + 3).toFixed(1), 'text-anchor': 'start',
        fill: '#C084FC', 'font-size': '8.5'
      });
      if (rt) { rt.textContent = `$${maxCost.toFixed(2)}`; nodes.push(rt); }
    }
  });

  items.forEach((it, idx) => {
    const cx = padL + (idx + 0.5) * slotW;
    const isSel = selectedDate === it.date;
    const tokH = Math.max(2, (it.tokens / maxTok) * plotH);
    const costH = it.costUSD > 0 ? Math.max(2, (it.costUSD / maxCost) * plotH) : 0;

    const tokRect = createSvgEl('rect', {
      x: (cx - subBarW - 1.5).toFixed(1),
      y: (padT + plotH - tokH).toFixed(1),
      width: subBarW.toFixed(1),
      height: tokH.toFixed(1),
      rx: '2',
      fill: '#10B981',
      stroke: isSel ? '#FFFFFF' : 'none',
      'stroke-width': isSel ? '1.2' : '0',
      style: 'cursor:pointer',
      'data-csi-day': it.date
    });
    if (tokRect) {
      tokRect.addEventListener?.('click', () => handleHeatmapDaySelected(it.date));
      nodes.push(tokRect);
    }

    if (costH > 0) {
      const costRect = createSvgEl('rect', {
        x: (cx + 1.5).toFixed(1),
        y: (padT + plotH - costH).toFixed(1),
        width: subBarW.toFixed(1),
        height: costH.toFixed(1),
        rx: '2',
        fill: '#C084FC',
        stroke: isSel ? '#FFFFFF' : 'none',
        'stroke-width': isSel ? '1.2' : '0',
        style: 'cursor:pointer',
        'data-csi-day': it.date
      });
      if (costRect) {
        costRect.addEventListener?.('click', () => handleHeatmapDaySelected(it.date));
        nodes.push(costRect);
      }
    }

    const dLbl = createSvgEl('text', {
      x: cx.toFixed(1),
      y: String(height - 6),
      'text-anchor': 'middle',
      fill: isSel ? '#C084FC' : 'var(--ag-text-muted, #8a8a94)',
      'font-size': '9',
      'font-weight': isSel ? '700' : '400'
    });
    if (dLbl) {
      dLbl.textContent = it.date.slice(5);
      nodes.push(dLbl);
    }
  });

  if (typeof svg.replaceChildren === 'function') svg.replaceChildren(...nodes);
  else {
    svg.innerHTML = '';
    nodes.forEach(n => svg.appendChild?.(n));
  }
}

/**
 * 渲染 #panel-tokens 跨会话全局洞察大盘全部模块与会话档案列表。
 */
function renderCrossSessionInsightsSection() {
  const sec = el('cross-session-insights-section');
  if (!sec) return;
  const datePill = el('csi-date-filter-pill');
  const clearBtn = el('btn-csi-clear-date');
  const summaryPills = el('csi-summary-pills');
  const chartSvg = el('csi-7d-chart-svg');
  const topToolsEl = el('csi-top-tools');
  const topCmdsEl = el('csi-top-commands');
  const topSkillsEl = el('csi-top-skills');
  const wsFiltersEl = el('csi-workspace-filters');
  const sortsEl = el('csi-archive-sorts');
  const archiveListEl = el('csi-archive-list');

  const data = buildEffectiveCrossSessionInsights();
  const selDate = state.csiSelectedDate || null;
  const wsFilter = state.csiWorkspaceFilter || 'all';
  const sortBy = state.csiSortBy || 'recent';
  const query = String(state.csiSearchQuery || '').trim().toLowerCase();

  if (datePill) {
    if (selDate) {
      datePill.hidden = false;
      datePill.textContent = t('tokens.insights.filteredDate', { date: selDate });
    } else {
      datePill.hidden = true;
      datePill.textContent = '';
    }
  }
  if (clearBtn) clearBtn.hidden = !selDate;

  // 统计摘要胶囊
  if (summaryPills) {
    summaryPills.replaceChildren();
    let totalTok = 0;
    let totalCost = 0;
    let totalCalls = 0;
    let sessionsCount = 0;
    if (selDate && data.dailyInsights[selDate]) {
      const dr = data.dailyInsights[selDate];
      totalTok = Number(dr.tokens || 0);
      totalCost = Number(dr.costUSD || 0);
      totalCalls = Number(dr.calls || 0);
      sessionsCount = Number(dr.sessions || 0);
    } else {
      const vals = Object.values(data.dailyInsights);
      for (const dr of vals) {
        totalTok += Number(dr?.tokens || 0);
        totalCost += Number(dr?.costUSD || 0);
        totalCalls += Number(dr?.calls || 0);
      }
      sessionsCount = data.sessionArchives.length;
    }
    const items = [
      `${sessionsCount} 会话`,
      `${totalCalls} 请求`,
      `${short(totalTok)} tok`,
      ...(totalCost > 0 ? [`$${totalCost.toFixed(2)}`] : [])
    ];
    for (const txt of items) {
      const sp = document.createElement('span');
      sp.className = 'ctx-ov-meta-pill';
      sp.textContent = txt;
      summaryPills.appendChild(sp);
    }
  }

  renderCsi7dChart(chartSvg, data.dailyInsights, selDate);
  renderCsiRankBoard(topToolsEl, data.topTools, selDate, 'tool');
  renderCsiRankBoard(topCmdsEl, data.topCommands, selDate, 'cmd');
  renderCsiRankBoard(topSkillsEl, data.topSkills, selDate, 'skill');

  // 工作区动态筛选胶囊
  if (wsFiltersEl) {
    wsFiltersEl.replaceChildren();
    const workspaces = Array.from(new Set(data.sessionArchives.map(a => a.workspaceTag).filter(Boolean))).slice(0, 8);
    const tags = ['all', ...workspaces];
    for (const tag of tags) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tl-filter-chip${wsFilter === tag ? ' active' : ''}`;
      btn.setAttribute('data-csi-ws', tag);
      btn.textContent = tag === 'all' ? t('tokens.insights.allWorkspaces') : tag;
      btn.addEventListener('click', () => {
        state.csiWorkspaceFilter = tag;
        renderCrossSessionInsightsSection();
      });
      wsFiltersEl.appendChild(btn);
    }
  }

  if (sortsEl) {
    for (const b of Array.from(sortsEl.querySelectorAll?.('[data-csi-sort]') || [])) {
      const act = b.getAttribute('data-csi-sort') === sortBy;
      b.classList?.toggle?.('active', act);
      b.setAttribute?.('aria-pressed', act ? 'true' : 'false');
    }
  }

  // 会话档案流渲染
  if (archiveListEl) {
    archiveListEl.replaceChildren();
    let archives = data.sessionArchives.filter(sa => {
      if (!sa) return false;
      if (selDate && sa.date !== selDate) return false;
      if (wsFilter !== 'all' && sa.workspaceTag !== wsFilter) return false;
      if (!query) return true;
      return `${sa.title || ''} ${sa.workspaceTag || ''} ${sa.modelLabel || ''} ${sa.cascadeId || ''}`.toLowerCase().includes(query);
    });

    if (sortBy === 'tokens') archives = archives.slice().sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    else if (sortBy === 'cost') archives = archives.slice().sort((a, b) => (b.costUSD || 0) - (a.costUSD || 0));
    else archives = archives.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!archives.length) {
      const em = document.createElement('div');
      em.className = 'timeline-turn-meta';
      em.textContent = t('tokens.insights.empty');
      archiveListEl.appendChild(em);
      return;
    }

    for (const sa of archives.slice(0, 36)) {
      const card = document.createElement('div');
      card.className = 'csi-archive-card';
      card.setAttribute('data-archive-cid', sa.cascadeId || '');

      const top = document.createElement('div');
      top.className = 'ctx-radar-top';
      const titleEl = document.createElement('strong');
      titleEl.style.cssText = 'font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      titleEl.textContent = sa.title || (sa.cascadeId ? sa.cascadeId.slice(0, 12) : 'session');
      const dateSp = document.createElement('span');
      dateSp.style.cssText = 'font-size:10px;color:var(--ag-text-muted);flex-shrink:0;';
      dateSp.textContent = sa.date || '—';
      top.appendChild(titleEl);
      top.appendChild(dateSp);

      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;font-size:10px;color:var(--ag-text-secondary);';
      if (sa.workspaceTag) {
        const wsPill = document.createElement('span');
        wsPill.className = 'ctx-ov-meta-pill';
        wsPill.textContent = sa.workspaceTag;
        meta.appendChild(wsPill);
      }
      if (sa.modelLabel) {
        const mSp = document.createElement('span');
        mSp.textContent = sa.modelLabel;
        meta.appendChild(mSp);
      }

      const bar = document.createElement('div');
      bar.className = 'csi-archive-bar';
      const ratios = sa.compositionRatios || { inputPct: 0, cachePct: 0, outputPct: 0 };
      for (const [col, pct] of [['#10B981', ratios.inputPct], ['#FB923C', ratios.cachePct], ['#C084FC', ratios.outputPct]]) {
        if (!(pct > 0)) continue;
        const seg = document.createElement('div');
        seg.style.cssText = `width:${Math.max(2, pct)}%;background:${col};height:100%;`;
        bar.appendChild(seg);
      }

      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;justify-content:space-between;font-size:10.5px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums;';
      const leftF = document.createElement('span');
      leftF.textContent = `${short(sa.totalTokens || 0)} · Cache ${sa.cacheReadPct ?? 0}%`;
      const rightF = document.createElement('span');
      rightF.textContent = sa.costUSD > 0 ? `$${Number(sa.costUSD).toFixed(3)}` : `${sa.callCount || 0} calls`;
      foot.appendChild(leftF);
      foot.appendChild(rightF);

      card.appendChild(top);
      card.appendChild(meta);
      card.appendChild(bar);
      card.appendChild(foot);
      archiveListEl.appendChild(card);
    }
  }
}

/**
 * 绑定跨会话全局洞察大盘日期清除、搜索与排序控件。
 */
function initCrossSessionInsightsControls() {
  const clearBtn = el('btn-csi-clear-date');
  if (clearBtn && !clearBtn._csiBound) {
    clearBtn._csiBound = true;
    clearBtn.addEventListener('click', () => {
      state.csiSelectedDate = null;
      if (typeof renderActiveHeatView === 'function') renderActiveHeatView(true);
      renderCrossSessionInsightsSection();
    });
  }

  const searchInp = el('csi-archive-search');
  if (searchInp && !searchInp._csiBound) {
    searchInp._csiBound = true;
    searchInp.addEventListener('input', () => {
      state.csiSearchQuery = searchInp.value || '';
      renderCrossSessionInsightsSection();
    });
  }

  const sortsEl = el('csi-archive-sorts');
  if (sortsEl && !sortsEl._csiBound) {
    sortsEl._csiBound = true;
    sortsEl.addEventListener('click', (ev) => {
      const btn = ev?.target?.closest?.('[data-csi-sort]');
      if (!btn) return;
      state.csiSortBy = btn.getAttribute('data-csi-sort') || 'recent';
      renderCrossSessionInsightsSection();
    });
  }
}
