'use strict';

/**
 * Antigravity 多账号统一身份、凭据切换、阈值自动切号、ELV-57 配额对照区间与 ELV-52 保活保障引擎。
 *
 * 复用与许可说明（MIT License）：
 * - Google OAuth2 回环授权、Token 刷新与 CloudCode 配额查询接口（loadCodeAssist / fetchAvailableModels / retrieveUserQuotaSummary）
 *   参考自 MIT 协议项目 `jlcodes99/vscode-antigravity-cockpit`（commit 14d40df3771d399a0596221351852bcc721b423a，原作者 jlcodes99，
 *   参考文件 src/auto_trigger/oauth_service.ts 与 src/shared/cloudcode_client.ts）。
 * - Antigravity 2.32.1 客户端凭据存储格式与 Protobuf 线缆结构已针对本机真实 `state.vscdb`、Windows Credential Manager (`gemini:antigravity`)
 *   及 `TokenUsageInsights`（MIT，commit 26652097e4e7a8a1208251c91c76f4c3bc2fd671）调研结果独立编写。
 * - 不包含任何 API 中转或模型重定向逻辑，亦不包含非 MIT 兼容项目代码。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { execFileSync, spawnSync } = require('child_process');

const { getStateDir, getAppDataDir } = require('./asar-engine');
const { buildModelQuotaSnapshot, selectPrimaryQuotaBucket, getModelPoolKey, getSharedQuotaGroupKey } = require('./meter-core');
const {
  applyProxyEnvironment,
  requestWithProxyTunnel,
  sanitizeDiagnosticErrorText,
  detectProxyConfig,
  redactProxyUrl
} = require('./meter-proxy');

// 宿主官方 OAuth Client 成对非敏感摘要锚点（严禁在源码硬编码 OAuth 客户端密钥字面量，运行时按需从本机已安装的 Antigravity 二进制/环境变量读取）
// 注意：每个 client_id 与其对应 client_secret 必须严格成对绑定，不可交叉混配
const OFFICIAL_OAUTH_CLIENT_PAIRS = Object.freeze([
  {
    key: 'antigravity_default',
    clientIdSha256: 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',
    clientSecretSha256: '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60'
  },
  {
    key: 'antigravity_enterprise',
    clientIdSha256: '69dee430c4e956f6b672b99a846566d6a86814999fc3b3b050697c0d65ea80c3',
    clientSecretSha256: 'a2ddedc84850a9c48b7e01d61700848083bf0e10fb8d6c99c496803e8b48ced0'
  }
]);
const OAUTH_GOOGLE_SUFFIX = '.apps.googleusercontent.com';
const OAUTH_SECRET_TAG = 'GOCSP' + 'X-';
let cachedHostOAuthPairs = null;
let cachedHostOAuthBinPath = '';

function streamScanLanguageServerOAuthPairs(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return [];
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const OVERLAP = 512;
  const fd = fs.openSync(binPath, 'r');
  const idByHash = new Map();
  const secByHash = new Map();
  const wantedIdHashes = new Set(OFFICIAL_OAUTH_CLIENT_PAIRS.map(p => p.clientIdSha256));
  const wantedSecHashes = new Set(OFFICIAL_OAUTH_CLIENT_PAIRS.map(p => p.clientSecretSha256));

  try {
    const stat = fs.fstatSync(fd);
    let offset = 0;
    let tailBuf = Buffer.alloc(0);
    const idAnchor = Buffer.from(OAUTH_GOOGLE_SUFFIX, 'utf8');
    const secAnchor = Buffer.from(OAUTH_SECRET_TAG, 'utf8');

    while (offset < stat.size && (idByHash.size < wantedIdHashes.size || secByHash.size < wantedSecHashes.size)) {
      const readLen = Math.min(CHUNK_SIZE, stat.size - offset);
      const chunk = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fd, chunk, 0, readLen, offset);
      if (bytesRead <= 0) break;
      const work = tailBuf.length > 0 ? Buffer.concat([tailBuf, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);

      if (idByHash.size < wantedIdHashes.size) {
        let idx = 0;
        while ((idx = work.indexOf(idAnchor, idx)) !== -1) {
          const sliceStart = Math.max(0, idx - 64);
          const candidateWindow = work.subarray(sliceStart, idx + idAnchor.length).toString('utf8');
          const m = candidateWindow.match(/[0-9]{10,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/);
          if (m) {
            const h = crypto.createHash('sha256').update(m[0]).digest('hex');
            if (wantedIdHashes.has(h) && !idByHash.has(h)) {
              idByHash.set(h, m[0]);
            }
          }
          idx += idAnchor.length;
        }
      }

      if (secByHash.size < wantedSecHashes.size) {
        let idx = 0;
        while ((idx = work.indexOf(secAnchor, idx)) !== -1) {
          if (idx + 35 <= work.length) {
            const cand = work.subarray(idx, idx + 35).toString('utf8');
            if (/^[A-Za-z0-9_-]{35}$/.test(cand)) {
              const h = crypto.createHash('sha256').update(cand).digest('hex');
              if (wantedSecHashes.has(h) && !secByHash.has(h)) {
                secByHash.set(h, cand);
              }
            }
          }
          idx += secAnchor.length;
        }
      }

      offset += bytesRead;
      tailBuf = work.length > OVERLAP ? Buffer.from(work.subarray(work.length - OVERLAP)) : Buffer.from(work);
    }
  } finally {
    fs.closeSync(fd);
  }

  const pairs = [];
  for (const spec of OFFICIAL_OAUTH_CLIENT_PAIRS) {
    const clientId = idByHash.get(spec.clientIdSha256);
    const clientSecret = secByHash.get(spec.clientSecretSha256);
    if (clientId && clientSecret) {
      pairs.push({
        key: spec.key,
        clientId,
        clientSecret,
        source: 'antigravity_host_binary'
      });
    }
  }
  return pairs;
}

function getHostBinaryOAuthPairs(options = {}) {
  try {
    const { detectTargetBinary } = require('./meter-context-unlock');
    const lsPath = typeof detectTargetBinary === 'function' ? detectTargetBinary(options.languageServerPath) : null;
    if (lsPath) {
      if (cachedHostOAuthPairs && cachedHostOAuthBinPath === lsPath) return cachedHostOAuthPairs;
      const scanned = streamScanLanguageServerOAuthPairs(lsPath);
      if (scanned.length) {
        cachedHostOAuthPairs = scanned;
        cachedHostOAuthBinPath = lsPath;
        return scanned;
      }
    }
  } catch { }
  return cachedHostOAuthPairs || [];
}

function resolveAllAntigravityOAuthConfigs(options = {}) {
  const optId = typeof options.oauthClientId === 'string' ? options.oauthClientId.trim() : '';
  const optSec = typeof options.oauthClientSecret === 'string' ? options.oauthClientSecret.trim() : '';
  if (optId && optSec) {
    return [{
      key: options.oauthClientKey || 'explicit_option',
      clientId: optId,
      clientSecret: optSec,
      source: 'explicit_option'
    }];
  }
  const envId = String(process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || process.env.AG_OAUTH_CLIENT_ID || '').trim();
  const envSec = String(process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || process.env.AG_OAUTH_CLIENT_SECRET || '').trim();
  if (envId && envSec) {
    return [{
      key: 'environment',
      clientId: envId,
      clientSecret: envSec,
      source: 'environment'
    }];
  }
  const pairs = getHostBinaryOAuthPairs(options);
  if (!pairs.length) return [];

  const preferredKey = typeof options.oauthClientKey === 'string' ? options.oauthClientKey.trim() : '';
  const preferredId = typeof options.preferredClientId === 'string' ? options.preferredClientId.trim() : '';
  if (!preferredKey && !preferredId) return pairs;

  const sorted = [...pairs].sort((a, b) => {
    const aHit = (preferredId && a.clientId === preferredId) || (preferredKey && a.key === preferredKey) ? 1 : 0;
    const bHit = (preferredId && b.clientId === preferredId) || (preferredKey && b.key === preferredKey) ? 1 : 0;
    return bHit - aHit;
  });
  return sorted;
}

function resolveAntigravityOAuthConfig(options = {}) {
  const list = resolveAllAntigravityOAuthConfigs(options);
  return list.length ? list[0] : null;
}
const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode'
];
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CLOUDCODE_PROD_URL = 'https://cloudcode-pa.googleapis.com';
const CLOUDCODE_DAILY_URL = 'https://daily-cloudcode-pa.googleapis.com';

const CALLBACK_PORT_START = 11451;
const CALLBACK_PORT_RANGE = 80;

const DEFAULT_AUTO_SWITCH_CONFIG = Object.freeze({
  enabled: false,
  metricMode: 'remaining_pct', // 'remaining_pct' | 'used_pct'
  poolKey: 'shared_gemini_main',
  windowKey: 'primary', // 'primary' | '5h' | '7d'
  thresholdPct: 10,
  debounceSec: 15,
  cooldownSec: 180,
  waitUntilIdle: true,
  strategy: 'highest_quota', // 'highest_quota' | 'candidate_order'
  candidates: [] // email array
});

const DEFAULT_KEEPALIVE_CONFIG = Object.freeze({
  enabled: false,
  experimentApproved: false,
  targetAccountEmail: null,
  targetSessionId: null,
  targetModelId: null,
  intervalSec: 240,
  maxDurationMin: 30,
  maxRequests: 6
});

/**
 * Antigravity 2.32.1 真实协议与历史归属核实矩阵（供 UI 与文档直接展示，绝不虚报）
 */
const SOURCE_ATTRIBUTION_CAPABILITIES = Object.freeze({
  desktop: {
    source: 'desktop',
    label: 'Antigravity Desktop',
    canIdentifyHistoricalEmail: false,
    canIdentifyLiveSession: true,
    evidence: '本地 .pb/.pbtxt 对话文件不含邮箱；实时会话可依据已确认生效的 GetUserStatus 邮箱归属，早于登录记录的旧历史归入未归属。'
  },
  cli: {
    source: 'cli',
    label: 'Antigravity CLI',
    canIdentifyHistoricalEmail: false,
    canIdentifyLiveSession: true,
    evidence: '~/.gemini/antigravity-cli 会话日志与 .db 不含邮箱；仅当采集时捕获对应账号归属或带明确账户标记时归属当前账号，无依据旧历史独立保留。'
  },
  agent: {
    source: 'agent',
    label: 'Subagent / Agent',
    canIdentifyHistoricalEmail: false,
    canIdentifyLiveSession: true,
    evidence: '子代理经 parentCascadeId / subagent 描述继承父会话账号归属；若父会话未归属，子代理同样保持未归属。'
  },
  ide: {
    source: 'ide',
    label: 'Antigravity IDE',
    canIdentifyHistoricalEmail: false,
    canIdentifyLiveSession: false,
    evidence: 'IDE globalStorage/state.vscdb 仅记录当前桌面实例 userStatus，旧对话文件不含历史账号标签；旧 IDE 历史一律保留为未归属。'
  }
});

const ELV52_PROTOCOL_EVIDENCE = Object.freeze({
  checkedVersion: '2.32.1',
  rpcCountChecked: 375,
  hasServerTtlRpc: false,
  hasKeepaliveEndpoint: false,
  hasCacheWriteField: false,
  hasCacheTtlField: false,
  modelUsageFields: ['inputTokens', 'cacheReadTokens', 'outputTokens', 'responseOutputTokens', 'thinkingOutputTokens', 'model'],
  conclusion: '在已检查的 Antigravity 2.32.1 语言服务 375 个 RPC 和响应中，未发现明确的 Prompt Cache 续期或 TTL 接口，响应亦未见 cacheWriteTokens 或 cacheTtl；因此不展示虚构到期倒计时，缓存保活保持待验证/默认关闭。',
  minimalExperimentPlan: {
    id: 'elv52-ab-v1',
    requiresMaintainerApproval: true,
    isolationMode: 'dedicated_session_pair',
    targetModel: 'Gemini 4 Hydrogen (High)',
    totalRequestsPlanned: 5,
    prefixDesign: '完全一致的静态长前置上下文（约 20K tokens 中英文只读文本，禁用工具调用），两组各新建独立隔离会话并在相近时段顺序对比，以排除时间与前缀差异干扰。',
    groupA: '对照组（2 次请求，无保活）：t=0 分钟发送约 20K 前缀 + 第 1 问，静置至 t=6 分钟发送同前缀第 2 问，采集每次真实 cacheReadTokens、inputTokens、outputTokens 与剩余额度百分比变化。',
    groupB: '实验组（3 次请求，含 1 次保活）：t=0 分钟发送完全相同 20K 前缀 + 第 1 问，t=4 分钟向该独立测试会话发送 1 次极短纯文本心跳（仅 "ok"，禁用工具调用），t=6 分钟发送同前缀第 2 问，采集全部 3 次实际用量。',
    budgetAndLimits: {
      totalRequestsPlanned: 5,
      extraRequestsPerRun: 1,
      intervalSec: 240,
      maxDurationMin: 10,
      maxRequests: 2,
      estimatedTotalInputTokens: '冷启动约 20K×2（对照组、实验组首轮）；后续轮次若命中前缀则主要计入 cacheReadTokens，未命中则额外重读约 20K/轮',
      estimatedTotalOutputTokens: '总计约 60~150 output tokens（其中第 4 分钟心跳响应 <= 10 tokens）',
      stopConditions: [
        '两组各自完成第 2 轮提问（合计 5 次请求）即结束',
        '遭遇 429 限流、服务端异常或剩余额度出现非预期大幅下降立即中止',
        '发生账号切换、窗口退出或到达 maxRequests/maxDurationMin 上限立即停止',
        '检测到工具触发或前缀/模型与对照组不一致立即作废并终止'
      ]
    },
    verificationAndControl: '每次请求直接从本机真实步骤账本逐条采集 cache_read_tokens / input_tokens / output_tokens；严格固定同一模型、相同静态前缀及相邻时间窗口以排除时间与前缀差异。',
    abortRules: '任何真实额外模型请求必须先由维护者确认本实验方案后再放行，严禁向用户日常对话中偷偷插消息。'
  }
});

function normalizeEmail(email) {
  const s = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return s && s.includes('@') ? s : '';
}

function buildAccountScopeKey(emailOrId) {
  const raw = typeof emailOrId === 'string' ? emailOrId.trim().toLowerCase() : '';
  if (!raw) return 'unattributed';
  return 'acct_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function maskEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return '';
  const [local, domain] = clean.split('@');
  if (!domain) return clean;
  if (local.length <= 2) return `${local[0] || '*'}*@${domain}`;
  if (local.length <= 5) return `${local.slice(0, 2)}***@${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-2)}@${domain}`;
}

/**
 * 清理账号诊断信息中的一切敏感字段（授权码、Token、Secret、URL 查询参数等），仅保留阶段/主机/状态等排障元数据。
 */
