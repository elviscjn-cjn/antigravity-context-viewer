'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { normalizeLoopbackOrigin } = require('./local-api');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const origDateNow = Date.now;
const origFsMethods = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  copyFileSync: fs.copyFileSync,
  renameSync: fs.renameSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  existsSync: fs.existsSync
};
const { safeWriteJsonSync, safeReadJsonSync, withFileLockSync, withFileLockAsync } = require('./meter-storage');
const {
  buildCliProxyEnv,
  detectProxyConfig,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  redactProxyUrl,
  openSocks5Tunnel,
  openHttpConnectTunnel,
  classifyRequestTimeoutPhase,
  sanitizeDiagnosticErrorText
} = require('./meter-proxy');
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
  applyUnlockAsync: applyContextUnlockAsync,
  restoreUnlock: restoreContextUnlock,
  restoreUnlockAsync: restoreContextUnlockAsync,
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
  buildModelQuotaSnapshot,
  isDecorativeBadgeTagTitle,
  getModelPoolKey,
  getSharedQuotaGroupKey,
  extractCallId,
  parseGeneratorCall,
  extractModelString,
  normalizeModelId,
  resolveStableModelId,
  UNATTRIBUTED_MODEL_KEY,
  resolveModelUsageBucket,
  computeCacheReadStats,
  summarizeCacheReadStats,
  summarizeDailyMapCacheStats,
  normalizeSessionCallRecord,
  sanitizeTurnPreviewText,
  groupSessionCallsByTurns,
  isValidSpeedSample,
  MAX_SPEED_SAMPLES_PER_MODEL,
  calculateRequestApiCost,
  filterReleases,
  findReleaseAsset,
  compareVersions
} = require('./meter-core');
const { PROJECT_VERSION } = require('./modules-config');

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
    } catch { }
  }
  for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    try {
      const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (check.status === 0 && check.stdout.trim()) {
        cachedPython = check.stdout.trim().split(/\r?\n/)[0];
        return cachedPython;
      }
    } catch { }
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
  const isTagUnavailable = /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
  const isDecoTag = isDecorativeBadgeTagTitle(tagTitle);
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
  const rawReason = String(c.unavailabilityReason || c.disabledReason || c.reason || '').trim();
  const safeReason = (rawReason && !isDecorativeBadgeTagTitle(rawReason)) ? rawReason : null;
  const fallbackTagReason = isUnavail ? (tagDesc || (!isDecoTag && tagTitle ? tagTitle : null)) : null;
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
    disabled: c.disabled === true,
    allowedTiers: Array.isArray(c.allowedTiers) ? c.allowedTiers.slice() : undefined,
    unavailable: isUnavail,
    unavailabilityReason: safeReason || fallbackTagReason || null,
    notice: c.notice || c.clientNotice || c.warning || (!isUnavail && tagTitle && (!isDecoTag || tagDesc) ? `${tagTitle}${tagDesc ? `：${tagDesc}` : ''}` : null),
    isHistorical: isHist,
    releaseDate: c.releaseDate || null,
    family: c.family || null,
    effort: c.effort || null
  };
}

const FILES_CACHE_MAX_ENTRIES = 512;
const CONVERSATIONS_CACHE_MAX_ENTRIES = 32;
const filesCache = new Map();
const conversations = new Map();
const csrfTokenByOrigin = new Map();
let pythonQueue = Promise.resolve();

function setBoundedMap(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function request(origin, method, body, token, signal = null) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, {
      agent: false,
      rejectUnauthorized: false,
      method: method ? 'POST' : 'GET',
      headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {},
      ...(signal ? { signal } : {})
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 96 * 1024 * 1024) {
          req.destroy(new Error('本地响应过大，扫描不完整'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (signal?.aborted) {
          const err = new Error('请求已取消');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        const text = Buffer.concat(chunks).toString();
        if (response.statusCode !== 200) reject(new Error(`本机接口 HTTP ${response.statusCode}`));
        else { try { resolve(method ? JSON.parse(text) : text); } catch (e) { reject(e); } }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

function pythonScan(items, signal = null) {
  const task = pythonQueue.then(() => {
    if (signal?.aborted) return items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] }));
    return runPythonScan(items, signal);
  });
  pythonQueue = task.catch(() => { });
  return task;
}

function runPythonScan(items, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] })));
    const py = resolvePython();
    if (!py) return reject(new Error('本地 Python 解析环境不可用'));
    const source = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false, aborted = false;
    const completed = [];
    const onAbort = () => { aborted = true; try { child.kill(); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { output += chunk; let at; while ((at = output.indexOf('\n')) >= 0) { const line = output.slice(0, at).trim(); output = output.slice(at + 1); if (line) { try { completed.push(JSON.parse(line)); } catch { } } } }); child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); const reason = aborted ? '扫描已切换会话取消' : timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果'; const done = new Set(completed.map(v => v.key)); for (const item of items) if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] }); resolve(completed); });
    child.stdin.on('error', () => { }); child.stdin.end(JSON.stringify(items));
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
  } catch { }
  return { width: null, height: null };
}

function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, (w > 384 || h > 384) ? 1120 : 258)];
}

async function scanFiles(media, scanOptions = {}) {
  const signal = scanOptions?.signal || null;
  const results = new Map(), work = [];
  for (const item of media) {
    if (signal?.aborted) break;
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
      let target;
      let stat;
      try {
        target = await fs.promises.realpath(targetPath);
        stat = await fs.promises.stat(target);
      } catch (fsErr) {
        if (fsErr && (fsErr.code === 'ENOENT' || fsErr.code === 'ENOTDIR')) {
          throw new Error('附件文件不存在或已移动');
        }
        throw fsErr;
      }
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) {
        const hit = filesCache.get(key);
        setBoundedMap(filesCache, key, hit, FILES_CACHE_MAX_ENTRIES);
        results.set(item.uri, hit);
      } else {
        work.push({ key: item.uri, path: target, cacheKey: key });
      }
    } catch (e) { results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] }); }
  }
  if (work.length && !signal?.aborted) {
    try {
      const parsed = await pythonScan(work.map(({ key, path }) => ({ key, path })), signal);
      for (const result of parsed) {
        const job = work.find(w => w.key === result.key);
        if (job) {
          if (result && result.status !== 'unknown') {
            setBoundedMap(filesCache, job.cacheKey, result, FILES_CACHE_MAX_ENTRIES);
          }
          results.set(job.key, result);
        }
      }
    } catch (e) { for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] }); }
  }
  return media.map(item => ({ ...item, ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }), uri: undefined, key: undefined }));
}

let collectSeqCounter = 0;
const latestCollectSeqByOrigin = new Map();

async function resolveCollectCsrfToken(origin, signal, options = {}, isSuperseded = null) {
  let token = '';
  let hasConfig = false;
  let htmlFetchErr = null;
  try {
    const html = await request(origin, null, null, null, signal);
    if (typeof isSuperseded === 'function' && isSuperseded()) return '';
    const match = String(html || '').match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (match) {
      hasConfig = true;
      const parsed = JSON.parse(match[1]);
      token = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    htmlFetchErr = err;
  }

  const canFallback = !htmlFetchErr || /HTTP 40[13]\b/.test(String(htmlFetchErr.message || ''));
  if (!token && canFallback) {
    try {
      const { resolveOriginCsrfToken } = require('./local-api');
      const fallbackToken = resolveOriginCsrfToken(origin, options);
      if (fallbackToken) {
        token = fallbackToken;
        hasConfig = true;
      }
    } catch {}
  }

  if (!token && htmlFetchErr) throw htmlFetchErr;
  if (!hasConfig) throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
  if (!token) throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  return token;
}

async function collect(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  origin = safeOrigin;
  const key = `${origin}/${id}`;
  const supersede = options.supersedePrevious === true;
  const mySeq = supersede ? (++collectSeqCounter) : 0;
  const abortController = supersede ? new AbortController() : null;
  if (supersede) {
    const prevLatest = latestCollectSeqByOrigin.get(origin);
    if (prevLatest && prevLatest.id !== id && prevLatest.abortController) {
      try { prevLatest.abortController.abort(); } catch { }
    }
    latestCollectSeqByOrigin.set(origin, { seq: mySeq, id, abortController });
  }
  const isSuperseded = () => {
    if (!supersede) return false;
    const latest = latestCollectSeqByOrigin.get(origin);
    return Boolean((latest && latest.seq > mySeq && latest.id !== id) || abortController?.signal?.aborted);
  };
  const previous = conversations.get(key);
  if (previous?.pending) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;
  const task = (async () => {
    const signal = abortController?.signal || null;
    try {
      let token = !options.force ? csrfTokenByOrigin.get(origin) : null;
      if (!token) {
        token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        csrfTokenByOrigin.set(origin, token);
      }
      const call = async (method, body) => {
        try {
          return await request(origin, method, body, token, signal);
        } catch (err) {
          if (err && /HTTP 40[13]/.test(String(err.message || '')) && !signal?.aborted) {
            csrfTokenByOrigin.delete(origin);
            token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
            if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
            csrfTokenByOrigin.set(origin, token);
            return await request(origin, method, body, token, signal);
          }
          throw err;
        }
      };
      const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const trajectory = full.trajectory;
      if (!trajectory) throw new Error('未取得会话历史，无法完整统计');
      const wsPath = extractWorkspaceFromTrajectory(trajectory);
      if (wsPath) conversationWorkspaces.set(id.toLowerCase(), wsPath);
      const steps = trajectory.steps || [];
      const expected = Number(full.numTotalSteps ?? steps.length);
      while (steps.length < expected) {
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
        if (!page.steps?.length) throw new Error(`历史仅取得 ${steps.length}/${expected} 步，扫描未完成`);
        steps.push(...page.steps);
      }
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const session = analyzeSteps(steps);
      const stepCapabilities = extractObservedModelInfoFromSteps(steps);
      const attachments = await scanFiles(session.media, { signal });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const attachmentTotal = empty();
      for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
      const total = add({ ...session.total }, attachmentTotal);
      let latest = null;
      const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
      const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, count - 3), includeMessages: false });
      let cachedHostUserStatus = cachedUserStatusByOrigin.get(normalizeQuotaOriginScope({ origin }))?.status || null;
      let knownCascadeConfigs = Array.isArray(cachedHostUserStatus?.cascadeModelConfigs) ? cachedHostUserStatus.cascadeModelConfigs : [];
      const hasAnyCap = knownCascadeConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!knownCascadeConfigs.length || !hasAnyCap) {
        try {
          const freshStatus = await fetchUserStatusFromHost({ origin });
          if (freshStatus) cachedHostUserStatus = freshStatus;
          if (Array.isArray(freshStatus?.cascadeModelConfigs) && freshStatus.cascadeModelConfigs.length) {
            knownCascadeConfigs = freshStatus.cascadeModelConfigs;
          }
        } catch { }
      }
      const mergedCascadeConfigs = mergeModelCapabilitiesIntoConfigs(
        knownCascadeConfigs,
        cachedHostUserStatus?.availableModelDetails || null,
        stepCapabilities
      );
      let latestModel = null;
      let latestCallId = null;
      let latestCallRecord = null;
      const recentGeneratorCalls = [];
      for (const m of (tail.generatorMetadata || [])) {
        const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
        if (callMeta) {
          const normCall = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          if (normCall) recentGeneratorCalls.push(normCall);
        }
      }
      for (const m of (tail.generatorMetadata || []).slice().reverse()) {
        latest = summarize(m, { cascadeModelConfigs: mergedCascadeConfigs });
        if (latest) {
          latestModel = m.chatModel;
          const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
          latestCallId = callMeta?.callId || null;
          if (callMeta) {
            latestCallRecord = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          }
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
    const result = { version: PROJECT_VERSION, conversation: id, workspacePath: wsPath || null, latest, latestCallId, latestCallRecord, recentGeneratorCalls, generatorCount: count, cascadeModelConfigs: compactCascadeConfigs, modelCapabilitiesById, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
    if (isSuperseded()) {
      conversations.delete(key);
      return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
    }
    setBoundedMap(conversations, key, { result, at: Date.now() }, CONVERSATIONS_CACHE_MAX_ENTRIES);
    return result;
    } catch (err) {
      if (isSuperseded() || (err && err.name === 'AbortError' && signal?.aborted)) {
        return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      }
      throw err;
    }
  })();
  setBoundedMap(conversations, key, { ...previous, pending: task }, CONVERSATIONS_CACHE_MAX_ENTRIES);
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
const ledgerCacheByPath = new Map();

function normalizeLedgerKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

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

function createUnreadableLedger(filePath, error, isCorrupted = false, phase = 'unreadable_guard', code = undefined) {
  return {
    version: '1.0.0',
    updatedAt: '',
    calls: {},
    ...(isCorrupted ? { __corrupted: true } : {}),
    __unreadable: true,
    __guardPhase: phase,
    ...(code ? { __code: code } : {}),
    __corruptedPath: filePath,
    __error: error || '账本文件当前不可读'
  };
}

function quarantineSyntheticCalls(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const qPath = p.replace('pricing_ledger_v1.json', 'pricing_ledger_quarantine.json');

  try {
    const readRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (!readRes.exists || !readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
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
      const qRead = safeReadJsonSync(qPath, null, { fs: fsImpl });
      if (qRead.exists && qRead.ok && qRead.data && typeof qRead.data === 'object') {
        qData = qRead.data;
      }
      qData.calls = { ...qData.calls, ...quarantined };
      safeWriteJsonSync(qPath, qData, { fs: fsImpl });

      raw.calls = kept;
      raw.updatedAt = new Date().toISOString();
      const saveRes = safeWriteJsonSync(p, raw, { fs: fsImpl });
      if (saveRes.ok) {
        ledgerCacheByPath.delete(cacheKey);
      }
    }
    return { quarantinedCount: qCount };
  } catch {
    return { quarantinedCount: 0 };
  }
}

function loadPricingLedger(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const def = { version: '1.0.0', updatedAt: '', calls: {} };

  let st = null;
  try {
    st = fsImpl.statSync(p);
  } catch (statErr) {
    ledgerCacheByPath.delete(cacheKey);
    if (statErr && statErr.code === 'ENOENT') {
      return def;
    }
    return createUnreadableLedger(p, statErr?.message || '检查账本文件状态失败', false, 'unreadable_guard', statErr?.code);
  }

  if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
    ledgerCacheByPath.delete(cacheKey);
    const nonFileCode = (st && typeof st.isDirectory === 'function' && st.isDirectory()) ? 'EISDIR' : 'EINVAL';
    return createUnreadableLedger(p, '账本目标路径不是普通文件', false, 'unreadable_guard', nonFileCode);
  }

  if (!options?.fs) {
    const cached = ledgerCacheByPath.get(cacheKey);
    if (cached && !cached.ledger?.__corrupted && !cached.ledger?.__unreadable && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.ledger;
    }
  }

  const bakPath = p.replace(/\.json$/i, '') + '.bak.json';
  const readRes = safeReadJsonSync(p, null, {
    fs: fsImpl,
    backupPath: bakPath,
    quarantineCorrupt: !options?.readOnly,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });

  if (!readRes.exists) {
    ledgerCacheByPath.delete(cacheKey);
    // statSync 已确认文件存在，后续读取却返回 exists: false 时必须阻断写入，防止瞬态异常清空账本
    return createUnreadableLedger(p, readRes.error || '账本文件状态不一致（stat 存在但读取返回不存在）', false, 'unreadable_guard', readRes.code || 'ENOENT');
  }

  if (readRes.corrupted && !readRes.recoveredFromBackup) {
    ledgerCacheByPath.delete(cacheKey);
    // 文件存在但损坏且无备份可恢复，绝不能当作正常空数据覆盖
    return createUnreadableLedger(p, readRes.error, true, 'corrupted_guard', readRes.code);
  }

  if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
    ledgerCacheByPath.delete(cacheKey);
    return createUnreadableLedger(p, readRes.error || '读取账本文件失败', false, 'unreadable_guard', readRes.code);
  }

  const raw = readRes.data;
  const ledger = { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || '', calls: { ...(raw.calls || {}) } };
  let hasSynthetic = false;
  for (const [id, call] of Object.entries(ledger.calls)) {
    if (isSyntheticCall(id, call)) {
      hasSynthetic = true;
      break;
    }
  }
  if (hasSynthetic && !options?.readOnly) {
    quarantineSyntheticCalls(overridePathOrDir, options);
    const cleanedRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (cleanedRes.exists && cleanedRes.ok && cleanedRes.data && typeof cleanedRes.data === 'object') {
      ledger.calls = { ...(cleanedRes.data.calls || {}) };
      ledger.updatedAt = cleanedRes.data.updatedAt || '';
    }
  }

  // 读取阶段在内存态自动消解可确认为同一调用的历史双键 (responseId + cascadeId#stepIndex)，不在纯读路径写盘
  if (reconcileConfirmableDuplicateStepCalls(ledger.calls)) {
    Object.defineProperty(ledger, '__hadDuplicateStepKeys', { value: true, configurable: true });
  }

  // 正常落盘数据建立自动滚动备份，供损坏时恢复（只读模式绝不写盘）
  if (!readRes.corrupted && !options?.readOnly) {
    try {
      if (!fsImpl.existsSync(bakPath) || Math.random() < 0.1) {
        fsImpl.copyFileSync(p, bakPath);
      }
    } catch { }
  }

  if (readRes.ok && !hasSynthetic && !options?.fs) {
    try {
      const stAfter = fsImpl.statSync(p);
      if (stAfter.isFile() && stAfter.mtimeMs === st.mtimeMs && stAfter.size === st.size) {
        ledgerCacheByPath.set(cacheKey, { ledger, mtimeMs: stAfter.mtimeMs, size: stAfter.size });
      } else {
        ledgerCacheByPath.delete(cacheKey);
      }
    } catch {
      ledgerCacheByPath.delete(cacheKey);
    }
  }
  return ledger;
}

function savePricingLedger(ledger, overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  if (ledger && (ledger.__corrupted || ledger.__unreadable)) {
    const errMsg = ledger.__corrupted
      ? '原账本数据已损坏且未从备份恢复，已阻止以空数据覆盖原有历史'
      : `原账本当前不可读 (${ledger.__error || 'I/O 异常'})，已阻止写入覆盖原有历史`;
    return {
      ok: false,
      phase: ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
      ...(ledger.__code ? { code: ledger.__code } : {}),
      error: errMsg
    };
  }
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const res = safeWriteJsonSync(p, ledger, {
    fs: fsImpl,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });
  if (res.ok && !options?.fs) {
    try {
      const st = fsImpl.statSync(p);
      if (st.isFile()) {
        const cachedCopy = {
          version: ledger.version || '1.0.0',
          updatedAt: ledger.updatedAt || '',
          calls: { ...(ledger.calls || {}) }
        };
        if (reconcileConfirmableDuplicateStepCalls(cachedCopy.calls)) {
          Object.defineProperty(cachedCopy, '__hadDuplicateStepKeys', { value: true, configurable: true });
        }
        ledgerCacheByPath.set(cacheKey, { ledger: cachedCopy, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch { }
  }
  return res;
}

function createRecordResult(ok, changed, error, phase, code) {
  return {
    ok: !!ok,
    changed: !!changed,
    error: error || undefined,
    phase: phase || undefined,
    ...(code ? { code } : {}),
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

function parseStepFallbackKey(callId, cascadeId) {
  if (typeof callId !== 'string' || !callId.includes('#')) return null;
  const hashIdx = callId.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const idPart = callId.slice(0, hashIdx);
  const stepPart = callId.slice(hashIdx + 1);
  if (!/^\d+$/.test(stepPart)) return null;
  if (cascadeId && idPart.toLowerCase() !== String(cascadeId).toLowerCase()) return null;
  return { cascadeId: cascadeId ? String(cascadeId) : idPart, stepIndex: Number(stepPart) };
}

function isStepFallbackCallId(callId, cascadeId) {
  return parseStepFallbackKey(callId, cascadeId) !== null;
}

function extractCallStepNumbers(c, fallbackKey = null) {
  const steps = [];
  if (!c) return steps;
  if (c.stepIndex !== null && c.stepIndex !== undefined && c.stepIndex !== '' && Number.isInteger(Number(c.stepIndex)) && Number(c.stepIndex) >= 0) {
    steps.push(Number(c.stepIndex));
  }
  if (Array.isArray(c.stepIndices)) {
    for (const s of c.stepIndices) {
      if (s !== null && s !== undefined && s !== '' && Number.isInteger(Number(s)) && Number(s) >= 0 && !steps.includes(Number(s))) {
        steps.push(Number(s));
      }
    }
  }
  if (!steps.length) {
    const parsed = parseStepFallbackKey(c.callId || fallbackKey, c.cascadeId);
    if (parsed) steps.push(parsed.stepIndex);
  }
  return steps;
}

function getCallTokenBreakdown(c) {
  if (!c || typeof c !== 'object') return { inp: 0, cap: 0, out: 0, think: 0, tot: 0 };
  const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
  const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
  const out = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
  const think = Number(c.thinkingTokens ?? c.thinking_output_tokens ?? c.thinking ?? 0) || 0;
  const computedTot = inp + cap + out;
  const rawTot = Number(c.totalTokens ?? 0) || 0;
  return { inp, cap, out, think, tot: computedTot > 0 ? computedTot : rawTot };
}

function isPlaceholderModel(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return /^model_placeholder_/i.test(raw.trim());
}

function getCollectorModelRank(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 0;
  if (isPlaceholderModel(s)) return 1;
  if (!normalizeModelId(s)) return 2;
  return 3;
}

function areModelsCompatible(mA, mB) {
  const a = typeof mA === 'string' ? mA.trim() : '';
  const b = typeof mB === 'string' ? mB.trim() : '';
  if (!a || !b || isPlaceholderModel(a) || isPlaceholderModel(b)) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const normA = normalizeModelId(a);
  const normB = normalizeModelId(b);
  if (normA && normB) return normA === normB;
  return false;
}

function pickRicherModel(primaryModel, secondaryModel) {
  const a = typeof primaryModel === 'string' ? primaryModel.trim() : '';
  const b = typeof secondaryModel === 'string' ? secondaryModel.trim() : '';
  if (!a) return b;
  if (!b) return a;
  const rankA = getCollectorModelRank(a);
  const rankB = getCollectorModelRank(b);
  if (rankB > rankA) return b;
  if (rankA > rankB) return a;
  return a;
}

function extractNormalizedDateInfo(e) {
  if (!e || typeof e !== 'object') {
    return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
  }
  const rawDate = (e.date && /^\d{4}-\d{2}-\d{2}/.test(String(e.date))) ? String(e.date).slice(0, 10) : null;
  const isProv = e.dateIsProvisional === true || e.dateSource === 'provisional';
  if (isProv) {
    return {
      rank: rawDate ? 1 : 0,
      date: rawDate,
      created_at: null,
      dateSource: rawDate ? 'provisional' : null,
      dateIsProvisional: true
    };
  }
  let parsedLocalFromCreated = null;
  if (e.created_at) {
    const dt = new Date(e.created_at);
    if (!Number.isNaN(dt.getTime())) {
      parsedLocalFromCreated = formatLocalDateKey(dt);
    }
  }
  if (e.dateSource === 'transcript' && (rawDate || parsedLocalFromCreated)) {
    return {
      rank: 4,
      date: parsedLocalFromCreated || rawDate,
      created_at: e.created_at ? String(e.created_at) : null,
      dateSource: 'transcript',
      dateIsProvisional: false
    };
  }
  if (parsedLocalFromCreated) {
    return {
      rank: 3,
      date: parsedLocalFromCreated,
      created_at: String(e.created_at),
      dateSource: e.dateSource || 'created_at',
      dateIsProvisional: false
    };
  }
  if (rawDate) {
    return {
      rank: 2,
      date: rawDate,
      created_at: null,
      dateSource: e.dateSource || 'explicit_date',
      dateIsProvisional: false
    };
  }
  return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
}

function compareCallUsage(uA, uB) {
  if (uA.tot !== uB.tot) return uA.tot - uB.tot;
  return uA.out - uB.out;
}

function extractSourceRevision(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.sourceRevision ?? entry.revision ?? entry.metadataRevision;
  if (raw !== undefined && raw !== null && raw !== '') {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  const rawUpdated = entry.updated_at ?? entry.sourceUpdatedAt;
  if (rawUpdated !== undefined && rawUpdated !== null && rawUpdated !== '') {
    const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function compareSourceRevision(incRev, baseRev) {
  const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
  const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
  if (a === null && b === null) return 0;
  if (a !== null && b === null) return 1;
  if (a === null && b !== null) return -1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, forceIncomingDate = false) {
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  if (incomingIsStaleStatus || !incDateInfo.date) return false;
  if (!baseDateInfo.date) return true;
  if (forceIncomingDate) return true;
  if (baseEntry.status !== 'final' && incomingEntry.status === 'final' && usageCmp >= 0 && revCmp >= 0) return true;
  if (revCmp > 0 && usageCmp >= 0) return true;
  if (usageCmp > 0 && revCmp >= 0) return true;
  return false;
}

function mergeSameCallRecords(baseEntry, incomingEntry, canonicalKey, explicitStep = null, preferIncomingModel = false, preferIncomingDate = false) {
  const uBase = getCallTokenBreakdown(baseEntry);
  const uInc = getCallTokenBreakdown(incomingEntry);
  const baseRev = extractSourceRevision(baseEntry);
  const incRev = extractSourceRevision(incomingEntry);
  const usageCmp = compareCallUsage(uInc, uBase);
  const revCmp = compareSourceRevision(incRev, baseRev);
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  const takeIncUsage = !incomingIsStaleStatus && (usageCmp > 0 || (usageCmp === 0 && revCmp > 0));

  const inp = takeIncUsage ? uInc.inp : uBase.inp;
  const cap = takeIncUsage ? uInc.cap : uBase.cap;
  const out = takeIncUsage ? uInc.out : uBase.out;
  const think = takeIncUsage ? (uInc.out < uBase.out ? Math.min(uInc.out, uInc.think) : Math.max(uBase.think, uInc.think)) : uBase.think;
  const tot = takeIncUsage ? uInc.tot : uBase.tot;

  const mergedModel = preferIncomingModel && !incomingIsStaleStatus
    ? pickRicherModel(incomingEntry.model, baseEntry.model)
    : pickRicherModel(baseEntry.model, incomingEntry.model);

  const resolvedStep = explicitStep
    ?? baseEntry.stepIndex
    ?? incomingEntry.stepIndex
    ?? extractCallStepNumbers(baseEntry)[0]
    ?? extractCallStepNumbers(incomingEntry)[0]
    ?? null;

  const resolvedCascadeId = baseEntry.cascadeId
    || incomingEntry.cascadeId
    || parseStepFallbackKey(baseEntry.callId, null)?.cascadeId
    || parseStepFallbackKey(incomingEntry.callId, null)?.cascadeId
    || undefined;

  const baseDateInfo = extractNormalizedDateInfo(baseEntry);
  const incDateInfo = extractNormalizedDateInfo(incomingEntry);
  const adoptSameRankDate = incDateInfo.rank >= 2 &&
    incDateInfo.rank === baseDateInfo.rank &&
    shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, preferIncomingDate);
  let chosenDateInfo;
  if (incDateInfo.rank > baseDateInfo.rank) {
    chosenDateInfo = incDateInfo;
  } else if (baseDateInfo.rank > incDateInfo.rank) {
    chosenDateInfo = baseDateInfo;
  } else if (adoptSameRankDate) {
    chosenDateInfo = incDateInfo;
  } else if (incDateInfo.rank === 1 && baseDateInfo.date && incDateInfo.date) {
    chosenDateInfo = baseDateInfo.date <= incDateInfo.date ? baseDateInfo : incDateInfo;
  } else {
    chosenDateInfo = baseDateInfo.date ? baseDateInfo : incDateInfo;
  }

  const mergedStatus = (baseEntry.status === 'final' || incomingEntry.status === 'final')
    ? 'final'
    : (incomingEntry.status || baseEntry.status || 'final');
  const mergedRev = !incomingIsStaleStatus && revCmp >= 0 ? (incRev ?? baseRev) : baseRev;

  // 保护已有测速指标与精确模型元数据不被无测速的后续校准覆盖
  const preservedExactId = incomingEntry.modelExactId || baseEntry.modelExactId;
  const preservedLabel = incomingEntry.modelLabel || baseEntry.modelLabel;
  const preservedEffort = incomingEntry.effort || baseEntry.effort;
  const keepSpeed = (!hasSpeedMetrics(baseEntry) && hasSpeedMetrics(incomingEntry) && isValidSpeedSample(incomingEntry))
    ? {
      ...(incomingEntry.ttftSec != null ? { ttftSec: incomingEntry.ttftSec } : {}),
      ...(incomingEntry.streamingSec != null ? { streamingSec: incomingEntry.streamingSec } : {}),
      ...(incomingEntry.durationSec != null ? { durationSec: incomingEntry.durationSec } : {}),
      ...(incomingEntry.tps != null ? { tps: incomingEntry.tps } : {}),
      ...(incomingEntry.origin ? { origin: incomingEntry.origin } : {})
    }
    : (hasSpeedMetrics(baseEntry)
      ? {
        ...(baseEntry.ttftSec != null ? { ttftSec: baseEntry.ttftSec } : {}),
        ...(baseEntry.streamingSec != null ? { streamingSec: baseEntry.streamingSec } : {}),
        ...(baseEntry.durationSec != null ? { durationSec: baseEntry.durationSec } : {}),
        ...(baseEntry.tps != null ? { tps: baseEntry.tps } : {}),
        ...(baseEntry.origin ? { origin: baseEntry.origin } : {})
      }
      : {});

  // 保留账号归属元数据，避免后续无账号扫描富化抹除已确认的账号归属
  const attributionMerged = mergeAccountAttributionFields(baseEntry, incomingEntry);

  const merged = {
    ...baseEntry,
    ...(!incomingIsStaleStatus && takeIncUsage ? incomingEntry : {}),
    ...(chosenDateInfo === incDateInfo && incomingEntry.timestamp !== undefined ? { timestamp: incomingEntry.timestamp } : {}),
    callId: canonicalKey,
    source: baseEntry.source || incomingEntry.source || 'desktop',
    ...(resolvedCascadeId ? { cascadeId: resolvedCascadeId } : {}),
    stepIndex: resolvedStep,
    model: mergedModel,
    ...(preservedExactId ? { modelExactId: preservedExactId } : {}),
    ...(preservedLabel ? { modelLabel: preservedLabel } : {}),
    ...(preservedEffort ? { effort: preservedEffort } : {}),
    inputTokens: inp,
    cacheTokens: cap,
    cacheReadTokens: cap,
    outputTokens: out,
    thinkingTokens: think,
    totalTokens: tot,
    status: mergedStatus,
    date: chosenDateInfo.date,
    created_at: chosenDateInfo.created_at,
    ...(chosenDateInfo.dateSource ? { dateSource: chosenDateInfo.dateSource } : {}),
    dateIsProvisional: Boolean(chosenDateInfo.dateIsProvisional),
    ...(mergedRev !== null ? { sourceRevision: mergedRev } : {}),
    ...keepSpeed,
    ...attributionMerged,
    updatedAt: Date.now()
  };
  if (!attributionMerged.accountScopeKey) {
    delete merged.accountScopeKey;
  }
  if (!attributionMerged.accountAttributionEvidence) {
    delete merged.accountAttributionEvidence;
  }
  if (!attributionMerged.unattributedReason) {
    delete merged.unattributedReason;
  }
  if (!chosenDateInfo.dateSource) {
    delete merged.dateSource;
  }
  if (mergedRev === null) {
    delete merged.sourceRevision;
  }

  const costCalc = calculateRequestApiCost(merged);
  if (costCalc.isPriced) {
    merged.modelKey = costCalc.modelKey;
    merged.isPriced = true;
    merged.costUSD = costCalc.costUSD ?? 0;
  } else {
    merged.modelKey = costCalc.modelKey || normalizeModelId(merged.model) || null;
    merged.isPriced = false;
    merged.costUSD = 0;
  }
  merged.isEstimated = Boolean(baseEntry.isEstimated && incomingEntry.isEstimated);
  return merged;
}

// 判定跨键单候选 (real, syn) 是否有充分证据确认为同一调用：已完成的非零真实记录严禁接受跨键异构 ID 的用量改写
function isConfirmableSingleStepMatch(real, syn) {
  if (!real || !syn) return false;
  if (!areModelsCompatible(real.model, syn.model)) return false;
  const uReal = getCallTokenBreakdown(real);
  const uSyn = getCallTokenBreakdown(syn);
  if (uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out) {
    return true;
  }
  if (real.status === 'streaming' || uReal.tot === 0) {
    return true;
  }
  if ((syn.status === 'streaming' || uSyn.tot === 0) && compareCallUsage(uSyn, uReal) <= 0) {
    return true;
  }
  return false;
}

function callSemanticSignature(c) {
  if (!c || typeof c !== 'object') return '';
  const u = getCallTokenBreakdown(c);
  const rev = extractSourceRevision(c);
  return [
    String(c.callId || ''),
    String(c.source || 'desktop'),
    String(c.cascadeId || ''),
    c.stepIndex ?? '',
    String(c.model || ''),
    String(c.modelKey || ''),
    String(c.modelExactId || ''),
    String(c.status || ''),
    Boolean(c.isEstimated),
    Boolean(c.isPriced),
    Number(c.costUSD || 0),
    u.inp,
    u.cap,
    u.out,
    u.think,
    u.tot,
    c.durationSec ?? '',
    c.tps ?? '',
    String(c.date || ''),
    String(c.created_at || ''),
    String(c.dateSource || ''),
    Boolean(c.dateIsProvisional),
    rev ?? '',
    String(c.accountScopeKey || ''),
    String(c.accountAttributionConfidence || ''),
    String(c.unattributedReason || '')
  ].join('|');
}

function hasCallsMapChanged(beforeCalls = {}, afterCalls = {}) {
  const bKeys = Object.keys(beforeCalls);
  const aKeys = Object.keys(afterCalls);
  if (bKeys.length !== aKeys.length) return true;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(beforeCalls, k)) return true;
    if (callSemanticSignature(beforeCalls[k]) !== callSemanticSignature(afterCalls[k])) return true;
  }
  return false;
}

function reconcileConfirmableDuplicateStepCalls(callsObj) {
  if (!callsObj || typeof callsObj !== 'object') return false;
  const synItems = [];
  const realItems = [];

  for (const [key, entry] of Object.entries(callsObj)) {
    if (!entry || typeof entry !== 'object') continue;
    const parsedKey = parseStepFallbackKey(key, entry.cascadeId);
    if (parsedKey) {
      synItems.push({
        synKey: key,
        syn: entry,
        synSrc: entry.source || 'desktop',
        synCid: parsedKey.cascadeId.toLowerCase(),
        synStep: parsedKey.stepIndex
      });
    } else {
      realItems.push({ realKey: key, real: entry });
    }
  }

  if (!synItems.length || !realItems.length) return false;

  // 按 (source, cascadeId) 建立局部哈希索引，将 O(syn * real) 降至线性 O(syn + real)
  const synCidSet = new Set();
  for (let i = 0; i < synItems.length; i++) {
    synCidSet.add(`${synItems[i].synSrc}\0${synItems[i].synCid}`);
  }
  const ruleAIndex = new Map();
  const ruleBIndex = new Map();
  for (let i = 0; i < realItems.length; i++) {
    const item = realItems[i];
    const { realKey, real } = item;
    const src = real.source || 'desktop';
    const cid = String(real.cascadeId || '').toLowerCase();
    const srcCid = `${src}\0${cid}`;
    if (!synCidSet.has(srcCid)) continue;
    const stepNums = extractCallStepNumbers(real, realKey);
    if (stepNums.length > 0) {
      for (let j = 0; j < stepNums.length; j++) {
        const aKey = `${srcCid}\0${stepNums[j]}`;
        let list = ruleAIndex.get(aKey);
        if (!list) { list = []; ruleAIndex.set(aKey, list); }
        list.push(item);
      }
    } else {
      const uReal = getCallTokenBreakdown(real);
      const bKey = `${srcCid}\0${uReal.inp}:${uReal.cap}:${uReal.out}`;
      let list = ruleBIndex.get(bKey);
      if (!list) { list = []; ruleBIndex.set(bKey, list); }
      list.push(item);
    }
  }

  let reconciled = false;
  const usedRealKeys = new Set();
  const unmatchedSyn = [];

  // Rule A: 同 (source, cascadeId) 下显式包含相同 stepIndex 且模型兼容的真实 responseId 记录
  for (const sItem of synItems) {
    const { synKey, syn, synSrc, synCid, synStep } = sItem;
    const indexedA = ruleAIndex.get(`${synSrc}\0${synCid}\0${synStep}`);
    const cands = indexedA ? indexedA.filter(({ realKey, real }) => {
      if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
      return areModelsCompatible(real.model, syn.model);
    }) : [];

    let matchedRealKey = null;
    if (cands.length === 1) {
      if (isConfirmableSingleStepMatch(cands[0].real, syn)) {
        matchedRealKey = cands[0].realKey;
      }
    } else if (cands.length > 1) {
      const uSyn = getCallTokenBreakdown(syn);
      if (uSyn.inp + uSyn.cap + uSyn.out > 0) {
        const exactCands = cands.filter(({ real }) => {
          const uReal = getCallTokenBreakdown(real);
          return uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out;
        });
        if (exactCands.length === 1) {
          matchedRealKey = exactCands[0].realKey;
        }
      }
    }

    if (matchedRealKey && callsObj[matchedRealKey]) {
      callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
      delete callsObj[synKey];
      usedRealKeys.add(matchedRealKey);
      reconciled = true;
    } else {
      unmatchedSyn.push(sItem);
    }
  }

  // Rule B: 遗留 stepIndex == null 的真实记录，按唯一非零 (source, cascadeId, inp, cap, out) + 兼容模型 1-to-1 消重
  if (unmatchedSyn.length) {
    const synByUsage = new Map();
    for (const sItem of unmatchedSyn) {
      const uSyn = getCallTokenBreakdown(sItem.syn);
      if (uSyn.inp + uSyn.cap + uSyn.out <= 0) continue;
      const uKey = `${sItem.synSrc}:${sItem.synCid}:${uSyn.inp}:${uSyn.cap}:${uSyn.out}`;
      let list = synByUsage.get(uKey);
      if (!list) { list = []; synByUsage.set(uKey, list); }
      list.push(sItem);
    }

    for (const [, synGroup] of synByUsage.entries()) {
      if (synGroup.length !== 1) continue;
      const { synKey, syn, synSrc, synCid, synStep } = synGroup[0];
      const uSyn = getCallTokenBreakdown(syn);
      const indexedB = ruleBIndex.get(`${synSrc}\0${synCid}\0${uSyn.inp}:${uSyn.cap}:${uSyn.out}`);
      const cands = indexedB ? indexedB.filter(({ realKey, real }) => {
        if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
        return areModelsCompatible(real.model, syn.model);
      }) : [];

      if (cands.length === 1) {
        const matchedRealKey = cands[0].realKey;
        callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
        delete callsObj[synKey];
        usedRealKeys.add(matchedRealKey);
        reconciled = true;
      }
    }
  }

  return reconciled;
}

const SCOPE_KEY_REGEX = /^acct_[0-9a-f]{16}$/i;

function isValidAccountScopeKey(val) {
  return typeof val === 'string' && SCOPE_KEY_REGEX.test(val.trim());
}

function getAccountAttributionRank(conf) {
  switch (String(conf || '')) {
    case 'explicit_account_email':
    case 'keepalive_bound':
      return 4;
    case 'session_window_verified':
      return 3;
    case 'repaired_session_window':
    case 'live_confirmed_account':
      return 2;
    case 'unattributed':
    default:
      return 0;
  }
}

function parseTimestampToMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const str = String(raw).trim();
  if (!str) return null;
  // 纯日期 YYYY-MM-DD 缺少精确时刻，不得视为请求精确时间窗边界
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
  }
  const parsed = Date.parse(str);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : null;
}

function extractCallTimeBoundsMs(call) {
  if (!call || typeof call !== 'object') return { startMs: null, endMs: null };
  // 临时轮询时间戳 (dateIsProvisional / dateSource === 'provisional') 是点开旧会话时填入的浏览时刻 Date.now()，绝不可当作请求真实发生时间
  const isProvisional = Boolean(call.dateIsProvisional || call.dateSource === 'provisional');
  const allowRawTimestamp = !isProvisional;
  const liveObsMs = call.liveRealtimeConfirmed === true ? parseTimestampToMs(call.liveObservedAtMs) : null;
  const startCand = parseTimestampToMs(call.requestStartMs)
    ?? parseTimestampToMs(call.startTimeMs)
    ?? parseTimestampToMs(call.startTime)
    ?? parseTimestampToMs(call.startedAt)
    ?? parseTimestampToMs(call.created_at)
    ?? parseTimestampToMs(call.createdAt)
    ?? (allowRawTimestamp ? parseTimestampToMs(call.timestamp) : null)
    ?? liveObsMs;
  const endCand = parseTimestampToMs(call.requestEndMs)
    ?? parseTimestampToMs(call.endTimeMs)
    ?? parseTimestampToMs(call.endTime)
    ?? parseTimestampToMs(call.completedAt)
    ?? (allowRawTimestamp ? parseTimestampToMs(call.timestamp) : null)
    ?? parseTimestampToMs(call.created_at)
    ?? liveObsMs
    ?? startCand;
  if (startCand == null && endCand == null) return { startMs: null, endMs: null };
  const s = startCand ?? endCand;
  const e = endCand ?? startCand;
  return { startMs: Math.min(s, e), endMs: Math.max(s, e) };
}

function mergeAccountAttributionFields(baseEntry = {}, incomingEntry = {}) {
  const bScope = isValidAccountScopeKey(baseEntry.accountScopeKey) && baseEntry.accountAttributionConfidence !== 'unattributed'
    ? baseEntry.accountScopeKey.trim()
    : null;
  const iScope = isValidAccountScopeKey(incomingEntry.accountScopeKey) && incomingEntry.accountAttributionConfidence !== 'unattributed'
    ? incomingEntry.accountScopeKey.trim()
    : null;
  const bRank = bScope ? Math.max(1, getAccountAttributionRank(baseEntry.accountAttributionConfidence)) : 0;
  const iRank = iScope ? Math.max(1, getAccountAttributionRank(incomingEntry.accountAttributionConfidence)) : 0;

  if (bScope && iScope) {
    if (bScope === iScope) {
      const winner = iRank >= bRank ? incomingEntry : baseEntry;
      return {
        accountScopeKey: bScope,
        accountAttributionConfidence: winner.accountAttributionConfidence || baseEntry.accountAttributionConfidence || incomingEntry.accountAttributionConfidence || 'live_confirmed_account',
        accountAttributionEvidence: winner.accountAttributionEvidence || baseEntry.accountAttributionEvidence || incomingEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    if (iRank > bRank) {
      return {
        accountScopeKey: iScope,
        accountAttributionConfidence: incomingEntry.accountAttributionConfidence,
        accountAttributionEvidence: incomingEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    if (bRank > iRank) {
      return {
        accountScopeKey: bScope,
        accountAttributionConfidence: baseEntry.accountAttributionConfidence,
        accountAttributionEvidence: baseEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    // 同一置信度指向不同账号时拒绝猜测，降级未归属冲突
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      accountAttributionEvidence: null,
      unattributedReason: 'account_conflict'
    };
  }

  if (bScope && !iScope) {
    const baseIsHardBound = baseEntry.accountAttributionConfidence === 'explicit_account_email'
      || baseEntry.accountAttributionConfidence === 'keepalive_bound';
    if (!baseIsHardBound && incomingEntry.forceUnattributed && incomingEntry.unattributedReason) {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        accountAttributionEvidence: null,
        unattributedReason: incomingEntry.unattributedReason
      };
    }
    return {
      accountScopeKey: bScope,
      accountAttributionConfidence: baseEntry.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: baseEntry.accountAttributionEvidence || null,
      unattributedReason: null
    };
  }

  if (!bScope && iScope) {
    return {
      accountScopeKey: iScope,
      accountAttributionConfidence: incomingEntry.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: incomingEntry.accountAttributionEvidence || null,
      unattributedReason: null
    };
  }

  return {
    accountScopeKey: null,
    accountAttributionConfidence: 'unattributed',
    accountAttributionEvidence: incomingEntry.accountAttributionEvidence || baseEntry.accountAttributionEvidence || null,
    unattributedReason: incomingEntry.unattributedReason || baseEntry.unattributedReason || null
  };
}

function matchTimestampAgainstSessions(startMs, endMs, source, accountSessions = [], matchOpts = {}) {
  const normSource = String(source || 'desktop').toLowerCase();
  if (normSource === 'ide') {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'unverified_source_ide' };
  }
  if (!Number.isFinite(startMs) || startMs <= 0) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'missing_request_timestamp' };
  }
  const rStart = Math.min(startMs, Number.isFinite(endMs) ? endMs : startMs);
  const rEnd = Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs);
  const sessions = Array.isArray(accountSessions)
    ? accountSessions.filter(s => s && s.email && Number.isFinite(Number(s.startAtMs)))
    : [];
  if (!sessions.length) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }

  const openVerifiedMs = Number.isFinite(Number(matchOpts.openSessionVerifiedUntilMs))
    ? Number(matchOpts.openSessionVerifiedUntilMs)
    : 0;
  const openEmailNorm = typeof matchOpts.openSessionEmail === 'string'
    ? matchOpts.openSessionEmail.trim().toLowerCase()
    : '';

  const getSessionWinEnd = (s) => {
    const sStart = Number(s.startAtMs);
    const sLast = Number.isFinite(Number(s.lastVerifiedAtMs)) ? Number(s.lastVerifiedAtMs) : sStart;
    if (s.endAtMs != null) return Number(s.endAtMs) + 5000;
    const isMatchedOpen = openVerifiedMs > 0 && (!openEmailNorm || String(s.email).trim().toLowerCase() === openEmailNorm);
    const effLast = isMatchedOpen ? Math.max(sLast, sStart, openVerifiedMs) : Math.max(sLast, sStart);
    return effLast + 180000;
  };

  let earliestStart = Infinity;
  const matching = [];
  for (const s of sessions) {
    const sStart = Number(s.startAtMs);
    if (sStart < earliestStart) earliestStart = sStart;
    const winStart = sStart - 5000;
    const winEnd = getSessionWinEnd(s);
    if (rStart >= winStart && rEnd <= winEnd) {
      matching.push(s);
    }
  }
  if (matching.length > 0) {
    const distinct = new Set(matching.map(m => String(m.email).trim().toLowerCase()));
    if (distinct.size === 1) {
      const m = matching[0];
      return {
        accountScopeKey: isValidAccountScopeKey(m.accountScopeKey) ? m.accountScopeKey.trim() : buildAccountScopeKey(m.email),
        confidence: 'session_window_verified',
        evidence: m.evidence || 'host_user_status_window'
      };
    }
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }
  const touched = sessions.filter(s => {
    const sStart = Number(s.startAtMs);
    const winStart = sStart - 5000;
    const winEnd = getSessionWinEnd(s);
    return rEnd >= winStart && rStart <= winEnd;
  });
  if (touched.length > 0) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }
  if (rEnd < earliestStart - 5000) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }
  return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'outside_verified_window' };
}

