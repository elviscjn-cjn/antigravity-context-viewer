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
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
    subagentHits: 0,
    stepsCount: 0
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
      if (typeof m === 'string' && m.trim()) out.lastModel = m.trim();
      const usage = obj.usage || obj.chatModel?.usage;
      if (usage && typeof usage === 'object') {
        const inp = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
        const cap = Number(usage.cacheReadTokens ?? usage.cacheTokens ?? 0);
        const outp = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
        const tot = Number(usage.totalTokens ?? (inp + cap + outp));
        if (Number.isFinite(tot) && tot > 0) {
          out.lastUsage = { inputTokens: inp, cacheTokens: cap, outputTokens: outp, totalTokens: tot };
        }
      }
    }
  } catch {}
  return out;
}

/**
 * 解析特定模型在 CLI 下的有效上下文偏好 (立即读取最新设置文件)
 */
function normalizeCliModelMatchKey(raw) {
  const base = core.normalizeModelLookupName?.(raw) || String(raw || '').toLowerCase();
  return base.replace(/[.\s_-]+/g, ' ').trim();
}

function resolveCliModelContextBudget(modelInput, options = {}) {
  const settingsSnap = collector.getPluginSettings({ stateDir: options.stateDir });
  const prefs = settingsSnap?.contextPreferences || {};
  const unified = settingsSnap?.contextUnifiedPreference || null;
  const rawList = Array.isArray(modelInput) ? modelInput : [modelInput];
  const candidates = rawList.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
  const candLowers = candidates.map(v => v.toLowerCase());
  const candNorms = candidates.map(normalizeCliModelMatchKey).filter(Boolean);
  const modelStr = candidates[0] || '';

  let matchedPref = null;
  let matchedKey = null;
  for (const [k, pref] of Object.entries(prefs)) {
    if (!pref || typeof pref !== 'object') continue;
    const kLower = String(k).trim().toLowerCase();
    const kNorm = normalizeCliModelMatchKey(k);
    if (candLowers.includes(kLower) || (kNorm && candNorms.includes(kNorm))) {
      matchedPref = pref;
      matchedKey = k;
      break;
    }
  }
  if (!matchedPref && unified && unified.mode && unified.mode !== 'default') {
    matchedPref = unified;
    matchedKey = 'unified';
  }

  let customLimitTokens = null;
  if (matchedPref) {
    if (matchedPref.mode === 'fixed' && Number.isFinite(Number(matchedPref.limitTokens))) {
      customLimitTokens = Number(matchedPref.limitTokens);
    } else if (matchedPref.mode === 'default') {
      customLimitTokens = 128000;
    }
  }

  const cliSettingsPath = options.cliSettingsPath || path.join(
    options.agCliDir || path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity-cli'),
    'settings.json'
  );
  const cliSettings = readJsonSafe(cliSettingsPath);
  const cliSettingsLimit = parseCliWindowString(cliSettings?.contextWindow);

  let budgetTokens = customLimitTokens;
  let budgetSource = matchedPref ? `per_model_pref:${matchedKey}` : null;

  if (!budgetTokens && modelStr) {
    try {
      const b = core.getModelContextBudget?.(modelStr, options.cascadeModelConfigs || null);
      if (b && Number.isFinite(Number(b.maxTokens)) && Number(b.maxTokens) > 0 && !b.isFallback) {
        budgetTokens = Number(b.maxTokens);
        budgetSource = 'model_catalog';
      }
    } catch {}
  }

  if (!budgetTokens && cliSettingsLimit) {
    budgetTokens = cliSettingsLimit;
    budgetSource = 'cli_settings_contextWindow';
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
 * 保存 CLI 按模型自定义上下文偏好 (立即写入共享设置，并清楚标示对 CLI 进程的生效时机)
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
  const payload = clear
    ? { clearContextPreferences: [cleanModel] }
    : {
        contextPreference: {
          modelId: cleanModel,
          mode,
          limitTokens: mode === 'fixed' ? Number(limitTokens) : null
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
      } else if (mode === 'fixed' && Number.isFinite(Number(limitTokens))) {
        const n = Math.round(Number(limitTokens));
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
    limitTokens: clear ? null : (mode === 'fixed' ? Number(limitTokens) : null),
    contextPreferences: saveRes.contextPreferences || {},
    cliSettingsSynced,
    cliSettingsPath,
    effectiveTiming: {
      cliProcess: 'after_restart',
      desktopRenderer: 'next_request',
      explanation: '配置已立即保存至磁盘. 独立 agy CLI 进程需重启或新开会话后读取新上限 (若受 128K 原生二进制上限限制需先执行 unlock --cli). 桌面端在网关放行下于下一次请求生效.'
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
        contextPercent: null,
        sessionTotalTokens: 0,
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
        if (tail.cwd && !s.cwd) s.cwd = tail.cwd;
        if (tail.lastModel && !s.model) s.model = tail.lastModel;
        if (tail.lastStepAtMs > s.lastActiveMs) s.lastActiveMs = tail.lastStepAtMs;
        if (tail.lastUsage) {
          s.contextUsedTokens = tail.lastUsage.totalTokens;
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
    for (const c of list) {
      const inp = Number(c.inputTokens || 0);
      const cap = Number(c.cacheReadTokens ?? c.cacheTokens ?? 0);
      const outp = Number(c.outputTokens || 0);
      const tot = Number(c.totalTokens ?? (inp + cap + outp));
      sumTokens += tot;
      const ts = Number(c.timestamp || c.updatedAt || (c.created_at ? Date.parse(c.created_at) : 0)) || 0;
      if (ts > s.lastActiveMs) s.lastActiveMs = ts;
      if (c.parentCascadeId && !s.parentSessionId) {
        s.isSubagent = true;
        s.parentSessionId = String(c.parentCascadeId);
      }
      if (c.agentRole === 'subagent') s.isSubagent = true;
    }
    const latest = list[list.length - 1];
    s.requestCount = list.length;
    s.sessionTotalTokens = sumTokens;
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
      agCliDir,
      homeDir: home
    });
    s.contextLimitTokens = budget.limitTokens;
    s.contextLimitSource = budget.budgetSource;
    if (s.contextUsedTokens !== null && s.contextLimitTokens) {
      s.contextPercent = Math.min(999, Math.round((s.contextUsedTokens / s.contextLimitTokens) * 1000) / 10);
    } else {
      s.contextPercent = null;
    }
    if (s.lastActiveMs > 0) {
      s.lastActiveAt = new Date(s.lastActiveMs).toISOString();
      const age = Math.max(0, nowMs - s.lastActiveMs);
      if (age <= activeThresholdMs) s.status = 'active';
      else if (age <= idleThresholdMs) s.status = 'idle';
      else s.status = 'stale';
    }
    sessions.push(s);
  }

  sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return {
    ok: true,
    agCliDir,
    sessionCount: sessions.length,
    sessions,
    scannedAt: new Date(nowMs).toISOString()
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

module.exports = {
  queryCliUsage,
  formatCliUsageText,
  scanCliSessions,
  renderCliMonitorFrame,
  runCliMonitor,
  resolveCliModelContextBudget,
  saveCliModelContextPreference,
  parseCliWindowString
};
