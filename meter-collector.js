'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { safeWriteJsonSync, safeReadJsonSync } = require('./meter-storage');
const { buildCliProxyEnv, detectProxyConfig } = require('./meter-proxy');
const {
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveCliExecutable,
  resolveCliWorkspace,
  launchCliSession
} = require('./meter-cli-launcher');
const {
  analyzeBinaryAsync: getContextUnlockStatus,
  analyzeBinary,
  analyzeBinaryAsync,
  applyUnlock: applyContextUnlock,
  restoreUnlock: restoreContextUnlock,
  validateContextLimit,
  DEFAULT_CHECKPOINT_TOKENS,
  AUTHOR_INFO: CONTEXT_UNLOCK_AUTHOR
} = require('./meter-context-unlock');
const {
  analyzeSteps,
  summarize,
  add,
  empty,
  measure,
  summarizeApiCost,
  calculateReferenceModelCost,
  resolveEffectivePlanStatus,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  CURRENCY_SYMBOLS,
  parseUserPlanStatus,
  parseGeneratorCall,
  extractModelString,
  normalizeModelId,
  resolveStableModelId,
  isValidSpeedSample,
  MAX_SPEED_SAMPLES_PER_MODEL,
  calculateRequestApiCost,
  filterReleases,
  findReleaseAsset,
  compareVersions
} = require('./meter-core');

let cachedPython = undefined;
function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  const home = os.homedir();
  const candidates = [];
  if (process.env.AG_METER_PYTHON) candidates.push(process.env.AG_METER_PYTHON);
  candidates.push(
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  );
  if (process.platform === 'win32') {
    const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Python');
    if (fs.existsSync(localPrograms)) {
      for (const dir of fs.readdirSync(localPrograms).sort().reverse()) {
        candidates.push(path.join(localPrograms, dir, 'python.exe'));
      }
    }
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).size > 0) {
        cachedPython = p;
        return cachedPython;
      }
    } catch {}
  }
  for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    try {
      const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (check.status === 0 && check.stdout.trim()) {
        cachedPython = check.stdout.trim().split(/\r?\n/)[0];
        return cachedPython;
      }
    } catch {}
  }
  cachedPython = null;
  return null;
}

/**
 * 规范化模型标识符（小写且去掉 proto 常见 MODEL_ 前缀）
 * @param {string} raw
 * @returns {string}
 */
function normalizeModelKeyForCap(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase().replace(/^model_/, '');
}

/**
 * 读取正整数能力数值；非正数或非法值统一返回 null
 * @param {unknown} v
 * @returns {number|null}
 */
function toPositiveIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 读取非负整数能力数值（如 minThinkingBudget/maxOutputTokens 为 0）
 * @param {unknown} v
 * @returns {number|null}
 */
function toNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 解析 LanguageServerService.GetAvailableModels 响应为安全能力映射表
 * 仅提取数值/枚举/标签元数据，绝不保留敏感或无关负载
 * @param {object|null|undefined} raw
 * @returns {Record<string, object>}
 */
function parseAvailableModelsResponse(raw) {
  const out = Object.create(null);
  const modelsObj = raw?.response?.models || raw?.models || (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.userStatus ? raw : null);
  if (!modelsObj || typeof modelsObj !== 'object') return out;

  const entries = Array.isArray(modelsObj)
    ? modelsObj.map(item => [item?.model || item?.modelId || item?.id || '', item])
    : Object.entries(modelsObj);

  for (const [entryKey, d] of entries) {
    if (!d || typeof d !== 'object') continue;
    const rawId = String(d.model || d.modelId || entryKey || '').trim();
    if (!rawId) continue;
    const normKey = normalizeModelKeyForCap(rawId);
    const entry = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : null,
      maxTokens: toPositiveIntOrNull(d.maxTokens ?? d.max_tokens),
      maxOutputTokens: toNonNegativeIntOrNull(d.maxOutputTokens ?? d.max_output_tokens),
      thinkingBudget: toNonNegativeIntOrNull(d.thinkingBudget ?? d.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(d.minThinkingBudget ?? d.min_thinking_budget),
      thinkingLevel: typeof (d.thinkingLevel ?? d.thinking_level) === 'string' ? (d.thinkingLevel ?? d.thinking_level) : null,
      supportsModelInfoOverride: typeof (d.supportsModelInfoOverride ?? d.supports_model_info_override) === 'boolean'
        ? Boolean(d.supportsModelInfoOverride ?? d.supports_model_info_override)
        : null,
      modelProvider: typeof (d.modelProvider ?? d.model_provider) === 'string' ? (d.modelProvider ?? d.model_provider) : null,
      disabled: typeof d.disabled === 'boolean' ? d.disabled : null,
      recommended: typeof d.recommended === 'boolean' ? d.recommended : null,
      tagTitle: typeof (d.tagTitle ?? d.tag_title) === 'string' ? (d.tagTitle ?? d.tag_title).trim() : null,
      tagDescription: typeof (d.tagDescription ?? d.tag_description) === 'string' ? (d.tagDescription ?? d.tag_description).trim() : null,
      capabilitySource: 'get_available_models'
    };
    if (normKey) out[normKey] = entry;
    if (entryKey && normalizeModelKeyForCap(entryKey) && !out[normalizeModelKeyForCap(entryKey)]) {
      out[normalizeModelKeyForCap(entryKey)] = entry;
    }
  }
  return out;
}

/**
 * 从会话 steps[].metadata.modelInfo 中提取实测上报的模型能力元数据
 * 严格隐私边界：仅提取 ModelInfo 数值与枚举标识，绝不读取/存储任何用户消息文本或令牌
 * @param {Array<object>} steps
 * @returns {Record<string, object>}
 */
function extractObservedModelInfoFromSteps(steps) {
  const out = Object.create(null);
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    const md = s?.metadata;
    const mi = md?.modelInfo || md?.model_info;
    if (!mi || typeof mi !== 'object') continue;
    const rawId = String(
      mi.modelId || mi.model_id || md.requestedModel?.model || md.generatorModel?.model || ''
    ).trim();
    const normKey = normalizeModelKeyForCap(rawId);
    const maxTokens = toPositiveIntOrNull(mi.maxTokens ?? mi.max_tokens);
    const maxOutputTokens = toNonNegativeIntOrNull(mi.maxOutputTokens ?? mi.max_output_tokens);
    if (!normKey || (!maxTokens && maxOutputTokens === null)) continue;
    out[normKey] = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof (mi.displayName ?? mi.display_name) === 'string' ? (mi.displayName ?? mi.display_name).trim() : null,
      maxTokens,
      maxOutputTokens,
      thinkingBudget: toNonNegativeIntOrNull(mi.thinkingBudget ?? mi.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(mi.minThinkingBudget ?? mi.min_thinking_budget),
      thinkingLevel: typeof (mi.thinkingLevel ?? mi.thinking_level) === 'string' ? (mi.thinkingLevel ?? mi.thinking_level) : null,
      capabilitySource: 'step_model_info'
    };
  }
  return out;
}

/**
 * 将 GetAvailableModels 与 Step.metadata.modelInfo 的能力字段安全合并到 cascadeModelConfigs
 * 不做按模型名称猜上限；缺失能力保持 null
 */
function mergeModelCapabilitiesIntoConfigs(configs, availableMap = null, stepCapsMap = null) {
  const list = Array.isArray(configs) ? configs.slice() : [];
  const availEntries = availableMap && typeof availableMap === 'object' ? Object.values(availableMap) : [];
  const stepEntries = stepCapsMap && typeof stepCapsMap === 'object' ? Object.values(stepCapsMap) : [];

  const lookupCap = (candidates, label) => {
    for (const c of candidates) {
      const k = normalizeModelKeyForCap(c);
      if (!k) continue;
      if (availableMap?.[k]) return availableMap[k];
      if (stepCapsMap?.[k]) return stepCapsMap[k];
    }
    const cleanLbl = typeof label === 'string' ? label.trim().toLowerCase() : '';
    if (cleanLbl) {
      const aMatches = availEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (aMatches.length === 1) return aMatches[0];
      const sMatches = stepEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (sMatches.length === 1) return sMatches[0];
    }
    return null;
  };

  const merged = list.map(cfg => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const cap = lookupCap([cfg.modelId, cfg.model, cfg.modelOrAlias?.model, cfg.modelOrAlias?.alias], cfg.label || cfg.modelDisplayName);
    if (!cap) return cfg;
    const next = { ...cfg };
    if (next.maxTokens == null && cap.maxTokens != null) next.maxTokens = cap.maxTokens;
    if (next.maxOutputTokens == null && cap.maxOutputTokens != null) next.maxOutputTokens = cap.maxOutputTokens;
    if (next.thinkingBudget == null && cap.thinkingBudget != null) next.thinkingBudget = cap.thinkingBudget;
    if (next.minThinkingBudget == null && cap.minThinkingBudget != null) next.minThinkingBudget = cap.minThinkingBudget;
    if (!next.thinkingLevel && cap.thinkingLevel) next.thinkingLevel = cap.thinkingLevel;
    if (next.supportsModelInfoOverride == null && cap.supportsModelInfoOverride != null) {
      next.supportsModelInfoOverride = cap.supportsModelInfoOverride;
    }
    if (!next.modelProvider && cap.modelProvider) next.modelProvider = cap.modelProvider;
    if (!next.capabilitySource && cap.capabilitySource) next.capabilitySource = cap.capabilitySource;
    if (next.disabled === undefined && cap.disabled !== null) next.disabled = cap.disabled;
    if (!next.tagTitle && cap.tagTitle) next.tagTitle = cap.tagTitle;
    if (!next.tagDescription && cap.tagDescription) next.tagDescription = cap.tagDescription;
    return next;
  });

  return merged;
}

function sanitizeCascadeModelConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const tagTitle = typeof c.tagTitle === 'string' ? c.tagTitle.trim() : '';
  const tagDesc = typeof c.tagDescription === 'string' ? c.tagDescription.trim() : '';
  const isTagUnavailable = /unavailable|disabled|不可用/i.test(tagTitle);
  const isUnavail = Boolean(
    c.unavailable === true ||
    c.isUnavailable === true ||
    c.status === 'unavailable' ||
    c.disabled === true ||
    c.enabled === false ||
    isTagUnavailable
  );
  const isHist = Boolean(
    c.isHistorical === true ||
    c.historical === true ||
    c.deprecated === true ||
    c.isDeprecated === true ||
    (typeof c.label === 'string' && /\(legacy\)|\(deprecated\)|\(old\)/i.test(c.label))
  );
  return {
    modelId: c.modelId || c.model || '',
    label: c.label || c.modelDisplayName || c.modelId || '',
    modelOrAlias: c.modelOrAlias || null,
    value: c.value !== undefined ? c.value : undefined,
    modelAlias: c.modelAlias !== undefined ? c.modelAlias : undefined,
    quotaInfo: c.quotaInfo ? {
      remainingFraction: typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: c.quotaInfo.resetTime || null
    } : null,
    tagTitle: tagTitle || null,
    tagDescription: tagDesc || null,
    contextWindowOptions: Array.isArray(c.contextWindowOptions) ? c.contextWindowOptions : undefined,
    maxTokens: toPositiveIntOrNull(c.maxTokens ?? c.max_tokens),
    maxOutputTokens: toNonNegativeIntOrNull(c.maxOutputTokens ?? c.max_output_tokens),
    thinkingBudget: toNonNegativeIntOrNull(c.thinkingBudget ?? c.thinking_budget),
    minThinkingBudget: toNonNegativeIntOrNull(c.minThinkingBudget ?? c.min_thinking_budget),
    thinkingLevel: typeof (c.thinkingLevel ?? c.thinking_level) === 'string' ? (c.thinkingLevel ?? c.thinking_level) : null,
    supportsModelInfoOverride: typeof (c.supportsModelInfoOverride ?? c.supports_model_info_override) === 'boolean'
      ? Boolean(c.supportsModelInfoOverride ?? c.supports_model_info_override)
      : null,
    modelProvider: typeof (c.modelProvider ?? c.model_provider) === 'string' ? (c.modelProvider ?? c.model_provider) : null,
    capabilitySource: typeof c.capabilitySource === 'string' ? c.capabilitySource : null,
    unavailable: isUnavail,
    unavailabilityReason: c.unavailabilityReason || c.disabledReason || c.reason || (isUnavail ? (tagDesc || tagTitle || null) : null),
    notice: c.notice || c.clientNotice || c.warning || (!isUnavail && tagTitle ? `${tagTitle}${tagDesc ? `：${tagDesc}` : ''}` : null),
    isHistorical: isHist,
    releaseDate: c.releaseDate || null,
    family: c.family || null,
    effort: c.effort || null
  };
}

