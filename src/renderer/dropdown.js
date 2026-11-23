  function closeAllDropdowns(exceptWrap = null) {
    const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : (typeof document !== 'undefined' ? document : null);
    try {
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => {
        if (w !== exceptWrap) {
          removeClass(w, 'is-open');
          w.querySelector?.('.ag-dropdown-trigger')?.setAttribute?.('aria-expanded', 'false');
        }
      });
    } catch {}
    if (typeof closeValidEndDatePicker === 'function') {
      const dpWrap = el('valid-end-picker-wrap');
      if (!exceptWrap || exceptWrap !== dpWrap) {
        closeValidEndDatePicker();
      }
    }
  }

  function initDropdownController(cfg) {
    const wrap = el(cfg.wrapId);
    const trigger = el(cfg.triggerId);
    const label = el(cfg.labelId);
    const menu = el(cfg.menuId);
    const linkedSelect = cfg.selectId ? el(cfg.selectId) : null;
    if (!wrap || !trigger || !label || !menu) return null;
    if (trigger._bound) return wrap._controller || null;
    trigger._bound = true;

    trigger.setAttribute?.('role', 'combobox');
    trigger.setAttribute?.('aria-haspopup', 'listbox');
    trigger.setAttribute?.('aria-expanded', 'false');
    const ariaLbl = cfg.ariaLabel || linkedSelect?.getAttribute?.('aria-label');
    if (ariaLbl) trigger.setAttribute?.('aria-label', ariaLbl);
    menu.setAttribute?.('role', 'listbox');

    let keyboardFocusIndex = -1;
    let listScrollTimer = null;
    let lastClosedMenuSig = '';
    const renderedItemMap = new Map();

    /**
     * 清空挂起的菜单内定位定时器，避免关闭或重建后继续触发滚动。
     */
    function clearListScrollTimer() {
      if (listScrollTimer) {
        clearTimeout(listScrollTimer);
        listScrollTimer = null;
      }
    }

    /**
     * 仅在不触发祖先滚动容器跳转的前提下聚焦元素。
     */
    function focusNoScroll(targetEl) {
      if (!targetEl || typeof targetEl.focus !== 'function') return;
      try {
        targetEl.focus({ preventScroll: true });
      } catch {
        targetEl.focus();
      }
    }

    /**
     * 仅调整下拉菜单自身 scrollTop，严禁调用会穿透滚动外层面板的 scrollIntoView。
     */
    function scrollChildNearestInContainer(scrollBox, childEl) {
      if (!scrollBox || !childEl) return;
      if (typeof scrollBox.getBoundingClientRect !== 'function' || typeof childEl.getBoundingClientRect !== 'function') return;
      try {
        const boxRect = scrollBox.getBoundingClientRect();
        const itemRect = childEl.getBoundingClientRect();
        if (!boxRect || !itemRect || boxRect.height <= 0 || itemRect.height <= 0) return;
        const searchBar = menu.querySelector ? menu.querySelector('.ag-dropdown-search-wrap') : null;
        const stickyTopH = (searchBar && typeof searchBar.getBoundingClientRect === 'function')
          ? Math.max(0, Math.round(searchBar.getBoundingClientRect().height || 0))
          : 0;
        const visTop = boxRect.top + stickyTopH;
        const visBottom = boxRect.bottom;
        const curScroll = Number(scrollBox.scrollTop) || 0;
        if (itemRect.top < visTop) {
          scrollBox.scrollTop = Math.max(0, curScroll - (visTop - itemRect.top + 4));
        } else if (itemRect.bottom > visBottom) {
          scrollBox.scrollTop = curScroll + (itemRect.bottom - visBottom + 4);
        }
      } catch { }
    }

    function renderMenu(kw = '', menuOpts = {}) {
      clearListScrollTimer();
      menu.innerHTML = '';
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      keyboardFocusIndex = -1;

      const allItemsForSearch = cfg.getOptions();
      const selectableCount = allItemsForSearch.filter(x => x && !x.isGroupHeader).length;
      const showSearch = cfg.searchable === true || (cfg.searchable !== false && selectableCount > 6);

      // 1. 搜索框（超过 6 项或显式启用时展示，短列表直接展示整洁选项）
      let searchInput = null;
      if (showSearch) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'ag-dropdown-search-wrap';
        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'ag-dropdown-search-input';
        searchInput.placeholder = (typeof cfg.searchPlaceholder === 'function' ? cfg.searchPlaceholder() : cfg.searchPlaceholder) || t('dropdown.searchPlaceholder');
        searchInput.value = kw;
        searchWrap.appendChild(searchInput);
        menu.appendChild(searchWrap);

        searchInput.addEventListener('click', (e) => e?.stopPropagation?.());
        searchInput.addEventListener('input', (e) => {
          renderList(e.target.value.trim().toLowerCase(), { scrollSelected: false });
        });
      }

      // 2. 列表容器
      const listContainer = document.createElement('div');
      listContainer.className = 'ag-dropdown-list-container';
      menu.appendChild(listContainer);

      let visibleItems = [];

      function updateKeyboardHighlight(newIdx) {
        const itemEls = listContainer.querySelectorAll ? listContainer.querySelectorAll('.ag-dropdown-item') : (listContainer.children || []);
        if (!itemEls.length) return;
        keyboardFocusIndex = Math.max(0, Math.min(newIdx, itemEls.length - 1));
        Array.from(itemEls).forEach((elNode, idx) => {
          if (idx === keyboardFocusIndex) {
            addClass(elNode, 'is-keyboard-focus');
            scrollChildNearestInContainer(menu, elNode);
          } else {
            removeClass(elNode, 'is-keyboard-focus');
          }
        });
      }

      function renderList(searchKey = '', listOpts = {}) {
        clearListScrollTimer();
        if (typeof listContainer.replaceChildren === 'function') listContainer.replaceChildren();
        listContainer.innerHTML = '';
        renderedItemMap.clear();
        const allItems = cfg.getOptions();
        const selectedVal = cfg.getSelectedValue();

        const matchesItem = it => {
          if (!searchKey) return true;
          if (cfg.filterItem) return cfg.filterItem(it, searchKey);
          const t1 = String(it.label || '').toLowerCase();
          const t2 = String(it.value || '').toLowerCase();
          const t3 = String(it.code || '').toLowerCase();
          const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
          return t1.includes(searchKey) || t2.includes(searchKey) || t3.includes(searchKey) || aliases.some(a => a.includes(searchKey));
        };

        // 过滤可选项；组标题仅在后续存在命中项时显示且不可选
        const renderEntries = [];
        let pendingHeader = null;
        visibleItems = [];
        for (const it of allItems) {
          if (it && it.isGroupHeader) {
            pendingHeader = it;
            continue;
          }
          if (matchesItem(it)) {
            if (pendingHeader) {
              renderEntries.push(pendingHeader);
              pendingHeader = null;
            }
            renderEntries.push(it);
            visibleItems.push(it);
          }
        }

        if (!visibleItems.length) {
          const emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'padding:10px;text-align:center;color:var(--ag-text-muted);font-size:11px';
          emptyDiv.textContent = (typeof cfg.emptyText === 'function' ? cfg.emptyText() : cfg.emptyText) || t('dropdown.empty');
          listContainer.appendChild(emptyDiv);
          return;
        }

        let selectableIdx = 0;
        renderEntries.forEach((opt) => {
          if (opt && opt.isGroupHeader) {
            const groupEl = document.createElement('div');
            groupEl.className = 'ag-dropdown-group-title';
            groupEl.setAttribute?.('role', 'presentation');
            if (opt.dotColor) {
              const dot = document.createElement('span');
              dot.className = 'ag-vendor-dot';
              dot.style.backgroundColor = opt.dotColor;
              groupEl.appendChild(dot);
            }
            const lbl = document.createElement('span');
            lbl.textContent = opt.label || '';
            groupEl.appendChild(lbl);
            listContainer.appendChild(groupEl);
            return;
          }

          const idx = selectableIdx++;
          const itemEl = document.createElement('div');
          const isSelected = cfg.isItemSelected ? cfg.isItemSelected(opt, selectedVal) : (opt.value === selectedVal);
          itemEl.className = 'ag-dropdown-item' + (isSelected ? ' is-selected' : '');
          itemEl.setAttribute?.('role', 'option');
          itemEl.setAttribute?.('aria-selected', isSelected ? 'true' : 'false');
          itemEl.setAttribute?.('data-index', String(idx));
          itemEl.setAttribute?.('data-value', String(opt.value || ''));
          itemEl.title = opt.tooltip || opt.displayLeft || opt.label || '';

          const leftSpan = document.createElement('span');
          leftSpan.className = 'ag-dropdown-item-text';
          leftSpan.textContent = opt.displayLeft || opt.label;
          itemEl.appendChild(leftSpan);

          if (opt.badgeText) {
            const b = document.createElement('span');
            b.className = 'ag-dropdown-badge';
            b.textContent = opt.badgeText;
            itemEl.appendChild(b);
          }

          const rightSpan = document.createElement('span');
          rightSpan.className = 'ag-dropdown-item-sub';
          if (opt.displayRight) {
            rightSpan.textContent = opt.displayRight;
          }

          const extraEl = typeof cfg.renderOptionExtras === 'function' ? cfg.renderOptionExtras(opt) : null;

          const check = document.createElement('span');
          check.className = 'ag-dropdown-item-check';
          check.textContent = '✓';

          if (extraEl) {
            const rightGroup = document.createElement('span');
            rightGroup.className = 'ag-dropdown-item-right';
            rightGroup.appendChild(extraEl);
            if (opt.displayRight) rightGroup.appendChild(rightSpan);
            itemEl.appendChild(rightGroup);
          } else if (opt.displayRight) {
            itemEl.appendChild(rightSpan);
          }
          itemEl.appendChild(check);

          renderedItemMap.set(opt.value, { itemEl, extraEl });

          itemEl.addEventListener('click', (e) => {
            e?.stopPropagation?.();
            selectOption(opt);
          });

          listContainer.appendChild(itemEl);
        });

        // 仅在主动展开菜单时，将当前选中项滚动到下拉列表自身可视区域（绝不触发祖先面板滚动）
        if (listOpts.scrollSelected === true) {
          listScrollTimer = setTimeout(() => {
            listScrollTimer = null;
            if (!hasClass(wrap, 'is-open')) return;
            const selNode = listContainer.querySelector ? listContainer.querySelector('.ag-dropdown-item.is-selected') : null;
            scrollChildNearestInContainer(menu, selNode);
          }, 30);
        }
      }

      function selectOption(opt) {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
        trigger.setAttribute?.('aria-expanded', 'false');
        const text = cfg.getLabelText ? cfg.getLabelText(opt) : (opt.label || opt.value);
        label.textContent = text;
        label.title = text || '';
        if (linkedSelect) {
          runWithUiHydration(() => {
            linkedSelect.value = opt.value;
          });
        }
        if (cfg.onSelect) cfg.onSelect(opt);
        focusNoScroll(trigger);
      }

      renderList(kw, menuOpts);

      // 键盘导航
      const keyHandler = (e) => {
        if (!hasClass(wrap, 'is-open')) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex <= 0 ? 0 : keyboardFocusIndex - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault?.();
          if (keyboardFocusIndex >= 0 && visibleItems[keyboardFocusIndex]) {
            selectOption(visibleItems[keyboardFocusIndex]);
          } else if (visibleItems.length === 1) {
            selectOption(visibleItems[0]);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault?.();
          clearListScrollTimer();
          clearInputFocusTimer();
          removeClass(wrap, 'is-open');
          trigger.setAttribute?.('aria-expanded', 'false');
          focusNoScroll(trigger);
        }
      };

      if (searchInput) searchInput.addEventListener('keydown', keyHandler);
      menu.addEventListener('keydown', keyHandler);
      wrap._activeKeyHandler = keyHandler;
    }

    let inputFocusTimer = null;
    function clearInputFocusTimer() {
      if (inputFocusTimer) {
        clearTimeout(inputFocusTimer);
        inputFocusTimer = null;
      }
    }

    // 立即预渲染一次菜单内容，避免初次点击或测试环境遇到空白（不触发滚动）
    renderMenu('', { scrollSelected: false });

    function toggleOpen() {
      const isOpen = hasClass(wrap, 'is-open');
      if (!isOpen) {
        closeAllDropdowns(wrap);
        clearInputFocusTimer();

        // 上下空间与左右边缘防裁剪自适应展开方向
        try {
          const rect = trigger.getBoundingClientRect?.() || { bottom: 0, top: 0, left: 0, right: 0, width: 0 };
          const spaceBelow = (typeof window !== 'undefined' ? (window.innerHeight || 800) : 800) - rect.bottom;
          if (spaceBelow < 240 && rect.top > 240) {
            addClass(wrap, 'open-up');
          } else {
            removeClass(wrap, 'open-up');
          }
          const containerEl = wrap.closest?.('#panel, #panel-tokens, #panel-quota, #panel-settings') || null;
          const cRect = containerEl?.getBoundingClientRect?.() || { left: 8, right: (typeof window !== 'undefined' ? (window.innerWidth || 1000) : 1000) - 8 };
          const estW = Math.max(rect.width || 0, cfg.minMenuWidth || 190);
          if (rect.left + estW > cRect.right - 6 && (rect.right - estW) >= cRect.left - 6) {
            addClass(wrap, 'align-right');
          } else {
            removeClass(wrap, 'align-right');
          }
        } catch {
          removeClass(wrap, 'open-up');
          removeClass(wrap, 'align-right');
        }

        addClass(wrap, 'is-open');
        trigger.setAttribute?.('aria-expanded', 'true');
        renderMenu('', { scrollSelected: true });
        inputFocusTimer = setTimeout(() => {
          inputFocusTimer = null;
          if (!hasClass(wrap, 'is-open')) return;
          const input = menu.querySelector ? menu.querySelector('.ag-dropdown-search-input') : null;
          if (input) focusNoScroll(input);
        }, 50);
      } else {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
        trigger.setAttribute?.('aria-expanded', 'false');
      }
    }

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      toggleOpen();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault?.();
        if (hasClass(wrap, 'is-open') && e.key === 'Enter' && typeof wrap._activeKeyHandler === 'function') {
          wrap._activeKeyHandler(e);
        } else {
          toggleOpen();
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hasClass(wrap, 'is-open')) {
          e.preventDefault?.();
          toggleOpen();
        }
        if (typeof wrap._activeKeyHandler === 'function') {
          wrap._activeKeyHandler(e);
        }
      } else if (e.key === 'Escape') {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
        trigger.setAttribute?.('aria-expanded', 'false');
      }
    });

    const controller = {
      refresh: () => {
        const val = cfg.getSelectedValue();
        const opts = cfg.getOptions();
        const found = opts.find(o => !o.isGroupHeader && o.value === val);
        const nextText = found
          ? (cfg.getLabelText ? cfg.getLabelText(found) : (found.label || found.value))
          : (typeof cfg.emptyLabel === 'function' ? cfg.emptyLabel() : cfg.emptyLabel);
        if (nextText != null && label.textContent !== nextText) {
          label.textContent = nextText;
        }
        label.title = label.textContent || '';
        const nextAria = cfg.getAriaLabel ? cfg.getAriaLabel() : (linkedSelect?.getAttribute?.('aria-label') || cfg.ariaLabel);
        if (nextAria) trigger.setAttribute?.('aria-label', nextAria);
        // 关闭态仅在选项结构/选中项变化时静态同步菜单（scrollSelected: false 绝不触发滚动），避免轮询无意义重建或抢滚动
        if (!hasClass(wrap, 'is-open')) {
          const langTag = typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : 'zh-CN';
          const optsSig = `${langTag}|${val || ''}|` + opts.map(o => `${o.value || ''}:${o.label || ''}:${o.displayRight || ''}:${o.badgeText || ''}:${o.isGroupHeader ? 1 : 0}`).join(';');
          if (optsSig !== lastClosedMenuSig) {
            lastClosedMenuSig = optsSig;
            renderMenu('', { scrollSelected: false });
          }
        }
      },
      isOpen: () => hasClass(wrap, 'is-open'),
      updateItemsInPlace: (updater) => {
        if (typeof updater !== 'function') return;
        for (const [val, entry] of renderedItemMap.entries()) {
          updater(val, entry.itemEl, entry.extraEl);
        }
      },
      close: () => {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
        trigger.setAttribute?.('aria-expanded', 'false');
      },
      open: () => toggleOpen(),
      wrap
    };
    wrap._controller = controller;
    return controller;
  }

  function formatOptionLabelByLang(opt) {
    if (!opt) return '';
    if (currentPanelLanguage === 'en') {
      if (opt.labelEn) return opt.labelEn;
      if (opt.code && opt.symbol) return `${opt.code} (${opt.symbol}${opt.nameEn ? ' ' + opt.nameEn : ''})`;
      if (opt.value && opt.value !== '未知') {
        const flagMatch = String(opt.label || '').match(/^([\u{1F1E6}-\u{1F1FF}]{2}|🌐|🌏)\s*/u);
        const flag = flagMatch ? flagMatch[1] + ' ' : '';
        return `${flag}${opt.code || opt.value}`;
      }
      return t('plan.country.auto');
    }
    if (currentPanelLanguage === 'zh-TW') {
      if (opt.labelTw) return opt.labelTw;
    }
    return opt.label;
  }

  const PLAN_TIER_OPTIONS = [
    { value: 'auto', label: '✨ 自动检测 (Auto-detect)', labelZh: '✨ 自动检测 (Auto-detect)', labelTw: '✨ 自動檢測 (Auto-detect)', labelEn: '✨ Auto-detect' },
    { value: 'free', label: 'Free (免费版)', labelZh: 'Free (免费版)', labelTw: 'Free (免費版)', labelEn: 'Free' },
    { value: 'pro', label: 'Google AI Pro', labelZh: 'Google AI Pro', labelTw: 'Google AI Pro', labelEn: 'Google AI Pro' },
    { value: 'ultra', label: 'Google AI Ultra', labelZh: 'Google AI Ultra', labelTw: 'Google AI Ultra', labelEn: 'Google AI Ultra' },
    { value: 'ultra_5x', label: 'Google AI Ultra (5x)', labelZh: 'Google AI Ultra (5x)', labelTw: 'Google AI Ultra (5x)', labelEn: 'Google AI Ultra (5x)' },
    { value: 'ultra_20x', label: 'Google AI Ultra (20x)', labelZh: 'Google AI Ultra (20x)', labelTw: 'Google AI Ultra (20x)', labelEn: 'Google AI Ultra (20x)' }
  ];

  // 刷新套餐规格直接选择器显示
  function refreshDirectPlanTierDisplay(currentVal) {
    const label = el('direct-tier-label');
    const tag = el('p-det-tier-tag');
    if (!label) return;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const effectiveCustom = (typeof getStoredCustomPlanSnapshot === 'function') ? getStoredCustomPlanSnapshot(email) : null;
    const override = currentVal || ps.planTierOverride || effectiveCustom?.planTierOverride || 'auto';
    const matched = PLAN_TIER_OPTIONS.find(o => o.value === override);
    if (override && override !== 'auto') {
      label.textContent = matched ? formatOptionLabelByLang(matched) : override;
      if (tag) tag.style.display = 'inline-block';
    } else {
      label.textContent = formatOptionLabelByLang(PLAN_TIER_OPTIONS[0]);
      if (tag) tag.style.display = 'none';
    }
  }

  // 刷新国家直接选择器显示
  function refreshDirectCountryDisplay(currentCountryVal) {
    const label = el('direct-country-label');
    if (!label) return;
    const rawVal = currentCountryVal || ANTIGRAVITY_TOKEN_DATA.planStatus?.country || '';
    const val = (!rawVal || rawVal === '未知' || rawVal === 'Unknown') ? '未知' : String(rawVal).trim();
    const matched = COUNTRY_OPTIONS.find(o => o.value === val || o.label === val || o.labelTw === val || o.labelEn === val)
      || (val !== '未知' ? COUNTRY_OPTIONS.find(o => o.value !== '未知' && localizeRegionDisplayValue(o.value, currentPanelLanguage) === localizeRegionDisplayValue(val, currentPanelLanguage)) : null);
    if (matched) {
      label.textContent = formatOptionLabelByLang(matched);
    } else if (val !== '未知') {
      label.textContent = `🌐 ${localizeRegionDisplayValue(val) || val}`;
    } else {
      label.textContent = t('plan.country.auto');
    }
  }

  // 刷新订阅地区直接选择器显示
  function refreshDirectRegionDisplay(currentRegionText) {
    const directLabel = el('direct-region-label');
    if (!directLabel) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    const reg = currentRegionText || ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知';
    const isUnk = !reg || reg === '未知' || reg === 'Unknown' || String(reg).includes('未在当前会话中获取');
    const matched = !isUnk
      ? (core?.findRegionPreset ? core.findRegionPreset(reg) : presets.find(p => p.id === reg || p.name === reg || p.nameTw === reg || p.nameEn === reg))
      : null;
    if (matched) {
      directLabel.textContent = formatPresetRegionLineParts(matched, currentPanelLanguage).full;
    } else if (!isUnk) {
      directLabel.textContent = '🌏 ' + (localizeRegionDisplayValue(reg) || reg);
    } else {
      directLabel.textContent = t('dropdown.regionUnknownShort');
    }
  }

  // 刷新币种直接选择器显示
  function refreshDirectCurrencyDisplay(currentCurrencyVal) {
    const label = el('direct-currency-label');
    if (!label) return;
    let val = currentCurrencyVal || ANTIGRAVITY_TOKEN_DATA.planStatus?.currency || 'USD';
    if (val === 'NTD') val = 'TWD';
    const matched = CURRENCY_OPTIONS.find(o => o.value === val);
    label.textContent = matched ? formatOptionLabelByLang(matched) : val;
  }

  function renderDirectRegionMenu(filterText = '') {
    const directWrap = el('direct-region-wrap');
    if (directWrap?._controller) {
      directWrap._controller.open();
    }
  }

  // =========================================================================
  // 插件栏设置持久化（币种、国家、订阅地区）与详情面板生命周期管理
  // =========================================================================
  let planDetailExpanded = false;
  let lastSavedCustomPlan = null;
  let lastSaveResult = { ok: true, error: '' };
  let saveFeedbackTimer = null;

  function showPlanSaveFeedback(ok, message) {
    lastSaveResult = { ok: Boolean(ok), error: ok ? '' : (message || t('dropdown.saveFailed')) };
    const fb = el('plan-save-feedback');
    if (!fb) return;
    if (saveFeedbackTimer) {
      clearTimeout(saveFeedbackTimer);
      saveFeedbackTimer = null;
    }
    fb.style.display = 'inline-block';
    fb.style.color = ok ? '#22c55e' : '#ef4444';
    fb.textContent = ok ? (message || t('dropdown.autoSaved')) : t('dropdown.saveFailedDetail', { msg: message || t('dropdown.writeCfgFailed') });
    if (ok) {
      saveFeedbackTimer = setTimeout(() => {
        if (fb) fb.style.display = 'none';
        saveFeedbackTimer = null;
      }, 2800);
    }
  }

  function closeOpenRegionDropdowns() {
    try {
      const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : document;
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => w.classList.remove('is-open'));
    } catch {}
  }

  // 统一控制 AI Pro 详情面板展开与收回（手动按钮、切换预估费用、关闭面板共用同一套清理逻辑）
  function setPlanDetailExpanded(expanded, options = {}) {
    const next = Boolean(expanded) && activeTokenView === 'tokens';
    planDetailExpanded = next;
    const card = el('plan-detail-card');
    const btn = el('btn-plan-detail-toggle');
    const form = el('plan-custom-form');

    if (card) {
      card.style.display = next ? 'block' : 'none';
      card.classList?.toggle?.('is-expanded', next);
      card.setAttribute?.('data-expanded', String(next));
      if (!next) {
        try { card.scrollTop = 0; } catch {}
      }
    }
    if (btn) {
      btn.textContent = next ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      btn.setAttribute?.('aria-expanded', String(next));
    }
    if (!next) {
      if (form) form.style.display = 'none';
      closeOpenRegionDropdowns();
    }
    if (!options.skipReposition) {
      positionFloatingPanels();
    }
    return planDetailExpanded;
  }

  let currentSaveSeq = 0;

  function getStoredCustomPlanSnapshot(email = 'default') {
    if (lastSavedCustomPlan && typeof lastSavedCustomPlan === 'object') {
      return { ...lastSavedCustomPlan };
    }
    try {
      const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
      const raw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const hasExplicitCustomPaid = Boolean(ps.isZeroExtraCost || (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined && ps.actualPricePaid !== ''));
    const pm = (ps.priceMode === 'custom' || ps.priceMode === 'preset')
      ? ps.priceMode
      : (ps.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');
    return {
      accountRegion: (ps.accountRegion && !ps.accountRegion.includes('未知')) ? ps.accountRegion : ((ps.country && !ps.country.includes('未知')) ? ps.country : undefined),
      country: (ps.country && !ps.country.includes('未知')) ? ps.country : undefined,
      subscriptionCountry: (ps.subscriptionCountry && !ps.subscriptionCountry.includes('未知')) ? ps.subscriptionCountry : ((ps.subscriptionRegion && !ps.subscriptionRegion.includes('未知')) ? ps.subscriptionRegion : ((ps.region && !ps.region.includes('未知')) ? ps.region : undefined)),
      subscriptionRegion: (ps.subscriptionRegion && !ps.subscriptionRegion.includes('未知')) ? ps.subscriptionRegion : ((ps.region && !ps.region.includes('未知')) ? ps.region : undefined),
      region: (ps.region && !ps.region.includes('未知')) ? ps.region : undefined,
      subscriptionCurrency: ps.subscriptionCurrency || ps.currency || 'USD',
      currency: ps.currency || 'USD',
      currencySource: ps.currencySource || 'default',
      currencySymbol: ps.currencySymbol || '$',
      actualPricePaid: ps.actualPricePaid ?? null,
      customActualPrice: (pm === 'custom' && ps.actualPricePaid !== null) ? ps.actualPricePaid : (lastSavedCustomPlan?.customActualPrice ?? null),
      priceMode: pm,
      billingCycle: (ps.billingCycle && !ps.billingCycle.includes('未知')) ? ps.billingCycle : '月付',
      acquisitionSource: ps.acquisitionSource || 'normal_paid',
      acquisitionSourceName: ps.acquisitionSourceName || undefined,
      isZeroExtraCost: Boolean(ps.isZeroExtraCost),
      validEndDate: ps.validEndDate || null,
      customNote: ps.customNote || '',
      priceSource: ps.priceSource || (pm === 'preset' ? 'preset_region' : 'custom')
    };
  }

  async function persistSettingsToHost(payload = {}) {
    const thisSeq = ++currentSaveSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = payload.email || ps.email || 'default';
    const customObj = payload.customPlan || null;

    // 保存前检查通信桥接，缺失时返回失败
    const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function';
    const hasLive = typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port);
    if (!hasIpc && !hasLive) {
      showPlanSaveFeedback(false, t('dropdown.noPersistBridge'));
      return { ok: false, error: 'NO_HOST_BRIDGE' };
    }

    try {
      let res = null;
      const savePayload = { ...payload, email, saveSeq: thisSeq };
      if (typeof callBackendWithPriority === 'function') {
        const out = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.saveSettings(savePayload) : null,
          liveRoute: '/save-settings',
          liveBody: savePayload
        });
        res = out.result;
      } else if (hasIpc) {
        res = await window.contextMeterAPI.saveSettings(savePayload);
      } else if (hasLive) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(savePayload)
        });
        if (!resp.ok) {
          showPlanSaveFeedback(false, `HTTP ${resp.status}`);
          return { ok: false, error: `HTTP ${resp.status}` };
        }
        res = await resp.json().catch(() => null);
      }

      // 请求序列检查：若在此保存期间发生更新的操作，丢弃旧回包，避免旧响应乱序覆盖
      if (thisSeq < currentSaveSeq) {
        return { ok: true, superseded: true };
      }

      if (!res || res.ok === false) {
        const errMsg = translateBackendText(res?.error) || t('dropdown.writeCfgFailed');
        showPlanSaveFeedback(false, errMsg);
        return { ok: false, error: errMsg };
      }

      // 宿主落盘确认成功后，才更新内存已保存缓存与全局快照
      if (payload.clearPlan) {
        lastSavedCustomPlan = null;
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = { ok: true, customPlan: null };
        }
        try {
          if (email && email !== 'default') localStorage?.removeItem('ag_custom_plan_' + String(email).toLowerCase());
          localStorage?.removeItem('ag_custom_plan_default');
        } catch {}
      } else {
        const savedPlan = res.customPlan || customObj;
        lastSavedCustomPlan = { ...savedPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = { ok: true, customPlan: { ...savedPlan } };
        }
        try {
          const jsonStr = JSON.stringify(savedPlan);
          if (email && email !== 'default') {
            localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          }
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch {}
      }

      showPlanSaveFeedback(true, t('dropdown.autoSaved'));
      return res;
    } catch (err) {
      if (thisSeq >= currentSaveSeq) {
        showPlanSaveFeedback(false, err?.message || t('dropdown.persistErr'));
      }
      return { ok: false, error: err?.message || t('dropdown.persistErr') };
    }
  }

  function applyCustomPlanObjectLocally(customObj, email = 'default') {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    const cleanLive = rawLive
      ? { ...rawLive, region: '未知', subscriptionRegion: '未知', country: '未知', actualPricePaid: null, regionSource: 'unknown', priceSource: 'unknown' }
      : null;

    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(cleanLive, customObj, { currentEmail: email });
    } else if (customObj) {
      const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      const sym = (core?.CURRENCY_SYMBOLS && customObj.currency) ? (core.CURRENCY_SYMBOLS[customObj.currency] || customObj.currencySymbol || '$') : (customObj.currencySymbol || '$');
      ANTIGRAVITY_TOKEN_DATA.planStatus = {
        ...ps,
        country: customObj.country || ps.country || '未知',
        countrySource: customObj.country ? 'custom' : (ps.countrySource || 'unknown'),
        region: customObj.subscriptionRegion || customObj.region || ps.region || '未知',
        subscriptionRegion: customObj.subscriptionRegion || customObj.region || ps.subscriptionRegion || '未知',
        regionSource: (customObj.subscriptionRegion || customObj.region) ? 'custom' : (ps.regionSource || 'unknown'),
        currency: customObj.currency || ps.currency || 'USD',
        currencySource: customObj.currency ? 'custom' : (ps.currencySource || 'default'),
        currencySymbol: sym,
        actualPricePaid: customObj.actualPricePaid !== undefined ? customObj.actualPricePaid : ps.actualPricePaid,
        priceSource: customObj.priceSource || 'custom'
      };
    }
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
  }

  // 明确切换价格模式：'preset' (跟随订阅国家参考价) 与 'custom' (自定义实付金额)
  function switchPlanPriceMode(newMode) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const targetMode = newMode === 'custom' ? 'custom' : 'preset';

    let customObj = null;
    if (targetMode === 'preset') {
      // 切换为「跟随订阅国家参考价」：实时根据当前订阅国家派生官方参考价与币种
      const currentReg = prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || ps.region || '';
      const matched = core?.findRegionPreset ? core.findRegionPreset(currentReg) : core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.id === currentReg || p.name === currentReg);
      const isUltraTier = ps.tierKey === 'ultra';
      const curCode = matched ? matched.currency : (prevCustom.subscriptionCurrency || prevCustom.currency || 'USD');
      const curSymbol = matched ? matched.symbol : (core?.CURRENCY_SYMBOLS?.[curCode] || '$');
      const paid = (matched && !isUltraTier) ? matched.monthlyPrice : null;

      customObj = {
        ...prevCustom,
        priceMode: 'preset',
        priceSource: (matched && !isUltraTier) ? 'preset_region' : 'unknown',
        actualPricePaid: paid,
        subscriptionCurrency: curCode,
        currency: curCode,
        currencySource: matched ? 'preset_region' : (prevCustom.currencySource || 'default'),
        currencySymbol: curSymbol,
        billingCycle: '月付',
        isZeroExtraCost: false,
        updatedAt: new Date().toISOString()
      };
      applyCustomPlanObjectLocally(customObj, email);
      void persistSettingsToHost({ email, customPlan: customObj });
    } else {
      // 切换为「自定义实付金额」：开启自定义模式并展开行内编辑表单
      const isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);
      const paid = isZero ? 0 : (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined ? prevCustom.actualPricePaid : (prevCustom.customActualPrice ?? null));

      customObj = {
        ...prevCustom,
        priceMode: 'custom',
        priceSource: 'custom',
        actualPricePaid: paid,
        customActualPrice: paid,
        updatedAt: new Date().toISOString()
      };
      applyCustomPlanObjectLocally(customObj, email);
      togglePlanCustomForm(true);
      void persistSettingsToHost({ email, customPlan: customObj });
    }
  }

  // 用户点选「订阅国家」：在参考价模式下实时派生价格与币种，在自定义模式下保持用户实付金额与币种
  function applyDirectRegionSelection(regionItem) {
    if (!regionItem) return;
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const localizedName = getLocalizedPresetName(regionItem, currentPanelLanguage).replace(/\s*\(CNY\)\s*$/i, '').trim();
    const regionName = localizedName + ' (' + (regionItem.currency === 'TWD' ? 'NTD' : regionItem.currency) + ')';
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;

    const hasExplicitCustomPaid = Boolean(prevCustom.isZeroExtraCost || (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined && prevCustom.actualPricePaid !== ''));
    const currentPriceMode = (prevCustom.priceMode === 'custom' || prevCustom.priceMode === 'preset')
      ? prevCustom.priceMode
      : (prevCustom.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');

    let curCode = regionItem.currency;
    let curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || regionItem.symbol || '$';
    let paid = null;
    let priceSource = 'preset_region';
    let isZero = false;
    let cycle = '月付';

    if (currentPriceMode === 'custom') {
      // 自定义实付模式：切换国家严格保留用户此前设置的实付金额与币种，绝不静默覆盖！
      isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);
      curCode = prevCustom.subscriptionCurrency || prevCustom.currency || regionItem.currency;
      curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || '$';
      paid = isZero ? 0 : (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined ? prevCustom.actualPricePaid : null);
      priceSource = 'custom';
      cycle = isZero ? '随套餐赠送/免费' : (prevCustom.billingCycle || '月付');
    } else {
      // 跟随订阅国家参考价模式：仅 Pro 等有统一区域参考表时派生价格；Ultra 不套用 Pro 参考价
      const isUltraTier = ps.tierKey === 'ultra';
      curCode = regionItem.currency;
      curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || regionItem.symbol || '$';
      paid = isUltraTier ? null : regionItem.monthlyPrice;
      priceSource = isUltraTier ? 'unknown' : 'preset_region';
      isZero = false;
      cycle = '月付';
    }

    const customObj = {
      ...prevCustom,
      accountRegion: prevCustom.accountRegion || prevCustom.country || undefined,
      country: prevCustom.country || prevCustom.accountRegion || undefined,
      subscriptionCountry: regionName,
      subscriptionRegion: regionName,
      region: regionName,
      acquisitionSource: prevCustom.acquisitionSource || ps.acquisitionSource || 'normal_paid',
      acquisitionSourceName: prevCustom.acquisitionSourceName || ps.acquisitionSourceName || undefined,
      isZeroExtraCost: isZero,
      actualPricePaid: paid,
      customActualPrice: currentPriceMode === 'custom' ? paid : (prevCustom.customActualPrice ?? null),
      priceMode: currentPriceMode,
      subscriptionCurrency: curCode,
      currency: curCode,
      currencySource: currentPriceMode === 'custom' ? 'custom' : 'preset_region',
      currencySymbol: curSymbol,
      billingCycle: isZero ? '随套餐赠送/免费' : cycle,
      priceSource,
      updatedAt: new Date().toISOString()
    };

    refreshDirectRegionDisplay(regionName);
    refreshDirectCurrencyDisplay(curCode);
    applyCustomPlanObjectLocally(customObj, email);

    // 双向同步：更新订阅国家表单及币种（使用纯同步防护守卫，防级联循环）
    runWithUiHydration(() => {
      const directCurSel = el('direct-currency-select');
      if (directCurSel) directCurSel.value = curCode === 'TWD' ? 'TWD' : curCode;
      const form = el('plan-custom-form');
      if (form) {
        const regInput = el('input-custom-region');
        const curSelect = el('select-custom-currency');
        const paidInput = el('input-custom-paid');
        const zeroCheck = el('check-zero-extra');
        if (regInput) regInput.value = localizeRegionDisplayValue(regionName) || regionName;
        if (curSelect) {
          curSelect.value = curCode;
          enhancedDropdowns.get('select-custom-currency')?.refresh?.();
        }
        if (paidInput && !zeroCheck?.checked) {
          paidInput.value = (paid !== null && paid !== undefined) ? paid : '';
        }
        const prevEl = el('region-cny-preview');
        if (prevEl) {
          if (paid !== null && paid !== undefined && Number(paid) > 0) {
            prevEl.textContent = formatSubscriptionSecondaryConversion(paid, curCode, regionItem.name, { perMonth: true, detail: true }) || '';
          } else {
            prevEl.textContent = '';
          }
        }
      }
    });

    void persistSettingsToHost({ email, customPlan: customObj });
  }

  // 用户单独修改「账号所在地区」：仅修改本地记录，绝不影响订阅国家、订阅币种或订阅金额
  function applyDirectCountrySelection(newCountryVal) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const cleanCountry = (newCountryVal && newCountryVal !== '未知' && newCountryVal !== 'Unknown') ? String(newCountryVal).trim() : '';

    const customObj = {
      ...prevCustom,
      accountRegion: cleanCountry || undefined,
      country: cleanCountry || undefined,
      updatedAt: new Date().toISOString()
    };
    if (!cleanCountry) {
      delete customObj.accountRegion;
      delete customObj.country;
    }

    refreshDirectCountryDisplay(cleanCountry || '未知');

    runWithUiHydration(() => {
      const countryInput = el('input-custom-country');
      if (countryInput) countryInput.value = cleanCountry ? (localizeRegionDisplayValue(cleanCountry) || cleanCountry) : '';
      const directCountrySel = el('direct-country-select');
      if (directCountrySel) directCountrySel.value = cleanCountry || '未知';
    });

    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
  }

  // 用户单独修改「订阅币种」：独立更新结算币种与符号，严格保持账号所在地区和订阅国家不变
  function applyDirectCurrencySelection(newCurrencyVal) {
    if (!newCurrencyVal) return;
    ++userActionSeq;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    let curCode = String(newCurrencyVal).trim().toUpperCase();
    if (curCode === 'NTD') curCode = 'TWD';
    const curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || '$';

    refreshDirectCurrencyDisplay(curCode);

    const hasExplicitCustomPaid = Boolean(prevCustom.isZeroExtraCost || (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined && prevCustom.actualPricePaid !== ''));
    const currentPriceMode = (prevCustom.priceMode === 'custom' || prevCustom.priceMode === 'preset')
      ? prevCustom.priceMode
      : (prevCustom.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');
    let paid = prevCustom.actualPricePaid;
    let priceSource = currentPriceMode === 'custom' ? 'custom' : 'preset_region';
    const isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);

    if (isZero) {
      paid = 0;
      priceSource = 'custom';
    } else if (currentPriceMode === 'preset') {
      // 检查新币种在预设库中是否有基准定价
      const matchedNewPreset = core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.currency === curCode);
      if (matchedNewPreset) {
        paid = matchedNewPreset.monthlyPrice;
        priceSource = 'preset_region';
      } else {
        paid = prevCustom.actualPricePaid;
      }
    } else {
      paid = prevCustom.actualPricePaid;
      priceSource = 'custom';
    }

    const customObj = {
      ...prevCustom,
      accountRegion: prevCustom.accountRegion || prevCustom.country || undefined,
      country: prevCustom.country || prevCustom.accountRegion || undefined,
      subscriptionCountry: prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || undefined,
      subscriptionRegion: prevCustom.subscriptionRegion || prevCustom.region || undefined,
      region: prevCustom.subscriptionRegion || prevCustom.region || undefined,
      subscriptionCurrency: curCode,
      currency: curCode,
      currencySource: 'custom',
      currencySymbol: curSymbol,
      actualPricePaid: paid,
      customActualPrice: currentPriceMode === 'custom' ? paid : (prevCustom.customActualPrice ?? null),
      priceMode: currentPriceMode,
      priceSource,
      updatedAt: new Date().toISOString()
    };

    runWithUiHydration(() => {
      const formCurSel = el('select-custom-currency');
      if (formCurSel) {
        formCurSel.value = curCode;
        enhancedDropdowns.get('select-custom-currency')?.refresh?.();
      }
      const directCurSel = el('direct-currency-select');
      if (directCurSel) directCurSel.value = curCode;
      const paidInput = el('input-custom-paid');
      if (paidInput && !isZero) {
        paidInput.value = (paid !== null && paid !== undefined) ? paid : '';
      }
      const prevEl = el('region-cny-preview');
      if (prevEl) {
        if (!isZero && paid !== null && paid !== undefined && Number(paid) > 0) {
          prevEl.textContent = formatSubscriptionSecondaryConversion(paid, curCode, customObj.region, { perMonth: true, detail: true }) || '';
        } else {
          prevEl.textContent = '';
        }
      }
    });

    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
  }

  function applyDirectPlanTierSelection(tierVal) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = (typeof getStoredCustomPlanSnapshot === 'function') ? getStoredCustomPlanSnapshot(email) : null;
    const customObj = {
      ...(prevCustom || {})
    };
    if (tierVal && tierVal !== 'auto') {
      customObj.planTierOverride = tierVal;
    } else {
      delete customObj.planTierOverride;
    }
    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
    refreshDirectPlanTierDisplay(tierVal);
  }

  el('direct-tier-select')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    applyDirectPlanTierSelection(e.target?.value || 'auto');
  });

  function initDirectPlanTierDropdown() {
    return initDropdownController({
      wrapId: 'direct-tier-wrap',
      triggerId: 'direct-tier-trigger',
      labelId: 'direct-tier-label',
      menuId: 'direct-tier-menu',
      selectId: 'direct-tier-select',
      getAriaLabel: () => t('plan.tier.aria'),
      searchPlaceholder: () => t('dropdown.tierSearch'),
      getOptions: () => PLAN_TIER_OPTIONS.map(o => ({ ...o, label: formatOptionLabelByLang(o) })),
      getSelectedValue: () => {
        const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
        const email = ps.email || 'default';
        const effectiveCustom = (typeof getStoredCustomPlanSnapshot === 'function') ? getStoredCustomPlanSnapshot(email) : null;
        return ps.planTierOverride || effectiveCustom?.planTierOverride || 'auto';
      },
      getLabelText: (opt) => formatOptionLabelByLang(opt),
      onSelect: (opt) => {
        applyDirectPlanTierSelection(opt.value);
      },
      emptyText: () => t('dropdown.tierEmpty')
    });
  }

  el('direct-country-select')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    applyDirectCountrySelection(e.target?.value || '');
  });

  el('direct-currency-select')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    applyDirectCurrencySelection(e.target?.value || 'USD');
  });

  // 绑定统一定制「账号所在地区」、「订阅国家」与「订阅币种」下拉组件
  function initDirectCountryDropdown() {
    return initDropdownController({
      wrapId: 'direct-country-wrap',
      triggerId: 'direct-country-trigger',
      labelId: 'direct-country-label',
      menuId: 'direct-country-menu',
      selectId: 'direct-country-select',
      getAriaLabel: () => t('plan.form.countryLabel'),
      searchPlaceholder: () => t('dropdown.countrySearch'),
      getOptions: () => COUNTRY_OPTIONS.map(o => ({ ...o, label: formatOptionLabelByLang(o) })),
      getSelectedValue: () => {
        const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
        return (ps.country && !String(ps.country).includes('未知')) ? String(ps.country).trim() : '未知';
      },
      getLabelText: (opt) => formatOptionLabelByLang(opt),
      onSelect: (opt) => {
        applyDirectCountrySelection(opt.value);
      },
      emptyText: () => t('dropdown.countryEmpty')
    });
  }

  function initDirectRegionDropdown() {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    return initDropdownController({
      wrapId: 'direct-region-wrap',
      triggerId: 'direct-region-trigger',
      labelId: 'direct-region-label',
      menuId: 'direct-region-menu',
      getAriaLabel: () => t('plan.form.regionLabel'),
      searchPlaceholder: () => t('dropdown.regionSearch'),
      getOptions: () => {
        return presets.map(p => {
          const curCode = p.currency === 'TWD' ? 'NTD' : p.currency;
          const parts = formatPresetRegionLineParts(p, currentPanelLanguage);
          return {
            value: p.id,
            rawItem: p,
            label: parts.left,
            displayLeft: parts.left,
            displayRight: parts.right,
            code: p.id,
            currency: curCode,
            aliases: [p.name, p.nameTw, p.nameEn, ...(p.aliases || [])].filter(Boolean)
          };
        });
      },
      getSelectedValue: () => {
        const currentReg = ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '';
        const matched = core?.findRegionPreset ? core.findRegionPreset(currentReg) : presets.find(p => p.id === currentReg || p.name === currentReg);
        return matched ? matched.id : '';
      },
      filterItem: (it, kw) => {
        const curCode = String(it.currency || '').toLowerCase();
        const name = String(it.label || '').toLowerCase();
        const id = String(it.code || '').toLowerCase();
        const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
        return name.includes(kw) || id.includes(kw) || curCode.includes(kw) || aliases.some(a => a.includes(kw));
      },
      getLabelText: (opt) => {
        const p = opt.rawItem;
        if (!p) return opt.label;
        return formatPresetRegionLineParts(p, currentPanelLanguage).full;
      },
      onSelect: (opt) => {
        if (opt.rawItem) applyDirectRegionSelection(opt.rawItem);
      },
      emptyText: () => t('dropdown.regionEmpty')
    });
  }

  function initDirectCurrencyDropdown() {
    return initDropdownController({
      wrapId: 'direct-currency-wrap',
      triggerId: 'direct-currency-trigger',
      labelId: 'direct-currency-label',
      menuId: 'direct-currency-menu',
      selectId: 'direct-currency-select',
      getAriaLabel: () => String(t('plan.dt.currency') || 'Currency').replace(/[：:]\s*$/, ''),
      searchPlaceholder: () => t('dropdown.currencySearch'),
      getOptions: () => CURRENCY_OPTIONS.map(o => ({ ...o, label: formatOptionLabelByLang(o) })),
      getSelectedValue: () => {
        const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
        let cur = ps.currency || 'USD';
        if (cur === 'NTD') cur = 'TWD';
        return cur;
      },
      filterItem: (it, kw) => {
        const name = String(it.name || '').toLowerCase();
        const code = String(it.code || '').toLowerCase();
        const sym = String(it.symbol || '').toLowerCase();
        const label = String(it.label || '').toLowerCase();
        const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
        return name.includes(kw) || code.includes(kw) || sym.includes(kw) || label.includes(kw) || aliases.some(a => a.includes(kw));
      },
      getLabelText: (opt) => formatOptionLabelByLang(opt),
      onSelect: (opt) => {
        applyDirectCurrencySelection(opt.value);
      },
      emptyText: () => t('dropdown.currencyEmpty')
    });
  }

  // 立即触发初始化四大原生定制下拉
  initDirectPlanTierDropdown();
  initDirectCountryDropdown();
  initDirectRegionDropdown();
  initDirectCurrencyDropdown();

  // 全局点击外部关闭所有下拉
  if (typeof shadow !== 'undefined' && shadow && shadow.addEventListener) {
    shadow.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }

  // 套餐详情卡片展开与收回（统一单入口 #btn-plan-detail-toggle 与底部 #btn-plan-detail-collapse）
  el('btn-plan-detail-toggle')?.addEventListener('click', () => {
    const card = el('plan-detail-card');
    const currentlyHidden = !card || card.style.display === 'none' || !card.style.display;
    setPlanDetailExpanded(currentlyHidden);
  });
  el('btn-plan-detail-collapse')?.addEventListener('click', () => {
    setPlanDetailExpanded(false);
  });

  // 统一基于 initDropdownController 将原生 <select> 改造为高端自定义下拉组件（全界面风格与交互 100% 一致）
  const enhancedDropdowns = new Map();
  const NATIVE_DROPDOWN_SPECS = [
    { selectId: 'token-account-select', wrapId: 'token-account-dropdown-wrap', triggerId: 'token-account-dropdown-trigger', labelId: 'token-account-dropdown-label', menuId: 'token-account-dropdown-menu', compact: true },
    { selectId: 'select-custom-acq', wrapId: 'select-custom-acq-dropdown-wrap', triggerId: 'select-custom-acq-dropdown-trigger', labelId: 'select-custom-acq-dropdown-label', menuId: 'select-custom-acq-dropdown-menu', compact: true },
    { selectId: 'select-custom-region-preset', wrapId: 'select-custom-region-preset-dropdown-wrap', triggerId: 'select-custom-region-preset-dropdown-trigger', labelId: 'select-custom-region-preset-dropdown-label', menuId: 'select-custom-region-preset-dropdown-menu', compact: true, searchable: true },
    { selectId: 'select-custom-currency', wrapId: 'select-custom-currency-dropdown-wrap', triggerId: 'select-custom-currency-dropdown-trigger', labelId: 'select-custom-currency-dropdown-label', menuId: 'select-custom-currency-dropdown-menu', compact: true, searchable: true, minMenuWidth: 130 },
    { selectId: 'select-custom-cycle', wrapId: 'select-custom-cycle-dropdown-wrap', triggerId: 'select-custom-cycle-dropdown-trigger', labelId: 'select-custom-cycle-dropdown-label', menuId: 'select-custom-cycle-dropdown-menu', compact: true },
    { selectId: 'sel-auto-switch-pool', wrapId: 'sel-auto-switch-pool-dropdown-wrap', triggerId: 'sel-auto-switch-pool-dropdown-trigger', labelId: 'sel-auto-switch-pool-dropdown-label', menuId: 'sel-auto-switch-pool-dropdown-menu', compact: true },
    { selectId: 'sel-auto-switch-mode', wrapId: 'sel-auto-switch-mode-dropdown-wrap', triggerId: 'sel-auto-switch-mode-dropdown-trigger', labelId: 'sel-auto-switch-mode-dropdown-label', menuId: 'sel-auto-switch-mode-dropdown-menu', compact: true },
    { selectId: 'sel-auto-switch-window', wrapId: 'sel-auto-switch-window-dropdown-wrap', triggerId: 'sel-auto-switch-window-dropdown-trigger', labelId: 'sel-auto-switch-window-dropdown-label', menuId: 'sel-auto-switch-window-dropdown-menu', compact: true }
  ];

  function initNativeSelectDropdown(selectId, opts = {}) {
    const sel = el(selectId);
    if (!sel) return null;
    if (enhancedDropdowns.has(selectId)) {
      const existing = enhancedDropdowns.get(selectId);
      existing?.refresh?.();
      return existing;
    }

    if (sel.style) sel.style.display = 'none';
    sel.setAttribute?.('aria-hidden', 'true');
    sel.setAttribute?.('tabindex', '-1');

    const preset = NATIVE_DROPDOWN_SPECS.find(s => s.selectId === selectId) || {};
    const wrapId = opts.wrapId || preset.wrapId || `${selectId}-dropdown-wrap`;
    const triggerId = opts.triggerId || preset.triggerId || `${selectId}-dropdown-trigger`;
    const labelId = opts.labelId || preset.labelId || `${selectId}-dropdown-label`;
    const menuId = opts.menuId || preset.menuId || `${selectId}-dropdown-menu`;

    let wrap = el(wrapId);
    if (!wrap && sel.parentNode && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      wrap = document.createElement('div');
      wrap.id = wrapId;
      wrap.className = `ag-dropdown-wrapper${opts.compact !== false && preset.compact !== false ? ' ag-dropdown-compact' : ''}`;
      wrap.setAttribute?.('data-target-select', selectId);

      const trigger = document.createElement('div');
      trigger.id = triggerId;
      trigger.className = 'ag-dropdown-trigger';
      trigger.setAttribute?.('tabindex', '0');

      const label = document.createElement('span');
      label.id = labelId;
      label.className = 'ag-dropdown-label';

      const arrow = document.createElement('div');
      arrow.className = 'ag-dropdown-arrow';
      arrow.innerHTML = '<svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>';

      trigger.appendChild?.(label);
      trigger.appendChild?.(arrow);
      wrap.appendChild?.(trigger);

      const menu = document.createElement('div');
      menu.id = menuId;
      menu.className = 'ag-dropdown-menu';
      wrap.appendChild?.(menu);

      sel.parentNode.insertBefore?.(wrap, sel.nextSibling);
    }

    if (!wrap || !el(triggerId) || !el(labelId) || !el(menuId)) {
      return null;
    }

    wrap.setAttribute?.('data-target-select', selectId);
    const controller = initDropdownController({
      wrapId,
      triggerId,
      labelId,
      menuId,
      selectId,
      searchable: opts.searchable ?? preset.searchable,
      minMenuWidth: opts.minMenuWidth ?? preset.minMenuWidth,
      ariaLabel: sel.getAttribute?.('aria-label') || opts.ariaLabel || '',
      getAriaLabel: () => sel.getAttribute?.('aria-label') || opts.ariaLabel || '',
      emptyLabel: () => (sel.selectedOptions?.[0]?.textContent || sel.options?.[0]?.textContent || ''),
      getSelectedValue: () => sel.value || '',
      getOptions: () => Array.from(sel.options || []).map(o => {
        const rawText = String(o.textContent || o.text || o.value || '').trim();
        const dotIdx = rawText.indexOf(' · ');
        return {
          value: o.value,
          label: rawText,
          displayLeft: dotIdx > 0 ? rawText.slice(0, dotIdx) : rawText,
          displayRight: dotIdx > 0 ? rawText.slice(dotIdx + 3) : '',
          tooltip: rawText
        };
      }),
      onSelect: (opt) => {
        sel.value = opt.value;
        if (typeof Event !== 'undefined') sel.dispatchEvent?.(new Event('change', { bubbles: true }));
        else sel.dispatchEvent?.({ type: 'change', target: sel });
      }
    });

    if (controller) {
      if (!sel._dropdownSyncBound) {
        sel._dropdownSyncBound = true;
        sel.addEventListener?.('change', () => controller.refresh());
      }
      controller.refresh();
      enhancedDropdowns.set(selectId, controller);
    }
    return controller;
  }

  function enhanceCustomSelect(selectId) {
    return initNativeSelectDropdown(selectId);
  }

  function syncAllNativeSelectDropdowns() {
    for (const spec of NATIVE_DROPDOWN_SPECS) {
      const ctrl = enhancedDropdowns.get(spec.selectId) || initNativeSelectDropdown(spec.selectId, spec);
      ctrl?.refresh?.();
    }
    for (const wrapId of ['direct-country-wrap', 'direct-region-wrap', 'direct-currency-wrap', 'direct-tier-wrap']) {
      el(wrapId)?._controller?.refresh?.();
    }
  }

  syncAllNativeSelectDropdowns();

  // 点击外部自动收起下拉浮层（closeAllDropdowns 同步更新 aria-expanded）
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      try {
        if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
          closeAllDropdowns();
        }
      } catch {}
    });
  }

  function updateRegionCnyPreviewFromForm() {
    const prevEl = el('region-cny-preview');
    if (!prevEl) return;
    const isZero = Boolean(el('check-zero-extra')?.checked);
    const rawPaidVal = el('input-custom-paid')?.value;
    const rawPaid = (rawPaidVal !== undefined && rawPaidVal !== null) ? String(rawPaidVal).trim() : '';
    const paid = isZero ? 0 : (rawPaid !== '' && !Number.isNaN(Number(rawPaid)) ? Number(rawPaid) : null);
    const cur = el('select-custom-currency')?.value || 'USD';
    const regVal = el('input-custom-region')?.value;
    const reg = (regVal !== undefined && regVal !== null) ? String(regVal).trim() : '';
    if (isZero || paid === null || paid <= 0) {
      prevEl.textContent = '';
      return;
    }
    prevEl.textContent = formatSubscriptionSecondaryConversion(paid, cur, reg, { perMonth: true, detail: true }) || '';
  }

  function normalizeBillingCycleValue(rawCycle) {
    if (!rawCycle) return '';
    const cleaned = String(rawCycle).replace(/[（(].*[）)]/g, '').trim();
    if (!cleaned || cleaned === '未知' || cleaned === 'Unknown') return '';
    if (cleaned === '月付' || cleaned === '月繳' || cleaned === 'Monthly' || cleaned === 'monthly') return '月付';
    if (cleaned === '年付' || cleaned === '年繳' || cleaned === 'Yearly' || cleaned === 'yearly') return '年付';
    if (cleaned === '免费/赠送' || cleaned === '免費/贈送' || cleaned === 'Free / Promo' || cleaned === '随套餐赠送/免费') return '免费/赠送';
    if (cleaned === '随套餐包含' || cleaned === '隨方案包含' || cleaned === 'Included in bundle') return '随套餐包含';
    if (cleaned === '其他周期' || cleaned === '其他週期' || cleaned === 'Other cycle') return '其他周期';
    return cleaned;
  }

  const DP_EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let validEndDpState = null;

  function formatLocalYmdDate(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function closeValidEndDatePicker() {
    if (!validEndDpState) return;
    validEndDpState.isOpen = false;
    removeClass(validEndDpState.wrap, 'is-open');
    removeClass(validEndDpState.wrap, 'open-up');
    if (validEndDpState.popover) validEndDpState.popover.style.display = 'none';
    validEndDpState.trigger?.setAttribute?.('aria-expanded', 'false');
  }

  function syncValidEndDatePickerLabel() {
    const labelEl = el('valid-end-label');
    const hiddenEl = el('input-valid-end');
    const triggerEl = el('valid-end-trigger');
    if (triggerEl) triggerEl.setAttribute?.('aria-label', t('datePicker.ariaLabel'));
    if (!labelEl) return;
    const raw = String(hiddenEl?.value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      labelEl.textContent = raw;
      removeClass(labelEl, 'is-placeholder');
    } else {
      labelEl.textContent = t('datePicker.placeholder');
      addClass(labelEl, 'is-placeholder');
    }
  }

  function refreshValidEndDatePicker() {
    syncValidEndDatePickerLabel();
    if (validEndDpState?.isOpen) {
      validEndDpState.renderCalendar();
    }
  }

  function initValidEndDatePicker() {
    const wrap = el('valid-end-picker-wrap');
    const trigger = el('valid-end-trigger');
    const popover = el('valid-end-popover');
    const hiddenInput = el('input-valid-end');
    if (!wrap || !trigger || !popover || !hiddenInput) return null;
    if (trigger._dpBound) {
      refreshValidEndDatePicker();
      return validEndDpState;
    }
    trigger._dpBound = true;

    const now = new Date();
    validEndDpState = {
      wrap,
      trigger,
      popover,
      hiddenInput,
      isOpen: false,
      viewYear: now.getFullYear(),
      viewMonth: now.getMonth(),
      renderCalendar: () => {}
    };

    const dispatchHiddenChange = () => {
      if (typeof Event !== 'undefined') hiddenInput.dispatchEvent?.(new Event('change', { bubbles: true }));
      else hiddenInput.dispatchEvent?.({ type: 'change', target: hiddenInput });
    };

    const commitDateValue = (ymd) => {
      hiddenInput.value = ymd || '';
      syncValidEndDatePickerLabel();
      dispatchHiddenChange();
      closeValidEndDatePicker();
    };

    const renderCalendar = () => {
      const y = validEndDpState.viewYear;
      const m = validEndDpState.viewMonth;
      const todayYmd = formatLocalYmdDate(new Date());
      const selRaw = String(hiddenInput.value || '').trim();
      const selectedYmd = /^\d{4}-\d{2}-\d{2}$/.test(selRaw) ? selRaw : '';

      if (typeof popover.replaceChildren === 'function') popover.replaceChildren();
      else popover.innerHTML = '';

      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;

      const header = document.createElement('div');
      header.className = 'ag-dp-header';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'ag-dp-nav-btn';
      prevBtn.textContent = '‹';
      prevBtn.setAttribute('aria-label', t('datePicker.prevMonth'));
      prevBtn.title = t('datePicker.prevMonth');
      prevBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        if (validEndDpState.viewMonth === 0) {
          validEndDpState.viewMonth = 11;
          validEndDpState.viewYear -= 1;
        } else {
          validEndDpState.viewMonth -= 1;
        }
        renderCalendar();
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'ag-dp-month-title';
      titleSpan.textContent = t('datePicker.monthTitle', { y, m: m + 1, monthEn: DP_EN_MONTHS[m] });

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'ag-dp-nav-btn';
      nextBtn.textContent = '›';
      nextBtn.setAttribute('aria-label', t('datePicker.nextMonth'));
      nextBtn.title = t('datePicker.nextMonth');
      nextBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        if (validEndDpState.viewMonth === 11) {
          validEndDpState.viewMonth = 0;
          validEndDpState.viewYear += 1;
        } else {
          validEndDpState.viewMonth += 1;
        }
        renderCalendar();
      });

      header.appendChild(prevBtn);
      header.appendChild(titleSpan);
      header.appendChild(nextBtn);
      popover.appendChild(header);

      const weekdaysRow = document.createElement('div');
      weekdaysRow.className = 'ag-dp-weekdays';
      const wkLabels = String(t('datePicker.weekdays')).split(',');
      for (const wk of wkLabels) {
        const wCell = document.createElement('div');
        wCell.className = 'ag-dp-weekday';
        wCell.textContent = wk;
        weekdaysRow.appendChild(wCell);
      }
      popover.appendChild(weekdaysRow);

      const grid = document.createElement('div');
      grid.className = 'ag-dp-grid';
      const firstDow = new Date(y, m, 1).getDay();
      for (let i = 0; i < 42; i++) {
        const cellDate = new Date(y, m, 1 - firstDow + i);
        const ymd = formatLocalYmdDate(cellDate);
        const inCurMonth = cellDate.getMonth() === m && cellDate.getFullYear() === y;
        const btn = document.createElement('button');
        btn.type = 'button';
        let cls = 'ag-dp-day';
        if (!inCurMonth) cls += ' is-outside';
        if (ymd === todayYmd) cls += ' is-today';
        if (ymd === selectedYmd) cls += ' is-selected';
        btn.className = cls;
        btn.setAttribute('data-date', ymd);
        btn.setAttribute('aria-label', ymd);
        btn.textContent = String(cellDate.getDate());
        btn.addEventListener('click', (e) => {
          e?.stopPropagation?.();
          commitDateValue(ymd);
        });
        grid.appendChild(btn);
      }
      popover.appendChild(grid);

      const footer = document.createElement('div');
      footer.className = 'ag-dp-footer';

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'ag-dp-action-btn';
      clearBtn.setAttribute('data-dp-action', 'clear');
      clearBtn.textContent = t('datePicker.clear');
      clearBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        commitDateValue('');
      });

      const todayBtn = document.createElement('button');
      todayBtn.type = 'button';
      todayBtn.className = 'ag-dp-action-btn is-today-btn';
      todayBtn.setAttribute('data-dp-action', 'today');
      todayBtn.textContent = t('datePicker.today');
      todayBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        const tNow = new Date();
        validEndDpState.viewYear = tNow.getFullYear();
        validEndDpState.viewMonth = tNow.getMonth();
        commitDateValue(formatLocalYmdDate(tNow));
      });

      footer.appendChild(clearBtn);
      footer.appendChild(todayBtn);
      popover.appendChild(footer);
    };

    validEndDpState.renderCalendar = renderCalendar;

    const openPicker = () => {
      closeAllDropdowns(wrap);
      const curVal = String(hiddenInput.value || '').trim();
      const m = curVal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        validEndDpState.viewYear = Number(m[1]);
        validEndDpState.viewMonth = Math.max(0, Math.min(11, Number(m[2]) - 1));
      } else {
        const curNow = new Date();
        validEndDpState.viewYear = curNow.getFullYear();
        validEndDpState.viewMonth = curNow.getMonth();
      }
      renderCalendar();
      validEndDpState.isOpen = true;
      addClass(wrap, 'is-open');
      try {
        const tRect = trigger.getBoundingClientRect?.();
        if (tRect && typeof window !== 'undefined' && window.innerHeight && tRect.bottom + 240 > window.innerHeight && tRect.top > 240) {
          addClass(wrap, 'open-up');
        } else {
          removeClass(wrap, 'open-up');
        }
      } catch {}
      popover.style.display = 'block';
      trigger.setAttribute?.('aria-expanded', 'true');
    };

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      if (validEndDpState.isOpen) closeValidEndDatePicker();
      else openPicker();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (validEndDpState.isOpen) closeValidEndDatePicker();
        else openPicker();
      } else if (e.key === 'Escape' && validEndDpState.isOpen) {
        e.preventDefault();
        closeValidEndDatePicker();
      }
    });

    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeValidEndDatePicker();
        trigger.focus?.();
      }
    });

    popover.addEventListener('click', (e) => {
      e?.stopPropagation?.();
    });

    syncValidEndDatePickerLabel();
    return validEndDpState;
  }

  initValidEndDatePicker();

  // 就地行内自定义订阅表单交互（实际读取优先于手填，支持官方依据活动来源）
  function togglePlanCustomForm(forceOpen) {
    const form = el('plan-custom-form');
    if (!form) return;
    const curHidden = form.style.display === 'none' || !form.style.display;
    const next = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    form.style.display = next ? 'block' : 'none';
    if (!next) {
      closeValidEndDatePicker();
    }
    if (next) {
      const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      const acqSelect = el('select-custom-acq');
      const acqNameInput = el('input-custom-acq-name');
      const zeroCheck = el('check-zero-extra');
      const countryInput = el('input-custom-country');
      const regInput = el('input-custom-region');
      const paidInput = el('input-custom-paid');
      const curSelect = el('select-custom-currency');
      const cycleSelect = el('select-custom-cycle');
      const validEndInput = el('input-valid-end');
      const noteInput = el('input-custom-note');

      runWithUiHydration(() => {
        if (acqSelect && ps.acquisitionSource) acqSelect.value = ps.acquisitionSource;
        if (acqNameInput) acqNameInput.value = (ps.acquisitionSourceName && ps.acquisitionSourceName !== '正常付费订阅') ? ps.acquisitionSourceName : '';
        if (zeroCheck) zeroCheck.checked = Boolean(ps.isZeroExtraCost || ps.actualPricePaid === 0);
        if (countryInput) {
          const cVal = (ps.country && !String(ps.country).includes('未知') && ps.country !== 'Unknown') ? ps.country : '';
          countryInput.value = cVal ? (localizeRegionDisplayValue(cVal) || cVal) : '';
        }
        if (regInput) {
          const rVal = (ps.region && !String(ps.region).includes('未知') && ps.region !== 'Unknown') ? ps.region : '';
          regInput.value = rVal ? (localizeRegionDisplayValue(rVal) || rVal) : '';
        }
        if (paidInput) {
          paidInput.value = (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) ? ps.actualPricePaid : (zeroCheck?.checked ? '0' : '');
          paidInput.disabled = Boolean(zeroCheck?.checked);
        }
        if (curSelect && ps.currency) curSelect.value = ps.currency;
        if (cycleSelect && ps.billingCycle) {
          const normCycle = normalizeBillingCycleValue(ps.billingCycle);
          if (normCycle) cycleSelect.value = normCycle;
        }
        if (validEndInput) validEndInput.value = ps.validEndDate || '';
        initValidEndDatePicker();
        refreshValidEndDatePicker();
        if (noteInput) noteInput.value = ps.customNote || '';
        updateRegionCnyPreviewFromForm();
        ['select-custom-acq', 'select-custom-region-preset', 'select-custom-currency', 'select-custom-cycle'].forEach(id => enhanceCustomSelect(id));
      });
      regInput?.focus?.();
    }
    positionFloatingPanels();
  }

  el('input-custom-paid')?.addEventListener('input', () => {
    if (!isHydratingUiControls) updateRegionCnyPreviewFromForm();
  });
  el('select-custom-currency')?.addEventListener('change', () => {
    if (!isHydratingUiControls) updateRegionCnyPreviewFromForm();
  });
  el('input-custom-region')?.addEventListener('input', () => {
    if (!isHydratingUiControls) updateRegionCnyPreviewFromForm();
  });

  el('select-custom-region-preset')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const presetId = e.target?.value || '';
    if (!presetId || presetId === 'custom') return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const matched = core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.id === presetId);
    if (matched) {
      applyDirectRegionSelection(matched);
    }
  });

  el('check-zero-extra')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const paidInput = el('input-custom-paid');
    if (e.target.checked) {
      if (paidInput) {
        paidInput.value = '0';
        paidInput.disabled = true;
      }
    } else {
      if (paidInput) {
        paidInput.disabled = false;
        if (paidInput.value === '0') paidInput.value = '';
      }
    }
    updateRegionCnyPreviewFromForm();
  });

  el('select-custom-acq')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const val = e.target.value;
    const zeroCheck = el('check-zero-extra');
    const paidInput = el('input-custom-paid');
    const cycleSelect = el('select-custom-cycle');
    const freeBundlePresets = ['student_offer', 'pixel_bundle', 'chromebook_bundle', 'samsung_galaxy', 'jio_offer', 'official_promo'];
    if (freeBundlePresets.includes(val)) {
      if (zeroCheck) zeroCheck.checked = true;
      if (paidInput) {
        paidInput.value = '0';
        paidInput.disabled = true;
      }
      if (cycleSelect) cycleSelect.value = '免费/赠送';
    } else if (val === 'normal_paid') {
      if (zeroCheck) zeroCheck.checked = false;
      if (paidInput) {
        paidInput.disabled = false;
        const curTierKey = ANTIGRAVITY_TOKEN_DATA?.planStatus?.tierKey;
        if ((!paidInput.value || paidInput.value === '0') && curTierKey !== 'ultra') paidInput.value = '19.99';
      }
      if (cycleSelect) {
        cycleSelect.value = '月付';
        enhancedDropdowns.get('select-custom-cycle')?.refresh?.();
      }
    }
    enhancedDropdowns.get('select-custom-acq')?.refresh?.();
    enhancedDropdowns.get('select-custom-cycle')?.refresh?.();
  });

  el('btn-mode-preset')?.addEventListener('click', () => switchPlanPriceMode('preset'));
  el('btn-mode-custom')?.addEventListener('click', () => switchPlanPriceMode('custom'));
  el('btn-edit-plan-custom')?.addEventListener('click', () => togglePlanCustomForm());
  el('btn-custom-plan-cancel')?.addEventListener('click', () => togglePlanCustomForm(false));

  el('btn-custom-plan-save')?.addEventListener('click', () => {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const acq = el('select-custom-acq')?.value || 'normal_paid';
    const acqName = String(el('input-custom-acq-name')?.value ?? '').trim();
    const isZero = Boolean(el('check-zero-extra')?.checked);
    const countryInputEl = el('input-custom-country');
    const countryVal = countryInputEl ? String(countryInputEl.value ?? '').trim() : (prevCustom.accountRegion || prevCustom.country || '');
    const regInputEl = el('input-custom-region');
    const reg = regInputEl ? String(regInputEl.value ?? '').trim() : (prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || '');
    const rawPaidVal = el('input-custom-paid')?.value;
    const rawPaid = (rawPaidVal !== undefined && rawPaidVal !== null) ? String(rawPaidVal).trim() : '';
    const paid = isZero ? 0 : (rawPaid !== '' && !Number.isNaN(Number(rawPaid)) ? Number(rawPaid) : null);
    const cur = el('select-custom-currency')?.value || prevCustom.subscriptionCurrency || prevCustom.currency || 'USD';
    const cycle = el('select-custom-cycle')?.value || (isZero ? '随套餐赠送/免费' : '月付');
    const validEnd = String(el('input-valid-end')?.value ?? '').trim();
    const note = String(el('input-custom-note')?.value ?? '').trim();

    const customObj = {
      ...prevCustom,
      accountRegion: countryVal || undefined,
      country: countryVal || undefined,
      subscriptionCountry: reg || undefined,
      subscriptionRegion: reg || undefined,
      region: reg || undefined,
      acquisitionSource: acq,
      acquisitionSourceName: acqName || undefined,
      isZeroExtraCost: isZero,
      actualPricePaid: paid,
      customActualPrice: paid,
      priceMode: 'custom',
      subscriptionCurrency: cur,
      currency: cur,
      currencySource: 'custom',
      billingCycle: cycle,
      validEndDate: validEnd || null,
      customNote: note,
      priceSource: 'custom',
      updatedAt: new Date().toISOString()
    };
    if (!countryVal) {
      delete customObj.accountRegion;
      delete customObj.country;
    }
    if (!reg) {
      delete customObj.subscriptionCountry;
      delete customObj.subscriptionRegion;
      delete customObj.region;
    }

    applyCustomPlanObjectLocally(customObj, email);
    togglePlanCustomForm(false);
    void persistSettingsToHost({ email, customPlan: customObj });
  });

  el('btn-custom-plan-clear')?.addEventListener('click', () => {
    ++userActionSeq;
    const validEndInput = el('input-valid-end');
    if (validEndInput) validEndInput.value = '';
    refreshValidEndDatePicker();
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(rawLive, { priceMode: 'preset' }, { currentEmail: email });
    }
    togglePlanCustomForm(false);
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
    void persistSettingsToHost({ email, clearPlan: true });
  });

  let lastBadgePriceState = null;
  let activeBadgeRafId = null;
  let activeBadgeTimerId = null;
  let activeCnyTimerId = null;