function resolveCallAccountAttribution(call, options = {}, existing = null) {
  if (call.accountAttributionConfidence === 'unattributed' && !call.accountEmail) {
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: call.unattributedReason || 'explicit_unattributed',
      forceUnattributed: Boolean(call.forceUnattributed)
    };
  }
  const explicitEmail = (typeof call.accountEmail === 'string' && call.accountEmail.includes('@'))
    ? call.accountEmail.trim().toLowerCase()
    : '';
  const explicitScope = isValidAccountScopeKey(call.accountScopeKey) ? call.accountScopeKey.trim() : null;
  const isHardBound = Boolean(explicitEmail || (explicitScope && (call.isKeepalive || call.accountAttributionConfidence === 'explicit_account_email' || call.accountAttributionConfidence === 'keepalive_bound')));
  if (isHardBound || (explicitScope && !Array.isArray(options.accountSessions))) {
    return {
      accountScopeKey: explicitScope || buildAccountScopeKey(explicitEmail),
      accountAttributionConfidence: call.accountAttributionConfidence || (call.isKeepalive ? 'keepalive_bound' : 'explicit_account_email'),
      accountAttributionEvidence: call.accountAttributionEvidence || (explicitEmail ? 'call_account_email' : 'call_account_scope_key'),
      unattributedReason: null
    };
  }

  const callSource = String(call.source || existing?.source || 'desktop').toLowerCase();
  if (Array.isArray(options.accountSessions)) {
    if (callSource === 'ide') {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: 'unverified_source_ide',
        forceUnattributed: true
      };
    }
    // 优先采用非临时的权威请求时间戳（若入参为点开旧会话产生的 provisional 浏览记录，必须使用账本已有 existing 的权威时间）
    const callBounds = extractCallTimeBoundsMs(call);
    const existBounds = existing ? extractCallTimeBoundsMs(existing) : { startMs: null, endMs: null };
    const authBounds = callBounds.startMs != null ? callBounds : existBounds;
    const hasExactTs = authBounds.startMs != null;

    if (hasExactTs && options.accountSessions.length > 0) {
      const liveAcct = options.liveConfirmedAccount;
      const m = matchTimestampAgainstSessions(authBounds.startMs, authBounds.endMs, callSource, options.accountSessions, {
        openSessionEmail: liveAcct?.email || null,
        openSessionVerifiedUntilMs: liveAcct?.verifiedAtMs || null
      });
      if (m.accountScopeKey) {
        return {
          accountScopeKey: m.accountScopeKey,
          accountAttributionConfidence: m.confidence,
          accountAttributionEvidence: m.evidence || 'host_user_status_window',
          unattributedReason: null
        };
      }
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: m.unattributedReason || 'outside_verified_window',
        forceUnattributed: true
      };
    }

    if (hasExactTs && options.accountSessions.length === 0) {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: 'before_account_tracking',
        forceUnattributed: true
      };
    }

    // 尚无 transcript 精确时间时：仅对前端明确确认为“会话水合后实时新产生/流式刚结束”的本机请求归入当前已验证活跃账号；
    // 点开历史旧会话首次水合出来的旧步骤严禁按当前登录账号猜测归属！
    const liveAcct = options.liveConfirmedAccount;
    const isOfflineScan = Boolean(options.trustTranscriptDate || call.fromTranscriptScan);
    if (!hasExactTs && !isOfflineScan && call.liveRealtimeConfirmed === true && callSource === 'desktop' && liveAcct && typeof liveAcct.email === 'string' && liveAcct.email.includes('@')) {
      const nowMs = Date.now();
      const verifiedAt = Number(liveAcct.verifiedAtMs) || nowMs;
      if (nowMs <= verifiedAt + 180000) {
        return {
          accountScopeKey: buildAccountScopeKey(liveAcct.email),
          accountAttributionConfidence: 'live_confirmed_account',
          accountAttributionEvidence: 'live_ipc_confirmed_account',
          unattributedReason: null
        };
      }
    }

    // 若既无精确时间也非实时确认新请求，保持现有有效归属或暂列未归属（等待 transcript 权威时间落盘裁决）
    if (existing && isValidAccountScopeKey(existing.accountScopeKey) && existing.accountAttributionConfidence !== 'unattributed') {
      return {
        accountScopeKey: existing.accountScopeKey.trim(),
        accountAttributionConfidence: existing.accountAttributionConfidence,
        accountAttributionEvidence: existing.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }

    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: 'pending_authoritative_timestamp'
    };
  }

  // 未提供 accountSessions 时：历史离线扫描严禁按当前账号强行归属；保留测试或明确传参兼容性
  if (options.trustTranscriptDate || call.fromTranscriptScan) {
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: 'history_scan_without_sessions'
    };
  }

  const fallbackEmail = (typeof options.confirmedAccountEmail === 'string' && options.confirmedAccountEmail.includes('@'))
    ? options.confirmedAccountEmail.trim().toLowerCase()
    : '';
  const fallbackScope = fallbackEmail
    ? buildAccountScopeKey(fallbackEmail)
    : (isValidAccountScopeKey(options.accountScopeKey) ? options.accountScopeKey.trim() : null);

  if (fallbackScope) {
    return {
      accountScopeKey: fallbackScope,
      accountAttributionConfidence: options.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: options.accountAttributionEvidence || 'confirmed_account_email_option',
      unattributedReason: null
    };
  }

  return {
    accountScopeKey: null,
    accountAttributionConfidence: 'unattributed',
    unattributedReason: 'missing_account_context'
  };
}

function buildRecordModelCallsLockedExecutor(newCalls = [], options = {}) {
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const fsOpt = (options && typeof options === 'object' && options.fs) ? { fs: options.fs } : undefined;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));

  const executeLocked = () => {
    // 持锁期间强制失效内存缓存，确保跨进程场景读到前一进程刚落盘的最新账本状态
    if (!fsOpt) {
      ledgerCacheByPath.delete(normalizeLedgerKey(resolvedLedgerPath));
    }
    const ledger = loadPricingLedger(targetDir, fsOpt);

    if (ledger.__corrupted || ledger.__unreadable) {
      const prefix = ledger.__corrupted
        ? '账本已损坏，阻止空覆盖'
        : `账本当前不可读 (${ledger.__error || 'I/O 异常'})，阻止覆盖`;
      return createRecordResult(
        false,
        false,
        `${prefix} (${ledger.__corruptedPath})`,
        ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
        ledger.__code
      );
    }

    // 第一阶段：每条传入记录仅按自身 targetKey 入表或同键合并，避免逐条贪心跨键绑定引发输入顺序依赖
    const beforeCalls = ledger.calls || {};
    const draftCalls = { ...beforeCalls };

    for (const call of newCalls) {
      if (!call || !call.callId) continue;
      // 默认阻止测试样例和合成调用污染生产账本
      if (!options.allowSynthetic && isSyntheticCall(call.callId, call)) continue;

      const targetKey = String(call.callId);
      const incomingFallback = parseStepFallbackKey(targetKey, call.cascadeId);
      const callCidRaw = call.cascadeId || incomingFallback?.cascadeId;
      const existing = draftCalls[targetKey];

      // 严格账号归属：结合会话活跃时间窗或显式已核实账号，绝不把离线扫描旧记录或跨号边界错记到当前账号
      const attrRes = resolveCallAccountAttribution(call, options, existing);
      const resolvedScopeKey = attrRes.accountScopeKey;
      const resolvedAttrConf = attrRes.accountAttributionConfidence;
      const resolvedAttrEvidence = attrRes.accountAttributionEvidence || null;
      const resolvedUnattrReason = attrRes.unattributedReason || null;
      const callWithAttr = {
        ...call,
        ...(resolvedScopeKey ? { accountScopeKey: resolvedScopeKey } : {}),
        accountAttributionConfidence: resolvedAttrConf,
        ...(resolvedAttrEvidence ? { accountAttributionEvidence: resolvedAttrEvidence } : {}),
        ...(resolvedUnattrReason ? { unattributedReason: resolvedUnattrReason } : {}),
        ...(attrRes.forceUnattributed ? { forceUnattributed: true } : {})
      };
      if (!resolvedScopeKey) {
        delete callWithAttr.accountScopeKey;
      }

      if (!existing) {
        const normalizedStep = extractCallStepNumbers(callWithAttr, targetKey)[0] ?? null;
        const uInc = getCallTokenBreakdown(callWithAttr);
        const dInfo = extractNormalizedDateInfo(callWithAttr);
        const incRev = extractSourceRevision(callWithAttr);
        const nextEntry = {
          ...callWithAttr,
          callId: targetKey,
          ...(resolvedScopeKey ? { accountScopeKey: resolvedScopeKey } : {}),
          accountAttributionConfidence: resolvedAttrConf,
          ...(resolvedAttrEvidence ? { accountAttributionEvidence: resolvedAttrEvidence } : {}),
          ...(resolvedUnattrReason ? { unattributedReason: resolvedUnattrReason } : {}),
          ...(call.isKeepalive ? { isKeepalive: true } : {}),
          ...(callCidRaw && !call.cascadeId ? { cascadeId: callCidRaw } : {}),
          ...(normalizedStep !== null && call.stepIndex == null ? { stepIndex: normalizedStep } : {}),
          ...(call.totalTokens == null && uInc.tot > 0 ? { totalTokens: uInc.tot } : {}),
          ...(dInfo.date ? { date: dInfo.date } : {}),
          ...(dInfo.created_at ? { created_at: dInfo.created_at } : (dInfo.dateIsProvisional ? { created_at: null } : {})),
          ...(dInfo.dateSource ? { dateSource: dInfo.dateSource } : {}),
          dateIsProvisional: Boolean(dInfo.dateIsProvisional),
          ...(incRev !== null ? { sourceRevision: incRev } : {}),
          updatedAt: Date.now()
        };
        if (incRev === null) {
          delete nextEntry.sourceRevision;
        }
        if (dInfo.date && dInfo.date !== call.date) {
          const recalc = calculateRequestApiCost(nextEntry);
          if (recalc.isPriced) {
            nextEntry.modelKey = recalc.modelKey;
            nextEntry.isPriced = true;
            nextEntry.costUSD = recalc.costUSD ?? 0;
          }
        }
        draftCalls[targetKey] = nextEntry;
        continue;
      }

      const uExist = getCallTokenBreakdown(existing);
      const uCall = getCallTokenBreakdown(call);
      const usageCmp = compareCallUsage(uCall, uExist);
      const existRev = extractSourceRevision(existing);
      const callRev = extractSourceRevision(call);
      const revCmp = compareSourceRevision(callRev, existRev);
      const incomingIsStaleStatus = existing.status === 'final' && Boolean(call.status) && call.status !== 'final';
      const isUsageRollback = incomingIsStaleStatus || (existing.status === 'final' && usageCmp < 0);
      const existDateInfo = extractNormalizedDateInfo(existing);
      const callDateInfo = extractNormalizedDateInfo(call);
      const trustIncomingTranscriptDate = Boolean(options.trustTranscriptDate && callDateInfo.dateSource === 'transcript');
      const adoptIncomingSameRankDate = callDateInfo.rank >= 2 &&
        callDateInfo.rank === existDateInfo.rank &&
        shouldAdoptSameRankAuthDate(existing, call, existDateInfo, callDateInfo, usageCmp, revCmp, trustIncomingTranscriptDate);
      const sameRankAuthDateProgressed = adoptIncomingSameRankDate && (
        callDateInfo.date !== existDateInfo.date ||
        (callDateInfo.rank >= 3 && Boolean(callDateInfo.created_at) && callDateInfo.created_at !== existDateInfo.created_at)
      );
      const dateProgressed = (
        callDateInfo.rank > existDateInfo.rank ||
        sameRankAuthDateProgressed ||
        (existing.date && existDateInfo.date && existing.date !== existDateInfo.date)
      ) && Boolean(callDateInfo.date || existDateInfo.date);
      const stateProgressed = existing.status !== 'final' && call.status === 'final';
      const usageProgressed = !incomingIsStaleStatus && usageCmp > 0;
      const revisionUsageProgressed = !isUsageRollback && usageCmp === 0 && revCmp > 0 && (
        uCall.inp !== uExist.inp || uCall.cap !== uExist.cap || uCall.think !== uExist.think
      );
      const revisionMetaProgressed = !isUsageRollback && revCmp > 0 && callRev !== existRev;
      const modelProgressed = getCollectorModelRank(call.model) > getCollectorModelRank(existing.model);
      const speedProgressed = !hasSpeedMetrics(existing) && hasSpeedMetrics(call) && isValidSpeedSample(call);
      const modelExactProgressed = !existing.modelExactId && Boolean(call.modelExactId);
      const recalcExist = calculateRequestApiCost(existing);
      const costOutOfSync = Boolean(recalcExist.isPriced) !== Boolean(existing.isPriced)
        || (recalcExist.isPriced && Number(existing.costUSD || 0) !== Number(recalcExist.costUSD || 0));
      const pricingProgressed = costOutOfSync || ((!existing.isPriced || !existing.costUSD) && Boolean((call.isPriced && call.costUSD > 0) || normalizeModelId(call.model || existing.model)));
      const resolvedStepIndex = existing.stepIndex ?? call.stepIndex ?? extractCallStepNumbers(existing, targetKey)[0] ?? extractCallStepNumbers(call, targetKey)[0] ?? null;
      const existScopeClean = isValidAccountScopeKey(existing.accountScopeKey) && existing.accountAttributionConfidence !== 'unattributed'
        ? existing.accountScopeKey.trim()
        : null;
      const existRank = existScopeClean ? Math.max(1, getAccountAttributionRank(existing.accountAttributionConfidence)) : 0;
      const incRank = resolvedScopeKey ? Math.max(1, getAccountAttributionRank(resolvedAttrConf)) : 0;
      const existBaseHardBound = existing.accountAttributionConfidence === 'explicit_account_email'
        || existing.accountAttributionConfidence === 'keepalive_bound';
      const attributionProgressed = Boolean(
        (!existScopeClean && resolvedScopeKey)
        || (existScopeClean && resolvedScopeKey && existScopeClean === resolvedScopeKey && incRank > existRank)
        || (existScopeClean && resolvedScopeKey && existScopeClean !== resolvedScopeKey && incRank >= existRank)
        || (existScopeClean && !resolvedScopeKey && attrRes.forceUnattributed && !existBaseHardBound)
        || (!existScopeClean && !existing.unattributedReason && resolvedUnattrReason)
      );
      const metaProgressed = (existing.stepIndex == null && resolvedStepIndex != null) || (!existing.cascadeId && Boolean(callCidRaw)) || modelExactProgressed || attributionProgressed;

      if (modelProgressed || metaProgressed || dateProgressed || (!isUsageRollback && (stateProgressed || usageProgressed || revisionUsageProgressed || revisionMetaProgressed || pricingProgressed || speedProgressed))) {
        draftCalls[targetKey] = mergeSameCallRecords(
          existing,
          callWithAttr,
          targetKey,
          resolvedStepIndex,
          !isUsageRollback && revCmp >= 0,
          adoptIncomingSameRankDate
        );
      }
    }

    // 第二阶段：在完整候选集（既有记录 + 整批新入账记录）上统一执行无顺序依赖的充分证据跨键消解
    reconcileConfirmableDuplicateStepCalls(draftCalls);
    pruneExcessSpeedSamples(draftCalls);

    const changed = Boolean(ledger.__hadDuplicateStepKeys) || hasCallsMapChanged(beforeCalls, draftCalls);

    if (changed) {
      const draftLedger = {
        ...ledger,
        calls: draftCalls,
        updatedAt: new Date().toISOString()
      };
      const saveRes = savePricingLedger(draftLedger, targetDir, fsOpt);
      if (!saveRes.ok) {
        return createRecordResult(false, false, saveRes.error || '保存账本落盘失败', saveRes.phase, saveRes.code);
      }
      // 同步落盘物理隔离的分账号账本目录（account_ledgers/<accountScopeKey>.json 与 unattributed.json）
      if (!fsOpt || typeof fsOpt.fs?.writeFileSync === 'function') {
        try {
          syncAccountLedgerPartitions(resolvedLedgerPath, draftCalls, fsOpt?.fs || fs);
        } catch { }
      }
      // 账本变化时失效聚合热缓存（含按 agDir 隔离作用域的扫描缓存）
      cachedTokenHistoryAt = 0;
    }

    return createRecordResult(true, changed);
  };

  return { fsOpt, resolvedLedgerPath, executeLocked };
}

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const { fsOpt, resolvedLedgerPath, executeLocked } = buildRecordModelCallsLockedExecutor(newCalls, options);
  if (fsOpt) {
    return executeLocked();
  }
  return withFileLockSync(resolvedLedgerPath, executeLocked, options.lockOptions);
}

async function recordModelCallsLockedAsync(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const { fsOpt, resolvedLedgerPath, executeLocked } = buildRecordModelCallsLockedExecutor(newCalls, options);
  if (fsOpt) {
    return executeLocked();
  }
  return withFileLockAsync(resolvedLedgerPath, executeLocked, options.lockOptions);
}

/**
 * 将账本 calls 按 accountScopeKey 严格拆分为独立账号分片与 unattributed.json
 * 不同账号数据绝不互相混合，未归属历史单独隔离。
 */
