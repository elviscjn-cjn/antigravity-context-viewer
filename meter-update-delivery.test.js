'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const {
  filterReleases,
  findReleaseAsset,
  compareVersions
} = require('./meter-core');

const {
  checkUpdateAsync,
  applyUpdateAsync
} = require('./meter-collector');

const {
  loadAsarEngine
} = require('./asar-engine');

/**
 * 极简 zip 打包助手（纯 Node.js，无需外部依赖）
 */
function createSimpleZipBuffer(fileMap) {
  // 使用最简 ZIP 格式或简易存档
  // 使用 Node.js 的 adm-zip 或 zip 打包
  // 这里用简易标准 zipfile 格式组装
  const entries = [];
  let offset = 0;
  const localHeaders = [];

  for (const [name, content] of Object.entries(fileMap)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crypto.createHash('sha256').update(data).digest(); // dummy crc or calculate crc32

    // Simple CRC32
    let crc32 = 0 ^ (-1);
    for (let i = 0; i < data.length; i++) {
      crc32 = (crc32 >>> 8) ^ table[(crc32 ^ data[i]) & 0xff];
    }
    crc32 = (crc32 ^ (-1)) >>> 0;

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lh.writeUInt16LE(20, 4); // Version needed
    lh.writeUInt16LE(0, 6); // General purpose flag
    lh.writeUInt16LE(0, 8); // Compression method (0 = stored)
    lh.writeUInt16LE(0, 10); // Time
    lh.writeUInt16LE(0, 12); // Date
    lh.writeUInt32LE(crc32, 14); // CRC32
    lh.writeUInt32LE(data.length, 18); // Compressed size
    lh.writeUInt32LE(data.length, 22); // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, data);
    entries.push({ name: nameBuf, crc32, size: data.length, offset });
    offset += lh.length + data.length;
  }

  const cdHeaders = [];
  let cdOffset = offset;
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.name.length);
    cd.writeUInt32LE(0x02014b50, 0); // Central directory header
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(e.crc32, 16);
    cd.writeUInt32LE(e.size, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(e.offset, 42);
    e.name.copy(cd, 46);
    cdHeaders.push(cd);
  }

  const cdSize = cdHeaders.reduce((sum, h) => sum + h.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

// CRC32 table
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  table[i] = c >>> 0;
}

function writeStreamAsync(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(chunk);
  });
}

test('交付验证 1: 发布包内容检查（确保包含解锁引擎与所有必要资源）', () => {
  const root = path.resolve(__dirname);
  const commonFiles = [
    'cli.js',
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
    'package.json'
  ];

  for (const rel of commonFiles) {
    const full = path.join(root, rel);
    assert.ok(fs.existsSync(full), `发布必备文件必须存在: ${rel}`);
    assert.ok(fs.statSync(full).size > 0, `文件体积不能为 0: ${rel}`);
  }

  // 验证 install.js 的 additions 中包含 meter-context-unlock.js
  const installSrc = fs.readFileSync(path.join(root, 'install.js'), 'utf8');
  assert.ok(installSrc.includes("'meter-context-unlock.js'"), 'install.js 的 additions 必须包含 meter-context-unlock.js');
  assert.ok(installSrc.includes('getContextUnlockStatus'), 'install.js 的 preload 必须暴露 getContextUnlockStatus');
  assert.ok(installSrc.includes('applyContextUnlock'), 'install.js 的 preload 必须暴露 applyContextUnlock');
  assert.ok(installSrc.includes('restoreContextUnlock'), 'install.js 的 preload 必须暴露 restoreContextUnlock');
});

test('交付验证 2: 隔离环境模拟更新检查 (checkUpdateAsync)', async () => {
  const mockReleases = [
    {
      tag_name: 'v0.9.0',
      name: 'v0.9.0 实验性上下文加长正式集成',
      body: '1. 引入上下文加长功能\n2. 零外部依赖\n3. 支持恢复官方原版',
      published_at: '2026-11-12T00:00:00Z',
      html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.0',
      assets: [
        {
          name: 'antigravity-context-viewer_0.9.0_windows_amd64.zip',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/antigravity-context-viewer_0.9.0_windows_amd64.zip'
        },
        {
          name: 'checksums.txt',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/checksums.txt'
        }
      ]
    }
  ];

  const res = await checkUpdateAsync({
    force: true,
    _requestGithubUrl: async () => JSON.stringify(mockReleases)
  });

  assert.equal(res.ok, true);
  assert.equal(res.hasUpdate, true);
  assert.equal(res.latestVersion, '0.9.0');
  assert.match(res.releaseNotes, /上下文加长/);
});

