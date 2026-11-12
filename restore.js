'use strict';
// Preserve Electron ASAR support in the host process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getStateDir, builtinAsar, loadAsarEngine } = require('./asar-engine');
const { acquireFileLock } = require('./modules-config');
const {
  TAGS,
  validateSyntax,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyCleanStructure
} = require('./modular-installer');

const asar = loadAsarEngine();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function clearAsarCache(archivePath) {
  try {
    if (asar && typeof asar.uncacheAll === 'function') asar.uncacheAll();
    if (asar && typeof asar.uncache === 'function' && archivePath) asar.uncache(archivePath);
  } catch {}
}

function extractAllAsar(archivePath, destDir) {
  clearAsarCache(archivePath);
  try {
    asar.extractAll(archivePath, destDir);
  } catch {
    builtinAsar.extractAll(archivePath, destDir);
  }
}

function extractAsarFile(archivePath, relPath) {
  clearAsarCache(archivePath);
  try {
    return builtinAsar.extractFile(archivePath, relPath);
  } catch {
    return asar.extractFile(archivePath, relPath);
  }
}

async function tryHotDispose() {
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
    for (const target of targets) {
      let ws = null;
      try {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__AGContextMeter?.dispose()' } }));
        await new Promise(r => setTimeout(r, 100));
      } catch {} finally {
        if (ws) { try { ws.close(); } catch {} }
      }
    }
    return targets.length > 0;
  } catch {
    return false;
  }
}

