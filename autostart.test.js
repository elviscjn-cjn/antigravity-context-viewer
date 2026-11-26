'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LABEL,
  resolveAutostartTarget,
  resolveNodePath,
  buildWatchArgs,
  buildLaunchAgentPlist,
  buildWindowsRunCommand,
  readLaunchAgentProgramArguments,
  getAutostartStatus,
  enableAutostart,
  disableAutostart
} = require('./autostart');

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

test('autostart 1: 目标路径按平台解析，Linux 标记为 unsupported', () => {
  const mac = resolveAutostartTarget({ platform: 'darwin', homeDir: '/tmp/home' });
  assert.equal(mac.kind, 'launchagent');
  assert.equal(mac.file, path.join('/tmp/home', 'Library', 'LaunchAgents', `${LABEL}.plist`));

  const win = resolveAutostartTarget({ platform: 'win32', homeDir: '/tmp/home' });
  assert.equal(win.kind, 'run-key');

  const linux = resolveAutostartTarget({ platform: 'linux', homeDir: '/tmp/home' });
  assert.equal(linux.kind, 'unsupported');
});

test('autostart 2: watch 参数只在显式指定端口时携带 --port', () => {
  const base = buildWatchArgs({ scriptPath: '/opt/app/cli.js' });
  assert.deepEqual(base, ['/opt/app/cli.js', 'watch']);
  const withPort = buildWatchArgs({ scriptPath: '/opt/app/cli.js', port: 58322 });
  assert.deepEqual(withPort, ['/opt/app/cli.js', 'watch', '--port', '58322']);
});

test('autostart 2b: node 路径优先取稳定符号路径，显式传入时原样返回', () => {
  assert.equal(resolveNodePath('/custom/node'), '/custom/node');
  const auto = resolveNodePath();
  assert.equal(typeof auto, 'string');
  assert.ok(auto.endsWith('node') || auto.endsWith('node.exe'));
});

