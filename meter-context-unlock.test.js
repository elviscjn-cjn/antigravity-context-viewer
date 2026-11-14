'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  AUTHOR_INFO,
  detectTargetBinary,
  findTextSection,
  findPclntab,
  buildFunctions,
  analyzeBinary,
  analyzeBinaryAsync,
  getRunningLanguageServerInfoAsync,
  cleanupOldReplacedFiles,
  applyUnlock,
  restoreUnlock,
  getUnlockBackupDir
} = require('./meter-context-unlock');

/**
 * 构造一个用于端到端单测的精简合法 x86-64 PE Go 二进制 Buffer
 */
function createMockGoBinary(options = {}) {
  const isPatched = options.isPatched === true;
  const breakSymbols = options.breakSymbols === true;

  // 1. DOS + PE Header
  const buf = Buffer.alloc(1024 * 64, 0);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  buf.writeUInt32LE(0x80, 0x3c); // PE header at 0x80

  const pe = 0x80;
  buf.write('PE\0\0', pe, 'ascii');
  buf.writeUInt16LE(0x8664, pe + 4); // x86-64
  buf.writeUInt16LE(1, pe + 6); // 1 section
  buf.writeUInt16LE(0xf0, pe + 20); // opt header size

  const opt = pe + 24;
  buf.writeBigUInt64LE(0x140000000n, opt + 24); // ImageBase

  const sect = opt + 0xf0;
  buf.write('.text\0\0\0', sect, 'ascii');
  buf.writeUInt32LE(0x1000, sect + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, sect + 12); // VirtualAddress
  buf.writeUInt32LE(0xe000, sect + 16); // SizeOfRawData
  buf.writeUInt32LE(0x200, sect + 20); // PointerToRawData

  const textOff = 0x200;
  const textVA = 0x140001000n;

  // 2. 函数体填充
  // Gate 3A: utils.GetCheckpointConfig
  // x86-64 原版: 81fa00e80300be00e803000f42f2
  // x86-64 补丁: 89d6 + 12个 90
  const CLAMP_ORIG = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
  const CLAMP_PATCH = Buffer.concat([Buffer.from('89d6', 'hex'), Buffer.alloc(12, 0x90)]);

  const fn3aOff = textOff + 0x100;
  buf.set(isPatched ? CLAMP_PATCH : CLAMP_ORIG, fn3aOff + 0x20);

  // Gate 3B: config.applyFeatureProviderCheckpointOverrideConfig
  // call to selectCheckpointExperimentKey (e8 disp32) -> test %al,%al (84 c0) -> jne (75 08)
  const fn3bOff = textOff + 0x300;
  const fnSelOff = textOff + 0x500;

  // 在 fn3bOff + 0x10 放置 call fnSel
  const callDisp = (0x500) - (0x300 + 0x10 + 5);
  buf[fn3bOff + 0x10] = 0xe8;
  buf.writeInt32LE(callDisp, fn3bOff + 0x11);
  buf[fn3bOff + 0x15] = 0x84; // test %al, %al
  buf[fn3bOff + 0x16] = 0xc0;
  if (isPatched) {
    buf[fn3bOff + 0x17] = 0x90; // nop
    buf[fn3bOff + 0x18] = 0x90;
  } else {
    buf[fn3bOff + 0x17] = 0x75; // jne
    buf[fn3bOff + 0x18] = 0x08;
  }

  // 3. pclntab 构建
  const pclnBase = 0x1000;
  buf.set(Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]), pclnBase);
  buf[pclnBase + 6] = 1; // minLC = 1
  buf[pclnBase + 7] = 8; // ptrSize = 8
  buf.writeBigUInt64LE(1005n, pclnBase + 8); // nfunc = 1005
  buf.writeBigUInt64LE(0x80n, pclnBase + 32); // fnstart off from pclnBase = 0x80
  buf.writeBigUInt64LE(0x400n, pclnBase + 64); // pcln array off = 0x400

  // 写入字符串表 (fnstart = 0x1080)
  const fnstart = pclnBase + 0x80;
  const name1 = breakSymbols ? 'broken.func1\0' : 'cortex/utils.GetCheckpointConfig\0';
  const name2 = breakSymbols ? 'broken.func2\0' : 'cortex/config.applyFeatureProviderCheckpointOverrideConfig\0';
  const name3 = breakSymbols ? 'broken.func3\0' : 'cortex/config.selectCheckpointExperimentKey\0';

  const off1 = 0;
  buf.write(name1, fnstart + off1, 'ascii');
  const off2 = off1 + name1.length;
  buf.write(name2, fnstart + off2, 'ascii');
  const off3 = off2 + name2.length;
  buf.write(name3, fnstart + off3, 'ascii');

  // 写入 pcln 记录
  const pclnArray = pclnBase + 0x400;
  const recBase = pclnBase + 0x800;

  // func 0: utils.GetCheckpointConfig
  buf.writeUInt32LE(0x100, pclnArray + 0); // entryoff
  buf.writeUInt32LE(0x800 - 0x400, pclnArray + 4); // funcoff (rec0)
  buf.writeUInt32LE(0x300, pclnArray + 8); // nextEntry

  buf.writeInt32LE(0, recBase + 0);
  buf.writeInt32LE(off1, recBase + 4); // nameoff

  // func 1: config.applyFeatureProviderCheckpointOverrideConfig
  buf.writeUInt32LE(0x300, pclnArray + 8);
  buf.writeUInt32LE(0x820 - 0x400, pclnArray + 12);
  buf.writeUInt32LE(0x500, pclnArray + 16);

  buf.writeInt32LE(0, recBase + 0x20);
  buf.writeInt32LE(off2, recBase + 0x24);

  // func 2: config.selectCheckpointExperimentKey
  buf.writeUInt32LE(0x500, pclnArray + 16);
  buf.writeUInt32LE(0x840 - 0x400, pclnArray + 20);
  buf.writeUInt32LE(0x700, pclnArray + 24);

  buf.writeInt32LE(0, recBase + 0x40);
  buf.writeInt32LE(off3, recBase + 0x44);

  return buf;
}

