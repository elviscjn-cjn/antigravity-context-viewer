'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const accountsMod = require('./meter-accounts');
const mainMod = require('./meter-main');

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const TPL_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');

/**
 * 构建带真实 Antigravity 宿主设置 DOM 与 Shadow DOM 支持的轻量渲染器测试夹具。
 */
function createBatch01Harness(options = {}) {
  const shadowElements = new Map();
  const docElements = new Map();
  const docListeners = new Map();
  const bodyChildren = [];
  const headChildren = [];
  const savedSettingsPayloads = [];
  const accountsActionCalls = [];
  const overviewQueue = [...(options.overviewQueue || [])];
  let activeOverview = options.initialOverview || null;
  let storedSettings = {
    ok: true,
    uiPreferences: {
      panelLanguage: 'zh-CN',
      themeMode: 'dark',
      allowBetaUpdates: false,
      nextPromptEnabled: false,
      ...(options.initialUiPrefs || {})
    }
  };

  function makeNode(tag = 'div') {
    const attrs = new Map();
    const listeners = new Map();
    const styleProps = new Map();
    let _innerHtml = '';
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      parentElement: null,
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      title: '',
      tabIndex: 0,
      scrollTop: 0,
      isConnected: true,
      shadowRoot: null,
      style: {
        display: '',
        visibility: '',
        left: '',
        top: '',
        right: '',
        bottom: '',
        opacity: '',
        pointerEvents: '',
        width: '',
        height: '',
        setProperty(k, v) {
          styleProps.set(k, String(v));
          if (k === 'display') this.display = String(v);
        },
        removeProperty(k) {
          styleProps.delete(k);
          if (k === 'display') this.display = '';
        },
        getPropertyValue(k) {
          if (styleProps.has(k)) return styleProps.get(k);
          return k === 'display' ? this.display : '';
        }
      },
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && docElements.get(prev) === node) docElements.delete(prev);
        attrs.set('id', String(v || ''));
        if (v) docElements.set(String(v), node);
      },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(...cs) {
          const list = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          for (const c of cs) if (c && !list.includes(c)) list.push(c);
          attrs.set('class', list.join(' '));
        },
        remove(...cs) {
          const list = (attrs.get('class') || '').split(/\s+/).filter((x) => x && !cs.includes(x));
          attrs.set('class', list.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        },
        toggle(c, force) {
          const has = this.contains(c);
          const next = force !== undefined ? Boolean(force) : !has;
          if (next) this.add(c);
          else this.remove(c);
          return next;
        }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), node);
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        if (k === 'id') {
          const prev = attrs.get('id');
          if (prev && docElements.get(prev) === node) docElements.delete(prev);
        }
        attrs.delete(k);
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentElement && typeof child.remove === 'function') child.remove();
        child.parentElement = node;
        child.isConnected = true;
        node.children.push(child);
        if (child.id && (node.getRootNode?.() === shadowRoot || node._inShadow)) {
          shadowElements.set(child.id, child);
        }
        return child;
      },
      prepend(...items) {
        for (let i = items.length - 1; i >= 0; i--) {
          const child = items[i];
          if (!child) continue;
          if (child.parentElement && typeof child.remove === 'function') child.remove();
          child.parentElement = node;
          child.isConnected = true;
          node.children.unshift(child);
        }
      },
      after(...items) {
        if (!node.parentElement) return;
        for (const it of items) {
          if (!it) continue;
          if (it.parentElement && typeof it.remove === 'function') it.remove();
          const idx = node.parentElement.children.indexOf(node);
          it.parentElement = node.parentElement;
          it.isConnected = true;
          node.parentElement.children.splice(idx + 1, 0, it);
        }
      },
      remove() {
        if (node.parentElement && Array.isArray(node.parentElement.children)) {
          const idx = node.parentElement.children.indexOf(node);
          if (idx >= 0) node.parentElement.children.splice(idx, 1);
        }
        node.parentElement = null;
        node.isConnected = false;
      },
      replaceChildren(...items) {
        node.children = [];
        for (const it of items) if (it && typeof it !== 'string') node.appendChild(it);
      },
      contains(target) {
        if (!target) return false;
        if (target === node) return true;
        return node.children.some((c) => c === target || c.contains?.(target));
      },
      closest(sel) {
        let cur = node;
        while (cur) {
          if (matchesSel(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of (n.children || [])) {
            if (matchesSel(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(node);
        return out;
      },
      querySelector(sel) {
        return node.querySelectorAll(sel)[0] || null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatchEvent(ev = {}) {
        const evt = typeof ev === 'string' ? { type: ev } : { ...ev };
        if (!evt.target) evt.target = node;
        if (!evt.currentTarget) evt.currentTarget = node;
        if (!evt.preventDefault) evt.preventDefault = () => { };
        if (!evt.stopPropagation) evt.stopPropagation = () => { };
        let cur = node;
        while (cur) {
          const fns = cur._listenersMap?.get(evt.type) || [];
          for (const fn of [...fns]) fn(evt);
          cur = cur.parentElement;
        }
      },
      click() {
        node.dispatchEvent({ type: 'click', target: node });
      },
      trigger(type, extra = {}) {
        node.dispatchEvent({ type, target: node, ...extra });
      },
      focus() { },
      scrollIntoView() { },
      attachShadow() {
        const sr = makeNode('shadow-root');
        sr.host = node;
        sr.getElementById = (id) => {
          const found = findById(sr, id);
          return found || null;
        };
        node.shadowRoot = sr;
        return sr;
      },
      getRootNode() {
        let cur = node;
        while (cur.parentElement) cur = cur.parentElement;
        return cur;
      },
      get firstElementChild() {
        return Array.isArray(node.children) && node.children.length > 0 ? node.children[0] : null;
      },
      get nextElementSibling() {
        if (!node.parentElement || !Array.isArray(node.parentElement.children)) return null;
        const idx = node.parentElement.children.indexOf(node);
        return idx >= 0 && idx + 1 < node.parentElement.children.length ? node.parentElement.children[idx + 1] : null;
      },
      get previousElementSibling() {
        if (!node.parentElement || !Array.isArray(node.parentElement.children)) return null;
        const idx = node.parentElement.children.indexOf(node);
        return idx > 0 ? node.parentElement.children[idx - 1] : null;
      },
      get innerHTML() { return _innerHtml; },
      set innerHTML(val) {
        _innerHtml = String(val || '');
        if (!val) {
          node.children = [];
        } else if (/<[a-z0-9-][^>]*\bid="/i.test(_innerHtml)) {
          node.children = [];
          let nsRoot = null;
          for (const m of _innerHtml.matchAll(/<(section|button|div|span|h1|h2|p|input|select|label|header)\b([^>]*)>/gi)) {
            const rawAttrs = m[2] || '';
            const idMatch = rawAttrs.match(/\bid="([^"]+)"/i);
            const hasNsAttr = /\bdata-ag-ns-(seg|switch|select|input|action|color)\b/i.test(rawAttrs);
            if (!idMatch && !hasNsAttr) continue;
            const sub = makeNode(m[1]);
            if (idMatch) sub.id = idMatch[1];
            for (const am of rawAttrs.matchAll(/\b(data-[a-z0-9-]+|role|type|aria-[a-z-]+)="([^"]*)"/gi)) {
              sub.setAttribute(am[1], am[2]);
            }
            if (sub.id === 'ag-ns-root') {
              nsRoot = sub;
              node.appendChild(sub);
            } else if (nsRoot) {
              nsRoot.appendChild(sub);
            } else {
              node.appendChild(sub);
            }
          }
        }
      },
      getBoundingClientRect() {
        return { left: 20, top: 20, width: 320, height: 48, right: 340, bottom: 68 };
      },
      _listenersMap: listeners
    };
    return node;
  }

  function findById(root, id) {
    if (!root || !id) return null;
    for (const c of (root.children || [])) {
      if (c.id === id) return c;
      const deep = findById(c, id);
      if (deep) return deep;
    }
    return null;
  }

  function matchesSel(node, sel) {
    if (!node || !sel) return false;
    const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (p === '.relative.flex.w-full.h-full') {
        if (node.classList?.contains('relative') && node.classList?.contains('flex') && node.classList?.contains('w-full') && node.classList?.contains('h-full')) return true;
        continue;
      }
      if (p === '[data-testid="settings-sidebar"]') {
        if (node.getAttribute?.('data-testid') === 'settings-sidebar') return true;
        continue;
      }
      if (p === '[data-settings-content-pane="true"]') {
        if (node.getAttribute?.('data-settings-content-pane') === 'true') return true;
        continue;
      }
      if (p === '[role="dialog"]') {
        if (node.getAttribute?.('role') === 'dialog') return true;
        continue;
      }
      if (p === '[role="tab"]') {
        if (node.getAttribute?.('role') === 'tab') return true;
        continue;
      }
      if (p === 'button[id^="settings-nav-item-"]') {
        if (node.tagName === 'BUTTON' && String(node.id || '').startsWith('settings-nav-item-')) return true;
        continue;
      }
      if (p === 'button[data-testid^="settings-nav-item-"]') {
        if (node.tagName === 'BUTTON' && String(node.getAttribute?.('data-testid') || '').startsWith('settings-nav-item-')) return true;
        continue;
      }
      const attrOnly = p.match(/^\[([a-z0-9-]+)\]$/i);
      if (attrOnly) {
        if (node.hasAttribute?.(attrOnly[1])) return true;
        continue;
      }
      const attrEq = p.match(/^\[([a-z0-9-]+)="([^"]*)"\]$/i);
      if (attrEq) {
        if (node.getAttribute?.(attrEq[1]) === attrEq[2]) return true;
        continue;
      }
      if (p.startsWith('#') && node.id === p.slice(1)) return true;
      if (p.startsWith('.') && node.classList?.contains(p.slice(1))) return true;
      if (p === 'button' && node.tagName === 'BUTTON') return true;
    }
    return false;
  }

  // 解析真实 template.html 的结构树，确保测试针对真实控件 ID 与关系运行
  const shadowRoot = makeNode('shadow-root');
  function buildTemplateTreeIntoShadow() {
    const bodyBtnCloseRe = /<([a-z0-9-]+)([^>]*?)\b(id="([^"]+)"[^>]*)?>/gi;
    const ensureEl = (id, tag = 'div', attrs = {}) => {
      if (shadowElements.has(id)) return shadowElements.get(id);
      const n = makeNode(tag);
      n.id = id;
      n._inShadow = true;
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k === 'hidden') n.hidden = Boolean(v);
        else n.setAttribute(k, v);
      }
      shadowElements.set(id, n);
      shadowRoot.appendChild(n);
      return n;
    };

    // 从 template.html 提取所有 id 建立兜底节点
    for (const m of TPL_SOURCE.matchAll(/<([a-z0-9-]+)([^>]*?)\bid="([^"]+)"([^>]*)>/gi)) {
      const attrsStr = (m[2] || '') + ' ' + (m[4] || '');
      const clsMatch = attrsStr.match(/\bclass="([^"]*)"/i);
      const hiddenAttr = /\bhidden\b/i.test(attrsStr);
      const roleMatch = attrsStr.match(/\brole="([^"]*)"/i);
      const dataTabMatch = attrsStr.match(/\bdata-ctx-tab="([^"]*)"/i);
      const n = ensureEl(m[3], m[1], {
        ...(clsMatch ? { class: clsMatch[1] } : {}),
        ...(hiddenAttr ? { hidden: true } : {}),
        ...(roleMatch ? { role: roleMatch[1] } : {})
      });
      if (dataTabMatch) n.setAttribute('data-ctx-tab', dataTabMatch[1]);
      if (m[1].toLowerCase() === 'input') {
        const typeM = attrsStr.match(/\btype="([^"]*)"/i);
        if (typeM) n.type = typeM[1];
      }
    }

    // 精确建立关键父子关系以便测试移动工作区、折叠与标签栏顺序
    const panel = ensureEl('panel', 'section');
    const ctxTabsBar = ensureEl('ctx-tabs-bar', 'div');
    const tabs = ['session', 'speed', 'models', 'accounts'].map((k) => {
      const b = ensureEl(`tab-ctx-${k}`, 'button', { role: 'tab', class: 'ctx-tab' });
      b.setAttribute('data-ctx-tab', k);
      return b;
    });
    ctxTabsBar.replaceChildren(...tabs);
    panel.appendChild(ctxTabsBar);

    for (const k of ['session', 'speed', 'models', 'accounts', 'settings']) {
      panel.appendChild(ensureEl(`pane-ctx-${k}`, 'div'));
    }

    // 关键工作区和弹窗层级关系（对应真实 template.html）
    const paneSettings = ensureEl('pane-ctx-settings', 'div');
    const workspace = ensureEl('ag-cm-settings-workspace', 'div');
    const fallbackBanner = ensureEl('settings-fallback-banner', 'div');
    paneSettings.appendChild(fallbackBanner);
    paneSettings.appendChild(workspace);
    for (const cardId of [
      'settings-general-card', 'settings-display-card', 'settings-region-card',
      'settings-accounts-card', 'settings-unlock-card', 'settings-enhance-card',
      'settings-rehydrate-card', 'settings-update-card', 'settings-diag-card'
    ]) {
      workspace.appendChild(ensureEl(cardId, 'div'));
    }
    const acctCard = ensureEl('settings-accounts-card', 'div');
    for (const cid of [
      'chk-auto-switch-enabled', 'sel-auto-switch-pool', 'sel-auto-switch-metric',
      'sel-auto-switch-window', 'inp-auto-switch-threshold', 'auto-switch-candidates-list',
      'btn-save-auto-switch', 'auto-switch-save-status', 'auto-switch-status-pill', 'accounts-list'
    ]) {
      acctCard.appendChild(ensureEl(cid, cid.startsWith('chk') || cid.startsWith('inp') ? 'input' : 'div'));
    }
    const paneAccounts = ensureEl('pane-ctx-accounts', 'div');
    const secSwitch = ensureEl('ctx-accounts-switch-section', 'div');
    const secPools = ensureEl('ctx-shared-pools-section', 'div');
    paneAccounts.appendChild(secSwitch);
    paneAccounts.appendChild(secPools);
    for (const aid of [
      'btn-tab-acct-refresh', 'btn-tab-acct-oauth-add', 'ctx-acct-active-summary',
      'ctx-acct-feedback', 'ctx-accounts-list', 'ctx-autoswitch-summary-card',
      'ctx-autoswitch-status-pill', 'ctx-autoswitch-rule-summary', 'ctx-autoswitch-reason',
      'btn-ctx-open-autoswitch-rules'
    ]) {
      secSwitch.appendChild(ensureEl(aid, aid.startsWith('btn') ? 'button' : 'div'));
    }
    for (const pid of [
      'ctx-pools-account-tag', 'ctx-pools-updated-at', 'btn-ctx-pools-refresh',
      'ctx-pools-banner', 'ctx-pools-current-card', 'ctx-pools-cur-model',
      'ctx-pools-cur-reset', 'ctx-pools-cur-badges', 'ctx-pools-others-list', 'quota-compare-list'
    ]) {
      secPools.appendChild(ensureEl(pid, pid.startsWith('btn') ? 'button' : 'div'));
    }

    // 确认弹窗位于顶层 shadow 而不是 workspace 内部（验收重点）
    ensureEl('global-restart-modal', 'div', { hidden: true });
    ensureEl('account-remove-modal', 'div', { hidden: true });
    ensureEl('ctx-unlock-restart-modal', 'div', { hidden: true });

    // 让 ctx-tabs-bar 保留真实的源码 DOM 顺序检测
    void bodyBtnCloseRe;
  }

  buildTemplateTreeIntoShadow();

  const origShadowQsa = shadowRoot.querySelectorAll.bind(shadowRoot);
  const origShadowQs = shadowRoot.querySelector.bind(shadowRoot);
  Object.defineProperty(shadowRoot, 'innerHTML', {
    get: () => '',
    set: () => { },
    configurable: true
  });
  const host = makeNode('div');
  host.id = 'ag-context-meter';
  host.attachShadow = () => {
    shadowRoot.host = host;
    shadowRoot.getElementById = (id) => shadowElements.get(id) || findById(shadowRoot, id) || null;
    shadowRoot.querySelectorAll = (sel) => origShadowQsa(sel);
    shadowRoot.querySelector = (sel) => origShadowQs(sel);
    return shadowRoot;
  };

  const bodyNode = makeNode('body');
  bodyNode.children = bodyChildren;
  const headNode = makeNode('head');
  headNode.children = headChildren;
  const docEl = makeNode('html');
  docEl.appendChild(headNode);
  docEl.appendChild(bodyNode);

  const lStoreMap = new Map(Object.entries(options.initialLocalStorage || {}));
  let firstCreate = true;
  const sandbox = {
    core,
    __AGContextMeterCore: core,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/batch01-followup-route' },
    localStorage: {
      getItem: (k) => (lStoreMap.has(k) ? lStoreMap.get(k) : null),
      setItem: (k, v) => lStoreMap.set(k, String(v)),
      removeItem: (k) => lStoreMap.delete(k)
    },
    navigator: { platform: 'Win32' },
    document: {
      hidden: false,
      head: headNode,
      body: bodyNode,
      documentElement: docEl,
      activeElement: null,
      createElement(tag) {
        if (firstCreate) {
          firstCreate = false;
          return host;
        }
        return makeNode(tag);
      },
      getElementById(id) {
        return findById(docEl, id) || null;
      },
      querySelectorAll(sel) {
        return docEl.querySelectorAll(sel);
      },
      querySelector(sel) {
        return docEl.querySelector(sel);
      },
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        docListeners.get(type)?.delete(fn);
      },
      dispatchEvent(ev = {}) {
        const t = ev.type || ev;
        for (const fn of (docListeners.get(t) || [])) fn(ev);
      }
    },
    window: {
      innerWidth: 1280,
      innerHeight: 860,
      outerWidth: 1280,
      outerHeight: 860,
      __APP_CONFIG__: { csrfToken: 'batch01-csrf' },
      contextMeterAPI: {
        scan: async () => ({ ok: true, data: { session: null, scannedAt: Date.now() } }),
        getSettings: async () => ({ ...storedSettings }),
        saveSettings: async (payload) => {
          savedSettingsPayloads.push(payload);
          if (payload?.uiPreferences) {
            storedSettings.uiPreferences = { ...storedSettings.uiPreferences, ...payload.uiPreferences };
          }
          if (payload?.allowBetaUpdates !== undefined) storedSettings.uiPreferences.allowBetaUpdates = Boolean(payload.allowBetaUpdates);
          if (payload?.nextPromptEnabled !== undefined) storedSettings.uiPreferences.nextPromptEnabled = Boolean(payload.nextPromptEnabled);
          return { ok: true, ...storedSettings };
        },
        getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.9.2', runtimeMode: 'installed' }),
        getQuota: async () => ({ ok: true, collectorVersion: '0.9.2', pools: [] }),
        getAccountsOverview: async () => {
          if (overviewQueue.length > 0) {
            const next = overviewQueue.shift();
            if (typeof next === 'function') return await next();
            activeOverview = next;
          }
          return activeOverview || { ok: true, accounts: [], autoSwitch: { enabled: false }, autoSwitchStatus: { state: 'off' } };
        },
        accountsAction: async (req) => {
          const action = req?.action;
          accountsActionCalls.push(req);
          if (typeof options.onAccountsAction === 'function') {
            const custom = await options.onAccountsAction(action, req);
            if (custom) return custom;
          }
          return { ok: true, overview: activeOverview };
        },
        openExternal: async () => ({ ok: true })
      },
      getComputedStyle: () => ({ backgroundColor: 'rgb(30, 30, 30)', color: 'rgb(220, 220, 220)' }),
      addEventListener() { },
      removeEventListener() { }
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    AbortController,
    EventSource: undefined,
    WebSocket: undefined,
    MutationObserver: undefined,
    requestAnimationFrame: (fn) => { try { fn(); } catch { } return 1; },
    cancelAnimationFrame() { },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() { },
    URL,
    Blob: undefined,
    performance: { now: () => Date.now() },
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.self = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  const flush = () => new Promise((r) => setTimeout(r, 15));

  function mountRealHostSettingsModal() {
    const dialog = makeNode('div');
    dialog.setAttribute('role', 'dialog');
    dialog.className = 'settings-modal-container';

    const headerBar = makeNode('div');
    const closeBtn = makeNode('button');
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '×';
    headerBar.appendChild(closeBtn);
    dialog.appendChild(headerBar);

    const splitRow = makeNode('div');
    splitRow.className = 'relative flex w-full h-full';

    const sidebar = makeNode('div');
    sidebar.setAttribute('data-testid', 'settings-sidebar');
    const listRoot = makeNode('div');

    // 第 1 组：常规大组（General, Editor, Browser）
    const groupGeneral = makeNode('div');
    groupGeneral.className = 'settings-group-general';
    const mkNavBtn = (id, label, active = false) => {
      const b = makeNode('button');
      b.id = `settings-nav-item-${id}`;
      b.textContent = label;
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.setAttribute('data-active', active ? 'true' : 'false');
      if (active) b.classList.add('active', 'bg-accent');
      return b;
    };
    const btnGeneral = mkNavBtn('General', 'General', true);
    const btnEditor = mkNavBtn('Editor', 'Editor', false);
    const btnBrowser = mkNavBtn('Browser', 'Browser', false);
    groupGeneral.appendChild(btnGeneral);
    groupGeneral.appendChild(btnEditor);
    groupGeneral.appendChild(btnBrowser);

    // 第 2 组：账户大组（验证跨大组切换时高亮不重影且不误把组当右栏）
    const groupAccount = makeNode('div');
    groupAccount.className = 'settings-group-account';
    const btnAccount = mkNavBtn('Account', 'Account', false);
    groupAccount.appendChild(btnAccount);

    listRoot.appendChild(groupGeneral);
    listRoot.appendChild(groupAccount);
    sidebar.appendChild(listRoot);

    const rightPane = makeNode('div');
    rightPane.setAttribute('data-settings-content-pane', 'true');
    rightPane.className = 'flex-1 overflow-y-auto';
    rightPane.scrollTop = 140;
    const nativeGeneralContent = makeNode('div');
    nativeGeneralContent.id = 'native-general-content';
    nativeGeneralContent.textContent = 'Native General Settings Body';
    rightPane.appendChild(nativeGeneralContent);

    splitRow.appendChild(sidebar);
    splitRow.appendChild(rightPane);
    dialog.appendChild(splitRow);
    bodyNode.appendChild(dialog);

    const switchNativeTo = (name, text) => {
      for (const b of [btnGeneral, btnEditor, btnBrowser, btnAccount]) {
        b.classList.remove('active', 'bg-accent');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('data-active', 'false');
      }
      const cur = name === 'Browser' ? btnBrowser : name === 'Account' ? btnAccount : btnGeneral;
      cur.classList.add('active', 'bg-accent');
      cur.setAttribute('aria-selected', 'true');
      cur.setAttribute('data-active', 'true');
      nativeGeneralContent.textContent = text;
    };
    btnGeneral.addEventListener('click', () => switchNativeTo('General', 'Native General Settings Body'));
    btnBrowser.addEventListener('click', () => switchNativeTo('Browser', 'Native Browser Settings Body'));
    btnAccount.addEventListener('click', () => switchNativeTo('Account', 'Native Account Settings Body'));

    return {
      dialog,
      closeBtn,
      sidebar,
      splitRow,
      groupGeneral,
      groupAccount,
      btnGeneral,
      btnBrowser,
      btnAccount,
      rightPane,
      nativeGeneralContent
    };
  }

  return {
    sandbox,
    api: sandbox.__AGContextMeter,
    elements: shadowElements,
    docElements,
    makeNode,
    bodyNode,
    mountRealHostSettingsModal,
    savedSettingsPayloads,
    accountsActionCalls,
    getStoredSettings: () => storedSettings,
    getActiveOverview: () => activeOverview,
    setActiveOverview: (ov) => { activeOverview = ov; },
    flush
  };
}

