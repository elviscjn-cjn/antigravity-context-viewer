'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function createSpeedUiHarness(opts = {}) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();

  function makeEl() {
    const attrs = new Map();
    const props = new Map();
    const node = {
      style: {
        display: '',
        opacity: '',
        color: '',
        borderColor: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      scrollTop: 0,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), node); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', cur.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        listeners.get(node).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), node);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() { },
      appendChild(x) {
        if (x) {
          x.parentElement = node;
          node.children.push(x);
          const xId = x.id || x.getAttribute?.('id');
          if (xId) docElements.set(xId, x);
        }
      },
      contains(target) {
        if (target === node) return true;
        return node.children.some(c => c.contains?.(target));
      },
      matches() { return false; },
      replaceChildren(...items) {
        node.children = [];
        for (const it of items) node.appendChild(it);
      },
      querySelectorAll() { return []; },
      click() { listeners.get(node)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 120, height: 24, right: 220, bottom: 124 }; },
      trigger(type, ev = {}) { listeners.get(node)?.get(type)?.(ev); }
    };
    return node;
  }

  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_v) { },
    getElementById(id) {
      if (!elements.has(id)) {
        const elNode = makeEl();
        elNode.id = id;
        elements.set(id, elNode);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  });

  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    document: {
      createElement: () => { if (first) { first = false; return host; } return makeEl(); },
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener() { },
      removeEventListener() { },
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      contextMeterAPI: {
        scan: async () => { opts.onScan?.(); return { ok: true, data: { session: null, scannedAt: Date.now() } }; },
        getTokenHistory: async () => { opts.onGetTokenHistory?.(); return { ok: true, dailyMap: {} }; }
      }
    },
    matchMedia: () => ({ matches: false }),
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval: (fn, ms) => (opts.onSetInterval ? opts.onSetInterval(fn, ms) : 1),
    clearInterval() { },
    fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  return {
    sandbox,
    elements,
    api: sandbox.__AGContextMeter
  };
}

test('ELV-91 1: 原截图长等待案例独立复算与木桶规则回归（TTFT 138.65s / 总耗时 141.99s / 输出 433 / 流速 129.6）', () => {
  const res = core.evaluateGenerationExperience({
    phase: 'final',
    ttftSec: 138.65,
    totalDurationSec: 141.99,
    streamingSec: 3.34,
    streamSpeed: 129.6,
    overallTps: 3.0,
    outputTokens: 433
  }, 'zh-CN');

  // 独立计算精确核对：E = 11.6 (F 级), TTFT 占比 97.6%
  assert.equal(res.efficiency.available, true);
  assert.equal(res.efficiency.score, 11.6);
  assert.equal(res.efficiency.grade, 'F');
  assert.equal(res.ttftRatioPct, 97.6);
  assert.equal(res.ttftFormatted, '2 分 19 秒');
  assert.equal(res.speedColor, '#EF4444');
  assert.equal(res.badge.color, '#DC2626');
  assert.equal(res.speedShortTitle, '漫长煎熬 · 后续极快');
  assert.match(res.comment, /等得花都谢了/);
  assert.match(res.comment, /2 分 19 秒/);
  assert.match(res.comment, /97\.6%/);
  assert.match(res.comment, /129\.6 tok\/s/);
  assert.equal(res.stability.isStable, false);
  assert.doesNotMatch(res.subLabel, /输出平稳/);

  // 流式阶段正在进行时同样不得给纯好评，主标题为 漫长煎熬 · 后续极快 且警示红 #EF4444
  const streamingRes = core.evaluateGenerationExperience({
    phase: 'streaming',
    ttftSec: 138.65,
    totalDurationSec: 141.99,
    streamingSec: 3.34,
    streamSpeed: 129.6,
    outputTokens: 433
  }, 'zh-CN');
  assert.equal(streamingRes.badge.color, '#EF4444');
  assert.equal(streamingRes.badge.text, '漫长煎熬 · 后续极快');
});