test('原作者署名与链接完整且有效', () => {
  assert.equal(AUTHOR_INFO.name, 'Linux.do @23375');
  assert.equal(AUTHOR_INFO.url, 'https://linux.do/t/topic/3117832');
  assert.match(AUTHOR_INFO.credit, /Linux\.do\s+@23375/);
  assert.match(AUTHOR_INFO.credit, /原作者帖子/);
  assert.match(AUTHOR_INFO.disclaimer, /非官方本地技术修补/);
  assert.match(AUTHOR_INFO.disclaimer, /无法承诺“不会封号”/);
});

test('PE 二进制解析与 pclntab 定位测试', () => {
  const mock = createMockGoBinary();
  const textInfo = findTextSection(mock);
  assert.equal(textInfo.format, 'PE');
  assert.equal(textInfo.arch, 'x86-64');
  assert.equal(textInfo.textOff, 0x200);

  const pcln = findPclntab(mock);
  assert.equal(pcln.base, 0x1000);
  assert.equal(pcln.nfunc, 1005);

  const funcs = buildFunctions(mock).funcs;
  assert.ok(funcs['utils.GetCheckpointConfig']);
  assert.ok(funcs['config.applyFeatureProviderCheckpointOverrideConfig']);
  assert.ok(funcs['config.selectCheckpointExperimentKey']);
});

