'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  builtinAsar,
  resolveAsarTarget,
  computeAsarTargetKey
} = require('./asar-engine');
const { install } = require('./install');
const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
const { inspectHostRecoveryState } = require('./host-recovery');
const {
  buildLaunchAgentPlist,
  buildWatchArgs
} = require('./autostart');
const hostGuard = require('./host-guard');
const cli = require('./cli');
const liveHost = require('./live-host');
const settingsUi = require('./src/renderer/context-settings-ui');

const SAMPLE_V235_UTILS = `"use strict";
exports.loadHubWindowUrl = loadHubWindowUrl;
async function loadHubWindowUrl(win, targetUrl, options) {
    await win.loadURL(targetUrl);
}
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    const windowOptions = {
        titleBarStyle: 'hidden',
    };
    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;

const SAMPLE_BROKEN_ANCHOR_UTILS = `"use strict";
function setupNodeWrapper(env) { return env; }
function createWindow(url) {
    customUnknownLoader(url);
}
`;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createHostAsarFixture(dir, version, utilsSource = SAMPLE_V235_UTILS, filename = 'app.asar') {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `src-${version}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsSource, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n', 'utf8');
  const out = path.join(dir, filename);
  await builtinAsar.createPackage(src, out);
  fs.rmSync(src, { recursive: true, force: true });
  return out;
}

function makeExecStub(responses = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const key = `${file} ${args[0] || ''}`.trim();
    if (responses[key] !== undefined) {
      if (responses[key] instanceof Error) throw responses[key];
      return responses[key];
    }
    return '';
  };
  return { exec, calls };
}

test('Issue #109/#116: 统一目标解析器支持非默认盘/空格中文路径、显式路径严格防误命中、宿主迁移与多目标隔离', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-resolver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const customSpaceDir = path.join(root, 'F盘模拟 空格目录', 'Antigravity 中文版', 'resources');
  const secondDir = path.join(root, 'Second Install', 'resources');
  const asarA = await createHostAsarFixture(customSpaceDir, '2.35.1');
  const asarB = await createHostAsarFixture(secondDir, '2.35.2');

  // 1. 显式 --path 指向不存在路径时严格报错，绝不静默回退到其他目录
  const missingExplicit = resolveAsarTarget(path.join(root, 'not-exist', 'app.asar'), {
    stateDir,
    extraCandidates: [asarA, asarB]
  });
  assert.equal(missingExplicit.ok, false);
  assert.equal(missingExplicit.source, 'explicit_path');
  assert.equal(missingExplicit.asarPath, null);

  // 2. 显式传入包含空格和中文的目录，可自动定位 resources/app.asar
  const dirHit = resolveAsarTarget(path.dirname(customSpaceDir), { stateDir });
  assert.equal(dirHit.ok, true);
  assert.equal(dirHit.source, 'explicit_path');
  assert.equal(dirHit.asarPath, path.resolve(asarA));

  // 3. 在目标 A 和目标 B 分别安装，验证 installation.json 中按 targetKey 隔离记录互不串写
  await install({ path: asarA, stateDir, noHotInject: true, pureMeterOnly: true });
  await install({ path: asarB, stateDir, noHotInject: true, pureMeterOnly: true });

  const keyA = computeAsarTargetKey(asarA);
  const keyB = computeAsarTargetKey(asarB);
  assert.notEqual(keyA, keyB);
  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'installation.json'), 'utf8'));
  assert.equal(manifest.targets[keyA].version, '2.35.1');
  assert.equal(manifest.targets[keyB].version, '2.35.2');

  // 未传显式路径时优先命中已记录的自定义路径
  const fromManifest = resolveAsarTarget(null, { stateDir, platform: 'win32', localAppData: path.join(root, 'empty-local'), programFiles: path.join(root, 'empty-pf'), homeDir: path.join(root, 'empty-home') });
  assert.equal(fromManifest.ok, true);
  assert.equal(fromManifest.source, 'recorded_manifest');
  assert.equal(fromManifest.asarPath, path.resolve(asarB));

  // 4. 模拟宿主从原记录目录迁移到新目录：原记录失效并标记 recordedTargetMissing
  const migratedDir = path.join(root, 'Migrated Antigravity', 'resources');
  const asarMigrated = await createHostAsarFixture(migratedDir, '2.35.3');
  fs.rmSync(asarA, { force: true });
  fs.rmSync(asarB, { force: true });
  const migrated = resolveAsarTarget(null, {
    stateDir,
    platform: 'win32',
    localAppData: path.join(root, 'empty-local'),
    programFiles: path.join(root, 'empty-pf'),
    homeDir: path.join(root, 'empty-home'),
    extraCandidates: [asarMigrated]
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.recordedTargetMissing, true);
  assert.equal(migrated.source, 'migrated_candidate');
  assert.equal(migrated.asarPath, path.resolve(asarMigrated));
});

