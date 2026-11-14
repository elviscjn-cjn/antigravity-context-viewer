'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const enhance = require('./meter-enhance');
const modulesCfg = require('./modules-config');

/**
 * 构建带 .rdata Go embed.FS 系统提示词槽位与中文标题原始指令的合成 PE32+ 二进制
 * @param {object} opts
 * @returns {Buffer}
 */
function buildMockEnhancePe64(opts = {}) {
  const imageBase = 0x140000000n;
  const rdataRva = 0x1000;
  const rdataPtr = 0x400;
  const totalSize = 0x8000;
  const buf = Buffer.alloc(totalSize, 0);

  // DOS + PE header
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84); // x64
  buf.writeUInt16LE(1, 0x86); // NumberOfSections = 1
  buf.writeUInt32LE(0x69100000, 0x88); // TimeDateStamp
  buf.writeUInt16LE(0xf0, 0x94); // SizeOfOptionalHeader = 240
  const opt = 0x98;
  buf.writeUInt16LE(0x020b, opt); // PE32+
  buf.writeBigUInt64LE(imageBase, opt + 24);
  buf.writeUInt32LE(totalSize, opt + 56); // SizeOfImage

  // Section 1: .rdata
  const secOff = opt + 0xf0;
  buf.write('.rdata\0\0', secOff, 'ascii');
  buf.writeUInt32LE(totalSize - rdataPtr, secOff + 8); // VirtualSize
  buf.writeUInt32LE(rdataRva, secOff + 12); // VirtualAddress
  buf.writeUInt32LE(totalSize - rdataPtr, secOff + 16); // SizeOfRawData
  buf.writeUInt32LE(rdataPtr, secOff + 20); // PointerToRawData

  const fileOffToVa = (off) => imageBase + BigInt(rdataRva + (off - rdataPtr));

  const prefix = 'google3/third_party/jetski/prompt/template_provider/templates/';
  const longDummy = (label, minLen) => {
    const base = `<!-- ${label} stock section -->\n` + 'Keep original helpful behavior. '.repeat(Math.ceil(minLen / 30));
    return base.slice(0, minLen);
  };

  const slots = [
    { shortName: 'system_prompts/identity.tmpl', content: 'You are Antigravity, an agentic AI coding assistant.\n' },
    { shortName: 'system_prompts/guidelines.tmpl', content: longDummy('guidelines', 900) },
    { shortName: 'system_prompts/function_call.tmpl', content: longDummy('function_call', 800) },
    { shortName: 'system_prompts/communication_style.tmpl', content: longDummy('communication_style', 2400) },
    { shortName: 'system_prompts/artifacts.tmpl', content: longDummy('artifacts', 120) },
    { shortName: 'system_prompts/persistent_context.tmpl', content: longDummy('persistent_context', 120) },
    { shortName: 'system_prompts/knowledge_items.tmpl', content: longDummy('knowledge_items', 120) },
    { shortName: 'system_prompts/planning_mode_artifacts.tmpl', content: longDummy('planning_mode_artifacts', 120) },
    { shortName: 'system_prompts/conversation_transcript.tmpl', content: longDummy('conversation_transcript', 120) },
    { shortName: 'system_prompts/slash_commands.tmpl', content: longDummy('slash_commands', 120) },
    { shortName: 'system_prompts/plugins.tmpl', content: longDummy('plugins', 120) }
  ];

  // 先写入名称和数据字符串，从 0x500 开始，表写入到 0x3000
  let strCursor = 0x500;
  const tableBase = 0x4800;
  slots.forEach((s, idx) => {
    const fullName = prefix + s.shortName;
    const nameOff = strCursor;
    buf.write(fullName, nameOff, 'utf8');
    strCursor += Buffer.byteLength(fullName, 'utf8') + 1;

    const dataOff = strCursor;
    buf.write(s.content, dataOff, 'utf8');
    const dataLen = Buffer.byteLength(s.content, 'utf8');
    strCursor += dataLen + 2;

    const entryOff = tableBase + idx * 48;
    buf.writeBigUInt64LE(fileOffToVa(nameOff), entryOff);
    buf.writeBigUInt64LE(BigInt(Buffer.byteLength(fullName, 'utf8')), entryOff + 8);
    buf.writeBigUInt64LE(fileOffToVa(dataOff), entryOff + 16);
    buf.writeBigUInt64LE(BigInt(dataLen), entryOff + 24);
  });

  // 写入 3 条中文标题等长特征（从 0x6200 开始）
  let titleCursor = 0x6200;
  for (const rule of enhance.CHINESE_TITLE_RULES) {
    buf.write(rule.oldText, titleCursor, 'ascii');
    titleCursor += Buffer.byteLength(rule.oldText, 'ascii') + 16;
  }

  return buf;
}

