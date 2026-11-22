'use strict';

process.env.AG_METER_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const core = require('./meter-core');
const modulesCfg = require('./modules-config');
const rehydrate = require('./meter-rehydrate');
const { ensureLiveBridgeIfNeeded } = require('./cli');

function createTmpIsolatedEnv(prefix = 'ag-rehydrate-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const configDir = path.join(root, 'gemini-config');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return {
    root,
    stateDir,
    configDir,
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {}
    }
  };
}

function createRendererHarness() {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();

  const makeElement = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c).join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        if (!listeners.get(el).has(type)) listeners.get(el).set(type, []);
        listeners.get(el).get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(el)?.get(type);
        if (list) {
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        }
      },
      trigger(type, ev = {}) {
        for (const fn of (listeners.get(el)?.get(type) || [])) fn(ev);
      },
      click() { this.trigger('click'); },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        if (child) {
          child.parentElement = el;
          el.children.push(child);
        }
      },
      remove() {},
      replaceChildren() { el.children = []; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; }
    };
    return el;
  };

  const host = makeElement();
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    }
  });

  let first = true;
  const timers = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => {
        if (first) {
          first = false;
          return host;
        }
        return makeElement();
      },
      getElementById: id => docElements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        getSettings: async () => ({ ok: true, panelLanguage: 'zh-CN' }),
        saveSettings: async () => ({ ok: true })
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout(cb, ms, ...args) {
      const id = setTimeout(cb, ms, ...args);
      id.unref?.();
      return id;
    },
    clearTimeout,
    setInterval(cb) { timers.push(cb); return timers.length; },
    clearInterval() {},
    fetch: () => new Promise(() => {})
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    elements,
    api: sandbox.__AGContextMeter,
    flush: () => new Promise(resolve => setTimeout(resolve, 25))
  };
}

