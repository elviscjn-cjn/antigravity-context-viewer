'use strict';
/**
 * 03 + 07 + 回归 #5 / ELV-108 右侧辅助面板原生页签共存与快切控制器
 *
 * 设计约束：
 * 1. 原生标签栏共存（Antigravity 2.35+ SidePanelV2 `Wvd` 与 Classic `q6c`）：
 *    - 在 `[data-side-panel-strip="true"]` 中以原生风格页签与 Swarm / Browser 并列挂载，严禁隐藏宿主顶栏条。
 *    - 支持从 `+` 按钮入口打开：兼容 SidePanelV2 的 `[data-testid="side-panel-new-tab-view"]` 卡片列表与 Classic `[data-testid="aux-panel-plus-dropdown-trigger"]` 下拉菜单。
 *    - 切到 ContextMeter 时仅在 `[data-side-panel-body="true"]` 内通过非破坏性 `visibility: hidden; pointer-events: none; position: absolute; inset: 0;` 遮罩宿主正文子节点：
 *      a) 完整保留 Swarm（Overview / Board / Members / Graph）DOM 树与非零几何尺寸，切回零白板、零重排崩塌；
 *      b) 命中宿主 `WcvBrowser` 的 `visibility === "hidden"` 判据，安全退场原生 Browser 叠加层；
 *      c) 严格沿用宿主辅助栏自然宽度，绝不额外强插中间列挤压主聊天区。
 * 2. 兼容保留原 `createAuxQuickSwitchController` / `computeAuxQuickSwitchTransition` 导出，保障既有单测与降级路径无损运行。
 * 3. 三语可见文案严格零中英文括号；普通按住仅轻微变深不变形；零顶层 ESM export/import。
 */
