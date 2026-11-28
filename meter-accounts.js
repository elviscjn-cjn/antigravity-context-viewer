'use strict';

/**
 * Antigravity 多账号统一身份、凭据切换、阈值自动切号、ELV-57 配额对照区间与 ELV-52 保活保障引擎。
 * 覆盖 Google OAuth2 回环授权、Token 刷新、CloudCode 配额查询与本地 state.vscdb / 系统凭据同步。
 * 第三方开源归属声明统一见根目录 THIRD_PARTY_NOTICES.md。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { execFileSync, spawnSync, spawn } = require('child_process');

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
const CLOUDCODE_SANDBOX_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const GOOGLE_ANTIGRAVITY_SUPPORT_URL = 'https://antigravity.google/support';

/**
 * 将上游订阅档位原文规范化为 ULTRA / PRO / FREE 及可读套餐名称，避免界面裸露 g1-pro-tier / free-tier 内部标识
 * @param {string|null|undefined} rawTier
 * @returns {{ tierCode: string|null, tierName: string|null, rawTier: string|null }}
 */
function normalizeSubscriptionTierInfo(rawTier) {
  const raw = typeof rawTier === 'string' ? rawTier.trim() : '';
  if (!raw || raw === '未知' || /^unknown$/i.test(raw)) {
    return { tierCode: null, tierName: null, rawTier: raw || null };
  }
  const low = raw.toLowerCase();
  if (low.includes('ultra')) {
    return { tierCode: 'ULTRA', tierName: 'Google AI Ultra', rawTier: raw };
  }
  if (low.includes('pro')) {
    return { tierCode: 'PRO', tierName: 'Google AI Pro', rawTier: raw };
  }
  if (low.includes('plus')) {
    return { tierCode: 'PLUS', tierName: 'Google AI Plus', rawTier: raw };
  }
  if (low.includes('free') || low.includes('standard') || low.includes('免费') || low.includes('免費')) {
    return { tierCode: 'FREE', tierName: 'Free', rawTier: raw };
  }
  return { tierCode: null, tierName: raw, rawTier: raw };
}

/**
 * 从账号真实配额快照中派生精简可用模型能力标签（严禁编造或混入反代/优先级概念）
 * @param {Object|null} quotaSnapshot
 * @param {string|null} tierCode
 * @returns {string[]}
 */