test('1. MIT 独立实现脚本头部、LF 换行、py_compile、BOM 快路径、检查点注入去重、符号链接防护与敏感文件过滤验证', (t) => {
  const legacyDocPath = path.join(__dirname, 'rehydrate', 'AGY-rehydrate-slim-lts-release-v2.md');
  const readmePath = path.join(__dirname, 'rehydrate', 'README.md');
  const scriptPath = path.join(__dirname, 'rehydrate', 'rehydrate_after_compact.py');
  assert.equal(fs.existsSync(legacyDocPath), false, '旧版发布文档必须已移除');
  assert.equal(fs.existsSync(readmePath), true);
  assert.equal(fs.existsSync(scriptPath), true);

  const readmeText = fs.readFileSync(readmePath, 'utf8');
  assert.equal(readmeText.includes('\r\n'), false, 'rehydrate/README.md 应保持纯 LF 换行');
  assert.match(readmeText, /MIT/);
  assert.match(readmeText, /fork_lineage\.json/);

  const scriptText = fs.readFileSync(scriptPath, 'utf8');
  assert.equal(scriptText.includes('\r\n'), false, 'Python 脚本应保持纯 LF 换行');
  assert.equal(scriptText.endsWith('\n'), true);
  assert.ok(
    scriptText.startsWith('#!/usr/bin/env python3\n# SPDX-License-Identifier: MIT\n'),
    'Python 脚本必须以 #!/usr/bin/env python3 与 # SPDX-License-Identifier: MIT 开头'
  );

  rehydrate.clearPythonProbeCache();
  const py = rehydrate.resolvePython310();
  if (!py.ok) {
    t.skip('本机未安装 Python 3.10+，跳过 py_compile 与运行时契约测试');
    return;
  }

  execFileSync(py.executable, ['-m', 'py_compile', scriptPath], { stdio: 'pipe', windowsHide: true });

  for (const rawIn of ['{}', '\ufeff{}']) {
    const fastOut = execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
      input: rawIn,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(fastOut.trim(), '{}', `空负载应快速返回 {}: ${JSON.stringify(rawIn)}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rh-py-contract-'));
  try {
    const wsDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
    const appJs = path.join(wsDir, 'src', 'app.js');
    const skillMd = path.join(wsDir, 'SKILL.md');
    const settingsIni = path.join(wsDir, 'settings.ini');
    const exit0Txt = path.join(wsDir, 'exit0_ok.txt');
    const failedTxt = path.join(wsDir, 'failed_read.txt');
    const exit2Txt = path.join(wsDir, 'exit2_fail.txt');
    const badPpk = path.join(wsDir, 'deploy.ppk');
    const badP8 = path.join(wsDir, 'AuthKey_ABC.p8');
    const badGpg = path.join(wsDir, 'vault.gpg');
    const badToken = path.join(wsDir, 'token.json');
    const badProdEnv = path.join(wsDir, 'prod.env');
    const badSvcAcct = path.join(wsDir, 'gcp-service-account.json');
    const badVaultTok = path.join(wsDir, '.vault-token');

    fs.writeFileSync(
      appJs,
      [
        'export const featureX = true;',
        'const token = getToken();',
        'const password = req.body.password;',
        'this.password = user.password;',
        'login(password=user_password);',
        'const apiKey = "super_secret_literal_99";',
        'OPENAI_API_KEY=env_secret_value_88',
        ''
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(skillMd, '# Skill Spec\nFollow clean architecture.\n', 'utf8');
    fs.writeFileSync(
      settingsIni,
      '[database]\nhost=127.0.0.1\npassword=s3cr3t_ini_pw\ndb.password = P@ss#9876\napi_key: yaml_unquoted_key_77\n',
      'utf8'
    );
    fs.writeFileSync(exit0Txt, 'Workspace read note ok. Exit 0 result should be restored.\n', 'utf8');
    fs.writeFileSync(failedTxt, 'SHOULD_NOT_RESTORE_FAILED_TOOL_CALL\n', 'utf8');
    fs.writeFileSync(exit2Txt, 'SHOULD_NOT_RESTORE_NONZERO_EXIT_CALL\n', 'utf8');
    fs.writeFileSync(badPpk, 'PPK_SECRET_PAYLOAD_DO_NOT_LEAK\n', 'utf8');
    fs.writeFileSync(badP8, 'P8_SECRET_PAYLOAD_DO_NOT_LEAK\n', 'utf8');
    fs.writeFileSync(badGpg, 'GPG_SECRET_PAYLOAD_DO_NOT_LEAK\n', 'utf8');
    fs.writeFileSync(badToken, '{"token_marker":"TOKEN_JSON_DO_NOT_LEAK"}\n', 'utf8');
    fs.writeFileSync(badProdEnv, 'PROD_ENV_SECRET_DO_NOT_LEAK\n', 'utf8');
    fs.writeFileSync(badSvcAcct, '{"private":"SVC_ACCT_DO_NOT_LEAK"}\n', 'utf8');
    fs.writeFileSync(badVaultTok, 'VAULT_TOKEN_DO_NOT_LEAK\n', 'utf8');

    const cid = '11111111-2222-3333-4444-555555555555';
    const logsDir = path.join(tmpRoot, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const tPath = path.join(logsDir, 'transcript.jsonl');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');

    // 使用真实 Antigravity transcript_full.jsonl 结构：无 id 的 tool_calls(args) + type:'GENERIC' + Created/Completed At 时间头
    const tsHdr = 'Created At: 2026-11-17T08:00:03+08:00\nCompleted At: 2026-11-17T08:00:04+08:00\n';
    const records = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T08:00:01Z', content: '<USER_REQUEST>Build feature X safely</USER_REQUEST>' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-17T08:00:02Z',
        content: 'Updating src/app.js and inspecting docs.',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'git status', toolSummary: 'Check git status' } },
          { name: 'edit_file', args: { Path: appJs } },
          { name: 'read_file', args: { Path: skillMd } },
          { name: 'read_file', args: { Path: settingsIni } },
          { name: 'read_file', args: { Path: exit0Txt } },
          { name: 'read_file', args: { Path: failedTxt } },
          { name: 'read_file', args: { Path: exit2Txt } },
          { name: 'read_file', args: { Path: badPpk } },
          { name: 'read_file', args: { Path: badP8 } },
          { name: 'read_file', args: { Path: badGpg } },
          { name: 'read_file', args: { Path: badToken } },
          { name: 'read_file', args: { Path: badProdEnv } },
          { name: 'read_file', args: { Path: badSvcAcct } },
          { name: 'read_file', args: { Path: badVaultTok } }
        ]
      },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Command exited with code 0.\n` },
      { step_index: 4, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Made 1 replacement in ${appJs}\n` },
      { step_index: 5, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-2 of 2\n` },
      { step_index: 6, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-4 of 4\n` },
      { step_index: 7, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Command exited with code 0.\n` },
      { step_index: 8, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Error: ENOENT: failed to read ${failedTxt}\n` },
      { step_index: 9, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Command exited with code 2.\n` },
      { step_index: 10, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 11, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 12, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 13, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 14, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 15, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 16, type: 'GENERIC', status: 'DONE', content: `${tsHdr}Showing lines 1-1 of 1\n` },
      { step_index: 17, type: 'CHECKPOINT', status: 'DONE', created_at: '2026-11-17T08:01:00Z', content: 'Summary' }
    ];
    const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(tPath, jsonl, 'utf8');
    fs.writeFileSync(fullPath, jsonl, 'utf8');

    const payload = JSON.stringify({
      transcriptPath: tPath,
      workspacePaths: [wsDir],
      conversationId: cid
    });

    const out1Raw = execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true
    });
    const out1 = JSON.parse(out1Raw.trim());
    assert.equal(Array.isArray(out1.injectSteps), true, '新检查点首次调用必须返回 injectSteps');
    assert.equal(out1.injectSteps.length, 1);
    const msg = out1.injectSteps[0]?.systemMessage?.systemMessage || '';
    assert.ok(msg.startsWith('[POST-COMPACT REHYDRATION v1 | checkpoint=17 |'));
    assert.ok(Buffer.byteLength(msg, 'utf8') <= 45000, '回注 UTF-8 字节数不得超过 45000');
    assert.match(msg, /Build feature X safely/);
    assert.match(msg, /## 3\. Restored Active Skills & Spec Docs/);
    assert.match(msg, /## 4\. Restored Active Workspace Files/);
    assert.match(msg, /src\/app\.js/);
    assert.match(msg, /SKILL\.md/);
    assert.match(msg, /settings\.ini/);
    assert.match(msg, /exit0_ok\.txt/);

    // 源码普通变量与函数调用不得被误脱敏，引号字面量、环境变量与 INI/YAML 无引号密钥必须被遮蔽
    assert.equal(msg.includes('const token = getToken();'), true, '普通代码 token = getToken() 不得被误脱敏破坏');
    assert.equal(msg.includes('const password = req.body.password;'), true, '普通属性读取不得被误脱敏破坏');
    assert.equal(msg.includes('this.password = user.password;'), true, '属性赋值不得被误脱敏破坏');
    assert.equal(msg.includes('login(password=user_password);'), true, '关键字参数变量名不得被误脱敏破坏');
    assert.equal(msg.includes('password=[REDACTED]'), true, 'settings.ini 中无引号 password=... 必须被遮蔽');
    assert.equal(msg.includes('super_secret_literal_99'), false, '引号包裹的密钥字面量必须被脱敏');
    assert.equal(msg.includes('env_secret_value_88'), false, '环境变量格式密钥赋值必须被脱敏');
    assert.equal(msg.includes('s3cr3t_ini_pw'), false, 'INI 无引号 password=... 值不得泄露');
    assert.equal(msg.includes('P@ss#9876'), false, 'INI/Properties 带点号键值密码不得泄露');
    assert.equal(msg.includes('yaml_unquoted_key_77'), false, 'YAML 无引号 api_key: ... 值不得泄露');

    const sec4 = msg.split('## 4. Restored Active Workspace Files')[1] || '';

    // 带时间头且以 Error: 或非零退出码失败的真实 GENERIC 工具结果不得恢复进第 4 节文件快照，退出码 0 应恢复
    assert.equal(sec4.includes('exit0_ok.txt'), true, '退出码 0 的结果不应被误判失败');
    assert.equal(sec4.includes('failed_read.txt'), false, '报错的工具调用目标文件不得被恢复进第 4 节');
    assert.equal(sec4.includes('exit2_fail.txt'), false, '非零退出码的工具调用目标文件不得被恢复进第 4 节');
    assert.equal(msg.includes('### failed_read.txt'), false, '报错的工具调用文件标题不得出现');
    assert.equal(msg.includes('### exit2_fail.txt'), false, '非零退出码文件标题不得出现');
    assert.equal(msg.includes('SHOULD_NOT_RESTORE_FAILED_TOOL_CALL'), false);
    assert.equal(msg.includes('SHOULD_NOT_RESTORE_NONZERO_EXIT_CALL'), false);

    for (const excludedName of ['deploy.ppk', 'AuthKey_ABC.p8', 'vault.gpg', 'token.json', 'prod.env', 'gcp-service-account.json', '.vault-token']) {
      assert.equal(sec4.includes(excludedName), false, `敏感文件不得被恢复进工作区文件段落: ${excludedName}`);
      assert.equal(msg.includes(`### ${excludedName}`), false, `敏感文件标题不得出现在回注结果中: ${excludedName}`);
    }
    for (const forbidden of [
      'PPK_SECRET_PAYLOAD_DO_NOT_LEAK',
      'P8_SECRET_PAYLOAD_DO_NOT_LEAK',
      'GPG_SECRET_PAYLOAD_DO_NOT_LEAK',
      'TOKEN_JSON_DO_NOT_LEAK',
      'PROD_ENV_SECRET_DO_NOT_LEAK',
      'SVC_ACCT_DO_NOT_LEAK',
      'VAULT_TOKEN_DO_NOT_LEAK'
    ]) {
      assert.equal(msg.includes(forbidden), false, `敏感文件内容不得出现在回注结果中: ${forbidden}`);
    }

    // 第二次立即调用必须去重返回 {}，且状态文件不得残留 in_progress_cp_token
    const out2Raw = execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(out2Raw.trim(), '{}', '同一检查点二次调用必须去重返回 {}');

    const stateFile1 = path.join(logsDir, 'rehydrate_state.json');
    const savedState1 = JSON.parse(fs.readFileSync(stateFile1, 'utf8'));
    const savedDoneTok = savedState1.done_cp_token;
    assert.ok(typeof savedDoneTok === 'string' && savedDoneTok.startsWith('17:'));
    assert.equal(savedState1.in_progress_cp_token, undefined, '正常完成后应清除 in_progress_cp_token');

    // 验证上一轮在重活中途被宿主强杀（仅保留 in_progress_cp_token）时，下一轮直接跳过并固化 done_cp_token
    fs.writeFileSync(stateFile1, JSON.stringify({ in_progress_cp_token: savedDoneTok }) + '\n', 'utf8');
    const outKilledRaw = execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(outKilledRaw.trim(), '{}', '命中 in_progress_cp_token 时下一轮必须直接降级返回 {}');
    const recoveredState = JSON.parse(fs.readFileSync(stateFile1, 'utf8'));
    assert.equal(recoveredState.done_cp_token, savedDoneTok);
    assert.equal(recoveredState.in_progress_cp_token, undefined);

    // 验证 rehydrate_state.json 为符号链接/重解析点时拒绝覆写目标文件
    const cid2 = '22222222-3333-4444-5555-666666666666';
    const logsDir2 = path.join(tmpRoot, 'brain', cid2, '.system_generated', 'logs');
    fs.mkdirSync(logsDir2, { recursive: true });
    const tPath2 = path.join(logsDir2, 'transcript.jsonl');
    const fullPath2 = path.join(logsDir2, 'transcript_full.jsonl');
    const statePath2 = path.join(logsDir2, 'rehydrate_state.json');
    fs.writeFileSync(tPath2, jsonl, 'utf8');
    fs.writeFileSync(fullPath2, jsonl, 'utf8');

    const victimFile = path.join(tmpRoot, 'victim_target.json');
    const victimOriginal = '{"sentinel":"DO_NOT_OVERWRITE"}\n';
    fs.writeFileSync(victimFile, victimOriginal, 'utf8');

    let fileSymlinkCreated = false;
    try {
      fs.symlinkSync(victimFile, statePath2, 'file');
      fileSymlinkCreated = true;
    } catch {}

    if (fileSymlinkCreated) {
      execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
        input: JSON.stringify({ transcriptPath: tPath2, workspacePaths: [wsDir], conversationId: cid2 }),
        encoding: 'utf8',
        windowsHide: true
      });
      assert.equal(fs.readFileSync(victimFile, 'utf8'), victimOriginal, '符号链接指向的目标文件绝不能被覆写');
    } else {
      // Windows 非管理员环境下同时验证真实目录联接 (Junction) 拦截与 Python 层 is_symlink 原子写保护
      const junctionTargetDir = path.join(tmpRoot, 'junction-target-dir');
      fs.mkdirSync(junctionTargetDir, { recursive: true });
      fs.symlinkSync(junctionTargetDir, statePath2, 'junction');
      execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
        input: JSON.stringify({ transcriptPath: tPath2, workspacePaths: [wsDir], conversationId: cid2 }),
        encoding: 'utf8',
        windowsHide: true
      });
      assert.deepEqual(fs.readdirSync(junctionTargetDir), [], '联接目录内不得产生任何临时文件');
      fs.rmSync(statePath2, { recursive: true, force: true });

      fs.copyFileSync(victimFile, statePath2);
      const pySymCheck = [
        'import importlib.util, pathlib, sys',
        'from unittest import mock',
        'spec = importlib.util.spec_from_file_location("rh", sys.argv[1])',
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        'sp = pathlib.Path(sys.argv[2])',
        'orig = pathlib.Path.is_symlink',
        'with mock.patch.object(pathlib.Path, "is_symlink", lambda self: True if str(self) == str(sp) else orig(self)):',
        '    ok = mod._save_state(sp, {"done_cp_token": "99:deadbeefcafe"})',
        '    assert ok is False, "expected _save_state to refuse symlink"'
      ].join('\n');
      execFileSync(py.executable, ['-X', 'utf8', '-c', pySymCheck, scriptPath, statePath2], {
        encoding: 'utf8',
        windowsHide: true
      });
      assert.equal(fs.readFileSync(statePath2, 'utf8'), victimOriginal, '被判定为符号链接的目标文件绝不能被覆写');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('2. 隔离环境完整生命周期与共存 Hook (herdr) 绝对保留验证', () => {
  const env = createTmpIsolatedEnv();
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = env.stateDir;

  try {
    const hooksDir = path.join(env.configDir, 'hooks');
    const hooksJsonPath = path.join(env.configDir, 'hooks.json');
    const siblingScriptPath = path.join(hooksDir, 'herdr-agent-state.ps1');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(siblingScriptPath, '# preserve me\n', 'utf8');

    const initialHooks = {
      herdr: {
        PreInvocation: [
          { type: 'command', command: 'powershell -File herdr-agent-state.ps1', timeout: 10 }
        ]
      }
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify(initialHooks, null, 2) + '\n', 'utf8');

    const mockPy = () => ({ ok: true, command: 'python', executable: 'python', version: '3.12' });
    const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };

    // 1. 默认 Opt-in 未安装
    assert.equal(modulesCfg.DEFAULT_CONFIG.modules.rehydrate.enabled, false);
    const st0 = rehydrate.getRehydrateStatus(opts);
    assert.equal(st0.status, 'not_installed');
    assert.deepEqual(st0.otherHookNames, ['herdr']);

    // 2. 启用部署
    const applyRes1 = rehydrate.applyRehydrate(opts);
    assert.equal(applyRes1.ok, true);
    assert.equal(applyRes1.changed, true);
    assert.equal(applyRes1.status.status, 'enabled');
    assert.equal(applyRes1.status.scriptInstalled, true);
    assert.equal(applyRes1.status.scriptMatchesBundled, true);
    assert.deepEqual(applyRes1.status.otherHookNames, ['herdr']);

    const afterApplyHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.deepEqual(afterApplyHooks.herdr, initialHooks.herdr, '启用回水不得修改已有 herdr Hook');
    assert.equal(afterApplyHooks['post-compact-rehydrate'].enabled, true);

    // 3. 幂等重启用
    const applyRes2 = rehydrate.applyRehydrate(opts);
    assert.equal(applyRes2.ok, true);
    assert.equal(applyRes2.changed, false);

    // 4. 停用（保留脚本与 herdr）
    const disRes = rehydrate.disableRehydrate(opts);
    assert.equal(disRes.ok, true);
    assert.equal(disRes.changed, true);
    assert.equal(disRes.status.status, 'disabled');
    assert.equal(fs.existsSync(disRes.status.deployedScriptPath), true);
    const afterDisHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.deepEqual(afterDisHooks.herdr, initialHooks.herdr);
    assert.equal(afterDisHooks['post-compact-rehydrate'].enabled, false);

    // 5. 再次启用
    const applyRes3 = rehydrate.applyRehydrate(opts);
    assert.equal(applyRes3.ok, true);
    assert.equal(applyRes3.status.status, 'enabled');

    // 6. 移除（删除 post-compact-rehydrate 与部署脚本，完整保留 herdr 与兄弟脚本）
    const remRes = rehydrate.restoreRehydrate(opts);
    assert.equal(remRes.ok, true);
    assert.equal(remRes.changed, true);
    assert.equal(remRes.status.status, 'not_installed');
    assert.equal(fs.existsSync(remRes.status.deployedScriptPath), false);
    assert.equal(fs.existsSync(siblingScriptPath), true, '同级脚本必须完好保留');
    const afterRemHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.deepEqual(afterRemHooks, initialHooks, '移除后 hooks.json 必须精确还原为仅含 herdr');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    env.cleanup();
  }
});