test('第 1 项：宿主设置真实结构独立 Context Meter 页、右侧保存读回、原生恢复与降级横幅', async () => {
  const h = createBatch01Harness();
  try {
    await h.api.restoreSettingsForTest();
    const modal = h.mountRealHostSettingsModal();
    assert.equal(h.api.syncHostSettingsForTest(), true, '应准确识别真实 settings-sidebar 与右栏 splitRow');

    // 验证导航插在 Browser 后，而非 Account 大组，且移除旧回跳按钮
    const navBtn = h.docElements.get('ag-cm-host-settings-nav');
    assert.ok(navBtn, '左侧导航必须插入 Context Meter 独立入口');
    assert.equal(navBtn.parentElement, modal.groupGeneral);
    const generalChildren = modal.groupGeneral.children;
    assert.equal(generalChildren.indexOf(navBtn), generalChildren.indexOf(modal.btnBrowser) + 1);
    assert.equal(modal.closeBtn.hidden, false, '右上角原生关闭按钮绝不能被隐藏');

    // 点开 Context Meter 独立页
    h.api.openContextSettingsForTest({ section: 'accounts' });
    await h.flush();

    const routeState = h.api.getSettingsRouteStateForTest();
    assert.equal(routeState.mode, 'host');
    assert.equal(routeState.reason, 'matched_settings_sidebar_splitrow');
    assert.equal(navBtn.getAttribute('data-active'), 'true');
    assert.equal(navBtn.getAttribute('aria-selected'), 'true');
    assert.equal(modal.btnGeneral.getAttribute('aria-selected'), 'false', '原生导航高亮必须消退');
    assert.equal(modal.nativeGeneralContent.hidden, true, '原生右侧内容在 Context Meter 页下应隐藏');

    // 验证原生设置页挂载于右栏 Shadow DOM，且移除了旧跳回看板按钮 ag-hs-btn-open-settings
    const hsState = h.api.getHostSettingsStateForTest();
    assert.equal(hsState.mounted, true);
    assert.equal(hsState.selected, true);
    assert.equal(hsState.nativeSettingsPageReady, true);
    assert.equal(hsState.hasShadowRoot, true);
    const workspace = h.elements.get('ag-cm-settings-workspace');
    assert.equal(modal.rightPane.querySelector('#ag-hs-btn-open-settings'), null, '不得再渲染跳回插件看板的旧按钮');

    // 确认弹窗位于顶层 shadow 而不是被吞进宿主右栏内部
    assert.notEqual(h.elements.get('global-restart-modal').parentElement, workspace);
    assert.notEqual(h.elements.get('account-remove-modal').parentElement, workspace);

    // 在右侧真实控件（#ag-cm-host-settings-page Shadow DOM 内 #ag-ns-sw-betaChannel）直接修改并保存，再切回原生与重开读回
    const hostPage = modal.rightPane.querySelector('#ag-cm-host-settings-page');
    assert.ok(hostPage?.shadowRoot, '右侧设置容器必须创建 Shadow DOM');
    const swBeta = hostPage.shadowRoot.getElementById('ag-ns-sw-betaChannel');
    assert.ok(swBeta, '右侧设置 Shadow DOM 内必须包含 #ag-ns-sw-betaChannel');
    swBeta.click();
    await h.flush();
    assert.ok(h.savedSettingsPayloads.some((p) => p.allowBetaUpdates === true || p.uiPreferences?.allowBetaUpdates === true));

    // 切回跨组原生导航 Account，确认原生右栏恢复、scrollTop 保留、Context Meter 取消高亮
    modal.btnAccount.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, false);
    assert.equal(modal.nativeGeneralContent.hidden, false);
    assert.equal(modal.rightPane.scrollTop, 140);
    assert.equal(navBtn.getAttribute('data-active'), 'false');
    assert.equal(navBtn.getAttribute('aria-selected'), 'false');
    assert.equal(modal.btnAccount.getAttribute('aria-selected'), 'true');

    // 验证 Browser -> Context Meter -> Account -> Context Meter 连续往返与右栏 DOM 重建后重绑定
    modal.btnBrowser.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, false);
    assert.equal(modal.btnBrowser.getAttribute('aria-selected'), 'true');

    // 模拟宿主框架重绘右栏节点（替换 rightPane），再点 Context Meter
    const replacedPane = h.makeNode('div');
    replacedPane.setAttribute('data-settings-content-pane', 'true');
    replacedPane.className = 'flex-1 overflow-y-auto';
    const freshNativeBody = h.makeNode('div');
    freshNativeBody.id = 'native-replaced-body';
    freshNativeBody.textContent = 'Rebuilt Models Content';
    replacedPane.appendChild(freshNativeBody);
    modal.rightPane.remove();
    modal.splitRow.appendChild(replacedPane);

    navBtn.click();
    await h.flush();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, true);
    assert.equal(navBtn.getAttribute('data-active'), 'true');
    assert.equal(navBtn.getAttribute('aria-selected'), 'true');
    assert.equal(modal.btnBrowser.getAttribute('aria-selected'), 'false', '切回 Context Meter 时上一次原生导航选中态必须消退');
    assert.equal(freshNativeBody.hidden, true, '新替换右栏中的原生内容节点必须被隐藏');
    assert.ok(replacedPane.querySelector('#ag-cm-host-settings-page'), '必须重新挂载或绑定到新右栏节点');
    modal.rightPane = replacedPane;
    modal.nativeGeneralContent = freshNativeBody;

    // 模拟重开读回：重置当前表单值后经 restoreSettingsForTest() 从持久化读取并重新进入 Context Meter 核对
    await h.api.restoreSettingsForTest();
    h.api.openContextSettingsForTest({ section: 'settings-update-card' });
    await h.flush();
    assert.equal(h.api.getUpdateStateForTest().allowBetaUpdates, true, '重新读回必须恢复已保存更新通道状态');
    assert.equal(hostPage.shadowRoot.getElementById('ag-ns-sw-betaChannel').getAttribute('aria-checked'), 'true', '右侧页重新打开必须显示已保存开关值');

    // 卸载宿主设置模态框 -> 降级到面板内置 #pane-ctx-settings 并显式说明原因
    modal.dialog.remove();
    h.api.openContextSettingsForTest({ section: 'general' });
    await h.flush();
    const fallbackRoute = h.api.getSettingsRouteStateForTest();
    assert.equal(fallbackRoute.mode, 'fallback');
    assert.ok(fallbackRoute.reason);
    assert.equal(h.elements.get('pane-ctx-settings').hidden, false);
    assert.equal(h.elements.get('settings-fallback-banner').hidden, false);
    assert.ok(String(h.elements.get('settings-fallback-reason-text').textContent || '').length > 5);
  } finally {
    h.api.dispose();
  }
});

