'use strict';

/**
 * CDP 免改盘运行时界面汉化模块 (live-i18n.js)
 *
 * 复用本仓库内置的 i18n/zh-CN.json 与 i18n/i18n-runtime.js（上游基于 MIT 协议的
 * Antigravity-Chinese-Localization），在 watch / live 模式下通过本机回环 CDP 调试接口
 * 动态注入到 Antigravity 渲染窗口与内置 plugin:// 子框架，不修改 app.asar 与 language_server。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { getStateDir, getAppDataDir, isIsolatedTestPath } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient } = require('./local-api');
const {
  loadModulesConfig,
  normalizeBrandTitle,
  normalizeClientLanguage
} = require('./modules-config');

const bundleCache = new Map();

const DEFAULT_BUILTIN_PLUGIN_PREFIXES = [
  'plugin://swarm/',
  'plugin://swarm--',
  'plugin://antigravity/',
  'plugin://antigravity--',
  'plugin://agy/',
  'plugin://agy--',
  'plugin://google-antigravity/',
  'plugin://google-antigravity--',
  'plugin://builtin/',
  'plugin://builtin--'
];

function resolveBundledAssetPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 判断 plugin:// 子框架是否属于允许注入的内置 UI 面板白名单，避免波及第三方 Marketplace 插件或 MCP App。
 */
function isAllowedPluginIframeUrl(url, options = {}) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith('plugin://')) return false;
  if (options.includeAllPluginIframes === true) return true;
  const allowlist = Array.isArray(options.pluginIframeAllowlist) && options.pluginIframeAllowlist.length > 0
    ? options.pluginIframeAllowlist
    : DEFAULT_BUILTIN_PLUGIN_PREFIXES;
  return allowlist.some(rule => {
    if (!rule) return false;
    if (rule instanceof RegExp) return rule.test(url);
    return lower.startsWith(String(rule).trim().toLowerCase());
  });
}

function sanitizeTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `${u.origin}${u.pathname}`;
    }
    if (u.protocol === 'plugin:') {
      return rawUrl.split(/[?#]/)[0];
    }
    return rawUrl.split(/[?#]/)[0];
  } catch {
    return String(rawUrl).split(/[?#]/)[0];
  }
}

function shouldBlockTestCdpAccess(options = {}) {
  const isTestEnv = process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
  if (!isTestEnv) return false;
  const hasExplicitTestTarget = Boolean(
    options.port ||
    options.appDataDir ||
    options._discoverCdp ||
    isIsolatedTestPath(getAppDataDir(options))
  );
  return !hasExplicitTestTarget;
}

/**
 * 解析运行时汉化生效配置，兼容显式命令行参数与 modules.json 持久化配置。
 */
function resolveRuntimeChineseConfig(options = {}) {
  const cfg = options.modulesConfig || loadModulesConfig({ stateDir: options.stateDir });
  const stored = cfg?.modules?.chinese || {};

  const hasExplicitEnable = typeof options.enabled === 'boolean';
  const language = options.language !== undefined
    ? normalizeClientLanguage(options.language, hasExplicitEnable ? options.enabled : true)
    : hasExplicitEnable
      ? (options.enabled
          ? normalizeClientLanguage(stored.language === 'en' ? '' : stored.language, true)
          : 'en')
      : normalizeClientLanguage(stored.language, stored.enabled);
  const enabled = hasExplicitEnable
    ? (options.enabled && language !== 'en')
    : Boolean(stored.enabled && language !== 'en');
  const brandTitle = options.brandTitle !== undefined
    ? normalizeBrandTitle(options.brandTitle)
    : normalizeBrandTitle(stored.brandTitle);

  return {
    enabled,
    language: enabled ? 'zh-CN' : 'en',
    brandTitle,
    shouldInject: Boolean(enabled || brandTitle !== 'english')
  };
}

function buildConfigSignature(chineseConfig) {
  const enabled = chineseConfig?.enabled === true && chineseConfig?.language !== 'en';
  const lang = enabled ? 'zh-CN' : 'en';
  const brand = normalizeBrandTitle(chineseConfig?.brandTitle);
  return `${enabled ? 1 : 0}:${lang}:${brand}`;
}

function buildEmptyRuntimeI18nProbe(options = {}) {
  const cfg = resolveRuntimeChineseConfig({ stateDir: options.stateDir || getStateDir() });
  return {
    configEnabled: cfg.enabled,
    language: cfg.language,
    brandTitle: cfg.brandTitle,
    cdpPort: null,
    activeTargets: 0,
    chineseActiveTargets: 0,
    totalTargets: 0,
    targets: []
  };
}

/**
 * 构建并校验 CDP 运行时汉化载荷（支持按字典/运行时内容哈希缓存，并返回注入后校验快照）。
 */
function buildRuntimeI18nBundle(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : __dirname;
  const dictPath = options.dictPath || resolveBundledAssetPath([
    path.join(rootDir, 'i18n', 'zh-CN.json'),
    path.join(rootDir, 'src', 'i18n', 'zh-CN.json')
  ]);
  const runtimePath = options.runtimePath || resolveBundledAssetPath([
    path.join(rootDir, 'i18n', 'i18n-runtime.js'),
    path.join(rootDir, 'src', 'i18n', 'i18n-runtime.js')
  ]);

  if (!dictPath || !runtimePath) {
    throw new Error('未找到内置客户端汉化词典 (i18n/zh-CN.json) 或运行时引擎 (i18n/i18n-runtime.js)');
  }

  const chineseConfig = options.chineseConfig || resolveRuntimeChineseConfig(options);
  const configSig = buildConfigSignature(chineseConfig);
  const dictRaw = fs.readFileSync(dictPath, 'utf8');
  const runtimeRaw = fs.readFileSync(runtimePath, 'utf8');
  const buildHash = crypto
    .createHash('sha256')
    .update(dictRaw, 'utf8')
    .update('\n--runtime--\n', 'utf8')
    .update(runtimeRaw, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const cacheKey = `${buildHash}|${configSig}`;
  if (bundleCache.has(cacheKey)) {
    return bundleCache.get(cacheKey);
  }

  const dictObj = JSON.parse(dictRaw);
  const dictEntries = dictObj?.exact && typeof dictObj.exact === 'object'
    ? Object.keys(dictObj.exact).length
    : 0;
  const publicConfig = {
    enabled: Boolean(chineseConfig.enabled),
    language: chineseConfig.language || (chineseConfig.enabled ? 'zh-CN' : 'en'),
    brandTitle: normalizeBrandTitle(chineseConfig.brandTitle)
  };

  const code = [
    '(function () {',
    '  var _win = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null);',
    '  var _wasInit = Boolean(_win && _win.__AGY_I18N_INITIALIZED__);',
    '  var _canHotUpdate = Boolean(_wasInit && typeof _win.__AGY_I18N_HOT_UPDATE__ === "function");',
    '  if (_wasInit && !_canHotUpdate) {',
    '    return {',
    '      init: true,',
    '      hotUpdated: false,',
    '      reloadRequired: true,',
    '      meta: _win.__AGY_RUNTIME_I18N_META__ || null,',
    '      contextMeterActive: Boolean(_win && _win.__AGContextMeter)',
    '    };',
    '  }',
    `  var _cfg = ${JSON.stringify(publicConfig)};`,
    `  var _dict = ${JSON.stringify(dictObj)};`,
    '  if (typeof window !== "undefined") {',
    '    window.__AGY_CHINESE_CONFIG__ = _cfg;',
    '    window.__AGY_I18N_CONFIG__ = _cfg;',
    '    window.__AGY_I18N_DATA__ = _dict;',
    '  }',
    '  if (typeof globalThis !== "undefined") {',
    '    globalThis.__AGY_CHINESE_CONFIG__ = _cfg;',
    '    globalThis.__AGY_I18N_CONFIG__ = _cfg;',
    '    globalThis.__AGY_I18N_DATA__ = _dict;',
    '  }',
    runtimeRaw,
    '  var _meta = {',
    '    mode: "cdp-runtime",',
    '    source: "bundled-i18n",',
    `    dictEntries: ${dictEntries},`,
    `    buildHash: ${JSON.stringify(buildHash)},`,
    `    configSig: ${JSON.stringify(configSig)},`,
    '    injectedAt: Date.now()',
    '  };',
    '  if (typeof window !== "undefined") {',
    '    window.__AGY_RUNTIME_I18N_META__ = _meta;',
    '  }',
    '  return {',
    '    init: Boolean(_win && _win.__AGY_I18N_INITIALIZED__),',
    '    hotUpdated: _wasInit,',
    '    reloadRequired: false,',
    '    meta: _meta,',
    '    contextMeterActive: Boolean(_win && _win.__AGContextMeter)',
    '  };',
    '})()'
  ].join('\n');

  new vm.Script(code, { filename: 'live-i18n-bundle.js' });

  const bundle = {
    code,
    buildHash,
    configSig,
    dictEntries,
    chineseConfig: publicConfig,
    source: 'bundled-i18n'
  };
  if (bundleCache.size > 16) bundleCache.clear();
  bundleCache.set(cacheKey, bundle);
  return bundle;
}

function isLoopbackWsUrl(wsUrl) {
  if (!wsUrl || typeof wsUrl !== 'string') return false;
  try {
    const u = new URL(wsUrl);
    return u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

/**
 * 从 CDP 探测结果收集需要本地化的宿主页面与内置 plugin:// 子框架，过滤第三方本地预览页与外部 UI 插件。
 */
function collectLocalizationTargets(cdp, options = {}) {
  const seenWs = new Set();
  const targets = [];

  const pushTarget = (item, fallbackType) => {
    if (!item || !isLoopbackWsUrl(item.webSocketDebuggerUrl)) return;
    if (seenWs.has(item.webSocketDebuggerUrl)) return;
    seenWs.add(item.webSocketDebuggerUrl);
    targets.push({
      id: item.id || null,
      type: item.type || fallbackType,
      title: item.title || '',
      url: item.url || '',
      webSocketDebuggerUrl: item.webSocketDebuggerUrl
    });
  };

  for (const page of (Array.isArray(cdp?.pages) ? cdp.pages : [])) {
    pushTarget(page, 'page');
  }
  for (const item of (Array.isArray(cdp?.allPages) ? cdp.allPages : [])) {
    if (item && item.type === 'iframe' && isAllowedPluginIframeUrl(item.url, options)) {
      pushTarget(item, 'iframe');
    }
  }
  return targets;
}

/**
 * 向单个 CDP 目标幂等注入或热更新运行时汉化引擎；未就绪或非宿主页面自动跳过。
 */
async function injectRuntimeI18nTarget(target, bundleInfo, options = {}) {
  const clientFactory = typeof options._createCdpClient === 'function'
    ? options._createCdpClient
    : createCdpClient;
  const cleanUrl = sanitizeTargetUrl(target.url);
  const client = await clientFactory(target.webSocketDebuggerUrl, { timeoutMs: 5000 });
  try {
    const pre = await client.evaluateValue(`(() => ({
      init: Boolean(window.__AGY_I18N_INITIALIZED__),
      hasHotUpdate: typeof window.__AGY_I18N_HOT_UPDATE__ === 'function',
      meta: window.__AGY_RUNTIME_I18N_META__ || null,
      config: window.__AGY_I18N_CONFIG__ || null,
      contextMeterActive: Boolean(window.__AGContextMeter),
      isHostPage: Boolean(
        window.__APP_CONFIG__ ||
        window.__AGContextMeter ||
        window.contextMeterAPI ||
        (typeof document !== 'undefined' && (
          document.getElementById?.('workbench') ||
          document.querySelector?.('.monaco-workbench, [data-testid="new-conversation-button"], [data-testid="title-menu-bar-item"]')
        ))
      )
    }))()`, { timeoutMs: 5000 });

    if (target.type === 'page' && pre && pre.isHostPage === false && options.skipHostCheck !== true) {
      return {
        ok: true,
        skipped: true,
        reason: 'non_host_page',
        id: target.id,
        type: target.type,
        url: cleanUrl
      };
    }

    if (
      pre &&
      pre.init &&
      pre.meta &&
      pre.meta.buildHash === bundleInfo.buildHash &&
      pre.meta.configSig === bundleInfo.configSig
    ) {
      return {
        ok: true,
        skipped: true,
        id: target.id,
        type: target.type,
        url: cleanUrl,
        buildHash: pre.meta.buildHash,
        configSig: pre.meta.configSig,
        contextMeterActive: Boolean(pre.contextMeterActive)
      };
    }

    if (pre && pre.init && !pre.hasHotUpdate) {
      return {
        ok: false,
        skipped: false,
        reloadRequired: true,
        reason: 'already_initialized_reload_required',
        error: '窗口已加载旧版或外部汉化运行时，请刷新窗口 (Cmd/Ctrl+R) 后生效',
        id: target.id,
        type: target.type,
        url: cleanUrl,
        buildHash: pre.meta?.buildHash || null,
        configSig: pre.meta?.configSig || null,
        contextMeterActive: Boolean(pre.contextMeterActive)
      };
    }

    const sameBaseBundle = Boolean(
      pre &&
      pre.init &&
      pre.hasHotUpdate &&
      pre.meta &&
      pre.meta.buildHash === bundleInfo.buildHash
    );
    if (sameBaseBundle) {
      const brandOnly = Boolean(pre.config?.enabled) === Boolean(bundleInfo.chineseConfig.enabled);
      const updated = await client.evaluateValue(`(() => {
        const nextCfg = ${JSON.stringify(bundleInfo.chineseConfig)};
        const nextSig = ${JSON.stringify(bundleInfo.configSig)};
        const brandOnly = ${brandOnly ? 'true' : 'false'};
        if (brandOnly) {
          if (window.__AGY_I18N_CONFIG__) window.__AGY_I18N_CONFIG__.brandTitle = nextCfg.brandTitle;
          if (window.__AGY_CHINESE_CONFIG__) window.__AGY_CHINESE_CONFIG__.brandTitle = nextCfg.brandTitle;
          if (window.__AGY_RUNTIME_I18N_META__) window.__AGY_RUNTIME_I18N_META__.configSig = nextSig;
          if (typeof window.__AGY_RUN_FULL_SCAN__ === 'function') window.__AGY_RUN_FULL_SCAN__();
        } else {
          window.__AGY_I18N_HOT_UPDATE__(null, nextCfg);
          if (window.__AGY_RUNTIME_I18N_META__) window.__AGY_RUNTIME_I18N_META__.configSig = nextSig;
        }
        return {
          init: Boolean(window.__AGY_I18N_INITIALIZED__),
          meta: window.__AGY_RUNTIME_I18N_META__ || null,
          contextMeterActive: Boolean(window.__AGContextMeter)
        };
      })()`, { timeoutMs: 5000 });

      const ok = Boolean(updated && updated.init && updated.meta?.configSig === bundleInfo.configSig);
      return {
        ok,
        skipped: false,
        ...(brandOnly ? { brandRefreshed: true } : { hotUpdated: true }),
        id: target.id,
        type: target.type,
        url: cleanUrl,
        buildHash: updated?.meta?.buildHash || bundleInfo.buildHash,
        configSig: updated?.meta?.configSig || bundleInfo.configSig,
        contextMeterActive: Boolean(updated?.contextMeterActive),
        ...(ok ? {} : { error: 'runtime_i18n_hot_update_failed' })
      };
    }

    const post = await client.evaluateValue(bundleInfo.code, { timeoutMs: 12000 });
    if (post && post.reloadRequired) {
      return {
        ok: false,
        skipped: false,
        reloadRequired: true,
        reason: 'already_initialized_reload_required',
        error: '窗口已加载旧版或外部汉化运行时，请刷新窗口 (Cmd/Ctrl+R) 后生效',
        id: target.id,
        type: target.type,
        url: cleanUrl,
        buildHash: post.meta?.buildHash || null,
        configSig: post.meta?.configSig || null,
        contextMeterActive: Boolean(post.contextMeterActive)
      };
    }

    const ok = Boolean(
      post &&
      post.init &&
      post.meta &&
      post.meta.buildHash === bundleInfo.buildHash &&
      post.meta.configSig === bundleInfo.configSig
    );
    return {
      ok,
      skipped: false,
      ...(post?.hotUpdated ? { hotUpdated: true } : {}),
      id: target.id,
      type: target.type,
      url: cleanUrl,
      buildHash: post?.meta?.buildHash || null,
      configSig: post?.meta?.configSig || null,
      contextMeterActive: Boolean(post?.contextMeterActive),
      ...(ok ? {} : { error: 'runtime_i18n_verification_failed' })
    };
  } finally {
    client.close();
  }
}

/**
 * 向当前所有匹配的 Antigravity 窗口及内置 plugin:// 子框架执行免改盘运行时汉化注入。
 */
async function injectRuntimeI18nIntoTargets(options = {}) {
  if (shouldBlockTestCdpAccess(options)) {
    return { ok: false, reason: 'test_mode_isolated', targetCount: 0, injectedCount: 0, skippedCount: 0, failedCount: 0, targets: [] };
  }

  const chineseConfig = options.chineseConfig || resolveRuntimeChineseConfig(options);
  if (!chineseConfig.shouldInject && options.force !== true) {
    return {
      ok: true,
      skipped: true,
      reason: 'chinese_disabled',
      targetCount: 0,
      injectedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      targets: []
    };
  }

  const bundleInfo = buildRuntimeI18nBundle({ ...options, chineseConfig });
  const discoverFn = typeof options._discoverCdp === 'function' ? options._discoverCdp : discoverAntigravityCdp;

  let cdp;
  try {
    cdp = await discoverFn(options);
  } catch (err) {
    return {
      ok: false,
      reason: 'cdp_not_enabled',
      error: err?.message || String(err),
      targetCount: 0,
      injectedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      targets: []
    };
  }

  const targets = collectLocalizationTargets(cdp, options);
  if (targets.length === 0) {
    return {
      ok: false,
      reason: 'no_page_targets',
      cdpPort: cdp?.port || null,
      targetCount: 0,
      injectedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      targets: []
    };
  }

  const results = [];
  for (const target of targets) {
    try {
      results.push(await injectRuntimeI18nTarget(target, bundleInfo, options));
    } catch (err) {
      results.push({
        ok: false,
        skipped: false,
        id: target.id,
        type: target.type,
        url: sanitizeTargetUrl(target.url),
        error: err?.message || String(err)
      });
    }
  }

  const nonHostOnly = results.length > 0 && results.every(r => r.reason === 'non_host_page');
  const reloadRequired = results.some(r => r.reloadRequired === true);
  return {
    ok: !nonHostOnly && results.length > 0 && results.every(r => r.ok),
    ...(nonHostOnly ? { reason: 'no_host_page_targets' } : {}),
    ...(reloadRequired ? { reloadRequired: true } : {}),
    cdpPort: cdp?.port || null,
    buildHash: bundleInfo.buildHash,
    configSig: bundleInfo.configSig,
    dictEntries: bundleInfo.dictEntries,
    targetCount: targets.length,
    injectedCount: results.filter(r => r.ok && !r.skipped).length,
    skippedCount: results.filter(r => r.ok && r.skipped).length,
    failedCount: results.filter(r => !r.ok).length,
    targets: results
  };
}

/**
 * 只读探测当前运行中窗口与内置 plugin:// 子框架的运行时汉化状态。
 */
async function probeRuntimeI18nTargets(options = {}) {
  const base = buildEmptyRuntimeI18nProbe(options);
  if (shouldBlockTestCdpAccess(options)) {
    return { ...base, isolated: true, reason: 'test_mode_isolated' };
  }

  const discoverFn = typeof options._discoverCdp === 'function' ? options._discoverCdp : discoverAntigravityCdp;
  const clientFactory = typeof options._createCdpClient === 'function' ? options._createCdpClient : createCdpClient;

  let cdp;
  try {
    cdp = await discoverFn(options);
  } catch {
    return base;
  }

  const targets = collectLocalizationTargets(cdp, options);
  base.cdpPort = cdp?.port || null;
  base.totalTargets = targets.length;

  for (const target of targets) {
    const cleanUrl = sanitizeTargetUrl(target.url);
    let client = null;
    try {
      client = await clientFactory(target.webSocketDebuggerUrl, { timeoutMs: 3500 });
      const snap = await client.evaluateValue(`(() => {
        const init = Boolean(window.__AGY_I18N_INITIALIZED__);
        const cfg = window.__AGY_I18N_CONFIG__ || null;
        return {
          i18nActive: init,
          chineseActive: Boolean(init && (!cfg || (cfg.enabled !== false && cfg.language !== 'en'))),
          mode: window.__AGY_RUNTIME_I18N_META__?.mode || (init ? 'preload-or-external' : null),
          buildHash: window.__AGY_RUNTIME_I18N_META__?.buildHash || null,
          configSig: window.__AGY_RUNTIME_I18N_META__?.configSig || null,
          dictEntries: window.__AGY_RUNTIME_I18N_META__?.dictEntries || null,
          contextMeterActive: Boolean(window.__AGContextMeter)
        };
      })()`, { timeoutMs: 3500 });
      if (snap?.i18nActive) base.activeTargets++;
      if (snap?.chineseActive) base.chineseActiveTargets++;
      base.targets.push({ id: target.id, type: target.type, url: cleanUrl, ...(snap || {}) });
    } catch (err) {
      base.targets.push({ id: target.id, type: target.type, url: cleanUrl, i18nActive: false, chineseActive: false, error: err?.message || String(err) });
    } finally {
      if (client) {
        try { client.close(); } catch {}
      }
    }
  }
  return base;
}

module.exports = {
  DEFAULT_BUILTIN_PLUGIN_PREFIXES,
  isAllowedPluginIframeUrl,
  sanitizeTargetUrl,
  shouldBlockTestCdpAccess,
  buildEmptyRuntimeI18nProbe,
  resolveRuntimeChineseConfig,
  buildConfigSignature,
  buildRuntimeI18nBundle,
  collectLocalizationTargets,
  injectRuntimeI18nTarget,
  injectRuntimeI18nIntoTargets,
  probeRuntimeI18nTargets
};
