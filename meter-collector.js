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
  extractCallId,
  parseGeneratorCall,
  extractModelString,
  normalizeModelId,
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
    const attachments = await scanFiles(session.media);
    const attachmentTotal = empty();
    for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
    const total = add({ ...session.total }, attachmentTotal);
    let latest = null;
    const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
    const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, count - 3), includeMessages: false });
    let latestModel = null;
    for (const m of (tail.generatorMetadata || []).slice().reverse()) { latest = summarize(m); if (latest) { latestModel = m.chatModel; break; } }
    const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
    const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
    session.groups.system = system; session.groups.definitions = definitions;
    add(total, system); add(total, definitions);
    if (session.currentError) {
      const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, {
        currentModel: latest?.model || latestModel?.modelDisplayName || latestModel?.model || '',
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
    const result = { version: '0.8.2', conversation: id, workspacePath: wsPath || null, latest, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
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
  if (hasSynthetic) {
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

  // 正常落盘数据建立自动滚动备份，供损坏时恢复
  if (!readRes.corrupted) {
    try {
      if (!fsImpl.existsSync(bakPath) || Math.random() < 0.1) {
        fsImpl.copyFileSync(p, bakPath);
      }
    } catch {}
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
    } catch {}
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
  // 同等级权威日期修订：需显式更新的修订号（且用量未回退）、严格增长的用量（且修订号未倒退）或 streaming -> final 状态完成；
  // 已完成记录在无修订依据且同用量时保持首个权威日期（first-write-wins），阻断乱序旧包回滚与交替震荡
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

  const merged = {
    ...baseEntry,
    ...(!incomingIsStaleStatus && takeIncUsage ? incomingEntry : {}),
    ...(chosenDateInfo === incDateInfo && incomingEntry.timestamp !== undefined ? { timestamp: incomingEntry.timestamp } : {}),
    callId: canonicalKey,
    source: baseEntry.source || incomingEntry.source || 'desktop',
    ...(resolvedCascadeId ? { cascadeId: resolvedCascadeId } : {}),
    stepIndex: resolvedStep,
    model: mergedModel,
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
    updatedAt: Date.now()
  };
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
    String(c.status || ''),
    Boolean(c.isEstimated),
    Boolean(c.isPriced),
    Number(c.costUSD || 0),
    u.inp,
    u.cap,
    u.out,
    u.think,
    u.tot,
    String(c.date || ''),
    String(c.created_at || ''),
    String(c.dateSource || ''),
    Boolean(c.dateIsProvisional),
    rev ?? ''
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

  let reconciled = false;
  const usedRealKeys = new Set();
  const unmatchedSyn = [];

  // Rule A: 同 (source, cascadeId) 下显式包含相同 stepIndex 且模型兼容的真实 responseId 记录
  for (const sItem of synItems) {
    const { synKey, syn, synSrc, synCid, synStep } = sItem;
    const cands = realItems.filter(({ realKey, real }) => {
      if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
      if ((real.source || 'desktop') !== synSrc) return false;
      if (String(real.cascadeId || '').toLowerCase() !== synCid) return false;
      if (!extractCallStepNumbers(real, realKey).includes(synStep)) return false;
      return areModelsCompatible(real.model, syn.model);
    });

    let matchedRealKey = null;
    if (cands.length === 1) {
      // 单候选必须满足充分证据（精确用量一致 / 任一为流式或估算或 0 用量 / 任一缺失模型），证据不足时保留合成记录
      if (isConfirmableSingleStepMatch(cands[0].real, syn)) {
        matchedRealKey = cands[0].realKey;
      }
    } else if (cands.length > 1) {
      // 多条真实调用位于同一步骤：仅当恰好 1 条非零精确用量完全一致时才确认归并，否则保留合成记录
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
      const cands = realItems.filter(({ realKey, real }) => {
        if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
        if ((real.source || 'desktop') !== synSrc) return false;
        if (String(real.cascadeId || '').toLowerCase() !== synCid) return false;
        if (extractCallStepNumbers(real, realKey).length > 0) return false;
        const uReal = getCallTokenBreakdown(real);
        if (uReal.inp !== uSyn.inp || uReal.cap !== uSyn.cap || uReal.out !== uSyn.out) return false;
        return areModelsCompatible(real.model, syn.model);
      });

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

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const fsOpt = (options && typeof options === 'object' && options.fs) ? { fs: options.fs } : undefined;
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

    if (!existing) {
      const normalizedStep = extractCallStepNumbers(call, targetKey)[0] ?? null;
      const uInc = getCallTokenBreakdown(call);
      const dInfo = extractNormalizedDateInfo(call);
      const incRev = extractSourceRevision(call);
      const nextEntry = {
        ...call,
        callId: targetKey,
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
    const recalcExist = calculateRequestApiCost(existing);
    const costOutOfSync = Boolean(recalcExist.isPriced) !== Boolean(existing.isPriced)
      || (recalcExist.isPriced && Number(existing.costUSD || 0) !== Number(recalcExist.costUSD || 0));
    const pricingProgressed = costOutOfSync || ((!existing.isPriced || !existing.costUSD) && Boolean((call.isPriced && call.costUSD > 0) || normalizeModelId(call.model || existing.model)));
    const resolvedStepIndex = existing.stepIndex ?? call.stepIndex ?? extractCallStepNumbers(existing, targetKey)[0] ?? extractCallStepNumbers(call, targetKey)[0] ?? null;
    const metaProgressed = (existing.stepIndex == null && resolvedStepIndex != null) || (!existing.cascadeId && Boolean(callCidRaw));

    if (modelProgressed || metaProgressed || dateProgressed || (!isUsageRollback && (stateProgressed || usageProgressed || revisionUsageProgressed || revisionMetaProgressed || pricingProgressed))) {
      draftCalls[targetKey] = mergeSameCallRecords(
        existing,
        call,
        targetKey,
        resolvedStepIndex,
        !isUsageRollback && revCmp >= 0,
        adoptIncomingSameRankDate
      );
    }
  }

  // 第二阶段：在完整候选集（既有记录 + 整批新入账记录）上统一执行无顺序依赖的充分证据跨键消解
  reconcileConfirmableDuplicateStepCalls(draftCalls);

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

function loadCustomPlanSettings(overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const def = { version: '1.1.0', updatedAt: '', lastAccount: 'default', accounts: {}, uiPreferences: {} };
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;

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

    return {
      version: raw.version || '1.1.0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      lastAccount: typeof raw.lastAccount === 'string' ? raw.lastAccount : 'default',
      accounts,
      uiPreferences
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
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    savedHeatView: uiPrefs.savedHeatView,
    autoCheckUpdate: uiPrefs.autoCheckUpdate,
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
  if (typeof payload.autoCheckUpdate === 'boolean') {
    topLevelUiPrefs.autoCheckUpdate = payload.autoCheckUpdate;
  }
  const incomingUiPrefs = (payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences))
    ? { ...payload.uiPreferences, ...topLevelUiPrefs }
    : (Object.keys(topLevelUiPrefs).length > 0 ? topLevelUiPrefs : null);

  if (incomingUiPrefs) {
    settings.uiPreferences = {
      ...(settings.uiPreferences || {}),
      ...incomingUiPrefs,
      updatedAt: new Date().toISOString()
    };
  }

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
    uiPreferences: settings.uiPreferences
  };
}

let cachedHostUserStatus = null;
let cachedHostUserStatusAt = 0;

async function fetchUserStatusFromHost(options = {}) {
  if (options && options.userStatus !== undefined) {
    if (!options.userStatus) return null;
    const parsed = parseUserPlanStatus(options.userStatus);
    const configs = options.userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || options.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    if (parsed && configs.length) parsed.cascadeModelConfigs = configs;
    return parsed;
  }
  if (!options.agDir && cachedHostUserStatus && Date.now() - cachedHostUserStatusAt < 60000) {
    return cachedHostUserStatus;
  }
  try {
    const { connect } = require('./local-api');
    const api = await connect();
    const res = await api.call('GetUserStatus', {});
    const parsed = parseUserPlanStatus(res);
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    if (parsed && configs.length) parsed.cascadeModelConfigs = configs;
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
let activeScanScope = '';
let cachedTokenHistoryScope = '';
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'tasks', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

function getEffectiveScanScopeKey(options = {}) {
  const home = process.env.USERPROFILE || os.homedir();
  const agDir = path.resolve(options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity'));
  const agCliDir = path.resolve(options.agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli'));
  return process.platform === 'win32'
    ? `${agDir.toLowerCase()}|${agCliDir.toLowerCase()}`
    : `${agDir}|${agCliDir}`;
}

async function collectTokenHistoryAsync(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  if (!options.force && !options.agDir && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  if (!options.force && !options.agDir && activeScanPromise && activeScanScope === scopeKey) {
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
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        const parsedDate = new Date(rec.created_at);
        if (Number.isNaN(parsedDate.getTime())) continue;
        const dateKey = formatLocalDateKey(parsedDate);
        registerDate(dateKey);
        if (!rec.tot || !rec.eventId) continue;
        if (seenEvents.has(rec.eventId)) continue;
        seenEvents.add(rec.eventId);

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
          cascadeId: rec.cascadeId,
          stepIndex: rec.stepIndex,
          model: rec.model,
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

        recentRequests.push(reqObj);
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

  // 结合持久化逐请求账本与本次扫描调用：先与既有账本做双阶段 1-to-1 对齐与富化，再仅将未匹配的已计价扫描请求落盘
  const initialCallsMap = loadPricingLedger(agDir).calls || {};
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
        // 多真实调用同步骤时，仅在非零 Token 分项精确一致时一对一消费对应步骤记录，避免先到调用跨键误吞同步骤其它调用的日志
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
      // 仅当账本候选与未匹配 transcript 候选在兼容二分图上互为唯一候选（双边度数均为 1）时才执行绑定，消除遍历顺序依赖
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
  if (ledgerUpdates.length) {
    recordModelCalls(ledgerUpdates, { agDir, trustTranscriptDate: true });
  }

  const effectiveCallsMap = { ...(loadPricingLedger(agDir).calls || {}) };
  for (const [origKey, { targetCallId, merged }] of inMemoryEnrichments.entries()) {
    if (effectiveCallsMap[targetCallId]) {
      effectiveCallsMap[targetCallId] = mergeSameCallRecords(effectiveCallsMap[targetCallId], merged, targetCallId, merged.stepIndex, false, true);
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

  const out = {
    schemaVersion: '0.8.2',
    version: '0.8.2',
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
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
    cachedTokenHistoryScope = scopeKey;
    cachedTokenHistoryAt = Date.now();
  }
  return out;
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

function collectTokenHistory(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  if (!options.force && !options.agDir && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return (cachedTokenHistory && cachedTokenHistoryScope === scopeKey) ? cachedTokenHistory : {
    schemaVersion: '0.8.2',
    version: '0.8.2',
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
        'User-Agent': 'AntigravityContextMeter/0.8.2',
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
  const runtimeVersion = options.currentVersion || '0.8.2';
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

  const currentVersion = options.currentVersion || '0.8.2';
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