test('第 2 项：看板第 4 标签账号与共享池、双脱敏切号、展开其他池不改会话模型及异常提示', async () => {
  const twoAccountsOverview = {
    activeAccountEmail: 'alice.smith@example.com',
    accounts: [
      {
        email: 'alice.smith@example.com',
        maskedEmail: 'al***th@example.com',
        isActive: true,
        hasRefreshToken: true,
        quotaSnapshot: {
          fetchedAtMs: Date.now(),
          activePoolKey: 'shared_gemini_main',
          pools: [
            {
              poolKey: 'shared_gemini_main',
              label: 'Gemini 主模型池',
              models: ['Gemini 4 Pro High', 'Gemini 4 Flash'],
              buckets: [
                { bucketId: '5h', label: '5h', windowKey: '5h', remainingFraction: 0.68, remainingPct: 68, resetText: '2h 15m' },
                { bucketId: '7d', label: '7d', windowKey: '7d', remainingFraction: 0.84, remainingPct: 84, resetText: '5d 04h' }
              ]
            },
            {
              poolKey: 'shared_claude_alt',
              label: 'Claude 备选共享池',
              models: ['Claude Sonnet'],
              buckets: [
                { bucketId: '5h', label: '5h', windowKey: '5h', remainingFraction: 0.92, remainingPct: 92, resetText: '4h 10m' }
              ]
            }
          ]
        }
      },
      {
        email: 'bob.jones@example.com',
        maskedEmail: 'bo***es@example.com',
        isActive: false,
        hasRefreshToken: true,
        quotaSnapshot: {
          fetchedAtMs: Date.now(),
          activePoolKey: 'shared_gemini_main',
          pools: [
            {
              poolKey: 'shared_gemini_main',
              label: 'Gemini 主模型池',
              models: ['Gemini 4 Pro High'],
              buckets: [
                { bucketId: '5h', label: '5h', windowKey: '5h', remainingPct: 97, resetText: '4h 50m' },
                { bucketId: '7d', label: '7d', windowKey: '7d', remainingPct: 99, resetText: '6d 20h' }
              ]
            }
          ]
        }
      }
    ],
    autoSwitch: {
      enabled: false,
      poolKey: 'shared_gemini_main',
      metricMode: 'remaining_pct',
      windowKey: '5h',
      thresholdPct: 20,
      candidates: ['bob.jones@example.com']
    },
    autoSwitchStatus: { state: 'off' }
  };

  let currentOverview = { ok: true, ...JSON.parse(JSON.stringify(twoAccountsOverview)) };
  const h = createBatch01Harness({
    initialLocalStorage: { ag_ctx_active_tab: 'settings' },
    initialOverview: currentOverview,
    onAccountsAction: async (action, payload) => {
      if ((action === 'switch' || action === 'switch_account') && (payload?.email === 'bob.jones@example.com' || payload?.targetEmail === 'bob.jones@example.com')) {
        currentOverview = {
          ...currentOverview,
          ok: true,
          activeAccountEmail: 'bob.jones@example.com',
          accounts: currentOverview.accounts.map((a) => ({
            ...a,
            isActive: a.email === 'bob.jones@example.com'
          }))
        };
        h.setActiveOverview(currentOverview);
        return { ok: true, overview: currentOverview };
      }
      return { ok: true, overview: currentOverview };
    }
  });

  try {
    // 1. 标签顺序与唯一 ID
    const bar = h.elements.get('ctx-tabs-bar');
    assert.deepEqual(
      bar.children.map((c) => c.getAttribute('data-ctx-tab')),
      ['session', 'speed', 'models', 'accounts']
    );
    assert.ok(TPL_SOURCE.match(/id="quota-compare-list"/g)?.length === 1, '全模板仅允许存在唯一 #quota-compare-list');

    // 2. 旧持久化标识 'settings' 自动迁移至第 4 标签 'accounts'，及方向键导航
    assert.equal(h.api.getAccountsTabStateForTest().activeContextTab, 'accounts');
    assert.equal(h.sandbox.localStorage.getItem('ag_ctx_active_tab'), 'accounts');
    assert.equal(h.elements.get('pane-ctx-accounts').hidden, false);

    // 右箭头循环回第一项，左箭头回到 accounts
    h.elements.get('tab-ctx-accounts').trigger('keydown', { key: 'ArrowRight' });
    assert.equal(h.api.getAccountsTabStateForTest().activeContextTab, 'session');
    h.elements.get('tab-ctx-session').trigger('keydown', { key: 'ArrowLeft' });
    assert.equal(h.api.getAccountsTabStateForTest().activeContextTab, 'accounts');

    // 3. 写入账号列表 + 设置当前会话模型上下文，验证切号前与展开其他池不变更会话模型
    h.api.setContextLatestForTest({
      model: 'Gemini 4 Pro High',
      modelId: 'gemini-4-pro-high',
      status: 'reported',
      used: 20000,
      budget: 256000
    });
    h.api.setAccountsOverviewForTest(currentOverview);
    h.api.setQuotaSnapshotForTest({ snapshot: currentOverview.accounts[0].quotaSnapshot });
    await h.flush();

    const stateBefore = h.api.getAccountsTabStateForTest();
    assert.equal(stateBefore.activeEmail, 'alice.smith@example.com');
    assert.equal(stateBefore.tabAccountCount, 2);
    assert.equal(stateBefore.tabOtherPoolsCount, 1);

    // 验证第 4 标签移除了重复的完整 20 格进度条，改用 5h / 7d 分窗口简洁摘要与直达模型额度看板按钮
    const collectText = (n) => {
      if (!n) return '';
      return [n.textContent || '', ...Array.from(n.children || []).map(collectText)].filter(Boolean).join(' ');
    };
    const curBucketsEl = h.elements.get('ctx-pools-cur-buckets');
    const curBucketsText = collectText(curBucketsEl);
    assert.equal(curBucketsEl.querySelectorAll('.quota-bar-track').length, 0, '账号页当前池摘要不得渲染重复 20 格额度进度条');
    assert.equal(curBucketsEl.querySelectorAll('.quota-bucket-row').length, 0, '账号页当前池摘要不得渲染完整进度行');
    assert.match(curBucketsText, /68%/);
    assert.match(curBucketsText, /84%/);
    assert.match(curBucketsText, /2h 15m/);
    assert.match(curBucketsText, /5d 04h/);
    assert.equal(h.elements.get('ctx-pools-others-list').querySelectorAll('.quota-bar-track').length, 0, '其他共享池列表亦不得重复渲染完整进度条');
    assert.ok(h.elements.get('btn-ctx-open-quota-board'), '必须提供查看模型额度直达按钮');
    h.elements.get('btn-ctx-open-quota-board').click();
    assert.equal(h.elements.get('panel-quota').hidden, false, '查看模型额度按钮必须直达模型额度看板');
    assert.ok(h.elements.get('quota-cur-buckets').querySelectorAll('.quota-bar-track').length > 0, '完整 20 格进度条统一在模型额度看板展示');
    assert.ok(h.elements.get('quota-cur-buckets').querySelectorAll('.quota-bucket-row').length > 0, '完整分桶行统一在模型额度看板展示');
    h.elements.get('btn-quota-open-accounts-settings').click();

    const beforeSessionModel = h.api.syncContextModelSelectionForTest().activeSessionModelKey;
    h.api.selectQuotaPoolBrowseForTest('shared_claude_alt');
    assert.equal(h.api.syncContextModelSelectionForTest().activeSessionModelKey, beforeSessionModel, '展开其他共享池绝不能修改当前会话模型');

    // 手动点击 Bob 账号的切换按钮 -> 刷新实际生效账号和共享池 5h/7d 值
    const switchBtn = h.elements.get('ctx-accounts-list').querySelectorAll('button').find((b) => String(b.textContent).includes('切'));
    assert.ok(switchBtn, '应渲染切换账号按钮');
    switchBtn.click();
    await h.flush();
    assert.equal(h.api.getAccountsTabStateForTest().activeEmail, 'bob.jones@example.com');

    // 验证第 4 标签共享池错误/无权限/空数据横幅可显式展示
    // 验证读取账号概览失败时明确展示加载异常，不得伪装成「0 个已登记账号」
    const origAcctsAction = h.sandbox.window.contextMeterAPI.accountsAction;
    h.api.setAccountsOverviewForTest(null);
    h.sandbox.window.contextMeterAPI.accountsAction = async () => ({ ok: false, error: 'backend_module_corrupted' });
    h.elements.get('btn-tab-acct-refresh').click();
    await h.flush();
    assert.match(h.elements.get('ctx-acct-active-summary').textContent, /失败|backend_module_corrupted/);
    assert.match(collectText(h.elements.get('ctx-accounts-list')), /失败|backend_module_corrupted/);

    // 恢复正常概览接口并验证第 4 标签共享池错误/无权限/空数据横幅可显式展示
    h.sandbox.window.contextMeterAPI.accountsAction = origAcctsAction;
    h.sandbox.window.contextMeterAPI.getAccountsOverview = async () => currentOverview;
    h.api.setAccountsOverviewForTest({
      activeAccountEmail: null,
      accounts: [],
      autoSwitch: { enabled: false },
      autoSwitchStatus: { state: 'off' }
    });
    h.api.setQuotaSnapshotForTest({ error: 'unauthorized', errorKind: 'auth' });
    await h.flush();
    assert.equal(h.elements.get('ctx-pools-banner').hidden, false, '未登录或无权限时共享池必须显示明确状态横幅');
    assert.match(h.elements.get('ctx-pools-banner-text').textContent, /unauthorized|无权限|失败/);

    h.api.setQuotaSnapshotForTest({
      snapshot: {
        fetchedAtMs: Date.now(),
        pools: [{ poolKey: 'shared_3p_pool', title: 'Claude', noPermission: true, buckets: [] }]
      }
    });
    await h.flush();
    assert.equal(h.elements.get('ctx-pools-banner').hidden, false);
    assert.match(h.elements.get('ctx-pools-banner-text').textContent, /无权限/);

    // 4. 顶栏额度快览 Manage Accounts 捷径进入第 4 标签
    h.elements.get('btn-quota-open-accounts-settings').click();
    assert.equal(h.elements.get('pane-ctx-accounts').hidden, false);
  } finally {
    h.api.dispose();
  }
});

