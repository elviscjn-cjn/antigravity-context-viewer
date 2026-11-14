(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const {
    summarize,
    parseGeneratorCall,
    calculateRequestApiCost,
    normalizeModelId,
    resolveStableModelId,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    convertToCNY,
    resolveEffectivePlanStatus
  } = (globalThis.__AGContextMeterCore || {});
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据（纯净初始状态，启动时由宿主实时扫描本地实际账本注入）
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "",
    firstUseDate: null,
    summary: {
      grandTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      todayTokens: 0,
      monthTokens: 0,
      yearTokens: 0,
      totalSteps: 0,
      totalConversations: 0,
      firstUseDate: null,
      activeDaysCount: 0
    },
    dailyMap: {},
    speedRecords: []
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* @INSERT_STYLES_AND_TEMPLATE */

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  /* @INSERT_I18N_MODULE */
  /* @INSERT_BUDGET_ENGINE_MODULE */
  const budgetEngine = globalThis.__AGContextBudgetEngine || {};
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => {
    if (v == null) return '—';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}K`;
    return fmt(v);
  };
  // 悬停信息气泡专用紧凑计数格式（如 37k、475k、1.05M）
  const fmtBubbleToken = v => {
    if (v == null) return t('common.unknown');
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? t('common.notProvided') : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    reportedFinalCallIds: new Set(), reportedFinalCallOutputs: new Map()
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;
  let activeCostModel = 'gemini-3.8-flash';
  let activeCostMode = 'ref';
  let autoCheckUpdate = true;
  let cachedLatestRelease = null;

  /* @INSERT_COLORS_MODULE */
  // =========================================================================
  // 模块 2: 宿主布局挂载、右上角原生窗口控制区预留、渐进式宽度收缩与悬浮层定位
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;

  function findHostTitlebar() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function isTopRightToolbarCluster(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    const classList = typeof el.classList?.contains === 'function'
      ? el.classList
      : { contains: c => cls.split(/\s+/).includes(c) };
    if (!classList.contains('absolute') || !classList.contains('right-0')) return false;

    const styleTop = el.style?.top || el.getAttribute('style') || '';
    const hasTopClass = classList.contains('top-0');
    const hasTopStyle = /(?:^|;)\s*top:\s*0(?:px)?(?:\s*;|$)/i.test(styleTop);
    const rectTop = el.getBoundingClientRect ? el.getBoundingClientRect().top : 0;
    if (el.getBoundingClientRect && rectTop >= 20) return false;
    const isAtTop = hasTopClass || hasTopStyle || (rectTop <= 10 && rectTop >= 0);
    if (!isAtTop) return false;

    // 排除明显非顶栏容器（右侧全高抽屉、全屏浮层或带有明确非零高度下沉定位的浮层）
    if (classList.contains('bottom-0') || classList.contains('h-screen') || classList.contains('h-full')) {
      return false;
    }

    // 排除右侧滚动条滑槽（特征：包含 top-0.5 / bottom-0.5 / w-3 等滚动条特征）
    if (classList.contains('w-3') || classList.contains('right-0.5')) {
      return false;
    }

    // 必须符合顶栏控制按钮容器特征：
    // a) 包含右侧栏切换按钮
    // b) 或包含 z-50 并具有 flex / items-center 水平布局
    const hasAuxToggle = Boolean(el.querySelector && el.querySelector('[data-testid="toggle-aux-sidebar"]'));
    const hasToolbarLayout = classList.contains('z-50') && (classList.contains('items-center') || classList.contains('flex'));

    return hasAuxToggle || hasToolbarLayout;
  }

  function findTopRightCluster() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      // 1. 优先从右侧栏切换按钮向上寻找最近的顶栏容器
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        // 先尝试带 top-0 的经典结构（Antigravity 1.x）
        let cluster = auxToggle.closest('div.absolute.right-0.top-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
        // 兼容 Antigravity 2.x（top: 0px 写在内联 style，class 无 top-0）
        cluster = auxToggle.closest('div.absolute.right-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
      }

      // 2. 备用安全探测：当 auxToggle 尚未挂载或被动态卸载时，精确匹配顶栏容器
      // 严格检查顶部坐标与容器特征，绝不误伤滚动条、侧栏抽屉或模态弹窗
      const selectors = [
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.top-0.z-50',
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50',
        'div.absolute.right-0.z-50'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isTopRightToolbarCluster(el)) return el;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 动态计算右上角原生窗口控制区（Minimize / Maximize / Close）独占宽度（CSS px）
  function computeWindowControlsWidth(topRight) {
    if (!topRight) return 0;
    try {
      const plat = (typeof navigator !== 'undefined' && navigator.platform) || '';
      if (/^Mac|iPhone|iPad/i.test(plat)) return 0;
      if (topRight?.getBoundingClientRect) {
        const tr = topRight.getBoundingClientRect();
        // 若顶部已单独渲染菜单栏（top >= 20），则 40px 工具栏不在窗口顶边，无需重复留白
        if (tr.height > 0 && tr.top >= 20) return 0;
      }
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      // 优先 1: 标准 WCO 接口 navigator.windowControlsOverlay
      const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
      if (wco?.visible && typeof wco.getTitlebarAreaRect === 'function') {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.width > 0 && vw > 0 && rect.width < vw) {
          return Math.max(0, Math.ceil(vw - rect.right));
        }
      }
      // 优先 2: 根据 Electron titleBarOverlay 几何规格（Windows 3 颗原生控制按钮共 138 OS DIP）与实时缩放比动态换算
      let zoomFactor = 1;
      if (typeof window !== 'undefined') {
        const nativeZoom = window.electronNative?.getZoomLevel?.();
        if (typeof nativeZoom === 'number' && nativeZoom >= 0.25 && nativeZoom <= 5) {
          zoomFactor = nativeZoom;
        } else if (window.outerWidth > 0 && window.innerWidth > 0) {
          const ratio = window.outerWidth / window.innerWidth;
          if (ratio >= 0.25 && ratio <= 5) zoomFactor = ratio;
        }
      }
      const rawCssWidth = Math.ceil(138 / zoomFactor);
      let existingSpacerWidth = 0;
      if (topRight?.querySelectorAll) {
        const spacers = topRight.querySelectorAll('div[aria-hidden="true"]');
        for (const sp of spacers) {
          if (sp.id !== 'ag-wco-spacer' && sp.getBoundingClientRect) {
            existingSpacerWidth += Math.round(sp.getBoundingClientRect().width || parseFloat(sp.style?.width) || 0);
          }
        }
      }
      return Math.max(0, rawCssWidth - existingSpacerWidth);
    } catch {
      return 98;
    }
  }

  function syncWindowControlsOverlay() {
    if (state.disposed) return;
    try {
      const topRight = findTopRightCluster();
      const wcoWidth = computeWindowControlsWidth(topRight);
      const spacer = typeof document.getElementById === 'function' ? document.getElementById('ag-wco-spacer') : null;
      if (topRight && typeof document.createElement === 'function' && wcoWidth > 0) {
        let activeSpacer = spacer;
        if (!activeSpacer || activeSpacer.parentElement !== topRight) {
          activeSpacer?.remove?.();
          activeSpacer = document.createElement('div');
          activeSpacer.id = 'ag-wco-spacer';
          activeSpacer.setAttribute('aria-hidden', 'true');
          topRight.appendChild(activeSpacer);
        }
        const targetCss = `width:${wcoWidth}px;height:100%;flex-shrink:0;pointer-events:none;`;
        if (activeSpacer.style.cssText !== targetCss) {
          activeSpacer.style.cssText = targetCss;
        }
      } else {
        if (spacer) {
          spacer.remove();
        }
        if (topRight?.querySelectorAll) {
          const oldSpacers = topRight.querySelectorAll('#ag-wco-spacer');
          for (const s of oldSpacers) {
            s.remove?.();
          }
        }
      }

      if (typeof document.head !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = typeof document.getElementById === 'function' ? document.getElementById('ag-topbar-host-fix') : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ag-topbar-host-fix';
          document.head.appendChild(styleEl);
        }
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          wcoWidth > 0 ? [
            '[class*="@container/titlebar"],',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child {',
            '  -webkit-app-region: drag;',
            '}',
            '[class*="@container/titlebar"] button,',
            '[class*="@container/titlebar"] a,',
            '[class*="@container/titlebar"] input,',
            '[class*="@container/titlebar"] [role="button"],',
            '[data-testid="pane-titlebar-toolbar"] > *,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] button,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] [data-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child button,',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child a,',
            '#ag-context-meter {',
            '  -webkit-app-region: no-drag;',
            '}'
          ].join('\n') : ''
        ].join('\n');
        if (styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
      }
      syncNativeOverlayTheme();
    } catch {}
  }

  function ensureHostDocked() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      // 自愈保护：若主对话区（div.flex[style*="min-width"]）的 inline flex-grow 被意外清空，立即恢复为 1，绝不覆写其他分栏属性
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch {}

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch {}

      if (host.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {}
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
      updateFixedFallbackPosition();
    }
    updateResponsiveLayout();
  }

  function findNativeTopRightAnchor() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const openIdeBtn = buttons.find(b => {
        const text = (b.textContent || '').trim();
        return (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) && b.getBoundingClientRect?.().top < 50;
      });
      if (openIdeBtn) {
        const parentGroup = openIdeBtn.closest('div.flex.items-center, div.absolute.right-0') || openIdeBtn;
        return parentGroup;
      }
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
      }
      return document.querySelector('div.absolute.right-0.top-0');
    } catch {
      return null;
    }
  }

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      host.style.top = '6px';
      host.style.right = `${rightOffset}px`;
    } catch {}
  }

  // 带迟滞区间（Hysteresis）的四阶段渐进收缩计算，防止临界宽度抖动
  function computeNextLayoutMode(availWidth, currentMode) {
    // 阈值设计：
    // wide <-> compact: 收缩 < 195px, 恢复 >= 210px
    // compact <-> minimal: 收缩 < 135px, 恢复 >= 150px
    // minimal <-> ring-only: 收缩 < 68px, 恢复 >= 82px
    if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
    if (currentMode === 'wide') {
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      if (availWidth < 195) return 'compact';
      return 'wide';
    }
    if (currentMode === 'compact') {
      if (availWidth >= 210) return 'wide';
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      return 'compact';
    }
    if (currentMode === 'minimal') {
      if (availWidth >= 210) return 'wide';
      if (availWidth >= 150) return 'compact';
      if (availWidth < 68) return 'ring-only';
      return 'minimal';
    }
    // currentMode === 'ring-only'
    if (availWidth >= 210) return 'wide';
    if (availWidth >= 150) return 'compact';
    if (availWidth >= 82) return 'minimal';
    return 'ring-only';
  }

  function measureAvailableWidth() {
    try {
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (tbRect.left < 168 ? (168 - tbRect.left) : 12);
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = Math.max(150, titleRealW);
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== host && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) nativeButtonsWidth = sum + 6;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - nativeButtonsWidth;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {}
    return 400;
  }

  function renderSessionCost() {
    const roundCostBar = el('round-cost-bar');
    const roundCostText = el('round-cost-text');
    const sessionCostText = el('session-cost-text');
    if (!roundCostText || !sessionCostText) return;
    const activeCalls = state.sessionCalls || [];
    const latestCall = activeCalls[activeCalls.length - 1];
    const sessTotal = state.sessionCostTotal || 0;
    if (latestCall && latestCall.isPriced) {
      const roundCost = latestCall.costUSD || 0;
      const roundCostStr = roundCost < 0.01 ? '<$0.01' : `≈$${roundCost.toFixed(4)}`;
      const estLabel = latestCall.status === 'streaming' ? t('cost.streamingEst') : t('cost.returnedEst');
      roundCostText.textContent = t('cost.latestTurn', { val: roundCostStr, label: estLabel });
      roundCostText.title = t('cost.modelTip', {
        model: latestCall.model,
        input: fmt(latestCall.inputTokens),
        cache: fmt(latestCall.cacheTokens),
        output: fmt(latestCall.outputTokens),
        cost: roundCost.toFixed(6)
      });
    } else if (latestCall) {
      roundCostText.textContent = t('cost.unpriced');
      roundCostText.title = latestCall.model ? t('cost.unpricedTip', { model: latestCall.model }) : t('cost.missingModel');
    } else {
      roundCostText.textContent = t('cost.latestDash');
      roundCostText.title = '';
    }
    sessionCostText.textContent = sessTotal > 0 ? t('cost.sessionTotal', { val: sessTotal.toFixed(4) }) : t('session.sessionCost.dash');
  }

  function applyLayoutMode(nextMode) {
    if (!nextMode) return;
    const prev = state.layoutMode;
    state.layoutMode = nextMode;
    host.setAttribute('data-layout', nextMode);
    if (prev !== nextMode) {
      if (nextMode !== 'minimal') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
    }
    renderSessionCost();
  }

  function updateResponsiveLayout() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth();
    const nextMode = computeNextLayoutMode(avail, state.layoutMode);
    applyLayoutMode(nextMode);
    if (state.tooltipOpen) positionContextTooltip();
    if (isAnyPanelOpen() || !el('overflow-menu')?.hidden) positionFloatingPanels();
  }

  function scheduleLayoutSync() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        ensureHostDocked();
      });
    } else {
      ensureHostDocked();
    }
  }

  // 定位上下文悬停气泡：空间足够时优先在圆环上方，顶部空间不足时自动翻转至下方，左右防裁切
  function positionContextTooltip() {
    const tip = el('context-tooltip');
    const badge = el('badge');
    if (!tip || !badge || !badge.getBoundingClientRect) return;
    try {
      const bRect = badge.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 190, height: 66 };
      const tipW = tRect.width || 190;
      const tipH = tRect.height || 66;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = Math.max(6, Math.min(vh - tipH - 6, Math.round(top)));

      let left = Math.round(bRect.left + bRect.width / 2 - tipW / 2);
      left = Math.max(8, Math.min(vw - tipW - 8, left));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch {}
  }

  function showContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip || !el('panel')?.hidden) return;
    state.tooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionContextTooltip();
  }

  function hideContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip) return;
    state.tooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  let elevatedStackAncestor = null;

  function syncHostStackingElevation(elevate) {
    try {
      if (elevate) {
        const z0 = host.closest?.('div.relative.z-0');
        if (z0?.style) {
          elevatedStackAncestor = z0;
          z0.style.zIndex = '40';
        }
      } else if (elevatedStackAncestor?.style) {
        elevatedStackAncestor.style.zIndex = '';
        elevatedStackAncestor = null;
      }
    } catch {}
  }

  function getLeftProjectSidebarRight(vw) {
    try {
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 260) {
            return Math.ceil(nr.right);
          }
        }
      }
    } catch {}
    return 0;
  }

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const navRight = getLeftProjectSidebarRight(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;

      const placePanel = (panelEl, targetW, anchorBtn) => {
        if (!panelEl) return;
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const top = Math.max(36, Math.min(vh - 120, Math.round((bRect.bottom || hRect.bottom) + 6)));
        const isCompact = panelEl.classList?.contains?.('cost-compact-view') || panelEl.getAttribute?.('class')?.includes?.('cost-compact-view');
        const effW = isCompact ? 400 : targetW;
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(effW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，确保任何视口宽度下右边缘绝不溢出
        let left = Math.round(bRect.right - finalW);
        left = Math.min(left, vw - finalW - 12);
        left = Math.max(minLeft, left);

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${Math.max(260, vw - left - 12)}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      placePanel(el('panel'), 472, el('badge'));
      placePanel(el('panel-tokens'), 730, el('badge-tokens'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
      positionColorPickerPopover();
    } catch {}
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (!host.isConnected || host.getAttribute('data-dock') !== 'flow' || !findHostTitlebar()?.contains?.(host)) {
          scheduleLayoutSync();
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {}

  const onWindowResize = () => updateResponsiveLayout();
  const onWindowFocus = () => host.setAttribute('data-window-active', 'true');
  const onWindowBlur = () => host.setAttribute('data-window-active', 'false');
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
  } catch {}

  ensureHostDocked();

  // =========================================================================
  // 模块 3: 面板、气泡与溢出菜单交互
  // =========================================================================
  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } }, {
      currentModel: value?.model || state.latest?.model || '',
      cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      previousValidContext: value
    });
    return {
      ...(value || {}),
      error: failure.error,
      errorClassification: failure.errorClassification,
      exceeded: failure.exceeded,
      network: failure.network,
      serviceLimit: failure.serviceLimit || value?.serviceLimit || null,
      status: failure.status,
      // 解耦：保留已有有效上下文数据，不归零、不清空
      used: value?.used ?? failure?.used ?? null,
      actual: failure.exceeded ? null : (value?.actual ?? null),
      estimate: value?.estimate ?? failure?.estimate ?? null,
      budget: value?.budget ?? failure?.budget ?? null,
      percent: failure.exceeded ? 100 : (value?.percent ?? null),
      estimated: value?.actual == null
    };
  }

  function isAnyPanelOpen() {
    return !el('panel').hidden || !el('panel-tokens').hidden;
  }

  function showPanel(target) {
    const pContext = el('panel');
    const pTokens = el('panel-tokens');
    const pOverflow = el('overflow-menu');
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bTokens = el('badge-tokens');
    const bOverflow = el('badge-overflow');

    hideUpdatePopover();
    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');

    if (target === 'tokens') {
      hideContextTooltip();
      closeColorPicker();
      pContext.hidden = true;
      pTokens.hidden = false;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      void syncTokenHistoryFromHost(false);
      renderActiveHeatView(true);
    } else if (target === 'context') {
      hideContextTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pTokens.hidden = true;
      pContext.hidden = false;
      bContext.setAttribute('aria-expanded', 'true');
      bSpeed?.setAttribute('aria-expanded', 'true');
      bTokens.setAttribute('aria-expanded', 'false');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      applyContextViewVisibility?.();
      if (activeContextTab === 'models' && !isContextSettingsView) {
        void refreshUnlockStatus();
      } else if (activeContextTab === 'speed' && !isContextSettingsView) {
        renderSpeedComparisonTab?.();
      }
      if (isContextSettingsView) {
        void refreshModulesDisplay();
      }
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      closeColorPicker();
      hidePopover();
      syncHostStackingElevation(false);
    }
  }

  function toggle(open, tab = 'context') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'tokens' ? 'tokens' : 'context');
    }
  }

  function toggleContext() {
    if (!el('panel').hidden) showPanel('none');
    else showPanel('context');
  }

  function toggleTokens() {
    if (!el('panel-tokens').hidden) showPanel('none');
    else showPanel('tokens');
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    hideContextTooltip();
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
    if (willOpen) positionFloatingPanels();
  }

  // 外观调色按钮进入设置视图并直接展开颜色自定义抽屉
  el('btn-panel-palette')?.addEventListener('click', () => {
    openContextSettings?.({ openColors: true });
  });
  el('btn-panel-tokens-palette')?.addEventListener('click', () => toggleTokenColorsDrawer());

  // =========================================================================
  // 统一定制下拉组件控制器 (国家 / 订阅地区 / 币种 / 增强 Select)
  // =========================================================================
  const COUNTRY_OPTIONS = [
    { value: '未知', label: '🌐 未设置 / 自动', labelTw: '🌐 未設定 / 自動', labelEn: '🌐 Auto / Unset', code: 'AUTO', aliases: ['自动', '未知', 'none', 'auto'] },
    { value: '美国 (US)', label: '🇺🇸 美国 (US)', labelTw: '🇺🇸 美國 (US)', labelEn: '🇺🇸 United States (US)', code: 'US', aliases: ['美国', 'united states', 'usa'] },
    { value: '日本 (JP)', label: '🇯🇵 日本 (JP)', labelTw: '🇯🇵 日本 (JP)', labelEn: '🇯🇵 Japan (JP)', code: 'JP', aliases: ['日本', 'japan'] },
    { value: '韩国 (KR)', label: '🇰🇷 韩国 (KR)', labelTw: '🇰🇷 韓國 (KR)', labelEn: '🇰🇷 South Korea (KR)', code: 'KR', aliases: ['韩国', 'korea', 'south korea'] },
    { value: '中国台湾 (TW)', label: '🇹🇼 中国台湾 (TW)', labelTw: '🇹🇼 中國台灣 (TW)', labelEn: '🇹🇼 Taiwan (TW)', code: 'TW', aliases: ['台湾', 'taiwan', 'tw'] },
    { value: '中国香港 (HK)', label: '🇭🇰 中国香港 (HK)', labelTw: '🇭🇰 中國香港 (HK)', labelEn: '🇭🇰 Hong Kong (HK)', code: 'HK', aliases: ['香港', 'hong kong', 'hk'] },
    { value: '澳大利亚 (AU)', label: '🇦🇺 澳大利亚 (AU)', labelTw: '🇦🇺 澳洲 (AU)', labelEn: '🇦🇺 Australia (AU)', code: 'AU', aliases: ['澳大利亚', '澳洲', 'australia', 'au'] },
    { value: '新加坡 (SG)', label: '🇸🇬 新加坡 (SG)', labelTw: '🇸🇬 新加坡 (SG)', labelEn: '🇸🇬 Singapore (SG)', code: 'SG', aliases: ['新加坡', 'singapore', 'sg'] },
    { value: '英国 (UK)', label: '🇬🇧 英国 (UK)', labelTw: '🇬🇧 英國 (UK)', labelEn: '🇬🇧 United Kingdom (UK)', code: 'UK', aliases: ['英国', 'united kingdom', 'uk', 'gb', 'britain'] },
    { value: '德国 (DE)', label: '🇩🇪 德国 (DE)', labelTw: '🇩🇪 德國 (DE)', labelEn: '🇩🇪 Germany (DE)', code: 'DE', aliases: ['德国', 'germany', 'de'] },
    { value: '加拿大 (CA)', label: '🇨🇦 加拿大 (CA)', labelTw: '🇨🇦 加拿大 (CA)', labelEn: '🇨🇦 Canada (CA)', code: 'CA', aliases: ['加拿大', 'canada', 'ca'] },
    { value: '土耳其 (TR)', label: '🇹🇷 土耳其 (TR)', labelTw: '🇹🇷 土耳其 (TR)', labelEn: '🇹🇷 Turkey (TR)', code: 'TR', aliases: ['土耳其', 'turkey', 'tr'] },
    { value: '尼日利亚 (NG)', label: '🇳🇬 尼日利亚 (NG)', labelTw: '🇳🇬 奈及利亞 (NG)', labelEn: '🇳🇬 Nigeria (NG)', code: 'NG', aliases: ['尼日利亚', 'nigeria', 'ng'] },
    { value: '菲律宾 (PH)', label: '🇵🇭 菲律宾 (PH)', labelTw: '🇵🇭 菲律賓 (PH)', labelEn: '🇵🇭 Philippines (PH)', code: 'PH', aliases: ['菲律宾', 'philippines', 'ph'] },
    { value: '印度 (IN)', label: '🇮🇳 印度 (IN)', labelTw: '🇮🇳 印度 (IN)', labelEn: '🇮🇳 India (IN)', code: 'IN', aliases: ['印度', 'india', 'in'] },
    { value: '马来西亚 (MY)', label: '🇲🇾 马来西亚 (MY)', labelTw: '🇲🇾 馬來西亞 (MY)', labelEn: '🇲🇾 Malaysia (MY)', code: 'MY', aliases: ['马来西亚', 'malaysia', 'my'] },
    { value: '巴西 (BR)', label: '🇧🇷 巴西 (BR)', labelTw: '🇧🇷 巴西 (BR)', labelEn: '🇧🇷 Brazil (BR)', code: 'BR', aliases: ['巴西', 'brazil', 'br'] },
    { value: '中国大陆 (CN)', label: '🇨🇳 中国大陆 (CN)', labelTw: '🇨🇳 中國大陸 (CN)', labelEn: '🇨🇳 China Mainland (CN)', code: 'CN', aliases: ['中国大陆', '中国', 'china', 'cn'] }
  ];

  const CURRENCY_OPTIONS = [
    { value: 'USD', code: 'USD', symbol: '$', name: '美元', nameEn: 'US Dollar', label: 'USD ($ 美元)', labelTw: 'USD ($ 美元)', labelEn: 'USD ($ US Dollar)', aliases: ['美元', 'usd', '$', 'dollar'] },
    { value: 'KRW', code: 'KRW', symbol: '₩', name: '韩元', nameEn: 'Korean Won', label: 'KRW (₩ 韩元)', labelTw: 'KRW (₩ 韓元)', labelEn: 'KRW (₩ Won)', aliases: ['韩元', 'krw', '₩', 'won'] },
    { value: 'AUD', code: 'AUD', symbol: 'AU$', name: '澳元', nameEn: 'Australian Dollar', label: 'AUD (AU$ 澳元)', labelTw: 'AUD (AU$ 澳元)', labelEn: 'AUD (AU$ AUD)', aliases: ['澳元', '澳洲', 'aud', 'au$', 'australian'] },
    { value: 'JPY', code: 'JPY', symbol: '¥', name: '日元', nameEn: 'Japanese Yen', label: 'JPY (¥ 日元)', labelTw: 'JPY (¥ 日圓)', labelEn: 'JPY (¥ Yen)', aliases: ['日元', '日本', 'jpy', '¥', 'yen'] },
    { value: 'HKD', code: 'HKD', symbol: 'HK$', name: '港币', nameEn: 'Hong Kong Dollar', label: 'HKD (HK$ 港币)', labelTw: 'HKD (HK$ 港幣)', labelEn: 'HKD (HK$ HKD)', aliases: ['港币', '香港', 'hkd', 'hk$'] },
    { value: 'TWD', code: 'TWD', symbol: 'NT$', name: '台币', nameEn: 'New Taiwan Dollar', label: 'TWD (NT$ 台币)', labelTw: 'TWD (NT$ 新台幣)', labelEn: 'TWD (NT$ TWD)', aliases: ['台币', '台湾', 'twd', 'ntd', 'nt$'] },
    { value: 'TRY', code: 'TRY', symbol: '₺', name: '里拉', nameEn: 'Turkish Lira', label: 'TRY (₺ 里拉)', labelTw: 'TRY (₺ 里拉)', labelEn: 'TRY (₺ Lira)', aliases: ['里拉', '土耳其', 'try', '₺', 'lira'] },
    { value: 'NGN', code: 'NGN', symbol: '₦', name: '奈拉', nameEn: 'Nigerian Naira', label: 'NGN (₦ 奈拉)', labelTw: 'NGN (₦ 奈拉)', labelEn: 'NGN (₦ Naira)', aliases: ['奈拉', '尼日利亚', 'ngn', '₦', 'naira'] },
    { value: 'CNY', code: 'CNY', symbol: '¥', name: '人民币', nameEn: 'Chinese Yuan', label: 'CNY (¥ 人民币)', labelTw: 'CNY (¥ 人民幣)', labelEn: 'CNY (¥ CNY)', aliases: ['人民币', '中国', 'cny', 'rmb', '¥', 'yuan'] },
    { value: 'EUR', code: 'EUR', symbol: '€', name: '欧元', nameEn: 'Euro', label: 'EUR (€ 欧元)', labelTw: 'EUR (€ 歐元)', labelEn: 'EUR (€ Euro)', aliases: ['欧元', '欧洲', 'eur', '€', 'euro'] },
    { value: 'GBP', code: 'GBP', symbol: '£', name: '英镑', nameEn: 'British Pound', label: 'GBP (£ 英镑)', labelTw: 'GBP (£ 英鎊)', labelEn: 'GBP (£ Pound)', aliases: ['英镑', '英国', 'gbp', '£', 'pound'] },
    { value: 'SGD', code: 'SGD', symbol: 'S$', name: '新元', nameEn: 'Singapore Dollar', label: 'SGD (S$ 新元)', labelTw: 'SGD (S$ 新幣)', labelEn: 'SGD (S$ SGD)', aliases: ['新元', '新加坡', 'sgd', 's$'] },
    { value: 'CAD', code: 'CAD', symbol: 'CA$', name: '加元', nameEn: 'Canadian Dollar', label: 'CAD (CA$ 加元)', labelTw: 'CAD (CA$ 加幣)', labelEn: 'CAD (CA$ CAD)', aliases: ['加元', '加拿大', 'cad', 'ca$'] },
    { value: 'PHP', code: 'PHP', symbol: '₱', name: '比索', nameEn: 'Philippine Peso', label: 'PHP (₱ 比索)', labelTw: 'PHP (₱ 披索)', labelEn: 'PHP (₱ Peso)', aliases: ['比索', '菲律宾', 'php', '₱', 'peso'] },
    { value: 'INR', code: 'INR', symbol: '₹', name: '卢比', nameEn: 'Indian Rupee', label: 'INR (₹ 卢比)', labelTw: 'INR (₹ 盧比)', labelEn: 'INR (₹ Rupee)', aliases: ['卢比', '印度', 'inr', '₹', 'rupee'] },
    { value: 'MYR', code: 'MYR', symbol: 'RM', name: '令吉', nameEn: 'Malaysian Ringgit', label: 'MYR (RM 令吉)', labelTw: 'MYR (RM 令吉)', labelEn: 'MYR (RM Ringgit)', aliases: ['令吉', '马来西亚', 'myr', 'rm', 'ringgit'] },
    { value: 'BRL', code: 'BRL', symbol: 'R$', name: '雷亚尔', nameEn: 'Brazilian Real', label: 'BRL (R$ 雷亚尔)', labelTw: 'BRL (R$ 雷亞爾)', labelEn: 'BRL (R$ Real)', aliases: ['雷亚尔', '巴西', 'brl', 'r$', 'real'] }
  ];

  function refreshRegionPresetSelectOptions() {
    const sel = el('select-custom-region-preset');
    if (!sel || !sel.options) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      if (!opt || opt.value === '' || opt.value === 'custom') continue;
      const p = presets.find(item => item.id === opt.value);
      if (!p) continue;
      const dispName = getPanelLanguage() === 'en' ? (p.nameEn || p.id || p.name) : p.name;
      if (p.currency === 'CNY') {
        opt.textContent = t('plan.form.presetLineCny', { flag: p.flag || '🌏', name: dispName, price: p.monthlyPrice });
      } else {
        const cny = core?.convertToCNY ? core.convertToCNY(p.monthlyPrice, p.currency, p.name) : (p.monthlyPrice * p.rateToCNY);
        opt.textContent = t('plan.form.presetLine', {
          flag: p.flag || '🌏',
          name: dispName,
          id: p.id,
          sym: p.symbol,
          price: p.monthlyPrice,
          cny: Number(cny).toFixed(1)
        });
      }
    }
  }

  function hasClass(node, cls) {
    if (!node) return false;
    if (node.classList?.contains) return node.classList.contains(cls);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  function addClass(node, cls) {
    if (!node) return;
    if (node.classList?.add) { node.classList.add(cls); return; }
    const cur = String(node.className || '').trim();
    if (!cur.split(/\s+/).includes(cls)) node.className = cur ? `${cur} ${cls}` : cls;
  }
  function removeClass(node, cls) {
    if (!node) return;
    if (node.classList?.remove) { node.classList.remove(cls); return; }
    const parts = String(node.className || '').split(/\s+/).filter(c => c !== cls);
    node.className = parts.join(' ');
  }

  // 纯同步 UI 控件回填防护守卫（仅在纯同步赋值代码块内开启，严禁跨越 await）
  let isHydratingUiControls = false;
  function runWithUiHydration(fn) {
    const prev = isHydratingUiControls;
    isHydratingUiControls = true;
    try {
      return fn();
    } finally {
      isHydratingUiControls = prev;
    }
  }

  // 兼容老调用声明
  let isRestoringSettings = false;

  // 异步时序保护：用户主动修改序列号与恢复请求版本号
  let userActionSeq = 0;
  let restoreRequestSeq = 0;

  /* @INSERT_DROPDOWN_MODULE */
  function renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCnyText, options = {}) {
    const priceValEl = el('plan-summary-price-val');
    const priceCnyEl = el('plan-summary-price-cny');
    const badgeEl = el('plan-summary-price-badge');
    if (!priceValEl) return;

    if (activeBadgeTimerId) {
      clearTimeout(activeBadgeTimerId);
      activeBadgeTimerId = null;
    }
    if (activeCnyTimerId) {
      clearTimeout(activeCnyTimerId);
      activeCnyTimerId = null;
    }
    if (activeBadgeRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(activeBadgeRafId);
      activeBadgeRafId = null;
    }

    const formattedFinalNum = targetNum !== null && targetNum !== undefined
      ? (Number(targetNum) % 1 === 0 ? String(Number(targetNum)) : Number(targetNum).toFixed(2))
      : '';

    // 轻量模拟环境安全兼容
    if (typeof priceValEl.querySelector !== 'function') {
      priceValEl.textContent = `${targetSymbol}${formattedFinalNum}${targetCycle}`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const hasRaf = typeof requestAnimationFrame === 'function';
    const forceDirect = options.forceDirect || !hasRaf || !lastBadgePriceState;

    if (forceDirect) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${targetSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const startNum = (lastBadgePriceState && Number.isFinite(lastBadgePriceState.num))
      ? lastBadgePriceState.num
      : (Number(targetNum) || 0);
    const endNum = targetNum !== null ? Number(targetNum) : 0;
    const startSymbol = lastBadgePriceState?.symbol || targetSymbol;
    const endSymbol = targetSymbol;

    // 确保内部 DOM 结构完整
    let symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
    let numEl = priceValEl.querySelector?.('.badge-num-anim');
    let cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');

    if (!symbolEl || !numEl || !cycleEl) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${startSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
      numEl = priceValEl.querySelector?.('.badge-num-anim');
      cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');
    }

    if (cycleEl) cycleEl.textContent = targetCycle;

    // 1. 货币符号消散再切换动画 (Symbol Dissolve & Crossfade)
    if (startSymbol !== endSymbol && symbolEl && symbolEl.classList) {
      symbolEl.classList.remove('is-entering');
      symbolEl.classList.add('is-dissolving');

      activeBadgeTimerId = setTimeout(() => {
        symbolEl.textContent = endSymbol;
        symbolEl.classList.remove('is-dissolving');
        symbolEl.classList.add('is-entering');
        try { void symbolEl.offsetWidth; } catch {}
        setTimeout(() => {
          symbolEl.classList?.remove?.('is-entering');
        }, 180);
        activeBadgeTimerId = null;
      }, 160);
    } else if (symbolEl) {
      symbolEl.textContent = endSymbol;
    }

    // 2. CNY 折合平滑渐变
    if (priceCnyEl && priceCnyEl.textContent !== targetCnyText) {
      try {
        priceCnyEl.style.transition = 'opacity 0.18s ease';
        priceCnyEl.style.opacity = '0.2';
        activeCnyTimerId = setTimeout(() => {
          priceCnyEl.textContent = targetCnyText;
          priceCnyEl.style.opacity = '0.85';
          activeCnyTimerId = null;
        }, 140);
      } catch {
        priceCnyEl.textContent = targetCnyText;
      }
    }

    // 3. 数字滚动/递减递增动画 (Rolling Numeric Count Tween)
    if (startNum !== endNum && numEl) {
      if (badgeEl && badgeEl.classList) badgeEl.classList.add('is-animating');

      const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const duration = 500;
      const easeOut = t => 1 - Math.pow(1 - t, 4);

      const step = now => {
        const elapsed = Math.max(0, now - startTime);
        const progress = Math.min(1, elapsed / duration);
        const eased = easeOut(progress);
        const currentVal = startNum + (endNum - startNum) * eased;

        if (progress < 1) {
          if (endNum % 1 !== 0) {
            numEl.textContent = currentVal >= 100 ? String(Math.round(currentVal)) : currentVal.toFixed(2);
          } else {
            numEl.textContent = String(Math.round(currentVal));
          }
          activeBadgeRafId = requestAnimationFrame(step);
        } else {
          numEl.textContent = formattedFinalNum;
          if (badgeEl && badgeEl.classList) badgeEl.classList.remove('is-animating');
          activeBadgeRafId = null;
        }
      };

      activeBadgeRafId = requestAnimationFrame(step);
    } else if (numEl) {
      numEl.textContent = formattedFinalNum;
    }

    lastBadgePriceState = {
      symbol: targetSymbol,
      num: endNum,
      cycle: targetCycle,
      cnyText: targetCnyText
    };
  }

  function renderPlanDetail(ps) {
    if (!ps) return;
    const sumTxt = el('plan-summary-text');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : ps.hasCustomSettings
          ? t('plan.summary.custom')
          : t('plan.summary.unknown');
      sumTxt.textContent = `${ps.tierName || 'Pro'} · ${modeTxt} · ${t('plan.summary.justNow')}`;
    }
    // 实时联动更新黄框位置的订阅费与汇率胶囊 (支持动效与符号消散)
    const curSymbol = ps.currencySymbol || '$';
    let targetSymbol = '$';
    let targetNum = 19.99;
    let targetCycle = t('plan.summary.perMonth');
    let targetCny = '(≈ ¥134.3 CNY)';

    if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
      targetSymbol = curSymbol;
      targetNum = 0;
      targetCycle = t('plan.summary.perMonth');
      targetCny = t('plan.summary.freeWithPlan');
    } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
      targetSymbol = curSymbol;
      targetNum = Number(ps.actualPricePaid);
      targetCycle = t('plan.summary.perMonth');
      if (ps.currency === 'CNY') {
        targetCny = '';
      } else if (ps.cnyFormatted) {
        const cnyClean = String(ps.cnyFormatted).replace(/^[折合約\s≈()（）]+/, '').replace(/[()（）]/g, '').trim();
        const prefix = currentPanelLanguage === 'en' ? 'approx. ' : '≈ ';
        targetCny = cnyClean ? `(${prefix}${cnyClean})` : '';
      } else {
        targetCny = '';
      }
    } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
      targetSymbol = '$';
      targetNum = Number(ps.officialPriceMonthly);
      targetCycle = t('plan.summary.perMonth');
      targetCny = '(≈ ¥134.3 CNY)';
    } else {
      targetSymbol = '$';
      targetNum = 19.99;
      targetCycle = t('plan.summary.perMonth');
      targetCny = '(≈ ¥134.3 CNY)';
    }

    renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCny);

    const detName = el('p-det-name');
    if (detName) detName.textContent = ps.tierName || 'Google AI Pro';
    const detAcc = el('p-det-account');
    if (detAcc) detAcc.textContent = ps.email || t('plan.account.unknown');

    // 守卫：若当前不在 Token 统计视图或详情处于收起状态，严禁异步返回时撑开详情面板
    const cardEl = el('plan-detail-card');
    if (cardEl && (activeTokenView !== 'tokens' || !planDetailExpanded)) {
      cardEl.style.display = 'none';
      cardEl.classList?.remove?.('is-expanded');
    }

    const detCountry = el('p-det-country');
    const tagCountry = el('p-det-country-tag');
    const directCountrySel = el('direct-country-select');
    const countryText = (ps.country && !String(ps.country).includes('未知')) ? String(ps.country).trim() : '未知';
    if (detCountry) detCountry.textContent = countryText === '未知' ? t('plan.country.unknown') : countryText;
    if (tagCountry) {
      tagCountry.style.display = ps.countrySource === 'custom' ? 'inline-block' : 'none';
      tagCountry.textContent = ps.countrySource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detReg = el('p-det-region');
    const tagReg = el('p-det-region-tag');
    let regText = ps.subscriptionRegion || ps.region || '未知';
    if (regText.includes('未在当前会话中获取') || regText.trim() === '未知') regText = '未知';
    if (detReg) detReg.textContent = regText === '未知' ? t('plan.region.unknown') : regText;
    if (tagReg) {
      tagReg.style.display = ps.regionSource === 'custom' ? 'inline-block' : 'none';
      tagReg.textContent = ps.regionSource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detCur = el('p-det-currency');
    const tagCur = el('p-det-currency-tag');
    const directCurSel = el('direct-currency-select');
    const curText = ps.currency || 'USD';
    if (detCur) detCur.textContent = curText;
    if (tagCur) {
      tagCur.style.display = ps.currencySource === 'custom' ? 'inline-block' : 'none';
      tagCur.textContent = ps.currencySource === 'custom' ? t('plan.tag.custom') : '';
    }

    // 使用纯同步回填守卫同步更新详情面板内的下拉控件值
    runWithUiHydration(() => {
      if (directCountrySel) {
        if (countryText !== '未知' && directCountrySel.options) {
          const exists = Array.from(directCountrySel.options).some(o => o.value === countryText);
          if (!exists && typeof document.createElement === 'function') {
            const opt = document.createElement('option');
            opt.value = countryText;
            opt.textContent = '🌐 ' + countryText;
            directCountrySel.appendChild?.(opt);
          }
        }
        directCountrySel.value = countryText;
      }
      if (directCurSel) {
        directCurSel.value = curText === 'NTD' ? 'TWD' : curText;
      }
    });

    // 刷新国家、订阅地区与币种直接选择器标签与选中高亮
    if (typeof refreshDirectCountryDisplay === 'function') {
      refreshDirectCountryDisplay(countryText);
    }
    if (typeof refreshDirectRegionDisplay === 'function') {
      refreshDirectRegionDisplay(regText);
    }
    if (typeof refreshDirectCurrencyDisplay === 'function') {
      refreshDirectCurrencyDisplay(curText);
    }

    const detAcq = el('p-det-acq');
    const tagAcq = el('p-det-acq-tag');
    if (detAcq) detAcq.textContent = localizeAcquisitionSource(ps.acquisitionSource || ps.acquisitionSourceName);
    if (tagAcq) {
      const isPromo = ps.acquisitionSource && ps.acquisitionSource !== 'normal_paid';
      tagAcq.style.display = isPromo ? 'inline-block' : 'none';
      tagAcq.textContent = isPromo ? t('plan.tag.promo') : '';
    }

    const detPrice = el('p-det-price');
    const tagPrice = el('p-det-price-tag');
    const isPresetMode = ps.priceMode === 'preset';
    const btnModePreset = el('btn-mode-preset');
    const btnModeCustom = el('btn-mode-custom');
    if (btnModePreset) setPillActive(btnModePreset, isPresetMode);
    if (btnModeCustom) setPillActive(btnModeCustom, !isPresetMode);

    if (detPrice) {
      const cycleText = localizeBillingCycleLabel(ps.billingCycle);
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        detPrice.textContent = `${curSymbol}0 · ${cycleText}`;
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        let cnyPart = '';
        if (ps.currency !== 'CNY' && ps.cnyFormatted) {
          const locCny = localizeCnyFormatted(ps.cnyFormatted);
          cnyPart = locCny ? ` (${locCny})` : '';
        }
        const paidFormatted = Number(ps.actualPricePaid) % 1 === 0 ? Number(ps.actualPricePaid) : Number(ps.actualPricePaid).toFixed(2);
        detPrice.textContent = `${curSymbol}${paidFormatted} · ${cycleText}${cnyPart}`;
      } else if (ps.priceRangeNote && ps.priceRangeNote !== '未知') {
        detPrice.textContent = ps.priceRangeNote.replace(/[（\(][^）\)]*[）\)]/g, '').trim();
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        detPrice.textContent = `${t('plan.tag.publicRef')} $${ps.officialPriceMonthly}${t('plan.summary.perMonth')}`;
      } else {
        detPrice.textContent = '—';
      }
    }
    if (tagPrice) {
      tagPrice.style.display = 'inline-block';
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        tagPrice.textContent = t('plan.tag.manualFree');
      } else if (ps.priceMode === 'custom' || ps.priceSource === 'custom') {
        tagPrice.textContent = t('plan.tag.userPaid');
      } else if (ps.priceSource === 'preset_region' || isPresetMode) {
        tagPrice.textContent = t('plan.tag.official');
      } else {
        tagPrice.textContent = t('plan.tag.publicRef');
      }
    }

    const dtVal = el('p-dt-validity');
    const ddVal = el('p-det-validity');
    if (dtVal && ddVal) {
      if (ps.validEndDate) {
        dtVal.style.display = 'block';
        ddVal.style.display = 'block';
        ddVal.textContent = ps.isExpired
          ? t('plan.validity.expired', { date: ps.validEndDate })
          : t('plan.validity.active', { date: ps.validEndDate });
        ddVal.style.color = ps.isExpired ? '#ef4444' : 'var(--ag-text-secondary)';
      } else {
        dtVal.style.display = 'none';
        ddVal.style.display = 'none';
      }
    }

    const dtNote = el('p-dt-note');
    const ddNote = el('p-det-note');
    if (dtNote && ddNote) {
      if (ps.customNote) {
        dtNote.style.display = 'block';
        ddNote.style.display = 'block';
        ddNote.textContent = String(ps.customNote);
      } else {
        dtNote.style.display = 'none';
        ddNote.style.display = 'none';
      }
    }

    const pPrompt = el('p-det-prompt-credits');
    const pFlow = el('p-det-flow-credits');
    if (pPrompt && ps.promptCredits) {
      const promptTxt = `Prompt Credits: ${t('plan.credits.avail', { avail: ps.promptCredits.available ?? '—', monthly: ps.promptCredits.monthly ?? '—' })}`;
      pPrompt.textContent = promptTxt;
      const pLegacy = el('p-det-credits');
      if (pLegacy) pLegacy.textContent = promptTxt;
    }
    if (pFlow && ps.flowCredits) {
      pFlow.textContent = t('plan.credits.avail', { avail: ps.flowCredits?.available ?? '—', monthly: ps.flowCredits?.monthly ?? '—' });
    }
    const detTime = el('p-det-time');
    if (detTime) {
      const timeStr = ps.updatedAt ? new Date(ps.updatedAt).toLocaleString() : '—';
      const verifyStr = ps.pricingTableVerifiedDate ? ` · ${ps.pricingTableVerifiedDate}` : '';
      detTime.textContent = `${timeStr}${verifyStr}`;
    }
  }

  function setPillActive(node, active) {
    if (!node) return;
    node.classList?.toggle?.('active', active);
    const cur = node.getAttribute('class') || 'switch-pill-btn';
    if (active) {
      if (!cur.includes('active')) node.setAttribute('class', (cur + ' active').trim());
    } else {
      node.setAttribute('class', cur.replace(/\bactive\b/g, '').trim());
    }
  }

  // 数据源切换（全部 / 桌面 / CLI）
  let activeTokenSource = 'all';
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch {}
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = bySrc[src] || bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      renderActiveHeatView(true);
      renderActiveCostEstimateView();
    }
  }
  el('src-tab-all')?.addEventListener('click', () => switchTokenSource('all'));
  el('src-tab-desktop')?.addEventListener('click', () => switchTokenSource('desktop'));
  el('src-tab-cli')?.addEventListener('click', () => switchTokenSource('cli'));

  // 视图切换（Token 统计 / API 等值估算）
  let activeTokenView = 'tokens';

  // 费用面板紧凑摘要与展开详情切换
  let costDetailsExpanded = false;
  function toggleCostDetails(expand) {
    if (expand === undefined) costDetailsExpanded = !costDetailsExpanded;
    else costDetailsExpanded = Boolean(expand);

    const pane = el('cost-details-pane');
    const btn = el('btn-cost-details-toggle');
    const pTokens = el('panel-tokens');

    if (pane) {
      pane.style.display = costDetailsExpanded ? 'block' : 'none';
      if (costDetailsExpanded) pane.style.animation = 'agFadeIn .2s cubic-bezier(0.16,1,0.3,1)';
    }
    if (btn) btn.textContent = costDetailsExpanded ? t('cost.btnCollapse') : t('cost.btnExpand');
    if (pTokens) {
      const isCompact = activeTokenView === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('cost-details-pane');
  el('cost-non-paid-badge');
  el('cost-scope-desc');
  el('tokens-main-view');
  el('btn-cost-details-toggle')?.addEventListener('click', () => toggleCostDetails());
  el('btn-cost-details-collapse')?.addEventListener('click', () => toggleCostDetails(false));
  el('btn-cost-fill-sub')?.addEventListener('click', () => {
    switchTokenView('tokens');
    setPlanDetailExpanded(true);
    togglePlanCustomForm(true);
  });
  toggleCostDetails(false);

  function switchTokenView(v) {
    activeTokenView = v;
    // 离开 Token 统计视图时关闭订阅详情与表单
    if (v !== 'tokens') {
      setPlanDetailExpanded(false, { skipReposition: true });
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
    }
    setPillActive(el('tok-view-tokens'), v === 'tokens');
    setPillActive(el('tok-view-cost'), v === 'cost');
    const costCard = el('cost-estimate-card');
    const tokensMain = el('tokens-main-view');
    const statCards = el('token-stat-cards');
    const planBar = el('plan-summary-bar');
    const titleTokens = el('panel-tokens-title');
    const pTokens = el('panel-tokens');

    if (costCard) {
      costCard.style.display = v === 'cost' ? 'block' : 'none';
      if (v === 'cost') costCard.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (tokensMain) {
      tokensMain.style.display = v === 'tokens' ? 'block' : 'none';
      if (v === 'tokens') tokensMain.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (statCards) statCards.style.display = v === 'tokens' ? 'grid' : 'none';
    if (planBar) planBar.style.display = v === 'tokens' ? 'flex' : 'none';
    if (titleTokens) titleTokens.textContent = v === 'cost' ? t('tokens.titleCost') : t('tokens.title');

    if (pTokens) {
      const isCompact = v === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('tok-view-tokens')?.addEventListener('click', () => switchTokenView('tokens'));
  el('tok-view-cost')?.addEventListener('click', () => switchTokenView('cost'));

  // =========================================================================
  // 一键启动 CLI 模式（当前项目目录绑定 + 中文/空格路径兼容 + 错误提示）
  // =========================================================================
  let cliLaunchBusy = false;
  let cliToastTimer = null;
  let lastCliLaunchResult = null;

  function showCliToast(message, isError = false) {
    const toast = el('cli-launch-toast');
    if (!toast) return;
    if (cliToastTimer) {
      clearTimeout(cliToastTimer);
      cliToastTimer = null;
    }
    toast.hidden = false;
    toast.setAttribute('data-tone', isError ? 'error' : 'info');
    toast.textContent = message;
    cliToastTimer = setTimeout(() => {
      toast.hidden = true;
      cliToastTimer = null;
    }, isError ? 5200 : 3200);
  }

  async function triggerLaunchCli(customOpts = {}) {
    if (cliLaunchBusy) {
      showCliToast(t('cli.busy'), false);
      return { ok: false, error: t('cli.busy') };
    }
    cliLaunchBusy = true;
    const btn = el('badge-cli');
    const label = el('cli-label');
    btn?.setAttribute('data-busy', 'true');
    if (label) label.textContent = '…';
    try {
      if (typeof document !== 'undefined' && document.activeElement?.blur) {
        document.activeElement.blur();
      }
    } catch {}

    const hostBounds = {
      x: typeof window !== 'undefined' ? (window.screenX || 0) : 0,
      y: typeof window !== 'undefined' ? (window.screenY || 0) : 0,
      width: typeof window !== 'undefined' ? (window.outerWidth || window.innerWidth || 1200) : 1200,
      height: typeof window !== 'undefined' ? (window.outerHeight || window.innerHeight || 800) : 800
    };

    const reqOpts = {
      cascadeId: state.route || undefined,
      cwd: customOpts.cwd !== undefined ? customOpts.cwd : (state.scan?.workspacePath || undefined),
      hostBounds,
      ...customOpts
    };
    try {
      let res = null;
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.launchCli === 'function') {
        res = await window.contextMeterAPI.launchCli(reqOpts);
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/launch-cli`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(reqOpts)
        });
        res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      } else {
        res = { ok: false, code: 'NO_BRIDGE', error: t('cli.noBridge') };
      }

      lastCliLaunchResult = res;
      if (res && res.ok) {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        showCliToast(t('cli.launched', { cwd: res.cwd || t('cli.defaultCwd') }), false);
        return res;
      } else {
        const errMsg = res?.error ? translateBackendText(res.error) : t('cli.notFound');
        showCliToast(t('cli.failed', { err: errMsg }), true);
        return res || { ok: false, error: errMsg };
      }
    } catch (err) {
      const errMsg = err?.message ? translateBackendText(err.message) : t('cli.exception');
      lastCliLaunchResult = { ok: false, error: errMsg };
      showCliToast(t('cli.failed', { err: errMsg }), true);
      return lastCliLaunchResult;
    } finally {
      cliLaunchBusy = false;
      btn?.removeAttribute('data-busy');
      btn?.removeAttribute('data-pressed');
      if (label) label.textContent = 'CLI';
    }
  }

  const badgeCliEl = el('badge-cli');
  if (badgeCliEl) {
    const releasePress = () => {
      badgeCliEl.removeAttribute('data-pressed');
    };
    badgeCliEl.addEventListener('pointerdown', () => {
      badgeCliEl.setAttribute('data-pressed', 'true');
    });
    badgeCliEl.addEventListener('pointerup', releasePress);
    badgeCliEl.addEventListener('pointercancel', releasePress);
    badgeCliEl.addEventListener('mouseleave', releasePress);
    badgeCliEl.addEventListener('blur', releasePress);
    badgeCliEl.addEventListener('click', () => {
      releasePress();
      void triggerLaunchCli();
    });
  }
  el('overflow-cli-btn')?.addEventListener('click', () => { void triggerLaunchCli(); });

  el('badge').addEventListener('click', toggleContext);
  el('badge-speed')?.addEventListener('click', toggleContext);
  el('badge-tokens').addEventListener('click', toggleTokens);
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-speed-btn')?.addEventListener('click', () => showPanel('context'));
  el('overflow-tokens-btn')?.addEventListener('click', () => showPanel('tokens'));
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));

  // 上下文圆环悬停与键盘聚焦气泡（面板打开时不通过悬停误切，必须通过显式左键点击切换）
  el('badge').addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showContextTooltip();
    }
  });
  el('badge').addEventListener('mouseleave', () => {
    hideContextTooltip();
  });
  el('badge').addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showContextTooltip();
  });
  el('badge').addEventListener('blur', () => {
    hideContextTooltip();
  });

  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('theme-toggle-tokens')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // =========================================================================
  // 模块 3: 上下文面板分页、设置视图、模型产品偏好、重启验证与速度对比
  // =========================================================================
  const btnTabSession = el('tab-ctx-session');
  const btnTabModels = el('tab-ctx-models');
  const btnTabSpeed = el('tab-ctx-speed');
  const btnTabSettings = el('tab-ctx-settings');
  const paneSession = el('pane-ctx-session');
  const paneModels = el('pane-ctx-models');
  const paneSpeed = el('pane-ctx-speed');
  const paneSettings = el('pane-ctx-settings');
  const ctxTabsBar = el('ctx-tabs-bar');
  const btnCtxSettings = el('btn-ctx-settings');
  const btnCtxSettingsBack = el('btn-ctx-settings-back');
  const btnGotoModelSettings = el('btn-goto-model-settings');
  const btnCardGotoSpeed = el('btn-card-goto-speed');
  const btnCtxBackCurrent = el('btn-ctx-back-current');
  const ctxCompactSavedEl = el('ctx-compact-saved');
  const ctxCompactClientEl = el('ctx-compact-client');

  const btnToggleUnlockDetails = el('btn-toggle-unlock-details');
  const unlockDrawerBody = el('unlock-drawer-body');
  const unlockDrawerArrow = el('unlock-drawer-arrow');
  const unlockBadge = el('unlock-badge');
  const unlockStatusDesc = el('unlock-status-desc');
  const ctxClientStatusText = el('ctx-client-status-text');
  const ctxRestartMismatchNote = el('ctx-restart-mismatch-note');
  const btnRestartHost = el('btn-restart-host');
  const ctxManualRestartNote = el('ctx-manual-restart-note');
  const ctxRestartConfirm = el('ctx-restart-confirm');
  const btnRestartCancel = el('btn-restart-cancel');
  const btnRestartConfirmGo = el('btn-restart-confirm-go');
  const ctxRestartFeedback = el('ctx-restart-feedback');
  const globalRestartModal = el('global-restart-modal');
  const modalRestartTitle = el('modal-restart-title');
  const modalRestartText = el('modal-restart-text');
  const modalRestartFeedback = el('modal-restart-feedback');
  const btnModalRestartCancel = el('btn-modal-restart-cancel');
  const btnModalRestartConfirm = el('btn-modal-restart-confirm');

  const btnApplyUnlock = el('btn-apply-unlock');
  const btnRestoreUnlock = el('btn-restore-unlock');
  const btnRefreshUnlock = el('btn-refresh-unlock');
  const unlockResultBox = el('unlock-result-box');
  const unlockResultText = el('unlock-result-text');
  const unlockResultActions = el('unlock-result-actions');
  const btnUnlockResultRestart = el('btn-unlock-result-restart');
  const btnUnlockResultRetry = el('btn-unlock-result-retry');
  const unlockResultManual = el('unlock-result-manual');
  const unlockMetaMode = el('unlock-meta-mode');
  const unlockMetaTarget = el('unlock-meta-target');
  const unlockMetaArch = el('unlock-meta-arch');
  const unlockMetaBackup = el('unlock-meta-backup');
  const linkUnlockAuthor = el('link-unlock-author');
  const btnCopyUnlockLink = el('btn-copy-unlock-link');
  const unlockLinkToast = el('unlock-link-toast');

  const ctxModelSelect = el('ctx-model-select');
  const ctxModelSelectorRoleEl = el('ctx-model-selector-role');
  const ctxModelDropdownLabelEl = el('ctx-model-dropdown-label');
  const ctxModelListEl = el('ctx-model-list');
  const ctxConflictBanner = el('ctx-conflict-banner');
  const ctxConflictRows = el('ctx-conflict-rows');
  const ctxCardVendorDot = el('ctx-card-vendor-dot');
  const ctxCardVendorName = el('ctx-card-vendor-name');
  const ctxCardProductName = el('ctx-card-product-name');
  const ctxCardEffortsList = el('ctx-card-efforts-list');
  const ctxCardSessionEffort = el('ctx-card-session-effort');
  const ctxCardSavedEl = el('ctx-card-saved');
  const ctxCardRequestEl = el('ctx-card-request');
  const ctxCardClientEl = el('ctx-card-client');
  const ctxCardClientTagEl = el('ctx-card-client-tag');
  const ctxCardObservedBudgetEl = el('ctx-card-observed-budget');
  const ctxCardPreRestartBudgetEl = el('ctx-card-pre-restart-budget');
  const ctxCardServiceLimitEl = el('ctx-card-service-limit');
  const ctxCardConvoEl = el('ctx-card-convo');
  const ctxCardDiagnosisEl = el('ctx-card-diagnosis');
  const ctxCardObservedSpeedEl = el('ctx-card-observed-speed');
  const ctxCardHintsEl = el('ctx-card-hints');
  const ctxCapWindowEl = el('ctx-cap-window');
  const ctxCapOutputEl = el('ctx-cap-output');
  const ctxCapModelMaxEl = el('ctx-cap-model-max');
  const ctxCapClientPolicyEl = el('ctx-cap-client-policy');
  const ctxCapDefaultEl = el('ctx-cap-default');
  const ctxCapRangeEl = el('ctx-cap-range');
  const ctxCapFormulaEl = el('ctx-cap-formula');
  const ctxRefSavedEl = el('ctx-ref-saved');
  const ctxRefSentEl = el('ctx-ref-sent');
  const ctxRefAdoptedEl = el('ctx-ref-adopted');
  const ctxUnifiedProjEl = el('ctx-unified-projection');
  const ctxCardTierCapsRowEl = el('ctx-card-tier-caps-row');
  const ctxCardTierCapsEl = el('ctx-card-tier-caps');
  const ctxPresetModelMaxSubEl = el('ctx-preset-modelmax-sub');

  const ctxPresetGrid = el('ctx-preset-grid');
  const ctxCustomInput = el('ctx-custom-limit-input');
  const ctxValidationEl = el('ctx-limit-validation');
  const btnSaveModelCtx = el('btn-save-model-ctx');
  const btnResetModelCtx = el('btn-reset-model-ctx');
  const ctxResetNoticeEl = el('ctx-reset-notice');

  // 双模式控件与精简展示元素
  const btnModeUnified = el('btn-ctx-mode-unified');
  const btnModePerModel = el('btn-ctx-mode-per-model');
  const ctxModelsToolbar = el('ctx-models-toolbar');
  const ctxSummaryModeEl = el('ctx-summary-mode');
  const ctxSummaryModelEl = el('ctx-summary-model');
  const ctxSummaryLengthEl = el('ctx-summary-length');
  const ctxSummaryStatusPillEl = el('ctx-summary-status-pill');

  const CTX_DEFAULT_TOKENS = 256000;
  const CTX_MIN_ENGINEERING_TOKENS = 16384;
  const CTX_MAX_ENGINEERING_TOKENS = 2097152;
  const CTX_ACTIVE_TAB_KEY = 'ag_ctx_active_tab';
  const CTX_PRE_RESTART_OBS_KEY = 'ag_ctx_pre_restart_obs_v1';

  const VENDOR_ORDER = ['Google', 'Anthropic', 'OpenAI', '其他'];
  const VENDOR_DOT_COLORS = {
    Google: 'var(--ag-custom-speed, var(--ag-speed-default, #38bdf8))',
    Anthropic: 'var(--ag-ring-warn, #f59e0b)',
    OpenAI: 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))',
    '其他': 'var(--ag-text-muted, #8a8a94)'
  };

  let activeContextTab = 'session';
  try {
    const savedTab = localStorage?.getItem(CTX_ACTIVE_TAB_KEY);
    if (savedTab === 'session' || savedTab === 'models' || savedTab === 'speed') {
      activeContextTab = savedTab;
    }
  } catch {}
  let isContextSettingsView = false;

  let currentUnlockStatus = null;
  let unlockStatusFetchError = false;
  let isUnlocking = false;
  let lastPartialReason = '';
  let unlockReqSeq = 0;
  let contextPrefSaveSeq = 0;
  let contextPreferencesMap = {};
  let contextScopeMode = 'unified'; // 'unified' | 'per_model'
  let contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  try {
    if (typeof window !== 'undefined' && window.__AGContextPreferences && typeof window.__AGContextPreferences === 'object') {
      contextPreferencesMap = { ...window.__AGContextPreferences };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawPrefs = localStorage.getItem('ag-context-preferences');
      if (rawPrefs) contextPreferencesMap = JSON.parse(rawPrefs) || {};
    }
    const initMode = (typeof window !== 'undefined' && window.__AGContextScopeMode)
      || (typeof localStorage !== 'undefined' && localStorage?.getItem?.('ag-context-scope-mode'))
      || '';
    if (initMode === 'unified' || initMode === 'per_model') {
      contextScopeMode = initMode;
    }
    if (typeof window !== 'undefined' && window.__AGContextUnifiedPreference && typeof window.__AGContextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...window.__AGContextUnifiedPreference };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawUni = localStorage.getItem('ag-context-unified-preference');
      if (rawUni) contextUnifiedPreference = JSON.parse(rawUni) || contextUnifiedPreference;
    }
  } catch {}

  function getContextScopeMode() {
    return contextScopeMode || 'unified';
  }

  function getContextUnifiedPreference() {
    return contextUnifiedPreference || { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  }

  function syncContextPreferencesCache(map) {
    try {
      if (typeof window !== 'undefined') {
        window.__AGContextPreferences = { ...(map || {}) };
        window.__AGContextScopeMode = contextScopeMode;
        window.__AGContextUnifiedPreference = { ...(contextUnifiedPreference || {}) };
        localStorage?.setItem('ag-context-preferences', JSON.stringify(map || {}));
        localStorage?.setItem('ag-context-scope-mode', contextScopeMode);
        localStorage?.setItem('ag-context-unified-preference', JSON.stringify(contextUnifiedPreference || {}));
      }
    } catch {}
  }
  let activeSessionModelKey = null;
  let activeSessionProductKey = null;
  let activeSessionEffort = null;
  let activeSessionModelConfirmed = false;
  let selectedEditModelKey = null;
  let selectedProductKey = null;
  let manualModelSelection = false;
  let ctxDraft = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  let ctxDraftDirty = false;
  let lastAutoObservedBudget = 0;
  let needsRestartAfterApply = false;
  let pendingRestartVerification = null;
  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;
  let restartMismatchNotice = '';

  const observedByModelId = new Map();
  let preRestartSnapshot = null;
  try {
    const rawPre = localStorage?.getItem(CTX_PRE_RESTART_OBS_KEY);
    if (rawPre) preRestartSnapshot = JSON.parse(rawPre);
  } catch {}

  let speedRangeDays = '7';
  let speedOriginFilter = 'all';
  let speedMetric = 'tps';
  let selectedSpeedExactModelId = null;
  let ctxHeaderDropdownCtrl = null;
  let speedModelDropdownCtrl = null;

  function formatKShort(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (typeof formatTokensK === 'function') return formatTokensK(n);
    return short(n);
  }

  function formatMonthDayTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatEffortZh(effort) {
    if (!effort) return '';
    const lang = typeof getPanelLanguage === 'function' ? getPanelLanguage() : 'zh-CN';
    if (typeof formatEffortLabel === 'function') return formatEffortLabel(effort, lang);
    return String(effort);
  }

  function groupProductSafe(input) {
    if (typeof groupModelProduct === 'function') return groupModelProduct(input || {});
    const rawId = String(input?.modelId || input?.label || 'unknown').trim();
    const low = rawId.toLowerCase();
    const vendor = low.includes('claude') ? 'Anthropic' : (low.includes('gpt') || low.includes('o1') || low.includes('o3')) ? 'OpenAI' : (low.includes('gemini') ? 'Google' : '其他');
    return { productKey: low, productLabel: input?.label || rawId, vendor, effort: input?.effort || null };
  }

  function resolveStableModelKeyClient(rawOrLatest) {
    if (!rawOrLatest) return null;
    if (typeof resolveStableModelId === 'function') {
      const resolved = resolveStableModelId(rawOrLatest, state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);
      if (resolved) return resolved;
    }
    if (typeof rawOrLatest === 'string') {
      const s = rawOrLatest.trim().toLowerCase();
      return s || null;
    }
    const str = String(rawOrLatest.modelId || rawOrLatest.modelRaw || rawOrLatest.model || '').trim().toLowerCase();
    return str || null;
  }

  // =========================================================================
  // ELV-41 / ELV-43: 官方模型选择器识别与多通道请求拦截注入器
  // 支持：主世界 LS 客户端装饰器、WebSocket (Lcc JSON)、Fetch/XHR (JSON / Envelope / Protobuf)
  // 严格过滤 StartCascade，仅拦截 SendUserCascadeMessage；不从面板配置卡猜测模型
  // =========================================================================
  const CTX_CONFIRM_TIMEOUT_MS = budgetEngine.DEFAULT_CONFIRM_TIMEOUT_MS || 45000;
  const budgetTracker = typeof budgetEngine.createContextBudgetTracker === 'function'
    ? budgetEngine.createContextBudgetTracker({ confirmTimeoutMs: CTX_CONFIRM_TIMEOUT_MS })
    : null;
  let lastDecoratorDispatchHint = null;
  const pendingConfirmTimers = new Set();

  function scheduleConfirmTimeoutCheck(delayMs = CTX_CONFIRM_TIMEOUT_MS + 100) {
    if (typeof setTimeout !== 'function' || state.disposed) return;
    const tId = setTimeout(() => {
      pendingConfirmTimers.delete(tId);
      if (state.disposed) return;
      try {
        renderCompactSessionCard();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
        }
      } catch {}
    }, delayMs);
    pendingConfirmTimers.add(tId);
  }

  function refreshBudgetUiAfterDispatch() {
    try {
      renderCompactSessionCard();
      const prod = getSelectedProductObj();
      if (prod) renderModelDetailCard(prod);
    } catch {}
  }

  /**
   * 仅从宿主真实输入框选择器读取当前选中模型（严格排除插件自身 #ag-context-meter DOM）
   */
  function extractHostSelectedModel() {
    if (typeof document === 'undefined') return null;
    const triggers = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]'))
      : (typeof document.querySelector === 'function' ? [document.querySelector('[data-testid="model-selector-trigger"]')].filter(Boolean) : []);
    if (!triggers.length) return null;

    let trigger = null;
    for (const candidate of triggers) {
      if (!candidate) continue;
      if (host && typeof host.contains === 'function' && host.contains(candidate)) continue;
      if (typeof candidate.closest === 'function' && candidate.closest('#ag-context-meter')) continue;
      if (typeof candidate.getBoundingClientRect === 'function') {
        const rect = candidate.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      trigger = candidate;
      break;
    }
    if (!trigger) return null;

    let effort = null;
    const effortEl = trigger.querySelector?.('[data-testid="model-selector-effort-option"]')
      || trigger.querySelector?.('[data-effort]');
    if (effortEl) {
      effort = effortEl.getAttribute?.('data-effort') || effortEl.textContent?.trim() || null;
    }

    const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
    const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
    if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
    const rawText = (clone.textContent || '').trim();
    if (!rawText) return null;

    if (!effort) {
      const mEffort = rawText.match(/\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)/i);
      if (mEffort) effort = mEffort[1];
    }

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const stableId = resolveStableModelKeyClient(rawText) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(rawText, configs) : null);
    const g = groupProductSafe({
      modelId: stableId || rawText,
      label: rawText,
      effort
    });

    return {
      rawText,
      modelId: stableId || rawText,
      productKey: g.productKey,
      productLabel: g.productLabel || rawText,
      effort: effort || g.effort || null,
      source: 'dom_trigger'
    };
  }

  function buildInterceptorContext(channel, urlOrProcedure = '', contentType = '') {
    return {
      channel,
      urlOrProcedure,
      contentType,
      scopeMode: getContextScopeMode(),
      unifiedPreference: getContextUnifiedPreference(),
      contextPreferencesMap: contextPreferencesMap || (typeof window !== 'undefined' ? window.__AGContextPreferences : null) || {},
      knownConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      verifiedConversationBindings: budgetTracker?.verifiedConversationBindings || {},
      groupProduct: groupProductSafe,
      resolveStableModelId: resolveStableModelKeyClient,
      minTokens: CTX_MIN_ENGINEERING_TOKENS,
      maxTokens: CTX_MAX_ENGINEERING_TOKENS
    };
  }

  function recordBudgetTransformDispatch(txResult) {
    if (!txResult || !txResult.handled || !budgetTracker) return null;
    if (txResult.uninjectable) {
      const rec = budgetTracker.beginDispatch({
        cascadeId: txResult.cascadeId || null,
        productKey: txResult.productKey || null,
        modelId: txResult.modelId || null,
        scopeMode: txResult.scopeMode,
        targetMode: txResult.targetMode || 'default',
        targetLimitTokens: txResult.targetLimitTokens ?? null,
        sentMode: 'passthrough',
        sentLimitTokens: null,
        channel: txResult.channel || 'http',
        status: 'uninjectable',
        reason: txResult.reason || 'uninjectable'
      });
      refreshBudgetUiAfterDispatch();
      return rec;
    }

    const rec = budgetTracker.beginDispatch({
      cascadeId: txResult.cascadeId || null,
      productKey: txResult.productKey || null,
      productLabel: txResult.productLabel || null,
      modelId: txResult.modelId || null,
      scopeMode: txResult.scopeMode,
      prefSnapshot: {
        mode: txResult.targetMode || 'default',
        limitTokens: txResult.targetLimitTokens ?? null
      },
      targetMode: txResult.targetMode,
      targetLimitTokens: txResult.targetLimitTokens,
      sentMode: txResult.sentMode,
      sentLimitTokens: txResult.sentLimitTokens,
      channel: txResult.channel || 'http',
      status: 'dispatched'
    });
    if (txResult.targetMode === 'fixed' || txResult.targetMode === 'dynamic' || txResult.targetMode === 'default') {
      scheduleConfirmTimeoutCheck();
    }
    refreshBudgetUiAfterDispatch();
    return rec;
  }

  function finishDispatchOutcome(dispatchId, ok, err) {
    if (!dispatchId || !budgetTracker) return;
    if (!ok) {
      const errMsg = String(err?.message || err || '');
      const isAbort = err?.name === 'AbortError' || /abort|cancel/i.test(errMsg);
      budgetTracker.updateDispatchStatus(dispatchId, {
        status: isAbort ? 'aborted' : 'send_failed',
        errorMessage: errMsg || (isAbort ? '请求已取消' : '发送失败')
      });
      refreshBudgetUiAfterDispatch();
    }
  }

  function installRequestInterceptor() {
    if (typeof window === 'undefined') return;
    if (window.__agRequestInterceptorInstalled) return;

    // 0. 绑定主世界冷启动客户端装饰器回调（序列化前修改真实请求对象）
    globalThis.__AG_METER_ON_SEND_MESSAGE__ = function(req, channel = 'client_object') {
      try {
        if (!req || typeof req !== 'object' || typeof budgetEngine.transformOutgoingSendRequest !== 'function') return null;
        const tx = budgetEngine.transformOutgoingSendRequest(req, buildInterceptorContext(channel, 'SendUserCascadeMessage'));
        if (!tx || !tx.handled) return null;
        const rec = recordBudgetTransformDispatch(tx);
        lastDecoratorDispatchHint = {
          ts: Date.now(),
          cascadeId: tx.cascadeId || null,
          productKey: tx.productKey || null,
          sentMode: tx.sentMode,
          sentLimitTokens: tx.sentLimitTokens ?? null,
          dispatchId: rec?.dispatchId || null
        };
        return rec ? { dispatchId: rec.dispatchId } : null;
      } catch (err) {
        console.warn('[ContextMeter] Client decorator hook error:', err);
        return null;
      }
    };
    globalThis.__AG_METER_ON_SEND_RESULT__ = function(dispatchId, ok, err) {
      finishDispatchOutcome(dispatchId, ok, err);
    };

    const isCoveredByRecentDecorator = (tx) => {
      if (!lastDecoratorDispatchHint) return false;
      const age = Date.now() - lastDecoratorDispatchHint.ts;
      if (age < 0 || age > 400) return false;
      const sameConv = (lastDecoratorDispatchHint.cascadeId || null) === (tx.cascadeId || null);
      const sameMode = lastDecoratorDispatchHint.sentMode === tx.sentMode
        && (lastDecoratorDispatchHint.sentLimitTokens ?? null) === (tx.sentLimitTokens ?? null);
      return sameConv && sameMode;
    };

    // 1. WebSocket.prototype.send interceptor (覆盖 Lcc ws://<host>/connect-websocket JSON 帧)
    if (typeof window.WebSocket === 'function' && window.WebSocket.prototype && typeof window.WebSocket.prototype.send === 'function') {
      const origWsSend = window.WebSocket.prototype.send;
      window.__agOrigWsSend = origWsSend;
      window.WebSocket.prototype.send = function(data) {
        let nextData = data;
        let rec = null;
        try {
          if (typeof budgetEngine.transformOutgoingSendRequest === 'function') {
            const tx = budgetEngine.transformOutgoingSendRequest(data, buildInterceptorContext('ws_frame', this?.url || ''));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                nextData = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] WebSocket interceptor error:', err);
        }
        try {
          return origWsSend.call(this, nextData);
        } catch (wsErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, wsErr);
          throw wsErr;
        }
      };
    }

    // 2. window.fetch interceptor (仅处理 SendUserCascadeMessage；严禁猜测 StartCascade)
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.__agOrigFetch = origFetch;
      window.fetch = async function(resource, init) {
        let rec = null;
        try {
          const urlStr = typeof resource === 'string'
            ? resource
            : (resource && resource.url ? resource.url : String(resource || ''));
          if (typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr) && init?.body) {
            const headersObj = init?.headers;
            let contentType = '';
            if (headersObj) {
              if (typeof headersObj.get === 'function') {
                contentType = headersObj.get('content-type') || headersObj.get('Content-Type') || '';
              } else if (typeof headersObj === 'object') {
                contentType = headersObj['content-type'] || headersObj['Content-Type'] || '';
              }
            }
            const tx = budgetEngine.transformOutgoingSendRequest(init.body, buildInterceptorContext('fetch', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                init = { ...init, body: tx.output };
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] Fetch request interceptor error:', err);
        }
        try {
          const response = await origFetch.call(this, resource, init);
          if (rec && response && response.ok === false) {
            finishDispatchOutcome(rec.dispatchId, false, new Error(`HTTP ${response.status || 'error'}`));
          }
          return response;
        } catch (fetchErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, fetchErr);
          throw fetchErr;
        }
      };
    }

    // 3. window.XMLHttpRequest interceptor
    if (typeof window.XMLHttpRequest === 'function') {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSetHdr = window.XMLHttpRequest.prototype.setRequestHeader;
      const origSend = window.XMLHttpRequest.prototype.send;
      window.__agOrigXhrOpen = origOpen;
      window.__agOrigXhrSetHdr = origSetHdr;
      window.__agOrigXhrSend = origSend;

      window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          this.__agRequestUrl = typeof url === 'string' ? url : String(url || '');
          this.__agRequestHeaders = {};
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      if (typeof origSetHdr === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          try {
            if (this.__agRequestHeaders && typeof name === 'string') {
              this.__agRequestHeaders[name.toLowerCase()] = String(value || '');
            }
          } catch {}
          return origSetHdr.call(this, name, value);
        };
      }

      window.XMLHttpRequest.prototype.send = function(body) {
        let rec = null;
        try {
          const urlStr = this.__agRequestUrl || '';
          if (body && typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr)) {
            const contentType = this.__agRequestHeaders?.['content-type'] || '';
            const tx = budgetEngine.transformOutgoingSendRequest(body, buildInterceptorContext('xhr', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                body = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] XHR request interceptor error:', err);
        }
        if (rec && typeof this.addEventListener === 'function') {
          const dId = rec.dispatchId;
          this.addEventListener('error', () => finishDispatchOutcome(dId, false, new Error('XHR network error')), { once: true });
          this.addEventListener('abort', () => finishDispatchOutcome(dId, false, Object.assign(new Error('XHR aborted'), { name: 'AbortError' })), { once: true });
          this.addEventListener('load', () => {
            if (typeof this.status === 'number' && this.status >= 400) {
              finishDispatchOutcome(dId, false, new Error(`HTTP ${this.status}`));
            }
          }, { once: true });
        }
        try {
          return origSend.call(this, body);
        } catch (xhrErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, xhrErr);
          throw xhrErr;
        }
      };
    }

    window.__agRequestInterceptorInstalled = true;
  }

  function uninstallRequestInterceptor() {
    if (typeof window === 'undefined') return;
    delete globalThis.__AG_METER_ON_SEND_MESSAGE__;
    delete globalThis.__AG_METER_ON_SEND_RESULT__;
    for (const tId of pendingConfirmTimers) clearTimeout(tId);
    pendingConfirmTimers.clear();
    if (window.__agOrigWsSend && window.WebSocket?.prototype) {
      window.WebSocket.prototype.send = window.__agOrigWsSend;
      delete window.__agOrigWsSend;
    }
    if (window.__agOrigFetch) {
      window.fetch = window.__agOrigFetch;
      delete window.__agOrigFetch;
    }
    if (window.__agOrigXhrOpen && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.open = window.__agOrigXhrOpen;
      delete window.__agOrigXhrOpen;
    }
    if (window.__agOrigXhrSetHdr && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.setRequestHeader = window.__agOrigXhrSetHdr;
      delete window.__agOrigXhrSetHdr;
    }
    if (window.__agOrigXhrSend && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.send = window.__agOrigXhrSend;
      delete window.__agOrigXhrSend;
    }
    window.__agRequestInterceptorInstalled = false;
  }

  function resolveRuntimeUnlockPolicyClient() {
    if (typeof budgetEngine.resolveRuntimeUnlockPolicy === 'function') {
      return budgetEngine.resolveRuntimeUnlockPolicy(currentUnlockStatus);
    }
    return null;
  }

  function formatDiskPolicyText(policy) {
    if (!policy) return '未知';
    if (policy.diskMode === 'dynamic') return 'Dynamic 动态跟随';
    if (policy.diskMode === 'fixed' && policy.diskLimitTokens) return `固定 ${fmt(policy.diskLimitTokens)} tokens`;
    if (policy.diskMode === 'default') return '默认 256,000 tokens';
    if (policy.diskMode === 'partial') return '部分异常';
    return '未知';
  }

  function getProductCapabilitySummary(product) {
    if (!product) return null;
    if (typeof budgetEngine.deriveModelCapabilitySummary === 'function') {
      return budgetEngine.deriveModelCapabilitySummary(product, currentUnlockStatus, state.modelCapabilitiesById || null);
    }
    return null;
  }

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
    }
  }

  function validateCustomLimitClient(rawInput, modeOverride = ctxDraft.mode, productOverride = null) {
    if (modeOverride === 'dynamic') {
      return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
    }
    if (modeOverride === 'default') {
      return { ok: true, mode: 'default', limitTokens: CTX_DEFAULT_TOKENS, warnings: [] };
    }
    const targetProd = productOverride || (contextScopeMode === 'per_model' ? getSelectedProductObj() : null);
    const capSummary = targetProd ? getProductCapabilitySummary(targetProd) : null;
    if (modeOverride === 'model_max') {
      if (contextScopeMode === 'unified') {
        return { ok: false, error: '统一模式下各模型容量不同，请改为具体整数或切回“按模型分别设置”后选择最大可用。' };
      }
      if (!capSummary || capSummary.modelTheoreticalMaxTokens == null) {
        return { ok: false, error: '尚未获取到当前模型的上下文窗口与最大输出元数据，暂无法自动计算最大可用预算。' };
      }
      if (!capSummary.runtimePolicy?.policyKnown || capSummary.maxAdjustableTokens == null) {
        return {
          ok: false,
          error: `当前客户端运行策略未知或待重启确认，暂无法计算当前环境最大可用上限（模型理论输入上限 ${fmt(capSummary.modelTheoreticalMaxTokens)} tokens）。`
        };
      }
      rawInput = capSummary.maxAdjustableTokens;
    }

    if (typeof budgetEngine.evaluateLimitInput === 'function') {
      const ev = budgetEngine.evaluateLimitInput(rawInput, capSummary, currentUnlockStatus, state.latest?.serviceLimit);
      if (!ev.ok) {
        if (ev.reasonCode === 'out_of_engineering_range') {
          return {
            ok: false,
            error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
          };
        }
        return { ok: false, error: t('models.custom.placeholder') };
      }
      const warnings = [];
      for (const w of ev.warnings) {
        if (w.code === 'exceeds_model_limit') {
          if (w.adoptableTokens != null) {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；若仍保存 ${fmt(w.limitTokens)}，当前环境预计最高仅可采用 ${fmt(w.adoptableTokens)} tokens。`);
          } else {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；当前客户端运行策略未确认，实际可采用上限未知。`);
          }
        } else if (w.code === 'requires_dynamic_unlock') {
          const cap = w.stockCap || 256000;
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前默认限制 ${fmt(cap)}：未开启 Dynamic 动态模式且未实机证实前，语言服务仍可能将其限制在 ${fmt(cap)} tokens（请点击“保存并应用”）。`);
        } else if (w.code === 'exceeds_fixed_client_limit') {
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前客户端固定限制 ${fmt(w.fixedCap)} tokens：未调整为更高固定值或启用 Dynamic 动态模式前，预计仍将被限制在 ${fmt(w.fixedCap)} tokens。`);
        } else if (w.code === 'unconfirmed_runtime_policy') {
          if (w.runtimeState === 'pending_restart') {
            warnings.push(`磁盘配置（${formatDiskPolicyText({ diskMode: w.diskMode, diskLimitTokens: w.diskLimitTokens })}）已变更但客户端尚未重启，运行中实际策略待确认，无法预测 ${fmt(w.limitTokens)} 是否会被采用。`);
          } else if (w.runtimeState === 'runtime_unconfirmed') {
            warnings.push(`仅读取到磁盘配置，尚未确认运行中进程已加载该策略；${fmt(w.limitTokens)} 实际能否采用需等待进程验证或实机请求确认。`);
          } else if (w.runtimeState === 'partial') {
            warnings.push(`检测到客户端处于部分异常状态，运行限制未知，无法预测 ${fmt(w.limitTokens)} 的实际采用结果。`);
          } else {
            warnings.push(`当前客户端运行策略未知，暂无法预测 ${fmt(w.limitTokens)} 在本机的实际采用上限（需先读取运行策略或实机发送验证）。`);
          }
        } else if (w.code === 'exceeds_service_limit') {
          warnings.push(t('models.validation.aboveService', { val: formatKShort(w.serviceLimit) }));
        } else if (w.code === 'below_recommended_floor') {
          warnings.push(t('models.validation.tooSmall', { val: fmt(w.limitTokens) }));
        }
      }
      return {
        ok: true,
        mode: 'fixed',
        limitTokens: ev.limitTokens,
        exceedsModelLimit: ev.exceedsModelLimit,
        exceedsClientPolicy: ev.exceedsClientPolicy,
        clientPolicyLimit: ev.clientPolicyLimit,
        runtimeState: ev.runtimeState,
        policyKnown: ev.policyKnown,
        adoptableTokens: ev.adoptableTokens,
        requiresDynamicUnlock: ev.requiresDynamicUnlock,
        warnings
      };
    }

    const rawStr = typeof rawInput === 'number' ? String(rawInput) : String(rawInput || '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    if (num < CTX_MIN_ENGINEERING_TOKENS || num > CTX_MAX_ENGINEERING_TOKENS) {
      return {
        ok: false,
        error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
      };
    }
    const warnings = [];
    if (num < 65536) {
      warnings.push(t('models.validation.tooSmall', { val: fmt(num) }));
    }
    const sLimit = Number(state.latest?.serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push(t('models.validation.aboveService', { val: formatKShort(sLimit) }));
    }
    return { ok: true, mode: 'fixed', limitTokens: num, warnings };
  }

  /** 将所有已知模型、当前会话和历史调用按产品维度分组 */
  function getKnownModelProducts() {
    const productMap = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];

    const slugToKey = new Map();
    const ensureProduct = (meta, fromAccountCatalog = false) => {
      const g = groupProductSafe(meta);
      if (!g.productKey) return null;
      const keyParts = g.productKey.split(':');
      const keySlug = keyParts.length >= 3 ? keyParts.slice(2).join(':') : '';
      let targetKey = g.productKey;
      // 若同一产品 slug 在列表里既有明确厂商又有"其他"厂商，合并到明确厂商条目下（不合并不同前缀或代际）
      if (keySlug && !productMap.has(targetKey) && slugToKey.has(keySlug)) {
        const existingKey = slugToKey.get(keySlug);
        const existingProd = productMap.get(existingKey);
        if (existingProd && (g.vendor === '其他' || existingProd.vendor === '其他')) {
          if (existingProd.vendor === '其他' && g.vendor !== '其他') {
            productMap.delete(existingKey);
            existingProd.productKey = targetKey;
            existingProd.vendor = g.vendor;
            productMap.set(targetKey, existingProd);
            slugToKey.set(keySlug, targetKey);
          } else {
            targetKey = existingKey;
          }
        }
      }
      let prod = productMap.get(targetKey);
      if (!prod) {
        prod = {
          productKey: targetKey,
          productLabel: g.productLabel,
          vendor: g.vendor || '其他',
          inAccountCatalog: Boolean(fromAccountCatalog),
          unavailable: Boolean(meta.unavailable),
          unavailabilityReason: meta.unavailabilityReason || null,
          notice: meta.notice || null,
          isHistorical: Boolean(meta.isHistorical),
          members: new Map()
        };
        productMap.set(targetKey, prod);
        if (keySlug && (!slugToKey.has(keySlug) || g.vendor !== '其他')) {
          slugToKey.set(keySlug, targetKey);
        }
      } else if (fromAccountCatalog) {
        prod.inAccountCatalog = true;
        if (meta.notice && !prod.notice) prod.notice = meta.notice;
        if (meta.isHistorical !== undefined) prod.isHistorical = prod.isHistorical && Boolean(meta.isHistorical);
      }
      if (meta.modelId) {
        const mid = String(meta.modelId).trim().toLowerCase();
        const prev = prod.members.get(mid);
        const capEntry = state.modelCapabilitiesById?.[mid.replace(/^model_/, '')]
          || state.modelCapabilitiesById?.[String(meta.modelOrAlias?.model || '').trim().toLowerCase().replace(/^model_/, '')]
          || null;
        prod.members.set(mid, {
          modelId: mid,
          label: meta.label || prev?.label || mid,
          effort: g.effort || prev?.effort || null,
          maxTokens: meta.maxTokens ?? capEntry?.maxTokens ?? prev?.maxTokens ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? capEntry?.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
          thinkingBudget: meta.thinkingBudget ?? capEntry?.thinkingBudget ?? prev?.thinkingBudget ?? null,
          minThinkingBudget: meta.minThinkingBudget ?? capEntry?.minThinkingBudget ?? prev?.minThinkingBudget ?? null,
          thinkingLevel: meta.thinkingLevel || capEntry?.thinkingLevel || prev?.thinkingLevel || null,
          supportsModelInfoOverride: meta.supportsModelInfoOverride ?? capEntry?.supportsModelInfoOverride ?? prev?.supportsModelInfoOverride ?? null,
          capabilitySource: meta.capabilitySource || capEntry?.capabilitySource || prev?.capabilitySource || null,
          unavailable: meta.unavailable !== undefined ? Boolean(meta.unavailable) : (prev?.unavailable || false),
          unavailabilityReason: meta.unavailabilityReason || prev?.unavailabilityReason || null,
          notice: meta.notice || prev?.notice || null,
          isHistorical: meta.isHistorical !== undefined ? Boolean(meta.isHistorical) : (prev?.isHistorical || false)
        });
      }
      return prod;
    };

    if (Array.isArray(configs)) {
      for (const c of configs) {
        const stableId = resolveStableModelKeyClient(c) || c?.modelId || c?.modelOrAlias?.model;
        ensureProduct({
          modelId: stableId,
          label: c?.label || c?.modelId || stableId,
          modelOrAlias: c?.modelOrAlias,
          effort: c?.effort,
          maxTokens: c?.maxTokens,
          maxOutputTokens: c?.maxOutputTokens,
          thinkingBudget: c?.thinkingBudget,
          minThinkingBudget: c?.minThinkingBudget,
          thinkingLevel: c?.thinkingLevel,
          supportsModelInfoOverride: c?.supportsModelInfoOverride,
          capabilitySource: c?.capabilitySource,
          unavailable: c?.unavailable,
          unavailabilityReason: c?.unavailabilityReason,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (state.latest?.modelId || state.latest?.modelRaw || state.latest?.model) {
      const stableId = resolveStableModelKeyClient(state.latest);
      ensureProduct({
        modelId: stableId,
        label: state.latest.model || stableId,
        modelOrAlias: state.latest.modelOrAlias,
        effort: state.latest.effort
      }, false);
    }

    const calls = [...(ANTIGRAVITY_TOKEN_DATA.speedRecords || []), ...(state.sessionCalls || [])];
    for (const c of calls) {
      if (!c) continue;
      const mid = c.modelExactId || c.modelId || c.model;
      if (!mid) continue;
      ensureProduct({
        modelId: mid,
        label: c.modelLabel || c.model || mid,
        effort: c.effort
      }, false);
    }

    for (const [k, pref] of Object.entries(contextPreferencesMap || {})) {
      if (!pref) continue;
      const g = groupProductSafe({
        modelId: pref.productKey || k,
        label: pref.label || k
      });
      if (pref.scope === 'product' || k === g.productKey) {
        ensureProduct({
          modelId: pref.productKey || k,
          label: pref.label || g.productLabel
        }, false);
      } else {
        ensureProduct({
          modelId: k,
          label: pref.label || k
        }, false);
      }
    }

    const rankEffort = { Minimal: 1, Low: 2, Medium: 3, High: 4, XHigh: 5, Extra: 6, 'Extra High': 7, Max: 8 };
    const result = Array.from(productMap.values()).map(p => {
      const members = Array.from(p.members.values()).sort((a, b) => (rankEffort[a.effort] || 99) - (rankEffort[b.effort] || 99));
      const allUnavailable = members.length > 0 && members.every(m => m.unavailable);
      const partialUnavailable = members.length > 0 && !allUnavailable && members.some(m => m.unavailable);
      const isUnavailable = members.length > 0 ? allUnavailable : Boolean(p.unavailable);
      const isHistorical = members.length > 0 ? (members.every(m => m.isHistorical) || !p.inAccountCatalog) : (p.isHistorical || (!p.inAccountCatalog));
      const notice = p.notice || members.find(m => m.notice)?.notice || null;
      const reason = isUnavailable
        ? (p.unavailabilityReason || members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null)
        : (partialUnavailable ? (members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null) : null);
      return {
        productKey: p.productKey,
        productLabel: p.productLabel,
        vendor: p.vendor,
        inAccountCatalog: p.inAccountCatalog,
        unavailable: isUnavailable,
        partialUnavailable,
        unavailabilityReason: reason,
        notice,
        isHistorical,
        members
      };
    });
    result.sort((a, b) => {
      const va = VENDOR_ORDER.indexOf(a.vendor);
      const vb = VENDOR_ORDER.indexOf(b.vendor);
      if (va !== vb) return (va === -1 ? 99 : va) - (vb === -1 ? 99 : vb);
      return a.productLabel.localeCompare(b.productLabel);
    });
    return result;
  }

  function formatSavedPrefLabel(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) {
      const num = Number(pref.limitTokens);
      if (num === 512000) return '512K';
      return t('models.card.savedCustom', { val: `${formatKShort(num)}（${fmt(num)}）` });
    }
    return t('status.savedDefault');
  }

  function formatPrefShortPill(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedShortDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) return formatKShort(pref.limitTokens);
    return t('status.savedShortDefault');
  }

  /** 解析当前产品的设置状态与旧档位迁移/冲突检测 */
  function resolveProductPreferenceState(product) {
    if (!product) {
      return { status: 'none', pref: null, displayText: t('status.savedDefault'), shortText: t('status.savedShortDefault'), legacyKeys: [], conflictEntries: [] };
    }
    const pKey = product.productKey;
    const direct = contextPreferencesMap?.[pKey];
    if (direct && (direct.scope === 'product' || (direct.productKey && direct.productKey === pKey))) {
      return {
        status: 'product',
        pref: direct,
        displayText: formatSavedPrefLabel(direct),
        shortText: formatPrefShortPill(direct),
        legacyKeys: [],
        conflictEntries: []
      };
    }

    const legacyEntries = [];
    const seenKeys = new Set();
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    for (const [k, rawPref] of Object.entries(contextPreferencesMap || {})) {
      if (!rawPref) continue;
      if (k === pKey && rawPref.scope === 'product') continue;
      const belonged = memberIds.has(k) || groupProductSafe({ modelId: k, label: rawPref.label || k }).productKey === pKey;
      if (!belonged) continue;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      const memberMeta = (product.members || []).find(m => m.modelId === k);
      const effortName = memberMeta?.effort || groupProductSafe({ modelId: k, label: rawPref.label || k }).effort;
      legacyEntries.push({
        legacyKey: k,
        effort: effortName,
        effortLabel: effortName ? formatEffortZh(effortName) : (rawPref.label || k),
        mode: rawPref.mode || 'default',
        limitTokens: rawPref.mode === 'fixed' ? Number(rawPref.limitTokens) : null,
        updatedAt: rawPref.updatedAt || null,
        label: rawPref.label || product.productLabel
      });
    }

    if (legacyEntries.length === 0) {
      if (direct) {
        return {
          status: 'product',
          pref: direct,
          displayText: formatSavedPrefLabel(direct),
          shortText: formatPrefShortPill(direct),
          legacyKeys: [],
          conflictEntries: []
        };
      }
      return { status: 'none', pref: null, displayText: t('models.pref.none'), shortText: t('models.pref.noneShort'), legacyKeys: [], conflictEntries: [] };
    }

    const sigs = new Map();
    for (const entry of legacyEntries) {
      const sig = `${entry.mode}:${entry.mode === 'fixed' ? (entry.limitTokens || 0) : ''}`;
      if (!sigs.has(sig)) sigs.set(sig, entry);
    }

    if (sigs.size === 1) {
      const unified = legacyEntries[0];
      const syntheticPref = {
        scope: 'product',
        productKey: pKey,
        modelId: pKey,
        label: product.productLabel,
        mode: unified.mode,
        limitTokens: unified.limitTokens,
        updatedAt: unified.updatedAt
      };
      return {
        status: 'legacy_uniform',
        pref: syntheticPref,
        displayText: formatSavedPrefLabel(syntheticPref),
        shortText: formatPrefShortPill(syntheticPref),
        legacyKeys: legacyEntries.map(e => e.legacyKey),
        conflictEntries: []
      };
    }

    return {
      status: 'conflict',
      pref: null,
      displayText: t('models.pref.inconsistent'),
      shortText: t('models.pref.inconsistent'),
      legacyKeys: legacyEntries.map(e => e.legacyKey),
      conflictEntries: legacyEntries
    };
  }

  function describeClientModeValue(data) {
    if (!data) return t('models.preset.default');
    if (data.configuredMode === 'dynamic') return t('models.preset.dynamic');
    if (data.configuredMode === 'fixed' && data.configuredLimitTokens) {
      return formatKShort(data.configuredLimitTokens);
    }
    return t('models.preset.default');
  }

  function doesClientMatchVerification(data, ver) {
    if (!data || !ver) return false;
    const mode = data.configuredMode || 'unknown';
    if (ver.mode === 'dynamic') return mode === 'dynamic';
    if (ver.mode === 'default') return mode === 'default' || data.status === 'not_patched';
    if (ver.mode === 'fixed') return mode === 'fixed' && Number(data.configuredLimitTokens) === Number(ver.limitTokens);
    return false;
  }

  /** 将状态 strictly 映射为规定的 5 个普通视图标签之一 */
  function mapUnlockDisplayStatus(data) {
    if (unlockStatusFetchError) {
      return { badge: t('status.badge.unavailable'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    if (!data) {
      return { badge: t('status.badge.reading'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    const raw = data.status;
    const restarted = data.runtimeEvidence?.restartDetected === true;

    if (raw === 'patched_pending_restart') {
      return { badge: t('status.badge.pendingRestart'), pillClass: 'pill-warn', effectiveLoaded: false };
    }
    if (raw === 'not_patched') {
      return { badge: t('status.badge.notPatched'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    if (raw === 'patched_loaded') {
      if (!restarted) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
      }
      if ((pendingRestartVerification && !doesClientMatchVerification(data, pendingRestartVerification)) || restartMismatchNotice) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-warn', effectiveLoaded: false };
      }
      return { badge: t('status.badge.loaded'), pillClass: 'pill-ok', effectiveLoaded: true };
    }
    if (raw === 'patched_runtime_unconfirmed') {
      return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
    }
    if (raw === 'partial_match') {
      return { badge: t('status.badge.partialMatch'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    return { badge: t('status.badge.failed'), pillClass: 'pill-danger', effectiveLoaded: false };
  }

  function buildFriendlyWriteError(rawErr) {
    const msg = String(rawErr || '');
    if (/EBUSY|EPERM|EACCES|占用|lock|locked|in use/i.test(msg)) {
      return t('msg.writeBusy');
    }
    return t('msg.writeFail', { err: translateBackendText(msg) || t('msg.unknownErr') });
  }

  function applyContextViewVisibility() {
    if (ctxTabsBar) ctxTabsBar.hidden = false;
    if (paneSettings) paneSettings.hidden = activeContextTab !== 'settings';
    if (paneSession) paneSession.hidden = activeContextTab !== 'session';
    if (paneModels) paneModels.hidden = activeContextTab !== 'models';
    if (paneSpeed) paneSpeed.hidden = activeContextTab !== 'speed';

    setPillActive(btnTabSession, activeContextTab === 'session');
    setPillActive(btnTabModels, activeContextTab === 'models');
    setPillActive(btnTabSpeed, activeContextTab === 'speed');
    setPillActive(btnTabSettings, activeContextTab === 'settings');
    btnTabSession?.setAttribute('aria-selected', String(activeContextTab === 'session'));
    btnTabModels?.setAttribute('aria-selected', String(activeContextTab === 'models'));
    btnTabSpeed?.setAttribute('aria-selected', String(activeContextTab === 'speed'));
    btnTabSettings?.setAttribute('aria-selected', String(activeContextTab === 'settings'));
  }

  let prevTabBeforeSettings = 'models';

  function switchContextTab(tabName) {
    if (tabName !== 'session' && tabName !== 'models' && tabName !== 'speed' && tabName !== 'settings') return;
    if (activeContextTab !== 'settings') {
      prevTabBeforeSettings = activeContextTab;
    }
    activeContextTab = tabName;
    isContextSettingsView = tabName === 'settings';
    try { localStorage?.setItem(CTX_ACTIVE_TAB_KEY, tabName); } catch {}
    applyContextViewVisibility();
    if (tabName === 'models') {
      renderModelSettingsTab();
      if (!currentUnlockStatus && !unlockStatusFetchError) {
        void refreshUnlockStatus();
      }
    } else if (tabName === 'speed') {
      // 速度对比页只读取已有本地记录，绝不发起任何请求或 IPC
      renderSpeedComparisonTab();
    } else if (tabName === 'settings') {
      void refreshModulesDisplay();
      if (typeof refreshEnhanceStatus === 'function') void refreshEnhanceStatus();
    }
    positionFloatingPanels();
  }

  function openContextSettings(opts = {}) {
    if (el('panel')?.hidden) showPanel('context');
    switchContextTab('settings');
    if (opts.openColors) {
      toggleColorsDrawer(true);
    }
    positionFloatingPanels();
  }

  function closeContextSettings() {
    switchContextTab(prevTabBeforeSettings || 'models');
    positionFloatingPanels();
  }

  btnTabSession?.addEventListener('click', () => switchContextTab('session'));
  btnTabModels?.addEventListener('click', () => switchContextTab('models'));
  btnTabSpeed?.addEventListener('click', () => switchContextTab('speed'));
  btnTabSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettingsBack?.addEventListener('click', () => closeContextSettings());

  btnGotoModelSettings?.addEventListener('click', () => {
    if (activeSessionProductKey) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
      manualModelSelection = false;
      ctxDraftDirty = false;
    }
    switchContextTab('models');
  });

  btnCardGotoSpeed?.addEventListener('click', () => {
    const products = getKnownModelProducts();
    const curProd = products.find(p => p.productKey === selectedProductKey) || products[0];
    if (curProd) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const targetMember = curProd.members.find(m => m.modelId === activeSessionModelKey)
        || curProd.members.find(m => mergedCalls.some(c => c.modelExactId === m.modelId && isValidSpeedSampleSafe(c)))
        || curProd.members[0];
      if (targetMember) selectedSpeedExactModelId = targetMember.modelId;
    }
    switchContextTab('speed');
  });

  btnCtxBackCurrent?.addEventListener('click', () => {
    const hostSelected = extractHostSelectedModel();
    if (hostSelected && hostSelected.productKey) {
      activeSessionModelKey = hostSelected.modelId;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
      }
    }
    if (!activeSessionModelConfirmed || !activeSessionProductKey) {
      if (typeof showToastNotification === 'function') {
        showToastNotification(t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      } else {
        showUnlockResultBox(false, t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      }
      return;
    }
    manualModelSelection = false;
    selectedProductKey = activeSessionProductKey;
    selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function toggleUnlockDrawer(forceOpen) {
    if (!unlockDrawerBody) return;
    const isHidden = unlockDrawerBody.style.display === 'none' || !unlockDrawerBody.style.display;
    const nextOpen = forceOpen === undefined ? isHidden : Boolean(forceOpen);
    unlockDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (unlockDrawerArrow) unlockDrawerArrow.textContent = nextOpen ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleUnlockDetails?.setAttribute('aria-expanded', String(nextOpen));
    if (nextOpen && !currentUnlockStatus) void refreshUnlockStatus();
  }

  btnToggleUnlockDetails?.addEventListener('click', () => toggleUnlockDrawer());

  function getSelectedProductObj() {
    const products = getKnownModelProducts();
    if (!products.length) return null;
    if (selectedProductKey) {
      const found = products.find(p => p.productKey === selectedProductKey);
      if (found) return found;
    }
    if (activeSessionProductKey) {
      const activeFound = products.find(p => p.productKey === activeSessionProductKey);
      if (activeFound) return activeFound;
    }
    return products[0];
  }

  function renderHeaderModelDropdown() {
    const products = getKnownModelProducts();
    if (!selectedProductKey && products.length) {
      selectedProductKey = activeSessionProductKey || products[0].productKey;
    }
    const currentProd = products.find(p => p.productKey === selectedProductKey) || products[0] || null;
    if (currentProd) {
      selectedProductKey = currentProd.productKey;
      selectedEditModelKey = (activeSessionProductKey === currentProd.productKey && activeSessionModelKey)
        ? activeSessionModelKey
        : (currentProd.members[0]?.modelId || currentProd.productKey);
    }

    if (ctxModelSelectorRoleEl) {
      ctxModelSelectorRoleEl.textContent = t('panel.ctx.viewModel');
    }
    if (btnCtxBackCurrent) {
      btnCtxBackCurrent.hidden = !(manualModelSelection && activeSessionModelConfirmed && activeSessionProductKey && selectedProductKey && selectedProductKey !== activeSessionProductKey);
    }

    if (ctxModelSelect && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      if (typeof ctxModelSelect.replaceChildren === 'function') {
        const opts = [];
        for (const p of products) {
          const opt = document.createElement('option');
          opt.value = p.productKey;
          const pState = resolveProductPreferenceState(p);
          opt.textContent = `${p.productLabel} (${pState.shortText})${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          opts.push(opt);
        }
        ctxModelSelect.replaceChildren(...opts);
        if (selectedProductKey) ctxModelSelect.value = selectedProductKey;
      }
    }

    if (ctxModelDropdownLabelEl) {
      ctxModelDropdownLabelEl.textContent = currentProd ? currentProd.productLabel : t('models.dropdown.empty');
    }

    if (!ctxHeaderDropdownCtrl && typeof initDropdownController === 'function' && el('ctx-model-dropdown-wrap')) {
      ctxHeaderDropdownCtrl = initDropdownController({
        wrapId: 'ctx-model-dropdown-wrap',
        triggerId: 'ctx-model-dropdown-trigger',
        labelId: 'ctx-model-dropdown-label',
        menuId: 'ctx-model-dropdown-menu',
        selectId: 'ctx-model-select',
        emptyLabel: () => t('models.dropdown.empty'),
        searchPlaceholder: () => t('dropdown.modelSearch'),
        emptyText: () => t('dropdown.modelEmpty'),
        getSelectedValue: () => selectedProductKey || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
          selectedProductKey = val;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        },
        getOptions: () => {
          const list = getKnownModelProducts();
          const items = [];
          const activeList = list.filter(p => p.inAccountCatalog);
          const historyList = list.filter(p => !p.inAccountCatalog);
          let lastVendor = '';
          for (const p of activeList) {
            if (p.vendor !== lastVendor) {
              lastVendor = p.vendor;
              items.push({
                value: `__group_${p.vendor}`,
                label: formatVendorLabel(p.vendor),
                isGroupHeader: true,
                dotColor: VENDOR_DOT_COLORS[p.vendor] || VENDOR_DOT_COLORS['其他']
              });
            }
            const pState = resolveProductPreferenceState(p);
            items.push({
              value: p.productKey,
              label: p.productLabel,
              displayRight: pState.shortText,
              badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : '',
              aliases: [p.vendor, p.productKey]
            });
          }
          if (historyList.length) {
            items.push({
              value: '__group_history',
              label: t('models.list.historyGroup'),
              isGroupHeader: true,
              dotColor: VENDOR_DOT_COLORS['其他']
            });
            for (const p of historyList) {
              const pState = resolveProductPreferenceState(p);
              items.push({
                value: p.productKey,
                label: p.productLabel,
                displayRight: pState.shortText,
                badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : t('models.list.historyTag'),
                aliases: [p.vendor, p.productKey]
              });
            }
          }
          return items;
        }
      });
    } else if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.refresh === 'function') {
      ctxHeaderDropdownCtrl.refresh();
    }
  }

  ctxModelSelect?.addEventListener('change', (e) => {
    const val = e?.target?.value || '';
    if (!val) return;
    manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
    selectedProductKey = val;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function renderCompactSessionCard() {
    const scopeMode = getContextScopeMode();
    if (ctxCompactSavedEl) {
      if (scopeMode === 'unified') {
        ctxCompactSavedEl.textContent = formatSavedPrefLabel(contextUnifiedPreference);
      } else if (!activeSessionModelConfirmed || !activeSessionProductKey) {
        ctxCompactSavedEl.textContent = t('panel.ctx.currentModelUnconfirmed') || '当前模型待确认';
      } else {
        const products = getKnownModelProducts();
        const targetProd = products.find(p => p.productKey === activeSessionProductKey) || null;
        const pState = resolveProductPreferenceState(targetProd);
        ctxCompactSavedEl.textContent = pState.pref == null && pState.status === 'none' ? t('status.savedDefault') : pState.displayText;
      }
    }
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCompactClientEl) {
      if (unlockStatusFetchError) {
        ctxCompactClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCompactClientEl.textContent = t('status.badge.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${t('models.status.pendingRestart') || statusInfo.badge}）`;
      } else {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${statusInfo.badge}）`;
      }
    }
  }

  function renderClientStatusBar() {
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (unlockBadge) {
      unlockBadge.textContent = statusInfo.badge;
      unlockBadge.className = `key-pill ${statusInfo.pillClass}`;
    }

    if (ctxClientStatusText) {
      if (unlockStatusFetchError) {
        ctxClientStatusText.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxClientStatusText.textContent = t('status.client.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxClientStatusText.textContent = t('status.client.pendingRestart', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'dynamic') {
        ctxClientStatusText.textContent = t('status.client.loadedDynamic');
      } else if (currentUnlockStatus.configuredMode === 'fixed' || currentUnlockStatus.limitTokens) {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'default' || currentUnlockStatus.status === 'unpatched_official') {
        ctxClientStatusText.textContent = t('status.client.loadedDefault');
      } else {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      }
    }

    if (ctxRestartMismatchNote) {
      if (restartMismatchNotice) {
        ctxRestartMismatchNote.textContent = restartMismatchNotice;
        ctxRestartMismatchNote.hidden = false;
      } else {
        ctxRestartMismatchNote.hidden = true;
      }
    }

    const showRestart = needsRestartAfterApply || currentUnlockStatus?.status === 'patched_pending_restart';
    const isErrorStatus = currentUnlockStatus?.status === 'partial_match' || currentUnlockStatus?.status === 'failed';
    if (btnRestartHost) {
      btnRestartHost.hidden = !showRestart || !hostSupportsRestart;
    }
    if (ctxManualRestartNote) {
      ctxManualRestartNote.hidden = hostSupportsRestart || !showRestart;
    }
    if (btnUnlockResultRestart) {
      btnUnlockResultRestart.hidden = !showRestart || !hostSupportsRestart;
    }
    if (btnUnlockResultRetry) {
      btnUnlockResultRetry.hidden = !isErrorStatus;
    }
    if (unlockResultManual) {
      unlockResultManual.hidden = !(showRestart && !hostSupportsRestart);
    }
    if (unlockResultActions) {
      const hasAction = (showRestart && hostSupportsRestart) || isErrorStatus;
      unlockResultActions.hidden = !hasAction;
    }
    const btnEnhanceRestart = el('btn-enhance-restart-host');
    if (btnEnhanceRestart) {
      btnEnhanceRestart.hidden = !(showRestart && hostSupportsRestart);
    }
  }

  function renderModelListGroup(products) {
    if (!ctxModelListEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (!products.length) {
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const accountProducts = hasAccountCatalog ? products.filter(p => p.inAccountCatalog) : products;
    const historyProducts = hasAccountCatalog ? products.filter(p => !p.inAccountCatalog) : [];

    const appendGroupRows = (fragNodes, vendor, list, isHistoryGroup = false) => {
      const grp = document.createElement('div');
      grp.className = 'ctx-model-group';

      const hdr = document.createElement('div');
      hdr.className = isHistoryGroup ? 'ctx-model-group-hdr is-history-hdr' : 'ctx-model-group-hdr';
      const dot = document.createElement('span');
      dot.className = 'ag-vendor-dot';
      if (dot.style) dot.style.background = VENDOR_DOT_COLORS[vendor] || VENDOR_DOT_COLORS['其他'];
      const vTxt = document.createElement('span');
      vTxt.textContent = isHistoryGroup ? t('models.list.historyGroup') : formatVendorLabel(vendor);
      hdr.appendChild(dot);
      hdr.appendChild(vTxt);
      grp.appendChild(hdr);

      for (const prod of list) {
        const pState = resolveProductPreferenceState(prod);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `ctx-product-row${prod.productKey === selectedProductKey ? ' is-active' : ''}${prod.unavailable ? ' is-unavailable' : ''}`;
        row.setAttribute('data-product-key', prod.productKey);

        const left = document.createElement('span');
        left.className = 'ctx-product-row-left';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ctx-product-row-name';
        nameSpan.textContent = prod.productLabel;
        left.appendChild(nameSpan);

        if (prod.unavailable) {
          const unavailTag = document.createElement('span');
          unavailTag.className = 'ctx-product-row-unavailable-tag';
          unavailTag.textContent = t('models.card.modelUnavailable') || '不可用';
          if (prod.unavailabilityReason) unavailTag.title = prod.unavailabilityReason;
          left.appendChild(unavailTag);
        } else if (prod.notice) {
          const noticeTag = document.createElement('span');
          noticeTag.className = 'ctx-product-row-notice-tag';
          noticeTag.textContent = 'Notice';
          noticeTag.title = typeof prod.notice === 'string' ? prod.notice : JSON.stringify(prod.notice);
          left.appendChild(noticeTag);
        }

        if (prod.productKey === activeSessionProductKey) {
          const curTag = document.createElement('span');
          curTag.className = 'ag-dropdown-badge';
          curTag.textContent = t('models.list.currentTag');
          left.appendChild(curTag);
        } else if (isHistoryGroup || prod.isHistorical) {
          const histTag = document.createElement('span');
          histTag.className = 'ctx-product-row-history-tag';
          histTag.textContent = t('models.list.historyTag');
          left.appendChild(histTag);
        }

        const right = document.createElement('span');
        right.className = 'ctx-product-row-right';
        const valSpan = document.createElement('span');
        valSpan.className = `ctx-product-row-val${pState.status === 'conflict' ? ' is-conflict' : ''}`;
        valSpan.textContent = pState.shortText;
        right.appendChild(valSpan);

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => {
          manualModelSelection = Boolean(activeSessionProductKey && prod.productKey !== activeSessionProductKey);
          selectedProductKey = prod.productKey;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        });
        grp.appendChild(row);
      }
      fragNodes.push(grp);
    };

    const groups = new Map();
    for (const p of accountProducts) {
      if (!groups.has(p.vendor)) groups.set(p.vendor, []);
      groups.get(p.vendor).push(p);
    }
    const fragNodes = [];
    for (const [vendor, list] of groups.entries()) {
      appendGroupRows(fragNodes, vendor, list, false);
    }
    if (historyProducts.length > 0) {
      appendGroupRows(fragNodes, '其他', historyProducts, true);
    }
    if (typeof ctxModelListEl.replaceChildren === 'function') {
      ctxModelListEl.replaceChildren(...fragNodes);
    }
  }

  function findLatestProductObservation(product, activeConvId = null) {
    if (!product) return { latestBudgetObs: null, latestServiceLimitObs: null };
    const scoped = budgetTracker ? budgetTracker.getScopedObservation(activeConvId, product.productKey) : null;
    if (scoped) {
      return {
        latestBudgetObs: scoped.budget > 0 ? scoped : null,
        latestServiceLimitObs: scoped.serviceLimit > 0 ? scoped : null
      };
    }
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let latestBudgetObs = null;
    let latestServiceLimitObs = null;

    for (const mid of memberIds) {
      const obs = observedByModelId.get(mid);
      if (!obs) continue;
      if (activeConvId && obs.convoId && obs.convoId !== activeConvId) continue;
      if (obs.budget > 0 && (!latestBudgetObs || obs.ts > latestBudgetObs.ts)) {
        latestBudgetObs = obs;
      }
      if (obs.serviceLimit > 0 && (!latestServiceLimitObs || obs.ts > latestServiceLimitObs.ts)) {
        latestServiceLimitObs = obs;
      }
    }
    return { latestBudgetObs, latestServiceLimitObs };
  }

  function findPreRestartBudgetForProduct(product) {
    if (!product || !preRestartSnapshot?.observations) return null;
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let best = null;
    for (const mid of memberIds) {
      const obs = preRestartSnapshot.observations[mid];
      if (obs && obs.budget > 0 && (!best || obs.ts > best.ts)) best = obs;
    }
    return best;
  }

  async function resolveProductConflict(product, chosenEntry) {
    if (!product || !chosenEntry) return;
    const legacyKeys = resolveProductPreferenceState(product).legacyKeys;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('models.toast.saveFailed', { err: translateBackendText(res?.error) || t('models.err.saveFailed') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[product.productKey] = {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    showUnlockResultBox(true, t('models.toast.savedUniform'));
  }

  function evaluateModelContextStatus(product) {
    if (!product) {
      return {
        status: 'unconfirmed',
        badge: t('panel.ctx.currentModelUnconfirmed') || '待确认',
        pillClass: 'pill-muted',
        diagnosis: '未获取到模型信息',
        targetText: '—',
        requestText: '—',
        observedText: '—',
        convoId: '—'
      };
    }

    const pState = resolveProductPreferenceState(product);
    const scopeMode = getContextScopeMode();
    const activePref = (scopeMode === 'unified') ? contextUnifiedPreference : pState.pref;
    const targetMode = activePref?.mode || 'default';
    const targetLimit = (targetMode === 'fixed') ? Number(activePref?.limitTokens) : null;
    const capSummary = getProductCapabilitySummary(product);

    let targetText = t('status.savedDefault') || '恢复客户端默认';
    if (targetMode === 'dynamic') {
      targetText = t('models.preset.dynamic') || '动态跟随';
    } else if (targetMode === 'fixed' && targetLimit) {
      targetText = (targetLimit === 512000) ? '512K（512,000 tokens）' : `${formatKShort(targetLimit)}（${fmt(targetLimit)} tokens）`;
    }

    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;
    const evalCore = budgetTracker
      ? budgetTracker.evaluateStatus({
        product,
        scopeMode,
        pref: activePref,
        activeConvId,
        modelHardLimit: capSummary?.modelTheoreticalMaxTokens || null
      })
      : {
        status: 'saved_pending_dispatch',
        convoId: activeConvId || '—',
        targetMode,
        targetLimit,
        dispatched: null,
        observation: findLatestProductObservation(product, activeConvId).latestBudgetObs
      };

    const dispatched = evalCore.dispatched;
    const obs = evalCore.observation;
    const obsBudget = Number(obs?.budget || 0);

    let requestText = dispatched ? '默认透传（未附加自定义参数）' : '尚无本次验证';
    if (dispatched) {
      if (dispatched.status === 'send_failed') {
        requestText = `发送失败（${dispatched.errorMessage || '请求未完成'}）`;
      } else if (dispatched.status === 'aborted') {
        requestText = '已取消发送';
      } else if (dispatched.status === 'uninjectable') {
        requestText = '透传未注入（缺少可靠模型/不支持帧）';
      } else if (dispatched.sentMode === 'fixed' && dispatched.sentLimitTokens) {
        requestText = `${formatKShort(dispatched.sentLimitTokens)}（${fmt(dispatched.sentLimitTokens)} tokens）`;
      } else if (dispatched.sentMode === 'dynamic') {
        requestText = '动态跟随（已清除固定数值）';
      }
      if (dispatched.timestamp) {
        requestText += ` · ${formatMonthDayTime(dispatched.timestamp)}`;
      }
    }

    function statusUsesExistingObs(st, diagCode) {
      return st === 'confirmed'
        || st === 'clamped_by_model_limit'
        || st === 'mismatch'
        || (st === 'default' && diagCode === 'default_confirmed');
    }

    let observedText = '尚无本次验证';
    if (obsBudget > 0 && statusUsesExistingObs(evalCore.status, evalCore.diagnosisCode)) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      const tTxt = obs.ts ? ` · ${formatMonthDayTime(obs.ts)}` : '';
      observedText = `${formatKShort(obsBudget)}（${fmt(obsBudget)} tokens）${effTxt}${tTxt}`;
    } else if (obsBudget > 0) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      observedText = `仅见历史观测 ${fmt(obsBudget)} tokens${effTxt}（当前设置尚无本次验证）`;
    }

    const convoId = evalCore.convoId || activeConvId || '—';

    let status = evalCore.status;
    let badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
    let pillClass = 'pill-muted';
    let diagnosis = '已保存目标参数，将在下次发起请求时自动注入并发送。';

    if (status === 'default') {
      if (evalCore.diagnosisCode === 'default_confirmed') {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-good';
        diagnosis = `本次请求已按客户端默认透传（未附加自定义覆盖），收到新回复确认实际采用 ${fmt(obsBudget)} tokens。`;
      } else {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-muted';
        diagnosis = '已恢复/保持客户端默认（不附加覆盖参数），将在下一次发送时生效并验证实际采用值。';
      }
    } else if (status === 'send_failed') {
      badge = '发送失败（未确认）';
      pillClass = 'pill-bad';
      diagnosis = `本次请求发送失败（${evalCore.errorMessage || '网络或传输错误'}），因此无法确认实际预算。`;
    } else if (status === 'aborted') {
      badge = '已取消（未确认）';
      pillClass = 'pill-muted';
      diagnosis = '本次请求在完成前被取消，未收到新回复。';
    } else if (status === 'uninjectable') {
      badge = '本次未注入（已透传）';
      pillClass = 'pill-warn';
      diagnosis = `未能向本次请求自动注入参数（${evalCore.diagnosisCode || '缺少可靠模型身份或协议格式不支持'}），已保持原样透传。`;
    } else if (status === 'confirmed') {
      badge = t('models.status.confirmed') || '实际预算已确认';
      pillClass = 'pill-good';
      diagnosis = targetMode === 'dynamic'
        ? `已启用动态跟随模式，本次发送后实测返回预算 ${fmt(obsBudget)} tokens。`
        : `请求实际携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次发送后服务端返回预算 ${fmt(obsBudget)} tokens，完全吻合。`;
    } else if (status === 'clamped_by_model_limit') {
      badge = '受模型上限限制';
      pillClass = 'pill-warn';
      diagnosis = `请求携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/服务端上限（${fmt(evalCore.knownCap)} tokens）限制，实际采用 ${fmt(obsBudget)} tokens。`;
    } else if (status === 'mismatch') {
      badge = t('models.status.mismatch') || '未生效：目标值与观测值不一致';
      pillClass = 'pill-bad';
      let detail = `目标设置（${fmt(targetLimit)} tokens）与发送后实际观测预算（${fmt(obsBudget)} tokens）不一致，原因待确认。`;
      if (product.unavailable && product.unavailabilityReason) {
        detail += `（模型可用性说明：${product.unavailabilityReason}）`;
      }
      diagnosis = detail;
    } else if (status === 'timeout_unconfirmed') {
      badge = '确认超时（未观测到新回复）';
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? `已按客户端默认透传发送请求，但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`
        : `已在请求中携带设置（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`;
    } else if (status === 'dispatched_pending_confirm') {
      badge = targetMode === 'default' ? '已默认透传，等待确认' : (t('models.status.dispatchedPendingConfirm') || '已发送设置，等待确认');
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? '已按客户端默认透传发出请求（未附加覆盖参数），等待收到新回复以确认服务端实际预算。'
        : `已在本次请求中成功注入参数（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），等待收到新回复以确认实际分配预算。`;
    } else {
      status = 'saved_pending_dispatch';
      badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
      pillClass = 'pill-muted';
      diagnosis = `已保存目标设置（${targetText}），下一次在对应模型发起发送时将自动注入。`;
    }

    return {
      status,
      badge,
      pillClass,
      diagnosis,
      targetText,
      requestText,
      observedText,
      convoId
    };
  }

  function renderModelDetailCard(product) {
    if (!product) {
      if (ctxCardProductName) ctxCardProductName.textContent = t('models.card.waiting');
      if (ctxCardVendorName) ctxCardVendorName.textContent = '—';
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      if (ctxConflictBanner) ctxConflictBanner.hidden = true;
      if (ctxSummaryModelEl) ctxSummaryModelEl.textContent = '待确认';
      if (ctxSummaryLengthEl) ctxSummaryLengthEl.textContent = '—';
      if (ctxSummaryStatusPillEl) ctxSummaryStatusPillEl.hidden = true;
      return;
    }

    const evalResult = evaluateModelContextStatus(product);
    const pState = resolveProductPreferenceState(product);
    if (ctxCardVendorDot?.style) {
      ctxCardVendorDot.style.background = VENDOR_DOT_COLORS[product.vendor] || VENDOR_DOT_COLORS['其他'];
    }
    if (ctxCardVendorName) ctxCardVendorName.textContent = formatVendorLabel(product.vendor);
    if (ctxCardProductName) {
      if (product.unavailable) {
        ctxCardProductName.textContent = `${product.productLabel} [${t('models.card.modelUnavailable') || '不可用'}]`;
      } else {
        ctxCardProductName.textContent = product.productLabel;
      }
    }

    const efforts = product.members.map(m => m.effort).filter(Boolean);
    if (ctxCardEffortsList) {
      ctxCardEffortsList.textContent = efforts.length
        ? t('models.card.effortsList', { list: efforts.map(formatEffortZh).join(' · ') })
        : t('models.card.effortStandard');
    }
    if (ctxCardSessionEffort) {
      if (activeSessionProductKey === product.productKey && activeSessionEffort) {
        ctxCardSessionEffort.textContent = t('models.card.sessionEffort', { effort: formatEffortZh(activeSessionEffort) });
        ctxCardSessionEffort.hidden = false;
      } else {
        ctxCardSessionEffort.hidden = true;
      }
    }

    // 旧档位冲突横幅
    if (ctxConflictBanner && ctxConflictRows) {
      if (pState.status === 'conflict' && pState.conflictEntries.length > 0) {
        ctxConflictBanner.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxConflictRows.replaceChildren === 'function') {
          const rows = [];
          for (const ce of pState.conflictEntries) {
            const r = document.createElement('div');
            r.className = 'ctx-conflict-row';
            const lbl = document.createElement('span');
            lbl.textContent = `${ce.effortLabel} · ${formatSavedPrefLabel(ce)}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ctx-conflict-btn';
            btn.textContent = t('models.conflict.useThis');
            btn.addEventListener('click', () => { void resolveProductConflict(product, ce); });
            r.appendChild(lbl);
            r.appendChild(btn);
            rows.push(r);
          }
          const selfRow = document.createElement('div');
          selfRow.className = 'ctx-conflict-row';
          const selfHint = document.createElement('span');
          selfHint.textContent = t('models.conflict.orCustom');
          const selfBtn = document.createElement('button');
          selfBtn.type = 'button';
          selfBtn.className = 'ctx-conflict-btn';
          selfBtn.textContent = t('models.conflict.selfSet');
          selfBtn.addEventListener('click', () => {
            ctxCustomInput?.focus?.();
          });
          selfRow.appendChild(selfHint);
          selfRow.appendChild(selfBtn);
          rows.push(selfRow);
          ctxConflictRows.replaceChildren(...rows);
        }
      } else {
        ctxConflictBanner.hidden = true;
      }
    }

    // 0. 模型能力参考卡片渲染（紧邻预算设置区，不隐藏；严格区分模型上限 / 客户端限制 / 运行策略默认预算 / 可采纳范围）
    const capSummary = getProductCapabilitySummary(product);
    const runtimePolicy = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    if (ctxCapWindowEl) {
      ctxCapWindowEl.textContent = capSummary?.maxTokens ? `${fmt(capSummary.maxTokens)} tokens` : '未知（待获取元数据）';
    }
    if (ctxCapOutputEl) {
      ctxCapOutputEl.textContent = capSummary?.maxOutputTokens != null ? `${fmt(capSummary.maxOutputTokens)} tokens` : '未知';
    }
    if (ctxCapModelMaxEl) {
      ctxCapModelMaxEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
        ? `${fmt(capSummary.modelTheoreticalMaxTokens)} tokens`
        : '未知（待获取元数据）';
    }
    if (ctxCapClientPolicyEl) {
      if (!runtimePolicy || runtimePolicy.runtimeState === 'unknown') {
        ctxCapClientPolicyEl.textContent = '未知（待读取运行策略）';
      } else if (runtimePolicy.runtimeState === 'pending_restart') {
        ctxCapClientPolicyEl.textContent = `待重启（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
        ctxCapClientPolicyEl.textContent = `进程未确认（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'partial') {
        ctxCapClientPolicyEl.textContent = '部分异常（运行限制未知）';
      } else if (runtimePolicy.runtimeMode === 'dynamic') {
        ctxCapClientPolicyEl.textContent = 'Dynamic 动态跟随（按模型上限）';
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCapClientPolicyEl.textContent = `固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} tokens`;
      } else {
        ctxCapClientPolicyEl.textContent = '默认限制 256,000 tokens';
      }
    }
    if (ctxCapDefaultEl) {
      if (capSummary?.currentStrategyDefaultBudget != null && runtimePolicy?.policyKnown) {
        let stratNote = '';
        if (runtimePolicy.runtimeMode === 'dynamic') {
          stratNote = '（Dynamic 默认）';
        } else if (runtimePolicy.runtimeMode === 'fixed') {
          stratNote = `（受固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} 约束）`;
        } else {
          stratNote = '（受默认 256,000 约束）';
        }
        ctxCapDefaultEl.textContent = `${fmt(capSummary.currentStrategyDefaultBudget)} tokens${stratNote}`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapDefaultEl.textContent = '未知（运行策略待确认）';
      } else {
        ctxCapDefaultEl.textContent = '未知';
      }
    }
    if (ctxCapRangeEl) {
      if (capSummary?.maxAdjustableTokens != null) {
        ctxCapRangeEl.textContent = `${fmt(capSummary.rangeMin || CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(capSummary.maxAdjustableTokens)} tokens`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapRangeEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
          ? `运行策略未知（模型理论上限 ${fmt(capSummary.modelTheoreticalMaxTokens)}）`
          : `运行策略未知（工程范围 ${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}）`;
      } else {
        ctxCapRangeEl.textContent = `${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}（模型上限未知）`;
      }
    }
    if (ctxCapFormulaEl) {
      const parts = [];
      if (capSummary?.sources?.length) {
        const srcText = capSummary.sources.map(s => (s === 'get_available_models' ? 'GetAvailableModels 目录' : (s === 'step_model_info' ? '会话 Step ModelInfo' : s))).join(' + ');
        parts.push(`来源：${srcText}`);
      }
      if (capSummary?.formulaNote) {
        parts.push(capSummary.formulaNote);
      } else {
        parts.push('尚未获取到当前账号/步骤的模型窗口与最大输出元数据（不按模型名称推测上限）。');
      }
      if (capSummary?.policyNote) {
        parts.push(capSummary.policyNote);
      }
      if (capSummary?.hasTierVariance) {
        parts.push('注意：该模型不同力度档位报告了不同容量/最大输出，可调上限取安全交集，详情见下方「档位能力」。');
      }
      if (runtimePolicy?.diskVsRuntimeMismatch) {
        parts.push('磁盘配置与运行中进程尚未确认一致：以下预测与默认预算均按未确认处理，请勿当作已实机生效。');
      }
      ctxCapFormulaEl.textContent = parts.join('；');
    }
    if (ctxRefSavedEl) {
      const targetSavedLabel = getContextScopeMode() === 'unified'
        ? formatSavedPrefLabel(contextUnifiedPreference)
        : pState.displayText;
      ctxRefSavedEl.textContent = targetSavedLabel;
    }
    if (ctxRefSentEl) {
      ctxRefSentEl.textContent = evalResult.requestText || '尚无本次验证';
    }
    if (ctxRefAdoptedEl) {
      ctxRefAdoptedEl.textContent = evalResult.observedText || '尚无本次验证';
    }

    if (ctxUnifiedProjEl) {
      if (getContextScopeMode() === 'unified' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const allProducts = getKnownModelProducts().filter(p => p.inAccountCatalog);
        const projections = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, allProducts, currentUnlockStatus, state.modelCapabilitiesById || null);
        if (projections.length > 0 && typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxUnifiedProjEl.replaceChildren === 'function') {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'ctx-unified-proj-title';
          titleDiv.textContent = '统一模式各模型预计采用预算（预测值，非实机已确认）：';
          const rowNodes = [titleDiv];
          for (const pr of projections.slice(0, 8)) {
            const row = document.createElement('div');
            const isWarnRow = pr.outcome === 'clamped_to_model_max' || pr.outcome === 'exceeds_client_policy' || pr.outcome === 'clamped_by_client_policy' || pr.outcome === 'pending_restart_unconfirmed' || pr.outcome === 'partial_policy_unconfirmed' || pr.outcome === 'runtime_unconfirmed';
            row.className = `ctx-unified-proj-row${isWarnRow ? ' is-clamped' : ''}`;
            const lbl = document.createElement('span');
            lbl.textContent = pr.productLabel;
            const val = document.createElement('strong');
            if (pr.outcome === 'clamped_to_model_max') {
              val.textContent = `受模型上限限制 -> 预计 ${fmt(pr.projectedTokens)}（最大可用）`;
            } else if (pr.outcome === 'exceeds_client_policy') {
              val.textContent = `超出当前客户端限制 -> 预计仅保底 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'clamped_by_client_policy') {
              val.textContent = `受当前客户端限制 -> 预计 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'pending_restart_unconfirmed') {
              val.textContent = '待验证（磁盘已改，客户端未重启）';
            } else if (pr.outcome === 'runtime_unconfirmed') {
              val.textContent = '待验证（运行中进程未确认）';
            } else if (pr.outcome === 'partial_policy_unconfirmed') {
              val.textContent = '未知（客户端处于部分异常状态）';
            } else if (pr.outcome === 'unknown_policy') {
              val.textContent = '未知（运行策略待读取）';
            } else if (pr.outcome === 'unknown_cap') {
              val.textContent = '模型上限未知';
            } else if (pr.outcome === 'client_default' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（当前策略默认）`;
            } else if (pr.outcome === 'dynamic_follow' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（Dynamic 默认）`;
            } else if (pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens`;
            } else {
              val.textContent = '待验证';
            }
            row.appendChild(lbl);
            row.appendChild(val);
            rowNodes.push(row);
          }
          ctxUnifiedProjEl.replaceChildren(...rowNodes);
          ctxUnifiedProjEl.hidden = false;
        } else {
          ctxUnifiedProjEl.hidden = true;
        }
      } else {
        ctxUnifiedProjEl.hidden = true;
      }
    }

    if (ctxCardTierCapsRowEl && ctxCardTierCapsEl) {
      if (capSummary?.tierDetails?.length) {
        ctxCardTierCapsRowEl.hidden = false;
        const lines = capSummary.tierDetails.map(td => {
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || '标准');
          const winTxt = td.maxTokens ? `窗口 ${fmt(td.maxTokens)}` : '窗口未知';
          const outTxt = td.maxOutputTokens != null ? `最大输出 ${fmt(td.maxOutputTokens)}` : '输出未知';
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? `可调上限 ${fmt(td.maxTokens - td.maxOutputTokens)}`
            : '上限未知';
          return `${tierName}：${winTxt} / ${outTxt} / ${maxInTxt}`;
        });
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardTierCapsEl.replaceChildren === 'function') {
          ctxCardTierCapsEl.replaceChildren(...lines.map(l => {
            const d = document.createElement('div');
            d.textContent = l;
            return d;
          }));
        } else {
          ctxCardTierCapsEl.textContent = lines.join(' | ');
        }
      } else {
        ctxCardTierCapsRowEl.hidden = true;
      }
    }

    // 1. 目标值（已保存）
    if (ctxCardSavedEl) {
      ctxCardSavedEl.textContent = pState.displayText;
      ctxCardSavedEl.title = (pState.pref?.mode === 'fixed' && pState.pref.limitTokens)
        ? `${fmt(pState.pref.limitTokens)} tokens`
        : '';
    }

    // 2. 本次请求携带值
    if (ctxCardRequestEl) {
      ctxCardRequestEl.textContent = evalResult.requestText;
      ctxCardRequestEl.title = evalResult.requestText;
    }

    // 3. 对应会话
    if (ctxCardConvoEl) {
      ctxCardConvoEl.textContent = evalResult.convoId;
      ctxCardConvoEl.title = evalResult.convoId;
    }

    // 4. 生效诊断
    if (ctxCardDiagnosisEl) {
      ctxCardDiagnosisEl.textContent = evalResult.diagnosis;
      ctxCardDiagnosisEl.title = evalResult.diagnosis;
      ctxCardDiagnosisEl.className = `ctx-metric-value ctx-metric-diagnosis-val is-${evalResult.status}`;
    }

    // 5. 底座引擎（严格区分磁盘配置与当前运行进程已加载状态）
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCardClientEl) {
      if (unlockStatusFetchError) {
        ctxCardClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCardClientEl.textContent = t('status.badge.reading');
      } else if (runtimePolicy?.runtimeState === 'pending_restart') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（待重启生效）`;
      } else if (runtimePolicy?.runtimeState === 'runtime_unconfirmed') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（运行态未确认）`;
      } else if (runtimePolicy?.runtimeState === 'partial') {
        ctxCardClientEl.textContent = '部分异常（请核对客户端状态）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'dynamic') {
        ctxCardClientEl.textContent = '动态跟随已确认运行（各模型独立）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCardClientEl.textContent = `固定单一上限模式 (${formatKShort(runtimePolicy.currentClientLimitTokens)}，建议升级为动态跟随)`;
      } else {
        ctxCardClientEl.textContent = describeClientModeValue(currentUnlockStatus);
      }
    }
    if (ctxCardClientTagEl) {
      if (unlockStatusFetchError || !currentUnlockStatus) {
        ctxCardClientTagEl.hidden = true;
      } else {
        ctxCardClientTagEl.hidden = false;
        ctxCardClientTagEl.textContent = statusInfo.badge;
        ctxCardClientTagEl.className = `key-pill ${statusInfo.pillClass}`;
      }
    }

    // 6. 实测预算 + 独立 serviceLimit
    const { latestBudgetObs, latestServiceLimitObs } = findLatestProductObservation(product);
    const preObs = findPreRestartBudgetForProduct(product);
    if (ctxCardObservedBudgetEl) {
      if (pendingRestartVerification && !latestBudgetObs && preObs) {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedWaitRestart');
        ctxCardObservedBudgetEl.title = '';
      } else if (latestBudgetObs?.budget > 0) {
        const effTxt = latestBudgetObs.effort ? ` · ${formatEffortZh(latestBudgetObs.effort)}` : '';
        const tTxt = latestBudgetObs.ts ? ` · ${formatMonthDayTime(latestBudgetObs.ts)}` : '';
        ctxCardObservedBudgetEl.textContent = `${formatKShort(latestBudgetObs.budget)}${effTxt}${tTxt}`;
        ctxCardObservedBudgetEl.title = t('models.card.observedTitle', { val: fmt(latestBudgetObs.budget) });
      } else {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedBudgetNone');
        ctxCardObservedBudgetEl.title = '';
      }
    }
    if (ctxCardPreRestartBudgetEl) {
      if (!latestBudgetObs && preObs?.budget > 0) {
        const effTxt = preObs.effort ? ` · ${formatEffortZh(preObs.effort)}` : '';
        const tTxt = preObs.ts ? ` · ${formatMonthDayTime(preObs.ts)}` : '';
        ctxCardPreRestartBudgetEl.textContent = `${t('models.card.preRestartTitle', { val: formatKShort(preObs.budget) }).replace(/ tokens$/, '')}${effTxt}${tTxt}`;
        ctxCardPreRestartBudgetEl.title = t('models.card.preRestartTitle', { val: fmt(preObs.budget) });
        ctxCardPreRestartBudgetEl.hidden = false;
      } else {
        ctxCardPreRestartBudgetEl.title = '';
        ctxCardPreRestartBudgetEl.hidden = true;
      }
    }
    if (ctxCardServiceLimitEl) {
      if (latestServiceLimitObs?.serviceLimit > 0) {
        const tTxt = latestServiceLimitObs.ts ? `（${formatMonthDayTime(latestServiceLimitObs.ts)}）` : '';
        ctxCardServiceLimitEl.textContent = `${t('models.card.serviceLimit', { val: formatKShort(latestServiceLimitObs.serviceLimit) })}${tTxt}`;
        ctxCardServiceLimitEl.title = t('models.card.serviceLimitTitle', { val: fmt(latestServiceLimitObs.serviceLimit) });
        ctxCardServiceLimitEl.hidden = false;
      } else {
        ctxCardServiceLimitEl.title = '';
        ctxCardServiceLimitEl.hidden = true;
      }
    }

    // 7. 实测速度（按档位逐行显示中位数、样本数、时间，不跨档位借用）
    if (ctxCardObservedSpeedEl) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const summaryRows = typeof summarizeSpeedByModel === 'function'
        ? summarizeSpeedByModel(mergedCalls, { days: 'all', cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] })
        : [];
      const summaryByExact = new Map(summaryRows.map(r => [r.modelExactId, r]));
      const members = product.members?.length ? product.members : [{ modelId: product.productKey, label: product.productLabel, effort: null }];
      const lines = [];
      for (const m of members) {
        const stat = summaryByExact.get(m.modelId);
        const prefix = m.effort ? `${formatEffortZh(m.effort)} ` : '';
        if (stat && stat.medianTps != null) {
          const tStr = stat.maxTs ? ` · ${formatMonthDayTime(stat.maxTs)}` : '';
          const lowNote = stat.lowSample ? t('models.card.lowSampleParen') : '';
          lines.push(t('models.card.speedLineText', { prefix, tps: stat.medianTps, count: stat.count, low: lowNote, ts: tStr }));
        } else {
          lines.push(`${prefix}${t('models.card.observedSpeedNone')}`);
        }
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardObservedSpeedEl.replaceChildren === 'function') {
        const lineNodes = lines.map(txt => {
          const d = document.createElement('div');
          d.textContent = txt;
          return d;
        });
        ctxCardObservedSpeedEl.replaceChildren(...lineNodes);
      } else {
        ctxCardObservedSpeedEl.textContent = lines.join(' | ');
      }
    }

    // 8. 提示规则与 Notice 说明
    if (ctxCardHintsEl) {
      const hints = [];
      if (product.notice) {
        const nText = typeof product.notice === 'string' ? product.notice : (product.notice.message || JSON.stringify(product.notice));
        hints.push(`模型提示：${nText}`);
      }
      if (product.unavailable && product.unavailabilityReason) {
        hints.push(`不可用原因：${product.unavailabilityReason}`);
      } else if (product.partialUnavailable && product.unavailabilityReason) {
        hints.push(`部分档位受限：${product.unavailabilityReason}`);
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens &&
        pState.pref &&
        !(pState.pref.mode === 'fixed' && Number(pState.pref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      ) {
        hints.push(t('models.card.hintDiffClient'));
      }
      if (pState.pref?.mode === 'dynamic') {
        hints.push(t('models.validation.dynamicDesc'));
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens > 0 &&
        latestBudgetObs?.budget > 0 &&
        latestBudgetObs.budget < currentUnlockStatus.configuredLimitTokens
      ) {
        hints.push(t('models.card.hintBelowSet'));
      }
      if (hints.length > 0) {
        ctxCardHintsEl.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardHintsEl.replaceChildren === 'function') {
          const nodes = hints.map(h => {
            const div = document.createElement('div');
            div.className = 'ctx-card-hint-item';
            div.textContent = h;
            return div;
          });
          ctxCardHintsEl.replaceChildren(...nodes);
        } else {
          ctxCardHintsEl.textContent = hints.join(' ');
        }
      } else {
        ctxCardHintsEl.hidden = true;
      }
    }

    // 9. 精简主界面展示：当前模式、当前模型、目标设置与状态
    if (ctxSummaryModeEl) {
      ctxSummaryModeEl.textContent = contextScopeMode === 'unified'
        ? (t('models.mode.unifiedTitle') || '所有模型统一设置')
        : (t('models.mode.perModelTitle') || '按模型分别设置');
    }
    if (ctxSummaryModelEl) {
      if (contextScopeMode === 'unified') {
        ctxSummaryModelEl.textContent = t('models.summary.unifiedTarget') || '所有模型（统一生效）';
      } else if (activeSessionModelConfirmed && activeSessionProductKey === product.productKey) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else if (activeSessionModelConfirmed && activeSessionProductKey) {
        const cur = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
        ctxSummaryModelEl.textContent = cur ? cur.productLabel : product.productLabel;
      } else if (product) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else {
        ctxSummaryModelEl.textContent = '待确认';
      }
    }
    if (ctxSummaryLengthEl) {
      ctxSummaryLengthEl.textContent = evalResult.targetText;
    }
    if (ctxSummaryStatusPillEl) {
      if (needsRestartAfterApply) {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = t('models.summary.pendingRestart') || '待重启生效';
        ctxSummaryStatusPillEl.className = 'key-pill pill-warn';
      } else {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = evalResult.badge;
        ctxSummaryStatusPillEl.className = `key-pill ${evalResult.pillClass}`;
      }
    }

    if (btnSaveModelCtx) btnSaveModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
    if (btnResetModelCtx) btnResetModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
  }

  function renderPresetSelectionUI() {
    const targetMode = ctxDraft.mode;
    const targetLimit = ctxDraft.limitTokens;
    const isUnified = contextScopeMode === 'unified';
    const currentProd = isUnified ? null : getSelectedProductObj();
    const capSummary = currentProd ? getProductCapabilitySummary(currentProd) : null;
    const knownEnvMax = (!isUnified && capSummary?.maxAdjustableTokens != null) ? capSummary.maxAdjustableTokens : null;
    const knownModelMax = (!isUnified && capSummary?.modelTheoreticalMaxTokens != null) ? capSummary.modelTheoreticalMaxTokens : null;
    const rp = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const policyKnown = Boolean(rp?.policyKnown);

    if (ctxPresetModelMaxSubEl) {
      if (isUnified) {
        ctxPresetModelMaxSubEl.textContent = '统一模式下各模型不同（已禁用）';
      } else if (knownEnvMax != null) {
        ctxPresetModelMaxSubEl.textContent = `当前环境最大可采纳：${fmt(knownEnvMax)} tokens`;
      } else if (!policyKnown && knownModelMax != null) {
        ctxPresetModelMaxSubEl.textContent = `运行策略未确认（模型理论上限 ${fmt(knownModelMax)}，暂不可用）`;
      } else {
        ctxPresetModelMaxSubEl.textContent = '模型元数据待获取（暂不可用）';
      }
    }

    const btns = ctxPresetGrid?.children || [];
    const applyPresetState = btn => {
      if (!btn) return;
      const bMode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode;
      const bLimRaw = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
      const bLim = bLimRaw ? Number(bLimRaw) : null;

      let disabled = false;
      let disableReason = '';
      if (bMode === 'model_max') {
        if (isUnified) {
          disabled = true;
          disableReason = '统一模式下各模型最大可用上限不同，请切换到按模型分别设置或填写具体数值。';
        } else if (knownModelMax == null) {
          disabled = true;
          disableReason = '尚未获取到该模型的上下文窗口与最大输出元数据，无法计算最大可用值。';
        } else if (!policyKnown || knownEnvMax == null) {
          disabled = true;
          disableReason = '当前客户端运行策略未知或待重启确认，暂无法确定当前环境最大可用上限。';
        }
      } else if (bMode === 'fixed' && bLim && knownModelMax != null && bLim > knownModelMax) {
        disabled = true;
        disableReason = `预设 ${fmt(bLim)} 超出当前模型理论输入上限 ${fmt(knownModelMax)}（总窗口 - 最大输出）。`;
      }

      if ('disabled' in btn) btn.disabled = disabled;
      if (btn.classList) {
        if (disabled) btn.classList.add('is-disabled');
        else btn.classList.remove('is-disabled');
      }
      if ('title' in btn) btn.title = disableReason;

      const matched = !disabled && (
        (bMode === 'model_max' && targetMode === 'fixed' && knownEnvMax != null && targetLimit === knownEnvMax) ||
        (bMode === targetMode && (targetMode !== 'fixed' || bLim === targetLimit))
      );
      if (btn.classList) {
        if (matched) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      btn.setAttribute?.('aria-pressed', String(Boolean(matched)));
    };
    if (typeof ctxPresetGrid?.querySelectorAll === 'function') {
      const list = ctxPresetGrid.querySelectorAll('.ctx-preset-btn');
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) applyPresetState(list[i]);
      }
    } else if (Array.isArray(btns)) {
      for (const b of btns) applyPresetState(b);
    }

    if (ctxCustomInput && 'value' in ctxCustomInput) {
      if (targetMode === 'dynamic') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phFollow');
      } else if (targetMode === 'default') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phDefault');
      } else if (targetLimit != null) {
        const cleanVal = String(targetLimit);
        if (ctxCustomInput.value !== cleanVal && !ctxDraftDirty) {
          ctxCustomInput.value = cleanVal;
        }
      }
    }
    updateValidationMessageUI();
  }

  function updateValidationMessageUI() {
    if (!ctxValidationEl) return;
    if (ctxDraft.mode === 'dynamic') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = t('models.validation.dynamicDesc');
      return;
    }
    if (ctxDraft.mode === 'default') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = '恢复客户端默认：请求将清除 maxTokenLimit 覆盖，由当前语言服务全局模式决定（若已开 Dynamic 则按动态默认）。';
      return;
    }
    const rawVal = ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== ''
      ? ctxCustomInput.value
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawVal, 'fixed');
    if (!val.ok) {
      ctxValidationEl.className = 'ctx-validation-msg is-error';
      ctxValidationEl.textContent = val.error;
      return;
    }
    if (val.warnings && val.warnings.length > 0) {
      ctxValidationEl.className = 'ctx-validation-msg is-warn';
      ctxValidationEl.textContent = val.warnings.join(' ');
      return;
    }
    ctxValidationEl.className = 'ctx-validation-msg';
    ctxValidationEl.textContent = t('models.input.validFixed', { short: formatKShort(val.limitTokens), full: fmt(val.limitTokens) });
  }

  function loadDraftFromSelectedModel(forceResetDraft = false) {
    if (!ctxDraftDirty || forceResetDraft) {
      if (contextScopeMode === 'unified') {
        const pref = contextUnifiedPreference;
        if (pref && pref.mode) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          ctxDraft = { mode: 'default', limitTokens: null };
        }
      } else {
        const prod = getSelectedProductObj();
        const pState = resolveProductPreferenceState(prod);
        const pref = pState.pref;
        if (pref) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          const rp = resolveRuntimeUnlockPolicyClient();
          if (rp?.policyKnown && rp.runtimeMode !== 'unknown' && rp.runtimeMode !== 'partial') {
            ctxDraft = {
              mode: rp.runtimeMode,
              limitTokens: rp.runtimeMode === 'fixed' ? (rp.currentClientLimitTokens ?? null) : null
            };
          } else {
            ctxDraft = { mode: 'default', limitTokens: null };
          }
        }
      }
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) {
        ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
      }
    }
    renderModelSettingsTab();
    renderPresetSelectionUI();
  }

  function renderModelSettingsTab() {
    const products = getKnownModelProducts();
    const currentProd = getSelectedProductObj();
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    renderCompactSessionCard();
    renderClientStatusBar();
    renderModelListGroup(products);
    renderModelDetailCard(currentProd);
    renderPresetSelectionUI();
  }

  function recordObservationFromSummary(summary, convoId, opts = {}) {
    if (!summary) return;
    const rawId = resolveStableModelKeyClient(summary);
    if (!rawId && !summary.model) return;
    const g = groupProductSafe({
      modelId: rawId || summary.model,
      label: summary.model || rawId,
      modelOrAlias: summary.modelOrAlias,
      effort: summary.effort
    });
    if (!g?.productKey) return;

    if (budgetTracker && (summary.budget > 0 || summary.serviceLimit > 0 || opts.callId)) {
      budgetTracker.recordObservation({
        convoId: convoId || state.activeConversationId || state.route || null,
        productKey: g.productKey,
        modelId: rawId || g.productKey,
        modelLabel: summary.model || g.productLabel,
        effort: g.effort || summary.effort || null,
        budget: Number(summary.budget || 0),
        serviceLimit: Number(summary.serviceLimit || 0),
        callId: opts.callId || null,
        stepCount: Number.isFinite(opts.stepCount) ? opts.stepCount : -1,
        ts: opts.ts || 0
      });
    }
  }

  function syncContextModelSelectionFromState() {
    const prevProd = activeSessionProductKey;
    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;

    // 1. 最高优先级：宿主输入框旁真实选中的模型（排除插件自身 DOM）
    const hostSelected = extractHostSelectedModel();
    let exactId = null;
    let detectedProduct = null;
    let detectedEffort = null;
    let isConfirmed = false;

    if (hostSelected && hostSelected.productKey) {
      exactId = hostSelected.modelId;
      detectedProduct = hostSelected.productKey;
      detectedEffort = hostSelected.effort;
      isConfirmed = true;
    } else if (state.latest && activeConvId) {
      // 2. 次优先级：检查 state.latest 是否属于当前活跃会话且非历史归档模型
      const candidateId = resolveStableModelKeyClient(state.latest);
      if (candidateId) {
        const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
        const matchedCfg = Array.isArray(configs) && configs.length > 0
          ? configs.find(c => (resolveStableModelKeyClient(c) || c.modelId) === candidateId)
          : null;
        const isAllowedInCatalog = Array.isArray(configs) && configs.length > 0
          ? Boolean(matchedCfg && !matchedCfg.isHistorical)
          : true;
        if (isAllowedInCatalog) {
          const g = groupProductSafe({
            modelId: candidateId,
            label: state.latest?.model || candidateId,
            modelOrAlias: state.latest?.modelOrAlias,
            effort: state.latest?.effort
          });
          exactId = candidateId;
          detectedProduct = g.productKey;
          detectedEffort = g.effort || state.latest?.effort || null;
          isConfirmed = true;
        }
      }
    }

    if (isConfirmed && exactId && detectedProduct) {
      activeSessionModelKey = exactId;
      activeSessionProductKey = detectedProduct;
      activeSessionEffort = detectedEffort;
      activeSessionModelConfirmed = true;
      // 严禁在此处用 Date.now() 伪造观测时间戳；仅当无观测记录且有明确后端快照时保留已有真实观测
    } else {
      activeSessionModelConfirmed = false;
      activeSessionModelKey = null;
      activeSessionProductKey = null;
      activeSessionEffort = null;
    }

    if (activeSessionModelConfirmed && activeSessionProductKey && (!manualModelSelection || !selectedProductKey)) {
      const switched = prevProd !== activeSessionProductKey || selectedProductKey !== activeSessionProductKey;
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey;
      if (switched) {
        ctxDraftDirty = false;
        loadDraftFromSelectedModel(true);
      }
    }
    renderHeaderModelDropdown();
    renderCompactSessionCard();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  ctxPresetGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.ctx-preset-btn');
    if (!btn || btn.disabled) return;
    const mode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode || 'default';
    const rawLim = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
    ctxDraftDirty = true;
    if (mode === 'dynamic') {
      ctxDraft = { mode: 'dynamic', limitTokens: null };
    } else if (mode === 'default') {
      ctxDraft = { mode: 'default', limitTokens: null };
    } else if (mode === 'model_max') {
      const prod = contextScopeMode === 'unified' ? null : getSelectedProductObj();
      const cap = prod ? getProductCapabilitySummary(prod) : null;
      if (!cap || !cap.runtimePolicy?.policyKnown || cap.maxAdjustableTokens == null) {
        updateValidationMessageUI();
        return;
      }
      ctxDraft = { mode: 'fixed', limitTokens: cap.maxAdjustableTokens };
    } else {
      const lim = Number(rawLim || 512000);
      ctxDraft = { mode: 'fixed', limitTokens: lim };
    }
    if (ctxCustomInput && 'value' in ctxCustomInput) {
      ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
    }
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    renderPresetSelectionUI();
  });

  ctxCustomInput?.addEventListener('input', () => {
    const rawStr = String(ctxCustomInput.value || '').trim();
    ctxDraftDirty = true;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    if (!rawStr) {
      ctxDraft = { mode: 'fixed', limitTokens: null };
      renderPresetSelectionUI();
      return;
    }
    const val = validateCustomLimitClient(rawStr, 'fixed');
    ctxDraft = {
      mode: 'fixed',
      limitTokens: val.ok ? val.limitTokens : null
    };
    renderPresetSelectionUI();
  });

  async function saveSettingsPayloadBridge(payload = {}) {
    if (window.contextMeterAPI?.saveSettings) {
      return await window.contextMeterAPI.saveSettings(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge') };
  }

  function showUnlockResultBox(isSuccess, html, opts = {}) {
    if (!unlockResultBox || !unlockResultText) return;
    unlockResultBox.style.display = 'block';
    unlockResultBox.className = `unlock-result-box ${isSuccess ? 'result-success' : 'result-error'}`;
    unlockResultText.innerHTML = html;
    const canRestartHost = Boolean(hostSupportsRestart);
    const needRestart = Boolean(opts.needsRestart);
    const showRetry = Boolean(opts.showRetry);
    if (btnUnlockResultRestart) btnUnlockResultRestart.hidden = !(needRestart && canRestartHost);
    if (btnUnlockResultRetry) btnUnlockResultRetry.hidden = !showRetry;
    if (unlockResultManual) unlockResultManual.hidden = !(needRestart && !canRestartHost);
    if (unlockResultActions) unlockResultActions.hidden = !((needRestart && canRestartHost) || showRetry);
  }

  async function saveCurrentProductDraft() {
    if (contextScopeMode === 'unified') {
      const rawLimit = ctxDraft.mode === 'fixed'
        ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
        : ctxDraft.limitTokens;
      const val = validateCustomLimitClient(rawLimit, ctxDraft.mode);
      if (!val.ok) {
        updateValidationMessageUI();
        return { ok: false, error: val.error };
      }
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference,
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraftDirty = false;
      renderModelSettingsTab();
      let notice = null;
      if (val.mode === 'fixed' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const projs = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, getKnownModelProducts().filter(p => p.inAccountCatalog), currentUnlockStatus, state.modelCapabilitiesById || null);
        const clampedModel = projs.filter(p => p.outcome === 'clamped_to_model_max');
        const clampedClient = projs.filter(p => p.outcome === 'exceeds_client_policy' || p.outcome === 'clamped_by_client_policy');
        const unconfirmed = projs.filter(p => p.outcome === 'pending_restart_unconfirmed' || p.outcome === 'runtime_unconfirmed' || p.outcome === 'partial_policy_unconfirmed' || p.outcome === 'unknown_policy');
        const msgParts = [];
        if (clampedModel.length > 0) {
          msgParts.push(`部分模型低于统一值：${clampedModel.map(c => `${c.productLabel}(上限 ${fmt(c.projectedTokens)})`).join('、')} 预计仅采用各自最大可用上限`);
        }
        if (clampedClient.length > 0) {
          msgParts.push(`当前客户端限制为 ${fmt(clampedClient[0].clientLimitTokens)} tokens，超限模型预计仅保底 ${clampedClient.map(c => `${c.productLabel}(${fmt(c.projectedTokens)})`).join('、')}`);
        }
        if (unconfirmed.length > 0) {
          msgParts.push('当前客户端运行策略尚未确认/待重启，统一值能否实机采用需后续发送请求验证');
        }
        if (msgParts.length > 0) {
          notice = `已保存统一目标 ${fmt(val.limitTokens)} tokens。注意：${msgParts.join('；')}。`;
        }
      }
      return { ok: true, prod: null, val, notice };
    }

    const prod = getSelectedProductObj();
    if (!prod) {
      return { ok: false, error: t('msg.noModelsDetected') };
    }
    const rawLimit = ctxDraft.mode === 'fixed'
      ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawLimit, ctxDraft.mode, prod);
    if (!val.ok) {
      updateValidationMessageUI();
      return { ok: false, error: val.error };
    }
    if (val.exceedsModelLimit) {
      updateValidationMessageUI();
      const capSummary = getProductCapabilitySummary(prod);
      const modelMaxCap = capSummary?.modelTheoreticalMaxTokens ?? val.adoptableTokens;
      const capText = modelMaxCap != null ? `${fmt(modelMaxCap)} tokens` : '已知模型理论上限';
      return {
        ok: false,
        error: `输入 ${fmt(val.limitTokens)} 超出 ${prod.productLabel} 模型理论输入上限 ${capText}（依据元数据：总窗口 - 最大输出）。请修改为 <= ${capText} 或重新选择合法档位，系统不会静默改写数值。`
      };
    }
    const legacyKeys = resolveProductPreferenceState(prod).legacyKeys;
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return { ok: false, stale: true };
    if (!res || !res.ok) {
      return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[prod.productKey] = {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    return { ok: true, prod, val };
  }

  btnSaveModelCtx?.addEventListener('click', async () => {
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const res = await saveCurrentProductDraft();
    if (res.stale) return;
    if (!res.ok) {
      showUnlockResultBox(false, res.error);
      return;
    }
    showUnlockResultBox(true, res.notice || t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用');
  });

  btnResetModelCtx?.addEventListener('click', async () => {
    if (contextScopeMode === 'unified') {
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: 'default',
        limitTokens: null,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference: { mode: 'default' },
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraft = { mode: 'default', limitTokens: null };
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
      renderModelSettingsTab();
      renderPresetSelectionUI();
      showUnlockResultBox(true, t('models.summary.modelDefault') || '已恢复默认值');
      return;
    }

    const prod = getSelectedProductObj();
    if (!prod) return;
    const pState = resolveProductPreferenceState(prod);
    const oldSavedPref = pState.pref;
    const clearAll = [prod.productKey, ...pState.legacyKeys];
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      clearContextPreferences: clearAll
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return;
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const k of clearAll) delete contextPreferencesMap[k];
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraft = { mode: 'default', limitTokens: null };
    ctxDraftDirty = false;
    if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    renderPresetSelectionUI();

    if (ctxResetNoticeEl) {
      const clientUsingSame = oldSavedPref && currentUnlockStatus && (
        (oldSavedPref.mode === 'dynamic' && currentUnlockStatus.configuredMode === 'dynamic') ||
        (oldSavedPref.mode === 'fixed' && currentUnlockStatus.configuredMode === 'fixed' && Number(oldSavedPref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      );
      if (clientUsingSame) {
        const curVal = describeClientModeValue(currentUnlockStatus);
        ctxResetNoticeEl.textContent = t('msg.resetStillUsing', { val: curVal });
        ctxResetNoticeEl.hidden = false;
      } else {
        ctxResetNoticeEl.hidden = true;
      }
    }
    showUnlockResultBox(true, t('msg.resetDefault'));
  });

  function setScopeMode(newMode) {
    contextScopeMode = newMode === 'per_model' ? 'per_model' : 'unified';
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    syncContextPreferencesCache(contextPreferencesMap);
    void saveSettingsPayloadBridge({ contextScopeMode });
    loadDraftFromSelectedModel(true);
    const prod = getSelectedProductObj();
    if (prod) renderModelDetailCard(prod);
  }

  btnModeUnified?.addEventListener('click', () => setScopeMode('unified'));
  btnModePerModel?.addEventListener('click', () => setScopeMode('per_model'));

  async function invokeUnlockApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getContextUnlockStatus) {
      return await window.contextMeterAPI.getContextUnlockStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyContextUnlock) {
      return await window.contextMeterAPI.applyContextUnlock(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreContextUnlock) {
      return await window.contextMeterAPI.restoreContextUnlock(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/context-unlock-${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('models.err.noApplyBridge') };
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/restart-host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: '{}'
      });
      return await r.json().catch(() => ({ ok: true, supported: false }));
    }
    return { ok: true, supported: false };
  }

  async function invokeEnhanceApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getEnhanceStatus) {
      return await window.contextMeterAPI.getEnhanceStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyEnhancePatch) {
      return await window.contextMeterAPI.applyEnhancePatch(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreAllEnhance) {
      return await window.contextMeterAPI.restoreAllEnhance(payload);
    }
    if (endpoint === 'restart-ls' && window.contextMeterAPI?.restartLanguageServers) {
      return await window.contextMeterAPI.restartLanguageServers(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const routeMap = {
        status: '/enhance-status',
        apply: '/enhance-apply',
        restore: '/enhance-restore',
        'restart-ls': '/restart-language-servers'
      };
      const path = routeMap[endpoint];
      if (path) {
        const r = await fetch(`http://127.0.0.1:${live.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(payload)
        });
        return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      }
    }
    return { ok: false, error: t('enhance.result.noBridge'), unavailable: true };
  }

  async function invokeModulesApi(action, name, enable, opts = {}) {
    if (action === 'status' && window.contextMeterAPI?.getModulesStatus) {
      return await window.contextMeterAPI.getModulesStatus();
    }
    if (action === 'toggle' && window.contextMeterAPI?.toggleModule) {
      return await window.contextMeterAPI.toggleModule(name, enable, opts);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const route = action === 'status' ? '/modules-status' : '/toggle-module';
      const body = action === 'status' ? {} : { name, enable, opts };
      const r = await fetch(`http://127.0.0.1:${live.port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(body)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
  }

  async function refreshUnlockStatus() {
    const thisSeq = ++unlockReqSeq;
    try {
      const currentObservedBudget = (state.latest?.budget && state.latest.budget > 0)
        ? state.latest.budget
        : undefined;
      const res = await invokeUnlockApi('status', { currentBudget: currentObservedBudget });
      if (thisSeq !== unlockReqSeq) return;

      if (!res || !res.ok || !res.data) {
        unlockStatusFetchError = true;
        currentUnlockStatus = null;
        if (unlockStatusDesc) unlockStatusDesc.textContent = t('status.client.unavailable');
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
        return;
      }

      unlockStatusFetchError = false;
      const data = res.data;
      currentUnlockStatus = data;
      lastPartialReason = data.partialMatchReason || data.error || '';
      if (typeof data.hostSupportsRestart === 'boolean') {
        hostSupportsRestart = data.hostSupportsRestart;
      }
      if (data.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
      } else if (data.status === 'patched_loaded' || data.status === 'not_patched') {
        needsRestartAfterApply = false;
      }

      // 重启后校验核对
      if (pendingRestartVerification) {
        if (data.runtimeEvidence?.restartDetected === true) {
          if (data.status === 'patched_loaded' && doesClientMatchVerification(data, pendingRestartVerification)) {
            restartMismatchNotice = '';
          } else {
            restartMismatchNotice = t('models.status.restartMismatch', { actual: describeClientModeValue(data) });
          }
          pendingRestartVerification = null;
          void saveSettingsPayloadBridge({ uiPreferences: { restartVerification: null } });
        }
      }

      const statusInfo = mapUnlockDisplayStatus(data);
      if (unlockStatusDesc) {
        unlockStatusDesc.textContent = t('models.status.line', { badge: statusInfo.badge, mode: describeClientModeValue(data) });
      }
      if (unlockMetaMode) {
        unlockMetaMode.textContent = `${describeClientModeValue(data)}（${statusInfo.badge}）`;
      }
      if (unlockMetaTarget) {
        unlockMetaTarget.textContent = data.arch ? t('models.meta.targetDesktopArch', { arch: data.arch }) : t('models.meta.targetDesktop');
      }
      if (unlockMetaArch) unlockMetaArch.textContent = data.arch || t('models.meta.archUnknown');
      if (unlockMetaBackup) {
        unlockMetaBackup.textContent = data.hasBackup
          ? (data.backupStaleReason ? t('models.meta.backupStale') : t('models.meta.backupReady'))
          : t('models.meta.backupNone');
      }

      if (btnApplyUnlock) {
        const writableStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
        if (writableStatuses.has(data.status) && (!data.arch || data.arch === 'x86-64')) {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.saveApply');
        } else if (data.status === 'partial_match') {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.partialBlocked');
        } else if (data.status === 'failed') {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.retryApply');
        } else {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.unsupported');
        }
      }

      if (btnRestoreUnlock) {
        btnRestoreUnlock.disabled = !(
          (data.hasBackup && data.backupValidForCurrentBinary !== false) ||
          data.hasMatchingGate3BSidecar ||
          (data.status && data.status !== 'not_patched' && data.status !== 'unsupported')
        );
      }

      if (data.status === 'partial_match' && unlockResultBox && (!unlockResultBox.style.display || unlockResultBox.style.display === 'none')) {
        showUnlockResultBox(
          false,
          t('models.card.partialFailDetail', { reason: translateBackendText(lastPartialReason) || '' }),
          { showRetry: true }
        );
      }

      if (!ctxDraftDirty && !resolveProductPreferenceState(getSelectedProductObj()).pref) {
        loadDraftFromSelectedModel(false);
      } else {
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    } catch {
      if (thisSeq !== unlockReqSeq) return;
      unlockStatusFetchError = true;
      currentUnlockStatus = null;
      renderCompactSessionCard();
      renderClientStatusBar();
    }
  }

  btnRefreshUnlock?.addEventListener('click', () => {
    void refreshUnlockStatus();
  });

  btnApplyUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const saved = await saveCurrentProductDraft();
    if (saved.stale) return;
    if (!saved.ok) {
      showUnlockResultBox(false, saved.error);
      return;
    }

    isUnlocking = true;
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    needsRestartAfterApply = false;
    restartMismatchNotice = '';

    try {
      // ELV-41: 底座统一应用为动态透传模式 (mov esi, edx)，使各模型设置能够独立生效，绝不把单一模型的数值固化进二进制
      const res = await invokeUnlockApi('apply', {
        mode: 'dynamic',
        limitTokens: null,
        serviceLimit: state.latest?.serviceLimit || undefined
      });
      if (!res || !res.ok) {
        needsRestartAfterApply = false;
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error), { showRetry: true });
        return;
      }
      if (res.needsRestart === true) {
        needsRestartAfterApply = true;
        showUnlockResultBox(true, t('msg.appliedRestart'), { needsRestart: true });
      } else if (res.alreadyMatched) {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '底座引擎已处于动态跟随状态。当前模型设置已保存，下一次发送时尝试应用。');
      } else {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '已应用底座配置。当前模型设置已保存，下一次发送时尝试应用。');
      }
    } catch (e) {
      needsRestartAfterApply = false;
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
      if (!needsRestartAfterApply && currentUnlockStatus?.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
    }
  });

  let isRestartInProgress = false;

  async function executeClientRestart(fromModal = false) {
    if (isRestartInProgress) return;
    isRestartInProgress = true;
    if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = true;
    if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = true;

    // 记录重启前的观测快照（不保存草稿）
    try {
      const obsObj = budgetTracker ? { ...budgetTracker.exportAllObservationsByProduct() } : {};
      for (const [mid, val] of observedByModelId.entries()) obsObj[mid] = val;
      preRestartSnapshot = { requestedAt: new Date().toISOString(), observations: obsObj };
      localStorage?.setItem(CTX_PRE_RESTART_OBS_KEY, JSON.stringify(preRestartSnapshot));
    } catch {}

    const feedbackEl = fromModal ? modalRestartFeedback : (modalRestartFeedback || ctxRestartFeedback);
    if (feedbackEl) {
      feedbackEl.textContent = t('client.restart.triggering');
      feedbackEl.hidden = false;
    }

    const res = await invokeRestartHostApi();
    if (!res || res.supported === false) {
      hostSupportsRestart = false;
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.hostNotSupported');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      renderClientStatusBar();
      return;
    }
    if (res.ok === false) {
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.failed', { err: translateBackendText(res.error) || t('msg.unknownErr') });
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      return;
    }

    if (feedbackEl) {
      feedbackEl.textContent = t('models.restart.restarting');
      feedbackEl.hidden = false;
    }
    if (restartTimeoutTimer) clearTimeout(restartTimeoutTimer);
    restartTimeoutTimer = setTimeout(() => {
      if (!state.disposed && feedbackEl) {
        feedbackEl.textContent = t('models.restart.notExited');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
    }, 15000);
  }

  function openClientRestartConfirmFlow() {
    if (!hostSupportsRestart) {
      showUnlockResultBox(true, t('client.restart.hostNotSupported'), { needsRestart: true });
      return;
    }
    if (globalRestartModal) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = '';
        modalRestartFeedback.hidden = true;
      }
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      isRestartInProgress = false;
      globalRestartModal.hidden = false;
      return;
    }
    if (ctxRestartConfirm) {
      ctxRestartConfirm.hidden = false;
      if (ctxRestartFeedback) ctxRestartFeedback.hidden = true;
    }
  }

  btnRestartHost?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRestart?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRetry?.addEventListener('click', () => {
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    void refreshUnlockStatus();
  });

  btnModalRestartCancel?.addEventListener('click', () => {
    if (globalRestartModal) globalRestartModal.hidden = true;
  });
  globalRestartModal?.addEventListener('click', (e) => {
    if (e.target === globalRestartModal) {
      globalRestartModal.hidden = true;
    }
  });

  btnModalRestartConfirm?.addEventListener('click', () => executeClientRestart(true));

  btnRestartCancel?.addEventListener('click', () => {
    if (ctxRestartConfirm) ctxRestartConfirm.hidden = true;
  });

  btnRestartConfirmGo?.addEventListener('click', () => executeClientRestart(false));

  btnRestoreUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    isUnlocking = true;
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';

    try {
      const res = await invokeUnlockApi('restore');
      if (!res || !res.ok) {
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error || t('msg.restoreFail')), { showRetry: true });
        return;
      }
      needsRestartAfterApply = true;
      showUnlockResultBox(true, t('msg.restoredRestart'), { needsRestart: true });
    } catch (e) {
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
    }
  });

  // -----------------------------------------------------------------------
  // 速度对比分页与纯 SVG 图表渲染
  // -----------------------------------------------------------------------
  function isValidSpeedSampleSafe(c) {
    if (typeof isValidSpeedSample === 'function') return isValidSpeedSample(c);
    return Boolean(c && c.status === 'final' && !c.estimated && Number(c.outputTokens) > 0 && Number(c.durationSec) > 0 && Number(c.tps) > 0);
  }

  function mergeAvailableSpeedCalls() {
    const byId = new Map();
    const hist = Array.isArray(ANTIGRAVITY_TOKEN_DATA.speedRecords) ? ANTIGRAVITY_TOKEN_DATA.speedRecords : [];
    for (const r of hist) {
      if (r && r.callId) byId.set(r.callId, r);
    }
    const cur = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    for (const r of cur) {
      if (!r || !r.callId) continue;
      const prev = byId.get(r.callId);
      if (!prev || (!isValidSpeedSampleSafe(prev) && isValidSpeedSampleSafe(r)) || Number(r.outputTokens || 0) > Number(prev.outputTokens || 0)) {
        byId.set(r.callId, r);
      }
    }
    return Array.from(byId.values());
  }

  function createSvgEl(tag, attrs = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    const node = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
      : (typeof doc.createElement === 'function' ? doc.createElement(tag) : null);
    if (!node) return null;
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && typeof node.setAttribute === 'function') node.setAttribute(k, String(v));
    }
    return node;
  }

  function renderSpeedBarChart(groups) {
    const svg = el('speed-bar-svg');
    const wrap = el('speed-bar-chart-wrap');
    const emptyEl = el('speed-bar-empty');
    const tooltip = el('speed-bar-tooltip');
    const titleEl = el('speed-bar-title');

    const metricTitleMap = { tps: t('speed.barTitle.tps'), ttft: t('speed.barTitle.ttft'), duration: t('speed.barTitle.duration') };
    if (titleEl) titleEl.textContent = metricTitleMap[speedMetric] || t('speed.barTitle.tps');

    if (!groups.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const rowH = 34;
    const padTop = 8;
    const padBottom = 10;
    const labelW = 148;
    const valW = 86;
    const barAreaW = width - labelW - valW - 12;
    const height = padTop + padBottom + groups.length * rowH;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const getVal = g => speedMetric === 'ttft' ? g.medianTtft : speedMetric === 'duration' ? g.medianDuration : g.medianTps;
    const maxVal = Math.max(...groups.map(g => getVal(g) || 0), 0.1);

    const nodes = [];
    groups.forEach((g, idx) => {
      const y = padTop + idx * rowH;
      const val = getVal(g) || 0;
      const w = Math.max(4, (val / maxVal) * barAreaW);
      const effText = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
      const displayLabel = `${g.productLabel}${effText}`;
      const unitStr = speedMetric === 'tps' ? `${val} tok/s` : t('speed.unitSec', { val });

      const rowGrp = createSvgEl('g', { style: 'cursor:pointer' });
      const bgHit = createSvgEl('rect', { x: 0, y, width, height: rowH - 4, rx: 4, fill: 'transparent' });
      const dot = createSvgEl('circle', {
        cx: 7,
        cy: y + 14,
        r: 3.5,
        fill: VENDOR_DOT_COLORS[g.vendor] || '#8a8a94'
      });
      const lbl = createSvgEl('text', {
        x: 15,
        y: y + 18,
        fill: 'var(--ag-text-primary, #ececef)',
        'font-size': '10.5'
      });
      if (lbl) lbl.textContent = displayLabel.length > 20 ? displayLabel.slice(0, 19) + '…' : displayLabel;

      const track = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: barAreaW,
        height: 14,
        rx: 3,
        fill: 'var(--ag-track-bg, rgba(255,255,255,0.08))'
      });
      const bar = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: w.toFixed(1),
        height: 14,
        rx: 3,
        fill: VENDOR_DOT_COLORS[g.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        opacity: g.lowSample ? '0.45' : '0.92'
      });
      const valTxt = createSvgEl('text', {
        x: labelW + barAreaW + 6,
        y: y + 18,
        fill: g.lowSample ? 'var(--ag-text-muted, #8a8a94)' : 'var(--ag-text-secondary, #c8c8d0)',
        'font-size': '10'
      });
      if (valTxt) valTxt.textContent = `${unitStr}${g.lowSample ? ` ${t('speed.lowSample')}` : ''}`;

      if (rowGrp) {
        if (bgHit) rowGrp.appendChild(bgHit);
        if (dot) rowGrp.appendChild(dot);
        if (lbl) rowGrp.appendChild(lbl);
        if (track) rowGrp.appendChild(track);
        if (bar) rowGrp.appendChild(bar);
        if (valTxt) rowGrp.appendChild(valTxt);
        rowGrp.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const rangeTxt = g.minTs && g.maxTs
            ? `${formatMonthDayTime(g.minTs)} ~ ${formatMonthDayTime(g.maxTs)}`
            : '—';
          tooltip.innerHTML =
            `<strong>${displayLabel}</strong><br>` +
            `${t('speed.tip.samples', { n: g.count, low: g.lowSample ? t('models.card.lowSampleParen') : '' })}<br>` +
            `${t('speed.tip.timeRange', { range: rangeTxt })}<br>` +
            `${t('speed.tip.medOut', { val: fmt(g.medianOutputTokens) })}<br>` +
            `${t('speed.tip.medIn', { val: fmt(g.medianInputTokens) })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = `${Math.max(4, y - 4)}px`;
            tooltip.style.right = '8px';
          }
        });
        rowGrp.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        rowGrp.addEventListener?.('click', () => {
          selectedSpeedExactModelId = g.modelExactId;
          renderSpeedComparisonTab();
        });
        nodes.push(rowGrp);
      }
    });
    svg.replaceChildren(...nodes);
  }

  function renderSpeedLineChart(selectedGroup) {
    const svg = el('speed-line-svg');
    const wrap = el('speed-line-chart-wrap');
    const emptyEl = el('speed-line-empty');
    const tooltip = el('speed-line-tooltip');

    const samples = (selectedGroup?.samples || []).filter(s => s && s.tps > 0);
    if (!samples.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const height = 148;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const maxTps = Math.max(...samples.map(s => Number(s.tps) || 0), 10);
    const minTps = Math.max(0, Math.min(...samples.map(s => Number(s.tps) || 0)) * 0.8);
    const spanTps = Math.max(1, maxTps - minTps);

    const nodes = [];
    // Y 轴参考线与刻度
    [0, 0.5, 1].forEach(ratio => {
      const y = padT + plotH * (1 - ratio);
      const val = Math.round(minTps + spanTps * ratio);
      const grid = createSvgEl('line', {
        x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
        stroke: 'var(--ag-border-subtle, rgba(255,255,255,0.08))', 'stroke-width': 1
      });
      const txt = createSvgEl('text', {
        x: padL - 5, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5'
      });
      if (txt) txt.textContent = String(val);
      if (grid) nodes.push(grid);
      if (txt) nodes.push(txt);
    });

    const pts = samples.map((s, idx) => {
      const x = samples.length === 1 ? padL + plotW / 2 : padL + (idx / (samples.length - 1)) * plotW;
      const y = padT + plotH * (1 - ((Number(s.tps) - minTps) / spanTps));
      return { x, y, sample: s };
    });

    if (pts.length >= 2) {
      const dAttr = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const path = createSvgEl('path', {
        d: dAttr, fill: 'none',
        stroke: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        'stroke-width': 1.8
      });
      if (path) nodes.push(path);
    }

    pts.forEach((pt, idx) => {
      const circle = createSvgEl('circle', {
        cx: pt.x.toFixed(1),
        cy: pt.y.toFixed(1),
        r: 3.5,
        fill: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        stroke: 'var(--ag-bg-panel, #181818)',
        'stroke-width': 1.2,
        style: 'cursor:pointer'
      });
      if (circle) {
        circle.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const s = pt.sample;
          const originTxt = s.origin === 'speed-test' ? t('speed.originProbe') : t('speed.origin.chat');
          const ttftTxt = s.ttftSec != null ? t('speed.unitSec', { val: s.ttftSec }) : t('speed.unknown');
          tooltip.innerHTML =
            `<strong>${t('speed.tip.tpsLine', { idx: idx + 1, tps: s.tps })}</strong><br>` +
            `${t('speed.tip.time', { val: formatMonthDayTime(s.ts || s.createdAt) || '—' })}<br>` +
            `${t('speed.tip.output', { val: fmt(s.outputTokens) })}<br>` +
            `${t('speed.tip.ttft', { val: ttftTxt })}<br>` +
            `${t('speed.tip.origin', { val: originTxt })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = '6px';
            tooltip.style.right = '8px';
          }
        });
        circle.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        nodes.push(circle);
      }
    });

    const firstLbl = createSvgEl('text', { x: padL, y: height - 6, fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (firstLbl) firstLbl.textContent = formatMonthDayTime(samples[0].ts || samples[0].createdAt) || '#1';
    const lastLbl = createSvgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (lastLbl && samples.length > 1) lastLbl.textContent = formatMonthDayTime(samples[samples.length - 1].ts || samples[samples.length - 1].createdAt) || `#${samples.length}`;
    if (firstLbl) nodes.push(firstLbl);
    if (lastLbl) nodes.push(lastLbl);

    svg.replaceChildren(...nodes);
  }

  let lastSpeedGroups = [];

  function renderSpeedComparisonTab() {
    const mergedCalls = mergeAvailableSpeedCalls();
    const daysArg = speedRangeDays === 'all' ? 'all' : Number(speedRangeDays);
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
        days: daysArg,
        origin: speedOriginFilter,
        metric: speedMetric,
        cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
      })
      : [];
    lastSpeedGroups = groups;

    renderSpeedBarChart(groups);

    if (!selectedSpeedExactModelId || !groups.some(g => g.modelExactId === selectedSpeedExactModelId)) {
      selectedSpeedExactModelId = groups[0]?.modelExactId || null;
    }
    const chosenGroup = groups.find(g => g.modelExactId === selectedSpeedExactModelId) || null;
    const speedDropLabel = el('speed-model-dropdown-label');
    if (speedDropLabel) {
      if (chosenGroup) {
        const effStr = chosenGroup.effort ? ` (${formatEffortZh(chosenGroup.effort)})` : '';
        speedDropLabel.textContent = `${chosenGroup.productLabel}${effStr}`;
      } else {
        speedDropLabel.textContent = t('speed.lineNoModel');
      }
    }

    if (!speedModelDropdownCtrl && typeof initDropdownController === 'function' && el('speed-model-dropdown-wrap')) {
      speedModelDropdownCtrl = initDropdownController({
        wrapId: 'speed-model-dropdown-wrap',
        triggerId: 'speed-model-dropdown-trigger',
        labelId: 'speed-model-dropdown-label',
        menuId: 'speed-model-dropdown-menu',
        emptyLabel: () => t('speed.lineNoModel'),
        searchPlaceholder: () => t('dropdown.speedSearch'),
        emptyText: () => t('dropdown.speedEmpty'),
        getSelectedValue: () => selectedSpeedExactModelId || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          selectedSpeedExactModelId = val;
          renderSpeedComparisonTab();
        },
        getOptions: () => lastSpeedGroups.map(g => {
          const effStr = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
          return {
            value: g.modelExactId,
            label: `${g.productLabel}${effStr}`,
            displayRight: t('speed.samples', { n: g.count })
          };
        })
      });
    } else if (speedModelDropdownCtrl && typeof speedModelDropdownCtrl.refresh === 'function') {
      speedModelDropdownCtrl.refresh();
    }

    renderSpeedLineChart(chosenGroup);
  }

  const SPEED_RANGE_MAP = { 'speed-range-7d': '7', 'speed-range-30d': '30', 'speed-range-all': 'all' };
  const SPEED_ORIGIN_MAP = { 'speed-origin-all': 'all', 'speed-origin-chat': 'chat' };
  const SPEED_METRIC_MAP = { 'speed-metric-tps': 'tps', 'speed-metric-ttft': 'ttft', 'speed-metric-duration': 'duration' };

  function bindSpeedFilterGroup(map, onPick) {
    const ids = Object.keys(map);
    ids.forEach(id => {
      el(id)?.addEventListener('click', () => {
        const val = map[id];
        onPick(val);
        ids.forEach(k => setPillActive(el(k), map[k] === val));
        renderSpeedComparisonTab();
      });
    });
  }

  bindSpeedFilterGroup(SPEED_RANGE_MAP, v => { speedRangeDays = v; });
  bindSpeedFilterGroup(SPEED_ORIGIN_MAP, v => { speedOriginFilter = v; });
  bindSpeedFilterGroup(SPEED_METRIC_MAP, v => { speedMetric = v; });

  applyContextViewVisibility();

  const UNLOCK_POST_URL = 'https://linux.do/t/topic/3117832';
  let unlockToastTimer = null;

  function showUnlockToast(msg) {
    if (!unlockLinkToast) return;
    if (unlockToastTimer) clearTimeout(unlockToastTimer);
    unlockLinkToast.textContent = msg;
    unlockLinkToast.style.display = 'block';
    unlockToastTimer = setTimeout(() => {
      unlockLinkToast.style.display = 'none';
    }, 4500);
  }

  async function openUnlockAuthorPost() {
    let opened = false;
    try {
      if (window.contextMeterAPI?.openExternal) {
        const res = await window.contextMeterAPI.openExternal(UNLOCK_POST_URL);
        if (res && res.ok) opened = true;
      }
    } catch {}

    if (!opened) {
      try {
        const w = window.open(UNLOCK_POST_URL, '_blank');
        if (w) opened = true;
      } catch {}
    }

    if (opened) {
      showUnlockToast(t('models.linkOpened'));
    } else {
      copyUnlockPostUrl(true);
    }
  }

  function copyUnlockPostUrl(fromFailedOpen = false) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(UNLOCK_POST_URL);
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = UNLOCK_POST_URL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch {}
    }
    showUnlockToast(fromFailedOpen
      ? t('models.linkCopyFallback')
      : t('models.copyOk'));
  }

  linkUnlockAuthor?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openUnlockAuthorPost();
  });

  linkUnlockAuthor?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      void openUnlockAuthorPost();
    }
  });

  btnCopyUnlockLink?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyUnlockPostUrl(false);
  });

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 模块 1.5: 插件面板语言 (Context Meter) 与客户端语言 (Antigravity)
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');
  const btnClientLangZhCn = el('btn-client-lang-zh-CN');
  const btnClientLangEn = el('btn-client-lang-en');

  function syncPanelLanguageButtons(lang) {
    const normalized = normalizePanelLanguage(lang);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  function syncClientLanguageButtons() {
    if (btnClientLangZhCn) {
      if (currentChineseEnabled) addClass(btnClientLangZhCn, 'active');
      else removeClass(btnClientLangZhCn, 'active');
      btnClientLangZhCn.setAttribute?.('aria-pressed', String(currentChineseEnabled));
    }
    if (btnClientLangEn) {
      if (!currentChineseEnabled) addClass(btnClientLangEn, 'active');
      else removeClass(btnClientLangEn, 'active');
      btnClientLangEn.setAttribute?.('aria-pressed', String(!currentChineseEnabled));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (cardDrawerArrow && cardDrawerBody) {
        const open = cardDrawerBody.style.display === 'block';
        cardDrawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (unlockDrawerArrow && unlockDrawerBody) {
        const open = unlockDrawerBody.style.display === 'block';
        unlockDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
      }
      const btnCostDet = el('btn-cost-details-toggle');
      const costDetBody = el('cost-details-pane');
      if (btnCostDet && costDetBody) {
        const open = costDetBody.style.display === 'block';
        btnCostDet.textContent = open ? t('cost.btnCollapse') : t('cost.btnExpand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch {}
    try { if (typeof applyTheme === 'function') applyTheme(); } catch {}
    try { render(); } catch {}
    try { renderSessionCost(); } catch {}
    try { renderHeaderModelDropdown(); } catch {}
    try { renderModelSettingsTab(); } catch {}
    try { renderSpeedComparisonTab(); } catch {}
    try { if (currentUnlockStatus) { renderClientStatusBar(); renderCompactSessionCard(); } } catch {}
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      } else {
        const pv = el('plan-summary-price-val');
        if (pv && /^\$19\.99\/(月|mo)$/.test(String(pv.textContent || '').trim())) {
          pv.textContent = `$19.99${t('plan.summary.perMonth')}`;
        }
      }
      if (typeof refreshRegionPresetSelectOptions === 'function') refreshRegionPresetSelectOptions();
      if (typeof refreshDirectCountryDisplay === 'function') refreshDirectCountryDisplay();
      if (typeof refreshDirectRegionDisplay === 'function') refreshDirectRegionDisplay();
      if (typeof refreshDirectCurrencyDisplay === 'function') refreshDirectCurrencyDisplay();
    } catch {}
    try {
      if (typeof renderEnhanceSectionUI === 'function') renderEnhanceSectionUI();
    } catch {}
    try {
      if (isChineseExpanded || isProxyExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView && typeof refreshEnhanceStatus === 'function') {
        void refreshEnhanceStatus();
      }
    } catch {}
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
      }
    } catch {}

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch {}
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  // 模块 2: 客户端界面汉化 (AntigravityChinese)
  // -------------------------------------------------------------
  const btnToggleChinese = el('btn-toggle-chinese');
  const chineseDrawerBody = el('chinese-drawer-body');
  const chineseDrawerArrow = el('chinese-drawer-arrow');
  const chineseBadge = el('chinese-badge');
  const chineseStatusDesc = el('chinese-status-desc');
  const btnToggleChineseModule = el('btn-toggle-chinese-module');

  let isChineseExpanded = false;
  let currentChineseEnabled = false;

  btnToggleChinese?.addEventListener('click', () => {
    isChineseExpanded = !isChineseExpanded;
    if (chineseDrawerBody) chineseDrawerBody.style.display = isChineseExpanded ? 'block' : 'none';
    if (chineseDrawerArrow) chineseDrawerArrow.textContent = isChineseExpanded ? t('drawer.collapse') : t('drawer.expand');
    btnToggleChinese?.setAttribute('aria-expanded', String(isChineseExpanded));
    if (isChineseExpanded) {
      void refreshModulesDisplay();
    }
  });

  // -------------------------------------------------------------
  // 模块 3: 免 TUN 网络直连 (AntigravityProxyNoTun)
  // -------------------------------------------------------------
  const btnToggleProxy = el('btn-toggle-proxy');
  const proxyDrawerBody = el('proxy-drawer-body');
  const proxyDrawerArrow = el('proxy-drawer-arrow');
  const proxyBadge = el('proxy-badge');
  const proxyStatusDesc = el('proxy-status-desc');
  const inputProxyUrl = el('input-proxy-url');
  const inputProxyBypass = el('input-proxy-bypass');
  const btnTestProxy = el('btn-test-proxy');
  const btnToggleProxyModule = el('btn-toggle-proxy-module');
  const proxyTestResult = el('proxy-test-result');

  let isProxyExpanded = false;
  let currentProxyEnabled = false;

  btnToggleProxy?.addEventListener('click', () => {
    isProxyExpanded = !isProxyExpanded;
    if (proxyDrawerBody) proxyDrawerBody.style.display = isProxyExpanded ? 'block' : 'none';
    if (proxyDrawerArrow) proxyDrawerArrow.textContent = isProxyExpanded ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleProxy?.setAttribute('aria-expanded', String(isProxyExpanded));
  });

  // -------------------------------------------------------------
  // 模块 3.5: 系统增强、提示词档位、品牌与推荐配置控制器 (PR #3 / PR #4 融合)
  // -------------------------------------------------------------
  const btnEnhancePresetApply = el('btn-enhance-preset-apply');
  const btnEnhanceRestoreAll = el('btn-enhance-restore-all');
  const enhanceGlobalBadge = el('enhance-global-badge');
  const enhancePresetConfirm = el('enhance-preset-confirm');
  const enhanceConfirmTitle = el('enhance-preset-confirm-text');
  const btnEnhanceConfirmCancel = el('btn-enhance-confirm-cancel');
  const btnEnhanceConfirmGo = el('btn-enhance-confirm-go');
  const enhanceGlobalResult = el('enhance-global-result');
  const enhanceResultText = el('enhance-global-result-text');
  const enhanceResultActions = el('enhance-global-result-actions');
  const enhanceManualNote = el('enhance-global-manual-note');
  const btnEnhanceRestartHost = el('btn-enhance-restart-host');
  const btnEnhanceRestartLs = el('btn-enhance-restart-ls');

  const chkPresetPrompt = el('chk-rec-prompt');
  const chkPresetTitle = el('chk-rec-title');
  const chkPresetLang = el('chk-rec-lang');
  const chkPresetCtx = el('chk-rec-ctx');

  const brandTitleBtns = {
    english: el('btn-brand-english'),
    hidden: el('btn-brand-hidden'),
    translated: el('btn-brand-translated')
  };

  const enhancePromptBadge = el('enhance-prompt-badge');
  const enhanceStatPrompt = el('enhance-stat-prompt');
  const enhanceStatTitle = el('enhance-stat-title');
  const enhanceStatSlots = el('enhance-stat-slots');
  const enhanceStatBackup = el('enhance-stat-backup');
  const enhanceTierGrid = el('enhance-tier-grid');
  const enhanceTierBtns = [0, 1, 2, 3, 4].map(n =>
    el(`enhance-tier-${n}`) || enhanceTierGrid?.querySelector?.(`[data-enhance-tier="${n}"]`) || null
  );
  const enhanceTierSummary = el('enhance-tier-matrix-title');
  const enhanceTierCurrentDesc = el('enhance-tier-current-desc');
  const enhanceTierKeeps = el('enhance-tier-keeps');
  const enhanceTierClears = el('enhance-tier-clears');
  const enhanceTierReplaces = el('enhance-tier-replaces');
  const enhanceTierMeaning = el('enhance-tier-meaning');
  const btnApplyBrandTitle = el('btn-apply-brand-title');
  const brandApplyFeedback = el('brand-apply-feedback');
  const enhanceChineseTitleCheck = el('chk-enhance-chinese-title');
  const btnApplyEnhancePrompt = el('btn-enhance-apply-prompt');
  const btnRefreshEnhance = el('btn-enhance-refresh');
  const enhancePromptResult = el('enhance-prompt-result');
  const enhancePromptResultText = el('enhance-prompt-result-text');
  const btnToggleEnhanceDetails = el('btn-toggle-enhance-details');
  const enhanceDetailsBody = el('enhance-details-body');
  const enhanceDetailsArrow = el('enhance-details-arrow');
  const enhanceBinaryList = el('enhance-binary-list');

  let currentBrandTitle = 'english';
  let currentEnhanceStatus = null;
  let selectedEnhanceTier = 0;
  let enhanceTitleDraft = false;
  let pendingEnhanceConfirmMode = null; // 'preset' | 'restore' | null
  let isEnhanceBusy = false;
  let hasPendingLsReload = false;

  function syncBrandTitleButtons(mode = currentBrandTitle) {
    for (const [k, btn] of Object.entries(brandTitleBtns)) {
      if (!btn) continue;
      const active = k === mode;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
  }

  function renderEnhancePromptMatrix(tier = selectedEnhanceTier) {
    const idx = [0, 1, 2, 3, 4].includes(Number(tier)) ? Number(tier) : 0;
    const allTierBtns = enhanceTierGrid?.querySelectorAll?.('[data-enhance-tier]') || enhanceTierBtns.filter(Boolean);
    allTierBtns.forEach?.((btn) => {
      const bIdx = Number(btn.getAttribute?.('data-enhance-tier'));
      const active = bIdx === idx;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    });
    if (enhanceTierSummary) enhanceTierSummary.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierCurrentDesc) enhanceTierCurrentDesc.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierKeeps) enhanceTierKeeps.textContent = t(`enhance.tier.${idx}.keeps`);
    if (enhanceTierClears) enhanceTierClears.textContent = t(`enhance.tier.${idx}.clears`);
    if (enhanceTierReplaces) enhanceTierReplaces.textContent = t(`enhance.tier.${idx}.replaces`);
    if (enhanceTierMeaning) enhanceTierMeaning.textContent = t(`enhance.tier.${idx}.meaning`);
  }

  function renderEnhanceSectionUI() {
    syncBrandTitleButtons(currentBrandTitle);
    renderEnhancePromptMatrix(selectedEnhanceTier);
    const data = currentEnhanceStatus;
    const s = data?.summary || data;
    const tierNum = s?.promptTier ?? s?.detectedTier;
    const hasTitle = Boolean(s?.chineseTitleEnabled);
    const titleMode = s?.chineseTitleMode || (hasTitle ? 'zh' : 'en');
    const slotCount = Number(s?.slotCount || 0);
    const totalCap = Number(s?.totalCapacityBytes || 0);
    const activeBytes = Number(s?.activeSlotBytes || 0);
    const allBak = Boolean(s?.allBackedUp ?? s?.hasBackup);
    const targetsList = Array.isArray(data?.binaries) ? data.binaries : (Array.isArray(data?.targets) ? data.targets : []);

    if (enhanceGlobalBadge) {
      if (!data || !data.supported) {
        enhanceGlobalBadge.textContent = t('enhance.status.unread');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      } else if (Number(tierNum) > 0 || hasTitle) {
        enhanceGlobalBadge.textContent = t('enhance.status.patchedActive');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else {
        enhanceGlobalBadge.textContent = t('enhance.status.stock');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      }
    }
    if (enhancePromptBadge) {
      if (!data || !data.supported) {
        enhancePromptBadge.textContent = t('enhance.status.unread');
        enhancePromptBadge.className = 'key-pill pill-muted';
      } else {
        enhancePromptBadge.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
        enhancePromptBadge.className = Number(tierNum) > 0 ? 'key-pill pill-ok' : 'key-pill pill-muted';
      }
    }
    if (enhanceStatPrompt) {
      if (!data || !data.supported) {
        enhanceStatPrompt.textContent = t('enhance.status.unread');
      } else {
        enhanceStatPrompt.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
      }
    }
    if (enhanceStatTitle) {
      if (!data || !data.supported) enhanceStatTitle.textContent = t('enhance.status.unread');
      else if (titleMode === 'zh' || hasTitle) enhanceStatTitle.textContent = hasPendingLsReload ? t('enhance.titleState.onWritten') : t('enhance.titleState.on');
      else if (titleMode === 'mixed') enhanceStatTitle.textContent = t('enhance.titleState.conflict');
      else enhanceStatTitle.textContent = t('enhance.titleState.off');
    }
    if (enhanceStatSlots) {
      if (!data || !data.supported || totalCap <= 0) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else {
        enhanceStatSlots.textContent = `${activeBytes} / ${totalCap} B (${slotCount})`;
      }
    }
    if (enhanceStatBackup) {
      if (!data || !data.supported) enhanceStatBackup.textContent = t('enhance.status.unread');
      else enhanceStatBackup.textContent = allBak ? t('enhance.status.backupYes') : t('enhance.status.backupNo');
    }
    if (enhanceBinaryList && targetsList.length) {
      enhanceBinaryList.textContent = targetsList.map(tgt => `${tgt.label || tgt.id || ''}: ${tgt.path || tgt}${tgt.exists === false ? ' (missing)' : ''}`).join(' | ');
    }
    if (enhanceDetailsArrow && enhanceDetailsBody) {
      const open = enhanceDetailsBody.style.display === 'block';
      enhanceDetailsArrow.textContent = open ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    }
  }

  function showEnhanceResultBox(ok, message, opts = {}) {
    if (!enhanceGlobalResult || !enhanceResultText) return;
    enhanceGlobalResult.style.display = 'block';
    enhanceGlobalResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhanceResultText.textContent = message;
    const needLs = Boolean(opts.needsLsRestart);
    const needHost = Boolean(opts.needsHostRestart);
    const canRestartHost = Boolean(hostSupportsRestart);
    if (btnEnhanceRestartLs) btnEnhanceRestartLs.hidden = !needLs;
    if (btnEnhanceRestartHost) btnEnhanceRestartHost.hidden = !(needHost && canRestartHost);
    if (enhanceManualNote) enhanceManualNote.hidden = !(needHost && !canRestartHost);
    if (enhanceResultActions) enhanceResultActions.hidden = !(needLs || (needHost && canRestartHost));
  }

  function showEnhancePromptResult(ok, message) {
    if (!enhancePromptResult || !enhancePromptResultText) return;
    enhancePromptResult.style.display = 'block';
    enhancePromptResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhancePromptResultText.textContent = message;
  }

  async function refreshEnhanceStatus(syncDrafts = true) {
    try {
      const res = await invokeEnhanceApi('status', {});
      if (res && res.ok && res.data) {
        currentEnhanceStatus = res.data;
        const s = res.data.summary || res.data;
        if (syncDrafts) {
          const tierVal = s.promptTier ?? s.detectedTier;
          if ([0, 1, 2, 3, 4].includes(Number(tierVal))) {
            selectedEnhanceTier = Number(tierVal);
          }
          enhanceTitleDraft = Boolean(s.chineseTitleEnabled);
          if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.checked = enhanceTitleDraft;
        }
      } else if (res && res.unavailable) {
        currentEnhanceStatus = { supported: false };
      }
    } catch {
      currentEnhanceStatus = null;
    }
    renderEnhanceSectionUI();
  }

  for (let i = 0; i < enhanceTierBtns.length; i++) {
    const btn = enhanceTierBtns[i];
    btn?.addEventListener('click', () => {
      selectedEnhanceTier = i;
      renderEnhancePromptMatrix(i);
    });
  }

  enhanceTierGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('[data-enhance-tier]');
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-enhance-tier'));
    if (![0, 1, 2, 3, 4].includes(idx)) return;
    selectedEnhanceTier = idx;
    renderEnhancePromptMatrix(idx);
  });

  enhanceChineseTitleCheck?.addEventListener('change', (e) => {
    enhanceTitleDraft = Boolean(e?.target?.checked);
  });

  btnToggleEnhanceDetails?.addEventListener('click', () => {
    if (!enhanceDetailsBody) return;
    const isHidden = enhanceDetailsBody.style.display === 'none' || !enhanceDetailsBody.style.display;
    enhanceDetailsBody.style.display = isHidden ? 'block' : 'none';
    btnToggleEnhanceDetails.setAttribute('aria-expanded', String(isHidden));
    renderEnhanceSectionUI();
  });

  btnRefreshEnhance?.addEventListener('click', () => {
    void refreshEnhanceStatus(true);
  });

  btnApplyEnhancePrompt?.addEventListener('click', async () => {
    if (isEnhanceBusy) return;
    isEnhanceBusy = true;
    const wantTitle = enhanceChineseTitleCheck ? Boolean(enhanceChineseTitleCheck.checked) : enhanceTitleDraft;
    if (btnApplyEnhancePrompt) {
      btnApplyEnhancePrompt.disabled = true;
      btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPromptBusy');
    }
    try {
      const res = await invokeEnhanceApi('apply', {
        promptTier: selectedEnhanceTier,
        chineseTitle: wantTitle,
        restartLanguageServer: false
      });
      if (!res || !res.ok) {
        const errMsg = t('enhance.result.fail', { err: translateBackendText(res?.error) || t('msg.unknownErr') });
        showEnhancePromptResult(false, errMsg);
        showEnhanceResultBox(false, errMsg);
      } else {
        const tierLabel = t(`enhance.tier.${selectedEnhanceTier}.short`);
        const titleLabel = wantTitle ? t('enhance.titleState.on') : t('enhance.titleState.off');
        hasPendingLsReload = true;
        const msg = t('enhance.result.appliedNeedRestartLs', { tier: tierLabel, title: titleLabel });
        showEnhancePromptResult(true, msg);
        showEnhanceResultBox(true, msg, { needsLsRestart: true, needsHostRestart: false });
      }
      await refreshEnhanceStatus(true);
    } catch (e) {
      const errMsg = t('enhance.result.fail', { err: e?.message || t('msg.unknownErr') });
      showEnhancePromptResult(false, errMsg);
      showEnhanceResultBox(false, errMsg);
    } finally {
      isEnhanceBusy = false;
      if (btnApplyEnhancePrompt) {
        btnApplyEnhancePrompt.disabled = false;
        btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPrompt');
      }
    }
  });

  btnEnhancePresetApply?.addEventListener('click', () => {
    const selectedLabels = [];
    if (chkPresetPrompt?.checked) selectedLabels.push(t('enhance.preset.itemPrompt'));
    if (chkPresetTitle?.checked) selectedLabels.push(t('enhance.preset.itemTitle'));
    if (chkPresetLang?.checked) selectedLabels.push(t('enhance.preset.itemLang'));
    if (chkPresetCtx?.checked) selectedLabels.push(t('enhance.preset.itemCtx'));
    if (!selectedLabels.length) {
      showEnhanceResultBox(false, t('enhance.confirm.noneSelected'));
      return;
    }
    pendingEnhanceConfirmMode = 'preset';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.presetSummary', { items: selectedLabels.join('、') });
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceRestoreAll?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = 'restore';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.restoreSummary');
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceConfirmCancel?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
  });

  btnEnhanceConfirmGo?.addEventListener('click', async () => {
    const mode = pendingEnhanceConfirmMode;
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
    if (!mode || isEnhanceBusy) return;

    isEnhanceBusy = true;
    try {
      const doneParts = [];
      const failedParts = [];
      let needsLsRestart = false;
      let needsHostRestart = false;

      if (mode === 'preset') {
        const wantPrompt = Boolean(chkPresetPrompt?.checked);
        const wantTitle = Boolean(chkPresetTitle?.checked);
        const wantLang = Boolean(chkPresetLang?.checked);
        const wantCtx = Boolean(chkPresetCtx?.checked);

        if (wantPrompt || wantTitle) {
          const itemLabel = [wantPrompt ? t('enhance.preset.itemPrompt') : '', wantTitle ? t('enhance.preset.itemTitle') : ''].filter(Boolean).join('、');
          try {
            const payload = {};
            if (wantPrompt) payload.promptTier = 4;
            if (wantTitle) payload.chineseTitle = true;
            const eRes = await invokeEnhanceApi('apply', payload);
            if (!eRes || !eRes.ok) {
              throw new Error(translateBackendText(eRes?.error) || t('msg.unknownErr'));
            }
            if (wantPrompt) doneParts.push(t('enhance.preset.itemPrompt'));
            if (wantTitle) doneParts.push(t('enhance.preset.itemTitle'));
            if (eRes.needsRestart !== false) needsLsRestart = true;
          } catch (stepErr) {
            failedParts.push(`${itemLabel}: ${stepErr?.message || t('msg.unknownErr')}`);
          }
        }

        if (wantLang) {
          try {
            const lRes = await invokeModulesApi('toggle', 'chinese', true, {
              language: 'zh-CN',
              brandTitle: currentBrandTitle
            });
            if (!lRes || !lRes.ok) {
              throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
            }
            doneParts.push(t('enhance.preset.itemLang'));
            needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
          }
        }

        if (wantCtx) {
          try {
            const cRes = await invokeUnlockApi('apply', { mode: 'dynamic', limitTokens: null });
            if (!cRes || !cRes.ok) {
              throw new Error(buildFriendlyWriteError(cRes?.error));
            }
            doneParts.push(t('enhance.preset.itemCtx'));
            if (cRes.needsRestart) needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.unknownErr')}`);
          }
        }
      } else if (mode === 'restore') {
        const promptTitleLabel = `${t('enhance.preset.itemPrompt')} / ${t('enhance.preset.itemTitle')}`;
        try {
          const rRes = await invokeEnhanceApi('restore', {});
          if (!rRes || !rRes.ok) {
            throw new Error(translateBackendText(rRes?.error) || t('msg.restoreFail'));
          }
          doneParts.push(promptTitleLabel);
          if (rRes.needsRestart) needsLsRestart = true;
        } catch (stepErr) {
          failedParts.push(`${promptTitleLabel}: ${stepErr?.message || t('msg.restoreFail')}`);
        }

        try {
          const lRes = await invokeModulesApi('toggle', 'chinese', false, { language: 'en', brandTitle: 'english' });
          if (!lRes || !lRes.ok) {
            throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
          }
          currentBrandTitle = 'english';
          doneParts.push(t('enhance.preset.itemLang'));
          needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
        }

        try {
          const cRes = await invokeUnlockApi('restore', {});
          if (!cRes || !cRes.ok) {
            throw new Error(buildFriendlyWriteError(cRes?.error));
          }
          doneParts.push(t('enhance.preset.itemCtx'));
          if (cRes.needsRestart) needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.restoreFail')}`);
        }
      }

      if (needsHostRestart) needsRestartAfterApply = true;

      if (failedParts.length > 0) {
        const msg = doneParts.length > 0
          ? t('enhance.result.partialFail', { done: doneParts.join('、'), failed: failedParts.join('；') })
          : t('enhance.result.fail', { err: failedParts.join('；') });
        showEnhanceResultBox(false, msg, { needsLsRestart, needsHostRestart });
      } else if (mode === 'preset') {
        showEnhanceResultBox(
          true,
          t('enhance.result.presetDone', { summary: doneParts.join('、') }),
          { needsLsRestart, needsHostRestart }
        );
      } else if (mode === 'restore') {
        showEnhanceResultBox(true, t('enhance.result.restoredDone'), { needsLsRestart, needsHostRestart: true });
      }
      await Promise.all([refreshEnhanceStatus(true), refreshModulesDisplay(), refreshUnlockStatus()]);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.fail', { err: e?.message || t('msg.unknownErr') }));
    } finally {
      isEnhanceBusy = false;
    }
  });

  btnEnhanceRestartLs?.addEventListener('click', async () => {
    try {
      const res = await invokeEnhanceApi('restart-ls', {});
      if (!res || !res.ok) {
        showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      const killedCount = Array.isArray(res.killed) ? res.killed.length : (Number(res.killed) || 0);
      hasPendingLsReload = false;
      showEnhanceResultBox(true, t('enhance.result.lsRestarted', { killed: killedCount }), { needsLsRestart: false, needsHostRestart: needsRestartAfterApply });
      await refreshEnhanceStatus(false);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: e?.message || t('msg.unknownErr') }));
    }
  });

  btnEnhanceRestartHost?.addEventListener('click', openClientRestartConfirmFlow);

  let selectedBrandTitle = currentBrandTitle;
  let brandObserver = null;

  function ensureBrandObserver(modeKey, targetBtn) {
    if (brandObserver) {
      try { brandObserver.disconnect(); } catch {}
      brandObserver = null;
    }
    if (!targetBtn || modeKey === 'english') return;
    try {
      const container = targetBtn.parentElement || targetBtn;
      brandObserver = new MutationObserver(() => {
        const btn = document.querySelector('button[data-agy-brand-item="true"]') || targetBtn;
        if (!btn) return;
        const txt = btn.textContent?.trim() || '';
        if (modeKey === 'hidden' && txt !== '') {
          btn.textContent = '';
        } else if (modeKey === 'translated' && txt !== '反重力') {
          btn.textContent = '反重力';
        }
      });
      brandObserver.observe(container, { childList: true, subtree: true, characterData: true });
    } catch {}
  }

  function applyBrandTitleToDom(modeKey) {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { found: false, applied: false, nodeText: null };
    }
    // 1. 优先通过持久化标记锁定曾确认过的品牌节点（确保隐藏清空文字后仍可精准识别与无损恢复）
    let targetBtn = document.querySelector('button[data-agy-brand-item="true"]');

    // 2. 若尚未标记，遍历所有 title-menu-bar-item 菜单按钮，精准仅匹配原文本为 Antigravity 的节点
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const menuItems = document.querySelectorAll('button[data-testid="title-menu-bar-item"]');
      for (const btn of menuItems) {
        const txt = btn.textContent?.trim();
        if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
          targetBtn = btn;
          break;
        }
      }
    }

    // 3. 备选：极左上角区域（top <= 70 && left <= 300）候选定位
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const candidateBtns = document.querySelectorAll('button.agy-button, button[class*="agy-button"]');
      for (const btn of candidateBtns) {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { top: 0, left: 0 };
        if (rect.top <= 70 && rect.left <= 300) {
          const txt = btn.textContent?.trim();
          if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
            targetBtn = btn;
            break;
          }
        }
      }
    }

    if (!targetBtn) {
      return { found: false, applied: false, nodeText: null };
    }

    // 永久保留节点引用与原始身份标记，不顺带修改 document.title 或任务栏标题
    targetBtn.setAttribute('data-agy-brand-item', 'true');
    targetBtn._agyBrandManaged = true;
    if (!targetBtn._agyOriginalText) {
      targetBtn._agyOriginalText = 'Antigravity';
    }

    const expectedText = modeKey === 'translated' ? '反重力' : (modeKey === 'hidden' ? '' : 'Antigravity');

    const nodes = targetBtn.childNodes ? Array.from(targetBtn.childNodes) : (targetBtn.children || []);
    let textNode = null;
    for (const node of nodes) {
      if (node && node.nodeType === 3) {
        textNode = node;
        break;
      }
    }

    // 保留菜单入口可用（不设置 display: none，隐藏模式仅清空文字），确保菜单功能随时可点击
    targetBtn.style.display = '';
    if (textNode) {
      textNode.nodeValue = expectedText;
    } else {
      targetBtn.textContent = expectedText;
    }
    targetBtn.setAttribute('data-agy-brand-mode', modeKey);

    ensureBrandObserver(modeKey, targetBtn);

    const currentText = targetBtn.textContent?.trim() || '';
    const isApplied = (modeKey === 'hidden' ? currentText === '' : currentText === expectedText);

    return {
      found: true,
      applied: isApplied,
      nodeText: currentText
    };
  }

  function showBrandFeedback(mode, isSuccess = true, customMsg = '', isApplied = false) {
    if (!brandApplyFeedback) return;
    if (!isSuccess) {
      brandApplyFeedback.textContent = customMsg || t('msg.saveFail');
      brandApplyFeedback.style.color = '#ef4444';
      brandApplyFeedback.hidden = false;
      return;
    }
    const modeLabel = t(`enhance.brand.${mode}`) || mode;
    let msg = customMsg;
    if (!msg) {
      msg = isApplied
        ? `${t('enhance.brand.switched', { mode: modeLabel })}（已即时生效）`
        : `${t('enhance.brand.switched', { mode: modeLabel })}（未检测到目标，${t('models.status.pendingRestart')}）`;
    }
    brandApplyFeedback.textContent = msg;
    if (!isApplied) {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'unlock-btn unlock-btn-secondary';
      rBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;cursor:pointer;';
      rBtn.textContent = t('models.btnRestartHost');
      rBtn.addEventListener('click', () => openClientRestartConfirmFlow());
      brandApplyFeedback.appendChild(rBtn);
    }
    brandApplyFeedback.style.color = isApplied ? '#10b981' : 'var(--ag-text-primary)';
    brandApplyFeedback.hidden = false;
  }

  async function applyBrandTitleSetting(modeKey) {
    try {
      const res = await invokeModulesApi('toggle', 'chinese', currentChineseEnabled, {
        language: currentChineseEnabled ? 'zh-CN' : 'en',
        brandTitle: modeKey
      });
      if (!res || !res.ok) {
        const err = translateBackendText(res?.error) || t('msg.saveFail');
        showBrandFeedback(modeKey, false, err, false);
        showEnhanceResultBox(false, err);
        return;
      }
      currentBrandTitle = modeKey;
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);

      // 实时真实 DOM 应用
      const domResult = applyBrandTitleToDom(modeKey);

      // 实时热同步（若已注入运行时环境）
      try {
        if (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__) {
          window.__AGY_I18N_CONFIG__.brandTitle = modeKey;
          if (typeof window.__AGY_RUN_FULL_SCAN__ === 'function') {
            window.__AGY_RUN_FULL_SCAN__();
          }
        }
      } catch {}

      const modeLabel = t(`enhance.brand.${modeKey}`) || modeKey;
      if (domResult.applied) {
        const appliedMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（左上角品牌已切换为：${modeLabel}）`;
        showBrandFeedback(modeKey, true, appliedMsg, true);
        showEnhanceResultBox(true, appliedMsg, { needsHostRestart: false });
      } else {
        const pendingMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（当前窗口未检测到品牌节点，重启客户端后生效）`;
        showBrandFeedback(modeKey, true, pendingMsg, false);
        showEnhanceResultBox(true, pendingMsg, { needsHostRestart: true });
      }
    } catch (e) {
      const err = e?.message || t('msg.saveFail');
      showBrandFeedback(modeKey, false, err, false);
      showEnhanceResultBox(false, err);
    }
  }

  for (const [modeKey, btn] of Object.entries(brandTitleBtns)) {
    btn?.addEventListener('click', () => {
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);
      void applyBrandTitleSetting(modeKey);
    });
  }

  btnApplyBrandTitle?.addEventListener('click', () => {
    void applyBrandTitleSetting(selectedBrandTitle || currentBrandTitle);
  });

  async function refreshModulesDisplay() {
    try {
      const res = await invokeModulesApi('status');
      if (!res || !res.ok || !res.data) {
        const errMsg = (res && res.error) ? translateBackendText(res.error) : t('msg.unknownErr');
        if (chineseBadge) {
          chineseBadge.textContent = t('mod.readFail');
          chineseBadge.className = 'key-pill pill-danger';
        }
        if (chineseStatusDesc) {
          chineseStatusDesc.textContent = t('mod.zh.failDetect', { err: errMsg });
        }
        if (proxyBadge) {
          proxyBadge.textContent = t('mod.readFail');
          proxyBadge.className = 'key-pill pill-danger';
        }
        if (proxyStatusDesc) {
          proxyStatusDesc.textContent = t('mod.proxy.failDetect', { err: errMsg });
        }
        return;
      }
      const cfg = res.data;

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      currentBrandTitle = cfg.modules?.chinese?.brandTitle || 'english';
      syncBrandTitleButtons(currentBrandTitle);
      applyBrandTitleToDom(currentBrandTitle);
      // 判定宿主界面是否已翻译：定向检查系统导航、活动栏、菜单及操作按钮等固有系统壳层（排除用户消息内容区域）
      const isDomTranslated = (() => {
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const systemContainers = document.querySelectorAll(
            "div[role='navigation'], nav, header, [role='banner'], aside, [data-testid*='sidebar'], [data-testid*='navigation'], [class*='@container/titlebar'], .monaco-workbench, .activitybar"
          );
          const systemKeywords = ['新建对话', '新建会话', '新建', '设置', '账户', '项目', '关于', '帮助', '工作区', '管理', '自定义扩展', '资源管理器', '活动栏'];
          for (let i = 0; i < systemContainers.length; i++) {
            const container = systemContainers[i];
            if (container.closest && container.closest('.chat-session, .conversation-view, .monaco-list-row, .markdown, [data-testid*="chat"], [data-testid*="message"]')) {
              continue; // 严格排除用户聊天内容区
            }
            const labeledNodes = container.querySelectorAll ? container.querySelectorAll('button, a, [role="button"], [aria-label], [title], span') : [];
            for (let j = 0; j < Math.min(labeledNodes.length, 40); j++) {
              const node = labeledNodes[j];
              const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
              if (label && systemKeywords.some(kw => label.includes(kw))) return true;
              const text = (node.textContent || '').trim();
              if (text && systemKeywords.some(kw => text.includes(kw))) return true;
            }
            const txt = container.innerText || '';
            if (systemKeywords.some(kw => txt.includes(kw))) return true;
          }
          const nav = document.querySelector("div[role='navigation'], nav");
          if (nav && nav.innerText && systemKeywords.some(kw => nav.innerText.includes(kw))) {
            return true;
          }
        } catch {}
        return false;
      })();
      const disk = res.disk || {};

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = disk.chinese ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!disk.chinese) {
          chineseBadge.textContent = t('mod.zh.badgeNotInjected');
          chineseBadge.className = 'key-pill pill-danger';
        } else {
          chineseBadge.textContent = t('mod.zh.badgePendingRestart');
          chineseBadge.className = 'key-pill pill-warn';
        }
      }
      if (chineseStatusDesc) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseStatusDesc.textContent = t('mod.zh.descRestartEn');
          } else {
            chineseStatusDesc.textContent = disk.chinese
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!disk.chinese) {
          chineseStatusDesc.textContent = t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();

      currentProxyEnabled = Boolean(cfg.modules?.proxy?.enabled);
      if (proxyBadge) {
        if (currentProxyEnabled) {
          proxyBadge.textContent = disk.proxy ? t('mod.proxy.badgeOk') : t('mod.proxy.badgeNotInjected');
          proxyBadge.className = disk.proxy ? 'key-pill pill-ok' : 'key-pill pill-warn';
        } else {
          proxyBadge.textContent = t('mod.proxy.badgeOff');
          proxyBadge.className = 'key-pill pill-muted';
        }
      }
      if (inputProxyUrl && cfg.modules?.proxy?.proxyUrl) {
        inputProxyUrl.value = cfg.modules.proxy.proxyUrl;
      }
      if (inputProxyBypass && cfg.modules?.proxy?.bypassList) {
        inputProxyBypass.value = cfg.modules.proxy.bypassList;
      }
      if (proxyStatusDesc) {
        if (currentProxyEnabled) {
          proxyStatusDesc.textContent = disk.proxy
            ? t('mod.proxy.descOn', { url: cfg.modules.proxy.proxyUrl })
            : t('mod.proxy.descNeedInject');
        } else {
          proxyStatusDesc.textContent = t('mod.proxy.descOff');
        }
      }
      if (btnToggleProxyModule) {
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (chineseBadge) {
        chineseBadge.textContent = t('mod.readErr');
        chineseBadge.className = 'key-pill pill-danger';
      }
      if (chineseStatusDesc) {
        chineseStatusDesc.textContent = t('mod.zh.errDetect', { err: errMsg });
      }
      if (proxyBadge) {
        proxyBadge.textContent = t('mod.readErr');
        proxyBadge.className = 'key-pill pill-danger';
      }
      if (proxyStatusDesc) {
        proxyStatusDesc.textContent = t('mod.proxy.errDetect', { err: errMsg });
      }
    }
  }

  async function setClientLanguageTarget(wantChinese) {
    if (Boolean(wantChinese) === Boolean(currentChineseEnabled)) return;
    if (btnToggleChineseModule) {
      btnToggleChineseModule.disabled = true;
      btnToggleChineseModule.textContent = t('mod.processing');
    }
    try {
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en',
        brandTitle: currentBrandTitle
      });
      if (!res || !res.ok) {
        showEnhanceResultBox(false, translateBackendText(res?.error) || t('mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, `${t('mod.zh.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleChineseModule) {
        btnToggleChineseModule.disabled = false;
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
    }
  }

  btnClientLangZhCn?.addEventListener('click', () => {
    void setClientLanguageTarget(true);
  });
  btnClientLangEn?.addEventListener('click', () => {
    void setClientLanguageTarget(false);
  });

  btnToggleChineseModule?.addEventListener('click', () => {
    void setClientLanguageTarget(!currentChineseEnabled);
  });

  btnToggleProxyModule?.addEventListener('click', async () => {
    try {
      btnToggleProxyModule.disabled = true;
      btnToggleProxyModule.textContent = t('mod.processing');
      const res = await invokeModulesApi('toggle', 'proxy', !currentProxyEnabled, {
        proxyUrl: inputProxyUrl?.value?.trim(),
        bypassList: inputProxyBypass?.value?.trim()
      });
      if (!res || !res.ok) {
        showEnhanceResultBox(false, translateBackendText(res?.error) || t('mod.proxy.toggleFail'));
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, `${t('mod.proxy.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleProxyModule) {
        btnToggleProxyModule.disabled = false;
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('settings.proxy.enableBtn');
      }
    }
  });

  btnTestProxy?.addEventListener('click', async () => {
    try {
      const api = window.contextMeterAPI;
      if (!api || typeof api.testProxy !== 'function') return;
      btnTestProxy.disabled = true;
      btnTestProxy.textContent = t('settings.proxy.testing');
      if (proxyTestResult) {
        proxyTestResult.style.display = 'block';
        proxyTestResult.textContent = t('settings.proxy.testingDetail');
      }
      const res = await api.testProxy(inputProxyUrl?.value?.trim());
      if (proxyTestResult) {
        if (!res || !res.ok) {
          proxyTestResult.textContent = t('settings.proxy.testFail', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
        } else {
          const d = res.data;
          proxyTestResult.innerHTML = `
            ${t('settings.proxy.resFmt')}: ${d.configValid ? t('settings.proxy.resValid') : t('settings.proxy.resInvalid')}<br>
            ${t('settings.proxy.resPort')}: ${d.proxyReachable ? t('settings.proxy.resReachable') : t('settings.proxy.resUnreachable')}<br>
            ${t('settings.proxy.resNet')}: ${d.internetReachable ? t('settings.proxy.resOnline') : t('settings.proxy.resOffline')}<br>
            ${t('settings.proxy.resModel')}: ${t('settings.proxy.resPending')}
            ${d.error ? `<br><span style="color:var(--ag-danger)">⚠️ ${translateBackendText(d.error)}</span>` : ''}
          `;
        }
      }
    } catch (e) {
      if (proxyTestResult) proxyTestResult.textContent = t('settings.proxy.testErr', { err: e.message });
    } finally {
      if (btnTestProxy) {
        btnTestProxy.disabled = false;
        btnTestProxy.textContent = t('settings.proxy.testBtn');
      }
    }
  });

  // 静默初始化检测一次解锁状态与各模块状态
  setTimeout(() => {
    void refreshUnlockStatus();
    void refreshModulesDisplay();
  }, 500);
  setTimeout(() => {
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);

  // 二级抽屉 1（面板 B 内）: 指标与背景颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  function toggleColorsDrawer(forceOpen) {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
    colorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker();
    }
  }
  btnColors?.addEventListener('click', () => toggleColorsDrawer());

  // 二级抽屉 2（面板 B 内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 模型卡片下一层详情折叠展开（实测预算、速度与内部详情）
  const btnCardDetails = el('btn-toggle-card-details');
  const cardDrawerBody = el('ctx-card-drawer-body');
  const cardDrawerArrow = el('ctx-card-drawer-arrow');
  btnCardDetails?.addEventListener('click', () => {
    if (!cardDrawerBody) return;
    const isHidden = cardDrawerBody.style.display === 'none' || !cardDrawerBody.style.display;
    cardDrawerBody.style.display = isHidden ? 'block' : 'none';
    if (cardDrawerArrow) cardDrawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnCardDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 3（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
  const btnTokenColors = el('btn-toggle-token-colors');
  const tokenColorDrawerBody = el('token-color-drawer-body');
  const tokenColorDrawerArrow = el('token-color-drawer-arrow');
  function toggleTokenColorsDrawer(forceOpen) {
    if (!tokenColorDrawerBody) return;
    const curHidden = tokenColorDrawerBody.style.display === 'none' || !tokenColorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    tokenColorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    tokenColorDrawerBody.classList?.toggle?.('is-expanded', nextOpen);
    if (tokenColorDrawerArrow) tokenColorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnTokenColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker(false);
    }
  }
  btnTokenColors?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('heat-legend-scale')?.addEventListener('click', () => toggleTokenColorsDrawer(true));

  // 热力图视图切换（每天 / 每周 / 累计总量）

  // 费用估算范围（默认本期：自然月）与估值模式（默认参考模型折算，首屏展示真实用量价值）
  let activeCostScope = 'period'; // 'period' | 'all'
  let costModelMode = 'ref'; // 'ref' | 'hybrid' | 'identified'
  let activeRefMode = 'all'; // 兼容旧接口 'all' | 'hybrid'

  function switchCostScope(scope) {
    activeCostScope = scope;
    setPillActive(el('cost-btn-scope-period'), scope === 'period');
    setPillActive(el('cost-btn-scope-all'), scope === 'all');
    renderActiveCostEstimateView();
  }
  el('cost-btn-scope-period')?.addEventListener('click', () => switchCostScope('period'));
  el('cost-btn-scope-all')?.addEventListener('click', () => switchCostScope('all'));

  function switchCostModelMode(mode) {
    costModelMode = mode;
    setPillActive(el('cost-btn-mode-ref'), mode === 'ref');
    setPillActive(el('cost-btn-mode-hybrid'), mode === 'hybrid');
    setPillActive(el('cost-btn-mode-identified'), mode === 'identified');
    renderActiveCostEstimateView();
  }
  el('cost-btn-mode-ref')?.addEventListener('click', () => switchCostModelMode('ref'));
  el('cost-btn-mode-hybrid')?.addEventListener('click', () => switchCostModelMode('hybrid'));
  el('cost-btn-mode-identified')?.addEventListener('click', () => switchCostModelMode('identified'));

  function toggleRefCostDrawer(forceOpen) {
    const body = el('ref-cost-drawer-body');
    const btn = el('btn-toggle-ref-cost-drawer');
    if (!body) return;
    const curHidden = body.style.display === 'none' || !body.style.display;
    const next = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    body.style.display = next ? 'block' : 'none';
    if (btn) btn.textContent = next ? t('cost.btnCollapse') : t('cost.btnExpand');
  }
  el('btn-toggle-ref-cost-drawer')?.addEventListener('click', () => toggleRefCostDrawer());

  function switchRefMode(mode) {
    activeRefMode = mode;
    costModelMode = mode === 'hybrid' ? 'hybrid' : 'ref';
    setPillActive(el('btn-ref-mode-all'), mode === 'all');
    setPillActive(el('btn-ref-mode-hybrid'), mode === 'hybrid');
    renderActiveCostEstimateView();
  }
  el('btn-ref-mode-all')?.addEventListener('click', () => switchRefMode('all'));
  el('btn-ref-mode-hybrid')?.addEventListener('click', () => switchRefMode('hybrid'));

  function renderActiveCostEstimateView() {
    const isPeriod = activeCostScope === 'period';
    const titleEl = el('cost-card-title');
    const periodTag = el('cost-period-tag');
    const grandVal = el('cost-grand-val');
    const grandSub = el('cost-grand-sub');
    const covPill = el('cost-coverage-pill');
    const subSpendVal = el('cost-sub-spend-val');
    const subSpendLbl = el('cost-sub-spend-lbl');
    const subNote = el('cost-sub-compare-note');
    const usageSummary = el('cost-usage-summary');
    const diffSummary = el('cost-diff-summary');
    const breakdown = el('cost-breakdown-info');

    // 分类卡片 DOM
    const inVal = el('ref-cost-input-val');
    const inTok = el('ref-cost-input-tok');
    const caVal = el('ref-cost-cache-val');
    const caTok = el('ref-cost-cache-tok');
    const outVal = el('ref-cost-output-val');
    const outTok = el('ref-cost-output-tok');

    if (titleEl) titleEl.textContent = isPeriod ? t('cost.title') : t('cost.titleAll');
    if (periodTag) {
      const pKey = ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag');
      periodTag.textContent = isPeriod ? pKey : t('cost.allHistory');
    }

    // 1. 提取当前范围真实用量与折算数据
    const curIn = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthInput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalInputTokens || 0);
    const curCa = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthCache || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalCacheTokens || 0);
    const curOut = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthOutput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalOutputTokens || 0);
    const curTotal = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.monthTokens || (curIn + curCa + curOut))
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens || (curIn + curCa + curOut));

    const refAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.all || {};
    const refMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonth || {};
    const refHybridAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.hybrid || {};
    const refHybridMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonthHybrid || refHybridAll;

    const curRef = isPeriod ? refMonth : refAll;
    const curHybrid = isPeriod ? refHybridMonth : refHybridAll;

    const ceSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateBySource || {};
    const ceAll = ceSourceMap[activeTokenSource] || ceSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimate || {};
    const cePeriod = ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth || ceAll;
    const curIdentified = isPeriod ? cePeriod : ceAll;

    let apiCost = 0;
    let pillText = t('cost.covFull');
    let pillClass = 'key-pill pill-good';

    // 2. 估值模式计算
    let effectiveRef = curRef;
    if ((effectiveRef.totalCostUSD === undefined || effectiveRef.totalCostUSD === null) && curTotal > 0) {
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      if (core && core.calculateReferenceModelCost) {
        effectiveRef = core.calculateReferenceModelCost({
          inputTokens: curIn,
          outputTokens: curOut,
          cacheTokens: curCa,
          totalTokens: curTotal
        }, 'gemini-3.8-flash', { pricingDate: '2026-11-09', mode: 'all' });
      }
    }

    const rateIn = Number(effectiveRef.matchedTier?.inputPerMillion ?? 0.75);
    const rateCa = Number(effectiveRef.matchedTier?.cacheReadPerMillion ?? 0.075);
    const rateOut = Number(effectiveRef.matchedTier?.outputPerMillion ?? 3.75);

    // 更新小摘要来源与时间描述行及非实付常驻标识
    const scopeDescEl = el('cost-scope-desc');
    if (scopeDescEl) {
      const srcName = activeTokenSource === 'desktop' ? t('tokens.srcDesktopLabel') : activeTokenSource === 'cli' ? 'CLI' : t('tokens.srcAllLabel');
      const pLabel = isPeriod ? (ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag')) : t('cost.allHistory');
      scopeDescEl.textContent = `${srcName} · ${pLabel}`;
    }
    const nonPaidBadge = el('cost-non-paid-badge');
    if (nonPaidBadge) nonPaidBadge.textContent = t('cost.nonPaidBadge');

    if (costModelMode === 'ref') {
      apiCost = Number(effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
          grandVal.title = `$${apiCost.toFixed(4)}`;
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else {
          grandVal.textContent = '$0.00';
          grandVal.title = t('cost.noRecords');
        }
      }
      if (grandSub) {
        grandSub.textContent = t('cost.refSub', {
          model: effectiveRef.modelDisplayName || 'Gemini 3.8 Flash',
          in: rateIn.toFixed(2),
          ca: rateCa.toFixed(3),
          out: rateOut.toFixed(2)
        });
      }
      pillText = t('cost.modeRef');
      pillClass = 'key-pill pill-muted';

      if (inVal) inVal.textContent = `$${Number(effectiveRef.inputCostUSD || (curIn * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
      if (caVal) caVal.textContent = `$${Number(effectiveRef.cacheCostUSD || (curCa * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
      if (outVal) outVal.textContent = `$${Number(effectiveRef.outputCostUSD || (curOut * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
    } else if (costModelMode === 'hybrid') {
      const h = curHybrid.hybrid || {};
      apiCost = Number(h.combinedTotalUSD || effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
        grandVal.title = t('cost.hybridSub', { known: h.knownCostUSD || 0, res: h.unpricedResidualCostUSD || 0 });
      }
      if (grandSub) {
        grandSub.textContent = t('cost.hybridSub', {
          known: Number(h.knownCostUSD || 0).toFixed(2),
          res: Number(h.unpricedResidualCostUSD || 0).toFixed(2)
        });
      }
      pillText = t('cost.hybridBadge');
      pillClass = 'key-pill pill-muted';

      const rb = h.residualTokensBreakdown || {};
      if (inVal) inVal.textContent = `$${Number(rb.inputCostUSD || (Number(rb.input || 0) * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.input || 0) });
      if (caVal) caVal.textContent = `$${Number(rb.cacheCostUSD || (Number(rb.cache || 0) * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) });
      if (outVal) outVal.textContent = `$${Number(rb.outputCostUSD || (Number(rb.output || 0) * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.output || 0) });
    } else {
      // 仅已识别真实模型
      const pricedCount = Number(curIdentified.pricedRequestsCount || 0);
      const unpricedCount = Number(curIdentified.unpricedRequestsCount || 0);
      const totalCount = pricedCount + unpricedCount;
      apiCost = Number(curIdentified.pricedCostUSD || 0);

      if (grandVal) {
        if (totalCount === 0) {
          grandVal.textContent = t('cost.noRecords');
        } else if (pricedCount === 0) {
          grandVal.textContent = t('cost.unpriced');
          grandVal.title = t('cost.identSubNone');
        } else if (apiCost < 0.01 && apiCost > 0) {
          grandVal.textContent = '<$0.01';
          grandVal.title = `$${apiCost.toFixed(6)}`;
        } else {
          grandVal.textContent = `$${apiCost.toFixed(2)}`;
          grandVal.title = `$${apiCost.toFixed(4)}`;
        }
      }
      if (grandSub) {
        grandSub.textContent = pricedCount > 0
          ? t('cost.identSub', { n: pricedCount })
          : t('cost.identSubNone');
      }
      if (pricedCount === 0) {
        pillText = t('cost.covPct', { pct: 0 });
        pillClass = 'key-pill pill-warn';
      } else {
        const pct = curIdentified.coveragePercent != null ? curIdentified.coveragePercent : 0;
        pillText = t('cost.covPct', { pct });
        pillClass = `key-pill ${pct >= 100 ? 'pill-good' : 'pill-warn'}`;
      }

      if (inVal) inVal.textContent = `$${((curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${((curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6).toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${((curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curIdentified.byCategory?.outputTokens || 0)} tok`;
    }

    if (covPill) {
      covPill.textContent = pillText;
      covPill.className = pillClass;
      covPill.setAttribute?.('class', pillClass);
    }

    // 3. 用户实际支出渲染（首屏并列右栏）
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const curSymbol = ps.currencySymbol || '$';
    if (subSpendLbl) subSpendLbl.textContent = t('cost.subSpendLabel');

    const extraNoCompare = isPeriod ? '' : t('cost.allNoCompare');
    if (subSpendVal && subNote) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subSpendVal.textContent = `${curSymbol}0`;
        subNote.textContent = t('cost.freeActive', { src: ps.acquisitionSourceName || t('cost.freePromo'), extra: extraNoCompare });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        subSpendVal.textContent = `${curSymbol}${Number(ps.actualPricePaid).toFixed(2)}`;
        const expTag = ps.isExpired ? t('cost.expiredTag') : '';
        subNote.textContent = `${ps.acquisitionSourceName || t('cost.subSpend')} · ${t('cost.paidLabel')} (${ps.billingCycle || t('plan.summary.perMonth')})${expTag}${extraNoCompare}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        subSpendVal.textContent = t('cost.paidUnknown');
        subNote.textContent = `${t('cost.publicRefMonthly', { p: ps.officialPriceMonthly })}${extraNoCompare}`;
      } else {
        subSpendVal.textContent = t('cost.unknown');
        subNote.textContent = t('cost.noPlanData');
      }
    }

    const subLine = el('cost-sub-line');
    if (subLine) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subLine.textContent = t('cost.subLineFree', { sym: curSymbol, src: ps.acquisitionSourceName || t('plan.tag.promo') });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const cnyPart = (ps.currency !== 'CNY' && ps.cnyFormatted) ? ` (${ps.cnyFormatted})` : '';
        subLine.textContent = t('cost.subLinePaid', {
          sym: curSymbol,
          val: Number(ps.actualPricePaid).toFixed(2),
          cny: cnyPart,
          cycle: ps.billingCycle || t('plan.summary.perMonth'),
          exp: ps.isExpired ? ' · ⚠️' : ''
        });
      } else {
        subLine.textContent = t('cost.subUnknown');
      }
    }

    // 4. 用量与参考差额指标条（注明累计处理 Token，含缓存读取）
    if (usageSummary) {
      usageSummary.textContent = t('cost.usageSummary', { total: fmtYi(curTotal), cache: fmtYi(curCa) });
    }
    if (diffSummary) {
      if (!isPeriod) {
        diffSummary.textContent = t('cost.diffAll');
      } else if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        diffSummary.textContent = t('cost.diffFree', { val: apiCost.toFixed(2) });
      } else if (ps.actualPricePaid !== null && ps.currency === 'USD') {
        const diff = apiCost - Number(ps.actualPricePaid);
        diffSummary.textContent = t('cost.diffPaid', { sign: diff >= 0 ? '+' : '', val: diff.toFixed(2) });
      } else {
        diffSummary.textContent = t('cost.diffUnknown');
      }
    }

    // 5. 详细未计价原因说明
    if (breakdown) {
      const modelKeys = Object.keys(curIdentified.byModel || {});
      const modelDetails = modelKeys.map(k => `${k}: $${curIdentified.byModel[k].costUSD} (${fmt(curIdentified.byModel[k].tokens)} tok)`).join('; ');
      breakdown.textContent = t('cost.breakdownPrefix', {
        details: modelDetails || t('cost.breakdownNone'),
        note: ''
      });
    }

    // 6. 兼容性辅助隐藏层同步
    const refGrand = el('ref-cost-grand-val');
    if (refGrand) refGrand.textContent = t('cost.refApprox', { val: Number(curRef.totalCostUSD || 0).toFixed(2) });
  }

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = customColors.tokenAccent || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
  }

  function switchHeatView(view, save = true) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ savedHeatView: view });
    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    const isClosingNow = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (pop && !pop.hidden && !isClosingNow) {
      const isInsidePicker = path.includes(pop);
      const isSwatchBtn = path.some(n => n?.classList?.contains?.('color-swatch-btn') || n?.classList?.contains?.('heat-leg-swatch') || n?.id?.startsWith?.('swatch-') || n?.id?.startsWith?.('heat-leg-'));
      if (!isInsidePicker && !isSwatchBtn) {
        closeColorPicker();
      }
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      const pop = el('color-picker-popover');
      const isEscClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
      if (pop && !pop.hidden && !isEscClosing) {
        const returnFocus = activePickerAnchor;
        closeColorPicker();
        returnFocus?.focus?.();
        return;
      }
      const tokenDrawer = el('token-color-drawer-body');
      if (tokenDrawer && tokenDrawer.style.display !== 'none') {
        toggleTokenColorsDrawer(false);
        btnTokenColors?.focus?.();
        return;
      }
      const colorDrawer = el('color-drawer-body');
      if (colorDrawer && colorDrawer.style.display !== 'none') {
        toggleColorsDrawer(false);
        btnColors?.focus?.();
        return;
      }
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);

  // =========================================================================
  // 模块 4: 数据渲染、完整本地 Token 历史读取与首次使用日起算时间轴
  // =========================================================================
  function renderFiles(session) {
    const parent = el('files'); parent.replaceChildren();
    if (!session) { const item = document.createElement('p'); item.textContent = t('files.reading'); parent.appendChild(item); return; }
    if (!Array.isArray(session.attachments) || !session.attachments.length) { const item = document.createElement('p'); item.textContent = t('files.empty'); parent.appendChild(item); return; }
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? t('files.refs', { n: file.references }) : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      const sizeInfo = file.width && file.height
        ? t('files.px', { w: file.width, h: file.height })
        : (typeof file.chars === 'number' && file.chars > 0 ? t('files.chars', { n: fmt(file.chars) }) : '');
      const tokenInfo = range(file) ? `${range(file)} token` : t('files.tokUnknown');
      const sheetsPart = file.sheets != null ? t('files.sheets', { sheets: file.sheets, cells: fmt(file.cells) }) : '';
      const hiddenPart = file.hiddenSheets ? t('files.hiddenSheets', { n: file.hiddenSheets }) : '';
      detail.textContent = `${file.source === 'assistant' ? t('files.assistantPrefix') : ''}${tokenInfo}${sizeInfo ? ` · ${sizeInfo}` : ''}${sheetsPart}${hiddenPart}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = t('files.unknownPrefix', { parts: file.unknownParts.join('；') }); item.appendChild(unknown); }
      parent.appendChild(item);
    }
  }

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString('en-US');
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  function parseLocalYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDotYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  function formatZhYmd(ymd) {
    const d = parseLocalYmd(ymd);
    if (!d) return ymd || '—';
    if (currentPanelLanguage === 'en') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function addDays(baseDate, deltaDays) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() + deltaDays);
    return d;
  }

  function getFirstUseDateStr() {
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (map[k]?.total > 0)).sort();
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return formatLocalYmd(new Date());
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = parseLocalYmd(firstStr) || today;
    const totalDays = 52 * 7; // 364 天（12 个月 / 52 周）
    const elapsedDays = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / 86400000)) + 1;

    let winStart;
    let winEnd;
    let canPrev = false;
    let canNext = false;

    if (elapsedDays <= totalDays) {
      // 使用未满一年：起点固定为实际首次使用日，向后铺满 12 个月（前置空白为 0）
      heatPageOffset = 0;
      winStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      winEnd = addDays(winStart, totalDays - 1);
    } else {
      // 使用满一年后：默认窗口滚动为「以今天结尾的最近 12 个月」，且起点永不早于首次使用日；支持 ‹ / › 翻页回看更早归档
      const latestStart = addDays(today, -(totalDays - 1));
      const stepDays = 26 * 7; // 每次翻页半年度（26 周）
      let candidateStart = addDays(latestStart, heatPageOffset * stepDays);
      if (candidateStart.getTime() <= firstDate.getTime()) {
        candidateStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const maxBackSteps = -Math.ceil((latestStart.getTime() - firstDate.getTime()) / (stepDays * 86400000));
        if (heatPageOffset < maxBackSteps) heatPageOffset = maxBackSteps;
      }
      winStart = candidateStart;
      winEnd = addDays(winStart, totalDays - 1);
      canPrev = winStart.getTime() > firstDate.getTime();
      canNext = heatPageOffset < 0;
    }

    const firstBadge = el('first-use-badge');
    if (firstBadge) firstBadge.textContent = t('tokens.firstUse', { date: formatZhYmd(firstStr) });
    const rangeEl = el('h-win-range');
    const prevBtn = el('h-page-prev');
    const nextBtn = el('h-page-next');

    if (activeHeatView === 'monthly') {
      const targetMonthDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
      const targetY = targetMonthDate.getFullYear();
      const targetM = targetMonthDate.getMonth();
      const firstY = firstDate.getFullYear();
      const firstM = firstDate.getMonth();
      const targetMonthKey = targetY * 12 + targetM;
      const firstMonthKey = firstY * 12 + firstM;
      canPrev = targetMonthKey > firstMonthKey;
      canNext = heatMonthOffset < 0;
      if (rangeEl) rangeEl.textContent = t('tokens.range.month', { y: targetY, m: currentPanelLanguage === 'en' ? String(targetM + 1).padStart(2, '0') : (targetM + 1) });
    } else if (activeHeatView === 'yearly') {
      const thisY = today.getFullYear();
      const targetY = thisY + heatYearOffset;
      const firstY = firstDate.getFullYear();
      canPrev = targetY > firstY;
      canNext = heatYearOffset < 0;
      if (rangeEl) {
        rangeEl.textContent = (targetY === thisY) ? t('tokens.range.yearToToday', { y: targetY }) : t('tokens.range.year', { y: targetY });
      }
    } else {
      if (rangeEl) rangeEl.textContent = `${formatDotYmd(winStart)} – ${formatDotYmd(winEnd)}`;
    }

    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;

    return { firstStr, firstDate, today, winStart, winEnd, totalDays, canPrev, canNext };
  }

  function applyTokenHistoryPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (Array.isArray(payload.speedRecords)) {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = payload.speedRecords;
      if (!isContextSettingsView && activeContextTab === 'speed') {
        renderSpeedComparisonTab();
      } else if (!isContextSettingsView && activeContextTab === 'models') {
        renderModelSettingsTab();
      }
    }
    if (payload.modelCapabilitiesById && typeof payload.modelCapabilitiesById === 'object') {
      mergeCapabilitiesMapClient(payload.modelCapabilitiesById);
    }
    if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
      const hasExisting = Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0;
      const incomingHasCaps = payload.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      const existingHasCaps = hasExisting && state.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!hasExisting || (incomingHasCaps && !existingHasCaps)) {
        state.cascadeModelConfigs = payload.cascadeModelConfigs;
        renderHeaderModelDropdown();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    }

    const hasExistingData = Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0;
    const incomingKeys = Object.keys(payload.dailyMap || {});
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(payload.dailyMap[k]?.total) || 0), 0);
    const hasIncomingRefCost = Boolean(payload.referenceCost?.currentMonth?.totalCostUSD || payload.referenceCost?.all?.totalCostUSD);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || incomingTotal > 0 || hasIncomingRefCost;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(payload, { source: activeTokenSource, todayStr })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.referenceCost = normalized.referenceCost;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      if (normalized.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate;
      if (normalized.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = normalized.updatedAt;
    } else {
      const newMap = {};
      if (payload.dailyMap && typeof payload.dailyMap === 'object') {
        for (const [dKey, rec] of Object.entries(payload.dailyMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || !rec) continue;
          newMap[dKey] = {
            total: Number(rec.total) || 0,
            input: Number(rec.input) || 0,
            output: Number(rec.output) || 0,
            cache: Number(rec.cache) || 0,
            steps: Number(rec.steps) || 0
          };
        }
      }
      ANTIGRAVITY_TOKEN_DATA.dailyMap = newMap;
      if (payload.dailyMapBySource) ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = payload.dailyMapBySource;
      if (payload.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = payload.firstUseDate;
      if (payload.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = payload.updatedAt;
      if (payload.currentPeriod) ANTIGRAVITY_TOKEN_DATA.currentPeriod = payload.currentPeriod;
      if (payload.referenceCost) ANTIGRAVITY_TOKEN_DATA.referenceCost = payload.referenceCost;

      const keys = Object.keys(newMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && newMap[k]?.total > 0).sort();
      const monthPrefix = todayStr.slice(0, 7);
      const yearPrefix = todayStr.slice(0, 4);
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, yearTokens = 0, monthDays = 0;
      let totalInput = 0, totalOutput = 0, totalCache = 0;
      let curMonthInput = 0, curMonthOutput = 0, curMonthCache = 0;
      for (const k of keys) {
        const r = newMap[k];
        const t = Number(r.total) || 0;
        totalTokens += t;
        totalInput += Number(r.input) || 0;
        totalOutput += Number(r.output) || 0;
        totalCache += Number(r.cache) || 0;
        if (k === todayStr) todayTokens += t;
        if (k.startsWith(monthPrefix)) {
          monthTokens += t;
          curMonthInput += Number(r.input) || 0;
          curMonthOutput += Number(r.output) || 0;
          curMonthCache += Number(r.cache) || 0;
          monthDays += 1;
        }
        if (k.startsWith(yearPrefix)) yearTokens += t;
      }
      const rawSum = payload.summary || {};
      ANTIGRAVITY_TOKEN_DATA.summary = {
        grandTotalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        totalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        todayTokens: todayTokens > 0 ? todayTokens : (Number(rawSum.todayTokens) || 0),
        monthTokens: Math.max(monthTokens, Number(rawSum.monthTokens) || 0),
        yearTokens: Math.max(yearTokens, Number(rawSum.yearTokens) || 0),
        totalInputTokens: Math.max(totalInput, Number(rawSum.totalInputTokens) || 0),
        totalOutputTokens: Math.max(totalOutput, Number(rawSum.totalOutputTokens) || 0),
        totalCacheTokens: Math.max(totalCache, Number(rawSum.totalCacheTokens) || 0),
        currentMonthInput: Math.max(curMonthInput, Number(rawSum.currentMonthInput) || 0),
        currentMonthOutput: Math.max(curMonthOutput, Number(rawSum.currentMonthOutput) || 0),
        currentMonthCache: Math.max(curMonthCache, Number(rawSum.currentMonthCache) || 0),
        totalDays: keys.length,
        totalConversations: Number(rawSum.totalConversations) || keys.length,
        firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
      };
    }

    if (payload.planStatus || payload.customPlanSettings) {
      let mergedPlan = payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      try {
        const email = mergedPlan.email || 'default';
        let customObj = lastSavedCustomPlan || payload.customPlanSettings || null;
        if (!customObj && typeof window !== 'undefined' && window.__AGContextMeterSettings?.customPlan) {
          customObj = window.__AGContextMeterSettings.customPlan;
        }
        if (!customObj) {
          const savedCustomRaw = localStorage?.getItem('ag_custom_plan_' + email.toLowerCase()) || localStorage?.getItem('ag_custom_plan_default');
          if (savedCustomRaw) customObj = JSON.parse(savedCustomRaw);
        }
        if (customObj && typeof customObj === 'object') {
          lastSavedCustomPlan = { ...customObj };
          try {
            const jsonStr = JSON.stringify(customObj);
            if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + email.toLowerCase(), jsonStr);
            localStorage?.setItem('ag_custom_plan_default', jsonStr);
          } catch {}
          if (core && core.resolveEffectivePlanStatus) {
            mergedPlan = core.resolveEffectivePlanStatus(payload.rawPlanStatus || payload.planStatus, customObj, { currentEmail: email });
          }
        }
      } catch {}
      ANTIGRAVITY_TOKEN_DATA.planStatus = mergedPlan;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus || mergedPlan;
      renderPlanDetail(mergedPlan);
    }

    if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimate = payload.costEstimate;
    }
    if (payload.costEstimateCurrentMonth) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = payload.costEstimateCurrentMonth;
    }
    if (payload.costEstimateBySource) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = payload.costEstimateBySource;
    } else if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = {
        all: payload.costEstimate,
        desktop: payload.costEstimate,
        cli: { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {} }
      };
    }

    // 重新汇总卡片统计与顶栏
    const sum = ANTIGRAVITY_TOKEN_DATA.summary;
    const totalTokens = sum.grandTotalTokens;
    const shownToday = sum.todayTokens;
    const monthTokens = sum.monthTokens;
    const yearTokens = sum.yearTokens;
    const convCount = sum.totalConversations;
    const totalDays = sum.totalDays || Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length;
    const avgMonth = Math.round(monthTokens / Math.max(1, totalDays));

    const fmtCardM = v => {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    };
    const badgeAmt = el('token-amount');
    const badgeExtra = el('token-hover-extra');
    const overAmt = el('overflow-tokens-val');
    if (badgeAmt) badgeAmt.textContent = fmtCardM(totalTokens);
    if (badgeExtra) badgeExtra.textContent = t('tokens.badge.today', { val: fmtCardM(shownToday) });
    if (overAmt) overAmt.textContent = fmtCardM(totalTokens);

    const tTotalVal = el('t-total-val');
    const tTotalSub = el('t-total-sub');
    const tTodayVal = el('t-today-val');
    const tTodaySub = el('t-today-sub');
    const tMonthVal = el('t-month-val');
    const tMonthSub = el('t-month-sub');
    const tYearVal = el('t-year-val');
    const tYearSub = el('t-year-sub');

    if (tTotalVal) tTotalVal.textContent = fmtCardM(totalTokens);
    if (tTotalSub) tTotalSub.textContent = `${totalTokens.toLocaleString('en-US')} Tokens`;
    if (tTodayVal) tTodayVal.textContent = fmtCardM(shownToday);
    if (tTodaySub) tTodaySub.textContent = t('tokens.card.todaySub', { n: convCount });
    if (tMonthVal) tMonthVal.textContent = fmtCardM(monthTokens);
    if (tMonthSub) tMonthSub.textContent = t('tokens.card.monthSub', { val: fmtCardM(avgMonth) });
    if (tYearVal) tYearVal.textContent = fmtCardM(yearTokens);
    if (tYearSub) tYearSub.textContent = t('tokens.card.yearSub', { n: totalDays });

    // 聚合全周期各区间预估费用
    const allDateKeys = Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap || {});
    const nowYmd = todayStr;
    const thisMonthPrefix = nowYmd.slice(0, 7);
    const thisYearPrefix = nowYmd.slice(0, 4);

    const todayCostInfo = getDailyModelCost(ANTIGRAVITY_TOKEN_DATA.dailyMap[nowYmd], nowYmd, activeCostModel, { mode: activeCostMode });
    const todayCostCny = convertToCNY(todayCostInfo.costUSD, 'USD');

    const totalCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, allDateKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const totalCostCny = convertToCNY(totalCostAgg.totalCostUSD, 'USD');

    const monthKeys = allDateKeys.filter(k => k.startsWith(thisMonthPrefix) && k <= nowYmd);
    const monthCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, monthKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const monthCostCny = convertToCNY(monthCostAgg.totalCostUSD, 'USD');

    const yearKeys = allDateKeys.filter(k => k.startsWith(thisYearPrefix) && k <= nowYmd);
    const yearCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, yearKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const yearCostCny = convertToCNY(yearCostAgg.totalCostUSD, 'USD');

    const tTotalCost = el('t-total-cost');
    const tTodayCost = el('t-today-cost');
    const tMonthCost = el('t-month-cost');
    const tYearCost = el('t-year-cost');

    if (tTotalCost) {
      tTotalCost.textContent = `≈ $${totalCostAgg.totalCostUSD.toFixed(2)}${totalCostCny !== null ? ` (¥${totalCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: totalCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tTodayCost) {
      tTodayCost.textContent = `≈ $${todayCostInfo.costUSD.toFixed(2)}${todayCostCny !== null ? ` (¥${todayCostCny.toFixed(2)})` : ''}`;
    }
    if (tMonthCost) {
      tMonthCost.textContent = `≈ $${monthCostAgg.totalCostUSD.toFixed(2)}${monthCostCny !== null ? ` (¥${monthCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: monthCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tYearCost) {
      tYearCost.textContent = `≈ $${yearCostAgg.totalCostUSD.toFixed(2)}${yearCostCny !== null ? ` (¥${yearCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: yearCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }

    // 规范化已完整保留输入/缓存/输出分类，执行费用视图渲染
    renderActiveCostEstimateView();

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }


  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return;
    let changed = false;
    const hasFinalCall = calls.some(c => c?.status === 'final');
    try {
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function') {
        const res = await window.contextMeterAPI.recordCalls(calls);
        if (res && res.ok === false) {
          console.warn('Context Meter: 记录调用入账失败', res.error);
        } else if (res?.changed) {
          changed = true;
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/record-calls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ calls })
        });
        if (!resp.ok) {
          console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${resp.status}`);
        } else {
          const res = await resp.json().catch(() => null);
          if (res && res.ok === false) {
            console.warn('Context Meter: 实时通道 record-calls 失败', res.error);
          } else if (res?.changed) {
            changed = true;
          }
        }
      }
      if (changed || hasFinalCall) {
        void syncTokenHistoryFromHost(false);
      }
    } catch (err) {
      console.warn('Context Meter: 调用入账发生异常', err);
    }
  }

  async function restoreSettingsFromHost() {
    if (state.disposed) return;
    const thisSeq = ++restoreRequestSeq;
    const startActionSeq = userActionSeq;
    try {
      let settingsRes = null;
      const currentEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';

      // 权威配置同步：宿主通信桥接可用时，以宿主最新持久化配置为准，避免启动快照覆盖最新状态
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function') {
        settingsRes = await window.contextMeterAPI.getSettings({ email: currentEmail });
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/get-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ email: currentEmail })
        });
        if (r.ok) settingsRes = await r.json().catch(() => null);
      } else if (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
        settingsRes = window.__AGContextMeterSettings;
      }

      // 若在网络等待期间有更新的恢复请求完成或用户发生了最新主动修改，丢弃旧回包！
      if (thisSeq < restoreRequestSeq || userActionSeq > startActionSeq) {
        return;
      }

      if (settingsRes?.ok) {
        if (settingsRes.uiPreferences?.restartVerification && typeof settingsRes.uiPreferences.restartVerification === 'object') {
          pendingRestartVerification = { ...settingsRes.uiPreferences.restartVerification };
          void refreshUnlockStatus();
        }
        if (settingsRes.contextScopeMode) {
          contextScopeMode = settingsRes.contextScopeMode === 'per_model' ? 'per_model' : 'unified';
        } else {
          const hasPerModelPrefs = settingsRes.contextPreferences && Object.values(settingsRes.contextPreferences).some(p => p && p.mode && p.mode !== 'default');
          contextScopeMode = hasPerModelPrefs ? 'per_model' : 'unified';
        }

        if (settingsRes.contextUnifiedPreference && typeof settingsRes.contextUnifiedPreference === 'object') {
          contextUnifiedPreference = { ...settingsRes.contextUnifiedPreference };
        } else {
          contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
        }

        if (settingsRes.contextPreferences && typeof settingsRes.contextPreferences === 'object') {
          contextPreferencesMap = { ...settingsRes.contextPreferences };
        }
        syncContextPreferencesCache(contextPreferencesMap);
        renderHeaderModelDropdown();
        if (!ctxDraftDirty) loadDraftFromSelectedModel(true);
        else renderCompactSessionCard();
        const savedView = settingsRes.savedHeatView || settingsRes.uiPreferences?.savedHeatView;
        if (savedView && ['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(savedView)) {
          switchHeatView(savedView, false);
        }
        const savedAutoUpdate = settingsRes.autoCheckUpdate !== undefined
          ? settingsRes.autoCheckUpdate
          : settingsRes.uiPreferences?.autoCheckUpdate;
        if (savedAutoUpdate !== undefined) {
          autoCheckUpdate = savedAutoUpdate !== false;
          const chk = el('check-auto-update');
          if (chk) chk.checked = autoCheckUpdate;
        }
        const savedLang = settingsRes.panelLanguage || settingsRes.uiPreferences?.panelLanguage;
        if (savedLang && ['zh-CN', 'zh-TW', 'en'].includes(savedLang) && savedLang !== currentPanelLanguage) {
          await applyPanelLanguage(savedLang, { persist: false });
        }
      } else {
        try {
          const localLang = localStorage?.getItem('ag_panel_language');
          if (localLang && ['zh-CN', 'zh-TW', 'en'].includes(localLang) && localLang !== currentPanelLanguage) {
            await applyPanelLanguage(localLang, { persist: false });
          }
        } catch {}
      }

      if (settingsRes?.ok && settingsRes.customPlan && typeof settingsRes.customPlan === 'object') {
        lastSavedCustomPlan = { ...settingsRes.customPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ok: true,
            customPlan: { ...settingsRes.customPlan },
            contextPreferences: { ...contextPreferencesMap }
          };
        }

        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || settingsRes.customPlan?.account || currentEmail || 'default';
        try {
          const jsonStr = JSON.stringify(settingsRes.customPlan);
          if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch {}
        applyCustomPlanObjectLocally(settingsRes.customPlan, email);
      } else {
        // 回退检查 localStorage
        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';
        const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
        const savedRaw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
        if (savedRaw) {
          const parsed = JSON.parse(savedRaw);
          if (parsed && typeof parsed === 'object') {
            lastSavedCustomPlan = { ...parsed };
            applyCustomPlanObjectLocally(parsed, parsed.account || email);
          }
        }
      }
    } catch {}
  }

  let historySyncBusy = false;
  let pendingHistoryForce = false;
  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      if (force) {
        pendingHistoryForce = true;
      }
      return;
    }
    historySyncBusy = true;
    try {
      await restoreSettingsFromHost();
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function') {
        const res = await window.contextMeterAPI.getTokenHistory(Boolean(force));
        if (res?.ok && res.data) {
          if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
          applyTokenHistoryPayload(res.data);
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/token-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ force: Boolean(force) })
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.ok && j.data) {
            if (typeof window !== 'undefined') window.__AGContextMeterHistory = j.data;
            applyTokenHistoryPayload(j.data);
          }
        }
      }
    } catch {}
    finally {
      historySyncBusy = false;
      if (pendingHistoryForce) {
        pendingHistoryForce = false;
        void syncTokenHistoryFromHost(true);
      }
      if (autoCheckUpdate) {
        setTimeout(() => { void checkAppUpdate(false); }, 1200);
      }
    }
  }

  function openGithubRepo(pathSuffix = '') {
    const url = 'https://github.com/elviscjn-cjn/antigravity-context-viewer' + pathSuffix;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.openExternal === 'function') {
      window.contextMeterAPI.openExternal(url);
    } else {
      window.open?.(url, '_blank');
    }
  }

  let currentUpdateTrigger = 'tokens';

  function positionUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    const triggerBtn = trigger === 'ctx' ? el('btn-check-update-ctx') : el('btn-check-update');
    if (!triggerBtn || typeof triggerBtn.getBoundingClientRect !== 'function') return;
    const rect = triggerBtn.getBoundingClientRect();
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024;
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 768) : 768;
    let right = Math.max(14, winW - rect.right);
    let top = rect.bottom + 8;
    if (top + 220 > winH) {
      top = Math.max(10, rect.top - 230);
    }
    pop.style.position = 'fixed';
    pop.style.top = `${Math.round(top)}px`;
    pop.style.right = `${Math.round(right)}px`;
    pop.style.left = 'auto';
  }

  function showUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    currentUpdateTrigger = trigger;
    positionUpdatePopover(trigger);
    pop.style.display = 'block';
  }

  function hideUpdatePopover() {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      const pop = el('update-popover');
      if (pop && pop.style.display === 'block') {
        positionUpdatePopover();
      }
    });
  }

  async function checkAppUpdate(manual = false, trigger = currentUpdateTrigger) {
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    const pop = el('update-popover');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const statusEl = el('up-pop-status');
    const applyBtn = el('btn-apply-update');

    // 检查桥接是否存在；若缺失则直接判定为更新功能不可用，严禁显示“最新”
    const currentVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.3';
    const hasBridge = typeof window !== 'undefined' && typeof window.contextMeterAPI?.checkUpdate === 'function';
    if (!hasBridge) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.unavailableTitle');
      if (verEl) verEl.textContent = t('update.unavailableVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.unavailableBody');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      if (manual) showUpdatePopover(trigger);
      return;
    }

    if (manual) {
      cachedLatestRelease = null;
      showUpdatePopover(trigger);
      if (titleEl) titleEl.textContent = t('update.checkingTitle');
      if (verEl) verEl.textContent = t('update.checkingVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.connecting');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
    }

    try {
      const res = await window.contextMeterAPI.checkUpdate({ force: manual, currentVersion: currentVer });

      // 返回 null、非对象或 ok: false 均为检查失败，严禁显示“最新”
      if (!res || res.ok === false) {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.failedTitle');
        if (verEl) verEl.textContent = t('update.failedVer', { ver: currentVer });
        const errMsg = res?.error ? translateBackendText(res.error) : t('update.failedFetch');
        if (bodyEl) bodyEl.textContent = t('update.failedBody', { err: errMsg });
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        if (manual) showUpdatePopover(trigger);
        return;
      }

      if (res.hasUpdate && res.latestVersion) {
        cachedLatestRelease = res;
        if (dot) dot.style.display = 'block';
        if (dotCtx) dotCtx.style.display = 'block';
        if (titleEl) titleEl.textContent = t('update.foundTitle');
        if (verEl) verEl.textContent = `v${res.currentVersion || currentVer} → v${res.latestVersion}`;
        if (bodyEl) {
          bodyEl.textContent = t('update.foundBody', { ver: res.latestVersion, notes: res.releaseNotes || t('update.defaultNotes') });
        }
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = t('update.applyNow');
          applyBtn.style.display = 'inline-block';
        }
        if (manual) showUpdatePopover(trigger);
      } else {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.latestTitle');
        const effectiveCurrent = res.installedVersion || res.currentVersion || currentVer;
        if (verEl) verEl.textContent = t('update.latestVer', { ver: effectiveCurrent });
        const updateStatusText = res.diskPendingRestart
          ? t('update.diskPending', { ver: effectiveCurrent })
          : t('update.latestBody', { ver: effectiveCurrent });
        if (bodyEl) bodyEl.textContent = updateStatusText;
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        if (manual) showUpdatePopover(trigger);
      }
    } catch (err) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.failedTitle');
      if (verEl) verEl.textContent = t('update.failedVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.failedNetBody', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      if (manual) showUpdatePopover(trigger);
    }
  }

  async function applyAppUpdate() {
    const pop = el('update-popover');
    const applyBtn = el('btn-apply-update');
    const statusEl = el('up-pop-status');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    if (!cachedLatestRelease) return;

    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = t('update.updatingBtn');
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = t('update.downloading');
    }

    try {
      let res = null;
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.applyUpdate === 'function') {
        res = await window.contextMeterAPI.applyUpdate({ version: cachedLatestRelease.latestVersion });
      } else {
        throw new Error(t('update.noApi'));
      }
      if (res && res.ok) {
        const targetVer = res.version || res.installedVersion || cachedLatestRelease?.latestVersion || currentVer;
        currentVer = targetVer;
        const vEl = el('v');
        if (vEl) vEl.textContent = `v${currentVer}`;

        const dot = el('update-badge-dot');
        const dotCtx = el('update-badge-dot-ctx');
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';

        if (titleEl) titleEl.textContent = t('update.doneTitle');
        if (verEl) verEl.textContent = t('update.doneVer', { ver: currentVer });
        if (bodyEl) {
          bodyEl.textContent = res.liveInjected
            ? t('update.doneHot', { ver: currentVer })
            : t('update.doneDisk', { ver: currentVer });
        }
        if (applyBtn) {
          applyBtn.textContent = t('update.btnUpdated');
          applyBtn.disabled = false;
        }

        if (res.liveInjected) {
          if (statusEl) statusEl.textContent = t('update.doneHot', { ver: currentVer });
        } else {
          if (statusEl) statusEl.textContent = t('update.doneDisk', { ver: currentVer });
        }
        setTimeout(() => {
          if (pop) pop.style.display = 'none';
        }, 3500);
      } else {
        if (statusEl) statusEl.textContent = t('update.failStatus', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = t('update.errStatus', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
    }
  }

  el('btn-github-repo')?.addEventListener('click', () => openGithubRepo());
  el('btn-github-repo-ctx')?.addEventListener('click', () => openGithubRepo());
  el('btn-check-update')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'tokens') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'tokens');
    }
  });
  el('btn-check-update-ctx')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'ctx') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'ctx');
    }
  });
  el('btn-close-update-pop')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-update-later')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-view-release-page')?.addEventListener('click', () => {
    openGithubRepo(cachedLatestRelease?.tagName ? `/releases/tag/${cachedLatestRelease.tagName}` : '/releases');
  });
  el('btn-apply-update')?.addEventListener('click', () => void applyAppUpdate());

  el('check-auto-update')?.addEventListener('change', e => {
    autoCheckUpdate = e.target.checked;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ autoCheckUpdate });
    }
  });

  /* @INSERT_HEATMAP_MODULE */
  function updateRingAndBubble(d, session, pct, danger, stale, incomplete) {
    const ringFill = el('ring-fill');
    const tipTitle = el('ctx-tip-title');
    const tipPct = el('ctx-tip-pct');
    const tipDetail = el('ctx-tip-detail');

    // 区分常态颜色与高占用告警状态
    let occupancy = 'normal';
    if (danger || (pct != null && pct >= 90)) {
      occupancy = 'danger';
    } else if ((pct != null && pct >= 75) || stale) {
      occupancy = 'warn';
    }
    host.setAttribute('data-occupancy', occupancy);

    // 1. 圆环进度与未知容量状态表达（未知容量绝不画成 0% 或 100%）
    if (ringFill) {
      if (d?.exceeded) {
        ringFill.setAttribute('data-ring-state', 'exceeded');
        ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '1';
      } else if (pct != null) {
        ringFill.setAttribute('data-ring-state', 'determinate');
        if (pct <= 0) {
          ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '0';
        } else {
          const arcLen = Math.max(1.8, (Math.min(100, pct) / 100) * RING_CIRCUMFERENCE);
          ringFill.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '1';
        }
      } else {
        // 容量未知 / 仅估算 / 尚未就绪：使用均匀虚线环段表示非确定比例，不画成 0% 空环或 100% 满环
        ringFill.setAttribute('data-ring-state', d?.estimated ? 'estimated' : 'unknown');
        ringFill.setAttribute('stroke-dasharray', '3.2 4.97');
        ringFill.style.opacity = '0.55';
      }
    }

    // 2. 悬停信息气泡三层文案（标题 — 使用比例 — 用量与容量）
    if (!tipTitle || !tipPct || !tipDetail) return;

    const disp = resolveDisplayStatus(d, session);
    if (disp.isError || disp.kind === 'canceled') {
      tipTitle.textContent = disp.tipTitle;
      tipPct.textContent = disp.tipPct;
      tipDetail.textContent = disp.tipDetail;
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleVal', { used: usedRound, rem: remRound });
      tipDetail.textContent = t('tip.detail.usedOfBudget', { used: fmtBubbleToken(d.actual), budget: fmtBubbleToken(d.budget), inc: '' });
    } else if (stale) {
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleUnknown');
      tipDetail.textContent = session?.total
        ? t('tip.detail.sessionEst', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) })
        : t('tip.detail.waitBg');
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = t('tip.title.high90');
        tipPct.textContent = t('tip.pct.high90', { used: usedRound, rem: remRound });
      } else if (rawPct >= 75) {
        tipTitle.textContent = t('tip.title.high75');
        tipPct.textContent = t('tip.pct.high75', { used: usedRound, rem: remRound });
      } else {
        tipTitle.textContent = t('tip.title.normal');
        tipPct.textContent = t('tip.pct.normal', { used: usedRound, rem: remRound });
      }
      tipDetail.textContent = t('tip.detail.usedOfBudget', {
        used: fmtBubbleToken(d.actual),
        budget: fmtBubbleToken(d.budget),
        inc: incomplete ? t('tip.detail.incSuffix') : ''
      });
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noBudget');
      tipDetail.textContent = t('tip.detail.usedNoBudget', { used: fmtBubbleToken(d.actual) });
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.estOnly');
      const budgetPart = d.budget ? t('tip.detail.estBudgetPart', { budget: fmtBubbleToken(d.budget) }) : t('tip.detail.estNoBudgetPart');
      tipDetail.textContent = t('tip.detail.estUsed', { used: fmtBubbleToken(d.estimate), budget: budgetPart });
    } else if (session?.total) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.waitStats');
      tipDetail.textContent = t('tip.detail.sessionCum', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) });
    } else {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.notReady');
      tipDetail.textContent = t('tip.detail.readingSession');
    }

    if (state.tooltipOpen) positionContextTooltip();
  }

  function syncSpeedBadgeText() {
    const sp = state.latest?.speed;
    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    if (!speedAmount) return;
    const isCompact = state.layoutMode === 'compact';
    if (sp?.tps != null) {
      speedAmount.textContent = isCompact ? `${sp.tps}` : `${sp.tps} tok/s`;
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${sp.tps} tok/s`;
    } else if (state.requestBusy) {
      const calcText = t('badge.speedCalc');
      speedAmount.textContent = isCompact ? '…' : calcText;
      if (overflowSpeedVal) overflowSpeedVal.textContent = calcText;
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  // 渲染上下文与全局状态（无论在主页 / 还是会话页 /c/<id>，始终保持插件栏挂载与可用）
  function render() {
    host.hidden = false;
    host.setAttribute('data-has-session', state.route ? 'true' : 'false');
    ensureHostDocked();
    if (!state.route) {
      hideContextTooltip();
      const barFill = el('bar-fill');
      if (barFill) barFill.style.width = '0%';
      const badgePctVal = el('badge-pct-val');
      if (badgePctVal) badgePctVal.textContent = '--%';
      el('amount').textContent = t('badge.noSession');
      setHoverExtra(t('badge.clickOpenCli'));
      syncSpeedBadgeText();
      el('badge-tokens').title = t('badge.tokensTitle');
      return;
    }
    renderSessionCost();

    const d = state.latest, session = state.scan?.session;
    const disp = resolveDisplayStatus(d, session);
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = disp.isError || d?.exceeded;

    let pct = null;
    if (d?.exceeded) {
      pct = 100;
    } else if (d?.percent != null && !danger && !stale) {
      pct = Math.min(100, Math.max(0, d.percent));
    } else if (d?.actual != null && d?.budget && !danger && !stale) {
      pct = Math.min(100, Math.max(0, (d.actual / d.budget) * 100));
    }

    const barColor = danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff';
    const tone = danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff';
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

    updateRingAndBubble(d, session, pct, danger, stale, incomplete);

    syncContextModelSelectionFromState();

    // 若观测到的上下文预算变化且抽屉已展开或尚未读取状态，触发一次轻量同步（不再据此判定真实请求已验证）
    if (d?.budget && d.budget !== lastAutoObservedBudget && d.budget > 256000) {
      lastAutoObservedBudget = d.budget;
      if (currentUnlockStatus || (unlockDrawerBody && unlockDrawerBody.style.display === 'block')) {
        void refreshUnlockStatus();
      }
    }

    const status = disp.isError
      ? disp.statusText
      : stale ? t('badge.status.stale')
      : state.scanError ? t('badge.status.scanErr', { err: translateBackendText(state.scanError) })
      : incomplete ? t('badge.status.incomplete', { count: session.unknownFiles })
      : d?.estimated ? t('badge.status.estimated')
      : t('badge.status.normal');
    el('status').textContent = status;

    const corpus = session?.total
      ? t('badge.corpus.range', { range: range(session.total), inc: incomplete ? t('badge.corpus.incPlus') : '' })
      : state.scanBusy ? t('badge.corpus.scanning') : t('badge.corpus.pending');

    const badgePctVal = el('badge-pct-val');
    if (disp.isError || disp.kind === 'canceled') {
      el('amount').textContent = disp.amountText;
      if (badgePctVal) badgePctVal.textContent = disp.badgeText;
      setHoverExtra(disp.hoverExtra);
    } else if (stale) {
      el('amount').textContent = t('badge.delayed');
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      el('amount').textContent = `${short(d.actual)}${pctStr}`;
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      el('amount').textContent = t('badge.actualUnknown');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(` · ${corpus}`);
    }

    el('badge-tokens').title = t('badge.tokensTitle');

    // 渲染输出速度 (统一使用 tok/s)
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedHoverExtra = el('speed-hover-extra');
    syncSpeedBadgeText();
    if (speedBadge) {
      if (sp?.tps != null) {
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
        speedBadge.title = t('badge.speedTitleDetail', {
          tps: sp.tps,
          streaming: sp.streamingTps ? t('badge.speedStreamingPart', { tps: sp.streamingTps }) : '',
          duration: sp.duration || '—',
          ttft: sp.ttft || '—',
          streamSec: sp.streamingSec || '—',
          output: fmt(sp.outputTokens)
        });
      } else if (state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = t('badge.speedTitleWait');
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = t('badge.speedHoverIdle');
        speedBadge.title = t('badge.speedTitleIdle');
      }
    }

    if (el('key-summary')) {
      const keyBar = el('key-bar-fill');
      const keyBadge = el('key-badge');
      const keyUsed = el('key-used');
      const keyLimit = el('key-limit');
      const keyRemaining = el('key-remaining');
      const keyTakeaway = el('key-takeaway');

      if (keyBar) keyBar.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

      if (disp.isError || disp.kind === 'canceled') {
        if (keyBadge) {
          keyBadge.textContent = disp.keyBadgeText;
          keyBadge.className = disp.pillClass;
        }

        const usedTokenCount = d?.actual != null ? d.actual : (d?.used != null ? d.used : (d?.estimate != null ? d.estimate : (session?.total?.low ?? null)));
        const budgetTokenCount = d?.budget || (d?.serviceLimit ? d.serviceLimit : 983040);

        if (disp.isOverflow) {
          if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : t('key.overflowUsed');
          if (keyLimit) keyLimit.textContent = d.serviceLimit ? short(d.serviceLimit) : short(budgetTokenCount);
          if (keyRemaining) keyRemaining.textContent = t('key.overflowRem');
        } else {
          // 非超限错误：保留已有上下文用量，标明其状态，不归零、不清空
          if (keyUsed) {
            keyUsed.textContent = usedTokenCount != null ? (d?.actual != null ? `${short(usedTokenCount)}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}` : t('key.estShort', { val: short(usedTokenCount) })) : '—';
          }
          if (keyLimit) keyLimit.textContent = budgetTokenCount ? short(budgetTokenCount) : '—';
          if (keyRemaining) {
            if (usedTokenCount != null && budgetTokenCount) {
              const rem = Math.max(0, budgetTokenCount - usedTokenCount);
              const remP = Math.max(0, 100 - (pct || ((usedTokenCount / budgetTokenCount) * 100)));
              keyRemaining.textContent = `${short(rem)} (${remP.toFixed(1)}%)`;
            } else {
              keyRemaining.textContent = t('key.pending');
            }
          }
        }
        if (keyTakeaway) keyTakeaway.textContent = disp.keyTakeaway;
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = t('key.pill.tight'); keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = t('key.pill.elevated'); keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = t('key.pill.normal'); keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        if (keyLimit) keyLimit.textContent = short(limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.textContent = t('key.takeaway.90', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else if (pct >= 75) {
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else {
            keyTakeaway.textContent = t('key.takeaway.ok', { pct: pct.toFixed(1), rem: short(remainVal) });
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (session?.total ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) keyTakeaway.textContent = t('key.takeaway.est');
      }
    }

    if (el('speed-summary')) {
      const spBadge = el('speed-badge');
      const spVal = el('speed-val');
      const spDur = el('speed-duration');
      const spTtft = el('speed-ttft');
      const spTokens = el('speed-tokens');
      const spTakeaway = el('speed-takeaway');

      if (sp?.tps != null) {
        if (spBadge) {
          if (sp.tps >= 80) { spBadge.textContent = t('speed.pill.fast'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 35) { spBadge.textContent = t('speed.pill.smooth'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 15) { spBadge.textContent = t('speed.pill.good'); spBadge.className = 'key-pill pill-warn'; }
          else { spBadge.textContent = t('speed.pill.slow'); spBadge.className = 'key-pill pill-danger'; }
        }
        if (spVal) spVal.textContent = `${sp.tps} tok/s`;
        if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
        if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
        if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
        if (spTakeaway) {
          const modelStr = d?.model ? `（${d.model}）` : '';
          const streamInfo = sp.streamingTps ? t('speed.streamPart', { tps: sp.streamingTps }) : '';
          spTakeaway.textContent = t('speed.takeaway.ok', {
            tone: sp.tps >= 35 ? t('speed.tone.smooth') : t('speed.tone.steady'),
            tps: sp.tps,
            stream: streamInfo,
            dur: sp.duration,
            tok: fmt(sp.outputTokens),
            model: modelStr
          });
        }
      } else {
        if (spBadge) { spBadge.textContent = state.requestBusy ? t('speed.pill.calc') : t('speed.pill.idle'); spBadge.className = 'key-pill pill-muted'; }
        if (spVal) spVal.textContent = '—';
        if (spDur) spDur.textContent = '—';
        if (spTtft) spTtft.textContent = '—';
        if (spTokens) spTokens.textContent = '—';
        if (spTakeaway) spTakeaway.textContent = t('speed.takeaway.idle');
      }
    }

    el('model').textContent = d?.model?.startsWith('MODEL_PLACEHOLDER') ? t('tech.modelPlaceholder', { id: d.model }) : d?.model || t('tech.modelMissing');
    el('request-status').textContent = d?.exceeded ? t('tech.req.exceeded') : d?.network ? t('tech.req.network') : d?.error ? t('tech.req.failed') : d?.status === 'reported' ? t('tech.req.reported') : d?.status === 'estimated' ? t('tech.req.estimated') : t('tech.req.waiting');
    el('actual').textContent = d?.actual != null ? token(d.actual) : d?.exceeded ? t('tech.actual.exceeded', { val: fmt(d.serviceLimit || 0) }) : t('tech.actual.unknown');
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = t('tech.actual.exceededNoLim');
    el('estimate').textContent = d?.estimate ? t('tech.est.val', { val: fmt(d.estimate), note: d.exceeded ? t('tech.est.under') : t('tech.est.ref') }) : t('tech.est.none');
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? t('tech.svcLim.val', { val: fmt(d.serviceLimit) }) : t('tech.svcLim.none');
    el('percent').textContent = d?.percent != null && !danger && !stale ? t('tech.pct.val', { pct: d.percent.toFixed(1) }) : t('tech.pct.none');
    el('session-total').textContent = session?.total ? range(session.total) + (incomplete ? t('tech.plusUnknown') : '') : state.scanError ? t('tech.scanIncomplete') : t('tech.scanning');
    el('characters').textContent = session?.total ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session?.groups ? range(session.groups[name]) : '—';
    el('system').textContent = session?.groups ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session?.attachmentTotal ? range(session.attachmentTotal) + (incomplete ? t('tech.plusUnknownShort') : '') : '—';
    el('steps').textContent = session?.steps != null ? t('tech.stepsVal', { steps: fmt(session.steps), user: session.userMessages, assistant: session.assistantMessages }) : t('tech.stepsNone');
    el('coverage').textContent = Array.isArray(session?.attachments)
      ? t('tech.coverageVal', {
          total: session.attachments.length,
          user: session.attachments.filter(f => f.source === 'user').length,
          assistant: session.attachments.filter(f => f.source === 'assistant').length,
          read: session.attachments.filter(f => f.chars > 0).length,
          unknown: session.unknownFiles,
          rescan: state.scanBusy ? t('tech.coverageRescan') : '',
          err: state.scanError ? t('tech.coverageErr', { err: translateBackendText(state.scanError) }) : ''
        })
      : (state.scanError ? translateBackendText(state.scanError) : t('tech.coverageScanning'));
    el('updated').textContent = t('tech.updatedVal', {
      req: state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : t('tech.unread'),
      scan: state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : t('tech.unfinished')
    });
    el('refresh').disabled = state.scanBusy;
  }

  async function requestPoll(generation, id) {
    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken; if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      const parsedCalls = [];
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          state.sessionCallsMap.set(call.callId, call);
          parsedCalls.push(call);
        }
      }
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c.isPriced ? (c.costUSD || 0) : 0), 0);
      if (parsedCalls.length) {
        if (!state.reportedFinalCallIds) state.reportedFinalCallIds = new Set();
        if (!state.reportedFinalCallOutputs) state.reportedFinalCallOutputs = new Map();
        const callsToReport = [];
        for (const call of parsedCalls) {
          if (call && call.status === 'final' && call.callId) {
            const lastOutput = state.reportedFinalCallOutputs.get(call.callId);
            const currentOutput = call.outputTokens || 0;
            if (!state.reportedFinalCallIds.has(call.callId) || (lastOutput != null && currentOutput > lastOutput)) {
              callsToReport.push(call);
            }
          }
        }
        if (callsToReport.length) {
          for (const call of callsToReport) {
            state.reportedFinalCallIds.add(call.callId);
            state.reportedFinalCallOutputs.set(call.callId, call.outputTokens || 0);
          }
          void recordModelCallsRemote(callsToReport);
        }
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const value = summarize(rows[i], { cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] });
        if (value) {
          state.latest = withStepError(value, rows[i]);
          const callInfo = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
          recordObservationFromSummary(state.latest, id, {
            callId: callInfo?.callId || null,
            stepCount: state.count,
            ts: Date.now()
          });
          break;
        }
      }
      state.requestAt = Date.now(); state.requestError = '';
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally { clearTimeout(timeout); state.controllers.delete(controller); if (generation === state.generation && !state.disposed) { state.requestBusy = false; state.requestNext = Date.now() + (document.hidden ? 15000 : 3000); render(); } }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      if (window.contextMeterAPI?.scan) result = await window.contextMeterAPI.scan(id, force);
      else if (window.__AGContextMeterLive) {
        const live = window.__AGContextMeterLive, controller = new AbortController(); state.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 180000);
        try { const response = await fetch(`http://127.0.0.1:${live.port}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token }, body: JSON.stringify({ id, force }), signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); result = await response.json(); }
        finally { clearTimeout(timeout); state.controllers.delete(controller); }
      } else throw new Error('完整重启 Antigravity 后启用附件扫描');
      if (generation !== state.generation || state.disposed) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.modelCapabilitiesById && typeof result.data.modelCapabilitiesById === 'object') {
        mergeCapabilitiesMapClient(result.data.modelCapabilitiesById);
      }
      if (Array.isArray(result.data.cascadeModelConfigs) && result.data.cascadeModelConfigs.length) {
        state.cascadeModelConfigs = result.data.cascadeModelConfigs;
      }
      if (result.data.scannedAt >= state.requestAt && result.data.latest) {
        state.latest = result.data.latest;
        state.requestAt = result.data.scannedAt;
        const genSteps = Number(result.data.generatorCount);
        const msgSteps = Number(result.data.session?.userMessages || 0) + Number(result.data.session?.assistantMessages || 0);
        const resolvedStepCount = Number.isFinite(genSteps) && genSteps >= 0 ? genSteps : (msgSteps > 0 ? msgSteps : state.count);
        recordObservationFromSummary(state.latest, id, {
          callId: result.data.latestCallId || null,
          stepCount: resolvedStepCount,
          ts: Number(result.data.scannedAt || Date.now())
        });
      }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastHistorySync = 0;
  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
    if (!csrf) return;
    if (Date.now() - lastAvailableModelsSync < 300000 && state.modelCapabilitiesById && Object.keys(state.modelCapabilitiesById).length > 0) {
      return;
    }
    availableModelsFetchInFlight = true;
    try {
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ forceRefresh: false })
      });
      if (!response.ok) return;
      const data = await response.json();
      const modelsObj = data?.response?.models || data?.models;
      if (!modelsObj || typeof modelsObj !== 'object') return;
      const entries = Array.isArray(modelsObj)
        ? modelsObj.map(item => [item?.model || item?.modelId || '', item])
        : Object.entries(modelsObj);
      const nextCaps = {};
      for (const [entryKey, d] of entries) {
        if (!d || typeof d !== 'object') continue;
        const rawId = String(d.model || d.modelId || entryKey || '').trim();
        if (!rawId) continue;
        const normKey = rawId.toLowerCase().replace(/^model_/, '');
        const maxTokens = Number.isSafeInteger(Number(d.maxTokens)) && Number(d.maxTokens) > 0 ? Number(d.maxTokens) : null;
        const maxOutputTokens = d.maxOutputTokens != null && Number.isSafeInteger(Number(d.maxOutputTokens)) && Number(d.maxOutputTokens) >= 0
          ? Number(d.maxOutputTokens)
          : null;
        const rec = {
          modelId: rawId,
          displayName: d.displayName || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget: d.thinkingBudget ?? null,
          minThinkingBudget: d.minThinkingBudget ?? null,
          thinkingLevel: d.thinkingLevel || null,
          supportsModelInfoOverride: typeof d.supportsModelInfoOverride === 'boolean' ? d.supportsModelInfoOverride : null,
          capabilitySource: 'get_available_models'
        };
        if (normKey) nextCaps[normKey] = rec;
        if (entryKey) nextCaps[String(entryKey).trim().toLowerCase().replace(/^model_/, '')] = rec;
      }
      if (Object.keys(nextCaps).length > 0) {
        mergeCapabilitiesMapClient(nextCaps);
        lastAvailableModelsSync = Date.now();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
          renderPresetSelectionUI();
        }
      }
    } catch {}
    finally {
      availableModelsFetchInFlight = false;
    }
  }

  function tick() {
    if (!state.disposed && !host.isConnected) {
      ensureHostDocked();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.reportedFinalCallIds) state.reportedFinalCallIds.clear();
      if (state.reportedFinalCallOutputs) state.reportedFinalCallOutputs.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [], sessionCostTotal: 0,
        requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        reportedFinalCallIds: state.reportedFinalCallIds || new Set(),
        reportedFinalCallOutputs: state.reportedFinalCallOutputs || new Map()
      });
      toggle(false); hideContextTooltip(); renderFiles(null); render();
      void syncTokenHistoryFromHost(false);
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
  }

  const timer = setInterval(tick, 500);
  globalThis.__AGContextMeter = {
    version: typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.3',
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch {}; applyTheme(); },
    getCustomColors: () => ({ ...customColors }),
    setCustomColor,
    resetCustomColors,
    resetHeatmapLevels,
    getHeatPreset: () => heatPreset,
    setHeatPreset,
    getHeatPalette: () => getEffectiveHeatmapScale(),
    getActivePickerSlot: () => activePickerSlot,
    openColorPicker,
    closeColorPicker,
    applyTokenHistoryPayload,
    applyPickerHex,
    setTokenHistoryForTest: payload => applyTokenHistoryPayload(payload),
    getPlanDetailExpanded: () => planDetailExpanded,
    setPlanDetailExpanded,
    switchTokenView,
    switchHeatView: view => switchHeatView(view),
    getActiveHeatView: () => activeHeatView,
    renderHeatmapMonthly: () => renderHeatmapMonthly(),
    renderHeatmapYearly: () => renderHeatmapYearly(),
    checkUpdate: manual => checkAppUpdate(manual),
    applyUpdate: () => applyAppUpdate(),
    getLatestRelease: () => cachedLatestRelease,
    openGithubRepo: path => openGithubRepo(path),
    updateHeatTabThumb: () => updateHeatTabThumb(),
    getPlanSettings: () => ({
      country: ANTIGRAVITY_TOKEN_DATA.planStatus?.country || '未知',
      subscriptionRegion: ANTIGRAVITY_TOKEN_DATA.planStatus?.subscriptionRegion || ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      region: ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      currency: ANTIGRAVITY_TOKEN_DATA.planStatus?.currency || 'USD',
      currencySymbol: ANTIGRAVITY_TOKEN_DATA.planStatus?.currencySymbol || '$',
      actualPricePaid: ANTIGRAVITY_TOKEN_DATA.planStatus?.actualPricePaid ?? null,
      lastSaveResult
    }),
    setCountry: val => applyDirectCountrySelection(val),
    setCurrency: val => applyDirectCurrencySelection(val),
    restoreSettingsFromHost,
    launchCli: opts => triggerLaunchCli(opts),
    getLastCliLaunchResult: () => lastCliLaunchResult,
    getTimelineWindow: () => {
      const w = computeTimelineWindow();
      return {
        firstUseDate: w.firstStr,
        winStart: formatLocalYmd(w.winStart),
        winEnd: formatLocalYmd(w.winEnd),
        totalDays: w.totalDays,
        canPrev: w.canPrev,
        canNext: w.canNext
      };
    },
    repositionPanelsForTest: () => positionFloatingPanels(),
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => {
      const next = computeNextLayoutMode(width, state.layoutMode);
      applyLayoutMode(next);
      return state.layoutMode;
    },
    findTopRightClusterForTest: () => findTopRightCluster(),
    syncWindowControlsOverlayForTest: () => syncWindowControlsOverlay(),
    computeWindowControlsWidthForTest: el => computeWindowControlsWidth(el),
    getContextPreferencesState: () => ({
      activeSessionModelKey,
      activeSessionProductKey,
      selectedEditModelKey,
      selectedProductKey,
      activeContextTab,
      isContextSettingsView,
      draft: { ...ctxDraft },
      contextPreferences: { ...contextPreferencesMap },
      unlockStatus: currentUnlockStatus ? { ...currentUnlockStatus } : null,
      pendingRestartVerification: pendingRestartVerification ? { ...pendingRestartVerification } : null,
      needsRestartAfterApply
    }),
    setContextLatestForTest: (latestObj, configs = [], capabilitiesById = null) => {
      if (capabilitiesById && typeof capabilitiesById === 'object') mergeCapabilitiesMapClient(capabilitiesById);
      if (Array.isArray(configs) && configs.length) state.cascadeModelConfigs = configs;
      state.latest = latestObj;
      if (latestObj && (state.route || state.activeConversationId)) {
        recordObservationFromSummary(latestObj, state.route || state.activeConversationId, { ts: latestObj.ts || Date.now() });
      }
      manualModelSelection = false;
      render();
      return { activeSessionModelKey, activeSessionProductKey, selectedEditModelKey, selectedProductKey, draft: { ...ctxDraft } };
    },
    setModelCapabilitiesForTest: (capabilitiesById) => {
      mergeCapabilitiesMapClient(capabilitiesById);
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getBudgetTrackerTracesForTest: () => (budgetTracker && typeof budgetTracker.exportDiagnosticTraces === 'function')
      ? budgetTracker.exportDiagnosticTraces()
      : [],
    switchContextTabForTest: (tab) => switchContextTab(tab),
    openContextSettingsForTest: (opts) => openContextSettings(opts),
    setSpeedRecordsForTest: (records, calls = []) => {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = Array.isArray(records) ? records : [];
      if (Array.isArray(calls)) state.sessionCalls = calls;
      if (!isContextSettingsView && activeContextTab === 'speed') renderSpeedComparisonTab();
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    setRestartVerificationForTest: (ver, preSnapshot = null) => {
      pendingRestartVerification = ver ? { ...ver } : null;
      if (preSnapshot) preRestartSnapshot = preSnapshot;
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getKnownModelProductsForTest: () => getKnownModelProducts(),
    refreshUnlockStatusForTest: () => refreshUnlockStatus(),
    refreshEnhanceStatusForTest: () => refreshEnhanceStatus(),
    getEnhanceStateForTest: () => ({
      currentBrandTitle,
      selectedEnhanceTier,
      enhanceTitleDraft,
      hasPendingLsReload,
      currentEnhanceStatus: currentEnhanceStatus ? { ...currentEnhanceStatus } : null
    }),
    getUnlockUiStateForTest: () => ({
      hostSupportsRestart,
      needsRestartAfterApply,
      resultBoxDisplay: unlockResultBox?.style?.display || '',
      resultRestartHidden: btnUnlockResultRestart ? btnUnlockResultRestart.hidden : null,
      resultRetryHidden: btnUnlockResultRetry ? btnUnlockResultRetry.hidden : null,
      resultManualHidden: unlockResultManual ? unlockResultManual.hidden : null,
      headerRestartHidden: btnRestartHost ? btnRestartHost.hidden : null
    }),
    getContextScopeModeForTest: () => getContextScopeMode(),
    setContextScopeModeForTest: mode => setScopeMode(mode),
    getContextUnifiedPreferenceForTest: () => getContextUnifiedPreference(),
    getPanelLanguage: () => getPanelLanguage(),
    setPanelLanguage: (lang, opts) => applyPanelLanguage(lang, opts),
    restoreSettingsForTest: () => restoreSettingsFromHost(),
    translateForTest: (key, vars) => t(key, vars),
    applyStaticTranslationsForTest: (rootNode) => applyStaticPanelTranslations(rootNode),
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls, sessionCostTotal: state.sessionCostTotal }),
    dispose() {
      state.disposed = true;
      for (const controller of state.controllers) controller.abort();
      clearInterval(timer);
      if (layoutRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf);
      syncHostStackingElevation(false);
      try { uninstallRequestInterceptor(); } catch {}
      try { themeObserver?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { hostDomObserver?.disconnect(); } catch {}
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        window.removeEventListener?.('mousemove', onPointerMove);
        window.removeEventListener?.('mouseup', onPointerUp);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      } catch {}
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch {}
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch {}
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  refreshRegionPresetSelectOptions();
  renderEnhanceSectionUI();
  void restoreSettingsFromHost();
  installRequestInterceptor();
  render();
  tick();
})();