test('Issue #112 核心闭环: 跨版本覆盖 + 慢写去抖 + 文件暂缺 + 同版官方修复 + 新版纯净备份不回写旧盘', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-recover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.1');

  // 预设用户配置：仅开启 meter + proxy，chinese 保持关闭，验证恢复后严格保留且不擅自开启未启用模块
  const cfg = loadModulesConfig({ stateDir });
  cfg.modules.meter.enabled = true;
  cfg.modules.proxy.enabled = true;
  cfg.modules.proxy.proxyUrl = 'http://127.0.0.1:7897';
  cfg.modules.chinese.enabled = false;
  saveModulesConfig(cfg, { stateDir });

  await install({ path: activeAsar, stateDir, noHotInject: true });
  const clean2351Backup = path.join(stateDir, 'backups', `app-2.35.1-${computeAsarTargetKey(activeAsar)}-base.asar`);
  assert.equal(fs.existsSync(clean2351Backup), true);
  const sha2351Clean = sha256(clean2351Backup);

  const tracker = hostGuard.createGuardTracker();

  // 阶段 1: 模拟官方更新器短暂移除 app.asar（更新进行中）
  const tempStash = path.join(root, 'stash.asar');
  fs.renameSync(activeAsar, tempStash);
  const tickMissing = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 2,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(tickMissing.action, 'wait_update_stable');
  assert.equal(tickMissing.status, 'waiting_host_update_stable');
  assert.equal(fs.existsSync(activeAsar), false, '更新过程中不得用旧备份覆盖回去');

  // 阶段 2: 官方写入新版 2.35.2 纯净 ASAR（首次观测触发去抖等待，不急于抢写）
  await createHostAsarFixture(hostDir, '2.35.2');
  const sha2352Clean = sha256(activeAsar);
  const tickDebounce = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 2,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(tickDebounce.action, 'wait_debounce');
  assert.equal(sha256(activeAsar), sha2352Clean, '去抖未稳定前不得提前写入');

  // 阶段 3: 第二次观测文件稳定 -> 自动备份新版 2.35.2 基底并恢复已启用模块
  const tickRecover = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 2,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(tickRecover.ok, true);
  assert.equal(tickRecover.action, 'recovered');
  assert.equal(tickRecover.lastRecovery.hostVersion, '2.35.2');
  assert.equal(tickRecover.lastRecovery.fromState, 'overwritten_by_host_update');

  // 确认保留了 2.35.1 旧基底并新增了 2.35.2 新基底，且当前磁盘宿主确为 2.35.2（绝未回写旧宿主）
  const clean2352Backup = path.join(stateDir, 'backups', `app-2.35.2-${computeAsarTargetKey(activeAsar)}-base.asar`);
  assert.equal(fs.existsSync(clean2352Backup), true);
  assert.equal(sha256(clean2352Backup), sha2352Clean);
  assert.equal(sha256(clean2351Backup), sha2351Clean);

  const postInspect = inspectHostRecoveryState({ asarPath: activeAsar, stateDir });
  assert.equal(postInspect.state, 'healthy');
  assert.equal(postInspect.hostVersion, '2.35.2');
  assert.equal(postInspect.disk.meterReady, true);
  assert.equal(postInspect.disk.proxyReady, true);
  assert.equal(postInspect.savedModules.chinese, false, '未启用模块不得自行开启');
  const worktreeRendererBuild = sha256(path.join(__dirname, 'meter-renderer.js')).slice(0, 16);
  assert.equal(postInspect.diskRendererBuildId, worktreeRendererBuild);

  // 阶段 4: 再次轮询保持幂等 healthy
  const tickHealthy = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 2,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(tickHealthy.action, 'healthy');

  // 阶段 5: 同版本官方修复安装覆写（2.35.2 -> 2.35.2 纯净包）
  await createHostAsarFixture(hostDir, '2.35.2');
  // 修改一下 mtime 确保签名变化
  const futureTime = new Date(Date.now() + 5000);
  fs.utimesSync(activeAsar, futureTime, futureTime);
  const repairPre = inspectHostRecoveryState({ asarPath: activeAsar, stateDir });
  assert.equal(repairPre.state, 'overwritten_by_host_update');
  assert.equal(repairPre.reason, 'host_repaired_same_version_without_plugin');

  const repairTick = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(repairTick.ok, true);
  assert.equal(repairTick.action, 'recovered');
  assert.equal(inspectHostRecoveryState({ asarPath: activeAsar, stateDir }).state, 'healthy');
});

