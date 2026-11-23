// =========================================================================
// 模块 3B: 上下文解剖台 · 分类树 / 顺序切片视图 / 搜索排序 / 助手过滤 / 安全渲染预览与附件视觉审计
// =========================================================================

const INSPECTOR_SOURCE_LABEL_KEYS = {
  builtin: 'session.inspector.sourceBuiltin',
  mcp: 'session.inspector.sourceMcp',
  skill: 'session.inspector.sourceSkill'
};

let inspectorCopyResetTimer = null;

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

  // 1. 分类树模式渲染，完整保留 .ctx-tree-node[data-tree-cat] 测试与交互契约
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

  // 2. 顺序切片视图渲染：按实际提示词拼装顺序逆序 #N .. #1 展示
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

  // 3. 右子栏详情预览区：兼容旧测例聚焦分类逻辑，并支持原文 / 安全渲染切换与复制
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

  // 4. 多模态附件视觉审计卡片
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
