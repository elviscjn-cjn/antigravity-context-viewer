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
const COCKPIT_VALID_SPANS = [4, 6, 8, 12];
const COCKPIT_VALID_HEIGHTS = ['compact', 'standard', 'expanded'];
const COCKPIT_MIN_WIDTH = 200;
const COCKPIT_MIN_HEIGHT = 180;
const COCKPIT_MAX_HEIGHT = 680;
const COCKPIT_FLIP_EASING = 'cubic-bezier(0.2, 1.08, 0.32, 1)';
// 2D Skyline 自动排版参数
const COCKPIT_SKYLINE_GAP = 10;
const COCKPIT_SINGLE_COLUMN_BREAKPOINT = 520;
const COCKPIT_ROW_SLIVER_PX = 24;
const COCKPIT_CARD_COMPACT_MAX = 360;
const COCKPIT_CARD_WIDE_MIN = 560;
const COCKPIT_MAGNET_DISTANCE = 8;
const COCKPIT_MAGNET_PREVIEW_DISTANCE = 32;

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

function normalizeCockpitPresetOrder(rawOrder, customPresets = []) {
  const customIds = Array.isArray(customPresets) ? customPresets.map(p => String(p?.id || '').trim()).filter(Boolean) : [];
  const validIds = new Set([...BUILTIN_COCKPIT_PRESET_IDS, ...customIds]);
  const seen = new Set();
  const out = [];
  for (const rawId of (Array.isArray(rawOrder) ? rawOrder : [])) {
    const pid = typeof rawId === 'string' ? rawId.trim() : '';
    if (!pid || !validIds.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  for (const bId of BUILTIN_COCKPIT_PRESET_IDS) {
    if (!seen.has(bId)) { seen.add(bId); out.push(bId); }
  }
  for (const cId of customIds) {
    if (!seen.has(cId)) { seen.add(cId); out.push(cId); }
  }
  return out;
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
  let srcList = Array.isArray(raw.widgets) ? raw.widgets : [];
  if (srcList.length === 0 && Array.isArray(raw.order) && raw.order.length > 0) {
    const hiddenSet = new Set(Array.isArray(raw.hiddenIds) ? raw.hiddenIds : []);
    srcList = raw.order.map(id => ({
      id,
      span: raw.spans?.[id],
      height: raw.heights?.[id],
      visible: !hiddenSet.has(id),
      customHeightPx: raw.heightPx?.[id] ?? null
    }));
  }
  if (srcList.length === 0) srcList = base.widgets;

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
    const visible = typeof item.visible === 'boolean' ? item.visible : fb.visible;
    const rawPx = Number(item.customHeightPx ?? item.heightPx);
    const customHeightPx = Number.isFinite(rawPx) && rawPx >= 100
      ? Math.max(COCKPIT_MIN_HEIGHT, Math.min(COCKPIT_MAX_HEIGHT, Math.round(rawPx)))
      : null;
    // P1-1：自由缩放宽度必须原样保留（有限数值且落在 (0, 1]），否则重载后退回 span 推导
    const rawRatio = Number(item.widthRatio);
    const widthRatio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1
      ? rawRatio
      : null;
    normalized.push({
      id,
      span,
      height,
      visible,
      customHeightPx,
      ...(customWidth ? { customWidth } : {}),
      ...(widthRatio != null ? { widthRatio } : {}),
      ...(customHeightPx != null ? { heightPx: customHeightPx } : {})
    });
  }

  for (const fb of base.widgets) {
    if (!seen.has(fb.id)) {
      const index = fb.id === 'request-cost' && presetId === 'speed_cost'
        ? normalized.findIndex(item => item.id === 'token-breakdown') : -1;
      if (index >= 0) normalized.splice(index + 1, 0, { ...fb });
      else normalized.push({ ...fb });
    }
  }
  const result = {
    version: 1,
    presetId,
    widgets: normalized
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
  result.presetOrder = normalizeCockpitPresetOrder(raw.presetOrder, customPresets);
  return result;
}

let presetSortMode = false;

function renderCockpitPresetsTrack(layout) {
  const track = el('ctx-cockpit-presets-track') || el('ctx-cockpit-toolbar')?.querySelector?.('.ctx-cockpit-presets');
  const sortToggleBtn = el('btn-ctx-preset-sort');
  if (sortToggleBtn) {
    sortToggleBtn.setAttribute('aria-pressed', presetSortMode ? 'true' : 'false');
    sortToggleBtn.classList?.toggle?.('active', presetSortMode);
    sortToggleBtn.textContent = presetSortMode ? t('session.preset.sortDone') : t('session.preset.sort');
  }
  const activeId = layout.activeCustomId || layout.presetId;
  if (track) {
    const customList = Array.isArray(layout.customPresets) ? layout.customPresets : [];
    const customMap = new Map(customList.map(c => [c.id, c]));
    const order = normalizeCockpitPresetOrder(layout.presetOrder, customList);
    const sig = JSON.stringify([activeId, presetSortMode, order, customList.map(c => [c.id, c.name])]);
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
      track.setAttribute?.('data-sort-mode', presetSortMode ? 'true' : 'false');
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
          btn.className = 'ctx-preset-btn';
          btn.setAttribute('data-cockpit-preset', pid);
        }
        if (customMeta) {
          btn.textContent = customMeta.name;
          btn.title = customMeta.name;
          btn.setAttribute?.('data-custom-preset', 'true');
        } else if (meta) {
          btn.removeAttribute?.('data-custom-preset');
          btn.textContent = t(meta.labelKey);
        }
        const isAct = pid === activeId;
        btn.setAttribute?.('aria-pressed', isAct ? 'true' : 'false');
        btn.classList?.toggle?.('active', isAct);

        if (presetSortMode) {
          const wrap = document.createElement('span');
          wrap.className = 'ctx-preset-chip-group';
          wrap.setAttribute('data-preset-chip-id', pid);
          const leftBtn = document.createElement('button');
          leftBtn.type = 'button';
          leftBtn.className = 'ctx-preset-sort-step';
          leftBtn.setAttribute('data-preset-move', '-1');
          leftBtn.setAttribute('data-preset-move-id', pid);
          leftBtn.setAttribute('aria-label', t('session.preset.moveLeftAria'));
          leftBtn.textContent = '‹';
          leftBtn.disabled = i === 0;
          const rightBtn = document.createElement('button');
          rightBtn.type = 'button';
          rightBtn.className = 'ctx-preset-sort-step';
          rightBtn.setAttribute('data-preset-move', '1');
          rightBtn.setAttribute('data-preset-move-id', pid);
          rightBtn.setAttribute('aria-label', t('session.preset.moveRightAria'));
          rightBtn.textContent = '›';
          rightBtn.disabled = i === order.length - 1;
          wrap.appendChild(leftBtn);
          wrap.appendChild(btn);
          wrap.appendChild(rightBtn);
          items.push(wrap);
        } else {
          items.push(btn);
        }
      }
      if (typeof track.replaceChildren === 'function') {
        track.replaceChildren(...items);
      }
    }
  }
  const actions = el('ctx-custom-preset-actions');
  if (actions) actions.hidden = !layout.activeCustomId;
}