function deriveAccountCapabilities(quotaSnapshot, tierCode = null) {
  const pools = Array.isArray(quotaSnapshot?.pools) ? quotaSnapshot.pools : [];
  if (!pools.length) return [];
  const tags = [];
  const addTag = (label) => {
    if (label && !tags.includes(label)) tags.push(label);
  };
  let hasArgon = false;
  let claudeVer = '';
  let hasGpt120b = false;

  for (const pool of pools) {
    if (!pool || pool.noPermission) continue;
    const pk = String(pool.poolKey || '').toLowerCase();
    const title = String(pool.title || pool.poolTitle || '').toLowerCase();
    const desc = String(pool.description || '').toLowerCase();
    const models = Array.isArray(pool.models) ? pool.models : [];

    if (pk === 'shared_gemini_argon' || title.includes('argon')) {
      hasArgon = true;
    }
    for (const m of models) {
      if (!m || m.noPermission) continue;
      const hay = [m.productLabel, m.productKey, ...(m.modelIds || []), ...(m.aliases || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (hay.includes('argon')) hasArgon = true;
      if (hay.includes('claude')) {
        if (hay.includes('5.5') || hay.includes('5-5')) claudeVer = 'Claude 5.5';
        else if (hay.includes('4.6') || hay.includes('4-6')) claudeVer = claudeVer || 'Claude 4.6';
        else if (!claudeVer) claudeVer = 'Claude';
      }
      if (hay.includes('gpt-oss') || hay.includes('gpt-120b') || hay.includes('120b')) {
        hasGpt120b = true;
      }
    }
    if (!claudeVer && desc.includes('claude')) {
      if (desc.includes('5.5')) claudeVer = 'Claude 5.5';
      else if (desc.includes('4.6')) claudeVer = 'Claude 4.6';
      else claudeVer = 'Claude';
    }
    if (!hasGpt120b && (desc.includes('gpt-oss') || desc.includes('120b'))) {
      hasGpt120b = true;
    }
  }

  if (hasArgon || tierCode === 'ULTRA') addTag('Argon');
  if (claudeVer) addTag(claudeVer);
  if (hasGpt120b) addTag('GPT-120B');
  return tags;
}

/**
 * 识别可信的账号停用（ToS）状态信号：仅依据明确的结构化状态码或清晰的官方停用文案判定，绝不靠普通网络/限流错误猜测。
 */
function detectAccountSuspendedSignal(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;
    if (/(?:account[_\s-]?suspended|tos[_\s-]?violation|account[_\s-]?disabled|terms\s+of\s+service\s+violation|your\s+account\s+(?:has\s+been\s+)?(?:suspended|disabled)|账号已被停用|帳號已被停用|违反服务条款|違反服務條款)/i.test(s)) {
      return { suspended: true, reason: s.slice(0, 200) };
    }
    return null;
  }
  if (typeof input === 'object') {
    const us = input.userStatus && typeof input.userStatus === 'object' ? input.userStatus : input;
    if (us.suspended === true || us.isSuspended === true || us.accountSuspended === true || us.tosSuspended === true) {
      return {
        suspended: true,
        reason: String(us.suspendedReason || us.disabledReason || us.suspensionMessage || 'ACCOUNT_SUSPENDED').slice(0, 200)
      };
    }
    const statusStr = String(us.accountStatus || us.status || us.code || us.errorCode || '').trim().toUpperCase();
    if (['ACCOUNT_SUSPENDED', 'TOS_VIOLATION', 'USER_DISABLED', 'ACCOUNT_DISABLED', 'SUSPENDED'].includes(statusStr)) {
      return {
        suspended: true,
        reason: String(us.suspendedReason || us.error || statusStr).slice(0, 200)
      };
    }
    const textHit = detectAccountSuspendedSignal(us.error || us.message || us.detail || '');
    if (textHit) return textHit;
  }
  return null;
}

const CALLBACK_PORT_START = 11451;
const CALLBACK_PORT_RANGE = 80;

const AUTO_SWITCH_QUOTA_TARGETS = Object.freeze([
  Object.freeze({ targetKey: 'shared_gemini_main:5h', poolKey: 'shared_gemini_main', windowKey: '5h' }),
  Object.freeze({ targetKey: 'shared_gemini_main:7d', poolKey: 'shared_gemini_main', windowKey: '7d' }),
  Object.freeze({ targetKey: 'shared_3p_pool:5h', poolKey: 'shared_3p_pool', windowKey: '5h' }),
  Object.freeze({ targetKey: 'shared_3p_pool:7d', poolKey: 'shared_3p_pool', windowKey: '7d' })
]);
const AUTO_SWITCH_FLOAT_EPS = 1e-9;

/**
 * 校验自动切号的监控额度是否为允许的四项精确组合之一
 * @param {string} poolKey
 * @param {string} windowKey
 * @returns {{ valid: boolean, targetKey: string, poolKey: string, windowKey: string, reason?: string }}
 */
function validateAutoSwitchQuotaTarget(poolKey, windowKey) {
  const pk = String(poolKey || '').trim();
  const wk = String(windowKey || '').trim().toLowerCase();
  const matched = AUTO_SWITCH_QUOTA_TARGETS.find(t => t.poolKey === pk && t.windowKey === wk);
  if (matched) {
    return { valid: true, targetKey: matched.targetKey, poolKey: matched.poolKey, windowKey: matched.windowKey };
  }
  return { valid: false, targetKey: '', poolKey: pk, windowKey: wk, reason: 'legacy_rule_needs_migration' };
}

const DEFAULT_AUTO_SWITCH_CONFIG = Object.freeze({
  enabled: false,
  metricMode: 'remaining_pct', // 'remaining_pct' | 'used_pct'
  poolKey: 'shared_gemini_main',
  windowKey: '5h', // '5h' | '7d'
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
 * 从宿主/采集器返回的额度响应派生自动切号可信上下文：
 * 仅当请求成功无错、快照明确处于 fresh、同次响应带有可验证的归属邮箱且与当前活跃账号一致、
 * 且采样时间戳有效（非缺失、非未来时间、在新鲜窗口内）才允许自动切号采信并写入账号配额。
 */
function deriveTrustedAutoSwitchQuotaContext({ res = null, raw = null, activeEmail = null, nowMs = Date.now(), maxAgeMs = 120000, maxFutureSkewMs = 5000 } = {}) {
  if (!res) {
    return {
      trusted: false,
      syncState: 'error',
      reason: 'quota_snapshot_unavailable'
    };
  }
  if (res.staleDiscarded === true || res.dataFreshness === 'stale_discarded') {
    return {
      trusted: false,
      syncState: 'stale_discarded',
      reason: res.discardedReason || 'quota_snapshot_stale_discarded'
    };
  }
  if (
    res.forceRefreshFallback === true ||
    res.dataFreshness === 'host_cache_fallback' ||
    res.errorKind === 'force_refresh_unsupported' ||
    (res.forceRefreshSent === true && res.forceRefreshApplied === false && !res.error)
  ) {
    return {
      trusted: false,
      syncState: 'host_cache_fallback',
      reason: 'quota_host_cache_fallback'
    };
  }
  if (res.accountIdentityMismatch === true || res.errorKind === 'account_mismatch') {
    return {
      trusted: false,
      syncState: 'account_mismatch',
      reason: 'quota_snapshot_account_mismatch'
    };
  }
  if (res.identityVerified === false || res.errorKind === 'unverified_account') {
    return {
      trusted: false,
      syncState: 'unverified_account',
      reason: 'quota_snapshot_unverified_identity'
    };
  }
  if (res.ok !== true || res.error || !res.snapshot) {
    const rawState = String(res?.snapshot?.syncState || res?.syncState || 'error');
    return {
      trusted: false,
      syncState: rawState === 'fresh' ? 'error' : rawState,
      reason: res?.error || 'quota_snapshot_unavailable'
    };
  }
  const snapSyncState = String(res.snapshot.syncState || res.syncState || 'unknown');
  if (snapSyncState !== 'fresh') {
    return {
      trusted: false,
      syncState: snapSyncState,
      reason: `quota_state_${snapSyncState}`
    };
  }
  const normActive = normalizeEmail(activeEmail || '');
  const snapEmail = normalizeEmail(
    res.email || res.snapshot.email || raw?.planStatus?.email || raw?.userStatus?.email || raw?.email || ''
  );
  if (!snapEmail) {
    return {
      trusted: false,
      syncState: 'unverified_account',
      reason: 'quota_snapshot_missing_account',
      activeEmail: normActive || null
    };
  }
  if (normActive && normActive !== snapEmail) {
    return {
      trusted: false,
      syncState: 'account_mismatch',
      reason: 'quota_snapshot_account_mismatch',
      snapEmail,
      activeEmail: normActive
    };
  }
  const refNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const snapTs = Number(res.snapshot.updatedAtMs || res.updatedAtMs || res.snapshot.fetchedAtMs || res.fetchedAtMs || 0);
  if (!Number.isFinite(snapTs) || snapTs <= 0) {
    return {
      trusted: false,
      syncState: 'untrusted_timestamp',
      reason: 'quota_snapshot_missing_timestamp',
      email: snapEmail
    };
  }
  const futureLimit = Number.isFinite(Number(maxFutureSkewMs)) ? Number(maxFutureSkewMs) : 5000;
  if (snapTs > refNow + futureLimit) {
    return {
      trusted: false,
      syncState: 'untrusted_timestamp',
      reason: 'quota_snapshot_future_timestamp',
      skewMs: snapTs - refNow,
      email: snapEmail
    };
  }
  if (Number.isFinite(Number(maxAgeMs)) && (refNow - snapTs) > Number(maxAgeMs)) {
    return {
      trusted: false,
      syncState: 'stale',
      reason: 'quota_state_stale',
      ageMs: refNow - snapTs,
      email: snapEmail
    };
  }
  return {
    trusted: true,
    syncState: 'fresh',
    reason: null,
    email: snapEmail,
    snapTs
  };
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

const _stateDbItemsCache = new Map();

function readStateDbItems(dbPath, keys) {
  if (!dbPath || !fs.existsSync(dbPath)) return {};
  let statSig = '';
  try {
    const st = fs.statSync(dbPath);
    let walSig = '0:0';
    try {
      const wst = fs.statSync(`${dbPath}-wal`);
      walSig = `${wst.size}:${wst.mtimeMs}`;
    } catch { }
    statSig = `${st.size}:${st.mtimeMs}|${walSig}|${keys.join(',')}`;
    const cached = _stateDbItemsCache.get(dbPath);
    if (cached && cached.statSig === statSig) {
      return { ...cached.items };
    }
  } catch { }
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
      if (statSig) _stateDbItemsCache.set(dbPath, { statSig, items: { ...out } });
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
// Google OAuth2 与 CloudCode 配额查询客户端
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

function isSafeDataImageUri(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 260000) return false;
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s);
}

function normalizeGoogleAvatarUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const s = rawUrl.trim();
  if (!/^https?:\/\//i.test(s)) return '';
  if (/googleusercontent\.com/i.test(s)) {
    if (/=s\d+(-c)?$/i.test(s)) return s.replace(/=s\d+(-c)?$/i, '=s96-c');
    if (!/=s\d+/i.test(s) && !/\?/.test(s)) return `${s}=s96-c`;
  }
  return s;
}

function decodeJwtPicture(jwtStr) {
  if (typeof jwtStr !== 'string') return '';
  const parts = jwtStr.split('.');
  if (parts.length < 2) return '';
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const json = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    const pic = json?.picture || json?.avatar_url || json?.photo_url || '';
    return typeof pic === 'string' ? pic.trim() : '';
  } catch {
    return '';
  }
}

function isAllowedAvatarFetchUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = String(parsed.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
    return parsed.protocol === 'https:' && (
      /(^|\.)googleusercontent\.com$/i.test(host)
      || /^lh\d+\.ggpht\.com$/i.test(host)
    );
  } catch {
    return false;
  }
}

async function fetchAvatarDataUriViaNode(rawUrl, customFetch = null, proxyConfigOptions = {}) {
  if (isSafeDataImageUri(rawUrl)) return String(rawUrl).trim();
  const targetUrl = normalizeGoogleAvatarUrl(rawUrl);
  if (!targetUrl || !isAllowedAvatarFetchUrl(targetUrl)) return null;
  const MAX_BYTES = 180 * 1024;
  const timeoutMs = 8000;

  if (typeof customFetch === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await customFetch(targetUrl, {
        method: 'GET',
        headers: { Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
        signal: controller.signal
      });
      if (!res || !res.ok) return null;
      const ctype = String(res.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (!ctype.startsWith('image/')) return null;
      const buf = typeof res.arrayBuffer === 'function'
        ? Buffer.from(await res.arrayBuffer())
        : (typeof res.buffer === 'function' ? await res.buffer() : null);
      if (!buf || !buf.length || buf.length > MAX_BYTES) return null;
      return `data:${ctype};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 优先复用系统/插件代理设置，直连或经 HTTPS 隧道下载头像并转为 Data URI，绕过 Electron CSP
  const proxyCfg = typeof detectProxyConfig === 'function' ? detectProxyConfig(proxyConfigOptions) : null;
  const tryFetchDirectOrEnv = async (urlToFetch, redirectsLeft = 3) => {
    if (redirectsLeft < 0) return null;
    let parsed;
    try { parsed = new URL(urlToFetch); } catch { return null; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (typeof fetch === 'function' && (!proxyCfg || !proxyCfg.enabled)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(urlToFetch, {
          method: 'GET',
          redirect: 'follow',
          headers: { Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
          signal: controller.signal
        });
        if (!res.ok) return null;
        const ctype = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
        if (!ctype.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) return null;
        return `data:${ctype};base64,${buf.toString('base64')}`;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return await new Promise((resolve) => {
      try {
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request(urlToFetch, {
          method: 'GET',
          headers: { Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8', 'User-Agent': 'AntigravityContextMeter/1.0' }
        }, (res) => {
          const code = Number(res.statusCode || 0);
          if ([301, 302, 303, 307, 308].includes(code) && res.headers?.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, urlToFetch).toString();
            void tryFetchDirectOrEnv(nextUrl, redirectsLeft - 1).then(resolve);
            return;
          }
          if (code < 200 || code >= 300) {
            res.resume();
            resolve(null);
            return;
          }
          const ctype = String(res.headers?.['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase();
          if (!ctype.startsWith('image/')) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > MAX_BYTES) {
              req.destroy();
              resolve(null);
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (total <= 0 || total > MAX_BYTES) return resolve(null);
            resolve(`data:${ctype};base64,${Buffer.concat(chunks).toString('base64')}`);
          });
          res.on('error', () => resolve(null));
        });
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { } resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
      } catch {
        resolve(null);
      }
    });
  };

  if (proxyCfg && proxyCfg.enabled && typeof requestWithProxyTunnel === 'function') {
    try {
      const tunRes = await requestWithProxyTunnel(targetUrl, {
        method: 'GET',
        headers: { Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
        timeoutMs,
        stage: 'avatar_fetch',
        binary: true,
        proxyConfigOptions
      });
      if (tunRes?.ok && Buffer.isBuffer(tunRes.buffer) && tunRes.buffer.length > 0 && tunRes.buffer.length <= MAX_BYTES) {
        const ctype = String(tunRes.headers?.['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase();
        if (ctype.startsWith('image/')) {
          return `data:${ctype};base64,${tunRes.buffer.toString('base64')}`;
        }
      }
    } catch { }
  }
  return await tryFetchDirectOrEnv(targetUrl, 3);
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
  const picRaw = res.json.picture || res.json.avatar_url || res.json.photo_url || null;
  return {
    email: normalizeEmail(res.json.email),
    name: String(res.json.name || res.json.given_name || res.json.email.split('@')[0] || ''),
    picture: typeof picRaw === 'string' && picRaw.trim() ? picRaw.trim() : null
  };
}

async function fetchAccountQuotaViaCloudCode(accessToken, options = {}) {
  const customFetch = options.fetch || null;
  const proxyConfigOptions = options.proxyConfigOptions || {};
  const quotaStage = options.stage || 'quota_fetch';
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ua = `antigravity/2.35.2 ${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': ua,
    'Content-Type': 'application/json'
  };

  // 参考 Antigravity-Manager (quota.rs)：
  // 1) loadCodeAssist 按 Daily -> Sandbox -> Prod 顺序提取项目 ID 与权威付费等级；
  // 2) fetchAvailableModels 与 retrieveUserQuotaSummary 严格按 Daily -> Sandbox，严禁回退到 Prod 污染配额（Prod 对耗尽账号误报 100%）。
  const explicitBaseUrl = options.baseUrl || (options.useDaily === false ? CLOUDCODE_PROD_URL : null);
  const loadEndpoints = explicitBaseUrl
    ? [explicitBaseUrl]
    : [CLOUDCODE_DAILY_URL, CLOUDCODE_SANDBOX_URL, CLOUDCODE_PROD_URL];
  const quotaEndpoints = explicitBaseUrl
    ? [explicitBaseUrl]
    : [CLOUDCODE_DAILY_URL, CLOUDCODE_SANDBOX_URL];

  let projectId = options.projectId || '';
  let rawTierId = null;
  let loadTargetHost = 'daily-cloudcode-pa.googleapis.com';

  for (const baseUrl of loadEndpoints) {
    let targetHost = 'daily-cloudcode-pa.googleapis.com';
    try { targetHost = new URL(baseUrl).hostname; } catch { }
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
        loadTargetHost = targetHost;
        if (typeof loadRes.json.cloudaicompanionProject === 'string' && loadRes.json.cloudaicompanionProject) {
          projectId = loadRes.json.cloudaicompanionProject;
        } else if (loadRes.json.cloudaicompanionProject?.id) {
          projectId = loadRes.json.cloudaicompanionProject.id;
        }
        // 等级提取优先级对齐 Antigravity-Manager：paidTier -> currentTier -> allowedTiers(free-tier/isDefault) -> free-tier
        const paidTier = loadRes.json.paidTier;
        const currentTier = loadRes.json.currentTier;
        const allowedTiers = Array.isArray(loadRes.json.allowedTiers) ? loadRes.json.allowedTiers : [];
        const fallbackAllowed = allowedTiers.find(t => t && (t.id === 'free-tier' || t.isDefault === true));
        rawTierId =
          (paidTier && (paidTier.id || paidTier.name))
          || (currentTier && (currentTier.id || currentTier.name))
          || (fallbackAllowed && (fallbackAllowed.id || fallbackAllowed.name))
          || 'free-tier';
        break;
      } else if (loadRes.status === 401 || loadRes.status === 403) {
        const bodyText = String(loadRes.text || '');
        const susSig = detectAccountSuspendedSignal(bodyText);
        const err = attachStageErrorMeta(
          new Error(susSig ? `账号已被停用 (HTTP ${loadRes.status}): ${susSig.reason}` : `CloudCode 鉴权失效 (HTTP ${loadRes.status})`),
          quotaStage,
          targetHost,
          loadRes.status,
          loadRes.diagnostics
        );
        err.isAuthInvalid = !susSig;
        if (susSig) err.isSuspended = true;
        throw err;
      }
    } catch (e) {
      if (e.isAuthInvalid || e.isSuspended) throw e;
    }
  }

  const tierInfo = normalizeSubscriptionTierInfo(rawTierId);
  const payload = projectId ? { project: projectId } : {};

  let reqRes = null;
  let lastQuotaErr = null;
  for (let i = 0; i < quotaEndpoints.length; i++) {
    const baseUrl = quotaEndpoints[i];
    let targetHost = 'daily-cloudcode-pa.googleapis.com';
    try { targetHost = new URL(baseUrl).hostname; } catch { }

    let availRes;
    let summaryRes;
    try {
      [availRes, summaryRes] = await Promise.all([
        fetchJsonWithProxy(`${baseUrl}/v1internal:fetchAvailableModels`, { method: 'POST', stage: quotaStage, headers, body: JSON.stringify(payload) }, customFetch, proxyConfigOptions),
        fetchJsonWithProxy(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, { method: 'POST', stage: quotaStage, headers, body: JSON.stringify(payload) }, customFetch, proxyConfigOptions)
      ]);
    } catch (e) {
      const diag = e?.diagnostics || {};
      lastQuotaErr = attachStageErrorMeta(
        new Error(`CloudCode 配额请求网络失败 (${diag.targetHost || targetHost}): ${sanitizeDiagnosticErrorText(e)}`),
        quotaStage,
        diag.targetHost || targetHost,
        null,
        diag
      );
      continue;
    }

    // 403 / 401 鉴权或停用识别：直接返回不误尝试下一端点
    const failed403 = [availRes, summaryRes].find(r => r && (r.status === 401 || r.status === 403));
    if (failed403 && !availRes.ok && !summaryRes.ok) {
      const bodyText = String(failed403.text || '');
      const lowText = bodyText.toLowerCase();
      const isValidation = lowText.includes('validation_required') || lowText.includes('verify your account') || lowText.includes('validation_url');
      const susSig = isValidation ? null : detectAccountSuspendedSignal(bodyText);
      const err = attachStageErrorMeta(
        new Error(
          susSig
            ? `账号服务已被停用 (HTTP ${failed403.status}): ${susSig.reason}`
            : (isValidation ? `账号需要验证身份 (HTTP ${failed403.status})` : `CloudCode 配额请求失败 (HTTP ${failed403.status})`)
        ),
        quotaStage,
        targetHost,
        failed403.status,
        failed403.diagnostics
      );
      err.isAuthInvalid = failed403.status === 401 || (!susSig && !isValidation && failed403.status === 403);
      if (susSig) err.isSuspended = true;
      if (isValidation) err.isValidationRequired = true;
      throw err;
    }

    if (!availRes.ok && !summaryRes.ok) {
      const st = availRes.status || summaryRes.status;
      lastQuotaErr = attachStageErrorMeta(
        new Error(`CloudCode 配额请求失败 (HTTP ${st})`),
        quotaStage,
        targetHost,
        st,
        availRes.diagnostics || summaryRes.diagnostics
      );
      continue;
    }

    reqRes = { availRes, summaryRes, targetHost };
    break;
  }

  if (!reqRes) {
    throw lastQuotaErr || attachStageErrorMeta(new Error('CloudCode 配额请求全部端点失败'), quotaStage, loadTargetHost, null, null);
  }

  const { availRes, summaryRes, targetHost } = reqRes;
  const modelsObj = availRes.ok && availRes.json?.models && typeof availRes.json.models === 'object' ? availRes.json.models : {};

  // 解析官方支持集合：兼容 agentModelSorts 对象数组（groups[].modelIds）与字符串数组，合并 imageGenerationModelIds / tieredModelIds
  const officialSupportedIds = new Set();
  if (Array.isArray(availRes.json?.agentModelSorts)) {
    for (const sortItem of availRes.json.agentModelSorts) {
      if (typeof sortItem === 'string' && sortItem.trim()) {
        officialSupportedIds.add(sortItem.trim().toLowerCase());
      } else if (sortItem && typeof sortItem === 'object' && Array.isArray(sortItem.groups)) {
        for (const grp of sortItem.groups) {
          if (Array.isArray(grp?.modelIds)) {
            for (const mid of grp.modelIds) {
              if (typeof mid === 'string' && mid.trim()) officialSupportedIds.add(mid.trim().toLowerCase());
            }
          }
        }
      }
    }
  }
  if (Array.isArray(availRes.json?.imageGenerationModelIds)) {
    for (const mid of availRes.json.imageGenerationModelIds) {
      if (typeof mid === 'string' && mid.trim()) officialSupportedIds.add(mid.trim().toLowerCase());
    }
  }
  if (availRes.json?.tieredModelIds && typeof availRes.json.tieredModelIds === 'object') {
    for (const ids of Object.values(availRes.json.tieredModelIds)) {
      if (Array.isArray(ids)) {
        for (const mid of ids) {
          if (typeof mid === 'string' && mid.trim()) officialSupportedIds.add(mid.trim().toLowerCase());
        }
      }
    }
  }

  const CORE_POOLS = new Set(['shared_gemini_main', 'shared_3p_pool', 'shared_gemini_argon', 'shared_gemini_carbon']);
  const clientModelConfigs = [];
  let hasAnyClaudeOrGptModel = false;
  const rawModelEntries = Object.entries(modelsObj);

  for (const [k, v] of rawModelEntries) {
    if (!v || typeof v !== 'object') continue;
    if (v.isInternal === true || v.disabled === true || v.isDisabled === true) continue;
    const mKey = String(k || '').trim().toLowerCase();
    const mModel = String(v.model || '').trim().toLowerCase();
    if (!mKey) continue;
    if (mKey.includes('-disabled') || mKey.endsWith('_disabled') || mKey === 'gemini-flash-worker-agy') continue;
    if ((mKey.startsWith('chat_') && /^chat_\d+$/.test(mKey)) || (mModel.startsWith('chat_') && /^chat_\d+$/.test(mModel))) continue;
    if (mKey.startsWith('tab_') || mModel.startsWith('tab_')) continue;
    if (officialSupportedIds.size > 0 && !officialSupportedIds.has(mKey) && !officialSupportedIds.has(mModel)) {
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
    if (mKey.startsWith('claude') || mKey.startsWith('gpt') || poolKey === 'shared_3p_pool') {
      hasAnyClaudeOrGptModel = true;
    }

    clientModelConfigs.push(cfg);
  }

  // 3P 隔离：若 fetchAvailableModels 已成功返回模型列表且完全无 Claude/GPT，剔除上游虚假 3P 分组
  let quotaSummaryData = summaryRes.ok ? (summaryRes.json?.response || summaryRes.json || null) : null;
  if (quotaSummaryData && Array.isArray(quotaSummaryData.groups) && rawModelEntries.length > 0 && !hasAnyClaudeOrGptModel) {
    quotaSummaryData = {
      ...quotaSummaryData,
      groups: quotaSummaryData.groups.filter((g) => {
        const gName = String(g?.displayName || g?.display_name || g?.name || '').toLowerCase();
        return !gName.includes('claude') && !gName.includes('gpt') && !gName.includes('3p');
      })
    };
  }

  const resolvedTierName = tierInfo.tierName || rawTierId || null;
  const userStatusCompat = {
    userStatus: {
      email: options.email || '',
      planStatus: resolvedTierName ? { planInfo: { planName: resolvedTierName, teamsTier: rawTierId || resolvedTierName } } : undefined,
      userTier: resolvedTierName ? { id: rawTierId || resolvedTierName, name: resolvedTierName } : undefined,
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
    tierId: rawTierId || null,
    tierCode: tierInfo.tierCode || null,
    tierName: resolvedTierName || snapshot?.planStatus?.tierName || null,
    targetHost,
    snapshot,
    fetchedAtMs: nowMs
  };
}

// =========================================================================
// 核心协调管理器（统一账号状态、自动切号、ELV-57 区间对账、ELV-52 保活保障）
// =========================================================================

function isTempIsolatedDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const tmpBase = path.resolve(os.tmpdir()).toLowerCase();
    const resolved = path.resolve(dirPath).toLowerCase();
    return resolved === tmpBase || resolved.startsWith(tmpBase + path.sep);
  } catch {
    return false;
  }
}

function createAccountsManager(options = {}) {
  const explicitStateDir = options.stateDir || options.storageDir || '';
  const stateDir = explicitStateDir || getStateDir();
  const autoIsolateHome = !options.homeDir && Boolean(explicitStateDir && isTempIsolatedDir(explicitStateDir));
  const homeDir = options.homeDir || (autoIsolateHome ? path.join(stateDir, '_isolated_home') : os.homedir());
  const resolvedAppDataDir = options.appDataDir || (autoIsolateHome ? path.join(stateDir, '_isolated_appdata') : undefined);
  const credStore = options.credentialStore || createDefaultSystemCredentialStore({
    homeDir,
    appDataDir: resolvedAppDataDir,
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
  const avatarsDir = path.join(stateDir, 'avatars');
  const switchLockPath = path.join(stateDir, 'account_switch.lock');
  const keepaliveLockPath = path.join(stateDir, 'cache_keepalive.lock');
  const avatarMemoryCache = new Map();
  let avatarHydratePromise = null;
  let lastAvatarHydrateAtMs = 0;

  function getAvatarCacheFilePath(emailOrScope) {
    const scopeKey = String(emailOrScope || '').startsWith('acct_')
      ? String(emailOrScope)
      : buildAccountScopeKey(emailOrScope);
    return path.join(avatarsDir, `${scopeKey}.datauri`);
  }

  function readCachedAvatarDataUri(emailOrScope) {
    const scopeKey = String(emailOrScope || '').startsWith('acct_')
      ? String(emailOrScope)
      : buildAccountScopeKey(emailOrScope);
    if (avatarMemoryCache.has(scopeKey)) return avatarMemoryCache.get(scopeKey);
    try {
      const fp = getAvatarCacheFilePath(scopeKey);
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, 'utf8').trim();
        if (isSafeDataImageUri(raw)) {
          avatarMemoryCache.set(scopeKey, raw);
          return raw;
        }
      }
    } catch { }
    return null;
  }

  function writeCachedAvatarDataUri(emailOrScope, dataUri) {
    if (!isSafeDataImageUri(dataUri)) return null;
    const scopeKey = String(emailOrScope || '').startsWith('acct_')
      ? String(emailOrScope)
      : buildAccountScopeKey(emailOrScope);
    const clean = String(dataUri).trim();
    avatarMemoryCache.set(scopeKey, clean);
    try {
      ensureDir(avatarsDir);
      const fp = getAvatarCacheFilePath(scopeKey);
      const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, clean, 'utf8');
      fs.renameSync(tmp, fp);
    } catch { }
    return clean;
  }

  async function resolveAndCacheAvatar(email, rawCandidate, opts = {}) {
    const clean = normalizeEmail(email);
    if (!clean) return null;
    if (isSafeDataImageUri(rawCandidate)) {
      return writeCachedAvatarDataUri(clean, rawCandidate);
    }
    const existingDisk = readCachedAvatarDataUri(clean);
    if (existingDisk && !opts.force) return existingDisk;
    if (typeof rawCandidate === 'string' && /^https?:\/\//i.test(rawCandidate.trim())) {
      const fetched = await fetchAvatarDataUriViaNode(rawCandidate.trim(), customFetch);
      if (fetched) return writeCachedAvatarDataUri(clean, fetched);
    }
    return existingDisk || null;
  }

  const debounceState = new Map(); // accountKey -> { firstSeenMs }
  const autoSwitchDiagThrottle = new Map(); // diagKey -> lastLoggedAtMs
  const inFlightAccountRefresh = new Map(); // normEmail -> Promise
  const accountRefreshBackoff = new Map(); // normEmail -> { untilMs, attempts, message, httpStatus }
  const accountRefreshStatus = new Map(); // accountScopeKey -> { state, updatedAtMs, lastSuccessAtMs, unchanged, retryAtMs, error, reason }
  let inFlightSwitch = null;

  function computeQuotaSnapshotSignature(snap) {
    if (!snap || !Array.isArray(snap.pools)) return '';
    return snap.pools
      .map(p => {
        const bSig = (Array.isArray(p.buckets) ? p.buckets : [])
          .map(b => `${b.windowKey || b.bucketId || ''}:${b.remainingFraction ?? 'n'}:${b.resetTimeIso || b.resetTime || ''}`)
          .sort()
          .join(',');
        return `${p.poolKey || ''}:${p.noPermission ? 1 : 0}:${p.remainingFraction ?? 'n'}:[${bSig}]`;
      })
      .sort()
      .join('|');
  }

  function setAccountRefreshStatus(emailOrScope, patch = {}) {
    const cleanEmail = normalizeEmail(emailOrScope);
    const scopeKey = cleanEmail ? buildAccountScopeKey(cleanEmail) : String(emailOrScope || '').trim();
    if (!scopeKey) return null;
    const prev = accountRefreshStatus.get(scopeKey) || {
      accountScopeKey: scopeKey,
      state: 'idle',
      updatedAtMs: 0,
      lastSuccessAtMs: null,
      unchanged: false,
      retryAtMs: null,
      error: null,
      reason: null
    };
    const next = { ...prev, ...patch, accountScopeKey: scopeKey };
    accountRefreshStatus.set(scopeKey, next);
    return next;
  }

  function getAccountRefreshStatus(emailOrScope) {
    const cleanEmail = normalizeEmail(emailOrScope);
    const scopeKey = cleanEmail ? buildAccountScopeKey(cleanEmail) : String(emailOrScope || '').trim();
    if (!scopeKey) return null;
    const cur = accountRefreshStatus.get(scopeKey);
    return cur ? { ...cur } : {
      accountScopeKey: scopeKey,
      state: 'idle',
      updatedAtMs: 0,
      lastSuccessAtMs: null,
      unchanged: false,
      retryAtMs: null,
      error: null,
      reason: null
    };
  }

  function logAutoSwitchDiag(store, stage, details = {}, minIntervalMs = 60000) {
    const key = `${stage}|${details.reason || ''}`;
    const now = Number(details.nowMs || Date.now());
    const last = autoSwitchDiagThrottle.get(key) || 0;
    if (minIntervalMs > 0 && (now - last) < minIntervalMs) return;
    autoSwitchDiagThrottle.set(key, now);
    try {
      const msgParts = [
        `stage=${stage}`,
        details.poolKey ? `pool=${details.poolKey}` : '',
        details.windowKey ? `win=${details.windowKey}` : '',
        details.syncState ? `sync=${details.syncState}` : '',
        details.remPct !== undefined && details.remPct !== null ? `rem=${details.remPct}%` : '',
        details.thresholdPct !== undefined && details.thresholdPct !== null ? `th=${details.thresholdPct}%` : '',
        details.candidateCount !== undefined ? `cands=${details.candidateCount}` : '',
        details.eligibleCount !== undefined ? `eligible=${details.eligibleCount}` : '',
        details.openWindowCount !== undefined ? `wins=${details.openWindowCount}` : '',
        details.reason ? `reason=${details.reason}` : ''
      ].filter(Boolean);
      recordDiag(store, {
        action: 'auto_switch',
        stage,
        ok: details.ok !== false,
        message: msgParts.join(' '),
        error: details.error || ''
      });
    } catch { }
  }

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

  function normalizeConsumedNoticeIds(rawList) {
    if (!Array.isArray(rawList)) return [];
    const seen = new Set();
    const out = [];
    for (const item of rawList) {
      const s = typeof item === 'string' ? item.trim() : '';
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out.slice(-50);
  }

  function resolveAutoSwitchNoticeKey(lr) {
    if (!lr || typeof lr !== 'object') return '';
    if (typeof lr.noticeId === 'string' && lr.noticeId.trim()) {
      return lr.noticeId.trim();
    }
    const at = lr.atMs ?? '';
    const ver = lr.verifiedAtMs ?? '';
    const dst = normalizeEmail(lr.toEmail || '') || String(lr.targetEmailMasked || '').trim();
    if (!at && !ver && !dst) return '';
    return `legacy:${at}:${ver}:${dst}`;
  }

  function loadStore() {
    const raw = readJsonSafe(storePath, null);
    if (!raw || typeof raw !== 'object') {
      return {
        version: 1,
        activeAccountEmail: null,
        accounts: {}, // email -> record
        deletedAccounts: {}, // email -> { deletedAtMs, scopeKey }
        autoSwitch: { ...DEFAULT_AUTO_SWITCH_CONFIG },
        autoSwitchStatus: {
          state: 'disabled', // disabled | watching | pending_debounce | waiting_idle | cooldown | switching | all_candidates_exhausted | error
          lastCheckAtMs: null,
          lastSwitchAtMs: 0,
          lastResult: null,
          lastError: null,
          blockedReason: null,
          consumedNoticeIds: []
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
    const deletedAccounts = {};
    if (raw.deletedAccounts && typeof raw.deletedAccounts === 'object' && !Array.isArray(raw.deletedAccounts)) {
      for (const [k, v] of Object.entries(raw.deletedAccounts)) {
        const cleanK = normalizeEmail(k);
        if (!cleanK) continue;
        deletedAccounts[cleanK] = {
          deletedAtMs: Number(v?.deletedAtMs || v || Date.now()),
          scopeKey: v?.scopeKey || buildAccountScopeKey(cleanK)
        };
      }
    }
    let normalizedAccounts = {};
    let inferredActiveEmail = raw.activeAccountEmail ? normalizeEmail(raw.activeAccountEmail) : null;
    if (Array.isArray(raw.accounts)) {
      for (const item of raw.accounts) {
        const cleanItemEmail = normalizeEmail(item?.email || '');
        if (!cleanItemEmail || deletedAccounts[cleanItemEmail]) continue;
        normalizedAccounts[cleanItemEmail] = {
          ...item,
          email: cleanItemEmail,
          accountScopeKey: item.accountScopeKey || buildAccountScopeKey(cleanItemEmail)
        };
        if (!inferredActiveEmail && item.isActive) inferredActiveEmail = cleanItemEmail;
      }
    } else if (raw.accounts && typeof raw.accounts === 'object') {
      for (const [k, item] of Object.entries(raw.accounts)) {
        const cleanItemEmail = normalizeEmail(item?.email || k);
        if (!cleanItemEmail || deletedAccounts[cleanItemEmail]) continue;
        normalizedAccounts[cleanItemEmail] = item;
      }
    }
    if (inferredActiveEmail && deletedAccounts[inferredActiveEmail]) {
      inferredActiveEmail = null;
    }
    const loaded = {
      version: 1,
      activeAccountEmail: inferredActiveEmail || null,
      accounts: normalizedAccounts,
      deletedAccounts,
      autoSwitch: { ...DEFAULT_AUTO_SWITCH_CONFIG, ...(raw.autoSwitch || {}) },
      autoSwitchStatus: {
        state: raw.autoSwitch?.enabled ? 'watching' : 'disabled',
        lastCheckAtMs: null,
        lastSwitchAtMs: 0,
        lastResult: null,
        lastError: null,
        blockedReason: null,
        ...(raw.autoSwitchStatus || {}),
        consumedNoticeIds: normalizeConsumedNoticeIds(raw.autoSwitchStatus?.consumedNoticeIds)
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

  function normalizeSnapshotForView(rawSnap) {
    if (!rawSnap || typeof rawSnap !== 'object') return null;
    if (!Array.isArray(rawSnap.pools)) return rawSnap;
    return {
      ...rawSnap,
      pools: rawSnap.pools.map((pl) => {
        if (!pl || typeof pl !== 'object') return pl;
        const resetIso = pl.resetTimeIso || pl.resetTime || null;
        const buckets = Array.isArray(pl.buckets)
          ? pl.buckets.map((b) => {
            if (!b || typeof b !== 'object') return b;
            const bReset = b.resetTimeIso || b.resetTime || null;
            return {
              ...b,
              resetTime: bReset,
              resetTimeIso: bReset
            };
          })
          : [];
        return {
          ...pl,
          resetTime: resetIso,
          resetTimeIso: resetIso,
          buckets
        };
      })
    };
  }

  function sanitizeAccountForView(rec, activeEmail) {
    if (!rec) return null;
    const scopeKey = rec.accountScopeKey || buildAccountScopeKey(rec.email);
    const rawTier = rec.tierName || rec.tierId || rec.quotaSnapshot?.planStatus?.tierName || null;
    const tierInfo = normalizeSubscriptionTierInfo(rawTier);
    const tierName = tierInfo.tierName || rawTier || null;
    const normSnap = normalizeSnapshotForView(rec.quotaSnapshot || null);
    const capabilities = deriveAccountCapabilities(normSnap, tierInfo.tierCode);
    const cachedAvatar = readCachedAvatarDataUri(scopeKey);
    const resolvedAvatar = cachedAvatar
      || (isSafeDataImageUri(rec.profilePictureUrl) ? writeCachedAvatarDataUri(scopeKey, rec.profilePictureUrl) : null)
      || (typeof rec.profilePictureUrl === 'string' && rec.profilePictureUrl.trim() ? rec.profilePictureUrl.trim() : null);
    return {
      accountId: scopeKey,
      email: rec.email,
      maskedEmail: maskEmail(rec.email),
      accountScopeKey: scopeKey,
      name: rec.name || rec.email.split('@')[0],
      profilePictureUrl: resolvedAvatar,
      source: rec.source || 'manual',
      oauthClientKey: rec.oauthClientKey || null,
      isActive: Boolean(activeEmail && normalizeEmail(activeEmail) === normalizeEmail(rec.email)),
      hasRefreshToken: Boolean(rec.credential?.refreshToken),
      expiresAt: rec.credential?.expiresAt || null,
      authInvalid: Boolean(rec.authInvalid),
      authError: rec.authError || null,
      suspended: Boolean(rec.suspended),
      suspendedReason: rec.suspendedReason || null,
      suspendedAtMs: rec.suspendedAtMs || null,
      supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
      tierId: rec.tierId || null,
      tierCode: tierInfo.tierCode || null,
      tierName,
      planLabel: tierName || null,
      capabilities,
      projectId: rec.projectId || null,
      quotaSnapshot: normSnap,
      quotaSource: rec.quotaSource || null,
      quotaTargetHost: rec.quotaTargetHost || null,
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
      profilePictureUrl: data.profilePictureUrl !== undefined ? (data.profilePictureUrl || null) : (prev.profilePictureUrl || null),
      source: data.source || prev.source || 'manual',
      credential: {
        accessToken: data.credential?.accessToken || prev.credential?.accessToken || '',
        refreshToken: data.credential?.refreshToken || prev.credential?.refreshToken || '',
        expiresAt: data.credential?.expiresAt || prev.credential?.expiresAt || null,
        idToken: data.credential?.idToken || prev.credential?.idToken || ''
      },
      projectId: data.projectId ?? prev.projectId ?? null,
      tierId: data.tierId ?? prev.tierId ?? null,
      tierName: data.tierName !== undefined ? (data.tierName || null) : (prev.tierName || null),
      suspended: data.suspended !== undefined ? Boolean(data.suspended) : Boolean(prev.suspended),
      suspendedReason: data.suspendedReason !== undefined ? (data.suspendedReason || null) : (prev.suspendedReason || null),
      suspendedAtMs: data.suspendedAtMs !== undefined ? data.suspendedAtMs : (prev.suspendedAtMs || null),
      actionEpoch: Number.isFinite(Number(data.actionEpoch)) ? Number(data.actionEpoch) : Number(prev.actionEpoch || 0),
      quotaSnapshot: data.quotaSnapshot !== undefined ? data.quotaSnapshot : (prev.quotaSnapshot || null),
      quotaSource: data.quotaSource !== undefined ? (data.quotaSource || null) : (prev.quotaSource || null),
      quotaTargetHost: data.quotaTargetHost !== undefined ? (data.quotaTargetHost || null) : (prev.quotaTargetHost || null),
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

  function isAccountDeleted(store, email) {
    const clean = normalizeEmail(email);
    return Boolean(clean && store?.deletedAccounts && store.deletedAccounts[clean]);
  }

  function clearAccountDeletionTombstone(store, email) {
    const clean = normalizeEmail(email);
    if (clean && store?.deletedAccounts && store.deletedAccounts[clean]) {
      delete store.deletedAccounts[clean];
    }
  }

  function markAccountSuspended(email, reason = 'ACCOUNT_SUSPENDED', opts = {}) {
    const clean = normalizeEmail(email);
    if (!clean) return { ok: false, error: '无效账号邮箱' };
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const store = loadStore();
    if (!store.accounts[clean] && isAccountDeleted(store, clean)) {
      return { ok: false, removed: true, error: '账号已被移除' };
    }
    const rec = store.accounts[clean] || upsertAccountRecord(store, { email: clean, source: 'host_detected', credential: {} });
    rec.suspended = true;
    rec.suspendedReason = String(reason || 'ACCOUNT_SUSPENDED').slice(0, 200);
    rec.suspendedAtMs = rec.suspendedAtMs || nowMs;
    rec.actionEpoch = Number(rec.actionEpoch || 0) + 1;
    // 立即停用该账号的保活任务，避免继续外发请求
    if (store.keepalive && normalizeEmail(store.keepalive.targetAccountEmail) === clean) {
      store.keepalive.enabled = false;
      store.keepaliveState = {
        ...(store.keepaliveState || {}),
        running: false,
        stopReason: 'account_suspended',
        blockedReason: 'account_suspended'
      };
      try { if (fs.existsSync(keepaliveLockPath)) fs.unlinkSync(keepaliveLockPath); } catch { }
    }
    for (const k of Array.from(debounceState.keys())) {
      if (k === clean || k.startsWith(`${clean}|`) || k.startsWith(`${clean}:`)) debounceState.delete(k);
    }
    saveStore(store);
    return {
      ok: true,
      suspended: true,
      supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
      account: sanitizeAccountForView(rec, store.activeAccountEmail)
    };
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
    let hostUserStatus = null;
    if (typeof getHostUserStatusFn === 'function') {
      try {
        const status = await getHostUserStatusFn();
        hostUserStatus = status?.userStatus || status || null;
        hostEmail = normalizeEmail(status?.email || status?.userStatus?.email || '');
      } catch (e) {
        const sus = detectAccountSuspendedSignal(e?.message || String(e || ''));
        if (sus) {
          const curSt = loadStore();
          if (curSt.activeAccountEmail) {
            markAccountSuspended(curSt.activeAccountEmail, sus.reason);
          }
        }
      }
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
    const switchStore = loadStore();
    const pending = switchStore.autoSwitchStatus.lastResult;
    if (pending?.restartPending) {
      const now = Date.now();
      const targetEmailNorm = normalizeEmail(pending.toEmail || '');
      const fromEmailNorm = normalizeEmail(pending.fromEmail || '');
      const isNewProcess = pending.pid !== process.pid;
      const elapsedSinceStartMs = now - Number(pending.atMs || 0);
      const verified = isNewProcess && Boolean(targetEmailNorm) && hostEmail === targetEmailNorm;
      const newProcessWrongAccount = isNewProcess && Boolean(hostEmail) && hostEmail !== targetEmailNorm && elapsedSinceStartMs >= 25000;
      const timedOut = elapsedSinceStartMs >= 120000;
      if (!verified && !newProcessWrongAccount && !timedOut) {
        const email = switchStore.activeAccountEmail || null;
        return { email, accountScopeKey: email ? buildAccountScopeKey(email) : null, switchInProgress: true };
      }
      if (verified) {
        closeActiveAccountSessions(switchStore, now);
        switchStore.activeAccountEmail = targetEmailNorm;
        if (switchStore.accounts[targetEmailNorm]) {
          switchStore.accounts[targetEmailNorm].lastUsedAtMs = now;
        }
        recordVerifiedAccountSession(switchStore, {
          email: targetEmailNorm,
          nowMs: now,
          source: 'desktop',
          evidence: 'account_switch_verified',
          forceNew: true
        });
        const maskedTarget = maskEmail(targetEmailNorm);
        const noticeId = pending.noticeId || `as_verified_${now}_${Math.random().toString(36).slice(2, 6)}`;
        switchStore.autoSwitchStatus = {
          ...switchStore.autoSwitchStatus,
          state: switchStore.autoSwitch?.enabled ? 'cooldown' : 'disabled',
          lastSwitchAtMs: now,
          blockedReason: null,
          blockedMeta: null,
          lastError: null,
          lastResult: {
            ...pending,
            restartPending: false,
            manualRestartRequired: false,
            ok: true,
            verifiedEffective: true,
            verifiedAtMs: now,
            targetEmailMasked: maskedTarget,
            noticeId,
            noticeConsumedAtMs: null,
            message: pending.trigger === 'auto_switch'
              ? `已自动切换至 ${maskedTarget}，重启后已通过 GetUserStatus 核验生效。`
              : `已切换至 ${maskedTarget}，客户端重启后已通过 GetUserStatus 核验生效。`
          }
        };
        debounceState.clear();
        saveStore(switchStore);
      } else {
        let rolledBack = Boolean(fromEmailNorm && hostEmail === fromEmailNorm);
        if (fromEmailNorm && switchStore.accounts[fromEmailNorm]?.credential?.refreshToken) {
          try {
            const origCred = switchStore.accounts[fromEmailNorm].credential;
            const rb = credStore.applyCredential({
              email: fromEmailNorm,
              name: switchStore.accounts[fromEmailNorm].name,
              accessToken: origCred.accessToken,
              refreshToken: origCred.refreshToken,
              expiresAt: origCred.expiresAt,
              idToken: origCred.idToken
            });
            rolledBack = Boolean(rb?.ok) || rolledBack;
          } catch { }
        }
        const failReason = newProcessWrongAccount
          ? `客户端重启后仍回报 ${hostEmail}，未切换至 ${targetEmailNorm || '目标账号'}${rolledBack ? '，已回滚原账号凭据' : ''}`
          : `客户端重启验证超时，未确认切换到 ${targetEmailNorm || '目标账号'}${rolledBack ? '，已回滚原账号凭据' : ''}`;
        const isAutoTrigger = String(pending.trigger || '').startsWith('auto');
        if (isAutoTrigger) {
          switchStore.autoSwitch.enabled = false;
        }
        switchStore.autoSwitchStatus = {
          ...switchStore.autoSwitchStatus,
          state: isAutoTrigger ? 'error' : (switchStore.autoSwitch?.enabled ? 'watching' : 'disabled'),
          blockedReason: null,
          blockedMeta: null,
          lastError: failReason,
          lastResult: {
            ...pending,
            restartPending: false,
            manualRestartRequired: false,
            ok: false,
            verifiedEffective: false,
            rolledBack,
            observedEmail: hostEmail || null,
            error: failReason
          }
        };
        saveStore(switchStore);
        if (!hostEmail) {
          return { email: switchStore.activeAccountEmail, accountScopeKey: null, skippedWrite: true };
        }
      }
    }
      if (resolved) {
        const store = switchStore;
        let dirty = false;
        if (store.activeAccountEmail !== resolved) {
          store.activeAccountEmail = resolved;
          dirty = true;
        }
        // 将宿主 GetUserStatus 的真实身份元数据（昵称、头像、Google 会员等级、停用信号）同步到当前账号记录
        if (hostUserStatus && (!hostEmail || hostEmail === resolved)) {
          const us = hostUserStatus;
          const prevAcc = store.accounts[resolved];
          const nextName = typeof us.name === 'string' && us.name.trim() ? us.name.trim() : null;
          const rawHostAvatar = us.profilePictureUrl || us.avatarUrl || us.photoUrl || us.picture || null;
          let nextAvatar = typeof rawHostAvatar === 'string' && rawHostAvatar.trim() ? rawHostAvatar.trim() : null;
          if (nextAvatar) {
            if (isSafeDataImageUri(nextAvatar)) {
              writeCachedAvatarDataUri(resolved, nextAvatar);
            } else if (/^https?:\/\//i.test(nextAvatar)) {
              const cached = await resolveAndCacheAvatar(resolved, nextAvatar);
              if (cached) nextAvatar = cached;
            }
          }
          const nextTierId = us.userTier?.id || us.planStatus?.planInfo?.teamsTier || null;
          const nextTierName = us.userTier?.name || us.planStatus?.planInfo?.planName || null;
          const susSig = detectAccountSuspendedSignal(us);
          if (prevAcc) {
            if (nextName && prevAcc.name !== nextName) { prevAcc.name = nextName; dirty = true; }
            if (nextAvatar && prevAcc.profilePictureUrl !== nextAvatar) { prevAcc.profilePictureUrl = nextAvatar; dirty = true; }
            if (nextTierId && prevAcc.tierId !== nextTierId) { prevAcc.tierId = nextTierId; dirty = true; }
            if (nextTierName && prevAcc.tierName !== nextTierName) { prevAcc.tierName = nextTierName; dirty = true; }
            if (susSig && !prevAcc.suspended) {
              prevAcc.suspended = true;
              prevAcc.suspendedReason = susSig.reason;
              prevAcc.suspendedAtMs = Date.now();
              prevAcc.actionEpoch = Number(prevAcc.actionEpoch || 0) + 1;
              dirty = true;
            }
          } else if (!isAccountDeleted(store, resolved)) {
            upsertAccountRecord(store, {
              email: resolved,
              name: nextName || resolved.split('@')[0],
              profilePictureUrl: nextAvatar,
              tierId: nextTierId,
              tierName: nextTierName,
              suspended: Boolean(susSig),
              suspendedReason: susSig ? susSig.reason : null,
              suspendedAtMs: susSig ? Date.now() : null,
              source: 'client_auto_detected',
              credential: {},
              lastUsedAtMs: Date.now()
            });
            dirty = true;
          }
        }
        if (hostEmail || dbEmail) {
          const nowMs = Date.now();
          const prevOpen = Array.isArray(store.accountSessions)
            ? store.accountSessions.find(s => s && s.endAtMs == null && normalizeEmail(s.email) === resolved)
            : null;
          const prevVerifiedAt = Number(prevOpen?.lastVerifiedAtMs || 0);
          recordVerifiedAccountSession(store, {
            email: resolved,
            nowMs,
            source: 'desktop',
            evidence: hostEmail ? 'host_user_status' : 'desktop_state_db'
          });
          if (!prevOpen || (nowMs - prevVerifiedAt) >= 60000) {
            dirty = true;
          }
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
      let rawAvatar = decodeJwtPicture(idToken) || '';
      if (typeof getHostUserStatusFn === 'function') {
        try {
          const hs = await getHostUserStatusFn();
          const hsUs = hs?.userStatus || hs || {};
          if (!email) email = normalizeEmail(hsUs?.email || '');
          if (!name && typeof hsUs?.name === 'string') name = hsUs.name.trim();
          const hsPic = hsUs?.profilePictureUrl || hsUs?.avatarUrl || hsUs?.photoUrl || hsUs?.picture || '';
          if (typeof hsPic === 'string' && hsPic.trim()) rawAvatar = hsPic.trim();
        } catch { }
      }
      if (!email && accessToken) {
        try {
          const info = await fetchGoogleUserInfo(accessToken, customFetch);
          if (!email) email = info.email;
          name = name || info.name;
          if (!rawAvatar && info.picture) rawAvatar = info.picture;
        } catch { }
      }
      if (!email) {
        return { ok: false, error: '已找到本地登录记录但未能识别所属邮箱，请在宿主原生入口重新登录后同步' };
      }

      const cachedAvatar = isSafeDataImageUri(rawAvatar)
        ? writeCachedAvatarDataUri(email, rawAvatar)
        : readCachedAvatarDataUri(email);
      const nowMs = Date.now();
      const store = loadStore();
      clearAccountDeletionTombstone(store, email);
      upsertAccountRecord(store, {
        email,
        name,
        ...(cachedAvatar ? { profilePictureUrl: cachedAvatar } : {}),
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
     * 探测本机只读外部工具数据目录（Antigravity Tools + Cockpit Tools v1.5.x 新旧目录与自定义根目录，软链接去重）
     */
    function discoverExternalToolsRoots() {
      const candidates = [];
      const pushCand = (dirPath, kind, label) => {
        if (!dirPath || typeof dirPath !== 'string') return;
        const trimmed = dirPath.trim();
        if (!trimmed) return;
        candidates.push({ dir: path.resolve(trimmed), kind, label });
      };

      pushCand(path.join(homeDir, '.antigravity_tools'), 'antigravity_tools', 'Antigravity Tools');

      const envCockpitDir = process.env.COCKPIT_TOOLS_DATA_DIR;
      if (envCockpitDir && !options.ignoreEnvToolsDir) {
        pushCand(envCockpitDir, 'cockpit_tools', 'Cockpit Tools');
      }
      const customRootJson = readJsonSafe(path.join(homeDir, '.cockpit_tools-data-root.json'), null);
      if (typeof customRootJson === 'string' && customRootJson.trim()) {
        pushCand(customRootJson.trim(), 'cockpit_tools', 'Cockpit Tools');
      } else if (customRootJson && typeof customRootJson === 'object') {
        const customPath = customRootJson.data_root || customRootJson.dataRoot || customRootJson.path || customRootJson.dir || '';
        if (typeof customPath === 'string' && customPath.trim()) {
          pushCand(customPath.trim(), 'cockpit_tools', 'Cockpit Tools');
        }
      }
      pushCand(path.join(homeDir, '.cockpit_tools'), 'cockpit_tools', 'Cockpit Tools');
      pushCand(path.join(homeDir, '.antigravity_cockpit'), 'cockpit_tools', 'Cockpit Tools');

      const seenReal = new Set();
      const roots = [];
      for (const c of candidates) {
        try {
          if (!fs.existsSync(c.dir) || !fs.statSync(c.dir).isDirectory()) continue;
          let real = c.dir;
          try { real = fs.realpathSync(c.dir); } catch { }
          const key = process.platform === 'win32' ? real.toLowerCase() : real;
          if (seenReal.has(key)) continue;
          seenReal.add(key);
          roots.push({ ...c, realDir: real });
        } catch { }
      }
      return roots;
    }

    function loadAes256KeyFile(keyPath) {
      try {
        if (!fs.existsSync(keyPath)) return null;
        const rawBuf = fs.readFileSync(keyPath);
        if (rawBuf.length === 32) return rawBuf;
        const text = rawBuf.toString('utf8').trim();
        if (!text) return null;
        const decoded = Buffer.from(text, 'base64');
        if (decoded.length === 32) return decoded;
        if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
        return null;
      } catch {
        return null;
      }
    }

    function decryptAes256GcmPayload(keyBuf, nonceB64, ciphertextB64) {
      if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
        throw new Error('密钥长度无效（需 32 字节）');
      }
      const nonce = Buffer.from(String(nonceB64 || ''), 'base64');
      const combined = Buffer.from(String(ciphertextB64 || ''), 'base64');
      if (nonce.length !== 12) throw new Error('GCM nonce 长度无效');
      if (combined.length < 16) throw new Error('密文长度不足');
      const authTag = combined.subarray(combined.length - 16);
      const ciphertext = combined.subarray(0, combined.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, nonce);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString('utf8');
    }

    function readExternalAccountDetail(rootDir, accountId) {
      const safeId = String(accountId || '').trim();
      if (!safeId || /[/\\]|\.\./.test(safeId)) return { detail: null, decryptError: null };
      const filePath = path.join(rootDir, 'accounts', `${safeId}.json`);
      const raw = readJsonSafe(filePath, null);
      if (!raw || typeof raw !== 'object') return { detail: null, decryptError: null };

      // 格式 3：Cockpit Tools 新版整文件 AES-256-GCM 加密信封
      if (raw.algorithm === 'AES-256-GCM' && raw.nonce && raw.ciphertext) {
        if (Number(raw.version || 1) !== 1) {
          return { detail: null, decryptError: `不支持的加密信封版本 v${raw.version}` };
        }
        const keyBuf = loadAes256KeyFile(path.join(rootDir, 'secure-account-storage.key'));
        if (!keyBuf) {
          return { detail: null, decryptError: '缺少或无法读取 secure-account-storage.key' };
        }
        try {
          const plainStr = decryptAes256GcmPayload(keyBuf, raw.nonce, raw.ciphertext);
          return { detail: JSON.parse(plainStr), decryptError: null, format: 'cockpit_envelope_v1' };
        } catch (err) {
          return { detail: null, decryptError: `整文件解密失败: ${err?.message || err}` };
        }
      }

      // 格式 2：Cockpit Tools 历史字段级加密 token_encrypted
      if (raw.token_encrypted && typeof raw.token_encrypted === 'object' && raw.token_encrypted.nonce && raw.token_encrypted.ciphertext) {
        if (Number(raw.token_encrypted.version || 1) !== 1) {
          return { detail: raw, decryptError: `不支持的 token_encrypted 版本 v${raw.token_encrypted.version}` };
        }
        const keyBuf = loadAes256KeyFile(path.join(rootDir, 'account-token.key'));
        if (!keyBuf) {
          return { detail: raw, decryptError: '缺少或无法读取 account-token.key' };
        }
        try {
          const plainStr = decryptAes256GcmPayload(keyBuf, raw.token_encrypted.nonce, raw.token_encrypted.ciphertext);
          const tokObj = JSON.parse(plainStr);
          return { detail: { ...raw, token: tokObj }, decryptError: null, format: 'cockpit_token_encrypted_v1' };
        } catch (err) {
          return { detail: raw, decryptError: `token 字段解密失败: ${err?.message || err}` };
        }
      }

      // 格式 1：明文 JSON
      return { detail: raw, decryptError: null, format: 'plaintext_json' };
    }

    function readExternalToolsIndex(rootInfo, report = null) {
      const byEmail = new Map();
      const addEntry = (item) => {
        const email = normalizeEmail(item?.email || '');
        if (!email) {
          if (report) {
            report.invalidCount = (report.invalidCount || 0) + 1;
            report.warnings.push(`${rootInfo.label}: 跳过缺少有效邮箱的损坏/无效记录`);
          }
          return;
        }
        const prev = byEmail.get(email);
        if (!prev || (!prev.id && item.id)) {
          byEmail.set(email, {
            id: String(item.id || ''),
            email,
            name: String(item.name || ''),
            disabled: Boolean(item.disabled),
            createdAt: item.createdAt ?? null,
            lastUsed: item.lastUsed ?? null,
            planType: item.planType || null,
            token: item.token || null,
            sourceKind: rootInfo.kind,
            sourceLabel: rootInfo.label,
            rootDir: rootInfo.dir
          });
        }
      };

      // 优先读取新版 SQLite 主索引 antigravity_accounts.sqlite（Node 22.5+ 内置 node:sqlite 只读查询）
      const sqlitePath = path.join(rootInfo.dir, 'antigravity_accounts.sqlite');
      if (fs.existsSync(sqlitePath)) {
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(sqlitePath, { readOnly: true });
          try {
            const rows = db.prepare('SELECT account_id, email, name, created_at, last_used, plan_type FROM summaries').all();
            for (const row of (rows || [])) {
              addEntry({
                id: row.account_id || row.id || '',
                email: row.email || '',
                name: row.name || '',
                createdAt: row.created_at ?? null,
                lastUsed: row.last_used ?? null,
                planType: row.plan_type || null
              });
            }
          } finally {
            try { db.close(); } catch { }
          }
        } catch (err) {
          if (report) report.errors.push(`${rootInfo.label} SQLite 索引损坏或无法读取: ${err?.message || err}`);
        }
      }

      // 兼容旧版/标准 accounts.json 索引
      const jsonPath = path.join(rootInfo.dir, 'accounts.json');
      if (fs.existsSync(jsonPath)) {
        let jsonIdx = null;
        try {
          jsonIdx = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (err) {
          if (report) report.errors.push(`${rootInfo.label} accounts.json 已损坏: ${err?.message || err}`);
        }
        if (jsonIdx !== null) {
          if (Array.isArray(jsonIdx.accounts)) {
            for (const a of jsonIdx.accounts) {
              if (!a || typeof a !== 'object') {
                if (report) {
                  report.invalidCount = (report.invalidCount || 0) + 1;
                  report.warnings.push(`${rootInfo.label}: 跳过非对象类型的无效记录`);
                }
                continue;
              }
              addEntry({
                id: a.id || a.account_id || '',
                email: a.email || '',
                name: a.name || '',
                disabled: Boolean(a.disabled),
                createdAt: a.created_at ?? null,
                lastUsed: a.last_used ?? null,
                planType: a.plan_type || null,
                token: a.token || null
              });
            }
          } else if (report) {
            report.errors.push(`${rootInfo.label} accounts.json 缺少有效的 accounts 数组`);
          }
        }
      }

      return Array.from(byEmail.values());
    }

    /**
     * 只读预览本机 Antigravity Tools 与 Cockpit Tools 中可用账号（绝不修改第三方文件）
     */
    function listAntigravityToolsAccounts() {
      const roots = discoverExternalToolsRoots();
      if (!roots.length) return { ok: true, available: false, count: 0, accounts: [] };
      const mergedByEmail = new Map();
      for (const r of roots) {
        const entries = readExternalToolsIndex(r);
        for (const e of entries) {
          if (!mergedByEmail.has(e.email)) mergedByEmail.set(e.email, e);
        }
      }
      const items = Array.from(mergedByEmail.values());
      return {
        ok: true,
        available: items.length > 0,
        count: items.length,
        roots: roots.map(r => ({ kind: r.kind, label: r.label })),
        accounts: items.map(({ id, email, name, disabled, createdAt, sourceKind, sourceLabel }) => ({
          id,
          email,
          name,
          disabled,
          createdAt,
          sourceKind,
          sourceLabel
        }))
      };
    }

    function convertToolsQuotaToSnapshot(detail, email) {
      const q = detail?.quota;
      if (!q || typeof q !== 'object') return null;
      const rawGroups = Array.isArray(q.quota_groups) ? q.quota_groups : [];
      const rawModels = Array.isArray(q.models) ? q.models : [];
      if (!rawGroups.length && !rawModels.length) return null;

      const summaryGroups = rawGroups.map((g, idx) => ({
        groupId: g.group_id || g.display_name || `tools-group-${idx}`,
        displayName: g.display_name || g.displayName || '',
        description: g.description || '',
        buckets: (Array.isArray(g.buckets) ? g.buckets : []).map((b, bIdx) => ({
          bucketId: b.bucket_id || b.bucketId || `bucket-${bIdx}`,
          window: b.window || '',
          remainingFraction: typeof b.remaining_fraction === 'number'
            ? b.remaining_fraction
            : (typeof b.remainingFraction === 'number'
              ? b.remainingFraction
              : (typeof b.remaining_percentage === 'number' ? Math.max(0, Math.min(1, b.remaining_percentage / 100)) : undefined)),
          windowDurationSeconds: b.window_duration_seconds || b.windowDurationSeconds || undefined,
          resetTime: b.reset_time || b.resetTime || ''
        }))
      }));

      const clientModelConfigs = rawModels
        .filter(m => m && m.name)
        .map(m => ({
          modelId: m.name,
          label: m.display_name || m.name,
          modelOrAlias: { model: m.model || m.name },
          quotaInfo: {
            remainingFraction: typeof m.percentage === 'number' ? Math.max(0, Math.min(1, m.percentage / 100)) : undefined,
            resetTime: m.reset_time || undefined
          }
        }));

      const tierInfo = normalizeSubscriptionTierInfo(q.subscription_tier || q.raw_tier || '');
      const updatedMs = Number.isFinite(Number(q.last_updated)) && Number(q.last_updated) > 0
        ? (Number(q.last_updated) > 1e12 ? Number(q.last_updated) : Number(q.last_updated) * 1000)
        : Date.now();

      const snap = buildModelQuotaSnapshot({
        userStatusRes: {
          userStatus: {
            email,
            planStatus: tierInfo.tierName ? { planInfo: { planName: tierInfo.tierName } } : undefined,
            cascadeModelConfigData: { clientModelConfigs }
          }
        },
        quotaSummaryRes: summaryGroups.length ? { groups: summaryGroups } : null,
        cascadeModelConfigs: clientModelConfigs,
        nowMs: updatedMs
      });

      return { snapshot: snap, updatedAtMs: updatedMs, tierInfo };
    }

    function importFromAntigravityTools(selectedEmails = null) {
      const roots = discoverExternalToolsRoots();
      if (!roots.length) {
        return { ok: false, error: '未发现 ~/.antigravity_tools 或 Cockpit Tools 账号索引' };
      }
      const filterSet = Array.isArray(selectedEmails) && selectedEmails.length
        ? new Set(selectedEmails.map(normalizeEmail).filter(Boolean))
        : null;

      const store = loadStore();
      const imported = [];
      const warnings = [];
      const indexReport = { errors: [], warnings: [], invalidCount: 0 };
      let credentialsImportedCount = 0;
      const seenEmails = new Set();

      for (const r of roots) {
        const entries = readExternalToolsIndex(r, indexReport);
        for (const meta of entries) {
          const email = normalizeEmail(meta?.email || '');
          if (!email || seenEmails.has(email)) continue;
          if (filterSet && !filterSet.has(email)) continue;
          if (!filterSet && isAccountDeleted(store, email)) continue;
          seenEmails.add(email);
          if (filterSet) clearAccountDeletionTombstone(store, email);

          const { detail, decryptError } = readExternalAccountDetail(r.dir, meta.id);
          if (decryptError) {
            warnings.push(`${maskEmail(email)}: ${decryptError}`);
          } else if (!detail && meta.id) {
            const detailPath = path.join(r.dir, 'accounts', `${meta.id}.json`);
            if (fs.existsSync(detailPath)) {
              warnings.push(`${maskEmail(email)}: 账号详情文件已损坏或无法解析`);
            }
          }

          const tok = detail?.token || meta?.token || {};
          const refreshToken = String(tok.refresh_token || detail?.refresh_token || '').trim();
          const accessToken = String(tok.access_token || detail?.access_token || '').trim();
          const idToken = String(tok.id_token || detail?.id_token || '').trim();
          const rawExpTs = tok.expiry_timestamp ?? detail?.expiry_timestamp ?? null;
          const expiresAt = tok.expiry
            || (Number.isFinite(Number(rawExpTs)) && Number(rawExpTs) > 0
              ? new Date(Number(rawExpTs) > 1e12 ? Number(rawExpTs) : Number(rawExpTs) * 1000).toISOString()
              : null);
          const hasCred = Boolean(refreshToken);
          if (hasCred) credentialsImportedCount += 1;

          const prev = store.accounts[email] || null;
          const toolsQuota = convertToolsQuotaToSnapshot(detail, email);
          const rawLastUsed = detail?.last_used ?? meta?.lastUsed ?? null;
          const lastUsedMs = Number.isFinite(Number(rawLastUsed)) && Number(rawLastUsed) > 0
            ? (Number(rawLastUsed) > 1e12 ? Number(rawLastUsed) : Number(rawLastUsed) * 1000)
            : null;
          const rawTier = detail?.quota?.subscription_tier || detail?.quota?.raw_tier || meta?.planType || null;
          const tierInfo = normalizeSubscriptionTierInfo(rawTier);
          const shouldAdoptToolsSnap = Boolean(
            toolsQuota?.snapshot
            && (!prev?.quotaSnapshot || !prev.lastQuotaUpdatedAtMs || toolsQuota.updatedAtMs > prev.lastQuotaUpdatedAtMs)
          );
          const susSig = detail?.quota?.is_forbidden ? detectAccountSuspendedSignal(detail?.quota?.forbidden_reason || '') : null;
          const toolsRawAvatar = detail?.profilePictureUrl || detail?.avatarUrl || detail?.photoUrl || detail?.picture || null;
          const safeLocalAvatar = isSafeDataImageUri(toolsRawAvatar) ? writeCachedAvatarDataUri(email, toolsRawAvatar) : null;

          upsertAccountRecord(store, {
            email,
            name: detail?.name || meta.name || email.split('@')[0],
            ...(safeLocalAvatar ? { profilePictureUrl: safeLocalAvatar } : {}),
            source: r.kind === 'cockpit_tools' ? 'cockpit_tools_import' : 'antigravity_tools_import',
            ...(hasCred ? {
              oauthClientKey: tok.oauth_client_key || (r.kind === 'cockpit_tools' ? 'antigravity_default' : 'antigravity_enterprise'),
              oauthClientId: tok.client_id || null,
              credential: { accessToken, refreshToken, expiresAt, idToken }
            } : {}),
            tierId: rawTier || undefined,
            tierName: tierInfo.tierName || undefined,
            ...(shouldAdoptToolsSnap ? { quotaSnapshot: toolsQuota.snapshot, lastQuotaUpdatedAtMs: toolsQuota.updatedAtMs } : {}),
            ...(lastUsedMs && (!prev?.lastUsedAtMs || lastUsedMs > prev.lastUsedAtMs) ? { lastUsedAtMs: lastUsedMs } : {}),
            ...(susSig ? { suspended: true, suspendedReason: susSig.reason, suspendedAtMs: Date.now() } : {}),
            authInvalid: false,
            authError: null
          });
          imported.push(email);
        }
      }
      const allWarnings = [...indexReport.errors, ...indexReport.warnings, ...warnings];
      const invalidCount = Number(indexReport.invalidCount || 0);
      if (imported.length === 0 && (indexReport.errors.length > 0 || invalidCount > 0 || warnings.length > 0)) {
        const errDetail = allWarnings[0] || 'Tools 数据损坏或无可导入有效账号';
        return {
          ok: false,
          credentialsImported: false,
          credentialsImportedCount: 0,
          importedCount: 0,
          invalidCount,
          warnings: allWarnings,
          error: `导入失败：${errDetail}`,
          message: `未导入有效账号：${errDetail}`,
          accounts: []
        };
      }
      if (imported.length > 0) saveStore(store);
      const warnSuffix = allWarnings.length > 0
        ? `；另有 ${allWarnings.length} 条异常/无效记录（${allWarnings[0]}）`
        : '';
      return {
        ok: imported.length > 0 || allWarnings.length === 0,
        partial: imported.length > 0 && allWarnings.length > 0,
        credentialsImported: credentialsImportedCount > 0,
        credentialsImportedCount,
        importedCount: imported.length,
        invalidCount,
        warnings: allWarnings,
        message: imported.length > 0
          ? `已从 Tools 导入 ${imported.length} 个账号${credentialsImportedCount > 0 ? `（含 ${credentialsImportedCount} 份可刷新/可切换凭据）` : ''}${warnSuffix}`
          : '未发现可导入的 Tools 账号记录',
        accounts: imported.map(e => sanitizeAccountForView(store.accounts[e], store.activeAccountEmail))
      };
    }

    /**
     * 兼容导入 Cockpit Tools 导出/迁移 JSON（schema: "cockpit-tools.data-transfer", version: 1）
     */
    function importFromCockpitBackupJson(rawData) {
      let data = rawData;
      if (typeof rawData === 'string') {
        try { data = JSON.parse(rawData); } catch (e) {
          return { ok: false, error: `JSON 解析失败: ${e?.message || e}` };
        }
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, error: '无效的 Cockpit Tools 导出数据' };
      }
      if (data.schema && data.schema !== 'cockpit-tools.data-transfer') {
        return { ok: false, error: `不支持的导出格式 schema: ${data.schema}` };
      }
      const list = data?.accounts?.platforms?.antigravity?.exported_data;
      if (!Array.isArray(list) || !list.length) {
        return { ok: false, error: '导出文件中未找到 Antigravity 账号数据' };
      }
      const store = loadStore();
      const imported = [];
      for (const item of list) {
        const email = normalizeEmail(item?.email || '');
        const refreshToken = String(item?.refresh_token || item?.token?.refresh_token || '').trim();
        if (!email || !refreshToken) continue;
        clearAccountDeletionTombstone(store, email);
        upsertAccountRecord(store, {
          email,
          name: item?.name || email.split('@')[0],
          source: 'cockpit_tools_backup',
          oauthClientKey: item?.oauth_client_key || item?.token?.oauth_client_key || 'antigravity_default',
          oauthClientId: item?.client_id || item?.token?.client_id || null,
          credential: {
            accessToken: String(item?.access_token || item?.token?.access_token || '').trim(),
            refreshToken,
            expiresAt: item?.expiry || null,
            idToken: String(item?.id_token || item?.token?.id_token || '').trim()
          },
          authInvalid: false,
          authError: null
        });
        imported.push(email);
      }
      saveStore(store);
      return {
        ok: imported.length > 0,
        credentialsImported: imported.length > 0,
        importedCount: imported.length,
        message: imported.length > 0 ? `已从 Cockpit Tools 备份导入 ${imported.length} 个账号` : '导出文件中无有效凭据账号',
        accounts: imported.map(e => sanitizeAccountForView(store.accounts[e], store.activeAccountEmail))
      };
    }

    let activeOAuthCancelFn = null;

    function cancelOAuthLogin() {
      if (typeof activeOAuthCancelFn === 'function') {
        const fn = activeOAuthCancelFn;
        activeOAuthCancelFn = null;
        try { fn(); } catch { }
        return { ok: true, cancelled: true, message: '已取消 OAuth 登录授权' };
      }
      return { ok: true, cancelled: false, message: '当前无进行中的 OAuth 登录' };
    }

    function openExternalUrlWithOsFallback(targetUrl) {
      if (!targetUrl || !/^https?:\/\//i.test(String(targetUrl))) return false;
      try {
        const electronMod = require('electron');
        if (electronMod && electronMod.shell && typeof electronMod.shell.openExternal === 'function') {
          Promise.resolve(electronMod.shell.openExternal(targetUrl)).catch(() => { });
          return true;
        }
      } catch { }
      try {
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          return true;
        }
        if (process.platform === 'darwin') {
          spawn('open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
          return true;
        }
        spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 启动 OAuth2 本地回环授权流程并添加账号（ELV-102：跨进程可靠拉起浏览器、支持取消/超时/重试、凭据落盘后不随初始配额失败回滚）
     */
    async function startOAuthLogin({ openExternal = options.openExternal || null, timeoutMs = 120000 } = {}) {
      if (typeof activeOAuthCancelFn === 'function') {
        cancelOAuthLogin();
      }
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
          const closeCallbackServer = () => {
            try { server?.close(); } catch { }
            try { server?.closeAllConnections?.(); } catch { }
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            activeOAuthCancelFn = null;
            closeCallbackServer();
            reject(attachStageErrorMeta(new Error('OAuth 授权超时（请重新点击登录添加后在浏览器完成授权）'), curStage, '127.0.0.1', null, null));
          }, timeoutMs);

          activeOAuthCancelFn = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            closeCallbackServer();
            const cancelErr = attachStageErrorMeta(new Error('已取消 OAuth 授权登录'), 'user_cancelled', '127.0.0.1', null, null);
            cancelErr.cancelled = true;
            reject(cancelErr);
          };

          const handleReq = (req, res) => {
            try {
              const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
              if (reqUrl.pathname === '/favicon.ico') {
                res.writeHead(204, { Connection: 'close' });
                res.end();
                return;
              }
              const errParam = reqUrl.searchParams.get('error');
              const codeParam = reqUrl.searchParams.get('code');
              const stParam = reqUrl.searchParams.get('state');
              if (errParam) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
                res.end('<html><body><h3>OAuth 授权失败</h3><p>您可以关闭此标签页。</p></body></html>');
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  closeCallbackServer();
                  reject(attachStageErrorMeta(new Error(`OAuth 拒绝或失败: ${errParam}`), 'loopback_callback', '127.0.0.1', 400, null));
                }
                return;
              }
              if (codeParam && stParam === stateStr) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
                res.end('<html><body><h3>✅ 授权回调已接收，正在返回 Antigravity Context Meter…</h3><script>setTimeout(()=>window.close(),1500)</script></body></html>');
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  closeCallbackServer();
                  resolve(codeParam);
                }
                return;
              }
              res.writeHead(400, { Connection: 'close' });
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
                prompt: 'select_account consent',
                state: stateStr
              });
              const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;
              if (typeof openExternal === 'function') {
                Promise.resolve(openExternal(authUrl)).catch(() => { });
              } else {
                openExternalUrlWithOsFallback(authUrl);
              }
            });
          };
          tryNextPort();
        });
      } catch (e) {
        activeOAuthCancelFn = null;
        if (e?.cancelled) {
          return { ok: false, cancelled: true, stage: 'user_cancelled', message: '已取消 OAuth 授权登录' };
        }
        return logFailAndReturn(e?.stage || curStage, e, { targetHost: '127.0.0.1', proxySource: 'loopback_direct' });
      }
      activeOAuthCancelFn = null;

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
      const normEmail = normalizeEmail(userInfo.email);
      let existedBefore = false;
      const oauthAvatarRaw = userInfo.picture || decodeJwtPicture(tokData.id_token || '') || null;
      const cachedOauthAvatar = oauthAvatarRaw ? await resolveAndCacheAvatar(normEmail, oauthAvatarRaw) : null;
      try {
        curStage = 'credential_persist';
        const store = loadStore();
        existedBefore = Boolean(store.accounts[normEmail]);
        clearAccountDeletionTombstone(store, normEmail);
        rec = upsertAccountRecord(store, {
          email: normEmail,
          name: userInfo.name,
          profilePictureUrl: cachedOauthAvatar || oauthAvatarRaw || null,
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
          message: `凭据已保存 (${maskEmail(normEmail)})`
        });
        saveStore(store);
      } catch (e) {
        return logFailAndReturn('credential_persist', e, { targetHost: 'local_store' });
      }

      // 阶段 6：拉取新账号初始配额（即使额度查询失败也保留账号并返回部分成功与重试状态）
      const quotaRes = await refreshAccountQuota(normEmail, { stage: 'initial_quota_fetch' });
      const freshStore = loadStore();
      const viewAccount = sanitizeAccountForView(freshStore.accounts[normEmail] || rec, freshStore.activeAccountEmail);
      if (!quotaRes.ok) {
        return {
          ok: true,
          quotaOk: false,
          updatedExisting: existedBefore,
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
        updatedExisting: existedBefore,
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
      clearAccountDeletionTombstone(store, cleanEmail);
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
      if (!store.deletedAccounts || typeof store.deletedAccounts !== 'object') {
        store.deletedAccounts = {};
      }
      store.deletedAccounts[clean] = {
        deletedAtMs: Date.now(),
        scopeKey: removedScopeKey
      };
      store.autoSwitch.candidates = (store.autoSwitch.candidates || []).filter(e => normalizeEmail(e) !== clean);

      // 清理该账号的在途刷新、退避、状态和头像缓存，防止异步回写复活
      inFlightAccountRefresh.delete(clean);
      accountRefreshBackoff.delete(clean);
      accountRefreshStatus.delete(removedScopeKey);
      avatarMemoryCache.delete(removedScopeKey);
      try {
        const avatarFile = getAvatarCacheFilePath(removedScopeKey);
        if (fs.existsSync(avatarFile)) fs.unlinkSync(avatarFile);
      } catch { }

      // 清理该账号相关的防抖计数；若移除了活跃账号则整组重置防抖，避免基于失效账号触发误切换
      for (const k of Array.from(debounceState.keys())) {
        if (k === clean || k.startsWith(`${clean}|`) || k.startsWith(`${clean}:`)) debounceState.delete(k);
      }

      if (wasActive) {
        store.activeAccountEmail = null;
        debounceState.clear();
        if (store.autoSwitchStatus && (store.autoSwitchStatus.state === 'waiting_idle' || store.autoSwitchStatus.state === 'pending_idle')) {
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
      const scopeKey = buildAccountScopeKey(clean);
      const store = loadStore();
      const rec = store.accounts[clean];
      const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
      if (!rec || isAccountDeleted(store, clean)) return { ok: false, status: 'error', error: '账号不存在' };
      if (rec.suspended && opts.explicitVerify !== true) {
        setAccountRefreshStatus(scopeKey, {
          state: 'suspended',
          updatedAtMs: nowMs,
          lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
          unchanged: false,
          retryAtMs: null,
          error: '该账号当前处于停用状态，已停止后台刷新，请前往官方支持页确认状态或点击手动重新核验',
          reason: 'account_suspended'
        });
        return {
          ok: false,
          status: 'suspended',
          suspended: true,
          skipped: true,
          lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
          supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
          error: '该账号当前处于停用状态，已停止后台刷新，请前往官方支持页确认状态或点击手动重新核验'
        };
      }

      // 01/02 退避检查：429 限流退避期间保留旧读数与原采样时间，不重复发远端请求
      const activeBackoff = accountRefreshBackoff.get(clean);
      if (activeBackoff && nowMs < activeBackoff.untilMs && opts.explicitVerify !== true && !opts.mockQuotaSnapshot) {
        const retryAfterMs = Math.max(0, activeBackoff.untilMs - nowMs);
        setAccountRefreshStatus(scopeKey, {
          state: 'backoff',
          updatedAtMs: nowMs,
          lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
          unchanged: false,
          retryAtMs: activeBackoff.untilMs,
          error: activeBackoff.message,
          reason: 'rate_limited_429'
        });
        return {
          ok: false,
          status: 'backoff',
          backoffActive: true,
          retryAfterMs,
          retryAtMs: activeBackoff.untilMs,
          lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
          account: sanitizeAccountForView(rec, store.activeAccountEmail),
          error: activeBackoff.message
        };
      }
      if (activeBackoff && nowMs >= activeBackoff.untilMs) {
        accountRefreshBackoff.delete(clean);
      }

      // 01/02 同账号在途去重：并发点击合并同一在途刷新，避免并发扫号或堆叠请求
      if (inFlightAccountRefresh.has(clean) && opts.explicitVerify !== true && !opts.mockQuotaSnapshot) {
        return inFlightAccountRefresh.get(clean);
      }

      // 当前活跃账号优先复用宿主快照（若宿主不可用且本地有 refreshToken 则平滑回退 CloudCode）；
      // 非活跃账号手动点击刷新直接走 CloudCode 拉取最新 Gemini/Claude/Argon 多池余量与倒计时
      const isCurrentActive = Boolean(store.activeAccountEmail && normalizeEmail(store.activeAccountEmail) === clean);
      const hostFetcher = typeof opts.fetchActiveHostSnapshot === 'function'
        ? opts.fetchActiveHostSnapshot
        : (typeof options.fetchActiveHostSnapshot === 'function' ? options.fetchActiveHostSnapshot : null);
      if (isCurrentActive && hostFetcher && !opts.mockQuotaSnapshot && !opts.forceCloudCode) {
        setAccountRefreshStatus(scopeKey, { state: 'refreshing', updatedAtMs: nowMs, error: null, reason: null });
        const hostRun = (async () => {
          try {
            const prevSig = computeQuotaSnapshotSignature(rec.quotaSnapshot);
            const hostRes = await hostFetcher({ email: clean, accountScopeKey: scopeKey, force: Boolean(opts.force), manual: opts.manual !== false, nowMs });
            const postHostStore = loadStore();
            if (!postHostStore.accounts[clean] || isAccountDeleted(postHostStore, clean)) {
              return { ok: false, status: 'error', error: '账号已被移除' };
            }
            if (hostRes && hostRes.ok && hostRes.snapshot) {
              const nextSig = computeQuotaSnapshotSignature(hostRes.snapshot);
              const unchanged = Boolean(prevSig && nextSig && prevSig === nextSig);
              const synced = syncActiveHostQuotaSnapshot(hostRes, clean, { nowMs });
              const updatedAt = hostRes.fetchedAtMs || nowMs;
              setAccountRefreshStatus(scopeKey, {
                state: unchanged ? 'unchanged' : 'updated',
                updatedAtMs: updatedAt,
                lastSuccessAtMs: updatedAt,
                unchanged,
                retryAtMs: null,
                error: null,
                reason: unchanged ? 'snapshot_unchanged' : 'host_snapshot_updated'
              });
              return {
                ok: true,
                status: unchanged ? 'unchanged' : 'updated',
                unchanged,
                source: 'host_local_snapshot',
                targetHost: null,
                fetchedAtMs: updatedAt,
                lastSuccessAtMs: updatedAt,
                account: synced
              };
            }
            if (!rec.credential?.refreshToken) {
              const errMsg = hostRes?.error || '未能从宿主读取最新额度快照，已保留上次读数';
              setAccountRefreshStatus(scopeKey, {
                state: hostRes?.backoffActive ? 'backoff' : 'error',
                updatedAtMs: nowMs,
                lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
                unchanged: false,
                retryAtMs: hostRes?.retryAtMs || null,
                error: errMsg,
                reason: hostRes?.errorKind || 'host_snapshot_failed'
              });
              return {
                ok: false,
                status: hostRes?.backoffActive ? 'backoff' : 'error',
                backoffActive: Boolean(hostRes?.backoffActive),
                retryAfterMs: hostRes?.retryAfterMs ?? null,
                retryAtMs: hostRes?.retryAtMs ?? null,
                lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
                account: sanitizeAccountForView(rec, store.activeAccountEmail),
                error: errMsg
              };
            }
            return null;
          } finally {
            inFlightAccountRefresh.delete(clean);
          }
        })();
        inFlightAccountRefresh.set(clean, hostRun);
        const hostOutcome = await hostRun;
        if (hostOutcome) return hostOutcome;
      }

      const startEpoch = Number(rec.actionEpoch || 0);
      setAccountRefreshStatus(scopeKey, {
        state: 'refreshing',
        updatedAtMs: nowMs,
        lastSuccessAtMs: rec.lastQuotaUpdatedAtMs || null,
        unchanged: false,
        retryAtMs: null,
        error: null,
        reason: null
      });

      const execRefresh = async () => {
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
        if (!targetRec || isAccountDeleted(freshStore, clean)) return { ok: false, status: 'error', error: '账号已被移除' };
        // 若请求期间账号被标记停用或状态代次已推进且非显式核验，立即丢弃迟到响应，避免覆盖停用状态
        if (opts.explicitVerify !== true && (targetRec.suspended || Number(targetRec.actionEpoch || 0) !== startEpoch)) {
          return {
            ok: false,
            status: 'stale_discarded',
            staleDiscarded: true,
            suspended: Boolean(targetRec.suspended),
            supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
            error: '账号状态已变更，已忽略迟到响应'
          };
        }

        const prevSnap = targetRec.quotaSnapshot || null;
        const prevAtMs = targetRec.lastQuotaUpdatedAtMs || null;
        const prevSig = computeQuotaSnapshotSignature(prevSnap);
        const nextSig = computeQuotaSnapshotSignature(quotaData.snapshot);
        const unchanged = Boolean(prevSig && nextSig && prevSig === nextSig);

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

        const resolvedQuotaSource = opts.mockQuotaSnapshot ? 'mock_snapshot' : 'cloudcode_direct';
        const resolvedTargetHost = quotaData.targetHost || null;
        targetRec.projectId = quotaData.projectId ?? targetRec.projectId;
        targetRec.tierId = quotaData.tierId ?? targetRec.tierId;
        targetRec.tierName = quotaData.tierName || quotaData.snapshot?.planStatus?.tierName || targetRec.tierName || null;
        targetRec.quotaSnapshot = quotaData.snapshot;
        targetRec.quotaSource = resolvedQuotaSource;
        targetRec.quotaTargetHost = resolvedTargetHost;
        targetRec.lastQuotaUpdatedAtMs = quotaData.fetchedAtMs || nowMs;
        targetRec.lastQuotaError = null;
        targetRec.lastQuotaErrorMeta = null;
        targetRec.authInvalid = false;
        targetRec.authError = null;
        if (opts.explicitVerify === true && targetRec.suspended) {
          targetRec.suspended = false;
          targetRec.suspendedReason = null;
          targetRec.suspendedAtMs = null;
        }
        accountRefreshBackoff.delete(clean);
        saveStore(freshStore);
        setAccountRefreshStatus(scopeKey, {
          state: unchanged ? 'unchanged' : 'updated',
          updatedAtMs: targetRec.lastQuotaUpdatedAtMs,
          lastSuccessAtMs: targetRec.lastQuotaUpdatedAtMs,
          unchanged,
          retryAtMs: null,
          error: null,
          reason: unchanged ? 'snapshot_unchanged' : 'snapshot_updated'
        });
        return {
          ok: true,
          status: unchanged ? 'unchanged' : 'updated',
          unchanged,
          source: resolvedQuotaSource,
          targetHost: resolvedTargetHost,
          fetchedAtMs: targetRec.lastQuotaUpdatedAtMs,
          lastSuccessAtMs: targetRec.lastQuotaUpdatedAtMs,
          account: sanitizeAccountForView(targetRec, freshStore.activeAccountEmail)
        };
      } catch (e) {
        const susSig = detectAccountSuspendedSignal(e?.message || e);
        if (susSig) {
          markAccountSuspended(clean, susSig.reason, { nowMs });
        }
        const httpStatusNum = Number(e?.httpStatus ?? e?.status ?? NaN);
        const is429 = httpStatusNum === 429 || /\b429\b|resource_exhausted|too many requests|rate[_\s-]?limit/i.test(String(e?.message || ''));
        let backoffUntil = null;
        if (is429) {
          const prevB = accountRefreshBackoff.get(clean);
          const attempts = prevB && nowMs < (prevB.untilMs + 120000) ? (prevB.attempts + 1) : 1;
          const expMs = Math.min(300000, 30000 * Math.pow(2, Math.min(4, attempts - 1)));
          const explicitMs = Number(e?.retryAfterMs ?? e?.retryAfterSec * 1000);
          const waitMs = Number.isFinite(explicitMs) && explicitMs > 0 ? Math.max(expMs, Math.min(600000, explicitMs)) : expMs;
          backoffUntil = nowMs + waitMs;
          accountRefreshBackoff.set(clean, {
            untilMs: backoffUntil,
            attempts,
            httpStatus: 429,
            message: '请求频率受限，已保留上次读数并进入退避等待'
          });
        }
        const freshStore = loadStore();
        const diagEntry = recordDiag(freshStore, {
          at: new Date().toISOString(),
          flow: 'refresh_quota',
          stage: e.stage || 'quota_fetch',
          targetHost: e.targetHost || 'cloudcode-pa.googleapis.com',
          httpStatus: Number.isFinite(httpStatusNum) ? httpStatusNum : null,
          proxySource: e.proxySource || null,
          proxyEndpoint: e.proxyEndpoint || null,
          errorCode: e.errorCode || e.code || null,
          error: e.message || String(e),
          emailMasked: maskEmail(clean)
        });
        const existingRec = freshStore.accounts[clean] || null;
        if (existingRec) {
          // 失败保留上次可信 quotaSnapshot 与 lastQuotaUpdatedAtMs
          existingRec.lastQuotaError = e.message;
          existingRec.lastQuotaErrorMeta = diagEntry;
          if (e.isAuthInvalid) {
            existingRec.authInvalid = true;
            existingRec.authError = e.message;
          }
          saveStore(freshStore);
        } else {
          saveStore(freshStore);
        }
        setAccountRefreshStatus(scopeKey, {
          state: susSig ? 'suspended' : (is429 ? 'backoff' : 'error'),
          updatedAtMs: nowMs,
          lastSuccessAtMs: existingRec?.lastQuotaUpdatedAtMs || null,
          unchanged: false,
          retryAtMs: backoffUntil,
          error: e.message,
          reason: susSig ? 'account_suspended' : (is429 ? 'rate_limited_429' : (e.isAuthInvalid ? 'auth_invalid' : 'refresh_failed'))
        });
        return {
          ok: false,
          status: susSig ? 'suspended' : (is429 ? 'backoff' : 'error'),
          backoffActive: Boolean(is429),
          retryAfterMs: backoffUntil ? Math.max(0, backoffUntil - nowMs) : null,
          retryAtMs: backoffUntil,
          lastSuccessAtMs: existingRec?.lastQuotaUpdatedAtMs || null,
          account: existingRec ? sanitizeAccountForView(existingRec, freshStore.activeAccountEmail) : null,
          error: e.message,
          stage: diagEntry.stage,
          targetHost: diagEntry.targetHost,
          httpStatus: diagEntry.httpStatus,
          diagnostics: diagEntry,
          authInvalid: Boolean(e.isAuthInvalid),
          suspended: Boolean(susSig),
          supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
          isClientMismatch: Boolean(e.isClientMismatch)
        };
      }
      };

      if (opts.mockQuotaSnapshot) {
        return execRefresh();
      }
      const p = execRefresh().finally(() => {
        if (inFlightAccountRefresh.get(clean) === p) {
          inFlightAccountRefresh.delete(clean);
        }
      });
      inFlightAccountRefresh.set(clean, p);
      return p;
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
        if (isAccountDeleted(store, clean)) return null;
        rec = upsertAccountRecord(store, {
          email: clean,
          name: hostQuotaResult.name || undefined,
          profilePictureUrl: hostQuotaResult.profilePictureUrl || null,
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
      rec.quotaSource = 'host_local_snapshot';
      rec.quotaTargetHost = null;
      rec.lastQuotaUpdatedAtMs = nowMs;
      rec.lastQuotaError = hostQuotaResult.error || null;
      if (!hostQuotaResult.error) rec.lastQuotaErrorMeta = null;
      if (hostQuotaResult.name && typeof hostQuotaResult.name === 'string') rec.name = hostQuotaResult.name;
      if (hostQuotaResult.profilePictureUrl && typeof hostQuotaResult.profilePictureUrl === 'string') {
        rec.profilePictureUrl = hostQuotaResult.profilePictureUrl;
      }
      const resolvedTierId = hostQuotaResult.userTier?.id || hostQuotaResult.planTierSummary?.tierId || hostQuotaResult.planStatus?.tierId || null;
      const resolvedTierName = hostQuotaResult.userTier?.name || hostQuotaResult.planTierSummary?.tierName || hostQuotaResult.planStatus?.tierName || hostQuotaResult.snapshot?.planStatus?.tierName || null;
      if (resolvedTierId) rec.tierId = resolvedTierId;
      if (resolvedTierName) rec.tierName = resolvedTierName;
      const susSig = detectAccountSuspendedSignal(hostQuotaResult);
      if (susSig) {
        rec.suspended = true;
        rec.suspendedReason = susSig.reason;
        rec.suspendedAtMs = rec.suspendedAtMs || nowMs;
        rec.actionEpoch = Number(rec.actionEpoch || 0) + 1;
      }
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
    if (ctx.productionGuard === true) {
      store.keepaliveState = { ...st, running: false, blockedReason: 'consumer_keepalive_disabled' };
      saveStore(store);
      return {
        ok: false,
        action: 'blocked',
        reason: 'consumer_keepalive_disabled',
        message: '消费版生产环境已停用缓存保活外发请求，仅保留历史状态展示与离线测试回归'
      };
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
      const callNowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
      const store = loadStore();
      const targetRec = store.accounts[cleanTarget];
      const pending = store.autoSwitchStatus.lastResult;
      if (pending?.restartPending && !pending?.manualRestartRequired && callNowMs - pending.atMs < 120000) {
        return { ok: false, busy: true, error: '正在等待客户端重启后验证账号切换' };
      }
      if (!targetRec) return { ok: false, error: `未在多账号列表中找到 ${cleanTarget}` };
      if (targetRec.suspended) {
        return {
          ok: false,
          suspended: true,
          supportUrl: GOOGLE_ANTIGRAVITY_SUPPORT_URL,
          error: `${maskEmail(cleanTarget)} 已被标记停用，请先前往官方支持页核实账号状态`
        };
      }
      if (!targetRec.credential?.refreshToken) {
        return {
          ok: false,
          needsNativeReauth: true,
          error: `${maskEmail(cleanTarget)} 缺少可切换凭据，请先通过官方登录重新授权或在客户端退出后重新登录`
        };
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
      return { ok: false, error: '另一 Antigravity 窗口正在执行切号，本窗口已跳过以防并发冲突', busy: true, locked: true };
    }

      let preSnap = null;
      const preStore = loadStore();
      const preActiveEmail = preStore.activeAccountEmail || null;
      const switchStartMs = callNowMs;
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

        // 3. 写入凭据前执行原子提交前核对（核实账号/空闲/单窗口/无未保存草稿等条件未发生变更）
        if (typeof opts.preCommitCheck === 'function') {
          const preWriteCheck = await opts.preCommitCheck({
            phase: 'before_credential_write',
            targetEmail: cleanTarget,
            preActiveEmail
          });
          if (preWriteCheck && preWriteCheck.ok === false) {
            return {
              ok: false,
              abortedBeforeWrite: true,
              deferred: Boolean(preWriteCheck.deferred),
              reason: preWriteCheck.reason || 'pre_commit_aborted',
              error: preWriteCheck.error || '提交切换前状态已变化，已取消写入凭据'
            };
          }
        }

        // 4. 保存切换前系统凭据快照用于失败回滚（仅在确认切换生效后才切割账本活跃时段）
        preSnap = credStore.captureSnapshot();

        // 5. 原子同步写入 OS 共享凭据、Desktop/IDE state.vscdb 及 CLI ~/.gemini
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
          finalizeFailureStore({ errMsg, rolledBack, verifiedEmail: '', atMs: callNowMs });
          return {
            ok: false,
            error: errMsg,
            rolledBack
          };
        }

        if (typeof opts.restartClient === 'function') {
          const noticeMeta = {
            ...(opts.switchContext || {}),
            fromEmailMasked: maskEmail(preActiveEmail),
            targetEmailMasked: maskEmail(cleanTarget),
            trigger: opts.trigger || 'manual',
            noticeId: opts.switchContext?.noticeId || `as_pre_${switchStartMs}`
          };
          if (typeof opts.onBeforeRestartNotice === 'function') {
            try {
              await opts.onBeforeRestartNotice(noticeMeta);
            } catch { }
            const noticeWaitMs = Number.isFinite(Number(opts.preRestartNoticeDelayMs))
              ? Math.max(0, Number(opts.preRestartNoticeDelayMs))
              : 0;
            if (noticeWaitMs > 0) {
              await new Promise(r => setTimeout(r, noticeWaitMs));
            }
          }
          if (typeof opts.preCommitCheck === 'function') {
            const preRestartCheck = await opts.preCommitCheck({
              phase: 'before_restart',
              targetEmail: cleanTarget,
              preActiveEmail,
              switchContext: noticeMeta
            });
            if (preRestartCheck && preRestartCheck.ok === false) {
              if (typeof opts.onAbortRestartNotice === 'function') {
                try { await opts.onAbortRestartNotice(preRestartCheck); } catch { }
              }
              const rb = credStore.restoreSnapshot(preSnap);
              const rolledBack = Boolean(rb?.ok !== false);
              const abortMsg = preRestartCheck.error || '发起客户端重启前状态已变化，已回滚凭据并取消重启';
              finalizeFailureStore({ errMsg: abortMsg, rolledBack, verifiedEmail: preActiveEmail || '', atMs: callNowMs });
              const restoreSt = loadStore();
              if (preRestartCheck.deferred && restoreSt.autoSwitch?.enabled) {
                restoreSt.autoSwitchStatus.state = 'waiting_idle';
                restoreSt.autoSwitchStatus.blockedReason = preRestartCheck.reason || 'pre_restart_aborted';
                restoreSt.autoSwitchStatus.lastError = null;
                saveStore(restoreSt);
              }
              return {
                ok: false,
                deferred: Boolean(preRestartCheck.deferred),
                rolledBack,
                reason: preRestartCheck.reason || 'pre_restart_aborted',
                error: abortMsg
              };
            }
          }
          const pendingStore = loadStore();
          if (pendingStore.autoSwitch?.enabled) {
            pendingStore.autoSwitchStatus.state = 'restarting';
          }
          pendingStore.autoSwitchStatus.blockedReason = null;
          pendingStore.autoSwitchStatus.blockedMeta = null;
          pendingStore.autoSwitchStatus.lastResult = {
            ok: false,
            restartPending: true,
            fromEmail: preActiveEmail,
            toEmail: cleanTarget,
            targetEmailMasked: maskEmail(cleanTarget),
            noticeId: noticeMeta.noticeId,
            poolKey: noticeMeta.poolKey || null,
            windowKey: noticeMeta.windowKey || null,
            metricMode: noticeMeta.metricMode || null,
            thresholdPct: noticeMeta.thresholdPct ?? null,
            currentRemPct: noticeMeta.currentRemPct ?? null,
            currentUsedPct: noticeMeta.currentUsedPct ?? null,
            atMs: switchStartMs,
            pid: process.pid,
            trigger: opts.trigger || 'manual'
          };
          pendingStore.autoSwitchStatus.lastError = null;
          saveStore(pendingStore);
          const result = await opts.restartClient();
          if (result?.cancelled) {
            const rb = credStore.restoreSnapshot(preSnap);
            const rolledBack = Boolean(rb?.ok !== false);
            const cancelMsg = '已取消重启客户端，已恢复原账号凭据';
            finalizeFailureStore({ errMsg: cancelMsg, rolledBack, verifiedEmail: preActiveEmail || '', atMs: Date.now() });
            const stRestore = loadStore();
            stRestore.autoSwitchStatus.state = stRestore.autoSwitch?.enabled ? 'watching' : 'disabled';
            stRestore.autoSwitchStatus.lastError = null;
            saveStore(stRestore);
            return { ok: false, cancelled: true, rolledBack, reason: 'user_cancelled_restart', message: cancelMsg };
          }
          if (!result?.supported || result.ok === false) throw new Error(result?.error || '当前客户端无法自动重启');
          return { ok: true, restartPending: true, verifiedEffective: false, message: '已准备切换账号，正在重启客户端' };
        }
        if (opts.requiresClientRestart) {
            if (opts.allowManualRestartPending && !String(opts.trigger || '').startsWith('auto')) {
              const isDeferAutoRestart = Boolean(opts.deferRestart && opts.canAutoRestart);
              const pendingStore = loadStore();
              pendingStore.autoSwitchStatus.lastResult = {
                ok: false,
                restartPending: true,
                manualRestartRequired: !isDeferAutoRestart,
                fromEmail: preActiveEmail,
                toEmail: cleanTarget,
                targetEmailMasked: maskEmail(cleanTarget),
                atMs: Date.now(),
                pid: process.pid,
                trigger: opts.trigger || 'manual'
              };
              pendingStore.autoSwitchStatus.lastError = null;
              saveStore(pendingStore);
              return {
                ok: true,
                restartPending: true,
                pendingRestart: true,
                deferRestart: isDeferAutoRestart,
                canAutoRestart: Boolean(opts.canAutoRestart),
                manualRestartRequired: !isDeferAutoRestart,
                targetEmail: cleanTarget,
                targetEmailMasked: maskEmail(cleanTarget),
                verifiedEffective: false,
                message: isDeferAutoRestart
                  ? '已写入目标账号凭据，即将重启客户端生效'
                  : '已写入目标账号凭据，请手动完全退出并重启 Antigravity 客户端后生效'
              };
            }
            const rb = credStore.restoreSnapshot(preSnap);
            const rolledBack = Boolean(rb?.ok !== false);
            const errMsg = opts.blockedRestartMessage || '当前运行模式无法自动重启客户端，已回滚原凭据';
            finalizeFailureStore({ errMsg, rolledBack, verifiedEmail: preActiveEmail || '', atMs: Date.now() });
            return { ok: false, rolledBack, reason: opts.blockedRestartReason || 'client_restart_unavailable', error: errMsg };
          }

          // 5. 重启语言服务使其加载新凭据
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
              blockedReason: null,
              blockedMeta: null,
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

          // 若 LS 未在校验时间内确认切换为目标邮箱（PR #96 / Issue #95）：
          // Antigravity 2.34+ 的语言服务凭据由 Electron 主进程在启动时经 host bridge 下发，
          // 仅重启语言服务不会加载新凭据 → 手动切号保留已写入凭据并进入待重启态，自动切号维持回滚行为。
          const isAutoTrigger = String(opts.trigger || '').startsWith('auto');
          const shouldPersist = isAutoTrigger
            ? Boolean(opts.persistOnVerifyMismatch)
            : Boolean(opts.persistOnVerifyMismatch || opts.allowManualRestartPending) && opts.rollbackOnVerifyMismatch !== true;
          let rolledBack = false;
          if (!shouldPersist && preSnap) {
            try {
              const rb = credStore.restoreSnapshot(preSnap);
              rolledBack = Boolean(rb?.ok !== false);
            } catch { }
          }
          let clientRelaunchScheduled = false;
          if (shouldPersist && opts.restartClientOnVerifyFail !== false) {
            try {
              const electronMod = (() => { try { return require('electron'); } catch { return null; } })();
              const app = electronMod && typeof electronMod === 'object' && electronMod.app && typeof electronMod.app.quit === 'function'
                ? electronMod.app
                : null;
              if (app) {
                clientRelaunchScheduled = true;
                const launcherCandidates = [
                  path.join(os.homedir(), 'Documents', 'MyFiles', 'agy-tool', '启动Antigravity.command')
                ];
                const launcher = launcherCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
                if (launcher) {
                  try {
                    spawn('/bin/bash', ['-c', `sleep 5; exec '${launcher.replace(/'/g, `'\\''`)}' >/dev/null 2>&1`], { detached: true, stdio: 'ignore' }).unref();
                  } catch { clientRelaunchScheduled = false; }
                }
                if (!clientRelaunchScheduled) {
                  setTimeout(() => {
                    try { app.relaunch(); app.quit(); } catch { }
                  }, 1500);
                } else {
                  setTimeout(() => {
                    try { app.quit(); } catch { }
                  }, 1500);
                }
              }
            } catch { }
          }
          const failErrMsg = shouldPersist
            ? `已写入 ${cleanTarget} 凭据。当前版本语言服务凭据由客户端启动时下发，仅重启语言服务不会生效${clientRelaunchScheduled ? '，客户端即将自动重启以完成切换' : '，请完全退出并重启 Antigravity 后自动生效（无需再次点击切换）'}。`
            : `凭据验证未生效，宿主暂未切换至 ${cleanTarget}${verifiedEmail ? `（当前仍回报 ${verifiedEmail}）` : ''}${rolledBack ? '，已自动回滚原凭据' : ''}。请重载或重启 Antigravity 客户端后重试。`;
          const savedFailStore = finalizeFailureStore({ errMsg: failErrMsg, rolledBack, verifiedEmail, atMs: nowMs });
          if (shouldPersist) {
            savedFailStore.activeAccountEmail = cleanTarget;
            savedFailStore.autoSwitchStatus = {
              ...savedFailStore.autoSwitchStatus,
              lastResult: {
                ...(savedFailStore.autoSwitchStatus?.lastResult || {}),
                ok: false,
                pendingRestart: true,
                restartPending: true,
                manualRestartRequired: !clientRelaunchScheduled,
                fromEmail: preActiveEmail,
                toEmail: cleanTarget,
                targetEmailMasked: maskEmail(cleanTarget),
                atMs: nowMs,
                pid: process.pid,
                trigger: opts.trigger || 'manual',
                rolledBack: false,
                error: failErrMsg
              }
            };
            saveStore(savedFailStore);
          }
          return {
            ok: false,
            verifiedEffective: false,
            rolledBack,
            lsRestarted,
            pendingRestart: shouldPersist,
            restartPending: shouldPersist,
            clientRelaunchScheduled,
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
      const prev = store.autoSwitch || DEFAULT_AUTO_SWITCH_CONFIG;
      const prevEnabled = Boolean(prev.enabled);
      const next = {
        ...prev,
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
        metricMode: patch.metricMode === 'used_pct' ? 'used_pct' : (patch.metricMode === 'remaining_pct' ? 'remaining_pct' : prev.metricMode),
        poolKey: patch.poolKey ? String(patch.poolKey).trim() : prev.poolKey,
        windowKey: ['primary', '5h', '7d', '24h'].includes(patch.windowKey) ? patch.windowKey : prev.windowKey,
        thresholdPct: patch.thresholdPct !== undefined && Number.isFinite(Number(patch.thresholdPct)) ? Math.max(1, Math.min(95, Number(patch.thresholdPct))) : prev.thresholdPct,
        debounceSec: patch.debounceSec !== undefined && Number.isFinite(Number(patch.debounceSec)) ? Math.max(0, Math.min(300, Number(patch.debounceSec))) : prev.debounceSec,
        cooldownSec: patch.cooldownSec !== undefined && Number.isFinite(Number(patch.cooldownSec)) ? Math.max(10, Math.min(3600, Number(patch.cooldownSec))) : prev.cooldownSec,
        waitUntilIdle: patch.waitUntilIdle !== undefined ? Boolean(patch.waitUntilIdle) : prev.waitUntilIdle,
        strategy: patch.strategy === 'candidate_order' ? 'candidate_order' : (patch.strategy === 'highest_quota' ? 'highest_quota' : prev.strategy),
        candidates: Array.isArray(patch.candidates)
          ? Array.from(new Set(patch.candidates.map(normalizeEmail).filter(Boolean)))
          : prev.candidates
      };
      const targetCheck = validateAutoSwitchQuotaTarget(next.poolKey, next.windowKey);
      if (next.enabled && !targetCheck.valid) {
        // 保留原有配置与候选账号，但阻止旧规则进入监控状态
        store.autoSwitchStatus = {
          ...(store.autoSwitchStatus || {}),
          state: 'blocked_legacy_rule',
          blockedReason: 'legacy_rule_needs_migration',
          blockedMeta: { poolKey: next.poolKey, windowKey: next.windowKey },
          needsRuleMigration: true
        };
        debounceState.clear();
        saveStore(store);
        return {
          ok: false,
          reason: 'legacy_rule_needs_migration',
          error: '当前规则使用了旧版监控池或未指定周期，请先从四项具体监控额度中选择一项并保存',
          autoSwitch: store.autoSwitch,
          autoSwitchStatus: store.autoSwitchStatus
        };
      }
      const ruleChanged = prev.poolKey !== next.poolKey
        || prev.windowKey !== next.windowKey
        || prev.metricMode !== next.metricMode
        || prev.thresholdPct !== next.thresholdPct
        || JSON.stringify(prev.candidates || []) !== JSON.stringify(next.candidates || []);
      store.autoSwitch = next;
      if (!next.enabled) {
        store.autoSwitchStatus.state = 'disabled';
        store.autoSwitchStatus.blockedReason = null;
        store.autoSwitchStatus.blockedMeta = null;
        store.autoSwitchStatus.needsRuleMigration = !targetCheck.valid;
        debounceState.clear();
      } else if (!prevEnabled || ruleChanged || store.autoSwitchStatus.state === 'blocked_legacy_rule') {
        store.autoSwitchStatus.state = 'watching';
        store.autoSwitchStatus.lastError = null;
        store.autoSwitchStatus.blockedReason = null;
        store.autoSwitchStatus.blockedMeta = null;
        store.autoSwitchStatus.needsRuleMigration = false;
        debounceState.clear();
      }
      saveStore(store);
      return { ok: true, autoSwitch: next, autoSwitchStatus: store.autoSwitchStatus };
    }

  /**
   * 精细提取目标池与窗口的剩余与已用额度百分比，保留精确浮点值用于阈值判断
   * 绝不将无权限、缺池、缺窗口、已过重置点或空快照视为 0% 触发切换
   */
  function inspectPoolMetric(quotaSnapshot, poolKey, windowKey = '5h') {
    if (!quotaSnapshot || !Array.isArray(quotaSnapshot.pools)) {
      return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_pool_missing_in_snapshot', poolKey, windowKey };
    }
    const pool = quotaSnapshot.pools.find(p => p && p.poolKey === poolKey);
    if (!pool) {
      return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_pool_missing_in_snapshot', poolKey, windowKey };
    }
    if (pool.noPermission || pool.status === 'no_permission') {
      return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_pool_no_permission', poolKey, windowKey };
    }
    const buckets = Array.isArray(pool.buckets) ? pool.buckets.filter(Boolean) : [];
    let targetBucket = null;
    if (windowKey === 'primary') {
      targetBucket = pool.primaryBucket || selectPrimaryQuotaBucket(buckets).primaryBucket;
      if (!targetBucket && buckets.length === 0) {
        if (pool.isResetPassed || pool.resetPassed) {
          return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_window_reset_passed', poolKey, windowKey };
        }
        if (pool.remainingFraction !== null && pool.remainingFraction !== undefined && Number.isFinite(Number(pool.remainingFraction))) {
          const numFrac = Number(pool.remainingFraction);
          const remPct = numFrac * 100;
          const usedPct = (1 - numFrac) * 100;
          return {
            ok: true,
            pct: remPct,
            remPct,
            usedPct,
            displayRemPct: Math.round(remPct),
            displayUsedPct: Math.round(usedPct),
            reason: null,
            poolKey,
            windowKey
          };
        }
      }
    } else {
      targetBucket = buckets.find(b =>
        String(b.windowShort || '').toLowerCase() === windowKey ||
        String(b.windowKey || '').toLowerCase() === windowKey ||
        (windowKey === '7d' && b.windowKey === 'weekly')
      ) || null;
      if (!targetBucket) {
        return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_window_unavailable', poolKey, windowKey };
      }
    }
    if (targetBucket && (targetBucket.isResetPassed || targetBucket.resetPassed)) {
      return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_window_reset_passed', poolKey, windowKey };
    }
    const frac = targetBucket ? targetBucket.remainingFraction : null;
    if (frac === null || frac === undefined || !Number.isFinite(Number(frac))) {
      return { ok: false, pct: null, remPct: null, usedPct: null, reason: 'target_pool_missing_value', poolKey, windowKey };
    }
    const numFrac = Number(frac);
    const remPct = numFrac * 100;
    const usedPct = (1 - numFrac) * 100;
    return {
      ok: true,
      pct: remPct,
      remPct,
      usedPct,
      displayRemPct: Math.round(remPct),
      displayUsedPct: Math.round(usedPct),
      reason: null,
      poolKey,
      windowKey
    };
  }

  function extractPoolMetricPct(quotaSnapshot, poolKey, windowKey = '5h') {
    const res = inspectPoolMetric(quotaSnapshot, poolKey, windowKey);
    return res.ok ? res.pct : null;
  }

  async function evaluateAutoSwitch(ctx = {}) {
    const nowMs = Number.isFinite(Number(ctx.nowMs)) ? Number(ctx.nowMs) : Date.now();
    const store = loadStore();
    const cfg = store.autoSwitch;
    const st = store.autoSwitchStatus;

    if (!cfg.enabled) {
      return { ok: true, action: 'noop', state: 'disabled' };
    }
    if (st.lastResult?.restartPending && Date.now() - st.lastResult.atMs < 120000) {
      return { ok: true, action: 'blocked', state: st.state, reason: 'client_restart_pending' };
    }
    if (isSwitchLockActive()) {
      return { ok: true, action: 'blocked', state: 'switching', reason: 'switch_lock_active' };
    }
    st.lastCheckAtMs = nowMs;

    // 0. 校验是否为合法的四项具体监控额度；旧规则保留配置但不允许自动评估
    const targetCheck = validateAutoSwitchQuotaTarget(cfg.poolKey, cfg.windowKey);
    if (!targetCheck.valid) {
      st.state = 'blocked_legacy_rule';
      st.blockedReason = 'legacy_rule_needs_migration';
      st.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey };
      st.needsRuleMigration = true;
      debounceState.clear();
      logAutoSwitchDiag(store, st.state, { poolKey: cfg.poolKey, windowKey: cfg.windowKey, reason: st.blockedReason, ok: false, nowMs });
      saveStore(store);
      return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state, blockedMeta: st.blockedMeta };
    }
    st.needsRuleMigration = false;

        const activeEmail = normalizeEmail(ctx.activeEmail || store.activeAccountEmail || '');
        const activeSnapshot = ctx.activeSnapshot || store.accounts[activeEmail]?.quotaSnapshot || null;
        if (!activeEmail || !activeSnapshot) {
          st.state = 'blocked_missing_account';
          st.blockedReason = 'no_active_account_or_snapshot';
          st.blockedMeta = { activeEmail: activeEmail || null };
          logAutoSwitchDiag(store, st.state, { reason: st.blockedReason, ok: false, nowMs });
          saveStore(store);
          return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state };
        }

    // 1. 数据过期 / 未知 / 错误 / 无权限：严格不触发
    const syncState = ctx.syncState || 'unknown';
    if (syncState !== 'fresh') {
      st.state = 'blocked_untrusted_quota';
      st.blockedReason = `quota_state_${syncState}`;
      st.blockedMeta = { syncState };
      debounceState.clear();
      logAutoSwitchDiag(store, st.state, { reason: st.blockedReason, syncState, ok: false, nowMs });
      saveStore(store);
      return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state };
    }

        const metric = inspectPoolMetric(activeSnapshot, cfg.poolKey, cfg.windowKey);
        if (!metric.ok) {
          st.state = 'blocked_missing_pool';
          st.blockedReason = metric.reason || 'target_pool_missing_in_snapshot';
          st.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey, reason: st.blockedReason };
          logAutoSwitchDiag(store, st.state, { poolKey: cfg.poolKey, windowKey: cfg.windowKey, reason: st.blockedReason, ok: false, nowMs });
          saveStore(store);
          return { ok: true, action: 'blocked', reason: st.blockedReason, state: st.state, blockedMeta: st.blockedMeta };
        }
        const remPct = metric.pct;
        const usedPct = Number.isFinite(metric.usedPct) ? metric.usedPct : (100 - remPct);

        const dbKey = `${activeEmail}|${cfg.poolKey}|${cfg.windowKey}`;
        // 用精确浮点百分比判断，等于阈值触发，显示取整绝不提前触发
        const triggered = cfg.metricMode === 'used_pct'
          ? (usedPct + AUTO_SWITCH_FLOAT_EPS >= cfg.thresholdPct)
          : (remPct - AUTO_SWITCH_FLOAT_EPS <= cfg.thresholdPct);
        if (!triggered) {
          // 额度重置或滚动恢复回到安全线以上：精准清理当前规则键并恢复 watching
          debounceState.delete(dbKey);
          st.state = 'watching';
          st.blockedReason = null;
          st.blockedMeta = null;
          saveStore(store);
          return { ok: true, action: 'ok_above_threshold', remainingPct: remPct, usedPct, state: 'watching' };
        }

        // 2. 冷却保护（优先检查，避免刚切完号又再次进入防抖）
        if (st.lastSwitchAtMs && (nowMs - st.lastSwitchAtMs) < cfg.cooldownSec * 1000) {
          st.state = 'cooldown';
          st.blockedReason = null;
          st.blockedMeta = null;
          logAutoSwitchDiag(store, 'cooldown', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, nowMs });
          saveStore(store);
          return { ok: true, action: 'cooldown', retryInSec: Math.ceil((st.lastSwitchAtMs + cfg.cooldownSec * 1000 - nowMs) / 1000), state: 'cooldown' };
        }

        // 3. 防抖保护（默认 15s）
        const dbEntry = debounceState.get(dbKey);
        if (!dbEntry) {
          debounceState.set(dbKey, { firstSeenMs: nowMs });
          if (cfg.debounceSec > 0) {
            st.state = 'pending_debounce';
            st.blockedReason = null;
            st.blockedMeta = null;
            logAutoSwitchDiag(store, 'pending_debounce', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, nowMs });
            saveStore(store);
            return { ok: true, action: 'pending_debounce', state: st.state, remainingPct: remPct, retryInSec: cfg.debounceSec };
          }
        } else if ((nowMs - dbEntry.firstSeenMs) < cfg.debounceSec * 1000) {
          const retryInSec = Math.max(1, Math.ceil((dbEntry.firstSeenMs + cfg.debounceSec * 1000 - nowMs) / 1000));
          st.state = 'pending_debounce';
          st.blockedReason = null;
          st.blockedMeta = null;
          logAutoSwitchDiag(store, 'pending_debounce', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, nowMs });
          saveStore(store);
          return { ok: true, action: 'pending_debounce', state: st.state, remainingPct: remPct, retryInSec };
        }

        // 4. 若当前正在生成或有未保存规则草稿，不静默中断，等待安全时机
        if (ctx.isGenerating && cfg.waitUntilIdle) {
          st.state = 'waiting_idle';
          st.blockedReason = 'generation_in_progress';
          st.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey };
          logAutoSwitchDiag(store, 'waiting_idle', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, reason: st.blockedReason, nowMs });
          saveStore(store);
          return { ok: true, action: 'waiting_idle', state: 'waiting_idle', reason: 'generation_in_progress' };
        }
        if (ctx.hasUnsavedDraft) {
          st.state = 'waiting_idle';
          st.blockedReason = 'unsaved_draft_present';
          st.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey };
          logAutoSwitchDiag(store, 'waiting_idle', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, reason: st.blockedReason, nowMs });
          saveStore(store);
          return { ok: true, action: 'waiting_idle', state: 'waiting_idle', reason: 'unsaved_draft_present' };
        }

        // 5. 筛选可用且充足的候选目标账号（当前账号与已停用账号不作为当次切换目标）
        const candidateEmails = (cfg.candidates || [])
          .map(normalizeEmail)
          .filter(e => e && e !== activeEmail && store.accounts[e] && !store.accounts[e].authInvalid && !store.accounts[e].suspended && store.accounts[e].credential?.refreshToken);

        // 消费版生产环境边界：只保留本地阈值提醒与历史状态记录，绝不后台自动派发切号、刷新非活跃候选或自动重启
        if (ctx.productionAlertOnly === true) {
          st.state = 'alert_only';
          st.blockedReason = 'consumer_auto_switch_disabled';
          st.blockedMeta = {
            poolKey: cfg.poolKey,
            windowKey: cfg.windowKey,
            remPct,
            usedPct,
            thresholdPct: cfg.thresholdPct,
            candidateCount: candidateEmails.length
          };
          logAutoSwitchDiag(store, 'alert_only', {
            poolKey: cfg.poolKey,
            windowKey: cfg.windowKey,
            remPct,
            thresholdPct: cfg.thresholdPct,
            candidateCount: candidateEmails.length,
            reason: 'consumer_auto_switch_disabled',
            ok: true,
            nowMs
          });
          saveStore(store);
          return {
            ok: true,
            action: 'alert_only',
            state: 'alert_only',
            reason: 'consumer_auto_switch_disabled',
            remainingPct: remPct,
            usedPct,
            candidateCount: candidateEmails.length
          };
        }

        if (candidateEmails.length === 0) {
          st.state = 'no_candidates';
          st.blockedReason = 'no_candidates_configured';
          st.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey, candidateCount: 0 };
          logAutoSwitchDiag(store, 'no_candidates', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, candidateCount: 0, reason: st.blockedReason, ok: false, nowMs });
          saveStore(store);
          return { ok: true, action: 'no_candidates', state: 'no_candidates', reason: 'no_candidates_configured' };
        }

        const initialRuleSig = JSON.stringify({
          poolKey: cfg.poolKey,
          windowKey: cfg.windowKey,
          metricMode: cfg.metricMode,
          thresholdPct: cfg.thresholdPct,
          candidates: Array.isArray(cfg.candidates) ? cfg.candidates : []
        });

        const maxStaleMs = Number.isFinite(Number(ctx.candidateMaxStaleMs)) ? Number(ctx.candidateMaxStaleMs) : 5 * 60 * 1000;
        if (ctx.skipCandidateRefresh !== true && (typeof customFetch === 'function' || ctx.allowLiveCandidateRefresh === true || !options.credentialStore)) {
          for (const ce of candidateEmails) {
            const curSnapStore = loadStore();
            const cRec = curSnapStore.accounts[ce];
            if (!cRec) continue;
            const cAgeMs = cRec.lastQuotaUpdatedAtMs ? (nowMs - cRec.lastQuotaUpdatedAtMs) : Infinity;
            if (!cRec.quotaSnapshot || cRec.lastQuotaError || cAgeMs > maxStaleMs) {
              try {
                await refreshAccountQuota(ce, { nowMs });
              } catch { }
            }
          }
        }

        const latestStore = loadStore();
        const latestCfg = latestStore.autoSwitch || {};
        const latestRuleSig = JSON.stringify({
          poolKey: latestCfg.poolKey,
          windowKey: latestCfg.windowKey,
          metricMode: latestCfg.metricMode,
          thresholdPct: latestCfg.thresholdPct,
          candidates: Array.isArray(latestCfg.candidates) ? latestCfg.candidates : []
        });
        if (!latestCfg.enabled) {
          return { ok: true, action: 'noop', state: 'disabled', reason: 'auto_switch_disabled' };
        }
        if (latestRuleSig !== initialRuleSig) {
          debounceState.clear();
          latestStore.autoSwitchStatus = {
            ...(latestStore.autoSwitchStatus || {}),
            state: 'watching',
            blockedReason: null,
            blockedMeta: null
          };
          logAutoSwitchDiag(latestStore, 'rule_changed_aborted', { poolKey: latestCfg.poolKey, windowKey: latestCfg.windowKey, reason: 'rule_changed_during_eval', ok: true, nowMs });
          saveStore(latestStore);
          return { ok: true, action: 'waiting_idle', state: 'watching', reason: 'rule_changed_during_eval' };
        }
        const latestStatus = latestStore.autoSwitchStatus || (latestStore.autoSwitchStatus = {});
        const eligible = [];
        for (const ce of candidateEmails) {
          const cRec = latestStore.accounts[ce];
          if (!cRec || cRec.authInvalid) continue;
          const cAgeMs = cRec.lastQuotaUpdatedAtMs ? (nowMs - cRec.lastQuotaUpdatedAtMs) : Infinity;
          if (cRec.lastQuotaError || cAgeMs > maxStaleMs) continue;
          const cMetric = inspectPoolMetric(cRec.quotaSnapshot, cfg.poolKey, cfg.windowKey);
          if (!cMetric.ok) continue;
          const cRem = cMetric.pct;
          const cUsed = Number.isFinite(cMetric.usedPct) ? cMetric.usedPct : (100 - cRem);
          const cStillLow = cfg.metricMode === 'used_pct'
            ? (cUsed + AUTO_SWITCH_FLOAT_EPS >= cfg.thresholdPct)
            : (cRem - AUTO_SWITCH_FLOAT_EPS <= cfg.thresholdPct);
          if (!cStillLow) {
            eligible.push({ email: ce, remainingPct: cRem, usedPct: cUsed });
          }
        }

        if (!eligible.length) {
          latestStatus.state = 'all_candidates_exhausted';
          latestStatus.blockedReason = 'all_candidates_insufficient_or_stale';
          latestStatus.blockedMeta = { poolKey: cfg.poolKey, windowKey: cfg.windowKey, candidateCount: candidateEmails.length };
          logAutoSwitchDiag(latestStore, 'all_candidates_exhausted', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, candidateCount: candidateEmails.length, eligibleCount: 0, reason: latestStatus.blockedReason, ok: false, nowMs });
          saveStore(latestStore);
          return { ok: true, action: 'all_candidates_exhausted', state: 'all_candidates_exhausted' };
        }

        if (cfg.strategy === 'highest_quota') {
          eligible.sort((a, b) => b.remainingPct - a.remainingPct);
        }
    const chosen = eligible[0];

    if (ctx.requiresClientRestart && typeof ctx.restartClient !== 'function') {
      latestStatus.state = 'waiting_idle';
      latestStatus.blockedReason = ctx.blockedRestartReason || 'client_restart_requires_idle_window';
      latestStatus.blockedMeta = {
        poolKey: cfg.poolKey,
        windowKey: cfg.windowKey,
        reason: latestStatus.blockedReason,
        openWindowCount: ctx.openWindowCount ?? null
      };
      logAutoSwitchDiag(latestStore, 'blocked_restart_guard', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, candidateCount: candidateEmails.length, eligibleCount: eligible.length, openWindowCount: ctx.openWindowCount ?? null, reason: latestStatus.blockedReason, ok: false, nowMs });
      saveStore(latestStore);
      return { ok: true, action: 'blocked', state: 'waiting_idle', reason: latestStatus.blockedReason };
    }

    latestStatus.state = 'switching';
    latestStatus.blockedReason = null;
    latestStatus.blockedMeta = null;
    logAutoSwitchDiag(latestStore, 'switching', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, remPct, thresholdPct: cfg.thresholdPct, candidateCount: candidateEmails.length, eligibleCount: eligible.length, nowMs }, 0);
    saveStore(latestStore);
    const switchContext = {
      poolKey: cfg.poolKey,
      windowKey: cfg.windowKey,
      metricMode: cfg.metricMode,
      thresholdPct: cfg.thresholdPct,
      currentRemPct: remPct,
      currentUsedPct: usedPct,
      displayRemPct: Math.round(remPct),
      displayUsedPct: Math.round(usedPct),
      targetEmailMasked: maskEmail(chosen.email),
      initialRuleSig,
      noticeId: `as_${nowMs}_${Math.random().toString(36).slice(2, 8)}`
    };
    const swRes = await (optsSwitchExecutor(ctx))(chosen.email, {
      trigger: 'auto_switch',
      restartClient: ctx.restartClient,
      requiresClientRestart: Boolean(ctx.requiresClientRestart),
      blockedRestartReason: ctx.blockedRestartReason,
      preCommitCheck: ctx.preCommitCheck,
      onBeforeRestartNotice: ctx.onBeforeRestartNotice,
      onAbortRestartNotice: ctx.onAbortRestartNotice,
      preRestartNoticeDelayMs: ctx.preRestartNoticeDelayMs,
      switchContext,
      nowMs,
      forceWhileBusy: !cfg.waitUntilIdle,
      restartLanguageServer: ctx.restartLanguageServer,
      skipTokenRefresh: ctx.skipTokenRefresh,
      assumeVerifiedInDryRun: ctx.assumeVerifiedInDryRun
    });

    const postStore = loadStore();
    if (!swRes.ok) {
      if (swRes.deferred) {
        postStore.autoSwitchStatus = {
          ...(postStore.autoSwitchStatus || {}),
          state: 'waiting_idle',
          blockedReason: swRes.reason || 'pre_commit_deferred',
          blockedMeta: { poolKey: cfg.poolKey, windowKey: cfg.windowKey, openWindowCount: ctx.openWindowCount ?? null },
          lastError: null
        };
        saveStore(postStore);
        return { ok: true, action: 'waiting_idle', state: 'waiting_idle', reason: swRes.reason || 'pre_commit_deferred' };
      }
      // 切换失败后停止循环并保留错误反馈（绝不连环重试烧毁其他账号）
      postStore.autoSwitch.enabled = false;
      postStore.autoSwitchStatus = {
        ...(postStore.autoSwitchStatus || {}),
        state: 'error',
        blockedReason: null,
        blockedMeta: null,
        lastError: swRes.error || '自动切号失败，已停止自动切换保护账号状态',
        lastResult: { ok: false, toEmail: chosen.email, atMs: nowMs, error: swRes.error }
      };
      logAutoSwitchDiag(postStore, 'switch_failed_halted', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, reason: swRes.reason || 'switch_failed', error: swRes.error, ok: false, nowMs }, 0);
      saveStore(postStore);
      return { ok: false, action: 'switch_failed_halted', targetEmail: chosen.email, error: swRes.error };
    }

    if (swRes.restartPending) {
      debounceState.clear();
      logAutoSwitchDiag(postStore, 'restart_pending', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, nowMs }, 0);
      return { ok: true, action: 'restart_pending', fromEmail: activeEmail, toEmail: chosen.email, switchResult: swRes };
    }

    // 成功切换后立刻收敛状态为 cooldown，避免状态滞留在 switching 或被同次条件重复触发
    postStore.autoSwitchStatus = {
      ...(postStore.autoSwitchStatus || {}),
      state: 'cooldown',
      lastSwitchAtMs: postStore.autoSwitchStatus?.lastSwitchAtMs || nowMs,
      lastError: null,
      blockedReason: null,
      blockedMeta: null
    };
    logAutoSwitchDiag(postStore, 'switched', { poolKey: cfg.poolKey, windowKey: cfg.windowKey, nowMs }, 0);
    saveStore(postStore);
    debounceState.clear();
    return { ok: true, action: 'switched', fromEmail: activeEmail, toEmail: chosen.email, targetRemainingPct: chosen.remainingPct, state: 'cooldown', switchResult: swRes };
  }

  function optsSwitchExecutor(ctx) {
    return typeof ctx.switchFn === 'function' ? ctx.switchFn : switchActiveAccount;
  }

  function ackAutoSwitchNotice(noticeId = null) {
    const store = loadStore();
    if (!store.autoSwitchStatus || typeof store.autoSwitchStatus !== 'object') {
      store.autoSwitchStatus = { state: store.autoSwitch?.enabled ? 'watching' : 'disabled', consumedNoticeIds: [] };
    }
    const existing = normalizeConsumedNoticeIds(store.autoSwitchStatus.consumedNoticeIds);
    const lr = store.autoSwitchStatus.lastResult || null;
    const explicit = typeof noticeId === 'string' ? noticeId.trim() : '';
    const fallbackKey = resolveAutoSwitchNoticeKey(lr);
    const targetId = explicit || fallbackKey;
    if (!targetId) {
      return { ok: true, consumed: false, noticeId: null, consumedNoticeIds: existing };
    }
    const nextList = normalizeConsumedNoticeIds([...existing, targetId]);
    store.autoSwitchStatus.consumedNoticeIds = nextList;
    if (lr && typeof lr === 'object') {
      const lrKey = resolveAutoSwitchNoticeKey(lr);
      if (lrKey === targetId || !lr.noticeId) {
        lr.noticeConsumedAtMs = lr.noticeConsumedAtMs || Date.now();
      }
    }
    saveStore(store);
    return { ok: true, consumed: true, noticeId: targetId, consumedNoticeIds: nextList };
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
    const targetCheck = validateAutoSwitchQuotaTarget(store.autoSwitch?.poolKey, store.autoSwitch?.windowKey);
    const rawAutoSwitchStatus = store.autoSwitchStatus || {};
    const consumedNoticeIds = normalizeConsumedNoticeIds(rawAutoSwitchStatus.consumedNoticeIds);
    let normalizedLastResult = rawAutoSwitchStatus.lastResult || null;
    if (normalizedLastResult && typeof normalizedLastResult === 'object') {
      const hasExplicitNoticeId = Boolean(
        typeof normalizedLastResult.noticeId === 'string' && normalizedLastResult.noticeId.trim()
      );
      const noticeKey = resolveAutoSwitchNoticeKey(normalizedLastResult);
      const isLegacyHistorical = Boolean(
        normalizedLastResult.trigger === 'auto_switch' &&
        normalizedLastResult.ok === true &&
        normalizedLastResult.verifiedEffective === true &&
        !hasExplicitNoticeId
      );
      const noticeConsumed = Boolean(
        normalizedLastResult.noticeConsumedAtMs ||
        isLegacyHistorical ||
        (noticeKey && consumedNoticeIds.includes(noticeKey))
      );
      normalizedLastResult = {
        ...normalizedLastResult,
        isLegacyNotice: isLegacyHistorical,
        noticeConsumed
      };
    }
    const isLegacyBlocked = !targetCheck.valid && Boolean(store.autoSwitch?.enabled)
      && !['error', 'switching', 'restarting'].includes(rawAutoSwitchStatus.state);
    const effectiveAutoSwitchStatus = {
      ...rawAutoSwitchStatus,
      consumedNoticeIds,
      lastResult: normalizedLastResult,
      needsRuleMigration: !targetCheck.valid,
      validTargetKey: targetCheck.valid ? targetCheck.targetKey : '',
      ...(isLegacyBlocked ? {
        state: 'blocked_legacy_rule',
        blockedReason: 'legacy_rule_needs_migration',
        blockedMeta: { poolKey: store.autoSwitch?.poolKey || '', windowKey: store.autoSwitch?.windowKey || '' }
      } : {})
    };
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
      autoSwitchStatus: effectiveAutoSwitchStatus,
      keepalive: store.keepalive,
      keepaliveState: store.keepaliveState,
      quotaIntervals: (store.quotaIntervals || []).slice().reverse(),
      sourceCapabilities: SOURCE_ATTRIBUTION_CAPABILITIES,
      protocolEvidence: ELV52_PROTOCOL_EVIDENCE
    };
  }

  async function hydrateMissingAvatars(opts = {}) {
    const nowMs = Date.now();
    const allowRemoteFetch = opts.allowRemoteFetch === true;
    if (!opts.force && avatarHydratePromise) return avatarHydratePromise;
    if (!opts.force && lastAvatarHydrateAtMs && (nowMs - lastAvatarHydrateAtMs) < 5 * 60 * 1000) {
      return { ok: true, skipped: true, updated: 0 };
    }
    const maxCount = Math.max(1, Math.min(12, Number(opts.limit) || 6));
    const run = async () => {
      lastAvatarHydrateAtMs = Date.now();
      const store = loadStore();
      const all = Object.values(store.accounts || {}).filter(Boolean);
      let updated = 0;
      let tried = 0;
      for (const rec of all) {
        if (tried >= maxCount) break;
        const clean = normalizeEmail(rec.email);
        if (!clean) continue;
        if (readCachedAvatarDataUri(clean)) continue;
        if (isSafeDataImageUri(rec.profilePictureUrl)) {
          writeCachedAvatarDataUri(clean, rec.profilePictureUrl);
          continue;
        }
        // 合规边界：默认仅复用本地安全 Data URI 缓存，严禁后台静默刷 OAuth Token 或调用 Google UserInfo 外发探测
        if (!allowRemoteFetch) continue;
        const picCandidate = (typeof rec.profilePictureUrl === 'string' && /^https?:\/\//i.test(rec.profilePictureUrl))
          ? rec.profilePictureUrl.trim()
          : '';
        if (!picCandidate || !isAllowedAvatarFetchUrl(picCandidate)) continue;
        tried += 1;
        const cached = await resolveAndCacheAvatar(clean, picCandidate);
        if (cached) {
          const freshStore = loadStore();
          if (freshStore.accounts[clean]) {
            freshStore.accounts[clean].profilePictureUrl = cached;
            saveStore(freshStore);
          }
          updated += 1;
        }
      }
      return { ok: true, updated, tried, remoteFetchAllowed: allowRemoteFetch };
    };
    avatarHydratePromise = run().finally(() => { avatarHydratePromise = null; });
    return avatarHydratePromise;
  }

  return {
    getPaths: () => ({ storePath, switchLockPath, keepaliveLockPath, avatarsDir }),
    loadStore,
    saveStore,
    getOverviewState,
    hydrateMissingAvatars,
    ackAutoSwitchNotice,
    detectCurrentActiveAccount,
    importFromCurrentClient,
    listAntigravityToolsAccounts,
    importFromAntigravityTools,
    importFromCockpitBackupJson,
    startOAuthLogin,
    cancelOAuthLogin,
    addAccountWithCredential,
    removeAccount,
    refreshAccountQuota,
    getAccountRefreshStatus,
    syncActiveHostQuotaSnapshot,
    markAccountSuspended,
    switchActiveAccount,
    inspectPoolMetric,
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
  try {
    const { discoverLiveDaemonHubs } = require('./local-api');
    const hubs = discoverLiveDaemonHubs({
      ...opts,
      allowDaemonFallback: true,
      isPidAlive: typeof opts.isPidAlive === 'function' ? opts.isPidAlive : defaultIsPidAlive
    });
    return hubs
      .filter(h => h && h.httpsOrigin && h.httpsPort)
      .map(h => ({
        origin: h.httpsOrigin,
        httpsPort: h.httpsPort,
        csrfToken: h.csrfToken,
        pid: h.pid,
        filePath: h.filePath || null,
        mtimeMs: h.mtimeMs
      }));
  } catch {
    return [];
  }
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

  const resolvedStateDir = opts.stateDir || opts.storageDir || getStateDir();
  const stateDirDiffers = Boolean(resolvedStateDir && resolvedStateDir !== sharedMgrStateDir);
  if (!sharedAccountsMgr || opts.forceNew || stateDirDiffers) {
    if (!opts.forceNew && resolvedStateDir) sharedMgrStateDir = resolvedStateDir;
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

async function dispatchAccountsAction(mgr, payload = {}, options = {}) {
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
    case 'import_cockpit_backup':
      return { ...mgr.importFromCockpitBackupJson(payload.data), overview: mgr.getOverviewState() };
    case 'oauth_login':
      return {
        ...(await mgr.startOAuthLogin({
          ...(typeof options.openExternal === 'function' ? { openExternal: options.openExternal } : {}),
          ...(Number.isFinite(Number(payload.timeoutMs)) ? { timeoutMs: Number(payload.timeoutMs) } : {})
        })),
        overview: mgr.getOverviewState()
      };
    case 'oauth_cancel':
      return { ...mgr.cancelOAuthLogin(), overview: mgr.getOverviewState() };
    case 'remove':
      return { ...mgr.removeAccount(payload.email), overview: mgr.getOverviewState() };
    case 'refresh_quota': {
      const targetEmail = payload.email ? normalizeEmail(payload.email) : '';
      const refreshExtraOpts = {
        explicitVerify: Boolean(payload.explicitVerify),
        force: Boolean(payload.force),
        manual: payload.manual !== false,
        ...(typeof options.fetchActiveHostSnapshot === 'function' ? { fetchActiveHostSnapshot: options.fetchActiveHostSnapshot } : {})
      };
      if (targetEmail) {
        const res = await mgr.refreshAccountQuota(targetEmail, refreshExtraOpts);
        return {
          ...res,
          ...(res.ok ? { message: res.unchanged ? `已核对 ${maskEmail(targetEmail)} 最新额度快照，当前数值无变化` : `已刷新 ${maskEmail(targetEmail)} 最新额度快照` } : {}),
          overview: mgr.getOverviewState()
        };
      }
      const st = mgr.getOverviewState();
      const results = [];
      let successCount = 0;
      let failCount = 0;
      let skippedSuspended = 0;
      let firstError = '';
      for (const acc of st.accounts) {
        if (acc.suspended) { skippedSuspended += 1; continue; }
        if (!acc.isActive && !acc.hasRefreshToken) continue;
        // 非当前账号仅在用户显式点击刷新时单次触发，绝不静默启动全扫
        const r = await mgr.refreshAccountQuota(acc.email, refreshExtraOpts);
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
          skippedSuspended,
          error: `额度刷新部分或全部失败，成功 ${successCount} 失败 ${failCount}，${firstError}`,
          results,
          overview: mgr.getOverviewState()
        };
      }
      return {
        ok: true,
        successCount,
        failCount: 0,
        skippedSuspended,
        message: successCount > 0 ? `已刷新 ${successCount} 个账号最新额度快照` : '当前无可刷新账号',
        results,
        overview: mgr.getOverviewState()
      };
    }
    case 'verify_account': {
      const targetEmail = payload.email ? normalizeEmail(payload.email) : '';
      if (!targetEmail) return { ok: false, error: '请指定待核验账号', overview: mgr.getOverviewState() };
      const verifyExtraOpts = {
        explicitVerify: true,
        ...(typeof options.fetchActiveHostSnapshot === 'function' ? { fetchActiveHostSnapshot: options.fetchActiveHostSnapshot } : {})
      };
      const res = await mgr.refreshAccountQuota(targetEmail, verifyExtraOpts);
      return { ...res, overview: mgr.getOverviewState() };
    }
    case 'mark_suspended': {
      const targetEmail = payload.email ? normalizeEmail(payload.email) : '';
      const res = mgr.markAccountSuspended(targetEmail, payload.reason || 'ACCOUNT_SUSPENDED');
      return { ...res, overview: mgr.getOverviewState() };
    }
    case 'switch': {
      return {
        ...(await mgr.switchActiveAccount(payload.email, {
          restartClient: options.restartClient,
          requiresClientRestart: Boolean(options.requiresClientRestart),
          allowManualRestartPending: Boolean(options.allowManualRestartPending),
          persistOnVerifyMismatch: Boolean(options.persistOnVerifyMismatch),
          deferRestart: Boolean(options.deferRestart),
          canAutoRestart: Boolean(options.canAutoRestart),
          forceWhileBusy: Boolean(payload.forceWhileBusy),
          ...(payload.verifyTimeoutMs != null ? { verifyTimeoutMs: payload.verifyTimeoutMs } : {})
        })),
        overview: mgr.getOverviewState()
      };
    }
    case 'update_auto_switch':
      return { ...mgr.updateAutoSwitchConfig(payload.config || {}), overview: mgr.getOverviewState() };
    case 'evaluate_auto_switch':
      return { ...(await mgr.evaluateAutoSwitch(payload.context || {})), overview: mgr.getOverviewState() };
    case 'ack_auto_switch_notice':
      return { ...mgr.ackAutoSwitchNotice(payload.noticeId || null), overview: mgr.getOverviewState() };
    case 'update_keepalive': {
      if (payload?.config?.enabled === true && options.allowKeepaliveInTest !== true) {
        return {
          ok: false,
          reason: 'consumer_keepalive_disabled',
          error: '消费版生产环境已停用缓存保活外发请求，避免产生额外背景流量',
          overview: mgr.getOverviewState()
        };
      }
      return { ...mgr.updateKeepaliveConfig(payload.config || {}), overview: mgr.getOverviewState() };
    }
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
  AUTO_SWITCH_QUOTA_TARGETS,
  validateAutoSwitchQuotaTarget,
  DEFAULT_AUTO_SWITCH_CONFIG,
  DEFAULT_KEEPALIVE_CONFIG,
  DEFAULT_SWITCH_VERIFY_TIMEOUT_MS,
  discoverDaemonHubOrigins,
  requestGetUserStatusDirect,
  normalizeEmail,
  buildAccountScopeKey,
  maskEmail,
  isSafeDataImageUri,
  normalizeGoogleAvatarUrl,
  fetchAvatarDataUriViaNode,
  decodeJwtPicture,
  deriveTrustedAutoSwitchQuotaContext,
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
  fetchJsonWithProxy,
  CLOUDCODE_DAILY_URL,
  CLOUDCODE_SANDBOX_URL,
  CLOUDCODE_PROD_URL,
  normalizeSubscriptionTierInfo,
  deriveAccountCapabilities,
  GOOGLE_ANTIGRAVITY_SUPPORT_URL,
  detectAccountSuspendedSignal,
  ANTIGRAVITY_OAUTH_SCOPES
};
