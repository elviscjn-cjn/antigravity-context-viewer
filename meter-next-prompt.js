'use strict';

/**
 * 基于上下文的下一句预测模块 (meter-next-prompt.js)
 * 设计原则：
 * 1. 每轮符合条件最多请求 1 次，仅输出单句或空字符串（严禁生成子进程 agy.exe，禁用工具 tools:[] / mode:NONE）；
 * 2. 主链路直连 CloudCode v1internal:generateContent，仅在明确允许且本地配置可用时受控回退 GetModelResponse；
 * 3. 输入严格脱敏、区分真实用户输入/转发/后台通知、保留末尾验证证据与未完成 task.md 待办，严谨弃权防乱编。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CLOUDCODE_DAILY_URL,
  CLOUDCODE_PROD_URL,
  fetchJsonWithProxy,
  getSharedAccountsManager,
  normalizeEmail
} = require('./meter-accounts');

const DEFAULT_MAX_USER_CHARS = 800;
const DEFAULT_MAX_ASSISTANT_CHARS = 1500;
const DEFAULT_ASSISTANT_TAIL_CHARS = 500;
const DEFAULT_MAX_HISTORY_TURNS = 6;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_PREDICTION_MODEL = 'gemini-3-flash';

const ABSTENTION_RE = /^(?:no_suggestion|none|n\/a|null|empty|skip|\(none\)|无建议|留空)$/i;
const GENERIC_FILLER_RE = /^(?:继续|继续吧|请继续|好的|好|行|收到|谢谢|感谢|明白|ok|okay|continue|go ahead|proceed|thanks|thank you|looks good|sounds good|yes|no|done)\s*[。.!！?？]*$/i;

/**
 * 脱敏文本：屏蔽常见 API Key、Bearer Token、OAuth 凭据、Cookie 与邮箱，避免预测请求外传敏感信息
 */
function redactPredictionText(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  return rawText
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:ya29\.[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|1\/\/[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * 头部+尾部截断：保留开头主干及末尾最关键的验证/问题尾部
 */
function truncateKeepHeadAndTail(text, maxChars, tailChars = 400) {
  const clean = redactPredictionText(text);
  if (!clean || clean.length <= maxChars) return clean;
  const safeTail = Math.max(80, Math.min(tailChars, Math.floor(maxChars * 0.48)));
  const headChars = Math.max(40, maxChars - safeTail - 16);
  return `${clean.slice(0, headChars).trimEnd()}\n…[中间省略]…\n${clean.slice(-safeTail).trimStart()}`;
}

function truncateKeepTail(text, maxChars) {
  const clean = redactPredictionText(text);
  if (!clean || clean.length <= maxChars) return clean;
  return `…${clean.slice(-maxChars).trimStart()}`;
}

/**
 * 解析会话 task.md 勾选状态，严格区分已完成 [x] 与待办 [ ] / [/]
 */
function parseTaskChecklist(markdown) {
  const pending = [];
  const inProgress = [];
  const completed = [];
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { pending, inProgress, completed };
  }
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X|\/)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const text = redactPredictionText(m[2]).slice(0, 140);
    if (!text) continue;
    if (mark === 'x') completed.push(text);
    else if (mark === '/') inProgress.push(text);
    else pending.push(text);
  }
  return { pending, inProgress, completed };
}

/**
 * 从会话目录只读加载 task.md（支持 brain/<cascadeId>/task.md）
 */
function readTaskChecklistForSession(cascadeId, opts = {}) {
  const fsImpl = opts.fs || fs;
  const rawId = String(cascadeId || '').trim();
  if (!rawId || !/^[A-Za-z0-9_-]{4,128}$/.test(rawId)) return { pending: [], inProgress: [], completed: [] };

  const candidates = [];
  if (opts.taskFilePath) candidates.push(opts.taskFilePath);
  if (opts.agDir) candidates.push(path.join(opts.agDir, 'brain', rawId, 'task.md'));
  for (const rootDir of (Array.isArray(opts.rootDirs) ? opts.rootDirs : [])) {
    if (rootDir) candidates.push(path.join(rootDir, 'brain', rawId, 'task.md'));
  }
  if (!candidates.length) {
    try {
      const { getAppDataDir } = require('./asar-engine');
      const homeGemini = path.join(require('node:os').homedir(), '.gemini', 'antigravity');
      candidates.push(path.join(homeGemini, 'brain', rawId, 'task.md'));
      const appDir = getAppDataDir();
      if (appDir) candidates.push(path.join(appDir, 'Antigravity', 'brain', rawId, 'task.md'));
    } catch { }
  }

  for (const p of candidates) {
    try {
      if (p && fsImpl.existsSync(p)) {
        const md = fsImpl.readFileSync(p, 'utf8');
        return parseTaskChecklist(md);
      }
    } catch { }
  }
  return { pending: [], inProgress: [], completed: [] };
}

