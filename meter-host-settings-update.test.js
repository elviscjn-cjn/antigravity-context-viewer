'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const liveHost = require('./live-host');

const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const TPL_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');

function createHostSettingsTestHarness(options = {}) {
  const rendererPath = path.join(__dirname, 'meter-renderer.js');
  const source = fs.readFileSync(rendererPath, 'utf8');

  const elements = new Map();
  const docElements = new Map();
  const docListeners = new Map();
  const headChildren = [];
  const bodyChildren = [];
  const savedSettingsPayloads = [];
  const runtimeInfoQueue = [...(options.runtimeInfos || [])];
  const checkUpdateHandlers = [...(options.checkHandlers || [])];
  const applyUpdateHandlers = [...(options.applyHandlers || [])];

  function createMockNode(tagName = 'div') {
    const attrs = new Map();
    const listeners = new Map();
    const styleProps = new Map();
    let _innerHtml = '';

    const node = {
      tagName: String(tagName || 'div').toUpperCase(),
      children: [],
      parentElement: null,
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      title: '',
      tabIndex: 0,
      isConnected: true,
      style: {
        display: '',
        left: '',
        top: '',
        right: '',
        bottom: '',
        opacity: '',
        pointerEvents: '',
        setProperty(k, v) {
          styleProps.set(k, v);
          if (k === 'display') this.display = v;
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
        attrs.set('id', String(v));
        if (v) docElements.set(String(v), node);
      },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const list = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!list.includes(c)) list.push(c);
          attrs.set('class', list.join(' '));
        },
        remove(c) {
          const list = (attrs.get('class') || '').split(/\s+/).filter((x) => x && x !== c);
          attrs.set('class', list.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), node);
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        if (k === 'id') {
          const prev = attrs.get('id');
          if (prev && docElements.get(prev) === node) docElements.delete(prev);
        }
        attrs.delete(k);
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      get nextElementSibling() {
        if (!this.parentElement || !Array.isArray(this.parentElement.children)) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentElement.children.length
          ? this.parentElement.children[idx + 1]
          : null;
      },
      get previousElementSibling() {
        if (!this.parentElement || !Array.isArray(this.parentElement.children)) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx > 0 ? this.parentElement.children[idx - 1] : null;
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentElement && child.parentElement !== this && typeof child.remove === 'function') {
          child.remove();
        } else if (child.parentElement === this) {
          const curIdx = this.children.indexOf(child);
          if (curIdx >= 0) this.children.splice(curIdx, 1);
        }
        child.parentElement = this;
        child.isConnected = true;
        this.children.push(child);
        return child;
      },
      after(...nodes) {
        if (!this.parentElement || !Array.isArray(this.parentElement.children)) return;
        for (const n of nodes) {
          if (!n) continue;
          if (n.parentElement && typeof n.remove === 'function') n.remove();
          const curIdx = this.parentElement.children.indexOf(this);
          n.parentElement = this.parentElement;
          n.isConnected = true;
          this.parentElement.children.splice(curIdx + 1, 0, n);
        }
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx >= 0) this.parentElement.children.splice(idx, 1);
        }
        this.parentElement = null;
        this.isConnected = false;
      },
      contains(target) {
        if (!target) return false;
        if (target === this) return true;
        for (const child of this.children) {
          if (child === target || child.contains?.(target)) return true;
        }
        return false;
      },
      closest(sel) {
        let cur = this;
        const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
        while (cur) {
          for (const p of parts) {
            if (p.startsWith('.') && cur.classList?.contains?.(p.slice(1))) return cur;
            if (p.startsWith('#') && cur.id === p.slice(1)) return cur;
            if (p === '[role="dialog"]' && cur.getAttribute?.('role') === 'dialog') return cur;
            if (p === 'button' && cur.tagName === 'BUTTON') return cur;
            if (p === '[role="tab"]' && cur.getAttribute?.('role') === 'tab') return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const c of (n.children || [])) {
            if (matchesSelector(c, sel)) res.push(c);
            walk(c);
          }
        };
        walk(this);
        return res;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      replaceChildren(...items) {
        this.children = [];
        for (const it of items) this.appendChild(it);
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
        if (!evt.target) evt.target = this;
        const fns = listeners.get(evt.type) || [];
        for (const fn of [...fns]) fn(evt);
        if (this.parentElement) {
          const parentCapturing = this.parentElement._listenersMap?.get(evt.type) || [];
          for (const fn of [...parentCapturing]) fn(evt);
        }
      },
      click() {
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
      },
      trigger(type, extra = {}) {
        this.dispatchEvent({ type, target: this, preventDefault() {}, stopPropagation() {}, ...extra });
      },
      getBoundingClientRect() {
        return { left: 200, top: 600, width: 120, height: 26, right: 320, bottom: 626 };
      },
      get innerHTML() {
        return _innerHtml;
      },
      set innerHTML(val) {
        _innerHtml = String(val || '');
        if (_innerHtml && (this.id === 'ag-cm-host-settings-page' || this.id === 'ag-cm-host-settings-nav')) {
          this.children = [];
          let nsRoot = null;
          for (const m of _innerHtml.matchAll(/<(section|button|input|select|span|h1|h2|p|div|header|label)\b([^>]*)>/gi)) {
            const rawAttrs = m[2] || '';
            const idMatch = rawAttrs.match(/\bid="([^"]+)"/i);
            const hasNsAttr = /\bdata-ag-ns-(seg|switch|select|input|action|color)\b/i.test(rawAttrs);
            if (!idMatch && !hasNsAttr) continue;
            const sub = createMockNode(m[1]);
            if (idMatch) sub.id = idMatch[1];
            for (const am of rawAttrs.matchAll(/\b(data-[a-z0-9-]+|role|type|aria-[a-z-]+)="([^"]*)"/gi)) {
              sub.setAttribute(am[1], am[2]);
            }
            if (sub.id === 'ag-ns-root') {
              nsRoot = sub;
              this.appendChild(sub);
            } else if (nsRoot) {
              nsRoot.appendChild(sub);
            } else {
              this.appendChild(sub);
            }
          }
        }
      },
      _listenersMap: listeners
    };
    return node;
  }

  function matchesSelector(node, sel) {
    const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (p.startsWith('#') && node.id === p.slice(1)) return true;
      if (p.startsWith('.') && node.classList?.contains?.(p.slice(1))) return true;
      const attrOnly = p.match(/^\[([a-z0-9-]+)\]$/i);
      if (attrOnly && node.hasAttribute?.(attrOnly[1])) return true;
      const attrEq = p.match(/^\[([a-z0-9-]+)="([^"]*)"\]$/i);
      if (attrEq && node.getAttribute?.(attrEq[1]) === attrEq[2]) return true;
      if (p === 'button' && node.tagName === 'BUTTON') return true;
      if (p === 'button[id^="settings-nav-item-"]' && node.tagName === 'BUTTON' && String(node.id || '').startsWith('settings-nav-item-')) return true;
      if (p === '#settings-nav-item-Browser' && node.id === 'settings-nav-item-Browser') return true;
      if (p === '#ag-cm-host-settings-nav' && node.id === 'ag-cm-host-settings-nav') return true;
    }
    return false;
  }

  const host = createMockNode('div');
  host.attachShadow = () => ({
    set innerHTML(_) { },
    getElementById(id) {
      if (!elements.has(id)) {
        const n = createMockNode('div');
        n._idShadow = id;
        elements.set(id, n);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() { },
    removeEventListener() { }
  });

  const bodyNode = createMockNode('body');
  bodyNode.children = bodyChildren;
  const headNode = createMockNode('head');
  headNode.children = headChildren;

  const docRoot = createMockNode('html');
  docRoot.appendChild(headNode);
  docRoot.appendChild(bodyNode);

  const lStoreMap = new Map();
  const lStore = {
    getItem: (k) => (lStoreMap.has(k) ? lStoreMap.get(k) : null),
    setItem: (k, v) => lStoreMap.set(k, String(v)),
    removeItem: (k) => lStoreMap.delete(k),
    clear: () => lStoreMap.clear()
  };

  let firstCreate = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/phase7-test-route' },
    document: {
      hidden: false,
      head: headNode,
      body: bodyNode,
      documentElement: docRoot,
      createElement(tag) {
        if (firstCreate) {
          firstCreate = false;
          return host;
        }
        return createMockNode(tag);
      },
      getElementById(id) {
        return docElements.get(id) || null;
      },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const c of (n.children || [])) {
            if (matchesSelector(c, sel)) res.push(c);
            walk(c);
          }
        };
        walk(docRoot);
        return res;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
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
      innerHeight: 800,
      __APP_CONFIG__: { csrfToken: 'test-token' },
      contextMeterAPI: {
        scan: async () => ({ ok: true, data: { session: null, scannedAt: Date.now() } }),
        getSettings: async () => ({ ok: true, ...(options.initialSettings || {}) }),
        saveSettings: async (payload) => {
          savedSettingsPayloads.push(payload);
          return { ok: true };
        },
        checkUpdate: options.noUpdateBridge ? undefined : async (req) => {
          const nextFn = checkUpdateHandlers.shift();
          return nextFn ? nextFn(req) : { ok: true, hasUpdate: false, currentVersion: '0.9.2', installedVersion: '0.9.2' };
        },
        applyUpdate: options.noUpdateBridge ? undefined : async (req) => {
          const nextFn = applyUpdateHandlers.shift();
          return nextFn ? nextFn(req) : { ok: true, diskInstalled: false, liveStaged: true, downloaded: true, version: req?.version };
        },
        getRuntimeInfo: async () => {
          if (runtimeInfoQueue.length > 0) return runtimeInfoQueue.shift();
          return { ok: true, backendVersion: options.initialBackendVersion || '0.9.2' };
        },
        getQuota: async () => ({ ok: true, collectorVersion: options.initialBackendVersion || '0.9.2', pools: [] })
      }
    },
    localStorage: lStore,
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => { },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  function mountHostSettingsModal() {
    const modal = createMockNode('div');
    modal.className = 'settings-modal-container flex flex-row';
    modal.setAttribute('role', 'dialog');

    const navList = createMockNode('div');
    navList.className = 'settings-nav-list';
    const btnGen = createMockNode('button');
    btnGen.id = 'settings-nav-item-General';
    btnGen.textContent = 'General';
    btnGen.setAttribute('aria-selected', 'true');
    const btnBrowser = createMockNode('button');
    btnBrowser.id = 'settings-nav-item-Browser';
    btnBrowser.className = 'flex items-center px-3 py-2 text-sm';
    btnBrowser.textContent = 'Browser';
    const btnAccount = createMockNode('button');
    btnAccount.id = 'settings-nav-item-Account';
    btnAccount.textContent = 'Account';
    navList.appendChild(btnGen);
    navList.appendChild(btnBrowser);
    navList.appendChild(btnAccount);

    const contentPane = createMockNode('div');
    contentPane.setAttribute('data-settings-content-pane', 'true');
    const nativePane1 = createMockNode('div');
    nativePane1.id = 'native-pane-general';
    nativePane1.textContent = 'General Settings';
    const nativePane2 = createMockNode('div');
    nativePane2.id = 'native-pane-browser';
    nativePane2.textContent = 'Browser Settings';
    nativePane2.style.display = 'flex';
    contentPane.appendChild(nativePane1);
    contentPane.appendChild(nativePane2);

    modal.appendChild(navList);
    modal.appendChild(contentPane);
    bodyNode.appendChild(modal);

    return { modal, navList, btnGen, btnBrowser, btnAccount, contentPane, nativePane1, nativePane2 };
  }

  return {
    sandbox,
    host,
    elements,
    docElements,
    bodyNode,
    lStoreMap,
    savedSettingsPayloads,
    createMockNode,
    mountHostSettingsModal,
    flush: () => new Promise((resolve) => setTimeout(resolve, 10))
  };
}