function redactAccountDiagnosticEntry(entry = {}) {
  const cleanMsg = sanitizeDiagnosticErrorText(entry.message || entry.error || '');
  let cleanProxy = null;
  if (entry.proxyEndpoint) {
    cleanProxy = redactProxyUrl(String(entry.proxyEndpoint)) || null;
  }
  return {
    at: entry.at || new Date().toISOString(),
    action: String(entry.action || 'oauth'),
    stage: String(entry.stage || 'unknown'),
    targetHost: entry.targetHost ? String(entry.targetHost).split(/[/?#]/)[0] : null,
    proxySource: entry.proxySource || 'direct',
    proxyProtocol: entry.proxyProtocol || 'direct',
    proxyEndpoint: cleanProxy,
    httpStatus: Number.isFinite(Number(entry.httpStatus)) ? Number(entry.httpStatus) : null,
    errorCode: entry.errorCode ? String(entry.errorCode) : null,
    ok: Boolean(entry.ok),
    message: cleanMsg.slice(0, 300)
  };
}

function appendAccountDiagnostic(stateDir, entry = {}) {
  const clean = redactAccountDiagnosticEntry(entry);
  if (!stateDir) return clean;
  try {
    ensureDir(stateDir);
    const diagPath = path.join(stateDir, 'oauth_diagnostics.jsonl');
    fs.appendFileSync(diagPath, JSON.stringify(clean) + '\n', 'utf8');
  } catch { }
  return clean;
}

/**
 * 在已有连续配额采样区间与账号使用时间戳的基础上，派生已核实宿主活跃会话窗口。
 */
function deriveAccountSessionsFromStore(store) {
  const existing = Array.isArray(store?.accountSessions) ? store.accountSessions.filter(Boolean) : [];
  if (existing.length > 0) return existing;
  const intervals = Array.isArray(store?.quotaIntervals) ? store.quotaIntervals : [];
  if (!intervals.length) return [];

  const sorted = intervals
    .filter(iv => iv && iv.email && Number.isFinite(Number(iv.startAtMs)) && Number.isFinite(Number(iv.endAtMs)))
    .slice()
    .sort((a, b) => Number(a.startAtMs) - Number(b.startAtMs));

  const sessions = [];
  for (const iv of sorted) {
    const email = normalizeEmail(iv.email);
    if (!email) continue;
    const sMs = Number(iv.startAtMs);
    const eMs = Math.max(sMs, Number(iv.endAtMs));
    const scopeKey = buildAccountScopeKey(email);
    const last = sessions[sessions.length - 1];
    if (last && last.email === email && sMs - last.lastVerifiedAtMs <= 30 * 60 * 1000) {
      last.startAtMs = Math.min(last.startAtMs, sMs);
      last.lastVerifiedAtMs = Math.max(last.lastVerifiedAtMs, eMs);
      last.endAtMs = last.lastVerifiedAtMs;
    } else {
      if (last && last.endAtMs == null) last.endAtMs = last.lastVerifiedAtMs;
      sessions.push({
        email,
        accountScopeKey: scopeKey,
        source: 'desktop',
        startAtMs: sMs,
        lastVerifiedAtMs: eMs,
        endAtMs: eMs,
        evidence: 'quota_intervals_derived'
      });
    }
  }
  const activeEmail = normalizeEmail(store?.activeAccountEmail || '');
  const lastSess = sessions[sessions.length - 1];
  if (lastSess && activeEmail && lastSess.email === activeEmail) {
    lastSess.endAtMs = null;
  }
  return sessions;
}

function recordVerifiedAccountSession(store, { email, nowMs = Date.now(), source = 'desktop', evidence = 'host_user_status', forceNew = false } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || !store || typeof store !== 'object') return null;
  if (!Array.isArray(store.accountSessions)) {
    store.accountSessions = deriveAccountSessionsFromStore(store);
  }
  const ts = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const scopeKey = buildAccountScopeKey(cleanEmail);
  const sessions = store.accountSessions;
  const last = sessions[sessions.length - 1];

  if (!forceNew && last && last.email === cleanEmail && (ts - last.lastVerifiedAtMs) <= 30 * 60 * 1000 && last.endAtMs == null) {
    last.lastVerifiedAtMs = Math.max(last.lastVerifiedAtMs, ts);
    return last;
  }
  if (last && last.endAtMs == null) {
    last.endAtMs = Math.min(last.lastVerifiedAtMs, ts);
  }
  const nextSess = {
    email: cleanEmail,
    accountScopeKey: scopeKey,
    source: source || 'desktop',
    startAtMs: ts,
    lastVerifiedAtMs: ts,
    endAtMs: null,
    evidence
  };
  sessions.push(nextSess);
  if (sessions.length > 200) {
    store.accountSessions = sessions.slice(-200);
  }
  return nextSess;
}

function closeActiveAccountSessions(store, endAtMs = Date.now()) {
  if (!store || !Array.isArray(store.accountSessions)) return;
  const ts = Number.isFinite(Number(endAtMs)) ? Number(endAtMs) : Date.now();
  for (const s of store.accountSessions) {
    if (s && s.endAtMs == null) {
      s.endAtMs = Math.max(s.startAtMs, Math.min(s.lastVerifiedAtMs || ts, ts));
    }
  }
}

/**
 * 根据请求的权威开始/完成时间与已核实账号活跃窗口，判断可靠归属：
 * - 绝不根据当前登录态或会话标题猜归属；
 * - 无可靠时间戳、早于账号追踪起点、跨越切号边界或来自未核实历史源时，统一返回 unattributed 及具体原因。
 */
function resolveAccountForTimestamp({ reqStartMs, reqEndMs, source = 'desktop', accountSessions = [] } = {}) {
  const normSource = String(source || 'desktop').toLowerCase();
  if (normSource === 'ide') {
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'unverified_source_ide' };
  }
  const start = Number(reqStartMs);
  const end = Number.isFinite(Number(reqEndMs)) ? Number(reqEndMs) : start;
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) {
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'missing_request_timestamp' };
  }
  const rStart = Math.min(start, end);
  const rEnd = Math.max(start, end);
  const sessions = Array.isArray(accountSessions) ? accountSessions.filter(s => s && s.email && Number.isFinite(s.startAtMs)) : [];
  if (!sessions.length) {
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }

  let earliestStart = Infinity;
  const matching = [];
  for (const s of sessions) {
    if (s.startAtMs < earliestStart) earliestStart = s.startAtMs;
    const winStart = s.startAtMs - 5000;
    const winEnd = s.endAtMs != null ? (s.endAtMs + 5000) : (Math.max(s.lastVerifiedAtMs || s.startAtMs, s.startAtMs) + 180000);
    // 判断请求整个生命周期是否完全位于该已核实活跃窗口内部
    if (rStart >= winStart && rEnd <= winEnd) {
      matching.push(s);
    }
  }

  if (matching.length === 1) {
    return {
      accountScopeKey: matching[0].accountScopeKey || buildAccountScopeKey(matching[0].email),
      email: normalizeEmail(matching[0].email),
      confidence: 'verified_session_window',
      attributionSource: 'host_user_status_window'
    };
  }
  if (matching.length > 1) {
    const distinctEmails = new Set(matching.map(m => normalizeEmail(m.email)));
    if (distinctEmails.size === 1) {
      const m = matching[0];
      return {
        accountScopeKey: m.accountScopeKey || buildAccountScopeKey(m.email),
        email: normalizeEmail(m.email),
        confidence: 'verified_session_window',
        attributionSource: 'host_user_status_window'
      };
    }
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }

  // 检查是否跨越两个不同账号窗口边界
  const touched = sessions.filter(s => {
    const winStart = s.startAtMs - 5000;
    const winEnd = s.endAtMs != null ? (s.endAtMs + 5000) : (Math.max(s.lastVerifiedAtMs || s.startAtMs, s.startAtMs) + 180000);
    return rEnd >= winStart && rStart <= winEnd;
  });
  if (touched.length > 0) {
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }
  if (rEnd < earliestStart - 5000) {
    return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }
  return { accountScopeKey: null, email: null, confidence: 'unattributed', unattributedReason: 'outside_verified_window' };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function atomicWriteJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// =========================================================================
// 轻量零依赖 Protobuf 编解码器（严格匹配 Antigravity 2.32.1 state.vscdb 结构）
// =========================================================================

function encodeVarint(num) {
  let n = BigInt(num);
  if (n < 0n) n = BigInt.asUintN(64, n);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = BigInt(buf[pos++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return [Number(result), pos];
    shift += 7n;
  }
  throw new Error('Protobuf varint 截断');
}

function encodeProtoFieldBytes(fieldNum, payloadBuf) {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payloadBuf.length);
  return Buffer.concat([tag, len, payloadBuf]);
}

function encodeProtoFieldString(fieldNum, str) {
  return encodeProtoFieldBytes(fieldNum, Buffer.from(String(str || ''), 'utf8'));
}

function encodeProtoFieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function skipProtoField(buf, offset, wireType) {
  if (wireType === 0) return decodeVarint(buf, offset)[1];
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const [len, p] = decodeVarint(buf, offset);
    return p + len;
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`不支持的 Protobuf wireType=${wireType}`);
}

function decodeProtoFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = decodeVarint(buf, pos);
    pos = p1;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [val, p2] = decodeVarint(buf, pos);
      pos = p2;
      fields.push({ field, wire, value: val });
    } else if (wire === 2) {
      const [len, p2] = decodeVarint(buf, pos);
      pos = p2;
      const bytes = buf.subarray(pos, pos + len);
      pos += len;
      fields.push({ field, wire, bytes });
    } else {
      pos = skipProtoField(buf, pos, wire);
    }
  }
  return fields;
}

/**
 * 构建 Antigravity 2.32.1 `antigravityUnifiedStateSync.oauthToken` Base64 Topic payload
 */
function buildUnifiedOAuthTokenTopicBase64({ accessToken, refreshToken, expirySeconds, tokenType = 'Bearer', idToken = '' }) {
  const parts = [];
  if (accessToken) parts.push(encodeProtoFieldString(1, accessToken));
  if (tokenType) parts.push(encodeProtoFieldString(2, tokenType));
  if (refreshToken) parts.push(encodeProtoFieldString(3, refreshToken));
  if (Number.isFinite(Number(expirySeconds)) && Number(expirySeconds) > 0) {
    const tsBuf = Buffer.concat([
      encodeProtoFieldVarint(1, Math.floor(Number(expirySeconds))),
      encodeProtoFieldVarint(2, 0)
    ]);
    parts.push(encodeProtoFieldBytes(4, tsBuf));
  }
  if (idToken) parts.push(encodeProtoFieldString(5, idToken));

  const oauthInfoB64 = Buffer.concat(parts).toString('base64');
  const valMsg = encodeProtoFieldString(1, oauthInfoB64);
  const entryMsg = Buffer.concat([
    encodeProtoFieldString(1, 'oauthTokenInfoSentinelKey'),
    encodeProtoFieldBytes(2, valMsg)
  ]);
  return encodeProtoFieldBytes(1, entryMsg).toString('base64');
}

/**
 * 解析 Antigravity 2.32.1 `antigravityUnifiedStateSync.oauthToken` Base64 Topic payload
 */