function renderCustomCockpitPresets(layout) {
  renderCockpitPresetsTrack(layout);
}

function updateCustomCockpitPreset(action, name = '') {
  const layout = getCockpitLayout();
  const presets = layout.customPresets || [];
  const active = presets.find(item => item.id === layout.activeCustomId);
  const curOrder = normalizeCockpitPresetOrder(layout.presetOrder, presets);
  if (action === 'delete' && active) {
    const nextCustoms = presets.filter(item => item !== active);
    const nextOrder = curOrder.filter(id => id !== active.id);
    return applyCockpitPreset('cockpit', { customPresets: nextCustoms, presetOrder: nextOrder });
  }
  if (action === 'save') {
    const id = `custom-${window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
    const entry = { id, name, presetId: layout.presetId, widgets: layout.widgets };
    const nextCustoms = [...presets, entry];
    const nextOrder = normalizeCockpitPresetOrder([...curOrder, id], nextCustoms);
    persistCockpitLayout({ ...layout, activeCustomId: id, customPresets: nextCustoms, presetOrder: nextOrder });
  } else if (active) {
    const entry = action === 'rename' ? { ...active, name } : { ...active, widgets: layout.widgets };
    persistCockpitLayout({ ...layout, customPresets: presets.map(item => item === active ? entry : item), presetOrder: curOrder });
  }
  applyCockpitLayoutToDom();
  return getCockpitLayout();
}

function reorderCockpitPresets(sourceId, targetId, insertAfter = false, { persist = true } = {}) {
  const layout = getCockpitLayout();
  const customs = layout.customPresets || [];
  const order = normalizeCockpitPresetOrder(layout.presetOrder, customs).slice();
  const fromIdx = order.indexOf(sourceId);
  const toIdxOrig = order.indexOf(targetId);
  if (fromIdx < 0 || toIdxOrig < 0 || sourceId === targetId) return layout;
  order.splice(fromIdx, 1);
  let targetIdx = order.indexOf(targetId);
  if (targetIdx < 0) return layout;
  if (insertAfter) targetIdx += 1;
  order.splice(targetIdx, 0, sourceId);
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
  order.splice(idx, 1);
  order.splice(nextIdx, 0, presetId);
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

// 严格锁死合法吸格列数：xl 仅 4/6/8/12，wide 与 medium 仅 6/12，narrow 锁死 12 列仅调高度
const COCKPIT_LEGAL_SPANS = Object.freeze({
  xl: [4, 6, 8, 12],
  wide: [6, 12],
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

/** 窄容器（< 520px）收敛为单列 100% 宽 */
function isSkylineSingleColumn(containerWidth) {
  return !(Number(containerWidth) >= COCKPIT_SINGLE_COLUMN_BREAKPOINT);
}

/** 由 widthRatio / span 解析出该卡在给定容器宽下的像素宽 */
function resolveSkylineCardWidth(widget, containerWidth, gap = 10) {
  const container = Number(containerWidth) || 0;
  if (container <= 0) return 0;
  if (isSkylineSingleColumn(container)) return container;
  const ratio = Number(widget?.widthRatio);
  if (Number.isFinite(ratio) && ratio > 0) {
    return Math.max(Math.min(COCKPIT_MIN_WIDTH, container), Math.min(container, Math.round(ratio * container)));
  }
  const span = Math.max(1, Math.min(12, Number(widget?.span) || 12));
  return Math.max(COCKPIT_MIN_WIDTH, Math.min(container, Math.floor((container + gap) * span / 12 - gap)));
}

/**
 * Skyline 紧凑装箱：按顺序为每个盒子找「最高（y 最小）且能放下」的水平空位。
 * 候选 y 取 0 与所有已放置盒子的底边 + 间距；候选 x 取 0 与所有已放置盒子的右边缘 + 间距。
 * 结果确定性、绝不纵向重叠。
 */
function packSkylineBoxes(boxes, containerWidth, gap = 10, { fillSlivers = true } = {}) {
  const container = Number(containerWidth) || 0;
  const safeGap = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 10;
  const list = Array.isArray(boxes) ? boxes : [];
  if (container <= 0) return list.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const single = isSkylineSingleColumn(container);
  const placed = [];
  const out = [];
  for (const box of list) {
    const w = single ? container : Math.max(1, Math.min(container, Math.round(Number(box?.w) || container)));
    const h = Math.max(1, Math.ceil(Number(box?.h) || 0));
    const above = !single && Number.isInteger(box?.alignBelow) ? placed[box.alignBelow] : null;
    const align = above && above.x + w <= container ? above : null;
    const minY = align ? align.y + align.h + safeGap : 0;
    const candidateYs = [minY];
    for (const p of placed) candidateYs.push(p.y + p.h + safeGap);
    const ys = Array.from(new Set(candidateYs)).sort((a, b) => a - b);
    let chosen = null;
    for (const y of ys) {
      if (y < minY) continue;
      const candidateXs = align ? [align.x] : [0];
      if (!align) for (const p of placed) candidateXs.push(p.x + p.w + safeGap);
      const xs = Array.from(new Set(candidateXs)).sort((a, b) => a - b);
      for (const x of xs) {
        if (x + w > container + 0.5) continue;
        const collides = placed.some(p =>
          x < p.x + p.w + safeGap - 0.01 &&
          x + w + safeGap - 0.01 > p.x &&
          y < p.y + p.h + safeGap - 0.01 &&
          y + h + safeGap - 0.01 > p.y);
        if (!collides) {
          chosen = { x, y, w, h };
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      const maxBottom = placed.reduce((m, p) => Math.max(m, p.y + p.h + safeGap), 0);
      chosen = { x: 0, y: maxBottom, w, h };
    }
    placed.push(chosen);
    out.push({ ...chosen });
  }
  // 行尾极小缝隙（< 24px）微调贴齐右缘，彻底消除自由缩放后的右侧碎缝
  if (fillSlivers && !single) {
    const rows = new Map();
    for (const p of out) {
      const key = `${p.y}`;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(p);
    }
    for (const rowBoxes of rows.values()) {
      const rightMost = rowBoxes.reduce((m, p) => Math.max(m, p.x + p.w), 0);
      const leftover = container - rightMost;
      if (leftover > 0.5 && leftover < COCKPIT_ROW_SLIVER_PX) {
        const target = rowBoxes.reduce((best, p) => (p.x + p.w === rightMost && (!best || p.w > best.w) ? p : best), null);
        if (target) target.w = Math.min(container - target.x, target.w + leftover);
      }
    }
  }
  return out;
}

function aabbOverlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap - 0.01
    && a.x + a.w + gap - 0.01 > b.x
    && a.y < b.y + b.h + gap - 0.01
    && a.y + a.h + gap - 0.01 > b.y;
}


function applyCockpitLayoutToDom({ renderManager = true } = {}) {
  const layout = getCockpitLayout();
  const grid = el('ctx-bento-grid');
  const toolbar = el('ctx-cockpit-toolbar');

  if (toolbar) {
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

  // 按最新排序重排网格子卡片 DOM 顺序并同步列宽、高度模式与显隐
  const packItems = [];
  for (let i = 0; i < layout.widgets.length; i++) {
    const cfg = layout.widgets[i];
    const card = cardsById.get(cfg.id);
    if (!card) continue;

    if (!grid.hasAttribute?.('data-widget-gesture') && grid.children?.[i] !== card) {
      if (typeof grid.insertBefore === 'function') grid.insertBefore(card, grid.children?.[i] || null);
      else grid.appendChild?.(card);
    }

    card.hidden = !cfg.visible;
    card.style.display = cfg.visible ? '' : 'none';
    card.setAttribute?.('data-span', String(cfg.span));
    card.setAttribute?.('data-height-mode', cfg.height);
    card.classList?.remove?.('is-height-compact', 'is-height-standard', 'is-height-expanded');
    card.classList?.add?.(`is-height-${cfg.height}`);

    const fixedHeight = cfg.heightPx != null ? cfg.heightPx : cfg.customHeightPx;
    card.classList?.toggle?.('is-custom-height', fixedHeight != null);
    if (!card.classList?.contains?.('is-resizing')) {
      card.style.height = fixedHeight != null ? `${fixedHeight}px` : '';
    }

    const heightBtn = card.querySelector?.('[data-widget-action="cycle-height"]');
    if (heightBtn) {
      heightBtn.textContent = t(`session.widget.height.${cfg.height}`);
      heightBtn.title = t('session.widget.heightTitle');
    }
    if (cfg.visible) packItems.push({ cfg, card, fixedHeight });
  }

  applySkylineLayout(grid, packItems, metrics);

  if (renderManager) renderCockpitWidgetManagerPopover();
  return layout;
}

/**
 * 落地 2D Skyline 排版：先定宽并量自然高，再装箱、写 left/top/容器总高。
 * 宽网格保留自由缩放预览的位置，单列网格在预览时同步下移后续卡片。
 */
function applySkylineLayout(grid, items, metrics) {
  const containerW = Math.floor(metrics?.width || 0);
  const gap = COCKPIT_SKYLINE_GAP;
  grid.setAttribute?.('data-layout-engine', 'skyline');
  if (!containerW || !items.length) {
    // 容器尚未量出宽度（首屏 / 面板隐藏）时绝不落到绝对定位，否则卡片会塌成一条细缝
    grid.removeAttribute?.('data-layout-engine');
    if (grid.style) grid.style.height = '';
    // 面板随后展开时宽度才会出现，这里做有限次 rAF 重试让 2D 排版真正接管
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

  grid.__agSkylineRetry = 0;
  const singleColumn = isSkylineSingleColumn(containerW);
  const sizeCard = (card, width) => {
    card.style.width = `${width}px`;
    card.setAttribute?.('data-card-size', width < COCKPIT_CARD_COMPACT_MAX
      ? 'compact'
      : (width < COCKPIT_CARD_WIDE_MIN ? 'regular' : 'wide'));
  };
  const measureCardHeight = (card) => {
    // offsetHeight ignores transforms and includes borders and CSS min-height.
    const height = card.offsetHeight || card.getBoundingClientRect?.()?.height || 0;
    return Math.max(COCKPIT_MIN_HEIGHT, Math.ceil(height));
  };
  // Install widths before reading heights, so wrapping and container queries are current.
  for (const item of items) {
    const { cfg, card } = item;
    item.width = resolveSkylineCardWidth(cfg, containerW, gap);
    item.resizing = card.classList?.contains?.('is-resizing');
    if (item.resizing) continue;
    card.style.position = 'absolute';
    card.style.gridColumn = '';
    card.style.justifySelf = '';
    sizeCard(card, item.width);
  }
  for (const item of items) {
    if (item.resizing && !singleColumn) {
      item.width = item.card.offsetWidth || item.card.getBoundingClientRect?.()?.width || item.width;
    }
    item.height = measureCardHeight(item.card);
  }
  const boxes = () => items.map((item, index) => ({
    w: item.width, h: item.height,
    alignBelow: item.cfg.id === 'request-cost' && items[index - 1]?.cfg.id === 'token-breakdown' ? index - 1 : null
  }));
  let placements = packSkylineBoxes(boxes(), containerW, gap);
  const widened = [];
  items.forEach((item, index) => {
    const width = placements[index].w;
    if (item.resizing || width === item.width) return;
    item.width = width;
    sizeCard(item.card, width);
    widened.push(item);
  });
  if (widened.length) {
    for (const item of widened) item.height = measureCardHeight(item.card);
    placements = packSkylineBoxes(boxes(), containerW, gap, { fillSlivers: false });
  }
  let maxBottom = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const place = placements[i];
    if (!place) continue;
    maxBottom = Math.max(maxBottom, place.y + place.h);
    if (item.resizing && !singleColumn) continue;
    item.card.style.left = `${place.x}px`;
    item.card.style.top = `${place.y}px`;
    if (item.resizing) continue;
    // 列数按钮文案必须跟随实测宽度并走三语词条，杜绝英文界面泄漏「12列」这类硬编码
    const spanBtn = item.card.querySelector?.('[data-widget-action="cycle-span"]');
    if (spanBtn) {
      const spine = Math.max(1, Math.min(12, Math.round((place.w / containerW) * 12)));
      const label = t('session.widget.spanLabel', { n: spine });
      if (spanBtn.textContent !== label) spanBtn.textContent = label;
      spanBtn.title = t('session.widget.spanTitle');
    }
  }
  grid.style.height = `${Math.max(0, maxBottom)}px`;
  grid.setAttribute?.('data-layout-height', String(Math.max(0, maxBottom)));
  return placements;
}

function applyCockpitPreset(presetId, { persist = true, customPresets = getCockpitLayout().customPresets, presetOrder = getCockpitLayout().presetOrder } = {}) {
  const custom = customPresets?.find(item => item.id === presetId);
  const safeId = custom?.presetId || (Object.prototype.hasOwnProperty.call(COCKPIT_PRESET_LAYOUTS, presetId) ? presetId : 'cockpit');
  const nextOrder = normalizeCockpitPresetOrder(presetOrder, customPresets);
  const next = custom
    ? { presetId: safeId, widgets: custom.widgets, activeCustomId: custom.id, customPresets, presetOrder: nextOrder }
    : { ...buildDefaultCockpitLayout(safeId), customPresets, presetOrder: nextOrder };
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
    const cyclePool = isXl ? [4, 6, 8, 12] : [6, 12];
    let target = Number(nextSpan);
    if (!COCKPIT_VALID_SPANS.includes(target)) {
      const idx = cyclePool.indexOf(w.span);
      target = cyclePool[(idx + 1) % cyclePool.length];
    }
    return { ...w, span: target, customWidth: false };
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
    return { ...w, height: target, customHeightPx: px };
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
  if (!nextWidgets.some(w => w.visible)) {
    const ov = nextWidgets.find(w => w.id === 'overview-kpi') || nextWidgets[0];
    if (ov) ov.visible = true;
  }
  const saved = persistCockpitLayout({ ...cur, widgets: nextWidgets });
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
    toolbar.addEventListener('click', (e) => {
      const target = e?.target;
      const action = target?.closest?.('[data-custom-preset-action]')?.getAttribute('data-custom-preset-action');
      if (action) {
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
      const moveBtn = target?.closest?.('[data-preset-move]');
      if (moveBtn) {
        const moveId = moveBtn.getAttribute('data-preset-move-id');
        const delta = Number(moveBtn.getAttribute('data-preset-move') || 0);
        if (moveId && delta) moveCockpitPresetByOffset(moveId, delta, { persist: true });
        return;
      }
      if (target?.closest?.('#btn-ctx-preset-sort')) {
        presetSortMode = !presetSortMode;
        renderCockpitPresetsTrack(getCockpitLayout());
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

    // 预设条长按指针拖拽重排 + 键盘左右方向键辅助排序
    const presetTrack = el('ctx-cockpit-presets-track') || toolbar.querySelector?.('.ctx-cockpit-presets');
    if (presetTrack && !presetTrack._presetDragBound) {
      presetTrack._presetDragBound = true;
      let pDrag = null;
      const clearPDrag = () => {
        if (!pDrag) return;
        if (pDrag.pressTimer) clearTimeout(pDrag.pressTimer);
        if (pDrag.chipEl) pDrag.chipEl.classList?.remove?.('is-dragging');
        window.removeEventListener?.('pointermove', onPMove);
        window.removeEventListener?.('pointerup', onPUp);
        window.removeEventListener?.('pointercancel', clearPDrag);
        window.removeEventListener?.('keydown', onPEsc, true);
        pDrag = null;
      };
      const onPEsc = (ev) => {
        if (ev.key === 'Escape' && pDrag) {
          ev.preventDefault?.();
          clearPDrag();
        }
      };
      const onPMove = (ev) => {
        if (!pDrag) return;
        const dx = Math.abs((ev.clientX || 0) - pDrag.startX);
        const dy = Math.abs((ev.clientY || 0) - pDrag.startY);
        if (!pDrag.active && (dx > 6 || dy > 6)) {
          if (!pDrag.armed) { clearPDrag(); return; }
          pDrag.active = true;
          pDrag.chipEl?.classList?.add?.('is-dragging');
        }
        if (!pDrag.active) return;
        const btns = Array.from(presetTrack.querySelectorAll?.('[data-cockpit-preset]') || []);
        for (const cand of btns) {
          const cid = cand.getAttribute?.('data-cockpit-preset');
          if (!cid || cid === pDrag.presetId || typeof cand.getBoundingClientRect !== 'function') continue;
          const r = cand.getBoundingClientRect();
          if ((ev.clientX || 0) >= r.left && (ev.clientX || 0) <= r.right) {
            pDrag.targetId = cid;
            pDrag.insertAfter = (ev.clientX || 0) >= (r.left + r.width / 2);
            break;
          }
        }
      };
      const onPUp = () => {
        if (!pDrag) return;
        const { active, presetId, targetId, insertAfter } = pDrag;
        clearPDrag();
        if (active) {
          toolbar._suppressPresetClick = true;
          setTimeout(() => { toolbar._suppressPresetClick = false; }, 120);
          if (targetId && targetId !== presetId) {
            reorderCockpitPresets(presetId, targetId, insertAfter, { persist: true });
          }
        }
      };
      presetTrack.addEventListener?.('pointerdown', (ev) => {
        if (ev.isPrimary === false || (ev.button != null && ev.button !== 0)) return;
        if (ev.target?.closest?.('.ctx-preset-sort-step')) return;
        const btn = ev.target?.closest?.('[data-cockpit-preset]');
        const pid = btn?.getAttribute?.('data-cockpit-preset');
        if (!pid) return;
        clearPDrag();
        pDrag = {
          presetId: pid,
          chipEl: btn.closest?.('.ctx-preset-chip-group') || btn,
          startX: ev.clientX || 0,
          startY: ev.clientY || 0,
          armed: false,
          active: false,
          targetId: null,
          insertAfter: false,
          pressTimer: setTimeout(() => {
            if (!pDrag || pDrag.presetId !== pid) return;
            pDrag.armed = true;
            pDrag.active = true;
            pDrag.chipEl?.classList?.add?.('is-dragging');
          }, 180)
        };
        window.addEventListener?.('pointermove', onPMove);
        window.addEventListener?.('pointerup', onPUp);
        window.addEventListener?.('pointercancel', clearPDrag);
        window.addEventListener?.('keydown', onPEsc, true);
      });
      presetTrack.addEventListener?.('keydown', (ev) => {
        if (!presetSortMode) return;
        const btn = ev.target?.closest?.('[data-cockpit-preset]');
        const pid = btn?.getAttribute?.('data-cockpit-preset');
        if (!pid) return;
        if (ev.key === 'ArrowLeft') {
          ev.preventDefault?.();
          moveCockpitPresetByOffset(pid, -1, { persist: true });
        } else if (ev.key === 'ArrowRight') {
          ev.preventDefault?.();
          moveCockpitPresetByOffset(pid, 1, { persist: true });
        }
      });
      activeDisposers.add(clearPDrag);
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
    for (const card of Array.from(grid.children || [])) {
      if (!card.querySelector?.('.ag-widget-resize-handle')) continue;
      for (const side of ['left', 'right']) {
        const grip = document.createElement('div');
        grip.className = 'ctx-widget-resize-handle ag-widget-resize-handle';
        grip.setAttribute('data-resize-vertical', 'top');
        grip.setAttribute('data-resize-edge', side);
        grip.setAttribute('aria-hidden', 'true');
        card.appendChild(grip);
      }
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
      const observer = new ResizeObserver(entries => {
        let changed = false;
        let needsRepack = false;
        for (const { target, contentRect } of entries) {
          const { width, height } = contentRect;
          if (target === grid) {
            // 宽度从 0 变为 >0（面板首次展开）时必须立刻装箱，不能只等短时 rAF 轮询
            const engineEngaged = grid.getAttribute?.('data-layout-engine') === 'skyline';
            if (width > 0 && (width !== gridWidth || !engineEngaged)) {
              gridWidth = width;
              needsRepack = true;
            }
            continue;
          }
          if (!width || !height || target.classList?.contains?.('is-resizing')) continue;
          const stamp = `${Math.round(width)}:${Math.round(height)}`;
          if (sizes.get(target) !== stamp) {
            sizes.set(target, stamp);
            changed = true;
            // 卡片自身拿到真实尺寸就说明面板已展开，必须让 Skyline 立刻接管
            needsRepack = true;
          }
          if (grid.getAttribute?.('data-layout-engine') !== 'skyline') needsRepack = true;
        }
        if (needsRepack && activeDrag == null && repackFrame == null) {
          repackFrame = requestFrame(() => {
            repackFrame = null;
            if (state.disposed || activeDrag) return;
            const reflow = () => { applyCockpitLayoutToDom({ renderManager: false }); };
            try {
              if (isSkyline()) reflow();
              else flipLayout(visibleCards(), reflow);
            } catch { reflow(); }
          });
        }
        if (!changed || geometryFrame != null) return;
        geometryFrame = requestFrame(() => {
          geometryFrame = null;
          if (!el('panel')?.hidden) redrawCardCharts();
        });
      });
      for (const card of Array.from(grid.children || [])) {
        if (card.getAttribute?.('data-widget-id')) observer.observe(card);
      }
      observer.observe(grid);
      if (typeof activeDisposers !== 'undefined') {
        activeDisposers.add(() => {
          observer.disconnect();
          if (repackFrame != null) cancelFrame(repackFrame);
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
        const { card, originalHeight } = drag;
        card.classList.remove('is-resizing');
        card.removeAttribute?.('data-resizing');
        card.style.height = originalHeight;
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

      activeDrag = {
        mode: 'reorder',
        pointerId: pointerEv.pointerId,
        captureTarget: activeDrag?.captureTarget,
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
      const { startX, startY, startW, startH, gridW, gridLeft, gridTop, fromLeft, fromTop } = drag;
      const scrollAccum = drag.scrollAccum || 0;
      // Narrow boards stay single-column during the gesture as well as on commit.
      const horizontalDelta = fromLeft ? startX - x : x - startX;
      let width = drag.singleColumn ? gridW
        : clamp(startW + horizontalDelta, Math.min(COCKPIT_MIN_WIDTH, gridW), gridW);
      const deltaY = y - startY + scrollAccum;
      let height = clamp(Math.round(startH + (fromTop ? -deltaY : deltaY)), COCKPIT_MIN_HEIGHT, COCKPIT_MAX_HEIGHT);
      const leftForWidth = value => fromLeft
        ? clamp(gridLeft + startW - value, 0, Math.max(0, gridW - value))
        : Math.min(gridLeft, Math.max(0, gridW - value));
      const topForHeight = value => fromTop ? Math.max(0, gridTop + startH - value) : gridTop;
      if (drag.neighbors) {
        const guides = cockpitResizeMagnets(drag, width, height, leftForWidth(width), topForHeight(height));
        if (guides.x?.snapped) width = guides.x.size;
        if (guides.y?.snapped) height = guides.y.size;
        drawMagnet('x', guides.x);
        drawMagnet('y', guides.y);
      }
      const anchorLeft = leftForWidth(width);

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
      resizeBadgeEl.textContent = `${Math.round(width)} × ${height}px`;
      positionResizeBadge(x, y);
      drag.card.style.left = `${anchorLeft}px`;
      drag.card.style.top = `${topForHeight(height)}px`;
      drag.card.style.width = `${width}px`;
      drag.card.style.height = `${height}px`;
      if (drag.singleColumn) applyCockpitLayoutToDom({ renderManager: false });
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
          activeDrag.card.style.translate = `${Math.round(lastMoveX - activeDrag.offsetX - activeDrag.originLeft)}px ${Math.round(lastMoveY - activeDrag.offsetY - activeDrag.originTop)}px`;
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

      // 拖拽重排
      if (activeDrag.mode === 'reorder') {
        const px = ev.clientX || 0;
        const py = ev.clientY || 0;
        const targetX = px - activeDrag.offsetX;
        const targetY = py - activeDrag.offsetY;

        // 惯性形变计算
        const now = Date.now();
        const dt = Math.max(1, now - activeDrag.lastMoveTime);
        const instVx = ((px - activeDrag.lastMoveX) / dt) * 10;
        const instVy = ((py - activeDrag.lastMoveY) / dt) * 10;
        activeDrag.vx = activeDrag.vx * 0.7 + instVx * 0.3;
        activeDrag.vy = activeDrag.vy * 0.7 + instVy * 0.3;
        activeDrag.lastMoveX = px;
        activeDrag.lastMoveY = py;
        activeDrag.lastMoveTime = now;

        const tiltDeg = Math.max(-2.5, Math.min(2.5, activeDrag.vx * 0.4));
        const scaleX = Math.max(0.965, Math.min(1.035, 1 + activeDrag.vy * 0.002));
        const scaleY = Math.max(0.965, Math.min(1.035, 1 - activeDrag.vy * 0.002));

        if (activeDrag.card) {
          let dx = targetX - activeDrag.originLeft;
          let dy = targetY - activeDrag.originTop;
          if (activeDrag.neighbors) {
            const rect = grid.getBoundingClientRect();
            const left = targetX - rect.left;
            const top = targetY - rect.top;
            const right = left + activeDrag.cardW;
            const bottom = top + activeDrag.cardH;
            const pairEdges = (a, b, start, end) => [a, b].flatMap(edge => [start, end].map(at => ({ at, delta: at - edge })));
            const x = pairEdges(left, right, 0, rect.width);
            const y = [{ at: 0, delta: -top }];
            for (const other of activeDrag.neighbors) {
              x.push(...pairEdges(left, right, other.x, other.x + other.w));
              y.push(...pairEdges(top, bottom, other.y, other.y + other.h));
            }
            const xGuide = nearestCockpitGuide(x);
            const yGuide = nearestCockpitGuide(y);
            dx += xGuide?.delta || 0;
            dy += yGuide?.delta || 0;
            drawMagnet('x', xGuide);
            drawMagnet('y', yGuide);
          }
          activeDrag.card.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
          activeDrag.card.style.transform = `rotate(${tiltDeg.toFixed(2)}deg) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
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
        const { card, widgetId, finalW, finalH, gridW, singleColumn } = activeDrag;
        if (finalH == null) {
          cleanupDrag();
          return;
        }
        suppressClickFromGesture(event);
        const commitResize = () => {
          cleanupDrag({ repack: false });
          const layout = getCockpitLayout();
          const widget = layout.widgets.find(item => item.id === widgetId);
          if (widget) {
            if (!singleColumn) {
              const ratio = clamp(finalW / gridW, 0.08, 1);
              widget.widthRatio = Math.round(ratio * 10000) / 10000;
              widget.span = Math.max(1, Math.min(12, Math.round(ratio * 12)));
              widget.customWidth = ratio < 0.999;
            }
            widget.height = 'expanded';
            widget.heightPx = Math.round(finalH);
            widget.customHeightPx = Math.round(finalH);
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
        const { card, scroller, widgetId, targetId, insertAfter } = activeDrag;
        const before = getCockpitLayout();
        cleanupDrag({ repack: false });
        if (reorderCockpitWidget(widgetId, targetId, insertAfter) === before) {
          applyCockpitLayoutToDom({ renderManager: false });
        } else {
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
        }
        return;
      }

      cleanupDrag();
    };

    const onDragKeyDown = (event) => {
      if (event.key === 'Escape') cleanupDrag();
    };
    const onPointerInterrupted = (event) => {
      if (activeDrag?.pointerId === event.pointerId) cleanupDrag();
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

      const resizeHandle = e?.target?.closest?.('.ag-widget-resize-handle, .ctx-widget-resize-handle');
      if (resizeHandle) {
        const card = resizeHandle.closest?.('[data-widget-id]');
        const wId = card?.getAttribute?.('data-widget-id');
        const bodyEl = card?.querySelector?.('.ctx-widget-body');
        if (!wId || !bodyEl) return;
        e.preventDefault?.();
        clearSelectionSafe();
        flipAnimations.get(card)?.cancel();
        card.classList.remove('is-settling');
        const cardRect = card.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        const gridW = Math.floor(measureCockpitGrid(grid).width);
        if (!gridW || !cardRect.width) return;
        try { resizeHandle.setPointerCapture?.(e.pointerId); } catch { }
        activeDrag = {
          mode: 'resize',
          pointerId: e.pointerId,
          captureTarget: resizeHandle,
          card,
          widgetId: wId,
          startX: e.clientX ?? 0,
          startY: e.clientY ?? 0,
          startW: cardRect.width,
          startH: cardRect.height,
          originalHeight: card.style.height || '',
          gridW,
          singleColumn: isSkylineSingleColumn(gridW),
          gridLeft: Math.max(0, cardRect.left - gridRect.left),
          gridTop: Math.max(0, cardRect.top - gridRect.top),
          fromLeft: resizeHandle.getAttribute?.('data-resize-edge') === 'left',
          fromTop: resizeHandle.getAttribute?.('data-resize-vertical') === 'top',
          neighbors: isSkyline() && grid.offsetWidth > 0 ? readMagnetNeighbors(card, gridRect) : null,
          finalH: null,
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
      const resizeHandle = e?.target?.closest?.('.ag-widget-resize-handle, .ctx-widget-resize-handle');
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