test('autostart 3: LaunchAgent plist 结构正确并转义特殊字符', () => {
  const plist = buildLaunchAgentPlist({
    nodePath: '/opt/node & co/bin/node',
    scriptPath: '/Users/a<b>/cli.js',
    port: 58322,
    homeDir: '/tmp/home',
    logPath: '/tmp/home/Library/Logs/ag.log'
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.elviscjn\.antigravity-context-meter<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<string>\/opt\/node &amp; co\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/a&lt;b&gt;\/cli\.js<\/string>/);
  assert.match(plist, /<string>--port<\/string>\s*<string>58322<\/string>/);
  assert.match(plist, /<string>\/tmp\/home\/Library\/Logs\/ag\.log<\/string>/);

  const args = readLaunchAgentProgramArguments(plist);
  assert.deepEqual(args.slice(1, 3), ['/Users/a<b>/cli.js', 'watch']);
});

test('autostart 4: darwin 启用/幂等/停用全流程只写临时目录', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-autostart-'));
  const { exec, calls } = makeExecStub();
  const opts = { platform: 'darwin', homeDir, exec, scriptPath: path.join(homeDir, 'cli.js'), nodePath: '/opt/homebrew/bin/node', port: 58322 };

  try {
    const befores = getAutostartStatus({ platform: 'darwin', homeDir });
    assert.equal(befores.enabled, false);

    const enabled = await enableAutostart(opts);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.action, 'enabled');
    assert.equal(fs.existsSync(enabled.file), true);
    assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap'));
    assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout'));

    const afterEnable = getAutostartStatus({ platform: 'darwin', homeDir });
    assert.equal(afterEnable.enabled, true);
    assert.match(afterEnable.command, /cli\.js watch --port 58322$/);

    const before = fs.readFileSync(enabled.file, 'utf8');
    const again = await enableAutostart(opts);
    assert.equal(again.action, 'already_enabled');
    assert.equal(fs.readFileSync(enabled.file, 'utf8'), before);

    const disabled = await disableAutostart(opts);
    assert.equal(disabled.action, 'disabled');
    assert.equal(fs.existsSync(enabled.file), false);
    assert.equal(getAutostartStatus({ platform: 'darwin', homeDir }).enabled, false);

    const noop = await disableAutostart(opts);
    assert.equal(noop.action, 'already_disabled');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('autostart 5: linux 平台明确返回 unsupported，不产生任何写入', async () => {
  const { exec, calls } = makeExecStub();
  const res = await enableAutostart({ platform: 'linux', homeDir: '/tmp/nope', exec });
  assert.equal(res.ok, false);
  assert.equal(res.action, 'unsupported');
  assert.equal(calls.length, 0);
});

test('autostart 6: Windows Run 键写入带引号的命令并支持状态读取与移除', async () => {
  const cmd = buildWindowsRunCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\tools\\cli.js', port: 58322 });
  assert.equal(cmd, '"C:\\Program Files\\nodejs\\node.exe" C:\\tools\\cli.js watch --port 58322');

  const { exec, calls } = makeExecStub({
    'reg query': 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    AntigravityContextMeter    REG_SZ    C:\\node.exe cli.js watch\r\n'
  });
  const status = getAutostartStatus({ platform: 'win32', homeDir: 'C:\\Users\\a', exec });
  assert.equal(status.enabled, true);
  assert.equal(status.command, 'C:\\node.exe cli.js watch');

  const enabled = await enableAutostart({ platform: 'win32', homeDir: 'C:\\Users\\a', exec, nodePath: 'C:\\node.exe', scriptPath: 'C:\\tools\\cli.js' });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.action, 'already_enabled');

  await disableAutostart({ platform: 'win32', homeDir: 'C:\\Users\\a', exec });
  assert.ok(calls.some((c) => c[0] === 'reg' && c[1] === 'delete'));
});

test('autostart 7: Windows 未写入时启用会调用 reg add 携带 /f', async () => {
  const { exec, calls } = makeExecStub({ 'reg query': new Error('not found') });
  const res = await enableAutostart({ platform: 'win32', homeDir: 'C:\\Users\\a', exec, nodePath: 'C:\\node.exe', scriptPath: 'C:\\tools\\cli.js', port: 58322 });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'enabled');
  const addCall = calls.find((c) => c[0] === 'reg' && c[1] === 'add');
  assert.ok(addCall);
  assert.ok(addCall.includes('/f'));
  assert.ok(addCall.includes('C:\\node.exe C:\\tools\\cli.js watch --port 58322'));
});

test('autostart 8 (Issue #119): persistent 选项写入 KeepAlive=true、ThrottleInterval 与 --persistent 参数', () => {
  const plist = buildLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/opt/app/cli.js',
    port: 58321,
    persistent: true,
    homeDir: '/tmp/home',
    logPath: '/tmp/home/Library/Logs/ag.log'
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  const args = readLaunchAgentProgramArguments(plist);
  assert.deepEqual(args, ['/opt/homebrew/bin/node', '/opt/app/cli.js', 'watch', '--persistent', '--port', '58321']);
});

