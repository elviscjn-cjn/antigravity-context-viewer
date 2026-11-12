'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect, pingCdp } = require('./local-api');
const {
  collect,
  collectTokenHistoryAsync,
  recordModelCalls,
  getPluginSettings,
  savePluginSettings,
  launchCliSession
} = require('./meter-collector');
const { getKernelStatus, applyKernelPatch } = require('./meter-patcher');
const { normalizeLocale, normalizeBrandTitle, readI18nConfig, saveI18nConfig, getI18nStatus } = require('./meter-i18n');
const { install, findAsarPath, tryHotInject, applyLiveI18nToRunningWindows } = require('./install');
const { getStateDir } = require('./asar-engine');

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 传输体积上限
const MAX_RECORD_CALLS = 500; // 单批次最大记录数
const BRIDGE_VERSION = 3;
const ALLOWED_ROUTES = ['/scan', '/token-history', '/record-calls', '/get-settings', '/save-settings', '/launch-cli', '/get-kernel-status', '/apply-kernel-patch', '/get-i18n-status', '/apply-i18n-config'];

(async () => {
  let api = await connect();
  const secret = crypto.randomBytes(32).toString('hex');
  const stateDir = getStateDir();
  const stamp = path.join(stateDir, '.live-session.json');
  let boundPort = 0;
  let healingBusy = false;

  function writeStamp() {
    if (!boundPort) return;
    const info = {
      port: boundPort,
      token: secret,
      pid: process.pid,
      origin: api.origin,
      bridgeVersion: BRIDGE_VERSION,
      startedAt: Date.now()
    };
    fs.writeFileSync(stamp, JSON.stringify(info));
  }

  async function healWindowAfterReload(nextApi) {
    if (healingBusy) return;
    healingBusy = true;
    try {
      if (nextApi && nextApi.origin !== api.origin) {
        api = nextApi;
        writeStamp();
      }
      await tryHotInject();
      const cfg = readI18nConfig({ stateDir });
      if (cfg.locale && cfg.locale !== 'en') {
        await applyLiveI18nToRunningWindows({
          locale: cfg.locale,
          brandTitle: cfg.brandTitle,
          stateDir
        });
      }
    } catch {} finally {
      healingBusy = false;
    }
  }

  function scheduleRapidHealAfterLsRestart() {
    let attempts = 0;
    let confirmedStable = 0;
    const prevOrigin = api.origin;
    const fastTimer = setInterval(async () => {
      attempts++;
      if (attempts > 40 || confirmedStable >= 3) {
        clearInterval(fastTimer);
        return;
      }
      try {
        const cdp = await pingCdp();
        if (!cdp.alive || !cdp.page || !cdp.origin) return;
        if (cdp.origin !== prevOrigin || attempts > 4) {
          const latest = await connect().catch(() => ({ ...api, origin: cdp.origin, page: cdp.page }));
          const state = await probeWindowMeterState(cdp.page.webSocketDebuggerUrl);
          if (!state || state.readyState !== 'complete' || !state.hasMeter || state.livePort !== boundPort) {
            confirmedStable = 0;
            await healWindowAfterReload(latest);
          } else {
            confirmedStable++;
          }
        }
      } catch {}
    }, 650);
  }

  async function probeWindowMeterState(wsUrl) {
    if (!wsUrl) return null;
    let ws = null;
    try {
      ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws timeout')), 1500);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
        ws.addEventListener('error', err => { clearTimeout(t); reject(err); }, { once: true });
      });
      const probe = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('eval timeout')), 1500);
        ws.addEventListener('message', ev => {
          const d = JSON.parse(ev.data);
          if (d.id === 1) {
            clearTimeout(t);
            resolve(d.result?.result?.value || null);
          }
        });
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: '({ readyState: document.readyState, hasMeter: Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter")), hasIpc: Boolean(window.contextMeterAPI?.getKernelStatus), livePort: window.__AGContextMeterLive?.port || 0 })',
            returnByValue: true
          }
        }));
      });
      return probe;
    } catch {
      return null;
    } finally {
      if (ws) { try { ws.close(); } catch {} }
    }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin !== api.origin && /^https:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) {
      try {
        const latest = await connect();
        if (latest.origin === origin) {
          api = latest;
          writeStamp();
        }
      } catch {}
    }
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
            res.end(JSON.stringify({ ok: false, changed: false, error: resCall.error || '入账落盘失败' }));
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
        if (req.url === '/get-kernel-status') {
          const result = getKernelStatus();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/apply-kernel-patch') {
          const result = applyKernelPatch(request || {});
          if (result?.ok && request?.restartLanguageServer) {
            scheduleRapidHealAfterLsRestart();
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/get-i18n-status') {
          let asarPath = null;
          try { asarPath = findAsarPath(); } catch {}
          const result = getI18nStatus({ asarPath });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/apply-i18n-config') {
          const locale = normalizeLocale(request?.locale);
          const brandTitle = normalizeBrandTitle(request?.brandTitle);
          if (locale === undefined || brandTitle === undefined) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: '无效的界面汉化或品牌显示参数' }));
            return;
          }
          const saved = saveI18nConfig({ locale, brandTitle, pluginSourceDir: __dirname });
          let asarUpdated = false;
          let asarError = null;
          let asarPath = null;
          try {
            const manifest = await install({
              locale: saved.locale,
              brandTitle: saved.brandTitle,
              skipHotInject: true,
              liveRefreshI18n: true
            });
            asarUpdated = true;
            asarPath = manifest.installed;
          } catch (packErr) {
            asarError = packErr.message;
            try { asarPath = findAsarPath(); } catch {}
          }
          const status = getI18nStatus({ asarPath });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, asarUpdated, asarError, status }));
          return;
        }
        if (req.url === '/token-history') {
          const data = await collectTokenHistoryAsync({ force: request.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        const data = await collect(api.origin, request.id, { force: request.force === true });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, data }));
      }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    boundPort = server.address().port;
    writeStamp();
    console.log('Context Meter local bridge ready on loopback port ' + boundPort);
    void healWindowAfterReload(api);
  });
  let misses = 0;
  let tickCount = 0;
  const check = setInterval(async () => {
    tickCount++;
    try {
      const cdp = await pingCdp();
      if (!cdp.alive) {
        if (++misses >= 20) {
          clearInterval(check);
          server.close();
          process.exit(0);
        }
        return;
      }
      misses = 0;
      if (cdp.origin && cdp.origin !== api.origin) {
        const nextApi = await connect().catch(() => ({ ...api, origin: cdp.origin, page: cdp.page }));
        await healWindowAfterReload(nextApi);
        return;
      }
      // 每 3 秒轻量探查主页面：若刷新或重启语言服务导致热挂载丢失，立即自动补齐桥接凭证与面板
      if (cdp.page?.webSocketDebuggerUrl && !healingBusy) {
        const probe = await probeWindowMeterState(cdp.page.webSocketDebuggerUrl);
        if (probe && !probe.hasIpc && (!probe.hasMeter || probe.livePort !== boundPort)) {
          await healWindowAfterReload(api);
        }
      }
    } catch {
      if (++misses >= 20) {
        clearInterval(check);
        server.close();
        process.exit(0);
      }
    }
  }, 3000);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
