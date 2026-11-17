'use strict';
// Preserve Electron ASAR support in the host process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getStateDir, getAppDataDir, isIsolatedTestPath, builtinAsar, collectUnpackedPaths, loadAsarEngine } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient } = require('./local-api');
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

async function tryHotDispose(options = {}) {
  try {
    const appData = getAppDataDir(options);

    // 严格安全隔离门禁：若处于测试模式且未指定隔离目录或测试端口，严禁连接真实宿主机 AppData/DevTools 端口！
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.port && !options.appDataDir) {
      if (!isIsolatedTestPath(appData)) return false;
    }

    const cdp = await discoverAntigravityCdp(options);
    const targets = Array.isArray(cdp.pages) ? cdp.pages : [];
    for (const target of targets) {
      let cdpClient = null;
      try {
        cdpClient = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 3000 });
        await cdpClient.evaluate('window.__AGContextMeter?.dispose()', { timeoutMs: 3000 });
        await new Promise(r => setTimeout(r, 100));
      } catch {} finally {
        if (cdpClient) { try { cdpClient.close(); } catch {} }
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
  const previous = process.argv.includes('--previous') || Boolean(options.previous);
  const force = process.argv.includes('--force') || Boolean(options.force);
  const inPlaceExplicit = process.argv.includes('--in-place') || Boolean(options.inPlace);

  const stateManifest = path.join(getStateDir(), 'installation.json');
  const localManifest = path.join(__dirname, 'installation.json');
  const hasManifest = fs.existsSync(stateManifest) || fs.existsSync(localManifest);
  const manifestPath = fs.existsSync(stateManifest) ? stateManifest : localManifest;
  if (!hasManifest && (!customPath || previous || force)) {
    throw new Error('installation.json not found; nothing to restore.');
  }

  const info = hasManifest
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { installed: path.resolve(customPath) };
  const targetFile = customPath ? path.resolve(customPath) : (info.installed ? path.resolve(info.installed) : null);
  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error(`Target file not found: ${targetFile || info.installed}`);
  }

  // 1. 自定义 --path 严格检查目标归属，绝不使用一个目标的备份去恢复另一个目标
  const isSameTarget = Boolean(info.installed && path.resolve(info.installed) === path.resolve(targetFile));
  if (hasManifest && customPath && !isSameTarget && !inPlaceExplicit) {
    throw new Error(`指定的卸载目标 (${targetFile}) 与安装记录中的目标 (${info.installed}) 不一致，拒绝跨目标还原。`);
  }

  // 获取目标文件互斥锁，避免并发改写冲突
  const fileLock = acquireFileLock(targetFile);

  try {
    const currentInstalledSha = sha(targetFile);

    // 2. 先只读探测目标 ASAR 结构与宿主版本、插件痕迹，避免后续误判并保护不支持的结构
    let targetHostVer = null;
    let currentUtilsRaw = null;
    let currentPreloadRaw = null;
    let targetParseError = null;
    let targetValid = false;
    try {
      clearAsarCache(targetFile);
      const pkgRaw = JSON.parse(extractAsarFile(targetFile, 'package.json').toString('utf8'));
      targetHostVer = pkgRaw && typeof pkgRaw.version === 'string' ? pkgRaw.version : null;
      currentUtilsRaw = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
      try {
        currentPreloadRaw = extractAsarFile(targetFile, 'dist/preload.js').toString('utf8');
      } catch {
        currentPreloadRaw = '';
      }
      targetValid = Boolean(currentUtilsRaw && currentUtilsRaw.trim());
    } catch (e) {
      targetParseError = e?.message || '无效的 ASAR 结构或缺少 dist/utils.js';
      targetValid = false;
    }

    const hasMeterTraces = Boolean(
      targetValid && currentUtilsRaw && (
        currentUtilsRaw.includes('installContextMeter') ||
        currentUtilsRaw.includes(TAGS.METER_UTILS_START) ||
        currentUtilsRaw.includes(TAGS.PROXY_START)
      )
    );

    // 3. 检测并严格验证可用备份完整性：绝不使用已损坏或哈希不匹配的备份覆盖
    const backupCandidates = previous
      ? [{ path: info.previousInstalledBackup, expected: info.previousInstalledSha256 }]
      : [
          { path: info.previousInstalledBackup, expected: info.previousInstalledSha256 },
          { path: info.backup, expected: info.originalSha256 }
        ];

    let anyBackupFileExists = false;
    let validBackup = null;
    let validExpectedSha = null;
    for (const c of backupCandidates) {
      if (c.path && fs.existsSync(c.path)) {
        anyBackupFileExists = true;
        if (c.expected && sha(c.path) === c.expected) {
          validBackup = c.path;
          validExpectedSha = c.expected;
          break;
        }
      }
    }

    let backupHostVer = null;
    if (validBackup) {
      try {
        backupHostVer = JSON.parse(extractAsarFile(validBackup, 'package.json').toString('utf8')).version;
      } catch (e) {
        if (previous || !hasMeterTraces) {
          throw new Error(`解析备份 ASAR 版本失败: ${e.message}`);
        }
        // 备份文件本身内容已损坏时降级视作不可用备份，转交原位解构或校验拒绝分支处理
        validBackup = null;
        validExpectedSha = null;
      }
    }
    const versionMatches = Boolean(!backupHostVer || !targetHostVer || backupHostVer === targetHostVer);

    // 显式 --previous 还原必须具备完全匹配的合法备份与版本一致性
    if (previous) {
      if (!validBackup) {
        throw new Error('Backup checksum mismatch; refusing restore');
      }
      if (!versionMatches) {
        throw new Error(`目标文件 (${targetFile}) 校验失败：备份宿主版本 (v${backupHostVer}) 与当前目标宿主版本 (v${targetHostVer}) 不匹配，文件内容已被宿主升级、第三方补丁或其他操作改变，拒绝覆盖还原以保护宿主文件。`);
      }
    }

    // 4. 若有效备份匹配当前文件且哈希与期望一致：幂等返回
    if (validBackup && versionMatches && currentInstalledSha === validExpectedSha) {
      await tryHotDispose();
      return { restored: targetFile, fromBackup: validBackup, alreadyRestored: true };
    }

    // 5. 若非强制原位模式，且存在匹配的完整备份及精确匹配的补丁哈希，走标准无损整包覆盖还原
    if (!inPlaceExplicit && validBackup && versionMatches && currentInstalledSha === info.patchedSha256 && !force) {
      try {
        fs.copyFileSync(validBackup, targetFile);
        clearAsarCache(targetFile);
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          throw new Error(`无法还原目标文件 (${targetFile})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
        }
        throw err;
      }
      if (sha(targetFile) !== validExpectedSha) {
        throw new Error('Restored file checksum mismatch');
      }
      await tryHotDispose();
      if (hasManifest) {
        try {
          info.restoredAt = new Date().toISOString();
          fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
        } catch {}
      }
      return { restored: targetFile, fromBackup: validBackup };
    }

    // 若备份文件存在于磁盘但全部校验损坏（哈希不符），在未显式指定 --in-place 时拒绝盲目覆盖或跳过校验
    if (!validBackup && anyBackupFileExists && !inPlaceExplicit) {
      throw new Error('Backup checksum mismatch; refusing restore（检测到备份文件已损坏或哈希不符，若确认需安全剥离当前插件挂载且保留宿主改动，请追加 --in-place 执行原位卸载）');
    }

    // 6. 无法直接恢复宿主原包时（如备份缺失、宿主已升级、存在第三方修改或显式 --in-place），评估原位安全剥离方案
    const canTryInPlace = Boolean(
      !previous &&
      !force &&
      (inPlaceExplicit || !validBackup || !versionMatches || (validBackup && versionMatches && currentInstalledSha !== info.patchedSha256))
    );

    if (canTryInPlace) {
      if (!targetValid) {
        throw new Error(`无法卸载目标文件 (${targetFile})：不支持或损坏的文件结构 (${targetParseError || '缺少 dist/utils.js'})，已完整保留原文件现场。`);
      }
      if (!hasMeterTraces) {
        if (validBackup && !versionMatches) {
          throw new Error(
            `目标文件 (${targetFile}) 校验失败：备份宿主版本 (v${backupHostVer}) 与当前目标宿主版本 (v${targetHostVer}) 不匹配，文件内容已被宿主升级、第三方补丁或其他操作改变，拒绝覆盖还原以保护宿主文件。`
          );
        }
        if (!anyBackupFileExists && !validBackup) {
          throw new Error(`无法卸载目标文件 (${targetFile})：原版备份缺失且目标未检测到本插件挂载痕迹，无法安全还原，已保留原文件。`);
        }
      } else {
        const potentialCleanUtils = cleanUtilsSource(currentUtilsRaw);
        const potentialCleanPreload = currentPreloadRaw ? cleanPreloadSource(currentPreloadRaw) : '';
        const utilsSyntaxOk = validateSyntax(potentialCleanUtils, 'clean-restore-utils.js');
        const preloadSyntaxOk = !potentialCleanPreload || validateSyntax(potentialCleanPreload, 'clean-restore-preload.js');

        if (!verifyCleanStructure(potentialCleanUtils) || !utilsSyntaxOk || !preloadSyntaxOk) {
          throw new Error(`无法对目标文件 (${targetFile}) 执行原位卸载：剥离插件后的宿主核心结构或语法校验未通过，已完整保留原文件现场。`);
        }

        const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const staging = path.join(os.tmpdir(), `ag-restore-staging-${stamp}`);
        const packed = path.join(os.tmpdir(), `ag-restore-packed-${stamp}.asar`);
        try {
          fs.mkdirSync(staging, { recursive: true });
          clearAsarCache(targetFile);
          extractAllAsar(targetFile, staging);

          fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), potentialCleanUtils, 'utf8');
          if (currentPreloadRaw && fs.existsSync(path.join(staging, 'dist', 'preload.js'))) {
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
            'meter-enhance.js',
            'meter-accounts.js',
            'macos-binary-utils.js',
            'local-api.js',
            'attachment_scan.py',
            'meter-manifest.json'
          ];
          for (const f of additions) {
            const p = path.join(staging, 'dist', f);
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
          }
          try { fs.rmSync(path.join(staging, 'dist', 'i18n'), { recursive: true, force: true }); } catch {}

          const snapshotDir = path.join(getStateDir(), 'backups', 'snapshots');
          fs.mkdirSync(snapshotDir, { recursive: true });
          const snapshotFile = path.join(snapshotDir, `app-${targetHostVer || 'unknown'}-prerestore-${stamp}-${currentInstalledSha.slice(0, 8)}.asar`);
          fs.copyFileSync(targetFile, snapshotFile);

          const unpackedPaths = collectUnpackedPaths(asar, targetFile);
          if (unpackedPaths.size > 0) {
            await builtinAsar.createPackageWithOptions(staging, packed, { unpackedPaths });
          } else {
            await builtinAsar.createPackageWithOptions(staging, packed, {});
          }

          const tempReplacement = path.join(path.dirname(targetFile), `app.asar.restore_tmp_${stamp}`);
          fs.copyFileSync(packed, tempReplacement);

          let restoreCommitted = false;
          try {
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

            const postRestoreUtils = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
            if (postRestoreUtils.includes('installContextMeter') || !verifyCleanStructure(postRestoreUtils)) {
              throw new Error('原位解构写回后校验失败：文件结构不合规或仍残留插件标记，中止并回滚。');
            }

            console.log('[Restore] 已通过原位解构精准移除插件挂载，并完整保留宿主现有修改与构建内容。');
            const hotDisposed = await tryHotDispose();
            if (hasManifest) {
              info.restoredAt = new Date().toISOString();
              info.inPlaceCleaned = true;
              fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
            }
            restoreCommitted = true;
            return { restored: targetFile, inPlaceCleaned: true, hotDisposed };
          } catch (err) {
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
          try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
        }
      }
    }

    // 7. 强制整包覆写或前置条件仍未满足时的严谨拦截
    if (!validBackup) {
      throw new Error('Backup checksum mismatch; refusing restore');
    }
    if (!force && !versionMatches) {
      throw new Error(`目标文件 (${targetFile}) 校验失败：备份宿主版本 (v${backupHostVer}) 与当前目标宿主版本 (v${targetHostVer}) 不匹配，文件内容已被宿主升级、第三方补丁或其他操作改变，拒绝覆盖还原以保护宿主文件。`);
    }
    if (!force && !hasMeterTraces) {
      throw new Error(
        `目标文件 (${targetFile}) 校验失败：文件内容已被宿主升级、第三方补丁或其他操作改变（当前哈希: ${currentInstalledSha.slice(0, 12)}...，预期补丁哈希: ${info.patchedSha256 ? info.patchedSha256.slice(0, 12) : 'null'}...），且无法证明原位解构安全，拒绝覆盖还原以保护宿主文件。\n` +
        `若确认需要强制以原版备份覆盖还原，请使用 --force 参数执行卸载。`
      );
    }

    try {
      fs.copyFileSync(validBackup, targetFile);
      clearAsarCache(targetFile);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw new Error(`无法还原目标文件 (${targetFile})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
      }
      throw err;
    }

    if (sha(targetFile) !== validExpectedSha) {
      throw new Error('Restored file checksum mismatch');
    }

    const hotDisposed = await tryHotDispose();
    if (hasManifest) {
      try {
        info.restoredAt = new Date().toISOString();
        info.inPlaceCleaned = false;
        fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
      } catch {}
    }
    return { restored: targetFile, fromBackup: validBackup, inPlaceCleaned: false, hotDisposed };
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
