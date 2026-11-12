'use strict';
// Preserve Electron ASAR support in the host process.
// Context Meter Preload API Exposure Contract:
// recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls)
// getContextUnlockStatus: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-status")
// applyContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-apply")
// restoreContextUnlock: () => electron_1.ipcRenderer.invoke("context-meter:context-unlock-restore")
// additions: 'asar-engine.js', 'local-api.js', 'meter-context-unlock.js'
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadAsarEngine, builtinAsar, getStateDir, findAsarPath } = require('./asar-engine');
const { loadModulesConfig, saveModulesConfig, acquireFileLock } = require('./modules-config');
const {
  TAGS,
  validateSyntax,
  generateProxyUtilsCode,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  generateChinesePreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyCleanStructure
} = require('./modular-installer');

const asar = loadAsarEngine();
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function clearAsarCache(archivePath) {
  try {
    if (asar && typeof asar.uncacheAll === 'function') asar.uncacheAll();
    if (asar && typeof asar.uncache === 'function' && archivePath) asar.uncache(archivePath);
  } catch {}
}

function extractAsarFile(archivePath, relPath) {
  clearAsarCache(archivePath);
  try {
    return builtinAsar.extractFile(archivePath, relPath);
  } catch {
    return asar.extractFile(archivePath, relPath);
  }
}

function extractAllAsar(archivePath, destDir) {
  clearAsarCache(archivePath);
  try {
    builtinAsar.extractAll(archivePath, destDir);
  } catch {
    asar.extractAll(archivePath, destDir);
  }
}

// findAsarPath 由 ./asar-engine 纯路径共享模块提供并导出

