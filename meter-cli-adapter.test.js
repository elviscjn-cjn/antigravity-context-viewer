'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getShortPath,
  buildCompatibleStatusLineCommand,
  resolveAgyLaunchChain,
  isScriptAdapted,
  buildAdaptedProxyScript,
  installCliAdapter,
  restoreCliAdapter,
  statusCliAdapter
} = require('./meter-cli-adapter');
const {
  isPidAlive,
  parseCompanionArgs,
  recordProcessSessionBinding,
  getProcessSessionBinding,
  removeProcessSessionBinding,
  resolveSessionForCwd,
  runCompanion
} = require('./meter-cli-companion');

function makeTempDir(prefix = 'acm-adapter-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('CLI 启动链路适配器: 解析、备份、增强生成与原样恢复已有 statusLine', () => {
  const tmpDir = makeTempDir('acm-adapter-');
  try {
    const proxyDir = path.join(tmpDir, 'proxy-bin');
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(proxyDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const proxyScript = path.join(proxyDir, 'agy.cmd');
    const rawBinary = path.join(binDir, 'agy.exe');
    const companionScript = path.join(tmpDir, 'meter-cli-companion.js');
    const settingsPath = path.join(tmpDir, 'settings.json');

    // 写入模拟的原版代理脚本
    const originalScriptContent = [
      '@echo off',
      'setlocal',
      'set "HTTP_PROXY=http://127.0.0.1:7897"',
      'set "HTTPS_PROXY=http://127.0.0.1:7897"',
      `"${rawBinary}" %*`,
      'exit /b %errorlevel%'
    ].join('\r\n');
    fs.writeFileSync(proxyScript, originalScriptContent, 'utf8');
    fs.writeFileSync(rawBinary, 'mock-binary', 'utf8');
    fs.writeFileSync(companionScript, '// mock companion', 'utf8');

    // 用户原先拥有自己自定义的 statusLine 配置
    const userOriginalStatusLine = { command: 'my-custom-statusline-tool', stack_with_default: false };
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'Gemini 4 Hydrogen',
      statusLine: userOriginalStatusLine
    }, null, 2), 'utf8');

    // 1. 链路解析验证
    const chainInfo = resolveAgyLaunchChain({
      launchChain: [proxyScript, rawBinary]
    });
    assert.equal(chainInfo.proxyScript, proxyScript);
    assert.equal(chainInfo.rawBinary, rawBinary);

    // 2. 增强生成验证 (保留代理、参数、退出码与 --run 包装托管)
    const adaptedContent = buildAdaptedProxyScript(originalScriptContent, companionScript, rawBinary);
    assert.ok(adaptedContent.includes('HTTP_PROXY=http://127.0.0.1:7897'), '必须保留原 HTTP_PROXY');
    assert.ok(adaptedContent.includes('HTTPS_PROXY=http://127.0.0.1:7897'), '必须保留原 HTTPS_PROXY');
    assert.ok(adaptedContent.includes('meter-cli-companion.js'), '必须挂接伴随监视脚本');
    assert.ok(adaptedContent.includes('--run'), '必须通过 --run 托管原生客户端');
    assert.ok(adaptedContent.includes('%*'), '必须完整传递所有命令行参数');
    assert.ok(adaptedContent.includes('exit /b %errorlevel%'), '必须保留退出码');
    assert.equal(isScriptAdapted(originalScriptContent), false);
    assert.equal(isScriptAdapted(adaptedContent), true);

    // 3. 安装适配器验证
    const installRes = installCliAdapter({
      proxyScript,
      rawBinary,
      companionPath: companionScript,
      settingsPath
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.backupCreated, true);
    assert.equal(installRes.statusLineConfigured, true);
    assert.ok(fs.existsSync(`${proxyScript}.bak`), '必须生成 .bak 备份');
    assert.equal(fs.readFileSync(`${proxyScript}.bak`, 'utf8'), originalScriptContent, '备份内容必须与原版一致');

    // 再次安装不覆盖已有原版 .bak
    const reInstallRes = installCliAdapter({
      proxyScript,
      rawBinary,
      companionPath: companionScript,
      settingsPath
    });
    assert.equal(reInstallRes.ok, true);
    assert.equal(reInstallRes.backupCreated, false, '重复安装绝不覆盖已有原版备份');

    // 检查 settings.json 配置已指向 ACM
    const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(updatedSettings.statusLine, 'settings.json 必须配置 statusLine');
    assert.equal(updatedSettings.statusLine.stack_with_default, true);
    assert.ok(updatedSettings.statusLine.command.includes('statusline'));
    assert.equal(updatedSettings.statusLine.command.startsWith('node "'), false, '命令绝不能包含外层转义引号，防止 Go statusline_runner 误当成文件名');

    const testNoSpaces = buildCompatibleStatusLineCommand('D:/my-tools/cli.js');
    assert.equal(testNoSpaces, 'node D:/my-tools/cli.js statusline');
    assert.equal(testNoSpaces.includes('"'), false);

    // 4. 状态检查验证
    const st = statusCliAdapter({ proxyScript, settingsPath });
    assert.equal(st.isAdapted, true);
    assert.equal(st.backupExists, true);
    assert.equal(st.statusLineConfigured, true);

    // 5. 无损还原验证：必须将用户原先的 statusLine 原样恢复！
    const restoreRes = restoreCliAdapter({ proxyScript, settingsPath });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.scriptRestored, true);
    assert.equal(restoreRes.statusLineRestored, true);
    assert.equal(fs.readFileSync(proxyScript, 'utf8'), originalScriptContent, '脚本必须完全还原为原版');

    const restoredSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(restoredSettings.statusLine, userOriginalStatusLine, '还原后 settings.json 中必须完整恢复用户原版自定义 statusLine');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 终端伴随监视守护: PID 绑定注册、同目录防串线与未就绪等待约束', () => {
  const tmpDir = makeTempDir('acm-companion-st-');
  try {
    // 1. 参数解析
    const opts = parseCompanionArgs([
      '--target-pid', '99999',
      '--parent-pid', '88888',
      '--cwd', 'D:\\work\\project-a',
      '--interval', '1000',
      '--once'
    ]);
    assert.equal(opts.targetPid, 99999);
    assert.equal(opts.parentPid, 88888);
    assert.equal(opts.cwd, 'D:\\work\\project-a');
    assert.equal(opts.interval, 1000);
    assert.equal(opts.once, true);

    // 2. PID 注册表读写与清理
    recordProcessSessionBinding({
      pid: process.pid,
      sessionId: 'test-sess-bind-1234',
      cwd: 'D:\\work\\project-a',
      stateDir: tmpDir
    });
    const binding = getProcessSessionBinding(process.pid, { stateDir: tmpDir });
    assert.ok(binding);
    assert.equal(binding.sessionId, 'test-sess-bind-1234');

    // 3. 多会话隔离匹配 (通过 PID 绑定精准匹配属于自身的会话)
    const mockScan = {
      sessions: [
        { sessionId: 'test-sess-other', cwd: 'D:\\work\\project-a', contextUsedTokens: 12000 },
        { sessionId: 'test-sess-bind-1234', cwd: 'D:\\work\\project-a', contextUsedTokens: 34000 }
      ]
    };
    const matched = resolveSessionForCwd(mockScan, 'D:\\work\\project-a', {
      targetPid: process.pid,
      stateDir: tmpDir
    });
    assert.ok(matched);
    assert.equal(matched.sessionId, 'test-sess-bind-1234');
    assert.equal(matched.contextUsedTokens, 34000);

    // 4. 严格防串线约束：当未建立明确绑定时，绝不借用其他会话，必须返回 null！
    const unbindMatched = resolveSessionForCwd(mockScan, 'D:\\work\\project-a', {
      targetPid: 987654, // 无任何绑定的无关 PID
      stateDir: tmpDir
    });
    assert.equal(unbindMatched, null, '未建立绑定的终端严禁回退到 scan.sessions[0]，必须返回 null');

    // 5. 清理绑定
    removeProcessSessionBinding(process.pid, { stateDir: tmpDir });
    assert.equal(getProcessSessionBinding(process.pid, { stateDir: tmpDir }), null);

    // 6. 进程存活检查
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(2147483640), false);

    // 7. 跨子 shell (AG_METER_COMPANION_PID + targetPid) 同源绑定与清理验证
    recordProcessSessionBinding({
      pid: 445566,
      companionPid: 778899,
      sessionId: 'test-sess-bind-1234',
      cwd: 'D:\\work\\project-a',
      stateDir: tmpDir
    });
    recordProcessSessionBinding({
      pid: 778899,
      companionPid: 778899,
      sessionId: 'test-sess-bind-1234',
      cwd: 'D:\\work\\project-a',
      stateDir: tmpDir
    });
    const matchedByCompanion = resolveSessionForCwd(mockScan, 'D:\\work\\project-a', {
      targetPid: 999111, // agy pid
      companionPid: 778899, // companion pid
      stateDir: tmpDir
    });
    assert.equal(matchedByCompanion?.sessionId, 'test-sess-bind-1234', '状态栏通过 companionPid 写入的绑定必须被标题守护进程同源识别');
    removeProcessSessionBinding(778899, { stateDir: tmpDir });
    removeProcessSessionBinding(445566, { stateDir: tmpDir });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 7.1: 无代理原脚本适配与无 .bak 还原绝不注入硬编码 127.0.0.1:7897 或 D:\\agy\\bin\\agy.exe', () => {
  const tmpDir = makeTempDir('acm-adapter-noproxy-');
  try {
    const proxyDir = path.join(tmpDir, 'proxy-bin');
    const binDir = path.join(tmpDir, 'custom-bin');
    fs.mkdirSync(proxyDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const proxyScript = path.join(proxyDir, 'agy.cmd');
    const rawBinary = path.join(binDir, 'agy.exe');
    const companionScript = path.join(tmpDir, 'meter-cli-companion.js');
    const settingsPath = path.join(tmpDir, 'settings.json');
    const cleanOrig = `@echo off\r\nsetlocal\r\n"${rawBinary}" %*\r\nexit /b %errorlevel%\r\n`;
    fs.writeFileSync(proxyScript, cleanOrig, 'utf8');
    fs.writeFileSync(rawBinary, 'bin', 'utf8');
    fs.writeFileSync(companionScript, '// companion', 'utf8');
    fs.writeFileSync(settingsPath, '{}', 'utf8');

    const adapted = buildAdaptedProxyScript(cleanOrig, companionScript, rawBinary);
    assert.equal(adapted.includes('7897'), false, '无代理配置时不得强行注入 127.0.0.1:7897');
    assert.equal(adapted.includes('D:\\agy\\bin\\agy.exe'), false);
    assert.ok(adapted.includes(path.resolve(rawBinary)));

    // 模拟已适配脚本但不存在 .bak 时的 restore 回退
    fs.writeFileSync(proxyScript, adapted, 'utf8');
    const restoreRes = restoreCliAdapter({ proxyScript, settingsPath });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.scriptRestored, true);
    const restoredContent = fs.readFileSync(proxyScript, 'utf8');
    assert.equal(restoredContent.includes('7897'), false, '无 .bak 还原不得注入硬编码 7897');
    assert.equal(restoredContent.includes('D:\\agy\\bin\\agy.exe'), false, '无 .bak 还原不得硬编码 D:\\agy\\bin\\agy.exe');
    assert.ok(restoredContent.includes(path.resolve(rawBinary)));
    assert.equal(isScriptAdapted(restoredContent), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
