'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect } = require('./local-api');
const {
  collect,
  collectTokenHistoryAsync,
  fetchQuotaSnapshotFromHost,
  recordModelCalls,
  getPluginSettings,
  savePluginSettings,
  launchCliSession,
  getContextUnlockStatus,
  applyContextUnlockAsync,
  restoreContextUnlockAsync
} = require('./meter-collector');
const { normalizeProxyUrl, normalizeBypassListForCompare, parseAndValidateProxyUrl } = require('./meter-proxy');
const { getStateDir } = require('./asar-engine');
const { PROJECT_VERSION } = require('./modules-config');

const liveBootProxySnapshot = (() => {
  const bootInfo = (typeof globalThis !== 'undefined' && globalThis.__AG_PROXY_BOOT_INFO__ && globalThis.__AG_PROXY_BOOT_INFO__.injectedAtStartup)
    ? globalThis.__AG_PROXY_BOOT_INFO__
    : null;
  if (bootInfo) {
    return {
      injectedAtStartup: true,
      enabled: Boolean(bootInfo.active && bootInfo.proxyUrl),
      proxyUrl: bootInfo.proxyUrl || null,
      bypassList: typeof bootInfo.bypassList === 'string' ? bootInfo.bypassList : null
    };
  }
  const envProxy = normalizeProxyUrl(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '');
  const envBypass = String(process.env.NO_PROXY || process.env.no_proxy || '').trim() || null;
  return {
    injectedAtStartup: false,
    enabled: Boolean(envProxy),
    proxyUrl: envProxy || null,
    bypassList: envBypass
  };
})();

const liveBootChineseSnapshots = new Map();

function resolveLiveBootChineseSnapshot() {
  const key = String(process.env.AG_METER_STATE_DIR || '__default__');
  if (liveBootChineseSnapshots.has(key)) return liveBootChineseSnapshots.get(key);
  let snap = { enabled: false, language: 'en' };
  try {
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules();
    const ch = cfg?.modules?.chinese || {};
    const diskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
    const active = Boolean(ch.enabled && String(ch.language || '').toLowerCase() !== 'en' && diskReady);
    snap = {
      enabled: active,
      language: String(ch.language || (ch.enabled ? 'zh-CN' : 'en'))
    };
  } catch {}
  liveBootChineseSnapshots.set(key, snap);
  return snap;
}
try { resolveLiveBootChineseSnapshot(); } catch {}