test('3. 异常防护：损坏 hooks.json fail-closed、Python 版本不足、自定义脚本备份与带空格路径命令拼装', () => {
  const env = createTmpIsolatedEnv('ag space & (x86) test-');
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = env.stateDir;

  try {
    const hooksJsonPath = path.join(env.configDir, 'hooks.json');
    const brokenContent = '{ "herdr": invalid json ';
    fs.writeFileSync(hooksJsonPath, brokenContent, 'utf8');

    const mockPy = () => ({ ok: true, command: 'python', executable: 'python', version: '3.12' });
    const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };

    assert.equal(rehydrate.getRehydrateStatus(opts).status, 'corrupt_hooks_json');
    const failApply = rehydrate.applyRehydrate(opts);
    assert.equal(failApply.ok, false);
    assert.equal(failApply.errorKey, 'rehydrate.err.corruptHooksJson');
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf8'), brokenContent, '损坏时绝不能覆写用户 hooks.json');

    // 修复 hooks.json，校验 Python < 3.10 拦截
    fs.writeFileSync(hooksJsonPath, '{}\n', 'utf8');
    const lowPyRes = rehydrate.applyRehydrate({
      configDir: env.configDir,
      stateDir: env.stateDir,
      _pythonProbe: () => ({ ok: false, command: null, version: '3.9' })
    });
    assert.equal(lowPyRes.ok, false);
    assert.equal(lowPyRes.errorKey, 'rehydrate.err.noPython310');

    // 验证用户自定义脚本在覆写、默认退回与强制移除前的 .bak 备份行为
    const hooksDir = path.join(env.configDir, 'hooks');
    const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(scriptPath, '# user custom script\n', 'utf8');

    const ovRes = rehydrate.applyRehydrate(opts);
    assert.equal(ovRes.ok, true);
    assert.equal(ovRes.backupPath, `${scriptPath}.bak`);
    assert.equal(fs.readFileSync(ovRes.backupPath, 'utf8'), '# user custom script\n');

    fs.writeFileSync(scriptPath, '# edited after deploy\n', 'utf8');
    const rmDefaultRes = rehydrate.restoreRehydrate(opts);
    assert.equal(rmDefaultRes.ok, true);
    assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), '# edited after deploy\n');
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), '# user custom script\n', '默认恢复应还原接管前的用户脚本');

    fs.writeFileSync(scriptPath, '# edited again\n', 'utf8');
    const rmForceRes = rehydrate.restoreRehydrate({ ...opts, force: true });
    assert.equal(rmForceRes.ok, true);
    assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), '# edited again\n');
    assert.equal(fs.existsSync(scriptPath), false);

    // 验证 buildHookCommand：Windows 无引号 Base64 runpy 与 POSIX 单引号安全转义
    const bothSpacesCmd = rehydrate.buildHookCommand(
      'C:\\Program Files (x86)\\Bob & Co\\Python312\\python.exe',
      'C:\\Users\\Alice Smith\\.gemini\\config\\hooks\\rehydrate_after_compact.py',
      'win32'
    );
    assert.equal(bothSpacesCmd.includes('"'), false, 'Windows 含空格命令绝不能包含触发 cmd /c 剥离的双引号');
    assert.match(bothSpacesCmd, /^set PATH=C:\\Program Files \^\(x86\^\)\\Bob \^& Co\\Python312;%PATH%&&python\.exe -X utf8 -c .*#rehydrate_after_compact\.py$/);

    const barePySpaceScriptCmd = rehydrate.buildHookCommand(
      'python',
      'C:\\Users\\Alice Smith\\.gemini\\config\\hooks\\rehydrate_after_compact.py',
      'win32'
    );
    assert.equal(barePySpaceScriptCmd.includes('"'), false);
    assert.match(barePySpaceScriptCmd, /^python -X utf8 -c .*#rehydrate_after_compact\.py$/);

    assert.equal(
      rehydrate.buildHookCommand('python', 'C:\\Users\\Alice\\.gemini\\config\\hooks\\rehydrate_after_compact.py', 'win32'),
      'python -X utf8 C:/Users/Alice/.gemini/config/hooks/rehydrate_after_compact.py'
    );
    assert.equal(
      rehydrate.buildHookCommand('/opt/my py/python3', '/Users/alice smith/.gemini/config/hooks/rehydrate_after_compact.py', 'darwin'),
      "'/opt/my py/python3' -X utf8 '/Users/alice smith/.gemini/config/hooks/rehydrate_after_compact.py'"
    );

    // 若运行在本机 Windows 且存在 Python 3.10+，真实验证 cmd /c 在无关 cwd、含空格+(x86)+&+% 路径下的双向执行（escaped & verbatim）
    if (process.platform === 'win32') {
      const py = rehydrate.resolvePython310();
      if (py.ok) {
        const pyWrapperDir = path.join(env.root, 'Program Files (x86)', 'My & Py%20Dir');
        fs.mkdirSync(pyWrapperDir, { recursive: true });
        const wrapperExe = path.join(pyWrapperDir, 'pywrap.cmd');
        fs.writeFileSync(wrapperExe, `@"${py.executable}" %*\r\n`, 'utf8');
        const spacedScriptDir = path.join(env.configDir, 'Alice & Smith', 'hooks');
        fs.mkdirSync(spacedScriptDir, { recursive: true });
        const spacedScript = path.join(spacedScriptDir, 'rehydrate_after_compact.py');
        fs.copyFileSync(path.join(__dirname, 'rehydrate', 'rehydrate_after_compact.py'), spacedScript);

        const cmdsToVerify = [
          rehydrate.buildHookCommand(wrapperExe, spacedScript, 'win32'),
          rehydrate.buildHookCommand(py.executable, spacedScript, 'win32')
        ];
        for (const cmdStr of cmdsToVerify) {
          for (const verbatim of [false, true]) {
            const runRes = spawnSync('cmd.exe', ['/c', cmdStr], {
              cwd: os.tmpdir(),
              input: '{}',
              encoding: 'utf8',
              windowsVerbatimArguments: verbatim,
              windowsHide: true
            });
            assert.equal(runRes.status, 0, `cmd /c 执行失败 (verbatim=${verbatim}): ${cmdStr}\nstderr=${runRes.stderr}`);
            assert.equal(String(runRes.stdout || '').trim(), '{}');
          }
        }
      }
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    env.cleanup();
  }
});

