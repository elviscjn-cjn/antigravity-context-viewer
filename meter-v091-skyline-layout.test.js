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
  assert.match(
    GRID_SOURCE,
    /(?:grid\.style\.height\s*=\s*`\$\{Math\.max\(0,\s*maxBottom\)\}px`|const\s+nextGridH\s*=\s*`\$\{Math\.max\(0,\s*maxBottom\)\}px`[\s\S]{0,120}grid\.style\.height\s*=\s*nextGridH)/,
    '必须同步更新容器总高度防重叠'
  );
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
    assert.ok(parseFloat(first.style.width) <= 440 && parseFloat(first.style.width) >= 72);
    assert.ok(parseFloat(first.style.top) >= 0 && parseFloat(first.style.left) >= 0);
    assert.ok(parseFloat(first.style.left) + parseFloat(first.style.width) <= 440 + 0.5);
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
      assert.ok(parseFloat(first.style.width) < 440 && parseFloat(first.style.width) >= 72, `自由缩放：窄栏/单列必须允许缩宽至极紧凑下限 (${cancel})`);
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

// =========================================================================
// 回归 #6-A：超级自由化 8 向缩放 + 自由画布 + 严格边界钳制 + 首次非空态 + 卡片自适应
// 直接在隔离 VM 加载最新源码 src/renderer/preset-board-upgrades.js + dashboard-grid.js
// =========================================================================
function createFreestyleSourceHarness(gridW = 800, initialStorage = null) {
  const upgradesSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'preset-board-upgrades.js'), 'utf8');
  const gridSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'dashboard-grid.js'), 'utf8');
  const elements = new Map();
  const winListeners = new Map();
  const storageMap = new Map();
  if (initialStorage) storageMap.set('ag_session_cockpit_layout_v1', JSON.stringify(initialStorage));

  const makeEl = (tag = 'div') => {
    const attrs = new Map();
    const listeners = new Map();
    const props = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: null,
      hidden: false,
      isConnected: true,
      textContent: '',
      title: '',
      clientWidth: gridW,
      offsetWidth: gridW,
      offsetHeight: 200,
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
      style: {
        display: '', position: '', left: '', top: '', width: '', height: '',
        minHeight: '', gridColumn: '', justifySelf: '', translate: '', transform: '',
        zIndex: '', pointerEvents: '', transition: '', willChange: '', userSelect: '', touchAction: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) {
          props.delete(k);
          this[k.replace(/-([a-z])/g, (_, l) => l.toUpperCase())] = '';
        },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) elements.set(String(v), node); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(...cs) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          for (const c of cs) if (c && !cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(...cs) {
          attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x && !cs.includes(x)).join(' '));
        },
        toggle(c, on) {
          const next = on === undefined ? !this.contains(c) : Boolean(on);
          if (next) this.add(c); else this.remove(c);
          return next;
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id' && v) elements.set(String(v), node); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        if (!child) return child;
        child.parentElement = node;
        node.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (!child) return child;
        node.children = node.children.filter(c => c !== child);
        child.parentElement = node;
        const idx = ref ? node.children.indexOf(ref) : node.children.length;
        node.children.splice(idx < 0 ? node.children.length : idx, 0, child);
        return child;
      },
      replaceChildren(...items) {
        node.children = [];
        for (const it of items) node.appendChild(it);
      },
      remove() {
        if (node.parentElement) {
          node.parentElement.children = node.parentElement.children.filter(c => c !== node);
          node.parentElement = null;
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      trigger(type, ev = {}) {
        for (const fn of (listeners.get(type) || [])) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
      },
      click() { node.trigger('click', { target: node }); },
      matches(sel) {
        return String(sel).split(',').map(s => s.trim()).some(part => {
          if (part.startsWith('#')) return node.id === part.slice(1);
          if (part.startsWith('.')) return node.classList.contains(part.slice(1));
          const m = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (m) return m[2] !== undefined ? node.getAttribute(m[1]) === m[2] : node.hasAttribute(m[1]);
          return false;
        });
      },
      closest(sel) {
        let cur = node;
        while (cur) {
          if (cur.matches(sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (root) => {
          for (const ch of root.children) {
            if (ch.matches(sel)) out.push(ch);
            walk(ch);
          }
        };
        walk(node);
        return out;
      },
      querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
      setPointerCapture() {},
      hasPointerCapture() { return false; },
      releasePointerCapture() {},
      getBoundingClientRect() {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const width = parseFloat(node.style.width) || node.clientWidth || gridW;
        const height = parseFloat(node.style.height) || node.offsetHeight || 180;
        return { left, top, width, height, right: left + width, bottom: top + height };
      }
    };
    return node;
  };

  const panel = makeEl('section'); panel.id = 'panel';
  const pane = makeEl('div'); pane.id = 'pane-ctx-session';
  const toolbar = makeEl('div'); toolbar.id = 'ctx-cockpit-toolbar';
  const track = makeEl('div'); track.id = 'ctx-cockpit-presets-track';
  const emptyState = makeEl('div'); emptyState.id = 'ctx-cockpit-empty-state'; emptyState.hidden = true;
  const grid = makeEl('div'); grid.id = 'ctx-bento-grid';
  grid.clientWidth = grid.offsetWidth = gridW;
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: grid.clientWidth, height: parseFloat(grid.style.height) || 900, right: grid.clientWidth, bottom: 900 });

  const widgetIds = ['overview-kpi', 'token-breakdown', 'timing-speed', 'trend-pulse', 'context-inspector', 'execution-trace', 'context-events', 'file-radar', 'command-audit', 'agent-collab', 'tech-drawer'];
  const cards = new Map();
  for (const id of widgetIds) {
    const card = makeEl('section');
    card.className = 'ctx-widget-card';
    card.setAttribute('data-widget-id', id);
    const hdr = makeEl('header');
    hdr.className = 'ctx-widget-hdr';
    const grip = makeEl('button');
    grip.className = 'ctx-widget-drag-handle ag-widget-drag-handle';
    hdr.appendChild(grip);
    card.appendChild(hdr);
    const body = makeEl('div');
    body.className = 'ctx-widget-body';
    card.appendChild(body);
    if (id !== 'tech-drawer') {
      const se = makeEl('div');
      se.className = 'ctx-widget-resize-handle ag-widget-resize-handle';
      card.appendChild(se);
    }
    grid.appendChild(card);
    cards.set(id, card);
  }

  const shadow = makeEl('div');
  const host = makeEl('div');
  const sandbox = {
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: true }),
      getComputedStyle: (n) => ({ width: `${n.clientWidth || gridW}px`, columnGap: '10px' }),
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
      requestAnimationFrame: (fn) => { fn(16); return 1; },
      cancelAnimationFrame() {}
    },
    document: {
      hidden: false,
      head: makeEl('head'),
      body: makeEl('body'),
      createElement: makeEl,
      getElementById: (id) => elements.get(id) || null,
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    },
    el: (id) => elements.get(id) || null,
    t: (k) => k,
    state: { ctxWidthTier: 'wide', disposed: false },
    activeDisposers: new Set(),
    shadow,
    host,
    requestAnimationFrame: (fn) => { fn(16); return 1; },
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    WeakMap
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(upgradesSrc, sandbox);
  sandbox.window.AGPresetBoardUpgrades = sandbox.AGPresetBoardUpgrades;
  vm.runInContext(gridSrc, sandbox);
  sandbox.initSessionCockpitGrid();

  return {
    sandbox,
    grid,
    cards,
    emptyState,
    storageMap,
    winTrigger(type, ev = {}) {
      for (const fn of Array.from(winListeners.get(type) || [])) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
    }
  };
}

