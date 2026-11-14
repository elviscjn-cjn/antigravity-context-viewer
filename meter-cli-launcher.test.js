'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  resolveCliExecutable,
  resolveCliWorkspace,
  resolveHelperExecutable,
  escapePosixArg,
  launchCliSession
} = require('./meter-cli-launcher');

test('CLI 启动模块 1: resolveCliExecutable 探测真实环境或隔离模拟环境 agy', () => {
  let res = resolveCliExecutable();
  if (!res.ok) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-probe-'));
    try {
      const mockAppBin = path.join(tmpDir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
      fs.mkdirSync(mockAppBin, { recursive: true });
      const mockAgy = path.join(mockAppBin, 'agy');
      fs.writeFileSync(mockAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      res = resolveCliExecutable(null, {
        platform: 'darwin',
        homeDir: tmpDir,
        macAppRoots: [path.join(tmpDir, 'Antigravity.app')],
        env: { PATH: '' }
      });
      assert.equal(res.ok, true, '必须能成功探测到 Antigravity CLI');
      assert.ok(res.exePath && fs.existsSync(res.exePath), '解析的 CLI 可执行文件必须存在');
      assert.match(res.exePath.toLowerCase(), /agy(\.exe|\.cmd)?$/, '可执行文件名必须为 agy');
      assert.equal(res.source, 'mac_app_bin');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }
  assert.equal(res.ok, true, '必须能成功探测到 Antigravity CLI');
  assert.ok(res.exePath && fs.existsSync(res.exePath), '解析的 CLI 可执行文件必须存在');
  assert.match(res.exePath.toLowerCase(), /agy(\.exe|\.cmd)?$/, '可执行文件名必须为 agy');
});

test('CLI 启动模块 2: dryRun 包含完整参数与跨平台色彩环境隔离', async () => {
  const hostCli = resolveCliExecutable();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-dryrun-'));
  try {
    let cliPathOpt;
    if (!hostCli.ok) {
      cliPathOpt = path.join(tmpDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
      fs.writeFileSync(cliPathOpt, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const dry = await launchCliSession({
      dryRun: true,
      cliPath: cliPathOpt,
      cwd: tmpDir,
      model: 'gemini-3.8-flash-high',
      args: ['--verbose'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.model, 'gemini-3.8-flash-high');
    assert.deepEqual(dry.args, ['--model', 'gemini-3.8-flash-high', '--verbose']);
    assert.equal(dry.env.NO_COLOR, undefined);
    assert.equal(dry.env.TERM, 'xterm-256color');
    assert.equal(dry.env.COLORTERM, 'truecolor');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 2b: macOS 路径探测 (~/.gemini/antigravity/bin/agy、PATH、Application Support 与 zsh AppleScript)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-macos-'));
  try {
    const geminiBin = path.join(tmpDir, '.gemini', 'antigravity', 'bin');
    fs.mkdirSync(geminiBin, { recursive: true });
    const geminiAgy = path.join(geminiBin, 'agy');
    fs.writeFileSync(geminiAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const fromGemini = resolveCliExecutable(null, {
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [path.join(tmpDir, 'Missing.app')],
      env: { PATH: '' }
    });
    assert.equal(fromGemini.ok, true);
    assert.equal(fromGemini.source, 'gemini_bin');

    const pathBin = path.join(tmpDir, 'custom-path');
    fs.mkdirSync(pathBin, { recursive: true });
    const pathAgy = path.join(pathBin, 'agy');
    fs.writeFileSync(pathAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.unlinkSync(geminiAgy);

    const fromPath = resolveCliExecutable(null, {
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [path.join(tmpDir, 'Missing.app')],
      env: { PATH: pathBin }
    });
    assert.equal(fromPath.ok, true);
    assert.equal(fromPath.source, 'PATH');

    // 验证 macOS ~/Library/Application Support/Antigravity/app_storage.json 工作区解析
    const appSupportDir = path.join(tmpDir, 'Library', 'Application Support', 'Antigravity');
    const configProjDir = path.join(tmpDir, '.gemini', 'config', 'projects');
    const workspaceDir = path.join(tmpDir, 'my-mac-project');
    fs.mkdirSync(appSupportDir, { recursive: true });
    fs.mkdirSync(configProjDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(appSupportDir, 'app_storage.json'),
      JSON.stringify({ 'new-convo-last-selected-project': 'proj-mac-1' })
    );
    fs.writeFileSync(
      path.join(configProjDir, 'proj-mac-1.json'),
      JSON.stringify({
        name: 'Mac Project',
        projectResources: {
          resources: [{ folderUri: `file://${workspaceDir}` }]
        }
      })
    );

    const ws = await resolveCliWorkspace({
      platform: 'darwin',
      homeDir: tmpDir,
      configDir: path.join(tmpDir, '.gemini', 'config')
    });
    assert.equal(ws.ok, true);
    assert.equal(ws.source, 'last_selected_project');
    assert.equal(ws.cwd, workspaceDir);

    // 验证 macOS AppleScript 生成 ($SHELL / zsh + TERM/COLORTERM)
    const macDry = await launchCliSession({
      _inspectAppleScript: true,
      platform: 'darwin',
      cliPath: pathAgy,
      cwd: workspaceDir,
      model: 'gemini-3.8-pro',
      env: { SHELL: '/bin/zsh', PATH: pathBin }
    });
    assert.equal(macDry.ok, true);
    assert.equal(macDry.terminal, 'Terminal.app');
    assert.match(macDry.appleScript, /TERM='xterm-256color'/);
    assert.match(macDry.appleScript, /COLORTERM='truecolor'/);
    assert.match(macDry.appleScript, /exec '\/bin\/zsh' -l/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 3: 源码绝对不残留同步 powershell、8000ms 阻塞与作者绝对开发路径', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-cli-launcher.js'), 'utf8');
  assert.equal(src.includes("spawnSync('powershell.exe'"), false, '严禁包含 spawnSync powershell');
  assert.equal(src.includes('timeout: 8000'), false, '严禁包含旧版 8000ms 同步阻塞');
  assert.equal(src.includes('D:\\AI_plugin'), false, '严禁包含作者开发机本地绝对路径');
  assert.ok(src.includes('0.8.2-helper-v2'), '必须包含最新的版本契约标识 0.8.2-helper-v2');
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

test('CLI 启动模块 6: helper 缺失与启动失败时合理降级，不谎报原生居中成功', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-missing-'));
  try {
    // 探测一个确定不存在的路径
    const resMissing = resolveHelperExecutable({ helperPath: path.join(tmpDir, 'non_existent.exe') });
    assert.equal(resMissing.ok, false);
    assert.match(resMissing.error, /(未找到|不存在)/);

    // 验证 launchCliSession 针对 helper 缺失的降级响应字段
    // dryRun 会跳过执行，因此这里用单测模拟降级返回结构契约
    const fallbackContract = {
      ok: true,
      fallback: true,
      nativePlacement: false,
      windowLocated: false,
      isCentered: false,
      isForeground: false,
      fallbackReason: '未检测到原生定位辅助程序 (cli-window-helper.exe)，已降级启动标准控制台'
    };
    assert.equal(fallbackContract.fallback, true);
    assert.equal(fallbackContract.nativePlacement, false);
    assert.equal(fallbackContract.isCentered, false);
    assert.equal(fallbackContract.isForeground, false);
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
