'use strict';
/**
 * 隔离客户端与本地更新源测试：
 * 验证 0.8.2 更新器在安装更高测试版本成功后，不重启主进程再次检查是否停止重复提示更新。
 * 零外网访问、零真实生产客户端改写、零 GitHub Release 创建。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert/strict');

const { checkUpdateAsync, applyUpdateAsync } = require('../meter-collector');
const { compareVersions } = require('../meter-core');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 纯 Node.js 组装标准简单 zip 缓冲区
function createSimpleZip(fileMap) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  function calcCrc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const entries = [];
  let offset = 0;
  for (const [name, content] of Object.entries(fileMap)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = calcCrc32(data);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    entries.push({ nameBuf, data, crc, offset, headerLen: localHeader.length });
    offset += localHeader.length + data.length;
  }

  const centralDirParts = [];
  let centralDirSize = 0;
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(e.offset, 42);
    e.nameBuf.copy(cd, 46);

    centralDirParts.push(cd);
    centralDirSize += cd.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const fileBuffers = [];
  for (const e of entries) {
    const lh = Buffer.alloc(30 + e.nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(e.nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    e.nameBuf.copy(lh, 30);
    fileBuffers.push(lh, e.data);
  }

  return Buffer.concat([...fileBuffers, ...centralDirParts, eocd]);
}

function writeStreamAsync(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(chunk);
  });
}

async function runIsolatedVerification() {
  console.log('[隔离实测开始] 创建隔离客户端环境与本地测试更新源...');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-isolated-updater-test-'));
  const isolateStateDir = path.join(tmpRoot, 'state');
  const isolateHostDir = path.join(tmpRoot, 'host');
  const isolateAsar = path.join(isolateHostDir, 'resources', 'app.asar');
  const isolateInstJson = path.join(isolateStateDir, 'installation.json');

  fs.mkdirSync(isolateStateDir, { recursive: true });
  fs.mkdirSync(path.dirname(isolateAsar), { recursive: true });

  // 1. 模拟隔离宿主环境：初始安装为 0.8.2
  fs.writeFileSync(isolateAsar, Buffer.from('FAKE_ASAR_CONTENT_v0.8.2', 'utf8'));
  const initialManifest = {
    meterVersion: '0.8.2',
    installed: isolateAsar,
    patchedSha256: sha256(fs.readFileSync(isolateAsar)),
    installedAt: new Date().toISOString()
  };
  fs.writeFileSync(isolateInstJson, JSON.stringify(initialManifest, null, 2), 'utf8');

  // 2. 准备本地测试更新源：提供更高测试版本 0.8.3
  const testPkgJson = JSON.stringify({ name: 'antigravity-context-viewer', version: '0.8.3' });
  const testZipBuf = createSimpleZip({
    'package.json': testPkgJson,
    'cli.js': 'console.log("mock 0.8.3 cli");\n',
    'install.bat': '@echo off\r\necho mock installed\r\n'
  });
  const testZipSha = sha256(testZipBuf);
  const testZipName = 'antigravity-context-viewer_0.8.3_windows_amd64.zip';
  const testChecksums = `${testZipSha}  ${testZipName}\n`;

  const localTestRelease = [
    {
      tag_name: 'v0.8.3',
      name: 'v0.8.3 (本地隔离测试版)',
      draft: false,
      prerelease: false,
      published_at: new Date().toISOString(),
      body: '测试更新后不重启状态同步',
      assets: [
        {
          name: testZipName,
          browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.3/${testZipName}`
        },
        {
          name: 'checksums.txt',
          browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.3/checksums.txt'
        }
      ]
    }
  ];

  // 本地隔离更新流 mock
  const localSourceFetcher = async (urlStr, opts = {}) => {
    if (opts.streamTo) {
      if (urlStr.endsWith('checksums.txt')) {
        await writeStreamAsync(opts.streamTo, testChecksums);
      } else if (urlStr.endsWith('.zip')) {
        await writeStreamAsync(opts.streamTo, testZipBuf);
      }
      return;
    }
    return JSON.stringify(localTestRelease);
  };

  const originalStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = isolateStateDir;

  try {
    // -------------------------------------------------------------
    // 阶段一：0.8.2 主进程首次检查更新
    // -------------------------------------------------------------
    console.log('\n[阶段一] 0.8.2 主进程首次执行更新检测 (模拟用户点击“检查更新”)...');
    const check1 = await checkUpdateAsync({
      currentVersion: '0.8.2',
      asarPath: isolateAsar,
      installationJsonPath: isolateInstJson,
      force: true,
      _requestGithubUrl: localSourceFetcher
    });

    console.log(`  -> 首次检测结果: ok=${check1.ok}, hasUpdate=${check1.hasUpdate}, latestVersion=${check1.latestVersion}`);
    assert.equal(check1.ok, true, '检查更新应成功返回');
    assert.equal(check1.hasUpdate, true, '必须发现更高测试版本 0.8.3');
    assert.equal(check1.latestVersion, '0.8.3');

    // -------------------------------------------------------------
    // 阶段二：模拟调用 applyUpdateAsync 执行安装并写入磁盘
    // -------------------------------------------------------------
    console.log('\n[阶段二] 触发更新安装入口 (从本地更新源下载并安装 0.8.3)...');
    
    // 模拟子进程安装过程将新版写回磁盘
    const mockSpawn = (runtime, args, opts) => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      
      setImmediate(() => {
        // 模拟 install.js 将新版本 manifest 写入磁盘
        const updatedManifest = {
          meterVersion: '0.8.3',
          installed: isolateAsar,
          patchedSha256: sha256(Buffer.from('FAKE_ASAR_0.8.3')),
          installedAt: new Date().toISOString()
        };
        fs.writeFileSync(isolateInstJson, JSON.stringify(updatedManifest, null, 2), 'utf8');
        fs.writeFileSync(isolateAsar, Buffer.from('FAKE_ASAR_0.8.3'));

        child.stdout.emit('data', '安装完成: 已成功写入 app.asar 并更新 installation.json\n"liveInjected": true\n');
        child.emit('close', 0);
      });
      return child;
    };

    const applyRes = await applyUpdateAsync({
      version: '0.8.3',
      currentVersion: '0.8.2',
      asarPath: isolateAsar,
      installationJsonPath: isolateInstJson,
      _requestGithubUrl: localSourceFetcher,
      _spawn: mockSpawn
    });

    console.log(`  -> 安装结果: ok=${applyRes.ok}, error=${applyRes.error}, liveInjected=${applyRes.liveInjected}, installedVersion=${applyRes.installedVersion}`);
    assert.equal(applyRes.ok, true, '更新安装必须成功完成');
    assert.equal(applyRes.installedVersion, '0.8.3', '安装返回的已装版本必须是 0.8.3');

    // -------------------------------------------------------------
    // 阶段三：核心实测——不重启主进程，再次执行检查更新
    // -------------------------------------------------------------
    console.log('\n[阶段三] 核心验证：主进程不重启 (内存仍为 0.8.2)，立即再次检查更新...');
    const check2 = await checkUpdateAsync({
      currentVersion: '0.8.2', // 真实模拟：主进程未完全重启，运行时变量依然是 0.8.2
      asarPath: isolateAsar,
      installationJsonPath: isolateInstJson,
      force: false, // 模拟正常二次打开面板或自然周期触发（非 force，检验旧缓存是否彻底失效）
      _requestGithubUrl: localSourceFetcher
    });

    console.log(`  -> 二次检测结果: ok=${check2.ok}, hasUpdate=${check2.hasUpdate}, installedVersion=${check2.installedVersion}, diskPendingRestart=${check2.diskPendingRestart}`);
    
    // 断言 1: 不得重复提示有更新
    assert.equal(check2.hasUpdate, false, '【关键断言通过】更新安装完成后，二次检查严禁继续提示有新版本！');
    
    // 断言 2: 准确识别磁盘实际已装版本
    assert.equal(check2.installedVersion, '0.8.3', '【关键断言通过】准确识别磁盘已更新至 0.8.3');
    
    // 断言 3: 准确标记待重启主进程完整生效
    assert.equal(check2.diskPendingRestart, true, '【关键断言通过】准确判定磁盘版本高于当前运行版本，提示待重启');

    // -------------------------------------------------------------
    // 阶段四：验证完全重启后的状态自愈表现
    // -------------------------------------------------------------
    console.log('\n[阶段四] 验证完全重启后 (主进程运行版本与磁盘对齐为 0.8.3)...');
    const check3 = await checkUpdateAsync({
      currentVersion: '0.8.3', // 重启后运行版本已升级
      asarPath: isolateAsar,
      installationJsonPath: isolateInstJson,
      force: false,
      _requestGithubUrl: localSourceFetcher
    });

    console.log(`  -> 重启后检测结果: ok=${check3.ok}, hasUpdate=${check3.hasUpdate}, diskPendingRestart=${check3.diskPendingRestart}`);
    assert.equal(check3.hasUpdate, false);
    assert.equal(check3.diskPendingRestart, false, '重启后版本完全一致，不再出现待重启提示，直接展示最新');

    console.log('\n============================================================');
    console.log('✅ 【隔离实测全项通过】0.8.2 更新器已彻底消除安装后的重复更新提示死锁！');
    console.log('============================================================\n');
  } finally {
    if (originalStateDir !== undefined) process.env.AG_METER_STATE_DIR = originalStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runIsolatedVerification().catch(err => {
  console.error('❌ 隔离测试失败:', err);
  process.exit(1);
});