test('ELV-91 2: 四维分档精确边界（1/10/30/80/180/300 tok/s, TTFT 600s, 总时长 3600s, E 小数边界）', () => {
  // 纯流式 7 档左闭右开边界
  assert.equal(core.classifyStreamSpeedTier(0.6).title, '彻底停滞');
  assert.equal(core.classifyStreamSpeedTier(0.6).color, '#DC2626');
  assert.match(core.classifyStreamSpeedTier(0.6).comment, /Claude.*Codex.*豆包/);
  assert.doesNotMatch(core.classifyStreamSpeedTier(0.6).comment, /OpenAI/);
  assert.match(core.classifyTtftTier(360, 'zh-CN').comment, /Claude.*Codex.*豆包/);
  assert.match(core.classifyTtftTier(700, 'en').comment, /Claude.*Codex.*Doubao/);
  assert.match(core.classifyEfficiencyGrade(10, 'zh-TW').comment, /Claude.*Codex.*豆包/);
  assert.equal(core.classifyStreamSpeedTier(1.0).title, '濒临卡死');
  assert.match(core.classifyStreamSpeedTier(5.0).comment, /慢得批爆/);
  assert.equal(core.classifyStreamSpeedTier(10.0).title, '慢于阅读');
  assert.equal(core.classifyStreamSpeedTier(30.0).title, '流畅跟读');
  assert.equal(core.classifyStreamSpeedTier(80.0).title, '高速输出');
  assert.equal(core.classifyStreamSpeedTier(180.0).title, '疾速刷屏');
  assert.equal(core.classifyStreamSpeedTier(300.0).title, '瞬时爆发');
  assert.equal(core.classifyStreamSpeedTier(315.2).color, '#8B5CF6');

  // TTFT 7 档及恰好 600s 归世纪等待
  assert.equal(core.classifyTtftTier(0.9).title, '秒回响应');
  assert.equal(core.classifyTtftTier(1.0).title, '正常等待');
  assert.equal(core.classifyTtftTier(10.0).title, '思考较久');
  assert.equal(core.classifyTtftTier(30.0).title, '明显迟缓');
  assert.equal(core.classifyTtftTier(60.0).title, '漫长煎熬');
  assert.equal(core.classifyTtftTier(300.0).title, '极度漫长');
  assert.equal(core.classifyTtftTier(600.0).title, '世纪等待');
  assert.equal(core.classifyTtftTier(600.0).color, '#DC2626');

  // 总耗时 7 档及恰好 3600s 归跨时鏖战
  assert.equal(core.classifyDurationTier(4.9).title, '瞬时完成');
  assert.equal(core.classifyDurationTier(5.0).title, '常规耗时');
  assert.equal(core.classifyDurationTier(30.0).title, '深度处理');
  assert.equal(core.classifyDurationTier(120.0).title, '长程运行');
  assert.equal(core.classifyDurationTier(600.0).title, '重度攻坚');
  assert.equal(core.classifyDurationTier(1800.0).title, '超长耐久');
  assert.equal(core.classifyDurationTier(3600.0).title, '跨时鏖战');

  // E 小数连续值边界 [90,100], [75,90), [60,75), [40,60), [20,40), [0,20)
  assert.equal(core.classifyEfficiencyGrade(90.0).grade, 'S');
  assert.equal(core.classifyEfficiencyGrade(89.9).grade, 'A');
  assert.equal(core.classifyEfficiencyGrade(75.0).grade, 'A');
  assert.equal(core.classifyEfficiencyGrade(74.9).grade, 'B');
  assert.equal(core.classifyEfficiencyGrade(60.0).grade, 'B');
  assert.equal(core.classifyEfficiencyGrade(59.9).grade, 'C');
  assert.equal(core.classifyEfficiencyGrade(40.0).grade, 'C');
  assert.equal(core.classifyEfficiencyGrade(39.9).grade, 'D');
  assert.equal(core.classifyEfficiencyGrade(20.0).grade, 'D');
  assert.equal(core.classifyEfficiencyGrade(19.9).grade, 'F');
});

