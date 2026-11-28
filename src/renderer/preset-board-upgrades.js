'use strict';
/**
 * 06 预设全项删除、中性圆角胶囊、无变形 2D Swap、8 向自由缩放防黑洞与四卡同行补齐模块
 *
 * 覆盖主工作树 src/renderer/dashboard-grid.js & template.html & styles.css 的剩余实证缺口：
 * 1. 预设操作三项（覆盖保存 / 重命名 / 删除预设 + 取消）统一中性圆角胶囊，去除 ctx-mini-link-btn 亮蓝字与下划线，
 *    按住态仅轻微加深底色，严禁 scale / skew / tilt / stretch / jelly 变形。
 * 2. 所有内置预设（会话总览/极简遥测/深度排障/速度与成本/多代理协作）与自建/空分组均可逐项删除；
 *    持久化 deletedPresetIds 防止重载/重绘/切会话复活；删后选中相邻可用项；支持删到 0 预设空态并保留「新建分组」。
 * 3. 预设 2D 点对点直接互换硬参数（5px / 140ms / 11px / 22% / 140ms 冷却 / 250ms FLIP / 200ms 等尺寸落位 /
 *    160ms ::before 阴影淡入），彻底清零 3.5deg 倾角、0.02 拉伸与 jelly 回弹，末尾新建分组永不参与交换且零高亮。
 * 4. 看板卡片 8 向自由缩放：允许窄栏/浮层/单列在 minWidth..gridW 连续横向缩宽；上沿与上角缩放采用滚动补偿与
 *    外层浮层高度锁定，彻底消除上方黑洞与外浮层高度跳变。
 * 5. 四卡同行与极窄态可读尺寸预算（overview-kpi / trend-pulse / timing-speed / context-inspector）。
 */
