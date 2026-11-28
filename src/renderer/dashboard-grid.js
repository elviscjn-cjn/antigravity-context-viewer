// =========================================================================
// 模块: 12 列自适应自由拖拽驾驶舱引擎 (5 套预设 · 长按/手柄拖拽 · 尺寸持久化)
// =========================================================================
const SESSION_COCKPIT_STORAGE_KEY = 'ag_session_cockpit_layout_v1';

const COCKPIT_WIDGET_DEFS = Object.freeze([
  { id: 'overview-kpi', titleKey: 'session.widget.overviewKpi', defaultSpan: 12, defaultHeight: 'standard', fixedCompact: false },
  { id: 'token-breakdown', titleKey: 'session.widget.tokenBreakdown', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'request-cost', titleKey: 'session.widget.requestCost', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'timing-speed', titleKey: 'session.widget.timingSpeed', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'trend-pulse', titleKey: 'session.widget.trendPulse', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'context-inspector', titleKey: 'session.widget.contextInspector', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'execution-trace', titleKey: 'session.widget.executionTrace', defaultSpan: 12, defaultHeight: 'standard', fixedCompact: false },
  { id: 'context-events', titleKey: 'session.widget.contextEvents', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'file-radar', titleKey: 'session.widget.fileRadar', defaultSpan: 6, defaultHeight: 'standard', fixedCompact: false },
  { id: 'command-audit', titleKey: 'session.widget.commandAudit', defaultSpan: 12, defaultHeight: 'standard', fixedCompact: false },
  { id: 'agent-collab', titleKey: 'session.widget.agentCollab', defaultSpan: 12, defaultHeight: 'standard', fixedCompact: false },
  { id: 'tech-drawer', titleKey: 'session.widget.techDrawer', defaultSpan: 12, defaultHeight: 'compact', fixedCompact: true }
]);

const COCKPIT_VALID_WIDGET_IDS = new Set(COCKPIT_WIDGET_DEFS.map(d => d.id));
const COCKPIT_VALID_SPANS = [3, 4, 6, 8, 12];
const COCKPIT_VALID_HEIGHTS = ['compact', 'standard', 'expanded'];
const COCKPIT_MIN_WIDTH = 72;
const COCKPIT_MIN_HEIGHT = 48;
const COCKPIT_MAX_HEIGHT = 1600;
const COCKPIT_FLIP_EASING = 'cubic-bezier(0.2, 1.08, 0.32, 1)';
// 2D 自由画布 + Skyline 自动排版参数
const COCKPIT_SKYLINE_GAP = 10;
const COCKPIT_SINGLE_COLUMN_BREAKPOINT = 520;
const COCKPIT_SINGLE_COLUMN_HYSTERESIS_PX = 14;
const COCKPIT_ROW_SLIVER_PX = 24;
const COCKPIT_CARD_COMPACT_MAX = 360;
const COCKPIT_CARD_WIDE_MIN = 560;
const COCKPIT_CARD_SIZE_HYSTERESIS_PX = 10;
const COCKPIT_MAGNET_DISTANCE = 6;
const COCKPIT_MAGNET_PREVIEW_DISTANCE = 28;
let cockpitLayoutTraceEnabled = false;
const cockpitLayoutTraceLog = [];
let cockpitLayoutApplyCount = 0;
let cockpitLayoutLightResizeCount = 0;
let cockpitLastSingleColumn = null;

function isWorkspacePaneResizingNow(grid = null) {
  try {
    if (typeof wsActiveDragging !== 'undefined' && wsActiveDragging) return true;
    if (grid?.getAttribute?.('data-pane-resizing') === 'true') return true;
    const panelEl = typeof el === 'function' ? el('panel') : null;
    if (panelEl?.getAttribute?.('data-pane-resizing') === 'true') return true;
    if (typeof host !== 'undefined' && host?.getAttribute?.('data-pane-resizing') === 'true') return true;
    if (typeof document !== 'undefined' && document?.documentElement?.getAttribute?.('data-pane-resizing') === 'true') return true;
  } catch { }
  return false;
}

function getCockpitPerfStatsForTest() {
  return {
    applyCount: cockpitLayoutApplyCount,
    lightResizeCount: cockpitLayoutLightResizeCount,
    lastSingleColumn: cockpitLastSingleColumn
  };
}

function resetCockpitPerfStatsForTest() {
  cockpitLayoutApplyCount = 0;
  cockpitLayoutLightResizeCount = 0;
}

function nearestCockpitGuide(proposals, preview = false) {
  let best = null;
  for (const proposal of proposals) {
    const distance = Math.abs(proposal.delta);
    if (distance > (preview && proposal.pair ? COCKPIT_MAGNET_PREVIEW_DISTANCE : COCKPIT_MAGNET_DISTANCE)) continue;
    const priority = distance <= COCKPIT_MAGNET_DISTANCE ? (proposal.pair ? 0 : 1) : 2;
    if (!best || priority < best.priority || (priority === best.priority && distance < best.distance)) {
      best = { ...proposal, distance, priority, snapped: distance <= COCKPIT_MAGNET_DISTANCE };
    }
  }
  return best;
}

function cockpitResizeMagnets(drag, width, height, left, top) {
  const { gridW, fromLeft, fromTop, singleColumn, neighbors = [], fitGuides = [] } = drag;
  const right = left + width;
  const bottom = top + height;
  const edgeX = fromLeft ? left : right;
  const edgeY = fromTop ? top : bottom;
  const x = [], y = [];
  const addX = (at, pair = false, pairWidth = null, labelY = 0) => {
    const delta = pairWidth == null ? at - edgeX : (fromLeft ? width - pairWidth : pairWidth - width);
    const w = pairWidth ?? width + (fromLeft ? -delta : delta);
    if (w >= COCKPIT_MIN_WIDTH && w <= gridW) {
      x.push({ at, delta, pair, size: w, labelY });
    }
  };
  const addY = (at) => {
    const delta = at - edgeY;
    const h = height + (fromTop ? -delta : delta);
    if (h >= COCKPIT_MIN_HEIGHT && h <= COCKPIT_MAX_HEIGHT) y.push({ at, delta, size: h });
  };
  if (!singleColumn) {
    addX(fromLeft ? 0 : gridW);
    for (const guide of fitGuides) addX(guide.at, true, guide.width, guide.labelY);
  }
  addY(0);
  for (const neighbor of neighbors) {
    const { x: nx, y: ny, w: nw, h: nh } = neighbor;
    const nr = nx + nw;
    const nb = ny + nh;
    if (!singleColumn) {
      addX(nx);
      addX(nr);
      if (top < nb + COCKPIT_SKYLINE_GAP && ny < bottom + COCKPIT_SKYLINE_GAP) {
        addX(fromLeft ? nr + COCKPIT_SKYLINE_GAP : nx - COCKPIT_SKYLINE_GAP);
      }
    }
    if (left <= nr + COCKPIT_SKYLINE_GAP && nx <= right + COCKPIT_SKYLINE_GAP) {
      addY(ny);
      addY(nb);
      addY(fromTop ? nb + COCKPIT_SKYLINE_GAP : ny - COCKPIT_SKYLINE_GAP);
    }
  }
  return { x: nearestCockpitGuide(x, true), y: nearestCockpitGuide(y) };
}

function cockpitSideFitGuides(drag, boxes, index) {
  const { gridW, gridLeft, gridTop, startW, startH, fromLeft } = drag;
  const gap = COCKPIT_SKYLINE_GAP;
  const pack = width => packSkylineBoxes(boxes.map((box, i) => i === index ? { ...box, w: width } : box), gridW, gap);
  const guides = [];
  for (let i = 0; i < boxes.length; i++) {
    const neighbor = boxes[i];
    if (i === index || Math.abs(neighbor.y - gridTop) > Math.max(startH, neighbor.h) + gap) continue;
    const fits = [gridW - neighbor.w - gap, gridW - neighbor.x - neighbor.w - gap, neighbor.x - gridLeft - gap, gridLeft + startW - neighbor.x - neighbor.w - gap];
    for (const width of fits.map(Math.round)) {
      if (width < COCKPIT_MIN_WIDTH || width >= gridW || guides.some(guide => guide.width === width)) continue;
      const sideBySide = (placed) => {
        const card = placed[index];
        const other = placed[i];
        return card.y === other.y && card.y <= gridTop + gap;
      };
      const placed = pack(width);
      if (!sideBySide(placed) || sideBySide(pack(width + 1))) continue;
      const card = placed[index];
      const other = placed[i];
      const at = fromLeft ? card.x : card.x + card.w;
      guides.push({ at: Math.min(gridW - 1, at), width, labelY: Math.max(card.y, other.y) + 6 });
    }
  }
  return guides;
}

const COCKPIT_PRESET_LAYOUTS = Object.freeze({
  cockpit: {
    id: 'cockpit',
    labelKey: 'session.preset.cockpit',
    items: [
      { id: 'overview-kpi', span: 12, height: 'standard', visible: true },
      { id: 'token-breakdown', span: 6, height: 'standard', visible: true },
      { id: 'timing-speed', span: 6, height: 'standard', visible: true },
      { id: 'trend-pulse', span: 6, height: 'standard', visible: true },
      { id: 'context-inspector', span: 6, height: 'standard', visible: true },
      { id: 'execution-trace', span: 12, height: 'standard', visible: true },
      { id: 'context-events', span: 6, height: 'standard', visible: true },
      { id: 'file-radar', span: 6, height: 'standard', visible: true },
      { id: 'command-audit', span: 12, height: 'standard', visible: true },
      { id: 'agent-collab', span: 12, height: 'standard', visible: true },
      { id: 'tech-drawer', span: 12, height: 'compact', visible: true }
    ]
  },
  minimal: {
    id: 'minimal',
    labelKey: 'session.preset.minimal',
    items: [
      { id: 'overview-kpi', span: 12, height: 'standard', visible: true },
      { id: 'trend-pulse', span: 6, height: 'standard', visible: true },
      { id: 'timing-speed', span: 6, height: 'standard', visible: true },
      { id: 'context-inspector', span: 12, height: 'standard', visible: true },
      { id: 'token-breakdown', span: 6, height: 'standard', visible: false },
      { id: 'execution-trace', span: 12, height: 'standard', visible: false },
      { id: 'context-events', span: 6, height: 'standard', visible: false },
      { id: 'file-radar', span: 6, height: 'standard', visible: false },
      { id: 'command-audit', span: 12, height: 'standard', visible: false },
      { id: 'agent-collab', span: 12, height: 'standard', visible: false },
      { id: 'tech-drawer', span: 12, height: 'compact', visible: false }
    ]
  },
  debug: {
    id: 'debug',
    labelKey: 'session.preset.debug',
    items: [
      { id: 'overview-kpi', span: 12, height: 'standard', visible: true },
      { id: 'execution-trace', span: 12, height: 'expanded', visible: true },
      { id: 'trend-pulse', span: 12, height: 'standard', visible: true },
      { id: 'context-inspector', span: 6, height: 'expanded', visible: true },
      { id: 'context-events', span: 6, height: 'expanded', visible: true },
      { id: 'file-radar', span: 6, height: 'standard', visible: true },
      { id: 'command-audit', span: 6, height: 'standard', visible: true },
      { id: 'timing-speed', span: 12, height: 'standard', visible: true },
      { id: 'token-breakdown', span: 6, height: 'standard', visible: false },
      { id: 'agent-collab', span: 12, height: 'standard', visible: false },
      { id: 'tech-drawer', span: 12, height: 'compact', visible: false }
    ]
  },
  speed_cost: {
    id: 'speed_cost',
    labelKey: 'session.preset.speedCost',
    items: [
      { id: 'timing-speed', span: 6, height: 'expanded', visible: true },
      { id: 'token-breakdown', span: 6, height: 'expanded', visible: true },
      { id: 'request-cost', span: 6, height: 'standard', visible: true },
      { id: 'trend-pulse', span: 12, height: 'standard', visible: true },
      { id: 'overview-kpi', span: 6, height: 'standard', visible: true },
      { id: 'context-inspector', span: 6, height: 'standard', visible: true },
      { id: 'execution-trace', span: 12, height: 'standard', visible: false },
      { id: 'context-events', span: 6, height: 'standard', visible: false },
      { id: 'file-radar', span: 6, height: 'standard', visible: false },
      { id: 'command-audit', span: 12, height: 'standard', visible: false },
      { id: 'agent-collab', span: 12, height: 'standard', visible: false },
      { id: 'tech-drawer', span: 12, height: 'compact', visible: false }
    ]
  },
  collab: {
    id: 'collab',
    labelKey: 'session.preset.collab',
    items: [
      { id: 'agent-collab', span: 12, height: 'expanded', visible: true },
      { id: 'execution-trace', span: 12, height: 'standard', visible: true },
      { id: 'overview-kpi', span: 6, height: 'standard', visible: true },
      { id: 'context-events', span: 6, height: 'standard', visible: true },
      { id: 'file-radar', span: 6, height: 'standard', visible: true },
      { id: 'command-audit', span: 6, height: 'standard', visible: true },
      { id: 'token-breakdown', span: 6, height: 'standard', visible: false },
      { id: 'timing-speed', span: 6, height: 'standard', visible: false },
      { id: 'trend-pulse', span: 6, height: 'standard', visible: false },
      { id: 'context-inspector', span: 6, height: 'standard', visible: false },
      { id: 'tech-drawer', span: 12, height: 'compact', visible: false }
    ]
  }
});

let sessionCockpitLayout = null;
let cockpitManagerOpen = false;
let cockpitDragCleanup = null;
let cancelCockpitManagerDrag = null;
let stopCockpitManagerPositioning = null;

const BUILTIN_COCKPIT_PRESET_IDS = Object.freeze(['cockpit', 'minimal', 'debug', 'speed_cost', 'collab']);

function normalizeCockpitPresetOrder(rawOrder, customPresets = [], deletedPresetIds = []) {
  const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
  if (upg && typeof upg.normalizePresetCatalog === 'function') {
    const cat = upg.normalizePresetCatalog({
      presetOrder: rawOrder,
      customPresets,
      deletedPresetIds
    }, BUILTIN_COCKPIT_PRESET_IDS);
    return Array.isArray(cat?.order) ? cat.order : [];
  }
  const deletedSet = new Set((Array.isArray(deletedPresetIds) ? deletedPresetIds : []).map(id => String(id || '').trim()).filter(Boolean));
  const customIds = Array.isArray(customPresets) ? customPresets.map(p => String(p?.id || '').trim()).filter(Boolean) : [];
  const activeBuiltins = BUILTIN_COCKPIT_PRESET_IDS.filter(id => !deletedSet.has(id));
  const validIds = new Set([...activeBuiltins, ...customIds]);
  const seen = new Set();
  const out = [];
  for (const rawId of (Array.isArray(rawOrder) ? rawOrder : [])) {
    const pid = typeof rawId === 'string' ? rawId.trim() : '';
    if (!pid || !validIds.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  for (const bId of activeBuiltins) {
    if (!seen.has(bId)) { seen.add(bId); out.push(bId); }
  }
  for (const cId of customIds) {
    if (!seen.has(cId)) { seen.add(cId); out.push(cId); }
  }
  return out;
}

function normalizeCockpitFreeRect(rawRect) {
  if (!rawRect || typeof rawRect !== 'object' || Array.isArray(rawRect)) return null;
  const x = Number(rawRect.x);
  const y = Number(rawRect.y);
  const w = Number(rawRect.w);
  const h = Number(rawRect.h);
  const xRatio = Number(rawRect.xRatio);
  const wRatio = Number(rawRect.wRatio);
  const baseW = Number(rawRect.baseW);
  const hasPixels = Number.isFinite(w) && w >= COCKPIT_MIN_WIDTH && Number.isFinite(h) && h >= COCKPIT_MIN_HEIGHT;
  const hasRatios = Number.isFinite(wRatio) && wRatio > 0 && wRatio <= 1 && Number.isFinite(h) && h >= COCKPIT_MIN_HEIGHT;
  if (!hasPixels && !hasRatios) return null;
  const safeBaseW = Number.isFinite(baseW) && baseW > 0 ? Math.round(baseW) : null;
  const safeW = hasPixels ? Math.max(COCKPIT_MIN_WIDTH, Math.round(w)) : (safeBaseW ? Math.max(COCKPIT_MIN_WIDTH, Math.round(wRatio * safeBaseW)) : COCKPIT_MIN_WIDTH);
  const safeH = Math.max(COCKPIT_MIN_HEIGHT, Math.min(COCKPIT_MAX_HEIGHT, Math.round(h)));
  const safeX = Number.isFinite(x) ? Math.max(0, Math.round(x)) : (safeBaseW && Number.isFinite(xRatio) ? Math.max(0, Math.round(xRatio * safeBaseW)) : 0);
  const safeY = Number.isFinite(y) ? Math.max(0, Math.round(y)) : 0;
  const safeXRatio = Number.isFinite(xRatio) && xRatio >= 0 && xRatio <= 1
    ? Math.round(xRatio * 10000) / 10000
    : (safeBaseW ? Math.round(Math.max(0, Math.min(1, safeX / safeBaseW)) * 10000) / 10000 : 0);
  const safeWRatio = Number.isFinite(wRatio) && wRatio > 0 && wRatio <= 1
    ? Math.round(wRatio * 10000) / 10000
    : (safeBaseW ? Math.round(Math.max(0.04, Math.min(1, safeW / safeBaseW)) * 10000) / 10000 : 1);
  return {
    x: safeX,
    y: safeY,
    w: safeW,
    h: safeH,
    xRatio: safeXRatio,
    wRatio: safeWRatio,
    ...(safeBaseW ? { baseW: safeBaseW } : {})
  };
}

function clampFreestyleRectForGrid(rect, containerWidth, opts = {}) {
  const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
  if (upg && typeof upg.clampFreestyleRect === 'function') {
    return upg.clampFreestyleRect(rect, containerWidth, {
      minWidth: COCKPIT_MIN_WIDTH,
      minHeight: COCKPIT_MIN_HEIGHT,
      maxHeight: COCKPIT_MAX_HEIGHT,
      ...opts
    });
  }
  const cw = Math.max(1, Math.floor(Number(containerWidth) || 0));
  const minW = Math.min(Number(opts.minWidth) || COCKPIT_MIN_WIDTH, cw);
  const minH = Number(opts.minHeight) || COCKPIT_MIN_HEIGHT;
  const maxH = Number(opts.maxHeight) || COCKPIT_MAX_HEIGHT;
  const w = Math.max(minW, Math.min(cw, Math.round(Number(rect?.w) || cw)));
  const h = Math.max(minH, Math.min(maxH, Math.round(Number(rect?.h) || minH)));
  const x = Math.max(0, Math.min(cw - w, Math.round(Number(rect?.x) || 0)));
  const y = Math.max(0, Math.round(Number(rect?.y) || 0));
  return { x, y, w, h };
}

function buildDefaultCockpitLayout(presetId = 'cockpit') {
  const safeId = Object.prototype.hasOwnProperty.call(COCKPIT_PRESET_LAYOUTS, presetId) ? presetId : 'cockpit';
  const base = COCKPIT_PRESET_LAYOUTS[safeId];
  return {
    version: 1,
    presetId: safeId,
    presetOrder: [...BUILTIN_COCKPIT_PRESET_IDS],
    widgets: [...base.items, ...COCKPIT_WIDGET_DEFS.filter(def => !base.items.some(it => it.id === def.id))
      .map(def => ({ id: def.id, span: def.defaultSpan, height: def.defaultHeight, visible: false }))].map(it => ({
      id: it.id,
      span: COCKPIT_VALID_SPANS.includes(Number(it.span)) ? Number(it.span) : 12,
      height: COCKPIT_VALID_HEIGHTS.includes(it.height) ? it.height : 'standard',
      visible: it.visible !== false,
      customHeightPx: null
    }))
  };
}

function normalizeCockpitLayout(raw, includePresets = true) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildDefaultCockpitLayout('cockpit');
  }
  const presetId = Object.prototype.hasOwnProperty.call(COCKPIT_PRESET_LAYOUTS, raw.presetId)
    ? raw.presetId
    : 'cockpit';
  const base = buildDefaultCockpitLayout(presetId);
  const hasExplicitModules = Array.isArray(raw.modules);
  const explicitModulesSet = hasExplicitModules
    ? new Set(raw.modules.map(m => String(m || '').trim()).filter(id => COCKPIT_VALID_WIDGET_IDS.has(id)))
    : null;
  // 严格区分「用户主动删空 / 显式新建 0 模块空分组」与「首次初始化 / 缺失字段的旧配置」：
  // 仅当显式声明 emptyGroup === true、userClearedAll === true 或 emptyPresetCatalog === true 时才允许 0 模块空态
  const isExplicitEmptyGroup = Boolean(
    raw.emptyGroup === true
    || raw.userClearedAll === true
    || raw.emptyPresetCatalog === true
  );
  let srcList = Array.isArray(raw.widgets) ? raw.widgets : [];
  if (srcList.length === 0 && Array.isArray(raw.order) && raw.order.length > 0) {
    const hiddenSet = new Set(Array.isArray(raw.hiddenIds) ? raw.hiddenIds : []);
    srcList = raw.order.map(id => ({
      id,
      span: raw.spans?.[id],
      height: raw.heights?.[id],
      visible: hasExplicitModules && (explicitModulesSet.size > 0 || isExplicitEmptyGroup)
        ? explicitModulesSet.has(id)
        : (isExplicitEmptyGroup ? false : !hiddenSet.has(id)),
      customHeightPx: raw.heightPx?.[id] ?? null
    }));
  }
  if (srcList.length === 0) {
    srcList = isExplicitEmptyGroup
      ? base.widgets.map(w => ({ ...w, visible: false }))
      : (hasExplicitModules && explicitModulesSet.size > 0
        ? base.widgets.map(w => ({ ...w, visible: explicitModulesSet.has(w.id) }))
        : base.widgets);
  }

  const baseMap = new Map(base.widgets.map(w => [w.id, w]));
  const seen = new Set();
  const normalized = [];

  for (const item of srcList) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!COCKPIT_VALID_WIDGET_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    const fb = baseMap.get(id) || { span: 12, height: 'standard', visible: true };
    const spanNum = Number(item.span);
    const customWidth = item.customWidth === true && Number.isInteger(spanNum) && spanNum >= 1 && spanNum <= 12;
    const span = customWidth || COCKPIT_VALID_SPANS.includes(spanNum) ? spanNum : fb.span;
    const height = COCKPIT_VALID_HEIGHTS.includes(item.height) ? item.height : fb.height;
    const visible = typeof item.visible === 'boolean'
      ? item.visible
      : (hasExplicitModules && (explicitModulesSet.size > 0 || isExplicitEmptyGroup)
        ? explicitModulesSet.has(id)
        : (isExplicitEmptyGroup ? false : fb.visible));
    const rawPx = Number(item.customHeightPx ?? item.heightPx);
    const customHeightPx = Number.isFinite(rawPx) && rawPx >= COCKPIT_MIN_HEIGHT
      ? Math.max(COCKPIT_MIN_HEIGHT, Math.min(COCKPIT_MAX_HEIGHT, Math.round(rawPx)))
      : null;
    // 自由缩放宽度原样保留（有限数值且落在 (0, 1]），解除不合理的最小宽高硬锁
    const rawRatio = Number(item.widthRatio);
    const widthRatio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1
      ? rawRatio
      : null;
    const freeRect = normalizeCockpitFreeRect(item.freeRect);
    normalized.push({
      id,
      span,
      height,
      visible,
      customHeightPx,
      ...(customWidth ? { customWidth } : {}),
      ...(widthRatio != null ? { widthRatio } : {}),
      ...(customHeightPx != null ? { heightPx: customHeightPx } : {}),
      ...(freeRect ? { freeRect } : {})
    });
  }

  for (const fb of base.widgets) {
    if (!seen.has(fb.id)) {
      const nextVis = hasExplicitModules && (explicitModulesSet.size > 0 || isExplicitEmptyGroup)
        ? explicitModulesSet.has(fb.id)
        : (isExplicitEmptyGroup ? false : fb.visible);
      const index = fb.id === 'request-cost' && presetId === 'speed_cost'
        ? normalized.findIndex(item => item.id === 'token-breakdown') : -1;
      const entry = { ...fb, visible: nextVis };
      if (index >= 0) normalized.splice(index + 1, 0, entry);
      else normalized.push(entry);
    }
  }

  // 防初次打开误显空态：非显式空分组 / 非用户主动清零时，若全部模块意外为 false，自动恢复该预设默认模块集
  let visibleModules = normalized.filter(w => w.visible).map(w => w.id);
  if (visibleModules.length === 0 && !isExplicitEmptyGroup) {
    for (const w of normalized) {
      const fb = baseMap.get(w.id);
      w.visible = fb ? fb.visible !== false : true;
    }
    visibleModules = normalized.filter(w => w.visible).map(w => w.id);
  }
  const allHidden = visibleModules.length === 0;
  const hasFreestyle = normalized.some(w => w.visible && w.freeRect);
  const result = {
    version: 1,
    presetId,
    widgets: normalized,
    modules: visibleModules,
    layoutMode: hasFreestyle ? 'freestyle' : 'flow',
    ...(allHidden ? { emptyGroup: true } : {}),
    ...(allHidden && raw.userClearedAll === true ? { userClearedAll: true } : {})
  };
  if (!includePresets) return result;
  const seenPresets = new Set();
  const customPresets = [];
  if (Array.isArray(raw.customPresets)) {
    for (const item of raw.customPresets) {
      const id = String(item?.id || '');
      const name = String(item?.name || '').replace(/[（）()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!/^custom-[\w-]{1,72}$/.test(id) || !name || seenPresets.has(id)) continue;
      seenPresets.add(id);
      customPresets.push({ ...normalizeCockpitLayout(item, false), id, name });
    }
    if (customPresets.length) result.customPresets = customPresets;
    if (seenPresets.has(raw.activeCustomId)) result.activeCustomId = raw.activeCustomId;
  }
  const deletedPresetIds = Array.isArray(raw.deletedPresetIds)
    ? Array.from(new Set(raw.deletedPresetIds.map(id => String(id || '').trim()).filter(id => BUILTIN_COCKPIT_PRESET_IDS.includes(id))))
    : [];
  if (deletedPresetIds.length) result.deletedPresetIds = deletedPresetIds;
  result.presetOrder = normalizeCockpitPresetOrder(raw.presetOrder, customPresets, deletedPresetIds);
  if (result.presetOrder.length === 0) {
    result.presetId = null;
    result.emptyPresetCatalog = true;
  } else if (!result.activeCustomId && !result.presetOrder.includes(result.presetId)) {
    const firstId = result.presetOrder[0];
    if (seenPresets.has(firstId)) result.activeCustomId = firstId;
    else result.presetId = firstId;
  }
  return result;
}

