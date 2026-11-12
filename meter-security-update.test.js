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
  const src = path.join(dir, `mock-src-${version}`);
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

  const asarPath = path.join(dir, `app-${version}.asar`);
  await builtinAsar.createPackageWithOptions(src, asarPath, {});
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

    // 3. 运行 restore：必须能够自愈并将文件完整还原为官方原版！
    const res = await restore({ path: targetAsar });
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '必须成功还原为官方纯净原版');
    assert.equal(res.restored, targetAsar);

    // 4. 重复卸载：幂等返回 alreadyRestored
    const res2 = await restore({ path: targetAsar });
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