function detectDominantLanguage(text) {
  const clean = String(text || '');
  if (!clean) return 'en';
  const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const asciiWords = (clean.match(/[a-zA-Z]{2,}/g) || []).length;
  if (cjk >= 4 || (cjk > 0 && cjk >= asciiWords)) {
    if (/[請這與體檢視頁設定執行測試確]/u.test(clean) && !/[请这与体查看页设置执行测试确]/u.test(clean)) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  return 'en';
}

/**
 * 抽取与规范化预测上下文：明确标注来源角色、最近目标/偏好、最后回复尾部、工具摘要及待办清单
 */
function buildPredictionContext(input = {}) {
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const taskChecklist = input.taskMarkdown !== undefined
    ? parseTaskChecklist(input.taskMarkdown)
    : readTaskChecklistForSession(input.cascadeId, input);

  const normalizedTurns = turns
    .filter(t => t && typeof t === 'object')
    .map(t => ({
      sourceType: ['user', 'assistant', 'forwarded', 'background_notification', 'tool_summary'].includes(t.sourceType)
        ? t.sourceType
        : (t.role === 'assistant' ? 'assistant' : 'user'),
      role: t.role === 'assistant' ? 'assistant' : 'user',
      text: redactPredictionText(t.text || t.content || ''),
      status: t.status || 'completed',
      toolSummary: redactPredictionText(t.toolSummary || ''),
      verificationEvidence: redactPredictionText(t.verificationEvidence || '')
    }))
    .filter(t => t.text || t.toolSummary || t.verificationEvidence);

  const realUserTurns = normalizedTurns.filter(t => t.sourceType === 'user');
  const lastTurn = normalizedTurns[normalizedTurns.length - 1] || null;
  const lastNonAssistantTurn = normalizedTurns.slice().reverse().find(t => t.sourceType !== 'assistant') || null;
  const lastRealUser = realUserTurns[realUserTurns.length - 1] || null;
  const lastAssistant = normalizedTurns.slice().reverse().find(t => t.sourceType === 'assistant') || null;

  const recentGoals = realUserTurns.slice(-3).map(t => truncateKeepHeadAndTail(t.text, 280, 120)).filter(Boolean);
  const preferences = Array.isArray(input.preferences)
    ? input.preferences.map(redactPredictionText).filter(Boolean).slice(0, 6)
    : [];

  const olderTurns = normalizedTurns
    .slice(Math.max(0, normalizedTurns.length - (DEFAULT_MAX_HISTORY_TURNS + 2)), -2)
    .map(t => {
      const tag = t.sourceType === 'user'
        ? '[REAL_USER]'
        : t.sourceType === 'forwarded'
          ? '[FORWARDED]'
          : t.sourceType === 'background_notification'
            ? '[BACKGROUND_NOTIFICATION]'
            : t.sourceType === 'tool_summary'
              ? '[TOOL_SUMMARY]'
              : '[ASSISTANT]';
      return `${tag} ${truncateKeepHeadAndTail(t.text || t.toolSummary, 220, 100)}`;
    });

  const lastUserText = lastRealUser ? truncateKeepTail(lastRealUser.text, input.maxUserChars || DEFAULT_MAX_USER_CHARS) : '';
  const lastAssistantText = lastAssistant
    ? truncateKeepHeadAndTail(lastAssistant.text, input.maxAssistantChars || DEFAULT_MAX_ASSISTANT_CHARS, DEFAULT_ASSISTANT_TAIL_CHARS)
    : '';
  const lastToolSummary = (lastAssistant?.toolSummary || normalizedTurns.slice().reverse().find(t => t.toolSummary)?.toolSummary || '').slice(0, 360);
  const verificationEvidence = redactPredictionText(input.verificationEvidence || lastAssistant?.verificationEvidence || '').slice(0, 420);

  const preferredLang = input.language || detectDominantLanguage(lastUserText || lastAssistantText);

  return {
    cascadeId: input.cascadeId || null,
    turnId: input.turnId || null,
    language: preferredLang,
    lastTurnSourceType: lastTurn?.sourceType || null,
    lastNonAssistantSourceType: lastNonAssistantTurn?.sourceType || null,
    lastTurnStatus: lastTurn?.status || 'completed',
    recentGoals,
    preferences,
    olderTurns,
    lastUserText,
    lastAssistantText,
    lastToolSummary,
    verificationEvidence,
    taskChecklist
  };
}

/**
 * 前置保护性弃权：非真实对话轮次完成（如后台通知、中断/报错、空上下文）时不触发额外模型请求
 */
function shouldPreAbstain(ctx) {
  if (!ctx || !ctx.lastAssistantText) return { abstain: true, reason: 'missing_assistant_reply' };
  if (ctx.lastTurnStatus === 'error' || ctx.lastTurnStatus === 'aborted' || ctx.lastTurnStatus === 'streaming') {
    return { abstain: true, reason: `turn_status_${ctx.lastTurnStatus}` };
  }
  if (ctx.lastTurnSourceType === 'background_notification' || ctx.lastNonAssistantSourceType === 'background_notification') {
    return { abstain: true, reason: 'background_notification_turn' };
  }
  if (!ctx.lastUserText) {
    return { abstain: true, reason: 'missing_real_user_turn' };
  }
  return { abstain: false, reason: null };
}

/**
 * 构建用于评测与生产的双模式 Prompt：
 * - baseline：仅看上一轮一问一答（作为离线对照基线）
 * - enhanced：引入最近目标、偏好、task.md 已/未完成项、验证证据与严格 3 档优先级/留空规则
 */
function buildPredictionPrompts(ctx, mode = 'enhanced') {
  const langLabel = ctx.language === 'zh-CN' ? 'Simplified Chinese' : (ctx.language === 'zh-TW' ? 'Traditional Chinese' : 'English');

  if (mode === 'baseline') {
    return {
      systemPrompt: 'Predict the user\'s next short message based only on the previous turn. Reply with a single short sentence in the user\'s language, or NO_SUGGESTION if nothing clear follows.',
      userPrompt: `Last user message:\n${ctx.lastUserText || '(none)'}\n\nLast assistant reply:\n${ctx.lastAssistantText || '(none)'}`
    };
  }

  const systemPrompt = [
    'You predict the single most likely next message the USER will type into the chat box after a completed assistant turn.',
    `Output language MUST match the user's language (${langLabel}) and concise direct tone.`,
    'Strict selection priority:',
    '1. First priority: the smallest concrete next step the user explicitly asked for in recent goals or pending task items that has NOT been done yet.',
    '2. Second priority: a concrete verification or follow-up check strictly grounded in current task evidence and not yet completed.',
    '3. Third priority: a natural user answer to a question in the assistant reply ONLY when earlier user goals or preferences already provide sufficient clues.',
    'Strict abstention rules (output ONLY the exact token NO_SUGGESTION in all these cases):',
    '- The task and user goals are already verified/complete with no remaining pending items.',
    '- The assistant offers two or more choices (e.g. A or B) where the user gave no prior preference.',
    '- Predicting would guess an unstated preference, expand scope, or emit vague filler like "continue", "ok", "thanks", or "继续".',
    'Hard constraints:',
    '- Suggest ONLY ONE short, directly sendable user-voiced sentence (no quotes, no bullets, no markdown framing, max 120 chars / 22 words).',
    '- Ignore [BACKGROUND_NOTIFICATION] entries as user intent. Never repeat items marked completed [x] in task checklist.'
  ].join('\n');

  const blocks = [];
  if (ctx.recentGoals.length) {
    blocks.push(`Confirmed recent user goals:\n- ${ctx.recentGoals.join('\n- ')}`);
  }
  if (ctx.preferences.length) {
    blocks.push(`Explicit user preferences:\n- ${ctx.preferences.join('\n- ')}`);
  }
  if (ctx.taskChecklist.completed.length || ctx.taskChecklist.inProgress.length || ctx.taskChecklist.pending.length) {
    const todoLines = [];
    if (ctx.taskChecklist.completed.length) todoLines.push(`Already completed [x] (DO NOT suggest again): ${ctx.taskChecklist.completed.join('; ')}`);
    if (ctx.taskChecklist.inProgress.length) todoLines.push(`In progress [/]: ${ctx.taskChecklist.inProgress.join('; ')}`);
    if (ctx.taskChecklist.pending.length) todoLines.push(`Remaining pending [ ]: ${ctx.taskChecklist.pending.join('; ')}`);
    blocks.push(`Task checklist state:\n${todoLines.join('\n')}`);
  }
  if (ctx.olderTurns.length) {
    blocks.push(`Earlier trimmed turns:\n${ctx.olderTurns.join('\n')}`);
  }
  blocks.push(`[REAL_USER] Last user request:\n${ctx.lastUserText}`);
  if (ctx.lastToolSummary) {
    blocks.push(`[TOOL_SUMMARY]\n${ctx.lastToolSummary}`);
  }
  if (ctx.verificationEvidence) {
    blocks.push(`[VERIFICATION_EVIDENCE]\n${ctx.verificationEvidence}`);
  }
  blocks.push(`[ASSISTANT] Last assistant reply tail:\n${ctx.lastAssistantText}`);

  return {
    systemPrompt,
    userPrompt: blocks.join('\n\n')
  };
}

/**
 * 清洗、校验并拦截空话与已完成重复项
 */
function sanitizeAndValidateSuggestion(rawOutput, ctx) {
  if (typeof rawOutput !== 'string') return '';
  let text = rawOutput
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (ABSTENTION_RE.test(text)) return '';

  // 剥离外层引号、列表标记或 Markdown 代码包裹
  text = text
    .replace(/^[-*•\d.)]+\s+/, '')
    .replace(/^["'`「『]+|["'`」』]+$/g, '')
    .trim();

  if (!text || ABSTENTION_RE.test(text) || GENERIC_FILLER_RE.test(text)) return '';
  if (text.length > 140) return '';

  // 检查是否与 task.md 中已经勾掉 [x] 的条目完全重合
  const normSug = text.toLowerCase().replace(/[\s，。,.!！?？]/g, '');
  for (const doneItem of (ctx?.taskChecklist?.completed || [])) {
    const normDone = String(doneItem || '').toLowerCase().replace(/[\s，。,.!！?？]/g, '');
    if (normDone && normDone.length >= 6 && (normSug === normDone || normSug.includes(normDone) || normDone.includes(normSug))) {
      return '';
    }
  }

  return text;
}

/**
 * 直连 CloudCode v1internal:generateContent 发起严格无工具的单句文本预测
 */
async function callCloudCodeGenerateContent(prompts, options = {}) {
  const customFetch = options.fetch || null;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const model = String(options.model || DEFAULT_PREDICTION_MODEL).trim().replace(/^models\//i, '');

  let accessToken = options.accessToken || null;
  let projectId = options.projectId || '';
  if (!accessToken) {
    const mgr = getSharedAccountsManager(options.managerOpts || {});
    const ov = mgr.getOverviewState?.() || {};
    const store = mgr.loadStore?.() || { accounts: {} };
    const activeEmail = normalizeEmail(ov.activeAccountEmail || store.activeAccountEmail || '');
    const rec = activeEmail ? store.accounts?.[activeEmail] : null;
    accessToken = rec?.credential?.accessToken || null;
    projectId = projectId || rec?.projectId || '';
  }

  if (!accessToken) {
    return { ok: false, error: 'missing_oauth_credential', reason: 'missing_oauth_credential' };
  }

  const ua = `antigravity/2.34.0 ${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': ua,
    'Content-Type': 'application/json'
  };

  const payload = {
    ...(projectId ? { project: projectId } : {}),
    model,
    request: {
      systemInstruction: { parts: [{ text: prompts.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompts.userPrompt }] }],
      tools: [],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 96,
        candidateCount: 1
      }
    }
  };

  const baseUrls = options.baseUrl
    ? [options.baseUrl]
    : [CLOUDCODE_DAILY_URL, CLOUDCODE_PROD_URL];

  let lastErr = null;
  const startedAt = Date.now();
  for (const baseUrl of baseUrls) {
    try {
      const res = await fetchJsonWithProxy(`${baseUrl}/v1internal:generateContent`, {
        method: 'POST',
        stage: 'next_prompt_predict',
        timeoutMs,
        headers,
        body: JSON.stringify(payload)
      }, customFetch, options.proxyConfigOptions || {});

      if (res.ok && res.json) {
        const respRoot = res.json.response || res.json;
        const candText = respRoot?.candidates?.[0]?.content?.parts
          ?.map(p => (typeof p?.text === 'string' ? p.text : ''))
          .join('')
          .trim() || '';
        const usageMeta = respRoot?.usageMetadata || res.json.usageMetadata || null;
        return {
          ok: true,
          transport: 'cloudcode_generate_content',
          model,
          rawText: candText,
          latencyMs: Date.now() - startedAt,
          usage: usageMeta ? {
            inputTokens: Number(usageMeta.promptTokenCount) || 0,
            outputTokens: Number(usageMeta.candidatesTokenCount) || 0,
            totalTokens: Number(usageMeta.totalTokenCount) || 0
          } : null
        };
      }
      lastErr = new Error(`CloudCode generateContent HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403 || res.status === 400) break;
    } catch (e) {
      lastErr = e;
    }
  }

  return {
    ok: false,
    transport: 'cloudcode_generate_content',
    model,
    error: lastErr?.message || 'cloudcode_failed',
    latencyMs: Date.now() - startedAt
  };
}

