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
  getPluginSettings
} = require('./meter-collector');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function session(unknown = 0) {
  return {
    groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k, core.empty()])),
    total: { chars: 100, low: 10, high: 50 },
    attachmentTotal: core.empty(),
    attachments: [],
    unknownFiles: unknown,
    steps: 10,
    userMessages: 2,
    assistantMessages: 3
  };
}

function harness(scanSession = session()) {
  const elements = new Map();
  const listeners = new Map();
  const element = () => {
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
      children: [], hidden: false, textContent: '', value: '', checked: false, disabled: false,
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element();
  host.attachShadow = () => ({
    set innerHTML(value) {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  });
  const pending = [], scans = [], timers = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: id => new Promise(resolve => scans.push({ id, resolve })),
        getSettings: async (req) => ({ ok: true, customPlan: null }),
        saveSettings: async (req) => ({ ok: true, customPlan: req.customPlan })
      }
    },
    __AGContextMeterCore: core,
    AbortController: global.AbortController,
    Date,
    setTimeout: (cb) => { if (typeof cb === 'function') setTimeout(cb, 0); return 1; },
    clearTimeout: () => {},
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval: () => {},
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); }
  };
  let first = true;
  sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    host,
    pending,
    scans,
    elements,
    tick: () => timers[0](),
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } });
    }
  };
}

function response(chatModel) {
  return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) };
}

// ============================================================================
// 验收测试 1: 参考价模式下连续切换多个订阅国家 (TW -> JP -> KR -> AU -> US) 与修改账号地区隔离
// ============================================================================
test('参考价模式下连续切换多个订阅国家与修改账号地区隔离', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const api = h.sandbox.__AGContextMeter;

  // 初始化基础 payload
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'test_user@enterprise.invalid',
      region: '未知',
      currency: 'USD',
      priceMode: 'preset',
      actualPricePaid: null
    }
  });

  const priceVal = h.elements.get('plan-summary-price-val');
  const priceCny = h.elements.get('plan-summary-price-cny');
  const detPrice = h.elements.get('p-det-price');
  const detPriceTag = h.elements.get('p-det-price-tag');
  const btnModePreset = h.elements.get('btn-mode-preset');
  const btnModeCustom = h.elements.get('btn-mode-custom');

  // 1.1 初始设为中国台湾 (TW: NT$650/月)
  h.elements.get('direct-region-trigger').click();
  let directMenu = h.elements.get('direct-region-menu');
  let listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  let twItem = listContainer.children.find(it => it.textContent.includes('台湾') || it.textContent.includes('TW') || it.children?.some(c => c.textContent.includes('台湾')));
  assert.ok(twItem, 'Taiwan item exists in dropdown');
  twItem.click();
  await h.flush();

  assert.match(priceVal.textContent, /NT\$650/);
  assert.match(priceCny.textContent, /136\.5/);
  assert.match(detPrice.textContent, /NT\$650 · 月付/);
  assert.equal(detPriceTag.textContent, '官方定价');

  // 1.2 连续切换为日本 (JP: ¥2900/月)
  h.elements.get('direct-region-trigger').click();
  directMenu = h.elements.get('direct-region-menu');
  listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  let jpItem = listContainer.children.find(it => it.textContent.includes('日本') || it.children?.some(c => c.textContent.includes('日本')));
  assert.ok(jpItem, 'Japan item exists in dropdown');
  jpItem.click();
  await h.flush();

  assert.match(priceVal.textContent, /¥2900/);
  assert.match(priceCny.textContent, /123\.3/);
  assert.match(detPrice.textContent, /¥2900 · 月付/);
  assert.equal(detPriceTag.textContent, '官方定价');
  assert.equal(api.getPlanSettings().currency, 'JPY');
  assert.equal(api.getPlanSettings().actualPricePaid, 2900);

  // 1.3 连续切换为韩国 (KR: ₩29000/月)
  h.elements.get('direct-region-trigger').click();
  directMenu = h.elements.get('direct-region-menu');
  listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  let krItem = listContainer.children.find(it => it.textContent.includes('韩国') || it.children?.some(c => c.textContent.includes('韩国')));
  assert.ok(krItem, 'Korea item exists in dropdown');
  krItem.click();
  await h.flush();

  assert.match(priceVal.textContent, /₩29000/);
  assert.match(priceCny.textContent, /147\.9/);
  assert.match(detPrice.textContent, /₩29000 · 月付/);
  assert.equal(api.getPlanSettings().currency, 'KRW');
  assert.equal(api.getPlanSettings().actualPricePaid, 29000);

  // 1.4 连续切换为澳大利亚 (AU: AU$32.99/月)
  h.elements.get('direct-region-trigger').click();
  directMenu = h.elements.get('direct-region-menu');
  listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  let auItem = listContainer.children.find(it => it.textContent.includes('澳大利亚') || it.children?.some(c => c.textContent.includes('澳大利亚')));
  assert.ok(auItem, 'Australia item exists in dropdown');
  auItem.click();
  await h.flush();

  assert.match(priceVal.textContent, /AU\$32\.99/);
  assert.match(priceCny.textContent, /146\.8/);
  assert.match(detPrice.textContent, /AU\$32\.99 · 月付/);
  assert.equal(api.getPlanSettings().currency, 'AUD');
  assert.equal(api.getPlanSettings().actualPricePaid, 32.99);

  // 1.5 修改「账号所在地区」为 英国 (UK) -> 严格保持订阅国家 (澳大利亚)、币种 (AUD) 与金额 (32.99) 完全不变！
  api.setCountry('英国 (UK)');
  await h.flush();

  const settingsAfterCountry = api.getPlanSettings();
  assert.equal(settingsAfterCountry.country, '英国 (UK)');
  assert.match(settingsAfterCountry.subscriptionRegion, /澳大利亚/);
  assert.equal(settingsAfterCountry.currency, 'AUD');
  assert.equal(settingsAfterCountry.actualPricePaid, 32.99);
  assert.match(priceVal.textContent, /AU\$32\.99/);
  assert.match(detPrice.textContent, /AU\$32\.99 · 月付/);

  api.dispose();
});