test('ELV-91 3: 人性化分秒舍入进位、真实体量调节核对与典型五场景', () => {
  assert.equal(core.formatHumanDuration(59.6, 'zh-CN'), '59.6s');
  assert.equal(core.formatHumanDuration(59.96, 'zh-CN'), '1 分 0 秒');
  assert.equal(core.formatHumanDuration(138.65, 'zh-CN'), '2 分 19 秒');
  assert.equal(core.formatHumanDuration(3599.6, 'zh-CN'), '1 小时 0 分');
  assert.equal(core.formatHumanDuration(4200, 'zh-CN'), '1 小时 10 分');
  assert.equal(core.formatHumanDuration(4200, 'en'), '1h 10m');

  // 仍在等待首字 360 秒 (6 分钟)：5-10 分钟档深红 #DC2626，按真实时长表达绝不误说快十分钟
  const wait360 = core.evaluateGenerationExperience({ phase: 'waiting', elapsedSec: 360 }, 'zh-CN');
  assert.equal(wait360.badge.color, '#DC2626');
  assert.equal(wait360.shortTitle, '极度漫长');
  assert.match(wait360.comment, /6 分 0 秒/);
  assert.doesNotMatch(wait360.comment, /快十分钟/);
  assert.equal(wait360.subLabel, '首字未达 · 计时中');

  // 不足 10s 等待为中性灰 #9CA3AF
  const wait4 = core.evaluateGenerationExperience({ phase: 'waiting', elapsedSec: 4.2 }, 'zh-CN');
  assert.equal(wait4.badge.color, '#9CA3AF');
  assert.equal(wait4.shortTitle, '等待首字');

  // TTFT 0.8s, 流速 5.0 tok/s
  const slowStream = core.evaluateGenerationExperience({ phase: 'streaming', ttftSec: 0.8, streamingSec: 12, streamSpeed: 5.0, outputTokens: 60 }, 'zh-CN');
  assert.equal(slowStream.badge.color, '#EF4444');
  assert.equal(slowStream.shortTitle, '濒临卡死');
  assert.match(slowStream.comment, /慢得批爆/);

  // TTFT 0.9s, 流速 80.0 tok/s 且具备 16 块均匀间隔采样 -> 允许显示输出平稳
  const smoothEven = core.evaluateGenerationExperience({
    phase: 'streaming',
    ttftSec: 0.9,
    streamingSec: 5.0,
    streamSpeed: 80.0,
    outputTokens: 400,
    chunkCount: 16,
    chunkIntervalsMs: Array(15).fill(310)
  }, 'zh-CN');
  assert.equal(smoothEven.badge.color, '#3B82F6');
  assert.equal(smoothEven.shortTitle, '高速输出');
  assert.equal(smoothEven.stability.isStable, true);
  assert.match(smoothEven.subLabel, /输出平稳/);

  // 若仅有 chunkCount >= 15 但无真实间隔数组或方差过大 -> 严禁标输出平稳
  const noVarianceEvidence = core.computeStreamStability({ chunkCount: 25, streamingSec: 5.0 });
  assert.equal(noVarianceEvidence.isStable, false);
  assert.equal(noVarianceEvidence.reason, 'missing_interval_evidence');

  const jitteryStream = core.computeStreamStability({
    chunkCount: 16,
    streamingSec: 5.0,
    chunkIntervalsMs: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 2500]
  });
  assert.equal(jitteryStream.isStable, false);
  assert.equal(jitteryStream.reason, 'high_variance');

  // 重型任务宽容系数核对（50K outputTokens, 45 tok/s, 3600s, 有无 inputTokens 均独立算分，高于 F 级）
  const heavyScoreNoIn = core.calculateExperienceScore({ outputTokens: 50000, ttftSec: 10, streamSpeed: 45, totalDurationSec: 3600 });
  const heavyScoreWithIn = core.calculateExperienceScore({ outputTokens: 50000, totalInputTokens: 60000, ttftSec: 10, streamSpeed: 45, totalDurationSec: 3600 });
  assert.equal(heavyScoreNoIn.score, 59);
  assert.ok(heavyScoreWithIn.score > heavyScoreNoIn.score, '输入体量参与 N_work 应进一步提高大型重构耗时宽容度');
});