test('4. 测试模式强制路径隔离守卫：绝不解析到真实用户 ~/.gemini/config', () => {
  const realConfigDir = path.join(os.homedir(), '.gemini', 'config');
  const prevEnvDir = process.env.AG_METER_GEMINI_CONFIG_DIR;
  delete process.env.AG_METER_GEMINI_CONFIG_DIR;
  try {
    const resolved = rehydrate.resolveGeminiConfigDir();
    assert.notEqual(path.resolve(resolved), path.resolve(realConfigDir));
  } finally {
    if (prevEnvDir !== undefined) process.env.AG_METER_GEMINI_CONFIG_DIR = prevEnvDir;
  }
});

test('5. 渲染层界面控制、推荐配置联动、白名单链接与三语完整性校验', async () => {
  assert.equal(core.isValidExternalUrl('https://agy-rehydrate.pages.dev/'), true);
  assert.equal(core.isValidExternalUrl('https://agy-rehydrate.pages.dev/rehydrate_after_compact.py'), false);
  assert.equal(core.isValidExternalUrl('https://evil.example.com/agy-rehydrate.pages.dev'), false);

  const templateHtml = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const recRehydrateTag = templateHtml.match(/<input\b[^>]*\bid="chk-rec-rehydrate"[^>]*>/);
  assert.ok(recRehydrateTag, 'template.html 必须包含 chk-rec-rehydrate 复选框');
  assert.equal(/\bchecked\b/i.test(recRehydrateTag[0]), false, 'chk-rec-rehydrate 在推荐配置中默认必须未勾选');

  const h = createRendererHarness();
  try {
    let mockStatus = {
      supported: true,
      status: 'not_installed',
      hookRegistered: false,
      hookEnabled: false,
      scriptInstalled: false,
      scriptMatchesBundled: false,
      hooksFileValid: true,
      hooksJsonPath: '/tmp/hooks.json',
      deployedScriptPath: '/tmp/hooks/rehydrate_after_compact.py',
      otherHookNames: ['herdr'],
      pythonReady: true,
      pythonVersion: '3.12'
    };
    const calls = { apply: 0, disable: 0, restore: 0 };
    const restorePayloads = [];

    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      getEnhanceStatus: async () => ({ ok: true, data: { supported: true, summary: { promptTier: 0, chineseTitleMode: 'en' } } }),
      applyEnhancePatch: async () => ({ ok: true, needsRestart: false }),
      restoreAllEnhance: async () => ({ ok: true, needsRestart: false }),
      getModulesStatus: async () => ({ ok: true, data: { modules: { chinese: { enabled: false, brandTitle: 'english' }, proxy: { enabled: false } } }, disk: {} }),
      toggleModule: async () => ({ ok: true, restartRequired: false }),
      applyContextUnlock: async () => ({ ok: true, needsRestart: false }),
      restoreContextUnlock: async () => ({ ok: true, needsRestart: false }),
      getRehydrateStatus: async () => ({ ok: true, data: mockStatus }),
      applyRehydrate: async () => {
        calls.apply++;
        mockStatus = { ...mockStatus, status: 'enabled', hookRegistered: true, hookEnabled: true, scriptInstalled: true, scriptMatchesBundled: true };
        return { ok: true, changed: true, status: mockStatus };
      },
      disableRehydrate: async () => {
        calls.disable++;
        mockStatus = { ...mockStatus, status: 'disabled', hookRegistered: true, hookEnabled: false };
        return { ok: true, changed: true, status: mockStatus };
      },
      restoreRehydrate: async (opts) => {
        calls.restore++;
        restorePayloads.push(opts && typeof opts === 'object' ? JSON.parse(JSON.stringify(opts)) : opts);
        mockStatus = { ...mockStatus, status: 'not_installed', hookRegistered: false, hookEnabled: false, scriptInstalled: false };
        return { ok: true, changed: true, status: mockStatus };
      }
    };

    h.elements.get('btn-ctx-settings').click();
    await h.flush();

    assert.equal(h.elements.get('rehydrate-badge').textContent, '未开启');
    assert.match(h.elements.get('rehydrate-stat-siblings').textContent, /herdr/);

    // 单独卡片启用 -> 停用 -> 二次确认显式卸载移除（首次点击仅进入确认态，二次点击才传入 { force: true }）
    h.elements.get('btn-rehydrate-enable').click();
    await h.flush();
    assert.equal(calls.apply, 1);
    assert.equal(h.elements.get('rehydrate-badge').textContent, '已开启');

    h.elements.get('btn-rehydrate-disable').click();
    await h.flush();
    assert.equal(calls.disable, 1);
    assert.equal(h.elements.get('rehydrate-badge').textContent, '已停用');

    h.elements.get('btn-rehydrate-remove').click();
    await h.flush();
    assert.equal(calls.restore, 0, '首次点击 btn-rehydrate-remove 不得直接执行卸载');
    assert.equal(h.elements.get('btn-rehydrate-remove').textContent, '确认卸载？');
    assert.match(h.elements.get('rehydrate-result-text').textContent, /确认卸载/);

    // 刷新状态或切换语言应自动解除二次确认态
    h.elements.get('btn-rehydrate-refresh').click();
    await h.flush();
    assert.equal(h.elements.get('btn-rehydrate-remove').textContent, '卸载移除');
    assert.equal(calls.restore, 0);

    // 再次连续点击两次执行真正卸载
    h.elements.get('btn-rehydrate-remove').click();
    assert.equal(calls.restore, 0);
    h.elements.get('btn-rehydrate-remove').click();
    await h.flush();
    assert.equal(calls.restore, 1);
    assert.deepEqual(restorePayloads[0], { force: true });
    assert.equal(h.elements.get('rehydrate-badge').textContent, '未开启');

    // 推荐配置勾选框联动启用与「全部恢复官方默认」（默认恢复不得传 force: true）
    h.elements.get('chk-rec-prompt').checked = false;
    h.elements.get('chk-rec-title').checked = false;
    h.elements.get('chk-rec-lang').checked = false;
    h.elements.get('chk-rec-ctx').checked = false;
    h.elements.get('chk-rec-rehydrate').checked = true;
    h.elements.get('btn-enhance-preset-apply').click();
    h.elements.get('btn-enhance-confirm-go').click();
    await h.flush();
    assert.equal(calls.apply, 2);

    h.elements.get('btn-enhance-restore-all').click();
    h.elements.get('btn-enhance-confirm-go').click();
    await h.flush();
    assert.equal(calls.restore, 2);
    assert.deepEqual(restorePayloads[1], {});

    // 点击参考方案外链时应显示「参考方案页面」提示，而非「原作者帖子」
    h.sandbox.window.contextMeterAPI.openExternal = async () => ({ ok: true });
    h.elements.get('link-rehydrate-author').trigger('click', { preventDefault() {}, stopPropagation() {} });
    await h.flush();
    assert.match(h.elements.get('rehydrate-link-toast').textContent, /参考方案页面/);
    assert.doesNotMatch(h.elements.get('rehydrate-link-toast').textContent, /原作者帖子/);

    // 三语言检查，且英文模式绝无中文残留
    const keysToCheck = [
      'enhance.preset.itemRehydrate',
      'rehydrate.card.title',
      'rehydrate.stat.hook',
      'rehydrate.btn.enable',
      'rehydrate.btn.removeConfirm',
      'rehydrate.result.confirmRemoveHint',
      'rehydrate.credit.source',
      'rehydrate.credit.author',
      'rehydrate.credit.linkOpened',
      'rehydrate.credit.adapter',
      'rehydrate.result.enabled',
      'rehydrate.err.noPython310',
      'rehydrate.err.corruptHooksJson',
      'rehydrate.err.corruptModulesJson',
      'rehydrate.err.missingBackup'
    ];
    for (const lang of ['zh-CN', 'zh-TW', 'en']) {
      await h.api.setPanelLanguage(lang, { persist: false });
      for (const k of keysToCheck) {
        const val = h.api.translateForTest(k, { path: '~/.gemini/config/hooks.json' });
        assert.ok(val && val !== k, `缺少译文: ${lang}:${k}`);
        if (lang === 'en') {
          assert.equal(/[\u4e00-\u9fa5]/.test(val), false, `EN 文案不得包含汉字 (${k}): ${val}`);
        }
      }
    }
  } finally {
    h.api.dispose();
  }
});