test('Phase 7.2: computeStrictUpdateState 严格三态与防假报Active校验', () => {
  const unavail = core.computeStrictUpdateState({ hasBridge: false, rendererVersion: '0.9.2' });
  assert.equal(unavail.stage, 'unavailable');

  // 免改盘暂存：必须严格停留在 downloaded（已下载）
  const liveDownloaded = core.computeStrictUpdateState({
    hasBridge: true,
    rendererVersion: '0.9.2',
    backendVersion: '0.9.2',
    applyResult: { ok: true, diskInstalled: false, liveStaged: true, downloaded: true, stagedVersion: '0.9.3', liveInjected: false }
  });
  assert.equal(liveDownloaded.stage, 'downloaded');
  assert.equal(liveDownloaded.downloaded, true);
  assert.equal(liveDownloaded.activeConfirmed, false);

  // 磁盘更新后未重开：必须停留在 pending_restart
  const diskPending = core.computeStrictUpdateState({
    hasBridge: true,
    rendererVersion: '0.9.2',
    backendVersion: '0.9.2',
    targetVersion: '0.9.3',
    applyResult: { ok: true, diskInstalled: true, liveInjected: false, version: '0.9.3' }
  });
  assert.equal(diskPending.stage, 'pending_restart');

  // 前端热注入已是 0.9.3 但后端仍为 0.9.2：严格禁报 新版已生效，停留在 pending_restart
  const halfReloaded = core.computeStrictUpdateState({
    hasBridge: true,
    rendererVersion: '0.9.3',
    backendVersion: '0.9.2',
    targetVersion: '0.9.3',
    applyResult: { ok: true, diskInstalled: true, liveInjected: true, backendHotReloaded: false, version: '0.9.3' }
  });
  assert.equal(halfReloaded.stage, 'pending_restart');
  assert.equal(halfReloaded.backendMismatch, true);
  assert.equal(halfReloaded.activeConfirmed, false);

  // 仅当渲染器与实测后台均对齐 targetVersion 且无待重启标记才返回 active
  const bothActive = core.computeStrictUpdateState({
    hasBridge: true,
    rendererVersion: '0.9.3',
    backendVersion: '0.9.3',
    backendSource: 'live-host',
    targetVersion: '0.9.3',
    backendVersionMismatch: false,
    pendingUpdateRestart: false,
    applyResult: { ok: true, diskInstalled: true, liveInjected: true, backendHotReloaded: true, version: '0.9.3' }
  });
  assert.equal(bothActive.stage, 'active');
  assert.equal(bothActive.activeConfirmed, true);

  // 错误态保留现行运行版本
  const errState = core.computeStrictUpdateState({
    hasBridge: true,
    rendererVersion: '0.9.2',
    backendVersion: '0.9.2',
    actionPhase: 'error',
    lastError: 'SHA-256 校验失败'
  });
  assert.equal(errState.stage, 'error');
  assert.equal(errState.rendererVersion, '0.9.2');
});