test('ELV-91 4: 防造假护栏（极小分母不造速度、缺指标不补造 E 分、样本少分开且英文不混中文）', () => {
  // ttft === duration（streamingSec === 0）且无 streamSpeed：不得除以 0.01 造假高速
  const zeroStreamDur = core.evaluateGenerationExperience({
    phase: 'final',
    ttftSec: 25.0,
    totalDurationSec: 25.0,
    outputTokens: 300
  }, 'zh-CN');
  assert.equal(zeroStreamDur.streamSpeed, null);
  assert.equal(zeroStreamDur.efficiency.available, false);
  assert.equal(zeroStreamDur.efficiency.skippedReason, 'missing_metrics');

  // 样本过少仅条件一成立（如仅 outputTokens=8 < 15 但 streamingSec=3.0 >= 0.5）：文案只陈述字数少
  const sparseTokensOnly = core.evaluateGenerationExperience({
    phase: 'final',
    ttftSec: 0.5,
    streamingSec: 3.0,
    totalDurationSec: 3.5,
    streamSpeed: 2.7,
    outputTokens: 8
  }, 'zh-CN');
  assert.equal(sparseTokensOnly.speedShortTitle, '样本过少');
  assert.match(sparseTokensOnly.comment, /仅输出 8 tokens/);
  assert.doesNotMatch(sparseTokensOnly.comment, /耗时极短/);

  // 双条件成立跳过 E 评分
  const sparseScore = core.calculateExperienceScore({
    outputTokens: 10,
    ttftSec: 0.4,
    streamingSec: 1.0,
    totalDurationSec: 1.4,
    streamSpeed: 10
  });
  assert.equal(sparseScore.available, false);
  assert.equal(sparseScore.skippedReason, 'insufficient_sample');

  // 取消与失败不计算速度或评分
  const canc = core.evaluateGenerationExperience({ phase: 'canceled', ttftSec: 4.5 }, 'en');
  assert.equal(canc.efficiency.available, false);
  assert.doesNotMatch(canc.shortTitle + canc.comment + canc.subLabel, /[\u4e00-\u9fa5]/, '英文模式绝不得夹带中文');

  // 英文模式所有状态严格纯英文
  for (const input of [
    { phase: 'waiting', elapsedSec: 360 },
    { phase: 'streaming', ttftSec: 138.65, streamingSec: 3.34, totalDurationSec: 141.99, streamSpeed: 129.6, outputTokens: 433 },
    { phase: 'final', ttftSec: 0.8, streamingSec: 4.0, totalDurationSec: 4.8, streamSpeed: 180, outputTokens: 720 }
  ]) {
    const outEn = core.evaluateGenerationExperience(input, 'en');
    const combined = `${outEn.badge.text}|${outEn.shortTitle}|${outEn.comment}|${outEn.subLabel}`;
    assert.doesNotMatch(combined, /[\u4e00-\u9fa5]/, 'ELV-91 英文输出绝不得夹带中文字符');
  }
});

test('ELV-91 5: UI 面板三阶段展示、闪电颜色联动、最新卡片/时间线 E 评分及规则版本号接入', async () => {
  const h = createSpeedUiHarness();
  try {
    // 1. 阶段一等待：动态变色及闪电同步（测试沙箱模拟等待状态）
    h.api.setSpeedEvaluationForTest({ phase: 'waiting', elapsedSec: 360 });
    let sp = h.api.getSpeedPanelStateForTest();
    assert.equal(sp.badgeColor, '#DC2626');
    assert.equal(sp.boltColor, '#DC2626');
    assert.equal(sp.summaryBoltColor, '#DC2626');
    assert.match(sp.badgeText, /极度漫长/);
    assert.match(sp.subLabel, /首字未达/);

    // 2. 阶段三完成：原截图场景 E=11.6 F 级 + 展开拆解核对规则版本
    h.api.setSpeedEvaluationForTest({
      phase: 'final',
      ttftSec: 138.65,
      streamingSec: 3.34,
      totalDurationSec: 141.99,
      streamSpeed: 129.6,
      overallTps: 3.0,
      outputTokens: 433
    }, { openBreakdown: true });
    sp = h.api.getSpeedPanelStateForTest();
    assert.match(sp.badgeText, /11\.6 分 · F/);
    assert.equal(sp.badgeColor, '#DC2626');
    assert.equal(sp.boltColor, '#DC2626');
    assert.equal(sp.speedVal, '129.6 tok/s');
    assert.equal(sp.ttftVal, '2 分 19 秒');
    assert.equal(sp.durationVal, '2 分 22 秒');
    assert.match(sp.takeaway, /整体均速 3 tok\/s/);
    const gridChildren = h.elements.get('speed-breakdown-grid').children;
    assert.ok(gridChildren.some(c => /综合效率评分/.test(c.children[0].textContent)));
    assert.ok(gridChildren.every(c => !/elv91-v1|ELV-91/i.test(c.children[0].textContent)), '用户可见面板不得暴露内部规则编号或 Linear 编号');

    // 3. 同一记录同步进入最新调用卡片与时间线且字段统一（清除 override）
    h.api.setSpeedEvaluationForTest(null, { openBreakdown: false });
    h.api.setSessionCallsForTest([{
      callId: 'elv91-call-1',
      model: 'gemini-4-carbon',
      modelLabel: 'Orchestrator (Carbon)',
      inputTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 433,
      ttftSec: 138.65,
      streamingSec: 3.34,
      durationSec: 141.99,
      status: 'final',
      timestamp: 1700000000000
    }], { replace: true });

    const cardScore = h.elements.get('latest-call-score-inline');
    assert.equal(cardScore.hidden, false);
    // 此处传入了 inputTokens: 1000（参与 N_work 体量加权），独立计算结果精确为 13.4 分 · F
    assert.match(cardScore.textContent, /13\.4分 · F/);

    await h.api.setPanelLanguage('en', { persist: false });
    assert.match(h.elements.get('latest-call-score-inline').textContent, /13\.4 pts · F/);
  } finally {
    h.api.dispose();
  }
});

