'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const core = require('./meter-core');
const { builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const {
  DEFAULT_CONFIG,
  loadModulesConfig,
  saveModulesConfig,
  inspectDiskModules,
  invalidateDiskModulesCache
} = require('./modules-config');
const { generateChinesePreloadCode, TAGS } = require('./modular-installer');
const {
  inspectHostRecoveryState,
  backupHostAsarByVersion,
  recoverHostInstallation
} = require('./host-recovery');
const { getPluginSettings, savePluginSettings } = require('./meter-collector');
const enhance = require('./meter-enhance');

const SAMPLE_V234_UTILS = `"use strict";
exports.loadHubWindowUrl = loadHubWindowUrl;
async function loadHubWindowUrl(win, targetUrl, options) {
    await win.loadURL(targetUrl);
}
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    const windowOptions = {
        titleBarStyle: 'hidden',
    };
    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createHostAsarFixture(dir, version, utilsSource = SAMPLE_V234_UTILS, filename = 'app.asar') {
  const src = path.join(dir, `src-${version}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsSource, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n', 'utf8');
  const out = path.join(dir, filename);
  await builtinAsar.createPackage(src, out);
  fs.rmSync(src, { recursive: true, force: true });
  return out;
}

function buildMockEnhancePe64() {
  const imageBase = 0x140000000n;
  const rdataRva = 0x1000;
  const rdataPtr = 0x400;
  const totalSize = 0x8000;
  const buf = Buffer.alloc(totalSize, 0);

  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84);
  buf.writeUInt16LE(1, 0x86);
  buf.writeUInt32LE(0x69100000, 0x88);
  buf.writeUInt16LE(0xf0, 0x94);
  const opt = 0x98;
  buf.writeUInt16LE(0x020b, opt);
  buf.writeBigUInt64LE(imageBase, opt + 24);
  buf.writeUInt32LE(totalSize, opt + 56);

  const secOff = opt + 0xf0;
  buf.write('.rdata\0\0', secOff, 'ascii');
  buf.writeUInt32LE(totalSize - rdataPtr, secOff + 8);
  buf.writeUInt32LE(rdataRva, secOff + 12);
  buf.writeUInt32LE(totalSize - rdataPtr, secOff + 16);
  buf.writeUInt32LE(rdataPtr, secOff + 20);

  const fileOffToVa = (off) => imageBase + BigInt(rdataRva + (off - rdataPtr));
  const prefix = 'google3/third_party/jetski/prompt/template_provider/templates/';
  const longDummy = (label, minLen) => {
    const base = `<!-- ${label} stock section -->\n` + 'Keep original helpful behavior. '.repeat(Math.ceil(minLen / 30));
    return base.slice(0, minLen);
  };
  const slots = [
    { shortName: 'system_prompts/identity.tmpl', content: 'You are Antigravity, an agentic AI coding assistant.\n' },
    { shortName: 'system_prompts/guidelines.tmpl', content: longDummy('guidelines', 900) },
    { shortName: 'system_prompts/function_call.tmpl', content: longDummy('function_call', 800) },
    { shortName: 'system_prompts/communication_style.tmpl', content: longDummy('communication_style', 2400) },
    { shortName: 'system_prompts/artifacts.tmpl', content: longDummy('artifacts', 120) },
    { shortName: 'system_prompts/persistent_context.tmpl', content: longDummy('persistent_context', 120) },
    { shortName: 'system_prompts/knowledge_items.tmpl', content: longDummy('knowledge_items', 120) },
    { shortName: 'system_prompts/planning_mode_artifacts.tmpl', content: longDummy('planning_mode_artifacts', 120) },
    { shortName: 'system_prompts/conversation_transcript.tmpl', content: longDummy('conversation_transcript', 120) },
    { shortName: 'system_prompts/slash_commands.tmpl', content: longDummy('slash_commands', 120) },
    { shortName: 'system_prompts/plugins.tmpl', content: longDummy('plugins', 120) }
  ];
  let strCursor = 0x500;
  const tableBase = 0x4800;
  slots.forEach((s, idx) => {
    const fullName = prefix + s.shortName;
    const nameOff = strCursor;
    buf.write(fullName, nameOff, 'utf8');
    strCursor += Buffer.byteLength(fullName, 'utf8') + 1;
    const dataOff = strCursor;
    buf.write(s.content, dataOff, 'utf8');
    const dataLen = Buffer.byteLength(s.content, 'utf8');
    strCursor += dataLen + 2;
    const entryOff = tableBase + idx * 48;
    buf.writeBigUInt64LE(fileOffToVa(nameOff), entryOff);
    buf.writeBigUInt64LE(BigInt(Buffer.byteLength(fullName, 'utf8')), entryOff + 8);
    buf.writeBigUInt64LE(fileOffToVa(dataOff), entryOff + 16);
    buf.writeBigUInt64LE(BigInt(dataLen), entryOff + 24);
  });
  let titleCursor = 0x6200;
  for (const rule of enhance.CHINESE_TITLE_RULES) {
    buf.write(rule.oldText, titleCursor, 'ascii');
    titleCursor += Buffer.byteLength(rule.oldText, 'ascii') + 16;
  }
  return buf;
}

