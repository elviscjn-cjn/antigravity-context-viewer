'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./meter-core');
const collector = require('./meter-collector');
const { getStateDir } = require('./asar-engine');
const { extractWorkspaceFromTranscriptFile } = require('./meter-cli-launcher');

function parseCliWindowString(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'm') return Math.round(num * 1024 * 1024);
  if (unit === 'k') return Math.round(num * 1000);
  return Math.round(num);
}

function formatCompactTokens(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '0';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return String(Math.round(num));
}

function getLocalDateKeys(now = new Date(), daysCount = 7) {
  const keys = [];
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(collector.formatLocalDateKey(d));
  }
  return new Set(keys);
}

function resolveAccountEmailMap(stateDir = null) {
  const map = new Map();
  try {
    const dir = stateDir || getStateDir();
    const acctPath = path.join(dir, 'accounts_v1.json');
    if (!fs.existsSync(acctPath)) return map;
    const raw = JSON.parse(fs.readFileSync(acctPath, 'utf8'));
    const accounts = raw?.accounts && typeof raw.accounts === 'object' ? Object.values(raw.accounts) : [];
    for (const a of accounts) {
      if (a?.accountScopeKey && a?.email) {
        map.set(a.accountScopeKey, String(a.email));
      }
    }
    const sessions = Array.isArray(raw?.accountSessions) ? raw.accountSessions : [];
    for (const s of sessions) {
      if (s?.accountScopeKey && s?.email && !map.has(s.accountScopeKey)) {
        map.set(s.accountScopeKey, String(s.email));
      }
    }
  } catch {}
  return map;
}

function resolvePeriodMatch(period, dateKey, now = new Date(), weekKeys = null) {
  const todayKey = collector.formatLocalDateKey(now);
  if (period === 'today') return dateKey === todayKey;
  if (period === 'month') return dateKey.startsWith(todayKey.slice(0, 7));
  if (period === 'week') {
    const set = weekKeys || getLocalDateKeys(now, 7);
    return set.has(dateKey);
  }
  return true;
}

function aggregateDailyMapForPeriod(dailyMap = {}, period = 'all', now = new Date()) {
  const weekKeys = period === 'week' ? getLocalDateKeys(now, 7) : null;
  let totalTokens = 0;
  let inputTokens = 0;
  let cacheTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let activeDays = 0;
  for (const [dayKey, rec] of Object.entries(dailyMap || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (!resolvePeriodMatch(period, dayKey, now, weekKeys)) continue;
    const tot = Number(rec.total || 0);
    const inp = Number(rec.input || 0);
    const cap = Number(rec.cache || 0);
    const out = Number(rec.output || 0);
    const st = Number(rec.steps || 0);
    if (tot > 0 || st > 0) activeDays += 1;
    totalTokens += tot;
    inputTokens += inp;
    cacheTokens += cap;
    outputTokens += out;
    steps += st;
  }
  return { totalTokens, inputTokens, cacheTokens, outputTokens, steps, activeDays };
}

function aggregateModelMapForPeriod(dailyModelMap = {}, modelMetaByKey = {}, period = 'all', modelQuery = null, now = new Date()) {
  const weekKeys = period === 'week' ? getLocalDateKeys(now, 7) : null;
  const q = modelQuery ? String(modelQuery).trim().toLowerCase() : null;
  const byModel = new Map();
  let totalTokens = 0;
  let inputTokens = 0;
  let cacheTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  const activeDaySet = new Set();

  const matchesModel = (mKey) => {
    if (!q) return true;
    const meta = modelMetaByKey?.[mKey] || {};
    const candidates = [
      mKey,
      meta.label,
      meta.family,
      ...(Array.isArray(meta.rawKeys) ? meta.rawKeys : []),
      ...(Array.isArray(meta.modelIds) ? meta.modelIds : [])
    ].filter(Boolean).map(v => String(v).toLowerCase());
    return candidates.some(c => c === q || c.includes(q));
  };

  for (const [dayKey, dayModels] of Object.entries(dailyModelMap || {})) {
    if (!resolvePeriodMatch(period, dayKey, now, weekKeys)) continue;
    if (!dayModels || typeof dayModels !== 'object') continue;
    for (const [mKey, rec] of Object.entries(dayModels)) {
      if (!rec || typeof rec !== 'object' || !matchesModel(mKey)) continue;
      const tot = Number(rec.total || 0);
      const inp = Number(rec.input || 0);
      const cap = Number(rec.cache || 0);
      const out = Number(rec.output || 0);
      const st = Number(rec.steps || 0);
      if (tot > 0 || st > 0) activeDaySet.add(dayKey);
      totalTokens += tot;
      inputTokens += inp;
      cacheTokens += cap;
      outputTokens += out;
      steps += st;

      const cur = byModel.get(mKey) || {
        modelKey: mKey,
        label: modelMetaByKey?.[mKey]?.label || mKey,
        totalTokens: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        steps: 0
      };
      cur.totalTokens += tot;
      cur.inputTokens += inp;
      cur.cacheTokens += cap;
      cur.outputTokens += out;
      cur.steps += st;
      byModel.set(mKey, cur);
    }
  }

  const models = Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    totals: {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      steps,
      activeDays: activeDaySet.size
    },
    models
  };
}

/**
 * ELV-58: 在终端查询累计 Token 消耗，读取口径与桌面面板保持严格一致
 */
