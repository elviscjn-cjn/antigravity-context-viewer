'use strict';
/**
 * 07 下一句预测内联几何对齐与六色调试开关模块
 *
 * 根治问题（对照主工作树 src/renderer/next-prompt.js:54-74 与实机图）：
 * 1. 旧 CSS 写了 `inset: 0 !important; padding: 0 !important;`，导致 JS 的 syncInlineGhostGeometry
 *    写入的 top / left / width / paddingTop / paddingLeft 全部被 CSS !important 覆盖，预览文字与真实编辑行错位。
 * 2. 旧颜色默认使用带透明度蓝灰 `rgba(148, 163, 184, 0.62)`（实机采样偏 #6A7380），与宿主中性输入区突兀。
 * 3. 本模块提供：
 *    - 去掉冲突 !important 的精确对齐 CSS（默认中性灰 #9A9A9A，浅色自适应，绝不覆盖宿主原生 placeholder/草稿色）；
 *    - 六色实机对比试验开关（#474747、#9A9A9A、#959595、#7E7E7E、#555555、#868686）与实时 WCAG 对比度计算；
 *    - 亚像素级编辑行几何同步 syncAlignedInlineGhostGeometry，使预览文字与真实输入的起点与基线差 <= 1 CSS px，
 *      且绝不增高输入框。
 */
