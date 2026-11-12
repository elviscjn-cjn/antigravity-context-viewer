'use strict';
// Preserve Electron ASAR support in the host process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    fs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, baseOffset: 16 + jsonSize + padding };
  } finally {
    fs.closeSync(fd);
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
    const { header, baseOffset } = readHeader(archivePath);
    const node = getNode(header, relPath);
    if (node.unpacked) {
      return fs.readFileSync(path.join(archivePath + '.unpacked', relPath));
    }
    const buf = Buffer.alloc(node.size);
    const fd = fs.openSync(archivePath, 'r');
    try {
      fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
      return buf;
    } finally {
      fs.closeSync(fd);
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
    const { header, baseOffset } = readHeader(archivePath);
    const fd = fs.openSync(archivePath, 'r');
    try {
      function walk(tree, currentDir, relDir) {
        fs.mkdirSync(currentDir, { recursive: true });
        for (const [name, info] of Object.entries(tree.files || {})) {
          const targetPath = path.join(currentDir, name);
          const relPath = relDir ? path.join(relDir, name) : name;
          if (info.files) {
            walk(info, targetPath, relPath);
          } else if (info.unpacked) {
            const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
            if (fs.existsSync(unpackedSrc)) {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              fs.copyFileSync(unpackedSrc, targetPath);
            }
          } else {
            const buf = Buffer.alloc(info.size);
            fs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
            fs.writeFileSync(targetPath, buf);
          }
        }
      }
      walk(header, destDir, '');
    } finally {
      fs.closeSync(fd);
    }
  },

  async createPackageWithOptions(srcDir, destAsar, options = {}) {
    let offset = 0;
    const chunks = [];
    const unpackMatcher = options.unpackDir ? (relPosix => relPosix.includes('chrome-devtools-mcp')) : () => false;

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

    const fd = fs.openSync(destAsar, 'w');
    try {
      fs.writeSync(fd, headerBuf);
      for (const chunk of chunks) {
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
};

function loadAsarEngine() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [
    '@electron/asar',
    'asar',
    path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'node_modules', 'asar'),
    path.join(localAppData, 'AntigravityChinese', 'source', 'node_modules', '@electron', 'asar')
  ];
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  return builtinAsar;
}

function getStateDir() {
  if (process.env.AG_METER_STATE_DIR) return process.env.AG_METER_STATE_DIR;
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
 * 探测本机 Antigravity 宿主 app.asar 安装路径（纯路径定位，无安装副作用）
 */
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
  // 若在 Electron 宿主运行时内部被调用，优先定位宿主自身捆绑的 resources/app.asar
  if (process.versions && process.versions.electron && process.execPath) {
    const hostAsar = path.join(path.dirname(process.execPath), 'resources', 'app.asar');
    if (fs.existsSync(hostAsar)) return hostAsar;
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

module.exports = { loadAsarEngine, builtinAsar, getStateDir, findAsarPath };