async function queryCliUsage(options = {}) {
  const period = ['today', 'week', 'month', 'all'].includes(options.period) ? options.period : 'all';
  const accountQuery = options.account ? String(options.account).trim() : null;
  const modelQuery = options.model ? String(options.model).trim() : null;
  const now = options.now instanceof Date ? options.now : new Date();

  // 强制 CLI 查询只读，绝不回退写入或清理备份
  const history = options._history || await collector.collectTokenHistoryAsync({
    ...options,
    force: options.force !== false,
    readOnly: true
  });

  const emailMap = resolveAccountEmailMap(options.stateDir);
  if (history?.accountScopeKey && history?.currentAccountEmail) {
    emailMap.set(history.accountScopeKey, history.currentAccountEmail);
  }

  let selectedScope = null;
  let selectedAccountLabel = '全部账号 (含未归属)';
  let activeDailyMap = history.dailyMap || {};
  let activeDailyModelMap = history.dailyModelMapBySource?.all || {};
  let activeModelMeta = history.modelMetaByKey || {};
  let activeSourceBreakdown = {
    desktop: aggregateDailyMapForPeriod(history.dailyMapBySource?.desktop || {}, period, now).totalTokens,
    cli: aggregateDailyMapForPeriod(history.dailyMapBySource?.cli || {}, period, now).totalTokens,
    legacyUnallocated: aggregateDailyMapForPeriod(history.dailyMapBySource?.legacyUnallocated || {}, period, now).totalTokens
  };

  if (accountQuery) {
    const qLower = accountQuery.toLowerCase();
    if (qLower === 'unattributed' || qLower === '未归属') {
      const unattr = history.unattributedUsage || {};
      selectedScope = 'unattributed';
      selectedAccountLabel = '未归属 (unattributed)';
      activeDailyMap = unattr.dailyMap || {};
      activeDailyModelMap = unattr.dailyModelMapBySource?.all || {};
      activeModelMeta = unattr.modelMetaByKey || history.modelMetaByKey || {};
      activeSourceBreakdown = {
        desktop: aggregateDailyMapForPeriod(unattr.dailyMapBySource?.desktop || {}, period, now).totalTokens,
        cli: aggregateDailyMapForPeriod(unattr.dailyMapBySource?.cli || {}, period, now).totalTokens,
        legacyUnallocated: aggregateDailyMapForPeriod(unattr.dailyMapBySource?.legacyUnallocated || {}, period, now).totalTokens
      };
    } else {
      const accounts = history.usageByAccount || {};
      let matchedKey = null;
      for (const scopeKey of Object.keys(accounts)) {
        const email = (emailMap.get(scopeKey) || '').toLowerCase();
        if (scopeKey.toLowerCase() === qLower || (email && (email === qLower || email.includes(qLower)))) {
          matchedKey = scopeKey;
          break;
        }
      }
      if (!matchedKey) {
        return {
          ok: false,
          code: 'ACCOUNT_NOT_FOUND',
          error: `未找到匹配账号: ${accountQuery}`,
          availableAccounts: Object.keys(accounts).map(k => ({
            accountScopeKey: k,
            email: emailMap.get(k) || null,
            totalTokens: accounts[k]?.totalTokens || 0
          }))
        };
      }
      const acctObj = accounts[matchedKey];
      selectedScope = matchedKey;
      selectedAccountLabel = emailMap.get(matchedKey) ? `${emailMap.get(matchedKey)} (${matchedKey})` : matchedKey;
      activeDailyMap = acctObj.dailyMap || {};
      activeDailyModelMap = acctObj.dailyModelMapBySource?.all || {};
      activeModelMeta = acctObj.modelMetaByKey || history.modelMetaByKey || {};
      activeSourceBreakdown = {
        desktop: aggregateDailyMapForPeriod(acctObj.dailyMapBySource?.desktop || {}, period, now).totalTokens,
        cli: aggregateDailyMapForPeriod(acctObj.dailyMapBySource?.cli || {}, period, now).totalTokens,
        legacyUnallocated: aggregateDailyMapForPeriod(acctObj.dailyMapBySource?.legacyUnallocated || {}, period, now).totalTokens
      };
    }
  }

  const modelAgg = aggregateModelMapForPeriod(activeDailyModelMap, activeModelMeta, period, modelQuery, now);
  let totals;
  if (modelQuery) {
    totals = modelAgg.totals;
    if (modelAgg.models.length === 0) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `在当前统计范围内未找到匹配模型: ${modelQuery}`,
        period,
        account: selectedScope || 'all'
      };
    }
  } else if (!accountQuery && period === 'all') {
    totals = {
      totalTokens: history.summary?.grandTotalTokens || 0,
      inputTokens: history.summary?.totalInputTokens || 0,
      cacheTokens: history.summary?.totalCacheTokens || 0,
      outputTokens: history.summary?.totalOutputTokens || 0,
      steps: history.summary?.totalSteps || 0,
      activeDays: history.summary?.activeDaysCount || Object.keys(activeDailyMap).length
    };
  } else if (!accountQuery && period === 'today') {
    const todayKey = collector.formatLocalDateKey(now);
    const todayRec = activeDailyMap[todayKey] || {};
    totals = {
      totalTokens: history.summary?.todayTokens || 0,
      inputTokens: Number(todayRec.input || 0),
      cacheTokens: Number(todayRec.cache || 0),
      outputTokens: Number(todayRec.output || 0),
      steps: Number(todayRec.steps || 0),
      activeDays: (history.summary?.todayTokens || 0) > 0 ? 1 : 0
    };
  } else if (!accountQuery && period === 'month') {
    const mAgg = aggregateDailyMapForPeriod(activeDailyMap, 'month', now);
    totals = {
      totalTokens: history.summary?.monthTokens ?? mAgg.totalTokens,
      inputTokens: history.summary?.currentMonthInput ?? mAgg.inputTokens,
      cacheTokens: history.summary?.currentMonthCache ?? mAgg.cacheTokens,
      outputTokens: history.summary?.currentMonthOutput ?? mAgg.outputTokens,
      steps: mAgg.steps,
      activeDays: mAgg.activeDays
    };
  } else {
    totals = aggregateDailyMapForPeriod(activeDailyMap, period, now);
  }

  let referenceCostUSD = null;
  let referenceCostNote = null;
  if (!accountQuery && !modelQuery) {
    if (period === 'all' && Number.isFinite(history.costEstimate?.pricedCostUSD) && history.costEstimate?.pricedRequests > 0) {
      referenceCostUSD = history.costEstimate.pricedCostUSD;
      referenceCostNote = `已计价 ${history.costEstimate.pricedRequests} 次调用参考值 (按模型官方 API 单价)`;
    } else if (period === 'month' && Number.isFinite(history.costEstimateCurrentMonth?.pricedCostUSD) && history.costEstimateCurrentMonth?.pricedRequests > 0) {
      referenceCostUSD = history.costEstimateCurrentMonth.pricedCostUSD;
      referenceCostNote = `本月已计价 ${history.costEstimateCurrentMonth.pricedRequests} 次调用参考值`;
    }
  }

  const accountsSummary = Object.entries(history.usageByAccount || {}).map(([k, v]) => ({
    accountScopeKey: k,
    email: emailMap.get(k) || null,
    totalTokens: v.totalTokens || 0,
    todayTokens: v.todayTokens || 0,
    monthTokens: v.monthTokens || 0
  }));

  const resolvedLedgerPath = path.resolve(collector.getPricingLedgerPath(options.ledgerPath || options.agDir || null));

  return {
    ok: true,
    readOnly: options.readOnly !== false,
    period,
    account: selectedScope || 'all',
    accountLabel: selectedAccountLabel,
    modelFilter: modelQuery || null,
    ledgerPath: resolvedLedgerPath,
    firstUseDate: history.firstUseDate || null,
    updatedAt: history.updatedAt || null,
    totals,
    sourceBreakdown: modelQuery ? null : activeSourceBreakdown,
    topModels: modelAgg.models.slice(0, 10),
    referenceCostUSD,
    referenceCostNote,
    accounts: accountsSummary,
    unattributedTokens: history.unattributedUsage?.totalTokens || 0,
    sources: history.sources || null
  };
}

function formatCliUsageText(res) {
  if (!res || !res.ok) {
    return `查询失败. ${res?.error || '未知错误'}`;
  }
  const periodLabels = {
    today: '今日 (Today)',
    week: '近 7 天 (7d)',
    month: '本月 (Month)',
    all: '累计全部 (All)'
  };
  const lines = [
    `[Antigravity 用量统计] 周期: ${periodLabels[res.period] || res.period} | 账号: ${res.accountLabel}${res.modelFilter ? ` | 模型筛选: ${res.modelFilter}` : ''}`,
    `  总 Token: ${res.totals.totalTokens.toLocaleString('en-US')} (${formatCompactTokens(res.totals.totalTokens)}) | 输入: ${formatCompactTokens(res.totals.inputTokens)} | 缓存读取: ${formatCompactTokens(res.totals.cacheTokens)} | 输出: ${formatCompactTokens(res.totals.outputTokens)} | 步数: ${res.totals.steps} | 活跃天数: ${res.totals.activeDays}`
  ];
  if (res.sourceBreakdown) {
    lines.push(
      `  来源拆解: 桌面端 ${formatCompactTokens(res.sourceBreakdown.desktop)} | CLI ${formatCompactTokens(res.sourceBreakdown.cli)} | 历史未分来源 ${formatCompactTokens(res.sourceBreakdown.legacyUnallocated)}`
    );
  }
  if (res.referenceCostUSD !== null) {
    lines.push(`  参考费用: $${res.referenceCostUSD.toFixed(4)} (${res.referenceCostNote}. 仅作计价参考)`);
  }
  if (Array.isArray(res.topModels) && res.topModels.length > 0) {
    lines.push('  模型分布 (Top):');
    for (const m of res.topModels.slice(0, 6)) {
      lines.push(`    - ${m.label}: ${formatCompactTokens(m.totalTokens)} (输入 ${formatCompactTokens(m.inputTokens)}, 缓存 ${formatCompactTokens(m.cacheTokens)}, 输出 ${formatCompactTokens(m.outputTokens)}, ${m.steps} 步)`);
    }
  }
  lines.push(`  账本路径: ${res.ledgerPath} (只读模式: ${res.readOnly ? '是' : '否'})`);
  return lines.join('\n');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTranscriptTailSummary(transcriptPath) {
  const out = {
    cwd: null,
    lastStepAtMs: 0,
    lastModel: null,
    lastUsage: null,
    lastModelStep: null,
    subagentHits: 0,
    stepsCount: 0,
    userTurns: 0
  };
  try {
    if (!fs.existsSync(transcriptPath)) return out;
    const st = fs.statSync(transcriptPath);
    out.lastStepAtMs = Number(st.mtimeMs) || 0;
    out.cwd = extractWorkspaceFromTranscriptFile(transcriptPath);
    const size = Number(st.size) || 0;
    const readBytes = Math.min(size, 65536);
    const fd = fs.openSync(transcriptPath, 'r');
    let text = '';
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (size > readBytes && lines.length > 1) lines.shift();
    out.stepsCount = lines.length;
    for (const line of lines) {
      let obj = null;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'USER_INPUT' || obj.type === 'user_input' || obj.source === 'USER_EXPLICIT' || obj.role === 'user') {
        out.userTurns += 1;
      }
      if (obj.created_at) {
        const ts = Date.parse(obj.created_at);
        if (Number.isFinite(ts) && ts > out.lastStepAtMs) out.lastStepAtMs = ts;
      }
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (tc?.name === 'invoke_subagent') out.subagentHits += 1;
        }
      }
      const m = obj.model || obj.chatModel?.model || obj.metadata?.model;
      const mLabel = obj.chatModel?.modelDisplayName || obj.modelLabel || obj.metadata?.modelLabel || null;
      const reqModelRaw = obj.requestedModel || obj.requested_model || obj.metadata?.requestedModel?.model || obj.metadata?.requestedModel || obj.chatModel?.requestedModel?.model || obj.chatModel?.requestedModel || obj.chatModel?.modelOrAlias?.model || ((obj.chatModel?.model && obj.chatModel?.responseModel && obj.chatModel.model !== obj.chatModel.responseModel) ? obj.chatModel.model : null);
      const reqModelStr = typeof reqModelRaw === 'string' ? reqModelRaw.trim() : (reqModelRaw && typeof reqModelRaw === 'object' ? String(reqModelRaw.model || reqModelRaw.alias || '').trim() : '');
      if (typeof m === 'string' && m.trim()) out.lastModel = m.trim();

      // 提取 usage（兼容平铺蛇形/驼峰以及 obj.usage / obj.chatModel.usage）
      let inp = 0, cap = 0, outp = 0, tot = 0, hasUsage = false;
      const usage = obj.usage || obj.chatModel?.usage;
      if (usage && typeof usage === 'object') {
        inp = Number(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
        cap = Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cacheTokens ?? 0);
        outp = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? 0);
        tot = Number(usage.totalTokens ?? usage.total_tokens ?? (inp + cap + outp));
        hasUsage = true;
      } else if (
        obj.input_tokens !== undefined || obj.inputTokens !== undefined ||
        obj.output_tokens !== undefined || obj.outputTokens !== undefined
      ) {
        inp = Number(obj.input_tokens ?? obj.inputTokens ?? 0);
        cap = Number(obj.cache_read_tokens ?? obj.cacheReadTokens ?? obj.cache_tokens ?? obj.cacheTokens ?? 0);
        outp = Number(obj.output_tokens ?? obj.outputTokens ?? 0);
        tot = Number(obj.total_tokens ?? obj.totalTokens ?? (inp + cap + outp));
        hasUsage = true;
      }
      if (hasUsage && Number.isFinite(tot) && tot > 0) {
        out.lastUsage = { inputTokens: inp, cacheTokens: cap, outputTokens: outp, totalTokens: tot };
        const rawStatus = String(obj.status || '').toUpperCase();
        const isStreaming = rawStatus === 'RUNNING' || rawStatus === 'STREAMING' || rawStatus === 'IN_PROGRESS';
        const ttftRaw = obj.ttftSec ?? obj.ttft_sec ?? obj.chatModel?.ttftSec;
        const streamRaw = obj.streamingSec ?? obj.streaming_sec ?? obj.chatModel?.streamingSec;
        const durRaw = obj.durationSec ?? obj.duration_sec ?? obj.chatModel?.durationSec;
        const stepIdx = Number.isInteger(obj.step_index) ? obj.step_index : (Number.isInteger(obj.stepIndex) ? obj.stepIndex : null);
        out.lastModelStep = {
          stepIndex: stepIdx,
          responseId: obj.responseId || obj.response_id || null,
          ...(reqModelStr ? { requestedModel: reqModelStr } : {}),
          model: (typeof m === 'string' && m.trim()) ? m.trim() : out.lastModel,
          modelLabel: mLabel,
          inputTokens: inp,
          cacheTokens: cap,
          outputTokens: outp,
          totalTokens: tot,
          status: isStreaming ? 'streaming' : 'final',
          outcomeStatus: isStreaming ? 'streaming' : (obj.error ? 'failed' : 'success'),
          error: obj.error ? String(obj.error) : null,
          created_at: obj.created_at || null,
          timestamp: obj.created_at ? Date.parse(obj.created_at) : out.lastStepAtMs,
          ttftSec: (ttftRaw != null && Number.isFinite(Number(ttftRaw))) ? Number(ttftRaw) : null,
          streamingSec: (streamRaw != null && Number.isFinite(Number(streamRaw))) ? Number(streamRaw) : null,
          durationSec: (durRaw != null && Number.isFinite(Number(durRaw))) ? Number(durRaw) : null
        };
      }
    }
  } catch {}
  return out;
}