test('ELV-91 6: 等待期定时轻量刷新与会话切换不触发全量历史扫描', async () => {
  let scanCount = 0;
  let historyScanCount = 0;
  const intervalFns = [];
  const h = createSpeedUiHarness({
    onScan: () => { scanCount += 1; },
    onGetTokenHistory: () => { historyScanCount += 1; },
    onSetInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; }
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    const initialScans = scanCount;
    const initialHistoryScans = historyScanCount;

    // 模拟等待期连续更新，不应触发额外历史/全量扫描
    for (const elapsedSec of [2.0, 12.3, 35.0, 70.0, 320.0]) {
      h.api.setSpeedEvaluationForTest({ phase: 'waiting', elapsedSec });
    }
    h.api.setSpeedEvaluationForTest(null);

    // 模拟切换当前会话数据并触发路由刷新，仅更新当前会话视图，不触发全量 token 历史重扫
    h.sandbox.location.pathname = '/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    h.api.setSessionCallsForTest([{
      callId: 'c-switch-1',
      model: 'gemini-3-1-pro',
      inputTokens: 100,
      outputTokens: 120,
      ttftSec: 0.9,
      streamingSec: 1.5,
      durationSec: 2.4,
      status: 'final',
      timestamp: Date.now()
    }], { replace: true });

    assert.equal(scanCount, initialScans, '等待期更新与切会话展示不应触发多余 IPC scan');
    assert.equal(historyScanCount, initialHistoryScans, '等待期更新与切会话展示严禁重跑全量 getTokenHistory');
  } finally {
    h.api.dispose();
  }
});

test('ELV-91 7: 短窗口样本统一显示短样本（349 tok / 4.19s / 3.89s / 0.30s -> ~1150 tok/s）、不报错说字太少且保留短窗口对照', async () => {
  const shortCase = core.evaluateGenerationExperience({
    phase: 'final',
    outputTokens: 349,
    ttftSec: 3.89,
    streamingSec: 0.30,
    totalDurationSec: 4.19,
    streamSpeed: 1150.2,
    overallTps: 83.3
  }, 'zh-CN');

  assert.equal(shortCase.isSampleSparse, true);
  assert.equal(shortCase.lowStreamTokens, false);
  assert.equal(shortCase.shortStreamTime, true);
  assert.equal(shortCase.isReliableSpeed, false);
  assert.equal(shortCase.shortWindowEstimateSpeed, 1150.2);
  assert.equal(shortCase.efficiency.available, false);
  assert.equal(shortCase.efficiency.skippedReason, 'insufficient_sample');
  assert.match(shortCase.comment, /流式持续时间过短/);
  assert.doesNotMatch(shortCase.comment, /字太少/);

  const h = createSpeedUiHarness();
  try {
    h.api.setSpeedEvaluationForTest({
      phase: 'final',
      outputTokens: 349,
      ttftSec: 3.89,
      streamingSec: 0.30,
      totalDurationSec: 4.19,
      streamSpeed: 1150.2,
      overallTps: 83.3
    }, { openBreakdown: true });

    const sp = h.api.getSpeedPanelStateForTest();
    assert.equal(h.elements.get('speed-amount').textContent, '短样本');
    assert.equal(h.elements.get('overflow-speed-val').textContent, '短样本');
    assert.equal(sp.speedVal, '短样本');
    assert.match(sp.badgeText, /流式过短/);
    assert.doesNotMatch(sp.badgeText, /瞬时爆发|极快/);
    const cells = h.elements.get('speed-breakdown-grid').children.map(c => `${c.children[0].textContent}=>${c.children[1].textContent}`);
    assert.ok(cells.some(s => /短窗口估算/.test(s) && /1150\.2 tok\/s/.test(s)));
    assert.ok(cells.some(s => /整体平均速率/.test(s) && /83\.3 tok\/s/.test(s)));

    await h.api.setPanelLanguage('en', { persist: false });
    h.api.setSpeedEvaluationForTest({
      phase: 'final',
      outputTokens: 349,
      ttftSec: 3.89,
      streamingSec: 0.30,
      totalDurationSec: 4.19,
      streamSpeed: 1150.2,
      overallTps: 83.3
    }, { openBreakdown: true });
    assert.equal(h.elements.get('speed-amount').textContent, 'Short sample');
    assert.equal(h.api.getSpeedPanelStateForTest().speedVal, 'Short sample');
  } finally {
    h.api.dispose();
  }
});