function parseUnifiedOAuthTokenTopicBase64(topicBase64) {
  if (!topicBase64 || typeof topicBase64 !== 'string') return null;
  try {
    const topicBuf = Buffer.from(topicBase64.trim(), 'base64');
    const entries = decodeProtoFields(topicBuf).filter(f => f.field === 1 && f.bytes);
    for (const entry of entries) {
      const eFields = decodeProtoFields(entry.bytes);
      const keyF = eFields.find(f => f.field === 1 && f.bytes);
      const valF = eFields.find(f => f.field === 2 && f.bytes);
      if (!keyF || !valF) continue;
      if (keyF.bytes.toString('utf8') !== 'oauthTokenInfoSentinelKey') continue;
      const vFields = decodeProtoFields(valF.bytes);
      const b64F = vFields.find(f => f.field === 1 && f.bytes);
      if (!b64F) continue;
      const innerBuf = Buffer.from(b64F.bytes.toString('utf8'), 'base64');
      const infoFields = decodeProtoFields(innerBuf);
      const out = { accessToken: '', tokenType: 'Bearer', refreshToken: '', expirySeconds: null, idToken: '' };
      for (const f of infoFields) {
        if (f.field === 1 && f.bytes) out.accessToken = f.bytes.toString('utf8');
        else if (f.field === 2 && f.bytes) out.tokenType = f.bytes.toString('utf8');
        else if (f.field === 3 && f.bytes) out.refreshToken = f.bytes.toString('utf8');
        else if (f.field === 4 && f.bytes) {
          const tsF = decodeProtoFields(f.bytes).find(x => x.field === 1 && typeof x.value === 'number');
          if (tsF) out.expirySeconds = tsF.value;
        } else if (f.field === 5 && f.bytes) out.idToken = f.bytes.toString('utf8');
      }
      if (out.refreshToken || out.accessToken) return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 构建 Antigravity 2.32.1 `antigravityUnifiedStateSync.userStatus` Base64 Topic payload
 */
function buildUnifiedUserStatusTopicBase64({ email, name }) {
  const parts = [];
  if (name || email) parts.push(encodeProtoFieldString(3, name || email.split('@')[0] || 'User'));
  if (email) parts.push(encodeProtoFieldString(7, email));
  const innerB64 = Buffer.concat(parts).toString('base64');
  const valMsg = encodeProtoFieldString(1, innerB64);
  const entryMsg = Buffer.concat([
    encodeProtoFieldString(1, 'userStatusSentinelKey'),
    encodeProtoFieldBytes(2, valMsg)
  ]);
  return encodeProtoFieldBytes(1, entryMsg).toString('base64');
}

function parseUnifiedUserStatusTopicBase64(topicBase64) {
  if (!topicBase64 || typeof topicBase64 !== 'string') return null;
  try {
    const topicBuf = Buffer.from(topicBase64.trim(), 'base64');
    const entries = decodeProtoFields(topicBuf).filter(f => f.field === 1 && f.bytes);
    for (const entry of entries) {
      const eFields = decodeProtoFields(entry.bytes);
      const keyF = eFields.find(f => f.field === 1 && f.bytes);
      const valF = eFields.find(f => f.field === 2 && f.bytes);
      if (!keyF || !valF || keyF.bytes.toString('utf8') !== 'userStatusSentinelKey') continue;
      const b64F = decodeProtoFields(valF.bytes).find(f => f.field === 1 && f.bytes);
      if (!b64F) continue;
      const innerBuf = Buffer.from(b64F.bytes.toString('utf8'), 'base64');
      const uFields = decodeProtoFields(innerBuf);
      const nameF = uFields.find(f => f.field === 3 && f.bytes);
      const emailF = uFields.find(f => f.field === 7 && f.bytes);
      return {
        name: nameF ? nameF.bytes.toString('utf8') : '',
        email: emailF ? normalizeEmail(emailF.bytes.toString('utf8')) : ''
      };
    }
    return null;
  } catch {
    return null;
  }
}

function decodeJwtEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return '';
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return normalizeEmail(payload?.email || '');
  } catch {
    return '';
  }
}

// =========================================================================
// Windows Credential Manager / macOS Keychain / state.vscdb / CLI 凭据读写
// =========================================================================

function getSqliteSyncCtor() {
  try {
    const sqliteMod = require('node:sqlite');
    if (sqliteMod?.DatabaseSync) return sqliteMod.DatabaseSync;
  } catch { }
  return null;
}

function resolveSystemNodeBinary() {
  const candidates = process.platform === 'win32'
    ? ['node.exe', 'node']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', 'node'];
  for (const cand of candidates) {
    try {
      const out = spawnSync(cand, ['-e', 'require("node:sqlite");console.log("ok")'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (out.status === 0 && String(out.stdout || '').includes('ok')) return cand;
    } catch { }
  }
  return null;
}

function readStateDbItems(dbPath, keys) {
  if (!dbPath || !fs.existsSync(dbPath)) return {};
  const DatabaseSync = getSqliteSyncCtor();
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const out = {};
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      for (const k of keys) {
        const row = stmt.get(k);
        out[k] = row ? row.value : null;
      }
      return out;
    } finally {
      db.close();
    }
  }
  const nodeBin = resolveSystemNodeBinary();
  if (!nodeBin) return {};
  const res = spawnSync(nodeBin, [
    '-e',
    'const{DatabaseSync}=require("node:sqlite"),p=JSON.parse(process.argv[1]);const db=new DatabaseSync(p.db,{readOnly:true});const out={};for(const k of p.keys){const r=db.prepare("SELECT value FROM ItemTable WHERE key=?").get(k);out[k]=r?r.value:null;}db.close();console.log(JSON.stringify(out));',
    JSON.stringify({ db: dbPath, keys })
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (res.status === 0) {
    try { return JSON.parse(res.stdout || '{}'); } catch { return {}; }
  }
  return {};
}

function writeStateDbItems(dbPath, entriesMap) {
  if (!dbPath || !fs.existsSync(dbPath)) return { ok: false, skipped: true, reason: 'db_missing' };
  const DatabaseSync = getSqliteSyncCtor();
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('BEGIN IMMEDIATE');
      const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      const del = db.prepare('DELETE FROM ItemTable WHERE key = ?');
      for (const [k, v] of Object.entries(entriesMap)) {
        if (v === null || v === undefined) del.run(k);
        else upsert.run(k, String(v));
      }
      db.exec('COMMIT');
      return { ok: true };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      return { ok: false, error: e.message };
    } finally {
      db.close();
    }
  }
  const nodeBin = resolveSystemNodeBinary();
  if (!nodeBin) return { ok: false, error: '当前运行环境及系统均不可用 node:sqlite' };
  const res = spawnSync(nodeBin, [
    '-e',
    'const{DatabaseSync}=require("node:sqlite"),p=JSON.parse(process.argv[1]);const db=new DatabaseSync(p.db);db.exec("PRAGMA busy_timeout = 5000;");db.exec("BEGIN IMMEDIATE");const up=db.prepare("INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)"),dl=db.prepare("DELETE FROM ItemTable WHERE key=?");for(const[k,v]of Object.entries(p.entries)){if(v===null||v===undefined)dl.run(k);else up.run(k,String(v));}db.exec("COMMIT");db.close();',
    JSON.stringify({ db: dbPath, entries: entriesMap })
  ], { encoding: 'utf8', timeout: 6000, windowsHide: true });
  return res.status === 0
    ? { ok: true }
    : { ok: false, error: (res.stderr || res.stdout || '写入 state.vscdb 失败').trim() };
}

/**
 * Windows Credential Manager (Advapi32 P/Invoke CredReadW / CredWriteW，支持 >1KB UTF-8 JSON，且凭证经 stdin 传参，绝不进命令行参数)
 */
const WIN_CREDMGR_PS_PREFIX = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AgCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree([In] IntPtr buffer);

  public static string ReadUtf8(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0 || c.CredentialBlob == IntPtr.Zero) return "";
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally {
      CredFree(ptr);
    }
  }

  public static bool WriteUtf8(string target, string user, string secret) {
    byte[] bytes = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1;
    c.TargetName = target;
    c.UserName = user;
    c.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
    c.CredentialBlobSize = (uint)bytes.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      return CredWrite(ref c, 0);
    } finally {
      Marshal.FreeCoTaskMem(c.CredentialBlob);
    }
  }
}
"@
`;

function createDefaultSystemCredentialStore(dirs = {}) {
  const homeDir = dirs.homeDir || os.homedir();
  const appDataDir = dirs.appDataDir || process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const desktopDbPath = dirs.desktopDbPath || (process.platform === 'darwin'
    ? path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
    : path.join(appDataDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
  const ideDbPath = dirs.ideDbPath || (process.platform === 'darwin'
    ? path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
    : path.join(appDataDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
  const googleAccountsPath = path.join(homeDir, '.gemini', 'google_accounts.json');
  const oauthCredsPath = path.join(homeDir, '.gemini', 'oauth_creds.json');
  const jetskiTokenPath = path.join(homeDir, '.gemini', 'jetski-standalone-oauth-token');
  const cliTokenPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

  return {
    getPaths() {
      return { desktopDbPath, ideDbPath, googleAccountsPath, oauthCredsPath, jetskiTokenPath, cliTokenPath };
    },

    readWindowsSystemCredential() {
      if (process.platform !== 'win32') return null;
      const script = `${WIN_CREDMGR_PS_PREFIX}\n$v = [AgCredMan]::ReadUtf8('gemini:antigravity')\nif ($null -ne $v) { [Console]::Out.Write($v) }\n`;
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: script,
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true
      });
      if (res.status !== 0 || !res.stdout) return null;
      try { return JSON.parse(res.stdout); } catch { return res.stdout; }
    },

    writeWindowsSystemCredential(payloadObj) {
      if (process.platform !== 'win32') return { ok: false, skipped: true };
      const jsonStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
      const b64 = Buffer.from(jsonStr, 'utf8').toString('base64');
      const script = `${WIN_CREDMGR_PS_PREFIX}\n$raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))\n$ok = [AgCredMan]::WriteUtf8('gemini:antigravity', 'antigravity', $raw)\nif (-not $ok) { exit 2 }\n`;
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: script,
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true
      });
      return res.status === 0
        ? { ok: true }
        : { ok: false, error: (res.stderr || `CredWrite exit ${res.status}`).trim() };
    },

    readMacKeychainCredential() {
      if (process.platform !== 'darwin') return null;
      try {
        const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], { encoding: 'utf8', timeout: 4000 }).trim();
        const raw = out.startsWith('go-keyring-base64:') ? Buffer.from(out.slice('go-keyring-base64:'.length), 'base64').toString('utf8') : out;
        try { return JSON.parse(raw); } catch { return raw; }
      } catch {
        return null;
      }
    },

    writeMacKeychainCredential(payloadObj) {
      if (process.platform !== 'darwin') return { ok: false, skipped: true };
      try {
        const jsonStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
        const encoded = `go-keyring-base64:${Buffer.from(jsonStr, 'utf8').toString('base64')}`;
        execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', 'gemini', '-a', 'antigravity', '-w', encoded], { timeout: 5000 });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    captureSnapshot() {
      const snap = {
        capturedAtMs: Date.now(),
        platform: process.platform,
        winCred: this.readWindowsSystemCredential(),
        macCred: this.readMacKeychainCredential(),
        desktopDbRows: readStateDbItems(desktopDbPath, [
          'antigravityUnifiedStateSync.oauthToken',
          'antigravityUnifiedStateSync.userStatus',
          'antigravityOnboarding'
        ]),
        ideDbRows: readStateDbItems(ideDbPath, [
          'antigravityUnifiedStateSync.oauthToken',
          'antigravityUnifiedStateSync.userStatus',
          'antigravityOnboarding'
        ]),
        googleAccountsRaw: fs.existsSync(googleAccountsPath) ? fs.readFileSync(googleAccountsPath, 'utf8') : null,
        oauthCredsRaw: fs.existsSync(oauthCredsPath) ? fs.readFileSync(oauthCredsPath, 'utf8') : null,
        jetskiTokenRaw: fs.existsSync(jetskiTokenPath) ? fs.readFileSync(jetskiTokenPath, 'utf8') : null,
        cliTokenRaw: fs.existsSync(cliTokenPath) ? fs.readFileSync(cliTokenPath, 'utf8') : null
      };
      return snap;
    },

    applyCredential({ email, name, accessToken, refreshToken, expiresAt, idToken }) {
      const expiryMs = expiresAt ? Date.parse(expiresAt) : Date.now() + 3600000;
      const expirySeconds = Math.floor((Number.isFinite(expiryMs) ? expiryMs : Date.now() + 3600000) / 1000);
      const isoExpiry = new Date(expirySeconds * 1000).toISOString();

      // 1. OS 共享系统凭据（Antigravity 2.x + CLI 共用格式；Windows Credential Blob 上限 2560B，超限时自动省略冗余 id_token）
      let systemPayload = {
        token: {
          access_token: accessToken,
          token_type: 'Bearer',
          refresh_token: refreshToken,
          expiry: isoExpiry
        },
        auth_method: 'consumer',
        ...(email ? { id_token_email: email } : {}),
        ...(idToken ? { id_token: idToken } : {})
      };
      if (process.platform === 'win32' && idToken && Buffer.byteLength(JSON.stringify(systemPayload), 'utf8') > 2500) {
        systemPayload = {
          token: systemPayload.token,
          auth_method: 'consumer',
          ...(email ? { id_token_email: email } : {})
        };
      }

      const stepResults = {};
      if (process.platform === 'win32') {
        stepResults.osCred = this.writeWindowsSystemCredential(systemPayload);
        if (!stepResults.osCred.ok) return { ok: false, stage: 'windows_credmgr', ...stepResults };
      } else if (process.platform === 'darwin') {
        stepResults.osCred = this.writeMacKeychainCredential(systemPayload);
        if (!stepResults.osCred.ok) return { ok: false, stage: 'macos_keychain', ...stepResults };
      }

      // 2. Desktop / IDE state.vscdb Protobuf 同步写入
      const oauthTopicB64 = buildUnifiedOAuthTokenTopicBase64({ accessToken, refreshToken, expirySeconds, idToken });
      const userTopicB64 = buildUnifiedUserStatusTopicBase64({ email, name });
      const dbEntries = {
        'antigravityUnifiedStateSync.oauthToken': oauthTopicB64,
        'antigravityUnifiedStateSync.userStatus': userTopicB64,
        'antigravityOnboarding': 'true'
      };
      if (fs.existsSync(desktopDbPath)) {
        stepResults.desktopDb = writeStateDbItems(desktopDbPath, dbEntries);
        if (!stepResults.desktopDb.ok) return { ok: false, stage: 'desktop_state_db', ...stepResults };
      }
      if (fs.existsSync(ideDbPath)) {
        stepResults.ideDb = writeStateDbItems(ideDbPath, dbEntries);
      }

      // 3. CLI ~/.gemini 文件同步
      try {
        ensureDir(path.dirname(googleAccountsPath));
        const prevGa = readJsonSafe(googleAccountsPath, { active: '', old: [] }) || { active: '', old: [] };
        const oldList = Array.isArray(prevGa.old) ? prevGa.old.filter(Boolean) : [];
        if (prevGa.active && prevGa.active.toLowerCase() !== email.toLowerCase() && !oldList.includes(prevGa.active)) {
          oldList.push(prevGa.active);
        }
        atomicWriteJson(googleAccountsPath, { active: email, old: oldList });

        atomicWriteJson(oauthCredsPath, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expiry_date: expirySeconds * 1000,
          scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
          ...(idToken ? { id_token: idToken } : {})
        });

        if (fs.existsSync(path.dirname(cliTokenPath))) {
          fs.writeFileSync(cliTokenPath, JSON.stringify(systemPayload, null, 2), 'utf8');
        }
        if (fs.existsSync(jetskiTokenPath)) {
          fs.writeFileSync(jetskiTokenPath, JSON.stringify(systemPayload, null, 2), 'utf8');
        }
        stepResults.cliFiles = { ok: true };
      } catch (e) {
        return { ok: false, stage: 'cli_files', error: e.message, ...stepResults };
      }

      return { ok: true, stepResults };
    },

    restoreSnapshot(snap) {
      if (!snap || typeof snap !== 'object') return { ok: false, error: '无有效回滚快照' };
      try {
        if (process.platform === 'win32' && snap.winCred) {
          this.writeWindowsSystemCredential(snap.winCred);
        } else if (process.platform === 'darwin' && snap.macCred) {
          this.writeMacKeychainCredential(snap.macCred);
        }
        if (fs.existsSync(desktopDbPath) && snap.desktopDbRows) {
          writeStateDbItems(desktopDbPath, snap.desktopDbRows);
        }
        if (fs.existsSync(ideDbPath) && snap.ideDbRows) {
          writeStateDbItems(ideDbPath, snap.ideDbRows);
        }
        if (snap.googleAccountsRaw !== null) fs.writeFileSync(googleAccountsPath, snap.googleAccountsRaw, 'utf8');
        else if (fs.existsSync(googleAccountsPath)) { try { fs.unlinkSync(googleAccountsPath); } catch { } }
        if (snap.oauthCredsRaw !== null) fs.writeFileSync(oauthCredsPath, snap.oauthCredsRaw, 'utf8');
        else if (fs.existsSync(oauthCredsPath)) { try { fs.unlinkSync(oauthCredsPath); } catch { } }
        if (snap.jetskiTokenRaw !== null && fs.existsSync(path.dirname(jetskiTokenPath))) {
          fs.writeFileSync(jetskiTokenPath, snap.jetskiTokenRaw, 'utf8');
        } else if (snap.jetskiTokenRaw === null && fs.existsSync(jetskiTokenPath)) {
          try { fs.unlinkSync(jetskiTokenPath); } catch { }
        }
        if (snap.cliTokenRaw !== null && fs.existsSync(path.dirname(cliTokenPath))) {
          fs.writeFileSync(cliTokenPath, snap.cliTokenRaw, 'utf8');
        } else if (snap.cliTokenRaw === null && fs.existsSync(cliTokenPath)) {
          try { fs.unlinkSync(cliTokenPath); } catch { }
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  };
}

// =========================================================================
// Google OAuth2 & CloudCode Quota API 客户端（适配自 MIT vscode-antigravity-cockpit）
// =========================================================================

/**
 * 统一通过显式代理隧道（HTTP CONNECT / SOCKS5）或本机直连执行远端 HTTP/HTTPS JSON 请求，
 * 彻底绕开 Electron/Node 在进程启动后才设置 NODE_USE_ENV_PROXY=1 被 undici 忽略的问题。
 */
async function fetchJsonWithProxy(urlStr, opts = {}, customFetch = null, proxyConfigOptions = {}) {
  const stage = opts.stage || 'http_request';
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  let targetHost = '';
  try {
    targetHost = new URL(urlStr).hostname;
  } catch { }

  if (typeof customFetch === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startMs = Date.now();
    try {
      const res = await customFetch(urlStr, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body,
        signal: controller.signal
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { }
      return {
        ok: res.ok,
        status: res.status,
        text,
        json,
        diagnostics: {
          stage,
          targetHost,
          proxySource: 'custom_fetch',
          proxyProtocol: 'custom',
          proxyEndpoint: null,
          bypassMatched: false,
          httpStatus: res.status,
          durationMs: Date.now() - startMs
        }
      };
    } catch (e) {
      const err = (e instanceof Error) ? e : new Error(String(e || '请求失败'));
      err.stage = err.stage || stage;
      err.targetHost = err.targetHost || targetHost;
      if (!err.diagnostics) {
        err.diagnostics = {
          stage,
          targetHost,
          proxySource: 'custom_fetch',
          proxyProtocol: 'custom',
          proxyEndpoint: null,
          httpStatus: null,
          errorCode: err.code || 'FETCH_ERROR',
          durationMs: Date.now() - startMs
        };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return await requestWithProxyTunnel(urlStr, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
    timeoutMs,
    stage,
    proxyConfigOptions
  });
}

function attachStageErrorMeta(err, stage, targetHost, httpStatus, diagnostics) {
  const targetErr = (err instanceof Error) ? err : new Error(String(err || '请求失败'));
  targetErr.stage = targetErr.stage || stage;
  targetErr.targetHost = targetErr.targetHost || targetHost || diagnostics?.targetHost || null;
  if (httpStatus != null && targetErr.httpStatus == null) targetErr.httpStatus = httpStatus;
  if (diagnostics && !targetErr.diagnostics) targetErr.diagnostics = diagnostics;
  return targetErr;
}

async function exchangeOAuthCode(code, redirectUri, customFetch = null, oauthConfig = null, proxyConfigOptions = {}) {
  const cfg = oauthConfig || resolveAntigravityOAuthConfig();
  if (!cfg?.clientId || !cfg?.clientSecret) {
    throw attachStageErrorMeta(
      new Error('未检测到可用 OAuth 客户端配置；可通过“导入当前”或“导入 Tools”添加账号，或配置 AG_OAUTH_CLIENT_ID / AG_OAUTH_CLIENT_SECRET。'),
      'oauth_config',
      'oauth2.googleapis.com',
      null,
      null
    );
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  let res;
  try {
    res = await fetchJsonWithProxy(OAUTH_TOKEN_URL, {
      method: 'POST',
      stage: 'token_exchange',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }, customFetch, proxyConfigOptions);
  } catch (e) {
    const diag = e?.diagnostics || {};
    const host = diag.targetHost || 'oauth2.googleapis.com';
    const cleanMsg = sanitizeDiagnosticErrorText(e);
    throw attachStageErrorMeta(
      new Error(`授权码换取 Token 网络失败 (${host}, 阶段: token_exchange): ${cleanMsg}`),
      'token_exchange',
      host,
      null,
      diag
    );
  }
  if (!res.ok || !res.json?.access_token) {
    const detail = sanitizeDiagnosticErrorText(res.json?.error_description || res.json?.error || res.text || 'unknown');
    throw attachStageErrorMeta(
      new Error(`OAuth Token 交换失败 (HTTP ${res.status}): ${detail.slice(0, 160)}`),
      'token_exchange',
      res.diagnostics?.targetHost || 'oauth2.googleapis.com',
      res.status,
      res.diagnostics
    );
  }
  return { ...res.json, _diagnostics: res.diagnostics || null };
}

async function refreshOAuthAccessToken(refreshToken, customFetch = null, oauthConfig = null, proxyConfigOptions = {}) {
  const cfg = oauthConfig || resolveAntigravityOAuthConfig();
  if (!cfg?.clientId || !cfg?.clientSecret) {
    throw attachStageErrorMeta(
      new Error('未检测到可用 OAuth 客户端配置，无法刷新 Token。'),
      'token_refresh',
      'oauth2.googleapis.com',
      null,
      null
    );
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  let res;
  try {
    res = await fetchJsonWithProxy(OAUTH_TOKEN_URL, {
      method: 'POST',
      stage: 'token_refresh',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }, customFetch, proxyConfigOptions);
  } catch (e) {
    const diag = e?.diagnostics || {};
    throw attachStageErrorMeta(
      new Error(`刷新 Token 网络失败 (${diag.targetHost || 'oauth2.googleapis.com'}): ${sanitizeDiagnosticErrorText(e)}`),
      'token_refresh',
      diag.targetHost || 'oauth2.googleapis.com',
      null,
      diag
    );
  }
  if (!res.ok || !res.json?.access_token) {
    const errCode = String(res.json?.error || '').trim().toLowerCase();
    const errDesc = String(res.json?.error_description || '').trim().toLowerCase();
    const lower = String(res.text || '').toLowerCase();
    const isClientMismatch = errCode === 'invalid_client'
      || errCode === 'unauthorized_client'
      || errDesc.includes('client secret is invalid')
      || errDesc.includes('invalid client')
      || lower.includes('invalid_client')
      || (res.status === 401 && errCode !== 'invalid_grant' && !errDesc.includes('expired or revoked'));
    const isInvalidGrant = !isClientMismatch && (
      errCode === 'invalid_grant'
      || lower.includes('invalid_grant')
      || errDesc.includes('token has been expired or revoked')
      || errDesc.includes('bad_refresh_token')
    );
    const detail = sanitizeDiagnosticErrorText(res.json?.error_description || res.json?.error || res.text || 'unknown');
    const err = attachStageErrorMeta(
      new Error(`刷新 Token 失败 (HTTP ${res.status}): ${detail.slice(0, 160)}`),
      'token_refresh',
      res.diagnostics?.targetHost || 'oauth2.googleapis.com',
      res.status,
      res.diagnostics
    );
    err.oauthErrorCode = errCode || null;
    err.isClientMismatch = isClientMismatch;
    err.isAuthInvalid = isInvalidGrant;
    throw err;
  }
  return {
    accessToken: res.json.access_token,
    refreshToken: res.json.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (Number(res.json.expires_in) || 3600) * 1000).toISOString(),
    idToken: res.json.id_token || '',
    oauthClientId: cfg.clientId,
    oauthClientKey: cfg.key || null
  };
}

async function fetchGoogleUserInfo(accessToken, customFetch = null, proxyConfigOptions = {}) {
  let res;
  try {
    res = await fetchJsonWithProxy(OAUTH_USERINFO_URL, {
      stage: 'userinfo_fetch',
      headers: { Authorization: `Bearer ${accessToken}` }
    }, customFetch, proxyConfigOptions);
  } catch (e) {
    const diag = e?.diagnostics || {};
    throw attachStageErrorMeta(
      new Error(`获取账号身份失败 (${diag.targetHost || 'www.googleapis.com'}): ${sanitizeDiagnosticErrorText(e)}`),
      'userinfo_fetch',
      diag.targetHost || 'www.googleapis.com',
      null,
      diag
    );
  }
  if (!res.ok || !res.json?.email) {
    throw attachStageErrorMeta(
      new Error(`获取 Google 用户信息失败 (HTTP ${res.status})`),
      'userinfo_fetch',
      res.diagnostics?.targetHost || 'www.googleapis.com',
      res.status,
      res.diagnostics
    );
  }
  return {
    email: normalizeEmail(res.json.email),
    name: String(res.json.name || res.json.given_name || res.json.email.split('@')[0] || '')
  };
}

async function fetchAccountQuotaViaCloudCode(accessToken, options = {}) {
  const customFetch = options.fetch || null;
  const proxyConfigOptions = options.proxyConfigOptions || {};
  const quotaStage = options.stage || 'quota_fetch';
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ua = `antigravity/2.33.0 ${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': ua,
    'Content-Type': 'application/json'
  };

  const initialBaseUrl = options.baseUrl || (options.useDaily === false ? CLOUDCODE_PROD_URL : CLOUDCODE_DAILY_URL);
  const allowFallback = !options.baseUrl && options.useDaily !== false && initialBaseUrl !== CLOUDCODE_PROD_URL;

  const tryRequest = async (baseUrl) => {
    let targetHost = 'cloudcode-pa.googleapis.com';
    try { targetHost = new URL(baseUrl).hostname; } catch { }
    let projectId = options.projectId || '';
    let tierId = null;
    try {
      const loadRes = await fetchJsonWithProxy(`${baseUrl}/v1internal:loadCodeAssist`, {
        method: 'POST',
        stage: quotaStage,
        headers,
        body: JSON.stringify({
          metadata: {
            ideName: 'antigravity',
            ideType: 'ANTIGRAVITY',
            pluginType: 'GEMINI',
            updateChannel: 'stable'
          },
          mode: 'FULL_ELIGIBILITY_CHECK',
          ...(projectId ? { cloudaicompanionProject: projectId } : {})
        })
      }, customFetch, proxyConfigOptions);
      if (loadRes.ok && loadRes.json) {
        if (typeof loadRes.json.cloudaicompanionProject === 'string' && loadRes.json.cloudaicompanionProject) {
          projectId = loadRes.json.cloudaicompanionProject;
        } else if (loadRes.json.cloudaicompanionProject?.id) {
          projectId = loadRes.json.cloudaicompanionProject.id;
        }
        tierId = loadRes.json.paidTier?.id || loadRes.json.currentTier?.id || null;
      } else if (loadRes.status === 401 || loadRes.status === 403) {
        const err = attachStageErrorMeta(
          new Error(`CloudCode 鉴权失效 (HTTP ${loadRes.status})`),
          quotaStage,
          targetHost,
          loadRes.status,
          loadRes.diagnostics
        );
        err.isAuthInvalid = true;
        throw err;
      }
    } catch (e) {
      if (e.isAuthInvalid) throw e;
    }

    const payload = projectId ? { project: projectId } : {};
    let availRes;
    let summaryRes;
    try {
      [availRes, summaryRes] = await Promise.all([
        fetchJsonWithProxy(`${baseUrl}/v1internal:fetchAvailableModels`, { method: 'POST', stage: quotaStage, headers, body: JSON.stringify(payload) }, customFetch, proxyConfigOptions),
        fetchJsonWithProxy(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, { method: 'POST', stage: quotaStage, headers, body: JSON.stringify(payload) }, customFetch, proxyConfigOptions)
      ]);
    } catch (e) {
      const diag = e?.diagnostics || {};
      throw attachStageErrorMeta(
        new Error(`CloudCode 配额请求网络失败 (${diag.targetHost || targetHost}): ${sanitizeDiagnosticErrorText(e)}`),
        quotaStage,
        diag.targetHost || targetHost,
        null,
        diag
      );
    }

    if (!availRes.ok && !summaryRes.ok) {
      const st = availRes.status || summaryRes.status;
      const err = attachStageErrorMeta(
        new Error(`CloudCode 配额请求失败 (HTTP ${st})`),
        quotaStage,
        targetHost,
        st,
        availRes.diagnostics || summaryRes.diagnostics
      );
      if (st === 401 || st === 403) err.isAuthInvalid = true;
      throw err;
    }

    return { projectId, tierId, availRes, summaryRes, targetHost };
  };

  let reqRes;
  try {
    reqRes = await tryRequest(initialBaseUrl);
  } catch (err) {
    if (err.isAuthInvalid || !allowFallback) throw err;
    reqRes = await tryRequest(CLOUDCODE_PROD_URL);
  }

  const { projectId, tierId, availRes, summaryRes } = reqRes;
  const modelsObj = availRes.json?.models && typeof availRes.json.models === 'object' ? availRes.json.models : {};
  const agentSorts = Array.isArray(availRes.json?.agentModelSorts) && availRes.json.agentModelSorts.length > 0
    ? new Set(availRes.json.agentModelSorts.map(s => String(s).trim().toLowerCase()))
    : null;
  const CORE_POOLS = new Set(['shared_gemini_main', 'shared_3p_pool', 'shared_gemini_argon', 'shared_gemini_carbon']);

  const clientModelConfigs = [];
  for (const [k, v] of Object.entries(modelsObj)) {
    if (!v || typeof v !== 'object') continue;
    if (v.isInternal === true) continue;
    const mKey = String(k || '').trim().toLowerCase();
    const mModel = String(v.model || '').trim().toLowerCase();
    if ((mKey.startsWith('chat_') && /^chat_\d+$/.test(mKey)) || (mModel.startsWith('chat_') && /^chat_\d+$/.test(mModel))) {
      continue;
    }
    if (mKey.startsWith('tab_') || mModel.startsWith('tab_')) {
      continue;
    }

    const cfg = {
      modelId: k,
      label: v.displayName || k,
      modelOrAlias: { model: v.model || k },
      quotaInfo: v.quotaInfo || null
    };

    const poolKey = getSharedQuotaGroupKey(cfg);
    if (!CORE_POOLS.has(poolKey)) {
      continue;
    }
    if (agentSorts && !agentSorts.has(mKey) && !agentSorts.has(mModel) && !agentSorts.has(poolKey)) {
      // 若有显式 agentModelSorts 且不在核心列表内则过滤
    }

    clientModelConfigs.push(cfg);
  }

  const quotaSummaryData = summaryRes.json?.response || summaryRes.json || null;
  const userStatusCompat = {
    userStatus: {
      email: options.email || '',
      planStatus: tierId ? { planInfo: { planName: tierId } } : undefined,
      cascadeModelConfigData: { clientModelConfigs }
    }
  };
  const snapshot = buildModelQuotaSnapshot({
    userStatusRes: userStatusCompat,
    quotaSummaryRes: quotaSummaryData,
    cascadeModelConfigs: clientModelConfigs,
    nowMs
  });

  return {
    projectId: projectId || null,
    tierId,
    tierName: snapshot?.planStatus?.tierName || tierId || null,
    snapshot,
    fetchedAtMs: nowMs
  };
}