// ============================================================================
// 验收测试 2: 自定义模式（非零金额、0 元、赠送权益、不同周期）与切换国家隔离
// ============================================================================
test('自定义实付模式下非零金额、0 元与不同周期，且切换订阅国家不覆盖实付', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const api = h.sandbox.__AGContextMeter;

  // 初始化基础 payload
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'test_user@enterprise.invalid',
      region: '未知',
      currency: 'USD',
      priceMode: 'preset',
      actualPricePaid: null
    }
  });

  const priceVal = h.elements.get('plan-summary-price-val');
  const priceCny = h.elements.get('plan-summary-price-cny');
  const detPrice = h.elements.get('p-det-price');
  const detPriceTag = h.elements.get('p-det-price-tag');
  const btnModePreset = h.elements.get('btn-mode-preset');
  const btnModeCustom = h.elements.get('btn-mode-custom');

  // 2.1 点击开启「自定义实付」模式，填写实付金额 12.80 USD，周期「月付」
  btnModeCustom.click();
  await h.flush();

  assert.match(btnModeCustom.getAttribute('class') || '', /active/);

  h.elements.get('input-custom-paid').value = '12.80';
  h.elements.get('select-custom-currency').value = 'USD';
  h.elements.get('select-custom-cycle').value = '月付';
  h.elements.get('btn-custom-plan-save').click();
  await h.flush();

  assert.match(priceVal.textContent, /\$12\.80/);
  assert.match(detPrice.textContent, /\$12\.80 · 月付/);
  assert.equal(detPriceTag.textContent, '用户实付');

  // 2.2 在自定义实付模式下，切换订阅国家为日本 (JP) -> 实付金额必须严格保持 12.80 USD，绝不能被日本的 2900 JPY 冲掉！
  h.elements.get('direct-region-trigger').click();
  const directMenu = h.elements.get('direct-region-menu');
  const listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  const jpItem = listContainer.children.find(it => it.textContent.includes('日本') || it.children?.some(c => c.textContent.includes('日本')));
  assert.ok(jpItem, 'Japan item exists');
  jpItem.click();
  await h.flush();

  const settingsAfterJp = api.getPlanSettings();
  assert.match(settingsAfterJp.subscriptionRegion, /日本/);
  assert.equal(settingsAfterJp.currency, 'USD', '实付币种必须保持 USD');
  assert.equal(settingsAfterJp.actualPricePaid, 12.80, '实付金额必须保持 12.80');
  assert.match(priceVal.textContent, /\$12\.80/);
  assert.match(detPrice.textContent, /\$12\.80 · 月付/);
  assert.equal(detPriceTag.textContent, '用户实付');

  // 2.3 测试 0 元与赠送权益（Pixel 赠送活动，0 元必须严格作为合法数值生效，不可与 null 混淆）
  h.elements.get('btn-edit-plan-custom').click();
  h.elements.get('select-custom-acq').value = 'pixel_bundle';
  h.elements.get('select-custom-acq').trigger('change', { target: { value: 'pixel_bundle' } });
  assert.equal(h.elements.get('check-zero-extra').checked, true);
  assert.equal(h.elements.get('input-custom-paid').value, '0');
  h.elements.get('btn-custom-plan-save').click();
  await h.flush();

  const settingsZero = api.getPlanSettings();
  assert.equal(settingsZero.actualPricePaid, 0, '0 元必须作为有效实付金额');
  assert.match(priceVal.textContent, /\$0/);
  assert.match(detPrice.textContent, /\$0 · 免费\/赠送/);
  assert.equal(detPriceTag.textContent, '手动确认 · 免费');

  // 2.4 点击「跟随参考价」切换回参考价模式 -> 立即按日本实时恢复 ¥2900/月
  btnModePreset.click();
  await h.flush();

  const settingsBackToPreset = api.getPlanSettings();
  assert.match(btnModePreset.getAttribute('class') || '', /active/);
  assert.equal(settingsBackToPreset.currency, 'JPY');
  assert.equal(settingsBackToPreset.actualPricePaid, 2900);
  assert.match(priceVal.textContent, /¥2900/);
  assert.match(detPrice.textContent, /¥2900 · 月付/);
  assert.equal(detPriceTag.textContent, '官方定价');

  api.dispose();
});

