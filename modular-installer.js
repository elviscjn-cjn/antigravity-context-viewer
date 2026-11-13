'use strict';
/**
 * Antigravity 统一模块注入与清洗调度引擎 (modular-installer.js)
 * 职责：
 * 1. 统一管理 ContextMeter、Chinese、ProxyNoTun 的代码注入模板与成对标识；
 * 2. 安装与卸载共用同一套原位手术刀清洗逻辑，杜绝规则分叉；
 * 3. 严格保护第三方修改与宿主固有配置，不猜测删除未确认归属的代码；
 * 4. 每次改写均通过 vm.Script 进行前置与后置 JavaScript 语法校验。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 成对标记定义
const TAGS = {
  PROXY_START: '// --- Antigravity Proxy NoTun Injection Start ---',
  PROXY_END: '// --- Antigravity Proxy NoTun Injection End ---',
  CHINESE_START: '// --- Antigravity Chinese Localization Injection Start ---',
  CHINESE_END: '// --- Antigravity Chinese Localization Injection End ---',
  METER_UTILS_START: '// --- Antigravity Context Meter utils Injection Start ---',
  METER_UTILS_END: '// --- Antigravity Context Meter utils Injection End ---',
  METER_PRELOAD_START: '// --- Antigravity Context Meter preload Injection Start ---',
  METER_PRELOAD_END: '// --- Antigravity Context Meter preload Injection End ---'
};

/**
 * 校验 JavaScript 脚本语法合法性
 */
