// =========================================================================
// 模块 3A: 全景脉冲趋势增强 · 全会话压缩带 / 耗时叠加 / 事件标旗 / Hover Scrub 与三行摘要
// =========================================================================

/**
 * 在步骤快览条中匹配并渲染当前悬停或选中点的三行语义摘要。
 */
function resolveTrendStepQuickSummary(pt, timelineSrc) {
  if (!pt) return null;
  const trace = timelineSrc?.executionTrace || null;
  const quickList = Array.isArray(trace?.stepQuickSummaries) ? trace.stepQuickSummaries : [];
  let matched = null;
  if (pt.stepIndex != null) {
    matched = quickList.find(q => Number(q.stepIndex) === Number(pt.stepIndex))
      || quickList.find(q => q.stepIndex != null && Number(q.stepIndex) <= Number(pt.stepIndex) && q.turnIndex === pt.turnIndex);
  }
  if (!matched && pt.turnIndex != null) {
    const turnItems = quickList.filter(q => Number(q.turnIndex) === Number(pt.turnIndex));
    if (turnItems.length) matched = turnItems[turnItems.length - 1];
  }
  if (matched) return matched;

  const calls = Array.isArray(timelineSrc?.turns)
    ? timelineSrc.turns.flatMap(turn => Array.isArray(turn?.calls) ? turn.calls : [])
    : [];
  const callRec = calls.find(c =>
    (pt.callId && c.callId === pt.callId)
    || (pt.stepIndex != null && Number(c.stepIndex) === Number(pt.stepIndex))
  ) || null;
  const toolsList = Array.isArray(callRec?.toolNames) && callRec.toolNames.length
    ? callRec.toolNames.slice(0, 4).join(' · ')
    : '';
  const intent = callRec?.userPromptPreview || pt.modelLabel || pt.label || '—';
  const loadedParts = [];
  if (Number(pt.cacheReadTokens) > 0) loadedParts.push(`${t('session.dual.cacheRead')} ${short(pt.cacheReadTokens)}`);
  if (Number(pt.freshInputTokens) > 0) loadedParts.push(`${t('session.dual.cacheFresh')} ${short(pt.freshInputTokens)}`);
  if (toolsList) loadedParts.push(toolsList);
  const loaded = loadedParts.join(' · ') || '—';
  const actionParts = [];
  if (Number(pt.outputTokens) > 0) actionParts.push(`${t('heat.output')} ${short(pt.outputTokens)}`);
  if (pt.durationSec != null && Number(pt.durationSec) > 0) actionParts.push(`${Number(pt.durationSec).toFixed(2)}s`);
  const action = actionParts.join(' · ') || (pt.modelLabel || '—');
  return {
    stepIndex: pt.stepIndex ?? null,
    turnIndex: pt.turnIndex ?? null,
    intent,
    loaded,
    action
  };
}

/**
 * 渲染趋势图下方 3 行一步语义快览条，点击可平滑定位上下文解剖台。
 */
function renderTrendStepQuickbar(pt, timelineSrc) {
  const bar = el('ctx-trend-step-quickbar');
  if (!bar) return;
  bar.replaceChildren();
  const quick = resolveTrendStepQuickSummary(pt, timelineSrc);
  if (!quick) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'timeline-turn-meta';
    emptyEl.textContent = t('session.trend.quickEmpty');
    bar.appendChild(emptyEl);
    return;
  }

  const rows = [
    { keyLabel: t('session.trend.quickIntent'), val: quick.intent || '—' },
    { keyLabel: t('session.trend.quickLoaded'), val: quick.loaded || '—' },
    { keyLabel: t('session.trend.quickAction'), val: quick.action || '—' }
  ];
  for (const r of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'ctx-trend-quick-row';
    const kEl = document.createElement('span');
    kEl.className = 'ctx-trend-quick-k';
    kEl.textContent = r.keyLabel;
    const vEl = document.createElement('span');
    vEl.className = 'ctx-trend-quick-v';
    vEl.textContent = String(r.val || '—').slice(0, 120);
    vEl.title = String(r.val || '');
    rowEl.appendChild(kEl);
    rowEl.appendChild(vEl);
    bar.appendChild(rowEl);
  }
  bar.setAttribute('data-step-index', quick.stepIndex != null ? String(quick.stepIndex) : '');
}

