/**
 * 宿主原生设置弹窗融合模块
 * 负责在 Antigravity 原生设置弹窗左侧导航栏紧贴 Browser 项下方单实例挂载 Context Meter 独立设置页，
 * 由受高度约束的单一纵向滚动容器承载原生风格设置 UI，并在切换回宿主原生页时无损还原原生面板.
 * 第三方开源归属声明统一见根目录 THIRD_PARTY_NOTICES.md.
 * @param {Object} deps
 * @returns {Object}
 */
function createHostSettingsController(deps = {}) {
  const {
    t = (k) => k,
    getSnapshot = () => ({}),
    getNativeSettingsSnapshot = null,
    onNativeSettingChange = null,
    onNativeColorChange = null,
    onNativeResetColors = null,
    onNativeAction = null,
    syncThemeTarget = null,
    onCheckUpdate = () => { },
    onApplyUpdate = () => { },
    onRestartHost = () => { },
    onVerifyRuntime = () => { },
    onOpenPluginPanel = () => { },
    onOpenReleasePage = () => { },
    onCopyDiagnostics = null,
    onHostPageActivated = null,
    onHostPageDeactivated = null,
    applyStaticTranslations = null
  } = deps;

  const NAV_ID = 'ag-cm-host-settings-nav';
  const NAV_WRAPPER_ATTR = 'data-ag-hs-nav-wrapper';
  const PAGE_ID = 'ag-cm-host-settings-page';
  const STYLE_ID = 'ag-cm-host-settings-styles';
  const HIDDEN_ATTR = 'data-ag-hs-hidden';
  const controllerToken = typeof Symbol === 'function' ? Symbol('ag-cm-host-settings-ctrl') : `ag_hs_${Date.now()}_${Math.random()}`;

  let disposed = false;
  let observer = null;
  let scanTimer = null;
  let activeModal = null;
  let activeSidebar = null;
  let activeNavList = null;
  let activeSplitRow = null;
  let activeContentPane = null;
  let navItemEl = null;
  let navButtonEl = null;
  let pageEl = null;
  let pageShadow = null;
  let hostSelected = false;
  let savedHiddenNodes = [];
  let savedPageScrollTop = 0;
  let savedNativePaneScrollTop = 0;
  let lastMountDiagnostic = 'not_mounted';
  let activeEnsureTimer = null;
  let activeLateEnsureTimer = null;
  let pendingOpenTimer = null;
  let pendingOpenSeq = 0;
  const boundNavContainers = typeof WeakSet === 'function' ? new WeakSet() : null;

  function setHiddenSafe(node, hidden, origDisplay = '') {
    if (!node) return;
    node.hidden = Boolean(hidden);
    if (!node.style) return;
    if (hidden) {
      if (typeof node.style.setProperty === 'function') {
        node.style.setProperty('display', 'none', 'important');
      } else {
        node.style.display = 'none';
      }
    } else if (typeof node.style.removeProperty === 'function') {
      node.style.removeProperty('display');
      if (origDisplay) node.style.display = origDisplay;
    } else {
      node.style.display = origDisplay || '';
    }
  }

  function ensureStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${NAV_ID} {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        width: 100% !important;
        text-align: left !important;
        cursor: pointer !important;
      }
      #${NAV_ID} > svg,
      #${NAV_ID} > .ag-hs-nav-label {
        pointer-events: none !important;
      }
      #${NAV_ID}[data-active="true"] {
        background: var(--sidebar-secondary, var(--vscode-list-activeSelectionBackground, rgba(119, 72, 207, 0.18))) !important;
        color: var(--vscode-list-activeSelectionForeground, var(--foreground, #f8fafc)) !important;
        font-weight: 600 !important;
      }
      [data-ag-hs-custom-active="true"] button[id^="settings-nav-item-"],
      [data-ag-hs-custom-active="true"] button[data-testid^="settings-nav-item-"],
      [data-ag-hs-custom-active="true"] [role="tab"]:not(#${NAV_ID}),
      [data-ag-hs-custom-active="true"] [data-ag-hs-muted="true"] {
        opacity: 0.72;
        background: transparent !important;
        background-color: transparent !important;
        box-shadow: none !important;
      }
      [data-ag-cm-host-open="true"] [data-ag-cm-split-row="true"] {
        min-height: 0 !important;
      }
      [data-ag-cm-host-open="true"] [data-ag-cm-right-pane="true"] {
        min-height: 0 !important;
        overflow: hidden !important;
      }
      [data-ag-cm-host-open="true"] [data-ag-cm-right-pane="true"] > :not(#${PAGE_ID}):not(button):not([data-testid*="close"]):not([aria-label*="Close" i]):not([aria-label*="关闭"]):not([aria-label*="關閉"]) {
        display: none !important;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${PAGE_ID} {
        display: none;
        position: relative;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        max-height: 100%;
        min-width: 0;
        min-height: 0;
        flex: 1 1 0%;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-gutter: stable;
        padding: 0;
        margin: 0;
        background: transparent;
        color: var(--foreground, #ececef);
        font-family: inherit;
        -webkit-font-smoothing: antialiased;
      }
      [data-ag-cm-host-open="true"] #${PAGE_ID}:not([hidden]) {
        display: block !important;
      }
    `;
    document.head.appendChild(style);
  }

  function isPluginOwnedNode(node) {
    if (!node) return false;
    if (
      node.id === 'ag-context-meter' ||
      node.id === 'ag-context-meter-radial-host' ||
      node.id === 'ag-context-meter-modal-host' ||
      node.id === NAV_ID ||
      node.id === PAGE_ID ||
      node.getAttribute?.(NAV_WRAPPER_ATTR) === 'true'
    ) return true;
    return Boolean(
      typeof node.closest === 'function' &&
      node.closest(`#ag-context-meter, #ag-context-meter-radial-host, #ag-context-meter-modal-host, #${NAV_ID}, #${PAGE_ID}, [${NAV_WRAPPER_ATTR}="true"]`)
    );
  }

  const SETTINGS_NAV_CATEGORY_RE = /\b(general|browser|account|appearance|editor|models?|notifications?|shortcuts?|keybindings?|agents?|privacy|extensions?|plugins?|mcp|billing|language|theme)\b|通用|应用|浏览器|瀏覽器|账号|帳號|账户|帳戶|外观|外觀|模型|通知|快捷键|快捷鍵|隐私|隱私|语言|語言|代理/i;

  function isHostNavTestId(node) {
    if (!node) return false;
    const id = String(node.id || '');
    const tid = String(node.getAttribute?.('data-testid') || '');
    return id.startsWith('settings-nav-item-') || tid.startsWith('settings-nav-item-');
  }

  function getNavButtons(container) {
    if (!container) return [];
    if (typeof container.querySelectorAll === 'function') {
      const explicit = Array.from(container.querySelectorAll('button[id^="settings-nav-item-"], button[data-testid^="settings-nav-item-"]') || [])
        .filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
      if (explicit.length > 0) return explicit;
      const fallback = Array.from(container.querySelectorAll('button, [role="tab"]') || [])
        .filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
      return fallback;
    }
    return Array.from(container.children || []).filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
  }

  function resolveNavRowInList(navList, btn) {
    if (!btn) return null;
    if (!navList) return btn;
    let cur = btn;
    let depth = 0;
    while (cur && cur.parentElement && depth < 6) {
      if (cur.parentElement === navList) return cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return btn;
  }

  function isProtectedNativeNode(node) {
    if (!node) return true;
    if (node.id === PAGE_ID || node.tagName === 'STYLE' || isPluginOwnedNode(node)) return true;
    if (node.tagName === 'BUTTON') return true;
    const testId = String(node.getAttribute?.('data-testid') || '');
    const ariaLbl = String(node.getAttribute?.('aria-label') || '');
    const cls = String(node.className || '');
    if (/close/i.test(testId) || /close|关闭|關閉/i.test(ariaLbl)) return true;
    if (/\bclose\b/i.test(cls) && !node.children?.length) return true;
    return false;
  }

  function findBrowserAnchorButton(navList, explicitBrowserBtn = null) {
    if (explicitBrowserBtn) {
      if (!navList || explicitBrowserBtn.parentElement === navList || navList.contains?.(explicitBrowserBtn)) {
        return explicitBrowserBtn;
      }
    }
    const items = getNavButtons(navList);
    return (
      items.find((b) => b.id === 'settings-nav-item-Browser' || b.getAttribute?.('data-testid') === 'settings-nav-item-Browser') ||
      items.find((b) => /browser|浏览器|瀏覽器/i.test(String(b.textContent || b.id || b.getAttribute?.('data-testid') || ''))) ||
      items[items.length - 1] ||
      null
    );
  }

  function findRealSidebarAndGroup() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    const sidebar = document.querySelector('[data-testid="settings-sidebar"]');
    if (!sidebar || isPluginOwnedNode(sidebar)) return null;
    const listRoot = sidebar.firstElementChild || sidebar;
    const groups = Array.from(listRoot?.children || []).filter((ch) => ch && !isPluginOwnedNode(ch));
    let targetGroup = null;
    let browserBtn = sidebar.querySelector?.('#settings-nav-item-Browser, [data-testid="settings-nav-item-Browser"]') || null;
    if (browserBtn) {
      let cur = browserBtn.parentElement;
      let hop = 0;
      while (cur && hop < 4) {
        if (groups.includes(cur)) {
          targetGroup = cur;
          break;
        }
        cur = cur.parentElement;
        hop += 1;
      }
    }
    if (!targetGroup) {
      targetGroup = groups.find((grp) => {
        const btns = getNavButtons(grp);
        return btns.some((b) => (
          b.id === 'settings-nav-item-Browser' ||
          b.id === 'settings-nav-item-General' ||
          b.getAttribute?.('data-testid') === 'settings-nav-item-Browser' ||
          b.getAttribute?.('data-testid') === 'settings-nav-item-General' ||
          /general|browser|通用|应用|浏览器|瀏覽器/i.test(String(b.textContent || b.id || b.getAttribute?.('data-testid') || ''))
        ));
      }) || groups.find((grp) => getNavButtons(grp).length > 0) || null;
    }
    const navList = targetGroup || listRoot || sidebar;
    if (!browserBtn) browserBtn = findBrowserAnchorButton(navList, null);
    const splitRow = sidebar.closest?.('.relative.flex.w-full.h-full') || sidebar.parentElement || null;
    let rightPane = null;
    if (splitRow) {
      const sibs = Array.from(splitRow.children || []).filter((child) => (
        child &&
        child !== sidebar &&
        !child.contains?.(sidebar) &&
        !isProtectedNativeNode(child)
      ));
      rightPane = sibs.find((child) => (
        child.getAttribute?.('data-settings-content-pane') === 'true'
        || Boolean(child.querySelector?.('[data-settings-content-pane="true"]'))
      )) || sibs.find((child) => {
        const cls = String(child.className || '');
        if (/\bw-px\b|\bw-\[1px\]|\bdivider\b/i.test(cls) && !(child.children && child.children.length)) return false;
        const childCount = child.children ? child.children.length : 0;
        return /\bflex-1\b|\boverflow-y-auto\b|\boverflow-hidden\b/.test(cls) || childCount > 0 || String(child.textContent || '').trim().length > 0;
      }) || sibs[0] || null;
      if (rightPane && rightPane.getAttribute?.('data-settings-content-pane') !== 'true') {
        const innerExplicit = rightPane.querySelector?.('[data-settings-content-pane="true"]');
        if (innerExplicit && !innerExplicit.contains?.(sidebar)) rightPane = innerExplicit;
      }
    }
    const modal = splitRow?.closest?.('.settings-modal-container, [role="dialog"]') || splitRow?.parentElement || splitRow || sidebar;
    if (!rightPane) {
      rightPane = findContentPane(modal, sidebar);
    }
    if (!navList || !rightPane) return null;
    return { modal, sidebar, navList, splitRow, anchorBtn: browserBtn, contentPane: rightPane };
  }

  function findContentPane(modal, navListOrSidebar) {
    if (!modal || !navListOrSidebar) return null;
    if (typeof modal.querySelector === 'function') {
      const explicitPane = modal.querySelector('[data-settings-content-pane="true"], .settings-content-pane');
      if (explicitPane && !explicitPane.contains?.(navListOrSidebar) && explicitPane !== navListOrSidebar) {
        return explicitPane;
      }
    }
    const sidebarHost = (typeof navListOrSidebar.closest === 'function' ? navListOrSidebar.closest('[data-testid="settings-sidebar"]') : null) || navListOrSidebar;
    let cursor = sidebarHost;
    while (cursor && cursor !== modal) {
      const parent = cursor.parentElement;
      if (!parent) break;
      const children = Array.from(parent.children || []).filter(Boolean);
      const siblings = children.filter((child) => (
        child !== cursor &&
        !child.contains?.(sidebarHost) &&
        !isProtectedNativeNode(child)
      ));
      const candidate = siblings.find((child) => {
        if (child.getAttribute?.('data-testid') === 'settings-sidebar') return false;
        const textLen = String(child.textContent || '').trim().length;
        const childCount = child.children ? child.children.length : 0;
        const role = typeof child.getAttribute === 'function' ? child.getAttribute('role') : '';
        return role === 'tabpanel' || childCount > 0 || textLen > 0;
      }) || siblings[0] || null;
      if (candidate) return candidate;
      cursor = parent;
    }
    return null;
  }

  function findHostSettingsTargets() {
    if (typeof document === 'undefined') {
      lastMountDiagnostic = 'no_document';
      return null;
    }
    const realTarget = findRealSidebarAndGroup();
    if (realTarget) {
      lastMountDiagnostic = 'matched_settings_sidebar_splitrow';
      return realTarget;
    }

    const candidates = [];
    if (typeof document.querySelectorAll === 'function') {
      const found = Array.from(document.querySelectorAll('.settings-modal-container, [role="dialog"]') || []);
      for (const n of found) {
        if (n && !isPluginOwnedNode(n) && !candidates.includes(n)) candidates.push(n);
      }
    }
    const browserById = typeof document.querySelector === 'function'
      ? document.querySelector('#settings-nav-item-Browser, [data-testid="settings-nav-item-Browser"]')
      : (typeof document.getElementById === 'function' ? document.getElementById('settings-nav-item-Browser') : null);
    if (browserById && !isPluginOwnedNode(browserById)) {
      const modalFromBrowser = browserById.closest?.('.settings-modal-container, [role="dialog"]') || browserById.parentElement?.parentElement || null;
      if (modalFromBrowser && !candidates.includes(modalFromBrowser)) candidates.unshift(modalFromBrowser);
    }

    for (const modal of candidates) {
      const browserBtn = modal.querySelector?.('#settings-nav-item-Browser, [data-testid="settings-nav-item-Browser"]') || (browserById && (modal.contains?.(browserById) || browserById.parentElement?.parentElement === modal) ? browserById : null);
      const navBtns = getNavButtons(modal);
      if (!browserBtn && navBtns.length === 0) continue;
      const isExplicitSettingsModal = Boolean(
        modal.classList?.contains?.('settings-modal-container') ||
        modal.getAttribute?.('data-testid') === 'settings-modal'
      );
      const explicitNavBtns = navBtns.filter((b) => isHostNavTestId(b));
      const matchedCategoryBtns = navBtns.filter((b) => (
        isHostNavTestId(b) ||
        SETTINGS_NAV_CATEGORY_RE.test(String(b.textContent || b.id || b.getAttribute?.('data-testid') || ''))
      ));
      if (!browserBtn && explicitNavBtns.length === 0) {
        if (isExplicitSettingsModal) {
          if (matchedCategoryBtns.length === 0) continue;
        } else if (matchedCategoryBtns.length < 2) {
          continue;
        }
      }
      let navList = null;
      if (browserBtn) {
        const directParent = browserBtn.parentElement;
        const grandParent = directParent?.parentElement;
        if (grandParent && getNavButtons(grandParent).length > getNavButtons(directParent).length) {
          navList = grandParent;
        } else {
          navList = directParent;
        }
      } else {
        const sampleBtn = explicitNavBtns[0] || matchedCategoryBtns[0];
        if (!sampleBtn) continue;
        const directParent = sampleBtn.parentElement;
        const grandParent = directParent?.parentElement;
        navList = (grandParent && getNavButtons(grandParent).length > getNavButtons(directParent).length)
          ? grandParent
          : directParent;
      }
      if (!navList) continue;
      const anchorBtn = findBrowserAnchorButton(navList, browserBtn);
      const contentPane = findContentPane(modal, navList);
      if (!contentPane) continue;
      lastMountDiagnostic = 'matched_settings_modal_container';
      return { modal, sidebar: null, navList, splitRow: contentPane.parentElement || null, anchorBtn, contentPane };
    }
    lastMountDiagnostic = candidates.length > 0 ? 'host_settings_structure_unrecognized' : 'host_settings_modal_not_open';
    return null;
  }

  function restoreHiddenNativeNodes() {
    if (activeContentPane && activeContentPane.children) {
      for (const child of Array.from(activeContentPane.children)) {
        if (!child || child.id === PAGE_ID) continue;
        if (child.getAttribute?.(HIDDEN_ATTR) !== 'true') continue;
        const saved = savedHiddenNodes.find((item) => item.node === child);
        child.removeAttribute?.(HIDDEN_ATTR);
        setHiddenSafe(child, Boolean(saved?.origHidden), saved?.origDisplay || '');
      }
    }
    for (const entry of savedHiddenNodes) {
      try {
        if (entry?.node?.getAttribute?.(HIDDEN_ATTR) === 'true') {
          entry.node.removeAttribute?.(HIDDEN_ATTR);
          setHiddenSafe(entry.node, Boolean(entry.origHidden), entry.origDisplay || '');
        }
      } catch { }
    }
    savedHiddenNodes = [];
  }

  function hideNativeContentNodes() {
    if (!activeContentPane) return;
    for (const child of Array.from(activeContentPane.children || [])) {
      if (isProtectedNativeNode(child)) continue;
      if (child.getAttribute?.(HIDDEN_ATTR) === 'true') {
        if (!child.hidden) setHiddenSafe(child, true);
        continue;
      }
      const origDisplay = child.style?.getPropertyValue?.('display') || child.style?.display || '';
      const origHidden = Boolean(child.hidden);
      savedHiddenNodes.push({ node: child, origDisplay, origHidden });
      child.setAttribute?.(HIDDEN_ATTR, 'true');
      setHiddenSafe(child, true);
    }
  }

  function clearNavBtnActiveClasses(btn) {
    if (!btn?.classList) return;
    btn.classList.remove('active', 'is-active', 'selected', 'bg-accent', 'bg-ide-input-background', 'bg-sidebar-secondary');
  }

  function syncNavHighlightState(active, opts = {}) {
    const { clickedNativeBtn = null } = opts;
    if (navButtonEl) {
      navButtonEl.setAttribute('data-active', active ? 'true' : 'false');
      navButtonEl.setAttribute('aria-selected', active ? 'true' : 'false');
      if (!active) clearNavBtnActiveClasses(navButtonEl);
    }
    const navScope = activeSidebar || activeModal || activeNavList;
    if (navScope) {
      if (active) navScope.setAttribute?.('data-ag-hs-custom-active', 'true');
      else navScope.removeAttribute?.('data-ag-hs-custom-active');
    }
    if (!navScope) return;
    for (const btn of getNavButtons(navScope)) {
      if (!btn || btn === navButtonEl) continue;
      if (active) {
        btn.setAttribute?.('data-ag-hs-muted', 'true');
        const wasSel = btn.getAttribute?.('aria-selected') === 'true'
          || btn.getAttribute?.('data-active') === 'true'
          || btn.classList?.contains?.('active')
          || btn.classList?.contains?.('bg-accent')
          || btn.classList?.contains?.('bg-sidebar-secondary');
        if (wasSel) {
          btn.setAttribute('data-ag-hs-prev-selected', 'true');
          btn.setAttribute('aria-selected', 'false');
          if (btn.hasAttribute?.('data-active')) btn.setAttribute('data-active', 'false');
        }
      } else {
        btn.removeAttribute?.('data-ag-hs-muted');
        const hadPrev = btn.getAttribute?.('data-ag-hs-prev-selected') === 'true';
        if (hadPrev) {
          btn.removeAttribute('data-ag-hs-prev-selected');
          if (!clickedNativeBtn) {
            btn.setAttribute('aria-selected', 'true');
            if (btn.hasAttribute?.('data-active')) btn.setAttribute('data-active', 'true');
          }
        }
      }
    }
  }

  function getActiveUiRoot() {
    return pageShadow || pageEl;
  }

  function syncThemeToPageHost() {
    if (!pageEl) return;
    if (typeof syncThemeTarget === 'function') {
      try { syncThemeTarget(pageEl); } catch { }
    }
  }

  function scrollToSection(sectionId) {
    if (!sectionId || !pageEl) return false;
    const uiRoot = getActiveUiRoot();
    let target = findElInPage(sectionId);
    if (!target && uiRoot && typeof uiRoot.querySelector === 'function') {
      target = uiRoot.querySelector(`[data-section-id="${sectionId}"]`);
    }
    if (!target) return false;
    try {
      if (sectionId === 'ag-ns-colors-body' || sectionId === 'colors') {
        const colorsBody = findElInPage('ag-ns-colors-body');
        const colorsBtn = findElInPage('ag-ns-toggle-colors');
        if (colorsBody && colorsBody.hidden) {
          colorsBody.hidden = false;
          colorsBtn?.setAttribute?.('aria-expanded', 'true');
        }
      }
      if (typeof pageEl.getBoundingClientRect === 'function' && typeof target.getBoundingClientRect === 'function') {
        const pRect = pageEl.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        if (pRect && tRect && pRect.height > 0) {
          const nextTop = Math.max(0, Math.round((pageEl.scrollTop || 0) + (tRect.top - pRect.top) - 18));
          pageEl.scrollTop = nextTop;
          savedPageScrollTop = nextTop;
          return true;
        }
      }
    } catch { }
    return true;
  }

  function clearPendingOpenWaiter() {
    pendingOpenSeq += 1;
    if (pendingOpenTimer) {
      clearTimeout(pendingOpenTimer);
      pendingOpenTimer = null;
    }
  }

  function verifyHostPagePresented() {
    if (disposed || !hostSelected) return false;
    if (!activeModal || activeModal.isConnected === false) return false;
    if (!activeContentPane || activeContentPane.isConnected === false) return false;
    if (!pageEl || pageEl.isConnected === false || pageEl.hidden) return false;
    if (typeof activeContentPane.contains === 'function' && !activeContentPane.contains(pageEl)) return false;
    if (navButtonEl?.getAttribute?.('data-active') !== 'true') return false;
    if (!findElInPage('ag-ns-root')) return false;
    const unhiddenNative = Array.from(activeContentPane.children || []).some((child) => (
      child && !isProtectedNativeNode(child) && child.getAttribute?.(HIDDEN_ATTR) !== 'true' && !child.hidden
    ));
    if (unhiddenNative) return false;
    return true;
  }

  function deactivateHostPage(opts = {}) {
    clearPendingOpenWaiter();
    if (activeEnsureTimer) {
      clearTimeout(activeEnsureTimer);
      activeEnsureTimer = null;
    }
    if (activeLateEnsureTimer) {
      clearTimeout(activeLateEnsureTimer);
      activeLateEnsureTimer = null;
    }
    if (pageEl && typeof pageEl.scrollTop === 'number') {
      savedPageScrollTop = pageEl.scrollTop;
    }
    hostSelected = false;
    activeModal?.removeAttribute?.('data-ag-cm-host-open');
    activeSplitRow?.removeAttribute?.('data-ag-cm-host-open');
    activeContentPane?.removeAttribute?.('data-ag-cm-host-open');
    if (pageEl) {
      setHiddenSafe(pageEl, true);
    }
    restoreHiddenNativeNodes();
    if (activeContentPane && typeof activeContentPane.scrollTop === 'number' && savedNativePaneScrollTop > 0) {
      activeContentPane.scrollTop = savedNativePaneScrollTop;
    }
    syncNavHighlightState(false, { clickedNativeBtn: opts?.clickedNativeBtn || null });
    try { onHostPageDeactivated?.(); } catch { }
  }

  function applyHostPageActivePresentation() {
    if (!hostSelected || disposed || !activeContentPane) return;
    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== activeContentPane) {
      activeContentPane.appendChild(pageEl);
    }
    activeModal?.setAttribute?.('data-ag-cm-host-open', 'true');
    activeSplitRow?.setAttribute?.('data-ag-cm-split-row', 'true');
    activeContentPane?.setAttribute?.('data-ag-cm-right-pane', 'true');
    activeContentPane?.setAttribute?.('data-ag-cm-host-open', 'true');
    // 防止宿主右栏此前存在滚动偏移导致右上角原生关闭按钮或独立页首屏被顶出视口
    if (typeof activeContentPane.scrollTop === 'number' && activeContentPane.scrollTop !== 0) {
      savedNativePaneScrollTop = activeContentPane.scrollTop;
      activeContentPane.scrollTop = 0;
    }
    hideNativeContentNodes();
    setHiddenSafe(pageEl, false);
    if (savedPageScrollTop > 0 && typeof pageEl.scrollTop === 'number' && pageEl.scrollTop !== savedPageScrollTop) {
      pageEl.scrollTop = savedPageScrollTop;
    }
    syncThemeToPageHost();
    syncNavHighlightState(true);
    renderPage();
  }

  function activateHostPage(opts = {}) {
    clearPendingOpenWaiter();
    const freshTargets = findHostSettingsTargets();
    if (freshTargets) {
      const targetChanged = freshTargets.modal !== activeModal
        || freshTargets.sidebar !== activeSidebar
        || freshTargets.navList !== activeNavList
        || freshTargets.contentPane !== activeContentPane
        || activeContentPane?.isConnected === false;
      if (targetChanged) {
        activeModal = freshTargets.modal;
        activeSidebar = freshTargets.sidebar || null;
        activeNavList = freshTargets.navList;
        activeSplitRow = freshTargets.splitRow || null;
        activeContentPane = freshTargets.contentPane;
        bindNavSwitchHandler(activeModal);
        bindNavSwitchHandler(activeSidebar || activeNavList);
      }
    }
    if (!activeModal || !activeContentPane) return false;
    ensureStyles();
    hostSelected = true;
    applyHostPageActivePresentation();
    if (opts && opts.section) {
      scrollToSection(opts.section);
    } else if (pageEl && savedPageScrollTop > 0 && typeof pageEl.scrollTop === 'number') {
      pageEl.scrollTop = savedPageScrollTop;
    }
    if (typeof Promise === 'function') {
      Promise.resolve().then(() => {
        if (!disposed && hostSelected) {
          syncModalMount();
          applyHostPageActivePresentation();
        }
      });
    }
    if (activeEnsureTimer) clearTimeout(activeEnsureTimer);
    activeEnsureTimer = setTimeout(() => {
      activeEnsureTimer = null;
      if (!disposed && hostSelected) {
        syncModalMount();
        applyHostPageActivePresentation();
      }
    }, 35);
    if (activeLateEnsureTimer) clearTimeout(activeLateEnsureTimer);
    activeLateEnsureTimer = setTimeout(() => {
      activeLateEnsureTimer = null;
      if (!disposed && hostSelected) {
        syncModalMount();
        applyHostPageActivePresentation();
      }
    }, 120);
    try { onHostPageActivated?.({ section: opts?.section || null }); } catch { }
    return verifyHostPagePresented();
  }

  function bindNavButtonEvents(btn) {
    if (!btn || btn.__agHsCtrlToken === controllerToken) return btn;
    btn.__agHsCtrlToken = controllerToken;
    btn.addEventListener?.('click', (e) => {
      if (disposed) return;
      e?.stopPropagation?.();
      e?.preventDefault?.();
      activateHostPage();
    });
    btn.addEventListener?.('keydown', (e) => {
      if (disposed) return;
      const key = e?.key;
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        activateHostPage();
      }
    });
    return btn;
  }

  function createNavButton(anchorBtn) {
    const btn = document.createElement('button');
    btn.id = NAV_ID;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-active', 'false');
    const baseClass = String(anchorBtn?.className || '')
      .replace(/\bbg-sidebar-secondary\b|\bbg-ide-input-background\b|\bbg-accent\b|\bis-active\b|\bactive\b|\bselected\b|\btext-foreground\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    btn.className = baseClass ? `${baseClass} ag-cm-host-nav-item` : 'ag-cm-host-nav-item';
    btn.innerHTML = `
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="pointer-events:none;flex-shrink:0">
        <circle cx="8" cy="8" r="6"></circle>
        <path d="M8 8l3-2.5"></path>
      </svg>
      <span class="ag-hs-nav-label" style="pointer-events:none">Context Meter</span>
    `;
    return bindNavButtonEvents(btn);
  }

  function findElInPage(id) {
    if (!id) return null;
    if (pageShadow) {
      if (typeof pageShadow.getElementById === 'function') {
        const hit = pageShadow.getElementById(id);
        if (hit) return hit;
      }
      if (typeof pageShadow.querySelector === 'function') {
        const hit = pageShadow.querySelector(`#${id}`);
        if (hit) return hit;
      }
    }
    if (!pageEl) return null;
    if (typeof pageEl.querySelector === 'function') {
      const hit = pageEl.querySelector(`#${id}`);
      if (hit) return hit;
    }
    const queue = Array.from(pageEl.children || []);
    while (queue.length) {
      const cur = queue.shift();
      if (!cur) continue;
      if (cur.id === id) return cur;
      if (cur.children && cur.children.length) queue.push(...Array.from(cur.children));
    }
    return null;
  }

  function createPageElement() {
    const wrap = document.createElement('section');
    wrap.id = PAGE_ID;
    wrap.setAttribute('aria-label', 'Context Meter 设置');
    wrap.tabIndex = 0;
    wrap.hidden = true;
    wrap.scrollTop = 0;
    wrap.addEventListener?.('scroll', () => {
      if (hostSelected && typeof wrap.scrollTop === 'number') {
        savedPageScrollTop = wrap.scrollTop;
      }
    }, { passive: true });
    pageShadow = typeof wrap.attachShadow === 'function' ? wrap.attachShadow({ mode: 'open' }) : null;
    const uiTarget = pageShadow || wrap;

    const cssText = typeof buildNativeSettingsPageCss === 'function'
      ? buildNativeSettingsPageCss()
      : ':host { display: block; width: 100%; height: 100%; overflow-y: auto; }';
    const htmlText = typeof buildNativeSettingsPageHtml === 'function'
      ? buildNativeSettingsPageHtml()
      : '<section id="ag-ns-root" class="ag-ns-page"><h1>Context Meter</h1></section>';

    const styleEl = document.createElement('style');
    styleEl.id = 'ag-cm-hs-workspace-style';
    styleEl.textContent = cssText;

    if (pageShadow) {
      const containerWrap = document.createElement('div');
      containerWrap.innerHTML = htmlText;
      pageShadow.appendChild(styleEl);
      const kids = Array.from(containerWrap.children || []);
      if (kids.length > 0) {
        for (const kid of kids) pageShadow.appendChild(kid);
      } else {
        pageShadow.appendChild(containerWrap);
      }
    } else {
      wrap.innerHTML = htmlText;
    }
    pageEl = wrap;

    if (typeof initContextSettingsUI === 'function') {
      initContextSettingsUI(uiTarget, {
        onChange: (key, value, meta) => {
          if (typeof onNativeSettingChange === 'function') {
            onNativeSettingChange(key, value, meta);
          }
        },
        onColorChange: (colorKey, hex) => {
          if (typeof onNativeColorChange === 'function') {
            onNativeColorChange(colorKey, hex);
          }
        },
        onResetColors: () => {
          if (typeof onNativeResetColors === 'function') {
            onNativeResetColors();
          }
        },
        onAction: (actionName, payload) => {
          if (typeof onNativeAction === 'function') {
            onNativeAction(actionName, payload);
            return;
          }
          if (actionName === 'checkUpdate') void onCheckUpdate('host-settings');
          else if (actionName === 'applyUpdate') void onApplyUpdate('host-settings');
          else if (actionName === 'restartHost') void onRestartHost();
          else if (actionName === 'verifyRuntime') void onVerifyRuntime();
          else if (actionName === 'openReleasePage') void onOpenReleasePage();
          else if (actionName === 'openAccountsTab') void onOpenPluginPanel('accounts');
          else if (actionName === 'openQuotaBoard') void onOpenPluginPanel('quota');
          else if (actionName === 'openTokensBoard') void onOpenPluginPanel('tokens');
          else if (actionName === 'copyDiag' && typeof onCopyDiagnostics === 'function') void onCopyDiagnostics();
        }
      });
    }

    return wrap;
  }

  function renderPage() {
    if (!pageEl || disposed) return;
    if (typeof applyStaticTranslations === 'function') {
      try { applyStaticTranslations(getActiveUiRoot()); } catch { }
    }
    const snap = getSnapshot() || {};
    const upd = snap.strictUpdateState || { stage: 'idle' };
    const stage = upd.stage || 'idle';
    const frontendVer = snap.rendererDisplayVersion || snap.rendererVersion || '--';
    const backendVer = snap.backendDisplayVersion || snap.backendVersion || t('hostSettings.notDetected');
    const sourceLabel = snap.backendSource || t('hostSettings.sourceUnknown');
    const pidLabel = snap.backendPid ? `PID ${snap.backendPid}` : '';
    const targetVer = upd.targetVersion ? (snap.formatVersion ? snap.formatVersion(upd.targetVersion) : upd.targetVersion) : frontendVer;

    const setText = (id, text) => {
      const n = findElInPage(id);
      if (n) n.textContent = String(text ?? '');
    };

    if (typeof getNativeSettingsSnapshot === 'function' && typeof renderContextSettingsUI === 'function') {
      const nativeData = getNativeSettingsSnapshot();
      if (nativeData) {
        renderContextSettingsUI(getActiveUiRoot(), nativeData);
      }
    }

    setText('ag-ns-subtitle', t('hostSettings.subtitle'));
    setText('ag-hs-btn-open-accounts', t('tab.accounts'));
    setText('ag-hs-btn-open-quota', t('hostSettings.btn.quota'));
    setText('ag-hs-btn-open-tokens', t('hostSettings.btn.tokens'));
    setText('ag-hs-sec-version', t('hostSettings.sec.version'));
    setText('ag-hs-lbl-frontend', t('hostSettings.lbl.frontend'));
    setText('ag-hs-lbl-backend', t('hostSettings.lbl.backend'));
    setText('ag-hs-lbl-bridge', t('hostSettings.lbl.bridge'));
    setText('ag-hs-lbl-target', t('hostSettings.lbl.target'));
    setText('ag-hs-sec-diag', t('hostSettings.sec.diag'));
    setText('ag-hs-btn-copy-diag', t('hostSettings.btn.copyDiag'));
    setText('ag-hs-btn-verify-runtime', t('hostSettings.btn.verify'));
    setText('ag-hs-btn-release-page', t('update.viewRelease'));

    setText('ag-hs-val-frontend', frontendVer);
    setText('ag-hs-val-backend', `${backendVer}${pidLabel ? ` · ${pidLabel}` : ''}`);
    setText('ag-hs-val-bridge', `${sourceLabel}${snap.backendMismatch ? ` · ${t('hostSettings.versionMismatchShort')}` : ''}`);
    setText('ag-hs-val-target', targetVer);

    const stagePill = findElInPage('ag-hs-update-stage-pill');
    const stageKeyMap = {
      idle: 'hostSettings.stage.idle',
      latest: 'hostSettings.stage.latest',
      checking: 'hostSettings.stage.checking',
      available: 'hostSettings.stage.available',
      downloading: 'hostSettings.stage.downloading',
      downloaded: 'hostSettings.stage.downloaded',
      pending_restart: 'hostSettings.stage.pendingRestart',
      active: 'hostSettings.stage.active',
      error: 'hostSettings.stage.error',
      unavailable: 'hostSettings.stage.unavailable'
    };
    if (stagePill) {
      stagePill.setAttribute('data-stage', stage);
      stagePill.textContent = t(stageKeyMap[stage] || 'hostSettings.stage.idle');
    }

    let detailText = '';
    if (stage === 'unavailable') detailText = t('update.unavailableBody');
    else if (stage === 'checking') detailText = t('update.connecting');
    else if (stage === 'available') detailText = t('update.foundBody', { ver: targetVer, notes: snap.releaseNotes || t('update.defaultNotes') });
    else if (stage === 'downloading') detailText = t('update.downloading');
    else if (stage === 'downloaded') detailText = t('update.doneLiveSynced', { ver: targetVer });
    else if (stage === 'pending_restart') {
      detailText = snap.hostSupportsRestart
        ? t('update.doneDisk', { ver: targetVer })
        : `${t('update.doneDisk', { ver: targetVer })} ${t('client.restart.hostNotSupported')}`;
    } else if (stage === 'active') detailText = t('update.doneHotFull', { ver: targetVer });
    else if (stage === 'error') detailText = t('update.failStatus', { err: snap.errorText || t('msg.unknownErr') });
    else if (stage === 'latest') detailText = t('update.latestBody', { ver: frontendVer });
    else detailText = t('hostSettings.stage.idleHint');
    setText('ag-hs-update-detail', detailText);

    const btnCheck = findElInPage('ag-hs-btn-check-update');
    if (btnCheck) {
      btnCheck.disabled = stage === 'checking' || stage === 'downloading';
      btnCheck.textContent = stage === 'checking' ? t('update.checkingTitle') : t('hostSettings.btn.check');
    }
    const btnApply = findElInPage('ag-hs-btn-apply-update');
    if (btnApply) {
      const showApply = stage === 'available' || (stage === 'error' && Boolean(snap.hasCachedRelease));
      btnApply.hidden = !showApply;
      if (btnApply.style) btnApply.style.display = showApply ? 'inline-flex' : 'none';
      btnApply.disabled = stage === 'downloading';
      btnApply.textContent = stage === 'error' ? t('update.btnRetry') : t('update.applyNow');
    }
    const btnRestart = findElInPage('ag-hs-btn-restart-host');
    if (btnRestart) {
      const showRestart = stage === 'pending_restart' && Boolean(snap.hostSupportsRestart);
      btnRestart.hidden = !showRestart;
      if (btnRestart.style) btnRestart.style.display = showRestart ? 'inline-flex' : 'none';
      btnRestart.textContent = t('update.restartBtn');
    }

    const diagLines = [
      `${t('hostSettings.diag.route')}: ${snap.activeRoute || '--'}`,
      `${t('hostSettings.diag.latency')}: ${Number.isFinite(snap.lastQuotaDurationMs) ? `${snap.lastQuotaDurationMs} ms` : '--'}`,
      `${t('hostSettings.diag.mismatch')}: ${snap.backendMismatch ? t('hostSettings.diag.yes') : t('hostSettings.diag.no')}`,
      snap.diagError ? `${t('hostSettings.diag.lastErr')}: ${snap.diagError}` : ''
    ].filter(Boolean);
    setText('ag-hs-diag-summary', diagLines.join(' · '));

    const toggleColorsBtn = findElInPage('ag-ns-toggle-colors');
    const toggleColorsLabel = findElInPage('ag-ns-toggle-colors-label');
    const colorsBody = findElInPage('ag-ns-colors-body');
    if (toggleColorsBtn) {
      toggleColorsBtn.setAttribute('data-label-expand', t('ns.colors.expand'));
      toggleColorsBtn.setAttribute('data-label-collapse', t('ns.colors.collapse'));
      if (toggleColorsLabel && colorsBody) {
        toggleColorsLabel.textContent = colorsBody.hidden ? t('ns.colors.expand') : t('ns.colors.collapse');
      }
    }
  }

  function bindNavSwitchHandler(container) {
    if (!container) return;
    if (boundNavContainers) {
      if (boundNavContainers.has(container)) return;
      boundNavContainers.add(container);
    } else if (container.__agHsBound) {
      return;
    } else {
      container.__agHsBound = true;
    }
    const onNativeNavClick = (ev) => {
      if (disposed) return;
      const target = ev?.target;
      const hitBtn = typeof target?.closest === 'function'
        ? target.closest('button, [role="tab"]')
        : target;
      if (!hitBtn || hitBtn.id === NAV_ID || isPluginOwnedNode(hitBtn)) return;
      const navScope = activeSidebar || activeNavList;
      const isNavBtn = (navScope && (navScope.contains?.(hitBtn) || Array.from(navScope.children || []).includes(hitBtn)))
        || isHostNavTestId(hitBtn);
      if (isNavBtn && hostSelected) {
        deactivateHostPage({ clickedNativeBtn: hitBtn });
      }
    };
    container.addEventListener?.('click', onNativeNavClick, true);
  }

  function removeDuplicateNavNodes(keepBtn, keepItem, navList) {
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const allNavs = Array.from(document.querySelectorAll(`#${NAV_ID}`) || []);
      for (const n of allNavs) {
        if (n !== keepBtn) {
          const wrap = n.parentElement?.getAttribute?.(NAV_WRAPPER_ATTR) === 'true' ? n.parentElement : null;
          try { (wrap && wrap !== keepItem ? wrap : n).remove?.(); } catch { }
        }
      }
      const allWraps = Array.from(document.querySelectorAll(`[${NAV_WRAPPER_ATTR}="true"]`) || []);
      for (const w of allWraps) {
        if (w !== keepItem) {
          try { w.remove?.(); } catch { }
        }
      }
    }
    if (navList && navList.children) {
      for (const child of Array.from(navList.children)) {
        if (!child || child === keepItem || child === keepBtn) continue;
        if (child.id === NAV_ID || child.getAttribute?.(NAV_WRAPPER_ATTR) === 'true') {
          try { child.remove?.(); } catch { }
        }
      }
    }
  }

  function syncModalMount() {
    if (disposed) return false;
    const targets = findHostSettingsTargets();
    if (!targets) {
      if (activeModal && activeModal.isConnected === false) {
        deactivateHostPage();
        savedPageScrollTop = 0;
        savedNativePaneScrollTop = 0;
        activeModal = null;
        activeSidebar = null;
        activeNavList = null;
        activeSplitRow = null;
        activeContentPane = null;
        navItemEl = null;
        navButtonEl = null;
      }
      return false;
    }

    const { modal, sidebar, navList, splitRow, anchorBtn, contentPane } = targets;
    const modalChanged = modal !== activeModal
      || sidebar !== activeSidebar
      || navList !== activeNavList
      || contentPane !== activeContentPane
      || activeContentPane?.isConnected === false;
    if (modalChanged) {
      if (activeModal && activeModal !== modal) {
        deactivateHostPage();
        savedPageScrollTop = 0;
        savedNativePaneScrollTop = 0;
      }
      activeModal = modal;
      activeSidebar = sidebar || null;
      activeNavList = navList;
      activeSplitRow = splitRow || null;
      activeContentPane = contentPane;
      bindNavSwitchHandler(activeModal);
      bindNavSwitchHandler(activeSidebar || navList);
    }

    ensureStyles();

    const anchorRow = resolveNavRowInList(navList, anchorBtn);
    const useRowWrapper = Boolean(anchorBtn && anchorRow && anchorRow !== anchorBtn);

    let existingBtn = null;
    if (typeof navList.querySelector === 'function') {
      existingBtn = navList.querySelector(`#${NAV_ID}`) || null;
    }
    if (!existingBtn && navList.children) {
      for (const ch of Array.from(navList.children)) {
        if (!ch) continue;
        if (ch.id === NAV_ID) { existingBtn = ch; break; }
        const nested = typeof ch.querySelector === 'function'
          ? ch.querySelector(`#${NAV_ID}`)
          : Array.from(ch.children || []).find((sub) => sub && sub.id === NAV_ID);
        if (nested) { existingBtn = nested; break; }
      }
    }

    if (existingBtn && existingBtn.__agHsCtrlToken === controllerToken) {
      navButtonEl = existingBtn;
    } else {
      if (existingBtn && existingBtn.__agHsCtrlToken !== controllerToken) {
        const oldWrap = existingBtn.parentElement?.getAttribute?.(NAV_WRAPPER_ATTR) === 'true'
          ? existingBtn.parentElement
          : null;
        try { (oldWrap || existingBtn).remove?.(); } catch { }
      }
      if (!navButtonEl || navButtonEl.__agHsCtrlToken !== controllerToken) {
        navButtonEl = createNavButton(anchorBtn);
      }
    }
    bindNavButtonEvents(navButtonEl);

    if (useRowWrapper) {
      if (
        !navItemEl ||
        navItemEl === navButtonEl ||
        navItemEl.getAttribute?.(NAV_WRAPPER_ATTR) !== 'true'
      ) {
        const existingWrap = navButtonEl.parentElement?.getAttribute?.(NAV_WRAPPER_ATTR) === 'true'
          ? navButtonEl.parentElement
          : null;
        navItemEl = existingWrap || document.createElement('div');
        navItemEl.setAttribute?.(NAV_WRAPPER_ATTR, 'true');
      }
      const rowCls = String(anchorRow?.className || 'relative group/nav-item mx-2').trim();
      if (navItemEl.className !== rowCls) navItemEl.className = rowCls;
      if (navButtonEl.parentElement !== navItemEl) {
        navItemEl.appendChild(navButtonEl);
      }
    } else {
      if (navItemEl && navItemEl !== navButtonEl && navItemEl.getAttribute?.(NAV_WRAPPER_ATTR) === 'true') {
        try { navItemEl.remove?.(); } catch { }
      }
      navItemEl = navButtonEl;
    }

    removeDuplicateNavNodes(navButtonEl, navItemEl, navList);

    if (anchorRow && typeof anchorRow.after === 'function') {
      if (anchorRow.nextElementSibling !== navItemEl || navItemEl.parentElement !== navList) {
        anchorRow.after(navItemEl);
      }
    } else if (navItemEl.parentElement !== navList) {
      navList.appendChild(navItemEl);
    }

    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== contentPane) {
      contentPane.appendChild(pageEl);
    }
    setHiddenSafe(pageEl, !hostSelected);
    if (hostSelected) {
      applyHostPageActivePresentation();
    } else {
      syncNavHighlightState(false, { clickedNativeBtn: true });
    }
    return true;
  }

  function findNativeSettingsTriggerButton() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const explicit = Array.from(document.querySelectorAll('button[data-testid*="settings" i], button[aria-label*="Settings" i], button[aria-label*="设置" i], button[aria-label*="設定" i]') || []);
    const hitExplicit = explicit.find((btn) => btn && !isPluginOwnedNode(btn));
    if (hitExplicit) return hitExplicit;
    const allButtons = Array.from(document.querySelectorAll('button') || []);
    return allButtons.find((btn) => {
      if (!btn || isPluginOwnedNode(btn)) return false;
      const label = String(btn.textContent || btn.getAttribute?.('aria-label') || '').trim();
      return /^(Settings|设置|設定)$/i.test(label);
    }) || null;
  }

  function openHostSettingsPage(opts = {}) {
    if (disposed) return { ok: false, mode: 'fallback', reason: 'controller_disposed' };
    clearPendingOpenWaiter();
    if (syncModalMount()) {
      const ok = activateHostPage(opts);
      if (ok && verifyHostPagePresented()) {
        return { ok: true, mode: 'host', reason: lastMountDiagnostic };
      }
      return { ok: false, mode: 'fallback', reason: 'host_page_presentation_failed' };
    }
    if (opts.autoOpenHost !== false) {
      const nativeTrigger = findNativeSettingsTriggerButton();
      if (nativeTrigger && typeof nativeTrigger.click === 'function') {
        try { nativeTrigger.click(); } catch { }
        if (syncModalMount()) {
          const ok = activateHostPage(opts);
          if (ok && verifyHostPagePresented()) {
            return { ok: true, mode: 'host', reason: lastMountDiagnostic };
          }
          return { ok: false, mode: 'fallback', reason: 'host_page_presentation_failed' };
        }
        if (typeof opts.onResolved === 'function') {
          const mySeq = ++pendingOpenSeq;
          const startedAt = Date.now();
          const pollWait = () => {
            if (disposed || mySeq !== pendingOpenSeq) return;
            if (syncModalMount()) {
              const ok = activateHostPage(opts);
              if (ok && verifyHostPagePresented()) {
                clearPendingOpenWaiter();
                opts.onResolved({ ok: true, mode: 'host', reason: lastMountDiagnostic });
                return;
              }
            }
            if (Date.now() - startedAt >= 650) {
              clearPendingOpenWaiter();
              opts.onResolved({ ok: false, mode: 'fallback', reason: lastMountDiagnostic || 'host_settings_modal_timeout' });
              return;
            }
            pendingOpenTimer = setTimeout(pollWait, 25);
          };
          pendingOpenTimer = setTimeout(pollWait, 20);
          return { ok: false, pending: true, mode: 'host_opening', reason: 'awaiting_host_modal_mount' };
        }
      }
    }
    return { ok: false, mode: 'fallback', reason: lastMountDiagnostic || 'host_settings_unavailable' };
  }

  function scheduleSync() {
    if (disposed || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      syncModalMount();
    }, 50);
  }

  function start(opts = {}) {
    if (disposed) return;
    syncModalMount();
    if (opts.watchDom === true && typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      const rootTarget = document.body || document.documentElement;
      if (rootTarget && !observer) {
        observer = new MutationObserver((mutations) => {
          if (disposed) return;
          let shouldSchedule = false;
          for (const m of mutations || []) {
            if (isPluginOwnedNode(m?.target)) continue;
            const changedNodes = [
              ...Array.from(m?.addedNodes || []),
              ...Array.from(m?.removedNodes || [])
            ];
            if (changedNodes.length > 0 && changedNodes.every((n) => isPluginOwnedNode(n))) {
              continue;
            }
            if (hostSelected && activeContentPane && (m?.target === activeContentPane || activeContentPane.contains?.(m?.target))) {
              hideNativeContentNodes();
            }
            shouldSchedule = true;
          }
          if (shouldSchedule) scheduleSync();
        });
        try {
          observer.observe(rootTarget, { childList: true, subtree: true });
        } catch { }
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearPendingOpenWaiter();
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (activeEnsureTimer) {
      clearTimeout(activeEnsureTimer);
      activeEnsureTimer = null;
    }
    if (activeLateEnsureTimer) {
      clearTimeout(activeLateEnsureTimer);
      activeLateEnsureTimer = null;
    }
    try { observer?.disconnect?.(); } catch { }
    observer = null;
    deactivateHostPage();
    try { (navItemEl || navButtonEl)?.remove?.(); } catch { }
    try { navButtonEl?.remove?.(); } catch { }
    try { pageEl?.remove?.(); } catch { }
    if (typeof document !== 'undefined') {
      try { document.getElementById(STYLE_ID)?.remove?.(); } catch { }
    }
    navItemEl = null;
    navButtonEl = null;
    pageEl = null;
    pageShadow = null;
    activeModal = null;
    activeSidebar = null;
    activeNavList = null;
    activeSplitRow = null;
    activeContentPane = null;
  }

  function openColorsDrawer() {
    const colorsBody = findElInPage('ag-ns-colors-body');
    const colorsBtn = findElInPage('ag-ns-toggle-colors');
    const colorsLbl = findElInPage('ag-ns-toggle-colors-label');
    if (colorsBody) colorsBody.hidden = false;
    if (colorsBtn) colorsBtn.setAttribute?.('aria-expanded', 'true');
    if (colorsLbl) colorsLbl.textContent = t('ns.colors.collapse');
  }

  return {
    start,
    dispose,
    syncModalMount,
    scheduleSync,
    renderPage,
    activateHostPage,
    deactivateHostPage,
    openHostSettingsPage,
    scrollToSection,
    openColorsDrawer,
    findElementById: findElInPage,
    getPageRoot: () => pageShadow || pageEl || null,
    getPageHost: () => pageEl || null,
    syncThemeToPageHost,
    isHostPageSelected: () => Boolean(hostSelected),
    getLastMountDiagnostic: () => lastMountDiagnostic,
    getStateForTest: () => ({
      mounted: Boolean(activeModal && navButtonEl && (navItemEl?.parentElement === activeNavList || navButtonEl.parentElement === activeNavList)),
      selected: hostSelected,
      navId: navButtonEl?.id || null,
      pageHidden: pageEl ? Boolean(pageEl.hidden) : true,
      hasShadowRoot: Boolean(pageShadow),
      nativeSettingsPageReady: Boolean(findElInPage('ag-ns-root')),
      scrollTop: pageEl ? Number(pageEl.scrollTop || 0) : 0,
      contentPaneId: activeContentPane?.id || activeContentPane?.getAttribute?.('data-testid') || null,
      hiddenNativeCount: savedHiddenNodes.length,
      navCountInDoc: typeof document?.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(`#${NAV_ID}`) || []).length
        : (navButtonEl ? 1 : 0)
    })
  };
}