test('官方更新器先启动新版宿主与用户关闭保持关闭: 运行态安全延迟、退出后补做恢复且不自启', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-defer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.1');
  await install({ path: activeAsar, stateDir, noHotInject: true, pureMeterOnly: true });

  // 官方更新覆写为 2.35.2，同时官方更新器已先拉起 Antigravity 进程
  await createHostAsarFixture(hostDir, '2.35.2');
  const clean2352Sha = sha256(activeAsar);
  const tracker = hostGuard.createGuardTracker();
  let hostRunning = true;

  const tickWhileRunning = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker,
    _isHostRunning: async () => hostRunning
  });
  assert.equal(tickWhileRunning.action, 'defer_until_host_exit');
  assert.equal(tickWhileRunning.status, 'waiting_host_exit_for_recovery');
  assert.equal(sha256(activeAsar), clean2352Sha, '宿主运行中绝不可抢改 app.asar');

  // 用户正常退出 Antigravity -> 守护在下一次检测安全补做磁盘恢复，并保持关闭状态（不拉起宿主）
  hostRunning = false;
  const tickAfterExit = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker,
    _isHostRunning: async () => hostRunning
  });
  assert.equal(tickAfterExit.ok, true);
  assert.equal(tickAfterExit.action, 'recovered');
  assert.equal(tickAfterExit.status, 'host_closed_by_user');
  assert.equal(inspectHostRecoveryState({ asarPath: activeAsar, stateDir }).state, 'healthy');

  // 锁冲突场景 (EBUSY) 同样优雅延迟不报错
  await createHostAsarFixture(hostDir, '2.35.3');
  const tickLocked = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker: hostGuard.createGuardTracker(),
    _isHostRunning: async () => false,
    _recoverHost: async () => ({ ok: false, action: 'locked', reason: 'host_asar_locked' })
  });
  assert.equal(tickLocked.action, 'locked_deferred');
  assert.equal(tickLocked.status, 'waiting_host_exit_for_recovery');
});

test('未知锚点拦截、写盘异常回滚、同一坏包去重只处置一次且原包零改动', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-block-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.1');
  await install({ path: activeAsar, stateDir, noHotInject: true, pureMeterOnly: true });

  // 覆盖为一个未知锚点版本 2.99.0
  await createHostAsarFixture(hostDir, '2.99.0', SAMPLE_BROKEN_ANCHOR_UTILS);
  const badSha = sha256(activeAsar);
  const tracker = hostGuard.createGuardTracker();

  const first = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker,
    _isHostRunning: async () => false
  });
  assert.equal(first.action, 'blocked');
  assert.equal(first.status, 'unknown_anchor_blocked');
  assert.equal(sha256(activeAsar), badSha, '未知锚点拦截必须保持原包一字节不变');

  // 恢复过程抛异常（模拟快照回滚）并验证同一覆盖哈希只处置一次
  await createHostAsarFixture(hostDir, '2.35.4');
  let recoverCalls = 0;
  const tracker2 = hostGuard.createGuardTracker();
  const r1 = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker: tracker2,
    _isHostRunning: async () => false,
    _recoverHost: async () => {
      recoverCalls++;
      throw new Error('Installed checksum mismatch; 已自动回滚');
    }
  });
  assert.equal(r1.status, 'rolled_back');
  assert.equal(recoverCalls, 1);

  const r2 = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: activeAsar,
    platform: 'win32',
    debounceStableChecks: 1,
    tracker: tracker2,
    _isHostRunning: async () => false,
    _recoverHost: async () => {
      recoverCalls++;
      throw new Error('should not be called again for same sha');
    }
  });
  assert.equal(r2.action, 'deduped_already_handled');
  assert.equal(recoverCalls, 1, '同一覆盖事件只处置一次，不无限死循环');
});

test('一次性启用、无窗 VBS 稳定路径注册、升级保持设置、停用卸载全清理与旧配置迁移', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-life-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.2');

  // 模拟旧版无 hostGuard 字段的 modules.json，升级后平滑迁移为默认关闭且不擅自注册
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'modules.json'), JSON.stringify({
    schemaVersion: '0.8.8',
    modules: { meter: { enabled: true }, chinese: { enabled: false, language: 'en' }, proxy: { enabled: false } }
  }), 'utf8');
  const migratedCfg = loadModulesConfig({ stateDir });
  assert.equal(migratedCfg.modules.hostGuard.enabled, false);

  const upgradeWhileDisabled = await hostGuard.refreshHostGuardAfterUpgrade({ stateDir, platform: 'win32' });
  assert.equal(upgradeWhileDisabled.action, 'skipped_not_enabled');

  // 启用 Windows 常驻守护：验证写入 live-runtime 稳定运行包与无窗 VBS 启动器
  const { exec, calls } = makeExecStub({ 'reg query': new Error('not found') });
  let spawnedArgs = null;
  const enabled = await hostGuard.enableHostGuard({
    stateDir,
    asarPath: activeAsar,
    platform: 'win32',
    exec,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    _spawnDaemon: (nodeExe, args) => {
      spawnedArgs = [nodeExe, ...args];
      return 43210;
    }
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.runtime.isStableRuntime, true);
  assert.ok(enabled.runtime.cliPath.includes(path.join('live-runtime', 'cli.js')), '必须指向宿主更新不会覆盖的 live-runtime 稳定目录');
  assert.ok(fs.existsSync(path.join(stateDir, hostGuard.WINDOWS_SILENT_LAUNCHER_NAME)), 'Windows 应生成无窗 VBS 启动器');
  const vbsText = fs.readFileSync(path.join(stateDir, hostGuard.WINDOWS_SILENT_LAUNCHER_NAME), 'utf8');
  assert.match(vbsText, /shell\.Run cmd, 0, False/);
  assert.ok(vbsText.includes('--persistent') && vbsText.includes('--no-launch'));
  const regAdd = calls.find(c => c[0] === 'reg' && c[1] === 'add');
  assert.ok(regAdd && regAdd.some(a => /wscript\.exe \/\/B \/\/NoLogo/i.test(a)));
  assert.ok(spawnedArgs && spawnedArgs.includes('--persistent'));

  // 升级后保持启用设置
  const upgraded = await hostGuard.refreshHostGuardAfterUpgrade({
    stateDir,
    platform: 'win32',
    exec,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    _spawnDaemon: () => 43211
  });
  assert.equal(upgraded.ok, true);
  assert.equal(loadModulesConfig({ stateDir }).modules.hostGuard.enabled, true);

  // 停用清理：配置置 false、移除 VBS、删除 Run 键
  const { exec: execDisable, calls: disableCalls } = makeExecStub({
    'reg query': 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    AntigravityContextMeter    REG_SZ    wscript.exe //B //NoLogo "x.vbs"\r\n'
  });
  const disabled = await hostGuard.disableHostGuard({
    stateDir,
    asarPath: activeAsar,
    platform: 'win32',
    exec: execDisable
  });
  assert.equal(disabled.ok, true);
  assert.equal(loadModulesConfig({ stateDir }).modules.hostGuard.enabled, false);
  assert.equal(fs.existsSync(path.join(stateDir, hostGuard.WINDOWS_SILENT_LAUNCHER_NAME)), false);
  assert.ok(disableCalls.some(c => c[0] === 'reg' && c[1] === 'delete'));
});