// =========================================================================
// 核心协调管理器（统一账号状态、自动切号、ELV-57 区间对账、ELV-52 保活保障）
// =========================================================================

function createAccountsManager(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const homeDir = options.homeDir || os.homedir();
  const credStore = options.credentialStore || createDefaultSystemCredentialStore({
    homeDir,
    appDataDir: options.appDataDir,
    desktopDbPath: options.desktopDbPath,
    ideDbPath: options.ideDbPath
  });
  const customFetch = options.fetch || null;
  const restartLanguageServersFn = options.restartLanguageServers || (() => require('./meter-enhance').restartLanguageServersAsync({ includeCli: false }));
  const getHostUserStatusFn = options.getHostUserStatus || null;
  const checkHostBusyFn = options.checkHostBusy || null;
  const collector = options.collector || null;
  const oauthResolveOpts = {
    oauthClientId: options.oauthClientId,
    oauthClientSecret: options.oauthClientSecret,
    languageServerPath: options.languageServerPath
  };

  const storePath = path.join(stateDir, 'accounts_v1.json');
  const switchLockPath = path.join(stateDir, 'account_switch.lock');
  const keepaliveLockPath = path.join(stateDir, 'cache_keepalive.lock');

  const debounceState = new Map(); // accountKey -> { firstSeenMs }
  let inFlightSwitch = null;

  function isSwitchLockActive() {
    if (inFlightSwitch) return true;
    try {
      if (!fs.existsSync(switchLockPath)) return false;
      const existing = readJsonSafe(switchLockPath, null);
      return Boolean(existing && (Date.now() - Number(existing.acquiredAtMs || 0)) <= 25000);
    } catch {
      return false;
    }
  }

  function loadStore() {
    const raw = readJsonSafe(storePath, null);
    if (!raw || typeof raw !== 'object') {
      return {
        version: 1,
        activeAccountEmail: null,
        accounts: {}, // email -> record
        autoSwitch: { ...DEFAULT_AUTO_SWITCH_CONFIG },
        autoSwitchStatus: {
          state: 'disabled', // disabled | watching | pending_debounce | waiting_idle | cooldown | switching | all_candidates_exhausted | error
          lastCheckAtMs: null,
          lastSwitchAtMs: 0,
          lastResult: null,
          lastError: null,
          blockedReason: null
        },
        keepalive: { ...DEFAULT_KEEPALIVE_CONFIG },
        keepaliveState: {
          running: false,
          startedAtMs: null,
          requestsSent: 0,
          lastPingAtMs: null,
          stopReason: null,
          blockedReason: null,
          lastError: null,
          backoffUntilMs: 0
        },
        quotaIntervals: [], // ELV-57 配额对照区间历史
        accountSessions: [], // 已核实账号活跃时间窗口
        lastDiagnostics: [] // 脱敏诊断记录
      };
    }
    const loaded = {
      version: 1,
      activeAccountEmail: raw.activeAccountEmail || null,
      accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
      autoSwitch: { ...DEFAULT_AUTO_SWITCH_CONFIG, ...(raw.autoSwitch || {}) },
      autoSwitchStatus: {
        state: raw.autoSwitch?.enabled ? 'watching' : 'disabled',
        lastCheckAtMs: null,
        lastSwitchAtMs: 0,
        lastResult: null,
        lastError: null,
        blockedReason: null,
        ...(raw.autoSwitchStatus || {})
      },
      keepalive: { ...DEFAULT_KEEPALIVE_CONFIG, ...(raw.keepalive || {}) },
      keepaliveState: {
        running: false,
        startedAtMs: null,
        requestsSent: 0,
        lastPingAtMs: null,
        stopReason: null,
        blockedReason: null,
        lastError: null,
        backoffUntilMs: 0,
        ...(raw.keepaliveState || {})
      },
      quotaIntervals: Array.isArray(raw.quotaIntervals) ? raw.quotaIntervals : [],
      accountSessions: Array.isArray(raw.accountSessions) ? raw.accountSessions : [],
      lastDiagnostics: Array.isArray(raw.lastDiagnostics) ? raw.lastDiagnostics : []
    };
    if (!loaded.accountSessions.length && loaded.quotaIntervals.length) {
      loaded.accountSessions = deriveAccountSessionsFromStore(loaded);
    }
    // 清理旧版本因 OAuth Client 密钥错配 ("The provided client secret is invalid" / invalid_client) 误打上的 authInvalid 标记
    let healedFalseAuthInvalid = false;
    for (const acc of Object.values(loaded.accounts)) {
      if (!acc || !acc.authInvalid) continue;
      const errLower = String(acc.authError || '').toLowerCase();
      const isFalseClientMismatch = Boolean(acc.credential?.refreshToken) && (
        errLower.includes('client secret is invalid')
        || errLower.includes('invalid_client')
        || errLower.includes('unauthorized_client')
      );
      if (isFalseClientMismatch) {
        acc.authInvalid = false;
        acc.authError = null;
        healedFalseAuthInvalid = true;
      }
    }
    if (healedFalseAuthInvalid) {
      try { atomicWriteJson(storePath, loaded); } catch { }
    }
    return loaded;
  }

  function recordDiag(store, entry) {
    const clean = appendAccountDiagnostic(stateDir, entry);
    if (store && typeof store === 'object') {
      if (!Array.isArray(store.lastDiagnostics)) store.lastDiagnostics = [];
      store.lastDiagnostics.push(clean);
      if (store.lastDiagnostics.length > 20) store.lastDiagnostics = store.lastDiagnostics.slice(-20);
    }
    return clean;
  }

  function saveStore(store) {
    atomicWriteJson(storePath, store);
  }

  function acquireSimpleLock(lockPath, ttlMs = 15000) {
    ensureDir(path.dirname(lockPath));
    const lockToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    try {
      if (fs.existsSync(lockPath)) {
        const existing = readJsonSafe(lockPath, null);
        if (!existing || (now - Number(existing.acquiredAtMs || 0)) > ttlMs) {
          try { fs.unlinkSync(lockPath); } catch { }
        }
      }
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: lockToken, acquiredAtMs: now }));
      fs.closeSync(fd);
      return {
        ok: true,
        release() {
          try {
            const cur = readJsonSafe(lockPath, null);
            if (!cur || cur.token === lockToken) fs.unlinkSync(lockPath);
          } catch { }
        }
      };
    } catch {
      return { ok: false, reason: 'locked_by_another_window' };
    }
  }

  function sanitizeAccountForView(rec, activeEmail) {
    if (!rec) return null;
    return {
      email: rec.email,
      maskedEmail: maskEmail(rec.email),
      accountScopeKey: rec.accountScopeKey || buildAccountScopeKey(rec.email),
      name: rec.name || rec.email.split('@')[0],
      source: rec.source || 'manual',
      oauthClientKey: rec.oauthClientKey || null,
      isActive: Boolean(activeEmail && normalizeEmail(activeEmail) === normalizeEmail(rec.email)),
      hasRefreshToken: Boolean(rec.credential?.refreshToken),
      expiresAt: rec.credential?.expiresAt || null,
      authInvalid: Boolean(rec.authInvalid),
      authError: rec.authError || null,
      tierId: rec.tierId || null,
      tierName: rec.tierName || rec.quotaSnapshot?.planStatus?.tierName || null,
      projectId: rec.projectId || null,
      quotaSnapshot: rec.quotaSnapshot || null,
      lastQuotaUpdatedAtMs: rec.lastQuotaUpdatedAtMs || null,
      lastQuotaError: rec.lastQuotaError || null,
      lastQuotaErrorMeta: rec.lastQuotaErrorMeta || null,
      addedAtMs: rec.addedAtMs || null,
      lastUsedAtMs: rec.lastUsedAtMs || null
    };
  }

  function upsertAccountRecord(store, data) {
    const email = normalizeEmail(data.email);
    if (!email) throw new Error('无效账号邮箱');
    const prev = store.accounts[email] || {};
    const next = {
      email,
      accountScopeKey: buildAccountScopeKey(email),
      name: data.name || prev.name || email.split('@')[0],
      source: data.source || prev.source || 'manual',
      credential: {
        accessToken: data.credential?.accessToken || prev.credential?.accessToken || '',
        refreshToken: data.credential?.refreshToken || prev.credential?.refreshToken || '',
        expiresAt: data.credential?.expiresAt || prev.credential?.expiresAt || null,
        idToken: data.credential?.idToken || prev.credential?.idToken || ''
      },
      projectId: data.projectId ?? prev.projectId ?? null,
      tierId: data.tierId ?? prev.tierId ?? null,
      quotaSnapshot: data.quotaSnapshot !== undefined ? data.quotaSnapshot : (prev.quotaSnapshot || null),
      lastQuotaUpdatedAtMs: data.lastQuotaUpdatedAtMs ?? prev.lastQuotaUpdatedAtMs ?? null,
      lastQuotaError: data.lastQuotaError !== undefined ? data.lastQuotaError : (prev.lastQuotaError || null),
      lastQuotaErrorMeta: data.lastQuotaErrorMeta !== undefined ? data.lastQuotaErrorMeta : (prev.lastQuotaErrorMeta || null),
      authInvalid: data.authInvalid !== undefined ? Boolean(data.authInvalid) : Boolean(prev.authInvalid),
      authError: data.authError !== undefined ? data.authError : (prev.authError || null),
      oauthClientKey: data.oauthClientKey !== undefined ? (data.oauthClientKey || null) : (prev.oauthClientKey || null),
      oauthClientId: data.oauthClientId !== undefined ? (data.oauthClientId || null) : (prev.oauthClientId || null),
      addedAtMs: prev.addedAtMs || Date.now(),
      lastUsedAtMs: data.lastUsedAtMs ?? prev.lastUsedAtMs ?? null
    };
    store.accounts[email] = next;
    return next;
  }

  /**
   * 检测当前客户端实际登录账号，并与内部状态及活跃会话窗口对齐
   */
  async function detectCurrentActiveAccount() {
    if (isSwitchLockActive()) {
      const lockedStore = loadStore();
      const lockedEmail = lockedStore.activeAccountEmail || null;
      return {
        email: lockedEmail,
        accountScopeKey: lockedEmail ? buildAccountScopeKey(lockedEmail) : null,
        switchInProgress: true,
        skippedWrite: true,
        sources: { hostEmail: null, dbEmail: null, cliEmail: null }
      };
    }
    let hostEmail = '';
    if (typeof getHostUserStatusFn === 'function') {
      try {
        const status = await getHostUserStatusFn();
        hostEmail = normalizeEmail(status?.email || status?.userStatus?.email || '');
      } catch { }
    }
    const paths = credStore.getPaths();
    let dbEmail = '';
    if (paths.desktopDbPath && fs.existsSync(paths.desktopDbPath)) {
      const items = readStateDbItems(paths.desktopDbPath, ['antigravityUnifiedStateSync.userStatus', 'antigravityUnifiedStateSync.oauthToken']);
      const u = parseUnifiedUserStatusTopicBase64(items['antigravityUnifiedStateSync.userStatus']);
      if (u?.email) dbEmail = u.email;
      else {
        const tok = parseUnifiedOAuthTokenTopicBase64(items['antigravityUnifiedStateSync.oauthToken']);
        if (tok?.idToken) dbEmail = decodeJwtEmail(tok.idToken);
      }
    }
    let gaEmail = '';
    const ga = readJsonSafe(paths.googleAccountsPath, null);
    if (ga?.active) gaEmail = normalizeEmail(ga.active);

    const resolved = hostEmail || dbEmail || gaEmail || null;
    if (resolved) {
      const store = loadStore();
      let dirty = false;
      if (store.activeAccountEmail !== resolved) {
        store.activeAccountEmail = resolved;
        dirty = true;
      }
      if (hostEmail || dbEmail) {
        recordVerifiedAccountSession(store, {
          email: resolved,
          nowMs: Date.now(),
          source: 'desktop',
          evidence: hostEmail ? 'host_user_status' : 'desktop_state_db'
        });
        dirty = true;
      }
      if (dirty) saveStore(store);
    }
    return {
      email: resolved,
      accountScopeKey: resolved ? buildAccountScopeKey(resolved) : null,
      sources: { hostEmail: hostEmail || null, dbEmail: dbEmail || null, cliEmail: gaEmail || null }
    };
  }

  /**
   * 从当前已登录的 Antigravity 客户端抽取账号并保存到 ACM 多账号列表
   */
  async function importFromCurrentClient() {
    const paths = credStore.getPaths();
    const winCred = credStore.readWindowsSystemCredential();
    const macCred = credStore.readMacKeychainCredential();
    const osCred = winCred || macCred || null;
    const dbItems = fs.existsSync(paths.desktopDbPath)
      ? readStateDbItems(paths.desktopDbPath, ['antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus'])
      : {};
    const dbTok = parseUnifiedOAuthTokenTopicBase64(dbItems['antigravityUnifiedStateSync.oauthToken']);
    const dbUser = parseUnifiedUserStatusTopicBase64(dbItems['antigravityUnifiedStateSync.userStatus']);
    const cliCreds = readJsonSafe(paths.oauthCredsPath, null);
    const ga = readJsonSafe(paths.googleAccountsPath, null);

    let accessToken = osCred?.token?.access_token || dbTok?.accessToken || cliCreds?.access_token || '';
    const refreshToken = osCred?.token?.refresh_token || dbTok?.refreshToken || cliCreds?.refresh_token || '';
    const idToken = osCred?.id_token || dbTok?.idToken || cliCreds?.id_token || '';
    const expiresAt = osCred?.token?.expiry
      || (dbTok?.expirySeconds ? new Date(dbTok.expirySeconds * 1000).toISOString() : null)
      || (cliCreds?.expiry_date ? new Date(cliCreds.expiry_date).toISOString() : null);

    if (!refreshToken && !accessToken) {
      return { ok: false, error: '当前本机未检测到可用 Antigravity 登录凭据' };
    }

    let email = dbUser?.email || decodeJwtEmail(idToken) || normalizeEmail(ga?.active || '');
    let name = dbUser?.name || '';
    if (!email && typeof getHostUserStatusFn === 'function') {
      try {
        const hs = await getHostUserStatusFn();
        email = normalizeEmail(hs?.email || hs?.userStatus?.email || '');
      } catch { }
    }
    if (!email && accessToken) {
      try {
        const info = await fetchGoogleUserInfo(accessToken, customFetch);
        email = info.email;
        name = name || info.name;
      } catch { }
    }
    if (!email) {
      return { ok: false, error: '已找到本地 Token 但未能识别所属邮箱，请使用 Google OAuth 登录导入' };
    }

    const nowMs = Date.now();
    const store = loadStore();
    upsertAccountRecord(store, {
      email,
      name,
      source: 'client_import',
      oauthClientKey: 'antigravity_default',
      credential: { accessToken, refreshToken, expiresAt, idToken },
      authInvalid: false,
      authError: null,
      lastUsedAtMs: nowMs
    });
    store.activeAccountEmail = email;
    recordVerifiedAccountSession(store, {
      email,
      nowMs,
      source: 'desktop',
      evidence: 'client_import'
    });
    saveStore(store);
    return { ok: true, account: sanitizeAccountForView(store.accounts[email], store.activeAccountEmail) };
  }

  /**
   * 只读预览 ~/.antigravity_tools/accounts.json 中可用账号（绝不修改第三方文件）
   */
  function listAntigravityToolsAccounts() {
    const toolsIdxPath = path.join(homeDir, '.antigravity_tools', 'accounts.json');
    const data = readJsonSafe(toolsIdxPath, null);
    if (!data) return { ok: true, available: false, accounts: [] };
    const rawList = Array.isArray(data.accounts) ? data.accounts : [];
    const items = rawList
      .map(a => ({
        id: a.id || '',
        email: normalizeEmail(a.email || ''),
        name: a.name || '',
        disabled: Boolean(a.disabled),
        createdAt: a.created_at || null
      }))
      .filter(a => a.email);
    return { ok: true, available: true, count: items.length, accounts: items };
  }

  function importFromAntigravityTools(selectedEmails = null) {
    const toolsDir = path.join(homeDir, '.antigravity_tools');
    const idx = readJsonSafe(path.join(toolsDir, 'accounts.json'), null);
    if (!idx || !Array.isArray(idx.accounts)) {
      return { ok: false, error: '未发现 ~/.antigravity_tools/accounts.json' };
    }
    const filterSet = Array.isArray(selectedEmails) && selectedEmails.length
      ? new Set(selectedEmails.map(normalizeEmail).filter(Boolean))
      : null;

    const store = loadStore();
    const imported = [];
    for (const meta of idx.accounts) {
      const email = normalizeEmail(meta?.email || '');
      if (!email) continue;
      if (filterSet && !filterSet.has(email)) continue;
      const detail = readJsonSafe(path.join(toolsDir, 'accounts', `${meta.id}.json`), null);
      const tok = detail?.token || meta?.token || {};
      const refreshToken = tok.refresh_token || detail?.refresh_token || '';
      const accessToken = tok.access_token || detail?.access_token || '';
      const idToken = detail?.id_token || '';
      const expiresAt = tok.expiry || (tok.expiry_timestamp ? new Date(tok.expiry_timestamp * 1000).toISOString() : null);
      if (!refreshToken) continue;
      upsertAccountRecord(store, {
        email,
        name: meta.name || email.split('@')[0],
        source: 'antigravity_tools_import',
        oauthClientKey: tok.oauth_client_key || 'antigravity_enterprise',
        oauthClientId: tok.client_id || null,
        credential: { accessToken, refreshToken, expiresAt, idToken },
        authInvalid: false,
        authError: null
      });
      imported.push(email);
    }
    saveStore(store);
    return {
      ok: true,
      importedCount: imported.length,
      accounts: imported.map(e => sanitizeAccountForView(store.accounts[e], store.activeAccountEmail))
    };
  }

  /**
   * 启动 OAuth2 本地回环授权流程并添加账号（分阶段报错与脱敏记录；凭据持久化成功后不随初始配额失败回滚）
   */
  async function startOAuthLogin({ openExternal = options.openExternal || null, timeoutMs = 120000 } = {}) {
    const stateStr = crypto.randomBytes(16).toString('hex');
    let server = null;
    let boundPort = 0;
    let curStage = 'oauth_callback_bind';

    const logFailAndReturn = (stage, err, extraDiag = {}) => {
      const diag = err?.diagnostics || {};
      const entry = {
        action: 'oauth_login',
        stage: err?.stage || stage,
        targetHost: err?.targetHost || diag.targetHost || extraDiag.targetHost || null,
        proxySource: diag.proxySource || extraDiag.proxySource || 'direct',
        proxyProtocol: diag.proxyProtocol || extraDiag.proxyProtocol || 'direct',
        proxyEndpoint: diag.proxyEndpoint || extraDiag.proxyEndpoint || null,
        httpStatus: err?.httpStatus ?? diag.httpStatus ?? null,
        errorCode: diag.errorCode || err?.code || null,
        ok: false,
        message: sanitizeDiagnosticErrorText(err)
      };
      const st = loadStore();
      const recorded = recordDiag(st, entry);
      saveStore(st);
      return {
        ok: false,
        stage: recorded.stage,
        targetHost: recorded.targetHost,
        httpStatus: recorded.httpStatus,
        proxySource: recorded.proxySource,
        proxyEndpoint: recorded.proxyEndpoint,
        errorCode: recorded.errorCode,
        error: recorded.message,
        diagnostics: recorded
      };
    };

    let code = '';
    try {
      code = await new Promise((resolve, reject) => {
        let port = CALLBACK_PORT_START;
        let tries = 0;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { server?.close(); } catch { }
          reject(attachStageErrorMeta(new Error('OAuth 授权超时（请重新点击登录添加后在浏览器完成授权）'), curStage, '127.0.0.1', null, null));
        }, timeoutMs);

        const handleReq = (req, res) => {
          try {
            const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
            if (reqUrl.pathname === '/favicon.ico') {
              res.writeHead(204);
              res.end();
              return;
            }
            const errParam = reqUrl.searchParams.get('error');
            const codeParam = reqUrl.searchParams.get('code');
            const stParam = reqUrl.searchParams.get('state');
            if (errParam) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<html><body><h3>OAuth 授权失败</h3><p>您可以关闭此标签页。</p></body></html>');
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                try { server?.close(); } catch { }
                reject(attachStageErrorMeta(new Error(`OAuth 拒绝或失败: ${errParam}`), 'loopback_callback', '127.0.0.1', 400, null));
              }
              return;
            }
            if (codeParam && stParam === stateStr) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<html><body><h3>✅ 授权回调已接收，正在返回 Antigravity Context Meter…</h3><script>setTimeout(()=>window.close(),1500)</script></body></html>');
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                try { server?.close(); } catch { }
                resolve(codeParam);
              }
              return;
            }
            res.writeHead(400);
            res.end('Invalid callback');
          } catch (e) {
            res.writeHead(500);
            res.end('Error');
          }
        };

        const tryNextPort = () => {
          if (tries >= CALLBACK_PORT_RANGE) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(attachStageErrorMeta(new Error('无法绑定本地 OAuth 回调端口'), 'oauth_callback_bind', '127.0.0.1', null, null));
            }
            return;
          }
          const s = http.createServer(handleReq);
          s.on('error', err => {
            try { s.close(); } catch { }
            if (err.code === 'EADDRINUSE') {
              port++;
              tries++;
              tryNextPort();
            } else if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(attachStageErrorMeta(err, 'oauth_callback_bind', '127.0.0.1', null, null));
            }
          });
          s.listen(port, '127.0.0.1', () => {
            const oauthCfg = resolveAntigravityOAuthConfig(oauthResolveOpts);
            if (!oauthCfg?.clientId || !oauthCfg?.clientSecret) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                try { s.close(); } catch { }
                reject(attachStageErrorMeta(
                  new Error('未检测到可用 OAuth 客户端配置；可通过“导入当前”或“导入 Tools”添加账号，或设置 AG_OAUTH_CLIENT_ID / AG_OAUTH_CLIENT_SECRET。'),
                  'oauth_config',
                  null,
                  null,
                  null
                ));
              }
              return;
            }
            server = s;
            boundPort = port;
            curStage = 'loopback_callback';
            const redirectUri = `http://127.0.0.1:${boundPort}`;
            const params = new URLSearchParams({
              client_id: oauthCfg.clientId,
              redirect_uri: redirectUri,
              response_type: 'code',
              scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
              access_type: 'offline',
              prompt: 'consent',
              state: stateStr
            });
            const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;
            if (typeof openExternal === 'function') {
              Promise.resolve(openExternal(authUrl)).catch(() => { });
            } else {
              try {
                const { shell } = require('electron');
                shell?.openExternal?.(authUrl);
              } catch { }
            }
          });
        };
        tryNextPort();
      });
    } catch (e) {
      return logFailAndReturn(e?.stage || curStage, e, { targetHost: '127.0.0.1', proxySource: 'loopback_direct' });
    }

    const redirectUri = `http://127.0.0.1:${boundPort}`;
    const loginOAuthCfg = resolveAntigravityOAuthConfig(oauthResolveOpts);
    let tokData;
    try {
      curStage = 'token_exchange';
      tokData = await exchangeOAuthCode(code, redirectUri, customFetch, loginOAuthCfg);
    } catch (e) {
      return logFailAndReturn('token_exchange', e, { targetHost: 'oauth2.googleapis.com' });
    }

    let userInfo;
    try {
      curStage = 'userinfo_fetch';
      userInfo = await fetchGoogleUserInfo(tokData.access_token, customFetch);
    } catch (e) {
      return logFailAndReturn('userinfo_fetch', e, { targetHost: 'www.googleapis.com' });
    }

    // 阶段 5：凭据已成功换取并验证身份，原子落盘（不更改当前活跃账号，不触发切号）
    let rec;
    try {
      curStage = 'credential_persist';
      const store = loadStore();
      rec = upsertAccountRecord(store, {
        email: userInfo.email,
        name: userInfo.name,
        source: 'oauth_login',
        oauthClientKey: loginOAuthCfg?.key || 'antigravity_default',
        oauthClientId: loginOAuthCfg?.clientId || null,
        credential: {
          accessToken: tokData.access_token,
          refreshToken: tokData.refresh_token || '',
          expiresAt: new Date(Date.now() + (Number(tokData.expires_in) || 3600) * 1000).toISOString(),
          idToken: tokData.id_token || ''
        },
        authInvalid: false,
        authError: null
      });
      recordDiag(store, {
        action: 'oauth_login',
        stage: 'credential_persist',
        targetHost: 'local_store',
        proxySource: tokData?._diagnostics?.proxySource || 'plugin_config',
        proxyProtocol: tokData?._diagnostics?.proxyProtocol || 'direct',
        proxyEndpoint: tokData?._diagnostics?.proxyEndpoint || null,
        httpStatus: 200,
        ok: true,
        message: `凭据已保存 (${maskEmail(userInfo.email)})`
      });
      saveStore(store);
    } catch (e) {
      return logFailAndReturn('credential_persist', e, { targetHost: 'local_store' });
    }

    // 阶段 6：拉取新账号初始配额（即使额度查询失败也保留账号并返回部分成功与重试状态）
    const quotaRes = await refreshAccountQuota(userInfo.email, { stage: 'initial_quota_fetch' });
    const freshStore = loadStore();
    const viewAccount = sanitizeAccountForView(freshStore.accounts[userInfo.email] || rec, freshStore.activeAccountEmail);
    if (!quotaRes.ok) {
      return {
        ok: true,
        quotaOk: false,
        stage: quotaRes.stage || 'initial_quota_fetch',
        targetHost: quotaRes.targetHost || 'cloudcode-pa.googleapis.com',
        httpStatus: quotaRes.httpStatus ?? null,
        quotaError: quotaRes.error || '初始额度查询暂不可用',
        account: viewAccount
      };
    }
    return {
      ok: true,
      quotaOk: true,
      stage: 'completed',
      account: viewAccount
    };
  }

  /**
   * 直接用已获 Token（或测试桩）添加账号，用于测试与凭据直导
   */
  function addAccountWithCredential({ email, name, accessToken, refreshToken, expiresAt, idToken, source = 'manual' }) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return { ok: false, error: '邮箱格式无效' };
    const store = loadStore();
    const rec = upsertAccountRecord(store, {
      email: cleanEmail,
      name,
      source,
      credential: { accessToken, refreshToken, expiresAt, idToken },
      authInvalid: false,
      authError: null
    });
    saveStore(store);
    return { ok: true, account: sanitizeAccountForView(rec, store.activeAccountEmail) };
  }

  function removeAccount(email) {
    const clean = normalizeEmail(email);
    if (!clean) return { ok: false, error: '无效邮箱' };
    const store = loadStore();
    if (!store.accounts[clean]) return { ok: false, error: '账号不存在' };

    const removedScopeKey = store.accounts[clean].accountScopeKey || buildAccountScopeKey(clean);
    const wasActive = store.activeAccountEmail === clean;

    delete store.accounts[clean];
    store.autoSwitch.candidates = (store.autoSwitch.candidates || []).filter(e => normalizeEmail(e) !== clean);

    // 清理该账号相关的防抖计数；若移除了活跃账号则整组重置防抖，避免基于失效账号触发误切换
    for (const k of Array.from(debounceState.keys())) {
      if (k === clean || k.startsWith(`${clean}:`)) debounceState.delete(k);
    }

    if (wasActive) {
      store.activeAccountEmail = null;
      debounceState.clear();
      if (store.autoSwitchStatus && store.autoSwitchStatus.state === 'pending_idle') {
        store.autoSwitchStatus.state = store.autoSwitch.enabled ? 'watching' : 'disabled';
        store.autoSwitchStatus.blockedReason = null;
      }
    }

    // 同步停止并解绑指向被移除账号或活跃已移除账号的保活配置，避免残留失效状态
    if (store.keepalive) {
      const targetEmail = normalizeEmail(store.keepalive.targetAccountEmail);
      if (targetEmail === clean || (wasActive && !targetEmail)) {
        store.keepalive.enabled = false;
        store.keepalive.targetAccountEmail = null;
        store.keepaliveState = {
          ...(store.keepaliveState || {}),
          running: false,
          stopReason: 'account_removed'
        };
        try { if (fs.existsSync(keepaliveLockPath)) fs.unlinkSync(keepaliveLockPath); } catch { }
      }
    }

    // 移除最后一个账号时收拢自动切号运行状态，不擅自修改或残留等待态
    const remainingCount = Object.keys(store.accounts).length;
    if (remainingCount === 0) {
      store.activeAccountEmail = null;
      store.autoSwitch.enabled = false;
      store.autoSwitchStatus = {
        ...(store.autoSwitchStatus || {}),
        state: 'disabled',
        blockedReason: null
      };
      debounceState.clear();
    }

    // 注意：有意保留 store.accountSessions 与本地 pricing_ledger_v1.json 历史归属记录，不做擦除或迁移
    saveStore(store);
    return { ok: true, removedEmail: clean, removedScopeKey, wasActive, remainingCount };
  }

  /**
   * 刷新指定账号的 AccessToken（过期前 5 分钟自动刷新）并获取其云端配额快照 + 记录 ELV-57 配额对照区间
   */
  async function ensureFreshTokenForAccount(email) {
    const clean = normalizeEmail(email);
    const store = loadStore();
    const rec = store.accounts[clean];
    if (!rec) throw new Error(`账号不存在: ${clean}`);
    const expiresAtMs = rec.credential?.expiresAt ? Date.parse(rec.credential.expiresAt) : 0;
    const isNearExpiry = !rec.credential?.accessToken || !Number.isFinite(expiresAtMs) || (expiresAtMs - Date.now() < 5 * 60 * 1000);
    if (!isNearExpiry) return rec.credential;
    if (!rec.credential?.refreshToken) {
      throw Object.assign(new Error('缺少 refresh_token，需要重新授权'), { isAuthInvalid: true });
    }
    const candidates = resolveAllAntigravityOAuthConfigs({
      ...oauthResolveOpts,
      oauthClientKey: rec.oauthClientKey || (rec.source === 'antigravity_tools_import' ? 'antigravity_enterprise' : ''),
      preferredClientId: rec.oauthClientId || ''
    });
    const configsToTry = candidates.length ? candidates : [null];
    let lastErr = null;
    for (let i = 0; i < configsToTry.length; i++) {
      const cfg = configsToTry[i];
      try {
        const refreshed = await refreshOAuthAccessToken(rec.credential.refreshToken, customFetch, cfg);
        const nextStore = loadStore();
        if (nextStore.accounts[clean]) {
          nextStore.accounts[clean].credential = { ...nextStore.accounts[clean].credential, ...refreshed };
          if (refreshed.oauthClientId) nextStore.accounts[clean].oauthClientId = refreshed.oauthClientId;
          if (refreshed.oauthClientKey) nextStore.accounts[clean].oauthClientKey = refreshed.oauthClientKey;
          nextStore.accounts[clean].authInvalid = false;
          nextStore.accounts[clean].authError = null;
          saveStore(nextStore);
        }
        return refreshed;
      } catch (e) {
        lastErr = e;
        const canRetryNextOfficialPair = (i + 1 < configsToTry.length) && (e.isClientMismatch || e.isAuthInvalid);
        if (canRetryNextOfficialPair) continue;
        break;
      }
    }
    if (lastErr?.isAuthInvalid) {
      const nextStore = loadStore();
      if (nextStore.accounts[clean]) {
        nextStore.accounts[clean].authInvalid = true;
        nextStore.accounts[clean].authError = lastErr.message;
        saveStore(nextStore);
      }
    }
    throw lastErr;
  }

  /**
   * ELV-57 核心纯逻辑：根据新旧配额快照与归属本机账本记录，构建/切分/合并对照区间。
   * - 同账号同池且连续无断点（无切号、无重置/恢复、采样间隔 <= gapSplitMs）时就地合并延续，避免产生海量 0pp 碎片；
   * - 切号、重置/滚动恢复、断网/过期缺口 (>30m 或错误态) 必须结束或切分，不拼成一段；
   * - 绝不把百分点变化直接认定为“本机消耗了该账号的 X%”。
   */
  function queryIntervalLocalUsage(scopeKey, poolKey, startMs, endMs, options = {}) {
    let localStats = {
      requestCount: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      keepaliveRequests: 0,
      keepaliveTokens: 0
    };
    if (typeof options.queryLocalUsageInWindow === 'function') {
      localStats = { ...localStats, ...(options.queryLocalUsageInWindow({ accountScopeKey: scopeKey, poolKey, startMs, endMs }) || {}) };
    } else if (collector && typeof collector.summarizeAccountWindowUsage === 'function') {
      localStats = { ...localStats, ...(collector.summarizeAccountWindowUsage({ accountScopeKey: scopeKey, poolKey, startMs, endMs }) || {}) };
    }
    return localStats;
  }

  function recordQuotaComparisonSample(store, email, prevSnapshot, prevAtMs, nextSnapshot, nextAtMs, options = {}) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail || !nextSnapshot || !Array.isArray(nextSnapshot.pools)) return;
    const scopeKey = buildAccountScopeKey(cleanEmail);
    const nowMs = Number.isFinite(Number(nextAtMs)) ? Number(nextAtMs) : Date.now();
    const gapSplitMs = Number(options.gapSplitMs) || 30 * 60 * 1000;

    if (!Array.isArray(store.quotaIntervals)) store.quotaIntervals = [];

    for (const pool of nextSnapshot.pools) {
      if (!pool || pool.noPermission || pool.remainingFraction == null) continue;
      const pb = pool.primaryBucket || selectPrimaryQuotaBucket(pool.buckets || []).primaryBucket;
      const winKey = pb?.windowKey || 'primary';
      const winShort = pb?.windowShort || '';
      const endPct = Number((pool.remainingFraction * 100).toFixed(2));

      // 查找同账号同池的上一条活跃基准
      const prevPool = prevSnapshot?.pools?.find(p => p.poolKey === pool.poolKey) || null;
      if (!prevPool || prevPool.remainingFraction == null || prevAtMs == null || prevAtMs >= nowMs) {
        continue;
      }

      const startPct = Number((prevPool.remainingFraction * 100).toFixed(2));
      const timeGapMs = nowMs - prevAtMs;
      const isSwitchedDuringWindow = Boolean(options.accountSwitched);
      const isResetOrRecovery = endPct > startPct + 1.0 || Boolean(pb?.resetTimeIso && prevPool.resetTimeIso && pb.resetTimeIso !== prevPool.resetTimeIso);
      const hasGap = timeGapMs > gapSplitMs || Boolean(options.hadStaleOrOfflineGap);

      let splitReason = null;
      if (isSwitchedDuringWindow) splitReason = 'account_switched';
      else if (isResetOrRecovery) splitReason = endPct >= 99 ? 'quota_reset' : 'rolling_recovery';
      else if (hasGap) splitReason = 'sampling_gap';

      // 若本次连续无断点，优先查找可合并的最近一条同账号同池活跃连续区间（防止 30s 轮询制造数百条无意义碎片）
      if (!splitReason && !hasGap) {
        let mergeIdx = -1;
        for (let i = store.quotaIntervals.length - 1; i >= 0; i--) {
          const cand = store.quotaIntervals[i];
          if (!cand || cand.poolKey !== pool.poolKey) continue;
          // 遇到其他账号在更晚结束的同池区间，则不再跨账号向前回溯合并
          if (cand.accountScopeKey !== scopeKey) break;
          if (!cand.splitReason && !cand.hasSamplingGap && cand.isReliableContinuous !== false
            && Number.isFinite(cand.endAtMs) && cand.endAtMs <= nowMs
            && (nowMs - cand.endAtMs) <= gapSplitMs
            && (cand.endAtMs === prevAtMs || Math.abs(cand.endAtMs - prevAtMs) <= gapSplitMs)) {
            mergeIdx = i;
          }
          break;
        }
        if (mergeIdx >= 0) {
          const baseIv = store.quotaIntervals[mergeIdx];
          const mergedStartMs = baseIv.startAtMs;
          const mergedStats = queryIntervalLocalUsage(scopeKey, pool.poolKey, mergedStartMs, nowMs, options);
          store.quotaIntervals[mergeIdx] = {
            ...baseIv,
            endAtMs: nowMs,
            endRemainingPct: endPct,
            deltaPp: Number((endPct - baseIv.startRemainingPct).toFixed(2)),
            requestCount: mergedStats.requestCount || 0,
            uncachedInputTokens: mergedStats.uncachedInputTokens || 0,
            cacheReadTokens: mergedStats.cacheReadTokens || 0,
            outputTokens: mergedStats.outputTokens || 0,
            totalTokens: mergedStats.totalTokens || 0,
            keepaliveRequests: mergedStats.keepaliveRequests || 0,
            keepaliveTokens: mergedStats.keepaliveTokens || 0,
            updatedAtMs: nowMs
          };
          continue;
        }
      }

      // 查询本机在同一账号、同一模型池、同一时间段的实测流量
      const localStats = queryIntervalLocalUsage(scopeKey, pool.poolKey, prevAtMs, nowMs, options);

      const deltaPp = Number((endPct - startPct).toFixed(2));
      const interval = {
        id: `qi_${scopeKey}_${pool.poolKey}_${nowMs}`,
        email: cleanEmail,
        accountScopeKey: scopeKey,
        poolKey: pool.poolKey,
        poolTitle: pool.title || pool.poolKey,
        windowKey: winKey,
        windowShort: winShort,
        startAtMs: prevAtMs,
        endAtMs: nowMs,
        startRemainingPct: startPct,
        endRemainingPct: endPct,
        deltaPp, // 正值表示回升/重置，负值表示下降（如 -8.0）
        requestCount: localStats.requestCount || 0,
        uncachedInputTokens: localStats.uncachedInputTokens || 0,
        cacheReadTokens: localStats.cacheReadTokens || 0,
        outputTokens: localStats.outputTokens || 0,
        totalTokens: localStats.totalTokens || 0,
        keepaliveRequests: localStats.keepaliveRequests || 0,
        keepaliveTokens: localStats.keepaliveTokens || 0,
        hasSamplingGap: hasGap,
        splitReason,
        isReliableContinuous: !splitReason && !hasGap,
        updatedAtMs: nowMs,
        disclaimer: '同一账号其余设备并发使用、平台按比例取整、滚动恢复及采样延迟均会导致账面百分比变化与本机 Token 消耗不成严格线性关系。'
      };
      store.quotaIntervals.push(interval);
    }

    // 保留最近 200 条对照区间，防无限膨胀
    if (store.quotaIntervals.length > 200) {
      store.quotaIntervals = store.quotaIntervals.slice(-200);
    }
  }

  /**
   * 从历史记录中归并连续 30s 无断点碎片，并按最新归属账本重算每个对照区间的本机调用统计
   */
  function rebuildQuotaIntervalsFromHistory(options = {}) {
    const gapSplitMs = Number(options.gapSplitMs) || 30 * 60 * 1000;
    const store = loadStore();
    const rawList = Array.isArray(store.quotaIntervals) ? store.quotaIntervals.slice() : [];
    const sorted = rawList
      .filter(iv => iv && iv.accountScopeKey && iv.poolKey && Number.isFinite(iv.startAtMs) && Number.isFinite(iv.endAtMs))
      .sort((a, b) => (a.startAtMs - b.startAtMs) || (a.endAtMs - b.endAtMs));

    const merged = [];
    for (const cur of sorted) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      const canMerge = prev
        && prev.accountScopeKey === cur.accountScopeKey
        && prev.poolKey === cur.poolKey
        && !prev.splitReason && !prev.hasSamplingGap && prev.isReliableContinuous !== false
        && !cur.splitReason && !cur.hasSamplingGap && cur.isReliableContinuous !== false
        && cur.startAtMs >= prev.startAtMs
        && (cur.startAtMs - prev.endAtMs) <= gapSplitMs
        && cur.endRemainingPct <= (cur.startRemainingPct + 1.0);

      if (canMerge) {
        prev.endAtMs = Math.max(prev.endAtMs, cur.endAtMs);
        prev.endRemainingPct = cur.endRemainingPct;
        prev.deltaPp = Number((prev.endRemainingPct - prev.startRemainingPct).toFixed(2));
        prev.updatedAtMs = Math.max(prev.updatedAtMs || 0, cur.updatedAtMs || cur.endAtMs);
      } else {
        merged.push({ ...cur });
      }
    }

    for (const iv of merged) {
      const localStats = queryIntervalLocalUsage(iv.accountScopeKey, iv.poolKey, iv.startAtMs, iv.endAtMs, options);
      iv.requestCount = localStats.requestCount || 0;
      iv.uncachedInputTokens = localStats.uncachedInputTokens || 0;
      iv.cacheReadTokens = localStats.cacheReadTokens || 0;
      iv.outputTokens = localStats.outputTokens || 0;
      iv.totalTokens = localStats.totalTokens || 0;
      iv.keepaliveRequests = localStats.keepaliveRequests || 0;
      iv.keepaliveTokens = localStats.keepaliveTokens || 0;
    }

    store.quotaIntervals = merged.slice(-200);
    saveStore(store);
    return { ok: true, beforeCount: rawList.length, afterCount: store.quotaIntervals.length, intervals: store.quotaIntervals };
  }

  async function refreshAccountQuota(email, opts = {}) {
    const clean = normalizeEmail(email);
    const store = loadStore();
    const rec = store.accounts[clean];
    if (!rec) return { ok: false, error: '账号不存在' };

    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    try {
      let quotaData = null;
      if (opts.mockQuotaSnapshot) {
        quotaData = {
          projectId: rec.projectId,
          tierId: rec.tierId,
          snapshot: opts.mockQuotaSnapshot,
          fetchedAtMs: nowMs
        };
      } else {
        const freshCred = await ensureFreshTokenForAccount(clean);
        quotaData = await fetchAccountQuotaViaCloudCode(freshCred.accessToken, {
          email: clean,
          projectId: rec.projectId,
          fetch: customFetch,
          nowMs
        });
      }

      const freshStore = loadStore();
      const targetRec = freshStore.accounts[clean];
      if (!targetRec) return { ok: false, error: '账号已被移除' };

      const prevSnap = targetRec.quotaSnapshot || null;
      const prevAtMs = targetRec.lastQuotaUpdatedAtMs || null;

      recordQuotaComparisonSample(
        freshStore,
        clean,
        prevSnap,
        prevAtMs,
        quotaData.snapshot,
        quotaData.fetchedAtMs || nowMs,
        {
          accountSwitched: Boolean(opts.accountSwitched),
          hadStaleOrOfflineGap: Boolean(opts.hadStaleOrOfflineGap),
          queryLocalUsageInWindow: opts.queryLocalUsageInWindow
        }
      );

      targetRec.projectId = quotaData.projectId ?? targetRec.projectId;
      targetRec.tierId = quotaData.tierId ?? targetRec.tierId;
      targetRec.tierName = quotaData.tierName || quotaData.snapshot?.planStatus?.tierName || targetRec.tierName || null;
      targetRec.quotaSnapshot = quotaData.snapshot;
      targetRec.lastQuotaUpdatedAtMs = quotaData.fetchedAtMs || nowMs;
      targetRec.lastQuotaError = null;
      targetRec.lastQuotaErrorMeta = null;
      targetRec.authInvalid = false;
      targetRec.authError = null;
      saveStore(freshStore);
      return { ok: true, account: sanitizeAccountForView(targetRec, freshStore.activeAccountEmail) };
    } catch (e) {
      const freshStore = loadStore();
      const diagEntry = recordDiag(freshStore, {
        at: new Date().toISOString(),
        flow: 'refresh_quota',
        stage: e.stage || 'quota_fetch',
        targetHost: e.targetHost || 'cloudcode-pa.googleapis.com',
        httpStatus: Number.isFinite(Number(e.httpStatus)) ? Number(e.httpStatus) : null,
        proxySource: e.proxySource || null,
        proxyEndpoint: e.proxyEndpoint || null,
        errorCode: e.errorCode || e.code || null,
        error: e.message || String(e),
        emailMasked: maskEmail(clean)
      });
      if (freshStore.accounts[clean]) {
        freshStore.accounts[clean].lastQuotaError = e.message;
        freshStore.accounts[clean].lastQuotaErrorMeta = diagEntry;
        if (e.isAuthInvalid) {
          freshStore.accounts[clean].authInvalid = true;
          freshStore.accounts[clean].authError = e.message;
        }
        saveStore(freshStore);
      } else {
        saveStore(freshStore);
      }
      return {
        ok: false,
        error: e.message,
        stage: diagEntry.stage,
        targetHost: diagEntry.targetHost,
        httpStatus: diagEntry.httpStatus,
        diagnostics: diagEntry,
        authInvalid: Boolean(e.isAuthInvalid),
        isClientMismatch: Boolean(e.isClientMismatch)
      };
    }
  }

  /**
   * 同步主面板通过本地 Language Server 拉取到的当前登录账号额度快照（避免重复轮询！共用同一条刷新链路）
   */
  function syncActiveHostQuotaSnapshot(hostQuotaResult, hostEmail, opts = {}) {
    if (isSwitchLockActive()) return null;
    const clean = normalizeEmail(hostEmail);
    if (!clean || !hostQuotaResult?.snapshot) return null;
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : (hostQuotaResult.fetchedAtMs || Date.now());
    const store = loadStore();
    const prevActive = store.activeAccountEmail;
    const accountSwitched = Boolean(prevActive && prevActive !== clean);
    let rec = store.accounts[clean];
    if (!rec) {
      rec = upsertAccountRecord(store, {
        email: clean,
        source: 'client_auto_detected',
        credential: {}
      });
    }
    const prevSnap = rec.quotaSnapshot || null;
    const prevAtMs = rec.lastQuotaUpdatedAtMs || null;
    recordQuotaComparisonSample(store, clean, prevSnap, prevAtMs, hostQuotaResult.snapshot, nowMs, {
      accountSwitched,
      hadStaleOrOfflineGap: Boolean(hostQuotaResult.error),
      queryLocalUsageInWindow: opts.queryLocalUsageInWindow
    });
    rec.quotaSnapshot = hostQuotaResult.snapshot;
    rec.lastQuotaUpdatedAtMs = nowMs;
    rec.lastQuotaError = hostQuotaResult.error || null;
    if (!hostQuotaResult.error) rec.lastQuotaErrorMeta = null;
    if (hostQuotaResult.planStatus?.tierName) rec.tierId = hostQuotaResult.planStatus.tierName;
    rec.lastUsedAtMs = nowMs;
    if (accountSwitched) {
      closeActiveAccountSessions(store, nowMs);
    }
    recordVerifiedAccountSession(store, {
      email: clean,
      nowMs,
      source: 'desktop',
      evidence: 'host_quota_sync',
      forceNew: accountSwitched
    });
    store.activeAccountEmail = clean;
    saveStore(store);
    return sanitizeAccountForView(rec, store.activeAccountEmail);
  }

  // =========================================================================
  // ELV-52 Prompt Cache 保活控制器（默认禁用 + 严格边界 + 未经维护者确认严禁发模型请求）
  // =========================================================================

  function stopKeepalive(reason = 'manual_stop') {
    const store = loadStore();
    const wasRunning = Boolean(store.keepaliveState?.running);
    store.keepalive.enabled = false;
    store.keepaliveState = {
      ...store.keepaliveState,
      running: false,
      stopReason: reason,
      stoppedAtMs: Date.now()
    };
    saveStore(store);
    try { if (fs.existsSync(keepaliveLockPath)) fs.unlinkSync(keepaliveLockPath); } catch { }
    return { ok: true, wasRunning, reason, keepaliveState: store.keepaliveState };
  }

  function updateKeepaliveConfig(patch = {}) {
    const store = loadStore();
    const next = {
      ...store.keepalive,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : store.keepalive.enabled,
      experimentApproved: patch.experimentApproved !== undefined ? Boolean(patch.experimentApproved) : store.keepalive.experimentApproved,
      targetAccountEmail: patch.targetAccountEmail !== undefined ? (normalizeEmail(patch.targetAccountEmail) || null) : store.keepalive.targetAccountEmail,
      targetSessionId: patch.targetSessionId !== undefined ? (patch.targetSessionId ? String(patch.targetSessionId).trim() : null) : store.keepalive.targetSessionId,
      targetModelId: patch.targetModelId !== undefined ? (patch.targetModelId ? String(patch.targetModelId).trim() : null) : store.keepalive.targetModelId,
      intervalSec: patch.intervalSec !== undefined ? Math.max(60, Math.min(1800, Number(patch.intervalSec) || 240)) : store.keepalive.intervalSec,
      maxDurationMin: patch.maxDurationMin !== undefined ? Math.max(1, Math.min(240, Number(patch.maxDurationMin) || 30)) : store.keepalive.maxDurationMin,
      maxRequests: patch.maxRequests !== undefined ? Math.max(1, Math.min(20, Number(patch.maxRequests) || 6)) : store.keepalive.maxRequests
    };
    store.keepalive = next;
    if (!next.enabled) {
      store.keepaliveState = { ...store.keepaliveState, running: false, stopReason: 'disabled_by_user' };
    }
    saveStore(store);
    return { ok: true, keepalive: next, keepaliveState: store.keepaliveState };
  }

  async function evaluateKeepaliveTick(ctx = {}) {
    const nowMs = Number.isFinite(Number(ctx.nowMs)) ? Number(ctx.nowMs) : Date.now();
    const store = loadStore();
    const cfg = store.keepalive || DEFAULT_KEEPALIVE_CONFIG;
    const st = store.keepaliveState || {};

    if (!cfg.enabled) {
      return { ok: false, action: 'noop', reason: 'disabled' };
    }
    if (!cfg.experimentApproved) {
      store.keepaliveState = { ...st, running: false, blockedReason: 'pending_maintainer_experiment_approval' };
      saveStore(store);
      return {
        ok: false,
        action: 'blocked',
        reason: 'pending_maintainer_experiment_approval',
        message: 'ELV-52 实机保活对照实验尚未获得维护者确认，已拦截真实模型请求。'
      };
    }
    if (!cfg.targetAccountEmail || !cfg.targetSessionId || !cfg.targetModelId) {
      return { ok: false, action: 'blocked', reason: 'missing_scope_binding', message: '必须明确绑定单一目标账号、隔离会话 ID 与单一模型 ID。' };
    }
    // 禁止往用户正在活跃生成的会话中注入请求
    if (ctx.activeUserSessionId && ctx.activeUserSessionId === cfg.targetSessionId && ctx.isGenerating) {
      return { ok: false, action: 'deferred', reason: 'active_user_session_busy' };
    }
    if (ctx.isGenerating) {
      return { ok: false, action: 'deferred', reason: 'generation_in_progress' };
    }
    // 账号切换后若新账号尚未确认生效或当前账号与绑定目标账号不一致，必须停止/不继续
    const activeEmail = normalizeEmail(ctx.confirmedActiveEmail || store.activeAccountEmail || '');
    if (!activeEmail || activeEmail !== cfg.targetAccountEmail) {
      stopKeepalive('account_mismatch_or_unconfirmed');
      return { ok: false, action: 'stopped', reason: 'account_mismatch_or_unconfirmed' };
    }
    // 退避检查
    if (st.backoffUntilMs && nowMs < st.backoffUntilMs) {
      return { ok: false, action: 'backoff', reason: 'rate_limit_or_error_backoff', retryAtMs: st.backoffUntilMs };
    }
    // 次数与时长上限检查
    if ((st.requestsSent || 0) >= cfg.maxRequests) {
      stopKeepalive('max_requests_reached');
      return { ok: false, action: 'stopped', reason: 'max_requests_reached' };
    }
    if (st.startedAtMs && (nowMs - st.startedAtMs) >= cfg.maxDurationMin * 60 * 1000) {
      stopKeepalive('max_duration_reached');
      return { ok: false, action: 'stopped', reason: 'max_duration_reached' };
    }
    // 防止因保活消耗反复把账号打到自动切号阈值下：若当前目标账号剩余配额已处于阈值保护带内，自动停止保活
    if (store.autoSwitch?.enabled && store.accounts[activeEmail]?.quotaSnapshot) {
      const pool = (store.accounts[activeEmail].quotaSnapshot.pools || []).find(p => p.poolKey === store.autoSwitch.poolKey);
      if (pool && pool.remainingFraction != null && (pool.remainingFraction * 100) <= (store.autoSwitch.thresholdPct + 2)) {
        stopKeepalive('auto_switch_threshold_guard');
        return { ok: false, action: 'stopped', reason: 'auto_switch_threshold_guard' };
      }
    }

    // 多窗口去重锁
    const lock = acquireSimpleLock(keepaliveLockPath, Math.max(30000, cfg.intervalSec * 500));
    if (!lock.ok) {
      return { ok: false, action: 'skipped', reason: 'multi_window_lock_held' };
    }
    try {
      if (typeof ctx.sendIsolatedPing !== 'function') {
        return { ok: false, action: 'blocked', reason: 'no_transport_handler' };
      }
      const res = await ctx.sendIsolatedPing({
        accountEmail: activeEmail,
        accountScopeKey: buildAccountScopeKey(activeEmail),
        sessionId: cfg.targetSessionId,
        modelId: cfg.targetModelId,
        allowTools: false,
        isKeepalive: true
      });
      const nextStore = loadStore();
      if (!res || res.ok === false) {
        const is429 = Number(res?.status) === 429 || /rate_limit|429/i.test(String(res?.error || ''));
        if (is429) {
          nextStore.keepaliveState = {
            ...nextStore.keepaliveState,
            running: true,
            backoffUntilMs: nowMs + 5 * 60 * 1000,
            lastError: res?.error || 'HTTP 429 限流退避'
          };
          saveStore(nextStore);
          return { ok: false, action: 'backoff', reason: 'rate_limited_429' };
        }
        stopKeepalive('ping_failed');
        return { ok: false, action: 'stopped', reason: 'ping_failed', error: res?.error || '保活请求失败' };
      }
      nextStore.keepaliveState = {
        ...nextStore.keepaliveState,
        running: true,
        startedAtMs: nextStore.keepaliveState.startedAtMs || nowMs,
        requestsSent: (nextStore.keepaliveState.requestsSent || 0) + 1,
        lastPingAtMs: nowMs,
        lastError: null,
        blockedReason: null
      };
      saveStore(nextStore);
      return { ok: true, action: 'ping_sent', requestsSent: nextStore.keepaliveState.requestsSent, isKeepalive: true };
    } finally {
      lock.release();
    }
  }

  // =========================================================================
  // 真实客户端切号执行引擎 + 生效校验 + 失败回滚
  // =========================================================================

  async function switchActiveAccount(targetEmail, opts = {}) {
    const cleanTarget = normalizeEmail(targetEmail);
    if (!cleanTarget) return { ok: false, error: '目标账号邮箱无效' };
    if (inFlightSwitch) return { ok: false, error: '已有切号任务正在执行，请勿并发触发', busy: true };

    const execSwitch = async () => {
      const store = loadStore();
      const targetRec = store.accounts[cleanTarget];
      if (!targetRec) return { ok: false, error: `未在多账号列表中找到 ${cleanTarget}` };
      if (!targetRec.credential?.refreshToken) {
        return { ok: false, error: `${cleanTarget} 缺少 refresh_token，无法切换客户端登录态` };
      }
      if (targetRec.authInvalid) {
        return { ok: false, error: `${cleanTarget} 授权已失效 (${targetRec.authError || 'invalid_grant'})，请重新授权后再切号`, authInvalid: true };
      }

      // 正在生成保护：若检测到正在生成且未传 forceWhileBusy，等待安全时机或拒绝静默中断
      if (typeof checkHostBusyFn === 'function' && !opts.forceWhileBusy) {
        try {
          const busyInfo = await checkHostBusyFn();
          if (busyInfo?.isGenerating) {
            return {
              ok: false,
              deferred: true,
              reason: 'generation_in_progress',
              error: '检测到当前会话仍在生成中，为避免静默中断已延后切换（请等待本轮生成完成或手动强制切换）。'
            };
          }
        } catch { }
      }

      const lock = acquireSimpleLock(switchLockPath, 25000);
      if (!lock.ok) {
        return { ok: false, error: '另一 Antigravity 窗口正在执行切号，本窗口已跳过以防并发冲突', locked: true };
      }

      let preSnap = null;
      const preStore = loadStore();
      const preActiveEmail = preStore.activeAccountEmail || null;
      const switchStartMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
      const preOpenSessions = (preStore.accountSessions || [])
        .filter(s => s && s.endAtMs == null && normalizeEmail(s.email) === normalizeEmail(preActiveEmail))
        .map(s => ({ startAtMs: s.startAtMs, source: s.source || 'desktop' }));

      // 统一回滚记账与 UI 持久反馈：还原切号前活跃账号、清理中途意外生成的目标临时会话、写入失败与回滚结果
      const finalizeFailureStore = ({ errMsg, rolledBack, verifiedEmail, atMs }) => {
        const failStore = loadStore();
        const fallbackActive = (verifiedEmail && verifiedEmail !== cleanTarget && failStore.accounts[verifiedEmail])
          ? verifiedEmail
          : preActiveEmail;
        failStore.activeAccountEmail = fallbackActive || null;
        if (Array.isArray(failStore.accountSessions)) {
          const nextSessions = [];
          for (const s of failStore.accountSessions) {
            if (!s) continue;
            const sEmail = normalizeEmail(s.email);
            const isProvisionalTarget = sEmail === cleanTarget
              && Number(s.startAtMs || 0) >= (switchStartMs - 1000)
              && s.evidence !== 'account_switch_verified';
            if (isProvisionalTarget) continue;
            if (rolledBack && preActiveEmail && sEmail === normalizeEmail(preActiveEmail)
              && preOpenSessions.some(po => po.startAtMs === s.startAtMs && po.source === (s.source || 'desktop'))) {
              s.endAtMs = null;
              s.lastVerifiedAtMs = Math.max(Number(s.lastVerifiedAtMs || 0), atMs);
            }
            nextSessions.push(s);
          }
          failStore.accountSessions = nextSessions;
        }
        failStore.autoSwitchStatus = {
          ...failStore.autoSwitchStatus,
          lastResult: {
            ok: false,
            fromEmail: preActiveEmail,
            toEmail: cleanTarget,
            atMs,
            trigger: opts.trigger || 'manual',
            rolledBack: Boolean(rolledBack),
            error: errMsg
          },
          lastError: errMsg
        };
        saveStore(failStore);
        return failStore;
      };

      try {
        // 1. 协调停止旧账号保活，切号期间新账号尚未确认生效前不允许继续保活
        stopKeepalive('pre_account_switch');

        // 2. 先校验/刷新目标账号 Token（防止写入过期 Token 后客户端报错）
        let freshCred = null;
        if (opts.skipTokenRefresh && targetRec.credential?.accessToken) {
          freshCred = targetRec.credential;
        } else {
          freshCred = await ensureFreshTokenForAccount(cleanTarget);
        }

        // 3. 保存切换前系统凭据快照用于失败回滚（仅在确认切换生效后才切割账本活跃时段）
        preSnap = credStore.captureSnapshot();

        // 4. 原子同步写入 OS 共享凭据、Desktop/IDE state.vscdb 及 CLI ~/.gemini
        const writeRes = credStore.applyCredential({
          email: cleanTarget,
          name: targetRec.name,
          accessToken: freshCred.accessToken,
          refreshToken: freshCred.refreshToken,
          expiresAt: freshCred.expiresAt,
          idToken: freshCred.idToken
        });
        if (!writeRes.ok) {
          const rb = credStore.restoreSnapshot(preSnap);
          const rolledBack = Boolean(rb?.ok !== false);
          const errMsg = `写入客户端凭据失败（阶段: ${writeRes.stage}）：${writeRes.error || '未知错误'}，已自动回滚至切换前状态`;
          finalizeFailureStore({ errMsg, rolledBack, verifiedEmail: '', atMs: Date.now() });
          return {
            ok: false,
            error: errMsg,
            rolledBack
          };
        }

        // 5. 重启语言服务使其加载新凭据（不暴力 kill 主 Electron UI 进程，如实告知重启 LS 行为）
        let lsRestarted = false;
        if (opts.restartLanguageServer !== false) {
          const lsRes = await Promise.resolve(restartLanguageServersFn({ includeCli: false }));
          lsRestarted = Boolean(lsRes && lsRes.ok !== false);
        }

        // 6. 切换完成后必须通过 GetUserStatus 验证真实生效邮箱，未验证前不将后续流量记入目标账号！
        // 超时默认值 DEFAULT_SWITCH_VERIFY_TIMEOUT_MS (20000ms) 依据：
        // 宿主 Auto-Restart 冷却 2000ms + Go 语言服务拉起与本地 TLS/状态初始化 2000~5000ms + 窗口 reload / daemon hub_*.json 落盘与轮询余量。
        let verifiedEmail = '';
        let verifiedEffective = false;
        if (typeof getHostUserStatusFn === 'function') {
          if (lsRestarted) {
            await new Promise(r => setTimeout(r, 350));
          }
          const verifyTimeout = Number(opts.verifyTimeoutMs) || DEFAULT_SWITCH_VERIFY_TIMEOUT_MS;
          const deadline = Date.now() + verifyTimeout;
          while (Date.now() <= deadline) {
            try {
              const hs = await getHostUserStatusFn({ force: true });
              verifiedEmail = normalizeEmail(hs?.email || hs?.userStatus?.email || '');
              if (verifiedEmail === cleanTarget) {
                verifiedEffective = true;
                break;
              }
            } catch { }
            if (Date.now() + 500 > deadline) break;
            await new Promise(r => setTimeout(r, 450));
          }
        } else if (opts.assumeVerifiedInDryRun) {
          verifiedEmail = cleanTarget;
          verifiedEffective = true;
        }

        const nextStore = loadStore();
        const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
        if (verifiedEffective) {
          closeActiveAccountSessions(nextStore, nowMs);
          nextStore.activeAccountEmail = cleanTarget;
          if (nextStore.accounts[cleanTarget]) nextStore.accounts[cleanTarget].lastUsedAtMs = nowMs;
          recordVerifiedAccountSession(nextStore, {
            email: cleanTarget,
            nowMs,
            source: 'desktop',
            evidence: 'account_switch_verified',
            forceNew: true
          });
          const okMessage = lsRestarted
            ? `已切换至 ${cleanTarget}，语言服务已重启并通过 GetUserStatus 核验生效。`
            : `已写入 ${cleanTarget} 凭据并通过生效校验（部分桌面扩展若仍显示旧缓存，建议重载窗口）。`;
          nextStore.autoSwitchStatus = {
            ...nextStore.autoSwitchStatus,
            lastSwitchAtMs: nowMs,
            lastResult: {
              ok: true,
              fromEmail: preActiveEmail,
              toEmail: cleanTarget,
              atMs: nowMs,
              trigger: opts.trigger || 'manual',
              rolledBack: false,
              message: okMessage
            },
            lastError: null
          };
          saveStore(nextStore);
          return {
            ok: true,
            email: cleanTarget,
            accountScopeKey: buildAccountScopeKey(cleanTarget),
            lsRestarted,
            verifiedEffective: true,
            requiresWindowReloadHint: !lsRestarted,
            message: okMessage
          };
        }

        // 若 LS 未在校验时间内确认切换为目标邮箱，默认自动回滚并保持原活跃账号，不虚报成功！
        let rolledBack = false;
        if (opts.rollbackOnVerifyMismatch !== false && preSnap) {
          try {
            const rb = credStore.restoreSnapshot(preSnap);
            rolledBack = Boolean(rb?.ok !== false);
          } catch { }
        }
        const failErrMsg = `凭据验证未生效，宿主暂未切换至 ${cleanTarget}${verifiedEmail ? `（当前仍回报 ${verifiedEmail}）` : ''}${rolledBack ? '，已自动回滚原凭据' : ''}。请重载或重启 Antigravity 客户端后重试。`;
        const savedFailStore = finalizeFailureStore({ errMsg: failErrMsg, rolledBack, verifiedEmail, atMs: nowMs });
        return {
          ok: false,
          verifiedEffective: false,
          rolledBack,
          lsRestarted,
          observedEmail: verifiedEmail || null,
          activeAccountEmail: savedFailStore.activeAccountEmail || null,
          error: failErrMsg
        };
      } catch (e) {
        let rolledBack = false;
        if (preSnap) {
          try {
            const rb = credStore.restoreSnapshot(preSnap);
            rolledBack = Boolean(rb?.ok !== false);
          } catch { }
        }
        const errMsg = e.message || String(e);
        finalizeFailureStore({ errMsg, rolledBack, verifiedEmail: '', atMs: Date.now() });
        return { ok: false, error: errMsg, rolledBack, authInvalid: Boolean(e.isAuthInvalid) };
      } finally {
        lock.release();
      }
    };

    inFlightSwitch = execSwitch().finally(() => { inFlightSwitch = null; });
    return inFlightSwitch;
  }

  // =========================================================================
  // 阈值自动切号状态机（默认关闭，仅当用户显式开启、数据新鲜可用、且存在合适候选时才执行）
  // =========================================================================

  function updateAutoSwitchConfig(patch = {}) {
    const store = loadStore();
    const prevEnabled = Boolean(store.autoSwitch.enabled);
    const next = {
      ...store.autoSwitch,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : store.autoSwitch.enabled,
      metricMode: patch.metricMode === 'used_pct' ? 'used_pct' : (patch.metricMode === 'remaining_pct' ? 'remaining_pct' : store.autoSwitch.metricMode),
      poolKey: patch.poolKey ? String(patch.poolKey).trim() : store.autoSwitch.poolKey,
      windowKey: ['primary', '5h', '7d', '24h'].includes(patch.windowKey) ? patch.windowKey : store.autoSwitch.windowKey,
      thresholdPct: patch.thresholdPct !== undefined && Number.isFinite(Number(patch.thresholdPct)) ? Math.max(1, Math.min(95, Number(patch.thresholdPct))) : store.autoSwitch.thresholdPct,
      debounceSec: patch.debounceSec !== undefined && Number.isFinite(Number(patch.debounceSec)) ? Math.max(0, Math.min(300, Number(patch.debounceSec))) : store.autoSwitch.debounceSec,
      cooldownSec: patch.cooldownSec !== undefined && Number.isFinite(Number(patch.cooldownSec)) ? Math.max(10, Math.min(3600, Number(patch.cooldownSec))) : store.autoSwitch.cooldownSec,
      waitUntilIdle: patch.waitUntilIdle !== undefined ? Boolean(patch.waitUntilIdle) : store.autoSwitch.waitUntilIdle,
      strategy: patch.strategy === 'candidate_order' ? 'candidate_order' : (patch.strategy === 'highest_quota' ? 'highest_quota' : store.autoSwitch.strategy),
      candidates: Array.isArray(patch.candidates)
        ? Array.from(new Set(patch.candidates.map(normalizeEmail).filter(Boolean)))
        : store.autoSwitch.candidates
    };
    store.autoSwitch = next;
    if (!next.enabled) {
      store.autoSwitchStatus.state = 'disabled';
      store.autoSwitchStatus.blockedReason = null;
      debounceState.clear();
    } else if (!prevEnabled) {
      store.autoSwitchStatus.state = 'watching';
      store.autoSwitchStatus.lastError = null;
      store.autoSwitchStatus.blockedReason = null;
    }
    saveStore(store);
    return { ok: true, autoSwitch: next, autoSwitchStatus: store.autoSwitchStatus };
  }

  function extractPoolMetricPct(quotaSnapshot, poolKey, windowKey = 'primary') {
    if (!quotaSnapshot || !Array.isArray(quotaSnapshot.pools)) return null;
    const pool = quotaSnapshot.pools.find(p => p.poolKey === poolKey);
    if (!pool || pool.noPermission) return null;
    let targetBucket = null;
    if (windowKey === 'primary') {
      targetBucket = pool.primaryBucket || selectPrimaryQuotaBucket(pool.buckets || []).primaryBucket;
    } else {
      targetBucket = (pool.buckets || []).find(b =>
        String(b.windowShort || '').toLowerCase() === windowKey ||
        String(b.windowKey || '').toLowerCase() === windowKey ||
        (windowKey === '7d' && b.windowKey === 'weekly')
      ) || null;
    }
    const frac = targetBucket ? targetBucket.remainingFraction : pool.remainingFraction;
    if (frac === null || frac === undefined || !Number.isFinite(Number(frac))) return null;
    return Number((Number(frac) * 100).toFixed(2));
  }

  async function evaluateAutoSwitch(ctx = {}) {
    const nowMs = Number.isFinite(Number(ctx.nowMs)) ? Number(ctx.nowMs) : Date.now();
    const store = loadStore();
    const cfg = store.autoSwitch;
    const st = store.autoSwitchStatus;

    if (!cfg.enabled) {
      return { ok: true, action: 'noop', state: 'disabled' };
    }
    st.lastCheckAtMs = nowMs;

    // 1. 数据过期 / 未知 / 错误 / 无权限：严格不触发
    const syncState = ctx.syncState || 'unknown';
    if (syncState !== 'fresh') {
      st.state = 'blocked_untrusted_quota';
      st.blockedReason = `quota_state_${syncState}`;
      debounceState.clear();
      saveStore(store);
      return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state };
    }

    const activeEmail = normalizeEmail(ctx.activeEmail || store.activeAccountEmail || '');
    const activeSnapshot = ctx.activeSnapshot || store.accounts[activeEmail]?.quotaSnapshot || null;
    if (!activeEmail || !activeSnapshot) {
      st.state = 'blocked_missing_account';
      st.blockedReason = 'no_active_account_or_snapshot';
      saveStore(store);
      return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state };
    }

    const remPct = extractPoolMetricPct(activeSnapshot, cfg.poolKey, cfg.windowKey);
    if (remPct === null) {
      st.state = 'blocked_missing_pool';
      st.blockedReason = 'target_pool_unavailable_or_no_permission';
      saveStore(store);
      return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state };
    }

    // 检查是否触发阈值
    const usedPct = Number((100 - remPct).toFixed(2));
    const triggered = cfg.metricMode === 'used_pct' ? (usedPct >= cfg.thresholdPct) : (remPct <= cfg.thresholdPct);
    if (!triggered) {
      // 额度重置或滚动恢复回到安全线以上：重置状态并恢复 watching
      debounceState.delete(activeEmail);
      st.state = 'watching';
      st.blockedReason = null;
      saveStore(store);
      return { ok: true, action: 'ok_above_threshold', remainingPct: remPct, usedPct, state: 'watching' };
    }

    // 2. 冷却保护（优先检查，避免刚切完号又再次进入防抖）
    if (st.lastSwitchAtMs && (nowMs - st.lastSwitchAtMs) < cfg.cooldownSec * 1000) {
      st.state = 'cooldown';
      saveStore(store);
      return { ok: true, action: 'cooldown', retryInSec: Math.ceil((st.lastSwitchAtMs + cfg.cooldownSec * 1000 - nowMs) / 1000), state: 'cooldown' };
    }

    // 3. 防抖保护（默认 15s）
    const dbKey = `${activeEmail}|${cfg.poolKey}|${cfg.windowKey}`;
    const dbEntry = debounceState.get(dbKey);
    if (!dbEntry) {
      debounceState.set(dbKey, { firstSeenMs: nowMs });
      if (cfg.debounceSec > 0) {
        st.state = 'pending_debounce';
        saveStore(store);
        return { ok: true, action: 'pending_debounce', state: st.state, remainingPct: remPct };
      }
    } else if ((nowMs - dbEntry.firstSeenMs) < cfg.debounceSec * 1000) {
      st.state = 'pending_debounce';
      saveStore(store);
      return { ok: true, action: 'pending_debounce', state: st.state, remainingPct: remPct };
    }

    // 4. 若当前正在生成，不静默中断，等待安全时机
    if (ctx.isGenerating && cfg.waitUntilIdle) {
      st.state = 'waiting_idle';
      st.blockedReason = 'generation_in_progress';
      saveStore(store);
      return { ok: true, action: 'waiting_idle', state: 'waiting_idle' };
    }

    // 5. 筛选可用且充足的候选目标账号（绝不选中同账号/无效授权/也处于阈值以下/过期快照的账号）
    const candidateEmails = (cfg.candidates || [])
      .map(normalizeEmail)
      .filter(e => e && e !== activeEmail && store.accounts[e] && !store.accounts[e].authInvalid && store.accounts[e].credential?.refreshToken);

    const eligible = [];
    for (const ce of candidateEmails) {
      const cRec = store.accounts[ce];
      const cAgeMs = cRec.lastQuotaUpdatedAtMs ? (nowMs - cRec.lastQuotaUpdatedAtMs) : Infinity;
      if (cRec.lastQuotaError || cAgeMs > (ctx.candidateMaxStaleMs || 5 * 60 * 1000)) continue;
      const cRem = extractPoolMetricPct(cRec.quotaSnapshot, cfg.poolKey, cfg.windowKey);
      if (cRem === null) continue;
      const cUsed = Number((100 - cRem).toFixed(2));
      const cStillLow = cfg.metricMode === 'used_pct' ? (cUsed >= cfg.thresholdPct) : (cRem <= cfg.thresholdPct);
      if (!cStillLow) {
        eligible.push({ email: ce, remainingPct: cRem });
      }
    }

    if (!eligible.length) {
      st.state = 'all_candidates_exhausted';
      st.blockedReason = 'all_candidates_insufficient_or_stale';
      saveStore(store);
      return { ok: true, action: 'all_candidates_exhausted', state: 'all_candidates_exhausted' };
    }

    if (cfg.strategy === 'highest_quota') {
      eligible.sort((a, b) => b.remainingPct - a.remainingPct);
    }
    const chosen = eligible[0];

    st.state = 'switching';
    saveStore(store);
    const swRes = await (optsSwitchExecutor(ctx))(chosen.email, {
      trigger: 'auto_switch',
      nowMs,
      forceWhileBusy: !cfg.waitUntilIdle,
      restartLanguageServer: ctx.restartLanguageServer,
      skipTokenRefresh: ctx.skipTokenRefresh,
      assumeVerifiedInDryRun: ctx.assumeVerifiedInDryRun
    });

    const postStore = loadStore();
    if (!swRes.ok) {
      // 切换失败后停止循环并保留错误反馈（绝不连环重试烧毁其他账号）
      postStore.autoSwitch.enabled = false;
      postStore.autoSwitchStatus = {
        ...postStore.autoSwitchStatus,
        state: 'error',
        lastError: swRes.error || '自动切号失败，已停止自动切换保护账号状态',
        lastResult: { ok: false, toEmail: chosen.email, atMs: nowMs, error: swRes.error }
      };
      saveStore(postStore);
      return { ok: false, action: 'switch_failed_halted', targetEmail: chosen.email, error: swRes.error };
    }

    debounceState.clear();
    return { ok: true, action: 'switched', fromEmail: activeEmail, toEmail: chosen.email, targetRemainingPct: chosen.remainingPct, switchResult: swRes };
  }

  function optsSwitchExecutor(ctx) {
    return typeof ctx.switchFn === 'function' ? ctx.switchFn : switchActiveAccount;
  }

  function getOverviewState() {
    const store = loadStore();
    const list = Object.values(store.accounts || {}).map(rec => sanitizeAccountForView(rec, store.activeAccountEmail));
    list.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || String(a.email).localeCompare(String(b.email)));
    const accountSessions = (store.accountSessions || []).map(s => ({
      email: s.email,
      accountScopeKey: s.accountScopeKey || buildAccountScopeKey(s.email),
      source: s.source || 'desktop',
      startAtMs: s.startAtMs,
      lastVerifiedAtMs: s.lastVerifiedAtMs,
      endAtMs: s.endAtMs ?? null,
      evidence: s.evidence || 'unknown'
    }));
    return {
      ok: true,
      activeAccountEmail: store.activeAccountEmail || null,
      activeAccountScopeKey: store.activeAccountEmail ? buildAccountScopeKey(store.activeAccountEmail) : null,
      switchInProgress: isSwitchLockActive(),
      accounts: list,
      accountSessions,
      diagnosticsPath: path.join(stateDir, 'oauth_diagnostics.jsonl'),
      lastDiagnostics: (store.lastDiagnostics || []).slice(-10),
      autoSwitch: store.autoSwitch,
      autoSwitchStatus: store.autoSwitchStatus,
      keepalive: store.keepalive,
      keepaliveState: store.keepaliveState,
      quotaIntervals: (store.quotaIntervals || []).slice().reverse(),
      sourceCapabilities: SOURCE_ATTRIBUTION_CAPABILITIES,
      protocolEvidence: ELV52_PROTOCOL_EVIDENCE
    };
  }

  return {
    getPaths: () => ({ storePath, switchLockPath, keepaliveLockPath }),
    loadStore,
    saveStore,
    getOverviewState,
    detectCurrentActiveAccount,
    importFromCurrentClient,
    listAntigravityToolsAccounts,
    importFromAntigravityTools,
    startOAuthLogin,
    addAccountWithCredential,
    removeAccount,
    refreshAccountQuota,
    syncActiveHostQuotaSnapshot,
    switchActiveAccount,
    updateAutoSwitchConfig,
    evaluateAutoSwitch,
    updateKeepaliveConfig,
    stopKeepalive,
    evaluateKeepaliveTick,
    recordQuotaComparisonSample,
    rebuildQuotaIntervalsFromHistory,
    isSwitchInFlight: isSwitchLockActive
  };
}