test('Prompt Tier 3/4 防幻觉载荷遵循真实工具契约、无过时截止日或无关强制配色', () => {
  const combined = [
    enhance.TIER3_GUIDELINES,
    enhance.TIER3_FUNCTION_CALL,
    enhance.TIER3_COMMUNICATION_STYLE,
    enhance.TIER4_GUIDELINES,
    enhance.TIER4_FUNCTION_CALL,
    enhance.TIER4_COMMUNICATION_STYLE
  ].join('\n');

  // 应包含 Antigravity 真实工具名与验证规则
  assert.ok(combined.includes('read_file'));
  assert.ok(combined.includes('edit_file'));
  assert.ok(combined.includes('run_command'));

  // 不应包含与当前环境冲突的旧工具名、固定知识截止日或无关配色限制
  for (const forbidden of ['view_file', 'replace_file_content', 'write_to_file', 'knowledge cutoff', 'March 2025', 'purple', '紫蓝']) {
    assert.equal(combined.toLowerCase().includes(forbidden.toLowerCase()), false, `载荷不应包含: ${forbidden}`);
  }
});

test('meter-enhance: 0~4 档位切换、中文标题等长替换、状态检测与原位备份还原全闭环', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-test-'));
  try {
    const binPath = path.join(tmpDir, 'language_server_windows_x64.exe');
    const backupDir = path.join(tmpDir, 'backups');
    const stockBuf = buildMockEnhancePe64();
    fs.writeFileSync(binPath, stockBuf);

    const targets = [{ id: 'desktop', label: '桌面端语言服务', path: binPath }];
    const opts = { targets, backupDir, homeDir: tmpDir, skipProcessCheck: true };

    // 1. 初始应检测为 0档原版 + 英文标题
    const s0 = enhance.getEnhanceStatus(opts);
    assert.equal(s0.ok, true);
    assert.equal(s0.supported, true);
    assert.equal(s0.summary.promptTier, 0);
    assert.equal(s0.summary.chineseTitleEnabled, false);

    // 2. 依次验证 Tier 1 -> 2 -> 3 -> 4 + 中文标题开启
    for (const tier of [1, 2, 3, 4]) {
      const res = enhance.applyEnhancePatch({ promptTier: tier, chineseTitle: tier >= 3 }, opts);
      assert.equal(res.ok, true, `Tier ${tier} 应成功`);
      assert.equal(res.status.summary.promptTier, tier, `Tier ${tier} 检测应一致`);
      assert.equal(res.status.summary.chineseTitleEnabled, tier >= 3);
      assert.equal(fs.statSync(binPath).size, stockBuf.length, '文件体积必须保持严格等长');
    }

    // 3. 验证中文标题单独关闭而保留 Tier 4
    const toggleTitleOff = enhance.applyEnhancePatch({ chineseTitle: false }, opts);
    assert.equal(toggleTitleOff.ok, true);
    assert.equal(toggleTitleOff.status.summary.promptTier, 4);
    assert.equal(toggleTitleOff.status.summary.chineseTitleEnabled, false);

    // 4. 全部恢复官方默认，二进制必须一字节不差还原
    const restoreRes = enhance.restoreAllEnhance(opts);
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.status.summary.promptTier, 0);
    assert.equal(restoreRes.status.summary.chineseTitleEnabled, false);
    const restoredBuf = fs.readFileSync(binPath);
    assert.equal(Buffer.compare(restoredBuf, stockBuf), 0, '恢复后必须与原版二进制完全一致');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('客户端语言与品牌选项默认不暗中启用，支持三态品牌展示与持久化', () => {
  const def = JSON.parse(JSON.stringify(modulesCfg.DEFAULT_CONFIG));
  assert.equal(def.modules.chinese.enabled, false, '默认不得暗中启用客户端汉化');
  assert.equal(def.modules.chinese.language, 'en');
  assert.equal(def.modules.chinese.brandTitle, 'english');
  assert.equal(modulesCfg.normalizeBrandTitle('hidden'), 'hidden');
  assert.equal(modulesCfg.normalizeBrandTitle('translated'), 'translated');
  assert.equal(modulesCfg.normalizeBrandTitle('unknown-val'), 'english');

  // 运行时 DOM 品牌标题三态真实生效验证（通过 vm 加载 i18n-runtime.js）
  const runtimeCode = fs.readFileSync(path.join(__dirname, 'i18n', 'i18n-runtime.js'), 'utf8');
  const testBrandMode = (mode, rawTitle) => {
    const textNode = { nodeType: 3, nodeValue: rawTitle };
    const parentEl = {
      nodeType: 1,
      tagName: 'DIV',
      className: 'window-title',
      attributes: [],
      firstChild: textNode,
      childNodes: [textNode],
      closest: (sel) => String(sel || '').includes('.window-title'),
      hasAttribute: () => false,
      getAttribute: () => null,
      setAttribute: () => {}
    };
    textNode.parentElement = parentEl;
    textNode.parentNode = parentEl;
    const sandbox = {
      __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN', brandTitle: mode },
      __AGY_I18N_DICT__: { exact: { Settings: '设置' }, patterns: [] },
      window: null,
      document: { addEventListener: () => {} },
      setTimeout,
      clearTimeout
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeCode, sandbox);
    sandbox.__AGY_CREATE_ENGINE__(sandbox.__AGY_I18N_DICT__);
    sandbox.__AGY_TRANSLATE_EL__(parentEl);
    return textNode.nodeValue;
  };

  assert.equal(testBrandMode('english', 'Antigravity'), 'Antigravity');
  assert.equal(testBrandMode('hidden', 'Antigravity'), '');
  assert.equal(testBrandMode('translated', 'Antigravity'), '反重力');
  // 严格限定只控制左上角独立品牌文字，复合标题与其他文本绝不顺带改写
  assert.equal(testBrandMode('hidden', 'Workspace - Antigravity'), 'Workspace - Antigravity');
  assert.equal(testBrandMode('translated', 'Workspace - Antigravity'), 'Workspace - Antigravity');
});

test('安全隔离回归：测试下缺失 targets 或误传单数字段时绝对禁止探测/写入真实客户端', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-iso-'));
  try {
    const fakeExe = path.join(tmpDir, 'language_server.exe');
    fs.writeFileSync(fakeExe, buildMockEnhancePe64());

    // 1. 误传 targetPath / binPath 代替 options.targets
    const rTypo = enhance.applyEnhancePatch({ promptTier: 1 }, { targetPath: fakeExe, backupDir: path.join(tmpDir, 'bak') });
    assert.equal(rTypo.ok, false);
    assert.equal(rTypo.code, 'INVALID_TARGET_OPTION');

    // 2. node --test 下未传入 options.targets 的 applyEnhancePatch 与 restoreAllEnhance 必须全部拒写
    const rMissing = enhance.applyEnhancePatch({ promptTier: 3, chineseTitle: true }, {});
    assert.equal(rMissing.ok, false);
    assert.equal(rMissing.code, 'MISSING_TARGETS');

    const rRestoreMissing = enhance.restoreAllEnhance({ backupDir: path.join(tmpDir, 'bak2') });
    assert.equal(rRestoreMissing.ok, false);
    assert.equal(rRestoreMissing.code, 'MISSING_TARGETS');

    // 3. resolveTargetBinaries 在隔离/测试下缺 targets 时返回空数组
    assert.deepEqual(enhance.resolveTargetBinaries({ skipProcessCheck: true }), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
