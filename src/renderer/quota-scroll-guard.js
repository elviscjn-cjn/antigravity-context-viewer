(function (root) {
  'use strict';

  /**
   * PR #83 / #82 额度看板多层滚动锚点与用户意图保护控制器
   * - 覆盖内层 view-quota、panel-quota 以及外层实际宿主滚动容器
   * - 防止宿主快照刷新、后台用量迟到重绘与关闭重开抢回用户滚动位置
   * - 支持内容缩短时安全夹紧、滚底跨多轮保持底部锚定与用户滚轮/键盘/拖拽立即取消恢复定时器
   */
  const DEFAULT_RESTORE_STEPS_MS = Object.freeze([0, 120, 400, 1200, 2200]);
  const DEFAULT_USER_INTENT_GRACE_MS = 350;
  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']);

  function clampScrollTop(node, desiredTop) {
    const raw = Math.max(0, Number(desiredTop) || 0);
    const sh = Number(node?.scrollHeight);
    const ch = Number(node?.clientHeight);
    if (Number.isFinite(sh) && Number.isFinite(ch) && sh > 0 && ch > 0) {
      return Math.min(raw, Math.max(0, sh - ch));
    }
    return raw;
  }

  function isAtBottom(node, thresholdPx = 12) {
    if (!node) return false;
    const sh = Number(node.scrollHeight);
    const ch = Number(node.clientHeight);
    const st = Number(node.scrollTop);
    if (!Number.isFinite(sh) || !Number.isFinite(ch) || !Number.isFinite(st) || sh <= ch) return false;
    return (sh - ch - st) <= thresholdPx;
  }

  function createQuotaScrollGuard(options = {}) {
    const resolveContainers = typeof options.resolveContainers === 'function'
      ? options.resolveContainers
      : () => [];
    const isPanelVisible = typeof options.isPanelVisible === 'function'
      ? options.isPanelVisible
      : () => true;
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    const restoreStepsMs = Array.isArray(options.restoreStepsMs) && options.restoreStepsMs.length
      ? options.restoreStepsMs.slice()
      : DEFAULT_RESTORE_STEPS_MS;
    const userIntentGraceMs = Number.isFinite(Number(options.userIntentGraceMs))
      ? Math.max(50, Number(options.userIntentGraceMs))
      : DEFAULT_USER_INTENT_GRACE_MS;

    const anchorsById = new Map();
    const boundNodes = new WeakSet();
    let restoreTimers = [];
    let userIntentAtMs = 0;
    let programmatic = false;
    let disposed = false;
    let roundLogs = [];

    function clearTimers() {
      for (const tid of restoreTimers) {
        try { clearTimer(tid); } catch { }
      }
      restoreTimers = [];
    }

    function cancelRestore() {
      if (!restoreTimers.length) return false;
      clearTimers();
      return true;
    }

    function recordAnchorForNode(id, node) {
      if (!id || !node || typeof node.scrollTop !== 'number') return;
      anchorsById.set(id, {
        scrollTop: Math.max(0, Number(node.scrollTop) || 0),
        stickBottom: isAtBottom(node),
        scrollHeight: Number(node.scrollHeight) || 0,
        clientHeight: Number(node.clientHeight) || 0,
        recordedAtMs: nowFn()
      });
    }

    function bindContainers() {
      const list = resolveContainers() || [];
      for (const item of list) {
        if (!item || !item.node || !item.id || boundNodes.has(item.node)) continue;
        const { id, node } = item;
        if (typeof node.addEventListener !== 'function') continue;
        boundNodes.add(node);

        const onUserGesture = () => {
          userIntentAtMs = nowFn();
          cancelRestore();
          recordAnchorForNode(id, node);
        };
        for (const evt of ['wheel', 'touchstart', 'mousedown', 'pointerdown']) {
          node.addEventListener(evt, onUserGesture, { passive: true });
        }
        node.addEventListener('scroll', () => {
          if (programmatic) return;
          userIntentAtMs = nowFn();
          cancelRestore();
          recordAnchorForNode(id, node);
        }, { passive: true });
        node.addEventListener('keydown', (ev) => {
          if (ev && SCROLL_KEYS.has(ev.key)) {
            onUserGesture();
          }
        });
      }
    }

    function captureSnapshot() {
      bindContainers();
      const captured = [];
      const list = resolveContainers() || [];
      for (const item of list) {
        if (!item || !item.node || !item.id) continue;
        if (typeof item.node.scrollTop !== 'number') continue;
        const prev = anchorsById.get(item.id) || null;
        const curTop = Math.max(0, Number(item.node.scrollTop) || 0);
        // 若容器刚在重绘中被重置为 0 但先前有非零锚点且非用户主动归顶，则保留先前锚点
        const preservePrev = curTop === 0 && prev && prev.scrollTop > 0 && (nowFn() - userIntentAtMs) >= userIntentGraceMs;
        const effectiveTop = preservePrev ? prev.scrollTop : curTop;
        const stickBottom = preservePrev ? Boolean(prev.stickBottom) : isAtBottom(item.node);
        anchorsById.set(item.id, {
          scrollTop: effectiveTop,
          stickBottom,
          scrollHeight: Number(item.node.scrollHeight) || 0,
          clientHeight: Number(item.node.clientHeight) || 0,
          recordedAtMs: nowFn()
        });
        captured.push({ id: item.id, node: item.node, scrollTop: effectiveTop, stickBottom });
      }
      return captured;
    }

    function applyRestoreOnce(entries, reason = 'redraw') {
      if (disposed || !isPanelVisible()) return { applied: false, skippedReason: 'hidden_or_disposed' };
      const elapsedSinceIntent = nowFn() - userIntentAtMs;
      if (userIntentAtMs > 0 && elapsedSinceIntent < userIntentGraceMs) {
        return { applied: false, skippedReason: 'user_intent_active' };
      }

      const targets = Array.isArray(entries) && entries.length
        ? entries
        : (resolveContainers() || [])
            .filter(item => item && item.node && item.id && anchorsById.has(item.id))
            .map(item => ({ id: item.id, node: item.node, ...anchorsById.get(item.id) }));

      const appliedList = [];
      programmatic = true;
      try {
        for (const t of targets) {
          if (!t || !t.node || typeof t.node.scrollTop !== 'number') continue;
          const desired = t.stickBottom && Number(t.node.scrollHeight) > Number(t.node.clientHeight)
            ? Math.max(0, Number(t.node.scrollHeight) - Number(t.node.clientHeight))
            : t.scrollTop;
          const clamped = clampScrollTop(t.node, desired);
          if (Math.abs(Number(t.node.scrollTop) - clamped) > 1) {
            t.node.scrollTop = clamped;
          }
          appliedList.push({ id: t.id, scrollTop: Number(t.node.scrollTop), desired: clamped, stickBottom: Boolean(t.stickBottom) });
        }
      } finally {
        programmatic = false;
      }

      roundLogs.push({ atMs: nowFn(), reason, targets: appliedList });
      if (roundLogs.length > 40) roundLogs.shift();
      return { applied: true, targets: appliedList };
    }

    function armRestoreAfterRedraw(entries = null, reason = 'redraw') {
      clearTimers();
      if (disposed || !isPanelVisible()) return;
      const snap = Array.isArray(entries) ? entries : captureSnapshot();
      if (!snap.length) return;
      for (const delay of restoreStepsMs) {
        if (delay === 0) {
          applyRestoreOnce(snap, `${reason}:immediate`);
        } else {
          const tid = setTimer(() => {
            applyRestoreOnce(snap, `${reason}:t${delay}`);
          }, delay);
          restoreTimers.push(tid);
        }
      }
    }

    function restoreOnReopen() {
      bindContainers();
      armRestoreAfterRedraw(null, 'reopen');
    }

    function getState() {
      const anchors = {};
      for (const [k, v] of anchorsById.entries()) anchors[k] = { ...v };
      return {
        anchors,
        activeTimerCount: restoreTimers.length,
        userIntentAtMs,
        roundLogs: roundLogs.slice()
      };
    }

    function destroy() {
      disposed = true;
      clearTimers();
    }

    return {
      bindContainers,
      captureSnapshot,
      applyRestoreOnce,
      armRestoreAfterRedraw,
      restoreOnReopen,
      cancelRestore,
      getState,
      destroy
    };
  }

  const exportsObj = {
    DEFAULT_RESTORE_STEPS_MS,
    clampScrollTop,
    isAtBottom,
    createQuotaScrollGuard
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
  }
  if (root && typeof root === 'object') {
    root.__AGQuotaScrollGuard = exportsObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
