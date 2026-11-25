'use strict';

// v0.9.1 第五轮：2D Skyline 紧凑自动排版 + 卡内 @container 自适应

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const GRID_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'dashboard-grid.js'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');

test('Skyline side-by-side magnet previews and releases past the verified packing boundary', () => {
  const api = harness().sandbox.__AGContextMeter;
  const boxes = [{ x: 0, y: 0, w: 295, h: 220 }, { x: 305, y: 0, w: 277, h: 220 }];
  const drag = { gridW: 600, gridLeft: 305, gridTop: 0, startW: 277, startH: 220, neighbors: [boxes[0]] };
  const guide = (w, fromLeft = false) => api.getCockpitResizeGuidesForTest(
    { ...drag, fromLeft }, boxes, 1, w, 220, Math.min(305, 600 - w), 0).x;
  assert.equal(guide(276).pair, true);
  assert.equal(guide(276).snapped, false);
  assert.equal(guide(301).size, 295);
  assert.equal(guide(301, true).snapped, true);
  assert.equal(guide(320).snapped && guide(320).pair, false);
  assert.equal(api.packSkylineBoxesForTest([{ w: 295, h: 220 }, { w: 295, h: 220 }], 600, 10)[1].y, 0);
  assert.equal(api.packSkylineBoxesForTest([{ w: 295, h: 220 }, { w: 296, h: 220 }], 600, 10)[1].y, 230);
});

function ruleOf(css, selector) {
  const needle = selector.replace(/\s*\{\s*$/, '') + ' {';
  const idx = css.indexOf(needle);
  if (idx < 0) return '';
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return '';
  return css.slice(open + 1, close);
}

function harness({ gestures = false } = {}) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '', opacity: '', position: '', top: '', left: '', right: '', bottom: '',
        width: '', height: '', gridColumn: '', justifySelf: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) {
          props.delete(k);
          this[k.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = '';
        },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [], hidden: false, textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) { const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean); if (!cur.includes(c)) cur.push(c); attrs.set('class', cur.join(' ')); },
        remove(c) { attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c).join(' ')); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      addEventListener(type, fn) { if (!listeners.has(el)) listeners.set(el, new Map()); listeners.get(el).set(type, fn); },
      removeEventListener(type) { listeners.get(el)?.delete(type); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id' && v) docElements.set(String(v), el); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      remove() { if (el.parentElement) el.parentElement.children = el.parentElement.children.filter(child => child !== el); },
      appendChild(x) { if (x) { x.parentElement = el; el.children.push(x); } },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
      replaceChildren() { el.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 80, height: 28, right: 180, bottom: 128 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };

  const host = element();
  const overlays = element();
  host.attachShadow = () => (host.shadowRoot ||= {
    set innerHTML(value) { },
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    appendChild: overlays.appendChild,
    querySelectorAll(selector) { return selector === '.ag-widget-resize-badge' ? overlays.children : []; },
    querySelector() { return null; },
    addEventListener(type, fn) { if (!listeners.has(host)) listeners.set(host, new Map()); listeners.get(host).set(type, fn); },
    removeEventListener() { }
  });

  const scans = [], timers = [];
  const docListeners = new Map();
  const pointerListeners = new Map();
  const frames = new Map();
  const observations = new Map();
  let nextFrame = 0;
  const storageMap = new Map();
  const lStore = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    clear() { storageMap.clear(); }
  };

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, new Set()); docListeners.get(type).add(fn); },
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      hidden: false
    },
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) },
      matchMedia: () => ({ matches: false })
    },
    localStorage: lStore,
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() { },
    fetch: () => new Promise(() => { })
  };

  let first = true;
  sandbox.document.createElement = () => {
    if (first) { first = false; return host; }
    return element();
  };

  vm.createContext(sandbox);
  if (gestures) {
    Object.assign(sandbox.window, {
      addEventListener(type, fn) { pointerListeners.set(type, fn); },
      removeEventListener(type, fn) { if (pointerListeners.get(type) === fn) pointerListeners.delete(type); },
      getComputedStyle: () => ({ columnGap: '10px' })
    });
    sandbox.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; };
    sandbox.cancelAnimationFrame = id => frames.delete(id);
    sandbox.MutationObserver = class {
      constructor(fn) { this.fn = fn; }
      observe(target) { observations.set(target, this.fn); }
      disconnect() { }
    };
    const grid = host.attachShadow().getElementById('ctx-bento-grid');
    const panel = host.attachShadow().getElementById('panel');
    const pane = host.attachShadow().getElementById('pane-ctx-session');
    grid.closest = selector => selector === '#pane-ctx-session' ? pane : panel;
  }
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    host,
    elements,
    element,
    lStore,
    pointer: (type, e) => pointerListeners.get(type)?.(e),
    notifyHidden: node => observations.get(node)?.([{ target: node }]),
    flushFrames() {
      for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(16);
    },
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i]?.resolve({
        ok: true,
        data: {
          session: {
            groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
            total: { chars: 100, low: 10, high: 50 },
            attachmentTotal: core.empty(),
            attachments: [],
            unknownFiles: 0,
            steps: 10,
            userMessages: 2,
            assistantMessages: 3
          },
          scannedAt: Date.now(),
          latest: null
        }
      });
    }
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test('v0.9.1 第五轮 / A: 两张自由宽卡并排拼行且绝不重叠', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    // 660 宽容器、10px 间距，两张 320 宽卡必须落在同一行
    const placed = api.packSkylineBoxesForTest([{ w: 320, h: 260 }, { w: 320, h: 300 }], 660, 10);
    assert.equal(placed.length, 2);
    assert.equal(placed[0].y, 0);
    assert.equal(placed[1].y, 0, '两张窄卡必须错落拼在同一行，不得各自独占一行');
    assert.equal(placed[1].x, 330, '第二张必须紧贴第一张右侧并留出 10px 间距');
    assert.equal(overlaps(placed[0], placed[1]), false, '并排卡严禁重叠');

    // 第三张放不下时自动折行
    const three = api.packSkylineBoxesForTest([{ w: 320, h: 260 }, { w: 320, h: 260 }, { w: 320, h: 200 }], 660, 10);
    assert.equal(three[2].x, 0, '放不下必须折行到左侧起始');
    assert.equal(three[2].y, 270, '折行后的 y 必须紧接上一行底部加间距');
    for (let i = 0; i < three.length; i++) {
      for (let j = i + 1; j < three.length; j++) {
        assert.equal(overlaps(three[i], three[j]), false, `卡 ${i} 与卡 ${j} 严禁重叠`);
      }
    }
  } finally {
    api.dispose();
  }
});