const filesCache = new Map();
const conversations = new Map();
let pythonQueue = Promise.resolve();

function request(origin, method, body, token) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    const req = https.request(url, { rejectUnauthorized: false, method: method ? 'POST' : 'GET', headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let chunks = [], size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 96 * 1024 * 1024) { req.destroy(new Error('本地响应过大，扫描不完整')); return; } chunks.push(chunk); });
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); if (response.statusCode !== 200) reject(new Error(`本机接口 HTTP ${response.statusCode}`)); else { try { resolve(method ? JSON.parse(text) : text); } catch (e) { reject(e); } } });
    });
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时'))); req.on('error', reject); req.end(method ? JSON.stringify(body) : undefined);
  });
}

function pythonScan(items) {
  const task = pythonQueue.then(() => runPythonScan(items));
  pythonQueue = task.catch(() => {});
  return task;
}

function runPythonScan(items) {
  return new Promise((resolve, reject) => {
    const py = resolvePython();
    if (!py) return reject(new Error('本地 Python 解析环境不可用'));
    const source = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    const completed = [];
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { output += chunk; let at; while ((at = output.indexOf('\n')) >= 0) { const line = output.slice(0, at).trim(); output = output.slice(at + 1); if (line) { try { completed.push(JSON.parse(line)); } catch {} } } }); child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); const reason = timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果'; const done = new Set(completed.map(v => v.key)); for (const item of items) if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] }); resolve(completed); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(items));
  });
}

function getImageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] === 0xFF && [0xC0, 0xC1, 0xC2, 0xC3].includes(buf[offset + 1])) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        } else if (buf[offset] === 0xFF) {
          const len = buf.readUInt16BE(offset + 2);
          offset += 2 + len;
        } else {
          offset++;
        }
      }
    }
  } catch {}
  return { width: null, height: null };
}

function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, (w > 384 || h > 384) ? 1120 : 258)];
}

async function scanFiles(media) {
  const results = new Map(), work = [];
  for (const item of media) {
    try {
      if (item.inlineData) {
        const mime = String(item.mime || '').toLowerCase();
        const buf = Buffer.from(item.inlineData, 'base64');
        if (mime.startsWith('image/')) {
          const dims = getImageDimensions(buf);
          const [low, high] = calcImageTokens(dims.width, dims.height);
          results.set(item.uri, {
            status: 'parsed',
            width: dims.width,
            height: dims.height,
            chars: 0,
            dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
            bytes: buf.length,
            low,
            high,
            unknownParts: []
          });
          continue;
        } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
          const text = buf.toString('utf8');
          const m = measure(text);
          results.set(item.uri, {
            status: 'parsed',
            chars: text.length,
            bytes: buf.length,
            low: m.low,
            high: m.high,
            unknownParts: []
          });
          continue;
        } else {
          const est = Math.ceil(buf.length / 4);
          results.set(item.uri, {
            status: 'parsed',
            chars: buf.length,
            bytes: buf.length,
            low: Math.ceil(est * 0.7),
            high: Math.ceil(est * 1.4),
            unknownParts: []
          });
          continue;
        }
      }
      if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('无可用本地附件，内容未知');
      const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
      if (!fs.existsSync(targetPath)) throw new Error('附件文件不存在或已移动');
      const target = fs.realpathSync(targetPath);
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) results.set(item.uri, filesCache.get(key));
      else work.push({ key: item.uri, path: target, cacheKey: key });
    } catch (e) { results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] }); }
  }
  if (work.length) {
    try {
      const parsed = await pythonScan(work.map(({ key, path }) => ({ key, path })));
      for (const result of parsed) { const job = work.find(w => w.key === result.key); if (job) { filesCache.set(job.cacheKey, result); results.set(job.key, result); } }
    } catch (e) { for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] }); }
  }
  return media.map(item => ({ ...item, ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }), uri: undefined, key: undefined }));
}

async function collect(origin, id, options = {}) {
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  const key = `${origin}/${id}`;
  const previous = conversations.get(key);
  if (previous?.pending) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;
  const task = (async () => {
    const html = await request(origin);
    const token = JSON.parse(html.match(/window.__APP_CONFIG__ = (.*?);/)[1]).csrfToken;
    const call = (method, body) => request(origin, method, body, token);
    const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
    const trajectory = full.trajectory;
    if (!trajectory) throw new Error('未取得会话历史，无法完整统计');
    const wsPath = extractWorkspaceFromTrajectory(trajectory);
    if (wsPath) conversationWorkspaces.set(id.toLowerCase(), wsPath);
    const steps = trajectory.steps || [];
    const expected = Number(full.numTotalSteps ?? steps.length);
    while (steps.length < expected) {
      const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
      if (!page.steps?.length) throw new Error(`历史仅取得 ${steps.length}/${expected} 步，扫描未完成`);
      steps.push(...page.steps);
    }
    const session = analyzeSteps(steps);
    const stepCapabilities = extractObservedModelInfoFromSteps(steps);
    const attachments = await scanFiles(session.media);
    const attachmentTotal = empty();
    for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
    const total = add({ ...session.total }, attachmentTotal);
    let latest = null;
    const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
    const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, count - 3), includeMessages: false });
    let knownCascadeConfigs = Array.isArray(cachedHostUserStatus?.cascadeModelConfigs) ? cachedHostUserStatus.cascadeModelConfigs : [];
    const hasAnyCap = knownCascadeConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
    if (!knownCascadeConfigs.length || !hasAnyCap) {
      try {
        const freshStatus = await fetchUserStatusFromHost();
        if (Array.isArray(freshStatus?.cascadeModelConfigs) && freshStatus.cascadeModelConfigs.length) {
          knownCascadeConfigs = freshStatus.cascadeModelConfigs;
        }
      } catch {}
    }
    const mergedCascadeConfigs = mergeModelCapabilitiesIntoConfigs(
      knownCascadeConfigs,
      cachedHostUserStatus?.availableModelDetails || null,
      stepCapabilities
    );
    let latestModel = null;
    let latestCallId = null;
    for (const m of (tail.generatorMetadata || []).slice().reverse()) {
      latest = summarize(m, { cascadeModelConfigs: mergedCascadeConfigs });
      if (latest) {
        latestModel = m.chatModel;
        const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
        latestCallId = callMeta?.callId || null;
        break;
      }
    }
    const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
    const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
    session.groups.system = system; session.groups.definitions = definitions;
    add(total, system); add(total, definitions);
    if (session.currentError) {
      const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, {
        currentModel: latest?.model || latestModel?.modelDisplayName || latestModel?.model || '',
        cascadeModelConfigs: mergedCascadeConfigs,
        previousValidContext: latest
      });
      if (fromStep?.error) {
        latest = {
          ...(latest || {}),
          error: fromStep.error,
          errorClassification: fromStep.errorClassification,
          exceeded: fromStep.exceeded,
          network: fromStep.network,
          serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null,
          status: fromStep.status,
          actual: fromStep.exceeded ? null : (latest?.actual ?? null),
          percent: fromStep.exceeded ? null : (latest?.percent ?? null),
          estimated: latest?.actual == null
        };
      }
    }
    const unknownFiles = attachments.filter(a => a.status !== 'parsed').length;
    const compactCascadeConfigs = mergedCascadeConfigs.map(sanitizeCascadeModelConfig).filter(Boolean);
    const modelCapabilitiesById = {
      ...(cachedHostUserStatus?.availableModelDetails || {}),
      ...stepCapabilities
    };
    const result = { version: '0.8.3', conversation: id, workspacePath: wsPath || null, latest, latestCallId, generatorCount: count, cascadeModelConfigs: compactCascadeConfigs, modelCapabilitiesById, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
    conversations.set(key, { result, at: Date.now() });
    return result;
  })();
  conversations.set(key, { ...previous, pending: task });
  try { return await task; } catch (e) { conversations.delete(key); throw e; }
}

let cachedTokenHistory = null;
let cachedTokenHistoryAt = 0;

function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 检查是否为 SQLite 伴生文件或临时文件
function isCompanionOrTempFile(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('-wal') ||
         lower.endsWith('-shm') ||
         lower.endsWith('-journal') ||
         lower.endsWith('.tmp') ||
         lower.endsWith('.lock') ||
         lower.endsWith('.bak');
}

// 尝试安全读取 LanguageServer 的 GetUserStatus

// ============================================================================
// 逐请求已计价账本持久化、合成数据隔离与幂等入账
// ============================================================================
let cachedLedger = null;

function isSyntheticCall(callId, call = {}) {
  if (!callId) return false;
  const sId = String(callId).toLowerCase();
  const cId = String(call?.cascadeId || '').toLowerCase();
  return sId.startsWith('test_') ||
         sId.startsWith('fixture_') ||
         sId.startsWith('synthetic_') ||
         sId.includes('desktop_response_001') ||
         cId.includes('verify') ||
         cId.includes('test') ||
         cId.includes('mock');
}

function getPricingLedgerPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'pricing_ledger_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'pricing_ledger_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'pricing_ledger_v1.json');
}

function quarantineSyntheticCalls(overridePathOrDir) {
  const p = getPricingLedgerPath(overridePathOrDir);
  const qPath = p.replace('pricing_ledger_v1.json', 'pricing_ledger_quarantine.json');
  if (!fs.existsSync(p)) return { quarantinedCount: 0 };

  try {
    const readRes = safeReadJsonSync(p, null);
    if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
      return { quarantinedCount: 0 };
    }
    const raw = readRes.data;
    const calls = raw.calls || {};
    const quarantined = {};
    const kept = {};

    for (const [id, call] of Object.entries(calls)) {
      if (isSyntheticCall(id, call)) {
        quarantined[id] = call;
      } else {
        kept[id] = call;
      }
    }

    const qCount = Object.keys(quarantined).length;
    if (qCount > 0) {
      let qData = { version: '1.0.0', quarantinedAt: new Date().toISOString(), calls: {} };
      if (fs.existsSync(qPath)) {
        const qRead = safeReadJsonSync(qPath, null);
        if (qRead.ok && qRead.data && typeof qRead.data === 'object') {
          qData = qRead.data;
        }
      }
      qData.calls = { ...qData.calls, ...quarantined };
      safeWriteJsonSync(qPath, qData);

      raw.calls = kept;
      raw.updatedAt = new Date().toISOString();
      const saveRes = safeWriteJsonSync(p, raw);
      if (saveRes.ok && cachedLedger && cachedLedger.calls) {
        cachedLedger.calls = kept;
      }
    }
    return { quarantinedCount: qCount };
  } catch {
    return { quarantinedCount: 0 };
  }
}

