  // =========================================================================
  // 下一句预测控制器（任务 4 重做 · 输入框内浅色内联预览、多轮可复用、真编辑器 Tab 填入与保护门禁）
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
    editorEl: null,
    ghostEl: null,
    ghostTextEl: null,
    anchorHostEl: null,
    isComposing: false,
    attemptedTurnKeys: new Set(),
    lastDiagnostics: null,
    metrics: {
      shownCount: 0,
      acceptedCount: 0,
      sentCount: 0,
      lastAcceptedText: ''
    }
  };

  function ensureNextPromptStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(NEXT_PROMPT_STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = NEXT_PROMPT_STYLE_ID;
      const alignMod = typeof window !== 'undefined' ? window.AGNextPromptAlignment : null;
      st.textContent = (alignMod && typeof alignMod.ALIGNED_GHOST_CSS === 'string' && alignMod.ALIGNED_GHOST_CSS.trim())
        ? alignMod.ALIGNED_GHOST_CSS
        : `
        .ag-np-inline-host {
          position: relative !important;
        }
        .ag-np-inline-host.ag-np-has-suggestion [class*="placeholder" i]:not(.ag-np-ghost):not(.ag-np-ghost-text),
        .ag-np-inline-host.ag-np-has-suggestion [data-placeholder]:not(.ag-np-ghost)::before,
        .ag-np-inline-host.ag-np-has-suggestion [data-lexical-editor="true"]::before {
          opacity: 0 !important;
          color: transparent !important;
        }
        .ag-np-ghost.ag-np-inline-ghost {
          position: absolute;
          top: 0;
          left: 0;
          z-index: 4;
          display: block;
          margin: 0;
          padding: 0;
          border: none;
          background: transparent;
          color: var(--ag-np-ghost-color, #9A9A9A);
          pointer-events: none;
          user-select: none;
          overflow: hidden;
          white-space: pre-wrap;
          word-break: break-word;
          box-sizing: border-box;
        }
        [data-theme="light"] .ag-np-ghost.ag-np-inline-ghost,
        .light .ag-np-ghost.ag-np-inline-ghost {
          --ag-np-ghost-color: #767676;
        }
        .ag-np-ghost[hidden] {
          display: none !important;
        }
        .ag-np-ghost-text {
          display: inline;
          font: inherit;
          line-height: inherit;
          letter-spacing: inherit;
          color: inherit;
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

  function isHostNativeCompletionOpen(editor) {
    try {
      if (!editor) return false;
      if (editor.getAttribute?.('aria-expanded') === 'true') {
        const ctrlId = editor.getAttribute?.('aria-controls');
        if (!ctrlId) return true;
        const menu = typeof document?.getElementById === 'function' ? document.getElementById(ctrlId) : null;
        if (menu && !menu.hidden) return true;
      }
      if (typeof document?.querySelector === 'function') {
        const typeahead = document.querySelector('[role="listbox"] [role="option"][aria-selected="true"], [role="option"][id^="typeahead-item-"]');
        if (typeahead && !typeahead.closest?.('#ag-context-meter')) return true;
      }
    } catch { }
    return false;
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

  function toggleHostNativePlaceholderNodes(anchorParent, editor, hide) {
    try {
      if (!anchorParent || typeof anchorParent.querySelectorAll !== 'function') return;
      if (!hide) {
        const hiddenNodes = Array.from(anchorParent.querySelectorAll('[data-ag-np-hidden-placeholder="true"]') || []);
        for (const n of hiddenNodes) {
          const origOpacity = n.getAttribute?.('data-ag-np-orig-opacity') ?? '';
          const origVis = n.getAttribute?.('data-ag-np-orig-vis') ?? '';
          if (n.style) {
            n.style.opacity = origOpacity;
            n.style.visibility = origVis;
          }
          n.removeAttribute?.('data-ag-np-hidden-placeholder');
          n.removeAttribute?.('data-ag-np-orig-opacity');
          n.removeAttribute?.('data-ag-np-orig-vis');
        }
        return;
      }
      const candidates = Array.from(anchorParent.querySelectorAll('div, span, p') || []);
      for (const n of candidates) {
        if (!n || n === editor || n.contains?.(editor) || editor?.contains?.(n)) continue;
        if (n.classList?.contains?.('ag-np-ghost') || n.closest?.('.ag-np-ghost')) continue;
        const cls = String(n.className || '');
        const txt = String(n.textContent || '').trim();
        const looksPlaceholder = /placeholder/i.test(cls)
          || (/pointer-events-none/i.test(cls) && txt.length > 0 && txt.length <= 120)
          || /Ask anything|@ to mention|\/ for actions|输入消息|輸入訊息/i.test(txt);
        if (!looksPlaceholder) continue;
        if (n.getAttribute?.('data-ag-np-hidden-placeholder') !== 'true') {
          n.setAttribute?.('data-ag-np-orig-opacity', n.style?.opacity || '');
          n.setAttribute?.('data-ag-np-orig-vis', n.style?.visibility || '');
          n.setAttribute?.('data-ag-np-hidden-placeholder', 'true');
        }
        if (n.style) {
          n.style.opacity = '0';
          n.style.visibility = 'hidden';
        }
      }
    } catch { }
  }

  function dismissNextPromptSuggestion(invalidateInFlight = false) {
    if (invalidateInFlight) {
      nextPromptState.seq++;
      nextPromptState.inFlight = false;
    }
    nextPromptState.suggestion = '';
    if (nextPromptState.ghostTextEl) {
      // 严禁清空 ghostEl.textContent 导致子节点销毁，只清空专用文本子节点确保连续多轮复用
      nextPromptState.ghostTextEl.textContent = '';
    }
    if (nextPromptState.ghostEl) {
      nextPromptState.ghostEl.hidden = true;
    }
    if (nextPromptState.anchorHostEl) {
      nextPromptState.anchorHostEl.classList?.remove?.('ag-np-has-suggestion');
      toggleHostNativePlaceholderNodes(nextPromptState.anchorHostEl, nextPromptState.editorEl, false);
    }
  }

  function syncInlineGhostGeometry(ghost, editor, anchorParent) {
    try {
      if (!ghost || !editor) return;
      const alignMod = typeof window !== 'undefined' ? window.AGNextPromptAlignment : null;
      if (alignMod && typeof alignMod.syncAlignedInlineGhostGeometry === 'function') {
        alignMod.syncAlignedInlineGhostGeometry(ghost, editor, anchorParent);
        if (typeof alignMod.createNextPromptColorDebugController === 'function') {
          let debugColor = null;
          try { debugColor = typeof localStorage !== 'undefined' ? localStorage.getItem('ag_np_debug_color') : null; } catch { }
          if (debugColor) {
            const dbgCtrl = alignMod.createNextPromptColorDebugController({ initialColor: debugColor, ghostEl: ghost });
            dbgCtrl?.setColor?.(debugColor);
          }
        }
        return;
      }
      const cs = typeof window?.getComputedStyle === 'function' ? window.getComputedStyle(editor) : null;
      if (cs) {
        if (cs.fontSize) ghost.style.fontSize = cs.fontSize;
        if (cs.lineHeight) ghost.style.lineHeight = cs.lineHeight;
        if (cs.fontFamily) ghost.style.fontFamily = cs.fontFamily;
        if (cs.letterSpacing) ghost.style.letterSpacing = cs.letterSpacing;
        ghost.style.paddingTop = cs.paddingTop || '0px';
        ghost.style.paddingRight = cs.paddingRight || '0px';
        ghost.style.paddingBottom = cs.paddingBottom || '0px';
        ghost.style.paddingLeft = cs.paddingLeft || '0px';
      }
      if (
        anchorParent &&
        typeof anchorParent.getBoundingClientRect === 'function' &&
        typeof editor.getBoundingClientRect === 'function'
      ) {
        const pr = anchorParent.getBoundingClientRect();
        const er = editor.getBoundingClientRect();
        if (pr.width > 0 && er.width > 0) {
          ghost.style.top = `${Math.max(0, er.top - pr.top)}px`;
          ghost.style.left = `${Math.max(0, er.left - pr.left)}px`;
          ghost.style.width = `${er.width}px`;
          ghost.style.height = `${er.height}px`;
        }
      }
    } catch { }
  }

  function placeCaretAtEnd(editor) {
    try {
      if (typeof editor.setSelectionRange === 'function' && typeof editor.value === 'string') {
        const len = editor.value.length;
        editor.setSelectionRange(len, len);
        return;
      }
      if (typeof document?.createRange === 'function' && typeof window?.getSelection === 'function') {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges?.();
        sel?.addRange?.(range);
      }
    } catch { }
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
      editor.focus?.({ preventScroll: true });
      if (typeof editor.value === 'string') {
        const proto = Object.getPrototypeOf(editor);
        const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (desc && typeof desc.set === 'function') desc.set.call(editor, text);
        else editor.value = text;
      } else {
        let applied = false;
        if (typeof document?.execCommand === 'function') {
          try {
            applied = Boolean(document.execCommand('insertText', false, text));
          } catch { applied = false; }
        }
        if (!applied || readEditorDraftText(editor).trim() !== text) {
          try {
            if (typeof editor.dispatchEvent === 'function') {
              let pasteEv = null;
              if (typeof ClipboardEvent === 'function' && typeof DataTransfer === 'function') {
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                pasteEv = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
              }
              if (pasteEv) editor.dispatchEvent(pasteEv);
            }
          } catch { }
        }
        if (readEditorDraftText(editor).trim() !== text) {
          try {
            if (typeof InputEvent === 'function' && typeof editor.dispatchEvent === 'function') {
              editor.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data: text,
                inputType: 'insertText'
              }));
            }
          } catch { }
        }
        if (readEditorDraftText(editor).trim() !== text) {
          editor.textContent = text;
        }
      }
      try {
        if (typeof editor.dispatchEvent === 'function') {
          editor.dispatchEvent(typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
            : { type: 'input', target: editor });
        }
      } catch { }
      const readback = readEditorDraftText(editor).trim();
      const confirmed = readback === text || readback.includes(text);
      if (confirmed) {
        placeCaretAtEnd(editor);
        nextPromptState.metrics.acceptedCount += 1;
        nextPromptState.metrics.lastAcceptedText = text;
        dismissNextPromptSuggestion(true);
        return true;
      }
      dismissNextPromptSuggestion(true);
      return false;
    } catch {
      return false;
    }
  }

  function renderNextPromptGhost(composer, suggestionText) {
    if (!composer || !suggestionText) {
      dismissNextPromptSuggestion(false);
      return;
    }
    const editor = resolveComposerEditorEl(composer);
    if (!editor || readEditorDraftText(editor).trim() !== '') {
      dismissNextPromptSuggestion(false);
      return;
    }
    ensureNextPromptStyles();
    const anchorParent = editor.parentElement || composer;
    anchorParent.classList?.add?.('ag-np-inline-host');

    let ghost = nextPromptState.ghostEl;
    let textSpan = nextPromptState.ghostTextEl;
    if (!ghost || ghost.parentElement !== anchorParent || !textSpan || textSpan.parentElement !== ghost) {
      if (ghost) try { ghost.remove?.(); } catch { }
      ghost = document.createElement('div');
      ghost.className = 'ag-np-ghost ag-np-inline-ghost';
      ghost.setAttribute('data-ag-next-prompt-ghost', 'true');
      ghost.setAttribute('aria-hidden', 'true');
      textSpan = document.createElement('span');
      textSpan.className = 'ag-np-ghost-text';
      ghost.appendChild(textSpan);
      anchorParent.appendChild?.(ghost);
      nextPromptState.ghostEl = ghost;
      nextPromptState.ghostTextEl = textSpan;
    }
    textSpan.textContent = suggestionText;
    syncInlineGhostGeometry(ghost, editor, anchorParent);
    ghost.hidden = false;
    if (nextPromptState.anchorHostEl && nextPromptState.anchorHostEl !== anchorParent) {
      nextPromptState.anchorHostEl.classList?.remove?.('ag-np-has-suggestion');
      toggleHostNativePlaceholderNodes(nextPromptState.anchorHostEl, nextPromptState.editorEl, false);
    }
    anchorParent.classList?.add?.('ag-np-has-suggestion');
    toggleHostNativePlaceholderNodes(anchorParent, editor, true);
    nextPromptState.anchorHostEl = anchorParent;
    nextPromptState.composerEl = composer;
    nextPromptState.editorEl = editor;
    nextPromptState.suggestion = suggestionText;
    nextPromptState.metrics.shownCount += 1;
  }

  function extractTurnsFromVisibleConversationDom() {
    try {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return [];
      const convRoot = document.querySelector('[data-testid="conversation-view"]') || document.body;
      if (!convRoot || typeof convRoot.querySelectorAll !== 'function') return [];
      const nodes = Array.from(convRoot.querySelectorAll('[data-bubble-side], [data-message-author-role], [data-turn-index]') || []);
      const out = [];
      for (const n of nodes) {
        if (!n || n.closest?.('#ag-context-meter, .ag-cm-turn-footer, .surface-composer')) continue;
        const side = String(n.getAttribute?.('data-bubble-side') || n.getAttribute?.('data-message-author-role') || '').toLowerCase();
        const role = (side === 'right' || side === 'user') ? 'user' : ((side === 'left' || side === 'assistant' || side === 'model') ? 'assistant' : '');
        if (!role) continue;
        const text = String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
        if (!text || text.length < 2) continue;
        if (out.length > 0 && out[out.length - 1].role === role) {
          out[out.length - 1].text = `${out[out.length - 1].text}\n${text}`.slice(-1500);
        } else {
          out.push({ role, sourceType: role, text, status: 'completed' });
        }
      }
      if (out.some(t => t.role === 'assistant')) return out.slice(-6);
      // 兜底：面板关闭且无 data-bubble-side 时，沿宿主系统工具栏回溯最新真实回复与前方用户消息
      const toolbars = Array.from(convRoot.querySelectorAll('[data-testid="cascade-system-message-toolbar"]') || [])
        .filter(tb => tb && !tb.closest?.('[data-testid="side-question-tab-conversation"], #ag-context-meter'));
      if (toolbars.length > 0) {
        const lastTb = toolbars[toolbars.length - 1];
        const msgBlock = lastTb.closest?.('[data-message-id], [data-step-index], article, section') || lastTb.parentElement?.parentElement || lastTb.parentElement;
        const extractCleanText = (node) => {
          if (!node) return '';
          let raw = String(node.textContent || '');
          const footerTxt = String(node.querySelector?.('.ag-cm-turn-footer')?.textContent || '');
          if (footerTxt) raw = raw.replace(footerTxt, '');
          const tbTxt = String(node.querySelector?.('[data-testid="cascade-system-message-toolbar"]')?.textContent || '');
          if (tbTxt) raw = raw.replace(tbTxt, '');
          return raw.replace(/\s+/g, ' ').trim().slice(0, 1500);
        };
        const aTxt = extractCleanText(msgBlock);
        let uTxt = '';
        let prev = msgBlock?.previousElementSibling || null;
        for (let step = 0; step < 6 && prev && !uTxt; step++) {
          if (!prev.querySelector?.('[data-testid="cascade-system-message-toolbar"]')) {
            const candidate = String(prev.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 800);
            if (candidate && candidate.length >= 1 && !/^(?:just now|\d+[smhd] ago)$/i.test(candidate)) {
              uTxt = candidate;
            }
          }
          prev = prev.previousElementSibling || null;
        }
        const fallbackOut = [];
        if (uTxt) fallbackOut.push({ role: 'user', sourceType: 'user', text: uTxt, status: 'completed' });
        if (aTxt) fallbackOut.push({ role: 'assistant', sourceType: 'assistant', text: aTxt, status: 'completed' });
        if (fallbackOut.some(t => t.role === 'assistant')) return fallbackOut;
      }
      return [];
    } catch {
      return [];
    }
  }

  function extractRecentTurnsFromActiveSession() {
    // 0. 优先读取后端 timeline 返回的最新精简对话轮次（不依赖右侧面板打开）
    const recentTlTurns = Array.isArray(state.sessionTimeline?.recentConversationTurns)
      ? state.sessionTimeline.recentConversationTurns
      : [];
    if (recentTlTurns.length > 0 && recentTlTurns.some(tr => tr && tr.role === 'assistant' && tr.text)) {
      return recentTlTurns.slice(-8);
    }
    // 1. 其次读取结构化 rawSteps（完整包含用户与助手正文及工具摘要）
    const rawSteps = Array.isArray(state.sessionTimeline?.rawSteps) ? state.sessionTimeline.rawSteps : [];
    if (rawSteps.length > 0) {
      const fromSteps = [];
      let pendingTools = [];
      for (const st of rawSteps) {
        if (!st || typeof st !== 'object') continue;
        const uTxt = typeof st.userInput?.userResponse === 'string' ? st.userInput.userResponse.trim() : '';
        if (uTxt) {
          pendingTools = [];
          fromSteps.push({ role: 'user', sourceType: 'user', text: uTxt, status: 'completed' });
          continue;
        }
        if (st.type === 'TOOL_RESULT' && typeof st.content === 'string') {
          pendingTools.push(st.content.slice(0, 120));
          continue;
        }
        const aTxt = typeof st.plannerResponse?.response === 'string' ? st.plannerResponse.response.trim() : '';
        if (aTxt) {
          const stStatus = st.status === 'RUNNING' ? 'streaming' : (st.error ? 'error' : 'completed');
          const toolSummary = pendingTools.slice(-3).join(' | ').slice(0, 320);
          pendingTools = [];
          if (fromSteps.length > 0 && fromSteps[fromSteps.length - 1].role === 'assistant') {
            fromSteps[fromSteps.length - 1].text = `${fromSteps[fromSteps.length - 1].text}\n${aTxt}`.trim();
            fromSteps[fromSteps.length - 1].status = stStatus;
            if (toolSummary) fromSteps[fromSteps.length - 1].toolSummary = toolSummary;
          } else {
            fromSteps.push({
              role: 'assistant',
              sourceType: 'assistant',
              text: aTxt,
              status: stStatus,
              ...(toolSummary ? { toolSummary } : {})
            });
          }
        }
      }
      if (fromSteps.length > 0) return fromSteps.slice(-8);
    }
    // 2. 兼容已带明确 role/text 的 turns 列表（含测试夹具与历史 timelineData）
    const timelineTurns = Array.isArray(state.sessionTimeline?.turns) && state.sessionTimeline.turns.length > 0
      ? state.sessionTimeline.turns
      : (Array.isArray(state.timelineData?.turns) ? state.timelineData.turns : []);
    if (timelineTurns.length > 0) {
      const mapped = timelineTurns.slice(-8).map(tr => ({
        role: tr.role || (tr.isAssistant ? 'assistant' : 'user'),
        sourceType: tr.sourceType || (tr.isAssistant ? 'assistant' : 'user'),
        text: tr.text || tr.promptText || tr.responseText || tr.summary || '',
        status: tr.status || 'completed',
        toolSummary: tr.toolSummary || '',
        verificationEvidence: tr.verificationEvidence || ''
      })).filter(tr => tr.text || tr.toolSummary || tr.verificationEvidence);
      if (mapped.some(tr => tr.role === 'assistant')) return mapped;
    }
    // 3. 回退到当前可见宿主聊天 DOM 与 state.latest
    const domTurns = extractTurnsFromVisibleConversationDom();
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
    const onFocusOut = (e) => {
      if (!nextPromptState.suggestion || !nextPromptState.composerEl) return;
      const nextTarget = e.relatedTarget;
      if (nextTarget && nextPromptState.composerEl.contains?.(nextTarget)) return;
      if (nextPromptState.ghostEl) nextPromptState.ghostEl.hidden = true;
      if (nextPromptState.anchorHostEl) {
        nextPromptState.anchorHostEl.classList?.remove?.('ag-np-has-suggestion');
        toggleHostNativePlaceholderNodes(nextPromptState.anchorHostEl, nextPromptState.editorEl, false);
      }
    };
    const onFocusIn = (e) => {
      if (!nextPromptState.suggestion || !nextPromptState.composerEl) return;
      const comp = e.target?.closest?.('.surface-composer');
      if (comp && comp === nextPromptState.composerEl) {
        const editor = resolveComposerEditorEl(comp);
        if (editor && readEditorDraftText(editor).trim() === '' && nextPromptState.ghostEl) {
          syncInlineGhostGeometry(nextPromptState.ghostEl, editor, editor.parentElement || comp);
          nextPromptState.ghostEl.hidden = false;
          if (nextPromptState.anchorHostEl) {
            nextPromptState.anchorHostEl.classList?.add?.('ag-np-has-suggestion');
            toggleHostNativePlaceholderNodes(nextPromptState.anchorHostEl, editor, true);
          }
        }
      } else if (nextPromptState.ghostEl) {
        nextPromptState.ghostEl.hidden = true;
        if (nextPromptState.anchorHostEl) {
          nextPromptState.anchorHostEl.classList?.remove?.('ag-np-has-suggestion');
          toggleHostNativePlaceholderNodes(nextPromptState.anchorHostEl, nextPromptState.editorEl, false);
        }
      }
    };
    const onKeyDown = (e) => {
      if (!nextPromptState.suggestion) return;
      const comp = e.target?.closest?.('.surface-composer');
      if (!comp || comp !== nextPromptState.composerEl) return;
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        dismissNextPromptSuggestion(true);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !nextPromptState.isComposing) {
        const editor = resolveComposerEditorEl(comp);
        if (editor && readEditorDraftText(editor).trim() === '' && !isHostNativeCompletionOpen(editor)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          e.stopImmediatePropagation?.();
          acceptNextPromptIntoComposer(comp);
        }
      }
    };
    const onClickSend = (e) => {
      const sendBtn = e.target?.closest?.('button[data-testid="send-button"]');
      if (sendBtn && nextPromptState.metrics.lastAcceptedText) {
        nextPromptState.metrics.sentCount += 1;
        nextPromptState.metrics.lastAcceptedText = '';
      }
    };
    document.addEventListener('compositionstart', onCompStart, true);
    document.addEventListener('compositionend', onCompEnd, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClickSend, true);
    activeDisposers.add(() => {
      try {
        document.removeEventListener('compositionstart', onCompStart, true);
        document.removeEventListener('compositionend', onCompEnd, true);
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('focusout', onFocusOut, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('click', onClickSend, true);
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
    const hasExplicitTurns = Array.isArray(opts.turns);
    const hasCompletedSessionActivity = Boolean(
      !hasExplicitTurns &&
      (state.count > 0 || (Array.isArray(state.sessionCalls) && state.sessionCalls.some(c => c && c.status === 'final')))
      && state.sessionCalls?.at?.(-1)?.status !== 'streaming'
    );
    if (!turns.length && !hasCompletedSessionActivity) {
      nextPromptState.lastDiagnostics = { at: Date.now(), routeId, stage: 'skipped', reason: 'no_turns' };
      return { skipped: true, reason: 'no_turns' };
    }
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      if (lastTurn.role !== 'assistant' || lastTurn.status === 'streaming' || lastTurn.status === 'error') {
        nextPromptState.lastDiagnostics = { at: Date.now(), routeId, stage: 'skipped', reason: 'turn_not_ready' };
        return { skipped: true, reason: 'turn_not_ready' };
      }
    }

    const lastCallId = state.sessionCalls?.at?.(-1)?.callId || '';
    const lastTurnTail = turns.length > 0 ? String(turns[turns.length - 1]?.text || '').slice(-60) : '';
    const turnKey = opts.turnKey || `${routeId}::${state.latest?.completedAtMs || state.latest?.turnId || lastCallId || lastTurnTail || state.count || turns.length}`;
    if (nextPromptState.attemptedTurnKeys.has(turnKey) && opts.force !== true) {
      return { skipped: true, reason: 'already_predicted_for_turn' };
    }
    nextPromptState.attemptedTurnKeys.add(turnKey);

    const reqSeq = ++nextPromptState.seq;
    const reqStartedAt = Date.now();
    nextPromptState.inFlight = true;
    nextPromptState.routeId = routeId;
    nextPromptState.turnKey = turnKey;
    nextPromptState.lastDiagnostics = { at: reqStartedAt, routeId, turnKey, stage: 'requested', turnsCount: turns.length };

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

      // 异步到达严格核对：会话切换 / 新轮开始 / 输入框已填草稿 / 开关关闭，必须丢弃旧建议
      if (state.disposed || reqSeq !== nextPromptState.seq || (!nextPromptEnabled && opts.force !== true)) {
        return { skipped: true, stale: true, reason: 'superseded_or_disposed' };
      }
      if ((state.route || routeId) !== routeId) {
        dismissNextPromptSuggestion(false);
        return { skipped: true, stale: true, reason: 'route_changed' };
      }
      const currentComp = findActiveVisibleComposer(routeId) || composer;
      const currentEditor = resolveComposerEditorEl(currentComp);
      if (!currentEditor || readEditorDraftText(currentEditor).trim() !== '' || nextPromptState.isComposing || hasPendingHostApprovalOrQueue(currentComp)) {
        dismissNextPromptSuggestion(false);
        return { skipped: true, stale: true, reason: 'draft_changed_while_inflight' };
      }

      nextPromptState.inFlight = false;
      const sug = String(res?.suggestion || '').trim();
      if (!res?.ok || !sug) {
        const failReason = res?.reason || res?.error || 'empty';
        // 若首次触发时尚未落盘助手正文，允许同一轮次在后续新读数到来时受控补试 1 次，防止永久锁死
        const isTransientMissing = failReason === 'missing_assistant_reply' || failReason === 'missing_real_user_turn' || !res?.ok;
        if (isTransientMissing && !nextPromptState._retriedTurnKeys?.has?.(turnKey)) {
          if (!nextPromptState._retriedTurnKeys) nextPromptState._retriedTurnKeys = new Set();
          nextPromptState._retriedTurnKeys.add(turnKey);
          nextPromptState.attemptedTurnKeys.delete(turnKey);
        }
        nextPromptState.lastDiagnostics = {
          at: Date.now(),
          routeId,
          turnKey,
          stage: res?.ok ? 'abstained' : 'failed',
          reason: failReason,
          turnsSource: res?.turnsSource || 'unknown',
          authRefreshed: Boolean(res?.authRefreshed),
          latencyMs: Date.now() - reqStartedAt
        };
        dismissNextPromptSuggestion(false);
        return { ok: Boolean(res?.ok), abstained: true, suggestion: '', reason: failReason };
      }

      nextPromptState.model = res.model || null;
      nextPromptState.lastDiagnostics = {
        at: Date.now(),
        routeId,
        turnKey,
        stage: 'shown',
        model: nextPromptState.model,
        latencyMs: Date.now() - reqStartedAt
      };
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
    try { nextPromptState.ghostEl?.remove?.(); } catch { }
    nextPromptState.ghostEl = null;
    nextPromptState.ghostTextEl = null;
    try { document.getElementById(NEXT_PROMPT_STYLE_ID)?.remove?.(); } catch { }
  }
