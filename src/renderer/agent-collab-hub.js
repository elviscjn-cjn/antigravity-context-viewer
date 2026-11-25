// =========================================================================
// 模块 3D: 多代理协作中枢 · 主子拓扑 / 协作泳道 / 委派任务 / 交互回执检查器
// =========================================================================

const COLLAB_STATUS_COLORS = {
  running: '#A855F7',
  in_progress: '#A855F7',
  pending: '#F59E0B',
  completed: '#10B981',
  failed: '#F43F5E'
};

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
    ['#C084FC', (Number(outTok || 0) / tot) * 100]
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

  // 1. 左侧主子代理拓扑卡片（点击筛选右侧泳道与回执）
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
      meta.textContent = `${short(ag.totalTokens)} tok · ${ag.callCount} calls${durTxt}`;

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

  // 2. 右上跨代理时间泳道
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

  // 3. 右中委派任务分组列表
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

  // 4. 下方双栏交互回执检查器
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
