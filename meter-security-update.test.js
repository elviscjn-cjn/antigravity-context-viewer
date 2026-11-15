'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 设置隔离环境：避免 tryHotInject 探测宿主真实端口超时
const isolatedAppData = path.join(os.tmpdir(), 'ag-meter-isolated-appdata');
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;
process.env.AG_METER_TEST_MODE = '1';

const { builtinAsar, loadAsarEngine } = require('./asar-engine');
const asar = loadAsarEngine();
const { install, tryHotInject } = require('./install');
const { restore } = require('./restore');
const {
  checkUpdateAsync,
  applyUpdateAsync,
  resolveNodeRuntime,
  isAllowedDownloadRedirectUrl,
  isOfficialAssetDownloadUrl,
  OFFICIAL_REPO
} = require('./meter-collector');
const core = require('./meter-core');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 辅助写入可写流并等待完全落盘
 */
function writeStreamAsync(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(chunk);
  });
}

/**
 * 辅助函数：快速在临时目录生成一个合法的 mock ASAR
 */
async function createMockHostAsar(dir, version = '0.1.0', utilsContent = null) {
  const rand = Math.random().toString(36).slice(2, 8);
  const src = path.join(dir, `mock-src-${version}-${rand}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');

  const defaultUtils = `"use strict";
function setupNodeWrapper(env) {
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsContent || defaultUtils, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '// mock preload\nconst electron_1 = require("electron");\n', 'utf8');

  const asarPath = path.join(dir, `app-${version}-${rand}.asar`);
  await builtinAsar.createPackageWithOptions(src, asarPath, {});
  try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
  return asarPath;
}

// ============================================================================
// 问题 1 测试集：修复重新安装可能覆盖新版宿主的问题
// ============================================================================

test('安装安全性 1.1：宿主升级后重新安装，以新版宿主为打包基底，绝不覆盖降回旧版本', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-upgrade-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    // 1. 初始化旧版本宿主 0.1.0
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);

    // 2. 首次安装到 0.1.0
    const manifestV1 = await install({ path: targetAsar });
    assert.equal(manifestV1.version, '0.1.0');
    assert.ok(fs.existsSync(manifestV1.backup));
    assert.match(manifestV1.backup, /app-0\.1\.0-.*-base\.asar/);

    // 3. 模拟宿主自身升级到 0.2.0（ASAR 内容被宿主更新覆盖）
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v2Path, targetAsar);
    const hostV2Sha = sha256(fs.readFileSync(targetAsar));
    assert.notEqual(hostV2Sha, manifestV1.patchedSha256);

    // 4. 用户再次运行安装
    const manifestV2 = await install({ path: targetAsar });

    // 验证：必须基于 0.2.0 打包，记录版本必须是 0.2.0，且备份也是 0.2.0
    assert.equal(manifestV2.version, '0.2.0', '重新安装后记录的版本必须是新宿主版本 0.2.0');
    assert.match(manifestV2.backup, /app-0\.2\.0-.*-base\.asar/);
    const installedPkg = JSON.parse(builtinAsar.extractFile(targetAsar, 'package.json').toString('utf8'));
    assert.equal(installedPkg.version, '0.2.0', '目标 ASAR 内 package.json 必须是 0.2.0，严禁降级回 0.1.0');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.2：正常重新安装（当前文件匹配已知补丁哈希时允许使用校验通过的原始备份）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-reinstall-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);

    // 首次安装
    const m1 = await install({ path: targetAsar });
    assert.equal(sha256(fs.readFileSync(targetAsar)), m1.patchedSha256);

    // 第二次重装：当前 ASAR 匹配 m1.patchedSha256
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.version, '0.1.0');
    assert.equal(sha256(fs.readFileSync(targetAsar)), m2.patchedSha256);
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.3：安装记录目标路径不同，不选用旧记录备份', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-diffpath-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const asarA = path.join(tmpDir, 'appA.asar');
    const asarB = path.join(tmpDir, 'appB.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v1Path, asarA);
    fs.copyFileSync(v2Path, asarB);

    // 先安装到 A
    await install({ path: asarA });

    // 随后安装到 B（不同路径）
    const mB = await install({ path: asarB });
    assert.equal(mB.version, '0.2.0', '安装到路径 B 时必须以 B 自身为基底，不得使用 A 的旧备份');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.4：当前文件包含未知补丁痕迹且哈希不匹配安装记录时，明确报错拒绝安装以保持文件不变', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-unrecognized-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 创建一个包含未知补丁痕迹的 mock utils
    const unknownUtils = `"use strict";
function setupNodeWrapper(env) {
}
require("./meter-main").installContextMeter(win);
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const asarPath = await createMockHostAsar(tmpDir, '0.1.0', unknownUtils);
    fs.copyFileSync(asarPath, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    // 执行安装，必须报错
    await assert.rejects(
      async () => { await install({ path: targetAsar }); },
      /当前 ASAR 包含未知的补丁修改痕迹且哈希不匹配安装记录/
    );

    const afterSha = sha256(fs.readFileSync(targetAsar));
    assert.equal(beforeSha, afterSha, '报错后必须保持当前文件绝对不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.5：接口签名不兼容时明确报错，保持原文件不变', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-incompatible-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 缺少 setupNodeWrapper 标记
    const incompatibleUtils = `"use strict";
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const asarPath = await createMockHostAsar(tmpDir, '0.1.0', incompatibleUtils);
    fs.copyFileSync(asarPath, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    await assert.rejects(
      async () => { await install({ path: targetAsar }); },
      /Unexpected createWindow\/setupNodeWrapper/
    );

    const afterSha = sha256(fs.readFileSync(targetAsar));
    assert.equal(beforeSha, afterSha, '报错后当前文件未被修改');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.6：同版本不同安装目标的备份物理隔离，防止 restore 时将 A 的旧备份错误覆盖到 B', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-backup-isolation-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const asarA = path.join(tmpDir, 'appA.asar');
    const asarB = path.join(tmpDir, 'appB.asar');

    // 创建两份同为 0.1.0 但内部 utils 注释不同的 ASAR
    const utilsA = `"use strict";\n// Unique package A identifier\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`;
    const utilsB = `"use strict";\n// Unique package B identifier\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`;

    const dirA = path.join(tmpDir, 'mock-a');
    const dirB = path.join(tmpDir, 'mock-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const vAPath = await createMockHostAsar(dirA, '0.1.0', utilsA);
    const vBPath = await createMockHostAsar(dirB, '0.1.0', utilsB);
    fs.copyFileSync(vAPath, asarA);
    fs.copyFileSync(vBPath, asarB);

    const origShaA = sha256(fs.readFileSync(asarA));
    const origShaB = sha256(fs.readFileSync(asarB));
    assert.notEqual(origShaA, origShaB, 'A 和 B 的原始 ASAR 内容必须不同');

    // 1. 先安装到 A
    const manifestA = await install({ path: asarA });
    assert.equal(manifestA.version, '0.1.0');

    // 2. 接着安装到 B（同版本 0.1.0 但不同目标路径）
    const manifestB = await install({ path: asarB });
    assert.equal(manifestB.version, '0.1.0');

    // 验证备份文件路径与名称已按目标路径隔离
    assert.notEqual(manifestA.backup, manifestB.backup, 'A 和 B 的 backup 路径必须物理隔离');
    assert.notEqual(manifestA.previousInstalledBackup, manifestB.previousInstalledBackup, 'A 和 B 的 previousInstalledBackup 必须物理隔离');

    // 3. 执行 restore()，此时系统 manifest 记录的是 B
    const restoreRes = await restore();
    assert.equal(restoreRes.restored, asarB);

    // 4. 关键验证：B 还原后内容必须严格等于 B 的原始包哈希，绝不等于 A 的原始包
    const restoredShaB = sha256(fs.readFileSync(asarB));
    assert.equal(restoredShaB, origShaB, 'B 还原后的内容必须严格等于 B 原始包');
    assert.notEqual(restoredShaB, origShaA, 'B 绝对不能被错误还原为 A 的内容');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 问题 2 测试集：修复卸载缺少当前文件归属校验的问题
// ============================================================================

test('卸载安全性 2.1：当前文件匹配 patchedSha256 且备份哈希正确时允许还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-ok-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 安装
    const manifest = await install({ path: targetAsar });
    assert.notEqual(sha256(fs.readFileSync(targetAsar)), origSha);

    // 卸载还原
    const res = await restore();
    assert.equal(res.restored, targetAsar);
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '还原后文件哈希必须恢复为原始备份哈希');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.2：当前文件已经等于目标备份时，幂等返回 alreadyRestored: true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-idempotent-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 第一次还原
    const res1 = await restore();
    assert.equal(res1.alreadyRestored, undefined);

    // 第二次重复还原：幂等返回
    const res2 = await restore();
    assert.equal(res2.alreadyRestored, true, '已还原状态下再次卸载必须幂等成功');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.3：宿主已升级或文件被外部改变后，拒绝覆盖还原并说明原因', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-protect-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 模拟宿主在此期间升级了（文件内容变为新版本 0.2.0）
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v2Path, targetAsar);
    const upgradedSha = sha256(fs.readFileSync(targetAsar));

    // 尝试执行 restore，必须被拒绝！
    await assert.rejects(
      async () => { await restore(); },
      /已被宿主升级、第三方补丁或其他操作改变.*拒绝覆盖还原以保护宿主文件/
    );

    // 校验文件保持未被破坏
    assert.equal(sha256(fs.readFileSync(targetAsar)), upgradedSha, '拒绝覆盖后宿主新文件未被篡改');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.4：备份文件被损坏时拒绝还原，不修改当前文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-corrupt-backup-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const m = await install({ path: targetAsar });

    // 破坏所有备份文件
    if (m.backup && fs.existsSync(m.backup)) fs.writeFileSync(m.backup, 'corrupted backup');
    if (m.previousInstalledBackup && fs.existsSync(m.previousInstalledBackup)) fs.writeFileSync(m.previousInstalledBackup, 'corrupted backup');
    const currentSha = sha256(fs.readFileSync(targetAsar));

    await assert.rejects(
      async () => { await restore(); },
      /Backup checksum mismatch; refusing restore/
    );

    assert.equal(sha256(fs.readFileSync(targetAsar)), currentSha, '备份损坏时当前目标文件保持不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装异常恢复 1.7：当前文件包含补丁痕迹且哈希与清单脱节，但存在合规原版备份时，自动安全采信原版备份重新安装', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-recovery-install-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 1. 初次正常安装
    const m1 = await install({ path: targetAsar });
    assert.equal(m1.originalSha256, origSha);

    // 2. 模拟文件被外部二次改动（例如热更新或重新打补丁），导致当前文件哈希与清单中的 patchedSha256 脱节
    // 但内部依旧保留着本插件的补丁痕迹
    fs.appendFileSync(targetAsar, '\n');

    const desyncedSha = sha256(fs.readFileSync(targetAsar));
    assert.notEqual(desyncedSha, m1.patchedSha256, '模拟文件哈希已与安装清单脱节');

    // 3. 再次运行安装：安装器必须能够自动识别该脱节状态，并通过校验匹配的官方原版备份安全重新注入！
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.originalSha256, origSha, '重新安装必须继承并核验原版备份');
    assert.notEqual(m2.patchedSha256, desyncedSha, '必须生成新的合法补丁哈希');

    // 验证重新注入后的文件包含合法补丁
    const newUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(newUtils.includes('installContextMeter(win)'));
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载异常恢复 2.5：当前文件包含补丁痕迹且哈希与清单脱节，但原版备份完好时，自动安全执行纯净原版还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-recovery-restore-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 1. 初次正常安装
    const m1 = await install({ path: targetAsar });

    // 2. 模拟文件哈希脱节但包含补丁痕迹
    fs.appendFileSync(targetAsar, '\n');

    // 3. 运行 restore --force：必须能够将文件完整还原为官方原版！
    const res = await restore({ path: targetAsar, force: true });
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '必须成功还原为官方纯净原版');
    assert.equal(res.restored, targetAsar);

    // 4. 重复卸载：幂等返回 alreadyRestored
    const res2 = await restore({ path: targetAsar, force: true });
    assert.equal(res2.alreadyRestored, true, '自愈后再次卸载必须幂等成功');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 问题 4 & 3 测试集：更新入口来源校验、受控重定向与异步子进程执行
// ============================================================================

test('更新安全 4.1：渲染层传入伪造下载 URL 被彻底忽略，强制向官方固定仓库 API 查询', async () => {
  let queriedUrl = null;
  const mockFetcher = async (url) => {
    queriedUrl = url;
    return JSON.stringify([]); // 空版本列表
  };

  const maliciousOptions = {
    release: {
      latestVersion: '0.9.0',
      assets: [{
        name: 'antigravity-context-viewer_0.9.0_windows_amd64.zip',
        browser_download_url: 'http://malicious-attacker.com/evil.zip'
      }, {
        name: 'checksums.txt',
        browser_download_url: 'http://malicious-attacker.com/checksums.txt'
      }]
    },
    _requestGithubUrl: mockFetcher
  };

  const res = await applyUpdateAsync(maliciousOptions);
  assert.equal(res.ok, false);
  assert.equal(queriedUrl, `https://api.github.com/repos/${OFFICIAL_REPO}/releases`, '主进程必须忽略调用方的 URL，查询固定官方 API');
});

test('更新安全 4.2：资产文件名校验（官方标准无 v 前缀与带 v 均支持，非法包名拒绝）', async () => {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
  const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';

  // 1. 非法文件名
  const badAssetName = 'custom-backdoor.zip';
  const mockFetcherBad = async (url) => {
    return JSON.stringify([{
      tag_name: 'v0.9.0',
      html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
      assets: [
        { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
        { name: badAssetName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${badAssetName}` }
      ]
    }]);
  };
  const resBad = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: mockFetcherBad });
  assert.equal(resBad.ok, false);
  assert.match(resBad.error, /不符合官方命名规范|未提供对应系统架构资产/);

  // 2. 带 v 前缀的兼容包名：能通过包名校验（进入后续校验）
  const legacyPkgName = `antigravity-context-viewer_v0.9.0_${osName}_${archName}.zip`;
  const mockFetcherLegacy = async (url) => {
    return JSON.stringify([{
      tag_name: 'v0.9.0',
      html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
      assets: [
        { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
        { name: legacyPkgName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${legacyPkgName}` }
      ]
    }]);
  };
  const resLegacy = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: mockFetcherLegacy });
  assert.equal(resLegacy.ok, false);
  assert.doesNotMatch(resLegacy.error, /不符合官方命名规范/);
});