function syncAccountLedgerPartitions(resolvedLedgerPath, callsMap = {}, fsImpl = fs) {
  const partDir = path.join(path.dirname(resolvedLedgerPath), 'account_ledgers');
  if (!fsImpl.existsSync(partDir)) {
    fsImpl.mkdirSync(partDir, { recursive: true });
  }
  const buckets = new Map();
  buckets.set('unattributed', {});
  for (const [callId, rec] of Object.entries(callsMap || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const rawKey = (typeof rec.accountScopeKey === 'string' && /^acct_[0-9a-f]{16}$/i.test(rec.accountScopeKey.trim()))
      ? rec.accountScopeKey.trim()
      : 'unattributed';
    if (!buckets.has(rawKey)) buckets.set(rawKey, {});
    buckets.get(rawKey)[callId] = rec;
  }
  const nowIso = new Date().toISOString();
  for (const [scopeKey, partCalls] of buckets.entries()) {
    const targetFile = path.join(partDir, `${scopeKey}.json`);
    const payload = JSON.stringify({
      version: 1,
      accountScopeKey: scopeKey,
      updatedAt: nowIso,
      callCount: Object.keys(partCalls).length,
      calls: partCalls
    });
    const tmp = `${targetFile}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, payload, 'utf8');
    fsImpl.renameSync(tmp, targetFile);
  }
  // 清理纠偏后已不再包含任何归属记录的陈旧 acct_*.json 分片文件，保证分片目录与主账本 100% 一致
  if (typeof fsImpl.readdirSync === 'function' && typeof fsImpl.unlinkSync === 'function') {
    try {
      for (const fName of fsImpl.readdirSync(partDir)) {
        if (!/^acct_[0-9a-f]{16}\.json$/i.test(fName)) continue;
        const sk = fName.slice(0, -5);
        if (!buckets.has(sk)) {
          fsImpl.unlinkSync(path.join(partDir, fName));
        }
      }
    } catch { }
  }
}

function accumulateDayBucket(map, dKey, u, tot, steps = 1) {
  if (!dKey) return;
  if (!map[dKey]) {
    map[dKey] = { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
  }
  map[dKey].input += u.inp;
  map[dKey].cache += u.cap;
  map[dKey].output += u.out;
  map[dKey].total += tot;
  map[dKey].steps += steps;
}

function accumulateModelDayBucket(srcMap, dKey, vKey, u, tot, steps = 1) {
  if (!dKey || !vKey) return;
  if (!srcMap[dKey]) srcMap[dKey] = {};
  if (!srcMap[dKey][vKey]) {
    srcMap[dKey][vKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
  }
  srcMap[dKey][vKey].total += tot;
  srcMap[dKey][vKey].input += u.inp;
  srcMap[dKey][vKey].output += u.out;
  srcMap[dKey][vKey].cache += u.cap;
  srcMap[dKey][vKey].steps += steps;
}

function buildRefCostBundle(inp, outp, cap, tot, mInp, mOutp, mCap, mTot, costAll, costMonth) {
  return {
    all: calculateReferenceModelCost({ inputTokens: inp, outputTokens: outp, cacheTokens: cap, totalTokens: tot }, 'gemini-3.8-flash', { pricingDate: '2026-11-08', mode: 'all' }),
    currentMonth: calculateReferenceModelCost({ inputTokens: mInp, outputTokens: mOutp, cacheTokens: mCap, totalTokens: mTot }, 'gemini-3.8-flash', { pricingDate: '2026-11-08', mode: 'all' }),
    hybrid: calculateReferenceModelCost({ inputTokens: inp, outputTokens: outp, cacheTokens: cap, totalTokens: tot }, 'gemini-3.8-flash', {
      pricingDate: '2026-11-09',
      mode: 'unpriced_only',
      knownUsage: { byCategory: costAll?.byCategory, costUSD: costAll?.pricedCostUSD || 0 }
    }),
    currentMonthHybrid: calculateReferenceModelCost({ inputTokens: mInp, outputTokens: mOutp, cacheTokens: mCap, totalTokens: mTot }, 'gemini-3.8-flash', {
      pricingDate: '2026-11-09',
      mode: 'unpriced_only',
      knownUsage: { byCategory: costMonth?.byCategory, costUSD: costMonth?.pricedCostUSD || 0 }
    })
  };
}

/**
 * 构建严格的跨账号用量隔离统计：
 * - 只有带明确 accountScopeKey 且非 unattributed 的记录计入对应账号；
 * - 为每个账号完整生成 dailyMapBySource / dailyModelMapBySource / 费用 / 缓存 / 对话数，确保全界面任意筛选项严密同步；
 * - 未归属记录与旧档案按照「全量 - 已归属各账号总和」精确对账并入 unattributed，绝不默认算给当前账号。
 * - 保活请求 (isKeepalive: true) 计入对应账号同时提供独立统计 keepaliveStats。
 */
function buildAccountUsageBreakdown({
  finalCallsEntries = [],
  resolveLedgerCallDate = (k, c) => c?.date || null,
  dailyMapAll = {},
  mergedDesktop = {},
  mergedCli = {},
  mergedLegacyUnallocated = {},
  dailyModelMapBySource = null,
  modelMetaByKey = {},
  compactModelConfigs = [],
  availableModelDetails = null,
  totalConversationsAll = 0,
  unpricedSummaryBySource = null,
  now = new Date()
} = {}) {
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  const ensureAcct = (scopeKey) => ({
    accountScopeKey: scopeKey,
    totalTokens: 0,
    totalInputTokens: 0,
    totalCacheTokens: 0,
    totalOutputTokens: 0,
    todayTokens: 0,
    monthTokens: 0,
    yearTokens: 0,
    currentMonthInput: 0,
    currentMonthCache: 0,
    currentMonthOutput: 0,
    callCount: 0,
    totalSteps: 0,
    totalConversations: 0,
    activeDaysCount: 0,
    firstUseDate: null,
    keepaliveRequests: 0,
    keepaliveTokens: 0,
    sources: { desktop: 0, cli: 0, agent: 0, ide: 0 },
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {}, legacyUnallocated: {} },
    dailyModelMapBySource: { all: {}, desktop: {}, cli: {} },
    modelMetaByKey: {},
    _convIds: new Set(),
    _cacheItems: [],
    _monthCacheItems: [],
    _calls: [],
    _monthCalls: [],
    _desktopCalls: [],
    _cliCalls: []
  });

  const byAccount = {};
  const unattributedCallsMap = new Map();
  const attributedByDayAll = {};
  const attributedByDayDesktop = {};
  const attributedByDayCli = {};
  const attributedModelByDay = { all: {}, desktop: {}, cli: {} };
  const attributedConvIds = new Set();
  const bucketMemo = new Map();

  const resolveCallModelBucket = (callObj) => {
    const memoKey = `${callObj.model || ''}\0${callObj.modelExactId || ''}\0${callObj.modelLabel || ''}\0${callObj.effort || ''}`;
    let bucket = bucketMemo.get(memoKey);
    if (!bucket) {
      bucket = resolveModelUsageBucket(callObj, compactModelConfigs, availableModelDetails);
      if (bucketMemo.size < 2000) bucketMemo.set(memoKey, bucket);
    }
    return bucket;
  };

  for (const [ledgerKey, call] of (Array.isArray(finalCallsEntries) ? finalCallsEntries : [])) {
    if (!call || typeof call !== 'object') continue;
    const scopeKey = (typeof call.accountScopeKey === 'string' && SCOPE_KEY_REGEX.test(call.accountScopeKey.trim()) && call.accountAttributionConfidence !== 'unattributed')
      ? call.accountScopeKey.trim()
      : 'unattributed';
    const dKey = resolveLedgerCallDate(ledgerKey, call) || todayKey;
    const u = getCallTokenBreakdown(call);
    const tot = u.tot || (u.inp + u.cap + u.out);
    if (tot <= 0 && !call.isKeepalive) continue;

    if (scopeKey === 'unattributed') {
      unattributedCallsMap.set(ledgerKey, { call, dKey, u, tot });
      continue;
    }

    if (!byAccount[scopeKey]) byAccount[scopeKey] = ensureAcct(scopeKey);
    const acc = byAccount[scopeKey];
    acc.callCount += 1;
    acc.totalSteps += 1;
    acc.totalInputTokens += u.inp;
    acc.totalCacheTokens += u.cap;
    acc.totalOutputTokens += u.out;
    acc.totalTokens += tot;
    if (!acc.firstUseDate || dKey < acc.firstUseDate) acc.firstUseDate = dKey;
    if (dKey === todayKey) acc.todayTokens += tot;
    if (dKey.startsWith(monthPrefix)) {
      acc.monthTokens += tot;
      acc.currentMonthInput += u.inp;
      acc.currentMonthCache += u.cap;
      acc.currentMonthOutput += u.out;
      acc._monthCacheItems.push({ inputTokens: u.inp, cacheReadTokens: u.cap, outputTokens: u.out, totalTokens: tot, hasInputCacheFields: true });
      acc._monthCalls.push(call);
    }
    if (dKey.startsWith(yearPrefix)) acc.yearTokens += tot;
    if (call.isKeepalive) {
      acc.keepaliveRequests += 1;
      acc.keepaliveTokens += tot;
    }

    const roleSrc = call.agentRole === 'subagent' ? 'agent' : (call.source === 'cli' ? 'cli' : (call.source === 'ide' ? 'ide' : 'desktop'));
    acc.sources[roleSrc] = (acc.sources[roleSrc] || 0) + 1;

    const srcKey = call.source === 'cli' ? 'cli' : 'desktop';
    const convKey = call.cascadeId ? `${srcKey}:${String(call.cascadeId).toLowerCase()}` : `call:${ledgerKey}`;
    acc._convIds.add(convKey);
    attributedConvIds.add(convKey);

    accumulateDayBucket(acc.dailyMap, dKey, u, tot, 1);
    accumulateDayBucket(acc.dailyMapBySource.all, dKey, u, tot, 1);
    accumulateDayBucket(acc.dailyMapBySource[srcKey], dKey, u, tot, 1);
    accumulateDayBucket(attributedByDayAll, dKey, u, tot, 1);
    accumulateDayBucket(srcKey === 'cli' ? attributedByDayCli : attributedByDayDesktop, dKey, u, tot, 1);

    const bucket = resolveCallModelBucket(call);
    const vKey = bucket.variantKey || UNATTRIBUTED_MODEL_KEY;
    if (bucket.isAttributed && vKey !== UNATTRIBUTED_MODEL_KEY) {
      acc.modelMetaByKey[vKey] = modelMetaByKey[vKey] || {
        modelKey: bucket.modelKey,
        modelLabel: bucket.modelLabel,
        variantKey: vKey,
        variantLabel: bucket.variantLabel
      };
    }
    accumulateModelDayBucket(acc.dailyModelMapBySource.all, dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(acc.dailyModelMapBySource[srcKey], dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(attributedModelByDay.all, dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(attributedModelByDay[srcKey], dKey, vKey, u, tot, 1);

    acc._cacheItems.push({ inputTokens: u.inp, cacheReadTokens: u.cap, outputTokens: u.out, totalTokens: tot, hasInputCacheFields: true });
    acc._calls.push(call);
    if (srcKey === 'cli') acc._cliCalls.push(call);
    else acc._desktopCalls.push(call);
  }

  for (const acc of Object.values(byAccount)) {
    acc.activeDaysCount = Object.keys(acc.dailyMap).length;
    acc.totalConversations = acc._convIds.size;
    acc.cacheReadStats = summarizeCacheReadStats(acc._cacheItems);
    acc.currentMonthCacheReadStats = summarizeCacheReadStats(acc._monthCacheItems);
    acc.cacheReadStatsBySource = {
      all: acc.cacheReadStats,
      desktop: summarizeDailyMapCacheStats(acc.dailyMapBySource.desktop),
      cli: summarizeDailyMapCacheStats(acc.dailyMapBySource.cli)
    };
    acc.currentMonthCacheReadStatsBySource = {
      all: acc.currentMonthCacheReadStats,
      desktop: summarizeDailyMapCacheStats(acc.dailyMapBySource.desktop, monthPrefix),
      cli: summarizeDailyMapCacheStats(acc.dailyMapBySource.cli, monthPrefix)
    };
    acc.costEstimate = summarizeApiCost(acc._calls, 0, {}, 0);
    acc.costEstimateCurrentMonth = summarizeApiCost(acc._monthCalls, 0, {}, 0);
    acc.costEstimateBySource = {
      all: acc.costEstimate,
      desktop: summarizeApiCost(acc._desktopCalls, 0, {}, 0),
      cli: summarizeApiCost(acc._cliCalls, 0, {}, 0)
    };
    acc.referenceCost = buildRefCostBundle(
      acc.totalInputTokens, acc.totalOutputTokens, acc.totalCacheTokens, acc.totalTokens,
      acc.currentMonthInput, acc.currentMonthOutput, acc.currentMonthCache, acc.monthTokens,
      acc.costEstimate, acc.costEstimateCurrentMonth
    );
    delete acc._convIds;
    delete acc._cacheItems;
    delete acc._monthCacheItems;
    delete acc._calls;
    delete acc._monthCalls;
    delete acc._desktopCalls;
    delete acc._cliCalls;
  }

  // 构建严格“未归属历史”视图：严格遵循「全量 - SUM(已归属账号)」守恒公式
  const unattributed = ensureAcct('unattributed');
  unattributed.unattributedReasonCounts = {};
  unattributed.unattributedReasonTokens = {};

  const subtractSourceDailyMap = (fullMap, attrMap, targetMap) => {
    for (const [dKey, rec] of Object.entries(fullMap || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const attr = attrMap[dKey] || { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
      const remInp = Math.max(0, Number(rec.input || 0) - attr.input);
      const remCap = Math.max(0, Number(rec.cache || 0) - attr.cache);
      const remOut = Math.max(0, Number(rec.output || 0) - attr.output);
      const remTot = Math.max(0, Number(rec.total || 0) - attr.total);
      const remSteps = Math.max(0, Number(rec.steps || rec.conversations || 0) - attr.steps);
      if (remTot <= 0 && remSteps <= 0) continue;
      targetMap[dKey] = { input: remInp, cache: remCap, output: remOut, total: remTot, steps: remSteps };
    }
  };

  subtractSourceDailyMap(dailyMapAll, attributedByDayAll, unattributed.dailyMap);
  unattributed.dailyMapBySource.all = unattributed.dailyMap;
  subtractSourceDailyMap(mergedDesktop, attributedByDayDesktop, unattributed.dailyMapBySource.desktop);
  subtractSourceDailyMap(mergedCli, attributedByDayCli, unattributed.dailyMapBySource.cli);
  unattributed.dailyMapBySource.legacyUnallocated = { ...(mergedLegacyUnallocated || {}) };

  for (const [dKey, rec] of Object.entries(unattributed.dailyMap)) {
    if (!unattributed.firstUseDate || dKey < unattributed.firstUseDate) unattributed.firstUseDate = dKey;
    unattributed.totalInputTokens += rec.input;
    unattributed.totalCacheTokens += rec.cache;
    unattributed.totalOutputTokens += rec.output;
    unattributed.totalTokens += rec.total;
    unattributed.callCount += rec.steps;
    unattributed.totalSteps += rec.steps;
    if (dKey === todayKey) unattributed.todayTokens += rec.total;
    if (dKey.startsWith(monthPrefix)) {
      unattributed.monthTokens += rec.total;
      unattributed.currentMonthInput += rec.input;
      unattributed.currentMonthCache += rec.cache;
      unattributed.currentMonthOutput += rec.output;
    }
    if (dKey.startsWith(yearPrefix)) unattributed.yearTokens += rec.total;
  }

  const subtractSourceModelMap = (srcName, authDailyMap) => {
    const fullSrcModel = dailyModelMapBySource?.[srcName] || {};
    const attrSrcModel = attributedModelByDay[srcName] || {};
    const out = {};
    for (const [dKey, authRec] of Object.entries(authDailyMap || {})) {
      if (!authRec || authRec.total <= 0) continue;
      const fullDay = fullSrcModel[dKey] || {};
      const attrDay = attrSrcModel[dKey] || {};
      const dayOut = {};
      let sumTot = 0, sumInp = 0, sumCap = 0, sumOut = 0, sumSteps = 0;
      for (const [vKey, fRec] of Object.entries(fullDay)) {
        const aRec = attrDay[vKey] || { total: 0, input: 0, cache: 0, output: 0, steps: 0 };
        const rTot = Math.max(0, Number(fRec.total || 0) - aRec.total);
        if (rTot <= 0) continue;
        const rInp = Math.max(0, Number(fRec.input || 0) - aRec.input);
        const rCap = Math.max(0, Number(fRec.cache || 0) - aRec.cache);
        const rOut = Math.max(0, Number(fRec.output || 0) - aRec.output);
        const rStp = Math.max(0, Number(fRec.steps || 0) - aRec.steps);
        dayOut[vKey] = { total: rTot, input: rInp, output: rOut, cache: rCap, steps: rStp };
        if (modelMetaByKey?.[vKey]) unattributed.modelMetaByKey[vKey] = modelMetaByKey[vKey];
        sumTot += rTot; sumInp += rInp; sumCap += rCap; sumOut += rOut; sumSteps += rStp;
      }
      const diffTot = Math.max(0, authRec.total - sumTot);
      if (diffTot > 0) {
        if (!dayOut[UNATTRIBUTED_MODEL_KEY]) {
          dayOut[UNATTRIBUTED_MODEL_KEY] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        dayOut[UNATTRIBUTED_MODEL_KEY].total += diffTot;
        dayOut[UNATTRIBUTED_MODEL_KEY].input += Math.max(0, authRec.input - sumInp);
        dayOut[UNATTRIBUTED_MODEL_KEY].cache += Math.max(0, authRec.cache - sumCap);
        dayOut[UNATTRIBUTED_MODEL_KEY].output += Math.max(0, authRec.output - sumOut);
        dayOut[UNATTRIBUTED_MODEL_KEY].steps += Math.max(0, authRec.steps - sumSteps);
      }
      if (Object.keys(dayOut).length > 0) out[dKey] = dayOut;
    }
    unattributed.dailyModelMapBySource[srcName] = out;
  };
  subtractSourceModelMap('all', unattributed.dailyMapBySource.all);
  subtractSourceModelMap('desktop', unattributed.dailyMapBySource.desktop);
  subtractSourceModelMap('cli', unattributed.dailyMapBySource.cli);

  const unattrCalls = [], unattrMonthCalls = [], unattrDesktopCalls = [], unattrCliCalls = [];
  for (const { call, dKey, tot } of unattributedCallsMap.values()) {
    const reason = call.unattributedReason || (call.source === 'ide' ? 'unverified_source_ide' : 'before_account_tracking');
    unattributed.unattributedReasonCounts[reason] = (unattributed.unattributedReasonCounts[reason] || 0) + 1;
    unattributed.unattributedReasonTokens[reason] = (unattributed.unattributedReasonTokens[reason] || 0) + tot;
    unattrCalls.push(call);
    if (dKey.startsWith(monthPrefix)) unattrMonthCalls.push(call);
    if (call.source === 'cli') unattrCliCalls.push(call);
    else unattrDesktopCalls.push(call);
  }

  unattributed.activeDaysCount = Object.keys(unattributed.dailyMap).length;
  unattributed.totalConversations = Math.max(0, (Number(totalConversationsAll) || unattributed.activeDaysCount) - attributedConvIds.size);
  unattributed.cacheReadStats = summarizeDailyMapCacheStats(unattributed.dailyMap);
  unattributed.currentMonthCacheReadStats = summarizeDailyMapCacheStats(unattributed.dailyMap, monthPrefix);
  unattributed.cacheReadStatsBySource = {
    all: unattributed.cacheReadStats,
    desktop: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.desktop),
    cli: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.cli)
  };
  unattributed.currentMonthCacheReadStatsBySource = {
    all: unattributed.currentMonthCacheReadStats,
    desktop: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.desktop, monthPrefix),
    cli: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.cli, monthPrefix)
  };
  unattributed.costEstimate = summarizeApiCost(
    unattrCalls,
    unpricedSummaryBySource?.all?.count || 0,
    unpricedSummaryBySource?.all?.reasons || {},
    unpricedSummaryBySource?.all?.tokens || 0
  );
  unattributed.costEstimateCurrentMonth = summarizeApiCost(
    unattrMonthCalls,
    unpricedSummaryBySource?.currentMonth?.count || 0,
    unpricedSummaryBySource?.currentMonth?.reasons || {},
    unpricedSummaryBySource?.currentMonth?.tokens || 0
  );
  unattributed.costEstimateBySource = {
    all: unattributed.costEstimate,
    desktop: summarizeApiCost(
      unattrDesktopCalls,
      unpricedSummaryBySource?.desktop?.count || 0,
      unpricedSummaryBySource?.desktop?.reasons || {},
      unpricedSummaryBySource?.desktop?.tokens || 0
    ),
    cli: summarizeApiCost(
      unattrCliCalls,
      unpricedSummaryBySource?.cli?.count || 0,
      unpricedSummaryBySource?.cli?.reasons || {},
      unpricedSummaryBySource?.cli?.tokens || 0
    )
  };
  unattributed.referenceCost = buildRefCostBundle(
    unattributed.totalInputTokens, unattributed.totalOutputTokens, unattributed.totalCacheTokens, unattributed.totalTokens,
    unattributed.currentMonthInput, unattributed.currentMonthOutput, unattributed.currentMonthCache, unattributed.monthTokens,
    unattributed.costEstimate, unattributed.costEstimateCurrentMonth
  );
  delete unattributed._convIds;
  delete unattributed._cacheItems;
  delete unattributed._monthCacheItems;
  delete unattributed._calls;
  delete unattributed._monthCalls;
  delete unattributed._desktopCalls;
  delete unattributed._cliCalls;

  return {
    byAccount,
    unattributed
  };
}

const CURRENT_ATTRIBUTION_REPAIR_VERSION = 'elv89-v3';
/**
 * 同一账本最多保留最近 N=3 份归属纠偏备份：
 * 1 份用于最近一次变更的即时回滚，另 2 份覆盖跨版本纠偏迁移，避免多实例与周期扫描导致磁盘无限膨胀。
 */
const MAX_LEDGER_REPAIR_BACKUPS = 3;
const LEDGER_BACKUP_CLEANUP_MARKER_VERSION = '0.8.9';

/**
 * 列出指定账本对应的 .bak-pre-elv89-* 备份文件（按时间从新到旧排序）
 */
function listLedgerRepairBackups(resolvedLedgerPath, fsImpl = fs) {
  const dir = path.dirname(resolvedLedgerPath);
  const prefix = `${path.basename(resolvedLedgerPath)}.bak-pre-elv89-`;
  if (!fsImpl.existsSync(dir)) return [];
  const entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const fullPath = path.join(dir, entry.name);
    const suffix = entry.name.slice(prefix.length);
    const numericTs = /^\d{10,16}$/.test(suffix) ? Number(suffix) : NaN;
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = fsImpl.statSync(fullPath);
      mtimeMs = Number(st.mtimeMs) || 0;
      size = Number(st.size) || 0;
    } catch { }
    items.push({ name: entry.name, path: fullPath, numericTs, mtimeMs, size });
  }
  items.sort((a, b) => {
    const aHasTs = Number.isFinite(a.numericTs);
    const bHasTs = Number.isFinite(b.numericTs);
    if (aHasTs && bHasTs && b.numericTs !== a.numericTs) return b.numericTs - a.numericTs;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
  return items;
}

/**
 * 裁剪同一账本的历史备份，只保留最新的 keep 份
 */
function pruneLedgerRepairBackups(resolvedLedgerPath, { keep = MAX_LEDGER_REPAIR_BACKUPS, fs: fsImpl = fs } = {}) {
  const keepCount = Math.max(0, Number.isFinite(Number(keep)) ? Math.floor(Number(keep)) : MAX_LEDGER_REPAIR_BACKUPS);
  const all = listLedgerRepairBackups(resolvedLedgerPath, fsImpl);
  const kept = all.slice(0, keepCount);
  const toRemove = all.slice(keepCount);
  const removed = [];
  let removedBytes = 0;
  for (const item of toRemove) {
    try {
      fsImpl.unlinkSync(item.path);
      removed.push(item.path);
      removedBytes += item.size;
    } catch { }
  }
  return {
    totalBefore: all.length,
    keptCount: kept.length,
    keptPaths: kept.map(x => x.path),
    removedCount: removed.length,
    removedPaths: removed,
    removedBytes
  };
}

/**
 * 升级时清理历史堆积的 .bak-pre-elv89-* 备份，只保留最新 1 份
 */
function cleanupUpgradeLedgerBackups({
  agDir = null,
  ledgerPath = null,
  stateDir = null,
  keep = 1,
  force = false,
  readOnly = false,
  fs: fsImpl = fs
} = {}) {
  const targetDir = ledgerPath || agDir;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));
  if (readOnly) {
    return { ok: true, skipped: true, reason: 'read_only', ledgerPath: resolvedLedgerPath, removedCount: 0 };
  }
  const markerDir = stateDir || path.dirname(resolvedLedgerPath);
  const markerPath = path.join(markerDir, '.pricing_ledger_backup_cleanup_v1.json');

  try {
    if (!force && fsImpl.existsSync(markerPath)) {
      const parsed = JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'));
      if (parsed && parsed.cleanedVersion === LEDGER_BACKUP_CLEANUP_MARKER_VERSION &&
          parsed.ledgerPath === resolvedLedgerPath) {
        return { ok: true, skipped: true, reason: 'already_cleaned', ledgerPath: resolvedLedgerPath, removedCount: 0 };
      }
    }
  } catch { }

  const existing = listLedgerRepairBackups(resolvedLedgerPath, fsImpl);
  if (existing.length <= Math.max(1, keep) && !force) {
    return {
      ok: true,
      skipped: false,
      ledgerPath: resolvedLedgerPath,
      totalBefore: existing.length,
      keptCount: existing.length,
      removedCount: 0,
      removedPaths: [],
      removedBytes: 0
    };
  }

  const pruneRes = pruneLedgerRepairBackups(resolvedLedgerPath, { keep, fs: fsImpl });
  try {
    fsImpl.mkdirSync(markerDir, { recursive: true });
    fsImpl.writeFileSync(markerPath, JSON.stringify({
      cleanedVersion: LEDGER_BACKUP_CLEANUP_MARKER_VERSION,
      ledgerPath: resolvedLedgerPath,
      cleanedAt: new Date().toISOString(),
      keptPaths: pruneRes.keptPaths,
      removedCount: pruneRes.removedCount
    }, null, 2));
  } catch { }

  return {
    ok: true,
    skipped: false,
    ledgerPath: resolvedLedgerPath,
    ...pruneRes
  };
}

/**
 * 幂等账本账号归属迁移与纠偏：
 * - 仅在账本内容确实发生变化时才对原 pricing_ledger_v1.json 做 .bak 备份，并按 N=3 上限轮转清理；
 * - 对带有精确时间戳且落在单一已核实 accountSessions 窗口内的记录准确归属；
 * - 剥离早于追踪起点、缺时间戳、IDE 未核实或跨切号边界却被错误标为当前账号的 accountScopeKey；
 * - 写入 attributionRepairVersion: CURRENT_ATTRIBUTION_REPAIR_VERSION，多次执行保持幂等不重复计数。
 */
function buildRepairAndMigrateLedgerExecutor({
  agDir = null,
  ledgerPath = null,
  accountSessions = [],
  force = false,
  dryRun = false,
  backupSuffix = null,
  maxBackups = MAX_LEDGER_REPAIR_BACKUPS,
  stateDir = null
} = {}) {
  const targetDir = ledgerPath || agDir;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));

  const runLocked = () => {
    if (!dryRun) {
      try {
        cleanupUpgradeLedgerBackups({ agDir, ledgerPath, stateDir, keep: 1 });
      } catch { }
    }
    ledgerCacheByPath.delete(normalizeLedgerKey(resolvedLedgerPath));
    const ledger = loadPricingLedger(targetDir);
    if (!ledger || ledger.__corrupted || ledger.__unreadable) {
      return { ok: false, error: ledger?.__error || '账本不可读或已损坏' };
    }
    const calls = ledger.calls || {};
    const nextCalls = { ...calls };

    const summarizeCounts = (map) => {
      const counts = { total: 0, attributed: {}, unattributed: 0 };
      for (const rec of Object.values(map)) {
        if (!rec || typeof rec !== 'object') continue;
        counts.total += 1;
        const sk = isValidAccountScopeKey(rec.accountScopeKey) && rec.accountAttributionConfidence !== 'unattributed'
          ? rec.accountScopeKey.trim()
          : null;
        if (sk) counts.attributed[sk] = (counts.attributed[sk] || 0) + 1;
        else counts.unattributed += 1;
      }
      return counts;
    };

    const before = summarizeCounts(calls);
    let updatedCount = 0;
    let clearedCount = 0;
    let attributedOrFixedCount = 0;
    let hasContentChange = false;
    const unattributedReasons = {};

    for (const [k, rec] of Object.entries(calls)) {
      if (!rec || typeof rec !== 'object') continue;
      if (!force && rec.attributionRepairVersion === CURRENT_ATTRIBUTION_REPAIR_VERSION) continue;

      const copy = { ...rec };
      const curScope = isValidAccountScopeKey(copy.accountScopeKey) && copy.accountAttributionConfidence !== 'unattributed'
        ? copy.accountScopeKey.trim()
        : null;

      // 保护极近期（3分钟内）实时确认的新增调用，避免在 transcript 落盘前或窗口同步间隙被误清除（不写入修复版本号以便稳定后复核）
      if (copy.accountAttributionConfidence === 'live_confirmed_account' && curScope && !force) {
        const obsMs = Number(copy.liveObservedAtMs) || (copy.updatedAt ? Date.parse(copy.updatedAt) : NaN) || Number(copy.timestamp);
        if (Number.isFinite(obsMs) && (Date.now() - obsMs) >= 0 && (Date.now() - obsMs) < 180000) {
          nextCalls[k] = copy;
          continue;
        }
      }

      // 显式保留用户/实验硬绑定的账号记录（keepalive / explicit email），其余均依据权威时间戳严格复核
      if (copy.isKeepalive && curScope && copy.accountAttributionConfidence === 'keepalive_bound') {
        if (copy.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION) {
          copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
          hasContentChange = true;
        }
        nextCalls[k] = copy;
        continue;
      }
      if (copy.accountEmail && typeof copy.accountEmail === 'string' && copy.accountEmail.includes('@')) {
        const nextScopeKey = buildAccountScopeKey(copy.accountEmail);
        const nextEvidence = copy.accountAttributionEvidence || 'call_account_email';
        if (
          copy.accountScopeKey !== nextScopeKey ||
          copy.accountAttributionConfidence !== 'explicit_account_email' ||
          copy.accountAttributionEvidence !== nextEvidence ||
          copy.unattributedReason !== undefined ||
          copy.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION
        ) {
          hasContentChange = true;
        }
        copy.accountScopeKey = nextScopeKey;
        copy.accountAttributionConfidence = 'explicit_account_email';
        copy.accountAttributionEvidence = nextEvidence;
        delete copy.unattributedReason;
        copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
        nextCalls[k] = copy;
        if (curScope !== copy.accountScopeKey) updatedCount++;
        continue;
      }

      const { startMs, endMs } = extractCallTimeBoundsMs(copy);
      const src = String(copy.source || 'desktop').toLowerCase();
      let verdict;
      if (src === 'ide') {
        verdict = { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'unverified_source_ide' };
      } else if (startMs != null) {
        verdict = matchTimestampAgainstSessions(startMs, endMs, src, accountSessions);
      } else {
        verdict = { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'missing_request_timestamp' };
      }

      if (verdict.accountScopeKey) {
        const nextEvidence = verdict.evidence || 'session_window_repair';
        if (curScope !== verdict.accountScopeKey || copy.accountAttributionConfidence !== 'repaired_session_window') {
          attributedOrFixedCount += 1;
          updatedCount += 1;
          hasContentChange = true;
        } else if (
          copy.accountAttributionEvidence !== nextEvidence ||
          copy.unattributedReason !== undefined ||
          copy.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION
        ) {
          hasContentChange = true;
        }
        copy.accountScopeKey = verdict.accountScopeKey;
        copy.accountAttributionConfidence = 'repaired_session_window';
        copy.accountAttributionEvidence = nextEvidence;
        delete copy.unattributedReason;
      } else {
        const nextReason = verdict.unattributedReason || 'before_account_tracking';
        if (curScope) {
          clearedCount += 1;
          updatedCount += 1;
          hasContentChange = true;
        } else if (copy.accountAttributionConfidence !== 'unattributed' || !copy.unattributedReason) {
          updatedCount += 1;
          hasContentChange = true;
        } else if (
          copy.accountScopeKey !== undefined ||
          copy.accountAttributionEvidence !== undefined ||
          copy.unattributedReason !== nextReason ||
          copy.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION
        ) {
          hasContentChange = true;
        }
        delete copy.accountScopeKey;
        copy.accountAttributionConfidence = 'unattributed';
        copy.unattributedReason = nextReason;
        delete copy.accountAttributionEvidence;
        unattributedReasons[copy.unattributedReason] = (unattributedReasons[copy.unattributedReason] || 0) + 1;
      }
      copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
      nextCalls[k] = copy;
    }

    const after = summarizeCounts(nextCalls);
    let backupPath = null;
    let prunedBackups = null;
    if (!dryRun && hasContentChange) {
      if (fs.existsSync(resolvedLedgerPath)) {
        const tsTag = backupSuffix || `${Date.now()}`;
        backupPath = `${resolvedLedgerPath}.bak-pre-elv89-${tsTag}`;
        fs.copyFileSync(resolvedLedgerPath, backupPath);
        prunedBackups = pruneLedgerRepairBackups(resolvedLedgerPath, { keep: maxBackups });
      }
      const draftLedger = {
        ...ledger,
        calls: nextCalls,
        updatedAt: new Date().toISOString()
      };
      const saveRes = savePricingLedger(draftLedger, targetDir);
      if (!saveRes.ok) {
        return { ok: false, error: saveRes.error || '修复后账本保存失败', backupPath };
      }
      try {
        syncAccountLedgerPartitions(resolvedLedgerPath, nextCalls, fs);
      } catch { }
      cachedTokenHistoryAt = 0;
    }

    return {
      ok: true,
      dryRun: Boolean(dryRun),
      changed: hasContentChange,
      ledgerPath: resolvedLedgerPath,
      backupPath,
      prunedBackups,
      updatedCount,
      clearedCount,
      attributedOrFixedCount,
      unattributedReasons,
      before,
      after
    };
  };

  return { resolvedLedgerPath, runLocked };
}

function repairAndMigrateAccountLedger(options = {}) {
  const { resolvedLedgerPath, runLocked } = buildRepairAndMigrateLedgerExecutor(options);
  return withFileLockSync(resolvedLedgerPath, runLocked, options.lockOptions);
}

async function repairAndMigrateAccountLedgerAsync(options = {}) {
  const { resolvedLedgerPath, runLocked } = buildRepairAndMigrateLedgerExecutor(options);
  return withFileLockAsync(resolvedLedgerPath, runLocked, options.lockOptions);
}

/**
 * 查询某账号在某模型共享池与指定时间区间内的本地实测消耗（专供 ELV-57 配额变化对照使用）
 */
function summarizeAccountWindowUsage({ agDir, ledgerPath, accountScopeKey, poolKey, startMs, endMs } = {}) {
  const targetDir = ledgerPath || agDir;
  const ledger = loadPricingLedger(targetDir);
  const calls = ledger?.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const start = Number(startMs) || 0;
  const end = Number(endMs) || Date.now();
  let requestCount = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let keepaliveRequests = 0;
  let keepaliveTokens = 0;

  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    if (accountScopeKey && call.accountScopeKey !== accountScopeKey) continue;
    if (call.accountAttributionConfidence === 'unattributed') continue;
    const ts = getCallSortTimestamp(call) ?? Number(call.timestamp) ?? (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(ts) || ts < start || ts > end) continue;
    if (poolKey) {
      const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
      const sharedKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || call.modelLabel || '') : null;
      const singlePoolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : null;
      if (sharedKey !== poolKey && singlePoolKey !== poolKey) continue;
    }
    const u = getCallTokenBreakdown(call);
    const tot = u.tot || (u.inp + u.cap + u.out);
    requestCount += 1;
    uncachedInputTokens += u.inp;
    cacheReadTokens += u.cap;
    outputTokens += u.out;
    totalTokens += tot;
    if (call.isKeepalive) {
      keepaliveRequests += 1;
      keepaliveTokens += tot;
    }
  }

  return {
    requestCount,
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    keepaliveRequests,
    keepaliveTokens
  };
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

  if (out.planTierOverride !== undefined) {
    const rawTier = String(out.planTierOverride || '').trim();
    if (!rawTier || rawTier.toLowerCase() === 'auto') {
      delete out.planTierOverride;
    } else {
      out.planTierOverride = rawTier;
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

function loadCustomPlanSettings(overridePathOrDir, options = {}) {
  const readOnly = Boolean(options?.readOnly);
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
      // 配置文件损坏时自动隔离备份并恢复默认结构，防止崩溃（只读模式绝不写盘）
      if (!readOnly) {
        try {
          const bakCorrupt = p.replace(/\.json$/i, '') + '.corrupt.bak.json';
          fs.copyFileSync(p, bakCorrupt);
        } catch { }
      }
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
  const targetDir = typeof options === 'string'
    ? options
    : (options?.targetDir || options?.agDir || options?.stateDir);
  const settings = loadCustomPlanSettings(targetDir);
  const email = options?.email || cachedTokenHistory?.planStatus?.email || null;
  const customPlan = resolveAccountCustomPlan(settings, email);
  const uiPrefs = settings.uiPreferences || {};
  const contextPreferences = settings.contextPreferences || {};
  const validDockPositions = new Set(['flow', 'fixed', 'aux', 'page', 'hide']);
  const validQuotaWindowModes = new Set(['auto', '5h', 'weekly', 'both']);
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    contextPreferences,
    contextScopeMode: settings.contextScopeMode || 'unified',
    contextUnifiedPreference: settings.contextUnifiedPreference || { mode: 'default', limitTokens: null },
    savedHeatView: uiPrefs.savedHeatView,
    autoCheckUpdate: uiPrefs.autoCheckUpdate,
    allowBetaUpdates: uiPrefs.allowBetaUpdates === true,
    dockPosition: validDockPositions.has(uiPrefs.dockPosition) ? uiPrefs.dockPosition : 'flow',
    quotaBadgeWindowMode: validQuotaWindowModes.has(uiPrefs.quotaBadgeWindowMode) ? uiPrefs.quotaBadgeWindowMode : 'auto',
    panelLanguage: uiPrefs.panelLanguage || 'zh-CN',
    cliAccountEmail: uiPrefs.cliAccountEmail || null,
    accounts: settings.accounts || {},
    updatedAt: settings.updatedAt || '',
    recoveredFromCorruption: Boolean(settings.recoveredFromCorruption)
  };
}

function savePluginSettings(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '无效的设置参数' };
  }
  const targetDir = typeof options === 'string'
    ? options
    : (options?.targetDir || options?.agDir || options?.stateDir || payload?.targetDir || payload?.agDir || payload?.stateDir);
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
    if (inputPlan.planTierOverride === null || inputPlan.planTierOverride === '' || String(inputPlan.planTierOverride).toLowerCase() === 'auto') {
      delete mergedRaw.planTierOverride;
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
  const validDockPositions = new Set(['flow', 'fixed', 'aux', 'page', 'hide']);
  const validQuotaWindowModes = new Set(['auto', '5h', 'weekly', 'both']);
  if (typeof payload.autoCheckUpdate === 'boolean') {
    topLevelUiPrefs.autoCheckUpdate = payload.autoCheckUpdate;
  }
  if (typeof payload.allowBetaUpdates === 'boolean') {
    topLevelUiPrefs.allowBetaUpdates = payload.allowBetaUpdates;
    cachedUpdateCheck = null;
    cachedUpdateCheckAt = 0;
  }
  if (typeof payload.dockPosition === 'string' && validDockPositions.has(payload.dockPosition)) {
    topLevelUiPrefs.dockPosition = payload.dockPosition;
  }
  if (typeof payload.quotaBadgeWindowMode === 'string' && validQuotaWindowModes.has(payload.quotaBadgeWindowMode)) {
    topLevelUiPrefs.quotaBadgeWindowMode = payload.quotaBadgeWindowMode;
  }
  if (typeof payload.panelLanguage === 'string' && validPanelLanguages.has(payload.panelLanguage)) {
    topLevelUiPrefs.panelLanguage = payload.panelLanguage;
  }
  if (typeof payload.cliAccountEmail === 'string') {
    topLevelUiPrefs.cliAccountEmail = payload.cliAccountEmail.trim() || null;
  } else if (payload.cliAccountEmail === null) {
    topLevelUiPrefs.cliAccountEmail = null;
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

const cachedUserStatusByOrigin = new Map();
const cachedQuotaStateByOrigin = new Map();
const activeQuotaFetchByOrigin = new Map();

function normalizeQuotaOriginScope(options = {}) {
  const raw = typeof options.origin === 'string' ? options.origin.trim() : '';
  return raw || '__default__';
}

function buildAccountScopeKey(emailOrId) {
  const raw = typeof emailOrId === 'string' ? emailOrId.trim().toLowerCase() : '';
  if (!raw) return 'anonymous';
  return 'acct_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function resetQuotaHostCacheForTest() {
  cachedUserStatusByOrigin.clear();
  cachedQuotaStateByOrigin.clear();
  activeQuotaFetchByOrigin.clear();
}

function classifyQuotaFetchError(err) {
  const msg = String(err?.message || err || '未知错误').trim();
  const lower = msg.toLowerCase();
  if (/enoent|devtoolsactiveport/i.test(lower)) {
    return { kind: 'network', message: '本地额度服务尚未就绪，请稍后重试' };
  }
  if (/timeout|timed out|etimedout|deadline/i.test(lower)) {
    return { kind: 'timeout', message: '请求语言服务超时' };
  }
  if (/econnrefused|econnreset|enotfound|not running|unreachable|network|socket|connect/i.test(lower)) {
    return { kind: 'network', message: '未能连接到 Antigravity 本地服务' };
  }
  if (/unauthorized|forbidden|401|403|csrf|鉴权/i.test(lower)) {
    return { kind: 'auth', message: '本地鉴权失败或已失效' };
  }
  return { kind: 'network', message: msg || '额度数据获取失败' };
}

/**
 * 并发拉取宿主模型额度池与可用模型详情，带多窗口 origin 隔离、并发去重、短缓存、失败分级及账号切换检测
 * @param {Object} options - 支持 force / origin / backendSource / userStatus / quotaSummary / connect 等参数
 */
async function fetchQuotaSnapshotFromHost(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const force = options.force === true;
  const hasStaticFixture = options.userStatus !== undefined || options.quotaSummary !== undefined || options.error !== undefined;
  const originScope = normalizeQuotaOriginScope(options);
  const backendSource = typeof options.backendSource === 'string' && options.backendSource.trim()
    ? options.backendSource.trim()
    : 'host';

  // 短缓存防刷（仅在非强制刷新且无静态测试桩时生效，15s 内复用同 origin 结果）
  const prevCachedQuota = cachedQuotaStateByOrigin.get(originScope) || null;
  if (!force && !hasStaticFixture && !options.agDir && prevCachedQuota && (nowMs - prevCachedQuota.fetchedAtMs < 15000)) {
    if (prevCachedQuota.backendSource === backendSource && prevCachedQuota.collectorVersion === PROJECT_VERSION) {
      return prevCachedQuota;
    }
    return {
      ...prevCachedQuota,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource
    };
  }

  // 如果已有相同 origin 请求进行中，直接合并等待，避免重复请求
  const activePromise = activeQuotaFetchByOrigin.get(originScope) || null;
  if (!hasStaticFixture && activePromise) {
    if (!force) return activePromise;
    try { await activePromise; } catch { }
  }

  const runFetch = async () => {
    let userStatusRes = null;
    let quotaSummaryRes = null;
    let fetchError = null;
    let errorKind = null;

    if (options.error) {
      const classified = classifyQuotaFetchError(options.error);
      fetchError = classified.message;
      errorKind = classified.kind;
    } else if (options.userStatus !== undefined || options.quotaSummary !== undefined) {
      userStatusRes = options.userStatus || null;
      quotaSummaryRes = options.quotaSummary || null;
    } else {
      try {
        const connector = typeof options.connect === 'function' ? options.connect : require('./local-api').connect;
        const connectOpts = {};
        if (options.origin) connectOpts.origin = options.origin;
        if (options.authBootstrap !== undefined) connectOpts.authBootstrap = options.authBootstrap;
        if (options.daemonDir) connectOpts.daemonDir = options.daemonDir;
        if (options.homeDir) connectOpts.homeDir = options.homeDir;
        if (typeof options.isPidAlive === 'function') connectOpts.isPidAlive = options.isPidAlive;
        if (options.allowDaemonFallback !== undefined) connectOpts.allowDaemonFallback = options.allowDaemonFallback;
        const api = await connector(Object.keys(connectOpts).length ? connectOpts : undefined);
        const [uRes, qRes] = await Promise.allSettled([
          api.call('GetUserStatus', {}),
          api.call('RetrieveUserQuotaSummary', {})
        ]);
        if (uRes.status === 'fulfilled' && uRes.value) {
          userStatusRes = uRes.value;
        }
        if (qRes.status === 'fulfilled' && qRes.value) {
          quotaSummaryRes = qRes.value;
        }
        if (!userStatusRes && !quotaSummaryRes) {
          const firstErr = uRes.status === 'rejected' ? uRes.reason : (qRes.status === 'rejected' ? qRes.reason : new Error('宿主未返回额度数据'));
          const classified = classifyQuotaFetchError(firstErr);
          fetchError = classified.message;
          errorKind = classified.kind;
        }
      } catch (e) {
        const classified = classifyQuotaFetchError(e);
        fetchError = classified.message;
        errorKind = classified.kind;
      }
    }

    const doneAtMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const rawConfigs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs
      || userStatusRes?.cascadeModelConfigData?.clientModelConfigs
      || [];
    const sanitizedConfigs = Array.isArray(rawConfigs)
      ? rawConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
      : [];
    const parsedPlan = userStatusRes ? parseUserPlanStatus(userStatusRes) : null;
    const rawEmail = parsedPlan?.email || userStatusRes?.userStatus?.email || '';
    const scopeQuotaState = cachedQuotaStateByOrigin.get(originScope) || null;
    const scopeUserEntry = cachedUserStatusByOrigin.get(originScope) || null;
    const prevAccountScopeKey = scopeUserEntry?.accountScopeKey || scopeQuotaState?.accountScopeKey || null;
    const nextScopeKey = rawEmail ? buildAccountScopeKey(rawEmail) : (prevAccountScopeKey || 'anonymous');

    // 账号切换检测：一旦发现同 origin 作用域下账号变化，立即清掉旧账号缓存，绝不跨账号残留旧额度
    const accountSwitched = Boolean(
      rawEmail &&
      prevAccountScopeKey &&
      nextScopeKey !== prevAccountScopeKey
    );
    if (accountSwitched) {
      cachedQuotaStateByOrigin.delete(originScope);
      cachedUserStatusByOrigin.delete(originScope);
    }
    if (rawEmail) {
      const existingEntry = cachedUserStatusByOrigin.get(originScope) || {};
      cachedUserStatusByOrigin.set(originScope, {
        ...existingEntry,
        accountScopeKey: nextScopeKey
      });
    }

    if (fetchError) {
      // 保留同 origin 同账号最后一次有效原始响应以产出 stale 状态；无旧数据时产出 error 状态
      const curScoped = cachedQuotaStateByOrigin.get(originScope) || null;
      const prevRaw = (!accountSwitched && curScoped?._raw) ? curScoped._raw : null;
      const snapshot = buildModelQuotaSnapshot({
        cascadeModelConfigs: prevRaw?.cascadeModelConfigs || [],
        quotaSummaryRes: prevRaw?.quotaSummaryRes || null,
        planStatus: prevRaw?.planStatus || null,
        currentModel: options.currentModel || null,
        browsePoolKey: options.browsePoolKey || null,
        fetchMeta: {
          fetchedAtMs: prevRaw?.fetchedAtMs || null,
          error: fetchError,
          errorKind
        },
        nowMs: doneAtMs
      });
      const out = {
        ok: false,
        collectorVersion: PROJECT_VERSION,
        backendVersion: PROJECT_VERSION,
        backendSource,
        originScope,
        accountScopeKey: prevRaw?.accountScopeKey || nextScopeKey,
        accountSwitched,
        fetchedAtMs: doneAtMs,
        lastSuccessAtMs: prevRaw?.fetchedAtMs || null,
        error: fetchError,
        errorKind,
        planTierSummary: prevRaw?.planStatus ? {
          status: prevRaw.planStatus.status,
          tierKey: prevRaw.planStatus.tierKey,
          tierId: prevRaw.planStatus.tierId || null,
          teamsTier: prevRaw.planStatus.teamsTier || null,
          tierName: prevRaw.planStatus.tierName || null,
          planName: prevRaw.planStatus.planName || null
        } : null,
        snapshot,
        _raw: prevRaw
      };
      if (!hasStaticFixture && !options.agDir && curScoped) {
        cachedQuotaStateByOrigin.set(originScope, { ...curScoped, error: fetchError, errorKind, snapshot });
      }
      return out;
    }

    const rawRecord = {
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      fetchedAtMs: doneAtMs,
      accountScopeKey: nextScopeKey
    };

    const snapshot = buildModelQuotaSnapshot({
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      currentModel: options.currentModel || null,
      browsePoolKey: options.browsePoolKey || null,
      fetchMeta: {
        fetchedAtMs: doneAtMs,
        error: null,
        errorKind: null
      },
      nowMs: doneAtMs
    });

    const out = {
      ok: true,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource,
      originScope,
      accountScopeKey: nextScopeKey,
      accountSwitched,
      fetchedAtMs: doneAtMs,
      lastSuccessAtMs: doneAtMs,
      error: null,
      errorKind: null,
      planTierSummary: parsedPlan ? {
        status: parsedPlan.status,
        tierKey: parsedPlan.tierKey,
        tierId: parsedPlan.tierId || null,
        teamsTier: parsedPlan.teamsTier || null,
        tierName: parsedPlan.tierName || null,
        planName: parsedPlan.planName || null
      } : null,
      snapshot,
      cascadeModelConfigs: sanitizedConfigs,
      _raw: rawRecord
    };

    if (!hasStaticFixture && !options.agDir) {
      cachedQuotaStateByOrigin.set(originScope, out);
    }
    return out;
  };

  if (!hasStaticFixture) {
    const p = runFetch().finally(() => {
      if (activeQuotaFetchByOrigin.get(originScope) === p) activeQuotaFetchByOrigin.delete(originScope);
    });
    activeQuotaFetchByOrigin.set(originScope, p);
    return p;
  }
  return runFetch();
}

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
  const originScope = normalizeQuotaOriginScope(options);
  const cachedEntry = cachedUserStatusByOrigin.get(originScope) || null;
  if (!options.agDir && !options.force && cachedEntry?.status && Date.now() - (cachedEntry.fetchedAt || 0) < 60000) {
    return cachedEntry.status;
  }
  try {
    const { connect } = require('./local-api');
    const connectOpts = {};
    if (options.origin) connectOpts.origin = options.origin;
    if (options.authBootstrap !== undefined) connectOpts.authBootstrap = options.authBootstrap;
    if (options.daemonDir) connectOpts.daemonDir = options.daemonDir;
    if (options.homeDir) connectOpts.homeDir = options.homeDir;
    if (typeof options.isPidAlive === 'function') connectOpts.isPidAlive = options.isPidAlive;
    if (options.allowDaemonFallback !== undefined) connectOpts.allowDaemonFallback = options.allowDaemonFallback;
    const api = await connect(Object.keys(connectOpts).length ? connectOpts : undefined);
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
      const nextScope = parsed.email ? buildAccountScopeKey(parsed.email) : null;
      const prevScope = cachedEntry?.accountScopeKey || null;
      if (nextScope && prevScope && nextScope !== prevScope) {
        cachedQuotaStateByOrigin.delete(originScope);
      }
      cachedUserStatusByOrigin.set(originScope, {
        status: parsed,
        fetchedAt: Date.now(),
        accountScopeKey: nextScope || prevScope || null
      });
    }
    return parsed;
  } catch {
    return cachedEntry?.status || null;
  }
}

let activeScanPromise = null;
let activeScanScope = '';
let cachedTokenHistoryScope = '';
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'tasks', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

const IGNORED_WSL_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine(?:-[a-z0-9_-]+)?)$/i;
const WSL_LXSS_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

function dedupeScanPaths(paths = [], platform = process.platform) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const pathMod = (platform === 'win32' || trimmed.startsWith('\\\\')) ? path.win32 : path;
    const resolved = pathMod.resolve(trimmed);
    const key = (platform === 'win32' || resolved.startsWith('\\\\')) ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * 解析 Windows 注册表 Lxss 导出内容，提取已安装且可用的 WSL 发行版
 * @param {string} rawText
 */
function parseLxssRegistryOutput(rawText = '') {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const distros = [];
  const seenNames = new Set();
  let current = null;

  const flush = () => {
    if (!current || !current.name) return;
    const name = current.name.trim();
    if (!name || IGNORED_WSL_DISTRO_RE.test(name)) return;
    if (current.state !== null && current.state !== 1) return;
    const key = name.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    distros.push({
      name,
      state: current.state,
      version: current.version,
      defaultUid: current.defaultUid
    });
  };

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:HKEY_CURRENT_USER|HKCU)\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\/i.test(trimmed)) {
      flush();
      current = { name: '', state: null, version: null, defaultUid: null };
      continue;
    }
    if (!current) continue;
    const nameMatch = trimmed.match(/^DistributionName\s+REG_SZ\s+(.+)$/i);
    if (nameMatch) {
      current.name = nameMatch[1].trim();
      continue;
    }
    const stateMatch = trimmed.match(/^State\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (stateMatch) {
      current.state = stateMatch[1] ? parseInt(stateMatch[1], 16) : parseInt(stateMatch[2], 10);
      continue;
    }
    const verMatch = trimmed.match(/^Version\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (verMatch) {
      current.version = verMatch[1] ? parseInt(verMatch[1], 16) : parseInt(verMatch[2], 10);
      continue;
    }
    const uidMatch = trimmed.match(/^DefaultUid\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (uidMatch) {
      current.defaultUid = uidMatch[1] ? parseInt(uidMatch[1], 16) : parseInt(uidMatch[2], 10);
    }
  }
  flush();
  return distros;
}

function listRegisteredWslDistros(options = {}) {
  if (Array.isArray(options.wslDistros)) {
    const out = [];
    const seen = new Set();
    for (const item of options.wslDistros) {
      const rawName = typeof item === 'string' ? item : item?.name;
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name || IGNORED_WSL_DISTRO_RE.test(name)) continue;
      const state = typeof item === 'object' && item && item.state !== undefined ? Number(item.state) : null;
      if (state !== null && Number.isFinite(state) && state !== 1) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        state: Number.isFinite(state) ? state : null,
        version: typeof item === 'object' && item ? (item.version ?? null) : null,
        defaultUid: typeof item === 'object' && item ? (item.defaultUid ?? null) : null
      });
    }
    return out;
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  try {
    const res = spawnSync('reg.exe', ['query', WSL_LXSS_REG_KEY, '/s'], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    return parseLxssRegistryOutput(res.stdout);
  } catch {
    return [];
  }
}

function resolveWslDistroUncRoot(distroName, options = {}) {
  const fsApi = options.fs || fs;
  const name = typeof distroName === 'string' ? distroName.trim() : '';
  if (!name) return null;
  for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
    const candidate = `${prefix}\\${name}`;
    try {
      if (fsApi.existsSync(path.win32.join(candidate, 'root')) || fsApi.existsSync(path.win32.join(candidate, 'home'))) {
        return candidate;
      }
    } catch { }
  }
  return null;
}

function collectGeminiDirsFromLinuxRoot(rootDir, options = {}) {
  const fsApi = options.fs || fs;
  const platform = options.platform || process.platform;
  const desktopDirs = [];
  const cliDirs = [];
  if (typeof rootDir !== 'string' || !rootDir.trim()) return { desktopDirs, cliDirs };
  const pathMod = (platform === 'win32' || rootDir.startsWith('\\\\')) ? path.win32 : path;

  const candidateHomes = [];
  const rootHome = pathMod.join(rootDir, 'root');
  try {
    if (fsApi.existsSync(rootHome)) candidateHomes.push(rootHome);
  } catch { }

  const homeParent = pathMod.join(rootDir, 'home');
  try {
    if (fsApi.existsSync(homeParent)) {
      for (const entry of fsApi.readdirSync(homeParent, { withFileTypes: true })) {
        const sub = pathMod.join(homeParent, entry.name);
        if (entry.isDirectory()) {
          candidateHomes.push(sub);
        } else if (entry.isSymbolicLink()) {
          try {
            if (fsApi.statSync(sub).isDirectory()) candidateHomes.push(sub);
          } catch { }
        }
      }
    }
  } catch { }

  const uniqueHomes = dedupeScanPaths(candidateHomes.map((h) => {
    try {
      return typeof fsApi.realpathSync === 'function' ? fsApi.realpathSync(h) : h;
    } catch {
      return h;
    }
  }), platform);

  for (const h of uniqueHomes) {
    const ag = pathMod.join(h, '.gemini', 'antigravity');
    const cli = pathMod.join(h, '.gemini', 'antigravity-cli');
    try {
      if (fsApi.existsSync(ag)) desktopDirs.push(ag);
    } catch { }
    try {
      if (fsApi.existsSync(cli)) cliDirs.push(cli);
    } catch { }
  }
  return {
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform)
  };
}

const WSL_DISCOVERY_CACHE_TTL_MS = 45000;
let wslDiscoveryCache = { scopeKey: '', at: 0, value: null };

function discoverWslGeminiDirs(options = {}) {
  const platform = options.platform || process.platform;
  if (options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1') {
    return { distros: [], roots: [], desktopDirs: [], cliDirs: [], skippedRoots: [] };
  }
  const hasExplicitPrimary = Boolean(options.agDir || options.agCliDir || process.env.AG_DIR || process.env.AG_CLI_DIR);
  const allowAutoDistros = options.includeWsl === true ||
    (platform === 'win32' && !hasExplicitPrimary && process.env.AG_METER_TEST_MODE !== '1');

  const distros = allowAutoDistros ? listRegisteredWslDistros(options) : [];
  const discoveredRoots = [];
  const skippedRoots = [];
  for (const d of distros) {
    try {
      const uncRoot = resolveWslDistroUncRoot(d.name, options);
      if (uncRoot) discoveredRoots.push(uncRoot);
      else skippedRoots.push({ target: d.name, reason: 'unreachable' });
    } catch (e) {
      skippedRoots.push({ target: d.name, reason: e?.code || e?.message || 'error' });
    }
  }
  const explicitRoots = Array.isArray(options.wslRoots) ? options.wslRoots : [];
  const roots = dedupeScanPaths([...discoveredRoots, ...explicitRoots], platform);

  const desktopDirs = [];
  const cliDirs = [];
  for (const r of roots) {
    try {
      const found = collectGeminiDirsFromLinuxRoot(r, options);
      desktopDirs.push(...found.desktopDirs);
      cliDirs.push(...found.cliDirs);
    } catch (e) {
      skippedRoots.push({ target: r, reason: e?.code || e?.message || 'error' });
    }
  }
  return {
    distros: distros.map(d => d.name),
    roots,
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform),
    skippedRoots
  };
}

/**
 * 带超时保护与缓存的异步 WSL 目录发现：
 * - 对慢 UNC/休眠发行版施加有界超时（默认 1500ms），不阻塞主循环或拖慢 UI；
 * - 不执行任何写入或主动拉起未运行发行版，权限不足/不可达时记录 skippedRoots 并安全跳过。
 */
async function discoverWslGeminiDirsAsync(options = {}) {
  const platform = options.platform || process.platform;
  if (options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1') {
    return { distros: [], roots: [], desktopDirs: [], cliDirs: [], skippedRoots: [] };
  }
  const hasCustomOverride = Boolean(options.fs || options.wslDistros || options.wslProbeFn || options.wslProbeTimeoutMs);
  const scopeKey = getEffectiveScanScopeKey(options);
  if (!hasCustomOverride && !options.force && wslDiscoveryCache.value && wslDiscoveryCache.scopeKey === scopeKey && (Date.now() - wslDiscoveryCache.at) < WSL_DISCOVERY_CACHE_TTL_MS) {
    return wslDiscoveryCache.value;
  }

  const hasExplicitPrimary = Boolean(options.agDir || options.agCliDir || process.env.AG_DIR || process.env.AG_CLI_DIR);
  const allowAutoDistros = options.includeWsl === true ||
    (platform === 'win32' && !hasExplicitPrimary && process.env.AG_METER_TEST_MODE !== '1');

  const distros = allowAutoDistros ? listRegisteredWslDistros(options) : [];
  const timeoutMs = Number.isFinite(Number(options.wslProbeTimeoutMs)) && Number(options.wslProbeTimeoutMs) > 0
    ? Number(options.wslProbeTimeoutMs)
    : 1500;
  const fsPromises = options.fs?.promises || fs.promises;
  const pathMod = platform === 'win32' ? path.win32 : path;

  const runWithBoundedTimeout = async (promiseFactory, targetLabel) => {
    let timer = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`WSL 探测超时 (${timeoutMs}ms): ${targetLabel}`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      return await Promise.race([promiseFactory(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const probeDistroAsync = async (d) => {
    if (typeof options.wslProbeFn === 'function') {
      return await runWithBoundedTimeout(() => Promise.resolve(options.wslProbeFn(d)), d.name);
    }
    if (options.fs && !options.fs.promises) {
      return resolveWslDistroUncRoot(d.name, options);
    }
    return await runWithBoundedTimeout(async () => {
      for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
        const candidate = `${prefix}\\${d.name}`;
        for (const sub of ['root', 'home']) {
          try {
            await fsPromises.access(pathMod.join(candidate, sub));
            return candidate;
          } catch { }
        }
      }
      return null;
    }, d.name);
  };

  const discoveredRoots = [];
  const skippedRoots = [];
  const probeResults = await Promise.all(distros.map(async (d) => {
    try {
      const root = await probeDistroAsync(d);
      return { name: d.name, root, error: null };
    } catch (e) {
      return { name: d.name, root: null, error: e };
    }
  }));

  for (const r of probeResults) {
    if (r.error) {
      skippedRoots.push({ target: r.name, reason: r.error.code === 'ETIMEDOUT' ? 'timeout' : (r.error.code || r.error.message || 'error') });
    } else if (r.root) {
      discoveredRoots.push(r.root);
    } else {
      skippedRoots.push({ target: r.name, reason: 'unreachable' });
    }
  }

  const explicitRoots = Array.isArray(options.wslRoots) ? options.wslRoots : [];
  const roots = dedupeScanPaths([...discoveredRoots, ...explicitRoots], platform);

  const desktopDirs = [];
  const cliDirs = [];
  for (const r of roots) {
    try {
      const found = await runWithBoundedTimeout(
        () => Promise.resolve(collectGeminiDirsFromLinuxRoot(r, options)),
        r
      );
      desktopDirs.push(...found.desktopDirs);
      cliDirs.push(...found.cliDirs);
    } catch (e) {
      skippedRoots.push({ target: r, reason: e?.code === 'ETIMEDOUT' ? 'timeout' : (e?.code || e?.message || 'error') });
    }
  }

  const result = {
    distros: distros.map(d => d.name),
    roots,
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform),
    skippedRoots
  };
  if (!hasCustomOverride) {
    wslDiscoveryCache = { scopeKey, at: Date.now(), value: result };
  }
  return result;
}

function resolvePrimaryGeminiDirs(options = {}) {
  const home = process.env.USERPROFILE || os.homedir();
  const explicitAg = options.agDir || process.env.AG_DIR || null;
  const agDir = explicitAg || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || (
    explicitAg
      ? path.join(path.dirname(path.resolve(explicitAg)), 'antigravity-cli')
      : path.join(home, '.gemini', 'antigravity-cli')
  );
  return { home, agDir, agCliDir };
}

function getEffectiveScanScopeKey(options = {}) {
  const resolved = resolvePrimaryGeminiDirs(options);
  const agDir = path.resolve(resolved.agDir);
  const agCliDir = path.resolve(resolved.agCliDir);
  const extraDesk = dedupeScanPaths(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []);
  const extraCli = dedupeScanPaths(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []);
  const wslRoots = dedupeScanPaths(Array.isArray(options.wslRoots) ? options.wslRoots : []);
  const wslFlag = options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1'
    ? 'wsl=0'
    : (options.includeWsl === true ? 'wsl=1' : 'wsl=auto');
  const parts = [agDir, agCliDir, wslFlag, ...extraDesk, ...extraCli, ...wslRoots];
  return process.platform === 'win32'
    ? parts.map(p => p.toLowerCase()).join('|')
    : parts.join('|');
}

function isFsMonkeyPatched() {
  return fs.readFileSync !== origFsMethods.readFileSync ||
    fs.writeFileSync !== origFsMethods.writeFileSync ||
    fs.copyFileSync !== origFsMethods.copyFileSync ||
    fs.renameSync !== origFsMethods.renameSync ||
    fs.readdirSync !== origFsMethods.readdirSync ||
    fs.statSync !== origFsMethods.statSync ||
    fs.existsSync !== origFsMethods.existsSync;
}

function captureCollectorEnvSnapshot() {
  const snap = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') snap[k] = v;
  }
  return snap;
}

function cloneCollectorOptionsForWorker(options = {}) {
  const out = {};
  if (!options || typeof options !== 'object') return out;
  for (const [k, v] of Object.entries(options)) {
    if (k === '_inWorker' || k === 'fs' || k === 'hostFetcher') continue;
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function canUseHistoryWorker(options = {}) {
  if (!isMainThread || typeof Worker !== 'function') return false;
  if (historyWorkerDisabled || options.useWorker === false || options._inWorker) return false;
  if (options.fs || options.hostFetcher) return false;
  if (Date.now !== origDateNow || isFsMonkeyPatched()) return false;
  return true;
}

let historyWorkerDisabled = false;
let historyWorkerConsecutiveErrors = 0;
let historyWorkerInstance = null;
let historyWorkerScriptPath = __filename;
let historyWorkerIdleTimer = null;
let historyWorkerReqId = 1;
const historyWorkerPending = new Map();
const HISTORY_WORKER_IDLE_MS = 45000;
const DEFAULT_HISTORY_WORKER_TIMEOUT_MS = 45000;

function clearAllHistoryWorkerPending(targetWorker = null, errReason = null) {
  for (const [id, entry] of historyWorkerPending.entries()) {
    if (targetWorker && entry.worker !== targetWorker) continue;
    historyWorkerPending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(errReason ? { _workerHandled: false, error: errReason } : null);
  }
}

function scheduleHistoryWorkerIdleCleanup() {
  if (historyWorkerIdleTimer) {
    clearTimeout(historyWorkerIdleTimer);
    historyWorkerIdleTimer = null;
  }
  if (!historyWorkerInstance || historyWorkerPending.size > 0) return;
  const idleMs = process.env.NODE_TEST_CONTEXT ? 120 : HISTORY_WORKER_IDLE_MS;
  historyWorkerIdleTimer = setTimeout(() => {
    historyWorkerIdleTimer = null;
    if (historyWorkerInstance && historyWorkerPending.size === 0) {
      const w = historyWorkerInstance;
      historyWorkerInstance = null;
      try { w.terminate(); } catch { }
    }
  }, idleMs);
  if (typeof historyWorkerIdleTimer.unref === 'function') historyWorkerIdleTimer.unref();
}

function getOrStartHistoryWorker(workerEntry = __filename) {
  const targetScript = workerEntry || __filename;
  if (historyWorkerInstance && historyWorkerScriptPath === targetScript) return historyWorkerInstance;
  if (historyWorkerInstance && historyWorkerScriptPath !== targetScript) {
    const oldW = historyWorkerInstance;
    historyWorkerInstance = null;
    clearAllHistoryWorkerPending(oldW, 'worker_replaced');
    try { oldW.terminate(); } catch { }
  }
  historyWorkerScriptPath = targetScript;
  const w = new Worker(targetScript, {
    workerData: { agCollectorHistoryWorker: true }
  });
  w.on('message', (msg) => {
    if (!msg || !msg.id) return;
    const entry = historyWorkerPending.get(msg.id);
    if (!entry) return;
    historyWorkerPending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    historyWorkerConsecutiveErrors = 0;
    if (historyWorkerPending.size === 0) {
      try { w.unref(); } catch { }
    }
    scheduleHistoryWorkerIdleCleanup();
    if (msg.ok) entry.resolve({ _workerHandled: true, result: msg.result });
    else entry.resolve({ _workerHandled: false, error: msg.error || 'Worker 执行失败' });
  });
  w.on('error', (err) => {
    historyWorkerConsecutiveErrors++;
    if (historyWorkerConsecutiveErrors >= 3) {
      historyWorkerDisabled = true;
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, err?.message || 'worker_error');
    try { w.terminate(); } catch { }
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      let hadPending = false;
      for (const entry of historyWorkerPending.values()) {
        if (entry.worker === w) { hadPending = true; break; }
      }
      if (hadPending) {
        historyWorkerConsecutiveErrors++;
        if (historyWorkerConsecutiveErrors >= 3) {
          historyWorkerDisabled = true;
        }
      }
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, code !== 0 ? `worker_exit_${code}` : null);
  });
  // Node.js v24 注册 message 监听会隐式 ref 底层 MessagePort，必须在全部监听绑定之后再 unref
  try { w.unref(); } catch { }
  historyWorkerInstance = w;
  return w;
}

let recordCallsAsyncQueue = Promise.resolve();

function invalidateHostLedgerAndHistoryCaches() {
  ledgerCacheByPath.clear();
  cachedTokenHistory = null;
  cachedTokenHistoryAt = 0;
}

/**
 * 异步入账模型调用记录（优先交由后台 Worker 线程执行大账本读写与合并，保持串行无竞态并零阻塞主进程事件循环）
 * @param {Array<object>} newCalls
 * @param {object|string} options
 */
async function recordModelCallsAsync(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return { ok: true, changed: false };
  const optsObj = typeof options === 'string' ? { agDir: options } : (options && typeof options === 'object' ? options : {});
  const task = recordCallsAsyncQueue.then(async () => {
    if (canUseHistoryWorker(optsObj)) {
      const workerResp = await runHistoryWorkerTask({
        newCalls,
        options: cloneCollectorOptionsForWorker(optsObj)
      }, 'recordModelCalls', optsObj);
      if (workerResp && workerResp._workerHandled) {
        const res = workerResp.result;
        if (res && res.changed) {
          invalidateHostLedgerAndHistoryCaches();
        }
        return res;
      }
    }
    const res = await recordModelCallsLockedAsync(newCalls, optsObj);
    if (res && res.changed) {
      invalidateHostLedgerAndHistoryCaches();
    }
    return res;
  });
  recordCallsAsyncQueue = task.catch(() => { });
  return task;
}

async function runHistoryWorkerTask(payload, cmd = 'collectTokenHistory', taskOptions = {}) {
  try {
    if (historyWorkerIdleTimer) {
      clearTimeout(historyWorkerIdleTimer);
      historyWorkerIdleTimer = null;
    }
    const workerEntry = (taskOptions && taskOptions._historyWorkerScript) || __filename;
    const timeoutMs = Number.isFinite(Number(taskOptions?.workerTimeoutMs)) && Number(taskOptions.workerTimeoutMs) > 0
      ? Number(taskOptions.workerTimeoutMs)
      : DEFAULT_HISTORY_WORKER_TIMEOUT_MS;
    const w = getOrStartHistoryWorker(workerEntry);
    const id = historyWorkerReqId++;
    return await new Promise((resolve) => {
      const entry = { resolve, timer: null, worker: w };
      entry.timer = setTimeout(() => {
        if (!historyWorkerPending.has(id)) return;
        historyWorkerPending.delete(id);
        if (historyWorkerInstance === w) historyWorkerInstance = null;
        clearAllHistoryWorkerPending(w, `Worker 任务超时 (${timeoutMs}ms)`);
        try { w.terminate(); } catch { }
        resolve({ _workerHandled: false, error: `Worker 任务超时 (${timeoutMs}ms)`, timedOut: true });
      }, timeoutMs);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      historyWorkerPending.set(id, entry);
      try {
        try { w.ref(); } catch { }
        w.postMessage({ id, cmd, payload, env: captureCollectorEnvSnapshot() });
      } catch {
        historyWorkerPending.delete(id);
        if (historyWorkerPending.size === 0) {
          try { w.unref(); } catch { }
        }
        if (entry.timer) clearTimeout(entry.timer);
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

let cachedNodeDatabaseSync;

function getNodeDatabaseSync() {
  if (cachedNodeDatabaseSync !== undefined) return cachedNodeDatabaseSync;
  try {
    cachedNodeDatabaseSync = require('node:sqlite').DatabaseSync || null;
  } catch {
    cachedNodeDatabaseSync = null;
  }
  return cachedNodeDatabaseSync;
}

function buildSqliteUriWithQuery(dbPath, query) {
  const normalized = String(dbPath || '').replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (encoded.startsWith('//')) {
    return `file://${encoded}?${query}`;
  }
  return `file:///${encoded.replace(/^\/+/, '')}?${query}`;
}

/**
 * 构建 SQLite 只读 immutable URI，兼容 Windows 盘符、UNC (\\wsl.localhost\...) 与 POSIX 路径。
 * 必须显式使用 file:////wsl.localhost/...?immutable=1，否则 9P 共享目录会报 database is locked。
 * @param {string} dbPath
 * @returns {string}
 */
function buildSqliteImmutableUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'immutable=1');
}

function buildSqliteModeRoUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'mode=ro');
}

function readPbVarint(buf, offset, end = buf.length) {
  let value = 0;
  let multiplier = 1;
  let pos = offset;
  while (pos < end && pos - offset < 10) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }
    multiplier *= 128;
  }
  return null;
}

function walkPbFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagInfo = readPbVarint(buf, pos, end);
    if (!tagInfo) break;
    pos = tagInfo.next;
    const fieldNum = Math.floor(tagInfo.value / 8);
    const wireType = tagInfo.value % 8;
    if (fieldNum <= 0) break;

    if (wireType === 0) {
      const valInfo = readPbVarint(buf, pos, end);
      if (!valInfo) break;
      pos = valInfo.next;
      onField(fieldNum, wireType, valInfo.value, 0, 0);
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
      onField(fieldNum, wireType, 0, pos - 8, pos);
    } else if (wireType === 2) {
      const lenInfo = readPbVarint(buf, pos, end);
      if (!lenInfo || lenInfo.value < 0) break;
      const valStart = lenInfo.next;
      const valEnd = valStart + lenInfo.value;
      if (valEnd > end) break;
      pos = valEnd;
      onField(fieldNum, wireType, 0, valStart, valEnd);
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
      onField(fieldNum, wireType, 0, pos - 4, pos);
    } else {
      break;
    }
  }
}