function createRendererLangHarness(opts = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const storageMap = new Map(Object.entries(opts.localStorageInit || {}));

  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
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
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { if (x) this.children.push(x); },
      querySelectorAll() { return []; },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };

  const host = element();
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  });

  const localStorage = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); }
  };

  let first = true;
  const scans = [];
  const winObj = {
    __APP_CONFIG__: { csrfToken: 'test' },
    ...(opts.chineseConfig !== undefined ? { __AGY_CHINESE_CONFIG__: opts.chineseConfig } : {}),
    ...(opts.i18nConfig !== undefined ? { __AGY_I18N_CONFIG__: opts.i18nConfig } : {}),
    ...(opts.settingsBoot !== undefined ? { __AGContextMeterSettings: opts.settingsBoot } : {}),
    contextMeterAPI: {
      scan: (id) => new Promise(resolve => scans.push({ id, resolve })),
      getSettings: async () => (opts.settingsRes || { ok: true, panelLanguage: 'zh-CN', panelLanguageExplicit: false, uiPreferences: {} }),
      saveSettings: async (payload) => {
        if (typeof opts.onSaveSettings === 'function') opts.onSaveSettings(payload);
        return { ok: true, ...payload };
      },
      modules: async () => (opts.modulesRes || {
        ok: true,
        data: { modules: { meter: { enabled: true }, chinese: { enabled: false, language: 'en' }, proxy: { enabled: false } } },
        disk: { meter: true, meterReady: true, chinese: true, chineseReady: true, proxy: true, proxyReady: true },
        runtime: { chineseActive: Boolean(opts.chineseConfig?.enabled) }
      })
    }
  };

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    localStorage,
    document: {
      createElement: () => { if (first) { first = false; return host; } return element(); },
      getElementById: id => docElements.get(id) || null,
      documentElement: {
        lang: opts.docLang || '',
        getAttribute(k) { return k === 'lang' ? (opts.docLang || '') : null; },
        appendChild() {}
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      hidden: false
    },
    window: winObj,
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => new Promise(() => {})
  };
  if (opts.chineseConfig !== undefined) sandbox.__AGY_CHINESE_CONFIG__ = opts.chineseConfig;
  if (opts.i18nConfig !== undefined) sandbox.__AGY_I18N_CONFIG__ = opts.i18nConfig;
  if (opts.settingsBoot !== undefined) sandbox.__AGContextMeterSettings = opts.settingsBoot;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { sandbox, elements, scans, storageMap, flush, api: sandbox.__AGContextMeter };
}

