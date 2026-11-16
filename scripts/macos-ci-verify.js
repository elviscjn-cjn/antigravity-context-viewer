'use strict';

/**
 * macOS CI 真机 Mach-O 编译、Apple codesign 重签名/entitlements 保留、原生执行及失败回滚实测脚本。
 * 仅在 macOS runner 的系统临时隔离目录中运行，绝不改动宿主机系统文件或真实用户配置。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');

const { parseMachO64 } = require('../macos-binary-utils');
const unlock = require('../meter-context-unlock');
const enhance = require('../meter-enhance');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function runAndVerifyExec(binPath, label) {
  const ver = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', binPath], { encoding: 'utf8' });
  console.log(`[CI][${label}] codesign verify exit=${ver.status}\n${ver.stderr || ver.stdout || ''}`.trim());
  assert.equal(ver.status, 0, `[${label}] codesign --verify --deep --strict 必须通过`);

  const ent = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', binPath], { encoding: 'utf8' });
  const entText = String(ent.stdout || '') + String(ent.stderr || '');
  assert.ok(entText.includes('com.apple.security.cs.allow-jit'), `[${label}] 必须保留原始 entitlements (allow-jit)`);

  const run = spawnSync(binPath, [], { encoding: 'utf8', timeout: 5000 });
  console.log(`[CI][${label}] exec exit=${run.status} signal=${run.signal || 'none'} stdout=${JSON.stringify((run.stdout || '').trim())}`);
  assert.equal(run.signal, null, `[${label}] 进程不得被 AMFI/签名校验 SIGKILL`);
  assert.equal(run.status, 0, `[${label}] 可执行文件运行退出码必须为 0`);
  assert.match(run.stdout || '', /MACOS_CI_REAL_MACHO_OK/);
}

function buildClangArm64Source() {
  const titleRules = enhance.CHINESE_TITLE_RULES || [];
  const ruleDecls = titleRules
    .map((r, i) => `__attribute__((section("__TEXT,__cstring"))) __attribute__((used)) static const char title_rule_${i}[] = ${JSON.stringify(r.oldText)};`)
    .join('\n');

  const slots = [
    { name: 'identity.tmpl', text: 'You are Antigravity, an agentic AI coding assistant.' },
    { name: 'guidelines.tmpl', text: 'G'.repeat(700) },
    { name: 'function_call.tmpl', text: 'F'.repeat(605) },
    { name: 'communication_style.tmpl', text: 'C'.repeat(2034) },
    { name: 'slash_commands.tmpl', text: 'S'.repeat(600) },
    { name: 'plugins.tmpl', text: 'P'.repeat(600) },
    { name: 'artifacts.tmpl', text: 'A'.repeat(1200) }
  ];
  const prefix = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';

  const slotDecls = slots.map((s, i) => `
__attribute__((section("__TEXT,__const"))) __attribute__((used)) static const char slot_name_${i}[] = ${JSON.stringify(prefix + s.name)};
__attribute__((section("__TEXT,__const"))) __attribute__((used)) static const char slot_body_${i}[] = ${JSON.stringify(s.text)};
`).join('\n');

  const tableDecls = slots.map((s, i) => `
  { slot_name_${i}, sizeof(slot_name_${i}) - 1, slot_body_${i}, sizeof(slot_body_${i}) - 1 },
`).join('');

  return `
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>

typedef struct {
  const char *namePtr;
  uint64_t nameLen;
  const char *bodyPtr;
  uint64_t bodyLen;
} EmbedSlot;

${ruleDecls}
${slotDecls}

__attribute__((section("__DATA,__const"))) __attribute__((used)) static const EmbedSlot g_embed_slots[${slots.length}] = {
${tableDecls}
};

/* 预留 64KB 合法数据槽，随后写入对齐 textVA 的 Go pclntab 测试表 */
__attribute__((section("__DATA,__data"))) __attribute__((used)) unsigned char g_pcln_area[65536] = { 0xDE, 0xAD, 0xBE, 0xEF };