function loadPricingLedger(overridePathOrDir) {
  if (!overridePathOrDir && cachedLedger && !cachedLedger.__corrupted) return cachedLedger;
  const p = getPricingLedgerPath(overridePathOrDir);
  const def = { version: '1.0.0', updatedAt: '', calls: {} };
  const bakPath = p.replace(/\.json$/i, '') + '.bak.json';
  const readRes = safeReadJsonSync(p, null, {
    backupPath: bakPath,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });

  if (!readRes.exists) {
    if (!overridePathOrDir) cachedLedger = def;
    return def;
  }

  if (readRes.corrupted && !readRes.recoveredFromBackup) {
    // 文件存在但损坏且无备份可恢复，绝不能当作正常空数据覆盖
    return {
      version: '1.0.0',
      updatedAt: '',
      calls: {},
      __corrupted: true,
      __corruptedPath: p,
      __error: readRes.error
    };
  }

  const raw = readRes.data || def;
  const ledger = { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || '', calls: raw.calls || {} };
  let hasSynthetic = false;
  for (const [id, call] of Object.entries(ledger.calls)) {
    if (isSyntheticCall(id, call)) {
      hasSynthetic = true;
      break;
    }
  }
  if (hasSynthetic) {
    quarantineSyntheticCalls(overridePathOrDir);
    const cleanedRes = safeReadJsonSync(p, null);
    if (cleanedRes.ok && cleanedRes.data && typeof cleanedRes.data === 'object') {
      ledger.calls = cleanedRes.data.calls || {};
      ledger.updatedAt = cleanedRes.data.updatedAt || '';
    }
  }

  // 正常落盘数据建立自动滚动备份，供损坏时恢复
  if (!readRes.corrupted && fs.existsSync(p)) {
    try {
      if (!fs.existsSync(bakPath) || Math.random() < 0.1) {
        fs.copyFileSync(p, bakPath);
      }
    } catch {}
  }

  if (!overridePathOrDir) cachedLedger = ledger;
  return ledger;
}

function savePricingLedger(ledger, overridePathOrDir) {
  if (ledger && ledger.__corrupted) {
    return { ok: false, error: '原账本数据已损坏且未从备份恢复，已阻止以空数据覆盖原有历史' };
  }
  const p = getPricingLedgerPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, ledger, {
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });
  if (res.ok) {
    if (!overridePathOrDir) cachedLedger = ledger;
  }
  return res;
}

function createRecordResult(ok, changed, error, phase) {
  return {
    ok: !!ok,
    changed: !!changed,
    error: error || undefined,
    phase: phase || undefined,
    valueOf() { return this.changed; }
  };
}

function hasSpeedMetrics(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return rec.durationSec != null || rec.tps != null || rec.ttftSec != null || rec.streamingSec != null;
}

function getCallSortTimestamp(rec) {
  if (!rec) return 0;
  if (Number.isFinite(Number(rec.timestamp)) && Number(rec.timestamp) > 0) return Number(rec.timestamp);
  if (rec.created_at) {
    const t = Date.parse(rec.created_at);
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (rec.date) {
    const t = Date.parse(rec.date);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Number(rec.updatedAt) || 0;
}

/**
 * 每个准确模型 ID 最多保留最近 200 条速度样本；超出的只清除速度字段，计费与 token 数据保留不动
 */
function pruneExcessSpeedSamples(draftCalls, limit = MAX_SPEED_SAMPLES_PER_MODEL || 200) {
  if (!draftCalls || typeof draftCalls !== 'object') return false;
  const byModel = new Map();
  for (const [callId, rec] of Object.entries(draftCalls)) {
    if (!rec || !hasSpeedMetrics(rec)) continue;
    const exactId = String(rec.modelExactId || resolveStableModelId(rec) || rec.model || '').trim().toLowerCase();
    if (!exactId) continue;
    if (!byModel.has(exactId)) byModel.set(exactId, []);
    byModel.get(exactId).push({ callId, ts: getCallSortTimestamp(rec) });
  }
  let pruned = false;
  for (const entries of byModel.values()) {
    if (entries.length <= limit) continue;
    entries.sort((a, b) => b.ts - a.ts);
    for (let i = limit; i < entries.length; i++) {
      const rec = draftCalls[entries[i].callId];
      if (!rec) continue;
      const copy = { ...rec };
      delete copy.ttftSec;
      delete copy.streamingSec;
      delete copy.durationSec;
      delete copy.tps;
      delete copy.origin;
      draftCalls[entries[i].callId] = copy;
      pruned = true;
    }
  }
  return pruned;
}

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const ledger = loadPricingLedger(targetDir);

  if (ledger.__corrupted) {
    return createRecordResult(false, false, `账本已损坏，阻止空覆盖 (${ledger.__corruptedPath})`, 'corrupted_guard');
  }

  // 使用独立副本避免在写入磁盘失败前原地修改共享缓存
  const draftCalls = { ...(ledger.calls || {}) };
  let changed = false;

  for (const call of newCalls) {
    if (!call || !call.callId) continue;
    // 默认阻止测试样例和合成调用污染生产账本
    if (!options.allowSynthetic && isSyntheticCall(call.callId, call)) continue;

    const existing = draftCalls[call.callId];
    if (!existing) {
      draftCalls[call.callId] = {
        ...call,
        updatedAt: Date.now()
      };
      changed = true;
      continue;
    }

    // 幂等入账与数据校准：记录新调用；当存在更完整、最终用量或补齐实测速度数据时更新校准
    const stateProgressed = existing.status === 'streaming' && call.status === 'final';
    const usageProgressed = (call.outputTokens || 0) > (existing.outputTokens || 0) || (call.totalTokens || 0) > (existing.totalTokens || 0);
    const pricingProgressed = (!existing.isPriced || !existing.costUSD) && (call.isPriced && call.costUSD > 0);
    const speedProgressed = !hasSpeedMetrics(existing) && hasSpeedMetrics(call) && isValidSpeedSample(call);
    const modelExactProgressed = !existing.modelExactId && Boolean(call.modelExactId);
    const isStaleRollback = (existing.status === 'final' && call.status !== 'final') ||
      (existing.status === 'final' && (call.outputTokens || 0) < (existing.outputTokens || 0));

    if (!isStaleRollback && (stateProgressed || usageProgressed || pricingProgressed || speedProgressed || modelExactProgressed)) {
      draftCalls[call.callId] = {
        ...existing,
        ...call,
        created_at: existing.created_at || call.created_at,
        date: existing.date || call.date,
        updatedAt: Date.now()
      };
      changed = true;
    }
  }

  if (pruneExcessSpeedSamples(draftCalls)) {
    changed = true;
  }

  if (changed) {
    const draftLedger = {
      ...ledger,
      calls: draftCalls,
      updatedAt: new Date().toISOString()
    };
    const saveRes = savePricingLedger(draftLedger, targetDir);
    if (!saveRes.ok) {
      return createRecordResult(false, false, saveRes.error || '保存账本落盘失败', saveRes.phase);
    }
    if (!targetDir) {
      cachedTokenHistoryAt = 0;
    }
  }

  return createRecordResult(true, changed);
}

// ============================================================================
// 用户自定义订阅配置与插件栏偏好持久化（按账号隔离 + default 回退 + 损坏自愈）
// ============================================================================
function getCustomPlanPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'custom_plan_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'custom_plan_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'custom_plan_v1.json');
}

function sanitizeAccountPlanEntry(entry, accountKey = 'default') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = { ...entry };
  out.account = String(entry.account || accountKey || 'default').trim().toLowerCase();

  // 1. 账号所在地区 (accountRegion / country)：独立保留，仅修改本地记录
  const rawAccReg = (typeof out.accountRegion === 'string' && out.accountRegion.trim())
    ? out.accountRegion.trim()
    : ((typeof out.country === 'string' && out.country.trim()) ? out.country.trim() : '');
  if (rawAccReg && !rawAccReg.includes('未知')) {
    out.accountRegion = rawAccReg;
    out.country = rawAccReg;
  } else {
    delete out.accountRegion;
    delete out.country;
  }

  // 2. 订阅国家 (subscriptionCountry / subscriptionRegion / region)：独立保留，可与账号所在地区不同
  const rawSubCountry = (typeof out.subscriptionCountry === 'string' && out.subscriptionCountry.trim())
    ? out.subscriptionCountry.trim()
    : ((typeof out.subscriptionRegion === 'string' && out.subscriptionRegion.trim())
      ? out.subscriptionRegion.trim()
      : ((typeof out.region === 'string' && out.region.trim()) ? out.region.trim() : ''));
  if (rawSubCountry && !rawSubCountry.includes('未知')) {
    out.subscriptionCountry = rawSubCountry;
    out.subscriptionRegion = rawSubCountry;
    out.region = rawSubCountry;
  } else {
    delete out.subscriptionCountry;
    delete out.subscriptionRegion;
    delete out.region;
  }

  // 3. 订阅币种 (subscriptionCurrency / currency)：独立保留，支持标记手动(custom)或自动(auto)来源
  const rawCur = (typeof out.subscriptionCurrency === 'string' && out.subscriptionCurrency.trim())
    ? out.subscriptionCurrency.trim()
    : ((typeof out.currency === 'string' && out.currency.trim()) ? out.currency.trim() : '');
  if (rawCur) {
    let cur = rawCur.toUpperCase();
    if (cur === 'NTD') cur = 'TWD';
    if (CURRENCY_SYMBOLS[cur]) {
      out.subscriptionCurrency = cur;
      out.currency = cur;
      if (!out.currencySymbol) out.currencySymbol = CURRENCY_SYMBOLS[cur];
    } else {
      delete out.subscriptionCurrency;
      delete out.currency;
      delete out.currencySymbol;
    }
  } else {
    delete out.subscriptionCurrency;
    delete out.currency;
    delete out.currencySymbol;
  }

  if (out.currencySource) {
    out.currencySource = String(out.currencySource).trim();
  }

  // 1. 先清洗校验实付金额 (actualPricePaid)
  if (out.actualPricePaid !== undefined && out.actualPricePaid !== null && out.actualPricePaid !== '') {
    const num = Number(out.actualPricePaid);
    if (Number.isFinite(num) && num >= 0) {
      out.actualPricePaid = num;
    } else {
      out.actualPricePaid = null;
    }
  } else {
    out.actualPricePaid = null;
  }

  // 2. 校验价格模式 (priceMode)
  if (out.priceMode === 'custom' || out.priceMode === 'preset') {
    // 保持用户显式模式
  } else if (out.priceSource === 'preset_region') {
    out.priceMode = 'preset';
  } else if (out.actualPricePaid !== null) {
    out.priceMode = 'custom';
  } else {
    out.priceMode = 'preset';
  }

  if (out.priceMode === 'custom' && out.actualPricePaid !== null) {
    out.customActualPrice = out.actualPricePaid;
  }

  if (out.customActualPrice !== undefined && out.customActualPrice !== null && out.customActualPrice !== '') {
    const cNum = Number(out.customActualPrice);
    if (Number.isFinite(cNum) && cNum >= 0) {
      out.customActualPrice = cNum;
    } else {
      delete out.customActualPrice;
    }
  }

  return out;
}

function sanitizeContextPreferenceEntry(raw, fallbackModelId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const isProductScope = raw.scope === 'product' || (typeof raw.productKey === 'string' && raw.productKey.trim()) || (typeof fallbackModelId === 'string' && fallbackModelId.startsWith('product:'));
  const rawModelId = isProductScope ? (raw.productKey || raw.modelId || fallbackModelId) : (raw.modelId || fallbackModelId);
  if (!rawModelId || typeof rawModelId !== 'string') return null;
  const stableKey = isProductScope
    ? rawModelId.trim().toLowerCase()
    : (resolveStableModelId(rawModelId) || rawModelId.trim().toLowerCase());
  if (!stableKey) return null;

  const modeRaw = String(raw.mode || 'default').trim().toLowerCase();
  if (modeRaw !== 'default' && modeRaw !== 'fixed' && modeRaw !== 'dynamic') {
    return null;
  }

  let limitTokens = null;
  if (modeRaw === 'default') {
    limitTokens = DEFAULT_CHECKPOINT_TOKENS;
  } else if (modeRaw === 'fixed') {
    const val = validateContextLimit(raw.limitTokens);
    if (!val.ok) return null;
    limitTokens = val.limitTokens;
  }

  const out = {
    modelId: stableKey,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : String(rawModelId).trim(),
    mode: modeRaw,
    limitTokens,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString()
  };
  if (isProductScope) {
    out.scope = 'product';
    out.productKey = stableKey;
  }
  return out;
}