function buildLiveRuntimeModulesMeta(cfg) {
  const diskProxy = cfg?.modules?.proxy || {};
  const diskEnabled = Boolean(diskProxy.enabled);
  const diskUrl = normalizeProxyUrl(diskProxy.proxyUrl || '');
  const diskBypass = normalizeBypassListForCompare(diskProxy.bypassList || '');
  const runtimeEnabled = Boolean(liveBootProxySnapshot.enabled);
  const runtimeUrl = normalizeProxyUrl(liveBootProxySnapshot.proxyUrl || '');
  const runtimeBypass = normalizeBypassListForCompare(liveBootProxySnapshot.bypassList || '');
  const proxyNeedsRestart = runtimeEnabled !== diskEnabled ||
    (diskEnabled && runtimeEnabled && (diskUrl !== runtimeUrl || diskBypass !== runtimeBypass));
  const bootZh = resolveLiveBootChineseSnapshot();
  const diskCh = cfg?.modules?.chinese || {};
  const diskZhActive = Boolean(diskCh.enabled && String(diskCh.language || '').toLowerCase() !== 'en');
  return {
    injectedAtStartup: Boolean(liveBootProxySnapshot.injectedAtStartup),
    proxyActive: runtimeEnabled,
    runtimeProxyUrl: runtimeUrl || null,
    runtimeBypassList: typeof liveBootProxySnapshot.bypassList === 'string' ? liveBootProxySnapshot.bypassList : null,
    proxyNeedsRestart,
    chineseActive: Boolean(bootZh.enabled),
    chineseBootLanguage: bootZh.language,
    chineseNeedsRestart: diskZhActive !== Boolean(bootZh.enabled)
  };
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 传输体积上限
const MAX_RECORD_CALLS = 500; // 单批次最大记录数
const ALLOWED_ROUTES = [
  '/scan',
  '/token-history',
  '/quota',
  '/record-calls',
  '/get-settings',
  '/save-settings',
  '/launch-cli',
  '/context-unlock-status',
  '/context-unlock-apply',
  '/context-unlock-restore',
  '/enhance-status',
  '/enhance-apply',
  '/enhance-restore',
  '/restart-language-servers',
  '/modules-status',
  '/toggle-module',
  '/test-proxy',
  '/restart-host'
];

function createLiveRequestHandler({ api, secret }) {
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin !== api.origin) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', api.origin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || req.headers['x-ag-context-token'] !== secret) { res.writeHead(403); res.end(); return; }
    let body = '';
    let bodyLength = 0;
    let exceeded = false;
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求体积超出限制（最大 1MB）' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (exceeded) return;
      try {
        const request = JSON.parse(body || '{}');
        if (req.url === '/record-calls') {
          const calls = Array.isArray(request.calls) ? request.calls : [];
          if (calls.length > MAX_RECORD_CALLS) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `单次入账记录数超出上限（最多 ${MAX_RECORD_CALLS} 条）` }));
            return;
          }
          const resCall = recordModelCalls(calls);
          if (resCall && typeof resCall === 'object' && resCall.ok === false) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              changed: false,
              error: resCall.error || '入账落盘失败',
              ...(resCall.phase ? { phase: resCall.phase } : {}),
              ...(resCall.code ? { code: resCall.code } : {})
            }));
            return;
          }
          const changed = (resCall && typeof resCall === 'object') ? !!resCall.changed : !!resCall;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, changed }));
          return;
        }
        if (req.url === '/get-settings') {
          const result = getPluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/save-settings') {
          const result = savePluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/launch-cli') {
          const result = await launchCliSession(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/context-unlock-status') {
          const result = await getContextUnlockStatus(undefined, request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/context-unlock-apply') {
          const opts = { ...(request || {}) };
          if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
          const result = await applyContextUnlockAsync(opts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/context-unlock-restore') {
          const opts = { ...(request || {}) };
          if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
          const result = await restoreContextUnlockAsync(opts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/enhance-status') {
          const { getEnhanceStatusAsync } = require('./meter-enhance');
          const result = await getEnhanceStatusAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/enhance-apply') {
          const { applyEnhancePatchAsync } = require('./meter-enhance');
          const result = await applyEnhancePatchAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/enhance-restore') {
          const { restoreAllEnhanceAsync } = require('./meter-enhance');
          const result = await restoreAllEnhanceAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/restart-language-servers') {
          const { restartLanguageServersAsync } = require('./meter-enhance');
          const result = await restartLanguageServersAsync();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/test-proxy') {
          const { testProxyHealth } = require('./modules-config');
          const report = await testProxyHealth(request?.proxyUrl);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: report }));
          return;
        }
        if (req.url === '/modules-status') {
          const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
          const cfg = loadModulesConfig();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: cfg,
            disk: inspectDiskModules(request?.asarPath || null),
            runtime: buildLiveRuntimeModulesMeta(cfg),
            configCorrupted: Boolean(cfg.__configCorrupted),
            configError: cfg.__configError || null,
            corruptedConfigPath: cfg.__corruptedConfigPath || null
          }));
          return;
        }
        if (req.url === '/toggle-module') {
          const { loadModulesConfig, saveModulesConfig, inspectDiskModules, normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
          const cfg = loadModulesConfig();
          const mod = request?.name;
          if (!cfg.modules[mod]) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `未知模块: ${mod}` }));
            return;
          }
          const extra = request?.opts || {};
          const targetEnable = Boolean(request?.enable);
          const disk = inspectDiskModules(extra.asarPath || null);
          const hasDiskCapability = mod === 'chinese'
            ? Boolean(disk.chineseReady)
            : (mod === 'proxy' ? Boolean(disk.proxyReady) : Boolean(disk.meterReady));

          // 在热挂载模式或未持久化注入下尝试开启未注入模块时，给出可执行的外部补装指引，不假报切换成功
          if (targetEnable && !hasDiskCapability) {
            const modLabel = mod === 'chinese' ? '汉化' : (mod === 'proxy' ? '免 TUN 代理' : '核心监控');
            const subCmd = mod === 'proxy' ? 'proxy:enable' : (mod === 'chinese' ? 'chinese:enable' : 'install');
            const cmdHint = process.platform === 'win32'
              ? `在插件目录打开终端运行 install.bat 或 node cli.js ${subCmd}`
              : `在插件目录打开终端运行 node cli.js ${subCmd}`;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: false,
              status: 'install_failed',
              data: cfg,
              disk,
              runtime: buildLiveRuntimeModulesMeta(cfg),
              error: `当前客户端磁盘 ASAR 未注入${modLabel}组件（或组件不完整）。请先彻底退出 Antigravity（包含系统托盘），再${cmdHint} 完成持久化注入。`,
              restartRequired: false
            }));
            return;
          }

          // 在写盘更改前先确保本生命周期启动汉化快照已捕获
          resolveLiveBootChineseSnapshot();
          const prevChineseEnabled = Boolean(cfg.modules.chinese?.enabled);
          const prevChineseLang = cfg.modules.chinese?.language || (prevChineseEnabled ? 'zh-CN' : 'en');
          if (mod === 'chinese') {
            const nextLang = normalizeClientLanguage(extra.language, targetEnable);
            cfg.modules.chinese.language = nextLang;
            cfg.modules.chinese.enabled = nextLang === 'zh-CN';
            if (extra.brandTitle !== undefined) cfg.modules.chinese.brandTitle = normalizeBrandTitle(extra.brandTitle);
            cfg.modules.chinese.lastUpdated = new Date().toISOString();
          } else {
            if (mod === 'proxy' && extra.proxyUrl !== undefined) {
              const check = parseAndValidateProxyUrl(extra.proxyUrl);
              if (!check.ok) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  ok: false,
                  status: 'invalid_config',
                  error: check.error,
                  data: cfg,
                  runtime: buildLiveRuntimeModulesMeta(cfg)
                }));
                return;
              }
              cfg.modules.proxy.proxyUrl = check.value;
            }
            cfg.modules[mod].enabled = targetEnable;
            if (mod === 'proxy') {
              if (typeof extra.bypassList === 'string') {
                cfg.modules.proxy.bypassList = extra.bypassList.trim();
              }
              cfg.modules.proxy.lastUpdated = new Date().toISOString();
            }
          }
          saveModulesConfig(cfg);
          const runtime = buildLiveRuntimeModulesMeta(cfg);
          const langChanged = mod === 'chinese' && (
            Boolean(cfg.modules.chinese.enabled) !== prevChineseEnabled ||
            cfg.modules.chinese.language !== prevChineseLang
          );
          const brandOnlyUpdate = mod === 'chinese' && extra.brandTitle !== undefined && !langChanged;
          const restartRequired = mod === 'proxy'
            ? Boolean(runtime.proxyNeedsRestart)
            : (brandOnlyUpdate ? false : Boolean(runtime.chineseNeedsRestart));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            status: 'config_toggled',
            data: cfg,
            disk,
            runtime,
            restartRequired
          }));
          return;
        }
        if (req.url === '/restart-host') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, supported: false }));
          return;
        }
        if (req.url === '/token-history') {
          const data = await collectTokenHistoryAsync({ force: request.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        if (req.url === '/quota') {
          const resData = await fetchQuotaSnapshotFromHost({ force: request.force === true });
          const { _raw, ...safeData } = resData || {};
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: safeData }));
          return;
        }
        const data = await collect(api.origin, request.id, { force: request.force === true });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, data }));
      }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  };
}

async function startLiveHost() {
  const api = await connect();
  const secret = crypto.randomBytes(32).toString('hex');
  const stamp = path.join(getStateDir(), '.live-session.json');
  const server = http.createServer(createLiveRequestHandler({ api, secret }));
  server.listen(0, '127.0.0.1', () => {
    const info = {
      port: server.address().port,
      token: secret,
      pid: process.pid,
      origin: api.origin,
      version: PROJECT_VERSION,
      hasQuota: true,
      startedAt: Date.now()
    };
    fs.writeFileSync(stamp, JSON.stringify(info));
    console.log('Context Meter local bridge ready on loopback port ' + info.port);
  });
  let misses = 0;
  const check = setInterval(async () => {
    try { const a = await connect(); if (a.origin !== api.origin) throw new Error('App restarted'); misses = 0; }
    catch { if (++misses >= 3) { clearInterval(check); server.close(); process.exit(0); } }
  }, 10000);
}

if (require.main === module) {
  startLiveHost().catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  buildLiveRuntimeModulesMeta,
  createLiveRequestHandler,
  startLiveHost
};