function parsePbDurationSec(buf, start, end) {
  let seconds = 0;
  let nanos = 0;
  let hasField = false;
  walkPbFields(buf, start, end, (fn, wt, val) => {
    if (wt !== 0) return;
    if (fn === 1) { seconds = val; hasField = true; }
    else if (fn === 2) { nanos = val; hasField = true; }
  });
  if (!hasField) return null;
  const secVal = seconds + nanos / 1e9;
  return Number.isFinite(secVal) && secVal >= 0 ? Number(secVal.toFixed(2)) : null;
}

/**
 * 从 gen_metadata.data 的 Protobuf 负载提取完整的步骤元数据（兼容模型 ID、展示标签、耗时、responseId 与父子关联）。
 */
function extractStepMetaFromGenMetadataBlob(rawData) {
  if (!rawData || !rawData.length) return [];
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const steps = [];
  let rawModel = '';
  let label = '';
  let modelEnum = '';
  let responseId = '';
  let ttftSec = null;
  let streamingSec = null;
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';

  walkPbFields(buf, 0, buf.length, (fn, wt, val, vs, ve) => {
    if (fn === 2) {
      if (wt === 0 && Number.isInteger(val) && val >= 0) {
        steps.push(val);
      } else if (wt === 2) {
        let p = vs;
        while (p < ve) {
          const item = readPbVarint(buf, p, ve);
          if (!item) break;
          if (Number.isInteger(item.value) && item.value >= 0) {
            steps.push(item.value);
          }
          p = item.next;
        }
      }
    } else if (fn === 1 && wt === 2) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 4) {
          walkPbFields(buf, cvs, cve, (ufn, uwt, _uval, uvs, uve) => {
            if (ufn === 7 && uwt === 2) {
              const str = buf.toString('utf8', uvs, uve).trim();
              if (str) responseId = str;
            }
          });
        } else if (cfn === 11) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) ttftSec = d;
        } else if (cfn === 12) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) streamingSec = d;
        } else if (cfn === 19) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) rawModel = str;
        } else if (cfn === 20) {
          let k = '';
          let v = '';
          walkPbFields(buf, cvs, cve, (kfn, kwt, _kval, kvs, kve) => {
            if (kwt !== 2) return;
            if (kfn === 1) k = buf.toString('utf8', kvs, kve).trim();
            else if (kfn === 2) v = buf.toString('utf8', kvs, kve).trim();
          });
          if (k === 'model_enum' && v) modelEnum = v;
          else if (k === 'parent_cascade_id' && v) parentCascadeId = v;
          else if (k === 'root_cascade_id' && v) rootCascadeId = v;
          else if (k === 'subagent_type' && v) subagentType = v;
        } else if (cfn === 21) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) label = str;
        }
      });
    }
  });

  const resolvedModel = label || rawModel || modelEnum;
  const resolvedExactId = modelEnum || rawModel || '';
  if (!steps.length) return [];
  if (!resolvedModel && !resolvedExactId && !responseId && ttftSec === null && streamingSec === null && !parentCascadeId && !rootCascadeId) {
    return [];
  }
  return steps.map(stepIndex => ({
    stepIndex,
    model: resolvedModel,
    rawModel,
    modelLabel: label,
    modelExactId: resolvedExactId,
    responseId,
    ttftSec,
    streamingSec,
    parentCascadeId,
    rootCascadeId,
    subagentType
  }));
}

/**
 * 从会话数据库 gen_metadata.data 的 Protobuf 负载提取 stepIndex -> model/label 映射（保持兼容旧签名）。
 * 顶层字段 2 为 stepIndices（单个 varint 或 packed varint），字段 1 内的 19 为 rawModel、21 为展示标签。
 * @param {Buffer|Uint8Array} rawData
 * @returns {Array<{stepIndex: number, model: string}>}
 */
function extractStepModelsFromGenMetadataBlob(rawData) {
  return extractStepMetaFromGenMetadataBlob(rawData)
    .filter(item => Boolean(item.model))
    .map(item => ({ stepIndex: item.stepIndex, model: item.model }));
}

function extractTrajectoryBlobMeta(rawData, selfCascadeId = '') {
  const out = { parentCascadeId: '', rootCascadeId: '', subagentType: '', subagentRole: '' };
  if (!rawData || !rawData.length) return out;
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const selfNorm = String(selfCascadeId || '').trim().toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  walkPbFields(buf, 0, buf.length, (fn, wt, _val, vs, ve) => {
    if (wt !== 2) return;
    if (fn === 4) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 1) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 64) out.subagentType = s;
        } else if (cfn === 2) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 120) out.subagentRole = s;
        }
      });
    } else if (fn === 5) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.parentCascadeId = s;
    } else if (fn === 6) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.rootCascadeId = s;
    }
  });
  return out;
}

const conversationDbMetaCache = new Map();
const MAX_CONVERSATION_DB_CACHE_ENTRIES = 500;

function getDbFileCacheSig(dbPath) {
  try {
    const stDb = origFsMethods.statSync(dbPath);
    if (!stDb.isFile()) return null;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    let walSize = 0;
    let walMtimeMs = 0;
    let hasWal = false;
    let hasShm = false;
    try {
      if (origFsMethods.existsSync(walPath)) {
        const stWal = origFsMethods.statSync(walPath);
        hasWal = stWal.isFile();
        walSize = stWal.size || 0;
        walMtimeMs = stWal.mtimeMs || 0;
      }
    } catch { }
    try {
      hasShm = origFsMethods.existsSync(shmPath) && origFsMethods.statSync(shmPath).isFile();
    } catch { }
    return {
      sig: `${stDb.size}:${stDb.mtimeMs}:${hasWal ? 1 : 0}:${walSize}:${walMtimeMs}:${hasShm ? 1 : 0}`,
      hasWal,
      walSize,
      hasShm
    };
  } catch {
    return null;
  }
}

/**
 * 严格只读且兼顾 WAL 一致性地读取会话 .db（不修改 .db / -wal / -shm，不以 immutable 绕过活跃锁读取撕裂页）：
 * - 当不存在非空 -wal 时，使用 ?immutable=1（零写零锁，且兼容 WSL UNC）；
 * - 当存在非空 -wal 且存在 -shm 时，使用 ?mode=ro（遵守 SQLite 锁读取一致 WAL 快照，不创建新伴生文件）；
 * - 当存在非空 -wal 但缺少 -shm 或只读受锁阻断时，安全降级返回空（保留未知，等待后续 checkpoint 后再回填）。
 */
function loadConversationDbMeta(dbPath, selfCascadeId = '') {
  const emptyResult = {
    stepMetaMap: new Map(),
    stepToModel: new Map(),
    parentCascadeId: '',
    rootCascadeId: '',
    subagentType: '',
    subagentRole: '',
    readMode: 'skipped',
    skippedReason: null
  };
  if (!dbPath || !origFsMethods.existsSync(dbPath)) {
    return { ...emptyResult, skippedReason: 'missing' };
  }
  const DatabaseSync = getNodeDatabaseSync();
  if (!DatabaseSync) {
    return { ...emptyResult, skippedReason: 'sqlite_unavailable' };
  }
  const sigInfo = getDbFileCacheSig(dbPath);
  if (!sigInfo) {
    return { ...emptyResult, skippedReason: 'stat_failed' };
  }

  const cacheKey = process.platform === 'win32' ? String(dbPath).toLowerCase() : String(dbPath);
  const cached = conversationDbMetaCache.get(cacheKey);
  if (cached && cached.sig === sigInfo.sig) {
    return cached.value;
  }

  let targetUri = null;
  let readMode = 'immutable';
  if (!sigInfo.hasWal || sigInfo.walSize === 0) {
    targetUri = buildSqliteImmutableUri(dbPath);
    readMode = 'immutable';
  } else if (sigInfo.hasShm) {
    targetUri = buildSqliteModeRoUri(dbPath);
    readMode = 'mode_ro_wal';
  } else {
    return { ...emptyResult, readMode: 'skipped', skippedReason: 'wal_without_shm' };
  }

  const stepMetaMap = new Map();
  const stepToModel = new Map();
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';
  let subagentRole = '';

  let db = null;
  try {
    db = new DatabaseSync(targetUri, { readOnly: true });
    try {
      const rows = db.prepare('SELECT data FROM gen_metadata').all();
      for (const row of rows) {
        const entries = extractStepMetaFromGenMetadataBlob(row?.data);
        for (const item of entries) {
          if (!item || !Number.isInteger(item.stepIndex)) continue;
          stepMetaMap.set(item.stepIndex, item);
          if (item.model) stepToModel.set(item.stepIndex, item.model);
          if (!parentCascadeId && item.parentCascadeId) parentCascadeId = item.parentCascadeId;
          if (!rootCascadeId && item.rootCascadeId) rootCascadeId = item.rootCascadeId;
          if (!subagentType && item.subagentType) subagentType = item.subagentType;
        }
      }
    } catch {
      // 忽略缺失 gen_metadata 表或非预期 schema
    }
    try {
      const tmbRows = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 2').all();
      for (const row of tmbRows) {
        const tm = extractTrajectoryBlobMeta(row?.data, selfCascadeId);
        if (!parentCascadeId && tm.parentCascadeId) parentCascadeId = tm.parentCascadeId;
        if (!rootCascadeId && tm.rootCascadeId) rootCascadeId = tm.rootCascadeId;
        if (!subagentType && tm.subagentType) subagentType = tm.subagentType;
        if (!subagentRole && tm.subagentRole) subagentRole = tm.subagentRole;
      }
    } catch {
      // 旧库可能没有 trajectory_metadata_blob
    }
  } catch (err) {
    return {
      ...emptyResult,
      readMode: 'skipped',
      skippedReason: err?.code || err?.message || 'sqlite_open_error'
    };
  } finally {
    if (db) {
      try { db.close(); } catch { }
    }
  }

  const out = {
    stepMetaMap,
    stepToModel,
    parentCascadeId,
    rootCascadeId,
    subagentType,
    subagentRole,
    readMode,
    skippedReason: null
  };
  if (conversationDbMetaCache.size >= MAX_CONVERSATION_DB_CACHE_ENTRIES) {
    const oldest = conversationDbMetaCache.keys().next().value;
    if (oldest) conversationDbMetaCache.delete(oldest);
  }
  conversationDbMetaCache.set(cacheKey, { sig: sigInfo.sig, value: out });
  return out;
}

function loadStepModelMapFromSqlite(dbPath) {
  return loadConversationDbMeta(dbPath).stepToModel;
}

function needsDbLabelEnrichment(rec) {
  if (!rec || !(rec.tot > 0)) return false;
  if (!rec.model) return true;
  if (/^model_/i.test(rec.model)) return true;
  if (!rec.modelLabel && !/[A-Z\s()]/.test(rec.model)) return true;
  return false;
}

function backfillMissingModelsFromConversationDb(records, convDir, options = {}) {
  if (!Array.isArray(records) || !records.length || !convDir || options.fs || isFsMonkeyPatched()) return 0;

  const targetByCascade = new Map();
  for (const rec of records) {
    if (!rec || !(rec.tot > 0)) continue;
    const needsLabel = needsDbLabelEnrichment(rec);
    const needsMeta = !rec.modelExactId || rec.ttftSec == null || rec.streamingSec == null;
    if (!needsLabel && !needsMeta) continue;
    if (!Number.isInteger(rec.stepIndex) || rec.stepIndex < 0) continue;
    const cid = String(rec.cascadeId || '').trim();
    if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) continue;
    let list = targetByCascade.get(cid);
    if (!list) {
      list = [];
      targetByCascade.set(cid, list);
    }
    list.push(rec);
  }
  if (targetByCascade.size === 0) return 0;

  let filledCount = 0;
  for (const [cid, recs] of targetByCascade.entries()) {
    const dbPath = path.join(convDir, `${cid}.db`);
    const dbMeta = loadConversationDbMeta(dbPath, cid);
    if (dbMeta.stepMetaMap.size === 0) continue;
    for (const rec of recs) {
      const recovered = dbMeta.stepMetaMap.get(rec.stepIndex);
      if (!recovered) continue;
      let modelOrLabelFilled = false;
      if (recovered.model && (!rec.model || (/^model_/i.test(rec.model) && recovered.model !== rec.model))) {
        rec.model = recovered.model;
        modelOrLabelFilled = true;
      }
      if (!rec.modelExactId && recovered.modelExactId) {
        rec.modelExactId = recovered.modelExactId;
      }
      const recoveredLabel = recovered.modelLabel || (recovered.model && /[A-Z\s()]/.test(recovered.model) ? recovered.model : '');
      if (!rec.modelLabel && recoveredLabel) {
        rec.modelLabel = recoveredLabel;
        modelOrLabelFilled = true;
      }
      if (modelOrLabelFilled) filledCount++;
      if (rec.ttftSec == null && recovered.ttftSec != null) {
        rec.ttftSec = recovered.ttftSec;
      }
      if (rec.streamingSec == null && recovered.streamingSec != null) {
        rec.streamingSec = recovered.streamingSec;
      }
      if (!rec.responseId && recovered.responseId) {
        rec.responseId = recovered.responseId;
      }
      if (!rec.parentCascadeId && (recovered.parentCascadeId || dbMeta.parentCascadeId)) {
        rec.parentCascadeId = recovered.parentCascadeId || dbMeta.parentCascadeId;
      }
      if (!rec.rootCascadeId && (recovered.rootCascadeId || dbMeta.rootCascadeId)) {
        rec.rootCascadeId = recovered.rootCascadeId || dbMeta.rootCascadeId;
      }
      if (!rec.subagentType && (recovered.subagentType || dbMeta.subagentType)) {
        rec.subagentType = recovered.subagentType || dbMeta.subagentType;
      }
    }
  }
  return filledCount;
}

function mergeModelDailyMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [dateKey, modelRecs] of Object.entries(m)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !modelRecs || typeof modelRecs !== 'object') continue;
      if (!out[dateKey]) out[dateKey] = {};
      for (const [mKey, rec] of Object.entries(modelRecs)) {
        if (!rec || typeof rec !== 'object') continue;
        if (!out[dateKey][mKey]) {
          out[dateKey][mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        out[dateKey][mKey].total += Number(rec.total) || 0;
        out[dateKey][mKey].input += Number(rec.input) || 0;
        out[dateKey][mKey].output += Number(rec.output) || 0;
        out[dateKey][mKey].cache += Number(rec.cache) || 0;
        out[dateKey][mKey].steps += Number(rec.steps) || 0;
      }
    }
  }
  return out;
}

/**
 * 基于账本（含 RPC 富化模型）与未匹配 transcript 实时记录构建分来源按日按模型用量分布，
 * 并严格对齐 dailyMap 权威总额（未能归属模型的差额落入 UNATTRIBUTED_MODEL_KEY）。
 */