function createPresetSixDotGripElement() {
  const grip = document.createElement('span');
  grip.className = 'ctx-preset-grip ag-preset-handle';
  grip.setAttribute('aria-hidden', 'true');
  try {
    grip.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg>';
  } catch {
    grip.textContent = '⋮⋮';
  }
  return grip;
}

function createPresetAddButtonElement() {
  const btn = document.createElement('button');
  btn.id = 'btn-ctx-preset-new-group';
  btn.type = 'button';
  btn.className = 'ag-preset-add-btn';
  btn.setAttribute('data-custom-preset-action', 'new-empty-group');
  const plus = document.createElement('span');
  plus.className = 'ag-preset-add-plus';
  plus.setAttribute('aria-hidden', 'true');
  plus.textContent = '+';
  const lbl = document.createElement('span');
  lbl.className = 'ag-preset-add-label';
  lbl.setAttribute('data-i18n', 'session.preset.newGroup');
  lbl.textContent = t('session.preset.newGroup');
  btn.appendChild?.(plus);
  btn.appendChild?.(lbl);
  return btn;
}

let presetDragInProgress = false;
let lastCommittedPresetOrderAt = 0;

function ensurePresetUpgradeStyleInjected() {
  try {
    const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
    if (!upg || typeof upg.PRESET_UPGRADE_CSS !== 'string') return;
    const rootNode = (typeof shadow !== 'undefined' && shadow) || (typeof document !== 'undefined' ? document.head : null);
    if (!rootNode || typeof rootNode.querySelector !== 'function' || typeof document === 'undefined') return;
    if (rootNode.querySelector('#ag-preset-board-upgrades-style')) return;
    const st = document.createElement('style');
    st.id = 'ag-preset-board-upgrades-style';
    st.textContent = upg.PRESET_UPGRADE_CSS;
    rootNode.appendChild?.(st);
  } catch { }
}

function renderCockpitPresetsTrack(layout) {
  if (presetDragInProgress) return;
  ensurePresetUpgradeStyleInjected();
  const track = el('ctx-cockpit-presets-track') || el('ctx-cockpit-toolbar')?.querySelector?.('.ctx-cockpit-presets');
  const activeId = layout.activeCustomId || layout.presetId;
  const deletedPresetIds = Array.isArray(layout.deletedPresetIds) ? layout.deletedPresetIds : [];
  const customList = Array.isArray(layout.customPresets) ? layout.customPresets : [];
  const order = normalizeCockpitPresetOrder(layout.presetOrder, customList, deletedPresetIds);
  const langTag = typeof currentLang !== 'undefined' ? String(currentLang) : (typeof lang !== 'undefined' ? String(lang) : 'zh-CN');
  if (track) {
    const customMap = new Map(customList.map(c => [c.id, c]));
    const sig = JSON.stringify([langTag, activeId, order, deletedPresetIds, customList.map(c => [c.id, c.name])]);
    if (track._presetTrackSignature !== sig) {
      track._presetTrackSignature = sig;
      const builtinBtnIdMap = {
        cockpit: 'btn-preset-cockpit',
        minimal: 'btn-preset-minimal',
        debug: 'btn-preset-debug',
        speed_cost: 'btn-preset-speed-cost',
        collab: 'btn-preset-collab'
      };
      const existingById = new Map();
      if (typeof track.querySelectorAll === 'function') {
        for (const btn of Array.from(track.querySelectorAll('[data-cockpit-preset]'))) {
          const pid = btn.getAttribute?.('data-cockpit-preset');
          if (pid && !existingById.has(pid)) existingById.set(pid, btn);
        }
      }
      for (const [pid, domId] of Object.entries(builtinBtnIdMap)) {
        if (!existingById.has(pid)) {
          const found = el(domId);
          if (found) {
            found.setAttribute?.('data-cockpit-preset', pid);
            existingById.set(pid, found);
          }
        }
      }
      const items = [];
      for (let i = 0; i < order.length; i++) {
        const pid = order[i];
        const meta = COCKPIT_PRESET_LAYOUTS[pid];
        const customMeta = customMap.get(pid);
        if (!meta && !customMeta) continue;
        let btn = existingById.get(pid);
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ctx-preset-btn ctx-preset-pill ag-preset-pill';
          btn.setAttribute('data-cockpit-preset', pid);
        } else {
          btn.classList?.add?.('ctx-preset-btn', 'ctx-preset-pill', 'ag-preset-pill');
        }
        const labelText = customMeta ? customMeta.name : (meta ? t(meta.labelKey) : pid);
        if (customMeta) {
          btn.title = customMeta.name;
          btn.setAttribute?.('data-custom-preset', 'true');
        } else if (meta) {
          btn.removeAttribute?.('data-custom-preset');
        }
        if (typeof document.createElement === 'function' && typeof btn.replaceChildren === 'function' && btn.tagName) {
          let labelSpan = btn.querySelector?.('.ctx-preset-label');
          if (!labelSpan) {
            const grip = createPresetSixDotGripElement();
            labelSpan = document.createElement('span');
            labelSpan.className = 'ctx-preset-label ag-preset-label';
            btn.textContent = '';
            btn.replaceChildren(grip, labelSpan);
          }
          if (meta && !customMeta) {
            labelSpan.setAttribute?.('data-i18n', meta.labelKey);
            btn.removeAttribute?.('data-i18n');
          } else {
            labelSpan.removeAttribute?.('data-i18n');
          }
          labelSpan.textContent = labelText;
        } else {
          btn.textContent = labelText;
        }
        const isAct = pid === activeId;
        btn.setAttribute?.('aria-pressed', isAct ? 'true' : 'false');
        btn.classList?.toggle?.('active', isAct);
        btn.classList?.toggle?.('is-active', isAct);
        items.push(btn);
      }
      let addBtn = el('btn-ctx-preset-new-group') || track.querySelector?.('.ag-preset-add-btn');
      if (!addBtn && typeof document.createElement === 'function') {
        addBtn = createPresetAddButtonElement();
      } else if (addBtn) {
        addBtn.classList?.add?.('ag-preset-add-btn');
        addBtn.setAttribute?.('data-custom-preset-action', 'new-empty-group');
        const lbl = addBtn.querySelector?.('.ag-preset-add-label');
        if (lbl) {
          lbl.textContent = t('session.preset.newGroup');
        } else if (typeof document.createElement === 'function' && typeof addBtn.replaceChildren === 'function' && addBtn.tagName) {
          const plus = document.createElement('span');
          plus.className = 'ag-preset-add-plus';
          plus.setAttribute('aria-hidden', 'true');
          plus.textContent = '+';
          const nl = document.createElement('span');
          nl.className = 'ag-preset-add-label';
          nl.setAttribute('data-i18n', 'session.preset.newGroup');
          nl.textContent = t('session.preset.newGroup');
          addBtn.replaceChildren(plus, nl);
        } else {
          addBtn.textContent = t('session.preset.newGroup');
        }
      }
      if (addBtn) items.push(addBtn);
      if (typeof track.replaceChildren === 'function') {
        track.replaceChildren(...items);
      }
    }
  }
  const actions = el('ctx-custom-preset-actions');
  if (actions) {
    const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
    if (upg && typeof upg.normalizePresetCatalog === 'function' && typeof upg.syncPresetActionPillsDom === 'function') {
      const cat = upg.normalizePresetCatalog({
        presetOrder: order,
        customPresets: customList,
        deletedPresetIds,
        activeCustomId: layout.activeCustomId || null,
        presetId: layout.presetId || null
      }, BUILTIN_COCKPIT_PRESET_IDS);
      upg.syncPresetActionPillsDom(actions, cat, langTag);
    } else {
      actions.hidden = !activeId;
    }
  }
}

function renderCustomCockpitPresets(layout) {
  renderCockpitPresetsTrack(layout);
}