test('autostart 9 (macOS EIO 竞态): bootout 后等待 launchd 卸载完成并对瞬态 Bootstrap failed: 5 重试成功', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-autostart-eio-'));
  try {
    let printCalls = 0;
    let bootstrapCalls = 0;
    const seq = [];
    const exec = (file, args) => {
      seq.push(`${file}:${args[0]}`);
      if (file === 'launchctl' && args[0] === 'print') {
        printCalls++;
        if (printCalls <= 2) {
          return 'gui/502/com.elviscjn.antigravity-context-meter = {\n\tstate = running\n\tpid = 40026\n}';
        }
        throw new Error('Could not find service');
      }
      if (file === 'launchctl' && args[0] === 'bootstrap') {
        bootstrapCalls++;
        if (bootstrapCalls === 1) {
          throw new Error('Command failed: launchctl bootstrap gui/502 ...\nBootstrap failed: 5: Input/output error');
        }
        return '';
      }
      return '';
    };

    const res = await enableAutostart({
      platform: 'darwin',
      homeDir,
      exec,
      persistent: true,
      force: true,
      scriptPath: path.join(homeDir, 'cli.js'),
      nodePath: '/opt/homebrew/bin/node',
      _pollIntervalMs: 5,
      _bootoutWaitTimeoutMs: 500,
      _bootstrapRetryMs: 5
    });
    assert.equal(res.ok, true);
    assert.equal(res.warning, null, '等待卸载并重试后不应再返回 bootstrap warning');
    assert.ok(printCalls >= 3, `应轮询 launchctl print 直至服务卸载 (actual=${printCalls})`);
    assert.equal(bootstrapCalls, 2, '遇到瞬态 Bootstrap failed: 5 应自动重试并在第 2 次成功');
    assert.ok(seq.includes('launchctl:enable'), 'bootstrap 前应调用 launchctl enable');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Issue #119: macOS Dock 一键启动挂载入口 (.app) 生成、签名、状态查询、Dock 固定与移除闭环', () => {
  const autostart = require('./autostart');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-autostart-launcher-'));
  try {
    const fakeSourceApp = path.join(homeDir, 'FakeAntigravity.app');
    fs.mkdirSync(path.join(fakeSourceApp, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(fakeSourceApp, 'Contents', 'Resources', 'icon.icns'), Buffer.from('icns-mock'));

    const fakeDockPlist = path.join(homeDir, 'com.apple.dock.plist');
    const execLog = [];
    const mockExec = (cmd, args) => {
      execLog.push(`${cmd}:${args[0] || ''}`);
      if (cmd === 'python3' || cmd === '/usr/bin/python3') {
        const action = args[2];
        const appPathArg = args[4];
        if (action === 'check') {
          const present = fs.existsSync(fakeDockPlist) && fs.readFileSync(fakeDockPlist, 'utf8').includes(appPathArg);
          return JSON.stringify({ ok: true, present, index: present ? 0 : -1 });
        }
        if (action === 'add') {
          const existed = fs.existsSync(fakeDockPlist) && fs.readFileSync(fakeDockPlist, 'utf8').includes(appPathArg);
          fs.writeFileSync(fakeDockPlist, appPathArg, 'utf8');
          return JSON.stringify({ ok: true, present: true, changed: !existed });
        }
        if (action === 'remove') {
          const existed = fs.existsSync(fakeDockPlist) && fs.readFileSync(fakeDockPlist, 'utf8').includes(appPathArg);
          if (existed) fs.unlinkSync(fakeDockPlist);
          return JSON.stringify({ ok: true, present: false, changed: existed });
        }
      }
      return '';
    };

    const res = autostart.installMacDockLauncher({
      platform: 'darwin',
      homeDir,
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/opt/meter/cli.js',
      port: 58321,
      sourceAppPath: fakeSourceApp,
      addToDock: true,
      restartDock: false,
      dockPlistPath: fakeDockPlist,
      exec: mockExec
    });
    assert.equal(res.ok, true);
    assert.equal(res.installed, true);
    assert.equal(res.iconCopied, true);
    assert.equal(res.signed, true);
    assert.equal(res.addedToDock, true);
    assert.equal(res.inDock, true);
    assert.ok(fs.existsSync(res.plistPath));
    assert.ok(fs.existsSync(res.execPath));

    const plist = fs.readFileSync(res.plistPath, 'utf8');
    assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.match(plist, /<string>launch-antigravity-meter<\/string>/);
    const script = fs.readFileSync(res.execPath, 'utf8');
    assert.match(script, /launcher:run/);
    assert.match(script, /58321/);
    assert.ok(execLog.some(x => x.startsWith('codesign:--force')));

    const st = autostart.getMacDockLauncherStatus({
      platform: 'darwin',
      homeDir,
      dockPlistPath: fakeDockPlist,
      exec: mockExec
    });
    assert.equal(st.installed, true);
    assert.equal(st.inDock, true);
    assert.equal(st.iconPresent, true);

    const rm = autostart.removeMacDockLauncher({
      platform: 'darwin',
      homeDir,
      dockPlistPath: fakeDockPlist,
      restartDock: false,
      exec: mockExec
    });
    assert.equal(rm.ok, true);
    assert.equal(rm.removed, true);
    assert.equal(rm.dockRemoved, true);
    assert.equal(fs.existsSync(res.appPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