test('6. 安装器、卸载器与发布打包清单完整包含 rehydrate 模块', () => {
  const installSrc = fs.readFileSync(path.join(__dirname, 'install.js'), 'utf8');
  const restoreSrc = fs.readFileSync(path.join(__dirname, 'restore.js'), 'utf8');
  const pkgRelSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'package-release.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'modular-installer.js'), 'utf8');
  const liveHostSrc = fs.readFileSync(path.join(__dirname, 'live-host.js'), 'utf8');

  assert.equal(installSrc.includes("'meter-rehydrate.js'"), true);
  assert.equal(installSrc.includes("'dist/rehydrate/rehydrate_after_compact.py'"), true);
  assert.equal(restoreSrc.includes("'meter-rehydrate.js'"), true);
  assert.equal(restoreSrc.includes("'rehydrate'"), true);
  assert.equal(pkgRelSrc.includes("'meter-rehydrate.js'"), true);
  assert.equal(pkgRelSrc.includes("'rehydrate/rehydrate_after_compact.py'"), true);
  assert.equal(pkgRelSrc.includes('AGY-rehydrate-slim-lts-release-v2.md'), false);
  assert.equal(pkgRelSrc.includes("'rehydrate/README.md'"), true);
  assert.equal(preloadSrc.includes('getRehydrateStatus: () => electron_1.ipcRenderer.invoke("context-meter:rehydrate-status")'), true);
  assert.equal(preloadSrc.includes('applyRehydrate: () => electron_1.ipcRenderer.invoke("context-meter:rehydrate-apply")'), true);
  assert.equal(preloadSrc.includes('disableRehydrate: () => electron_1.ipcRenderer.invoke("context-meter:rehydrate-disable")'), true);
  assert.equal(preloadSrc.includes('restoreRehydrate: (opts) => electron_1.ipcRenderer.invoke("context-meter:rehydrate-restore", opts && opts.force === true ? { force: true } : {})'), true);
  assert.equal(liveHostSrc.includes("sanitizeRehydrateRendererOptions(request, 'status')"), true);
  assert.equal(liveHostSrc.includes("sanitizeRehydrateRendererOptions(request, 'apply')"), true);
  assert.equal(liveHostSrc.includes("sanitizeRehydrateRendererOptions(request, 'disable')"), true);
  assert.equal(liveHostSrc.includes("sanitizeRehydrateRendererOptions(request, 'restore')"), true);
});

test('7. 安全边界 (P1 #1)：主进程 IPC 与选项白名单完全丢弃渲染层传入的路径和脚本覆盖参数', async () => {
  const env = createTmpIsolatedEnv('ag-rehydrate-sec-');
  const attackerDir = path.join(env.root, 'attacker-config');
  const attackerHome = path.join(env.root, 'attacker-home');
  const attackerState = path.join(env.root, 'attacker-state');
  const evilScriptPath = path.join(env.root, 'evil_payload.py');
  fs.mkdirSync(attackerDir, { recursive: true });
  fs.mkdirSync(attackerHome, { recursive: true });
  fs.mkdirSync(attackerState, { recursive: true });
  fs.writeFileSync(evilScriptPath, 'print("PWNED")\n', 'utf8');

  const maliciousPayload = {
    configDir: attackerDir,
    homeDir: attackerHome,
    stateDir: attackerState,
    bundledScriptPath: evilScriptPath,
    platform: 'linux',
    _pythonProbe: () => ({ ok: true, command: 'evil-py', executable: 'evil-py', version: '9.9' }),
    force: true
  };

  assert.deepEqual(rehydrate.sanitizeRehydrateRendererOptions(maliciousPayload, 'status'), {});
  assert.deepEqual(rehydrate.sanitizeRehydrateRendererOptions(maliciousPayload, 'apply'), {});
  assert.deepEqual(rehydrate.sanitizeRehydrateRendererOptions(maliciousPayload, 'disable'), {});
  assert.deepEqual(rehydrate.sanitizeRehydrateRendererOptions(maliciousPayload, 'restore'), { force: true });
  assert.deepEqual(rehydrate.sanitizeRehydrateRendererOptions({ force: 'true', configDir: attackerDir }, 'restore'), {});

  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevGeminiDir = process.env.AG_METER_GEMINI_CONFIG_DIR;
  process.env.AG_METER_STATE_DIR = env.stateDir;
  process.env.AG_METER_GEMINI_CONFIG_DIR = env.configDir;

  try {
    delete require.cache[require.resolve('./meter-main')];
    const { registerMeterIpcHandlers } = require('./meter-main');
    const handlers = {};
    registerMeterIpcHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } });
    const localFrame = { url: 'https://127.0.0.1:5173/' };
    const ev = { senderFrame: localFrame, sender: { mainFrame: localFrame } };

    const stRes = await handlers['context-meter:rehydrate-status'](ev, maliciousPayload);
    assert.equal(stRes.ok, true);
    assert.equal(path.resolve(stRes.data.configDir), path.resolve(env.configDir), 'status 绝不能采用渲染层指定的 configDir');

    const applyRes = await handlers['context-meter:rehydrate-apply'](ev, maliciousPayload);
    assert.equal(fs.existsSync(path.join(attackerDir, 'hooks.json')), false, '攻击者指定目录绝不能被写入 hooks.json');
    assert.equal(fs.existsSync(path.join(attackerDir, 'hooks', 'rehydrate_after_compact.py')), false, '攻击者指定目录绝不能部署脚本');
    assert.equal(fs.existsSync(path.join(attackerState, 'modules.json')), false, '攻击者指定 stateDir 绝不能被写入');
    if (applyRes.ok) {
      const deployedText = fs.readFileSync(path.join(env.configDir, 'hooks', 'rehydrate_after_compact.py'), 'utf8');
      assert.notEqual(deployedText, 'print("PWNED")\n', '绝不能采用渲染层传入的 bundledScriptPath');
      assert.equal(applyRes.status.command.includes('evil-py'), false, '绝不能采用渲染层伪造的 _pythonProbe');
      const hooksJson = JSON.parse(fs.readFileSync(path.join(env.configDir, 'hooks.json'), 'utf8'));
      assert.equal(hooksJson['post-compact-rehydrate'].PreInvocation[0].command.includes('evil_payload'), false);

      await handlers['context-meter:rehydrate-disable'](ev, maliciousPayload);
      const afterDis = JSON.parse(fs.readFileSync(path.join(env.configDir, 'hooks.json'), 'utf8'));
      assert.equal(afterDis['post-compact-rehydrate'].enabled, false);

      await handlers['context-meter:rehydrate-restore'](ev, { configDir: attackerDir });
      const afterRes = JSON.parse(fs.readFileSync(path.join(env.configDir, 'hooks.json'), 'utf8'));
      assert.equal(Object.prototype.hasOwnProperty.call(afterRes, 'post-compact-rehydrate'), false);
    }
  } finally {
    delete require.cache[require.resolve('./meter-main')];
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    if (prevGeminiDir !== undefined) process.env.AG_METER_GEMINI_CONFIG_DIR = prevGeminiDir;
    else delete process.env.AG_METER_GEMINI_CONFIG_DIR;
    env.cleanup();
  }
});

test('8. 独立 Hook 保护 (P1 #2)：默认恢复绝不误删用户独立部署的 Hook，并可退回接管前自定义状态', () => {
  const env = createTmpIsolatedEnv('ag-rehydrate-unmanaged-');
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = env.stateDir;

  try {
    const hooksDir = path.join(env.configDir, 'hooks');
    const hooksJsonPath = path.join(env.configDir, 'hooks.json');
    const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
    fs.mkdirSync(hooksDir, { recursive: true });

    const independentEntry = {
      enabled: true,
      PreInvocation: [
        { type: 'command', command: 'python -X utf8 hooks/rehydrate_after_compact.py', timeout: 25 }
      ]
    };
    const independentHooks = {
      herdr: {
        PreInvocation: [{ type: 'command', command: 'powershell -File herdr.ps1', timeout: 10 }]
      },
      'post-compact-rehydrate': independentEntry
    };
    const independentHooksRaw = JSON.stringify(independentHooks, null, 2) + '\n';
    const independentScriptRaw = '# independent user script v1\nprint("{}")\n';
    fs.writeFileSync(hooksJsonPath, independentHooksRaw, 'utf8');
    fs.writeFileSync(scriptPath, independentScriptRaw, 'utf8');

    const mockPy = () => ({ ok: true, command: 'python', executable: 'python', version: '3.12' });
    const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };

    // A. 未经过插件开启（managed=false）时，触发默认恢复（全部恢复官方默认 / restore --all）绝不删改独立 Hook
    const skipRes = rehydrate.restoreRehydrate(opts);
    assert.equal(skipRes.ok, true);
    assert.equal(skipRes.changed, false);
    assert.equal(skipRes.skippedUnmanaged, true);
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf8'), independentHooksRaw, '未托管的 hooks.json 必须字节不变');
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), independentScriptRaw, '未托管的脚本必须字节不变');
    assert.equal(skipRes.status.status, 'enabled');

    // B. 插件接管后再次触发默认恢复：精准退回插件接管前的独立 Hook 与原自定义脚本
    const takeOverRes = rehydrate.applyRehydrate(opts);
    assert.equal(takeOverRes.ok, true);
    assert.equal(takeOverRes.changed, true);
    const bundledText = fs.readFileSync(path.join(__dirname, 'rehydrate', 'rehydrate_after_compact.py'), 'utf8');
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), bundledText);

    const revertRes = rehydrate.restoreRehydrate(opts);
    assert.equal(revertRes.ok, true);
    assert.equal(revertRes.changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')), independentHooks, '默认恢复后应精准还原接管前的 post-compact-rehydrate 条目');
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), independentScriptRaw, '默认恢复后应精准还原接管前的自定义脚本');
    assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), false);

    // B2. 全新由插件创建启用后，若用户手动把 post-compact-rehydrate 改写成无关外部脚本，默认恢复不误删该条目
    const env2 = createTmpIsolatedEnv('ag-rehydrate-rewritten-');
    try {
      const opts2 = { configDir: env2.configDir, stateDir: path.join(env2.root, 'state2'), _pythonProbe: mockPy };
      assert.equal(rehydrate.applyRehydrate(opts2).ok, true);
      const hj2Path = path.join(env2.configDir, 'hooks.json');
      const manualEntry = {
        enabled: true,
        PreInvocation: [{ type: 'command', command: 'node custom-other-hook.js', timeout: 10 }]
      };
      fs.writeFileSync(hj2Path, JSON.stringify({ 'post-compact-rehydrate': manualEntry }, null, 2) + '\n', 'utf8');
      const revert2 = rehydrate.restoreRehydrate(opts2);
      assert.equal(revert2.ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(hj2Path, 'utf8'))['post-compact-rehydrate'], manualEntry);
    } finally {
      env2.cleanup();
    }

    // C. 显式卸载移除（force: true）才删除 post-compact-rehydrate 并保留 herdr 与 .bak 备份
    const forceRes = rehydrate.restoreRehydrate({ ...opts, force: true });
    assert.equal(forceRes.ok, true);
    assert.equal(forceRes.changed, true);
    assert.equal(fs.existsSync(scriptPath), false);
    assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), independentScriptRaw);
    const finalHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.deepEqual(finalHooks, { herdr: independentHooks.herdr });
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    env.cleanup();
  }
});

