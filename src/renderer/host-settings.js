/**
 * 宿主原生设置弹窗融合模块
 * 负责在 Antigravity 原生设置弹窗左侧导航栏紧贴 Browser 项下方单实例挂载 Context Meter 设置专页，
 * 复用插件内部状态与动作，并在切换回宿主原生页时无损还原原生面板.
 * @param {Object} deps
 * @returns {Object}
 */
function createHostSettingsController(deps = {}) {
  const {
    t = (k) => k,
    getSnapshot = () => ({}),
    onCheckUpdate = () => {},
    onApplyUpdate = () => {},
    onRestartHost = () => {},
    onVerifyRuntime = () => {},
    onToggleBetaUpdates = () => {},
    onToggleNextPrompt = () => {},
    onOpenPluginPanel = () => {},
    onOpenReleasePage = () => {},
    onCopyDiagnostics = null
  } = deps;

  const NAV_ID = 'ag-cm-host-settings-nav';
  const PAGE_ID = 'ag-cm-host-settings-page';
  const STYLE_ID = 'ag-cm-host-settings-styles';
  const HIDDEN_ATTR = 'data-ag-hs-hidden';

  let disposed = false;
  let observer = null;
  let scanTimer = null;
  let activeModal = null;
  let activeNavList = null;
  let activeContentPane = null;
  let navButtonEl = null;
  let pageEl = null;
  let hostSelected = false;
  let savedHiddenNodes = [];

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
      #${NAV_ID}[data-active="true"] {
        background: var(--vscode-list-activeSelectionBackground, rgba(99, 102, 241, 0.18)) !important;
        color: var(--vscode-list-activeSelectionForeground, var(--foreground, #f8fafc)) !important;
        font-weight: 600 !important;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${PAGE_ID} {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 18px 20px;
        box-sizing: border-box;
        color: var(--foreground, #e5e7eb);
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.5;
      }
      #${PAGE_ID} .ag-hs-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.18));
      }
      #${PAGE_ID} .ag-hs-title {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--foreground, #f8fafc);
      }
      #${PAGE_ID} .ag-hs-sub {
        margin: 2px 0 0;
        font-size: 11.5px;
        color: var(--muted-foreground, #94a3b8);
      }
      #${PAGE_ID} .ag-hs-card {
        border: 1px solid var(--border, rgba(148, 163, 184, 0.2));
        border-radius: 10px;
        padding: 12px 14px;
        background: var(--card, rgba(148, 163, 184, 0.05));
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #${PAGE_ID} .ag-hs-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      #${PAGE_ID} .ag-hs-card-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--foreground, #f1f5f9);
      }
      #${PAGE_ID} .ag-hs-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        background: rgba(148, 163, 184, 0.18);
        color: var(--foreground, #e2e8f0);
      }
      #${PAGE_ID} .ag-hs-pill[data-stage="active"],
      #${PAGE_ID} .ag-hs-pill[data-stage="latest"] {
        background: rgba(52, 211, 153, 0.18);
        color: #34d399;
      }
      #${PAGE_ID} .ag-hs-pill[data-stage="downloaded"] {
        background: rgba(56, 189, 248, 0.18);
        color: #38bdf8;
      }
      #${PAGE_ID} .ag-hs-pill[data-stage="pending_restart"],
      #${PAGE_ID} .ag-hs-pill[data-stage="available"] {
        background: rgba(251, 191, 36, 0.2);
        color: #fbbf24;
      }
      #${PAGE_ID} .ag-hs-pill[data-stage="error"] {
        background: rgba(248, 113, 113, 0.2);
        color: #f87171;
      }
      #${PAGE_ID} .ag-hs-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #${PAGE_ID} .ag-hs-kv {
        padding: 7px 9px;
        border-radius: 7px;
        background: rgba(148, 163, 184, 0.08);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      #${PAGE_ID} .ag-hs-k {
        font-size: 10.5px;
        color: var(--muted-foreground, #94a3b8);
      }
      #${PAGE_ID} .ag-hs-v {
        font-size: 12px;
        font-weight: 600;
        word-break: break-word;
      }
      #${PAGE_ID} .ag-hs-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${PAGE_ID} .ag-hs-btn {
        border: 1px solid var(--border, rgba(148, 163, 184, 0.28));
        background: transparent;
        color: inherit;
        border-radius: 6px;
        padding: 5px 11px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
      }
      #${PAGE_ID} .ag-hs-btn[hidden] {
        display: none !important;
      }
      #${PAGE_ID} .ag-hs-btn.is-primary {
        background: var(--button-background, #4f46e5);
        border-color: transparent;
        color: #ffffff;
      }
      #${PAGE_ID} .ag-hs-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #${PAGE_ID} .ag-hs-switch-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        cursor: pointer;
      }
      #${PAGE_ID} .ag-hs-switch-copy {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      #${PAGE_ID} .ag-hs-switch-desc {
        font-size: 11px;
        color: var(--muted-foreground, #94a3b8);
      }
      #${PAGE_ID} .ag-hs-note {
        font-size: 11.5px;
        color: var(--muted-foreground, #cbd5e1);
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function isPluginOwnedNode(node) {
    if (!node) return false;
    if (node.id === 'ag-context-meter' || node.id === 'ag-context-meter-radial-host') return true;
    return Boolean(typeof node.closest === 'function' && node.closest('#ag-context-meter, #ag-context-meter-radial-host'));
  }

  function getNavButtons(container) {
    if (!container) return [];
    if (typeof container.querySelectorAll === 'function') {
      const explicit = Array.from(container.querySelectorAll('button[id^="settings-nav-item-"]') || [])
        .filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
      if (explicit.length > 0) return explicit;
      const fallback = Array.from(container.querySelectorAll('button, [role="tab"]') || [])
        .filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
      return fallback;
    }
    return Array.from(container.children || []).filter((b) => b && b.id !== NAV_ID && !isPluginOwnedNode(b));
  }

  function findBrowserAnchorButton(navList, explicitBrowserBtn = null) {
    if (explicitBrowserBtn && (!navList || explicitBrowserBtn.parentElement === navList)) {
      return explicitBrowserBtn;
    }
    const items = getNavButtons(navList);
    return (
      items.find((b) => b.id === 'settings-nav-item-Browser') ||
      items.find((b) => /browser|浏览器|瀏覽器/i.test(String(b.textContent || b.id || ''))) ||
      items[items.length - 1] ||
      null
    );
  }

  function findContentPane(modal, navList) {
    if (!modal || !navList) return null;
    if (typeof modal.querySelector === 'function') {
      const explicitPane = modal.querySelector('[data-settings-content-pane="true"], .settings-content-pane');
      if (explicitPane && !explicitPane.contains?.(navList) && explicitPane !== navList) {
        return explicitPane;
      }
    }
    let cursor = navList;
    while (cursor && cursor !== modal) {
      const parent = cursor.parentElement;
      if (!parent) break;
      const children = Array.from(parent.children || []).filter(Boolean);
      const siblings = children.filter((child) => (
        child !== cursor &&
        child.id !== PAGE_ID &&
        child.tagName !== 'STYLE' &&
        !isPluginOwnedNode(child)
      ));
      const candidate = siblings.find((child) => {
        const textLen = String(child.textContent || '').trim().length;
        const childCount = Array.isArray(child.children) ? child.children.length : 0;
        const role = typeof child.getAttribute === 'function' ? child.getAttribute('role') : '';
        return role === 'tabpanel' || childCount > 0 || textLen > 0;
      }) || siblings.find((child) => !/close/i.test(String(child.className || child.getAttribute?.('aria-label') || '')));
      if (candidate) return candidate;
      cursor = parent;
    }
    return null;
  }

  function findHostSettingsTargets() {
    if (typeof document === 'undefined') return null;
    const candidates = [];
    if (typeof document.querySelectorAll === 'function') {
      const found = Array.from(document.querySelectorAll('.settings-modal-container, [role="dialog"]') || []);
      for (const n of found) {
        if (n && !isPluginOwnedNode(n) && !candidates.includes(n)) candidates.push(n);
      }
    }
    const browserById = typeof document.getElementById === 'function' ? document.getElementById('settings-nav-item-Browser') : null;
    if (browserById && !isPluginOwnedNode(browserById)) {
      const modalFromBrowser = browserById.closest?.('.settings-modal-container, [role="dialog"]') || browserById.parentElement?.parentElement || null;
      if (modalFromBrowser && !candidates.includes(modalFromBrowser)) candidates.unshift(modalFromBrowser);
    }

    for (const modal of candidates) {
      const browserBtn = modal.querySelector?.('#settings-nav-item-Browser') || (browserById && (modal.contains?.(browserById) || browserById.parentElement?.parentElement === modal) ? browserById : null);
      const navBtns = getNavButtons(modal);
      if (!browserBtn && navBtns.length === 0) continue;
      const navList = browserBtn?.parentElement || navBtns.find((b) => /general|browser|account|浏览器|通用/i.test(String(b.textContent || b.id || '')))?.parentElement || navBtns[0]?.parentElement;
      if (!navList) continue;
      const anchorBtn = findBrowserAnchorButton(navList, browserBtn);
      const contentPane = findContentPane(modal, navList);
      if (!contentPane) continue;
      return { modal, navList, anchorBtn, contentPane };
    }
    return null;
  }

  function restoreHiddenNativeNodes() {
    if (activeContentPane && Array.isArray(activeContentPane.children)) {
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
      } catch {}
    }
    savedHiddenNodes = [];
  }

  function hideNativeContentNodes() {
    if (!activeContentPane) return;
    for (const child of Array.from(activeContentPane.children || [])) {
      if (!child || child.id === PAGE_ID || child.tagName === 'STYLE') continue;
      if (child.getAttribute?.(HIDDEN_ATTR) === 'true') continue;
      const origDisplay = child.style?.getPropertyValue?.('display') || child.style?.display || '';
      const origHidden = Boolean(child.hidden);
      savedHiddenNodes.push({ node: child, origDisplay, origHidden });
      child.setAttribute?.(HIDDEN_ATTR, 'true');
      setHiddenSafe(child, true);
    }
  }

  function syncNavHighlightState(active) {
    if (navButtonEl) {
      navButtonEl.setAttribute('data-active', active ? 'true' : 'false');
      navButtonEl.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (!activeNavList) return;
    for (const btn of getNavButtons(activeNavList)) {
      if (!btn || btn === navButtonEl) continue;
      if (active) {
        if (btn.getAttribute?.('aria-selected') === 'true') {
          btn.setAttribute('data-ag-hs-prev-selected', 'true');
          btn.setAttribute('aria-selected', 'false');
        }
      } else if (btn.getAttribute?.('data-ag-hs-prev-selected') === 'true') {
        btn.removeAttribute('data-ag-hs-prev-selected');
        btn.setAttribute('aria-selected', 'true');
      }
    }
  }

  function deactivateHostPage() {
    hostSelected = false;
    if (pageEl) {
      setHiddenSafe(pageEl, true);
    }
    restoreHiddenNativeNodes();
    syncNavHighlightState(false);
  }

  function activateHostPage() {
    if (!activeModal || !activeContentPane) return;
    ensureStyles();
    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== activeContentPane) {
      activeContentPane.appendChild(pageEl);
    }
    hostSelected = true;
    hideNativeContentNodes();
    setHiddenSafe(pageEl, false);
    syncNavHighlightState(true);
    renderPage();
  }

  function createNavButton(anchorBtn) {
    const btn = document.createElement('button');
    btn.id = NAV_ID;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-active', 'false');
    const baseClass = String(anchorBtn?.className || '')
      .replace(/\bbg-ide-input-background\b|\bbg-accent\b|\bis-active\b|\bactive\b|\bselected\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    btn.className = baseClass ? `${baseClass} ag-cm-host-nav-item` : 'ag-cm-host-nav-item';
    btn.innerHTML = `
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6"></circle>
        <path d="M8 8l3-2.5"></path>
      </svg>
      <span class="ag-hs-nav-label">Context Meter</span>
    `;
    btn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      activateHostPage();
    });
    return btn;
  }

  function findElInPage(id) {
    if (!pageEl) return null;
    if (typeof pageEl.querySelector === 'function') {
      const hit = pageEl.querySelector(`#${id}`);
      if (hit) return hit;
    }
    const queue = [...(pageEl.children || [])];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur) continue;
      if (cur.id === id) return cur;
      if (Array.isArray(cur.children)) queue.push(...cur.children);
    }
    return null;
  }

  function createPageElement() {
    const wrap = document.createElement('section');
    wrap.id = PAGE_ID;
    wrap.setAttribute('aria-label', 'Context Meter 设置');
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="ag-hs-header">
        <div>
          <h2 id="ag-hs-title" class="ag-hs-title">Context Meter</h2>
          <p id="ag-hs-sub" class="ag-hs-sub"></p>
        </div>
        <div class="ag-hs-actions">
          <button id="ag-hs-btn-open-accounts" class="ag-hs-btn" type="button"></button>
          <button id="ag-hs-btn-open-quota" class="ag-hs-btn" type="button"></button>
          <button id="ag-hs-btn-open-tokens" class="ag-hs-btn" type="button"></button>
          <button id="ag-hs-btn-open-settings" class="ag-hs-btn" type="button"></button>
        </div>
      </div>

      <div class="ag-hs-card">
        <div class="ag-hs-card-head">
          <span id="ag-hs-sec-version" class="ag-hs-card-title"></span>
          <span id="ag-hs-update-stage-pill" class="ag-hs-pill" data-stage="idle"></span>
        </div>
        <div class="ag-hs-grid">
          <div class="ag-hs-kv">
            <span id="ag-hs-lbl-frontend" class="ag-hs-k"></span>
            <span id="ag-hs-val-frontend" class="ag-hs-v">--</span>
          </div>
          <div class="ag-hs-kv">
            <span id="ag-hs-lbl-backend" class="ag-hs-k"></span>
            <span id="ag-hs-val-backend" class="ag-hs-v">--</span>
          </div>
          <div class="ag-hs-kv">
            <span id="ag-hs-lbl-bridge" class="ag-hs-k"></span>
            <span id="ag-hs-val-bridge" class="ag-hs-v">--</span>
          </div>
          <div class="ag-hs-kv">
            <span id="ag-hs-lbl-target" class="ag-hs-k"></span>
            <span id="ag-hs-val-target" class="ag-hs-v">--</span>
          </div>
        </div>
        <div id="ag-hs-update-detail" class="ag-hs-note"></div>
        <label class="ag-hs-switch-row" for="ag-hs-chk-beta-updates">
          <span class="ag-hs-switch-copy">
            <span id="ag-hs-lbl-beta" class="ag-hs-card-title" style="font-size:12px"></span>
            <span id="ag-hs-desc-beta" class="ag-hs-switch-desc"></span>
          </span>
          <input id="ag-hs-chk-beta-updates" type="checkbox">
        </label>
        <div class="ag-hs-actions">
          <button id="ag-hs-btn-check-update" class="ag-hs-btn is-primary" type="button"></button>
          <button id="ag-hs-btn-apply-update" class="ag-hs-btn is-primary" type="button" hidden></button>
          <button id="ag-hs-btn-restart-host" class="ag-hs-btn is-primary" type="button" hidden></button>
          <button id="ag-hs-btn-verify-runtime" class="ag-hs-btn" type="button"></button>
          <button id="ag-hs-btn-release-page" class="ag-hs-btn" type="button"></button>
        </div>
      </div>

      <div class="ag-hs-card">
        <div class="ag-hs-card-head">
          <span id="ag-hs-sec-prefs" class="ag-hs-card-title"></span>
        </div>
        <label class="ag-hs-switch-row" for="ag-hs-chk-next-prompt">
          <span class="ag-hs-switch-copy">
            <span id="ag-hs-lbl-next-prompt" class="ag-hs-card-title" style="font-size:12px"></span>
            <span id="ag-hs-desc-next-prompt" class="ag-hs-switch-desc"></span>
          </span>
          <input id="ag-hs-chk-next-prompt" type="checkbox">
        </label>
      </div>

      <div class="ag-hs-card">
        <div class="ag-hs-card-head">
          <span id="ag-hs-sec-diag" class="ag-hs-card-title"></span>
          <button id="ag-hs-btn-copy-diag" class="ag-hs-btn" type="button"></button>
        </div>
        <div id="ag-hs-diag-summary" class="ag-hs-note"></div>
      </div>
    `;
    pageEl = wrap;

    findElInPage('ag-hs-btn-check-update')?.addEventListener('click', () => { void onCheckUpdate('host-settings'); });
    findElInPage('ag-hs-btn-apply-update')?.addEventListener('click', () => { void onApplyUpdate('host-settings'); });
    findElInPage('ag-hs-btn-restart-host')?.addEventListener('click', () => { void onRestartHost(); });
    findElInPage('ag-hs-btn-verify-runtime')?.addEventListener('click', () => { void onVerifyRuntime(); });
    findElInPage('ag-hs-btn-release-page')?.addEventListener('click', () => { void onOpenReleasePage(); });
    findElInPage('ag-hs-btn-open-accounts')?.addEventListener('click', () => { void onOpenPluginPanel('accounts'); });
    findElInPage('ag-hs-btn-open-quota')?.addEventListener('click', () => { void onOpenPluginPanel('quota'); });
    findElInPage('ag-hs-btn-open-tokens')?.addEventListener('click', () => { void onOpenPluginPanel('tokens'); });
    findElInPage('ag-hs-btn-open-settings')?.addEventListener('click', () => { void onOpenPluginPanel('settings'); });
    findElInPage('ag-hs-btn-copy-diag')?.addEventListener('click', () => {
      if (typeof onCopyDiagnostics === 'function') {
        void onCopyDiagnostics();
      }
    });
    findElInPage('ag-hs-chk-beta-updates')?.addEventListener('change', (e) => {
      const checked = Boolean(e?.target?.checked);
      onToggleBetaUpdates(checked);
    });
    findElInPage('ag-hs-chk-next-prompt')?.addEventListener('change', (e) => {
      const checked = Boolean(e?.target?.checked);
      onToggleNextPrompt(checked);
    });

    return wrap;
  }

  function renderPage() {
    if (!pageEl || disposed) return;
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

    setText('ag-hs-sub', t('hostSettings.subtitle'));
    setText('ag-hs-btn-open-accounts', t('hostSettings.btn.accounts'));
    setText('ag-hs-btn-open-quota', t('hostSettings.btn.quota'));
    setText('ag-hs-btn-open-tokens', t('hostSettings.btn.tokens'));
    setText('ag-hs-btn-open-settings', t('hostSettings.btn.settings'));
    setText('ag-hs-sec-version', t('hostSettings.sec.version'));
    setText('ag-hs-lbl-frontend', t('hostSettings.lbl.frontend'));
    setText('ag-hs-lbl-backend', t('hostSettings.lbl.backend'));
    setText('ag-hs-lbl-bridge', t('hostSettings.lbl.bridge'));
    setText('ag-hs-lbl-target', t('hostSettings.lbl.target'));
    setText('ag-hs-lbl-beta', t('hostSettings.beta.label'));
    setText('ag-hs-desc-beta', t('hostSettings.beta.desc'));
    setText('ag-hs-sec-prefs', t('hostSettings.sec.prefs'));
    setText('ag-hs-lbl-next-prompt', t('settings.nextPrompt.label'));
    setText('ag-hs-desc-next-prompt', t('settings.nextPrompt.desc'));
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
    if (stage === 'unavailable') {
      detailText = t('update.unavailableBody');
    } else if (stage === 'checking') {
      detailText = t('update.connecting');
    } else if (stage === 'available') {
      detailText = t('update.foundBody', { ver: targetVer, notes: snap.releaseNotes || t('update.defaultNotes') });
    } else if (stage === 'downloading') {
      detailText = t('update.downloading');
    } else if (stage === 'downloaded') {
      detailText = t('update.doneLiveSynced', { ver: targetVer });
    } else if (stage === 'pending_restart') {
      detailText = snap.hostSupportsRestart
        ? t('update.doneDisk', { ver: targetVer })
        : `${t('update.doneDisk', { ver: targetVer })} ${t('client.restart.hostNotSupported')}`;
    } else if (stage === 'active') {
      detailText = t('update.doneHotFull', { ver: targetVer });
    } else if (stage === 'error') {
      detailText = t('update.failStatus', { err: snap.errorText || t('msg.unknownErr') });
    } else if (stage === 'latest') {
      detailText = t('update.latestBody', { ver: frontendVer });
    } else {
      detailText = t('hostSettings.stage.idleHint');
    }
    setText('ag-hs-update-detail', detailText);

    const chkBeta = findElInPage('ag-hs-chk-beta-updates');
    if (chkBeta) chkBeta.checked = Boolean(snap.allowBetaUpdates);
    const chkNextPrompt = findElInPage('ag-hs-chk-next-prompt');
    if (chkNextPrompt) chkNextPrompt.checked = Boolean(snap.nextPromptEnabled);

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
  }

  function bindNavSwitchHandler(navList) {
    if (!navList || navList.__agHsBound) return;
    navList.__agHsBound = true;
    const onNativeNavClick = (ev) => {
      if (disposed) return;
      const target = ev?.target;
      const hitBtn = typeof target?.closest === 'function'
        ? target.closest('button, [role="tab"]')
        : target;
      if (!hitBtn || hitBtn.id === NAV_ID || isPluginOwnedNode(hitBtn)) return;
      if (navList.contains?.(hitBtn) || Array.from(navList.children || []).includes(hitBtn)) {
        if (hostSelected) {
          deactivateHostPage();
        }
      }
    };
    navList.addEventListener?.('click', onNativeNavClick, true);
  }

  function removeDuplicateNavNodes(keepNode, navList) {
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const allNavs = Array.from(document.querySelectorAll(`#${NAV_ID}`) || []);
      for (const n of allNavs) {
        if (n !== keepNode) {
          try { n.remove?.(); } catch {}
        }
      }
    }
    if (navList && Array.isArray(navList.children)) {
      for (const child of Array.from(navList.children)) {
        if (child && child.id === NAV_ID && child !== keepNode) {
          try { child.remove?.(); } catch {}
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
        activeModal = null;
        activeNavList = null;
        activeContentPane = null;
        navButtonEl = null;
      }
      return false;
    }

    const { modal, navList, anchorBtn, contentPane } = targets;
    const modalChanged = modal !== activeModal || navList !== activeNavList || contentPane !== activeContentPane;
    if (modalChanged) {
      if (activeModal && activeModal !== modal) {
        deactivateHostPage();
      }
      activeModal = modal;
      activeNavList = navList;
      activeContentPane = contentPane;
      bindNavSwitchHandler(navList);
    }

    ensureStyles();

    const existingInNav = Array.from(navList.children || []).find((n) => n && n.id === NAV_ID) || null;
    if (existingInNav) {
      navButtonEl = existingInNav;
    } else if (!navButtonEl || (navButtonEl.parentElement && navButtonEl.parentElement !== navList)) {
      navButtonEl = createNavButton(anchorBtn);
    }
    removeDuplicateNavNodes(navButtonEl, navList);

    if (anchorBtn && typeof anchorBtn.after === 'function') {
      if (anchorBtn.nextElementSibling !== navButtonEl || navButtonEl.parentElement !== navList) {
        anchorBtn.after(navButtonEl);
      }
    } else if (navButtonEl.parentElement !== navList) {
      navList.appendChild(navButtonEl);
    }

    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== contentPane) {
      contentPane.appendChild(pageEl);
    }
    setHiddenSafe(pageEl, !hostSelected);
    if (hostSelected) {
      hideNativeContentNodes();
      renderPage();
    }
    return true;
  }

  function scheduleSync() {
    if (disposed || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      syncModalMount();
    }, 50);
  }

  function start() {
    if (disposed) return;
    syncModalMount();
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      const rootTarget = document.body || document.documentElement;
      if (rootTarget && !observer) {
        observer = new MutationObserver((mutations) => {
          if (disposed) return;
          for (const m of mutations || []) {
            if (isPluginOwnedNode(m?.target)) continue;
            scheduleSync();
            break;
          }
        });
        try {
          observer.observe(rootTarget, { childList: true, subtree: true });
        } catch {}
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    try { observer?.disconnect?.(); } catch {}
    observer = null;
    deactivateHostPage();
    try { navButtonEl?.remove?.(); } catch {}
    try { pageEl?.remove?.(); } catch {}
    if (typeof document !== 'undefined') {
      try { document.getElementById(STYLE_ID)?.remove?.(); } catch {}
    }
    navButtonEl = null;
    pageEl = null;
    activeModal = null;
    activeNavList = null;
    activeContentPane = null;
  }

  return {
    start,
    dispose,
    syncModalMount,
    renderPage,
    activateHostPage,
    deactivateHostPage,
    getStateForTest: () => ({
      mounted: Boolean(activeModal && navButtonEl && navButtonEl.parentElement === activeNavList),
      selected: hostSelected,
      navId: navButtonEl?.id || null,
      pageHidden: pageEl ? Boolean(pageEl.hidden) : true,
      hiddenNativeCount: savedHiddenNodes.length,
      navCountInDoc: typeof document?.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(`#${NAV_ID}`) || []).length
        : (navButtonEl ? 1 : 0)
    })
  };
}
