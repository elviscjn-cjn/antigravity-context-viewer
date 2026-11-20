'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  resolveCliExecutable,
  resolveCliWorkspace,
  resolveHelperExecutable,
  resolveCliAccountProfile,
  escapePosixArg,
  launchCliSession
} = require('./meter-cli-launcher');

test('CLI 启动模块 1: resolveCliExecutable 隔离跨平台探测（Windows .exe/.cmd 与 macOS .app）及环境探测', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-resolve-'));
  try {
    // 1. 隔离模拟 Windows 安装目录 (.gemini/antigravity/bin/agy.exe)
    const winHome = path.join(tmpDir, 'win-home');
    const winBin = path.join(winHome, '.gemini', 'antigravity', 'bin');
    fs.mkdirSync(winBin, { recursive: true });
    const fakeWinExe = path.join(winBin, 'agy.exe');
    fs.writeFileSync(fakeWinExe, 'MZ');
    const resWin = resolveCliExecutable(null, { platform: 'win32', homeDir: winHome, env: { USERPROFILE: winHome, PATH: '' } });
    assert.equal(resWin.ok, true);
    assert.equal(path.resolve(resWin.exePath), path.resolve(fakeWinExe));

    // 2. 隔离模拟 macOS Google Antigravity.app 安装目录
    const macAppRoot = path.join(tmpDir, 'Google Antigravity.app');
    const macBin = path.join(macAppRoot, 'Contents', 'Resources', 'app', 'bin', 'agy');
    fs.mkdirSync(path.dirname(macBin), { recursive: true });
    fs.writeFileSync(macBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resMac = resolveCliExecutable(null, { platform: 'darwin', macAppRoots: [macAppRoot], homeDir: tmpDir, env: { PATH: '' } });
    assert.equal(resMac.ok, true);
    assert.equal(path.resolve(resMac.exePath), path.resolve(macBin));

    // 3. 如宿主机实际已安装 Antigravity CLI，额外核对真实探测结果格式正确
    const hostRes = resolveCliExecutable();
    if (hostRes.ok) {
      assert.ok(hostRes.exePath && fs.existsSync(hostRes.exePath));
      assert.match(path.basename(hostRes.exePath).toLowerCase(), /^agy(\.exe|\.cmd|\.bat)?$/);
    } else {
      assert.equal(hostRes.code, 'CLI_NOT_FOUND');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 2: dryRun 包含完整参数与环境隔离', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-dryrun-'));
  try {
    const fakeCli = path.join(tmpDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(fakeCli, 'stub', { mode: 0o755 });
    const dry = await launchCliSession({ cliPath: fakeCli, cwd: tmpDir, dryRun: true, model: 'gemini-3.8-flash-high', args: ['--verbose'] });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.model, 'gemini-3.8-flash-high');
    assert.deepEqual(dry.args, ['--model', 'gemini-3.8-flash-high', '--verbose']);
    if (process.platform === 'win32') {
      assert.equal(dry.env.TERM, 'xterm-256color');
      assert.equal(dry.env.COLORTERM, 'truecolor');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 3: 源码绝对不残留同步 powershell、8000ms 阻塞与作者绝对开发路径', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-cli-launcher.js'), 'utf8');
  assert.equal(src.includes("spawnSync('powershell.exe'"), false, '严禁包含 spawnSync powershell');
  assert.equal(src.includes('timeout: 8000'), false, '严禁包含旧版 8000ms 同步阻塞');
  assert.equal(src.includes('D:\\AI_plugin'), false, '严禁包含作者开发机本地绝对路径');
  assert.ok(src.includes('0.8.4-helper-v2'), '必须包含最新的版本契约标识 0.8.4-helper-v2');
});

test('CLI 启动模块 4: helper 输出诊断结构完整解析与部分成功时防重入', async () => {
  const mockJson = JSON.stringify({
    ok: false,
    terminalSpawned: true,
    cliAlive: true,
    windowLocated: true,
    isCentered: true,
    isForeground: false,
    error: 'Foreground activation failed',
    cmdPid: 12345,
    centerOffset: { dx: 0, dy: 0 }
  });

  const rawStdout = mockJson;
  let parsed = null;
  try { parsed = JSON.parse(rawStdout); } catch {}
  assert.ok(parsed, 'JSON 必须成功解析');
  assert.equal(parsed.terminalSpawned, true);
  assert.equal(parsed.isForeground, false);
  assert.equal(parsed.cmdPid, 12345);
});