/**
 * 受控回退通道：仅在策略显式开启时通过 local-api 调用 GetModelResponse，同样禁工具不写主会话
 */
async function callControlledGetModelResponseFallback(prompts, options = {}) {
  if (options.allowGetModelResponseFallback !== true) {
    return { ok: false, error: 'fallback_disabled' };
  }
  const startedAt = Date.now();
  try {
    const connector = typeof options.connect === 'function' ? options.connect : require('./local-api').connect;
    const api = await connector(options.origin ? { origin: options.origin } : undefined);
    const res = await api.call('GetModelResponse', {
      prompt: `${prompts.systemPrompt}\n\n${prompts.userPrompt}`,
      model: options.model || DEFAULT_PREDICTION_MODEL,
      tools: [],
      disableTools: true
    });
    const text = String(res?.response || res?.text || res?.candidates?.[0]?.text || '').trim();
    return {
      ok: true,
      transport: 'get_model_response_fallback',
      model: options.model || DEFAULT_PREDICTION_MODEL,
      rawText: text,
      latencyMs: Date.now() - startedAt,
      usage: null
    };
  } catch (e) {
    return {
      ok: false,
      transport: 'get_model_response_fallback',
      error: e?.message || 'get_model_response_failed',
      latencyMs: Date.now() - startedAt
    };
  }
}