test('v0.9.1 第五轮 / B: 高度变化自动下推、行尾碎缝贴齐、任意组合零重叠', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    // 前卡变高必须把后续卡整体下推
    const short = api.packSkylineBoxesForTest([{ w: 600, h: 200 }, { w: 600, h: 200 }], 620, 10);
    const tall = api.packSkylineBoxesForTest([{ w: 600, h: 400 }, { w: 600, h: 200 }], 620, 10);
    assert.equal(short[1].y, 210);
    assert.equal(tall[1].y, 410, '前卡自然高度变大后，后卡必须被自动下推');

    // 行尾 < 24px 缝隙贴齐右缘，> 24px 保持原宽
    const sliver = api.packSkylineBoxesForTest([{ w: 400, h: 100 }, { w: 205, h: 100 }], 620, 10);
    const sliverRight = Math.max(...sliver.map(p => p.x + p.w));
    assert.ok(Math.abs(sliverRight - 620) < 0.51, `行尾碎缝必须贴齐右缘，实际右缘 ${sliverRight}`);
    const wideGap = api.packSkylineBoxesForTest([{ w: 300, h: 100 }], 620, 10);
    assert.equal(wideGap[0].w, 300, '缝隙较大时不得强行拉伸');

    // 随机组合的通用无重叠保证
    const combos = [
      [{ w: 300, h: 180 }, { w: 300, h: 240 }, { w: 300, h: 200 }],
      [{ w: 200, h: 500 }, { w: 400, h: 200 }, { w: 610, h: 150 }],
      [{ w: 610, h: 120 }, { w: 200, h: 300 }, { w: 200, h: 300 }, { w: 200, h: 260 }],
      [{ w: 150, h: 90 }, { w: 150, h: 90 }, { w: 300, h: 90 }, { w: 600, h: 90 }]
    ];
    for (const combo of combos) {
      const out = api.packSkylineBoxesForTest(combo, 620, 10);
      for (let i = 0; i < out.length; i++) {
        assert.ok(out[i].x >= 0 && out[i].x + out[i].w <= 620 + 0.51, `卡 ${i} 不得横向溢出`);
        for (let j = i + 1; j < out.length; j++) {
          assert.equal(overlaps(out[i], out[j]), false, `组合内卡 ${i} 与卡 ${j} 严禁重叠`);
        }
      }
    }
  } finally {
    api.dispose();
  }
});

