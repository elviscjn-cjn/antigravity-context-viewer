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
    isComposing: false,
    attemptedTurnKeys: new Set()
  };

  function ensureNextPromptStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(NEXT_PROMPT_STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = NEXT_PROMPT_STYLE_ID;
      st.textContent = `
        .ag-np-ghost {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin: 4px 10px 2px;
          padding: 4px 10px;
          border-radius: 7px;
          border: 1px dashed rgba(148, 163, 184, 0.32);
          background: rgba(148, 163, 184, 0.08);
          color: rgba(148, 163, 184, 0.92);
          font-size: 11.5px;
          line-height: 1.4;
          pointer-events: auto;
          user-select: none;
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
          font-style: italic;
        }
        .ag-np-ghost-actions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
          font-size: 10.5px;
        }
        .ag-np-kbd {
          padding: 1px 5px;
          border-radius: 4px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          background: rgba(148, 163, 184, 0.12);
          cursor: pointer;
          font-family: inherit;
          color: inherit;
        }
        .ag-np-kbd:hover {
          background: rgba(139, 92, 246, 0.2);
          border-color: rgba(139, 92, 246, 0.5);
        }
      `;
      document.head.appendChild(st);
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
        const stopBtn = composer?.querySelector?.('button[data-testid="stop-button"], button[aria-label^="Stop"]')
          || document.querySelector('.surface-composer button[data-testid="stop-button"]');
        if (stopBtn) return true;
        const approvalBtn = document.querySelector('[data-testid*="approval"], [data-testid*="permission-prompt"], [role="alertdialog"]');
        if (approvalBtn && !approvalBtn.closest?.('#ag-context-meter')) return true;
      }
      if (state.latest?.error || state.awaitingAutoRecovery) return true;
    } catch { }
    return false;
  }

  function dismissNextPromptSuggestion(invalidateInFlight = false) {
    if (invalidateInFlight) {
      nextPromptState.seq++;
      nextPromptState.inFlight = false;
    }
    nextPromptState.suggestion = '';
    if (nextPromptState.ghostEl) {
      nextPromptState.ghostEl.hidden = true;
      nextPromptState.ghostEl.textContent = '';
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
    try {
      editor.focus?.();
      if (typeof editor.value === 'string') {
        editor.value = text;
      } else if (typeof document?.execCommand === 'function') {
        const ok = document.execCommand('insertText', false, text);
        if (!ok) editor.textContent = text;
      } else {
        editor.textContent = text;
      }
      try {
        if (typeof editor.dispatchEvent === 'function') {
          editor.dispatchEvent(typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
            : { type: 'input', target: editor });
        }
      } catch { }
      dismissNextPromptSuggestion(true);
      return true;
    } catch {
      return false;
    }
  }

  function renderNextPromptGhost(composer, suggestionText) {
    if (!composer || !suggestionText) {
      dismissNextPromptSuggestion(false);
      return;
    }
    ensureNextPromptStyles();
    let ghost = nextPromptState.ghostEl;
    if (!ghost || ghost.parentElement !== composer) {
      if (ghost) try { ghost.remove?.(); } catch { }
      ghost = document.createElement('div');
      ghost.className = 'ag-np-ghost';
      ghost.setAttribute('data-ag-next-prompt-ghost', 'true');
      const txtEl = document.createElement('span');
      txtEl.className = 'ag-np-ghost-text';
      const actEl = document.createElement('span');
      actEl.className = 'ag-np-ghost-actions';
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'ag-np-kbd';
      tabBtn.setAttribute('data-np-action', 'accept');
      tabBtn.textContent = t('nextPrompt.tabFill');
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        acceptNextPromptIntoComposer(composer);
      });
      const escBtn = document.createElement('button');
      escBtn.type = 'button';
      escBtn.className = 'ag-np-kbd';
      escBtn.setAttribute('data-np-action', 'dismiss');
      escBtn.textContent = 'Esc';
      escBtn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        dismissNextPromptSuggestion(true);
      });
      actEl.appendChild(tabBtn);
      actEl.appendChild(escBtn);
      ghost.appendChild(txtEl);
      ghost.appendChild(actEl);
      composer.appendChild?.(ghost);
      nextPromptState.ghostEl = ghost;
    }
    const textSpan = ghost.querySelector?.('.ag-np-ghost-text') || ghost.children?.[0];
    if (textSpan) textSpan.textContent = suggestionText;
    ghost.hidden = false;
    nextPromptState.composerEl = composer;
    nextPromptState.suggestion = suggestionText;
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
      if (e.target?.closest?.('.surface-composer')) {
        nextPromptState.isComposing = false;
      }
    };
    const onInput = (e) => {
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp.closest?.('#ag-context-meter')) return;
      const editor = resolveComposerEditorEl(comp);
      if (editor && readEditorDraftText(editor).trim() !== '') {
        dismissNextPromptSuggestion(true);
      }
    };
    const onKeyDown = (e) => {
      if (!nextPromptState.suggestion) return;
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp !== nextPromptState.composerEl) return;
      if (e.key === 'Escape') {
        e.preventDefault?.();
        dismissNextPromptSuggestion(true);
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
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    activeDisposers.add(() => {
      try {
        document.removeEventListener('compositionstart', onCompStart, true);
        document.removeEventListener('compositionend', onCompEnd, true);
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

    const turnKey = opts.turnKey || `${routeId}::${state.latest?.completedAtMs || state.latest?.turnId || lastTurn.text?.slice(-60) || turns.length}`;
    if (nextPromptState.attemptedTurnKeys.has(turnKey) && opts.force !== true) {
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
        const httpRes = await fetch(resolveLiveHttpUrl('/predict-next-prompt'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        res = httpRes.ok ? await httpRes.json() : { ok: false, error: `HTTP ${httpRes.status}` };
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
      renderNextPromptGhost(currentComp, sug);
      return { ok: true, abstained: false, suggestion: sug, model: nextPromptState.model };
    } catch (e) {
      nextPromptState.inFlight = false;
      return { ok: false, abstained: true, suggestion: '', error: e?.message || 'predict_failed' };
    }
  }

  function disposeNextPrompt() {
    dismissNextPromptSuggestion(true);
    nextPromptState.attemptedTurnKeys.clear();
    try { document.getElementById(NEXT_PROMPT_STYLE_ID)?.remove?.(); } catch { }
  }