function validateSyntax(code, filename = 'script.js') {
  if (typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 生成免 TUN 代理主进程注入代码（支持环境变量拦截、Chromium 命令行开关与 Electron session 代理）
 */
function generateProxyUtilsCode(cfg = {}) {
  const proxyUrl = cfg.proxyUrl || 'http://127.0.0.1:7897';
  const bypassList = cfg.bypassList || 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<local>';
  return `\n${TAGS.PROXY_START}
try {
  const _fs = require('fs');
  const _path = require('path');
  const _os = require('os');
  const _electron = require('electron');

  let _proxyUrl = ${JSON.stringify(proxyUrl)};
  let _noProxy = ${JSON.stringify(bypassList)};

  const _localApp = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || _path.join(_os.homedir(), 'AppData', 'Local'))
    : (process.platform === 'darwin'
      ? _path.join(_os.homedir(), 'Library', 'Application Support')
      : _path.join(_os.homedir(), '.local', 'state'));

  const _cfgCandidates = [
    _path.join(_localApp, 'AntigravityContextMeter', 'modules.json'),
    _path.join(_localApp, 'AntigravityContextMeter', 'proxy.json'),
    _path.join(_localApp, 'AntigravityProxyNoTun', 'config.json')
  ];

  for (const _p of _cfgCandidates) {
    if (_fs.existsSync(_p)) {
      try {
        const _d = JSON.parse(_fs.readFileSync(_p, 'utf8'));
        const _pCfg = (_d.modules && _d.modules.proxy) ? _d.modules.proxy : _d;
        if (_pCfg.enabled === false) { _proxyUrl = null; break; }
        if (_pCfg.proxyUrl || _pCfg.httpProxy) _proxyUrl = _pCfg.proxyUrl || _pCfg.httpProxy;
        if (_pCfg.bypassList || _pCfg.noProxy) _noProxy = _pCfg.bypassList || _pCfg.noProxy;
        break;
      } catch {}
    }
  }

  if (_proxyUrl) {
    for (const _k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      if (!process.env[_k]) process.env[_k] = _proxyUrl;
    }
    process.env['NO_PROXY'] = _noProxy;
    process.env['no_proxy'] = _noProxy;

    if (_electron && _electron.app && _electron.app.commandLine) {
      try {
        _electron.app.commandLine.appendSwitch('proxy-server', _proxyUrl);
        _electron.app.commandLine.appendSwitch('proxy-bypass-list', _noProxy);
      } catch {}
    }

    if (_electron && _electron.app && typeof _electron.app.whenReady === 'function') {
      _electron.app.whenReady().then(() => {
        try {
          if (_electron.session && _electron.session.defaultSession) {
            _electron.session.defaultSession.setProxy({
              proxyRules: _proxyUrl,
              proxyBypassRules: _noProxy
            }).catch(() => {});
          }
        } catch {}
      }).catch(() => {});
    }
  }
} catch (_pErr) {
  console.warn('[ProxyNoTun] Injection init warning:', _pErr);
}
${TAGS.PROXY_END}\n`;
}

/**
 * 生成上下文监控模块的 utils 挂载代码（成对标记）
 */
function generateMeterUtilsCode() {
  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  return {
    headerProxyHook: `try { require("./meter-main").ensureProxyEnvironment(process.env); } catch {}`,
    nodeWrapperHook: `\n    try { require("./meter-main").ensureProxyEnvironment(env); } catch {}`,
    storageFallback: `\n${storageFallbackLine}`,
    menuBarOption: `\n        autoHideMenuBar: true,`,
    windowLoadHook: `${TAGS.METER_UTILS_START}\n${hookLine}${TAGS.METER_UTILS_END}\n`,
    focusHook: `\n        try { require("./meter-main").installContextMeter(wins[0]); require("./meter-main").ensureMeterInjected(wins[0], { force: true }); } catch {}`,
    createHook: `\n        try { require("./meter-main").installContextMeter(_mWin); require("./meter-main").ensureMeterInjected(_mWin, { force: true }); } catch {}`
  };
}

/**
 * 生成上下文监控模块的 preload 注入代码（成对标记）
 */
function generateMeterPreloadCode() {
  return `\n${TAGS.METER_PRELOAD_START}
// Context Meter v2: narrow read-only conversation scan API
electron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true), getTokenHistory: (force) => electron_1.ipcRenderer.invoke("context-meter:token-history", force === true), syncOverlay: (opts) => electron_1.ipcRenderer.invoke("context-meter:sync-overlay", opts), recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls), getSettings: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-settings", opts), saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload), launchCli: (opts) => electron_1.ipcRenderer.invoke("context-meter:launch-cli", opts), checkUpdate: (opts) => electron_1.ipcRenderer.invoke("context-meter:check-update", opts), applyUpdate: (opts) => electron_1.ipcRenderer.invoke("context-meter:apply-update", opts), openExternal: (url) => electron_1.ipcRenderer.invoke("context-meter:open-external", url), getContextUnlockStatus: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-status"), applyContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-apply"), restoreContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-restore"), getModulesStatus: () => electron_1.ipcRenderer.invoke("context-meter:modules-status"), toggleModule: (name, enable, opts) => electron_1.ipcRenderer.invoke("context-meter:toggle-module", name, enable, opts), testProxy: (url) => electron_1.ipcRenderer.invoke("context-meter:test-proxy", url) });
${TAGS.METER_PRELOAD_END}\n`;
}

/**
 * 生成桌面端汉化注入代码（仅对桌面端 DOM 进行翻译，不篡改系统提示词与后端逻辑）
 */
function generateChinesePreloadCode(dictContent, runtimeContent) {
  return `\n${TAGS.CHINESE_START}
(function() {
  try {
    var _enabled = false;
    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer && typeof electron_1.ipcRenderer.sendSync === 'function') {
      try {
        _enabled = electron_1.ipcRenderer.sendSync('context-meter:is-chinese-enabled') === true;
      } catch(e) { _enabled = false; }
    } else {
      var _fs = typeof require === 'function' ? (function() { try { return require('fs'); } catch(e) { return null; } })() : null;
      var _path = typeof require === 'function' ? (function() { try { return require('path'); } catch(e) { return null; } })() : null;
      var _os = typeof require === 'function' ? (function() { try { return require('os'); } catch(e) { return null; } })() : null;
      if (_fs && _path && _os) {
        var _localApp = process.platform === 'win32'
          ? (process.env.LOCALAPPDATA || _path.join(_os.homedir(), 'AppData', 'Local'))
          : (process.platform === 'darwin'
            ? _path.join(_os.homedir(), 'Library', 'Application Support')
            : _path.join(_os.homedir(), '.local', 'state'));
        var _cfgP = _path.join(_localApp, 'AntigravityContextMeter', 'modules.json');
        if (_fs.existsSync(_cfgP)) {
          try {
            var _c = JSON.parse(_fs.readFileSync(_cfgP, 'utf8'));
            if (_c && _c.modules && _c.modules.chinese && _c.modules.chinese.enabled === true) {
              _enabled = true;
            }
          } catch(e) {}
        }
      }
    }
    if (!_enabled) return;

    var _dictData = ${dictContent.trim()};
    if (typeof window !== 'undefined') {
      window.__AGY_I18N_DATA__ = _dictData;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_I18N_DATA__ = _dictData;
    }
    ${runtimeContent}
  } catch(e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AGY-i18n] Runtime Injection Error:', e);
    }
  }
})();
${TAGS.CHINESE_END}\n`;
}

/**
 * 原位手术刀清洗 utils.js
 * 规则：
 * 1. 优先通过成对标记精准删除 Proxy 与 Meter 注入；
 * 2. 对历史无标记的代码执行严格白名单特征清洗；
 * 3. 绝不盲目基于缩进或 titleBarStyle 猜测删除无关代码；
 * 4. 必须验证最终 JS 语法合法性。
 */
function cleanUtilsSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  // 1. 精准移除成对标记内容
  const proxyRegex = new RegExp(`\\n?\\s*${TAGS.PROXY_START}[\\s\\S]*?${TAGS.PROXY_END}\\n?`, 'g');
  code = code.replace(proxyRegex, '\n');

  const meterRegex = new RegExp(`\\n?\\s*${TAGS.METER_UTILS_START}[\\s\\S]*?${TAGS.METER_UTILS_END}\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  // 2. 清洗历史未打标记的 ContextMeter 注入（严格特征匹配，防止破坏第三方）
  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  code = code
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(process\.env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace('\n' + storageFallbackLine, '')
    .replace(/\s*require\("\.\/meter-main"\)\.installContextMeter\(win\);?\r?\n?/g, '')
    .replace(/\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(wins\[0\]\);[\s\S]*?\}\s*catch\s*\{\}/g, '')
    .replace(/const _mWin = createWindow\(`\$\{constants_1\.WINDOW_ORIGIN\}:\$\{port\}\/`\);\s*\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(_mWin\);[\s\S]*?\}\s*catch\s*\{\}/g, 'createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);');

  // 仅删除带有插件特定 8 空格缩进的注入行，若宿主原有自包含 autoHideMenuBar 则保留
  code = code.replace(/\n {8}autoHideMenuBar:\s*true,/, '');

  return code;
}

/**
 * 原位手术刀清洗 preload.js
 */
function cleanPreloadSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const chineseRegex = new RegExp(`\\n?\\s*${TAGS.CHINESE_START}[\\s\\S]*?${TAGS.CHINESE_END}\\n?`, 'g');
  code = code.replace(chineseRegex, '\n');

  const meterRegex = new RegExp(`\\n?\\s*${TAGS.METER_PRELOAD_START}[\\s\\S]*?${TAGS.METER_PRELOAD_END}\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  // 历史未标记正则
  const legacyMeterRegex = /\r?\n?\/\/ Context Meter v2: narrow read-only conversation scan API\r?\nelectron_1\.contextBridge\.exposeInMainWorld\("contextMeterAPI",\s*\{[\s\S]*?\}\);\r?\n?/g;
  code = code.replace(legacyMeterRegex, '\n');

  return code;
}

/**
 * 校验清洗后的 utils 结构合法性与 JavaScript 语法
 */
function verifyCleanStructure(cleanUtils) {
  if (!cleanUtils) return false;
  if (cleanUtils.includes('installContextMeter')) return false;
  if (cleanUtils.includes(TAGS.PROXY_START) || cleanUtils.includes(TAGS.METER_UTILS_START)) return false;
  const marker = '    void win.loadURL(url);';
  const setupNodeMarker = 'function setupNodeWrapper(env) {';
  const structuralOk = cleanUtils.split(marker).length === 2 && cleanUtils.includes(setupNodeMarker);
  return structuralOk && validateSyntax(cleanUtils, 'dist/utils.js');
}

module.exports = {
  TAGS,
  validateSyntax,
  generateProxyUtilsCode,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  generateChinesePreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyCleanStructure
};