test('Phase 7.1: 宿主原生设置融合单实例挂载、无损切换与恢复、双向实时同步与防重重开', async () => {
  const h = createHostSettingsTestHarness({ initialBackendVersion: '0.9.2' });
  const api = h.sandbox.__AGContextMeter;
  try {
    await h.flush();
    const modalCtx = h.mountHostSettingsModal();

    // 多次重复同步不得生成重复导航按钮，并紧贴 settings-nav-item-Browser 下方
    assert.equal(api.syncHostSettingsForTest(), true);
    assert.equal(api.syncHostSettingsForTest(), true);
    const navBtn = h.docElements.get('ag-cm-host-settings-nav');
    assert.ok(navBtn, '必须挂载 #ag-cm-host-settings-nav');
    assert.equal(modalCtx.btnBrowser.nextElementSibling, navBtn, '导航项必须紧贴 Browser 下方');
    assert.equal(api.getHostSettingsStateForTest().navCountInDoc, 1, '严禁生成重复导航项');

    // 点击 Context Meter：无损隐藏原生右侧设置子节点，展示共享专页
    navBtn.click();
    assert.equal(api.getHostSettingsStateForTest().selected, true);
    assert.equal(modalCtx.nativePane1.hidden, true);
    assert.equal(modalCtx.nativePane2.hidden, true);
    assert.equal(modalCtx.nativePane1.getAttribute('data-ag-hs-hidden'), 'true');
    assert.ok(modalCtx.contentPane.contains(modalCtx.nativePane1), '原生面板节点只能隐藏不得删除');
    const pageEl = h.docElements.get('ag-cm-host-settings-page');
    assert.equal(pageEl.hidden, false);

    // 双向实时同步 1：在宿主设置专页切换 下一句预测 -> 插件面板复选框同步改变并保存
    const hsSwNext = h.docElements.get('ag-ns-sw-nextPromptEnabled');
    assert.ok(hsSwNext, '必须渲染 #ag-ns-sw-nextPromptEnabled');
    hsSwNext.click();
    assert.equal(h.elements.get('chk-next-prompt-enabled').checked, true);
    assert.equal(api.getUpdateStateForTest().nextPromptEnabled, true);
    assert.equal(hsSwNext.getAttribute('aria-checked'), 'true');
    assert.ok(h.savedSettingsPayloads.some((p) => p.nextPromptEnabled === true));

    // 双向实时同步 2：在插件面板切换 chk-next-prompt-enabled -> 宿主专页开关同步还原
    const mainChkNext = h.elements.get('chk-next-prompt-enabled');
    mainChkNext.checked = false;
    mainChkNext.trigger('change', { target: mainChkNext });
    assert.equal(hsSwNext.getAttribute('aria-checked'), 'false');

    // 双向实时同步 3：测试版通道开关双向同步
    const hsSwBeta = h.docElements.get('ag-ns-sw-betaChannel');
    assert.ok(hsSwBeta, '必须渲染 #ag-ns-sw-betaChannel');
    hsSwBeta.click();
    assert.equal(h.elements.get('check-allow-beta-updates').checked, true);
    assert.equal(hsSwBeta.getAttribute('aria-checked'), 'true');

    // 快捷直达插件账号 / 额度 / 用量面板
    h.docElements.get('ag-hs-btn-open-quota').click();
    assert.equal(h.elements.get('panel-quota').hidden, false);
    h.docElements.get('ag-hs-btn-open-tokens').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false);
    h.docElements.get('ag-hs-btn-open-accounts').click();
    assert.equal(h.elements.get('panel').hidden, false);

    // 点回宿主原生标签 Account -> 专页隐藏，原生子节点无损还原先前 display 状态
    modalCtx.btnAccount.click();
    assert.equal(api.getHostSettingsStateForTest().selected, false);
    assert.equal(pageEl.hidden, true);
    assert.equal(modalCtx.nativePane1.hidden, false);
    assert.equal(modalCtx.nativePane2.hidden, false);
    assert.equal(modalCtx.nativePane2.style.display, 'flex');
    assert.equal(modalCtx.nativePane1.getAttribute('data-ag-hs-hidden'), null);

    // 弹窗关闭后重新打开新弹窗：单实例防重不遗留状态
    modalCtx.modal.remove();
    const modalCtx2 = h.mountHostSettingsModal();
    assert.equal(api.syncHostSettingsForTest(), true);
    assert.equal(api.getHostSettingsStateForTest().navCountInDoc, 1);
    assert.equal(modalCtx2.btnBrowser.nextElementSibling.id, 'ag-cm-host-settings-nav');
    assert.equal(api.getHostSettingsStateForTest().selected, false);
  } finally {
    api.dispose();
  }
});