test('常驻 watch 生命周期、单实例锁先于恢复（零并行竞争）与 macOS 官方签名零改盘边界', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.2');
  const pkgVer = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

  // 1. 常驻模式：窗口关闭 -> 保持驻留不退出 -> 窗口再次出现自动重新挂载
  let cycle = 0;
  let injectCalls = 0;
  const watchRes = await cli.runWatchDaemon({
    stateDir,
    customPath: activeAsar,
    persistent: true,
    platform: 'win32',
    silent: true,
    handleSignals: false,
    pollIntervalMs: 5,
    maxConsecutiveMisses: 1,
    maxCycles: 4,
    debounceStableChecks: 1,
    _isHostRunning: async () => cycle !== 2,
    _discoverWindow: async () => {
      cycle++;
      if (cycle === 1 || cycle === 4) {
        return {
          running: true,
          pageFound: true,
          active: false,
          version: null,
          hasIpcBridge: false,
          origin: 'http://127.0.0.1:52001',
          origins: ['http://127.0.0.1:52001']
        };
      }
      return { running: false, pageFound: false };
    },
    _ensureBridge: async (live) => ({
      ready: true,
      reused: true,
      backendSource: 'live-host',
      backendVersion: pkgVer,
      liveInfo: { pid: process.pid, port: 55001, token: 'tok', version: pkgVer, origins: live.origins }
    }),
    _hotInject: async () => {
      injectCalls++;
      return { ok: true, injectedCount: 1, windowCount: 1, backendVersion: pkgVer, backendSource: 'live-host' };
    }
  });
  assert.equal(watchRes.ok, true);
  assert.equal(watchRes.persistent, true);
  assert.equal(watchRes.exitReason, 'max_cycles', '常驻模式在窗口关闭后不得以 window_closed 退出');
  assert.equal(injectCalls, 2, '初次出现与重开后各自动挂载一次');

  // 2. 单实例锁先于恢复：已有存活同版进程持锁时，新实例立即退出不并发执行恢复
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  const targetKey = computeAsarTargetKey(activeAsar);
  const bundleBuildId = cli.getWatchBundleBuildId(__dirname);
  hostGuard.writeTargetGuardLock(stateDir, targetKey, {
    pid: holder.pid,
    targetPath: activeAsar,
    mode: 'persistent',
    script: path.join(__dirname, 'cli.js'),
    version: pkgVer,
    buildId: bundleBuildId
  });
  let recoverInvoked = false;
  const dupRes = await cli.runWatchDaemon({
    stateDir,
    customPath: activeAsar,
    persistent: true,
    silent: true,
    handleSignals: false,
    maxCycles: 1,
    pollIntervalMs: 5,
    expectedBuildId: bundleBuildId,
    requireWatchMeta: false,
    _recoverHost: async () => { recoverInvoked = true; return { ok: true }; }
  });
  assert.equal(dupRes.alreadyRunning, true);
  assert.equal(dupRes.pid, holder.pid);
  assert.equal(recoverInvoked, false, '持锁失败的新实例绝不能在拿锁前并发触发恢复');

  // 3. macOS 官方签名保护：app.asar 逐字节不变、LaunchAgent 启用 KeepAlive=true 且直接启动命令带 --remote-debugging-port
  const macAppDir = path.join(root, 'Antigravity.app', 'Contents', 'Resources');
  const macAsar = await createHostAsarFixture(macAppDir, '2.35.2');
  fs.writeFileSync(path.join(root, 'Antigravity.app', 'Contents', 'Info.plist'), '<plist><dict><key>ElectronAsarIntegrity</key><dict></dict></dict></plist>');
  const macShaBefore = sha256(macAsar);
  const macTick = await hostGuard.evaluateGuardTick({
    stateDir: path.join(root, 'mac-state'),
    customPath: macAsar,
    platform: 'darwin',
    debounceStableChecks: 1,
    _isHostRunning: async () => false,
    _inspectRecovery: () => ({
      state: 'overwritten_by_host_update',
      hostVersion: '2.35.2',
      asarPath: macAsar,
      asarSha256: macShaBefore,
      preflight: { ok: false, blocked: true, reason: 'macos_asar_integrity_blocked' }
    })
  });
  assert.equal(macTick.action, 'live_only_protected');
  assert.equal(macTick.status, 'macos_signature_protected');
  assert.equal(sha256(macAsar), macShaBefore, 'macOS 必须保持官方 app.asar 零改动');

  const macPlist = buildLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/test/live-runtime/cli.js',
    persistent: true,
    noLaunch: true,
    silent: true,
    homeDir: '/Users/test'
  });
  assert.match(macPlist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(macPlist, /<string>--persistent<\/string>/);
  assert.match(macPlist, /<string>--no-launch<\/string>/);
  assert.deepEqual(buildWatchArgs({ scriptPath: '/a/cli.js', persistent: true, noLaunch: true }), ['/a/cli.js', 'watch', '--persistent', '--no-launch']);
  assert.match(cli.formatDirectMacCdpLaunchCommand({ execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' }, 58321), /Contents\/MacOS\/Antigravity" --remote-debugging-port=58321$/);
});

test('宿主设置页集成、live-host 路由与新增三语可见文案零括号校验', () => {
  // 1. live-host 路由与能力表对齐
  assert.equal(liveHost.ALLOWED_ROUTES.includes('/host-guard-status'), true);
  assert.equal(liveHost.ALLOWED_ROUTES.includes('/host-guard-action'), true);
  assert.equal(liveHost.LIVE_CAPABILITIES.hostGuard, true);

  // 2. 宿主设置页 DOM 节点与文案
  const html = settingsUi.buildNativeSettingsPageHtml();
  assert.ok(html.includes('id="ag-ns-sw-hostGuardEnabled"'));
  assert.ok(html.includes('id="ag-ns-host-guard-badge"'));
  assert.ok(html.includes('id="ag-ns-btn-host-guard-check"'));
  assert.ok(html.includes('id="ag-ns-btn-host-guard-recover"'));

  // 3. 新增全部 ns.hostGuard.* 三语文案严格零中英文括号
  const i18nRaw = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
  const lines = i18nRaw.split(/\r?\n/).filter(l => l.includes("'ns.hostGuard."));
  assert.ok(lines.length >= 16, '应完整定义三语 ns.hostGuard.* 词条');
  for (const line of lines) {
    assert.equal(/[()（）]/.test(line), false, `三语文案禁止包含中英文括号: ${line}`);
  }
});

test('测试隔离与配置漂移防护: configPath 仅写临时文件、非隔离写入被拦截、disabled_drift 精确上报并可清理', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-isolation-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. configPath 参数必须真实写入目标临时路径且支持读写不同值
  const customCfgPath = path.join(root, 'nested', 'custom-modules.json');
  const modCfg = require('./modules-config');
  const draft = JSON.parse(JSON.stringify(modCfg.DEFAULT_CONFIG));
  draft.modules.proxy.enabled = true;
  draft.modules.hostGuard.enabled = true;
  modCfg.saveModulesConfig(draft, { configPath: customCfgPath });
  assert.equal(fs.existsSync(customCfgPath), true);
  const loaded = modCfg.loadModulesConfig({ configPath: customCfgPath });
  assert.equal(loaded.modules.proxy.enabled, true);
  assert.equal(loaded.modules.hostGuard.enabled, true);

  // 2. AG_METER_TEST_MODE=1 下企图写入非隔离路径或真实注册表时硬拦截
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  delete process.env.AG_METER_STATE_DIR;
  try {
    assert.throws(
      () => modCfg.saveModulesConfig(draft),
      /测试模式禁止写入非隔离模块配置路径/
    );
    await assert.rejects(
      () => require('./autostart').enableAutostart({ platform: 'win32', nodePath: 'C:\\node.exe', scriptPath: 'C:\\cli.js' }),
      /必须提供 exec 注册表 stub/
    );
    await assert.rejects(
      () => hostGuard.enableHostGuard({ platform: 'win32' }),
      /测试模式禁止在非隔离目录启用常驻守护/
    );
  } finally {
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
  }

  // 3. 配置写已关闭但遗留存活守护进程、VBS 与 Run 键时，必须上报 configDrift=true 与 status=disabled_drift
  const stateDir = path.join(root, 'drift-state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.2');
  await install({ path: activeAsar, stateDir, noHotInject: true, pureMeterOnly: true });

  const cfgOff = loadModulesConfig({ stateDir });
  cfgOff.modules.hostGuard.enabled = false;
  saveModulesConfig(cfgOff, { stateDir });

  const targetKey = computeAsarTargetKey(activeAsar);
  hostGuard.writeTargetGuardLock(stateDir, targetKey, {
    pid: process.pid,
    targetPath: activeAsar,
    mode: 'persistent'
  });
  fs.writeFileSync(path.join(stateDir, hostGuard.WINDOWS_SILENT_LAUNCHER_NAME), "' stub\r\n", 'utf8');

  const { exec: execWithRun } = makeExecStub({
    'reg query': 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    AntigravityContextMeter    REG_SZ    wscript.exe //B //NoLogo "stub.vbs"\r\n'
  });
  const driftOverview = hostGuard.getHostGuardOverview({
    stateDir,
    asarPath: activeAsar,
    platform: 'win32',
    exec: execWithRun
  });
  assert.equal(driftOverview.enabled, false);
  assert.equal(driftOverview.configDrift, true);
  assert.equal(driftOverview.status, 'disabled_drift');
  assert.ok(driftOverview.driftReasons.includes('daemon_running_while_disabled'));
  assert.ok(driftOverview.driftReasons.includes('autostart_registered_while_disabled'));
  assert.ok(driftOverview.driftReasons.includes('silent_launcher_leftover'));

  // 停用清理后（锁清除、VBS 移除、Run 键删除）漂移归零
  const { exec: execAfterDisable } = makeExecStub({ 'reg query': new Error('not found') });
  let regDeleted = false;
  const execDisable = (file, args) => {
    if (file === 'reg' && args[0] === 'query' && !regDeleted) {
      return 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    AntigravityContextMeter    REG_SZ    wscript.exe //B //NoLogo "stub.vbs"\r\n';
    }
    if (file === 'reg' && args[0] === 'delete') {
      regDeleted = true;
      return '';
    }
    throw new Error('not found');
  };
  await hostGuard.disableHostGuard({
    stateDir,
    asarPath: activeAsar,
    platform: 'win32',
    exec: execDisable
  });
  const cleanOverview = hostGuard.getHostGuardOverview({
    stateDir,
    asarPath: activeAsar,
    platform: 'win32',
    exec: execAfterDisable
  });
  assert.equal(cleanOverview.enabled, false);
  assert.equal(cleanOverview.configDrift, false);
  assert.equal(cleanOverview.status, 'disabled');
});

test('04 补缺 1: 卸载还原后不再被 host-recovery/host-guard 误判恢复，多目标隔离还原与重装后恢复链路闭环', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const dirA = path.join(root, 'Target A', 'resources');
  const dirB = path.join(root, 'Target B', 'resources');
  const asarA = await createHostAsarFixture(dirA, '2.35.1');
  const asarB = await createHostAsarFixture(dirB, '2.35.2');
  const origShaA = sha256(asarA);
  const origShaB = sha256(asarB);

  const { restore } = require('./restore');

  // 1. 分别安装到 A 和 B（多目标隔离）
  await install({ path: asarA, stateDir, noHotInject: true, pureMeterOnly: true });
  await install({ path: asarB, stateDir, noHotInject: true, pureMeterOnly: true });

  // 2. 单独卸载目标 A（非 top-level 目标），验证多目标 targets[keyA] 精确还原且不伤及 B
  const resA = await restore({ path: asarA, stateDir });
  assert.equal(path.resolve(resA.restored), path.resolve(asarA));
  assert.equal(sha256(asarA), origShaA, '目标 A 必须逐字节恢复官方原版');
  assert.equal(inspectHostRecoveryState({ asarPath: asarB, stateDir }).state, 'healthy', '目标 B 保持健康不受影响');

  // 3. 卸载后即使 backups 目录仍留存原版备份，host-recovery 与 host-guard 绝不能将已卸载目标误判为 overwritten_by_host_update
  const afterUninstallA = inspectHostRecoveryState({ asarPath: asarA, stateDir });
  assert.equal(afterUninstallA.state, 'not_installed');
  assert.equal(afterUninstallA.reason, 'uninstalled_by_user');
  assert.equal(afterUninstallA.needsRecovery, false);

  const guardTickA = await hostGuard.evaluateGuardTick({
    stateDir,
    customPath: asarA,
    platform: 'win32',
    debounceStableChecks: 1,
    _isHostRunning: async () => false
  });
  assert.equal(guardTickA.action, 'noop_not_installed');
  assert.equal(sha256(asarA), origShaA, '卸载后常驻守护不得自动把插件装回去');

  // 4. 用户重新安装到 A 后清除 uninstalled 标记，此后官方覆盖升级恢复再次正常触发
  await install({ path: asarA, stateDir, noHotInject: true, pureMeterOnly: true });
  await createHostAsarFixture(dirA, '2.35.3');
  const afterReinstallOverwrite = inspectHostRecoveryState({ asarPath: asarA, stateDir });
  assert.equal(afterReinstallOverwrite.state, 'overwritten_by_host_update');
  assert.equal(afterReinstallOverwrite.needsRecovery, true);
});

