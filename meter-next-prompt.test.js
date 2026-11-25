'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const core = require('./meter-core');
const { getPluginSettings, savePluginSettings } = require('./meter-collector');
const nextPrompt = require('./meter-next-prompt');
const { runEvaluation, EVAL_CASES } = require('./scripts/eval-next-prompt');

test('Phase 6 backend: CloudCode tools:[] + mode:NONE、不启动子进程、输入脱敏与 task.md 已完成拦截', async () => {
  const capturedBodies = [];
  const customFetch = async (url, init) => {
    capturedBodies.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: '发一条消息，确认能收到回复' }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12, totalTokenCount: 132 }
        }
      })
    };
  };

  const res = await nextPrompt.predictNextPromptAsync({
    cascadeId: 'conv-p6-1',
    turns: [
      { sourceType: 'user', role: 'user', text: '先装再发一条真实消息，不要泄露密钥 sk-secret1234567890abcdef 或 user@example.com' },
      { sourceType: 'assistant', role: 'assistant', text: '已完成安装。校验结果一切正常，等待你的下一步指令。' }
    ],
    taskMarkdown: '- [x] 完成插件安装\n- [ ] 发一条真实测试消息验证回复'
  }, {
    accessToken: 'ya29.fake_access_token_value',
    projectId: 'proj-test-123',
    fetch: customFetch
  });

  assert.equal(res.ok, true);
  assert.equal(res.abstained, false);
  assert.equal(res.suggestion, '发一条消息，确认能收到回复');
  assert.equal(res.requestCount, 1);

  assert.equal(capturedBodies.length, 1);
  assert.match(capturedBodies[0].url, /\/v1internal:generateContent$/);
  const reqBody = capturedBodies[0].body.request;
  assert.deepEqual(reqBody.tools, []);
  assert.equal(reqBody.toolConfig?.functionCallingConfig?.mode, 'NONE');
  const serializedPrompt = JSON.stringify(reqBody);
  assert.equal(serializedPrompt.includes('sk-secret1234567890abcdef'), false, '敏感 API key 必须脱敏');
  assert.equal(serializedPrompt.includes('user@example.com'), false, '用户邮箱必须脱敏');
  assert.ok(serializedPrompt.includes('[REDACTED_SECRET]'));
  assert.ok(serializedPrompt.includes('[REDACTED_EMAIL]'));

  // 绝不尝试重复建议 task.md 中已经勾掉 [x] 的条目，也绝不接受空话 "继续"
  assert.equal(nextPrompt.sanitizeAndValidateSuggestion('继续', { taskChecklist: { completed: [] } }), '');
  assert.equal(
    nextPrompt.sanitizeAndValidateSuggestion('完成插件安装', { taskChecklist: { completed: ['完成插件安装'] } }),
    ''
  );

  // 后台通知轮次前直接前置弃权（requestCount === 0）
  const bgAbstain = await nextPrompt.predictNextPromptAsync({
    cascadeId: 'conv-p6-bg',
    turns: [
      { sourceType: 'user', role: 'user', text: '先放着吧' },
      { sourceType: 'background_notification', role: 'user', text: 'Delegated task done' },
      { sourceType: 'assistant', role: 'assistant', text: '收到后台完成通知' }
    ]
  }, {
    generateFn: () => { throw new Error('不应发起请求'); }
  });
  assert.equal(bgAbstain.abstained, true);
  assert.equal(bgAbstain.requestCount, 0);

  // 显式关闭受控回退时，CloudCode 失败不得调用 GetModelResponse
  const failNoFallback = await nextPrompt.callControlledGetModelResponseFallback({ systemPrompt: 'a', userPrompt: 'b' }, {
    allowGetModelResponseFallback: false
  });
  assert.equal(failNoFallback.ok, false);

  // 确保无 child_process / spawn / execFile 子进程生成代码
  const srcMod = fs.readFileSync(path.join(__dirname, 'meter-next-prompt.js'), 'utf8');
  assert.equal(/require\(['"](?:node:)?child_process['"]\)|\bspawnSync?\s*\(|\bexecFile(?:Sync)?\s*\(/i.test(srcMod), false);
});

test('Phase 6 eval: 18 条脱敏中英文样本离线 A/B 评估全部可用，增强组命中率与留空表现显著优于基线', async () => {
  assert.ok(EVAL_CASES.length >= 16);
  const report = await runEvaluation({ live: false });
  assert.equal(report.groups.enhanced.samples, EVAL_CASES.length);
  assert.equal(report.groups.enhanced.intentHits, EVAL_CASES.length);
  assert.equal(report.groups.enhanced.falsePositiveOnAbstain, 0, '增强组在应留空样例上不得误弹出');
  assert.ok(report.groups.baseline.falsePositiveOnAbstain > report.groups.enhanced.falsePositiveOnAbstain);
});

test('Phase 6 UI: 默认关闭、8 项门禁、Tab 仅填入草稿不自动发送、Esc 关闭与切会话草稿防覆盖', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-np-settings-'));
  try {
    // 1. 首装默认关闭
    assert.equal(getPluginSettings({ agDir: tmpDir }).nextPromptEnabled, false);
    savePluginSettings({ nextPromptEnabled: true }, { agDir: tmpDir });
    assert.equal(getPluginSettings({ agDir: tmpDir }).nextPromptEnabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  function makeEl(tag) {
    const attrs = new Map(), listeners = new Map(), classes = new Set();
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      children: [], hidden: false, disabled: false, textContent: '', value: undefined, parentElement: null,
      style: { display: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
      replaceChildren(...items) { el.children = []; items.forEach(x => el.appendChild(x)); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      cloneNode() { const cl = makeEl(tag); cl.textContent = el.textContent; return cl; },
      remove() {
        if (el.parentElement) {
          const i = el.parentElement.children.indexOf(el);
          if (i >= 0) el.parentElement.children.splice(i, 1);
        }
        el.parentElement = null;
      },
      closest(sel) {
        if (sel.includes('.surface-composer') && classes.has('surface-composer')) return el;
        return el.parentElement?.closest?.(sel) || null;
      },
      querySelectorAll(sel) {
        const out = [];
        for (const ch of el.children) {
          if (sel.includes('.surface-composer') && ch.classList?.contains?.('surface-composer')) out.push(ch);
          if (sel.includes('[data-lexical-editor="true"]') && ch.getAttribute?.('data-lexical-editor') === 'true') out.push(ch);
          out.push(...ch.querySelectorAll(sel));
        }
        return out;
      },
      querySelector(sel) {
        if (sel.includes('.ag-np-ghost-text')) return el.children[0] || null;
        return el.querySelectorAll(sel)[0] || null;
      },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      removeEventListener(t, fn) { const a = listeners.get(t); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
      dispatchEvent(ev) { for (const fn of (listeners.get(ev.type) || [])) fn(ev); },
      focus() {}
    };
    return el;
  }

  const head = makeEl('HEAD'), body = makeEl('BODY'), doc = makeEl('HTML');
  doc.appendChild(head); doc.appendChild(body);
  const compA = makeEl('DIV'); compA.classList.add('surface-composer');
  const convA = makeEl('DIV'); convA.setAttribute('data-cascade-id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const edA = makeEl('DIV'); edA.setAttribute('data-lexical-editor', 'true'); edA.setAttribute('contenteditable', 'true');
  compA.appendChild(edA); convA.appendChild(compA); body.appendChild(convA);

  const compB = makeEl('DIV'); compB.classList.add('surface-composer');
  const convB = makeEl('DIV'); convB.setAttribute('data-cascade-id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const edB = makeEl('DIV'); edB.setAttribute('data-lexical-editor', 'true'); edB.setAttribute('contenteditable', 'true');
  edB.textContent = 'existing side draft';
  compB.appendChild(edB); convB.appendChild(compB); body.appendChild(convB);

  const elements = new Map(), docListeners = new Map(), predictCalls = [];
  let pendingResolve = null;
  let activeComp = edA;

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    document: {
      head, body, documentElement: doc, hidden: false,
      get activeElement() { return activeComp; },
      createElement: t => makeEl(t),
      getElementById: id => doc.children.find(c => c.id === id) || null,
      querySelector: sel => {
        if (sel.includes('stop-button') || sel.includes('approval') || sel.includes('alertdialog')) return null;
        if (sel.includes('.surface-composer')) return compA;
        return null;
      },
      querySelectorAll: sel => (sel.includes('.surface-composer') ? [compA, compB] : []),
      addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
      removeEventListener: (t, fn) => docListeners.get(t)?.delete(fn),
      dispatchEvent: ev => { for (const fn of (docListeners.get(ev.type) || [])) fn(ev); }
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        predictNextPrompt: (payload) => new Promise(resolve => {
          predictCalls.push(payload);
          pendingResolve = resolve;
        })
      }
    },
    __AGContextMeterCore: core,
    AbortController, Date,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: () => new Promise(() => {})
  };
  let first = true;
  sandbox.document.createElement = (t) => {
    if (first) {
      first = false;
      const host = makeEl('DIV');
      host.attachShadow = () => ({ innerHTML: '', getElementById: id => { if (!elements.has(id)) { const d = makeEl('DIV'); d.id = id; elements.set(id, d); } return elements.get(id); } });
      return host;
    }
    return makeEl(t);
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.__AGContextMeter;
  try {
    // 1. 默认关闭时不发预测请求
    assert.equal(api.getNextPromptStateForTest().enabled, false);
    const rOff = await api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: compA,
      turns: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }]
    });
    assert.equal(rOff.skipped, true);
    assert.equal(predictCalls.length, 0);

    // 2. 开启开关并触发预测，Tab 填入草稿且绝不自动发送，Esc 消除
    api.setNextPromptEnabledForTest(true);
    const p1 = api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: compA,
      turnKey: 'turn-1',
      turns: [{ role: 'user', text: 'install then msg' }, { role: 'assistant', text: 'installed cleanly' }]
    });
    assert.equal(predictCalls.length, 1);
    pendingResolve({ ok: true, suggestion: '发一条消息，确认能收到回复', model: 'gemini-3-flash' });
    const res1 = await p1;
    assert.equal(res1.suggestion, '发一条消息，确认能收到回复');
    assert.equal(api.getNextPromptStateForTest().ghostHidden, false);

    // 同一轮不重复调用
    const dupRes = await api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: compA,
      turnKey: 'turn-1',
      turns: [{ role: 'user', text: 'install then msg' }, { role: 'assistant', text: 'installed cleanly' }]
    });
    assert.equal(dupRes.reason, 'already_predicted_for_turn');

    // Esc 关闭
    sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape', target: edA, preventDefault() {} });
    assert.equal(api.getNextPromptStateForTest().ghostHidden, true);

    // 重新预测并通过 Tab 填入草稿，确认草稿填入且 ghost 消失
    const p2 = api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: compA,
      turnKey: 'turn-2',
      turns: [{ role: 'user', text: 'install then msg' }, { role: 'assistant', text: 'installed cleanly' }]
    });
    pendingResolve({ ok: true, suggestion: '发一条消息，确认能收到回复', model: 'gemini-3-flash' });
    await p2;
    sandbox.document.dispatchEvent({ type: 'keydown', key: 'Tab', target: edA, preventDefault() {} });
    assert.equal(edA.textContent, '发一条消息，确认能收到回复');
    assert.equal(api.getNextPromptStateForTest().ghostHidden, true);

    // 3. 验收场景 4：主会话预测请求在途，切到支线且支线已有草稿时，迟到结果被丢弃且支线草稿不被覆盖
    edA.textContent = '';
    const pLate = api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: compA,
      turnKey: 'turn-late',
      turns: [{ role: 'user', text: 'install' }, { role: 'assistant', text: 'done' }]
    });
    // 切换当前聚焦路由至 Side Chat convB
    api.setContextLatestForTest(null, null, { route: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    activeComp = edB;
    sandbox.location.pathname = '/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    pendingResolve({ ok: true, suggestion: '主会话迟到建议', model: 'gemini-3-flash' });
    const lateOut = await pLate;
    assert.equal(lateOut.skipped, true);
    assert.equal(lateOut.stale, true);
    assert.equal(edB.textContent, 'existing side draft', '支线已有草稿绝不能被主会话迟到建议覆盖');
    assert.equal(api.getNextPromptStateForTest().ghostHidden, true);
  } finally {
    api.dispose();
  }
});
