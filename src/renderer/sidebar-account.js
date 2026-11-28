/**
 * 左下角当前账号胶囊与原生 Settings 收敛模块 (sidebar-account.js)
 *
 * 设计基线：
 * - 严格保持原有左下角账号胶囊与上拉菜单的整体形状、宽度与信息排版不变，
 *   移植 select_ui 动效体系：按压缩放、双箭头展开张合、切号停靠显影与触发器微回弹、
 *   毛玻璃弹簧展开收起、列表项错峰显影、磁吸滑动高亮胶囊与当前账号勾号描边绘制。
 * - 承载高频真实操作：快捷切号与二次确认、当前账号快捷刷新、添加账号、直达账号与额度页、直达设置。
 * - 与账号与额度页严格共用同一份账号与配额数据源，遵循 prefers-reduced-motion: reduce。
 */
function createSidebarAccountController(deps = {}) {
  const {
    t = (k) => k,
    getState = () => ({}),
    syncThemeTarget = null,
    onSwitchAccount = null,
    onRefreshActive = null,
    onAddAccount = null,
    onOpenAccountsPage = null,
    onOpenNativeSettings = null,
    onOpenSupportUrl = null,
    onMenuOpen = null,
    onOpenProfileHome = null
  } = deps;

  const HOST_ID = 'ag-sidebar-account-host';
  const POPOVER_HOST_ID = 'ag-sidebar-account-popover-host';
  const POPOVER_Z_INDEX = 2147483646;
  const ORIG_HIDDEN_ATTR = 'data-ag-orig-settings-hidden';
  const ORIG_DISPLAY_ATTR = 'data-ag-orig-settings-display';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let disposed = false;
  let hostEl = null;
  let shadowRoot = null;
  let popoverHostEl = null;
  let popoverShadowRoot = null;
  let origSettingsBtn = null;
  let origHiddenByUs = false;
  let observer = null;
  let resizeObserver = null;
  let syncTimer = null;
  let closeAnimTimer = null;
  let menuOpen = false;
  let isClosing = false;
  let switchingEmail = null;
  let refreshingActive = false;
  let lastActionFeedback = '';
  let lastActionTone = 'idle';
  let lastRenderSig = '';
  let lastListSig = '';
  let lastActiveAccountId = null;
  let compactMode = false;
  let mountedOk = false;
  let outsideClickHandler = null;
  let keydownHandler = null;
  let lastFocusBeforeDispose = false;
  let pillReady = false;
  let activeHoverEl = null;

  function isValidAvatarSrc(url) {
    if (typeof url !== 'string') return false;
    const s = url.trim();
    return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(s) || /^https?:\/\//i.test(s);
  }

  function formatAccountEmailForDisplay(acc, hideEmail) {
    if (!acc) return '';
    if (hideEmail === true) return acc.maskedEmail || acc.email || '';
    return acc.email || acc.maskedEmail || '';
  }

  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #2563eb, #1d4ed8)',
    'linear-gradient(135deg, #059669, #047857)',
    'linear-gradient(135deg, #d97706, #b45309)',
    'linear-gradient(135deg, #0284c7, #0369a1)',
    'linear-gradient(135deg, #db2777, #9d174d)',
    'linear-gradient(135deg, #0891b2, #0e7490)'
  ];

  function hashColorIdx(seed) {
    const str = String(seed || 'a');
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h) % AVATAR_GRADIENTS.length;
  }

  function extractInitial(name, email) {
    const src = String(name || email || '?').trim();
    if (!src) return '?';
    const ch = src[0];
    return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
  }

  function prefersReducedMotion() {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      }
    } catch { }
    return false;
  }

  function normalizePlanBadge(acc) {
    const code = String(acc?.tierCode || '').trim().toUpperCase();
    const raw = String(
      acc?.planLabel
      || acc?.tierName
      || acc?.tierId
      || (typeof acc?.userTier === 'string' ? acc.userTier : acc?.userTier?.name || acc?.userTier?.id || '')
      || ''
    ).trim();
    if (code === 'ULTRA' || raw.toLowerCase().includes('ultra')) {
      return { text: 'Google AI Ultra', isUltra: true, unknown: false };
    }
    if (code === 'PRO' || raw.toLowerCase().includes('pro')) {
      return { text: 'Google AI Pro', isUltra: false, unknown: false };
    }
    if (code === 'FREE' || raw.toLowerCase().includes('free') || raw.toLowerCase().includes('standard')) {
      return { text: 'Free', isUltra: false, unknown: false };
    }
    if (!raw || raw === '未知' || /^unknown$/i.test(raw)) {
      return { text: t('sidebarAccount.planUnknown'), isUltra: false, unknown: true };
    }
    return { text: raw, isUltra: false, unknown: false };
  }

  function resolveCompactQuotaHint(acc) {
    if (!acc) return { text: '', pct: null, tone: 'muted' };
    if (acc.suspended) return { text: t('accountsPage.statusSuspended'), pct: null, tone: 'danger' };
    if (acc.authInvalid) return { text: t('accounts.reauthRequired'), pct: null, tone: 'warn' };
    const pools = Array.isArray(acc.quotaSnapshot?.pools) ? acc.quotaSnapshot.pools : [];
    const main = pools.find((p) => p?.poolKey === 'shared_gemini_main') || pools[0] || null;
    if (!main) return { text: t('accountsPage.quotaUnsynced'), pct: null, tone: 'muted' };
    const buckets = Array.isArray(main.buckets) ? main.buckets.filter(Boolean) : [];
    const b5h = buckets.find((b) => b.windowKey === '5h' || b.windowShort === '5h') || null;
    const b7d = buckets.find((b) => b.windowKey === 'weekly' || b.windowShort === '7d') || null;
    const picked = b5h || b7d || buckets[0] || null;
    const winTag = b5h ? '5H' : (b7d ? '7D' : '5H');
    const rawFrac = picked?.remainingFraction ?? main.remainingFraction;
    if (rawFrac === null || rawFrac === undefined || !Number.isFinite(Number(rawFrac))) {
      return { text: t('accountsPage.quotaUnknown'), pct: null, tone: 'muted' };
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(rawFrac) * 100)));
    const tone = pct <= 15 ? 'danger' : (pct <= 40 ? 'warn' : 'ok');
    return { text: `${winTag} ${pct}%`, pct, tone };
  }

  function createTickSVG(doc, animate) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (animate) svg.setAttribute('class', 'sa-anim-check-glow');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M5 14.5C5 14.5 6.5 14.5 8.5 18C8.5 18 14.0588 8.83333 19 7');
    path.setAttribute('pathLength', '1');
    if (animate) path.setAttribute('class', 'sa-anim-check-draw');
    svg.appendChild(path);
    return svg;
  }

  function isPluginOwned(node) {
    if (!node) return false;
    if (node.id === HOST_ID || node.id === POPOVER_HOST_ID || node.id === 'ag-context-meter' || node.id === 'ag-context-meter-radial-host' || node.id === 'ag-context-meter-modal-host') return true;
    return Boolean(typeof node.closest === 'function' && node.closest(`#${HOST_ID}, #${POPOVER_HOST_ID}, #ag-context-meter, #ag-context-meter-radial-host, #ag-context-meter-modal-host`));
  }

  function getPopEl(id) {
    return popoverShadowRoot?.getElementById?.(id) || shadowRoot?.getElementById?.(id) || null;
  }

  function popQuery(sel) {
    return popoverShadowRoot?.querySelector?.(sel) || shadowRoot?.querySelector?.(sel) || null;
  }

  function popQueryAll(sel) {
    const root = popoverShadowRoot || shadowRoot;
    return root?.querySelectorAll ? Array.from(root.querySelectorAll(sel)) : [];
  }

  function triggerProfileHomeOpen(source = 'sidebar-avatar') {
    closeMenu(false, true);
    if (typeof onOpenProfileHome === 'function') {
      try {
        onOpenProfileHome({ source });
        return true;
      } catch { }
    }
    try {
      const viewsApi = typeof window !== 'undefined' ? window.__agContextMeterViews : null;
      if (viewsApi && typeof viewsApi.openProfileHome === 'function') {
        viewsApi.openProfileHome({ source });
        return true;
      }
    } catch { }
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        const EvCtor = typeof CustomEvent === 'function' ? CustomEvent : null;
        const ev = EvCtor
          ? new EvCtor('ag-open-profile-home', { detail: { source } })
          : { type: 'ag-open-profile-home', detail: { source } };
        window.dispatchEvent(ev);
        return true;
      }
    } catch { }
    return false;
  }

  function findNativeSettingsButton() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const byTestId = Array.from(document.querySelectorAll('[data-testid="settings-button"]') || [])
      .filter((el) => el && !isPluginOwned(el));
    if (byTestId.length > 0) return byTestId[0];
    return null;
  }

  function restoreNativeSettingsButton(restoreFocus = false) {
    if (!origSettingsBtn) return;
    try {
      if (origHiddenByUs || origSettingsBtn.getAttribute?.(ORIG_HIDDEN_ATTR) === 'true') {
        const prevDisp = origSettingsBtn.getAttribute?.(ORIG_DISPLAY_ATTR) || '';
        origSettingsBtn.removeAttribute?.(ORIG_HIDDEN_ATTR);
        origSettingsBtn.removeAttribute?.(ORIG_DISPLAY_ATTR);
        origSettingsBtn.hidden = false;
        if (origSettingsBtn.style) {
          if (typeof origSettingsBtn.style.removeProperty === 'function') {
            origSettingsBtn.style.removeProperty('display');
            if (prevDisp) origSettingsBtn.style.display = prevDisp;
          } else {
            origSettingsBtn.style.display = prevDisp || '';
          }
        }
        origSettingsBtn.removeAttribute?.('aria-hidden');
        if (restoreFocus && typeof origSettingsBtn.focus === 'function') {
          try { origSettingsBtn.focus({ preventScroll: true }); } catch { origSettingsBtn.focus(); }
        }
      }
    } catch { }
    origHiddenByUs = false;
  }

  function hideNativeSettingsButtonSafely(btn) {
    if (!btn || !hostEl || !hostEl.isConnected || !shadowRoot) return false;
    const menuSettingsBtn = getPopEl('ag-sa-act-settings');
    if (!menuSettingsBtn || typeof btn.click !== 'function') return false;
    try {
      if (btn.getAttribute?.(ORIG_HIDDEN_ATTR) !== 'true') {
        const curDisp = btn.style?.getPropertyValue?.('display') || btn.style?.display || '';
        btn.setAttribute?.(ORIG_DISPLAY_ATTR, curDisp);
        btn.setAttribute?.(ORIG_HIDDEN_ATTR, 'true');
      }
      btn.hidden = true;
      if (btn.style) {
        if (typeof btn.style.setProperty === 'function') btn.style.setProperty('display', 'none', 'important');
        else btn.style.display = 'none';
      }
      btn.setAttribute?.('aria-hidden', 'true');
      origHiddenByUs = true;
      return true;
    } catch {
      restoreNativeSettingsButton(false);
      return false;
    }
  }

  function triggerNativeSettingsOpen() {
    closeMenu(false, true);
    if (typeof onOpenNativeSettings === 'function') {
      const handled = onOpenNativeSettings(origSettingsBtn);
      if (handled === true) return true;
    }
    const btn = (origSettingsBtn && origSettingsBtn.isConnected !== false)
      ? origSettingsBtn
      : findNativeSettingsButton();
    if (!btn || typeof btn.click !== 'function') return false;
    const wasHidden = btn.hidden;
    try {
      btn.hidden = false;
      btn.click();
    } finally {
      if (origHiddenByUs && wasHidden) btn.hidden = true;
    }
    return true;
  }

  function buildStyles() {
    return `
:host {
  display: block;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  --sa-bg: transparent;
  --sa-hover: rgba(255, 255, 255, 0.08);
  --sa-active: rgba(255, 255, 255, 0.12);
  --sa-pop-glass: rgba(24, 24, 27, 0.78);
  --sa-pop-ring: rgba(255, 255, 255, 0.13);
  --sa-pop-inner-ring: rgba(255, 255, 255, 0.09);
  --sa-pop-shadow: 0 14px 36px -8px rgba(0, 0, 0, 0.44), 0 4px 12px -2px rgba(0, 0, 0, 0.24);
  --sa-pill-bg: rgba(255, 255, 255, 0.10);
  --sa-border: rgba(255, 255, 255, 0.10);
  --sa-text: #f4f4f6;
  --sa-text-sec: #b4b6be;
  --sa-text-muted: #848794;
  --sa-surface: rgba(255, 255, 255, 0.05);
  --sa-track: rgba(255, 255, 255, 0.12);
  --sa-badge-bg: rgba(255, 255, 255, 0.10);
  --sa-badge-text: #d4d4d8;
  --sa-ultra-bg: #f4f4f6;
  --sa-ultra-text: #141416;
  --sa-accent: var(--ag-host-accent, var(--primary, #3274f6));
  --sa-accent-fg: var(--ag-host-accent-fg, #ffffff);
  --sa-accent-border: var(--ag-host-accent-border, var(--sa-accent));
  --sa-accent-text: var(--ag-host-accent-text, var(--sa-accent));
  --sa-ring-alpha: color-mix(in srgb, var(--sa-accent-border) 24%, transparent);
  --sa-ok: #22c55e;
  --sa-warn: #f59e0b;
  --sa-danger: #ef4444;
  --sa-ring-border: #18181b;
  --sa-motion-open: 280ms;
  --sa-motion-close: 195ms;
  --sa-motion-pill: 210ms;
  --sa-motion-item: 220ms;
  --sa-motion-check: 340ms;
  --sa-ease-spring: cubic-bezier(0.22, 1.12, 0.36, 1);
  --sa-ease-close: cubic-bezier(0.32, 0.72, 0, 1);
}
:host([data-theme="light"]),
:host([data-panel-tone="light"]) {
  --sa-hover: rgba(0, 0, 0, 0.05);
  --sa-active: rgba(0, 0, 0, 0.08);
  --sa-pop-glass: rgba(255, 255, 255, 0.78);
  --sa-pop-ring: rgba(9, 9, 11, 0.11);
  --sa-pop-inner-ring: rgba(255, 255, 255, 0.62);
  --sa-pop-shadow: 0 14px 36px -8px rgba(15, 23, 42, 0.16), 0 4px 12px -2px rgba(15, 23, 42, 0.08);
  --sa-pill-bg: rgba(9, 9, 11, 0.075);
  --sa-border: rgba(0, 0, 0, 0.09);
  --sa-text: #18181b;
  --sa-text-sec: #52525b;
  --sa-text-muted: #71717a;
  --sa-surface: rgba(0, 0, 0, 0.035);
  --sa-track: rgba(0, 0, 0, 0.10);
  --sa-badge-bg: rgba(0, 0, 0, 0.07);
  --sa-badge-text: #3f3f46;
  --sa-ultra-bg: #18181b;
  --sa-ultra-text: #ffffff;
  --sa-ok: #16a34a;
  --sa-warn: #d97706;
  --sa-danger: #dc2626;
  --sa-ring-border: #ffffff;
}
*, *::before, *::after { box-sizing: border-box; }
.sa-anchor { position: relative; width: 100%; }

/* 1. 胶囊触发器手感（保持原尺寸形状 + 按压缩放 + 展开聚焦环 + 双箭头张开） */
.sa-trigger {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: var(--sa-bg);
  color: var(--sa-text);
  cursor: pointer;
  text-align: left;
  outline: none;
  user-select: none;
  transition:
    transform 180ms ease-out,
    background-color 160ms ease,
    border-color 160ms ease,
    box-shadow 180ms ease;
}
.sa-trigger:hover { background: var(--sa-hover); }
.sa-trigger:active { transform: scale(0.97); }
.sa-anchor.is-open .sa-trigger {
  background: var(--sa-hover);
  border-color: color-mix(in srgb, var(--sa-accent) 55%, var(--sa-border));
  box-shadow: 0 0 0 3px var(--sa-ring-alpha);
}
.sa-trigger:focus-visible {
  border-color: var(--sa-accent);
  box-shadow: 0 0 0 3px var(--sa-ring-alpha);
}
:host([data-compact="true"]) .sa-trigger {
  justify-content: center;
  padding: 5px;
  gap: 0;
}
:host([data-compact="true"]) .sa-meta,
:host([data-compact="true"]) .sa-chevron {
  display: none !important;
}

.sa-avatar {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  flex: 0 0 28px;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  font-weight: 700;
  color: #ffffff;
  user-select: none;
  transition: box-shadow 160ms ease, transform 160ms ease;
}
.sa-avatar.is-profile-link {
  cursor: pointer;
}
.sa-avatar.is-profile-link:hover {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sa-accent) 68%, transparent), 0 0 10px color-mix(in srgb, var(--sa-accent) 34%, transparent);
  transform: scale(1.05);
}
.sa-avatar.is-profile-link:focus-visible {
  outline: 2px solid var(--sa-accent);
  outline-offset: 2px;
}
.sa-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  object-fit: cover;
  display: block;
}
.sa-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--sa-ok);
  border: 2px solid var(--sa-ring-border);
}
.sa-status-dot[data-tone="danger"] { background: var(--sa-danger); }
.sa-status-dot[data-tone="warn"] { background: var(--sa-warn); }
.sa-status-dot[data-tone="muted"] { background: var(--sa-text-muted); }

.sa-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}
.sa-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.sa-name {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-plan {
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--sa-badge-bg);
  color: var(--sa-badge-text);
  line-height: 1.35;
  flex-shrink: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-plan.is-ultra {
  background: var(--sa-ultra-bg);
  color: var(--sa-ultra-text);
}
.sa-sub {
  font-size: 11px;
  color: var(--sa-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa-chevron {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--sa-text-muted);
  transition: color 140ms ease;
}
.sa-anchor.is-open .sa-chevron {
  color: var(--sa-text);
}
.sa-unfold-path {
  transition: transform var(--sa-motion-open) var(--sa-ease-spring);
}
.sa-trigger[aria-expanded="true"] .sa-unfold-path:first-child {
  transform: translateY(-1.5px);
}
.sa-trigger[aria-expanded="true"] .sa-unfold-path:last-child {
  transform: translateY(1.5px);
}

/* 2. 毛玻璃上拉菜单弹簧展开 / 收起 */
.sa-popover {
  position: fixed;
  width: 274px;
  max-width: calc(100vw - 16px);
  border-radius: 12px;
  background: var(--sa-pop-glass);
  box-shadow: 0 0 0 1px var(--sa-pop-ring), var(--sa-pop-shadow);
  backdrop-filter: blur(28px) saturate(1.5);
  -webkit-backdrop-filter: blur(28px) saturate(1.5);
  z-index: ${POPOVER_Z_INDEX};
  color: var(--sa-text);
  overflow: hidden;
  isolation: isolate;
  opacity: 0;
  pointer-events: none;
  transform: translate3d(0, 9px, 0) scale(0.92);
  filter: blur(4px);
  transform-origin: bottom left;
  will-change: transform, opacity, filter;
}
.sa-popover[hidden] { display: none !important; }
.sa-popover.is-open {
  opacity: 1;
  pointer-events: auto;
  transform: translate3d(0, 0, 0) scale(1);
  filter: blur(0px);
  transition:
    transform var(--sa-motion-open) var(--sa-ease-spring),
    opacity calc(var(--sa-motion-open) * 0.65) ease-out,
    filter calc(var(--sa-motion-open) * 0.7) ease-out;
}
.sa-popover.is-closing {
  opacity: 0;
  pointer-events: none;
  transform: translate3d(0, 9px, 0) scale(0.92);
  filter: blur(4px);
  transition:
    transform var(--sa-motion-close) var(--sa-ease-close),
    opacity var(--sa-motion-close) ease-in,
    filter var(--sa-motion-close) ease-in;
}
.sa-pop-ring {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: inset 0 0 0 1px var(--sa-pop-inner-ring);
  z-index: 30;
}

.sa-pop-header {
  position: relative;
  z-index: 10;
  padding: 10px 12px 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sa-pop-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sa-text-sec);
}
.sa-pop-head-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sa-pop-count {
  font-size: 10.5px;
  color: var(--sa-text-muted);
  background: var(--sa-surface);
  border: 1px solid var(--sa-border);
  padding: 1px 7px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}

/* 列表独立磁吸滑动高亮胶囊：严格约束在可滚动列表容器内，绝不穿模盖到顶部标题或底部操作区 */
.sa-menu-surface {
  position: relative;
  z-index: 10;
  display: flex;
  flex-direction: column;
}
.sa-list {
  position: relative;
  z-index: 10;
  padding: 2px 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 244px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  isolation: isolate;
}
.sa-list::-webkit-scrollbar { width: 5px; }
.sa-list::-webkit-scrollbar-thumb { background: var(--sa-border); border-radius: 999px; }

.sa-hover-pill {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  border-radius: 8px;
  background: var(--sa-pill-bg);
  pointer-events: none;
  opacity: 0;
  box-sizing: border-box;
  will-change: transform, width, height, opacity;
}

.sa-opt {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--sa-text);
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  text-align: left;
  outline: none;
  transition: color 140ms ease, transform 140ms ease, border-color 140ms ease, background-color 140ms ease;
}
.sa-opt:active { transform: scale(0.98); }
.sa-opt:focus-visible { outline: 2px solid var(--sa-accent-border); outline-offset: -2px; }
.sa-opt.is-active {
  border-color: color-mix(in srgb, var(--sa-accent-border) 34%, var(--sa-border));
}
.sa-opt.is-switching {
  border-color: var(--sa-accent-border);
  background: color-mix(in srgb, var(--sa-accent) 14%, transparent);
  animation: sa-switch-breathe 1.05s ease-in-out infinite;
}
@keyframes sa-switch-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.72; }
}
.sa-opt.is-suspended {
  opacity: 0.72;
}
.sa-opt-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sa-opt-top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.sa-opt-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-opt-email {
  font-size: 11px;
  color: var(--sa-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-opt-quota {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
}
.sa-opt-bar {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background: var(--sa-track);
  overflow: hidden;
  flex-shrink: 0;
}
.sa-opt-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--sa-ok);
}
.sa-opt-fill[data-tone="warn"] { background: var(--sa-warn); }
.sa-opt-fill[data-tone="danger"] { background: var(--sa-danger); }
.sa-opt-qtext {
  font-size: 10.5px;
  color: var(--sa-text-sec);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sa-opt-qtext[data-tone="danger"] { color: var(--sa-danger); }
.sa-opt-qtext[data-tone="warn"] { color: var(--sa-warn); }
.sa-opt-check {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--sa-accent-text);
  opacity: 0;
}
.sa-opt.is-active .sa-opt-check { opacity: 1; }
.sa-opt.is-switching .sa-opt-check { opacity: 1; }
.sa-opt.is-switching .sa-opt-check svg { animation: sa-spin 760ms linear infinite; }

.sa-empty {
  padding: 12px 10px;
  font-size: 11.5px;
  color: var(--sa-text-muted);
  text-align: center;
}
.sa-feedback {
  position: relative;
  z-index: 15;
  margin: 4px 6px 6px;
  padding: 6px 9px;
  border-radius: 7px;
  background: var(--sa-surface);
  border: 1px solid var(--sa-border);
  font-size: 11px;
  line-height: 1.4;
  color: var(--sa-text-sec);
  word-break: break-word;
}
.sa-feedback[hidden] { display: none !important; }
.sa-feedback[data-tone="error"] {
  color: var(--sa-danger);
  border-color: color-mix(in srgb, var(--sa-danger) 42%, transparent);
}
.sa-feedback[data-tone="ok"] {
  color: var(--sa-ok);
  border-color: color-mix(in srgb, var(--sa-ok) 42%, transparent);
}
.sa-divider { position: relative; z-index: 10; height: 1px; background: var(--sa-border); margin: 2px 0; }
.sa-footer {
  position: relative;
  z-index: 10;
  padding: 4px 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sa-action {
  position: relative;
  z-index: 10;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--sa-text);
  font-size: 12px;
  font-weight: 500;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  outline: none;
  transition: color 140ms ease, background-color 140ms ease, transform 140ms ease;
}
.sa-action:hover:not(:disabled) { background: var(--sa-pill-bg); }
.sa-action:active:not(:disabled) { transform: scale(0.98); }
.sa-action:focus-visible { outline: 2px solid var(--sa-accent-border); outline-offset: -2px; background: var(--sa-pill-bg); }
.sa-action:disabled { opacity: 0.55; cursor: wait; }
.sa-action-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sa-action-left svg { color: var(--sa-text-sec); flex-shrink: 0; }
.sa-action.is-spinning svg { animation: sa-spin 760ms linear infinite; }

/* 核心微动效 @keyframes（移植自 select_ui） */
@keyframes sa-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes sa-item-reveal {
  0% {
    opacity: 0;
    transform: translate3d(0, 4px, 0);
    filter: blur(2px);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0);
    filter: blur(0px);
  }
}
@keyframes sa-value-dock-up {
  0% {
    opacity: 0;
    transform: translate3d(0, 7px, 0) scale(0.96);
    filter: blur(3px);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
    filter: blur(0px);
  }
}
@keyframes sa-trigger-settle {
  0% { transform: scale(0.975); }
  55% { transform: scale(1.018); }
  100% { transform: scale(1); }
}
@keyframes sa-check-draw {
  0% {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    opacity: 0.3;
  }
  100% {
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
    opacity: 1;
  }
}
@keyframes sa-check-glow {
  0% { transform: scale(0.86); }
  65% { transform: scale(1.08); }
  100% { transform: scale(1); }
}

.sa-anim-item-reveal {
  animation: sa-item-reveal var(--sa-motion-item) var(--sa-ease-spring) both;
}
.sa-anim-dock-up {
  animation: sa-value-dock-up var(--sa-motion-open) var(--sa-ease-spring) both;
}
.sa-anim-trigger-settle {
  animation: sa-trigger-settle var(--sa-motion-open) var(--sa-ease-spring) both;
}
.sa-anim-check-draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  animation: sa-check-draw var(--sa-motion-check) cubic-bezier(0.22, 1, 0.36, 1) both;
}
.sa-anim-check-glow {
  animation: sa-check-glow var(--sa-motion-check) var(--sa-ease-spring) both;
}

@media (prefers-reduced-motion: reduce) {
  .sa-trigger, .sa-chevron, .sa-unfold-path, .sa-popover, .sa-hover-pill,
  .sa-opt, .sa-action, .sa-anim-item-reveal, .sa-anim-dock-up,
  .sa-anim-trigger-settle, .sa-anim-check-draw, .sa-anim-check-glow,
  .sa-action.is-spinning svg {
    transition: none !important;
    animation: none !important;
    filter: none !important;
  }
}
`.trim();
  }

  function buildTriggerMarkup() {
    return `
<div id="ag-sa-anchor" class="sa-anchor">
  <button id="ag-sa-trigger" class="sa-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="ag-sa-popover">
    <span id="ag-sa-avatar" class="sa-avatar is-profile-link" role="button" tabindex="0">
      <span id="ag-sa-avatar-text">?</span>
      <span id="ag-sa-status-dot" class="sa-status-dot" data-tone="muted"></span>
    </span>
    <span class="sa-meta">
      <span class="sa-name-row">
        <span id="ag-sa-name" class="sa-name">--</span>
        <span id="ag-sa-plan" class="sa-plan">--</span>
      </span>
      <span id="ag-sa-sub" class="sa-sub">--</span>
    </span>
    <span id="ag-sa-chevron" class="sa-chevron" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path class="sa-unfold-path" d="M7 10l5-5 5 5"/>
        <path class="sa-unfold-path" d="M7 14l5 5 5-5"/>
      </svg>
    </span>
  </button>
</div>`.trim();
  }

  function buildPopoverMarkup() {
    return `
<div id="ag-sa-popover" class="sa-popover" role="menu" hidden>
  <div class="sa-pop-ring" aria-hidden="true"></div>
  <div class="sa-pop-header">
    <span id="ag-sa-pop-title" class="sa-pop-title"></span>
    <span class="sa-pop-head-right">
      <span id="ag-sa-pop-count" class="sa-pop-count">0</span>
    </span>
  </div>
  <div id="ag-sa-surface" class="sa-menu-surface">
    <div id="ag-sa-top-actions" class="sa-top-actions" style="padding:4px 6px 2px;">
      <button id="ag-sa-act-profile" class="sa-action" type="button" role="menuitem" data-om-profile-entry="sidebar-menu">
        <span class="sa-action-left">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.2c.6-2.4 2.4-3.7 5-3.7s4.4 1.3 5 3.7"/></svg>
          <span id="ag-sa-lbl-profile"></span>
        </span>
      </button>
    </div>
    <div id="ag-sa-top-divider" class="sa-divider"></div>
    <div id="ag-sa-list" class="sa-list" role="group">
      <div id="ag-sa-hover-pill" class="sa-hover-pill" aria-hidden="true"></div>
    </div>
    <div id="ag-sa-feedback" class="sa-feedback" role="status" aria-live="polite" hidden></div>
    <div class="sa-divider"></div>
    <div id="ag-sa-footer" class="sa-footer">
      <button id="ag-sa-act-refresh" class="sa-action" type="button" role="menuitem">
        <span class="sa-action-left">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.45-3.72"/><path d="M13.5 2.8v2.7h-2.7"/></svg>
          <span id="ag-sa-lbl-refresh"></span>
        </span>
      </button>
      <button id="ag-sa-act-add" class="sa-action" type="button" role="menuitem">
        <span class="sa-action-left">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
          <span id="ag-sa-lbl-add"></span>
        </span>
      </button>
      <button id="ag-sa-act-accounts" class="sa-action" type="button" role="menuitem">
        <span class="sa-action-left">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="5.2" r="2.3"/><path d="M2.2 12.8c.4-2.1 2-3.3 4-3.3s3.6 1.2 4 3.3"/><path d="M11 4.5h3M11 7.5h3M11 10.5h2.2"/></svg>
          <span id="ag-sa-lbl-accounts"></span>
        </span>
      </button>
      <button id="ag-sa-act-settings" class="sa-action" type="button" role="menuitem">
        <span class="sa-action-left">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M13.2 8a5.2 5.2 0 0 0-.08-.9l1.38-1.08-1.3-2.25-1.66.52a5.2 5.2 0 0 0-1.56-.9L9.65 1.7h-2.6l-.33 1.69a5.2 5.2 0 0 0-1.56.9l-1.66-.52-1.3 2.25L3.58 7.1a5.2 5.2 0 0 0 0 1.8l-1.38 1.08 1.3 2.25 1.66-.52c.47.38 1 .68 1.56.9l.33 1.69h2.6l.33-1.69c.56-.22 1.09-.52 1.56-.9l1.66.52 1.3-2.25-1.38-1.08c.05-.3.08-.6.08-.9Z"/></svg>
          <span id="ag-sa-lbl-settings"></span>
        </span>
      </button>
    </div>
  </div>
</div>`.trim();
  }

  function computeRelativeBoxInList(listEl, targetEl) {
    if (!listEl || !targetEl || !listEl.contains(targetEl)) return null;
    // 与列表项严格同坐标系（.sa-list 为 position: relative 滚动容器），不受 popover 缩放动画 scale 扭曲，也无需手工扣减 scrollTop
    const x = Number(targetEl.offsetLeft || 0);
    const y = Number(targetEl.offsetTop || 0);
    const w = Number(targetEl.offsetWidth || 0);
    const h = Number(targetEl.offsetHeight || 0);
    if (w > 0 && h > 0) {
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }
    const lRect = listEl.getBoundingClientRect?.();
    const tRect = targetEl.getBoundingClientRect?.();
    if (!lRect || !tRect || tRect.width <= 0 || tRect.height <= 0) return null;
    return {
      x: Math.round(tRect.left - lRect.left + Number(listEl.scrollLeft || 0)),
      y: Math.round(tRect.top - lRect.top + Number(listEl.scrollTop || 0)),
      w: Math.round(tRect.width),
      h: Math.round(tRect.height)
    };
  }

  function updateMagneticPill(targetEl, animate = true) {
    if (!shadowRoot) return;
    const listEl = getPopEl('ag-sa-list');
    const pill = getPopEl('ag-sa-hover-pill');
    if (!listEl || !pill) return;
    if (!targetEl || !menuOpen || !listEl.contains(targetEl) || !targetEl.classList?.contains?.('sa-opt')) {
      pill.style.opacity = '0';
      activeHoverEl = null;
      return;
    }
    try {
      const box = computeRelativeBoxInList(listEl, targetEl);
      if (!box) {
        pill.style.opacity = '0';
        return;
      }
      const reduced = prefersReducedMotion();
      pill.style.transition = (!reduced && animate && pillReady)
        ? 'transform var(--sa-motion-pill) var(--sa-ease-spring), width var(--sa-motion-pill) var(--sa-ease-spring), height var(--sa-motion-pill) var(--sa-ease-spring), opacity 140ms ease'
        : 'opacity 120ms ease';
      pill.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
      pill.style.width = `${box.w}px`;
      pill.style.height = `${box.h}px`;
      pill.style.opacity = '1';
      activeHoverEl = targetEl;
      pillReady = true;
    } catch { }
  }

  function playSwitchDockAnimation() {
    if (!shadowRoot || prefersReducedMotion()) return;
    const nameEl = shadowRoot.getElementById('ag-sa-name');
    const trig = shadowRoot.getElementById('ag-sa-trigger');
    if (nameEl) {
      nameEl.classList.remove('sa-anim-dock-up');
      void nameEl.offsetWidth;
      nameEl.classList.add('sa-anim-dock-up');
    }
    if (trig) {
      trig.classList.remove('sa-anim-trigger-settle');
      void trig.offsetWidth;
      trig.classList.add('sa-anim-trigger-settle');
    }
  }

  function applyStaggerRevealToMenuItems() {
    if (!shadowRoot || prefersReducedMotion()) return;
    const items = popQueryAll('#ag-sa-list .sa-opt, #ag-sa-footer .sa-action');
    for (let i = 0; i < items.length; i++) {
      const node = items[i];
      node.classList.remove('sa-anim-item-reveal');
      node.style.animationDelay = `${Math.min(i, 7) * 18}ms`;
      void node.offsetWidth;
      node.classList.add('sa-anim-item-reveal');
    }
  }

  function positionPopover() {
    if (!shadowRoot) return;
    const pop = getPopEl('ag-sa-popover');
    const trig = shadowRoot.getElementById('ag-sa-trigger');
    if (!pop || !trig || !menuOpen) return;
    try {
      const rect = trig.getBoundingClientRect?.();
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const popW = Math.min(274, Math.max(220, vw - 16));
      pop.style.width = `${popW}px`;
      const measuredH = pop.offsetHeight > 0 ? pop.offsetHeight : 340;
      let left = rect && rect.width > 0 ? Math.round(rect.left) : 12;
      if (left + popW > vw - 8) left = Math.max(8, vw - popW - 8);
      if (left < 8) left = 8;
      let bottom = rect && rect.height > 0 ? Math.max(8, Math.round(vh - rect.top + 6)) : 56;
      if (vh - bottom - measuredH < 8) {
        bottom = Math.max(8, Math.min(bottom, vh - measuredH - 8));
      }
      pop.style.left = `${left}px`;
      pop.style.bottom = `${bottom}px`;
      pop.style.top = 'auto';
      if (popoverHostEl) {
        popoverHostEl.hidden = false;
        const pRect = pop.getBoundingClientRect?.();
        if (pRect && pRect.width > 0 && pRect.height > 0) {
          popoverHostEl.style.left = `${Math.round(pRect.left)}px`;
          popoverHostEl.style.top = `${Math.round(pRect.top)}px`;
          popoverHostEl.style.bottom = 'auto';
          popoverHostEl.style.right = 'auto';
          popoverHostEl.style.width = `${Math.round(pRect.width)}px`;
          popoverHostEl.style.height = `${Math.round(pRect.height)}px`;
          popoverHostEl.style.pointerEvents = 'auto';
        }
      }
    } catch { }
  }

  function openMenu(anchorOverride = null) {
    if (disposed) return false;
    if (!shadowRoot) {
      ensureHostCreated();
    }
    if (!shadowRoot) return false;
    if (closeAnimTimer) {
      clearTimeout(closeAnimTimer);
      closeAnimTimer = null;
    }
    menuOpen = true;
    isClosing = false;
    pillReady = false;
    activeHoverEl = null;
    try { onMenuOpen?.(); } catch { }
    const anchor = shadowRoot.getElementById('ag-sa-anchor');
    const trig = shadowRoot.getElementById('ag-sa-trigger');
    const pop = getPopEl('ag-sa-popover');
    if (anchor) anchor.classList.add('is-open');
    if (trig) trig.setAttribute('aria-expanded', 'true');
    if (popoverHostEl && document.body && popoverHostEl.parentElement !== document.body) {
      try { document.body.appendChild(popoverHostEl); } catch { }
    }
    if (popoverHostEl) popoverHostEl.hidden = false;
    syncTheme();

    render(true, { animateOpen: true });

    if (pop) {
      pop.classList.remove('is-closing');
      pop.hidden = false;
      if (anchorOverride && typeof anchorOverride.getBoundingClientRect === 'function') {
        try {
          const r = anchorOverride.getBoundingClientRect();
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const popW = Math.max(220, pop.offsetWidth || 244);
          const left = Math.max(8, Math.min(vw - popW - 8, Math.round(r.left)));
          const bottom = Math.max(8, Math.round(vh - r.top + 8));
          pop.style.left = `${left}px`;
          pop.style.bottom = `${bottom}px`;
          pop.style.top = 'auto';
          if (popoverHostEl) {
            const pRect = pop.getBoundingClientRect?.();
            const pw = Math.max(popW, Math.round(pRect?.width || popW));
            const ph = Math.max(120, Math.round(pRect?.height || 180));
            popoverHostEl.style.left = `${left}px`;
            popoverHostEl.style.top = `${Math.max(8, vh - bottom - ph)}px`;
            popoverHostEl.style.bottom = 'auto';
            popoverHostEl.style.right = 'auto';
            popoverHostEl.style.width = `${pw}px`;
            popoverHostEl.style.height = `${ph}px`;
            popoverHostEl.style.pointerEvents = 'auto';
          }
        } catch { positionPopover(); }
      } else {
        positionPopover();
      }
      void pop.offsetWidth;
      pop.classList.add('is-open');
    }
    applyStaggerRevealToMenuItems();
    const initialActiveOpt = popQuery('#ag-sa-list .sa-opt.is-active') || popQuery('#ag-sa-list .sa-opt');
    if (initialActiveOpt) {
      updateMagneticPill(initialActiveOpt, false);
    }
    return true;
  }

  function closeMenu(restoreFocus = false, immediate = false) {
    if (!shadowRoot) return;
    if (closeAnimTimer) {
      clearTimeout(closeAnimTimer);
      closeAnimTimer = null;
    }
    menuOpen = false;
    pillReady = false;
    activeHoverEl = null;
    const anchor = shadowRoot.getElementById('ag-sa-anchor');
    const trig = shadowRoot.getElementById('ag-sa-trigger');
    const pop = getPopEl('ag-sa-popover');
    const pill = getPopEl('ag-sa-hover-pill');
    if (anchor) anchor.classList.remove('is-open');
    if (trig) trig.setAttribute('aria-expanded', 'false');
    if (pill) pill.style.opacity = '0';

    const finishHide = () => {
      isClosing = false;
      if (!menuOpen && pop) {
        pop.classList.remove('is-open', 'is-closing');
        pop.hidden = true;
      }
      if (!menuOpen && popoverHostEl) {
        popoverHostEl.hidden = true;
        popoverHostEl.style.width = '0px';
        popoverHostEl.style.height = '0px';
        popoverHostEl.style.pointerEvents = 'none';
      }
      if (restoreFocus && trig && typeof trig.focus === 'function') {
        try { trig.focus({ preventScroll: true }); } catch { trig.focus(); }
      }
    };

    if (immediate || prefersReducedMotion() || !pop || pop.hidden) {
      finishHide();
    } else {
      isClosing = true;
      pop.classList.remove('is-open');
      pop.classList.add('is-closing');
      closeAnimTimer = setTimeout(() => {
        closeAnimTimer = null;
        finishHide();
      }, 205);
    }
  }

  function setFeedback(text, tone = 'idle') {
    lastActionFeedback = String(text || '');
    lastActionTone = tone || 'idle';
    render(true);
  }

  function detectCompactMode() {
    if (!hostEl) return false;
    try {
      const parent = hostEl.parentElement;
      const collapsedAncestor = hostEl.closest?.('[data-collapsed="true"], .is-collapsed, [aria-expanded="false"][data-sidebar]');
      if (collapsedAncestor) return true;
      const rect = (parent && typeof parent.getBoundingClientRect === 'function')
        ? parent.getBoundingClientRect()
        : hostEl.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.width < 126) return true;
    } catch { }
    return false;
  }

  function updateCompactAttr() {
    if (!hostEl) return;
    const next = detectCompactMode();
    if (next !== compactMode) {
      compactMode = next;
      hostEl.setAttribute('data-compact', compactMode ? 'true' : 'false');
    }
  }

  function syncTheme() {
    if (!hostEl) return;
    if (typeof syncThemeTarget === 'function') {
      try { syncThemeTarget(hostEl); } catch { }
      if (popoverHostEl) {
        try { syncThemeTarget(popoverHostEl); } catch { }
      }
    }
  }

  function renderAvatarNode(node, textNode, acc) {
    if (!node) return;
    const seed = acc?.email || acc?.name || 'guest';
    const existingImg = node.querySelector?.('.sa-avatar-img');
    const url = isValidAvatarSrc(acc?.profilePictureUrl)
      ? String(acc.profilePictureUrl).trim()
      : '';
    if (url) {
      let img = existingImg;
      if (!img) {
        img = document.createElement('img');
        img.className = 'sa-avatar-img';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => {
          try { img.remove(); } catch { }
          if (textNode) {
            textNode.hidden = false;
            textNode.textContent = extractInitial(acc?.name, acc?.email);
          }
          node.style.background = AVATAR_GRADIENTS[hashColorIdx(seed)];
        });
        node.insertBefore(img, node.firstChild);
      }
      if (img.src !== url) img.src = url;
      if (textNode) textNode.hidden = true;
      node.style.background = 'transparent';
    } else {
      if (existingImg) try { existingImg.remove(); } catch { }
      if (textNode) {
        textNode.hidden = false;
        textNode.textContent = extractInitial(acc?.name, acc?.email);
      }
      node.style.background = AVATAR_GRADIENTS[hashColorIdx(seed)];
    }
  }

  function createSpinnerSvg(doc) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9');
    svg.appendChild(p);
    return svg;
  }

  async function executeDirectSwitch(acc) {
    if (!acc || !acc.email || typeof onSwitchAccount !== 'function') return;
    const targetEmail = String(acc.email).trim();
    if (!targetEmail) return;
    if (switchingEmail) {
      setFeedback(t('sidebarAccount.busyBlocked'), 'idle');
      return;
    }
    switchingEmail = targetEmail.toLowerCase();
    setFeedback(t('sidebarAccount.switchingWait'), 'idle');
    try {
      const res = await onSwitchAccount(targetEmail);
      if (res?.cancelled) {
        setFeedback('', 'idle');
      } else if (res?.pendingRestart || res?.restartPending) {
        setFeedback(res.message || res.error || t('accountsPage.switchOverlayManual'), 'idle');
        setTimeout(() => { if (!disposed && menuOpen) closeMenu(false); }, 650);
      } else if (res?.officialManualSwitchRequired || res?.overlayMode === 'native_host_guide') {
        setFeedback(t('accountsPage.switchOverlayManual'), 'idle');
      } else if (res?.ok && res?.verifiedEffective !== false) {
        setFeedback(res.message || t('accounts.actionDone'), 'ok');
        setTimeout(() => { if (!disposed && menuOpen) closeMenu(false); }, 420);
      } else {
        setFeedback(res?.error || res?.message || t('accounts.actionFail'), 'error');
      }
    } catch (err) {
      setFeedback(err?.message || t('accounts.actionFail'), 'error');
    } finally {
      switchingEmail = null;
      render(true);
    }
  }

  function render(force = false, opts = {}) {
    if (disposed || !shadowRoot) return;
    updateCompactAttr();
    const st = getState() || {};
    const accounts = Array.isArray(st.accounts) ? st.accounts : [];
    const activeAcc = accounts.find((a) => a && a.isActive) || st.activeAccount || null;
    const hideEmail = Boolean(st.hideEmail);
    const busy = Boolean(st.busy);
    const activeIdNow = activeAcc ? String(activeAcc.accountId || activeAcc.email || '') : null;
    const switchedAccount = Boolean(lastActiveAccountId && activeIdNow && lastActiveAccountId !== activeIdNow);
    lastActiveAccountId = activeIdNow;

    const sig = JSON.stringify({
      menuOpen,
      switchingEmail,
      hideEmail,
      busy,
      refreshingActive,
      compactMode,
      lastActionFeedback,
      lastActionTone,
      lang: t('sidebarAccount.quickSwitch'),
      active: activeAcc ? [activeAcc.accountId || activeAcc.email, activeAcc.name, activeAcc.email, activeAcc.maskedEmail, activeAcc.planLabel || activeAcc.tierName, activeAcc.profilePictureUrl ? activeAcc.profilePictureUrl.slice(0, 48) : '', activeAcc.suspended, activeAcc.authInvalid] : null,
      list: accounts.map((a) => [a.accountId || a.email, a.isActive, a.name, a.email, a.maskedEmail, a.planLabel || a.tierName, a.profilePictureUrl ? a.profilePictureUrl.slice(0, 48) : '', a.suspended, a.authInvalid, a.lastQuotaUpdatedAtMs, resolveCompactQuotaHint(a).text])
    });
    if (!force && sig === lastRenderSig) return;
    lastRenderSig = sig;

    const trig = shadowRoot.getElementById('ag-sa-trigger');
    const avatarEl = shadowRoot.getElementById('ag-sa-avatar');
    const avatarTxt = shadowRoot.getElementById('ag-sa-avatar-text');
    const statusDot = shadowRoot.getElementById('ag-sa-status-dot');
    const nameEl = shadowRoot.getElementById('ag-sa-name');
    const planEl = shadowRoot.getElementById('ag-sa-plan');
    const subEl = shadowRoot.getElementById('ag-sa-sub');

    const activeDisplayEmail = formatAccountEmailForDisplay(activeAcc, hideEmail);
    const dispName = activeAcc?.name || activeDisplayEmail || t('sidebarAccount.unsigned');
    const dispSub = activeAcc ? activeDisplayEmail : t('sidebarAccount.clickToSignIn');
    const planInfo = activeAcc ? normalizePlanBadge(activeAcc) : { text: '', isUltra: false, unknown: true };

    renderAvatarNode(avatarEl, avatarTxt, activeAcc);
    if (avatarEl) {
      const profileHint = t('sidebarAccount.openProfileHome');
      avatarEl.classList?.toggle?.('is-profile-link', !compactMode);
      avatarEl.setAttribute('role', compactMode ? 'presentation' : 'button');
      avatarEl.setAttribute('tabindex', compactMode ? '-1' : '0');
      avatarEl.title = compactMode ? '' : profileHint;
      if (!compactMode) avatarEl.setAttribute('aria-label', profileHint);
      else avatarEl.removeAttribute?.('aria-label');
    }
    if (statusDot) {
      const dotTone = !activeAcc ? 'muted' : (activeAcc.suspended ? 'danger' : (activeAcc.authInvalid ? 'warn' : 'ok'));
      statusDot.setAttribute('data-tone', dotTone);
    }
    if (nameEl) nameEl.textContent = dispName;
    if (planEl) {
      planEl.hidden = !planInfo.text;
      planEl.textContent = planInfo.text;
      planEl.className = `sa-plan${planInfo.isUltra ? ' is-ultra' : ''}`;
    }
    if (subEl) subEl.textContent = dispSub;
    if (trig) {
      trig.title = `${dispName}${planInfo.text ? ` · ${planInfo.text}` : ''}`;
      trig.setAttribute('aria-label', `${t('sidebarAccount.triggerAria')} ${dispName}`);
    }
    if (switchedAccount) {
      playSwitchDockAnimation();
    }

    const popTitle = getPopEl('ag-sa-pop-title');
    const popCount = getPopEl('ag-sa-pop-count');
    if (popTitle) popTitle.textContent = t('sidebarAccount.quickSwitch');
    if (popCount) popCount.textContent = String(accounts.length);

    const lblProfile = getPopEl('ag-sa-lbl-profile');
    const lblRefresh = getPopEl('ag-sa-lbl-refresh');
    const lblAdd = getPopEl('ag-sa-lbl-add');
    const lblAccounts = getPopEl('ag-sa-lbl-accounts');
    const lblSettings = getPopEl('ag-sa-lbl-settings');
    if (lblProfile) lblProfile.textContent = t('sidebarAccount.profileHomeMenu') || '个人用量主页';
    const phEnabled = typeof window !== 'undefined' && typeof window.__AGContextMeter?.getProfileHomeEnabled === 'function'
      ? Boolean(window.__AGContextMeter.getProfileHomeEnabled())
      : true;
    const topActWrap = getPopEl('ag-sa-top-actions');
    const topDivEl = getPopEl('ag-sa-top-divider');
    const actProfileBtn = getPopEl('ag-sa-act-profile');
    if (topActWrap) topActWrap.hidden = !phEnabled;
    if (topDivEl) topDivEl.hidden = !phEnabled;
    if (actProfileBtn) actProfileBtn.hidden = !phEnabled;
    if (lblRefresh) lblRefresh.textContent = refreshingActive ? t('sidebarAccount.refreshing') : t('sidebarAccount.refreshActive');
    if (lblAdd) lblAdd.textContent = busy ? t('accounts.actionBusy') : t('sidebarAccount.addAccount');
    if (lblAccounts) lblAccounts.textContent = t('accountsPage.navLabel');
    if (lblSettings) lblSettings.textContent = t('sidebarAccount.settings');

    const actRefresh = getPopEl('ag-sa-act-refresh');
    if (actRefresh) {
      actRefresh.disabled = busy || refreshingActive || !activeAcc;
      actRefresh.classList.toggle('is-spinning', refreshingActive);
    }
    const actAdd = getPopEl('ag-sa-act-add');
    if (actAdd) actAdd.disabled = busy;

    const listEl = getPopEl('ag-sa-list');
    const pillEl = getPopEl('ag-sa-hover-pill');
    const doc = hostEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (listEl && doc) {
      const listSig = JSON.stringify({
        hideEmail,
        switchingEmail: switchingEmail || '',
        busy,
        emptyTxt: t('sidebarAccount.emptyAccounts'),
        items: accounts.map((acc) => {
          const qInfo = resolveCompactQuotaHint(acc);
          const pInfo = normalizePlanBadge(acc);
          return [
            acc.accountId || acc.email || '',
            acc.email || '',
            acc.maskedEmail || '',
            acc.name || '',
            pInfo.text || '',
            Boolean(acc.isActive),
            Boolean(acc.suspended),
            Boolean(acc.hasRefreshToken),
            Boolean(acc.authInvalid),
            acc.profilePictureUrl ? String(acc.profilePictureUrl).slice(0, 48) : '',
            qInfo.pct,
            qInfo.tone,
            qInfo.text
          ];
        })
      });
      const existingOptsCount = listEl.querySelectorAll ? listEl.querySelectorAll('.sa-opt, .sa-empty').length : 0;
      const shouldRebuildList = listSig !== lastListSig || existingOptsCount === 0 || Boolean(opts.animateOpen);
      if (shouldRebuildList) {
        lastListSig = listSig;
        const prevScrollTop = Number(listEl.scrollTop || 0);
        // 仅移除列表内容节点，保留位于 .sa-list 内部的磁吸高亮胶囊 #ag-sa-hover-pill
        for (const ch of Array.from(listEl.children || [])) {
          if (ch && ch !== pillEl && ch.id !== 'ag-sa-hover-pill') {
            try { ch.remove(); } catch { listEl.removeChild(ch); }
          }
        }
        if (accounts.length === 0) {
          const empty = doc.createElement('div');
          empty.className = 'sa-empty';
          empty.textContent = t('sidebarAccount.emptyAccounts');
          listEl.appendChild(empty);
        } else {
          const shouldAnimateCheck = Boolean(opts.animateOpen || switchedAccount);
          for (const acc of accounts) {
            const normAccEmail = String(acc.email || '').trim().toLowerCase();
            const isSwitchingThis = Boolean(switchingEmail && normAccEmail && switchingEmail === normAccEmail);
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = `sa-opt${acc.isActive ? ' is-active' : ''}${acc.suspended ? ' is-suspended' : ''}${isSwitchingThis ? ' is-switching' : ''}`;
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', acc.isActive ? 'true' : 'false');
            btn.setAttribute('data-sa-magnetic', 'true');
            btn.setAttribute('data-account-id', acc.accountId || acc.email || '');
            btn.setAttribute('data-account-email', acc.email || '');

            const av = doc.createElement('span');
            av.className = 'sa-avatar';
            const avT = doc.createElement('span');
            av.appendChild(avT);
            renderAvatarNode(av, avT, acc);

            const info = doc.createElement('span');
            info.className = 'sa-opt-info';

            const top = doc.createElement('span');
            top.className = 'sa-opt-top';
            const nm = doc.createElement('span');
            nm.className = 'sa-opt-name';
            const accDispEmail = formatAccountEmailForDisplay(acc, hideEmail);
            nm.textContent = acc.name || accDispEmail || '--';
            top.appendChild(nm);
            const pInfo = normalizePlanBadge(acc);
            if (pInfo.text) {
              const pb = doc.createElement('span');
              pb.className = `sa-plan${pInfo.isUltra ? ' is-ultra' : ''}`;
              pb.textContent = pInfo.text;
              top.appendChild(pb);
            }

            const em = doc.createElement('span');
            em.className = 'sa-opt-email';
            em.textContent = accDispEmail;

            const qInfo = resolveCompactQuotaHint(acc);
            const qRow = doc.createElement('span');
            qRow.className = 'sa-opt-quota';
            if (qInfo.pct !== null) {
              const bar = doc.createElement('span');
              bar.className = 'sa-opt-bar';
              const fill = doc.createElement('span');
              fill.className = 'sa-opt-fill';
              fill.setAttribute('data-tone', qInfo.tone);
              fill.style.width = `${qInfo.pct}%`;
              bar.appendChild(fill);
              qRow.appendChild(bar);
            }
            const qTxt = doc.createElement('span');
            qTxt.className = 'sa-opt-qtext';
            qTxt.setAttribute('data-tone', qInfo.tone);
            qTxt.textContent = qInfo.text;
            qRow.appendChild(qTxt);

            info.appendChild(top);
            info.appendChild(em);
            info.appendChild(qRow);

            const chk = doc.createElement('span');
            chk.className = 'sa-opt-check';
            chk.setAttribute('aria-hidden', 'true');
            if (isSwitchingThis) {
              chk.appendChild(createSpinnerSvg(doc));
            } else if (acc.isActive) {
              chk.appendChild(createTickSVG(doc, shouldAnimateCheck && !prefersReducedMotion()));
            }

            btn.appendChild(av);
            btn.appendChild(info);
            btn.appendChild(chk);

            btn.addEventListener('click', (ev) => {
              ev?.stopPropagation?.();
              if (busy || switchingEmail) {
                setFeedback(t('sidebarAccount.busyBlocked'), 'idle');
                return;
              }
              if (acc.isActive) {
                setFeedback(t('sidebarAccount.alreadyActive'), 'idle');
                return;
              }
              if (acc.suspended) {
                setFeedback(t('sidebarAccount.suspendedSwitchBlocked'), 'error');
                return;
              }
              // 单击直接发起真实切号流程（走插件主题一体化过渡提示，不弹原生白框）
              void executeDirectSwitch(acc);
            });

            listEl.appendChild(btn);
          }
        }
        if (prevScrollTop > 0) listEl.scrollTop = prevScrollTop;
      }
    }

    const fbEl = getPopEl('ag-sa-feedback');
    if (fbEl) {
      const text = lastActionFeedback || st.feedback || '';
      const tone = lastActionFeedback ? lastActionTone : (st.feedbackTone === 'error' ? 'error' : (st.feedbackTone === 'success' ? 'ok' : 'idle'));
      fbEl.hidden = !text;
      fbEl.textContent = text;
      fbEl.setAttribute('data-tone', tone);
    }
  }

  function bindShadowEvents() {
    if (!shadowRoot || shadowRoot.__agSaBound) return;
    shadowRoot.__agSaBound = true;

    // 阶段六/7.7 裁决：左下角账号头像单击始终打开账号切换上拉菜单，绝不劫持切号功能；个人主页入口置于上拉菜单顶部
    const avatarEl = shadowRoot.getElementById('ag-sa-avatar');
    avatarEl?.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      if (menuOpen) closeMenu(false);
      else openMenu();
    });
    avatarEl?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev?.stopPropagation?.();
        ev?.preventDefault?.();
        if (menuOpen) closeMenu(false);
        else openMenu();
      }
    });

    const trig = shadowRoot.getElementById('ag-sa-trigger');
    trig?.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      if (menuOpen) closeMenu(false);
      else openMenu();
    });
    trig?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowUp') {
        ev.preventDefault?.();
        if (menuOpen && ev.key === ' ') closeMenu(false);
        else {
          openMenu();
          const firstItem = popQuery('#ag-sa-list .sa-opt, #ag-sa-footer .sa-action');
          firstItem?.focus?.();
          if (firstItem && firstItem.classList?.contains?.('sa-opt')) updateMagneticPill(firstItem, false);
        }
      } else if (ev.key === 'Escape' && menuOpen) {
        ev.preventDefault?.();
        closeMenu(true);
      }
    });

    const listEl = getPopEl('ag-sa-list');
    const handleMagneticHit = (ev) => {
      if (!menuOpen) return;
      const hit = ev.target && ev.target.closest ? ev.target.closest('.sa-opt[data-sa-magnetic="true"]') : null;
      if (hit && listEl?.contains(hit) && hit !== activeHoverEl && !hit.disabled) {
        updateMagneticPill(hit, true);
      }
    };
    listEl?.addEventListener('mousemove', handleMagneticHit);
    listEl?.addEventListener('mouseover', handleMagneticHit);
    listEl?.addEventListener('focusin', handleMagneticHit);
    listEl?.addEventListener('mouseleave', () => {
      if (!menuOpen) return;
      updateMagneticPill(null, false);
    });
    listEl?.addEventListener('scroll', () => {
      if (!menuOpen) return;
      if (activeHoverEl && listEl.contains(activeHoverEl)) {
        const top = Number(activeHoverEl.offsetTop || 0);
        const h = Number(activeHoverEl.offsetHeight || 0);
        const st = Number(listEl.scrollTop || 0);
        const ch = Number(listEl.clientHeight || 0);
        if (ch > 0 && (top + h < st || top > st + ch)) {
          updateMagneticPill(null, false);
        } else {
          updateMagneticPill(activeHoverEl, false);
        }
      }
    }, { passive: true });

    const pop = getPopEl('ag-sa-popover');
    pop?.addEventListener('keydown', (ev) => {
      if (!menuOpen) return;
      if (ev.key === 'Escape') {
        ev.preventDefault?.();
        closeMenu(true);
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault?.();
        const items = Array.from(pop.querySelectorAll('button:not([disabled]):not([hidden])') || []).filter((b) => !b.closest('[hidden]'));
        if (!items.length) return;
        const activeRoot = popoverShadowRoot || shadowRoot;
        const curIdx = items.indexOf(activeRoot?.activeElement);
        const nextIdx = ev.key === 'ArrowDown'
          ? (curIdx < 0 ? 0 : (curIdx + 1) % items.length)
          : (curIdx <= 0 ? items.length - 1 : curIdx - 1);
        const nextBtn = items[nextIdx];
        nextBtn?.focus?.();
        if (nextBtn && nextBtn.classList?.contains?.('sa-opt')) {
          updateMagneticPill(nextBtn, true);
        } else {
          updateMagneticPill(null, false);
        }
      }
    });

    getPopEl('ag-sa-act-profile')?.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      triggerProfileHomeOpen('sidebar-menu');
    });

    getPopEl('ag-sa-act-refresh')?.addEventListener('click', async (ev) => {
      ev?.stopPropagation?.();
      if (refreshingActive || typeof onRefreshActive !== 'function') return;
      refreshingActive = true;
      setFeedback(t('sidebarAccount.refreshing'), 'idle');
      try {
        const res = await onRefreshActive();
        if (res && res.ok === false) {
          setFeedback(res.error || res.message || t('accounts.actionFail'), 'error');
        } else {
          setFeedback(res?.message || t('sidebarAccount.refreshDone'), 'ok');
        }
      } catch (err) {
        setFeedback(err?.message || t('accounts.actionFail'), 'error');
      } finally {
        refreshingActive = false;
        render(true);
      }
    });

    getPopEl('ag-sa-act-add')?.addEventListener('click', async (ev) => {
      ev?.stopPropagation?.();
      if (typeof onAddAccount !== 'function') return;
      setFeedback(t('sidebarAccount.loginWaiting'), 'idle');
      try {
        const res = await onAddAccount();
        if (res?.cancelled) {
          setFeedback(t('sidebarAccount.loginCancelled'), 'idle');
        } else if (res?.nativeLoginGuided) {
          setFeedback(res.message || t('sidebarAccount.loginWaiting'), 'idle');
        } else if (res?.ok && res?.quotaOk === false) {
          setFeedback(res.message || res.quotaError || t('accounts.actionDone'), 'idle');
        } else if (res?.ok) {
          setFeedback(res.message || t('accounts.actionDone'), 'ok');
        } else {
          setFeedback(res?.error || res?.message || t('accounts.actionFail'), 'error');
        }
      } catch (err) {
        setFeedback(err?.message || t('accounts.actionFail'), 'error');
      }
    });

    getPopEl('ag-sa-act-accounts')?.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      closeMenu(false, true);
      if (typeof onOpenAccountsPage === 'function') onOpenAccountsPage();
    });

    getPopEl('ag-sa-act-settings')?.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      triggerNativeSettingsOpen();
    });
  }

  function installPortalQueryDelegation(baseSr, portalSr) {
    if (!baseSr || !portalSr || baseSr.__agSaPortalDelegated) return;
    baseSr.__agSaPortalDelegated = true;
    try {
      const origGetById = typeof baseSr.getElementById === 'function' ? baseSr.getElementById.bind(baseSr) : null;
      const origQs = typeof baseSr.querySelector === 'function' ? baseSr.querySelector.bind(baseSr) : null;
      const origQsa = typeof baseSr.querySelectorAll === 'function' ? baseSr.querySelectorAll.bind(baseSr) : null;
      if (origGetById) {
        Object.defineProperty(baseSr, 'getElementById', {
          configurable: true,
          value: (id) => origGetById(id) || portalSr.getElementById?.(id) || null
        });
      }
      if (origQs) {
        Object.defineProperty(baseSr, 'querySelector', {
          configurable: true,
          value: (sel) => origQs(sel) || portalSr.querySelector?.(sel) || null
        });
      }
      if (origQsa) {
        Object.defineProperty(baseSr, 'querySelectorAll', {
          configurable: true,
          value: (sel) => {
            const a = Array.from(origQsa(sel) || []);
            const b = Array.from(portalSr.querySelectorAll?.(sel) || []);
            return b.length ? a.concat(b) : a;
          }
        });
      }
    } catch { }
  }

  function ensureHostCreated() {
    if (hostEl && shadowRoot) {
      if (popoverHostEl && document.body && popoverHostEl.parentElement !== document.body) {
        try { document.body.appendChild(popoverHostEl); } catch { }
      }
      return true;
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    const node = document.createElement('div');
    node.id = HOST_ID;
    node.setAttribute('data-ag-sidebar-account', 'true');
    if (typeof node.attachShadow !== 'function') return false;
    const sr = node.attachShadow({ mode: 'open' });
    if (!sr) return false;
    const sharedCss = buildStyles();
    const stEl = document.createElement('style');
    stEl.textContent = sharedCss;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildTriggerMarkup();
    sr.appendChild(stEl);
    while (wrap.firstChild) sr.appendChild(wrap.firstChild);

    // 顶层浮层 Portal：挂载到 document.body 最高层级，彻底脱离侧栏层叠上下文与 overflow 裁切
    const existingPortal = document.getElementById?.(POPOVER_HOST_ID);
    if (existingPortal) {
      try { existingPortal.remove(); } catch { }
    }
    const popHost = document.createElement('div');
    popHost.id = POPOVER_HOST_ID;
    popHost.setAttribute('data-ag-sidebar-account-popover', 'true');
    popHost.setAttribute('data-om-account-popover', 'true');
    popHost.hidden = true;
    popHost.style.cssText = `position:fixed;inset:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:${POPOVER_Z_INDEX};`;
    const popSr = typeof popHost.attachShadow === 'function' ? popHost.attachShadow({ mode: 'open' }) : null;
    if (popSr) {
      const popSt = document.createElement('style');
      popSt.textContent = sharedCss;
      const popWrap = document.createElement('div');
      popWrap.innerHTML = buildPopoverMarkup();
      popSr.appendChild(popSt);
      while (popWrap.firstChild) popSr.appendChild(popWrap.firstChild);
      if (document.body) {
        try { document.body.appendChild(popHost); } catch { }
      }
      popoverHostEl = popHost;
      popoverShadowRoot = popSr;
      installPortalQueryDelegation(sr, popSr);
    } else {
      const fallbackWrap = document.createElement('div');
      fallbackWrap.innerHTML = buildPopoverMarkup();
      while (fallbackWrap.firstChild) sr.appendChild(fallbackWrap.firstChild);
      popoverHostEl = null;
      popoverShadowRoot = null;
    }

    hostEl = node;
    shadowRoot = sr;
    bindShadowEvents();
    return true;
  }

  function syncMount() {
    if (disposed) return false;
    const nativeBtn = findNativeSettingsButton();
    if (!nativeBtn || !nativeBtn.parentElement) {
      if (origSettingsBtn && origSettingsBtn.isConnected === false) {
        origSettingsBtn = null;
        origHiddenByUs = false;
      }
      mountedOk = false;
      return false;
    }

    if (origSettingsBtn && origSettingsBtn !== nativeBtn) {
      restoreNativeSettingsButton(false);
    }
    origSettingsBtn = nativeBtn;

    if (!ensureHostCreated()) {
      restoreNativeSettingsButton(false);
      mountedOk = false;
      return false;
    }

    try {
      if (hostEl.parentElement !== nativeBtn.parentElement || hostEl.nextElementSibling !== nativeBtn) {
        nativeBtn.parentElement.insertBefore(hostEl, nativeBtn);
      }
    } catch {
      restoreNativeSettingsButton(false);
      mountedOk = false;
      return false;
    }

    syncTheme();
    updateCompactAttr();
    render(true);

    const hiddenOk = hideNativeSettingsButtonSafely(nativeBtn);
    mountedOk = Boolean(hiddenOk && hostEl.isConnected);
    if (!mountedOk) {
      restoreNativeSettingsButton(false);
    }

    if (mountedOk && typeof ResizeObserver === 'function' && !resizeObserver && hostEl.parentElement) {
      try {
        resizeObserver = new ResizeObserver(() => {
          if (disposed) return;
          updateCompactAttr();
          if (menuOpen) positionPopover();
        });
        resizeObserver.observe(hostEl.parentElement);
      } catch { }
    }
    return mountedOk;
  }

  function scheduleSync() {
    if (disposed || syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncMount();
    }, 80);
  }

  function start(opts = {}) {
    if (disposed) return false;
    const ok = syncMount();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !outsideClickHandler) {
      outsideClickHandler = (ev) => {
        if (disposed) return;
        const hostAcctBtn = ev?.target?.closest?.('#host-account-pill, [data-testid="sidebar-account-button"]');
        if (hostAcctBtn) {
          ev.stopPropagation?.();
          if (menuOpen) closeMenu(false);
          else openMenu(hostAcctBtn);
          return;
        }
        if (!menuOpen) return;
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
        if (hostEl && (path.includes(hostEl) || ev.target === hostEl)) return;
        if (popoverHostEl && (path.includes(popoverHostEl) || ev.target === popoverHostEl)) return;
        closeMenu(false);
      };
      document.addEventListener('click', outsideClickHandler, true);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !keydownHandler) {
      keydownHandler = (ev) => {
        if (menuOpen && ev.key === 'Escape') {
          ev.preventDefault?.();
          closeMenu(true);
        }
      };
      window.addEventListener('keydown', keydownHandler, true);
      window.addEventListener('resize', positionPopover);
    }
    if (opts.watchDom !== false && typeof MutationObserver === 'function' && typeof document !== 'undefined' && !observer) {
      const target = document.body || document.documentElement;
      if (target) {
        observer = new MutationObserver((mutations) => {
          if (disposed) return;
          for (const m of mutations || []) {
            if (isPluginOwned(m?.target)) continue;
            scheduleSync();
            break;
          }
        });
        try { observer.observe(target, { childList: true, subtree: true }); } catch { }
      }
    }
    return ok;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      const ae = typeof document !== 'undefined' ? document.activeElement : null;
      lastFocusBeforeDispose = Boolean(hostEl && (ae === hostEl || hostEl.contains?.(ae)));
    } catch { lastFocusBeforeDispose = false; }
    closeMenu(false, true);
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (closeAnimTimer) { clearTimeout(closeAnimTimer); closeAnimTimer = null; }
    try { observer?.disconnect?.(); } catch { }
    observer = null;
    try { resizeObserver?.disconnect?.(); } catch { }
    resizeObserver = null;
    if (outsideClickHandler && typeof document !== 'undefined') {
      try { document.removeEventListener('click', outsideClickHandler, true); } catch { }
      outsideClickHandler = null;
    }
    if (keydownHandler && typeof window !== 'undefined') {
      try { window.removeEventListener('keydown', keydownHandler, true); } catch { }
      try { window.removeEventListener('resize', positionPopover); } catch { }
      keydownHandler = null;
    }
    restoreNativeSettingsButton(lastFocusBeforeDispose);
    try { hostEl?.remove?.(); } catch { }
    try { popoverHostEl?.remove?.(); } catch { }
    hostEl = null;
    shadowRoot = null;
    popoverHostEl = null;
    popoverShadowRoot = null;
    origSettingsBtn = null;
    mountedOk = false;
  }

  return {
    start,
    dispose,
    syncMount,
    scheduleSync,
    syncTheme,
    render: () => render(true),
    openMenu,
    closeMenu,
    triggerNativeSettingsOpen,
    triggerProfileHomeOpen,
    getHostElement: () => hostEl,
    getShadowRoot: () => shadowRoot,
    getPopoverHostElement: () => popoverHostEl,
    getPopoverShadowRoot: () => popoverShadowRoot,
    getStateForTest: () => ({
      disposed,
      mounted: mountedOk,
      menuOpen,
      isClosing,
      compactMode,
      popoverInBodyPortal: Boolean(popoverHostEl && typeof document !== 'undefined' && popoverHostEl.parentElement === document.body),
      popoverZIndex: POPOVER_Z_INDEX,
      origSettingsHidden: Boolean(origSettingsBtn && (origSettingsBtn.hidden || origSettingsBtn.getAttribute?.(ORIG_HIDDEN_ATTR) === 'true')),
      hasOrigSettingsBtn: Boolean(origSettingsBtn),
      switchingEmail,
      refreshingActive,
      feedback: lastActionFeedback
    })
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSidebarAccountController };
}