test('9. 备份与基线一致性边界（1 个 P1 + 2 个 P2）：双版本零丢失、失败重试基线保留与缺失备份中止还原', () => {
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const mockPy = () => ({ ok: true, command: 'python', executable: 'python', version: '3.12' });

  try {
    // 1. P1：多轮显式卸载无历史丢失（内容寻址历史归档 + 重复内容幂等去重）
    {
      const env = createTmpIsolatedEnv('ag-rh-dualver-');
      process.env.AG_METER_STATE_DIR = env.stateDir;
      try {
        const sha8 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
        const hooksDir = path.join(env.configDir, 'hooks');
        const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
        fs.mkdirSync(hooksDir, { recursive: true });

        const v1 = '# v1 independent\n';
        const v2 = '# v2 modified after deploy\n';
        const v3 = '# v3 second lifecycle\n';
        const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };

        // 第一轮：v1 -> 接管 -> 手改 v2 -> 显式卸载
        fs.writeFileSync(scriptPath, v1, 'utf8');
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);
        fs.writeFileSync(scriptPath, v2, 'utf8');
        const force1 = rehydrate.restoreRehydrate({ ...opts, force: true });
        assert.equal(force1.ok, true);
        assert.equal(fs.existsSync(scriptPath), false);
        assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), false);
        assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), v2);
        assert.equal(fs.readFileSync(`${scriptPath}.bak.${sha8(v1)}`, 'utf8'), v1);

        // 第二轮：写入 v3 -> 再次接管 -> 再次显式卸载（确保 v1 / v2 / v3 全部完好且相同内容不产生重复文件）
        fs.writeFileSync(scriptPath, v3, 'utf8');
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);
        assert.equal(rehydrate.applyRehydrate(opts).ok, true); // 重复调用幂等，不生成冗余备份
        const force2 = rehydrate.restoreRehydrate({ ...opts, force: true });
        assert.equal(force2.ok, true);
        assert.equal(fs.existsSync(scriptPath), false);
        assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), false);
        assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), v3);
        assert.equal(fs.readFileSync(`${scriptPath}.bak.${sha8(v2)}`, 'utf8'), v2);
        assert.equal(fs.readFileSync(`${scriptPath}.bak.${sha8(v1)}`, 'utf8'), v1);
      } finally {
        env.cleanup();
      }
    }

    // 1b. P1：脚本已被外部提前删除时，force 移除应将 .pre-plugin.bak 提升为 .bak 而不是删除丢失
    {
      const env = createTmpIsolatedEnv('ag-rh-extdel-');
      process.env.AG_METER_STATE_DIR = env.stateDir;
      try {
        const hooksDir = path.join(env.configDir, 'hooks');
        const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(scriptPath, '# v1 only in pre-plugin bak\n', 'utf8');

        const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);
        fs.unlinkSync(scriptPath);
        if (fs.existsSync(`${scriptPath}.bak`)) fs.unlinkSync(`${scriptPath}.bak`);

        const forceRes = rehydrate.restoreRehydrate({ ...opts, force: true });
        assert.equal(forceRes.ok, true);
        assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), '# v1 only in pre-plugin bak\n');
        assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), false);
      } finally {
        env.cleanup();
      }
    }

    // 2. P2：首次 apply 在捕获基线、覆写脚本后中断（managed 仍为 false），重试后再默认恢复应精准还原初始 v1 基线
    {
      const env = createTmpIsolatedEnv('ag-rh-retry-');
      process.env.AG_METER_STATE_DIR = env.stateDir;
      try {
        const hooksDir = path.join(env.configDir, 'hooks');
        const hooksJsonPath = path.join(env.configDir, 'hooks.json');
        const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
        fs.mkdirSync(hooksDir, { recursive: true });

        const origEntry = {
          enabled: true,
          PreInvocation: [{ type: 'command', command: 'python -X utf8 hooks/rehydrate_after_compact.py', timeout: 30 }]
        };
        fs.writeFileSync(hooksJsonPath, JSON.stringify({ 'post-compact-rehydrate': origEntry }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(scriptPath, '# initial custom v1\n', 'utf8');

        const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);

        // 模拟写入状态尚未置 managed=true 时发生中断，但基线（baselineCaptured: true）已在改写前安全落盘
        const cfg = modulesCfg.loadModulesConfig({ stateDir: env.stateDir });
        cfg.modules.rehydrate.managed = false;
        cfg.modules.rehydrate.enabled = false;
        modulesCfg.saveModulesConfig(cfg, { stateDir: env.stateDir });

        const retryApply = rehydrate.applyRehydrate(opts);
        assert.equal(retryApply.ok, true);
        assert.equal(retryApply.changed, true);

        const revertRes = rehydrate.restoreRehydrate(opts);
        assert.equal(revertRes.ok, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'))['post-compact-rehydrate'], origEntry);
        assert.equal(fs.readFileSync(scriptPath, 'utf8'), '# initial custom v1\n');
      } finally {
        env.cleanup();
      }
    }

    // 3. P2：接管前自定义脚本的 .pre-plugin.bak 缺失时，默认恢复应明确报错中止且不破坏 hooks.json / 托管态；force 移除仍可清理
    {
      const env = createTmpIsolatedEnv('ag-rh-missbak-');
      process.env.AG_METER_STATE_DIR = env.stateDir;
      try {
        const hooksDir = path.join(env.configDir, 'hooks');
        const hooksJsonPath = path.join(env.configDir, 'hooks.json');
        const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
        fs.mkdirSync(hooksDir, { recursive: true });

        const origEntry = {
          enabled: true,
          PreInvocation: [{ type: 'command', command: 'python -X utf8 hooks/rehydrate_after_compact.py', timeout: 15 }]
        };
        fs.writeFileSync(hooksJsonPath, JSON.stringify({ 'post-compact-rehydrate': origEntry }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(scriptPath, '# custom v1 to lose if missing\n', 'utf8');

        const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);
        const beforeHooks = fs.readFileSync(hooksJsonPath, 'utf8');

        fs.unlinkSync(`${scriptPath}.pre-plugin.bak`);
        const abortedRestore = rehydrate.restoreRehydrate(opts);
        assert.equal(abortedRestore.ok, false);
        assert.equal(abortedRestore.errorKey, 'rehydrate.err.missingBackup');
        assert.equal(fs.readFileSync(hooksJsonPath, 'utf8'), beforeHooks, '中止还原时不得半途篡改 hooks.json');
        assert.equal(modulesCfg.loadModulesConfig({ stateDir: env.stateDir }).modules.rehydrate.managed, true);

        const forceCleanup = rehydrate.restoreRehydrate({ ...opts, force: true });
        assert.equal(forceCleanup.ok, true);
        assert.equal(fs.existsSync(scriptPath), false);
      } finally {
        env.cleanup();
      }
    }

    // 4. P2：默认恢复已还原 scriptPath=v1 与 .bak=v2，但在写回 modules.json 状态前中断；重试恢复必须成功且不覆写 .bak=v2
    {
      const env = createTmpIsolatedEnv('ag-rh-restoreretry-');
      process.env.AG_METER_STATE_DIR = env.stateDir;
      try {
        const hooksDir = path.join(env.configDir, 'hooks');
        const scriptPath = path.join(hooksDir, 'rehydrate_after_compact.py');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(scriptPath, '# v1 baseline\n', 'utf8');

        const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };
        assert.equal(rehydrate.applyRehydrate(opts).ok, true);
        fs.writeFileSync(scriptPath, '# v2 edited during managed\n', 'utf8');

        // 模拟第一次 restore 写回 .bak=v2 和 scriptPath=v1 后状态尚未翻转为 managed=false 的场景
        fs.writeFileSync(`${scriptPath}.bak`, '# v2 edited during managed\n', 'utf8');
        fs.writeFileSync(scriptPath, '# v1 baseline\n', 'utf8');
        assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), true);

        const retryRestore = rehydrate.restoreRehydrate(opts);
        assert.equal(retryRestore.ok, true);
        assert.equal(fs.readFileSync(scriptPath, 'utf8'), '# v1 baseline\n');
        assert.equal(fs.readFileSync(`${scriptPath}.bak`, 'utf8'), '# v2 edited during managed\n');
        assert.equal(fs.existsSync(`${scriptPath}.pre-plugin.bak`), false);
        assert.equal(modulesCfg.loadModulesConfig({ stateDir: env.stateDir }).modules.rehydrate.managed, false);
      } finally {
        env.cleanup();
      }
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
  }
});