async function restore(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const stateManifest = path.join(getStateDir(), 'installation.json');
  const localManifest = path.join(__dirname, 'installation.json');
  const manifestPath = fs.existsSync(stateManifest) ? stateManifest : localManifest;
  if (!fs.existsSync(manifestPath)) {
    throw new Error('installation.json not found; nothing to restore.');
  }
  const info = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const targetFile = customPath ? path.resolve(customPath) : (info.installed ? path.resolve(info.installed) : null);
  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error(`Target file not found: ${targetFile || info.installed}`);
  }

  // 1. 自定义 --path 严格检查目标归属，绝不使用一个目标的备份去恢复另一个目标
  const isSameTarget = Boolean(info.installed && path.resolve(info.installed) === path.resolve(targetFile));
  if (customPath && !isSameTarget) {
    throw new Error(`指定的卸载目标 (${targetFile}) 与安装记录中的目标 (${info.installed}) 不一致，拒绝跨目标还原。`);
  }

  // 获取目标文件互斥锁，避免并发写冲突
  const fileLock = acquireFileLock(targetFile);

  try {
    // 2. 严格验证备份完整性：即使传入 --force 也绝对不能使用损坏或哈希不匹配的备份
    const previous = process.argv.includes('--previous') || Boolean(options.previous);
    let backup = previous ? info.previousInstalledBackup : (info.previousInstalledBackup && fs.existsSync(info.previousInstalledBackup) && sha(info.previousInstalledBackup) === info.previousInstalledSha256 ? info.previousInstalledBackup : info.backup);
    let expected = (backup === info.previousInstalledBackup) ? info.previousInstalledSha256 : info.originalSha256;
    if (!backup || !fs.existsSync(backup) || sha(backup) !== expected) {
      if (info.backup && fs.existsSync(info.backup) && sha(info.backup) === info.originalSha256) {
        backup = info.backup;
        expected = info.originalSha256;
      } else {
        throw new Error('Backup checksum mismatch; refusing restore');
      }
    }

    // 3. 严格验证备份文件与目标文件的版本兼容性，防止将新宿主降级回旧备份
    let backupHostVer = null;
    let targetHostVer = null;
    try {
      backupHostVer = JSON.parse(extractAsarFile(backup, 'package.json').toString('utf8')).version;
      targetHostVer = JSON.parse(extractAsarFile(targetFile, 'package.json').toString('utf8')).version;
    } catch (e) {
      throw new Error(`解析 ASAR 版本失败: ${e.message}`);
    }
    if (backupHostVer && targetHostVer && backupHostVer !== targetHostVer) {
      throw new Error(`目标文件 (${targetFile}) 校验失败：备份宿主版本 (v${backupHostVer}) 与当前目标宿主版本 (v${targetHostVer}) 不匹配，文件内容已被宿主升级、第三方补丁或其他操作改变，拒绝覆盖还原以保护宿主文件。`);
    }

    const currentInstalledSha = sha(targetFile);
    // 当前文件已经等于目标备份时，幂等返回
    if (currentInstalledSha === expected) {
      await tryHotDispose();
      return { restored: targetFile, fromBackup: backup, alreadyRestored: true };
    }

    const force = process.argv.includes('--force') || Boolean(options.force);

    // 4. 标准正常卸载：当前文件匹配本次补丁哈希且备份校验通过，直接恢复官方原版备份（保证哈希精确匹配）
    if (currentInstalledSha === info.patchedSha256) {
      try {
        fs.copyFileSync(backup, targetFile);
        clearAsarCache(targetFile);
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          throw new Error(`无法还原目标文件 (${targetFile})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
        }
        throw err;
      }
      if (sha(targetFile) !== expected) {
        throw new Error('Restored file checksum mismatch');
      }
      await tryHotDispose();
      try {
        info.restoredAt = new Date().toISOString();
        fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
      } catch {}
      return { restored: targetFile, fromBackup: backup };
    }

    // 5. 脱节状态（当前文件哈希与记录不一致，如用户后续安装了第三方插件或汉化包）：
    let currentUtilsRaw = null;
    let currentPreloadRaw = null;
    try {
      currentUtilsRaw = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
      currentPreloadRaw = extractAsarFile(targetFile, 'dist/preload.js').toString('utf8');
    } catch {}

    const hasMeterTraces = Boolean(
      currentUtilsRaw && (
        currentUtilsRaw.includes('installContextMeter') ||
        currentUtilsRaw.includes(TAGS.METER_UTILS_START) ||
        currentUtilsRaw.includes(TAGS.PROXY_START)
      )
    );

    // 若未传 --force，且当前包含插件痕迹：优先尝试原位手术刀精准解构卸载，完整保留第三方修改与现有构建
    if (!force && hasMeterTraces) {
      const potentialCleanUtils = cleanUtilsSource(currentUtilsRaw);
      const potentialCleanPreload = cleanPreloadSource(currentPreloadRaw);

      if (verifyCleanStructure(potentialCleanUtils)) {
        const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const staging = path.join(os.tmpdir(), `ag-restore-staging-${stamp}`);
        const packed = path.join(os.tmpdir(), `ag-restore-packed-${stamp}.asar`);
        try {
          fs.mkdirSync(staging, { recursive: true });
          clearAsarCache(targetFile);
          extractAllAsar(targetFile, staging);

          fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), potentialCleanUtils, 'utf8');
          if (potentialCleanPreload) {
            fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), potentialCleanPreload, 'utf8');
          }

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
          for (const f of additions) {
            const p = path.join(staging, 'dist', f);
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
          }
          try { fs.rmSync(path.join(staging, 'dist', 'i18n'), { recursive: true, force: true }); } catch {}

          const snapshotDir = path.join(getStateDir(), 'backups', 'snapshots');
          fs.mkdirSync(snapshotDir, { recursive: true });
          const snapshotFile = path.join(snapshotDir, `app-${targetHostVer}-prerestore-${stamp}-${currentInstalledSha.slice(0, 8)}.asar`);
          fs.copyFileSync(targetFile, snapshotFile);

          const originalEntries = asar.listPackage(targetFile);
          const hasUnpacked = originalEntries.some(file => {
            const s = asar.statFile(targetFile, file.slice(1));
            return s && s.unpacked;
          });

          if (hasUnpacked) {
            await builtinAsar.createPackageWithOptions(staging, packed, { unpackDir: '**/chrome-devtools-mcp' });
          } else {
            await builtinAsar.createPackageWithOptions(staging, packed, {});
          }

          // 临时文件写入与校验，保证替换安全性
          const tempReplacement = path.join(path.dirname(targetFile), `app.asar.restore_tmp_${stamp}`);
          fs.copyFileSync(packed, tempReplacement);

          let restoreCommitted = false;
          try {
            // 执行替换
            try {
              fs.copyFileSync(tempReplacement, targetFile);
              clearAsarCache(targetFile);
            } catch (err) {
              if (err.code === 'EBUSY' || err.code === 'EPERM') {
                throw new Error(`无法还原目标文件 (${targetFile})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
              }
              throw err;
            } finally {
              try { if (fs.existsSync(tempReplacement)) fs.unlinkSync(tempReplacement); } catch {}
            }

            // 写入后校验：确保替换后的文件包含清洗后的合法 utils，且绝不包含本插件标记
            const postRestoreUtils = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
            if (postRestoreUtils.includes('installContextMeter') || !verifyCleanStructure(postRestoreUtils)) {
              throw new Error('原位解构写回后校验失败：文件结构不合规或仍残留插件标记，中止并回滚。');
            }

            console.log('[Restore] 已通过原位解构精准移除插件挂载，并完整保留宿主现有修改与构建内容。');
            const hotDisposed = await tryHotDispose();
            info.restoredAt = new Date().toISOString();
            info.inPlaceCleaned = true;
            fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
            restoreCommitted = true;
            return { restored: targetFile, inPlaceCleaned: true, hotDisposed };
          } catch (err) {
            // 失败回滚机制：中途或后续校验失败时，立即从快照无损还原目标文件
            if (!restoreCommitted && fs.existsSync(snapshotFile)) {
              try {
                fs.copyFileSync(snapshotFile, targetFile);
                clearAsarCache(targetFile);
                console.error(`[Failure-Rollback] 原位卸载过程异常中断，已自动从改写前快照完整还原目标文件: ${targetFile}`);
              } catch (rollbackErr) {
                console.error(`[Fatal Rollback Error] 卸载快照回滚失败: ${rollbackErr.message}`);
              }
            }
            throw err;
          }
        } finally {
          try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
          try { fs.rmSync(packed, { force: true }); } catch {}
        }
      }
    }

    // 若未传 --force 且当前文件未检测到本插件补丁痕迹，拒绝覆盖还原以保护宿主
    if (!force && !hasMeterTraces) {
      throw new Error(
        `目标文件 (${targetFile}) 校验失败：文件内容已被宿主升级、第三方补丁或其他操作改变（当前哈希: ${currentInstalledSha.slice(0, 12)}...，预期补丁哈希: ${info.patchedSha256 ? info.patchedSha256.slice(0, 12) : 'null'}...），且无法证明原位解构安全，拒绝覆盖还原以保护宿主文件。\n` +
        `若确认需要强制以原版备份覆盖还原，请使用 --force 参数执行卸载。`
      );
    }

    // 6. 执行备份写回覆盖 (在 --force 或明确授权时)
    try {
      fs.copyFileSync(backup, targetFile);
      clearAsarCache(targetFile);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw new Error(`无法还原目标文件 (${targetFile})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
      }
      throw err;
    }

    if (sha(targetFile) !== expected) {
      throw new Error('Restored file checksum mismatch');
    }

    const hotDisposed = await tryHotDispose();
    try {
      info.restoredAt = new Date().toISOString();
      info.inPlaceCleaned = false;
      fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
    } catch {}
    return { restored: targetFile, fromBackup: backup, inPlaceCleaned: false, hotDisposed };
  } finally {
    fileLock.release();
  }
}

if (require.main === module) {
  restore()
    .then(() => console.log('Restored the exact pre-meter archive. Fully restart Antigravity for the change to take effect.'))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { restore, tryHotDispose };