test('v0.9.1 第五轮 / C: 窄容器收敛单列 100% 宽，宽容器按 widthRatio 换算像素宽', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    // < 520px 容器：无论比例如何一律单列满宽并纵向堆叠
    const narrow = api.packSkylineBoxesForTest([{ w: 300, h: 200 }, { w: 180, h: 200 }], 480, 10);
    assert.equal(narrow[0].w, 480, '窄容器必须收敛为单列满宽');
    assert.equal(narrow[1].w, 480, '窄容器下第二张也必须满宽');
    assert.equal(narrow[1].x, 0);
    assert.equal(narrow[1].y, 210, '窄容器必须纵向堆叠');

    // 宽容器：widthRatio 精确换算
    assert.equal(api.resolveSkylineCardWidthForTest({ widthRatio: 0.5 }, 800, 10), 400);
    assert.equal(api.resolveSkylineCardWidthForTest({ widthRatio: 0.25 }, 800, 10), 200);
    // 旧 span 配置向下兼容
    assert.equal(api.resolveSkylineCardWidthForTest({ span: 6 }, 800, 10), 395);
    assert.equal(api.resolveSkylineCardWidthForTest({ span: 12 }, 800, 10), 800);
    // 窄容器下即使有比例也强制满宽
    assert.equal(api.resolveSkylineCardWidthForTest({ widthRatio: 0.3 }, 480, 10), 480);
  } finally {
    api.dispose();
  }
});

test('v0.9.1 第五轮 / D: 卡内自适应与 2D 排版样式契约齐全', () => {  // 2D 排版接管定位
  const skylineGrid = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-cockpit-grid[data-layout-engine="skyline"]');
  assert.match(skylineGrid, /display:\s*block/, 'skyline 模式下网格必须退化为普通块容器');
  const skylineCard = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-cockpit-grid[data-layout-engine="skyline"] > .ctx-widget-card');
  assert.match(skylineCard, /position:\s*absolute/, 'skyline 模式下卡片必须绝对定位');
  assert.match(skylineCard, /box-sizing:\s*border-box/);

  // 卡内三档宽度属性
  assert.match(GRID_SOURCE, /data-card-size/, '必须按实测宽度写入 data-card-size 档位');
  assert.match(GRID_SOURCE, /'compact'/, '必须存在 compact 档');
  assert.match(GRID_SOURCE, /'regular'/, '必须存在 regular 档');
  assert.match(GRID_SOURCE, /COCKPIT_CARD_COMPACT_MAX = 360/, 'compact 档阈值必须为 360px');

  // 卡内窄态容器查询
  assert.match(STYLES_SOURCE, /@container ctx-widget \(max-width: 360px\)/, '必须存在 360px 卡内容器查询');
  assert.match(STYLES_SOURCE, /@container ctx-widget \(max-width: 360px\)[\s\S]{0,240}\.ctx-token-breakdown-visual\s*\{[\s\S]{0,160}flex-direction:\s*column/,
    'Token 构成与费用卡变窄时环形图与图例必须转为上下堆叠');
  assert.match(STYLES_SOURCE, /@container ctx-widget \(max-width: 360px\)[\s\S]{0,600}\.ctx-kpi-link-pills/, '窄态下 KPI 联动胶囊必须转纵向');
  assert.match(STYLES_SOURCE, /container:\s*ctx-widget\s*\/\s*inline-size/, '卡片必须是 inline-size 容器');

  // 结构兜底：flex 纵向 + 内容区独立滚动
  const cardRule = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-widget-card');
  assert.match(cardRule, /display:\s*flex/);
  assert.match(cardRule, /flex-direction:\s*column/);
  assert.match(cardRule, /overflow:\s*hidden/);
  const bodyRule = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-widget-body');
  assert.match(bodyRule, /flex:\s*1 1 auto/, '内容区必须吃掉剩余空间');
  assert.match(bodyRule, /min-height:\s*0/, '内容区必须允许收缩才不会被腰斩');
  assert.match(bodyRule, /overflow-y:\s*auto/, '内容区必须可独立内滚');
  const hdrRule = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-widget-hdr');
  assert.match(hdrRule, /flex-shrink:\s*0/, '标题栏不得被压缩');

  // 重排防护：ResizeObserver 触发重新排版 + 拖动中不写位置
  assert.match(GRID_SOURCE, /needsRepack = true/, '卡片自然高度变化必须触发重新排版');
  assert.match(GRID_SOURCE, /if \(state\.disposed \|\| activeDrag\) return;/, '拖动中必须跳过重排以免抖动');
  assert.match(GRID_SOURCE, /grid\.style\.height = `\$\{Math\.max\(0, maxBottom\)\}px`/, '必须同步更新容器总高度防重叠');
});

test('v0.9.1 第十轮 / E: 初始宽 0 不接管，面板延迟打开变宽后自动切入 skyline', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    const grid = h.elements.get('ctx-bento-grid');
    assert.ok(grid, '必须有 ctx-bento-grid 容器');
    const mkCard = (id) => {
      const card = h.sandbox.document.createElement('div');
      card.setAttribute('data-widget-id', id);
      card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 180, right: 0, bottom: 180 });
      grid.appendChild(card);
      return card;
    };
    const cardA = mkCard('overview-kpi');
    const cardB = mkCard('token-breakdown');

    // 1) 面板未展开：网格宽 0，绝不能落到绝对定位
    grid.clientWidth = 0;
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
    api.applyCockpitLayoutForTest();
    assert.equal(grid.getAttribute('data-layout-engine'), null, '宽度为 0 时不得标记 skyline');
    assert.equal(cardA.style.position || '', '', '宽度为 0 时卡片必须留在常规流，不能绝对定位');

    // 2) 面板延迟打开：宽度变为 700，必须立即切入 skyline
    grid.clientWidth = 700;
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 400, right: 700, bottom: 400 });
    cardA.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 200, right: 700, bottom: 200 });
    cardB.getBoundingClientRect = () => ({ left: 0, top: 210, width: 340, height: 200, right: 340, bottom: 410 });
    api.applyCockpitLayoutForTest();
    assert.equal(grid.getAttribute('data-layout-engine'), 'skyline', '宽度就绪后必须自动切入 skyline');
    assert.equal(cardA.style.position, 'absolute', '切入 skyline 后卡片必须绝对定位');
    assert.ok(cardA.style.width.endsWith('px'), '切入后必须写入像素宽');
    assert.ok(cardA.getAttribute('data-card-size'), '切入后必须写入 data-card-size 档位');
    assert.ok(Number(String(grid.style.height).replace('px', '')) > 0, '必须同步容器总高度');
  } finally {
    api.dispose();
  }
});

