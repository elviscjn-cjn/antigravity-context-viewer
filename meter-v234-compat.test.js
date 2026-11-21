'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const { builtinAsar } = require('./asar-engine');
const {
  TAGS,
  findWindowLoadHookTarget,
  injectWindowLoadHook,
  verifyCleanStructure,
  cleanUtilsSource
} = require('./modular-installer');
const { install } = require('./install');
const { restore } = require('./restore');
const {
  registerMeterIpcHandlers,
  resolveHubWindowWebContents,
  createHubWindowLocalApi
} = require('./meter-main');
const { fetchUserStatusFromHost } = require('./meter-collector');
const { resolveCliWorkspace } = require('./meter-cli-launcher');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function createMockAsar(dir, version, utilsContent) {
  const rand = Math.random().toString(36).slice(2, 8);
  const src = path.join(dir, `mock-src-${version}-${rand}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsContent, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n', 'utf8');
  const asarPath = path.join(dir, `app-${version}-${rand}.asar`);
  await builtinAsar.createPackageWithOptions(src, asarPath, {});
  fs.rmSync(src, { recursive: true, force: true });
  return asarPath;
}

const UTILS_234 = `"use strict";
async function loadHubWindowUrl(win, url, options) {
    if (!options || !options.skipBootstrapMint) {
        // host login bootstrap mint
    }
    await win.loadURL(url);
}
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    const skipBootstrapMint = Boolean(options && options.skipBootstrapMint);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;

const UTILS_234_WITH_INTERNAL_VOID_LOAD = `"use strict";
function loadHubWindowUrl(win, url, options) {
    if (options && options.skipBootstrapMint) {
        void win.loadURL(url);
        return;
    }
    void win.loadURL(url + '?boot=1');
}
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    const skipBootstrapMint = false;
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;

const UTILS_LEGACY = `"use strict";
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
    return win;
}
`;

test('Antigravity 2.34.0 结构校验与注入匹配：兼容新旧窗口加载写法且严格唯一命中', () => {
  const target234 = findWindowLoadHookTarget(UTILS_234);
  assert.ok(target234, '应命中 2.34.0 loadHubWindowUrl 写法');
  assert.equal(target234.kind, 'loadHubWindowUrl');
  assert.equal(verifyCleanStructure(UTILS_234), true);

  // loadHubWindowUrl 内部即使带有 void win.loadURL(url)，也应唯一命中 createWindow 中的 loadHubWindowUrl 调用
  const target234Internal = findWindowLoadHookTarget(UTILS_234_WITH_INTERNAL_VOID_LOAD);
  assert.ok(target234Internal, 'loadHubWindowUrl 内部存在 void win.loadURL(url) 时仍应唯一命中 loadHubWindowUrl');
  assert.equal(target234Internal.kind, 'loadHubWindowUrl');
  assert.equal(verifyCleanStructure(UTILS_234_WITH_INTERNAL_VOID_LOAD), true);

  // 旧版 void win.loadURL(url); 保持兼容
  const targetLegacy = findWindowLoadHookTarget(UTILS_LEGACY);
  assert.ok(targetLegacy, '应继续兼容旧版 void win.loadURL(url);');
  assert.equal(targetLegacy.kind, 'win.loadURL');
  assert.equal(verifyCleanStructure(UTILS_LEGACY), true);

  // 多行参数及无 void 写法也应支持
  const multiline234 = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    loadHubWindowUrl(win, url, {
        skipBootstrapMint: true,
    });
}
`;
  assert.equal(verifyCleanStructure(multiline234), true);

  // 重复命中（非唯一）必须拒绝
  const duplicate234 = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    void loadHubWindowUrl(win, url, { skipBootstrapMint: true });
}
`;
  assert.equal(findWindowLoadHookTarget(duplicate234), null, '存在多个 loadHubWindowUrl 调用时不得盲目注入');
  assert.equal(verifyCleanStructure(duplicate234), false);

  const duplicateLegacy = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
    void win.loadURL(url);
}
`;
  assert.equal(findWindowLoadHookTarget(duplicateLegacy), null, '存在多个 void win.loadURL(url) 时不得盲目注入');
  assert.equal(verifyCleanStructure(duplicateLegacy), false);

  // 注入钩子必须位于 loadHubWindowUrl 之前且不篡改宿主登录引导调用
  const hook = `${TAGS.METER_UTILS_START}\n    require("./meter-main").installContextMeter(win);\n${TAGS.METER_UTILS_END}\n`;
  const injected = injectWindowLoadHook(UTILS_234, hook);
  assert.ok(injected);
  const hookIdx = injected.indexOf('installContextMeter(win)');
  const loadIdx = injected.indexOf('void loadHubWindowUrl(win, url, { skipBootstrapMint });');
  assert.ok(hookIdx > 0 && loadIdx > hookIdx, '插件注入应位于宿主 loadHubWindowUrl 之前');
  assert.equal(verifyCleanStructure(cleanUtilsSource(injected)), true, '原位清洗后应恢复为合法纯净结构');
});

