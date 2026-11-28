'use strict';
/**
 * 07 实时请求表紧凑排序下拉组件（替代 5 个常驻排序按钮）
 *
 * 规格要求：
 * - 将「时间、Token、费用、耗时、速度」五个常驻按钮收成一个紧凑排序下拉，新用户默认「时间 · 最新优先」
 * - 沿用现有排序键（time_desc / tokens_desc / cost_desc / duration_desc / speed_desc）、
 *   Token 聚合语义、进行中请求置顶、筛选与分页语义
 * - 速度排序对接 @data-lead 的端到端速度未舍入字段（endToEndTps / sortValue），缺可信起止或无有效输出排有效样本后，
 *   绝不拿短流式峰值兜底
 * - 完整键盘交互（ArrowDown/ArrowUp/Home/End/Enter/Space/Escape 归还焦点）、窄窗自适应、三语零括号、
 *   按住态仅轻微变深不变形
 */
(function (rootScope) {
  const REQ_SORT_STYLE_ID = 'ag-req-sort-dropdown-style';
  const DEFAULT_REQ_SORT_KEY = 'time_desc';

  const REQ_SORT_OPTIONS = Object.freeze([
    'time_desc',
    'tokens_desc',
    'cost_desc',
    'duration_desc',
    'speed_desc'
  ]);

  const REQ_SORT_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      triggerAria: '实时请求排序方式',
      listboxAria: '选择排序方式',
      prefix: '排序',
      speedColumnHeader: '端到端速度',
      options: Object.freeze({
        time_desc: '时间 · 最新优先',
        tokens_desc: 'Token · 总量优先',
        cost_desc: '费用 · 金额优先',
        duration_desc: '耗时 · 时长优先',
        speed_desc: '端到端速度 · 最快优先'
      }),
      shortLabels: Object.freeze({
        time_desc: '时间 · 最新优先',
        tokens_desc: 'Token · 总量优先',
        cost_desc: '费用 · 金额优先',
        duration_desc: '耗时 · 时长优先',
        speed_desc: '速度 · 端到端优先'
      })
    }),
    'zh-TW': Object.freeze({
      triggerAria: '即時請求排序方式',
      listboxAria: '選擇排序方式',
      prefix: '排序',
      speedColumnHeader: '端到端速度',
      options: Object.freeze({
        time_desc: '時間 · 最新優先',
        tokens_desc: 'Token · 總量優先',
        cost_desc: '費用 · 金額優先',
        duration_desc: '耗時 · 時長優先',
        speed_desc: '端到端速度 · 最快優先'
      }),
      shortLabels: Object.freeze({
        time_desc: '時間 · 最新優先',
        tokens_desc: 'Token · 總量優先',
        cost_desc: '費用 · 金額優先',
        duration_desc: '耗時 · 時長優先',
        speed_desc: '速度 · 端到端優先'
      })
    }),
    en: Object.freeze({
      triggerAria: 'Sort live requests',
      listboxAria: 'Choose sort order',
      prefix: 'Sort',
      speedColumnHeader: 'End to End Speed',
      options: Object.freeze({
        time_desc: 'Time · Newest first',
        tokens_desc: 'Tokens · Highest first',
        cost_desc: 'Cost · Highest first',
        duration_desc: 'Duration · Longest first',
        speed_desc: 'End to End Speed · Fastest first'
      }),
      shortLabels: Object.freeze({
        time_desc: 'Time · Newest first',
        tokens_desc: 'Tokens · Highest',
        cost_desc: 'Cost · Highest',
        duration_desc: 'Duration · Longest',
        speed_desc: 'Speed · End to End'
      })
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  function getReqSortCopy(lang) {
    return REQ_SORT_I18N[resolveLang(lang)] || REQ_SORT_I18N['zh-CN'];
  }

  function normalizeReqSortKey(key) {
    const k = String(key || '').trim();
    return REQ_SORT_OPTIONS.includes(k) ? k : DEFAULT_REQ_SORT_KEY;
  }

  const REQ_SORT_CSS = `
    .ag-req-sort-dd {
      position: relative;
      display: inline-flex;
      align-items: center;
      font-family: inherit;
      max-width: 100%;
    }
    .ag-req-sort-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      max-width: 196px;
      padding: 0 9px;
      border-radius: 7px;
      border: 1px solid var(--ag-border-card, rgba(255, 255, 255, 0.12));
      background: var(--ag-btn-bg, rgba(255, 255, 255, 0.05));
      color: var(--ag-text-primary, #ececef);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      outline: none;
      transform: none !important;
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .ag-req-sort-trigger:hover {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.10));
      border-color: var(--ag-border-strong, rgba(255, 255, 255, 0.22));
    }
    .ag-req-sort-trigger:active {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.16));
      transform: none !important;
    }
    .ag-req-sort-trigger:focus-visible {
      box-shadow: 0 0 0 2px var(--ag-focus-ring, rgba(120, 140, 255, 0.7));
    }
    .ag-req-sort-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ag-req-sort-caret {
      width: 11px;
      height: 11px;
      flex: 0 0 11px;
      opacity: 0.72;
      transition: transform 140ms ease;
    }
    .ag-req-sort-trigger[aria-expanded="true"] .ag-req-sort-caret {
      transform: rotate(180deg);
    }
    .ag-req-sort-menu {
      position: absolute;
      top: calc(100% + 5px);
      right: 0;
      min-width: 176px;
      padding: 4px;
      border-radius: 10px;
      border: 1px solid var(--ag-border-card, rgba(255, 255, 255, 0.14));
      background: var(--ag-bg-card, #1c1c20);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
      z-index: 80;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ag-req-sort-menu[hidden] {
      display: none !important;
    }
    .ag-req-sort-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-height: 28px;
      padding: 4px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--ag-text-secondary, #c8c8d0);
      font-family: inherit;
      font-size: 12px;
      font-weight: 450;
      text-align: left;
      cursor: pointer;
      outline: none;
      transform: none !important;
      transition: background-color 110ms ease, color 110ms ease;
    }
    .ag-req-sort-option:hover,
    .ag-req-sort-option.is-highlighted {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.08));
      color: var(--ag-text-primary, #ffffff);
    }
    .ag-req-sort-option:active {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.14));
      transform: none !important;
    }
    .ag-req-sort-option[aria-selected="true"] {
      color: var(--ag-text-primary, #ffffff);
      font-weight: 500;
    }
    .ag-req-sort-check {
      width: 12px;
      height: 12px;
      flex: 0 0 12px;
      opacity: 0;
    }
    .ag-req-sort-option[aria-selected="true"] .ag-req-sort-check {
      opacity: 1;
    }
    [data-theme="light"] .ag-req-sort-trigger {
      border-color: rgba(24, 24, 27, 0.14);
      background: #ffffff;
      color: #18181b;
    }
    [data-theme="light"] .ag-req-sort-menu {
      border-color: rgba(24, 24, 27, 0.14);
      background: #ffffff;
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
    }
    [data-theme="light"] .ag-req-sort-option {
      color: #3f3f46;
    }
    [data-theme="light"] .ag-req-sort-option:hover,
    [data-theme="light"] .ag-req-sort-option.is-highlighted,
    [data-theme="light"] .ag-req-sort-option[aria-selected="true"] {
      background: rgba(24, 24, 27, 0.06);
      color: #18181b;
    }
    @media (prefers-reduced-motion: reduce) {
      .ag-req-sort-trigger,
      .ag-req-sort-caret,
      .ag-req-sort-option {
        transition: none !important;
      }
    }
  `;

  /**
   * 端到端速度未舍入排序值提取器（对接 @data-lead 契约）：
   * - 优先取 endToEndTps / e2eTps / resolveRequestRowSpeed(rec).e2eSortValue / sortValue（仅限端到端，不回退短流式峰值）
   * - 若无预计算字段且记录自带可信 dispatchAtMs/endAtMs 与 outputTokens > 0，则直接按未舍入秒数计算
   * - 无有效输出或缺可信起止时返回 null（排序时严格排在所有有效样本之后）
   */
  function resolveEndToEndSpeedSortValue(rec, externalResolver = null) {
    if (!rec || typeof rec !== 'object') return null;
    if (typeof externalResolver === 'function') {
      const info = externalResolver(rec);
      if (info && typeof info === 'object') {
        const v = info.e2eSortValue ?? info.endToEndTps ?? (info.speedKind === 'e2e' ? info.sortValue : null);
        if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
        if (info.hasValidE2e === false || info.unavailable === true) return null;
      }
    }
    const direct = rec.endToEndTps ?? rec.e2eTps ?? rec.e2eSpeedRaw;
    if (direct != null && Number.isFinite(Number(direct)) && Number(direct) > 0) {
      return Number(direct);
    }
    const outTok = Number(rec.outputTokens ?? rec.completionTokens ?? 0);
    if (!Number.isFinite(outTok) || outTok <= 0) return null;
    const rawSec = Number(rec.e2eDurationSec ?? rec.totalDurationSec ?? rec.durationSec);
    if (Number.isFinite(rawSec) && rawSec > 0) {
      return outTok / rawSec;
    }
    const startMs = Number(rec.dispatchedAtMs ?? rec.startedAtMs ?? 0);
    const endMs = Number(rec.completedAtMs ?? rec.finishedAtMs ?? 0);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      return outTok / ((endMs - startMs) / 1000);
    }
    return null;
  }

  /**
   * 实时请求表统一排序比较器：
   * - 进行中请求（status === 'streaming' | 'queued' | 'pending' | isInFlight）始终置顶
   * - speed_desc 严格采用未舍入端到端速度，缺样本/无效样本排在有效样本之后
   */
  function sortRequestRecords(records, sortBy = DEFAULT_REQ_SORT_KEY, opts = {}) {
    const list = Array.isArray(records) ? records.slice() : [];
    const key = normalizeReqSortKey(sortBy);
    const isInFlight = (r) => Boolean(r?.isInFlight || r?.status === 'streaming' || r?.status === 'queued' || r?.status === 'pending');
    const getTime = (r) => Number(r?.timestampMs ?? r?.timestamp ?? r?.startedAtMs ?? 0) || 0;
    const getTokens = (r) => {
      if (typeof opts.resolveTotalTokens === 'function') return Number(opts.resolveTotalTokens(r)) || 0;
      const tot = Number(r?.totalTokens);
      if (Number.isFinite(tot) && tot > 0) return tot;
      return Math.max(0, Number(r?.inputTokens || 0))
        + Math.max(0, Number(r?.outputTokens || 0))
        + Math.max(0, Number(r?.cacheReadTokens || 0))
        + Math.max(0, Number(r?.cacheCreationInputTokens || 0));
    };
    const getCost = (r) => Number(r?.costUsd ?? r?.estimatedCostUsd ?? 0) || 0;
    const getDuration = (r) => Number(r?.e2eDurationSec ?? r?.durationSec ?? r?.durationMs / 1000 ?? 0) || 0;

    list.sort((a, b) => {
      const fa = isInFlight(a) ? 1 : 0;
      const fb = isInFlight(b) ? 1 : 0;
      if (fa !== fb) return fb - fa;

      if (key === 'speed_desc') {
        const sa = resolveEndToEndSpeedSortValue(a, opts.resolveSpeed);
        const sb = resolveEndToEndSpeedSortValue(b, opts.resolveSpeed);
        const va = sa != null && Number.isFinite(sa) && sa > 0;
        const vb = sb != null && Number.isFinite(sb) && sb > 0;
        if (va !== vb) return va ? -1 : 1;
        if (va && vb && sa !== sb) return sb - sa;
        return getTime(b) - getTime(a);
      }
      if (key === 'tokens_desc') {
        const diff = getTokens(b) - getTokens(a);
        return diff !== 0 ? diff : getTime(b) - getTime(a);
      }
      if (key === 'cost_desc') {
        const diff = getCost(b) - getCost(a);
        return diff !== 0 ? diff : getTime(b) - getTime(a);
      }
      if (key === 'duration_desc') {
        const diff = getDuration(b) - getDuration(a);
        return diff !== 0 ? diff : getTime(b) - getTime(a);
      }
      return getTime(b) - getTime(a);
    });
    return list;
  }

  function createReqSortDropdownController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    let value = normalizeReqSortKey(deps.initialSort);
    let lang = resolveLang(deps.lang);
    let open = false;
    let highlightedIndex = REQ_SORT_OPTIONS.indexOf(value);
    let wrapEl = null;
    let triggerEl = null;
    let labelEl = null;
    let menuEl = null;
    let optionEls = [];
    let disposed = false;

    function ensureStyle(styleRoot) {
      if (!doc) return;
      const target = styleRoot && styleRoot.nodeType === 11 ? styleRoot : doc.head;
      if (!target) return;
      const exists = target.querySelector ? target.querySelector(`#${REQ_SORT_STYLE_ID}`) : doc.getElementById?.(REQ_SORT_STYLE_ID);
      if (exists) return;
      const st = doc.createElement('style');
      st.id = REQ_SORT_STYLE_ID;
      st.textContent = REQ_SORT_CSS;
      target.appendChild(st);
    }

    function syncDom() {
      if (!wrapEl || disposed) return;
      const copy = getReqSortCopy(lang);
      if (triggerEl) {
        triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        triggerEl.setAttribute('aria-label', `${copy.triggerAria} ${copy.options[value]}`);
        triggerEl.title = copy.options[value];
        triggerEl.setAttribute('data-req-sort-value', value);
      }
      if (labelEl) {
        labelEl.textContent = copy.shortLabels[value] || copy.options[value];
      }
      if (menuEl) {
        menuEl.hidden = !open;
        menuEl.setAttribute('aria-label', copy.listboxAria);
      }
      optionEls.forEach((optBtn, idx) => {
        const optKey = REQ_SORT_OPTIONS[idx];
        const selected = optKey === value;
        optBtn.setAttribute('aria-selected', selected ? 'true' : 'false');
        optBtn.classList?.toggle?.('is-highlighted', idx === highlightedIndex);
        const textNode = optBtn.querySelector('.ag-req-sort-opt-text');
        if (textNode) textNode.textContent = copy.options[optKey];
      });
    }

    function setOpen(nextOpen, restoreFocus = false) {
      const next = Boolean(nextOpen);
      if (open === next) return;
      open = next;
      if (open) {
        highlightedIndex = Math.max(0, REQ_SORT_OPTIONS.indexOf(value));
      }
      syncDom();
      if (!open && restoreFocus) {
        triggerEl?.focus?.();
      }
    }

    function selectValue(nextKey, { emit = true, closeAfter = true } = {}) {
      const normalized = normalizeReqSortKey(nextKey);
      const changed = normalized !== value;
      value = normalized;
      highlightedIndex = REQ_SORT_OPTIONS.indexOf(value);
      if (closeAfter) open = false;
      syncDom();
      if (emit && changed && typeof deps.onChange === 'function') {
        deps.onChange(value);
      }
      return value;
    }

    function onTriggerKeyDown(ev) {
      if (disposed) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault?.();
        if (!open) {
          setOpen(true);
        } else {
          const dir = ev.key === 'ArrowDown' ? 1 : -1;
          highlightedIndex = (highlightedIndex + dir + REQ_SORT_OPTIONS.length) % REQ_SORT_OPTIONS.length;
          syncDom();
        }
      } else if (ev.key === 'Home' && open) {
        ev.preventDefault?.();
        highlightedIndex = 0;
        syncDom();
      } else if (ev.key === 'End' && open) {
        ev.preventDefault?.();
        highlightedIndex = REQ_SORT_OPTIONS.length - 1;
        syncDom();
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault?.();
        if (!open) {
          setOpen(true);
        } else {
          selectValue(REQ_SORT_OPTIONS[highlightedIndex], { emit: true, closeAfter: true });
          triggerEl?.focus?.();
        }
      } else if (ev.key === 'Escape' && open) {
        ev.preventDefault?.();
        setOpen(false, true);
      }
    }

    function onDocumentPointerDown(ev) {
      if (!open || !wrapEl) return;
      const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : [];
      if (path.length ? !path.includes(wrapEl) : !wrapEl.contains?.(ev?.target)) {
        setOpen(false, false);
      }
    }

    function createIconSvg(kind) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 14 14');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.6');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const p = doc.createElementNS(NS, 'path');
      if (kind === 'caret') {
        svg.setAttribute('class', 'ag-req-sort-caret');
        p.setAttribute('d', 'M3.5 5.5L7 9L10.5 5.5');
      } else {
        svg.setAttribute('class', 'ag-req-sort-check');
        p.setAttribute('d', 'M3 7.2L5.8 10L11 4.2');
      }
      svg.appendChild(p);
      return svg;
    }

    function mount(container, styleRoot = null) {
      if (disposed || !doc || !container) return null;
      unmount();
      ensureStyle(styleRoot || (container.getRootNode ? container.getRootNode() : null));

      const copy = getReqSortCopy(lang);
      wrapEl = doc.createElement('div');
      wrapEl.id = 'req-sort-dropdown';
      wrapEl.className = 'ag-req-sort-dd';

      triggerEl = doc.createElement('button');
      triggerEl.id = 'btn-req-sort-trigger';
      triggerEl.type = 'button';
      triggerEl.className = 'ag-req-sort-trigger';
      triggerEl.setAttribute('aria-haspopup', 'listbox');
      triggerEl.setAttribute('aria-controls', 'req-sort-menu');

      labelEl = doc.createElement('span');
      labelEl.className = 'ag-req-sort-label';
      triggerEl.appendChild(labelEl);
      triggerEl.appendChild(createIconSvg('caret'));

      menuEl = doc.createElement('div');
      menuEl.id = 'req-sort-menu';
      menuEl.className = 'ag-req-sort-menu';
      menuEl.setAttribute('role', 'listbox');
      menuEl.hidden = true;

      optionEls = REQ_SORT_OPTIONS.map((optKey, idx) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-req-sort-option';
        btn.setAttribute('role', 'option');
        btn.setAttribute('data-req-sort', optKey);
        const txt = doc.createElement('span');
        txt.className = 'ag-req-sort-opt-text';
        txt.textContent = copy.options[optKey];
        btn.appendChild(txt);
        btn.appendChild(createIconSvg('check'));
        btn.addEventListener('pointerenter', () => {
          highlightedIndex = idx;
          syncDom();
        });
        btn.addEventListener('click', () => {
          selectValue(optKey, { emit: true, closeAfter: true });
          triggerEl?.focus?.();
        });
        menuEl.appendChild(btn);
        return btn;
      });

      triggerEl.addEventListener('click', () => setOpen(!open, false));
      triggerEl.addEventListener('keydown', onTriggerKeyDown);
      menuEl.addEventListener('keydown', onTriggerKeyDown);
      doc.addEventListener?.('pointerdown', onDocumentPointerDown, true);

      wrapEl.appendChild(triggerEl);
      wrapEl.appendChild(menuEl);
      container.appendChild(wrapEl);
      syncDom();
      return wrapEl;
    }

    function setLang(nextLang) {
      lang = resolveLang(nextLang);
      syncDom();
    }

    function unmount() {
      doc?.removeEventListener?.('pointerdown', onDocumentPointerDown, true);
      if (wrapEl) try { wrapEl.remove?.(); } catch { }
      wrapEl = null;
      triggerEl = null;
      labelEl = null;
      menuEl = null;
      optionEls = [];
      open = false;
    }

    function destroy() {
      disposed = true;
      unmount();
    }

    return {
      mount,
      selectValue,
      setOpen,
      setLang,
      getState: () => ({ value, open, highlightedIndex, lang }),
      unmount,
      destroy
    };
  }

  const exported = {
    REQ_SORT_STYLE_ID,
    DEFAULT_REQ_SORT_KEY,
    REQ_SORT_OPTIONS,
    REQ_SORT_I18N,
    REQ_SORT_CSS,
    getReqSortCopy,
    normalizeReqSortKey,
    resolveEndToEndSpeedSortValue,
    sortRequestRecords,
    createReqSortDropdownController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGReqSortDropdown = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