test('04 补缺 2: Windows 无窗 VBS 启动器对空格与中文路径使用纯 ASCII ChrW 编码防乱码', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-vbs-cn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, '状态目录 Space');
  const targetPath = path.join(root, 'F盘模拟 空格', 'Antigravity 中文版', 'resources', 'app.asar');
  const out = hostGuard.ensureWindowsSilentLauncher({
    stateDir,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: path.join(stateDir, 'live-runtime', 'cli.js'),
    targetPath
  });
  const vbsRaw = fs.readFileSync(out.vbsPath, 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(vbsRaw), false, 'VBS 文件必须保持纯 ASCII，避免 ANSI 代码页乱码');
  assert.match(vbsRaw, /ChrW\(\d+\)/, '中文路径必须通过 ChrW() 安全编码');
  assert.match(vbsRaw, /shell\.Run cmd, 0, False/);
  assert.ok(vbsRaw.includes('--persistent') && vbsRaw.includes('--no-launch'));

  // 解析还原 cmd = ... 表达式，核对与原始 Unicode cmdLine 完全一致
  const cmdLineMatch = vbsRaw.match(/^cmd = (.+)$/m);
  assert.ok(cmdLineMatch, '应包含 cmd 赋值行');
  const decoded = cmdLineMatch[1]
    .split(/\s*&\s*/)
    .map(part => {
      const chrw = part.match(/^ChrW\((\d+)\)$/);
      if (chrw) return String.fromCharCode(Number(chrw[1]));
      return part.slice(1, -1).replace(/""/g, '"');
    })
    .join('');
  assert.equal(decoded, out.cmdLine, 'VBScript 运行时求值结果必须逐字符还原原始中文与空格路径');
});