test('更新安全 4.3：资产下载 URL 不属于官方仓库时拒绝安装', async () => {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
  const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';
  const validPkgName = `antigravity-context-viewer_0.9.0_${osName}_${archName}.zip`;

  const mockFetcher = async (url) => {
    return JSON.stringify([{
      tag_name: 'v0.9.0',
      html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://evil.org/releases/download/v0.9.0/checksums.txt' },
        { name: validPkgName, browser_download_url: 'https://evil.org/releases/download/v0.9.0/' + validPkgName }
      ]
    }]);
  };

  const res = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: mockFetcher });
  assert.equal(res.ok, false);
  assert.match(res.error, /不属于官方仓库/);
});

test('更新安全 4.4：受控重定向白名单校验', () => {
  assert.equal(isAllowedDownloadRedirectUrl('http://github.com/test'), false, '禁止非 HTTPS 协议');
  assert.equal(isAllowedDownloadRedirectUrl('https://malicious-site.com/payload.zip'), false, '拦截未授权第三方域名');
  assert.equal(isAllowedDownloadRedirectUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345'), true);
  assert.equal(isAllowedDownloadRedirectUrl('https://github-production-release-asset-2e65be.s3.amazonaws.com/12345'), true);
  assert.equal(isAllowedDownloadRedirectUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases'), true);

  assert.equal(isOfficialAssetDownloadUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/checksums.txt', 'checksums.txt'), true);
  assert.equal(isOfficialAssetDownloadUrl('https://github.com/attacker/antigravity-context-viewer/releases/download/v0.9.0/checksums.txt', 'checksums.txt'), false);
  assert.equal(isOfficialAssetDownloadUrl('https://evil.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.9.0/checksums.txt', 'checksums.txt'), false);
});

test('更新安全 4.5：checksums.txt 缺失哈希记录或哈希不匹配时拒绝执行安装入口，清理临时文件', async () => {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
  const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';
  const pkgName = `antigravity-context-viewer_0.9.0_${osName}_${archName}.zip`;

  // 1. checksums.txt 缺少对应记录
  const mockFetcherMissingSha = async (url, opts = {}) => {
    if (url.endsWith('/releases')) {
      return JSON.stringify([{
        tag_name: 'v0.9.0',
        html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
        assets: [
          { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
          { name: pkgName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${pkgName}` }
        ]
      }]);
    }
    if (opts.streamTo) {
      if (url.endsWith('checksums.txt')) {
        await writeStreamAsync(opts.streamTo, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 other-file.zip\n');
      } else {
        await writeStreamAsync(opts.streamTo, 'mock zip binary');
      }
      return;
    }
  };

  const res1 = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: mockFetcherMissingSha });
  assert.equal(res1.ok, false);
  assert.match(res1.error, /未找到合法的 64 位 SHA-256 校验记录/);

  // 2. 哈希不匹配
  const mockFetcherWrongSha = async (url, opts = {}) => {
    if (url.endsWith('/releases')) {
      return JSON.stringify([{
        tag_name: 'v0.9.0',
        html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
        assets: [
          { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
          { name: pkgName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${pkgName}` }
        ]
      }]);
    }
    if (opts.streamTo) {
      if (url.endsWith('checksums.txt')) {
        // 提供一个错误的哈希
        await writeStreamAsync(opts.streamTo, `0000000000000000000000000000000000000000000000000000000000000000  ${pkgName}\n`);
      } else {
        await writeStreamAsync(opts.streamTo, 'mock-content');
      }
      return;
    }
  };

  const res2 = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: mockFetcherWrongSha });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /SHA-256 校验失败/);
});

test('更新安全 4.6：模拟慢速 I/O 延迟打开写入流配合网络请求立即失败，绝不触发 uncaughtException', async () => {
  let uncaughtError = null;
  const uncaughtHandler = (err) => {
    uncaughtError = err;
  };
  process.on('uncaughtException', uncaughtHandler);

  try {
    const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
    const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';
    const pkgName = `antigravity-context-viewer_0.9.0_${osName}_${archName}.zip`;

    const failingFetcher = async (url, opts = {}) => {
      if (url.endsWith('/releases')) {
        return JSON.stringify([{
          tag_name: 'v0.9.0',
          html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
          assets: [
            { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
            { name: pkgName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${pkgName}` }
          ]
        }]);
      }
      if (opts.streamTo) {
        throw new Error('网络连接立即中断: ECONNRESET');
      }
    };

    const res = await applyUpdateAsync({
      version: '0.9.0',
      _requestGithubUrl: failingFetcher
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /ECONNRESET/);

    await new Promise(r => setTimeout(r, 60));
    assert.equal(uncaughtError, null, '写入流必须安全销毁并等待关闭，绝不触发 uncaughtException');
  } finally {
    process.removeListener('uncaughtException', uncaughtHandler);
  }
});

test('子进程更新 3.1：运行时解析区分 Node 与 Electron 运行环境', () => {
  // 1. 模拟非 Electron 环境
  const prevElectronVer = process.versions.electron;
  delete process.versions.electron;
  const nodeRuntime = resolveNodeRuntime();
  assert.equal(nodeRuntime.isElectron, false);
  assert.equal(nodeRuntime.env.ELECTRON_RUN_AS_NODE, undefined);

  // 2. 模拟 Electron 环境
  process.versions.electron = '32.1.0';
  try {
    const electronRuntime = resolveNodeRuntime();
    assert.equal(electronRuntime.isElectron, true);
    assert.equal(electronRuntime.env.ELECTRON_RUN_AS_NODE, '1', 'Electron 环境必须设置 ELECTRON_RUN_AS_NODE=1');
  } finally {
    if (prevElectronVer !== undefined) process.versions.electron = prevElectronVer;
    else delete process.versions.electron;
  }
});

test('子进程更新 3.2：防重复点击并发控制', async () => {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
  const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';
  const pkgName = `antigravity-context-viewer_0.9.0_${osName}_${archName}.zip`;

  let releaseQueryPromiseResolve;
  const slowFetcher = async (url) => {
    await new Promise(r => { releaseQueryPromiseResolve = r; });
    return JSON.stringify([]);
  };

  // 启动第一个更新
  const p1 = applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: slowFetcher });

  // 在 p1 尚未完成时，并发调用 p2
  const res2 = await applyUpdateAsync({ version: '0.9.0', _requestGithubUrl: slowFetcher });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /更新任务正在执行中，请勿重复操作/);

  // 释放 p1
  releaseQueryPromiseResolve();
  await p1;
});

test('子进程更新 3.3：异步子进程非阻塞、超时、非零退出码与热注入状态精确报告', async () => {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
  const archName = (process.arch === 'x64' || process.arch === 'amd64') ? 'amd64' : 'arm64';
  const pkgName = `antigravity-context-viewer_0.9.0_${osName}_${archName}.zip`;
  const contentBuf = Buffer.from('mock zip package');
  const contentSha = sha256(contentBuf);

  const mockFetcher = async (url, opts = {}) => {
    if (url.endsWith('/releases')) {
      return JSON.stringify([{
        tag_name: 'v0.9.0',
        html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/v0.9.0`,
        assets: [
          { name: 'checksums.txt', browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/checksums.txt` },
          { name: pkgName, browser_download_url: `https://github.com/${OFFICIAL_REPO}/releases/download/v0.9.0/${pkgName}` }
        ]
      }]);
    }
    if (opts.streamTo) {
      if (url.endsWith('checksums.txt')) {
        await writeStreamAsync(opts.streamTo, `${contentSha}  ${pkgName}\n`);
      } else {
        await writeStreamAsync(opts.streamTo, contentBuf);
      }
      return;
    }
  };

  const createMockSpawner = (exitCode, stdoutText, stderrText = '', delayMs = 15) => {
    return (runtime, args, options) => {
      assert.ok(Array.isArray(args));
      assert.ok(args.some(a => a.endsWith('cli.js')));
      assert.ok(args.includes('install'));

      const ee = new EventEmitter();
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      setTimeout(() => {
        if (stdoutText) ee.stdout.emit('data', Buffer.from(stdoutText));
        if (stderrText) ee.stderr.emit('data', Buffer.from(stderrText));
        ee.emit('close', exitCode, null);
      }, delayMs);
      return ee;
    };
  };

  const mockExtractZip = async (zipPath, extractDir) => {
    fs.writeFileSync(path.join(extractDir, 'cli.js'), '// mock cli entry\n', 'utf8');
    return { status: 0 };
  };

  // 1. 解压后缺少 cli.js：终止安装并报错
  const mockExtractNoCli = async (zipPath, extractDir) => ({ status: 0 });
  const resNoCli = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractNoCli
  });
  assert.equal(resNoCli.ok, false);
  assert.match(resNoCli.error, /缺少 cli\.js/);

  // 2. 覆盖断言一：执行期间事件循环不阻塞（eventLoopTicked === true）
  let eventLoopTicked = false;
  setImmediate(() => { eventLoopTicked = true; });
  const spawnerNormal = createMockSpawner(0, '✅ ASAR 持久化注入完成\n✅ 运行中窗口热挂载状态: 已即时生效（无需重启）\n', '', 25);
  const resNormal = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerNormal
  });
  assert.equal(resNormal.ok, true);
  assert.equal(eventLoopTicked, true, '子进程异步执行期间 Node 事件循环绝不阻塞');

  // 3. 覆盖断言二：非零退出码返回错误
  const spawnerFail = createMockSpawner(1, '', '磁盘空间不足，写入失败', 10);
  const resFail = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerFail
  });
  assert.equal(resFail.ok, false);
  assert.match(resFail.error, /热安装执行失败: 磁盘空间不足，写入失败/);

  // 4. 覆盖断言三：超时触发 kill 并返回超时错误，等待子进程 close 后安全清理
  let childKillCalled = false;
  const spawnerTimeout = (runtime, args, options) => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = (sig) => {
      childKillCalled = true;
      setTimeout(() => ee.emit('close', null, sig), 10);
    };
    return ee;
  };
  const resTimeout = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerTimeout,
    _timeoutMs: 30
  });
  assert.equal(resTimeout.ok, false);
  assert.match(resTimeout.error, /更新安装子进程执行超时 \(30ms\)/);
  assert.equal(childKillCalled, true, '超时必须触发 child.kill');

  // 5. 覆盖断言四：liveInjected 为 true 与 false 的精确解析与临时目录清理
  const spawnerLiveTrue = createMockSpawner(0, '✅ ASAR 持久化注入完成\n✅ 运行中窗口热挂载状态: 已即时生效（无需重启）\n', '', 10);
  const resTrue = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerLiveTrue
  });
  assert.equal(resTrue.ok, true);
  assert.equal(resTrue.liveInjected, true, '包含“已即时生效（无需重启）”时 liveInjected 为 true');

  const spawnerLiveFalse = createMockSpawner(0, '✅ ASAR 持久化注入完成\n✅ 运行中窗口热挂载状态: 将在下次启动 Antigravity 时自动生效\n', '', 10);
  const resFalse = await applyUpdateAsync({
    version: '0.9.0',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerLiveFalse
  });
  assert.equal(resFalse.ok, true);
  assert.equal(resFalse.liveInjected, false, '未包含即时生效提示时 liveInjected 为 false');

  // 6. 验证子进程参数包含记录的自定义安装路径 --path（问题 3）
  let capturedArgs = null;
  const spawnerInspectArgs = (runtime, args, options) => {
    capturedArgs = args;
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setTimeout(() => ee.emit('close', 0, null), 10);
    return ee;
  };
  await applyUpdateAsync({
    version: '0.9.0',
    targetPath: 'D:\\custom\\antigravity\\resources\\app.asar',
    _requestGithubUrl: mockFetcher,
    _extractZip: mockExtractZip,
    _spawn: spawnerInspectArgs
  });
  assert.ok(Array.isArray(capturedArgs));
  assert.ok(capturedArgs.includes('--path'));
  assert.equal(capturedArgs[capturedArgs.indexOf('--path') + 1], 'D:\\custom\\antigravity\\resources\\app.asar');
});