function createEmptyCustomCockpitGroup({ name = '', persist = true } = {}) {
  const layout = getCockpitLayout();
  const presets = layout.customPresets || [];
  const deletedPresetIds = Array.isArray(layout.deletedPresetIds) ? layout.deletedPresetIds : [];
  const curOrder = normalizeCockpitPresetOrder(layout.presetOrder, presets, deletedPresetIds);
  const existingNames = new Set(presets.map(p => String(p?.name || '').trim()));
  let finalName = String(name || '').replace(/[（）()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!finalName) {
    let seq = presets.length + 1;
    while (seq < 999) {
      const cand = t('session.preset.newGroupDefaultName', { n: seq });
      if (!existingNames.has(cand)) {
        finalName = cand;
        break;
      }
      seq += 1;
    }
    if (!finalName) finalName = `Group ${Date.now().toString(36)}`;
  }
  const id = `custom-${window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}`;
  const emptyWidgets = buildDefaultCockpitLayout('cockpit').widgets.map(w => ({ ...w, visible: false }));
  const entry = {
    id,
    name: finalName,
    presetId: 'cockpit',
    widgets: emptyWidgets,
    modules: [],
    emptyGroup: true
  };
  const nextCustoms = [...presets, entry];
  const nextOrder = normalizeCockpitPresetOrder([...curOrder, id], nextCustoms, deletedPresetIds);
  const saved = persistCockpitLayout({
    ...layout,
    presetId: 'cockpit',
    widgets: emptyWidgets,
    modules: [],
    emptyGroup: true,
    activeCustomId: id,
    customPresets: nextCustoms,
    deletedPresetIds,
    presetOrder: nextOrder
  }, { persistHost: persist });
  applyCockpitLayoutToDom();
  return saved;
}

function updateCustomCockpitPreset(action, name = '') {
  if (action === 'new-empty-group') {
    return createEmptyCustomCockpitGroup({ name, persist: true });
  }
  const layout = getCockpitLayout();
  const presets = layout.customPresets || [];
  const deletedPresetIds = Array.isArray(layout.deletedPresetIds) ? layout.deletedPresetIds : [];
  const active = presets.find(item => item.id === layout.activeCustomId);
  const activeTargetId = layout.activeCustomId || layout.presetId || null;
  const curOrder = normalizeCockpitPresetOrder(layout.presetOrder, presets, deletedPresetIds);
  const visibleModules = (layout.widgets || []).filter(w => w.visible).map(w => w.id);
  const emptyFlag = visibleModules.length === 0 ? { emptyGroup: true } : {};
  if (action === 'delete' && activeTargetId) {
    const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
    if (upg && typeof upg.deletePresetFromCatalog === 'function') {
      const delRes = upg.deletePresetFromCatalog({
        ...layout,
        customPresets: presets,
        deletedPresetIds,
        presetOrder: curOrder
      }, activeTargetId, BUILTIN_COCKPIT_PRESET_IDS);
      if (delRes?.changed && delRes.nextLayout) {
        if (delRes.nextActiveId) {
          return applyCockpitPreset(delRes.nextActiveId, {
            customPresets: delRes.nextLayout.customPresets || [],
            presetOrder: delRes.nextLayout.presetOrder || [],
            deletedPresetIds: delRes.nextLayout.deletedPresetIds || []
          });
        }
        const savedEmpty = persistCockpitLayout({
          ...delRes.nextLayout,
          widgets: buildDefaultCockpitLayout('cockpit').widgets.map(w => ({ ...w, visible: false })),
          modules: [],
          emptyGroup: true
        });
        applyCockpitLayoutToDom();
        return savedEmpty;
      }
    }
    if (active) {
      const nextCustoms = presets.filter(item => item !== active);
      const nextOrder = curOrder.filter(id => id !== active.id);
      return applyCockpitPreset(nextOrder[0] || 'cockpit', { customPresets: nextCustoms, presetOrder: nextOrder, deletedPresetIds });
    }
  }
  if (action === 'save') {
    const id = `custom-${window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
    const entry = { id, name, presetId: layout.presetId || 'cockpit', widgets: layout.widgets, modules: visibleModules, ...emptyFlag };
    const nextCustoms = [...presets, entry];
    const nextOrder = normalizeCockpitPresetOrder([...curOrder, id], nextCustoms, deletedPresetIds);
    persistCockpitLayout({ ...layout, modules: visibleModules, ...emptyFlag, activeCustomId: id, customPresets: nextCustoms, deletedPresetIds, presetOrder: nextOrder });
  } else if (active) {
    const entry = action === 'rename'
      ? { ...active, name }
      : { ...active, widgets: layout.widgets, modules: visibleModules, ...emptyFlag };
    if (action !== 'rename' && visibleModules.length > 0) delete entry.emptyGroup;
    persistCockpitLayout({ ...layout, modules: visibleModules, ...emptyFlag, customPresets: presets.map(item => item === active ? entry : item), deletedPresetIds, presetOrder: curOrder });
  }
  applyCockpitLayoutToDom();
  return getCockpitLayout();
}

function swapCockpitPresets(sourceId, targetId, { persist = true } = {}) {
  const layout = getCockpitLayout();
  const customs = layout.customPresets || [];
  const order = normalizeCockpitPresetOrder(layout.presetOrder, customs).slice();
  const fromIdx = order.indexOf(sourceId);
  const toIdx = order.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return layout;
  const tmp = order[fromIdx];
  order[fromIdx] = order[toIdx];
  order[toIdx] = tmp;
  lastCommittedPresetOrderAt = Date.now();
  const saved = persistCockpitLayout({ ...layout, presetOrder: order }, { persistHost: persist });
  renderCockpitPresetsTrack(saved);
  return saved;
}

function reorderCockpitPresets(sourceId, targetId, insertAfter = false, { persist = true } = {}) {
  const layout = getCockpitLayout();
  const customs = layout.customPresets || [];
  const order = normalizeCockpitPresetOrder(layout.presetOrder, customs).slice();
  const fromIdx = order.indexOf(sourceId);
  const toIdxOrig = order.indexOf(targetId);
  if (fromIdx < 0 || toIdxOrig < 0 || sourceId === targetId) return layout;
  const tmp = order[fromIdx];
  order[fromIdx] = order[toIdxOrig];
  order[toIdxOrig] = tmp;
  lastCommittedPresetOrderAt = Date.now();
  const saved = persistCockpitLayout({ ...layout, presetOrder: order }, { persistHost: persist });
  renderCockpitPresetsTrack(saved);
  return saved;
}

function moveCockpitPresetByOffset(presetId, offset, { persist = true } = {}) {
  const layout = getCockpitLayout();
  const customs = layout.customPresets || [];
  const order = normalizeCockpitPresetOrder(layout.presetOrder, customs).slice();
  const idx = order.indexOf(presetId);
  const delta = Number(offset) || 0;
  const nextIdx = idx + delta;
  if (idx < 0 || delta === 0 || nextIdx < 0 || nextIdx >= order.length) return layout;
  const tmp = order[idx];
  order[idx] = order[nextIdx];
  order[nextIdx] = tmp;
  lastCommittedPresetOrderAt = Date.now();
  const saved = persistCockpitLayout({ ...layout, presetOrder: order }, { persistHost: persist });
  renderCockpitPresetsTrack(saved);
  return saved;
}

function getCockpitLayout() {
  if (!sessionCockpitLayout) {
    try {
      const savedRaw = typeof localStorage !== 'undefined' ? localStorage.getItem(SESSION_COCKPIT_STORAGE_KEY) : null;
      if (savedRaw) {
        sessionCockpitLayout = normalizeCockpitLayout(JSON.parse(savedRaw));
      }
    } catch { }
  }
  if (!sessionCockpitLayout) {
    sessionCockpitLayout = buildDefaultCockpitLayout('cockpit');
  }
  return sessionCockpitLayout;
}

function persistCockpitLayout(layoutObj, { persistHost = true } = {}) {
  const clean = normalizeCockpitLayout(layoutObj);
  sessionCockpitLayout = clean;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SESSION_COCKPIT_STORAGE_KEY, JSON.stringify(clean));
    }
  } catch { }
  if (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
    window.__AGContextMeterSettings = {
      ...window.__AGContextMeterSettings,
      sessionCockpitLayout: clean,
      uiPreferences: {
        ...(window.__AGContextMeterSettings.uiPreferences || {}),
        sessionCockpitLayout: clean
      }
    };
  }
  if (persistHost && (typeof window?.contextMeterAPI?.saveSettings === 'function' || (typeof hasLiveHttpBridge === 'function' && hasLiveHttpBridge()))) {
    if (typeof saveSettingsPayloadBridge === 'function') {
      void saveSettingsPayloadBridge({ sessionCockpitLayout: clean });
    }
  }
  return clean;
}

function measureCockpitGrid(grid) {
  const style = window.getComputedStyle?.(grid);
  const clientWidth = grid.clientWidth || grid.getBoundingClientRect?.()?.width || 0;
  const cssWidth = Number.parseFloat(style?.width);
  const width = Number.isFinite(cssWidth) ? Math.min(clientWidth, cssWidth) : clientWidth;
  const gap = Number.parseFloat(style?.columnGap) || 0;
  const track = (width + gap) / 12;
  return {
    width,
    gap,
    track,
    minSpan: width > 0 ? Math.min(12, Math.ceil((COCKPIT_MIN_WIDTH + gap) / track)) : 1
  };
}

// 合法吸格列数：宽容器支持 3 列四卡同行（3×4=12），narrow 收敛为 12 列单栏
const COCKPIT_LEGAL_SPANS = Object.freeze({
  xl: [3, 4, 6, 8, 12],
  wide: [3, 4, 6, 12],
  medium: [6, 12],
  narrow: [12],
  compact: [12],
  minimal: [12],
  'ring-only': [12]
});

function resolveCockpitWidthTier() {
  try {
    const tier = el('panel')?.getAttribute?.('data-ctx-width-tier');
    if (tier && COCKPIT_LEGAL_SPANS[tier]) return String(tier);
  } catch { }
  const w = Number(window.innerWidth) || 1280;
  if (w >= 1180) return 'xl';
  if (w >= 860) return 'wide';
  if (w >= 560) return 'medium';
  return 'narrow';
}

function legalCockpitSpans(tier = resolveCockpitWidthTier()) {
  return COCKPIT_LEGAL_SPANS[tier] || COCKPIT_LEGAL_SPANS.wide;
}

/**
 * 把任意原始列数吸附到当前断点的合法档位；等距时优先更大一档，杜绝 5 列 / 7 列 / 9 列等畸形碎列
 */
function snapCockpitSpan(rawSpan, tier = resolveCockpitWidthTier()) {
  const pool = legalCockpitSpans(tier);
  const raw = Number(rawSpan);
  if (!Number.isFinite(raw)) return pool[pool.length - 1];
  let best = pool[0];
  let bestDist = Infinity;
  for (const n of pool) {
    const dist = Math.abs(n - raw);
    if (dist < bestDist || (dist === bestDist && n > best)) {
      best = n;
      bestDist = dist;
    }
  }
  return best;
}

function applyCockpitCardWidth(card, widget, metrics) {
  const container = metrics.width || 0;
  const ratio = Number(widget.widthRatio);
  const hasRatio = Number.isFinite(ratio) && ratio > 0;
  if (hasRatio && container > 0) {
    // 真·自由缩放：按相对比例算精确像素宽，向下兼容旧 span 配置
    const px = Math.max(Math.min(COCKPIT_MIN_WIDTH, container), Math.min(container, Math.round(ratio * container)));
    const span = Math.max(1, Math.min(12, Math.ceil((px / container) * 12)));
    const column = `span ${span}`;
    if (card.style.gridColumn !== column) card.style.gridColumn = column;
    const widthCss = `${px}px`;
    if (card.style.width !== widthCss) card.style.width = widthCss;
    if (card.style.justifySelf !== 'start') card.style.justifySelf = 'start';
  } else {
    if (card.style.width) card.style.width = '';
    if (card.style.justifySelf) card.style.justifySelf = '';
    const column = widget.customWidth ? `span ${snapCockpitSpan(widget.span, resolveCockpitWidthTier())}` : '';
    if (card.style.gridColumn !== column) card.style.gridColumn = column;
  }
  const spanBtn = card.querySelector?.('[data-widget-action="cycle-span"]');
  if (spanBtn) {
    const effectiveSpan = hasRatio
      ? Math.max(1, Math.min(12, Math.round(ratio * 12)))
      : snapCockpitSpan(widget.span, resolveCockpitWidthTier());
    const label = t('session.widget.spanLabel', { n: effectiveSpan });
    if (spanBtn.textContent !== label) spanBtn.textContent = label;
    spanBtn.title = t('session.widget.spanTitle');
  }
}

// ============================================================================
// 轻量 2D Skyline 紧凑自动排版（确定性、无重叠、可单测）
// ============================================================================

/** 窄容器（< 520px）收敛为单列 100% 宽；传入 prevSingle 时应用 ±14px 滞回，防止拖拽临界点加滚动条闪切 */
function isSkylineSingleColumn(containerWidth, prevSingle = null) {
  const w = Number(containerWidth) || 0;
  if (prevSingle === true) {
    return !(w >= COCKPIT_SINGLE_COLUMN_BREAKPOINT + COCKPIT_SINGLE_COLUMN_HYSTERESIS_PX);
  }
  if (prevSingle === false) {
    return w < COCKPIT_SINGLE_COLUMN_BREAKPOINT - COCKPIT_SINGLE_COLUMN_HYSTERESIS_PX;
  }
  return !(w >= COCKPIT_SINGLE_COLUMN_BREAKPOINT);
}

/** 由 widthRatio / span 解析出该卡在给定容器宽下的像素宽 */
function resolveSkylineCardWidth(widget, containerWidth, gap = 10, singleOverride = null) {
  const container = Number(containerWidth) || 0;
  if (container <= 0) return 0;
  const single = typeof singleOverride === 'boolean' ? singleOverride : isSkylineSingleColumn(container);
  if (single) return container;
  const ratio = Number(widget?.widthRatio);
  if (Number.isFinite(ratio) && ratio > 0) {
    return Math.max(Math.min(COCKPIT_MIN_WIDTH, container), Math.min(container, Math.round(ratio * container)));
  }
  const span = Math.max(1, Math.min(12, Number(widget?.span) || 12));
  return Math.max(COCKPIT_MIN_WIDTH, Math.min(container, Math.floor((container + gap) * span / 12 - gap)));
}

/**
 * 行级规整装箱：同行统一顶边与行底对齐（杜绝短卡下方悬挂空洞），下一行从上一行最大底边 + gap 开始，
 * 支持四张卡同一行（4×3列或自由宽度）并在行尾小余量时贴齐右缘。
 */
function packSkylineBoxes(boxes, containerWidth, gap = 10, { fillSlivers = true, equalizeRows = true, singleColumn = null } = {}) {
  const container = Number(containerWidth) || 0;
  const safeGap = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 10;
  const list = Array.isArray(boxes) ? boxes : [];
  if (container <= 0) return list.map(() => ({ x: 0, y: 0, w: 0, h: 0, rowHeight: 0 }));
  const single = typeof singleColumn === 'boolean' ? singleColumn : isSkylineSingleColumn(container);
  if (single) {
    let cursorY = 0;
    return list.map(box => {
      const h = Math.max(1, Math.ceil(Number(box?.h) || 0));
      const placed = { x: 0, y: cursorY, w: container, h, rowHeight: h };
      cursorY += h + safeGap;
      return placed;
    });
  }

  // 按顺序分组成行，确保同行顶边对齐、下一行严格在上一行最大底边 + safeGap 之下
  const rows = [];
  let curRow = [];
  let curRowWidth = 0;
  const out = new Array(list.length);

  const flushRow = () => {
    if (!curRow.length) return;
    rows.push(curRow);
    curRow = [];
    curRowWidth = 0;
  };

  for (let i = 0; i < list.length; i++) {
    const box = list[i];
    const w = Math.max(1, Math.min(container, Math.round(Number(box?.w) || container)));
    const h = Math.max(1, Math.ceil(Number(box?.h) || 0));
    const forceNewRow = Boolean(Number.isInteger(box?.alignBelow) && curRow.some(item => item.idx === box.alignBelow));
    const needed = curRow.length === 0 ? w : (curRowWidth + safeGap + w);
    if (curRow.length > 0 && (forceNewRow || needed > container + 0.5)) {
      flushRow();
    }
    const x = curRow.length === 0 ? 0 : (curRowWidth + safeGap);
    curRow.push({ idx: i, x, w, h });
    curRowWidth = x + w;
  }
  flushRow();

  let cursorY = 0;
  for (const row of rows) {
    const rowMaxH = row.reduce((m, item) => Math.max(m, item.h), 1);
    if (fillSlivers && row.length > 0) {
      const last = row[row.length - 1];
      const rightMost = last.x + last.w;
      const leftover = container - rightMost;
      // 极小碎缝（< 24px）直接贴齐最右卡；多卡同行且剩余不足以再放一张卡（1~2 列内余量）按比例弹性补齐
      if (leftover > 0.5 && leftover < COCKPIT_ROW_SLIVER_PX) {
        last.w = Math.min(container - last.x, last.w + leftover);
      } else if (row.length >= 2 && leftover >= COCKPIT_ROW_SLIVER_PX && leftover < COCKPIT_MIN_WIDTH) {
        const extraEach = Math.floor(leftover / row.length);
        let rem = leftover - extraEach * row.length;
        let runX = 0;
        for (let k = 0; k < row.length; k++) {
          const add = extraEach + (k === row.length - 1 ? rem : 0);
          row[k].x = runX;
          row[k].w = Math.min(container - runX, row[k].w + add);
          runX += row[k].w + safeGap;
        }
      }
    }
    for (const item of row) {
      out[item.idx] = {
        x: item.x,
        y: cursorY,
        w: item.w,
        h: item.h,
        rowHeight: equalizeRows ? rowMaxH : item.h
      };
    }
    cursorY += rowMaxH + safeGap;
  }
  return out;
}

/**
 * 带滞回（±10px）计算卡片密度档位，防止 360px / 560px 阈值边界处因滚动条或子像素取整造成持续闪切
 */
function resolveCardSizeTierWithHysteresis(card, width) {
  const prev = card?.getAttribute?.('data-card-size') || '';
  const h = COCKPIT_CARD_SIZE_HYSTERESIS_PX;
  if (prev === 'compact') {
    if (width < COCKPIT_CARD_COMPACT_MAX + h) return 'compact';
    return width < COCKPIT_CARD_WIDE_MIN ? 'regular' : 'wide';
  }
  if (prev === 'regular') {
    if (width < COCKPIT_CARD_COMPACT_MAX - h) return 'compact';
    if (width >= COCKPIT_CARD_WIDE_MIN + h) return 'wide';
    return 'regular';
  }
  if (prev === 'wide') {
    if (width < COCKPIT_CARD_COMPACT_MAX - h) return 'compact';
    if (width < COCKPIT_CARD_WIDE_MIN - h) return 'regular';
    return 'wide';
  }
  return width < COCKPIT_CARD_COMPACT_MAX
    ? 'compact'
    : (width < COCKPIT_CARD_WIDE_MIN ? 'regular' : 'wide');
}

function aabbOverlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap - 0.01
    && a.x + a.w + gap - 0.01 > b.x
    && a.y < b.y + b.h + gap - 0.01
    && a.y + a.h + gap - 0.01 > b.y;
}


function syncCardAdaptiveAttrs(card, width, height, { lightDrag = false } = {}) {
  if (!card) return 'regular';
  const curSize = card.getAttribute?.('data-card-size') || '';
  const nextSize = (lightDrag && curSize) ? curSize : resolveCardSizeTierWithHysteresis(card, width);
  if (!lightDrag && curSize !== nextSize) {
    card.setAttribute?.('data-card-size', nextSize);
  }
  const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
  const cls = (upg && typeof upg.classifyCardLayoutState === 'function')
    ? upg.classifyCardLayoutState(width, height)
    : (() => {
      const w = Math.max(0, Number(width) || 0);
      const h = Math.max(0, Number(height) || 0);
      let density = 'wide';
      if (w < 150 || h < 88) density = 'micro';
      else if (w < 220 || h < 130) density = 'nano';
      else if (w < 360) density = 'compact';
      else if (w < 560) density = 'regular';
      let shape = 'standard';
      if (w <= 160 && h <= 120) shape = 'micro-tile';
      else if (h <= 115 && w >= 220) shape = 'wide-strip';
      else if (w <= 210 && h >= 220) shape = 'tall-strip';
      return { density, shape };
    })();
  if (!lightDrag) {
    if (card.getAttribute?.('data-card-density') !== cls.density) {
      card.setAttribute?.('data-card-density', cls.density);
    }
    if (card.getAttribute?.('data-card-shape') !== cls.shape) {
      card.setAttribute?.('data-card-shape', cls.shape);
    }
    card.classList?.toggle?.('is-card-micro', cls.density === 'micro');
    card.classList?.toggle?.('is-card-nano', cls.density === 'nano');
    card.classList?.toggle?.('is-card-compact', cls.density === 'compact' || cls.density === 'nano' || cls.density === 'micro');
    card.classList?.toggle?.('is-card-wide-strip', cls.shape === 'wide-strip');
    card.classList?.toggle?.('is-card-tall-strip', cls.shape === 'tall-strip');
  }
  return nextSize;
}

function resolveFreestyleCardRect(cfg, containerW, fallbackH = COCKPIT_MIN_HEIGHT) {
  const fr = cfg?.freeRect;
  if (!fr || typeof fr !== 'object') return null;
  const baseW = Number(fr.baseW);
  const sameContainer = Number.isFinite(baseW) && baseW > 0 && Math.abs(containerW - baseW) <= 2;
  let rawW;
  let rawX;
  if (sameContainer && Number.isFinite(Number(fr.w))) {
    rawW = Number(fr.w);
    rawX = Number.isFinite(Number(fr.x)) ? Number(fr.x) : 0;
  } else if (Number.isFinite(Number(fr.wRatio)) && Number(fr.wRatio) > 0) {
    rawW = Math.round(Number(fr.wRatio) * containerW);
    rawX = Number.isFinite(Number(fr.xRatio)) ? Math.round(Number(fr.xRatio) * containerW) : 0;
  } else {
    rawW = Number.isFinite(Number(fr.w)) ? Number(fr.w) : containerW;
    rawX = Number.isFinite(Number(fr.x)) ? Number(fr.x) : 0;
  }
  const rawY = Number.isFinite(Number(fr.y)) ? Number(fr.y) : 0;
  const rawH = Number.isFinite(Number(fr.h)) ? Number(fr.h) : Math.max(COCKPIT_MIN_HEIGHT, Number(fallbackH) || COCKPIT_MIN_HEIGHT);
  return clampFreestyleRectForGrid({ x: rawX, y: rawY, w: rawW, h: rawH }, containerW);
}

function ensureCockpitEmptyRestoreButton() {
  const emptyState = el('ctx-cockpit-empty-state');
  if (!emptyState || typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let restoreBtn = el('btn-ctx-empty-restore-default') || emptyState.querySelector?.('#btn-ctx-empty-restore-default') || null;
  const langTag = typeof currentLang !== 'undefined' ? String(currentLang) : (typeof lang !== 'undefined' ? String(lang) : 'zh-CN');
  const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
  const label = (upg && typeof upg.formatCopy === 'function' ? upg.formatCopy(langTag, 'restoreDefaultModules') : '') || '恢复默认模块';
  if (!restoreBtn) {
    restoreBtn = document.createElement('button');
    restoreBtn.id = 'btn-ctx-empty-restore-default';
    restoreBtn.type = 'button';
    restoreBtn.className = 'ctx-action-pill ctx-empty-restore-btn';
    restoreBtn.setAttribute('data-cockpit-empty-action', 'restore-default');
    const actionsWrap = emptyState.querySelector?.('.ctx-cockpit-empty-actions');
    if (actionsWrap) actionsWrap.appendChild?.(restoreBtn);
    else emptyState.appendChild?.(restoreBtn);
  }
  if (restoreBtn.textContent !== label) restoreBtn.textContent = label;
  if (!restoreBtn._cockpitRestoreBound) {
    restoreBtn._cockpitRestoreBound = true;
    restoreBtn.addEventListener?.('click', (e) => {
      e?.stopPropagation?.();
      restoreDefaultCockpitModules({ persist: true });
    });
  }
  return restoreBtn;
}

function applyCockpitLayoutToDom({ renderManager = true, lightResize = false } = {}) {
  const layout = getCockpitLayout();
  const grid = el('ctx-bento-grid');
  const toolbar = el('ctx-cockpit-toolbar');
  const paneResizing = Boolean(lightResize || isWorkspacePaneResizingNow(grid));

  if (toolbar && !paneResizing) {
    renderCustomCockpitPresets(layout);
    toolbar.querySelectorAll?.('[data-cockpit-preset]')?.forEach(btn => {
      const pId = btn.getAttribute('data-cockpit-preset');
      const isAct = pId === (layout.activeCustomId || layout.presetId);
      btn.classList?.toggle?.('active', isAct);
      btn.setAttribute?.('aria-pressed', isAct ? 'true' : 'false');
    });
  }

  if (!grid) return layout;
  if (grid.getAttribute?.('data-widget-gesture') === 'reorder'
      && grid.getAttribute?.('data-layout-engine') === 'skyline') return layout;

  const metrics = measureCockpitGrid(grid);
  const cardsById = new Map();
  Array.from(grid.children || []).forEach(node => {
    const wId = node.getAttribute?.('data-widget-id');
    if (wId) cardsById.set(wId, node);
  });

  // 按最新排序重排网格子卡片 DOM 顺序并同步列宽、高度模式与显隐（拖拽降载帧跳过重复写不变的静态属性与按钮文案）
  const packItems = [];
  let configuredVisibleCount = 0;
  for (let i = 0; i < layout.widgets.length; i++) {
    const cfg = layout.widgets[i];
    if (cfg.visible) configuredVisibleCount += 1;
    const card = cardsById.get(cfg.id);
    if (!card) continue;

    if (!paneResizing) {
      if (!grid.hasAttribute?.('data-widget-gesture') && grid.children?.[i] !== card) {
        if (typeof grid.insertBefore === 'function') grid.insertBefore(card, grid.children?.[i] || null);
        else grid.appendChild?.(card);
      }

      if (card.hidden !== !cfg.visible) card.hidden = !cfg.visible;
      const nextDisp = cfg.visible ? '' : 'none';
      if (card.style.display !== nextDisp) card.style.display = nextDisp;
      const spanStr = String(cfg.span);
      if (card.getAttribute?.('data-span') !== spanStr) card.setAttribute?.('data-span', spanStr);
      if (card.getAttribute?.('data-height-mode') !== cfg.height) {
        card.setAttribute?.('data-height-mode', cfg.height);
        card.classList?.remove?.('is-height-compact', 'is-height-standard', 'is-height-expanded');
        card.classList?.add?.(`is-height-${cfg.height}`);
      }

      const fixedHeight = cfg.freeRect?.h != null
        ? cfg.freeRect.h
        : (cfg.heightPx != null ? cfg.heightPx : cfg.customHeightPx);
      card.classList?.toggle?.('is-custom-height', fixedHeight != null);
      card.classList?.toggle?.('is-freestyle-card', Boolean(cfg.freeRect));
      if (!card.classList?.contains?.('is-resizing')) {
        const nextH = fixedHeight != null ? `${fixedHeight}px` : '';
        if (card.style.height !== nextH) card.style.height = nextH;
      }

      if (!card.__agHeightBtn) card.__agHeightBtn = card.querySelector?.('[data-widget-action="cycle-height"]') || null;
      const heightBtn = card.__agHeightBtn;
      if (heightBtn) {
        const hTxt = t(`session.widget.height.${cfg.height}`);
        if (heightBtn.textContent !== hTxt) heightBtn.textContent = hTxt;
        heightBtn.title = t('session.widget.heightTitle');
      }
      if (cfg.visible) packItems.push({ cfg, card, fixedHeight });
    } else if (cfg.visible) {
      const fixedHeight = cfg.freeRect?.h != null
        ? cfg.freeRect.h
        : (cfg.heightPx != null ? cfg.heightPx : cfg.customHeightPx);
      packItems.push({ cfg, card, fixedHeight });
    }
  }

  if (!paneResizing) {
    const emptyState = el('ctx-cockpit-empty-state');
    const isExplicitEmpty = Boolean(layout.emptyGroup || layout.userClearedAll || layout.emptyPresetCatalog);
    const shouldShowEmpty = configuredVisibleCount === 0 && isExplicitEmpty;
    if (emptyState) {
      ensureCockpitEmptyRestoreButton();
      if (emptyState.hidden !== !shouldShowEmpty) emptyState.hidden = !shouldShowEmpty;
    }
  }

  applySkylineLayout(grid, packItems, metrics, { lightResize: paneResizing });

  if (renderManager && !paneResizing) renderCockpitWidgetManagerPopover();
  return layout;
}

let cockpitAwaitingSizeObserver = null;

function ensureCockpitAwaitingSizeObserver(grid) {
  if (!grid || typeof ResizeObserver !== 'function') return;
  if (cockpitAwaitingSizeObserver) {
    try { cockpitAwaitingSizeObserver.observe(grid); } catch { }
    return;
  }
  try {
    cockpitAwaitingSizeObserver = new ResizeObserver((entries) => {
      if (typeof state !== 'undefined' && state?.disposed) return;
      let becameNonZero = false;
      for (const entry of entries) {
        const w = Math.round(entry?.contentRect?.width || entry?.target?.clientWidth || 0);
        const h = Math.round(entry?.contentRect?.height || entry?.target?.clientHeight || 0);
        if (w > 0 && h > 0 && entry?.target?.getAttribute?.('data-om-awaiting-size') === 'true') {
          becameNonZero = true;
          break;
        }
      }
      if (!becameNonZero) return;
      grid.removeAttribute?.('data-om-awaiting-size');
      if (typeof applyCockpitLayoutToDom === 'function') {
        applyCockpitLayoutToDom({ renderManager: false, lightResize: false });
      }
      if (typeof renderContextTrendCard === 'function') renderContextTrendCard({ force: true });
      if (typeof renderSessionBentoSections === 'function') renderSessionBentoSections();
    });
    cockpitAwaitingSizeObserver.observe(grid);
    if (typeof activeDisposers !== 'undefined') {
      activeDisposers.add(() => {
        try { cockpitAwaitingSizeObserver?.disconnect?.(); } catch { }
        cockpitAwaitingSizeObserver = null;
      });
    }
  } catch { }
}

/**
 * 落地 2D 自由画布 / Skyline 排版：
 * - 自由画布态（存在 freeRect）：精准还原并按容器宽度实时严格钳制每张卡片的 (x, y, w, h)，
 *   支持首行及任意行并排放 2/3/4/5/N 个模块、任意合法长宽比，绝不强制踢到下一行或越出容器边界。
 * - 预设自动流态（无 freeRect）：严格三阶段批量读写分离，零重叠装箱与同排对齐。
 */
function applySkylineLayout(grid, items, metrics, { lightResize = false } = {}) {
  const containerW = Math.floor(metrics?.width || 0);
  const gap = COCKPIT_SKYLINE_GAP;
  if (grid.getAttribute?.('data-layout-engine') !== 'skyline') {
    grid.setAttribute?.('data-layout-engine', 'skyline');
  }
  if (!containerW || !items.length) {
    // 容器尚未量出宽度（首屏 / 面板隐藏 / display:none）时绝不落到绝对定位，否则卡片会塌成一条细缝
    grid.removeAttribute?.('data-layout-engine');
    grid.removeAttribute?.('data-freestyle-active');
    if (grid.style) grid.style.height = '';
    if (containerW <= 0 && items.length) {
      grid.setAttribute?.('data-om-awaiting-size', 'true');
      ensureCockpitAwaitingSizeObserver(grid);
    } else {
      grid.removeAttribute?.('data-om-awaiting-size');
    }
    const retryKey = '__agSkylineRetry';
    const attempt = Number(grid[retryKey] || 0);
    if (containerW <= 0 && items.length && attempt < 20 && typeof requestAnimationFrame === 'function') {
      grid[retryKey] = attempt + 1;
      requestAnimationFrame(() => { try { applyCockpitLayoutToDom({ renderManager: false }); } catch { } });
    } else if (containerW > 0) {
      grid[retryKey] = 0;
    }
    return [];
  }

  grid.removeAttribute?.('data-om-awaiting-size');
  grid.__agSkylineRetry = 0;
  grid.__agLayoutApplying = true;
  cockpitLayoutApplyCount += 1;
  try {
    const isLightDrag = Boolean(lightResize || isWorkspacePaneResizingNow(grid));
    const hasFreestyleCards = items.some(it => it.cfg.freeRect && typeof it.cfg.freeRect === 'object');
    grid.setAttribute?.('data-freestyle-active', hasFreestyleCards ? 'true' : 'false');

    if (hasFreestyleCards) {
      if (isLightDrag) cockpitLayoutLightResizeCount += 1;
      const placements = new Array(items.length);
      let maxBottom = 0;

      // 第一轮：先放置全部已有 freeRect 的自由画布卡片并严格钳制到 [0, containerW] 与 y >= 0
      const pendingIndices = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        item.resizing = Boolean(item.card.classList?.contains?.('is-resizing'));
        const resolved = resolveFreestyleCardRect(item.cfg, containerW, item.fixedHeight || item.card.__agLastNaturalH || 180);
        if (resolved) {
          placements[i] = { ...resolved, rowHeight: resolved.h };
          maxBottom = Math.max(maxBottom, resolved.y + resolved.h);
        } else {
          pendingIndices.push(i);
        }
      }

      // 第二轮：为自由模式下新勾选加入且尚无 freeRect 的卡片在画布底部顺序落位
      let cursorY = maxBottom > 0 ? maxBottom + gap : 0;
      for (const idx of pendingIndices) {
        const item = items[idx];
        const rawW = resolveSkylineCardWidth(item.cfg, containerW, gap, false);
        const rawH = item.fixedHeight != null
          ? Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(Number(item.fixedHeight)))
          : Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(Number(item.card.__agLastNaturalH) || item.card.offsetHeight || 180));
        const clamped = clampFreestyleRectForGrid({ x: 0, y: cursorY, w: rawW, h: rawH }, containerW);
        placements[idx] = { ...clamped, rowHeight: clamped.h };
        cursorY = clamped.y + clamped.h + gap;
        maxBottom = Math.max(maxBottom, clamped.y + clamped.h);
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const place = placements[i];
        if (!place) continue;
        if (item.resizing) {
          const curTop = Number.parseFloat(item.card.style?.top || '0') || 0;
          const curH = Number.parseFloat(item.card.style?.height || '0') || place.h;
          maxBottom = Math.max(maxBottom, Math.ceil(curTop + curH));
          continue;
        }
        if (isLightDrag && item.card.getAttribute?.('data-ag-drag-offscreen') === 'true') continue;
        if (item.card.style.position !== 'absolute') item.card.style.position = 'absolute';
        if (item.card.style.gridColumn !== '') item.card.style.gridColumn = '';
        if (item.card.style.justifySelf) item.card.style.justifySelf = '';
        const leftCss = `${place.x}px`;
        const topCss = `${place.y}px`;
        const widthCss = `${place.w}px`;
        const heightCss = `${place.h}px`;
        if (item.card.style.left !== leftCss) item.card.style.left = leftCss;
        if (item.card.style.top !== topCss) item.card.style.top = topCss;
        if (item.card.style.width !== widthCss) item.card.style.width = widthCss;
        if (item.card.style.height !== heightCss) item.card.style.height = heightCss;
        if (item.card.style.minHeight) item.card.style.minHeight = '';
        item.card.__agLastNaturalH = place.h;
        syncCardAdaptiveAttrs(item.card, place.w, place.h, { lightDrag: isLightDrag });
        if (!isLightDrag) {
          if (item.card.__agSpanBtn === undefined) {
            item.card.__agSpanBtn = item.card.querySelector?.('[data-widget-action="cycle-span"]') || null;
          }
          const spanBtn = item.card.__agSpanBtn;
          if (spanBtn) {
            const spine = Math.max(1, Math.min(12, Math.round((place.w / containerW) * 12)));
            const label = t('session.widget.spanLabel', { n: spine });
            if (spanBtn.textContent !== label) spanBtn.textContent = label;
            spanBtn.title = t('session.widget.spanTitle');
          }
        }
      }

      const nextGridH = `${Math.max(0, Math.ceil(maxBottom))}px`;
      if (grid.style.height !== nextGridH) grid.style.height = nextGridH;
      const nextHeightAttr = String(Math.max(0, Math.ceil(maxBottom)));
      if (grid.getAttribute?.('data-layout-height') !== nextHeightAttr) {
        grid.setAttribute?.('data-layout-height', nextHeightAttr);
      }
      grid.__agLastAppliedWidth = containerW;
      return placements;
    }

    // 拖拽期间启用 ±14px 单双列滞回，防止临界点加滚动条来回抖动；松手终态校准按精确 520px 落位
    const prevSingle = isLightDrag ? cockpitLastSingleColumn : null;
    const singleColumn = isSkylineSingleColumn(containerW, prevSingle);
    const colModeChanged = cockpitLastSingleColumn !== null && cockpitLastSingleColumn !== singleColumn;
    cockpitLastSingleColumn = singleColumn;

    // 1. 纯内存预计算最终行宽度（不触碰任何 DOM 读写）
    const preBoxes = items.map((item, index) => {
      const resizing = Boolean(item.card.classList?.contains?.('is-resizing'));
      item.resizing = resizing;
      const rawW = resizing && !singleColumn
        ? (item.card.offsetWidth || item.card.getBoundingClientRect?.()?.width || resolveSkylineCardWidth(item.cfg, containerW, gap, singleColumn))
        : resolveSkylineCardWidth(item.cfg, containerW, gap, singleColumn);
      item.width = rawW;
      return {
        w: rawW,
        h: COCKPIT_MIN_HEIGHT,
        alignBelow: item.cfg.id === 'request-cost' && items[index - 1]?.cfg.id === 'token-breakdown' ? index - 1 : null
      };
    });
    const prePlacements = packSkylineBoxes(preBoxes, containerW, gap, { fillSlivers: true, equalizeRows: false, singleColumn });

    let cardSizeChanged = false;
    const nextCardSizes = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const finalW = item.resizing ? item.width : (prePlacements[i]?.w || item.width);
      item.width = finalW;
      const curSize = item.card.getAttribute?.('data-card-size') || '';
      const nextSize = (isLightDrag && curSize) ? curSize : resolveCardSizeTierWithHysteresis(item.card, finalW);
      nextCardSizes[i] = nextSize;
      if (curSize !== nextSize) cardSizeChanged = true;
    }

    const canReuseCachedHeights = isLightDrag
      || (!colModeChanged
        && !cardSizeChanged
        && items.every(it => it.fixedHeight != null || it.resizing || Number(it.card.__agLastNaturalH) >= COCKPIT_MIN_HEIGHT)
        && false);

    if (isLightDrag) {
      cockpitLayoutLightResizeCount += 1;
    }

    // 2. 阶段 1（纯写批次）：一次性提交所有卡片宽度、密度档位；拖拽期间跳过已冻结的屏外卡片，彻底零无效重排
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.resizing) continue;
      if (isLightDrag && item.card.getAttribute?.('data-ag-drag-offscreen') === 'true') continue;
      if (item.card.style.position !== 'absolute') item.card.style.position = 'absolute';
      if (item.card.style.gridColumn !== '') item.card.style.gridColumn = '';
      if (item.card.style.justifySelf) item.card.style.justifySelf = '';
      const widthCss = `${item.width}px`;
      if (item.card.style.width !== widthCss) item.card.style.width = widthCss;
      const nextSize = nextCardSizes[i];
      if (!isLightDrag && item.card.getAttribute?.('data-card-size') !== nextSize) {
        item.card.setAttribute?.('data-card-size', nextSize);
      }
      if (!canReuseCachedHeights && item.fixedHeight == null && item.card.style.minHeight) {
        item.card.style.minHeight = '';
      }
    }

    // 3. 阶段 2（纯读批次）：拖拽期间严格 0 次 offsetHeight 同步回流；非拖拽松手一次性精确测高
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.resizing) {
        const inlineH = Number.parseFloat(item.card.style?.height || '');
        if (Number.isFinite(inlineH) && inlineH > 0) {
          item.height = Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(inlineH));
          continue;
        }
      }
      if (item.fixedHeight != null) {
        item.height = Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(Number(item.fixedHeight)));
        item.card.__agLastNaturalH = item.height;
        continue;
      }
      if (canReuseCachedHeights) {
        const cachedH = Number(item.card.__agLastNaturalH);
        item.height = Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(Number.isFinite(cachedH) && cachedH >= COCKPIT_MIN_HEIGHT ? cachedH : COCKPIT_MIN_HEIGHT));
        continue;
      }
      const measured = item.card.offsetHeight || item.card.getBoundingClientRect?.()?.height || 0;
      const clampedH = Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(measured));
      item.height = clampedH;
      item.card.__agLastNaturalH = clampedH;
    }

    // 4. 内存中最终装箱 + 同行统一顶边与行底对齐（纯计算，零 DOM 访问）
    const finalBoxes = items.map((item, index) => ({
      w: item.width,
      h: item.height,
      alignBelow: item.cfg.id === 'request-cost' && items[index - 1]?.cfg.id === 'token-breakdown' ? index - 1 : null
    }));
    const placements = packSkylineBoxes(finalBoxes, containerW, gap, { fillSlivers: false, equalizeRows: true, singleColumn });

    // 5. 阶段 3（纯写批次）：签名去重与幂等 DOM 提交
    const layoutSig = `${containerW}|${singleColumn ? '1' : 'm'}|${placements.map((p, i) => `${items[i].cfg.id}:${p.x},${p.y},${p.w},${p.rowHeight || p.h},${nextCardSizes[i]}`).join(';')}`;
    let maxBottom = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const place = placements[i];
      if (!place) continue;
      const boxH = place.rowHeight || place.h;
      maxBottom = Math.max(maxBottom, place.y + boxH);
      // 正在自由缩放的卡片或拖拽期屏外冻结卡片保持不动，松手统一校准
      if (item.resizing) continue;
      if (isLightDrag && item.card.getAttribute?.('data-ag-drag-offscreen') === 'true') continue;
      const leftCss = `${place.x}px`;
      const topCss = `${place.y}px`;
      if (item.card.style.left !== leftCss) item.card.style.left = leftCss;
      if (item.card.style.top !== topCss) item.card.style.top = topCss;
      if (item.fixedHeight == null) {
        const minHCss = !singleColumn && boxH > item.height ? `${boxH}px` : '';
        if (item.card.style.minHeight !== minHCss) item.card.style.minHeight = minHCss;
      }
      syncCardAdaptiveAttrs(item.card, place.w, boxH, { lightDrag: isLightDrag });
      if (!isLightDrag) {
        if (item.card.__agSpanBtn === undefined) {
          item.card.__agSpanBtn = item.card.querySelector?.('[data-widget-action="cycle-span"]') || null;
        }
        const spanBtn = item.card.__agSpanBtn;
        if (spanBtn) {
          const spine = Math.max(1, Math.min(12, Math.round((place.w / containerW) * 12)));
          const label = t('session.widget.spanLabel', { n: spine });
          if (spanBtn.textContent !== label) spanBtn.textContent = label;
          spanBtn.title = t('session.widget.spanTitle');
        }
      }
    }
    if (grid.style.height !== `${Math.max(0, maxBottom)}px`) {
      grid.style.height = `${Math.max(0, maxBottom)}px`;
    }
    const nextHeightAttr = String(Math.max(0, maxBottom));
    if (grid.getAttribute?.('data-layout-height') !== nextHeightAttr) {
      grid.setAttribute?.('data-layout-height', nextHeightAttr);
    }
    grid.__agLastLayoutSig = layoutSig;
    grid.__agLastAppliedWidth = containerW;
    if (cockpitLayoutTraceEnabled) {
      cockpitLayoutTraceLog.push({
        ts: Date.now(),
        containerW,
        maxBottom,
        lightResize: isLightDrag,
        reusedHeights: canReuseCachedHeights,
        cards: items.map((it, idx) => ({
          id: it.cfg.id,
          x: placements[idx]?.x,
          y: placements[idx]?.y,
          w: placements[idx]?.w,
          h: placements[idx]?.rowHeight || placements[idx]?.h,
          heightMode: it.cfg.height,
          cardSize: it.card.getAttribute?.('data-card-size')
        }))
      });
      if (cockpitLayoutTraceLog.length > 200) cockpitLayoutTraceLog.shift();
    }
    return placements;
  } finally {
    grid.__agLayoutApplying = false;
  }
}

/**
 * 分隔线拖拽松手后执行一次精确终态校准：同步宽度档位、实测全部卡片自然高并对齐行底，按需刷新趋势 SVG，同时锁定滚动条不乱跳。
 */
function flushCockpitLayoutAfterPaneResize() {
  const grid = el('ctx-bento-grid');
  const pEl = el('panel');
  if (!grid || !pEl || pEl.hidden) return;
  const savedScrollTop = typeof pEl.scrollTop === 'number' ? pEl.scrollTop : 0;
  if (typeof syncContextPanelContainerWidthTier === 'function') syncContextPanelContainerWidthTier();
  cockpitLastSingleColumn = null;
  applyCockpitLayoutToDom({ renderManager: false, lightResize: false });
  if (typeof activeContextTab === 'undefined' || activeContextTab === 'session') {
    if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
  }
  if (typeof pEl.scrollTop === 'number' && Math.abs(pEl.scrollTop - savedScrollTop) > 2) {
    try { pEl.scrollTop = savedScrollTop; } catch { }
  }
}

function applyCockpitPreset(presetId, { persist = true, customPresets = getCockpitLayout().customPresets, presetOrder = getCockpitLayout().presetOrder, deletedPresetIds = getCockpitLayout().deletedPresetIds } = {}) {
  const custom = customPresets?.find(item => item.id === presetId);
  const safeId = custom?.presetId || (Object.prototype.hasOwnProperty.call(COCKPIT_PRESET_LAYOUTS, presetId) ? presetId : 'cockpit');
  const nextOrder = normalizeCockpitPresetOrder(presetOrder, customPresets, deletedPresetIds);
  const next = custom
    ? {
      presetId: safeId,
      widgets: custom.widgets,
      ...(Array.isArray(custom.modules) ? { modules: custom.modules } : {}),
      ...(custom.emptyGroup ? { emptyGroup: true } : {}),
      activeCustomId: custom.id,
      customPresets,
      deletedPresetIds,
      presetOrder: nextOrder
    }
    : { ...buildDefaultCockpitLayout(safeId), customPresets, deletedPresetIds, presetOrder: nextOrder };
  persistCockpitLayout(next, { persistHost: persist });

  if (safeId === 'speed_cost') {
    state.timingDiagExpanded = true;
    state.contextTrendMode = 'delta';
  } else {
    state.timingDiagExpanded = false;
  }
  syncTimingDiagFoldUi?.();

  applyCockpitLayoutToDom();
  if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
  if (typeof renderSessionBentoSections === 'function') renderSessionBentoSections();
  if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  return next;
}

function reorderCockpitWidget(dragId, targetId, insertAfter = false, { renderManager = true } = {}) {
  if (!dragId || !targetId || dragId === targetId) return getCockpitLayout();
  const cur = getCockpitLayout();
  const nextWidgets = cur.widgets.map(w => ({ ...w }));
  const fromIdx = nextWidgets.findIndex(w => w.id === dragId);
  const toIdx = nextWidgets.findIndex(w => w.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return cur;
  const [moved] = nextWidgets.splice(fromIdx, 1);
  let insertIdx = nextWidgets.findIndex(w => w.id === targetId);
  if (insertAfter) insertIdx += 1;
  if (insertIdx === fromIdx) return cur;
  nextWidgets.splice(Math.max(0, Math.min(nextWidgets.length, insertIdx)), 0, moved);
  const saved = persistCockpitLayout({ ...cur, widgets: nextWidgets });
  applyCockpitLayoutToDom({ renderManager });
  return saved;
}

function moveCockpitWidgetStep(widgetId, direction = 1, includeHidden = false) {
  const cur = getCockpitLayout();
  const visible = includeHidden ? cur.widgets : cur.widgets.filter(w => w.visible);
  const curVisIdx = visible.findIndex(w => w.id === widgetId);
  if (curVisIdx < 0) return cur;
  const nextVisIdx = Math.max(0, Math.min(visible.length - 1, curVisIdx + (direction < 0 ? -1 : 1)));
  if (nextVisIdx === curVisIdx) return cur;
  const targetWidget = visible[nextVisIdx];
  return reorderCockpitWidget(widgetId, targetWidget.id, nextVisIdx > curVisIdx);
}

function setCockpitWidgetSpan(widgetId, nextSpan = null) {
  const cur = getCockpitLayout();
  const nextWidgets = cur.widgets.map(w => {
    if (w.id !== widgetId) return { ...w };
    const isXl = state.ctxWidthTier === 'xl';
    const cyclePool = isXl ? [3, 4, 6, 8, 12] : [6, 12];
    let target = Number(nextSpan);
    if (!COCKPIT_VALID_SPANS.includes(target)) {
      const idx = cyclePool.indexOf(w.span);
      target = cyclePool[(idx + 1) % cyclePool.length];
    }
    const next = { ...w, span: target, customWidth: false };
    delete next.widthRatio;
    delete next.freeRect;
    return next;
  });
  const saved = persistCockpitLayout({ ...cur, widgets: nextWidgets });
  applyCockpitLayoutToDom();
  if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
  if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  return saved;
}

function setCockpitWidgetHeight(widgetId, nextHeight = null, customHeightPx = undefined) {
  const cur = getCockpitLayout();
  const nextWidgets = cur.widgets.map(w => {
    if (w.id !== widgetId) return { ...w };
    let target = nextHeight;
    if (!COCKPIT_VALID_HEIGHTS.includes(target)) {
      const idx = COCKPIT_VALID_HEIGHTS.indexOf(w.height);
      target = COCKPIT_VALID_HEIGHTS[(idx + 1) % COCKPIT_VALID_HEIGHTS.length];
    }
    const px = customHeightPx !== undefined ? customHeightPx : null;
    const next = { ...w, height: target, customHeightPx: px };
    if (px == null) {
      delete next.heightPx;
      delete next.freeRect;
    }
    return next;
  });
  const saved = persistCockpitLayout({ ...cur, widgets: nextWidgets });
  applyCockpitLayoutToDom();
  if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  return saved;
}

function toggleCockpitWidgetVisibility(widgetId, forceVisible = null) {
  const cur = getCockpitLayout();
  const nextWidgets = cur.widgets.map(w => {
    if (w.id !== widgetId) return { ...w };
    const nextVis = typeof forceVisible === 'boolean' ? forceVisible : !w.visible;
    return { ...w, visible: nextVis };
  });
  const visibleModules = nextWidgets.filter(w => w.visible).map(w => w.id);
  const allCleared = visibleModules.length === 0;
  const payload = {
    ...cur,
    widgets: nextWidgets,
    modules: visibleModules
  };
  if (allCleared) {
    payload.emptyGroup = true;
    payload.userClearedAll = true;
  } else {
    delete payload.emptyGroup;
    delete payload.userClearedAll;
  }
  const saved = persistCockpitLayout(payload);
  applyCockpitLayoutToDom();
  if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
  if (typeof renderSessionBentoSections === 'function') renderSessionBentoSections();
  if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  return saved;
}

function restoreDefaultCockpitModules({ persist = true } = {}) {
  const cur = getCockpitLayout();
  const targetPreset = (cur.presetId && Object.prototype.hasOwnProperty.call(COCKPIT_PRESET_LAYOUTS, cur.presetId))
    ? cur.presetId
    : 'cockpit';
  const nextDeleted = cur.emptyPresetCatalog ? [] : (Array.isArray(cur.deletedPresetIds) ? cur.deletedPresetIds : []);
  const nextOrder = normalizeCockpitPresetOrder(
    cur.emptyPresetCatalog ? [...BUILTIN_COCKPIT_PRESET_IDS] : cur.presetOrder,
    cur.customPresets || [],
    nextDeleted
  );
  const defaults = buildDefaultCockpitLayout(targetPreset);
  const next = {
    ...defaults,
    customPresets: cur.customPresets || [],
    deletedPresetIds: nextDeleted,
    presetOrder: nextOrder,
    activeCustomId: null
  };
  delete next.emptyGroup;
  delete next.userClearedAll;
  delete next.emptyPresetCatalog;
  const saved = persistCockpitLayout(next, { persistHost: persist });
  applyCockpitLayoutToDom();
  if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
  if (typeof renderSessionBentoSections === 'function') renderSessionBentoSections();
  if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  return saved;
}

function revealAndScrollToCockpitWidget(widgetId, { flash = true } = {}) {
  if (!COCKPIT_VALID_WIDGET_IDS.has(widgetId)) return null;
  const cur = getCockpitLayout();
  const target = cur.widgets.find(w => w.id === widgetId);
  if (target && !target.visible) {
    toggleCockpitWidgetVisibility(widgetId, true);
  }
  const grid = el('ctx-bento-grid');
  const card = grid?.querySelector?.(`[data-widget-id="${widgetId}"]`);
  if (!card) return null;
  if (widgetId === 'tech-drawer') {
    const btn = el('btn-toggle-details');
    const body = el('drawer-body');
    if (body && body.style.display !== 'block') btn?.click?.();
  }
  try {
    card.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } catch { }
  if (flash && card.classList) {
    card.classList.remove('is-widget-flash');
    try { void card.offsetWidth; } catch { }
    card.classList.add('is-widget-flash');
    setTimeout(() => card.classList?.remove?.('is-widget-flash'), 1100);
  }
  return card;
}

function closeCockpitWidgetManager() {
  if (el('btn-ctx-widget-mgr')?.getAttribute('aria-expanded') !== 'true') return;
  cockpitManagerOpen = false;
  renderCockpitWidgetManagerPopover();
}

function positionCockpitWidgetManagerPopover() {
  const button = el('btn-ctx-widget-mgr');
  if (button?.getAttribute('aria-expanded') !== 'true') return;
  const pop = el('ctx-widget-mgr-popover');
  const panelRect = el('panel')?.getBoundingClientRect();
  if (!pop || !panelRect?.width || !panelRect.height) return;

  const buttonRect = button.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportTop = viewport?.offsetTop || 0;
  const inset = 8;
  const gap = 6;
  const left = Math.ceil(Math.max(panelRect.left, viewportLeft) + inset);
  const right = Math.floor(Math.min(panelRect.right, viewportLeft + (viewport?.width || window.innerWidth)) - inset);
  const top = Math.ceil(Math.max(panelRect.top, viewportTop) + inset);
  const bottom = Math.floor(Math.min(panelRect.bottom, viewportTop + (viewport?.height || window.innerHeight)) - inset);
  if (right <= left || bottom <= top || buttonRect.bottom <= top || buttonRect.top >= bottom) {
    closeCockpitWidgetManager();
    return;
  }

  const below = Math.max(0, bottom - Math.ceil(buttonRect.bottom + gap));
  const above = Math.max(0, Math.floor(buttonRect.top - gap) - top);
  pop.style.setProperty('--ctx-widget-mgr-max-width', `${right - left}px`);
  pop.style.setProperty('--ctx-widget-mgr-max-height', `${Math.max(below, above) || bottom - top}px`);
  const { width, height } = pop.getBoundingClientRect();
  const openRight = right - buttonRect.left >= buttonRect.right - left;
  const openBelow = height <= below || below >= above;
  const anchorX = openRight ? Math.ceil(buttonRect.left) : Math.floor(buttonRect.right) - width;
  const anchorY = openBelow ? Math.ceil(buttonRect.bottom + gap) : Math.floor(buttonRect.top - gap) - height;
  pop.style.left = `${Math.max(left, Math.min(anchorX, right - width))}px`;
  pop.style.top = `${Math.max(top, Math.min(anchorY, bottom - height))}px`;
}

function trackCockpitManagerPosition() {
  if (stopCockpitManagerPositioning) return;
  let frame = null;
  const update = () => {
    if (typeof window.requestAnimationFrame !== 'function') {
      positionCockpitWidgetManagerPopover();
    } else if (frame == null) {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        positionCockpitWidgetManagerPopover();
      });
    }
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  for (const id of ['panel', 'ctx-cockpit-toolbar', 'btn-ctx-widget-mgr']) {
    const node = el(id);
    if (node) observer?.observe(node);
  }
  const viewport = window.visualViewport;
  const listeners = [[window, 'resize'], [window, 'scroll'], [shadow, 'scroll'], [viewport, 'resize'], [viewport, 'scroll']];
  for (const [target, event] of listeners) target?.addEventListener?.(event, update, { capture: true, passive: true });
  stopCockpitManagerPositioning = () => {
    observer?.disconnect();
    if (frame != null) window.cancelAnimationFrame?.(frame);
    for (const [target, event] of listeners) target?.removeEventListener?.(event, update, true);
    stopCockpitManagerPositioning = null;
  };
}

function renderCockpitWidgetManagerPopover() {
  const pop = el('ctx-widget-mgr-popover');
  const btn = el('btn-ctx-widget-mgr');
  if (btn) btn.setAttribute?.('aria-expanded', cockpitManagerOpen ? 'true' : 'false');
  if (!pop) return;
  cancelCockpitManagerDrag?.();
  if (!cockpitManagerOpen) {
    stopCockpitManagerPositioning?.();
    if (pop.matches?.(':popover-open')) pop.hidePopover();
    pop.hidden = true;
    return;
  }

  pop.hidden = false;
  if (typeof pop.showPopover === 'function' && !pop.matches(':popover-open')) {
    pop.setAttribute('popover', 'manual');
    pop.showPopover();
  }

  const list = el('ctx-widget-mgr-list');
  if (!list) return;
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const layout = getCockpitLayout();

  for (const w of layout.widgets) {
    const def = COCKPIT_WIDGET_DEFS.find(d => d.id === w.id);
    if (!def) continue;
    const row = document.createElement('div');
    row.className = 'ctx-widget-mgr-row';
    row.setAttribute('data-mgr-order-id', w.id);

    const grip = document.createElement('span');
    grip.className = 'ctx-widget-mgr-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';
    grip.title = t('session.widget.holdToSort');

    const lbl = document.createElement('label');
    lbl.className = 'ctx-widget-mgr-check';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = w.visible;
    chk.setAttribute('data-mgr-widget', w.id);
    chk.addEventListener('change', () => {
      toggleCockpitWidgetVisibility(w.id, Boolean(chk.checked));
    });
    const nameSp = document.createElement('span');
    nameSp.textContent = t(def.titleKey);
    lbl.appendChild(chk);
    lbl.appendChild(nameSp);

    const mvWrap = document.createElement('span');
    mvWrap.className = 'ctx-widget-mgr-moves';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'ctx-widget-mini-btn';
    upBtn.textContent = '↑';
    upBtn.title = t('session.widget.moveUp');
    upBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      moveCockpitWidgetStep(w.id, -1, true);
    });
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'ctx-widget-mini-btn';
    downBtn.textContent = '↓';
    downBtn.title = t('session.widget.moveDown');
    downBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      moveCockpitWidgetStep(w.id, 1, true);
    });
    mvWrap.appendChild(upBtn);
    mvWrap.appendChild(downBtn);

    row.appendChild(grip);
    row.appendChild(lbl);
    row.appendChild(mvWrap);
    list.appendChild(row);
  }
  list.scrollTop = scrollTop;
  trackCockpitManagerPosition();
  positionCockpitWidgetManagerPopover();
}

function bindCockpitManagerReorder(list) {
  if (!list || list._cockpitReorderBound) return;
  list._cockpitReorderBound = true;
  const pop = el('ctx-widget-mgr-popover');
  const settleEasing = 'cubic-bezier(0.22, 1.28, 0.36, 1)';
  const settleDuration = 220;
  const rowAnimations = new Map();
  let gesture = null;
  let ignoredPointerId = null;

  const translate = (x, y) => `translate3d(${x}px, ${y}px, 0)`;
  const moveRow = (container, row, before = null) => {
    if (container.moveBefore) container.moveBefore(row, before);
    else container.insertBefore(row, before);
  };
  const capture = (drag) => {
    try { list.setPointerCapture?.(drag.pointerId); } catch { }
  };
  const cancelFrames = (drag) => {
    if (drag.moveFrame != null) window.cancelAnimationFrame?.(drag.moveFrame);
    if (drag.scrollFrame != null) window.cancelAnimationFrame?.(drag.scrollFrame);
    drag.moveFrame = null;
    drag.scrollFrame = null;
  };

  const cancel = () => {
    const drag = gesture;
    if (!drag) return;
    gesture = null;
    cancelCockpitManagerDrag = null;
    clearTimeout(drag.pressTimer);
    cancelFrames(drag);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancelPointer);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', escape, true);
    if (list.hasPointerCapture?.(drag.pointerId)) list.releasePointerCapture(drag.pointerId);
    for (const animation of rowAnimations.values()) animation.cancel();
    rowAnimations.clear();

    if (drag.slot) {
      ignoredPointerId = drag.pointerId;
      drag.flight?.cancel();
      drag.landing?.cancel();
      if (drag.float.matches?.(':popover-open')) drag.float.hidePopover();
      moveRow(list, drag.row, drag.dropped ? drag.slot : drag.originalNext);
      drag.row.classList.remove('is-lifted', 'is-landing');
      drag.row.inert = false;
      drag.slot.remove();
      drag.float.remove();
      list.classList.remove('is-sorting');
    }
  };

  const moveSlot = (drag, listRect, rowCenter) => {
    const center = rowCenter - listRect.top + list.scrollTop;
    const next = drag.rows.find(row => center < row.offsetTop + row.offsetHeight / 2) || null;
    const siblings = Array.from(list.children);
    if (next === (siblings[siblings.indexOf(drag.slot) + 1] || null)) return;

    if (drag.reducedMotion) {
      list.insertBefore(drag.slot, next);
      return;
    }
    // Start each FLIP at the current painted position so reversing direction does not jump.
    const first = drag.rows.map(row => row.getBoundingClientRect().top);
    for (const animation of rowAnimations.values()) animation.cancel();
    rowAnimations.clear();
    list.insertBefore(drag.slot, next);
    const last = drag.rows.map(row => row.getBoundingClientRect().top);
    drag.rows.forEach((row, index) => {
      const dy = first[index] - last[index];
      if (dy && row.animate) {
        rowAnimations.set(row, row.animate(
          [{ transform: translate(0, dy) }, { transform: translate(0, 0) }],
          { duration: settleDuration, easing: settleEasing }
        ));
      }
    });
  };

  const update = (drag) => {
    const rect = list.getBoundingClientRect();
    const left = rect.left + drag.listOffsetX;
    const x = Math.max(-6, Math.min(6, (drag.x - drag.startX) * 0.08));
    const y = drag.y - drag.grabOffsetY;
    moveSlot(drag, rect, y + drag.height / 2);
    drag.float.style.transform = translate(left + x, y);
  };

  const edgeScroll = (time) => {
    const drag = gesture;
    if (!drag?.slot || drag.dropped) return;
    drag.scrollFrame = null;
    const { top, bottom } = list.getBoundingClientRect();
    const edge = Math.min(32, (bottom - top) / 2);
    const distance = drag.y < top + edge ? drag.y - top - edge : Math.max(0, drag.y - bottom + edge);
    if (!distance || edge <= 0) {
      drag.scrollTime = null;
      return;
    }
    const elapsed = Math.min(32, time - (drag.scrollTime ?? time - 16));
    drag.scrollTime = time;
    const speed = Math.max(-1, Math.min(1, distance / edge));
    const before = list.scrollTop;
    list.scrollTop += Math.sign(speed) * Math.max(1, elapsed * 0.42 * Math.abs(speed));
    if (list.scrollTop !== before) {
      update(drag);
      drag.scrollFrame = window.requestAnimationFrame(edgeScroll);
    }
  };

  const queueEdgeScroll = (drag) => {
    if (drag.scrollFrame == null && window.requestAnimationFrame) {
      drag.scrollTime = null;
      drag.scrollFrame = window.requestAnimationFrame(edgeScroll);
    }
  };

  const lift = (drag) => {
    if (gesture !== drag || drag.slot) return;
    clearTimeout(drag.pressTimer);
    const rowRect = drag.row.getBoundingClientRect();
    const rows = Array.from(list.children);
    drag.rows = rows.filter(row => row !== drag.row);
    drag.originalNext = rows[rows.indexOf(drag.row) + 1] || null;
    drag.height = rowRect.height;
    drag.grabOffsetY = drag.startY - rowRect.top;
    drag.listOffsetX = rowRect.left - list.getBoundingClientRect().left;
    drag.reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    const slot = document.createElement('div');
    slot.className = 'ctx-widget-mgr-slot';
    slot.style.height = `${rowRect.height}px`;
    slot.setAttribute('aria-hidden', 'true');
    const floating = document.createElement('div');
    floating.className = 'ctx-widget-mgr-float';
    floating.style.width = `${rowRect.width}px`;
    floating.style.transform = translate(rowRect.left, rowRect.top);
    floating.setAttribute('aria-hidden', 'true');
    drag.slot = slot;
    drag.float = floating;

    list.insertBefore(slot, drag.row);
    pop.appendChild(floating);
    capture(drag);
    moveRow(floating, drag.row);
    drag.row.inert = true;
    drag.row.classList.add('is-lifted');
    if (typeof floating.showPopover === 'function') {
      floating.setAttribute('popover', 'manual');
      floating.showPopover();
    }
    list.classList.add('is-sorting');
    window.getSelection?.()?.removeAllRanges();
    update(drag);
    queueEdgeScroll(drag);
  };

  const move = (event) => {
    const drag = gesture;
    if (!drag || drag.dropped || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      cancel();
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.slot) {
      const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
      if (drag.fromGrip && distance > 3) lift(drag);
      else if (!drag.fromGrip && distance > 6) cancel();
      if (!drag.slot) return;
    }

    event.preventDefault();
    if (list.hasPointerCapture && !list.hasPointerCapture(drag.pointerId)) capture(drag);
    if (typeof window.requestAnimationFrame !== 'function') {
      update(drag);
    } else if (drag.moveFrame == null) {
      drag.moveFrame = window.requestAnimationFrame(() => {
        drag.moveFrame = null;
        update(drag);
      });
    }
    queueEdgeScroll(drag);
  };

  const finish = (event) => {
    const drag = gesture;
    if (!drag || drag.dropped || event.pointerId !== drag.pointerId) return;
    if (!drag.slot) {
      cancel();
      return;
    }
    event.preventDefault();
    ignoredPointerId = drag.pointerId;
    cancelFrames(drag);
    drag.x = event.clientX;
    drag.y = event.clientY;
    update(drag);
    drag.dropped = true;

    const siblings = Array.from(list.children);
    const index = siblings.indexOf(drag.slot);
    const next = siblings[index + 1];
    const neighbor = next || siblings[index - 1];
    if (neighbor) {
      reorderCockpitWidget(drag.row.getAttribute('data-mgr-order-id'),
        neighbor.getAttribute('data-mgr-order-id'), !next, { renderManager: false });
    }

    if (drag.reducedMotion || !drag.float.animate) {
      cancel();
      return;
    }
    const { left, top } = drag.slot.getBoundingClientRect();
    const from = drag.float.style.transform;
    const to = translate(left, top);
    const scale = window.getComputedStyle?.(drag.row)?.transform || 'scale(1.028)';
    drag.row.classList.add('is-landing');
    drag.float.style.transform = to;
    drag.flight = drag.float.animate([{ transform: from }, { transform: to }],
      { duration: settleDuration, easing: settleEasing });
    drag.landing = drag.row.animate(
      [{ transform: scale }, { transform: 'scale(1.02, 0.98)', offset: 0.78 }, { transform: 'scale(1, 1)' }],
      { duration: settleDuration }
    );
    drag.flight.onfinish = cancel;
  };

  const cancelPointer = (event) => {
    if (event.pointerId === gesture?.pointerId && !gesture.dropped) cancel();
  };

  const escape = (event) => {
    if (event.key !== 'Escape' || !gesture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };

  list.addEventListener('click', event => {
    if (ignoredPointerId == null || event.detail === 0 ||
      (event.pointerId != null && event.pointerId !== ignoredPointerId)) return;
    ignoredPointerId = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  list.addEventListener('pointerdown', event => {
    if (event.isPrimary === false || event.button !== 0) return;
    if (gesture?.dropped) cancel();
    if (gesture) return;
    ignoredPointerId = null;
    if (event.target?.closest?.('button') || event.target?.closest?.('input') || event.target?.closest?.('a')) return;
    const row = event.target?.closest?.('[data-mgr-order-id]');
    if (!row) return;

    const fromGrip = Boolean(event.target.closest('.ctx-widget-mgr-grip'));
    const pending = {
      row, fromGrip, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY
    };
    gesture = pending;
    cancelCockpitManagerDrag = cancel;
    pending.pressTimer = setTimeout(() => lift(pending), fromGrip ? 120 : 180);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
  });
  activeDisposers.add(() => {
    cancel();
    stopCockpitManagerPositioning?.();
  });
}

function initSessionCockpitGrid() {
  const toolbar = el('ctx-cockpit-toolbar');
  const grid = el('ctx-bento-grid');
  if (!toolbar && !grid) return;
  bindCockpitManagerReorder(el('ctx-widget-mgr-list'));

  if (toolbar && !toolbar._cockpitBound) {
    toolbar._cockpitBound = true;
    const editor = el('ctx-custom-preset-editor');
    const nameInput = el('ctx-custom-preset-name');
    let editAction = 'save';
    editor?.addEventListener('submit', event => {
      event.preventDefault();
      const name = String(nameInput?.value || '').replace(/[（）()]/g, ' ').trim();
      if (!name) {
        nameInput?.focus();
        return;
      }
      updateCustomCockpitPreset(editAction, name);
      editor.hidden = true;
    });
    const emptyOpenBtn = el('btn-ctx-empty-open-mgr');
    if (emptyOpenBtn && !emptyOpenBtn._cockpitBound) {
      emptyOpenBtn._cockpitBound = true;
      emptyOpenBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        cockpitManagerOpen = true;
        renderCockpitWidgetManagerPopover();
      });
    }
    toolbar.addEventListener('click', (e) => {
      const target = e?.target;
      const action = target?.closest?.('[data-custom-preset-action]')?.getAttribute('data-custom-preset-action');
      if (action) {
        if (action === 'new-empty-group') {
          editor && (editor.hidden = true);
          createEmptyCustomCockpitGroup({ persist: true });
          return;
        }
        if (action === 'save' || action === 'rename') {
          editAction = action;
          const layout = getCockpitLayout();
          const active = layout.customPresets?.find(preset => preset.id === layout.activeCustomId);
          nameInput.value = action === 'rename' ? (active?.name || '') : '';
          editor.hidden = false;
          nameInput.focus();
        } else {
          editor.hidden = true;
          if (action !== 'cancel') updateCustomCockpitPreset(action);
        }
        return;
      }
      const presetBtn = target?.closest?.('[data-cockpit-preset]');
      if (presetBtn) {
        if (toolbar._suppressPresetClick) {
          toolbar._suppressPresetClick = false;
          return;
        }
        const pid = presetBtn.getAttribute('data-cockpit-preset');
        applyCockpitPreset(pid, { persist: true });
        return;
      }
      if (target?.closest?.('#btn-ctx-widget-mgr')) {
        cockpitManagerOpen = !cockpitManagerOpen;
        renderCockpitWidgetManagerPopover();
        return;
      }
      if (target?.closest?.('#btn-ctx-preset-reset')) {
        const layout = getCockpitLayout();
        const curPreset = layout.activeCustomId || layout.presetId || 'cockpit';
        applyCockpitPreset(curPreset, { persist: true });
        closeCockpitWidgetManager();
      }
    });

    // 预设条 2D 点对点直接互换拖拽：严格对齐 2d.html 与本轮硬参数
    // 5px / 140ms 激活 · 11px / 22% 内缩 · 140ms 冷却 · 250ms FLIP · 3.5deg 低通倾角 · 0.02 拉伸 · 末尾新建分组永不参与交换且零高亮
    const presetTrack = el('ctx-cockpit-presets-track') || toolbar.querySelector?.('.ctx-cockpit-presets');
    const presetShell = el('ctx-cockpit-presets-shell') || presetTrack?.parentElement || null;
    if (presetTrack && !presetTrack._presetDragBound) {
      presetTrack._presetDragBound = true;
      let pDrag = null;
      const PRESET_LONG_PRESS_MS = 140;
      const PRESET_DRAG_THRESHOLD_PX = 5;
      const PRESET_DEADZONE_PX = 11;
      const PRESET_COOLDOWN_MS = 140;
      const PRESET_FLIP_MS = 250;
      const PRESET_MAX_TILT_DEG = 0;
      const PRESET_POINTER_WEIGHT = 0.65;
      const PRESET_GHOST_CENTER_WEIGHT = 0.35;
      const PRESET_LOWPASS_KEEP = 0.72;
      const PRESET_LOWPASS_NEW = 0.28;
      const PRESET_MAX_STRETCH = 0;
      const isPresetReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

      const getAddBtnNode = () => el('btn-ctx-preset-new-group') || presetTrack.querySelector?.('.ag-preset-add-btn') || null;
      const ensureAddBtnLast = () => {
        const addBtn = getAddBtnNode();
        if (addBtn && presetTrack.lastElementChild !== addBtn) {
          presetTrack.appendChild?.(addBtn);
        }
      };
      const getTrackChipNodes = () => Array.from(presetTrack.children || []).filter((n) => {
        if (!n) return false;
        if (n.id === 'btn-ctx-preset-new-group' || n.classList?.contains?.('ag-preset-add-btn')) return false;
        return Boolean(n.getAttribute?.('data-cockpit-preset'));
      });
      const getChipPresetId = (node) => node?.getAttribute?.('data-cockpit-preset') || '';

      const ensurePresetGhostPortalStyle = () => {
        try {
          if (typeof document === 'undefined' || !document.head) return;
          if (document.getElementById('ag-pbar-ghost-portal-style')) return;
          const st = document.createElement('style');
          st.id = 'ag-pbar-ghost-portal-style';
          st.textContent = `
            #ag-pbar-ghost-portal.ag-pbar-ghost-layer {
              position: fixed !important;
              inset: 0 !important;
              pointer-events: none !important;
              z-index: 2147483647 !important;
              overflow: visible !important;
              contain: none !important;
            }
            #ag-pbar-ghost-portal .ag-preset-drag-ghost {
              position: fixed !important;
              left: 0;
              top: 0;
              margin: 0 !important;
              pointer-events: none !important;
              z-index: 2147483647 !important;
              display: inline-flex !important;
              align-items: center !important;
              gap: 5px !important;
              height: 30px !important;
              padding: 0 10px 0 7px !important;
              border-radius: 7px !important;
              box-sizing: border-box !important;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
              font-size: 12px !important;
              font-weight: 500 !important;
              line-height: 1 !important;
              white-space: nowrap !important;
              background: #1f1f24 !important;
              color: #e4e4e7 !important;
              border: 1px solid rgba(255, 255, 255, 0.22) !important;
              box-shadow: 0 12px 30px -6px rgba(0, 0, 0, 0.55), 0 4px 12px -2px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
              opacity: 0.98 !important;
              transform-origin: center center !important;
              will-change: transform !important;
              transition: box-shadow 140ms ease, opacity 140ms ease !important;
            }
            #ag-pbar-ghost-portal[data-theme="light"] .ag-preset-drag-ghost {
              background: #ffffff !important;
              color: #18181b !important;
              border-color: rgba(24, 24, 27, 0.20) !important;
              box-shadow: 0 12px 28px -6px rgba(15, 23, 42, 0.20), 0 4px 10px -2px rgba(15, 23, 42, 0.10), 0 0 0 1px rgba(15, 23, 42, 0.06) !important;
            }
            #ag-pbar-ghost-portal .ag-preset-drag-ghost.is-dropping {
              box-shadow: 0 2px 6px rgba(0, 0, 0, 0.14) !important;
              opacity: 1 !important;
            }
            #ag-pbar-ghost-portal .ag-preset-drag-ghost .ag-preset-grip {
              display: inline-flex !important;
              align-items: center !important;
              justify-content: center !important;
              width: 14px !important;
              height: 20px !important;
              flex: 0 0 14px !important;
              color: inherit !important;
              opacity: 0.72 !important;
            }
            #ag-pbar-ghost-portal .ag-preset-drag-ghost .ag-preset-label {
              white-space: nowrap !important;
            }
            #ag-pbar-ghost-portal .ag-preset-drag-ghost .ctx-preset-pill-del {
              display: none !important;
            }
          `;
          document.head.appendChild(st);
        } catch { }
      };

      const ensurePresetGhostLayer = () => {
        const canPortalBody = Boolean(
          typeof document !== 'undefined'
          && document.body
          && typeof document.body.appendChild === 'function'
          && document.head
          && typeof window?.getComputedStyle === 'function'
          && host?.isConnected !== false
        );
        if (canPortalBody) {
          ensurePresetGhostPortalStyle();
          let portal = document.getElementById?.('ag-pbar-ghost-portal') || null;
          if (!portal && typeof document.createElement === 'function') {
            portal = document.createElement('div');
            portal.id = 'ag-pbar-ghost-portal';
            portal.className = 'ag-pbar-ghost-layer';
            portal.setAttribute?.('aria-hidden', 'true');
            document.body.appendChild(portal);
          } else if (portal && portal.parentElement !== document.body) {
            document.body.appendChild(portal);
          }
          if (portal) {
            const themeVal = host?.getAttribute?.('data-theme') || 'dark';
            portal.setAttribute?.('data-theme', themeVal);
            return portal;
          }
        }
        const ghostRoot = (typeof shadow !== 'undefined' && shadow) ? shadow : document.body;
        if (!ghostRoot) return null;
        let layer = ghostRoot.querySelector?.('.ag-pbar-ghost-layer') || null;
        if (!layer && typeof document.createElement === 'function') {
          layer = document.createElement('div');
          layer.className = 'ag-pbar-ghost-layer';
          layer.setAttribute?.('aria-hidden', 'true');
          ghostRoot.appendChild?.(layer);
        }
        return layer || ghostRoot;
      };

      const triggerSwapPartnerPulse = (partnerEl) => {
        if (!partnerEl || isPresetReducedMotion()) return;
        partnerEl.classList?.remove?.('is-swap-partner');
        try { void partnerEl.offsetWidth; } catch { }
        partnerEl.classList?.add?.('is-swap-partner');
        setTimeout(() => { partnerEl?.classList?.remove?.('is-swap-partner'); }, 440);
      };

      let shellHeightTimer = null;
      const animatePresetShellHeight = (prevH, nextH) => {
        if (!presetShell || !presetShell.style || Math.abs(prevH - nextH) < 1) return;
        if (shellHeightTimer) clearTimeout(shellHeightTimer);
        presetShell.style.transition = 'none';
        presetShell.style.height = `${prevH}px`;
        try { void presetShell.offsetHeight; } catch { }
        const dur = isPresetReducedMotion() ? 100 : Math.min(260, PRESET_FLIP_MS);
        presetShell.style.transition = `height ${dur}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        presetShell.style.height = `${nextH}px`;
        shellHeightTimer = setTimeout(() => {
          if (presetShell.style) {
            presetShell.style.height = '';
            presetShell.style.transition = '';
          }
        }, dur + 30);
      };

      const flipTimers = new WeakMap();
      const applyPresetOrderWithFLIP = (orderedIds) => {
        const nodes = getTrackChipNodes();
        const addBtn = getAddBtnNode();
        const byId = new Map();
        for (const n of nodes) {
          const id = getChipPresetId(n);
          if (id) byId.set(id, n);
        }
        const flipTargets = nodes.filter(n => !pDrag || n !== pDrag.chipEl);
        if (addBtn) flipTargets.push(addBtn);

        const reduced = isPresetReducedMotion();
        const firstRects = new Map();
        const prevH = presetShell?.getBoundingClientRect?.()?.height || 0;
        if (!reduced) {
          for (const n of flipTargets) {
            const oldT = flipTimers.get(n);
            if (oldT) clearTimeout(oldT);
            if (typeof n.getBoundingClientRect === 'function') {
              n.style.transition = 'none';
              n.style.transform = '';
              firstRects.set(n, n.getBoundingClientRect());
            }
          }
        }
        for (const id of orderedIds) {
          const n = byId.get(id);
          if (n) {
            if (addBtn && addBtn.parentElement === presetTrack && typeof presetTrack.insertBefore === 'function') {
              presetTrack.insertBefore(n, addBtn);
            } else {
              presetTrack.appendChild?.(n);
            }
          }
        }
        ensureAddBtnLast();
        if (presetShell?.style) presetShell.style.height = '';
        const nextH = presetShell?.getBoundingClientRect?.()?.height || 0;
        if (prevH > 0 && nextH > 0) animatePresetShellHeight(prevH, nextH);

        if (reduced || !firstRects.size) return;
        const moved = [];
        for (const [n, first] of firstRects.entries()) {
          const last = n.getBoundingClientRect();
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            n.style.transition = 'none';
            n.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
            moved.push(n);
          }
        }
        if (!moved.length) return;
        try { void presetTrack.offsetHeight; } catch { }
        const startAnim = () => {
          for (const n of moved) {
            n.style.transition = `transform ${PRESET_FLIP_MS}ms cubic-bezier(0.22, 1.28, 0.36, 1)`;
            n.style.transform = 'translate3d(0, 0, 0)';
            const timer = setTimeout(() => {
              n.style.transition = '';
              n.style.transform = '';
            }, PRESET_FLIP_MS + 35);
            flipTimers.set(n, timer);
          }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(startAnim);
        else startAnim();
      };

      const hitTestFrozenHomeSlots = (hitX, hitY, homeSlots, deadzonePx = PRESET_DEADZONE_PX) => {
        if (!Array.isArray(homeSlots) || homeSlots.length === 0) return -1;
        for (let i = 0; i < homeSlots.length; i++) {
          const slot = homeSlots[i];
          const r = slot?.rect;
          if (!r) continue;
          const insetX = Math.min(deadzonePx, r.width * 0.22);
          const insetY = Math.min(deadzonePx * 0.4, r.height * 0.22);
          if (
            hitX >= r.left + insetX
            && hitX <= r.right - insetX
            && hitY >= r.top + insetY
            && hitY <= r.bottom - insetY
          ) {
            return slot.index !== undefined ? slot.index : i;
          }
        }
        return -1;
      };

      const applyDirectSwapOrder = (targetIdx) => {
        if (!pDrag || !pDrag.active) return;
        if (targetIdx < 0 || targetIdx >= pDrag.baseOrder.length) return;
        if (targetIdx === pDrag.currentTargetIndex) return;
        const prevTargetIdx = pDrag.currentTargetIndex;
        pDrag.currentTargetIndex = targetIdx;
        const nextOrder = pDrag.baseOrder.slice();
        if (targetIdx !== pDrag.originIndex) {
          const tmp = nextOrder[pDrag.originIndex];
          nextOrder[pDrag.originIndex] = nextOrder[targetIdx];
          nextOrder[targetIdx] = tmp;
        }
        pDrag.previewOrder = nextOrder;
        applyPresetOrderWithFLIP(nextOrder);
        if (targetIdx !== pDrag.originIndex) {
          triggerSwapPartnerPulse(pDrag.homeSlots?.[targetIdx]?.el);
        } else if (prevTargetIdx !== pDrag.originIndex) {
          triggerSwapPartnerPulse(pDrag.homeSlots?.[prevTargetIdx]?.el);
        }
        pDrag.lastReorderAt = Date.now();
      };

      // 挂载算法与参数供测试定向验证
      presetTrack.__agPresetSwapApi = {
        hitTestFrozenHomeSlots,
        params: {
          mode: 'swap',
          longPressMs: PRESET_LONG_PRESS_MS,
          dragThresholdPx: PRESET_DRAG_THRESHOLD_PX,
          deadzonePx: PRESET_DEADZONE_PX,
          cooldownMs: PRESET_COOLDOWN_MS,
          flipMs: PRESET_FLIP_MS,
          maxTiltDeg: PRESET_MAX_TILT_DEG,
          pointerWeight: PRESET_POINTER_WEIGHT,
          ghostCenterWeight: PRESET_GHOST_CENTER_WEIGHT,
          lowpassKeep: PRESET_LOWPASS_KEEP,
          lowpassNew: PRESET_LOWPASS_NEW,
          maxStretch: PRESET_MAX_STRETCH
        }
      };

      const isPresetImmediateEnv = () => Boolean(
        (typeof process !== 'undefined' && process.env?.NODE_TEST_CONTEXT)
        || typeof HTMLElement === 'undefined'
        || !(presetTrack instanceof HTMLElement)
      );

      let activePresetDrop = null;
      const finalizeActivePresetDropNow = () => {
        if (activePresetDrop && typeof activePresetDrop.finalize === 'function') {
          activePresetDrop.finalize();
        }
      };

      const activatePresetDrag = (clientX, clientY) => {
        if (!pDrag || pDrag.active) return;
        if (pDrag.pressTimer) {
          clearTimeout(pDrag.pressTimer);
          pDrag.pressTimer = null;
        }
        const chipNodes = getTrackChipNodes();
        const originIndex = chipNodes.indexOf(pDrag.chipEl);
        const homeSlots = chipNodes.map((node, index) => {
          const r = typeof node.getBoundingClientRect === 'function'
            ? node.getBoundingClientRect()
            : { left: index * 86, right: (index + 1) * 86 - 7, top: 0, bottom: 30, width: 79, height: 30 };
          return { index, id: getChipPresetId(node), el: node, rect: r };
        });
        const baseOrder = homeSlots.map(s => s.id).filter(Boolean);
        const rect = (originIndex >= 0 && homeSlots[originIndex]?.rect)
          ? homeSlots[originIndex].rect
          : (typeof pDrag.chipEl?.getBoundingClientRect === 'function'
            ? pDrag.chipEl.getBoundingClientRect()
            : { left: clientX - 24, top: clientY - 12, width: 84, height: 30 });

        pDrag.armed = true;
        pDrag.active = true;
        presetDragInProgress = true;
        pDrag.baseOrder = baseOrder.length === pDrag.initialOrder.length ? baseOrder : pDrag.initialOrder.slice();
        pDrag.originIndex = originIndex >= 0 ? originIndex : Math.max(0, pDrag.baseOrder.indexOf(pDrag.presetId));
        pDrag.currentTargetIndex = pDrag.originIndex;
        pDrag.homeSlots = homeSlots;
        pDrag.offsetX = clientX - rect.left;
        pDrag.offsetY = clientY - rect.top;
        pDrag.ghostW = rect.width > 0 ? rect.width : 84;
        pDrag.ghostH = rect.height > 0 ? rect.height : 30;
        pDrag.lastMoveX = clientX;
        pDrag.smoothVx = 0;
        pDrag.ghostX = rect.left;
        pDrag.ghostY = rect.top;
        try {
          if (pDrag.pointerId != null) pDrag.chipEl?.setPointerCapture?.(pDrag.pointerId);
        } catch { }
        try {
          const sel = window.getSelection?.();
          if (sel && sel.rangeCount > 0) sel.removeAllRanges?.();
        } catch { }
        host?.setAttribute?.('data-preset-dragging', 'true');
        pDrag.chipEl?.classList?.remove?.('is-jelly-settling');
        pDrag.chipEl?.classList?.add?.('is-dragging', 'is-drag-placeholder');

        const ghostLayer = ensurePresetGhostLayer();
        if (ghostLayer && typeof document.createElement === 'function') {
          const reduced = isPresetReducedMotion();
          const ghost = document.createElement('div');
          ghost.className = 'ctx-preset-drag-ghost ag-preset-drag-ghost';
          ghost.setAttribute?.('data-preset-drag-ghost', pDrag.presetId);
          ghost.style.width = `${pDrag.ghostW}px`;
          ghost.style.height = `${pDrag.ghostH}px`;
          ghost.style.zIndex = '2147483647';
          ghost.style.pointerEvents = 'none';
          ghost.style.transform = `translate3d(${rect.left.toFixed(2)}px, ${rect.top.toFixed(2)}px, 0)`;

          const tiltWrap = document.createElement('div');
          tiltWrap.className = 'ag-ghost-tilt';

          const surface = document.createElement('div');
          const isActivePill = Boolean(pDrag.chipEl?.classList?.contains?.('active') || pDrag.chipEl?.classList?.contains?.('is-active'));
          surface.className = `ctx-preset-btn ctx-preset-pill ag-ghost-surface${isActivePill ? ' active is-active-style' : ''}${reduced ? ' is-reduced-lift' : ''}`;
          const gripSpan = createPresetSixDotGripElement();
          const lblSpan = document.createElement('span');
          lblSpan.className = 'ctx-preset-label ag-preset-label';
          lblSpan.textContent = String(
            pDrag.chipEl?.querySelector?.('.ctx-preset-label')?.textContent
            || pDrag.chipEl?.textContent
            || ''
          ).replace(/[‹›⋮]/g, '').trim();
          surface.appendChild?.(gripSpan);
          surface.appendChild?.(lblSpan);

          tiltWrap.appendChild?.(surface);
          ghost.appendChild?.(tiltWrap);
          ghostLayer.appendChild?.(ghost);
          if (typeof requestAnimationFrame === 'function' && !isPresetImmediateEnv()) {
            requestAnimationFrame(() => {
              if (surface.isConnected) surface.classList?.add?.('is-shadow-visible');
            });
          } else {
            surface.classList?.add?.('is-shadow-visible');
          }
          pDrag.ghostEl = ghost;
          pDrag.ghostTiltEl = tiltWrap;
          pDrag.ghostSurfaceEl = surface;
        }
      };

      const finishPresetDragWithDrop = ({ restoreOriginal = false, commitOrder = null } = {}) => {
        if (!pDrag) return;
        const dragSnap = pDrag;
        if (dragSnap.pressTimer) clearTimeout(dragSnap.pressTimer);
        window.removeEventListener?.('pointermove', onPMove);
        window.removeEventListener?.('pointerup', onPUp);
        window.removeEventListener?.('pointercancel', onPCancel);
        window.removeEventListener?.('blur', onPCancel);
        window.removeEventListener?.('keydown', onPEsc, true);
        pDrag = null;
        host?.removeAttribute?.('data-preset-dragging');

        if (restoreOriginal && dragSnap.active && Array.isArray(dragSnap.baseOrder || dragSnap.initialOrder)) {
          applyPresetOrderWithFLIP(dragSnap.baseOrder || dragSnap.initialOrder);
        }

        const commitNow = () => {
          if (dragSnap.ghostEl) {
            try { dragSnap.ghostEl.remove?.(); } catch { }
          }
          if (dragSnap.chipEl) {
            dragSnap.chipEl.classList?.remove?.('is-dragging', 'is-drag-placeholder');
          }
          presetDragInProgress = false;
          if (dragSnap.active) {
            if (Array.isArray(commitOrder)) {
              lastCommittedPresetOrderAt = Date.now();
              const layout = getCockpitLayout();
              const saved = persistCockpitLayout({ ...layout, presetOrder: commitOrder }, { persistHost: true });
              renderCockpitPresetsTrack(saved);
            } else if (dragSnap.presetId) {
              renderCockpitPresetsTrack(getCockpitLayout());
            }
          }
        };

        if (!dragSnap.active || !dragSnap.ghostEl || isPresetImmediateEnv()) {
          commitNow();
          return;
        }

        const reduced = isPresetReducedMotion();
        const dropMs = reduced ? 110 : 200;
        const targetRect = typeof dragSnap.chipEl?.getBoundingClientRect === 'function'
          ? dragSnap.chipEl.getBoundingClientRect()
          : null;
        if (!targetRect || targetRect.width <= 0) {
          commitNow();
          return;
        }
        let settled = false;
        const finalize = () => {
          if (settled) return;
          settled = true;
          if (activePresetDrop && activePresetDrop.timer) clearTimeout(activePresetDrop.timer);
          if (activePresetDrop && activePresetDrop.finalize === finalize) activePresetDrop = null;
          commitNow();
        };
        dragSnap.ghostEl.classList?.add?.('is-dropping');
        if (reduced) dragSnap.ghostEl.classList?.add?.('is-reduced');
        if (dragSnap.ghostTiltEl) dragSnap.ghostTiltEl.style.transform = 'rotate(0deg) scale(1, 1)';
        dragSnap.ghostEl.style.transform = `translate3d(${targetRect.left.toFixed(2)}px, ${targetRect.top.toFixed(2)}px, 0)`;
        const timer = setTimeout(finalize, dropMs + 25);
        activePresetDrop = { finalize, timer };
      };

      const clearPDrag = ({ restoreOriginal = false } = {}) => {
        finalizeActivePresetDropNow();
        finishPresetDragWithDrop({ restoreOriginal, commitOrder: null });
      };
      const onPCancel = () => finishPresetDragWithDrop({ restoreOriginal: true, commitOrder: null });
      const onPEsc = (ev) => {
        if (ev.key === 'Escape' && pDrag) {
          ev.preventDefault?.();
          ev.stopPropagation?.();
          finishPresetDragWithDrop({ restoreOriginal: true, commitOrder: null });
        }
      };
      const onPMove = (ev) => {
        if (!pDrag) return;
        const cx = ev.clientX || 0;
        const cy = ev.clientY || 0;
        const dist = Math.hypot(cx - pDrag.startX, cy - pDrag.startY);
        if (!pDrag.active && dist > PRESET_DRAG_THRESHOLD_PX) {
          ev.preventDefault?.();
          activatePresetDrag(cx, cy);
        }
        if (!pDrag.active) return;
        ev.preventDefault?.();
        const left = cx - pDrag.offsetX;
        const top = cy - pDrag.offsetY;
        pDrag.ghostX = left;
        pDrag.ghostY = top;
        const vx = cx - (pDrag.lastMoveX ?? cx);
        pDrag.lastMoveX = cx;
        pDrag.smoothVx = (pDrag.smoothVx || 0) * PRESET_LOWPASS_KEEP + vx * PRESET_LOWPASS_NEW;
        if (Math.abs(pDrag.smoothVx) < 0.02) pDrag.smoothVx = 0;

        if (pDrag.ghostEl) {
          pDrag.ghostEl.style.transform = `translate3d(${left.toFixed(2)}px, ${top.toFixed(2)}px, 0)`;
          if (pDrag.ghostTiltEl) {
            if (!isPresetReducedMotion()) {
              const tiltDeg = Math.max(-PRESET_MAX_TILT_DEG, Math.min(PRESET_MAX_TILT_DEG, pDrag.smoothVx * 0.35));
              const stretch = Math.min(PRESET_MAX_STRETCH, Math.abs(pDrag.smoothVx) * 0.0014);
              pDrag.ghostTiltEl.style.transform =
                `rotate(${tiltDeg.toFixed(2)}deg) scale(${(1 + stretch).toFixed(4)}, ${(1 - stretch * 0.7).toFixed(4)})`;
            } else {
              pDrag.ghostTiltEl.style.transform = '';
            }
          }
        }
        const now = Date.now();
        if (now - (pDrag.lastReorderAt || 0) < PRESET_COOLDOWN_MS) return;

        const ghostCX = left + pDrag.ghostW * 0.5;
        const ghostCY = top + pDrag.ghostH * 0.5;
        const trackRect = typeof presetTrack.getBoundingClientRect === 'function' ? presetTrack.getBoundingClientRect() : null;
        const outMargin = 54;
        const outsideTrack = Boolean(
          trackRect && trackRect.width > 0 && trackRect.height > 0 && (
            cx < trackRect.left - outMargin || cx > trackRect.right + outMargin
            || cy < trackRect.top - outMargin || cy > trackRect.bottom + outMargin
          )
        );
        if (outsideTrack) {
          if (pDrag.outsideValid !== true) {
            pDrag.outsideValid = true;
            if (pDrag.currentTargetIndex !== pDrag.originIndex) {
              applyDirectSwapOrder(pDrag.originIndex);
            }
          }
          return;
        }
        pDrag.outsideValid = false;
        const hitX = cx * PRESET_POINTER_WEIGHT + ghostCX * PRESET_GHOST_CENTER_WEIGHT;
        const hitY = cy * PRESET_POINTER_WEIGHT + ghostCY * PRESET_GHOST_CENTER_WEIGHT;
        const hitIdx = hitTestFrozenHomeSlots(hitX, hitY, pDrag.homeSlots, PRESET_DEADZONE_PX);
        if (hitIdx !== -1 && hitIdx !== pDrag.currentTargetIndex) {
          applyDirectSwapOrder(hitIdx);
        }
      };
      const onPUp = () => {
        if (!pDrag) return;
        const { active, baseOrder, initialOrder, previewOrder, outsideValid } = pDrag;
        const refBase = baseOrder || initialOrder;
        const changed = Boolean(active && !outsideValid && Array.isArray(previewOrder) && JSON.stringify(previewOrder) !== JSON.stringify(refBase));
        if (active) {
          toolbar._suppressPresetClick = true;
          setTimeout(() => { toolbar._suppressPresetClick = false; }, 260);
        }
        finishPresetDragWithDrop({
          restoreOriginal: Boolean(active && outsideValid),
          commitOrder: changed ? previewOrder : null
        });
      };
      presetTrack.addEventListener?.('pointerdown', (ev) => {
        if (ev.isPrimary === false || (ev.button != null && ev.button !== 0)) return;
        if (ev.target?.closest?.('.ag-preset-add-btn, #btn-ctx-preset-new-group')) return;
        const btn = ev.target?.closest?.('[data-cockpit-preset]');
        const pid = btn?.getAttribute?.('data-cockpit-preset');
        if (!pid) return;
        clearPDrag();
        const layout = getCockpitLayout();
        const curOrder = normalizeCockpitPresetOrder(layout.presetOrder, layout.customPresets || []).slice();
        pDrag = {
          presetId: pid,
          pointerId: ev.pointerId ?? null,
          chipEl: btn,
          startX: ev.clientX || 0,
          startY: ev.clientY || 0,
          offsetX: 0,
          offsetY: 0,
          ghostW: 84,
          ghostH: 30,
          ghostX: 0,
          ghostY: 0,
          lastMoveX: ev.clientX || 0,
          smoothVx: 0,
          ghostEl: null,
          ghostTiltEl: null,
          ghostSurfaceEl: null,
          armed: false,
          active: false,
          outsideValid: false,
          lastReorderAt: 0,
          initialOrder: curOrder,
          baseOrder: curOrder.slice(),
          originIndex: Math.max(0, curOrder.indexOf(pid)),
          currentTargetIndex: Math.max(0, curOrder.indexOf(pid)),
          homeSlots: [],
          previewOrder: curOrder.slice(),
          pressTimer: setTimeout(() => {
            if (!pDrag || pDrag.presetId !== pid) return;
            activatePresetDrag(pDrag.startX, pDrag.startY);
          }, PRESET_LONG_PRESS_MS)
        };
        window.addEventListener?.('pointermove', onPMove, { passive: false });
        window.addEventListener?.('pointerup', onPUp);
        window.addEventListener?.('pointercancel', onPCancel);
        window.addEventListener?.('blur', onPCancel);
        window.addEventListener?.('keydown', onPEsc, true);
      });
      presetTrack.addEventListener?.('keydown', (ev) => {
        const btn = ev.target?.closest?.('[data-cockpit-preset]');
        const pid = btn?.getAttribute?.('data-cockpit-preset');
        if (!pid) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault?.();
          applyCockpitPreset(pid, { persist: true });
        }
      });
      activeDisposers.add(() => clearPDrag({ restoreOriginal: false }));
    }
  }

  if (typeof shadow !== 'undefined' && shadow && typeof shadow.addEventListener === 'function' && !shadow._cockpitOutsideBound) {
    shadow._cockpitOutsideBound = true;
    shadow.addEventListener('click', (e) => {
      if (!cockpitManagerOpen) return;
      const inMgr = e?.target?.closest?.('#ctx-widget-mgr-wrap');
      if (!inMgr) closeCockpitWidgetManager();
    });
  }

  if (grid && !grid._cockpitBound) {
    grid._cockpitBound = true;
    const ensureCardEightDirHandles = (card) => {
      if (!card || !card.getAttribute?.('data-widget-id') || card._ag8DirHandlesReady) return;
      card._ag8DirHandlesReady = true;
      // 1. 复用或补建右下角（se）柄并标注全向属性
      let seHandle = card.querySelector?.('.ag-widget-resize-handle:not([data-resize-edge]):not([data-resize-vertical])')
        || card.querySelector?.('.ag-widget-resize-handle[data-resize-vertical="bottom"][data-resize-edge="right"]');
      if (!seHandle) {
        seHandle = document.createElement('div');
        seHandle.className = 'ctx-widget-resize-handle ag-widget-resize-handle';
        card.appendChild(seHandle);
      }
      seHandle.setAttribute('data-resize-vertical', 'bottom');
      seHandle.setAttribute('data-resize-edge', 'right');
      seHandle.setAttribute('data-resize-axis', 'both');
      seHandle.setAttribute('data-resize-dir', 'se');
      seHandle.setAttribute('aria-hidden', 'true');

      // 2. 补齐其余 3 个角柄（nw / ne / sw）
      const extraCorners = [
        { vertical: 'top', edge: 'left', dir: 'nw' },
        { vertical: 'top', edge: 'right', dir: 'ne' },
        { vertical: 'bottom', edge: 'left', dir: 'sw' }
      ];
      for (const spec of extraCorners) {
        const grip = document.createElement('div');
        grip.className = 'ctx-widget-resize-handle ag-widget-resize-handle';
        grip.setAttribute('data-resize-vertical', spec.vertical);
        grip.setAttribute('data-resize-edge', spec.edge);
        grip.setAttribute('data-resize-axis', 'both');
        grip.setAttribute('data-resize-dir', spec.dir);
        grip.setAttribute('aria-hidden', 'true');
        card.appendChild(grip);
      }
      // 3. 补齐 4 条纯边柄（n / s 仅改高、w / e 仅改宽）
      const edges = [
        { axis: 'y', vertical: 'top', dir: 'n' },
        { axis: 'y', vertical: 'bottom', dir: 's' },
        { axis: 'x', edge: 'left', dir: 'w' },
        { axis: 'x', edge: 'right', dir: 'e' }
      ];
      for (const edgeSpec of edges) {
        const edgeEl = document.createElement('div');
        edgeEl.className = 'ctx-widget-resize-edge ag-widget-resize-edge';
        edgeEl.setAttribute('data-resize-axis', edgeSpec.axis);
        edgeEl.setAttribute('data-resize-dir', edgeSpec.dir);
        if (edgeSpec.vertical) edgeEl.setAttribute('data-resize-vertical', edgeSpec.vertical);
        if (edgeSpec.edge) edgeEl.setAttribute('data-resize-edge', edgeSpec.edge);
        edgeEl.setAttribute('aria-hidden', 'true');
        card.appendChild(edgeEl);
      }
    };
    for (const card of Array.from(grid.children || [])) {
      ensureCardEightDirHandles(card);
    }

    grid.addEventListener('click', (e) => {
      const actBtn = e?.target?.closest?.('[data-widget-action]');
      if (!actBtn) return;
      const card = actBtn.closest?.('[data-widget-id]');
      const wId = card?.getAttribute?.('data-widget-id');
      if (!wId) return;
      e.stopPropagation();
      const action = actBtn.getAttribute('data-widget-action');
      if (action === 'cycle-span') setCockpitWidgetSpan(wId);
      else if (action === 'cycle-height') setCockpitWidgetHeight(wId);
      else if (action === 'move-up') moveCockpitWidgetStep(wId, -1);
      else if (action === 'move-down') moveCockpitWidgetStep(wId, 1);
    });

    grid.addEventListener('keydown', (e) => {
      const handle = e?.target?.closest?.('.ctx-widget-drag-handle');
      if (!handle) return;
      const card = handle.closest?.('[data-widget-id]');
      const wId = card?.getAttribute?.('data-widget-id');
      if (!wId) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        moveCockpitWidgetStep(wId, -1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        moveCockpitWidgetStep(wId, 1);
      }
    });

    // Pointer gestures for card ordering and resizing.
    let pressTimer = null;
    let activeDrag = null;
    let resizeBadgeEl = null;
    const magnetLines = new Map();
    let resizeFrame = null;
    let scrollFrame = null;
    let geometryFrame = null;
    let suppressReleaseClick = null;
    const flipAnimations = new Map();
    const hostPanel = el('panel');
    const sessionPane = el('pane-ctx-session');
    const isSkyline = () => grid.getAttribute?.('data-layout-engine') === 'skyline';
    const gridIsVisible = () => grid.isConnected !== false && grid.offsetWidth !== 0;
    const motionReduced = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
    const visibleCards = () => Array.from(grid.children || []).filter(card =>
      !card.hidden && card.getAttribute?.('data-widget-id'));
    const readMagnetNeighbors = (card, gridRect) => visibleCards()
      .filter(other => other !== card)
      .map(other => {
        const box = other.getBoundingClientRect();
        return { x: Math.round(box.left - gridRect.left), y: Math.round(box.top - gridRect.top),
          w: Math.round(box.width), h: Math.round(box.height) };
      })
      .filter(box => [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0);
    const readSideFitGuides = (drag, gridRect) => {
      if (!drag.neighbors || drag.singleColumn) return [];
      const layout = getCockpitLayout();
      const cards = visibleCards();
      const index = cards.indexOf(drag.card);
      const configs = new Map(layout.widgets.map(widget => [widget.id, widget]));
      const boxes = cards.map((card, i) => {
        const rect = card.getBoundingClientRect();
        const id = card.getAttribute('data-widget-id');
        return {
          x: Math.round(rect.left - gridRect.left),
          y: Math.round(rect.top - gridRect.top),
          w: resolveSkylineCardWidth(configs.get(id), drag.gridW, COCKPIT_SKYLINE_GAP),
          h: Math.ceil(card.offsetHeight || rect.height),
          alignBelow: id === 'request-cost' && cards[i - 1]?.getAttribute('data-widget-id') === 'token-breakdown' ? i - 1 : null
        };
      });
      return cockpitSideFitGuides(drag, boxes, index);
    };
    const drawMagnet = (axis, guide) => {
      let line = magnetLines.get(axis);
      if (!guide) {
        line?.remove();
        magnetLines.delete(axis);
        return;
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'ctx-card-magnet';
        line.setAttribute('data-axis', axis);
        line.setAttribute('aria-hidden', 'true');
        line.appendChild(document.createElement('span'));
        grid.appendChild(line);
        magnetLines.set(axis, line);
      }
      line.style.setProperty('--magnet-at', `${guide.at}px`);
      line.style.setProperty('--magnet-label-y', `${guide.labelY || 0}px`);
      line.setAttribute('data-snapped', String(guide.snapped));
      if (line.firstElementChild) line.firstElementChild.textContent = guide.pair ? t('session.widget.magnetFit') : '';
    };
    const requestFrame = (callback) => typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : setTimeout(() => callback(Date.now()), 16);
    const cancelFrame = (frame) => {
      if (frame == null) return;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      else clearTimeout(frame);
    };
    const redrawCardCharts = () => {
      if (typeof renderContextTrendCard === 'function') renderContextTrendCard();
      if (typeof renderSessionBentoSections === 'function') renderSessionBentoSections();
    };
    if (typeof ResizeObserver === 'function') {
      const sizes = new WeakMap();
      let gridWidth = null;
      let repackFrame = null;
      let chartRedrawTimer = null;
      const observer = new ResizeObserver(entries => {
        // 切断反馈环：布局提交自身或拖拽分隔线期间完全由统一拖拽通道接管，严禁 12 个卡片 ResizeObserver 反向唤醒重排风暴
        if (grid.__agLayoutApplying || activeDrag != null) return;
        const paneResizing = isWorkspacePaneResizingNow(grid);
        if (paneResizing) return;
        let widthChanged = false;
        let needsRepack = false;
        for (const { target, contentRect } of entries) {
          const width = Math.round(contentRect.width);
          const height = Math.round(contentRect.height);
          if (target === grid) {
            const engineEngaged = grid.getAttribute?.('data-layout-engine') === 'skyline';
            const wasAwaitingSize = grid.getAttribute?.('data-om-awaiting-size') === 'true' || !grid.__agLastAppliedWidth;
            if (width > 0 && (gridWidth === null || gridWidth === 0 || wasAwaitingSize || Math.abs(width - gridWidth) >= 2 || !engineEngaged)) {
              gridWidth = width;
              widthChanged = true;
              needsRepack = true;
              if (wasAwaitingSize) grid.removeAttribute?.('data-om-awaiting-size');
            } else if (width === 0) {
              gridWidth = 0;
            }
            continue;
          }
          if (!width || !height || target.classList?.contains?.('is-resizing')) continue;
          const prev = sizes.get(target);
          if (!prev || Math.abs(prev.w - width) >= 2 || Math.abs(prev.h - height) >= 2) {
            if (!prev || Math.abs(prev.w - width) >= 2) widthChanged = true;
            sizes.set(target, { w: width, h: height });
            needsRepack = true;
          }
          if (grid.getAttribute?.('data-layout-engine') !== 'skyline') needsRepack = true;
        }
        if (needsRepack && activeDrag == null && repackFrame == null) {
          repackFrame = requestFrame(() => {
            repackFrame = null;
            if (state.disposed || activeDrag) return;
            if (grid.__agLayoutApplying) return;
            if (isWorkspacePaneResizingNow(grid)) return;
            const reflow = () => { applyCockpitLayoutToDom({ renderManager: false, lightResize: false }); };
            try {
              if (isSkyline()) reflow();
              else flipLayout(visibleCards(), reflow);
            } catch { reflow(); }
          });
        }
        // 非插件自控拖拽（例如拖宿主原生双会话线或调整主窗口宽）时对图表重建做 120ms 尾缘防抖，避免每帧销毁重建 SVG 造成卡顿
        if (!widthChanged) return;
        if (chartRedrawTimer) clearTimeout(chartRedrawTimer);
        chartRedrawTimer = setTimeout(() => {
          chartRedrawTimer = null;
          if (state.disposed || grid.__agLayoutApplying || isWorkspacePaneResizingNow(grid)) return;
          if (!el('panel')?.hidden) redrawCardCharts();
        }, 120);
      });
      for (const card of Array.from(grid.children || [])) {
        if (card.getAttribute?.('data-widget-id')) observer.observe(card);
      }
      observer.observe(grid);
      if (typeof activeDisposers !== 'undefined') {
        activeDisposers.add(() => {
          observer.disconnect();
          if (repackFrame != null) cancelFrame(repackFrame);
          if (chartRedrawTimer != null) clearTimeout(chartRedrawTimer);
        });
      }
    }

    const clearSelectionSafe = () => {
      try {
        if (typeof window !== 'undefined' && window.getSelection) {
          window.getSelection()?.removeAllRanges?.();
        }
      } catch { }
    };

    const cleanupDrag = ({ repack = true } = {}) => {
      const drag = activeDrag;
      if (!drag) return;
      cancelFrame(resizeFrame);
      resizeFrame = null;
      stopAutoScroll();
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      if (cockpitDragCleanup) {
        cockpitDragCleanup();
        cockpitDragCleanup = null;
      }
      if (drag.captureTarget?.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture?.(drag.pointerId);
      }
      if (resizeBadgeEl) {
        resizeBadgeEl.remove?.();
        resizeBadgeEl = null;
      }
      for (const line of magnetLines.values()) line.remove();
      magnetLines.clear();
      grid.removeAttribute?.('data-gesture-height-locked');
      if (drag.mode === 'resize') {
        const { card, originalHeight, originalWidth, originalLeft, originalTop } = drag;
        card.classList.remove('is-resizing');
        card.removeAttribute?.('data-resizing');
        card.style.height = originalHeight;
        if (originalWidth !== undefined) card.style.width = originalWidth;
        if (originalLeft !== undefined) card.style.left = originalLeft;
        if (originalTop !== undefined) card.style.top = originalTop;
      }
      if (drag.mode === 'reorder') {
        const c = drag.card;
        c.classList?.remove?.('is-dragging');
        c.classList?.remove?.('is-squish-pop');
        if (c.style.position === 'fixed') {
          for (const property of ['position', 'width', 'height', 'left', 'top']) c.style.removeProperty?.(property);
        }
        c.style.removeProperty?.('z-index');
        c.style.removeProperty?.('pointer-events');
        c.style.removeProperty?.('transition');
        c.style.removeProperty?.('will-change');
        c.style.removeProperty?.('transform');
        c.style.removeProperty?.('translate');
        grid.style.removeProperty?.('user-select');
        grid.style.removeProperty?.('touch-action');
      }
      grid.classList?.remove?.('is-reordering');
      grid.removeAttribute?.('data-widget-gesture');
      activeDrag = null;
      clearSelectionSafe();
      // Repack after gesture-owned styles and flags have been cleared.
      try {
        if (repack && (drag.mode === 'resize' || drag.mode === 'reorder')) {
          applyCockpitLayoutToDom({ renderManager: false });
        }
      } catch { }
    };

    if (typeof activeDisposers !== 'undefined') activeDisposers.add(() => {
      cleanupDrag();
      suppressReleaseClick?.();
      cancelFrame(geometryFrame);
      for (const animation of flipAnimations.values()) animation.cancel();
      flipAnimations.clear();
    });

    const flipLayout = (cards, mutator, resizedCard = null) => {
      const reduce = motionReduced();
      const first = reduce ? [] : cards.map(card => card.getBoundingClientRect?.());
      for (const card of cards) flipAnimations.get(card)?.cancel();
      mutator();
      if (reduce) return;
      const last = cards.map(card => card.getBoundingClientRect?.());
      cards.forEach((card, index) => {
        const from = first[index];
        const to = last[index];
        if (!from?.width || !to?.width || !from.height || !to.height || typeof card.animate !== 'function') return;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        const resize = card === resizedCard;
        if (!resize && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        const scale = resize ? ` scale(${from.width / to.width}, ${from.height / to.height})` : '';
        const animation = card.animate([
          { transform: `translate3d(${dx}px, ${dy}px, 0)${scale}`, transformOrigin: 'top left' },
          { transform: 'translate3d(0, 0, 0) scale(1, 1)', transformOrigin: 'top left' }
        ], { duration: 190, easing: COCKPIT_FLIP_EASING });
        flipAnimations.set(card, animation);
        animation.finished.then(() => {
          if (flipAnimations.get(card) !== animation) return;
          flipAnimations.delete(card);
          if (resize && activeDrag?.card !== card) {
            card.classList.add('is-settling');
            card.addEventListener('animationend', () => card.classList.remove('is-settling'), { once: true });
          }
        }, () => {
          if (flipAnimations.get(card) === animation) flipAnimations.delete(card);
        });
      });
    };

    const snapshotVisibleCardsToFreestyle = (layout, gridW, excludeId = null) => {
      if (!layout || !Array.isArray(layout.widgets) || !(gridW > 0)) return;
      const gridRect = grid.getBoundingClientRect?.() || { left: 0, top: 0 };
      const byId = new Map(layout.widgets.map(w => [w.id, w]));
      for (const node of visibleCards()) {
        const wId = node.getAttribute?.('data-widget-id');
        if (!wId || wId === excludeId) continue;
        const cfg = byId.get(wId);
        if (!cfg || !cfg.visible || cfg.freeRect) continue;
        const box = node.getBoundingClientRect?.();
        const styleL = Number.parseFloat(node.style?.left);
        const styleT = Number.parseFloat(node.style?.top);
        const styleW = Number.parseFloat(node.style?.width);
        const styleH = Number.parseFloat(node.style?.height);
        const rawX = Number.isFinite(styleL) ? styleL : (box ? box.left - gridRect.left : 0);
        const rawY = Number.isFinite(styleT) ? styleT : (box ? box.top - gridRect.top : 0);
        const rawW = Number.isFinite(styleW) && styleW > 0 ? styleW : (box?.width || gridW);
        const rawH = Number.isFinite(styleH) && styleH > 0 ? styleH : (node.offsetHeight || box?.height || 180);
        const clamped = clampFreestyleRectForGrid({ x: rawX, y: rawY, w: rawW, h: rawH }, gridW);
        const wRatio = Math.round(clamp(clamped.w / gridW, 0.04, 1) * 10000) / 10000;
        const xRatio = Math.round(clamp(clamped.x / gridW, 0, 1) * 10000) / 10000;
        cfg.freeRect = { ...clamped, xRatio, wRatio, baseW: gridW };
        cfg.widthRatio = wRatio;
        cfg.heightPx = clamped.h;
        cfg.customHeightPx = clamped.h;
      }
    };

    const startReorderSession = (card, wId, pointerEv) => {
      flipAnimations.get(card)?.cancel();
      card.classList.remove('is-settling');
      clearSelectionSafe();
      try {
        grid.style.userSelect = 'none';
        grid.style.touchAction = 'none';
      } catch { }

      const rect = card.getBoundingClientRect?.() || { left: 0, top: 0, width: 300, height: 200 };
      const startX = pointerEv?.clientX || rect.left;
      const startY = pointerEv?.clientY || rect.top;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;
      const gridRect = grid.getBoundingClientRect();
      const gridW = Math.floor(measureCockpitGrid(grid).width || gridRect.width || 0);
      const startGridLeft = Math.max(0, Number.isFinite(Number.parseFloat(card.style?.left))
        ? Number.parseFloat(card.style.left)
        : (rect.left - gridRect.left));
      const startGridTop = Math.max(0, Number.isFinite(Number.parseFloat(card.style?.top))
        ? Number.parseFloat(card.style.top)
        : (rect.top - gridRect.top));

      const captureEl = activeDrag?.captureTarget || card.querySelector?.('.ctx-widget-hdr') || card;
      if (pointerEv?.pointerId != null && captureEl && !captureEl.hasPointerCapture?.(pointerEv.pointerId)) {
        try { captureEl.setPointerCapture?.(pointerEv.pointerId); } catch { }
      }
      activeDrag = {
        mode: 'reorder',
        pointerId: pointerEv.pointerId,
        captureTarget: captureEl,
        scroller: grid.closest?.('.ag-panel-body, #panel, .ctx-bento-grid-scroll') || grid.parentElement,
        scrolling: 0,
        card,
        widgetId: wId,
        targetId: wId,
        insertAfter: false,
        startX,
        startY,
        offsetX,
        offsetY,
        originLeft: rect.left,
        originTop: rect.top,
        startGridLeft,
        startGridTop,
        gridW,
        finalLeft: startGridLeft,
        finalTop: startGridTop,
        hasMoved: false,
        neighbors: isSkyline() ? readMagnetNeighbors(card, gridRect) : null,
        cardW: rect.width,
        cardH: rect.height,
        lastMoveX: startX,
        lastMoveY: startY,
        lastMoveTime: Date.now(),
        vx: 0,
        vy: 0
      };

      // Squish & Pop 微动效
      card.classList?.add?.('is-squish-pop');
      card.classList?.add?.('is-dragging');
      grid.classList?.add?.('is-reordering');
      grid.setAttribute?.('data-widget-gesture', 'reorder');

      // 脱离文档流跟手浮起
      const skylineEngine = grid.getAttribute?.('data-layout-engine') === 'skyline';
      if (skylineEngine) {
        // P0：Skyline 下卡片本身就是 position:absolute，抓起时严禁切成 fixed。
        // 切 fixed 会让坐标系突变（含 transform/contain 祖先时更严重），直接导致卡片飞出视口。
        card.style.position = 'absolute';
        card.style.zIndex = '100';
        card.style.pointerEvents = 'none';
        card.style.transition = 'none';
        card.style.willChange = 'translate';
      } else {
        card.style.position = 'fixed';
        card.style.zIndex = '2147482000';
        card.style.pointerEvents = 'none';
        card.style.width = `${Math.round(rect.width)}px`;
        card.style.height = `${Math.round(rect.height)}px`;
        card.style.left = `${Math.round(rect.left)}px`;
        card.style.top = `${Math.round(rect.top)}px`;
        // A transformed ancestor can establish a containing block for fixed positioning.
        const afterRect = card.getBoundingClientRect?.();
        if (afterRect) {
          const dx = rect.left - afterRect.left;
          const dy = rect.top - afterRect.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            card.style.left = `${Math.round(rect.left + dx)}px`;
            card.style.top = `${Math.round(rect.top + dy)}px`;
          }
        }
        if (!grid.style.height) grid.style.height = `${Math.round(grid.getBoundingClientRect?.().height || 0)}px`;
        grid.setAttribute?.('data-gesture-height-locked', 'true');
      }
    };

    const positionResizeBadge = (x, y) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = resizeBadgeEl.offsetWidth || 112;
      const height = resizeBadgeEl.offsetHeight || 24;
      const left = x + 12 + width <= viewportWidth - 8 ? x + 12 : x - width - 12;
      resizeBadgeEl.style.left = `${clamp(left, 8, viewportWidth - width - 8)}px`;
      resizeBadgeEl.style.top = `${clamp(y - height - 12, 8, viewportHeight - height - 8)}px`;
    };

    const updateResizePreview = () => {
      resizeFrame = null;
      if (activeDrag?.mode !== 'resize' || !activeDrag.pointer) return;
      if (!gridIsVisible()) {
        cleanupDrag();
        return;
      }
      const drag = activeDrag;
      const { x, y } = drag.pointer;
      const { startX, startY, startW, startH, gridW, gridLeft, gridTop, fromLeft, fromTop, resizeAxis = 'both' } = drag;
      const scrollAccum = drag.scrollAccum || 0;
      const allowX = resizeAxis !== 'y';
      const allowY = resizeAxis !== 'x';
      const minFreeW = Math.min(COCKPIT_MIN_WIDTH, gridW);
      const upg = typeof window !== 'undefined' ? window.AGPresetBoardUpgrades : null;
      let width;
      let height;
      let anchorLeft;
      let anchorTop;
      if (upg && typeof upg.resolveFreeResizeGeometry === 'function') {
        const freeGeo = upg.resolveFreeResizeGeometry(drag, { x, y }, {
          minWidth: minFreeW,
          minHeight: COCKPIT_MIN_HEIGHT,
          maxHeight: COCKPIT_MAX_HEIGHT,
          freePosition: true
        });
        width = freeGeo.width;
        height = freeGeo.height;
        anchorLeft = freeGeo.left;
        anchorTop = freeGeo.top;
      } else {
        const anchorRight = clamp(Math.round(gridLeft + startW), minFreeW, gridW);
        const anchorBottom = Math.max(COCKPIT_MIN_HEIGHT, Math.round(gridTop + startH));
        if (allowX) {
          if (fromLeft) {
            width = Math.round(clamp(startW + (startX - x), minFreeW, anchorRight));
            anchorLeft = Math.max(0, anchorRight - width);
          } else {
            anchorLeft = clamp(Math.round(gridLeft), 0, Math.max(0, gridW - minFreeW));
            width = Math.round(clamp(startW + (x - startX), minFreeW, Math.max(minFreeW, gridW - anchorLeft)));
          }
        } else {
          width = Math.round(clamp(startW, minFreeW, gridW));
          anchorLeft = clamp(Math.round(gridLeft), 0, Math.max(0, gridW - width));
        }
        const deltaY = y - startY + scrollAccum;
        if (allowY) {
          if (fromTop) {
            const maxTopH = Math.min(COCKPIT_MAX_HEIGHT, anchorBottom);
            height = Math.round(clamp(startH - deltaY, COCKPIT_MIN_HEIGHT, maxTopH));
            anchorTop = Math.max(0, anchorBottom - height);
          } else {
            anchorTop = Math.max(0, Math.round(gridTop));
            height = Math.round(clamp(startH + deltaY, COCKPIT_MIN_HEIGHT, COCKPIT_MAX_HEIGHT));
          }
        } else {
          anchorTop = Math.max(0, Math.round(gridTop));
          height = Math.round(clamp(startH, COCKPIT_MIN_HEIGHT, COCKPIT_MAX_HEIGHT));
        }
      }

      if (drag.neighbors) {
        const guides = cockpitResizeMagnets(drag, width, height, anchorLeft, anchorTop);
        if (allowX && guides.x?.snapped) {
          const snappedW = Math.round(guides.x.size);
          if (fromLeft) {
            const anchorRight = clamp(Math.round(gridLeft + startW), minFreeW, gridW);
            width = clamp(snappedW, minFreeW, anchorRight);
            anchorLeft = Math.max(0, anchorRight - width);
          } else {
            width = clamp(snappedW, minFreeW, Math.max(minFreeW, gridW - anchorLeft));
          }
        }
        if (allowY && guides.y?.snapped) {
          const snappedH = Math.round(guides.y.size);
          if (fromTop) {
            const anchorBottom = Math.max(COCKPIT_MIN_HEIGHT, Math.round(gridTop + startH));
            height = clamp(snappedH, COCKPIT_MIN_HEIGHT, Math.min(COCKPIT_MAX_HEIGHT, anchorBottom));
            anchorTop = Math.max(0, anchorBottom - height);
          } else {
            height = clamp(snappedH, COCKPIT_MIN_HEIGHT, COCKPIT_MAX_HEIGHT);
          }
        }
        drawMagnet('x', allowX ? guides.x : null);
        drawMagnet('y', allowY ? guides.y : null);
      }

      // 终态硬约束边界钳制：严禁任何一边越出 [0, gridW] 或负 y 坐标
      const clamped = clampFreestyleRectForGrid({ x: anchorLeft, y: anchorTop, w: width, h: height }, gridW);
      anchorLeft = clamped.x;
      anchorTop = clamped.y;
      width = clamped.w;
      height = clamped.h;

      if (!resizeBadgeEl) {
        resizeBadgeEl = document.createElement('div');
        resizeBadgeEl.className = 'ag-widget-resize-badge';
        resizeBadgeEl.setAttribute('aria-hidden', 'true');
        shadow.appendChild(resizeBadgeEl);
        drag.card.classList.add('is-resizing');
        drag.card.setAttribute('data-resizing', 'true');
        grid.setAttribute?.('data-widget-gesture', 'resize');
      }

      drag.finalW = width;
      drag.finalH = height;
      drag.finalLeft = anchorLeft;
      drag.finalTop = anchorTop;
      resizeBadgeEl.textContent = `${Math.round(width)} × ${height}px`;
      positionResizeBadge(x, y);
      drag.card.style.left = `${anchorLeft}px`;
      drag.card.style.top = `${anchorTop}px`;
      drag.card.style.width = `${width}px`;
      drag.card.style.height = `${height}px`;
      syncCardAdaptiveAttrs(drag.card, width, height);
      const curGridH = Number.parseFloat(grid.style.height || '0') || 0;
      if (anchorTop + height > curGridH) {
        grid.style.height = `${Math.ceil(anchorTop + height)}px`;
      }
    };

    const updateReorderTarget = (px, py) => {
      let chosen = null;
      let insertAfter = false;
      let bestDist = Infinity;
      let bestCenterDist = Infinity;
      const cards = visibleCards().filter(card => card !== activeDrag.card);
      for (const card of cards) {
        const rect = card.getBoundingClientRect?.();
        if (!rect || rect.width <= 0) continue;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(px - clamp(px, rect.left, rect.right), py - clamp(py, rect.top, rect.bottom));
        const centerDist = Math.hypot(px - cx, py - cy);
        if (dist < bestDist || (dist === bestDist && centerDist < bestCenterDist)) {
          bestDist = dist;
          bestCenterDist = centerDist;
          chosen = card;
          insertAfter = py > cy || (Math.abs(py - cy) < rect.height * 0.25 && px > cx);
        }
      }
      activeDrag.targetId = chosen?.getAttribute('data-widget-id') || null;
      activeDrag.insertAfter = insertAfter;
    };

    const updateReorderScroll = (frameTime) => {
      scrollFrame = null;
      if (activeDrag?.mode !== 'reorder') return;
      const { scroller, lastMoveX, lastMoveY, scrolling } = activeDrag;
      if (!scroller || !scrolling) return;
      const elapsed = clamp(frameTime - (activeDrag.scrollTime ?? frameTime - 16), 0, 32);
      activeDrag.scrollTime = frameTime;
      const previous = scroller.scrollTop;
      const distance = Math.max(1, elapsed * 0.48);
      scroller.scrollTop += scrolling * distance;
      if (scroller.scrollTop !== previous) {
        const offset = scroller.scrollTop - previous;
        if (isSkyline()) {
          activeDrag.originTop -= offset;
          const rect = grid.getBoundingClientRect();
          const gridW = Math.max(1, Math.floor(activeDrag.gridW || rect.width || measureCockpitGrid(grid).width || 1));
          const rawLeft = lastMoveX - activeDrag.offsetX - rect.left;
          const rawTop = lastMoveY - activeDrag.offsetY - rect.top;
          const clampedPos = clampFreestyleRectForGrid({ x: rawLeft, y: rawTop, w: activeDrag.cardW, h: activeDrag.cardH }, gridW);
          activeDrag.finalLeft = clampedPos.x;
          activeDrag.finalTop = clampedPos.y;
          activeDrag.hasMoved = true;
          const dx = clampedPos.x - activeDrag.startGridLeft;
          const dy = clampedPos.y - activeDrag.startGridTop;
          activeDrag.card.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
        }
        updateReorderTarget(lastMoveX, lastMoveY);
        scrollFrame = requestFrame(updateReorderScroll);
      }
    };

    /**
     * 缩放拖拽的边缘自动滚动：独立 rAF 循环持续驱动，鼠标停在边缘不动也持续平滑滚动；
     * 移出边缘、松手、失焦或 Esc 立即停止
     */
    const updateResizeScroll = (frameTime) => {
      scrollFrame = null;
      if (activeDrag?.mode !== 'resize') return;
      const { scroller, scrolling } = activeDrag;
      if (!scroller || !scrolling) return;
      const elapsed = clamp(frameTime - (activeDrag.scrollTime ?? frameTime - 16), 0, 32);
      activeDrag.scrollTime = frameTime;
      const previous = scroller.scrollTop;
      const distance = Math.max(1, elapsed * 0.48);
      const maxScroll = Math.max(0, Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0));
      const target = clamp(previous + scrolling * distance, 0, maxScroll);
      scroller.scrollTop = target;
      const applied = Number(scroller.scrollTop || 0) - previous;
      if (!applied) return;
      // 容器滚动量折算进卡片高度，指针停在边缘不动时卡片持续顺畅长高
      activeDrag.scrollAccum = (activeDrag.scrollAccum || 0) + applied;
      if (resizeFrame == null) resizeFrame = requestFrame(updateResizePreview);
      scrollFrame = requestFrame(updateResizeScroll);
    };

    const stopAutoScroll = () => {
      if (scrollFrame != null) {
        cancelFrame(scrollFrame);
        scrollFrame = null;
      }
      if (activeDrag) {
        activeDrag.scrolling = 0;
        activeDrag.scrollTime = null;
      }
    };

    const resolveEdgeScrolling = (pointerY) => {
      if (!activeDrag) return 0;
      const scroller = activeDrag.scroller;
      if (!scroller) return 0;
      const bounds = scroller.getBoundingClientRect?.();
      if (!bounds) return 0;
      if (pointerY < bounds.top + 48) return -1;
      if (pointerY > bounds.bottom - 48) return 1;
      return 0;
    };

    const onPointerMoveDoc = (ev) => {
      if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
      // P0：面板已关闭/隐藏（网格脱离文档或零宽）或主键已松开时，立即中止手势，
      // 绝不允许在面板消失后继续更新尺寸角标与宽高
      const buttonsReleased = ev.pointerType !== 'touch' && ev.buttons === 0;
      if (!gridIsVisible() || buttonsReleased) {
        cleanupDrag();
        return;
      }
      clearSelectionSafe();

      // 手柄移动超 3px 立即跟手浮起（零延迟）
      if (activeDrag.mode === 'pending-handle') {
        const dist = Math.hypot((ev.clientX || 0) - activeDrag.startX, (ev.clientY || 0) - activeDrag.startY);
        if (dist > 3) {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
          startReorderSession(activeDrag.card, activeDrag.widgetId, ev);
        }
        return;
      }

      // 标题栏长按检查（超 6px 则取消判定）
      if (activeDrag.mode === 'pending-longpress') {
        const dist = Math.hypot((ev.clientX || 0) - activeDrag.startX, (ev.clientY || 0) - activeDrag.startY);
        if (dist > 6) {
          cleanupDrag();
        }
        return;
      }

      if (activeDrag.mode === 'resize') {
        if (ev.clientX === activeDrag.startX && ev.clientY === activeDrag.startY && !activeDrag.pointer) return;
        activeDrag.pointer = { x: ev.clientX, y: ev.clientY };
        // 拖拽接近滚动容器上下边缘 48px 内启动独立 rAF 自动滚动，鼠标停在边缘不动也持续平滑滚动
        const scrolling = resolveEdgeScrolling(ev.clientY || 0);
        if (scrolling !== activeDrag.scrolling) {
          activeDrag.scrollTime = null;
          activeDrag.scrolling = scrolling;
          if (scrolling && scrollFrame == null) scrollFrame = requestFrame(updateResizeScroll);
          else if (!scrolling && scrollFrame != null) {
            cancelFrame(scrollFrame);
            scrollFrame = null;
          }
        }
        if (resizeFrame == null) resizeFrame = requestFrame(updateResizePreview);
        return;
      }

      // 自由拖拽定位（严格容器边界钳制 + 柔和边缘磁吸对齐，不踢行不重排兄弟）
      if (activeDrag.mode === 'reorder') {
        const px = ev.clientX || 0;
        const py = ev.clientY || 0;
        const targetX = px - activeDrag.offsetX;
        const targetY = py - activeDrag.offsetY;

        // 惯性微动效计算
        const now = Date.now();
        const dt = Math.max(1, now - activeDrag.lastMoveTime);
        const instVx = ((px - activeDrag.lastMoveX) / dt) * 10;
        const instVy = ((py - activeDrag.lastMoveY) / dt) * 10;
        activeDrag.vx = activeDrag.vx * 0.7 + instVx * 0.3;
        activeDrag.vy = activeDrag.vy * 0.7 + instVy * 0.3;
        activeDrag.lastMoveX = px;
        activeDrag.lastMoveY = py;
        activeDrag.lastMoveTime = now;

        const tiltDeg = Math.max(-1.8, Math.min(1.8, activeDrag.vx * 0.28));
        const scaleX = Math.max(0.98, Math.min(1.02, 1 + activeDrag.vy * 0.0014));
        const scaleY = Math.max(0.98, Math.min(1.02, 1 - activeDrag.vy * 0.0014));

        if (activeDrag.card) {
          const rect = grid.getBoundingClientRect();
          const gridW = Math.max(1, Math.floor(activeDrag.gridW || rect.width || measureCockpitGrid(grid).width || 1));
          let left = targetX - rect.left;
          let top = targetY - rect.top;
          if (activeDrag.neighbors) {
            const right = left + activeDrag.cardW;
            const bottom = top + activeDrag.cardH;
            const pairEdges = (a, b, start, end) => [a, b].flatMap(edge => [start, end].map(at => ({ at, delta: at - edge })));
            const x = pairEdges(left, right, 0, gridW);
            const y = [{ at: 0, delta: -top }];
            for (const other of activeDrag.neighbors) {
              x.push(...pairEdges(left, right, other.x, other.x + other.w));
              x.push({ at: other.x + other.w + COCKPIT_SKYLINE_GAP, delta: (other.x + other.w + COCKPIT_SKYLINE_GAP) - left });
              x.push({ at: other.x - COCKPIT_SKYLINE_GAP, delta: (other.x - COCKPIT_SKYLINE_GAP) - right });
              y.push(...pairEdges(top, bottom, other.y, other.y + other.h));
              y.push({ at: other.y + other.h + COCKPIT_SKYLINE_GAP, delta: (other.y + other.h + COCKPIT_SKYLINE_GAP) - top });
              y.push({ at: other.y - COCKPIT_SKYLINE_GAP, delta: (other.y - COCKPIT_SKYLINE_GAP) - bottom });
            }
            const xGuide = nearestCockpitGuide(x);
            const yGuide = nearestCockpitGuide(y);
            left += xGuide?.delta || 0;
            top += yGuide?.delta || 0;
            drawMagnet('x', xGuide);
            drawMagnet('y', yGuide);
          }
          // 严格容器边界钳制：拖拽期间绝不越出左/右/上边界
          const clampedPos = clampFreestyleRectForGrid({ x: left, y: top, w: activeDrag.cardW, h: activeDrag.cardH }, gridW);
          activeDrag.finalLeft = clampedPos.x;
          activeDrag.finalTop = clampedPos.y;
          activeDrag.hasMoved = true;
          const dx = clampedPos.x - activeDrag.startGridLeft;
          const dy = clampedPos.y - activeDrag.startGridTop;
          activeDrag.card.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
          activeDrag.card.style.transform = `rotate(${tiltDeg.toFixed(2)}deg) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
          const curGridH = Number.parseFloat(grid.style.height || '0') || 0;
          if (clampedPos.y + activeDrag.cardH > curGridH) {
            grid.style.height = `${Math.ceil(clampedPos.y + activeDrag.cardH)}px`;
          }
        }

        const scroller = activeDrag.scroller;
        const bounds = scroller?.getBoundingClientRect?.();
        const scrolling = bounds && py >= bounds.top - 48 && py <= bounds.bottom + 48
          ? (py < bounds.top + 48 ? -1 : py > bounds.bottom - 48 ? 1 : 0)
          : 0;
        if (scrolling !== activeDrag.scrolling) activeDrag.scrollTime = null;
        activeDrag.scrolling = scrolling;
        if (scrolling && scrollFrame == null) scrollFrame = requestFrame(updateReorderScroll);
        else if (!scrolling && scrollFrame != null) {
          cancelFrame(scrollFrame);
          scrollFrame = null;
        }
        updateReorderTarget(px, py);
      }
    };

    const suppressClickFromGesture = pointerEvent => {
      if (!pointerEvent || !Number.isFinite(pointerEvent.clientX)) return;
      suppressReleaseClick?.();
      const onClick = event => {
        if (!event.detail || Math.abs(event.clientX - pointerEvent.clientX) > 2 ||
          Math.abs(event.clientY - pointerEvent.clientY) > 2) return;
        suppressReleaseClick?.();
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const timer = setTimeout(() => suppressReleaseClick?.(), 180);
      suppressReleaseClick = () => {
        window.removeEventListener('click', onClick, true);
        clearTimeout(timer);
        suppressReleaseClick = null;
      };
      window.addEventListener('click', onClick, true);
    };

    const onPointerUpDoc = (event) => {
      if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
      if (!gridIsVisible()) {
        cleanupDrag();
        return;
      }
      clearSelectionSafe();

      if (activeDrag.mode === 'resize') {
        if (resizeFrame != null) {
          cancelFrame(resizeFrame);
          resizeFrame = null;
        }
        stopAutoScroll();
        if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
            && (activeDrag.pointer || event.clientX !== activeDrag.startX || event.clientY !== activeDrag.startY)) {
          activeDrag.pointer = { x: event.clientX, y: event.clientY };
        }
        updateResizePreview();
        const { card, widgetId, finalW, finalH, finalLeft, finalTop, gridW, singleColumn, resizeAxis = 'both' } = activeDrag;
        if (finalH == null || finalW == null) {
          cleanupDrag();
          return;
        }
        suppressClickFromGesture(event);
        const commitResize = () => {
          const layout = getCockpitLayout();
          // 先在清理前锁定兄弟卡片当前坐标，防止任意缩放引起邻居被踢行或重排
          snapshotVisibleCardsToFreestyle(layout, gridW, widgetId);
          cleanupDrag({ repack: false });
          const widget = layout.widgets.find(item => item.id === widgetId);
          if (widget) {
            const clamped = clampFreestyleRectForGrid(
              { x: finalLeft ?? 0, y: finalTop ?? 0, w: finalW, h: finalH },
              gridW
            );
            const ratio = clamp(clamped.w / gridW, 0.04, 1);
            const xRatio = clamp(clamped.x / gridW, 0, 1);
            widget.freeRect = {
              ...clamped,
              xRatio: Math.round(xRatio * 10000) / 10000,
              wRatio: Math.round(ratio * 10000) / 10000,
              baseW: gridW
            };
            if (resizeAxis !== 'y') {
              widget.widthRatio = Math.round(ratio * 10000) / 10000;
              widget.span = Math.max(1, Math.min(12, Math.round(ratio * 12)));
              widget.customWidth = ratio < 0.999;
            }
            if (resizeAxis !== 'x') {
              widget.height = 'expanded';
              widget.heightPx = clamped.h;
              widget.customHeightPx = clamped.h;
            }
            persistCockpitLayout(layout);
          }
          applyCockpitLayoutToDom();
        };
        if (isSkyline() && singleColumn) commitResize();
        else flipLayout(visibleCards(), commitResize, card);
        return;
      }

      if (activeDrag.mode === 'reorder') {
        suppressClickFromGesture(event);
        if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
          updateReorderTarget(event.clientX, event.clientY);
        }
        const { card, scroller, widgetId, finalLeft, finalTop, cardW, cardH, gridW, hasMoved } = activeDrag;
        const safeGridW = Math.max(1, Math.floor(gridW || measureCockpitGrid(grid).width || 1));
        const layout = getCockpitLayout();
        if (isSkyline() && hasMoved) {
          snapshotVisibleCardsToFreestyle(layout, safeGridW, widgetId);
          const widget = layout.widgets.find(item => item.id === widgetId);
          if (widget) {
            const clamped = clampFreestyleRectForGrid({ x: finalLeft, y: finalTop, w: cardW, h: cardH }, safeGridW);
            const wRatio = Math.round(clamp(clamped.w / safeGridW, 0.04, 1) * 10000) / 10000;
            const xRatio = Math.round(clamp(clamped.x / safeGridW, 0, 1) * 10000) / 10000;
            widget.freeRect = { ...clamped, xRatio, wRatio, baseW: safeGridW };
            widget.widthRatio = wRatio;
            widget.heightPx = clamped.h;
            widget.customHeightPx = clamped.h;
            persistCockpitLayout(layout);
          }
          cleanupDrag({ repack: false });
          applyCockpitLayoutToDom({ renderManager: false });
        } else {
          const { targetId, insertAfter } = activeDrag;
          const before = getCockpitLayout();
          cleanupDrag({ repack: false });
          if (reorderCockpitWidget(widgetId, targetId, insertAfter) === before) {
            applyCockpitLayoutToDom({ renderManager: false });
          }
        }
        const rect = card.getBoundingClientRect();
        const viewport = scroller?.getBoundingClientRect?.();
        if (viewport) {
          const header = hostPanel?.querySelector?.('.panel-header-bar')?.getBoundingClientRect?.();
          const visibleTop = Math.max(viewport.top, header?.bottom ?? viewport.top);
          if (rect.top < visibleTop) {
            scroller.scrollTop += rect.top - visibleTop;
          } else if (rect.bottom > viewport.bottom && rect.height <= viewport.bottom - visibleTop) {
            scroller.scrollTop += rect.bottom - viewport.bottom;
          }
        }
        return;
      }

      cleanupDrag();
    };

    const onDragKeyDown = (event) => {
      if (event.key === 'Escape') cleanupDrag();
    };
    const onPointerInterrupted = (event) => {
      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
      if (event?.type === 'lostpointercapture' && event.target && activeDrag.captureTarget && event.target !== activeDrag.captureTarget) {
        return;
      }
      cleanupDrag();
    };
    const onDocumentHidden = () => {
      if (document.hidden) cleanupDrag();
    };
    const watchDrag = () => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
      let visibilityObserver;
      if (typeof MutationObserver === 'function') {
        visibilityObserver = new MutationObserver(() => {
          if (hostPanel?.hidden || sessionPane?.hidden) cleanupDrag();
        });
        for (const node of [hostPanel, sessionPane]) {
          if (node) visibilityObserver.observe(node, { attributes: true, attributeFilter: ['hidden'] });
        }
      }
      window.addEventListener('pointermove', onPointerMoveDoc);
      window.addEventListener('pointerup', onPointerUpDoc);
      window.addEventListener('pointercancel', onPointerInterrupted);
      window.addEventListener('lostpointercapture', onPointerInterrupted);
      window.addEventListener('blur', cleanupDrag);
      document.addEventListener?.('visibilitychange', onDocumentHidden);
      window.addEventListener('keydown', onDragKeyDown, true);
      cockpitDragCleanup = () => {
        visibilityObserver?.disconnect();
        window.removeEventListener?.('pointermove', onPointerMoveDoc);
        window.removeEventListener?.('pointerup', onPointerUpDoc);
        window.removeEventListener?.('pointercancel', onPointerInterrupted);
        window.removeEventListener?.('lostpointercapture', onPointerInterrupted);
        window.removeEventListener?.('blur', cleanupDrag);
        document.removeEventListener?.('visibilitychange', onDocumentHidden);
        window.removeEventListener?.('keydown', onDragKeyDown, true);
      };
    };

    // 绑定指针事件
    grid.addEventListener('pointerdown', (e) => {
      if (activeDrag || e.isPrimary === false) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const resizeHandle = e?.target?.closest?.('.ag-widget-resize-handle, .ctx-widget-resize-handle, .ag-widget-resize-edge, .ctx-widget-resize-edge');
      if (resizeHandle) {
        const card = resizeHandle.closest?.('[data-widget-id]');
        const wId = card?.getAttribute?.('data-widget-id');
        if (!wId) return;
        e.preventDefault?.();
        clearSelectionSafe();
        flipAnimations.get(card)?.cancel();
        card.classList.remove('is-settling');
        const cardRect = card.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        const gridW = Math.floor(measureCockpitGrid(grid).width);
        if (!gridW || !cardRect.width) return;
        try { resizeHandle.setPointerCapture?.(e.pointerId); } catch { }
        const rawAxis = resizeHandle.getAttribute?.('data-resize-axis');
        const resizeAxis = rawAxis === 'x' || rawAxis === 'y' ? rawAxis : 'both';
        const styleL = Number.parseFloat(card.style?.left);
        const styleT = Number.parseFloat(card.style?.top);
        const gridLeft = Math.max(0, Number.isFinite(styleL) ? styleL : (cardRect.left - gridRect.left));
        const gridTop = Math.max(0, Number.isFinite(styleT) ? styleT : (cardRect.top - gridRect.top));
        activeDrag = {
          mode: 'resize',
          pointerId: e.pointerId,
          captureTarget: resizeHandle,
          card,
          widgetId: wId,
          resizeAxis,
          resizeDir: resizeHandle.getAttribute?.('data-resize-dir') || '',
          startX: e.clientX ?? 0,
          startY: e.clientY ?? 0,
          startW: cardRect.width,
          startH: cardRect.height,
          originalHeight: card.style.height || '',
          originalWidth: card.style.width || '',
          originalLeft: card.style.left || '',
          originalTop: card.style.top || '',
          gridW,
          singleColumn: isSkylineSingleColumn(gridW),
          gridLeft,
          gridTop,
          fromLeft: resizeHandle.getAttribute?.('data-resize-edge') === 'left',
          fromTop: resizeHandle.getAttribute?.('data-resize-vertical') === 'top',
          neighbors: isSkyline() && grid.offsetWidth > 0 ? readMagnetNeighbors(card, gridRect) : null,
          finalH: null,
          finalW: null,
          finalLeft: gridLeft,
          finalTop: gridTop,
          scroller: grid.closest?.('.ag-panel-body, #panel, .ctx-bento-grid-scroll') || grid.parentElement,
          scrolling: 0,
          scrollTime: null,
          scrollAccum: 0
        };
        activeDrag.fitGuides = readSideFitGuides(activeDrag, gridRect);

        watchDrag();
        return;
      }

      const hdr = e?.target?.closest?.('.ctx-widget-hdr');
      if (!hdr) return;
      if (e?.target?.closest?.('button, input, select, a, [data-widget-action]')) {
        // 如果点击的是左上手柄自身，仍然允许触发
        if (!e?.target?.closest?.('.ag-widget-drag-handle, .ctx-widget-drag-handle')) {
          return;
        }
      }
      const card = hdr.closest?.('[data-widget-id]');
      const wId = card?.getAttribute?.('data-widget-id');
      if (!wId) return;

      const isDirectHandle = Boolean(e?.target?.closest?.('.ag-widget-drag-handle, .ctx-widget-drag-handle'));
      watchDrag();

      if (isDirectHandle) {
        e.preventDefault?.();
        clearSelectionSafe();
        try { e.target.setPointerCapture?.(e.pointerId); } catch { }
        // 6 点手柄：按下即待命，移动超 3px 零延迟浮起，短按不误触
        activeDrag = {
          mode: 'pending-handle',
          pointerId: e.pointerId,
          captureTarget: e.target,
          card,
          widgetId: wId,
          startX: e.clientX || 0,
          startY: e.clientY || 0
        };
      } else {
        activeDrag = {
          mode: 'pending-longpress',
          pointerId: e.pointerId,
          card,
          widgetId: wId,
          startX: e.clientX || 0,
          startY: e.clientY || 0
        };
        // 标题栏空白区长按阈值收紧到 160ms，短按不误触
        pressTimer = setTimeout(() => {
          if (activeDrag && activeDrag.mode === 'pending-longpress' && activeDrag.widgetId === wId) {
            startReorderSession(card, wId, e);
          }
        }, 160);
      }
    });

    // 双击缩放手柄还原预设
    grid.addEventListener('dblclick', (e) => {
      const resizeHandle = e?.target?.closest?.('.ag-widget-resize-handle, .ctx-widget-resize-handle, .ag-widget-resize-edge, .ctx-widget-resize-edge');
      if (resizeHandle) {
        const card = resizeHandle.closest?.('[data-widget-id]');
        const wId = card?.getAttribute?.('data-widget-id');
        if (!wId) return;
        const def = COCKPIT_WIDGET_DEFS.find(d => d.id === wId);
        if (def) {
          setCockpitWidgetSpan(wId, def.defaultSpan);
          setCockpitWidgetHeight(wId, def.defaultHeight || 'standard');
        }
      }
    });

  }

  applyCockpitLayoutToDom();
}