// 2000ms LS 重启冷却 + ~2-5s Go LS 绑定及状态初始化 + 窗口/daemon 刷新与网络轮询余量
const DEFAULT_SWITCH_VERIFY_TIMEOUT_MS = 20000;

function defaultIsPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * 后备发现：从 ~/.gemini/antigravity/daemon/hub_*.json 扫描存活语言服务（pid 存活且按 mtimeMs 最新优先），
 * 仅在主进程无法通过活跃窗口 webContents 读取 URL 或旧端口失联时使用，不依赖 CDP / DevToolsActivePort。
 */
function discoverDaemonHubOrigins(opts = {}) {
  const daemonDir = opts.daemonDir || path.join(opts.homeDir || os.homedir(), '.gemini', 'antigravity', 'daemon');
  const isPidAlive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : defaultIsPidAlive;
  const out = [];
  try {
    if (!fs.existsSync(daemonDir)) return out;
    const files = fs.readdirSync(daemonDir);
    for (const name of files) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const filePath = path.join(daemonDir, name);
      try {
        const st = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const pid = Number(raw?.pid);
        const httpsPort = Number(raw?.httpsPort);
        const csrfToken = typeof raw?.csrfToken === 'string' ? raw.csrfToken.trim() : '';
        if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) continue;
        if (!csrfToken) continue;
        if (!isPidAlive(pid)) continue;
        out.push({
          origin: `https://127.0.0.1:${httpsPort}`,
          httpsPort,
          csrfToken,
          pid,
          filePath,
          mtimeMs: Number(st.mtimeMs) || 0
        });
      } catch { }
    }
  } catch { }
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.httpsPort - a.httpsPort));
  return out;
}