/* 在 __TEXT,__text 放入可被扫描定位但不会被 main 调用的合法 ARM64 Gate 指令序列 */
#if defined(__aarch64__)
__attribute__((noinline, used)) void ag_mock_arm64_gates(void) {
  __asm__ volatile (
    "b 1f\\n"
    ".space 0x100, 0\\n"
    /* Gate 3A clamp: cmp + mov 256000 + csel */
    ".byte 0x04,0x00,0x9d,0xd2, 0x64,0x00,0xa0,0xf2, 0x7f,0x00,0x04,0x6b, 0x04,0x00,0x9d,0xd2, 0x64,0x00,0xa0,0xf2, 0x63,0x30,0x84,0x9a\\n"
    ".space 0xe0, 0\\n"
    /* Gate 3A default: cmp w3,#0; b.gt +16; mov x3,#0xe800; movk x3,#3; str w3,[x0,#12] */
    ".byte 0x7f,0x00,0x00,0x71, 0x8c,0x00,0x00,0x54, 0x03,0x00,0x9d,0xd2, 0x63,0x00,0xa0,0xf2, 0x03,0x0c,0x00,0xb9\\n"
    ".space 0x100, 0\\n"
    /* selectCheckpointExperimentKey marker */
    ".byte 0xe1,0x03,0x01,0xaa\\n"
    ".byte 0x13,0x37,0xca,0xfe\\n"
    ".space 0xe0, 0\\n"
    /* applyFeatureProviderCheckpointOverrideConfig: bl placeholder + mov x1,x1 (不用 nop 避免误判为 Gate 3B 已 patched) + tbnz w0, #0, +12 */
    ".byte 0x04,0x00,0x00,0x14\\n"
    ".byte 0xe1,0x03,0x01,0xaa\\n"
    ".byte 0xe1,0x03,0x01,0xaa\\n"
    ".byte 0x60,0x00,0x00,0x37\\n"
    "1:\\n"
    "ret\\n"
  );
}
#else
__attribute__((noinline, used)) void ag_mock_arm64_gates(void) {}
#endif

