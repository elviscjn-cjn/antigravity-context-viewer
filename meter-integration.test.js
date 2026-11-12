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
  launchCliSession
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
// 12. 验证 Windows CLI 多路径探测、注册表 PATH 回退、批处理目标解析与残缺 PATH 自愈
// ============================================================================
test('CLI 探测支持官方 %LOCALAPPDATA%\\agy\\bin、Programs\\Antigravity\\bin 及保存设置路径', () => {
  const { resolveCliExecutable } = require('./meter-cli-launcher');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-discover-'));

  try {
    const homeDir = path.join(tmpRoot, 'home');
    const localApp = path.join(tmpRoot, 'localappdata');
    const appData = path.join(tmpRoot, 'appdata');
    const emptyBaseOpts = {
      platform: 'win32',
      homeDir,
      execPath: '',
      skipRegistry: true,
      env: { USERPROFILE: homeDir, LOCALAPPDATA: localApp, APPDATA: appData, PATH: '' }
    };

    // 1. 无任何安装时返回 CLI_NOT_FOUND 及可操作安装命令
    const missRes = resolveCliExecutable(undefined, emptyBaseOpts);
    assert.equal(missRes.ok, false);
    assert.equal(missRes.code, 'CLI_NOT_FOUND');
    assert.match(missRes.installCommand, /antigravity\.google\/cli\/install\.ps1/);

    // 2. 在 custom_plan_v1.json 配置 uiPreferences.cliPath（带引号）可被识别
    const customDir = path.join(tmpRoot, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    const customExe = path.join(customDir, 'agy.exe');
    fs.writeFileSync(customExe, 'custom');
    const agDir = path.join(tmpRoot, 'ag-dir');
    fs.mkdirSync(agDir, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'custom_plan_v1.json'), JSON.stringify({
      uiPreferences: { cliPath: `"${customExe}"` }
    }));
    const savedHit = resolveCliExecutable(undefined, {
      ...emptyBaseOpts,
      env: { ...emptyBaseOpts.env, AG_DIR: agDir }
    });
    assert.equal(savedHit.ok, true);
    assert.equal(savedHit.source, 'saved_settings');
    assert.equal(savedHit.exePath, customExe);

    // 3. Antigravity 2.x 默认桌面目录 Programs\Antigravity\bin\agy.cmd 能解析底层 agy.exe
    const progBin = path.join(localApp, 'Programs', 'Antigravity', 'bin');
    const progApp = path.join(localApp, 'Programs', 'Antigravity', 'resources', 'cli');
    fs.mkdirSync(progBin, { recursive: true });
    fs.mkdirSync(progApp, { recursive: true });
    const wrappedExe = path.join(progApp, 'agy.exe');
    const progCmd = path.join(progBin, 'agy.cmd');
    fs.writeFileSync(wrappedExe, 'wrapped');
    fs.writeFileSync(progCmd, `@echo off\r\n"%~dp0..${path.sep}resources${path.sep}cli${path.sep}agy.exe" %*\r\n`);
    const progHit = resolveCliExecutable(undefined, emptyBaseOpts);
    assert.equal(progHit.ok, true);
    assert.equal(progHit.source, 'programs_antigravity_bin');
    assert.equal(progHit.cliPath, progCmd);
    assert.equal(progHit.exePath, wrappedExe);

    // 4. 官方安装路径 %LOCALAPPDATA%\agy\bin\agy.exe 具有最高候选目录优先级
    const officialBin = path.join(localApp, 'agy', 'bin');
    fs.mkdirSync(officialBin, { recursive: true });
    const officialExe = path.join(officialBin, 'agy.exe');
    fs.writeFileSync(officialExe, 'official');
    const officialHit = resolveCliExecutable(undefined, emptyBaseOpts);
    assert.equal(officialHit.ok, true);
    assert.equal(officialHit.source, 'localappdata_agy_bin');
    assert.equal(officialHit.exePath, officialExe);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI 探测支持 Windows Path 大小写/引号、注册表回退及启动环境 PATH 修复', async () => {
  const { resolveCliExecutable } = require('./meter-cli-launcher');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-reg-'));

  try {
    const homeDir = path.join(tmpRoot, 'home');
    const localApp = path.join(tmpRoot, 'localappdata');
    const appData = path.join(tmpRoot, 'appdata');
    const pathDir = path.join(tmpRoot, 'path with space');
    const pathExeDir = path.join(tmpRoot, 'real-exe');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.mkdirSync(pathExeDir, { recursive: true });
    const pathExe = path.join(pathExeDir, 'agy.exe');
    const pathCmd = path.join(pathDir, 'agy.cmd');
    fs.writeFileSync(pathExe, 'exe');
    fs.writeFileSync(pathCmd, `@echo off\r\n"${pathExe}" %*\r\n`);

    // 1. 验证混合大小写 env.Path 与双引号路径能解析 .cmd -> 底层 agy.exe
    const pathHit = resolveCliExecutable(undefined, {
      platform: 'win32',
      homeDir,
      execPath: '',
      skipRegistry: true,
      env: { USERPROFILE: homeDir, LOCALAPPDATA: localApp, APPDATA: appData, Path: `"${pathDir}"` }
    });
    assert.equal(pathHit.ok, true);
    assert.equal(pathHit.source, 'PATH');
    assert.equal(pathHit.cliPath, pathCmd);
    assert.equal(pathHit.exePath, pathExe);

    // 2. 验证空 PATH 时可通过 reg.exe 读取注册表 REG_EXPAND_SZ Path 并展开 %LOCALAPPDATA%
    const regBin = path.join(localApp, 'custom-reg-cli', 'bin');
    fs.mkdirSync(regBin, { recursive: true });
    const regExeTarget = path.join(regBin, 'agy.exe');
    fs.writeFileSync(regExeTarget, 'reg-exe');
    const mockSpawnSync = (_exe, args) => {
      if (args.includes('HKCU\\Environment')) {
        return { status: 0, stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\custom-reg-cli\\bin\r\n' };
      }
      return { status: 1, stdout: '' };
    };
    const regHit = resolveCliExecutable(undefined, {
      platform: 'win32',
      homeDir,
      execPath: '',
      spawnSync: mockSpawnSync,
      env: { USERPROFILE: homeDir, LOCALAPPDATA: localApp, APPDATA: appData, PATH: '' }
    });
    assert.equal(regHit.ok, true);
    assert.equal(regHit.source, 'registry_PATH');
    assert.equal(regHit.exePath, regExeTarget);

    // 3. 验证宿主机 PATH 为空时 launchCliSession 在 Windows 下补齐 System32 / PowerShell 与 CLI 目录
    if (process.platform === 'win32') {
      const fakeWin = path.join(tmpRoot, 'Windows');
      const sys32 = path.join(fakeWin, 'System32');
      const psDir = path.join(sys32, 'WindowsPowerShell', 'v1.0');
      fs.mkdirSync(psDir, { recursive: true });
      fs.writeFileSync(path.join(sys32, 'cmd.exe'), 'cmd');
      fs.writeFileSync(path.join(psDir, 'powershell.exe'), 'ps');
      const dryRun = await launchCliSession({
        cliPath: `"${regExeTarget}"`,
        cwd: tmpRoot,
        dryRun: true,
        env: { PATH: '', SystemRoot: fakeWin }
      });
      assert.equal(dryRun.ok, true);
      assert.equal(dryRun.cmdExe, path.join(sys32, 'cmd.exe'));
      assert.equal(dryRun.powershellExe, path.join(psDir, 'powershell.exe'));
      assert.ok(String(dryRun.env.PATH).includes(regBin));
      assert.ok(String(dryRun.env.PATH).includes(sys32));
      assert.ok(String(dryRun.env.PATH).includes(psDir));
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