// ============================================================================
// 验收测试 3: 并发恢复、慢读取、慢保存与倒序回包时序保证，控件永不锁死
// ============================================================================
test('并发 restoreSettingsFromHost 与倒序回包防护，控件立即可操作', async () => {
  const pendingResolvers = [];

  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const api = h.sandbox.__AGContextMeter;

  h.sandbox.window.contextMeterAPI.getSettings = () => {
    return new Promise(resolve => pendingResolvers.push(resolve));
  };

  // 3.1 模拟并发调用恢复请求
  const p1 = api.restoreSettingsFromHost();
  const p2 = api.restoreSettingsFromHost();

  // 3.2 验证在异步请求挂起期间，用户依然可以立即点击下拉控件，完全不被阻断！
  h.elements.get('direct-region-trigger').click();
  const directMenu = h.elements.get('direct-region-menu');
  const listContainer = directMenu.children.find(c => c.className === 'ag-dropdown-list-container');
  const krItem = listContainer.children.find(it => it.textContent.includes('韩国') || it.children?.some(c => c.textContent.includes('韩国')));
  krItem.click();
  await h.flush();

  // 此时用户已经选定了韩国
  assert.match(h.elements.get('plan-summary-price-val').textContent, /₩29000/);
  assert.equal(api.getPlanSettings().currency, 'KRW');

  // 3.3 慢恢复响应此时才返回（返回旧配置：台湾）
  pendingResolvers[0]?.({
    ok: true,
    customPlan: { subscriptionRegion: '中国台湾 (TW)', currency: 'TWD', actualPricePaid: 650, priceMode: 'preset' }
  });
  pendingResolvers[1]?.({
    ok: true,
    customPlan: { subscriptionRegion: '中国台湾 (TW)', currency: 'TWD', actualPricePaid: 650, priceMode: 'preset' }
  });
  await Promise.all([p1, p2]);
  await h.flush();

  // 验证时序保护：因为网络等待期间用户主动选择了韩国，旧回包被判定为过期，绝不能将韩国覆盖回台湾！
  assert.equal(api.getPlanSettings().currency, 'KRW', '用户最新操作拥有最高权威，旧回包不可覆盖');
  assert.match(h.elements.get('plan-summary-price-val').textContent, /₩29000/);

  api.dispose();
});