function buildDailyModelBreakdown(params) {
  const {
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs,
    availableModelDetails
  } = params;

  const modelMetaByKey = {};
  const archivedMetaByKey = (archiveV2?.modelMetaByKey && typeof archiveV2.modelMetaByKey === 'object')
    ? archiveV2.modelMetaByKey
    : {};
  const matchedModels = { desktop: {}, cli: {} };
  const extraModels = { desktop: {}, cli: {} };
  const bucketMemo = new Map();

  const addModelBucket = (srcMap, dateKey, callObj, inp, cap, outp, tot, steps = 1) => {
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    if (tot <= 0 && steps <= 0) return;
    const memoKey = `${callObj.model || ''}\0${callObj.modelExactId || ''}\0${callObj.modelLabel || ''}\0${callObj.effort || ''}`;
    let bucket = bucketMemo.get(memoKey);
    if (!bucket) {
      bucket = resolveModelUsageBucket(callObj, compactModelConfigs, availableModelDetails);
      if (bucketMemo.size < 2000) bucketMemo.set(memoKey, bucket);
    }
    const vKey = bucket.variantKey || UNATTRIBUTED_MODEL_KEY;
    if (bucket.isAttributed && vKey !== UNATTRIBUTED_MODEL_KEY) {
      modelMetaByKey[vKey] = {
        modelKey: bucket.modelKey,
        modelLabel: bucket.modelLabel,
        variantKey: vKey,
        variantLabel: bucket.variantLabel
      };
    }
    if (!srcMap[dateKey]) srcMap[dateKey] = {};
    if (!srcMap[dateKey][vKey]) {
      srcMap[dateKey][vKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    }
    srcMap[dateKey][vKey].total += tot;
    srcMap[dateKey][vKey].input += inp;
    srcMap[dateKey][vKey].output += outp;
    srcMap[dateKey][vKey].cache += cap;
    srcMap[dateKey][vKey].steps += steps;
  };

  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const srcKey = c.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
    const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
    const outp = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
    const tot = Number(c.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedLedgerKeys.has(ledgerKey) ? matchedModels[srcKey] : extraModels[srcKey], effDate, c, inp, cap, outp, tot, 1);
  }

  for (const r of recentRequests) {
    if (matchedTranscriptReqs && matchedTranscriptReqs.has(r)) continue;
    const srcKey = r.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(r.inputTokens) || 0;
    const cap = Number(r.cacheTokens ?? r.cacheReadTokens ?? 0) || 0;
    const outp = Number(r.outputTokens) || 0;
    const tot = Number(r.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedModels[srcKey], r.date, r, inp, cap, outp, tot, 1);
  }

  const appendScaledDayBuckets = (dayOut, srcDay, authTotal, state) => {
    if (!srcDay) return;
    for (const [mKey, rec] of Object.entries(srcDay)) {
      if (state.sumTot >= authTotal) break;
      const takeTot = Math.min(rec.total, authTotal - state.sumTot);
      const ratio = rec.total > 0 ? takeTot / rec.total : 0;
      if (!dayOut[mKey]) dayOut[mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
      const addInp = takeTot === rec.total ? rec.input : Math.round(rec.input * ratio);
      const addOut = takeTot === rec.total ? rec.output : Math.round(rec.output * ratio);
      const addCap = takeTot === rec.total ? rec.cache : Math.max(0, takeTot - addInp - addOut);
      dayOut[mKey].total += takeTot;
      dayOut[mKey].input += addInp;
      dayOut[mKey].output += addOut;
      dayOut[mKey].cache += addCap;
      dayOut[mKey].steps += rec.steps;
      state.sumTot += takeTot;
      state.sumInp += addInp;
      state.sumOut += addOut;
      state.sumCap += addCap;
      state.sumSteps += rec.steps;
    }
  };

  const reconcileSourceMap = (srcKey, authDailyMap) => {
    const archivedModels = archiveV2?.dailyModelMapBySource?.[srcKey] || {};
    const outMap = {};
    const allDates = new Set([
      ...Object.keys(authDailyMap || {}),
      ...Object.keys(matchedModels[srcKey]),
      ...Object.keys(extraModels[srcKey])
    ]);
    for (const dateKey of allDates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const authRec = authDailyMap?.[dateKey];
      if (!authRec || Number(authRec.total) <= 0) continue;

      const dayOut = {};
      const scanDay = matchedModels[srcKey][dateKey];
      const extraDay = extraModels[srcKey][dateKey];
      const state = { sumTot: 0, sumInp: 0, sumOut: 0, sumCap: 0, sumSteps: 0 };

      if (scanDay || extraDay) {
        appendScaledDayBuckets(dayOut, scanDay, authRec.total, state);
        appendScaledDayBuckets(dayOut, extraDay, authRec.total, state);
      } else if (archivedModels[dateKey]) {
        for (const [mKey, rec] of Object.entries(archivedModels[dateKey])) {
          if (!rec || typeof rec !== 'object') continue;
          const addTot = Number(rec.total) || 0;
          const addInp = Number(rec.input) || 0;
          const addOut = Number(rec.output) || 0;
          const addCap = Number(rec.cache) || 0;
          const addSteps = Number(rec.steps) || 0;
          let effKey = mKey;
          if (mKey !== UNATTRIBUTED_MODEL_KEY) {
            const oldMeta = archivedMetaByKey[mKey] || null;
            const probeLabel = oldMeta?.variantLabel || oldMeta?.modelLabel || '';
            const reBucket = resolveModelUsageBucket(
              { model: mKey, ...(probeLabel ? { modelLabel: probeLabel } : {}) },
              compactModelConfigs,
              availableModelDetails
            );
            effKey = reBucket.variantKey || mKey;
            if (reBucket.isAttributed && effKey !== UNATTRIBUTED_MODEL_KEY) {
              modelMetaByKey[effKey] = {
                modelKey: reBucket.modelKey,
                modelLabel: reBucket.modelLabel,
                variantKey: effKey,
                variantLabel: reBucket.variantLabel
              };
            } else if (oldMeta && !modelMetaByKey[effKey]) {
              modelMetaByKey[effKey] = oldMeta;
            }
          }
          if (!dayOut[effKey]) dayOut[effKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
          dayOut[effKey].total += addTot;
          dayOut[effKey].input += addInp;
          dayOut[effKey].output += addOut;
          dayOut[effKey].cache += addCap;
          dayOut[effKey].steps += addSteps;
          state.sumTot += addTot;
          state.sumInp += addInp;
          state.sumOut += addOut;
          state.sumCap += addCap;
          state.sumSteps += addSteps;
        }
      }

      const diffTot = Math.max(0, (Number(authRec.total) || 0) - state.sumTot);
      if (diffTot > 0) {
        if (!dayOut[UNATTRIBUTED_MODEL_KEY]) {
          dayOut[UNATTRIBUTED_MODEL_KEY] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        dayOut[UNATTRIBUTED_MODEL_KEY].total += diffTot;
        dayOut[UNATTRIBUTED_MODEL_KEY].input += Math.max(0, (Number(authRec.input) || 0) - state.sumInp);
        dayOut[UNATTRIBUTED_MODEL_KEY].output += Math.max(0, (Number(authRec.output) || 0) - state.sumOut);
        dayOut[UNATTRIBUTED_MODEL_KEY].cache += Math.max(0, (Number(authRec.cache) || 0) - state.sumCap);
        dayOut[UNATTRIBUTED_MODEL_KEY].steps += Math.max(0, (Number(authRec.steps) || 0) - state.sumSteps);
      }

      if (Object.keys(dayOut).length > 0) outMap[dateKey] = dayOut;
    }
    return outMap;
  };

  const desktopModelMap = reconcileSourceMap('desktop', mergedDesktop);
  const cliModelMap = reconcileSourceMap('cli', mergedCli);
  const unallocatedModelMap = {};
  for (const [dateKey, rec] of Object.entries(mergedLegacyUnallocated || {})) {
    if (!rec || Number(rec.total) <= 0) continue;
    unallocatedModelMap[dateKey] = { [UNATTRIBUTED_MODEL_KEY]: { ...rec } };
  }
  const allModelMap = mergeModelDailyMaps(desktopModelMap, cliModelMap, unallocatedModelMap);

  return {
    dailyModelMapBySource: {
      all: allModelMap,
      desktop: desktopModelMap,
      cli: cliModelMap
    },
    modelMetaByKey
  };
}

/**
 * 历史用量与账本聚合核心逻辑（支持在 Worker 线程或主线程直接运行）
 * @param {object} options
 * @param {object} extraContext
 */
async function collectTokenHistoryCoreAsync(options = {}, extraContext = {}) {
  const { home, agDir, agCliDir } = resolvePrimaryGeminiDirs(options);

  const archivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');

  // 1. 读取旧 v1 归档（非只读模式下首次迁移生成 .bak 备份）
  const bakPathV1 = path.join(agDir, 'token_usage_archive_v1.bak.json');
  const readV1 = safeReadJsonSync(archivePathV1, null, {
    backupPath: bakPathV1,
    quarantineCorrupt: !options.readOnly
  });
  let legacyV1Archive = { firstUseDate: null, dailyMap: {}, maxConversations: 0 };
  if (readV1.exists) {
    if (readV1.ok && readV1.data && typeof readV1.data === 'object') {
      legacyV1Archive = readV1.data;
      if (!options.readOnly && !fs.existsSync(bakPathV1)) {
        try { fs.copyFileSync(archivePathV1, bakPathV1); } catch { }
      }
    }
  }

  // 2. 读取已有的 v2 归档
  const bakPathV2 = path.join(agDir, 'token_usage_archive_v2.bak.json');
  const readV2 = safeReadJsonSync(archivePathV2, null, {
    backupPath: bakPathV2,
    quarantineCorrupt: !options.readOnly
  });
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
      if (!options.readOnly && !fs.existsSync(bakPathV2)) {
        try { fs.copyFileSync(archivePathV2, bakPathV2); } catch { }
      }
    }
  }

  let earliestDate = archiveV2.firstUseDate || legacyV1Archive.firstUseDate || null;
  const registerDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
    }
  };

  // 3. 扫描桌面端与 CLI 会话文件（含 Windows 异步探测的 WSL 发行版目录，忽略伴生文件并仅对标准 UUID 跨根去重）
  const extraWsl = await discoverWslGeminiDirsAsync(options);
  const desktopAgDirs = dedupeScanPaths([
    agDir,
    ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []),
    ...extraWsl.desktopDirs
  ]);
  const cliAgDirs = dedupeScanPaths([
    agCliDir,
    ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []),
    ...extraWsl.cliDirs
  ]);

  let desktopPbCount = 0;
  let cliPbCount = 0;
  const seenDesktopConvs = new Set();
  const seenCliConvs = new Set();
  const nonUuidConvDirsBySource = {
    desktop: new Map(),
    cli: new Map()
  };
  const UUID_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:db|pb)$/i;
  const scanSessionDir = (dir, sourceName, seenSet = null) => {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      const normDirKey = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionOrTempFile(name)) continue;
        if (!name.endsWith('.pb') && !name.endsWith('.db')) continue;
        const p = path.join(dir, name);
        const isUuid = UUID_SESSION_FILE_RE.test(name);
        let dedupeKey;
        if (isUuid) {
          dedupeKey = process.platform === 'win32' ? name.toLowerCase() : name;
        } else {
          // 非 UUID 会话不仅靠文件名合并，仅在真实路径相同时视作同一个文件，或后续通过共享 responseId 事件确认镜像
          let realFile = p;
          try { realFile = fs.realpathSync(p); } catch { }
          dedupeKey = process.platform === 'win32' ? realFile.toLowerCase() : realFile;
        }
        if (seenSet && seenSet.has(dedupeKey)) continue;
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            if (seenSet) seenSet.add(dedupeKey);
            count++;
            if (!isUuid) {
              const baseLower = name.replace(/\.(?:db|pb)$/i, '').toLowerCase();
              const dirMap = nonUuidConvDirsBySource[sourceName];
              if (dirMap) {
                if (!dirMap.has(baseLower)) dirMap.set(baseLower, new Set());
                dirMap.get(baseLower).add(normDirKey);
              }
            }
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerDate(formatLocalDateKey(new Date(ts)));
          }
        } catch { }
      }
    } catch { }
    return count;
  };

  for (const dDir of desktopAgDirs) {
    desktopPbCount += scanSessionDir(path.join(dDir, 'conversations'), 'desktop', seenDesktopConvs);
  }
  for (const cDir of cliAgDirs) {
    cliPbCount += scanSessionDir(path.join(cDir, 'conversations'), 'cli', seenCliConvs);
  }

  // 4. 多目录遍历扫描 transcript.jsonl（跳过 steps/scratch 重型目录，软链接与环路去重）
  const visitedRealDirs = new Set();
  const transcriptJobs = [];

  const walkTranscripts = (dir, sourceName, depth = 0, convDirPath = '') => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const normDir = path.resolve(dir);
      const normKey = process.platform === 'win32' ? normDir.toLowerCase() : normDir;
      if (visitedRealDirs.has(normKey)) return;
      visitedRealDirs.add(normKey);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const realKey = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              if (!visitedRealDirs.has(realKey)) {
                walkTranscripts(realTarget, sourceName, depth + 1, convDirPath);
              }
            } else if (entry.name === 'transcript.jsonl') {
              transcriptJobs.push({ path: realTarget, source: sourceName, convDir: convDirPath });
            }
          } catch { }
        } else if (entry.isDirectory()) {
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLogPath)) {
              transcriptJobs.push({ path: stdLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (fs.existsSync(directLogPath)) {
              transcriptJobs.push({ path: directLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkTranscripts(fullPath, sourceName, depth + 1, convDirPath);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ path: fullPath, source: sourceName, convDir: convDirPath });
        }
      }
    } catch { }
  };

  for (const dDir of desktopAgDirs) {
    const bDir = path.join(dDir, 'brain');
    if (fs.existsSync(bDir)) walkTranscripts(bDir, 'desktop', 0, path.join(dDir, 'conversations'));
  }
  for (const cDir of cliAgDirs) {
    const cbDir = path.join(cDir, 'brain');
    if (fs.existsSync(cbDir)) walkTranscripts(cbDir, 'cli', 0, path.join(cDir, 'conversations'));
  }

  // 5. 结构化 JSON 解析 transcript.jsonl（基于 size+mtimeMs 单文件增量缓存，去重并汇总）
  const scannedBySource = {
    desktop: {},
    cli: {}
  };
  const seenEvents = new Map();
  const recentRequests = [];

  for (let jIdx = 0; jIdx < transcriptJobs.length; jIdx++) {
    const job = transcriptJobs[jIdx];
    if (jIdx > 0 && jIdx % 15 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const st = fs.statSync(job.path);
      const cachedFile = transcriptFileCache.get(job.path);
      let fileRecords = null;

      if (cachedFile && cachedFile.size === st.size && cachedFile.mtimeMs === st.mtimeMs) {
        fileRecords = cachedFile.records;
      } else {
        fileRecords = [];
        const brainMatch = String(job.path).match(/[\\/]brain[\\/]([^\\/]+)[\\/]/i);
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

          let hasValidCreatedAt = false;
          if (event.created_at) {
            const d = new Date(event.created_at);
            if (!Number.isNaN(d.getTime())) {
              hasValidCreatedAt = true;
            }
          }
          if (!hasValidCreatedAt) continue;

          let inp = 0, outp = 0, cap = 0, thinking = 0;
          const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || '';
          const modelExactId = event.chatModel?.modelId || event.modelId || '';
          const modelLabel = event.chatModel?.modelDisplayName || '';

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
          if (tot > 0) {
            // 唯一事件标识去重 (避免复制/软链接/重复日志相加)
            const cascadeId = String(event.cascadeId || (brainMatch ? brainMatch[1] : path.basename(job.path, '.jsonl')));
            const rawStep = event.step_index ?? event.stepIndex;
            const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
            const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
            const fallbackScope = (event.cascadeId || brainMatch) ? cascadeId : job.path;
            const eventId = extractCallId(event, fallbackScope, stepIndex ?? i);

            fileRecords.push({
              eventId,
              cascadeId,
              stepIndex,
              model,
              ...(modelExactId ? { modelExactId } : {}),
              ...(modelLabel ? { modelLabel } : {}),
              inp,
              outp,
              cap,
              thinking,
              tot,
              created_at: event.created_at
            });
          } else {
            fileRecords.push({
              tot: 0,
              created_at: event.created_at
            });
          }
        }
        backfillMissingModelsFromConversationDb(fileRecords, job.convDir, options);
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      const jobConvNorm = job.convDir ? (process.platform === 'win32' ? path.resolve(job.convDir).toLowerCase() : path.resolve(job.convDir)) : '';
      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        const parsedDate = new Date(rec.created_at);
        if (Number.isNaN(parsedDate.getTime())) continue;
        const dateKey = formatLocalDateKey(parsedDate);
        registerDate(dateKey);
        if (!rec.tot || !rec.eventId) continue;

        const existingReq = seenEvents.get(rec.eventId);
        if (existingReq) {
          // 跨根重复事件绝不重复累加 Token；仅当新根回填/保留了更优模型标识时就地富化原记录
          if (getCollectorModelRank(rec.model) > getCollectorModelRank(existingReq.model)) {
            existingReq.model = rec.model;
            existingReq.modelKey = normalizeModelId(rec.model);
            const enrichedCost = calculateRequestApiCost(existingReq);
            existingReq.isPriced = enrichedCost.isPriced;
            existingReq.costUSD = enrichedCost.costUSD ?? 0;
          }
          if (!existingReq.modelExactId && rec.modelExactId) existingReq.modelExactId = rec.modelExactId;
          if (!existingReq.modelLabel && rec.modelLabel) existingReq.modelLabel = rec.modelLabel;
          // 若两个不同 convDir 下的非 UUID 同名会话共享同一真实 responseId（非 step 拼接键），证明是同一镜像会话
          if (
            !String(rec.eventId).includes('#') &&
            existingReq.source === job.source &&
            existingReq._convDirNorm &&
            jobConvNorm &&
            existingReq._convDirNorm !== jobConvNorm &&
            existingReq.cascadeId &&
            existingReq.cascadeId === rec.cascadeId &&
            !UUID_SESSION_FILE_RE.test(`${rec.cascadeId}.db`)
          ) {
            const baseLower = String(rec.cascadeId).toLowerCase();
            const mirrorKey = `${job.source}|${jobConvNorm}|${baseLower}`;
            const convDirSet = nonUuidConvDirsBySource[job.source]?.get(baseLower);
            if (convDirSet && convDirSet.has(existingReq._convDirNorm) && convDirSet.has(jobConvNorm) && !seenEvents.has(`__mirror_dedup:${mirrorKey}`)) {
              seenEvents.set(`__mirror_dedup:${mirrorKey}`, true);
              if (job.source === 'cli' && cliPbCount > 1) cliPbCount--;
              else if (job.source === 'desktop' && desktopPbCount > 1) desktopPbCount--;
            }
          }
          continue;
        }

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[dateKey]) {
          srcMap[dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[dateKey].total += rec.tot;
        srcMap[dateKey].input += rec.inp;
        srcMap[dateKey].output += rec.outp;
        srcMap[dateKey].cache += rec.cap;
        srcMap[dateKey].steps += 1;

        const modelKey = normalizeModelId(rec.model);
        const reqObj = {
          callId: rec.eventId,
          source: job.source,
          _convDirNorm: jobConvNorm,
          cascadeId: rec.cascadeId,
          stepIndex: rec.stepIndex,
          model: rec.model,
          ...(rec.modelExactId ? { modelExactId: rec.modelExactId } : {}),
          ...(rec.modelLabel ? { modelLabel: rec.modelLabel } : {}),
          modelKey,
          inputTokens: rec.inp,
          cacheTokens: rec.cap,
          cacheReadTokens: rec.cap,
          outputTokens: rec.outp,
          thinkingTokens: rec.thinking,
          totalTokens: rec.tot,
          status: 'final',
          isEstimated: false,
          date: dateKey,
          dateSource: 'transcript',
          dateIsProvisional: false,
          created_at: rec.created_at || null,
          timestamp: parsedDate.getTime()
        };
        const costCalc = calculateRequestApiCost(reqObj);
        reqObj.isPriced = costCalc.isPriced;
        reqObj.costUSD = costCalc.costUSD ?? 0;

        seenEvents.set(rec.eventId, reqObj);
        recentRequests.push(reqObj);
      }
    } catch { }
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
  let livePlanStatus = Object.prototype.hasOwnProperty.call(extraContext, 'livePlanStatus')
    ? extraContext.livePlanStatus
    : await fetchUserStatusFromHost(options);
  if (!livePlanStatus) {
    livePlanStatus = archiveV2.planStatus || parseUserPlanStatus(null);
  }

  const customSettingsAll = loadCustomPlanSettings(agDir, { readOnly: Boolean(options.readOnly) });
  const currentAccountKey = livePlanStatus?.email || archiveV2.planStatus?.email || null;
  const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);

  const effectivePlanStatus = resolveEffectivePlanStatus(livePlanStatus, currentCustom, {
    cachedLivePlan: archiveV2.planStatus,
    currentEmail: currentAccountKey
  });

  // 加载可用于历史补扫归属校验的账号活跃时段（仅在使用默认宿主目录或显式传入时读取，隔离测试不读宿主真实账号）
  let sessionWindowsForHistory = Array.isArray(extraContext.accountSessions)
    ? extraContext.accountSessions
    : (Array.isArray(options.accountSessions) ? options.accountSessions : null);
  let hasRealAccountStore = false;
  if (!sessionWindowsForHistory || !options.skipAutoRepair) {
    try {
      const defaultAgDir = path.resolve(path.join(os.homedir(), '.gemini', 'antigravity'));
      const isDefaultHostAg = path.resolve(agDir) === defaultAgDir;
      if (isDefaultHostAg || options.stateDir) {
        const { getStateDir } = require('./asar-engine');
        const stDir = options.stateDir || getStateDir();
        const acctStorePath = path.join(stDir, 'accounts_v1.json');
        if (fs.existsSync(acctStorePath)) {
          hasRealAccountStore = true;
          const parsedAcct = JSON.parse(fs.readFileSync(acctStorePath, 'utf8'));
          if (!sessionWindowsForHistory && Array.isArray(parsedAcct?.accountSessions) && parsedAcct.accountSessions.length > 0) {
            sessionWindowsForHistory = parsedAcct.accountSessions;
          }
        }
      } else if (Array.isArray(options.accountSessions) && options.accountSessions.length > 0) {
        hasRealAccountStore = true;
      }
    } catch { }
  }

  // 在任何 transcript 对齐或富化写入覆盖之前，先清理历史堆积的旧版本备份，并对未经历最新归属版本校验的账本执行幂等纠偏
  if (!options.readOnly && !options.skipAutoRepair && (!options.fs || options.fs === fs)) {
    try {
      cleanupUpgradeLedgerBackups({
        agDir,
        stateDir: options.stateDir || null,
        keep: 1
      });
    } catch { }
  }
  if (!options.readOnly && hasRealAccountStore && !options.skipAutoRepair && (!options.fs || options.fs === fs)) {
    try {
      const preRepairCalls = (loadPricingLedger(agDir).calls || {});
      const needsAttributionRepair = Object.values(preRepairCalls).some(rec =>
        rec &&
        typeof rec === 'object' &&
        rec.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION &&
        isValidAccountScopeKey(rec.accountScopeKey) &&
        rec.accountAttributionConfidence !== 'unattributed'
      );
      if (needsAttributionRepair) {
        await repairAndMigrateAccountLedgerAsync({
          agDir,
          stateDir: options.stateDir || null,
          accountSessions: Array.isArray(sessionWindowsForHistory) ? sessionWindowsForHistory : []
        });
      }
    } catch { }
  }

  // 结合持久化逐请求账本与本次扫描调用：先与既有账本做双阶段 1-to-1 对齐与富化，再仅将未匹配的已计价扫描请求落盘
  const ledgerReadOpt = options.readOnly ? { readOnly: true } : undefined;
  const initialCallsMap = loadPricingLedger(agDir, ledgerReadOpt).calls || {};
  const matchedTranscriptReqs = new Set();
  const matchedLedgerKeys = new Set();
  const callEffectiveDate = new Map();
  const reqsByCallId = new Map();
  const reqsByStepKey = new Map();

  for (const r of recentRequests) {
    if (r.callId) {
      const rId = String(r.callId);
      let list = reqsByCallId.get(rId);
      if (!list) { list = []; reqsByCallId.set(rId, list); }
      list.push(r);
    }
    if (r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const sKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`;
      let list = reqsByStepKey.get(sKey);
      if (!list) { list = []; reqsByStepKey.set(sKey, list); }
      list.push(r);
    }
  }

  // 统计每个 (source, cascadeId, stepIndex) 上的非合成账本调用数量，避免同步骤多条独立 responseId 错绑其它调用的用量
  const realLedgerCountByStepKey = new Map();
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c || !c.cascadeId) continue;
    const cidKey = String(c.callId || ledgerKey);
    if (isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId)) continue;
    const cSrc = c.source || 'desktop';
    const cCid = String(c.cascadeId).toLowerCase();
    for (const stIdx of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${cSrc}:${cCid}#${stIdx}`;
      realLedgerCountByStepKey.set(sKey, (realLedgerCountByStepKey.get(sKey) || 0) + 1);
    }
  }

  const takeUnmatchedReq = (list, predicate = null) => {
    if (!list) return null;
    for (const item of list) {
      if (matchedTranscriptReqs.has(item)) continue;
      if (predicate && !predicate(item)) continue;
      matchedTranscriptReqs.add(item);
      return item;
    }
    return null;
  };

  // 严格规则：仅允许“合成键 <-> 真实 ID”（或合成键之间）通过 stepIndex / 用量指纹兜底关联，严禁两条不同真实 ID 跨绑
  const canFallbackLink = (ledgerKey, c, cidKey, reqItem) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const rId = String(reqItem.callId || '');
    const rIsFallback = !rId || isStepFallbackCallId(rId, reqItem.cascadeId);
    return cIsFallback || rIsFallback;
  };

  const ledgerEnrichmentCalls = [];
  const inMemoryEnrichments = new Map();

  const applyTranscriptMatch = (ledgerKey, c, cidKey, matched) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const mId = String(matched.callId || '');
    const mIsFallback = !mId || isStepFallbackCallId(mId, matched.cascadeId);
    const targetCallId = (cIsFallback && !mIsFallback) ? mId : cidKey;

    const uC = getCallTokenBreakdown(c);
    const merged = mergeSameCallRecords(c, matched, targetCallId, null, false, true);
    const uMerged = getCallTokenBreakdown(merged);

    const keyChanged = targetCallId !== ledgerKey;
    const modelEnriched = getCollectorModelRank(merged.model) > getCollectorModelRank(c.model);
    const usageEnriched = uMerged.tot > uC.tot || (uMerged.tot === uC.tot && uMerged.out > uC.out);
    const stepEnriched = (c.stepIndex === null || c.stepIndex === undefined) && merged.stepIndex !== null && merged.stepIndex !== undefined;
    const cascadeEnriched = !c.cascadeId && Boolean(merged.cascadeId);
    const dateEnriched = String(c.date || '') !== String(merged.date || '')
      || String(c.created_at || '') !== String(merged.created_at || '')
      || Boolean(c.dateIsProvisional) !== Boolean(merged.dateIsProvisional);
    const statusEnriched = String(c.status || '') !== String(merged.status || '');
    const pricingEnriched = Boolean(c.isPriced) !== Boolean(merged.isPriced) || Number(c.costUSD || 0) !== Number(merged.costUSD || 0);

    if (keyChanged || modelEnriched || usageEnriched || stepEnriched || cascadeEnriched || dateEnriched || statusEnriched || pricingEnriched) {
      ledgerEnrichmentCalls.push(merged);
      inMemoryEnrichments.set(ledgerKey, { targetCallId, merged });
    }
    const effectiveDateVal = merged.date || matched.date || c.date || null;
    matchedLedgerKeys.add(ledgerKey);
    callEffectiveDate.set(ledgerKey, effectiveDateVal);
    if (targetCallId !== ledgerKey) {
      matchedLedgerKeys.add(targetCallId);
      callEffectiveDate.set(targetCallId, effectiveDateVal);
    }
  };

  // Pass 1A: 优先在全量账本记录上完成精确 callId 对齐，避免同键记录被其它同步骤记录抢先消费
  const unmatchedAfterExactId = [];
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c) continue;
    const cidKey = String(c.callId || ledgerKey);
    let matched = takeUnmatchedReq(reqsByCallId.get(cidKey));
    if (!matched && cidKey !== ledgerKey) {
      matched = takeUnmatchedReq(reqsByCallId.get(ledgerKey));
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedAfterExactId.push([ledgerKey, c]);
    }
  }

  // Pass 1B: 跨键 stepIndex 对齐（施加充分证据门禁：两条均含模型且用量不同的最终态调用绝不跨键误合并）
  const unmatchedLedgerPass2 = [];
  for (const [ledgerKey, c] of unmatchedAfterExactId) {
    const cidKey = String(c.callId || ledgerKey);
    let matched = null;
    if (c.cascadeId) {
      const cSrc = c.source || 'desktop';
      const cCid = String(c.cascadeId).toLowerCase();
      const candSteps = extractCallStepNumbers(c, ledgerKey);
      const uC = getCallTokenBreakdown(c);
      for (const stIdx of candSteps) {
        const sKey = `${cSrc}:${cCid}#${stIdx}`;
        const multiRealAtStep = (realLedgerCountByStepKey.get(sKey) || 0) > 1;
        if (multiRealAtStep && (uC.inp + uC.cap + uC.out) > 0) {
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            if (!areModelsCompatible(c.model, item.model)) return false;
            const uItem = getCallTokenBreakdown(item);
            return uItem.inp === uC.inp && uItem.cap === uC.cap && uItem.out === uC.out;
          });
        } else if (!multiRealAtStep) {
          const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            const rId = String(item.callId || '');
            const rIsFallback = !rId || isStepFallbackCallId(rId, item.cascadeId);
            return (cIsFallback && !rIsFallback)
              ? isConfirmableSingleStepMatch(item, c)
              : isConfirmableSingleStepMatch(c, item);
          });
        }
        if (matched) break;
      }
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedLedgerPass2.push([ledgerKey, c]);
    }
  }

  // Pass 2: 兼容尚未记录 stepIndex 的历史账本条目，按同会话精确非零用量指纹 + 兼容模型双边唯一（1-to-1）匹配
  if (unmatchedLedgerPass2.length) {
    const reqsByUsageKey = new Map();
    for (const r of recentRequests) {
      if (matchedTranscriptReqs.has(r) || !r.cascadeId) continue;
      const uR = getCallTokenBreakdown(r);
      if (uR.inp + uR.cap + uR.out <= 0) continue;
      const uKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}:${uR.inp}:${uR.cap}:${uR.out}`;
      let list = reqsByUsageKey.get(uKey);
      if (!list) { list = []; reqsByUsageKey.set(uKey, list); }
      list.push(r);
    }
    const ledgerCandsByUsageKey = new Map();
    for (const [ledgerKey, c] of unmatchedLedgerPass2) {
      if (!c.cascadeId) continue;
      if (c.stepIndex !== null && c.stepIndex !== undefined) continue;
      if (extractCallStepNumbers(c, ledgerKey).length > 0) continue;
      const uC = getCallTokenBreakdown(c);
      if (uC.inp + uC.cap + uC.out <= 0) continue;
      const uKey = `${c.source || 'desktop'}:${String(c.cascadeId).toLowerCase()}:${uC.inp}:${uC.cap}:${uC.out}`;
      let list = ledgerCandsByUsageKey.get(uKey);
      if (!list) { list = []; ledgerCandsByUsageKey.set(uKey, list); }
      list.push([ledgerKey, c, String(c.callId || ledgerKey)]);
    }
    for (const [uKey, ledgerGroup] of ledgerCandsByUsageKey.entries()) {
      const reqCandidates = (reqsByUsageKey.get(uKey) || []).filter(item => !matchedTranscriptReqs.has(item));
      if (!reqCandidates.length) continue;
      const reqToCompatibleLedgers = new Map();
      const ledgerToCompatibleReqs = new Map();
      for (const lEntry of ledgerGroup) {
        const [ledgerKey, c, cidKey] = lEntry;
        const compatReqs = reqCandidates.filter(
          item => canFallbackLink(ledgerKey, c, cidKey, item) && areModelsCompatible(c.model, item.model)
        );
        ledgerToCompatibleReqs.set(lEntry, compatReqs);
        for (const rItem of compatReqs) {
          let lList = reqToCompatibleLedgers.get(rItem);
          if (!lList) { lList = []; reqToCompatibleLedgers.set(rItem, lList); }
          lList.push(lEntry);
        }
      }
      for (const lEntry of ledgerGroup) {
        const compatReqs = ledgerToCompatibleReqs.get(lEntry) || [];
        if (compatReqs.length !== 1) continue;
        const targetReq = compatReqs[0];
        if ((reqToCompatibleLedgers.get(targetReq) || []).length !== 1) continue;
        if (matchedTranscriptReqs.has(targetReq)) continue;
        matchedTranscriptReqs.add(targetReq);
        const [ledgerKey, c, cidKey] = lEntry;
        applyTranscriptMatch(ledgerKey, c, cidKey, targetReq);
      }
    }
  }

  // 向账本写入既有记录的富化更新（补齐 model / 最新完整用量 / stepIndex）以及未匹配的已计价扫描调用
  const unmatchedPricedTranscriptReqs = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && r.isPriced && r.callId);
  const ledgerUpdates = [...ledgerEnrichmentCalls, ...unmatchedPricedTranscriptReqs];
  if (!options.readOnly && ledgerUpdates.length) {
    await recordModelCallsLockedAsync(ledgerUpdates, {
      agDir,
      trustTranscriptDate: true,
      ...(sessionWindowsForHistory ? { accountSessions: sessionWindowsForHistory } : {})
    });
  }

  const effectiveCallsMap = { ...(loadPricingLedger(agDir, ledgerReadOpt).calls || {}) };
  for (const [origKey, { targetCallId, merged }] of inMemoryEnrichments.entries()) {
    if (effectiveCallsMap[targetCallId]) {
      const diskRec = effectiveCallsMap[targetCallId];
      const nextMerged = mergeSameCallRecords(diskRec, merged, targetCallId, merged.stepIndex, false, true);
      if (diskRec.attributionRepairVersion === CURRENT_ATTRIBUTION_REPAIR_VERSION) {
        nextMerged.attributionRepairVersion = diskRec.attributionRepairVersion;
        if (diskRec.accountAttributionConfidence === 'unattributed') {
          delete nextMerged.accountScopeKey;
          delete nextMerged.accountAttributionEvidence;
          nextMerged.accountAttributionConfidence = 'unattributed';
          if (diskRec.unattributedReason) nextMerged.unattributedReason = diskRec.unattributedReason;
        } else if (isValidAccountScopeKey(diskRec.accountScopeKey)) {
          nextMerged.accountScopeKey = diskRec.accountScopeKey;
          nextMerged.accountAttributionConfidence = diskRec.accountAttributionConfidence;
          if (diskRec.accountAttributionEvidence) nextMerged.accountAttributionEvidence = diskRec.accountAttributionEvidence;
        }
      }
      effectiveCallsMap[targetCallId] = nextMerged;
    } else if (effectiveCallsMap[origKey]) {
      if (targetCallId !== origKey) delete effectiveCallsMap[origKey];
      effectiveCallsMap[targetCallId] = merged;
    }
  }

  const finalRealKeysByStep = new Map();
  for (const [ledgerKey, c] of Object.entries(effectiveCallsMap)) {
    if (!c || !c.cascadeId) continue;
    if (isStepFallbackCallId(ledgerKey, c.cascadeId)) continue;
    const src = c.source || 'desktop';
    const cid = String(c.cascadeId).toLowerCase();
    for (const st of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${src}:${cid}#${st}`;
      let list = finalRealKeysByStep.get(sKey);
      if (!list) { list = []; finalRealKeysByStep.set(sKey, list); }
      list.push(ledgerKey);
    }
  }
  for (const r of unmatchedPricedTranscriptReqs) {
    const rKey = String(r.callId);
    let persistedKey = effectiveCallsMap[rKey] ? rKey : null;
    if (!persistedKey && isStepFallbackCallId(rKey, r.cascadeId) && r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const cands = (finalRealKeysByStep.get(`${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`) || [])
        .filter(k => effectiveCallsMap[k] && areModelsCompatible(effectiveCallsMap[k].model, r.model));
      if (cands.length === 1) {
        if (isConfirmableSingleStepMatch(effectiveCallsMap[cands[0]], r)) {
          persistedKey = cands[0];
        }
      } else if (cands.length > 1) {
        const uR = getCallTokenBreakdown(r);
        if (uR.inp + uR.cap + uR.out > 0) {
          const exact = cands.filter(k => {
            const uK = getCallTokenBreakdown(effectiveCallsMap[k]);
            return uK.inp === uR.inp && uK.cap === uR.cap && uK.out === uR.out;
          });
          if (exact.length === 1) persistedKey = exact[0];
        }
      }
    }
    if (!persistedKey && !isSyntheticCall(rKey, r)) {
      effectiveCallsMap[rKey] = r;
      persistedKey = rKey;
    }
    if (persistedKey) {
      matchedTranscriptReqs.add(r);
      matchedLedgerKeys.add(persistedKey);
      callEffectiveDate.set(persistedKey, r.date || effectiveCallsMap[persistedKey].date || null);
    }
  }

  const finalCallsEntries = Object.entries(effectiveCallsMap);
  const mergedCalls = finalCallsEntries.map(([, c]) => c);

  const resolveLedgerCallDate = (ledgerKey, c) => {
    const mapped = callEffectiveDate.get(ledgerKey);
    if (mapped) return String(mapped).slice(0, 10);
    const dInfo = extractNormalizedDateInfo(c);
    if (dInfo.date) return dInfo.date;
    return null;
  };

  // 按来源与日期汇总未匹配任何实时 transcript 的账本调用，用于抵扣 v2 / v1 历史归档中已被账本覆盖的份额
  const unmatchedLedgerBySourceDate = new Map();
  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c || matchedLedgerKeys.has(ledgerKey)) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const cSrc = c.source === 'cli' ? 'cli' : 'desktop';
    const cInp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0);
    const cCap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0);
    const cOut = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0);
    const cTok = cInp + cCap + cOut;
    const mapKey = `${cSrc}:${effDate}`;
    const prev = unmatchedLedgerBySourceDate.get(mapKey) || { tokens: 0, steps: 0 };
    prev.tokens += cTok;
    prev.steps += 1;
    unmatchedLedgerBySourceDate.set(mapKey, prev);
  }

  let archDeskUncovSteps = 0, archDeskUncovTokens = 0;
  let archCliUncovSteps = 0, archCliUncovTokens = 0;
  let archMonthUncovSteps = 0, archMonthUncovTokens = 0;

  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;

    const v2OnlyDeskTok = Math.max(0, (mergedDesktop[k]?.total || 0) - (scannedBySource.desktop[k]?.total || 0));
    const v2OnlyDeskSteps = Math.max(0, (mergedDesktop[k]?.steps || 0) - (scannedBySource.desktop[k]?.steps || 0));
    const covDesk = unmatchedLedgerBySourceDate.get(`desktop:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovDeskTok = Math.max(0, v2OnlyDeskTok - covDesk.tokens);
    const v2UncovDeskSteps = v2UncovDeskTok > 0
      ? Math.max(1, v2OnlyDeskSteps - covDesk.steps)
      : Math.max(0, v2OnlyDeskSteps - covDesk.steps);
    const excessDeskTok = Math.max(0, covDesk.tokens - v2OnlyDeskTok);
    const excessDeskSteps = Math.max(0, covDesk.steps - v2OnlyDeskSteps);

    const v2OnlyCliTok = Math.max(0, (mergedCli[k]?.total || 0) - (scannedBySource.cli[k]?.total || 0));
    const v2OnlyCliSteps = Math.max(0, (mergedCli[k]?.steps || 0) - (scannedBySource.cli[k]?.steps || 0));
    const covCli = unmatchedLedgerBySourceDate.get(`cli:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovCliTok = Math.max(0, v2OnlyCliTok - covCli.tokens);
    const v2UncovCliSteps = v2UncovCliTok > 0
      ? Math.max(1, v2OnlyCliSteps - covCli.steps)
      : Math.max(0, v2OnlyCliSteps - covCli.steps);
    const excessCliTok = Math.max(0, covCli.tokens - v2OnlyCliTok);
    const excessCliSteps = Math.max(0, covCli.steps - v2OnlyCliSteps);

    const rawV1Tok = mergedLegacyUnallocated[k]?.total || 0;
    const rawV1Steps = mergedLegacyUnallocated[k]?.steps || 0;
    const excessTok = excessDeskTok + excessCliTok;
    const excessSteps = excessDeskSteps + excessCliSteps;
    const v1UncovTok = Math.max(0, rawV1Tok - excessTok);
    const v1UncovSteps = v1UncovTok > 0
      ? Math.max(1, rawV1Steps - excessSteps)
      : Math.max(0, rawV1Steps - excessSteps);

    archDeskUncovTokens += v2UncovDeskTok + v1UncovTok;
    archDeskUncovSteps += v2UncovDeskSteps + v1UncovSteps;
    archCliUncovTokens += v2UncovCliTok;
    archCliUncovSteps += v2UncovCliSteps;
    if (k.startsWith(monthPrefix)) {
      archMonthUncovTokens += v2UncovDeskTok + v2UncovCliTok + v1UncovTok;
      archMonthUncovSteps += v2UncovDeskSteps + v2UncovCliSteps + v1UncovSteps;
    }
  }

  // 分来源与全量动态统计未被账本覆盖的剩余未计价请求与原因
  const unmatchedRecentUnpriced = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && !r.isPriced);
  const desktopRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'desktop');
  const cliRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'cli');

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

  const deskUnpriced = aggregateUnpriced(desktopRecentUnpriced, archDeskUncovSteps, archDeskUncovTokens);
  const cliUnpriced = aggregateUnpriced(cliRecentUnpriced, archCliUncovSteps, archCliUncovTokens);

  const totalUnpricedCount = deskUnpriced.count + cliUnpriced.count;
  const totalUnpricedTokens = deskUnpriced.tokens + cliUnpriced.tokens;
  const totalUnpricedReasons = {
    missingModel: deskUnpriced.reasons.missingModel + cliUnpriced.reasons.missingModel,
    unsupportedModel: deskUnpriced.reasons.unsupportedModel + cliUnpriced.reasons.unsupportedModel,
    missingUsage: deskUnpriced.reasons.missingUsage + cliUnpriced.reasons.missingUsage
  };

  const costEstimateAll = summarizeApiCost(mergedCalls, totalUnpricedCount, totalUnpricedReasons, totalUnpricedTokens);
  const costEstimateDesktop = summarizeApiCost(mergedCalls.filter(c => (c.source || 'desktop') === 'desktop'), deskUnpriced.count, deskUnpriced.reasons, deskUnpriced.tokens);
  const costEstimateCli = summarizeApiCost(mergedCalls.filter(c => c.source === 'cli'), cliUnpriced.count, cliUnpriced.reasons, cliUnpriced.tokens);

  // 本期 (本月自然月) 账本过滤与计价分析（仅追加未被账本覆盖的本月剩余步骤与 v2/v1 遗留差额）
  const currentMonthCalls = finalCallsEntries
    .filter(([ledgerKey, c]) => {
      if (!c) return false;
      const effDate = resolveLedgerCallDate(ledgerKey, c);
      return effDate && effDate.startsWith(monthPrefix);
    })
    .map(([, c]) => c);
  const currentMonthUnmatchedReqs = unmatchedRecentUnpriced.filter(r => r.date && String(r.date).startsWith(monthPrefix));
  const monthUnpriced = aggregateUnpriced(currentMonthUnmatchedReqs, archMonthUncovSteps, archMonthUncovTokens);
  const costEstimateCurrentMonth = summarizeApiCost(
    currentMonthCalls,
    monthUnpriced.count,
    monthUnpriced.reasons,
    monthUnpriced.tokens
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

  // 汇总最近 8 天各共享额度池真实消耗事件（供 5h / weekly 双周期剩余 Token 约数校准使用）
  // 统计口径：原始 inputTokens + cacheReadTokens + outputTokens 之和；同时计算全历史最小已知调用时间戳以判断周期起点覆盖完整性
  const quotaNowMs = Date.now();
  const quotaCutoffMs = quotaNowMs - 8 * 86400000;
  const quotaRecentCutoffMs = quotaNowMs - 86400000;
  const seenQuotaCallIds = new Set();
  const recentModelUsage = [];
  const olderQuotaBuckets = new Map();
  let allKnownCallsMinTs = null;
  const pushQuotaUsageCall = (call) => {
    if (!call || typeof call !== 'object') return;
    if (call.callId && seenQuotaCallIds.has(call.callId)) return;
    const rawTs = getCallSortTimestamp(call) ?? call.timestamp ?? (call.created_at ? new Date(call.created_at).getTime() : NaN);
    const ts = Number(rawTs);
    if (!Number.isFinite(ts) || ts <= 0 || ts > quotaNowMs + 60000) return;
    if (allKnownCallsMinTs === null || ts < allKnownCallsMinTs) {
      allKnownCallsMinTs = ts;
    }
    if (ts < quotaCutoffMs) return;
    const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
    const poolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : 'unknown';
    const sharedGroupKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || poolKey) : 'unknown';
    if ((!poolKey || poolKey === 'unknown') && (!sharedGroupKey || sharedGroupKey === 'unknown')) return;
    const inp = Math.max(0, Number(call.inputTokens || 0));
    const cache = Math.max(0, Number(call.cacheTokens ?? call.cacheReadTokens ?? 0));
    const outp = Math.max(0, Number(call.outputTokens || 0));
    const sumParts = inp + cache + outp;
    const totalTokens = Number(call.totalTokens ?? sumParts);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
    if (call.callId) seenQuotaCallIds.add(call.callId);
    if (ts >= quotaRecentCutoffMs) {
      recentModelUsage.push({
        id: call.callId || null,
        poolKey,
        sharedGroupKey,
        ts,
        inputTokens: inp,
        cacheTokens: cache,
        outputTokens: outp,
        totalTokens
      });
    } else {
      const bTs = Math.floor(ts / 900000) * 900000;
      const bKey = `${sharedGroupKey}:${poolKey}:${bTs}`;
      const existingB = olderQuotaBuckets.get(bKey);
      if (existingB) {
        existingB.inputTokens += inp;
        existingB.cacheTokens += cache;
        existingB.outputTokens += outp;
        existingB.totalTokens += totalTokens;
      } else {
        olderQuotaBuckets.set(bKey, {
          poolKey,
          sharedGroupKey,
          ts: bTs,
          inputTokens: inp,
          cacheTokens: cache,
          outputTokens: outp,
          totalTokens
        });
      }
    }
  };
  for (const c of mergedCalls) pushQuotaUsageCall(c);
  for (const c of recentRequests) pushQuotaUsageCall(c);
  for (const b of olderQuotaBuckets.values()) recentModelUsage.push(b);
  const quotaUsageCoverageStartMs = allKnownCallsMinTs !== null ? Math.max(quotaCutoffMs, allKnownCallsMinTs) : null;

  const modelBreakdown = buildDailyModelBreakdown({
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs,
    availableModelDetails: livePlanStatus?.availableModelDetails || null
  });

  const cacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll);
  const cacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop);
  const cacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli);
  const currentMonthCacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll, monthPrefix);
  const currentMonthCacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop, monthPrefix);
  const currentMonthCacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli, monthPrefix);

  const prevAccountEmail = Object.prototype.hasOwnProperty.call(extraContext, 'prevAccountEmail')
    ? extraContext.prevAccountEmail
    : (collectTokenHistoryAsync._lastAccountEmail || null);
  const accountUsageBreakdown = buildAccountUsageBreakdown({
    finalCallsEntries,
    resolveLedgerCallDate,
    dailyMapAll,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
    modelMetaByKey: modelBreakdown.modelMetaByKey,
    compactModelConfigs,
    availableModelDetails: livePlanStatus?.availableModelDetails || null,
    totalConversationsAll: totalConversations,
    unpricedSummaryBySource: {
      all: { count: totalUnpricedCount, reasons: totalUnpricedReasons, tokens: totalUnpricedTokens },
      desktop: deskUnpriced,
      cli: cliUnpriced,
      currentMonth: monthUnpriced
    },
    now
  });
  const out = {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    accountScopeKey: currentAccountKey ? buildAccountScopeKey(currentAccountKey) : null,
    currentAccountEmail: currentAccountKey || null,
    usageByAccount: accountUsageBreakdown.byAccount,
    unattributedUsage: accountUsageBreakdown.unattributed,
    attributionPolicy: {
      historicalFilesAttributed: false,
      description: '仅带有可靠账号归属证据的请求计入对应账号；未携带账号依据的历史会话及离线日志统一保留在未归属账本，绝不默认算给当前登录账号。'
    },
    isAccountSwitched: Boolean(
      currentAccountKey &&
      prevAccountEmail &&
      String(prevAccountEmail).toLowerCase() !== String(currentAccountKey).toLowerCase()
    ),
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
    quotaUsageCoverageStartMs,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage,
    speedRecords,
    cascadeModelConfigs: compactModelConfigs,
    modelCapabilitiesById: livePlanStatus?.availableModelDetails || null,
    currentPeriod: {
      key: monthPrefix,
      periodType: 'calendar_month',
      label: monthPrefix,
      isCurrentMonth: true
    },
    sources: {
      desktop: {
        conversationsCount: desktopPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'desktop').length
      },
      cli: {
        dirExists: cliAgDirs.some(d => fs.existsSync(d)),
        conversationsCount: cliPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'cli').length
      },
      wsl: {
        distros: extraWsl.distros,
        desktopDirsCount: extraWsl.desktopDirs.length,
        cliDirsCount: extraWsl.cliDirs.length,
        skippedRoots: Array.isArray(extraWsl.skippedRoots) ? extraWsl.skippedRoots : []
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
    cacheReadStatsBySource: {
      all: cacheReadStatsAll,
      desktop: cacheReadStatsDesktop,
      cli: cacheReadStatsCli
    },
    currentMonthCacheReadStatsBySource: {
      all: currentMonthCacheReadStatsAll,
      desktop: currentMonthCacheReadStatsDesktop,
      cli: currentMonthCacheReadStatsCli
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
      cacheReadStats: cacheReadStatsAll,
      currentMonthCacheReadStats: currentMonthCacheReadStatsAll,
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
    },
    dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
    modelMetaByKey: modelBreakdown.modelMetaByKey
  };

  const unattributedModelTokens = Object.values(modelBreakdown.dailyModelMapBySource?.all || {}).reduce(
    (acc, dayRec) => acc + (Number(dayRec?.[UNATTRIBUTED_MODEL_KEY]?.total) || 0),
    0
  );
  const modelMetaSig = Object.keys(modelBreakdown.modelMetaByKey).sort().join(',');
  const archiveSig = `${agDir}|${earliestDate}|${totalConversations}|${grandTotalTokens}|${totalSteps}|m:${modelMetaSig}|u:${unattributedModelTokens}|${effectivePlanStatus?.tierKey || ''}|${effectivePlanStatus?.tierId || ''}|${effectivePlanStatus?.teamsTier || ''}|${effectivePlanStatus?.actualPricePaid ?? ''}|${effectivePlanStatus?.currency || ''}|${costEstimate?.pricedCostUSD ?? ''}`;
  const isStaleCheck = typeof extraContext.isStale === 'function' ? extraContext.isStale : null;
  if (isStaleCheck && isStaleCheck()) {
    return { out, archiveSig: null, accountKey: currentAccountKey || null, stale: true };
  }

  // 持久化保存到 v2 与 v1 归档（仅在数据变化或文件不存在时原子写入，减少高频磁盘 I/O）
  const prevArchiveSig = Object.prototype.hasOwnProperty.call(extraContext, 'prevArchiveSig')
    ? extraContext.prevArchiveSig
    : collectTokenHistoryAsync._lastArchiveSig;
  try {
    const shouldWriteArchive = !options.readOnly && (options.agDir || archiveSig !== prevArchiveSig || !fs.existsSync(archivePathV2) || !fs.existsSync(archivePathV1));
    if (shouldWriteArchive) {
      const v2Payload = {
        version: '2.0.0',
        firstUseDate: earliestDate,
        updatedAt: out.updatedAt,
        maxConversations: totalConversations,
        planStatus: effectivePlanStatus,
        costEstimate,
        costEstimateCurrentMonth,
        referenceCost: out.referenceCost,
        dailyMapBySource: out.dailyMapBySource,
        dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
        modelMetaByKey: modelBreakdown.modelMetaByKey
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
  } catch { }

  return {
    out,
    archiveSig,
    accountKey: currentAccountKey ? String(currentAccountKey) : null,
    stale: false
  };
}

/**
 * 异步收集历史 Token 用量与成本汇总（优先后台 Worker 线程执行，避免阻塞宿主主进程事件循环）
 * @param {object} options
 */
async function collectTokenHistoryAsync(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  if (!options.force && !options.agDir && activeScanPromise && activeScanScope === scopeKey) {
    return activeScanPromise;
  }

  const thisScanSeq = ++currentScanSequence;
  const runner = (async () => {
    const livePlanStatus = await fetchUserStatusFromHost(options);
    const prevAccountEmail = collectTokenHistoryAsync._lastAccountEmail || null;
    const prevArchiveSig = collectTokenHistoryAsync._lastArchiveSig || null;

    let result = null;
    if (canUseHistoryWorker(options)) {
      const workerResp = await runHistoryWorkerTask({
        options: cloneCollectorOptionsForWorker(options),
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig
      }, 'collectTokenHistory', options);
      if (workerResp && workerResp._workerHandled && workerResp.result && workerResp.result.out) {
        result = workerResp.result;
      }
    }

    if (!result) {
      result = await collectTokenHistoryCoreAsync(options, {
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig,
        isStale: () => !options.agDir && thisScanSeq !== currentScanSequence
      });
    }

    if (!options.agDir && thisScanSeq !== currentScanSequence) {
      return result.out;
    }
    if (result.archiveSig) {
      collectTokenHistoryAsync._lastArchiveSig = result.archiveSig;
    }
    if (canCacheByScope) {
      if (!options.agDir && result.accountKey) collectTokenHistoryAsync._lastAccountEmail = result.accountKey;
      cachedTokenHistory = result.out;
      cachedTokenHistoryScope = scopeKey;
      cachedTokenHistoryAt = Date.now();
    }
    return result.out;
  })();

  if (!options.agDir) {
    activeScanScope = scopeKey;
    const tracked = runner.finally(() => {
      if (activeScanPromise === tracked) {
        activeScanPromise = null;
        activeScanScope = '';
      }
    });
    activeScanPromise = tracked;
    return tracked;
  }
  return runner;
}

/**
 * 从单个 transcript.jsonl 提取用户轮次标记、模型调用记录与可验证的子代理调用关联。
 */
function parseTranscriptForSessionTimeline(transcriptPath, cascadeId, convDir, sourceName = 'desktop', extraOpts = {}) {
  const turns = [];
  const calls = [];
  const subagentLinks = [];
  const uuidExtractRe = /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns, calls, subagentLinks };
  }

  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { turns, calls, subagentLinks };
  }

  const dbMeta = convDir && !extraOpts.fs && !isFsMonkeyPatched()
    ? loadConversationDbMeta(path.join(convDir, `${cascadeId}.db`), cascadeId)
    : null;

  const lines = content.split(/\r?\n/);
  const explicitUserTurns = [];
  const fallbackUserTurns = [];
  const pendingInvokes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }

    const rawStep = event.step_index ?? event.stepIndex;
    const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
    const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
    const createdAt = event.created_at || event.createdAt || null;
    const ts = createdAt ? Date.parse(createdAt) : NaN;
    const validTs = Number.isFinite(ts) && ts > 0 ? ts : null;

    if (event.type === 'USER_INPUT' || event.type === 'user' || event.role === 'user') {
      const textBody = typeof event.content === 'string' ? event.content : (typeof event.text === 'string' ? event.text : '');
      const rawPreview = sanitizeTurnPreviewText(textBody, 120);
      const turnEntry = {
        stepIndex,
        timestamp: validTs,
        created_at: createdAt,
        source: event.source || 'USER_EXPLICIT',
        preview: rawPreview
      };
      if (event.source === 'SYSTEM_SDK') {
        fallbackUserTurns.push(turnEntry);
      } else {
        explicitUserTurns.push(turnEntry);
      }
      continue;
    }

    if (Array.isArray(event.tool_calls)) {
      for (const tc of event.tool_calls) {
        if (!tc || !tc.name) continue;
        if (tc.name === 'invoke_subagent' || tc.name === 'send_message') {
          const cleanArg = (v) => (typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : '');
          pendingInvokes.push({
            stepIndex,
            toolName: tc.name,
            role: cleanArg(tc.args?.Role),
            typeName: cleanArg(tc.args?.TypeName),
            recipient: cleanArg(tc.args?.Recipient)
          });
        }
      }
    }

    if (typeof event.content === 'string' && event.content.includes('conversationId')) {
      let m;
      uuidExtractRe.lastIndex = 0;
      while ((m = uuidExtractRe.exec(event.content)) !== null) {
        const childCid = m[1];
        if (!childCid || childCid.toLowerCase() === String(cascadeId).toLowerCase()) continue;
        // 寻找紧邻前文的 invoke_subagent 调用以定位准确父步骤和 Role/TypeName
        let matchedInvoke = null;
        for (let pIdx = pendingInvokes.length - 1; pIdx >= 0; pIdx--) {
          const inv = pendingInvokes[pIdx];
          if (inv.toolName === 'invoke_subagent' && (stepIndex === null || inv.stepIndex === null || Math.abs(stepIndex - inv.stepIndex) <= 15)) {
            matchedInvoke = inv;
            break;
          }
        }
        const alreadyLinked = subagentLinks.find(l => l.childCid.toLowerCase() === childCid.toLowerCase());
        if (!alreadyLinked) {
          subagentLinks.push({
            childCid,
            parentCascadeId: cascadeId,
            parentStepIndex: matchedInvoke?.stepIndex ?? stepIndex,
            subagentRole: matchedInvoke?.role || '',
            subagentType: matchedInvoke?.typeName || '',
            confidence: 'verified_tool_output'
          });
        }
      }
    }

    const u = event.chatModel?.usage || null;
    const hasTokenFields = event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null || u != null;
    if (!hasTokenFields && !event.error && event.type !== 'PLANNER_RESPONSE') continue;

    const inp = event.input_tokens != null ? Number(event.input_tokens || 0) : (u?.inputTokens != null ? Number(u.inputTokens || 0) : null);
    const outp = event.output_tokens != null ? Number(event.output_tokens || 0) : (u?.outputTokens != null ? Number(u.outputTokens || 0) : null);
    const cap = event.cache_read_tokens != null ? Number(event.cache_read_tokens || 0) : (u?.cacheReadTokens != null ? Number(u.cacheReadTokens || 0) : null);
    const thinking = event.thinking_output_tokens != null ? Number(event.thinking_output_tokens || 0) : (u?.thinkingOutputTokens != null ? Number(u.thinkingOutputTokens || 0) : 0);

    const dbStep = (dbMeta && stepIndex !== null) ? dbMeta.stepMetaMap.get(stepIndex) : null;
    const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || dbStep?.model || '';
    const modelExactId = event.chatModel?.modelId || event.modelId || dbStep?.modelExactId || '';
    const modelLabel = event.chatModel?.modelDisplayName || dbStep?.modelLabel || '';

    const callId = dbStep?.responseId || extractCallId(event, cascadeId, stepIndex ?? i);
    if (!callId) continue;

    const hasUsageNums = inp !== null || cap !== null || outp !== null;
    if (!hasUsageNums && !event.error) continue;

    calls.push({
      callId,
      cascadeId,
      source: sourceName,
      stepIndex,
      model,
      ...(modelExactId ? { modelExactId } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      inputTokens: inp,
      cacheReadTokens: cap,
      cacheTokens: cap,
      outputTokens: outp,
      thinkingTokens: thinking,
      totalTokens: hasUsageNums ? ((inp || 0) + (cap || 0) + (outp || 0)) : null,
      hasInputCacheFields: inp !== null || cap !== null,
      ttftSec: dbStep?.ttftSec ?? null,
      streamingSec: dbStep?.streamingSec ?? null,
      status: event.status === 'RUNNING' ? 'streaming' : 'final',
      ...(event.error ? { error: String(event.error) } : {}),
      date: validTs ? formatLocalDateKey(new Date(validTs)) : null,
      dateSource: 'transcript',
      dateIsProvisional: false,
      created_at: createdAt,
      timestamp: validTs
    });
  }

  const chosenTurns = explicitUserTurns.length ? explicitUserTurns : fallbackUserTurns;
  for (const t of chosenTurns) turns.push(t);
  return { turns, calls, subagentLinks, dbMeta };
}