test('回归 #6-A: 首次默认初始化加载全套模块不误显空态，主动删空全部模块才显空态并支持一键恢复', () => {
  // 1. 纯净首次打开（localStorage 为空）：加载 11 个默认模块，绝不误显空态
  const fresh = createFreestyleSourceHarness(800, null);
  const freshLayout = fresh.sandbox.getCockpitLayout();
  assert.equal(freshLayout.widgets.filter(w => w.visible).length, 11, '首次打开必须加载默认全套 11 个模块');
  assert.equal(fresh.emptyState.hidden, true, '首次打开严禁误显空态');

  // 2. 损坏/未初始化的旧快照（modules: [] 但无 emptyGroup / userClearedAll）：自动恢复默认模块不误显空态
  const stale = createFreestyleSourceHarness(800, { presetId: 'cockpit', modules: [], widgets: [] });
  assert.equal(stale.sandbox.getCockpitLayout().widgets.filter(w => w.visible).length, 11, '非显式空分组不得误判为空态');
  assert.equal(stale.emptyState.hidden, true);

  // 3. 用户主动逐个隐藏所有模块 -> 显示空态 + 一键恢复默认模块按钮，重开读回保留空态
  const visibleIds = freshLayout.widgets.filter(w => w.visible).map(w => w.id);
  for (const id of visibleIds) {
    fresh.sandbox.toggleCockpitWidgetVisibility(id, false);
  }
  const clearedLayout = fresh.sandbox.getCockpitLayout();
  assert.equal(clearedLayout.widgets.filter(w => w.visible).length, 0, '允许用户主动清空所有模块');
  assert.equal(clearedLayout.userClearedAll, true, '主动清空必须标记 userClearedAll=true');
  assert.equal(clearedLayout.emptyGroup, true);
  assert.equal(fresh.emptyState.hidden, false, '主动清空后必须显示空态引导');
  const restoreBtn = fresh.emptyState.querySelector('#btn-ctx-empty-restore-default');
  assert.ok(restoreBtn, '空态必须提供一键恢复默认模块按钮');

  // 4. 重开读回仍保留用户主动清空态
  const reopenedEmpty = createFreestyleSourceHarness(800, JSON.parse(fresh.storageMap.get('ag_session_cockpit_layout_v1')));
  assert.equal(reopenedEmpty.sandbox.getCockpitLayout().widgets.filter(w => w.visible).length, 0);
  assert.equal(reopenedEmpty.emptyState.hidden, false);

  // 5. 点击一键恢复默认模块 -> 立刻恢复全部默认模块并隐藏空态
  restoreBtn.click();
  assert.equal(fresh.sandbox.getCockpitLayout().widgets.filter(w => w.visible).length, 11, '一键恢复必须恢复全套默认模块');
  assert.equal(fresh.emptyState.hidden, true, '恢复后空态必须隐藏');
});

