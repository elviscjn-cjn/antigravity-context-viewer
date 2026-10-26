'use strict';
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { collect, collectTokenHistory } = require('./meter-collector');

function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    const os = require('os');
    const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const cfgPath = path.join(localBase, 'AntigravityContextMeter', 'proxy.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg || !cfg.httpProxy) return;
    const noProxy = cfg.noProxy || 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = cfg.httpProxy;
    }
    if (cfg.allProxy) {
      for (const k of ['ALL_PROXY', 'all_proxy']) {
        if (!targetEnv[k]) targetEnv[k] = cfg.allProxy;
      }
    }
    for (const k of ['NO_PROXY', 'no_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = noProxy;
    }
  } catch {}
}
ensureProxyEnvironment(process.env);
exports.ensureProxyEnvironment = ensureProxyEnvironment;

function getMeterSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  } catch (e) {
    return '';
  }
}
let registered = false;
exports.installContextMeter = function (win) {
  if (!registered) {
    registered = true;
    ipcMain.handle('context-meter:scan', async (event, id, force) => {
      const url = new URL(event.senderFrame?.url || event.sender.getURL());
      if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || event.senderFrame !== event.sender.mainFrame) throw new Error('仅允许本机主聊天窗口');
      try { return { ok: true, data: await collect(url.origin, id, { force: force === true }) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('context-meter:token-history', async (event, force) => {
      const url = new URL(event.senderFrame?.url || event.sender.getURL());
      if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || event.senderFrame !== event.sender.mainFrame) throw new Error('仅允许本机主聊天窗口');
      try { return { ok: true, data: collectTokenHistory({ force: force === true }) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
      try {
        const { BrowserWindow } = require('electron');
        const targetWin = BrowserWindow.fromWebContents(event.sender);
        if (!targetWin || targetWin.isDestroyed() || typeof targetWin.setTitleBarOverlay !== 'function') return { ok: false };
        const patch = {};
        if (options && typeof options.color === 'string') patch.color = options.color;
        if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
        if (options && Number.isFinite(Number(options.height)) && Number(options.height) >= 24 && Number(options.height) <= 64) {
          patch.height = Math.round(Number(options.height));
        }
        targetWin.setTitleBarOverlay(patch);
        return { ok: true, patch };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }
  const syncWindowOverlayHeight = () => {
    try {
      if (process.platform === 'darwin' || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') return;
      const zf = typeof win.webContents?.getZoomFactor === 'function' ? win.webContents.getZoomFactor() : 1;
      const targetH = Math.max(28, Math.min(60, Math.round(40 * (Number.isFinite(zf) && zf > 0 ? zf : 1))));
      win.setTitleBarOverlay({ height: targetH });
    } catch {}
  };
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    if (!/^https:\/\/127\.0\.0\.1:\d+\//.test(url)) return;
    syncWindowOverlayHeight();
    const runtimeSource = getMeterSource();
    if (runtimeSource) void win.webContents.executeJavaScript(runtimeSource).catch(error => console.warn('[Context Meter]', error.message));
  });
  win.webContents.on('zoom-changed', () => syncWindowOverlayHeight());
};