/**
 * 使用已知 origin 与 csrfToken 直接向本地 Antigravity Hub / LanguageServerService 发起 GetUserStatus，完全免 CDP。
 */
function requestGetUserStatusDirect(origin, csrfToken, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    try {
      const targetUrl = new URL('/exa.language_server_pb.LanguageServerService/GetUserStatus', origin);
      const client = targetUrl.protocol === 'https:' ? https : http;
      const bodyStr = '{}';
      const req = client.request(
        targetUrl,
        {
          agent: false,
          rejectUnauthorized: false,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyStr)),
            'Connect-Protocol-Version': '1',
            ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {})
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode || 0) >= 400) {
              return reject(new Error(`GetUserStatus HTTP ${res.statusCode}`));
            }
            try {
              const parsed = JSON.parse(raw || '{}');
              resolve({
                email: parsed?.userStatus?.email || '',
                userStatus: parsed?.userStatus || null
              });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.setTimeout(Number(timeoutMs) || 4000, () => {
        req.destroy(new Error('GetUserStatus 请求超时'));
      });
      req.on('error', reject);
      req.end(bodyStr);
    } catch (e) {
      reject(e);
    }
  });
}

let sharedAccountsMgr = null;
let sharedMgrStateDir = null;
const sharedMgrRuntime = {
  currentOrigin: '',
  getLiveOrigins: null,
  localApi: null,
  daemonDir: undefined,
  homeDir: undefined,
  isPidAlive: undefined,
  directRequestFn: null
};

