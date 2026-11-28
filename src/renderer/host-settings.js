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
    getCompactionProgressSnapshot = null,
    getAccountsPageSnapshot = null,
    onNativeSettingChange = null,
    onNativeColorChange = null,
    onNativeResetColors = null,
    onNativeAction = null,
    onAccountsPageAction = null,
    refreshSingleAccountForAll = null,
    refreshAllThrottleMs = 260,
    onHostModalVisibilityChange = null,
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
  const NAV_COMPACT_ID = 'ag-cm-host-settings-compact-nav';
  const NAV_ACCOUNTS_ID = 'ag-cm-host-settings-accounts-nav';
  const NAV_WRAPPER_ATTR = 'data-ag-hs-nav-wrapper';
  const NAV_COMPACT_WRAPPER_ATTR = 'data-ag-hs-compact-nav-wrapper';
  const NAV_ACCOUNTS_WRAPPER_ATTR = 'data-ag-hs-accounts-nav-wrapper';
  const PAGE_ID = 'ag-cm-host-settings-page';
  const PAGE_COMPACT_ID = 'ag-cm-host-compact-progress-page';
  const PAGE_ACCOUNTS_ID = 'ag-cm-host-accounts-page';
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
  let compactNavItemEl = null;
  let compactNavButtonEl = null;
  let accountsNavItemEl = null;
  let accountsNavButtonEl = null;
  let pageEl = null;
  let pageShadow = null;
  let compactPageEl = null;
  let compactPageShadow = null;
  let accountsPageEl = null;
  let accountsPageShadow = null;
  let hostSelected = false;
  let activeCustomPage = null; // null | 'settings' | 'compaction' | 'accounts'
  let lastReportedModalOpen = false;
  let savedHiddenNodes = [];
  let savedPageScrollTop = 0;
  let savedCompactPageScrollTop = 0;
  let savedAccountsPageScrollTop = 0;
  let savedNativePaneScrollTop = 0;
  let lastMountDiagnostic = 'not_mounted';
  let activeEnsureTimer = null;
  let activeLateEnsureTimer = null;
  let pendingOpenTimer = null;
  let pendingOpenSeq = 0;
  const boundNavContainers = typeof WeakSet === 'function' ? new WeakSet() : null;

  // 账号页顶部药丸升级与三语可见文案，严格零中英文括号
  const AC_UPGRADE_I18N = {
    refreshAll: { 'zh-CN': '刷新全部账号', 'zh-TW': '重新整理全部帳號', en: 'Refresh All Accounts' },
    refreshProgress: { 'zh-CN': '正在刷新 {done}/{total}', 'zh-TW': '正在重新整理 {done}/{total}', en: 'Refreshing {done}/{total}' },
    cancelRefresh: { 'zh-CN': '取消刷新', 'zh-TW': '取消重新整理', en: 'Cancel Refresh' },
    refreshAllDone: { 'zh-CN': '全部账号刷新完成 · 成功 {ok}/{total}', 'zh-TW': '全部帳號重新整理完成 · 成功 {ok}/{total}', en: 'All accounts refreshed · {ok}/{total} succeeded' },
    refreshAllPartial: { 'zh-CN': '刷新完成 · 成功 {ok} · 失败 {fail} · 已保留旧快照 · {reason}', 'zh-TW': '重新整理完成 · 成功 {ok} · 失敗 {fail} · 已保留舊快照 · {reason}', en: 'Refresh finished · {ok} ok · {fail} failed · Kept prior snapshot · {reason}' },
    refreshAllCancelled: { 'zh-CN': '已取消批量刷新 · 已完成 {done}/{total}', 'zh-TW': '已取消批次重新整理 · 已完成 {done}/{total}', en: 'Batch refresh cancelled · Completed {done}/{total}' },
    refreshAllEmpty: { 'zh-CN': '暂无可刷新的已登记账号', 'zh-TW': '暫無可重新整理的已登記帳號', en: 'No registered accounts available to refresh' },
    noRefreshCred: { 'zh-CN': '缺少可刷新凭据', 'zh-TW': '缺少可重新整理憑據', en: 'Missing refresh credential' },
    switchBestBtn: { 'zh-CN': '切换到余量充足账号', 'zh-TW': '切換至餘量充足帳號', en: 'Switch to Highest Quota' },
    switchBestAlready: { 'zh-CN': '当前账号已是余量最高账号', 'zh-TW': '目前帳號已是餘量最高帳號', en: 'Current account already has the highest quota' },
    switchBestNone: { 'zh-CN': '暂无可切换的余量充足账号', 'zh-TW': '暫無可切換的餘量充足帳號', en: 'No eligible account available to switch' },
    switchBestTrigger: { 'zh-CN': '正在切换至余量充足账号 {target} · 可用度 {score}%', 'zh-TW': '正在切換至餘量充足帳號 {target} · 可用度 {score}%', en: 'Switching to {target} · Availability {score}%' },
    autoSwitchToggleTitle: { 'zh-CN': '自动切号规则总开关', 'zh-TW': '自動切號規則總開關', en: 'Auto Switch Rule Master Toggle' },
    autoSwitchToggleDesc: { 'zh-CN': '开启后按下方监控额度与阈值条件监控并在保存后生效', 'zh-TW': '開啟後依下方監控額度與閾值條件監控並在儲存後生效', en: 'Monitor the selected quota target and threshold after saving' }
  };

  const refreshAllState = {
    running: false,
    cancelled: false,
    seq: 0,
    done: 0,
    total: 0,
    okCount: 0,
    failCount: 0,
    currentEmail: '',
    errors: [],
    waitTimer: null,
    waitResolve: null
  };

  function detectAccountsUpgradeLang() {
    try {
      const snap = typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : null;
      const rootSnap = typeof getSnapshot === 'function' ? getSnapshot() : null;
      const rawLang = String(snap?.lang || rootSnap?.lang || (typeof document !== 'undefined' ? document.documentElement?.lang : '') || '').trim();
      const low = rawLang.toLowerCase();
      if (low.includes('zh-tw') || low.includes('zh-hk') || low.includes('hant')) return 'zh-TW';
      if (low.startsWith('en')) return 'en';
      if (low.startsWith('zh')) return 'zh-CN';
      const navLbl = String(t('accountsPage.navLabel') || '');
      if (navLbl.includes('帳號') || navLbl.includes('額度')) return 'zh-TW';
      if (/^[A-Za-z0-9\s&/.-]+$/.test(navLbl) && navLbl && navLbl !== 'accountsPage.navLabel') return 'en';
    } catch { }
    return 'zh-CN';
  }

  function tu(key, vars = null) {
    const entry = AC_UPGRADE_I18N[key];
    if (!entry) return key;
    const lang = detectAccountsUpgradeLang();
    let str = entry[lang] || entry['zh-CN'] || key;
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
      }
    }
    return str;
  }

  function buildAccountsUpgradeExtraCss() {
    return `
      .ag-ac-pill-btn {
        border-radius: 999px !important;
        padding-left: 12px !important;
        padding-right: 12px !important;
        gap: 6px;
        transition: background-color 160ms ease, border-color 160ms ease, transform 140ms ease, opacity 140ms ease;
      }
      .ag-ac-refresh-progress-btn.is-running {
        border-color: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 48%, transparent) !important;
        background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 14%, transparent) !important;
      }
      .ag-ac-refresh-progress-btn.is-running svg {
        animation: ag-ac-pill-spin 0.9s linear infinite;
      }
      @keyframes ag-ac-pill-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .ag-ac-cancel-pill {
        border-radius: 999px !important;
        padding: 5px 10px !important;
        font-size: 11.5px !important;
        border-color: color-mix(in srgb, #ef4444 38%, transparent) !important;
        color: #ef4444 !important;
      }
      .ag-ac-switch-best-btn {
        border-radius: 999px !important;
        border-color: color-mix(in srgb, #10b981 42%, transparent) !important;
        background: color-mix(in srgb, #10b981 12%, transparent) !important;
      }
      .ag-ac-switch-best-btn:hover:not(:disabled) {
        background: color-mix(in srgb, #10b981 20%, transparent) !important;
      }
      .ag-ac-autoswitch-toggle {
        width: 16px;
        height: 16px;
        accent-color: var(--ag-host-accent, var(--primary, #3274f6));
        cursor: pointer;
      }
    `;
  }

  function showAccountsLocalToast(root, message, tone = 'info') {
    if (!root || !message) return;
    const toast = (typeof root.getElementById === 'function' ? root.getElementById('ag-ac-toast') : null)
      || root.querySelector?.('#ag-ac-toast');
    if (toast) {
      toast.textContent = String(message);
      toast.hidden = false;
      if (toast._agAcLocalToastTimer) clearTimeout(toast._agAcLocalToastTimer);
      toast._agAcLocalToastTimer = setTimeout(() => {
        toast.hidden = true;
      }, 3600);
    }
    const fb = (typeof root.getElementById === 'function' ? root.getElementById('ag-ac-feedback') : null)
      || root.querySelector?.('#ag-ac-feedback');
    if (fb && (tone === 'error' || tone === 'success')) {
      fb.textContent = String(message);
      fb.hidden = false;
      fb.className = 'ag-ns-note-box' + (tone === 'error' ? ' is-error' : '');
    }
  }

  function computeBalancedQuotaScore(acc) {
    if (!acc || acc.suspended) return { score: -1, valid: false, detail: null };
    const pools = Array.isArray(acc.quotaSnapshot?.pools) ? acc.quotaSnapshot.pools.filter(Boolean) : [];
    if (!pools.length) return { score: -1, valid: false, detail: null };

    const pickBucketPct = (pool, targetWin) => {
      if (!pool || pool.noPermission) return null;
      const bkts = Array.isArray(pool.buckets) ? pool.buckets.filter(Boolean) : [];
      const hit = bkts.find((b) => {
        const wk = String(b.windowKey || '').toLowerCase();
        const ws = String(b.windowShort || '').toLowerCase();
        const bid = String(b.bucketId || '').toLowerCase();
        if (targetWin === '5h') return wk === '5h' || ws === '5h' || bid.includes('5h') || bid.includes('hour');
        return wk === 'weekly' || ws === '7d' || bid.includes('week') || bid.includes('7d');
      }) || null;
      const frac = hit ? hit.remainingFraction : null;
      if (frac !== null && frac !== undefined && Number.isFinite(Number(frac))) {
        return Math.max(0, Math.min(100, Number(frac) * 100));
      }
      return null;
    };

    const scorePool = (pool) => {
      if (!pool || pool.noPermission) return null;
      const p5 = pickBucketPct(pool, '5h');
      const p7 = pickBucketPct(pool, 'weekly');
      if (p5 !== null && p7 !== null) {
        const bottleneckPenalty = Math.min(p5, p7) <= 5 ? 30 : 0;
        return Math.max(0, 0.55 * p5 + 0.45 * p7 - bottleneckPenalty);
      }
      if (p5 !== null) return p5;
      if (p7 !== null) return p7;
      if (pool.remainingFraction !== null && pool.remainingFraction !== undefined && Number.isFinite(Number(pool.remainingFraction))) {
        return Math.max(0, Math.min(100, Number(pool.remainingFraction) * 100));
      }
      return null;
    };

    const gemPool = pools.find((p) => p.poolKey === 'shared_gemini_main') || null;
    const p3Pool = pools.find((p) => p.poolKey === 'shared_3p_pool') || null;
    const gemScore = scorePool(gemPool);
    const p3Score = scorePool(p3Pool);

    let weightedSum = 0;
    let weightTotal = 0;
    if (gemScore !== null) { weightedSum += gemScore * 1.0; weightTotal += 1.0; }
    if (p3Score !== null) { weightedSum += p3Score * 0.85; weightTotal += 0.85; }
    if (weightTotal === 0) {
      let bestFallback = -1;
      for (const pl of pools) {
        const s = scorePool(pl);
        if (s !== null && s > bestFallback) bestFallback = s;
      }
      if (bestFallback < 0) return { score: -1, valid: false, detail: null };
      return { score: Math.round(bestFallback), valid: true, detail: { fallback: bestFallback } };
    }
    const finalScore = weightedSum / weightTotal;
    return {
      score: Math.round(finalScore),
      rawScore: finalScore,
      valid: true,
      detail: { gemScore, p3Score }
    };
  }

  function pickBestQuotaAccount(accounts = []) {
    const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
    const activeAcc = list.find((a) => Boolean(a.isActive)) || null;
    let bestOverall = null;
    let bestOverallScore = -1;
    let bestSwitchable = null;
    let bestSwitchableScore = -1;
    let activeScore = -1;

    for (const acc of list) {
      if (acc.suspended) continue;
      const scored = computeBalancedQuotaScore(acc);
      if (!scored.valid) continue;
      const val = scored.rawScore ?? scored.score;
      if (acc.isActive) activeScore = val;
      if (val > bestOverallScore) {
        bestOverallScore = val;
        bestOverall = { acc, score: scored.score, rawScore: val };
      }
      const canSwitch = !acc.isActive && acc.hasRefreshToken !== false && !acc.authInvalid;
      if (canSwitch && val > bestSwitchableScore) {
        bestSwitchableScore = val;
        bestSwitchable = { acc, score: scored.score, rawScore: val };
      }
    }

    return { activeAcc, activeScore, bestOverall, bestSwitchable };
  }

  function sleepAbortable(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      refreshAllState.waitResolve = resolve;
      refreshAllState.waitTimer = setTimeout(() => {
        refreshAllState.waitTimer = null;
        refreshAllState.waitResolve = null;
        resolve();
      }, delay);
    });
  }

  function cancelRefreshAllAccounts() {
    if (!refreshAllState.running) return false;
    refreshAllState.cancelled = true;
    if (refreshAllState.waitTimer) {
      clearTimeout(refreshAllState.waitTimer);
      refreshAllState.waitTimer = null;
    }
    if (typeof refreshAllState.waitResolve === 'function') {
      const r = refreshAllState.waitResolve;
      refreshAllState.waitResolve = null;
      try { r(); } catch { }
    }
    syncAccountsTopPillButtons(accountsPageShadow || accountsPageEl, typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : null);
    return true;
  }

  function syncAccountsTopPillButtons(acRoot, acData) {
    if (!acRoot) return;
    const findNode = (id) => (typeof acRoot.getElementById === 'function' ? acRoot.getElementById(id) : null) || acRoot.querySelector?.(`#${id}`);
    const rfBtn = findNode('ag-ac-btn-refresh');
    if (rfBtn) {
      rfBtn.classList?.add?.('ag-ac-pill-btn', 'ag-ac-refresh-progress-btn');
      rfBtn.classList?.toggle?.('is-running', Boolean(refreshAllState.running));
      rfBtn.classList?.toggle?.('is-spinning', Boolean(refreshAllState.running));
      const lblSpan = rfBtn.querySelector?.('span');
      if (lblSpan) {
        lblSpan.removeAttribute?.('data-i18n');
        lblSpan.textContent = refreshAllState.running
          ? tu('refreshProgress', { done: Math.min(refreshAllState.total, refreshAllState.done + 1), total: refreshAllState.total })
          : tu('refreshAll');
      }
      rfBtn.title = refreshAllState.running ? tu('cancelRefresh') : tu('refreshAll');
    }
    const cancelBtn = findNode('ag-ac-btn-refresh-cancel');
    if (cancelBtn) {
      cancelBtn.hidden = !refreshAllState.running;
      if (cancelBtn.style) cancelBtn.style.display = refreshAllState.running ? 'inline-flex' : 'none';
      cancelBtn.textContent = tu('cancelRefresh');
    }
    const bestBtn = findNode('ag-ac-btn-switch-best');
    if (bestBtn) {
      const bestSpan = bestBtn.querySelector?.('.ag-ac-switch-best-lbl');
      if (bestSpan) bestSpan.textContent = tu('switchBestBtn');
      bestBtn.title = tu('switchBestBtn');
      bestBtn.disabled = Boolean(acData?.busy || refreshAllState.running);
    }
  }

  function ensureAutoSwitchMasterToggle(acRoot, acData) {
    if (!acRoot) return;
    const findNode = (id) => (typeof acRoot.getElementById === 'function' ? acRoot.getElementById(id) : null) || acRoot.querySelector?.(`#${id}`);
    const secEl = findNode('ag-ns-sec-accounts');
    if (!secEl) return;
    const bodyEl = secEl.querySelector?.('.ag-ac-details-body');
    if (!bodyEl) return;
    let chk = findNode('ag-ns-chk-autoSwitchEnabled');
    if (!chk && typeof document !== 'undefined') {
      const row = document.createElement('div');
      row.className = 'ag-ns-row';
      row.id = 'ag-ns-row-autoSwitchEnabled';
      row.innerHTML = `
        <div class="ag-ns-row-text">
          <div id="ag-ns-lbl-autoSwitchEnabled-title" class="ag-ns-row-title">${tu('autoSwitchToggleTitle')}</div>
          <div id="ag-ns-lbl-autoSwitchEnabled-desc" class="ag-ns-row-desc">${tu('autoSwitchToggleDesc')}</div>
        </div>
        <div class="ag-ns-control">
          <input type="checkbox" id="ag-ns-chk-autoSwitchEnabled" class="ag-ac-autoswitch-toggle" />
        </div>
      `;
      if (bodyEl.firstElementChild) bodyEl.insertBefore(row, bodyEl.firstElementChild);
      else bodyEl.appendChild(row);
      chk = findNode('ag-ns-chk-autoSwitchEnabled');
      if (chk && !chk.__agHsAutoSwitchBound) {
        chk.__agHsAutoSwitchBound = true;
        chk.addEventListener?.('change', () => {
          if (typeof onNativeSettingChange === 'function') {
            onNativeSettingChange('autoSwitchEnabled', Boolean(chk.checked), { sourceEl: chk });
          }
        });
      }
    }
    const titleEl = findNode('ag-ns-lbl-autoSwitchEnabled-title');
    const descEl = findNode('ag-ns-lbl-autoSwitchEnabled-desc');
    if (titleEl) titleEl.textContent = tu('autoSwitchToggleTitle');
    if (descEl) descEl.textContent = tu('autoSwitchToggleDesc');
    if (chk && acRoot.activeElement !== chk) {
      const enabledVal = acData?.rules?.autoSwitchEnabled ?? acData?.autoSwitch?.enabled;
      if (enabledVal !== undefined) chk.checked = Boolean(enabledVal);
    }
  }

  function enhanceAccountsPageToolbar(acRoot) {
    if (!acRoot || typeof document === 'undefined') return;
    const findNode = (id) => (typeof acRoot.getElementById === 'function' ? acRoot.getElementById(id) : null) || acRoot.querySelector?.(`#${id}`);
    const rfBtn = findNode('ag-ac-btn-refresh');
    if (rfBtn && !rfBtn.__agHsUpgraded) {
      rfBtn.__agHsUpgraded = true;
      rfBtn.setAttribute?.('data-ag-ac-action', 'refreshAll');
      const lblSpan = rfBtn.querySelector?.('span');
      if (lblSpan) {
        lblSpan.removeAttribute?.('data-i18n');
        lblSpan.textContent = tu('refreshAll');
      }
      const parent = rfBtn.parentElement;
      if (parent && !findNode('ag-ac-btn-refresh-cancel')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.id = 'ag-ac-btn-refresh-cancel';
        cancelBtn.className = 'ag-ns-btn ag-ac-cancel-pill';
        cancelBtn.hidden = true;
        if (cancelBtn.style) cancelBtn.style.display = 'none';
        cancelBtn.textContent = tu('cancelRefresh');
        cancelBtn.addEventListener?.('click', (e) => {
          e?.stopPropagation?.();
          cancelRefreshAllAccounts();
        });
        if (typeof rfBtn.after === 'function') rfBtn.after(cancelBtn);
        else parent.appendChild(cancelBtn);
      }
      if (parent && !findNode('ag-ac-btn-switch-best')) {
        const bestBtn = document.createElement('button');
        bestBtn.type = 'button';
        bestBtn.id = 'ag-ac-btn-switch-best';
        bestBtn.className = 'ag-ns-btn ag-ac-pill-btn ag-ac-switch-best-btn';
        bestBtn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 1.8 3.6 9h4.2l-.9 5.2L12.4 7H8.2l1-5.2Z"/></svg><span class="ag-ac-switch-best-lbl">${tu('switchBestBtn')}</span>`;
        bestBtn.addEventListener?.('click', (e) => {
          e?.stopPropagation?.();
          void switchToBestQuotaAccount();
        });
        const anchorNode = findNode('ag-ac-btn-refresh-cancel') || rfBtn;
        if (typeof anchorNode.after === 'function') anchorNode.after(bestBtn);
        else parent.appendChild(bestBtn);
      }
    }
    syncAccountsTopPillButtons(acRoot, typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : null);
  }

  async function refreshAllAccounts() {
    const acRoot = accountsPageShadow || accountsPageEl;
    if (refreshAllState.running) {
      cancelRefreshAllAccounts();
      return { ok: false, cancelled: true };
    }
    const snap = typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : null;
    const allAccounts = Array.isArray(snap?.accounts) ? snap.accounts.filter((a) => a && a.email && !a.suspended) : [];
    if (!allAccounts.length) {
      showAccountsLocalToast(acRoot, tu('refreshAllEmpty'), 'info');
      return { ok: false, empty: true, total: 0, okCount: 0, failCount: 0 };
    }
    const ordered = [
      ...allAccounts.filter((a) => Boolean(a.isActive)),
      ...allAccounts.filter((a) => !a.isActive)
    ];

    const mySeq = ++refreshAllState.seq;
    refreshAllState.running = true;
    refreshAllState.cancelled = false;
    refreshAllState.done = 0;
    refreshAllState.total = ordered.length;
    refreshAllState.okCount = 0;
    refreshAllState.failCount = 0;
    refreshAllState.currentEmail = '';
    refreshAllState.errors = [];
    syncAccountsTopPillButtons(acRoot, snap);

    const throttleMs = Number.isFinite(Number(refreshAllThrottleMs)) ? Math.max(0, Number(refreshAllThrottleMs)) : 260;

    try {
      for (let i = 0; i < ordered.length; i++) {
        if (disposed || refreshAllState.cancelled || refreshAllState.seq !== mySeq) break;
        const acc = ordered[i];
        refreshAllState.done = i;
        refreshAllState.currentEmail = acc.email;
        syncAccountsTopPillButtons(acRoot, typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : snap);

        const canRefresh = Boolean(acc.isActive || acc.hasRefreshToken);
        if (!canRefresh) {
          refreshAllState.failCount += 1;
          refreshAllState.errors.push({ email: acc.email, error: tu('noRefreshCred') });
          refreshAllState.done = i + 1;
          continue;
        }

        if (acRoot && typeof beginAccountQuotaRefreshMotion === 'function') {
          try { beginAccountQuotaRefreshMotion(acRoot, acc.email); } catch { }
        }

        let res = null;
        let usedMainAction = false;
        try {
          if (typeof refreshSingleAccountForAll === 'function') {
            res = await refreshSingleAccountForAll(acc);
          } else if (typeof window !== 'undefined' && typeof window?.contextMeterAPI?.accountsAction === 'function') {
            res = await window.contextMeterAPI.accountsAction({
              action: 'refresh_quota',
              email: acc.email,
              force: true,
              manual: true
            });
          } else if (typeof onAccountsPageAction === 'function') {
            usedMainAction = true;
            const ret = onAccountsPageAction('refreshAccount', {
              email: acc.email,
              isActive: Boolean(acc.isActive),
              hasRefreshToken: Boolean(acc.hasRefreshToken)
            });
            if (ret && typeof ret.then === 'function') {
              res = await ret;
            } else {
              res = { ok: true };
            }
          } else {
            res = { ok: false, error: 'refresh_unavailable' };
          }
        } catch (err) {
          res = { ok: false, error: err?.message || String(err || 'refresh_error') };
        }

        const isOk = Boolean(res && res.ok !== false);
        if (isOk) {
          refreshAllState.okCount += 1;
        } else {
          refreshAllState.failCount += 1;
          refreshAllState.errors.push({
            email: acc.email,
            error: String(res?.error || res?.message || 'refresh_failed')
          });
        }

        if (!usedMainAction && acRoot && typeof completeAccountQuotaRefreshMotion === 'function') {
          const latestSnap = typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : snap;
          try {
            completeAccountQuotaRefreshMotion(acRoot, acc.email, {
              ok: isOk,
              data: latestSnap
            });
          } catch { }
        }

        refreshAllState.done = i + 1;
        syncAccountsTopPillButtons(acRoot, typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : snap);

        if (i < ordered.length - 1 && !refreshAllState.cancelled && !disposed) {
          await sleepAbortable(throttleMs);
        }
      }
    } finally {
      const wasCancelled = Boolean(refreshAllState.cancelled);
      const summary = {
        ok: !wasCancelled && refreshAllState.failCount === 0,
        partialOk: !wasCancelled && refreshAllState.okCount > 0 && refreshAllState.failCount > 0,
        cancelled: wasCancelled,
        done: refreshAllState.done,
        total: refreshAllState.total,
        okCount: refreshAllState.okCount,
        failCount: refreshAllState.failCount,
        errors: refreshAllState.errors.slice()
      };
      refreshAllState.running = false;
      refreshAllState.currentEmail = '';
      syncAccountsTopPillButtons(acRoot, typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : snap);

      if (wasCancelled) {
        showAccountsLocalToast(acRoot, tu('refreshAllCancelled', { done: summary.done, total: summary.total }), 'info');
      } else if (summary.failCount > 0) {
        const firstReason = summary.errors[0]?.error || '';
        showAccountsLocalToast(acRoot, tu('refreshAllPartial', { ok: summary.okCount, fail: summary.failCount, reason: firstReason }), 'error');
      } else {
        showAccountsLocalToast(acRoot, tu('refreshAllDone', { ok: summary.okCount, total: summary.total }), 'success');
      }
      return summary;
    }
  }

  function switchToBestQuotaAccount() {
    const acRoot = accountsPageShadow || accountsPageEl;
    const snap = typeof getAccountsPageSnapshot === 'function' ? getAccountsPageSnapshot() : null;
    const accounts = Array.isArray(snap?.accounts) ? snap.accounts : [];
    const { activeAcc, activeScore, bestOverall, bestSwitchable } = pickBestQuotaAccount(accounts);

    if (activeAcc && bestOverall && bestOverall.acc.email === activeAcc.email) {
      showAccountsLocalToast(acRoot, tu('switchBestAlready'), 'info');
      return { ok: true, alreadyBest: true, targetEmail: activeAcc.email, score: bestOverall.score };
    }
    if (!bestSwitchable) {
      showAccountsLocalToast(acRoot, activeAcc ? tu('switchBestAlready') : tu('switchBestNone'), 'info');
      return { ok: false, alreadyBest: Boolean(activeAcc), reason: 'no_eligible_account' };
    }
    if (activeAcc && activeScore >= 0 && activeScore >= bestSwitchable.rawScore) {
      showAccountsLocalToast(acRoot, tu('switchBestAlready'), 'info');
      return { ok: true, alreadyBest: true, targetEmail: activeAcc.email, score: Math.round(activeScore) };
    }

    const targetAcc = bestSwitchable.acc;
    const displayTarget = snap?.hideEmail
      ? (targetAcc.maskedEmail || targetAcc.email)
      : (targetAcc.email || targetAcc.maskedEmail);
    showAccountsLocalToast(acRoot, tu('switchBestTrigger', { target: displayTarget, score: bestSwitchable.score }), 'success');

    if (typeof onAccountsPageAction === 'function') {
      onAccountsPageAction('switchAccount', { email: targetAcc.email, account: targetAcc });
    } else if (typeof onNativeAction === 'function') {
      onNativeAction('switchAccount', { email: targetAcc.email, account: targetAcc });
    }
    return { ok: true, switched: true, targetEmail: targetAcc.email, score: bestSwitchable.score };
  }

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

  function notifyHostModalVisibility(isOpen) {
    const next = Boolean(isOpen);
    if (next === lastReportedModalOpen) return;
    lastReportedModalOpen = next;
    try { onHostModalVisibilityChange?.(next); } catch { }
  }

  function ensureStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    const alignedNavCss = typeof window?.AGHostSettingsNavAlign?.buildAlignedHostSettingsNavCss === 'function'
      ? window.AGHostSettingsNavAlign.buildAlignedHostSettingsNavCss([NAV_ID, NAV_COMPACT_ID, NAV_ACCOUNTS_ID])
      : `
      #${NAV_ID},
      #${NAV_COMPACT_ID},
      #${NAV_ACCOUNTS_ID} {
        display: flex !important;
        align-items: center !important;
        width: 100% !important;
        text-align: left !important;
        cursor: pointer !important;
        font-family: inherit !important;
        font-size: inherit !important;
        font-weight: inherit !important;
        line-height: inherit !important;
        letter-spacing: inherit !important;
      }
      #${NAV_ID} > .ag-hs-nav-label,
      #${NAV_COMPACT_ID} > .ag-hs-nav-label,
      #${NAV_ACCOUNTS_ID} > .ag-hs-nav-label {
        pointer-events: none !important;
        font-family: inherit !important;
        font-size: inherit !important;
        font-weight: inherit !important;
        line-height: inherit !important;
        letter-spacing: inherit !important;
        color: inherit !important;
      }
      #${NAV_ID}[data-active="false"],
      #${NAV_COMPACT_ID}[data-active="false"],
      #${NAV_ACCOUNTS_ID}[data-active="false"] {
        background: transparent !important;
        background-color: transparent !important;
      }
      #${NAV_ID}[data-active="true"],
      #${NAV_COMPACT_ID}[data-active="true"],
      #${NAV_ACCOUNTS_ID}[data-active="true"] {
        background: var(--ag-hs-active-bg, var(--sidebar-secondary, var(--vscode-list-activeSelectionBackground, color-mix(in srgb, var(--primary, var(--ag-host-accent, #3274f6)) 16%, transparent)))) !important;
        color: var(--ag-hs-active-color, var(--vscode-list-activeSelectionForeground, var(--foreground, inherit))) !important;
        opacity: 1 !important;
      }`;
    style.textContent = `
      ${alignedNavCss}
      [data-ag-hs-custom-active="true"] button[id^="settings-nav-item-"],
      [data-ag-hs-custom-active="true"] button[data-testid^="settings-nav-item-"],
      [data-ag-hs-custom-active="true"] [role="tab"]:not(#${NAV_ID}):not(#${NAV_COMPACT_ID}):not(#${NAV_ACCOUNTS_ID}),
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
      [data-ag-cm-host-open="true"] [data-ag-cm-right-pane="true"] > :not(#${PAGE_ID}):not(#${PAGE_COMPACT_ID}):not(#${PAGE_ACCOUNTS_ID}):not(button):not([data-testid*="close"]):not([aria-label*="Close" i]):not([aria-label*="关闭"]):not([aria-label*="關閉"]) {
        display: none !important;
      }
      #${PAGE_ID}[hidden],
      #${PAGE_COMPACT_ID}[hidden],
      #${PAGE_ACCOUNTS_ID}[hidden] {
        display: none !important;
      }
      #${PAGE_ID},
      #${PAGE_COMPACT_ID},
      #${PAGE_ACCOUNTS_ID} {
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
      [data-ag-cm-host-open="true"] #${PAGE_ID}:not([hidden]),
      [data-ag-cm-host-open="true"] #${PAGE_COMPACT_ID}:not([hidden]),
      [data-ag-cm-host-open="true"] #${PAGE_ACCOUNTS_ID}:not([hidden]) {
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
      node.id === 'ag-sidebar-account-host' ||
      node.id === NAV_ID ||
      node.id === NAV_COMPACT_ID ||
      node.id === NAV_ACCOUNTS_ID ||
      node.id === PAGE_ID ||
      node.id === PAGE_COMPACT_ID ||
      node.id === PAGE_ACCOUNTS_ID ||
      node.getAttribute?.(NAV_WRAPPER_ATTR) === 'true' ||
      node.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) === 'true' ||
      node.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) === 'true'
    ) return true;
    return Boolean(
      typeof node.closest === 'function' &&
      node.closest(`#ag-context-meter, #ag-context-meter-radial-host, #ag-context-meter-modal-host, #ag-sidebar-account-host, #${NAV_ID}, #${NAV_COMPACT_ID}, #${NAV_ACCOUNTS_ID}, #${PAGE_ID}, #${PAGE_COMPACT_ID}, #${PAGE_ACCOUNTS_ID}, [${NAV_WRAPPER_ATTR}="true"], [${NAV_COMPACT_WRAPPER_ATTR}="true"], [${NAV_ACCOUNTS_WRAPPER_ATTR}="true"]`)
    );
  }

  function isHostNavTestId(node) {
    if (!node) return false;
    const id = String(node.id || '');
    const tid = String(node.getAttribute?.('data-testid') || '');
    return id.startsWith('settings-nav-item-') || tid.startsWith('settings-nav-item-');
  }

  function getNavButtons(container) {
    if (!container) return [];
    const notOurs = (b) => b && b.id !== NAV_ID && b.id !== NAV_COMPACT_ID && b.id !== NAV_ACCOUNTS_ID && !isPluginOwnedNode(b);
    if (typeof container.querySelectorAll === 'function') {
      const explicit = Array.from(container.querySelectorAll('button[id^="settings-nav-item-"], button[data-testid^="settings-nav-item-"]') || [])
        .filter(notOurs);
      if (explicit.length > 0) return explicit;
      const fallback = Array.from(container.querySelectorAll('button, [role="tab"]') || [])
        .filter(notOurs);
      return fallback;
    }
    return Array.from(container.children || []).filter(notOurs);
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
    if (node.id === PAGE_ID || node.id === PAGE_COMPACT_ID || node.id === PAGE_ACCOUNTS_ID || node.tagName === 'STYLE' || isPluginOwnedNode(node)) return true;
    if (node.tagName === 'BUTTON') return true;
    const testId = String(node.getAttribute?.('data-testid') || '');
    const ariaLbl = String(node.getAttribute?.('aria-label') || '');
    const cls = String(node.className || '');
    if (/close/i.test(testId) || /close|关闭|關閉/i.test(ariaLbl)) return true;
    if (/\bclose\b/i.test(cls) && !node.children?.length) return true;
    return false;
  }

  // PR #126 & Issue #124: 宿主原生设置分类标签集合与显式设置弹窗信号判定
  const SETTINGS_CATEGORY_LABEL_RE = /^(?:general|browser|account|models?|appearance|keybindings?|shortcuts?|notifications?|privacy|agent|editor|terminal|mcp|extensions?|plugins?|billing|通用|应用|应用设置|應用|應用設定|浏览器|瀏覽器|账号|帳號|账户|帳戶|模型|外观|外觀|快捷键|快捷鍵|通知|隐私|隱私|代理|编辑器|編輯器|终端|終端|扩展|擴展|插件)$/i;

  function hasExplicitSettingsModalSignal(modal, browserBtn, navBtns) {
    if (!modal) return false;
    const cls = String(modal.className || '');
    if (/\bsettings-modal-container\b/.test(cls)) return true;
    if (browserBtn) return true;
    if (Array.isArray(navBtns) && navBtns.some((b) => isHostNavTestId(b))) return true;
    if (typeof modal.querySelector === 'function') {
      if (modal.querySelector('[data-testid="settings-sidebar"], #settings-nav-item-Browser, [data-testid="settings-nav-item-Browser"], button[id^="settings-nav-item-"], button[data-testid^="settings-nav-item-"], [data-settings-content-pane="true"], .settings-content-pane')) {
        return true;
      }
    }
    return false;
  }

  function getMatchedSettingsCategoryButtons(navBtns) {
    return (Array.isArray(navBtns) ? navBtns : []).filter((b) => {
      const label = String(b?.textContent || '').replace(/\s+/g, ' ').trim();
      return Boolean(label && SETTINGS_CATEGORY_LABEL_RE.test(label));
    });
  }

  /**
   * 严格校验候选模态框是否为真正的宿主设置弹窗，防止把归档通知、普通 [role="dialog"] 确认框或 macOS 归档 toast 误判为 Settings（PR #126 / Issue #124）
   */
  function isLikelyRealHostSettingsModal(modal) {
    if (!modal || isPluginOwnedNode(modal)) return false;
    const role = String(modal.getAttribute?.('role') || '').toLowerCase();
    if (role === 'alertdialog' || role === 'status' || role === 'alert') return false;
    if (modal.hasAttribute?.('aria-live') && String(modal.getAttribute?.('aria-live') || '').toLowerCase() !== 'off') {
      return false;
    }
    const cls = String(modal.className || '');
    const testId = String(modal.getAttribute?.('data-testid') || '');
    if (/\btoast\b|\bsnackbar\b|\bnotification\b|\barchive\b|\btoaster\b|\bsonner\b/i.test(`${cls} ${testId}`)) return false;
    if (modal.classList?.contains?.('settings-modal-container')) return true;
    const btns = getNavButtons(modal);
    const hasExplicitSettingsAnchor = hasExplicitSettingsModalSignal(modal, null, btns);
    if (hasExplicitSettingsAnchor) return true;
    // 明确排除归档通知卡片及多条叠加的通知栈（例如 "Conversation Archived / View archived in the sidebar / Undo / Dismiss"）
    if (modal.querySelector?.('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]')) {
      return false;
    }
    const rawText = String(modal.textContent || '');
    if (/conversation\s+archived|view\s+archived|archived\s+in\s+the\s+sidebar|对话已归档|對話已歸檔|已归档会话|已歸檔會話/i.test(rawText)) {
      return false;
    }
    // 无显式 settings-sidebar 时，如果渲染尺寸明显是右侧窄条 toast/通知卡或小确认框，严禁挂载设置页
    if (typeof modal.getBoundingClientRect === 'function') {
      try {
        const rect = modal.getBoundingClientRect();
        if (rect && Number(rect.width) > 0 && Number(rect.width) < 420) return false;
      } catch { }
    }
    // 兼容无 data-testid 的降级结构：必须至少命中 2 个不同标准宿主设置分类页签，且绝不能是归档/撤销/确认/关闭通知框
    if (btns.length < 2) return false;
    const nonSettingsActionRe = /^(dismiss|undo|archive|unarchive|view\s+archive|cancel|confirm|continue|proceed|ok|yes|no|close|delete|remove|×|✕|关闭|關閉|取消|确认|確認|继续|繼續|撤销|撤銷|归档|歸檔|查看归档|查看歸檔|知道了|忽略)$/i;
    const nonSettingsActionCount = btns.filter((b) => nonSettingsActionRe.test(String(b.textContent || b.getAttribute?.('aria-label') || '').trim())).length;
    if (nonSettingsActionCount > 0 && nonSettingsActionCount >= Math.max(1, btns.length - 1)) return false;
    const matchedBtns = getMatchedSettingsCategoryButtons(btns);
    const matchedNavNames = new Set(matchedBtns.map((b) => String(b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    return matchedNavNames.size >= 2;
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
      if (!isLikelyRealHostSettingsModal(modal)) continue;
      const browserBtn = modal.querySelector?.('#settings-nav-item-Browser, [data-testid="settings-nav-item-Browser"]') || (browserById && (modal.contains?.(browserById) || browserById.parentElement?.parentElement === modal) ? browserById : null);
      const navBtns = getNavButtons(modal);
      if (!browserBtn && navBtns.length === 0) continue;
      const isExplicitSettingsModal = hasExplicitSettingsModalSignal(modal, browserBtn, navBtns);
      const matchedCategoryBtns = getMatchedSettingsCategoryButtons(navBtns);
      if (!isExplicitSettingsModal && matchedCategoryBtns.length < 2) continue;
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
        // PR #126 / Issue #124: 严禁回退到盲选 navBtns[0]，仅使用标准宿主设置分类或带 settings-nav-item-* 标记的锚点
        const sampleBtn = matchedCategoryBtns[0]
          || (isExplicitSettingsModal ? navBtns.find((b) => isHostNavTestId(b)) : null);
        if (!sampleBtn) continue;
        const directParent = sampleBtn.parentElement;
        const grandParent = directParent?.parentElement;
        navList = (grandParent && modal.contains?.(grandParent) && grandParent !== modal && getNavButtons(grandParent).length > getNavButtons(directParent).length)
          ? grandParent
          : directParent;
      }
      if (!navList || navList === modal || (typeof modal.contains === 'function' && !modal.contains(navList))) continue;
      const anchorBtn = findBrowserAnchorButton(navList, browserBtn);
      const contentPane = findContentPane(modal, navList);
      if (!contentPane || contentPane === navList || contentPane === modal || (typeof modal.contains === 'function' && !modal.contains(contentPane))) continue;
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
    btn.classList.remove(
      'active', 'is-active', 'selected',
      'bg-accent', 'bg-ide-input-background', 'bg-sidebar-secondary', 'bg-sidebar-accent', 'bg-muted',
      'text-foreground', 'text-white', 'font-semibold', 'font-bold', 'font-medium'
    );
  }

  function sanitizeNavBaseClass(anchorBtn) {
    return String(anchorBtn?.className || '')
      .replace(/\b(bg-sidebar-secondary|bg-sidebar-accent|bg-ide-input-background|bg-accent|bg-muted|is-active|active|selected|text-foreground|text-white|font-semibold|font-bold|font-medium)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function syncPluginNavTypography(preferredAnchorBtn = null) {
    try {
      const navAlign = typeof window !== 'undefined' ? window.AGHostSettingsNavAlign : null;
      const scope = activeNavList || activeSidebar || activeModal;
      const nativeBtns = getNavButtons(scope);
      const anchor = preferredAnchorBtn || findBrowserAnchorButton(activeNavList, null) || nativeBtns[0] || null;
      const pluginBtns = [navButtonEl, compactNavButtonEl, accountsNavButtonEl].filter(Boolean);
      if (!pluginBtns.length) return;
      if (typeof navAlign?.alignHostSettingsNavTypography === 'function') {
        const picked = typeof navAlign.pickUnselectedNativeNavRef === 'function'
          ? navAlign.pickUnselectedNativeNavRef(nativeBtns, anchor)
          : { unselectedRef: anchor, activeRef: null };
        if (picked.unselectedRef) {
          navAlign.alignHostSettingsNavTypography(picked.unselectedRef, pluginBtns, typeof window !== 'undefined' ? window : null, {
            activeNativeRefBtn: picked.activeRef
          });
        }
      }
    } catch { }
  }

  function syncNavHighlightState(active, opts = {}) {
    const { clickedNativeBtn = null } = opts;
    const isSettingsActive = Boolean(active && activeCustomPage === 'settings');
    const isCompactActive = Boolean(active && activeCustomPage === 'compaction');
    const isAccountsActive = Boolean(active && activeCustomPage === 'accounts');
    if (navButtonEl) {
      navButtonEl.setAttribute('data-active', isSettingsActive ? 'true' : 'false');
      navButtonEl.setAttribute('aria-selected', isSettingsActive ? 'true' : 'false');
      if (!isSettingsActive) clearNavBtnActiveClasses(navButtonEl);
    }
    if (compactNavButtonEl) {
      compactNavButtonEl.setAttribute('data-active', isCompactActive ? 'true' : 'false');
      compactNavButtonEl.setAttribute('aria-selected', isCompactActive ? 'true' : 'false');
      if (!isCompactActive) clearNavBtnActiveClasses(compactNavButtonEl);
      const compactLbl = compactNavButtonEl.querySelector?.('.ag-hs-nav-label');
      if (compactLbl) compactLbl.textContent = t('compactProgress.navLabel');
    }
    if (accountsNavButtonEl) {
      accountsNavButtonEl.setAttribute('data-active', isAccountsActive ? 'true' : 'false');
      accountsNavButtonEl.setAttribute('aria-selected', isAccountsActive ? 'true' : 'false');
      if (!isAccountsActive) clearNavBtnActiveClasses(accountsNavButtonEl);
      const accLbl = accountsNavButtonEl.querySelector?.('.ag-hs-nav-label');
      if (accLbl) accLbl.textContent = t('accountsPage.navLabel');
    }
    const navScope = activeSidebar || activeModal || activeNavList;
    if (navScope) {
      if (active) navScope.setAttribute?.('data-ag-hs-custom-active', 'true');
      else navScope.removeAttribute?.('data-ag-hs-custom-active');
    }
    if (!navScope) return;
    for (const btn of getNavButtons(navScope)) {
      if (!btn || btn === navButtonEl || btn === compactNavButtonEl || btn === accountsNavButtonEl) continue;
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
    syncPluginNavTypography();
  }

  function getActiveUiRoot() {
    return pageShadow || pageEl;
  }

  function syncThemeToPageHost() {
    if (typeof syncThemeTarget === 'function') {
      if (pageEl) {
        try { syncThemeTarget(pageEl); } catch { }
      }
      if (compactPageEl) {
        try { syncThemeTarget(compactPageEl); } catch { }
      }
      if (accountsPageEl) {
        try { syncThemeTarget(accountsPageEl); } catch { }
      }
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
    const isCompact = activeCustomPage === 'compaction';
    const isAccounts = activeCustomPage === 'accounts';
    const curPage = isCompact ? compactPageEl : (isAccounts ? accountsPageEl : pageEl);
    const curBtn = isCompact ? compactNavButtonEl : (isAccounts ? accountsNavButtonEl : navButtonEl);
    if (!curPage || curPage.isConnected === false || curPage.hidden) return false;
    if (typeof activeContentPane.contains === 'function' && !activeContentPane.contains(curPage)) return false;
    if (curBtn?.getAttribute?.('data-active') !== 'true') return false;
    if (activeCustomPage === 'settings' && !findElInPage('ag-ns-root')) return false;
    if (activeCustomPage === 'accounts' && !findElInPage('ag-ac-root')) return false;
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
    if (compactPageEl && typeof compactPageEl.scrollTop === 'number') {
      savedCompactPageScrollTop = compactPageEl.scrollTop;
    }
    if (accountsPageEl && typeof accountsPageEl.scrollTop === 'number') {
      savedAccountsPageScrollTop = accountsPageEl.scrollTop;
    }
    hostSelected = false;
    activeCustomPage = null;
    activeModal?.removeAttribute?.('data-ag-cm-host-open');
    activeSplitRow?.removeAttribute?.('data-ag-cm-host-open');
    activeContentPane?.removeAttribute?.('data-ag-cm-host-open');
    if (pageEl) {
      setHiddenSafe(pageEl, true);
    }
    if (compactPageEl) {
      setHiddenSafe(compactPageEl, true);
    }
    if (accountsPageEl) {
      setHiddenSafe(accountsPageEl, true);
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
    const isCompact = activeCustomPage === 'compaction';
    const isAccounts = activeCustomPage === 'accounts';
    const isSettings = !isCompact && !isAccounts;
    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== activeContentPane) {
      activeContentPane.appendChild(pageEl);
    }
    if (!compactPageEl) createCompactPageElement();
    if (compactPageEl && compactPageEl.parentElement !== activeContentPane) {
      activeContentPane.appendChild(compactPageEl);
    }
    if (!accountsPageEl) createAccountsPageElement();
    if (accountsPageEl && accountsPageEl.parentElement !== activeContentPane) {
      activeContentPane.appendChild(accountsPageEl);
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
    setHiddenSafe(pageEl, !isSettings);
    if (compactPageEl) setHiddenSafe(compactPageEl, !isCompact);
    if (accountsPageEl) setHiddenSafe(accountsPageEl, !isAccounts);
    if (isSettings && savedPageScrollTop > 0 && typeof pageEl.scrollTop === 'number' && pageEl.scrollTop !== savedPageScrollTop) {
      pageEl.scrollTop = savedPageScrollTop;
    }
    if (isCompact && compactPageEl && savedCompactPageScrollTop > 0 && typeof compactPageEl.scrollTop === 'number' && compactPageEl.scrollTop !== savedCompactPageScrollTop) {
      compactPageEl.scrollTop = savedCompactPageScrollTop;
    }
    if (isAccounts && accountsPageEl && savedAccountsPageScrollTop > 0 && typeof accountsPageEl.scrollTop === 'number' && accountsPageEl.scrollTop !== savedAccountsPageScrollTop) {
      accountsPageEl.scrollTop = savedAccountsPageScrollTop;
    }
    syncThemeToPageHost();
    syncNavHighlightState(true);
    renderPage();
  }

  function activateHostPage(opts = {}) {
    clearPendingOpenWaiter();
    const targetCustomPage = opts?.page === 'compaction'
      ? 'compaction'
      : (opts?.page === 'accounts' ? 'accounts' : 'settings');
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
    activeCustomPage = targetCustomPage;
    applyHostPageActivePresentation();
    if (targetCustomPage === 'settings' && opts && opts.section) {
      scrollToSection(opts.section);
    } else if (targetCustomPage === 'settings' && pageEl && savedPageScrollTop > 0 && typeof pageEl.scrollTop === 'number') {
      pageEl.scrollTop = savedPageScrollTop;
    } else if (targetCustomPage === 'compaction' && compactPageEl && savedCompactPageScrollTop > 0 && typeof compactPageEl.scrollTop === 'number') {
      compactPageEl.scrollTop = savedCompactPageScrollTop;
    } else if (targetCustomPage === 'accounts' && accountsPageEl && savedAccountsPageScrollTop > 0 && typeof accountsPageEl.scrollTop === 'number') {
      accountsPageEl.scrollTop = savedAccountsPageScrollTop;
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
    try { onHostPageActivated?.({ section: opts?.section || null, page: targetCustomPage }); } catch { }
    return verifyHostPagePresented();
  }

  function bindNavButtonEvents(btn, targetPage = 'settings') {
    if (!btn || btn.__agHsCtrlToken === controllerToken) return btn;
    btn.__agHsCtrlToken = controllerToken;
    btn.addEventListener?.('click', (e) => {
      if (disposed) return;
      e?.stopPropagation?.();
      e?.preventDefault?.();
      activateHostPage({ page: targetPage });
    });
    btn.addEventListener?.('keydown', (e) => {
      if (disposed) return;
      const key = e?.key;
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        activateHostPage({ page: targetPage });
      }
    });
    return btn;
  }

  function createCompactNavButton(anchorBtn) {
    const btn = document.createElement('button');
    btn.id = NAV_COMPACT_ID;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-active', 'false');
    const baseClass = sanitizeNavBaseClass(anchorBtn);
    btn.className = baseClass ? `${baseClass} ag-cm-host-nav-item` : 'ag-cm-host-nav-item';
    btn.innerHTML = `<span class="ag-hs-nav-label" style="pointer-events:none">${t('compactProgress.navLabel')}</span>`;
    return bindNavButtonEvents(btn, 'compaction');
  }

  function createCompactPageElement() {
    const wrap = document.createElement('section');
    wrap.id = PAGE_COMPACT_ID;
    wrap.setAttribute('aria-label', t('compactProgress.navLabel'));
    wrap.tabIndex = 0;
    wrap.hidden = true;
    wrap.scrollTop = 0;
    wrap.addEventListener?.('scroll', () => {
      if (hostSelected && activeCustomPage === 'compaction' && typeof wrap.scrollTop === 'number') {
        savedCompactPageScrollTop = wrap.scrollTop;
      }
    }, { passive: true });
    compactPageShadow = typeof wrap.attachShadow === 'function' ? wrap.attachShadow({ mode: 'open' }) : null;
    const uiTarget = compactPageShadow || wrap;

    const cssText = typeof buildNativeSettingsPageCss === 'function'
      ? buildNativeSettingsPageCss()
      : ':host { display: block; width: 100%; height: 100%; overflow-y: auto; }';
    const htmlText = typeof buildCompactionProgressPageHtml === 'function'
      ? buildCompactionProgressPageHtml()
      : '<section id="ag-cp-root" class="ag-ns-page"><h1>压缩进度</h1></section>';

    const styleEl = document.createElement('style');
    styleEl.id = 'ag-cm-hs-compact-style';
    styleEl.textContent = cssText;

    if (compactPageShadow) {
      const containerWrap = document.createElement('div');
      containerWrap.innerHTML = htmlText;
      compactPageShadow.appendChild(styleEl);
      const kids = Array.from(containerWrap.children || []);
      if (kids.length > 0) {
        for (const kid of kids) compactPageShadow.appendChild(kid);
      } else {
        compactPageShadow.appendChild(containerWrap);
      }
    } else {
      wrap.innerHTML = htmlText;
    }

    const bindAction = (id, handler) => {
      const elNode = (uiTarget.getElementById ? uiTarget.getElementById(id) : null) || uiTarget.querySelector?.(`#${id}`);
      if (elNode && !elNode.__agCpBound) {
        elNode.__agCpBound = true;
        elNode.addEventListener?.('click', handler);
      }
    };
    bindAction('ag-cp-btn-open-settings', () => activateHostPage({ page: 'settings', section: 'rehydrate-hook-card' }));
    bindAction('ag-cp-btn-refresh', () => {
      if (typeof onNativeAction === 'function') onNativeAction('compactionRefresh', null);
    });
    bindAction('ag-cp-btn-manual-compact', () => {
      if (typeof onNativeAction === 'function') onNativeAction('manualCompactNow', null);
    });

    compactPageEl = wrap;
    return wrap;
  }

  function createAccountsNavButton(anchorBtn) {
    const btn = document.createElement('button');
    btn.id = NAV_ACCOUNTS_ID;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-active', 'false');
    const baseClass = sanitizeNavBaseClass(anchorBtn);
    btn.className = baseClass ? `${baseClass} ag-cm-host-nav-item` : 'ag-cm-host-nav-item';
    btn.innerHTML = `<span class="ag-hs-nav-label" style="pointer-events:none">${t('accountsPage.navLabel')}</span>`;
    return bindNavButtonEvents(btn, 'accounts');
  }

  function createAccountsPageElement() {
    const wrap = document.createElement('section');
    wrap.id = PAGE_ACCOUNTS_ID;
    wrap.setAttribute('aria-label', t('accountsPage.navLabel'));
    wrap.tabIndex = 0;
    wrap.hidden = true;
    wrap.scrollTop = 0;
    wrap.addEventListener?.('scroll', () => {
      if (hostSelected && activeCustomPage === 'accounts' && typeof wrap.scrollTop === 'number') {
        savedAccountsPageScrollTop = wrap.scrollTop;
      }
    }, { passive: true });
    accountsPageShadow = typeof wrap.attachShadow === 'function' ? wrap.attachShadow({ mode: 'open' }) : null;
    const uiTarget = accountsPageShadow || wrap;

    const cssText = typeof buildNativeSettingsPageCss === 'function'
      ? buildNativeSettingsPageCss()
      : ':host { display: block; width: 100%; height: 100%; overflow-y: auto; }';
    const htmlText = typeof buildHostAccountsPageHtml === 'function'
      ? buildHostAccountsPageHtml()
      : '<section id="ag-ac-root" class="ag-ns-page"><h1>账号与额度</h1></section>';

    const styleEl = document.createElement('style');
    styleEl.id = 'ag-cm-hs-accounts-style';
    styleEl.textContent = `${cssText}\n${buildAccountsUpgradeExtraCss()}`;

    if (accountsPageShadow) {
      const containerWrap = document.createElement('div');
      containerWrap.innerHTML = htmlText;
      accountsPageShadow.appendChild(styleEl);
      const kids = Array.from(containerWrap.children || []);
      if (kids.length > 0) {
        for (const kid of kids) accountsPageShadow.appendChild(kid);
      } else {
        accountsPageShadow.appendChild(containerWrap);
      }
    } else {
      wrap.innerHTML = htmlText;
    }

    enhanceAccountsPageToolbar(uiTarget);

    if (typeof initHostAccountsPage === 'function') {
      initHostAccountsPage(uiTarget, {
        onChange: (key, value, meta) => {
          if (typeof onNativeSettingChange === 'function') onNativeSettingChange(key, value, meta);
        },
        onAction: (actionName, payload) => {
          if (actionName === 'refreshCurrent' || actionName === 'refreshAll') {
            void refreshAllAccounts();
            return;
          }
          if (typeof onAccountsPageAction === 'function') {
            onAccountsPageAction(actionName, payload);
            return;
          }
          if (typeof onNativeAction === 'function') onNativeAction(actionName, payload);
        }
      });
    }

    accountsPageEl = wrap;
    return wrap;
  }

  function createNavButton(anchorBtn) {
    const btn = document.createElement('button');
    btn.id = NAV_ID;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-active', 'false');
    const baseClass = sanitizeNavBaseClass(anchorBtn);
    btn.className = baseClass ? `${baseClass} ag-cm-host-nav-item` : 'ag-cm-host-nav-item';
    btn.innerHTML = `<span class="ag-hs-nav-label" style="pointer-events:none">Context Meter</span>`;
    return bindNavButtonEvents(btn);
  }

  function findElInPage(id) {
    if (!id) return null;
    const searchRoots = [pageShadow, pageEl, accountsPageShadow, accountsPageEl, compactPageShadow, compactPageEl].filter(Boolean);
    for (const root of searchRoots) {
      if (typeof root.getElementById === 'function') {
        const hit = root.getElementById(id);
        if (hit) return hit;
      }
      if (typeof root.querySelector === 'function') {
        const hit = root.querySelector(`#${id}`);
        if (hit) return hit;
      }
    }
    if (pageEl) {
      const queue = Array.from(pageEl.children || []);
      while (queue.length) {
        const cur = queue.shift();
        if (!cur) continue;
        if (cur.id === id) return cur;
        if (cur.children && cur.children.length) queue.push(...Array.from(cur.children));
      }
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
    if (disposed) return;
    if (compactPageEl && typeof getCompactionProgressSnapshot === 'function' && typeof renderCompactionProgressPage === 'function') {
      const cpRoot = compactPageShadow || compactPageEl;
      if (typeof applyStaticTranslations === 'function') {
        try { applyStaticTranslations(cpRoot); } catch { }
      }
      const cpData = getCompactionProgressSnapshot();
      if (cpData) renderCompactionProgressPage(cpRoot, cpData);
    }
    if (compactNavButtonEl) {
      const lbl = compactNavButtonEl.querySelector?.('.ag-hs-nav-label');
      if (lbl) lbl.textContent = t('compactProgress.navLabel');
    }
    if (accountsPageEl && typeof getAccountsPageSnapshot === 'function' && typeof renderHostAccountsPage === 'function') {
      const acRoot = accountsPageShadow || accountsPageEl;
      if (typeof applyStaticTranslations === 'function') {
        try { applyStaticTranslations(acRoot); } catch { }
      }
      const acData = getAccountsPageSnapshot();
      if (acData) renderHostAccountsPage(acRoot, acData);
      enhanceAccountsPageToolbar(acRoot);
      syncAccountsTopPillButtons(acRoot, acData);
      ensureAutoSwitchMasterToggle(acRoot, acData);
    }
    if (accountsNavButtonEl) {
      const lbl = accountsNavButtonEl.querySelector?.('.ag-hs-nav-label');
      if (lbl) lbl.textContent = t('accountsPage.navLabel');
    }
    if (navButtonEl) {
      const lbl = navButtonEl.querySelector?.('.ag-hs-nav-label');
      if (lbl) {
        const navTxt = t('hostSettings.navLabel');
        lbl.textContent = (navTxt && navTxt !== 'hostSettings.navLabel') ? navTxt : 'Context Meter';
      }
    }
    if (!pageEl) return;
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
      if (!hitBtn || hitBtn.id === NAV_ID || hitBtn.id === NAV_COMPACT_ID || hitBtn.id === NAV_ACCOUNTS_ID || isPluginOwnedNode(hitBtn)) return;
      const navScope = activeSidebar || activeNavList;
      const isNavBtn = (navScope && (navScope.contains?.(hitBtn) || Array.from(navScope.children || []).includes(hitBtn)))
        || isHostNavTestId(hitBtn);
      if (isNavBtn && hostSelected) {
        deactivateHostPage({ clickedNativeBtn: hitBtn });
      }
    };
    container.addEventListener?.('click', onNativeNavClick, true);
  }

  function removeDuplicateNavNodes(keepBtn, keepItem, keepCompactBtn, keepCompactItem, keepAccountsBtn, keepAccountsItem, navList) {
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const cleanSet = [
        [NAV_ID, NAV_WRAPPER_ATTR, keepBtn, keepItem],
        [NAV_COMPACT_ID, NAV_COMPACT_WRAPPER_ATTR, keepCompactBtn, keepCompactItem],
        [NAV_ACCOUNTS_ID, NAV_ACCOUNTS_WRAPPER_ATTR, keepAccountsBtn, keepAccountsItem]
      ];
      for (const [nid, wattr, kBtn, kItem] of cleanSet) {
        const allNavs = Array.from(document.querySelectorAll(`#${nid}`) || []);
        for (const n of allNavs) {
          if (n !== kBtn) {
            const wrap = n.parentElement?.getAttribute?.(wattr) === 'true' ? n.parentElement : null;
            try { (wrap && wrap !== kItem ? wrap : n).remove?.(); } catch { }
          }
        }
        const allWraps = Array.from(document.querySelectorAll(`[${wattr}="true"]`) || []);
        for (const w of allWraps) {
          if (w !== kItem) {
            try { w.remove?.(); } catch { }
          }
        }
      }
    }
    if (navList && navList.children) {
      for (const child of Array.from(navList.children)) {
        if (!child || child === keepItem || child === keepBtn || child === keepCompactItem || child === keepCompactBtn || child === keepAccountsItem || child === keepAccountsBtn) continue;
        if (
          child.id === NAV_ID || child.id === NAV_COMPACT_ID || child.id === NAV_ACCOUNTS_ID ||
          child.getAttribute?.(NAV_WRAPPER_ATTR) === 'true' ||
          child.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) === 'true' ||
          child.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) === 'true'
        ) {
          try { child.remove?.(); } catch { }
        }
      }
    }
  }

  function isHostModalActuallyVisible(modal) {
    if (!modal || modal.isConnected === false) return false;
    let cur = modal;
    while (cur && cur.nodeType === 1) {
      if (cur.hidden === true || cur.hasAttribute?.('hidden')) return false;
      if (cur.getAttribute?.('aria-hidden') === 'true') return false;
      if (cur.style && cur.style.display === 'none') return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const cs = window.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        } catch { }
      }
      cur = cur.parentElement;
    }
    return true;
  }

  function syncModalMount() {
    if (disposed) return false;
    const targets = findHostSettingsTargets();
    if (!targets || !isHostModalActuallyVisible(targets.modal)) {
      if (activeModal && (activeModal.isConnected === false || !isHostModalActuallyVisible(activeModal))) {
        deactivateHostPage();
        savedPageScrollTop = 0;
        savedCompactPageScrollTop = 0;
        savedAccountsPageScrollTop = 0;
        savedNativePaneScrollTop = 0;
        activeModal = null;
        activeSidebar = null;
        activeNavList = null;
        activeSplitRow = null;
        activeContentPane = null;
        navItemEl = null;
        navButtonEl = null;
        compactNavItemEl = null;
        compactNavButtonEl = null;
        accountsNavItemEl = null;
        accountsNavButtonEl = null;
      }
      notifyHostModalVisibility(false);
      return false;
    }

    notifyHostModalVisibility(true);

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

    let existingCompactBtn = null;
    if (typeof navList.querySelector === 'function') {
      existingCompactBtn = navList.querySelector(`#${NAV_COMPACT_ID}`) || null;
    }
    if (existingCompactBtn && existingCompactBtn.__agHsCtrlToken === controllerToken) {
      compactNavButtonEl = existingCompactBtn;
    } else {
      if (existingCompactBtn && existingCompactBtn.__agHsCtrlToken !== controllerToken) {
        const oldWrap = existingCompactBtn.parentElement?.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) === 'true'
          ? existingCompactBtn.parentElement
          : null;
        try { (oldWrap || existingCompactBtn).remove?.(); } catch { }
      }
      if (!compactNavButtonEl || compactNavButtonEl.__agHsCtrlToken !== controllerToken) {
        compactNavButtonEl = createCompactNavButton(anchorBtn);
      }
    }
    bindNavButtonEvents(compactNavButtonEl, 'compaction');

    if (useRowWrapper) {
      if (
        !compactNavItemEl ||
        compactNavItemEl === compactNavButtonEl ||
        compactNavItemEl.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) !== 'true'
      ) {
        const existingWrap = compactNavButtonEl.parentElement?.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) === 'true'
          ? compactNavButtonEl.parentElement
          : null;
        compactNavItemEl = existingWrap || document.createElement('div');
        compactNavItemEl.setAttribute?.(NAV_COMPACT_WRAPPER_ATTR, 'true');
      }
      const rowCls = String(anchorRow?.className || 'relative group/nav-item mx-2').trim();
      if (compactNavItemEl.className !== rowCls) compactNavItemEl.className = rowCls;
      if (compactNavButtonEl.parentElement !== compactNavItemEl) {
        compactNavItemEl.appendChild(compactNavButtonEl);
      }
    } else {
      if (compactNavItemEl && compactNavItemEl !== compactNavButtonEl && compactNavItemEl.getAttribute?.(NAV_COMPACT_WRAPPER_ATTR) === 'true') {
        try { compactNavItemEl.remove?.(); } catch { }
      }
      compactNavItemEl = compactNavButtonEl;
    }

    let existingAccountsBtn = null;
    if (typeof navList.querySelector === 'function') {
      existingAccountsBtn = navList.querySelector(`#${NAV_ACCOUNTS_ID}`) || null;
    }
    if (existingAccountsBtn && existingAccountsBtn.__agHsCtrlToken === controllerToken) {
      accountsNavButtonEl = existingAccountsBtn;
    } else {
      if (existingAccountsBtn && existingAccountsBtn.__agHsCtrlToken !== controllerToken) {
        const oldWrap = existingAccountsBtn.parentElement?.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) === 'true'
          ? existingAccountsBtn.parentElement
          : null;
        try { (oldWrap || existingAccountsBtn).remove?.(); } catch { }
      }
      if (!accountsNavButtonEl || accountsNavButtonEl.__agHsCtrlToken !== controllerToken) {
        accountsNavButtonEl = createAccountsNavButton(anchorBtn);
      }
    }
    bindNavButtonEvents(accountsNavButtonEl, 'accounts');

    if (useRowWrapper) {
      if (
        !accountsNavItemEl ||
        accountsNavItemEl === accountsNavButtonEl ||
        accountsNavItemEl.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) !== 'true'
      ) {
        const existingWrap = accountsNavButtonEl.parentElement?.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) === 'true'
          ? accountsNavButtonEl.parentElement
          : null;
        accountsNavItemEl = existingWrap || document.createElement('div');
        accountsNavItemEl.setAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR, 'true');
      }
      const rowCls = String(anchorRow?.className || 'relative group/nav-item mx-2').trim();
      if (accountsNavItemEl.className !== rowCls) accountsNavItemEl.className = rowCls;
      if (accountsNavButtonEl.parentElement !== accountsNavItemEl) {
        accountsNavItemEl.appendChild(accountsNavButtonEl);
      }
    } else {
      if (accountsNavItemEl && accountsNavItemEl !== accountsNavButtonEl && accountsNavItemEl.getAttribute?.(NAV_ACCOUNTS_WRAPPER_ATTR) === 'true') {
        try { accountsNavItemEl.remove?.(); } catch { }
      }
      accountsNavItemEl = accountsNavButtonEl;
    }

    removeDuplicateNavNodes(navButtonEl, navItemEl, compactNavButtonEl, compactNavItemEl, accountsNavButtonEl, accountsNavItemEl, navList);

    if (anchorRow && typeof anchorRow.after === 'function') {
      if (anchorRow.nextElementSibling !== navItemEl || navItemEl.parentElement !== navList) {
        anchorRow.after(navItemEl);
      }
      if (navItemEl.nextElementSibling !== compactNavItemEl || compactNavItemEl.parentElement !== navList) {
        navItemEl.after(compactNavItemEl);
      }
      if (compactNavItemEl.nextElementSibling !== accountsNavItemEl || accountsNavItemEl.parentElement !== navList) {
        compactNavItemEl.after(accountsNavItemEl);
      }
    } else {
      if (navItemEl.parentElement !== navList) navList.appendChild(navItemEl);
      if (compactNavItemEl.parentElement !== navList) navList.appendChild(compactNavItemEl);
      if (accountsNavItemEl.parentElement !== navList) navList.appendChild(accountsNavItemEl);
    }
    syncPluginNavTypography(anchorBtn);

    if (!pageEl) createPageElement();
    if (pageEl.parentElement !== contentPane) {
      contentPane.appendChild(pageEl);
    }
    if (!compactPageEl) createCompactPageElement();
    if (compactPageEl.parentElement !== contentPane) {
      contentPane.appendChild(compactPageEl);
    }
    if (!accountsPageEl) createAccountsPageElement();
    if (accountsPageEl.parentElement !== contentPane) {
      contentPane.appendChild(accountsPageEl);
    }
    setHiddenSafe(pageEl, !(hostSelected && activeCustomPage === 'settings'));
    setHiddenSafe(compactPageEl, !(hostSelected && activeCustomPage === 'compaction'));
    setHiddenSafe(accountsPageEl, !(hostSelected && activeCustomPage === 'accounts'));
    if (hostSelected) {
      // 仅当弹窗结构发生实际变更或当前自定义页未完成挂载呈递时才重跑呈现，防止 MutationObserver 反复触发整页重绘导致频闪与点击吞掉
      if (modalChanged || !verifyHostPagePresented()) {
        applyHostPageActivePresentation();
      } else {
        hideNativeContentNodes();
        syncThemeToPageHost();
      }
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
    }, 120);
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
          observer.observe(rootTarget, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'aria-hidden', 'data-state']
          });
        } catch { }
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelRefreshAllAccounts();
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
    notifyHostModalVisibility(false);
    try { (navItemEl || navButtonEl)?.remove?.(); } catch { }
    try { navButtonEl?.remove?.(); } catch { }
    try { (compactNavItemEl || compactNavButtonEl)?.remove?.(); } catch { }
    try { compactNavButtonEl?.remove?.(); } catch { }
    try { (accountsNavItemEl || accountsNavButtonEl)?.remove?.(); } catch { }
    try { accountsNavButtonEl?.remove?.(); } catch { }
    try { pageEl?.remove?.(); } catch { }
    try { compactPageEl?.remove?.(); } catch { }
    try { accountsPageEl?.remove?.(); } catch { }
    if (typeof document !== 'undefined') {
      try { document.getElementById(STYLE_ID)?.remove?.(); } catch { }
    }
    navItemEl = null;
    navButtonEl = null;
    compactNavItemEl = null;
    compactNavButtonEl = null;
    accountsNavItemEl = null;
    accountsNavButtonEl = null;
    pageEl = null;
    pageShadow = null;
    compactPageEl = null;
    compactPageShadow = null;
    accountsPageEl = null;
    accountsPageShadow = null;
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
    openHostCompactionProgressPage: (opts = {}) => openHostSettingsPage({ ...opts, page: 'compaction' }),
    openHostAccountsPage: (opts = {}) => openHostSettingsPage({ ...opts, page: 'accounts' }),
    scrollToSection,
    openColorsDrawer,
    findElementById: findElInPage,
    getPageRoot: () => pageShadow || pageEl || null,
    getPageHost: () => pageEl || null,
    getCompactPageRoot: () => compactPageShadow || compactPageEl || null,
    getCompactPageHost: () => compactPageEl || null,
    getAccountsPageRoot: () => accountsPageShadow || accountsPageEl || null,
    getAccountsPageHost: () => accountsPageEl || null,
    refreshAllAccounts,
    cancelRefreshAllAccounts,
    switchToBestQuotaAccount,
    pickBestQuotaAccountForTest: pickBestQuotaAccount,
    getRefreshAllStateForTest: () => ({
      running: refreshAllState.running,
      cancelled: refreshAllState.cancelled,
      done: refreshAllState.done,
      total: refreshAllState.total,
      okCount: refreshAllState.okCount,
      failCount: refreshAllState.failCount,
      currentEmail: refreshAllState.currentEmail,
      errors: refreshAllState.errors.slice()
    }),
    getAccountsUpgradeI18nForTest: () => AC_UPGRADE_I18N,
    beginAccountsRefreshMotion: (email) => {
      const root = accountsPageShadow || accountsPageEl || null;
      if (!root || typeof beginAccountQuotaRefreshMotion !== 'function') return null;
      return beginAccountQuotaRefreshMotion(root, email);
    },
    completeAccountsRefreshMotion: (email, payload) => {
      const root = accountsPageShadow || accountsPageEl || null;
      if (!root || typeof completeAccountQuotaRefreshMotion !== 'function') return false;
      return completeAccountQuotaRefreshMotion(root, email, payload);
    },
    getAccountsMotionStateForTest: (email) => {
      const root = accountsPageShadow || accountsPageEl || null;
      const container = root && typeof root.getElementById === 'function' ? root.getElementById('ag-ac-root') : root?.querySelector?.('#ag-ac-root');
      const ls = container?._agAcLocalState || null;
      if (!ls) return null;
      if (email) {
        const m = ls.refreshMotions?.get?.(String(email).trim().toLowerCase());
        return m ? { phase: m.phase, seq: m.seq, reduced: m.reduced, drainDurationMs: m.drainDurationMs, pauseDurationMs: m.pauseDurationMs, chargeDurationMs: m.chargeDurationMs } : null;
      }
      const out = {};
      if (ls.refreshMotions) {
        for (const [k, m] of ls.refreshMotions.entries()) {
          out[k] = { phase: m.phase, seq: m.seq, reduced: m.reduced };
        }
      }
      return {
        motions: out,
        refreshingEmails: Array.from(ls.refreshingEmails || [])
      };
    },
    syncThemeToPageHost,
    isHostPageSelected: () => Boolean(hostSelected),
    isHostModalOpen: () => Boolean(lastReportedModalOpen),
    getActiveCustomPage: () => activeCustomPage,
    getLastMountDiagnostic: () => lastMountDiagnostic,
    getStateForTest: () => ({
      mounted: Boolean(activeModal && navButtonEl && (navItemEl?.parentElement === activeNavList || navButtonEl.parentElement === activeNavList)),
      compactNavMounted: Boolean(activeModal && compactNavButtonEl && (compactNavItemEl?.parentElement === activeNavList || compactNavButtonEl.parentElement === activeNavList)),
      accountsNavMounted: Boolean(activeModal && accountsNavButtonEl && (accountsNavItemEl?.parentElement === activeNavList || accountsNavButtonEl.parentElement === activeNavList)),
      selected: hostSelected,
      activeCustomPage,
      navId: navButtonEl?.id || null,
      compactNavId: compactNavButtonEl?.id || null,
      accountsNavId: accountsNavButtonEl?.id || null,
      pageHidden: pageEl ? Boolean(pageEl.hidden) : true,
      compactPageHidden: compactPageEl ? Boolean(compactPageEl.hidden) : true,
      accountsPageHidden: accountsPageEl ? Boolean(accountsPageEl.hidden) : true,
      hasShadowRoot: Boolean(pageShadow),
      hasAccountsShadowRoot: Boolean(accountsPageShadow),
      nativeSettingsPageReady: Boolean(findElInPage('ag-ns-root')),
      accountsPageReady: Boolean(findElInPage('ag-ac-root')),
      scrollTop: pageEl ? Number(pageEl.scrollTop || 0) : 0,
      contentPaneId: activeContentPane?.id || activeContentPane?.getAttribute?.('data-testid') || null,
      hiddenNativeCount: savedHiddenNodes.length,
      navCountInDoc: typeof document?.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(`#${NAV_ID}`) || []).length
        : (navButtonEl ? 1 : 0),
      compactNavCountInDoc: typeof document?.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(`#${NAV_COMPACT_ID}`) || []).length
        : (compactNavButtonEl ? 1 : 0),
      accountsNavCountInDoc: typeof document?.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(`#${NAV_ACCOUNTS_ID}`) || []).length
        : (accountsNavButtonEl ? 1 : 0)
    })
  };
}