test('v0.9.1 第20轮 / A: Skyline 拖拽保持 absolute 不切 fixed，结束清理并重排', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(src, /const skylineEngine = grid\.getAttribute\?\.\('data-layout-engine'\) === 'skyline';/,
    'Skyline 拖拽必须先判定排版引擎');
  assert.match(src, /if \(skylineEngine\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*card\.style\.position = 'absolute';/,
    'Skyline 下必须保持 absolute，严禁切 fixed');
  assert.match(src, /card\.style\.zIndex = '100';/, 'Skyline 拖拽只抬 z-index');
  assert.match(src, /card\.style\.willChange = 'translate';/, '必须用 translate 跟随指针');
  // 清理兜底
  assert.match(src, /c\.style\.removeProperty\?\.\('translate'\);/, '结束时必须清 translate');
  assert.match(src, /c\.style\.removeProperty\?\.\('will-change'\);/, '结束时必须清 will-change');
  assert.match(src, /c\.style\.removeProperty\?\.\('pointer-events'\);/, '结束时必须恢复 pointer-events');
  assert.match(src, /applyCockpitLayoutToDom\(\{ renderManager: false \}\);\s*\}\s*\} catch \{ \}/,
    '结束时必须触发一次 Skyline 重排落位');
  assert.match(src, /grid\.removeAttribute\?\.\('data-gesture-height-locked'\);/, '必须解除高度锁');
});

function mountGestureGrid(h, width = 440) {
  const grid = h.elements.get('ctx-bento-grid');
  h.elements.get('panel').hidden = false;
  h.elements.get('pane-ctx-session').hidden = false;
  grid.offsetWidth = grid.clientWidth = width;
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 900, width, height: 900 });
  grid.insertBefore = (card, reference) => {
    grid.children = grid.children.filter(child => child !== card);
    const index = reference ? grid.children.indexOf(reference) : grid.children.length;
    grid.children.splice(index, 0, card);
  };
  const cards = ['overview-kpi', 'token-breakdown', 'timing-speed'].map(id => {
    const card = h.element();
    card.setAttribute('data-widget-id', id);
    card.querySelector = selector => selector === '.ctx-widget-body' ? card : null;
    card.getBoundingClientRect = () => {
      const w = parseFloat(card.style.width) || 20;
      const height = parseFloat(card.style.height) || (w < 305 ? 280 : 220);
      const left = parseFloat(card.style.left) || 0;
      const top = parseFloat(card.style.top) || 0;
      return { left, top, width: w, height, right: left + w, bottom: top + height };
    };
    grid.appendChild(card);
    return card;
  });
  const api = h.sandbox.__AGContextMeter;
  api.applyCockpitLayoutForTest();
  return { grid, cards, api };
}