(function (rootScope) {
  const ALIGNED_GHOST_STYLE_ID = 'ag-next-prompt-aligned-style';
  const DEFAULT_DARK_GHOST_COLOR = '#9A9A9A';
  const DEFAULT_LIGHT_GHOST_COLOR = '#767676';

  const SIX_COLOR_EXPERIMENT_SWATCHES = Object.freeze([
    '#474747',
    '#9A9A9A',
    '#959595',
    '#7E7E7E',
    '#555555',
    '#868686'
  ]);

  const NEXT_PROMPT_ALIGN_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      debugLabel: '预测文字六色试验',
      contrastPrefix: '对比度',
      resetDefault: '恢复默认'
    }),
    'zh-TW': Object.freeze({
      debugLabel: '預測文字六色試驗',
      contrastPrefix: '對比度',
      resetDefault: '恢復預設'
    }),
    en: Object.freeze({
      debugLabel: 'Suggestion Six Color Switch',
      contrastPrefix: 'Contrast',
      resetDefault: 'Reset'
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  /**
   * 纯净对齐样式：显式移除 inset: 0 !important 与 padding: 0 !important，
   * 仅把绝对定位基准交给 syncAlignedInlineGhostGeometry 精确计算。
   */
  const ALIGNED_GHOST_CSS = `
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
      position: absolute !important;
      z-index: 4 !important;
      display: block !important;
      margin: 0 !important;
      border: none !important;
      background: transparent !important;
      color: var(--ag-np-ghost-color, ${DEFAULT_DARK_GHOST_COLOR}) !important;
      pointer-events: none !important;
      user-select: none !important;
      overflow: hidden !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      box-sizing: border-box !important;
    }
    [data-theme="light"] .ag-np-ghost.ag-np-inline-ghost,
    .light .ag-np-ghost.ag-np-inline-ghost {
      color: var(--ag-np-ghost-color-light, ${DEFAULT_LIGHT_GHOST_COLOR}) !important;
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

  function parseHexRgb(hex) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16)
    };
  }

  function relativeLuminance(rgb) {
    const toLinear = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  }

  /**
   * 计算前景色与背景色的 WCAG 合成对比度（保留 2 位小数，如 #9A9A9A on #252525 => 5.45）
   */
  function computeContrastRatio(fgHex, bgHex = '#252525') {
    const fg = parseHexRgb(fgHex);
    const bg = parseHexRgb(bgHex);
    if (!fg || !bg) return null;
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
  }

  /**
   * 读取编辑器真实编辑行起点与排版样式，将内联预览精准贴合至 <= 1 CSS px，且不增高输入框
   */
  function syncAlignedInlineGhostGeometry(ghost, editor, anchorParent, win = (typeof window !== 'undefined' ? window : null)) {
    if (!ghost || !editor) return null;
    const cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(editor) : null;
    const anchorCs = (anchorParent && typeof win?.getComputedStyle === 'function')
      ? win.getComputedStyle(anchorParent)
      : null;

    const firstParagraph = typeof editor.querySelector === 'function'
      ? editor.querySelector('p, [data-lexical-text="true"]')
      : null;
    const pCs = (firstParagraph && typeof win?.getComputedStyle === 'function')
      ? win.getComputedStyle(firstParagraph)
      : null;

    const fontSize = (pCs?.fontSize || cs?.fontSize || '');
    const lineHeight = (pCs?.lineHeight || cs?.lineHeight || '');
    const fontFamily = (pCs?.fontFamily || cs?.fontFamily || '');
    const fontWeight = (pCs?.fontWeight || cs?.fontWeight || '');
    const letterSpacing = (pCs?.letterSpacing || cs?.letterSpacing || '');
    const textIndent = (pCs?.textIndent || cs?.textIndent || '0px');

    const padTop = parseFloat(cs?.paddingTop || '0') || 0;
    const padRight = parseFloat(cs?.paddingRight || '0') || 0;
    const padBottom = parseFloat(cs?.paddingBottom || '0') || 0;
    const padLeft = parseFloat(cs?.paddingLeft || '0') || 0;
    const borderTop = parseFloat(cs?.borderTopWidth || '0') || 0;
    const borderLeft = parseFloat(cs?.borderLeftWidth || '0') || 0;
    const anchorBorderTop = parseFloat(anchorCs?.borderTopWidth || '0') || 0;
    const anchorBorderLeft = parseFloat(anchorCs?.borderLeftWidth || '0') || 0;

    if (ghost.style) {
      if (fontSize) ghost.style.fontSize = fontSize;
      if (lineHeight) ghost.style.lineHeight = lineHeight;
      if (fontFamily) ghost.style.fontFamily = fontFamily;
      if (fontWeight) ghost.style.fontWeight = fontWeight;
      if (letterSpacing) ghost.style.letterSpacing = letterSpacing;
      ghost.style.textIndent = textIndent;
      ghost.style.paddingTop = `${padTop}px`;
      ghost.style.paddingRight = `${padRight}px`;
      ghost.style.paddingBottom = `${padBottom}px`;
      ghost.style.paddingLeft = `${padLeft}px`;
    }

    let geometry = {
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      contentOriginX: padLeft,
      contentOriginY: padTop
    };

    if (
      anchorParent
      && typeof anchorParent.getBoundingClientRect === 'function'
      && typeof editor.getBoundingClientRect === 'function'
    ) {
      const pr = anchorParent.getBoundingClientRect();
      const er = editor.getBoundingClientRect();
      const refRect = (firstParagraph && typeof firstParagraph.getBoundingClientRect === 'function')
        ? firstParagraph.getBoundingClientRect()
        : null;

      if (pr.width > 0 && er.width > 0) {
        const relTop = Math.max(0, (er.top - pr.top) - anchorBorderTop + borderTop);
        const relLeft = Math.max(0, (er.left - pr.left) - anchorBorderLeft + borderLeft);
        let extraTop = 0;
        let extraLeft = 0;
        if (refRect && refRect.width > 0) {
          extraTop = Math.max(0, refRect.top - (er.top + borderTop + padTop));
          extraLeft = Math.max(0, refRect.left - (er.left + borderLeft + padLeft));
        }
        const finalTop = Number((relTop + extraTop).toFixed(2));
        const finalLeft = Number((relLeft + extraLeft).toFixed(2));
        const finalWidth = Number(Math.max(0, er.width - borderLeft * 2 - extraLeft).toFixed(2));
        const finalHeight = Number(Math.max(0, er.height - borderTop * 2).toFixed(2));

        if (ghost.style) {
          ghost.style.top = `${finalTop}px`;
          ghost.style.left = `${finalLeft}px`;
          ghost.style.width = `${finalWidth}px`;
          ghost.style.height = `${finalHeight}px`;
        }
        geometry = {
          top: finalTop,
          left: finalLeft,
          width: finalWidth,
          height: finalHeight,
          contentOriginX: Number((finalLeft + padLeft).toFixed(2)),
          contentOriginY: Number((finalTop + padTop).toFixed(2))
        };
      }
    }
    return geometry;
  }

  /**
   * 六色试验本地调试开关控制器（供本地对比 #474747/#9A9A9A/#959595/#7E7E7E/#555555/#868686）
   */
  function createNextPromptColorDebugController(deps = {}) {
    let activeColor = SIX_COLOR_EXPERIMENT_SWATCHES.includes(String(deps.initialColor || '').toUpperCase())
      ? String(deps.initialColor).toUpperCase()
      : DEFAULT_DARK_GHOST_COLOR;
    let backgroundHex = String(deps.backgroundHex || '#252525');
    let ghostEl = deps.ghostEl || null;
    let lang = resolveLang(deps.lang);

    function applyColorToTarget(colorHex) {
      const upper = String(colorHex || '').trim().toUpperCase();
      if (!SIX_COLOR_EXPERIMENT_SWATCHES.includes(upper)) return null;
      activeColor = upper;
      if (ghostEl && ghostEl.style) {
        ghostEl.style.setProperty('--ag-np-ghost-color', activeColor);
        ghostEl.setAttribute?.('data-np-debug-color', activeColor);
      }
      const ratio = computeContrastRatio(activeColor, backgroundHex);
      if (typeof deps.onColorChange === 'function') {
        deps.onColorChange({ color: activeColor, backgroundHex, contrastRatio: ratio });
      }
      return { color: activeColor, backgroundHex, contrastRatio: ratio };
    }

    function getAllSwatchReports() {
      return SIX_COLOR_EXPERIMENT_SWATCHES.map(hex => ({
        color: hex,
        backgroundHex,
        contrastRatio: computeContrastRatio(hex, backgroundHex),
        isSelected: hex === activeColor
      }));
    }

    function setGhostElement(el) {
      ghostEl = el;
      applyColorToTarget(activeColor);
    }

    return {
      swatches: SIX_COLOR_EXPERIMENT_SWATCHES,
      setColor: applyColorToTarget,
      reset: () => applyColorToTarget(DEFAULT_DARK_GHOST_COLOR),
      setGhostElement,
      getAllSwatchReports,
      getCopy: () => NEXT_PROMPT_ALIGN_I18N[lang] || NEXT_PROMPT_ALIGN_I18N['zh-CN'],
      getState: () => ({
        activeColor,
        backgroundHex,
        contrastRatio: computeContrastRatio(activeColor, backgroundHex)
      })
    };
  }

  /**
   * 校验样式文本绝不含覆盖 JS 几何同步的 inset: 0 !important 或 padding: 0 !important
   */
  function hasConflictingGhostGeometryCss(cssText) {
    const raw = String(cssText || '');
    const m = raw.match(/\.ag-np-ghost\.ag-np-inline-ghost\s*\{([\s\S]*?)\}/);
    if (!m) return false;
    return /\binset\s*:\s*0\s*!important/i.test(m[1]) || /\bpadding\s*:\s*0\s*!important/i.test(m[1]);
  }

  const exported = {
    ALIGNED_GHOST_STYLE_ID,
    DEFAULT_DARK_GHOST_COLOR,
    DEFAULT_LIGHT_GHOST_COLOR,
    SIX_COLOR_EXPERIMENT_SWATCHES,
    NEXT_PROMPT_ALIGN_I18N,
    ALIGNED_GHOST_CSS,
    computeContrastRatio,
    syncAlignedInlineGhostGeometry,
    createNextPromptColorDebugController,
    hasConflictingGhostGeometryCss
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGNextPromptAlignment = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