function getSharedAccountsManager(opts = {}) {
  const applyRuntimeOpts = (targetRuntime, srcOpts) => {
    if (srcOpts.origin && typeof srcOpts.origin === 'string') {
      targetRuntime.currentOrigin = srcOpts.origin.trim();
    }
    if (typeof srcOpts.getLiveOrigins === 'function') {
      targetRuntime.getLiveOrigins = srcOpts.getLiveOrigins;
    }
    if (srcOpts.localApi) {
      targetRuntime.localApi = srcOpts.localApi;
    }
    if (srcOpts.daemonDir !== undefined) {
      targetRuntime.daemonDir = srcOpts.daemonDir;
    }
    if (srcOpts.homeDir !== undefined) {
      targetRuntime.homeDir = srcOpts.homeDir;
    }
    if (typeof srcOpts.isPidAlive === 'function') {
      targetRuntime.isPidAlive = srcOpts.isPidAlive;
    }
    if (typeof srcOpts.directRequestFn === 'function') {
      targetRuntime.directRequestFn = srcOpts.directRequestFn;
    }
  };

  const stateDirDiffers = Boolean(opts.stateDir && opts.stateDir !== sharedMgrStateDir);
  if (!sharedAccountsMgr || opts.forceNew || stateDirDiffers) {
    if (!opts.forceNew && opts.stateDir) sharedMgrStateDir = opts.stateDir;
    const collector = opts.collector || require('./meter-collector');
    const localRuntime = opts.forceNew
      ? {
          currentOrigin: '',
          getLiveOrigins: null,
          localApi: null,
          daemonDir: undefined,
          homeDir: undefined,
          isPidAlive: undefined,
          directRequestFn: null
        }
      : sharedMgrRuntime;
    applyRuntimeOpts(localRuntime, opts);

    const mgr = createAccountsManager({
      ...opts,
      collector,
      getHostUserStatus: opts.getHostUserStatus || (async (callOpts = {}) => {
        const localApi = localRuntime.localApi || require('./local-api');
        const directFn = localRuntime.directRequestFn || requestGetUserStatusDirect;
        // 严格按非 CDP 优先级收集候选：
        // 1) Electron 主进程活跃窗口 webContents URL（最新实况）
        // 2) 最近已确认的 currentOrigin
        // 3) daemon/hub_*.json 后备（校验 pid 存活 + mtimeMs 最新）
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (origin, csrfToken = '', fromSource = '') => {
          if (!origin || typeof origin !== 'string') return;
          const cleanOrigin = origin.trim();
          if (!cleanOrigin) return;
          const key = `${cleanOrigin}|${csrfToken ? 'tok' : 'notok'}`;
          if (seen.has(key)) return;
          seen.add(key);
          candidates.push({ origin: cleanOrigin, csrfToken, fromSource });
        };

        let liveOrigins = [];
        if (typeof localRuntime.getLiveOrigins === 'function') {
          try {
            const rawLive = localRuntime.getLiveOrigins();
            if (Array.isArray(rawLive)) liveOrigins = rawLive;
          } catch { }
        }
        const hubBackups = discoverDaemonHubOrigins({
          daemonDir: localRuntime.daemonDir,
          homeDir: localRuntime.homeDir,
          isPidAlive: localRuntime.isPidAlive
        });

        if (callOpts?.force) {
          for (const lo of liveOrigins) pushCandidate(lo, '', 'electron_window');
          if (localRuntime.currentOrigin) pushCandidate(localRuntime.currentOrigin, '', 'current_origin');
          for (const hub of hubBackups) pushCandidate(hub.origin, hub.csrfToken, 'daemon_hub');
        } else {
          if (localRuntime.currentOrigin) pushCandidate(localRuntime.currentOrigin, '', 'current_origin');
          for (const lo of liveOrigins) pushCandidate(lo, '', 'electron_window');
          for (const hub of hubBackups) pushCandidate(hub.origin, hub.csrfToken, 'daemon_hub');
        }

        for (const cand of candidates) {
          try {
            if (cand.csrfToken) {
              try {
                const res = await directFn(cand.origin, cand.csrfToken);
                localRuntime.currentOrigin = cand.origin;
                return res;
              } catch { }
            }
            if (typeof localApi?.connect === 'function') {
              const api = await localApi.connect({ origin: cand.origin });
              if (api?.origin) localRuntime.currentOrigin = api.origin;
              const u = await api.call('GetUserStatus', {});
              return {
                email: u?.userStatus?.email || '',
                userStatus: u?.userStatus || null
              };
            }
          } catch { }
        }
        return null;
      })
    });
    if (!opts.forceNew) sharedAccountsMgr = mgr;
    return mgr;
  }
  applyRuntimeOpts(sharedMgrRuntime, opts);
  return sharedAccountsMgr;
}

