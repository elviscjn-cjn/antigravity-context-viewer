'use strict';
// Preserve Electron ASAR support in the host process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function getRawFs() {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    try {
      return require('original-fs');
    } catch {}
  }
  return fs;
}

function readHeader(archivePath) {
  const rawFs = getRawFs();
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    rawFs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    rawFs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, baseOffset: 16 + jsonSize + padding };
  } finally {
    rawFs.closeSync(fd);
  }
}

function getNode(header, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`File not found in ASAR: ${relPath}`);
    }
    cur = cur.files[part];
  }
  return cur;
}

function resolveUnpackedSource(archivePath, relPath, rawFs = getRawFs(), options = {}) {
  const direct = path.join(archivePath + '.unpacked', relPath);
  if (rawFs.existsSync(direct)) return direct;
  const siblingUnpacked = path.join(path.dirname(path.resolve(archivePath)), 'app.asar.unpacked', relPath);
  if (rawFs.existsSync(siblingUnpacked)) return siblingUnpacked;
  try {
    const fallbackHint = options?.fallbackAsarPath || options?.customPath || null;
    const mainAsar = findAsarPath(fallbackHint, options);
    const candidate = path.join(mainAsar + '.unpacked', relPath);
    if (rawFs.existsSync(candidate)) return candidate;
  } catch {}
  return direct;
}

const builtinAsar = {
  extractFile(archivePath, relPath, options = {}) {
    const rawFs = getRawFs();
    const { header, baseOffset } = readHeader(archivePath);
    const node = getNode(header, relPath);
    if (node.unpacked) {
      const unpackedSrc = resolveUnpackedSource(archivePath, relPath, rawFs, options);
      if (rawFs.existsSync(unpackedSrc)) {
        return rawFs.readFileSync(unpackedSrc);
      }
      return Buffer.alloc(node.size || 0);
    }
    const buf = Buffer.alloc(node.size);
    const fd = rawFs.openSync(archivePath, 'r');
    try {
      rawFs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
      return buf;
    } finally {
      rawFs.closeSync(fd);
    }
  },

  statFile(archivePath, relPath) {
    const { header } = readHeader(archivePath);
    return getNode(header, relPath);
  },

  listPackage(archivePath) {
    const { header } = readHeader(archivePath);
    const list = [];
    function walk(tree, prefix) {
      for (const [name, info] of Object.entries(tree.files || {})) {
        const cur = prefix + '/' + name;
        list.push(cur);
        if (info.files) walk(info, cur);
      }
    }
    walk(header, '');
    return list;
  },

  extractAll(archivePath, destDir, options = {}) {
    const rawFs = getRawFs();
    const { header, baseOffset } = readHeader(archivePath);
    const fd = rawFs.openSync(archivePath, 'r');
    try {
      function walk(tree, currentDir, relDir) {
        fs.mkdirSync(currentDir, { recursive: true });
        for (const [name, info] of Object.entries(tree.files || {})) {
          const targetPath = path.join(currentDir, name);
          const relPath = relDir ? path.join(relDir, name) : name;
          if (info.files) {
            walk(info, targetPath, relPath);
          } else if (info.unpacked) {
            const unpackedSrc = resolveUnpackedSource(archivePath, relPath, rawFs, options);
            if (rawFs.existsSync(unpackedSrc)) {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              rawFs.copyFileSync(unpackedSrc, targetPath);
            } else {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              fs.writeFileSync(targetPath, Buffer.alloc(0));
            }
          } else {
            const buf = Buffer.alloc(info.size);
            rawFs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
            fs.writeFileSync(targetPath, buf);
          }
        }
      }
      walk(header, destDir, '');
    } finally {
      rawFs.closeSync(fd);
    }
  },

  async createPackage(srcDir, destAsar) {
    return this.createPackageWithOptions(srcDir, destAsar, {});
  },

  async createPackageWithOptions(srcDir, destAsar, options = {}) {
    const rawFs = getRawFs();
    let offset = 0;
    const chunks = [];
    const unpackedSet = options.unpackedPaths instanceof Set ? options.unpackedPaths : null;
    const unpackMatcher = unpackedSet
      ? (relPosix => unpackedSet.has(relPosix))
      : (typeof options.unpackMatcher === 'function'
        ? options.unpackMatcher
        : (options.unpackDir ? (relPosix => relPosix.includes('chrome-devtools-mcp')) : () => false));

    function build(currentDir, relPosix) {
      const files = {};
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const childPosix = relPosix ? `${relPosix}/${entry.name}` : entry.name;
        const isUnpacked = unpackMatcher(childPosix);
        if (entry.isDirectory()) {
          const node = { files: build(fullPath, childPosix) };
          if (isUnpacked) node.unpacked = true;
          files[entry.name] = node;
        } else if (entry.isFile()) {
          const buf = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          const blockHashes = [];
          const blockSize = 4 * 1024 * 1024;
          for (let i = 0; i < buf.length; i += blockSize) {
            blockHashes.push(crypto.createHash('sha256').update(buf.subarray(i, i + blockSize)).digest('hex'));
          }
          if (blockHashes.length === 0) {
            blockHashes.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
          }
          const integrity = { algorithm: 'SHA256', hash, blockSize, blocks: blockHashes };
          if (isUnpacked) {
            const unpackedTarget = path.join(destAsar + '.unpacked', childPosix);
            fs.mkdirSync(path.dirname(unpackedTarget), { recursive: true });
            fs.copyFileSync(fullPath, unpackedTarget);
            files[entry.name] = { size: buf.length, unpacked: true, integrity };
          } else {
            files[entry.name] = { size: buf.length, offset: String(offset), integrity };
            offset += buf.length;
            chunks.push(buf);
          }
        }
      }
      return files;
    }

    const headerObj = { files: build(srcDir, '') };
    const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const jsonSize = jsonBuf.length;
    const padding = (4 - (jsonSize % 4)) % 4;
    const alignedSize = jsonSize + padding;
    const headerBuf = Buffer.alloc(16 + alignedSize);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(8 + alignedSize, 4);
    headerBuf.writeUInt32LE(4 + alignedSize, 8);
    headerBuf.writeUInt32LE(jsonSize, 12);
    jsonBuf.copy(headerBuf, 16);

    const fd = rawFs.openSync(destAsar, 'w');
    try {
      rawFs.writeSync(fd, headerBuf);
      for (const chunk of chunks) {
        rawFs.writeSync(fd, chunk);
      }
    } finally {
      rawFs.closeSync(fd);
    }
  }
};