test('状态检测：原版未解锁判定 (not_patched)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-test-'));
  const testFile = path.join(tmpDir, 'mock_server.exe');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: false }));

  const res = analyzeBinary(testFile);
  assert.equal(res.status, 'not_patched');
  assert.equal(res.statusText, '未解锁');
  assert.equal(res.mode, 'standalone language_server');
  assert.equal(res.gate3a.status, 'unpatched');
  assert.equal(res.gate3b.status, 'unpatched');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态检测：静态打补丁但进程未运行时严禁误报 verified_active，判定为 patched_runtime_unconfirmed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-test-'));
  const testFile = path.join(tmpDir, 'mock_server.exe');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true }));

  const res = analyzeBinary(testFile);
  assert.equal(res.status, 'patched_runtime_unconfirmed');
  assert.equal(res.statusText, '磁盘已解锁，运行待确认');
  assert.equal(res.gate3a.status, 'patched');
  assert.equal(res.gate3b.status, 'patched');
  assert.equal(res.runtimeEvidence.isProcessRunning, false);
  assert.match(res.details, /未运行/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态检测：具备真实请求预算证据时准确判定为已验证生效 (verified_active)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-verified-'));
  const testFile = path.join(tmpDir, 'mock_server.exe');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true }));

  const res = analyzeBinary(testFile, { currentBudget: 983040 });
  assert.equal(res.status, 'verified_active');
  assert.equal(res.statusText, '已验证生效');
  assert.equal(res.runtimeEvidence.budgetVerified, true);
  assert.match(res.details, /983,040/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态检测：缺少核心符号时判定为不支持 (unsupported)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-test-'));
  const testFile = path.join(tmpDir, 'mock_broken.exe');
  fs.writeFileSync(testFile, createMockGoBinary({ breakSymbols: true }));

  const res = analyzeBinary(testFile);
  assert.equal(res.status, 'unsupported');
  assert.match(res.reason, /缺少核心检查点上限符号/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('完整生命周期：解锁 -> 幂等防重入 -> 恢复原版 -> 重复恢复幂等', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-lifecycle-'));
  const testFile = path.join(tmpDir, 'language_server.exe');
  const backupDir = path.join(tmpDir, 'backups');
  const origBuf = createMockGoBinary({ isPatched: false });
  fs.writeFileSync(testFile, origBuf);
  const origSha = crypto.createHash('sha256').update(origBuf).digest('hex');

  // 1. 首次解锁
  const applyRes = applyUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.needsRestart, true);
  assert.equal(applyRes.beforeSha256, origSha);
  assert.notEqual(applyRes.afterSha256, origSha);
  assert.ok(fs.existsSync(applyRes.backupPath));

  // 验证打补丁后的分析：静态未运行时准确判定为 patched_runtime_unconfirmed，绝不误报 verified_active
  const postAnalysis = analyzeBinary(testFile, { backupDir });
  assert.ok(postAnalysis.status === 'patched_runtime_unconfirmed' || postAnalysis.status === 'patched_pending_restart');
  assert.equal(postAnalysis.gate3a.status, 'patched');
  assert.equal(postAnalysis.gate3b.status, 'patched');

  // 当产生实际请求预算时，确证为 verified_active
  const verifiedAnalysis = analyzeBinary(testFile, { backupDir, currentBudget: 983040 });
  assert.equal(verifiedAnalysis.status, 'verified_active');
  assert.equal(verifiedAnalysis.statusText, '已验证生效');

  // 2. 幂等执行解锁：识别已打补丁，绝不把补丁覆盖为备份
  const applyRepeat = applyUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(applyRepeat.ok, true);
  assert.equal(applyRepeat.alreadyPatched, true);

  // 校验备份文件内容依然是原版
  const backupContent = fs.readFileSync(applyRes.backupPath);
  assert.equal(crypto.createHash('sha256').update(backupContent).digest('hex'), origSha);

  // 3. 恢复原版
  const restoreRes = restoreUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.needsRestart, true);

  const restoredSha = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  assert.equal(restoredSha, origSha);

  // 4. 重复恢复原版：幂等返回 alreadyRestored
  const restoreRepeat = restoreUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(restoreRepeat.ok, true);
  assert.equal(restoreRepeat.alreadyRestored, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('安全性：备份文件被篡改时拒绝恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-tamper-'));
  const testFile = path.join(tmpDir, 'language_server.exe');
  const backupDir = path.join(tmpDir, 'backups');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: false }));

  const applyRes = applyUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(applyRes.ok, true);

  // 篡改备份文件
  fs.writeFileSync(applyRes.backupPath, Buffer.from('TAMPERED_BACKUP'));

  const restoreRes = restoreUnlock({ targetPath: testFile, backupDir, platform: 'win32' });
  assert.equal(restoreRes.ok, false);
  assert.match(restoreRes.error, /备份文件已损坏或被篡改/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态流转细分：预算验证、已重启清除待重启标记与状态区分', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-states-'));
  const testFile = path.join(tmpDir, 'language_server.exe');
  const backupDir = path.join(tmpDir, 'backups');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true }));

  // 1. 预算大于 256,000 (如 983,040) 直接确认为 verified_active
  const resBudget = analyzeBinary(testFile, { backupDir, currentBudget: 983040 });
  assert.equal(resBudget.status, 'verified_active');
  assert.equal(resBudget.statusText, '已验证生效');
  assert.equal(resBudget.runtimeEvidence.budgetVerified, true);
  assert.match(resBudget.details, /983,040/);

  // 2. 静态未运行状态：进程未运行、文件未被占用，严禁误报 verified_active，准确判定为 patched_runtime_unconfirmed
  const resStatic = analyzeBinary(testFile, { backupDir });
  assert.equal(resStatic.status, 'patched_runtime_unconfirmed');
  assert.equal(resStatic.statusText, '磁盘已解锁，运行待确认');
  assert.match(resStatic.details, /未运行/);

  // 3. 运行中但进程路径与当前目标二进制不匹配（如另一路径的进程）：绝不能误报 verified_active
  const { synthesizeAnalysisStatus } = require('./meter-context-unlock');
  if (typeof synthesizeAnalysisStatus === 'function') {
    const mismatchedSynth = synthesizeAnalysisStatus({
      gate3a: { status: 'patched' },
      gate3b: { status: 'patched' },
      proc: {
        isRunning: true,
        path: path.join(tmpDir, 'other_directory', 'language_server.exe'), // 不匹配当前 target
        startTimeMs: Date.now() + 10000 // 即使时间戳晚于打补丁时间
      },
      target: testFile,
      stats: { mtimeMs: Date.now() }
    });
    assert.equal(mismatchedSynth.overallStatus, 'patched_runtime_unconfirmed');
    assert.match(mismatchedSynth.details, /未能确证目标进程加载路径/);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runtime context unlock preserves host ASAR module resolution', () => {
  const { execFileSync } = require('node:child_process');
  const script = "const before=process.noAsar;require('./meter-context-unlock');require('./asar-engine');require('node:assert/strict').equal(process.noAsar,before)";
  execFileSync(process.execPath, ['-e', script], { cwd: __dirname });
  const installer=fs.readFileSync(path.join(__dirname,'install.js'),'utf8');
  assert.match(installer.slice(installer.indexOf('const additions = [')), /'asar-engine\.js'/);
});