function pointerDown(grid, card, mode) {
  const grip = {
    closest(selector) {
      if (selector === '[data-widget-id]') return card;
      if (selector === '.ctx-widget-hdr' || selector.includes(mode === 'resize' ? 'resize-handle' : 'drag-handle')) return grip;
      return null;
    }
  };
  const y = parseFloat(card.style.top) + 20;
  grid.trigger('pointerdown', { target: grip, pointerType: 'mouse', pointerId: 1, button: 0, clientX: 120, clientY: y });
  return y;
}

test('Skyline pointerup commits the target and preserves final geometry without an observer', () => {
  const h = harness({ gestures: true });
  const { api, grid, cards: [first, second] } = mountGestureGrid(h);
  try {
    const y = pointerDown(grid, first, 'reorder');
    h.pointer('pointermove', { pointerId: 1, buttons: 1, clientX: 120, clientY: y + 8 });
    h.pointer('pointermove', { pointerId: 1, buttons: 1, clientX: 120, clientY: 430 });
    h.pointer('pointerup', { pointerId: 1, buttons: 0, clientX: 120, clientY: 430 });
    assert.equal(first.style.position, 'absolute');
    assert.equal(first.style.width, '440px');
    assert.equal(second.style.top, '0px');
    assert.equal(first.style.top, '230px');
    assert.deepEqual(grid.children.slice(0, 2), [second, first]);
    assert.equal(first.style.translate, '');
    assert.equal(grid.hasAttribute('data-widget-gesture'), false);
  } finally {
    api.dispose();
  }
});

test('Skyline narrow resize stays single-column and clears the live badge on each interruption', () => {
  for (const cancel of ['pointerup', 'panel', 'tab', 'blur', 'Escape', 'pointercancel', 'lostpointercapture', 'released buttons']) {
    const h = harness({ gestures: true });
    const { api, grid, cards: [first, second] } = mountGestureGrid(h);
    try {
      const y = pointerDown(grid, first, 'resize');
      h.pointer('pointermove', { pointerId: 1, buttons: 1, clientX: 15, clientY: y + 56 });
      h.flushFrames();
      assert.equal(api.getResizeBadgeNodeCountForTest(), 1, cancel);
      assert.equal(first.style.width, '440px', cancel);
      assert.ok(parseFloat(second.style.top) >= first.getBoundingClientRect().bottom, cancel);
      if (cancel === 'panel' || cancel === 'tab') {
        const target = h.elements.get(cancel === 'panel' ? 'panel' : 'pane-ctx-session');
        target.hidden = true;
        h.notifyHidden(target);
      } else if (cancel === 'Escape') {
        h.pointer('keydown', { key: cancel });
      } else if (cancel === 'released buttons') {
        h.pointer('pointermove', { pointerId: 1, buttons: 0 });
      } else {
        h.pointer(cancel, { pointerId: 1, buttons: 0, clientX: 15, clientY: y + 56 });
      }
      h.flushFrames();
      assert.equal(api.getResizeBadgeNodeCountForTest(), 0, cancel);
      assert.equal(grid.hasAttribute('data-widget-gesture'), false, cancel);
      assert.equal(first.classList.contains('is-resizing'), false, cancel);
    } finally {
      api.dispose();
    }
  }
});

test('Skyline repacks neighbors using the natural height at the final sliver-adjusted width', () => {
  const h = harness({ gestures: true });
  const { api, grid, cards } = mountGestureGrid(h, 620);
  try {
    const first = cards[1];
    const next = cards[2];
    first.getBoundingClientRect = () => ({ width: parseFloat(first.style.width), height: first.style.width === '620px' ? 290 : 220 });
    const layout = api.getCockpitLayoutForTest();
    layout.widgets.find(widget => widget.id === 'token-breakdown').widthRatio = 0.98;
    h.lStore.setItem('ag_session_cockpit_layout_v1', JSON.stringify(layout));
    api.applyCockpitLayoutForTest();
    assert.equal(first.style.width, '620px');
    assert.equal(parseFloat(next.style.top), parseFloat(first.style.top) + 300);
    assert.equal(grid.getAttribute('data-layout-engine'), 'skyline');
  } finally {
    api.dispose();
  }
});