test('需求三-1: 首次全新安装 4 项可选增强默认全关，缺失字段 fail-closed，已有配置与遗留显式启用保留', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-first-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir1 = path.join(root, 'state-isolated');
  const legacyDirNoConfig = path.join(root, 'localapp-1');
  fs.mkdirSync(path.join(legacyDirNoConfig, 'AntigravityChinese'), { recursive: true });
  // 仅有旧 installation.json 或 enabled:false 的 config.json，不得误开启汉化
  fs.writeFileSync(path.join(legacyDirNoConfig, 'AntigravityChinese', 'installation.json'), JSON.stringify({ installed: 'x' }), 'utf8');
  fs.writeFileSync(path.join(legacyDirNoConfig, 'AntigravityChinese', 'config.json'), JSON.stringify({ enabled: false }), 'utf8');

  const firstCfg = loadModulesConfig({ stateDir: stateDir1, localAppData: legacyDirNoConfig });
  assert.equal(firstCfg.modules.meter.enabled, true, '核心上下文监控应默认开启');
  assert.equal(firstCfg.modules.chinese.enabled, false, '首次全新安装汉化必须默认关闭');
  assert.equal(firstCfg.modules.chinese.language, 'en');
  assert.equal(firstCfg.modules.proxy.enabled, false, '首次全新安装免 TUN 代理必须默认关闭');
  assert.equal(firstCfg.modules.enhance.promptTier, 0, '首次安装提示词优化必须为官方 0 档');
  assert.equal(firstCfg.modules.enhance.chineseTitle, false, '首次安装中文标题补丁必须默认关闭');
  assert.equal(firstCfg.modules.rehydrate.enabled, false, '首次安装防有损压缩必须默认关闭');

  // 验证缺 enabled/language 或显式关闭的 fail-closed 行为
  const modPath1 = path.join(stateDir1, 'modules.json');
  for (const zhRaw of [{}, { language: 'zh-CN' }, { enabled: false, language: 'zh-CN' }]) {
    fs.writeFileSync(modPath1, JSON.stringify({
      schemaVersion: DEFAULT_CONFIG.schemaVersion,
      modules: { ...DEFAULT_CONFIG.modules, chinese: zhRaw }
    }), 'utf8');
    const c = loadModulesConfig({ stateDir: stateDir1 });
    assert.equal(c.modules.chinese.enabled, false, `缺失或显式关闭字段 ${JSON.stringify(zhRaw)} 必须 fail-closed`);
    assert.equal(c.modules.chinese.language, 'en');
  }

  // 验证生成出来的 preload 门禁脚本在 chinese:{} 下绝不开启汉化
  const preloadGate = generateChinesePreloadCode('{}', '/* runtime */');
  assert.equal(preloadGate.includes('_ch.enabled === true'), true);
  assert.equal(preloadGate.includes('_ch.enabled !== false'), false);

  const vmSandbox = {
    window: {},
    globalThis: {},
    electron_1: undefined,
    require: (id) => {
      if (id === 'fs') {
        return {
          existsSync: (p) => p === modPath1,
          readFileSync: () => JSON.stringify({ modules: { chinese: {} } })
        };
      }
      if (id === 'path') return path;
      if (id === 'os') return os;
      return {};
    },
    process: { platform: 'win32', env: { AG_METER_STATE_DIR: stateDir1 } },
    document: null
  };
  vm.createContext(vmSandbox);
  vm.runInContext(preloadGate, vmSandbox);
  assert.equal(vmSandbox.window.__AGY_I18N_CONFIG__?.enabled, undefined, '缺 enabled 的配置在 preload 门禁中必须提前 return 不执行汉化');

  // 验证老用户显式 enabled:true（哪怕缺 language）保持开启
  fs.writeFileSync(modPath1, JSON.stringify({
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    modules: { ...DEFAULT_CONFIG.modules, chinese: { enabled: true } }
  }), 'utf8');
  const legacyEnabledCfg = loadModulesConfig({ stateDir: stateDir1 });
  assert.equal(legacyEnabledCfg.modules.chinese.enabled, true);
  assert.equal(legacyEnabledCfg.modules.chinese.language, 'zh-CN');

  // 旧独立工具的配置不能代表用户在新插件里选择开启模块。
  fs.writeFileSync(path.join(legacyDirNoConfig, 'AntigravityChinese', 'config.json'), JSON.stringify({ enabled: true }), 'utf8');
  const newInstallWithLegacy = loadModulesConfig({ stateDir: path.join(root, 'fresh-unified-state'), localAppData: legacyDirNoConfig });
  assert.equal(newInstallWithLegacy.modules.chinese.enabled, false);
  assert.equal(newInstallWithLegacy.modules.chinese.language, 'en');

  // 传隔离 stateDir 不传 localAppData 时绝不穿透读取宿主机真实旧痕迹
  const isoCfg = loadModulesConfig({ stateDir: path.join(root, 'pure-iso-state') });
  assert.equal(isoCfg.modules.chinese.enabled, false);
  assert.equal(isoCfg.modules.proxy.enabled, false);
});

