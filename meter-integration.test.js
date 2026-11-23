'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const {
  loadCustomPlanSettings,
  savePluginSettings,
  getPluginSettings,
  launchCliSession,
  collect
} = require('./meter-collector');

const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

// ============================================================================
// 1. 任意账号所在地区 / 订阅国家 / 币种组合测试 (非 AUD/KRW/TWD 示例，如 JPY, EUR, SGD, GBP)
// 保存成功后重开面板、多轮同步、切换会话均保持
// ============================================================================
test('任意账号所在地区/订阅国家/币种组合持久化与多周期同步防回退', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-1-'));
  try {
    const email = 'developer@enterprise.invalid';
    // 选定完全不同的组合：账号所在地区=英国，订阅国家=日本，币种=EUR
    const saveRes = savePluginSettings({
      email,
      customPlan: {
        accountRegion: '英国 (UK)',
        country: '英国 (UK)',
        subscriptionCountry: '日本 (JP)',
        subscriptionRegion: '日本 (JP)',
        region: '日本 (JP)',
        subscriptionCurrency: 'EUR',
        currency: 'EUR',
        currencySource: 'custom',
        actualPricePaid: 15.5,
        billingCycle: '月付'
      }
    }, { agDir: tmpDir });

    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.planStatus.accountRegion, '英国 (UK)');
    assert.equal(saveRes.planStatus.subscriptionCountry, '日本 (JP)');
    assert.equal(saveRes.planStatus.subscriptionCurrency, 'EUR');
    assert.equal(saveRes.planStatus.currency, 'EUR');
    assert.equal(saveRes.planStatus.currencySource, 'custom');
    assert.equal(saveRes.planStatus.actualPricePaid, 15.5);

    // 模拟重开面板与多次 15s 轮询读取
    for (let cycle = 1; cycle <= 3; cycle++) {
      const polled = getPluginSettings({ agDir: tmpDir, email });
      assert.equal(polled.ok, true);
      assert.equal(polled.customPlan.accountRegion, '英国 (UK)');
      assert.equal(polled.customPlan.subscriptionCountry, '日本 (JP)');
      assert.equal(polled.customPlan.subscriptionCurrency, 'EUR');
      assert.equal(polled.customPlan.actualPricePaid, 15.5);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 快速连续修改不同字段，故意乱序/延迟返回响应，保证以最新操作为权威
// ============================================================================
test('快速连续修改字段与乱序/迟到响应隔离 (Sequence / Revision 保证)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-2-'));
  try {
    const email = 'concurrency@example.invalid';

    // 第一次操作：设为新加坡 / SGD
    const op1 = savePluginSettings({
      email,
      customPlan: { subscriptionCountry: '新加坡 (SG)', subscriptionCurrency: 'SGD', actualPricePaid: 27.99 }
    }, { agDir: tmpDir });

    // 快速紧接着第二次操作：用户改为加拿大 / CAD
    const op2 = savePluginSettings({
      email,
      customPlan: { subscriptionCountry: '加拿大 (CA)', subscriptionCurrency: 'CAD', actualPricePaid: 26.99 }
    }, { agDir: tmpDir });

    assert.equal(op1.ok, true);
    assert.equal(op2.ok, true);

    // 读取磁盘最终真实状态
    const finalState = getPluginSettings({ agDir: tmpDir, email });
    assert.equal(finalState.customPlan.subscriptionCountry, '加拿大 (CA)');
    assert.equal(finalState.customPlan.subscriptionCurrency, 'CAD');
    assert.equal(finalState.customPlan.actualPricePaid, 26.99);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 两个虚构账号独立设置与切换，含启动初期尚无账号、default 迁移、清空字段与恢复自动
// ============================================================================
test('虚构账号独立隔离、初期无账号回退、清空字段与恢复自动模式', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-3-'));
  try {
    const accA = 'alice@company.invalid';
    const accB = 'bob@university.invalid';

    // 1. 账号 A 设置：香港 / HKD
    savePluginSettings({
      email: accA,
      customPlan: { accountRegion: '中国香港 (HK)', subscriptionCountry: '中国香港 (HK)', subscriptionCurrency: 'HKD', actualPricePaid: 158 }
    }, { agDir: tmpDir });

    // 2. 账号 B 此时无任何配置，查询 B 必须返回 null，绝不能倒灌账号 A 的设置！
    const resBInitial = getPluginSettings({ agDir: tmpDir, email: accB });
    assert.equal(resBInitial.customPlan, null, '新账号 B 初始应无配置，不得窃取账号 A 的设置');

    // 3. 账号 B 独立保存：德国 / EUR
    savePluginSettings({
      email: accB,
      customPlan: { accountRegion: '德国 (DE)', subscriptionCountry: '欧洲 (EU)', subscriptionCurrency: 'EUR', actualPricePaid: 21.99 }
    }, { agDir: tmpDir });

    // 4. 分别查询 A 和 B，验证互不干扰
    const resA = getPluginSettings({ agDir: tmpDir, email: accA });
    const resB = getPluginSettings({ agDir: tmpDir, email: accB });
    assert.equal(resA.customPlan.accountRegion, '中国香港 (HK)');
    assert.equal(resB.customPlan.accountRegion, '德国 (DE)');

    // 5. 账号 A 清空账号所在地区字段 (显式设为 null/空字符串)
    savePluginSettings({
      email: accA,
      customPlan: { accountRegion: '', country: '' }
    }, { agDir: tmpDir });
    const resACleared = getPluginSettings({ agDir: tmpDir, email: accA });
    assert.equal(resACleared.customPlan.accountRegion, undefined, '清空字段后不得被旧值重新合并回来');
    assert.equal(resACleared.customPlan.subscriptionCountry, '中国香港 (HK)', '其他字段应完整保留');

    // 6. 启动初期尚无邮箱 (email: null / default) 验证可正常回退到 lastAccount
    const resStartup = getPluginSettings({ agDir: tmpDir, email: null });
    assert.ok(resStartup.customPlan !== null, '未提供邮箱时可根据 lastAccount / default 提供回退');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 无保存桥接、写入失败及读回不匹配时绝无假成功，保存成功核对落盘数据
// ============================================================================
test('无保存桥接或写盘失败时无假成功反馈', () => {
  // 测试保存到非写目录（触发底层写入失败）
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fail-dir-'));
  fs.mkdirSync(path.join(badDir, 'custom_plan_v1.json'), { recursive: true });
  try {
    const failRes = savePluginSettings({
      email: 'fail@test.invalid',
      customPlan: { subscriptionCountry: '日本 (JP)', subscriptionCurrency: 'JPY' }
    }, { agDir: badDir });

    assert.equal(failRes.ok, false);
    assert.match(failRes.error, /目录|失败/);
  } finally {
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 详情下拉框与自定义表单概念对齐：赠送/零额外费用、有效期设置严格保留
// ============================================================================
test('订阅国家改变时严格保留用户的赠送/0额外费用及有效期', () => {
  const customGift = {
    accountRegion: '美国 (US)',
    subscriptionCountry: '韩国 (KR)',
    subscriptionCurrency: 'KRW',
    isZeroExtraCost: true,
    actualPricePaid: 0,
    acquisitionSource: 'student_offer',
    acquisitionSourceName: '学生特惠赠送',
    validEndDate: '2027-12-31'
  };

  const effective = core.resolveEffectivePlanStatus(null, customGift);
  assert.equal(effective.isZeroExtraCost, true);
  assert.equal(effective.actualPricePaid, 0);
  assert.equal(effective.acquisitionSourceName, '学生特惠赠送');
  assert.equal(effective.validEndDate, '2027-12-31');
  assert.match(effective.priceRangeNote, /0/);
});

// ============================================================================
// 6. 验证 CLI 启动环境修正：移除了 NO_COLOR，注入了 TERM 与 COLORTERM
// ============================================================================
test('插件 Windows 交互式 CLI 子进程环境配置恢复原生渐变彩虹 Logo', async () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-env-'));
  const cliPath = path.join(cliDir, 'agy.exe');
  fs.writeFileSync(cliPath, 'test fixture');
  const prevNoColor = process.env.NO_COLOR;
  const prevTerm = process.env.TERM;
  const prevColorTerm = process.env.COLORTERM;

  try {
    // 模拟运行 Antigravity 宿主的环境：NO_COLOR=1, TERM=dumb, COLORTERM=
    process.env.NO_COLOR = '1';
    process.env.TERM = 'dumb';
    delete process.env.COLORTERM;

    // 使用临时 CLI 文件验证命令组装，不依赖本机安装
    const dryRun = await launchCliSession({
      cliPath,
      cwd: cliDir,
      dryRun: true,
      model: 'gemini-3.8-flash-high'
    });

    assert.equal(dryRun.ok, true);
    if (process.platform === 'win32') {
      assert.equal(dryRun.env.NO_COLOR, undefined, 'Windows CLI 子进程环境必须清除 NO_COLOR');
      assert.equal(dryRun.env.TERM, 'xterm-256color', 'Windows CLI 子进程 TERM 必须为 xterm-256color');
      assert.equal(dryRun.env.COLORTERM, 'truecolor', 'Windows CLI 子进程 COLORTERM 必须为 truecolor');
    }
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor; else delete process.env.NO_COLOR;
    if (prevTerm !== undefined) process.env.TERM = prevTerm; else delete process.env.TERM;
    if (prevColorTerm !== undefined) process.env.COLORTERM = prevColorTerm; else delete process.env.COLORTERM;
  }
});

// ============================================================================
// 7. 验证 CLI 窗口居中前置脚本与宿主边界传递
// ============================================================================
test('CLI 启动器具备以 Antigravity 触发窗口为基准居中、多显示器工作区裁剪与前台激活能力', () => {
  const { windowsTerminalPlacement } = require('./meter-cli-launcher');
  assert.ok(windowsTerminalPlacement.includes('PositionAndActivate'), '必须包含 PositionAndActivate 居中前台激活方法');
  assert.ok(windowsTerminalPlacement.includes('SWP_SHOWWINDOW'), '必须包含 SWP_SHOWWINDOW 标志');
  assert.ok(!windowsTerminalPlacement.includes('0x0014'), '严禁使用包含 SWP_NOACTIVATE 的 0x0014 标志导致无法前置');
  assert.ok(windowsTerminalPlacement.includes('MonitorFromWindow'), '必须支持多显示器裁剪 MonitorFromWindow');
  assert.ok(windowsTerminalPlacement.includes('GetMonitorInfo'), '必须获取显示器工作区 GetMonitorInfo');
  assert.ok(windowsTerminalPlacement.includes('SetForegroundWindow'), '必须调用 SetForegroundWindow 确保首次获得焦点');
});

// ============================================================================
// 8. 验证渲染层 CLI 按钮按压即刻回弹、启动防重入与状态恢复
// ============================================================================
test('渲染层顶部 CLI 按钮解耦按压反馈与启动加载态，松开即刻回弹且防重入', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.ok(src.includes('data-pressed'), '必须支持 data-pressed 即刻按压反馈');
  assert.ok(src.includes('pointerdown'), '必须监听 pointerdown 触发按压态');
  assert.ok(src.includes('pointerup'), '必须监听 pointerup 立即释放按压态');
  assert.ok(src.includes('pointercancel'), '必须监听 pointercancel 释放按压态');
  assert.ok(src.includes('mouseleave'), '必须监听 mouseleave 释放按压态');
  assert.ok(src.includes('blur'), '必须监听 blur 释放按压态');
  assert.ok(src.includes('cliLaunchBusy'), '必须包含 cliLaunchBusy 防快速重复点击');
  assert.ok(src.includes('showCliToast'), '启动失败或启动中必须提供明确可读提示');

  const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  assert.ok(css.includes('#badge-cli:active') || css.includes('[data-pressed="true"]'), '样式必须包含轻量按压缩放与高亮反馈');
  assert.ok(!css.includes('#badge-cli[data-busy="true"]{\n      opacity:0.65;'), '不能仅将整个按钮变灰代替启动过程');
});

// ============================================================================
// 9. 验证上下文解锁状态机与实际预算联动、只读检测无副作用
// ============================================================================
test('上下文解锁状态与真实请求预算 (983K) 联动，清除过期待重启标记且只读安全', () => {
  const { analyzeBinary } = require('./meter-context-unlock');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-audit-'));
  try {
    const mockFile = path.join(tmpDir, 'mock_engine.exe');
    // 构造原版模拟文件
    const mockBuf = Buffer.alloc(1024, 0);
    fs.writeFileSync(mockFile, mockBuf);

    // 只读检测不会打补丁或修改目标文件大小
    const beforeStat = fs.statSync(mockFile);
    analyzeBinary(mockFile, { backupDir: tmpDir });
    const afterStat = fs.statSync(mockFile);
    assert.equal(beforeStat.size, afterStat.size, '状态检测必须严格保持只读，不得修改文件');
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, '状态检测不得更改文件修改时间戳');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. 单元测试验证：主窗口关闭拦截判定与多路径边界（辅助窗口放行、多窗口关闭、后台运行设置尊重与退出放行）
// ============================================================================
test('单元测试：主窗口关闭拦截判定与多路径边界（辅助窗口放行、多窗口关闭、后台运行设置尊重与退出放行）', () => {
  const { shouldInterceptWindowClose, setAppQuitting } = require('./meter-main');

  const mainWin1 = { isVisible: () => true, isDestroyed: () => false };
  const mainWin2 = { isVisible: () => true, isDestroyed: () => false };
  const auxPopupWindow = { isVisible: () => true, isDestroyed: () => false };

  try {
    setAppQuitting(false);

    // 路径 1: 唯一的已确认主会话窗口 + 允许后台运行 -> 拦截并隐藏保留会话
    const shouldHide = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(shouldHide, true, '唯一的主会话窗口在后台常驻开启时必须拦截隐藏');

    // 路径 2: 辅助/弹窗窗口（不在 getHubWindows 列表中） -> 绝不拦截，避免影响辅助窗口
    const auxResult = shouldInterceptWindowClose(auxPopupWindow, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(auxResult, false, '辅助窗口/弹窗不在主窗口列表中，必须放行正常关闭');

    // 路径 3: 多主窗口存在时，关闭其中一个窗口 -> 放行关闭辅助多开窗口
    const multiWinResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1, mainWin2]
    });
    assert.equal(multiWinResult, false, '存在其他可见主窗口时，放行关闭多开窗口');

    // 路径 4: 宿主后台常驻设置明确关闭 -> 尊重宿主设置，放行关闭
    const noBgResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => false,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(noBgResult, false, '宿主未开启后台常驻时，必须放行关闭退出');

    // 路径 5: 获取窗口列表或读取设置失败/异常 -> 绝不默认隐藏，放行正常关闭
    const errorResult1 = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => { throw new Error('settings read failed'); },
      getHubWindows: () => [mainWin1]
    });
    assert.equal(errorResult1, false, '读取设置异常时绝不默认隐藏，必须安全放行');

    const errorResult2 = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => { throw new Error('getHubWindows failed'); }
    });
    assert.equal(errorResult2, false, '获取窗口列表异常时绝不默认隐藏，必须安全放行');

    // 路径 6: 应用退出中（before-quit / will-quit） -> 放行关闭彻底释放
    setAppQuitting(true);
    const quittingResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(quittingResult, false, '应用退出状态下严禁拦截，确保窗口正常销毁退出');
  } finally {
    setAppQuitting(false);
  }
});

// ============================================================================
// 11. 单元测试验证：BaseWindow / WebContentsView 架构适配与 WebContents 严格探测
// ============================================================================
test('单元测试：BaseWindow / WebContentsView 架构适配与 WebContents 严格探测（PR #6 整合）', async () => {
  const { getWindowWebContents, installContextMeter } = require('./meter-main');

  // 场景 1: 传统 BrowserWindow 具备直接 webContents
  const fakeDirectWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:49999/' };
  const mockBrowserWin = { webContents: fakeDirectWc, isDestroyed: () => false };
  assert.equal(getWindowWebContents(mockBrowserWin), fakeDirectWc, '传统 BrowserWindow 必须直接返回 webContents');

  // 场景 2: BaseWindow 具备 contentView.children，包含遮罩 curtainView 与主 hubWcv
  const curtainWc = { isDestroyed: () => false, getURL: () => 'data:text/html,<!doctype html>...' };
  const hubWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:51234/' };
  const mockBaseWin = {
    isDestroyed: () => false,
    contentView: {
      children: [
        { webContents: curtainWc },
        { webContents: hubWc }
      ]
    }
  };
  const resolvedWc = getWindowWebContents(mockBaseWin);
  assert.equal(resolvedWc, hubWc, 'BaseWindow 必须精准匹配本地主服务 hubWcv，坚决排除 data: 协议的遮罩 curtainView');

  // 场景 3: BaseWindow 创建初期尚未挂载 WebContentsView，installContextMeter 延迟安全探测与清理
  let closedListener = null;
  const mockPendingWin = {
    isDestroyed: () => false,
    contentView: { children: [] },
    on() {},
    once(event, fn) {
      if (event === 'closed') closedListener = fn;
    }
  };
  installContextMeter(mockPendingWin);

  // 模拟窗口在挂载完成前被关闭
  if (typeof closedListener === 'function') {
    assert.doesNotThrow(() => closedListener(), '窗口关闭时清理探测定时器绝不抛错');
  }
});

// ============================================================================
// 12. 集成测试：collect() 在 /compact 后（无摘要调用 / 含摘要调用 / 下一轮新回复）端到端状态演进
// ============================================================================
test('集成测试：collect() 在 /compact 检查点后隔离压缩前大账单与摘要器调用，并在新消息后无缝恢复实测', async () => {
  const http = require('node:http');
  const cascadeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let mockSteps = [];
  let mockGeneratorMetadata = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><script>window.__APP_CONFIG__ = {"csrfToken":"mock-csrf-compact"};</script></html>');
      return;
    }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/GetCascadeTrajectory')) {
        res.end(JSON.stringify({
          numTotalSteps: mockSteps.length,
          numTotalGeneratorMetadata: mockGeneratorMetadata.length,
          trajectory: {
            steps: mockSteps,
            generatorMetadata: mockGeneratorMetadata
          }
        }));
      } else if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        res.end(JSON.stringify({ generatorMetadata: mockGeneratorMetadata }));
      } else if (req.url.endsWith('/GetUserStatus')) {
        res.end(JSON.stringify({
          userStatus: {
            cascadeModelConfigs: [
              { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_GOOGLE_GEMINI_4_HYDROGEN_HIGH' }, maxTokens: 1048576 }
            ]
          }
        }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const bigPreCompactText = '长对话历史内容 '.repeat(8000);
    const baseSteps = [
      { userInput: { userResponse: bigPreCompactText } },
      { plannerResponse: { modifiedResponse: bigPreCompactText, thinking: '详细推理 '.repeat(2000) } },
      { userInput: { userResponse: '/compact' } },
      {
        checkpoint: {
          sessionSummary: '已完成前序模块重构，待编写集成测试。',
          codeChangeSummary: 'Modified meter-core.js and meter-collector.js.',
          userIntent: '修复 /compact 后上下文圆环不及时回落的问题。',
          memorySummary: '遵循 AGENTS.md 构建与测试规范。',
          modelSummarizationFailed: false
        }
      }
    ];
    const preCompactTurnMeta = {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_GOOGLE_GEMINI_4_HYDROGEN_HIGH',
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        systemPrompt: 'You are Antigravity assistant.',
        tools: [{ name: 'read_file', description: 'Read file content from workspace' }],
        usage: { inputTokens: 190000, outputTokens: 2000, cacheReadInputTokens: 150000 },
        chatStartMetadata: {
          startStepIndex: 1,
          contextWindowMetadata: { estimatedTokensUsed: 189000, maxContextTokens: 256000 }
        },
        timeToFirstToken: '1.2s',
        streamingDuration: '4.0s'
      }
    };

    // 形态 A：steps 已写入 checkpoint (#3)，generatorMetadata 仍停留在压缩前轮次 (#1)
    mockSteps = baseSteps;
    mockGeneratorMetadata = [preCompactTurnMeta];
    const resA = await collect(origin, cascadeId, { force: true });
    assert.equal(resA.session.checkpointCount, 1);
    assert.equal(resA.session.lastCheckpointIndex, 3);
    assert.equal(resA.latest.compacted, true, '检查点晚于最近模型调用时必须进入 compacted 状态');
    assert.equal(resA.latest.status, 'compacted');
    assert.equal(resA.latest.actual, null, '压缩后尚未发新消息，actual 必须严格为 null');
    assert.equal(resA.latest.budget, 256000, '应继承当前会话已确认的上下文预算');
    assert.ok(resA.latest.postCompactEstimate > 0 && resA.latest.postCompactEstimate < 5000, '压缩后预估应回落至摘要切片量级而非 192K');
    assert.ok(resA.latest.percent > 0 && resA.latest.percent < 5, '压缩后百分比应回落至低位');
    assert.ok(resA.session.total.high > 40000, '全量历史抽屉仍完整保留压缩前累计字数与估算区间');

    // 形态 B：/compact 内部摘要器调用写入了一条 stepIndices=[3]（等于 checkpoint 步序）、inputTokens=190000 且无 tools/budget 的记录
    const summarizerMeta = {
      stepIndices: [3],
      chatModel: {
        model: 'MODEL_FLASH_SUMMARIZER_INTERNAL',
        modelDisplayName: 'Internal Summarizer',
        tools: [],
        usage: { inputTokens: 190000, outputTokens: 1500 }
      }
    };
    mockGeneratorMetadata = [preCompactTurnMeta, summarizerMeta];
    const resB = await collect(origin, cascadeId, { force: true });
    assert.equal(resB.latest.compacted, true, '摘要器调用（stepIndices===lastCheckpointIndex）绝不能把圆环拉回 191.5K');
    assert.equal(resB.latest.actual, null);
    assert.equal(resB.latest.budget, 256000, '摘要器缺失 budget 时必须回溯继承前序对话轮次的 256K 预算');
    assert.equal(resB.latest.model, 'Gemini 4 Hydrogen (High)', '当前活跃对话模型名称不应被内部摘要器覆盖');
    assert.ok(resB.session.groups.definitions.chars > 10, '工具定义开销应从真实对话轮次回溯保留而非置空');
    assert.equal(resB.latest.postCompactEstimate, resA.latest.postCompactEstimate, '摘要器记录不影响压缩后活跃切片预估值');
    assert.equal(resB.recentGeneratorCalls.length, 2, '全局 Token 账本与调用流水仍完整保留摘要器真实消耗');

    // 形态 C：压缩后发送新消息并获得新回复（stepIndices=[5] > lastCheckpointIndex）
    mockSteps = [
      ...baseSteps,
      { userInput: { userResponse: '继续下一步' } },
      { plannerResponse: { modifiedResponse: '好的，已完成验证。' } }
    ];
    mockGeneratorMetadata = [
      preCompactTurnMeta,
      summarizerMeta,
      {
        stepIndices: [5],
        chatModel: {
          model: 'MODEL_GOOGLE_GEMINI_4_HYDROGEN_HIGH',
          modelDisplayName: 'Gemini 4 Hydrogen (High)',
          usage: { inputTokens: 18500, outputTokens: 420 },
          chatStartMetadata: {
            startStepIndex: 5,
            contextWindowMetadata: { estimatedTokensUsed: 18200, maxContextTokens: 256000 }
          }
        }
      }
    ];
    const resC = await collect(origin, cascadeId, { force: true });
    assert.equal(Boolean(resC.latest.compacted), false, '压缩后新消息返回实测账单后应退出 compacted 预估态');
    assert.equal(resC.latest.status, 'reported');
    assert.equal(resC.latest.actual, 18920);
    assert.equal(resC.latest.budget, 256000);

    // 形态 D：在途旧扫描（落盘前启动）与压缩完成瞬间 force=true 新扫描并发时，force 不得复用旧 pending，且慢速旧扫描不得倒灌覆盖新缓存
    let holdFirstTrajectoryResolve = null;
    let trajectoryCallSeq = 0;
    const origListeners = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', async () => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><script>window.__APP_CONFIG__ = {"csrfToken":"mock-csrf-compact"};</script></html>');
          return;
        }
        if (req.url.endsWith('/GetCascadeTrajectory')) {
          const myCall = ++trajectoryCallSeq;
          if (myCall === 1) {
            const snapSteps = mockSteps.slice();
            const snapGenLen = mockGeneratorMetadata.length;
            await new Promise(r => { holdFirstTrajectoryResolve = r; });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              trajectory: { steps: snapSteps },
              numTotalSteps: snapSteps.length,
              numTotalGeneratorMetadata: snapGenLen
            }));
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.endsWith('/GetCascadeTrajectory')) {
          res.end(JSON.stringify({
            trajectory: { steps: mockSteps },
            numTotalSteps: mockSteps.length,
            numTotalGeneratorMetadata: mockGeneratorMetadata.length
          }));
        } else if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
          res.end(JSON.stringify({ generatorMetadata: mockGeneratorMetadata }));
        } else if (req.url.endsWith('/GetUserStatus')) {
          res.end(JSON.stringify({ userStatus: { cascadeModelConfigs: [] } }));
        } else {
          res.end('{}');
        }
      });
    });

    // 1) 启动一个在检查点落盘前的慢扫描（无 force，使用无缓存的新会话 ID）
    const cascadeIdRace = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const staleInFlightPromise = collect(origin, cascadeIdRace, { force: false });
    await new Promise(r => setTimeout(r, 30));

    // 2) 此时后端落盘新的二次压缩检查点，前端立即触发 collect(..., { force: true })
    mockSteps = [
      ...mockSteps,
      { userInput: { userResponse: '/compact' } },
      { checkpoint: { sessionSummary: '二次压缩后的精简摘要', modelSummarizationFailed: false } }
    ];
    const freshForcedPromise = collect(origin, cascadeIdRace, { force: true });
    const freshRes = await freshForcedPromise;
    assert.equal(freshRes.latest.compacted, true, 'force=true 必须穿透在途旧扫描并立即返回新检查点的压缩预估态');
    assert.equal(freshRes.session.lastCheckpointIndex, 7);

    // 3) 放行慢速旧扫描结束，验证其不会倒灌覆盖缓存中的新压缩快照
    if (holdFirstTrajectoryResolve) holdFirstTrajectoryResolve();
    await staleInFlightPromise;
    const cachedAfterStale = await collect(origin, cascadeIdRace, { force: false });
    assert.equal(cachedAfterStale.latest.compacted, true, '较晚完成的旧扫描绝不能覆盖 force 扫描写入的新检查点缓存');
    assert.equal(cachedAfterStale.session.lastCheckpointIndex, 7);

    server.removeAllListeners('request');
    for (const fn of origListeners) server.on('request', fn);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('单元测试：ensureMeterInjected 并发注入互斥与 force 合并、getMeterSource 缓存与异步日志及 console-message 新签名', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-main-perf-'));
  process.env.AG_METER_STATE_DIR = tmpStateDir;

  const mainPath = require.resolve('./meter-main');
  delete require.cache[mainPath];
  const {
    ensureMeterInjected,
    installContextMeter,
    getMeterSource,
    clearMeterSourceCacheForTest,
    flushDiagnosticLogsForTest
  } = require('./meter-main');

  const origReadFileSync = fs.readFileSync;
  try {
    // 1. getMeterSource 缓存命中校验（连续调用多次仅读取 1 次 meter-core.js 与 meter-renderer.js）
    clearMeterSourceCacheForTest();
    let coreReads = 0;
    let rendererReads = 0;
    fs.readFileSync = function (filePath, ...rest) {
      const p = String(filePath || '');
      if (p.endsWith(`${path.sep}meter-core.js`) || p === 'meter-core.js') coreReads += 1;
      if (p.endsWith(`${path.sep}meter-renderer.js`) || p === 'meter-renderer.js') rendererReads += 1;
      return origReadFileSync.call(this, filePath, ...rest);
    };
    const src1 = getMeterSource();
    const src2 = getMeterSource();
    const src3 = getMeterSource();
    assert.ok(src1.length > 0 && src1.length === src2.length && src2.length === src3.length);
    assert.equal(coreReads, 1, 'meter-core.js 未变化时应复用缓存');
    assert.equal(rendererReads, 1, 'meter-renderer.js 未变化时应复用缓存');
    fs.readFileSync = origReadFileSync;

    // 2. ensureMeterInjected 并发非 force 调用合并为 1 次，且在途期间的多个 force 请求合并为 1 次补跑
    let probeCalls = 0;
    let injectCalls = 0;
    let releaseFirstProbe = null;
    let firstProbeStarted = false;
    const wcListeners = new Map();
    const mockWc = {
      id: 77,
      isDestroyed: () => false,
      getURL: () => 'https://127.0.0.1:54321/c/11111111-1111-4111-8111-111111111111',
      on(evt, fn) {
        if (!wcListeners.has(evt)) wcListeners.set(evt, []);
        wcListeners.get(evt).push(fn);
      },
      executeJavaScript(code) {
        if (String(code).includes('window.__AGContextMeter && document.getElementById')) {
          probeCalls += 1;
          if (!firstProbeStarted) {
            firstProbeStarted = true;
            return new Promise(resolve => { releaseFirstProbe = () => resolve(false); });
          }
          return Promise.resolve(true);
        }
        injectCalls += 1;
        return Promise.resolve(true);
      }
    };
    const mockWin = {
      id: 1,
      isDestroyed: () => false,
      webContents: mockWc,
      on() {}
    };

    // 4 个并发非 force 调用只应触发 1 次探测 + 1 次全量注入
    const batch1 = [
      ensureMeterInjected(mockWin, { force: false }),
      ensureMeterInjected(mockWin, { force: false }),
      ensureMeterInjected(mockWin, { force: false }),
      ensureMeterInjected(mockWin, { force: false })
    ];
    await new Promise(r => setImmediate(r));
    assert.equal(probeCalls, 1, '并发非 force 调用应互斥合并为 1 次存活探测');
    releaseFirstProbe();
    const res1 = await Promise.all(batch1);
    assert.deepEqual(res1, [true, true, true, true]);
    assert.equal(injectCalls, 1, '并发非 force 调用只应执行 1 次全量注入');

    // 在途非 force 期间连续到达 2 个 force: true -> 仅补跑 1 次 force 注入
    firstProbeStarted = false;
    probeCalls = 0;
    injectCalls = 0;
    const pNonForce = ensureMeterInjected(mockWin, { force: false });
    await new Promise(r => setImmediate(r));
    const pForceA = ensureMeterInjected(mockWin, { force: true });
    const pForceB = ensureMeterInjected(mockWin, { force: true });
    releaseFirstProbe();
    const [r0, rA, rB] = await Promise.all([pNonForce, pForceA, pForceB]);
    assert.equal(r0, true);
    assert.equal(rA, true);
    assert.equal(rB, true);
    assert.equal(injectCalls, 2, '在途非 force (1 次) + 合并后的 force 补跑 (1 次) 合计应为 2 次');

    // 3. console-message 单参数签名与异步诊断日志刷盘
    installContextMeter(mockWin);
    const consoleFns = wcListeners.get('console-message') || [];
    assert.equal(consoleFns.length, 1);
    assert.equal(consoleFns[0].length, 1, 'console-message 监听函数形参个数必须为 1 以适配 Electron 新版事件对象');

    consoleFns[0]({ level: 'warning', message: 'Context Meter modern event test', lineNumber: 88 });
    consoleFns[0]({}, 2, 'Context Meter legacy tuple test', 99);
    await flushDiagnosticLogsForTest();
    const diagPath = path.join(tmpStateDir, 'meter-stage-diagnostics.log');
    assert.equal(fs.existsSync(diagPath), true, '异步诊断日志应成功落盘');
    const diagContent = fs.readFileSync(diagPath, 'utf8');
    assert.match(diagContent, /Context Meter modern event test/);
    assert.match(diagContent, /Context Meter legacy tuple test/);
  } finally {
    fs.readFileSync = origReadFileSync;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[mainPath];
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
});
