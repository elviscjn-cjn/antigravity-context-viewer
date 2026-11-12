'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONTEXT_SIGNATURES,
  CHINESE_TITLE_RULES,
  parsePeEmbedTemplates,
  isSamePeBuild,
  getKernelStatus,
  applyKernelPatch
} = require('./meter-patcher');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 构造一个合法的合成 PE64 二进制，内含：
 * - 标准 MZ + PE32+ 头与单个 .rdata/.text 混合节区
 * - Go embed.FS 48 字节切片结构与真实容量级别的 .tmpl 槽位
 * - v2.29 genericsystemprompt.applyEdits 子串校验特征字节码
 * - Desktop/CLI 上下文窗口 3 处门禁特征字节码
 */
function buildSyntheticKernelBinary(options = {}) {
  const timeDateStamp = options.timeDateStamp || 0x67001234;
  const extraPad = options.extraPad || 0;
  const totalSize = 65536 + extraPad;
  const buf = Buffer.alloc(totalSize, 0);

  const peOffset = 0x80;
  const imageBase = 0x140000000n;
  const optHeaderSize = 0xf0;
  const numSections = 1;

  // MZ Header
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOffset, 0x3c);

  // PE Signature + COFF Header
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(0x8664, peOffset + 4); // AMD64
  buf.writeUInt16LE(numSections, peOffset + 6);
  buf.writeUInt32LE(timeDateStamp, peOffset + 8);
  buf.writeUInt16LE(optHeaderSize, peOffset + 20);
  buf.writeUInt16LE(0x0022, peOffset + 22);

  // Optional Header (PE32+)
  const optOff = peOffset + 24;
  buf.writeUInt16LE(0x020b, optOff); // PE32+ magic
  buf.writeBigUInt64LE(imageBase, optOff + 24);
  buf.writeUInt32LE(totalSize, optOff + 56); // SizeOfImage

  // Section 0: rawPtr = 0x400, vAddr = 0x1000
  const secOff = optOff + optHeaderSize;
  const vAddr = 0x1000;
  const rawPtr = 0x400;
  const rawSize = totalSize - rawPtr;
  buf.write('.rdata\0\0', secOff, 'ascii');
  buf.writeUInt32LE(rawSize, secOff + 8); // VirtualSize
  buf.writeUInt32LE(vAddr, secOff + 12); // VirtualAddress
  buf.writeUInt32LE(rawSize, secOff + 16); // SizeOfRawData
  buf.writeUInt32LE(rawPtr, secOff + 20); // PointerToRawData

  const foffToVa = foff => imageBase + BigInt(vAddr + (foff - rawPtr));

  const prefix = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';
  const slotDefs = [
    ['artifacts.tmpl', '<artifacts>\nOfficial stock artifacts guidance.\n</artifacts>\n'.padEnd(900, 'A')],
    ['communication_style.tmpl', 'Stock communication style rules.\n'.padEnd(2034, 'C')],
    ['conversation_transcript.tmpl', 'Stock transcript format rules.\n'.padEnd(600, 'T')],
    ['function_call.tmpl', 'Stock function call instructions.\n'.padEnd(605, 'F')],
    ['guidelines.tmpl', 'Stock behavioral guidelines.\n'.padEnd(720, 'G')],
    ['identity.tmpl', 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team.\n'.padEnd(400, 'I')],
    ['persistent_context.tmpl', 'Stock persistent context instructions.\n'.padEnd(500, 'P')],
    ['skills.tmpl', 'Stock skills loader instructions.\n'.padEnd(450, 'S')],
    ['slash_commands.tmpl', 'Available slash commands: /goal /boost\n'.padEnd(320, 'L')]
  ];

  let cursor = rawPtr + 0x200 + extraPad;
  const entries = [];

  for (const [name, content] of slotDefs) {
    const fullName = prefix + name;
    const nameBytes = Buffer.from(fullName, 'utf8');
    const nameOff = cursor;
    nameBytes.copy(buf, nameOff);
    cursor += nameBytes.length + 16;

    const dataBytes = Buffer.from(content, 'utf8');
    const dataOff = cursor;
    dataBytes.copy(buf, dataOff);
    cursor += dataBytes.length + 16;

    entries.push({
      nameVa: foffToVa(nameOff),
      nameLen: nameBytes.length,
      dataVa: foffToVa(dataOff),
      dataLen: dataBytes.length
    });
  }

  // 写入连续的 48 字节 Go embed.FS 文件切片数组
  cursor = (cursor + 63) & ~63;
  for (const item of entries) {
    buf.writeBigUInt64LE(item.nameVa, cursor);
    buf.writeBigUInt64LE(BigInt(item.nameLen), cursor + 8);
    buf.writeBigUInt64LE(item.dataVa, cursor + 16);
    buf.writeBigUInt64LE(BigInt(item.dataLen), cursor + 24);
    cursor += 48;
  }

  // 写入 v2.29 genericsystemprompt.applyEdits 校验指令序列
  cursor += 64;
  const applyPrefix = Buffer.from('488b71104889742458488b711848897424384889d1', 'hex');
  const dummyCall = Buffer.from('e811223344', 'hex');
  const applyTailStock = Buffer.from('4883f8010f8474ffffff', 'hex');
  const applyEditsOffset = cursor;
  applyPrefix.copy(buf, cursor);
  cursor += applyPrefix.length;
  dummyCall.copy(buf, cursor);
  cursor += dummyCall.length;
  applyTailStock.copy(buf, cursor);
  cursor += applyTailStock.length;

  // 写入 Desktop/CLI 3 处上下文门禁特征字节码
  for (const sig of CONTEXT_SIGNATURES.slice(0, 3)) {
    cursor += 64;
    const sigBuf = Buffer.from(sig.stockHex, 'hex');
    sigBuf.copy(buf, cursor);
    cursor += sigBuf.length;
  }

  // 默认写入 3 处会话与章节英文标题生成指令特征（可通过 includeTitleRules: false 关闭）
  if (options.includeTitleRules !== false) {
    for (const rule of CHINESE_TITLE_RULES) {
      cursor += 48;
      const oldBytes = Buffer.from(rule.oldText, 'ascii');
      oldBytes.copy(buf, cursor);
      cursor += oldBytes.length;
    }
  }

  return { buf, applyEditsTailOffset: applyEditsOffset + applyPrefix.length + 5 };
}

