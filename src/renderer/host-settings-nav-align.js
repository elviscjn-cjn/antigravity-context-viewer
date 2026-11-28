'use strict';
/**
 * 07 宿主 Settings 左栏字体、字重与颜色对齐模块（含回归 #4 彻底修复）
 *
 * 结合 Antigravity 2.35.2 真实宿主 DOM（[data-testid="settings-sidebar"]）：
 * - 官方导航项为纯文本结构（零前缀 SVG 图标）：
 *   `div.relative.group/nav-item.mx-2 > button[data-testid="settings-nav-item-*"] > span`
 * - 官方未选中项使用常规字重（400）与 `text-secondary-foreground`（如 #9d9d9d），
 *   选中态切换 `bg-sidebar-secondary` 与 `text-foreground`（如 #cccccc），绝无 font-weight: 600 加粗。
 *
 * 本模块提供：
 * 1. 纯净样式规则 `buildAlignedHostSettingsNavCss`（零加粗覆盖、纯文本对齐、悬停与选中态同步官方高亮）；
 * 2. 未选中官方基准项选取函数 `pickUnselectedNativeNavRef`（避免把选中项样式抄给未选中插件项）；
 * 3. 运行时计算样式同步 `alignHostSettingsNavTypography`（同步 fontFamily / fontSize / fontWeight /
 *    lineHeight / letterSpacing / color / opacity / paddingLeft，并区分未选中与选中态）。
 */