/**
 * 主入口：根据上下文与设置预测下一句（每个符合条件的轮次最多调用一次；超时不自动重试；绝不启动子进程）
 */
async function predictNextPromptAsync(input = {}, options = {}) {
  const ctx = buildPredictionContext(input);
  const pre = shouldPreAbstain(ctx);
  if (pre.abstain) {
    return {
      ok: true,
      abstained: true,
      suggestion: '',
      reason: pre.reason,
      cascadeId: ctx.cascadeId,
      turnId: ctx.turnId,
      requestCount: 0,
      transport: 'pre_abstain'
    };
  }

  const mode = options.mode === 'baseline' ? 'baseline' : 'enhanced';
  const prompts = buildPredictionPrompts(ctx, mode);

  let genRes;
  if (typeof options.generateFn === 'function') {
    genRes = await options.generateFn(prompts, ctx, options);
  } else {
    genRes = await callCloudCodeGenerateContent(prompts, options);
    if (!genRes.ok && options.allowGetModelResponseFallback === true) {
      genRes = await callControlledGetModelResponseFallback(prompts, options);
    }
  }

  if (!genRes || !genRes.ok) {
    return {
      ok: false,
      abstained: true,
      suggestion: '',
      reason: genRes?.error || 'prediction_unavailable',
      cascadeId: ctx.cascadeId,
      turnId: ctx.turnId,
      model: genRes?.model || options.model || DEFAULT_PREDICTION_MODEL,
      transport: genRes?.transport || 'cloudcode_generate_content',
      requestCount: 1,
      latencyMs: genRes?.latencyMs || 0
    };
  }

  const cleaned = sanitizeAndValidateSuggestion(genRes.rawText, ctx);
  return {
    ok: true,
    abstained: !cleaned,
    suggestion: cleaned,
    rawText: genRes.rawText,
    reason: cleaned ? 'predicted' : 'filtered_or_abstained',
    cascadeId: ctx.cascadeId,
    turnId: ctx.turnId,
    model: genRes.model || options.model || DEFAULT_PREDICTION_MODEL,
    transport: genRes.transport || 'cloudcode_generate_content',
    requestCount: 1,
    latencyMs: genRes.latencyMs || 0,
    usage: genRes.usage || null
  };
}

module.exports = {
  DEFAULT_PREDICTION_MODEL,
  redactPredictionText,
  truncateKeepHeadAndTail,
  truncateKeepTail,
  parseTaskChecklist,
  readTaskChecklistForSession,
  detectDominantLanguage,
  buildPredictionContext,
  shouldPreAbstain,
  buildPredictionPrompts,
  sanitizeAndValidateSuggestion,
  callCloudCodeGenerateContent,
  callControlledGetModelResponseFallback,
  predictNextPromptAsync
};