/**
 * 悬停趋势节点时的实时 Scrub：联动检查文本、快览条及预览窗高亮，不改动持久化固定步骤。
 */
function handleTrendPointHover(pt, timelineSrc) {
  if (!pt) return;
  const inspectEl = el('ctx-trend-inspect');
  if (inspectEl && typeof formatTrendInspectText === 'function') {
    inspectEl.textContent = formatTrendInspectText(pt);
  }
  const pillEl = el('ctx-trend-pill');
  if (pillEl) {
    const pillDelta = pt.deltaTokens != null ? ` · Δ${pt.deltaTokens > 0 ? '+' : ''}${short(pt.deltaTokens)}` : '';
    const durSuffix = pt.durationSec != null && Number(pt.durationSec) > 0 ? ` · ${Number(pt.durationSec).toFixed(1)}s` : '';
    pillEl.hidden = false;
    pillEl.textContent = `${pt.label || `#${(pt.index || 0) + 1}`} · ${short(pt.totalContextTokens || 0)}${pillDelta}${durSuffix}`;
  }
  renderTrendStepQuickbar(pt, timelineSrc);
}

/**
 * 在趋势图基础 SVG 之上叠加全会话压缩态标识、右轴耗时折线、事件标旗交互与 3 行步骤快览。
 */