test('04 补缺 3: 升级、常驻守护、零窗口与重开不唤醒已停的缓存保活、自动切号或远端直连', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-guard-nowake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const hostDir = path.join(root, 'Antigravity', 'resources');
  const activeAsar = await createHostAsarFixture(hostDir, '2.35.1');
  await install({ path: activeAsar, stateDir, noHotInject: true, pureMeterOnly: true });

  // 写入旧版 accounts_v1.json（含 enabled: true 的旧 autoSwitch 与 keepalive 配置）
  const { createAccountsManager, dispatchAccountsAction } = require('./meter-accounts');
  let remoteFetchCalls = 0;
  const acctMgr = createAccountsManager({
    stateDir,
    fetchFn: async () => {
      remoteFetchCalls++;
      throw new Error('不应发起任何远端请求');
    }
  });
  const st = acctMgr.loadStore();
  st.autoSwitch = { ...(st.autoSwitch || {}), enabled: true, thresholdPct: 20 };
  st.keepalive = { ...(st.keepalive || {}), enabled: true, experimentApproved: false, targetAccountEmail: 'a@example.com', targetSessionId: 's1', targetModelId: 'm1' };
  acctMgr.saveStore(st);

  // 1. 模拟官方覆盖升级 -> 自动恢复 -> 零窗口驻留 -> 重开，期间远端发包数为 0
  await createHostAsarFixture(hostDir, '2.35.2');
  const watchRes = await cli.runWatchDaemon({
    stateDir,
    customPath: activeAsar,
    persistent: true,
    platform: 'win32',
    silent: true,
    handleSignals: false,
    pollIntervalMs: 5,
    maxConsecutiveMisses: 1,
    maxCycles: 3,
    debounceStableChecks: 1,
    _isHostRunning: async () => false,
    _discoverWindow: async () => ({ running: false, pageFound: false })
  });
  assert.equal(watchRes.ok, true);
  assert.equal(watchRes.guardRecoveryCount, 1);
  assert.equal(remoteFetchCalls, 0, '常驻守护、恢复与零窗口轮询不得产生任何远端业务发包');

  // 2. 验证消费版生产门禁拦截保活开启与评估
  const prodBlock = await dispatchAccountsAction(acctMgr, { action: 'update_keepalive', config: { enabled: true } });
  assert.equal(prodBlock.ok, false);
  assert.equal(prodBlock.reason, 'consumer_keepalive_disabled');
  const tickRes = await acctMgr.evaluateKeepaliveTick({ productionGuard: true });
  assert.equal(tickRes.ok, false);
  assert.equal(tickRes.reason, 'consumer_keepalive_disabled');
  assert.equal(acctMgr.loadStore().keepaliveState?.running, false);
  assert.equal(remoteFetchCalls, 0);
});