test('Antigravity 2.34.0 ASAR 完整生命周期：安装、重装、原位还原与备份还原均正常', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-234-lifecycle-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevTestMode = process.env.AG_METER_TEST_MODE;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  process.env.AG_METER_TEST_MODE = '1';

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const clean234 = await createMockAsar(tmpDir, '2.34.0', UTILS_234);
    fs.copyFileSync(clean234, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 1. 首次安装到 2.34.0
    const m1 = await install({ path: targetAsar });
    assert.equal(m1.version, '2.34.0');
    const patchedUtils1 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.equal(patchedUtils1.split('installContextMeter(win)').length, 2, '应恰好注入一次 installContextMeter(win)');
    assert.ok(
      patchedUtils1.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'),
      '宿主登录引导调用 loadHubWindowUrl 必须完整保留'
    );

    // 2. 重装到已打补丁的 2.34.0
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.version, '2.34.0');
    const patchedUtils2 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.equal(patchedUtils2.split('installContextMeter(win)').length, 2, '重装后不得重复注入');
    assert.ok(patchedUtils2.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));

    // 3. 原位还原 (--in-place)
    const inPlaceRes = await restore({ path: targetAsar, inPlace: true });
    assert.equal(inPlaceRes.inPlaceCleaned, true);
    const inPlaceUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.equal(inPlaceUtils.includes('installContextMeter'), false, '原位还原后不应残留插件钩子');
    assert.ok(inPlaceUtils.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
    assert.equal(verifyCleanStructure(inPlaceUtils), true);

    // 4. 再次安装后执行标准备份还原，校验逐字节 SHA-256 一致
    await install({ path: targetAsar });
    const restoreRes = await restore({ path: targetAsar });
    assert.equal(restoreRes.restored, targetAsar);
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '标准备份还原应逐字节恢复原版 2.34.0 ASAR');

    // 5. 模拟从旧版 2.33.0 升级到 2.34.0 后重新安装
    const clean233 = await createMockAsar(tmpDir, '2.33.0', UTILS_LEGACY);
    fs.copyFileSync(clean233, targetAsar);
    const mLegacy = await install({ path: targetAsar });
    assert.equal(mLegacy.version, '2.33.0');

    fs.copyFileSync(clean234, targetAsar);
    const mUpgrade = await install({ path: targetAsar });
    assert.equal(mUpgrade.version, '2.34.0', '宿主升级至 2.34.0 后重装应基于新版 2.34.0');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    if (prevTestMode !== undefined) process.env.AG_METER_TEST_MODE = prevTestMode;
    else delete process.env.AG_METER_TEST_MODE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Antigravity 2.34.0 模拟鉴权测试：初始页无 csrfToken 且直连返回 401 时，额度和当前账号通过 Hub 主窗口同源会话正常查询', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-234-auth-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevTestMode = process.env.AG_METER_TEST_MODE;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  process.env.AG_METER_TEST_MODE = '1';

  const origin = 'https://127.0.0.1:54234';
  const SESSION_COOKIE = 'ag_hub_session=valid-session-234';
  const requestLog = [];

  // 模拟 Antigravity 2.34.0 本地鉴权服务端：
  // - 初始页 HTML 无可用 csrfToken；
  // - 业务 RPC 校验已登录 Hub 窗口的会话 Cookie，缺失时一律返回 401。
  function handleSimulatedHostRequest({ method, pathName, headers = {} }) {
    const cookie = headers.Cookie || headers.cookie || '';
    const csrf = headers['x-codeium-csrf-token'] || '';
    requestLog.push({ method, url: pathName, cookie, csrf });

    if (cookie !== SESSION_COOKIE) {
      return {
        status: 401,
        body: JSON.stringify({ code: 'unauthenticated', message: 'missing hub session cookie' })
      };
    }

    if (pathName === '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
      return {
        status: 200,
        body: JSON.stringify({
          userStatus: {
            email: 'alice-234@example.com',
            planStatus: {
              planInfo: {
                planName: 'Pro',
                teamsTier: 'TEAMS_TIER_PRO'
              }
            },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.1 Pro (High)',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
                  quotaInfo: {
                    remainingFraction: 0.75,
                    resetTime: '2026-11-22T00:00:00Z'
                  }
                }
              ]
            }
          }
        })
      };
    }

    if (pathName === '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary') {
      return {
        status: 200,
        body: JSON.stringify({
          response: {
            groups: [
              {
                name: 'Gemini Pro',
                remainingFraction: 0.75,
                resetTime: '2026-11-22T00:00:00Z',
                models: ['MODEL_PLACEHOLDER_M37']
              }
            ]
          }
        })
      };
    }

    if (pathName === '/exa.language_server_pb.LanguageServerService/GetAvailableModels') {
      return {
        status: 200,
        body: JSON.stringify({
          response: {
            models: {
              MODEL_PLACEHOLDER_M37: {
                model: 'MODEL_PLACEHOLDER_M37',
                displayName: 'Gemini 3.1 Pro (High)',
                maxTokens: 1048576,
                maxOutputTokens: 65536
              }
            }
          }
        })
      };
    }

    if (pathName === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory') {
      return {
        status: 200,
        body: JSON.stringify({
          numTotalSteps: 1,
          numTotalGeneratorMetadata: 1,
          trajectory: {
            metadata: {
              workspaces: [
                { workspaceFolderAbsoluteUri: `file:///${tmpDir.replace(/\\/g, '/')}` }
              ]
            },
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                userInput: { items: [{ text: 'hello 2.34.0' }] }
              }
            ],
            generatorMetadata: []
          }
        })
      };
    }

    if (pathName === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      return {
        status: 200,
        body: JSON.stringify({
          generatorMetadata: [
            {
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M37',
                usage: {
                  inputTokens: 1200,
                  outputTokens: 300,
                  cacheReadTokens: 400
                }
              }
            }
          ]
        })
      };
    }

    return { status: 404, body: 'not found' };
  }

  // 构造模拟已登录的 Hub 主窗口 WebContents：页面无 csrfToken，但同源 fetch 自动沿用窗口会话 Cookie
  const makeHubWebContents = ({ pageOrigin, cookieHeader, csrfToken = '' }) => ({
    isDestroyed: () => false,
    getURL: () => `${pageOrigin}/c/11111111-1111-1111-1111-111111111111`,
    executeJavaScript: async (script) => {
      const sameOriginFetch = async (reqPath, init = {}) => {
        assert.equal(init.credentials, 'same-origin', 'Hub 主窗口请求必须携带 credentials: same-origin');
        assert.ok(String(reqPath).startsWith('/exa.language_server_pb.LanguageServerService/'), '必须发起同源相对路径请求');
        const headers = { ...(init.headers || {}) };
        if (cookieHeader) headers.Cookie = cookieHeader;
        const sim = handleSimulatedHostRequest({
          method: init.method || 'GET',
          pathName: String(reqPath),
          headers
        });
        return {
          ok: sim.status >= 200 && sim.status < 300,
          status: sim.status,
          text: async () => sim.body
        };
      };
      const sandbox = {
        window: {
          location: { origin: pageOrigin },
          __APP_CONFIG__: csrfToken ? { csrfToken } : {}
        },
        fetch: sameOriginFetch,
        AbortController,
        setTimeout,
        clearTimeout,
        JSON
      };
      return vm.runInNewContext(script, sandbox);
    }
  });

  try {
    // 1. 注册 IPC 处理器并通过已登录 Hub 主窗口调用 get-quota 与 accounts-overview
    const handlers = {};
    registerMeterIpcHandlers({
      handle: (ch, fn) => { handlers[ch] = fn; },
      on: () => {}
    });

    const loggedInWc = makeHubWebContents({ pageOrigin: origin, cookieHeader: SESSION_COOKIE });
    const loggedInEvent = {
      sender: loggedInWc,
      senderFrame: { url: loggedInWc.getURL() }
    };

    const quotaRes = await handlers['context-meter:get-quota'](loggedInEvent, { force: true });
    assert.equal(quotaRes.ok, true, '额度 IPC 查询应成功');
    assert.equal(quotaRes.data?.ok, true, '额度快照状态应为 ok');
    assert.equal(quotaRes.data?.error || null, null, '额度结果不应包含鉴权错误');
    assert.equal(quotaRes.data?.planTierSummary?.planName, 'Pro', '应通过同源会话解析到订阅方案信息');
    assert.notEqual(quotaRes.data?.accountScopeKey, 'anonymous', '应通过同源会话关联到登录账号作用域');
    assert.ok(quotaRes.data?.snapshot, '应返回有效额度快照');

    const overviewRes = await handlers['context-meter:accounts-overview'](loggedInEvent);
    assert.equal(overviewRes?.activeAccountEmail, 'alice-234@example.com', '账号概览应识别到当前登录账号');

    // 验证实际发出的 RPC 请求确实走的是同源会话（带 Cookie 且页面无 csrfToken 时不发空 header）
    const rpcReqs = requestLog.filter(r => r.url.startsWith('/exa.language_server_pb.LanguageServerService/'));
    assert.ok(rpcReqs.some(r => r.url.endsWith('/GetUserStatus') && r.cookie === SESSION_COOKIE && r.csrf === ''));
    assert.ok(rpcReqs.some(r => r.url.endsWith('/RetrieveUserQuotaSummary') && r.cookie === SESSION_COOKIE && r.csrf === ''));

    // 2. 当 Hub 窗口会话未登录（服务端返回 401）且旧版 HTML 也没有 csrfToken 时，应准确归类为 auth 错误
    const unauthWc = makeHubWebContents({ pageOrigin: origin, cookieHeader: '' });
    const unauthEvent = {
      sender: unauthWc,
      senderFrame: { url: unauthWc.getURL() }
    };
    const unauthApi = createHubWindowLocalApi({
      origin,
      sender: unauthWc,
      fallbackConnect: async () => {
        throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
      }
    });
    const unauthQuota = await handlers['context-meter:get-quota'](unauthEvent, {
      force: true,
      connect: unauthApi.connect
    });
    assert.equal(unauthQuota.ok, true);
    assert.equal(unauthQuota.data?.errorKind, 'auth', '窗口会话失效返回 401 时应准确归类为 auth 错误');

    // 3. 兼容旧版：若 Hub 窗口存在 window.__APP_CONFIG__.csrfToken，则同源请求同时附带 x-codeium-csrf-token
    const legacyWc = makeHubWebContents({ pageOrigin: origin, cookieHeader: SESSION_COOKIE, csrfToken: 'legacy-csrf-123' });
    const legacyApi = createHubWindowLocalApi({ origin, sender: legacyWc, allowLegacyFallback: false });
    const legacyConn = await legacyApi.connect({ origin });
    await legacyConn.call('GetUserStatus', {});
    assert.ok(
      requestLog.some(r => r.url.endsWith('/GetUserStatus') && r.csrf === 'legacy-csrf-123' && r.cookie === SESSION_COOKIE),
      '存在 csrfToken 时应一并携带以兼容旧版本'
    );

    // 4. 多窗口 origin 隔离：originB 的窗口不得被用于查询 originA
    const otherWc = makeHubWebContents({ pageOrigin: 'https://127.0.0.1:65432', cookieHeader: SESSION_COOKIE });
    const isolated = resolveHubWindowWebContents(origin, {
      sender: otherWc,
      getHubWindows: () => [{ webContents: otherWc, isDestroyed: () => false }]
    });
    assert.equal(isolated, null, '不同 origin 的窗口不得跨原点复用');

    // 5. createHubWindowLocalApi 直接验证 GetUserStatus & RetrieveUserQuotaSummary
    const hubApi = createHubWindowLocalApi({ origin, sender: loggedInWc, allowLegacyFallback: false });
    const conn = await hubApi.connect({ origin });
    assert.equal(conn.transport, 'hub-window-same-origin');
    const statusPayload = await conn.call('GetUserStatus', {});
    assert.equal(statusPayload?.userStatus?.email, 'alice-234@example.com');
    const quotaPayload = await conn.call('RetrieveUserQuotaSummary', {});
    assert.equal(quotaPayload?.response?.groups?.[0]?.name, 'Gemini Pro');

    // 6. 对话扫描 context-meter:scan 也必须走 Hub 窗口同源会话（不因初始页缺 csrfToken 返回 401）
    const scanRes = await handlers['context-meter:scan'](
      loggedInEvent,
      '11111111-1111-1111-1111-111111111111',
      true
    );
    assert.equal(scanRes.ok, true, 'context-meter:scan 应通过 Hub 主窗口同源会话成功完成');
    assert.equal(scanRes.data?.conversation, '11111111-1111-1111-1111-111111111111');
    assert.ok(requestLog.some(r => r.url.endsWith('/GetCascadeTrajectory') && r.cookie === SESSION_COOKIE));
    assert.ok(requestLog.some(r => r.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata') && r.cookie === SESSION_COOKIE));

    // 7. 历史用量套餐/模型能力查询 fetchUserStatusFromHost 支持同源会话（GetUserStatus + GetAvailableModels）
    const userStatus = await fetchUserStatusFromHost({ origin, force: true, connect: hubApi.connect });
    assert.equal(userStatus?.email, 'alice-234@example.com');
    assert.equal(userStatus?.planName, 'Pro');
    assert.equal(userStatus?.availableModelDetails?.placeholder_m37?.maxTokens, 1048576);
    assert.ok(requestLog.some(r => r.url.endsWith('/GetAvailableModels') && r.cookie === SESSION_COOKIE));

    // 8. CLI 启动器在无本地 transcript 缓存时，通过同源会话 GetCascadeTrajectory 解析会话工作目录
    const cliWs = await resolveCliWorkspace({
      cascadeId: '22222222-2222-2222-2222-222222222222',
      agDir: path.join(tmpDir, 'empty-ag'),
      appDataDir: path.join(tmpDir, 'empty-appdata'),
      configDir: path.join(tmpDir, 'empty-config'),
      origin,
      connect: hubApi.connect
    });
    assert.equal(cliWs.ok, true, 'resolveCliWorkspace 应通过同源会话成功解析工作区目录');
    assert.equal(cliWs.source, 'conversation_trajectory');
    assert.equal(path.resolve(cliWs.cwd), path.resolve(tmpDir));
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    if (prevTestMode !== undefined) process.env.AG_METER_TEST_MODE = prevTestMode;
    else delete process.env.AG_METER_TEST_MODE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