test('系统提示词 0~4 档与上下文 3 档全生命周期切换及 100% 无损还原', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-patcher-test-'));
  try {
    const binPath = path.join(tmpDir, 'language_server.exe');
    const { buf: originalBuf, applyEditsTailOffset } = buildSyntheticKernelBinary();
    const originalHash = sha256(originalBuf);
    fs.writeFileSync(binPath, originalBuf);

    const opts = {
      homeDir: tmpDir,
      skipProcessCheck: true,
      targets: [{ id: 'cli', label: '测试桌面端内核', path: binPath }]
    };

    // 1. 初始状态应为 0 档 + stock
    const st0 = getKernelStatus(opts);
    assert.equal(st0.ok, true);
    assert.equal(st0.summary.promptTier, 0);
    assert.equal(st0.summary.contextMode, 'stock');
    assert.equal(st0.summary.savedBytes, 0);

    // 2. 应用一键推荐 (4 档提示词 + 900k 上下文)
    const r4 = applyKernelPatch({ promptTier: '4', contextMode: '900k' }, opts);
    assert.equal(r4.ok, true);
    assert.equal(r4.status.summary.promptTier, 4);
    assert.equal(r4.status.summary.contextMode, '900k');
    assert.equal(r4.status.summary.effectiveBudget, 983040);
    assert.ok(r4.status.summary.savedBytes > 2000);
    assert.equal(fs.statSync(binPath).size, originalBuf.length, '原位补丁不得改变 PE 文件体积');

    // 验证 applyEdits 已被改为无条件跳转绕过
    const patched4Buf = fs.readFileSync(binPath);
    assert.equal(
      patched4Buf.subarray(applyEditsTailOffset, applyEditsTailOffset + 10).toString('hex'),
      '4883f801e975ffffff90'
    );

    // 验证 config.json 已同步写入 900K
    const cfgPath = path.join(tmpDir, '.gemini', 'config', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).contextWindow, '900K');

    // 3. 依次切换 3 档 -> 2 档 -> 1 档 + 512k
    const r3 = applyKernelPatch({ promptTier: '3', contextMode: '512k' }, opts);
    assert.equal(r3.ok, true);
    assert.equal(r3.status.summary.promptTier, 3);
    assert.equal(r3.status.summary.contextMode, '512k');
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).contextWindow, '512K');

    const r2 = applyKernelPatch({ promptTier: '2' }, opts);
    assert.equal(r2.ok, true);
    assert.equal(r2.status.summary.promptTier, 2);

    const r1 = applyKernelPatch({ promptTier: '1' }, opts);
    assert.equal(r1.ok, true);
    assert.equal(r1.status.summary.promptTier, 1);

    // 4. 恢复官方默认 (0 档 + stock)，验证与出厂二进制逐字节哈希 100% 一致
    const r0 = applyKernelPatch({ promptTier: '0', contextMode: 'stock' }, opts);
    assert.equal(r0.ok, true);
    assert.equal(r0.status.summary.promptTier, 0);
    assert.equal(r0.status.summary.contextMode, 'stock');
    assert.equal(sha256(fs.readFileSync(binPath)), originalHash, '恢复 0 档 + 默认上下文后必须逐字节还原');
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).contextWindow, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('客户端升级后残留旧版 .bak 时自动刷新备份且绝不错位写坏新二进制', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-patcher-upgrade-'));
  try {
    const binPath = path.join(tmpDir, 'agy.exe');
    // 旧版本备份（偏移与时间戳均不同）
    const oldBuild = buildSyntheticKernelBinary({ timeDateStamp: 0x11111111, extraPad: 0 });
    // 升级后的新版本主程序（偏移后移了 4096 字节）
    const newBuild = buildSyntheticKernelBinary({ timeDateStamp: 0x22222222, extraPad: 4096 });
    const newOriginalHash = sha256(newBuild.buf);

    fs.writeFileSync(`${binPath}.bak`, oldBuild.buf);
    fs.writeFileSync(binPath, newBuild.buf);

    assert.equal(isSamePeBuild(oldBuild.buf, newBuild.buf), false);

    const opts = {
      homeDir: tmpDir,
      skipProcessCheck: true,
      targets: [{ id: 'ide_hub', label: '测试共享后端', path: binPath }]
    };

    // 应用 4 档 + 900k：应自动识别客户端已升级并刷新 .bak 为新版原版，然后正确写入新版偏移
    const res = applyKernelPatch({ promptTier: '4', contextMode: '900k' }, opts);
    assert.equal(res.ok, true);
    assert.equal(sha256(fs.readFileSync(`${binPath}.bak`)), newOriginalHash, '过期 .bak 必须被自动刷新为新版纯净原版');

    // 验证新二进制结构完好且可 100% 还原回新版原版
    const templatesAfter = parsePeEmbedTemplates(fs.readFileSync(binPath));
    assert.ok(templatesAfter.has('system_prompts/identity.tmpl'));

    const resRestore = applyKernelPatch({ promptTier: '0', contextMode: 'stock' }, opts);
    assert.equal(resRestore.ok, true);
    assert.equal(sha256(fs.readFileSync(binPath)), newOriginalHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('会话与章节自动中文命名补丁：支持无损双向切换、无 .bak 还原及多内核同步', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-patcher-title-'));
  try {
    const desktopBin = path.join(tmpDir, 'language_server.exe');
    const cliBin = path.join(tmpDir, 'agy.exe');
    const legacyBin = path.join(tmpDir, 'legacy_no_title.exe');

    const { buf: stockDesktop } = buildSyntheticKernelBinary({ timeDateStamp: 0x33333333 });
    const { buf: stockCli } = buildSyntheticKernelBinary({ timeDateStamp: 0x44444444, extraPad: 512 });
    const { buf: stockLegacy } = buildSyntheticKernelBinary({ timeDateStamp: 0x55555555, includeTitleRules: false });

    const desktopHash = sha256(stockDesktop);
    const cliHash = sha256(stockCli);
    const legacyHash = sha256(stockLegacy);

    fs.writeFileSync(desktopBin, stockDesktop);
    fs.writeFileSync(cliBin, stockCli);
    fs.writeFileSync(legacyBin, stockLegacy);

    const opts = {
      homeDir: tmpDir,
      skipProcessCheck: true,
      targets: [
        { id: 'cli', label: '桌面端内核', path: desktopBin },
        { id: 'ide_hub', label: 'CLI 共享后端', path: cliBin },
        { id: 'ide', label: '无标题特征旧内核', path: legacyBin }
      ]
    };

    // 1. 初始检测：前两个为 en，旧内核为 unsupported
    const stInit = getKernelStatus(opts);
    assert.equal(stInit.ok, true);
    assert.equal(stInit.summary.chineseTitleMode, 'en');
    assert.equal(stInit.summary.chineseTitleEnabled, false);
    assert.equal(stInit.binaries[2].chineseTitleMode, 'unsupported');

    // 2. 单独开启中文标题（不影响 0 档提示词与默认 256K 上下文，且不破坏无特征旧内核）
    const rZh = applyKernelPatch({ chineseTitle: true }, opts);
    assert.equal(rZh.ok, true);
    assert.equal(rZh.status.summary.chineseTitleMode, 'zh');
    assert.equal(rZh.status.summary.chineseTitleEnabled, true);
    assert.equal(rZh.status.summary.promptTier, 0);
    assert.equal(rZh.status.summary.contextMode, 'stock');
    assert.equal(rZh.status.binaries[1].chineseTitleEnabled, true);
    assert.equal(sha256(fs.readFileSync(legacyBin)), legacyHash, '无标题特征的内核文件必须保持原封不动');

    const zhBuf = fs.readFileSync(desktopBin);
    assert.equal(zhBuf.length, stockDesktop.length, '等长 ASCII 替换不得改变 PE 字节长度');
    for (const rule of CHINESE_TITLE_RULES) {
      assert.ok(zhBuf.indexOf(Buffer.from(rule.newText, 'ascii')) !== -1, `应包含新中文规则: ${rule.id}`);
      assert.equal(zhBuf.indexOf(Buffer.from(rule.oldText, 'ascii')), -1, `不应残留旧英文规则: ${rule.id}`);
    }

    // 3. 即使删除 .bak 备份，单独关闭中文标题也能通过双向等长特征 100% 字节级还原
    fs.rmSync(`${desktopBin}.bak`, { force: true });
    fs.rmSync(`${cliBin}.bak`, { force: true });

    const rEn = applyKernelPatch({ chineseTitle: false }, opts);
    assert.equal(rEn.ok, true);
    assert.equal(rEn.status.summary.chineseTitleMode, 'en');
    assert.equal(rEn.status.summary.chineseTitleEnabled, false);
    assert.equal(sha256(fs.readFileSync(desktopBin)), desktopHash, '无 .bak 关闭中文标题后桌面内核逐字节还原');
    assert.equal(sha256(fs.readFileSync(cliBin)), cliHash, '无 .bak 关闭中文标题后 CLI 内核逐字节还原');

    // 4. 与 4 档提示词 + 900K 上下文一键组合开启与全量恢复
    const rCombo = applyKernelPatch({ promptTier: '4', contextMode: '900k', chineseTitle: 'on' }, opts);
    assert.equal(rCombo.ok, true);
    assert.equal(rCombo.status.summary.promptTier, 4);
    assert.equal(rCombo.status.summary.contextMode, '900k');
    assert.equal(rCombo.status.summary.chineseTitleEnabled, true);

    const rFullRestore = applyKernelPatch({ promptTier: '0', contextMode: 'stock', chineseTitle: 'off' }, opts);
    assert.equal(rFullRestore.ok, true);
    assert.equal(sha256(fs.readFileSync(desktopBin)), desktopHash);
    assert.equal(sha256(fs.readFileSync(cliBin)), cliHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