test('回归 #6-A: 8 方向自由缩放至极紧凑 72×48、严格边界钳制、首行自由并排 5 卡、重开精准读回与自适应断点', () => {
  const h = createFreestyleSourceHarness(800);
  const ovCard = h.cards.get('overview-kpi');
  const techCard = h.cards.get('tech-drawer');

  // 1. 全部卡片（含 tech-drawer）必须具备 8 个方向句柄（n/s/e/w/ne/nw/se/sw）
  for (const card of [ovCard, techCard]) {
    const dirs = card.querySelectorAll('[data-resize-dir]').map(n => n.getAttribute('data-resize-dir')).sort();
    assert.deepEqual(dirs, ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'], '每张卡必须具备完整 8 向缩放句柄');
  }

  // 2. 通过右下角 (se) 把 overview-kpi 极限缩小到 72×48（解除旧 176/140/260 硬锁），且不越界
  const seHandle = ovCard.querySelector('[data-resize-dir="se"]');
  h.grid.trigger('pointerdown', { target: seHandle, pointerId: 11, pointerType: 'mouse', button: 0, clientX: 800, clientY: 180 });
  h.winTrigger('pointermove', { pointerId: 11, pointerType: 'mouse', buttons: 1, clientX: -500, clientY: -500 });
  h.winTrigger('pointerup', { pointerId: 11, pointerType: 'mouse', buttons: 0, clientX: -500, clientY: -500 });
  assert.equal(parseFloat(ovCard.style.width), 72, '允许缩小到极紧凑最小宽 72px');
  assert.equal(parseFloat(ovCard.style.height), 48, '允许缩小到极紧凑最小高 48px');
  assert.equal(ovCard.getAttribute('data-card-density'), 'micro', '72×48 必须进入 micro 紧凑密度档');
  assert.equal(ovCard.getAttribute('data-card-shape'), 'micro-tile', '72×48 必须识别为 micro-tile 形态');

  // 3. 左上角 (nw) 与左/上纯边反向拉伸同步更新坐标与宽高，且严格钳制在 x >= 0, y >= 0, x + w <= 800
  const upg = h.sandbox.AGPresetBoardUpgrades;
  const nwRes = upg.resolveFreeResizeGeometry(
    { startX: 200, startY: 200, startW: 200, startH: 160, gridW: 800, gridLeft: 200, gridTop: 200, fromLeft: true, fromTop: true, resizeAxis: 'both' },
    { x: -300, y: -300 },
    { minWidth: 72, minHeight: 48, maxHeight: 1600, freePosition: true }
  );
  assert.equal(nwRes.left, 0, 'nw 往左上拉出容器时 left 严格钳制在 0');
  assert.equal(nwRes.top, 0, 'nw 往左上拉出容器时 top 严格钳制在 0');
  assert.equal(nwRes.width, 400, 'nw 反向拉伸同步增大宽并锁住右缘 400');
  assert.equal(nwRes.height, 360, 'nw 反向拉伸同步增大高并锁住底缘 360');

  // 4. 扁长条 (wide-strip) 与窄高柱 (tall-strip) 形态分类校验
  assert.equal(upg.classifyCardLayoutState(460, 72).shape, 'wide-strip');
  assert.equal(upg.classifyCardLayoutState(140, 300).shape, 'tall-strip');

  // 5. 首行自由并排 5 张模块（每张 148px 宽，间距 10px，总宽 780 <= 800）+ 重开精准读回 + 窄容器自动钳制
  const layout = h.sandbox.getCockpitLayout();
  const row1Ids = ['overview-kpi', 'token-breakdown', 'timing-speed', 'trend-pulse', 'context-inspector'];
  row1Ids.forEach((id, idx) => {
    const w = layout.widgets.find(item => item.id === id);
    const x = idx * 158;
    w.freeRect = { x, y: 0, w: 148, h: 96, xRatio: x / 800, wRatio: 148 / 800, baseW: 800 };
  });
  h.sandbox.persistCockpitLayout(layout);
  h.sandbox.applyCockpitLayoutToDom();

  for (let i = 0; i < row1Ids.length; i++) {
    const card = h.cards.get(row1Ids[i]);
    assert.equal(parseFloat(card.style.top), 0, `首行第 ${i + 1} 张卡必须精准停留在 y=0`);
    assert.equal(parseFloat(card.style.left), i * 158, `首行第 ${i + 1} 张卡 x 坐标精确无漂移`);
    assert.equal(parseFloat(card.style.width), 148);
    assert.equal(parseFloat(card.style.height), 96);
  }

  // 重开读回：完全一致
  const reopened = createFreestyleSourceHarness(800, JSON.parse(h.storageMap.get('ag_session_cockpit_layout_v1')));
  for (let i = 0; i < row1Ids.length; i++) {
    const card = reopened.cards.get(row1Ids[i]);
    assert.equal(parseFloat(card.style.top), 0);
    assert.equal(parseFloat(card.style.left), i * 158);
    assert.equal(parseFloat(card.style.width), 148);
    assert.equal(parseFloat(card.style.height), 96);
  }

  // 容器缩窄到 420px：所有卡片自动严格钳制回 [0, 420]，严禁任何一边越界
  reopened.grid.clientWidth = reopened.grid.offsetWidth = 420;
  reopened.sandbox.applyCockpitLayoutToDom();
  for (const id of row1Ids) {
    const card = reopened.cards.get(id);
    const l = parseFloat(card.style.left);
    const w = parseFloat(card.style.width);
    const topVal = parseFloat(card.style.top);
    assert.ok(l >= 0, `${id} left 不得为负`);
    assert.ok(topVal >= 0, `${id} top 不得为负`);
    assert.ok(l + w <= 420, `${id} 右缘 (${l + w}) 必须严格 <= 420`);
  }
});

test('回归 #6-B: 全 8 向 Pointer Events + setPointerCapture 缩放、窄面板自由缩宽与拖拽严格边界钳制', () => {
  const h = createFreestyleSourceHarness(380);
  const card = h.cards.get('overview-kpi');
  const card2 = h.cards.get('token-breakdown');

  // 1. 窄面板 (380px < 520px) 下通过 se 柄缩成极紧凑 120×64，松手精准停留不弹回 100% 宽
  let capturedId = null;
  const seHandle = card.querySelector('[data-resize-dir="se"]');
  seHandle.setPointerCapture = (pid) => { capturedId = pid; };
  const initRect = card.getBoundingClientRect();
  h.grid.trigger('pointerdown', { target: seHandle, pointerId: 21, pointerType: 'mouse', button: 0, clientX: initRect.width, clientY: initRect.height });
  assert.equal(capturedId, 21, '缩放起点必须调用 setPointerCapture');
  h.winTrigger('pointermove', { pointerId: 21, pointerType: 'mouse', buttons: 1, clientX: 120, clientY: 64 });
  h.winTrigger('pointerup', { pointerId: 21, pointerType: 'mouse', buttons: 0, clientX: 120, clientY: 64 });
  assert.equal(parseFloat(card.style.width), 120, '窄面板自由缩放宽 120px 必须精准停留');
  assert.equal(parseFloat(card.style.height), 64, '窄面板自由缩放高 64px 必须精准停留');

  // 2. 通过 w/n/e/s/nw/ne/sw/se 全部 8 个方向句柄均能驱动缩放且严格不越出 [0, 380] 与 y >= 0
  const layout = h.sandbox.getCockpitLayout();
  const wCfg = layout.widgets.find(w => w.id === 'overview-kpi');
  wCfg.freeRect = { x: 100, y: 80, w: 160, h: 100, xRatio: 100 / 380, wRatio: 160 / 380, baseW: 380 };
  h.sandbox.persistCockpitLayout(layout);
  h.sandbox.applyCockpitLayoutToDom();

  const dirCases = [
    { dir: 'w', startX: 100, startY: 130, endX: -200, endY: 130 },
    { dir: 'n', startX: 180, startY: 80, endX: 180, endY: -200 },
    { dir: 'e', startX: 260, startY: 130, endX: 900, endY: 130 },
    { dir: 's', startX: 180, startY: 180, endX: 180, endY: 260 },
    { dir: 'nw', startX: 100, startY: 80, endX: -120, endY: -120 },
    { dir: 'ne', startX: 260, startY: 80, endX: 700, endY: -120 },
    { dir: 'sw', startX: 100, startY: 180, endX: -120, endY: 240 },
    { dir: 'se', startX: 260, startY: 180, endX: 700, endY: 240 }
  ];
  let pid = 30;
  for (const tc of dirCases) {
    const handle = card.querySelector(`[data-resize-dir="${tc.dir}"]`);
    assert.ok(handle, `句柄 ${tc.dir} 必须存在`);
    pid += 1;
    h.grid.trigger('pointerdown', { target: handle, pointerId: pid, pointerType: 'mouse', button: 0, clientX: tc.startX, clientY: tc.startY });
    h.winTrigger('pointermove', { pointerId: pid, pointerType: 'mouse', buttons: 1, clientX: tc.endX, clientY: tc.endY });
    h.winTrigger('pointerup', { pointerId: pid, pointerType: 'mouse', buttons: 0, clientX: tc.endX, clientY: tc.endY });
    const l = parseFloat(card.style.left);
    const t = parseFloat(card.style.top);
    const w = parseFloat(card.style.width);
    const ht = parseFloat(card.style.height);
    assert.ok(l >= 0, `${tc.dir} 缩放后 left >= 0 (got ${l})`);
    assert.ok(t >= 0, `${tc.dir} 缩放后 top >= 0 (got ${t})`);
    assert.ok(l + w <= 380, `${tc.dir} 缩放后 right <= 380 (got ${l + w})`);
    assert.ok(w >= 72 && ht >= 48, `${tc.dir} 缩放后满足最小紧凑尺寸 (got ${w}x${ht})`);
  }

  // 3. 自由拖拽越界钳制：把卡片拖出左上 (-400, -300) 与右下 (+1200, 120)，四边严格停留在 [0, 380] 与 y >= 0
  const dragHandle = card2.querySelector('.ag-widget-drag-handle');
  assert.ok(dragHandle, '卡片必须包含拖拽手柄');
  h.grid.trigger('pointerdown', { target: dragHandle, pointerId: 91, pointerType: 'mouse', button: 0, clientX: 20, clientY: 200 });
  h.winTrigger('pointermove', { pointerId: 91, pointerType: 'mouse', buttons: 1, clientX: 10, clientY: 190 });
  h.winTrigger('pointermove', { pointerId: 91, pointerType: 'mouse', buttons: 1, clientX: -400, clientY: -300 });
  h.winTrigger('pointerup', { pointerId: 91, pointerType: 'mouse', buttons: 0, clientX: -400, clientY: -300 });
  assert.equal(parseFloat(card2.style.left), 0, '拖出左界必须严格钳制在 x=0');
  assert.equal(parseFloat(card2.style.top), 0, '拖出上界必须严格钳制在 y=0');
  assert.ok(parseFloat(card2.style.left) + parseFloat(card2.style.width) <= 380, '拖出左界后右缘必须 <= 380');

  // 再把紧凑卡往右拖出容器 (+1200, 120)，右缘必须严格 <= 380
  const card1Handle = card.querySelector('.ag-widget-drag-handle');
  h.grid.trigger('pointerdown', { target: card1Handle, pointerId: 92, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20 });
  h.winTrigger('pointermove', { pointerId: 92, pointerType: 'mouse', buttons: 1, clientX: 30, clientY: 24 });
  h.winTrigger('pointermove', { pointerId: 92, pointerType: 'mouse', buttons: 1, clientX: 1200, clientY: 120 });
  h.winTrigger('pointerup', { pointerId: 92, pointerType: 'mouse', buttons: 0, clientX: 1200, clientY: 120 });
  const r1Left = parseFloat(card.style.left);
  const r1W = parseFloat(card.style.width);
  assert.ok(r1Left >= 0 && r1Left + r1W <= 380, `拖出右界必须严格钳制在 [0, 380]，实际 left=${r1Left}, w=${r1W}`);
});