int main(void) {
  volatile uintptr_t anchor = (uintptr_t)&ag_mock_arm64_gates + (uintptr_t)g_embed_slots[0].nameLen + g_pcln_area[0] + (uintptr_t)title_rule_0[0];
  (void)anchor;
  puts("MACOS_CI_REAL_MACHO_OK");
  return 0;
}
`;
}

function populateRealMachOGoMetadata(binPath) {
  const buf = fs.readFileSync(binPath);
  const macho = parseMachO64(buf);
  assert.ok(macho && macho.format === 'Mach-O' && macho.arch === 'arm64', 'Clang 产物必须为有效 Mach-O arm64');
  assert.equal(macho.hasLinkedit, true, 'Clang 产物必须含 __LINKEDIT');

  const textSect = macho.sections.find(s => s.sectname === '__text');
  assert.ok(textSect, '必须存在 __TEXT,__text');

  // 定位 Gate 3A / 3B 字节特征以精确填写入 Go .gopclntab entry 偏移（相对于 textOff）
  const clampSig = Buffer.from('04009dd26400a0f27f00046b04009dd26400a0f26330849a', 'hex');
  const clampOff = buf.indexOf(clampSig, textSect.offset);
  assert.ok(clampOff >= textSect.offset && clampOff < textSect.offset + textSect.size, '应在 __text 中找到 Gate 3A clamp');

  const markerOff = buf.indexOf(Buffer.from('1337cafe', 'hex'), clampOff);
  assert.ok(markerOff > clampOff, '应在 __text 中找到实验函数占位');

  const tbnzOff = buf.indexOf(Buffer.from('60000037', 'hex'), markerOff);
  assert.ok(tbnzOff > markerOff + 12, '应在 __text 中找到 tbnz 指令');
  const blOff = tbnzOff - 12;
  // 写入从 blOff 跳转到 markerOff 的精确 ARM64 BL 相对位移
  const deltaWords = (markerOff - blOff) >> 2;
  const blInst = (0x94000000 | (deltaWords & 0x03ffffff)) >>> 0;
  buf.writeUInt32LE(blInst, blOff);

  const pcBase = buf.indexOf(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  assert.ok(pcBase > 0, '应定位 __DATA,__data 中的 g_pcln_area');

  const rel = (absOff) => absOff - textSect.offset;
  const funcs = [
    { name: 'google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig', entry: Math.max(0, rel(clampOff) - 0x40) },
    { name: 'google3/third_party/jetski/cortex/config/config.selectCheckpointExperimentKey', entry: rel(markerOff) },
    { name: 'google3/third_party/jetski/cortex/config/config.applyFeatureProviderCheckpointOverrideConfig', entry: rel(blOff) - 8 }
  ];

  const fnNameOff = 0x100;
  const pclnOff = 0x800;
  buf.fill(0, pcBase, pcBase + 0x4000);
  buf.writeUInt32LE(0xfffffff1, pcBase);
  buf[pcBase + 6] = 4;
  buf[pcBase + 7] = 8;
  buf.writeBigUInt64LE(1001n, pcBase + 8);
  buf.writeBigUInt64LE(BigInt(fnNameOff), pcBase + 32);
  buf.writeBigUInt64LE(BigInt(pclnOff), pcBase + 64);

  let strPos = pcBase + fnNameOff;
  for (let i = 0; i < funcs.length; i++) {
    const f = funcs[i];
    const relName = strPos - (pcBase + fnNameOff);
    buf.write(f.name + '\0', strPos, 'ascii');
    strPos += f.name.length + 1;
    const recOff = 1002 * 8 + i * 16;
    buf.writeUInt32LE(f.entry, pcBase + pclnOff + i * 8);
    buf.writeUInt32LE(recOff, pcBase + pclnOff + i * 8 + 4);
    buf.writeInt32LE(relName, pcBase + pclnOff + recOff + 4);
  }
  buf.writeUInt32LE(rel(tbnzOff) + 0x40, pcBase + pclnOff + funcs.length * 8);
  fs.writeFileSync(binPath, buf);
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[CI] 非 macOS 平台，跳过真机 codesign 实测');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-macos-ci-real-'));
  try {
    console.log(`[CI] 隔离临时工作目录: ${workDir} | arch=${process.arch}`);
    const entPlist = path.join(workDir, 'entitlements.plist');
    fs.writeFileSync(entPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>\n`, 'utf8');

    // 1. 若在 Intel Mac (x64) 或测试跨架构拦截，编译 x86_64 Mach-O 并验证严格拒绝写入
    const cSrcPath = path.join(workDir, 'sample.c');
    fs.writeFileSync(cSrcPath, buildClangArm64Source(), 'utf8');

    if (process.arch === 'x64') {
      const intelBin = path.join(workDir, 'language_server_x86_64');
      execFileSync('clang', ['-O0', cSrcPath, '-o', intelBin], { stdio: 'inherit' });
      execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entPlist, intelBin], { stdio: 'inherit' });
      const origSha = sha256File(intelBin);
      const st = unlock.analyzeBinary(intelBin, { backupDir: path.join(workDir, 'bak_x64'), skipProcessCheck: true });
      assert.equal(st.format, 'Mach-O');
      assert.equal(st.arch, 'x86-64');
      assert.equal(st.status, 'unsupported');
      const applyRes = unlock.applyUnlock({ targetPath: intelBin, backupDir: path.join(workDir, 'bak_x64'), mode: 'fixed', limitTokens: 512000 });
      assert.equal(applyRes.ok, false);
      assert.equal(sha256File(intelBin), origSha, 'Intel x86-64 原文件 SHA256 必须零变化');
      console.log(`[CI][x64-reject] 原文件 SHA256=${origSha} 拒绝写入验证通过`);
      return;
    }

    // 2. 在 Apple Silicon (arm64) 真机编译、签名并执行真实 Mach-O 二进制全链路
    const binPath = path.join(workDir, 'language_server');
    const bakDir = path.join(workDir, 'bak_arm64');
    const enhBakDir = path.join(workDir, 'enh_bak');
    const stateDir = path.join(workDir, 'state');

    execFileSync('clang', ['-arch', 'arm64', '-O0', cSrcPath, '-o', binPath], { stdio: 'inherit' });
    populateRealMachOGoMetadata(binPath);
    execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entPlist, binPath], { stdio: 'inherit' });

    const origSha = sha256File(binPath);
    console.log(`[CI][arm64] 原始已签名样本 SHA256=${origSha}`);
    runAndVerifyExec(binPath, 'ORIGINAL');

    // 3. 编译一个 x86_64 样本也在 arm64 上检验跨架构绝不误写
    const x64OnlyC = path.join(workDir, 'intel_stub.c');
    const intelStub = path.join(workDir, 'language_server_intel');
    fs.writeFileSync(x64OnlyC, 'int main(void){return 0;}\n');
    execFileSync('clang', ['-arch', 'x86_64', x64OnlyC, '-o', intelStub], { stdio: 'inherit' });
    const intelOrigSha = sha256File(intelStub);
    const intelReject = unlock.applyUnlock({ targetPath: intelStub, backupDir: path.join(workDir, 'bak_i'), mode: 'fixed', limitTokens: 512000 });
    assert.equal(intelReject.ok, false);
    assert.equal(sha256File(intelStub), intelOrigSha);
    console.log(`[CI][arm64-reject-x64] x86_64 样本拒绝写入验证通过 SHA256=${intelOrigSha}`);

    // 4. 先测试 codesign 失败（使用 /usr/bin/false 作为 codesignBin）必须完全回滚不破坏原文件
    const csFailRes = unlock.applyUnlock({
      targetPath: binPath,
      backupDir: bakDir,
      mode: 'fixed',
      limitTokens: 512000,
      codesignBin: '/usr/bin/false'
    });
    assert.equal(csFailRes.ok, false);
    assert.equal(csFailRes.code, 'MACOS_CODESIGN_OR_WRITE_FAILED');
    assert.equal(sha256File(binPath), origSha, 'codesign 失败回滚后原文件 SHA256 必须一字节不变');
    console.log(`[CI][codesign-fail-rollback] 失败回滚成功，SHA256 保持 ${origSha}`);

    // 5. 正式应用上下文解锁（真 codesign ad-hoc + entitlements 保留）
    const unlockRes = unlock.applyUnlock({
      targetPath: binPath,
      backupDir: bakDir,
      mode: 'fixed',
      limitTokens: 512000
    });
    assert.equal(unlockRes.ok, true, unlockRes.error);
    assert.equal(unlockRes.signatureMode, 'ad-hoc');
    assert.equal(unlockRes.entitlementsPreserved, true);
    const afterUnlockSha = sha256File(binPath);
    assert.notEqual(afterUnlockSha, origSha);
    console.log(`[CI][arm64-unlocked] 补丁后 SHA256=${afterUnlockSha}`);
    runAndVerifyExec(binPath, 'UNLOCKED_512K');

    // 6. 还原上下文解锁备份 -> 验证 SHA256 精确回到 origSha（字节一致+苹果原基线一致）
    const revUnlock = unlock.restoreUnlock({ targetPath: binPath, backupDir: bakDir });
    assert.equal(revUnlock.ok, true, revUnlock.error);
    const restoredUnlockSha = sha256File(binPath);
    assert.equal(restoredUnlockSha, origSha, '恢复备份后 SHA256 必须 100% 还原至原始基线');
    console.log(`[CI][arm64-restored] 恢复后 SHA256=${restoredUnlockSha}`);
    runAndVerifyExec(binPath, 'RESTORED_UNLOCK');

    // 7. 若 embed.FS 槽位也在真实 Clang 段中被连续排列并可定位，同时实测增强补丁（跳过仅因 Clang 对静态结构体插重定位导致的差异，若检测到则返回支持状态）
    const enhOpts = {
      targets: [{ id: 'desktop', label: 'macOS CI Binary', path: binPath }],
      enhanceBackupDir: enhBakDir,
      backupDir: bakDir,
      stateDir,
      skipProcessCheck: true
    };
    const enhSt = await enhance.getEnhanceStatusAsync(enhOpts);
    console.log(`[CI][enhance-status] supported=${enhSt.supported} titleMatched=${enhSt.summary?.titleMatchedCount ?? 0} slotCount=${enhSt.summary?.slotCount ?? 0}`);
    if (enhSt.supported && (enhSt.summary?.titleMatchedCount || 0) > 0) {
      const enhApply = await enhance.applyEnhancePatchAsync({ chineseTitle: true }, enhOpts);
      assert.equal(enhApply.ok, true);
      runAndVerifyExec(binPath, 'ENHANCED_TITLE');
      const enhRestore = await enhance.restoreAllEnhanceAsync(enhOpts);
      assert.equal(enhRestore.ok, true);
      assert.equal(sha256File(binPath), origSha);
      runAndVerifyExec(binPath, 'RESTORED_ENHANCE');
    }

    // 8. 隔离目录下测试 node cli.js check 与 node cli.js status 不抛未预期崩溃且尊重 --path
    const cli = path.join(__dirname, '..', 'cli.js');
    const dummyAsar = path.join(workDir, 'app.asar');
    const asar = require('../asar-engine');
    const asarFixtureDir = path.join(workDir, 'asar_src');
    fs.mkdirSync(path.join(asarFixtureDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(asarFixtureDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.99.0' }));
    fs.writeFileSync(path.join(asarFixtureDir, 'dist', 'utils.js'), '// dummy');
    await asar.builtinAsar.createPackage(asarFixtureDir, dummyAsar);

    const checkRun = spawnSync(process.execPath, [cli, 'check', '--path', dummyAsar], {
      encoding: 'utf8',
      env: { ...process.env, AG_METER_STATE_DIR: stateDir, AG_METER_TEST_MODE: '1' }
    });
    console.log('[CI][cli check]\n' + (checkRun.stdout || '') + (checkRun.stderr || ''));
    assert.equal(checkRun.status, 0);

    const statusRun = spawnSync(process.execPath, [cli, 'status', '--path', dummyAsar], {
      encoding: 'utf8',
      env: { ...process.env, AG_METER_STATE_DIR: stateDir, AG_METER_TEST_MODE: '1' }
    });
    console.log('[CI][cli status]\n' + (statusRun.stdout || ''));
    assert.equal(statusRun.status, 0);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[CI FAILED]', err);
  process.exitCode = 1;
});