const subagentParentIndexCache = { dirMtimesKey: '', byParent: new Map(), at: 0 };

/**
 * 基于目录签名缓存扫描所有可用根目录 conversations/*.db，查找显式记录了 parentCascadeId / rootCascadeId 的子代理会话。
 */
function findSubagentChildrenFromConvDirs(parentCascadeId, convDirs = [], options = {}) {
  if (!parentCascadeId || options.fs || isFsMonkeyPatched()) return [];
  const normParent = String(parentCascadeId).trim().toLowerCase();
  const dirSigParts = [];
  const uniqueConvDirs = dedupeScanPaths(convDirs);
  for (const d of uniqueConvDirs) {
    try {
      if (origFsMethods.existsSync(d)) {
        const st = origFsMethods.statSync(d);
        dirSigParts.push(`${d}:${st.mtimeMs}`);
      }
    } catch { }
  }
  const dirKey = dirSigParts.join('|');
  if (subagentParentIndexCache.dirMtimesKey !== dirKey || (Date.now() - subagentParentIndexCache.at) > 60000) {
    const nextByParent = new Map();
    for (const cDir of uniqueConvDirs) {
      try {
        if (!origFsMethods.existsSync(cDir)) continue;
        for (const name of origFsMethods.readdirSync(cDir)) {
          if (!name.endsWith('.db')) continue;
          const cid = name.slice(0, -3);
          const dbMeta = loadConversationDbMeta(path.join(cDir, name), cid);
          const pRaw = String(dbMeta.parentCascadeId || '').trim();
          const rRaw = String(dbMeta.rootCascadeId || '').trim();
          const parentKeys = new Set([pRaw.toLowerCase(), rRaw.toLowerCase()].filter(k => k && k !== cid.toLowerCase()));
          for (const pk of parentKeys) {
            let list = nextByParent.get(pk);
            if (!list) { list = []; nextByParent.set(pk, list); }
            if (!list.some(item => item.childCid === cid && item.convDir === cDir)) {
              list.push({
                childCid: cid,
                parentCascadeId: pRaw || rRaw,
                rootCascadeId: rRaw || pRaw,
                subagentType: dbMeta.subagentType || '',
                subagentRole: dbMeta.subagentRole || '',
                convDir: cDir
              });
            }
          }
        }
      } catch { }
    }
    subagentParentIndexCache.dirMtimesKey = dirKey;
    subagentParentIndexCache.byParent = nextByParent;
    subagentParentIndexCache.at = Date.now();
  }
  return subagentParentIndexCache.byParent.get(normParent) || [];
}

/**
 * 聚合指定会话的按用户轮次请求时间线与可验证子代理调用（仅只读访问，复用现有本地目录与账本）。
 */