test('第 3 项：自动切号总开关直提与校验、双维度状态反馈、失败恢复与 mutationSeq 防倒灌', async () => {
    let saveShouldFail = false;
    let releaseSlowAction = null;
    let releaseSlowOverview = null;
    const baseOverview = {
      ok: true,
      activeAccountEmail: 'a@example.com',
      accounts: [
        { email: 'a@example.com', maskedEmail: 'a***@example.com', isActive: true, hasRefreshToken: true },
        { email: 'b@example.com', maskedEmail: 'b***@example.com', isActive: false, hasRefreshToken: true }
      ],
      autoSwitch: {
        enabled: false,
        poolKey: 'shared_gemini_main',
        metricMode: 'remaining_pct',
        windowKey: '5h',
        thresholdPct: 20,
        candidates: ['b@example.com']
      },
      autoSwitchStatus: { state: 'off', blockedReason: null }
    };

    const h = createBatch01Harness({
      initialOverview: baseOverview,
      onAccountsAction: async (action, payload) => {
        if (action === 'update_auto_switch') {
          if (releaseSlowAction === 'wait') {
            await new Promise((r) => { releaseSlowAction = r; });
          }
          if (saveShouldFail) {
            return { ok: false, error: '网络超时写入失败' };
          }
          const curOv = h.getActiveOverview() || baseOverview;
          const nextOv = {
            ...baseOverview,
            autoSwitch: { ...baseOverview.autoSwitch, ...(payload?.config || payload) },
            ...curOv,
            autoSwitch: { ...curOv.autoSwitch, ...(payload?.config || payload) },
            autoSwitchStatus: (payload?.config?.enabled ?? payload?.enabled) ? { state: 'watching', blockedReason: null } : { state: 'off', blockedReason: null }
          };
          h.setActiveOverview(nextOv);
          return { ok: true, overview: nextOv };
        }
        return { ok: true, overview: h.getActiveOverview?.() || baseOverview };
      }
    });

    try {
      h.api.setAccountsOverviewForTest(baseOverview);
      await h.flush();

      const chk = h.elements.get('chk-auto-switch-enabled');
      const th = h.elements.get('inp-auto-switch-threshold');
      const saveStatus = h.elements.get('auto-switch-save-status');
      const tabPill = h.elements.get('ctx-autoswitch-status-pill');
      const quotaPill = h.elements.get('quota-entry-autoswitch-pill');

      // 1. 切换开关 -> 立即三处同步显示待保存/未保存状态
      // 1. 已有合法保存规则且无未保存草稿 -> 直接拨动总开关应立即提交并反馈双维度状态
      chk.checked = true;
      chk.trigger('change');
      await h.flush();
      assert.equal(h.api.getAccountsTabStateForTest().autoSwitchEnabled, true, '无未保存修改时总开关应直接提交启用');
      assert.equal(tabPill.textContent, '已开启 · 监控中');
      assert.equal(quotaPill.textContent, '已开启 · 监控中');
      assert.equal(h.elements.get('auto-switch-status-pill').textContent, '已开启 · 监控中');

      // 2. 在已确认开启状态下直切关闭若失败 -> 恢复最后确认值 (true) 并明确提示原因
      saveShouldFail = true;
      chk.checked = false;
      chk.trigger('change');
      await h.flush();
      assert.equal(chk.checked, true, '直切保存失败必须恢复到最后确认值 true');
      assert.match(saveStatus.textContent, /失败.*网络超时|网络超时/);

      // 3. 关闭成功，再测试快速连续点击防重入
      saveShouldFail = false;
      chk.checked = false;
      chk.trigger('change');
      await h.flush();
      assert.equal(h.api.getAccountsTabStateForTest().autoSwitchEnabled, false);

      releaseSlowAction = 'wait';
      const actionCallsBeforeRapid = h.accountsActionCalls.length;
      chk.checked = true;
      chk.trigger('change');
      assert.equal(chk.disabled, true, '保存进行中必须置禁用态防止重复点击');
      chk.checked = false;
      chk.trigger('change');
      assert.equal(h.accountsActionCalls.length, actionCallsBeforeRapid + 1, '快速连续点击仅允许提交一次');
      if (typeof releaseSlowAction === 'function') releaseSlowAction();
      releaseSlowAction = null;
      await h.flush();
      assert.equal(chk.disabled, false);
      assert.equal(chk.checked, true);

      // 4. 存在未保存草稿修改 -> 三处同步显示待保存，此时拨动总开关提示先保存规则；保存草稿与 mutationSeq 并发防倒灌正常
      th.value = '25';
      th.trigger('input');
      assert.match(saveStatus.textContent, /未保存|待保存/);
      assert.match(tabPill.textContent, /待保存/);
      assert.match(quotaPill.textContent, /待保存/);
      assert.equal(h.api.getAccountsTabStateForTest().draftDirty, true);

      // 2. 保存失败 -> 保留未提交草稿并展示具体错误原因
      saveShouldFail = true;
      h.elements.get('btn-save-auto-switch').click();
      await h.flush();
      assert.match(saveStatus.textContent, /失败.*网络超时|网络超时/);
      assert.equal(chk.checked, true, '保存失败不得把用户勾选草稿洗掉');
      assert.equal(th.value, '25');
      assert.equal(h.api.getAccountsTabStateForTest().draftDirty, true);

      // 3. 发起慢速 overview 刷新与保存并发：先发慢刷新，再完成保存，慢刷新晚到时 mutationSeq 必须拦截其回滚已确认状态
      let slowOverviewFired = false;
      h.sandbox.window.contextMeterAPI.getAccountsOverview = () => {
        if (!slowOverviewFired) {
          slowOverviewFired = true;
          return new Promise((res) => { releaseSlowOverview = res; });
        }
        return Promise.resolve(h.getActiveOverview());
      };
      h.api.switchContextTabForTest('accounts');
      saveShouldFail = false;
      const seqBeforeSave = h.api.getAccountsTabStateForTest().mutationSeq;
      h.elements.get('btn-save-auto-switch').click();
      await h.flush();
      const seqAfterSave = h.api.getAccountsTabStateForTest().mutationSeq;
      assert.ok(seqAfterSave > seqBeforeSave, '保存成功必须递增 mutationSeq');
      assert.equal(h.api.getAccountsTabStateForTest().autoSwitchEnabled, true);
      assert.equal(tabPill.textContent, '已开启 · 监控中');
      assert.equal(quotaPill.textContent, '已开启 · 监控中');
      assert.equal(h.api.getAccountsTabStateForTest().draftDirty, false);

      // 释放更早发出的旧 overview (enabled: false) -> mutationSeq 拦截，绝不得回滚已确认启用状态
      if (releaseSlowOverview) releaseSlowOverview({ ...baseOverview, autoSwitch: { ...baseOverview.autoSwitch, enabled: false } });
      await h.flush();
      assert.equal(h.api.getAccountsTabStateForTest().autoSwitchEnabled, true, '旧 overview 晚到绝不得回滚已保存状态');
      assert.equal(tabPill.textContent, '已开启 · 监控中');

      // 验证开启但无候选账号与免改盘模式下的双维度状态和阻塞原因清晰展示
      h.api.setAccountsOverviewForTest({
        ...baseOverview,
        autoSwitch: { ...baseOverview.autoSwitch, enabled: true, candidates: [] },
        autoSwitchStatus: { state: 'no_candidates', blockedReason: 'no_candidates_configured' }
      });
      assert.equal(tabPill.textContent, '已开启 · 受阻 · 缺少候选账号');
      assert.match(h.elements.get('ctx-autoswitch-reason').textContent, /候选账号/);

      // 此时若在缺少候选且未保存条件下直开，不得假成功
      h.api.setAccountsOverviewForTest({
        ...baseOverview,
        autoSwitch: { ...baseOverview.autoSwitch, enabled: false, candidates: [] },
        autoSwitchStatus: { state: 'off', blockedReason: null }
      });
      chk.checked = true;
      chk.trigger('change');
      await h.flush();
      assert.equal(chk.checked, false, '缺少备选账号时总开关直开必须恢复为 false 并提示');
      assert.match(saveStatus.textContent, /备选账号/);

      h.api.setAccountsOverviewForTest({
        ...baseOverview,
        autoSwitch: { ...baseOverview.autoSwitch, enabled: true, candidates: ['b@example.com'] },
        autoSwitchStatus: { state: 'waiting_idle', blockedReason: 'live_mode_cannot_auto_restart' }
      });
      assert.equal(tabPill.textContent, '已开启 · 等待当前生成完成');
      assert.match(h.elements.get('ctx-autoswitch-reason').textContent, /免改盘|重启/);
    } finally {
      h.api.dispose();
    }
  });

  test('第 4 项：deriveTrustedAutoSwitchQuotaContext、countOpenHostWindows、可控时钟阈值评估、防误切与失败恢复', async () => {
    // A. 测试 countOpenHostWindows 同窗口/WebContents 去重（注入临时 utils/electron stub 并严格复原）
    const Module = require('node:module');
    const sharedWc = { id: 42, getURL: () => 'http://127.0.0.1:43210/c/conv1', isDestroyed: () => false };
    const fakeWin1 = { isDestroyed: () => false, webContents: sharedWc };
    const fakeWin2Dup = { isDestroyed: () => false, webContents: sharedWc };
    const fakeWin3 = { isDestroyed: () => false, webContents: { id: 99, getURL: () => 'http://127.0.0.1:43210/c/conv2', isDestroyed: () => false } };
    const fakeWinDestroyed = { isDestroyed: () => true, webContents: { id: 100 } };
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === './utils') {
        return { getHubWindows: () => [fakeWin1, fakeWinDestroyed] };
      }
      if (request === 'electron') {
        return {
          BrowserWindow: { getAllWindows: () => [fakeWin1, fakeWin2Dup, fakeWin3] },
          BaseWindow: { getAllWindows: () => [fakeWin3] }
        };
      }
      return origLoad.apply(this, arguments);
    };
    let winCount = 0;
    try {
      winCount = mainMod.countOpenHostWindows();
    } finally {
      Module._load = origLoad;
    }
    assert.equal(winCount, 2, '相同 webContents.id 窗口必须去重，有效宿主窗口应精确为 2');

    // B. 测试 deriveTrustedAutoSwitchQuotaContext 对 stale / account_mismatch / error 的拦截
    const freshSnap = {
      ok: true,
      email: 'a@example.com',
      snapshot: {
        syncState: 'fresh',
        updatedAtMs: 100000,
        pools: [{ poolKey: 'p1', buckets: [{ bucketId: '5h', windowKey: '5h', remainingPct: 12 }] }]
      }
    };
    assert.equal(accountsMod.deriveTrustedAutoSwitchQuotaContext({ res: freshSnap, activeEmail: 'a@example.com', nowMs: 110000 }).trusted, true);
    assert.equal(accountsMod.deriveTrustedAutoSwitchQuotaContext({ res: freshSnap, activeEmail: 'a@example.com', nowMs: 300000 }).syncState, 'stale');
    assert.equal(accountsMod.deriveTrustedAutoSwitchQuotaContext({ res: freshSnap, activeEmail: 'b@example.com', nowMs: 110000 }).syncState, 'account_mismatch');
    assert.equal(accountsMod.deriveTrustedAutoSwitchQuotaContext({ res: { ok: false, error: 'timeout' }, activeEmail: 'a@example.com', nowMs: 110000 }).trusted, false);

    // C. 使用临时目录 + 可控时钟 nowMs 完整验证状态机、防误切与失败恢复
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-b01-'));
    let activeCred = {
      email: 'a@example.com',
      accessToken: 'tok-a',
      refreshToken: 'ref-a',
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    };
    let restartCalls = 0;
    let forceRestartFailure = false;
    const preCheckCalls = [];

    const mockCredStore = {
      getPaths: () => ({ desktopDbPath: '', ideDbPath: '', googleAccountsPath: '', oauthCredsPath: '' }),
      readWindowsSystemCredential: () => null,
      readMacKeychainCredential: () => null,
      captureSnapshot: () => ({ ...activeCred }),
      applyCredential: (cred) => {
        activeCred = { ...cred };
        return { ok: true };
      },
      restoreSnapshot: (snap) => {
        activeCred = { ...snap };
        return { ok: true };
      }
    };

    const mgr = accountsMod.createAccountsManager({
      stateDir: tmpDir,
      credentialStore: mockCredStore,
      getHostUserStatus: async () => ({ email: activeCred.email }),
      restartLanguageServers: async () => {
        restartCalls++;
        if (forceRestartFailure) return { ok: false, error: 'mock_restart_failed' };
        return { ok: true };
      }
    });

    try {
      mgr.addAccountWithCredential({
        email: 'a@example.com',
        accessToken: 'tok-a',
        refreshToken: 'ref-a',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        setActive: true
      });
      mgr.addAccountWithCredential({
        email: 'b@example.com',
        accessToken: 'tok-b',
        refreshToken: 'ref-b',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        setActive: false
      });
      await mgr.updateAutoSwitchConfig({
        enabled: true,
        poolKey: 'shared_gemini_main',
        metricMode: 'remaining_pct',
        windowKey: '5h',
        thresholdPct: 20,
        debounceSec: 15,
        cooldownSec: 600,
        waitUntilIdle: true,
        candidates: ['b@example.com']
      });

      const makeSnapshot = (frac5h, extra = {}) => ({
        syncState: 'fresh',
        pools: [{
          poolKey: 'shared_gemini_main',
          title: 'Gemini',
          remainingFraction: frac5h,
          primaryBucket: { windowKey: '5h', windowShort: '5h', remainingFraction: frac5h },
          buckets: [{
            bucketId: 'b5h',
            windowKey: '5h',
            windowShort: '5h',
            remainingFraction: frac5h,
            isResetPassed: Boolean(extra.resetPassed)
          }]
        }]
      });

      // 给 b@example.com 写入充足额度快照，给 a@example.com 写入正常快照
      await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: makeSnapshot(0.85), nowMs: 90000 });
      await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: makeSnapshot(0.45), nowMs: 95000 });

      // 1. 未越阈不切
      let r = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.45), syncState: 'fresh', nowMs: 100000 });
      assert.equal(r.action, 'ok_above_threshold');
      assert.equal(restartCalls, 0);

      // 2. isResetPassed 重置点已过旧桶不切
      r = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.05, { resetPassed: true }), syncState: 'fresh', nowMs: 110000 });
      assert.equal(r.action, 'blocked');
      assert.equal(r.reason, 'target_window_reset_passed');

      // 3. 防抖后校验：未保存草稿拦截
      await mgr.updateAutoSwitchConfig({ debounceSec: 0 });
      r = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.05), syncState: 'fresh', hasUnsavedDraft: true, nowMs: 120000 });
      assert.equal(r.action, 'waiting_idle');
      assert.equal(r.reason, 'unsaved_draft_present');

      // 4. 多窗口拦截（需要客户端重启但打开多个窗口）
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'a@example.com',
        activeSnapshot: makeSnapshot(0.05),
        syncState: 'fresh',
        openWindowCount: 2,
        requiresClientRestart: true,
        blockedRestartReason: 'multi_window_open',
        nowMs: 130000
      });
      assert.equal(r.action, 'blocked');
      assert.equal(r.reason, 'multi_window_open');

      // 5. 先切回安全阈值清掉旧 debounceState，再测生成中先防抖后 waiting_idle
      await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.45), syncState: 'fresh', nowMs: 135000 });
      await mgr.updateAutoSwitchConfig({ debounceSec: 10 });
      r = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.10), syncState: 'fresh', isGenerating: true, openWindowCount: 1, nowMs: 140000 });
      assert.equal(r.action, 'pending_debounce');
      r = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: makeSnapshot(0.10), syncState: 'fresh', isGenerating: true, openWindowCount: 1, nowMs: 155000 });
      assert.equal(r.action, 'waiting_idle');
      assert.equal(r.reason, 'generation_in_progress');

      // 6. preCommitCheck 在写凭据前临时中止 -> 凭据绝不修改
      await mgr.updateAutoSwitchConfig({ debounceSec: 0 });
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'a@example.com',
        activeSnapshot: makeSnapshot(0.08),
        syncState: 'fresh',
        isGenerating: false,
        openWindowCount: 1,
        skipTokenRefresh: true,
        nowMs: 160000,
        preCommitCheck: ({ phase }) => {
          preCheckCalls.push(phase);
          return phase === 'before_credential_write' ? { ok: false, deferred: true, reason: 'became_busy_before_write' } : { ok: true };
        }
      });
      assert.equal(r.action, 'waiting_idle');
      assert.equal(activeCred.email, 'a@example.com', 'before_credential_write 拦截时凭据绝不能被改写');

      // 7. preCommitCheck 在写后、重启前动态中止 -> 必须回滚原凭据且不发重启
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'a@example.com',
        activeSnapshot: makeSnapshot(0.08),
        syncState: 'fresh',
        isGenerating: false,
        openWindowCount: 1,
        skipTokenRefresh: true,
        requiresClientRestart: true,
        restartClient: async () => {
          restartCalls++;
          if (forceRestartFailure) return { ok: false, error: 'mock_restart_failed' };
          return { ok: true, restartPending: true };
        },
        nowMs: 170000,
        preCommitCheck: ({ phase }) => {
          preCheckCalls.push(phase);
          return phase === 'before_restart' ? { ok: false, deferred: true, reason: 'window_became_busy_before_restart' } : { ok: true };
        }
      });
      assert.equal(r.action, 'waiting_idle');
      assert.equal(activeCred.email, 'a@example.com', 'before_restart 动态中止必须把写出的凭据恢复回 a@example.com');
      assert.equal(restartCalls, 0);

      // 8. 正常空闲（LS 语言服务重启校验通过）-> 仅触发 1 次切号
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'a@example.com',
        activeSnapshot: makeSnapshot(0.08),
        syncState: 'fresh',
        isGenerating: false,
        openWindowCount: 1,
        skipTokenRefresh: true,
        nowMs: 180000,
        preCommitCheck: () => ({ ok: true })
      });
      assert.equal(r.action, 'switched');
      assert.equal(activeCred.email, 'b@example.com');
      assert.equal(restartCalls, 1);

      // 冷却期内再次评估仅命中 cooldown，不会连切
      r = await mgr.evaluateAutoSwitch({ activeEmail: 'b@example.com', activeSnapshot: makeSnapshot(0.08), syncState: 'fresh', isGenerating: false, openWindowCount: 1, nowMs: 181000 });
      assert.equal(r.action, 'cooldown');
      assert.equal(restartCalls, 1);

      // 9. 先验证候选账号快照过期时归为 all_candidates_exhausted，再刷新候选快照验证重启硬失败自动回滚并自动关闭开关
      await mgr.updateAutoSwitchConfig({ candidates: ['a@example.com'], enabled: true, debounceSec: 0 });
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'b@example.com',
        activeSnapshot: makeSnapshot(0.05),
        syncState: 'fresh',
        isGenerating: false,
        openWindowCount: 1,
        skipTokenRefresh: true,
        requiresClientRestart: true,
        nowMs: 900000
      });
      assert.equal(r.action, 'all_candidates_exhausted', '候选账号快照过期时必须阻止切号');

      await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: makeSnapshot(0.92), nowMs: 895000 });
      forceRestartFailure = true;
      r = await mgr.evaluateAutoSwitch({
        activeEmail: 'b@example.com',
        activeSnapshot: makeSnapshot(0.05),
        syncState: 'fresh',
        isGenerating: false,
        openWindowCount: 1,
        skipTokenRefresh: true,
        requiresClientRestart: true,
        restartClient: async () => ({ ok: false, error: 'mock_restart_failed' }),
        nowMs: 900000
      });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'switch_failed_halted');
      assert.equal(activeCred.email, 'b@example.com', '重启硬失败必须回滚到切前账号 b@example.com');
      assert.equal(mgr.getOverviewState().autoSwitch.enabled, false, '重启硬失败后自动切号开关必须安全降级关闭');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('第 5 项：窗口拖动防吞区域、双向客户端语言切换保留品牌、与宿主强调色开关绑定', async () => {
    const CSS_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
    // 1. 验证径向浮层与顶栏拖动选择器安全隔离
    assert.doesNotMatch(RENDERER_SOURCE, /#ag-context-meter-radial-host[^}]*-webkit-app-region:\s*no-drag/i, 'radialHost 外壳禁止带 no-drag');
    assert.match(CSS_SOURCE, /\.ctx-radial-orb:not\(\[hidden\]\)[\s\S]*?-webkit-app-region:\s*no-drag/);
    assert.match(RENDERER_SOURCE, /#ag-context-meter\[hidden\][\s\S]*?pointer-events:\s*none\s*!important/);
    assert.match(CSS_SOURCE, /--ag-host-accent,\s*#7748CF/);

    // 2. 双向客户端语言切换 zh-CN <-> en（保留品牌且不改面板语言）
    const modConfigMod = require('./modules-config');
    const tmpCfg = path.join(os.tmpdir(), `agcm-lang-cfg-${Date.now()}.json`);
    try {
      const baseCfg = JSON.parse(JSON.stringify(modConfigMod.DEFAULT_CONFIG));
      baseCfg.modules.chinese = { enabled: false, language: 'en', brandTitle: 'translated' };
      modConfigMod.saveModulesConfig(baseCfg, { configPath: tmpCfg });

      const c1 = modConfigMod.loadModulesConfig({ configPath: tmpCfg });
      c1.modules.chinese.enabled = true;
      c1.modules.chinese.language = 'zh-CN';
      modConfigMod.saveModulesConfig(c1, { configPath: tmpCfg });
      const readZh = modConfigMod.loadModulesConfig({ configPath: tmpCfg });
      assert.equal(readZh.modules.chinese.enabled, true);
      assert.equal(readZh.modules.chinese.language, 'zh-CN');
      assert.equal(readZh.modules.chinese.brandTitle, 'translated');

      readZh.modules.chinese.enabled = false;
      readZh.modules.chinese.language = 'en';
      modConfigMod.saveModulesConfig(readZh, { configPath: tmpCfg });
      const backToEn = modConfigMod.loadModulesConfig({ configPath: tmpCfg });
      assert.equal(backToEn.modules.chinese.enabled, false);
      assert.equal(backToEn.modules.chinese.language, 'en');
      assert.equal(backToEn.modules.chinese.brandTitle, 'translated', '切回原生英文必须保留品牌偏好');

      const meterMainSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');
      assert.doesNotMatch(meterMainSrc, /!targetEnable[\s\S]{0,160}brandTitle\s*=\s*['"]english['"]/, 'meter-main 切回英文不得重置 brandTitle');
    } finally {
      fs.rmSync(tmpCfg, { force: true });
    }
  });

  test('零括号校验：本次新增与修改的所有三语 i18n 文案及新增 HTML 文本不得出现中英文括号', () => {
    const newKeys = [
      'tab.accounts', 'accounts.editRulesBtn', 'accounts.status.unsaved',
      'accounts.status.saving', 'accounts.status.save_failed', 'accounts.status.no_candidates',
      'accounts.status.watching', 'accounts.status.waiting_idle', 'accounts.status.error',
      'accounts.blockedReason.no_candidates', 'accounts.blockedReason.unsaved_draft',
      'accounts.blockedReason.reset_passed', 'accounts.blockedReason.account_mismatch',
      'accounts.thresholdLabel', 'accounts.manageBtn', 'accounts.entryRuleUnsaved',
      'accounts.loadErrorSummary', 'accounts.toggleNeedSaveDraft', 'accounts.toggleNeedCandidates',
      'accountsTab.switchTitle', 'accountsTab.autoSwitchTitle', 'accountsTab.poolsTitle',
      'accountsTab.mainPoolLabel', 'accountsTab.poolsBrowseHint', 'accountsTab.compareMovedHint',
      'accountsTab.openPoolsBtn', 'accountsTab.openQuotaBoardBtn', 'accountsTab.noPermissionBanner',
      'settings.fallback.title', 'settings.fallback.defaultReason', 'settings.fallback.retryHost',
      'settings.fallback.noHostModal', 'settings.fallback.standaloneBrowser',
      'settings.clientLang.applyRestart', 'mod.zh.submitting', 'mod.zh.readbackMismatch',
      'prefs.saving', 'prefs.stateOn', 'prefs.stateOff', 'prefs.toggleFailed'
    ];
    for (const key of newKeys) {
      const m = I18N_SOURCE.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*\\{[^\\n]+\\}`));
      assert.ok(m, `必须存在词条 ${key}`);
      assert.doesNotMatch(m[0], /[（）()]/, `三语词条 ${key} 禁止出现中英文括号`);
    }
  });

test('v0.9.3 实机返工回归：2.35.1 VX外层包装导航零重建与旧节点重绑、Windows独立菜单栏拖拽、dialog重启弹窗、无noticeId历史事件与跨冷启动零重播', async () => {
  // 1. P0-1: 真实 Antigravity 2.35.1 DOM（div.relative.group/nav-item.mx-2 包裹 button[data-testid="settings-nav-item-Browser"]）
  const h = createBatch01Harness();
  try {
    await h.api.restoreSettingsForTest();

    const modal = h.makeNode('div');
    modal.className = 'settings-modal-container';
    modal.setAttribute('role', 'dialog');
    const splitRow = h.makeNode('div');
    splitRow.className = 'relative flex w-full h-full';

    const sidebar = h.makeNode('div');
    sidebar.setAttribute('data-testid', 'settings-sidebar');
    const listRoot = h.makeNode('div');
    const groupGeneral = h.makeNode('div');
    groupGeneral.className = 'flex flex-col gap-0.5';

    const makeVxItem = (name, active = false) => {
      const wrap = h.makeNode('div');
      wrap.className = 'relative group/nav-item mx-2';
      const btn = h.makeNode('button');
      btn.setAttribute('data-testid', `settings-nav-item-${name}`);
      btn.className = active ? 'flex items-center w-full bg-sidebar-secondary' : 'flex items-center w-full hover:bg-sidebar-muted';
      btn.textContent = name;
      wrap.appendChild(btn);
      return { wrap, btn };
    };
    const itemGeneral = makeVxItem('General', true);
    const itemBrowser = makeVxItem('Browser', false);
    // 预埋一个未绑定当前控制器的僵尸旧导航节点，验证 syncModalMount 会替换并重新绑定
    const staleWrap = h.makeNode('div');
    staleWrap.setAttribute('data-ag-hs-nav-wrapper', 'true');
    const staleBtn = h.makeNode('button');
    staleBtn.id = 'ag-cm-host-settings-nav';
    staleBtn.textContent = 'Stale Context Meter';
    staleWrap.appendChild(staleBtn);

    groupGeneral.appendChild(itemGeneral.wrap);
    groupGeneral.appendChild(itemBrowser.wrap);
    groupGeneral.appendChild(staleWrap);
    listRoot.appendChild(groupGeneral);
    sidebar.appendChild(listRoot);

    const rightPane = h.makeNode('div');
    rightPane.className = 'relative w-full h-full flex-1 flex flex-col';
    const nativeGeneral = h.makeNode('div');
    nativeGeneral.id = 'native-general-pane';
    nativeGeneral.textContent = 'General';
    rightPane.appendChild(nativeGeneral);

    splitRow.appendChild(sidebar);
    splitRow.appendChild(rightPane);
    modal.appendChild(splitRow);
    h.bodyNode.appendChild(modal);

    // 宿主先开设置（插件面板保持收起）
    h.api.syncHostSettingsForTest();
    const firstNavBtn = h.docElements.get('ag-cm-host-settings-nav');
    assert.ok(firstNavBtn && firstNavBtn !== staleBtn, '必须替换未绑定当前控制器的遗留僵尸按钮');
    assert.equal(firstNavBtn.parentElement.getAttribute('data-ag-hs-nav-wrapper'), 'true', 'VX 模式下应以同构 wrapper 挂入 navList');
    assert.equal(firstNavBtn.parentElement.parentElement, groupGeneral, 'wrapper 必须是 navList 直接子项');
    assert.equal(itemBrowser.wrap.nextElementSibling, firstNavBtn.parentElement, '必须紧跟在 Browser wrapper 之后而非塞进 Browser wrapper 内部');

    // 连续多次 syncModalMount 绝不得销毁重建按钮
    h.api.syncHostSettingsForTest();
    h.api.syncHostSettingsForTest();
    assert.equal(h.docElements.get('ag-cm-host-settings-nav'), firstNavBtn, '多次 syncModalMount 不得销毁重建导航按钮');

    // 一次点击直接激活 Context Meter
    firstNavBtn.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, true, '一次点击必须立即选中 Context Meter');
    assert.equal(nativeGeneral.hidden, true, '激活后必须隐藏原生 General 内容');
    assert.equal(firstNavBtn.getAttribute('data-active'), 'true');

    // General -> Context Meter -> Browser -> Context Meter 往返
    itemGeneral.btn.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, false);
    assert.equal(nativeGeneral.hidden, false);

    firstNavBtn.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, true);

    itemBrowser.btn.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, false);
    assert.equal(nativeGeneral.hidden, false);

    firstNavBtn.click();
    await h.flush();
    assert.equal(h.api.getHostSettingsStateForTest().selected, true);

    // 2. P0-2: Windows 独立菜单栏存在时仍注入 drag/no-drag 标题栏规则
    const titleMenuBar = h.makeNode('div');
    titleMenuBar.setAttribute('data-testid', 'title-menu-bar');
    h.bodyNode.appendChild(titleMenuBar);
    h.api.syncWindowControlsOverlayForTest();
    const fixStyle = h.docElements.get('ag-topbar-host-fix');
    assert.ok(fixStyle, '必须存在 #ag-topbar-host-fix 样式节点');
    assert.match(fixStyle.textContent, /\[data-testid="title-menu-bar"\][\s\S]*?-webkit-app-region:\s*drag/);
    assert.match(fixStyle.textContent, /\[class\*="@container\/titlebar"\]:not\(\[style\*="cursor: grab"\]\)/);
    assert.match(fixStyle.textContent, /\[data-testid="title-menu-bar"\] \[data-testid="title-menu-bar-item"\]/);

    // 3. P0-3: #global-restart-modal 模板必须为原生 <dialog>
    assert.match(TPL_SOURCE, /<dialog\s+id="global-restart-modal"/, 'global-restart-modal 必须使用原生 <dialog> 元素');
  } finally {
    h.api.dispose();
  }

  // 4. P0-4: 后端旧记录无 noticeId 零回放 + 新事件跨冷启动（清空 localStorage）零重播
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-p04-notice-'));
  try {
    const legacyStore = {
      version: 1,
      activeAccountEmail: 'b@example.com',
      accounts: {
        'a@example.com': { email: 'a@example.com', credential: { refreshToken: 'rA' } },
        'b@example.com': { email: 'b@example.com', credential: { refreshToken: 'rB' } }
      },
      autoSwitch: { enabled: true, poolKey: 'shared_gemini_main', windowKey: '5h', metricMode: 'remaining_pct', thresholdPct: 10, candidates: ['a@example.com'] },
      autoSwitchStatus: {
        state: 'watching',
        lastSwitchAtMs: 1795570170000,
        lastResult: {
          ok: true,
          trigger: 'auto_switch',
          fromEmail: 'a@example.com',
          toEmail: 'b@example.com',
          targetEmailMasked: 'b***@example.com',
          atMs: 1795570166000,
          verifiedEffective: true,
          verifiedAtMs: 1795570170000,
          message: '已自动切换至 b***@example.com，重启后已通过 GetUserStatus 核验生效。'
          // 刻意缺失 noticeId，复现 09:29:26 旧历史记录
        }
      },
      quotaIntervals: [],
      accountSessions: [],
      lastDiagnostics: []
    };
    fs.writeFileSync(path.join(tmpDir, 'accounts_v1.json'), JSON.stringify(legacyStore, null, 2), 'utf8');

    const mgr = accountsMod.createAccountsManager({ stateDir: tmpDir });
    const legacyOv = mgr.getOverviewState();
    assert.equal(legacyOv.autoSwitchStatus.lastResult.isLegacyNotice, true, '缺 noticeId 的历史成功记录必须识别为历史旧事件');
    assert.equal(legacyOv.autoSwitchStatus.lastResult.noticeConsumed, true, '缺 noticeId 的历史成功记录必须视为已消费零回放');
    assert.ok(legacyOv.autoSwitchStatus.lastResult.message, '历史记录本身仍保留可查阅');

    // 前端读取历史旧事件绝不弹窗
    const h1 = createBatch01Harness({ initialOverview: legacyOv });
    try {
      h1.api.setAccountsOverviewForTest(legacyOv);
      await h1.flush();
      const noticeStateLegacy = h1.api.getAutoSwitchNoticeStateForTest?.();
      assert.equal(Boolean(noticeStateLegacy?.visible), false, '缺 noticeId 的历史事件冷启动不得弹出成功提示');
    } finally {
      h1.api.dispose();
    }

    // 写入一条带新 noticeId 的新核验成功事件
    legacyStore.autoSwitchStatus.lastResult = {
      ...legacyStore.autoSwitchStatus.lastResult,
      noticeId: 'as_new_event_20261125_01',
      noticeConsumedAtMs: null
    };
    fs.writeFileSync(path.join(tmpDir, 'accounts_v1.json'), JSON.stringify(legacyStore, null, 2), 'utf8');
    const freshOv = mgr.getOverviewState();
    assert.equal(freshOv.autoSwitchStatus.lastResult.noticeConsumed, false);

    // 模拟后端 ack_auto_switch_notice 持久化落盘
    const ackRes = await accountsMod.dispatchAccountsAction(mgr, {
      action: 'ack_auto_switch_notice',
      noticeId: 'as_new_event_20261125_01'
    });
    assert.equal(ackRes.ok, true);
    assert.equal(ackRes.consumed, true);
    assert.ok(ackRes.overview.autoSwitchStatus.consumedNoticeIds.includes('as_new_event_20261125_01'));
    assert.equal(ackRes.overview.autoSwitchStatus.lastResult.noticeConsumed, true);

    // 模拟完全冷启动（新 manager 实例读取磁盘 + 全新渲染实例且 localStorage 完全为空）
    const mgrAfterRestart = accountsMod.createAccountsManager({ stateDir: tmpDir });
    const restartedOv = mgrAfterRestart.getOverviewState();
    assert.equal(restartedOv.autoSwitchStatus.lastResult.noticeConsumed, true, '跨冷启动后磁盘仍保持已消费状态');
    const h2 = createBatch01Harness({ initialOverview: restartedOv });
    try {
      h2.api.setAccountsOverviewForTest(restartedOv);
      await h2.flush();
      const noticeStateRestart = h2.api.getAutoSwitchNoticeStateForTest?.();
      assert.equal(Boolean(noticeStateRestart?.visible), false, '跨冷启动换随机端口清空 localStorage 后绝不得重播旧成功提示');
    } finally {
      h2.api.dispose();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