test('10. v0.8.7 集成对齐：modules.json 损坏 fail-closed 保护 & 同版本热加载与渲染层能力校验', async () => {
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const env = createTmpIsolatedEnv('ag-rh-v087-');
  const mockPy = () => ({ ok: true, version: '3.12.2', command: 'python' });
  try {
    process.env.AG_METER_STATE_DIR = env.stateDir;
    const hooksJsonPath = path.join(env.configDir, 'hooks.json');
    const modJsonPath = path.join(env.stateDir, 'modules.json');
    const origHooks = JSON.stringify({
      herdr: { enabled: true, PostResponse: [{ command: 'herdr', timeout: 5 }] },
      'post-compact-rehydrate': { enabled: true, PreInvocation: [{ type: 'command', command: 'python custom.py', timeout: 15 }] }
    }, null, 2) + '\n';
    const corruptModules = '{"schemaVersion":"0.8.7","modules":{"proxy":{"enabled":true';
    fs.writeFileSync(hooksJsonPath, origHooks, 'utf8');
    fs.writeFileSync(modJsonPath, corruptModules, 'utf8');

    const opts = { configDir: env.configDir, stateDir: env.stateDir, _pythonProbe: mockPy };
    const st = rehydrate.getRehydrateStatus(opts);
    assert.equal(st.modulesConfigValid, false);
    assert.equal(st.errorKey, 'rehydrate.err.corruptModulesJson');

    for (const actionRes of [
      rehydrate.applyRehydrate(opts),
      rehydrate.disableRehydrate(opts),
      rehydrate.restoreRehydrate(opts)
    ]) {
      assert.equal(actionRes.ok, false);
      assert.equal(actionRes.errorKey, 'rehydrate.err.corruptModulesJson');
      assert.equal(fs.readFileSync(modJsonPath, 'utf8'), corruptModules, '损坏的 modules.json 不得被重置覆写');
      assert.equal(fs.readFileSync(hooksJsonPath, 'utf8'), origHooks, '中止操作时不得修改 hooks.json');
    }

    const forceRes = rehydrate.restoreRehydrate({ ...opts, force: true });
    assert.equal(forceRes.ok, true);
    assert.equal(fs.readFileSync(modJsonPath, 'utf8'), corruptModules, '强制卸载清理 Hook 时仍不得覆写损坏的 modules.json');
    const hooksAfter = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(hooksAfter['post-compact-rehydrate'], undefined);
    assert.ok(hooksAfter.herdr);

    // 同版本热加载（免绑定端口，适配受限沙箱）：若运行中宿主缺乏 rehydrate IPC 能力，不得提前跳过 live-host
    const pkgVer = modulesCfg.PROJECT_VERSION;
    const origin = 'https://127.0.0.1:55111';
    const token = 'rh-cap-secret';
    fs.writeFileSync(path.join(env.stateDir, '.live-session.json'), JSON.stringify({
      port: 43211,
      token,
      pid: process.pid,
      origin,
      origins: [origin],
      version: pkgVer,
      hasQuota: true
    }), 'utf8');

    const probeWithRehydrate = async () => ({
      ok: true,
      backendVersion: pkgVer,
      capabilities: { quota: true, rehydrate: true },
      origins: [origin]
    });

    const lackingRehydrateIpc = await ensureLiveBridgeIfNeeded({
      running: true,
      pageFound: true,
      origin,
      origins: [origin],
      hasIpcBridge: true,
      hasQuotaIpcBridge: true,
      hasRehydrateIpcBridge: false,
      ipcBackendVersion: pkgVer
    }, { _probeLiveHost: probeWithRehydrate });
    assert.equal(lackingRehydrateIpc.needed, true);
    assert.equal(lackingRehydrateIpc.ready, true);
    assert.equal(lackingRehydrateIpc.reused, true);
    assert.equal(lackingRehydrateIpc.backendSource, 'live-host');

    const alignedIpc = await ensureLiveBridgeIfNeeded({
      running: true,
      pageFound: true,
      origin,
      origins: [origin],
      hasIpcBridge: true,
      hasQuotaIpcBridge: true,
      hasRehydrateIpcBridge: true,
      ipcBackendVersion: pkgVer
    }, { _probeLiveHost: probeWithRehydrate });
    assert.equal(alignedIpc.needed, false);
    assert.equal(alignedIpc.backendSource, 'electron-ipc');

    // 渲染层能力门控：未显式声明 rehydrate 的旧 live-host 绝不能被发送 /rehydrate-* 请求
    const h = createRendererHarness();
    try {
      const fetchedUrls = [];
      delete h.sandbox.window.contextMeterAPI.getRehydrateStatus;
      h.sandbox.window.__AGContextMeterLive = {
        port: 43210,
        token: 'tok',
        version: pkgVer,
        capabilities: { scan: true, quota: true, enhance: true }
      };
      h.sandbox.fetch = async (url) => {
        fetchedUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: { supported: true, status: 'not_installed', hooksFileValid: true, modulesConfigValid: true, pythonReady: true, otherHookNames: [] }
          })
        };
      };

      await h.api.refreshRehydrateStatusForTest();
      assert.equal(fetchedUrls.filter(u => u.includes('/rehydrate-')).length, 0, '旧 live-host 未声明 rehydrate 时不得发起 /rehydrate-* 请求');
      assert.equal(h.elements.get('rehydrate-badge').textContent, '未读取');

      h.sandbox.window.__AGContextMeterLive.capabilities.rehydrate = true;
      await h.api.refreshRehydrateStatusForTest();
      assert.equal(fetchedUrls.some(u => u.includes('/rehydrate-status')), true, '显式声明 rehydrate: true 后应恢复请求 /rehydrate-status');
      assert.equal(h.elements.get('rehydrate-badge').textContent, '未开启');
    } finally {
      h.api.dispose();
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    env.cleanup();
  }
});