test('ELV-91 8: 模型重复档位去重、MODEL_PLACEHOLDER_M525 映射与未映射未知处理、假轮询平稳拒绝及 5h/7d 确定性主窗口选择', () => {
  // 1. 防止 Gemini 4 Hydrogen (High) (High) 重复档位
  const splitRes = core.splitModelDisplayAndEffort('Gemini 4 Hydrogen (High) (High)', 'High');
  assert.equal(splitRes.baseLabel, 'Gemini 4 Hydrogen');
  assert.equal(splitRes.effort, 'High');

  const cfgList = [
    { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M525' }, modelId: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' }
  ];
  const recMapped = core.normalizeSessionCallRecord({
    callId: 'call-m525-mapped',
    model: 'MODEL_PLACEHOLDER_M525',
    modelLabel: 'Gemini 4 Hydrogen (High)',
    effort: 'High',
    inputTokens: 1000,
    cacheReadTokens: 2000,
    outputTokens: 300,
    durationSec: 4.0,
    status: 'final'
  }, { cascadeModelConfigs: cfgList });
  assert.equal(recMapped.modelLabel, 'Gemini 4 Hydrogen');
  assert.equal(recMapped.effort, 'High');
  assert.equal(recMapped.rawPlaceholderId, 'MODEL_PLACEHOLDER_M525');
  assert.equal(recMapped.stableModelId, 'gemini-4-hydrogen-high');
  assert.equal(recMapped.isRoutedModelVerified, true);

  // 未映射占位符不得当作已路由真实模型，UI 显示未知
  const recUnmapped = core.normalizeSessionCallRecord({
    callId: 'call-m525-unmapped',
    model: 'MODEL_PLACEHOLDER_M525',
    inputTokens: 500,
    outputTokens: 100,
    status: 'final'
  }, { cascadeModelConfigs: [] });
  assert.equal(recUnmapped.rawPlaceholderId, 'MODEL_PLACEHOLDER_M525');
  assert.equal(recUnmapped.isPlaceholderOnly, true);
  assert.equal(recUnmapped.isRoutedModelVerified, false);
  assert.equal(recUnmapped.modelLabel, null);

  // 2. 合成轮询间隔不得判为平稳
  const synthPoll = core.computeStreamStability({
    chunkCount: 20,
    streamingSec: 5.0,
    chunkIntervalsMs: Array(19).fill(1000),
    sampleSource: 'poll',
    isSyntheticPoll: true
  });
  assert.equal(synthPoll.isStable, false);
  assert.equal(synthPoll.reason, 'synthetic_poll_unsupported');

  // 3. 5h/7d 确定性主窗口选择（同余量优先 5h，较紧缩窗口优先）
  const tieSel = core.selectPrimaryQuotaBucket([
    { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.8 },
    { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.8 }
  ]);
  assert.equal(tieSel.primaryBucket.windowShort, '5h');
  assert.equal(tieSel.selectionReason, 'tie_window');

  const tighterSel = core.selectPrimaryQuotaBucket([
    { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.8 },
    { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.45 }
  ]);
  assert.equal(tighterSel.primaryBucket.windowShort, '7d');
  assert.equal(tighterSel.selectionReason, 'tighter_window');
});