function sanitizeContextPreferencesMap(rawMap) {
  const out = {};
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return out;
  for (const [k, v] of Object.entries(rawMap)) {
    const clean = sanitizeContextPreferenceEntry(v, k);
    if (clean) out[clean.modelId] = clean;
  }
  return out;
}

function loadCustomPlanSettings(overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const def = {
    version: '1.1.0',
    updatedAt: '',
    lastAccount: 'default',
    accounts: {},
    uiPreferences: {},
    contextPreferences: {},
    contextScopeMode: 'unified',
    contextUnifiedPreference: { mode: 'default', limitTokens: null }
  };
  try {
    if (!fs.existsSync(p)) return def;
    const content = fs.readFileSync(p, 'utf8');
    if (!content.trim()) return def;
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (parseErr) {
      // 配置文件损坏时自动隔离备份并恢复默认结构，防止崩溃
      try {
        const bakCorrupt = p.replace(/\.json$/i, '') + '.corrupt.bak.json';
        fs.copyFileSync(p, bakCorrupt);
      } catch {}
      return { ...def, recoveredFromCorruption: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...def, recoveredFromCorruption: true };
    }

    const accounts = {};
    // 兼容旧版直接平铺在顶层的配置结构
    if (!raw.accounts && (raw.region || raw.subscriptionRegion || raw.country || raw.currency || raw.actualPricePaid !== undefined)) {
      const legacyEntry = sanitizeAccountPlanEntry(raw, raw.email || raw.account || 'default');
      if (legacyEntry) {
        accounts[legacyEntry.account] = legacyEntry;
        accounts['default'] = { ...legacyEntry, account: 'default' };
      }
    } else if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [k, v] of Object.entries(raw.accounts)) {
        const cleanKey = String(k).trim().toLowerCase();
        const sanitized = sanitizeAccountPlanEntry(v, cleanKey);
        if (sanitized) accounts[cleanKey] = sanitized;
      }
    }

    const uiPreferences = (raw.uiPreferences && typeof raw.uiPreferences === 'object' && !Array.isArray(raw.uiPreferences))
      ? { ...raw.uiPreferences }
      : {};
    const contextPreferences = sanitizeContextPreferencesMap(raw.contextPreferences);

    // 默认使用统一模式，但升级时若已保存非默认模型偏好则保留分别模式，不覆盖用户选择
    let contextScopeMode = 'unified';
    if (raw.contextScopeMode === 'per_model' || raw.contextScopeMode === 'unified') {
      contextScopeMode = raw.contextScopeMode;
    } else if (Object.keys(contextPreferences).length > 0) {
      contextScopeMode = 'per_model';
    }

    const contextUnifiedPreference = raw.contextUnifiedPreference && typeof raw.contextUnifiedPreference === 'object'
      ? (sanitizeContextPreferenceEntry({ ...raw.contextUnifiedPreference, modelId: 'unified' }) || { mode: 'default', limitTokens: null })
      : { mode: 'default', limitTokens: null };

    return {
      version: raw.version || '1.1.0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      lastAccount: typeof raw.lastAccount === 'string' ? raw.lastAccount : 'default',
      accounts,
      uiPreferences,
      contextPreferences,
      contextScopeMode,
      contextUnifiedPreference
    };
  } catch {
    return def;
  }
}

function saveCustomPlanSettingsDetailed(settings, overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, settings, {
    validate: (data) => data && typeof data === 'object' && !Array.isArray(data)
  });
  if (!res.ok) {
    return { ok: false, error: res.error || '写入配置文件失败', phase: res.phase, path: p };
  }
  return { ok: true, path: p };
}

function saveCustomPlanSettings(settings, overridePathOrDir) {
  return saveCustomPlanSettingsDetailed(settings, overridePathOrDir).ok;
}

function setCustomPlanForAccount(accountKey, customData = {}, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  const merged = sanitizeAccountPlanEntry({
    ...(settings.accounts[key] || {}),
    ...customData,
    account: key,
    updatedAt: new Date().toISOString()
  }, key);
  if (!merged) return false;
  settings.accounts[key] = merged;
  // 同步 default 槽位与最近活跃账号，供启动早期尚未取得邮箱时读取
  settings.accounts['default'] = {
    ...(settings.accounts['default'] || {}),
    ...merged,
    account: 'default'
  };
  if (key !== 'default') settings.lastAccount = key;
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function clearCustomPlanForAccount(accountKey, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  delete settings.accounts[key];
  delete settings.accounts['default'];
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function resolveAccountCustomPlan(customSettingsAll, currentAccountKey) {
  if (!customSettingsAll || !customSettingsAll.accounts) return null;
  const accMap = customSettingsAll.accounts;
  if (currentAccountKey) {
    const k = String(currentAccountKey).trim().toLowerCase();
    if (accMap[k]) return accMap[k];
    // 账号隔离：明确指定了账号（非 default），但在配置中不存在该账号记录时，绝不回退到 default 或 lastAccount
    if (k !== 'default') return null;
  }
  // 仅在未指定账号（启动早期）或明确是 default 时，才允许检查 lastAccount 或 default
  if (!currentAccountKey || currentAccountKey === 'default') {
    if (customSettingsAll.lastAccount && accMap[customSettingsAll.lastAccount]) {
      return accMap[customSettingsAll.lastAccount];
    }
    if (accMap['default']) return accMap['default'];
  }
  return null;
}

function getPluginSettings(options = {}) {
  const targetDir = typeof options === 'string' ? options : options?.agDir;
  const settings = loadCustomPlanSettings(targetDir);
  const email = options?.email || cachedTokenHistory?.planStatus?.email || null;
  const customPlan = resolveAccountCustomPlan(settings, email);
  const uiPrefs = settings.uiPreferences || {};
  const contextPreferences = settings.contextPreferences || {};
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    contextPreferences,
    contextScopeMode: settings.contextScopeMode || 'unified',
    contextUnifiedPreference: settings.contextUnifiedPreference || { mode: 'default', limitTokens: null },
    savedHeatView: uiPrefs.savedHeatView,
    autoCheckUpdate: uiPrefs.autoCheckUpdate,
    panelLanguage: uiPrefs.panelLanguage || 'zh-CN',
    accounts: settings.accounts || {},
    updatedAt: settings.updatedAt || '',
    recoveredFromCorruption: Boolean(settings.recoveredFromCorruption)
  };
}

function savePluginSettings(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '无效的设置参数' };
  }
  const targetDir = typeof options === 'string' ? options : (options?.targetDir || options?.agDir || payload?.targetDir || payload?.agDir);
  const settings = loadCustomPlanSettings(targetDir);
  const rawKey = payload.account || payload.email || cachedTokenHistory?.planStatus?.email || settings.lastAccount || 'default';
  const key = String(rawKey).trim().toLowerCase() || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[key];
    if (key === 'default' || settings.lastAccount === key) {
      delete settings.accounts['default'];
      settings.lastAccount = 'default';
    }
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    // 账号隔离约束：新账号独立初始化，禁止从默认配置继承以避免跨账号数据污染
    const prev = settings.accounts[key] || {};
    const inputPlan = payload.customPlan;
    const mergedRaw = {
      ...prev,
      ...inputPlan,
      account: key,
      updatedAt: new Date().toISOString()
    };

    // 兼容层双向同步：若更新了兼容字段（如 currency），同步更新规范字段，防止被 prev 中的旧规范字段覆盖
    if (inputPlan.currency && !inputPlan.subscriptionCurrency) {
      mergedRaw.subscriptionCurrency = inputPlan.currency;
    }
    if (inputPlan.subscriptionCurrency && !inputPlan.currency) {
      mergedRaw.currency = inputPlan.subscriptionCurrency;
    }
    if (inputPlan.country && !inputPlan.accountRegion) {
      mergedRaw.accountRegion = inputPlan.country;
    }
    if (inputPlan.accountRegion && !inputPlan.country) {
      mergedRaw.country = inputPlan.accountRegion;
    }
    if (inputPlan.subscriptionRegion && !inputPlan.subscriptionCountry) {
      mergedRaw.subscriptionCountry = inputPlan.subscriptionRegion;
    }
    if (inputPlan.subscriptionCountry && !inputPlan.subscriptionRegion) {
      mergedRaw.subscriptionRegion = inputPlan.subscriptionCountry;
      mergedRaw.region = inputPlan.subscriptionCountry;
    }

    // 传入 null 或空字符串时，从合并对象中删除对应字段
    if (inputPlan.country === null || inputPlan.country === '' || inputPlan.accountRegion === null || inputPlan.accountRegion === '') {
      delete mergedRaw.country;
      delete mergedRaw.accountRegion;
    }
    if (inputPlan.subscriptionRegion === null || inputPlan.subscriptionRegion === '' || inputPlan.subscriptionCountry === null || inputPlan.subscriptionCountry === '' || inputPlan.region === null || inputPlan.region === '') {
      delete mergedRaw.subscriptionRegion;
      delete mergedRaw.subscriptionCountry;
      delete mergedRaw.region;
    }
    if (inputPlan.currency === null || inputPlan.currency === '' || inputPlan.subscriptionCurrency === null || inputPlan.subscriptionCurrency === '') {
      delete mergedRaw.currency;
      delete mergedRaw.subscriptionCurrency;
      delete mergedRaw.currencySymbol;
    }

    const sanitized = sanitizeAccountPlanEntry(mergedRaw, key);
    if (!sanitized) {
      return { ok: false, error: '订阅设置格式无效' };
    }
    settings.accounts[key] = sanitized;
    if (key === 'default') {
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    } else {
      settings.lastAccount = key;
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    }
  }

  const topLevelUiPrefs = {};
  if (typeof payload.savedHeatView === 'string' && payload.savedHeatView) {
    topLevelUiPrefs.savedHeatView = payload.savedHeatView;
  }
  const validPanelLanguages = new Set(['zh-CN', 'zh-TW', 'en']);
  if (typeof payload.autoCheckUpdate === 'boolean') {
    topLevelUiPrefs.autoCheckUpdate = payload.autoCheckUpdate;
  }
  if (typeof payload.panelLanguage === 'string' && validPanelLanguages.has(payload.panelLanguage)) {
    topLevelUiPrefs.panelLanguage = payload.panelLanguage;
  }
  const incomingUiPrefs = (payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences))
    ? { ...payload.uiPreferences, ...topLevelUiPrefs }
    : (Object.keys(topLevelUiPrefs).length > 0 ? topLevelUiPrefs : null);

  if (incomingUiPrefs) {
    if (incomingUiPrefs.panelLanguage !== undefined && !validPanelLanguages.has(incomingUiPrefs.panelLanguage)) {
      delete incomingUiPrefs.panelLanguage;
    }
    const nextUi = {
      ...(settings.uiPreferences || {}),
      ...incomingUiPrefs,
      updatedAt: new Date().toISOString()
    };
    if (nextUi.restartVerification === null) {
      delete nextUi.restartVerification;
    }
    settings.uiPreferences = nextUi;
  }

  if (!settings.contextPreferences || typeof settings.contextPreferences !== 'object') {
    settings.contextPreferences = {};
  }

  if (Array.isArray(payload.clearContextPreferences)) {
    for (const rawKey of payload.clearContextPreferences) {
      if (typeof rawKey !== 'string' || !rawKey.trim()) continue;
      const kNorm = rawKey.trim().toLowerCase();
      delete settings.contextPreferences[kNorm];
      const resolvedK = resolveStableModelId(rawKey);
      if (resolvedK) delete settings.contextPreferences[resolvedK];
    }
  }

  if (payload.clearContextPreference === true) {
    const rawTargetModel = payload.productKey || payload.modelId || payload.contextPreference?.productKey || payload.contextPreference?.modelId;
    if (!rawTargetModel || typeof rawTargetModel !== 'string' || !rawTargetModel.trim()) {
      return { ok: false, error: '恢复模型默认偏好时缺少模型标识' };
    }
    const trimmed = rawTargetModel.trim().toLowerCase();
    delete settings.contextPreferences[trimmed];
    if (!trimmed.startsWith('product:')) {
      const stableKey = resolveStableModelId(rawTargetModel);
      if (stableKey) delete settings.contextPreferences[stableKey];
    }
  } else if (payload.contextPreference !== undefined) {
    const cp = payload.contextPreference;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
      return { ok: false, error: '无效的模型上下文偏好参数格式' };
    }
    const isProd = cp.scope === 'product' || (typeof cp.productKey === 'string' && cp.productKey.trim());
    const idField = isProd ? (cp.productKey || cp.modelId) : cp.modelId;
    if (!idField || typeof idField !== 'string' || !idField.trim()) {
      return { ok: false, error: '按模型保存偏好时必须提供模型标识' };
    }
    const modeRaw = String(cp.mode || 'default').trim().toLowerCase();
    if (modeRaw !== 'default' && modeRaw !== 'fixed' && modeRaw !== 'dynamic') {
      return { ok: false, error: `不支持的上下文偏好模式: ${cp.mode}` };
    }
    if (modeRaw === 'fixed') {
      const valCheck = validateContextLimit(cp.limitTokens);
      if (!valCheck.ok) {
        return { ok: false, error: valCheck.error };
      }
    }
    const sanitizedPref = sanitizeContextPreferenceEntry({
      ...cp,
      modelId: idField,
      mode: modeRaw,
      updatedAt: new Date().toISOString()
    });
    if (!sanitizedPref) {
      return { ok: false, error: '模型上下文偏好参数校验失败' };
    }
    if (Array.isArray(cp.clearLegacyKeys)) {
      for (const lk of cp.clearLegacyKeys) {
        if (typeof lk !== 'string' || !lk.trim()) continue;
        delete settings.contextPreferences[lk.trim().toLowerCase()];
        const rk = resolveStableModelId(lk);
        if (rk) delete settings.contextPreferences[rk];
      }
    }
    settings.contextPreferences[sanitizedPref.modelId] = sanitizedPref;
  }

  if (payload.contextScopeMode === 'unified' || payload.contextScopeMode === 'per_model') {
    settings.contextScopeMode = payload.contextScopeMode;
  }
  if (payload.contextUnifiedPreference !== undefined) {
    if (payload.contextUnifiedPreference === null) {
      delete settings.contextUnifiedPreference;
    } else if (typeof payload.contextUnifiedPreference === 'object') {
      const sanitizedUnified = sanitizeContextPreferenceEntry({
        ...payload.contextUnifiedPreference,
        modelId: 'unified',
        updatedAt: new Date().toISOString()
      });
      if (sanitizedUnified) {
        settings.contextUnifiedPreference = sanitizedUnified;
      }
    }
  }

  delete settings.recoveredFromCorruption;
  settings.updatedAt = new Date().toISOString();
  const writeRes = saveCustomPlanSettingsDetailed(settings, targetDir);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || '配置落盘失败' };
  }

  const activeCustom = resolveAccountCustomPlan(settings, key === 'default' ? null : key);
  const baseLive = cachedTokenHistory?.rawPlanStatus || cachedTokenHistory?.planStatus || null;
  const effectivePlanStatus = resolveEffectivePlanStatus(baseLive, activeCustom, {
    cachedLivePlan: baseLive,
    currentEmail: key === 'default' ? (baseLive?.email || null) : key
  });

  // 同步更新内存缓存与 v2 归档中的 planStatus，确保刷新或重启即刻一致
  if (!targetDir && cachedTokenHistory) {
    cachedTokenHistory.planStatus = effectivePlanStatus;
    cachedTokenHistory.customPlanSettings = activeCustom;
    cachedTokenHistory.uiPreferences = settings.uiPreferences;
  }
  let archiveSyncWarning = null;
  let archiveSynced = false;
  try {
    const home = process.env.USERPROFILE || os.homedir();
    const agDir = targetDir && !targetDir.endsWith('.json') ? targetDir : (process.env.AG_DIR || path.join(home, '.gemini', 'antigravity'));
    const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');
    if (fs.existsSync(archivePathV2)) {
      const readRes = safeReadJsonSync(archivePathV2, null);
      if (readRes.ok && readRes.data && typeof readRes.data === 'object') {
        const v2Raw = { ...readRes.data };
        v2Raw.planStatus = effectivePlanStatus;
        v2Raw.customPlanSettings = activeCustom;
        const writeArch = safeWriteJsonSync(archivePathV2, v2Raw);
        if (!writeArch.ok) {
          archiveSyncWarning = writeArch.error || '写入 v2 归档文件失败';
        } else {
          archiveSynced = true;
        }
      } else if (readRes.corrupted) {
        archiveSyncWarning = 'v2 归档文件内容已损坏，已阻止回写覆盖以保护原始数据';
      }
    }
  } catch (err) {
    archiveSyncWarning = err?.message || '同步派生归档时发生未知异常';
  }

  return {
    ok: true,
    partial: archiveSyncWarning !== null,
    warning: archiveSyncWarning ? `主配置已保存，但派生归档同步失败: ${archiveSyncWarning}` : undefined,
    archiveSynced,
    path: writeRes.path,
    savedAt: settings.updatedAt,
    customPlan: activeCustom,
    planStatus: effectivePlanStatus,
    uiPreferences: settings.uiPreferences,
    contextPreferences: settings.contextPreferences || {},
    contextScopeMode: settings.contextScopeMode || 'unified',
    contextUnifiedPreference: settings.contextUnifiedPreference || null
  };
}