test('Phase 7.2: 严格三态更新流程、跨热加载校验对齐后转 Active 与失败保留现行状态', async () => {
  const h = createHostSettingsTestHarness({
    initialBackendVersion: '0.9.0',
    checkHandlers: [
      async () => ({
        ok: true,
        hasUpdate: true,
        currentVersion: '0.9.0',
        latestVersion: '0.9.5-beta.1',
        prerelease: true,
        releaseNotes: 'Test beta release'
      }),
      async () => ({
        ok: true,
        hasUpdate: true,
        currentVersion: '0.9.0',
        latestVersion: '0.9.5',
        prerelease: false,
        releaseNotes: 'Test failure release'
      })
    ],
    applyHandlers: [
      // 第一轮：免改盘仅暂存 -> downloaded
      async (req) => {
        assert.equal(req.allowBetaUpdates, true);
        assert.equal(req.prerelease, true);
        return {
          ok: true,
          diskInstalled: false,
          liveStaged: true,
          downloaded: true,
          stagedVersion: '0.9.5-beta.1',
          version: '0.9.5-beta.1',
          liveInjected: false
        };
      },
      // 第二轮：下载校验失败 -> error，且保留用户偏好和可点击重试
      async () => ({ ok: false, error: 'checksum mismatch' })
    ],
    runtimeInfos: [
      { ok: true, backendVersion: '0.9.0' }
    ]
  });
  const api = h.sandbox.__AGContextMeter;
  try {
    await h.flush();
    const modalCtx = h.mountHostSettingsModal();
    api.syncHostSettingsForTest();
    h.docElements.get('ag-cm-host-settings-nav').click();

    await api.checkUpdate(true);
    assert.equal(api.getStrictUpdateState().stage, 'available');
    assert.equal(h.docElements.get('ag-hs-update-stage-pill').getAttribute('data-stage'), 'available');

    // 应用免改盘更新 -> 停在 downloaded，不隐藏重试也不要求重启改盘
    await api.applyUpdate();
    const afterLive = api.getStrictUpdateState();
    assert.equal(afterLive.stage, 'downloaded');
    assert.equal(h.docElements.get('ag-hs-update-stage-pill').getAttribute('data-stage'), 'downloaded');
    assert.equal(h.docElements.get('ag-hs-btn-restart-host').hidden, true);

    // 开启设置项后触发更新失败：必须停留在 error 且保留设置、允许重试
    api.setNextPromptEnabledForTest(true);
    await api.checkUpdate(true);
    await api.applyUpdate();
    const afterFail = api.getStrictUpdateState();
    assert.equal(afterFail.stage, 'error');
    assert.equal(api.getUpdateStateForTest().nextPromptEnabled, true, '更新失败不得重置已有配置');
    assert.equal(h.docElements.get('ag-hs-btn-apply-update').hidden, false, '更新失败必须保留重试按钮');

    // 模拟跨热重载升级验证：新前端已到当前版本，后端尚未对齐前停在 pending_restart，对齐后才转 active
    const currentVer = h.sandbox.__AGContextMeter.version;
    api.setBackendStatusForTest({ backendVersion: '0.8.9', backendSource: 'electron-ipc' });
    api.applyInheritedHotReloadStateForTest({
      updateState: {
        targetVersion: currentVer,
        activatedTarget: true,
        actionPhase: 'idle',
        applyResult: { ok: true, diskInstalled: true, liveInjected: true, backendHotReloaded: false, version: currentVer }
      }
    });
    assert.equal(api.getStrictUpdateState().stage, 'pending_restart');

    api.setBackendStatusForTest({ backendVersion: currentVer, backendSource: 'live-host' });
    assert.equal(api.getStrictUpdateState().stage, 'active');
    assert.equal(h.docElements.get('ag-hs-update-stage-pill').getAttribute('data-stage'), 'active');
    modalCtx.modal.remove();
  } finally {
    api.dispose();
  }
});

