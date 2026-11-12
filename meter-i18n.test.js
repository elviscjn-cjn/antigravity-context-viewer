'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// 隔离 APPDATA 防止探测真实宿主窗口端口
const isolatedAppData = path.join(os.tmpdir(), 'ag-meter-i18n-test-appdata');
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;

const { builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const { restore } = require('./restore');
const {
  SIGNATURE_START,
  readI18nConfig,
  saveI18nConfig,
  loadDictionary,
  generatePreloadI18nScript,
  injectPreloadI18n,
  stripPreloadI18n,
  injectMenuI18n,
  stripMenuI18n,
  injectTrayI18n,
  stripTrayI18n,
  injectLoadingI18n,
  stripLoadingI18n,
  injectUpdaterI18n,
  stripUpdaterI18n,
  inspectPreloadI18nState,
  getI18nStatus
} = require('./meter-i18n');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

const STOCK_SAMPLES = {
  preload: `"use strict";
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("electronNative", {
    showContextMenu: (items) => electron_1.ipcRenderer.invoke("window:show-context-menu", items)
});
`,
  menu: `"use strict";
const electron_1 = require("electron");
function setupMenu(menu) {
    electron_1.Menu.setApplicationMenu(menu);
}
module.exports = { setupMenu };
`,
  tray: `"use strict";
const electron_1 = require("electron");
function createTray(actions) {
    const tray = new electron_1.Tray("icon.png");
    const countItem = { label: "No agents running" };
    const contextMenu = electron_1.Menu.buildFromTemplate(actions);
    tray.setContextMenu(contextMenu);
    function updateCount(count) {
        countItem.label =
                (count > 0 ? \`\${count}\` : 'No') +
                    ' agent' +
                    (count === 1 ? '' : 's') +
                    ' running';
    }
    return { tray, updateCount };
}
module.exports = { createTray };
`,
  loadingOverlay: `"use strict";
const html = '<div class="loading"><div class="text">Loading Antigravity</div></div>';
module.exports = { html };
`,
  updater: `"use strict";
function notifyUpToDate(dialog) {
    return dialog.showMessageBox({
                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],
    });
}
module.exports = { notifyUpToDate };
`
};

test('简繁词典加载与左上角品牌名三种策略（english / hidden / translated）验证', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-dict-'));
  try {
    const zhDictEnBrand = loadDictionary({ locale: 'zh-CN', brandTitle: 'english', stateDir: tmpState });
    const zhDictHiddenBrand = loadDictionary({ locale: 'zh-CN', brandTitle: 'hidden', stateDir: tmpState });
    const zhDictTransBrand = loadDictionary({ locale: 'zh-CN', brandTitle: 'translated', stateDir: tmpState });
    const twDictEnBrand = loadDictionary({ locale: 'zh-TW', brandTitle: 'english', stateDir: tmpState });

    assert.ok(Object.keys(zhDictEnBrand).length > 500, '简中词典应包含完整词条');
    assert.ok(Object.keys(twDictEnBrand).length > 500, '繁中词典应包含完整词条');

    assert.equal('Antigravity' in zhDictEnBrand, false, 'english 策略应移除 Antigravity 词条以保留英文原名');
    assert.equal(zhDictHiddenBrand.Antigravity, '', 'hidden 策略应将 Antigravity 映射为空字符串');
    assert.ok(zhDictTransBrand.Antigravity.includes('反重力'), 'translated 策略应保留中文品牌名');

    // 验证生成的 preload 脚本包含 #ag-context-meter 物理隔离选择器与合法 JS 语法
    const script = generatePreloadI18nScript({ locale: 'zh-CN', brandTitle: 'english', stateDir: tmpState });
    assert.ok(script.includes('#ag-context-meter'), '必须对上下文查看器组件做物理隔离');
    assert.doesNotThrow(() => new vm.Script(script), '生成的 preload 注入脚本必须通过 VM 语法校验');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('五大宿主模块（preload/menu/tray/loadingOverlay/updater）简繁切换、语法与幂等无损剥离', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-modules-'));
  try {
    for (const locale of ['zh-CN', 'zh-TW']) {
      for (const brandTitle of ['english', 'hidden', 'translated']) {
        const pPatched = injectPreloadI18n(STOCK_SAMPLES.preload, { locale, brandTitle, stateDir: tmpState });
        const mPatched = injectMenuI18n(STOCK_SAMPLES.menu, { locale, stateDir: tmpState });
        const tPatched = injectTrayI18n(STOCK_SAMPLES.tray, { locale, stateDir: tmpState });
        const lPatched = injectLoadingI18n(STOCK_SAMPLES.loadingOverlay, { locale, stateDir: tmpState });
        const uPatched = injectUpdaterI18n(STOCK_SAMPLES.updater, { locale, stateDir: tmpState });

        assert.ok(pPatched.includes(SIGNATURE_START));
        const detected = inspectPreloadI18nState(pPatched);
        assert.equal(detected.active, true);
        assert.equal(detected.locale, locale);
        assert.equal(detected.brandTitle, brandTitle);

        // 确保 tray.js 不含原版未定义的 USE_TW 引用，且全部模块均是合法 JS
        assert.equal(tPatched.includes('USE_TW'), false, 'tray.js 注入代码不得引用未定义变量 USE_TW');
        for (const [modName, code] of Object.entries({ pPatched, mPatched, tPatched, lPatched, uPatched })) {
          assert.doesNotThrow(() => new vm.Script(code), `${modName} (${locale}/${brandTitle}) 必须通过 VM 语法编译`);
        }

        // 验证剥离后 100% 逐字符还原为官方英文原版
        assert.equal(stripPreloadI18n(pPatched), STOCK_SAMPLES.preload);
        assert.equal(stripMenuI18n(mPatched), STOCK_SAMPLES.menu);
        assert.equal(stripTrayI18n(tPatched), STOCK_SAMPLES.tray);
        assert.equal(stripLoadingI18n(lPatched), STOCK_SAMPLES.loadingOverlay);
        assert.equal(stripUpdaterI18n(uPatched), STOCK_SAMPLES.updater);
      }
    }
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('完整桌面端 ASAR 集成生命周期：开箱简中 -> 切换繁中+隐藏品牌 -> 切回官方英文 -> restore 100% 还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-asar-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const stateDir = path.join(tmpDir, 'state');
  process.env.AG_METER_STATE_DIR = stateDir;

  try {
    // 1. 构造含完整 5 大模块的官方英文原版 app.asar
    const srcDir = path.join(tmpDir, 'stock-src');
    fs.mkdirSync(path.join(srcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.31.0' }), 'utf8');
    fs.writeFileSync(
      path.join(srcDir, 'dist', 'utils.js'),
      `"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(srcDir, 'dist', 'preload.js'), STOCK_SAMPLES.preload, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'menu.js'), STOCK_SAMPLES.menu, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'tray.js'), STOCK_SAMPLES.tray, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'loadingOverlay.js'), STOCK_SAMPLES.loadingOverlay, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'updater.js'), STOCK_SAMPLES.updater, 'utf8');

    const targetAsar = path.join(tmpDir, 'app.asar');
    await builtinAsar.createPackageWithOptions(srcDir, targetAsar, {});

    // 记录原版包内每个文件的 SHA256
    const stockExtract = path.join(tmpDir, 'stock-verify');
    builtinAsar.extractAll(targetAsar, stockExtract);
    const stockHashes = {};
    for (const rel of ['package.json', 'dist/utils.js', 'dist/preload.js', 'dist/menu.js', 'dist/tray.js', 'dist/loadingOverlay.js', 'dist/updater.js']) {
      stockHashes[rel] = sha256(fs.readFileSync(path.join(stockExtract, ...rel.split('/'))));
    }

    // 2. 默认首次安装：因含完整桌面模块，默认启用 zh-CN + english 品牌
    const m1 = await install({ asarPath: targetAsar, skipHotInject: true });
    assert.equal(m1.i18n.locale, 'zh-CN');
    assert.equal(m1.i18n.brandTitle, 'english');

    const st1 = getI18nStatus({ asarPath: targetAsar, stateDir });
    assert.equal(st1.locale, 'zh-CN');
    assert.equal(st1.brandTitle, 'english');

    // 3. 切换为繁體中文 + 隐藏左上角品牌名
    saveI18nConfig({ locale: 'zh-TW', brandTitle: 'hidden' }, { stateDir });
    assert.equal(readI18nConfig({ stateDir }).locale, 'zh-TW');
    const m2 = await install({ asarPath: targetAsar, locale: 'zh-TW', brandTitle: 'hidden', skipHotInject: true });
    assert.equal(m2.i18n.locale, 'zh-TW');
    assert.equal(m2.i18n.brandTitle, 'hidden');

    const st2 = getI18nStatus({ asarPath: targetAsar, stateDir });
    assert.equal(st2.locale, 'zh-TW');
    assert.equal(st2.brandTitle, 'hidden');

    // 4. 在保留上下文查看器插件的前提下，仅关闭界面汉化（切回官方英文 en）
    const m3 = await install({ asarPath: targetAsar, locale: 'en', skipHotInject: true });
    assert.equal(m3.i18n.locale, 'en');
    const st3 = getI18nStatus({ asarPath: targetAsar, stateDir });
    assert.equal(st3.locale, 'en');

    const enExtract = path.join(tmpDir, 'en-verify');
    builtinAsar.extractAll(targetAsar, enExtract);
    for (const rel of ['dist/menu.js', 'dist/tray.js', 'dist/loadingOverlay.js', 'dist/updater.js']) {
      assert.equal(
        sha256(fs.readFileSync(path.join(enExtract, ...rel.split('/')))),
        stockHashes[rel],
        `关闭汉化后 ${rel} 应完全还原为官方英文原版`
      );
    }
    const enPreload = fs.readFileSync(path.join(enExtract, 'dist', 'preload.js'), 'utf8');
    assert.equal(enPreload.includes(SIGNATURE_START), false, '关闭汉化后 preload.js 不应含汉化签名块');
    assert.ok(enPreload.includes('contextMeterAPI'), '关闭汉化后上下文查看器桥接仍须正常保留');

    // 5. 执行完整卸载 restore()，验证所有文件 100% 还原为官方原版
    await restore({ path: targetAsar });
    const restoredExtract = path.join(tmpDir, 'restored-verify');
    builtinAsar.extractAll(targetAsar, restoredExtract);
    for (const [rel, expectedHash] of Object.entries(stockHashes)) {
      assert.equal(
        sha256(fs.readFileSync(path.join(restoredExtract, ...rel.split('/')))),
        expectedHash,
        `卸载还原后 ${rel} 哈希必须与原版 100% 一致`
      );
    }
  } finally {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('前端渲染层联动：自动中文标题、简繁英切换、品牌按钮禁用与胶囊状态实时刷新', async () => {
  const core = require('./meter-core');
  const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const listeners = new Map();

  const makeEl = () => {
    const attrs = new Map();
    const node = {
      style: { display: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', cur.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        listeners.get(node).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(node)?.get('click')?.(); },
      getBoundingClientRect: () => ({ left: 100, top: 10, width: 20, height: 20, right: 120, bottom: 30 })
    };
    return node;
  };

  let kernelState = {
    ok: true,
    supported: true,
    binaries: [{ id: 'cli', label: '桌面端内核', exists: true, bakExists: true, promptTier: 0, contextMode: 'stock', chineseTitleMode: 'en', chineseTitleEnabled: false }],
    summary: { promptTier: 0, contextMode: 'stock', chineseTitleMode: 'en', chineseTitleEnabled: false, totalCapacityBytes: 22363, activeSlotBytes: 22363, savedBytes: 0, slotCount: 13 }
  };
  let i18nState = {
    ok: true,
    locale: 'zh-CN',
    localeLabel: '简体中文',
    brandTitle: 'english',
    brandTitleLabel: '保留英文 Antigravity (推荐)',
    brandTitleShortLabel: 'Antigravity',
    dictEntryCount: 4325
  };
  const kernelPayloads = [];
  const i18nPayloads = [];

  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    }
  });

  let firstCreate = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => { if (firstCreate) { firstCreate = false; return host; } return makeEl(); },
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        getKernelStatus: async () => kernelState,
        applyKernelPatch: async payload => {
          kernelPayloads.push(payload);
          const nextTier = payload.promptTier !== undefined ? Number(payload.promptTier) : kernelState.summary.promptTier;
          const nextCtx = payload.contextMode || kernelState.summary.contextMode;
          const nextZh = payload.chineseTitle !== undefined ? Boolean(payload.chineseTitle) : kernelState.summary.chineseTitleEnabled;
          kernelState = {
            ...kernelState,
            summary: {
              ...kernelState.summary,
              promptTier: nextTier,
              contextMode: nextCtx,
              chineseTitleMode: nextZh ? 'zh' : 'en',
              chineseTitleEnabled: nextZh
            }
          };
          return { ok: true, status: kernelState, logs: ['✔ 内核已更新'] };
        },
        getI18nStatus: async () => i18nState,
        applyI18nConfig: async payload => {
          i18nPayloads.push(payload);
          const loc = payload.locale || i18nState.locale;
          const br = payload.brandTitle || i18nState.brandTitle;
          i18nState = {
            ...i18nState,
            locale: loc,
            localeLabel: loc === 'zh-TW' ? '繁體中文' : (loc === 'en' ? '官方英文 (关闭汉化)' : '简体中文'),
            brandTitle: br
          };
          return { ok: true, status: i18nState };
        }
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => new Promise(() => {})
  };

  vm.createContext(sandbox);
  vm.runInContext(rendererSource, sandbox);

  try {
    await sandbox.__AGContextMeter.refreshKernelStatus(true);
    await sandbox.__AGContextMeter.refreshI18nStatus(true);

    assert.equal(elements.get('kernel-summary-pill').textContent, '0档 · 256K · 简中');
    assert.equal(elements.get('btn-i18n-zh-cn').classList.contains('is-active'), true);
    assert.equal(elements.get('btn-i18n-brand-english').disabled, false);

    // 点击「一键推荐」：应同时开启 4档 + 900k + chineseTitle: true
    elements.get('btn-kernel-recommended').click();
    await new Promise(r => setImmediate(r));
    assert.deepEqual({ ...kernelPayloads[0] }, { promptTier: '4', contextMode: '900k', chineseTitle: true });
    assert.equal(elements.get('kernel-summary-pill').textContent, '4档 · 900K · 中标 · 简中');
    assert.equal(elements.get('btn-kernel-title-zh').classList.contains('is-active'), true);

    // 点击界面语言「官方英文」：品牌按钮应自动置灰禁用
    elements.get('btn-i18n-en').click();
    await new Promise(r => setImmediate(r));
    assert.equal(i18nPayloads[0].locale, 'en');
    assert.equal(elements.get('btn-i18n-en').classList.contains('is-active'), true);
    assert.equal(elements.get('btn-i18n-brand-hidden').disabled, true);
    assert.equal(elements.get('kernel-summary-pill').textContent, '4档 · 900K · 中标 · 英文');
  } finally {
    sandbox.__AGContextMeter.dispose();
  }
});

test('三栏分段导航切换与 Failed to fetch 自动静默容错验证', async () => {
  const core = require('./meter-core');
  const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const listeners = new Map();

  const makeEl = () => {
    const attrs = new Map();
    const node = {
      style: { display: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', cur.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        listeners.get(node).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(node)?.get('click')?.(); },
      getBoundingClientRect: () => ({ left: 100, top: 10, width: 20, height: 20, right: 120, bottom: 30 })
    };
    return node;
  };

  const fbNode = makeEl();
  fbNode.hidden = true;
  elements.set('kernel-feedback', fbNode);

  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    }
  });

  let firstCreate = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => { if (firstCreate) { firstCreate = false; return host; } return makeEl(); },
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      __AGContextMeterLive: { port: 65530, token: 'dead-token' },
      __AGContextMeterBootstrap: {
        kernelStatus: {
          ok: true,
          supported: true,
          binaries: [{ id: 'cli', label: '桌面端内核', exists: true, bakExists: true, promptTier: 0, contextMode: '512k', chineseTitleMode: 'zh', chineseTitleEnabled: true }],
          summary: { promptTier: 0, contextMode: '512k', chineseTitleMode: 'zh', chineseTitleEnabled: true, totalCapacityBytes: 22363, activeSlotBytes: 22363, savedBytes: 0, slotCount: 13 }
        },
        i18nStatus: {
          ok: true,
          locale: 'zh-CN',
          localeLabel: '简体中文',
          brandTitle: 'english',
          dictEntryCount: 4325
        }
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: async url => {
      if (String(url).includes('127.0.0.1:65530')) {
        throw new TypeError('Failed to fetch');
      }
      return new Promise(() => {});
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(rendererSource, sandbox);

  try {
    // 1. 启动水合：无需网络即可立即展示快照胶囊
    assert.equal(elements.get('kernel-summary-pill').textContent, '0档 · 512K · 中标 · 简中');

    // 2. 自动探测 (force = false) 遇到 Failed to fetch 时必须静默容错，绝不弹红框
    await sandbox.__AGContextMeter.refreshKernelStatus(false);
    assert.equal(elements.get('kernel-feedback').hidden, true, '自动刷新遇到 Failed to fetch 时不应弹出红框');

    // 3. 三栏分段 Tab 与顶栏调色盘按钮互斥切换，无抽屉层层堆叠
    elements.get('ctx-tab-enhance').click();
    assert.equal(sandbox.__AGContextMeter.getActiveContextTab(), 'enhance');
    assert.equal(elements.get('kernel-drawer-body').style.display, 'block');
    assert.equal(elements.get('ctx-pane-overview').style.display, 'none');
    assert.equal(elements.get('drawer-body').style.display, 'none');

    elements.get('ctx-tab-audit').click();
    assert.equal(sandbox.__AGContextMeter.getActiveContextTab(), 'audit');
    assert.equal(elements.get('drawer-body').style.display, 'block');
    assert.equal(elements.get('kernel-drawer-body').style.display, 'none');

    elements.get('btn-panel-palette').click();
    assert.equal(sandbox.__AGContextMeter.getActiveContextTab(), 'palette');
    assert.equal(elements.get('color-drawer-body').style.display, 'block');
    assert.equal(elements.get('drawer-body').style.display, 'none');

    elements.get('btn-close-ctx-palette').click();
    assert.equal(sandbox.__AGContextMeter.getActiveContextTab(), 'overview');
    assert.equal(elements.get('ctx-pane-overview').style.display, 'block');
    assert.equal(elements.get('color-drawer-body').style.display, 'none');

    // 4. 仅当用户手动点击刷新 (force = true) 时，展示友好中文提示，不裸露英文 Failed to fetch
    await sandbox.__AGContextMeter.refreshKernelStatus(true);
    assert.equal(elements.get('kernel-feedback').hidden, false);
    assert.equal(elements.get('kernel-feedback').textContent.includes('Failed to fetch'), false);
    assert.match(elements.get('kernel-feedback').textContent, /临时桥接未连接/);
  } finally {
    sandbox.__AGContextMeter.dispose();
  }
});

test('v2.31.2 专项回归：ASAR 独立目录模块闭包完整性、BaseWindow + WebContentsView 启动链路与异常隔离护栏', async () => {
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v2312-boot-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const stateDir = path.join(tmpDir, 'state');
  process.env.AG_METER_STATE_DIR = stateDir;

  try {
    // 1. 构造高度还原 Antigravity v2.31.2 BaseWindow + curtainView + hubWcv + loadingOverlay 架构的宿主包
    const srcDir = path.join(tmpDir, 'host-2312-src');
    fs.mkdirSync(path.join(srcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.31.2' }), 'utf8');

    const v2312Utils = `"use strict";
const electron_1 = require("electron");
const hubViewByWindow = new Map();
const hubWindows = new Set();
function getHubWebContents(win) {
    return hubViewByWindow.get(win)?.webContents;
}
function getHubWindows() {
    return Array.from(hubWindows);
}
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const windowOptions = {
        titleBarStyle: 'hidden',
        webPreferences: { contextIsolation: true }
    };
    const baseWin = new electron_1.BaseWindow(windowOptions);
    const curtainView = new electron_1.WebContentsView({ webPreferences: { sandbox: true, javascript: false } });
    const hubWcv = new electron_1.WebContentsView({ webPreferences: { contextIsolation: true, transparent: true } });
    baseWin.contentView.addChildView(curtainView);
    baseWin.contentView.addChildView(hubWcv);
    const win = baseWin;
    Object.defineProperty(win, 'webContents', {
        get: () => hubWcv.webContents,
        configurable: true,
    });
    win.loadURL = (targetUrl, opts) => hubWcv.webContents.loadURL(targetUrl, opts);
    hubViewByWindow.set(win, hubWcv);
    hubWindows.add(win);
    const overlayView = new electron_1.WebContentsView({ webPreferences: { contextIsolation: true } });
    win.contentView.addChildView(overlayView);
    hubWcv.webContents.once('did-finish-load', () => {
        win.contentView.removeChildView(overlayView);
    });
    void win.loadURL(url);
    return win;
}
module.exports = { createWindow, setupNodeWrapper, getHubWebContents, getHubWindows };
`;
    fs.writeFileSync(path.join(srcDir, 'dist', 'utils.js'), v2312Utils, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'preload.js'), STOCK_SAMPLES.preload, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'menu.js'), STOCK_SAMPLES.menu, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'tray.js'), STOCK_SAMPLES.tray, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'loadingOverlay.js'), STOCK_SAMPLES.loadingOverlay, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'dist', 'updater.js'), STOCK_SAMPLES.updater, 'utf8');

    const targetAsar = path.join(tmpDir, 'app.asar');
    await builtinAsar.createPackageWithOptions(srcDir, targetAsar, {});

    // 2. 执行 install 打包到 targetAsar
    await install({ asarPath: targetAsar, skipHotInject: true });

    // 3. 解包到完全脱离插件源码仓库的独立目录，静态校验所有相对 require 100% 存在
    const isolatedUnpack = path.join(tmpDir, 'isolated-unpack');
    builtinAsar.extractAll(targetAsar, isolatedUnpack);
    const distDir = path.join(isolatedUnpack, 'dist');
    const distFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
    assert.ok(distFiles.includes('asar-engine.js'), 'dist 目录必须包含 asar-engine.js，严禁遗漏');

    for (const file of distFiles) {
      const code = fs.readFileSync(path.join(distDir, file), 'utf8');
      const relReqs = [...code.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map(m => m[1]);
      for (const reqPath of relReqs) {
        const resolved = path.resolve(distDir, reqPath.endsWith('.js') ? reqPath : `${reqPath}.js`);
        assert.ok(
          fs.existsSync(resolved),
          `打包后 dist/${file} 引用的本地模块 ${reqPath} 必须存在于 ASAR 内 (${resolved})`
        );
      }
    }

    // 4. Mock Electron 44 BaseWindow & WebContentsView，在隔离目录中真实 require('./dist/utils.js') 并运行 createWindow
    const executedScriptsOnHub = [];
    const executedScriptsOnCurtain = [];
    let viewSeq = 0;

    class MockWebContents extends EventEmitter {
      constructor(opts = {}) {
        super();
        this.opts = opts;
        this.currentUrl = '';
      }
      isDestroyed() { return false; }
      getURL() { return this.currentUrl; }
      getZoomFactor() { return 1; }
      async loadURL(u) {
        this.currentUrl = u;
        this.emit('did-finish-load');
      }
      async executeJavaScript(script) {
        if (this.opts.javascript === false) {
          executedScriptsOnCurtain.push(script);
          throw new Error('curtainView has javascript: false');
        }
        executedScriptsOnHub.push(script);
        if (script.startsWith('Boolean(window.__AGLocalization')) return true;
        if (script.startsWith('Boolean(window.__AGContextMeter')) return false;
        return true;
      }
    }

    class MockWebContentsView {
      constructor(options = {}) {
        this.id = ++viewSeq;
        this.webContents = new MockWebContents(options.webPreferences || {});
      }
    }

    class MockBaseWindow extends EventEmitter {
      constructor(options = {}) {
        super();
        this.options = options;
        this.children = [];
        this.overlayCalls = [];
        this.contentView = {
          addChildView: v => this.children.push(v),
          removeChildView: v => { this.children = this.children.filter(x => x !== v); }
        };
      }
      isDestroyed() { return false; }
      setTitleBarOverlay(patch) { this.overlayCalls.push(patch); }
    }

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return {
          BaseWindow: MockBaseWindow,
          BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
          WebContentsView: MockWebContentsView,
          ipcMain: { handle() {} },
          app: { on() {}, getPath: () => tmpDir }
        };
      }
      return origLoad.apply(this, arguments);
    };

    try {
      // 删除 pluginSourceDir 干扰，强制测试完全依靠解包目录内部资源运行
      const isolatedUtilsPath = path.join(distDir, 'utils.js');
      const hostUtils = require(isolatedUtilsPath);
      const win = hostUtils.createWindow('https://127.0.0.1:58888/', null);

      // 等待异步 ensureMeterInjected 微任务完成
      await new Promise(r => setTimeout(r, 40));

      assert.equal(win.webContents.getURL(), 'https://127.0.0.1:58888/', '主聊天视图必须正常导航至应用主页');
      assert.equal(win.children.length, 2, 'did-finish-load 触发后 loadingOverlay 视图必须被正常移除（仅剩 curtainView + hubWcv）');
      assert.equal(executedScriptsOnCurtain.length, 0, '严禁对 javascript:false 的 curtainView 执行任何脚本');
      assert.ok(executedScriptsOnHub.length >= 2, '必须向真实 hubWcv.webContents 注入上下文查看器脚本');

      // 5. 极端故障注入测试：模拟 meter-main.js 损坏抛错时，try/catch 护栏保证 win.loadURL 依然 100% 正常执行！
      delete require.cache[isolatedUtilsPath];
      const isolatedMainPath = path.join(distDir, 'meter-main.js');
      delete require.cache[isolatedMainPath];
      fs.writeFileSync(isolatedMainPath, 'throw new Error("simulated fatal plugin crash");\n', 'utf8');

      const hostUtilsBrokenPlugin = require(isolatedUtilsPath);
      const winFallback = hostUtilsBrokenPlugin.createWindow('https://127.0.0.1:59999/', null);
      assert.equal(
        winFallback.webContents.getURL(),
        'https://127.0.0.1:59999/',
        '即使插件模块异常崩溃，宿主窗口也必须 100% 正常执行 loadURL 并移除启动占位页，绝不卡死'
      );
      assert.equal(winFallback.children.length, 2, '异常隔离下 loadingOverlay 也必须随主页加载完成正常移除');
    } finally {
      Module._load = origLoad;
    }
  } finally {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('contextIsolation 跨世界汉化状态标记 (data-ag-i18n-locale) 与 __ag_i18n_dispose__ 事件还原验证', () => {
  const script = generatePreloadI18nScript({ locale: 'zh-CN', brandTitle: 'english' });
  const docListeners = new Map();
  const rootAttrs = new Map();
  const textNode = {
    nodeType: 3,
    nodeValue: 'Check for Updates',
    parentElement: {
      nodeType: 1,
      tagName: 'DIV',
      isContentEditable: false,
      textContent: 'Check for Updates',
      closest: () => null,
      getAttribute: () => null
    }
  };
  const bodyEl = {
    nodeType: 1,
    tagName: 'BODY',
    isContentEditable: false,
    childNodes: [textNode],
    getAttribute: () => null,
    setAttribute() {},
    closest: () => null
  };
  const docEl = {
    nodeType: 1,
    tagName: 'HTML',
    childNodes: [bodyEl],
    setAttribute: (k, v) => rootAttrs.set(k, String(v)),
    getAttribute: k => rootAttrs.get(k) ?? null,
    removeAttribute: k => rootAttrs.delete(k),
    closest: () => null
  };

  const sandbox = {
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 },
    Element: { prototype: { attachShadow() { return {}; } } },
    MutationObserver: class { observe() {} disconnect() {} },
    WeakMap,
    WeakSet,
    Map,
    Set,
    location: { protocol: 'https:', hostname: '127.0.0.1' },
    document: {
      readyState: 'complete',
      documentElement: docEl,
      body: bodyEl,
      activeElement: null,
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: (ev, fn) => docListeners.set(ev, fn),
      removeEventListener: ev => docListeners.delete(ev),
      dispatchEvent: ev => {
        const fn = docListeners.get(ev.type);
        if (fn) fn(ev);
      }
    },
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {}
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  assert.equal(rootAttrs.get('data-ag-i18n-locale'), 'zh-CN', '启动后必须在共享 documentElement 上写入语言标记');
  assert.equal(rootAttrs.get('data-ag-i18n-brand'), 'english', '启动后必须在共享 documentElement 上写入品牌策略标记');
  assert.notEqual(textNode.nodeValue, 'Check for Updates', 'DOM 文本节点应已被翻译为中文');

  // 模拟从另一个世界（如主进程 executeJavaScript 的 Main World）派发共享 DOM 事件销毁并还原汉化
  sandbox.document.dispatchEvent({ type: '__ag_i18n_dispose__' });

  assert.equal(rootAttrs.has('data-ag-i18n-locale'), false, '跨世界销毁后必须移除 data-ag-i18n-locale 标记');
  assert.equal(textNode.nodeValue, 'Check for Updates', '跨世界销毁后文本节点必须完整还原为英文原文');
});
