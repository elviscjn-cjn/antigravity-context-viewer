  // =========================================================================
  // 轻量模型与思考档位分离选择器模块（Phase 5 · 复用宿主链路的优雅增强层）
  // 遵循规则：
  // 1. 每个基础模型在菜单中仅出现一次；思考档位拆分到旁边独立控件；
  // 2. 固定档位与 Orchestrator 只读展示或隐藏可选下拉，绝不虚构不支持的档位；
  // 3. 切换模型优先沿用当前档位，不支持时按宿主规则回退并明确提示 High / Extra High；
  // 4. 按 .surface-composer 独立隔离分屏与 Side Chat 会话归属；结构不可识别时无缝退回原生菜单。
  // =========================================================================

  function getMpCore() {
    return (typeof __AGContextMeterCore !== 'undefined' && __AGContextMeterCore)
      ? __AGContextMeterCore
      : ((typeof globalThis !== 'undefined' && globalThis.__AGContextMeterCore) || {});
  }

  let simplifiedModelPickerEnabled = (() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem('ag_simplified_model_picker');
        if (v === 'false' || v === '0') return false;
      }
    } catch { }
    return true;
  })();

  const MODEL_PICKER_STYLE_ID = 'ag-model-picker-style';
  const modelPickerWeakState = new WeakMap();
  const mountedPickerRecords = new Set();
  let activeOpenPickerState = null;
  let globalPickerListenersBound = false;

  function ensureModelPickerStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(MODEL_PICKER_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = MODEL_PICKER_STYLE_ID;
      style.textContent = `
        .ag-mp-native-hidden {
          position: absolute !important;
          width: 1px !important;
          height: 1px !important;
          opacity: 0 !important;
          pointer-events: none !important;
          overflow: hidden !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
        }
        body.ag-mp-native-probing [role="listbox"],
        body.ag-mp-native-probing [role="menu"],
        body.ag-mp-native-probing [data-radix-popper-content-wrapper] {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .ag-mp-wrap {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          position: relative;
          min-width: 0;
          max-width: 100%;
          flex-shrink: 1;
          vertical-align: middle;
          font-family: inherit;
        }
        .ag-mp-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 26px;
          padding: 0 8px;
          border-radius: 7px;
          border: 1px solid rgba(148, 163, 184, 0.24);
          background: rgba(148, 163, 184, 0.08);
          color: inherit;
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          cursor: pointer;
          white-space: nowrap;
          min-width: 0;
          max-width: 210px;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .ag-mp-btn:hover,
        .ag-mp-btn[aria-expanded="true"] {
          background: rgba(148, 163, 184, 0.16);
          border-color: rgba(148, 163, 184, 0.42);
        }
        .ag-mp-btn:focus-visible {
          outline: 2px solid #8b5cf6;
          outline-offset: 1px;
        }
        .ag-mp-model-lbl {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ag-mp-effort-btn {
          max-width: 126px;
        }
        .ag-mp-effort-btn[data-readonly="true"] {
          opacity: 0.68;
          cursor: default;
          background: rgba(148, 163, 184, 0.05);
          border-style: dashed;
        }
        .ag-mp-effort-btn[data-readonly="true"]:hover {
          background: rgba(148, 163, 184, 0.05);
          border-color: rgba(148, 163, 184, 0.24);
        }
        .ag-mp-chevron {
          opacity: 0.7;
          font-size: 10px;
          flex-shrink: 0;
        }
        .ag-mp-fallback-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 7px;
          border-radius: 6px;
          font-size: 11px;
          line-height: 1.3;
          background: rgba(148, 163, 184, 0.14);
          border: 1px solid rgba(148, 163, 184, 0.28);
          color: inherit;
          white-space: nowrap;
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ag-mp-fallback-pill[data-level="high"] {
          background: rgba(245, 158, 11, 0.16);
          border-color: rgba(245, 158, 11, 0.5);
          color: #f59e0b;
        }
        .ag-mp-fallback-pill[hidden] {
          display: none !important;
        }
        .ag-mp-popover {
          position: fixed;
          z-index: 2147483000;
          min-width: 228px;
          max-width: min(320px, calc(100vw - 16px));
          max-height: min(420px, calc(100vh - 24px));
          overflow-y: auto;
          padding: 6px;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.28);
          background: var(--vscode-menu-background, #18181b);
          color: var(--vscode-menu-foreground, #f4f4f5);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
          font-size: 12px;
        }
        .ag-mp-popover[hidden] {
          display: none !important;
        }
        .ag-mp-popover[data-light="true"] {
          background: #ffffff;
          color: #18181b;
          border-color: rgba(15, 23, 42, 0.16);
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
        }
        .ag-mp-hdr {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 4px 8px 6px;
          font-size: 11px;
          opacity: 0.72;
          border-bottom: 1px solid rgba(148, 163, 184, 0.16);
          margin-bottom: 4px;
        }
        .ag-mp-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          width: 100%;
          border: 0;
          background: transparent;
          color: inherit;
          padding: 6px 8px;
          border-radius: 6px;
          text-align: left;
          font-size: 12px;
          cursor: pointer;
        }
        .ag-mp-item:hover,
        .ag-mp-item.is-focused {
          background: rgba(139, 92, 246, 0.18);
        }
        .ag-mp-item[aria-selected="true"] {
          font-weight: 600;
        }
        .ag-mp-item[aria-disabled="true"] {
          opacity: 0.46;
          cursor: not-allowed;
        }
        .ag-mp-item[aria-disabled="true"]:hover {
          background: transparent;
        }
        .ag-mp-item-meta {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          opacity: 0.78;
          flex-shrink: 0;
        }
        .ag-mp-divider {
          height: 1px;
          background: rgba(148, 163, 184, 0.18);
          margin: 5px 4px;
        }
        .ag-mp-subpanel {
          padding: 4px 2px 2px;
        }
        .ag-mp-subpanel[hidden] {
          display: none !important;
        }
        .ag-mp-sub-group-title {
          font-size: 10.5px;
          opacity: 0.68;
          padding: 4px 8px 2px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        @media (max-width: 480px) {
          .ag-mp-btn { max-width: 138px; padding: 0 6px; font-size: 11px; }
          .ag-mp-effort-btn { max-width: 82px; }
          .ag-mp-fallback-pill { max-width: 136px; font-size: 10.5px; }
        }
      `;
      document.head.appendChild(style);
    } catch { }
  }

  function resolveComposerRouteContext(composer, trigger) {
    try {
      const convNode = composer?.closest?.('[data-testid="conversation-view"], [data-cascade-id], [data-session-id]');
      const explicitId = convNode?.getAttribute?.('data-cascade-id') || convNode?.getAttribute?.('data-session-id') || null;
      if (explicitId) return explicitId;
      const layout = typeof parseConversationLayout === 'function' ? parseConversationLayout() : null;
      if (layout?.targets?.length) {
        const hit = layout.targets.find(tg => {
          const elNode = tg.triggerEl || tg.containerEl || tg.node;
          return elNode && (elNode === trigger || elNode === composer || composer?.contains?.(elNode) || elNode?.contains?.(composer));
        });
        if (hit?.id) return hit.id;
      }
    } catch { }
    return state.route || null;
  }

  function parseTriggerTextAndEffort(trigger) {
    if (!trigger) return { label: '', productLabel: '', effort: null, modelId: null, isOrchestrator: false };
    let effortAttr = null;
    try {
      const efNode = trigger.querySelector?.('[data-testid="model-selector-effort-option"]') || trigger.querySelector?.('[data-effort]');
      if (efNode) effortAttr = efNode.getAttribute?.('data-effort') || efNode.textContent?.trim() || null;
    } catch { }

    let rawText = '';
    try {
      const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
      const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
      if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
      rawText = String(clone.textContent || trigger.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      rawText = String(trigger.textContent || '').replace(/\s+/g, ' ').trim();
    }

    const stripped = rawText.replace(/^(?:Orchestrator|Planner|Worker|Executor)\s*[·|:\-–—»/]+\s*/i, '').trim();
    const isOrch = /^orchestrator\b/i.test(rawText);

    const parsedSplit = typeof getMpCore().splitModelDisplayAndEffort === 'function'
      ? getMpCore().splitModelDisplayAndEffort(stripped || rawText)
      : null;

    let baseName = parsedSplit?.baseName || stripped || rawText;
    let effort = effortAttr ? (getMpCore().normalizeEffortValue?.(effortAttr) || effortAttr) : (parsedSplit?.effort || null);
    if (isOrch) {
      baseName = rawText;
      effort = null;
    }

    return {
      label: rawText,
      productLabel: baseName,
      effort,
      isOrchestrator: isOrch
    };
  }

  function getActiveGroupedMenu() {
    const existingMenu = lastComputedQuotaView?.groupedModels
      || quotaState?.snapshot?.groupedModels
      || state?.groupedModels
      || null;
    if (existingMenu && Array.isArray(existingMenu.baseModels) && existingMenu.baseModels.length > 0) {
      return existingMenu;
    }
    const rawUserStatusCfgs = quotaState?.rawInput?.userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs
      || quotaState?.rawInput?.userStatusRes?.cascadeModelConfigData?.clientModelConfigs
      || quotaState?.rawInput?.cascadeModelConfigs
      || [];
    const rawUserStatusSorts = quotaState?.rawInput?.userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelSorts
      || quotaState?.rawInput?.userStatusRes?.cascadeModelConfigData?.clientModelSorts
      || state.clientModelSorts
      || [];
    const configs = (Array.isArray(rawUserStatusCfgs) && rawUserStatusCfgs.length > 0)
      ? rawUserStatusCfgs
      : (Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0
        ? state.cascadeModelConfigs
        : (Array.isArray(state.scan?.cascadeModelConfigs) ? state.scan.cascadeModelConfigs : []));
    const mpCore = getMpCore();
    if (!configs.length || typeof mpCore.buildGroupedModelMenu !== 'function') {
      return null;
    }
    return mpCore.buildGroupedModelMenu({
      cascadeModelConfigs: configs,
      clientModelSorts: rawUserStatusSorts,
      defaultOverrideModelConfig: state.defaultOverrideModelConfig || null,
      pools: lastComputedQuotaView?.pools || quotaState?.snapshot?.pools || []
    });
  }

  function findOpenNativeModelOptions() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
    const containers = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-testid*="model-selector-menu"]') || []);
    const candidates = [];
    for (const c of containers) {
      if (!c || c.closest?.('.ag-mp-popover') || c.closest?.('#ag-context-meter')) continue;
      const items = Array.from(c.querySelectorAll?.('[role="option"], [role="menuitem"], button, [data-value], [data-model-id]') || []);
      for (const it of items) candidates.push(it);
    }
    return candidates;
  }

  async function dispatchHostModelSwitch(rec, variant, productLabel) {
    if (!rec || !rec.trigger || !variant) return { ok: false, reason: 'missing_target' };
    try {
      // 1. 允许测试或宿主直接注册回调桥，否则通过隐藏探测点击真实宿主下拉项
      const testHook = typeof window !== 'undefined' && typeof window.__agTestModelSelectHook === 'function'
        ? window.__agTestModelSelectHook
        : null;
      if (testHook) {
        const res = await testHook({
          composer: rec.composer,
          trigger: rec.trigger,
          route: resolveComposerRouteContext(rec.composer, rec.trigger),
          variant,
          productLabel
        });
        if (res === false || res?.ok === false) {
          return { ok: false, reason: res?.reason || 'host_hook_rejected' };
        }
        return { ok: true, method: 'hook', modelId: variant.modelId, effort: variant.effort || null };
      }

      if (typeof document !== 'undefined' && document.body) {
        document.body.classList?.add?.('ag-mp-native-probing');
      }
      try {
        rec.trigger.click?.();
      } catch { }

      const deadline = Date.now() + 200;
      let matchedNode = null;
      while (Date.now() <= deadline) {
        const options = findOpenNativeModelOptions();
        for (const opt of options) {
          const dataModelId = String(opt.getAttribute?.('data-model-id') || opt.getAttribute?.('data-value') || '').trim();
          if (dataModelId && (dataModelId === variant.modelId || (variant.alias && dataModelId === variant.alias))) {
            matchedNode = opt;
            break;
          }
          const txt = String(opt.textContent || '').replace(/\s+/g, ' ').trim();
          const mpCore = getMpCore();
          if (typeof mpCore.matchHostMenuOptionText === 'function'
            ? mpCore.matchHostMenuOptionText(txt, variant, productLabel)
            : (txt && txt.toLowerCase() === String(variant.label || '').toLowerCase())) {
            matchedNode = opt;
            break;
          }
        }
        if (matchedNode) break;
        await new Promise(r => setTimeout(r, 16));
      }

      if (!matchedNode) {
        // 宿主结构不可识别：解除屏蔽并允许用户直接使用宿主原生按钮
        try {
          if (typeof document !== 'undefined' && document.body) {
            document.body.classList?.remove?.('ag-mp-native-probing');
          }
        } catch { }
        return { ok: false, reason: 'native_option_not_found' };
      }

      matchedNode.click?.();
      await new Promise(r => setTimeout(r, 20));
      return { ok: true, method: 'native_dom', modelId: variant.modelId, effort: variant.effort || null };
    } catch (e) {
      return { ok: false, reason: e?.message || 'dispatch_error' };
    } finally {
      try {
        if (typeof document !== 'undefined' && document.body) {
          document.body.classList?.remove?.('ag-mp-native-probing');
        }
      } catch { }
      try { scheduleHostModelSync(); } catch { }
    }
  }

  function closeActiveModelPicker(restoreFocus = false) {
    if (!activeOpenPickerState) return;
    const st = activeOpenPickerState;
    const prevMode = st.openMode;
    st.openMode = null;
    st.submenuOpen = false;
    st.focusedIndex = -1;
    if (st.modelMenuEl) st.modelMenuEl.hidden = true;
    if (st.effortMenuEl) st.effortMenuEl.hidden = true;
    st.modelBtn?.setAttribute?.('aria-expanded', 'false');
    st.effortBtn?.setAttribute?.('aria-expanded', 'false');
    activeOpenPickerState = null;
    if (restoreFocus) {
      if (prevMode === 'effort' && !st.effortBtn?.disabled) {
        st.effortBtn?.focus?.();
      } else {
        st.modelBtn?.focus?.();
      }
    }
  }

  function positionPickerPopover(anchorBtn, popoverEl) {
    if (!anchorBtn || !popoverEl || !popoverEl.style) return;
    try {
      const vw = (typeof window !== 'undefined' && Number(window.innerWidth) > 0) ? Number(window.innerWidth) : 1280;
      const vh = (typeof window !== 'undefined' && Number(window.innerHeight) > 0) ? Number(window.innerHeight) : 800;
      const rect = anchorBtn.getBoundingClientRect ? anchorBtn.getBoundingClientRect() : { left: 20, top: 600, bottom: 626, width: 120 };
      const popW = Math.min(320, Math.max(200, vw - 16));
      const popH = Math.min(360, vh - 24);
      const clampedLeft = Math.max(8, Math.min(rect.left || 8, vw - popW - 8));
      const placeAbove = (rect.top || 0) > popH + 16 || (vh - (rect.bottom || 0)) < 180;
      popoverEl.style.left = `${Math.round(clampedLeft)}px`;
      if (placeAbove) {
        popoverEl.style.top = 'auto';
        popoverEl.style.bottom = `${Math.max(8, Math.round(vh - (rect.top || 0) + 6))}px`;
      } else {
        popoverEl.style.bottom = 'auto';
        popoverEl.style.top = `${Math.min(vh - 48, Math.round((rect.bottom || 0) + 6))}px`;
      }
      popoverEl.style.maxWidth = `${Math.max(180, vw - 16)}px`;
      const isLightHost = host?.getAttribute?.('data-theme') === 'light';
      if (isLightHost) popoverEl.setAttribute('data-light', 'true');
      else popoverEl.removeAttribute('data-light');
    } catch { }
  }

  function bindGlobalPickerListeners() {
    if (globalPickerListenersBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    globalPickerListenersBound = true;
    const onDocPointerDown = (e) => {
      if (!activeOpenPickerState) return;
      const tgt = e.target;
      const inside = activeOpenPickerState.wrap?.contains?.(tgt)
        || activeOpenPickerState.modelMenuEl?.contains?.(tgt)
        || activeOpenPickerState.effortMenuEl?.contains?.(tgt);
      if (!inside) closeActiveModelPicker(false);
    };
    const onDocKeyDown = (e) => {
      if (!activeOpenPickerState) return;
      const st = activeOpenPickerState;
      const menuEl = st.openMode === 'effort' ? st.effortMenuEl : st.modelMenuEl;
      if (!menuEl || menuEl.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (st.submenuOpen && st.openMode === 'model') {
          st.submenuOpen = false;
          renderModelMenuContents(st);
          return;
        }
        closeActiveModelPicker(true);
        return;
      }
      const focusableItems = Array.from(menuEl.querySelectorAll?.('.ag-mp-item[data-selectable="true"]') || []);
      if (!focusableItems.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault?.();
        st.focusedIndex = (st.focusedIndex + 1 + focusableItems.length) % focusableItems.length;
        updateMenuFocusHighlight(focusableItems, st.focusedIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault?.();
        st.focusedIndex = (st.focusedIndex - 1 + focusableItems.length) % focusableItems.length;
        updateMenuFocusHighlight(focusableItems, st.focusedIndex);
      } else if (e.key === 'ArrowRight' && st.openMode === 'model') {
        const curItem = focusableItems[st.focusedIndex];
        if (curItem?.getAttribute?.('data-item-role') === 'orchestrator-entry') {
          e.preventDefault?.();
          st.submenuOpen = true;
          renderModelMenuContents(st);
        }
      } else if (e.key === 'ArrowLeft' && st.openMode === 'model' && st.submenuOpen) {
        e.preventDefault?.();
        st.submenuOpen = false;
        renderModelMenuContents(st);
      } else if ((e.key === 'Enter' || e.key === ' ') && st.focusedIndex >= 0 && focusableItems[st.focusedIndex]) {
        e.preventDefault?.();
        focusableItems[st.focusedIndex].click?.();
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    activeDisposers.add(() => {
      try {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('keydown', onDocKeyDown, true);
      } catch { }
      globalPickerListenersBound = false;
    });
  }

  function updateMenuFocusHighlight(items, activeIdx) {
    items.forEach((node, idx) => {
      if (idx === activeIdx) node.classList?.add?.('is-focused');
      else node.classList?.remove?.('is-focused');
    });
  }

  function openComposerQuotaFromModelMenu(rec) {
    closeActiveModelPicker(false);
    try {
      const csbQuota = el('csb-group-quota');
      if (csbQuota && typeof csbQuota.click === 'function' && !csbQuota.hidden) {
        csbQuota.click();
        return true;
      }
      const panelQuota = el('panel-quota');
      if (panelQuota && !panelQuota.hidden && panelQuota.style?.display !== 'none') {
        showPanel('none');
      } else if (typeof togglePanel === 'function') {
        togglePanel('quota');
      }
      return true;
    } catch { return false; }
  }

  function resolveCurrentSelectionForPicker(rec, menu) {
    const parsed = parseTriggerTextAndEffort(rec.trigger);
    if (rec.pendingSelection && rec.pendingSelection.label === parsed.label) {
      return rec.pendingSelection;
    }
    const baseModels = Array.isArray(menu?.baseModels) ? menu.baseModels : [];
    const orch = menu?.orchestrator || null;

    if (parsed.isOrchestrator && orch?.hasOrchestrator) {
      const hit = (orch.presets || []).find(p =>
        p.label.toLowerCase() === parsed.label.toLowerCase()
        || p.targetLabel.toLowerCase() === parsed.label.replace(/^orchestrator\s*[（(]?|[)）]$/gi, '').trim().toLowerCase()
      ) || orch.presets?.[0] || null;
      return {
        isOrchestrator: true,
        productKey: 'orchestrator',
        productLabel: hit ? hit.label : (parsed.label || 'Orchestrator'),
        effort: null,
        isFixedEffort: true,
        supportedEfforts: [],
        variant: hit,
        modelId: hit?.modelId || null,
        route: resolveComposerRouteContext(rec.composer, rec.trigger)
      };
    }

    const lowLabel = parsed.label.toLowerCase();
    const lowProd = parsed.productLabel.toLowerCase();
    let matchedBase = baseModels.find(m =>
      m.productLabel.toLowerCase() === lowProd
      || m.variants.some(v => v.label.toLowerCase() === lowLabel)
    ) || null;
    if (!matchedBase && lowProd) {
      const mpCore = getMpCore();
      const normProd = typeof mpCore.normalizeModelLookupName === 'function' ? mpCore.normalizeModelLookupName(lowProd) : lowProd;
      matchedBase = baseModels.find(m =>
        typeof mpCore.normalizeModelLookupName === 'function'
          ? mpCore.normalizeModelLookupName(m.productLabel) === normProd
          : m.productLabel.toLowerCase().includes(lowProd)
      ) || null;
    }
    if (!matchedBase) matchedBase = baseModels[0] || null;

    const chosenEffort = parsed.effort || matchedBase?.defaultEffort || matchedBase?.fixedEffortLabel || null;
    const matchedVariant = matchedBase
      ? (matchedBase.variants.find(v => chosenEffort && v.effort && v.effort.toLowerCase() === chosenEffort.toLowerCase()) || matchedBase.variants[0] || null)
      : null;

    return {
      isOrchestrator: false,
      productKey: matchedBase?.productKey || null,
      productLabel: matchedBase?.productLabel || parsed.productLabel || t('modelPicker.unknownModel'),
      effort: matchedVariant?.effort || chosenEffort || null,
      isFixedEffort: matchedBase ? Boolean(matchedBase.isFixedEffort) : true,
      supportedEfforts: matchedBase?.supportedEfforts || [],
      variant: matchedVariant,
      modelId: matchedVariant?.modelId || null,
      route: resolveComposerRouteContext(rec.composer, rec.trigger)
    };
  }

  async function applyModelOrEffortSelection(rec, targetRes) {
    if (!rec || !targetRes || !targetRes.ok || !targetRes.variant) return { ok: false, reason: targetRes?.reason || 'invalid' };
    const dispatchRes = await dispatchHostModelSwitch(rec, targetRes.variant, targetRes.productLabel);
    if (!dispatchRes.ok) {
      if (dispatchRes.reason === 'native_option_not_found') {
        rec.nativeStructureMismatch = true;
        fallbackPickerToNative(rec);
      }
      return dispatchRes;
    }

    rec.pendingSelection = {
      ...targetRes,
      label: targetRes.variant.label
    };
    if (targetRes.fallbackApplied) {
      rec.fallbackNotice = {
        highWarning: Boolean(targetRes.highFallbackWarning),
        fromEffort: targetRes.fallbackFrom,
        toEffort: targetRes.fallbackTo || targetRes.effort || '',
        text: targetRes.highFallbackWarning
          ? t('modelPicker.fallbackHighWarn', { from: targetRes.fallbackFrom || '', to: targetRes.fallbackTo || targetRes.effort || '' })
          : t('modelPicker.fallbackNormal', { to: targetRes.fallbackTo || targetRes.effort || '' })
      };
    } else {
      rec.fallbackNotice = null;
    }

    updatePickerButtonsUi(rec);
    closeActiveModelPicker(false);
    return {
      ok: true,
      modelId: targetRes.variant.modelId,
      effort: targetRes.effort || null,
      fallbackApplied: Boolean(targetRes.fallbackApplied),
      highFallbackWarning: Boolean(targetRes.highFallbackWarning),
      route: resolveComposerRouteContext(rec.composer, rec.trigger)
    };
  }

  function renderModelMenuContents(rec) {
    const menuEl = rec.modelMenuEl;
    if (!menuEl) return;
    const menu = getActiveGroupedMenu();
    if (!menu || !menu.baseModels?.length) return;
    const curSel = resolveCurrentSelectionForPicker(rec, menu);
    menuEl.replaceChildren?.();

    const hdr = document.createElement('div');
    hdr.className = 'ag-mp-hdr';
    const hdrTitle = document.createElement('span');
    hdrTitle.textContent = rec.submenuOpen ? t('modelPicker.orchestratorTitle') : t('modelPicker.title');
    hdr.appendChild(hdrTitle);
    const hdrNote = document.createElement('span');
    hdrNote.textContent = rec.submenuOpen ? t('modelPicker.orchestratorSubHint') : t('modelPicker.subtitle');
    hdr.appendChild(hdrNote);
    menuEl.appendChild(hdr);

    if (rec.submenuOpen && menu.orchestrator?.hasOrchestrator) {
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ag-mp-item';
      backBtn.setAttribute('data-selectable', 'true');
      backBtn.setAttribute('role', 'option');
      backBtn.textContent = `‹ ${t('modelPicker.backToModels')}`;
      backBtn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        rec.submenuOpen = false;
        rec.focusedIndex = -1;
        renderModelMenuContents(rec);
      });
      menuEl.appendChild(backBtn);

      if (menu.orchestrator.supportsIndependentRoles) {
        // 仅当宿主真实暴露独立 Planner / Executor 配置时提供双角色选择
        const addRoleSection = (titleKey, list, roleKind) => {
          if (!Array.isArray(list) || !list.length) return;
          const subT = document.createElement('div');
          subT.className = 'ag-mp-sub-group-title';
          subT.textContent = t(titleKey);
          menuEl.appendChild(subT);
          for (const item of list) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ag-mp-item';
            btn.setAttribute('role', 'option');
            btn.setAttribute('data-role-kind', roleKind);
            btn.setAttribute('data-model-id', item.modelId);
            if (item.unavailable) {
              btn.setAttribute('aria-disabled', 'true');
              btn.title = item.unavailabilityReason || t('modelPicker.unavailable');
            } else {
              btn.setAttribute('data-selectable', 'true');
              btn.addEventListener('click', (e) => {
                e.stopPropagation?.();
                void applyModelOrEffortSelection(rec, {
                  ok: true,
                  isOrchestrator: true,
                  productKey: 'orchestrator',
                  productLabel: item.label,
                  variant: item,
                  modelId: item.modelId,
                  effort: null,
                  isFixedEffort: true
                });
              });
            }
            const lbl = document.createElement('span');
            lbl.textContent = item.targetLabel || item.label;
            btn.appendChild(lbl);
            if (item.unavailable) {
              const meta = document.createElement('span');
              meta.className = 'ag-mp-item-meta';
              meta.textContent = t('modelPicker.unavailable');
              btn.appendChild(meta);
            }
            menuEl.appendChild(btn);
          }
        };
        addRoleSection('modelPicker.plannerSection', menu.orchestrator.planners, 'planner');
        addRoleSection('modelPicker.executorSection', menu.orchestrator.executors, 'executor');
      } else {
        for (const preset of (menu.orchestrator.presets || [])) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-mp-item';
          btn.setAttribute('role', 'option');
          btn.setAttribute('data-model-id', preset.modelId);
          const isActive = curSel.isOrchestrator && (curSel.modelId === preset.modelId || curSel.productLabel === preset.label);
          btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          if (preset.unavailable) {
            btn.setAttribute('aria-disabled', 'true');
            btn.title = preset.unavailabilityReason || t('modelPicker.unavailable');
          } else {
            btn.setAttribute('data-selectable', 'true');
            btn.addEventListener('click', (e) => {
              e.stopPropagation?.();
              void applyModelOrEffortSelection(rec, {
                ok: true,
                isOrchestrator: true,
                productKey: 'orchestrator',
                productLabel: preset.label,
                variant: preset,
                modelId: preset.modelId,
                effort: null,
                isFixedEffort: true
              });
            });
          }
          const lbl = document.createElement('span');
          lbl.textContent = preset.label;
          btn.appendChild(lbl);
          const meta = document.createElement('span');
          meta.className = 'ag-mp-item-meta';
          meta.textContent = preset.unavailable ? t('modelPicker.unavailable') : (isActive ? '✓' : '');
          btn.appendChild(meta);
          menuEl.appendChild(btn);
        }
      }
      return;
    }

    // 主模型列表：每个基础模型只出现一次
    for (const m of menu.baseModels) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-mp-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('data-product-key', m.productKey);
      const isSelected = !curSel.isOrchestrator && curSel.productKey === m.productKey;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      if (m.unavailable) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = m.unavailabilityReason || t('modelPicker.unavailable');
      } else {
        btn.setAttribute('data-selectable', 'true');
        btn.addEventListener('click', (e) => {
          e.stopPropagation?.();
          const targetRes = getMpCore().resolveTargetModelAndEffort(
            menu,
            m.productKey,
            curSel.effort,
            { defaultOverrideModelConfig: state.defaultOverrideModelConfig || null }
          );
          void applyModelOrEffortSelection(rec, targetRes);
        });
      }
      const lbl = document.createElement('span');
      lbl.textContent = m.productLabel;
      btn.appendChild(lbl);
      const meta = document.createElement('span');
      meta.className = 'ag-mp-item-meta';
      if (m.unavailable) {
        meta.textContent = t('modelPicker.unavailable');
      } else if (isSelected) {
        meta.textContent = '✓';
      } else if (m.isFixedEffort && m.fixedEffortLabel) {
        meta.textContent = m.fixedEffortLabel;
      }
      btn.appendChild(meta);
      menuEl.appendChild(btn);
    }

    // Orchestrator 单一合并入口
    if (menu.orchestrator?.hasOrchestrator) {
      const div1 = document.createElement('div');
      div1.className = 'ag-mp-divider';
      menuEl.appendChild(div1);

      const orchBtn = document.createElement('button');
      orchBtn.type = 'button';
      orchBtn.className = 'ag-mp-item';
      orchBtn.setAttribute('role', 'option');
      orchBtn.setAttribute('data-item-role', 'orchestrator-entry');
      orchBtn.setAttribute('aria-selected', curSel.isOrchestrator ? 'true' : 'false');
      if (menu.orchestrator.allUnavailable) {
        orchBtn.setAttribute('aria-disabled', 'true');
      } else {
        orchBtn.setAttribute('data-selectable', 'true');
        orchBtn.addEventListener('click', (e) => {
          e.stopPropagation?.();
          rec.submenuOpen = true;
          rec.focusedIndex = -1;
          renderModelMenuContents(rec);
        });
      }
      const oLbl = document.createElement('span');
      oLbl.textContent = t('modelPicker.orchestratorEntry');
      orchBtn.appendChild(oLbl);
      const oArrow = document.createElement('span');
      oArrow.className = 'ag-mp-item-meta';
      oArrow.textContent = curSel.isOrchestrator ? '✓ ›' : '›';
      orchBtn.appendChild(oArrow);
      menuEl.appendChild(orchBtn);
    }

    // 「查看用量」复用输入框已有用量入口
    const div2 = document.createElement('div');
    div2.className = 'ag-mp-divider';
    menuEl.appendChild(div2);

    const quotaBtn = document.createElement('button');
    quotaBtn.type = 'button';
    quotaBtn.className = 'ag-mp-item';
    quotaBtn.setAttribute('role', 'option');
    quotaBtn.setAttribute('data-item-role', 'view-usage');
    quotaBtn.setAttribute('data-selectable', 'true');
    quotaBtn.textContent = t('modelPicker.viewUsage');
    quotaBtn.addEventListener('click', (e) => {
      e.stopPropagation?.();
      openComposerQuotaFromModelMenu(rec);
    });
    menuEl.appendChild(quotaBtn);
  }

  function renderEffortMenuContents(rec) {
    const menuEl = rec.effortMenuEl;
    if (!menuEl) return;
    const menu = getActiveGroupedMenu();
    if (!menu) return;
    const curSel = resolveCurrentSelectionForPicker(rec, menu);
    menuEl.replaceChildren?.();
    if (curSel.isFixedEffort || !curSel.supportedEfforts?.length || curSel.isOrchestrator) return;

    const targetModel = menu.baseModels.find(m => m.productKey === curSel.productKey);
    if (!targetModel) return;

    const hdr = document.createElement('div');
    hdr.className = 'ag-mp-hdr';
    const title = document.createElement('span');
    title.textContent = t('modelPicker.effortTitle');
    hdr.appendChild(title);
    menuEl.appendChild(hdr);

    for (const ef of targetModel.supportedEfforts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-mp-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('data-effort', ef);
      btn.setAttribute('data-selectable', 'true');
      const active = Boolean(curSel.effort && curSel.effort.toLowerCase() === ef.toLowerCase());
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        const res = getMpCore().resolveTargetModelAndEffort(menu, targetModel.productKey, ef, {
          defaultOverrideModelConfig: state.defaultOverrideModelConfig || null
        });
        void applyModelOrEffortSelection(rec, res);
      });
      const lbl = document.createElement('span');
      lbl.textContent = ef;
      btn.appendChild(lbl);
      const chk = document.createElement('span');
      chk.className = 'ag-mp-item-meta';
      chk.textContent = active ? '✓' : '';
      btn.appendChild(chk);
      menuEl.appendChild(btn);
    }
  }

  function updatePickerButtonsUi(rec) {
    const menu = getActiveGroupedMenu();
    if (!menu || !rec) return;
    const curSel = resolveCurrentSelectionForPicker(rec, menu);
    if (rec.modelLblEl) rec.modelLblEl.textContent = curSel.productLabel || t('modelPicker.unknownModel');

    if (rec.effortBtn) {
      if (curSel.isOrchestrator) {
        rec.effortBtn.hidden = true;
        rec.effortBtn.disabled = true;
        rec.effortBtn.setAttribute('data-readonly', 'true');
        rec.effortBtn.setAttribute('aria-disabled', 'true');
      } else if (!curSel.effort && (!curSel.supportedEfforts || curSel.supportedEfforts.length === 0)) {
        rec.effortBtn.hidden = true;
        rec.effortBtn.disabled = true;
      } else {
        rec.effortBtn.hidden = false;
        const readOnly = Boolean(curSel.isFixedEffort || (curSel.supportedEfforts?.length || 0) <= 1);
        rec.effortBtn.disabled = readOnly;
        rec.effortBtn.setAttribute('data-readonly', readOnly ? 'true' : 'false');
        rec.effortBtn.setAttribute('aria-disabled', readOnly ? 'true' : 'false');
        rec.effortBtn.setAttribute('tabindex', readOnly ? '-1' : '0');
        rec.effortLblEl.textContent = curSel.effort || curSel.supportedEfforts?.[0] || '';
        if (rec.effortChevronEl) rec.effortChevronEl.hidden = readOnly;
      }
    }

    if (rec.fallbackPillEl) {
      if (rec.fallbackNotice?.text) {
        rec.fallbackPillEl.hidden = false;
        rec.fallbackPillEl.textContent = rec.fallbackNotice.text;
        rec.fallbackPillEl.setAttribute('data-level', rec.fallbackNotice.highWarning ? 'high' : 'normal');
      } else {
        rec.fallbackPillEl.hidden = true;
        rec.fallbackPillEl.textContent = '';
      }
    }
  }

  function fallbackPickerToNative(rec) {
    if (!rec) return;
    if (activeOpenPickerState === rec) closeActiveModelPicker(false);
    try { rec.trigger?.classList?.remove?.('ag-mp-native-hidden'); } catch { }
    try { rec.wrap?.remove?.(); } catch { }
    try { rec.modelMenuEl?.remove?.(); } catch { }
    try { rec.effortMenuEl?.remove?.(); } catch { }
    if (rec.composer) modelPickerWeakState.delete(rec.composer);
    mountedPickerRecords.delete(rec);
  }

  function mountModelPickerForComposer(composer, trigger) {
    if (!composer || !trigger || !trigger.parentElement) return null;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;

    let rec = modelPickerWeakState.get(composer);
    if (rec && rec.trigger === trigger && rec.wrap?.isConnected !== false) {
      updatePickerButtonsUi(rec);
      return rec;
    }
    if (rec) fallbackPickerToNative(rec);

    ensureModelPickerStyles();
    bindGlobalPickerListeners();

    const wrap = document.createElement('div');
    wrap.className = 'ag-mp-wrap';
    wrap.setAttribute('data-ag-model-picker', 'true');

    const modelBtn = document.createElement('button');
    modelBtn.type = 'button';
    modelBtn.className = 'ag-mp-btn ag-mp-model-btn';
    modelBtn.setAttribute('aria-haspopup', 'listbox');
    modelBtn.setAttribute('aria-expanded', 'false');
    const modelLbl = document.createElement('span');
    modelLbl.className = 'ag-mp-model-lbl';
    modelBtn.appendChild(modelLbl);
    const modelChev = document.createElement('span');
    modelChev.className = 'ag-mp-chevron';
    modelChev.textContent = '▾';
    modelBtn.appendChild(modelChev);

    const effortBtn = document.createElement('button');
    effortBtn.type = 'button';
    effortBtn.className = 'ag-mp-btn ag-mp-effort-btn';
    effortBtn.setAttribute('aria-haspopup', 'listbox');
    effortBtn.setAttribute('aria-expanded', 'false');
    const effortLbl = document.createElement('span');
    effortLbl.className = 'ag-mp-model-lbl';
    effortBtn.appendChild(effortLbl);
    const effortChev = document.createElement('span');
    effortChev.className = 'ag-mp-chevron';
    effortChev.textContent = '▾';
    effortBtn.appendChild(effortChev);

    const fallbackPill = document.createElement('span');
    fallbackPill.className = 'ag-mp-fallback-pill';
    fallbackPill.hidden = true;

    const modelMenuEl = document.createElement('div');
    modelMenuEl.className = 'ag-mp-popover ag-mp-model-menu';
    modelMenuEl.setAttribute('role', 'listbox');
    modelMenuEl.hidden = true;

    const effortMenuEl = document.createElement('div');
    effortMenuEl.className = 'ag-mp-popover ag-mp-effort-menu';
    effortMenuEl.setAttribute('role', 'listbox');
    effortMenuEl.hidden = true;

    wrap.appendChild(modelBtn);
    wrap.appendChild(effortBtn);
    wrap.appendChild(fallbackPill);
    document.body?.appendChild?.(modelMenuEl);
    document.body?.appendChild?.(effortMenuEl);

    rec = {
      composer,
      trigger,
      wrap,
      modelBtn,
      modelLblEl: modelLbl,
      effortBtn,
      effortLblEl: effortLbl,
      effortChevronEl: effortChev,
      fallbackPillEl: fallbackPill,
      modelMenuEl,
      effortMenuEl,
      openMode: null,
      submenuOpen: false,
      focusedIndex: -1,
      fallbackNotice: null,
      pendingSelection: null,
      nativeStructureMismatch: false
    };

    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation?.();
      if (activeOpenPickerState === rec && rec.openMode === 'model') {
        closeActiveModelPicker(false);
        return;
      }
      closeActiveModelPicker(false);
      rec.openMode = 'model';
      rec.submenuOpen = false;
      rec.focusedIndex = -1;
      activeOpenPickerState = rec;
      renderModelMenuContents(rec);
      rec.modelMenuEl.hidden = false;
      rec.modelBtn.setAttribute('aria-expanded', 'true');
      positionPickerPopover(rec.modelBtn, rec.modelMenuEl);
    });

    effortBtn.addEventListener('click', (e) => {
      e.stopPropagation?.();
      if (rec.effortBtn.disabled || rec.effortBtn.getAttribute('data-readonly') === 'true') return;
      if (activeOpenPickerState === rec && rec.openMode === 'effort') {
        closeActiveModelPicker(false);
        return;
      }
      closeActiveModelPicker(false);
      rec.openMode = 'effort';
      rec.focusedIndex = -1;
      activeOpenPickerState = rec;
      renderEffortMenuContents(rec);
      rec.effortMenuEl.hidden = false;
      rec.effortBtn.setAttribute('aria-expanded', 'true');
      positionPickerPopover(rec.effortBtn, rec.effortMenuEl);
    });

    // 保留原按钮在 DOM 中的真实尺寸 (>=1px) 与绑定以供现有选择器追踪与安全回退
    trigger.classList?.add?.('ag-mp-native-hidden');
    if (typeof trigger.after === 'function') {
      trigger.after(wrap);
    } else if (typeof trigger.parentElement.insertBefore === 'function') {
      trigger.parentElement.insertBefore(wrap, trigger.nextSibling || null);
    } else {
      trigger.parentElement.appendChild?.(wrap);
    }

    modelPickerWeakState.set(composer, rec);
    mountedPickerRecords.add(rec);
    updatePickerButtonsUi(rec);
    return rec;
  }

  function syncModelPickers() {
    try {
      if (state.disposed) return [];
      const menu = getActiveGroupedMenu();
      const marketplaceActive = typeof isHostMarketplaceActive === 'function' ? isHostMarketplaceActive() : false;
      if (!simplifiedModelPickerEnabled || marketplaceActive || !menu || !menu.baseModels?.length) {
        for (const rec of Array.from(mountedPickerRecords)) fallbackPickerToNative(rec);
        return [];
      }
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];

      const composers = Array.from(document.querySelectorAll('.surface-composer') || []);
      const validComposers = new Set();
      const results = [];

      for (const comp of composers) {
        if (!comp || comp.closest?.('#ag-context-meter, [role="dialog"], .settings-modal-container')) continue;
        const trigger = comp.querySelector?.('[data-testid="model-selector-trigger"]');
        if (!trigger || !trigger.parentElement) continue;
        const existingRec = modelPickerWeakState.get(comp);
        if (existingRec?.nativeStructureMismatch) continue;
        validComposers.add(comp);
        const rec = mountModelPickerForComposer(comp, trigger);
        if (rec) results.push(rec);
      }

      for (const rec of Array.from(mountedPickerRecords)) {
        if (!validComposers.has(rec.composer) || rec.trigger?.isConnected === false) {
          fallbackPickerToNative(rec);
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  function disposeModelPickers() {
    closeActiveModelPicker(false);
    for (const rec of Array.from(mountedPickerRecords)) {
      fallbackPickerToNative(rec);
    }
    try { document.getElementById(MODEL_PICKER_STYLE_ID)?.remove?.(); } catch { }
  }