// ============================================================================
// 验收测试 4: 独立配置目录多账号隔离、重启/刷新/切换会话落盘一致性
// ============================================================================
test('独立配置目录持久化、多账号隔离与重启后显示与落盘严格一致', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-acceptance-4-'));
  try {
    const accountA = 'user_alpha@corp.invalid';
    const accountB = 'user_beta@corp.invalid';

    // 账号 A 保存为参考价模式：韩国 (KRW)
    const saveA = savePluginSettings({
      email: accountA,
      customPlan: {
        accountRegion: '中国大陆 (CN)',
        subscriptionCountry: '韩国 (KR)',
        subscriptionRegion: '韩国 (KR)',
        region: '韩国 (KR)',
        currency: 'KRW',
        priceMode: 'preset',
        priceSource: 'preset_region',
        actualPricePaid: 29000,
        billingCycle: '月付'
      }
    }, { agDir: tmpDir });
    assert.equal(saveA.ok, true);

    // 账号 B 保存为自定义实付模式：日本 (JPY) 但手填实付 0 元 (免费赠送)
    const saveB = savePluginSettings({
      email: accountB,
      customPlan: {
        accountRegion: '日本 (JP)',
        subscriptionCountry: '日本 (JP)',
        subscriptionRegion: '日本 (JP)',
        region: '日本 (JP)',
        currency: 'JPY',
        priceMode: 'custom',
        priceSource: 'custom',
        isZeroExtraCost: true,
        actualPricePaid: 0,
        billingCycle: '随套餐赠送/免费'
      }
    }, { agDir: tmpDir });
    assert.equal(saveB.ok, true);

    // 读取落盘配置文件并验证隔离性
    const polledA = getPluginSettings({ agDir: tmpDir, email: accountA });
    assert.equal(polledA.customPlan.currency, 'KRW');
    assert.equal(polledA.customPlan.priceMode, 'preset');
    assert.equal(polledA.customPlan.actualPricePaid, 29000);

    const polledB = getPluginSettings({ agDir: tmpDir, email: accountB });
    assert.equal(polledB.customPlan.currency, 'JPY');
    assert.equal(polledB.customPlan.priceMode, 'custom');
    assert.equal(polledB.customPlan.actualPricePaid, 0);

    // 模拟应用重启：重新解析账号 A
    const restoredA = core.resolveEffectivePlanStatus(null, polledA.customPlan, { currentEmail: accountA });
    assert.equal(restoredA.subscriptionRegion, '韩国 (KR)');
    assert.equal(restoredA.currency, 'KRW');
    assert.equal(restoredA.actualPricePaid, 29000);
    assert.equal(restoredA.priceMode, 'preset');

    // 模拟应用重启：重新解析账号 B
    const restoredB = core.resolveEffectivePlanStatus(null, polledB.customPlan, { currentEmail: accountB });
    assert.equal(restoredB.subscriptionRegion, '日本 (JP)');
    assert.equal(restoredB.currency, 'JPY');
    assert.equal(restoredB.actualPricePaid, 0);
    assert.equal(restoredB.priceMode, 'custom');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
