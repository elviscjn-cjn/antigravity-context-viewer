'use strict';
// Preserve Electron ASAR support in the host process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

const builtinAsar = {
  extractFile(archivePath, relPath) {
    const rawFs = getRawFs();
    const { header, baseOffset } = readHeader(archivePath);
    const node = getNode(header, relPath);
    if (node.unpacked) {
      let unpackedSrc = path.join(archivePath + '.unpacked', relPath);
      if (!rawFs.existsSync(unpackedSrc)) {
        try {
          const mainAsar = findAsarPath();
          const candidate = path.join(mainAsar + '.unpacked', relPath);
          if (rawFs.existsSync(candidate)) unpackedSrc = candidate;
        } catch {}
      }
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

  extractAll(archivePath, destDir) {
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
            let unpackedSrc = path.join(archivePath + '.unpacked', relPath);
            if (!rawFs.existsSync(unpackedSrc)) {
              try {
                const mainAsar = findAsarPath();
                const candidate = path.join(mainAsar + '.unpacked', relPath);
                if (rawFs.existsSync(candidate)) unpackedSrc = candidate;
              } catch {}
            }
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
 * 探测本机 Antigravity 宿主 app.asar 安装路径（纯路径定位，无安装副作用）
 */
function findAsarPath(customPath) {
  const rawFs = getRawFs();
  const explicitPath = customPath || (process.env.AG_ASAR_PATH ? String(process.env.AG_ASAR_PATH).trim() : '');
  if (explicitPath) {
    let resolved = path.resolve(explicitPath);
    if (rawFs.existsSync(resolved) && rawFs.statSync(resolved).isDirectory()) {
      const inMacBundle = path.join(resolved, 'Contents', 'Resources', 'app.asar');
      if (rawFs.existsSync(inMacBundle)) return inMacBundle;
      const inRes = path.join(resolved, 'resources', 'app.asar');
      if (rawFs.existsSync(inRes)) return inRes;
      const direct = path.join(resolved, 'app.asar');
      if (rawFs.existsSync(direct)) return direct;
    }
    if (rawFs.existsSync(resolved)) return resolved;
    throw new Error(`Could not find app.asar at specified path: ${explicitPath}`);
  }
  // 若在 Electron 宿主运行时内部被调用，优先定位宿主自身捆绑的 resources/app.asar 或 Contents/Resources/app.asar
  if (process.versions && process.versions.electron && process.execPath) {
    const execDir = path.dirname(process.execPath);
    const hostCandidates = [
      path.join(execDir, 'resources', 'app.asar'),
      path.join(execDir, '..', 'Resources', 'app.asar')
    ];
    for (const hostAsar of hostCandidates) {
      if (rawFs.existsSync(hostAsar)) return path.resolve(hostAsar);
    }
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
    if (rawFs.existsSync(p)) return p;
  }
  throw new Error('Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.');
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

module.exports = { loadAsarEngine, builtinAsar, collectUnpackedPaths, getRawFs, getStateDir, getAppDataDir, isIsolatedTestPath, findAsarPath };
