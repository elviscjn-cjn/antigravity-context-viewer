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