(function (rootScope) {
  const HOST_SETTINGS_NAV_IDS = Object.freeze([
    'ag-cm-host-settings-nav',
    'ag-cm-host-settings-compact-nav',
    'ag-cm-host-settings-accounts-nav'
  ]);

  function isNativeNavBtnSelected(btn) {
    if (!btn) return false;
    if (btn.getAttribute?.('aria-selected') === 'true') return true;
    if (btn.getAttribute?.('data-active') === 'true') return true;
    if (btn.getAttribute?.('data-state') === 'active') return true;
    const cls = String(btn.className || '');
    return /\b(active|is-active|selected|bg-sidebar-secondary|bg-sidebar-accent|bg-accent|bg-ide-input-background)\b/.test(cls);
  }

  /**
   * 从宿主设置左栏官方按钮中选取一个「未选中」的基准按钮（优先 Browser / 浏览器），
   * 同时返回当前已选中的官方按钮（如有），用于采集官方选中态底色与前景色。
   */
  function pickUnselectedNativeNavRef(nativeBtns, preferredBtn = null) {
    const list = (Array.isArray(nativeBtns) ? nativeBtns : []).filter(Boolean);
    const activeRef = list.find((b) => isNativeNavBtnSelected(b)) || null;
    if (preferredBtn && !isNativeNavBtnSelected(preferredBtn)) {
      return { unselectedRef: preferredBtn, activeRef };
    }
    const unselectedBrowser = list.find((b) => (
      !isNativeNavBtnSelected(b) && (
        b.id === 'settings-nav-item-Browser'
        || b.getAttribute?.('data-testid') === 'settings-nav-item-Browser'
        || /browser|浏览器|瀏覽器/i.test(String(b.textContent || ''))
      )
    ));
    if (unselectedBrowser) return { unselectedRef: unselectedBrowser, activeRef };
    const anyUnselected = list.find((b) => !isNativeNavBtnSelected(b)) || preferredBtn || list[0] || null;
    return { unselectedRef: anyUnselected, activeRef };
  }

  /**
   * 纯净的宿主设置左栏样式块：
   * - 移除所有高于官方项的 font-weight 加粗覆盖与纯白强覆写
   * - 纯文本左对齐，零突兀前缀图标
   * - 未选中态严格贴齐官方未选中色值与不透明度；悬停态同步官方 hover；选中态同步官方高亮背景与前景色
   */
  function buildAlignedHostSettingsNavCss(navIds = HOST_SETTINGS_NAV_IDS) {
    const ids = Array.isArray(navIds) && navIds.length ? navIds : HOST_SETTINGS_NAV_IDS;
    const baseSel = ids.map(id => `#${id}`).join(',\n');
    const labelSel = ids.map(id => `#${id} > .ag-hs-nav-label`).join(',\n');
    const inactiveSel = ids.map(id => `#${id}[data-active="false"]`).join(',\n');
    const inactiveHoverSel = ids.map(id => `#${id}[data-active="false"]:hover`).join(',\n');
    const activeSel = ids.map(id => `#${id}[data-active="true"]`).join(',\n');
    return `
      ${baseSel} {
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
      ${labelSel} {
        pointer-events: none !important;
        flex: 1 1 auto !important;
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        user-select: none !important;
        font-family: inherit !important;
        font-size: inherit !important;
        font-weight: inherit !important;
        line-height: inherit !important;
        letter-spacing: inherit !important;
        color: inherit !important;
        vertical-align: middle !important;
      }
      ${inactiveSel} {
        background: transparent !important;
        background-color: transparent !important;
        color: var(--ag-hs-inactive-color, var(--secondary-foreground, inherit)) !important;
        opacity: var(--ag-hs-inactive-opacity, 1) !important;
      }
      ${inactiveHoverSel} {
        background: var(--sidebar-muted, rgba(128, 128, 128, 0.10)) !important;
        color: var(--ag-hs-active-color, var(--foreground, inherit)) !important;
      }
      ${activeSel} {
        background: var(--ag-hs-active-bg, var(--sidebar-secondary, var(--vscode-list-activeSelectionBackground, color-mix(in srgb, var(--primary, var(--ag-host-accent, #7849D1)) 16%, transparent)))) !important;
        color: var(--ag-hs-active-color, var(--vscode-list-activeSelectionForeground, var(--foreground, inherit))) !important;
        opacity: 1 !important;
      }
    `;
  }

  /**
   * 检测样式文本是否仍包含违规的插件导航加粗覆盖
   */
  function hasForbiddenNavBoldOverride(cssText) {
    const raw = String(cssText || '');
    const normalized = raw.replace(/\$\{[A-Z0-9_]+\}/g, (token) => {
      if (token === '${NAV_ID}') return 'ag-cm-host-settings-nav';
      if (token === '${NAV_COMPACT_ID}') return 'ag-cm-host-settings-compact-nav';
      if (token === '${NAV_ACCOUNTS_ID}') return 'ag-cm-host-settings-accounts-nav';
      return 'ag-cm-placeholder';
    });
    const activeBlockRe = /#ag-cm-host-settings-(?:nav|compact-nav|accounts-nav)\[data-active="true"\][^{]*\{([^}]*)\}/g;
    let m;
    while ((m = activeBlockRe.exec(normalized)) !== null) {
      if (/font-weight\s*:\s*(?:[6-9]\d\d|bold|bolder)/i.test(m[1])) {
        return true;
      }
    }
    return false;
  }

  function applyDualStyleProp(styleObj, camelProp, kebabProp, value, important = false) {
    if (!styleObj || value === undefined || value === null || value === '') return;
    try { styleObj[camelProp] = String(value); } catch { }
    if (important && typeof styleObj.setProperty === 'function') {
      try { styleObj.setProperty(kebabProp, String(value), 'important'); } catch { }
    }
  }

  /**
   * 运行时将宿主原生未选中基准按钮（优先 Browser / 浏览器）的排版与视觉计算样式对齐到插件导航按钮：
   * fontFamily / fontSize / fontWeight / lineHeight / letterSpacing / color / opacity / paddingLeft。
   * 未选中态 100% 贴齐官方未选中项；选中态同步官方高亮背景与前景色，绝不人工加粗。
   */
  function alignHostSettingsNavTypography(nativeRefBtn, pluginNavBtns, win = (typeof window !== 'undefined' ? window : null), opts = {}) {
    const targets = Array.isArray(pluginNavBtns) ? pluginNavBtns.filter(Boolean) : [];
    if (!nativeRefBtn || !targets.length) return { applied: false, metrics: null };
    const getCS = typeof win?.getComputedStyle === 'function' ? (el) => {
      try { return win.getComputedStyle(el); } catch { return null; }
    } : () => null;

    const cs = getCS(nativeRefBtn);
    const refInnerTextEl = nativeRefBtn.querySelector?.('span, div, p') || null;
    const innerCs = refInnerTextEl ? getCS(refInnerTextEl) : null;

    const pickTextVal = (prop, fallback = '') => (
      (innerCs && innerCs[prop])
      || (cs && cs[prop])
      || (nativeRefBtn.style && nativeRefBtn.style[prop])
      || fallback
    );
    const pickBoxVal = (prop, fallback = '') => (
      (cs && cs[prop])
      || (nativeRefBtn.style && nativeRefBtn.style[prop])
      || fallback
    );

    const metrics = {
      fontFamily: pickTextVal('fontFamily'),
      fontSize: pickTextVal('fontSize'),
      fontWeight: pickTextVal('fontWeight'),
      lineHeight: pickTextVal('lineHeight'),
      letterSpacing: pickTextVal('letterSpacing'),
      color: pickTextVal('color'),
      opacity: pickBoxVal('opacity'),
      paddingLeft: pickBoxVal('paddingLeft'),
      paddingRight: pickBoxVal('paddingRight'),
      paddingTop: pickBoxVal('paddingTop'),
      paddingBottom: pickBoxVal('paddingBottom'),
      height: pickBoxVal('height'),
      borderRadius: pickBoxVal('borderRadius')
    };

    const activeRefBtn = opts?.activeNativeRefBtn || null;
    const activeCs = activeRefBtn ? getCS(activeRefBtn) : null;
    const activeInner = activeRefBtn?.querySelector?.('span, div, p') || null;
    const activeInnerCs = activeInner ? getCS(activeInner) : null;
    const activeBg = activeCs?.backgroundColor && activeCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && activeCs.backgroundColor !== 'transparent'
      ? activeCs.backgroundColor
      : '';
    const activeColor = (activeInnerCs?.color || activeCs?.color || '');

    for (const btn of targets) {
      if (!btn.style) continue;

      if (typeof btn.style.setProperty === 'function') {
        try {
          if (metrics.color) btn.style.setProperty('--ag-hs-inactive-color', metrics.color);
          if (metrics.opacity) btn.style.setProperty('--ag-hs-inactive-opacity', metrics.opacity);
          if (activeBg) btn.style.setProperty('--ag-hs-active-bg', activeBg);
          if (activeColor) btn.style.setProperty('--ag-hs-active-color', activeColor);
        } catch { }
      }

      if (metrics.fontFamily) applyDualStyleProp(btn.style, 'fontFamily', 'font-family', metrics.fontFamily, true);
      if (metrics.fontSize) applyDualStyleProp(btn.style, 'fontSize', 'font-size', metrics.fontSize, true);
      if (metrics.fontWeight) applyDualStyleProp(btn.style, 'fontWeight', 'font-weight', metrics.fontWeight, true);
      if (metrics.lineHeight) applyDualStyleProp(btn.style, 'lineHeight', 'line-height', metrics.lineHeight, true);
      if (metrics.letterSpacing) applyDualStyleProp(btn.style, 'letterSpacing', 'letter-spacing', metrics.letterSpacing, true);
      if (metrics.paddingLeft) applyDualStyleProp(btn.style, 'paddingLeft', 'padding-left', metrics.paddingLeft, true);
      if (metrics.paddingRight) applyDualStyleProp(btn.style, 'paddingRight', 'padding-right', metrics.paddingRight, false);
      if (metrics.paddingTop) applyDualStyleProp(btn.style, 'paddingTop', 'padding-top', metrics.paddingTop, false);
      if (metrics.paddingBottom) applyDualStyleProp(btn.style, 'paddingBottom', 'padding-bottom', metrics.paddingBottom, false);
      if (metrics.borderRadius) applyDualStyleProp(btn.style, 'borderRadius', 'border-radius', metrics.borderRadius, false);

      const lbl = btn.querySelector?.('.ag-hs-nav-label');
      if (lbl && lbl.style) {
        lbl.style.fontWeight = 'inherit';
        lbl.style.fontSize = 'inherit';
        lbl.style.fontFamily = 'inherit';
        lbl.style.lineHeight = 'inherit';
        lbl.style.letterSpacing = 'inherit';
        lbl.style.color = 'inherit';
      }
    }
    return { applied: true, metrics };
  }

  /**
   * 精确补丁描述（向后兼容导出）
   */
  const HOST_SETTINGS_PATCH_SPEC = Object.freeze({
    targetFile: 'src/renderer/host-settings.js',
    lineRange: '114-138',
    removeLine: 'font-weight: 600 !important;',
    addRuleSummary: 'Remove prefix SVG icons, align font-family/font-size/font-weight/line-height/letter-spacing/color/opacity/padding-left from unselected host native sidebar item'
  });

  const exported = {
    HOST_SETTINGS_NAV_IDS,
    HOST_SETTINGS_PATCH_SPEC,
    isNativeNavBtnSelected,
    pickUnselectedNativeNavRef,
    buildAlignedHostSettingsNavCss,
    hasForbiddenNavBoldOverride,
    alignHostSettingsNavTypography
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGHostSettingsNavAlign = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