let cachedHostUserStatus = null;
let cachedHostUserStatusAt = 0;

async function fetchUserStatusFromHost(options = {}) {
  if (options && options.userStatus !== undefined) {
    if (!options.userStatus) return null;
    const parsed = parseUserPlanStatus(options.userStatus);
    const configs = options.userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || options.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = options.availableModels ? parseAvailableModelsResponse(options.availableModels) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    return parsed;
  }
  if (!options.agDir && !options.force && cachedHostUserStatus && Date.now() - cachedHostUserStatusAt < 60000) {
    return cachedHostUserStatus;
  }
  try {
    const { connect } = require('./local-api');
    const api = await connect();
    const [res, availRes] = await Promise.all([
      api.call('GetUserStatus', {}),
      api.call('GetAvailableModels', { forceRefresh: false }).catch(() => null)
    ]);
    const parsed = parseUserPlanStatus(res);
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = availRes ? parseAvailableModelsResponse(availRes) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    if (parsed && !options.agDir) {
      cachedHostUserStatus = parsed;
      cachedHostUserStatusAt = Date.now();
    }
    return parsed;
  } catch {
    return cachedHostUserStatus || null;
  }
}

let activeScanPromise = null;
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

async function collectTokenHistoryAsync(options = {}) {
  if (!options.force && !options.agDir && cachedTokenHistory && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  if (!options.agDir && activeScanPromise) {
    return activeScanPromise;
  }

  const thisScanSeq = ++currentScanSequence;
  const runner = (async () => {
    const home = process.env.USERPROFILE || os.homedir();
  const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');

  const brainDir = path.join(agDir, 'brain');
  const convDir = path.join(agDir, 'conversations');
  const archivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');

  // 1. 读取旧 v1 归档（并在首次迁移时自动生成 .bak 备份）
  const bakPathV1 = path.join(agDir, 'token_usage_archive_v1.bak.json');
  const readV1 = safeReadJsonSync(archivePathV1, null, { backupPath: bakPathV1 });
  let legacyV1Archive = { firstUseDate: null, dailyMap: {}, maxConversations: 0 };
  if (readV1.exists) {
    if (readV1.ok && readV1.data && typeof readV1.data === 'object') {
      legacyV1Archive = readV1.data;
      if (!fs.existsSync(bakPathV1)) {
        try { fs.copyFileSync(archivePathV1, bakPathV1); } catch {}
      }
    }
  }

  // 2. 读取已有的 v2 归档
  const bakPathV2 = path.join(agDir, 'token_usage_archive_v2.bak.json');
  const readV2 = safeReadJsonSync(archivePathV2, null, { backupPath: bakPathV2 });
  let archiveV2 = {
    version: '2.0.0',
    firstUseDate: legacyV1Archive.firstUseDate || null,
    planStatus: null,
    dailyMapBySource: {
      desktop: {},
      cli: {},
      legacyUnallocated: legacyV1Archive.dailyMap || {}
    }
  };
  if (readV2.exists) {
    if (readV2.ok && readV2.data && typeof readV2.data === 'object') {
      archiveV2 = { ...archiveV2, ...readV2.data };
      if (!fs.existsSync(bakPathV2)) {
        try { fs.copyFileSync(archivePathV2, bakPathV2); } catch {}
      }
    }
  }

  let earliestDate = archiveV2.firstUseDate || legacyV1Archive.firstUseDate || null;
  const registerDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
    }
  };

  // 3. 扫描桌面端与 CLI 会话文件（忽略 -wal/-shm/-journal 等伴生文件）
  let desktopPbCount = 0;
  let cliPbCount = 0;
  const scanSessionDir = (dir, isCli = false) => {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionOrTempFile(name)) continue;
        if (!name.endsWith('.pb') && !name.endsWith('.db')) continue;
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            count++;
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerDate(formatLocalDateKey(new Date(ts)));
          }
        } catch {}
      }
    } catch {}
    return count;
  };

  desktopPbCount = scanSessionDir(convDir, false);
  if (fs.existsSync(path.join(agCliDir, 'conversations'))) {
    cliPbCount = scanSessionDir(path.join(agCliDir, 'conversations'), true);
  }

  // 4. 双目录遍历扫描 transcript.jsonl（跳过 steps/scratch 重型目录，软链接与环路去重）
  const visitedRealDirs = new Set();
  const transcriptJobs = [];

  const walkTranscripts = (dir, sourceName, depth = 0) => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const normDir = path.resolve(dir);
      if (visitedRealDirs.has(normDir)) return;
      visitedRealDirs.add(normDir);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              if (!visitedRealDirs.has(realTarget)) {
                walkTranscripts(realTarget, sourceName, depth + 1);
              }
            } else if (entry.name === 'transcript.jsonl') {
              transcriptJobs.push({ path: realTarget, source: sourceName });
            }
          } catch {}
        } else if (entry.isDirectory()) {
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLogPath)) {
              transcriptJobs.push({ path: stdLogPath, source: sourceName });
              matchedFast = true;
            }
            if (fs.existsSync(directLogPath)) {
              transcriptJobs.push({ path: directLogPath, source: sourceName });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkTranscripts(fullPath, sourceName, depth + 1);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ path: fullPath, source: sourceName });
        }
      }
    } catch {}
  };

  walkTranscripts(brainDir, 'desktop');
  if (fs.existsSync(path.join(agCliDir, 'brain'))) {
    walkTranscripts(path.join(agCliDir, 'brain'), 'cli');
  }

  // 5. 结构化 JSON 解析 transcript.jsonl（基于 size+mtimeMs 单文件增量缓存，去重并汇总）
  const scannedBySource = {
    desktop: {},
    cli: {}
  };
  const seenEvents = new Set();
  const recentRequests = [];
  const newlyParsedPricedRequests = [];

  for (let jIdx = 0; jIdx < transcriptJobs.length; jIdx++) {
    const job = transcriptJobs[jIdx];
    if (jIdx > 0 && jIdx % 15 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const st = fs.statSync(job.path);
      const cachedFile = transcriptFileCache.get(job.path);
      let fileRecords = null;
      let isFreshlyParsed = false;

      if (cachedFile && cachedFile.size === st.size && cachedFile.mtimeMs === st.mtimeMs) {
        fileRecords = cachedFile.records;
      } else {
        isFreshlyParsed = true;
        fileRecords = [];
        const content = fs.readFileSync(job.path, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          let dateKey = null;
          if (event.created_at) {
            const d = new Date(event.created_at);
            if (!Number.isNaN(d.getTime())) {
              dateKey = formatLocalDateKey(d);
            }
          }

          let inp = 0, outp = 0, cap = 0, thinking = 0;
          let model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || '';

          if (event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null) {
            inp = Number(event.input_tokens || 0);
            outp = Number(event.output_tokens || 0);
            cap = Number(event.cache_read_tokens || 0);
            thinking = Number(event.thinking_output_tokens || 0);
          } else if (event.chatModel?.usage) {
            const u = event.chatModel.usage;
            inp = Number(u.inputTokens || 0);
            outp = Number(u.outputTokens || 0);
            cap = Number(u.cacheReadTokens || 0);
            thinking = Number(u.thinkingOutputTokens || 0);
          }

          const tot = inp + outp + cap;
          if (tot > 0 && dateKey) {
            const eventId = event.callId || event.responseId || event.chatModel?.usage?.responseId || `${job.path}#${event.step_index ?? i}`;
            const modelKey = normalizeModelId(model);
            const reqObj = {
              callId: eventId,
              source: job.source,
              cascadeId: event.cascadeId || path.basename(job.path, '.jsonl'),
              model,
              modelKey,
              inputTokens: inp,
              cacheTokens: cap,
              cacheReadTokens: cap,
              outputTokens: outp,
              thinkingTokens: thinking,
              totalTokens: tot,
              status: 'final',
              isEstimated: false,
              date: dateKey,
              created_at: event.created_at || null,
              timestamp: event.created_at ? new Date(event.created_at).getTime() : Date.now()
            };
            const costCalc = calculateRequestApiCost(reqObj);
            reqObj.isPriced = costCalc.isPriced;
            reqObj.costUSD = costCalc.costUSD ?? 0;

            fileRecords.push({
              eventId,
              dateKey,
              inp,
              outp,
              cap,
              tot,
              reqObj
            });
          } else if (dateKey) {
            fileRecords.push({ dateKey, tot: 0 });
          }
        }
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        if (rec.dateKey) registerDate(rec.dateKey);
        if (!rec.tot || !rec.eventId) continue;
        if (seenEvents.has(rec.eventId)) continue;
        seenEvents.add(rec.eventId);

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[rec.dateKey]) {
          srcMap[rec.dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[rec.dateKey].total += rec.tot;
        srcMap[rec.dateKey].input += rec.inp;
        srcMap[rec.dateKey].output += rec.outp;
        srcMap[rec.dateKey].cache += rec.cap;
        srcMap[rec.dateKey].steps += 1;

        recentRequests.push(rec.reqObj);
        if (isFreshlyParsed && rec.reqObj.isPriced && rec.reqObj.callId) {
          newlyParsedPricedRequests.push(rec.reqObj);
        }
      }
    } catch {}
  }

  // 6. 与旧归档做差异合并，防止简单相加或 Math.max 抹杀 CLI 增量
  // 规则：若 (desktop + cli) < legacyV1，则把差额保留为 legacyUnallocated；否则认为已被新日志完全覆盖
  const legacyDaily = legacyV1Archive.dailyMap || {};
  const mergedDesktop = { ...(archiveV2.dailyMapBySource?.desktop || {}), ...scannedBySource.desktop };
  const mergedCli = { ...(archiveV2.dailyMapBySource?.cli || {}), ...scannedBySource.cli };
  const mergedLegacyUnallocated = {};

  const allDateKeys = new Set([
    ...Object.keys(legacyDaily),
    ...Object.keys(mergedDesktop),
    ...Object.keys(mergedCli)
  ]);

  const dailyMapAll = {};
  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    registerDate(k);
    const dRec = mergedDesktop[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const cRec = mergedCli[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const lRec = legacyDaily[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };

    const scannedSum = (dRec.total || 0) + (cRec.total || 0);
    let unallocatedDiff = Math.max(0, (lRec.total || 0) - scannedSum);

    if (unallocatedDiff > 0) {
      mergedLegacyUnallocated[k] = {
        total: unallocatedDiff,
        input: Math.max(0, (lRec.input || 0) - (dRec.input || 0) - (cRec.input || 0)),
        output: Math.max(0, (lRec.output || 0) - (dRec.output || 0) - (cRec.output || 0)),
        cache: Math.max(0, (lRec.cache || 0) - (dRec.cache || 0) - (cRec.cache || 0)),
        steps: Math.max(0, (lRec.steps || 0) - (dRec.steps || 0) - (cRec.steps || 0))
      };
    }

    const unRec = mergedLegacyUnallocated[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    dailyMapAll[k] = {
      total: (dRec.total || 0) + (cRec.total || 0) + (unRec.total || 0),
      input: (dRec.input || 0) + (cRec.input || 0) + (unRec.input || 0),
      output: (dRec.output || 0) + (cRec.output || 0) + (unRec.output || 0),
      cache: (dRec.cache || 0) + (cRec.cache || 0) + (unRec.cache || 0),
      steps: (dRec.steps || 0) + (cRec.steps || 0) + (unRec.steps || 0)
    };
  }

  // 7. 计算各项聚合统计指标
  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!earliestDate) earliestDate = todayKey;

  let grandTotalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheTokens = 0, totalSteps = 0;
  let todayTokens = 0, monthTokens = 0, yearTokens = 0;

  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (!v) continue;
    grandTotalTokens += v.total || 0;
    totalInputTokens += v.input || 0;
    totalOutputTokens += v.output || 0;
    totalCacheTokens += v.cache || 0;
    totalSteps += v.steps || 0;
    if (k === todayKey) todayTokens += v.total || 0;
    if (k.startsWith(monthPrefix)) monthTokens += v.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += v.total || 0;
  }

  // 计算本期（本月自然月）分类汇总与步骤数
  let currentMonthInput = 0, currentMonthOutput = 0, currentMonthCache = 0, currentMonthSteps = 0;
  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (k.startsWith(monthPrefix) && v) {
      currentMonthInput += v.input || 0;
      currentMonthOutput += v.output || 0;
      currentMonthCache += v.cache || 0;
      currentMonthSteps += v.steps || 0;
    }
  }

  const totalConversations = Math.max(
    legacyV1Archive.maxConversations || 0,
    transcriptJobs.length,
    desktopPbCount + cliPbCount
  );

  // 8. 自动识别套餐与用户自定义设置合并（实际读取优先于自定义优先于未知）
  let livePlanStatus = await fetchUserStatusFromHost(options);
  if (!livePlanStatus) {
    livePlanStatus = archiveV2.planStatus || parseUserPlanStatus(null);
  }

  const customSettingsAll = loadCustomPlanSettings(agDir);
  const currentAccountKey = livePlanStatus?.email || archiveV2.planStatus?.email || null;
  const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);

  const effectivePlanStatus = resolveEffectivePlanStatus(livePlanStatus, currentCustom, {
    cachedLivePlan: archiveV2.planStatus,
    currentEmail: currentAccountKey
  });

  // 结合持久化逐请求账本与本次新解析的调用
  const ledger = loadPricingLedger(agDir);
  if (newlyParsedPricedRequests.length) {
    recordModelCalls(newlyParsedPricedRequests, { agDir });
  }
  const mergedCalls = Object.values(loadPricingLedger(agDir).calls || {});

  // 分来源与全量动态统计未计价请求与原因
  const desktopRecentUnpriced = recentRequests.filter(r => r.source === 'desktop' && !r.isPriced);
  const cliRecentUnpriced = recentRequests.filter(r => r.source === 'cli' && !r.isPriced);
  const unallocatedLegacyCount = Object.values(mergedLegacyUnallocated).reduce((sum, item) => sum + (item.steps || 0), 0);
  const unallocatedLegacyTokens = Object.values(mergedLegacyUnallocated).reduce((sum, item) => sum + (item.total || 0), 0);

  function aggregateUnpriced(items, extraCount = 0, extraTokens = 0) {
    const reasons = { missingModel: extraCount, unsupportedModel: 0, missingUsage: 0 };
    let tokens = extraTokens;
    for (const it of items) {
      tokens += (it.inputTokens + it.cacheTokens + it.outputTokens);
      if (!it.model) reasons.missingModel++;
      else if ((it.inputTokens + it.cacheTokens + it.outputTokens) === 0) reasons.missingUsage++;
      else reasons.unsupportedModel++;
    }
    return { count: items.length + extraCount, tokens, reasons };
  }

  const deskUnpriced = aggregateUnpriced(desktopRecentUnpriced, unallocatedLegacyCount, unallocatedLegacyTokens);
  const cliUnpriced = aggregateUnpriced(cliRecentUnpriced, 0, 0);

  const totalUnpricedCount = deskUnpriced.count + cliUnpriced.count;
  const totalUnpricedTokens = deskUnpriced.tokens + cliUnpriced.tokens;
  const totalUnpricedReasons = {
    missingModel: deskUnpriced.reasons.missingModel + cliUnpriced.reasons.missingModel,
    unsupportedModel: deskUnpriced.reasons.unsupportedModel + cliUnpriced.reasons.unsupportedModel,
    missingUsage: deskUnpriced.reasons.missingUsage + cliUnpriced.reasons.missingUsage
  };

  const costEstimateAll = summarizeApiCost(mergedCalls, totalUnpricedCount, totalUnpricedReasons, totalUnpricedTokens);
  const costEstimateDesktop = summarizeApiCost(mergedCalls.filter(c => c.source === 'desktop'), deskUnpriced.count, deskUnpriced.reasons, deskUnpriced.tokens);
  const costEstimateCli = summarizeApiCost(mergedCalls.filter(c => c.source === 'cli'), cliUnpriced.count, cliUnpriced.reasons, cliUnpriced.tokens);

  // 本期 (本月自然月) 账本过滤与计价分析
  const currentMonthCalls = mergedCalls.filter(c => c.date && String(c.date).startsWith(monthPrefix));
  const currentMonthPricedCalls = currentMonthCalls.filter(c => c.isPriced);
  const currentMonthPricedTokens = currentMonthPricedCalls.reduce((sum, c) => sum + (c.totalTokens || 0), 0);
  const currentMonthUnpricedCount = Math.max(0, currentMonthSteps - currentMonthPricedCalls.length);
  const currentMonthUnpricedTokens = Math.max(0, monthTokens - currentMonthPricedTokens);
  const costEstimateCurrentMonth = summarizeApiCost(
    currentMonthCalls,
    currentMonthUnpricedCount,
    { missingModel: currentMonthUnpricedCount },
    currentMonthUnpricedTokens
  );

  // 9. 参考模型折算（官方标准价格表 2026-11-08）
  const referenceCostAll = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostCurrentMonth = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostHybrid = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateAll.byCategory,
      costUSD: costEstimateAll.pricedCostUSD
    }
  });

  const referenceCostCurrentMonthHybrid = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateCurrentMonth.byCategory,
      costUSD: costEstimateCurrentMonth.pricedCostUSD
    }
  });

  const costEstimate = costEstimateAll;

  const speedRecords = mergedCalls
    .filter(c => isValidSpeedSample(c))
    .map(c => ({
      callId: c.callId,
      model: c.model,
      modelExactId: c.modelExactId || resolveStableModelId(c, livePlanStatus?.cascadeModelConfigs || []) || null,
      modelLabel: c.modelLabel || c.model || null,
      effort: c.effort || null,
      inputTokens: c.inputTokens,
      cacheReadTokens: c.cacheReadTokens ?? c.cacheTokens ?? 0,
      outputTokens: c.outputTokens,
      ttftSec: c.ttftSec ?? null,
      streamingSec: c.streamingSec ?? null,
      durationSec: c.durationSec,
      tps: c.tps ?? null,
      origin: c.origin === 'speed-test' ? 'speed-test' : 'chat',
      status: c.status,
      isEstimated: Boolean(c.isEstimated),
      date: c.date || null,
      created_at: c.created_at || null,
      timestamp: getCallSortTimestamp(c) || null
    }));

  const compactModelConfigs = Array.isArray(livePlanStatus?.cascadeModelConfigs)
    ? livePlanStatus.cascadeModelConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
    : [];

  const out = {
    schemaVersion: '0.8.3',
    version: '0.8.3',
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
    speedRecords,
    cascadeModelConfigs: compactModelConfigs,
    modelCapabilitiesById: livePlanStatus?.availableModelDetails || null,
    currentPeriod: {
      key: monthPrefix,
      label: `${monthPrefix} (自然月)`,
      isCurrentMonth: true
    },
    sources: {
      desktop: {
        conversationsCount: desktopPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'desktop').length
      },
      cli: {
        dirExists: fs.existsSync(agCliDir),
        conversationsCount: cliPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'cli').length
      }
    },
    planStatus: effectivePlanStatus,
    rawPlanStatus: livePlanStatus,
    customPlanSettings: currentCustom,
    uiPreferences: customSettingsAll.uiPreferences || {},
    costEstimate,
    costEstimateCurrentMonth,
    costEstimateBySource: {
      all: costEstimateAll,
      desktop: costEstimateDesktop,
      cli: costEstimateCli
    },
    referenceCost: {
      all: referenceCostAll,
      currentMonth: referenceCostCurrentMonth,
      hybrid: referenceCostHybrid,
      currentMonthHybrid: referenceCostCurrentMonthHybrid
    },
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      totalSteps,
      totalConversations,
      firstUseDate: earliestDate,
      activeDaysCount: Object.keys(dailyMapAll).length,
      costEstimate,
      costEstimateCurrentMonth,
      referenceCost: {
        all: referenceCostAll,
        currentMonth: referenceCostCurrentMonth,
        hybrid: referenceCostHybrid,
        currentMonthHybrid: referenceCostCurrentMonthHybrid
      }
    },
    dailyMap: dailyMapAll,
    dailyMapBySource: {
      all: dailyMapAll,
      desktop: mergedDesktop,
      cli: mergedCli,
      legacyUnallocated: mergedLegacyUnallocated
    }
  };

  // 检查是否已被后续强制并发采集超越：若已过时，放弃写盘与更新全局缓存
  if (!options.agDir && thisScanSeq !== currentScanSequence) {
    return out;
  }

  // 持久化保存到 v2 与 v1 归档（仅在数据变化或文件不存在时原子写入，减少高频磁盘 I/O）
  try {
    const archiveSig = `${agDir}|${earliestDate}|${totalConversations}|${grandTotalTokens}|${totalSteps}|${effectivePlanStatus?.tierKey || ''}|${effectivePlanStatus?.actualPricePaid ?? ''}|${effectivePlanStatus?.currency || ''}|${costEstimate?.pricedCostUSD ?? ''}`;
    const shouldWriteArchive = options.agDir || archiveSig !== collectTokenHistoryAsync._lastArchiveSig || !fs.existsSync(archivePathV2) || !fs.existsSync(archivePathV1);
    if (shouldWriteArchive) {
      collectTokenHistoryAsync._lastArchiveSig = archiveSig;
      const v2Payload = {
        version: '2.0.0',
        firstUseDate: earliestDate,
        updatedAt: out.updatedAt,
        maxConversations: totalConversations,
        planStatus: effectivePlanStatus,
        costEstimate,
        costEstimateCurrentMonth,
        referenceCost: out.referenceCost,
        dailyMapBySource: out.dailyMapBySource
      };
      safeWriteJsonSync(archivePathV2, v2Payload);

      // 同时写回 v1 格式以保持向下完全兼容
      const v1Payload = {
        firstUseDate: earliestDate,
        maxConversations: totalConversations,
        updatedAt: out.updatedAt,
        dailyMap: dailyMapAll
      };
      safeWriteJsonSync(archivePathV1, v1Payload);
    }
  } catch {}

  if (!options.agDir) {
    cachedTokenHistory = out;
    cachedTokenHistoryAt = Date.now();
  }
  return out;
  })();

  if (!options.agDir) {
    const tracked = runner.finally(() => {
      if (activeScanPromise === tracked) activeScanPromise = null;
    });
    activeScanPromise = tracked;
    return tracked;
  }
  return runner;
}