async function tryHotInject() {
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));

    // 严格安全隔离门禁：若处于测试模式，严禁连接真实运行环境的 AppData/DevTools 端口！
    if (process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') {
      const isIsolatedTemp = appData.toLowerCase().includes(os.tmpdir().toLowerCase());
      if (!isIsolatedTemp) return false;
    }

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
  const activeManifestPath = fs.existsSync(manifestPath)
    ? manifestPath
    : (fs.existsSync(legacyManifestPath) ? legacyManifestPath : null);

  if (activeManifestPath) {
    try { previousManifest = JSON.parse(fs.readFileSync(activeManifestPath, 'utf8')); } catch {}
  }

  // 获取目标文件互斥锁，避免并发改写冲突
  const fileLock = acquireFileLock(installed);

  try {
    // 1. 若用户显式传入了 --backup 参数，严格校验其对应关系，不合规立即明确报错，绝不静默回退
    if (explicitBackup !== undefined && explicitBackup !== null) {
      const resolvedBackup = path.resolve(String(explicitBackup).trim());
      if (!fs.existsSync(resolvedBackup) || !fs.statSync(resolvedBackup).isFile()) {
        throw new Error(`指定的 --backup 文件不存在或无效: ${resolvedBackup}`);
      }
      let bHostVer = null;
      let bUtils = null;
      try {
        bHostVer = JSON.parse(extractAsarFile(resolvedBackup, 'package.json').toString('utf8')).version;
        bUtils = extractAsarFile(resolvedBackup, 'dist/utils.js').toString('utf8');
      } catch (e) {
        throw new Error(`指定的 --backup 文件无法被解析为合法 ASAR 归档: ${e.message}`);
      }
      let tHostVer = null;
      try {
        tHostVer = JSON.parse(extractAsarFile(installed, 'package.json').toString('utf8')).version;
      } catch {}
      if (bHostVer && tHostVer && bHostVer !== tHostVer) {
        throw new Error(`指定的 --backup 宿主版本 (v${bHostVer}) 与当前目标宿主版本 (v${tHostVer}) 不匹配，拒绝跨版本还原。`);
      }
      if (bUtils.includes('installContextMeter') || bUtils.includes(TAGS.METER_UTILS_START)) {
        throw new Error('指定的 --backup 文件包含本插件修改痕迹，不能作为原版基底。');
      }
      if (!verifyCleanStructure(bUtils)) {
        throw new Error('指定的 --backup 文件的 dist/utils.js 缺少标准宿主标记或语法校验未通过。');
      }
      sourceArchive = resolvedBackup;
      console.log(`[Installation] 已校验并选用显式指定的备份文件 (${path.basename(resolvedBackup)}) 作为打包基底。`);
    }

    // 2. 基底选择与原位精准解构自愈（未显式指定 --backup 时执行）
    let inPlaceCleanedUtils = null;
    let inPlaceCleanedPreload = null;

    if (sourceArchive === installed) {
      let currentUtilsRaw = null;
      let currentPreloadRaw = null;
      let targetHostVer = null;
      try {
        currentUtilsRaw = extractAsarFile(installed, 'dist/utils.js').toString('utf8');
        currentPreloadRaw = extractAsarFile(installed, 'dist/preload.js').toString('utf8');
        targetHostVer = JSON.parse(extractAsarFile(installed, 'package.json').toString('utf8')).version;
      } catch (e) {
        throw new Error(`无法解析当前目标 ASAR 内容: ${e.message}`);
      }

      const hasPluginTrace = currentUtilsRaw.includes('installContextMeter') ||
                             currentUtilsRaw.includes(TAGS.METER_UTILS_START) ||
                             currentUtilsRaw.includes(TAGS.PROXY_START) ||
                             currentPreloadRaw.includes(TAGS.CHINESE_START);

      if (!hasPluginTrace) {
        // 场景 A: 纯净宿主（全新安装或宿主官方升级后，无本插件任何模块痕迹）
        sourceArchive = installed;
      } else {
        // 场景 B: 目标包含插件痕迹
        const isKnownInstallation = Boolean(
          previousManifest &&
          previousManifest.installed &&
          path.resolve(previousManifest.installed) === path.resolve(installed)
        );

        // 若为未知的外部篡改文件（本地无安装记录且未显式指定合规备份），严格拒绝安装以保护文件
        if (!isKnownInstallation && !explicitBackup) {
          throw new Error(
            '当前 ASAR 包含未知的补丁修改痕迹且哈希不匹配安装记录，且结构无法安全解构或本地未找到通过校验的官方原版备份。为保护宿主文件安全，已安全中止安装。\n' +
            '可执行的恢复路径：\n' +
            '1. 若您持有官方原版备份文件，请使用 --backup <path-to-clean-base.asar> 指定；\n' +
            '2. 或重新运行 Antigravity 官方安装程序执行修复以恢复纯净 ASAR，随后重新安装本插件。'
          );
        }

        // 优先评估能否在当前文件自身基础上原位清洗，以 100% 保留用户的第三方修改、汉化内容与现有构建
        const potentialCleanUtils = cleanUtilsSource(currentUtilsRaw);
        const potentialCleanPreload = cleanPreloadSource(currentPreloadRaw);

        if (verifyCleanStructure(potentialCleanUtils)) {
          // 原位清洗自证通过！保留所有无关内容，不丢第三方修改，也不回退宿主版本
          inPlaceCleanedUtils = potentialCleanUtils;
          inPlaceCleanedPreload = potentialCleanPreload;
          sourceArchive = installed;
          console.log('[Installation] 当前 ASAR 包含旧补丁痕迹，已通过原位解构精准移除插件挂载，并完整保留宿主现有修改与构建内容。');
        } else {
          // 原位清洗未通过标准结构校验（例如 utils.js 源码被外部严重破坏），回退检查本地合规原版备份
          let matchedBackup = null;
          if (previousManifest) {
            const isSameTarget = Boolean(previousManifest.installed && path.resolve(previousManifest.installed) === path.resolve(installed));
            if (isSameTarget) {
              if (previousManifest.backup && fs.existsSync(previousManifest.backup) && sha(fs.readFileSync(previousManifest.backup)) === previousManifest.originalSha256) {
                matchedBackup = previousManifest.backup;
              } else if (previousManifest.previousInstalledBackup && fs.existsSync(previousManifest.previousInstalledBackup) && sha(fs.readFileSync(previousManifest.previousInstalledBackup)) === previousManifest.previousInstalledSha256) {
                matchedBackup = previousManifest.previousInstalledBackup;
              }
              if (matchedBackup) {
                let bVer = null;
                let bClean = false;
                try {
                  bVer = JSON.parse(extractAsarFile(matchedBackup, 'package.json').toString('utf8')).version;
                  const bUtils = extractAsarFile(matchedBackup, 'dist/utils.js').toString('utf8');
                  bClean = verifyCleanStructure(bUtils);
                } catch {}
                if (bVer && targetHostVer && bVer === targetHostVer && bClean) {
                  sourceArchive = matchedBackup;
                  console.log(`[Installation] 已安全采信与当前宿主版本 (v${bVer}) 匹配的原版备份 (${path.basename(matchedBackup)}) 作为基底重新安装。`);
                }
              }
            }
          }

          if (sourceArchive === installed) {
            throw new Error(
              '当前 ASAR 包含未知的补丁修改痕迹且哈希不匹配安装记录，且结构无法安全解构或本地未找到通过校验的官方原版备份。为保护宿主文件安全，已安全中止安装。\n' +
              '可执行的恢复路径：\n' +
              '1. 若您持有官方原版备份文件，请使用 --backup <path-to-clean-base.asar> 指定；\n' +
              '2. 或重新运行 Antigravity 官方安装程序执行修复以恢复纯净 ASAR，随后重新安装本插件。'
            );
          }
        }
      }
    }

    // 3. 模块配置解析与状态管理
    const modulesConfig = loadModulesConfig();
    if (options.modules) {
      if (options.modules.meter) Object.assign(modulesConfig.modules.meter, options.modules.meter);
      if (options.modules.chinese) Object.assign(modulesConfig.modules.chinese, options.modules.chinese);
      if (options.modules.proxy) Object.assign(modulesConfig.modules.proxy, options.modules.proxy);
    }
    if (process.argv.includes('--enable-chinese')) modulesConfig.modules.chinese.enabled = true;
    if (process.argv.includes('--disable-chinese')) modulesConfig.modules.chinese.enabled = false;
    if (process.argv.includes('--enable-proxy')) modulesConfig.modules.proxy.enabled = true;
    if (process.argv.includes('--disable-proxy')) modulesConfig.modules.proxy.enabled = false;
    const proxyUrlIdx = process.argv.indexOf('--proxy-url');
    if (proxyUrlIdx >= 0 && process.argv[proxyUrlIdx + 1]) {
      modulesConfig.modules.proxy.proxyUrl = process.argv[proxyUrlIdx + 1];
    }
    saveModulesConfig(modulesConfig);

    const version = JSON.parse(extractAsarFile(sourceArchive, 'package.json').toString('utf8')).version;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
    const backupDir = path.join(stateDir, 'backups');
    const snapshotDir = path.join(backupDir, 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });

    // 4. 改写前保存带有时间戳与当前实际哈希的唯一快照，用于写入失败紧急恢复
    const currentInstalledSha = sha(fs.readFileSync(installed));
    const snapshotFile = path.join(snapshotDir, `app-${version}-preinstall-${stamp}-${currentInstalledSha.slice(0, 8)}.asar`);
    fs.copyFileSync(installed, snapshotFile);

    // 5. 建立长期官方原版备份（基于当前目标路径与宿主版本严格物理隔离）
    const targetKey = crypto.createHash('sha256').update(path.resolve(installed)).digest('hex').slice(0, 8);
    const backup = path.join(backupDir, `app-${version}-${targetKey}-base.asar`);

    if (!fs.existsSync(backup)) {
      if (sourceArchive !== installed) {
        fs.copyFileSync(sourceArchive, backup);
      } else if (!extractAsarFile(sourceArchive, 'dist/utils.js').toString('utf8').includes('installContextMeter')) {
        fs.copyFileSync(sourceArchive, backup);
      }
    }

    const staging = path.join(os.tmpdir(), `ag-context-meter-pkg-${stamp}`);
    const packed = path.join(os.tmpdir(), `ag-context-meter-${stamp}.asar`);

    try {
      fs.mkdirSync(staging, { recursive: true });
      clearAsarCache(sourceArchive);
      extractAllAsar(sourceArchive, staging);

      // 先完成底层 utils 与 preload 的全量原位清洗
      let cleanUtils = cleanUtilsSource(inPlaceCleanedUtils || extractAsarFile(sourceArchive, 'dist/utils.js').toString('utf8'));
      let cleanPreload = cleanPreloadSource(inPlaceCleanedPreload || extractAsarFile(sourceArchive, 'dist/preload.js').toString('utf8'));

      if (!verifyCleanStructure(cleanUtils)) {
        throw new Error('清洗后的 utils.js 结构校验未通过 (Unexpected createWindow/setupNodeWrapper) 或 JavaScript 语法自证失败，中止写入以保护宿主环境。');
      }

      let finalUtils = cleanUtils;
      let finalPreload = cleanPreload;

      // 6. 模块组装注入（使用成对标记与运行时配置门禁，默认完整注入三模块能力，通过 modules.json 精确控制开关）
      // 若用户或测试显式传入 pureMeterOnly: true 或 --pure-meter-only，则仅注入上下文监控
      const isPureMeterOnly = Boolean(options.pureMeterOnly || process.argv.includes('--pure-meter-only'));

      // 模块 A: Proxy NoTun (免 TUN 代理组件注入)
      const shouldInjectProxy = !isPureMeterOnly && (modulesConfig.modules.proxy.enabled || options.injectProxy !== false);
      if (shouldInjectProxy) {
        const proxyCode = generateProxyUtilsCode(modulesConfig.modules.proxy);
        finalUtils = proxyCode + '\n' + finalUtils;
      }

      // 模块 B: Context Meter (上下文与 Token 监控)
      if (modulesConfig.modules.meter.enabled) {
        const meterUtils = generateMeterUtilsCode();
        finalUtils = finalUtils
          .replace('"use strict";', `"use strict";\n${meterUtils.headerProxyHook}`)
          .replace('function setupNodeWrapper(env) {', `function setupNodeWrapper(env) {${meterUtils.nodeWrapperHook}`)
          .replace("titleBarStyle: 'hidden',", `titleBarStyle: 'hidden',${meterUtils.menuBarOption}`)
          .replace('    void win.loadURL(url);', `${meterUtils.windowLoadHook}    void win.loadURL(url);`);

        const createWinSig = 'function createWindow(url, storageManager, options) {';
        if (finalUtils.includes(createWinSig) && !finalUtils.includes('__agDefaultStorageManager')) {
          finalUtils = finalUtils.replace(createWinSig, createWinSig + meterUtils.storageFallback);
        }
        if (finalUtils.includes('wins[0].focus();') && !finalUtils.includes('ensureMeterInjected(wins[0]')) {
          finalUtils = finalUtils.replace('wins[0].focus();', 'wins[0].focus();' + meterUtils.focusHook);
        }
        if (finalUtils.includes('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);') && !finalUtils.includes('ensureMeterInjected(_mWin')) {
          finalUtils = finalUtils.replace('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);', 'const _mWin = createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);' + meterUtils.createHook);
        }

        finalPreload += generateMeterPreloadCode();
      }

      // 模块 C: Chinese (桌面端界面汉化组件注入)
      const shouldInjectChinese = !isPureMeterOnly && (modulesConfig.modules.chinese.enabled || options.injectChinese !== false);
      if (shouldInjectChinese) {
        const homeDir = os.homedir();
        const localAppDir = process.platform === 'win32'
          ? (process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'))
          : (process.platform === 'darwin'
            ? path.join(homeDir, 'Library', 'Application Support')
            : path.join(homeDir, '.local', 'state'));
        const dictCandidates = [
          path.join(__dirname, 'i18n', 'zh-CN.json'),
          path.join(__dirname, 'src', 'i18n', 'zh-CN.json'),
          path.join(__dirname, 'dist', 'i18n', 'zh-CN.json'),
          path.join(__dirname, '..', 'i18n', 'zh-CN.json'),
          path.join(localAppDir, 'AntigravityContextMeter', 'i18n', 'zh-CN.json')
        ];
        const runtimeCandidates = [
          path.join(__dirname, 'i18n', 'i18n-runtime.js'),
          path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'),
          path.join(__dirname, 'dist', 'i18n', 'i18n-runtime.js'),
          path.join(__dirname, '..', 'i18n', 'i18n-runtime.js'),
          path.join(localAppDir, 'AntigravityContextMeter', 'i18n', 'i18n-runtime.js')
        ];
        const dictP = dictCandidates.find(p => fs.existsSync(p));
        const rtP = runtimeCandidates.find(p => fs.existsSync(p));
        if (dictP && rtP) {
          const dictContent = fs.readFileSync(dictP, 'utf8');
          const runtimeContent = fs.readFileSync(rtP, 'utf8');
          finalPreload += generateChinesePreloadCode(dictContent, runtimeContent);
        } else {
          throw new Error('未找到客户端汉化字典 (zh-CN.json) 或运行时脚本 (i18n-runtime.js)，拒绝在缺少必要资源时完成安装。');
        }
      }

      // 7. 写回前对最终 JavaScript 语法做严格校验断言
      if (!validateSyntax(finalUtils, 'dist/utils.js')) {
        throw new Error('注入后生成的 dist/utils.js 未通过 JavaScript 语法编译断言，中止写入以保护宿主安全。');
      }
      if (!validateSyntax(finalPreload, 'dist/preload.js')) {
        throw new Error('注入后生成的 dist/preload.js 未通过 JavaScript 语法编译断言，中止写入以保护宿主安全。');
      }

      fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), finalUtils, 'utf8');
      fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), finalPreload, 'utf8');

      // 8. 拷贝各模块 additions
      const additions = [
        'asar-engine.js',
        'modules-config.js',
        'modular-installer.js',
        'install.js',
        'restore.js',
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
        const srcP = path.join(__dirname, file);
        if (fs.existsSync(srcP) && !fs.statSync(srcP).isDirectory()) {
          fs.copyFileSync(srcP, path.join(staging, 'dist', file));
        } else {
          const inStaging = path.join(staging, 'dist', file);
          if (!fs.existsSync(inStaging)) {
            throw new Error(`缺少必需的模块依赖文件: ${file}，拒绝生成不完整的 ASAR 归档！`);
          }
        }
      }

      // 拷贝 i18n 资源文件至 ASAR 内部，确保运行中客户端可离线切换汉化
      const i18nSrcDir = path.join(__dirname, 'i18n');
      if (fs.existsSync(i18nSrcDir)) {
        const i18nDstDir = path.join(staging, 'dist', 'i18n');
        fs.mkdirSync(i18nDstDir, { recursive: true });
        for (const item of ['zh-CN.json', 'i18n-runtime.js']) {
          const itemP = path.join(i18nSrcDir, item);
          if (fs.existsSync(itemP)) fs.copyFileSync(itemP, path.join(i18nDstDir, item));
        }
      }

      const originalEntries = asar.listPackage(sourceArchive);
      const hasUnpacked = originalEntries.some(file => {
        const s = asar.statFile(sourceArchive, file.slice(1));
        return s && s.unpacked;
      });

      if (hasUnpacked) {
        await builtinAsar.createPackageWithOptions(staging, packed, { unpackDir: '**/chrome-devtools-mcp' });
      } else {
        await builtinAsar.createPackageWithOptions(staging, packed, {});
      }

      let verified = 0;
      const allowedChanges = [
        'dist/utils.js',
        'dist/preload.js',
        'dist/i18n/zh-CN.json',
        'dist/i18n/i18n-runtime.js',
        ...additions.map(f => 'dist/' + f)
      ].map(p => path.normalize(p));
      for (const file of originalEntries) {
        const name = path.normalize(file.slice(1));
        const before = asar.statFile(sourceArchive, name);
        const after = asar.statFile(packed, name);
        if (before.files || before.link) continue;
        if (!!before.unpacked !== !!after.unpacked) throw new Error(`Unpack flag changed: ${name}`);
        const isAllowed = allowedChanges.includes(name) || name.startsWith('dist' + path.sep + 'i18n' + path.sep);
        if (!isAllowed && sha(asar.extractFile(sourceArchive, name)) !== sha(asar.extractFile(packed, name))) {
          throw new Error(`Unexpected file change: ${name}`);
        }
        verified++;
      }

      const isSameTargetManifest = Boolean(previousManifest?.installed && path.resolve(previousManifest.installed) === path.resolve(installed));
      const previousInstalledBackup = (isSameTargetManifest && previousManifest?.previousInstalledBackup && fs.existsSync(previousManifest.previousInstalledBackup))
        ? previousManifest.previousInstalledBackup
        : path.join(backupDir, `pre-meter-${version}-${targetKey}.asar`);

      if (fs.existsSync(backup) && !fs.existsSync(previousInstalledBackup)) {
        try { fs.copyFileSync(backup, previousInstalledBackup); } catch {}
      }
      const previousInstalledSha256 = fs.existsSync(previousInstalledBackup) ? sha(fs.readFileSync(previousInstalledBackup)) : null;
      const origSha = fs.existsSync(backup) ? sha(fs.readFileSync(backup)) : (previousInstalledSha256 || previousManifest?.originalSha256);

      const { PROJECT_VERSION } = require('./modules-config');
      const pkgVersion = PROJECT_VERSION;

      const manifest = {
        meterVersion: pkgVersion,
        version,
        installed,
        backup,
        previousInstalledBackup,
        previousInstalledSha256,
        originalSha256: origSha,
        patchedSha256: sha(fs.readFileSync(packed)),
        originalFilesVerified: verified,
        added: additions.map(f => 'dist/' + f),
        modified: ['dist/utils.js', 'dist/preload.js'],
        installedAt: new Date().toISOString(),
        enabledModules: Object.entries(modulesConfig.modules).filter(([, v]) => v.enabled).map(([k]) => k)
      };

      let installCommitted = false;
      const tempReplacement = path.join(path.dirname(installed), `app.asar.tmp_${stamp}`);

      try {
        // 9. 临时文件写入与校验
        fs.copyFileSync(packed, tempReplacement);
        if (sha(fs.readFileSync(tempReplacement)) !== manifest.patchedSha256) {
          throw new Error('Packed temporary file checksum mismatch; aborting before touching target.');
        }

        // 10. 安全原子替换目标文件
        try {
          fs.copyFileSync(tempReplacement, installed);
          clearAsarCache(installed);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') {
            throw new Error(`无法写入目标文件 (${installed})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
          }
          throw err;
        } finally {
          try { if (fs.existsSync(tempReplacement)) fs.unlinkSync(tempReplacement); } catch {}
        }

        if (sha(fs.readFileSync(installed)) !== manifest.patchedSha256) {
          throw new Error('Installed checksum mismatch');
        }

        // 11. 安装后从目标 ASAR 中重新读取核心启动文件并核对哈希与启动逻辑
        const extractedLauncher = extractAsarFile(installed, 'dist/meter-cli-launcher.js').toString('utf8');
        const localLauncherCandidates = [
          path.join(__dirname, 'meter-cli-launcher.js'),
          path.join(__dirname, '..', 'meter-cli-launcher.js')
        ];
        const localLauncherPath = localLauncherCandidates.find(p => fs.existsSync(p));
        const installedLauncherSha = sha(Buffer.from(extractedLauncher, 'utf8'));
        if (localLauncherPath) {
          const localLauncherSha = sha(fs.readFileSync(localLauncherPath));
          if (installedLauncherSha !== localLauncherSha) {
            throw new Error(`ASAR 内 meter-cli-launcher.js 哈希核验失败 (ASAR: ${installedLauncherSha}, Local: ${localLauncherSha})`);
          }
        }
        if (extractedLauncher.includes("spawnSync('powershell.exe'") || extractedLauncher.includes('timeout: 8000')) {
          throw new Error('ASAR 内仍然残留旧版同步 PowerShell 启动逻辑，拒绝完成安装！');
        }
        if (!extractedLauncher.includes('0.8.1-helper-v2')) {
          throw new Error('ASAR 内未包含最新的 LAUNCHER_VERSION 标识，拒绝完成安装！');
        }

        const extractedMain = extractAsarFile(installed, 'dist/meter-main.js').toString('utf8');
        const localMainCandidates = [
          path.join(__dirname, 'meter-main.js'),
          path.join(__dirname, '..', 'meter-main.js')
        ];
        const localMainPath = localMainCandidates.find(p => fs.existsSync(p));
        const installedMainSha = sha(Buffer.from(extractedMain, 'utf8'));
        if (localMainPath) {
          const localMainSha = sha(fs.readFileSync(localMainPath));
          if (installedMainSha !== localMainSha) {
            throw new Error(`ASAR 内 meter-main.js 哈希核验失败 (ASAR: ${installedMainSha}, Local: ${localMainSha})`);
          }
        }

        // 12. 同步部署 CLI 辅助定位程序至状态目录与资源目录并核对哈希
        let helperSha = null;
        const helperCandidates = [
          path.join(__dirname, 'scripts', 'cli-window-helper.exe'),
          path.join(__dirname, '..', 'scripts', 'cli-window-helper.exe'),
          path.join(stateDir, 'cli-window-helper.exe'),
          path.join(path.dirname(installed), 'bin', 'cli-window-helper.exe')
        ];
        const helperSrc = helperCandidates.find(p => fs.existsSync(p));
        if (helperSrc) {
          helperSha = sha(fs.readFileSync(helperSrc));
          const deployedHelperPath = path.join(stateDir, 'cli-window-helper.exe');
          if (deployedHelperPath !== helperSrc) {
            fs.copyFileSync(helperSrc, deployedHelperPath);
          }
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

        installCommitted = true;
        const liveInjected = await tryHotInject();
        return { ...manifest, liveInjected };
      } catch (err) {
        // 失败回滚机制：若在改写目标后发生任何校验或保存异常，立即从快照无损回滚还原
        if (!installCommitted && fs.existsSync(snapshotFile)) {
          try {
            fs.copyFileSync(snapshotFile, installed);
            clearAsarCache(installed);
            console.error(`[Failure-Rollback] 安装过程异常中断，已自动从改写前快照还原目标文件: ${installed}`);
          } catch (rollbackErr) {
            console.error(`[Fatal Rollback Error] 快照回滚失败: ${rollbackErr.message}`);
          }
        }
        throw err;
      }
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(packed, { force: true }); } catch {}
      try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
    }
  } finally {
    fileLock.release();
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

module.exports = { install, findAsarPath, tryHotInject, extractAsarFile };