test('11. POSIX 词法 PATH 解析（保留 Homebrew 符号链接不落入 Cellar）、ok:true 探测缓存与 skipPythonProbe 验证', async () => {
  const childProcess = require('node:child_process');
  const origStatSync = fs.statSync;
  const origAccessSync = fs.accessSync;
  const origRealpathSync = fs.realpathSync;
  const origExecFileSync = childProcess.execFileSync;
  const origExecFile = childProcess.execFile;

  const fakeBrewBin = '/tmp/ag-mock-brew-991/homebrew/bin';
  const fakeBrewPy = `${fakeBrewBin}/python3`;
  const fakeCellarPy = '/tmp/ag-mock-brew-991/homebrew/Cellar/python@3.12/3.12.7/bin/python3';
  const mockEnvPath = `.:node_modules/.bin:/usr/local/missing:${fakeBrewBin}:/usr/bin`;

  let syncSpawns = 0;
  let asyncSpawns = 0;
  let mockProbeOutput = `3.12|${fakeCellarPy}\n`;

  try {
    fs.statSync = (target, ...rest) => {
      const s = String(target);
      if (s === 'python3' || s === 'node_modules/.bin/python3' || s === fakeBrewPy || s === fakeCellarPy) {
        return { isFile: () => true };
      }
      return origStatSync.call(fs, target, ...rest);
    };
    fs.accessSync = (target, ...rest) => {
      const s = String(target);
      if (s === 'python3' || s === 'node_modules/.bin/python3' || s === fakeBrewPy || s === fakeCellarPy) {
        return undefined;
      }
      return origAccessSync.call(fs, target, ...rest);
    };
    fs.realpathSync = (target, ...rest) => {
      if (String(target) === fakeBrewPy) {
        throw new Error('resolvePosixCommandInPath 不得调用 realpathSync 解析 Homebrew 符号链接');
      }
      return origRealpathSync.call(fs, target, ...rest);
    };
    childProcess.execFileSync = (cmd, args, opts) => {
      if (Array.isArray(args) && args[0] === '-c') {
        syncSpawns++;
        return mockProbeOutput;
      }
      return origExecFileSync.call(childProcess, cmd, args, opts);
    };
    childProcess.execFile = (cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (Array.isArray(args) && args[0] === '-c') {
        asyncSpawns++;
        setImmediate(() => callback(null, mockProbeOutput, ''));
        return {};
      }
      return origExecFile.call(childProcess, cmd, args, opts, cb);
    };

    assert.equal(rehydrate.resolvePosixCommandInPath('python3', mockEnvPath), fakeBrewPy);

    // 1. darwin 下返回词法 Homebrew bin 路径，而非裸 'python3' 或 Cellar 物理路径
    rehydrate.clearPythonProbeCache();
    const res1 = rehydrate.resolvePython310({ platform: 'darwin', envPath: mockEnvPath });
    assert.equal(res1.ok, true);
    assert.equal(res1.command, fakeBrewPy);
    assert.notEqual(res1.command, 'python3');
    assert.equal(res1.command.includes('Cellar'), false);
    assert.equal(res1.executable, fakeCellarPy);
    assert.equal(syncSpawns, 1);

    // 2. ok: true 短 TTL 内存缓存命中（同步与异步共享，不再重复拉起 Python 进程）
    const res2 = rehydrate.resolvePython310({ platform: 'darwin', envPath: mockEnvPath });
    const res3 = await rehydrate.resolvePython310Async({ platform: 'darwin', envPath: mockEnvPath });
    assert.equal(res2.command, fakeBrewPy);
    assert.equal(res3.command, fakeBrewPy);
    assert.equal(syncSpawns, 1, 'ok: true 缓存有效期内不得再次同步拉起 Python');
    assert.equal(asyncSpawns, 0, 'ok: true 缓存有效期内不得再次异步拉起 Python');

    // 3. ok: false 不缓存，确保用户新安装 Python 3.10+ 后立即可被探测到
    rehydrate.clearPythonProbeCache();
    mockProbeOutput = '3.9|/usr/bin/python3\n';
    const failProbe = rehydrate.resolvePython310({ platform: 'darwin', envPath: mockEnvPath });
    assert.equal(failProbe.ok, false);
    const spawnsAfterFail = syncSpawns;
    mockProbeOutput = `3.12|${fakeCellarPy}\n`;
    const recoveredProbe = rehydrate.resolvePython310({ platform: 'darwin', envPath: mockEnvPath });
    assert.equal(recoveredProbe.ok, true);
    assert.equal(recoveredProbe.command, fakeBrewPy);
    assert.equal(syncSpawns, spawnsAfterFail + 1, 'ok: false 不得被缓存拦截后续探测');

    // 4. win32 保持返回裸命令 'python'
    rehydrate.clearPythonProbeCache();
    mockProbeOutput = '3.12|C:\\Python312\\python.exe\n';
    const winRes = rehydrate.resolvePython310({ platform: 'win32', envPath: 'C:\\Python312' });
    assert.equal(winRes.ok, true);
    assert.equal(winRes.command, 'python');

    // 5. restoreRehydrate / restoreRehydrateAsync 支持 skipPythonProbe: true（零次探测调用）
    const env = createTmpIsolatedEnv('ag-rh-skip-probe-');
    const prevStateDir = process.env.AG_METER_STATE_DIR;
    process.env.AG_METER_STATE_DIR = env.stateDir;
    try {
      const baseOpts = {
        configDir: env.configDir,
        stateDir: env.stateDir,
        _pythonProbe: () => ({ ok: true, command: 'python', executable: 'python', version: '3.12' })
      };
      assert.equal(rehydrate.applyRehydrate(baseOpts).ok, true);

      rehydrate.clearPythonProbeCache();
      const beforeSync = syncSpawns;
      const beforeAsync = asyncSpawns;
      let spyCalls = 0;
      const rSync = rehydrate.restoreRehydrate({
        configDir: env.configDir,
        stateDir: env.stateDir,
        skipPythonProbe: true,
        _pythonProbe: () => {
          spyCalls++;
          return { ok: true, command: 'python', executable: 'python', version: '3.12' };
        }
      });
      assert.equal(rSync.ok, true);
      assert.equal(rSync.changed, true);
      assert.equal(spyCalls, 0, 'skipPythonProbe: true 时 restoreRehydrate 不得调用 probe');
      assert.equal(syncSpawns, beforeSync);

      assert.equal(rehydrate.applyRehydrate(baseOpts).ok, true);
      const rAsync = await rehydrate.restoreRehydrateAsync({
        configDir: env.configDir,
        stateDir: env.stateDir,
        skipPythonProbe: true,
        _pythonProbe: async () => {
          spyCalls++;
          return { ok: true, command: 'python', executable: 'python', version: '3.12' };
        }
      });
      assert.equal(rAsync.ok, true);
      assert.equal(rAsync.changed, true);
      assert.equal(spyCalls, 0, 'skipPythonProbe: true 时 restoreRehydrateAsync 不得调用 probe');
      assert.equal(asyncSpawns, beforeAsync);
    } finally {
      if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
      else delete process.env.AG_METER_STATE_DIR;
      env.cleanup();
    }
  } finally {
    fs.statSync = origStatSync;
    fs.accessSync = origAccessSync;
    fs.realpathSync = origRealpathSync;
    childProcess.execFileSync = origExecFileSync;
    childProcess.execFile = origExecFile;
    rehydrate.clearPythonProbeCache();
  }
});

test('8. 缺 Python 时一键安装：win32 下载解压路径、已就绪短路与 UI 安装按钮联动', async () => {
  const env = createTmpIsolatedEnv('ag-rh-py-install-');
  try {
    const cliDir = path.join(env.configDir, 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive: true });

    // 1. 模拟缺 Python -> win32 内嵌版下载并解压，随后重新探测就绪
    let probeReady = false;
    const downloadCalls = [];
    const execCalls = [];
    const okRes = await rehydrate.installPythonRuntimeAsync({
      cliDir,
      homeDir: env.root,
      stateDir: env.stateDir,
      platform: 'win32',
      arch: 'x64',
      _probePython: async () => (probeReady
        ? { ok: true, executable: path.join(cliDir, 'runtimes', 'python', 'python.exe'), version: '3.12.8', versionTuple: [3, 12, 8] }
        : { ok: false, executable: null, reason: 'missing' }),
      _downloadFile: async (url, dest) => {
        downloadCalls.push({ url, dest });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from('PK_MOCK_ZIP'));
      },
      _execFile: async (bin, args) => {
        execCalls.push({ bin, args });
        const targetPy = path.join(cliDir, 'runtimes', 'python', 'python.exe');
        fs.mkdirSync(path.dirname(targetPy), { recursive: true });
        fs.writeFileSync(targetPy, 'MOCK_EXE');
        probeReady = true;
        return { stdout: '', stderr: '' };
      }
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.installed, true);
    assert.equal(okRes.method, 'python_embed_zip');
    assert.equal(downloadCalls.length, 1);
    assert.match(downloadCalls[0].url, /python-3\.12\.8-embed-amd64\.zip/);
    assert.ok(execCalls.length >= 1);

    // 2. 已就绪时直接返回 already_installed，不重复下载
    const alreadyRes = await rehydrate.installPythonRuntimeAsync({
      cliDir,
      homeDir: env.root,
      stateDir: env.stateDir,
      platform: 'win32',
      arch: 'x64',
      _probePython: async () => ({ ok: true, executable: path.join(cliDir, 'runtimes', 'python', 'python.exe'), version: '3.12.8' }),
      _downloadFile: async () => { throw new Error('should not download when ready'); }
    });
    assert.equal(alreadyRes.ok, true);
    assert.equal(alreadyRes.alreadyInstalled, true);

    // 3. UI 渲染层：pythonReady=false 显示一键安装按钮，点击触发 installRehydratePython 后隐藏按钮
    const h = createRendererHarness();
    try {
      let mockStatus = {
        supported: true,
        status: 'not_installed',
        hookRegistered: false,
        hookEnabled: false,
        scriptInstalled: false,
        scriptMatchesBundled: false,
        hooksFileValid: true,
        hooksJsonPath: path.join(cliDir, 'hooks.json'),
        deployedScriptPath: path.join(cliDir, 'hooks', 'rehydrate_after_compact.py'),
        otherHookNames: [],
        pythonReady: false,
        pythonVersion: null
      };
      let installClicks = 0;
      h.sandbox.window.contextMeterAPI = {
        ...h.sandbox.window.contextMeterAPI,
        getEnhanceStatus: async () => ({ ok: true, data: { supported: true, summary: { promptTier: 0, chineseTitleMode: 'en' } } }),
        getModulesStatus: async () => ({ ok: true, data: { modules: { chinese: { enabled: false }, proxy: { enabled: false } } }, disk: {} }),
        getRehydrateStatus: async () => ({ ok: true, data: mockStatus }),
        installRehydratePython: async () => {
          installClicks++;
          mockStatus = { ...mockStatus, pythonReady: true, pythonVersion: '3.12.8' };
          return { ok: true, installed: true, method: 'embed_zip', pythonVersion: '3.12.8', status: mockStatus };
        }
      };

      h.elements.get('btn-ctx-settings').click();
      await h.flush();
      const installBtn = h.elements.get('btn-rehydrate-install-python');
      assert.equal(installBtn.hidden, false, '缺少 Python 时应展示一键安装按钮');
      assert.equal(h.elements.get('btn-rehydrate-enable').disabled, true, '缺少 Python 时应禁用启用按钮');

      installBtn.click();
      await h.flush();
      assert.equal(installClicks, 1);
      assert.equal(installBtn.hidden, true, '安装成功并刷新状态后应隐藏一键安装按钮');
      assert.equal(h.elements.get('btn-rehydrate-enable').disabled, false);
    } finally {
      try { h.api.dispose(); } catch {}
    }
  } finally {
    env.cleanup();
  }
});