(function (rootScope) {
  const AUX_QS_STYLE_ID = 'ag-aux-quick-switch-style';
  const AUX_QS_ROOT_ID = 'ag-aux-quick-switch-bar';
  const AUX_NATIVE_TAB_STYLE_ID = 'ag-aux-native-tab-style';
  const AUX_NATIVE_TAB_ID = 'ag-context-meter-tab';
  const AUX_NATIVE_TAB_WRAP_ID = 'ag-aux-native-tab-wrap';
  const AUX_NATIVE_NEW_TAB_CARD_ID = 'ag-aux-new-tab-card-cm';
  const AUX_NATIVE_PLUS_MENU_ITEM_ID = 'ag-aux-plus-menu-item-cm';
  const MIN_SIDE_BY_SIDE_WIDTH_PX = 620;
  const MIN_MAIN_CHAT_SAFE_WIDTH_PX = 360;

  const AUX_QS_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      barAria: '辅助区布局切换',
      browser: '浏览器',
      context: '上下文',
      contextMeterTab: 'ContextMeter',
      contextMeterTabTitle: '切换到 ContextMeter 实时监控视图',
      closeTabTitle: '关闭 ContextMeter 页签',
      newTabLauncherTitle: 'ContextMeter',
      newTabLauncherDesc: '会话上下文、额度与实时速度看板',
      sideBySide: '并排',
      exitSideBySide: '标签页',
      swapOrder: '互换',
      browserTitle: '切换到宿主原生浏览器',
      contextTitle: '切换到当前会话上下文',
      sideBySideTitle: '浏览器与上下文并排显示',
      sideBySideNarrowTitle: '当前宽度不足，暂无法并排',
      swapOrderTitle: '交换浏览器与上下文左右位置',
      layoutTab: '标签页',
      layoutSplit: '并排',
      layoutTabTitle: '作为标签页与宿主原生标签并列',
      layoutSplitTitle: '会话、上下文与浏览器同屏并排显示'
    }),
    'zh-TW': Object.freeze({
      barAria: '輔助區版面切換',
      browser: '瀏覽器',
      context: '上下文',
      contextMeterTab: 'ContextMeter',
      contextMeterTabTitle: '切換到 ContextMeter 即時監控視圖',
      closeTabTitle: '關閉 ContextMeter 分頁',
      newTabLauncherTitle: 'ContextMeter',
      newTabLauncherDesc: '工作階段上下文、額度與即時速度看板',
      sideBySide: '並排',
      exitSideBySide: '分頁',
      swapOrder: '互換',
      browserTitle: '切換到宿主原生瀏覽器',
      contextTitle: '切換到目前工作階段上下文',
      sideBySideTitle: '瀏覽器與上下文並排顯示',
      sideBySideNarrowTitle: '目前寬度不足，暫無法並排',
      swapOrderTitle: '交換瀏覽器與上下文左右位置',
      layoutTab: '分頁',
      layoutSplit: '並排',
      layoutTabTitle: '作為分頁與宿主原生分頁並列',
      layoutSplitTitle: '工作階段、上下文與瀏覽器同屏並排顯示'
    }),
    en: Object.freeze({
      barAria: 'Auxiliary layout switcher',
      browser: 'Browser',
      context: 'Context',
      contextMeterTab: 'ContextMeter',
      contextMeterTabTitle: 'Switch to ContextMeter live monitor view',
      closeTabTitle: 'Close ContextMeter tab',
      newTabLauncherTitle: 'ContextMeter',
      newTabLauncherDesc: 'Session context, quota and live speed dashboard',
      sideBySide: 'Split',
      exitSideBySide: 'Tabs',
      swapOrder: 'Swap',
      browserTitle: 'Switch to native host browser',
      contextTitle: 'Switch to active session context',
      sideBySideTitle: 'Show browser and context side by side',
      sideBySideNarrowTitle: 'Available width too narrow for split view',
      swapOrderTitle: 'Swap browser and context positions',
      layoutTab: 'Tabs',
      layoutSplit: 'Split',
      layoutTabTitle: 'Show as a tab alongside native host tabs',
      layoutSplitTitle: 'Show chat, context and browser side by side'
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  function getAuxQuickSwitchCopy(lang) {
    return AUX_QS_I18N[resolveLang(lang)] || AUX_QS_I18N['zh-CN'];
  }

  const AUX_QS_CSS = `
    .ag-aux-qs-bar {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      padding: 2px;
      border-radius: 8px;
      background: var(--ag-aux-qs-bg, rgba(128, 128, 128, 0.12));
      border: 1px solid var(--ag-aux-qs-border, rgba(128, 128, 128, 0.2));
      box-sizing: border-box;
      user-select: none;
      -webkit-user-select: none;
      font-family: inherit;
    }
    .ag-aux-qs-bar[hidden] {
      display: none !important;
    }
    .ag-aux-qs-seg {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .ag-aux-qs-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 22px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--ag-text-secondary, var(--foreground, #c8c8d0));
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      outline: none;
      transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
      transform: none !important;
    }
    .ag-aux-qs-btn:hover:not(:disabled) {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.08));
      color: var(--ag-text-primary, var(--foreground, #ececef));
    }
    .ag-aux-qs-btn:active:not(:disabled) {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.14));
      transform: none !important;
    }
    .ag-aux-qs-btn:focus-visible {
      box-shadow: 0 0 0 1.5px var(--ag-host-accent, var(--primary, #3274f6));
    }
    .ag-aux-qs-btn[aria-selected="true"],
    .ag-aux-qs-btn[aria-pressed="true"],
    .ag-aux-qs-btn.active {
      background: var(--ag-host-accent, var(--primary, #3274f6));
      border-color: transparent;
      color: var(--ag-host-accent-fg, #ffffff);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
    }
    .ag-aux-qs-btn[aria-selected="true"]:hover:not(:disabled),
    .ag-aux-qs-btn.active:hover:not(:disabled) {
      background: var(--ag-host-accent, var(--primary, #3274f6));
      color: var(--ag-host-accent-fg, #ffffff);
      filter: brightness(1.06);
    }
    .ag-aux-qs-btn:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .ag-aux-qs-divider {
      width: 1px;
      height: 14px;
      background: var(--ag-aux-qs-border, rgba(128, 128, 128, 0.26));
      flex: 0 0 1px;
    }
    .ag-aux-qs-btn[hidden],
    .ag-aux-qs-divider[hidden] {
      display: none !important;
    }
    .ag-aux-qs-icon {
      width: 13px;
      height: 13px;
      flex: 0 0 13px;
      display: inline-block;
    }
    [data-theme="light"] .ag-aux-qs-bar {
      --ag-aux-qs-bg: rgba(24, 24, 27, 0.05);
      --ag-aux-qs-border: rgba(24, 24, 27, 0.12);
      --ag-btn-hover: rgba(24, 24, 27, 0.06);
      --ag-btn-active: rgba(24, 24, 27, 0.12);
    }
    @media (prefers-reduced-motion: reduce) {
      .ag-aux-qs-btn {
        transition: none !important;
      }
    }
  `;

  const AUX_NATIVE_TAB_CSS = `
    .ag-aux-native-tab-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      min-width: 48px;
      max-width: 180px;
      height: 28px;
      border-radius: 8px;
      overflow: hidden;
      background: transparent;
      color: var(--secondary-foreground, #9d9d9d);
      transition: background-color 120ms ease, color 120ms ease;
      -webkit-app-region: no-drag;
      user-select: none;
    }
    .ag-aux-native-tab-wrap[hidden] {
      display: none !important;
    }
    .ag-aux-native-tab-wrap:hover {
      background: var(--muted, rgba(255, 255, 255, 0.06));
      color: var(--foreground, #cccccc);
    }
    .ag-aux-native-tab-wrap[data-active="true"] {
      background: var(--secondary, rgba(255, 255, 255, 0.11));
      color: var(--foreground, #ececef);
    }
    .ag-aux-native-tab-btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      height: 100%;
      padding: 4px 6px 4px 8px;
      margin: 0;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 12.5px;
      font-weight: 400;
      line-height: 1.2;
      white-space: nowrap;
      cursor: pointer;
      outline: none;
      text-align: left;
    }
    .ag-aux-native-tab-btn:focus-visible {
      box-shadow: inset 0 0 0 1.5px var(--primary, rgba(120, 140, 255, 0.8));
      border-radius: 8px;
    }
    .ag-aux-native-tab-icon {
      width: 15px;
      height: 15px;
      flex: 0 0 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ag-host-accent, var(--primary, #3274f6));
    }
    .ag-aux-native-tab-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ag-aux-native-tab-close {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      margin-right: 4px;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      outline: none;
      flex-shrink: 0;
      transition: opacity 120ms ease, background-color 120ms ease;
    }
    .ag-aux-native-tab-close:hover {
      opacity: 1;
      background: rgba(128, 128, 128, 0.22);
    }
    .ag-aux-native-tab-close:focus-visible {
      opacity: 1;
      box-shadow: 0 0 0 1.5px var(--primary, rgba(120, 140, 255, 0.8));
    }
    /* 当 ContextMeter 原生页签激活时，温和弱化宿主原本激活页签的高亮态而不修改 React DOM className */
    [data-side-panel-strip][data-ag-cm-tab-active="true"] .agy-aux-tab:not([data-ag-aux-native-tab-wrap="true"]),
    [data-side-panel-strip][data-ag-cm-tab-active="true"] button[data-tab-id]:not([data-ag-aux-native-tab="true"]) {
      background: transparent !important;
      color: var(--secondary-foreground, #9d9d9d) !important;
    }
    [data-side-panel-strip][data-ag-cm-tab-active="true"] .agy-aux-tab:not([data-ag-aux-native-tab-wrap="true"]):hover,
    [data-side-panel-strip][data-ag-cm-tab-active="true"] button[data-tab-id]:not([data-ag-aux-native-tab="true"]):hover {
      background: var(--muted, rgba(255, 255, 255, 0.06)) !important;
      color: var(--foreground, #ececef) !important;
    }
    /* 死保宿主右侧标签栏末尾原生 + 新建标签按钮始终常驻可见且可点击 */
    [data-side-panel-strip] [data-testid="side-panel-new-tab-button"],
    [data-side-panel-strip] [data-testid="aux-panel-plus-dropdown-trigger"] {
      display: inline-flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      flex-shrink: 0 !important;
      position: relative !important;
      z-index: 3 !important;
    }
    /* 宿主正文子节点在 ContextMeter 激活时非破坏性退场：保留完整宽高与 DOM 子树，彻底杜绝 Swarm 白板/崩塌，同时通知 Electron WcvBrowser 隐退 */
    [data-ag-aux-native-occluded="true"] {
      visibility: hidden !important;
      pointer-events: none !important;
      position: absolute !important;
      inset: 0 !important;
      z-index: 0 !important;
    }
    [data-side-panel-body][data-ag-aux-body-hosted="true"] {
      position: relative !important;
      min-height: 0 !important;
    }
    [data-om-aux-stage="tab"] {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      z-index: 2;
      box-sizing: border-box;
    }
    [data-om-aux-stage="tab"][hidden] {
      display: none !important;
    }
    /* SidePanelV2 新建标签页卡片与 Classic + 下拉菜单入口 */
    .ag-aux-new-tab-card {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 12px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary-foreground, #9d9d9d);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      outline: none;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .ag-aux-new-tab-card:hover,
    .ag-aux-new-tab-card:focus-visible {
      background: var(--muted, rgba(255, 255, 255, 0.07));
      color: var(--foreground, #ececef);
    }
    .ag-aux-new-tab-card-desc {
      margin-left: auto;
      font-size: 11.5px;
      color: var(--muted-foreground, #7a7a85);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .ag-aux-native-tab-wrap,
      .ag-aux-native-tab-close,
      .ag-aux-new-tab-card {
        transition: none !important;
      }
    }
  `;

  /**
   * 探测 Antigravity 2.35+ 右侧辅助面板的真实 DOM 结构（支持 SidePanelV2 `Wvd` 与 Classic `q6c`）。
   */
  function detectNativeAuxPanelStructure(auxEl, doc = null) {
    const fallback = {
      supported: false,
      scopeEl: null,
      stripEl: null,
      bodyEl: null,
      tabsScrollEl: null,
      plusBtn: null,
      dragSpacer: null,
      nativeTabs: [],
      activeNativeTabId: '',
      activeNativeKind: 'unknown',
      hasSwarmTab: false,
      hasBrowserTab: false,
      newTabViewEl: null,
      isV2: false
    };
    const scope = auxEl && auxEl.getAttribute?.('data-side-panel-focus-scope') === 'true'
      ? auxEl
      : (auxEl?.closest?.('[data-side-panel-focus-scope="true"]')
        || auxEl?.querySelector?.('[data-side-panel-focus-scope="true"]')
        || doc?.querySelector?.('[data-side-panel-open="true"] [data-side-panel-focus-scope="true"]')
        || auxEl
        || null);
    if (!scope || typeof scope.querySelector !== 'function') return fallback;

    const stripEl = scope.querySelector('[data-side-panel-strip="true"], [data-side-panel-strip]') || null;
    const bodyEl = scope.querySelector('[data-side-panel-body="true"], [data-side-panel-body]') || null;
    if (!stripEl || !bodyEl) return { ...fallback, scopeEl: scope, stripEl, bodyEl };

    const plusBtn = stripEl.querySelector(
      '[data-testid="side-panel-new-tab-button"], [data-testid="aux-panel-plus-dropdown-trigger"]'
    ) || null;
    const dragSpacer = stripEl.querySelector('[data-testid="side-panel-drag-spacer"]') || null;
    const isV2 = Boolean(
      plusBtn?.getAttribute?.('data-testid') === 'side-panel-new-tab-button'
      || stripEl.querySelector('.agy-aux-tab')
      || bodyEl.querySelector('[data-testid="side-panel-new-tab-view"]')
    );

    const nativeTabBtns = Array.from(stripEl.querySelectorAll('button[data-tab-id]') || [])
      .filter(btn => btn && btn.getAttribute?.('data-ag-aux-native-tab') !== 'true');

    const tabsScrollEl = (() => {
      if (nativeTabBtns.length > 0) {
        const firstTab = nativeTabBtns[0];
        const tabWrapper = firstTab.closest?.('.agy-aux-tab') || firstTab;
        if (tabWrapper.parentElement && tabWrapper.parentElement !== stripEl) {
          return tabWrapper.parentElement;
        }
      }
      return stripEl;
    })();

    const activeNativeTabId = String(stripEl.getAttribute?.('data-active-tab-id') || '').trim();
    const newTabViewEl = bodyEl.querySelector('[data-testid="side-panel-new-tab-view"]') || null;

    let hasSwarmTab = false;
    let hasBrowserTab = false;
    let activeNativeKind = 'other';

    const classifyTab = (id, text) => {
      const combined = `${id || ''} ${text || ''}`.toLowerCase();
      if (/\bswarm\b|集群|蜂群|编队/.test(combined)) return 'swarm';
      if (/\bbrowser\b|preview|浏览器|瀏覽器|预览/.test(combined)) return 'browser';
      if (/\bterminal\b|终端|終端/.test(combined)) return 'terminal';
      if (/\breview\b|审查|審查/.test(combined)) return 'review';
      if (/\bnewtab__empty\b/.test(combined)) return 'new-tab';
      return 'other';
    };

    for (const btn of nativeTabBtns) {
      const tid = String(btn.getAttribute?.('data-tab-id') || '').trim();
      const txt = String(btn.textContent || btn.getAttribute?.('title') || btn.getAttribute?.('aria-label') || '').trim();
      const k = classifyTab(tid, txt);
      if (k === 'swarm') hasSwarmTab = true;
      if (k === 'browser') hasBrowserTab = true;
      if (activeNativeTabId && tid === activeNativeTabId) {
        activeNativeKind = k;
      }
    }

    if (newTabViewEl || activeNativeTabId === 'newTab__empty') {
      activeNativeKind = 'new-tab';
    } else if (activeNativeKind === 'other') {
      const idKind = classifyTab(activeNativeTabId, '');
      if (idKind !== 'other') {
        activeNativeKind = idKind;
      } else if (bodyEl.querySelector('webview, iframe, [data-testid*="browser" i]')) {
        activeNativeKind = 'browser';
        hasBrowserTab = true;
      } else if (bodyEl.querySelector('[data-testid*="swarm" i]') || /\bOverview\b[\s\S]*\bBoard\b[\s\S]*\bMembers\b/i.test(String(bodyEl.textContent || ''))) {
        activeNativeKind = 'swarm';
        hasSwarmTab = true;
      }
    }

    return {
      supported: true,
      scopeEl: scope,
      stripEl,
      bodyEl,
      tabsScrollEl,
      plusBtn,
      dragSpacer,
      nativeTabs: nativeTabBtns,
      activeNativeTabId,
      activeNativeKind,
      hasSwarmTab,
      hasBrowserTab,
      newTabViewEl,
      isV2
    };
  }

  /**
   * 评估当前布局下是否禁止侧栏强扩宽挤压主聊天区（回归 #5 & ELV-108 硬护栏）。
   */
  function shouldPreserveNativeAuxWidth(info, mainChatWidthPx = null, minSafeChatPx = MIN_MAIN_CHAT_SAFE_WIDTH_PX) {
    if (info?.supported) return true;
    if (info?.hasSwarmTab || info?.activeNativeKind === 'swarm') return true;
    if (Number.isFinite(Number(mainChatWidthPx)) && Number(mainChatWidthPx) > 0 && Number(mainChatWidthPx) < minSafeChatPx) {
      return true;
    }
    return false;
  }

  /**
   * 纯函数状态跃迁：给定当前辅助区视图状态与用户动作，计算下一状态与无损布局指令。
   * - mode: 'browser' | 'plugin' | 'both'
   * - lastSingleMode: 'browser' | 'plugin' (退出并排时直达所选单视图)
   * - paneOrder: 'plugin-first' | 'browser-first' (仅靠 CSS order 互换，零销毁/零重载 webview)
   */
  function computeAuxQuickSwitchTransition(currentState, action, opts = {}) {
    const prev = {
      mode: currentState?.mode === 'browser' || currentState?.mode === 'both' ? currentState.mode : 'plugin',
      lastSingleMode: currentState?.lastSingleMode === 'browser' ? 'browser' : 'plugin',
      paneOrder: currentState?.paneOrder === 'browser-first' ? 'browser-first' : 'plugin-first',
      availableWidth: Number.isFinite(Number(opts.availableWidth ?? currentState?.availableWidth))
        ? Number(opts.availableWidth ?? currentState?.availableWidth)
        : 900,
      minSplitWidth: Number.isFinite(Number(opts.minSplitWidth))
        ? Number(opts.minSplitWidth)
        : MIN_SIDE_BY_SIDE_WIDTH_PX
    };

    const canSplit = prev.availableWidth >= prev.minSplitWidth;
    const next = { ...prev, canSplit, changed: false, shouldPausePluginWork: false, shouldResumePluginWork: false };

    if (action === 'select-browser') {
      next.mode = 'browser';
      next.lastSingleMode = 'browser';
      next.changed = prev.mode !== 'browser';
    } else if (action === 'select-plugin') {
      next.mode = 'plugin';
      next.lastSingleMode = 'plugin';
      next.changed = prev.mode !== 'plugin';
    } else if (action === 'toggle-split') {
      if (prev.mode === 'both') {
        next.mode = prev.lastSingleMode || 'plugin';
        next.changed = true;
      } else if (canSplit) {
        next.lastSingleMode = prev.mode === 'browser' ? 'browser' : 'plugin';
        next.mode = 'both';
        next.changed = true;
      }
    } else if (action === 'swap-order') {
      if (prev.mode === 'both') {
        next.paneOrder = prev.paneOrder === 'plugin-first' ? 'browser-first' : 'plugin-first';
        next.changed = true;
      }
    } else if (action === 'resize') {
      if (prev.mode === 'both' && !canSplit) {
        next.mode = prev.lastSingleMode || 'plugin';
        next.changed = true;
      }
    }

    const wasPluginVisible = prev.mode === 'plugin' || prev.mode === 'both';
    const isPluginVisible = next.mode === 'plugin' || next.mode === 'both';
    next.shouldPausePluginWork = wasPluginVisible && !isPluginVisible;
    next.shouldResumePluginWork = !wasPluginVisible && isPluginVisible;
    next.cssOrder = next.paneOrder === 'browser-first'
      ? { browser: 1, plugin: 2 }
      : { plugin: 1, browser: 2 };
    next.pluginShellHidden = next.mode === 'browser';
    return next;
  }

  function createSvgIcon(doc, kind) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ag-aux-qs-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.45');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const add = (tag, attrs) => {
      const node = doc.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
    };

    if (kind === 'browser') {
      add('circle', { cx: 8, cy: 8, r: 5.8 });
      add('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 5.8 });
      add('line', { x1: 2.4, y1: 8, x2: 13.6, y2: 8 });
    } else if (kind === 'context') {
      add('circle', { cx: 8, cy: 8, r: 5.6, opacity: 0.32 });
      add('path', { d: 'M8 2.4 A5.6 5.6 0 1 1 3.2 10.9' });
    } else if (kind === 'split') {
      add('rect', { x: 2.2, y: 2.8, width: 11.6, height: 10.4, rx: 1.8 });
      add('line', { x1: 8, y1: 2.8, x2: 8, y2: 13.2 });
    } else if (kind === 'swap') {
      add('path', { d: 'M3 5.5H13M10.5 3L13 5.5L10.5 8' });
      add('path', { d: 'M13 10.5H3M5.5 8L3 10.5L5.5 13' });
    } else if (kind === 'close') {
      add('path', { d: 'M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5' });
    }
    return svg;
  }

  /**
   * 死保宿主右侧标签栏末尾原生 `+` 新建标签按钮常驻 DOM、可见且可点击，绝不被隐藏、遮罩或移除。
   */
  function ensureNativePlusButtonProtected(stripEl, plusBtn = null) {
    if (!stripEl) return null;
    try {
      stripEl.removeAttribute?.('data-ag-aux-native-occluded');
      stripEl.removeAttribute?.('data-ag-aux-host-hidden');
      if (stripEl.hidden) stripEl.hidden = false;
      if (stripEl.style && stripEl.style.display === 'none') stripEl.style.display = '';
      if (stripEl.style && stripEl.style.visibility === 'hidden') stripEl.style.visibility = '';
    } catch { }
    const targetPlus = plusBtn || stripEl.querySelector?.(
      '[data-testid="side-panel-new-tab-button"], [data-testid="aux-panel-plus-dropdown-trigger"]'
    ) || null;
    if (!targetPlus) return null;
    try {
      targetPlus.removeAttribute?.('data-ag-aux-native-occluded');
      targetPlus.removeAttribute?.('data-ag-aux-host-hidden');
      if (targetPlus.hidden) targetPlus.hidden = false;
      if (targetPlus.style) {
        if (targetPlus.style.display === 'none') targetPlus.style.display = '';
        if (targetPlus.style.visibility === 'hidden') targetPlus.style.visibility = '';
        if (targetPlus.style.opacity === '0') targetPlus.style.opacity = '';
        if (targetPlus.style.pointerEvents === 'none') targetPlus.style.pointerEvents = '';
      }
    } catch { }
    return targetPlus;
  }

  /**
   * 回归 #5 & ELV-108 核心：右侧辅助面板原生页签栏与 `+` 新建菜单共存控制器。
   * - 将 ContextMeter 接入 `[data-side-panel-strip="true"]` 成为原生并列页签，与 Swarm / Browser 自由切换；
   * - 支持从 `+` 按钮（SidePanelV2 New Tab View 卡片 & Classic Plus Dropdown 菜单）打开 ContextMeter；
   * - 切换时仅在 `[data-side-panel-body="true"]` 内互斥显隐，对 Swarm / Browser 零销毁、零白板、零挤压主聊天区。
   */
  function createNativeAuxTabCoexistenceController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    let lang = resolveLang(deps.lang);
    let tabOpen = deps.initialTabOpen !== false;
    let active = Boolean(deps.initialActive);
    let currentScopeEl = null;
    let currentStripEl = null;
    let currentBodyEl = null;
    let tabStageEl = null;
    let tabWrapEl = null;
    let tabBtnEl = null;
    let tabCloseBtnEl = null;
    let lastActiveNativeTabId = '';
    let lastActiveNativeKind = 'unknown';
    let occludedNodes = new Set();
    let plusMenuTimers = [];
    let disposed = false;

    function clearPlusMenuTimers() {
      for (const tid of plusMenuTimers) {
        try { clearTimeout(tid); } catch { }
      }
      plusMenuTimers = [];
    }

    function ensureNativeStyles() {
      if (!doc || !doc.head) return;
      if (doc.getElementById?.(AUX_NATIVE_TAB_STYLE_ID) || doc.head.querySelector?.(`#${AUX_NATIVE_TAB_STYLE_ID}`)) return;
      const st = doc.createElement('style');
      st.id = AUX_NATIVE_TAB_STYLE_ID;
      st.setAttribute('data-ag-ws-owned', 'true');
      st.textContent = AUX_NATIVE_TAB_CSS;
      doc.head.appendChild(st);
    }

    function restoreOccludedHostNodes() {
      for (const node of Array.from(occludedNodes)) {
        try {
          node?.removeAttribute?.('data-ag-aux-native-occluded');
        } catch { }
      }
      occludedNodes.clear();
      if (currentBodyEl) {
        try {
          for (const ch of Array.from(currentBodyEl.children || [])) {
            if (ch?.getAttribute?.('data-ag-aux-native-occluded') === 'true') {
              ch.removeAttribute('data-ag-aux-native-occluded');
            }
          }
        } catch { }
      }
      if (doc && typeof doc.querySelectorAll === 'function') {
        try {
          for (const node of Array.from(doc.querySelectorAll('[data-ag-aux-native-occluded="true"]') || [])) {
            node?.removeAttribute?.('data-ag-aux-native-occluded');
          }
        } catch { }
      }
    }

    function ensureTabStageInBody(bodyEl, pluginHostEl) {
      if (!bodyEl || !pluginHostEl) return null;
      if (pluginHostEl.parentElement !== bodyEl) {
        bodyEl.appendChild(pluginHostEl);
      }
      pluginHostEl.setAttribute?.('data-om-aux-stage', 'tab');
      tabStageEl = pluginHostEl;
      return pluginHostEl;
    }

    function applyBodyOcclusion(bodyEl, pluginHostEl, isPluginActive) {
      if (!bodyEl) return;
      bodyEl.setAttribute('data-ag-aux-body-hosted', 'true');
      if (!isPluginActive) {
        restoreOccludedHostNodes();
        if (pluginHostEl) {
          pluginHostEl.hidden = true;
          pluginHostEl.setAttribute?.('data-aux-native-tab-active', 'false');
        }
        return;
      }
      ensureTabStageInBody(bodyEl, pluginHostEl);
      const nextOccluded = new Set();
      for (const ch of Array.from(bodyEl.children || [])) {
        if (
          !ch
          || ch === pluginHostEl
          || ch === currentStripEl
          || ch.id === 'ag-context-meter'
          || ch.getAttribute?.('data-ag-ws-owned') === 'true'
          || ch.getAttribute?.('data-om-aux-stage')
          || ch.getAttribute?.('data-om-aux-fallback-host') === 'true'
          || ch.getAttribute?.('data-om-mount-root') === 'true'
        ) continue;
        // 死保宿主原生标签栏与末尾 `+` 按钮，绝不对其施加遮罩或隐藏
        if (
          ch.matches?.('[data-side-panel-strip], [data-testid="side-panel-new-tab-button"], [data-testid="aux-panel-plus-dropdown-trigger"]')
          || ch.querySelector?.('[data-side-panel-strip], [data-testid="side-panel-new-tab-button"], [data-testid="aux-panel-plus-dropdown-trigger"]')
        ) {
          ensureNativePlusButtonProtected(ch);
          continue;
        }
        // 严禁设置 display:none（会令 Swarm Graph/Board 塌缩为 0x0 并在切回时白板）；用 visibility:hidden + position:absolute 保持几何与 DOM 树 100% 完好，同时满足 WcvBrowser 退场条件
        ch.setAttribute('data-ag-aux-native-occluded', 'true');
        nextOccluded.add(ch);
      }
      for (const prev of Array.from(occludedNodes)) {
        if (!nextOccluded.has(prev)) {
          try { prev?.removeAttribute?.('data-ag-aux-native-occluded'); } catch { }
        }
      }
      occludedNodes = nextOccluded;
      if (pluginHostEl) {
        pluginHostEl.hidden = false;
        pluginHostEl.setAttribute?.('data-aux-native-tab-active', 'true');
        if (pluginHostEl.style) {
          if (pluginHostEl.style.display === 'none') pluginHostEl.style.display = '';
          if (pluginHostEl.style.visibility === 'hidden') pluginHostEl.style.visibility = '';
          pluginHostEl.style.position = 'relative';
          pluginHostEl.style.zIndex = '2';
          pluginHostEl.style.flex = '1 1 auto';
          pluginHostEl.style.width = '100%';
          pluginHostEl.style.height = '100%';
          pluginHostEl.style.minWidth = '0';
          pluginHostEl.style.minHeight = '0';
        }
      }
    }

    function updateTabVisuals() {
      const copy = getAuxQuickSwitchCopy(lang);
      if (tabWrapEl) {
        tabWrapEl.hidden = !tabOpen;
        tabWrapEl.setAttribute('data-active', active && tabOpen ? 'true' : 'false');
      }
      if (tabBtnEl) {
        tabBtnEl.setAttribute('aria-selected', active && tabOpen ? 'true' : 'false');
        tabBtnEl.title = copy.contextMeterTabTitle;
        tabBtnEl.setAttribute('aria-label', copy.contextMeterTab);
        const lbl = tabBtnEl.querySelector('.ag-aux-native-tab-label');
        if (lbl) lbl.textContent = copy.contextMeterTab;
      }
      if (tabCloseBtnEl) {
        tabCloseBtnEl.title = copy.closeTabTitle;
        tabCloseBtnEl.setAttribute('aria-label', copy.closeTabTitle);
      }
      if (currentStripEl) {
        if (active && tabOpen) {
          currentStripEl.setAttribute('data-ag-cm-tab-active', 'true');
        } else {
          currentStripEl.removeAttribute('data-ag-cm-tab-active');
        }
      }
    }

    function notifyStateChange(reason) {
      if (typeof deps.onActiveChange === 'function') {
        deps.onActiveChange(Boolean(active && tabOpen), {
          tabOpen,
          active: Boolean(active && tabOpen),
          reason,
          activeNativeTabId: lastActiveNativeTabId,
          activeNativeKind: lastActiveNativeKind,
          bodyEl: currentBodyEl,
          stripEl: currentStripEl
        });
      }
    }

    function activateContextMeter(reason = 'tab-click', pluginHostEl = null) {
      if (disposed) return false;
      const wasActive = active && tabOpen;
      tabOpen = true;
      active = true;
      updateTabVisuals();
      applyBodyOcclusion(currentBodyEl, pluginHostEl || deps.getPluginHost?.() || null, true);
      if (currentStripEl) ensureNativePlusButtonProtected(currentStripEl);
      if (!wasActive) {
        notifyStateChange(reason);
      }
      return true;
    }

    function deactivateContextMeter(reason = 'host-tab-click', { closeTab = false } = {}) {
      if (disposed) return false;
      const wasActive = active;
      const wasOpen = tabOpen;
      active = false;
      if (closeTab) tabOpen = false;
      updateTabVisuals();
      applyBodyOcclusion(currentBodyEl, deps.getPluginHost?.() || null, false);
      if (currentStripEl) ensureNativePlusButtonProtected(currentStripEl);
      if (wasActive || (closeTab && wasOpen)) {
        notifyStateChange(reason);
      }
      return true;
    }

    const onStripClick = (ev) => {
      if (disposed || !currentStripEl) return;
      const target = ev?.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest(`[data-ag-aux-native-tab-wrap="true"]`)) return;
      // 用户点击了宿主原生页签（Swarm / Browser / Files / Terminal）或 `+` 新建标签按钮 -> 立即退场 ContextMeter，还原宿主原生视图
      const hitNativeTab = target.closest('button[data-tab-id], .agy-aux-tab');
      const hitPlusBtn = target.closest('[data-testid="side-panel-new-tab-button"], [data-testid="aux-panel-plus-dropdown-trigger"]');
      if (hitNativeTab || hitPlusBtn) {
        if (active) {
          deactivateContextMeter(hitPlusBtn ? 'host-plus-click' : 'host-tab-click');
        }
        if (hitPlusBtn) {
          clearPlusMenuTimers();
          for (const delay of [30, 120]) {
            plusMenuTimers.push(setTimeout(() => {
              if (!disposed) syncPlusMenuLaunchers(null);
            }, delay));
          }
        }
      }
    };

    function detachStripListeners() {
      if (currentStripEl) {
        try { currentStripEl.removeEventListener('click', onStripClick, true); } catch { }
        try { currentStripEl.removeAttribute('data-ag-cm-tab-active'); } catch { }
      }
    }

    function buildNativeTabDom() {
      const copy = getAuxQuickSwitchCopy(lang);
      const wrap = doc.createElement('div');
      wrap.id = AUX_NATIVE_TAB_WRAP_ID;
      wrap.className = 'ag-aux-native-tab-wrap agy-aux-tab';
      wrap.setAttribute('data-ag-ws-owned', 'true');
      wrap.setAttribute('data-om-native-tab-wrap', 'true');
      wrap.setAttribute('data-ag-aux-native-tab-wrap', 'true');
      wrap.setAttribute('data-active', active && tabOpen ? 'true' : 'false');

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = AUX_NATIVE_TAB_ID;
      btn.className = 'ag-aux-native-tab-btn';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-tab-id', AUX_NATIVE_TAB_ID);
      btn.setAttribute('data-ag-aux-native-tab', 'true');
      btn.setAttribute('aria-selected', active && tabOpen ? 'true' : 'false');
      btn.title = copy.contextMeterTabTitle;
      btn.setAttribute('aria-label', copy.contextMeterTab);

      const iconWrap = doc.createElement('span');
      iconWrap.className = 'ag-aux-native-tab-icon';
      iconWrap.appendChild(createSvgIcon(doc, 'context'));

      const lbl = doc.createElement('span');
      lbl.className = 'ag-aux-native-tab-label';
      lbl.textContent = copy.contextMeterTab;

      btn.appendChild(iconWrap);
      btn.appendChild(lbl);
      btn.addEventListener('click', (ev) => {
        ev?.stopPropagation?.();
        activateContextMeter('native-tab-click');
      });

      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ag-aux-native-tab-close';
      closeBtn.setAttribute('data-ag-aux-native-tab-close', 'true');
      closeBtn.title = copy.closeTabTitle;
      closeBtn.setAttribute('aria-label', copy.closeTabTitle);
      closeBtn.appendChild(createSvgIcon(doc, 'close'));
      closeBtn.addEventListener('click', (ev) => {
        ev?.stopPropagation?.();
        deactivateContextMeter('native-tab-close', { closeTab: true });
      });

      wrap.appendChild(btn);
      wrap.appendChild(closeBtn);
      tabWrapEl = wrap;
      tabBtnEl = btn;
      tabCloseBtnEl = closeBtn;
      return wrap;
    }

    /**
     * 在 SidePanelV2 新建标签页 (`[data-testid="side-panel-new-tab-view"]`) 与 Classic `+` 下拉菜单中注入 ContextMeter 启动入口。
     */
    function syncPlusMenuLaunchers(info) {
      if (!doc || disposed) return;
      const copy = getAuxQuickSwitchCopy(lang);

      // 1) SidePanelV2: [data-testid="side-panel-new-tab-view"] 内的卡片列表
      const newTabView = info?.newTabViewEl || currentBodyEl?.querySelector?.('[data-testid="side-panel-new-tab-view"]') || null;
      if (newTabView) {
        let cardBtn = newTabView.querySelector?.(`[data-testid="new-tab-card-context-meter"]`) || null;
        if (!cardBtn) {
          const sampleCard = newTabView.querySelector?.('button[data-testid^="new-tab-card-"]') || null;
          const listParent = sampleCard?.parentElement || newTabView;
          cardBtn = doc.createElement('button');
          cardBtn.id = AUX_NATIVE_NEW_TAB_CARD_ID;
          cardBtn.type = 'button';
          cardBtn.className = 'ag-aux-new-tab-card';
          cardBtn.setAttribute('data-testid', 'new-tab-card-context-meter');
          cardBtn.setAttribute('data-ag-ws-owned', 'true');

          const iconWrap = doc.createElement('span');
          iconWrap.className = 'ag-aux-native-tab-icon';
          iconWrap.appendChild(createSvgIcon(doc, 'context'));

          const titleSpan = doc.createElement('span');
          titleSpan.className = 'ag-aux-new-tab-card-title';
          titleSpan.textContent = copy.newTabLauncherTitle;

          const descSpan = doc.createElement('span');
          descSpan.className = 'ag-aux-new-tab-card-desc';
          descSpan.textContent = copy.newTabLauncherDesc;

          cardBtn.appendChild(iconWrap);
          cardBtn.appendChild(titleSpan);
          cardBtn.appendChild(descSpan);
          cardBtn.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            activateContextMeter('new-tab-card');
          });
          listParent.appendChild(cardBtn);
        } else {
          const titleSpan = cardBtn.querySelector?.('.ag-aux-new-tab-card-title');
          const descSpan = cardBtn.querySelector?.('.ag-aux-new-tab-card-desc');
          if (titleSpan) titleSpan.textContent = copy.newTabLauncherTitle;
          if (descSpan) descSpan.textContent = copy.newTabLauncherDesc;
        }
      }

      // 2) Classic `+` dropdown menu: 查找带有 side-panel-plus-open-file 或 side-panel-plus-new-preview 的浮层菜单
      if (typeof doc.querySelector === 'function') {
        const anchorMenuItem = doc.querySelector('[data-testid="side-panel-plus-open-file"], [data-testid="side-panel-plus-new-preview"]');
        const menuRoot = anchorMenuItem?.parentElement || null;
        if (menuRoot && !menuRoot.querySelector?.('[data-testid="side-panel-plus-context-meter"]')) {
          const item = doc.createElement('button');
          item.id = AUX_NATIVE_PLUS_MENU_ITEM_ID;
          item.type = 'button';
          item.className = 'ag-aux-new-tab-card';
          item.setAttribute('role', 'menuitem');
          item.setAttribute('data-testid', 'side-panel-plus-context-meter');
          item.setAttribute('data-ag-ws-owned', 'true');

          const iconWrap = doc.createElement('span');
          iconWrap.className = 'ag-aux-native-tab-icon';
          iconWrap.appendChild(createSvgIcon(doc, 'context'));

          const titleSpan = doc.createElement('span');
          titleSpan.textContent = copy.newTabLauncherTitle;

          item.appendChild(iconWrap);
          item.appendChild(titleSpan);
          item.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            activateContextMeter('plus-dropdown-menu');
          });
          menuRoot.appendChild(item);
        }
      }
    }

    /**
     * 将原生标签栏共存同步到宿主 `auxEl`，并将 `pluginHostEl` 安全挂入 `[data-side-panel-body="true"]` 内（绝不放在 strip 之上覆盖或隐藏标签栏）。
     */
    function sync(auxEl, pluginHostEl = null, opts = {}) {
      if (disposed || !doc) return { supported: false, active: false };
      if (opts.lang) lang = resolveLang(opts.lang);
      const info = detectNativeAuxPanelStructure(auxEl, doc);
      if (!info.supported) {
        return { ...info, active: false, tabOpen };
      }

      ensureNativeStyles();

      if (currentStripEl !== info.stripEl) {
        detachStripListeners();
        currentStripEl = info.stripEl;
        currentStripEl.addEventListener('click', onStripClick, true);
      }
      if (currentBodyEl !== info.bodyEl) {
        restoreOccludedHostNodes();
        currentBodyEl = info.bodyEl;
      }
      currentScopeEl = info.scopeEl;

      // 若宿主自己切换了 activeTabId（例如快捷键、命令面板或点击了其他原生页签），自动把控制权还给宿主原生视图
      if (lastActiveNativeTabId && info.activeNativeTabId && info.activeNativeTabId !== lastActiveNativeTabId && active && !opts.forceActive) {
        active = false;
        notifyStateChange('host-active-tab-changed');
      }
      lastActiveNativeTabId = info.activeNativeTabId;
      lastActiveNativeKind = info.activeNativeKind;

      if (typeof opts.forceActive === 'boolean') {
        active = opts.forceActive;
        if (active) tabOpen = true;
      }

      // 将原生风格 ContextMeter 页签挂载到 stripEl（紧邻 `+` 按钮之前，绝不移除/隐藏/覆盖末尾原生 `+` 按钮）
      if (!tabWrapEl) {
        buildNativeTabDom();
      }
      const protectedPlus = ensureNativePlusButtonProtected(info.stripEl, info.plusBtn);
      const mountParent = protectedPlus && protectedPlus.parentElement === info.stripEl
        ? info.stripEl
        : (info.tabsScrollEl || info.stripEl);
      const refNode = (protectedPlus && protectedPlus.parentElement === mountParent)
        ? protectedPlus
        : (mountParent === info.stripEl && info.dragSpacer ? info.dragSpacer : null);
      const siblings = Array.isArray(mountParent.children) ? mountParent.children : Array.from(mountParent.children || []);
      const tabIdx = siblings.indexOf(tabWrapEl);
      const refIdx = refNode ? siblings.indexOf(refNode) : -1;
      const needsInsertBeforeRef = Boolean(
        refNode && refNode.parentElement === mountParent && (tabWrapEl.parentElement !== mountParent || (refIdx >= 0 && tabIdx > refIdx))
      );
      if (needsInsertBeforeRef && typeof mountParent.insertBefore === 'function') {
        mountParent.insertBefore(tabWrapEl, refNode);
      } else if (tabWrapEl.parentElement !== mountParent) {
        if (refNode && refNode.parentElement === mountParent && typeof mountParent.insertBefore === 'function') {
          mountParent.insertBefore(tabWrapEl, refNode);
        } else {
          mountParent.appendChild(tabWrapEl);
        }
      }
      ensureNativePlusButtonProtected(info.stripEl, protectedPlus);

      // 将 pluginHostEl 挂入 bodyEl 内部自有 data-om-aux-stage 容器（与 Swarm / Browser 同级，绝不挤压聊天区或遮挡 stripEl）
      const hostNode = pluginHostEl || deps.getPluginHost?.() || null;
      if (hostNode) {
        ensureTabStageInBody(info.bodyEl, hostNode);
      }

      updateTabVisuals();
      applyBodyOcclusion(info.bodyEl, hostNode, Boolean(active && tabOpen));
      syncPlusMenuLaunchers(info);

      return {
        ...info,
        tabOpen,
        active: Boolean(active && tabOpen),
        stageEl: tabStageEl,
        preserveNativeWidth: shouldPreserveNativeAuxWidth(info, opts.mainChatWidthPx)
      };
    }

    function unmount(opts = {}) {
      clearPlusMenuTimers();
      detachStripListeners();
      restoreOccludedHostNodes();
      const hostNode = deps.getPluginHost?.() || null;
      if (hostNode && opts.preserveHostHidden !== true) {
        hostNode.hidden = false;
        hostNode.removeAttribute?.('data-aux-native-tab-active');
      }
      if (tabStageEl) {
        try {
          if (tabStageEl === hostNode) {
            tabStageEl.removeAttribute?.('data-om-aux-stage');
          } else {
            tabStageEl.remove?.();
          }
        } catch { }
        tabStageEl = null;
      }
      if (currentBodyEl) {
        try { currentBodyEl.removeAttribute('data-ag-aux-body-hosted'); } catch { }
      }
      try { tabWrapEl?.remove?.(); } catch { }
      if (doc && typeof doc.querySelectorAll === 'function') {
        try {
          for (const n of Array.from(doc.querySelectorAll(`#${AUX_NATIVE_NEW_TAB_CARD_ID}, #${AUX_NATIVE_PLUS_MENU_ITEM_ID}, [data-om-aux-stage="tab"]`) || [])) {
            if (!n || n === hostNode || n.id === 'ag-context-meter' || (hostNode && typeof n?.contains === 'function' && n.contains(hostNode))) continue;
            n?.remove?.();
          }
        } catch { }
      }
      tabWrapEl = null;
      tabBtnEl = null;
      tabCloseBtnEl = null;
      currentScopeEl = null;
      currentStripEl = null;
      currentBodyEl = null;
    }

    function destroy() {
      disposed = true;
      unmount();
    }

    return {
      sync,
      activate: (reason) => activateContextMeter(reason),
      deactivate: (reason, opts) => deactivateContextMeter(reason, opts),
      syncPlusMenuLaunchers,
      getState: () => ({
        tabOpen,
        active: Boolean(active && tabOpen),
        activeNativeTabId: lastActiveNativeTabId,
        activeNativeKind: lastActiveNativeKind,
        occludedCount: occludedNodes.size,
        hasStrip: Boolean(currentStripEl),
        hasBody: Boolean(currentBodyEl)
      }),
      unmount,
      destroy
    };
  }

  function createAuxQuickSwitchController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const minSplitWidth = Number.isFinite(Number(deps.minSplitWidth))
      ? Number(deps.minSplitWidth)
      : MIN_SIDE_BY_SIDE_WIDTH_PX;

    let state = {
      mode: deps.initialMode === 'browser' || deps.initialMode === 'both' ? deps.initialMode : 'plugin',
      lastSingleMode: deps.initialMode === 'browser' ? 'browser' : 'plugin',
      paneOrder: deps.initialPaneOrder === 'browser-first' ? 'browser-first' : 'plugin-first',
      layoutMode: deps.initialLayoutMode === 'split' ? 'split' : 'tab',
      showLayoutModeSwitch: Boolean(deps.showLayoutModeSwitch),
      compactForNativeTab: Boolean(deps.compactForNativeTab),
      availableWidth: Number.isFinite(Number(deps.availableWidth)) ? Number(deps.availableWidth) : 960,
      lang: resolveLang(deps.lang),
      nativeViewKind: String(deps.nativeViewKind || 'browser'),
      visible: deps.visible !== false
    };

    let hostContainer = null;
    let barEl = null;
    let layoutGroupEl = null;
    let btnLayoutTab = null;
    let btnLayoutSplit = null;
    let btnSwap = null;
    let dividerEl = null;
    let disposed = false;

    function ensureStyle(targetRoot) {
      if (!doc) return;
      const headOrRoot = targetRoot && typeof targetRoot.querySelector === 'function' && targetRoot.nodeType === 11
        ? targetRoot
        : doc.head;
      if (!headOrRoot) return;
      const existing = headOrRoot.querySelector
        ? headOrRoot.querySelector(`#${AUX_QS_STYLE_ID}`)
        : doc.getElementById?.(AUX_QS_STYLE_ID);
      if (existing) return;
      const style = doc.createElement('style');
      style.id = AUX_QS_STYLE_ID;
      style.textContent = AUX_QS_CSS;
      headOrRoot.appendChild(style);
    }

    function applyStateToDom() {
      if (!barEl || disposed) return;
      const copy = getAuxQuickSwitchCopy(state.lang);
      const isNativeNonBrowser = Boolean(
        state.nativeViewKind && !/^(browser|context|plugin|both|empty)$/i.test(state.nativeViewKind)
      );
      const shouldHide = !state.visible || isNativeNonBrowser;
      barEl.hidden = shouldHide;
      barEl.setAttribute('aria-label', copy.barAria);
      barEl.setAttribute('data-aux-mode', state.mode);
      barEl.setAttribute('data-aux-order', state.paneOrder);
      barEl.setAttribute('data-aux-layout-mode', state.layoutMode);

      const isSplitLayout = state.layoutMode === 'split';
      const tabActive = !isSplitLayout;
      if (layoutGroupEl) {
        layoutGroupEl.hidden = false;
      }
      if (btnLayoutTab) {
        btnLayoutTab.setAttribute('aria-selected', tabActive ? 'true' : 'false');
        btnLayoutTab.setAttribute('tabindex', tabActive ? '0' : '-1');
        btnLayoutTab.classList?.toggle?.('active', tabActive);
        btnLayoutTab.title = copy.layoutTabTitle;
        btnLayoutTab.setAttribute('aria-label', copy.layoutTab);
        const lbl = btnLayoutTab.querySelector('.ag-aux-qs-label');
        if (lbl) lbl.textContent = copy.layoutTab;
      }
      if (btnLayoutSplit) {
        btnLayoutSplit.setAttribute('aria-selected', isSplitLayout ? 'true' : 'false');
        btnLayoutSplit.setAttribute('tabindex', isSplitLayout ? '0' : '-1');
        btnLayoutSplit.classList?.toggle?.('active', isSplitLayout);
        btnLayoutSplit.title = copy.layoutSplitTitle;
        btnLayoutSplit.setAttribute('aria-label', copy.layoutSplit);
        const lbl = btnLayoutSplit.querySelector('.ag-aux-qs-label');
        if (lbl) lbl.textContent = copy.layoutSplit;
      }
      if (dividerEl) {
        dividerEl.hidden = !isSplitLayout;
      }
      if (btnSwap) {
        btnSwap.hidden = !isSplitLayout;
        btnSwap.disabled = !isSplitLayout;
        btnSwap.title = copy.swapOrderTitle;
        btnSwap.setAttribute('aria-label', copy.swapOrder);
        const lbl = btnSwap.querySelector('.ag-aux-qs-label');
        if (lbl) lbl.textContent = copy.swapOrder;
      }
    }

    function dispatchAction(action, extraOpts = {}) {
      if (disposed) return state;
      if (action === 'swap-order' && state.layoutMode === 'split' && state.mode !== 'both') {
        state.mode = 'both';
      }
      const transition = computeAuxQuickSwitchTransition(state, action, {
        availableWidth: extraOpts.availableWidth ?? state.availableWidth,
        minSplitWidth
      });
      state = {
        ...state,
        mode: transition.mode,
        lastSingleMode: transition.lastSingleMode,
        paneOrder: transition.paneOrder,
        availableWidth: transition.availableWidth
      };
      applyStateToDom();
      if (transition.changed) {
        if (transition.shouldPausePluginWork && typeof deps.onPausePluginRendering === 'function') {
          deps.onPausePluginRendering(state);
        }
        if (transition.shouldResumePluginWork && typeof deps.onResumePluginRendering === 'function') {
          deps.onResumePluginRendering(state);
        }
        if (typeof deps.onApplyAuxViewTab === 'function') {
          deps.onApplyAuxViewTab(state.mode, {
            paneOrder: state.paneOrder,
            cssOrder: transition.cssOrder,
            pluginShellHidden: transition.pluginShellHidden,
            preserveBrowserInstance: true
          });
        }
        if (action === 'swap-order' && typeof deps.onSwapPaneOrder === 'function') {
          deps.onSwapPaneOrder(state.paneOrder, transition.cssOrder);
        }
      }
      return { ...state, ...transition };
    }

    function setLayoutModeAction(nextLayout) {
      if (disposed) return;
      const clean = nextLayout === 'split' ? 'split' : 'tab';
      if (state.layoutMode === clean) return;
      state.layoutMode = clean;
      if (clean === 'split') state.mode = 'both';
      else if (state.mode === 'both') state.mode = 'plugin';
      applyStateToDom();
      if (typeof deps.onLayoutModeChange === 'function') {
        deps.onLayoutModeChange(clean);
      }
    }

    function onKeyDown(ev) {
      if (disposed || !barEl) return;
      const target = ev.target;
      if (target !== btnLayoutTab && target !== btnLayoutSplit) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault?.();
        const nextBtn = target === btnLayoutTab ? btnLayoutSplit : btnLayoutTab;
        nextBtn?.focus?.();
        setLayoutModeAction(nextBtn === btnLayoutSplit ? 'split' : 'tab');
      } else if (ev.key === 'Home') {
        ev.preventDefault?.();
        btnLayoutTab?.focus?.();
        setLayoutModeAction('tab');
      } else if (ev.key === 'End') {
        ev.preventDefault?.();
        btnLayoutSplit?.focus?.();
        setLayoutModeAction('split');
      }
    }

    function buildButton(id, kind, role, labelText) {
      const btn = doc.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.className = 'ag-aux-qs-btn';
      if (role) btn.setAttribute('role', role);
      btn.appendChild(createSvgIcon(doc, kind));
      const span = doc.createElement('span');
      span.className = 'ag-aux-qs-label';
      span.textContent = labelText;
      btn.appendChild(span);
      return btn;
    }

    function mount(container, styleRoot = null) {
      if (disposed || !doc || !container) return null;
      if (hostContainer === container && barEl && barEl.parentElement === container) {
        applyStateToDom();
        return barEl;
      }
      unmount();
      ensureStyle(styleRoot || (container.getRootNode ? container.getRootNode() : null));

      const copy = getAuxQuickSwitchCopy(state.lang);
      barEl = doc.createElement('div');
      barEl.id = AUX_QS_ROOT_ID;
      barEl.className = 'ag-aux-qs-bar';
      barEl.setAttribute('data-ag-aux-quick-switch', 'true');
      barEl.setAttribute('data-om-layout-switch', 'true');

      layoutGroupEl = doc.createElement('div');
      layoutGroupEl.id = 'ag-aux-qs-layout-group';
      layoutGroupEl.className = 'ag-aux-qs-seg';
      layoutGroupEl.setAttribute('role', 'tablist');

      btnLayoutTab = buildButton('ag-aux-qs-mode-tab', 'context', 'tab', copy.layoutTab);
      btnLayoutTab.setAttribute('data-layout-mode', 'tab');
      btnLayoutSplit = buildButton('ag-aux-qs-mode-split', 'split', 'tab', copy.layoutSplit);
      btnLayoutSplit.setAttribute('data-layout-mode', 'split');

      btnLayoutTab.addEventListener('click', () => setLayoutModeAction('tab'));
      btnLayoutSplit.addEventListener('click', () => setLayoutModeAction('split'));
      layoutGroupEl.appendChild(btnLayoutTab);
      layoutGroupEl.appendChild(btnLayoutSplit);

      dividerEl = doc.createElement('span');
      dividerEl.className = 'ag-aux-qs-divider';
      dividerEl.setAttribute('aria-hidden', 'true');

      btnSwap = buildButton('ag-aux-qs-swap', 'swap', null, copy.swapOrder);
      btnSwap.addEventListener('click', () => dispatchAction('swap-order'));
      barEl.addEventListener('keydown', onKeyDown);

      barEl.appendChild(layoutGroupEl);
      barEl.appendChild(dividerEl);
      barEl.appendChild(btnSwap);

      hostContainer = container;
      container.appendChild(barEl);
      applyStateToDom();
      return barEl;
    }

    function sync(patch = {}) {
      if (disposed) return state;
      if (patch.mode === 'browser' || patch.mode === 'plugin' || patch.mode === 'both') {
        state.mode = patch.mode;
        if (patch.mode !== 'both') state.lastSingleMode = patch.mode;
      }
      if (patch.paneOrder === 'plugin-first' || patch.paneOrder === 'browser-first') {
        state.paneOrder = patch.paneOrder;
      }
      if (patch.layoutMode === 'tab' || patch.layoutMode === 'split') {
        state.layoutMode = patch.layoutMode;
      }
      if (typeof patch.showLayoutModeSwitch === 'boolean') {
        state.showLayoutModeSwitch = patch.showLayoutModeSwitch;
      }
      if (typeof patch.compactForNativeTab === 'boolean') {
        state.compactForNativeTab = patch.compactForNativeTab;
      }
      if (patch.lang) state.lang = resolveLang(patch.lang);
      if (patch.nativeViewKind !== undefined) state.nativeViewKind = String(patch.nativeViewKind || '');
      if (typeof patch.visible === 'boolean') state.visible = patch.visible;
      if (Number.isFinite(Number(patch.availableWidth))) {
        const nextW = Number(patch.availableWidth);
        state.availableWidth = nextW;
        if (state.mode === 'both' && nextW < minSplitWidth) {
          return dispatchAction('resize', { availableWidth: nextW });
        }
      }
      applyStateToDom();
      return { ...state };
    }

    function unmount() {
      if (barEl) {
        try { barEl.removeEventListener('keydown', onKeyDown); } catch { }
        try { barEl.remove?.(); } catch { }
      }
      barEl = null;
      layoutGroupEl = null;
      btnLayoutTab = null;
      btnLayoutSplit = null;
      btnSwap = null;
      dividerEl = null;
      hostContainer = null;
    }

    function destroy() {
      disposed = true;
      unmount();
    }

    return {
      mount,
      sync,
      dispatchAction,
      getState: () => ({ ...state, canSplit: state.availableWidth >= minSplitWidth }),
      unmount,
      destroy
    };
  }

  const exported = {
    AUX_QS_STYLE_ID,
    AUX_QS_ROOT_ID,
    AUX_QS_CSS,
    AUX_QS_I18N,
    AUX_NATIVE_TAB_STYLE_ID,
    AUX_NATIVE_TAB_ID,
    AUX_NATIVE_TAB_WRAP_ID,
    AUX_NATIVE_NEW_TAB_CARD_ID,
    AUX_NATIVE_PLUS_MENU_ITEM_ID,
    AUX_NATIVE_TAB_CSS,
    MIN_SIDE_BY_SIDE_WIDTH_PX,
    MIN_MAIN_CHAT_SAFE_WIDTH_PX,
    getAuxQuickSwitchCopy,
    detectNativeAuxPanelStructure,
    ensureNativePlusButtonProtected,
    shouldPreserveNativeAuxWidth,
    computeAuxQuickSwitchTransition,
    createNativeAuxTabCoexistenceController,
    createAuxQuickSwitchController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGAuxQuickSwitch = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
