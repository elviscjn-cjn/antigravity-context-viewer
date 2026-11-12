'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ipcMain, app } = require('electron');
const { builtinAsar } = require('./asar-engine');
const {
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
  recordModelCalls,
  getPluginSettings,
  savePluginSettings,
  launchCliSession,
  checkUpdateAsync,
  applyUpdateAsync
} = require('./meter-collector');
const { isValidExternalUrl } = require('./meter-core');
const { getKernelStatus, applyKernelPatch } = require('./meter-patcher');
const {
  normalizeLocale,
  normalizeBrandTitle,
  readI18nConfig,
  saveI18nConfig,
  getI18nStatus,
  generatePreloadI18nScript
} = require('./meter-i18n');

const { applyProxyEnvironment } = require('./meter-proxy');

// 启动期内存镜像备份：防止运行期重打包 app.asar 后 Electron 虚拟文件系统偏移缓存失效导致读取错位乱码
const INITIAL_CORE_CODE = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8'); } catch { return ''; }
})();
const INITIAL_RENDERER_CODE = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8'); } catch { return ''; }
})();

let kernelWarmupScheduled = false;
function scheduleBackgroundKernelWarmup() {
  if (kernelWarmupScheduled) return;
  kernelWarmupScheduled = true;
  const timer = setTimeout(() => {
    try { getKernelStatus({ skipProcessCheck: true }); } catch {}
  }, 1200);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function isSyntaxValidJs(code, filename) {
  if (!code || typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function loadFreshRuntimeAsset(filename, fallbackCode) {
  // 1. 优先尝试从外部插件源码目录加载最新磁盘文件
  try {
    const i18nCfg = readI18nConfig();
    if (i18nCfg && i18nCfg.pluginSourceDir) {
      const extFile = path.join(i18nCfg.pluginSourceDir, filename);
      if (fs.existsSync(extFile)) {
        const extCode = fs.readFileSync(extFile, 'utf8');
        if (isSyntaxValidJs(extCode, filename)) return extCode;
      }
    }
  } catch {}

  // 2. 若运行在 app.asar 内，使用 builtinAsar (process.noAsar=true) 实时解析最新 ASAR Header，彻底绕过陈旧缓存偏移
  const appAsar = path.resolve(__dirname, '..');
  if (appAsar.endsWith('.asar') && fs.existsSync(appAsar)) {
    try {
      const freshCode = builtinAsar.extractFile(appAsar, `dist/${filename}`).toString('utf8');
      if (isSyntaxValidJs(freshCode, filename)) return freshCode;
    } catch {}
  }

  // 3. 普通目录读取 + 语法校验，最终兜底回退启动期内存镜像
  try {
    const directCode = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    if (isSyntaxValidJs(directCode, filename)) return directCode;
  } catch {}

  return fallbackCode || '';
}

function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    return applyProxyEnvironment(targetEnv);
  } catch {
    return targetEnv;
  }
}
ensureProxyEnvironment(process.env);
exports.ensureProxyEnvironment = ensureProxyEnvironment;

function getMeterSource() {
  try {
    const coreCode = loadFreshRuntimeAsset('meter-core.js', INITIAL_CORE_CODE);
    const rendererCode = loadFreshRuntimeAsset('meter-renderer.js', INITIAL_RENDERER_CODE);
    if (!coreCode || !rendererCode) return '';
    let bootstrap = '';
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        bootstrap += `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
      const appAsar = path.resolve(__dirname, '..');
      const cachedKernel = getKernelStatus({ cachedOnly: true, skipProcessCheck: true });
      if (!cachedKernel) {
        scheduleBackgroundKernelWarmup();
      }
      const bootstrapSnap = {
        i18nStatus: getI18nStatus({ asarPath: appAsar.endsWith('.asar') ? appAsar : null })
      };
      if (cachedKernel) {
        bootstrapSnap.kernelStatus = cachedKernel;
      }
      bootstrap += `window.__AGContextMeterBootstrap = ${JSON.stringify(bootstrapSnap)};\n`;
    } catch {}
    return `${bootstrap}${coreCode}\n${rendererCode}\ntrue;`;
  } catch (e) {
    return '';
  }
}

function getWindowHubWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  try {
    const utils = require('./utils');
    if (typeof utils.getHubWebContents === 'function') {
      const hubWc = utils.getHubWebContents(win);
      if (hubWc && !hubWc.isDestroyed?.()) return hubWc;
    }
  } catch {}
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed?.()) return wc;
  } catch {}
  return null;
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1') return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveTargetWindow(sender) {
  try {
    const { BrowserWindow } = require('electron');
    const direct = BrowserWindow.fromWebContents(sender);
    if (direct && !direct.isDestroyed()) return direct;
  } catch {}
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch {}
  return null;
}

let registered = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();

function registerIpcOnce() {
  if (registered) return;
  registered = true;

  ipcMain.handle('context-meter:scan', async (event, id, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collect(url.origin, id, { force: force === true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:record-calls', async (event, calls) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const res = recordModelCalls(calls);
      if (res && typeof res === 'object') {
        if (res.ok === false) {
          return { ok: false, error: res.error || '入账失败', changed: false };
        }
        return { ok: true, changed: !!res.changed };
      }
      return { ok: true, changed: !!res };
    } catch (e) {
      return { ok: false, error: e.message, changed: false };
    }
  });

  ipcMain.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collectTokenHistoryAsync({ force: force === true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:get-settings', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return getPluginSettings(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:save-settings', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return savePluginSettings(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:launch-cli', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return await launchCliSession(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
    try {
      const targetWin = resolveTargetWindow(event.sender);
      if (!targetWin || targetWin.isDestroyed?.()) return { ok: false };
      if (process.platform === 'win32') {
        try {
          if (typeof targetWin.setMenuBarVisibility === 'function') targetWin.setMenuBarVisibility(false);
          targetWin.autoHideMenuBar = true;
        } catch {}
      }
      if (typeof targetWin.setTitleBarOverlay !== 'function') return { ok: true };
      const patch = {};
      if (options && typeof options.color === 'string') patch.color = options.color;
      if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
      const rawHeight = options?.height ?? options?.heightCssPx;
      if (options && Number.isFinite(Number(rawHeight)) && Number(rawHeight) >= 24 && Number(rawHeight) <= 64) {
        patch.height = Math.round(Number(rawHeight));
      }
      targetWin.setTitleBarOverlay(patch);
      return { ok: true, patch };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:check-update', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return await checkUpdateAsync(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:apply-update', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return await applyUpdateAsync(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:open-external', async (event, targetUrl) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (!isValidExternalUrl(targetUrl)) {
      return { ok: false, error: '仅允许打开官方 GitHub 仓库页面' };
    }
    try {
      const { shell } = require('electron');
      await shell.openExternal(targetUrl);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:get-kernel-status', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return getKernelStatus(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:apply-kernel-patch', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return applyKernelPatch(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:get-i18n-status', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const appAsar = path.resolve(__dirname, '..');
      return getI18nStatus({ asarPath: appAsar.endsWith('.asar') ? appAsar : null });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:apply-i18n-config', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const req = payload || {};
      const locale = normalizeLocale(req.locale);
      const brandTitle = normalizeBrandTitle(req.brandTitle);
      if (locale === undefined) return { ok: false, error: `无效的界面语言参数: ${req.locale}` };
      if (brandTitle === undefined) return { ok: false, error: `无效的品牌显示参数: ${req.brandTitle}` };
      const saved = saveI18nConfig({ locale, brandTitle });

      // 若存在插件源码目录，通过独立 Node 子进程执行 ASAR 持久化重打包，零干扰当前 Electron 主进程句柄
      let asarUpdated = false;
      let asarError = null;
      if (saved.pluginSourceDir && fs.existsSync(path.join(saved.pluginSourceDir, 'cli.js'))) {
        try {
          const { execFile } = require('child_process');
          await new Promise((resolve, reject) => {
            execFile(
              process.execPath,
              [
                path.join(saved.pluginSourceDir, 'cli.js'),
                'i18n',
                '--locale',
                saved.locale,
                '--brand-title',
                saved.brandTitle,
                '--no-live'
              ],
              {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                timeout: 45000,
                windowsHide: true
              },
              (err, stdout, stderr) => {
                if (err) reject(new Error((stderr || stdout || err.message || '').trim()));
                else resolve(stdout);
              }
            );
          });
          asarUpdated = true;
        } catch (packErr) {
          asarError = packErr.message;
        }
      }

      // 即时更新当前聊天窗口渲染层 DOM（通过跨世界事件同步销毁 preload 隔离世界旧观察者），无需重启即可预览切换效果
      try {
        const wc = event.sender;
        if (wc && !wc.isDestroyed?.()) {
          const disposeSnippet = 'try { document.dispatchEvent(new CustomEvent("__ag_i18n_dispose__")); window.__AGLocalization?.revertAndDispose?.(); } catch (e) {}';
          const liveScript = saved.locale === 'en'
            ? `${disposeSnippet} true;`
            : `${disposeSnippet}\n` +
              generatePreloadI18nScript({ locale: saved.locale, brandTitle: saved.brandTitle }) +
              '\ntrue;';
          await wc.executeJavaScript(liveScript);
        }
      } catch {}

      const appAsar = path.resolve(__dirname, '..');
      const status = getI18nStatus({ asarPath: asarUpdated && appAsar.endsWith('.asar') ? appAsar : null });
      return {
        ok: true,
        asarUpdated,
        asarError,
        status
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function syncWindowOverlayHeight(win) {
  try {
    if (!win || process.platform === 'darwin' || win.isDestroyed?.() || typeof win.setTitleBarOverlay !== 'function') return;
    const wc = getWindowHubWebContents(win);
    const zf = typeof wc?.getZoomFactor === 'function' ? wc.getZoomFactor() : 1;
    const targetH = Math.max(28, Math.min(60, Math.round(40 * (Number.isFinite(zf) && zf > 0 ? zf : 1))));
    win.setTitleBarOverlay({ height: targetH });
  } catch {}
}

async function ensureMeterInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowHubWebContents(win);
    if (!wc || wc.isDestroyed?.()) return false;
    const url = wc.getURL?.() || '';
    if (!/^https:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }

    syncWindowOverlayHeight(win);

    // 兜底自愈：同时识别 preload 隔离世界 (data-ag-i18n-locale) 与主世界汉化状态，仅在两者皆未激活时补齐，避免重复挂载观察者
    try {
      const i18nCfg = readI18nConfig();
      if (i18nCfg.locale && i18nCfg.locale !== 'en') {
        const hasLoc = await wc.executeJavaScript(
          'Boolean(window.__AGLocalization || (document.documentElement && document.documentElement.getAttribute("data-ag-i18n-locale")))'
        );
        if (!hasLoc) {
          await wc.executeJavaScript(
            generatePreloadI18nScript({ locale: i18nCfg.locale, brandTitle: i18nCfg.brandTitle }) + '\ntrue;'
          );
        }
      }
    } catch {}

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript(
          'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
        );
        if (alive === true) return true;
      } catch {}
    }

    const runtimeSource = getMeterSource();
    if (!runtimeSource) return false;

    await wc.executeJavaScript(runtimeSource);
    return true;
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      injectionTimers.set(win, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  try {
    registerIpcOnce();
    if (!win || win.isDestroyed?.()) return;

    if (!boundWindows.has(win)) {
      boundWindows.add(win);
      if (process.platform === 'win32') {
        try {
          if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
        } catch {}
      }
      const onWinVisibleOrActive = () => {
        if (process.platform === 'win32') {
          try {
            if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
            win.autoHideMenuBar = true;
          } catch {}
        }
        void ensureMeterInjected(win, { force: false });
      };
      win.on?.('show', onWinVisibleOrActive);
      win.on?.('restore', onWinVisibleOrActive);
      win.on?.('focus', onWinVisibleOrActive);
    }

    const wc = getWindowHubWebContents(win);
    if (wc && !boundWebContents.has(wc)) {
      boundWebContents.add(wc);
      wc.on?.('did-finish-load', () => {
        void ensureMeterInjected(win, { force: true });
      });
      wc.on?.('dom-ready', () => {
        void ensureMeterInjected(win, { force: false });
      });
      wc.on?.('did-navigate', () => {
        void ensureMeterInjected(win, { force: false });
      });
      wc.on?.('did-navigate-in-page', () => {
        void ensureMeterInjected(win, { force: false });
      });
      wc.on?.('zoom-changed', () => syncWindowOverlayHeight(win));
    }
  } catch (err) {
    console.warn('[Context Meter] installContextMeter error:', err?.message || String(err));
  }
};

try {
  if (app && typeof app.on === 'function') {
    app.on('browser-window-created', (_event, win) => {
      try {
        exports.installContextMeter(win);
        void ensureMeterInjected(win, { force: false });
      } catch {}
    });
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          exports.installContextMeter(w);
          void ensureMeterInjected(w, { force: true });
        }
      } catch {}
    });
    app.on('second-instance', () => {
      try {
        const utils = require('./utils');
        setTimeout(() => {
          try {
            const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
            for (const w of wins) {
              exports.installContextMeter(w);
              void ensureMeterInjected(w, { force: true });
            }
          } catch {}
        }, 120);
      } catch {}
    });
  }
} catch {}