function collectTokenHistory(options = {}) {
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  if (!options.force && !options.agDir && cachedTokenHistory && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return cachedTokenHistory || {
    schemaVersion: '0.8.3',
    version: '0.8.3',
    loading: true,
    updatedAt: '',
    firstUseDate: null,
    planStatus: parseUserPlanStatus(null),
    costEstimate: { pricedCostUSD: 0, coveragePercent: 0, byModel: {} },
    summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0, activeDaysCount: 0 },
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {} }
  };
}

// ============================================================================
// 一键启动 CLI 模式已抽离至 meter-cli-launcher.js，当前文件保持完全兼容导出
// ============================================================================

// ============================================================================
// 在线更新模块 (GitHub Releases 探测、SHA-256 校验与零依赖热安装)
// ============================================================================

const OFFICIAL_REPO = 'elviscjn-cjn/antigravity-context-viewer';
const OFFICIAL_RELEASES_API = `https://api.github.com/repos/${OFFICIAL_REPO}/releases`;

let cachedUpdateCheck = null;
let cachedUpdateCheckAt = 0;
let isApplyingUpdate = false;

/**
 * 校验下载重定向地址是否属于受信任的 GitHub / 官方资产 CDN
 */
function isAllowedDownloadRedirectUrl(targetUrlStr) {
  try {
    const u = new URL(targetUrlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) return true;
    if (host === 'objects.githubusercontent.com' || host.endsWith('.githubusercontent.com')) return true;
    if (host.endsWith('.amazonaws.com') && host.includes('github-production-release-asset')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 严格校验资产下载地址是否归属于官方仓库发布路径
 */
function isOfficialAssetDownloadUrl(urlStr, filename) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return false;
    const expectedPrefix = `/${OFFICIAL_REPO}/releases/download/`;
    if (!u.pathname.startsWith(expectedPrefix)) return false;
    if (filename && !u.pathname.endsWith('/' + filename)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 区分 Node 与 Electron 运行环境，解析可用的 Node CLI 执行环境
 */
function resolveNodeRuntime() {
  const isElectron = Boolean(process.versions && process.versions.electron);
  if (isElectron) {
    return {
      runtime: process.execPath,
      args: [],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      isElectron: true
    };
  }
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return {
    runtime: process.execPath || 'node',
    args: [],
    env: cleanEnv,
    isElectron: false
  };
}

function requestGithubUrl(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const timeoutMs = options.timeout || 8000;
      const redirectCount = options.redirectCount || 0;
      const parsedUrl = new URL(rawUrl);
      const headers = Object.assign({
        'User-Agent': 'AntigravityContextMeter/0.8.3',
        'Accept': 'application/vnd.github.v3+json'
      }, options.headers || {});

      const proxyInfo = detectProxyConfig();
      if (proxyInfo && proxyInfo.enabled && proxyInfo.httpProxy) {
        try {
          const proxyUrl = new URL(proxyInfo.httpProxy);
          const http = require('http');
          const connectReq = http.request({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port) || 80,
            method: 'CONNECT',
            path: `${parsedUrl.hostname}:${parsedUrl.port || 443}`
          });
          connectReq.on('connect', (res, socket) => {
            if (res.statusCode === 200) {
              const httpsAgent = new https.Agent({ socket });
              doRequest(httpsAgent);
            } else {
              doRequest(undefined);
            }
          });
          connectReq.on('error', () => doRequest(undefined));
          connectReq.setTimeout(timeoutMs, () => {
            connectReq.destroy();
            doRequest(undefined);
          });
          connectReq.end();
          return;
        } catch {
          doRequest(undefined);
          return;
        }
      }

      doRequest(undefined);

      function doRequest(customAgent) {
        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers,
          agent: customAgent
        };

        const req = https.request(reqOpts, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextLocation = res.headers.location;
            if (redirectCount >= 5) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch {} }
              return reject(new Error('GitHub 请求重定向次数过多 (>5)'));
            }
            if (!isAllowedDownloadRedirectUrl(nextLocation)) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch {} }
              return reject(new Error(`下载重定向地址不受信任或协议不安全: ${nextLocation}`));
            }
            const nextOptions = Object.assign({}, options, { redirectCount: redirectCount + 1 });
            return requestGithubUrl(nextLocation, nextOptions).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            if (options.streamTo) { try { options.streamTo.destroy(); } catch {} }
            let errBody = '';
            res.on('data', c => errBody += c);
            res.on('end', () => reject(new Error(`GitHub API HTTP ${res.statusCode}: ${errBody.slice(0, 150)}`)));
            return;
          }
          if (options.streamTo) {
            res.pipe(options.streamTo);
            options.streamTo.on('finish', () => resolve());
            options.streamTo.on('error', reject);
            res.on('error', err => {
              try { options.streamTo.destroy(err); } catch {}
              reject(err);
            });
          } else {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          }
        });

        req.setTimeout(timeoutMs, () => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch {} }
          req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
        });
        req.on('error', err => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch {} }
          reject(err);
        });
        if (options.body) req.write(options.body);
        req.end();
      }
    } catch (e) {
      reject(e);
    }
  });
}