(function (rootScope) {
  const BUILTIN_PRESET_IDS = Object.freeze(['cockpit', 'minimal', 'debug', 'speed_cost', 'collab']);
  const PRESET_SWAP_PARAMS = Object.freeze({
    mode: 'swap',
    dragThresholdPx: 5,
    longPressMs: 140,
    deadzonePx: 11,
    deadzoneWidthRatio: 0.22,
    deadzoneHeightRatio: 0.22,
    cooldownMs: 140,
    flipMs: 250,
    flipEasing: 'cubic-bezier(0.22, 1.28, 0.36, 1)',
    dropMs: 200,
    shadowFadeMs: 160,
    pointerWeight: 0.65,
    ghostCenterWeight: 0.35,
    maxTiltDeg: 0,
    maxStretch: 0,
    jellySettle: false,
    pillHeightPx: 30,
    pillGapPx: 7,
    pillPadding: '0 10px 0 7px',
    pillFontSizePx: 12,
    gripWidthPx: 14,
    gripHeightPx: 20
  });

  const PRESET_UPGRADE_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      save: '保存',
      overwrite: '覆盖保存',
      rename: '重命名',
      deletePreset: '删除预设',
      cancel: '取消',
      newGroup: '新建分组',
      confirmDeleteTitle: '确认删除预设',
      confirmDeletePrompt: '将删除预设 {name}，其余预设与会话数据不受影响',
      confirmDeleteOk: '确认删除',
      emptyCatalogHint: '当前暂无预设，可点击新建分组重新创建',
      overwriteSavedToast: '已覆盖保存当前预设',
      renamedToast: '预设名称已更新',
      deletedToast: '已删除预设 {name}',
      saveFailedToast: '保存失败，已保留原状态',
      deleteFailedToast: '删除失败，已保留原预设',
      newGroupDefault: '新建分组 {n}',
      restoreDefaultModules: '恢复默认模块'
    }),
    'zh-TW': Object.freeze({
      save: '儲存',
      overwrite: '覆蓋儲存',
      rename: '重新命名',
      deletePreset: '刪除預設',
      cancel: '取消',
      newGroup: '新建分組',
      confirmDeleteTitle: '確認刪除預設',
      confirmDeletePrompt: '將刪除預設 {name}，其餘預設與工作階段資料不受影響',
      confirmDeleteOk: '確認刪除',
      emptyCatalogHint: '目前暫無預設，可點擊新建分組重新建立',
      overwriteSavedToast: '已覆蓋儲存目前預設',
      renamedToast: '預設名稱已更新',
      deletedToast: '已刪除預設 {name}',
      saveFailedToast: '儲存失敗，已保留原狀態',
      deleteFailedToast: '刪除失敗，已保留原預設',
      newGroupDefault: '新建分組 {n}',
      restoreDefaultModules: '恢復預設模組'
    }),
    en: Object.freeze({
      save: 'Save',
      overwrite: 'Overwrite',
      rename: 'Rename',
      deletePreset: 'Delete Preset',
      cancel: 'Cancel',
      newGroup: 'New Group',
      confirmDeleteTitle: 'Confirm Preset Deletion',
      confirmDeletePrompt: 'Delete preset {name}. Other presets and session data remain intact.',
      confirmDeleteOk: 'Delete',
      emptyCatalogHint: 'No presets left. Click New Group to create one.',
      overwriteSavedToast: 'Preset overwritten',
      renamedToast: 'Preset renamed',
      deletedToast: 'Deleted preset {name}',
      saveFailedToast: 'Save failed. Previous state kept.',
      deleteFailedToast: 'Delete failed. Preset kept.',
      newGroupDefault: 'Group {n}',
      restoreDefaultModules: 'Restore Default Modules'
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  function formatCopy(lang, key, vars = null) {
    const dict = PRESET_UPGRADE_I18N[resolveLang(lang)] || PRESET_UPGRADE_I18N['zh-CN'];
    let out = String(dict[key] || '');
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
      }
    }
    return out;
  }

  /**
   * 统一中性圆角胶囊 + 无变形按住态 + 无倾角 2D Swap 顶层 Ghost 样式片段
   */
  const PRESET_UPGRADE_CSS = `
    /* 1. 预设操作三项与保存/模块管理统一中性圆角胶囊，彻底消除亮蓝字与下划线 */
    .ctx-custom-preset-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .ctx-custom-preset-actions[hidden] {
      display: none !important;
    }
    .ctx-action-pill,
    .ctx-custom-preset-actions .ctx-action-pill,
    .ctx-preset-editor .ctx-action-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 10px;
      border-radius: 7px;
      border: 1px solid var(--ag-border-card, rgba(255, 255, 255, 0.12));
      background: var(--ag-btn-bg, rgba(255, 255, 255, 0.05));
      color: var(--ag-text-primary, #ececef);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      text-decoration: none !important;
      white-space: nowrap;
      cursor: pointer;
      outline: none;
      transform: none !important;
      transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .ctx-action-pill:hover:not(:disabled) {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.10));
      border-color: var(--ag-border-strong, rgba(255, 255, 255, 0.22));
      text-decoration: none !important;
    }
    .ctx-action-pill:active:not(:disabled),
    .ag-preset-pill:active:not(:disabled),
    .ctx-preset-pill:active:not(:disabled),
    .ag-preset-add-btn:active:not(:disabled) {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.16));
      transform: none !important;
      scale: 1 !important;
    }
    .ctx-action-pill:focus-visible,
    .ag-preset-pill:focus-visible,
    .ag-preset-add-btn:focus-visible {
      box-shadow: 0 0 0 2px var(--ag-focus-ring, rgba(120, 140, 255, 0.68));
    }
    /* 删除按钮平时完全中性，仅悬停呈现克制危险态 */
    .ctx-action-pill--danger-hover:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.14);
      border-color: rgba(239, 68, 68, 0.42);
      color: var(--ag-ring-danger, #f87171);
    }
    .ctx-action-pill--danger-hover:active:not(:disabled) {
      background: rgba(239, 68, 68, 0.22);
      transform: none !important;
    }
    [data-theme="light"] .ctx-action-pill {
      border-color: rgba(24, 24, 27, 0.14);
      background: rgba(24, 24, 27, 0.04);
      color: #18181b;
    }
    [data-theme="light"] .ctx-action-pill:hover:not(:disabled) {
      background: rgba(24, 24, 27, 0.08);
      border-color: rgba(24, 24, 27, 0.24);
    }
    [data-theme="light"] .ctx-action-pill:active:not(:disabled),
    [data-theme="light"] .ag-preset-pill:active:not(:disabled) {
      background: rgba(24, 24, 27, 0.14);
      transform: none !important;
    }
    [data-theme="light"] .ctx-action-pill--danger-hover:hover:not(:disabled) {
      background: rgba(220, 38, 38, 0.09);
      border-color: rgba(220, 38, 38, 0.34);
      color: #dc2626;
    }

    /* 2. 预设轨道与 2D Swap 等尺寸无变形浮层，::before 160ms 淡入柔和投影 */
    .ag-preset-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
    }
    .ag-preset-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 10px 0 7px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      box-sizing: border-box;
      white-space: nowrap;
      transform: none;
    }
    .ag-preset-pill .ag-preset-handle {
      width: 14px;
      height: 20px;
      flex: 0 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .ag-preset-pill.is-drag-placeholder {
      border-style: dashed !important;
      background: transparent !important;
      color: transparent !important;
      box-shadow: none !important;
    }
    .ag-preset-pill.is-drag-placeholder > * {
      visibility: hidden !important;
    }
    #ag-pbar-ghost-portal.ag-pbar-ghost-layer {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      overflow: visible !important;
      contain: none !important;
    }
    #ag-pbar-ghost-portal .ag-preset-drag-ghost {
      position: fixed !important;
      left: 0;
      top: 0;
      margin: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      height: 30px !important;
      padding: 0 10px 0 7px !important;
      border-radius: 7px !important;
      box-sizing: border-box !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      line-height: 1 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      will-change: transform !important;
    }
    #ag-pbar-ghost-portal .ag-preset-drag-ghost::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow: 0 10px 26px -6px rgba(0, 0, 0, 0.45), 0 3px 10px -2px rgba(0, 0, 0, 0.28);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
    }
    #ag-pbar-ghost-portal .ag-preset-drag-ghost.is-shadow-visible::before {
      opacity: 1;
    }
    #ag-pbar-ghost-portal .ag-preset-drag-ghost.is-dropping::before {
      opacity: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      .ctx-action-pill,
      #ag-pbar-ghost-portal .ag-preset-drag-ghost::before {
        transition: none !important;
      }
    }
  `;

  /**
   * 归一化预设目录：支持 deletedPresetIds 持久化，确保已删除的内置预设绝不在重绘/重载/切会话后复活，
   * 且支持 0 预设空态（不强制回退 'cockpit'）。旧配置无 deletedPresetIds 字段时保留全部内置预设。
   */
  function normalizePresetCatalog(rawLayout = {}, builtinIds = BUILTIN_PRESET_IDS) {
    const builtins = Array.isArray(builtinIds) ? builtinIds.slice() : [...BUILTIN_PRESET_IDS];
    const builtinSet = new Set(builtins);
    const customPresets = Array.isArray(rawLayout?.customPresets)
      ? rawLayout.customPresets.filter(p => p && typeof p.id === 'string' && p.id.trim())
      : [];
    const customIds = customPresets.map(p => p.id.trim());
    const customSet = new Set(customIds);

    const rawDeleted = Array.isArray(rawLayout?.deletedPresetIds) ? rawLayout.deletedPresetIds : [];
    const deletedSet = new Set();
    for (const id of rawDeleted) {
      const clean = String(id || '').trim();
      if (clean && builtinSet.has(clean)) deletedSet.add(clean);
    }

    const availableBuiltins = builtins.filter(id => !deletedSet.has(id));
    const validIds = new Set([...availableBuiltins, ...customIds]);

    const seen = new Set();
    const order = [];
    for (const rawId of (Array.isArray(rawLayout?.presetOrder) ? rawLayout.presetOrder : [])) {
      const pid = String(rawId || '').trim();
      if (!pid || !validIds.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      order.push(pid);
    }
    for (const bId of availableBuiltins) {
      if (!seen.has(bId)) { seen.add(bId); order.push(bId); }
    }
    for (const cId of customIds) {
      if (!seen.has(cId)) { seen.add(cId); order.push(cId); }
    }

    const requestedActive = String(rawLayout?.activeCustomId || rawLayout?.presetId || '').trim();
    let activeId = null;
    if (order.length > 0) {
      activeId = validIds.has(requestedActive) ? requestedActive : order[0];
    }
    const activeIsCustom = Boolean(activeId && customSet.has(activeId));

    return {
      order,
      deletedPresetIds: Array.from(deletedSet),
      customPresets,
      activeId,
      activeCustomId: activeIsCustom ? activeId : null,
      presetId: activeId && !activeIsCustom ? activeId : (activeId ? String(rawLayout?.presetId || 'cockpit') : null),
      isEmptyCatalog: order.length === 0,
      canDeleteActive: Boolean(activeId),
      canRenameActive: activeIsCustom,
      canOverwriteActive: Boolean(activeId)
    };
  }

  /**
   * 逐项删除任意预设（内置 / 自建 / 0 模块空分组）：
   * - 有剩余时选中相邻可用项（优先原索引位置的新项，否则前一项）
   * - 删除最后一项时进入 0 预设空态，绝不自动补回内置项
   */
  function deletePresetFromCatalog(rawLayout = {}, targetId, builtinIds = BUILTIN_PRESET_IDS) {
    const cleanTarget = String(targetId || '').trim();
    const before = normalizePresetCatalog(rawLayout, builtinIds);
    const idx = before.order.indexOf(cleanTarget);
    if (idx < 0) {
      return { changed: false, catalog: before, nextLayout: { ...rawLayout } };
    }

    const builtinSet = new Set(Array.isArray(builtinIds) ? builtinIds : BUILTIN_PRESET_IDS);
    const nextDeleted = new Set(before.deletedPresetIds);
    let nextCustoms = before.customPresets.slice();

    if (builtinSet.has(cleanTarget)) {
      nextDeleted.add(cleanTarget);
    } else {
      nextCustoms = nextCustoms.filter(p => String(p.id).trim() !== cleanTarget);
    }

    const nextOrder = before.order.filter(id => id !== cleanTarget);
    let nextActiveId = null;
    if (nextOrder.length > 0) {
      nextActiveId = idx < nextOrder.length ? nextOrder[idx] : nextOrder[nextOrder.length - 1];
    }

    const customSet = new Set(nextCustoms.map(p => String(p.id).trim()));
    const nextActiveCustomId = nextActiveId && customSet.has(nextActiveId) ? nextActiveId : null;
    const nextPresetId = nextActiveId && !nextActiveCustomId ? nextActiveId : null;

    const nextLayout = {
      ...rawLayout,
      customPresets: nextCustoms,
      deletedPresetIds: Array.from(nextDeleted),
      presetOrder: nextOrder,
      activeCustomId: nextActiveCustomId,
      presetId: nextPresetId,
      emptyPresetCatalog: nextOrder.length === 0
    };
    if (nextOrder.length === 0) {
      nextLayout.modules = [];
      nextLayout.emptyGroup = true;
    }

    const catalog = normalizePresetCatalog(nextLayout, builtinIds);
    return {
      changed: true,
      deletedId: cleanTarget,
      previousIndex: idx,
      nextActiveId: catalog.activeId,
      catalog,
      nextLayout
    };
  }

  /**
   * 预设 2D 点对点直接互换命中测试（对齐 06 硬参数：11px / 22% 内缩、0.65 指针 + 0.35 胶囊中心）
   */
  function hitTestFrozenHomeSlots(pointerX, pointerY, ghostRect, homeSlots, params = PRESET_SWAP_PARAMS) {
    if (!Array.isArray(homeSlots) || homeSlots.length === 0) return -1;
    const pw = Number.isFinite(Number(params.pointerWeight)) ? Number(params.pointerWeight) : 0.65;
    const gw = Number.isFinite(Number(params.ghostCenterWeight)) ? Number(params.ghostCenterWeight) : 0.35;
    const gx = ghostRect ? (ghostRect.left + ghostRect.width / 2) : pointerX;
    const gy = ghostRect ? (ghostRect.top + ghostRect.height / 2) : pointerY;
    const hitX = pointerX * pw + gx * gw;
    const hitY = pointerY * pw + gy * gw;
    const deadzonePx = Number.isFinite(Number(params.deadzonePx)) ? Number(params.deadzonePx) : 11;
    const wRatio = Number.isFinite(Number(params.deadzoneWidthRatio)) ? Number(params.deadzoneWidthRatio) : 0.22;
    const hRatio = Number.isFinite(Number(params.deadzoneHeightRatio)) ? Number(params.deadzoneHeightRatio) : 0.22;

    for (let i = 0; i < homeSlots.length; i++) {
      const slot = homeSlots[i];
      if (!slot || slot.isAddButton || !slot.rect) continue;
      const r = slot.rect;
      const insetX = Math.min(deadzonePx, r.width * wRatio);
      const insetY = Math.min(deadzonePx * 0.4, r.height * hRatio);
      if (hitX >= r.left + insetX && hitX <= r.right - insetX && hitY >= r.top + insetY && hitY <= r.bottom - insetY) {
        return slot.index !== undefined ? slot.index : i;
      }
    }
    return -1;
  }

  /**
   * 从冻结基准 baseOrder 直接互换 originIndex 与 targetIndex，中间胶囊保持原位不动
   */
  function computeDirectSwapOrder(baseOrder, originIndex, targetIndex) {
    const out = Array.isArray(baseOrder) ? baseOrder.slice() : [];
    if (originIndex < 0 || targetIndex < 0 || originIndex >= out.length || targetIndex >= out.length) {
      return out;
    }
    if (originIndex === targetIndex) return out;
    const tmp = out[originIndex];
    out[originIndex] = out[targetIndex];
    out[targetIndex] = tmp;
    return out;
  }

  /**
   * 严格边界钳制：确保自由画布卡片四边永不越出容器水平范围与零上界（可选垂直上限）
   */
  function clampFreestyleRect(rect, containerWidth, limits = {}) {
    const cw = Math.max(1, Math.floor(Number(containerWidth) || 0));
    const reqMinW = Number.isFinite(Number(limits.minWidth)) ? Number(limits.minWidth) : 72;
    const reqMinH = Number.isFinite(Number(limits.minHeight)) ? Number(limits.minHeight) : 48;
    const reqMaxH = Number.isFinite(Number(limits.maxHeight)) ? Number(limits.maxHeight) : 1600;
    const maxCanvasH = Number.isFinite(Number(limits.maxContainerHeight)) && Number(limits.maxContainerHeight) > 0
      ? Math.floor(Number(limits.maxContainerHeight))
      : null;
    const effMinW = Math.min(Math.max(1, Math.round(reqMinW)), cw);
    const maxH = maxCanvasH != null ? Math.max(1, Math.min(reqMaxH, maxCanvasH)) : Math.max(1, reqMaxH);
    const effMinH = Math.min(Math.max(1, Math.round(reqMinH)), maxH);

    let w = Number.isFinite(Number(rect?.w)) ? Math.round(Number(rect.w)) : cw;
    w = Math.max(effMinW, Math.min(cw, w));
    let h = Number.isFinite(Number(rect?.h)) ? Math.round(Number(rect.h)) : effMinH;
    h = Math.max(effMinH, Math.min(maxH, h));
    let x = Number.isFinite(Number(rect?.x)) ? Math.round(Number(rect.x)) : 0;
    x = Math.max(0, Math.min(cw - w, x));
    let y = Number.isFinite(Number(rect?.y)) ? Math.round(Number(rect.y)) : 0;
    y = maxCanvasH != null ? Math.max(0, Math.min(Math.max(0, maxCanvasH - h), y)) : Math.max(0, y);

    return { x, y, w, h };
  }

  /**
   * 卡片尺寸密度与长宽比形态分类器：驱动微缩/扁长条/窄高柱优雅自适应
   */
  function classifyCardLayoutState(width, height) {
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
  }

  /**
   * 8 向自由缩放纯几何解算器：
   * - 支持 8 方向（n/s/e/w/ne/nw/se/sw）任意合法矩形与极紧凑尺寸（freePosition 模式下低至 72×48）
   * - 左/上边与左上/右上/左下角反向拉伸时同步更新坐标与宽高，严格钳制在 [0, gridW] 与 y >= 0 内
   * - 兼容旧调用（未传 freePosition 时保留滚动补偿与 180/140 默认下限）
   */
  function resolveFreeResizeGeometry(drag, pointer, limits = {}) {
    const freePosition = Boolean(limits.freePosition);
    const minFloorW = freePosition ? 48 : 120;
    const minFloorH = freePosition ? 36 : 100;
    const defaultMinW = freePosition ? 72 : 180;
    const defaultMinH = freePosition ? 48 : 140;
    const minW = Math.max(minFloorW, Number(limits.minWidth) || defaultMinW);
    const minH = Math.max(minFloorH, Number(limits.minHeight) || defaultMinH);
    const maxH = Math.max(minH, Number(limits.maxHeight) || (freePosition ? 1600 : 1400));
    const maxCanvasH = Number.isFinite(Number(limits.maxContainerHeight)) && Number(limits.maxContainerHeight) > 0
      ? Math.floor(Number(limits.maxContainerHeight))
      : null;
    const gridW = Math.max(1, Math.floor(Number(drag.gridW) || 360));
    const effMinW = Math.min(minW, gridW);

    const axis = drag.resizeAxis || 'both'; // 'x' | 'y' | 'both'
    const allowX = axis !== 'y';
    const allowY = axis !== 'x';
    const fromLeft = Boolean(drag.fromLeft);
    const fromTop = Boolean(drag.fromTop);

    const startW = Math.max(1, Number(drag.startW) || effMinW);
    const startH = Math.max(1, Number(drag.startH) || minH);
    const startLeft = Math.max(0, Number(drag.gridLeft) || 0);
    const startTop = Math.max(0, Number(drag.gridTop) || 0);

    const dx = Number(pointer.x) - Number(drag.startX);
    const dy = Number(pointer.y) - Number(drag.startY) + Number(drag.scrollAccum || 0);

    let width;
    let left;
    if (freePosition) {
      if (allowX) {
        if (fromLeft) {
          const anchorRight = Math.max(effMinW, Math.min(gridW, Math.round(startLeft + startW)));
          width = Math.round(Math.max(effMinW, Math.min(anchorRight, startW - dx)));
          left = Math.max(0, anchorRight - width);
        } else {
          left = Math.max(0, Math.min(Math.max(0, gridW - effMinW), Math.round(startLeft)));
          const maxRightW = Math.max(effMinW, gridW - left);
          width = Math.round(Math.max(effMinW, Math.min(maxRightW, startW + dx)));
        }
      } else {
        width = Math.round(Math.max(effMinW, Math.min(gridW, startW)));
        left = Math.max(0, Math.min(Math.max(0, gridW - width), Math.round(startLeft)));
      }
    } else {
      const horizontalDelta = fromLeft ? -dx : dx;
      width = allowX
        ? Math.round(Math.max(effMinW, Math.min(gridW, startW + horizontalDelta)))
        : Math.round(Math.max(effMinW, Math.min(gridW, startW)));
      left = fromLeft
        ? Math.round(Math.max(0, Math.min(Math.max(0, gridW - width), startLeft + startW - width)))
        : Math.round(Math.min(startLeft, Math.max(0, gridW - width)));
    }

    let height;
    let top = startTop;
    let scrollTopDelta = 0;
    if (freePosition) {
      if (allowY) {
        if (fromTop) {
          const anchorBottom = Math.max(minH, Math.round(startTop + startH));
          const maxTopH = Math.min(maxH, anchorBottom);
          height = Math.round(Math.max(minH, Math.min(maxTopH, startH - dy)));
          top = Math.max(0, anchorBottom - height);
        } else {
          top = Math.max(0, Math.round(startTop));
          const maxBottomH = maxCanvasH != null ? Math.max(minH, Math.min(maxH, maxCanvasH - top)) : maxH;
          height = Math.round(Math.max(minH, Math.min(maxBottomH, startH + dy)));
        }
      } else {
        top = Math.max(0, Math.round(startTop));
        height = Math.round(Math.max(minH, Math.min(maxH, startH)));
      }
      const clamped = clampFreestyleRect({ x: left, y: top, w: width, h: height }, gridW, {
        minWidth: effMinW,
        minHeight: minH,
        maxHeight: maxH,
        maxContainerHeight: maxCanvasH
      });
      left = clamped.x;
      top = clamped.y;
      width = clamped.w;
      height = clamped.h;
    } else {
      const verticalDelta = fromTop ? -dy : dy;
      height = allowY
        ? Math.round(Math.max(minH, Math.min(maxH, startH + verticalDelta)))
        : Math.round(startH);
      if (allowY && fromTop) {
        const heightDiff = height - startH;
        top = startTop;
        scrollTopDelta = heightDiff;
      }
    }

    const widthRatio = Number((width / gridW).toFixed(4));
    return {
      width,
      height,
      left,
      top,
      widthRatio,
      scrollTopDelta,
      lockOuterPanelHeight: Boolean(!freePosition && allowY && fromTop),
      topGapCreatedPx: Math.max(0, top - startTop)
    };
  }

  /**
   * 四卡同行尺寸预算计算（对应 06：overview-kpi / trend-pulse / timing-speed / context-inspector）
   * 给出宽屏四槽预算、极窄可读降级档位与同排对齐行底高度
   */
  function computeFourCardRowBudget(containerWidth, gap = 10, minReadableFourCardW = 165) {
    const availW = Math.max(200, Math.floor(Number(containerWidth) || 0));
    const g = Math.max(0, Number(gap) || 10);
    const totalGap4 = g * 3;
    const slotW4 = Math.floor((availW - totalGap4) / 4);
    const canFitFour = slotW4 >= minReadableFourCardW;
    const remainder4 = canFitFour ? (availW - totalGap4 - slotW4 * 4) : 0;

    const fourCardWidths = canFitFour
      ? [slotW4, slotW4, slotW4, slotW4 + remainder4]
      : null;

    const densityTier = slotW4 < 190 ? 'ultra-narrow' : (slotW4 < 260 ? 'compact' : 'standard');
    return {
      containerWidth: availW,
      gap: g,
      canFitFour,
      slotWidth: slotW4,
      fourCardWidths,
      trailingGapPx: canFitFour ? 0 : Math.max(0, availW - slotW4 * 3 - g * 2),
      densityTier,
      minReadableFourCardW
    };
  }

  /**
   * 渲染预设操作胶囊组（替代旧 ctx-mini-link-btn，支持所有内置与自建预设的删除入口）
   */
  function syncPresetActionPillsDom(container, catalog, lang = 'zh-CN') {
    if (!container) return;
    container.hidden = !catalog.activeId;
    const btns = Array.from(container.querySelectorAll?.('button') || []);
    for (const btn of btns) {
      const action = btn.getAttribute?.('data-custom-preset-action') || '';
      btn.classList?.remove?.('ctx-mini-link-btn');
      btn.classList?.add?.('ctx-action-pill');
      if (action === 'delete') {
        btn.classList?.add?.('ctx-action-pill--danger-hover');
        btn.hidden = !catalog.canDeleteActive;
        btn.textContent = formatCopy(lang, 'deletePreset');
      } else if (action === 'rename') {
        btn.hidden = !catalog.canRenameActive;
        btn.textContent = formatCopy(lang, 'rename');
      } else if (action === 'overwrite') {
        btn.hidden = !catalog.canOverwriteActive;
        btn.textContent = formatCopy(lang, 'overwrite');
      }
    }
  }

  const exported = {
    BUILTIN_PRESET_IDS,
    PRESET_SWAP_PARAMS,
    PRESET_UPGRADE_I18N,
    PRESET_UPGRADE_CSS,
    formatCopy,
    normalizePresetCatalog,
    deletePresetFromCatalog,
    hitTestFrozenHomeSlots,
    computeDirectSwapOrder,
    clampFreestyleRect,
    classifyCardLayoutState,
    resolveFreeResizeGeometry,
    computeFourCardRowBudget,
    syncPresetActionPillsDom
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGPresetBoardUpgrades = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