/**
 * 解析特定模型在 CLI 下的有效上下文偏好 (立即读取最新设置文件)
 * 兼容产品级键 (product:google:gemini-3.8-flash)、占位符 (MODEL_PLACEHOLDER_M318)、档位后缀 ((High)/-high) 与精确模型名
 */
const CLI_PLACEHOLDER_MODEL_ALIASES = {
  model_placeholder_m37: 'gemini-3.8-flash',
  model_placeholder_m318: 'gemini-3.8-flash',
  model_placeholder_m525: 'gemini-4-hydrogen',
  model_placeholder_m668: 'gemini-4-argon',
  model_placeholder_m670: 'gemini-4-carbon',
  model_placeholder_m104: 'gemini-4-carbon',
  model_placeholder_m105: 'gemini-4-argon',
  model_placeholder_m106: 'gemini-4-hydrogen'
};

function stripCliModelPrefixAndEffort(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^product:[a-z0-9_-]+:/i, '').trim();
  s = s.replace(/\s*\((?:low|medium|high|xhigh|minimal|thinking|extended|preview)\)\s*$/i, '').trim();
  s = s.replace(/[-_ ](?:low|medium|high|xhigh|minimal)$/i, '').trim();
  return s;
}

function normalizeCliModelMatchKey(raw) {
  const stripped = stripCliModelPrefixAndEffort(raw);
  const base = core.normalizeModelLookupName?.(stripped) || stripped.toLowerCase();
  return base.replace(/[.\s_-]+/g, ' ').trim();
}

function expandCliModelCandidates(modelInput) {
  const rawList = Array.isArray(modelInput) ? modelInput : [modelInput];
  const rawItems = rawList.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
  const exactLowers = [];
  const normKeys = [];
  const pushExact = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s && !exactLowers.includes(s)) exactLowers.push(s);
  };
  const pushNorm = (v) => {
    const s = normalizeCliModelMatchKey(v);
    if (s && !normKeys.includes(s)) normKeys.push(s);
  };

  for (const item of rawItems) {
    pushExact(item);
    const alias = CLI_PLACEHOLDER_MODEL_ALIASES[item.toLowerCase()];
    if (alias) {
      pushExact(alias);
      pushNorm(alias);
    }
    const normId = core.normalizeModelId?.(item);
    if (normId) {
      pushExact(normId);
      pushNorm(normId);
    }
    pushNorm(item);
  }

  if (rawItems.length > 0 && typeof core.groupModelProduct === 'function') {
    const labelCand = rawItems.find(v => !/^model_placeholder_/i.test(v)) || rawItems[0];
    const idCand = rawItems.find(v => /^model_/i.test(v)) || rawItems[0];
    try {
      const g = core.groupModelProduct({ modelId: idCand, label: labelCand });
      if (g?.productKey) {
        pushExact(g.productKey);
        pushNorm(g.productKey);
      }
      if (g?.productLabel) {
        pushNorm(g.productLabel);
      }
    } catch {}
  }

  return {
    primaryRaw: rawItems[0] || '',
    exactLowers,
    normKeys
  };
}

function resolveCliModelContextBudget(modelInput, options = {}) {
  const hasCustomPlan = (dir) => Boolean(dir && fs.existsSync(path.join(dir, 'custom_plan_v1.json')));
  const homeAgDir = options.homeDir ? path.join(options.homeDir, '.gemini', 'antigravity') : '';
  const prefDir = hasCustomPlan(options.agDir)
    ? options.agDir
    : (hasCustomPlan(options.stateDir)
      ? options.stateDir
      : (hasCustomPlan(homeAgDir) ? homeAgDir : (options.agDir || options.stateDir || '')));
  const settingsSnap = collector.getPluginSettings(prefDir ? { targetDir: prefDir } : {});
  const prefs = settingsSnap?.contextPreferences || {};
  const unified = settingsSnap?.contextUnifiedPreference || null;
  const { primaryRaw: modelStr, exactLowers, normKeys } = expandCliModelCandidates(modelInput);

  // 1. 优先匹配精确键名（如单独设置了 gemini-4-hydrogen-high），再按规范化产品键名匹配（如 product:google:gemini-3.8-flash）
  let matchedPref = null;
  let matchedKey = null;
  for (const [k, pref] of Object.entries(prefs)) {
    if (!pref || typeof pref !== 'object') continue;
    const kLower = String(k).trim().toLowerCase();
    if (exactLowers.includes(kLower)) {
      matchedPref = pref;
      matchedKey = k;
      break;
    }
  }
  if (!matchedPref) {
    for (const [k, pref] of Object.entries(prefs)) {
      if (!pref || typeof pref !== 'object') continue;
      const kNorm = normalizeCliModelMatchKey(k);
      if (kNorm && normKeys.includes(kNorm)) {
        matchedPref = pref;
        matchedKey = k;
        break;
      }
    }
  }

  // 仅当明确处于统一模式（contextScopeMode === 'unified'）且未命中单模型偏好时，才应用统一偏好
  const scopeMode = settingsSnap?.contextScopeMode || 'per_model';
  if (!matchedPref && scopeMode === 'unified' && unified && unified.mode && unified.mode !== 'default') {
    matchedPref = unified;
    matchedKey = 'unified';
  }

  const cliSettingsPath = options.cliSettingsPath || path.join(
    options.agCliDir || path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity-cli'),
    'settings.json'
  );
  const cliSettings = options.includeCliSettings === false ? null : readJsonSafe(cliSettingsPath);
  const cliSettingsLimit = options.includeCliSettings === false ? null : parseCliWindowString(cliSettings?.contextWindow);

  let budgetTokens = null;
  let budgetSource = null;

  if (matchedPref) {
    if (matchedPref.mode === 'fixed' && Number.isFinite(Number(matchedPref.limitTokens)) && Number(matchedPref.limitTokens) > 0) {
      budgetTokens = Number(matchedPref.limitTokens);
      budgetSource = `per_model_pref:${matchedKey}`;
    } else if (matchedPref.mode === 'default') {
      budgetTokens = 128000;
      budgetSource = `per_model_pref:${matchedKey}`;
    } else if (matchedPref.mode === 'dynamic') {
      budgetTokens = cliSettingsLimit || null;
      budgetSource = `per_model_pref:${matchedKey}:dynamic`;
    }
  }

  if (!budgetTokens && cliSettingsLimit) {
    budgetTokens = cliSettingsLimit;
    budgetSource = 'cli_settings_contextWindow';
  }

  if (!budgetTokens && modelStr) {
    try {
      const b = core.getModelContextBudget?.(modelStr, options.cascadeModelConfigs || null);
      if (b && Number.isFinite(Number(b.maxTokens)) && Number(b.maxTokens) > 0 && !b.isFallback) {
        budgetTokens = Number(b.maxTokens);
        budgetSource = 'model_catalog';
      }
    } catch {}
  }

  return {
    model: modelStr || null,
    preference: matchedPref,
    preferenceKey: matchedKey,
    cliSettingsLimit,
    limitTokens: budgetTokens || null,
    budgetSource: budgetSource || 'unknown'
  };
}