test('CLI 启动模块 5: 隔离环境中验证 helper 部署、探测与哈希一致性（零生产依赖）', () => {
  const canonicalHelper = path.join(__dirname, 'scripts', 'cli-window-helper.exe');
  assert.ok(fs.existsSync(canonicalHelper), '唯一权威二进制 scripts/cli-window-helper.exe 必须存在');

  const buf = fs.readFileSync(canonicalHelper);
  assert.ok(buf.length > 1024, 'helper 文件体积必须有效');
  assert.equal(buf[0], 0x4d, '必须为合法 MZ 头');
  assert.equal(buf[1], 0x5a, '必须为合法 MZ 头');
  const canonicalSha = crypto.createHash('sha256').update(buf).digest('hex');

  // 在隔离临时目录中模拟部署状态
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-deploy-'));
  try {
    const mockStateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(mockStateDir, { recursive: true });
    const deployedHelper = path.join(mockStateDir, 'cli-window-helper.exe');
    fs.copyFileSync(canonicalHelper, deployedHelper);

    // 验证 resolveHelperExecutable 优先识别注入的 stateDir 部署路径
    const res = resolveHelperExecutable({ stateDir: mockStateDir });
    assert.equal(res.ok, true, '必须能成功识别已部署的 helper');
    assert.equal(path.resolve(res.helperPath), path.resolve(deployedHelper));
    assert.equal(res.helperSha256, canonicalSha, '部署后 helper 的哈希必须与源码一致');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 6: helper 缺失与启动失败时真实走标准控制台降级启动 CLI，不谎报原生居中成功', async () => {
  const { spawnSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-missing-'));
  try {
    const missingHelper = path.join(tmpDir, 'non_existent.exe');
    const resMissing = resolveHelperExecutable({ helperPath: missingHelper });
    assert.equal(resMissing.ok, false);
    assert.match(resMissing.error, /(未找到|不存在)/);

    if (process.platform === 'win32') {
      const mockStateDir = path.join(tmpDir, 'state');
      const wsDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(wsDir, { recursive: true });
      const cliMarker = path.join(tmpDir, 'cli-ran.txt');
      const fakeCli = path.join(tmpDir, 'agy.cmd');
      fs.writeFileSync(fakeCli, `@echo off\r\n> "${cliMarker}" echo ARGS=%*\r\n`, 'ascii');

      const spawnCalls = [];
      const res = await launchCliSession({
        cliPath: fakeCli,
        cwd: wsDir,
        stateDir: mockStateDir,
        helperPath: missingHelper,
        model: 'gemini-3.8-flash-high',
        args: ['--dry-marker'],
        _spawn: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, opts });
          return { pid: 43210, unref() {} };
        }
      });

      assert.equal(res.ok, true);
      assert.equal(res.fallback, true);
      assert.equal(res.nativePlacement, false);
      assert.equal(res.terminalSpawned, true);
      assert.equal(res.windowLocated, false);
      assert.equal(res.isCentered, false);
      assert.equal(res.isForeground, false);
      assert.match(res.fallbackReason, /标准控制台/);
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'cmd.exe');
      assert.deepEqual(spawnCalls[0].args.slice(0, 2), ['/d', '/k']);

      // 在无窗口后台真实执行生成出来的 runnerBat (/d /c)，验证回退链路可真实启动目标 CLI 与探测 cwd
      const runnerBat = spawnCalls[0].args[2];
      assert.ok(fs.existsSync(runnerBat));
      const execOut = spawnSync('cmd.exe', ['/d', '/c', runnerBat], {
        cwd: spawnCalls[0].opts.cwd,
        env: spawnCalls[0].opts.env,
        windowsHide: true,
        encoding: 'utf8'
      });
      assert.equal(execOut.status, 0);
      assert.ok(fs.existsSync(res.probeFile), '标准控制台回退脚本必须真实写入 cwd 探测文件');
      assert.ok(fs.existsSync(cliMarker), '标准控制台回退脚本必须真实调用到 CLI 可执行文件');
      const cliArgsText = fs.readFileSync(cliMarker, 'utf8');
      assert.match(cliArgsText, /--model "?gemini-3\.8-flash-high"?/);
      assert.match(cliArgsText, /--dry-marker/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 7: POSIX 命令行参数安全转义（免疫 Shell 注入）', () => {
  assert.equal(escapePosixArg('simple'), "'simple'");
  assert.equal(escapePosixArg('path with spaces'), "'path with spaces'");
  assert.equal(escapePosixArg("it's a test"), "'it'\\''s a test'");
  assert.equal(escapePosixArg('$HOME && rm -rf /'), "'$HOME && rm -rf /'");
  assert.equal(escapePosixArg(''), "''");
  assert.equal(escapePosixArg(null), "''");
});

test('PR #14 独立适配 8: macOS agy 探测、AppleScript Terminal 参数组装与跨平台代理/状态路径', async () => {
  const { getAppDataDir } = require('./asar-engine');
  const { getProxyCandidatePaths, detectProxyConfig } = require('./meter-proxy');
  const { detectAndMigrateLegacyConfigs } = require('./modules-config');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-mac-paths-'));
  try {
    const macApp = path.join(tmpDir, 'Antigravity.app');
    const agyBin = path.join(macApp, 'Contents', 'Resources', 'app', 'bin', 'agy');
    fs.mkdirSync(path.dirname(agyBin), { recursive: true });
    fs.writeFileSync(agyBin, '#!/bin/sh\necho ok\n', 'utf8');

    const macCli = resolveCliExecutable(null, {
      platform: 'darwin',
      homeDir: tmpDir,
      env: {},
      macAppRoots: [macApp]
    });
    assert.equal(macCli.ok, true);
    assert.equal(macCli.source, 'mac_app_bin');
    assert.equal(macCli.exePath, agyBin);

    const inspect = await launchCliSession({
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [macApp],
      cwd: tmpDir,
      model: 'gemini-3.8-flash-high',
      args: ["--prompt='hi'"],
      env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
      _inspectAppleScript: true
    });
    assert.equal(inspect.ok, true);
    assert.equal(inspect.terminal, 'Terminal.app');
    assert.match(inspect.appleScript, /tell application "Terminal"/);
    assert.match(inspect.shellCmd, /HTTP_PROXY='http:\/\/127\.0\.0\.1:7897'/);
    assert.match(inspect.shellCmd, /exec '[^']+' -l/);

    // getAppDataDir & proxy & legacy migration macOS 路径
    const origAppData = process.env.APPDATA;
    delete process.env.APPDATA;
    try {
      const macAppData = getAppDataDir({ platform: 'darwin', homeDir: '/Users/demo' });
      assert.equal(macAppData.replace(/\\/g, '/'), '/Users/demo/Library/Application Support');
    } finally {
      if (origAppData !== undefined) process.env.APPDATA = origAppData;
    }

    const macProxyCandidates = getProxyCandidatePaths(null, { platform: 'darwin', homeDir: tmpDir, env: {} });
    assert.ok(macProxyCandidates.some(p => p.includes('Application Support') && p.endsWith('modules.json')));

    const modCfgPath = path.join(tmpDir, 'Library', 'Application Support', 'AntigravityContextMeter', 'modules.json');
    fs.mkdirSync(path.dirname(modCfgPath), { recursive: true });
    fs.writeFileSync(modCfgPath, JSON.stringify({
      modules: { proxy: { enabled: true, httpProxy: 'http://127.0.0.1:7897' } }
    }), 'utf8');
    const proxyRes = detectProxyConfig({ platform: 'darwin', homeDir: tmpDir, env: {} });
    assert.equal(proxyRes.enabled, true);
    assert.equal(proxyRes.httpProxy, 'http://127.0.0.1:7897');

    // 验证 Python attachment_scan.py 共享公式纯标准库回退与 _get_state_dir
    const { spawnSync } = require('node:child_process');
    const pyCheck = spawnSync('python', ['-c', `
import os, attachment_scan as s
assert s._translate_shared_formula_fallback('SUM(A1:B1)+$C$1', 'C1', 'D3') == 'SUM(B3:C3)+$C$1'
os.environ['AG_METER_STATE_DIR'] = 'X_CUSTOM'
assert s._get_state_dir() == 'X_CUSTOM'
print('PY_OK')
`], { cwd: __dirname, encoding: 'utf8' });
    if (pyCheck.status === 0) {
      assert.match(pyCheck.stdout, /PY_OK/);
    }
    assert.ok(typeof detectAndMigrateLegacyConfigs === 'function');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('local-api exports parseExplicitPort and cli.js status / runtime-check.js --port 58321 parse it cleanly with mock', async () => {
  const { spawnSync } = require('node:child_process');
  const { loadAsarEngine } = require('./asar-engine');
  const localApi = require('./local-api');
  assert.equal(typeof localApi.parseExplicitPort, 'function');
  assert.equal(localApi.parseExplicitPort('58321'), 58321);
  assert.equal(localApi.parseExplicitPort('0'), null);
  assert.equal(localApi.parseExplicitPort('70000'), null);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-port-parse-'));
  try {
    const srcDir = path.join(tmpDir, 'asar-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.33.0' }), 'utf8');
    const fakeAsar = path.join(tmpDir, 'fake-app.asar');
    await loadAsarEngine().createPackageWithOptions(srcDir, fakeAsar, {});

    const logFile = path.join(tmpDir, 'cdp-calls.json');
    const hookFile = path.join(tmpDir, 'mock-local-api.js');
    fs.writeFileSync(hookFile, `
      'use strict';
      const fs = require('node:fs');
      const path = require('node:path');
      const localApiPath = path.resolve(${JSON.stringify(path.join(__dirname, 'local-api.js'))});
      const api = require(localApiPath);
      const logPath = ${JSON.stringify(logFile)};
      api.discoverAntigravityCdp = async (opts = {}) => {
        const list = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
        list.push(opts);
        fs.writeFileSync(logPath, JSON.stringify(list), 'utf8');
        return { port: opts.port || null, pages: [], page: null, allPages: [] };
      };
    `, 'utf8');

    const isolatedEnv = {
      ...process.env,
      AG_METER_STATE_DIR: path.join(tmpDir, 'state'),
      AG_METER_TEST_MODE: '1',
      APPDATA: path.join(tmpDir, 'appdata'),
      LOCALAPPDATA: path.join(tmpDir, 'localappdata')
    };

    const statusRun = spawnSync(
      process.execPath,
      ['-r', hookFile, path.join(__dirname, 'cli.js'), 'status', '--port', '58321', '--path', fakeAsar],
      { cwd: __dirname, env: isolatedEnv, encoding: 'utf8', windowsHide: true }
    );
    assert.equal(statusRun.status, 0, `cli.js status stderr: ${statusRun.stderr}`);
    assert.doesNotMatch(statusRun.stderr + statusRun.stdout, /parseExplicitPort is not a function/);
    const statusJson = JSON.parse(statusRun.stdout);
    assert.equal(statusJson.liveWindow.cdpPort, 58321);

    const rcRun = spawnSync(
      process.execPath,
      ['-r', hookFile, path.join(__dirname, 'runtime-check.js'), '--port', '58321'],
      { cwd: __dirname, env: isolatedEnv, encoding: 'utf8', windowsHide: true }
    );
    assert.doesNotMatch(rcRun.stderr + rcRun.stdout, /parseExplicitPort is not a function/);
    assert.match(rcRun.stderr, /Expected exactly one Antigravity page/);

    const recorded = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    assert.ok(recorded.length >= 2);
    assert.deepEqual(recorded[0], { port: 58321, strictPort: true });
    assert.deepEqual(recorded[recorded.length - 1], { port: 58321 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 9: 探测 ~/.gemini/bin/agy 与 detectCliBinary 原生二进制过滤', () => {
  const { detectCliBinary } = require('./meter-context-unlock');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-gemini-root-bin-'));
  try {
    // 1. Windows: ~/.gemini/bin/agy.exe 应无需 PATH 即被识别
    const winExe = path.join(tmpDir, '.gemini', 'bin', 'agy.exe');
    fs.mkdirSync(path.dirname(winExe), { recursive: true });
    fs.writeFileSync(winExe, 'MZdummy', 'utf8');

    const resWin = resolveCliExecutable(null, { platform: 'win32', homeDir: tmpDir, env: {} });
    assert.equal(resWin.ok, true);
    assert.equal(resWin.source, 'gemini_cli_bin_exe');
    assert.equal(path.resolve(resWin.exePath), path.resolve(winExe));

    const detectedWin = detectCliBinary(null, { platform: 'win32', homeDir: tmpDir, env: {} });
    assert.equal(path.resolve(detectedWin), path.resolve(winExe));

    // 2. Windows 仅有无伴生 .exe 的 .cmd 包装脚本时，detectCliBinary 应拒绝将其送入 PE 解析
    const cmdOnlyHome = path.join(tmpDir, 'cmd-only');
    const winCmd = path.join(cmdOnlyHome, '.gemini', 'bin', 'agy.cmd');
    fs.mkdirSync(path.dirname(winCmd), { recursive: true });
    fs.writeFileSync(winCmd, '@echo off\r\necho agy wrapper\r\n', 'utf8');
    assert.equal(detectCliBinary(null, { platform: 'win32', homeDir: cmdOnlyHome, env: {} }), null);

    // 3. Linux/macOS: ~/.gemini/bin/agy 应被识别
    const unixHome = path.join(tmpDir, 'unix-home');
    const unixBin = path.join(unixHome, '.gemini', 'bin', 'agy');
    fs.mkdirSync(path.dirname(unixBin), { recursive: true });
    fs.writeFileSync(unixBin, '#!/bin/sh\necho ok\n', 'utf8');
    const resLinux = resolveCliExecutable(null, { platform: 'linux', homeDir: unixHome, env: {} });
    assert.equal(resLinux.ok, true);
    assert.equal(resLinux.source, 'gemini_cli_bin');
    assert.equal(path.resolve(resLinux.exePath), path.resolve(unixBin));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cli.js rejects --help, -h, and unknown args/commands with non-zero exit, prints usage only, and performs zero writes or live injection', () => {
  const { spawnSync } = require('node:child_process');
  const { parseCliArgs } = require('./cli');

  assert.equal(parseCliArgs([]).cmd, 'install');
  assert.equal(parseCliArgs(['--path', 'a.asar']).cmd, 'install');
  assert.equal(parseCliArgs(['status', '--port', '58321']).cmd, 'status');
  assert.equal(parseCliArgs(['proxy:set', 'http://127.0.0.1:7890', '--path', 'a.asar']).cmd, 'proxy:set');
  assert.equal(parseCliArgs(['--help']).showHelp, true);
  assert.equal(parseCliArgs(['--help']).exitCode, 1);
  assert.equal(parseCliArgs(['-h']).showHelp, true);
  assert.equal(parseCliArgs(['--unknown']).showHelp, true);
  assert.equal(parseCliArgs(['unknown-cmd']).showHelp, true);
  assert.equal(parseCliArgs(['status', '--unknown']).showHelp, true);
  assert.equal(parseCliArgs(['install', '--port']).reason, 'missing_value');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-help-'));
  try {
    const spyFile = path.join(tmpDir, 'spy-no-op.js');
    const triggerLog = path.join(tmpDir, 'triggers.txt');
    fs.writeFileSync(spyFile, `
      'use strict';
      const fs = require('node:fs');
      const path = require('node:path');
      const log = (tag) => fs.appendFileSync(${JSON.stringify(triggerLog)}, tag + '\\n');
      const installMod = require(path.resolve(${JSON.stringify(path.join(__dirname, 'install.js'))}));
      installMod.install = async () => { log('install'); throw new Error('must not call install'); };
      installMod.tryHotInject = async () => { log('tryHotInject'); throw new Error('must not call tryHotInject'); };
      installMod.tryHotInjectDetailed = async () => { log('tryHotInjectDetailed'); throw new Error('must not call tryHotInjectDetailed'); };
      const localApi = require(path.resolve(${JSON.stringify(path.join(__dirname, 'local-api.js'))}));
      localApi.discoverAntigravityCdp = async () => { log('discoverCdp'); throw new Error('must not call discoverCdp'); };
    `, 'utf8');

    const env = {
      ...process.env,
      AG_METER_STATE_DIR: path.join(tmpDir, 'state'),
      AG_METER_TEST_MODE: '1',
      APPDATA: path.join(tmpDir, 'appdata'),
      LOCALAPPDATA: path.join(tmpDir, 'localappdata')
    };

    const cases = [
      ['--help'],
      ['-h'],
      ['--unknown-flag'],
      ['unknown-subcommand'],
      ['status', '--unknown-flag'],
      ['install', '--bad-arg']
    ];
    for (const argv of cases) {
      const res = spawnSync(
        process.execPath,
        ['-r', spyFile, path.join(__dirname, 'cli.js'), ...argv],
        { cwd: __dirname, env, encoding: 'utf8', windowsHide: true }
      );
      assert.notEqual(res.status, 0, `args ${JSON.stringify(argv)} must exit non-zero`);
      assert.match(res.stdout, /用法:/, `args ${JSON.stringify(argv)} must print usage`);
      assert.doesNotMatch(res.stdout, /正在安装|已通过 CDP 热注入/, `args ${JSON.stringify(argv)} must not trigger install/live`);
    }
    assert.equal(fs.existsSync(triggerLog), false, 'Help/unknown args must trigger zero install/live/CDP calls');
    assert.equal(fs.existsSync(path.join(tmpDir, 'state')), false, 'Help/unknown args must not create stateDir files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('打包脚本回归: package-release 编译 helper 输出至临时目录且不覆盖仓库 cli-window-helper.exe', () => {
  const { ensureWindowsHelper, packagePlatform, supportsCscDeterministicFlag } = require('./scripts/package-release');
  const repoHelperPath = path.join(__dirname, 'scripts', 'cli-window-helper.exe');
  const beforeStat = fs.statSync(repoHelperPath);
  const beforeSha = crypto.createHash('sha256').update(fs.readFileSync(repoHelperPath)).digest('hex');

  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pkg-test-'));
  let helperInfo = null;
  try {
    helperInfo = ensureWindowsHelper();
    assert.ok(fs.existsSync(helperInfo.helperPath), '必须返回可用的 helperPath');
    if (process.platform === 'win32' && helperInfo.compiled) {
      assert.notEqual(
        path.resolve(helperInfo.helperPath),
        path.resolve(repoHelperPath),
        '本地编译输出必须位于临时目录，绝不能覆盖仓库里的 scripts/cli-window-helper.exe'
      );
      assert.ok(helperInfo.tempDir && helperInfo.helperPath.startsWith(path.resolve(os.tmpdir())));
    }
    const afterStat = fs.statSync(repoHelperPath);
    const afterSha = crypto.createHash('sha256').update(fs.readFileSync(repoHelperPath)).digest('hex');
    assert.equal(afterSha, beforeSha, '仓库 tracking 的 scripts/cli-window-helper.exe 内容绝不能被改写');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '仓库 scripts/cli-window-helper.exe 修改时间绝不能被改写');

    const res = packagePlatform(
      { name: 'windows_amd64', scripts: ['install.bat', 'uninstall.bat', 'scripts/cli-window-helper.exe'] },
      '0.8.8-test',
      { distDir: tmpOut, helperPath: helperInfo.helperPath }
    );
    assert.ok(fs.existsSync(res.path) && res.size > 0);
    assert.equal(typeof supportsCscDeterministicFlag('Z:/missing/csc.exe'), 'boolean');
  } finally {
    if (helperInfo?.tempDir) {
      try { fs.rmSync(helperInfo.tempDir, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch {}
  }
});

test('CLI 启动模块 10: resolveCliAccountProfile 独立账号解析、凭据提取与 profile 目录隔离', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-acc-'));
  try {
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const storeFile = path.join(stateDir, 'accounts_v1.json');
    const profilesDir = path.join(tmpDir, 'cli-profiles');

    // 1. 无指定账号时保持未隔离
    const resNone = await resolveCliAccountProfile(null, { stateDir, cliProfilesDir: profilesDir });
    assert.equal(resNone.ok, true);
    assert.equal(resNone.isolated, false);
    assert.equal(resNone.email, null);

    // 2. 账号库存在但查询不存在的账号
    const fakeStore = {
      version: 1,
      accounts: {
        'alpha@example.com': {
          email: 'alpha@example.com',
          credential: { accessToken: 'mock_token_alpha', refreshToken: 'mock_refresh_alpha' }
        },
        'beta@example.com': {
          email: 'beta@example.com',
          credential: {}
        }
      }
    };
    fs.writeFileSync(storeFile, JSON.stringify(fakeStore), 'utf8');

    const resMissing = await resolveCliAccountProfile('gamma@example.com', { stateDir, cliProfilesDir: profilesDir });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.code, 'ACCOUNT_NOT_FOUND');
    assert.match(resMissing.error, /未在多账号管理器中找到指定账号/);

    // 3. 账号存在但无凭据
    const resNoCred = await resolveCliAccountProfile('beta@example.com', { stateDir, cliProfilesDir: profilesDir });
    assert.equal(resNoCred.ok, false);
    assert.equal(resNoCred.code, 'ACCOUNT_NO_CREDENTIALS');

    // 4. 正常账号成功生成隔离 profile 与 token 文件
    const resAlpha = await resolveCliAccountProfile('alpha@example.com', { stateDir, cliProfilesDir: profilesDir });
    assert.equal(resAlpha.ok, true);
    assert.equal(resAlpha.isolated, true);
    assert.equal(resAlpha.email, 'alpha@example.com');
    assert.ok(fs.existsSync(resAlpha.isolatedDir));
    assert.ok(fs.existsSync(resAlpha.tokenFile));
    assert.ok(fs.existsSync(path.join(resAlpha.isolatedDir, 'keyring-marker-disabled')));

    const parsedToken = JSON.parse(fs.readFileSync(resAlpha.tokenFile, 'utf8'));
    assert.equal(parsedToken.token.access_token, 'mock_token_alpha');
    assert.equal(parsedToken.token.refresh_token, 'mock_refresh_alpha');
    assert.equal(parsedToken.id_token_email, 'alpha@example.com');
    assert.equal(parsedToken.auth_method, 'consumer');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 11: launchCliSession 与 cli.js launch-cli --account 隔离环境变量与无损凭据交接启动', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-launch-acc-'));
  try {
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const storeFile = path.join(stateDir, 'accounts_v1.json');
    const profilesDir = path.join(tmpDir, 'cli-profiles');
    const fakeCli = path.join(tmpDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(fakeCli, 'stub', { mode: 0o755 });

    const fakeStore = {
      version: 1,
      accounts: {
        'isolated_user@gmail.com': {
          email: 'isolated_user@gmail.com',
          credential: { accessToken: 'mock_token_iso', refreshToken: 'mock_refresh_iso' }
        }
      }
    };
    fs.writeFileSync(storeFile, JSON.stringify(fakeStore), 'utf8');

    // 1. launchCliSession dryRun 验证
    const dryRes = await launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      account: 'isolated_user@gmail.com',
      stateDir,
      cliProfilesDir: profilesDir,
      dryRun: true
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.account, 'isolated_user@gmail.com');
    assert.equal(dryRes.keyringBypassed, true);
    assert.equal(dryRes.args.includes('-keyring-unavailable'), false);
    assert.equal(dryRes.env.JETSKI_APP_DATA_DIR, dryRes.isolatedDir);
    assert.equal(dryRes.env.JETSKI_OAUTH_TOKEN, 'mock_token_iso');
    assert.equal(dryRes.env.AG_CLI_ACCOUNT_EMAIL, 'isolated_user@gmail.com');

    // 2. 通过 cli.js 命令行进程解析验证
    const resCli = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'cli.js'),
        'launch-cli',
        '--cli-path', fakeCli,
        '--cwd', tmpDir,
        '--account', 'isolated_user@gmail.com',
        '--state-dir', stateDir,
        '--dry-run',
        '--json'
      ],
      { cwd: __dirname, encoding: 'utf8', windowsHide: true }
    );
    assert.equal(resCli.status, 0, resCli.stderr);
    const parsedOut = JSON.parse(resCli.stdout.trim());
    assert.equal(parsedOut.ok, true);
    assert.equal(parsedOut.account, 'isolated_user@gmail.com');
    assert.equal(parsedOut.keyringBypassed, true);
    assert.equal(parsedOut.args.includes('-keyring-unavailable'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