test('需求三-2: template 推荐增强复选框默认全部未勾选，面板语言自动跟随英文/中文宿主并优先用户显式选择', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  for (const id of ['chk-rec-prompt', 'chk-rec-title', 'chk-rec-lang', 'chk-rec-ctx', 'chk-rec-rehydrate', 'chk-enhance-chinese-title', 'chk-autohide-topbar-docked', 'chk-radial-orb', 'chk-radial-topbar', 'chk-radial-bottombar', 'chk-show-composer-quota', 'chk-show-turn-footer-stats', 'check-auto-update']) {
    const tagMatch = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`, 'i'));
    assert.ok(tagMatch, `template.html 缺少元素 #${id}`);
    assert.equal(/\bchecked\b/i.test(tagMatch[0]), false, `首次安装可选增强复选框 #${id} 不得带默认 checked 属性`);
  }

  // 场景 A: 英文宿主 + 首装全关 + 用户从未手动选择面板语言 -> 首帧与 restoreSettings 后均保持英文
  const hEn = createRendererLangHarness({
    chineseConfig: { enabled: false, language: 'en' },
    docLang: 'en',
    settingsRes: { ok: true, panelLanguage: 'zh-CN', panelLanguageExplicit: false, uiPreferences: {} }
  });
  assert.equal(hEn.api.getPanelLanguage(), 'en', '英文宿主冷启动首帧必须跟随为 English');
  await hEn.api.restoreSettingsForTest();
  await hEn.flush();
  assert.equal(hEn.api.getPanelLanguage(), 'en', '未显式保存 panelLanguage 时不得被后端默认兼容值拉回 zh-CN');
  hEn.api.dispose();

  // 场景 B: 用户开启汉化并重启客户端 -> 宿主变为中文，面板自动跟随为简体中文
  const hZh = createRendererLangHarness({
    chineseConfig: { enabled: true, language: 'zh-CN' },
    docLang: 'zh-CN',
    settingsRes: { ok: true, panelLanguage: 'zh-CN', panelLanguageExplicit: false, uiPreferences: {} }
  });
  assert.equal(hZh.api.getPanelLanguage(), 'zh-CN', '汉化宿主重启后面板应自动跟随为 zh-CN');
  await hZh.api.restoreSettingsForTest();
  await hZh.flush();
  assert.equal(hZh.api.getPanelLanguage(), 'zh-CN');
  hZh.api.dispose();

  // 场景 C: 关闭汉化重启回英文 -> 面板跟随恢复英文
  const hBackEn = createRendererLangHarness({
    chineseConfig: { enabled: false, language: 'en' },
    docLang: 'en'
  });
  await hBackEn.api.restoreSettingsForTest();
  await hBackEn.flush();
  assert.equal(hBackEn.api.getPanelLanguage(), 'en');
  hBackEn.api.dispose();

  // 场景 D: 用户在英文宿主手动切换为 zh-TW 并持久化 -> 重启即使宿主仍为英文，始终优先用户个人设定
  const savedPayloads = [];
  const hUser = createRendererLangHarness({
    chineseConfig: { enabled: false, language: 'en' },
    docLang: 'en',
    onSaveSettings: (p) => savedPayloads.push(p)
  });
  assert.equal(hUser.api.getPanelLanguage(), 'en');
  await hUser.api.setPanelLanguage('zh-TW', { persist: true });
  await hUser.flush();
  assert.equal(hUser.api.getPanelLanguage(), 'zh-TW');
  assert.equal(hUser.storageMap.get('ag_panel_language'), 'zh-TW');
  assert.equal(savedPayloads.at(-1)?.panelLanguage, 'zh-TW');
  hUser.api.dispose();

  const hUserRestart = createRendererLangHarness({
    chineseConfig: { enabled: false, language: 'en' },
    docLang: 'en',
    settingsRes: {
      ok: true,
      panelLanguage: 'zh-TW',
      panelLanguageExplicit: true,
      uiPreferences: { panelLanguage: 'zh-TW' }
    }
  });
  await hUserRestart.api.restoreSettingsForTest();
  await hUserRestart.flush();
  assert.equal(hUserRestart.api.getPanelLanguage(), 'zh-TW', '显式保存的个人面板语言必须优先于英文宿主信号');
  hUserRestart.api.dispose();
});

