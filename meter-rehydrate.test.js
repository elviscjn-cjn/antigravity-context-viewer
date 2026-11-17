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
    setTimeout,
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

test('1. Slim-LTS 脚本提取一致性（1,080 行）与 Python 3.10+ 语法及空负载快路径验证', (t) => {
  const docPath = path.join(__dirname, 'rehydrate', 'AGY-rehydrate-slim-lts-release-v2.md');
  const scriptPath = path.join(__dirname, 'rehydrate', 'rehydrate_after_compact.py');
  assert.equal(fs.existsSync(docPath), true);
  assert.equal(fs.existsSync(scriptPath), true);

  const docText = fs.readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n');
  const match = docText.match(/## 附录：完整可部署源码（`rehydrate_after_compact\.py`）\n+```python\n([\s\S]*?)\n```\s*$/);
  assert.ok(match, '发布文档必须包含完整 Python 附录围栏');

  const scriptText = fs.readFileSync(scriptPath, 'utf8');
  assert.equal(scriptText.includes('\r\n'), false, 'Python 脚本应保持 LF 换行');
  assert.equal(scriptText.endsWith('\n'), true);

  const scriptLines = scriptText.slice(0, -1).split('\n');
  assert.equal(scriptLines.length, 1080, 'Slim-LTS 脚本必须为精确 1,080 行');
  assert.equal(scriptText, match[1] + '\n', '独立脚本必须与发布文档附录源码字节完全一致');

  const py = rehydrate.resolvePython310();
  if (!py.ok) {
    t.skip('本机未安装 Python 3.10+，跳过 py_compile 与 stdin 快路径测试');
    return;
  }

  execFileSync(py.executable, ['-m', 'py_compile', scriptPath], { stdio: 'pipe', windowsHide: true });
  const stdout = execFileSync(py.executable, ['-X', 'utf8', scriptPath], {
    input: '{}',
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(stdout.trim(), '{}');
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
  assert.equal(core.isValidExternalUrl('https://agy-rehydrate.pages.dev/rehydrate_after_compact.py'), true);
  assert.equal(core.isValidExternalUrl('https://evil.example.com/agy-rehydrate.pages.dev'), false);

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

    // 单独卡片启用 -> 停用 -> 显式卸载移除（应传入 { force: true }）
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

    // 三语言检查，且英文模式绝无中文残留
    const keysToCheck = [
      'enhance.preset.itemRehydrate',
      'rehydrate.card.title',
      'rehydrate.stat.hook',
      'rehydrate.btn.enable',
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
  assert.equal(pkgRelSrc.includes("'rehydrate/AGY-rehydrate-slim-lts-release-v2.md'"), true);
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