test('交付验证 3: 隔离环境更新下载、校验与解压安装完整演练', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-delivery-'));

  // 1. 构建模拟新版本文件
  const mockPackageJson = JSON.stringify({ name: 'antigravity-context-viewer', version: '0.9.0' });
  const mockUnlock = "module.exports = { version: '0.9.0-unlocked' };";
  const mockInstallBat = '@echo off\r\necho install complete\r\n';
  const mockCli = 'console.log("mock cli");\n';

  const zipBuf = createSimpleZipBuffer({
    'package.json': mockPackageJson,
    'cli.js': mockCli,
    'meter-context-unlock.js': mockUnlock,
    'install.bat': mockInstallBat
  });

  const zipSha = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const winZipName = 'antigravity-context-viewer_0.9.0_windows_amd64.zip';
  const macZipName = 'antigravity-context-viewer_0.9.0_darwin_arm64.zip';
  const checksumsContent = `${zipSha}  ${winZipName}\n${zipSha}  ${macZipName}\n`;

  const mockReleases = [
    {
      tag_name: 'v0.9.0',
      name: 'v0.9.0',
      published_at: '2026-11-12T00:00:00Z',
      html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.0',
      assets: [
        {
          name: winZipName,
          browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/${winZipName}`
        },
        {
          name: macZipName,
          browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/${macZipName}`
        },
        {
          name: 'checksums.txt',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/checksums.txt'
        }
      ]
    }
  ];

  // 模拟下载 fetcher
  const mockFetcher = async (url, opts = {}) => {
    if (opts.streamTo) {
      if (url.endsWith('checksums.txt')) {
        await writeStreamAsync(opts.streamTo, checksumsContent);
      } else if (url.endsWith('.zip')) {
        await writeStreamAsync(opts.streamTo, zipBuf);
      }
      return;
    }
    if (url.includes('/releases')) {
      return JSON.stringify(mockReleases);
    }
    throw new Error('404 Not Found: ' + url);
  };

  // 模拟子进程执行安装入口
  let inspectedExtractedFile = null;
  const mockSpawn = (runtime, subArgs, opts) => {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const extractDir = opts.cwd;
    const unlockPath = path.join(extractDir, 'meter-context-unlock.js');
    if (fs.existsSync(unlockPath)) {
      inspectedExtractedFile = fs.readFileSync(unlockPath, 'utf8');
    }
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('✅ ASAR 持久化注入完成\n✅ 运行中窗口热挂载状态: 已即时生效（无需重启）\n'));
      child.emit('close', 0, null);
    }, 10);
    return child;
  };

  // 执行 applyUpdateAsync (验证 Windows x64 与 macOS arm64 跨平台资产匹配)
  const updateRes = await applyUpdateAsync({
    version: '0.9.0',
    platform: 'win32',
    arch: 'x64',
    _requestGithubUrl: mockFetcher,
    _spawn: mockSpawn
  });

  if (!updateRes.ok) {
    console.error('DEBUG updateRes error:', updateRes);
  }
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.version, '0.9.0');
  assert.equal(updateRes.diskInstalled, true);
  assert.equal(updateRes.liveInjected, true);

  const macUpdateRes = await applyUpdateAsync({
    version: '0.9.0',
    platform: 'darwin',
    arch: 'arm64',
    _requestGithubUrl: mockFetcher,
    _spawn: mockSpawn
  });
  assert.equal(macUpdateRes.ok, true);
  assert.equal(macUpdateRes.version, '0.9.0');

  // 检查解压包中确实包含了 meter-context-unlock.js！
  assert.equal(inspectedExtractedFile, mockUnlock, '发布更新包解压后必须包含 meter-context-unlock.js');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('交付验证 4: 版本升级识别矩阵（0.8.0 识别 0.8.1 为新版本，0.8.1 不误报更新）', async () => {
  const releasesFixture = [
    {
      tag_name: 'v0.8.1',
      name: 'v0.8.1 修复版本',
      body: '1. 修复原生 helper 缺失\n2. 异步非阻塞状态判定',
      published_at: '2026-11-12T12:00:00Z',
      html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.1',
      assets: [
        {
          name: 'antigravity-context-viewer_0.8.1_windows_amd64.zip',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.1/antigravity-context-viewer_0.8.1_windows_amd64.zip'
        },
        {
          name: 'checksums.txt',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.1/checksums.txt'
        }
      ]
    },
    {
      tag_name: 'v0.8.0',
      name: 'v0.8.0 历史版本',
      body: '历史初始版本',
      published_at: '2026-11-10T12:00:00Z',
      html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.0',
      assets: [
        {
          name: 'antigravity-context-viewer_0.8.0_windows_amd64.zip',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.0/antigravity-context-viewer_0.8.0_windows_amd64.zip'
        }
      ]
    }
  ];

  // 1. 底层 filterReleases 纯函数测试
  const releasesForOld = filterReleases(releasesFixture, '0.8.0');
  assert.equal(releasesForOld.length, 1, '0.8.0 视角应仅过滤出 0.8.1');
  assert.equal(releasesForOld[0].version, '0.8.1');
  assert.equal(releasesForOld[0].tagName, 'v0.8.1');

  const releasesForCurrent = filterReleases(releasesFixture, '0.8.1');
  assert.equal(releasesForCurrent.length, 0, '0.8.1 面对自身及历史版本应无更高可用更新');

  // 2. 模拟 0.8.0 客户端执行 checkUpdateAsync 必须成功识别到 0.8.1
  const checkOld = await checkUpdateAsync({
    currentVersion: '0.8.0',
    installedVersion: '0.8.0',
    force: true,
    _requestGithubUrl: async () => JSON.stringify(releasesFixture)
  });
  assert.equal(checkOld.ok, true);
  assert.equal(checkOld.hasUpdate, true);
  assert.equal(checkOld.currentVersion, '0.8.0');
  assert.equal(checkOld.latestVersion, '0.8.1');
  assert.equal(checkOld.tagName, 'v0.8.1');
  assert.match(checkOld.releaseNotes, /修复原生 helper 缺失/);

  // 3. 0.8.2 默认客户端执行 checkUpdateAsync 面对 0.8.1 Release 必须判定已是最新（无新版本）
  const checkCurrent = await checkUpdateAsync({
    force: true,
    _requestGithubUrl: async () => JSON.stringify(releasesFixture)
  });
  assert.equal(checkCurrent.ok, true);
  assert.equal(checkCurrent.hasUpdate, false);
  assert.equal(checkCurrent.currentVersion, '0.8.2');
});

