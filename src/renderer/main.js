(function () {
  'use strict';
  if ((location.protocol !== 'https:' && location.protocol !== 'http:') || location.hostname !== '127.0.0.1') return;

  // 在替换或重载旧实例之前捕获当前打开面板、滚动位置与未保存设置草稿（同时兼容无 captureHotReloadState 的旧版本）
  let inheritedHotReloadState = null;
  try {
    if (typeof globalThis.__AGContextMeter?.captureHotReloadState === 'function') {
      inheritedHotReloadState = globalThis.__AGContextMeter.captureHotReloadState();
    } else if (typeof document !== 'undefined') {
      const prevHost = document.getElementById('ag-context-meter');
      const prevRoot = prevHost?.shadowRoot;
      if (prevRoot) {
        const readVal = id => prevRoot.getElementById(id)?.value;
        const readChk = id => Boolean(prevRoot.getElementById(id)?.checked);
        const pCtx = prevRoot.getElementById('panel');
        const pTokens = prevRoot.getElementById('panel-tokens');
        const pQuota = prevRoot.getElementById('panel-quota');
        const openPanel = (pQuota && !pQuota.hidden) ? 'quota'
          : ((pTokens && !pTokens.hidden) ? 'tokens'
            : ((pCtx && !pCtx.hidden) ? 'context' : 'none'));
        const activeTab = ['session', 'models', 'speed', 'settings'].find(
          k => prevRoot.getElementById(`tab-ctx-${k}`)?.classList?.contains('active')
        ) || null;
        const scrollTops = {};
        for (const sId of ['panel', 'panel-tokens', 'panel-quota', 'ctx-model-list', 'quota-view-body']) {
          const n = prevRoot.getElementById(sId);
          if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
        }
        const openDrawers = [];
        for (const btnId of [
          'btn-toggle-details', 'btn-toggle-card-details', 'btn-toggle-unlock-details',
          'btn-toggle-enhance-details', 'btn-toggle-proxy', 'btn-toggle-colors', 'btn-toggle-token-colors'
        ]) {
          if (prevRoot.getElementById(btnId)?.getAttribute?.('aria-expanded') === 'true') {
            openDrawers.push(btnId);
          }
        }
        const proxySaveBtn = prevRoot.getElementById('btn-save-proxy-config');
        const enhanceSaveBtn = prevRoot.getElementById('btn-enhance-preset-apply');
        inheritedHotReloadState = {
          capturedAt: Date.now(),
          openPanel,
          activeContextTab: activeTab,
          isContextSettingsView: activeTab === 'settings',
          scrollTops,
          openDrawers,
          drafts: {
            proxyInputDirty: Boolean(proxySaveBtn && !proxySaveBtn.hidden),
            proxyUrl: readVal('input-proxy-url'),
            proxyBypass: readVal('input-proxy-bypass'),
            ctxDraftDirty: Boolean(readVal('ctx-custom-limit-input')),
            ctxCustomValue: readVal('ctx-custom-limit-input'),
            enhanceTitleDirty: Boolean(enhanceSaveBtn && !enhanceSaveBtn.hidden),
            enhanceTitleDraft: readChk('chk-enhance-chinese-title')
          }
        };
      }
    }
  } catch { }

  globalThis.__AGContextMeter?.dispose?.();
  const activeDisposers = (globalThis.__AGContextMeterDisposers = globalThis.__AGContextMeterDisposers || new Set());
  for (const fn of Array.from(activeDisposers)) {
    try { fn(); } catch { }
  }
  activeDisposers.clear();
  // 清理此前初始化异常或重复挂载遗留的孤儿宿主容器，保证页面内永远仅有唯一实例
  try {
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('#ag-context-meter').forEach(node => {
        try {
          if (typeof node.__agForceDispose === 'function') {
            node.__agForceDispose();
            node.remove?.();
            return;
          }
          // 无主历史闭包节点：剥离 ID、隐藏且清空 shadowRoot 内容，保持其在位静默不再触发重插循环
          node.removeAttribute?.('id');
          node.setAttribute?.('data-ag-retired', '1');
          if (node.style) {
            node.style.cssText = 'display:none!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;position:absolute!important;';
          }
          if (node.shadowRoot && typeof node.shadowRoot.innerHTML === 'string') {
            node.shadowRoot.innerHTML = '';
          }
        } catch { }
      });
    }
  } catch { }
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
    computeCacheReadStats,
    summarizeCacheReadStats,
    normalizeSessionCallRecord,
    sanitizeTurnPreviewText,
    groupSessionCallsByTurns,
    ELV91_SCORE_RULE_VERSION,
    formatHumanDuration,
    computeStreamStability,
    calculateExperienceScore,
    evaluateGenerationExperience,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    convertToCNY,
    resolveEffectivePlanStatus,
    selectPrimaryQuotaBucket,
    resolveQuotaWindowBucketPair,
    splitModelDisplayAndEffort,
    resolvePlaceholderModelInfo
  } = (globalThis.__AGContextMeterCore || {});
  const VALID_DOCK_POSITIONS = ['flow'];
  const VALID_QUOTA_WINDOW_MODES = ['auto', '5h', 'weekly', 'both'];
  let dockPosition = (() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('ag_dock_position') : null;
      if (saved && saved !== 'flow') {
        localStorage.setItem('ag_dock_position', 'flow');
      }
      return 'flow';
    } catch { return 'flow'; }
  })();
  let dockFallbackReason = '';
  let quotaBadgeWindowMode = (() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('ag_quota_badge_window_mode') : null;
      return VALID_QUOTA_WINDOW_MODES.includes(saved) ? saved : 'auto';
    } catch { return 'auto'; }
  })();
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', dockPosition);
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
    dailyModelMap: {},
    dailyModelMapBySource: null,
    modelMetaByKey: null,
    speedRecords: []
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* @INSERT_STYLES_AND_TEMPLATE */

  (document.body || document.documentElement).appendChild(host);
  const el = id => {
    let node = shadow.getElementById(id);
    if (!node) {
      if (id === 'btn-github-repo-ctx') node = shadow.getElementById('btn-github-repo');
      else if (id === 'btn-check-update-ctx') node = shadow.getElementById('btn-check-update');
      else if (id === 'btn-github-repo') node = shadow.getElementById('btn-github-repo-ctx');
      else if (id === 'btn-check-update') node = shadow.getElementById('btn-check-update-ctx');
    }
    return node;
  };
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
    callsHydrated: false, syncedFinalMap: new Map(), pendingFinalCalls: new Map(),
    quarantinedOversizeMap: new Map(), flushFinalsBusy: false, pendingFlushForceSync: false,
    nextFlushRetryAt: 0, nextOversizeRetryAt: 0,
    displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
    pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
    historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
    timelineError: '', expandedTurnKeys: new Set(), timelinePageLimit: 10,
    timelineAutoExpandedRoute: null, timelineRenderedRoute: null,
    lastTimelineFetchAt: 0, lastTimelineCallSig: '', callRenderTimer: null,
    callEnterAnimTimer: null,
    speedBreakdownOpen: false, livePendingRequest: null, liveWaitTickTimer: null,
    streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;
  let activeCostModel = 'gemini-3.8-flash';
  let activeCostMode = 'ref';
  let autoCheckUpdate = true;
  let allowBetaUpdates = false;
  let cachedLatestRelease = null;

  const METER_RENDERER_VERSION = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.10';
  function formatDisplayVersion(rawVer) {
    const clean = String(rawVer ?? METER_RENDERER_VERSION).replace(/^v/i, '').trim();
    const buildDisplay = typeof METER_DISPLAY_VERSION !== 'undefined' && METER_DISPLAY_VERSION
      ? String(METER_DISPLAY_VERSION).trim()
      : '0.8.10';
    if (!clean) return buildDisplay;
    const normalizedCurrent = String(METER_RENDERER_VERSION || '').replace(/^v/i, '').trim();
    if (normalizedCurrent && clean === normalizedCurrent) return buildDisplay;
    if (clean === '0.8.8') return '0.8.8 α';
    const betaMatch = clean.match(/^(\d+\.\d+\.\d+)-beta(?:\.(\d+))?$/i);
    if (betaMatch) {
      return betaMatch[2] && betaMatch[2] !== '1' ? `${betaMatch[1]} β.${betaMatch[2]}` : `${betaMatch[1]} β`;
    }
    return `v${clean}`;
  }
  const backendStatus = {
    rendererVersion: METER_RENDERER_VERSION,
    backendSource: null,
    backendVersion: null,
    backendPid: null,
    ipcBackendVersion: (typeof window !== 'undefined' && window.__AGContextMeterBootBackend?.backendVersion)
      ? String(window.__AGContextMeterBootBackend.backendVersion)
      : null,
    liveHostVersion: (typeof window !== 'undefined' && window.__AGContextMeterLive?.version)
      ? String(window.__AGContextMeterLive.version)
      : null,
    liveHealthy: null,
    hotReloadFallback: false,
    backendVersionMismatch: false,
    lastVerifiedAtMs: null,
    lastQuotaDurationMs: null,
    lastError: null
  };

  function hasLiveHttpBridge() {
    return typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port && window.__AGContextMeterLive?.token);
  }

  function hasLiveRouteCapability(routePath) {
    if (!hasLiveHttpBridge()) return false;
    const caps = window.__AGContextMeterLive?.capabilities;
    if (!caps || typeof caps !== 'object') return true;
    const map = {
      '/quota': 'quota',
      '/scan': 'scan',
      '/token-history': 'tokenHistory',
      '/record-calls': 'recordCalls',
      '/get-settings': 'settings',
      '/save-settings': 'settings',
      '/launch-cli': 'launchCli',
      '/context-unlock-status': 'contextUnlock',
      '/context-unlock-apply': 'contextUnlock',
      '/context-unlock-restore': 'contextUnlock',
      '/enhance-status': 'enhance',
      '/enhance-apply': 'enhance',
      '/enhance-restore': 'enhance',
      '/restart-language-servers': 'enhance',
      '/modules-status': 'modules',
      '/toggle-module': 'modules',
      '/test-proxy': 'modules',
      '/accounts-overview': 'accounts',
      '/accounts-action': 'accounts',
      '/check-update': 'checkUpdate',
      '/apply-update': 'applyUpdate'
    };
    const key = map[routePath];
    if (!key) return true;
    if (Array.isArray(caps)) return caps.includes(key);
    return caps[key] !== false;
  }

  function shouldPreferLiveHost(ipcAvailable = false, routePath = '') {
    if (!hasLiveHttpBridge()) return false;
    if (routePath && !hasLiveRouteCapability(routePath)) return false;
    if (!ipcAvailable) return true;
    if (backendStatus.liveHealthy === false) return false;
    const live = window.__AGContextMeterLive || {};
    if (backendStatus.ipcBackendVersion === METER_RENDERER_VERSION) {
      return false;
    }
    if (live.version && live.version === METER_RENDERER_VERSION) {
      return true;
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterHotReloadContext?.preferLiveHost) {
      return true;
    }
    return false;
  }

  async function postLiveHttpEndpoint(routePath, body = {}, opts = {}) {
    const live = typeof window !== 'undefined' ? window.__AGContextMeterLive : null;
    if (!live?.port || !live?.token) {
      throw new Error('LIVE_BRIDGE_UNAVAILABLE');
    }
    const headers = { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token };
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    };
    if (opts.signal) fetchOpts.signal = opts.signal;
    const r = await fetch(`http://127.0.0.1:${live.port}${routePath}`, fetchOpts);
    if (!r.ok) {
      const errBody = typeof r.json === 'function' ? await r.json().catch(() => null) : null;
      const err = new Error(errBody?.error || `HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.responseData = errBody;
      throw err;
    }
    return await r.json();
  }

  function syncObservedBackendMeta(source, payloadOrRes, durationMs = null) {
    if (Number.isFinite(durationMs)) backendStatus.lastQuotaDurationMs = durationMs;
    const ver = payloadOrRes?.collectorVersion || payloadOrRes?.backendVersion || payloadOrRes?.version || payloadOrRes?.data?.collectorVersion || payloadOrRes?.data?.backendVersion || null;
    if (source === 'live-host') {
      backendStatus.liveHealthy = true;
      backendStatus.backendSource = 'live-host';
      backendStatus.hotReloadFallback = false;
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.liveHostVersion = String(ver);
      } else if (window.__AGContextMeterLive?.version) {
        backendStatus.backendVersion = String(window.__AGContextMeterLive.version);
      }
      if (payloadOrRes?.pid) backendStatus.backendPid = payloadOrRes.pid;
    } else if (source === 'electron-ipc') {
      backendStatus.backendSource = 'electron-ipc';
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.ipcBackendVersion = String(ver);
      }
    }
    backendStatus.backendVersionMismatch = Boolean(
      backendStatus.backendVersion &&
      backendStatus.backendVersion !== METER_RENDERER_VERSION
    );
    backendStatus.lastVerifiedAtMs = Date.now();
  }

  async function callBackendWithPriority({ ipcCall = null, liveRoute = '', liveBody = {}, liveFetchOpts = {}, onFallback = null } = {}) {
    const hasIpc = typeof ipcCall === 'function';
    const preferLive = shouldPreferLiveHost(hasIpc, liveRoute);
    if (preferLive && liveRoute) {
      try {
        const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
        syncObservedBackendMeta('live-host', res?.data || res);
        return { source: 'live-host', result: res };
      } catch (liveErr) {
        if (liveErr?.name === 'AbortError') throw liveErr;
        backendStatus.liveHealthy = false;
        backendStatus.lastError = liveErr?.message || String(liveErr || '');
        if (!hasIpc) throw liveErr;
        backendStatus.hotReloadFallback = true;
        if (typeof onFallback === 'function') onFallback(liveErr);
      }
    }
    if (hasIpc) {
      const res = await ipcCall();
      syncObservedBackendMeta('electron-ipc', res?.data || res);
      return { source: 'electron-ipc', result: res };
    }
    if (hasLiveHttpBridge() && liveRoute) {
      const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
      syncObservedBackendMeta('live-host', res?.data || res);
      return { source: 'live-host', result: res };
    }
    return { source: 'none', result: null };
  }

  /**
   * 获取当前有效设备像素比，用于跨屏混合 DPI 下的物理像素网格对齐
   */
  function getEffectiveDpr() {
    try {
      const dpr = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
      return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    } catch {
      return 1;
    }
  }

  /**
   * 将 CSS 逻辑坐标对齐到最近的物理设备像素边界，防止 100%/175% 混合缩放下出现亚像素偏移发虚
   */
  function snapToDevicePixel(px) {
    const num = Number(px);
    if (!Number.isFinite(num)) return 0;
    const dpr = getEffectiveDpr();
    return Math.round(num * dpr) / dpr;
  }

  /* @INSERT_COLORS_MODULE */
  // =========================================================================
  // 模块 2: 宿主布局挂载、右上角原生窗口控制区预留、渐进式宽度收缩与悬浮层定位
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let brandObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;
  const earlyDisposeHooks = [];
  const disconnectBrandObserver = () => {
    try { brandObserver?.disconnect?.(); } catch { }
    if (brandObserver && globalThis.__AGContextMeterBrandObserver === brandObserver) {
      globalThis.__AGContextMeterBrandObserver = null;
    }
    brandObserver = null;
  };
  const earlyForceDispose = () => {
    state.disposed = true;
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { }
    }
    if (layoutRaf && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(layoutRaf); } catch { }
      layoutRaf = 0;
    }
    while (earlyDisposeHooks.length) {
      const hook = earlyDisposeHooks.pop();
      try { hook(); } catch { }
    }
    try { resizeObserver?.disconnect?.(); } catch { }
    try { hostDomObserver?.disconnect?.(); } catch { }
    disconnectBrandObserver();
    if (globalThis.__AGContextMeterActiveHost === host) {
      globalThis.__AGContextMeterActiveHost = null;
    }
    activeDisposers.delete(earlyForceDispose);
    try { host.remove?.(); } catch { }
  };
  globalThis.__AGContextMeterActiveHost = host;
  host.__agForceDispose = earlyForceDispose;
  activeDisposers.add(earlyForceDispose);

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

      // 主对话区顶栏若处于窗口最顶行（无独立菜单栏，top < 20）且靠最右边，需同步避让系统控制按钮及右侧独立浮动簇
      let titlebarWcoPad = 0;
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        if (tbRect.height > 0 && tbRect.top < 20 && (vw <= 0 || tbRect.right >= vw - 16)) {
          const baseWco = computeWindowControlsWidth(titlebar);
          if (baseWco > 0) {
            titlebarWcoPad = baseWco;
            if (topRight && topRight !== titlebar && !titlebar.contains?.(topRight) && topRight.getBoundingClientRect) {
              const trRect = topRight.getBoundingClientRect();
              if (trRect.width > 0 && trRect.top < 20 && vw > 0 && trRect.left < vw) {
                titlebarWcoPad = Math.max(titlebarWcoPad, Math.ceil(vw - trRect.left) + 6);
              }
            }
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
        const activeWco = wcoWidth > 0 || titlebarWcoPad > 0;
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          titlebarWcoPad > 0 ? [
            '[class*="@container/titlebar"] {',
            `  padding-right: ${titlebarWcoPad}px !important;`,
            '}'
          ].join('\n') : '',
          activeWco ? [
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
    } catch { }
  }

  let layoutMeasurementDirty = true;
  let cachedMeasuredAvailWidth = null;
  let cachedMeasuredAvailAt = 0;
  let cachedMeasuredWinWidth = 0;

  function isNonConversationSubview() {
    try {
      if (typeof document?.querySelector !== 'function') return false;
      const hasCustomization = Boolean(
        document.querySelector('[data-testid*="customization"], [class*="customization"], [aria-label*="Customization"], [aria-label*="自定义"]')
      );
      const hasBackBtn = Boolean(
        document.querySelector('button[aria-label*="Back"], button[aria-label*="返回"], [data-testid*="back"]')
      );
      return hasCustomization || (hasBackBtn && !document.querySelector('[data-testid="composer"], textarea'));
    } catch { return false; }
  }

  function findAuxSidebarContainer() {
    try {
      if (typeof document?.querySelector !== 'function') return null;
      const auxScope = document.querySelector('[data-aux-pane-focus-scope="true"]');
      if (auxScope) {
        const tabContent = auxScope.querySelector('div[data-active-tab-id]') || auxScope;
        return tabContent;
      }
      return document.querySelector(
        '[data-testid="aux-sidebar"], [id="workbench.parts.auxiliarybar"], .auxiliary-bar, .part.auxiliarybar'
      );
    } catch { return null; }
  }

  function findEditorPageContainer() {
    try {
      if (typeof document?.querySelector !== 'function') return null;
      return document.querySelector('[id="workbench.parts.editor"], .editor-group-container, main[role="main"], .monaco-workbench .part.editor');
    } catch { return null; }
  }

  function syncDockPositionUi() {
    const seg = el('dock-pos-segmented');
    if (seg) {
      for (const btn of Array.from(seg.children || [])) {
        const mode = btn.getAttribute?.('data-dock-mode');
        const active = mode === 'flow' || mode === dockPosition;
        btn.classList?.toggle?.('active', active);
        btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
      }
    }
    const noteEl = el('dock-fallback-note');
    if (noteEl) {
      noteEl.hidden = true;
      noteEl.textContent = '';
    }
  }

  function syncDockedPanelsAttribute() {
    for (const id of ['panel', 'panel-tokens', 'panel-quota']) {
      const p = el(id);
      if (!p) continue;
      p.removeAttribute?.('data-panel-docked');
    }
  }

  function setDockPosition(mode, opts = {}) {
    const next = 'flow';
    dockPosition = next;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ag_dock_position', next);
    } catch { }
    layoutMeasurementDirty = true;
    ensureHostDocked();
    syncDockPositionUi();
    syncDockedPanelsAttribute();
    if (opts.persist !== false && (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge())) {
      void saveSettingsPayloadBridge({ dockPosition: next });
    }
    return dockPosition;
  }

  function ensureHostDocked() {
    if (state.disposed) return;
    if (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host) {
      earlyForceDispose();
      return;
    }
    dockFallbackReason = '';

    try {
      host.style.removeProperty?.('z-index');
      host.style.removeProperty?.('pointer-events');
      host.style.removeProperty?.('left');
    } catch { }
    host.style.zIndex = '';
    host.style.pointerEvents = '';
    host.style.left = '';

    // 默认或回退模式：始终内联锚定在会话标题栏右侧打开 IDE 左侧三个点的左边同一水平线上
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch { }

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch { }

      const firstRef = targetContainer.firstElementChild || targetContainer.firstChild || targetContainer.children?.[0];
      if (host.parentElement !== targetContainer || (firstRef && firstRef !== host && targetContainer !== titlebar)) {
        if (firstRef && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, firstRef);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
        host.style.removeProperty?.('bottom');
        host.style.removeProperty?.('position');
      } catch { }
      host.style.right = '';
      host.style.top = '';
      host.style.bottom = '';
      host.style.position = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch { }
      }
    } else {
      // 若未能通过标准类名定位标题栏（如全屏子视图），尝试通过右侧打开 IDE 按钮所在容器内联插入
      const nativeAnchor = findNativeTopRightAnchor();
      if (nativeAnchor && nativeAnchor !== document.body && nativeAnchor !== document.documentElement) {
        if (host.parentElement !== nativeAnchor) {
          if (nativeAnchor.firstChild) nativeAnchor.insertBefore(host, nativeAnchor.firstChild);
          else nativeAnchor.appendChild(host);
        }
        host.setAttribute('data-dock', 'flow');
        host.style.right = '';
        host.style.top = '';
        host.style.bottom = '';
        host.style.position = '';
      } else {
        // 绝不飞到窗口最上方标题栏 top: 6px！若当前没有任何可用容器，挂载到 body 但保持内联流式样式
        const fallbackParent = document.body || document.documentElement;
        if (fallbackParent && host.parentElement !== fallbackParent) {
          fallbackParent.appendChild(host);
        }
        host.setAttribute('data-dock', 'flow');
        host.style.position = 'relative';
        host.style.top = '';
        host.style.right = '';
        host.style.bottom = '';
      }
    }
    syncDockPositionUi();
    syncDockedPanelsAttribute();
    updateResponsiveLayout(layoutMeasurementDirty);
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
    // 彻底废除 fixed 模式，宿主始终内联锚定，严禁设置 top: 6px 飞至最上方标题栏
    try {
      host.style.removeProperty?.('right');
      host.style.removeProperty?.('top');
    } catch { }
    host.style.right = '';
    host.style.top = '';
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

  function measureAvailableWidth(force = false) {
    try {
      const now = Date.now();
      const curWinW = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0;
      if (
        !force
        && !layoutMeasurementDirty
        && cachedMeasuredAvailWidth !== null
        && curWinW === cachedMeasuredWinWidth
        && now - cachedMeasuredAvailAt < 300
      ) {
        return cachedMeasuredAvailWidth;
      }
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const inSubview = isNonConversationSubview();
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(inSubview ? 48 : 8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (inSubview ? 56 : (tbRect.left < 168 ? (168 - tbRect.left) : 12));
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = inSubview
            ? Math.max(160, titleRealW)
            : (tbRect.width < 760 ? Math.max(96, Math.min(180, titleRealW)) : Math.max(150, titleRealW));
          let nativeButtonsWidth = inSubview ? 120 : 64;
          let rightPad = inSubview ? 16 : 8;
          let titlebarOwnPadRight = 0;
          if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            titlebarOwnPadRight = parseFloat(window.getComputedStyle(titlebar).paddingRight) || 0;
          }
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = inSubview ? 16 : 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(inSubview ? 16 : 8, (parseFloat(rightClusterVar) || 44) - 4);
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
              if (sum > 0) nativeButtonsWidth = sum + (inSubview ? 14 : 6);
            }
          }
          const effectiveRightReserve = Math.max(rightPad, titlebarOwnPadRight);
          const avail = tbRect.width - contentStart - minTitleWidth - effectiveRightReserve - nativeButtonsWidth;
          cachedMeasuredAvailWidth = avail;
          cachedMeasuredAvailAt = now;
          cachedMeasuredWinWidth = curWinW;
          layoutMeasurementDirty = false;
          return avail;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        const avail = window.innerWidth - 360;
        cachedMeasuredAvailWidth = avail;
        cachedMeasuredAvailAt = now;
        cachedMeasuredWinWidth = curWinW;
        layoutMeasurementDirty = false;
        return avail;
      }
    } catch { }
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
      if (nextMode !== 'minimal' && nextMode !== 'ring-only') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
    }
    renderSessionCost();
  }

  function updateResponsiveLayout(forceMeasure = false) {
    if (state.disposed) return;
    if (forceMeasure) layoutMeasurementDirty = true;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth(forceMeasure);
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
      top = snapToDevicePixel(Math.max(6, Math.min(vh - tipH - 6, top)));

      let left = bRect.left + bRect.width / 2 - tipW / 2;
      left = snapToDevicePixel(Math.max(8, Math.min(vw - tipW - 8, left)));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch { }
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
    } catch { }
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
    } catch { }
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
        const effectiveDock = host.getAttribute?.('data-dock') || 'fixed';
        if ((effectiveDock === 'aux' || effectiveDock === 'page') && panelEl.id !== 'overflow-menu') {
          panelEl.setAttribute?.('data-panel-docked', 'true');
          panelEl.style.position = 'static';
          panelEl.style.top = '';
          panelEl.style.left = '';
          panelEl.style.right = '';
          panelEl.style.maxWidth = '100%';
          panelEl.style.maxHeight = '';
          return;
        }
        panelEl.removeAttribute?.('data-panel-docked');
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const dpr = getEffectiveDpr();
        const top = snapToDevicePixel(Math.max(36, Math.min(vh - 120, (bRect.bottom || hRect.bottom) + 6)));
        const isCompact = panelEl.classList?.contains?.('cost-compact-view') || panelEl.getAttribute?.('class')?.includes?.('cost-compact-view');
        const effW = isCompact ? 400 : targetW;
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(effW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，并按当前 DPI 物理像素网格对齐
        let left = snapToDevicePixel(bRect.right - finalW);
        left = Math.min(left, snapToDevicePixel(vw - finalW - 12));
        left = Math.max(snapToDevicePixel(minLeft), left);

        const maxWidthPx = Math.max(260, vw - left - 12);
        const maxHeightPx = Math.max(160, vh - top - 16);
        const geomKey = `${top}|${left}|${maxWidthPx}|${maxHeightPx}|${isCompact ? 1 : 0}|${dpr}`;
        if (panelEl._lastPlacedGeomKey === geomKey) return;
        panelEl._lastPlacedGeomKey = geomKey;

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${maxWidthPx}px`;
        panelEl.style.maxHeight = `${maxHeightPx}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      placePanel(el('panel'), 472, el(activeContextAnchorId) || el('badge'));
      placePanel(el('panel-quota'), 460, el(activeQuotaAnchorId) || el('badge-quota'));
      placePanel(el('panel-tokens'), 730, el(activeTokensAnchorId) || el('badge-tokens'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
      positionColorPickerPopover();
    } catch { }
  }

  let lastObservedHostModelSig = null;
  let hostModelSyncTimer = null;
  let domMutationThrottleTimer = null;
  function scheduleHostModelSync() {
    try {
      if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
      if (hostModelSyncTimer) return;
      hostModelSyncTimer = setTimeout(() => {
        hostModelSyncTimer = null;
        try {
          if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          const trig = document.querySelector('[data-testid="model-selector-trigger"]');
          const nextSig = trig ? `${trig.getAttribute?.('aria-label') || ''}|${trig.textContent || ''}` : '';
          if (nextSig === lastObservedHostModelSig) return;
          lastObservedHostModelSig = nextSig;
          if (typeof syncContextModelSelectionFromState === 'function') {
            syncContextModelSelectionFromState();
          }
        } catch { }
      }, 60);
    } catch { }
  }

  function flushHostDomMutationCheck() {
    domMutationThrottleTimer = null;
    if (state.disposed) return;
    if (!host.isConnected || (dockPosition === 'flow' && !findHostTitlebar()?.contains?.(host))) {
      ensureHostDocked();
    }
    scheduleHostModelSync();
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout(true));
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (state.disposed) return;
        if (!host.isConnected) {
          layoutMeasurementDirty = true;
          ensureHostDocked();
        }
        if (!domMutationThrottleTimer) {
          domMutationThrottleTimer = setTimeout(flushHostDomMutationCheck, 120);
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    }
  } catch { }

  const onWindowResize = () => {
    updateResponsiveLayout(true);
    try { syncCumResponsiveNarrowState(); } catch { }
  };
  const handleDpiOrZoomChange = () => {
    try {
      for (const id of ['panel', 'panel-quota', 'panel-tokens', 'overflow-menu']) {
        const node = el(id);
        if (node) node._lastPlacedGeomKey = '';
      }
      layoutMeasurementDirty = true;
      updateResponsiveLayout(true);
      const upPop = el('update-popover');
      if (upPop && upPop.style.display === 'block') {
        positionUpdatePopover();
      }
      if (state.tooltipOpen) positionContextTooltip();
    } catch { }
  };
  let removeDpiWatcher = null;
  const attachDpiWatcher = () => {
    try {
      if (removeDpiWatcher) {
        removeDpiWatcher();
        removeDpiWatcher = null;
      }
      if (state.disposed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const mql = window.matchMedia(`(resolution: ${getEffectiveDpr()}dppx)`);
      if (!mql) return;
      const onChange = () => {
        if (state.disposed) return;
        attachDpiWatcher();
        handleDpiOrZoomChange();
      };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        removeDpiWatcher = () => {
          try { mql.removeEventListener?.('change', onChange); } catch { }
        };
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onChange);
        removeDpiWatcher = () => {
          try { mql.removeListener?.(onChange); } catch { }
        };
      }
    } catch { }
  };
  const onWindowFocus = () => {
    host.setAttribute('data-window-active', 'true');
    if (typeof onQuotaWindowFocus === 'function') onQuotaWindowFocus();
  };
  const onWindowBlur = () => {
    host.setAttribute('data-window-active', 'false');
    if (typeof onQuotaWindowBlur === 'function') onQuotaWindowBlur();
  };
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
    attachDpiWatcher();
    earlyDisposeHooks.push(() => {
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
        if (removeDpiWatcher) {
          removeDpiWatcher();
          removeDpiWatcher = null;
        }
        if (hostModelSyncTimer) { clearTimeout(hostModelSyncTimer); hostModelSyncTimer = null; }
        if (domMutationThrottleTimer) { clearTimeout(domMutationThrottleTimer); domMutationThrottleTimer = null; }
      } catch { }
    });
  } catch { }

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
    return !el('panel').hidden || !el('panel-tokens').hidden || !el('panel-quota')?.hidden;
  }

  function showPanel(target) {
    const pContext = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const pOverflow = el('overflow-menu');
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bTokens = el('badge-tokens');
    const bQuota = el('badge-quota');
    const bOverflow = el('badge-overflow');

    hideUpdatePopover();
    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');
    if (target !== 'quota' && typeof clearQuotaBarChargeAnimations === 'function') {
      clearQuotaBarChargeAnimations();
    }

    if (target === 'tokens') {
      hideContextTooltip();
      closeColorPicker();
      pContext.hidden = true;
      if (pQuota) pQuota.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      pTokens.hidden = false;
      renderActiveHeatView(true);
      const hasCachedHistory = Boolean(ANTIGRAVITY_TOKEN_DATA.updatedAt || ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens);
      if (!hasCachedHistory || !lastHistorySync || (Date.now() - lastHistorySync) > 15000) {
        void syncTokenHistoryFromHost(false);
      }
      if (!accountsUiState?.overview && typeof refreshAccountsOverview === 'function') {
        void refreshAccountsOverview({ silent: true });
      } else {
        syncTokenAccountFilterOptions?.(ANTIGRAVITY_TOKEN_DATA.rawPayload);
      }
    } else if (target === 'quota') {
      hideContextTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      if (pQuota) pQuota.hidden = false;
      if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
      if (typeof maybeRefreshQuotaOnOpen === 'function') void maybeRefreshQuotaOnOpen();
      if (typeof renderAccountsOverviewSection === 'function') renderAccountsOverviewSection();
      if (typeof refreshAccountsOverview === 'function') void refreshAccountsOverview({ silent: true });
    } else if (target === 'context') {
      hideContextTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pTokens.hidden = true;
      if (pQuota) pQuota.hidden = true;
      bContext.setAttribute('aria-expanded', String(activeContextAnchorId === 'badge'));
      bSpeed?.setAttribute('aria-expanded', String(activeContextAnchorId === 'badge-speed'));
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      pContext.hidden = false;
      applyContextViewVisibility?.();
      if (activeContextTab === 'models' && !isContextSettingsView) {
        if (typeof syncModelListQuotaIndicators === 'function') syncModelListQuotaIndicators(null, Date.now(), true);
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
      if (pQuota) pQuota.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      closeColorPicker();
      hidePopover();
      syncHostStackingElevation(false);
    }
    syncDockedPanelsAttribute();
  }

  let activeContextAnchorId = 'badge';
  let activeTokensAnchorId = 'badge-tokens';
  let activeQuotaAnchorId = 'badge-quota';

  function toggle(open, tab = 'context') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'tokens' ? 'tokens' : (tab === 'quota' ? 'quota' : 'context'));
    }
  }

  function toggleContext(anchorId = 'badge') {
    if (!el('panel').hidden && activeContextAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeContextAnchorId = anchorId || 'badge';
      showPanel('context');
    }
  }

  function toggleTokens(anchorId = 'badge-tokens') {
    if (!el('panel-tokens').hidden && activeTokensAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeTokensAnchorId = anchorId || 'badge-tokens';
      showPanel('tokens');
    }
  }

  function toggleQuota(anchorId = 'badge-quota') {
    if (el('panel-quota') && !el('panel-quota').hidden && activeQuotaAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeQuotaAnchorId = anchorId || 'badge-quota';
      showPanel('quota');
    }
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    hideContextTooltip();
    if (willOpen) positionFloatingPanels();
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
  }

  // 外观调色按钮进入设置视图并直接展开颜色自定义抽屉
  el('btn-panel-palette')?.addEventListener('click', () => {
    openContextSettings?.({ openColors: true });
  });
  el('btn-panel-tokens-palette')?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('dock-pos-segmented')?.addEventListener('click', e => {
    const btn = e.target?.closest?.('[data-dock-mode]');
    const mode = btn?.getAttribute?.('data-dock-mode');
    if (mode) setDockPosition(mode, { persist: true });
  });
  el('quota-mode-segmented')?.addEventListener('click', e => {
    const btn = e.target?.closest?.('[data-quota-window-mode]');
    const mode = btn?.getAttribute?.('data-quota-window-mode');
    if (mode) setQuotaBadgeWindowMode(mode, { persist: true });
  });
  const onVersionBadgeActivate = () => {
    openContextSettings?.({ scrollToUpdate: true });
  };
  el('v')?.addEventListener('click', onVersionBadgeActivate);
  el('v')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onVersionBadgeActivate(); }
  });
  el('v-tokens')?.addEventListener('click', onVersionBadgeActivate);
  el('v-tokens')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onVersionBadgeActivate(); }
  });

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
    const curLang = getPanelLanguage();
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      if (!opt || opt.value === '' || opt.value === 'custom') continue;
      const p = presets.find(item => item.id === opt.value);
      if (!p) continue;
      const parts = formatPresetRegionLineParts(p, curLang);
      opt.textContent = parts.full || '';
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

    if (targetNum === null || targetNum === undefined) {
      const displayStr = targetSymbol || t('plan.summary.priceUnsetShort');
      if (typeof priceValEl.replaceChildren === 'function') {
        priceValEl.textContent = displayStr;
      } else {
        priceValEl.textContent = displayStr;
      }
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText || '';
      if (badgeEl && badgeEl.classList) badgeEl.classList.remove('is-animating');
      lastBadgePriceState = null;
      return;
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
        try { void symbolEl.offsetWidth; } catch { }
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
    const tierDisplay = typeof localizePlanTierName === 'function' ? localizePlanTierName(ps.tierName || 'Pro') : (ps.tierName || 'Pro');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : ps.hasCustomSettings
          ? t('plan.summary.custom')
          : t('plan.summary.unknown');
      sumTxt.textContent = `${tierDisplay} · ${modeTxt} · ${t('plan.summary.justNow')}`;
    }
    // 实时联动更新黄框位置的订阅费与汇率胶囊（Ultra 等无公开统一定价时不回退 Pro $19.99）
    const curSymbol = ps.currencySymbol || '$';
    let targetSymbol = '$';
    let targetNum = null;
    let targetCycle = t('plan.summary.perMonth');
    let targetCny = '';

    if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
      targetSymbol = curSymbol;
      targetNum = 0;
      targetCycle = t('plan.summary.perMonth');
      targetCny = t('plan.summary.freeWithPlan');
    } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
      targetSymbol = curSymbol;
      targetNum = Number(ps.actualPricePaid);
      targetCycle = t('plan.summary.perMonth');
      const sec = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { short: true });
      targetCny = sec ? `(${sec})` : '';
    } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
      targetSymbol = '$';
      targetNum = Number(ps.officialPriceMonthly);
      targetCycle = t('plan.summary.perMonth');
      const sec = formatSubscriptionSecondaryConversion(targetNum, 'USD', ps.region, { short: true });
      targetCny = sec ? `(${sec})` : '';
    } else {
      targetSymbol = t('plan.summary.priceUnsetShort');
      targetNum = null;
      targetCycle = '';
      targetCny = t('plan.summary.priceUnsetCny');
    }

    renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCny);

    const detName = el('p-det-name');
    if (detName) detName.textContent = typeof localizePlanTierName === 'function'
      ? localizePlanTierName(ps.tierName || 'Google AI Pro')
      : (ps.tierName || 'Google AI Pro');
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
    const tagTier = el('p-det-tier-tag');
    if (tagTier) {
      const isCustomTier = ps.sources?.tier === 'custom' || (ps.planTierOverride && ps.planTierOverride !== 'auto');
      tagTier.style.display = isCustomTier ? 'inline-block' : 'none';
      tagTier.textContent = isCustomTier ? t('plan.tag.custom') : '';
    }
    const directTierSel = el('direct-tier-select');
    const directCountrySel = el('direct-country-select');
    const rawCountryStr = ps.country ? String(ps.country).trim() : '';
    const isCountryUnknown = !rawCountryStr || rawCountryStr === '未知' || rawCountryStr === 'Unknown' || rawCountryStr.includes('未设置');
    const countryText = isCountryUnknown ? '未知' : rawCountryStr;
    const countryDisplay = countryText === '未知' ? t('plan.country.unknown') : (localizeRegionDisplayValue(countryText) || countryText);
    if (detCountry) detCountry.textContent = countryDisplay;
    if (tagCountry) {
      tagCountry.style.display = ps.countrySource === 'custom' ? 'inline-block' : 'none';
      tagCountry.textContent = ps.countrySource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detReg = el('p-det-region');
    const tagReg = el('p-det-region-tag');
    let regText = ps.subscriptionRegion || ps.region || '未知';
    if (regText.includes('未在当前会话中获取') || regText.trim() === '未知' || regText.trim() === 'Unknown') regText = '未知';
    const regDisplay = regText === '未知' ? t('plan.region.unknown') : (localizeRegionDisplayValue(regText) || regText);
    if (detReg) detReg.textContent = regDisplay;
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
      if (directTierSel) {
        directTierSel.value = ps.planTierOverride || 'auto';
      }
      if (directCountrySel) {
        if (countryText !== '未知' && directCountrySel.options) {
          const exists = Array.from(directCountrySel.options).some(o => o.value === countryText);
          if (!exists && typeof document.createElement === 'function') {
            const opt = document.createElement('option');
            opt.value = countryText;
            opt.textContent = '🌐 ' + (localizeRegionDisplayValue(countryText) || countryText);
            directCountrySel.appendChild?.(opt);
          }
        }
        directCountrySel.value = countryText;
      }
      if (directCurSel) {
        directCurSel.value = curText === 'NTD' ? 'TWD' : curText;
      }
    });

    // 刷新套餐规格、国家、订阅地区与币种直接选择器标签与选中高亮
    if (typeof refreshDirectPlanTierDisplay === 'function') {
      refreshDirectPlanTierDisplay(ps.planTierOverride || 'auto');
    }
    if (typeof refreshDirectCountryDisplay === 'function') {
      refreshDirectCountryDisplay(countryText);
    }
    if (typeof refreshDirectRegionDisplay === 'function') {
      refreshDirectRegionDisplay(regText);
    }
    if (typeof refreshDirectCurrencyDisplay === 'function') {
      refreshDirectCurrencyDisplay(curText);
    }

    // 同步更新额度面板顶部套餐胶囊 (#quota-plan-tier-pill)
    const tierPill = el('quota-plan-tier-pill');
    if (tierPill && ps.tierName && ps.tierName !== '未知') {
      setQuotaHiddenIfChanged(tierPill, false);
      setQuotaTextIfChanged(tierPill, ps.tierName);
    }

    // 同步刷新多账号列表中展示的套餐名
    if (typeof renderAccountsOverviewSection === 'function' && accountsUiState?.overview) {
      try { renderAccountsOverviewSection(); } catch {}
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
      const acqLabel = localizeAcquisitionSource(ps.acquisitionSource || ps.acquisitionSourceName);
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        detPrice.textContent = `${curSymbol}0 · ${cycleText}`;
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const secPart = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { detail: true });
        const paidFormatted = Number(ps.actualPricePaid) % 1 === 0 ? Number(ps.actualPricePaid) : Number(ps.actualPricePaid).toFixed(2);
        detPrice.textContent = secPart ? `${curSymbol}${paidFormatted} · ${cycleText} (${secPart})` : `${curSymbol}${paidFormatted} · ${cycleText}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        detPrice.textContent = `${t('plan.tag.publicRef')} $${ps.officialPriceMonthly}${t('plan.summary.perMonth')}`;
      } else {
        detPrice.textContent = `${acqLabel} · ${t('plan.priceUnsetNote')}`;
      }
    }
    if (tagPrice) {
      tagPrice.style.display = 'inline-block';
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        tagPrice.textContent = t('plan.tag.manualFree');
      } else if (ps.priceMode === 'custom' || ps.priceSource === 'custom') {
        tagPrice.textContent = t('plan.tag.userPaid');
      } else if (ps.priceSource === 'preset_region' && ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        tagPrice.textContent = t('plan.tag.official');
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        tagPrice.textContent = t('plan.tag.publicRef');
      } else {
        tagPrice.textContent = t('plan.tag.unset');
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

  function formatCompactTokenCount(v) {
    const n = Number(v) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  // 数据源切换（全部 / 桌面 / CLI）与分账号账本筛选
  let activeTokenSource = 'all';
  let activeTokenAccountFilter = 'all'; // 'all' | 'unattributed' | 'acct_xxx'
  const accountsUiState = {
    overview: null,
    toolsPreview: null,
    feedback: '',
    feedbackTone: 'info',
    busy: false,
    removeModal: {
      open: false,
      email: '',
      scopeKey: '',
      isActive: false,
      busy: false,
      error: ''
    }
  };
  function resetAccountScopedViewOffsets() {
    heatPageOffset = 0;
    heatMonthOffset = 0;
    heatYearOffset = 0;
    modelUsageOffsetDays = 0;
    modelUsageLockedKey = null;
    modelUsageHoveredKey = null;
    if (typeof resetCumSelectionState === 'function') resetCumSelectionState();
  }
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch { }
    if (typeof resetCumSelectionState === 'function') resetCumSelectionState();
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = bySrc[src] || bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      const mBySrc = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = mBySrc[src] || mBySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {};
      renderActiveHeatView(true);
      renderActiveCostEstimateView();
      renderModelUsageView();
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

  // 按模型 Token 统计状态与视图渲染
  let modelUsagePeriodDays = 7;
  let modelUsageOffsetDays = 0;
  let modelUsageGroupBy = 'model';
  let modelUsageMetric = 'total';
  let modelUsageHideUnattr = false;
  let modelUsageScaleMode = 'mixed'; // 'mixed' | 'linear'
  let modelUsageLockedKey = null;
  let modelUsageHoveredKey = null;
  const OTHER_SERIES_KEY = '__other_series__';

  function formatModelDateShort(dateStr) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return dateStr || '';
    const [y, m, d] = parts;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[m - 1] || m} ${d}`;
    }
    return `${m}/${String(d).padStart(2, '0')}`;
  }

  function formatModelRangeLabel(startStr, endStr) {
    const sp = String(startStr || '').split('-').map(Number);
    const ep = String(endStr || '').split('-').map(Number);
    if (sp.length !== 3 || ep.length !== 3) return `${startStr} – ${endStr}`;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (sp[0] === ep[0] && sp[1] === ep[1]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${ep[2]}, ${ep[0]}`;
      }
      if (sp[0] === ep[0]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
      }
      return `${months[sp[1] - 1]} ${sp[2]}, ${sp[0]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
    }
    return sp[0] === ep[0]
      ? `${startStr} – ${String(ep[1]).padStart(2, '0')}-${String(ep[2]).padStart(2, '0')}`
      : `${startStr} – ${endStr}`;
  }

  function setClassFlag(node, cls, active) {
    if (!node || !node.classList) return;
    if (active) node.classList.add(cls);
    else node.classList.remove(cls);
  }

  function applyModelSeriesFocusHighlight() {
    const focusKey = modelUsageHoveredKey || modelUsageLockedKey || null;
    const barsEl = el('model-usage-bars');
    const legendEl = el('model-usage-legend');
    if (barsEl && barsEl.children) {
      for (const col of Array.from(barsEl.children)) {
        for (const child of Array.from(col.children || [])) {
          if (String(child.className || '').includes('model-usage-stack')) {
            for (const seg of Array.from(child.children || [])) {
              const k = seg.getAttribute?.('data-series-key');
              setClassFlag(seg, 'is-dimmed', Boolean(focusKey && k !== focusKey));
            }
          }
        }
      }
    }
    if (legendEl && legendEl.children) {
      for (const card of Array.from(legendEl.children)) {
        const k = card.getAttribute?.('data-series-key');
        setClassFlag(card, 'is-dimmed', Boolean(focusKey && k !== focusKey));
        setClassFlag(card, 'is-locked', Boolean(modelUsageLockedKey && k === modelUsageLockedKey));
      }
    }
  }

  function renderModelUsageView() {
    const viewEl = el('model-usage-view');
    if (!viewEl) return;

    setPillActive(el('model-period-7d'), modelUsagePeriodDays === 7);
    setPillActive(el('model-period-30d'), modelUsagePeriodDays === 30);
    setPillActive(el('model-group-model'), modelUsageGroupBy === 'model');
    setPillActive(el('model-group-variant'), modelUsageGroupBy === 'variant');
    setPillActive(el('model-metric-total'), modelUsageMetric === 'total');
    setPillActive(el('model-metric-nocache'), modelUsageMetric === 'noCache');
    setPillActive(el('model-scale-mixed'), modelUsageScaleMode === 'mixed');
    setPillActive(el('model-scale-linear'), modelUsageScaleMode === 'linear');

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!core || typeof core.summarizeModelUsageWindow !== 'function') return;

    const todayStr = formatLocalYmd(new Date());
    const todayDate = new Date(todayStr + 'T00:00:00');
    const endDt = new Date(todayDate.getTime() - modelUsageOffsetDays * 86400000);
    const endDate = formatLocalYmd(endDt);

    const bySrcModel = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
    const dailyModelMap = bySrcModel[activeTokenSource] || bySrcModel.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {};

    const isLightTone = host.getAttribute?.('data-theme') === 'light' || host.getAttribute?.('data-panel-tone') === 'light';
    const themeAccent = customColors?.tokenAccent || (typeof heatPreset !== 'undefined' && heatPreset !== 'purple' && typeof getEffectiveHeatmapScale === 'function'
      ? getEffectiveHeatmapScale()[3]
      : '');
    const summary = core.summarizeModelUsageWindow(dailyModelMap, {
      periodDays: modelUsagePeriodDays,
      endDate,
      groupBy: modelUsageGroupBy,
      metric: modelUsageMetric,
      hideUnattributed: modelUsageHideUnattr,
      theme: isLightTone ? 'light' : 'dark',
      accentColor: themeAccent || undefined,
      modelMetaByKey: ANTIGRAVITY_TOKEN_DATA.modelMetaByKey,
      unattributedLabel: t('modelsUsage.unattributed')
    });

    // 长尾折叠：图例大于 6 项时保留 Top 5 独立颜色 + 第 6 项「其他模型/档位」
    let effectiveLegend = Array.isArray(summary.legend) ? summary.legend.slice() : [];
    const foldedKeys = new Set();
    if (effectiveLegend.length > 6) {
      const top5 = effectiveLegend.slice(0, 5);
      const tail = effectiveLegend.slice(5);
      let otherTokens = 0;
      let otherSteps = 0;
      tail.forEach(item => {
        foldedKeys.add(item.key);
        otherTokens += Number(item.tokens) || 0;
        otherSteps += Number(item.steps) || 0;
      });
      const winTot = Math.max(1, Number(summary.windowTotalTokens) || 0);
      const otherPct = (otherTokens / winTot) * 100;
      top5.push({
        key: '__other_series__',
        label: t('modelsUsage.otherSeries'),
        color: '#71717a',
        tokens: otherTokens,
        steps: otherSteps,
        pct: otherPct,
        pctLabel: otherPct < 0.1 && otherTokens > 0 ? '<0.1%' : `${otherPct.toFixed(1)}%`
      });
      effectiveLegend = top5;
    }

    if (modelUsageLockedKey && !effectiveLegend.some(it => it.key === modelUsageLockedKey)) {
      modelUsageLockedKey = null;
    }

    const rangeLbl = el('model-usage-range-label');
    if (rangeLbl) rangeLbl.textContent = formatModelRangeLabel(summary.startDate, summary.endDate);
    const winTotEl = el('model-usage-window-total');
    if (winTotEl) winTotEl.textContent = `${formatCompactTokenCount(summary.windowTotalTokens)} Tokens`;

    const unattrBtn = el('model-toggle-unattr');
    if (unattrBtn) {
      const showBtn = summary.hasUnattributed || modelUsageHideUnattr;
      unattrBtn.style.display = showBtn ? 'inline-flex' : 'none';
      setPillActive(unattrBtn, modelUsageHideUnattr);
      unattrBtn.textContent = modelUsageHideUnattr ? t('modelsUsage.showUnattr') : t('modelsUsage.hideUnattr');
    }

    const firstUse = ANTIGRAVITY_TOKEN_DATA.firstUseDate || ANTIGRAVITY_TOKEN_DATA.summary?.firstUseDate || null;
    const allModelDates = Object.keys(dailyModelMap || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const earliestKnown = allModelDates[0] && (!firstUse || allModelDates[0] < firstUse) ? allModelDates[0] : firstUse;
    const prevBtn = el('btn-model-win-prev');
    const nextBtn = el('btn-model-win-next');
    if (prevBtn) prevBtn.disabled = Boolean(earliestKnown && summary.startDate <= earliestKnown);
    if (nextBtn) nextBtn.disabled = modelUsageOffsetDays <= 0;

    const chartPxHeight = 140;
    const env = typeof core.resolveScaleEnvelope === 'function'
      ? core.resolveScaleEnvelope(summary.maxDayTotal, 'dailyBar')
      : { tier: '500M', anchor: 500e6, hCap: 1.0, refTicks: [1e6, 10e6, 100e6, 500e6], overflowThreshold: 500e6 };

    const gridWrap = el('model-usage-gridlines');
    const maxLblEl = el('model-chart-max-lbl');
    if (gridWrap) {
      const childrenArr = Array.from(gridWrap.children || []);
      const baseLines = [];
      childrenArr.forEach(node => {
        const cls = String(node.className || '');
        if (cls.includes('model-usage-tick-line')) {
          node.remove?.();
        } else {
          baseLines.push(node);
        }
      });
      if (modelUsageScaleMode === 'mixed' && typeof core.mapBarHeightPx === 'function') {
        gridWrap.style.display = 'block';
        baseLines.forEach(gl => { gl.style.display = 'none'; });
        const ticks = Array.isArray(env.refTicks) ? env.refTicks : [];
        const lastTick = ticks.length ? ticks[ticks.length - 1] : 0;
        ticks.forEach(tVal => {
          if (!(tVal > 0)) return;
          const pos = core.mapBarHeightPx(tVal, env, chartPxHeight, { mode: 'mixed', scaleKind: 'dailyBar' });
          const tickLine = document.createElement('div');
          tickLine.className = 'model-usage-tick-line';
          tickLine.style.bottom = `${pos.height.toFixed(1)}px`;
          const tickLbl = document.createElement('span');
          tickLbl.className = 'model-usage-tick-lbl';
          const isOverflowTop = Boolean(env.overflow && tVal === lastTick);
          tickLbl.textContent = isOverflowTop ? `${formatCompactTokenCount(tVal)}+` : formatCompactTokenCount(tVal);
          tickLine.appendChild(tickLbl);
          gridWrap.appendChild(tickLine);
        });
        if (maxLblEl) {
          maxLblEl.textContent = (env.overflow && summary.maxDayTotal > 0)
            ? formatCompactTokenCount(summary.maxDayTotal)
            : '';
        }
      } else {
        gridWrap.style.display = 'flex';
        gridWrap.style.flexDirection = 'column';
        gridWrap.style.justifyContent = 'space-between';
        baseLines.forEach(gl => { gl.style.display = 'block'; });
        if (maxLblEl) {
          maxLblEl.textContent = summary.maxDayTotal > 0 ? formatCompactTokenCount(summary.maxDayTotal) : '';
        }
      }
    } else if (maxLblEl) {
      maxLblEl.textContent = summary.maxDayTotal > 0 ? formatCompactTokenCount(summary.maxDayTotal) : '';
    }

    const barsEl = el('model-usage-bars');
    const xaxisEl = el('model-usage-xaxis');
    const legendEl = el('model-usage-legend');
    const emptyEl = el('model-usage-empty');
    const chartWrap = el('model-usage-chart-wrap');

    const hasAnyData = summary.windowTotalTokens > 0;
    if (emptyEl) emptyEl.style.display = hasAnyData ? 'none' : 'block';
    if (chartWrap) chartWrap.style.display = hasAnyData ? 'block' : 'none';
    if (chartWrap) chartWrap.setAttribute('data-scale-mode', modelUsageScaleMode);
    if (chartWrap) chartWrap.setAttribute('data-scale-tier', env.tier || '');

    const isCompact30 = modelUsagePeriodDays === 30;
    if (barsEl) {
      if (isCompact30) barsEl.classList?.add('compact-30');
      else barsEl.classList?.remove('compact-30');
      barsEl.replaceChildren();
    }
    if (xaxisEl) {
      if (isCompact30) xaxisEl.classList?.add('compact-30');
      else xaxisEl.classList?.remove('compact-30');
      xaxisEl.replaceChildren();
    }

    const anchorIndices = isCompact30
      ? new Set([0, 7, 14, 21, 29])
      : new Set([0, 1, 2, 3, 4, 5, 6]);
    const focusKey = modelUsageHoveredKey || modelUsageLockedKey || null;

    summary.days.forEach((day, idx) => {
      if (barsEl) {
        const col = document.createElement('div');
        col.className = 'model-usage-col';
        col.setAttribute('data-date', day.date);
        col.setAttribute('data-tokens', String(day.total || 0));

        // 折叠长尾段并保持真实 Top 顺序（column-reverse 下 index 0 在零基线底部）
        const segList = [];
        let otherSegTok = 0;
        (day.segments || []).forEach(seg => {
          if (foldedKeys.has(seg.key)) {
            otherSegTok += Number(seg.tokens) || 0;
          } else {
            segList.push({ ...seg, value: Number(seg.tokens) || 0 });
          }
        });
        if (otherSegTok > 0) {
          segList.push({
            key: '__other_series__',
            label: t('modelsUsage.otherSeries'),
            color: '#71717a',
            tokens: otherSegTok,
            value: otherSegTok,
            pct: day.total > 0 ? (otherSegTok / day.total) * 100 : 0
          });
        }
        // 点击锁定单系列时将该系列移至 0 基线底部（数组首位）
        if (modelUsageLockedKey) {
          const lockIdx = segList.findIndex(s => s.key === modelUsageLockedKey);
          if (lockIdx > 0) {
            const [lockedSeg] = segList.splice(lockIdx, 1);
            segList.unshift(lockedSeg);
          }
        }

        if (day.total > 0 && summary.maxDayTotal > 0 && segList.length > 0) {
          const barInfo = typeof core.mapBarHeightPx === 'function'
            ? core.mapBarHeightPx(day.total, env, chartPxHeight, { mode: modelUsageScaleMode, linearMax: summary.maxDayTotal, scaleKind: 'dailyBar' })
            : { height: Math.max(4, (day.total / summary.maxDayTotal) * chartPxHeight), overflow: false };
          const totalH = barInfo.height;
          const stack = document.createElement('div');
          stack.className = `model-usage-stack${barInfo.overflow && modelUsageScaleMode === 'mixed' ? ' is-overflow' : ''}`;
          stack.style.height = `${totalH.toFixed(4)}px`;
          stack.setAttribute('data-total-height', totalH.toFixed(4));

          const alloc = typeof core.allocateStackedSegmentHeights === 'function'
            ? core.allocateStackedSegmentHeights(segList, totalH, 1.5)
            : segList.map(s => ({ ...s, heightPx: (s.value / Math.max(1, day.total)) * totalH, rawRatio: s.value / Math.max(1, day.total) }));

          alloc.forEach(seg => {
            const segEl = document.createElement('div');
            segEl.className = `model-usage-seg${focusKey && seg.key !== focusKey ? ' is-dimmed' : ''}`;
            segEl.setAttribute('data-series-key', seg.key);
            segEl.setAttribute('data-raw-pct', (seg.rawRatio * 100).toFixed(2));
            segEl.style.height = `${seg.heightPx.toFixed(4)}px`;
            segEl.style.background = seg.color;
            stack.appendChild(segEl);
          });
          col.appendChild(stack);
        } else {
          const emptyBar = document.createElement('div');
          emptyBar.className = 'model-usage-empty-bar';
          col.appendChild(emptyBar);
        }

        const showBarPop = () => {
          const hp = el('heat-pop');
          const hpDate = el('heat-pop-date');
          const hpVal = el('heat-pop-val');
          const hpDet = el('heat-pop-det');
          if (!hp || !hpDate || !hpVal || !hpDet) return;
          hpDate.textContent = day.date + (day.date === todayStr ? t('heat.today') : '');
          hpVal.textContent = day.total > 0 ? `${formatCompactTokenCount(day.total)} Tokens` : '0 Tokens';
          hpDet.replaceChildren();
          if (day.segments.length > 0) {
            hpDet.style.display = 'flex';
            hpDet.style.flexDirection = 'column';
            hpDet.style.gap = '3px';
            day.segments.slice(0, 6).forEach(seg => {
              const row = document.createElement('div');
              row.style.display = 'flex';
              row.style.justifyContent = 'space-between';
              row.style.alignItems = 'center';
              row.style.gap = '10px';
              row.style.fontSize = '10.5px';
              const left = document.createElement('span');
              left.style.display = 'inline-flex';
              left.style.alignItems = 'center';
              left.style.gap = '5px';
              const dot = document.createElement('span');
              dot.style.display = 'inline-block';
              dot.style.width = '6px';
              dot.style.height = '6px';
              dot.style.borderRadius = '999px';
              dot.style.background = seg.color;
              const nm = document.createElement('span');
              nm.textContent = seg.label;
              left.appendChild(dot);
              left.appendChild(nm);
              const right = document.createElement('span');
              right.textContent = `${formatCompactTokenCount(seg.tokens)} (${Math.round(seg.pct * 10) / 10}%)`;
              row.appendChild(left);
              row.appendChild(right);
              hpDet.appendChild(row);
            });
          } else {
            hpDet.style.display = 'none';
          }
          const r = col.getBoundingClientRect();
          hp.style.left = `${r.left + r.width / 2}px`;
          hp.style.top = `${r.top - 6}px`;
          hp.style.opacity = '1';
        };
        col.addEventListener('mouseenter', showBarPop);
        col.addEventListener('mouseleave', hidePopover);
        col.addEventListener('click', showBarPop);
        barsEl.appendChild(col);
      }

      if (xaxisEl) {
        const lbl = document.createElement('div');
        lbl.className = 'model-usage-xlabel';
        lbl.textContent = anchorIndices.has(idx) ? formatModelDateShort(day.date) : '';
        xaxisEl.appendChild(lbl);
      }
    });

    if (legendEl) {
      legendEl.replaceChildren();
      effectiveLegend.forEach(item => {
        const card = document.createElement('div');
        card.className = `model-legend-item${focusKey && item.key !== focusKey ? ' is-dimmed' : ''}${modelUsageLockedKey === item.key ? ' is-locked' : ''}`;
        card.setAttribute('data-series-key', item.key);
        const bar = document.createElement('div');
        bar.className = 'model-legend-bar';
        bar.style.background = item.color;

        const textWrap = document.createElement('div');
        textWrap.className = 'model-legend-text';

        const nameEl = document.createElement('div');
        nameEl.className = 'model-legend-name';
        nameEl.textContent = item.label;
        nameEl.title = item.label;

        const valRow = document.createElement('div');
        valRow.className = 'model-legend-val-row';

        const pctEl = document.createElement('span');
        pctEl.className = 'model-legend-pct';
        pctEl.textContent = item.pctLabel;

        const metaEl = document.createElement('span');
        metaEl.className = 'model-legend-meta';
        metaEl.textContent = `${formatCompactTokenCount(item.tokens)} · ${t('modelsUsage.stepsSuffix', { n: item.steps })}`;

        valRow.appendChild(pctEl);
        valRow.appendChild(metaEl);
        textWrap.appendChild(nameEl);
        textWrap.appendChild(valRow);
        card.appendChild(bar);
        card.appendChild(textWrap);

        card.addEventListener('mouseenter', () => {
          modelUsageHoveredKey = item.key;
          applyModelSeriesFocusHighlight();
        });
        card.addEventListener('mouseleave', () => {
          if (modelUsageHoveredKey === item.key) modelUsageHoveredKey = null;
          applyModelSeriesFocusHighlight();
        });
        card.addEventListener('click', () => {
          modelUsageLockedKey = (modelUsageLockedKey === item.key) ? null : item.key;
          renderModelUsageView();
        });
        legendEl.appendChild(card);
      });
    }
  }

  function switchTokenView(v) {
    activeTokenView = v;
    // 离开 Token 统计视图时关闭订阅详情与表单
    setPlanDetailExpanded(false, { skipReposition: true });
    if (typeof hidePopover === 'function') hidePopover();

    setPillActive(el('tok-view-tokens'), v === 'tokens');
    setPillActive(el('tok-view-models'), v === 'models');
    setPillActive(el('tok-view-cost'), v === 'cost');
    const costCard = el('cost-estimate-card');
    const modelView = el('model-usage-view');
    const tokensMain = el('tokens-main-view');
    const statCards = el('token-stat-cards');
    const planBar = el('plan-summary-bar');
    const titleTokens = el('panel-tokens-title');
    const pTokens = el('panel-tokens');

    if (costCard) {
      costCard.style.display = v === 'cost' ? 'block' : 'none';
      if (v === 'cost') costCard.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (modelView) {
      modelView.style.display = v === 'models' ? 'block' : 'none';
      if (v === 'models') {
        modelView.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
        renderModelUsageView();
      }
    }
    if (tokensMain) {
      tokensMain.style.display = v === 'tokens' ? 'block' : 'none';
      if (v === 'tokens') tokensMain.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (statCards) statCards.style.display = v === 'tokens' ? 'grid' : 'none';
    if (planBar) planBar.style.display = v === 'tokens' ? 'flex' : 'none';
    if (titleTokens) {
      titleTokens.textContent = v === 'cost'
        ? t('tokens.titleCost')
        : v === 'models'
          ? t('tokens.titleModels')
          : t('tokens.title');
    }

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
  el('tok-view-models')?.addEventListener('click', () => switchTokenView('models'));
  el('tok-view-cost')?.addEventListener('click', () => switchTokenView('cost'));
  el('model-period-7d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 7;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-period-30d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 30;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-group-model')?.addEventListener('click', () => {
    modelUsageGroupBy = 'model';
    renderModelUsageView();
  });
  el('model-group-variant')?.addEventListener('click', () => {
    modelUsageGroupBy = 'variant';
    renderModelUsageView();
  });
  el('model-metric-total')?.addEventListener('click', () => {
    modelUsageMetric = 'total';
    renderModelUsageView();
  });
  el('model-metric-nocache')?.addEventListener('click', () => {
    modelUsageMetric = 'noCache';
    renderModelUsageView();
  });
  el('model-scale-mixed')?.addEventListener('click', () => {
    modelUsageScaleMode = 'mixed';
    renderModelUsageView();
  });
  el('model-scale-linear')?.addEventListener('click', () => {
    modelUsageScaleMode = 'linear';
    renderModelUsageView();
  });
  el('model-toggle-unattr')?.addEventListener('click', () => {
    modelUsageHideUnattr = !modelUsageHideUnattr;
    renderModelUsageView();
  });
  el('btn-model-win-prev')?.addEventListener('click', () => {
    modelUsageOffsetDays += modelUsagePeriodDays;
    renderModelUsageView();
  });
  el('btn-model-win-next')?.addEventListener('click', () => {
    modelUsageOffsetDays = Math.max(0, modelUsageOffsetDays - modelUsagePeriodDays);
    renderModelUsageView();
  });

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
    } catch { }

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
      const ipcFn = typeof window !== 'undefined' && typeof window.contextMeterAPI?.launchCli === 'function'
        ? () => window.contextMeterAPI.launchCli(reqOpts)
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/launch-cli',
            liveBody: reqOpts
          });
          res = out.result;
        } catch (err) {
          res = { ok: false, error: err?.message || t('cli.notFound') };
        }
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

  function syncQuotaWindowModeUi() {
    const seg = el('quota-mode-segmented');
    if (seg) {
      for (const btn of Array.from(seg.children || [])) {
        const mode = btn.getAttribute?.('data-quota-window-mode');
        const active = mode === quotaBadgeWindowMode;
        btn.classList?.toggle?.('active', active);
        btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
      }
    }
  }

  function setQuotaBadgeWindowMode(mode, opts = {}) {
    const next = VALID_QUOTA_WINDOW_MODES.includes(mode) ? mode : 'auto';
    quotaBadgeWindowMode = next;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ag_quota_badge_window_mode', next);
    } catch { }
    syncQuotaWindowModeUi();
    if (typeof renderQuotaBoard === 'function') {
      renderQuotaBoard(Date.now(), { animate: false });
    }
    if (opts.persist !== false && (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge())) {
      void saveSettingsPayloadBridge({ quotaBadgeWindowMode: next });
    }
    return quotaBadgeWindowMode;
  }

  function cycleQuotaBadgeWindowMode() {
    const idx = VALID_QUOTA_WINDOW_MODES.indexOf(quotaBadgeWindowMode);
    const next = VALID_QUOTA_WINDOW_MODES[(idx + 1) % VALID_QUOTA_WINDOW_MODES.length];
    return setQuotaBadgeWindowMode(next, { persist: true });
  }

  el('badge-quota')?.addEventListener('click', e => {
    if (e?.altKey) {
      e.preventDefault?.();
      cycleQuotaBadgeWindowMode();
      return;
    }
    toggleQuota('badge-quota');
  });
  el('badge').addEventListener('click', () => toggleContext('badge'));
  el('badge-speed')?.addEventListener('click', () => toggleContext('badge-speed'));
  el('badge-tokens').addEventListener('click', () => toggleTokens('badge-tokens'));
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-quota-btn')?.addEventListener('click', () => {
    activeQuotaAnchorId = 'badge-overflow';
    showPanel('quota');
  });
  el('overflow-speed-btn')?.addEventListener('click', () => {
    activeContextAnchorId = 'badge-overflow';
    showPanel('context');
  });
  el('overflow-tokens-btn')?.addEventListener('click', () => {
    activeTokensAnchorId = 'badge-overflow';
    showPanel('tokens');
  });
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));
  el('close-quota')?.addEventListener('click', () => showPanel('none'));
  el('badge-quota')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleQuotaBadgeWindowMode(); });

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
  const ctxCardQuotaSlot = el('ctx-card-quota-slot');
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
  } catch { }
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
    const bootSettings = (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok)
      ? window.__AGContextMeterSettings
      : null;
    if (typeof window !== 'undefined' && window.__AGContextPreferences && typeof window.__AGContextPreferences === 'object') {
      contextPreferencesMap = { ...window.__AGContextPreferences };
    } else if (bootSettings?.contextPreferences && typeof bootSettings.contextPreferences === 'object') {
      contextPreferencesMap = { ...bootSettings.contextPreferences };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawPrefs = localStorage.getItem('ag-context-preferences');
      if (rawPrefs) contextPreferencesMap = JSON.parse(rawPrefs) || {};
    }
    const initMode = (typeof window !== 'undefined' && window.__AGContextScopeMode)
      || bootSettings?.contextScopeMode
      || (typeof localStorage !== 'undefined' && localStorage?.getItem?.('ag-context-scope-mode'))
      || '';
    if (initMode === 'unified' || initMode === 'per_model') {
      contextScopeMode = initMode;
    } else if (Object.values(contextPreferencesMap).some(p => p && p.mode && p.mode !== 'default')) {
      contextScopeMode = 'per_model';
    }
    if (typeof window !== 'undefined' && window.__AGContextUnifiedPreference && typeof window.__AGContextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...window.__AGContextUnifiedPreference };
    } else if (bootSettings?.contextUnifiedPreference && typeof bootSettings.contextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...bootSettings.contextUnifiedPreference };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawUni = localStorage.getItem('ag-context-unified-preference');
      if (rawUni) contextUnifiedPreference = JSON.parse(rawUni) || contextUnifiedPreference;
    }
  } catch { }

  function getContextScopeMode() {
    return contextScopeMode || 'unified';
  }

  function getContextUnifiedPreference() {
    return contextUnifiedPreference || { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  }

  function syncContextPreferencesCache(map) {
    try {
      if (typeof window !== 'undefined') {
        const cleanMap = { ...(map || {}) };
        const cleanUni = { ...(contextUnifiedPreference || {}) };
        window.__AGContextPreferences = cleanMap;
        window.__AGContextScopeMode = contextScopeMode;
        window.__AGContextUnifiedPreference = cleanUni;
        if (window.__AGContextMeterSettings && typeof window.__AGContextMeterSettings === 'object') {
          window.__AGContextMeterSettings = {
            ...window.__AGContextMeterSettings,
            contextPreferences: cleanMap,
            contextScopeMode,
            contextUnifiedPreference: cleanUni
          };
        }
        localStorage?.setItem('ag-context-preferences', JSON.stringify(cleanMap));
        localStorage?.setItem('ag-context-scope-mode', contextScopeMode);
        localStorage?.setItem('ag-context-unified-preference', JSON.stringify(cleanUni));
      }
    } catch { }
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
  let pendingUpdateRestart = false;
  let pendingRestartVerification = null;
  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;
  let restartMismatchNotice = '';

  const observedByModelId = new Map();
  let preRestartSnapshot = null;
  try {
    const rawPre = localStorage?.getItem(CTX_PRE_RESTART_OBS_KEY);
    if (rawPre) preRestartSnapshot = JSON.parse(rawPre);
  } catch { }

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

  /**
   * 合并模型产品名与档位后缀，严格剥离尾部重复档位括号，避免出现 "(High) (High)"。
   */
  function formatProductDisplayWithEffort(rawLabel, explicitEffort = null) {
    const text = String(rawLabel || '').trim();
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (core && typeof core.splitModelDisplayAndEffort === 'function') {
      const split = core.splitModelDisplayAndEffort(text, explicitEffort || null);
      const base = split.baseLabel || text;
      const eff = explicitEffort || split.effort;
      if (!eff) return base;
      const effDisp = formatEffortZh(eff);
      if (!effDisp) return base;
      return `${base} (${effDisp})`;
    }
    if (!explicitEffort) return text;
    const effDisp = formatEffortZh(explicitEffort);
    if (!effDisp) return text;
    const low = text.toLowerCase();
    const rawEff = String(explicitEffort).trim().toLowerCase();
    if (low.endsWith(`(${rawEff})`) || low.endsWith(`(${effDisp.toLowerCase()})`)) {
      return text;
    }
    return `${text} (${effDisp})`;
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
      } catch { }
    }, delayMs);
    pendingConfirmTimers.add(tId);
  }

  function refreshBudgetUiAfterDispatch() {
    try {
      renderCompactSessionCard();
      const prod = getSelectedProductObj();
      if (prod) renderModelDetailCard(prod);
    } catch { }
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

    const effortCaseMap = {
      'extra high': 'Extra High',
      xhigh: 'XHigh',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      extra: 'Extra',
      minimal: 'Minimal',
      max: 'Max'
    };
    let baseText = rawText;
    const mParen = rawText.match(/^(.*?)\s*\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)\s*$/i);
    if (mParen) {
      baseText = mParen[1].trim() || rawText;
      if (!effort) effort = mParen[2];
    } else {
      const mTrail = rawText.match(/^(.*?)\s+(Extra High|XHigh|Low|Medium|High|Minimal|Max)\s*$/i);
      if (mTrail) {
        baseText = mTrail[1].trim() || rawText;
        if (!effort) effort = mTrail[2];
      }
    }
    const normEffort = effort ? (effortCaseMap[String(effort).trim().toLowerCase()] || effort) : null;
    const parenLabel = (normEffort && baseText && !baseText.includes('(')) ? `${baseText} (${normEffort})` : rawText;

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const resolveCand = (cand) => cand
      ? (resolveStableModelKeyClient(cand) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(cand, configs) : null))
      : null;
    const stableId = resolveCand(parenLabel) || resolveCand(rawText) || resolveCand(baseText);
    const g = groupProductSafe({
      modelId: stableId || parenLabel,
      label: parenLabel,
      effort: normEffort
    });

    return {
      rawText,
      modelId: stableId || parenLabel,
      productKey: g.productKey,
      productLabel: g.productLabel || baseText,
      effort: normEffort || g.effort || null,
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
    if (state.route && (!txResult.cascadeId || txResult.cascadeId === state.route)) {
      startLivePendingRequestWait(txResult.cascadeId || state.route);
    }
    refreshBudgetUiAfterDispatch();
    return rec;
  }

  function finishDispatchOutcome(dispatchId, ok, err) {
    if (!ok) {
      clearLivePendingRequestWait();
    }
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
    globalThis.__AG_METER_ON_SEND_MESSAGE__ = function (req, channel = 'client_object') {
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
    globalThis.__AG_METER_ON_SEND_RESULT__ = function (dispatchId, ok, err) {
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
      window.WebSocket.prototype.send = function (data) {
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
      window.fetch = async function (resource, init) {
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

      window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
          this.__agRequestUrl = typeof url === 'string' ? url : String(url || '');
          this.__agRequestHeaders = {};
        } catch { }
        return origOpen.call(this, method, url, ...rest);
      };

      if (typeof origSetHdr === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          try {
            if (this.__agRequestHeaders && typeof name === 'string') {
              this.__agRequestHeaders[name.toLowerCase()] = String(value || '');
            }
          } catch { }
          return origSetHdr.call(this, name, value);
        };
      }

      window.XMLHttpRequest.prototype.send = function (body) {
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

  let modelCapabilitiesVersion = 1;

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    let updated = false;
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
      updated = true;
    }
    if (updated) modelCapabilitiesVersion++;
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

  let cachedKnownProductsSnapshot = null;

  /** 将所有已知模型、当前会话和历史调用按产品维度分组（带签名缓存与调用模型去重，避免每次渲染重复全量分组） */
  function getKnownModelProducts() {
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const speedRecords = ANTIGRAVITY_TOKEN_DATA.speedRecords || [];
    const sessionCalls = state.sessionCalls || [];
    const latest = state.latest || null;
    const capsMap = state.modelCapabilitiesById || null;
    const prefsMap = contextPreferencesMap || {};

    let configsSig = '';
    if (Array.isArray(configs) && configs.length) {
      for (let i = 0; i < configs.length; i++) {
        const c = configs[i];
        configsSig += `${c?.modelId || c?.modelOrAlias?.model || ''}:${c?.maxTokens ?? ''}:${c?.maxOutputTokens ?? ''}:${c?.disabled ? 1 : 0}:${c?.unavailable ? 1 : 0}:${c?.isHistorical ? 1 : 0}:${c?.capabilitySource || ''};`;
      }
    }
    let prefsSig = '';
    for (const k of Object.keys(prefsMap)) {
      const p = prefsMap[k];
      prefsSig += `${k}:${p?.scope || ''}:${p?.productKey || ''}:${p?.label || ''};`;
    }
    const latestSig = latest ? `${latest.modelId || ''}|${latest.modelRaw || ''}|${latest.model || ''}|${latest.effort || ''}` : '';
    const capsLen = capsMap ? Object.keys(capsMap).length : 0;
    const speedLen = Array.isArray(speedRecords) ? speedRecords.length : 0;
    const sessLen = Array.isArray(sessionCalls) ? sessionCalls.length : 0;
    const speedEdge = speedLen ? `${speedRecords[0]?.modelExactId || speedRecords[0]?.model || ''}|${speedRecords[speedLen - 1]?.callId || speedRecords[speedLen - 1]?.modelExactId || ''}` : '';
    const sessEdge = sessLen ? `${sessionCalls[0]?.modelExactId || sessionCalls[0]?.model || ''}|${sessionCalls[sessLen - 1]?.callId || sessionCalls[sessLen - 1]?.model || ''}` : '';

    if (
      cachedKnownProductsSnapshot
      && cachedKnownProductsSnapshot.configsRef === configs
      && cachedKnownProductsSnapshot.configsSig === configsSig
      && cachedKnownProductsSnapshot.speedRef === speedRecords
      && cachedKnownProductsSnapshot.speedLen === speedLen
      && cachedKnownProductsSnapshot.speedEdge === speedEdge
      && cachedKnownProductsSnapshot.sessRef === sessionCalls
      && cachedKnownProductsSnapshot.sessLen === sessLen
      && cachedKnownProductsSnapshot.sessEdge === sessEdge
      && cachedKnownProductsSnapshot.latestSig === latestSig
      && cachedKnownProductsSnapshot.prefsSig === prefsSig
      && cachedKnownProductsSnapshot.capsVer === modelCapabilitiesVersion
      && cachedKnownProductsSnapshot.capsLen === capsLen
    ) {
      return cachedKnownProductsSnapshot.result.map(p => ({ ...p, members: p.members.slice() }));
    }

    const productMap = new Map();
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
          unavailable: Boolean(c?.unavailable || c?.disabled),
          unavailabilityReason: c?.unavailabilityReason || c?.tagDescription || null,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (latest?.modelId || latest?.modelRaw || latest?.model) {
      const stableId = resolveStableModelKeyClient(latest);
      ensureProduct({
        modelId: stableId,
        label: latest.model || stableId,
        modelOrAlias: latest.modelOrAlias,
        effort: latest.effort
      }, false);
    }

    // 先按 (modelId, label, effort) 去重，避免成百上千条同模型历史/会话调用重复执行产品分组
    const seenCallModels = new Set();
    const processCallList = (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        const mid = c.modelExactId || c.modelId || c.model;
        if (!mid) continue;
        const lbl = c.modelLabel || c.model || mid;
        const eff = c.effort || '';
        const sig = `${mid}\0${lbl}\0${eff}`;
        if (seenCallModels.has(sig)) continue;
        seenCallModels.add(sig);
        ensureProduct({
          modelId: mid,
          label: lbl,
          effort: eff || undefined
        }, false);
      }
    };
    processCallList(speedRecords);
    processCallList(sessionCalls);

    for (const [k, pref] of Object.entries(prefsMap)) {
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

    cachedKnownProductsSnapshot = {
      configsRef: configs,
      configsSig,
      speedRef: speedRecords,
      speedLen,
      speedEdge,
      sessRef: sessionCalls,
      sessLen,
      sessEdge,
      latestSig,
      prefsSig,
      capsVer: modelCapabilitiesVersion,
      capsLen,
      result
    };
    return result.map(p => ({ ...p, members: p.members.slice() }));
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
    try { localStorage?.setItem(CTX_ACTIVE_TAB_KEY, tabName); } catch { }
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
      if (!currentUnlockStatus && !unlockStatusFetchError && typeof refreshUnlockStatus === 'function') {
        void refreshUnlockStatus();
      }
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
    if (opts.scrollToUpdate) {
      try { el('settings-about-update-card')?.scrollIntoView?.({ block: 'nearest' }); } catch { }
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

  const MINI_QUOTA_RING_RADIUS = 5.5;
  const MINI_QUOTA_RING_CIRC = 2 * Math.PI * MINI_QUOTA_RING_RADIUS;
  const modelListChipByProductKey = new Map();
  let lastModelQuotaSyncSig = '';
  let quotaStateInitialized = false;

  /**
   * 安全获取额度视图（防止初始化阶段提前触发时出现 TDZ 异常）。
   */
  function getSafeQuotaViewForModelList(nowMs = Date.now()) {
    if (!quotaStateInitialized || typeof computeEffectiveQuotaView !== 'function') return null;
    try {
      return computeEffectiveQuotaView(nowMs);
    } catch {
      return null;
    }
  }

  /**
   * 兼容浏览器与精简测试环境的 SVG 节点创建函数。
   */
  function createQuotaSvgEl(tag) {
    if (typeof document === 'undefined') return null;
    if (typeof document.createElementNS === 'function') {
      return document.createElementNS('http://www.w3.org/2000/svg', tag);
    }
    return typeof document.createElement === 'function' ? document.createElement(tag) : null;
  }

  /**
   * 将模型产品对象映射到共享额度池并生成小圆环展示摘要。
   */
  function resolveProductQuotaSummary(product, quotaView = null, nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined'
      ? __AGContextMeterCore
      : (globalThis.__AGContextMeterCore || null);
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    const unknownText = t('quota.short.unknown');
    if (!product) {
      return {
        status: 'unknown',
        statusLabel: getQuotaStatusLabelText('unknown'),
        shortText: unknownText,
        fraction: null,
        poolKey: '',
        poolTitle: '',
        tooltip: '',
        ariaLabel: unknownText
      };
    }

    const pools = Array.isArray(view?.pools) ? view.pools : [];
    const membersList = Array.isArray(product.members)
      ? product.members
      : Array.from(product.members?.values?.() || []);
    const candidateIds = new Set();
    const candidateLabels = new Set();
    const pKeyLower = String(product.productKey || '').trim().toLowerCase();
    const pLabelLower = String(product.productLabel || '').trim().toLowerCase();
    if (pLabelLower) candidateLabels.add(pLabelLower);
    for (const m of membersList) {
      if (m?.modelId) candidateIds.add(String(m.modelId).trim().toLowerCase());
      if (m?.label) candidateLabels.add(String(m.label).trim().toLowerCase());
    }

    let matchedPool = null;
    let matchedModel = null;
    const isHistoryOnly = Boolean(product.isHistorical || !product.inAccountCatalog);

    // 1. 优先通过 productKey / modelIds / aliases 精确命中账号额度池模型（仅历史记录模型不借用当前活跃额度池）
    if (!isHistoryOnly) {
      for (const pool of pools) {
        for (const m of (pool.models || [])) {
          const mProdKey = String(m.productKey || '').trim().toLowerCase();
          const mLabel = String(m.productLabel || '').trim().toLowerCase();
          const mIds = Array.isArray(m.modelIds) ? m.modelIds.map(x => String(x || '').trim().toLowerCase()) : [];
          const mAliases = Array.isArray(m.aliases) ? m.aliases.map(x => String(x || '').trim().toLowerCase()) : [];
          const hit =
            (pKeyLower && mProdKey && mProdKey === pKeyLower) ||
            mIds.some(id => candidateIds.has(id)) ||
            mAliases.some(a => candidateIds.has(a) || candidateLabels.has(a)) ||
            (mLabel && candidateLabels.has(mLabel));
          if (hit) {
            matchedPool = pool;
            matchedModel = m;
            break;
          }
        }
        if (matchedPool) break;
      }

      // 2. 次级按共享额度池键归并当前账号目录内的模型
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const probeInput = {
          modelId: membersList[0]?.modelId || product.productKey,
          label: product.productLabel || membersList[0]?.label || ''
        };
        const gKey = core.getSharedQuotaGroupKey(probeInput);
        if (gKey) {
          matchedPool = pools.find(p => p.poolKey === gKey) || null;
        }
      }
    }

    const syncState = view?.syncState || 'unknown';
    const isNoPerm = Boolean(matchedModel?.noPermission || matchedPool?.noPermission || product.unavailable);
    let status = 'unknown';
    let shortText = unknownText;
    let fraction = null;

    if (isNoPerm) {
      status = 'no_permission';
      shortText = t('quota.short.no_permission');
    } else if (syncState === 'error' && !matchedPool) {
      status = 'error';
      shortText = t('quota.short.error');
    } else if (matchedPool) {
      fraction = matchedPool.remainingFraction;
      if (fraction === null || fraction === undefined) {
        status = syncState === 'stale' ? 'stale' : 'unknown';
        shortText = t(`quota.short.${status}`);
      } else if (matchedPool.isExhausted || fraction === 0) {
        status = syncState === 'stale' ? 'stale' : 'exhausted';
        shortText = t('quota.short.exhausted');
      } else {
        status = syncState === 'stale' ? 'stale' : (fraction <= 0.2 ? 'low' : 'available');
        shortText = core?.formatQuotaPercentText
          ? core.formatQuotaPercentText(fraction)
          : (matchedPool.percentText || `${Math.round(fraction * 100)}%`);
      }
    } else if (product.isHistorical || !product.inAccountCatalog) {
      status = 'unknown';
      shortText = unknownText;
    } else {
      status = syncState === 'stale' ? 'stale' : 'unknown';
      shortText = t(`quota.short.${status}`);
    }

    const statusLabel = typeof getQuotaStatusLabelText === 'function'
      ? getQuotaStatusLabelText(status)
      : status;
    const poolName = matchedPool?.title || (product.isHistorical ? t('quota.modelChip.historyHint') : t('quota.modelChip.unpooled'));
    const tipParts = [
      t('quota.modelChip.tooltip', {
        model: product.productLabel,
        pool: poolName,
        status: statusLabel,
        value: shortText
      })
    ];
    if (matchedPool?.hasResetTime && matchedPool.resetTimeText) {
      const cdStr = Number.isFinite(matchedPool.resetAtMs)
        ? ` (${formatCountdownMsCompact((matchedPool.resetAtMs || 0) - nowMs)})`
        : '';
      tipParts.push(t('quota.modelChip.resetPart', { reset: `${matchedPool.resetTimeText}${cdStr}` }));
    }
    const reason = matchedModel?.unavailabilityReason || product.unavailabilityReason;
    if (isNoPerm && reason) tipParts.push(String(reason));
    if (matchedModel?.noticeText) tipParts.push(String(matchedModel.noticeText));
    if (syncState === 'error' && view?.lastError && !matchedPool && !isNoPerm) {
      tipParts.push(String(view.lastError));
    }
    const tooltip = tipParts.join(' · ');

    return {
      status,
      statusLabel,
      shortText,
      fraction,
      poolKey: matchedPool?.poolKey || '',
      poolTitle: matchedPool?.title || '',
      tooltip,
      ariaLabel: tooltip
    };
  }

  /**
   * 更新小额度圆环芯片的圆弧进度、语义状态、数值文本与悬浮说明。
   */
  function updateMiniQuotaChipElement(chip, summary) {
    if (!chip || !summary) return;
    setQuotaAttrIfChanged(chip, 'data-quota-state', summary.status || 'unknown');
    setQuotaAttrIfChanged(chip, 'data-pool-key', summary.poolKey || '');
    setQuotaAttrIfChanged(chip, 'aria-label', summary.ariaLabel || summary.shortText);
    if (chip.title !== summary.tooltip) chip.title = summary.tooltip;
    if (chip._valNode && chip._valNode.textContent !== summary.shortText) {
      chip._valNode.textContent = summary.shortText;
    }
    const fill = chip._ringFill;
    if (!fill) return;
    if (summary.status === 'unknown' || (summary.fraction == null && summary.status === 'stale')) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', '8 26.56');
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else if (
      summary.fraction == null ||
      summary.status === 'exhausted' ||
      summary.status === 'no_permission' ||
      summary.status === 'error'
    ) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', `0 ${MINI_QUOTA_RING_CIRC.toFixed(2)}`);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else {
      const clamped = Math.max(0, Math.min(1, Number(summary.fraction) || 0));
      const arcLen = clamped > 0 ? Math.max(1.6, clamped * MINI_QUOTA_RING_CIRC) : 0;
      const dashStr = `${MINI_QUOTA_RING_CIRC.toFixed(2)} ${MINI_QUOTA_RING_CIRC.toFixed(2)}`;
      const offsetStr = (MINI_QUOTA_RING_CIRC - arcLen).toFixed(2);
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', dashStr);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', offsetStr);
    }
  }

  /**
   * 创建贴近原生 UI 的小额度圆环进度与状态芯片节点。
   */
  function createMiniQuotaChipElement(summary, opts = {}) {
    const chip = document.createElement('span');
    chip.className = `ctx-model-quota-chip${opts.variant ? ` is-${opts.variant}` : ''}`;
    const svg = createQuotaSvgEl('svg');
    let fill = null;
    if (svg) {
      svg.setAttribute?.('class', 'ctx-quota-ring-svg');
      svg.setAttribute?.('width', '13');
      svg.setAttribute?.('height', '13');
      svg.setAttribute?.('viewBox', '0 0 16 16');
      svg.setAttribute?.('aria-hidden', 'true');
      const track = createQuotaSvgEl('circle');
      if (track) {
        track.setAttribute?.('class', 'ctx-quota-ring-track');
        track.setAttribute?.('cx', '8');
        track.setAttribute?.('cy', '8');
        track.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        track.setAttribute?.('fill', 'none');
        track.setAttribute?.('stroke-width', '2');
        svg.appendChild(track);
      }
      fill = createQuotaSvgEl('circle');
      if (fill) {
        fill.setAttribute?.('class', 'ctx-quota-ring-fill');
        fill.setAttribute?.('cx', '8');
        fill.setAttribute?.('cy', '8');
        fill.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        fill.setAttribute?.('fill', 'none');
        fill.setAttribute?.('stroke-width', '2');
        fill.setAttribute?.('stroke-linecap', 'round');
        fill.setAttribute?.('transform', 'rotate(-90 8 8)');
        svg.appendChild(fill);
      }
      chip.appendChild(svg);
    }
    const valNode = document.createElement('span');
    valNode.className = 'ctx-model-quota-val';
    chip.appendChild(valNode);
    chip._ringFill = fill;
    chip._valNode = valNode;
    updateMiniQuotaChipElement(chip, summary);
    return chip;
  }

  /**
   * 原地同步模型列表、下拉选择器与选中模型卡片中的小额度圆环状态，避免重建闪烁。
   */
  function syncModelListQuotaIndicators(quotaView = null, nowMs = Date.now(), force = false) {
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    if (!view) return;
    const poolSig = (view.pools || [])
      .map(p => `${p.poolKey}:${p.remainingFraction ?? 'n'}:${p.noPermission ? 1 : 0}:${p.hasResetTime ? Math.floor(((p.resetAtMs || 0) - nowMs) / 60000) : 'x'}`)
      .join('|');
    const sig = `${view.syncState || ''}|${currentPanelLanguage}|${selectedProductKey || ''}|${poolSig}`;
    if (!force && sig === lastModelQuotaSyncSig) return;
    lastModelQuotaSyncSig = sig;

    const products = getKnownModelProducts();
    const byKey = new Map(products.map(p => [p.productKey, p]));
    const summaryCache = new Map();
    const getSummary = (prod) => {
      if (!prod) return null;
      if (!summaryCache.has(prod.productKey)) {
        summaryCache.set(prod.productKey, resolveProductQuotaSummary(prod, view, nowMs));
      }
      return summaryCache.get(prod.productKey);
    };

    for (const [pKey, entry] of modelListChipByProductKey.entries()) {
      const prod = byKey.get(pKey);
      if (!prod || !entry?.chipEl) continue;
      const summary = getSummary(prod);
      updateMiniQuotaChipElement(entry.chipEl, summary);
      if (entry.rowEl && entry.rowEl.title !== summary.tooltip) {
        entry.rowEl.title = summary.tooltip;
      }
    }

    if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.updateItemsInPlace === 'function') {
      ctxHeaderDropdownCtrl.updateItemsInPlace((val, itemEl, extraEl) => {
        const prod = byKey.get(val);
        if (!prod) return;
        const summary = getSummary(prod);
        if (extraEl) updateMiniQuotaChipElement(extraEl, summary);
        if (itemEl && itemEl.title !== summary.tooltip) itemEl.title = summary.tooltip;
      });
    }

    if (ctxCardQuotaSlot) {
      const currentProd = getSelectedProductObj();
      if (!currentProd) {
        ctxCardQuotaSlot.hidden = true;
      } else {
        const summary = getSummary(currentProd);
        ctxCardQuotaSlot.hidden = false;
        if (!ctxCardQuotaSlot._chipEl) {
          ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(summary, { variant: 'card' });
          if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
            ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
          } else {
            ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
          }
        } else {
          updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, summary);
        }
      }
    }
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
        const optionEntries = products.map((p) => {
          const pState = resolveProductPreferenceState(p);
          const optText = `${p.productLabel} (${pState.shortText})${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          return { value: p.productKey, text: optText };
        });
        const optsSig = `${currentPanelLanguage}|${optionEntries.map(o => `${o.value}=${o.text}`).join('|')}`;
        if (ctxModelSelect._lastOptionsSig !== optsSig) {
          ctxModelSelect._lastOptionsSig = optsSig;
          const opts = optionEntries.map((entry) => {
            const opt = document.createElement('option');
            opt.value = entry.value;
            opt.textContent = entry.text;
            return opt;
          });
          ctxModelSelect.replaceChildren(...opts);
        }
        if (selectedProductKey && ctxModelSelect.value !== selectedProductKey) {
          ctxModelSelect.value = selectedProductKey;
        }
      }
    }

    const nextDropdownLabel = currentProd ? currentProd.productLabel : t('models.dropdown.empty');
    if (ctxModelDropdownLabelEl && ctxModelDropdownLabelEl.textContent !== nextDropdownLabel) {
      ctxModelDropdownLabelEl.textContent = nextDropdownLabel;
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
        renderOptionExtras: (opt) => opt?.quotaSummary ? createMiniQuotaChipElement(opt.quotaSummary, { variant: 'dropdown' }) : null,
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
          const nowMs = Date.now();
          const qView = getSafeQuotaViewForModelList(nowMs);
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
            const qSummary = resolveProductQuotaSummary(p, qView, nowMs);
            items.push({
              value: p.productKey,
              label: p.productLabel,
              displayRight: pState.shortText,
              quotaSummary: qSummary,
              tooltip: qSummary.tooltip,
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
              const qSummary = resolveProductQuotaSummary(p, qView, nowMs);
              items.push({
                value: p.productKey,
                label: p.productLabel,
                displayRight: pState.shortText,
                quotaSummary: qSummary,
                tooltip: qSummary.tooltip,
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
    const nowMs = Date.now();
    const qView = getSafeQuotaViewForModelList(nowMs);
    if (!products.length) {
      modelListChipByProductKey.clear();
      ctxModelListEl._lastStructSig = '';
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const structSig = `${currentPanelLanguage}|${selectedProductKey || ''}|${activeSessionProductKey || ''}|${hasAccountCatalog ? 1 : 0}|` + products.map((p) => {
      const ps = resolveProductPreferenceState(p);
      return `${p.productKey}:${p.productLabel}:${p.vendor}:${p.unavailable ? 1 : 0}:${p.inAccountCatalog ? 1 : 0}:${p.isHistorical ? 1 : 0}:${ps.status}:${ps.shortText}:${Boolean(p.notice)}`;
    }).join(';');

    if (ctxModelListEl._lastStructSig === structSig && modelListChipByProductKey.size > 0) {
      syncModelListQuotaIndicators(qView, nowMs, false);
      return;
    }
    ctxModelListEl._lastStructSig = structSig;
    modelListChipByProductKey.clear();

    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    const prevScrollTop = ctxModelListEl.scrollTop || 0;
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
        const qSummary = resolveProductQuotaSummary(prod, qView, nowMs);
        const qChip = createMiniQuotaChipElement(qSummary, { variant: 'row' });
        right.appendChild(qChip);
        const valSpan = document.createElement('span');
        valSpan.className = `ctx-product-row-val${pState.status === 'conflict' ? ' is-conflict' : ''}`;
        valSpan.textContent = pState.shortText;
        right.appendChild(valSpan);
        row.title = qSummary.tooltip;
        modelListChipByProductKey.set(prod.productKey, { rowEl: row, chipEl: qChip });

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
    if (prevScrollTop > 0 && Math.abs((ctxModelListEl.scrollTop || 0) - prevScrollTop) > 1) {
      ctxModelListEl.scrollTop = prevScrollTop;
    }
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
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
    const isEnEval = currentPanelLanguage === 'en';
    const isTwEval = currentPanelLanguage === 'zh-TW';
    if (!product) {
      return {
        status: 'unconfirmed',
        badge: t('panel.ctx.currentModelUnconfirmed') || (isEnEval ? 'Unconfirmed' : (isTwEval ? '待確認' : '待确认')),
        pillClass: 'pill-muted',
        diagnosis: isEnEval ? 'Model metadata unavailable' : (isTwEval ? '未取得模型資訊' : '未获取到模型信息'),
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

    let targetText = t('status.savedDefault') || (isEnEval ? 'Client Default' : (isTwEval ? '還原用戶端預設' : '恢复客户端默认'));
    if (targetMode === 'dynamic') {
      targetText = t('models.preset.dynamic') || (isEnEval ? 'Dynamic' : (isTwEval ? '動態跟隨' : '动态跟随'));
    } else if (targetMode === 'fixed' && targetLimit) {
      targetText = (targetLimit === 512000) ? `512K (512,000 tokens)` : `${formatKShort(targetLimit)} (${fmt(targetLimit)} tokens)`;
      if (!isEnEval) {
        targetText = (targetLimit === 512000) ? '512K（512,000 tokens）' : `${formatKShort(targetLimit)}（${fmt(targetLimit)} tokens）`;
      }
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

    const noVerifyText = isEnEval ? 'Not verified in this session' : (isTwEval ? '尚無本次驗證' : '尚无本次验证');
    let requestText = dispatched
      ? (isEnEval ? 'Default passthrough (no override)' : (isTwEval ? '預設透傳（未附加自訂參數）' : '默认透传（未附加自定义参数）'))
      : noVerifyText;
    if (dispatched) {
      if (dispatched.status === 'send_failed') {
        const errPart = dispatched.errorMessage ? translateBackendText(dispatched.errorMessage) : (isEnEval ? 'Request incomplete' : (isTwEval ? '請求未完成' : '请求未完成'));
        requestText = isEnEval ? `Send failed (${errPart})` : (isTwEval ? `發送失敗（${errPart}）` : `发送失败（${dispatched.errorMessage || '请求未完成'}）`);
      } else if (dispatched.status === 'aborted') {
        requestText = isEnEval ? 'Aborted' : (isTwEval ? '已取消發送' : '已取消发送');
      } else if (dispatched.status === 'uninjectable') {
        requestText = isEnEval ? 'Passthrough (missing model identity / frame)' : (isTwEval ? '透傳未注入（缺少可靠模型/不支援影格）' : '透传未注入（缺少可靠模型/不支持帧）');
      } else if (dispatched.sentMode === 'fixed' && dispatched.sentLimitTokens) {
        requestText = isEnEval
          ? `${formatKShort(dispatched.sentLimitTokens)} (${fmt(dispatched.sentLimitTokens)} tokens)`
          : `${formatKShort(dispatched.sentLimitTokens)}（${fmt(dispatched.sentLimitTokens)} tokens）`;
      } else if (dispatched.sentMode === 'dynamic') {
        requestText = isEnEval ? 'Dynamic (fixed limit cleared)' : (isTwEval ? '動態跟隨（已清除固定數值）' : '动态跟随（已清除固定数值）');
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

    let observedText = noVerifyText;
    if (obsBudget > 0 && statusUsesExistingObs(evalCore.status, evalCore.diagnosisCode)) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      const tTxt = obs.ts ? ` · ${formatMonthDayTime(obs.ts)}` : '';
      observedText = isEnEval
        ? `${formatKShort(obsBudget)} (${fmt(obsBudget)} tokens)${effTxt}${tTxt}`
        : `${formatKShort(obsBudget)}（${fmt(obsBudget)} tokens）${effTxt}${tTxt}`;
    } else if (obsBudget > 0) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      observedText = isEnEval
        ? `Historical only: ${fmt(obsBudget)} tokens${effTxt} (current setting unverified)`
        : (isTwEval
          ? `僅見歷史觀測 ${fmt(obsBudget)} tokens${effTxt}（目前設定尚無本次驗證）`
          : `仅见历史观测 ${fmt(obsBudget)} tokens${effTxt}（当前设置尚无本次验证）`);
    }

    const convoId = evalCore.convoId || activeConvId || '—';

    let status = evalCore.status;
    let badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
    let pillClass = 'pill-muted';
    let diagnosis = isEnEval
      ? 'Saved target limit; it will be injected automatically on the next request.'
      : (isTwEval
        ? '已儲存目標參數，將在下次發起請求時自動注入並發送。'
        : '已保存目标参数，将在下次发起请求时自动注入并发送。');

    if (status === 'default') {
      if (evalCore.diagnosisCode === 'default_confirmed') {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-good';
        diagnosis = isEnEval
          ? `Passed through as client default (no override); reply confirmed ${fmt(obsBudget)} tokens.`
          : (isTwEval
            ? `本次請求已依用戶端預設透傳（未附加自訂覆寫），收到新回覆確認實際採用 ${fmt(obsBudget)} tokens。`
            : `本次请求已按客户端默认透传（未附加自定义覆盖），收到新回复确认实际采用 ${fmt(obsBudget)} tokens。`);
      } else {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-muted';
        diagnosis = isEnEval
          ? 'Client default active (no override); verified on next request.'
          : (isTwEval
            ? '已還原/維持用戶端預設（不附加覆寫參數），將在下一次發送時生效並驗證實際採用值。'
            : '已恢复/保持客户端默认（不附加覆盖参数），将在下一次发送时生效并验证实际采用值。');
      }
    } else if (status === 'send_failed') {
      badge = isEnEval ? 'Send failed (unconfirmed)' : (isTwEval ? '發送失敗（未確認）' : '发送失败（未确认）');
      pillClass = 'pill-bad';
      const errMsg = evalCore.errorMessage ? translateBackendText(evalCore.errorMessage) : (isEnEval ? 'network or transport error' : (isTwEval ? '網路或傳輸錯誤' : '网络或传输错误'));
      diagnosis = isEnEval
        ? `Request failed (${errMsg}); actual budget could not be confirmed.`
        : (isTwEval ? `本次請求發送失敗（${errMsg}），因此無法確認實際預算。` : `本次请求发送失败（${evalCore.errorMessage || '网络或传输错误'}），因此无法确认实际预算。`);
    } else if (status === 'aborted') {
      badge = isEnEval ? 'Aborted (unconfirmed)' : (isTwEval ? '已取消（未確認）' : '已取消（未确认）');
      pillClass = 'pill-muted';
      diagnosis = isEnEval ? 'Request was cancelled before a reply was received.' : (isTwEval ? '本次請求在完成前被取消，未收到新回覆。' : '本次请求在完成前被取消，未收到新回复。');
    } else if (status === 'uninjectable') {
      badge = isEnEval ? 'Not injected (passthrough)' : (isTwEval ? '本次未注入（已透傳）' : '本次未注入（已透传）');
      pillClass = 'pill-warn';
      const reasonTxt = evalCore.diagnosisCode || (isEnEval ? 'missing model identity or unsupported frame' : (isTwEval ? '缺少可靠模型身分或協定格式不支援' : '缺少可靠模型身份或协议格式不支持'));
      diagnosis = isEnEval
        ? `Could not inject override (${reasonTxt}); passed through unchanged.`
        : (isTwEval ? `未能向本次請求自動注入參數（${reasonTxt}），已保持原樣透傳。` : `未能向本次请求自动注入参数（${evalCore.diagnosisCode || '缺少可靠模型身份或协议格式不支持'}），已保持原样透传。`);
    } else if (status === 'confirmed') {
      badge = t('models.status.confirmed') || '实际预算已确认';
      pillClass = 'pill-good';
      diagnosis = targetMode === 'dynamic'
        ? (isEnEval ? `Dynamic mode active; observed response budget ${fmt(obsBudget)} tokens.` : (isTwEval ? `已啟用動態跟隨模式，本次發送後實測回傳預算 ${fmt(obsBudget)} tokens。` : `已启用动态跟随模式，本次发送后实测返回预算 ${fmt(obsBudget)} tokens。`))
        : (isEnEval ? `Sent ${fmt(dispatched?.sentLimitTokens || targetLimit)}; server confirmed ${fmt(obsBudget)} tokens.` : (isTwEval ? `請求實際攜帶 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次發送後伺服器端回傳預算 ${fmt(obsBudget)} tokens，完全吻合。` : `请求实际携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次发送后服务端返回预算 ${fmt(obsBudget)} tokens，完全吻合。`));
    } else if (status === 'clamped_by_model_limit') {
      badge = isEnEval ? 'Clamped by model cap' : (isTwEval ? '受模型上限限制' : '受模型上限限制');
      pillClass = 'pill-warn';
      diagnosis = isEnEval
        ? `Sent ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens, clamped to ${fmt(obsBudget)} tokens by known cap (${fmt(evalCore.knownCap)} tokens).`
        : (isTwEval ? `請求攜帶 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/伺服器端上限（${fmt(evalCore.knownCap)} tokens）限制，實際採用 ${fmt(obsBudget)} tokens。` : `请求携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/服务端上限（${fmt(evalCore.knownCap)} tokens）限制，实际采用 ${fmt(obsBudget)} tokens。`);
    } else if (status === 'mismatch') {
      badge = t('models.status.mismatch') || '未生效：目标值与观测值不一致';
      pillClass = 'pill-bad';
      let detail = isEnEval
        ? `Target (${fmt(targetLimit)} tokens) differs from observed budget (${fmt(obsBudget)} tokens).`
        : (isTwEval ? `目標設定（${fmt(targetLimit)} tokens）與發送後實際觀測預算（${fmt(obsBudget)} tokens）不一致，原因待確認。` : `目标设置（${fmt(targetLimit)} tokens）与发送后实际观测预算（${fmt(obsBudget)} tokens）不一致，原因待确认。`);
      if (product.unavailable && product.unavailabilityReason) {
        detail += isEnEval ? ` (${product.unavailabilityReason})` : `（模型可用性說明：${product.unavailabilityReason}）`;
      }
      diagnosis = detail;
    } else if (status === 'timeout_unconfirmed') {
      badge = isEnEval ? 'Timed out (unconfirmed)' : (isTwEval ? '確認逾時（未觀測到新回覆）' : '确认超时（未观测到新回复）');
      pillClass = 'pill-warn';
      const secWait = Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000);
      diagnosis = targetMode === 'default'
        ? (isEnEval ? `Sent with client default, but no budget confirmation arrived within ${secWait}s.` : (isTwEval ? `已依用戶端預設透傳發送請求，但超過 ${secWait} 秒未觀測到新回覆中的預算回傳。` : `已按客户端默认透传发送请求，但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`))
        : (isEnEval ? `Sent override (${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : 'Dynamic'}), but no reply arrived within ${secWait}s.` : (isTwEval ? `已在請求中攜帶設定（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '動態跟隨'}），但超過 ${secWait} 秒未觀測到新回覆中的預算回傳。` : `已在请求中携带设置（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`));
    } else if (status === 'dispatched_pending_confirm') {
      badge = targetMode === 'default'
        ? (isEnEval ? 'Passthrough sent; awaiting confirm' : (isTwEval ? '已預設透傳，等待確認' : '已默认透传，等待确认'))
        : (t('models.status.dispatchedPendingConfirm') || '已发送设置，等待确认');
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? (isEnEval ? 'Sent with client default (no override); awaiting reply to confirm allocated budget.' : (isTwEval ? '已依用戶端預設透傳發出請求（未附加覆寫參數），等待收到新回覆以確認伺服器端實際預算。' : '已按客户端默认透传发出请求（未附加覆盖参数），等待收到新回复以确认服务端实际预算。'))
        : (isEnEval ? `Injected (${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : 'Dynamic'}); awaiting reply to confirm budget.` : (isTwEval ? `已在本次請求中成功注入參數（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '動態跟隨'}），等待收到新回覆以確認實際分配預算。` : `已在本次请求中成功注入参数（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），等待收到新回复以确认实际分配预算。`));
    } else {
      status = 'saved_pending_dispatch';
      badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
      pillClass = 'pill-muted';
      diagnosis = isEnEval
        ? `Saved (${targetText}); will be injected on the next request for this model.`
        : (isTwEval ? `已儲存目標設定（${targetText}），下一次在對應模型發起發送時將自動注入。` : `已保存目标设置（${targetText}），下一次在对应模型发起发送时将自动注入。`);
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
      if (ctxCardQuotaSlot) ctxCardQuotaSlot.hidden = true;
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      if (ctxConflictBanner) ctxConflictBanner.hidden = true;
      if (ctxSummaryModelEl) ctxSummaryModelEl.textContent = t('models.summary.pendingConfirm');
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
    if (ctxCardQuotaSlot) {
      const nowMs = Date.now();
      const qSummary = resolveProductQuotaSummary(product, null, nowMs);
      ctxCardQuotaSlot.hidden = false;
      if (!ctxCardQuotaSlot._chipEl) {
        ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(qSummary, { variant: 'card' });
        if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
          ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
        } else {
          ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
        }
      } else {
        updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, qSummary);
      }
    }
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
        : t('models.cap.metaUnknown');
    }
    if (ctxCapClientPolicyEl) {
      if (!runtimePolicy || runtimePolicy.runtimeState === 'unknown') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyUnknown');
      } else if (runtimePolicy.runtimeState === 'pending_restart') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyPendingRestart', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyUnconfirmed', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy.runtimeState === 'partial') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyPartial');
      } else if (runtimePolicy.runtimeMode === 'dynamic') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyDynamic');
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyFixed', { limit: fmt(runtimePolicy.currentClientLimitTokens) });
      } else {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyDefault');
      }
    }
    if (ctxCapDefaultEl) {
      if (capSummary?.currentStrategyDefaultBudget != null && runtimePolicy?.policyKnown) {
        let stratNote = '';
        if (runtimePolicy.runtimeMode === 'dynamic') {
          stratNote = t('models.cap.stratDynamic');
        } else if (runtimePolicy.runtimeMode === 'fixed') {
          stratNote = t('models.cap.stratFixed', { limit: fmt(runtimePolicy.currentClientLimitTokens) });
        } else {
          stratNote = t('models.cap.stratDefault');
        }
        ctxCapDefaultEl.textContent = `${fmt(capSummary.currentStrategyDefaultBudget)} tokens${stratNote}`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapDefaultEl.textContent = t('models.cap.defaultUnknownPolicy');
      } else {
        ctxCapDefaultEl.textContent = t('speed.unknown');
      }
    }
    if (ctxCapRangeEl) {
      if (capSummary?.maxAdjustableTokens != null) {
        ctxCapRangeEl.textContent = `${fmt(capSummary.rangeMin || CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(capSummary.maxAdjustableTokens)} tokens`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapRangeEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
          ? t('models.cap.rangeUnknownPolicyMax', { max: fmt(capSummary.modelTheoreticalMaxTokens) })
          : t('models.cap.rangeUnknownPolicyEng', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) });
      } else {
        ctxCapRangeEl.textContent = t('models.cap.rangeUnknownModelMax', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) });
      }
    }
    if (ctxCapFormulaEl) {
      const parts = [];
      if (capSummary?.sources?.length) {
        const srcText = capSummary.sources.map(s => (
          s === 'get_available_models'
            ? (currentPanelLanguage === 'en' ? 'GetAvailableModels Catalog' : (currentPanelLanguage === 'zh-TW' ? 'GetAvailableModels 目錄' : 'GetAvailableModels 目录'))
            : (s === 'step_model_info'
              ? (currentPanelLanguage === 'en' ? 'Session Step ModelInfo' : (currentPanelLanguage === 'zh-TW' ? '工作階段 Step ModelInfo' : '会话 Step ModelInfo'))
              : s)
        )).join(' + ');
        parts.push(currentPanelLanguage === 'en' ? `Source: ${srcText}` : `来源：${srcText}`);
      }
      if (capSummary?.formulaNote) {
        parts.push(typeof translateBackendText === 'function' ? translateBackendText(capSummary.formulaNote) : capSummary.formulaNote);
      } else {
        parts.push(currentPanelLanguage === 'en'
          ? 'Window & max output metadata not received for current account/step (never inferred from name).'
          : (currentPanelLanguage === 'zh-TW'
            ? '尚未取得目前帳號/步驟的模型視窗與最大輸出中繼資料（不依模型名稱推測上限）。'
            : '尚未获取到当前账号/步骤的模型窗口与最大输出元数据（不按模型名称推测上限）。'));
      }
      if (capSummary?.policyNote) {
        parts.push(typeof translateBackendText === 'function' ? translateBackendText(capSummary.policyNote) : capSummary.policyNote);
      }
      if (capSummary?.hasTierVariance) {
        parts.push(currentPanelLanguage === 'en'
          ? 'Note: effort tiers report varying window/output caps; adjustable limit uses safe intersection (see Tier Capabilities below).'
          : (currentPanelLanguage === 'zh-TW'
            ? '注意：該模型不同力度檔位回報了不同容量/最大輸出，可調上限取安全交集，詳情見下方「檔位能力」。'
            : '注意：该模型不同力度档位报告了不同容量/最大输出，可调上限取安全交集，详情见下方「档位能力」。'));
      }
      if (runtimePolicy?.diskVsRuntimeMismatch) {
        parts.push(currentPanelLanguage === 'en'
          ? 'Disk config and running process not yet verified consistent: projections are treated as unconfirmed.'
          : (currentPanelLanguage === 'zh-TW'
            ? '磁碟設定與執行中程序尚未確認一致：以下預測與預設預算均依未確認處理，請勿當作已實機生效。'
            : '磁盘配置与运行中进程尚未确认一致：以下预测与默认预算均按未确认处理，请勿当作已实机生效。'));
      }
      ctxCapFormulaEl.textContent = parts.join(currentPanelLanguage === 'en' ? '; ' : '；');
    }
    if (ctxRefSavedEl) {
      const targetSavedLabel = getContextScopeMode() === 'unified'
        ? formatSavedPrefLabel(contextUnifiedPreference)
        : pState.displayText;
      ctxRefSavedEl.textContent = targetSavedLabel;
    }
    if (ctxRefSentEl) {
      ctxRefSentEl.textContent = evalResult.requestText || t('models.cap.noneVerified');
    }
    if (ctxRefAdoptedEl) {
      ctxRefAdoptedEl.textContent = evalResult.observedText || t('models.cap.noneVerified');
    }

    if (ctxUnifiedProjEl) {
      if (getContextScopeMode() === 'unified' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const allProducts = getKnownModelProducts().filter(p => p.inAccountCatalog);
        const projections = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, allProducts, currentUnlockStatus, state.modelCapabilitiesById || null);
        if (projections.length > 0 && typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxUnifiedProjEl.replaceChildren === 'function') {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'ctx-unified-proj-title';
          titleDiv.textContent = t('models.unified.projTitle');
          const rowNodes = [titleDiv];
          const isEnProj = currentPanelLanguage === 'en';
          const isTwProj = currentPanelLanguage === 'zh-TW';
          for (const pr of projections.slice(0, 8)) {
            const row = document.createElement('div');
            const isWarnRow = pr.outcome === 'clamped_to_model_max' || pr.outcome === 'exceeds_client_policy' || pr.outcome === 'clamped_by_client_policy' || pr.outcome === 'pending_restart_unconfirmed' || pr.outcome === 'partial_policy_unconfirmed' || pr.outcome === 'runtime_unconfirmed';
            row.className = `ctx-unified-proj-row${isWarnRow ? ' is-clamped' : ''}`;
            const lbl = document.createElement('span');
            lbl.textContent = pr.productLabel;
            const val = document.createElement('strong');
            if (pr.outcome === 'clamped_to_model_max') {
              val.textContent = isEnProj ? `Capped by model max -> ~${fmt(pr.projectedTokens)}` : (isTwProj ? `受模型上限限制 -> 預計 ${fmt(pr.projectedTokens)}（最大可用）` : `受模型上限限制 -> 预计 ${fmt(pr.projectedTokens)}（最大可用）`);
            } else if (pr.outcome === 'exceeds_client_policy') {
              val.textContent = isEnProj ? `Exceeds policy -> ~${fmt(pr.projectedTokens)} (limit ${fmt(pr.clientLimitTokens)})` : `超出当前客户端限制 -> 预计仅保底 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'clamped_by_client_policy') {
              val.textContent = isEnProj ? `Capped by policy -> ~${fmt(pr.projectedTokens)} (limit ${fmt(pr.clientLimitTokens)})` : `受当前客户端限制 -> 预计 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'pending_restart_unconfirmed') {
              val.textContent = isEnProj ? 'Pending restart (disk updated)' : (isTwProj ? '待重啟確認（磁碟已改）' : '待验证（磁盘已改，客户端未重启）');
            } else if (pr.outcome === 'runtime_unconfirmed') {
              val.textContent = isEnProj ? 'Pending (runtime unconfirmed)' : (isTwProj ? '待驗證（執行中程序未確認）' : '待验证（运行中进程未确认）');
            } else if (pr.outcome === 'partial_policy_unconfirmed') {
              val.textContent = t('models.cap.policyPartial');
            } else if (pr.outcome === 'unknown_policy') {
              val.textContent = t('models.cap.policyUnknown');
            } else if (pr.outcome === 'unknown_cap') {
              val.textContent = isEnProj ? 'Model cap unknown' : '模型上限未知';
            } else if (pr.outcome === 'client_default' && pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens (Policy default)` : `预计 ${fmt(pr.projectedTokens)} tokens（当前策略默认）`;
            } else if (pr.outcome === 'dynamic_follow' && pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens (Dynamic default)` : `预计 ${fmt(pr.projectedTokens)} tokens（Dynamic 默认）`;
            } else if (pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens` : `预计 ${fmt(pr.projectedTokens)} tokens`;
            } else {
              val.textContent = t('models.summary.pendingConfirm');
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
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || t('models.cap.tierStandard'));
          const winTxt = td.maxTokens ? t('models.cap.tierWin', { val: fmt(td.maxTokens) }) : t('models.cap.tierWinUnk');
          const outTxt = td.maxOutputTokens != null ? t('models.cap.tierOut', { val: fmt(td.maxOutputTokens) }) : t('models.cap.tierOutUnk');
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? t('models.cap.tierAdj', { val: fmt(td.maxTokens - td.maxOutputTokens) })
            : t('models.cap.tierAdjUnk');
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
        ctxCardClientEl.textContent = t('models.cap.diskPending', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy?.runtimeState === 'runtime_unconfirmed') {
        ctxCardClientEl.textContent = t('models.cap.diskUnconfirmed', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy?.runtimeState === 'partial') {
        ctxCardClientEl.textContent = t('models.cap.clientPartialAlert');
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'dynamic') {
        ctxCardClientEl.textContent = t('models.cap.clientDynamicOk');
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCardClientEl.textContent = t('models.cap.fixedAdvice', { val: formatKShort(runtimePolicy.currentClientLimitTokens) });
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
        ctxSummaryModelEl.textContent = t('models.summary.pendingConfirm');
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
        ctxPresetModelMaxSubEl.textContent = t('models.preset.unifiedDisabled');
      } else if (knownEnvMax != null) {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.envMax', { val: fmt(knownEnvMax) });
      } else if (!policyKnown && knownModelMax != null) {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.policyUnconfirmed', { val: fmt(knownModelMax) });
      } else {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.metaPending');
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
      const isEnPre = currentPanelLanguage === 'en';
      const isTwPre = currentPanelLanguage === 'zh-TW';
      if (bMode === 'model_max') {
        if (isUnified) {
          disabled = true;
          disableReason = isEnPre
            ? 'Max capacity varies per model in unified mode. Switch to Per-Model or enter a specific number.'
            : (isTwPre
              ? '統一模式下各模型最大可用上限不同，請切換為依模型個別設定或填寫具體數值。'
              : '统一模式下各模型最大可用上限不同，请切换到按模型分别设置或填写具体数值。');
        } else if (knownModelMax == null) {
          disabled = true;
          disableReason = isEnPre
            ? 'Context window and max output metadata not loaded yet for this model.'
            : (isTwPre
              ? '尚未取得此模型的上下文視窗與最大輸出中繼資料，無法計算最大可用值。'
              : '尚未获取到该模型的上下文窗口与最大输出元数据，无法计算最大可用值。');
        } else if (!policyKnown || knownEnvMax == null) {
          disabled = true;
          disableReason = isEnPre
            ? 'Client runtime policy is unknown or pending restart; environment max cannot be verified yet.'
            : (isTwPre
              ? '目前用戶端執行策略未知或待重啟確認，暫無法確定目前環境最大可用上限。'
              : '当前客户端运行策略未知或待重启确认，暂无法确定当前环境最大可用上限。');
        }
      } else if (bMode === 'fixed' && bLim && knownModelMax != null && bLim > knownModelMax) {
        disabled = true;
        disableReason = isEnPre
          ? `Preset ${fmt(bLim)} exceeds model theoretical input cap ${fmt(knownModelMax)} (window - max output).`
          : (isTwPre
            ? `預設 ${fmt(bLim)} 超出目前模型理論輸入上限 ${fmt(knownModelMax)}（總視窗 - 最大輸出）。`
            : `预设 ${fmt(bLim)} 超出当前模型理论输入上限 ${fmt(knownModelMax)}（总窗口 - 最大输出）。`);
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
      ctxValidationEl.textContent = t('models.validation.defaultDesc');
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
    if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  ctxPresetGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.ctx-preset-btn');
    if (!btn || btn.disabled) return;
    userActionSeq++;
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
    userActionSeq++;
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
    const ipcFn = window.contextMeterAPI?.saveSettings
      ? () => window.contextMeterAPI.saveSettings(payload)
      : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge') };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/save-settings',
        liveBody: payload
      });
      return out.result || { ok: false, error: t('msg.noHostBridge') };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
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
    userActionSeq++;
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
    userActionSeq++;
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
    userActionSeq++;
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
    const ipcMap = {
      status: window.contextMeterAPI?.getContextUnlockStatus,
      apply: window.contextMeterAPI?.applyContextUnlock,
      restore: window.contextMeterAPI?.restoreContextUnlock
    };
    const ipcFn = typeof ipcMap[endpoint] === 'function' ? () => ipcMap[endpoint](payload) : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('models.err.noApplyBridge') };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: `/context-unlock-${endpoint}`,
        liveBody: payload
      });
      return out.result || { ok: false, error: t('models.err.noApplyBridge') };
    } catch (e) {
      return { ok: false, error: e?.message || t('models.err.noApplyBridge') };
    }
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (hasLiveHttpBridge()) {
      try {
        return await postLiveHttpEndpoint('/restart-host', {});
      } catch {
        return { ok: true, supported: false };
      }
    }
    return { ok: true, supported: false };
  }

  async function invokeEnhanceApi(endpoint, payload = {}) {
    const ipcMap = {
      status: window.contextMeterAPI?.getEnhanceStatus,
      apply: window.contextMeterAPI?.applyEnhancePatch,
      restore: window.contextMeterAPI?.restoreAllEnhance,
      'restart-ls': window.contextMeterAPI?.restartLanguageServers
    };
    const routeMap = {
      status: '/enhance-status',
      apply: '/enhance-apply',
      restore: '/enhance-restore',
      'restart-ls': '/restart-language-servers'
    };
    const ipcFn = typeof ipcMap[endpoint] === 'function' ? () => ipcMap[endpoint](payload) : null;
    const liveRoute = routeMap[endpoint] || '';
    if ((!ipcFn && !hasLiveHttpBridge()) || !liveRoute) {
      return { ok: false, errorKey: 'enhance.result.noBridge', error: t('enhance.result.noBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute,
        liveBody: payload
      });
      return out.result || { ok: false, errorKey: 'enhance.result.noBridge', error: t('enhance.result.noBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('enhance.result.noBridge') };
    }
  }

  async function invokeModulesApi(action, name, enable, opts = {}) {
    const ipcFn = (action === 'status' && typeof window.contextMeterAPI?.getModulesStatus === 'function')
      ? () => window.contextMeterAPI.getModulesStatus()
      : ((action === 'toggle' && typeof window.contextMeterAPI?.toggleModule === 'function')
        ? () => window.contextMeterAPI.toggleModule(name, enable, opts)
        : null);
    const liveRoute = action === 'status' ? '/modules-status' : '/toggle-module';
    const liveBody = action === 'status' ? {} : { name, enable, opts };
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute,
        liveBody
      });
      return out.result || { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
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
        syncRecommendedCheckboxes();
        if (unlockStatusDesc) unlockStatusDesc.textContent = t('status.client.unavailable');
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
        return;
      }

      unlockStatusFetchError = false;
      const data = res.data;
      currentUnlockStatus = data;
      syncRecommendedCheckboxes();
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
        const archSupported = data.isPlatformSupported !== false && (!data.arch || data.arch === 'x86-64' || data.arch === 'arm64');
        if (writableStatuses.has(data.status) && archSupported) {
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
      if (typeof syncEnhanceInteractiveDisabledState === 'function') {
        syncEnhanceInteractiveDisabledState();
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

  function yieldForSettingsPaint() {
    if (typeof requestAnimationFrame === 'function') {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (typeof MessageChannel === 'function') {
      return new Promise((resolve) => {
        const mc = new MessageChannel();
        mc.port1.onmessage = () => resolve();
        mc.port2.postMessage(null);
      });
    }
    return Promise.resolve();
  }

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
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    showUnlockResultBox(true, t('mod.processing'));
    needsRestartAfterApply = false;
    restartMismatchNotice = '';

    try {
      await yieldForSettingsPaint();
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
      if (btnApplyUnlock) btnApplyUnlock.disabled = false;
      if (btnRestoreUnlock) btnRestoreUnlock.disabled = false;
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
    } catch { }

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
      const upStatusEl = el('up-pop-status');
      const upPop = el('update-popover');
      if (upStatusEl && upPop && upPop.style.display === 'block') {
        upStatusEl.style.display = 'block';
        upStatusEl.textContent = t('client.restart.hostNotSupported');
      }
      renderQuotaBoard?.();
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
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    showUnlockResultBox(true, t('mod.processing'));

    try {
      await yieldForSettingsPaint();
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
      if (btnRestoreUnlock) btnRestoreUnlock.disabled = false;
      if (btnApplyUnlock) btnApplyUnlock.disabled = false;
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
      const displayLabel = formatProductDisplayWithEffort(g.productLabel, g.effort);
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
        speedDropLabel.textContent = formatProductDisplayWithEffort(chosenGroup.productLabel, chosenGroup.effort);
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
          return {
            value: g.modelExactId,
            label: formatProductDisplayWithEffort(g.productLabel, g.effort),
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
    } catch { }

    if (!opened) {
      try {
        const w = window.open(UNLOCK_POST_URL, '_blank');
        if (w) opened = true;
      } catch { }
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
    } catch { }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = UNLOCK_POST_URL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch { }
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
      if (proxyDrawerArrow && proxyDrawerBody) {
        const open = proxyDrawerBody.style.display === 'block';
        proxyDrawerArrow.textContent = open ? t('drawer.shortCollapse') : t('drawer.shortExpand');
      }
      if (chineseDrawerArrow && chineseDrawerBody) {
        const open = chineseDrawerBody.style.display === 'block';
        chineseDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
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
    } catch { }
    try { if (typeof applyTheme === 'function') applyTheme(); } catch { }
    try { render(); } catch { }
    try { renderSessionCost(); } catch { }
    try { if (typeof renderQuotaBoard === 'function') renderQuotaBoard(); } catch { }
    try { renderHeaderModelDropdown(); } catch { }
    try { renderModelSettingsTab(); } catch { }
    try { renderSpeedComparisonTab(); } catch { }
    try { if (currentUnlockStatus) { renderClientStatusBar(); renderCompactSessionCard(); } } catch { }
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      } else {
        const pv = el('plan-summary-price-val');
        if (pv && /^\$19\.99\/(月|mo)$/.test(String(pv.textContent || '').trim())) {
          pv.textContent = `$19.99${t('plan.summary.perMonth')}`;
        }
      }
      const countryInp = el('input-custom-country');
      if (countryInp && countryInp.value) {
        const locCountry = localizeRegionDisplayValue(countryInp.value);
        if (locCountry) countryInp.value = locCountry;
      }
      const regInp = el('input-custom-region');
      if (regInp && regInp.value) {
        const locReg = localizeRegionDisplayValue(regInp.value);
        if (locReg) regInp.value = locReg;
      }
      if (typeof refreshRegionPresetSelectOptions === 'function') refreshRegionPresetSelectOptions();
      if (typeof refreshDirectPlanTierDisplay === 'function') refreshDirectPlanTierDisplay();
      if (typeof refreshDirectCountryDisplay === 'function') refreshDirectCountryDisplay();
      if (typeof refreshDirectRegionDisplay === 'function') refreshDirectRegionDisplay();
      if (typeof refreshDirectCurrencyDisplay === 'function') refreshDirectCurrencyDisplay();
      if (typeof refreshValidEndDatePicker === 'function') refreshValidEndDatePicker();
      if (typeof updateRegionCnyPreviewFromForm === 'function') updateRegionCnyPreviewFromForm();
      if (typeof syncAllNativeSelectDropdowns === 'function') syncAllNativeSelectDropdowns();
    } catch { }
    try {
      if (typeof renderEnhanceSectionUI === 'function') renderEnhanceSectionUI();
      if (typeof rerenderSettingsFeedbacks === 'function') rerenderSettingsFeedbacks();
      if (typeof renderAccountsOverviewSection === 'function' && accountsUiState?.overview) {
        renderAccountsOverviewSection();
      }
    } catch { }
    try {
      if (isChineseExpanded || isProxyExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView && typeof refreshEnhanceStatus === 'function') {
        void refreshEnhanceStatus(false);
      }
    } catch { }
    try {
      const basePayload = ANTIGRAVITY_TOKEN_DATA?.rawPayload || ANTIGRAVITY_TOKEN_DATA;
      if (typeof applyTokenHistoryPayload === 'function' && basePayload) {
        applyTokenHistoryPayload(basePayload);
      }
    } catch { }

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch { }
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
  const btnSaveProxyConfig = el('btn-save-proxy-config');
  const btnToggleProxyModule = el('btn-toggle-proxy-module');
  const proxyTestResult = el('proxy-test-result');

  let isProxyExpanded = false;
  let currentProxyEnabled = false;
  let proxyInputDirty = false;
  let savedProxyUrl = '';
  let savedProxyBypass = '';
  let isProxyBusy = false;
  let modulesStatusReqSeq = 0;

  function proxyInputsDifferFromSaved() {
    const curUrl = String(inputProxyUrl?.value ?? '').trim();
    const curBypass = String(inputProxyBypass?.value ?? '').trim();
    return Boolean(
      (curUrl && curUrl !== savedProxyUrl) ||
      (curBypass !== savedProxyBypass)
    );
  }

  function syncProxySaveButtonState() {
    if (!btnSaveProxyConfig) return;
    const show = Boolean(currentProxyEnabled && (proxyInputDirty || proxyInputsDifferFromSaved()));
    btnSaveProxyConfig.hidden = !show;
    btnSaveProxyConfig.disabled = Boolean(isProxyBusy);
    btnSaveProxyConfig.textContent = isProxyBusy ? t('mod.proxy.btnSaving') : t('mod.proxy.btnSave');
  }

  inputProxyUrl?.addEventListener('input', () => {
    proxyInputDirty = true;
    syncProxySaveButtonState();
  });
  inputProxyBypass?.addEventListener('input', () => {
    proxyInputDirty = true;
    syncProxySaveButtonState();
  });

  async function invokeTestProxyApi(proxyUrl) {
    const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.testProxy === 'function')
      ? () => window.contextMeterAPI.testProxy(proxyUrl)
      : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/test-proxy',
        liveBody: { proxyUrl }
      });
      return out.result || { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
  }

  btnToggleProxy?.addEventListener('click', () => {
    isProxyExpanded = !isProxyExpanded;
    if (proxyDrawerBody) proxyDrawerBody.style.display = isProxyExpanded ? 'block' : 'none';
    if (proxyDrawerArrow) proxyDrawerArrow.textContent = isProxyExpanded ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleProxy?.setAttribute('aria-expanded', String(isProxyExpanded));
    if (isProxyExpanded) {
      void refreshModulesDisplay();
    }
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
  let enhanceTierDirty = false;
  let enhanceTitleDirty = false;
  let enhanceStatusReqSeq = 0;
  let pendingEnhanceConfirmMode = null; // 'preset' | 'restore' | null
  let isEnhanceBusy = false;
  let isLsRestartBusy = false;
  let hasPendingLsReload = false;
  let enhanceGlobalResultState = null; // { ok, resolveMessage, opts }
  let enhancePromptResultState = null; // { ok, resolveMessage }
  let brandFeedbackState = null;       // { mode, isSuccess, resolveMessage, isApplied }
  let lastProxyTestState = null;       // { pending, thrownErr, res }
  const recDirty = { prompt: false, title: false, lang: false, ctx: false };

  function recommendedPromptOn() {
    const s = currentEnhanceStatus?.summary || currentEnhanceStatus;
    return Number(s?.promptTier) === 4;
  }
  function recommendedTitleOn() {
    const s = currentEnhanceStatus?.summary || currentEnhanceStatus;
    return s?.chineseTitleMode === 'zh';
  }
  function recommendedLangOn() {
    return Boolean(currentChineseEnabled);
  }
  function recommendedCtxOn() {
    return currentUnlockStatus?.configuredMode === 'dynamic';
  }

  function getRecommendedDiff() {
    const diff = [];
    if (Boolean(chkPresetPrompt?.checked) !== recommendedPromptOn()) diff.push({ key: 'prompt', enable: Boolean(chkPresetPrompt?.checked) });
    if (Boolean(chkPresetTitle?.checked) !== recommendedTitleOn()) diff.push({ key: 'title', enable: Boolean(chkPresetTitle?.checked) });
    if (Boolean(chkPresetLang?.checked) !== recommendedLangOn()) diff.push({ key: 'lang', enable: Boolean(chkPresetLang?.checked) });
    if (Boolean(chkPresetCtx?.checked) !== recommendedCtxOn()) diff.push({ key: 'ctx', enable: Boolean(chkPresetCtx?.checked) });
    return diff;
  }

  function syncRecommendedCheckboxes({ force = false } = {}) {
    const unsupported = Boolean(currentEnhanceStatus && currentEnhanceStatus.supported === false);
    const ctxUnsupported = Boolean(
      currentUnlockStatus &&
      currentUnlockStatus.isPlatformSupported === false &&
      currentUnlockStatus.status === 'unsupported'
    );
    if (chkPresetPrompt && (force || !recDirty.prompt)) {
      chkPresetPrompt.checked = !unsupported && recommendedPromptOn();
      if (force) recDirty.prompt = false;
    }
    if (chkPresetTitle && (force || !recDirty.title)) {
      chkPresetTitle.checked = !unsupported && recommendedTitleOn();
      if (force) recDirty.title = false;
    }
    if (chkPresetLang && (force || !recDirty.lang)) {
      chkPresetLang.checked = recommendedLangOn();
      if (force) recDirty.lang = false;
    }
    if (chkPresetCtx && (force || !recDirty.ctx)) {
      chkPresetCtx.checked = !ctxUnsupported && recommendedCtxOn();
      if (force) recDirty.ctx = false;
    }
  }

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

  function syncEnhanceInteractiveDisabledState() {
    const unsupported = Boolean(currentEnhanceStatus && currentEnhanceStatus.supported === false);
    const lockPromptControls = Boolean(isEnhanceBusy || unsupported);
    const allTierBtns = enhanceTierGrid?.querySelectorAll?.('[data-enhance-tier]') || enhanceTierBtns.filter(Boolean);
    allTierBtns.forEach?.((btn) => {
      btn.disabled = lockPromptControls;
    });
    if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.disabled = lockPromptControls;
    if (btnApplyEnhancePrompt) btnApplyEnhancePrompt.disabled = lockPromptControls;
    if (btnRefreshEnhance) btnRefreshEnhance.disabled = Boolean(isEnhanceBusy);
    if (btnEnhancePresetApply) btnEnhancePresetApply.disabled = Boolean(isEnhanceBusy);
    if (btnEnhanceRestoreAll) btnEnhanceRestoreAll.disabled = Boolean(isEnhanceBusy);
    if (btnEnhanceConfirmGo) btnEnhanceConfirmGo.disabled = Boolean(isEnhanceBusy);

    if (currentEnhanceStatus) {
      if (chkPresetPrompt) {
        if (unsupported) chkPresetPrompt.checked = false;
        chkPresetPrompt.disabled = lockPromptControls;
      }
      if (chkPresetTitle) {
        if (unsupported) chkPresetTitle.checked = false;
        chkPresetTitle.disabled = lockPromptControls;
      }
    }
    const ctxUnsupported = Boolean(
      currentUnlockStatus &&
      currentUnlockStatus.isPlatformSupported === false &&
      currentUnlockStatus.status === 'unsupported'
    );
    if (chkPresetCtx && currentUnlockStatus) {
      if (ctxUnsupported) chkPresetCtx.checked = false;
      chkPresetCtx.disabled = Boolean(isEnhanceBusy || ctxUnsupported);
    }
  }

  function renderEnhanceSectionUI() {
    syncBrandTitleButtons(currentBrandTitle);
    renderEnhancePromptMatrix(selectedEnhanceTier);
    syncEnhanceInteractiveDisabledState();

    const data = currentEnhanceStatus;
    const s = data?.summary || data;
    const isUnsupported = Boolean(data && data.supported === false);
    const tierNum = s?.promptTier ?? s?.detectedTier;
    const hasTitle = Boolean(s?.chineseTitleEnabled);
    const titleMode = s?.chineseTitleMode || (hasTitle ? 'zh' : 'en');
    const slotCount = Number(s?.slotCount || 0);
    const totalCap = Number(s?.totalCapacityBytes || 0);
    const activeBytes = Number(s?.activeSlotBytes || 0);
    const allBak = Boolean(s?.allBackedUp ?? s?.hasBackup);
    const syncState = s?.syncState || null;
    const targetsList = Array.isArray(data?.binaries) ? data.binaries : (Array.isArray(data?.targets) ? data.targets : []);
    const hasUnsavedDraft = Boolean(
      data &&
      data.supported &&
      !isUnsupported &&
      ((enhanceTierDirty && Number(selectedEnhanceTier) !== Number(tierNum)) ||
        (enhanceTitleDirty && Boolean(enhanceChineseTitleCheck ? enhanceChineseTitleCheck.checked : enhanceTitleDraft) !== hasTitle))
    );

    if (enhanceGlobalBadge) {
      if (!data) {
        enhanceGlobalBadge.textContent = t('enhance.status.unread');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      } else if (isUnsupported) {
        enhanceGlobalBadge.textContent = t('enhance.status.unsupportedPlatform');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'client_updated_mismatch') {
        enhanceGlobalBadge.textContent = t('enhance.status.clientUpdated');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'saved_disk_mismatch' || syncState === 'partial_mismatch') {
        enhanceGlobalBadge.textContent = t('enhance.status.diskMismatch');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'pending_ls_restart' || hasPendingLsReload) {
        enhanceGlobalBadge.textContent = t('enhance.status.pendingRestartLs');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'runtime_confirmed' && (Number(tierNum) > 0 || hasTitle)) {
        enhanceGlobalBadge.textContent = t('enhance.status.runtimeConfirmed');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else if (Number(tierNum) > 0 || hasTitle) {
        enhanceGlobalBadge.textContent = t('enhance.status.patchedActive');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else {
        enhanceGlobalBadge.textContent = t('enhance.status.stock');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      }
    }
    if (enhancePromptBadge) {
      if (!data) {
        enhancePromptBadge.textContent = t('enhance.status.unread');
        enhancePromptBadge.className = 'key-pill pill-muted';
      } else if (isUnsupported) {
        enhancePromptBadge.textContent = t('enhance.status.unsupportedPlatform');
        enhancePromptBadge.className = 'key-pill pill-warn';
      } else {
        const baseText = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
        enhancePromptBadge.textContent = hasUnsavedDraft ? `${baseText}${t('enhance.status.draftUnsaved')}` : baseText;
        enhancePromptBadge.className = hasUnsavedDraft
          ? 'key-pill pill-warn'
          : (Number(tierNum) > 0 ? 'key-pill pill-ok' : 'key-pill pill-muted');
      }
    }
    if (enhanceStatPrompt) {
      if (!data) {
        enhanceStatPrompt.textContent = t('enhance.status.unread');
      } else if (isUnsupported) {
        enhanceStatPrompt.textContent = t('enhance.status.unsupportedPlatform');
      } else {
        enhanceStatPrompt.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
      }
    }
    if (enhanceStatTitle) {
      if (!data) enhanceStatTitle.textContent = t('enhance.status.unread');
      else if (isUnsupported) enhanceStatTitle.textContent = t('enhance.status.unsupportedPlatform');
      else if (titleMode === 'zh' || hasTitle) {
        enhanceStatTitle.textContent = (hasPendingLsReload || s?.pendingLsRestart)
          ? t('enhance.titleState.onWritten')
          : (syncState === 'runtime_confirmed' ? t('enhance.titleState.onConfirmed') : t('enhance.titleState.on'));
      } else if (titleMode === 'mixed') enhanceStatTitle.textContent = t('enhance.titleState.conflict');
      else enhanceStatTitle.textContent = t('enhance.titleState.off');
    }
    if (enhanceStatSlots) {
      if (!data) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else if (isUnsupported) {
        enhanceStatSlots.textContent = t('enhance.status.unsupportedPlatform');
      } else if (totalCap <= 0) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else {
        enhanceStatSlots.textContent = `${activeBytes} / ${totalCap} B (${slotCount})`;
      }
    }
    if (enhanceStatBackup) {
      if (!data) enhanceStatBackup.textContent = t('enhance.status.unread');
      else if (isUnsupported) enhanceStatBackup.textContent = t('enhance.status.unsupportedPlatform');
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

  /** 获取用于操作反馈插值的品牌名称展示值 */
  function getBrandDisplayValue(modeKey) {
    if (modeKey === 'translated') return '反重力';
    if (modeKey === 'hidden') return t('enhance.brand.hiddenValue');
    return 'Antigravity';
  }

  /** 解析后端或增强桥接返回错误，兼容 errorKey 与后端原文翻译 */
  function resolveSettingsErrorText(rawOrRes, fallbackKey = 'msg.unknownErr') {
    if (rawOrRes && typeof rawOrRes === 'object') {
      if (rawOrRes.errorKey) return t(rawOrRes.errorKey);
      return translateBackendText(rawOrRes.error ?? rawOrRes.message) || t(fallbackKey);
    }
    return translateBackendText(rawOrRes) || t(fallbackKey);
  }

  function showEnhanceResultBox(ok, messageOrResolver, opts = {}) {
    if (!enhanceGlobalResult || !enhanceResultText) return;
    const resolveMessage = typeof messageOrResolver === 'function'
      ? messageOrResolver
      : () => String(messageOrResolver ?? '');
    enhanceGlobalResultState = { ok, resolveMessage, opts };
    enhanceGlobalResult.style.display = 'block';
    enhanceGlobalResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhanceResultText.textContent = resolveMessage();
    const needLs = Boolean(opts.needsLsRestart);
    const needHost = Boolean(opts.needsHostRestart);
    const canRestartHost = Boolean(hostSupportsRestart);
    if (btnEnhanceRestartLs) btnEnhanceRestartLs.hidden = !needLs;
    if (btnEnhanceRestartHost) btnEnhanceRestartHost.hidden = !(needHost && canRestartHost);
    if (enhanceManualNote) enhanceManualNote.hidden = !(needHost && !canRestartHost);
    if (enhanceResultActions) enhanceResultActions.hidden = !(needLs || (needHost && canRestartHost));
  }

  function showEnhancePromptResult(ok, messageOrResolver) {
    if (!enhancePromptResult || !enhancePromptResultText) return;
    const resolveMessage = typeof messageOrResolver === 'function'
      ? messageOrResolver
      : () => String(messageOrResolver ?? '');
    enhancePromptResultState = { ok, resolveMessage };
    enhancePromptResult.style.display = 'block';
    enhancePromptResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhancePromptResultText.textContent = resolveMessage();
  }

  function getSelectedPresetLabelResolvers() {
    const labels = {
      prompt: () => t('enhance.preset.itemPrompt'),
      title: () => t('enhance.preset.itemTitle'),
      lang: () => t('enhance.preset.itemLang'),
      ctx: () => t('enhance.preset.itemCtx')
    };
    return getRecommendedDiff().map((item) => labels[item.key]);
  }

  function renderEnhancePresetConfirmText() {
    if (!enhancePresetConfirm || enhancePresetConfirm.hidden || !enhanceConfirmTitle || !pendingEnhanceConfirmMode) return;
    if (pendingEnhanceConfirmMode === 'preset') {
      const items = getSelectedPresetLabelResolvers().map(fn => fn()).join(t('list.sep'));
      enhanceConfirmTitle.textContent = t('enhance.confirm.presetSummary', { items });
    } else if (pendingEnhanceConfirmMode === 'restore') {
      enhanceConfirmTitle.textContent = t('enhance.confirm.restoreSummary');
    }
  }

  function renderProxyTestResultView() {
    if (!proxyTestResult || !lastProxyTestState) return;
    if (lastProxyTestState.pending) {
      proxyTestResult.textContent = t('settings.proxy.testingDetail');
      return;
    }
    if (lastProxyTestState.thrownErr) {
      proxyTestResult.textContent = t('settings.proxy.testErr', { err: translateBackendText(lastProxyTestState.thrownErr) || t('msg.unknownErr') });
      return;
    }
    const res = lastProxyTestState.res;
    if (!res || !res.ok) {
      proxyTestResult.textContent = t('settings.proxy.testFail', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
      return;
    }
    const d = res.data;
    proxyTestResult.innerHTML = `
      ${t('settings.proxy.resFmt')}: ${d.configValid ? t('settings.proxy.resValid') : t('settings.proxy.resInvalid')}<br>
      ${t('settings.proxy.resPort')}: ${d.proxyReachable ? t('settings.proxy.resReachable') : t('settings.proxy.resUnreachable')}<br>
      ${t('settings.proxy.resNet')}: ${d.internetReachable ? t('settings.proxy.resOnline') : t('settings.proxy.resOffline')}<br>
      ${t('settings.proxy.resModel')}: ${t('settings.proxy.resPending')}
      ${d.error ? `<br><span style="color:var(--ag-danger)">⚠️ ${translateBackendText(d.error)}</span>` : ''}
    `;
  }

  /** 面板语言切换后，同步更新设置页当前仍可见的动态操作反馈与确认提示 */
  function rerenderSettingsFeedbacks() {
    renderEnhancePresetConfirmText();
    if (enhanceGlobalResultState && enhanceGlobalResult && enhanceGlobalResult.style.display && enhanceGlobalResult.style.display !== 'none') {
      showEnhanceResultBox(enhanceGlobalResultState.ok, enhanceGlobalResultState.resolveMessage, enhanceGlobalResultState.opts);
    }
    if (enhancePromptResultState && enhancePromptResult && enhancePromptResult.style.display && enhancePromptResult.style.display !== 'none') {
      showEnhancePromptResult(enhancePromptResultState.ok, enhancePromptResultState.resolveMessage);
    }
    if (brandFeedbackState && brandApplyFeedback && !brandApplyFeedback.hidden && brandApplyFeedback.style.display && brandApplyFeedback.style.display !== 'none') {
      showBrandFeedback(brandFeedbackState.mode, brandFeedbackState.isSuccess, brandFeedbackState.resolveMessage, brandFeedbackState.isApplied);
    }
    if (lastProxyTestState && proxyTestResult && proxyTestResult.style.display && proxyTestResult.style.display !== 'none') {
      renderProxyTestResultView();
    }
  }

  function applyEnhanceStatusPayload(statusData, { syncDrafts = true, forceSyncDrafts = false } = {}) {
    currentEnhanceStatus = statusData;
    const s = statusData?.summary || statusData;
    if (s && s.pendingLsRestart !== undefined) {
      hasPendingLsReload = Boolean(s.pendingLsRestart);
    }
    const useSavedAfterUpdate = Boolean(s?.clientUpdatedSinceSave && [0, 1, 2, 3, 4].includes(Number(s?.savedPromptTier)));
    if (syncDrafts && s && statusData?.supported !== false) {
      if (forceSyncDrafts || !enhanceTierDirty) {
        const tierVal = useSavedAfterUpdate ? s.savedPromptTier : (s.promptTier ?? s.detectedTier);
        if ([0, 1, 2, 3, 4].includes(Number(tierVal))) {
          selectedEnhanceTier = Number(tierVal);
        }
        if (forceSyncDrafts) enhanceTierDirty = false;
      }
      if (forceSyncDrafts || !enhanceTitleDirty) {
        enhanceTitleDraft = useSavedAfterUpdate ? Boolean(s.savedChineseTitle) : Boolean(s.chineseTitleEnabled);
        if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.checked = enhanceTitleDraft;
        if (forceSyncDrafts) enhanceTitleDirty = false;
      }
      if (useSavedAfterUpdate && (!enhancePromptResult || enhancePromptResult.style.display === 'none')) {
        const savedTierSnap = Number(s.savedPromptTier);
        const savedTitleSnap = Boolean(s.savedChineseTitle);
        showEnhancePromptResult(false, () => t('enhance.result.clientUpdatedNotice', {
          tier: t(`enhance.tier.${savedTierSnap}.short`),
          title: savedTitleSnap ? t('enhance.titleState.on') : t('enhance.titleState.off')
        }));
      }
    }
    syncRecommendedCheckboxes({ force: forceSyncDrafts });
    renderEnhanceSectionUI();
  }

  async function refreshEnhanceStatus(syncDrafts = true, { forceSyncDrafts = false, forceRefresh = false } = {}) {
    const seq = ++enhanceStatusReqSeq;
    try {
      const res = await invokeEnhanceApi('status', forceRefresh ? { forceRefresh: true } : {});
      if (seq !== enhanceStatusReqSeq) return;
      if (res && res.ok && res.data) {
        applyEnhanceStatusPayload(res.data, { syncDrafts, forceSyncDrafts });
      } else if (res && res.unavailable) {
        currentEnhanceStatus = { supported: false };
        renderEnhanceSectionUI();
      } else {
        renderEnhanceSectionUI();
      }
    } catch {
      if (seq !== enhanceStatusReqSeq) return;
      currentEnhanceStatus = null;
      renderEnhanceSectionUI();
    }
  }

  for (let i = 0; i < enhanceTierBtns.length; i++) {
    const btn = enhanceTierBtns[i];
    btn?.addEventListener('click', () => {
      if (isEnhanceBusy) return;
      selectedEnhanceTier = i;
      enhanceTierDirty = true;
      renderEnhancePromptMatrix(i);
      renderEnhanceSectionUI();
    });
  }

  enhanceTierGrid?.addEventListener('click', (e) => {
    if (isEnhanceBusy) return;
    const btn = e?.target?.closest?.('[data-enhance-tier]');
    if (!btn || btn.disabled) return;
    const idx = Number(btn.getAttribute('data-enhance-tier'));
    if (![0, 1, 2, 3, 4].includes(idx)) return;
    selectedEnhanceTier = idx;
    enhanceTierDirty = true;
    renderEnhancePromptMatrix(idx);
    renderEnhanceSectionUI();
  });

  enhanceChineseTitleCheck?.addEventListener('change', (e) => {
    if (isEnhanceBusy) return;
    enhanceTitleDraft = Boolean(e?.target?.checked);
    enhanceTitleDirty = true;
    renderEnhanceSectionUI();
  });

  btnToggleEnhanceDetails?.addEventListener('click', () => {
    if (!enhanceDetailsBody) return;
    const isHidden = enhanceDetailsBody.style.display === 'none' || !enhanceDetailsBody.style.display;
    enhanceDetailsBody.style.display = isHidden ? 'block' : 'none';
    btnToggleEnhanceDetails.setAttribute('aria-expanded', String(isHidden));
    renderEnhanceSectionUI();
  });

  btnRefreshEnhance?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    void refreshEnhanceStatus(true, { forceSyncDrafts: true, forceRefresh: true });
  });

  btnApplyEnhancePrompt?.addEventListener('click', async () => {
    if (isEnhanceBusy) return;
    if (currentEnhanceStatus && currentEnhanceStatus.supported === false) {
      showEnhancePromptResult(false, () => t('enhance.status.unsupportedPlatform'));
      return;
    }
    const submittedTier = Number(selectedEnhanceTier);
    const submittedTitle = enhanceChineseTitleCheck ? Boolean(enhanceChineseTitleCheck.checked) : Boolean(enhanceTitleDraft);
    isEnhanceBusy = true;
    syncEnhanceInteractiveDisabledState();
    if (btnApplyEnhancePrompt) {
      btnApplyEnhancePrompt.disabled = true;
      btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPromptBusy');
    }
    showEnhancePromptResult(true, () => t('enhance.btn.applyPromptBusy'));
    try {
      await yieldForSettingsPaint();
      const res = await invokeEnhanceApi('apply', {
        promptTier: submittedTier,
        chineseTitle: submittedTitle,
        restartLanguageServer: false
      });
      if (!res || !res.ok) {
        const errPayload = res;
        const resolveErr = () => t('enhance.result.fail', { err: resolveSettingsErrorText(errPayload, 'msg.unknownErr') });
        showEnhancePromptResult(false, resolveErr);
        showEnhanceResultBox(false, resolveErr);
        await refreshEnhanceStatus(false);
      } else {
        const actualTier = [0, 1, 2, 3, 4].includes(Number(res.appliedPromptTier))
          ? Number(res.appliedPromptTier)
          : ([0, 1, 2, 3, 4].includes(Number(res.status?.summary?.promptTier)) ? Number(res.status.summary.promptTier) : submittedTier);
        const actualTitle = res.appliedChineseTitleEnabled !== undefined
          ? Boolean(res.appliedChineseTitleEnabled)
          : (res.status?.summary?.chineseTitleEnabled !== undefined ? Boolean(res.status.summary.chineseTitleEnabled) : submittedTitle);
        const changedAny = res.changed !== false;
        const needLsRestart = res.needsRestart !== undefined ? Boolean(res.needsRestart) : changedAny;
        hasPendingLsReload = needLsRestart;
        enhanceTierDirty = false;
        enhanceTitleDirty = false;

        const resolveSuccess = (!changedAny && !needLsRestart)
          ? () => t('enhance.result.alreadyApplied', {
            tier: t(`enhance.tier.${actualTier}.short`),
            title: actualTitle ? t('enhance.titleState.on') : t('enhance.titleState.off')
          })
          : () => t('enhance.result.appliedNeedRestartLs', {
            tier: t(`enhance.tier.${actualTier}.short`),
            title: actualTitle ? t('enhance.titleState.on') : t('enhance.titleState.off')
          });
        showEnhancePromptResult(true, resolveSuccess);
        showEnhanceResultBox(true, resolveSuccess, { needsLsRestart: needLsRestart, needsHostRestart: false });
        if (res.status) {
          applyEnhanceStatusPayload(res.status, { syncDrafts: true, forceSyncDrafts: true });
        } else {
          await refreshEnhanceStatus(true, { forceSyncDrafts: true });
        }
      }
    } catch (e) {
      const rawErr = e?.message;
      const resolveErr = () => t('enhance.result.fail', { err: translateBackendText(rawErr) || t('msg.unknownErr') });
      showEnhancePromptResult(false, resolveErr);
      showEnhanceResultBox(false, resolveErr);
    } finally {
      isEnhanceBusy = false;
      if (btnApplyEnhancePrompt) {
        btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPrompt');
      }
      syncEnhanceInteractiveDisabledState();
    }
  });

  [['prompt', chkPresetPrompt], ['title', chkPresetTitle], ['lang', chkPresetLang], ['ctx', chkPresetCtx]].forEach(([key, box]) => {
    box?.addEventListener('change', () => {
      recDirty[key] = true;
    });
  });

  btnEnhancePresetApply?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    const selectedResolvers = getSelectedPresetLabelResolvers();
    if (!selectedResolvers.length) {
      showEnhanceResultBox(false, () => t('enhance.confirm.noneSelected'));
      return;
    }
    pendingEnhanceConfirmMode = 'preset';
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
    renderEnhancePresetConfirmText();
  });

  btnEnhanceRestoreAll?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    pendingEnhanceConfirmMode = 'restore';
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
    renderEnhancePresetConfirmText();
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

    const presetDiff = mode === 'preset' ? getRecommendedDiff() : [];
    const wantPrompt = presetDiff.find((item) => item.key === 'prompt');
    const wantTitle = presetDiff.find((item) => item.key === 'title');
    const wantLang = presetDiff.find((item) => item.key === 'lang');
    const wantCtx = presetDiff.find((item) => item.key === 'ctx');

    isEnhanceBusy = true;
    syncEnhanceInteractiveDisabledState();
    showEnhanceResultBox(true, () => t(mode === 'restore' ? 'enhance.result.restoreWorking' : 'enhance.result.presetWorking'));

    try {
      await yieldForSettingsPaint();
      const doneResolvers = [];
      const failedResolvers = [];
      let needsLsRestart = false;
      let needsHostRestart = false;
      let anyChanged = false;
      let latestEnhanceStatus = null;

      if (mode === 'preset') {
        if (wantPrompt || wantTitle) {
          const resolveItemLabel = () => [wantPrompt ? t('enhance.preset.itemPrompt') : '', wantTitle ? t('enhance.preset.itemTitle') : ''].filter(Boolean).join(t('list.sep'));
          try {
            const payload = {};
            if (wantPrompt) payload.promptTier = wantPrompt.enable ? 4 : 0;
            if (wantTitle) payload.chineseTitle = Boolean(wantTitle.enable);
            const eRes = await invokeEnhanceApi('apply', payload);
            if (!eRes || !eRes.ok) {
              const errPayload = eRes;
              failedResolvers.push(() => `${resolveItemLabel()}: ${resolveSettingsErrorText(errPayload, 'msg.unknownErr')}`);
            } else {
              if (wantPrompt) doneResolvers.push(() => t('enhance.preset.itemPrompt'));
              if (wantTitle) doneResolvers.push(() => t('enhance.preset.itemTitle'));
              if (eRes.changed !== false) anyChanged = true;
              if (eRes.needsRestart !== false) needsLsRestart = true;
              if (eRes.status) latestEnhanceStatus = eRes.status;
              enhanceTierDirty = false;
              enhanceTitleDirty = false;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${resolveItemLabel()}: ${translateBackendText(rawErr) || t('msg.unknownErr')}`);
          }
        }

        if (wantLang) {
          try {
            const lRes = await invokeModulesApi('toggle', 'chinese', Boolean(wantLang.enable), {
              language: wantLang.enable ? 'zh-CN' : 'en',
              brandTitle: wantLang.enable ? currentBrandTitle : 'english'
            });
            if (!lRes || !lRes.ok) {
              const errPayload = lRes;
              failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail')}`);
            } else {
              doneResolvers.push(() => t('enhance.preset.itemLang'));
              anyChanged = true;
              if (lRes.restartRequired !== false) needsHostRestart = true;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${translateBackendText(rawErr) || t('mod.zh.toggleFail')}`);
          }
        }

        if (wantCtx) {
          try {
            const cRes = wantCtx.enable
              ? await invokeUnlockApi('apply', { mode: 'dynamic', limitTokens: null })
              : await invokeUnlockApi('restore', {});
            if (!cRes || !cRes.ok) {
              const rawErr = cRes?.error;
              failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${buildFriendlyWriteError(rawErr)}`);
            } else {
              doneResolvers.push(() => t('enhance.preset.itemCtx'));
              if (!cRes.alreadyMatched) anyChanged = true;
              if (cRes.needsRestart) needsHostRestart = true;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${translateBackendText(rawErr) || t('msg.unknownErr')}`);
          }
        }
      } else if (mode === 'restore') {
        const resolvePromptTitleLabel = () => `${t('enhance.preset.itemPrompt')} / ${t('enhance.preset.itemTitle')}`;
        try {
          const rRes = await invokeEnhanceApi('restore', {});
          if (!rRes || !rRes.ok) {
            const errPayload = rRes;
            failedResolvers.push(() => `${resolvePromptTitleLabel()}: ${resolveSettingsErrorText(errPayload, 'msg.restoreFail')}`);
          } else {
            doneResolvers.push(resolvePromptTitleLabel);
            if (rRes.needsRestart) needsLsRestart = true;
            if (rRes.status) latestEnhanceStatus = rRes.status;
            enhanceTierDirty = false;
            enhanceTitleDirty = false;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${resolvePromptTitleLabel()}: ${translateBackendText(rawErr) || t('msg.restoreFail')}`);
        }

        try {
          const lRes = await invokeModulesApi('toggle', 'chinese', false, { language: 'en', brandTitle: 'english' });
          if (!lRes || !lRes.ok) {
            const errPayload = lRes;
            failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail')}`);
          } else {
            currentBrandTitle = 'english';
            doneResolvers.push(() => t('enhance.preset.itemLang'));
            if (lRes.restartRequired !== false) needsHostRestart = true;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${translateBackendText(rawErr) || t('mod.zh.toggleFail')}`);
        }

        try {
          const cRes = await invokeUnlockApi('restore', {});
          if (!cRes || !cRes.ok) {
            const rawErr = cRes?.error;
            failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${buildFriendlyWriteError(rawErr)}`);
          } else {
            doneResolvers.push(() => t('enhance.preset.itemCtx'));
            if (cRes.needsRestart) needsHostRestart = true;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${translateBackendText(rawErr) || t('msg.restoreFail')}`);
        }
      }

      if (needsHostRestart) needsRestartAfterApply = true;
      if (needsLsRestart) hasPendingLsReload = true;

      if (failedResolvers.length > 0) {
        const resolveMsg = doneResolvers.length > 0
          ? () => t('enhance.result.partialFail', {
            done: doneResolvers.map(fn => fn()).join(t('list.sep')),
            failed: failedResolvers.map(fn => fn()).join(t('list.semiSep'))
          })
          : () => t('enhance.result.fail', {
            err: failedResolvers.map(fn => fn()).join(t('list.semiSep'))
          });
        showEnhanceResultBox(false, resolveMsg, { needsLsRestart, needsHostRestart });
      } else if (mode === 'preset') {
        const key = (!anyChanged && !needsLsRestart && !needsHostRestart)
          ? 'enhance.result.presetAlreadyApplied'
          : 'enhance.result.presetDone';
        showEnhanceResultBox(
          true,
          () => t(key, { summary: doneResolvers.map(fn => fn()).join(t('list.sep')) }),
          { needsLsRestart, needsHostRestart }
        );
      } else if (mode === 'restore') {
        showEnhanceResultBox(true, () => t('enhance.result.restoredDone'), { needsLsRestart, needsHostRestart: true });
      }

      if (latestEnhanceStatus) {
        applyEnhanceStatusPayload(latestEnhanceStatus, { syncDrafts: true, forceSyncDrafts: true });
        await Promise.all([refreshModulesDisplay(), refreshUnlockStatus()]);
      } else {
        await Promise.all([refreshEnhanceStatus(true, { forceSyncDrafts: true }), refreshModulesDisplay(), refreshUnlockStatus()]);
      }
    } catch (e) {
      const rawErr = e?.message;
      showEnhanceResultBox(false, () => t('enhance.result.fail', { err: translateBackendText(rawErr) || t('msg.unknownErr') }));
    } finally {
      isEnhanceBusy = false;
      syncEnhanceInteractiveDisabledState();
    }
  });

  btnEnhanceRestartLs?.addEventListener('click', async () => {
    if (isLsRestartBusy) return;
    isLsRestartBusy = true;
    if (btnEnhanceRestartLs) {
      btnEnhanceRestartLs.disabled = true;
      btnEnhanceRestartLs.textContent = t('enhance.btn.restartLsBusy');
    }
    try {
      await yieldForSettingsPaint();
      const res = await invokeEnhanceApi('restart-ls', {});
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => t('enhance.result.lsRestartFail', { err: resolveSettingsErrorText(errPayload, 'msg.unknownErr') }));
        return;
      }
      const killedCount = Array.isArray(res.killed) ? res.killed.length : (Number(res.killed) || 0);
      hasPendingLsReload = false;
      const hostRestartFlag = needsRestartAfterApply;
      showEnhanceResultBox(true, () => t('enhance.result.lsRestarted', { killed: killedCount }), { needsLsRestart: false, needsHostRestart: hostRestartFlag });
      await refreshEnhanceStatus(false);
    } catch (e) {
      const rawErr = e?.message;
      showEnhanceResultBox(false, () => t('enhance.result.lsRestartFail', { err: translateBackendText(rawErr) || t('msg.unknownErr') }));
    } finally {
      isLsRestartBusy = false;
      if (btnEnhanceRestartLs) {
        btnEnhanceRestartLs.disabled = false;
        btnEnhanceRestartLs.textContent = t('enhance.btn.restartLs');
      }
    }
  });

  btnEnhanceRestartHost?.addEventListener('click', openClientRestartConfirmFlow);

  let selectedBrandTitle = currentBrandTitle;

  /**
   * 定位品牌按钮内的目标文本节点，避免直接覆写 textContent 破坏 React 子元素结构
   */
  function findBrandTextNode(el) {
    if (!el) return null;
    const nodes = el.childNodes ? Array.from(el.childNodes) : (el.children || []);
    for (const node of nodes) {
      if (node && node.nodeType === 3) {
        return node;
      }
    }
    let cur = el;
    let depth = 0;
    while (cur && depth < 6) {
      const children = cur.childNodes ? Array.from(cur.childNodes) : [];
      if (children.length === 1) {
        const only = children[0];
        if (only && only.nodeType === 3) return only;
        if (only && only.nodeType === 1) {
          cur = only;
          depth++;
          continue;
        }
      }
      break;
    }
    return null;
  }

  /**
   * 仅更新品牌节点的纯文本内容，保持 DOM 结构与 i18n 运行时状态同步
   */
  function writeBrandButtonText(btn, expectedText) {
    if (!btn) return;
    const textNode = findBrandTextNode(btn);
    if (textNode) {
      if (textNode.nodeValue !== expectedText) {
        textNode.nodeValue = expectedText;
      }
      textNode._agyOriginal = expectedText;
      return;
    }
    if ((btn.textContent || '') !== expectedText) {
      btn.textContent = expectedText;
    }
  }

  /**
   * 在修改品牌 DOM 之前先同步运行时配置，防止 i18n 扫描器与品牌设置互相冲突
   */
  function syncRuntimeBrandConfig(modeKey) {
    try {
      if (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__) {
        window.__AGY_I18N_CONFIG__.brandTitle = modeKey;
      }
    } catch { }
  }

  function ensureBrandObserver(modeKey, targetBtn) {
    disconnectBrandObserver();
    try {
      if (globalThis.__AGContextMeterBrandObserver && typeof globalThis.__AGContextMeterBrandObserver.disconnect === 'function') {
        globalThis.__AGContextMeterBrandObserver.disconnect();
        globalThis.__AGContextMeterBrandObserver = null;
      }
    } catch { }
    if (state.disposed || !targetBtn || modeKey === 'english') return;
    try {
      const container = targetBtn.parentElement || targetBtn;
      const expectedText = modeKey === 'hidden' ? '' : '反重力';
      let burstWindowStart = 0;
      let burstCount = 0;
      const obs = new MutationObserver(() => {
        if (state.disposed || brandObserver !== obs || globalThis.__AGContextMeterBrandObserver !== obs) {
          try { obs.disconnect(); } catch { }
          return;
        }
        const btn = document.querySelector('button[data-agy-brand-item="true"]') || targetBtn;
        if (!btn) return;
        const txt = btn.textContent?.trim() || '';
        if (txt === expectedText) return;
        const now = Date.now();
        if (now - burstWindowStart > 250) {
          burstWindowStart = now;
          burstCount = 0;
        }
        burstCount++;
        if (burstCount > 8) {
          // 熔断保护：检测到高频互搏变更时主动停止监听，防止渲染进程主线程卡死
          disconnectBrandObserver();
          return;
        }
        try {
          obs.disconnect();
          writeBrandButtonText(btn, expectedText);
        } finally {
          if (!state.disposed && brandObserver === obs && globalThis.__AGContextMeterBrandObserver === obs) {
            try { obs.observe(container, { childList: true, subtree: true, characterData: true }); } catch { }
          }
        }
      });
      brandObserver = obs;
      globalThis.__AGContextMeterBrandObserver = obs;
      obs.observe(container, { childList: true, subtree: true, characterData: true });
    } catch { }
  }

  function applyBrandTitleToDom(modeKey) {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { found: false, applied: false, nodeText: null };
    }
    disconnectBrandObserver();
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

    // 保留菜单入口可用（不设置 display: none，隐藏模式仅清空文字），确保菜单功能随时可点击
    targetBtn.style.display = '';
    writeBrandButtonText(targetBtn, expectedText);
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

  function showBrandFeedback(mode, isSuccess = true, customMsgOrResolver = '', isApplied = false) {
    if (!brandApplyFeedback) return;
    const resolveMessage = typeof customMsgOrResolver === 'function'
      ? customMsgOrResolver
      : (customMsgOrResolver
        ? () => String(customMsgOrResolver)
        : () => {
          if (!isSuccess) return t('msg.saveFail');
          const brandVal = getBrandDisplayValue(mode);
          if (!isApplied) return t('enhance.brand.savedNotFound', { mode: brandVal });
          return mode === 'hidden'
            ? t('enhance.brand.appliedHidden')
            : t('enhance.brand.appliedName', { mode: brandVal });
        });
    brandFeedbackState = { mode, isSuccess, resolveMessage, isApplied };
    brandApplyFeedback.style.display = 'block';
    brandApplyFeedback.hidden = false;
    if (!isSuccess) {
      brandApplyFeedback.textContent = resolveMessage();
      brandApplyFeedback.style.color = '#ef4444';
      return;
    }
    brandApplyFeedback.textContent = resolveMessage();
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
  }

  async function applyBrandTitleSetting(modeKey) {
    if (btnApplyBrandTitle) btnApplyBrandTitle.disabled = true;
    try {
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'chinese', currentChineseEnabled, {
        language: currentChineseEnabled ? 'zh-CN' : 'en',
        brandTitle: modeKey
      });
      if (!res || !res.ok) {
        const errPayload = res;
        const resolveErr = () => t('enhance.brand.saveFailErr', { err: resolveSettingsErrorText(errPayload, 'msg.saveFail') });
        showBrandFeedback(modeKey, false, resolveErr, false);
        showEnhanceResultBox(false, resolveErr);
        return;
      }
      currentBrandTitle = modeKey;
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);

      // 实时真实 DOM 应用（先同步运行时配置再更新 DOM，防止 i18n 扫描器与品牌设置互相冲突）
      syncRuntimeBrandConfig(modeKey);
      const domResult = applyBrandTitleToDom(modeKey);

      // 实时热同步（若已注入运行时环境）
      try {
        if (typeof window !== 'undefined' && typeof window.__AGY_RUN_FULL_SCAN__ === 'function') {
          window.__AGY_RUN_FULL_SCAN__();
        }
      } catch { }

      if (domResult.applied) {
        const resolveApplied = modeKey === 'hidden'
          ? () => t('enhance.brand.appliedHidden')
          : () => t('enhance.brand.appliedName', { mode: getBrandDisplayValue(modeKey) });
        showBrandFeedback(modeKey, true, resolveApplied, true);
        showEnhanceResultBox(true, resolveApplied, { needsHostRestart: false });
      } else {
        const resolveNotApplied = !domResult.found
          ? () => t('enhance.brand.savedNotFound', { mode: getBrandDisplayValue(modeKey) })
          : () => t('enhance.brand.savedApplyFailed', { mode: getBrandDisplayValue(modeKey) });
        showBrandFeedback(modeKey, true, resolveNotApplied, false);
        showEnhanceResultBox(false, resolveNotApplied, { needsHostRestart: true });
      }
    } catch (e) {
      const rawErr = e?.message;
      const resolveErr = () => t('enhance.brand.saveFailErr', { err: translateBackendText(rawErr) || t('msg.saveFail') });
      showBrandFeedback(modeKey, false, resolveErr, false);
      showEnhanceResultBox(false, resolveErr);
    } finally {
      if (btnApplyBrandTitle) btnApplyBrandTitle.disabled = false;
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

  async function refreshModulesDisplay({ forceProxySync = false } = {}) {
    const seq = ++modulesStatusReqSeq;
    try {
      const res = await invokeModulesApi('status');
      if (seq !== modulesStatusReqSeq) return;
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
      if (res.configCorrupted && res.configError) {
        showEnhanceResultBox(false, () => translateBackendText(res.configError));
      }

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      syncRecommendedCheckboxes();
      currentBrandTitle = cfg.modules?.chinese?.brandTitle || 'english';
      syncBrandTitleButtons(currentBrandTitle);
      syncRuntimeBrandConfig(currentBrandTitle);
      applyBrandTitleToDom(currentBrandTitle);
      const runtimeMeta = res.runtime && typeof res.runtime === 'object' ? res.runtime : null;
      // 判定宿主界面是否已翻译：优先使用 __AGY_I18N_CONFIG__，其次主进程启动期快照 runtimeMeta.chineseActive（跨 Electron 沙箱隔离真实可靠），最后仅匹配宿主固定壳层控件并严格排除用户项目/会话标题
      const isDomTranslated = (() => {
        const cfgSnap = typeof window.__AGY_I18N_CONFIG__ === 'object' && window.__AGY_I18N_CONFIG__
          ? window.__AGY_I18N_CONFIG__
          : null;
        if (cfgSnap) {
          return Boolean(cfgSnap.enabled === true && cfgSnap.language !== 'en');
        }
        if (runtimeMeta && typeof runtimeMeta.chineseActive === 'boolean') {
          return Boolean(runtimeMeta.chineseActive);
        }
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const fixedSelectors = [
            "[data-testid='new-conversation-button']",
            "[data-testid='automations-button']",
            "[data-testid='settings-button']",
            "[data-testid='open-editor-single']",
            "[data-testid='title-menu-bar-item']"
          ];
          const exactSystemLabels = new Set([
            '新建对话', '新建会话', '自动化', '设置', '打开 IDE', '工作区', '视图', '窗口', '自定义扩展'
          ]);
          for (let i = 0; i < fixedSelectors.length; i++) {
            const nodes = document.querySelectorAll ? document.querySelectorAll(fixedSelectors[i]) : [];
            for (let j = 0; j < nodes.length; j++) {
              const txt = (nodes[j].textContent || '').replace(/^\+\s*/, '').trim();
              if (txt && exactSystemLabels.has(txt)) return true;
            }
          }
        } catch { }
        return false;
      })();
      const disk = res.disk || {};
      const isChineseDiskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
      const isChinesePartial = Boolean(disk.chinese && disk.chineseReady === false);
      const isProxyDiskReady = disk.proxyReady !== undefined ? Boolean(disk.proxyReady) : Boolean(disk.proxy);
      const isProxyPartial = Boolean(disk.proxy && disk.proxyReady === false);

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = isChineseDiskReady ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!isChineseDiskReady) {
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
            chineseStatusDesc.textContent = isChineseDiskReady
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!isChineseDiskReady) {
          chineseStatusDesc.textContent = isChinesePartial && disk.chineseReason
            ? t('mod.zh.descPartialInject', { reason: translateBackendText(disk.chineseReason) })
            : t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();

      currentProxyEnabled = Boolean(cfg.modules?.proxy?.enabled);
      const diskProxyUrl = String(cfg.modules?.proxy?.proxyUrl || '');
      const diskProxyBypass = String(cfg.modules?.proxy?.bypassList || '');
      savedProxyUrl = diskProxyUrl;
      savedProxyBypass = diskProxyBypass;

      if (inputProxyUrl && diskProxyUrl && (forceProxySync || (!proxyInputDirty && document?.activeElement !== inputProxyUrl))) {
        inputProxyUrl.value = diskProxyUrl;
      }
      if (inputProxyBypass && (forceProxySync || (!proxyInputDirty && document?.activeElement !== inputProxyBypass))) {
        inputProxyBypass.value = diskProxyBypass;
      }
      if (runtimeMeta) {
        if (typeof runtimeMeta.chineseNeedsRestart === 'boolean') {
          needsRestartAfterApply = Boolean(runtimeMeta.proxyNeedsRestart || runtimeMeta.chineseNeedsRestart);
        } else if (runtimeMeta.proxyNeedsRestart) {
          needsRestartAfterApply = true;
        }
        renderClientStatusBar();
      }

      if (proxyBadge) {
        if (currentProxyEnabled) {
          if (!isProxyDiskReady) {
            proxyBadge.textContent = t('mod.proxy.badgeNotInjected');
            proxyBadge.className = 'key-pill pill-warn';
          } else if (runtimeMeta?.proxyNeedsRestart) {
            proxyBadge.textContent = t('mod.proxy.badgePendingRestart');
            proxyBadge.className = 'key-pill pill-warn';
          } else if (runtimeMeta?.proxyActive) {
            proxyBadge.textContent = t('mod.proxy.badgeActive');
            proxyBadge.className = 'key-pill pill-ok';
          } else {
            proxyBadge.textContent = t('mod.proxy.badgeOk');
            proxyBadge.className = 'key-pill pill-ok';
          }
        } else if (runtimeMeta?.proxyNeedsRestart) {
          proxyBadge.textContent = t('mod.proxy.badgePendingOff');
          proxyBadge.className = 'key-pill pill-warn';
        } else {
          proxyBadge.textContent = t('mod.proxy.badgeOff');
          proxyBadge.className = 'key-pill pill-muted';
        }
      }
      if (proxyStatusDesc) {
        if (currentProxyEnabled) {
          if (!isProxyDiskReady) {
            proxyStatusDesc.textContent = isProxyPartial && disk.proxyReason
              ? t('mod.proxy.descPartialInject', { reason: translateBackendText(disk.proxyReason) })
              : t('mod.proxy.descNeedInject');
          } else if (runtimeMeta?.proxyNeedsRestart) {
            proxyStatusDesc.textContent = t('mod.proxy.descPendingRestart', { url: diskProxyUrl });
          } else if (runtimeMeta?.proxyActive) {
            proxyStatusDesc.textContent = t('mod.proxy.descActive', { url: runtimeMeta.runtimeProxyUrl || diskProxyUrl });
          } else {
            proxyStatusDesc.textContent = t('mod.proxy.descOn', { url: diskProxyUrl });
          }
        } else if (runtimeMeta?.proxyNeedsRestart) {
          proxyStatusDesc.textContent = t('mod.proxy.descPendingOff', { url: runtimeMeta.runtimeProxyUrl || '' });
        } else {
          proxyStatusDesc.textContent = t('mod.proxy.descOff');
        }
      }
      if (btnToggleProxyModule) {
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
      syncProxySaveButtonState();
    } catch (err) {
      if (seq !== modulesStatusReqSeq) return;
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
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en',
        brandTitle: currentBrandTitle
      });
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = Boolean(res.restartRequired);
        renderClientStatusBar();
        if (res.restartRequired) {
          showEnhanceResultBox(
            true,
            () => t(wantChinese ? 'mod.zh.savedEnableRestart' : 'mod.zh.savedDisableRestart'),
            { needsHostRestart: true }
          );
        } else {
          showEnhanceResultBox(
            true,
            () => translateBackendText(res.message || '已同步回当前运行状态，无需重启'),
            { needsHostRestart: false }
          );
        }
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, () => `${t('mod.zh.toggleFail')}: ${resolveSettingsErrorText(e, 'msg.unknownErr')}`);
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

  async function applyProxyModuleUpdate(enableTarget) {
    if (isProxyBusy) return;
    isProxyBusy = true;
    const rawUrl = String(inputProxyUrl?.value ?? '').trim();
    const rawBypass = String(inputProxyBypass?.value ?? '').trim();
    if (btnToggleProxyModule) {
      btnToggleProxyModule.disabled = true;
      btnToggleProxyModule.textContent = t('mod.processing');
    }
    syncProxySaveButtonState();
    try {
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'proxy', Boolean(enableTarget), {
        proxyUrl: rawUrl || undefined,
        bypassList: rawBypass
      });
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => resolveSettingsErrorText(errPayload, 'mod.proxy.toggleFail'));
      } else {
        proxyInputDirty = false;
        const needRestart = Boolean(res.runtime?.proxyNeedsRestart ?? res.restartRequired);
        if (needRestart) needsRestartAfterApply = true;
        const appliedUrl = res.data?.modules?.proxy?.proxyUrl || rawUrl;
        if (enableTarget) {
          const msgKey = needRestart ? 'mod.proxy.savedPendingRestart' : 'mod.proxy.savedAlreadyActive';
          showEnhanceResultBox(true, () => t(msgKey, { url: appliedUrl }), { needsHostRestart: needRestart });
        } else {
          const msgKey = needRestart ? 'mod.proxy.disabledPendingRestart' : 'mod.proxy.disabledSaved';
          showEnhanceResultBox(true, () => t(msgKey), { needsHostRestart: needRestart });
        }
      }
      await refreshModulesDisplay({ forceProxySync: true });
    } catch (e) {
      showEnhanceResultBox(false, () => `${t('mod.proxy.toggleFail')}: ${resolveSettingsErrorText(e, 'msg.unknownErr')}`);
    } finally {
      isProxyBusy = false;
      if (btnToggleProxyModule) {
        btnToggleProxyModule.disabled = false;
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
      syncProxySaveButtonState();
    }
  }

  btnToggleProxyModule?.addEventListener('click', () => {
    void applyProxyModuleUpdate(!currentProxyEnabled);
  });

  btnSaveProxyConfig?.addEventListener('click', () => {
    void applyProxyModuleUpdate(true);
  });

  btnTestProxy?.addEventListener('click', async () => {
    if (isProxyBusy) return;
    try {
      if (btnTestProxy) {
        btnTestProxy.disabled = true;
        btnTestProxy.textContent = t('settings.proxy.testing');
      }
      if (proxyTestResult) {
        proxyTestResult.style.display = 'block';
        lastProxyTestState = { pending: true };
        renderProxyTestResultView();
      }
      await yieldForSettingsPaint();
      const res = await invokeTestProxyApi(inputProxyUrl?.value?.trim());
      if (proxyTestResult) {
        lastProxyTestState = { pending: false, res };
        renderProxyTestResultView();
      }
    } catch (e) {
      if (proxyTestResult) {
        lastProxyTestState = { pending: false, thrownErr: e?.message || String(e || '') };
        renderProxyTestResultView();
      }
    } finally {
      if (btnTestProxy) {
        btnTestProxy.disabled = false;
        btnTestProxy.textContent = t('settings.proxy.testBtn');
      }
    }
  });

  // 静默初始化检测一次解锁状态与各模块状态
  const initDetectTimer1 = setTimeout(() => {
    if (state.disposed) return;
    void refreshUnlockStatus();
    void refreshModulesDisplay();
  }, 500);
  const initDetectTimer2 = setTimeout(() => {
    if (state.disposed) return;
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);
  earlyDisposeHooks.push(() => {
    clearTimeout(initDetectTimer1);
    clearTimeout(initDetectTimer2);
  });

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
      const pKey = formatPeriodCalendarLabel(ANTIGRAVITY_TOKEN_DATA.currentPeriod);
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

    const inShare = el('ref-cost-input-share');
    const inBar = el('ref-cost-input-bar');
    const caShare = el('ref-cost-cache-share');
    const caBar = el('ref-cost-cache-bar');
    const outShare = el('ref-cost-output-share');
    const outBar = el('ref-cost-output-bar');
    let cInUSD = 0, cCaUSD = 0, cOutUSD = 0;

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
      const pLabel = isPeriod ? formatPeriodCalendarLabel(ANTIGRAVITY_TOKEN_DATA.currentPeriod) : t('cost.allHistory');
      scopeDescEl.textContent = `${srcName} · ${pLabel}`;
    }
    const nonPaidBadge = el('cost-non-paid-badge');
    if (nonPaidBadge) nonPaidBadge.textContent = t('cost.nonPaidBadge');

    if (costModelMode === 'ref') {
      apiCost = Number(effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = currentPanelLanguage === 'zh-CN'
            ? t('cost.approx', { val: apiCost.toFixed(2) })
            : formatUsdMetricDisplay(apiCost, { detail: currentPanelLanguage === 'zh-TW' });
          grandVal.title = formatUsdMetricTooltip(apiCost);
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else if (activeTokenAccountFilter !== 'all' && curTotal === 0) {
          grandVal.textContent = t('cost.noRecords');
          grandVal.title = t('accounts.filterNoData');
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

      cInUSD = Number(effectiveRef.inputCostUSD || (curIn * rateIn / 1e6));
      cCaUSD = Number(effectiveRef.cacheCostUSD || (curCa * rateCa / 1e6));
      cOutUSD = Number(effectiveRef.outputCostUSD || (curOut * rateOut / 1e6));
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
    } else if (costModelMode === 'hybrid') {
      const h = curHybrid.hybrid || {};
      apiCost = Number(h.combinedTotalUSD || effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        grandVal.textContent = currentPanelLanguage === 'zh-CN'
          ? t('cost.approx', { val: apiCost.toFixed(2) })
          : formatUsdMetricDisplay(apiCost, { detail: currentPanelLanguage === 'zh-TW' });
        grandVal.title = `${t('cost.hybridSub', { known: Number(h.knownCostUSD || 0).toFixed(2), res: Number(h.unpricedResidualCostUSD || 0).toFixed(2) })} | ${formatUsdMetricTooltip(apiCost)}`;
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
      cInUSD = Number(rb.inputCostUSD || (Number(rb.input || 0) * rateIn / 1e6));
      cCaUSD = Number(rb.cacheCostUSD || (Number(rb.cache || 0) * rateCa / 1e6));
      cOutUSD = Number(rb.outputCostUSD || (Number(rb.output || 0) * rateOut / 1e6));
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.input || 0) });
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) });
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
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
          grandVal.textContent = currentPanelLanguage === 'zh-TW'
            ? formatUsdMetricDisplay(apiCost, { withPrefix: false, detail: true })
            : `$${apiCost.toFixed(2)}`;
          grandVal.title = formatUsdMetricTooltip(apiCost);
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

      cInUSD = (curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6;
      cCaUSD = (curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6;
      cOutUSD = (curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6;
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curIdentified.byCategory?.outputTokens || 0)} tok`;
    }

    const cSumUSD = cInUSD + cCaUSD + cOutUSD;
    const pctIn = cSumUSD > 0 ? Math.max(0, Math.min(100, (cInUSD / cSumUSD) * 100)) : 0;
    const pctCa = cSumUSD > 0 ? Math.max(0, Math.min(100, (cCaUSD / cSumUSD) * 100)) : 0;
    const pctOut = cSumUSD > 0 ? Math.max(0, Math.min(100, (cOutUSD / cSumUSD) * 100)) : 0;
    if (inShare) inShare.textContent = `${pctIn.toFixed(1)}%`;
    if (inBar) inBar.style.width = `${pctIn.toFixed(1)}%`;
    if (caShare) caShare.textContent = `${pctCa.toFixed(1)}%`;
    if (caBar) caBar.style.width = `${pctCa.toFixed(1)}%`;
    if (outShare) outShare.textContent = `${pctOut.toFixed(1)}%`;
    if (outBar) outBar.style.width = `${pctOut.toFixed(1)}%`;

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
    const resolvedAcqLabel = (ps.acquisitionSourceName && ps.acquisitionSourceName !== '正常付费订阅')
      ? localizeAcquisitionSource(ps.acquisitionSourceName)
      : localizeAcquisitionSource(ps.acquisitionSource || 'normal_paid');
    const resolvedCycleLabel = ps.billingCycle ? localizeBillingCycleLabel(ps.billingCycle) : t('plan.summary.perMonth');
    if (subSpendVal && subNote) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subSpendVal.textContent = `${curSymbol}0`;
        subNote.textContent = t('cost.freeActive', { src: resolvedAcqLabel || t('cost.freePromo'), extra: extraNoCompare });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        subSpendVal.textContent = `${curSymbol}${Number(ps.actualPricePaid).toFixed(2)}`;
        const expTag = ps.isExpired ? t('cost.expiredTag') : '';
        subNote.textContent = `${resolvedAcqLabel || t('cost.subSpend')} · ${t('cost.paidLabel')} (${resolvedCycleLabel})${expTag}${extraNoCompare}`;
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
        subLine.textContent = t('cost.subLineFree', { sym: curSymbol, src: resolvedAcqLabel || t('plan.tag.promo') });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const secPart = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { detail: true });
        const cnyPart = secPart ? ` (${secPart})` : '';
        subLine.textContent = t('cost.subLinePaid', {
          sym: curSymbol,
          val: Number(ps.actualPricePaid).toFixed(2),
          cny: cnyPart,
          cycle: resolvedCycleLabel,
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
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const paidUsd = (ps.currency || 'USD') === 'USD'
          ? Number(ps.actualPricePaid)
          : convertCurrencyUi(ps.actualPricePaid, ps.currency || 'USD', 'USD', ps.region);
        if (paidUsd !== null && Number.isFinite(paidUsd)) {
          const diff = apiCost - paidUsd;
          diffSummary.textContent = t('cost.diffPaid', { sign: diff >= 0 ? '+' : '', val: diff.toFixed(2) });
        } else {
          diffSummary.textContent = t('cost.diffUnknown');
        }
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
    if (refGrand) {
      const refNum = Number(curRef.totalCostUSD || 0);
      refGrand.textContent = currentPanelLanguage === 'zh-TW'
        ? formatUsdMetricDisplay(refNum, { detail: true })
        : t('cost.refApprox', { val: refNum.toFixed(2) });
    }
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

    setClassFlag(el('h-scroll-box'), 'is-cum-active', view === 'cum');

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge())) {
      void saveSettingsPayloadBridge({ savedHeatView: view });
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

  /**
   * 仅在累计页可见宽度跨过 460px 窄窗阈值时重绘，自动切换 .is-narrow
   */
  function syncCumResponsiveNarrowState() {
    if (state.disposed || activeHeatView !== 'cum') return false;
    const cumBox = el('h-cum-box');
    const scrollBox = el('h-scroll-box') || cumBox?.parentElement;
    const panelTokens = el('panel-tokens');
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const panelRect = panelTokens && typeof panelTokens.getBoundingClientRect === 'function' ? panelTokens.getBoundingClientRect() : null;
    let width = (rect && rect.width > 120) ? rect.width : 0;
    if (!width && panelRect && panelRect.width > 120) {
      width = Math.max(121, panelRect.width - 56);
    }
    if (!width) return false;
    const nextNarrow = width < 460;
    const cumRoot = cumBox?.querySelector?.('.cum-root') || (cumBox?.children?.[0] || null);
    if (!cumRoot) return false;
    const curNarrow = hasClass(cumRoot, 'is-narrow');
    if (curNarrow === nextNarrow) return false;
    renderActiveHeatView(true);
    return true;
  }

  let panelTokensResizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    const pTokensObsTarget = el('panel-tokens');
    const hScrollObsTarget = el('h-scroll-box');
    if (pTokensObsTarget) {
      panelTokensResizeObserver = new ResizeObserver(() => {
        syncCumResponsiveNarrowState();
      });
      panelTokensResizeObserver.observe(pTokensObsTarget);
      if (hScrollObsTarget) panelTokensResizeObserver.observe(hScrollObsTarget);
      earlyDisposeHooks.push(() => {
        try { panelTokensResizeObserver?.disconnect?.(); } catch { }
        panelTokensResizeObserver = null;
      });
    }
  }

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
      if (accountsUiState.removeModal?.open) {
        if (!accountsUiState.removeModal.busy) closeRemoveAccountModal();
        return;
      }
      if (activeHeatView === 'cum' && typeof hasActiveCumLock === 'function' && hasActiveCumLock()) {
        if (typeof clearCumLockAndRefresh === 'function') clearCumLockAndRefresh();
        return;
      }
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
    const parent = el('files');
    if (!parent) return;
    if (!session) {
      const sig = `none|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = t('files.reading');
      parent.replaceChildren(item);
      return;
    }
    if (!Array.isArray(session.attachments) || !session.attachments.length) {
      const sig = `empty|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = t('files.empty');
      parent.replaceChildren(item);
      return;
    }
    const filesSig = `${currentPanelLanguage}|` + session.attachments.map(file =>
      `${file.name}|${file.references}|${file.width || 0}x${file.height || 0}|${file.chars || 0}|${file.sheets ?? ''}|${file.cells || 0}|${file.hiddenSheets || 0}|${file.source || ''}|${range(file) || ''}|${(file.unknownParts || []).join(',')}`
    ).join(';');
    if (parent._lastRenderSig === filesSig) return;
    parent._lastRenderSig = filesSig;

    const nodes = [];
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
      nodes.push(item);
    }
    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    parent.replaceChildren();
    for (const n of nodes) parent.appendChild(n);
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
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
    const isScopedView = activeTokenAccountFilter !== 'all' || activeTokenSource !== 'all';
    if (isScopedView) {
      return keys.length ? keys[0] : null;
    }
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return null;
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = firstStr ? (parseLocalYmd(firstStr) || today) : today;
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
    if (firstBadge) firstBadge.textContent = firstStr ? t('tokens.firstUse', { date: formatZhYmd(firstStr) }) : t('tokens.firstUseNone');
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
    const incomingScope = payload.accountScopeKey || (payload.planStatus?.email ? String(payload.planStatus.email).trim().toLowerCase() : null);
    if (payload.isAccountSwitched || (incomingScope && typeof handleQuotaAccountSwitch === 'function' && handleQuotaAccountSwitch(incomingScope))) {
      if (typeof handleQuotaAccountSwitch === 'function') handleQuotaAccountSwitch(incomingScope || null, { forceRefresh: true });
    }
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (payload.isAccountSwitched) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = [];
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'quotaUsageCoverageStartMs')) {
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = payload.quotaUsageCoverageStartMs ?? null;
    }
    if (Array.isArray(payload.recentModelUsage)) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = payload.recentModelUsage;
      if (typeof refreshQuotaTokenEstimates === 'function') {
        refreshQuotaTokenEstimates();
      }
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
    const incomingAllMap = payload.dailyMapBySource?.[activeTokenSource] || payload.dailyMapBySource?.all || payload.dailyMap || {};
    const incomingKeys = Object.keys(incomingAllMap);
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(incomingAllMap[k]?.total) || 0), 0);
    const hasIncomingBySourceData = Boolean(
      payload.dailyMapBySource &&
      typeof payload.dailyMapBySource === 'object' &&
      Object.values(payload.dailyMapBySource).some(m => m && typeof m === 'object' && Object.keys(m).length > 0)
    );
    const hasIncomingRefCost = Boolean(payload.referenceCost?.currentMonth?.totalCostUSD || payload.referenceCost?.all?.totalCostUSD);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || hasIncomingBySourceData || incomingTotal > 0 || hasIncomingRefCost;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;
    syncTokenAccountFilterOptions(payload);

    // 若选择了指定账号或“历史未归属”，构造彻底隔离的账本视图（全量指标、热力图、按模型与费用同步切换，绝不泄漏全局总量）
    const isScopedAccountFilter = activeTokenAccountFilter !== 'all';
    let viewPayload = payload;
    if (isScopedAccountFilter) {
      const zeroCostEstimate = {
        pricedCostUSD: 0,
        pricedRequestsCount: 0,
        unpricedRequestsCount: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        coveragePercent: null,
        byModel: {},
        byCategory: {}
      };
      const zeroRefCost = {
        totalCostUSD: 0,
        inputCostUSD: 0,
        cacheCostUSD: 0,
        outputCostUSD: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelDisplayName: 'Gemini 3.8 Flash',
        matchedTier: { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 }
      };
      const bucket = activeTokenAccountFilter === 'unattributed'
        ? payload.unattributedUsage
        : payload.usageByAccount?.[activeTokenAccountFilter];
      if (bucket && typeof bucket === 'object') {
        const bDaily = bucket.dailyMap || {};
        const bDailyBySrc = bucket.dailyMapBySource || {
          all: bDaily,
          desktop: activeTokenAccountFilter === 'unattributed' ? bDaily : {},
          cli: {},
          legacyUnallocated: activeTokenAccountFilter === 'unattributed' ? bDaily : {}
        };
        const bModelsBySrc = bucket.dailyModelMapBySource || {
          all: {},
          desktop: {},
          cli: {}
        };
        const bCostEst = bucket.costEstimate || zeroCostEstimate;
        const bCostMonth = bucket.costEstimateCurrentMonth || bCostEst;
        const bCostBySrc = bucket.costEstimateBySource || {
          all: bCostEst,
          desktop: bCostEst,
          cli: zeroCostEstimate
        };
        const bCacheBySrc = bucket.cacheReadStatsBySource || (bucket.cacheReadStats
          ? { all: bucket.cacheReadStats, desktop: bucket.cacheReadStats, cli: null }
          : { all: null, desktop: null, cli: null });
        const bMonthCacheBySrc = bucket.currentMonthCacheReadStatsBySource || bCacheBySrc;
        viewPayload = {
          ...payload,
          scopedAccountView: true,
          firstUseDate: bucket.firstUseDate || null,
          dailyMap: bDaily,
          dailyMapBySource: bDailyBySrc,
          dailyModelMapBySource: bModelsBySrc,
          modelMetaByKey: bucket.modelMetaByKey || {},
          summary: {
            grandTotalTokens: Number(bucket.totalTokens) || 0,
            totalInputTokens: Number(bucket.totalInputTokens) || 0,
            totalOutputTokens: Number(bucket.totalOutputTokens) || 0,
            totalCacheTokens: Number(bucket.totalCacheTokens) || 0,
            todayTokens: Number(bucket.todayTokens) || 0,
            monthTokens: Number(bucket.monthTokens) || 0,
            yearTokens: Number(bucket.yearTokens) || 0,
            currentMonthInput: Number(bucket.currentMonthInput) || 0,
            currentMonthOutput: Number(bucket.currentMonthOutput) || 0,
            currentMonthCache: Number(bucket.currentMonthCache) || 0,
            activeDaysCount: Number(bucket.activeDaysCount) || Object.keys(bDaily).length,
            totalConversations: Number(bucket.totalConversations ?? bucket.callCount) || 0,
            totalSteps: Number(bucket.totalSteps ?? bucket.callCount) || 0,
            firstUseDate: bucket.firstUseDate || null,
            cacheReadStats: bucket.cacheReadStats || null,
            currentMonthCacheReadStats: bucket.currentMonthCacheReadStats || bucket.cacheReadStats || null
          },
          costEstimate: bCostEst,
          costEstimateCurrentMonth: bCostMonth,
          costEstimateBySource: bCostBySrc,
          cacheReadStatsBySource: bCacheBySrc,
          currentMonthCacheReadStatsBySource: bMonthCacheBySrc,
          referenceCost: bucket.referenceCost || {
            all: { ...zeroRefCost },
            currentMonth: { ...zeroRefCost },
            hybrid: { ...zeroRefCost },
            currentMonthHybrid: { ...zeroRefCost }
          }
        };
      } else {
        viewPayload = {
          ...payload,
          scopedAccountView: true,
          firstUseDate: null,
          dailyMap: {},
          dailyMapBySource: { all: {}, desktop: {}, cli: {}, legacyUnallocated: {} },
          dailyModelMapBySource: { all: {}, desktop: {}, cli: {} },
          modelMetaByKey: {},
          summary: {
            grandTotalTokens: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheTokens: 0,
            todayTokens: 0,
            monthTokens: 0,
            yearTokens: 0,
            currentMonthInput: 0,
            currentMonthOutput: 0,
            currentMonthCache: 0,
            activeDaysCount: 0,
            totalConversations: 0,
            totalSteps: 0,
            firstUseDate: null,
            cacheReadStats: null,
            currentMonthCacheReadStats: null
          },
          costEstimate: { ...zeroCostEstimate },
          costEstimateCurrentMonth: { ...zeroCostEstimate },
          costEstimateBySource: { all: { ...zeroCostEstimate }, desktop: { ...zeroCostEstimate }, cli: { ...zeroCostEstimate } },
          cacheReadStatsBySource: { all: null, desktop: null, cli: null },
          currentMonthCacheReadStatsBySource: { all: null, desktop: null, cli: null },
          referenceCost: {
            all: { ...zeroRefCost },
            currentMonth: { ...zeroRefCost },
            hybrid: { ...zeroRefCost },
            currentMonthHybrid: { ...zeroRefCost }
          }
        };
      }
    }

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(viewPayload, { source: activeTokenSource, todayStr, scopedAccountView: isScopedAccountFilter })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = normalized.dailyModelMap || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = normalized.dailyModelMapBySource || (isScopedAccountFilter ? viewPayload.dailyModelMapBySource : payload.dailyModelMapBySource) || null;
      ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = normalized.modelMetaByKey || (isScopedAccountFilter ? viewPayload.modelMetaByKey : payload.modelMetaByKey) || null;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.referenceCost = normalized.referenceCost;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      if (isScopedAccountFilter) {
        ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate || viewPayload.firstUseDate || null;
        ANTIGRAVITY_TOKEN_DATA.costEstimate = viewPayload.costEstimate;
        ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = viewPayload.costEstimateCurrentMonth;
        ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = viewPayload.costEstimateBySource;
      } else {
        if (normalized.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate;
      }
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
      if (payload.dailyModelMapBySource) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = payload.dailyModelMapBySource;
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = payload.dailyModelMapBySource[activeTokenSource] || payload.dailyModelMapBySource.all || {};
      } else if (payload.dailyModelMap) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = payload.dailyModelMap;
      }
      if (payload.modelMetaByKey) ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = payload.modelMetaByKey;
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
          } catch { }
          if (core && core.resolveEffectivePlanStatus) {
            mergedPlan = core.resolveEffectivePlanStatus(payload.rawPlanStatus || payload.planStatus, customObj, { currentEmail: email });
          }
        }
      } catch { }
      ANTIGRAVITY_TOKEN_DATA.planStatus = mergedPlan;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus || mergedPlan;
      renderPlanDetail(mergedPlan);
    }

    if (payload.costEstimate && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimate = payload.costEstimate;
    }
    if (payload.costEstimateCurrentMonth && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = payload.costEstimateCurrentMonth;
    }
    if (payload.costEstimateBySource && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = payload.costEstimateBySource;
    } else if (payload.costEstimate && !isScopedAccountFilter) {
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

    const cs = sum.cacheReadStats || {
      cacheStatus: (sum.totalInputTokens > 0 || sum.totalCacheTokens > 0) ? 'hit' : 'missing',
      totalUncachedInput: Number(sum.totalInputTokens) || 0,
      totalCacheRead: Number(sum.totalCacheTokens) || 0,
      totalInput: (Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0),
      totalOutput: Number(sum.totalOutputTokens) || 0,
      cacheReadPct: ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0)) > 0
        ? Number(((Number(sum.totalCacheTokens || 0) / ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0))) * 100).toFixed(1))
        : null,
      missingCount: 0
    };
    const tcbInp = el('tcb-input-val');
    const tcbCache = el('tcb-cache-val');
    const tcbTotInp = el('tcb-total-input-val');
    const tcbOut = el('tcb-output-val');
    const tcbRatio = el('tcb-ratio-val');
    const tcbRatioFill = el('tcb-ratio-bar-fill');
    const tcbNote = el('tcb-note');
    const unknownText = t('tokens.cache.unknown');
    if (tcbInp) tcbInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalUncachedInput);
    if (tcbCache) tcbCache.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalCacheRead);
    if (tcbTotInp) tcbTotInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalInput);
    if (tcbOut) tcbOut.textContent = fmtCardM(sum.totalOutputTokens || cs.totalOutput || 0);
    if (tcbRatio) {
      if (cs.cacheStatus === 'missing') tcbRatio.textContent = unknownText;
      else if (cs.cacheStatus === 'zero_input') tcbRatio.textContent = t('tokens.cache.na');
      else tcbRatio.textContent = cs.cacheReadPct !== null ? `${cs.cacheReadPct}%` : unknownText;
    }
    if (tcbRatioFill) {
      const pctNum = (cs.cacheStatus === 'missing' || cs.cacheStatus === 'zero_input' || cs.cacheReadPct === null)
        ? 0
        : Math.max(0, Math.min(100, Number(cs.cacheReadPct) || 0));
      tcbRatioFill.style.width = `${pctNum.toFixed(1)}%`;
    }
    if (tcbNote) {
      tcbNote.hidden = false;
      if (cs.cacheStatus === 'missing') {
        tcbNote.textContent = t('tokens.cache.missingNote');
      } else if (cs.cacheStatus === 'zero_input') {
        tcbNote.textContent = t('tokens.cache.zeroInputNote');
      } else if (cs.missingCount > 0) {
        tcbNote.textContent = t('tokens.cache.partialNote', { n: cs.missingCount });
      } else {
        tcbNote.textContent = t('tokens.cache.weightedNote');
      }
    }

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

    const isScopedEmptyAccount = isScopedAccountFilter && totalTokens === 0;
    const noAcctCostStr = t('tokens.noAccountCost');
    if (tTotalCost) {
      tTotalCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(totalCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: totalCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tTotalCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(totalCostAgg.totalCostUSD);
    }
    if (tTodayCost) {
      tTodayCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : formatUsdMetricDisplay(todayCostInfo.costUSD);
      tTodayCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(todayCostInfo.costUSD);
    }
    if (tMonthCost) {
      tMonthCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(monthCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: monthCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tMonthCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(monthCostAgg.totalCostUSD);
    }
    if (tYearCost) {
      tYearCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(yearCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: yearCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tYearCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(yearCostAgg.totalCostUSD);
    }

    // 规范化已完整保留输入/缓存/输出分类，执行费用视图渲染
    renderActiveCostEstimateView();
    renderModelUsageView();

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }


  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return { ok: false, changed: false };
    try {
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function')
        ? () => window.contextMeterAPI.recordCalls(calls)
        : null;
      if (!ipcFn && !hasLiveHttpBridge()) {
        return { ok: false, changed: false };
      }
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/record-calls',
        liveBody: { calls }
      });
      const res = out.result;
      if (res && res.ok === false) {
        console.warn('Context Meter: 记录调用入账失败', res.error);
      }
      return res || { ok: false, changed: false };
    } catch (err) {
      if (err?.httpStatus) {
        console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${err.httpStatus}`);
        return {
          ok: false,
          changed: false,
          status: err.httpStatus,
          ...(err.responseData?.error ? { error: err.responseData.error } : {}),
          ...(err.responseData?.phase ? { phase: err.responseData.phase } : {}),
          ...(err.responseData?.code ? { code: err.responseData.code } : {})
        };
      }
      console.warn('Context Meter: 调用入账发生异常', err);
      return { ok: false, changed: false, error: err?.message || String(err || '') };
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
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function')
        ? () => window.contextMeterAPI.getSettings({ email: currentEmail })
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/get-settings',
            liveBody: { email: currentEmail }
          });
          settingsRes = out.result;
        } catch { }
      }
      if (!settingsRes?.ok && typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
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
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            ...(settingsRes.customPlan ? { customPlan: { ...settingsRes.customPlan } } : {}),
            uiPreferences: { ...(settingsRes.uiPreferences || {}) },
            contextScopeMode,
            contextUnifiedPreference: { ...contextUnifiedPreference },
            contextPreferences: { ...contextPreferencesMap }
          };
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
        const savedAllowBeta = settingsRes.allowBetaUpdates !== undefined
          ? settingsRes.allowBetaUpdates
          : settingsRes.uiPreferences?.allowBetaUpdates;
        if (savedAllowBeta !== undefined) {
          allowBetaUpdates = savedAllowBeta === true;
          const chkBeta = el('check-allow-beta-updates');
          if (chkBeta) chkBeta.checked = allowBetaUpdates;
        }
        const savedDock = settingsRes.dockPosition || settingsRes.uiPreferences?.dockPosition;
        if (savedDock && savedDock !== 'flow') {
          setDockPosition('flow', { persist: true });
        } else {
          syncDockPositionUi();
        }
        const savedQuotaMode = settingsRes.quotaBadgeWindowMode || settingsRes.uiPreferences?.quotaBadgeWindowMode;
        if (savedQuotaMode && VALID_QUOTA_WINDOW_MODES.includes(savedQuotaMode) && savedQuotaMode !== quotaBadgeWindowMode) {
          setQuotaBadgeWindowMode(savedQuotaMode, { persist: false });
        } else {
          syncQuotaWindowModeUi();
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
        } catch { }
      }

      if (settingsRes?.ok && settingsRes.customPlan && typeof settingsRes.customPlan === 'object') {
        lastSavedCustomPlan = { ...settingsRes.customPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            customPlan: { ...settingsRes.customPlan },
            contextScopeMode,
            contextUnifiedPreference: { ...contextUnifiedPreference },
            contextPreferences: { ...contextPreferencesMap }
          };
        }

        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || settingsRes.customPlan?.account || currentEmail || 'default';
        try {
          const jsonStr = JSON.stringify(settingsRes.customPlan);
          if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch { }
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
    } catch { }
  }

  let lastHistorySync = 0;
  let historySyncBusy = false;
  let historySyncPending = false;
  let historySyncPendingForce = false;
  const AUTOMATIC_HISTORY_SYNC_INTERVAL_MS = 5000;
  let automaticHistorySyncPending = false;
  let lastAutomaticHistorySync = null;
  let hasScheduledInitialUpdateCheck = false;
  let startupRestorePromise = null;

  function syncPendingAutomaticHistory() {
    if (!automaticHistorySyncPending || historySyncBusy || state.disposed) return;
    const now = Date.now();
    if (lastAutomaticHistorySync !== null && now - lastAutomaticHistorySync < AUTOMATIC_HISTORY_SYNC_INTERVAL_MS) return;
    lastAutomaticHistorySync = now;
    void syncTokenHistoryFromHost(true);
  }

  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      historySyncPending = true;
      if (force) historySyncPendingForce = true;
      return;
    }
    const forceFlag = Boolean(force);
    if (forceFlag) automaticHistorySyncPending = false;
    historySyncBusy = true;
    lastHistorySync = Date.now();
    try {
      const fetchHistoryAsync = async () => {
        const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function')
          ? () => window.contextMeterAPI.getTokenHistory(forceFlag)
          : null;
        if (!ipcFn && !hasLiveHttpBridge()) return null;
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/token-history',
            liveBody: { force: forceFlag }
          });
          return out.result || null;
        } catch {
          return null;
        }
      };
      const restoreStep = startupRestorePromise
        ? startupRestorePromise
        : restoreSettingsFromHost();
      const [, res] = await Promise.all([restoreStep, fetchHistoryAsync()]);
      if (state.disposed) return;
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (res?.ok && res.data) {
        if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
        applyTokenHistoryPayload(res.data);
      }
    } catch { }
    finally {
      historySyncBusy = false;
      lastHistorySync = Date.now();
      if (!hasScheduledInitialUpdateCheck && autoCheckUpdate && !state.disposed) {
        hasScheduledInitialUpdateCheck = true;
        setTimeout(() => { if (!state.disposed) void checkAppUpdate(false); }, 4500);
      }
      if (historySyncPending && !state.disposed) {
        const nextForce = historySyncPendingForce;
        historySyncPending = false;
        historySyncPendingForce = false;
        void syncTokenHistoryFromHost(nextForce);
      } else {
        syncPendingAutomaticHistory();
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
    const triggerBtn = trigger === 'ctx'
      ? (el('btn-check-update-ctx') || el('v') || el('btn-check-update'))
      : (el('btn-check-update') || el('v'));
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
    pop.style.top = `${snapToDevicePixel(top)}px`;
    pop.style.right = `${snapToDevicePixel(right)}px`;
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

  const onUpdatePopoverResize = () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block') {
      positionUpdatePopover();
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onUpdatePopoverResize);
    earlyDisposeHooks.push(() => {
      try { window.removeEventListener?.('resize', onUpdatePopoverResize); } catch { }
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
    const restartBtn = el('btn-update-restart');
    const setUpdateRestartVisible = (visible) => {
      if (!restartBtn) return;
      const show = Boolean(visible && hostSupportsRestart);
      restartBtn.hidden = !show;
      if (restartBtn.style) restartBtn.style.display = show ? 'inline-block' : 'none';
    };

    // 检查桥接是否存在；若缺失则直接判定为更新功能不可用，严禁显示“最新”
    const currentVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.8';
    const currentDisplayVer = formatDisplayVersion(currentVer);
    const hasIpcUpdateBridge = typeof window !== 'undefined' && typeof window.contextMeterAPI?.checkUpdate === 'function';
    const hasBridge = hasIpcUpdateBridge || (hasLiveHttpBridge() && hasLiveRouteCapability('/check-update'));
    if (!hasBridge) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.unavailableTitle');
      if (verEl) verEl.textContent = t('update.unavailableVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.unavailableBody');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
      if (manual) showUpdatePopover(trigger);
      return;
    }

    if (manual) {
      cachedLatestRelease = null;
      showUpdatePopover(trigger);
      if (titleEl) titleEl.textContent = t('update.checkingTitle');
      if (verEl) verEl.textContent = t('update.checkingVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.connecting');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
    }

    try {
      const checkReq = { force: manual, currentVersion: currentVer, allowBetaUpdates };
      const out = await callBackendWithPriority({
        ipcCall: hasIpcUpdateBridge ? () => window.contextMeterAPI.checkUpdate(checkReq) : null,
        liveRoute: '/check-update',
        liveBody: checkReq
      });
      const res = out.result;

      // 返回 null、非对象或 ok: false 均为检查失败，严禁显示“最新”
      if (!res || res.ok === false) {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.failedTitle');
        if (verEl) verEl.textContent = t('update.failedVer', { ver: currentDisplayVer });
        const errMsg = res?.error ? translateBackendText(res.error) : t('update.failedFetch');
        if (bodyEl) bodyEl.textContent = t('update.failedBody', { err: errMsg });
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        setUpdateRestartVisible(false);
        if (manual) showUpdatePopover(trigger);
        return;
      }

      if (res.hasUpdate && res.latestVersion) {
        cachedLatestRelease = res;
        const nextDisplayVer = formatDisplayVersion(res.latestVersion);
        if (dot) dot.style.display = 'block';
        if (dotCtx) dotCtx.style.display = 'block';
        if (titleEl) titleEl.textContent = t('update.foundTitle');
        if (verEl) verEl.textContent = `${formatDisplayVersion(res.currentVersion || currentVer)} → ${nextDisplayVer}`;
        if (bodyEl) {
          bodyEl.textContent = t('update.foundBody', { ver: nextDisplayVer, notes: res.releaseNotes || t('update.defaultNotes') });
        }
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = t('update.applyNow');
          applyBtn.style.display = 'inline-block';
        }
        setUpdateRestartVisible(false);
        if (manual) showUpdatePopover(trigger);
      } else {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.latestTitle');
        const effectiveCurrent = res.installedVersion || res.currentVersion || currentVer;
        const effectiveDisplayVer = formatDisplayVersion(effectiveCurrent);
        if (verEl) verEl.textContent = t('update.latestVer', { ver: effectiveDisplayVer });
        const needsDiskRestart = Boolean(res.diskPendingRestart);
        if (needsDiskRestart) {
          pendingUpdateRestart = true;
        }
        const updateStatusText = needsDiskRestart
          ? t('update.diskPending', { ver: effectiveDisplayVer })
          : t('update.latestBody', { ver: effectiveDisplayVer });
        if (bodyEl) bodyEl.textContent = updateStatusText;
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        setUpdateRestartVisible(needsDiskRestart);
        if (needsDiskRestart && !hostSupportsRestart && statusEl) {
          statusEl.style.display = 'block';
          statusEl.textContent = t('client.restart.hostNotSupported');
        }
        if (manual) showUpdatePopover(trigger);
      }
    } catch (err) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.failedTitle');
      if (verEl) verEl.textContent = t('update.failedVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.failedNetBody', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
      if (manual) showUpdatePopover(trigger);
    }
  }

  async function applyAppUpdate() {
    const pop = el('update-popover');
    const applyBtn = el('btn-apply-update');
    const restartBtn = el('btn-update-restart');
    const statusEl = el('up-pop-status');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    if (!cachedLatestRelease) return;

    if (restartBtn) {
      restartBtn.hidden = true;
      if (restartBtn.style) restartBtn.style.display = 'none';
    }
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
      const hasIpcApply = typeof window !== 'undefined' && typeof window.contextMeterAPI?.applyUpdate === 'function';
      const hasLiveApply = hasLiveHttpBridge() && hasLiveRouteCapability('/apply-update');
      if (hasIpcApply || hasLiveApply) {
        const out = await callBackendWithPriority({
          ipcCall: hasIpcApply ? () => window.contextMeterAPI.applyUpdate({ version: cachedLatestRelease.latestVersion }) : null,
          liveRoute: '/apply-update',
          liveBody: { version: cachedLatestRelease.latestVersion }
        });
        res = out.result;
      } else {
        throw new Error(t('update.noApi'));
      }
      if (state.disposed) return;
      if (res && res.ok) {
        const fallbackVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.8';
        const nextVer = res.version || res.installedVersion || cachedLatestRelease?.latestVersion || fallbackVer;
        const nextDisplayVer = formatDisplayVersion(nextVer);
        const vEl = el('v');
        if (vEl && res.liveInjected) vEl.textContent = nextDisplayVer;

        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';

        const fullyHotReloaded = Boolean(res.liveInjected && res.backendHotReloaded);
        pendingUpdateRestart = !fullyHotReloaded;
        if (titleEl) titleEl.textContent = t('update.doneTitle');
        if (verEl) verEl.textContent = t('update.doneVer', { ver: nextDisplayVer });
        if (bodyEl) {
          bodyEl.textContent = fullyHotReloaded
            ? t('update.doneHotFull', { ver: nextDisplayVer })
            : (res.liveInjected ? t('update.doneHot', { ver: nextDisplayVer }) : t('update.doneDisk', { ver: nextDisplayVer }));
        }
        if (applyBtn) {
          applyBtn.textContent = t('update.btnUpdated');
          applyBtn.disabled = false;
        }
        if (restartBtn) {
          const showRestart = Boolean(!fullyHotReloaded && hostSupportsRestart);
          restartBtn.hidden = !showRestart;
          if (restartBtn.style) restartBtn.style.display = showRestart ? 'inline-block' : 'none';
        }

        if (fullyHotReloaded) {
          if (statusEl) statusEl.textContent = t('update.doneHotFull', { ver: nextDisplayVer });
          if (backendStatus.backendVersion === nextVer) {
            backendStatus.backendVersionMismatch = false;
          }
        } else if (res.liveInjected) {
          if (statusEl) statusEl.textContent = t('update.doneHot', { ver: nextDisplayVer });
        } else {
          if (statusEl) {
            statusEl.textContent = hostSupportsRestart
              ? t('update.doneDisk', { ver: nextDisplayVer })
              : `${t('update.doneDisk', { ver: nextDisplayVer })} ${t('client.restart.hostNotSupported')}`;
          }
        }
        if (typeof renderQuotaBoard === 'function') {
          renderQuotaBoard(Date.now(), { animate: false });
        }
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
  const btnUpdateRestartInit = el('btn-update-restart');
  if (btnUpdateRestartInit) {
    btnUpdateRestartInit.hidden = true;
    if (btnUpdateRestartInit.style) btnUpdateRestartInit.style.display = 'none';
    btnUpdateRestartInit.addEventListener('click', () => {
      hideUpdatePopover();
      openClientRestartConfirmFlow();
    });
  }

  el('check-auto-update')?.addEventListener('change', e => {
    autoCheckUpdate = e.target.checked;
    if (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge()) {
      void saveSettingsPayloadBridge({ autoCheckUpdate });
    }
  });

  const chkBetaInit = el('check-allow-beta-updates');
  if (chkBetaInit) {
    chkBetaInit.checked = allowBetaUpdates;
    chkBetaInit.addEventListener('change', e => {
      allowBetaUpdates = e.target.checked === true;
      if (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge()) {
        void saveSettingsPayloadBridge({ allowBetaUpdates });
      }
    });
  }

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

  function stopLiveWaitTickTimer() {
    if (state.liveWaitTickTimer) {
      clearInterval(state.liveWaitTickTimer);
      state.liveWaitTickTimer = null;
    }
  }

  function clearLivePendingRequestWait() {
    state.livePendingRequest = null;
    stopLiveWaitTickTimer();
  }
  earlyDisposeHooks.push(clearLivePendingRequestWait);

  function resolveSpeedEvaluationInput() {
    if (state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object') {
      return state.speedOverrideForTest;
    }
    if (state.livePendingRequest && state.route && state.livePendingRequest.cascadeId === state.route) {
      const elapsedSec = Math.max(0, (Date.now() - state.livePendingRequest.startedAtMs) / 1000);
      return {
        phase: 'waiting',
        status: 'waiting',
        elapsedSec
      };
    }
    const d = state.latest;
    if (!d) return { phase: 'idle', status: 'idle' };
    const latestRec = resolveLatestSessionCallRecord();
    const sameActiveCall = latestRec && (!d.speed || !latestRec.outputTokens || Math.abs(Number(latestRec.outputTokens) - Number(d.speed?.outputTokens || 0)) <= 50 || latestRec.status === 'streaming');
    const trackedSamples = (latestRec && state.streamSampleTracker?.byCallId?.get?.(latestRec.callId)) || null;

    if (d.status === 'canceled' || d.errorClassification?.kind === 'canceled') {
      return {
        phase: 'canceled',
        status: 'canceled',
        outcomeStatus: 'canceled',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (d.exceeded || d.network || d.error || ['failed', 'quota_exhausted', 'rate_limited', 'auth_error', 'service_unavailable'].includes(d.status)) {
      return {
        phase: 'failed',
        status: d.status || 'failed',
        outcomeStatus: d.status || 'failed',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (latestRec && latestRec.status === 'streaming' && latestRec.outputTokens > 0) {
      return {
        phase: 'streaming',
        status: 'streaming',
        ttftSec: latestRec.ttftSec ?? d.speed?.ttft ?? null,
        streamingSec: latestRec.streamingSec ?? d.speed?.streamingSec ?? trackedSamples?.elapsedStreamSec ?? null,
        totalDurationSec: latestRec.durationSec ?? d.speed?.duration ?? null,
        streamSpeed: latestRec.streamingTps ?? d.speed?.streamingTps ?? null,
        overallTps: latestRec.tps ?? d.speed?.tps ?? null,
        outputTokens: latestRec.outputTokens ?? d.speed?.outputTokens ?? 0,
        totalInputTokens: latestRec.totalInputTokens ?? d.input ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    if (d.speed) {
      return {
        phase: 'final',
        status: 'final',
        ttftSec: d.speed.ttft ?? null,
        streamingSec: d.speed.streamingSec ?? null,
        totalDurationSec: d.speed.duration ?? null,
        streamSpeed: d.speed.streamingTps ?? d.speed.streamSpeed ?? null,
        overallTps: d.speed.tps ?? null,
        outputTokens: d.speed.outputTokens ?? null,
        totalInputTokens: d.speed.totalInputTokens ?? d.input ?? null,
        chunkCount: (sameActiveCall && trackedSamples?.chunks) || (sameActiveCall && latestRec?.chunkCount) || null,
        chunkIntervalsMs: (sameActiveCall && trackedSamples?.intervalsMs) || (sameActiveCall && latestRec?.chunkIntervalsMs) || null
      };
    }
    if (latestRec && (latestRec.ttftSec != null || latestRec.durationSec != null || latestRec.outputTokens > 0)) {
      return {
        phase: latestRec.status === 'streaming' ? 'streaming' : 'final',
        status: latestRec.status,
        ttftSec: latestRec.ttftSec ?? null,
        streamingSec: latestRec.streamingSec ?? null,
        totalDurationSec: latestRec.durationSec ?? null,
        streamSpeed: latestRec.streamingTps ?? null,
        overallTps: latestRec.tps ?? null,
        outputTokens: latestRec.outputTokens ?? null,
        totalInputTokens: latestRec.totalInputTokens ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    return { phase: 'idle', status: 'idle' };
  }

  function applyElv91PillTone(badgeEl, evalRes) {
    if (!badgeEl || !evalRes?.badge) return;
    const sev = evalRes.badge.severity || 'neutral';
    const cls = (sev === 'good' || sev === 'fast' || sev === 'rapid' || sev === 'epic')
      ? 'pill-good'
      : (sev === 'warn' ? 'pill-warn' : ((sev === 'danger' || sev === 'critical') ? 'pill-danger' : 'pill-muted'));
    badgeEl.className = `key-pill ${cls}`;
    badgeEl.style.color = evalRes.badge.color || '';
    badgeEl.textContent = `${evalRes.badge.glyph ? evalRes.badge.glyph + ' ' : ''}${evalRes.badge.text}`;
  }

  function renderSpeedExperienceInPlace(evalRes) {
    if (!evalRes) return;
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const activeColor = evalRes.badge?.color || '';

    const bSpeed = el('badge-speed');
    const speedAmount = el('speed-amount');
    const waitSvgWrap = el('badge-speed-wait-svg');
    const overflowSpeedVal = el('overflow-speed-val');
    const topBolt = el('badge-speed-icon');
    const cardBolt = el('speed-summary-bolt');
    if (topBolt) topBolt.style.color = activeColor;
    if (cardBolt) cardBolt.style.color = activeColor;
    if (topBolt && evalRes.badge?.glyph) topBolt.textContent = evalRes.badge.glyph;
    if (cardBolt && evalRes.badge?.glyph) cardBolt.textContent = evalRes.badge.glyph;

    const isCompact = state.layoutMode === 'compact';
    const shortSampleText = t('session.speed.shortSampleBadge');
    if (evalRes.phase === 'waiting') {
      // ELV-93: 等待态顶栏纯 SVG 沙漏动效，去除每秒文字变化导致的横向抖动
      bSpeed?.setAttribute?.('data-speed-phase', 'waiting');
      if (waitSvgWrap) waitSvgWrap.hidden = false;
      if (speedAmount) speedAmount.textContent = '';
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.elapsedFormatted || '0s'}`;
      if (bSpeed) {
        const waitTip = t('badge.speedWaitTitle', { elapsed: evalRes.elapsedFormatted || '0s' });
        bSpeed.title = waitTip;
        bSpeed.setAttribute?.('aria-label', waitTip);
      }
    } else {
      bSpeed?.removeAttribute?.('data-speed-phase');
      if (waitSvgWrap) waitSvgWrap.hidden = true;
      bSpeed?.setAttribute?.('aria-label', t('badge.speed.aria'));
      if (speedAmount) {
        if (evalRes.isSampleSparse) {
          speedAmount.textContent = shortSampleText;
          if (overflowSpeedVal) overflowSpeedVal.textContent = shortSampleText;
        } else if (evalRes.streamSpeed != null) {
          speedAmount.textContent = isCompact ? `${evalRes.streamSpeed}` : `${evalRes.streamSpeed} tok/s`;
          if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.streamSpeed} tok/s`;
        } else if (evalRes.overallTps != null) {
          speedAmount.textContent = isCompact ? `${evalRes.overallTps}` : `${evalRes.overallTps} tok/s`;
          if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.overallTps} tok/s`;
        } else {
          speedAmount.textContent = isCompact ? '--' : '-- tok/s';
          if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
        }
      }
    }

    const spBadge = el('speed-badge');
    const spVal = el('speed-val');
    const spDur = el('speed-duration');
    const spTtft = el('speed-ttft');
    const spTokens = el('speed-tokens');
    const spSub = el('speed-sub-label');
    const spTakeaway = el('speed-takeaway');
    const spToggleBtn = el('btn-speed-breakdown-toggle');
    const spBreakdownDet = el('speed-breakdown-details');
    const spBreakdownGrid = el('speed-breakdown-grid');

    const spMockTag = el('speed-mock-tag');
    if (spMockTag) {
      spMockTag.hidden = !(state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object');
      if (!spMockTag.hidden) spMockTag.textContent = t('session.speed.mockTag');
    }
    if (spBadge) applyElv91PillTone(spBadge, evalRes);
    if (spVal) {
      if (evalRes.phase === 'waiting') {
        spVal.textContent = isEn ? 'Waiting' : '等待首字';
      } else if (evalRes.isSampleSparse) {
        spVal.textContent = shortSampleText;
      } else if (evalRes.streamSpeed != null) {
        spVal.textContent = `${evalRes.streamSpeed} tok/s`;
      } else if (evalRes.overallTps != null) {
        spVal.textContent = `${evalRes.overallTps} tok/s`;
      } else {
        spVal.textContent = '—';
      }
    }
    if (spDur) spDur.textContent = evalRes.durationFormatted || '—';
    if (spTtft) spTtft.textContent = evalRes.ttftFormatted || '—';
    if (spTokens) spTokens.textContent = evalRes.outputTokens != null ? `${fmt(evalRes.outputTokens)} tok` : '—';

    if (spSub) {
      if (evalRes.subLabel && evalRes.phase !== 'idle') {
        spSub.hidden = false;
        spSub.textContent = evalRes.subLabel;
      } else {
        spSub.hidden = true;
        spSub.textContent = '';
      }
    }
    if (spTakeaway) {
      const avgNote = (evalRes.phase === 'final' && evalRes.overallTps != null && (evalRes.isSampleSparse || (evalRes.streamSpeed != null && Math.abs(evalRes.overallTps - evalRes.streamSpeed) >= 5)))
        ? (isEn ? ` (Overall avg ${evalRes.overallTps} tok/s)` : (isTw ? `（整體均速 ${evalRes.overallTps} tok/s）` : `（整体均速 ${evalRes.overallTps} tok/s）`))
        : '';
      spTakeaway.textContent = `${evalRes.comment || ''}${avgNote}`;
    }

    const canShowBreakdown = evalRes.phase === 'final' || evalRes.phase === 'streaming';
    if (spToggleBtn) {
      spToggleBtn.hidden = !canShowBreakdown;
      spToggleBtn.textContent = state.speedBreakdownOpen ? t('session.speed.hideDetails') : t('session.speed.details');
      spToggleBtn.setAttribute?.('aria-expanded', state.speedBreakdownOpen ? 'true' : 'false');
    }
    if (spBreakdownDet) {
      spBreakdownDet.style.display = (canShowBreakdown && state.speedBreakdownOpen) ? 'block' : 'none';
    }
    if (spBreakdownGrid && canShowBreakdown && state.speedBreakdownOpen) {
      spBreakdownGrid.replaceChildren();
      const unk = t('session.latestCall.unknownVal');
      const eText = evalRes.efficiency?.available
        ? `${evalRes.efficiency.score} ${isEn ? 'pts' : '分'} · ${evalRes.efficiency.tier?.title || evalRes.efficiency.grade}`
        : (evalRes.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing'));
      const stabText = evalRes.stability?.isStable
        ? t('session.speed.stabilityOk', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
        : (evalRes.stability?.reason === 'high_variance'
          ? t('session.speed.stabilityHighVar', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
          : t('session.speed.stabilityUnverified'));
      const fmtTierComment = (tier, elapsed) => (tier && tier.comment) ? String(tier.comment).replace('{elapsed}', elapsed || '—') : '';
      const streamCellVal = evalRes.isSampleSparse
        ? `${shortSampleText}${evalRes.shortWindowEstimateSpeed != null ? ` (${evalRes.shortWindowEstimateSpeed} tok/s)` : ''}`
        : (evalRes.speedTier ? `${evalRes.streamSpeed} tok/s · ${evalRes.speedTier.title}` : unk);
      const cells = [
        {
          k: t('session.speed.breakdown.eScore'),
          v: eText,
          color: evalRes.efficiency?.tier?.color || null,
          note: evalRes.efficiency?.tier?.comment || ''
        },
        {
          k: t('session.speed.breakdown.ttft'),
          v: evalRes.ttftTier ? `${evalRes.ttftFormatted} · ${evalRes.ttftTier.title}${evalRes.ttftRatioPct != null ? ` (${evalRes.ttftRatioPct}%)` : ''}` : unk,
          color: evalRes.ttftTier?.color || null,
          note: fmtTierComment(evalRes.ttftTier, evalRes.ttftFormatted)
        },
        {
          k: t('session.speed.breakdown.stream'),
          v: streamCellVal,
          color: evalRes.isSampleSparse ? null : (evalRes.speedTier?.color || null),
          note: evalRes.isSampleSparse ? t('session.speed.shortWindowNote') : (evalRes.speedTier?.comment || '')
        },
        {
          k: t('session.speed.breakdown.duration'),
          v: evalRes.durationTier ? `${evalRes.durationFormatted} · ${evalRes.durationTier.title}` : unk,
          color: evalRes.durationTier?.color || null,
          note: evalRes.durationTier?.comment || ''
        },
        { k: t('session.speed.breakdown.overall'), v: evalRes.overallTps != null ? `${evalRes.overallTps} tok/s` : unk, color: null, note: '' },
        { k: t('session.speed.breakdown.stability'), v: stabText, color: evalRes.stability?.isStable ? '#10B981' : null, note: '' }
      ];
      if (evalRes.isSampleSparse && evalRes.shortWindowEstimateSpeed != null) {
        cells.splice(3, 0, {
          k: t('session.speed.shortWindowEst'),
          v: `${evalRes.shortWindowEstimateSpeed} tok/s`,
          color: null,
          note: t('session.speed.shortWindowNote')
        });
      }
      if (evalRes.efficiency?.basis) {
        const b = evalRes.efficiency.basis;
        cells.push({
          k: t('session.speed.breakdown.basis'),
          v: `N=${b.N_work} · γ=${b.gamma} · w=[${b.w1}/${b.w2}/${b.w3}]`,
          color: null,
          note: ''
        });
      }
      for (const item of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = item.k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        if (item.color) {
          const dot = document.createElement('span');
          dot.className = 'tier-color-swatch';
          dot.style.backgroundColor = item.color;
          dot.setAttribute('aria-hidden', 'true');
          vEl.appendChild(dot);
          const txtEl = document.createElement('span');
          txtEl.textContent = item.v;
          vEl.appendChild(txtEl);
        } else {
          vEl.textContent = item.v;
        }
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        if (item.note) {
          const noteEl = document.createElement('span');
          noteEl.className = 'call-detail-note';
          noteEl.textContent = item.note;
          cell.appendChild(noteEl);
        }
        spBreakdownGrid.appendChild(cell);
      }
    }
    state.lastSpeedEval = evalRes;
  }

  function startLivePendingRequestWait(cascadeId) {
    const cid = cascadeId || state.route;
    if (!cid) return;
    const latestRec = resolveLatestSessionCallRecord();
    state.livePendingRequest = {
      cascadeId: cid,
      startedAtMs: Date.now(),
      baselineCallId: latestRec?.callId || null,
      baselineCount: state.count || 0
    };
    const updateWaitOnly = () => {
      if (state.disposed || !state.livePendingRequest || state.livePendingRequest.cascadeId !== state.route) {
        stopLiveWaitTickTimer();
        return;
      }
      if (typeof evaluateGenerationExperience === 'function') {
        renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
      }
    };
    updateWaitOnly();
    stopLiveWaitTickTimer();
    state.liveWaitTickTimer = setInterval(updateWaitOnly, 1000);
  }

  function syncSpeedBadgeText() {
    if (typeof evaluateGenerationExperience === 'function') {
      const evalRes = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
      renderSpeedExperienceInPlace(evalRes);
      return;
    }
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

  let lastCallCardLang = '';
  let timelineFetchController = null;
  let timelineFetchSeq = 0;

  function prefersReducedMotionNow() {
    try {
      return Boolean(typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function formatCallTimeStr(call) {
    if (!call) return '—';
    const rawTs = call.timestamp || (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(rawTs) || rawTs <= 0) return t('session.latestCall.unknownVal');
    try {
      return new Date(rawTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return new Date(rawTs).toLocaleTimeString();
    }
  }

  function formatCallModelTitle(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.isPlaceholderOnly && !call.isRoutedModelVerified) {
      const rawId = call.rawPlaceholderId || call.modelExactId || call.model || '';
      return rawId ? t('session.latestCall.unknownMappedModel', { id: rawId }) : t('session.latestCall.unknownVal');
    }
    const rawLbl = call.modelLabel || (call.model && !/^model_/i.test(String(call.model)) ? String(call.model) : '');
    if (rawLbl) {
      if (typeof splitModelDisplayAndEffort === 'function') {
        const split = splitModelDisplayAndEffort(rawLbl, call.effort);
        if (split.baseLabel) return split.baseLabel;
      }
      return rawLbl;
    }
    if (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId))) return String(call.stableModelId);
    if (call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId))) return String(call.modelExactId);
    if (call.model && !/^model_placeholder_/i.test(String(call.model))) return String(call.model);
    if (call.rawPlaceholderId || call.modelExactId || call.model) {
      return t('session.latestCall.unknownMappedModel', { id: call.rawPlaceholderId || call.modelExactId || call.model });
    }
    return t('session.latestCall.unknownVal');
  }

  function buildCallDisplaySignature(call) {
    if (!call) return '';
    return [
      call.callId || '',
      call.outcomeStatus || call.status || '',
      call.inputTokens ?? '',
      call.cacheReadTokens ?? '',
      call.outputTokens ?? '',
      call.totalTokens ?? '',
      call.modelExactId || call.model || '',
      call.modelLabel || '',
      call.effort || '',
      call.durationSec ?? '',
      call.ttftSec ?? '',
      call.error || '',
      call.agentRole || ''
    ].join('|');
  }

  function resolveLatestSessionCallRecord() {
    if (!state.route) return null;
    const rawPool = [];
    if (Array.isArray(state.sessionCalls)) {
      for (const c of state.sessionCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (Array.isArray(state.scan?.recentGeneratorCalls)) {
      for (const c of state.scan.recentGeneratorCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (state.scan?.latestCallRecord) {
      rawPool.push(state.scan.latestCallRecord);
    }
    if (!rawPool.length) return null;

    const mergedById = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    for (const raw of rawPool) {
      const norm = typeof normalizeSessionCallRecord === 'function'
        ? normalizeSessionCallRecord(raw, { cascadeId: state.route, cascadeModelConfigs: configs })
        : raw;
      if (!norm || !norm.callId) continue;
      const prev = mergedById.get(norm.callId);
      if (!prev) {
        mergedById.set(norm.callId, norm);
        continue;
      }
      // 同一 callId 从不同源补齐耗时、精确模型或状态，不产生第二条
      mergedById.set(norm.callId, {
        ...prev,
        ...norm,
        modelExactId: norm.modelExactId || prev.modelExactId || null,
        modelLabel: norm.modelLabel || prev.modelLabel || null,
        effort: norm.effort || prev.effort || null,
        ttftSec: norm.ttftSec ?? prev.ttftSec ?? null,
        durationSec: norm.durationSec ?? prev.durationSec ?? null,
        tps: norm.tps ?? prev.tps ?? null,
        streamingTps: norm.streamingTps ?? prev.streamingTps ?? null,
        error: norm.error || prev.error || null,
        errorClassification: norm.errorClassification || prev.errorClassification || null,
        hasInputCacheFields: Boolean(norm.hasInputCacheFields || prev.hasInputCacheFields),
        inputTokens: norm.hasInputCacheFields ? norm.inputTokens : (prev.hasInputCacheFields ? prev.inputTokens : norm.inputTokens),
        cacheReadTokens: norm.hasInputCacheFields ? norm.cacheReadTokens : (prev.hasInputCacheFields ? prev.cacheReadTokens : norm.cacheReadTokens),
        totalInputTokens: norm.hasInputCacheFields ? norm.totalInputTokens : (prev.hasInputCacheFields ? prev.totalInputTokens : norm.totalInputTokens),
        outputTokens: Math.max(Number(norm.outputTokens) || 0, Number(prev.outputTokens) || 0) || norm.outputTokens,
        totalTokens: Math.max(Number(norm.totalTokens) || 0, Number(prev.totalTokens) || 0) || norm.totalTokens,
        timestamp: norm.timestamp || prev.timestamp || null,
        created_at: norm.created_at || prev.created_at || null,
        stepIndex: norm.stepIndex ?? prev.stepIndex ?? null
      });
    }

    const candidates = Array.from(mergedById.values());
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ta = Number(a.timestamp) || 0;
      const tb = Number(b.timestamp) || 0;
      if (ta !== tb) return ta - tb;
      const sa = a.stepIndex != null ? Number(a.stepIndex) : -1;
      const sb = b.stepIndex != null ? Number(b.stepIndex) : -1;
      if (sa !== sb) return sa - sb;
      if (a.status === 'streaming' && b.status !== 'streaming') return 1;
      if (b.status === 'streaming' && a.status !== 'streaming') return -1;
      return 0;
    });
    return candidates[candidates.length - 1];
  }

  function isElementActivelyInspected() {
    try {
      const det = el('latest-call-details');
      const tl = el('session-timeline-drawer');
      if (det && state.latestCallDetailOpen && typeof det.matches === 'function' && det.matches(':hover')) return true;
      if (tl && state.historyDrawerOpen && typeof tl.matches === 'function' && tl.matches(':hover')) return true;
      const activeEl = shadow?.activeElement || document?.activeElement;
      if (activeEl && ((det && det.contains?.(activeEl)) || (tl && tl.contains?.(activeEl)))) return true;
      const sel = shadow?.getSelection?.() || window?.getSelection?.();
      if (sel && String(sel.toString() || '').trim().length > 0 && sel.anchorNode) {
        const card = el('latest-call-card');
        if (card && card.contains?.(sel.anchorNode)) return true;
      }
    } catch { }
    return false;
  }

  function isCallCardReadingProtected(incomingCall) {
    if (!state.displayedCallRecord || !incomingCall) return false;
    if (state.pinnedCallRecord) return true;
    const differentCall = incomingCall.callId !== state.displayedCallRecord.callId;
    if (!differentCall) return false;
    if (state.latestCallDetailOpen && state.displayedCallRecord.status !== 'streaming') return true;
    if (isElementActivelyInspected()) return true;
    return false;
  }

  function resolveCallStatusDisplay(call) {
    const out = call?.outcomeStatus || call?.status || 'unknown';
    if (out === 'streaming') return { text: t('session.latestCall.statusStreaming'), cls: 'key-pill pill-warn' };
    if (out === 'canceled') return { text: t('session.latestCall.statusCanceled'), cls: 'key-pill pill-muted' };
    if (out === 'success' || out === 'final') return { text: t('session.latestCall.statusSuccess'), cls: 'key-pill pill-good' };
    if (out === 'quota_exhausted' || out === 'context_overflow' || out === 'exceeded' || out === 'network' || out === 'network_error' || out === 'rate_limit' || out === 'failed' || call?.error) {
      return { text: t('session.latestCall.statusFailed'), cls: 'key-pill pill-danger' };
    }
    return { text: t('session.latestCall.statusUnknown'), cls: 'key-pill pill-muted' };
  }

  function formatCallCachePctText(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'missing' || !call.hasInputCacheFields) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'zero_input') return t('session.latestCall.naVal');
    if (call.cacheReadPct !== null && call.cacheReadPct !== undefined) return `${call.cacheReadPct}%`;
    return t('session.latestCall.unknownVal');
  }

  function applyLatestCallRecordToDom(call, { playAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    const statusPill = el('latest-call-status-pill');
    const agentPill = el('latest-call-agent-pill');
    const timeEl = el('latest-call-time');
    const modelEl = el('latest-call-model');
    const effortEl = el('latest-call-effort');
    const tokInline = el('latest-call-tokens-inline');
    const cacheInline = el('latest-call-cache-inline');
    const durInline = el('latest-call-duration-inline');
    const detailGrid = el('latest-call-detail-grid');
    const errorBox = el('latest-call-error-box');
    const bodyEl = el('latest-call-body');

    const st = resolveCallStatusDisplay(call);
    if (statusPill) {
      statusPill.textContent = st.text;
      statusPill.className = st.cls;
    }

    if (agentPill) {
      if (call.agentRole === 'subagent') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-subagent';
        agentPill.textContent = call.subagentType ? `${t('session.latestCall.agentSub')} · ${call.subagentType}` : t('session.latestCall.agentSub');
      } else if (call.attributionConfidence === 'unidentified') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-unknown';
        agentPill.textContent = t('session.latestCall.agentUnknown');
      } else {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge';
        agentPill.textContent = t('session.latestCall.agentMain');
      }
    }

    if (timeEl) timeEl.textContent = formatCallTimeStr(call);
    const modelTitle = formatCallModelTitle(call);
    if (modelEl) {
      modelEl.textContent = modelTitle;
      modelEl.title = call.modelExactId ? `${modelTitle} (${call.modelExactId})` : modelTitle;
    }
    if (effortEl) {
      if (call.effort) {
        effortEl.hidden = false;
        effortEl.textContent = call.effort;
      } else {
        effortEl.hidden = true;
        effortEl.textContent = '';
      }
    }

    const unk = t('session.latestCall.unknownVal');
    const scoreInline = el('latest-call-score-inline');
    const callEval = (typeof evaluateGenerationExperience === 'function')
      ? evaluateGenerationExperience({
          phase: call.status === 'streaming' ? 'streaming' : (call.outcomeStatus === 'canceled' ? 'canceled' : (call.error ? 'failed' : 'final')),
          outcomeStatus: call.outcomeStatus,
          ttftSec: call.ttftSec,
          streamingSec: call.streamingSec,
          totalDurationSec: call.durationSec,
          streamSpeed: call.streamingTps ?? call.streamSpeed,
          overallTps: call.tps,
          outputTokens: call.outputTokens,
          totalInputTokens: call.totalInputTokens,
          chunkCount: call.chunkCount,
          chunkIntervalsMs: call.chunkIntervalsMs,
          intervalCv: call.intervalCv,
          sampleSource: call.sampleSource || null,
          isSyntheticPoll: call.isSyntheticPoll === true,
          error: call.error
        }, currentPanelLanguage)
      : null;

    if (scoreInline) {
      if (callEval && callEval.efficiency?.available) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${callEval.efficiency.score}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${callEval.efficiency.grade}`;
        scoreInline.style.color = callEval.efficiency.tier?.color || '';
        scoreInline.style.borderColor = callEval.efficiency.tier?.color || '';
        scoreInline.title = callEval.shortTitle || '';
      } else if (call.eScore != null && call.eGrade) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${call.eScore}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${call.eGrade}`;
        scoreInline.style.color = callEval?.badge?.color || '';
        scoreInline.style.borderColor = callEval?.badge?.color || '';
      } else {
        scoreInline.hidden = true;
        scoreInline.textContent = '—';
        scoreInline.style.color = '';
        scoreInline.style.borderColor = '';
      }
    }

    const inpStr = call.hasInputCacheFields && call.inputTokens !== null ? short(call.inputTokens) : unk;
    const outStr = call.outputTokens !== null && call.outputTokens !== undefined ? short(call.outputTokens) : unk;
    if (tokInline) tokInline.textContent = t('session.latestCall.inlineTokens', { inp: inpStr, out: outStr });
    if (cacheInline) cacheInline.textContent = t('session.latestCall.inlineCache', { val: formatCallCachePctText(call) });
    if (durInline) durInline.textContent = call.durationSec !== null && call.durationSec !== undefined
      ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(call.durationSec, currentPanelLanguage) : `${call.durationSec}s`)
      : '—';

    if (detailGrid) {
      detailGrid.replaceChildren();
      const agentDesc = call.agentRole === 'subagent'
        ? `${t('session.latestCall.agentSub')}${call.subagentRole ? ` (${call.subagentRole})` : (call.subagentType ? ` (${call.subagentType})` : '')}${call.parentCascadeId ? ` · parent ${String(call.parentCascadeId).slice(0, 8)}` : ''}${call.parentStepIndex != null ? ` · step #${call.parentStepIndex}` : ` · ${t('session.latestCall.missingParentStep')}`}`
        : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
      const fmtDurOrUnk = (v) => (v !== null && v !== undefined) ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(v, currentPanelLanguage) : `${v}s`) : unk;
      const eDetailVal = callEval?.efficiency?.available
        ? `${callEval.efficiency.score} ${currentPanelLanguage === 'en' ? 'pts' : '分'} · ${callEval.efficiency.tier?.title || callEval.efficiency.grade}`
        : (call.eScore != null ? `${call.eScore} (${call.eGrade || '--'})` : (callEval?.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing')));
      const rawIdBadge = call.rawPlaceholderId ? ` (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})` : '';
      const stableIdDisplay = (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId)))
        ? `${call.stableModelId}${rawIdBadge}`
        : ((call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId)))
          ? `${call.modelExactId}${rawIdBadge}`
          : (call.rawPlaceholderId
            ? `${unk} (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})`
            : (call.modelExactId || call.modelKey || unk)));
      const modelAndEffortDisplay = formatProductDisplayWithEffort(modelTitle, call.effort);
      const callStreamDisplay = callEval?.isSampleSparse
        ? `${t('session.speed.shortSampleBadge')}${callEval.shortWindowEstimateSpeed != null ? ` (${t('session.speed.shortWindowEst')}: ${callEval.shortWindowEstimateSpeed} tok/s)` : ''}`
        : ((call.streamingTps ?? call.streamSpeed) != null ? `${call.streamingTps ?? call.streamSpeed} tok/s${callEval?.speedTier ? ` · ${callEval.speedTier.title}` : ''}` : unk);
      const cells = [
        [t('session.latestCall.fieldTime'), formatCallTimeStr(call)],
        [t('session.latestCall.fieldStatus'), st.text],
        [t('session.latestCall.fieldModelId'), stableIdDisplay],
        [t('session.latestCall.fieldModelLabel'), modelAndEffortDisplay],
        [t('session.latestCall.fieldInput'), call.hasInputCacheFields && call.inputTokens !== null ? fmt(call.inputTokens) : unk],
        [t('session.latestCall.fieldCacheRead'), call.hasInputCacheFields && call.cacheReadTokens !== null ? fmt(call.cacheReadTokens) : unk],
        [t('session.latestCall.fieldTotalInput'), call.hasInputCacheFields && call.totalInputTokens !== null ? fmt(call.totalInputTokens) : unk],
        [t('session.latestCall.fieldOutput'), call.outputTokens !== null && call.outputTokens !== undefined
          ? `${fmt(call.outputTokens)}${call.thinkingTokens ? ` (${fmt(call.thinkingTokens)})` : ''}`
          : unk],
        [t('session.latestCall.fieldCacheRatio'), formatCallCachePctText(call)],
        [t('session.latestCall.fieldTtft'), `${fmtDurOrUnk(call.ttftSec)}${call.ttftRatioPct != null ? ` (${call.ttftRatioPct}%)` : ''}${callEval?.ttftTier ? ` · ${callEval.ttftTier.title}` : ''}`],
        [t('session.latestCall.fieldDuration'), `${fmtDurOrUnk(call.durationSec)}${callEval?.durationTier ? ` · ${callEval.durationTier.title}` : ''}`],
        [t('session.speed.streamRate'), callStreamDisplay],
        [t('session.speed.breakdown.overall'), call.tps !== null && call.tps !== undefined ? `${call.tps} tok/s` : unk],
        [t('session.speed.breakdown.eScore'), eDetailVal],
        [t('session.latestCall.fieldAgent'), agentDesc]
      ];
      for (const [k, v] of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        vEl.textContent = v;
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        detailGrid.appendChild(cell);
      }
    }

    if (errorBox) {
      if (call.error || st.cls.includes('pill-danger')) {
        errorBox.hidden = false;
        const reason = call.errorClassification?.reason || '';
        errorBox.textContent = [reason, call.error].filter(Boolean).join(' · ') || st.text;
      } else {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
    }

    if (bodyEl && playAnim && !prefersReducedMotionNow()) {
      if (state.callEnterAnimTimer) {
        clearTimeout(state.callEnterAnimTimer);
        state.callEnterAnimTimer = null;
      }
      bodyEl.classList?.remove?.('is-entering');
      void bodyEl.offsetWidth;
      bodyEl.classList?.add?.('is-entering');
      state.callEnterAnimTimer = setTimeout(() => {
        state.callEnterAnimTimer = null;
        bodyEl.classList?.remove?.('is-entering');
      }, 250);
    }
  }

  function syncLatestCallDetailsVisibility() {
    const det = el('latest-call-details');
    const row = el('latest-call-summary-row');
    if (det) det.style.display = state.latestCallDetailOpen ? 'block' : 'none';
    if (row) row.setAttribute?.('aria-expanded', state.latestCallDetailOpen ? 'true' : 'false');
  }

  function renderLatestCallCard({ fromUserAction = false, skipAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    if (!state.route) {
      card.hidden = true;
      return;
    }

    const incoming = resolveLatestSessionCallRecord();
    const target = state.pinnedCallRecord || incoming;
    if (!target) {
      card.hidden = !state.historyDrawerOpen;
      return;
    }
    card.hidden = false;

    const newBanner = el('latest-call-new-banner');
    if (!fromUserAction && isCallCardReadingProtected(incoming)) {
      if (incoming && (!state.pendingLatestCallRecord || buildCallDisplaySignature(incoming) !== buildCallDisplaySignature(state.pendingLatestCallRecord))) {
        state.pendingLatestCallRecord = incoming;
      }
      if (newBanner) newBanner.hidden = false;
      if (state.pinnedCallRecord && lastCallCardLang !== currentPanelLanguage) {
        applyLatestCallRecordToDom(state.pinnedCallRecord, { playAnim: false });
        lastCallCardLang = currentPanelLanguage;
      }
      syncLatestCallDetailsVisibility();
      return;
    }

    if (newBanner) newBanner.hidden = true;
    state.pendingLatestCallRecord = null;

    const nextSig = buildCallDisplaySignature(target);
    const langChanged = lastCallCardLang !== currentPanelLanguage;
    if (nextSig === state.displayedCallSig && !langChanged) {
      syncLatestCallDetailsVisibility();
      return;
    }

    const hadPrev = Boolean(state.displayedCallRecord);
    const isRealReplacement = hadPrev && nextSig !== state.lastAnimatedCallSig && target.status !== 'streaming';
    const shouldAnimate = !skipAnim && isRealReplacement && nextSig !== state.displayedCallSig;

    state.displayedCallRecord = target;
    state.displayedCallSig = nextSig;
    if (target.status !== 'streaming') {
      state.lastAnimatedCallSig = nextSig;
    }
    lastCallCardLang = currentPanelLanguage;
    applyLatestCallRecordToDom(target, { playAnim: shouldAnimate });
    syncLatestCallDetailsVisibility();
  }

  function renderSessionTimeline() {
    const drawer = el('session-timeline-drawer');
    const toggleBtn = el('btn-session-history-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = state.historyDrawerOpen ? t('session.timeline.hideHistory') : t('session.timeline.viewHistory');
      toggleBtn.setAttribute?.('aria-expanded', state.historyDrawerOpen ? 'true' : 'false');
    }
    if (!drawer) return;
    drawer.style.display = state.historyDrawerOpen ? 'flex' : 'none';
    if (!state.historyDrawerOpen) return;

    const sumEl = el('session-timeline-summary');
    const listEl = el('session-timeline-list');
    const unlinkedEl = el('session-timeline-unlinked');
    const moreWrap = el('session-timeline-more-wrap');
    const moreBtn = el('btn-timeline-load-more');

    if (state.timelineLoading && !state.sessionTimeline) {
      if (sumEl) sumEl.textContent = t('session.timeline.loading');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const tl = state.sessionTimeline;
    if (!tl || (!tl.turns?.length && !tl.unlinkedSubagentCalls?.length)) {
      if (sumEl) sumEl.textContent = state.timelineError ? translateBackendText(state.timelineError) : t('session.timeline.empty');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const turns = Array.isArray(tl.turns) ? tl.turns : [];
    const cacheText = tl.cacheSummary && tl.cacheSummary.cacheStatus !== 'missing'
      ? (tl.cacheSummary.cacheStatus === 'zero_input' ? t('session.latestCall.naVal') : `${tl.cacheSummary.cacheReadPct}%`)
      : t('session.latestCall.unknownVal');
    if (sumEl) {
      sumEl.replaceChildren();
      const sLine = document.createElement('div');
      sLine.textContent = t('session.timeline.summary', {
        turns: turns.length,
        calls: tl.totalCalls || 0,
        main: tl.mainCallsCount || 0,
        sub: tl.subagentCallsCount || 0,
        cache: cacheText
      });
      const noteLine = document.createElement('div');
      noteLine.style.marginTop = '2px';
      noteLine.textContent = t('session.timeline.windowNote');
      sumEl.appendChild(sLine);
      sumEl.appendChild(noteLine);
      if (tl.subagentNote) {
        const dbNoteLine = document.createElement('div');
        dbNoteLine.style.marginTop = '2px';
        dbNoteLine.textContent = t('session.timeline.dbMissingNote', { reason: tl.subagentNote });
        sumEl.appendChild(dbNoteLine);
      }
    }

    if (listEl) {
      const curRouteKey = state.route || '';
      const sameTimelineRoute = state.timelineRenderedRoute === curRouteKey;
      const prevScrollTop = sameTimelineRoute ? Number(listEl.scrollTop || 0) : 0;
      listEl.replaceChildren();
      state.timelineRenderedRoute = curRouteKey;
      const resolveTurnKey = (tObj) => tObj?.turnKey || `turn-${tObj?.turnIndex ?? 'x'}-${tObj?.stepIndex ?? 'na'}`;
      const descTurns = [...turns].reverse();
      if (descTurns.length > 0 && state.timelineAutoExpandedRoute !== curRouteKey) {
        state.timelineAutoExpandedRoute = curRouteKey;
        if (state.expandedTurnKeys.size === 0) {
          state.expandedTurnKeys.add(resolveTurnKey(descTurns[0]));
        }
      }
      const limit = Math.max(5, Number(state.timelinePageLimit) || 10);
      const visibleTurns = descTurns.slice(0, limit);

      const createCallRow = (call) => {
        const row = document.createElement('div');
        const isSelected = state.pinnedCallRecord && state.pinnedCallRecord.callId === call.callId;
        row.className = `timeline-call-row${call.agentRole === 'subagent' ? ' is-subagent' : ''}${isSelected ? ' is-selected' : ''}`;
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const main = document.createElement('div');
        main.className = 'timeline-call-main';
        const roleBadge = document.createElement('span');
        roleBadge.className = `call-agent-badge${call.agentRole === 'subagent' ? ' is-subagent' : (call.attributionConfidence === 'unidentified' ? ' is-unknown' : '')}`;
        roleBadge.textContent = call.agentRole === 'subagent'
          ? (call.subagentType ? `${t('session.latestCall.agentSub')}·${call.subagentType}` : t('session.latestCall.agentSub'))
          : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
        const mName = document.createElement('span');
        mName.className = 'timeline-turn-prompt';
        const baseModelTitle = formatCallModelTitle(call);
        const effortText = call.effort ? String(call.effort).trim() : '';
        const hasEffortParen = effortText && baseModelTitle.trim().toLowerCase().endsWith(`(${effortText.toLowerCase()})`);
        mName.textContent = (effortText && !hasEffortParen) ? `${baseModelTitle} (${effortText})` : baseModelTitle;
        main.appendChild(roleBadge);
        main.appendChild(mName);

        const stats = document.createElement('div');
        stats.className = 'timeline-call-stats';
        const st = resolveCallStatusDisplay(call);
        const inpTxt = call.hasInputCacheFields ? short(call.totalInputTokens) : t('session.latestCall.unknownVal');
        const eTag = (call.eScore != null && call.eGrade)
          ? (currentPanelLanguage === 'en' ? ` · ${call.eScore}pt(${call.eGrade})` : ` · ${call.eScore}分(${call.eGrade})`)
          : '';
        if (currentPanelLanguage === 'en') {
          stats.textContent = `${formatCallTimeStr(call)} · In ${inpTxt}/Out ${short(call.outputTokens || 0)} · Cache ${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        } else if (currentPanelLanguage === 'zh-TW') {
          stats.textContent = `${formatCallTimeStr(call)} · 入${inpTxt}/出${short(call.outputTokens || 0)} · 緩${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        } else {
          stats.textContent = `${formatCallTimeStr(call)} · 入${inpTxt}/出${short(call.outputTokens || 0)} · 缓${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        }

        row.appendChild(main);
        row.appendChild(stats);
        const inspectCall = () => {
          state.pinnedCallRecord = call;
          state.latestCallDetailOpen = true;
          renderLatestCallCard({ fromUserAction: true, skipAnim: false });
          renderSessionTimeline();
        };
        row.addEventListener('click', inspectCall);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspectCall(); }
        });
        return row;
      };

      for (const turn of visibleTurns) {
        const turnKey = resolveTurnKey(turn);
        const isOpen = state.expandedTurnKeys.has(turnKey);
        const cardEl = document.createElement('div');
        cardEl.className = 'timeline-turn-card';

        const hdrBtn = document.createElement('button');
        hdrBtn.type = 'button';
        hdrBtn.className = 'timeline-turn-hdr';
        hdrBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        const left = document.createElement('div');
        left.className = 'timeline-turn-left';
        const idxEl = document.createElement('span');
        idxEl.className = 'timeline-turn-idx';
        idxEl.textContent = t('session.timeline.turnLabel', { n: turn.turnIndex });
        const rawTurnPrompt = turn.preview || turn.userPromptPreview || '';
        const promptText = typeof sanitizeTurnPreviewText === 'function' ? sanitizeTurnPreviewText(rawTurnPrompt, 120) : rawTurnPrompt;
        const promptEl = document.createElement('span');
        promptEl.className = 'timeline-turn-prompt';
        promptEl.textContent = promptText || t('session.timeline.turnNoPrompt');
        if (promptText) promptEl.title = promptText;
        left.appendChild(idxEl);
        left.appendChild(promptEl);

        const metaEl = document.createElement('span');
        metaEl.className = 'timeline-turn-meta';
        metaEl.textContent = t('session.timeline.turnSummary', {
          calls: turn.calls?.length || 0,
          inp: short(turn.inputTokens || 0),
          cap: short(turn.cacheReadTokens || 0),
          out: short(turn.outputTokens || 0)
        });

        hdrBtn.appendChild(left);
        hdrBtn.appendChild(metaEl);
        hdrBtn.addEventListener('click', () => {
          if (state.expandedTurnKeys.has(turnKey)) state.expandedTurnKeys.delete(turnKey);
          else state.expandedTurnKeys.add(turnKey);
          renderSessionTimeline();
        });
        cardEl.appendChild(hdrBtn);

        if (isOpen && Array.isArray(turn.calls)) {
          const bodyEl = document.createElement('div');
          bodyEl.className = 'timeline-turn-body';
          for (const call of turn.calls) {
            bodyEl.appendChild(createCallRow(call));
          }
          cardEl.appendChild(bodyEl);
        }
        listEl.appendChild(cardEl);
      }

      if (moreWrap && moreBtn) {
        const remaining = descTurns.length - visibleTurns.length;
        if (remaining > 0) {
          moreWrap.hidden = false;
          moreBtn.textContent = t('session.timeline.loadMore', { n: remaining });
        } else {
          moreWrap.hidden = true;
        }
      }

      if (unlinkedEl) {
        const unlinked = Array.isArray(tl.unlinkedSubagentCalls) ? tl.unlinkedSubagentCalls : [];
        if (unlinked.length > 0) {
          unlinkedEl.hidden = false;
          unlinkedEl.replaceChildren();
          const uTitle = document.createElement('div');
          uTitle.className = 'session-timeline-unlinked-title';
          uTitle.textContent = t('session.timeline.unlinkedTitle', { n: unlinked.length });
          unlinkedEl.appendChild(uTitle);
          for (const uCall of unlinked) {
            unlinkedEl.appendChild(createCallRow(uCall));
          }
        } else {
          unlinkedEl.hidden = true;
          unlinkedEl.replaceChildren();
        }
      }
      if (prevScrollTop > 0) {
        const maxScroll = Math.max(0, (listEl.scrollHeight || 0) - (listEl.clientHeight || 0));
        listEl.scrollTop = maxScroll > 0 ? Math.min(prevScrollTop, maxScroll) : prevScrollTop;
      }
    }
  }

  async function fetchSessionTimeline(id, { force = false } = {}) {
    if (!id || state.disposed || id !== state.route) return null;
    if (!force && state.timelineLoading) return null;
    const seq = ++timelineFetchSeq;
    const gen = state.generation;
    state.timelineLoading = true;
    state.timelineError = '';
    if (state.historyDrawerOpen) renderSessionTimeline();

    try {
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
      }
      timelineFetchController = typeof AbortController === 'function' ? new AbortController() : null;
      const liveCalls = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
      const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSessionTimeline === 'function';
      let timelineData = null;

      if (hasIpc || hasLiveHttpBridge()) {
        const out = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.getSessionTimeline(id, { force, liveCalls, cascadeModelConfigs: configs }) : null,
          liveRoute: '/session-timeline',
          liveBody: { id, force, liveCalls, cascadeModelConfigs: configs },
          liveFetchOpts: timelineFetchController ? { signal: timelineFetchController.signal } : {}
        });
        const res = out?.result;
        if (res?.ok && res.data) {
          timelineData = res.data;
        } else if (res && !res.ok) {
          state.timelineError = res.error || '';
        }
      } else if (typeof groupSessionCallsByTurns === 'function') {
        timelineData = groupSessionCallsByTurns([], liveCalls, { cascadeId: id, cascadeModelConfigs: configs });
      }

      if (gen !== state.generation || seq !== timelineFetchSeq || state.disposed) return null;
      if (timelineData) {
        state.sessionTimeline = timelineData;
        state.lastTimelineFetchAt = Date.now();
      }
    } catch (e) {
      if (e?.name !== 'AbortError' && gen === state.generation && !state.disposed) {
        state.timelineError = e?.message || String(e || '');
      }
    } finally {
      if (seq === timelineFetchSeq && !state.disposed) {
        state.timelineLoading = false;
        if (state.historyDrawerOpen) renderSessionTimeline();
      }
    }
    return state.sessionTimeline;
  }

  function scheduleLatestCallRefresh({ allowTimelineRefresh = false } = {}) {
    if (state.disposed) return;
    if (allowTimelineRefresh && state.historyDrawerOpen && state.route) {
      const latest = resolveLatestSessionCallRecord();
      const sig = buildCallDisplaySignature(latest);
      if (sig && sig !== state.lastTimelineCallSig && Date.now() - state.lastTimelineFetchAt > 1200) {
        state.lastTimelineCallSig = sig;
        void fetchSessionTimeline(state.route);
      }
    }
    renderLatestCallCard();
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
      syncContextModelSelectionFromState();
      renderLatestCallCard({ skipAnim: true });
      renderSessionTimeline();
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

    const status = disp.isError || disp.kind === 'canceled'
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
        if (keyTakeaway) {
          keyTakeaway.textContent = disp.keyTakeaway;
          const showErrTakeaway = Boolean(disp.isError);
          keyTakeaway.hidden = !showErrTakeaway;
          keyTakeaway.style.display = showErrTakeaway ? '' : 'none';
        }
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
            keyTakeaway.hidden = false;
            keyTakeaway.style.display = '';
          } else if (pct >= 75) {
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
            keyTakeaway.hidden = false;
            keyTakeaway.style.display = '';
          } else {
            keyTakeaway.textContent = t('key.takeaway.ok', { pct: pct.toFixed(1), rem: short(remainVal) });
            keyTakeaway.hidden = true;
            keyTakeaway.style.display = 'none';
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (session?.total ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) {
          keyTakeaway.textContent = t('key.takeaway.est');
          keyTakeaway.hidden = true;
          keyTakeaway.style.display = 'none';
        }
      }
    }

    if (el('speed-summary')) {
      if (typeof evaluateGenerationExperience === 'function') {
        const evalRes = state.lastSpeedEval || evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
        renderSpeedExperienceInPlace(evalRes);
      } else {
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
    scheduleLatestCallRefresh({ allowTimelineRefresh: false });
    if (state.historyDrawerOpen) renderSessionTimeline();
  }

  const MAX_FLUSH_BATCH_CALLS = 500;
  const MAX_FLUSH_BATCH_BYTES = 900 * 1024;
  const MAX_LIVE_RECORD_BODY_BYTES = 1024 * 1024;
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function getUtf8ByteLength(str) {
    const s = String(str ?? '');
    if (utf8Encoder) return utf8Encoder.encode(s).length;
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(s, 'utf8');
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  const getSingleCallBodyBytes = call => 12 + getUtf8ByteLength(JSON.stringify(call));

  const getModelRank = (model, modelKey) => {
    const s = String(model || '').trim();
    if (!s) return 0;
    if (/^model_placeholder_/i.test(s)) return modelKey ? 2 : 1;
    return modelKey ? 3 : 2;
  };

  const getDateRank = call => {
    if (!call) return 0;
    const hasDate = Boolean(call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date)));
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (isProv) return hasDate ? 1 : 0;
    let hasValidCreatedAt = false;
    if (call.created_at) {
      const dt = new Date(call.created_at);
      hasValidCreatedAt = !Number.isNaN(dt.getTime());
    }
    if (call.dateSource === 'transcript' && (hasDate || hasValidCreatedAt)) return 4;
    if (hasValidCreatedAt) return 3;
    if (hasDate) return 2;
    return 0;
  };

  const resolveWatermarkDate = call => {
    if (!call) return '';
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (!isProv && call.created_at) {
      const dt = new Date(call.created_at);
      if (!Number.isNaN(dt.getTime())) return formatLocalYmd(dt);
    }
    return (call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date))) ? String(call.date).slice(0, 10) : '';
  };

  function rawRevIsPresent(val) {
    return val !== null && val !== '';
  }

  const extractSourceRevision = row => {
    if (!row || typeof row !== 'object') return null;
    const raw = row.sourceRevision ?? row.revision ?? row.metadataRevision;
    if (raw !== undefined && rawRevIsPresent(raw)) {
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    const rawUpdated = row.updated_at ?? row.sourceUpdatedAt;
    if (rawUpdated !== undefined && rawRevIsPresent(rawUpdated)) {
      const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };

  const compareSourceRevision = (incRev, baseRev) => {
    const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
    const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
    if (a === null && b === null) return 0;
    if (a !== null && b === null) return 1;
    if (a === null && b !== null) return -1;
    if (a === b) return 0;
    return a > b ? 1 : -1;
  };

  const compareWatermarkUsage = (a, b) => {
    const totDiff = (a?.tot || 0) - (b?.tot || 0);
    if (totDiff !== 0) return totDiff;
    return (a?.out || 0) - (b?.out || 0);
  };

  const canAdoptNextDate = (nextWm, prevWm) => {
    if (!prevWm) return Boolean(nextWm?.date);
    const nextDateRank = nextWm?.dateRank || 0;
    const prevDateRank = prevWm?.dateRank || 0;
    if (nextDateRank > prevDateRank) return Boolean(nextWm?.date);
    if (nextDateRank < prevDateRank) return false;
    if (!nextWm?.date) return false;
    if (!prevWm?.date) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (nextDateRank >= 2) {
      if (revCmp > 0 && usageCmp >= 0) return true;
      if (usageCmp > 0 && revCmp >= 0) return true;
      return nextWm.date === prevWm.date && (nextWm.createdAt || '') === (prevWm.createdAt || '') && revCmp >= 0 && usageCmp >= 0;
    }
    return nextWm.date < prevWm.date;
  };

  const getFinalCallWatermark = call => ({
    inp: call?.inputTokens || 0,
    cap: call?.cacheTokens || 0,
    tot: (call?.inputTokens || 0) + (call?.cacheTokens || 0) + (call?.outputTokens || 0),
    out: call?.outputTokens || 0,
    model: String(call?.model || '').trim(),
    modelKey: String(call?.modelKey || '').trim(),
    isPriced: Boolean(call?.isPriced),
    costUSD: Number(call?.costUSD || 0),
    date: resolveWatermarkDate(call),
    createdAt: call?.created_at ? String(call.created_at) : '',
    dateSource: call?.dateSource ? String(call.dateSource) : '',
    dateRank: getDateRank(call),
    sourceRevision: extractSourceRevision(call)
  });

  function hasWatermarkProgressed(nextWm, prevWm) {
    if (!prevWm) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    if (usageCmp > 0) return true;
    if (getModelRank(nextWm.model, nextWm.modelKey) > getModelRank(prevWm.model, prevWm.modelKey)) return true;
    if (!prevWm.modelKey && Boolean(nextWm.modelKey)) return true;
    if (!prevWm.isPriced && Boolean(nextWm.isPriced)) return true;
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    if (nextDateRank > prevDateRank) return true;
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (!usageRegressed && revCmp > 0) return true;
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    if (
      takeNextDate &&
      nextDateRank >= 2 &&
      nextDateRank === prevDateRank &&
      Boolean(nextWm.date) &&
      (
        nextWm.date !== prevWm.date ||
        (nextDateRank >= 3 && Boolean(nextWm.createdAt) && nextWm.createdAt !== (prevWm.createdAt || ''))
      )
    ) {
      return true;
    }
    const hasUnacceptedDate = Boolean(prevWm.date) && Boolean(nextWm.date) && nextWm.date !== prevWm.date && !takeNextDate;
    if (!usageRegressed && revCmp >= 0 && !hasUnacceptedDate && nextWm.isPriced && !(prevWm.costUSD > 0) && nextWm.costUSD > 0) return true;
    return false;
  }

  function mergeWatermarks(prevWm, nextWm) {
    if (!prevWm) return { ...nextWm };
    const nextRank = getModelRank(nextWm.model, nextWm.modelKey);
    const prevRank = getModelRank(prevWm.model, prevWm.modelKey);
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takeNextUsage = usageCmp > 0 || (usageCmp === 0 && revCmp >= 0);
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const mergedSourceRevision = revCmp >= 0
      ? (nextWm.sourceRevision ?? prevWm.sourceRevision ?? null)
      : (prevWm.sourceRevision ?? null);
    let mergedCost = Math.max(prevWm.isPriced ? (prevWm.costUSD || 0) : 0, nextWm.isPriced ? (nextWm.costUSD || 0) : 0);
    if (!usageRegressed && revCmp >= 0 && nextWm.isPriced && (takeNextDate || nextWm.date === prevWm.date || !prevWm.date)) {
      mergedCost = nextWm.costUSD || 0;
    }
    return {
      inp: takeNextUsage ? (nextWm.inp ?? 0) : (prevWm.inp ?? 0),
      cap: takeNextUsage ? (nextWm.cap ?? 0) : (prevWm.cap ?? 0),
      tot: takeNextUsage ? nextWm.tot : prevWm.tot,
      out: takeNextUsage ? nextWm.out : prevWm.out,
      model: nextRank >= prevRank && nextWm.model ? nextWm.model : prevWm.model,
      modelKey: nextWm.modelKey || prevWm.modelKey || '',
      isPriced: Boolean(prevWm.isPriced || nextWm.isPriced),
      costUSD: mergedCost,
      date: takeNextDate ? nextWm.date : (prevWm.date || nextWm.date || ''),
      createdAt: takeNextDate ? (nextWm.createdAt || '') : (prevWm.createdAt || ''),
      dateSource: takeNextDate ? (nextWm.dateSource || '') : (prevWm.dateSource || ''),
      dateRank: Math.max(prevDateRank, nextDateRank),
      sourceRevision: mergedSourceRevision
    };
  }

  function mergePendingCallData(prevCall, nextCall) {
    if (!prevCall) return nextCall;
    const prevWm = getFinalCallWatermark(prevCall);
    const nextWm = getFinalCallWatermark(nextCall);
    const merged = { ...nextCall };
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takePrevUsage = usageCmp < 0 || (usageCmp === 0 && revCmp < 0);
    if (takePrevUsage) {
      merged.inputTokens = prevCall.inputTokens;
      merged.cacheTokens = prevCall.cacheTokens;
      merged.cacheReadTokens = prevCall.cacheReadTokens;
      merged.outputTokens = prevCall.outputTokens;
      merged.thinkingTokens = prevCall.thinkingTokens;
      merged.responseTokens = prevCall.responseTokens;
      merged.totalTokens = prevCall.totalTokens;
    }
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const takePrevDate = !takeNextDate && Boolean(prevWm.date || (prevWm.dateRank || 0) > (nextWm.dateRank || 0));
    if (takePrevDate) {
      merged.date = prevCall.date;
      merged.created_at = prevCall.created_at;
      if (prevCall.dateSource !== undefined) merged.dateSource = prevCall.dateSource;
      else delete merged.dateSource;
      merged.dateIsProvisional = prevCall.dateIsProvisional;
      if (prevCall.timestamp !== undefined) merged.timestamp = prevCall.timestamp;
    }
    if (revCmp < 0 && prevWm.sourceRevision !== null) {
      merged.sourceRevision = prevWm.sourceRevision;
    } else if (nextWm.sourceRevision !== null) {
      merged.sourceRevision = nextWm.sourceRevision;
    } else {
      delete merged.sourceRevision;
    }
    if (getModelRank(prevWm.model, prevWm.modelKey) > getModelRank(nextWm.model, nextWm.modelKey)) {
      merged.model = prevCall.model;
    }
    if (!nextWm.modelKey && prevWm.modelKey) {
      merged.modelKey = prevCall.modelKey;
    }
    if (typeof calculateRequestApiCost === 'function' && (merged.model || merged.modelKey)) {
      const recalc = calculateRequestApiCost(merged);
      if (recalc.isPriced) {
        merged.modelKey = recalc.modelKey;
        merged.isPriced = true;
        merged.costUSD = recalc.costUSD ?? 0;
      }
    } else if (!nextWm.isPriced && prevWm.isPriced) {
      merged.isPriced = prevCall.isPriced;
      merged.costUSD = prevCall.costUSD;
    } else if (nextWm.isPriced && prevWm.isPriced && (takePrevUsage || takePrevDate) && (prevWm.costUSD || 0) > (nextWm.costUSD || 0)) {
      merged.costUSD = prevCall.costUSD;
    }
    return merged;
  }

  function takeNextPendingBatch(pendingMap) {
    const chunk = [];
    const snap = [];
    let totalBytes = 12; // '{"calls":[]}'
    for (const call of pendingMap.values()) {
      if (chunk.length >= MAX_FLUSH_BATCH_CALLS) break;
      const itemBytes = getUtf8ByteLength(JSON.stringify(call));
      if (12 + itemBytes > MAX_FLUSH_BATCH_BYTES) continue;
      const addedBytes = (chunk.length > 0 ? 1 : 0) + itemBytes;
      if (chunk.length > 0 && totalBytes + addedBytes > MAX_FLUSH_BATCH_BYTES) break;
      chunk.push(call);
      snap.push({ callId: call.callId, wm: getFinalCallWatermark(call) });
      totalBytes += addedBytes;
    }
    return { chunk, snap };
  }

  function commitConfirmedEntries(entries) {
    for (const entry of entries) {
      state.quarantinedOversizeMap?.delete(entry.callId);
      const curSynced = state.syncedFinalMap.get(entry.callId);
      const nextSynced = mergeWatermarks(curSynced, entry.wm);
      state.syncedFinalMap.set(entry.callId, nextSynced);
      const curPending = state.pendingFinalCalls.get(entry.callId);
      if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), nextSynced)) {
        state.pendingFinalCalls.delete(entry.callId);
      }
    }
  }

  const EXPLICIT_OVERSIZE_RE = /\b413\b|payload\s+too\s+large|entity\s+too\s+large|body\s+too\s+large|(?:payload|body|size|record|message|batch|bytes?)\b.*(?:exceeds?|exceeded|over)\b|(?:exceeds?|exceeded|over)\b.*(?:\d+\s*(?:kib|mib|kb|mb|bytes?)|(?:size|payload|body)\s*(?:limit|max))|传输体积超限|体积超限|超出上限|超过.*上限/i;

  function isExplicitOversizeError(recRes) {
    if (!recRes || typeof recRes !== 'object') return false;
    if (recRes.status === 413) return true;
    if (recRes.code === 'PAYLOAD_TOO_LARGE' || recRes.code === 'OVERSIZE' || recRes.phase === 'oversize_guard') return true;
    return EXPLICIT_OVERSIZE_RE.test(String(recRes.error || ''));
  }

  function quarantineOversizedEntry(callId, wm) {
    if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
    const prevQuarantined = state.quarantinedOversizeMap.get(callId);
    state.quarantinedOversizeMap.set(callId, mergeWatermarks(prevQuarantined, wm));
    const curPending = state.pendingFinalCalls.get(callId);
    if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), wm) && getSingleCallBodyBytes(curPending) > MAX_FLUSH_BATCH_BYTES) {
      state.pendingFinalCalls.delete(callId);
    }
  }

  async function flushPendingFinalCalls(triggerSyncEvenIfUnchanged) {
    if (triggerSyncEvenIfUnchanged && state.flushFinalsBusy) {
      state.pendingFlushForceSync = true;
    }
    if (state.flushFinalsBusy || state.disposed || !state.pendingFinalCalls?.size) return;
    if (Date.now() < (state.nextFlushRetryAt || 0)) return;
    state.flushFinalsBusy = true;
    let anySucceeded = false;
    let anyChanged = false;
    let failedDuringLoop = false;
    try {
      while (!state.disposed && state.pendingFinalCalls.size > 0) {
        if (Date.now() < (state.nextFlushRetryAt || 0)) break;
        const { chunk, snap } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!chunk.length) break;
        const recRes = await recordModelCallsRemote(chunk);
        if (state.disposed) break;
        if (recRes?.ok === true) {
          anySucceeded = true;
          if (recRes.changed) anyChanged = true;
          commitConfirmedEntries(snap);
        } else {
          failedDuringLoop = true;
          state.nextFlushRetryAt = Date.now() + (document.hidden ? 15000 : 3000);
          break;
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextOversizeRetryAt || 0)) {
        const oversizedItems = [];
        for (const call of state.pendingFinalCalls.values()) {
          const singleBytes = getSingleCallBodyBytes(call);
          if (singleBytes > MAX_FLUSH_BATCH_BYTES) {
            oversizedItems.push({ call, singleBytes, wm: getFinalCallWatermark(call) });
          }
        }
        for (const item of oversizedItems) {
          if (state.disposed) break;
          if (!state.pendingFinalCalls.has(item.call.callId)) continue;
          const isLiveHttpMode = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls !== 'function' && hasLiveHttpBridge())
            || shouldPreferLiveHost(typeof window?.contextMeterAPI?.recordCalls === 'function', '/record-calls');
          if (isLiveHttpMode && item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 单条调用记录超过实时通道 1MiB 上限 (${item.singleBytes} bytes)，已隔离跳过: ${item.call.callId}`);
            continue;
          }
          const recRes = await recordModelCallsRemote([item.call]);
          if (state.disposed) break;
          if (recRes?.ok === true) {
            anySucceeded = true;
            if (recRes.changed) anyChanged = true;
            state.nextOversizeRetryAt = 0;
            commitConfirmedEntries([{ callId: item.call.callId, wm: item.wm }]);
          } else if ((isLiveHttpMode && (item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES || recRes?.status === 413)) || isExplicitOversizeError(recRes)) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 超大调用记录入账被拒绝，已隔离跳过: ${item.call.callId}`);
          } else {
            failedDuringLoop = true;
            const retryAt = Date.now() + (document.hidden ? 15000 : 3000);
            state.nextOversizeRetryAt = retryAt;
            state.nextFlushRetryAt = retryAt;
            break;
          }
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && (state.nextOversizeRetryAt || 0) > Date.now()) {
        const { chunk: remainingNormal } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!remainingNormal.length) {
          state.nextFlushRetryAt = state.nextOversizeRetryAt;
        }
      }
      if (!state.disposed && anySucceeded) {
        if (!failedDuringLoop && state.pendingFinalCalls.size === 0) {
          state.nextFlushRetryAt = 0;
          state.nextOversizeRetryAt = 0;
        }
        if (triggerSyncEvenIfUnchanged || state.pendingFlushForceSync || anyChanged) {
          state.pendingFlushForceSync = false;
          automaticHistorySyncPending = true;
          syncPendingAutomaticHistory();
        }
        if (typeof scheduleQuotaPostTurnRefresh === 'function') {
          scheduleQuotaPostTurnRefresh();
        }
      }
    } finally {
      state.flushFinalsBusy = false;
      if (anySucceeded && !state.disposed && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextFlushRetryAt || 0)) {
        void flushPendingFinalCalls(true);
      }
    }
  }

  function getRendererCsrfToken() {
    const direct = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage?.getItem?.('agy_session_csrf_token') : null;
      if (typeof stored === 'string' && stored.trim()) return stored.trim();
    } catch { }
    return '';
  }

  async function requestPoll(generation, id) {
    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = getRendererCsrfToken(); if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      if (!state.syncedFinalMap) state.syncedFinalMap = new Map();
      if (!state.pendingFinalCalls) state.pendingFinalCalls = new Map();
      if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
      const wasHydrated = Boolean(state.callsHydrated);
      let hasNewOrProgressedPending = false;
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          const prevSessionCall = state.sessionCallsMap.get(call.callId);
          const prevSynced = state.syncedFinalMap.get(call.callId);
          const prevPending = state.pendingFinalCalls.get(call.callId);
          const prevQuarantined = state.quarantinedOversizeMap.get(call.callId);
          let effectiveCall = (prevSessionCall && call.status === 'final' && prevSessionCall.status === 'final')
            ? mergePendingCallData(prevSessionCall, call)
            : call;
          const isNewLiveObservation = Boolean(
            (wasHydrated && !prevSessionCall) ||
            prevSessionCall?.liveRealtimeConfirmed === true ||
            (state.livePendingRequest && state.livePendingRequest.cascadeId === id && call.callId !== state.livePendingRequest.baselineCallId)
          );
          if (isNewLiveObservation) {
            effectiveCall = {
              ...effectiveCall,
              liveRealtimeConfirmed: true,
              liveObservedAtMs: prevSessionCall?.liveObservedAtMs || Date.now()
            };
          }
          if (prevPending && effectiveCall.status === 'final' && prevPending.status === 'final') {
            effectiveCall = mergePendingCallData(prevPending, effectiveCall);
          }
          if (effectiveCall.status === 'final') {
            if (prevSynced) {
              const effWm0 = getFinalCallWatermark(effectiveCall);
              const uCmp0 = compareWatermarkUsage(effWm0, prevSynced);
              const rCmp0 = compareSourceRevision(effWm0.sourceRevision, prevSynced.sourceRevision);
              const restoreSyncedUsage = (uCmp0 < 0 || (uCmp0 === 0 && rCmp0 < 0)) && prevSynced.inp !== undefined;
              const restoreSyncedDate = (prevSynced.dateRank || 0) >= 2 && Boolean(prevSynced.date) && !canAdoptNextDate(effWm0, prevSynced);
              const restoreSyncedRev = rCmp0 < 0 && prevSynced.sourceRevision !== null && prevSynced.sourceRevision !== undefined;
              if (restoreSyncedUsage || restoreSyncedDate || restoreSyncedRev) {
                effectiveCall = {
                  ...effectiveCall,
                  ...(restoreSyncedUsage ? {
                    inputTokens: prevSynced.inp,
                    cacheTokens: prevSynced.cap,
                    cacheReadTokens: prevSynced.cap,
                    outputTokens: prevSynced.out,
                    totalTokens: prevSynced.tot
                  } : {}),
                  ...(restoreSyncedDate ? {
                    date: prevSynced.date,
                    created_at: prevSynced.createdAt || null,
                    ...(prevSynced.dateSource ? { dateSource: prevSynced.dateSource } : {}),
                    dateIsProvisional: false
                  } : {}),
                  ...(restoreSyncedRev ? { sourceRevision: prevSynced.sourceRevision } : {})
                };
                if (restoreSyncedDate && !prevSynced.dateSource) delete effectiveCall.dateSource;
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
            if (getDateRank(effectiveCall) === 1) {
              let earliestProvDate = effectiveCall.date ? String(effectiveCall.date).slice(0, 10) : '';
              for (const ref of [prevPending, prevSynced, prevQuarantined]) {
                const refRank = ref ? (ref.dateRank !== undefined ? ref.dateRank : getDateRank(ref)) : 0;
                const refDate = ref?.date ? String(ref.date).slice(0, 10) : '';
                if (refRank === 1 && refDate && (!earliestProvDate || refDate < earliestProvDate)) {
                  earliestProvDate = refDate;
                }
              }
              if (earliestProvDate && earliestProvDate !== String(effectiveCall.date || '').slice(0, 10)) {
                effectiveCall = { ...effectiveCall, date: earliestProvDate, created_at: null, dateSource: 'provisional', dateIsProvisional: true };
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
          }
          state.sessionCallsMap.set(call.callId, effectiveCall);
          if (effectiveCall.status === 'final') {
            const wm = getFinalCallWatermark(effectiveCall);
            if (hasWatermarkProgressed(wm, prevSynced)) {
              if (prevQuarantined && !hasWatermarkProgressed(wm, prevQuarantined) && getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                continue;
              }
              const prevPendingWm = prevPending ? getFinalCallWatermark(prevPending) : null;
              const progressedVsPending = hasWatermarkProgressed(wm, prevPendingWm);
              if (progressedVsPending) {
                hasNewOrProgressedPending = true;
                if (getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                  state.nextOversizeRetryAt = 0;
                }
              }
              const notRegressedVsPending = !prevPendingWm || (
                compareWatermarkUsage(wm, prevPendingWm) >= 0 &&
                compareSourceRevision(wm.sourceRevision, prevPendingWm.sourceRevision) >= 0 &&
                canAdoptNextDate(wm, prevPendingWm) &&
                getModelRank(wm.model, wm.modelKey) >= getModelRank(prevPendingWm.model, prevPendingWm.modelKey) &&
                (wm.dateRank || 0) >= (prevPendingWm.dateRank || 0) &&
                (!prevPendingWm.modelKey || Boolean(wm.modelKey)) &&
                (!prevPendingWm.isPriced || Boolean(wm.isPriced))
              );
              if (progressedVsPending || notRegressedVsPending) {
                const nextPendingCall = prevPending ? mergePendingCallData(prevPending, effectiveCall) : effectiveCall;
                state.pendingFinalCalls.set(call.callId, nextPendingCall);
              }
            }
          }
        }
      }
      state.callsHydrated = true;
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c.isPriced ? (c.costUSD || 0) : 0), 0);

      // 清除等待首字计时器（禁止用 1000ms 轮询步进时间戳伪造服务器分块流式间隔，避免误判为“输出平稳”）
      const newestPollCall = state.sessionCalls.length ? state.sessionCalls[state.sessionCalls.length - 1] : null;
      if (newestPollCall) {
        if (state.livePendingRequest && state.livePendingRequest.cascadeId === id) {
          const isNewCall = newestPollCall.callId !== state.livePendingRequest.baselineCallId;
          const gotFirstToken = (newestPollCall.outputTokens || 0) > 0 || newestPollCall.ttftSec != null || newestPollCall.status === 'final';
          if ((isNewCall && gotFirstToken) || (state.count > (state.livePendingRequest.baselineCount || 0) && gotFirstToken) || newestPollCall.error) {
            clearLivePendingRequestWait();
          }
        }
      }

      if (hasNewOrProgressedPending) {
        state.nextFlushRetryAt = 0;
      }
      if (state.pendingFinalCalls.size > 0) {
        void flushPendingFinalCalls(wasHydrated);
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
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally {
      clearTimeout(timeout);
      state.controllers.delete(controller);
      if (generation === state.generation && !state.disposed) {
        state.requestBusy = false;
        const latestRecNow = resolveLatestSessionCallRecord();
        const isStreamingNow = Boolean(latestRecNow && latestRecNow.status === 'streaming');
        const nextDelay = document.hidden ? 15000 : (isStreamingNow ? 1000 : 3000);
        state.requestNext = Date.now() + nextDelay;
        render();
      }
    }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      const hasIpcScan = typeof window !== 'undefined' && typeof window.contextMeterAPI?.scan === 'function';
      if (!hasIpcScan && !hasLiveHttpBridge()) {
        throw new Error('完整重启 Antigravity 后启用附件扫描');
      }
      const controller = new AbortController(); state.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        const out = await callBackendWithPriority({
          ipcCall: hasIpcScan ? () => window.contextMeterAPI.scan(id, force) : null,
          liveRoute: '/scan',
          liveBody: { id, force },
          liveFetchOpts: { signal: controller.signal }
        });
        result = out.result;
      } finally {
        clearTimeout(timeout);
        state.controllers.delete(controller);
      }
      if (generation !== state.generation || state.disposed) return;
      if (result?.data?.abortedStale) return;
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
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = getRendererCsrfToken();
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
    } catch { }
    finally {
      availableModelsFetchInFlight = false;
    }
  }

  // =========================================================================
  // 模块 5: 模型额度看板（ELV-34）—— 顶栏圆环入口、共享池归组、多状态机与定时刷新
  // =========================================================================
  const QUOTA_REFRESH_FG_MS = 60000;
  const QUOTA_REFRESH_BG_MS = 180000;
  const QUOTA_STALE_MS = 180000;
  const QUOTA_ANIM_DURATION_MS = 220;
  const QUOTA_CAL_STORAGE_PREFIX = 'ag_quota_token_cal_v2_';
  const quotaState = {
    accountScopeKey: null,
    collectorVersion: null,
    snapshot: null,
    rawInput: null,
    browsePoolKey: null,
    busy: false,
    lastFetchedAtMs: null,
    lastSuccessAtMs: null,
    nextRefreshAtMs: null,
    error: null,
    errorKind: null,
    consecutiveErrors: 0,
    lastResetRequeryKey: null,
    autoPaused: false
  };
  quotaStateInitialized = true;
  let quotaAutoTimer = null;
  let quotaResetTimer = null;
  let quotaPostTurnTimer = null;
  let quotaFeedbackTimer = null;
  let quotaInFlightPromise = null;
  let quotaAbortController = null;
  const QUOTA_BAR_CHARGE_DURATION_MS = 720;
  let quotaRefreshSpinAnim = null;
  let quotaBarChargeTimer = null;
  let quotaBarChargePlaying = false;
  const quotaAnimRafs = new Set();
  const quotaActiveChargeRefs = new Set();
  const quotaNumAnimState = new WeakMap();
  const quotaNodeRefsMap = new WeakMap();
  let quotaCalibrationScope = null;
  let quotaCalibrationMap = {};
  let quotaLastEstComputeSig = '';
  let quotaCachedEstByKey = null;
  let quotaLastSnapshotSig = null;
  let quotaPendingSmoothAnim = false;
  let quotaBadgeLastHasFraction = false;

  function isQuotaReducedMotion() {
    try {
      return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function clearQuotaBarChargeAnimations() {
    if (quotaBarChargeTimer) {
      clearTimeout(quotaBarChargeTimer);
      quotaBarChargeTimer = null;
    }
    quotaBarChargePlaying = false;
    for (const ref of quotaActiveChargeRefs) {
      if (ref?.track) removeQuotaAttrIfPresent(ref.track, 'data-charging');
      if (ref?.chargeStage) setQuotaHiddenIfChanged(ref.chargeStage, true);
    }
    quotaActiveChargeRefs.clear();
  }

  function triggerQuotaBarsChargeAnimation(targets) {
    if (!Array.isArray(targets) || !targets.length) return false;
    // 动画进行中不堆积或重启多轮播放；减少动态效果下交由静态提示处理
    if (quotaBarChargePlaying || isQuotaReducedMotion()) return false;
    const panelQuotaEl = el('panel-quota');
    if (!panelQuotaEl || panelQuotaEl.hidden) return false;

    const validRefs = [];
    for (const ref of targets) {
      if (ref && ref.chargeEligible && ref.track && ref.chargeStage) {
        validRefs.push(ref);
      }
    }
    if (!validRefs.length) return false;

    for (const ref of validRefs) {
      removeQuotaAttrIfPresent(ref.track, 'data-charging');
      setQuotaHiddenIfChanged(ref.chargeStage, false);
      quotaActiveChargeRefs.add(ref);
    }
    // 仅触发单次整体可见性提交，确保后续 CSS 关键帧从 0% 平滑起播
    if (typeof panelQuotaEl.offsetHeight === 'number') void panelQuotaEl.offsetHeight;
    for (const ref of validRefs) {
      setQuotaAttrIfChanged(ref.track, 'data-charging', 'true');
    }

    quotaBarChargePlaying = true;
    quotaBarChargeTimer = setTimeout(() => {
      clearQuotaBarChargeAnimations();
    }, QUOTA_BAR_CHARGE_DURATION_MS + 30);
    return true;
  }

  function triggerQuotaRefreshIconSpin() {
    if (isQuotaReducedMotion()) return;
    const btn = el('btn-quota-refresh');
    const icon = btn?.querySelector?.('.quota-refresh-icon');
    if (!icon || typeof icon.animate !== 'function') return;
    if (quotaRefreshSpinAnim && quotaRefreshSpinAnim.playState === 'running') return;
    try {
      const anim = icon.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'none' }
      );
      quotaRefreshSpinAnim = anim;
      const clearRef = () => {
        if (quotaRefreshSpinAnim === anim) quotaRefreshSpinAnim = null;
      };
      anim.onfinish = clearRef;
      anim.oncancel = clearRef;
    } catch { }
  }

  function clearQuotaAnimations() {
    for (const rafId of quotaAnimRafs) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    }
    quotaAnimRafs.clear();
    clearQuotaBarChargeAnimations();
    if (quotaRefreshSpinAnim) {
      try { quotaRefreshSpinAnim.cancel(); } catch { }
      quotaRefreshSpinAnim = null;
    }
  }

  function clearQuotaTimers() {
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    if (quotaPostTurnTimer) { clearTimeout(quotaPostTurnTimer); quotaPostTurnTimer = null; }
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    clearQuotaAnimations();
    try { quotaAbortController?.abort?.(); } catch { }
    quotaAbortController = null;
  }

  function loadQuotaCalibrationForScope(scopeKey) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    if (quotaCalibrationScope === clean) return quotaCalibrationMap;
    quotaCalibrationScope = clean;
    quotaCalibrationMap = {};
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') quotaCalibrationMap = parsed;
        }
      }
    } catch { }
    return quotaCalibrationMap;
  }

  function saveQuotaCalibrationForScope(scopeKey, nextMap) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    quotaCalibrationScope = clean;
    quotaCalibrationMap = nextMap && typeof nextMap === 'object' ? nextMap : {};
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`, JSON.stringify(quotaCalibrationMap));
      }
    } catch { }
  }

  // 仅在值实际改变时写入 DOM，避免重复替换 Text 节点或重设属性引发重排与闪烁
  function setQuotaTextIfChanged(node, text) {
    if (!node) return;
    const next = text == null ? '' : String(text);
    if (node.textContent !== next) node.textContent = next;
  }

  function setQuotaHiddenIfChanged(node, hidden) {
    if (!node) return;
    const next = Boolean(hidden);
    if (Boolean(node.hidden) !== next) node.hidden = next;
  }

  function setQuotaAttrIfChanged(node, name, val) {
    if (!node) return;
    const next = String(val);
    if (getChildAttr(node, name) !== next) node.setAttribute(name, next);
  }

  function removeQuotaAttrIfPresent(node, name) {
    if (!node) return;
    if (getChildAttr(node, name) !== null) node.removeAttribute?.(name);
  }

  function setQuotaClassIfChanged(node, cls) {
    if (!node) return;
    const next = String(cls || '');
    if (node.className !== next) node.className = next;
  }

  function hideQuotaRefreshFeedback() {
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    const fb = el('quota-refresh-feedback');
    if (fb) setQuotaHiddenIfChanged(fb, true);
  }

  function showQuotaUpToDateFeedback() {
    const fb = el('quota-refresh-feedback');
    if (!fb) return;
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    setQuotaTextIfChanged(fb, t('quota.refresh.upToDate'));
    setQuotaHiddenIfChanged(fb, false);
    quotaFeedbackTimer = setTimeout(() => {
      quotaFeedbackTimer = null;
      if (!state.disposed && el('quota-refresh-feedback')) {
        setQuotaHiddenIfChanged(el('quota-refresh-feedback'), true);
      }
    }, 1800);
  }

  function computeQuotaVisualSignature(view) {
    if (!view || !Array.isArray(view.pools)) return 'empty';
    const parts = [
      quotaBadgeWindowMode || 'auto',
      view.currentModel?.productKey || '',
      view.activeStatus || '',
      view.badge?.fraction == null ? 'null' : view.badge.fraction.toFixed(4)
    ];
    for (const p of view.pools) {
      const bStr = (p.buckets || []).map(b => `${b.bucketId}:${b.remainingFraction == null ? 'null' : b.remainingFraction.toFixed(4)}:${b.resetAtMs || ''}`).join(',');
      parts.push(`${p.poolKey}=${p.status}=${bStr}`);
    }
    return parts.join('|');
  }

  function formatQuotaNumPctValue(pctVal) {
    if (!Number.isFinite(pctVal)) return '';
    const clamped = Math.max(0, Math.min(100, pctVal));
    if (clamped === 0) return '0%';
    if (clamped > 0 && clamped < 1) return `${Math.max(0.1, Math.round(clamped * 10) / 10)}%`;
    return `${Math.round(clamped)}%`;
  }

  function animateQuotaPercentNode(node, targetFrac, animate, fallbackText = '') {
    if (!node) return;
    const prevState = quotaNumAnimState.get(node) || { rafId: 0, currentPct: null, targetPct: null };
    if (targetFrac == null || !Number.isFinite(Number(targetFrac))) {
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: null, targetPct: null });
      setQuotaTextIfChanged(node, fallbackText);
      return;
    }

    const targetPct = Math.max(0, Math.min(100, Number(targetFrac) * 100));
    const canAnimate = Boolean(
      animate &&
      !isQuotaReducedMotion() &&
      typeof requestAnimationFrame === 'function' &&
      prevState.currentPct !== null &&
      Math.abs(targetPct - prevState.currentPct) >= 0.05
    );

    if (!canAnimate) {
      if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
        return;
      }
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: targetPct, targetPct });
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      return;
    }

    if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
      return;
    }

    if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(prevState.rafId);
      quotaAnimRafs.delete(prevState.rafId);
    }

    const startPct = prevState.currentPct;
    const startTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const animObj = { rafId: 0, currentPct: startPct, targetPct };
    quotaNumAnimState.set(node, animObj);

    const step = (nowTs) => {
      if (state.disposed) {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        return;
      }
      const curNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const rawT = Math.min(1, Math.max(0, (curNow - startTs) / QUOTA_ANIM_DURATION_MS));
      const eased = 1 - Math.pow(1 - rawT, 3);
      const val = startPct + (targetPct - startPct) * eased;
      animObj.currentPct = val;
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(val));
      if (rawT < 1) {
        animObj.rafId = requestAnimationFrame(step);
        quotaAnimRafs.add(animObj.rafId);
      } else {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        animObj.currentPct = targetPct;
        setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      }
    };
    animObj.rafId = requestAnimationFrame(step);
    quotaAnimRafs.add(animObj.rafId);
  }

  function resetQuotaState(opts = {}) {
    clearQuotaTimers();
    if (opts.clearAccountScope !== false) {
      quotaState.accountScopeKey = null;
      quotaCalibrationScope = null;
      quotaCalibrationMap = {};
    }
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    quotaLastSnapshotSig = null;
    quotaPendingSmoothAnim = false;
    quotaBadgeLastHasFraction = false;
    quotaState.snapshot = null;
    quotaState.rawInput = null;
    quotaState.browsePoolKey = null;
    quotaState.busy = false;
    quotaState.lastFetchedAtMs = null;
    quotaState.lastSuccessAtMs = null;
    quotaState.nextRefreshAtMs = null;
    quotaState.error = null;
    quotaState.errorKind = null;
    quotaState.consecutiveErrors = 0;
    quotaState.lastResetRequeryKey = null;
    quotaInFlightPromise = null;
    renderQuotaBoard();
  }

  function refreshQuotaTokenEstimates() {
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    if (!state.disposed && (quotaState.snapshot || quotaState.rawInput)) {
      renderQuotaBoard(Date.now(), { animate: false });
    }
  }

  function handleQuotaAccountSwitch(nextScopeKey, opts = {}) {
    const cleanNext = nextScopeKey ? String(nextScopeKey).trim() : null;
    const prev = quotaState.accountScopeKey;
    const changed = Boolean(cleanNext && prev && cleanNext !== prev);
    if (changed || opts.forceRefresh) {
      resetQuotaState({ clearAccountScope: true });
      if (cleanNext) quotaState.accountScopeKey = cleanNext;
      if (!state.disposed) void syncQuotaFromHost(true);
      return true;
    }
    if (cleanNext && !prev) {
      quotaState.accountScopeKey = cleanNext;
    }
    return false;
  }

  function getQuotaStatusLabelText(statusKey) {
    const keyMap = {
      available: 'quota.state.available',
      low: 'quota.state.low',
      exhausted: 'quota.state.exhausted',
      no_permission: 'quota.state.no_permission',
      stale: 'quota.state.stale',
      error: 'quota.state.error',
      unknown: 'quota.state.unknown'
    };
    return t(keyMap[statusKey] || 'quota.state.unknown');
  }

  function getQuotaShortBadgeText(statusKey) {
    const keyMap = {
      exhausted: 'quota.short.exhausted',
      no_permission: 'quota.short.no_permission',
      error: 'quota.short.error',
      stale: 'quota.short.stale',
      unknown: 'quota.short.unknown'
    };
    return keyMap[statusKey] ? t(keyMap[statusKey]) : '';
  }

  function getQuotaPillClass(statusKey) {
    if (statusKey === 'available') return 'pill-good';
    if (statusKey === 'low' || statusKey === 'stale') return 'pill-warn';
    if (statusKey === 'exhausted' || statusKey === 'error') return 'pill-danger';
    if (statusKey === 'no_permission') return 'pill-info';
    return 'pill-muted';
  }

  function formatQuotaDateTime(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return t('quota.time.unknown');
    const d = new Date(Number(ms));
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mo}-${da} ${hh}:${mi}:${ss}`;
  }

  function formatCountdownMsCompact(ms) {
    if (!Number.isFinite(Number(ms))) return t('quota.time.unknown');
    if (ms <= 0) return '0s';
    const sec = Math.ceil(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (currentPanelLanguage === 'en') {
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m`;
      return `${s}s`;
    }
    const hrUnit = currentPanelLanguage === 'zh-TW' ? '小時' : '小时';
    if (d > 0) return `${d}天${h}${hrUnit}`;
    if (h > 0) return `${h}${hrUnit}${m}分`;
    if (m > 0) return `${m}分`;
    return `${s}秒`;
  }

  function formatQuotaWindowTitle(bucket) {
    if (!bucket) return '';
    if (currentPanelLanguage === 'en') {
      if (bucket.windowKey === '5h') return '5h Window';
      if (bucket.windowKey === 'weekly') return 'Weekly Window';
      if (bucket.windowKey === 'daily') return 'Daily Window';
      return 'Primary Quota';
    }
    if (currentPanelLanguage === 'zh-TW') {
      if (bucket.windowKey === '5h') return '5小時限額';
      if (bucket.windowKey === 'weekly') return '每週限額';
      if (bucket.windowKey === 'daily') return '每日限額';
      return '目前主限額';
    }
    return bucket.windowLabel || '周期限额';
  }

  function getActiveQuotaModelInput() {
    if (activeSessionModelConfirmed && (activeSessionModelKey || activeSessionProductKey)) {
      const cfgList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const activeKeyLower = String(activeSessionModelKey || '').trim().toLowerCase();
      const matched = activeKeyLower ? cfgList.find(c =>
        String(c?.modelId || '').trim().toLowerCase() === activeKeyLower ||
        String(c?.modelOrAlias?.model || '').trim().toLowerCase() === activeKeyLower
      ) : null;
      if (matched) return matched;
      return {
        modelId: activeSessionModelKey || '',
        label: state.latest?.model || activeSessionModelKey || activeSessionProductKey,
        productKey: activeSessionProductKey || ''
      };
    }
    if (state.latest?.modelId || state.latest?.model) {
      return {
        modelId: state.latest.modelId || state.latest.model,
        label: state.latest.model || state.latest.modelId
      };
    }
    return null;
  }

  function attachTokenEstimatesToQuotaView(view, nowMs) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!view || !Array.isArray(view.pools) || !core?.applyQuotaTokenEstimates) return view;
    const scopeKey = quotaState.accountScopeKey || view.accountScopeKey || 'anonymous';
    const usageEvents = Array.isArray(ANTIGRAVITY_TOKEN_DATA.recentModelUsage) ? ANTIGRAVITY_TOKEN_DATA.recentModelUsage : [];
    const coverageStartMs = ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs ?? null;
    const lastEvTs = usageEvents.length ? Number(usageEvents[usageEvents.length - 1]?.ts || 0) : 0;
    const poolSig = view.pools.map(p => `${p.poolKey}:${(p.buckets || []).map(b => `${b.bucketId}=${b.remainingFraction ?? 'n'}`).join(',')}`).join(';');
    const computeSig = `${scopeKey}|${view.fetchedAtMs || 0}|${coverageStartMs ?? 'null'}|${usageEvents.length}|${lastEvTs}|${poolSig}`;

    if (quotaLastEstComputeSig === computeSig && quotaCachedEstByKey) {
      const enrichedPools = view.pools.map(p => {
        const nextBuckets = (p.buckets || []).map(b => {
          const bKey = `${p.poolKey}::${b.bucketId || b.windowKey}`;
          return quotaCachedEstByKey[bKey] ? { ...b, tokenEstimate: quotaCachedEstByKey[bKey] } : b;
        });
        const pb = p.primaryBucket ? (nextBuckets.find(b => b.bucketId === p.primaryBucket.bucketId) || nextBuckets[0] || p.primaryBucket) : (nextBuckets[0] || null);
        return { ...p, buckets: nextBuckets, primaryBucket: pb, tokenEstimate: pb?.tokenEstimate || p.tokenEstimate || null };
      });
      return { ...view, pools: enrichedPools };
    }

    const calMap = loadQuotaCalibrationForScope(scopeKey);
    const applied = core.applyQuotaTokenEstimates(view, {
      accountScopeKey: scopeKey,
      usageEvents,
      historyCoverageStartMs: coverageStartMs,
      calibrationMap: calMap,
      nowMs: view.fetchedAtMs || nowMs
    });
    if (applied?.nextCalibrationMap) {
      saveQuotaCalibrationForScope(scopeKey, applied.nextCalibrationMap);
    }
    const cacheObj = {};
    for (const p of (applied?.snapshot?.pools || [])) {
      for (const b of (p.buckets || [])) {
        cacheObj[`${p.poolKey}::${b.bucketId || b.windowKey}`] = b.tokenEstimate || null;
      }
    }
    quotaLastEstComputeSig = computeSig;
    quotaCachedEstByKey = cacheObj;
    return applied?.snapshot || view;
  }

  function applyQuotaBadgeWindowModeToView(view, core) {
    if (!view || !Array.isArray(view.pools) || !view.pools.length) return view;
    const mode = VALID_QUOTA_WINDOW_MODES.includes(quotaBadgeWindowMode) ? quotaBadgeWindowMode : 'auto';
    const targetPool = (view.currentModel?.poolKey
      ? view.pools.find(p => p.poolKey === view.currentModel.poolKey)
      : null) || view.pools[0] || null;
    if (!targetPool || !Array.isArray(targetPool.buckets) || !targetPool.buckets.length) {
      return { ...view, badge: { ...(view.badge || {}), windowMode: mode, dualBuckets: null } };
    }
    const selFn = typeof selectPrimaryQuotaBucket === 'function' ? selectPrimaryQuotaBucket : core?.selectPrimaryQuotaBucket;
    const pickMode = mode === 'both' ? 'auto' : mode;
    const sel = selFn ? selFn(targetPool.buckets, pickMode) : null;
    const pb = sel?.primaryBucket || targetPool.primaryBucket || targetPool.buckets[0] || null;
    if (pb) {
      targetPool.primaryBucket = pb;
      targetPool.selectionReason = sel?.selectionReason || targetPool.selectionReason;
    }

    const fmtPct = f => (core?.formatQuotaPercentText ? core.formatQuotaPercentText(f) : `${Math.round(Number(f) * 100)}%`);
    let dualBuckets = null;
    const pairFn = typeof resolveQuotaWindowBucketPair === 'function' ? resolveQuotaWindowBucketPair : core?.resolveQuotaWindowBucketPair;
    if (mode === 'both' && pairFn && view.activeStatus !== 'error' && view.activeStatus !== 'no_permission') {
      const pair = pairFn(targetPool.buckets);
      if (pair?.bucket5h && pair?.bucket7d && pair.bucket5h.remainingFraction != null && pair.bucket7d.remainingFraction != null) {
        dualBuckets = [
          { key: '5h', text: `5h ${fmtPct(pair.bucket5h.remainingFraction)}` },
          { key: '7d', text: `7d ${fmtPct(pair.bucket7d.remainingFraction)}` }
        ];
      }
    }

    const nextBadge = { ...(view.badge || {}), windowMode: mode, dualBuckets };
    let nextActiveReset = view.activeReset;
    if (pb && pb.remainingFraction != null && view.activeStatus !== 'error' && view.activeStatus !== 'no_permission') {
      nextBadge.fraction = pb.remainingFraction;
      if (pb.isExhausted || pb.remainingFraction === 0) {
        nextBadge.text = t('quota.short.exhausted');
      } else {
        nextBadge.text = fmtPct(pb.remainingFraction);
      }
      nextBadge.tag = view.syncState === 'stale' ? t('quota.short.stale') : (pb.windowShort || '');
      nextActiveReset = {
        hasResetTime: Boolean(pb.hasResetTime),
        resetTimeIso: pb.resetTimeIso ?? null,
        resetAtMs: pb.resetAtMs ?? null,
        resetTimeText: pb.resetTimeText ?? null,
        countdownText: pb.countdownText ?? null,
        isResetPassed: Boolean(pb.isResetPassed)
      };
    }

    return {
      ...view,
      badge: nextBadge,
      activeReset: nextActiveReset
    };
  }

  function computeEffectiveQuotaView(nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const currentModelInput = getActiveQuotaModelInput();

    // 1. 优先复用 rawInput 通过 buildModelQuotaSnapshot 完整演算（支持测试注入原始响应或本地配置变更）
    if (quotaState.rawInput && core?.buildModelQuotaSnapshot) {
      const built = core.buildModelQuotaSnapshot({
        ...quotaState.rawInput,
        currentModel: currentModelInput,
        browsePoolKey: quotaState.browsePoolKey,
        fetchMeta: {
          fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
          nextRefreshAtMs: quotaState.nextRefreshAtMs,
          staleThresholdMs: QUOTA_STALE_MS,
          error: quotaState.error,
          errorKind: quotaState.errorKind
        },
        nowMs
      });
      return applyQuotaBadgeWindowModeToView(attachTokenEstimatesToQuotaView(built, nowMs), core);
    }

    // 2. 基于主进程返回的标准化 snapshot 重新结合当前会话模型与实时 nowMs 刷新视图状态
    const base = quotaState.snapshot;
    if (!base) {
      const hasErr = Boolean(quotaState.error);
      return {
        schemaVersion: 1,
        syncState: hasErr ? 'error' : 'unknown',
        fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        staleThresholdMs: QUOTA_STALE_MS,
        lastError: quotaState.error,
        errorKind: quotaState.errorKind,
        currentModel: currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId) } : null,
        activeStatus: hasErr ? 'error' : 'unknown',
        activeStatusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown'),
        badge: {
          text: getQuotaShortBadgeText(hasErr ? 'error' : 'unknown'),
          tag: hasErr ? t('quota.retry') : '',
          fraction: null,
          status: hasErr ? 'error' : 'unknown',
          statusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown')
        },
        activeReset: { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false },
        browsePoolKey: quotaState.browsePoolKey,
        planTierName: ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || null,
        pools: []
      };
    }

    const updatedPools = (base.pools || []).map(p => {
      const nextBuckets = (p.buckets || []).map(b => {
        if (!b.resetTimeIso || !core?.formatQuotaResetMeta) return { ...b };
        const rm = core.formatQuotaResetMeta(b.resetTimeIso, nowMs);
        return {
          ...b,
          hasResetTime: rm.hasResetTime,
          resetAtMs: rm.resetAtMs,
          resetTimeText: rm.resetTimeText,
          countdownText: rm.countdownText,
          isResetPassed: rm.isResetPassed
        };
      });
      const pickMode = quotaBadgeWindowMode === 'both' ? 'auto' : quotaBadgeWindowMode;
      const sel = (typeof selectPrimaryQuotaBucket === 'function')
        ? selectPrimaryQuotaBucket(nextBuckets, pickMode)
        : (() => {
            const priced = nextBuckets.filter(b => b.remainingFraction !== null).sort((a, b) => a.remainingFraction - b.remainingFraction);
            return { primaryBucket: priced[0] || nextBuckets[0] || null, selectionReason: priced.length <= 1 ? 'single_window' : 'tighter_window' };
          })();
      const pb = sel.primaryBucket || p.primaryBucket || nextBuckets[0] || null;
      return {
        ...p,
        buckets: nextBuckets,
        primaryBucket: pb,
        selectionReason: sel.selectionReason || p.selectionReason || 'single_window',
        remainingFraction: pb?.remainingFraction ?? p.remainingFraction ?? null,
        percentText: pb?.percentText ?? p.percentText ?? null,
        isExhausted: pb ? Boolean(pb.isExhausted || pb.remainingFraction === 0) : Boolean(p.isExhausted),
        hasResetTime: Boolean(pb?.hasResetTime ?? p.hasResetTime),
        resetTimeIso: pb?.resetTimeIso ?? p.resetTimeIso ?? null,
        resetAtMs: pb?.resetAtMs ?? p.resetAtMs ?? null,
        resetTimeText: pb?.resetTimeText ?? p.resetTimeText ?? null,
        countdownText: pb?.countdownText ?? p.countdownText ?? null,
        isResetPassed: Boolean(pb?.isResetPassed ?? p.isResetPassed)
      };
    });

    // 针对实时切换后的会话模型重新匹配池与模型
    const targetCandidates = currentModelInput
      ? (typeof currentModelInput === 'object'
          ? [currentModelInput.modelId, currentModelInput.modelOrAlias?.model, currentModelInput.label, currentModelInput.model]
          : [String(currentModelInput)]
        ).filter(v => typeof v === 'string' && v.trim())
      : [];
    const targetLowers = targetCandidates.map(v => v.trim().toLowerCase());
    const targetStripped = targetLowers.map(v => v.replace(/^model_/, ''));
    const normFn = core?.normalizeModelLookupName;
    const targetNorms = normFn
      ? [...new Set(targetCandidates.map(v => normFn(v)).filter(Boolean))]
      : [];
    let matchedPool = null;
    let matchedModel = null;
    if (targetLowers.length > 0 || currentModelInput?.productKey) {
      for (const p of updatedPools) {
        for (const m of (p.models || [])) {
          const allIds = [...(m.modelIds || []), ...(m.aliases || [])].map(x => String(x).toLowerCase());
          if (allIds.some(id => targetLowers.includes(id) || targetStripped.includes(id.replace(/^model_/, '')))) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productLabel && targetLowers.includes(m.productLabel.toLowerCase())) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productKey && currentModelInput?.productKey && m.productKey === currentModelInput.productKey) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (normFn && m.productLabel) {
            const mNorm = normFn(m.productLabel);
            if (mNorm && targetNorms.includes(mNorm)) {
              matchedPool = p;
              matchedModel = m;
              break;
            }
          }
        }
        if (matchedPool) break;
      }
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const gKey = core.getSharedQuotaGroupKey(currentModelInput);
        matchedPool = updatedPools.find(p => p.poolKey === gKey) || null;
        if (matchedPool) matchedModel = matchedPool.models?.[0] || null;
      }
    }

    const lastOkMs = quotaState.lastSuccessAtMs ?? base.fetchedAtMs ?? null;
    const ageExpired = lastOkMs !== null && (nowMs - lastOkMs > QUOTA_STALE_MS);
    const anyResetPassed = updatedPools.some(p => p.isResetPassed && p.remainingFraction === 0);
    const hasAnyPool = updatedPools.some(p => p.remainingFraction !== null || p.noPermission);
    let syncState = 'unknown';
    if (!hasAnyPool && quotaState.error) syncState = 'error';
    else if (hasAnyPool && (quotaState.error || ageExpired || anyResetPassed)) syncState = 'stale';
    else if (hasAnyPool) syncState = 'fresh';

    let activeStatus = 'unknown';
    let badgeText = t('quota.short.unknown');
    let badgeTag = '';
    let activeFraction = null;
    let activeReset = { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false };

    if (syncState === 'error') {
      activeStatus = 'error';
      badgeText = t('quota.short.error');
      badgeTag = t('quota.retry');
    } else if (matchedModel?.noPermission || matchedPool?.noPermission) {
      activeStatus = 'no_permission';
      badgeText = t('quota.short.no_permission');
    } else if (matchedPool) {
      activeFraction = matchedPool.remainingFraction;
      activeReset = {
        hasResetTime: matchedPool.hasResetTime,
        resetTimeIso: matchedPool.resetTimeIso,
        resetAtMs: matchedPool.resetAtMs,
        resetTimeText: matchedPool.resetTimeText,
        countdownText: matchedPool.countdownText,
        isResetPassed: matchedPool.isResetPassed
      };
      if (matchedPool.remainingFraction === null) {
        activeStatus = syncState === 'stale' ? 'stale' : 'unknown';
        badgeText = t(syncState === 'stale' ? 'quota.short.stale' : 'quota.short.unknown');
      } else if (matchedPool.isExhausted || matchedPool.remainingFraction === 0) {
        activeStatus = syncState === 'stale' ? 'stale' : 'exhausted';
        badgeText = t('quota.short.exhausted');
        badgeTag = matchedPool.primaryBucket?.windowShort || '';
      } else {
        activeStatus = syncState === 'stale' ? 'stale' : (matchedPool.remainingFraction <= 0.2 ? 'low' : 'available');
        badgeText = core?.formatQuotaPercentText ? core.formatQuotaPercentText(matchedPool.remainingFraction) : matchedPool.percentText;
        badgeTag = syncState === 'stale' ? t('quota.short.stale') : (matchedPool.primaryBucket?.windowShort || '');
      }
    } else if (syncState === 'stale') {
      activeStatus = 'stale';
      badgeText = t('quota.short.stale');
    }

    const baseOut = attachTokenEstimatesToQuotaView({
      ...base,
      syncState,
      fetchedAtMs: lastOkMs,
      nextRefreshAtMs: quotaState.nextRefreshAtMs,
      lastError: quotaState.error,
      errorKind: quotaState.errorKind,
      currentModel: matchedModel
        ? {
          productKey: matchedModel.productKey,
          productLabel: matchedModel.productLabel,
          poolKey: matchedPool.poolKey,
          poolTitle: matchedPool.title,
          noPermission: matchedModel.noPermission,
          unavailabilityReason: matchedModel.unavailabilityReason,
          noticeText: matchedModel.noticeText
        }
        : (currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId), poolKey: null, poolTitle: null } : base.currentModel),
      activeStatus,
      activeStatusLabel: getQuotaStatusLabelText(activeStatus),
      badge: {
        text: badgeText,
        tag: badgeTag,
        fraction: activeFraction,
        status: activeStatus,
        statusLabel: getQuotaStatusLabelText(activeStatus)
      },
      activeReset,
      browsePoolKey: quotaState.browsePoolKey || matchedPool?.poolKey || updatedPools[0]?.poolKey || null,
      pools: updatedPools
    }, nowMs);
    return applyQuotaBadgeWindowModeToView(baseOut, core);
  }

  function formatBucketTokenEstimateLine(est) {
    if (!est || est.estSource === 'unavailable' || est.estSource === 'unknown') return '';
    if (est.estBasis === 'exhausted' || est.estSource === 'exhausted' || est.estRemainingTokens === 0) {
      return t('quota.est.exhausted');
    }
    if (est.estBasis === 'incomplete_samples' || est.estSource === 'incomplete') {
      return t('quota.est.incomplete');
    }
    if (est.estBasis === 'calibration_expired' || est.estSource === 'expired') {
      return t('quota.est.expired');
    }
    if (est.estBasis === 'coverage_incomplete') {
      return t('quota.est.coverageIncomplete');
    }
    if (est.estRemainingTokens != null && est.estRemainingShort) {
      let basisKey = 'quota.est.basisCached';
      if (est.estBasis === 'stale_with_divergence' || est.estSource === 'unreliable_cached') {
        basisKey = 'quota.est.basisStaleDivergence';
      } else if (est.estBasis === 'delta_calibrated' && est.estSource === 'delta') {
        basisKey = 'quota.est.basisDelta';
      } else if (est.estBasis === 'cycle_estimated' && est.estSource === 'cycle') {
        basisKey = 'quota.est.basisCycle';
      }
      const mainPart = t('quota.est.approx', { tokens: est.estRemainingShort });
      const basisPart = t(basisKey);
      const mixedPart = est.mixedPoolModels ? ` (${t('quota.est.mixedModels')})` : '';
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      const usedShort = est.cycleTokensUsed > 0 && core?.formatApproxTokensShort
        ? core.formatApproxTokensShort(est.cycleTokensUsed)
        : null;
      return usedShort
        ? `${mainPart} · ${basisPart}${mixedPart} · ${t('quota.est.cycleUsed', { used: usedShort })}`
        : `${mainPart} · ${basisPart}${mixedPart}`;
    }
    return t('quota.est.waiting');
  }

  function getChildAttr(node, name) {
    if (!node) return null;
    if (typeof node.getAttribute === 'function') return node.getAttribute(name);
    return node.attributes?.[name] ?? null;
  }

  function reconcileQuotaChildOrder(container, desiredNodes) {
    const cur = Array.from(container.children || []);
    const sameOrder = cur.length === desiredNodes.length && cur.every((n, idx) => n === desiredNodes[idx]);
    if (sameOrder) return;
    if (typeof container.removeChild === 'function' && typeof container.insertBefore === 'function') {
      const wantSet = new Set(desiredNodes);
      for (const ch of cur) {
        if (!wantSet.has(ch)) container.removeChild(ch);
      }
      for (let i = 0; i < desiredNodes.length; i++) {
        const node = desiredNodes[i];
        const atIdx = container.children[i] || null;
        if (atIdx !== node) {
          container.insertBefore(node, atIdx);
        }
      }
      return;
    }
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren(...desiredNodes);
    } else {
      if (Array.isArray(container.children)) container.children.length = 0;
      for (const n of desiredNodes) container.appendChild?.(n);
    }
  }

  function renderQuotaBucketsContainer(container, buckets, statusOverride = null, opts = {}) {
    if (!container) return;
    const list = Array.isArray(buckets) ? buckets : [];
    const animate = Boolean(opts.animate);
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    if (!list.length) {
      reconcileQuotaChildOrder(container, []);
      return;
    }

    const existingRows = new Map();
    for (const child of Array.from(container.children || [])) {
      const bKey = getChildAttr(child, 'data-bucket-key');
      if (bKey) existingRows.set(bKey, child);
    }

    const desiredRows = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const bKey = String(b.bucketId || b.windowKey || `b-${i}`);

      let row = existingRows.get(bKey);
      let refs = row ? quotaNodeRefsMap.get(row) : null;

      if (!row || !refs) {
        row = document.createElement('div');
        row.className = 'quota-bucket-row';
        row.setAttribute('data-bucket-key', bKey);

        const meta = document.createElement('div');
        meta.className = 'quota-bucket-meta';

        const nameEl = document.createElement('span');
        nameEl.className = 'quota-bucket-name';

        const valEl = document.createElement('span');
        valEl.className = 'quota-bucket-val';
        const pctEl = document.createElement('span');
        pctEl.className = 'quota-pct-num';
        const resetEl = document.createElement('span');
        resetEl.className = 'quota-reset-span';
        valEl.appendChild(pctEl);
        valEl.appendChild(resetEl);

        meta.appendChild(nameEl);
        meta.appendChild(valEl);

        const track = document.createElement('div');
        track.className = 'quota-bar-track';
        const fillEl = document.createElement('div');
        fillEl.className = 'quota-bar-fill';
        track.appendChild(fillEl);

        // 独立充能动画层：裁剪在真实比例宽度内，绝不归零底层也不填满到 100%
        const chargeStage = document.createElement('div');
        chargeStage.className = 'quota-bar-charge-stage';
        chargeStage.hidden = true;
        const chargeFill = document.createElement('div');
        chargeFill.className = 'quota-bar-charge-fill';
        const chargeSheen = document.createElement('div');
        chargeSheen.className = 'quota-bar-charge-sheen';
        chargeStage.appendChild(chargeFill);
        chargeStage.appendChild(chargeSheen);
        track.appendChild(chargeStage);

        const estEl = document.createElement('div');
        estEl.className = 'quota-bucket-est';
        estEl.hidden = true;

        row.appendChild(meta);
        row.appendChild(track);
        row.appendChild(estEl);
        refs = {
          nameEl,
          pctEl,
          resetEl,
          track,
          fillEl,
          chargeStage,
          chargeFill,
          chargeSheen,
          chargeRef: { track, chargeStage, chargeEligible: false },
          estEl
        };
        quotaNodeRefsMap.set(row, refs);
      }

      const { nameEl, pctEl, resetEl, track, fillEl, chargeStage, chargeRef, estEl } = refs;
      if (nameEl) setQuotaTextIfChanged(nameEl, formatQuotaWindowTitle(b));

      if (pctEl) {
        if (statusOverride === 'no_permission') {
          animateQuotaPercentNode(pctEl, null, false, t('quota.short.no_permission'));
        } else if (b.remainingFraction == null) {
          animateQuotaPercentNode(pctEl, null, false, t('quota.time.unknown'));
        } else {
          animateQuotaPercentNode(pctEl, b.remainingFraction, animate, b.percentText);
        }
      }

      if (resetEl) {
        const resetSuffix = b.hasResetTime
          ? ` · ${b.resetTimeText}${b.countdownText ? ` (${b.isResetPassed ? b.countdownText : formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : ''}`
          : ` · ${t('quota.time.reset')}: ${t('quota.time.unknown')}`;
        setQuotaTextIfChanged(resetEl, resetSuffix);
      }

      if (fillEl) {
        const bStatus = statusOverride || (b.remainingFraction == null
          ? 'unknown'
          : (b.isExhausted || b.remainingFraction === 0 ? 'exhausted' : (b.remainingFraction <= 0.2 ? 'low' : 'available')));
        const scaleVal = b.remainingFraction == null ? 0 : Math.max(0, Math.min(1, b.remainingFraction));
        const scaleStr = scaleVal.toFixed(4);
        const stageWidthStr = `${(scaleVal * 100).toFixed(2)}%`;
        setQuotaAttrIfChanged(fillEl, 'data-status', bStatus);
        if (getChildAttr(fillEl, 'data-fraction') !== scaleStr) {
          fillEl.setAttribute('data-fraction', scaleStr);
          if (typeof fillEl.style?.setProperty === 'function') {
            fillEl.style.setProperty('--quota-scale', scaleStr);
          }
          if (fillEl.style) {
            fillEl.style.transform = `scaleX(${scaleStr})`;
          }
        }
        const chargeEligible = Boolean(
          statusOverride !== 'no_permission' &&
          bStatus !== 'no_permission' &&
          bStatus !== 'unknown' &&
          b.remainingFraction != null &&
          Number.isFinite(Number(b.remainingFraction)) &&
          scaleVal > 0
        );
        if (chargeStage) {
          setQuotaAttrIfChanged(chargeStage, 'data-status', bStatus);
          if (getChildAttr(chargeStage, 'data-fraction') !== scaleStr) {
            chargeStage.setAttribute('data-fraction', scaleStr);
            if (chargeStage.style) {
              chargeStage.style.width = stageWidthStr;
            }
          }
        }
        if (track) {
          setQuotaAttrIfChanged(track, 'data-charge-eligible', chargeEligible ? 'true' : 'false');
          if (!chargeEligible) {
            removeQuotaAttrIfPresent(track, 'data-charging');
            if (chargeStage) setQuotaHiddenIfChanged(chargeStage, true);
            if (chargeRef) quotaActiveChargeRefs.delete(chargeRef);
          }
        }
        if (chargeRef) {
          chargeRef.chargeEligible = chargeEligible;
          if (chargeEligible && Array.isArray(opts.chargeTargets)) {
            opts.chargeTargets.push(chargeRef);
          }
        }
      }

      if (estEl) {
        const estText = statusOverride === 'no_permission' ? '' : formatBucketTokenEstimateLine(b.tokenEstimate);
        if (estText) {
          setQuotaHiddenIfChanged(estEl, false);
          setQuotaTextIfChanged(estEl, estText);
        } else {
          setQuotaHiddenIfChanged(estEl, true);
          setQuotaTextIfChanged(estEl, '');
        }
      }
      desiredRows.push(row);
    }

    reconcileQuotaChildOrder(container, desiredRows);
  }

  function renderQuotaBoard(nowMs = Date.now(), renderOpts = {}) {
    const viewQuotaBody = el('view-quota');
    const savedScrollTop = (viewQuotaBody && typeof viewQuotaBody.scrollTop === 'number') ? viewQuotaBody.scrollTop : null;
    const view = computeEffectiveQuotaView(nowMs);
    const currentSig = computeQuotaVisualSignature(view);
    const chargeBarTargets = renderOpts.chargeBars ? [] : null;
    const shouldAnimate = Boolean(
      renderOpts.animate !== undefined
        ? renderOpts.animate
        : (quotaPendingSmoothAnim && quotaLastSnapshotSig !== null && currentSig !== quotaLastSnapshotSig)
    );
    if (renderOpts.consumeAnim !== false && quotaPendingSmoothAnim) {
      quotaPendingSmoothAnim = false;
    }
    quotaLastSnapshotSig = currentSig;

    // 1. 渲染顶栏圆环入口与窄屏溢出菜单项（不只靠颜色，必含数值/状态短文本）
    const bQuota = el('badge-quota');
    const qFill = el('quota-ring-fill');
    const qVal = el('quota-badge-val');
    const qTag = el('quota-badge-tag');
    const qDual = el('quota-badge-dual');
    const oQuotaVal = el('overflow-quota-val');

    if (bQuota) {
      setQuotaAttrIfChanged(bQuota, 'data-quota-state', view.activeStatus || 'unknown');
      const tipModel = view.currentModel?.productLabel || t('quota.current.unmatched');
      const matchedPoolObj = (view.pools || []).find(p => p.poolKey === view.currentModel?.poolKey) || null;
      const reasonMap = {
        tighter_window: currentPanelLanguage === 'en' ? 'tightest window' : (currentPanelLanguage === 'zh-TW' ? '最緊縮視窗優先' : '最紧缩窗口优先'),
        tie_window: currentPanelLanguage === 'en' ? '5h priority on tie' : (currentPanelLanguage === 'zh-TW' ? '同餘量優先短視窗' : '同余量优先短窗口'),
        single_window: currentPanelLanguage === 'en' ? 'single window' : (currentPanelLanguage === 'zh-TW' ? '單一限額視窗' : '单一限额窗口'),
        user_5h: t('quota.modeTag.5h'),
        user_weekly: t('quota.modeTag.weekly')
      };
      const winLines = (matchedPoolObj?.buckets || []).map(b => {
        const wTag = b.windowShort || formatQuotaWindowTitle(b);
        const wReset = b.hasResetTime ? `${b.resetTimeText} (${formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : t('quota.time.unknown');
        return `${wTag}: ${b.percentText || t('quota.time.unknown')} (${wReset})`;
      });
      const selNote = matchedPoolObj?.primaryBucket
        ? `${matchedPoolObj.primaryBucket.windowShort || formatQuotaWindowTitle(matchedPoolObj.primaryBucket)} · ${reasonMap[matchedPoolObj.selectionReason] || ''}`
        : '';
      const modeTag = t(`quota.modeTag.${quotaBadgeWindowMode}`);
      const updatedStr = view.fetchedAtMs ? new Date(view.fetchedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('quota.time.unknown');
      const poolHeader = matchedPoolObj?.title ? ` · ${matchedPoolObj.title}` : '';
      const tipReset = view.activeReset?.hasResetTime
        ? `${view.activeReset.resetTimeText} (${formatCountdownMsCompact((view.activeReset.resetAtMs || 0) - nowMs)})`
        : t('quota.time.unknown');
      const nextTitle = [
        `${tipModel}${poolHeader} · ${view.activeStatusLabel} (${view.badge.text})${selNote ? ` [${selNote}]` : ''} · [${modeTag}]`,
        winLines.length ? winLines.join(' | ') : `${t('quota.time.reset')}: ${tipReset}`,
        `${currentPanelLanguage === 'en' ? 'Updated' : '更新'}: ${updatedStr}`
      ].filter(Boolean).join('\n');
      if (bQuota.title !== nextTitle) bQuota.title = nextTitle;
      setQuotaAttrIfChanged(bQuota, 'aria-label', `${t('badge.quota.aria')}: ${view.badge.text} (${view.activeStatusLabel})`);
    }
    if (qFill) {
      if (view.badge.fraction == null) {
        const nextDash = view.activeStatus === 'unknown' ? '10 30.84' : `0 ${RING_CIRCUMFERENCE.toFixed(2)}`;
        setQuotaAttrIfChanged(qFill, 'stroke-dasharray', nextDash);
        setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', '0');
        quotaBadgeLastHasFraction = false;
      } else {
        const clampedFrac = Math.max(0, Math.min(1, view.badge.fraction));
        const offsetStr = (RING_CIRCUMFERENCE * (1 - clampedFrac)).toFixed(2);
        const dashStr = `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
        if (!quotaBadgeLastHasFraction && qFill.style && typeof qFill.getBoundingClientRect === 'function') {
          qFill.style.transition = 'none';
          qFill.setAttribute('stroke-dasharray', dashStr);
          qFill.setAttribute('stroke-dashoffset', offsetStr);
          qFill.getBoundingClientRect();
          qFill.style.transition = '';
        } else {
          setQuotaAttrIfChanged(qFill, 'stroke-dasharray', dashStr);
          setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', offsetStr);
        }
        quotaBadgeLastHasFraction = true;
      }
    }
    const useDualDisplay = quotaBadgeWindowMode === 'both'
      && state.layoutMode !== 'compact'
      && Array.isArray(view.badge.dualBuckets)
      && view.badge.dualBuckets.length === 2;
    if (bQuota) {
      if (useDualDisplay) bQuota.setAttribute?.('data-quota-dual', 'true');
      else bQuota.removeAttribute?.('data-quota-dual');
    }
    if (useDualDisplay && qDual) {
      if (qVal) setQuotaHiddenIfChanged(qVal, true);
      if (qTag) setQuotaHiddenIfChanged(qTag, true);
      setQuotaHiddenIfChanged(qDual, false);
      const line0 = qDual.children?.[0] || document.createElement('span');
      line0.className = 'quota-dual-line';
      line0.textContent = view.badge.dualBuckets[0].text;
      const line1 = qDual.children?.[1] || document.createElement('span');
      line1.className = 'quota-dual-line is-secondary';
      line1.textContent = view.badge.dualBuckets[1].text;
      if (qDual.children?.length !== 2) {
        qDual.replaceChildren?.();
        qDual.appendChild?.(line0);
        qDual.appendChild?.(line1);
      }
    } else {
      if (qDual) setQuotaHiddenIfChanged(qDual, true);
      if (qVal) {
        setQuotaHiddenIfChanged(qVal, false);
        const hasNumericPct = view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error' && view.badge.fraction != null;
        if (hasNumericPct) {
          animateQuotaPercentNode(qVal, view.badge.fraction, shouldAnimate, view.badge.text);
          if (!shouldAnimate) {
            setQuotaTextIfChanged(qVal, view.badge.text);
          }
        } else {
          let dispVal = view.badge.text;
          if (view.activeStatus === 'exhausted') dispVal = t('quota.short.exhausted');
          else if (view.activeStatus === 'no_permission') dispVal = t('quota.short.no_permission');
          else if (view.activeStatus === 'error') dispVal = t('quota.short.error');
          else if (view.activeStatus === 'unknown' || view.badge.fraction == null) {
            dispVal = view.activeStatus === 'stale' ? t('quota.short.stale') : (view.badge.text || t('quota.short.unknown'));
          }
          animateQuotaPercentNode(qVal, null, false, dispVal);
          setQuotaTextIfChanged(qVal, dispVal);
        }
      }
      if (qTag) {
        let dispTag = view.badge.tag;
        if (view.activeStatus === 'error') dispTag = t('quota.retry');
        else if (view.activeStatus === 'stale' && view.badge.fraction != null) dispTag = t('quota.short.stale');
        if (dispTag) {
          setQuotaHiddenIfChanged(qTag, false);
          setQuotaTextIfChanged(qTag, dispTag);
        } else {
          setQuotaHiddenIfChanged(qTag, true);
          setQuotaTextIfChanged(qTag, '');
        }
      }
    }
    if (oQuotaVal) {
      const dispTxt = useDualDisplay
        ? view.badge.dualBuckets.map(b => b.text).join(' / ')
        : (view.badge.fraction != null && view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error'
          ? view.badge.text
          : (qVal ? qVal.textContent : view.badge.text));
      const dispTag = (!useDualDisplay && qTag && !qTag.hidden) ? qTag.textContent : '';
      setQuotaTextIfChanged(oQuotaVal, dispTag ? `${dispTxt} · ${dispTag}` : dispTxt);
    }

    // 2. 刷新按钮与横幅渲染（请求中维持现有文字、宽度与卡片数据，避免闪烁与布局抽动）
    const btnRefresh = el('btn-quota-refresh');
    const txtRefresh = el('quota-refresh-text');
    if (btnRefresh) {
      if (Boolean(btnRefresh.disabled) !== Boolean(quotaState.busy)) {
        btnRefresh.disabled = Boolean(quotaState.busy);
      }
      setQuotaAttrIfChanged(btnRefresh, 'data-busy', quotaState.busy ? 'true' : 'false');
    }
    if (txtRefresh) {
      setQuotaTextIfChanged(txtRefresh, t('quota.refresh.btn'));
    }

    const tierPill = el('quota-plan-tier-pill');
    if (tierPill) {
      const tierTxt = view.planTierName || ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || '';
      if (tierTxt && tierTxt !== '未知') {
        setQuotaHiddenIfChanged(tierPill, false);
        setQuotaTextIfChanged(tierPill, tierTxt);
      } else {
        setQuotaHiddenIfChanged(tierPill, true);
      }
    }

    const bannerEl = el('quota-banner');
    const bannerTextEl = el('quota-banner-text');
    const bannerRetryBtn = el('btn-quota-banner-retry');
    const bannerRestartBtn = el('btn-quota-banner-restart');
    if (bannerEl && bannerTextEl) {
      const currentVer = METER_RENDERER_VERSION;
      const isBridgeMissing = quotaState.errorKind === 'bridge_unavailable';
      const observedBackendVer = backendStatus.backendVersion || quotaState.collectorVersion || null;
      const isStaleCollectorAfterUpdate = Boolean(
        pendingUpdateRestart &&
        (!quotaState.collectorVersion || quotaState.collectorVersion !== currentVer) &&
        (Boolean(quotaState.error) || view.activeStatus === 'no_permission' || view.activeStatus === 'unknown')
      );
      const isExplicitBackendMismatch = Boolean(
        !isBridgeMissing &&
        !isStaleCollectorAfterUpdate &&
        observedBackendVer &&
        observedBackendVer !== currentVer &&
        (backendStatus.hotReloadFallback || pendingUpdateRestart || backendStatus.backendVersionMismatch)
      );
      const needsRestartAction = isBridgeMissing || isStaleCollectorAfterUpdate || isExplicitBackendMismatch;
      if (bannerRestartBtn) {
        setQuotaHiddenIfChanged(bannerRestartBtn, !(needsRestartAction && hostSupportsRestart));
      }
      if (bannerRetryBtn) {
        setQuotaHiddenIfChanged(bannerRetryBtn, isBridgeMissing);
      }

      if (isBridgeMissing) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.bridgeMissing')
          : `${t('quota.bridgeMissing')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isStaleCollectorAfterUpdate) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.pendingRestartBanner')
          : `${t('quota.pendingRestartBanner')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isExplicitBackendMismatch) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const baseMsg = t('quota.backendMismatchBanner', {
          uiVer: currentVer,
          backendVer: `v${observedBackendVer}`,
          source: backendStatus.backendSource || 'host'
        });
        const msg = hostSupportsRestart ? baseMsg : `${baseMsg} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (view.syncState === 'error' && view.lastError) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'error');
        setQuotaTextIfChanged(bannerTextEl, t('quota.errorBanner', { reason: view.lastError }));
      } else if (view.syncState === 'stale') {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const staleReason = view.lastError
          || (view.pools.some(p => p.isResetPassed && p.remainingFraction === 0) ? t('quota.resetPassReason') : t('quota.ageExpiredReason'));
        setQuotaTextIfChanged(bannerTextEl, t('quota.staleBanner', { reason: staleReason }));
      } else {
        setQuotaHiddenIfChanged(bannerEl, true);
      }
    }

    // 三时间分列渲染：数据更新时间 / 下次自动刷新 / 当前额度重置
    const tUpd = el('quota-time-updated');
    const tNext = el('quota-time-next');
    const tReset = el('quota-time-reset');
    if (tUpd) {
      const updStr = formatQuotaDateTime(view.fetchedAtMs);
      setQuotaTextIfChanged(tUpd, updStr);
      if (tUpd.title !== updStr) tUpd.title = updStr;
    }
    if (tNext) {
      const prevNextText = String(tNext.textContent || '').trim();
      const hasValidNextText = Boolean(prevNextText && prevNextText !== '—' && prevNextText !== t('quota.time.unknown') && prevNextText !== t('quota.refresh.busy'));
      let nextStr = null;
      if (quotaState.busy) {
        if (!hasValidNextText) nextStr = t('quota.refresh.busy');
      } else if (quotaState.autoPaused) {
        nextStr = t('quota.time.paused');
      } else if (Number.isFinite(Number(quotaState.nextRefreshAtMs))) {
        const nextDiff = quotaState.nextRefreshAtMs - nowMs;
        if (nextDiff > 0) {
          nextStr = `${formatQuotaDateTime(quotaState.nextRefreshAtMs).slice(6)} (${formatCountdownMsCompact(nextDiff)})`;
        } else if (!hasValidNextText) {
          nextStr = t('quota.refresh.busy');
        }
      } else {
        nextStr = t('quota.time.unknown');
      }
      if (nextStr !== null) {
        setQuotaTextIfChanged(tNext, nextStr);
        if (tNext.title !== nextStr) tNext.title = nextStr;
      }
    }
    if (tReset) {
      let resetStr = t('quota.time.unknown');
      if (view.activeReset?.hasResetTime) {
        const diffText = view.activeReset.isResetPassed
          ? t('quota.resetPassReason')
          : formatCountdownMsCompact((view.activeReset.resetAtMs || 0) - nowMs);
        resetStr = `${view.activeReset.resetTimeText} (${diffText})`;
      }
      setQuotaTextIfChanged(tReset, resetStr);
      if (tReset.title !== resetStr) tReset.title = resetStr;
    }

    // 当前会话模型概览卡片
    const curModelEl = el('quota-cur-model');
    const curPoolEl = el('quota-cur-pool');
    const curEstEl = el('quota-cur-est');
    const curStatusEl = el('quota-cur-status');
    const curAlertEl = el('quota-cur-alert');
    const curBucketsEl = el('quota-cur-buckets');

    const matchedPoolObj = view.pools.find(p => p.poolKey === view.currentModel?.poolKey);

    if (curModelEl) {
      setQuotaTextIfChanged(curModelEl, view.currentModel?.productLabel || t('quota.current.unmatched'));
    }
    if (curPoolEl) {
      setQuotaTextIfChanged(curPoolEl, view.currentModel?.poolTitle ? `${view.currentModel.poolTitle}` : '');
    }
    if (curEstEl) {
      const curEstText = !view.currentModel?.noPermission && matchedPoolObj?.primaryBucket?.tokenEstimate
        ? formatBucketTokenEstimateLine(matchedPoolObj.primaryBucket.tokenEstimate)
        : '';
      if (curEstText) {
        setQuotaHiddenIfChanged(curEstEl, false);
        setQuotaTextIfChanged(curEstEl, curEstText);
      } else {
        setQuotaHiddenIfChanged(curEstEl, true);
        setQuotaTextIfChanged(curEstEl, '');
      }
    }
    if (curStatusEl) {
      setQuotaClassIfChanged(curStatusEl, `key-pill ${getQuotaPillClass(view.activeStatus)}`);
      setQuotaTextIfChanged(curStatusEl, getQuotaStatusLabelText(view.activeStatus));
    }
    if (curAlertEl) {
      if (view.currentModel?.noPermission && view.currentModel?.unavailabilityReason) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'noperm');
        setQuotaTextIfChanged(curAlertEl, view.currentModel.unavailabilityReason);
      } else if (
        view.currentModel?.noticeText &&
        !/^(?:new|beta|preview|updated|notice|recommended)$/i.test(String(view.currentModel.noticeText).trim())
      ) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'notice');
        setQuotaTextIfChanged(curAlertEl, `Notice: ${view.currentModel.noticeText}`);
      } else {
        setQuotaHiddenIfChanged(curAlertEl, true);
      }
    }
    if (curBucketsEl) {
      renderQuotaBucketsContainer(
        curBucketsEl,
        matchedPoolObj?.buckets || [],
        view.currentModel?.noPermission ? 'no_permission' : null,
        { animate: shouldAnimate, nowMs, chargeTargets: view.currentModel?.noPermission ? null : chargeBarTargets }
      );
    }

    // 共享额度池列表（原地复用已有 DOM 卡片，禁止整块摧毁重排，兼顾轻量 mock DOM）
    const listEl = el('quota-pools-list');
    if (listEl) {
      if (!view.pools.length) {
        let emptyEl = Array.from(listEl.children || []).find(ch => String(ch.className || '').includes('quota-pools-empty-state')) || null;
        if (!emptyEl) {
          emptyEl = document.createElement('div');
          emptyEl.className = 'quota-pools-empty-state';
          if (emptyEl.style) emptyEl.style.cssText = 'font-size:11px;color:var(--ag-text-muted);padding:10px;text-align:center;border:1px dashed var(--ag-border-subcard);border-radius:7px';
        }
        setQuotaTextIfChanged(emptyEl, t('quota.pools.empty'));
        reconcileQuotaChildOrder(listEl, [emptyEl]);
      } else {
        const existingCards = new Map();
        for (const ch of Array.from(listEl.children || [])) {
          const pk = getChildAttr(ch, 'data-pool-key');
          if (pk) existingCards.set(pk, ch);
        }

        const desiredCards = [];
        for (let pIdx = 0; pIdx < view.pools.length; pIdx++) {
          const pool = view.pools[pIdx];
          const isCurrentPool = Boolean(view.currentModel?.poolKey && pool.poolKey === view.currentModel.poolKey);
          const isBrowsing = Boolean(view.browsePoolKey && pool.poolKey === view.browsePoolKey);

          let card = existingCards.get(pool.poolKey);
          let refs = card ? quotaNodeRefsMap.get(card) : null;

          if (!card || !refs) {
            card = document.createElement('div');
            card.className = 'quota-pool-card';
            card.setAttribute('data-pool-key', pool.poolKey);
            card.addEventListener('click', () => {
              quotaState.browsePoolKey = pool.poolKey;
              renderQuotaBoard(Date.now(), { animate: false });
            });

            const top = document.createElement('div');
            top.className = 'quota-pool-top';
            const titleEl = document.createElement('div');
            titleEl.className = 'quota-pool-title';
            const tagsEl = document.createElement('div');
            tagsEl.className = 'quota-pool-tags';
            const curTagEl = document.createElement('span');
            curTagEl.className = 'quota-current-tag';
            curTagEl.hidden = true;
            const stPill = document.createElement('span');
            stPill.className = 'key-pill quota-pool-status-pill';
            tagsEl.appendChild(curTagEl);
            tagsEl.appendChild(stPill);
            top.appendChild(titleEl);
            top.appendChild(tagsEl);

            const reasonEl = document.createElement('div');
            reasonEl.className = 'quota-pool-reason';
            if (reasonEl.style) reasonEl.style.cssText = 'font-size:10.5px;color:var(--ag-text-muted);margin-bottom:4px';
            reasonEl.hidden = true;

            const bucketsBox = document.createElement('div');
            bucketsBox.className = 'quota-buckets-list';

            const chipsBox = document.createElement('div');
            chipsBox.className = 'quota-models-chips';

            card.appendChild(top);
            card.appendChild(reasonEl);
            card.appendChild(bucketsBox);
            card.appendChild(chipsBox);
            refs = { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox };
            quotaNodeRefsMap.set(card, refs);
          }

          const { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox } = refs;

          if (isCurrentPool) setQuotaAttrIfChanged(card, 'data-active-current', 'true');
          else removeQuotaAttrIfPresent(card, 'data-active-current');
          if (isBrowsing) setQuotaAttrIfChanged(card, 'data-browsing', 'true');
          else removeQuotaAttrIfPresent(card, 'data-browsing');

          if (titleEl) setQuotaTextIfChanged(titleEl, pool.title);
          if (curTagEl) {
            if (isCurrentPool) {
              setQuotaHiddenIfChanged(curTagEl, false);
              setQuotaTextIfChanged(curTagEl, t('quota.current.tag'));
            } else {
              setQuotaHiddenIfChanged(curTagEl, true);
            }
          }
          if (stPill) {
            const pStatus = pool.noPermission ? 'no_permission' : (pool.status || 'unknown');
            setQuotaClassIfChanged(stPill, `key-pill quota-pool-status-pill ${getQuotaPillClass(pStatus)}`);
            const pctStr = !pool.noPermission && pool.percentText && pool.percentText !== '未知' ? ` · ${pool.percentText}` : '';
            setQuotaTextIfChanged(stPill, `${getQuotaStatusLabelText(pStatus)}${pctStr}`);
          }

          if (pool.noPermission && pool.unavailabilityReason) {
            if (reasonEl) {
              setQuotaHiddenIfChanged(reasonEl, false);
              setQuotaTextIfChanged(reasonEl, pool.unavailabilityReason);
            }
            if (bucketsBox) {
              setQuotaHiddenIfChanged(bucketsBox, true);
              renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
            }
          } else {
            if (reasonEl) setQuotaHiddenIfChanged(reasonEl, true);
            if (bucketsBox) {
              if (pool.buckets && pool.buckets.length) {
                setQuotaHiddenIfChanged(bucketsBox, false);
                renderQuotaBucketsContainer(bucketsBox, pool.buckets, null, { animate: shouldAnimate, nowMs, chargeTargets: chargeBarTargets });
              } else {
                setQuotaHiddenIfChanged(bucketsBox, true);
                renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
              }
            }
          }

          if (chipsBox) {
            const modelsList = Array.isArray(pool.models) ? pool.models : [];
            if (!modelsList.length) {
              setQuotaHiddenIfChanged(chipsBox, true);
            } else {
              setQuotaHiddenIfChanged(chipsBox, false);
              const chipsSig = modelsList.map(m => `${m.productKey}:${m.productLabel}:${(m.efforts || []).join('/')}:${m.noPermission ? 1 : 0}:${m.noticeText || ''}:${view.currentModel?.productKey === m.productKey ? 1 : 0}:${t('quota.short.no_permission')}`).join(';');
              if (getChildAttr(chipsBox, 'data-chips-sig') !== chipsSig) {
                chipsBox.setAttribute('data-chips-sig', chipsSig);
                const chipNodes = [];
                for (const m of modelsList) {
                  const chip = document.createElement('span');
                  chip.className = 'quota-model-chip';
                  if (view.currentModel?.productKey && m.productKey === view.currentModel.productKey) {
                    chip.setAttribute('data-current-model', 'true');
                  }
                  const lbl = document.createElement('span');
                  lbl.textContent = m.productLabel;
                  chip.appendChild(lbl);
                  if (m.efforts && m.efforts.length) {
                    const ef = document.createElement('span');
                    ef.className = 'quota-chip-efforts';
                    ef.textContent = `(${m.efforts.join('/')})`;
                    chip.appendChild(ef);
                  }
                  if (m.noPermission) {
                    const np = document.createElement('span');
                    np.className = 'quota-chip-noperm';
                    np.textContent = t('quota.short.no_permission');
                    chip.appendChild(np);
                  } else if (m.noticeText) {
                    const nt = document.createElement('span');
                    nt.className = 'quota-chip-notice';
                    nt.title = m.noticeText;
                    nt.textContent = m.noticeTitle || 'Notice';
                    chip.appendChild(nt);
                  }
                  chipNodes.push(chip);
                }
                reconcileQuotaChildOrder(chipsBox, chipNodes);
              }
            }
          }
          desiredCards.push(card);
        }
        reconcileQuotaChildOrder(listEl, desiredCards);
      }
    }

    if (
      savedScrollTop !== null &&
      savedScrollTop > 0 &&
      viewQuotaBody &&
      el('panel-quota') &&
      !el('panel-quota').hidden &&
      Math.abs((viewQuotaBody.scrollTop || 0) - savedScrollTop) > 1
    ) {
      viewQuotaBody.scrollTop = savedScrollTop;
    }

    if (renderOpts.chargeBars) {
      if (isQuotaReducedMotion()) {
        showQuotaUpToDateFeedback();
      } else if (chargeBarTargets && chargeBarTargets.length > 0) {
        triggerQuotaBarsChargeAnimation(chargeBarTargets);
      }
    }

    syncModelListQuotaIndicators(view, nowMs);
    scheduleQuotaResetConfirmIfNeeded(view, nowMs);
  }

  function scheduleQuotaResetConfirmIfNeeded(view, nowMs = Date.now()) {
    if (state.disposed) return;
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    // 找到未来最近的 resetAtMs 并设定到点 +2s 自动刷新；若刚过 reset 且尚未确认重拉则安排一次即时确认
    let soonestFutureMs = null;
    let passedKey = null;
    for (const p of (view.pools || [])) {
      for (const b of (p.buckets || [])) {
        if (!b.hasResetTime || !Number.isFinite(b.resetAtMs)) continue;
        if (b.resetAtMs > nowMs) {
          if (soonestFutureMs === null || b.resetAtMs < soonestFutureMs) soonestFutureMs = b.resetAtMs;
        } else if (b.remainingFraction === 0) {
          const rKey = `${p.poolKey}:${b.bucketId}:${b.resetTimeIso}`;
          if (quotaState.lastResetRequeryKey !== rKey) {
            passedKey = rKey;
          }
        }
      }
    }
    if (passedKey && !quotaState.busy) {
      quotaState.lastResetRequeryKey = passedKey;
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, 1500);
      return;
    }
    if (soonestFutureMs !== null) {
      const waitMs = Math.min(2147483000, Math.max(2000, soonestFutureMs - nowMs + 2000));
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, waitMs);
    }
  }

  function scheduleQuotaAutoRefresh(delayMs = null) {
    if (state.disposed) return;
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    const isWindowActive = host.getAttribute('data-window-active') !== 'false' && (typeof document === 'undefined' || !document.hidden);
    let interval = delayMs;
    if (!Number.isFinite(interval) || interval <= 0) {
      if (quotaState.consecutiveErrors > 0) {
        interval = Math.min(180000, 30000 * Math.pow(2, Math.min(2, quotaState.consecutiveErrors - 1)));
      } else {
        interval = isWindowActive ? QUOTA_REFRESH_FG_MS : QUOTA_REFRESH_BG_MS;
      }
    }
    quotaState.nextRefreshAtMs = Date.now() + interval;
    quotaAutoTimer = setTimeout(() => {
      quotaAutoTimer = null;
      if (!state.disposed) void syncQuotaFromHost(false, { silent: true });
    }, interval);
  }

  function onQuotaWindowFocus() {
    if (state.disposed) return;
    quotaState.autoPaused = false;
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (elapsed >= 20000 && !quotaState.busy) {
      void syncQuotaFromHost(false, { silent: true });
    } else {
      scheduleQuotaAutoRefresh();
    }
  }

  function onQuotaWindowBlur() {
    if (state.disposed) return;
    scheduleQuotaAutoRefresh(QUOTA_REFRESH_BG_MS);
  }

  function scheduleQuotaPostTurnRefresh() {
    if (state.disposed) return;
    if (quotaPostTurnTimer) clearTimeout(quotaPostTurnTimer);
    quotaPostTurnTimer = setTimeout(() => {
      quotaPostTurnTimer = null;
      const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
      if (!state.disposed && !quotaState.busy && elapsed > 5000) {
        void syncQuotaFromHost(true);
      }
    }, 1500);
  }

  async function maybeRefreshQuotaOnOpen() {
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (!quotaState.snapshot || elapsed > 15000) {
      await syncQuotaFromHost(false);
    }
  }

  function mergeQuotaConfigsPreservingCapabilities(prevConfigs, nextConfigs) {
    if (!Array.isArray(nextConfigs) || !nextConfigs.length) return Array.isArray(prevConfigs) ? prevConfigs : [];
    const prevById = new Map();
    if (Array.isArray(prevConfigs)) {
      for (const item of prevConfigs) {
        const key = String(item?.model || item?.modelId || item?.modelOrAlias?.model || '').trim().toLowerCase();
        if (key) prevById.set(key, item);
      }
    }
    return nextConfigs.map(cfg => {
      if (!cfg || typeof cfg !== 'object') return cfg;
      const key = String(cfg.model || cfg.modelId || cfg.modelOrAlias?.model || '').trim().toLowerCase();
      const prev = key ? prevById.get(key) : null;
      if (!prev) return cfg;
      const merged = { ...cfg };
      for (const field of ['maxTokens', 'maxOutputTokens', 'thinkingBudget', 'minThinkingBudget', 'thinkingLevel', 'supportsModelInfoOverride', 'capabilitySource']) {
        if ((merged[field] == null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
          merged[field] = prev[field];
        }
      }
      return merged;
    });
  }

  async function syncQuotaFromHost(force = false, meta = {}) {
    if (state.disposed) return null;
    if (quotaInFlightPromise) {
      return quotaInFlightPromise;
    }

    const isManual = Boolean(meta.manual);
    const isSilent = Boolean(meta.silent) && !isManual;
    if (isManual) triggerQuotaRefreshIconSpin();
    const runner = (async () => {
      const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(Date.now()));
      quotaState.busy = true;
      renderQuotaBoard(Date.now(), { animate: false, consumeAnim: false });
      let payload = null;
      let rpcErr = null;
      let missingBridge = false;
      let usedBackendSource = null;
      const reqStartMs = Date.now();
      try {
        const hasIpcGetQuota = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getQuota === 'function';
        const hasLivePort = hasLiveHttpBridge() && hasLiveRouteCapability('/quota');
        if (!hasIpcGetQuota && !hasLivePort) {
          missingBridge = true;
          rpcErr = t('quota.bridgeMissing');
        } else {
          quotaAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const out = await callBackendWithPriority({
            ipcCall: hasIpcGetQuota ? () => window.contextMeterAPI.getQuota({ force: Boolean(force) }) : null,
            liveRoute: '/quota',
            liveBody: {
              force: Boolean(force),
              origin: typeof window !== 'undefined' ? (window.location?.origin || undefined) : undefined
            },
            liveFetchOpts: { signal: quotaAbortController?.signal }
          });
          usedBackendSource = out.source;
          const resObj = out.result;
          if (resObj?.ok && resObj.data) {
            payload = resObj.data;
          } else if (resObj?.error) {
            rpcErr = resObj.error;
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') {
          rpcErr = e?.message || '请求模型额度失败';
        }
      } finally {
        quotaAbortController = null;
      }

      if (state.disposed) return null;
      const nowMs = Date.now();
      const quotaDurationMs = nowMs - reqStartMs;
      quotaState.busy = false;
      quotaState.lastFetchedAtMs = nowMs;

      if (payload) {
        if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
          clearQuotaBarChargeAnimations();
          quotaState.snapshot = null;
          quotaState.rawInput = null;
          quotaState.browsePoolKey = null;
          quotaState.lastResetRequeryKey = null;
          quotaLastEstComputeSig = '';
          quotaCachedEstByKey = null;
        }
        if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
        if (payload.collectorVersion) quotaState.collectorVersion = payload.collectorVersion;
        if (usedBackendSource) {
          syncObservedBackendMeta(usedBackendSource, payload, quotaDurationMs);
          if (backendStatus.backendVersion === METER_RENDERER_VERSION && !backendStatus.backendVersionMismatch) {
            pendingUpdateRestart = false;
          }
        }

        if (payload.ok !== false) {
          quotaState.snapshot = payload.snapshot || null;
          quotaState.rawInput = null;
          quotaState.lastSuccessAtMs = payload.lastSuccessAtMs || payload.fetchedAtMs || nowMs;
          quotaState.error = null;
          quotaState.errorKind = null;
          quotaState.consecutiveErrors = 0;
          if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
            state.cascadeModelConfigs = mergeQuotaConfigsPreservingCapabilities(
              payload.accountSwitched ? [] : state.cascadeModelConfigs,
              payload.cascadeModelConfigs
            );
            renderHeaderModelDropdown();
            syncContextModelSelectionFromState();
            if (!isContextSettingsView && activeContextTab === 'models') {
              renderModelSettingsTab();
            }
          }
        } else {
          quotaState.error = payload.error || '刷新失败';
          quotaState.errorKind = payload.errorKind || 'network';
          quotaState.consecutiveErrors += 1;
          if (payload.snapshot && !quotaState.snapshot) {
            quotaState.snapshot = payload.snapshot;
          }
        }
      } else if (rpcErr) {
        quotaState.error = rpcErr;
        quotaState.errorKind = missingBridge ? 'bridge_unavailable' : 'network';
        quotaState.consecutiveErrors += 1;
      }

      const nextView = computeEffectiveQuotaView(nowMs);
      const nextSig = computeQuotaVisualSignature(nextView);
      const hasDataChanged = nextSig !== prevSig;
      const requestSucceeded = Boolean(payload && payload.ok !== false && !rpcErr && !quotaState.error);
      const shouldAnimateChange = Boolean(hasDataChanged && !quotaState.error && prevSig !== 'empty' && !isSilent);
      const panelQuotaEl = el('panel-quota');
      const shouldChargeBars = Boolean(isManual && requestSucceeded && panelQuotaEl && !panelQuotaEl.hidden);
      quotaPendingSmoothAnim = shouldAnimateChange;
      if (!hasDataChanged && isManual && requestSucceeded) {
        showQuotaUpToDateFeedback();
      } else if (hasDataChanged || !requestSucceeded) {
        hideQuotaRefreshFeedback();
      }

      if (missingBridge) {
        clearQuotaTimers();
        quotaState.nextRefreshAtMs = null;
      } else {
        scheduleQuotaAutoRefresh();
      }
      if (typeof refreshAccountsOverview === 'function') {
        void refreshAccountsOverview({ silent: !isManual, refreshAllRemote: Boolean(isManual) });
      }
      renderQuotaBoard(nowMs, { animate: shouldAnimateChange, chargeBars: shouldChargeBars });
      return quotaState.snapshot;
    })();

    quotaInFlightPromise = runner;
    try {
      return await runner;
    } finally {
      if (quotaInFlightPromise === runner) quotaInFlightPromise = null;
    }
  }

  el('btn-speed-breakdown-toggle')?.addEventListener('click', () => {
    state.speedBreakdownOpen = !state.speedBreakdownOpen;
    if (typeof evaluateGenerationExperience === 'function') {
      renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
    }
    positionFloatingPanels();
  });

  el('latest-call-summary-row')?.addEventListener('click', () => {
    state.latestCallDetailOpen = !state.latestCallDetailOpen;
    if (!state.latestCallDetailOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderSessionTimeline();
    }
    if (!state.latestCallDetailOpen && state.pendingLatestCallRecord) {
      renderLatestCallCard({ fromUserAction: true });
    } else {
      syncLatestCallDetailsVisibility();
    }
    positionFloatingPanels();
  });
  el('latest-call-summary-row')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el('latest-call-summary-row')?.click();
    }
  });
  el('latest-call-new-banner')?.addEventListener('click', () => {
    state.pinnedCallRecord = null;
    state.pendingLatestCallRecord = null;
    renderLatestCallCard({ fromUserAction: true });
    if (state.historyDrawerOpen) renderSessionTimeline();
    positionFloatingPanels();
  });
  el('btn-session-history-toggle')?.addEventListener('click', () => {
    state.historyDrawerOpen = !state.historyDrawerOpen;
    if (!state.historyDrawerOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderLatestCallCard({ fromUserAction: true, skipAnim: true });
    }
    renderSessionTimeline();
    if (state.historyDrawerOpen && state.route) {
      void fetchSessionTimeline(state.route, { force: !state.sessionTimeline });
    }
    positionFloatingPanels();
  });
  el('btn-timeline-load-more')?.addEventListener('click', () => {
    state.timelinePageLimit = (Number(state.timelinePageLimit) || 10) + 10;
    renderSessionTimeline();
    positionFloatingPanels();
  });

  el('btn-quota-refresh')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });
  el('btn-quota-banner-retry')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });

  // =========================================================================
  // 多账号账本筛选、切号交互、ELV-57 配额对照表与 ELV-52 保活保障渲染
  // =========================================================================

  function syncTokenAccountFilterOptions(payload = null) {
    const sel = el('token-account-select');
    const noteEl = el('token-account-scope-note');
    if (!sel) return;
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const ov = accountsUiState.overview;
    const acctList = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const usageMap = payload?.usageByAccount || ANTIGRAVITY_TOKEN_DATA.rawPayload?.usageByAccount || {};
    const curScope = payload?.accountScopeKey || ov?.activeAccountScopeKey || '';

    const knownMap = new Map();
    for (const a of acctList) {
      knownMap.set(a.accountScopeKey, a.maskedEmail || a.email || a.accountScopeKey);
    }
    for (const scopeK of Object.keys(usageMap)) {
      if (!knownMap.has(scopeK)) knownMap.set(scopeK, scopeK);
    }

    const optsHtml = [];
    optsHtml.push({ val: 'all', label: t('accounts.filterAll') });
    for (const [scopeK, disp] of knownMap.entries()) {
      const isCur = scopeK === curScope;
      const suffix = isCur ? ` (${t('accounts.activeTag')})` : '';
      optsHtml.push({ val: scopeK, label: `${disp}${suffix}` });
    }
    optsHtml.push({ val: 'unattributed', label: t('accounts.filterUnattributed') });

    const prevVal = activeTokenAccountFilter || 'all';
    sel.replaceChildren();
    for (const item of optsHtml) {
      const opt = document.createElement('option');
      opt.value = item.val;
      opt.textContent = item.label;
      if (item.val === prevVal) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!optsHtml.some(o => o.val === prevVal)) {
      activeTokenAccountFilter = 'all';
      sel.value = 'all';
    } else {
      sel.value = prevVal;
    }

    if (noteEl) {
      if (activeTokenAccountFilter === 'unattributed') {
        const unAttrTot = Number(payload?.unattributedUsage?.totalTokens ?? ANTIGRAVITY_TOKEN_DATA.rawPayload?.unattributedUsage?.totalTokens ?? 0);
        noteEl.textContent = isEn
          ? `Unattributed history (${formatTokensK(unAttrTot)}): offline Desktop/CLI/IDE files without verified email.`
          : (isTw ? `歷史未歸屬 (${formatTokensK(unAttrTot)})：無帳號依據的舊檔案不計入當前帳號。` : `历史未归属 (${formatTokensK(unAttrTot)}): 无账号依据的旧文件不计入当前账号。`);
      } else if (activeTokenAccountFilter !== 'all') {
        const b = usageMap[activeTokenAccountFilter];
        const bTot = Number(b?.totalTokens || 0);
        const kaReqs = Number(b?.keepaliveRequests || 0);
        const kaTok = Number(b?.keepaliveTokens || 0);
        if (bTot <= 0 && kaReqs <= 0) {
          noteEl.textContent = t('accounts.filterNoData');
        } else if (kaReqs > 0) {
          noteEl.textContent = t('accounts.filterKeepaliveNote', { reqs: kaReqs, tok: formatTokensK(kaTok) });
        } else {
          noteEl.textContent = isEn ? 'Isolated account ledger (zero cross-account mixing).' : (isTw ? '單帳號獨立帳本（零跨號混算）。' : '单账号独立账本（零跨号混算）。');
        }
      } else {
        const attrCount = Object.keys(usageMap).length;
        noteEl.textContent = attrCount > 0
          ? (isEn ? `${attrCount} attributed account(s) + isolated legacy history.` : (isTw ? `含 ${attrCount} 個已歸屬帳號 + 獨立未歸屬歷史。` : `含 ${attrCount} 个已归属账号 + 独立未归属历史。`))
          : '';
      }
    }
    if (typeof enhancedDropdowns !== 'undefined' && enhancedDropdowns?.get) {
      enhancedDropdowns.get('token-account-select')?.refresh?.();
    }
  }

  el('token-account-select')?.addEventListener('change', (ev) => {
    activeTokenAccountFilter = ev.target?.value || 'all';
    resetAccountScopedViewOffsets();
    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    }
  });

  function isEditingAutoSwitchDraft() {
    try {
      const ae = shadow?.activeElement;
      if (!ae) return false;
      const body = el('auto-switch-config-body');
      return Boolean(body && body.contains?.(ae));
    } catch {
      return false;
    }
  }

  function renderAccountsOverviewSection() {
    const ov = accountsUiState.overview || {
      accounts: [],
      autoSwitch: {},
      autoSwitchStatus: { state: 'disabled' },
      keepalive: {},
      keepaliveState: {},
      quotaIntervals: [],
      protocolEvidence: {
        checkedVersion: '2.32.1',
        rpcCountChecked: 375,
        conclusion: '在已检查的 Antigravity 2.32.1 语言服务 375 个 RPC 和响应中，未发现明确的 Prompt Cache 续期或 TTL 接口，响应亦未见 cacheWriteTokens 或 cacheTtl；因此不展示虚构到期倒计时，缓存保活保持待验证/默认关闭。',
        minimalExperimentPlan: {
          targetModel: 'Gemini 4 Hydrogen (High)',
          totalRequestsPlanned: 5,
          groupB: '实验组（3 次请求，含 1 次 "ok" 心跳）对比对照组（2 次请求，无保活），约 20K 固定只读前缀、预计总输出 60~150 tok，待维护者确认后再发实验请求。'
        }
      }
    };
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';

    // 1. 工具按钮显隐与反馈横幅
    const toolsBtn = el('btn-acct-import-tools');
    if (toolsBtn) {
      toolsBtn.hidden = !(accountsUiState.toolsPreview?.available && (accountsUiState.toolsPreview.count || 0) > 0);
    }
    const fbEl = el('quota-acct-feedback');
    const lr = ov.autoSwitchStatus?.lastResult;
    const rawLastErr = (lr?.ok === false && lr?.error) ? lr.error : ov.autoSwitchStatus?.lastError;
    const formatPersistedError = (raw) => {
      if (!raw) return '';
      const txt = typeof translateBackendText === 'function' ? translateBackendText(raw) : String(raw);
      if (lr?.rolledBack && !/(回滚|回滾|rolled back)/i.test(txt)) {
        return t('accounts.lastSwitchRolledBack', { detail: txt });
      }
      return txt;
    };
    const hasRecentPersistedResult = Boolean(
      !accountsUiState.feedback
      && !accountsUiState.busy
      && lr
      && (lr.ok === false || (lr.atMs != null && Math.abs(Date.now() - Number(lr.atMs)) <= 15 * 60 * 1000))
    );
    let displayFeedback = accountsUiState.feedback || '';
    let displayTone = accountsUiState.feedbackTone;
    if (!displayFeedback && hasRecentPersistedResult) {
      if (lr.ok === false) {
        displayFeedback = formatPersistedError(rawLastErr || t('accounts.actionFail'));
        displayTone = 'error';
      } else if (lr.ok === true && (lr.message || lr.toEmail)) {
        displayFeedback = lr.message
          ? (typeof translateBackendText === 'function' ? translateBackendText(lr.message) : lr.message)
          : t('accounts.lastSwitchedTo', { email: lr.toEmail });
        displayTone = 'success';
      }
    }
    if (fbEl) {
      fbEl.hidden = !displayFeedback;
      fbEl.textContent = displayFeedback;
      fbEl.className = `quota-acct-feedback${displayTone === 'error' ? ' is-error' : (displayTone === 'success' ? ' is-success' : '')}`;
    }

    // 2. 账号清单
    const listEl = el('quota-accounts-list');
    if (listEl) {
      const prevScrollTop = Number(listEl.scrollTop || 0);
      listEl.replaceChildren();
      const accts = Array.isArray(ov.accounts) ? ov.accounts : [];
      if (!accts.length) {
        const empty = document.createElement('div');
        empty.className = 'quota-muted-note';
        empty.textContent = t('accounts.empty');
        listEl.appendChild(empty);
      } else {
        for (const acc of accts) {
          const card = document.createElement('div');
          card.className = `quota-acct-card${acc.isActive ? ' is-active' : ''}`;
          const topRow = document.createElement('div');
          topRow.className = 'quota-subcard-row';
          const left = document.createElement('span');
          left.className = 'quota-acct-email';
          const resolveAccountTierLabel = (a) => {
            if (!a) return '';
            const curEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email;
            if (a.isActive && curEmail && (typeof normalizeEmail === 'function' ? normalizeEmail(a.email) === normalizeEmail(curEmail) : a.email === curEmail)) {
              const curName = ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName;
              if (curName && curName !== '未知') return curName;
            }
            return a.tierName || a.tierId || '';
          };
          const accTierLabel = resolveAccountTierLabel(acc);
          left.textContent = `${acc.email}${accTierLabel ? ` · ${accTierLabel}` : ''}`;
          left.title = acc.email;
          const right = document.createElement('div');
          right.className = 'quota-subsec-actions';
          if (acc.hasRefreshToken) {
            const refBtn = document.createElement('button');
            refBtn.className = 'switch-pill-btn quota-acct-refresh-btn';
            refBtn.type = 'button';
            refBtn.disabled = accountsUiState.busy;
            refBtn.textContent = t('accounts.retryQuota');
            refBtn.addEventListener('click', () => void performAccountAction('refresh_quota', { email: acc.email }));
            right.appendChild(refBtn);
          }
          if (acc.isActive) {
            const pill = document.createElement('span');
            pill.className = 'key-pill pill-good';
            pill.textContent = t('accounts.activeTag');
            right.appendChild(pill);
          } else {
            const swBtn = document.createElement('button');
            swBtn.className = 'switch-pill-btn';
            swBtn.type = 'button';
            swBtn.disabled = accountsUiState.busy || Boolean(accountsUiState.removeModal?.busy) || !acc.hasRefreshToken || Boolean(acc.authInvalid);
            swBtn.textContent = t('accounts.switchBtn');
            swBtn.addEventListener('click', () => void performAccountAction('switch', { email: acc.email }));
            right.appendChild(swBtn);
          }
          const rmBtn = document.createElement('button');
          rmBtn.className = 'quota-acct-remove-btn';
          rmBtn.type = 'button';
          rmBtn.disabled = accountsUiState.busy || Boolean(accountsUiState.removeModal?.busy);
          rmBtn.textContent = t('accounts.removeBtn');
          if (rmBtn.dataset) rmBtn.dataset.removeEmail = acc.email;
          rmBtn.addEventListener('click', () => openRemoveAccountModal(acc));
          right.appendChild(rmBtn);
          topRow.appendChild(left);
          topRow.appendChild(right);
          card.appendChild(topRow);

          const CORE_POOL_NAMES = {
            shared_gemini_main: 'Hydrogen',
            shared_3p_pool: 'Claude/3P',
            shared_gemini_argon: 'Argon',
            shared_gemini_carbon: 'Carbon'
          };

          const poolSummaries = [];
          for (const p of (acc.quotaSnapshot?.pools || [])) {
            if (!p || typeof p !== 'object') continue;
            const pName = CORE_POOL_NAMES[p.poolKey];
            // 严禁使用 else 'Carbon' 兜底！只展示四大核心共享池，过滤掉历史快照中已残留的 shared_chat_* / shared_gemini-25-pro* 等非核心杂项池
            if (!pName) continue;

            // Carbon 显示规则：
            // 当 shared_gemini_carbon 具有真实可用权限（!p.noPermission 且有配额数据，即 Ultra 用户）时，必须正常显示 Carbon 额度；
            // 当 p.noPermission === true（无权限，如 Free / Pro 用户）时，在多账号卡片摘要行中直接隐藏该无权限项，不显示 "Carbon: 无模型权限"，更不能把别的池显示成 Carbon。
            if (p.poolKey === 'shared_gemini_carbon') {
              if (p.noPermission) continue;
              const hasQuotaData = (Array.isArray(p.buckets) && p.buckets.some(b => b && b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction))))
                || (p.remainingFraction !== null && p.remainingFraction !== undefined && Number.isFinite(Number(p.remainingFraction)));
              if (!hasQuotaData) continue;
            }

            if (p.noPermission) {
              poolSummaries.push(`${pName}: ${t('accounts.poolNoAccess')}`);
              continue;
            }

            const buckets = Array.isArray(p.buckets) ? p.buckets.filter(Boolean) : [];
            const b5h = buckets.find(b => b.windowKey === '5h' || b.windowShort === '5h') || null;
            const b7d = buckets.find(b => b.windowKey === 'weekly' || b.windowShort === '7d') || null;

            const formatBucketPct = (b) => {
              if (!b) return '';
              if (b.percentText && b.percentText !== '未知') return b.percentText;
              if (b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction))) {
                return `${Math.round(b.remainingFraction * 100)}%`;
              }
              return '—';
            };

            if (b5h && b7d) {
              // 若同时存在 5h 与 7d 桶，格式明确显示为 "Hydrogen: 5h 0% / 7d 70%"、"Claude/3P: 5h 100% / 7d 87%"
              poolSummaries.push(`${pName}: 5h ${formatBucketPct(b5h)} / 7d ${formatBucketPct(b7d)}`);
            } else if (b5h) {
              const tag = b5h.windowShort || '5h';
              poolSummaries.push(`${pName}: ${tag} ${formatBucketPct(b5h)}`);
            } else if (b7d) {
              // 若仅存在单一窗口桶（如 Argon 仅有 7d 桶，或 free-tier 仅有 7d 桶），明确带上窗口短标显示为 "Argon: 7d 70%"、"Hydrogen: 7d 100%"
              const tag = b7d.windowShort || '7d';
              poolSummaries.push(`${pName}: ${tag} ${formatBucketPct(b7d)}`);
            } else if (buckets.length === 1 && buckets[0]?.windowShort) {
              poolSummaries.push(`${pName}: ${buckets[0].windowShort} ${formatBucketPct(buckets[0])}`);
            } else {
              // 仅在 bucket 无 windowShort 时回退 p.percentText
              const pVal = p.percentText && p.percentText !== '未知' ? p.percentText : t('accounts.poolUnknown');
              poolSummaries.push(`${pName}: ${pVal}`);
            }
          }
          const metaRow = document.createElement('div');
          metaRow.className = 'quota-acct-meta';
          const updRaw = acc.lastQuotaUpdatedAtMs ? new Date(acc.lastQuotaUpdatedAtMs).toLocaleTimeString() : '—';
          const upd = (acc.quotaSnapshot && acc.lastQuotaError && acc.lastQuotaUpdatedAtMs)
            ? t('accounts.lastSnapshotTime', { time: updRaw })
            : updRaw;
          const authNote = acc.authInvalid ? ` · ${t('accounts.reauthRequired')}` : '';
          const emptyPoolText = acc.lastQuotaError ? t('accounts.poolPending') : t('accounts.poolUnknown');
          metaRow.textContent = `${poolSummaries.length ? poolSummaries.join(' | ') : emptyPoolText} · ${upd}${authNote}`;
          card.appendChild(metaRow);
          if (acc.lastQuotaError) {
            const errRow = document.createElement('div');
            errRow.className = 'quota-acct-error';
            const meta = acc.lastQuotaErrorMeta;
            const detailParts = [];
            if (meta?.stage) detailParts.push(meta.stage);
            if (meta?.targetHost) detailParts.push(meta.targetHost);
            if (meta?.httpStatus != null) detailParts.push(`HTTP ${meta.httpStatus}`);
            const translatedErr = typeof translateBackendText === 'function' ? translateBackendText(acc.lastQuotaError) : acc.lastQuotaError;
            const detailStr = detailParts.length ? `[${detailParts.join(' · ')}] ${translatedErr}` : translatedErr;
            errRow.textContent = t('accounts.quotaStageErr', { detail: detailStr });
            card.appendChild(errRow);
          }
          listEl.appendChild(card);
        }
      }
      if (prevScrollTop > 0) {
        const maxScroll = Math.max(0, (listEl.scrollHeight || 0) - (listEl.clientHeight || 0));
        listEl.scrollTop = maxScroll > 0 ? Math.min(prevScrollTop, maxScroll) : prevScrollTop;
      }
    }

    // 3. 自动切号状态与控件回填（编辑时跳过输入项覆盖，防破坏草稿）
    const stPill = el('auto-switch-status-pill');
    const lastNote = el('auto-switch-last-note');
    const stKeys = new Set(['disabled', 'watching', 'pending_debounce', 'waiting_idle', 'cooldown', 'switching', 'all_candidates_exhausted', 'blocked_untrusted_quota', 'error']);
    if (stPill) {
      const sKey = ov.autoSwitchStatus?.state || (ov.autoSwitch?.enabled ? 'watching' : 'disabled');
      stPill.textContent = stKeys.has(sKey) ? t(`accounts.status.${sKey}`) : sKey;
      stPill.className = `key-pill ${sKey === 'watching' ? 'pill-good' : (sKey === 'error' || sKey === 'all_candidates_exhausted' ? 'pill-warn' : 'pill-muted')}`;
    }
    if (lastNote) {
      if (rawLastErr) {
        lastNote.textContent = formatPersistedError(rawLastErr);
      } else if (lr?.ok === false) {
        lastNote.textContent = formatPersistedError(t('accounts.actionFail'));
      } else {
        lastNote.textContent = lr?.toEmail ? t('accounts.lastSwitchedTo', { email: lr.toEmail }) : '';
      }
    }

    if (!isEditingAutoSwitchDraft()) {
      const cfg = ov.autoSwitch || {};
      const chk = el('chk-auto-switch-enabled');
      const poolSel = el('sel-auto-switch-pool');
      const modeSel = el('sel-auto-switch-mode');
      const winSel = el('sel-auto-switch-window');
      const thInp = el('inp-auto-switch-threshold');
      if (chk) chk.checked = Boolean(cfg.enabled);
      if (poolSel && cfg.poolKey) poolSel.value = cfg.poolKey;
      if (modeSel && cfg.metricMode) modeSel.value = cfg.metricMode;
      if (winSel && cfg.windowKey) winSel.value = cfg.windowKey;
      if (thInp && cfg.thresholdPct != null) thInp.value = String(cfg.thresholdPct);
      if (typeof enhancedDropdowns !== 'undefined' && enhancedDropdowns?.get) {
        enhancedDropdowns.get('sel-auto-switch-pool')?.refresh?.();
        enhancedDropdowns.get('sel-auto-switch-mode')?.refresh?.();
        enhancedDropdowns.get('sel-auto-switch-window')?.refresh?.();
      }

      const candWrap = el('auto-switch-candidates-list');
      if (candWrap) {
        candWrap.replaceChildren();
        const selectedSet = new Set(Array.isArray(cfg.candidates) ? cfg.candidates : []);
        for (const acc of (ov.accounts || [])) {
          const lbl = document.createElement('label');
          lbl.className = 'auto-switch-cand-chip';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = acc.email;
          box.checked = selectedSet.has(acc.email);
          box.className = 'auto-switch-cand-checkbox';
          const span = document.createElement('span');
          span.textContent = acc.maskedEmail || acc.email;
          lbl.appendChild(box);
          lbl.appendChild(span);
          candWrap.appendChild(lbl);
        }
      }
    }

    // 4. ELV-57 配额变化对照表
    const cmpEl = el('quota-compare-list');
    if (cmpEl) {
      cmpEl.replaceChildren();
      const intervals = Array.isArray(ov.quotaIntervals) ? ov.quotaIntervals.slice(0, 8) : [];
      if (!intervals.length) {
        const emp = document.createElement('div');
        emp.className = 'quota-muted-note';
        emp.textContent = t('quota.compareEmpty');
        cmpEl.appendChild(emp);
      } else {
        for (const iv of intervals) {
          const card = document.createElement('div');
          card.className = 'quota-compare-card';
          const deltaLabel = iv.deltaPp < 0
            ? (isEn ? `-${Math.abs(iv.deltaPp)} pp` : (isTw ? `下降 ${Math.abs(iv.deltaPp)} 個百分點` : `下降 ${Math.abs(iv.deltaPp)} 个百分点`))
            : (iv.deltaPp > 0 ? (isEn ? `+${iv.deltaPp} pp` : (isTw ? `回升 ${iv.deltaPp} 個百分點` : `回升 ${iv.deltaPp} 个百分点`)) : (isEn ? '0 pp' : (isTw ? '無變化' : '无变化')));
          const splitText = iv.splitReason
            ? (t(`quota.split.${iv.splitReason}`) !== `quota.split.${iv.splitReason}` ? t(`quota.split.${iv.splitReason}`) : iv.splitReason)
            : '';
          const splitBadge = splitText ? ` [${splitText}]` : '';
          const sTime = new Date(iv.startAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const eTime = new Date(iv.endAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const head = document.createElement('div');
          head.className = 'quota-subcard-row';
          head.innerHTML = '';
          const hLeft = document.createElement('strong');
          hLeft.textContent = `${iv.poolTitle} (${iv.windowShort || iv.windowKey}) · ${iv.startRemainingPct}% → ${iv.endRemainingPct}% (${deltaLabel})`;
          const hRight = document.createElement('span');
          hRight.className = 'quota-acct-meta';
          hRight.textContent = `${sTime}–${eTime}${splitBadge}`;
          head.appendChild(hLeft);
          head.appendChild(hRight);

          const body = document.createElement('div');
          body.className = 'quota-acct-meta';
          body.textContent = isEn
            ? `Account: ${iv.email} · Local reqs: ${iv.requestCount} | Uncached In: ${formatTokensK(iv.uncachedInputTokens)} · Cache Read: ${formatTokensK(iv.cacheReadTokens)} · Out: ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · Sampling gap split' : ''}`
            : (isTw
              ? `帳號: ${iv.email} · 本機請求 ${iv.requestCount} 次 | 未快取輸入 ${formatTokensK(iv.uncachedInputTokens)} · 快取讀取 ${formatTokensK(iv.cacheReadTokens)} · 輸出 ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · 含採樣缺口已切分' : ''}`
              : `账号: ${iv.email} · 本机请求 ${iv.requestCount} 次 | 未缓存输入 ${formatTokensK(iv.uncachedInputTokens)} · 缓存读取 ${formatTokensK(iv.cacheReadTokens)} · 输出 ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · 含采样缺口已切分' : ''}`);
          card.appendChild(head);
          card.appendChild(body);
          cmpEl.appendChild(card);
        }
      }
    }

    // 5. ELV-52 保活协议证据与安全控制
    const kaPill = el('keepalive-status-pill');
    const kaProto = el('keepalive-protocol-summary');
    const kaExp = el('keepalive-experiment-summary');
    const kaRun = el('keepalive-runtime-note');
    const kaStopBtn = el('btn-keepalive-stop');
    const ka = ov.keepalive || {};
    const ks = ov.keepaliveState || {};
    if (kaPill) {
      kaPill.textContent = ks.running
        ? (isEn ? 'Running' : (isTw ? '保活執行中' : '保活运行中'))
        : (isEn ? 'Unverified · Off' : (isTw ? '待驗證 · 預設關閉' : '待验证 · 默认关闭'));
      kaPill.className = `key-pill ${ks.running ? 'pill-warn' : 'pill-muted'}`;
    }
    if (kaProto && ov.protocolEvidence) {
      kaProto.textContent = t('keepalive.protocolSummary', {
        ver: ov.protocolEvidence.checkedVersion || '2.32.1',
        rpcs: ov.protocolEvidence.rpcCountChecked || 375
      });
    }
    if (kaExp && ov.protocolEvidence?.minimalExperimentPlan) {
      const plan = ov.protocolEvidence.minimalExperimentPlan;
      kaExp.textContent = t('keepalive.experimentSummary', {
        reqs: plan.totalRequestsPlanned || 5,
        model: plan.targetModel || 'Gemini 4 Hydrogen (High)'
      });
    }
    if (kaRun) {
      const blockedTxt = ks.blockedReason && typeof translateBackendText === 'function' ? translateBackendText(ks.blockedReason) : ks.blockedReason;
      const stopTxt = ks.stopReason && typeof translateBackendText === 'function' ? translateBackendText(ks.stopReason) : ks.stopReason;
      kaRun.textContent = blockedTxt
        ? t('keepalive.blockedReason', { reason: blockedTxt })
        : (stopTxt ? t('keepalive.stopReason', { reason: stopTxt }) : t('keepalive.defaultNote'));
    }
    if (kaStopBtn) kaStopBtn.hidden = !ks.running;

    syncTokenAccountFilterOptions(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    if (accountsUiState.removeModal?.open) renderAccountRemoveModal();
  }

  async function refreshAccountsOverview({ silent = true, refreshAllRemote = false } = {}) {
    if (state.disposed) return null;
    try {
      const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getAccountsOverview === 'function';
      const hasLive = hasLiveHttpBridge() && hasLiveRouteCapability('/accounts-overview');
      if (!hasIpc && !hasLive) return null;
      if (refreshAllRemote) {
        const res = await callBackendWithPriority({
          ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
            ? () => window.contextMeterAPI.accountsAction({ action: 'refresh_quota' })
            : null,
          liveRoute: '/accounts-action',
          liveBody: { action: 'refresh_quota' }
        });
        const out = res?.result || {};
        const data = out.overview || out;
        if (data?.accounts) accountsUiState.overview = data;
        if (out.ok === false) {
          const errRaw = out.error || out.message || t('accounts.actionFail');
          accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(errRaw) : errRaw;
          accountsUiState.feedbackTone = 'error';
        } else if (out.ok === true && accountsUiState.feedbackTone === 'error') {
          const msgRaw = out.message || t('accounts.actionDone');
          accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(msgRaw) : msgRaw;
          accountsUiState.feedbackTone = 'success';
        }
      } else {
        const res = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.getAccountsOverview() : null,
          liveRoute: '/accounts-overview',
          liveBody: {}
        });
        const data = res?.result;
        if (data?.ok) accountsUiState.overview = data;
      }
      if (!accountsUiState.toolsPreview) {
        const prevRes = await callBackendWithPriority({
          ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
            ? () => window.contextMeterAPI.accountsAction({ action: 'preview_tools' })
            : null,
          liveRoute: '/accounts-action',
          liveBody: { action: 'preview_tools' }
        }).catch(() => null);
        if (prevRes?.result?.ok) accountsUiState.toolsPreview = prevRes.result;
      }
      renderAccountsOverviewSection();
      return accountsUiState.overview;
    } catch (e) {
      if (!silent) {
        accountsUiState.feedback = e.message;
        accountsUiState.feedbackTone = 'error';
        renderAccountsOverviewSection();
      }
      return null;
    }
  }

  function renderAccountRemoveModal() {
    const modal = el('account-remove-modal');
    const titleEl = el('modal-account-remove-title');
    const textEl = el('modal-account-remove-text');
    const fbEl = el('modal-account-remove-feedback');
    const cancelBtn = el('btn-modal-account-remove-cancel');
    const confirmBtn = el('btn-modal-account-remove-confirm');
    const st = accountsUiState.removeModal || {};
    if (!modal) return;
    modal.hidden = !st.open;
    if (!st.open) return;
    if (titleEl) titleEl.textContent = t('accounts.removeModal.title');
    if (textEl) {
      textEl.textContent = st.isActive
        ? t('accounts.removeModal.bodyActive', { email: st.email || '' })
        : t('accounts.removeModal.body', { email: st.email || '' });
    }
    if (fbEl) {
      fbEl.hidden = !st.error;
      fbEl.textContent = st.error || '';
    }
    if (cancelBtn) {
      cancelBtn.textContent = t('accounts.removeModal.cancel');
      cancelBtn.disabled = Boolean(st.busy);
    }
    if (confirmBtn) {
      confirmBtn.textContent = st.busy ? t('accounts.removeModal.removing') : t('accounts.removeModal.confirm');
      confirmBtn.disabled = Boolean(st.busy) || !st.email;
    }
  }

  function openRemoveAccountModal(acc) {
    if (!acc || !acc.email || accountsUiState.busy || accountsUiState.removeModal?.busy) return;
    const scopeKey = acc.accountScopeKey || String(acc.email).trim().toLowerCase();
    accountsUiState.removeModal = {
      open: true,
      email: acc.email,
      scopeKey,
      isActive: Boolean(acc.isActive),
      busy: false,
      error: ''
    };
    renderAccountRemoveModal();
  }

  function closeRemoveAccountModal(forceClose = false) {
    if (!forceClose && accountsUiState.removeModal?.busy) return;
    accountsUiState.removeModal = {
      open: false,
      email: '',
      scopeKey: '',
      isActive: false,
      busy: false,
      error: ''
    };
    renderAccountRemoveModal();
  }

  async function confirmRemoveAccountModal() {
    const st = accountsUiState.removeModal;
    if (!st?.open || !st.email || st.busy || accountsUiState.busy) return null;
    const targetEmail = st.email;
    const targetScopeKey = st.scopeKey || String(targetEmail).trim().toLowerCase();
    st.busy = true;
    st.error = '';
    renderAccountRemoveModal();
    renderAccountsOverviewSection();
    try {
      const out = await performAccountAction('remove', { email: targetEmail });
      if (out && out.ok) {
        const effectiveRemovedScope = out.removedScopeKey || targetScopeKey;
        closeRemoveAccountModal(true);
        accountsUiState.feedback = t('accounts.removeSuccess', { email: targetEmail });
        accountsUiState.feedbackTone = 'success';
        if (activeTokenAccountFilter && activeTokenAccountFilter === effectiveRemovedScope) {
          activeTokenAccountFilter = 'all';
          resetAccountScopedViewOffsets();
        }
        if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
          applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
        }
        renderAccountsOverviewSection();
        void refreshAccountsOverview({ silent: true });
        void syncTokenHistoryFromHost(true);
        return out;
      }
      const errDetail = translateBackendText(out?.error || t('accounts.actionFail'));
      accountsUiState.removeModal = {
        ...accountsUiState.removeModal,
        open: true,
        busy: false,
        error: t('accounts.removeModal.failed', { detail: errDetail })
      };
      renderAccountRemoveModal();
      return out || { ok: false, error: errDetail };
    } catch (err) {
      const errDetail = translateBackendText(err?.message || t('accounts.actionFail'));
      accountsUiState.removeModal = {
        ...accountsUiState.removeModal,
        open: true,
        busy: false,
        error: t('accounts.removeModal.failed', { detail: errDetail })
      };
      renderAccountRemoveModal();
      return { ok: false, error: errDetail };
    }
  }

  el('btn-modal-account-remove-cancel')?.addEventListener('click', () => closeRemoveAccountModal());
  el('btn-modal-account-remove-confirm')?.addEventListener('click', () => void confirmRemoveAccountModal());
  el('account-remove-modal')?.addEventListener('click', (ev) => {
    if (ev.target === el('account-remove-modal')) closeRemoveAccountModal();
  });

  async function performAccountAction(action, extraPayload = {}) {
    if (accountsUiState.busy) return null;
    accountsUiState.busy = true;
    accountsUiState.feedback = t('accounts.actionBusy');
    accountsUiState.feedbackTone = 'info';
    renderAccountsOverviewSection();
    try {
      const res = await callBackendWithPriority({
        ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
          ? () => window.contextMeterAPI.accountsAction({ action, ...extraPayload })
          : null,
        liveRoute: '/accounts-action',
        liveBody: { action, ...extraPayload }
      });
      const out = res?.result || {};
      if (out.overview) accountsUiState.overview = out.overview;
      const isOk = out.ok === true;
      const isPartialOAuthQuotaWarn = isOk && action === 'oauth_login' && out.quotaOk === false && Boolean(out.quotaError);
      const rawFb = isPartialOAuthQuotaWarn
        ? `${out.account?.email ? `${out.account.email} ` : ''}${translateBackendText(out.quotaError)}`
        : (isOk
          ? (out.message || t('accounts.actionDone'))
          : (out.error || out.message || t('accounts.actionFail')));
      accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(rawFb) : rawFb;
      accountsUiState.feedbackTone = isOk ? (isPartialOAuthQuotaWarn ? 'info' : 'success') : 'error';
      if (action === 'switch' && isOk) {
        void syncQuotaFromHost(true, { manual: false });
        void syncTokenHistoryFromHost(true);
      }
      return out;
    } catch (e) {
      const errTxt = e.message || t('accounts.actionFail');
      accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(errTxt) : errTxt;
      accountsUiState.feedbackTone = 'error';
      return { ok: false, error: e.message };
    } finally {
      accountsUiState.busy = false;
      renderAccountsOverviewSection();
    }
  }

  el('btn-acct-import-current')?.addEventListener('click', () => void performAccountAction('import_current'));
  el('btn-acct-import-tools')?.addEventListener('click', () => void performAccountAction('import_tools'));
  el('btn-acct-oauth-add')?.addEventListener('click', () => void performAccountAction('oauth_login'));
  el('btn-keepalive-stop')?.addEventListener('click', () => void performAccountAction('stop_keepalive', { reason: 'manual_button' }));
  el('btn-save-auto-switch')?.addEventListener('click', () => {
    const enabled = Boolean(el('chk-auto-switch-enabled')?.checked);
    const poolKey = el('sel-auto-switch-pool')?.value || 'shared_gemini_main';
    const metricMode = el('sel-auto-switch-mode')?.value || 'remaining_pct';
    const windowKey = el('sel-auto-switch-window')?.value || 'primary';
    const thresholdPct = Number(el('inp-auto-switch-threshold')?.value) || 10;
    const candidates = Array.from(shadow.querySelectorAll('.auto-switch-cand-checkbox:checked')).map(n => n.value);
    void performAccountAction('update_auto_switch', {
      config: { enabled, poolKey, metricMode, windowKey, thresholdPct, candidates }
    });
  });
  const btnQuotaBannerRestartInit = el('btn-quota-banner-restart');
  if (btnQuotaBannerRestartInit) {
    btnQuotaBannerRestartInit.hidden = true;
    btnQuotaBannerRestartInit.addEventListener('click', () => {
      openClientRestartConfirmFlow();
    });
  }
  renderQuotaBoard();

  let quotaTickCounter = 0;
  let hasTriggeredInitialQuotaSync = false;
  function tick() {
    if (state.disposed || (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host)) {
      earlyForceDispose();
      return;
    }
    if (!host.isConnected) {
      ensureHostDocked();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      clearLivePendingRequestWait();
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.expandedTurnKeys) state.expandedTurnKeys.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [], sessionCostTotal: 0,
        callsHydrated: false, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
        pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
        historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
        timelineError: '', timelinePageLimit: 10, timelineAutoExpandedRoute: null, timelineRenderedRoute: null,
        lastTimelineFetchAt: 0, lastTimelineCallSig: '',
        speedBreakdownOpen: false, streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
      });
      // 避免切换会话后立刻撞上 15s 周期历史刷新，若已做过同步则确保至少留出 7s 窗口给当前会话优先加载
      if (lastHistorySync > 0) {
        lastHistorySync = Math.max(lastHistorySync, Date.now() - 8000);
      }
      toggle(false); hideContextTooltip(); renderFiles(null); render();
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (!state.disposed && state.pendingFinalCalls?.size && !state.flushFinalsBusy && Date.now() >= (state.nextFlushRetryAt || 0)) {
      void flushPendingFinalCalls(false);
    }
    syncPendingAutomaticHistory();
    if (!hasTriggeredInitialQuotaSync) {
      hasTriggeredInitialQuotaSync = true;
      if (!quotaState.snapshot && !quotaState.busy && !quotaInFlightPromise) {
        void syncQuotaFromHost(false);
      }
    }
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
    quotaTickCounter = (quotaTickCounter + 1) % 2;
    if (quotaTickCounter === 0 && el('panel-quota') && !el('panel-quota').hidden) {
      renderQuotaBoard(Date.now());
    }
  }

  const timer = setInterval(tick, 500);
  // 监听 SPA 路由跳转，切会话微任务内立即清旧状态并发起新会话采集，消除轮询间隙旧数据残留
  let routeHookScheduled = false;
  const scheduleImmediateRouteTick = () => {
    if (routeHookScheduled || state.disposed) return;
    routeHookScheduled = true;
    Promise.resolve().then(() => {
      routeHookScheduled = false;
      if (!state.disposed && route() !== state.route) tick();
    });
  };
  let origPushState = null;
  let origReplaceState = null;
  let wrappedPushState = null;
  let wrappedReplaceState = null;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', scheduleImmediateRouteTick);
  }
  if (typeof globalThis.history === 'object' && globalThis.history) {
    if (typeof globalThis.history.pushState === 'function') {
      origPushState = globalThis.history.pushState;
      wrappedPushState = function (...args) {
        const res = origPushState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.pushState = wrappedPushState; } catch { wrappedPushState = null; }
    }
    if (typeof globalThis.history.replaceState === 'function') {
      origReplaceState = globalThis.history.replaceState;
      wrappedReplaceState = function (...args) {
        const res = origReplaceState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.replaceState = wrappedReplaceState; } catch { wrappedReplaceState = null; }
    }
  }
  async function verifyHotReloadAndRefreshQuota() {
    if (state.disposed) return null;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
      try {
        const rt = await window.contextMeterAPI.getRuntimeInfo();
        if (rt && rt.ok && rt.backendVersion) {
          backendStatus.ipcBackendVersion = String(rt.backendVersion);
        }
      } catch { }
    }
    if (hasLiveHttpBridge() && shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/runtime-info')) {
      try {
        const liveRt = await postLiveHttpEndpoint('/runtime-info', {});
        if (liveRt && liveRt.ok) {
          syncObservedBackendMeta('live-host', liveRt);
        }
      } catch {
        backendStatus.liveHealthy = false;
      }
    }
    const snap = await syncQuotaFromHost(true);
    return {
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      pendingUpdateRestart,
      quotaAttempted: Boolean(quotaState.lastFetchedAtMs),
      quotaOk: Boolean(snap && !quotaState.error),
      quotaActiveStatus: computeEffectiveQuotaView(Date.now()).activeStatus,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    };
  }

  function captureHotReloadState() {
    if (inheritedHotReloadState) return inheritedHotReloadState;
    const pCtx = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const openPanel = (pQuota && !pQuota.hidden) ? 'quota'
      : ((pTokens && !pTokens.hidden) ? 'tokens'
        : ((pCtx && !pCtx.hidden) ? 'context' : 'none'));
    const scrollTops = {};
    for (const sId of ['panel', 'panel-tokens', 'panel-quota', 'ctx-model-list', 'quota-view-body']) {
      const n = el(sId);
      if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
    }
    const openDrawers = [];
    for (const btnId of [
      'btn-toggle-details', 'btn-toggle-card-details', 'btn-toggle-unlock-details',
      'btn-toggle-enhance-details', 'btn-toggle-proxy', 'btn-toggle-colors', 'btn-toggle-token-colors'
    ]) {
      if (el(btnId)?.getAttribute?.('aria-expanded') === 'true') {
        openDrawers.push(btnId);
      }
    }
    return {
      capturedAt: Date.now(),
      openPanel,
      activeContextTab,
      isContextSettingsView,
      browsePoolKey: quotaState.browsePoolKey || null,
      scrollTops,
      openDrawers,
      drafts: {
        proxyInputDirty: Boolean(proxyInputDirty),
        proxyUrl: inputProxyUrl ? inputProxyUrl.value : null,
        proxyBypass: inputProxyBypass ? inputProxyBypass.value : null,
        ctxDraftDirty: Boolean(ctxDraftDirty),
        ctxCustomValue: ctxCustomInput ? ctxCustomInput.value : null,
        enhanceTierDirty: Boolean(enhanceTierDirty),
        selectedEnhanceTier: selectedEnhanceTier ?? null,
        enhanceTitleDirty: Boolean(enhanceTitleDirty),
        enhanceTitleDraft: enhanceTitleDraft ?? null
      }
    };
  }

  function applyInheritedHotReloadState(saved) {
    if (!saved || typeof saved !== 'object' || state.disposed) return;
    const d = saved.drafts || {};
    if (d.proxyInputDirty) {
      if (inputProxyUrl && typeof d.proxyUrl === 'string') inputProxyUrl.value = d.proxyUrl;
      if (inputProxyBypass && typeof d.proxyBypass === 'string') inputProxyBypass.value = d.proxyBypass;
      proxyInputDirty = true;
      syncProxySaveButtonState();
    }
    if (d.ctxDraftDirty && ctxCustomInput && typeof d.ctxCustomValue === 'string') {
      ctxCustomInput.value = d.ctxCustomValue;
      ctxDraftDirty = true;
    }
    if (d.enhanceTierDirty && d.selectedEnhanceTier != null) {
      selectedEnhanceTier = d.selectedEnhanceTier;
      enhanceTierDirty = true;
    }
    if (d.enhanceTitleDirty && d.enhanceTitleDraft != null) {
      enhanceTitleDraft = d.enhanceTitleDraft;
      if (enhanceChineseTitleCheck && typeof d.enhanceTitleDraft === 'boolean') {
        enhanceChineseTitleCheck.checked = d.enhanceTitleDraft;
      }
      enhanceTitleDirty = true;
    }
    if (d.enhanceTierDirty || d.enhanceTitleDirty) {
      renderEnhanceSectionUI();
    }
    if (saved.browsePoolKey) {
      quotaState.browsePoolKey = saved.browsePoolKey;
    }
    if (saved.openPanel && saved.openPanel !== 'none') {
      showPanel(saved.openPanel);
      if (saved.openPanel === 'context' && saved.activeContextTab) {
        switchContextTab(saved.activeContextTab);
      } else if (saved.openPanel === 'context' && saved.isContextSettingsView) {
        switchContextTab('settings');
      }
    }
    if (Array.isArray(saved.openDrawers)) {
      for (const btnId of saved.openDrawers) {
        const btn = el(btnId);
        if (btn && btn.getAttribute?.('aria-expanded') !== 'true') {
          try { btn.click(); } catch { }
        }
      }
    }
    const scrollTops = saved.scrollTops || {};
    const restoreScrolls = () => {
      if (state.disposed) return;
      for (const [sId, topVal] of Object.entries(scrollTops)) {
        const node = el(sId);
        if (node && Number(topVal) > 0) node.scrollTop = Number(topVal);
      }
    };
    restoreScrolls();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(restoreScrolls);
    }
    setTimeout(restoreScrolls, 40);
    setTimeout(restoreScrolls, 140);
  }

  globalThis.__AGContextMeter = {
    version: METER_RENDERER_VERSION,
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch { }; applyTheme(); },
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
    syncTokenHistoryFromHost,
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
      enhanceTierDirty,
      enhanceTitleDirty,
      proxyInputDirty,
      currentProxyEnabled,
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
    getModelQuotaStateForTest: (nowMs) => ({
      state: {
        accountScopeKey: quotaState.accountScopeKey,
        collectorVersion: quotaState.collectorVersion,
        browsePoolKey: quotaState.browsePoolKey,
        busy: quotaState.busy,
        lastFetchedAtMs: quotaState.lastFetchedAtMs,
        lastSuccessAtMs: quotaState.lastSuccessAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        error: quotaState.error,
        errorKind: quotaState.errorKind,
        activeSessionModelKey
      },
      view: computeEffectiveQuotaView(Number.isFinite(nowMs) ? nowMs : Date.now())
    }),
    setPendingUpdateRestartForTest: (val) => {
      pendingUpdateRestart = Boolean(val);
      renderQuotaBoard(Date.now(), { animate: false });
    },
    setQuotaSnapshotForTest: (payload, nowMs) => {
      const tNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (!payload) {
        resetQuotaState({ clearAccountScope: true });
        return computeEffectiveQuotaView(tNow);
      }
      const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
      if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
        resetQuotaState({ clearAccountScope: true });
      }
      if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
      quotaState.error = payload.error || null;
      quotaState.errorKind = payload.errorKind || (payload.error ? 'network' : null);
      if (payload.fetchedAtMs !== undefined) quotaState.lastFetchedAtMs = payload.fetchedAtMs;
      if (payload.lastSuccessAtMs !== undefined) quotaState.lastSuccessAtMs = payload.lastSuccessAtMs;
      if (payload.nextRefreshAtMs !== undefined) quotaState.nextRefreshAtMs = payload.nextRefreshAtMs;
      if (payload.userStatusRes || payload.quotaSummaryRes || payload.cascadeModelConfigs) {
        const fallbackCfgs = (Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0)
          ? state.cascadeModelConfigs
          : null;
        quotaState.rawInput = {
          userStatusRes: payload.userStatusRes || null,
          quotaSummaryRes: payload.quotaSummaryRes || null,
          cascadeModelConfigs: (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0)
            ? payload.cascadeModelConfigs
            : fallbackCfgs,
          planStatus: payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || null
        };
        quotaState.snapshot = null;
        if (!payload.error && payload.lastSuccessAtMs === undefined) quotaState.lastSuccessAtMs = tNow;
      } else if (payload.snapshot !== undefined) {
        quotaState.snapshot = payload.snapshot;
        quotaState.rawInput = null;
        if (!payload.error && payload.lastSuccessAtMs === undefined && payload.snapshot?.fetchedAtMs) {
          quotaState.lastSuccessAtMs = payload.snapshot.fetchedAtMs;
        }
      }
      const nextSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
      const shouldAnimate = Boolean(prevSig !== 'empty' && nextSig !== prevSig && !quotaState.error);
      renderQuotaBoard(tNow, { animate: shouldAnimate });
      return computeEffectiveQuotaView(tNow);
    },
    refreshQuotaForTest: (force = false, meta = {}) => syncQuotaFromHost(Boolean(force), meta),
    selectQuotaPoolBrowseForTest: (poolKey) => {
      quotaState.browsePoolKey = poolKey || null;
      renderQuotaBoard();
      return { browsePoolKey: quotaState.browsePoolKey, activeSessionModelKey };
    },
    showQuotaPanelForTest: (open = true) => {
      showPanel(open ? 'quota' : 'none');
      return !el('panel-quota')?.hidden;
    },
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls, sessionCostTotal: state.sessionCostTotal }),
    captureHotReloadState,
    verifyHotReloadAndRefreshQuota,
    getBackendStatusForTest: () => ({
      ...backendStatus,
      collectorVersion: quotaState.collectorVersion,
      pendingUpdateRestart,
      hasLiveHttpBridge: hasLiveHttpBridge(),
      shouldPreferLiveHost: shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/quota')
    }),
    getRuntimeVersionReport: () => ({
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    }),
    getLatestCallCardStateForTest: () => ({
      route: state.route,
      displayedCall: state.displayedCallRecord,
      pendingLatestCall: state.pendingLatestCallRecord,
      pinnedCall: state.pinnedCallRecord,
      detailOpen: state.latestCallDetailOpen,
      historyOpen: state.historyDrawerOpen,
      bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden),
      isEntering: Boolean(el('latest-call-body')?.classList?.contains?.('is-entering'))
    }),
    setSessionCallsForTest: (calls, opts = {}) => {
      if (opts.route && state.route !== opts.route) {
        state.route = opts.route;
        state.displayedCallRecord = null;
        state.displayedCallSig = '';
        state.pendingLatestCallRecord = null;
        state.pinnedCallRecord = null;
        state.latestCallDetailOpen = false;
        state.lastAnimatedCallSig = '';
      }
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      if (opts.replace) state.sessionCallsMap.clear();
      for (const c of (Array.isArray(calls) ? calls : [])) {
        if (c && c.callId) state.sessionCallsMap.set(c.callId, c);
      }
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      render();
      return {
        displayedCall: state.displayedCallRecord,
        pendingLatestCall: state.pendingLatestCallRecord,
        bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden)
      };
    },
    setSessionTimelineForTest: (tl) => {
      state.sessionTimeline = tl;
      if (state.historyDrawerOpen) renderSessionTimeline();
    },
    toggleSessionHistoryForTest: (open) => {
      state.historyDrawerOpen = open !== undefined ? Boolean(open) : !state.historyDrawerOpen;
      renderSessionTimeline();
      return state.historyDrawerOpen;
    },
    setSpeedEvaluationForTest: (mockInput, opts = {}) => {
      state.speedOverrideForTest = mockInput || null;
      if (opts.openBreakdown !== undefined) state.speedBreakdownOpen = Boolean(opts.openBreakdown);
      if (typeof evaluateGenerationExperience === 'function') {
        const res = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
        renderSpeedExperienceInPlace(res);
        return res;
      }
      return null;
    },
    getSpeedPanelStateForTest: () => ({
      badgeText: el('speed-badge')?.textContent || '',
      badgeColor: el('speed-badge')?.style?.color || '',
      boltColor: el('badge-speed-icon')?.style?.color || '',
      summaryBoltColor: el('speed-summary-bolt')?.style?.color || '',
      speedVal: el('speed-val')?.textContent || '',
      durationVal: el('speed-duration')?.textContent || '',
      ttftVal: el('speed-ttft')?.textContent || '',
      tokensVal: el('speed-tokens')?.textContent || '',
      subLabel: el('speed-sub-label')?.textContent || '',
      takeaway: el('speed-takeaway')?.textContent || '',
      topSpeedText: el('speed-amount')?.textContent || '',
      topSpeedPhase: el('badge-speed')?.getAttribute?.('data-speed-phase') || null,
      topWaitSvgVisible: Boolean(el('badge-speed-wait-svg') && !el('badge-speed-wait-svg').hidden),
      breakdownOpen: state.speedBreakdownOpen,
      lastEval: state.lastSpeedEval
    }),
    setDockPosition: (mode, opts = {}) => setDockPosition(mode, opts),
    getDockPosition: () => ({ dockPosition, actualDock: host.getAttribute('data-dock'), fallbackReason: dockFallbackReason }),
    setQuotaBadgeWindowMode: (mode, opts = {}) => setQuotaBadgeWindowMode(mode, opts),
    getQuotaBadgeWindowMode: () => quotaBadgeWindowMode,
    getTokenCacheBreakdownForTest: () => ({
      input: el('tcb-input-val')?.textContent || '',
      cacheRead: el('tcb-cache-val')?.textContent || '',
      totalInput: el('tcb-total-input-val')?.textContent || '',
      output: el('tcb-output-val')?.textContent || '',
      ratio: el('tcb-ratio-val')?.textContent || '',
      ratioBarWidth: el('tcb-ratio-bar-fill')?.style?.width || '',
      note: el('tcb-note')?.textContent || ''
    }),
    getModelUsageScaleForTest: () => ({
      scaleMode: modelUsageScaleMode,
      lockedKey: modelUsageLockedKey,
      setScaleMode: (m) => { modelUsageScaleMode = m === 'linear' ? 'linear' : 'mixed'; renderModelUsageView(); },
      setLockedKey: (k) => { modelUsageLockedKey = k || null; renderModelUsageView(); }
    }),
    getCumulativeViewStateForTest: () => ({
      summary: _lastCumSummary,
      lockedKey: cumLockedKey,
      expandedWeekKey: cumExpandedWeekKey,
      linkedDailyDate: cumLinkedDailyDate,
      pressEscape: () => escape({ key: 'Escape' })
    }),
    setTokenAccountFilterForTest: (scopeKey) => {
      activeTokenAccountFilter = scopeKey || 'all';
      resetAccountScopedViewOffsets();
      if (ANTIGRAVITY_TOKEN_DATA.rawPayload) applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
      return activeTokenAccountFilter;
    },
    getRemoveAccountModalStateForTest: () => ({ ...(accountsUiState.removeModal || {}) }),
    openRemoveAccountModalForTest: (acc) => openRemoveAccountModal(acc),
    confirmRemoveAccountModalForTest: () => confirmRemoveAccountModal(),
    closeRemoveAccountModalForTest: () => closeRemoveAccountModal(),
    setAccountsOverviewForTest: (overview) => {
      accountsUiState.overview = overview || null;
      renderAccountsOverviewSection();
      return accountsUiState.overview;
    },
    getAccountsPanelStateForTest: () => ({
      activeFilter: activeTokenAccountFilter,
      filterOptions: Array.from(el('token-account-select')?.children || []).map(o => ({ val: o.value, label: o.textContent })),
      scopeNote: el('token-account-scope-note')?.textContent || '',
      feedback: accountsUiState.feedback || '',
      feedbackTone: accountsUiState.feedbackTone || 'info',
      accountCount: el('quota-accounts-list')?.children?.length || 0,
      compareCount: el('quota-compare-list')?.children?.length || 0,
      autoSwitchStatus: el('auto-switch-status-pill')?.textContent || '',
      keepaliveStatus: el('keepalive-status-pill')?.textContent || ''
    }),
    isDisposedForTest: () => Boolean(state.disposed),
    dispose() {
      earlyForceDispose();
      clearQuotaTimers();
      clearInterval(timer);
      clearLivePendingRequestWait();
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      try { globalThis.removeEventListener?.('popstate', scheduleImmediateRouteTick); } catch { }
      try {
        if (wrappedPushState && globalThis.history?.pushState === wrappedPushState && origPushState) {
          globalThis.history.pushState = origPushState;
        }
        if (wrappedReplaceState && globalThis.history?.replaceState === wrappedReplaceState && origReplaceState) {
          globalThis.history.replaceState = origReplaceState;
        }
      } catch { }
      syncHostStackingElevation(false);
      try { uninstallRequestInterceptor(); } catch { }
      try { themeObserver?.disconnect(); } catch { }
      try {
        window.removeEventListener?.('mousemove', onPointerMove);
        window.removeEventListener?.('mouseup', onPointerUp);
      } catch { }
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch { }
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch { }
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  if (el('v-tokens')) el('v-tokens').textContent = formatDisplayVersion(METER_RENDERER_VERSION);
  syncDockPositionUi();
  syncQuotaWindowModeUi();
  applyStaticPanelTranslations(shadow);
  refreshRegionPresetSelectOptions();
  renderEnhanceSectionUI();
  if (inheritedHotReloadState) {
    applyInheritedHotReloadState(inheritedHotReloadState);
  }
  startupRestorePromise = restoreSettingsFromHost().finally(() => {
    startupRestorePromise = null;
    if (inheritedHotReloadState) {
      applyInheritedHotReloadState(inheritedHotReloadState);
      inheritedHotReloadState = null;
    }
  });
  installRequestInterceptor();
  __chartsReady = true;
  render();
  tick();
})();