/**
 * 保存 CLI 按模型自定义上下文偏好 (立即写入共享设置，默认不覆盖全局 settings.json)
 */
function saveCliModelContextPreference({
  model,
  mode = 'fixed',
  limitTokens = null,
  clear = false,
  syncCliSettings = false,
  stateDir = null,
  agCliDir = null,
  homeDir = null
} = {}) {
  if (!model || !String(model).trim()) {
    return { ok: false, error: '必须指定 --model 模型名称或标识' };
  }
  const cleanModel = String(model).trim();
  const parsedLimit = limitTokens !== null && limitTokens !== undefined ? parseCliWindowString(limitTokens) : null;
  if (!clear && mode === 'fixed' && (!parsedLimit || parsedLimit <= 0)) {
    return { ok: false, error: 'mode=fixed 时必须提供有效的 --limit 正整数或 K/M 窗口值' };
  }
  const payload = clear
    ? { clearContextPreferences: [cleanModel] }
    : {
        contextPreference: {
          modelId: cleanModel,
          mode,
          limitTokens: mode === 'fixed' ? parsedLimit : null
        }
      };

  const saveRes = collector.savePluginSettings(payload, { stateDir });
  if (!saveRes || !saveRes.ok) {
    return { ok: false, error: saveRes?.error || '保存按模型上下文偏好失败' };
  }

  let cliSettingsSynced = false;
  let cliSettingsPath = null;
  if (syncCliSettings) {
    const cliDir = agCliDir || path.join(homeDir || os.homedir(), '.gemini', 'antigravity-cli');
    cliSettingsPath = path.join(cliDir, 'settings.json');
    try {
      fs.mkdirSync(cliDir, { recursive: true });
      const cur = readJsonSafe(cliSettingsPath) || {};
      if (clear || mode === 'default' || mode === 'dynamic') {
        delete cur.contextWindow;
      } else if (mode === 'fixed' && Number.isFinite(Number(parsedLimit))) {
        const n = Math.round(Number(parsedLimit));
        cur.contextWindow = n % 1000 === 0 ? `${n / 1000}K` : String(n);
      }
      const tmp = `${cliSettingsPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, cliSettingsPath);
      cliSettingsSynced = true;
    } catch {}
  }

  return {
    ok: true,
    savedImmediately: true,
    model: cleanModel,
    mode: clear ? 'cleared' : mode,
    limitTokens: clear ? null : (mode === 'fixed' ? parsedLimit : null),
    contextPreferences: saveRes.contextPreferences || {},
    cliSettingsSynced,
    cliSettingsPath,
    effectiveTiming: {
      cliProcess: 'after_restart',
      desktopRenderer: 'next_request',
      explanation: '配置已立即保存至磁盘. 状态栏与看板已立即按新上限重算分母与百分比; 独立 agy CLI 宿主压缩阈值需重启或新开会话后生效 (若受原生二进制上限限制需先执行 unlock --cli).'
    }
  };
}

function computeCliSessionSpeedMetrics(latestCall, dbMeta = null, nowMs = Date.now()) {
  if (!latestCall || typeof latestCall !== 'object') {
    return { speedTokPerSec: null, speedSource: 'idle', latestCallMetrics: null };
  }
  const stepIdx = Number.isInteger(latestCall.stepIndex) ? latestCall.stepIndex : null;
  const dbStep = (dbMeta && dbMeta.stepMetaMap && stepIdx !== null) ? dbMeta.stepMetaMap.get(stepIdx) : null;

  const outp = Math.max(0, Number(latestCall.outputTokens ?? 0));
  const rawStatus = String(latestCall.outcomeStatus || latestCall.status || '').toLowerCase();
  const ttftSec = (latestCall.ttftSec != null && Number.isFinite(Number(latestCall.ttftSec)) && Number(latestCall.ttftSec) >= 0)
    ? Number(latestCall.ttftSec)
    : ((dbStep?.ttftSec != null && Number.isFinite(Number(dbStep.ttftSec)) && Number(dbStep.ttftSec) >= 0) ? Number(dbStep.ttftSec) : null);

  let streamingSec = (latestCall.streamingSec != null && Number.isFinite(Number(latestCall.streamingSec)) && Number(latestCall.streamingSec) >= 0)
    ? Number(latestCall.streamingSec)
    : ((dbStep?.streamingSec != null && Number.isFinite(Number(dbStep.streamingSec)) && Number(dbStep.streamingSec) >= 0) ? Number(dbStep.streamingSec) : null);

  let durationSec = (latestCall.durationSec != null && Number.isFinite(Number(latestCall.durationSec)) && Number(latestCall.durationSec) > 0)
    ? Number(latestCall.durationSec)
    : null;
  if (durationSec === null) {
    const durMs = Number(latestCall.durationMs || latestCall.elapsedMs || 0);
    if (Number.isFinite(durMs) && durMs > 0) {
      durationSec = Number((durMs / 1000).toFixed(4));
    } else if (ttftSec !== null && streamingSec !== null) {
      durationSec = Number((ttftSec + streamingSec).toFixed(4));
    } else if (streamingSec !== null && streamingSec > 0) {
      durationSec = streamingSec;
    }
  }

  // 流式进行中且仅有请求开始时间时，估算已流式窗口以便实时更新
  if (rawStatus === 'streaming' && streamingSec === null && outp > 0) {
    const ts = Number(latestCall.timestamp || (latestCall.created_at ? Date.parse(latestCall.created_at) : 0)) || 0;
    if (ts > 0 && nowMs > ts) {
      const elapsedSec = (nowMs - ts) / 1000;
      const estStream = ttftSec !== null ? Math.max(0, elapsedSec - ttftSec) : elapsedSec;
      if (estStream > 0 && estStream < 3600) {
        streamingSec = Number(estStream.toFixed(4));
        if (durationSec === null) durationSec = Number(elapsedSec.toFixed(4));
      }
    }
  }

  const streamSpeedIn = (latestCall.streamingTps != null && Number.isFinite(Number(latestCall.streamingTps)) && Number(latestCall.streamingTps) > 0)
    ? Number(latestCall.streamingTps)
    : null;
  const overallSpeedIn = (latestCall.tps != null && Number.isFinite(Number(latestCall.tps)) && Number(latestCall.tps) > 0)
    ? Number(latestCall.tps)
    : null;

  const evalRes = typeof core.evaluateGenerationExperience === 'function'
    ? core.evaluateGenerationExperience({
        status: rawStatus || 'final',
        outcomeStatus: rawStatus || 'final',
        ttftSec,
        streamingSec,
        totalDurationSec: durationSec,
        streamSpeed: streamSpeedIn,
        overallTps: overallSpeedIn,
        outputTokens: outp,
        error: latestCall.error || null
      })
    : null;

  const rowSpeedInfo = typeof core.resolveRequestRowSpeed === 'function'
    ? core.resolveRequestRowSpeed({
        outputTokens: outp,
        ttftSec,
        streamingSec,
        durationSec,
        streamingTps: streamSpeedIn,
        tps: overallSpeedIn,
        status: rawStatus || 'final',
        outcomeStatus: rawStatus || 'final'
      })
    : null;

  const reqModelMeta = typeof core.resolveRequestedModelDisplay === 'function'
    ? core.resolveRequestedModelDisplay(latestCall.requestedModel || latestCall.requestedModelRaw || dbStep?.requestedModel || null)
    : { text: latestCall.requestedModel || null };

  let speedTokPerSec = null;
  let speedSource = evalRes?.phase || 'unavailable';
  if (evalRes && evalRes.phase !== 'waiting' && evalRes.phase !== 'idle' && evalRes.phase !== 'canceled' && evalRes.phase !== 'failed') {
    if (!evalRes.isSampleSparse && evalRes.streamSpeed != null && Number.isFinite(Number(evalRes.streamSpeed))) {
      speedTokPerSec = Number(Number(evalRes.streamSpeed).toFixed(1));
      speedSource = 'streaming';
    } else if (!evalRes.isSampleSparse && evalRes.overallTps != null && Number.isFinite(Number(evalRes.overallTps))) {
      speedTokPerSec = Number(Number(evalRes.overallTps).toFixed(1));
      speedSource = 'overall';
    } else if (evalRes.isSampleSparse) {
      speedSource = 'sparse_sample';
    }
  }

  return {
    speedTokPerSec,
    speedSource,
    requestedModel: reqModelMeta?.text || null,
    latestCallMetrics: {
      callId: latestCall.callId || latestCall.responseId || null,
      stepIndex: stepIdx,
      created_at: latestCall.created_at || (latestCall.timestamp ? new Date(latestCall.timestamp).toISOString() : null),
      status: rawStatus || 'final',
      requestedModel: reqModelMeta?.text || null,
      outputTokens: outp,
      ttftSec,
      streamingSec,
      durationSec,
      streamSpeed: evalRes?.streamSpeed ?? streamSpeedIn,
      overallTps: evalRes?.overallTps ?? overallSpeedIn,
      rowSpeedTokPerSec: rowSpeedInfo?.speed ?? null,
      rowSpeedSource: rowSpeedInfo?.source ?? null,
      speedReason: rowSpeedInfo?.reasonCode ?? null,
      excludesTtft: speedSource === 'streaming',
      isSampleSparse: Boolean(evalRes?.isSampleSparse)
    }
  };
}

/**
 * ELV-59: 独立扫描 CLI 会话状态 (脱离桌面客户端与 CDP)，区分并发多 CLI 会话
 */
function scanCliSessions(options = {}) {
  const home = options.homeDir || os.homedir();
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');
  const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const nowMs = Number(options.nowMs) || Date.now();
  const activeThresholdMs = Number(options.activeThresholdMs) || 120000;
  const idleThresholdMs = Number(options.idleThresholdMs) || 3600000;

  const sessionMap = new Map();
  const transcriptTailBySession = new Map();
  const ensureSession = (id) => {
    const cleanId = String(id || '').trim();
    if (!cleanId) return null;
    if (!sessionMap.has(cleanId)) {
      sessionMap.set(cleanId, {
        sessionId: cleanId,
        shortId: cleanId.slice(0, 8),
        cwd: null,
        model: null,
        modelLabel: null,
        contextUsedTokens: null,
        contextLimitTokens: null,
        contextLimitSource: 'unknown',
        contextRemainingTokens: null,
        contextPercent: null,
        sessionTotalTokens: 0,
        sessionInputTokens: 0,
        sessionCacheTokens: 0,
        sessionOutputTokens: 0,
        cacheHitRate: null,
        turnCount: 0,
        stepCount: 0,
        speedTokPerSec: null,
        speedSource: 'idle',
        latestCallMetrics: null,
        requestCount: 0,
        lastActiveMs: 0,
        lastActiveAt: null,
        status: 'unknown',
        hasPresenceLock: false,
        isSubagent: false,
        parentSessionId: null,
        sources: []
      });
    }
    return sessionMap.get(cleanId);
  };

  // 1. 扫描 presence/*.lock 标识运行中或近期 CLI 会话
  const presenceDir = path.join(agCliDir, 'presence');
  if (fs.existsSync(presenceDir)) {
    try {
      for (const entry of fs.readdirSync(presenceDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
        const sid = entry.name.slice(0, -5);
        const s = ensureSession(sid);
        if (!s) continue;
        s.hasPresenceLock = true;
        if (!s.sources.includes('presence')) s.sources.push('presence');
        try {
          const st = fs.statSync(path.join(presenceDir, entry.name));
          if (st.mtimeMs > s.lastActiveMs) s.lastActiveMs = st.mtimeMs;
        } catch {}
      }
    } catch {}
  }

  // 2. 扫描 brain/<sessionId>/.system_generated/logs/transcript.jsonl
  const brainDir = path.join(agCliDir, 'brain');
  if (fs.existsSync(brainDir)) {
    try {
      for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tPath)) continue;
        const s = ensureSession(entry.name);
        if (!s) continue;
        if (!s.sources.includes('transcript')) s.sources.push('transcript');
        const tail = parseTranscriptTailSummary(tPath);
        transcriptTailBySession.set(entry.name, tail);
        if (tail.cwd && !s.cwd) s.cwd = tail.cwd;
        if (tail.lastModel && !s.model) s.model = tail.lastModel;
        if (tail.lastModelStep?.modelLabel && !s.modelLabel) s.modelLabel = tail.lastModelStep.modelLabel;
        if (tail.lastStepAtMs > s.lastActiveMs) s.lastActiveMs = tail.lastStepAtMs;
        if (tail.lastUsage) {
          s.contextUsedTokens = tail.lastUsage.totalTokens;
        }
        if (tail.userTurns > 0) s.turnCount = Math.max(s.turnCount || 0, tail.userTurns);
        if (tail.stepsCount > 0) s.stepCount = Math.max(s.stepCount || 0, tail.stepsCount);
        if (tail.lastUsage && s.sessionTotalTokens === 0) {
          s.sessionTotalTokens = tail.lastUsage.totalTokens;
          s.sessionInputTokens = tail.lastUsage.inputTokens;
          s.sessionCacheTokens = tail.lastUsage.cacheTokens;
          s.sessionOutputTokens = tail.lastUsage.outputTokens;
          const denom = tail.lastUsage.inputTokens + tail.lastUsage.cacheTokens;
          s.cacheHitRate = denom > 0 ? Number(((tail.lastUsage.cacheTokens / denom) * 100).toFixed(1)) : 0;
        }
      }
    } catch {}
  }

  // 3. 结合账本 pricing_ledger_v1.json 中 source==='cli' 的权威逐请求记录
  const ledgerTarget = options.ledgerPath || agDir;
  const ledger = collector.loadPricingLedger(ledgerTarget, { readOnly: true });
  const calls = ledger && !ledger.__corrupted && !ledger.__unreadable && ledger.calls
    ? Object.values(ledger.calls)
    : [];

  const cliCallsBySession = new Map();
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    if (String(c.source || '').toLowerCase() !== 'cli') continue;
    if (!c.cascadeId) continue;
    const sid = String(c.cascadeId).trim();
    if (!cliCallsBySession.has(sid)) cliCallsBySession.set(sid, []);
    cliCallsBySession.get(sid).push(c);
  }

  for (const [sid, list] of cliCallsBySession.entries()) {
    const s = ensureSession(sid);
    if (!s) continue;
    if (!s.sources.includes('ledger')) s.sources.push('ledger');
    list.sort((a, b) => {
      const ta = Number(a.timestamp || a.updatedAt || (a.created_at ? Date.parse(a.created_at) : 0)) || 0;
      const tb = Number(b.timestamp || b.updatedAt || (b.created_at ? Date.parse(b.created_at) : 0)) || 0;
      if (ta !== tb) return ta - tb;
      return Number(a.stepIndex || 0) - Number(b.stepIndex || 0);
    });
    let sumTokens = 0;
    let sumInput = 0;
    let sumCache = 0;
    let sumOutput = 0;
    const userTurnIndices = new Set();
    for (const c of list) {
      const inp = Number(c.inputTokens || 0);
      const cap = Number(c.cacheReadTokens ?? c.cacheTokens ?? 0);
      const outp = Number(c.outputTokens || 0);
      const tot = Number(c.totalTokens ?? (inp + cap + outp));
      sumTokens += tot;
      sumInput += inp;
      sumCache += cap;
      sumOutput += outp;
      const ts = Number(c.timestamp || c.updatedAt || (c.created_at ? Date.parse(c.created_at) : 0)) || 0;
      if (ts > s.lastActiveMs) s.lastActiveMs = ts;
      if (c.parentCascadeId && !s.parentSessionId) {
        s.isSubagent = true;
        s.parentSessionId = String(c.parentCascadeId);
      }
      if (c.agentRole === 'subagent') s.isSubagent = true;
      if (c.stepIndex !== undefined && c.stepIndex !== null) userTurnIndices.add(c.stepIndex);
    }
    const latest = list[list.length - 1];
    s.requestCount = list.length;
    s.sessionTotalTokens = sumTokens;
    s.sessionInputTokens = sumInput;
    s.sessionCacheTokens = sumCache;
    s.sessionOutputTokens = sumOutput;
    s.cacheHitRate = (sumInput + sumCache) > 0
      ? Number(((sumCache / (sumInput + sumCache)) * 100).toFixed(1))
      : 0;
    s.turnCount = s.turnCount || userTurnIndices.size || Math.max(1, Math.round(list.length / 2));
    s.stepCount = Math.max(s.stepCount || 0, list.length);
    if (latest) {
      s.model = latest.modelExactId || latest.model || s.model;
      s.modelLabel = latest.modelLabel || latest.model || s.modelLabel;
      const inp = Number(latest.inputTokens || 0);
      const cap = Number(latest.cacheReadTokens ?? latest.cacheTokens ?? 0);
      const outp = Number(latest.outputTokens || 0);
      const latestCtx = inp + cap + outp;
      if (latestCtx > 0) s.contextUsedTokens = latestCtx;
    }
  }

  // 3.5. 补全每会话的最新速度（优先使用比账本更新的流式/刚完成 transcript 步与只读 .db 耗时，复用桌面速度评估口径）
  const cliConvDir = path.join(agCliDir, 'conversations');
  for (const s of sessionMap.values()) {
    const list = cliCallsBySession.get(s.sessionId) || [];
    const latestLedgerCall = list.length ? list[list.length - 1] : null;
    const tailStep = transcriptTailBySession.get(s.sessionId)?.lastModelStep || null;

    let activeCall = latestLedgerCall;
    if (tailStep) {
      const ledgerStep = latestLedgerCall && Number.isInteger(latestLedgerCall.stepIndex) ? latestLedgerCall.stepIndex : -1;
      const tailStepIdx = Number.isInteger(tailStep.stepIndex) ? tailStep.stepIndex : -1;
      const tailTs = Number(tailStep.timestamp || 0) || 0;
      const ledgerTs = Number(
        latestLedgerCall?.timestamp
        || latestLedgerCall?.updatedAt
        || (latestLedgerCall?.created_at ? Date.parse(latestLedgerCall.created_at) : 0)
      ) || 0;
      const sameStep = (tailStepIdx >= 0 && ledgerStep >= 0 && tailStepIdx === ledgerStep);
      const tailIsNewer = !latestLedgerCall
        || (sameStep && tailStep.status === 'streaming' && String(latestLedgerCall.status || '').toLowerCase() === 'streaming')
        || (!sameStep && tailStep.status === 'streaming')
        || (tailStepIdx > ledgerStep && tailStepIdx >= 0)
        || (!sameStep && tailTs > ledgerTs + 1000);
      if (tailIsNewer) {
        activeCall = sameStep && latestLedgerCall
          ? {
              ...latestLedgerCall,
              outputTokens: Math.max(Number(latestLedgerCall.outputTokens || 0), Number(tailStep.outputTokens || 0)),
              totalTokens: Math.max(Number(latestLedgerCall.totalTokens || 0), Number(tailStep.totalTokens || 0)),
              status: tailStep.status || latestLedgerCall.status
            }
          : tailStep;
        if (tailStep.totalTokens > 0) s.contextUsedTokens = tailStep.totalTokens;
        if (tailStep.model) s.model = tailStep.model;
        if (tailStep.modelLabel) s.modelLabel = tailStep.modelLabel;
      }
    }

    if (activeCall) {
      let dbMeta = null;
      const needsDbSpeed = (activeCall.streamingSec == null && activeCall.streamingTps == null && activeCall.durationSec == null && activeCall.durationMs == null);
      if (needsDbSpeed && typeof collector.loadConversationDbMeta === 'function') {
        const dbPath = path.join(cliConvDir, `${s.sessionId}.db`);
        if (fs.existsSync(dbPath)) {
          dbMeta = collector.loadConversationDbMeta(dbPath, s.sessionId);
        }
      }
      const speedInfo = computeCliSessionSpeedMetrics(activeCall, dbMeta, nowMs);
      s.speedTokPerSec = speedInfo.speedTokPerSec;
      s.speedSource = speedInfo.speedSource;
      s.requestedModel = speedInfo.requestedModel || s.requestedModel || null;
      s.latestCallMetrics = speedInfo.latestCallMetrics;
    }
  }

  // 4. 按会话模型独立解析上下文上限与状态 (互不串会话)
  const sessions = [];
  for (const s of sessionMap.values()) {
    if (options.sessionFilter) {
      const sf = String(options.sessionFilter).trim().toLowerCase();
      if (!s.sessionId.toLowerCase().startsWith(sf) && s.sessionId.toLowerCase() !== sf) continue;
    }
    if (options.cwdFilter) {
      const cf = path.resolve(String(options.cwdFilter)).toLowerCase();
      if (!s.cwd || path.resolve(s.cwd).toLowerCase() !== cf) continue;
    }
    const budget = resolveCliModelContextBudget([s.model, s.modelLabel], {
      stateDir: options.stateDir,
      agDir,
      agCliDir,
      homeDir: home
    });
    s.contextLimitTokens = budget.limitTokens;
    s.contextLimitSource = budget.budgetSource;
    if (s.contextUsedTokens !== null && s.contextLimitTokens) {
      s.contextPercent = Math.min(999, Math.round((s.contextUsedTokens / s.contextLimitTokens) * 1000) / 10);
      s.contextRemainingTokens = Math.max(0, s.contextLimitTokens - s.contextUsedTokens);
    } else {
      s.contextPercent = null;
      s.contextRemainingTokens = null;
    }
    if (s.lastActiveMs > 0) {
      s.lastActiveAt = new Date(s.lastActiveMs).toISOString();
      const age = Math.max(0, nowMs - s.lastActiveMs);
      if (age <= activeThresholdMs) s.status = 'active';
      else if (age <= idleThresholdMs) s.status = 'idle';
      else s.status = 'stale';
    } else if (s.hasPresenceLock && s.requestCount === 0) {
      s.status = 'started';
      s.contextUsedTokens = 0;
      if (s.contextLimitTokens) {
        s.contextPercent = 0;
        s.contextRemainingTokens = s.contextLimitTokens;
      }
    }
    sessions.push(s);
  }

  sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  const activeSessionCount = sessions.filter(s => s.status === 'active' || s.status === 'started').length;
  const staleSessionCount = sessions.filter(s => s.status === 'stale').length;
  return {
    ok: true,
    agCliDir,
    sessionCount: sessions.length,
    activeSessionCount,
    staleSessionCount,
    sessions,
    scannedAt: new Date(nowMs).toISOString()
  };
}

function maskSessionId(sessionId) {
  const s = String(sessionId || '').trim();
  if (!s) return '—';
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * 按精确 sessionId 与可选 source ('cli' | 'desktop') 只读查询单个会话详情
 * 严格按精确 ID 匹配；找不到或非法时直接报错，绝不回退选最近活跃、目录名或第一条
 */
function getSessionDetail({ sessionId, source = null, agCliDir = null, agDir = null, stateDir = null, homeDir = null, nowMs = Date.now() } = {}) {
  const cleanSid = String(sessionId || '').trim();
  if (!cleanSid || /[/\\]|\.\./.test(cleanSid) || cleanSid.length > 128) {
    return { ok: false, code: 'INVALID_SESSION_ID', error: '会话 ID 为空或格式非法', sessionId: cleanSid };
  }
  const reqSourceRaw = source ? String(source).trim().toLowerCase() : '';
  const reqSource = (reqSourceRaw === 'desktop' || reqSourceRaw === 'cli') ? reqSourceRaw : null;

  const home = homeDir || os.homedir();
  const resolvedCliDir = agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');
  const resolvedAgDir = agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');

  const buildDetailForSource = (srcName) => {
    const baseDir = srcName === 'cli' ? resolvedCliDir : resolvedAgDir;
    const transcriptPath = path.join(baseDir, 'brain', cleanSid, '.system_generated', 'logs', 'transcript.jsonl');
    const hasTranscript = fs.existsSync(transcriptPath);
    const convDir = path.join(baseDir, 'conversations');
    const dbPath = path.join(convDir, `${cleanSid}.db`);
    const hasDb = fs.existsSync(dbPath);
    const hasPresenceLock = srcName === 'cli' && fs.existsSync(path.join(resolvedCliDir, 'presence', `${cleanSid}.lock`));

    const ledger = collector.loadPricingLedger(resolvedAgDir, { readOnly: true });
    const allLedgerCalls = (ledger && !ledger.__corrupted && !ledger.__unreadable && ledger.calls)
      ? Object.values(ledger.calls).filter(c => c && typeof c === 'object')
      : [];
    const ledgerCalls = allLedgerCalls.filter(c => String(c.cascadeId || '').trim() === cleanSid);
    const matchingSourceCalls = reqSource
      ? ledgerCalls.filter(c => !c.source || String(c.source).toLowerCase() === srcName)
      : ledgerCalls;

    if (!hasTranscript && matchingSourceCalls.length === 0 && !hasPresenceLock) {
      return null;
    }

    const tail = hasTranscript ? parseTranscriptTailSummary(transcriptPath) : null;
    const parsed = hasTranscript && typeof collector.parseTranscriptForSessionTimeline === 'function'
      ? collector.parseTranscriptForSessionTimeline(transcriptPath, cleanSid, convDir, srcName)
      : { turns: [], calls: [], subagentLinks: [], rawSteps: [], toolEntries: [] };

    const subagentInfo = typeof collector.collectVerifiedSubagentCallsForSessionSync === 'function'
      ? collector.collectVerifiedSubagentCallsForSessionSync({
          cascadeId: cleanSid,
          rootEntries: srcName === 'cli'
            ? [{ dir: resolvedCliDir, source: 'cli' }, { dir: resolvedAgDir, source: 'desktop' }]
            : [{ dir: resolvedAgDir, source: 'desktop' }, { dir: resolvedCliDir, source: 'cli' }],
          initialLinks: parsed.subagentLinks || [],
          ledgerCalls: allLedgerCalls
        })
      : { subagentCalls: [] };

    const rawMergedCalls = [...(parsed.calls || []), ...matchingSourceCalls, ...(subagentInfo.subagentCalls || [])];

    const prelimTurns = [...(parsed.turns || [])]
      .sort((a, b) => ((a.stepIndex ?? 0) - (b.stepIndex ?? 0)) || ((a.timestamp || 0) - (b.timestamp || 0)))
      .map((t, idx) => ({ ...t, turnIndex: idx + 1 }));
    const toolInsights = typeof collector.extractSessionToolInsights === 'function'
      ? collector.extractSessionToolInsights(parsed.toolEntries || [], prelimTurns)
      : { fileActivities: [], fileActivitySummary: null, commandExecutions: [], commandSummary: null, taskEvents: [], toolExecEvents: [] };

    const grouped = typeof core.groupSessionCallsByTurns === 'function'
      ? core.groupSessionCallsByTurns(parsed.turns || [], rawMergedCalls, {
          cascadeId: cleanSid,
          toolExecEvents: toolInsights.toolExecEvents,
          taskEvents: toolInsights.taskEvents
        })
      : { turns: [], calls: rawMergedCalls, totalCalls: rawMergedCalls.length };
    const flatCalls = [
      ...(grouped.turns || []).flatMap(t => t.calls || []),
      ...(grouped.unlinkedSubagentCalls || [])
    ].sort((a, b) => {
      const ta = Number(a.timestamp || a.updatedAt || (a.created_at ? Date.parse(a.created_at) : 0)) || 0;
      const tb = Number(b.timestamp || b.updatedAt || (b.created_at ? Date.parse(b.created_at) : 0)) || 0;
      if (ta !== tb) return ta - tb;
      return Number(a.stepIndex || 0) - Number(b.stepIndex || 0);
    });
    const contextChangeEvents = typeof core.detectContextChangeEvents === 'function'
      ? core.detectContextChangeEvents(parsed.rawSteps || [], flatCalls, { cascadeId: cleanSid })
      : [];

    const gTotals = grouped.sessionTokenTotals || null;
    let sumInput = gTotals ? Number(gTotals.inputTokens || 0) : 0;
    let sumCache = gTotals ? Number(gTotals.cacheReadTokens || 0) : 0;
    let sumOutput = gTotals ? Number(gTotals.outputTokens || 0) : 0;
    let sumTokens = gTotals ? Number(gTotals.totalTokens || 0) : 0;
    let lastActiveMs = Number(tail?.lastStepAtMs || 0) || 0;
    let model = tail?.lastModel || null;
    let modelLabel = tail?.lastModelStep?.modelLabel || null;
    for (const c of flatCalls) {
      if (!gTotals) {
        const inp = Number(c.inputTokens || 0);
        const cap = Number(c.cacheReadTokens ?? c.cacheTokens ?? 0);
        const outp = Number(c.outputTokens || 0);
        const tot = Number(c.totalTokens ?? (inp + cap + outp));
        sumInput += inp;
        sumCache += cap;
        sumOutput += outp;
        sumTokens += tot;
      }
      const ts = Number(c.timestamp || c.updatedAt || (c.created_at ? Date.parse(c.created_at) : 0)) || 0;
      if (ts > lastActiveMs) lastActiveMs = ts;
      if (c.modelExactId || c.model) model = c.modelExactId || c.model;
      if (c.attributedModelLabel || c.modelLabel || c.model) modelLabel = c.attributedModelLabel || c.modelLabel || c.model;
    }
    if (lastActiveMs === 0 && hasTranscript) {
      try { lastActiveMs = fs.statSync(transcriptPath).mtimeMs; } catch {}
    }

    const mainFlatCalls = flatCalls.filter(c => c.agentRole !== 'subagent');
    const latestCall = mainFlatCalls.length
      ? mainFlatCalls[mainFlatCalls.length - 1]
      : (flatCalls.length ? flatCalls[flatCalls.length - 1] : (tail?.lastModelStep || null));
    let contextUsedTokens = null;
    if (latestCall) {
      const latestCtx = Number(latestCall.inputTokens || 0)
        + Number(latestCall.cacheReadTokens ?? latestCall.cacheTokens ?? 0)
        + Number(latestCall.outputTokens || 0);
      if (latestCtx > 0) contextUsedTokens = latestCtx;
      else if (Number(latestCall.totalTokens || 0) > 0) contextUsedTokens = Number(latestCall.totalTokens);
    }
    if (contextUsedTokens === null && tail?.lastUsage?.totalTokens > 0) {
      contextUsedTokens = tail.lastUsage.totalTokens;
    }

    let dbMeta = parsed.dbMeta || null;
    if (!dbMeta && hasDb && typeof collector.loadConversationDbMeta === 'function') {
      try { dbMeta = collector.loadConversationDbMeta(dbPath, cleanSid); } catch {}
    }
    const speedInfo = latestCall
      ? computeCliSessionSpeedMetrics(latestCall, dbMeta, nowMs)
      : { speedTokPerSec: null, speedSource: 'idle', latestCallMetrics: null };

    const budget = resolveCliModelContextBudget([model, modelLabel], {
      stateDir,
      agDir: resolvedAgDir,
      agCliDir: resolvedCliDir,
      homeDir: home,
      includeCliSettings: srcName === 'cli'
    });
    const limitTokens = budget.limitTokens || null;
    const contextPercent = (contextUsedTokens !== null && limitTokens)
      ? Math.min(999, Math.round((contextUsedTokens / limitTokens) * 1000) / 10)
      : null;
    const contextRemainingTokens = (contextUsedTokens !== null && limitTokens)
      ? Math.max(0, limitTokens - contextUsedTokens)
      : null;

    const cacheHitRate = (sumInput + sumCache) > 0
      ? Number(((sumCache / (sumInput + sumCache)) * 100).toFixed(1))
      : (flatCalls.length > 0 ? 0 : null);

    let status = 'unknown';
    if (lastActiveMs > 0) {
      const age = Math.max(0, nowMs - lastActiveMs);
      if (age <= 120000) status = 'active';
      else if (age <= 3600000) status = 'idle';
      else status = 'stale';
    } else if (hasPresenceLock) {
      status = 'started';
    }

    const firstUserTurn = prelimTurns.find(t => t && t.preview) || null;
    const cwd = tail?.cwd || (hasTranscript ? extractWorkspaceFromTranscriptFile(transcriptPath) : null) || null;

    return {
      ok: true,
      sessionId: cleanSid,
      shortId: cleanSid.slice(0, 8),
      maskedId: maskSessionId(cleanSid),
      source: srcName,
      titlePreview: firstUserTurn?.preview || '',
      cwd,
      model,
      modelLabel: modelLabel || model || null,
      contextUsedTokens,
      contextLimitTokens: limitTokens,
      contextLimitSource: budget.budgetSource,
      contextRemainingTokens,
      contextPercent,
      sessionTotalTokens: sumTokens,
      sessionInputTokens: sumInput,
      sessionCacheTokens: sumCache,
      sessionOutputTokens: sumOutput,
      cacheHitRate,
      turnCount: Math.max(prelimTurns.length, tail?.userTurns || 0),
      stepCount: Math.max(tail?.stepsCount || 0, grouped.turns?.reduce((a, t) => Math.max(a, t.endStepIdx || 0), 0) + (tail?.stepsCount ? 0 : 1) || flatCalls.length),
      requestCount: gTotals ? gTotals.callCount : flatCalls.length,
      modelBreakdown: grouped.modelBreakdown || [],
      sessionTokenTotals: gTotals,
      speedTokPerSec: speedInfo.speedTokPerSec,
      speedSource: speedInfo.speedSource,
      latestCallMetrics: speedInfo.latestCallMetrics,
      lastActiveMs,
      lastActiveAt: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
      status,
      hasTranscript,
      timeline: {
        ok: true,
        sessionId: cleanSid,
        source: srcName,
        totalCalls: grouped.totalCalls ?? flatCalls.length,
        mainCallsCount: grouped.mainCallsCount ?? mainFlatCalls.length,
        subagentCallsCount: grouped.subagentCallsCount ?? (flatCalls.length - mainFlatCalls.length),
        turns: grouped.turns || [],
        calls: flatCalls,
        modelBreakdown: grouped.modelBreakdown || [],
        sessionTokenTotals: gTotals,
        contextChangeEvents,
        contextDeltaSummary: grouped.contextDeltaSummary || null,
        timingSummary: grouped.timingSummary || null,
        agentFleetSummary: grouped.agentFleetSummary || null,
        fileActivities: toolInsights.fileActivities || [],
        fileActivitySummary: toolInsights.fileActivitySummary || null,
        commandExecutions: toolInsights.commandExecutions || [],
        commandSummary: toolInsights.commandSummary || null,
        taskEvents: toolInsights.taskEvents || []
      }
    };
  };

  if (reqSource === 'desktop') {
    const desk = buildDetailForSource('desktop');
    if (desk) return desk;
    return {
      ok: false,
      code: 'SESSION_NOT_FOUND',
      sessionId: cleanSid,
      source: 'desktop',
      error: `未找到桌面会话 (${maskSessionId(cleanSid)}) 的本地记录`
    };
  }
  if (reqSource === 'cli') {
    const cli = buildDetailForSource('cli');
    if (cli) return cli;
    return {
      ok: false,
      code: 'SESSION_NOT_FOUND',
      sessionId: cleanSid,
      source: 'cli',
      error: `未找到 CLI 会话 (${maskSessionId(cleanSid)}) 的本地记录`
    };
  }

  const hitCli = buildDetailForSource('cli');
  if (hitCli) return hitCli;
  const hitDesk = buildDetailForSource('desktop');
  if (hitDesk) return hitDesk;
  return {
    ok: false,
    code: 'SESSION_NOT_FOUND',
    sessionId: cleanSid,
    source: null,
    error: `未找到会话 (${maskSessionId(cleanSid)}) 的本地记录`
  };
}

function renderCliMonitorFrame(scanResult, options = {}) {
  const sessions = Array.isArray(scanResult?.sessions) ? scanResult.sessions : [];
  if (sessions.length === 0) {
    return options.compact
      ? '[AG CLI] 未发现活跃 CLI 会话 | 上下文: --% (未知)'
      : '=== Antigravity CLI 终端监视器 (ELV-59) ===\n当前未发现 CLI 会话. 请启动 agy 后自动刷新.';
  }

  const primary = sessions[0];
  const pctStr = primary.contextPercent !== null ? `${primary.contextPercent}%` : '--%';
  const usedStr = primary.contextUsedTokens !== null ? formatCompactTokens(primary.contextUsedTokens) : '未知';
  const limitStr = primary.contextLimitTokens !== null ? formatCompactTokens(primary.contextLimitTokens) : '未知';

  if (options.compact) {
    const multiHint = sessions.length > 1 ? ` | 共 ${sessions.length} 会话` : '';
    const line = `[AG CLI ${primary.shortId}] ${primary.modelLabel || primary.model || '未知模型'} | 上下文 ${usedStr}/${limitStr} (${pctStr}) | 本会话累计 ${formatCompactTokens(primary.sessionTotalTokens)}${multiHint}`;
    return line;
  }

  const lines = [
    `=== Antigravity CLI 终端监视器 (独立运行. 共 ${sessions.length} 个会话) ===`,
    `扫描时间: ${scanResult.scannedAt} | 目录: ${scanResult.agCliDir}`
  ];
  for (const s of sessions.slice(0, 8)) {
    const sPct = s.contextPercent !== null ? `${s.contextPercent}%` : '--%';
    const sUsed = s.contextUsedTokens !== null ? formatCompactTokens(s.contextUsedTokens) : '未知';
    const sLimit = s.contextLimitTokens !== null ? formatCompactTokens(s.contextLimitTokens) : '未知';
    const roleTag = s.isSubagent ? ` [子代理<-${(s.parentSessionId || '').slice(0, 8)}]` : '';
    const cwdTag = s.cwd ? ` | 目录: ${s.cwd}` : '';
    lines.push(
      `  [${s.status.toUpperCase()}] ${s.shortId}${roleTag} | 模型: ${s.modelLabel || s.model || '未知'} | 上下文: ${sUsed} / ${sLimit} (${sPct}) | 累计: ${formatCompactTokens(s.sessionTotalTokens)} (${s.requestCount} 次)${cwdTag}`
    );
  }
  lines.push('提示: 按 Ctrl+C 退出监视器. 使用 --compact 可切换单行常驻状态栏.');
  return lines.join('\n');
}

async function runCliMonitor(options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs) || 2000);
  const stdout = options.stdout || process.stdout;
  const maxIterations = options.once ? 1 : (Number(options.maxIterations) || Infinity);
  let stopped = false;
  let iter = 0;

  const stop = () => { stopped = true; };
  if (options.handleSignals !== false) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  if (options.signal) {
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
  }

  let lastScan = null;
  try {
    while (!stopped && iter < maxIterations) {
      iter++;
      lastScan = scanCliSessions(options);
      if (options.json) {
        stdout.write(JSON.stringify(lastScan, null, 2) + '\n');
      } else {
        const frame = renderCliMonitorFrame(lastScan, options);
        if (options.compact && stdout.isTTY) {
          const title = frame.slice(0, 80);
          stdout.write(`\x1b]0;${title}\x07\r\x1b[2K${frame}`);
        } else if (!options.once && stdout.isTTY) {
          stdout.write(`\x1b[2J\x1b[H${frame}\n`);
        } else {
          stdout.write(frame + '\n');
        }
      }
      if (stopped || iter >= maxIterations) break;
      await new Promise(resolve => {
        const t = setTimeout(resolve, intervalMs);
        if (options.signal) {
          options.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        }
      });
    }
  } finally {
    if (options.handleSignals !== false) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    if (options.compact && stdout.isTTY) {
      try { stdout.write('\n'); } catch {}
    }
  }
  return { ok: true, iterations: iter, lastScan };
}

function formatCliStatusLine(session, options = {}) {
  if (!session) {
    return '◔ 上下文: 未知 · 启动 agy 后自动实时显示';
  }
  const pctStr = session.contextPercent !== null && session.contextPercent !== undefined ? `${session.contextPercent}%` : '--%';
  
  // 区分已用量：有真实数值显示压缩数值；无用量但有交互事件显示“暂无数据”；未发生交互显示“未知”
  let usedStr = '未知';
  if (session.contextUsedTokens !== null && session.contextUsedTokens !== undefined) {
    usedStr = formatCompactTokens(session.contextUsedTokens);
  } else if ((session.turnCount || 0) > 0 || (session.stepCount || 0) > 0) {
    usedStr = '暂无数据';
  }

  // 上限注明来源 (用户设置、官方目录、偏好或回退)
  let limitStr = '未知';
  if (session.contextLimitTokens !== null && session.contextLimitTokens !== undefined) {
    const compactLim = formatCompactTokens(session.contextLimitTokens);
    const src = session.contextLimitSource || 'unknown';
    let tag = '';
    if (src === 'cli_settings_contextWindow') tag = '(设置)';
    else if (src === 'model_catalog') tag = '(官方)';
    else if (src.startsWith('per_model_pref')) tag = '(偏好)';
    else tag = '(回退)';
    limitStr = `${compactLim}${tag}`;
  }

  const cacheHitStr = session.cacheHitRate !== null && session.cacheHitRate !== undefined ? `${session.cacheHitRate}%` : '--%';
  
  let totalStr = '0 tok';
  if (session.sessionTotalTokens > 0) {
    totalStr = `${formatCompactTokens(session.sessionTotalTokens)} tok`;
  } else if ((session.turnCount || 0) > 0 || (session.stepCount || 0) > 0) {
    totalStr = session.contextUsedTokens ? `${formatCompactTokens(session.contextUsedTokens)} tok` : '暂无数据';
  }

  const turns = session.turnCount || 0;
  const steps = session.stepCount || (session.turnCount ? session.turnCount * 2 : 0);
  const speedStr = (session.speedTokPerSec !== null && session.speedTokPerSec !== undefined && Number.isFinite(Number(session.speedTokPerSec)))
    ? `${session.speedTokPerSec} tok/s`
    : '— tok/s';

  const maxCols = options.columns || process.stdout.columns || 120;
  const full = `◔ 上下文 ${pctStr} (${usedStr}/${limitStr}) · ${speedStr} · 缓存命中 ${cacheHitStr} · 累计 ${totalStr} · ${turns} 轮 ${steps} 步`;
  if (full.length <= maxCols) return full;

  const mid = `◔ 上下文 ${pctStr} (${usedStr}/${limitStr}) · ${speedStr} · 累计 ${totalStr}`;
  if (mid.length <= maxCols) return mid;

  const compact = `◔ 上下文 ${pctStr} (${usedStr}/${limitStr}) · ${speedStr}`;
  if (compact.length <= maxCols) return compact;

  return `◔ 上下文 ${pctStr} (${usedStr}/${limitStr})`;
}

module.exports = {
  queryCliUsage,
  formatCliUsageText,
  scanCliSessions,
  getSessionDetail,
  maskSessionId,
  renderCliMonitorFrame,
  runCliMonitor,
  resolveCliModelContextBudget,
  saveCliModelContextPreference,
  parseCliWindowString,
  formatCliStatusLine
};