function loadAsarEngine() {
  const home = os.homedir();
  const candidates = ['@electron/asar', 'asar'];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'node_modules', 'asar'),
      path.join(localAppData, 'AntigravityChinese', 'source', 'node_modules', '@electron', 'asar')
    );
  }
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  return builtinAsar;
}

function getAppDataDir(options = {}) {
  if (options && typeof options.appDataDir === 'string' && options.appDataDir.trim()) {
    return path.resolve(options.appDataDir.trim());
  }
  if (process.env.APPDATA) return process.env.APPDATA;
  const home = (options && options.homeDir) || os.homedir();
  const platform = (options && options.platform) || process.platform;
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function getStateDir() {
  if (process.env.AG_METER_STATE_DIR) {
    const customDir = path.resolve(process.env.AG_METER_STATE_DIR);
    fs.mkdirSync(customDir, { recursive: true });
    return customDir;
  }
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'));
  const dir = path.join(base, 'AntigravityContextMeter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 判断路径是否位于隔离的测试临时目录中（兼容 Windows Temp、Linux /tmp 与 macOS /private/var/folders 软链）
 */
function isIsolatedTestPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const candidates = [os.tmpdir()];
  try {
    candidates.push(fs.realpathSync(os.tmpdir()));
  } catch {}
  try {
    if (fs.existsSync(resolved)) {
      const realTarget = fs.realpathSync(resolved);
      for (const tmpBase of candidates) {
        if (tmpBase && realTarget.toLowerCase().startsWith(path.resolve(tmpBase).toLowerCase())) {
          return true;
        }
      }
    }
  } catch {}
  const lower = resolved.toLowerCase().replace(/\\/g, '/');
  for (const tmpBase of candidates) {
    if (tmpBase && lower.startsWith(path.resolve(tmpBase).toLowerCase().replace(/\\/g, '/'))) {
      return true;
    }
  }
  return (
    lower.startsWith('/tmp/') ||
    lower.startsWith('/private/tmp/') ||
    lower.startsWith('/var/folders/') ||
    lower.startsWith('/private/var/folders/')
  );
}

/**
 * 规范化 ASAR 路径用于多目标比较（Windows 不区分大小写，保留原始 resolve 路径用于稳定 targetKey 哈希）
 */
function normalizeTargetPathForCompare(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 计算与既有备份命名一致的 8 位目标哈希（保持与 app-<ver>-<key>-base.asar 兼容）
 */
function computeAsarTargetKey(asarPath) {
  if (!asarPath || typeof asarPath !== 'string') return 'default';
  return crypto.createHash('sha256').update(path.resolve(asarPath)).digest('hex').slice(0, 8);
}

/**
 * 将用户传入或系统探测到的安装目录、可执行文件或 app.asar 路径规范化为真实存在的 app.asar 文件路径（严格模式，找不到返回 null）
 */
function normalizeAsarPathCandidate(inputPath, rawFs = getRawFs()) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const cleaned = inputPath
    .trim()
    .replace(/,\s*-?\d+$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return null;
  const resolved = path.resolve(cleaned);
  try {
    if (!rawFs.existsSync(resolved)) return null;
    const st = rawFs.statSync(resolved);
    if (st.isDirectory()) {
      const dirCandidates = [
        path.join(resolved, 'Contents', 'Resources', 'app.asar'),
        path.join(resolved, 'resources', 'app.asar'),
        path.join(resolved, 'Resources', 'app.asar'),
        path.join(resolved, 'app.asar')
      ];
      for (const p of dirCandidates) {
        if (rawFs.existsSync(p) && !rawFs.statSync(p).isDirectory()) return path.resolve(p);
      }
      return null;
    }
    if (resolved.toLowerCase().endsWith('.asar')) {
      return resolved;
    }
    const exeDir = path.dirname(resolved);
    const exeCandidates = [
      path.join(exeDir, 'resources', 'app.asar'),
      path.join(exeDir, '..', 'Resources', 'app.asar'),
      path.join(exeDir, 'app.asar')
    ];
    for (const p of exeCandidates) {
      if (rawFs.existsSync(p) && !rawFs.statSync(p).isDirectory()) return path.resolve(p);
    }
  } catch {}
  return null;
}

/**
 * 将候选路径（文件、可执行程序或目录）解析为具体的 app.asar 文件路径
 */
function resolveAsarFromPathOrDir(rawPath, rawFs = getRawFs()) {
  if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const strict = normalizeAsarPathCandidate(rawPath, rawFs);
  if (strict) return strict;
  const cleaned = rawPath
    .trim()
    .replace(/,\s*-?\d+$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return null;
  const resolved = path.resolve(cleaned);
  try {
    if (!rawFs.existsSync(resolved)) return null;
    const st = rawFs.statSync(resolved);
    if (st.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * 推导宿主安装目录与 resources 目录（供 language_server / agy / CLI 同步复用自定义安装路径）
 */
function deriveHostResourcesDirFromAsar(asarPath) {
  if (!asarPath || typeof asarPath !== 'string' || !asarPath.trim()) return null;
  const resolved = path.resolve(asarPath.trim());
  const resourcesDir = path.dirname(resolved);
  const installDir = path.basename(resourcesDir).toLowerCase() === 'resources'
    ? path.dirname(resourcesDir)
    : resourcesDir;
  return { asarPath: resolved, resourcesDir, installDir };
}

/**
 * 校验用户填写的自定义 Antigravity 安装路径或 app.asar 路径是否合法可读
 */
function inspectCustomAsarPath(rawPath, options = {}) {
  const rawFs = getRawFs();
  const input = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!input) {
    return { ok: false, asarPath: null, installDir: null, hostVersion: null, error: '路径不能为空' };
  }
  const resolvedAsar = resolveAsarFromPathOrDir(input, rawFs);
  if (!resolvedAsar || !rawFs.existsSync(resolvedAsar)) {
    return {
      ok: false,
      asarPath: null,
      installDir: null,
      hostVersion: null,
      error: `未在指定位置找到可用的 app.asar: ${input}`
    };
  }
  try {
    const st = rawFs.statSync(resolvedAsar);
    if (!st.isFile()) {
      return { ok: false, asarPath: null, installDir: null, hostVersion: null, error: `目标不是有效文件: ${resolvedAsar}` };
    }
  } catch (e) {
    return { ok: false, asarPath: null, installDir: null, hostVersion: null, error: e?.message || '无法读取目标文件' };
  }
  let hostVersion = null;
  try {
    const pkgBuf = builtinAsar.extractFile(resolvedAsar, 'package.json', { customPath: resolvedAsar });
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    hostVersion = typeof pkg?.version === 'string' ? pkg.version : null;
    builtinAsar.statFile(resolvedAsar, 'dist/utils.js');
  } catch (e) {
    return {
      ok: false,
      asarPath: resolvedAsar,
      installDir: deriveHostResourcesDirFromAsar(resolvedAsar)?.installDir || null,
      hostVersion: null,
      error: `指定路径不是有效的 Antigravity 宿主 app.asar: ${e?.message || '缺少 dist/utils.js'}`
    };
  }
  const derived = deriveHostResourcesDirFromAsar(resolvedAsar);
  return {
    ok: true,
    asarPath: resolvedAsar,
    resourcesDir: derived?.resourcesDir || null,
    installDir: derived?.installDir || null,
    hostVersion,
    error: null
  };
}

/**
 * 读取 modules.json 中保存的用户自定义 Antigravity 安装路径（Issue #109 / #116 / #113）
 */
function getConfiguredCustomAsarPath(options = {}) {
  const rawFs = getRawFs();
  const stateDir = options.stateDir
    ? path.resolve(String(options.stateDir))
    : (() => { try { return getStateDir(); } catch { return null; } })();
  if (!stateDir) return null;
  try {
    const modPath = path.join(stateDir, 'modules.json');
    if (!rawFs.existsSync(modPath)) return null;
    const modCfg = JSON.parse(rawFs.readFileSync(modPath, 'utf8'));
    const custom = modCfg?.modules?.hostInstall?.customPath;
    if (typeof custom === 'string' && custom.trim()) {
      return path.resolve(custom.trim());
    }
  } catch {}
  return null;
}

/**
 * 持久化保存或清除自定义 Antigravity 安装路径（写入 modules.json 的 modules.hostInstall.customPath）
 */
function saveConfiguredCustomAsarPath(rawPath, options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  if (
    process.env.AG_METER_TEST_MODE === '1' &&
    options.allowNonIsolatedInTest !== true &&
    !isIsolatedTestPath(stateDir)
  ) {
    throw new Error(`测试模式禁止写入非隔离配置目录: ${stateDir}`);
  }
  const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!trimmed) {
    const cfg = loadModulesConfig({ stateDir, allowLegacyMigration: false });
    cfg.modules.hostInstall = { customPath: null, lastUpdated: new Date().toISOString() };
    saveModulesConfig(cfg, { stateDir });
    return { ok: true, cleared: true, customPath: null, asarPath: null, hostVersion: null };
  }
  const check = inspectCustomAsarPath(trimmed, options);
  if (!check.ok) {
    return check;
  }
  const cfg = loadModulesConfig({ stateDir, allowLegacyMigration: false });
  cfg.modules.hostInstall = {
    customPath: check.asarPath,
    lastUpdated: new Date().toISOString()
  };
  saveModulesConfig(cfg, { stateDir });
  return {
    ok: true,
    cleared: false,
    customPath: check.asarPath,
    asarPath: check.asarPath,
    installDir: check.installDir,
    resourcesDir: check.resourcesDir,
    hostVersion: check.hostVersion
  };
}

function clearConfiguredCustomAsarPath(options = {}) {
  return saveConfiguredCustomAsarPath('', options);
}

/**
 * 只读读取持久化配置中保存的自定义 Antigravity 安装路径（兼容 modules.json 与 custom_plan_v1.json，PR #137）
 */
function getSavedCustomAsarPath(options = {}) {
  const rawFs = getRawFs();
  try {
    const fromModules = getConfiguredCustomAsarPath(options);
    if (fromModules) {
      const norm = normalizeAsarPathCandidate(fromModules, rawFs);
      if (norm) return norm;
    }
  } catch {}
  try {
    const home = options.homeDir || process.env.USERPROFILE || os.homedir();
    const agDir = options.agDir
      || (process.env.AG_DIR ? path.resolve(process.env.AG_DIR) : path.join(home, '.gemini', 'antigravity'));
    const cfgPath = agDir.endsWith('.json') ? agDir : path.join(agDir, 'custom_plan_v1.json');
    if (!rawFs.existsSync(cfgPath)) return null;
    const raw = JSON.parse(rawFs.readFileSync(cfgPath, 'utf8'));
    const saved = raw?.uiPreferences?.customInstallPath || raw?.customInstallPath || '';
    if (typeof saved !== 'string' || !saved.trim()) return null;
    return normalizeAsarPathCandidate(saved, rawFs);
  } catch {}
  return null;
}

/**
 * 兜底探测运行中的 Antigravity 进程路径、Windows 卸载注册表、macOS ps 或 Linux which 入口（PR #137）
 */
function probeInstalledAsarPaths(options = {}) {
  const rawFs = getRawFs();
  const platform = options.platform || process.platform;
  if (typeof options._probeSystemPaths === 'function') {
    try {
      const probed = options._probeSystemPaths(platform);
      const list = Array.isArray(probed) ? probed : (probed ? [probed] : []);
      for (const item of list) {
        const norm = normalizeAsarPathCandidate(item, rawFs);
        if (norm) return norm;
      }
    } catch {}
    return null;
  }
  if (
    options.disableSystemProbe === true ||
    process.env.AG_METER_DISABLE_SYSTEM_PROBE === '1' ||
    process.env.AG_METER_TEST_MODE === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT
  ) {
    return null;
  }
  const candidates = [];
  try {
    if (platform === 'win32') {
      const psScript = [
        "$p = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique);",
        "$r = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } | Where-Object { $_.DisplayName -like '*Antigravity*' } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon };",
        "@($p + $r) | Where-Object { $_ } | Select-Object -Unique"
      ].join(' ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        timeout: 2500,
        encoding: 'utf8',
        windowsHide: true
      });
      for (const line of String(out || '').split(/\r?\n/)) {
        if (line.trim()) candidates.push(line.trim());
      }
    } else if (platform === 'darwin') {
      const out = execFileSync('ps', ['-axo', 'comm='], { timeout: 2000, encoding: 'utf8' });
      for (const line of String(out || '').split(/\r?\n/)) {
        if (/antigravity(?:\s+ide)?\.app\/contents\/macos\//i.test(line)) {
          candidates.push(line.trim());
        }
      }
    } else {
      const out = execFileSync('which', ['antigravity'], { timeout: 2000, encoding: 'utf8' });
      for (const line of String(out || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        candidates.push(trimmed);
        try { candidates.push(rawFs.realpathSync(trimmed)); } catch {}
      }
    }
  } catch {}
  for (const item of candidates) {
    const norm = normalizeAsarPathCandidate(item, rawFs);
    if (norm) return norm;
  }
  return null;
}

/**
 * Windows 运行中 Antigravity.exe 进程与桌面/开始菜单快捷方式兜底探测（仅在非隔离测试或注入钩子时执行）
 */
function probeWindowsFallbackAsarCandidates(options = {}) {
  const results = [];
  const seen = new Set();
  const push = (p, source) => {
    if (!p || typeof p !== 'string' || !p.trim()) return;
    const resolved = path.resolve(p.trim());
    const cmp = resolved.toLowerCase();
    if (seen.has(cmp)) return;
    seen.add(cmp);
    results.push({ path: resolved, source });
  };
  if (typeof options._detectRunningHostExe === 'function') {
    try {
      const list = options._detectRunningHostExe() || [];
      for (const exe of Array.isArray(list) ? list : [list]) {
        if (exe) push(exe, 'windows_running_process');
      }
    } catch {}
  }
  if (typeof options._detectShortcutTargets === 'function') {
    try {
      const list = options._detectShortcutTargets() || [];
      for (const sc of Array.isArray(list) ? list : [list]) {
        if (sc) push(sc, 'windows_shortcut');
      }
    } catch {}
  }
  const isTestEnv = Boolean(
    process.env.AG_METER_TEST_MODE === '1'
    || process.env.NODE_TEST_CONTEXT
    || options.disableSystemProbe === true
    || options.homeDir
    || options.localAppData
    || options.programFiles
  );
  if (isTestEnv || (options.platform || process.platform) !== 'win32') {
    return results;
  }
  try {
    const { execFileSync } = require('child_process');
    const psCmd = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$paths = @()",
      "Get-Process -Name 'Antigravity','antigravity' | ForEach-Object { if ($_.Path) { $paths += ('PROC|' + $_.Path) } }",
      "$lnkDirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))",
      "$ws = New-Object -ComObject WScript.Shell",
      "foreach ($d in $lnkDirs) { if ($d -and (Test-Path $d)) { Get-ChildItem -Path $d -Filter '*Antigravity*.lnk' -Recurse -Depth 3 | ForEach-Object { $t = $ws.CreateShortcut($_.FullName).TargetPath; if ($t) { $paths += ('LNK|' + $t) } } } }",
      "$paths -join \"`n\""
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      encoding: 'utf8',
      timeout: 2200,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of String(out || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('PROC|')) push(trimmed.slice(5), 'windows_running_process');
      else if (trimmed.startsWith('LNK|')) push(trimmed.slice(4), 'windows_shortcut');
    }
  } catch {}
  return results;
}

/**
 * 从配置与安装记录（modules.json / installation.json）读取此前确认的目标路径，供非默认盘 / 自定义路径自动定位（Issue #109 / #116 / #113）
 */
function readRecordedAsarTargets(options = {}) {
  const rawFs = getRawFs();
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : null;
  if (!stateDir) return [];
  const manifestPath = path.join(stateDir, 'installation.json');
  const results = [];
  const seen = new Set();
  const pushTarget = (p, meta = {}) => {
    if (!p || typeof p !== 'string' || !p.trim()) return;
    const resolved = path.resolve(p.trim());
    const cmp = normalizeTargetPathForCompare(resolved);
    if (seen.has(cmp)) return;
    seen.add(cmp);
    results.push({ asarPath: resolved, ...meta });
  };
  // 最高优先级：用户在设置页或配置中显式保存的自定义安装路径
  try {
    const modPath = path.join(stateDir, 'modules.json');
    if (rawFs.existsSync(modPath)) {
      const modCfg = JSON.parse(rawFs.readFileSync(modPath, 'utf8'));
      const customInstallPath = modCfg?.modules?.hostInstall?.customPath;
      if (customInstallPath) {
        pushTarget(customInstallPath, { source: 'configured_custom_path', version: null });
      }
    }
  } catch {}
  try {
    if (rawFs.existsSync(manifestPath)) {
      const parsed = JSON.parse(rawFs.readFileSync(manifestPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.installed) {
          pushTarget(parsed.installed, { source: 'recorded_manifest', version: parsed.version || null });
        }
        if (parsed.targets && typeof parsed.targets === 'object') {
          const entries = Object.values(parsed.targets)
            .filter(t => t && typeof t === 'object' && t.installed)
            .sort((a, b) => Date.parse(b.updatedAt || b.installedAt || 0) - Date.parse(a.updatedAt || a.installedAt || 0));
          for (const entry of entries) {
            pushTarget(entry.installed, { source: 'recorded_manifest_target', version: entry.version || null });
          }
        }
      }
    }
  } catch {}
  try {
    const modPath = path.join(stateDir, 'modules.json');
    if (rawFs.existsSync(modPath)) {
      const modCfg = JSON.parse(rawFs.readFileSync(modPath, 'utf8'));
      const guardTarget = modCfg?.modules?.hostGuard?.targetPath;
      if (guardTarget) {
        pushTarget(guardTarget, { source: 'recorded_guard_config', version: null });
      }
    }
  } catch {}
  return results;
}

/**
 * 统一宿主 app.asar 目标解析器（status / check / recover / watch / install / host-guard 共用）
 * 规则：
 * 1. 显式传入 customPath 或环境变量 AG_ASAR_PATH 时严格按指定路径解析，不存在直接报错，绝不静默回退误命中其他盘；
 * 2. 在 Electron 宿主进程内优先定位自身可执行文件旁 resources/app.asar；
 * 3. 若提供了 stateDir 且非禁用记录，优先命中历史记录中的非默认盘/自定义路径，若已迁移则标记 recordedTargetMissing；
 * 4. 最后按平台默认候选与可选 extraCandidates 顺序探测。
 */
function resolveAsarTarget(customPath = null, options = {}) {
  const rawFs = getRawFs();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const candidatesChecked = [];

  const explicitArg = (typeof customPath === 'string' && customPath.trim()) ? customPath.trim() : '';
  if (explicitArg) {
    candidatesChecked.push({ path: path.resolve(explicitArg), source: 'explicit_path' });
    const hit = resolveAsarFromPathOrDir(explicitArg, rawFs);
    if (hit) {
      return {
        ok: true,
        asarPath: hit,
        source: 'explicit_path',
        targetKey: computeAsarTargetKey(hit),
        recordedTargetMissing: false,
        recordedTargetPath: null,
        candidatesChecked,
        error: null
      };
    }
    return {
      ok: false,
      asarPath: null,
      source: 'explicit_path',
      targetKey: computeAsarTargetKey(path.resolve(explicitArg)),
      recordedTargetMissing: false,
      recordedTargetPath: null,
      candidatesChecked,
      error: `Could not find app.asar at specified path: ${explicitArg}`
    };
  }

  const envExplicit = env && typeof env.AG_ASAR_PATH === 'string' ? env.AG_ASAR_PATH.trim() : '';
  if (envExplicit) {
    candidatesChecked.push({ path: path.resolve(envExplicit), source: 'env_ag_asar_path' });
    const hit = resolveAsarFromPathOrDir(envExplicit, rawFs);
    if (hit) {
      return {
        ok: true,
        asarPath: hit,
        source: 'env_ag_asar_path',
        targetKey: computeAsarTargetKey(hit),
        recordedTargetMissing: false,
        recordedTargetPath: null,
        candidatesChecked,
        error: null
      };
    }
    return {
      ok: false,
      asarPath: null,
      source: 'env_ag_asar_path',
      targetKey: computeAsarTargetKey(path.resolve(envExplicit)),
      recordedTargetMissing: false,
      recordedTargetPath: null,
      candidatesChecked,
      error: `Could not find app.asar at specified path: ${envExplicit}`
    };
  }

  const effectiveStateDir = options.stateDir
    ? path.resolve(String(options.stateDir))
    : (options.useRecordedManifest === false ? null : (() => {
      try { return getStateDir(); } catch { return null; }
    })());

  let recordedTargetMissing = false;
  let recordedTargetPath = null;
  const recordedList = (options.useRecordedManifest !== false && effectiveStateDir)
    ? readRecordedAsarTargets({ stateDir: effectiveStateDir })
    : [];

  // 优先级 3：用户在设置中明确保存的自定义安装路径优先于默认或进程推断
  const configuredEntry = recordedList.find(item => item.source === 'configured_custom_path');
  if (configuredEntry) {
    candidatesChecked.push({ path: configuredEntry.asarPath, source: 'configured_custom_path' });
    const hit = resolveAsarFromPathOrDir(configuredEntry.asarPath, rawFs);
    if (hit) {
      return {
        ok: true,
        asarPath: hit,
        source: 'configured_custom_path',
        targetKey: computeAsarTargetKey(hit),
        recordedTargetMissing: false,
        recordedTargetPath: configuredEntry.asarPath,
        candidatesChecked,
        error: null
      };
    }
    recordedTargetMissing = true;
    recordedTargetPath = configuredEntry.asarPath;
  }

  // 兼容 PR #137：读取 custom_plan_v1.json 中保存的 customInstallPath
  if (options.useRecordedManifest !== false && (options.agDir || !options.stateDir)) {
    const legacyCustomAsar = getSavedCustomAsarPath({
      stateDir: effectiveStateDir,
      homeDir: options.homeDir,
      agDir: options.agDir
    });
    if (legacyCustomAsar) {
      candidatesChecked.push({ path: legacyCustomAsar, source: 'saved_custom_install_path' });
      return {
        ok: true,
        asarPath: legacyCustomAsar,
        source: 'saved_custom_install_path',
        targetKey: computeAsarTargetKey(legacyCustomAsar),
        recordedTargetMissing: false,
        recordedTargetPath: legacyCustomAsar,
        candidatesChecked,
        error: null
      };
    }
  }

  // 若在 Electron 宿主运行时内部被调用，优先定位宿主自身捆绑的 resources/app.asar 或 Contents/Resources/app.asar
  if (options.useElectronSelf !== false && process.versions && process.versions.electron && process.execPath) {
    const execDir = path.dirname(process.execPath);
    const hostCandidates = [
      path.join(execDir, 'resources', 'app.asar'),
      path.join(execDir, '..', 'Resources', 'app.asar')
    ];
    for (const hostAsar of hostCandidates) {
      candidatesChecked.push({ path: path.resolve(hostAsar), source: 'electron_host_self' });
      if (rawFs.existsSync(hostAsar)) {
        const resolved = path.resolve(hostAsar);
        return {
          ok: true,
          asarPath: resolved,
          source: 'electron_host_self',
          targetKey: computeAsarTargetKey(resolved),
          recordedTargetMissing,
          recordedTargetPath,
          candidatesChecked,
          error: null
        };
      }
    }
  }

  if (recordedList.length > 0) {
    for (const rec of recordedList) {
      if (rec.source === 'configured_custom_path') continue;
      candidatesChecked.push({ path: rec.asarPath, source: rec.source });
      const hit = resolveAsarFromPathOrDir(rec.asarPath, rawFs);
      if (hit) {
        return {
          ok: true,
          asarPath: hit,
          source: rec.source,
          targetKey: computeAsarTargetKey(hit),
          recordedTargetMissing: false,
          recordedTargetPath: rec.asarPath,
          candidatesChecked,
          error: null
        };
      }
      if (!recordedTargetMissing) {
        recordedTargetMissing = true;
        recordedTargetPath = rec.asarPath;
      }
    }
  }

  const extraCandidates = Array.isArray(options.extraCandidates) ? options.extraCandidates : [];
  for (const extra of extraCandidates) {
    if (!extra) continue;
    candidatesChecked.push({ path: path.resolve(String(extra)), source: 'extra_candidate' });
    const hit = resolveAsarFromPathOrDir(String(extra), rawFs);
    if (hit) {
      return {
        ok: true,
        asarPath: hit,
        source: recordedTargetMissing ? 'migrated_candidate' : 'extra_candidate',
        targetKey: computeAsarTargetKey(hit),
        recordedTargetMissing,
        recordedTargetPath,
        candidatesChecked,
        error: null
      };
    }
  }

  // Windows 兜底探测：运行中进程路径与桌面/开始菜单快捷方式目标
  if (platform === 'win32') {
    const winFallbacks = probeWindowsFallbackAsarCandidates({ ...options, platform });
    for (const fb of winFallbacks) {
      candidatesChecked.push({ path: fb.path, source: fb.source });
      const hit = resolveAsarFromPathOrDir(fb.path, rawFs);
      if (hit) {
        return {
          ok: true,
          asarPath: hit,
          source: fb.source,
          targetKey: computeAsarTargetKey(hit),
          recordedTargetMissing,
          recordedTargetPath,
          candidatesChecked,
          error: null
        };
      }
    }
  }

  const home = options.homeDir || os.homedir();
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = options.localAppData || env?.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = options.programFiles || env?.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(home, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Antigravity IDE.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Google Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Google Antigravity.app', 'Contents', 'Resources', 'app.asar')
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
    candidatesChecked.push({ path: path.resolve(p), source: 'default_candidates' });
    if (rawFs.existsSync(p)) {
      const resolved = path.resolve(p);
      return {
        ok: true,
        asarPath: resolved,
        source: recordedTargetMissing ? 'migrated_default_candidate' : 'default_candidates',
        targetKey: computeAsarTargetKey(resolved),
        recordedTargetMissing,
        recordedTargetPath,
        candidatesChecked,
        error: null
      };
    }
  }
  // PR #137 兜底：跨平台系统进程 / Windows 卸载注册表 / macOS ps / Linux which 探测
  const systemProbed = probeInstalledAsarPaths({ ...options, platform });
  if (systemProbed) {
    candidatesChecked.push({ path: systemProbed, source: 'system_probe' });
    return {
      ok: true,
      asarPath: systemProbed,
      source: 'system_probe',
      targetKey: computeAsarTargetKey(systemProbed),
      recordedTargetMissing,
      recordedTargetPath,
      candidatesChecked,
      error: null
    };
  }
  return {
    ok: false,
    asarPath: null,
    source: 'not_found',
    targetKey: null,
    recordedTargetMissing,
    recordedTargetPath,
    candidatesChecked,
    error: 'Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.'
  };
}

/**
 * 探测本机 Antigravity 宿主 app.asar 安装路径（纯路径定位，无安装副作用）
 */
function findAsarPath(customPath, options = {}) {
  const res = resolveAsarTarget(customPath, options);
  if (res.ok && res.asarPath) return res.asarPath;
  throw new Error(res.error || 'Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.');
}

/**
 * 从源 ASAR 归档收集所有带有 unpacked 标记的 POSIX 相对路径集合，供重打包精确复刻
 */
function collectUnpackedPaths(asarLib, archivePath) {
  const unpacked = new Set();
  if (!asarLib || typeof asarLib.listPackage !== 'function') return unpacked;
  try {
    const entries = asarLib.listPackage(archivePath);
    for (const file of entries) {
      const relWin = file.startsWith('/') || file.startsWith('\\') ? file.slice(1) : file;
      const stat = asarLib.statFile(archivePath, relWin);
      if (stat && stat.unpacked) {
        unpacked.add(relWin.replace(/\\/g, '/'));
      }
    }
  } catch {}
  return unpacked;
}

module.exports = {
  loadAsarEngine,
  builtinAsar,
  collectUnpackedPaths,
  getRawFs,
  getStateDir,
  getAppDataDir,
  isIsolatedTestPath,
  normalizeTargetPathForCompare,
  computeAsarTargetKey,
  resolveUnpackedSource,
  normalizeAsarPathCandidate,
  resolveAsarFromPathOrDir,
  deriveHostResourcesDirFromAsar,
  inspectCustomAsarPath,
  getConfiguredCustomAsarPath,
  getSavedCustomAsarPath,
  saveConfiguredCustomAsarPath,
  clearConfiguredCustomAsarPath,
  probeInstalledAsarPaths,
  probeWindowsFallbackAsarCandidates,
  resolveAsarTarget,
  findAsarPath
};