async function collectSessionTimelineCoreAsync(cascadeId, options = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) {
    return { cascadeId: cid, turns: [], unlinkedSubagentCalls: [], totalCalls: 0, mainCallsCount: 0, subagentCallsCount: 0, cacheSummary: summarizeCacheReadStats([]), latestCall: null, subagentLinks: [] };
  }

  const { agDir, agCliDir } = resolvePrimaryGeminiDirs(options);
  const extraWsl = await discoverWslGeminiDirsAsync(options);

  const rootEntries = [
    ...dedupeScanPaths([agDir, ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []), ...extraWsl.desktopDirs]).map(d => ({ dir: d, source: 'desktop' })),
    ...dedupeScanPaths([agCliDir, ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []), ...extraWsl.cliDirs]).map(d => ({ dir: d, source: 'cli' }))
  ];

  const allTurns = [];
  const allCalls = [];
  const subagentMap = new Map();
  let mainDbMeta = null;

  const findTranscriptForCid = (targetCid) => {
    for (const r of rootEntries) {
      const candidates = [
        path.join(r.dir, 'brain', targetCid, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(r.dir, 'brain', targetCid, 'transcript.jsonl')
      ];
      for (const tp of candidates) {
        if (fs.existsSync(tp)) {
          return { path: tp, convDir: path.join(r.dir, 'conversations'), source: r.source };
        }
      }
    }
    return null;
  };

  // 1. 解析主会话自身 transcript + .db
  const mainFile = findTranscriptForCid(cid);
  if (mainFile) {
    const parsed = parseTranscriptForSessionTimeline(mainFile.path, cid, mainFile.convDir, mainFile.source, options);
    allTurns.push(...parsed.turns);
    allCalls.push(...parsed.calls);
    if (parsed.dbMeta) mainDbMeta = parsed.dbMeta;
    for (const link of parsed.subagentLinks) {
      subagentMap.set(link.childCid.toLowerCase(), link);
    }
  } else if (!options.fs && !isFsMonkeyPatched()) {
    for (const r of rootEntries) {
      const dbP = path.join(r.dir, 'conversations', `${cid}.db`);
      if (fs.existsSync(dbP)) {
        mainDbMeta = loadConversationDbMeta(dbP, cid);
        break;
      }
    }
  }

  // 2. 合并前端 / RPC 传入的 liveSteps（识别当前尚未写入磁盘的最新轮次与 invoke_subagent 调用）
  if (Array.isArray(options.liveSteps) && options.liveSteps.length) {
    for (let idx = 0; idx < options.liveSteps.length; idx++) {
      const s = options.liveSteps[idx];
      if (!s || typeof s !== 'object') continue;
      const stepIndex = Number.isInteger(Number(s.stepIndex ?? s.idx)) ? Number(s.stepIndex ?? s.idx) : idx;
      if (s.userInput) {
        const u = s.userInput;
        const rawText = String(u.userResponse || (u.items || []).map(item => item.text || '').join(' ') || '');
        const rawPreview = sanitizeTurnPreviewText(rawText, 120);
        const already = allTurns.some(t => t.stepIndex === stepIndex);
        if (!already) {
          allTurns.push({
            stepIndex,
            timestamp: s.timestamp || (s.createdAt ? Date.parse(s.createdAt) : null),
            created_at: s.createdAt || null,
            source: u.source || 'USER_EXPLICIT',
            preview: rawPreview
          });
        }
      }
    }
  }

  // 3. 合并来自当前会话 RPC / 前端传来的 liveCalls
  const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
  if (Array.isArray(options.liveCalls)) {
    for (const c of options.liveCalls) {
      if (!c || typeof c !== 'object') continue;
      if (c.cascadeId && String(c.cascadeId).toLowerCase() !== cid.toLowerCase()) continue;
      const dbStep = (mainDbMeta && Number.isInteger(Number(c.stepIndex)))
        ? mainDbMeta.stepMetaMap.get(Number(c.stepIndex))
        : null;
      allCalls.push({
        ...c,
        cascadeId: c.cascadeId || cid,
        modelExactId: c.modelExactId || dbStep?.modelExactId || resolveStableModelId(c, cascadeConfigs) || undefined,
        modelLabel: c.modelLabel || dbStep?.modelLabel || undefined
      });
    }
  }

  // 4. 合并本地 pricing_ledger_v1.json 中当前会话（及其子代理）的持久化记录
  const ledger = loadPricingLedger(agDir, options.fs ? { fs: options.fs } : undefined);
  const ledgerCalls = ledger && ledger.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const normCid = cid.toLowerCase();
  for (const lc of ledgerCalls) {
    if (!lc || !lc.cascadeId) continue;
    if (String(lc.cascadeId).toLowerCase() === normCid) {
      allCalls.push(lc);
    }
  }

  // 5. 发现基于 .db parent_cascade_id / root_cascade_id 的可验证子代理会话
  const dbChildren = findSubagentChildrenFromConvDirs(cid, rootEntries.map(r => path.join(r.dir, 'conversations')), options);
  for (const dc of dbChildren) {
    const k = dc.childCid.toLowerCase();
    const existing = subagentMap.get(k);
    if (!existing) {
      subagentMap.set(k, {
        childCid: dc.childCid,
        parentCascadeId: dc.parentCascadeId || cid,
        parentStepIndex: null,
        subagentRole: dc.subagentRole || '',
        subagentType: dc.subagentType || '',
        confidence: 'verified_db_meta'
      });
    } else if (!existing.subagentType && dc.subagentType) {
      existing.subagentType = dc.subagentType;
    }
  }

  // 6. 读取所有已验证关联子代理的 transcript + .db + ledger 调用
  const subagentLinks = Array.from(subagentMap.values());
  for (const link of subagentLinks) {
    const childFile = findTranscriptForCid(link.childCid);
    const childNorm = link.childCid.toLowerCase();
    if (childFile) {
      const childParsed = parseTranscriptForSessionTimeline(childFile.path, link.childCid, childFile.convDir, childFile.source, options);
      for (const cc of childParsed.calls) {
        allCalls.push({
          ...cc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || childParsed.dbMeta?.subagentType || '',
          subagentRole: link.subagentRole || childParsed.dbMeta?.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
    for (const lc of ledgerCalls) {
      if (!lc || !lc.cascadeId) continue;
      if (String(lc.cascadeId).toLowerCase() === childNorm) {
        allCalls.push({
          ...lc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || '',
          subagentRole: link.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
  }

  const grouped = groupSessionCallsByTurns(allTurns, allCalls, {
    cascadeId: cid,
    cascadeModelConfigs: cascadeConfigs,
    userStatus: options.userStatus || null
  });
  return {
    ...grouped,
    subagentLinks,
    subagentNote: mainDbMeta?.skippedReason ? `db_${mainDbMeta.skippedReason}` : null
  };
}

async function collectSessionTimelineAsync(cascadeId, options = {}) {
  if (canUseHistoryWorker(options)) {
    const workerResp = await runHistoryWorkerTask({
      cascadeId,
      options: cloneCollectorOptionsForWorker(options)
    }, 'collectSessionTimeline', options);
    if (workerResp && workerResp._workerHandled && workerResp.result) {
      return workerResp.result;
    }
  }
  return collectSessionTimelineCoreAsync(cascadeId, options);
}

if (!isMainThread && workerData && workerData.agCollectorHistoryWorker && parentPort) {
  parentPort.on('message', async (msg) => {
    const { id, cmd, payload, env } = msg || {};
    const prevEnv = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        prevEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      if (cmd === 'collectTokenHistory') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectTokenHistoryCoreAsync(opts, {
          livePlanStatus: payload?.livePlanStatus ?? null,
          prevAccountEmail: payload?.prevAccountEmail ?? null,
          prevArchiveSig: payload?.prevArchiveSig ?? null
        });
        parentPort.postMessage({ id, ok: true, result });
      } else if (cmd === 'recordModelCalls') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = recordModelCalls(payload?.newCalls || [], opts);
        // createRecordResult 附带 valueOf 函数，跨 Worker 边界时须剥离函数属性避免 StructuredClone 抛 DataCloneError
        const plainResult = {
          ok: result ? result.ok !== false : false,
          changed: Boolean(result && result.changed),
          ...(result?.error ? { error: result.error } : {}),
          ...(result?.phase ? { phase: result.phase } : {}),
          ...(result?.code ? { code: result.code } : {})
        };
        parentPort.postMessage({ id, ok: true, result: plainResult });
      } else if (cmd === 'collectSessionTimeline') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectSessionTimelineCoreAsync(payload?.cascadeId || '', opts);
        parentPort.postMessage({ id, ok: true, result });
      } else {
        throw new Error(`Unknown collector worker command: ${cmd}`);
      }
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
    } finally {
      for (const [k, oldV] of Object.entries(prevEnv)) {
        if (oldV === undefined) delete process.env[k];
        else process.env[k] = oldV;
      }
    }
  });
}

function collectTokenHistory(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return (cachedTokenHistory && cachedTokenHistoryScope === scopeKey) ? cachedTokenHistory : {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    loading: true,
    updatedAt: '',
    firstUseDate: null,
    planStatus: parseUserPlanStatus(null),
    costEstimate: { pricedCostUSD: 0, coveragePercent: 0, byModel: {} },
    summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0, activeDaysCount: 0 },
    quotaUsageCoverageStartMs: null,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage: [],
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
const OFFICIAL_RELEASES_WEB_BASE = `https://github.com/${OFFICIAL_REPO}/releases`;
const OFFICIAL_RELEASES_ATOM = `${OFFICIAL_RELEASES_WEB_BASE}.atom`;
const OFFICIAL_RELEASES_LATEST = `${OFFICIAL_RELEASES_WEB_BASE}/latest`;
const MAX_GITHUB_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_STREAM_BYTES = 100 * 1024 * 1024;

let cachedUpdateCheck = null;
let cachedUpdateCheckAt = 0;
let isApplyingUpdate = false;

/**
 * 校验下载重定向地址是否属于受信任的 GitHub / 官方资产 CDN（支持相对路径按 baseUrl 解析）
 */
function isAllowedDownloadRedirectUrl(targetUrlStr, baseUrlStr = null) {
  try {
    if (!targetUrlStr || typeof targetUrlStr !== 'string') return false;
    const u = baseUrlStr ? new URL(targetUrlStr, baseUrlStr) : new URL(targetUrlStr);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
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
 * 严格校验资产下载地址是否归属于官方仓库发布路径，禁止路径穿越与外站跳转
 */
function isOfficialAssetDownloadUrl(urlStr, filename, expectedTag = null) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  if (urlStr.includes('\\') || urlStr.includes('..') || /%2e%2e|%2f|%5c/i.test(urlStr)) return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return false;
    if (u.username || u.password || u.search || u.hash) return false;
    const expectedPrefix = `/${OFFICIAL_REPO}/releases/download/`;
    if (!u.pathname.startsWith(expectedPrefix)) return false;
    const rest = u.pathname.slice(expectedPrefix.length);
    const segments = rest.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return false;
    if (segments.some(seg => seg === '.' || seg === '..' || seg.includes('..'))) return false;
    if (expectedTag && decodeURIComponent(segments[0]) !== expectedTag && segments[0] !== expectedTag) return false;
    if (filename && segments[1] !== filename) return false;
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

// 隧道建立与超时分类助手已统一收敛至 meter-proxy.js 导出并在本文件顶部引入复用。


function requestGithubUrl(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const startMs = Date.now();
      const timeoutMs = options.timeout || 8000;
      const redirectCount = options.redirectCount || 0;
      const parsedUrl = new URL(rawUrl);
      const isApiHost = parsedUrl.hostname.toLowerCase() === 'api.github.com';
      const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : (options.streamTo ? MAX_GITHUB_STREAM_BYTES : MAX_GITHUB_TEXT_BYTES);
      const phase = options.phase || (isApiHost ? 'release_query' : (options.streamTo ? 'download_asset' : 'request'));
      const hopTrace = Array.isArray(options._hopTrace) ? options._hopTrace : [];

      // 认证信息仅允许发送至 api.github.com，绝不透传给网页、重定向目标或外部 CDN
      const rawHeaders = Object.assign({}, options.headers || {});
      for (const hKey of Object.keys(rawHeaders)) {
        if (!isApiHost && hKey.toLowerCase() === 'authorization') {
          delete rawHeaders[hKey];
        }
      }
      const headers = Object.assign({
        'User-Agent': `AntigravityContextMeter/${PROJECT_VERSION}`,
        'Accept': isApiHost ? 'application/vnd.github.v3+json' : (options.accept || '*/*')
      }, rawHeaders);
      const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (isApiHost && token && !Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${String(token).trim()}`;
      }

      const proxyInfo = options.useProxy === false
        ? null
        : detectProxyConfig(options.proxyConfigOptions || {});
      const pluginProxyConfigured = Boolean(proxyInfo && proxyInfo.enabled && proxyInfo.httpProxy);
      const bypassMatched = pluginProxyConfigured
        ? Boolean(matchesNoProxy(parsedUrl.hostname, proxyInfo.noProxy))
        : false;
      const parsedProxy = pluginProxyConfigured && !bypassMatched
        ? parseAndValidateProxyUrl(proxyInfo.httpProxy)
        : null;
      const willUseProxyTunnel = Boolean(pluginProxyConfigured && !bypassMatched);
      const hopEntry = {
        phase,
        hop: redirectCount + 1,
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port) || 443,
        proxySource: willUseProxyTunnel
          ? 'plugin_config'
          : (bypassMatched ? 'plugin_bypass' : (options.useProxy === false ? 'disabled' : 'direct')),
        proxyProtocol: parsedProxy?.ok ? parsedProxy.protocol : 'direct',
        proxyEndpoint: (pluginProxyConfigured && !bypassMatched) ? redactProxyUrl(proxyInfo.httpProxy) : null,
        bypassMatched,
        outcome: 'pending',
        timeoutPhase: null,
        durationMs: 0,
        error: null
      };
      hopTrace.push(hopEntry);

      let settledOuter = false;
      const finishResolve = val => {
        if (settledOuter) return;
        settledOuter = true;
        hopEntry.durationMs = Date.now() - startMs;
        if (hopEntry.outcome === 'pending') hopEntry.outcome = 'ok';
        resolve(val);
      };
      const finishReject = err => {
        if (settledOuter) return;
        settledOuter = true;
        hopEntry.durationMs = Date.now() - startMs;
        hopEntry.outcome = 'error';
        hopEntry.timeoutPhase = hopEntry.timeoutPhase || classifyRequestTimeoutPhase(err, willUseProxyTunnel);
        hopEntry.error = sanitizeDiagnosticErrorText(err);
        if (err && typeof err === 'object' && !err.diagnostics) {
          err.diagnostics = {
            phase,
            targetHost: hopEntry.host,
            targetPort: hopEntry.port,
            proxySource: hopEntry.proxySource,
            proxyProtocol: hopEntry.proxyProtocol,
            proxyEndpoint: hopEntry.proxyEndpoint,
            bypassMatched: hopEntry.bypassMatched,
            timeoutPhase: hopEntry.timeoutPhase,
            hops: hopTrace.map(h => ({ ...h }))
          };
        }
        try {
          console.warn('[Update Diagnostics]', JSON.stringify({
            phase: hopEntry.phase,
            hop: hopEntry.hop,
            host: hopEntry.host,
            port: hopEntry.port,
            proxySource: hopEntry.proxySource,
            proxyProtocol: hopEntry.proxyProtocol,
            proxyEndpoint: hopEntry.proxyEndpoint,
            bypassMatched: hopEntry.bypassMatched,
            timeoutPhase: hopEntry.timeoutPhase,
            durationMs: hopEntry.durationMs,
            error: hopEntry.error
          }));
        } catch { }
        reject(err);
      };

      if (willUseProxyTunnel) {
        if (!parsedProxy || !parsedProxy.ok) {
          return finishReject(new Error(`代理配置无效: ${parsedProxy?.error || '无法解析代理地址'}`));
        }
        const targetPort = Number(parsedUrl.port) || 443;
        const tunnelPromise = (parsedProxy.protocol === 'socks5:' || parsedProxy.protocol === 'socks5h:')
          ? openSocks5Tunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs)
          : openHttpConnectTunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs, {
            ca: options.proxyCa || options.ca,
            rejectUnauthorized: options.proxyRejectUnauthorized
          });
        // 代理已启用且未命中绕过规则时，隧道失败必须立即报错，绝不静默改走直连
        tunnelPromise.then(
          socket => doRequest(socket),
          err => {
            hopEntry.timeoutPhase = 'proxy_tunnel_connect';
            finishReject(err);
          }
        );
        return;
      }

      doRequest(null);

      function doRequest(tunnelSocket) {
        let tunnelConsumed = false;
        const releaseUnusedTunnel = () => {
          if (tunnelSocket && !tunnelConsumed && !tunnelSocket.destroyed) {
            try { tunnelSocket.destroy(); } catch { }
          }
        };
        const settleResolve = val => {
          releaseUnusedTunnel();
          finishResolve(val);
        };
        const settleReject = err => {
          releaseUnusedTunnel();
          finishReject(err);
        };
        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers
        };
        if (options.ca) reqOpts.ca = options.ca;
        if (typeof options.rejectUnauthorized === 'boolean') {
          reqOpts.rejectUnauthorized = options.rejectUnauthorized;
        }
        if (tunnelSocket) {
          const tls = require('tls');
          // Node https.request 在 agent:false 时会忽略 reqOpts.createConnection，必须绑定带 createConnection 的专属 Agent
          const tunnelAgent = new https.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => {
            tunnelConsumed = true;
            const tlsOpts = { socket: tunnelSocket, servername: parsedUrl.hostname };
            if (options.ca) tlsOpts.ca = options.ca;
            if (typeof options.rejectUnauthorized === 'boolean') {
              tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
            }
            return tls.connect(tlsOpts);
          };
          reqOpts.agent = tunnelAgent;
        }

        const req = https.request(reqOpts, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const rawLocation = String(res.headers.location);
            let nextUrlStr = null;
            try {
              nextUrlStr = new URL(rawLocation, parsedUrl).toString();
            } catch {
              nextUrlStr = null;
            }
            res.resume();
            if (redirectCount >= 5) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
              return settleReject(new Error('GitHub 请求重定向次数过多 (>5)'));
            }
            const redirectOk = typeof options._isAllowedRedirectUrl === 'function'
              ? options._isAllowedRedirectUrl(nextUrlStr, parsedUrl.toString())
              : isAllowedDownloadRedirectUrl(nextUrlStr, parsedUrl.toString());
            if (!nextUrlStr || !redirectOk) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
              return settleReject(new Error(`下载重定向地址不受信任或协议不安全: ${rawLocation}`));
            }
            // 剥离旧 headers 与 Authorization，按新目标域名重新决定是否附带凭据与代理绕过
            hopEntry.outcome = 'redirect';
            hopEntry.durationMs = Date.now() - startMs;
            try { hopEntry.redirectToHost = new URL(nextUrlStr).hostname; } catch {}
            const nextHeaders = Object.assign({}, options.headers || {});
            for (const hKey of Object.keys(nextHeaders)) {
              if (hKey.toLowerCase() === 'authorization') delete nextHeaders[hKey];
            }
            const nextOptions = Object.assign({}, options, {
              headers: nextHeaders,
              redirectCount: redirectCount + 1,
              phase,
              _hopTrace: hopTrace
            });
            releaseUnusedTunnel();
            return requestGithubUrl(nextUrlStr, nextOptions).then(finishResolve, finishReject);
          }
          if (res.statusCode !== 200) {
            if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
            let errBody = '';
            res.on('data', c => {
              if (errBody.length < 1024) errBody += c;
            });
            res.on('end', () => {
              const err = new Error(`GitHub HTTP ${res.statusCode}: ${errBody.slice(0, 150)}`);
              err.statusCode = res.statusCode;
              err.responseBody = errBody;
              settleReject(err);
            });
            return;
          }
          let totalBytes = 0;
          let abortedOrInvalid = false;
          const rawContentLen = !res.headers['content-encoding'] ? res.headers['content-length'] : null;
          const expectedContentLen = (rawContentLen != null && /^\d+$/.test(String(rawContentLen).trim()))
            ? Number(String(rawContentLen).trim())
            : null;

          const validateResponseComplete = () => {
            if (res.complete === false || res.aborted) {
              return new Error('响应流未完整结束，连接可能已提前中断');
            }
            if (expectedContentLen !== null && totalBytes !== expectedContentLen) {
              return new Error(`响应长度不完整 (期望 ${expectedContentLen} 字节，实际接收 ${totalBytes} 字节)`);
            }
            return null;
          };

          if (options.streamTo) {
            let resEnded = false;
            let streamFinished = false;
            const tryResolveStream = () => {
              if (abortedOrInvalid || !resEnded || !streamFinished) return;
              const integrityErr = validateResponseComplete();
              if (integrityErr) {
                abortedOrInvalid = true;
                try { options.streamTo.destroy(integrityErr); } catch { }
                return settleReject(integrityErr);
              }
              settleResolve();
            };

            res.on('data', chunk => {
              totalBytes += chunk.length;
              if (totalBytes > maxBytes && !abortedOrInvalid) {
                abortedOrInvalid = true;
                const err = new Error(`响应体超出大小限制 (>${maxBytes} 字节)`);
                err.code = 'RESPONSE_TOO_LARGE';
                if (typeof res.destroy === 'function') res.destroy(err);
                try { options.streamTo.destroy(err); } catch { }
                settleReject(err);
              }
            });
            res.on('aborted', () => {
              if (abortedOrInvalid) return;
              abortedOrInvalid = true;
              const err = new Error('下载响应流意外中断 (aborted)');
              try { options.streamTo.destroy(err); } catch { }
              settleReject(err);
            });
            res.on('end', () => {
              resEnded = true;
              tryResolveStream();
            });
            res.on('close', () => {
              if (!resEnded && !abortedOrInvalid && !res.complete) {
                abortedOrInvalid = true;
                const err = new Error('下载连接未完整结束即关闭');
                try { options.streamTo.destroy(err); } catch { }
                settleReject(err);
              }
            });
            res.on('error', err => {
              abortedOrInvalid = true;
              try { options.streamTo.destroy(err); } catch { }
              settleReject(err);
            });
            options.streamTo.on('finish', () => {
              streamFinished = true;
              tryResolveStream();
            });
            options.streamTo.on('error', err => {
              abortedOrInvalid = true;
              settleReject(err);
            });
            res.pipe(options.streamTo);
          } else {
            const chunks = [];
            res.on('data', chunk => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              totalBytes += buf.length;
              if (totalBytes > maxBytes) {
                abortedOrInvalid = true;
                const err = new Error(`响应体超出大小限制 (>${maxBytes} 字节)`);
                err.code = 'RESPONSE_TOO_LARGE';
                if (typeof res.destroy === 'function') res.destroy(err);
                settleReject(err);
                return;
              }
              chunks.push(buf);
            });
            res.on('aborted', () => {
              if (abortedOrInvalid) return;
              abortedOrInvalid = true;
              settleReject(new Error('响应流意外中断 (aborted)'));
            });
            res.on('end', () => {
              if (abortedOrInvalid) return;
              const integrityErr = validateResponseComplete();
              if (integrityErr) {
                abortedOrInvalid = true;
                return settleReject(integrityErr);
              }
              const data = Buffer.concat(chunks).toString('utf8');
              if (options.resolveWithMeta) {
                settleResolve({ data, finalUrl: parsedUrl.toString(), statusCode: res.statusCode });
              } else {
                settleResolve(data);
              }
            });
            res.on('close', () => {
              if (!abortedOrInvalid && !res.complete) {
                abortedOrInvalid = true;
                settleReject(new Error('响应连接未完整结束即关闭'));
              }
            });
            res.on('error', err => {
              if (!abortedOrInvalid) settleReject(err);
            });
          }
        });

        req.setTimeout(timeoutMs, () => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
          req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
        });
        req.on('error', err => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
          settleReject(err);
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
    } catch { }

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
  } catch { }
  return null;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function stripHtmlToPlainText(rawHtml) {
  const decoded = decodeHtmlEntities(rawHtml);
  return decoded
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseReleasesAtom(xmlText) {
  if (!xmlText || typeof xmlText !== 'string' || !/<feed\b/i.test(xmlText) || !/<entry\b/i.test(xmlText)) {
    throw new Error('releases.atom 响应结构异常，未能解析版本条目');
  }
  const releases = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entryXml = match[1];
    const linkMatch = entryXml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const titleMatch = entryXml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const idMatch = entryXml.match(/<id\b[^>]*>([\s\S]*?)<\/id>/i);
    const updatedMatch = entryXml.match(/<updated\b[^>]*>([\s\S]*?)<\/updated>/i);
    const contentMatch = entryXml.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);

    let tagName = '';
    let htmlUrl = '';
    if (linkMatch) {
      try {
        const u = new URL(decodeHtmlEntities(linkMatch[1]), 'https://github.com');
        const expectedPrefix = `/${OFFICIAL_REPO}/releases/tag/`;
        if (u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(expectedPrefix)) {
          tagName = decodeURIComponent(u.pathname.slice(expectedPrefix.length).split('/')[0] || '').trim();
          htmlUrl = `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`;
        }
      } catch { }
    }
    if (!tagName && idMatch) {
      const idText = decodeHtmlEntities(idMatch[1]).trim();
      const parts = idText.split('/');
      const cand = parts[parts.length - 1]?.trim();
      if (cand && /^v?\d+\.\d+\.\d+/.test(cand)) tagName = cand;
    }
    if (!tagName && titleMatch) {
      const titleText = decodeHtmlEntities(titleMatch[1]).trim();
      const verToken = titleText.match(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/);
      if (verToken) tagName = verToken[0];
    }
    if (!tagName) continue;
    if (!htmlUrl) htmlUrl = `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`;

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : tagName;
    const body = contentMatch ? stripHtmlToPlainText(contentMatch[1]) : '';
    const publishedAt = updatedMatch ? decodeHtmlEntities(updatedMatch[1]).trim() : '';
    const isPre = /alpha|beta|rc|pre-?release|draft/i.test(tagName) || /pre-?release/i.test(title);
    releases.push({
      tag_name: tagName,
      name: title,
      html_url: htmlUrl,
      body,
      published_at: publishedAt,
      draft: false,
      prerelease: isPre,
      assets: []
    });
  }
  if (!releases.length) {
    throw new Error('releases.atom 未包含有效的官方版本条目');
  }
  return releases;
}

function parseLatestReleaseHtml(htmlText, finalUrl = '') {
  const candidates = [];
  if (finalUrl) candidates.push(String(finalUrl));
  if (htmlText && typeof htmlText === 'string') {
    const canonicalMatch = htmlText.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (canonicalMatch) candidates.push(decodeHtmlEntities(canonicalMatch[1]));
    const ogMatch = htmlText.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
    if (ogMatch) candidates.push(decodeHtmlEntities(ogMatch[1]));
    const tagLinkRegex = new RegExp(`href=["'](?:https://github\\.com)?/${OFFICIAL_REPO}/releases/tag/([^"'?#\\s]+)["']`, 'i');
    const tagLinkMatch = htmlText.match(tagLinkRegex);
    if (tagLinkMatch) candidates.push(`https://github.com/${OFFICIAL_REPO}/releases/tag/${tagLinkMatch[1]}`);
  }
  const expectedPrefix = `/${OFFICIAL_REPO}/releases/tag/`;
  for (const cand of candidates) {
    try {
      const u = new URL(cand, 'https://github.com');
      if (u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(expectedPrefix)) {
        const rawTag = u.pathname.slice(expectedPrefix.length).split('/')[0];
        const tagName = decodeURIComponent(rawTag || '').trim();
        if (tagName && !tagName.includes('..') && tagName !== 'latest') {
          return [{
            tag_name: tagName,
            name: tagName,
            html_url: `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`,
            body: '',
            published_at: '',
            draft: false,
            prerelease: /alpha|beta|rc|pre-?release/i.test(tagName),
            assets: []
          }];
        }
      }
    } catch { }
  }
  throw new Error('releases/latest 页面结构异常，未能解析最新版本号');
}

function parseExpandedAssetsHtml(htmlText, tagName) {
  if (!htmlText || typeof htmlText !== 'string' || !tagName) {
    throw new Error('expanded_assets 响应为空或缺少版本标签');
  }
  const assets = [];
  const seen = new Set();
  const hrefRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = hrefRegex.exec(htmlText)) !== null) {
    const rawHref = decodeHtmlEntities(match[1]).trim();
    if (!rawHref) continue;
    let absUrl;
    try {
      absUrl = new URL(rawHref, 'https://github.com').toString();
    } catch {
      continue;
    }
    const u = new URL(absUrl);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') continue;
    const expectedPrefix = `/${OFFICIAL_REPO}/releases/download/`;
    if (!u.pathname.startsWith(expectedPrefix)) continue;
    const rest = u.pathname.slice(expectedPrefix.length);
    const segments = rest.split('/');
    if (segments.length !== 2) continue;
    const fileName = segments[1];
    if (!isOfficialAssetDownloadUrl(absUrl, fileName, tagName)) continue;
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    assets.push({
      name: fileName,
      browser_download_url: absUrl
    });
  }
  return assets;
}

function shouldUseWebFallback(err, rawData) {
  if (err) {
    if (err.statusCode === 403 || err.statusCode === 429) return true;
    if (/403|429|rate limit|HTTP (?:403|429|5\d\d)|ENOTFOUND|ECONN|ETIMEDOUT|超时/i.test(String(err.message || ''))) {
      return true;
    }
    return true;
  }
  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

async function fetchOfficialReleasesWithFallback(options = {}) {
  const effectiveCurrentVersion = options.currentVersion || PROJECT_VERSION;
  const fetcher = options._requestGithubUrl || requestGithubUrl;
  const timeout = options.timeout || 8000;
  let primaryErr = null;
  let usedSource = 'api';
  let releasesList = null;

  try {
    const rawData = await fetcher(OFFICIAL_RELEASES_API, { timeout });
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    if (Array.isArray(parsed)) {
      releasesList = parsed;
    } else {
      primaryErr = new Error(parsed?.message ? `GitHub API 返回异常: ${parsed.message}` : 'GitHub API 未返回版本列表');
    }
  } catch (err) {
    primaryErr = err;
  }

  if (!releasesList && shouldUseWebFallback(primaryErr)) {
    const fallbackErrors = [];
    try {
      const atomXml = await fetcher(OFFICIAL_RELEASES_ATOM, { timeout, accept: 'application/atom+xml, application/xml, text/xml, */*' });
      const atomText = typeof atomXml === 'object' && atomXml?.data ? atomXml.data : atomXml;
      releasesList = parseReleasesAtom(atomText);
      usedSource = 'atom';
    } catch (atomErr) {
      fallbackErrors.push(`releases.atom: ${atomErr.message}`);
    }

    if (!releasesList) {
      try {
        const latestRes = await fetcher(OFFICIAL_RELEASES_LATEST, {
          timeout,
          accept: 'text/html, */*',
          resolveWithMeta: true
        });
        const htmlBody = typeof latestRes === 'object' && latestRes !== null ? (latestRes.data || '') : latestRes;
        const finalUrl = typeof latestRes === 'object' && latestRes !== null ? (latestRes.finalUrl || '') : '';
        releasesList = parseLatestReleaseHtml(htmlBody, finalUrl);
        usedSource = 'latest';
      } catch (latestErr) {
        fallbackErrors.push(`releases/latest: ${latestErr.message}`);
      }
    }

    if (!releasesList) {
      const primaryMsg = primaryErr ? primaryErr.message : 'GitHub REST API 不可用';
      throw new Error(`${primaryMsg}（官方网页通道回退亦失败: ${fallbackErrors.join('; ')}；请前往发布页手动下载）`);
    }
  } else if (!releasesList) {
    throw primaryErr || new Error('未能获取有效的官方版本列表');
  }

  const valid = filterReleases(releasesList, effectiveCurrentVersion, {
    allowBetaUpdates: options.allowBetaUpdates === true
  });
  return {
    releases: valid,
    source: usedSource,
    rawCount: Array.isArray(releasesList) ? releasesList.length : 0
  };
}

async function resolveAssetsForWebRelease(targetRelease, fetcher, timeout = 8000) {
  if (!targetRelease || !targetRelease.tagName) return targetRelease;
  if (Array.isArray(targetRelease.assets) && targetRelease.assets.length > 0) return targetRelease;
  const assetsUrl = `${OFFICIAL_RELEASES_WEB_BASE}/expanded_assets/${encodeURIComponent(targetRelease.tagName)}`;
  const rawHtml = await fetcher(assetsUrl, { timeout, accept: 'text/html, */*' });
  const htmlBody = typeof rawHtml === 'object' && rawHtml?.data ? rawHtml.data : rawHtml;
  const parsedAssets = parseExpandedAssetsHtml(htmlBody, targetRelease.tagName);
  if (!parsedAssets.length) {
    throw new Error(`发布页资产列表解析为空或结构异常 (${targetRelease.tagName})，请前往官方发布页手动下载`);
  }
  return Object.assign({}, targetRelease, { assets: parsedAssets });
}

async function checkUpdateAsync(options = {}) {
  const runtimeVersion = options.currentVersion || PROJECT_VERSION;
  const diskVersion = getInstalledMeterVersion(options);
  const effectiveCurrentVersion = (diskVersion && compareVersions(diskVersion, runtimeVersion) > 0)
    ? diskVersion
    : runtimeVersion;
  const installedVersion = diskVersion || runtimeVersion;
  const resolvedAllowBeta = typeof options.allowBetaUpdates === 'boolean'
    ? options.allowBetaUpdates
    : getPluginSettings(options).allowBetaUpdates === true;

  const now = Date.now();
  const cacheTtl = 6 * 3600 * 1000;
  if (!options.force && cachedUpdateCheck && (now - cachedUpdateCheckAt < cacheTtl)) {
    // 若预发布通道开关或运行时版本与缓存不一致，缓存立即失效
    if (Boolean(cachedUpdateCheck.allowBetaUpdates) !== resolvedAllowBeta) {
      cachedUpdateCheck = null;
      cachedUpdateCheckAt = 0;
    } else if (cachedUpdateCheck.currentVersion && cachedUpdateCheck.currentVersion !== runtimeVersion) {
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

  try {
    const fetcher = options._requestGithubUrl || requestGithubUrl;
    const { releases: valid, source } = await fetchOfficialReleasesWithFallback({
      currentVersion: effectiveCurrentVersion,
      allowBetaUpdates: resolvedAllowBeta,
      _requestGithubUrl: fetcher,
      timeout: 8000
    });
    if (valid.length > 0) {
      let latest = valid[0];
      let assetsWarning = null;
      if (source !== 'api' && (!latest.assets || latest.assets.length === 0)) {
        try {
          latest = await resolveAssetsForWebRelease(latest, fetcher, 8000);
        } catch (assetErr) {
          assetsWarning = assetErr.message;
        }
      }
      const bodyLines = (latest.body || '').split(/\r?\n/).slice(0, 8).join('\n');
      cachedUpdateCheck = {
        ok: true,
        hasUpdate: true,
        currentVersion: runtimeVersion,
        installedVersion,
        latestVersion: latest.version,
        prerelease: Boolean(latest.prerelease),
        allowBetaUpdates: resolvedAllowBeta,
        tagName: latest.tagName,
        releaseNotes: bodyLines,
        htmlUrl: latest.htmlUrl || `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(latest.tagName)}`,
        publishedAt: latest.publishedAt,
        assets: latest.assets,
        source,
        ...(assetsWarning ? { assetsWarning } : {})
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
      allowBetaUpdates: resolvedAllowBeta,
      diskPendingRestart: compareVersions(installedVersion, runtimeVersion) > 0,
      source
    };
    cachedUpdateCheckAt = now;
    return cachedUpdateCheck;
  } catch (err) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion: runtimeVersion,
      installedVersion,
      htmlUrl: OFFICIAL_RELEASES_WEB_BASE,
      error: sanitizeDiagnosticErrorText(err),
      ...(err?.diagnostics ? { diagnostics: err.diagnostics } : {})
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

/**
 * 等待可写文件流完成刷盘与自动关闭，避免测试替身或自定义下载器提前返回导致读取竞态。
 * @param {import('fs').WriteStream} stream
 * @returns {Promise<void>}
 */
function waitWritableStreamClose(stream) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.closed || stream.destroyed) {
      return resolve();
    }
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 3000);
    function cleanup() {
      clearTimeout(timer);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    }
    stream.once('close', onClose);
    stream.once('error', onError);
    if (stream.writableFinished && !stream.closed) {
      // writableFinished 为 true 时 autoClose 会紧接着 emit close
    }
  });
}

const LIVE_RUNTIME_FILES = [
  'package.json',
  'cli.js',
  'install.js',
  'restore.js',
  'live-host.js',
  'local-api.js',
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-storage.js',
  'meter-proxy.js',
  'meter-cli-launcher.js',
  'meter-cli-monitor.js',
  'meter-context-unlock.js',
  'meter-enhance.js',
  'meter-accounts.js',
  'macos-binary-utils.js',
  'attachment_scan.py',
  'asar-engine.js',
  'modules-config.js',
  'modular-installer.js',
  'i18n/zh-CN.json',
  'i18n/i18n-runtime.js'
];

function getLiveRuntimeDir(customStateDir = null) {
  const { getStateDir } = require('./asar-engine');
  const stateDir = customStateDir || getStateDir();
  return path.join(stateDir, 'live-runtime');
}

/**
 * 将运行外置 live-host 所需的纯 JS/配置运行时文件原子同步至 stateDir/live-runtime。
 * 保证在线更新清理临时目录或安装目录变动后，热加载后台进程仍能稳定运行至客户端重启。
 */
function syncLiveRuntimeBundle(sourceDir, options = {}) {
  try {
    if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'live-host.js')) || !fs.existsSync(path.join(sourceDir, 'meter-core.js'))) {
      return null;
    }
    const { getStateDir } = require('./asar-engine');
    const stateDir = options.stateDir || getStateDir();
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.stateDir) {
      const lowerState = stateDir.toLowerCase();
      const lowerTmp = os.tmpdir().toLowerCase();
      if (!lowerState.includes(lowerTmp)) {
        return null;
      }
    }
    const targetDir = getLiveRuntimeDir(stateDir);
    fs.mkdirSync(targetDir, { recursive: true });
    let copiedCount = 0;
    for (const rel of LIVE_RUNTIME_FILES) {
      const src = path.join(sourceDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmpDst = `${dst}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(src, tmpDst);
      fs.renameSync(tmpDst, dst);
      copiedCount++;
    }
    let pkgVersion = options.version || null;
    try {
      if (!pkgVersion && fs.existsSync(path.join(sourceDir, 'package.json'))) {
        pkgVersion = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version || null;
      }
    } catch {}
    safeWriteJsonSync(path.join(targetDir, '.runtime-manifest.json'), {
      version: pkgVersion || PROJECT_VERSION,
      copiedCount,
      updatedAt: new Date().toISOString()
    });
    return targetDir;
  } catch {
    return null;
  }
}

function parseInstallStdoutMeta(stdout = '') {
  try {
    const lines = String(stdout || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const idx = lines[i].indexOf('__AG_INSTALL_META__=');
      if (idx >= 0) {
        const jsonPart = lines[i].slice(idx + '__AG_INSTALL_META__='.length).trim();
        return JSON.parse(jsonPart);
      }
    }
  } catch {}
  return null;
}

function isTransientUpdateDownloadError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '').toUpperCase();
  if (/代理配置无效|认证失败|不受信任|协议不安全|checksums|sha-?256|拒绝安装/i.test(msg)) {
    return false;
  }
  const statusCode = Number(err?.statusCode);
  if ([400, 401, 403, 404, 410, 451].includes(statusCode)) {
    return false;
  }
  if ([429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }
  return ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(code) ||
    /ETIMEDOUT|ECONNRESET|EPIPE|ESOCKETTIMEDOUT|请求超时|意外中断|意外关闭|未完整结束|长度不完整|socket hang up/i.test(msg);
}

async function downloadAssetFileWithRetry(url, filePath, fetcher, options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
  const baseRetryDelayMs = Number.isFinite(Number(options.retryDelayMs))
    ? Number(options.retryDelayMs)
    : ((process.env.NODE_ENV === 'test' || process.env.AG_METER_TEST_MODE === '1') ? 10 : 600);
  const attempts = [];
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
    const stream = fs.createWriteStream(filePath);
    stream.on('error', () => { });
    const hopTrace = [];
    try {
      await fetcher(url, {
        timeout: options.timeout || 15000,
        streamTo: stream,
        phase: options.phase || 'download_asset',
        _hopTrace: hopTrace,
        ...(options.proxyConfigOptions ? { proxyConfigOptions: options.proxyConfigOptions } : {})
      });
      await waitWritableStreamClose(stream);
      return {
        stream,
        attemptsCount: attempt + 1,
        diagnostics: {
          phase: options.phase || 'download_asset',
          attemptsCount: attempt + 1,
          hops: hopTrace
        }
      };
    } catch (err) {
      lastErr = err;
      await safeCloseStream(stream).catch(() => { });
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      attempts.push({
        attempt: attempt + 1,
        error: sanitizeDiagnosticErrorText(err),
        diagnostics: err?.diagnostics || (hopTrace.length ? { phase: options.phase, hops: hopTrace } : null)
      });
      if (attempt < maxRetries && isTransientUpdateDownloadError(err)) {
        const delayMs = baseRetryDelayMs * (attempt + 1);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      if (lastErr && typeof lastErr === 'object') {
        lastErr.diagnostics = {
          ...(lastErr.diagnostics || {}),
          phase: options.phase || lastErr.diagnostics?.phase || 'download_asset',
          attemptsCount: attempt + 1,
          attempts
        };
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function applyUpdateAsync(options = {}) {
  if (isApplyingUpdate) {
    return { ok: false, error: '更新任务正在执行中，请勿重复操作' };
  }
  isApplyingUpdate = true;

  const currentVersion = options.currentVersion || PROJECT_VERSION;
  let tmpDir = null;
  let checksumStream = null;
  let zipStream = null;

  try {
    // 渲染层仅传版本标识，不传递外部资产 URL 或下载地址
    const requestedVersion = typeof options === 'string'
      ? options
      : (options?.version || options?.release?.latestVersion || null);

    const fetcher = options._requestGithubUrl || requestGithubUrl;
    let releaseQuery;
    try {
      releaseQuery = await fetchOfficialReleasesWithFallback({
        currentVersion,
        _requestGithubUrl: fetcher,
        timeout: 10000
      });
    } catch (e) {
      return { ok: false, error: `查询官方发布信息失败: ${e.message}`, htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
    }

    const validReleases = releaseQuery.releases;
    if (!validReleases || validReleases.length === 0) {
      return { ok: false, error: '未获取到可用的官方发布版本', htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
    }

    let targetRelease = null;
    if (requestedVersion) {
      targetRelease = validReleases.find(r => r.version === requestedVersion || r.tagName === requestedVersion || r.tagName === `v${requestedVersion}`);
      if (!targetRelease) {
        return { ok: false, error: `未在官方仓库中找到版本 ${requestedVersion}`, htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
      }
    } else {
      targetRelease = validReleases[0];
    }

    if (releaseQuery.source !== 'api' && (!targetRelease.assets || targetRelease.assets.length === 0)) {
      try {
        targetRelease = await resolveAssetsForWebRelease(targetRelease, fetcher, 10000);
      } catch (assetErr) {
        return {
          ok: false,
          error: assetErr.message,
          htmlUrl: targetRelease.htmlUrl || OFFICIAL_RELEASES_WEB_BASE
        };
      }
    }

    const effectivePlatform = options.platform || options._platform || process.platform;
    const effectiveArch = options.arch || options._arch || process.arch;
    const { packageAsset, checksumAsset, targetOs, targetArch } = findReleaseAsset(targetRelease.assets, effectivePlatform, effectiveArch);
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

    const checksumDl = await downloadAssetFileWithRetry(
      checksumAsset.browser_download_url,
      checksumPath,
      fetcher,
      {
        timeout: options._checksumTimeoutMs || 15000,
        phase: 'download_checksums',
        maxRetries: options._maxDownloadRetries,
        retryDelayMs: options._retryDelayMs,
        proxyConfigOptions: options.proxyConfigOptions
      }
    );
    checksumStream = checksumDl.stream;

    const packageDl = await downloadAssetFileWithRetry(
      packageAsset.browser_download_url,
      zipPath,
      fetcher,
      {
        timeout: options._packageTimeoutMs || 60000,
        phase: 'download_package',
        maxRetries: options._maxDownloadRetries,
        retryDelayMs: options._retryDelayMs,
        proxyConfigOptions: options.proxyConfigOptions
      }
    );
    zipStream = packageDl.stream;

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
      extractRes = spawnSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'ignore', windowsHide: true });
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
      } catch { }
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
          try { child.kill('SIGKILL'); } catch { }
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
          env: { ...(runtimeInfo.env || {}), AG_EMIT_INSTALL_META: '1' },
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

    const liveRuntimeDir = syncLiveRuntimeBundle(extractDir, {
      version: targetRelease.version,
      stateDir: options.stateDir
    });
    const installMeta = parseInstallStdoutMeta(execRes.stdout);
    const liveInjected = Boolean(
      installMeta?.liveInjected === true ||
      execRes.stdout.includes('已即时生效（无需重启）') ||
      execRes.stdout.includes('"liveInjected": true')
    );
    const finalInstalledVer = getInstalledMeterVersion(options) || targetRelease.version;
    return {
      ok: true,
      diskInstalled: true,
      liveInjected,
      backendHotReloaded: Boolean(installMeta?.backendHotReloaded),
      backendVersion: installMeta?.backendVersion || null,
      backendSource: installMeta?.backendSource || null,
      hotReloadReport: installMeta || null,
      liveRuntimeDir: liveRuntimeDir || null,
      version: targetRelease.version,
      installedVersion: finalInstalledVer,
      diagnostics: {
        checksums: checksumDl.diagnostics,
        package: packageDl.diagnostics
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: `更新安装异常: ${sanitizeDiagnosticErrorText(err)}`,
      ...(err?.diagnostics ? { diagnostics: err.diagnostics } : {})
    };
  } finally {
    isApplyingUpdate = false;
    try {
      if (checksumStream) await safeCloseStream(checksumStream);
      if (zipStream) await safeCloseStream(zipStream);
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { }
  }
}

module.exports = {
  sanitizeCascadeModelConfig,
  parseAvailableModelsResponse,
  extractObservedModelInfoFromSteps,
  mergeModelCapabilitiesIntoConfigs,
  fetchUserStatusFromHost,
  fetchQuotaSnapshotFromHost,
  buildAccountScopeKey,
  resetQuotaHostCacheForTest,
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
  parseLxssRegistryOutput,
  listRegisteredWslDistros,
  resolveWslDistroUncRoot,
  collectGeminiDirsFromLinuxRoot,
  discoverWslGeminiDirs,
  discoverWslGeminiDirsAsync,
  getEffectiveScanScopeKey,
  buildSqliteImmutableUri,
  extractStepModelsFromGenMetadataBlob,
  extractStepMetaFromGenMetadataBlob,
  extractTrajectoryBlobMeta,
  loadConversationDbMeta,
  loadStepModelMapFromSqlite,
  needsDbLabelEnrichment,
  backfillMissingModelsFromConversationDb,
  buildDailyModelBreakdown,
  collectSessionTimelineCoreAsync,
  collectSessionTimelineAsync,
  scanFiles,
  pythonScan,
  resolvePython,
  isCompanionOrTempFile,
  formatLocalDateKey,
  recordModelCalls,
  recordModelCallsAsync,
  recordModelCallsLockedAsync,
  resolveCallAccountAttribution,
  syncAccountLedgerPartitions,
  buildAccountUsageBreakdown,
  summarizeAccountWindowUsage,
  repairAndMigrateAccountLedger,
  repairAndMigrateAccountLedgerAsync,
  MAX_LEDGER_REPAIR_BACKUPS,
  listLedgerRepairBackups,
  pruneLedgerRepairBackups,
  cleanupUpgradeLedgerBackups,
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
  LIVE_RUNTIME_FILES,
  getLiveRuntimeDir,
  syncLiveRuntimeBundle,
  parseReleasesAtom,
  parseLatestReleaseHtml,
  parseExpandedAssetsHtml,
  requestGithubUrl,
  isAllowedDownloadRedirectUrl,
  isOfficialAssetDownloadUrl,
  OFFICIAL_RELEASES_API,
  OFFICIAL_RELEASES_ATOM,
  OFFICIAL_RELEASES_LATEST,
  OFFICIAL_RELEASES_WEB_BASE,
  resolveNodeRuntime,
  OFFICIAL_REPO,
  openHttpConnectTunnel,
  openSocks5Tunnel,
  getContextUnlockStatus,
  applyContextUnlock,
  applyContextUnlockAsync,
  restoreContextUnlock,
  restoreContextUnlockAsync,
  CONTEXT_UNLOCK_AUTHOR
};
