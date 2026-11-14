'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  AUTHOR_INFO,
  DEFAULT_CHECKPOINT_TOKENS,
  MIN_ENGINEERING_LIMIT,
  MAX_ENGINEERING_LIMIT,
  validateContextLimit,
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
  syncExternalContextConfigs,
  getUnlockBackupDir,
  loadGate3BSidecar
} = require('./meter-context-unlock');

/**
 * 构造一个用于端到端单测的精简合法 x86-64 PE Go 二进制 Buffer
 */
function createMockGoBinary(options = {}) {
  const isPatched = options.isPatched === true;
  const breakSymbols = options.breakSymbols === true;
  const withDefaultSite = options.withDefaultSite === true;
  const jccType = options.jccType || 'rel8'; // 'rel8' | 'rel32'
  const peTimeDateStamp = options.peTimeDateStamp ?? 0x67101122;
  const peSizeOfImage = options.peSizeOfImage ?? 0x10000;

  // 1. DOS + PE Header
  const buf = Buffer.alloc(1024 * 64, 0);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  buf.writeUInt32LE(0x80, 0x3c); // PE header at 0x80

  const pe = 0x80;
  buf.write('PE\0\0', pe, 'ascii');
  buf.writeUInt16LE(0x8664, pe + 4); // x86-64
  buf.writeUInt16LE(1, pe + 6); // 1 section
  buf.writeUInt32LE(peTimeDateStamp >>> 0, pe + 8); // TimeDateStamp
  buf.writeUInt16LE(0xf0, pe + 20); // opt header size

  const opt = pe + 24;
  buf.writeBigUInt64LE(0x140000000n, opt + 24); // ImageBase
  buf.writeUInt32LE(peSizeOfImage >>> 0, opt + 56); // SizeOfImage

  const sect = opt + 0xf0;
  buf.write('.text\0\0\0', sect, 'ascii');
  buf.writeUInt32LE(0x1000, sect + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, sect + 12); // VirtualAddress
  buf.writeUInt32LE(0xe000, sect + 16); // SizeOfRawData
  buf.writeUInt32LE(0x200, sect + 20); // PointerToRawData

  const textOff = 0x200;
  const textVA = 0x140001000n;

  // 2. 函数体填充
  // Gate 3A: utils.GetCheckpointConfig (将 fn3a 扩展到足够覆盖 0x100~0x280，函数大小 0x200 即可；如果需要测多候选超范围在 0x3000 用自定义函数大小)
  const CLAMP_ORIG = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
  const CLAMP_PATCH = Buffer.concat([Buffer.from('89d6', 'hex'), Buffer.alloc(12, 0x90)]);
  const DEF_ORIG = Buffer.from('c7400c00e80300', 'hex');

  const fn3aOff = textOff + 0x100;
  buf.set(isPatched ? CLAMP_PATCH : CLAMP_ORIG, fn3aOff + 0x20);
  if (withDefaultSite) {
    if (options.partialDefLimit) {
      const defBuf = Buffer.from('c7400c00000000', 'hex');
      defBuf.writeUInt32LE(options.partialDefLimit >>> 0, 3);
      buf.set(defBuf, fn3aOff + 0x60);
    } else {
      buf.set(DEF_ORIG, fn3aOff + 0x60);
    }
  }
  if (options.extraClampNear) {
    buf.set(CLAMP_ORIG, fn3aOff + 0x40);
  }
  if (options.extraClampConstFar) {
    // 仍在 fn3a 体内若 fn3a 足够长（见下面 nextEntry 可调），或把主 default 放 fn3a 后端 >8192B
    const constBuf = Buffer.alloc(14, 0x90);
    constBuf[0] = 0xbe;
    constBuf.writeUInt32LE(512000, 1);
    buf.set(constBuf, fn3aOff + 0x100);
  }

  // Gate 3B: config.applyFeatureProviderCheckpointOverrideConfig
  const fn3bOff = textOff + (options.wideFn3a ? 0x3200 : 0x300);
  const fnSelOff = textOff + (options.wideFn3a ? 0x3400 : 0x500);

  const callDisp = (options.wideFn3a ? 0x3400 : 0x500) - ((options.wideFn3a ? 0x3200 : 0x300) + 0x10 + 5);
  buf[fn3bOff + 0x10] = 0xe8;
  buf.writeInt32LE(callDisp, fn3bOff + 0x11);
  buf[fn3bOff + 0x15] = 0x84; // test %al, %al
  buf[fn3bOff + 0x16] = 0xc0;
  const gate3bPatched = options.gate3bPatched !== undefined ? options.gate3bPatched : isPatched;
  if (gate3bPatched) {
    const len = jccType === 'rel32' ? 6 : 2;
    buf.fill(0x90, fn3bOff + 0x17, fn3bOff + 0x17 + len);
  } else if (jccType === 'rel32') {
    buf.set(Buffer.from('0f8512000000', 'hex'), fn3bOff + 0x17);
  } else {
    buf[fn3bOff + 0x17] = 0x75; // jne
    buf[fn3bOff + 0x18] = 0x08;
  }

  if (options.wideFn3a) {
    // 将主 clamp 放在偏移 0x2600（距 fn3aOff 0x2500），远端噪声在 fn3aOff+0x20，主 default 在 fn3aOff+0x2540（与主 clamp 在 ±8192 内）
    buf.fill(0x00, fn3aOff + 0x20, fn3aOff + 0x2e);
    buf.set(CLAMP_ORIG, fn3aOff + 0x20); // 距 default > 8192 (0x2540 - 0x20 = 0x2520 = 9504 > 8192!)
    buf.set(CLAMP_ORIG, fn3aOff + 0x2500);
    buf.set(DEF_ORIG, fn3aOff + 0x2540);
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
  const fn3bRelEntry = options.wideFn3a ? 0x3200 : 0x300;
  const fnSelRelEntry = options.wideFn3a ? 0x3400 : 0x500;
  const fnSelNext = options.wideFn3a ? 0x3600 : 0x700;

  buf.writeUInt32LE(0x100, pclnArray + 0); // entryoff
  buf.writeUInt32LE(0x800 - 0x400, pclnArray + 4); // funcoff (rec0)
  buf.writeUInt32LE(fn3bRelEntry, pclnArray + 8); // nextEntry

  buf.writeInt32LE(0, recBase + 0);
  buf.writeInt32LE(off1, recBase + 4); // nameoff

  // func 1: config.applyFeatureProviderCheckpointOverrideConfig
  buf.writeUInt32LE(fn3bRelEntry, pclnArray + 8);
  buf.writeUInt32LE(0x820 - 0x400, pclnArray + 12);
  buf.writeUInt32LE(fnSelRelEntry, pclnArray + 16);

  buf.writeInt32LE(0, recBase + 0x20);
  buf.writeInt32LE(off2, recBase + 0x24);

  // func 2: config.selectCheckpointExperimentKey
  buf.writeUInt32LE(fnSelRelEntry, pclnArray + 16);
  buf.writeUInt32LE(0x840 - 0x400, pclnArray + 20);
  buf.writeUInt32LE(fnSelNext, pclnArray + 24);

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

test('状态检测：仅观察到大于 256K 预算时绝不误判为真实请求已验证', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-verified-'));
  const testFile = path.join(tmpDir, 'mock_server.exe');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true }));

  const res = analyzeBinary(testFile, { currentBudget: 983040 });
  assert.equal(res.status, 'patched_runtime_unconfirmed');
  assert.equal(res.realRequestVerified, false);
  assert.equal(res.runtimeEvidence.realRequestVerified, false);
  assert.equal(res.runtimeEvidence.budgetObservedAbove256k, true);
  assert.match(res.details, /983,040/);
  assert.match(res.details, /尚未经过真实/);

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
  const applyRes = applyUnlock({ targetPath: testFile, backupDir });
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

  // 传入显示预算时仅记为参考观察值，严禁伪称已通过真实长请求验证
  const observedAnalysis = analyzeBinary(testFile, { backupDir, currentBudget: 983040 });
  assert.equal(observedAnalysis.status, 'patched_runtime_unconfirmed');
  assert.equal(observedAnalysis.realRequestVerified, false);
  assert.equal(observedAnalysis.runtimeEvidence.budgetObservedAbove256k, true);

  // 2. 幂等执行解锁：识别已打补丁，绝不把补丁覆盖为备份
  const applyRepeat = applyUnlock({ targetPath: testFile, backupDir });
  assert.equal(applyRepeat.ok, true);
  assert.equal(applyRepeat.alreadyPatched, true);

  // 校验备份文件内容依然是原版
  const backupContent = fs.readFileSync(applyRes.backupPath);
  assert.equal(crypto.createHash('sha256').update(backupContent).digest('hex'), origSha);

  // 3. 恢复原版
  const restoreRes = restoreUnlock({ targetPath: testFile, backupDir });
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.needsRestart, true);

  const restoredSha = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  assert.equal(restoredSha, origSha);

  // 4. 重复恢复原版：幂等返回 alreadyRestored
  const restoreRepeat = restoreUnlock({ targetPath: testFile, backupDir });
  assert.equal(restoreRepeat.ok, true);
  assert.equal(restoreRepeat.alreadyRestored, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('安全性：备份文件被篡改时拒绝恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-tamper-'));
  const testFile = path.join(tmpDir, 'language_server.exe');
  const backupDir = path.join(tmpDir, 'backups');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: false }));

  const applyRes = applyUnlock({ targetPath: testFile, backupDir });
  assert.equal(applyRes.ok, true);

  // 篡改备份文件
  fs.writeFileSync(applyRes.backupPath, Buffer.from('TAMPERED_BACKUP'));

  const restoreRes = restoreUnlock({ targetPath: testFile, backupDir });
  assert.equal(restoreRes.ok, false);
  assert.match(restoreRes.error, /备份文件已损坏或被篡改/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态流转细分：预算验证、已重启清除待重启标记与状态区分', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-states-'));
  const testFile = path.join(tmpDir, 'language_server.exe');
  const backupDir = path.join(tmpDir, 'backups');
  fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true }));

  // 1. 预算大于 256,000 时仅记录预算观察，不虚假标注为真实请求已验证
  const resBudget = analyzeBinary(testFile, { backupDir, currentBudget: 983040 });
  assert.equal(resBudget.status, 'patched_runtime_unconfirmed');
  assert.equal(resBudget.realRequestVerified, false);
  assert.equal(resBudget.runtimeEvidence.observedBudget, 983040);
  assert.equal(resBudget.runtimeEvidence.budgetObservedAbove256k, true);
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

    // 启动一个 5ms 的高频事件循环计数器
    let tickCount = 0;
    const interval = setInterval(() => {
      tickCount++;
    }, 5);

    // 调用异步分析
    const analysis = await analyzeBinaryAsync(testFile, { backupDir: tmpDir, forceRefresh: true });
    clearInterval(interval);

    assert.equal(analysis.status, 'not_patched');
    // 在异步查询期间（哪怕只有几十毫秒），高频定时器至少触发了一次以上，证明主事件循环未被同步冻结
    assert.ok(tickCount >= 1, `事件循环在异步查询期间必须持续流转 (tickCount=${tickCount})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('跨平台与安全架构拦截：非支持平台或架构明确拒绝写入', () => {
  // 模拟非法平台传入
  const origPlatform = process.platform;
  try {
    // 验证状态判定中的平台支持说明
    const mock = createMockGoBinary();
    const textInfo = findTextSection(mock);
    assert.equal(textInfo.arch, 'x86-64');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
  }
});

test('PR #3 算法融合：ORIG / CONST(512000/524288/自定义) / DYN 任意互切、幂等与 rel32 sidecar 恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-pr3-matrix-'));
  try {
    const testFile = path.join(tmpDir, 'language_server.exe');
    const backupDir = path.join(tmpDir, 'backups');
    const origBuf = createMockGoBinary({ isPatched: false, withDefaultSite: true, jccType: 'rel32' });
    fs.writeFileSync(testFile, origBuf);
    const origSha = crypto.createHash('sha256').update(origBuf).digest('hex');

    // 1. ORIG -> CONST(512000)（明确区分 512000 与 524288）
    const r512 = applyUnlock({ targetPath: testFile, backupDir, mode: 'fixed', limitTokens: 512000 });
    assert.equal(r512.ok, true);
    assert.equal(r512.configuredMode, 'fixed');
    assert.equal(r512.configuredLimitTokens, 512000);
    assert.equal(r512.defaultSitePatched, true);
    const st512 = analyzeBinary(testFile, { backupDir });
    assert.equal(st512.configuredMode, 'fixed');
    assert.equal(st512.configuredLimitTokens, 512000);
    assert.equal(st512.gate3a.defaultLimit, 512000);
    assert.equal(st512.gate3b.status, 'patched');
    assert.equal(st512.gate3b.length, 6);

    // 验证 Gate 3B 6字节 rel32 sidecar 记录准确
    const sidecar = loadGate3BSidecar(backupDir);
    assert.equal(sidecar.origHex, '0f8512000000');
    assert.equal(sidecar.length, 6);

    // 2. 同值幂等
    const r512Repeat = applyUnlock({ targetPath: testFile, backupDir, mode: 'fixed', limitTokens: 512000 });
    assert.equal(r512Repeat.ok, true);
    assert.equal(r512Repeat.alreadyMatched, true);

    // 3. CONST(512000) -> CONST(524288)
    const r524 = applyUnlock({ targetPath: testFile, backupDir, mode: 'fixed', limitTokens: 524288 });
    assert.equal(r524.ok, true);
    assert.equal(r524.configuredLimitTokens, 524288);
    const st524 = analyzeBinary(testFile, { backupDir });
    assert.equal(st524.configuredLimitTokens, 524288);
    assert.equal(st524.gate3a.defaultLimit, 524288);

    // 4. CONST(524288) -> 自定义非预设值 300000
    const r300 = applyUnlock({ targetPath: testFile, backupDir, mode: 'fixed', limitTokens: '300000' });
    assert.equal(r300.ok, true);
    const st300 = analyzeBinary(testFile, { backupDir, expectedLimit: 300000 });
    assert.equal(st300.configuredMode, 'fixed');
    assert.equal(st300.configuredLimitTokens, 300000);
    assert.equal(st300.gate3a.defaultLimit, 300000);

    // 5. CONST(300000) -> DYN（动态透传，不锁定 983040，且 default 站点切回 256000）
    const rDyn = applyUnlock({ targetPath: testFile, backupDir, mode: 'dynamic' });
    assert.equal(rDyn.ok, true);
    const stDyn = analyzeBinary(testFile, { backupDir });
    assert.equal(stDyn.configuredMode, 'dynamic');
    assert.equal(stDyn.configuredLimitTokens, null);
    assert.equal(stDyn.gate3a.defaultLimit, 256000);
    assert.match(stDyn.configuredSummary, /跟随模型/);

    // 6. DYN -> default 模式切换恢复官方 ORIG 与 rel32 Gate 3B 字节，SHA-256 必须与原版一致
    const rDef = applyUnlock({ targetPath: testFile, backupDir, mode: 'default' });
    assert.equal(rDef.ok, true);
    assert.equal(rDef.configuredMode, 'default');
    const restoredSha = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
    assert.equal(restoredSha, origSha);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('边界输入校验、部分匹配拒绝、多候选收窄与拒绝写入', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-guards-'));
  try {
    // 1. 输入整数范围与合理小窗口校验
    assert.equal(validateContextLimit(0).ok, false);
    assert.equal(validateContextLimit(-5000).ok, false);
    assert.equal(validateContextLimit(512000.5).ok, false);
    assert.equal(validateContextLimit('512k').ok, false);
    assert.equal(validateContextLimit(MIN_ENGINEERING_LIMIT - 1).ok, false);
    assert.equal(validateContextLimit(MAX_ENGINEERING_LIMIT + 1).ok, false);

    const smallValid = validateContextLimit(32768);
    assert.equal(smallValid.ok, true);
    assert.ok(smallValid.warnings.length >= 1, '小窗口必须给出输出预留空间警告');

    const overflowLimit = validateContextLimit(524288, { serviceLimit: 256000 });
    assert.equal(overflowLimit.ok, true);
    assert.ok(overflowLimit.warnings.some(w => w.includes('256,000')));

    // 2. 部分匹配状态：clamp(ORIG) 与 def(524288) 矛盾，拒绝写入
    const partialFile = path.join(tmpDir, 'partial.exe');
    fs.writeFileSync(partialFile, createMockGoBinary({ isPatched: false, withDefaultSite: true, partialDefLimit: 524288 }));
    const partialRes = analyzeBinary(partialFile);
    assert.equal(partialRes.status, 'partial_match');
    const applyPartial = applyUnlock({ targetPath: partialFile, backupDir: path.join(tmpDir, 'bak1'), mode: 'fixed', limitTokens: 512000 });
    assert.equal(applyPartial.ok, false);
    assert.equal(applyPartial.code, 'PARTIAL_MATCH');

    // 3. 混合状态：3A=patched 且 3B=unpatched，同样拒绝盲写
    const mixedFile = path.join(tmpDir, 'mixed.exe');
    fs.writeFileSync(mixedFile, createMockGoBinary({ isPatched: true, gate3bPatched: false }));
    assert.equal(analyzeBinary(mixedFile).status, 'partial_match');
    assert.equal(applyUnlock({ targetPath: mixedFile, backupDir: path.join(tmpDir, 'bak2'), mode: 'dynamic' }).ok, false);

    // 4. 多候选无法唯一收窄：同函数相邻两个 clamp 均在 default 8192 范围内，拒绝写入
    const ambFile = path.join(tmpDir, 'ambiguous.exe');
    fs.writeFileSync(ambFile, createMockGoBinary({ isPatched: false, withDefaultSite: true, extraClampNear: true }));
    const ambAnalysis = analyzeBinary(ambFile);
    assert.equal(ambAnalysis.gate3a.status, 'unknown');
    assert.match(ambAnalysis.gate3a.reason, /\d+\s*个\s*Gate 3A clamp 候选/);
    assert.equal(applyUnlock({ targetPath: ambFile, backupDir: path.join(tmpDir, 'bak3'), mode: 'dynamic' }).ok, false);

    // 5. 多候选可收窄：远离 default (>8192) 的噪声候选被排除，主候选成功收窄并写入
    const narrowFile = path.join(tmpDir, 'narrow.exe');
    fs.writeFileSync(narrowFile, createMockGoBinary({ isPatched: false, wideFn3a: true }));
    const narrowRes = applyUnlock({ targetPath: narrowFile, backupDir: path.join(tmpDir, 'bak4'), mode: 'fixed', limitTokens: 524288 });
    assert.equal(narrowRes.ok, true);
    assert.equal(analyzeBinary(narrowFile, { backupDir: path.join(tmpDir, 'bak4') }).configuredLimitTokens, 524288);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('版本漂移安全拦截：宿主升级导致 PE 指纹变更后拒绝还原旧备份与复用旧 sidecar', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-pe-drift-'));
  try {
    const testFile = path.join(tmpDir, 'language_server.exe');
    const backupDir = path.join(tmpDir, 'backups');

    // v1 打补丁生成备份与 Gate 3B sidecar
    fs.writeFileSync(testFile, createMockGoBinary({ isPatched: false, withDefaultSite: true, peTimeDateStamp: 0x11111111, peSizeOfImage: 0x10000 }));
    const r1 = applyUnlock({ targetPath: testFile, backupDir, mode: 'dynamic' });
    assert.equal(r1.ok, true);

    // 模拟官方升级覆盖了新版本（PE TimeDateStamp 与 SizeOfImage 改变，且已是新构建 patched 形态）
    fs.writeFileSync(testFile, createMockGoBinary({ isPatched: true, withDefaultSite: true, peTimeDateStamp: 0x22222222, peSizeOfImage: 0x12000 }));

    const driftStatus = analyzeBinary(testFile, { backupDir });
    assert.equal(driftStatus.hasBackup, true);
    assert.equal(driftStatus.backupValidForCurrentBinary, false);
    assert.equal(driftStatus.hasMatchingGate3BSidecar, false);
    assert.match(driftStatus.backupStaleReason, /PE 构建版本已变更/);

    // 尝试用旧备份恢复或无有效 sidecar 切回 default 时，必须严格拒绝！
    const restoreDrift = restoreUnlock({ targetPath: testFile, backupDir });
    assert.equal(restoreDrift.ok, false);
    assert.equal(restoreDrift.code, 'BACKUP_VERSION_MISMATCH');

    const switchDefaultDrift = applyUnlock({ targetPath: testFile, backupDir, mode: 'default' });
    assert.equal(switchDefaultDrift.ok, false);
    assert.equal(switchDefaultDrift.code, 'MISSING_OR_STALE_GATE3B_SIDECAR');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleRestartHost: 正常触发 app.relaunch + app.quit，无能力时返回 supported: false', async () => {
  const { handleRestartHost, setAppQuitting, getAppQuitting } = require('./meter-main');
  const localEvent = { senderFrame: { url: 'https://127.0.0.1:443/chat' } };

  await assert.rejects(
    () => handleRestartHost({ senderFrame: { url: 'https://example.com/' } }),
    /仅允许本机主聊天窗口/
  );

  // 1. 纯 Node 环境无 Electron app 时明确返回 supported: false
  const noAppRes = await handleRestartHost(localEvent);
  assert.deepEqual(noAppRes, { ok: true, supported: false });

  // 2. 注入模拟 Electron app 验证顺序执行 setAppQuitting(true) -> relaunch -> quit
  const calls = [];
  const fakeApp = {
    relaunch: (opts) => calls.push(['relaunch', opts]),
    quit: () => calls.push(['quit'])
  };
  try {
    setAppQuitting(false);
    const okRes = await handleRestartHost(localEvent, { appOverride: fakeApp, args: ['--test'], delayMs: 0 });
    assert.deepEqual(okRes, { ok: true, supported: true });
    assert.equal(getAppQuitting(), true);
    assert.deepEqual(calls, [
      ['relaunch', { args: ['--test'] }],
      ['quit']
    ]);
  } finally {
    setAppQuitting(false);
  }
});

test('1M 应用回归：函数体内存在额外 1000000 干扰常量时仍准确收窄唯一 Gate 3A 并可互切还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-unlock-1m-'));
  try {
    const binPath = path.join(tmpDir, 'language_server.exe');
    const backupDir = path.join(tmpDir, 'backups');
    const mockBuf = createMockGoBinary({ withDefaultSite: true });
    // 查找 textOff + 0x100 + 0x60 处刚写入的 DEF_ORIG (c7 40 0c 00 e8 03 00) 并为其前驱补上 jg +7 (7f 07)
    const defSig = Buffer.from('c7400c00e80300', 'hex');
    const defIdx = mockBuf.indexOf(defSig);
    assert.ok(defIdx > 10);
    mockBuf[defIdx - 2] = 0x7f;
    mockBuf[defIdx - 1] = 0x07;
    // 在同函数体内随后偏移放置一个不相关的 c7 40 0c <1000000> 常量
    const noiseBuf = Buffer.from('488990a8000000c7400c40420f00', 'hex');
    mockBuf.set(noiseBuf, defIdx + 0x20);
    fs.writeFileSync(binPath, mockBuf);

    // 1. 直接应用 1000000，不得因 1000000 常量而出现双候选失败
    const res1M = await applyUnlock({ targetPath: binPath, backupDir, homeDir: tmpDir, mode: 'fixed', limitTokens: 1000000 });
    assert.equal(res1M.ok, true, `1M 应用应成功，实际错误: ${res1M.error}`);
    assert.equal(res1M.configuredMode, 'fixed');
    assert.equal(res1M.configuredLimitTokens, 1000000);

    // 2. 切回 512000 与 dynamic，并还原原版
    const res512 = await applyUnlock({ targetPath: binPath, backupDir, homeDir: tmpDir, mode: 'fixed', limitTokens: 512000 });
    assert.equal(res512.ok, true);
    assert.equal(res512.configuredLimitTokens, 512000);

    const resDyn = await applyUnlock({ targetPath: binPath, backupDir, homeDir: tmpDir, mode: 'dynamic' });
    assert.equal(resDyn.ok, true);
    assert.equal(resDyn.configuredMode, 'dynamic');

    const resRestore = restoreUnlock({ targetPath: binPath, backupDir, homeDir: tmpDir });
    assert.equal(resRestore.ok, true);
    const { analyzeBinaryAsync } = require('./meter-context-unlock');
    const afterRestore = await analyzeBinaryAsync(binPath);
    assert.equal(afterRestore.status, 'not_patched');

    // 3. 验证 failed 状态保留具体 gate3a.reason
    const { synthesizeAnalysisStatus } = require('./meter-context-unlock');
    const failedSynth = synthesizeAnalysisStatus({
      target: binPath,
      gate3a: { status: 'failed', reason: '检测到 2 个 Gate 3A default 候选且无法唯一收窄' },
      gate3b: { status: 'original' }
    });
    assert.equal(failedSynth.overallStatus, 'failed');
    assert.ok(failedSynth.details.includes('Gate 3A'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PR #3 CLI serializer 门禁互切及外部配置文件 / context-mode.json 精确同步', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-unlock-ext-'));
  try {
    const binPath = path.join(tmpDir, 'language_server.exe');
    const backupDir = path.join(tmpDir, 'backups');
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });

    const mockBuf = createMockGoBinary({ withDefaultSite: true });
    // 放入 CLI serializer 原生特征 `4889442470488b8c24a80100008908b830000000` 到可用代码空间
    const serStock = Buffer.from('4889442470488b8c24a80100008908b830000000', 'hex');
    const serOffset = mockBuf.indexOf(Buffer.from('c7400c00e80300', 'hex')) + 0x40;
    serStock.copy(mockBuf, serOffset);
    fs.writeFileSync(binPath, mockBuf);

    // 1. Fixed 1000000: serializer 改写 mov dword [rax], 1000000 (c700 40420f00), config.json 与 context-mode.json 同步
    const rFixed = await applyUnlock({ targetPath: binPath, backupDir, mode: 'fixed', limitTokens: 1000000, homeDir: fakeHome });
    assert.equal(rFixed.ok, true);
    const patchedSerSlice = fs.readFileSync(binPath).subarray(serOffset + 5, serOffset + 11);
    assert.equal(patchedSerSlice.toString('hex'), 'c70040420f00');

    const { readExternalContextConfig } = require('./meter-context-unlock');
    const extFixed = readExternalContextConfig({ homeDir: fakeHome });
    assert.equal(extFixed.configContextWindow, '1000K');
    assert.equal(extFixed.contextModeBridge.effectiveMode, 'fixed');
    assert.equal(extFixed.contextModeBridge.limitTokens, 1000000);

    // 2. Dynamic: serializer 恢复 SERIALIZER_STOCK_X64 透传，context-mode.json 不冒充 983040
    const rDyn = await applyUnlock({ targetPath: binPath, backupDir, mode: 'dynamic', homeDir: fakeHome });
    assert.equal(rDyn.ok, true);
    assert.equal(Buffer.compare(fs.readFileSync(binPath).subarray(serOffset, serOffset + serStock.length), serStock), 0);
    const extDyn = readExternalContextConfig({ homeDir: fakeHome });
    assert.equal(extDyn.configContextWindow, null);
    assert.equal(extDyn.contextModeBridge.effectiveMode, 'dynamic');
    assert.equal(extDyn.contextModeBridge.limitTokens, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安全隔离回归：测试下缺失或拼错 targetPath 绝对禁止探测或写入系统安装目录', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-unlock-iso-'));
  try {
    const mockExe = path.join(tmpDir, 'mock_ls.exe');
    fs.writeFileSync(mockExe, createMockGoBinary({ withDefaultSite: true }));
    const backupDir = path.join(tmpDir, 'backups');

    // 1. 拼错字段 binPath，即使 backupDir 存在或缺失均直接拒绝
    const typo1 = applyUnlock({ binPath: mockExe, backupDir, mode: 'fixed', limitTokens: 1000000 });
    assert.equal(typo1.ok, false);
    assert.equal(typo1.code, 'INVALID_TARGET_OPTION');

    const typo2 = applyUnlock({ binPath: mockExe, mode: 'fixed', limitTokens: 512000 });
    assert.equal(typo2.ok, false);
    assert.equal(typo2.code, 'INVALID_TARGET_OPTION');

    const typoRestore = restoreUnlock({ binaryPath: mockExe });
    assert.equal(typoRestore.ok, false);
    assert.equal(typoRestore.code, 'INVALID_TARGET_OPTION');

    // 2. 在 node --test 下未指定 targetPath 直接拒绝回退 detectTargetBinary()
    const missingApply = applyUnlock({ mode: 'dynamic' });
    assert.equal(missingApply.ok, false);
    assert.equal(missingApply.code, 'MISSING_TARGET_PATH');

    const missingRestore = restoreUnlock({});
    assert.equal(missingRestore.ok, false);
    assert.equal(missingRestore.code, 'MISSING_TARGET_PATH');

    // 3. 验证 mockExe 与隔离外部配置目录未受写入污染
    const fakeHome = path.join(tmpDir, 'home');
    const syncedNoHome = syncExternalContextConfigs('fixed', 512000, { backupDir, targetPath: mockExe, syncConfigFiles: true });
    assert.deepEqual(syncedNoHome, [], '隔离上下文缺失 homeDir 时不得写入真实主目录');
    assert.equal(fs.existsSync(fakeHome), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