function renderTrendPulseExtras(series, pts, svg, timelineSrc, layoutMeta) {
  const compressBtn = el('btn-trend-compress-all');
  if (compressBtn) {
    const isAct = Boolean(state.trendCompressAll);
    compressBtn.classList?.toggle?.('active', isAct);
    compressBtn.setAttribute?.('aria-pressed', isAct ? 'true' : 'false');
  }
  const latencyBtn = el('btn-trend-latency-overlay');
  if (latencyBtn) {
    const isLat = Boolean(state.trendLatencyOverlay);
    latencyBtn.classList?.toggle?.('active', isLat);
    latencyBtn.setAttribute?.('aria-pressed', isLat ? 'true' : 'false');
  }

  const displayPt = layoutMeta?.displayPt || (Array.isArray(pts) && pts.length ? pts[pts.length - 1] : null);
  renderTrendStepQuickbar(displayPt, timelineSrc);

  if (!svg || !Array.isArray(pts) || !pts.length || !layoutMeta) return;

  const { width, padL, padR, padT, plotW, plotH, slotW } = layoutMeta;
  const baseBottomY = padT + plotH;

  // 若开启耗时叠加，在同一画布右轴绘制步骤耗时折线与峰值标注
  if (state.trendLatencyOverlay) {
    const durValues = pts.map(p => (p.durationSec != null && Number(p.durationSec) > 0) ? Number(p.durationSec) : null);
    const validDurs = durValues.filter(v => v != null && v > 0);
    if (validDurs.length > 0) {
      const maxDur = Math.max(0.5, ...validDurs);
      const latCoords = [];
      for (let i = 0; i < pts.length; i++) {
        const dVal = durValues[i];
        if (dVal == null) continue;
        const cx = padL + (i + 0.5) * slotW;
        const ratio = Math.min(1, Math.max(0, dVal / maxDur));
        const cy = baseBottomY - ratio * Math.max(12, plotH - 8);
        latCoords.push({ x: cx, y: cy, dur: dVal, pt: pts[i] });
      }
      if (latCoords.length >= 2) {
        const pathD = latCoords.map((lp, idx) => `${idx === 0 ? 'M' : 'L'} ${lp.x.toFixed(1)} ${lp.y.toFixed(1)}`).join(' ');
        const latPath = createSvgEl('path', {
          d: pathD,
          fill: 'none',
          stroke: '#A855F7',
          'stroke-width': '1.6',
          'stroke-dasharray': '4 2',
          style: 'pointer-events:none'
        });
        if (latPath) svg.appendChild?.(latPath);
      }
      for (const lp of latCoords) {
        const dot = createSvgEl('circle', {
          cx: lp.x.toFixed(1),
          cy: lp.y.toFixed(1),
          r: '2.5',
          fill: '#C084FC',
          stroke: 'var(--ctx-ck-card, #151517)',
          'stroke-width': '1',
          'data-latency-sec': String(lp.dur)
        });
        const titleNode = createSvgEl('title', {});
        if (titleNode) {
          titleNode.textContent = `${lp.pt?.label || ''} · ${lp.dur.toFixed(2)}s`;
          dot?.appendChild?.(titleNode);
        }
        if (dot) svg.appendChild?.(dot);
      }
      const maxLbl = createSvgEl('text', {
        x: (width - padR).toFixed(1),
        y: (padT + 9).toFixed(1),
        'text-anchor': 'end',
        fill: '#C084FC',
        'font-size': '8.5',
        style: 'pointer-events:none'
      });
      if (maxLbl) {
        maxLbl.textContent = `${maxDur >= 10 ? Math.round(maxDur) : maxDur.toFixed(1)}s`;
        svg.appendChild?.(maxLbl);
      }
    }
  }

  // 在事件标记点或压缩标记点旁补充可点击提示，点击联动跳转上下文异动日志
  const existingEvNodes = svg.querySelectorAll ? Array.from(svg.querySelectorAll('[data-event-type]')) : [];
  for (const evDot of existingEvNodes) {
    evDot.addEventListener?.('click', () => {
      if (typeof revealAndScrollToCockpitWidget === 'function') {
        revealAndScrollToCockpitWidget('context-events', { flash: true });
      }
    });
  }

  // 全会话压缩带模式下保留左右全跨度标记徽标
  if (state.trendCompressAll && series?.totalPoints > pts.length) {
    const truncEl = el('ctx-trend-trunc-note');
    if (truncEl) {
      truncEl.hidden = false;
      truncEl.textContent = `${t('session.trend.compressAll')} · ${pts.length} / ${series.totalPoints}`;
    }
  }
}

/**
 * 绑定全景脉冲趋势卡片交互控件。
 */
function initTrendPulseControls() {
  const compressBtn = el('btn-trend-compress-all');
  if (compressBtn && !compressBtn._trendPulseBound) {
    compressBtn._trendPulseBound = true;
    compressBtn.addEventListener('click', () => {
      state.trendCompressAll = !state.trendCompressAll;
      if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
    });
  }

  const latencyBtn = el('btn-trend-latency-overlay');
  if (latencyBtn && !latencyBtn._trendPulseBound) {
    latencyBtn._trendPulseBound = true;
    latencyBtn.addEventListener('click', () => {
      state.trendLatencyOverlay = !state.trendLatencyOverlay;
      if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
    });
  }

  const quickbar = el('ctx-trend-step-quickbar');
  if (quickbar && !quickbar._trendPulseBound) {
    quickbar._trendPulseBound = true;
    quickbar.addEventListener('click', () => {
      const stepRaw = quickbar.getAttribute('data-step-index');
      if (stepRaw !== null && stepRaw !== '') {
        const sNum = Number(stepRaw);
        if (Number.isInteger(sNum) && typeof jumpToStepOrTurn === 'function') {
          jumpToStepOrTurn({ stepIndex: sNum });
        }
      }
      if (typeof revealAndScrollToCockpitWidget === 'function') {
        revealAndScrollToCockpitWidget('context-inspector', { flash: true });
      }
    });
  }
}
