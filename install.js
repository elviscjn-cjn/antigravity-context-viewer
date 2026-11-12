'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadAsarEngine, builtinAsar, getStateDir } = require('./asar-engine');

const asar = loadAsarEngine();
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function extractAsarFile(archivePath, relPath) {
  try {
    return builtinAsar.extractFile(archivePath, relPath);
  } catch {
    return asar.extractFile(archivePath, relPath);
  }
}

function findAsarPath(customPath) {
  if (customPath) {
    let resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const inRes = path.join(resolved, 'resources', 'app.asar');
      if (fs.existsSync(inRes)) return inRes;
      const direct = path.join(resolved, 'app.asar');
      if (fs.existsSync(direct)) return direct;
    }
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`Could not find app.asar at specified path: ${customPath}`);
  }
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(home, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.');
}

async function tryHotInject() {
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
    const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) return false;
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    if (!port) return false;
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const targets = pages.filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    if (!targets.length) return false;

    const stateDir = getStateDir();
    const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
      ? path.join(stateDir, '.live-session.json')
      : path.join(__dirname, '.live-session.json');
    const liveInfo = fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : null;
    const bundle = ['meter-core.js', 'meter-renderer.js']
      .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))
      .join('\n');

    let injectedCount = 0;
    for (const target of targets) {
      let ws = null;
      try {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        let seq = 0;
        const evalExpr = expression => new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => reject(new Error('CDP eval timeout')), 5000);
          const handler = ev => {
            const d = JSON.parse(ev.data);
            if (d.id === id) {
              clearTimeout(timer);
              ws.removeEventListener('message', handler);
              resolve(d);
            }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        });
        if (liveInfo && liveInfo.origin === new URL(target.url).origin) {
          await evalExpr('window.__AGContextMeterLive=' + JSON.stringify({ port: liveInfo.port, token: liveInfo.token }));
        }
        try {
          const { collectTokenHistoryAsync, getPluginSettings } = require('./meter-collector');
          const settingsSnap = getPluginSettings();
          if (settingsSnap && settingsSnap.ok) {
            await evalExpr('window.__AGContextMeterSettings=' + JSON.stringify(settingsSnap));
          }
          const historyData = await collectTokenHistoryAsync({ force: true });
          if (historyData && !historyData.loading) {
            await evalExpr('window.__AGContextMeterHistory=' + JSON.stringify(historyData));
          }
        } catch {}
        const evalRes = await evalExpr(bundle);
        if (evalRes && !evalRes.error && !evalRes.result?.exceptionDetails) {
          injectedCount++;
        }
      } catch {} finally {
        if (ws) {
          try { ws.close(); } catch {}
        }
      }
    }
    return injectedCount > 0;
  } catch {
    return false;
  }
}