test('旧二进制清理机制：精准匹配 .old_*、保留无关文件与回滚保护', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-clean-'));
  try {
    const targetName = 'language_server.exe';
    // 构造测试文件
    const old1 = path.join(tmpDir, `${targetName}.old_123456789`);
    const old2 = path.join(tmpDir, `${targetName}.old_987654321`);
    const origBackup = path.join(tmpDir, `${targetName}_abc123.orig`);
    const normalExe = path.join(tmpDir, targetName);
    const otherOld = path.join(tmpDir, 'other_program.exe.old_123');

    fs.writeFileSync(old1, 'OLD_1');
    fs.writeFileSync(old2, 'OLD_2');
    fs.writeFileSync(origBackup, 'ORIG_BACKUP');
    fs.writeFileSync(normalExe, 'CURRENT_EXE');
    fs.writeFileSync(otherOld, 'OTHER_OLD');

    // 1. 执行清理，排除 old2（模拟正在占用）
    const res = cleanupOldReplacedFiles(tmpDir, targetName, old2);
    assert.deepEqual(res.cleaned, [`${targetName}.old_123456789`]);
    assert.equal(fs.existsSync(old1), false, '匹配的历史 old1 必须被清理');
    assert.equal(fs.existsSync(old2), true, '被排除/占用的 old2 必须保留');
    assert.equal(fs.existsSync(origBackup), true, '原版备份文件 .orig 绝对不能被误删');
    assert.equal(fs.existsSync(normalExe), true, '当前目标文件绝对不能被删除');
    assert.equal(fs.existsSync(otherOld), true, '其他程序的 old 文件绝对不能被删除');

    // 2. 清理全部
    const res2 = cleanupOldReplacedFiles(tmpDir, targetName);
    assert.deepEqual(res2.cleaned, [`${targetName}.old_987654321`]);
    assert.equal(fs.existsSync(old2), false, 'old2 也已被成功清理');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('主线程无阻塞验证：异步进程枚举期间 Node.js 事件循环持续处理任务', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-async-'));
  try {
    const testFile = path.join(tmpDir, 'language_server.exe');
    fs.writeFileSync(testFile, createMockGoBinary({ isPatched: false }));

    // 启动一个 1ms 的高频事件循环计数器
    let tickCount = 0;
    const interval = setInterval(() => {
      tickCount++;
    }, 1);

    // 调用异步分析
    const analysis = await analyzeBinaryAsync(testFile, { backupDir: tmpDir, forceRefresh: true, platform: 'win32' });
    clearInterval(interval);

    assert.equal(analysis.status, 'not_patched');
    // 在异步查询期间（哪怕只有几毫秒），高频定时器至少触发了一次以上，证明主事件循环未被同步冻结
    assert.ok(tickCount >= 1, `事件循环在异步查询期间必须持续流转 (tickCount=${tickCount})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('跨平台与安全架构拦截：非支持平台或架构明确拒绝写入', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-guard-'));
  try {
    const testFile = path.join(tmpDir, 'language_server');
    const mock = createMockGoBinary();
    fs.writeFileSync(testFile, mock);
    const textInfo = findTextSection(mock);
    assert.equal(textInfo.arch, 'x86-64');

    const darwinAnalyze = await analyzeBinaryAsync(testFile, { platform: 'darwin' });
    assert.equal(darwinAnalyze.status, 'unsupported');
    assert.equal(darwinAnalyze.isPlatformSupported, false);

    const darwinApply = applyUnlock({ targetPath: testFile, backupDir: tmpDir, platform: 'darwin' });
    assert.equal(darwinApply.ok, false);
    assert.equal(darwinApply.code, 'PLATFORM_UNSUPPORTED');

    const darwinRestore = restoreUnlock({ targetPath: testFile, backupDir: tmpDir, platform: 'darwin' });
    assert.equal(darwinRestore.ok, false);
    assert.equal(darwinRestore.code, 'PLATFORM_UNSUPPORTED');

    if (process.platform !== 'win32') {
      const hostApply = applyUnlock({ targetPath: testFile, backupDir: tmpDir });
      assert.equal(hostApply.ok, false);
      assert.equal(hostApply.code, 'PLATFORM_UNSUPPORTED');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
