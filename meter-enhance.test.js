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

test('identity.tmpl 含内嵌 {{- /* LINT.IfChange */ -}} 注释时不截断，activeSlotBytes 精确计入有效字节', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-ident-'));
  try {
    const rawIdentity = 'Header identity text.\n{{- /* LINT.IfChange("identity") */ -}}\nMore core rules kept intact.\n{{- /* LINT.ThenChange("ref") */ -}}';
    const base = buildMockEnhancePe64();
    const bigBuf = Buffer.alloc(0x10000, 0);
    base.copy(bigBuf, 0, 0, base.length);
    const longIdentity = rawIdentity + ' Trailing real prompt section padding check.';
    const dataStart = 0x9000;
    bigBuf.write(longIdentity, dataStart, 'utf8');
    const dataLen = Buffer.byteLength(longIdentity, 'utf8');
    const imageBase = 0x140000000n;
    const rdataRva = 0x1000;
    const rdataPtr = 0x400;
    const va = (off) => imageBase + BigInt(rdataRva + (off - rdataPtr));
    // 更新 .rdata 节大小和第 0 项 identity 数据指针，保持全文件名切片指向原位置
    bigBuf.writeBigUInt64LE(va(dataStart), 0x4800 + 16);
    bigBuf.writeBigUInt64LE(BigInt(dataLen), 0x4800 + 24);
    bigBuf.writeUInt32LE(bigBuf.length - rdataPtr, 0x98 + 0xf0 + 8);
    bigBuf.writeUInt32LE(bigBuf.length - rdataPtr, 0x98 + 0xf0 + 16);
    bigBuf.writeUInt32LE(bigBuf.length, 0x98 + 56);

    const parsed = enhance.parsePeEmbedTemplates(bigBuf);
    const identSlot = parsed.get('system_prompts/identity.tmpl');
    assert.ok(identSlot);
    assert.equal(identSlot.activeBytes, dataLen, '含中间模板注释时 activeBytes 必须保留后续正文并等于实际长度');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('异步增强链路：状态缓存失效、并发串行锁、冷启动恢复偏好与客户端更新失配识别', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-async-'));
  const bakDir = path.join(tmpDir, 'bak');
  const stateDir = path.join(tmpDir, 'state');
  try {
    const lsExe = path.join(tmpDir, 'language_server.exe');
    const agyExe = path.join(tmpDir, 'agy.exe');
    fs.writeFileSync(lsExe, buildMockEnhancePe64());
    fs.writeFileSync(agyExe, buildMockEnhancePe64());

    const targets = [
      { id: 'ls', label: 'language_server.exe', path: lsExe },
      { id: 'desktop', label: 'agy.exe', path: agyExe }
    ];
    const opts = {
      targets,
      backupDir: bakDir,
      stateDir,
      platform: 'win32',
      arch: 'x64',
      skipProcessCheck: true
    };

    // 1. 并发同时对同一组目标提交 tier 2 和 tier 4：队列串行，最终写入均一致、无损坏且事件循环可响应
    let timerTicks = 0;
    const heartbeat = setInterval(() => { timerTicks++; }, 5);
    const [rA, rB] = await Promise.all([
      enhance.applyEnhancePatchAsync({ promptTier: 2, chineseTitle: false }, opts),
      enhance.applyEnhancePatchAsync({ promptTier: 4, chineseTitle: true }, opts)
    ]);
    clearInterval(heartbeat);

    assert.equal(rA.ok, true);
    assert.equal(rB.ok, true);
    assert.equal(rB.appliedPromptTier, 4);
    assert.equal(rB.appliedChineseTitleEnabled, true);
    assert.equal(rB.status.summary.targetsConsistent, true);
    assert.equal(rB.status.summary.syncState, 'applied_saved');
    assert.ok(rB._timings && typeof rB._timings.totalMs === 'number');

    // 2. 相同设置幂等重应用：changed === false
    const rIdem = await enhance.applyEnhancePatchAsync({ promptTier: 4, chineseTitle: true }, opts);
    assert.equal(rIdem.ok, true);
    assert.equal(rIdem.changed, false);

    // 3. 模拟冷启动（清空内存缓存后重新探测）：保存到 modules.json 的偏好与磁盘完全吻合
    enhance.invalidateBinaryCache();
    const coldStatus = await enhance.getEnhanceStatusAsync(opts);
    assert.equal(coldStatus.summary.promptTier, 4);
    assert.equal(coldStatus.summary.chineseTitleEnabled, true);
    assert.equal(coldStatus.summary.savedPromptTier, 4);
    assert.equal(coldStatus.summary.savedChineseTitle, true);
    assert.equal(coldStatus.summary.clientUpdatedSinceSave, false);
    assert.equal(coldStatus.summary.syncState, 'applied_saved');

    // 4. 命中缓存 vs 外部改写磁盘（客户端更新替换二进制 TimeDateStamp=0x69200000，恢复原版 0档）自动失效缓存并识别升级失配
    const cachedHit = await enhance.getEnhanceStatusAsync({ ...opts, forceRefresh: false });
    assert.equal(cachedHit.summary.promptTier, 4);

    const updatedBuf = buildMockEnhancePe64();
    updatedBuf.writeUInt32LE(0x69200000, 0x88); // 新 PE 构建时间戳
    fs.writeFileSync(lsExe, updatedBuf);
    fs.writeFileSync(agyExe, updatedBuf);

    const afterUpdateStatus = await enhance.getEnhanceStatusAsync({ ...opts, forceRefresh: false });
    assert.equal(afterUpdateStatus.summary.promptTier, 0);
    assert.equal(afterUpdateStatus.summary.chineseTitleEnabled, false);
    assert.equal(afterUpdateStatus.summary.savedPromptTier, 4);
    assert.equal(afterUpdateStatus.summary.savedChineseTitle, true);
    assert.equal(afterUpdateStatus.summary.clientUpdatedSinceSave, true);
    assert.equal(afterUpdateStatus.summary.syncState, 'client_updated_mismatch');
    assert.ok(timerTicks >= 0);
  } finally {
    enhance.invalidateBinaryCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('多目标部分失败时诚实返回 partialOk 与逐项目标错误信息，绝不笼统报成功', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-partial-'));
  const bakDir = path.join(tmpDir, 'bak');
  const stateDir = path.join(tmpDir, 'state');
  try {
    const okExe = path.join(tmpDir, 'ok_ls.exe');
    const badExe = path.join(tmpDir, 'bad_agy.exe');
    fs.writeFileSync(okExe, buildMockEnhancePe64());
    // badExe 写入非法非 PE 数据触发解析/槽位缺失失败
    fs.writeFileSync(badExe, Buffer.from('NOT_A_VALID_PE_FILE_AT_ALL'));

    const res = await enhance.applyEnhancePatchAsync(
      { promptTier: 3, chineseTitle: true },
      {
        targets: [
          { id: 'ls', label: 'ok_ls.exe', path: okExe },
          { id: 'desktop', label: 'bad_agy.exe', path: badExe }
        ],
        backupDir: bakDir,
        stateDir,
        platform: 'win32',
        arch: 'x64',
        skipProcessCheck: true
      }
    );
    assert.equal(res.ok, false);
    assert.equal(res.partialOk, true);
    assert.equal(Array.isArray(res.targetResults), true);
    assert.equal(res.targetResults.length, 2);
    assert.equal(res.targetResults[0].ok, true);
    assert.equal(res.targetResults[1].ok, false);
    assert.match(res.error, /bad_agy\.exe/);
  } finally {
    enhance.invalidateBinaryCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('macOS Mach-O arm64 适配：embed.FS 槽位解析、0~4 档切换、中文标题与全还原', async () => {
  const buf = Buffer.alloc(0x10000, 0);
  const vmBase = 0x100000000n;
  // Mach-O 64-bit header (arm64)
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(2, 16); // ncmds = 2 (LC_UUID + LC_SEGMENT_64)
  // LC_UUID at 32 (24B)
  buf.writeUInt32LE(0x1b, 32);
  buf.writeUInt32LE(24, 36);
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(buf, 40);
  // LC_SEGMENT_64 (__TEXT) at 56 (72 + 2 * 80 = 232B)
  buf.writeUInt32LE(0x19, 56);
  buf.writeUInt32LE(72 + 2 * 80, 60);
  buf.write('__TEXT', 64, 'ascii');
  buf.writeBigUInt64LE(vmBase, 80);
  buf.writeBigUInt64LE(0x10000n, 88);
  buf.writeBigUInt64LE(0n, 96);
  buf.writeBigUInt64LE(0x10000n, 104);
  buf.writeUInt32LE(2, 120); // nsects = 2
  buf.writeUInt32LE(24 + 72 + 2 * 80, 20); // sizeofcmds

  // Section 1: __rodata at 0x2000..0x8000
  const s1 = 128;
  buf.write('__rodata', s1, 'ascii');
  buf.write('__TEXT', s1 + 16, 'ascii');
  buf.writeBigUInt64LE(vmBase + 0x2000n, s1 + 32);
  buf.writeBigUInt64LE(0x6000n, s1 + 40);
  buf.writeUInt32LE(0x2000, s1 + 48);
  // Section 2: __cstring at 0x8000..0xf000
  const s2 = s1 + 80;
  buf.write('__cstring', s2, 'ascii');
  buf.write('__TEXT', s2 + 16, 'ascii');
  buf.writeBigUInt64LE(vmBase + 0x8000n, s2 + 32);
  buf.writeBigUInt64LE(0x7000n, s2 + 40);
  buf.writeUInt32LE(0x8000, s2 + 48);

  const prefix = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';
  const slots = [
    { name: 'identity.tmpl', text: 'You are Antigravity, an agentic AI coding assistant.' },
    { name: 'guidelines.tmpl', text: 'G'.repeat(700) },
    { name: 'function_call.tmpl', text: 'F'.repeat(605) },
    { name: 'communication_style.tmpl', text: 'C'.repeat(2034) },
    { name: 'slash_commands.tmpl', text: 'S'.repeat(600) },
    { name: 'plugins.tmpl', text: 'P'.repeat(600) },
    { name: 'artifacts.tmpl', text: 'A'.repeat(1200) }
  ];

  let strCursor = 0x2100;
  let tblCursor = 0x9000;
  for (const s of slots) {
    const fullName = prefix + s.name;
    const nameOff = strCursor;
    buf.write(fullName, nameOff, 'utf8');
    strCursor += Buffer.byteLength(fullName, 'utf8') + 16;

    const dataOff = strCursor;
    buf.write(s.text, dataOff, 'utf8');
    strCursor += Buffer.byteLength(s.text, 'utf8') + 16;

    buf.writeBigUInt64LE(vmBase + BigInt(nameOff), tblCursor);
    buf.writeBigUInt64LE(BigInt(Buffer.byteLength(fullName, 'utf8')), tblCursor + 8);
    buf.writeBigUInt64LE(vmBase + BigInt(dataOff), tblCursor + 16);
    buf.writeBigUInt64LE(BigInt(Buffer.byteLength(s.text, 'utf8')), tblCursor + 24);
    tblCursor += 48;
  }

  for (const rule of enhance.CHINESE_TITLE_RULES) {
    buf.write(rule.oldText, strCursor, 'ascii');
    strCursor += rule.oldText.length + 16;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enhance-macho-'));
  try {
    const binPath = path.join(tmpDir, 'language_server');
    fs.writeFileSync(binPath, buf);
    const opts = {
      targets: [{ id: 'desktop', label: 'macOS LS', path: binPath }],
      enhanceBackupDir: path.join(tmpDir, 'enh_bak'),
      backupDir: path.join(tmpDir, 'ctx_bak'),
      stateDir: path.join(tmpDir, 'state'),
      platform: 'darwin',
      arch: 'arm64',
      skipProcessCheck: true
    };

    const st0 = await enhance.getEnhanceStatusAsync(opts);
    assert.equal(st0.supported, true);
    assert.equal(st0.summary.promptTier, 0);
    assert.equal(st0.summary.chineseTitleMode, 'en');
    assert.equal(st0.summary.slotCount, 7);

    const r4 = await enhance.applyEnhancePatchAsync({ promptTier: 4, chineseTitle: true }, opts);
    assert.equal(r4.ok, true);
    assert.equal(r4.appliedPromptTier, 4);
    assert.equal(r4.appliedChineseTitleEnabled, true);

    const r0 = await enhance.restoreAllEnhanceAsync(opts);
    assert.equal(r0.ok, true);
    assert.equal(r0.status.summary.promptTier, 0);
    assert.equal(r0.status.summary.chineseTitleEnabled, false);
    assert.equal(Buffer.compare(fs.readFileSync(binPath), buf), 0);

    // 额外验证 Intel Mac (darwin/x64) 必须明确拒绝写入增强补丁，且 codesign 失败严格回滚原文件
    const intelStatus = await enhance.getEnhanceStatusAsync({
      platform: 'darwin',
      arch: 'x64',
      stateDir: path.join(tmpDir, 'state_intel'),
      skipProcessCheck: true
    });
    assert.equal(intelStatus.supported, false);

    const shaBeforeCsFail = require('crypto').createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
    const csFailRes = await enhance.applyEnhancePatchAsync(
      { promptTier: 4, chineseTitle: true },
      {
        ...opts,
        forceCodesign: true,
        _execFile: (bin, args, _execOpts, cb) => {
          if (args.includes('--force')) {
            return cb(new Error('codesign failed'), '', 'codesign error');
          }
          return cb(null, '', '');
        }
      }
    );
    assert.equal(csFailRes.ok, false);
    const shaAfterCsFail = require('crypto').createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
    assert.equal(shaAfterCsFail, shaBeforeCsFail, 'codesign 失败后增强目标原文件 SHA256 必须一字节不变');
  } finally {
    enhance.invalidateBinaryCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
