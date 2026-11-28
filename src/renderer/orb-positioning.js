'use strict';
/**
 * 03 悬浮圆球定位、模态层退场与防跳变拖动控制器
 *
 * 根治问题（对照《圆球错位.mp4》与《圆球移动bug.mp4》）：
 * 1. 按下拖动时读取圆球当前实际显示坐标（displayPos / DOM rect），不再直接用未避让的 userAnchor，消除首帧跳变。
 * 2. 附件预览遮罩、宿主 Settings 及插件设置页/独立账号页等模态层出现时，圆球与已展开径向菜单同步退出前景与命中，
 *    并取消任何进行中的拖动；模态关闭后按原显示位或新边界稳定恢复，不覆写用户保存锚点。
 * 3. 自动避让、临时隐退、Esc/pointercancel/blur 取消拖动均不覆写 userAnchor；仅合法松手落点持久化一次。
 * 4. 统一 Pointer Events，消除 pointerdown+mousedown 重复绑定，保持单击开菜单与拖后点击抑制。
 */
(function (rootScope) {
  const ORB_SIZE_PX = 46;
  const DEFAULT_DRAG_THRESHOLD_PX = 5;

  function clampOrbCoord(pos, vw, vh, orbSize = ORB_SIZE_PX) {
    const safeW = Number.isFinite(Number(vw)) && Number(vw) > 0 ? Number(vw) : 1280;
    const safeH = Number.isFinite(Number(vh)) && Number(vh) > 0 ? Number(vh) : 800;
    const minX = 12;
    const maxX = Math.max(minX, safeW - orbSize - 12);
    const minY = 48;
    const maxY = Math.max(minY, safeH - orbSize - 12);
    const rawX = Number(pos?.x);
    const rawY = Number(pos?.y);
    return {
      x: Math.round(Math.max(minX, Math.min(maxX, Number.isFinite(rawX) ? rawX : maxX))),
      y: Math.round(Math.max(minY, Math.min(maxY, Number.isFinite(rawY) ? rawY : Math.round(safeH * 0.62))))
    };
  }

  /**
   * 检测当前页面是否存在占用焦点的宿主模态层或全页覆盖层（Settings、附件预览/图片灯箱、详细上下文页、个人主页、通用 aria-modal 对话框）
   */
  function detectBlockingHostModal(doc, opts = {}) {
    if (opts.hostSettingsModalOpen) return { blocked: true, reason: 'host-settings' };
    if (opts.marketplaceActive) return { blocked: true, reason: 'marketplace' };
    if (opts.insightsPageActive) return { blocked: true, reason: 'context-insights' };
    if (opts.profileHomeActive) return { blocked: true, reason: 'profile-home' };
    if (opts.fullPageActive) return { blocked: true, reason: 'fullpage-overlay' };
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { blocked: false, reason: null };
    }
    const fullPageSelectors = [
      '#ag-context-insights-page',
      '#ag-profile-home-page',
      '#ag-cm-host-settings-page',
      '#ag-cm-host-accounts-page',
      '[data-om-fullpage-active="true"]',
      '[data-om-context-insights="true"]',
      '[data-om-profile-home="true"]'
    ];
    let fullPageNodes = [];
    try {
      fullPageNodes = Array.from(doc.querySelectorAll(fullPageSelectors.join(',')) || []);
    } catch {
      fullPageNodes = [];
    }
    for (const node of fullPageNodes) {
      if (!node || node.hidden) continue;
      if (node.style?.display === 'none' || node.style?.visibility === 'hidden') continue;
      if (typeof node.getBoundingClientRect === 'function') {
        const r = node.getBoundingClientRect();
        if (r && (r.width <= 0 || r.height <= 0)) continue;
      }
      const id = String(node.id || '');
      const reason = (id === 'ag-context-insights-page' || node.getAttribute?.('data-om-context-insights') === 'true')
        ? 'context-insights'
        : ((id === 'ag-profile-home-page' || node.getAttribute?.('data-om-profile-home') === 'true')
          ? 'profile-home'
          : 'fullpage-overlay');
      return { blocked: true, reason };
    }
    const selectors = [
      '.settings-modal-container',
      '[data-testid="settings-sidebar"]',
      '[data-testid*="attachment-preview" i]',
      '[data-testid*="image-preview" i]',
      '[data-testid*="lightbox" i]',
      '[data-testid*="media-preview" i]',
      '[role="dialog"][aria-modal="true"]',
      '[aria-modal="true"]'
    ];
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll(selectors.join(',')) || []);
    } catch {
      nodes = [];
    }
    for (const node of nodes) {
      if (!node || node.hidden) continue;
      if (node.closest?.('#ag-context-meter, #ag-context-meter-radial-host')) continue;
      const cls = String(node.className || '');
      const role = String(node.getAttribute?.('role') || '').toLowerCase();
      if (role === 'status' || role === 'alert' || /\btoast\b|\bsnackbar\b|\bnotification\b/i.test(cls)) continue;
      if (node.style?.display === 'none' || node.style?.visibility === 'hidden') continue;
      if (typeof node.getBoundingClientRect === 'function') {
        const r = node.getBoundingClientRect();
        if (r && (r.width <= 0 || r.height <= 0)) continue;
      }
      const tid = String(node.getAttribute?.('data-testid') || '');
      const reason = /settings/i.test(`${cls} ${tid}`) ? 'host-settings'
        : (/preview|lightbox|media/i.test(`${cls} ${tid}`) ? 'attachment-preview' : 'host-modal');
      return { blocked: true, reason };
    }
    return { blocked: false, reason: null };
  }

  function createOrbPositioningController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    const orbSize = Number.isFinite(Number(deps.orbSize)) ? Number(deps.orbSize) : ORB_SIZE_PX;
    const dragThresholdPx = Number.isFinite(Number(deps.dragThresholdPx))
      ? Number(deps.dragThresholdPx)
      : DEFAULT_DRAG_THRESHOLD_PX;

    const getViewport = () => {
      if (typeof deps.getViewportSize === 'function') {
        const v = deps.getViewportSize();
        if (v && v.width > 0 && v.height > 0) return v;
      }
      return {
        width: Number(win?.innerWidth) || 1280,
        height: Number(win?.innerHeight) || 800
      };
    };

    const computeAvoided = (anchor, vw, vh) => {
      const clamped = clampOrbCoord(anchor, vw, vh, orbSize);
      if (typeof deps.computeAvoidance === 'function') {
        const out = deps.computeAvoidance(clamped, vw, vh);
        if (out && Number.isFinite(Number(out.x)) && Number.isFinite(Number(out.y))) {
          return clampOrbCoord(out, vw, vh, orbSize);
        }
      }
      return clamped;
    };

    let userAnchor = clampOrbCoord(deps.initialAnchor || null, getViewport().width, getViewport().height, orbSize);
    let displayPos = { ...userAnchor };
    let enabled = deps.enabled !== false;
    let hiddenByModal = false;
    let hiddenReason = null;
    let preModalDisplayPos = null;
    let preModalViewportKey = '';
    let lastLayoutSig = '';
    let orbEl = null;
    let disposed = false;

    // 拖动状态
    let drag = null;
    let suppressNextClick = false;
    let lastDragTrace = null;

    function buildViewportKey(vw, vh) {
      return `${Math.round(vw)}x${Math.round(vh)}`;
    }

    function readVisiblePositionFromDom(vw, vh) {
      if (orbEl && typeof orbEl.getBoundingClientRect === 'function') {
        const r = orbEl.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0 && Number.isFinite(r.left) && Number.isFinite(r.top)) {
          return clampOrbCoord({ x: r.left, y: r.top }, vw, vh, orbSize);
        }
      }
      if (orbEl && orbEl.style) {
        const lx = parseFloat(orbEl.style.left);
        const ty = parseFloat(orbEl.style.top);
        if (Number.isFinite(lx) && Number.isFinite(ty)) {
          return clampOrbCoord({ x: lx, y: ty }, vw, vh, orbSize);
        }
      }
      return clampOrbCoord(displayPos, vw, vh, orbSize);
    }

    function writePositionToDom(pos) {
      displayPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
      if (orbEl && orbEl.style) {
        orbEl.style.left = `${displayPos.x}px`;
        orbEl.style.top = `${displayPos.y}px`;
      }
    }

    function cancelActiveDrag(reason = 'cancel') {
      if (!drag) return false;
      const prevDrag = drag;
      drag = null;
      if (orbEl) {
        orbEl.classList?.remove?.('is-pressing', 'is-dragging');
        if (prevDrag.pointerId != null && typeof orbEl.releasePointerCapture === 'function') {
          try { orbEl.releasePointerCapture(prevDrag.pointerId); } catch { }
        }
      }
      // 取消拖动绝不覆写 userAnchor，回到拖前显示坐标
      writePositionToDom(prevDrag.startDisplayPos);
      lastDragTrace = {
        ...prevDrag.trace,
        cancelled: true,
        cancelReason: reason,
        restoredPos: { ...prevDrag.startDisplayPos },
        savedAnchor: { ...userAnchor }
      };
      return true;
    }

    function syncVisibilityAndPosition(opts = {}) {
      if (disposed) return { visible: false, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
      const { width: vw, height: vh } = getViewport();
      const modalState = detectBlockingHostModal(doc, {
        hostSettingsModalOpen: Boolean(opts.hostSettingsModalOpen ?? deps.isHostSettingsModalOpen?.()),
        marketplaceActive: Boolean(opts.marketplaceActive ?? deps.isMarketplaceActive?.()),
        insightsPageActive: Boolean(opts.insightsPageActive ?? deps.isInsightsPageActive?.()),
        profileHomeActive: Boolean(opts.profileHomeActive ?? deps.isProfileHomeActive?.()),
        fullPageActive: Boolean(opts.fullPageActive ?? deps.isFullPageActive?.())
      });

      const shouldBlock = modalState.blocked;
      const shouldShow = enabled && !shouldBlock;

      if (!shouldShow) {
        if (!hiddenByModal && shouldBlock) {
          // 记录打开模态层之前的显示坐标与视口，供关闭后原位恢复
          preModalDisplayPos = readVisiblePositionFromDom(vw, vh);
          preModalViewportKey = buildViewportKey(vw, vh);
        }
        if (drag) cancelActiveDrag(modalState.reason || 'modal-open');
        hiddenByModal = shouldBlock;
        hiddenReason = modalState.reason;
        if (orbEl) {
          orbEl.hidden = true;
          orbEl.setAttribute?.('data-orb-modal-hidden', shouldBlock ? 'true' : 'false');
          if (orbEl.style) {
            orbEl.style.display = 'none';
            orbEl.style.pointerEvents = 'none';
          }
        }
        if (typeof deps.onCloseRadialMenu === 'function') {
          deps.onCloseRadialMenu(true);
        }
        return { visible: false, reason: hiddenReason, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
      }

      const wasHiddenByModal = hiddenByModal;
      hiddenByModal = false;
      hiddenReason = null;

      if (orbEl) {
        orbEl.hidden = false;
        orbEl.removeAttribute?.('data-orb-modal-hidden');
        if (orbEl.style) {
          orbEl.style.display = '';
          orbEl.style.pointerEvents = 'auto';
        }
      }

      if (drag && drag.moved) {
        return { visible: true, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
      }

      const curVpKey = buildViewportKey(vw, vh);
      const blockerSig = typeof deps.getBlockerSignature === 'function' ? String(deps.getBlockerSignature() || '') : '';
      const nextLayoutSig = `${curVpKey}|${blockerSig}|${userAnchor.x},${userAnchor.y}`;

      if (wasHiddenByModal && preModalDisplayPos && preModalViewportKey === curVpKey && !opts.forceRecompute) {
        // 模态关闭且工作区布局未变：稳定恢复到打开前的同一显示坐标
        writePositionToDom(preModalDisplayPos);
        preModalDisplayPos = null;
        lastLayoutSig = nextLayoutSig;
        return { visible: true, restoredPreModal: true, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
      }
      preModalDisplayPos = null;

      // 视口与阻挡物都未变化时，禁止自动更新造成圆球跳位或回弹
      if (!opts.forceRecompute && lastLayoutSig && nextLayoutSig === lastLayoutSig) {
        return { visible: true, skippedUnchanged: true, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
      }

      const avoided = computeAvoided(userAnchor, vw, vh);
      writePositionToDom(avoided);
      lastLayoutSig = nextLayoutSig;
      return { visible: true, displayPos: { ...displayPos }, userAnchor: { ...userAnchor } };
    }

    function onPointerDown(ev) {
      if (disposed || !orbEl || hiddenByModal) return;
      if (ev?.button != null && ev.button !== 0) return;
      const modalState = detectBlockingHostModal(doc, {
        hostSettingsModalOpen: Boolean(deps.isHostSettingsModalOpen?.()),
        marketplaceActive: Boolean(deps.isMarketplaceActive?.()),
        insightsPageActive: Boolean(deps.isInsightsPageActive?.()),
        profileHomeActive: Boolean(deps.isProfileHomeActive?.()),
        fullPageActive: Boolean(deps.isFullPageActive?.())
      });
      if (modalState.blocked) {
        syncVisibilityAndPosition();
        return;
      }

      const { width: vw, height: vh } = getViewport();
      // 关键修法：从圆球当前真实可见位置（而非原始 userAnchor）开始拖动，彻底消除首帧跳变
      const startDisplayPos = readVisiblePositionFromDom(vw, vh);
      const clientX = Number(ev?.clientX ?? 0);
      const clientY = Number(ev?.clientY ?? 0);

      drag = {
        pointerId: ev?.pointerId ?? null,
        startClientX: clientX,
        startClientY: clientY,
        grabOffsetX: clientX - startDisplayPos.x,
        grabOffsetY: clientY - startDisplayPos.y,
        startDisplayPos,
        moved: false,
        currentPos: { ...startDisplayPos },
        trace: {
          pointerDownClient: { x: clientX, y: clientY },
          startDisplayPos: { ...startDisplayPos },
          startAnchor: { ...userAnchor },
          firstMovePos: null,
          dropPos: null
        }
      };

      orbEl.classList?.add?.('is-pressing');
      if (drag.pointerId != null && typeof orbEl.setPointerCapture === 'function') {
        try { orbEl.setPointerCapture(drag.pointerId); } catch { }
      }
    }

    function onPointerMove(ev) {
      if (disposed || !drag) return;
      if (drag.pointerId != null && ev?.pointerId != null && ev.pointerId !== drag.pointerId) return;
      const cx = Number(ev?.clientX ?? 0);
      const cy = Number(ev?.clientY ?? 0);
      const dx = cx - drag.startClientX;
      const dy = cy - drag.startClientY;

      if (!drag.moved && Math.hypot(dx, dy) > dragThresholdPx) {
        drag.moved = true;
        orbEl?.classList?.add?.('is-dragging');
        if (typeof deps.onCloseRadialMenu === 'function') deps.onCloseRadialMenu(true);
      }

      if (drag.moved) {
        const { width: vw, height: vh } = getViewport();
        // 保持指针抓取偏移，连续跟手零跳变
        const nextPos = clampOrbCoord(
          { x: cx - drag.grabOffsetX, y: cy - drag.grabOffsetY },
          vw,
          vh,
          orbSize
        );
        if (!drag.trace.firstMovePos) drag.trace.firstMovePos = { ...nextPos };
        drag.currentPos = nextPos;
        writePositionToDom(nextPos);
      }
    }

    function onPointerUp(ev) {
      if (disposed || !drag) return;
      if (drag.pointerId != null && ev?.pointerId != null && ev.pointerId !== drag.pointerId) return;
      const snap = drag;
      drag = null;
      if (orbEl) {
        orbEl.classList?.remove?.('is-pressing', 'is-dragging');
        if (snap.pointerId != null && typeof orbEl.releasePointerCapture === 'function') {
          try { orbEl.releasePointerCapture(snap.pointerId); } catch { }
        }
      }
      if (snap.moved) {
        suppressNextClick = true;
        userAnchor = { ...snap.currentPos };
        writePositionToDom(userAnchor);
        const { width: vw, height: vh } = getViewport();
        const blockerSig = typeof deps.getBlockerSignature === 'function' ? String(deps.getBlockerSignature() || '') : '';
        lastLayoutSig = `${buildViewportKey(vw, vh)}|${blockerSig}|${userAnchor.x},${userAnchor.y}`;
        lastDragTrace = {
          ...snap.trace,
          cancelled: false,
          dropPos: { ...userAnchor },
          savedAnchor: { ...userAnchor }
        };
        if (typeof deps.onPersistAnchor === 'function') {
          deps.onPersistAnchor({ ...userAnchor });
        }
      }
    }

    function onPointerCancel() {
      cancelActiveDrag('pointercancel');
    }

    function onWindowBlur() {
      cancelActiveDrag('blur');
    }

    function onKeyDown(ev) {
      if (ev?.key === 'Escape' && drag) {
        cancelActiveDrag('escape');
      }
    }

    function onOrbClick(ev) {
      ev?.stopPropagation?.();
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (hiddenByModal) return;
      if (typeof deps.onOrbClick === 'function') deps.onOrbClick(ev);
    }

    function attach(element) {
      if (disposed || !element) return;
      detach();
      orbEl = element;
      orbEl.addEventListener('pointerdown', onPointerDown);
      orbEl.addEventListener('click', onOrbClick);
      win?.addEventListener?.('pointermove', onPointerMove);
      win?.addEventListener?.('pointerup', onPointerUp);
      win?.addEventListener?.('pointercancel', onPointerCancel);
      win?.addEventListener?.('blur', onWindowBlur);
      win?.addEventListener?.('keydown', onKeyDown, true);
      syncVisibilityAndPosition({ forceRecompute: true });
    }

    function detach() {
      if (drag) cancelActiveDrag('detach');
      if (orbEl) {
        orbEl.removeEventListener('pointerdown', onPointerDown);
        orbEl.removeEventListener('click', onOrbClick);
      }
      win?.removeEventListener?.('pointermove', onPointerMove);
      win?.removeEventListener?.('pointerup', onPointerUp);
      win?.removeEventListener?.('pointercancel', onPointerCancel);
      win?.removeEventListener?.('blur', onWindowBlur);
      win?.removeEventListener?.('keydown', onKeyDown, true);
      orbEl = null;
    }

    function setAnchorFromExternal(anchor, opts = {}) {
      // 拖动中或刚完成拖动期间，禁止旧配置回包覆盖用户锚点
      if (drag && drag.moved) return false;
      const { width: vw, height: vh } = getViewport();
      userAnchor = clampOrbCoord(anchor, vw, vh, orbSize);
      syncVisibilityAndPosition({ forceRecompute: Boolean(opts.forceRecompute) });
      return true;
    }

    function setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      syncVisibilityAndPosition({ forceRecompute: true });
    }

    function destroy() {
      disposed = true;
      detach();
    }

    return {
      attach,
      detach,
      syncVisibilityAndPosition,
      cancelActiveDrag,
      setAnchorFromExternal,
      setEnabled,
      getState: () => ({
        enabled,
        hiddenByModal,
        hiddenReason,
        isDragging: Boolean(drag?.moved),
        userAnchor: { ...userAnchor },
        displayPos: { ...displayPos },
        lastDragTrace: lastDragTrace ? { ...lastDragTrace } : null
      }),
      destroy
    };
  }

  const exported = {
    ORB_SIZE_PX,
    clampOrbCoord,
    detectBlockingHostModal,
    createOrbPositioningController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGOrbPositioning = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