async function dispatchAccountsAction(mgr, payload = {}) {
  const act = String(payload?.action || '').trim();
  if (!mgr) return { ok: false, error: '账号管理器尚未初始化' };
  switch (act) {
    case 'overview':
      return mgr.getOverviewState();
    case 'detect_active':
      return { ok: true, active: await mgr.detectCurrentActiveAccount(), overview: mgr.getOverviewState() };
    case 'import_current':
      return { ...(await mgr.importFromCurrentClient()), overview: mgr.getOverviewState() };
    case 'preview_tools':
      return mgr.listAntigravityToolsAccounts();
    case 'import_tools':
      return { ...mgr.importFromAntigravityTools(payload.emails || null), overview: mgr.getOverviewState() };
    case 'oauth_login':
      return { ...(await mgr.startOAuthLogin()), overview: mgr.getOverviewState() };
    case 'remove':
      return { ...mgr.removeAccount(payload.email), overview: mgr.getOverviewState() };
    case 'refresh_quota': {
      const targetEmail = payload.email ? normalizeEmail(payload.email) : '';
      if (targetEmail) {
        const res = await mgr.refreshAccountQuota(targetEmail);
        return {
          ...res,
          ...(res.ok ? { message: `已刷新 ${targetEmail} 最新额度快照。` } : {}),
          overview: mgr.getOverviewState()
        };
      }
      const st = mgr.getOverviewState();
      const results = [];
      let successCount = 0;
      let failCount = 0;
      let firstError = '';
      for (const acc of st.accounts) {
        if (!acc.hasRefreshToken) continue;
        const r = await mgr.refreshAccountQuota(acc.email);
        results.push({ email: acc.email, ...r });
        if (r.ok) successCount += 1;
        else {
          failCount += 1;
          if (!firstError) firstError = r.error || '刷新失败';
        }
      }
      if (failCount > 0) {
        return {
          ok: false,
          partialOk: successCount > 0,
          successCount,
          failCount,
          error: `额度刷新部分或全部失败（成功 ${successCount} / 失败 ${failCount}）：${firstError}`,
          results,
          overview: mgr.getOverviewState()
        };
      }
      return {
        ok: true,
        successCount,
        failCount: 0,
        message: successCount > 0 ? `已刷新全部 ${successCount} 个账号最新额度快照。` : '当前无可刷新账号。',
        results,
        overview: mgr.getOverviewState()
      };
    }
    case 'switch':
      return {
        ...(await mgr.switchActiveAccount(payload.email, {
          forceWhileBusy: Boolean(payload.forceWhileBusy),
          ...(payload.verifyTimeoutMs != null ? { verifyTimeoutMs: payload.verifyTimeoutMs } : {})
        })),
        overview: mgr.getOverviewState()
      };
    case 'update_auto_switch':
      return { ...mgr.updateAutoSwitchConfig(payload.config || {}), overview: mgr.getOverviewState() };
    case 'evaluate_auto_switch':
      return { ...(await mgr.evaluateAutoSwitch(payload.context || {})), overview: mgr.getOverviewState() };
    case 'update_keepalive':
      return { ...mgr.updateKeepaliveConfig(payload.config || {}), overview: mgr.getOverviewState() };
    case 'stop_keepalive':
      return { ...mgr.stopKeepalive(payload.reason || 'manual_stop'), overview: mgr.getOverviewState() };
    default:
      return { ok: false, error: `未知账号操作: ${act}` };
  }
}

module.exports = {
  OFFICIAL_OAUTH_CLIENT_PAIRS,
  resolveAntigravityOAuthConfig,
  resolveAllAntigravityOAuthConfigs,
  SOURCE_ATTRIBUTION_CAPABILITIES,
  ELV52_PROTOCOL_EVIDENCE,
  DEFAULT_AUTO_SWITCH_CONFIG,
  DEFAULT_KEEPALIVE_CONFIG,
  DEFAULT_SWITCH_VERIFY_TIMEOUT_MS,
  discoverDaemonHubOrigins,
  requestGetUserStatusDirect,
  normalizeEmail,
  buildAccountScopeKey,
  maskEmail,
  redactAccountDiagnosticEntry,
  appendAccountDiagnostic,
  deriveAccountSessionsFromStore,
  recordVerifiedAccountSession,
  closeActiveAccountSessions,
  resolveAccountForTimestamp,
  buildUnifiedOAuthTokenTopicBase64,
  parseUnifiedOAuthTokenTopicBase64,
  buildUnifiedUserStatusTopicBase64,
  parseUnifiedUserStatusTopicBase64,
  createDefaultSystemCredentialStore,
  createAccountsManager,
  getSharedAccountsManager,
  dispatchAccountsAction,
  fetchAccountQuotaViaCloudCode,
  CLOUDCODE_DAILY_URL,
  CLOUDCODE_PROD_URL,
  ANTIGRAVITY_OAUTH_SCOPES
};