async function install(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const customBackupIdx = process.argv.indexOf('--backup');
  const explicitBackup = options.backup || (customBackupIdx >= 0 ? process.argv[customBackupIdx + 1] : null);

  const installed = findAsarPath(customPath);
  const stateDir = getStateDir();
  let sourceArchive = installed;
  let previousManifest = null;
  const manifestPath = path.join(stateDir, 'installation.json');
  const legacyManifestPath = path.join(__dirname, 'installation.json');

  // 若用户显式传入了官方原版备份文件，执行前置结构与纯净性验证后优先采纳
  if (explicitBackup && fs.existsSync(explicitBackup)) {
    try {
      const explicitUtils = asar.extractFile(explicitBackup, 'dist/utils.js').toString('utf8');
      if (!explicitUtils.includes('installContextMeter') && explicitUtils.includes('void win.loadURL(url);')) {
        sourceArchive = explicitBackup;
      }
    } catch {}
  }

  const activeManifestPath = fs.existsSync(manifestPath)
    ? manifestPath
    : (fs.existsSync(legacyManifestPath) ? legacyManifestPath : null);

  if (activeManifestPath && sourceArchive === installed) {
    const previous = JSON.parse(fs.readFileSync(activeManifestPath, 'utf8'));
    const isSameTarget = Boolean(previous.installed && path.resolve(previous.installed) === path.resolve(installed));
    const currentInstalledSha = sha(fs.readFileSync(installed));

    let matchedBackup = null;
    if (previous.backup && fs.existsSync(previous.backup) && sha(fs.readFileSync(previous.backup)) === previous.originalSha256) {
      matchedBackup = previous.backup;
    } else if (previous.previousInstalledBackup && fs.existsSync(previous.previousInstalledBackup) && sha(fs.readFileSync(previous.previousInstalledBackup)) === previous.previousInstalledSha256) {
      matchedBackup = previous.previousInstalledBackup;
    }

    if (isSameTarget && currentInstalledSha === previous.patchedSha256) {
      // 场景 1: 标准升级/重装（当前文件哈希与记录完全吻合）
      if (!matchedBackup) {
        throw new Error('Original backup checksum mismatch; refusing to install over patched archive without valid backup.');
      }
      previousManifest = previous;
      sourceArchive = matchedBackup;
      if (fs.existsSync(installed + '.unpacked') && !fs.existsSync(sourceArchive + '.unpacked')) {
        fs.cpSync(installed + '.unpacked', sourceArchive + '.unpacked', { recursive: true, force: false, errorOnExist: true });
      }
    } else if (isSameTarget && matchedBackup) {
      // 场景 2: 自动安全恢复（当前 ASAR 哈希与清单不一致，如热注入或外部操作导致，但本地存在经过严格 SHA-256 校验的官方原版备份）
      let backupHostVer = null;
      let targetHostVer = null;
      let backupIsClean = false;
      try {
        backupHostVer = JSON.parse(asar.extractFile(matchedBackup, 'package.json').toString('utf8')).version;
        targetHostVer = JSON.parse(asar.extractFile(installed, 'package.json').toString('utf8')).version;
        const backupUtils = asar.extractFile(matchedBackup, 'dist/utils.js').toString('utf8');
        backupIsClean = !backupUtils.includes('installContextMeter') && backupUtils.includes('void win.loadURL(url);');
      } catch {}

      if (matchedBackup) {
        let backupHostVer = null;
        let targetHostVer = null;
        let backupIsClean = false;
        try {
          backupHostVer = JSON.parse(extractAsarFile(matchedBackup, 'package.json').toString('utf8')).version;
          targetHostVer = JSON.parse(extractAsarFile(installed, 'package.json').toString('utf8')).version;
          const backupUtils = extractAsarFile(matchedBackup, 'dist/utils.js').toString('utf8');
          backupIsClean = !backupUtils.includes('installContextMeter') && backupUtils.includes('void win.loadURL(url);');
        } catch {}

        if (backupHostVer && targetHostVer && backupHostVer === targetHostVer && backupIsClean) {
          console.log(`[Auto-Recovery] 当前目标 ASAR 包含补丁痕迹但哈希与安装清单不一致，已成功通过 SHA-256 校验安全采信本地官方原版备份 (v${backupHostVer}, ${path.basename(matchedBackup)}) 作为基底重新安装。`);
          previousManifest = previous;
          sourceArchive = matchedBackup;
          if (fs.existsSync(installed + '.unpacked') && !fs.existsSync(sourceArchive + '.unpacked')) {
            fs.cpSync(installed + '.unpacked', sourceArchive + '.unpacked', { recursive: true, force: false, errorOnExist: true });
          }
        } else {
          sourceArchive = installed;
        }
      } else {
        sourceArchive = installed;
      }
    } else {
      sourceArchive = installed;
    }
  }

  const version = JSON.parse(extractAsarFile(sourceArchive, 'package.json').toString('utf8')).version;
  let originalUtils = extractAsarFile(sourceArchive, 'dist/utils.js').toString('utf8');
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  const createWinSig = 'function createWindow(url, storageManager, options) {';
  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  const showOrCreateHookFocus = '        wins[0].focus();\n        try { require("./meter-main").installContextMeter(wins[0]); require("./meter-main").ensureMeterInjected(wins[0], { force: true }); } catch {}';
  const showOrCreateHookCreate = '        const _mWin = createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);\n        try { require("./meter-main").installContextMeter(_mWin); require("./meter-main").ensureMeterInjected(_mWin, { force: true }); } catch {}';

  // 若当前文件不是已知补丁，但却包含补丁痕迹，且本地未找到合法原版备份，严格安全中止以保持当前文件不变
  if (sourceArchive === installed && originalUtils.includes('installContextMeter')) {
    throw new Error(
      '当前 ASAR 包含未知的补丁修改痕迹且哈希不匹配安装记录，且本地未找到通过校验的官方原版备份。为保护宿主文件安全，已中止操作。\n' +
      '可执行的恢复路径：\n' +
      '1. 若您持有官方原版备份，请使用 --backup <path-to-clean-base.asar> 指定；\n' +
      '2. 或重新运行 Antigravity 官方安装程序执行修复以恢复纯净 ASAR，随后重新安装本插件。'
    );
  }

  if (originalUtils.includes('installContextMeter')) {
    originalUtils = originalUtils
      .replace('try { require("./meter-main").ensureProxyEnvironment(process.env); } catch {}\n', '')
      .replace('\n    try { require("./meter-main").ensureProxyEnvironment(env); } catch {}', '')
      .replace('\n' + storageFallbackLine, '')
      .replace(hookLine, '')
      .replace(/\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(wins\[0\]\);[\s\S]*?\}\s*catch\s*\{\}/g, '')
      .replace(/const _mWin = createWindow\(`\$\{constants_1\.WINDOW_ORIGIN\}:\$\{port\}\/`\);\s*\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(_mWin\);[\s\S]*?\}\s*catch\s*\{\}/g, 'createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);');
  }
  const marker = '    void win.loadURL(url);';
  const setupNodeMarker = 'function setupNodeWrapper(env) {';
  if (originalUtils.split(marker).length !== 2 || !originalUtils.includes(setupNodeMarker)) {
    throw new Error('Unexpected createWindow/setupNodeWrapper source in dist/utils.js; nothing changed.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const targetKey = crypto.createHash('sha256').update(path.resolve(installed)).digest('hex').slice(0, 8);
  const backup = path.join(backupDir, `app-${version}-${targetKey}-base.asar`);

  if (!fs.existsSync(backup) || sha(fs.readFileSync(backup)) !== sha(fs.readFileSync(sourceArchive))) {
    fs.copyFileSync(sourceArchive, backup);
  }
  if (fs.existsSync(sourceArchive + '.unpacked') && !fs.existsSync(backup + '.unpacked')) {
    fs.cpSync(sourceArchive + '.unpacked', backup + '.unpacked', { recursive: true, force: false, errorOnExist: true });
  }

  const staging = path.join(os.tmpdir(), `ag-context-meter-pkg-${stamp}`);
  const packed = path.join(os.tmpdir(), `ag-context-meter-${stamp}.asar`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    asar.extractAll(sourceArchive, staging);
    let patchedUtils = originalUtils
      .replace('"use strict";', '"use strict";\ntry { require("./meter-main").ensureProxyEnvironment(process.env); } catch {}')
      .replace(setupNodeMarker, setupNodeMarker + '\n    try { require("./meter-main").ensureProxyEnvironment(env); } catch {}')
      .replace("titleBarStyle: 'hidden',", "titleBarStyle: 'hidden',\n        autoHideMenuBar: true,")
      .replace(marker, hookLine + marker);
    if (patchedUtils.includes(createWinSig) && !patchedUtils.includes('__agDefaultStorageManager')) {
      patchedUtils = patchedUtils.replace(createWinSig, createWinSig + '\n' + storageFallbackLine);
    }
    if (patchedUtils.includes('wins[0].focus();') && !patchedUtils.includes('ensureMeterInjected(wins[0]')) {
      patchedUtils = patchedUtils.replace('wins[0].focus();', showOrCreateHookFocus);
    }
    if (patchedUtils.includes('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);') && !patchedUtils.includes('ensureMeterInjected(_mWin')) {
      patchedUtils = patchedUtils.replace('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);', showOrCreateHookCreate);
    }
    fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), patchedUtils);

    const preloadPath = path.join(staging, 'dist', 'preload.js');
    const preloadMarker = '// Context Meter v2: narrow read-only conversation scan API';
    let preloadContent = fs.readFileSync(preloadPath, 'utf8');
    if (preloadContent.includes(preloadMarker)) {
      const regex = /\r?\n?\/\/ Context Meter v2: narrow read-only conversation scan API\r?\nelectron_1\.contextBridge\.exposeInMainWorld\("contextMeterAPI",\s*\{[\s\S]*?\}\);\r?\n?/g;
      preloadContent = preloadContent.replace(regex, '\n');
    }
    preloadContent += `\n${preloadMarker}\nelectron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true), getTokenHistory: (force) => electron_1.ipcRenderer.invoke("context-meter:token-history", force === true), syncOverlay: (opts) => electron_1.ipcRenderer.invoke("context-meter:sync-overlay", opts), recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls), getSettings: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-settings", opts), saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload), launchCli: (opts) => electron_1.ipcRenderer.invoke("context-meter:launch-cli", opts), checkUpdate: (opts) => electron_1.ipcRenderer.invoke("context-meter:check-update", opts), applyUpdate: (opts) => electron_1.ipcRenderer.invoke("context-meter:apply-update", opts), openExternal: (url) => electron_1.ipcRenderer.invoke("context-meter:open-external", url), getContextUnlockStatus: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-status"), applyContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-apply"), restoreContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-restore") });\n`;
    fs.writeFileSync(preloadPath, preloadContent);

    const additions = [
      'asar-engine.js',
      'meter-main.js',
      'meter-core.js',
      'meter-renderer.js',
      'meter-collector.js',
      'meter-storage.js',
      'meter-proxy.js',
      'meter-cli-launcher.js',
      'meter-context-unlock.js',
      'local-api.js',
      'attachment_scan.py'
    ];
    for (const file of additions) {
      fs.copyFileSync(path.join(__dirname, file), path.join(staging, 'dist', file));
    }

    const originalEntries = asar.listPackage(sourceArchive);
    for (const file of originalEntries) {
      const stat = asar.statFile(sourceArchive, file.slice(1));
      if (stat.unpacked && !file.replaceAll('\\', '/').startsWith('/node_modules/chrome-devtools-mcp/')) {
        throw new Error('Unexpected unpacked file; not installing.');
      }
    }

    const hasUnpacked = originalEntries.some(file => {
      const s = asar.statFile(sourceArchive, file.slice(1));
      return s && s.unpacked;
    });

    if (hasUnpacked) {
      await asar.createPackageWithOptions(staging, packed, { unpackDir: '**/chrome-devtools-mcp' });
    } else {
      await asar.createPackageWithOptions(staging, packed, {});
    }

    let verified = 0;
    const allowedChanges = ['dist/utils.js', 'dist/preload.js', ...additions.map(f => 'dist/' + f)].map(p => path.normalize(p));
    for (const file of originalEntries) {
      const name = path.normalize(file.slice(1));
      const before = asar.statFile(sourceArchive, name);
      const after = asar.statFile(packed, name);
      if (before.files || before.link) continue;
      if (!!before.unpacked !== !!after.unpacked) throw new Error(`Unpack flag changed: ${name}`);
      if (!allowedChanges.includes(name) &&
          sha(asar.extractFile(sourceArchive, name)) !== sha(asar.extractFile(packed, name))) {
        throw new Error(`Unexpected file change: ${name}`);
      }
      verified++;
    }

    const previousInstalledBackup = path.join(backupDir, `pre-meter-${version}-${targetKey}.asar`);
    if (sourceArchive === installed || !fs.existsSync(previousInstalledBackup)) {
      fs.copyFileSync(backup, previousInstalledBackup);
    }
    const previousInstalledSha256 = sha(fs.readFileSync(previousInstalledBackup));

    const pkgVersion = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.8.1';
      } catch {
        return '0.8.1';
      }
    })();

    const manifest = {
      meterVersion: pkgVersion,
      version,
      installed,
      backup,
      previousInstalledBackup,
      previousInstalledSha256,
      originalSha256: sha(fs.readFileSync(backup)),
      patchedSha256: sha(fs.readFileSync(packed)),
      originalFilesVerified: verified,
      added: additions.map(f => 'dist/' + f),
      modified: ['dist/utils.js', 'dist/preload.js'],
      installedAt: new Date().toISOString()
    };

    try {
      fs.copyFileSync(packed, installed);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw new Error(`无法写入目标文件 (${installed})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
      }
      throw err;
    }
    if (sha(fs.readFileSync(installed)) !== manifest.patchedSha256) {
      throw new Error('Installed checksum mismatch');
    }

    // 安装后从目标 ASAR 中重新读取核心启动文件并核对哈希与启动逻辑
    const extractedLauncher = extractAsarFile(installed, 'dist/meter-cli-launcher.js').toString('utf8');
    const localLauncherSha = sha(fs.readFileSync(path.join(__dirname, 'meter-cli-launcher.js')));
    const installedLauncherSha = sha(Buffer.from(extractedLauncher, 'utf8'));
    if (installedLauncherSha !== localLauncherSha) {
      throw new Error(`ASAR 内 meter-cli-launcher.js 哈希核验失败 (ASAR: ${installedLauncherSha}, Local: ${localLauncherSha})`);
    }
    if (extractedLauncher.includes("spawnSync('powershell.exe'") || extractedLauncher.includes('timeout: 8000')) {
      throw new Error('ASAR 内仍然残留旧版同步 PowerShell 启动逻辑，拒绝完成安装！');
    }
    if (!extractedLauncher.includes('0.8.1-helper-v2')) {
      throw new Error('ASAR 内未包含最新的 LAUNCHER_VERSION 标识，拒绝完成安装！');
    }

    const extractedMain = extractAsarFile(installed, 'dist/meter-main.js').toString('utf8');
    const localMainSha = sha(fs.readFileSync(path.join(__dirname, 'meter-main.js')));
    const installedMainSha = sha(Buffer.from(extractedMain, 'utf8'));
    if (installedMainSha !== localMainSha) {
      throw new Error(`ASAR 内 meter-main.js 哈希核验失败 (ASAR: ${installedMainSha}, Local: ${localMainSha})`);
    }

    // 同步部署 CLI 辅助定位程序至状态目录与资源目录并核对哈希
    let helperSha = null;
    const helperSrc = path.join(__dirname, 'scripts', 'cli-window-helper.exe');
    if (fs.existsSync(helperSrc)) {
      helperSha = sha(fs.readFileSync(helperSrc));
      const deployedHelperPath = path.join(stateDir, 'cli-window-helper.exe');
      fs.copyFileSync(helperSrc, deployedHelperPath);
      const deployedSha = sha(fs.readFileSync(deployedHelperPath));
      if (deployedSha !== helperSha) {
        throw new Error(`部署的 helper 哈希不一致 (目标: ${deployedSha}, 源: ${helperSha})`);
      }
      const resBinDir = path.join(path.dirname(installed), 'bin');
      if (fs.existsSync(resBinDir)) {
        try {
          fs.copyFileSync(helperSrc, path.join(resBinDir, 'cli-window-helper.exe'));
        } catch {}
      }
    }

    manifest.verifiedLauncherSha256 = installedLauncherSha;
    manifest.verifiedMainSha256 = installedMainSha;
    manifest.helperSha256 = helperSha;
    manifest.verifiedAt = new Date().toISOString();

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const liveInjected = await tryHotInject();
    return { ...manifest, liveInjected };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(packed, { force: true }); } catch {}
    try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  install()
    .then(manifest => console.log(JSON.stringify(manifest, null, 2)))
    .catch(error => {
      console.error(String(error.stack || error.message).slice(0, 2000));
      process.exitCode = 1;
    });
}

module.exports = { install, findAsarPath, tryHotInject };