// ============================================================================
// 问题 5 测试集：修复无法检查更新却显示“最新”的问题
// ============================================================================

function setupRendererHarness() {
  const elements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      disabled: false,
      children: [],
      hidden: false,
      textContent: '',
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!current.includes(c)) current.push(c);
          attrs.set('class', current.join(' '));
        },
        remove(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', current.join(' '));
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); }
    };
    return el;
  };

  const host = element();
  host.attachShadow = () => ({
    set innerHTML(v) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  });

  const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => { if (first) { first = false; return host; } return element(); },
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {}
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) })
  };

  vm.createContext(sandbox);
  vm.runInContext(rendererSource, sandbox);

  return {
    sandbox,
    elements,
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

test('界面状态 5.1：缺少 checkUpdate 桥接时显示 (更新不可用)，严禁显示最新', async () => {
  const h = setupRendererHarness();
  // 移除 checkUpdate 桥接
  delete h.sandbox.window.contextMeterAPI.checkUpdate;

  // 点击检查更新按钮
  h.elements.get('btn-check-update').click();
  await h.flush();

  const verEl = h.elements.get('up-pop-ver');
  const bodyEl = h.elements.get('up-pop-body');
  const applyBtn = h.elements.get('btn-apply-update');

  assert.match(verEl.textContent, /更新不可用/, '缺少桥接时必须显示更新不可用');
  assert.doesNotMatch(verEl.textContent, /最新/, '绝不能显示最新');
  assert.match(bodyEl.textContent, /未提供更新桥接接口/);
  assert.equal(applyBtn.style.display, 'none');

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.2：checkUpdate 返回 null、ok:false 或抛出异常时显示 (检查失败)，严禁显示最新', async () => {
  const h = setupRendererHarness();

  // 1. 测试返回 null
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => null;
  h.elements.get('btn-check-update').click();
  await h.flush();
  assert.match(h.elements.get('up-pop-ver').textContent, /检查失败/);
  assert.doesNotMatch(h.elements.get('up-pop-ver').textContent, /最新/);
  assert.equal(h.elements.get('btn-apply-update').style.display, 'none');

  // 2. 测试返回 ok: false（重置 popover 避免触发 toggle 关闭）
  h.elements.get('update-popover').style.display = 'none';
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => ({ ok: false, error: '网络连接超时' });
  h.elements.get('btn-check-update').click();
  await h.flush();
  assert.match(h.elements.get('up-pop-ver').textContent, /检查失败/);
  assert.match(h.elements.get('up-pop-body').textContent, /网络连接超时/);
  assert.doesNotMatch(h.elements.get('up-pop-ver').textContent, /最新/);

  // 3. 测试抛出异常
  h.elements.get('update-popover').style.display = 'none';
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => { throw new Error('ERR_CONNECTION_REFUSED'); };
  h.elements.get('btn-check-update').click();
  await h.flush();
  assert.match(h.elements.get('up-pop-ver').textContent, /检查失败/);
  assert.match(h.elements.get('up-pop-body').textContent, /ERR_CONNECTION_REFUSED/);
  assert.doesNotMatch(h.elements.get('up-pop-ver').textContent, /最新/);

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.3：有效检查结果确认最新时显示 (已是最新)', async () => {
  const h = setupRendererHarness();
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => ({
    ok: true,
    hasUpdate: false,
    currentVersion: '0.8.0',
    latestVersion: '0.8.0'
  });

  h.elements.get('btn-check-update').click();
  await h.flush();

  const verEl = h.elements.get('up-pop-ver');
  const bodyEl = h.elements.get('up-pop-body');
  assert.match(verEl.textContent, /v0\.8\.0 \(已是最新\)/);
  assert.match(bodyEl.textContent, /当前已是最新版本/);
  assert.equal(h.elements.get('btn-apply-update').style.display, 'none');

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.4：有更新时展示版本对比与立即更新按钮', async () => {
  const h = setupRendererHarness();
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => ({
    ok: true,
    hasUpdate: true,
    currentVersion: '0.8.0',
    latestVersion: '0.8.1',
    releaseNotes: '支持新版宿主热更新'
  });

  h.elements.get('btn-check-update').click();
  await h.flush();

  const verEl = h.elements.get('up-pop-ver');
  const applyBtn = h.elements.get('btn-apply-update');
  assert.equal(verEl.textContent, 'v0.8.0 → v0.8.1');
  assert.equal(applyBtn.style.display, 'inline-block');
  assert.equal(applyBtn.disabled, false);

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.5：应用更新文案区分热注入即时生效与需重启生效', async () => {
  const h = setupRendererHarness();
  let appliedPayload = null;
  h.sandbox.window.contextMeterAPI.checkUpdate = async () => ({
    ok: true,
    hasUpdate: true,
    currentVersion: '0.8.0',
    latestVersion: '0.8.1'
  });
  h.sandbox.window.contextMeterAPI.applyUpdate = async (opts) => {
    appliedPayload = opts;
    return { ok: true, diskInstalled: true, liveInjected: false, version: '0.8.1' };
  };

  h.elements.get('btn-check-update').click();
  await h.flush();

  // 点击更新按钮
  h.elements.get('btn-apply-update').click();
  await h.flush();

  // 验证仅传版本标识
  assert.equal(appliedPayload.version, '0.8.1');
  assert.equal(appliedPayload.release, undefined, '不能传递外部 release 资产对象');

  // liveInjected 为 false，必须提示需重启生效，绝不假称已热注入
  const statusEl = h.elements.get('up-pop-status');
  assert.match(statusEl.textContent, /需完全重启 Antigravity 后生效/);
  assert.doesNotMatch(statusEl.textContent, /已完成热注入即时生效/);

  // 再次测试 liveInjected 为 true
  h.sandbox.window.contextMeterAPI.applyUpdate = async () => ({
    ok: true,
    diskInstalled: true,
    liveInjected: true,
    version: '0.8.1'
  });
  h.elements.get('btn-apply-update').click();
  await h.flush();
  assert.match(statusEl.textContent, /已完成热注入即时生效/);

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.6：在线更新完成后再次检查更新呈现已是最新且红点与更新按钮自动消除', async () => {
  const h = setupRendererHarness();
  let checkCount = 0;
  h.sandbox.window.contextMeterAPI.checkUpdate = async (opts) => {
    checkCount++;
    if (checkCount === 1) {
      return {
        ok: true,
        hasUpdate: true,
        currentVersion: '0.8.0',
        latestVersion: '0.8.1'
      };
    }
    return {
      ok: true,
      hasUpdate: false,
      currentVersion: opts?.currentVersion || '0.8.1',
      installedVersion: '0.8.1',
      latestVersion: '0.8.1'
    };
  };

  h.sandbox.window.contextMeterAPI.applyUpdate = async () => ({
    ok: true,
    diskInstalled: true,
    liveInjected: true,
    version: '0.8.1'
  });

  // 1. 首次检查并应用更新
  h.elements.get('btn-check-update').click();
  await h.flush();
  h.elements.get('btn-apply-update').click();
  await h.flush();

  const titleEl = h.elements.get('up-pop-title');
  const verEl = h.elements.get('up-pop-ver');
  const applyBtn = h.elements.get('btn-apply-update');
  const dot = h.elements.get('update-badge-dot');
  const pop = h.elements.get('update-popover');

  // 2. 更新完成后弹窗关闭，用户再次主动触发“检查更新”
  pop.style.display = 'none';
  h.elements.get('btn-check-update').click();
  await h.flush();

  assert.equal(titleEl.textContent, '✅ 已是最新版本');
  assert.match(verEl.textContent, /v0\.8\.1.*已是最新/);
  assert.equal(applyBtn.style.display, 'none');
  assert.equal(applyBtn.disabled, true);
  assert.equal(dot.style.display, 'none');

  h.sandbox.__AGContextMeter?.dispose();
});

test('界面状态 5.7：汉化状态检测在随后面板打开时即时自愈同步为已生效', async () => {
  const h = setupRendererHarness();
  h.sandbox.window.contextMeterAPI.getModulesStatus = async () => ({
    ok: true,
    data: { modules: { chinese: { enabled: true } } },
    disk: { found: true, chinese: true }
  });

  const badge = h.elements.get('chinese-badge');
  const toggleBtn = h.elements.get('btn-toggle-chinese');

  // 1. 初始展开抽屉，由于此时宿主尚未翻译，显示待重启
  toggleBtn.click();
  await h.flush();
  assert.match(badge.textContent, /⏳ 待重启客户端生效/);

  // 2. 模拟随后宿主汉化完成（注入运行时数据）
  h.sandbox.window.__AGY_I18N_DATA__ = { loaded: true };

  // 3. 用户再次进入面板或展开抽屉，验证自动即时自愈为已生效
  toggleBtn.click(); // 收起
  await h.flush();
  toggleBtn.click(); // 再次展开，触发即时刷新
  await h.flush();

  assert.match(badge.textContent, /🟢 已翻译生效/);
  h.sandbox.__AGContextMeter?.dispose();
});

test('热注入安全 6.1：CDP 返回 exceptionDetails 时 tryHotInject 判定失败返回 false，无异常时返回 true', async () => {
  const http = require('node:http');

  // 解码客户端发来的 WebSocket 文本帧
  function decodeWsFrame(buf) {
    if (buf.length < 2) return null;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const isMasked = (buf[1] & 0x80) !== 0;
    if (isMasked) offset += 4;
    if (buf.length < offset + len) return null;
    const data = Buffer.alloc(len);
    if (isMasked) {
      const mask = buf.subarray(offset - 4, offset);
      for (let i = 0; i < len; i++) {
        data[i] = buf[offset + i] ^ mask[i % 4];
      }
    } else {
      buf.copy(data, 0, offset, offset + len);
    }
    return {
      text: data.toString('utf8'),
      totalBytes: offset + len
    };
  }

  // 构造发送给客户端的 WebSocket 文本帧
  function encodeWsText(text) {
    const payload = Buffer.from(text, 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-hotinject-'));
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = tmpDir;

  let mockReturnException = true;
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const p = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        type: 'page',
        url: 'https://127.0.0.1:12345/main.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/1`
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    let recvBuf = Buffer.alloc(0);
    socket.on('data', chunk => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      while (true) {
        const frame = decodeWsFrame(recvBuf);
        if (!frame) break;
        recvBuf = recvBuf.subarray(frame.totalBytes);

        try {
          const msg = JSON.parse(frame.text);
          let respPayload;
          if (mockReturnException) {
            respPayload = {
              id: msg.id,
              result: {
                exceptionDetails: {
                  text: 'Uncaught SyntaxError: Unexpected identifier',
                  lineNumber: 1
                }
              }
            };
          } else {
            respPayload = {
              id: msg.id,
              result: {
                value: 'injected successfully'
              }
            };
          }
          socket.write(encodeWsText(JSON.stringify(respPayload)));
        } catch {}
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 写入 DevToolsActivePort 文件
  const portDir = path.join(tmpDir, 'Antigravity');
  fs.mkdirSync(portDir, { recursive: true });
  fs.writeFileSync(path.join(portDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/mock\n`);

  try {
    // 1. 模拟 CDP 返回 exceptionDetails：tryHotInject 必须返回 false
    mockReturnException = true;
    const failRes = await tryHotInject();
    assert.equal(failRes, false, '当 CDP 返回 exceptionDetails 时，tryHotInject 必须判定注入失败并返回 false');

    // 2. 模拟 CDP 正常无异常：tryHotInject 返回 true
    mockReturnException = false;
    const okRes = await tryHotInject();
    assert.equal(okRes, true, '当 CDP 执行无异常时，tryHotInject 必须返回 true');
  } finally {
    for (const s of activeSockets) {
      try { s.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
    if (prevAppData !== undefined) process.env.APPDATA = prevAppData;
    else delete process.env.APPDATA;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 专项复核测试集：识别误覆盖、保护无关内容、防跨版本回退与失败恢复
// ============================================================================

test('专项复核 1：同版本不同构建与第三方修改并存（必须保留第三方代码，严禁误丢弃）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-preserve-third-party-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const thirdPartyUtils = `"use strict";
// Third-Party Custom Localization Patch v2
globalThis.__customChineseLocalization = true;
function setupNodeWrapper(env) {
    if (globalThis.__customChineseLocalization) env.LANG = "zh_CN.UTF-8";
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const hostPath = await createMockHostAsar(tmpDir, '2.31.2', thirdPartyUtils);
    fs.copyFileSync(hostPath, targetAsar);

    // 1. 初次安装
    await install({ path: targetAsar });

    // 2. 模拟文件哈希微变（脱节）但带有第三方修改与旧插件痕迹
    fs.appendFileSync(targetAsar, '\n');

    // 3. 再次运行安装（重装升级）
    await install({ path: targetAsar });

    // 4. 断言：第三方修改必须完好保留！
    const resUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(resUtils.includes('Third-Party Custom Localization Patch v2'), '必须完整保留第三方的自定义注释');
    assert.ok(resUtils.includes('globalThis.__customChineseLocalization = true;'), '必须完整保留第三方定义的全局变量');
    assert.ok(resUtils.includes('env.LANG = "zh_CN.UTF-8"'), '必须完整保留第三方定制的逻辑');
    assert.ok(resUtils.includes('installContextMeter(win)'), '必须成功注入最新版插件代码');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 2：新版宿主仍含插件痕迹（严禁宿主版本意外回退回旧备份）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-prevent-host-downgrade-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 1. 在旧版宿主 2.30.0 上安装本插件，留下 2.30.0 的备份
    const v1Path = await createMockHostAsar(tmpDir, '2.30.0');
    fs.copyFileSync(v1Path, targetAsar);
    const m1 = await install({ path: targetAsar });
    assert.equal(m1.version, '2.30.0');

    // 2. 宿主跨版本升级到了 2.31.2，外部操作残留了插件痕迹
    const v2ResidualUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    require("./meter-main").installContextMeter(win);
    void win.loadURL(url);
}
`;
    const v2Path = await createMockHostAsar(tmpDir, '2.31.2', v2ResidualUtils);
    fs.copyFileSync(v2Path, targetAsar);

    // 3. 执行安装：必须基于当前 2.31.2 打包，严禁将宿主版本回退为旧备份 2.30.0！
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.version, '2.31.2', '宿主版本必须继承当前宿主 2.31.2，绝不能回退为旧备份 2.30.0');
    const installedPkg = JSON.parse(builtinAsar.extractFile(targetAsar, 'package.json').toString('utf8'));
    assert.equal(installedPkg.version, '2.31.2', 'ASAR 内部版本必须是 2.31.2');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 3：当前文件不含插件但清单陈旧（卸载时必须拒绝覆盖当前纯净新文件）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-stale-manifest-restore-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const cleanHost = await createMockHostAsar(tmpDir, '2.31.2', `"use strict";\n// Official clean freshly installed\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`);
    fs.copyFileSync(cleanHost, targetAsar);
    const cleanSha = sha256(fs.readFileSync(targetAsar));

    // 执行卸载：必须拒绝覆盖，保护用户的新文件！
    await assert.rejects(
      async () => { await restore({ path: targetAsar }); },
      /拒绝覆盖还原以保护宿主文件/
    );
    assert.equal(sha256(fs.readFileSync(targetAsar)), cleanSha, '拒绝后当前纯净文件未被破坏');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 4：外部备份属于不同版本或无效（--backup 严格校验，拒绝并保持原文件不变）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-explicit-backup-validation-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    // 1. 传入不存在的文件路径
    await assert.rejects(
      async () => { await install({ path: targetAsar, backup: path.join(tmpDir, 'nonexistent.asar') }); },
      /指定的 --backup 文件不存在或无效/
    );

    // 2. 传入版本不匹配的备份 (2.30.0 vs 2.31.2)
    const mismatchedBackup = await createMockHostAsar(tmpDir, '2.30.0');
    await assert.rejects(
      async () => { await install({ path: targetAsar, backup: mismatchedBackup }); },
      /指定的 --backup 宿主版本.*不匹配/
    );

    assert.equal(sha256(fs.readFileSync(targetAsar)), beforeSha, '参数无效时目标文件必须保持不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 5：改写中断与失败恢复机制（快照原子回退保护）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-rollback-protection-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    const origCopy = fs.copyFileSync;
    let didThrow = false;
    try {
      fs.copyFileSync = (src, dest) => {
        if (dest === targetAsar && !didThrow) {
          didThrow = true;
          throw new Error('Simulated disk full or I/O failure during file write');
        }
        return origCopy(src, dest);
      };

      await assert.rejects(
        async () => { await install({ path: targetAsar }); },
        /Simulated disk full or I\/O failure/
      );

      assert.equal(sha256(fs.readFileSync(targetAsar)), beforeSha, '异常中断后目标文件必须完整还原无损坏');
    } finally {
      fs.copyFileSync = origCopy;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 6：restore 卸载时原位清洗保留第三方修改（反例 A 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-preserve-mod-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const staging = path.join(tmpDir, 'staging-post-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    const thirdPartyMarker = '// Custom User Third-Party Feature Injection';
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n' + thirdPartyMarker + '\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const res = await restore({ path: targetAsar });
    assert.equal(res.inPlaceCleaned, true, '必须优先走原位清洗卸载');

    const restoredUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(restoredUtils.includes(thirdPartyMarker), '卸载后第三方修改必须完好保留，严禁被旧备份覆盖丢弃');
    assert.equal(restoredUtils.includes('installContextMeter'), false, '本插件挂载代码必须已被彻底移除');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 7：改写目标后发生后续异常时的真实快照回滚（反例 B 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-rollback-manifest-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    const origWriteFile = fs.writeFileSync;
    fs.writeFileSync = (p, data, opt) => {
      if (typeof p === 'string' && p.endsWith('installation.json')) {
        throw new Error('Simulated disk full or permission error while saving installation.json');
      }
      return origWriteFile(p, data, opt);
    };

    try {
      await assert.rejects(
        async () => { await install({ path: targetAsar }); },
        /Simulated disk full or permission error while saving installation.json/
      );

      const afterSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterSha, beforeSha, '写清单失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.writeFileSync = origWriteFile;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 8：restore 自定义 --path 严格归属校验（反例 C 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-path-ownership-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetA = path.join(tmpDir, 'target-a', 'app.asar');
    const targetB = path.join(tmpDir, 'target-b', 'app.asar');
    fs.mkdirSync(path.dirname(targetA), { recursive: true });
    fs.mkdirSync(path.dirname(targetB), { recursive: true });

    const hostA = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(hostA, targetA);
    const hostB = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(hostB, targetB);

    await install({ path: targetA });

    await assert.rejects(
      async () => { await restore({ path: targetB }); },
      /与安装记录中的目标.*不一致，拒绝跨目标还原/
    );
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 9：原有 autoHideMenuBar 不被误删且 JS 语法校验通过（反例 D 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-preserve-menubar-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const customMenuBarUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const win = { autoHideMenuBar: true };
    void win.loadURL(url);
}
`;
    const host = await createMockHostAsar(tmpDir, '2.31.2', customMenuBarUtils);
    fs.copyFileSync(host, targetAsar);

    await install({ path: targetAsar });
    fs.appendFileSync(targetAsar, '\n');
    await install({ path: targetAsar });

    const finalUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(finalUtils.includes('const win = { autoHideMenuBar: true };'), '宿主原有的 autoHideMenuBar 绝不能被清洗逻辑误删！');

    const vm = require('vm');
    assert.doesNotThrow(() => {
      new vm.Script(finalUtils, { filename: 'dist/utils.js' });
    }, '最终 utils.js 必须是合法且可编译执行的 JavaScript 脚本');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('三模块组合验证 10：单模块、双模块、三模块按需开启、独立关闭及旧版配置平滑迁移', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-three-modules-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    const { TAGS, validateSyntax } = require('./modular-installer');
    const { loadModulesConfig, saveModulesConfig, testProxyHealth } = require('./modules-config');

    // 1. 初始状态：仅安装上下文模块 (ContextMeter)，显式指定 pureMeterOnly
    const m1 = await install({ path: targetAsar, pureMeterOnly: true, modules: { meter: { enabled: true }, chinese: { enabled: false }, proxy: { enabled: false } } });
    let u1 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    let p1 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');

    assert.ok(u1.includes(TAGS.METER_UTILS_START), '上下文模块 utils 成对标记必须存在');
    assert.ok(p1.includes(TAGS.METER_PRELOAD_START), '上下文模块 preload 成对标记必须存在');
    assert.equal(u1.includes(TAGS.PROXY_START), false, '纯净上下文模式下免 TUN 绝不能有标记');
    assert.equal(p1.includes(TAGS.CHINESE_START), false, '纯净上下文模式下汉化绝不能有标记');
    assert.ok(validateSyntax(u1, 'dist/utils.js'));
    assert.ok(validateSyntax(p1, 'dist/preload.js'));

    // 2. 独立增量启用免 TUN 代理模块
    await install({ path: targetAsar, injectChinese: false, modules: { proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:9999' } } });
    let u2 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(u2.includes(TAGS.PROXY_START), '免 TUN 代理成对标记必须成功注入');
    assert.ok(u2.includes('127.0.0.1:9999'), '自定义代理地址必须准确写入');
    assert.ok(u2.includes(TAGS.METER_UTILS_START), '原上下文模块必须完好保留');
    assert.ok(validateSyntax(u2, 'dist/utils.js'));

    // 3. 独立增量启用汉化模块（三模块同时启用）
    await install({ path: targetAsar, modules: { chinese: { enabled: true } } });
    let u3 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    let p3 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.ok(u3.includes(TAGS.PROXY_START), '三模块共存时免 TUN 仍存在');
    assert.ok(u3.includes(TAGS.METER_UTILS_START), '三模块共存时上下文仍存在');
    assert.ok(p3.includes(TAGS.CHINESE_START), '三模块共存时汉化标记必须成功注入');
    assert.ok(validateSyntax(u3, 'dist/utils.js'));
    assert.ok(validateSyntax(p3, 'dist/preload.js'));

    // 4. 独立关闭免 TUN 模块并原位清洗标记
    await install({ path: targetAsar, injectProxy: false, modules: { proxy: { enabled: false } } });
    let u4 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    let p4 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.equal(u4.includes(TAGS.PROXY_START), false, '免 TUN 模块清洗后，其标记与代码必须被干净移除');
    assert.ok(u4.includes(TAGS.METER_UTILS_START), '关闭免 TUN 模块时，上下文模块必须完好保留');
    assert.ok(p4.includes(TAGS.CHINESE_START), '关闭免 TUN 模块时，汉化模块必须完好保留');
    assert.ok(validateSyntax(u4, 'dist/utils.js'));

    // 5. 独立关闭汉化模块并原位清洗标记
    await install({ path: targetAsar, injectProxy: false, injectChinese: false, modules: { chinese: { enabled: false } } });
    let p5 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.equal(p5.includes(TAGS.CHINESE_START), false, '汉化模块清洗后，其标记与代码必须被干净移除');
    assert.ok(p5.includes(TAGS.METER_PRELOAD_START), '关闭汉化模块时，上下文模块必须完好保留');
    assert.ok(validateSyntax(p5, 'dist/preload.js'));

    // 6. 代理健康分层检测断言
    const invalidRes = await testProxyHealth('not_a_valid_url');
    assert.equal(invalidRes.configValid, false);
    assert.match(invalidRes.error, /格式错误/);

    const unreachableRes = await testProxyHealth('http://127.0.0.1:54321');
    assert.equal(unreachableRes.configValid, true);
    assert.equal(unreachableRes.proxyReachable, false);
    assert.match(unreachableRes.error, /无法连接/);
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 11：restore 原位卸载写入目标时发生 I/O 异常时的快照回滚（断言目标文件未被写坏）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-write-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 增加第三方修改使其进入原位解构卸载路径
    const staging = path.join(tmpDir, 'staging-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n// Third Party Modification\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const beforeRestoreSha = sha256(fs.readFileSync(targetAsar));

    // Mock: 模拟在将原位清洗后的文件写回目标时抛出 I/O 错误
    const origCopy = fs.copyFileSync;
    let didThrow = false;
    fs.copyFileSync = (src, dest) => {
      if (dest === targetAsar && !didThrow) {
        didThrow = true;
        // 模拟文件被截断/破坏时抛出异常
        throw new Error('Simulated disk full or I/O failure while writing restored ASAR');
      }
      return origCopy(src, dest);
    };

    try {
      await assert.rejects(
        async () => { await restore({ path: targetAsar }); },
        /Simulated disk full or I\/O failure while writing restored ASAR/
      );

      // 断言：必须真实从快照回滚，目标文件完整保留原状，绝不留下损坏文件！
      const afterRestoreSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterRestoreSha, beforeRestoreSha, '原位卸载写入失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.copyFileSync = origCopy;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 12：restore 原位卸载替换成功后写清单失败时的快照回滚（断言文件与清单保持一致）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-manifest-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const staging = path.join(tmpDir, 'staging-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n// Third Party Modification\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const beforeRestoreSha = sha256(fs.readFileSync(targetAsar));

    // Mock: 模拟在写回 targetAsar 成功后，写入 installation.json 失败
    const origWriteFile = fs.writeFileSync;
    fs.writeFileSync = (p, data, opt) => {
      if (typeof p === 'string' && p.endsWith('installation.json')) {
        throw new Error('Simulated disk full while updating installation.json during restore');
      }
      return origWriteFile(p, data, opt);
    };

    try {
      await assert.rejects(
        async () => { await restore({ path: targetAsar }); },
        /Simulated disk full while updating installation.json during restore/
      );

      // 断言：写清单失败后必须自动回滚目标文件，确保文件与清单不脱节
      const afterRestoreSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterRestoreSha, beforeRestoreSha, '卸载写清单失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.writeFileSync = origWriteFile;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 13：汉化与三模块重复安装、资源缺失防护与原位解构清理', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-review-three-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    const { TAGS, validateSyntax, generateChinesePreloadCode } = require('./modular-installer');

    // 1. 静态代码审查断言：源码中绝对不残留作者本地绝对开发路径
    const installSrc = fs.readFileSync(path.join(__dirname, 'install.js'), 'utf8');
    assert.equal(installSrc.includes('D:\\AI_plugin'), false, 'install.js 严禁包含作者绝对开发路径');
    const restoreSrc = fs.readFileSync(path.join(__dirname, 'restore.js'), 'utf8');
    assert.equal(restoreSrc.includes('D:\\AI_plugin'), false, 'restore.js 严禁包含作者绝对开发路径');

    // 2. 首次安装带汉化与代理
    await install({ path: targetAsar, modules: { meter: { enabled: true }, chinese: { enabled: true }, proxy: { enabled: true } } });
    const p1 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.ok(p1.includes(TAGS.CHINESE_START), '首次安装汉化标记必须存在');

    // 3. 重复执行带汉化的安装：必须平滑通过，绝不能因 dist/i18n 未在 allowedChanges 而崩溃
    await assert.doesNotReject(async () => {
      await install({ path: targetAsar, modules: { meter: { enabled: true }, chinese: { enabled: true }, proxy: { enabled: true } } });
    }, '同版本或已有 i18n 资源存在时重新安装必须平滑通过');

    // 4. 原位解构卸载：必须同时清洗 dist/i18n 资源
    await restore({ path: targetAsar });
    const entriesAfterRestore = builtinAsar.listPackage(targetAsar);
    assert.equal(entriesAfterRestore.includes('/dist/i18n/zh-CN.json'), false, '原位解构卸载后 dist/i18n 必须被干净移除');
    assert.equal(entriesAfterRestore.includes('/dist/i18n/i18n-runtime.js'), false, '原位解构卸载后 i18n-runtime.js 必须被移除');

    // 5. 校验 preload 汉化注入代码门禁语法
    const dummyDict = '{"exact":{}}';
    const dummyRuntime = 'console.log("rt");';
    const code = generateChinesePreloadCode(dummyDict, dummyRuntime);
    assert.ok(validateSyntax(code, 'preload.js'), '生成的 preload 汉化注入代码必须通过语法检查');
    assert.ok(code.includes('chinese.enabled === false'), '生成的 preload 汉化代码必须包含配置门禁检查');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 14：隔离集成测试：状态机三分模型、目标定位失败保护与深层能力判定断言', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-ipc-toggle-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    const { loadModulesConfig, inspectDiskModules, PROJECT_VERSION } = require('./modules-config');
    const { handleToggleModule, handleModulesStatus } = require('./meter-main');
    const { TAGS } = require('./modular-installer');

    // 0. 权威版本一致性断言：模块配置 PROJECT_VERSION 必须严格等于 package.json 版本
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(PROJECT_VERSION, pkg.version, 'PROJECT_VERSION 必须与 package.json 绝对一致');

    const fakeEvent = {
      sender: {
        getURL: () => 'https://127.0.0.1:45678/'
      }
    };

    // 1. 模拟未注入任何扩展模块的宿主环境（显式指定 pureMeterOnly）
    await install({ path: targetAsar, pureMeterOnly: true, modules: { meter: { enabled: true }, chinese: { enabled: false }, proxy: { enabled: false } } });
    
    // 检查磁盘初始状态
    const initDisk = inspectDiskModules(targetAsar);
    assert.equal(initDisk.chinese, false, '初始磁盘 preload 未注入汉化代码');
    assert.equal(initDisk.chineseReady, false);
    assert.equal(initDisk.meter, true, '初始磁盘 utils 包含上下文监控');

    const status1 = await handleModulesStatus(fakeEvent, targetAsar);
    assert.equal(status1.ok, true);
    assert.equal(status1.data.modules.chinese.enabled, false);
    assert.equal(status1.disk.chinese, false);

    // 2. 模拟磁盘组件未就绪时的保护拦截：在未注入汉化的宿主上，客户端内尝试开启汉化
    // 测试防护机制：绝对不能把异常吃掉！绝对不能将配置改成 true！绝不调用内部危险安装！
    const resFail = await handleToggleModule(fakeEvent, 'chinese', true, { asarPath: targetAsar });

    assert.equal(resFail.ok, false, '磁盘未就绪时 toggle-module 必须返回 ok: false');
    assert.equal(resFail.status, 'install_failed', '状态必须明确为 install_failed');
    assert.match(resFail.error, /未注入/, '错误描述必须清晰指出磁盘未注入组件');

    // 核查配置：modules.json 必须保持 enabled: false，绝不偷偷改成已开启！
    const cfgAfterFail = loadModulesConfig();
    assert.equal(cfgAfterFail.modules.chinese.enabled, false, '安装失败后配置必须依然保持 false');

    // 3. 正常执行包含汉化门禁的安装（模拟用户通过 CLI 或成功安装器打入带门禁与字典的完整包）
    await install({ path: targetAsar, modules: { chinese: { enabled: true } } });
    const readyDisk = inspectDiskModules(targetAsar);
    assert.equal(readyDisk.chinese, true, '此时磁盘已注入汉化');
    assert.equal(readyDisk.chineseReady, true, '此时磁盘深层核实完整运行时与字典已就绪');
    assert.equal(readyDisk.chineseStatus, 'ready');

    // 4. 客户端内关闭汉化 (已有完整运行时通过配置门禁切换: config_toggled)
    const resClose = await handleToggleModule(fakeEvent, 'chinese', false, { asarPath: targetAsar });
    assert.equal(resClose.ok, true);
    assert.equal(resClose.status, 'config_toggled', '必须命中 config_toggled 结果类型');
    assert.equal(resClose.restartRequired, true, '必须提示需重启客户端生效');
    const cfgClosed = loadModulesConfig();
    assert.equal(cfgClosed.modules.chinese.enabled, false, '配置已正确更新为关闭');

    // 5. 客户端内重新开启汉化 (同样命中 config_toggled，无需重复改写 ASAR)
    const resReOpen = await handleToggleModule(fakeEvent, 'chinese', true, { asarPath: targetAsar });
    assert.equal(resReOpen.ok, true);
    assert.equal(resReOpen.status, 'config_toggled');
    assert.equal(resReOpen.restartRequired, true);
    const cfgReOpen = loadModulesConfig();
    assert.equal(cfgReOpen.modules.chinese.enabled, true, '配置已正确更新为开启');

    // 6. 深层能力判定反例测试 A: 标记存在但字典为空字典字面量 {}（缺少条目资源）
    const brokenDictStaging = path.join(tmpDir, 'mock-broken-dict');
    fs.mkdirSync(path.join(brokenDictStaging, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(brokenDictStaging, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.31.2' }));
    fs.writeFileSync(path.join(brokenDictStaging, 'dist', 'utils.js'), '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url) { void win.loadURL(url); }\n');
    fs.writeFileSync(path.join(brokenDictStaging, 'dist', 'preload.js'), `${TAGS.CHINESE_START}\nvar _dictData = {};\nfunction createI18nEngine(){}\nif (modules.chinese.enabled === false) return;\n${TAGS.CHINESE_END}\n`);
    const brokenDictAsar = path.join(tmpDir, 'broken-dict.asar');
    await builtinAsar.createPackageWithOptions(brokenDictStaging, brokenDictAsar, {});
    fs.rmSync(brokenDictStaging, { recursive: true, force: true });

    const brokenDisk = inspectDiskModules(brokenDictAsar);
    assert.equal(brokenDisk.chinese, true, '标记确实存在');
    assert.equal(brokenDisk.chineseReady, false, '但字典为空，不能判定为 ready');
    assert.equal(brokenDisk.chineseStatus, 'missing_resources', '状态必须判定为 missing_resources');

    // 7. 深层能力判定反例测试 B: 标记与字典存在但缺少配置门禁
    const noGateStaging = path.join(tmpDir, 'mock-no-gate');
    fs.mkdirSync(path.join(noGateStaging, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(noGateStaging, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.31.2' }));
    fs.writeFileSync(path.join(noGateStaging, 'dist', 'utils.js'), '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url) { void win.loadURL(url); }\n');
    const validDictSample = JSON.stringify({ exact: { "Hello": "你好", "World": "世界", "Settings": "设置", "About": "关于" } });
    fs.writeFileSync(path.join(noGateStaging, 'dist', 'preload.js'), `${TAGS.CHINESE_START}\nvar _dictData = ${validDictSample.repeat(10)};\nwindow.__AGY_I18N_DATA__ = _dictData;\nfunction createI18nEngine(){}\n${TAGS.CHINESE_END}\n`);
    const noGateAsar = path.join(tmpDir, 'no-gate.asar');
    await builtinAsar.createPackageWithOptions(noGateStaging, noGateAsar, {});
    fs.rmSync(noGateStaging, { recursive: true, force: true });

    const noGateDisk = inspectDiskModules(noGateAsar);
    assert.equal(noGateDisk.chinese, true);
    assert.equal(noGateDisk.chineseReady, false);
    assert.equal(noGateDisk.chineseStatus, 'missing_gate', '缺少门禁必须判定为 missing_gate');

    // 8. 免 TUN 代理模块失败防护测试
    // 若代理原本未注入，客户端内尝试开启必须报错并拒绝修改配置为 true
    const cleanHostForProxy = await createMockHostAsar(tmpDir, '2.31.2');
    const resProxyFail = await handleToggleModule(fakeEvent, 'proxy', true, { asarPath: cleanHostForProxy });
    assert.equal(resProxyFail.ok, false);
    assert.equal(resProxyFail.status, 'install_failed');
    assert.match(resProxyFail.error, /未注入/);
    const cfgProxyFail = loadModulesConfig();
    assert.equal(cfgProxyFail.modules.proxy.enabled, false, '代理未就绪配置严禁被改成 true');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 15：真实 Electron/ASAR 模块加载环境验证：运行在 app.asar 内部时状态查询与模块检测零异常、零 process.noAsar 副作用', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-electron-asar-env-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'test-target.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    // 1. 执行全量模块安装注入，生成包含 additions（asar-engine, modules-config, modular-installer, meter-main 等）的真实完整 ASAR
    await install({
      path: targetAsar,
      modules: {
        meter: { enabled: true },
        chinese: { enabled: true },
        proxy: { enabled: true }
      }
    });

    // 2. 纯 Node 环境断言：引入 modules-config 和 inspectDiskModules 前后绝对不污染 process.noAsar
    const { inspectDiskModules, loadModulesConfig } = require('./modules-config');
    const beforeNodeNoAsar = process.noAsar;
    const diskFromNode = inspectDiskModules(targetAsar);
    assert.equal(process.noAsar, beforeNodeNoAsar, 'Node 环境下 inspectDiskModules 不得篡改 process.noAsar');
    assert.equal(diskFromNode.found, true);
    assert.equal(diskFromNode.chinese, true);
    assert.equal(diskFromNode.proxy, true);

    // 3. 真实 Electron/ASAR 模块加载环境复现验证
    // 探测本机 Antigravity 或 Electron 可执行文件
    const electronCandidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(process.env.ProgramFiles || '', 'antigravity', 'Antigravity.exe'),
      path.join(process.env.ProgramFiles || '', 'Google Antigravity', 'Antigravity.exe')
    ];
    const electronExe = electronCandidates.find(p => fs.existsSync(p));

    if (!electronExe) {
      console.log('   [注意] 当前机器未检测到 Antigravity.exe 宿主可执行文件，标记 Electron 真实进程子用例跳过（Node ASAR 验证已通过）');
      return;
    }

    const runnerScript = path.join(tmpDir, 'runner.js');
    fs.writeFileSync(runnerScript, `
'use strict';
const assert = require('assert');
const testAsar = ${JSON.stringify(targetAsar)};

assert.ok(process.versions.electron, '必须在 Electron 宿主运行时中执行');
assert.equal(process.noAsar, undefined, '初始 process.noAsar 必须为 undefined');

// 从 ASAR 归档内部路径加载 modules-config
const modulesConfigPath = testAsar + '/dist/modules-config.js';
const { inspectDiskModules, loadModulesConfig } = require(modulesConfigPath);
assert.equal(process.noAsar, undefined, 'require 内部 modules-config 后 process.noAsar 必须保持 undefined');

// 触发状态检测，断言不再报错 ENOENT/open/lstat 且正常返回各模块就绪状态
const disk = inspectDiskModules(testAsar);
assert.equal(disk.found, true);
assert.equal(disk.meter, true);
assert.equal(disk.chinese, true);
assert.equal(disk.proxy, true);
assert.equal(process.noAsar, undefined, '调用 inspectDiskModules 后 process.noAsar 必须依然为 undefined');

const cfg = loadModulesConfig();
assert.equal(cfg.modules.chinese.enabled, true);
assert.equal(cfg.modules.proxy.enabled, true);

console.log('ELECTRON_ASAR_VERIFIED_SUCCESS');
`, 'utf8');

    const { spawnSync } = require('child_process');
    const childRes = spawnSync(electronExe, [runnerScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 10000
    });

    assert.equal(childRes.status, 0, `Electron 子进程异常退出 (${childRes.status})。STDERR: ${childRes.stderr}`);
    assert.match(childRes.stdout, /ELECTRON_ASAR_VERIFIED_SUCCESS/, 'Electron ASAR 内部加载断言必须成功完成');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 16：沙箱 preload 环境下汉化门禁回退到 ipcRenderer.sendSync 且默认 fail-closed', async () => {
  const vm = require('vm');
  const { generateChinesePreloadCode, validateSyntax } = require('./modular-installer');
  const code = generateChinesePreloadCode('{"exact":{}}', 'globalThis.__TEST_CHINESE_EXECUTED__ = true;');
  assert.ok(validateSyntax(code, 'preload.js'), '生成的沙箱 preload 代码必须合法');

  const runInSandbox = (ipcReturnValue) => {
    const sandbox = {
      require: () => { throw new Error('sandboxed require blocked'); },
      process: { platform: 'win32', env: {} },
      electron_1: {
        ipcRenderer: {
          sendSync: (channel) => (channel === 'context-meter:is-chinese-enabled' ? ipcReturnValue : false)
        }
      },
      window: {},
      globalThis: {}
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return Boolean(sandbox.__TEST_CHINESE_EXECUTED__);
  };

  assert.equal(runInSandbox(false), false, 'ipcRenderer.sendSync 返回 false 时不得执行汉化注入');
  assert.equal(runInSandbox(undefined), false, 'ipcRenderer.sendSync 返回非 true 值时必须保持 fail-closed');
  assert.equal(runInSandbox(true), true, '仅当 ipcRenderer.sendSync 明确返回 true 时才允许执行汉化注入');
});