function getInstalledMeterVersion(options = {}) {
  try {
    if (options && options.installedVersion) return String(options.installedVersion);
    const { getStateDir, findAsarPath } = require('./asar-engine');
    const stateDir = getStateDir();

    let targetAsar = null;
    try {
      targetAsar = options.asarPath || findAsarPath(options.customPath || null);
    } catch {}

    const candidatePaths = [
      options && options.installationJsonPath,
      path.join(stateDir, 'installation.json'),
      path.join(__dirname, 'installation.json')
    ].filter(Boolean);

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (manifest && manifest.meterVersion) {
          // 严格核对清单中记录的安装目标是否与当前宿主目标一致
          if (targetAsar && manifest.installed) {
            try {
              const manifestTarget = path.resolve(manifest.installed).toLowerCase();
              const currentTarget = path.resolve(targetAsar).toLowerCase();
              if (manifestTarget !== currentTarget) {
                continue; // 属于其他宿主路径的陈旧记录，严禁采信
              }
            } catch {
              continue;
            }
          }
          if (manifest.installed && !fs.existsSync(manifest.installed)) {
            continue; // 记录的物理文件已不存在，属于失效记录
          }
          return String(manifest.meterVersion);
        }
      }
    }
  } catch {}
  return null;
}

async function checkUpdateAsync(options = {}) {
  const runtimeVersion = options.currentVersion || '0.8.3';
  const diskVersion = getInstalledMeterVersion(options);
  const effectiveCurrentVersion = (diskVersion && compareVersions(diskVersion, runtimeVersion) > 0)
    ? diskVersion
    : runtimeVersion;
  const installedVersion = diskVersion || runtimeVersion;

  const now = Date.now();
  const cacheTtl = 6 * 3600 * 1000;
  if (!options.force && cachedUpdateCheck && (now - cachedUpdateCheckAt < cacheTtl)) {
    // 若当前运行时版本与缓存中的运行时版本不一致（例如重启后运行版本对齐），缓存立即失效
    if (cachedUpdateCheck.currentVersion && cachedUpdateCheck.currentVersion !== runtimeVersion) {
      cachedUpdateCheck = null;
      cachedUpdateCheckAt = 0;
    } else if (cachedUpdateCheck.hasUpdate && cachedUpdateCheck.latestVersion) {
      // 若当前磁盘或生效版本已追平或超越缓存的最新发布版本，该缓存必须即刻失效
      if (compareVersions(effectiveCurrentVersion, cachedUpdateCheck.latestVersion) >= 0) {
        cachedUpdateCheck = null;
        cachedUpdateCheckAt = 0;
      } else {
        return cachedUpdateCheck;
      }
    } else {
      return cachedUpdateCheck;
    }
  }

  const releasesApiUrl = OFFICIAL_RELEASES_API;
  try {
    const fetcher = options._requestGithubUrl || requestGithubUrl;
    const rawData = await fetcher(releasesApiUrl, { timeout: 8000 });
    const releasesList = JSON.parse(rawData);
    const valid = filterReleases(releasesList, effectiveCurrentVersion);
    if (valid.length > 0) {
      const latest = valid[0];
      const bodyLines = (latest.body || '').split(/\r?\n/).slice(0, 8).join('\n');
      cachedUpdateCheck = {
        ok: true,
        hasUpdate: true,
        currentVersion: runtimeVersion,
        installedVersion,
        latestVersion: latest.version,
        tagName: latest.tagName,
        releaseNotes: bodyLines,
        htmlUrl: latest.htmlUrl,
        publishedAt: latest.publishedAt,
        assets: latest.assets
      };
      cachedUpdateCheckAt = now;
      return cachedUpdateCheck;
    }
    cachedUpdateCheck = {
      ok: true,
      hasUpdate: false,
      currentVersion: runtimeVersion,
      installedVersion,
      latestVersion: effectiveCurrentVersion,
      diskPendingRestart: compareVersions(installedVersion, runtimeVersion) > 0
    };
    cachedUpdateCheckAt = now;
    return cachedUpdateCheck;
  } catch (err) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion: runtimeVersion,
      installedVersion,
      error: err.message
    };
  }
}

