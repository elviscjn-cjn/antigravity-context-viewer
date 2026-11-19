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
  applyUpdateAsync,
  parseReleasesAtom,
  parseLatestReleaseHtml,
  parseExpandedAssetsHtml,
  requestGithubUrl,
  isAllowedDownloadRedirectUrl,
  isOfficialAssetDownloadUrl,
  OFFICIAL_RELEASES_API,
  OFFICIAL_RELEASES_ATOM,
  OFFICIAL_RELEASES_LATEST,
  OFFICIAL_RELEASES_WEB_BASE
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
  const osMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const zipName = `antigravity-context-viewer_0.9.0_${osMap[process.platform] || 'windows'}_${archMap[process.arch] || 'amd64'}.zip`;
  const checksumsContent = `${zipSha}  ${zipName}\n`;

  const mockReleases = [
    {
      tag_name: 'v0.9.0',
      name: 'v0.9.0',
      published_at: '2026-11-12T00:00:00Z',
      html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.0',
      assets: [
        {
          name: zipName,
          browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/${zipName}`
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

  // 执行 applyUpdateAsync
  const updateRes = await applyUpdateAsync({
    version: '0.9.0',
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

  // 3. 当前默认客户端执行 checkUpdateAsync 面对 0.8.1 Release 必须判定已是最新（无新版本）
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  const checkCurrent = await checkUpdateAsync({
    force: true,
    _requestGithubUrl: async () => JSON.stringify(releasesFixture)
  });
  assert.equal(checkCurrent.ok, true);
  assert.equal(checkCurrent.hasUpdate, false);
  assert.equal(checkCurrent.currentVersion, pkgVersion);
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

test('Issue #22: API 403/429 限流时自动回退官方 releases.atom + expanded_assets 并完成完整下载与 SHA-256 校验', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue22-fallback-'));
  try {
    const zipBuf = createSimpleZipBuffer({
      'package.json': JSON.stringify({ name: 'antigravity-context-viewer', version: '0.9.2' }),
      'cli.js': 'console.log("ok");\n'
    });
    const zipSha = crypto.createHash('sha256').update(zipBuf).digest('hex');
    const platformMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
    const archMap = { x64: 'amd64', arm64: 'arm64' };
    const zipName = `antigravity-context-viewer_0.9.2_${platformMap[process.platform] || 'windows'}_${archMap[process.arch] || 'amd64'}.zip`;
    const checksumTxt = `${zipSha}  ${zipName}\n`;

    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.9.2</id>
    <updated>2026-11-15T12:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.2"/>
    <title>v0.9.2</title>
    <content type="html">&lt;p&gt;支持官方 Web 回退通道&lt;/p&gt;</content>
  </entry>
</feed>`;

    const expandedHtml = `
      <ul>
        <li><a href="https://evil.example.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/${zipName}">Evil Mirror</a></li>
        <li><a href="/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/../evil/${zipName}">Traversal</a></li>
        <li><a href="/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.1/${zipName}">Wrong Tag</a></li>
        <li><a href="/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/${zipName}">Valid Zip</a></li>
        <li><a href="/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/checksums.txt">Valid Checksum</a></li>
      </ul>`;

    const requestedUrls = [];
    const mockFetcher = async (url, opts = {}) => {
      requestedUrls.push(url);
      if (url === OFFICIAL_RELEASES_API) {
        const err = new Error('GitHub HTTP 403: API rate limit exceeded');
        err.statusCode = 403;
        throw err;
      }
      if (url === OFFICIAL_RELEASES_ATOM) return atomXml;
      if (url === `${OFFICIAL_RELEASES_WEB_BASE}/expanded_assets/v0.9.2`) return expandedHtml;
      if (url === `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/checksums.txt` && opts.streamTo) {
        opts.streamTo.end(Buffer.from(checksumTxt, 'utf8'));
        return;
      }
      if (url === `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/${zipName}` && opts.streamTo) {
        opts.streamTo.end(zipBuf);
        return;
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const chk = await checkUpdateAsync({
      currentVersion: '0.8.3',
      installedVersion: '0.8.3',
      force: true,
      _requestGithubUrl: mockFetcher
    });
    assert.equal(chk.ok, true);
    assert.equal(chk.hasUpdate, true);
    assert.equal(chk.latestVersion, '0.9.2');
    assert.equal(chk.source, 'atom');
    assert.match(chk.releaseNotes, /支持官方 Web 回退通道/);
    assert.equal(chk.assets.length, 2, '仅允许同 tag 官方路径的两个合法资产，过滤外站/穿越/错 tag');

    let spawnCalled = false;
    const targetAsar = path.join(tmpDir, 'mock_app.asar');
    const applyRes = await applyUpdateAsync({
      version: '0.9.2',
      currentVersion: '0.8.3',
      targetPath: targetAsar,
      _requestGithubUrl: mockFetcher,
      _extractZip: async (zp, dir) => {
        fs.writeFileSync(path.join(dir, 'cli.js'), 'ok', 'utf8');
        return { status: 0 };
      },
      _spawn: () => {
        spawnCalled = true;
        const { EventEmitter } = require('events');
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('installed\n'));
          child.emit('close', 0, null);
        }, 5);
        return child;
      }
    });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.version, '0.9.2');
    assert.equal(spawnCalled, true);
    assert.ok(requestedUrls.includes(OFFICIAL_RELEASES_ATOM));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Issue #22: 429 限流且 atom 失败时兜底 releases/latest，同时拦截畸形响应、外站链接与错误校验和', async () => {
  // 1. 429 -> atom 失败 -> releases/latest 成功解析 tag
  const latestRes = await checkUpdateAsync({
    currentVersion: '0.8.3',
    installedVersion: '0.8.3',
    force: true,
    _requestGithubUrl: async (url) => {
      if (url === OFFICIAL_RELEASES_API) {
        const e = new Error('HTTP 429 Too Many Requests');
        e.statusCode = 429;
        throw e;
      }
      if (url === OFFICIAL_RELEASES_ATOM) throw new Error('atom temporarily down');
      if (url === OFFICIAL_RELEASES_LATEST) {
        return {
          data: '<html><head><link rel="canonical" href="https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.5"></head></html>',
          finalUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.5'
        };
      }
      if (url === `${OFFICIAL_RELEASES_WEB_BASE}/expanded_assets/v0.9.5`) {
        return '<a href="/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.5/checksums.txt">cs</a>';
      }
      throw new Error(`Unexpected: ${url}`);
    }
  });
  assert.equal(latestRes.ok, true);
  assert.equal(latestRes.hasUpdate, true);
  assert.equal(latestRes.latestVersion, '0.9.5');
  assert.equal(latestRes.source, 'latest');

  // 2. 畸形 Atom/HTML 结构异常时准确返回失败与官方手动下载入口
  const badCheck = await checkUpdateAsync({
    currentVersion: '0.8.3',
    installedVersion: '0.8.3',
    force: true,
    _requestGithubUrl: async () => '<html>not valid json or xml or tag</html>'
  });
  assert.equal(badCheck.ok, false);
  assert.equal(badCheck.htmlUrl, OFFICIAL_RELEASES_WEB_BASE);
  assert.match(badCheck.error, /官方网页通道回退亦失败/);

  const badAssetsApply = await applyUpdateAsync({
    version: '0.9.5',
    currentVersion: '0.8.3',
    _requestGithubUrl: async (url) => {
      if (url === OFFICIAL_RELEASES_API) return JSON.stringify({ message: 'API rate limit exceeded' });
      if (url === OFFICIAL_RELEASES_ATOM) throw new Error('502');
      if (url === OFFICIAL_RELEASES_LATEST) return { data: '', finalUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.5' };
      if (url.includes('expanded_assets')) return '<div>broken structure with no valid links</div>';
      throw new Error('unexpected');
    }
  });
  assert.equal(badAssetsApply.ok, false);
  assert.match(badAssetsApply.error, /结构异常|手动下载/);
  assert.match(badAssetsApply.htmlUrl, /\/releases\/tag\/v0\.9\.5$/);

  // 3. 路径穿越与外站 URL 守卫验证
  assert.equal(isAllowedDownloadRedirectUrl('/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.5', OFFICIAL_RELEASES_LATEST), true);
  assert.equal(isAllowedDownloadRedirectUrl('https://evil.com/x.zip', OFFICIAL_RELEASES_LATEST), false);
  assert.equal(isOfficialAssetDownloadUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.5/checksums.txt', 'checksums.txt', 'v0.9.5'), true);
  assert.equal(isOfficialAssetDownloadUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.5/../v0.8.0/checksums.txt', 'checksums.txt', 'v0.9.5'), false);
  assert.equal(isOfficialAssetDownloadUrl('https://user:pass@github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.5/checksums.txt', 'checksums.txt', 'v0.9.5'), false);
  assert.equal(parseExpandedAssetsHtml('<a href="/other-owner/repo/releases/download/v0.9.5/checksums.txt">x</a>', 'v0.9.5').length, 0);

  // 4. SHA-256 校验失败拒绝安装
  const badShaRes = await applyUpdateAsync({
    version: '0.9.2',
    currentVersion: '0.8.3',
    _requestGithubUrl: async (url, opts = {}) => {
      const platformMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
      const archMap = { x64: 'amd64', arm64: 'arm64' };
      const zipName = `antigravity-context-viewer_0.9.2_${platformMap[process.platform] || 'windows'}_${archMap[process.arch] || 'amd64'}.zip`;
      if (url === OFFICIAL_RELEASES_API) {
        return JSON.stringify([{
          tag_name: 'v0.9.2',
          html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.2',
          assets: [
            { name: zipName, browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/${zipName}` },
            { name: 'checksums.txt', browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.2/checksums.txt' }
          ]
        }]);
      }
      if (url.endsWith('checksums.txt') && opts.streamTo) {
        opts.streamTo.end(Buffer.from(`${'0'.repeat(64)}  ${zipName}\n`, 'utf8'));
        return;
      }
      if (url.endsWith(zipName) && opts.streamTo) {
        opts.streamTo.end(Buffer.from('corrupted-zip-bytes', 'utf8'));
        return;
      }
      throw new Error(`unexpected ${url}`);
    }
  });
  assert.equal(badShaRes.ok, false);
  assert.match(badShaRes.error, /SHA-256 校验失败/);
});

test('Issue #22: requestGithubUrl 相对重定向跟随、Authorization 不泄露至非 API 域与响应体积上限拦截', async () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const origRequest = https.request;
  const origGhToken = process.env.GITHUB_TOKEN;
  const seenRequests = [];

  try {
    process.env.GITHUB_TOKEN = 'secret_test_token_123';
    https.request = (opts, cb) => {
      seenRequests.push({ hostname: opts.hostname, path: opts.path, headers: opts.headers });
      const req = new EventEmitter();
      req.setTimeout = () => { };
      req.write = () => { };
      req.destroy = (err) => { process.nextTick(() => req.emit('error', err)); };
      req.end = () => {
        const res = new EventEmitter();
        res.resume = () => { };
        if (opts.hostname === 'github.com' && opts.path === '/elviscjn-cjn/antigravity-context-viewer/releases/latest') {
          res.statusCode = 302;
          res.headers = { location: '/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.6' };
          process.nextTick(() => cb(res));
          return;
        }
        if (opts.hostname === 'github.com' && opts.path === '/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.6') {
          res.statusCode = 200;
          res.headers = {};
          process.nextTick(() => {
            cb(res);
            res.emit('data', Buffer.from('<html>ok-tag-page</html>'));
            res.emit('end');
          });
          return;
        }
        if (opts.hostname === 'api.github.com') {
          res.statusCode = 200;
          res.headers = {};
          process.nextTick(() => {
            cb(res);
            res.emit('data', Buffer.from('x'.repeat(200)));
            res.emit('end');
          });
          return;
        }
      };
      return req;
    };

    // 1. github.com 相对重定向且不附带 GITHUB_TOKEN
    const webRes = await requestGithubUrl(OFFICIAL_RELEASES_LATEST, { resolveWithMeta: true });
    assert.equal(webRes.data, '<html>ok-tag-page</html>');
    assert.equal(webRes.finalUrl, 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.6');
    assert.equal(seenRequests[0].headers.Authorization, undefined, '非 API 域禁止携带 GitHub Token');
    assert.equal(seenRequests[1].headers.Authorization, undefined, '重定向目标禁止携带 GitHub Token');

    // 2. api.github.com 携带 Token，但超出 maxBytes 时中止拒绝
    await assert.rejects(
      requestGithubUrl(OFFICIAL_RELEASES_API, { maxBytes: 50 }),
      /超出大小限制/
    );
    assert.equal(seenRequests[2].headers.Authorization, 'Bearer secret_test_token_123');
  } finally {
    https.request = origRequest;
    if (origGhToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = origGhToken;
  }
});

test('交付验证 8: 预发布与正式版通道隔离、beta 升级正式版、release.yml 配置检查', async () => {
  const { getPluginSettings, savePluginSettings } = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-beta-channel-'));
  try {
    const preAndStableReleases = [
      {
        tag_name: 'v0.8.9-beta.2',
        draft: false,
        prerelease: true,
        published_at: '2026-11-20T01:00:00Z',
        html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.9-beta.2',
        body: 'Beta 2',
        assets: []
      },
      {
        tag_name: 'v0.8.9-beta.1',
        draft: false,
        prerelease: true,
        published_at: '2026-11-19T01:00:00Z',
        html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.9-beta.1',
        body: 'Beta 1',
        assets: []
      }
    ];

    // 1. 默认设置：allowBetaUpdates 必须为 false，正式版 0.8.8 不应收到 beta.1 / beta.2
    assert.equal(getPluginSettings({ agDir: tmpDir }).allowBetaUpdates, false);
    const stableDefaultCheck = await checkUpdateAsync({
      agDir: tmpDir,
      currentVersion: '0.8.8',
      installedVersion: '0.8.8',
      force: true,
      _requestGithubUrl: async () => JSON.stringify(preAndStableReleases)
    });
    assert.equal(stableDefaultCheck.ok, true);
    assert.equal(stableDefaultCheck.hasUpdate, false);

    // 2. 开启 allowBetaUpdates 后，正式版 0.8.8 可以检测到 beta.2（且缓存随开关自动失效）
    const saved = savePluginSettings({ allowBetaUpdates: true }, { agDir: tmpDir });
    assert.equal(saved.ok, true);
    assert.equal(getPluginSettings({ agDir: tmpDir }).allowBetaUpdates, true);
    const stableOptInCheck = await checkUpdateAsync({
      agDir: tmpDir,
      currentVersion: '0.8.8',
      installedVersion: '0.8.8',
      _requestGithubUrl: async () => JSON.stringify(preAndStableReleases)
    });
    assert.equal(stableOptInCheck.hasUpdate, true);
    assert.equal(stableOptInCheck.latestVersion, '0.8.9-beta.2');

    // 3. beta.1 用户面对包含正式版 0.8.9 的列表应优先识别并升级到 0.8.9
    const betaToStableCheck = await checkUpdateAsync({
      agDir: tmpDir,
      currentVersion: '0.8.9-beta.1',
      installedVersion: '0.8.9-beta.1',
      allowBetaUpdates: false,
      force: true,
      _requestGithubUrl: async () => JSON.stringify([
        ...preAndStableReleases,
        {
          tag_name: 'v0.8.9',
          draft: false,
          prerelease: false,
          published_at: '2026-11-25T01:00:00Z',
          html_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.9',
          body: 'Stable 0.8.9',
          assets: []
        }
      ])
    });
    assert.equal(betaToStableCheck.hasUpdate, true);
    assert.equal(betaToStableCheck.latestVersion, '0.8.9');
    assert.equal(betaToStableCheck.prerelease, false);

    // 4. release.yml 必须支持 -beta 按 prerelease 发布并使用 displayVersion 作为标题
    const releaseYml = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(releaseYml, /is_prerelease/);
    assert.match(releaseYml, /prerelease:\s*\$\{\{\s*steps\.meta\.outputs\.is_prerelease\s*\}\}/);
    assert.match(releaseYml, /p\.displayVersion/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