test('需求五 (ELV-105): 宿主更新覆盖自动检测、按版本备份隔离、模块与增强无损恢复、写前预检拦截与 CLI recover', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-elv105-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostDir = path.join(root, 'host');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // 准备纯净 2.33.1 与 2.34.0 官方样本 ASAR，及模拟 language_server PE 二进制
  const clean233 = await createHostAsarFixture(root, '2.33.1', SAMPLE_V234_UTILS, 'clean-2.33.1.asar');
  const clean234 = await createHostAsarFixture(root, '2.34.0', SAMPLE_V234_UTILS, 'clean-2.34.0.asar');
  const activeAsar = path.join(hostDir, 'app.asar');
  fs.copyFileSync(clean233, activeAsar);

  const pePath = path.join(hostDir, 'language_server_windows_x64.exe');
  fs.writeFileSync(pePath, buildMockEnhancePe64());
  const enhanceTargets = [{ id: 'ls', label: 'language_server', path: pePath }];

  // 1. 在 2.33.1 上安装并显式开启汉化 + 应用增强意图
  await install({
    path: activeAsar,
    stateDir,
    noHotInject: true,
    modules: { chinese: { enabled: true, language: 'zh-CN' } }
  });
  await enhance.applyEnhancePatchAsync(
    { promptTier: 1, chineseTitle: 'on' },
    { agDir: stateDir, targets: enhanceTargets, useWorker: false }
  );
  const cfgAfterEnh = loadModulesConfig({ stateDir });
  cfgAfterEnh.modules.enhance.promptTier = 1;
  cfgAfterEnh.modules.enhance.chineseTitle = 'on';
  saveModulesConfig(cfgAfterEnh, { stateDir });

  // 同版本健康态 -> inspect 为 healthy，recover 返回 noop 且零改写 ASAR
  const healthyInspect = inspectHostRecoveryState({ asarPath: activeAsar, stateDir });
  assert.equal(healthyInspect.state, 'healthy');
  assert.equal(healthyInspect.needsRecovery, false);
  const noopRes = await recoverHostInstallation({ asarPath: activeAsar, stateDir, noHotInject: true });
  assert.equal(noopRes.ok, true);
  assert.equal(noopRes.action, 'noop');
  assert.equal(noopRes.changed, false);

  // 2. 模拟官方宿主自动更新：用干净 2.34.0 ASAR 与全新未打补丁 PE 二进制覆写原文件
  fs.copyFileSync(clean234, activeAsar);
  fs.writeFileSync(pePath, buildMockEnhancePe64());
  invalidateDiskModulesCache();

  // 只读诊断必须精确报出 overwritten_by_host_update
  const overCheck = await recoverHostInstallation({ asarPath: activeAsar, stateDir, checkOnly: true });
  assert.equal(overCheck.action, 'check_only');
  assert.equal(overCheck.inspected.state, 'overwritten_by_host_update');
  assert.equal(overCheck.inspected.needsRecovery, true);
  assert.equal(overCheck.inspected.hostVersion, '2.34.0');

  // CLI --check-only --json 验证不改盘只读
  const cliCheckOut = execFileSync(process.execPath, [
    path.join(__dirname, 'cli.js'),
    'recover',
    '--path', activeAsar,
    '--state-dir', stateDir,
    '--check-only',
    '--json'
  ], { encoding: 'utf8', env: { ...process.env, AG_METER_TEST_MODE: '1' } });
  const parsedCheck = JSON.parse(cliCheckOut);
  assert.equal(parsedCheck.inspected.state, 'overwritten_by_host_update');
  assert.equal(sha256(activeAsar), sha256(clean234), 'check-only 模式不得修改 ASAR');

  // 3. 执行完整恢复 -> 备份 2.34.0 且保留 2.33.1 备份，恢复插件及汉化开关 + enhance
  const recRes = await recoverHostInstallation({
    asarPath: activeAsar,
    stateDir,
    noHotInject: true,
    enhanceTargets
  });
  assert.equal(recRes.ok, true);
  assert.equal(recRes.action, 'recovered');
  assert.equal(recRes.changed, true);
  assert.equal(recRes.hostVersion, '2.34.0');
  assert.equal(recRes.diskAfter.meterReady, true);
  assert.equal(recRes.diskAfter.chineseReady, true);
  assert.equal(loadModulesConfig({ stateDir }).modules.chinese.enabled, true, '恢复后必须保留用户之前开启的汉化配置');
  assert.ok(recRes.backupsByVersion['2.33.1']?.backup, '必须保留 2.33.1 原版备份');
  assert.ok(recRes.backupsByVersion['2.34.0']?.backup, '必须新建 2.34.0 版本隔离备份');
  assert.notEqual(recRes.backupsByVersion['2.33.1'].backup, recRes.backupsByVersion['2.34.0'].backup);
  assert.equal(sha256(recRes.backupsByVersion['2.34.0'].backup), sha256(clean234));
  assert.equal(recRes.enhanceRecovery.ok, true, '已记录的 enhance 意图应在恢复时同步补回');

  // 再次 recover 必须幂等 noop
  const recAgain = await recoverHostInstallation({ asarPath: activeAsar, stateDir, noHotInject: true });
  assert.equal(recAgain.action, 'noop');
  assert.equal(recAgain.changed, false);

  // 4. 写前预检拦截：不兼容宿主入口结构 (verifyCleanStructure 失败) 绝不强写
  const badStructAsar = await createHostAsarFixture(root, '2.99.0', '"use strict"; exports.broken = () => 1;\n', 'bad-struct.asar');
  const badShaBefore = sha256(badStructAsar);
  const badStateDir = path.join(root, 'state-bad');
  fs.mkdirSync(badStateDir, { recursive: true });
  fs.writeFileSync(path.join(badStateDir, 'installation.json'), JSON.stringify({ installed: badStructAsar, version: '2.34.0' }));
  const badRec = await recoverHostInstallation({ asarPath: badStructAsar, stateDir: badStateDir, noHotInject: true });
  assert.equal(badRec.ok, false);
  assert.equal(badRec.action, 'blocked');
  assert.equal(badRec.reason, 'host_structure_unsupported');
  assert.equal(sha256(badStructAsar), badShaBefore, '结构不兼容时不得写入目标 ASAR');

  // 5. 写前预检拦截：macOS ElectronAsarIntegrity 启用时必须写前阻止并给 watch/live 指引
  const macAppResDir = path.join(root, 'Antigravity.app', 'Contents', 'Resources');
  fs.mkdirSync(macAppResDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Antigravity.app', 'Contents', 'Info.plist'),
    '<plist><dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string></dict></dict></dict></plist>',
    'utf8'
  );
  const macAsar = path.join(macAppResDir, 'app.asar');
  fs.copyFileSync(clean234, macAsar);
  const macShaBefore = sha256(macAsar);
  const macStateDir = path.join(root, 'state-mac');
  fs.mkdirSync(macStateDir, { recursive: true });
  fs.writeFileSync(path.join(macStateDir, 'installation.json'), JSON.stringify({ installed: macAsar, version: '2.33.1' }));
  const macRec = await recoverHostInstallation({
    asarPath: macAsar,
    stateDir: macStateDir,
    enforceMacIntegrityCheck: true,
    _platform: 'darwin',
    noHotInject: true
  });
  assert.equal(macRec.ok, false);
  assert.equal(macRec.action, 'blocked');
  assert.equal(macRec.reason, 'macos_asar_integrity_blocked');
  assert.match(macRec.guidance, /watch|live/);
  assert.equal(sha256(macAsar), macShaBefore, 'macOS 受完整性保护时绝不强写 ASAR');
});