test('PR #137 (Issues #109 & #116): 非默认盘/中文空格/Mac .app 规范化、.unpacked fallbackAsarPath 透传、注册表/进程兜底与显式路径优先', async (t) => {
  const {
    builtinAsar,
    normalizeAsarPathCandidate,
    getSavedCustomAsarPath,
    probeInstalledAsarPaths,
    saveConfiguredCustomAsarPath,
    clearConfiguredCustomAsarPath,
    findAsarPath
  } = require('./asar-engine');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pr137-path-'));
  const prevAgAsar = process.env.AG_ASAR_PATH;
  delete process.env.AG_ASAR_PATH;
  t.after(() => {
    if (prevAgAsar === undefined) delete process.env.AG_ASAR_PATH;
    else process.env.AG_ASAR_PATH = prevAgAsar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. 构造非默认盘 + 中文/空格目录及 .asar.unpacked
  const customRoot = path.join(tmpDir, 'F盘 Apps', 'Antigravity 中文版');
  const customRes = path.join(customRoot, 'resources');
  const customUnpacked = path.join(customRes, 'app.asar.unpacked', 'node_modules', 'native.txt');
  fs.mkdirSync(path.dirname(customUnpacked), { recursive: true });
  fs.writeFileSync(customUnpacked, 'NATIVE_UNPACKED_OK', 'utf8');
  const fakeExe = path.join(customRoot, 'Antigravity.exe');
  fs.writeFileSync(fakeExe, 'stub', 'utf8');

  const packSrc = path.join(tmpDir, 'pack-src');
  fs.mkdirSync(path.join(packSrc, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(packSrc, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packSrc, 'package.json'), '{"name":"antigravity","version":"2.35.2"}', 'utf8');
  fs.writeFileSync(path.join(packSrc, 'dist', 'utils.js'), 'function setupNodeWrapper(env){}\nfunction createWindow(url){void win.loadURL(url);}\n', 'utf8');
  fs.writeFileSync(path.join(packSrc, 'node_modules', 'native.txt'), 'NATIVE_UNPACKED_OK', 'utf8');
  const customAsar = path.join(customRes, 'app.asar');
  await builtinAsar.createPackageWithOptions(packSrc, customAsar, {
    unpackedPaths: new Set(['node_modules/native.txt'])
  });

  // 备份目录独立存放，测试 .unpacked 透传 fallbackAsarPath
  const bakDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakAsar = path.join(bakDir, 'app.asar.bak');
  fs.copyFileSync(customAsar, bakAsar);

  assert.equal(normalizeAsarPathCandidate(customRoot), customAsar);
  assert.equal(normalizeAsarPathCandidate(customRes), customAsar);
  assert.equal(normalizeAsarPathCandidate(fakeExe), customAsar);
  assert.equal(normalizeAsarPathCandidate(`"${fakeExe}",0`), customAsar, '应剥离 Windows 注册表 DisplayIcon 引号与图标索引');
  assert.equal(normalizeAsarPathCandidate(customAsar), customAsar);
  assert.equal(normalizeAsarPathCandidate(path.join(tmpDir, 'missing-dir')), null);

  // macOS .app 路径规范化
  const macApp = path.join(tmpDir, 'Applications Custom', 'Antigravity.app');
  const macAsar = path.join(macApp, 'Contents', 'Resources', 'app.asar');
  fs.mkdirSync(path.dirname(macAsar), { recursive: true });
  fs.copyFileSync(customAsar, macAsar);
  assert.equal(normalizeAsarPathCandidate(macApp), macAsar);

  // 2. .unpacked 透传 fallbackAsarPath
  const extractedViaOpt = builtinAsar.extractFile(bakAsar, 'node_modules/native.txt', { fallbackAsarPath: customAsar });
  assert.equal(extractedViaOpt.toString('utf8'), 'NATIVE_UNPACKED_OK');

  // 3. 系统进程/注册表兜底探测
  const emptyHome = path.join(tmpDir, 'empty-home');
  const emptyState = path.join(tmpDir, 'empty-state');
  fs.mkdirSync(emptyHome, { recursive: true });
  fs.mkdirSync(emptyState, { recursive: true });
  const probedPath = probeInstalledAsarPaths({ _probeSystemPaths: () => [`"${fakeExe}",0`] });
  assert.equal(probedPath, customAsar);
  const foundViaProbe = findAsarPath(null, {
    homeDir: emptyHome,
    stateDir: emptyState,
    agDir: emptyHome,
    platform: 'linux',
    useElectronSelf: false,
    _probeSystemPaths: () => [customRoot]
  });
  assert.equal(foundViaProbe, customAsar);

  // 4. 持久化重开回读 + 显式路径优先于已保存自定义路径
  const saved = saveConfiguredCustomAsarPath(customRoot, { stateDir: emptyState });
  assert.equal(saved.ok, true);
  assert.equal(getSavedCustomAsarPath({ stateDir: emptyState, agDir: emptyHome }), customAsar);
  assert.equal(
    findAsarPath(null, { homeDir: emptyHome, stateDir: emptyState, agDir: emptyHome, platform: 'linux', useElectronSelf: false, disableSystemProbe: true }),
    customAsar
  );
  assert.equal(
    findAsarPath(macApp, { homeDir: emptyHome, stateDir: emptyState, agDir: emptyHome, platform: 'darwin', useElectronSelf: false, disableSystemProbe: true }),
    macAsar,
    '显式路径必须优先于已保存的自定义路径'
  );
  clearConfiguredCustomAsarPath({ stateDir: emptyState });
  assert.equal(getSavedCustomAsarPath({ stateDir: emptyState, agDir: emptyHome }), null);
});