test('Phase 7.2: live-host HTTP /apply-update 与 /shutdown 并发防早退保护', async () => {
  let resolveApply;
  let shutdownCalled = 0;
  const server = http.createServer(liveHost.createLiveRequestHandler({
    api: { origin: 'http://127.0.0.1:12345', origins: ['http://127.0.0.1:12345'] },
    secret: 'test-secret',
    onShutdown: () => { shutdownCalled += 1; },
    _applyUpdateAsync: async () => new Promise((resolve) => {
      resolveApply = resolve;
    })
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const postRoute = (route, payload) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:12345',
        'X-AG-Context-Token': 'test-secret',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload || {}));
  });

  try {
    const applyPromise = postRoute('/apply-update', { version: '0.9.5' });
    await new Promise((r) => setTimeout(r, 30));
    const shutdownRes = await postRoute('/shutdown', {});
    assert.equal(shutdownRes.status, 200);
    assert.equal(shutdownRes.body.deferredForApplyUpdate, true);
    assert.equal(shutdownCalled, 0, '/apply-update 进行中绝不能立刻退出');

    resolveApply({ ok: true, diskInstalled: false, liveStaged: true, downloaded: true, version: '0.9.5' });
    const applyRes = await applyPromise;
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.ok, true);
    assert.equal(applyRes.body.downloaded, true);

    await new Promise((r) => setTimeout(r, 320));
    assert.equal(shutdownCalled, 1, '更新响应发回后才延迟执行优雅退出');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Phase 7.3: 底栏开关解耦、#csb-group-status 直达与窄窗优先露出 + 新增三语零括号检验', async () => {
  // 1. 静态检查: #composer-status-bar 初始 hidden 且 Shadow DOM 严格隐身（防 Issue #101 顶栏泄露）
  assert.match(TPL_SOURCE, /<div id="composer-status-bar" class="composer-status-bar" data-dock="composer" hidden>/);
  assert.match(STYLES_SOURCE, /:host #composer-status-bar,\s*\.composer-status-bar\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(STYLES_SOURCE, /\.composer-status-bar\[data-csb-width="tight"\] \.csb-runtime-pill[\s\S]*order:\s*-10 !important/);

  // 2. 新增 i18n 词条三语完备且严禁中英文括号
  const keys = [
    'update.doneLiveSynced', 'composer.runtime.clickHint',
    'hostSettings.subtitle', 'hostSettings.sec.version', 'hostSettings.stage.downloaded',
    'hostSettings.stage.pendingRestart', 'hostSettings.stage.active', 'hostSettings.beta.label'
  ];
  for (const key of keys) {
    const match = I18N_SOURCE.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{[^\\n]+\\}`));
    assert.ok(match, `缺少三语词条: ${key}`);
    for (const langTag of ["'zh-CN'", "'zh-TW'", 'en']) {
      assert.ok(match[0].includes(langTag), `${key} 缺少 ${langTag}`);
    }
    assert.doesNotMatch(match[0], /[（）\(\)]/, `${key} 不得包含括号`);
  }

  // 3. 运行时底栏窄窗 tight 下 widthMode 更新与 #csb-group-status 点击直达且不触发五线卡片
  const h = createHostSettingsTestHarness();
  const api = h.sandbox.__AGContextMeter;
  try {
    await h.flush();
    h.sandbox.window.innerWidth = 420;
    api.setComposerStateForTest({
      allTurns: [1],
      sessionCalls: [{ callId: 'c1', inputTokens: 1200, outputTokens: 200, cacheReadTokens: 800 }],
      sessionStats: { usedTokens: 2000, limitTokens: 100000 }
    });
    assert.equal(h.elements.get('composer-status-bar').getAttribute('data-csb-width'), 'tight');

    const statusBtn = h.elements.get('csb-group-status');
    assert.match(statusBtn.getAttribute('data-tooltip') || '', /点击查看实时请求/);
    statusBtn.click();
    assert.equal(h.elements.get('panel-tokens').hidden, false, '#csb-group-status 点击必须直达实时请求与用量面板');
    assert.equal(h.elements.get('token-five-line-card').hidden, true, '必须保持 token-five-line-card 隐藏契约');
  } finally {
    api.dispose();
  }
});
