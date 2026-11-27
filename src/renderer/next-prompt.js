  // =========================================================================
  // 下一句预测控制器 (Phase 6 · 默认关闭、8 项拦截门禁、跨会话/草稿隔离、Tab 仅填不发)
  // =========================================================================

  let nextPromptEnabled = (() => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem('ag_next_prompt_enabled') === 'true';
      }
    } catch { }
    return false;
  })();

  const NEXT_PROMPT_STYLE_ID = 'ag-next-prompt-style';
  let nextPromptState = {
    seq: 0,
    inFlight: false,
    suggestion: '',
    routeId: null,
    turnKey: null,
    model: null,
    composerEl: null,
    ghostEl: null,
    inlineHostEl: null,
    cachedRouteId: null,
    cachedTurnKey: null,
    cachedSuggestion: '',
    isComposing: false,
    attemptedTurnKeys: new Set(),
    dismissedTurnKeys: new Set()
  };

  function ensureNextPromptStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      let st = document.getElementById(NEXT_PROMPT_STYLE_ID);
      if (!st) {
        st = document.createElement('style');
        st.id = NEXT_PROMPT_STYLE_ID;
        document.head.appendChild(st);
      }
      st.textContent = `
        [data-ag-np-active="true"] > p.pointer-events-none,
        [data-ag-np-active="true"] > p[class*="pointer-events-none"] {
          opacity: 0 !important;
          visibility: hidden !important;
        }
        @keyframes ag-np-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .ag-np-ghost {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin: 4px 10px 4px;
          padding: 5px 10px;
          border-radius: 8px;
          border: 1px dashed rgba(100, 116, 139, 0.45);
          background: rgba(139, 92, 246, 0.07);
          color: var(--ag-text-secondary, #475569);
          font-size: 12px;
          line-height: 1.4;
          pointer-events: auto;
          user-select: none;
        }
        .ag-np-ghost.ag-np-inline {
          position: absolute;
          top: 8px;
          left: 8px;
          right: 8px;
          z-index: 1;
          display: inline-flex;
          align-items: center;
          justify-content: flex-start;
          gap: 6px;
          max-width: calc(100% - 16px);
          height: 24px;
          margin: 0;
          padding: 0;
          border: none;
          border-radius: 0;
          background: transparent;
          color: inherit;
          font-size: 14px;
          line-height: 24px;
          pointer-events: none;
          user-select: none;
          animation: ag-np-fade-in 150ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .ag-np-ghost.ag-np-inline {
            animation: none;
          }
        }
        .ag-np-ghost[hidden] {
          display: none !important;
        }
        .ag-np-ghost-text {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-style: normal;
        }
        .ag-np-ghost.ag-np-inline .ag-np-ghost-text {
          flex: 0 1 auto;
          opacity: 0.45;
        }
        .ag-np-ghost-actions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
          font-size: 11px;
        }
        .ag-np-kbd {
          padding: 1px 6px;
          border-radius: 4px;
          border: 1px solid rgba(100, 116, 139, 0.42);
          background: rgba(148, 163, 184, 0.14);
          cursor: pointer;
          font-family: inherit;
          color: inherit;
        }
        .ag-np-ghost.ag-np-inline .ag-np-kbd {
          pointer-events: auto;
          height: 18px;
          line-height: 16px;
          padding: 0 5px;
          font-size: 10.5px;
          font-weight: 500;
          border-radius: 4px;
          border: 1px solid rgba(128, 128, 128, 0.35);
          background: rgba(128, 128, 128, 0.08);
          opacity: 0.55;
          transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease;
        }
        .ag-np-kbd:hover {
          background: rgba(139, 92, 246, 0.2);
          border-color: rgba(139, 92, 246, 0.5);
        }
        .ag-np-ghost.ag-np-inline .ag-np-kbd:hover {
          opacity: 0.92;
          background: rgba(128, 128, 128, 0.18);
          border-color: rgba(128, 128, 128, 0.55);
        }
      `;
    } catch { }
  }

  function resolveComposerEditorEl(composer) {
    if (!composer || typeof composer.querySelector !== 'function') return null;
    return composer.querySelector('[data-lexical-editor="true"][contenteditable="true"], textarea, [contenteditable="true"]');
  }

  function readEditorDraftText(editor) {
    if (!editor) return '';
    if (typeof editor.value === 'string') return editor.value;
    return String(editor.textContent || '');
  }

  function findActiveVisibleComposer(targetRoute) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const composers = Array.from(document.querySelectorAll('.surface-composer') || [])
      .filter(c => c && !c.closest?.('#ag-context-meter, [role="dialog"], .settings-modal-container'));
    if (!composers.length) return null;

    const activeEl = document.activeElement;
    if (activeEl) {
      const focusedComp = activeEl.closest?.('.surface-composer') || composers.find(c => c.contains?.(activeEl));
      if (focusedComp) return focusedComp;
    }
    if (targetRoute) {
      const matched = composers.find(c => {
        const conv = c.closest?.('[data-testid="conversation-view"], [data-cascade-id], [data-session-id]');
        const cid = conv?.getAttribute?.('data-cascade-id') || conv?.getAttribute?.('data-session-id') || '';
        return cid && sameRouteId(cid, targetRoute);
      });
      if (matched) return matched;
    }
    return composers[0];
  }

  function hasPendingHostApprovalOrQueue(composer) {
    try {
      if (state.livePendingRequest) return true;
      if (state.compacting || state.lastDomCompactingActive) return true;
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        const stopBtn = composer
          ? composer.querySelector?.('button[data-testid="stop-button"], button[data-testid="input-cancel-button"]:not([disabled]), button[aria-label^="Stop"]')
          : document.querySelector('.surface-composer button[data-testid="stop-button"], .surface-composer button[data-testid="input-cancel-button"]:not([disabled])');
        if (stopBtn) return true;
        const approvalBtn = document.querySelector('[data-testid*="approval"], [data-testid*="permission-prompt"], [role="alertdialog"]');
        if (approvalBtn && !approvalBtn.closest?.('#ag-context-meter')) return true;
      }
      if (state.latest?.error || state.awaitingAutoRecovery) return true;
    } catch { }
    return false;
  }

  function clearNextPromptInlineHostFlag() {
    try {
      if (nextPromptState.inlineHostEl) {
        nextPromptState.inlineHostEl.removeAttribute?.('data-ag-np-active');
        nextPromptState.inlineHostEl = null;
      }
      const p = nextPromptState.ghostEl?.parentElement;
      if (p?.hasAttribute?.('data-ag-np-active')) {
        p.removeAttribute('data-ag-np-active');
      }
    } catch { }
  }

  function clearNextPromptCache() {
    nextPromptState.cachedRouteId = null;
    nextPromptState.cachedTurnKey = null;
    nextPromptState.cachedSuggestion = '';
  }

  function restoreCachedNextPromptIfEmpty(composer = null) {
    if (!nextPromptEnabled || state.disposed || nextPromptState.isComposing || nextPromptState.inFlight) return false;
    if (nextPromptState.suggestion) return false;
    if (!nextPromptState.cachedSuggestion || !nextPromptState.cachedTurnKey) return false;
    const curRoute = state.route || null;
    if (curRoute && nextPromptState.cachedRouteId && curRoute !== nextPromptState.cachedRouteId) return false;
    if (nextPromptState.dismissedTurnKeys.has(nextPromptState.cachedTurnKey)) return false;
    const comp = composer || findActiveVisibleComposer(curRoute);
    if (!comp || hasPendingHostApprovalOrQueue(comp)) return false;
    const editor = resolveComposerEditorEl(comp);
    if (!editor || editor.disabled || editor.getAttribute?.('aria-disabled') === 'true') return false;
    if (readEditorDraftText(editor).trim() !== '') return false;
    renderNextPromptGhost(comp, nextPromptState.cachedSuggestion);
    return true;
  }

  function dismissNextPromptSuggestion(invalidateInFlight = false, opts = {}) {
    if (invalidateInFlight) {
      nextPromptState.seq++;
      nextPromptState.inFlight = false;
    }
    if (opts && opts.explicitUserDismiss) {
      const tk = nextPromptState.turnKey || nextPromptState.cachedTurnKey;
      if (tk) nextPromptState.dismissedTurnKeys.add(tk);
      clearNextPromptCache();
    } else if (opts && opts.clearCache) {
      clearNextPromptCache();
    }
    nextPromptState.suggestion = '';
    clearNextPromptInlineHostFlag();
    if (nextPromptState.ghostEl) {
      nextPromptState.ghostEl.hidden = true;
      const textSpan = nextPromptState.ghostEl.querySelector?.('.ag-np-ghost-text');
      if (textSpan) textSpan.textContent = '';
    }
  }

  function acceptNextPromptIntoComposer(composer = null) {
    const text = nextPromptState.suggestion;
    const targetComp = composer || nextPromptState.composerEl;
    if (!text || !targetComp) return false;
    const editor = resolveComposerEditorEl(targetComp);
    if (!editor) return false;
    // 严格保护已有草稿不被覆盖
    if (readEditorDraftText(editor).trim() !== '') {
      dismissNextPromptSuggestion(true);
      return false;
    }
    // 先清空建议状态防止重入，再写入编辑器
    dismissNextPromptSuggestion(true);
    try {
      editor.focus?.();
      let insertedViaExecCommand = false;
      if (typeof editor.value === 'string') {
        editor.value = text;
      } else if (typeof document?.execCommand === 'function') {
        insertedViaExecCommand = Boolean(document.execCommand('insertText', false, text));
        if (!insertedViaExecCommand) editor.textContent = text;
      } else {
        editor.textContent = text;
      }
      if (!insertedViaExecCommand) {
        try {
          if (typeof editor.dispatchEvent === 'function') {
            editor.dispatchEvent(typeof InputEvent === 'function'
              ? new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
              : { type: 'input', target: editor });
          }
        } catch { }
      }
      return true;
    } catch {
      return false;
    }
  }

  function resolveNextPromptInlineHost(composer) {
    const editor = resolveComposerEditorEl(composer);
    const parent = editor?.parentElement || null;
    if (!editor || !parent || parent === composer) return null;
    const isLexical = editor.getAttribute?.('data-lexical-editor') === 'true';
    let isRelative = false;
    try {
      isRelative = typeof getComputedStyle === 'function' && getComputedStyle(parent).position === 'relative';
    } catch { }
    if (isLexical || isRelative) return parent;
    return null;
  }

  function renderNextPromptGhost(composer, suggestionText) {
    if (!composer || !suggestionText) {
      dismissNextPromptSuggestion(false);
      return;
    }
    ensureNextPromptStyles();
    const inlineHost = resolveNextPromptInlineHost(composer);
    const mountTarget = inlineHost || composer;
    const isInline = Boolean(inlineHost);

    let ghost = nextPromptState.ghostEl;
    const modeMatches = ghost ? (ghost.classList?.contains('ag-np-inline') === isInline) : false;
    if (!ghost || ghost.parentElement !== mountTarget || !modeMatches || !ghost.querySelector?.('.ag-np-ghost-text')) {
      clearNextPromptInlineHostFlag();
      if (ghost) try { ghost.remove?.(); } catch { }
      try {
        composer.querySelectorAll?.('[data-ag-next-prompt-ghost]')?.forEach?.(el => el.remove?.());
      } catch { }
      ghost = document.createElement('div');
      ghost.className = isInline ? 'ag-np-ghost ag-np-inline' : 'ag-np-ghost';
      ghost.setAttribute('data-ag-next-prompt-ghost', 'true');
      const txtEl = document.createElement('span');
      txtEl.className = 'ag-np-ghost-text';
      const actEl = document.createElement('span');
      actEl.className = 'ag-np-ghost-actions';
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'ag-np-kbd';
      tabBtn.setAttribute('data-np-action', 'accept');
      tabBtn.setAttribute('translate', 'no');
      tabBtn.textContent = isInline ? '⇥ Tab' : t('nextPrompt.tabFill');
      tabBtn.title = t('nextPrompt.tabFill');
      tabBtn.addEventListener('mousedown', (e) => {
        e.preventDefault?.();
        e.stopPropagation?.();
      });
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        acceptNextPromptIntoComposer(composer);
      });
      actEl.appendChild(tabBtn);
      if (!isInline) {
        const escBtn = document.createElement('button');
        escBtn.type = 'button';
        escBtn.className = 'ag-np-kbd';
        escBtn.setAttribute('data-np-action', 'dismiss');
        escBtn.textContent = 'Esc';
        escBtn.addEventListener('click', (e) => {
          e.stopPropagation?.();
          dismissNextPromptSuggestion(true, { explicitUserDismiss: true });
        });
        actEl.appendChild(escBtn);
      }
      ghost.appendChild(txtEl);
      ghost.appendChild(actEl);
      if (isInline) {
        mountTarget.appendChild?.(ghost);
      } else {
        const statusBar = composer.querySelector?.('.composer-status-bar');
        if (statusBar && statusBar.parentElement === composer && typeof composer.insertBefore === 'function') {
          composer.insertBefore(ghost, statusBar);
        } else {
          composer.appendChild?.(ghost);
        }
      }
      nextPromptState.ghostEl = ghost;
    }
    const textSpan = ghost.querySelector?.('.ag-np-ghost-text') || ghost.children?.[0];
    if (textSpan) textSpan.textContent = suggestionText;
    ghost.hidden = false;
    if (isInline && inlineHost) {
      inlineHost.setAttribute?.('data-ag-np-active', 'true');
      nextPromptState.inlineHostEl = inlineHost;
    } else {
      clearNextPromptInlineHostFlag();
    }
    nextPromptState.composerEl = composer;
    nextPromptState.suggestion = suggestionText;
  }

  function extractDomTurnsFromConversationView() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
    const root = document.querySelector?.('[data-testid="conversation-view"]') || document;
    const nodes = Array.from(root.querySelectorAll?.('[data-testid="user-message"], [data-testid="agent-response"]') || [])
      .filter(el => el && !el.closest?.('#ag-context-meter'));
    if (!nodes.length) return [];

    const readCleanText = (el, stripSelectors = []) => {
      if (!el) return '';
      try {
        if (typeof el.cloneNode === 'function') {
          const clone = el.cloneNode(true);
          if (stripSelectors.length && typeof clone.querySelectorAll === 'function') {
            clone.querySelectorAll(stripSelectors.join(',')).forEach(n => n.remove?.());
          }
          return String(clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        }
      } catch { }
      return String(el.innerText || el.textContent || '').trim();
    };

    const turns = [];
    for (const node of nodes.slice(-16)) {
      const tid = node.getAttribute?.('data-testid');
      if (tid === 'user-message') {
        const contentEl = node.querySelector?.('[data-testid="user-message-content"]')
          || node.querySelector?.('[data-testid="user-message-bubble"]')
          || node;
        const text = readCleanText(contentEl, ['style', 'script', 'noscript', 'svg', '.sr-only', '[data-testid="user-message-actions"]']);
        if (text) {
          turns.push({ role: 'user', sourceType: 'user', text, status: 'completed' });
        }
        continue;
      }
      if (tid === 'agent-response') {
        const srHeading = node.querySelector?.('h6.sr-only, h6');
        const headingText = String(srHeading?.textContent || '').trim();
        const isStreaming = /\b(?:working|generating|thinking|running)\b/i.test(headingText);
        const toolCard = node.querySelector?.('[data-testid="changed-files-card-header"]');
        const toolSummary = toolCard ? String(toolCard.innerText || toolCard.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const text = readCleanText(node, [
          'style',
          'script',
          'noscript',
          'svg',
          '.sr-only',
          '[data-testid="worked-for-collapsible"]',
          '[data-testid="tool-group-collapsible"]',
          '[data-testid="turn-cards-container"]',
          '[data-testid="cascade-system-message-toolbar"]',
          '[data-testid="step-plan"]',
          '.ag-cm-turn-footer'
        ]);
        if (isStreaming || text || toolSummary) {
          turns.push({
            role: 'assistant',
            sourceType: 'assistant',
            text,
            status: isStreaming ? 'streaming' : 'completed',
            toolSummary
          });
        }
      }
    }
    return turns.slice(-8);
  }

  function extractRecentTurnsFromActiveSession() {
    const timelineTurns = Array.isArray(state.timelineData?.turns) ? state.timelineData.turns : [];
    if (timelineTurns.length > 0) {
      return timelineTurns.slice(-8).map(tr => ({
        role: tr.role || (tr.isAssistant ? 'assistant' : 'user'),
        sourceType: tr.sourceType || (tr.isAssistant ? 'assistant' : 'user'),
        text: tr.text || tr.promptText || tr.responseText || '',
        status: tr.status || 'completed',
        toolSummary: tr.toolSummary || '',
        verificationEvidence: tr.verificationEvidence || ''
      }));
    }
    const domTurns = extractDomTurnsFromConversationView();
    if (domTurns.length > 0) return domTurns;
    const out = [];
    if (state.latest?.promptText) out.push({ role: 'user', sourceType: 'user', text: state.latest.promptText, status: 'completed' });
    if (state.latest?.responseText || state.latest?.lastText) {
      out.push({
        role: 'assistant',
        sourceType: 'assistant',
        text: state.latest.responseText || state.latest.lastText || '',
        status: state.latest?.isStreaming ? 'streaming' : (state.latest?.error ? 'error' : 'completed')
      });
    }
    return out;
  }

  function bindNextPromptComposerListeners() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onCompStart = (e) => {
      if (e.target?.closest?.('.surface-composer')) {
        nextPromptState.isComposing = true;
        dismissNextPromptSuggestion(true);
      }
    };
    const onCompEnd = (e) => {
      const comp = e.target?.closest?.('.surface-composer');
      if (comp) {
        nextPromptState.isComposing = false;
        const editor = resolveComposerEditorEl(comp);
        if (editor && readEditorDraftText(editor).trim() === '') {
          restoreCachedNextPromptIfEmpty(comp);
        }
      }
    };
    const onBeforeInput = (e) => {
      if (!nextPromptState.suggestion) return;
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp.closest?.('#ag-context-meter')) return;
      if (e.data) {
        dismissNextPromptSuggestion(true);
      }
    };
    const onInput = (e) => {
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp.closest?.('#ag-context-meter')) return;
      const editor = resolveComposerEditorEl(comp);
      if (!editor) return;
      if (readEditorDraftText(editor).trim() !== '') {
        dismissNextPromptSuggestion(true);
      } else {
        restoreCachedNextPromptIfEmpty(comp);
      }
    };
    const onKeyDown = (e) => {
      if (!nextPromptState.suggestion) return;
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp !== nextPromptState.composerEl) return;
      if (e.key === 'Escape') {
        e.preventDefault?.();
        dismissNextPromptSuggestion(true, { explicitUserDismiss: true });
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !nextPromptState.isComposing) {
        const editor = resolveComposerEditorEl(comp);
        if (editor && readEditorDraftText(editor).trim() === '') {
          e.preventDefault?.();
          acceptNextPromptIntoComposer(comp);
        }
      }
    };
    document.addEventListener('compositionstart', onCompStart, true);
    document.addEventListener('compositionend', onCompEnd, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    activeDisposers.add(() => {
      try {
        document.removeEventListener('compositionstart', onCompStart, true);
        document.removeEventListener('compositionend', onCompEnd, true);
        document.removeEventListener('beforeinput', onBeforeInput, true);
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('keydown', onKeyDown, true);
      } catch { }
    });
  }

  async function maybeRequestNextPromptPrediction(opts = {}) {
    if (state.disposed) return { skipped: true, reason: 'disposed' };
    if (!nextPromptEnabled && opts.force !== true) return { skipped: true, reason: 'disabled' };
    const routeId = opts.routeId || state.route || null;
    if (!routeId) return { skipped: true, reason: 'no_route' };
    if (nextPromptState.routeId && nextPromptState.routeId !== routeId) {
      dismissNextPromptSuggestion(true, { clearCache: true });
    }
    const composer = opts.composer || findActiveVisibleComposer(routeId);
    if (!composer) return { skipped: true, reason: 'no_composer' };
    if (nextPromptState.isComposing) return { skipped: true, reason: 'ime_composing' };
    const editor = resolveComposerEditorEl(composer);
    if (!editor || editor.disabled || editor.getAttribute?.('aria-disabled') === 'true') {
      return { skipped: true, reason: 'editor_disabled' };
    }
    if (readEditorDraftText(editor).trim() !== '') {
      dismissNextPromptSuggestion(true);
      return { skipped: true, reason: 'draft_non_empty' };
    }
    if (hasPendingHostApprovalOrQueue(composer)) {
      return { skipped: true, reason: 'busy_approval_or_queue' };
    }

    const turns = Array.isArray(opts.turns) ? opts.turns : extractRecentTurnsFromActiveSession();
    if (!turns.length) return { skipped: true, reason: 'no_turns' };
    const lastTurn = turns[turns.length - 1];
    if (lastTurn.role !== 'assistant' || lastTurn.status === 'streaming' || lastTurn.status === 'error') {
      return { skipped: true, reason: 'turn_not_ready' };
    }

    const lastTailKey = `${turns.length}:${String(lastTurn.text || '').slice(-80)}`;
    const turnKey = opts.turnKey || `${routeId}::${lastTailKey}`;
    if (nextPromptState.inFlight && nextPromptState.turnKey === turnKey && opts.force !== true) {
      return { skipped: true, reason: 'in_flight' };
    }
    if (nextPromptState.attemptedTurnKeys.has(turnKey) && opts.force !== true) {
      if (
        !nextPromptState.suggestion
        && nextPromptState.cachedTurnKey === turnKey
        && nextPromptState.cachedSuggestion
        && !nextPromptState.dismissedTurnKeys.has(turnKey)
      ) {
        renderNextPromptGhost(composer, nextPromptState.cachedSuggestion);
        return { ok: true, restored: true, abstained: false, suggestion: nextPromptState.cachedSuggestion, model: nextPromptState.model };
      }
      return { skipped: true, reason: 'already_predicted_for_turn' };
    }
    nextPromptState.attemptedTurnKeys.add(turnKey);

    const reqSeq = ++nextPromptState.seq;
    nextPromptState.inFlight = true;
    nextPromptState.routeId = routeId;
    nextPromptState.turnKey = turnKey;

    try {
      const payload = {
        cascadeId: routeId,
        turnId: turnKey,
        turns,
        ...(opts.taskMarkdown !== undefined ? { taskMarkdown: opts.taskMarkdown } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        allowWhenDisabled: opts.force === true
      };

      let res = null;
      if (typeof window?.contextMeterAPI?.predictNextPrompt === 'function') {
        res = await window.contextMeterAPI.predictNextPrompt(payload);
      } else if (hasLiveHttpBridge()) {
        res = await postLiveHttpEndpoint('/predict-next-prompt', payload);
      }

      // 异步到达严格核对：会话切换 / 新轮开始 / 输入框已填草稿，必须丢弃旧建议
      if (state.disposed || reqSeq !== nextPromptState.seq) {
        return { skipped: true, stale: true, reason: 'superseded_or_disposed' };
      }
      if ((state.route || routeId) !== routeId) {
        dismissNextPromptSuggestion(false);
        return { skipped: true, stale: true, reason: 'route_changed' };
      }
      const currentComp = findActiveVisibleComposer(routeId) || composer;
      const currentEditor = resolveComposerEditorEl(currentComp);
      if (!currentEditor || readEditorDraftText(currentEditor).trim() !== '' || nextPromptState.isComposing) {
        dismissNextPromptSuggestion(false);
        return { skipped: true, stale: true, reason: 'draft_changed_while_inflight' };
      }

      nextPromptState.inFlight = false;
      const sug = String(res?.suggestion || '').trim();
      if (!res?.ok || !sug) {
        dismissNextPromptSuggestion(false);
        return { ok: Boolean(res?.ok), abstained: true, suggestion: '' };
      }

      nextPromptState.model = res.model || null;
      nextPromptState.cachedRouteId = routeId;
      nextPromptState.cachedTurnKey = turnKey;
      nextPromptState.cachedSuggestion = sug;
      nextPromptState.dismissedTurnKeys.delete(turnKey);
      renderNextPromptGhost(currentComp, sug);
      return { ok: true, abstained: false, suggestion: sug, model: nextPromptState.model };
    } catch (e) {
      nextPromptState.inFlight = false;
      return { ok: false, abstained: true, suggestion: '', error: e?.message || 'predict_failed' };
    }
  }

  function disposeNextPrompt() {
    dismissNextPromptSuggestion(true, { clearCache: true });
    nextPromptState.attemptedTurnKeys.clear();
    nextPromptState.dismissedTurnKeys.clear();
    try { document.getElementById(NEXT_PROMPT_STYLE_ID)?.remove?.(); } catch { }
  }