test('交付验证 5: 隔离环境中模拟在线安装完成后自动清空缓存并动态识别磁盘版本', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-update-sync-'));
  const instPath = path.join(tmpDir, 'installation.json');
  try {
    // 1. 模拟初始状态：磁盘已安装 0.8.0
    fs.writeFileSync(instPath, JSON.stringify({ meterVersion: '0.8.0' }), 'utf8');

    const releasesFixture = [
      {
        tag_name: 'v0.8.1',
        draft: false,
        prerelease: false,
        published_at: '2026-11-12T16:00:00Z',
        body: '修复在线更新状态展示问题',
        assets: [
          {
            name: 'antigravity-context-viewer-v0.8.1-windows_amd64.zip',
            browser_download_url: 'https://example.com/download.zip'
          }
        ]
      }
    ];

    // 2. 模拟更新检查，此时识别到 0.8.1 为新版本
    const check1 = await checkUpdateAsync({
      currentVersion: '0.8.0',
      installedVersion: '0.8.0',
      force: true,
      _requestGithubUrl: async () => JSON.stringify(releasesFixture)
    });
    assert.equal(check1.ok, true);
    assert.equal(check1.hasUpdate, true);
    assert.equal(check1.latestVersion, '0.8.1');

    // 3. 模拟完成安装，installation.json 写入 0.8.1
    fs.writeFileSync(instPath, JSON.stringify({ meterVersion: '0.8.1' }), 'utf8');

    // 4. 更新完成后再次检查更新（无论是否 force），必须动态识别磁盘已是 0.8.1，判定 hasUpdate 为 false
    const check2 = await checkUpdateAsync({
      currentVersion: '0.8.0', // 即使主进程内存仍为旧版
      installedVersion: '0.8.1', // 磁盘已更新为 0.8.1
      force: false,
      _requestGithubUrl: async () => JSON.stringify(releasesFixture)
    });
    assert.equal(check2.ok, true);
    assert.equal(check2.hasUpdate, false, '磁盘安装版本已是 0.8.1，不能继续提示有新版本');
    assert.equal(check2.installedVersion, '0.8.1');
    assert.equal(check2.diskPendingRestart, true, '标记为待重启以完全刷新主进程');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