function safeCloseStream(stream) {
  return new Promise(resolve => {
    if (!stream || stream.destroyed || stream.closed) {
      return setImmediate(resolve);
    }
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const timer = setTimeout(done, 1500);
    stream.once('close', () => { clearTimeout(timer); done(); });
    stream.once('error', () => { clearTimeout(timer); done(); });
    try {
      stream.destroy();
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

async function applyUpdateAsync(options = {}) {
  if (isApplyingUpdate) {
    return { ok: false, error: '更新任务正在执行中，请勿重复操作' };
  }
  isApplyingUpdate = true;

  const currentVersion = options.currentVersion || '0.8.3';
  let tmpDir = null;
  let checksumStream = null;
  let zipStream = null;

  try {
    // 渲染层仅传版本标识，不传递外部资产 URL 或下载地址
    const requestedVersion = typeof options === 'string'
      ? options
      : (options?.version || options?.release?.latestVersion || null);

    const fetcher = options._requestGithubUrl || requestGithubUrl;
    let rawReleases;
    try {
      rawReleases = await fetcher(OFFICIAL_RELEASES_API, { timeout: 10000 });
    } catch (e) {
      return { ok: false, error: `查询官方发布信息失败: ${e.message}`, htmlUrl: `https://github.com/${OFFICIAL_REPO}/releases` };
    }

    let releasesList;
    try {
      releasesList = typeof rawReleases === 'string' ? JSON.parse(rawReleases) : rawReleases;
    } catch (e) {
      return { ok: false, error: '解析官方发布信息失败', htmlUrl: `https://github.com/${OFFICIAL_REPO}/releases` };
    }

    const validReleases = filterReleases(releasesList, currentVersion);
    if (!validReleases || validReleases.length === 0) {
      return { ok: false, error: '未获取到可用的官方发布版本', htmlUrl: `https://github.com/${OFFICIAL_REPO}/releases` };
    }

    let targetRelease = null;
    if (requestedVersion) {
      targetRelease = validReleases.find(r => r.version === requestedVersion || r.tagName === requestedVersion || r.tagName === `v${requestedVersion}`);
      if (!targetRelease) {
        return { ok: false, error: `未在官方仓库中找到版本 ${requestedVersion}`, htmlUrl: `https://github.com/${OFFICIAL_REPO}/releases` };
      }
    } else {
      targetRelease = validReleases[0];
    }

    const { packageAsset, checksumAsset, targetOs, targetArch } = findReleaseAsset(targetRelease.assets, process.platform, process.arch);
    if (!packageAsset || !checksumAsset) {
      return {
        ok: false,
        error: '当前版本未提供对应系统架构资产或缺少 checksums.txt 校验文件，请前往发布页手动下载',
        htmlUrl: targetRelease.htmlUrl || `https://github.com/${OFFICIAL_REPO}/releases`
      };
    }

    // 严格验证资产文件名是否符合规范（对齐官方打包脚本，同时向下兼容带 v 前缀）
    if (checksumAsset.name !== 'checksums.txt') {
      return { ok: false, error: '校验资产文件名异常，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }
    const standardPackageName = `antigravity-context-viewer_${targetRelease.version}_${targetOs}_${targetArch}.zip`;
    const legacyPackageName = `antigravity-context-viewer_v${targetRelease.version}_${targetOs}_${targetArch}.zip`;
    if (packageAsset.name !== standardPackageName && packageAsset.name !== legacyPackageName) {
      return { ok: false, error: `安装包文件名 (${packageAsset.name}) 不符合官方命名规范 (${standardPackageName})，拒绝安装`, htmlUrl: targetRelease.htmlUrl };
    }

    // 严格验证下载地址的官方仓库归属
    if (!isOfficialAssetDownloadUrl(checksumAsset.browser_download_url, 'checksums.txt')) {
      return { ok: false, error: '校验文件下载地址不属于官方仓库，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }
    if (!isOfficialAssetDownloadUrl(packageAsset.browser_download_url, packageAsset.name)) {
      return { ok: false, error: '安装包下载地址不属于官方仓库，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }

    const crypto = require('crypto');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-update-'));
    const zipPath = path.join(tmpDir, packageAsset.name);
    const checksumPath = path.join(tmpDir, 'checksums.txt');
    const extractDir = path.join(tmpDir, 'extracted');

    checksumStream = fs.createWriteStream(checksumPath);
    checksumStream.on('error', () => {});
    await fetcher(checksumAsset.browser_download_url, { timeout: 15000, streamTo: checksumStream });

    zipStream = fs.createWriteStream(zipPath);
    zipStream.on('error', () => {});
    await fetcher(packageAsset.browser_download_url, { timeout: 60000, streamTo: zipStream });

    const checksumContent = fs.readFileSync(checksumPath, 'utf8');
    const lines = checksumContent.split(/\r?\n/);
    let expectedSha = null;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === packageAsset.name) {
        const candSha = parts[0].toLowerCase();
        if (/^[0-9a-f]{64}$/.test(candSha)) {
          expectedSha = candSha;
        }
        break;
      }
    }
    if (!expectedSha) {
      return { ok: false, error: 'checksums.txt 中未找到合法的 64 位 SHA-256 校验记录，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }

    const fileBuf = fs.readFileSync(zipPath);
    const actualSha = crypto.createHash('sha256').update(fileBuf).digest('hex').toLowerCase();
    if (actualSha !== expectedSha) {
      return { ok: false, error: `SHA-256 校验失败 (期望: ${expectedSha}, 实际: ${actualSha})，拒绝安装`, htmlUrl: targetRelease.htmlUrl };
    }

    fs.mkdirSync(extractDir, { recursive: true });
    let extractRes;
    if (typeof options._extractZip === 'function') {
      try {
        extractRes = await options._extractZip(zipPath, extractDir);
        if (extractRes === undefined) extractRes = { status: 0 };
      } catch (err) {
        extractRes = { status: 1, error: err };
      }
    } else if (process.platform === 'win32') {
      extractRes = spawnSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'ignore' });
    } else {
      extractRes = spawnSync('unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'ignore' });
    }
    if (extractRes && extractRes.status !== 0) {
      return { ok: false, error: '解压更新安装包失败，终止安装', htmlUrl: targetRelease.htmlUrl };
    }

    const cliPath = path.join(extractDir, 'cli.js');
    if (!fs.existsSync(cliPath)) {
      return { ok: false, error: '解压包中缺少 cli.js 安装入口', htmlUrl: targetRelease.htmlUrl };
    }

    const runtimeResolver = options._resolveNodeRuntime || resolveNodeRuntime;
    const runtimeInfo = runtimeResolver();
    const subArgs = [...runtimeInfo.args, cliPath, 'install'];

    // 检查是否存在已记录的自定义安装路径，确保更新子进程继续更新原目标
    let recordedInstalledPath = options.targetPath || null;
    if (!recordedInstalledPath) {
      try {
        const { getStateDir } = require('./asar-engine');
        const stateDir = getStateDir();
        const candidatePaths = [
          path.join(stateDir, 'installation.json'),
          path.join(__dirname, 'installation.json')
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            const manifestData = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (manifestData && manifestData.installed && typeof manifestData.installed === 'string') {
              recordedInstalledPath = manifestData.installed;
              break;
            }
          }
        }
      } catch {}
    }
    if (recordedInstalledPath && typeof recordedInstalledPath === 'string') {
      subArgs.push('--path', recordedInstalledPath);
    }

    const spawner = options._spawn || spawn;
    const execRes = await new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = options._timeoutMs || 45000;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child) {
          try { child.kill('SIGKILL'); } catch {}
          const closeGraceTimer = setTimeout(() => {
            reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
          }, 3000);
          child.once('close', () => {
            clearTimeout(closeGraceTimer);
            reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
          });
        } else {
          reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      try {
        child = spawner(runtimeInfo.runtime, subArgs, {
          cwd: extractDir,
          env: runtimeInfo.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ code, signal, stdout, stderr });
      });
    });

    if (execRes.code !== 0) {
      const detail = (execRes.stderr || execRes.stdout || `退出码 ${execRes.code}`).trim();
      return { ok: false, error: `热安装执行失败: ${detail}` };
    }

    cachedUpdateCheck = null;
    cachedUpdateCheckAt = 0;

    const liveInjected = execRes.stdout.includes('已即时生效（无需重启）') || execRes.stdout.includes('"liveInjected": true');
    const finalInstalledVer = getInstalledMeterVersion(options) || targetRelease.version;
    return {
      ok: true,
      diskInstalled: true,
      liveInjected: Boolean(liveInjected),
      version: targetRelease.version,
      installedVersion: finalInstalledVer
    };
  } catch (err) {
    return { ok: false, error: `更新安装异常: ${err.message}` };
  } finally {
    isApplyingUpdate = false;
    try {
      if (checksumStream) await safeCloseStream(checksumStream);
      if (zipStream) await safeCloseStream(zipStream);
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

module.exports = {
  sanitizeCascadeModelConfig,
  parseAvailableModelsResponse,
  extractObservedModelInfoFromSteps,
  mergeModelCapabilitiesIntoConfigs,
  fetchUserStatusFromHost,
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
  scanFiles,
  pythonScan,
  resolvePython,
  isCompanionOrTempFile,
  formatLocalDateKey,
  recordModelCalls,
  loadPricingLedger,
  savePricingLedger,
  getPricingLedgerPath,
  isSyntheticCall,
  quarantineSyntheticCalls,
  getCustomPlanPath,
  sanitizeAccountPlanEntry,
  loadCustomPlanSettings,
  saveCustomPlanSettings,
  saveCustomPlanSettingsDetailed,
  setCustomPlanForAccount,
  clearCustomPlanForAccount,
  resolveAccountCustomPlan,
  getPluginSettings,
  savePluginSettings,
  sanitizeContextPreferenceEntry,
  resolveCliExecutable,
  resolveCliWorkspace,
  buildCliProxyEnv,
  launchCliSession,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  checkUpdateAsync,
  applyUpdateAsync,
  requestGithubUrl,
  isAllowedDownloadRedirectUrl,
  isOfficialAssetDownloadUrl,
  resolveNodeRuntime,
  OFFICIAL_REPO,
  getContextUnlockStatus,
  applyContextUnlock,
  restoreContextUnlock,
  CONTEXT_UNLOCK_AUTHOR
};
