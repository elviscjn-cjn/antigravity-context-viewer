(function (root) {
  'use strict';
  const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function parseDurationSec(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function stripModelVariantTags(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s || /^model_(?:placeholder|unspecified)_?/i.test(s)) return '';
    let prev;
    do {
      prev = s;
      s = s.replace(/\s*\([^)]*\b(?:xhigh|high|medium|med|minimal|min|low|thinking|reasoning|extended|fast|turbo|standard|std|default|preview|experimental|exp|beta|alpha|recommended|new)\b[^)]*\)/gi, '').trim();
    } while (s !== prev);
    do {
      prev = s;
      s = s.replace(/[\s_-]+(?:xhigh|high|medium|med|minimal|min|low|thinking|reasoning|fast|preview)$/gi, '').trim();
    } while (s !== prev);
    return s;
  }

  function pickPreferredModelText(raw, labelFallback = '') {
    const cleanLbl = stripModelVariantTags(labelFallback);
    if (cleanLbl) return cleanLbl;
    const cleanRaw = stripModelVariantTags(raw);
    if (cleanRaw) return cleanRaw;
    const l = String(labelFallback || '').trim();
    const r = String(raw || '').trim();
    if (l && !/^model_(?:placeholder|unspecified)_?/i.test(l)) return l;
    return r || l;
  }

  function getModelPoolKey(raw, labelFallback = '') {
    const preferred = pickPreferredModelText(raw, labelFallback);
    if (!preferred) return 'unknown';
    const base = stripModelVariantTags(preferred) || preferred;
    const slug = base
      .toLowerCase()
      .replace(/(\d)-(\d)/g, '$1.$2')
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || base.toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'unknown';
  }

  function getPoolDisplayName(label, modelId, poolKey) {
    const cleanLbl = stripModelVariantTags(label);
    if (cleanLbl) return cleanLbl;
    const cleanId = stripModelVariantTags(modelId);
    if (cleanId) return cleanId;
    const rawLbl = String(label || '').trim();
    if (rawLbl && !/^model_(?:placeholder|unspecified)_?/i.test(rawLbl)) return rawLbl;
    return poolKey && poolKey !== 'unknown' ? poolKey : '未知模型';
  }

  function formatResetTimeZh(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}月${day}日 ${h}:${min}`;
    } catch {
      return String(isoStr);
    }
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs) {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const targetPoolKey = getModelPoolKey(modelIdOrName);
    const targetStr = String(modelIdOrName).toLowerCase().trim();
    const readCfgId = c => String(c?.modelOrAlias?.model || c?.modelId || c?.model || '').trim();

    // 1. 优先精准匹配 modelId 或 label
    let matched = cascadeModelConfigs.find(c => {
      const mId = readCfgId(c).toLowerCase();
      const lbl = String(c?.label || c?.displayName || '').toLowerCase().trim();
      return (mId && mId === targetStr) || (lbl && lbl === targetStr);
    });

    // 2. 匹配同一规范化模型配额池（忽略 High / Low / XHigh / Thinking 及 placeholder ID 差异）
    if (!matched && targetPoolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(readCfgId(c), c?.label || c?.displayName);
        return cPool === targetPoolKey;
      });
    }

    // 3. 系列前缀回退（如简写 claude-opus 匹配 Claude Opus 4.6）
    if (!matched && targetPoolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(readCfgId(c), c?.label || c?.displayName);
        return cPool !== 'unknown' && (cPool.includes(targetPoolKey) || targetPoolKey.includes(cPool));
      });
    }

    if (!matched) return null;

    const matchedId = readCfgId(matched);
    const matchedLabel = String(matched.label || matched.displayName || matchedId || modelIdOrName).trim();
    const poolKey = getModelPoolKey(matchedId, matchedLabel);
    const displayBase = getPoolDisplayName(matchedLabel, matchedId, poolKey);
    const qi = matched.quotaInfo || matched.quota_info || {};
    const rawFrac = qi.remainingFraction ?? qi.remaining_fraction;
    const remainingFraction = (typeof rawFrac === 'number' && Number.isFinite(rawFrac))
      ? Math.max(0, Math.min(1, rawFrac))
      : ((rawFrac != null && rawFrac !== '' && Number.isFinite(Number(rawFrac))) ? Math.max(0, Math.min(1, Number(rawFrac))) : null);

    return {
      modelId: matchedId,
      label: matchedLabel,
      baseName: displayBase,
      poolKey,
      poolName: displayBase,
      remainingFraction,
      resetTime: qi.resetTime || qi.reset_time || null
    };
  }

  function classifyRequestError(input, options = {}) {
    const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
    const currentModel = options.currentModel || '';
    const cascadeConfigs = options.cascadeModelConfigs || [];
    const modelQuota = resolveModelQuota(currentModel, cascadeConfigs);

    if (!error) {
      return {
        kind: 'none',
        title: '正常',
        badgeText: '正常',
        detail: '',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: modelQuota?.poolName || currentModel || null,
        diagnostic: ''
      };
    }

    // 脱敏清洗诊断摘要（去除非必要的完整 URL 和堆栈冗余）
    let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
    if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

    // 1. 上下文容量超限 (Context Overflow)
    // 明确排除 Go context.DeadlineExceeded 网络超时
    const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
    const overflowMatch = !isDeadlineTimeout && error.match(/input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i);
    if (overflowMatch) {
      const serviceLimit = number(error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', ''));
      return {
        kind: 'context_overflow',
        title: '超限告警',
        badgeText: '超限',
        detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或新建会话`,
        serviceLimit,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 2. 模型或额度池耗尽 (Quota Exhausted)
    const explicitQuotaMatch = /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
    const quotaZeroEvidence = Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);

    if (explicitQuotaMatch || quotaZeroEvidence) {
      const resetTimeZh = modelQuota?.resetTime ? formatResetTimeZh(modelQuota.resetTime) : null;
      const poolName = modelQuota?.poolName || (currentModel ? `${currentModel} 专属配额` : '模型配额');
      return {
        kind: 'quota_exhausted',
        title: '额度耗尽',
        badgeText: '额度耗尽',
        detail: `${poolName}额度已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}。可手动切换其他可用模型`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: modelQuota?.resetTime || null,
        resetTimeZh,
        modelOrPool: poolName,
        diagnostic
      };
    }

    // 3. 请求频率限制 (Rate Limited)
    const rateLimitMatch = /(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error);
    if (rateLimitMatch) {
      const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
      const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
      return {
        kind: 'rate_limited',
        title: '请求限流',
        badgeText: '限流',
        detail: `请求过于频繁，触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}`,
        serviceLimit: null,
        retryAfterSec,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 4. 用户主动取消或请求中断 (Canceled)
    const canceledMatch = /(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error);
    if (canceledMatch) {
      return {
        kind: 'canceled',
        title: '已取消',
        badgeText: '已取消',
        detail: '本次生成请求已由用户或系统主动取消',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 5. 身份认证与权限错误 (Auth / Permission)
    const authMatch = /(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error);
    if (authMatch) {
      return {
        kind: 'auth_error',
        title: '认证异常',
        badgeText: '认证',
        detail: '身份认证失败或缺少访问权限，请检查账号登录状态或订阅权限',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 6. 服务暂不可用 (Service Unavailable)
    const unavailMatch = /(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error);
    if (unavailMatch) {
      return {
        kind: 'service_unavailable',
        title: '服务受限',
        badgeText: '服务异常',
        detail: '模型服务暂时过载或不可用，请稍后重试',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 7. 明确网络连接失败或超时 (Network Error)
    const netMatch = /(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error);
    if (netMatch) {
      let cleanNet = '连接失败或超时';
      if (/deadline exceeded|timeout/i.test(error)) cleanNet = '连接或读取超时';
      else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = '连接被对端重置';
      else if (/ECONNREFUSED/i.test(error)) cleanNet = '连接被拒绝';
      else if (/ENOTFOUND/i.test(error)) cleanNet = 'DNS 域名解析失败';
      else if (/\bEOF\b/i.test(error)) cleanNet = '服务端过早关闭连接 (EOF)';

      return {
        kind: 'network_error',
        title: '网络故障',
        badgeText: '网络',
        detail: `网络连接异常（${cleanNet}），请检查网络代理及本地连接`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 8. 兜底：原因待确认 (Unknown)
    return {
      kind: 'unknown',
      title: '原因待确认',
      badgeText: '待确认',
      detail: `请求失败，当前无法确认具体原因（${diagnostic}）`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';

    // 执行结构化错误分类
    const classification = error ? classifyRequestError(error, {
      currentModel: model,
      cascadeModelConfigs: options.cascadeModelConfigs || [],
      userStatus: options.userStatus || null
    }) : { kind: 'none' };

    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = number(usage?.inputTokens), cached = number(usage?.cacheReadTokens), output = number(usage?.outputTokens);
    const thinking = number(usage?.thinkingOutputTokens), responseTokens = number(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cached || 0) > 0;

    // 解耦维度：错误发生时不强制归零已有上下文用量
    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const estimate = number(context?.estimatedTokensUsed) || prevContext?.estimate || null;
    const budget = number(context?.maxContextTokens) || prevContext?.budget || null;

    // 计算生成耗时与输出速度 (Tokens Per Second)
    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
    let tps = null;
    if (output && duration && duration > 0) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec > 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const speed = (tps !== null || duration !== null || output !== null) ? {
      tps,
      streamingTps,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0)
    } : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    const usedVal = actual ?? (estimate > 0 ? estimate : null);
    const percentVal = actual !== null && budget > 0 && !exceeded ? (actual / budget * 100) : null;

    return {
      used: usedVal,
      actual,
      estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification: classification,
      estimated: actual === null,
      input: hasInput ? (input || 0) + (cached || 0) : (prevContext?.input || null),
      cached: cached || prevContext?.cached || 0,
      output: output ?? (prevContext?.output ?? null),
      percent: percentVal,
      model,
      status,
      speed
    };
  }
  function measure(text) {
    text = String(text || '');
    let chars = 0, bytes = 0, cjk = 0;
    for (const char of text) { const c = char.codePointAt(0); chars++; bytes += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4; if (c >= 0x2e80 && c <= 0x9fff || c >= 0xf900 && c <= 0xfaff) cjk++; }
    const middle = (chars - cjk) / 4 + cjk * 1.2;
    return { chars, bytes, low: Math.ceil(middle * .7), high: Math.ceil(Math.max(middle * 1.6, bytes / 2)) };
  }
  function add(a, b) { for (const k of ['chars', 'bytes', 'low', 'high']) a[k] += b[k] || 0; return a; }
  const empty = () => ({ chars: 0, bytes: 0, low: 0, high: 0 });
  function analyzeSteps(steps) {
    const groups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty(), summaries: empty() };
    const media = new Map();
    let userMessages = 0, assistantMessages = 0, latestStepError = null, lastUserAt = -1, lastAssistantAt = -1;
    const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
    function content(value) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (!value) return '';
      if (Array.isArray(value)) return value.map(content).join('\n');
      return Object.entries(value).filter(([key]) => !skip.has(key)).map(([key, v]) => `${key}: ${content(v)}`).join('\n');
    }
    function attachments(value, source, withinStep = new Set()) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) attachments(v, source, withinStep); return; }
      if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
        const key = String(value.uri);
        if (!withinStep.has(key)) { withinStep.add(key); const prior = media.get(key); if (prior) prior.references++; else media.set(key, { uri: key, name: String(value.description || key.split(/[\\/]/).pop()), mime: String(value.mimeType || ''), references: 1, source }); }
      } else if (value.inlineData && !value.uri) {
        const key = `inline-${media.size}`;
        const rawData = typeof value.inlineData === 'string' ? value.inlineData : (value.inlineData.data || '');
        const mime = String(value.mimeType || value.inlineData.mimeType || '');
        if (!withinStep.has(key)) {
          withinStep.add(key);
          media.set(key, {
            uri: `inline:${key}`,
            inlineData: rawData,
            name: String(value.description || (mime.startsWith('image/') ? '内嵌图像' : '内嵌附件')),
            mime,
            references: 1,
            source
          });
        }
      }
      for (const [key, v] of Object.entries(value)) if (!skip.has(key) || key === 'media') attachments(v, source, withinStep);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.userInput) {
        userMessages++; lastUserAt = i;
        const u = s.userInput;
        add(groups.user, measure(u.userResponse || (u.items || []).map(item => item.text || '').join('\n')));
        // Canonical media and item inline previews represent the same upload.
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++; lastAssistantAt = i;
        add(groups.assistant, measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || ''));
        add(groups.thinking, measure(s.plannerResponse.thinking || ''));
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = { index: i, text: e.modelErrorMessage || e.shortError || e.fullError || '', id: e.errorId || '' };
      } else if (s.checkpoint) {
        add(groups.summaries, measure(s.checkpoint.sessionSummary || ''));
      } else {
        const payload = Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'status', 'metadata', 'error'].includes(k)));
        add(groups.tools, measure(content(payload)));
        attachments(payload, 'assistant');
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    return { groups, total, media: [...media.values()], steps: steps.length, userMessages, assistantMessages, currentError };
  }

  // 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
  // 来源: https://ai.google.dev/gemini-api/docs/pricing
  // 核对日期: 2026-11-08
  const GEMINI_PRICING_TABLE = {
    'gemini-3.8-flash': [
      {
        effectiveTo: '2026-12-31',
        inputPerMillion: 0.75,
        outputPerMillion: 3.75,
        cacheReadPerMillion: 0.075
      },
      {
        effectiveFrom: '2027-01-01',
        inputPerMillion: 1.50,
        outputPerMillion: 7.50,
        cacheReadPerMillion: 0.15
      }
    ],
    'gemini-4-argon': [
      {
        effectiveTo: '2026-11-30',
        inputPerMillion: 2.00,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.10
      },
      {
        effectiveFrom: '2026-12-01',
        inputPerMillion: 4.00,
        outputPerMillion: 20.00,
        cacheReadPerMillion: 0.20
      }
    ],
    'gemini-3.1-pro-preview': [
      {
        maxPromptTokens: 200000,
        inputPerMillion: 2.00,
        outputPerMillion: 12.00,
        cacheReadPerMillion: 0.20
      },
      {
        minPromptTokens: 200001,
        inputPerMillion: 4.00,
        outputPerMillion: 18.00,
        cacheReadPerMillion: 0.40
      }
    ],
    'gemini-3.5-flash-lite': [
      {
        inputPerMillion: 0.30,
        outputPerMillion: 2.50,
        cacheReadPerMillion: 0.03
      }
    ],
    'gemini-2.5-pro': [
      {
        maxPromptTokens: 200000,
        inputPerMillion: 1.25,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.125
      },
      {
        minPromptTokens: 200001,
        inputPerMillion: 2.50,
        outputPerMillion: 15.00,
        cacheReadPerMillion: 0.25
      }
    ]
  };

  function extractModelString(req) {
    if (!req) return '';
    if (typeof req === 'string') return req;
    const cm = req.chatModel;
    return cm?.modelDisplayName || cm?.responseModel || cm?.model || req.modelDisplayName || req.responseModel || req.model || req.chatModel || req.modelId || '';
  }

  function normalizeModelId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const str = raw.trim().toLowerCase();
    if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
    if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon')) return 'gemini-4-argon';
    if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
    if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
    if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
    return null;
  }

  function calculateRequestApiCost(req) {
    if (!req) return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
    const rawModel = extractModelString(req);
    const modelKey = normalizeModelId(rawModel);
    if (!modelKey || !GEMINI_PRICING_TABLE[modelKey]) {
      return { costUSD: null, isPriced: false, modelKey: null, rawModel, reason: !rawModel ? '缺模型名称' : '未知模型或无官方公开费率' };
    }
    const input = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
    const cache = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
    const output = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
    const thinking = Number(req.thinkingTokens ?? req.thinking_output_tokens ?? req.thinking ?? 0);
    const totalPrompt = input + cache;

    const reqDate = req.date ? String(req.date).slice(0, 10) : req.created_at ? String(req.created_at).slice(0, 10) : '2026-11-08';
    const tierRules = GEMINI_PRICING_TABLE[modelKey];
    let matchedTier = null;

    for (const rule of tierRules) {
      if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
      if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
      if (rule.maxPromptTokens && totalPrompt > rule.maxPromptTokens) continue;
      if (rule.minPromptTokens && totalPrompt < rule.minPromptTokens) continue;
      matchedTier = rule;
      break;
    }

    if (!matchedTier) {
      matchedTier = tierRules[0];
    }

    const costInput = (input * matchedTier.inputPerMillion) / 1000000;
    const costCache = (cache * matchedTier.cacheReadPerMillion) / 1000000;
    const costOutput = (output * matchedTier.outputPerMillion) / 1000000;
    const totalCost = costInput + costCache + costOutput;

    return {
      costUSD: Number(totalCost.toFixed(6)),
      isPriced: true,
      modelKey,
      matchedTier,
      inputTokens: input,
      cacheTokens: cache,
      cacheReadTokens: cache,
      outputTokens: output,
      thinkingTokens: thinking,
      totalTokens: input + cache + output
    };
  }

  function summarizeApiCost(requests = [], extraUnpricedCount = 0, extraUnpricedReasons = {}, extraUnpricedTokens = 0) {
    let pricedCostUSD = 0;
    let pricedTokens = 0;
    let pricedInputTokens = 0;
    let pricedCacheTokens = 0;
    let pricedOutputTokens = 0;
    let pricedThinkingTokens = 0;
    let unpricedTokens = Number(extraUnpricedTokens) || 0;
    let pricedRequestsCount = 0;
    let unpricedRequestsCount = Number(extraUnpricedCount) || 0;
    const unpricedReasons = {
      missingModel: Number(extraUnpricedReasons.missingModel || 0),
      unsupportedModel: Number(extraUnpricedReasons.unsupportedModel || 0),
      missingUsage: Number(extraUnpricedReasons.missingUsage || 0)
    };
    const byModel = {};

    for (const req of requests) {
      const calc = calculateRequestApiCost(req);
      if (calc.isPriced) {
        pricedCostUSD += calc.costUSD;
        pricedTokens += calc.totalTokens;
        pricedInputTokens += (calc.inputTokens || 0);
        pricedCacheTokens += (calc.cacheTokens || 0);
        pricedOutputTokens += (calc.outputTokens || 0);
        pricedThinkingTokens += (calc.thinkingTokens || 0);
        pricedRequestsCount += 1;
        if (!byModel[calc.modelKey]) {
          byModel[calc.modelKey] = { requests: 0, costUSD: 0, tokens: 0 };
        }
        byModel[calc.modelKey].requests += 1;
        byModel[calc.modelKey].costUSD = Number((byModel[calc.modelKey].costUSD + calc.costUSD).toFixed(6));
        byModel[calc.modelKey].tokens += calc.totalTokens;
      } else {
        unpricedRequestsCount += 1;
        const inp = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
        const cap = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
        const outp = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
        const tot = inp + cap + outp;
        unpricedTokens += tot;
        const rawM = extractModelString(req);
        if (!rawM) unpricedReasons.missingModel += 1;
        else if (tot === 0) unpricedReasons.missingUsage += 1;
        else unpricedReasons.unsupportedModel += 1;
      }
    }

    const totalRequests = pricedRequestsCount + unpricedRequestsCount;
    let coveragePercent = null;
    let tokenCoveragePercent = null;
    let requestCoveragePercent = null;
    let isPartialCoverage = false;

    if (totalRequests > 0) {
      requestCoveragePercent = Number(((pricedRequestsCount / totalRequests) * 100).toFixed(1));
      const totalTok = pricedTokens + unpricedTokens;
      if (totalTok > 0) {
        tokenCoveragePercent = Number(((pricedTokens / totalTok) * 100).toFixed(1));
      }
      if (pricedRequestsCount === 0) {
        coveragePercent = 0;
      } else if (unpricedRequestsCount > 0) {
        isPartialCoverage = true;
        // 当存在未计价历史记录且未知 token 未计时，不能虚假呈现 100% 覆盖
        if (unpricedTokens === 0) {
          coveragePercent = requestCoveragePercent;
        } else {
          coveragePercent = Math.min(tokenCoveragePercent ?? requestCoveragePercent, requestCoveragePercent);
        }
        if (coveragePercent >= 100) coveragePercent = 99.9;
      } else {
        coveragePercent = 100;
      }
    }

    return {
      pricedCostUSD: Number((Math.round((pricedCostUSD + Number.EPSILON) * 10000) / 10000).toFixed(4)),
      pricedRequestsCount,
      unpricedRequestsCount,
      pricedTokens,
      unpricedTokens,
      byCategory: {
        inputTokens: pricedInputTokens,
        cacheTokens: pricedCacheTokens,
        outputTokens: pricedOutputTokens,
        thinkingTokens: pricedThinkingTokens
      },
      coveragePercent,
      tokenCoveragePercent,
      requestCoveragePercent,
      isPartialCoverage,
      unpricedReasons,
      byModel
    };
  }

  function parseGeneratorCall(row, cascadeId = null, source = 'desktop') {
    if (!row || typeof row !== 'object') return null;
    const cm = row.chatModel || {};
    const u = cm.usage || {};
    const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';
    const modelKey = normalizeModelId(model);

    const input = Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0);
    const cached = Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0);
    const output = Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? (output - thinking > 0 ? output - thinking : output));

    const callId = String(u.responseId || u.messageId || row.callId || row.responseId || (cascadeId ? `${cascadeId}#${(row.stepIndices?.[0] ?? row.stepIndex ?? 0)}` : ''));
    if (!callId) return null;

    // 完成状态管理：依据完成标记或耗时证据判定 final，流式中或只有部分文本时判定 streaming
    const hasExplicitFinish = Boolean(
      row.status === 'final' ||
      row.status === 'completed' ||
      cm.finishReason ||
      row.finishReason ||
      row.done === true ||
      (cm.streamingDuration != null && cm.timeToFirstToken != null)
    );
    const hasUsage = (input + cached + output) > 0;
    const status = hasExplicitFinish || (hasUsage && !row.isStreaming && row.status !== 'streaming') ? 'final' : 'streaming';
    const isEstimated = !hasUsage || output === 0;

    // 日期与时间戳：严格提取真实创建时间，不默认将历史记录替换为今天
    let callDate = null;
    let callTimestamp = null;
    const rawCreatedAt = row.created_at || row.createdAt || row.timestamp;
    if (rawCreatedAt) {
      const dt = new Date(rawCreatedAt);
      if (!Number.isNaN(dt.getTime())) {
        callDate = dt.toISOString().slice(0, 10);
        callTimestamp = dt.getTime();
      }
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      callDate = String(row.date).slice(0, 10);
      callTimestamp = new Date(callDate).getTime();
    } else if (source === 'desktop' && typeof window !== 'undefined') {
      callTimestamp = Date.now();
      callDate = new Date(callTimestamp).toISOString().slice(0, 10);
    }

    const reqObj = {
      model,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      date: callDate
    };
    const costCalc = calculateRequestApiCost(reqObj);

    return {
      callId,
      source,
      cascadeId,
      model,
      modelKey,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      status,
      isEstimated,
      isPriced: costCalc.isPriced,
      costUSD: costCalc.costUSD ?? 0,
      date: callDate,
      created_at: rawCreatedAt ? String(rawCreatedAt) : (callTimestamp ? new Date(callTimestamp).toISOString() : null),
      timestamp: callTimestamp
    };
  }

  function parseUserPlanStatus(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        planName: '未知',
        email: null,
        region: '未知',
        currency: 'USD',
        billingCycle: '未知',
        officialPriceMonthly: null,
        priceRangeNote: '未知',
        actualPricePaid: null,
        isPriceEstimated: true,
        promptCredits: null,
        flowCredits: null,
        pricingTableVerifiedDate: '2026-11-08',
        updatedAt: null
      };
    }
    const us = raw.userStatus || raw;
    const userTier = us.userTier || {};
    const planStatus = us.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const email = us.email || null;
    const rawTierName = String(userTier.name || planInfo.planName || '').trim();
    const cascadeModelConfigs = Array.isArray(us?.cascadeModelConfigData?.clientModelConfigs)
      ? us.cascadeModelConfigData.clientModelConfigs
      : (Array.isArray(raw?.cascadeModelConfigs) ? raw.cascadeModelConfigs : []);
    const quotaSummary = us.quotaSummary || raw.quotaSummary || raw.userQuotaSummary || (Array.isArray(us.groups || raw.groups) ? { groups: us.groups || raw.groups } : null);

    // 只有具备明确权益证据时才识别套餐，避免空对象或缺省状态被当成 Free
    const hasTierEvidence = Boolean(
      rawTierName ||
      userTier.id ||
      planStatus.availablePromptCredits !== undefined ||
      planInfo.monthlyPromptCredits !== undefined
    );

    if (!hasTierEvidence) {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        planName: '未知',
        email,
        region: '未知',
        currency: 'USD',
        billingCycle: '未知',
        officialPriceMonthly: null,
        priceRangeNote: '未知',
        actualPricePaid: null,
        isPriceEstimated: true,
        promptCredits: null,
        flowCredits: null,
        cascadeModelConfigs,
        quotaSummary,
        pricingTableVerifiedDate: '2026-11-08',
        updatedAt: null
      };
    }

    let tierKey = 'unknown';
    let tierDisplayName = '未知';
    let officialPrice = null;
    let priceRange = null;

    if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '')) {
      tierKey = 'ultra';
      const subTierMatch = rawTierName.match(/ultra\s*([0-9a-zA-Z\-_]+)/i);
      if (subTierMatch && !['plan', 'tier'].includes(subTierMatch[1].toLowerCase())) {
        tierDisplayName = `Google AI Ultra (${subTierMatch[1]})`;
        officialPrice = null;
        priceRange = '子档定制费率未知';
      } else {
        tierDisplayName = 'Google AI Ultra（子档未知）';
        officialPrice = null;
        priceRange = '参考区间 $99.99 ~ $249.99/月（子档未知）';
      }
    } else if (/pro/i.test(rawTierName) || /pro/i.test(userTier.id || '')) {
      tierKey = 'pro';
      tierDisplayName = 'Google AI Pro';
      officialPrice = 19.99;
      priceRange = '$19.99/月（公开参考）';
    } else if (/plus/i.test(rawTierName) || /plus/i.test(userTier.id || '')) {
      tierKey = 'plus';
      tierDisplayName = 'Google AI Plus';
      officialPrice = 4.99;
      priceRange = '$4.99/月（公开参考）';
    } else if (/free/i.test(rawTierName) || /free/i.test(userTier.id || '')) {
      tierKey = 'free';
      tierDisplayName = 'Free';
      officialPrice = 0;
      priceRange = '$0/月（公开参考）';
    } else {
      tierKey = 'custom';
      tierDisplayName = rawTierName || '未知套餐';
      officialPrice = null;
      priceRange = '费率未知';
    }

    return {
      status: 'identified',
      tierKey,
      tierName: tierDisplayName,
      tierId: userTier.id || null,
      planName: planInfo.planName || tierDisplayName,
      email,
      region: '未知',
      currency: 'USD',
      billingCycle: officialPrice !== null ? '月付 · 公开参考' : '未知',
      officialPriceMonthly: officialPrice,
      priceRangeNote: priceRange,
      actualPricePaid: null,
      isPriceEstimated: true,
      promptCredits: {
        available: planStatus.availablePromptCredits ?? null,
        monthly: planInfo.monthlyPromptCredits ?? null
      },
      flowCredits: {
        available: planStatus.availableFlowCredits ?? null,
        monthly: planInfo.monthlyFlowCredits ?? null
      },
      cascadeModelConfigs,
      quotaSummary,
      pricingTableVerifiedDate: '2026-11-08',
      updatedAt: new Date().toISOString()
    };
  }

  function calculateReferenceModelCost(tokenTotals = {}, modelKey = 'gemini-3.8-flash', options = {}) {
    if (!tokenTotals || typeof tokenTotals !== 'object') {
      tokenTotals = {};
    }
    const input = Number(tokenTotals.inputTokens ?? tokenTotals.input ?? tokenTotals.totalInputTokens ?? 0);
    const cache = Number(tokenTotals.cacheTokens ?? tokenTotals.cacheReadTokens ?? tokenTotals.cache ?? tokenTotals.totalCacheTokens ?? 0);
    const output = Number(tokenTotals.outputTokens ?? tokenTotals.output ?? tokenTotals.totalOutputTokens ?? 0);
    const total = Number(tokenTotals.totalTokens ?? tokenTotals.total ?? tokenTotals.grandTotalTokens ?? (input + cache + output));
    const hasBreakdown = (input + cache + output) > 0;

    const normKey = normalizeModelId(modelKey) || 'gemini-3.8-flash';
    const tierRules = GEMINI_PRICING_TABLE[normKey] || GEMINI_PRICING_TABLE['gemini-3.8-flash'];
    const reqDate = options.pricingDate ? String(options.pricingDate).slice(0, 10) : '2026-11-08';
    let matchedTier = tierRules[0];
    for (const rule of tierRules) {
      if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
      if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
      matchedTier = rule;
      break;
    }

    let inputCost = 0;
    let cacheCost = 0;
    let outputCost = 0;
    let totalCost = 0;
    let unpricedTokens = 0;

    if (hasBreakdown) {
      inputCost = (input * matchedTier.inputPerMillion) / 1000000;
      cacheCost = (cache * matchedTier.cacheReadPerMillion) / 1000000;
      outputCost = (output * matchedTier.outputPerMillion) / 1000000;
      totalCost = inputCost + cacheCost + outputCost;
    } else if (total > 0) {
      if (options.simulationSplit && typeof options.simulationSplit === 'object') {
        const inRatio = Number(options.simulationSplit.inputRatio || 0.8);
        const outRatio = Number(options.simulationSplit.outputRatio || 0.2);
        const simIn = total * inRatio;
        const simOut = total * outRatio;
        inputCost = (simIn * matchedTier.inputPerMillion) / 1000000;
        outputCost = (simOut * matchedTier.outputPerMillion) / 1000000;
        totalCost = inputCost + outputCost;
      } else {
        unpricedTokens = total;
      }
    }

    // 混合模式：已识别按实际模型，仅未知部分按参考模型折算（精确按分类扣除残差）
    let hybrid = null;
    if (options.mode === 'unpriced_only' || options.knownUsage) {
      const ku = options.knownUsage || {};
      const knownIn = Number(ku.inputTokens ?? ku.byCategory?.inputTokens ?? ku.input ?? 0);
      const knownCache = Number(ku.cacheTokens ?? ku.cacheReadTokens ?? ku.byCategory?.cacheTokens ?? ku.cache ?? 0);
      const knownOut = Number(ku.outputTokens ?? ku.byCategory?.outputTokens ?? ku.output ?? 0);
      const knownCost = Number(ku.costUSD ?? ku.pricedCostUSD ?? 0);

      const residualIn = Math.max(0, input - knownIn);
      const residualCache = Math.max(0, cache - knownCache);
      const residualOut = Math.max(0, output - knownOut);

      const resInCost = (residualIn * matchedTier.inputPerMillion) / 1000000;
      const resCacheCost = (residualCache * matchedTier.cacheReadPerMillion) / 1000000;
      const resOutCost = (residualOut * matchedTier.outputPerMillion) / 1000000;
      const resTotalCost = resInCost + resCacheCost + resOutCost;

      const combined = resTotalCost === 0 ? knownCost : Number((knownCost + resTotalCost).toFixed(4));
      hybrid = {
        knownCostUSD: knownCost,
        unpricedResidualTokens: residualIn + residualCache + residualOut,
        unpricedResidualCostUSD: Number(resTotalCost.toFixed(4)),
        combinedTotalUSD: combined,
        residualTokensBreakdown: {
          input: residualIn,
          cache: residualCache,
          output: residualOut,
          inputCostUSD: Number(resInCost.toFixed(4)),
          cacheCostUSD: Number(resCacheCost.toFixed(4)),
          outputCostUSD: Number(resOutCost.toFixed(4))
        }
      };
    }

    const modelNameMap = {
      'gemini-3.8-flash': 'Gemini 3.8 Flash Standard',
      'gemini-4-argon': 'Gemini 4 Argon',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
      'gemini-2.5-pro': 'Gemini 2.5 Pro'
    };

    return {
      modelKey: normKey,
      modelDisplayName: modelNameMap[normKey] || normKey,
      pricingDate: reqDate,
      matchedTier,
      hasBreakdown,
      inputTokens: input,
      cacheTokens: cache,
      cacheReadTokens: cache,
      outputTokens: output,
      totalTokens: total,
      inputCostUSD: Number(inputCost.toFixed(4)),
      cacheCostUSD: Number(cacheCost.toFixed(4)),
      outputCostUSD: Number(outputCost.toFixed(4)),
      totalCostUSD: Number(totalCost.toFixed(4)),
      formattedTotalUSD: Number(totalCost.toFixed(2)),
      categoryBreakdown: {
        input: {
          tokens: input,
          ratePerMillion: matchedTier.inputPerMillion,
          costUSD: Number(inputCost.toFixed(4))
        },
        cache: {
          tokens: cache,
          ratePerMillion: matchedTier.cacheReadPerMillion,
          costUSD: Number(cacheCost.toFixed(4))
        },
        output: {
          tokens: output,
          ratePerMillion: matchedTier.outputPerMillion,
          costUSD: Number(outputCost.toFixed(4))
        }
      },
      isSimulation: !hasBreakdown && total > 0 && !!options.simulationSplit,
      unpricedTokens,
      hybrid,
      exclusionsNote: '估值未包含项目：缓存存储费用、超大上下文单请求分档溢价、向量检索与搜索接地费用。',
      pricingNote: '缓存读取按官方 10% 优惠费率折算，不作普通输入计价；输出已含 thinking token，不重复计算。'
    };
  }

  // 官方依据订阅获取方式预设表 (核对日期: 2026-11-09)
  const SUBSCRIPTION_ACQUISITION_PRESETS = [
    {
      id: 'normal_paid',
      name: '正常付费订阅',
      category: 'paid',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://one.google.com/about/plans',
      defaultPaid: 19.99,
      note: '按月或按年常规全额付费订阅'
    },
    {
      id: 'student_offer',
      name: '学生认证优惠 (Google One AI Student)',
      category: 'discount',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://support.google.com/googleone/thread/460703251/updates-to-google-one-ai-student-offers-for-2026',
      defaultPaid: 0,
      note: '学生资格验证试用或专享折扣 (按地区提供 Plus/Pro)'
    },
    {
      id: 'pixel_bundle',
      name: 'Google Pixel 设备赠送',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://support.google.com/pixelphone/answer/13529884',
      defaultPaid: 0,
      note: '购买指定 Pixel 机型附赠权益 (如 Pixel 11 Pro 系列赠送 6 个月)'
    },
    {
      id: 'chromebook_bundle',
      name: 'Chromebook Plus 设备赠送',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.google.com/chromebook/chromebookplus/',
      defaultPaid: 0,
      note: '符合资格的 Chromebook Plus 设备赠送 Google AI Pro 权益'
    },
    {
      id: 'samsung_galaxy',
      name: 'Samsung Galaxy 设备指定活动',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.samsung.com/hk_en/offer/content-services-offer/tnc/',
      defaultPaid: 0,
      note: '指定 Galaxy 机型区域专享 Google AI Pro 活动 (需在有效领取期内)'
    },
    {
      id: 'jio_offer',
      name: 'Jio 运营商套餐权益',
      category: 'partner',
      status: 'expired_claim_active_use',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.jio.com/help/faq/mobile/offers/google-gemini-offer/',
      defaultPaid: 0,
      note: '历史活动 (新领取已截止，已成功兑换者享有最长 18 个月权益)'
    },
    {
      id: 'partner_carrier',
      name: '其他运营商 / 合作伙伴权益',
      category: 'partner',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '宽带、通信套餐或第三方平台绑定的 AI 订阅权益'
    },
    {
      id: 'family_sharing',
      name: '家庭组共享 / 他人赠送',
      category: 'sharing',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '加入家庭组成员车位或受赠权益 (非公开促销)'
    },
    {
      id: 'official_promo',
      name: 'Google 官方限时试用 / 促销活动',
      category: 'promo',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '新用户首月免费或其他官方优惠码兑换'
    },
    {
      id: 'custom_source',
      name: '其他 / 自由自定义来源',
      category: 'custom',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: null,
      note: '用户自定义填写的特定渠道或活动'
    }
  ];

  const CURRENCY_SYMBOLS = {
    USD: '$',
    CNY: '¥',
    JPY: '¥',
    HKD: 'HK$',
    EUR: '€',
    GBP: '£',
    SGD: 'S$',
    TRY: '₺',
    NGN: '₦',
    TWD: 'NT$',
    PHP: '₱',
    INR: '₹',
    BRL: 'R$',
    CAD: 'CA$',
    AUD: 'AU$',
    MYR: 'RM ',
    KRW: '₩',
    NZD: 'NZ$',
    THB: '฿',
    VND: '₫',
    IDR: 'Rp ',
    PKR: '₨ ',
    MXN: '$',
    ARS: '$',
    CLP: '$',
    COP: '$',
    PEN: 'S/ ',
    CHF: 'CHF ',
    UAH: '₴',
    PLN: 'zł ',
    SEK: 'kr ',
    NOK: 'kr ',
    DKK: 'kr ',
    CZK: 'Kč ',
    HUF: 'Ft ',
    RON: 'lei ',
    ZAR: 'R ',
    EGP: 'E£ ',
    KES: 'KSh ',
    AED: 'AED ',
    SAR: 'SAR ',
    ILS: '₪ '
  };

  // 订阅地区参考价与静态汇率，供本地估算使用 (基准货币: CNY)
  const SUBSCRIPTION_REGIONS_PRESET = [
    // 亚太与大洋洲
    { id: 'TW', name: '中国台湾', flag: '🇹🇼', currency: 'TWD', symbol: 'NT$', monthlyPrice: 650, rateToCNY: 0.21, aliases: ['tw', 'ntd', 'twd', 'taiwan', '台湾', '中国台湾', '台区'] },
    { id: 'HK', name: '中国香港', flag: '🇭🇰', currency: 'HKD', symbol: 'HK$', monthlyPrice: 158.00, rateToCNY: 0.857, aliases: ['hk', 'hong kong', '香港', '中国香港', '港区'] },
    { id: 'JP', name: '日本', flag: '🇯🇵', currency: 'JPY', symbol: '¥', monthlyPrice: 2900, rateToCNY: 0.0425, aliases: ['jp', 'japan', '日本', '日区'] },
    { id: 'KR', name: '韩国', flag: '🇰🇷', currency: 'KRW', symbol: '₩', monthlyPrice: 29000, rateToCNY: 0.0051, aliases: ['kr', 'korea', 'south korea', '韩国', '韩区'] },
    { id: 'AU', name: '澳大利亚 (澳区)', flag: '🇦🇺', currency: 'AUD', symbol: 'AU$', monthlyPrice: 32.99, rateToCNY: 4.45, aliases: ['au', 'aud', 'australia', '澳大利亚', '澳洲', '澳区'] },
    { id: 'NZ', name: '新西兰', flag: '🇳🇿', currency: 'NZD', symbol: 'NZ$', monthlyPrice: 34.99, rateToCNY: 4.05, aliases: ['nz', 'nzd', 'new zealand', '新西兰'] },
    { id: 'SG', name: '新加坡', flag: '🇸🇬', currency: 'SGD', symbol: 'S$', monthlyPrice: 27.99, rateToCNY: 5.12, aliases: ['sg', 'singapore', '新加坡', '星洲'] },
    { id: 'MY', name: '马来西亚', flag: '🇲🇾', currency: 'MYR', symbol: 'RM ', monthlyPrice: 97.99, rateToCNY: 1.55, aliases: ['my', 'myr', 'malaysia', '马来西亚', '大马'] },
    { id: 'TH', name: '泰国', flag: '🇹🇭', currency: 'THB', symbol: '฿', monthlyPrice: 750, rateToCNY: 0.20, aliases: ['th', 'thb', 'thailand', '泰国'] },
    { id: 'VN', name: '越南', flag: '🇻🇳', currency: 'VND', symbol: '₫', monthlyPrice: 489000, rateToCNY: 0.00028, aliases: ['vn', 'vnd', 'vietnam', '越南'] },
    { id: 'ID', name: '印度尼西亚', flag: '🇮🇩', currency: 'IDR', symbol: 'Rp ', monthlyPrice: 309000, rateToCNY: 0.00044, aliases: ['id', 'idr', 'indonesia', '印度尼西亚', '印尼'] },
    { id: 'PH', name: '菲律宾', flag: '🇵🇭', currency: 'PHP', symbol: '₱', monthlyPrice: 1100, rateToCNY: 0.117, aliases: ['ph', 'php', 'philippines', '菲律宾'] },
    { id: 'IN', name: '印度', flag: '🇮🇳', currency: 'INR', symbol: '₹', monthlyPrice: 1950, rateToCNY: 0.076, aliases: ['in', 'inr', 'india', '印度', '印区'] },
    { id: 'PK', name: '巴基斯坦', flag: '🇵🇰', currency: 'PKR', symbol: '₨ ', monthlyPrice: 5600, rateToCNY: 0.024, aliases: ['pk', 'pkr', 'pakistan', '巴基斯坦'] },

    // 北美与拉美
    { id: 'US', name: '美国', flag: '🇺🇸', currency: 'USD', symbol: '$', monthlyPrice: 19.99, rateToCNY: 6.72, aliases: ['us', 'usa', 'united states', '美国', '美区'] },
    { id: 'CA', name: '加拿大', flag: '🇨🇦', currency: 'CAD', symbol: 'CA$', monthlyPrice: 26.99, rateToCNY: 4.88, aliases: ['ca', 'cad', 'canada', '加拿大'] },
    { id: 'MX', name: '墨西哥', flag: '🇲🇽', currency: 'MXN', symbol: '$', monthlyPrice: 395, rateToCNY: 0.36, aliases: ['mx', 'mxn', 'mexico', '墨西哥'] },
    { id: 'BR', name: '巴西', flag: '🇧🇷', currency: 'BRL', symbol: 'R$', monthlyPrice: 96.99, rateToCNY: 1.18, aliases: ['br', 'brl', 'brazil', '巴西'] },
    { id: 'TR', name: '土耳其', flag: '🇹🇷', currency: 'TRY', symbol: '₺', monthlyPrice: 869.99, rateToCNY: 0.133, aliases: ['tr', 'try', 'turkey', '土耳其', '土区'] },
    { id: 'AR', name: '阿根廷', flag: '🇦🇷', currency: 'ARS', symbol: '$', monthlyPrice: 19999, rateToCNY: 0.0065, aliases: ['ar', 'ars', 'argentina', '阿根廷'] },
    { id: 'CL', name: '智利', flag: '🇨🇱', currency: 'CLP', symbol: '$', monthlyPrice: 18990, rateToCNY: 0.0072, aliases: ['cl', 'clp', 'chile', '智利'] },
    { id: 'CO', name: '哥伦比亚', flag: '🇨🇴', currency: 'COP', symbol: '$', monthlyPrice: 84900, rateToCNY: 0.0016, aliases: ['co', 'cop', 'colombia', '哥伦比亚'] },
    { id: 'PE', name: '秘鲁', flag: '🇵🇪', currency: 'PEN', symbol: 'S/ ', monthlyPrice: 76.90, rateToCNY: 1.82, aliases: ['pe', 'pen', 'peru', '秘鲁'] },

    // 欧洲与欧亚
    { id: 'GB', name: '英国', flag: '🇬🇧', currency: 'GBP', symbol: '£', monthlyPrice: 18.99, rateToCNY: 8.75, aliases: ['gb', 'uk', 'gbp', 'united kingdom', '英国', '英区'] },
    { id: 'EU', name: '欧洲/欧盟 (德法意西荷等)', flag: '🇪🇺', currency: 'EUR', symbol: '€', monthlyPrice: 21.99, rateToCNY: 7.52, aliases: ['eu', 'eur', 'euro', 'europe', '欧洲', '欧盟', '德国', '法国', '意大利', '西班牙', '荷兰'] },
    { id: 'CH', name: '瑞士', flag: '🇨🇭', currency: 'CHF', symbol: 'CHF ', monthlyPrice: 17.00, rateToCNY: 7.85, aliases: ['ch', 'chf', 'switzerland', '瑞士'] },
    { id: 'UA', name: '乌克兰', flag: '🇺🇦', currency: 'UAH', symbol: '₴', monthlyPrice: 900, rateToCNY: 0.162, aliases: ['ua', 'uah', 'ukraine', '乌克兰'] },
    { id: 'PL', name: '波兰', flag: '🇵🇱', currency: 'PLN', symbol: 'zł ', monthlyPrice: 97.99, rateToCNY: 1.72, aliases: ['pl', 'pln', 'poland', '波兰'] },
    { id: 'SE', name: '瑞典', flag: '🇸🇪', currency: 'SEK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.65, aliases: ['se', 'sek', 'sweden', '瑞典'] },
    { id: 'NO', name: '挪威', flag: '🇳🇴', currency: 'NOK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.63, aliases: ['no', 'nok', 'norway', '挪威'] },
    { id: 'DK', name: '丹麦', flag: '🇩🇰', currency: 'DKK', symbol: 'kr ', monthlyPrice: 169, rateToCNY: 1.01, aliases: ['dk', 'dkk', 'denmark', '丹麦'] },
    { id: 'CZ', name: '捷克', flag: '🇨🇿', currency: 'CZK', symbol: 'Kč ', monthlyPrice: 529, rateToCNY: 0.30, aliases: ['cz', 'czk', 'czech', '捷克'] },
    { id: 'HU', name: '匈牙利', flag: '🇭🇺', currency: 'HUF', symbol: 'Ft ', monthlyPrice: 8990, rateToCNY: 0.0185, aliases: ['hu', 'huf', 'hungary', '匈牙利'] },
    { id: 'RO', name: '罗马尼亚', flag: '🇷🇴', currency: 'RON', symbol: 'lei ', monthlyPrice: 109.99, rateToCNY: 1.51, aliases: ['ro', 'ron', 'romania', '罗马尼亚'] },

    // 中东与非洲
    { id: 'NG', name: '尼日利亚', flag: '🇳🇬', currency: 'NGN', symbol: '₦', monthlyPrice: 28500, rateToCNY: 0.0042, aliases: ['ng', 'ngn', 'nigeria', '尼日利亚', '尼区'] },
    { id: 'ZA', name: '南非', flag: '🇿🇦', currency: 'ZAR', symbol: 'R ', monthlyPrice: 429.99, rateToCNY: 0.38, aliases: ['za', 'zar', 'south africa', '南非'] },
    { id: 'EG', name: '埃及', flag: '🇪🇬', currency: 'EGP', symbol: 'E£ ', monthlyPrice: 999, rateToCNY: 0.136, aliases: ['eg', 'egp', 'egypt', '埃及'] },
    { id: 'KE', name: '肯尼亚', flag: '🇰🇪', currency: 'KES', symbol: 'KSh ', monthlyPrice: 2800, rateToCNY: 0.052, aliases: ['ke', 'kes', 'kenya', '肯尼亚'] },
    { id: 'AE', name: '阿联酋', flag: '🇦🇪', currency: 'AED', symbol: 'AED ', monthlyPrice: 76.99, rateToCNY: 1.83, aliases: ['ae', 'aed', 'uae', 'emirates', '阿联酋', '迪拜'] },
    { id: 'SA', name: '沙特阿拉伯', flag: '🇸🇦', currency: 'SAR', symbol: 'SAR ', monthlyPrice: 85.99, rateToCNY: 1.79, aliases: ['sa', 'sar', 'saudi', '沙特', '沙特阿拉伯'] },
    { id: 'IL', name: '以色列', flag: '🇮🇱', currency: 'ILS', symbol: '₪ ', monthlyPrice: 79.90, rateToCNY: 1.85, aliases: ['il', 'ils', 'israel', '以色列'] },

    // 大中华区/人民币与自定义
    { id: 'CN', name: '中国大陆 (CNY)', flag: '🇨🇳', currency: 'CNY', symbol: '¥', monthlyPrice: 140.00, rateToCNY: 1.0, aliases: ['cn', 'cny', 'china', '中国', '人民币', '国内'] }
  ];

  function findRegionPreset(regionQuery) {
    if (!regionQuery || typeof regionQuery !== 'string') return null;
    const q = regionQuery.trim().toLowerCase();
    return SUBSCRIPTION_REGIONS_PRESET.find(r =>
      r.id.toLowerCase() === q ||
      r.name.toLowerCase() === q ||
      r.aliases.some(a => a.toLowerCase() === q || q.includes(a.toLowerCase()))
    ) || null;
  }

  function convertToCNY(amount, currency, regionQuery = null) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
    const num = Number(amount);
    if (num === 0) return 0;
    const cur = String(currency || '').toUpperCase();
    if (cur === 'CNY') return Number(num.toFixed(2));

    let preset = findRegionPreset(regionQuery);
    if (!preset || (cur && preset.currency !== cur)) {
      preset = SUBSCRIPTION_REGIONS_PRESET.find(r => r.currency === cur);
    }
    const rate = preset ? preset.rateToCNY : (cur === 'USD' ? 6.72 : (cur === 'HKD' ? 0.857 : (cur === 'JPY' ? 0.0425 : (cur === 'EUR' ? 7.52 : (cur === 'GBP' ? 8.75 : null)))));
    if (!rate) return null;
    return Number((num * rate).toFixed(2));
  }

  function resolveEffectivePlanStatus(livePlanStatus, customSettings, options = {}) {
    const rawLive = livePlanStatus && typeof livePlanStatus === 'object' ? livePlanStatus : null;
    const rawCustom = customSettings && typeof customSettings === 'object' ? customSettings : null;
    const cachedLive = options.cachedLivePlan && typeof options.cachedLivePlan === 'object' ? options.cachedLivePlan : null;

    // 当前账号标识
    const currentEmail = rawLive?.email || options.currentEmail || cachedLive?.email || null;
    const customAccount = rawCustom?.email || rawCustom?.account || null;

    // 账号隔离验证：若自定义设置声明了具体账号（非 default），且与当前账号（非 default）不匹配，则不得套用
    const normCustomAcc = customAccount ? String(customAccount).trim().toLowerCase() : '';
    const normCurrentEmail = currentEmail ? String(currentEmail).trim().toLowerCase() : '';
    const isCustomAccountMatched = !normCustomAcc || normCustomAcc === 'default' || !normCurrentEmail || normCurrentEmail === 'default' || normCustomAcc === normCurrentEmail;
    const effectiveCustom = isCustomAccountMatched ? rawCustom : null;

    // 1. 套餐名称与识别状态
    let status = 'unidentified';
    let tierKey = 'unknown';
    let tierName = '未知';
    let tierId = null;
    let planName = '未知';
    let tierSource = 'unknown';

    if (rawLive && rawLive.status === 'identified' && rawLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = rawLive.tierKey;
      tierName = rawLive.tierName;
      tierId = rawLive.tierId;
      planName = rawLive.planName || rawLive.tierName;
      tierSource = 'live';
    } else if (effectiveCustom && effectiveCustom.tierName) {
      status = 'custom';
      tierKey = effectiveCustom.tierKey || 'custom';
      tierName = effectiveCustom.tierName;
      planName = effectiveCustom.tierName;
      tierSource = 'custom';
    } else if (cachedLive && cachedLive.status === 'identified' && cachedLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = cachedLive.tierKey;
      tierName = cachedLive.tierName;
      tierId = cachedLive.tierId;
      planName = cachedLive.planName || cachedLive.tierName;
      tierSource = 'cached_live';
    }

    // 2A. 账号所在地区 (accountRegion / country) 独立取值：仅表示本地记录，不影响订阅国家与币种
    let country = '未知';
    let countrySource = 'unknown';
    const customAccVal = effectiveCustom?.accountRegion || effectiveCustom?.country;
    const isLiveCountryValid = rawLive?.country && rawLive.countrySource !== 'custom' && !String(rawLive.country).includes('未知');
    const isCachedCountryValid = cachedLive?.country && !String(cachedLive.country).includes('未知');
    if (isLiveCountryValid) {
      country = String(rawLive.country).trim();
      countrySource = 'live';
    } else if (customAccVal && typeof customAccVal === 'string' && customAccVal.trim() && !customAccVal.includes('未知')) {
      country = customAccVal.trim();
      countrySource = 'custom';
    } else if (isCachedCountryValid) {
      country = String(cachedLive.country).trim();
      countrySource = 'cached_live';
    }

    // 2B. 订阅国家 (subscriptionCountry / subscriptionRegion / region) 独立取值：购买/结算所在地区，允许与账号所在地区不同
    let region = '未知';
    let regionSource = 'unknown';
    const liveRegVal = rawLive?.subscriptionCountry || rawLive?.subscriptionRegion || rawLive?.region;
    const customRegVal = effectiveCustom?.subscriptionCountry || effectiveCustom?.subscriptionRegion || effectiveCustom?.region;
    const cachedRegVal = cachedLive?.subscriptionCountry || cachedLive?.subscriptionRegion || cachedLive?.region;
    const isLiveRegionValid = liveRegVal && rawLive?.regionSource !== 'custom' && rawLive?.regionSource !== 'preset_region' && !String(liveRegVal).includes('未知');
    const isCachedRegionValid = cachedRegVal && !String(cachedRegVal).includes('未知');

    if (isLiveRegionValid) {
      region = String(liveRegVal).trim();
      regionSource = 'live';
    } else if (customRegVal && typeof customRegVal === 'string' && customRegVal.trim() && !customRegVal.includes('未知')) {
      region = customRegVal.trim();
      regionSource = 'custom';
    } else if (isCachedRegionValid) {
      region = String(cachedRegVal).trim();
      regionSource = 'cached_live';
    }
    const subscriptionRegion = region;
    const subscriptionCountry = region;

    // 3. 订阅获取方式与活动有效期
    const customAcqId = effectiveCustom?.acquisitionSource || 'normal_paid';
    const presetAcq = SUBSCRIPTION_ACQUISITION_PRESETS.find(p => p.id === customAcqId) || null;
    const acquisitionSource = customAcqId;
    const acquisitionSourceName = effectiveCustom?.acquisitionSourceName || presetAcq?.name || '正常付费订阅';
    const acquisitionCategory = effectiveCustom?.acquisitionCategory || presetAcq?.category || 'paid';
    const validStartDate = effectiveCustom?.validStartDate || null;
    const validEndDate = effectiveCustom?.validEndDate || null;

    let isExpired = false;
    if (validEndDate && /^\d{4}-\d{2}-\d{2}$/.test(String(validEndDate))) {
      const today = new Date().toISOString().slice(0, 10);
      if (String(validEndDate) < today) {
        isExpired = true;
      }
    }

    // 4. 订阅币种 (subscriptionCurrency / currency)、价格模式与实付价格解析
    // 明确区分两种价格模式：
    // 'preset': 跟随订阅国家参考价 (按所选国家实时派生参考定价与币种，不固定用户实付)
    // 'custom': 自定义实付金额 (尊重用户手动填写的金额，含 0 元，切换国家不覆盖)
    let priceMode = effectiveCustom?.priceMode;
    if (priceMode !== 'preset' && priceMode !== 'custom') {
      const hasCustomPaid = Boolean(effectiveCustom && (effectiveCustom.isZeroExtraCost || (effectiveCustom.actualPricePaid !== null && effectiveCustom.actualPricePaid !== undefined && effectiveCustom.actualPricePaid !== '')));
      if (effectiveCustom?.priceSource === 'preset_region') {
        priceMode = 'preset';
      } else if (hasCustomPaid && (effectiveCustom?.priceSource === 'custom' || !findRegionPreset(region) || effectiveCustom?.actualPricePaid !== findRegionPreset(region)?.monthlyPrice)) {
        priceMode = 'custom';
      } else {
        priceMode = 'preset';
      }
    }

    let actualPricePaid = null;
    let officialPriceMonthly = rawLive?.officialPriceMonthly ?? cachedLive?.officialPriceMonthly ?? null;
    const matchedRegionPreset = findRegionPreset(region);
    let rawCur = (effectiveCustom?.subscriptionCurrency || effectiveCustom?.currency) ? String(effectiveCustom.subscriptionCurrency || effectiveCustom.currency).trim().toUpperCase() : '';
    if (rawCur === 'NTD') rawCur = 'TWD';
    const isValidCustomCurrency = Boolean(rawCur && (CURRENCY_SYMBOLS[rawCur] || SUBSCRIPTION_REGIONS_PRESET.some(p => p.currency === rawCur)));
    // 显式锁定币种：明确声明为 custom 来源，或自定义模式下指定了币种，或币种与当前地区预设不一致且明确传入
    const isManualCurrency = isValidCustomCurrency && (
      effectiveCustom?.currencySource === 'custom' ||
      priceMode === 'custom' ||
      (matchedRegionPreset && rawCur !== matchedRegionPreset.currency && effectiveCustom?.currencySource !== 'preset_region')
    );

    let currency = 'USD';
    let currencySource = 'default';
    if (isManualCurrency) {
      currency = rawCur;
      currencySource = 'custom';
    } else if (matchedRegionPreset) {
      currency = matchedRegionPreset.currency;
      currencySource = 'preset_region';
    } else if (rawLive?.currency) {
      currency = rawLive.currency;
      currencySource = 'live';
    } else if (isValidCustomCurrency) {
      currency = rawCur;
      currencySource = 'custom';
    } else {
      currency = 'USD';
      currencySource = 'default';
    }
    if (currency === 'NTD') currency = 'TWD';
    if (!CURRENCY_SYMBOLS[currency]) currency = matchedRegionPreset?.currency || 'USD';

    const matchedCurrencyPreset = SUBSCRIPTION_REGIONS_PRESET.find(p => p.currency === currency);
    const curSymbol = CURRENCY_SYMBOLS[currency]
      || (matchedRegionPreset && matchedRegionPreset.currency === currency ? matchedRegionPreset.symbol : null)
      || (matchedCurrencyPreset ? matchedCurrencyPreset.symbol : null)
      || (currency + ' ');
    let billingCycle = '未知';
    let priceRangeNote = '未知';
    let isPriceEstimated = true;
    let priceSource = 'unknown';

    const isLivePaidValid = rawLive && rawLive.priceSource !== 'custom' && rawLive.priceSource !== 'preset_region' && rawLive.actualPricePaid !== null && rawLive.actualPricePaid !== undefined && Number.isFinite(Number(rawLive.actualPricePaid)) && Number(rawLive.actualPricePaid) >= 0;

    if (isLivePaidValid) {
      priceMode = 'live';
      actualPricePaid = Number(rawLive.actualPricePaid);
      isPriceEstimated = false;
      priceSource = 'live';
      billingCycle = rawLive.billingCycle || '月付';
      priceRangeNote = `${acquisitionSourceName} · 实际结算 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
    } else if (priceMode === 'custom') {
      const isCustomZeroConfirmed = Boolean(effectiveCustom && (effectiveCustom.isZeroExtraCost || effectiveCustom.actualPricePaid === 0 || effectiveCustom.actualPricePaid === '0'));
      const isCustomPaidValid = Boolean(effectiveCustom && effectiveCustom.actualPricePaid !== null && effectiveCustom.actualPricePaid !== undefined && effectiveCustom.actualPricePaid !== '' && Number.isFinite(Number(effectiveCustom.actualPricePaid)) && Number(effectiveCustom.actualPricePaid) >= 0);

      if (isCustomZeroConfirmed) {
        actualPricePaid = 0;
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom?.billingCycle || '随套餐赠送/免费';
        priceRangeNote = isExpired
          ? `${acquisitionSourceName} · 权益已到期`
          : `${acquisitionSourceName} · 订阅额外实付 ${curSymbol}0 · 用户确认`;
      } else if (isCustomPaidValid) {
        actualPricePaid = Number(effectiveCustom.actualPricePaid);
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom.billingCycle || '月付';
        priceRangeNote = isExpired
          ? `${acquisitionSourceName} · 权益已到期`
          : `${acquisitionSourceName} · 用户实付 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
      } else {
        actualPricePaid = null;
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom?.billingCycle || '月付';
        priceRangeNote = `${acquisitionSourceName} · 待设置实付金额`;
      }
    } else {
      // priceMode === 'preset' (跟随订阅国家参考价)
      priceMode = 'preset';
      if (matchedRegionPreset) {
        actualPricePaid = Number(matchedRegionPreset.monthlyPrice);
        isPriceEstimated = true;
        priceSource = 'preset_region';
        billingCycle = effectiveCustom?.billingCycle || '月付';
        priceRangeNote = `${acquisitionSourceName} · 地区参考价 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
      } else if (officialPriceMonthly !== null) {
        actualPricePaid = null;
        priceSource = 'official_reference';
        billingCycle = '月付 · 公开参考';
        priceRangeNote = `${acquisitionSourceName} · 公开参考价 $${officialPriceMonthly}/月`;
      } else {
        actualPricePaid = null;
        priceSource = 'unknown';
        billingCycle = '未知';
        priceRangeNote = `${acquisitionSourceName} · 待设置订阅国家与价格`;
      }
    }

    // 5. 用户自定义备注（仅展示，不参与计算）
    const customNote = effectiveCustom?.customNote ? String(effectiveCustom.customNote).trim() : null;

    // 6. 额度池
    const promptCredits = rawLive?.promptCredits || cachedLive?.promptCredits || null;
    const flowCredits = rawLive?.flowCredits || cachedLive?.flowCredits || null;

    // 根据地区与币种自动折合人民币 (CNY)
    const rateRegion = (matchedRegionPreset && matchedRegionPreset.currency === currency) ? region : null;
    const effectiveRate = (matchedRegionPreset && matchedRegionPreset.currency === currency)
      ? matchedRegionPreset.rateToCNY
      : (matchedCurrencyPreset ? matchedCurrencyPreset.rateToCNY : (currency === 'USD' ? 6.72 : (currency === 'HKD' ? 0.857 : (currency === 'JPY' ? 0.0425 : (currency === 'CNY' ? 1.0 : null)))));
    const actualPricePaidCNY = actualPricePaid !== null ? convertToCNY(actualPricePaid, currency, rateRegion) : null;
    const cnyFormatted = actualPricePaidCNY !== null ? (currency === 'CNY' ? ('¥' + actualPricePaidCNY) : ('折合 ≈ ¥' + actualPricePaidCNY.toFixed(1) + ' CNY')) : null;

    if (actualPricePaidCNY !== null && actualPricePaid > 0 && currency !== 'CNY') {
      priceRangeNote += ' (' + cnyFormatted + ')';
    }

    return {
      status,
      tierKey,
      tierName,
      tierId,
      planName,
      email: currentEmail,
      accountRegion: country,
      country,
      countrySource,
      subscriptionCountry: region,
      subscriptionRegion,
      region,
      regionSource,
      regionPreset: matchedRegionPreset,
      subscriptionCurrency: currency,
      currency,
      currencySource,
      currencySymbol: curSymbol,
      actualPricePaidCNY,
      cnyFormatted,
      exchangeRateToCNY: effectiveRate,
      billingCycle,
      acquisitionSource,
      acquisitionSourceName,
      acquisitionCategory,
      isZeroExtraCost: actualPricePaid === 0,
      validStartDate,
      validEndDate,
      isExpired,
      officialPriceMonthly,
      priceRangeNote,
      priceMode,
      actualPricePaid,
      isPriceEstimated,
      priceSource,
      customNote,
      promptCredits,
      flowCredits,
      sources: {
        tier: tierSource,
        country: countrySource,
        region: regionSource,
        currency: currencySource,
        price: priceSource,
        acquisition: effectiveCustom?.acquisitionSource ? 'custom' : 'default'
      },
      hasCustomSettings: Boolean(effectiveCustom && (effectiveCustom.country || effectiveCustom.region || effectiveCustom.subscriptionRegion || effectiveCustom.currency || effectiveCustom.actualPricePaid !== undefined || effectiveCustom.customNote || effectiveCustom.acquisitionSource)),
      pricingTableVerifiedDate: '2026-11-09',
      updatedAt: rawLive?.updatedAt || new Date().toISOString()
    };
  }

  function normalizeTokenHistoryPayload(payload, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const source = options.source || 'all';
    const pricingDate = options.pricingDate || '2026-11-09';
    const modelId = options.modelId || 'gemini-3.8-flash';

    const dailyMapBySource = payload.dailyMapBySource && typeof payload.dailyMapBySource === 'object'
      ? payload.dailyMapBySource
      : { all: payload.dailyMap || {}, desktop: {}, cli: {} };

    const targetMap = dailyMapBySource[source] || dailyMapBySource.all || payload.dailyMap || {};
    const normalizedMap = {};
    for (const [k, rec] of Object.entries(targetMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !rec) continue;
      normalizedMap[k] = {
        total: Number(rec.total) || 0,
        input: Number(rec.input) || 0,
        output: Number(rec.output) || 0,
        cache: Number(rec.cache) || 0,
        steps: Number(rec.steps) || 0
      };
    }

    const todayStr = options.todayStr || (new Date()).toISOString().slice(0, 10);
    const currentMonthPrefix = todayStr.slice(0, 7);
    const currentYearPrefix = todayStr.slice(0, 4);

    let grandTotalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let todayTokens = 0;
    let monthTokens = 0;
    let yearTokens = 0;
    let currentMonthInput = 0;
    let currentMonthOutput = 0;
    let currentMonthCache = 0;
    let activeDaysCount = 0;

    for (const [k, rec] of Object.entries(normalizedMap)) {
      if (rec.total > 0) activeDaysCount++;
      grandTotalTokens += rec.total;
      totalInputTokens += rec.input;
      totalOutputTokens += rec.output;
      totalCacheTokens += rec.cache;

      if (k === todayStr) todayTokens += rec.total;
      if (k.startsWith(currentMonthPrefix)) {
        monthTokens += rec.total;
        currentMonthInput += rec.input;
        currentMonthOutput += rec.output;
        currentMonthCache += rec.cache;
      }
      if (k.startsWith(currentYearPrefix)) {
        yearTokens += rec.total;
      }
    }

    const rawSum = payload.summary || {};
    if (source === 'all') {
      if (Number(rawSum.totalInputTokens) > totalInputTokens) totalInputTokens = Number(rawSum.totalInputTokens);
      if (Number(rawSum.totalOutputTokens) > totalOutputTokens) totalOutputTokens = Number(rawSum.totalOutputTokens);
      if (Number(rawSum.totalCacheTokens) > totalCacheTokens) totalCacheTokens = Number(rawSum.totalCacheTokens);
      if (Number(rawSum.grandTotalTokens) > grandTotalTokens) grandTotalTokens = Number(rawSum.grandTotalTokens);
      if (Number(rawSum.currentMonthInput) > currentMonthInput) currentMonthInput = Number(rawSum.currentMonthInput);
      if (Number(rawSum.currentMonthOutput) > currentMonthOutput) currentMonthOutput = Number(rawSum.currentMonthOutput);
      if (Number(rawSum.currentMonthCache) > currentMonthCache) currentMonthCache = Number(rawSum.currentMonthCache);
      if (Number(rawSum.monthTokens) > monthTokens) monthTokens = Number(rawSum.monthTokens);
    }

    const refMonth = payload.referenceCost?.currentMonth;
    const refAll = payload.referenceCost?.all;
    if (refMonth) {
      if (refMonth.inputTokens && !currentMonthInput) currentMonthInput = Number(refMonth.inputTokens);
      if (refMonth.cacheTokens && !currentMonthCache) currentMonthCache = Number(refMonth.cacheTokens);
      if (refMonth.outputTokens && !currentMonthOutput) currentMonthOutput = Number(refMonth.outputTokens);
      if (refMonth.totalTokens && !monthTokens) monthTokens = Number(refMonth.totalTokens);
      else if (!monthTokens && (currentMonthInput || currentMonthOutput || currentMonthCache)) {
        monthTokens = currentMonthInput + currentMonthOutput + currentMonthCache;
      }
    }
    if (refAll) {
      if (refAll.inputTokens && !totalInputTokens) totalInputTokens = Number(refAll.inputTokens);
      if (refAll.cacheTokens && !totalCacheTokens) totalCacheTokens = Number(refAll.cacheTokens);
      if (refAll.outputTokens && !totalOutputTokens) totalOutputTokens = Number(refAll.outputTokens);
      if (refAll.totalTokens && !grandTotalTokens) grandTotalTokens = Number(refAll.totalTokens);
      else if (!grandTotalTokens && (totalInputTokens || totalOutputTokens || totalCacheTokens)) {
        grandTotalTokens = totalInputTokens + totalOutputTokens + totalCacheTokens;
      }
    }

    const summary = {
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
      activeDaysCount,
      totalConversations: Number(rawSum.totalConversations) || activeDaysCount,
      firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
    };

    let referenceCost = payload.referenceCost;
    if (!referenceCost || !referenceCost.all || !referenceCost.currentMonth) {
      const calcRefAll = calculateReferenceModelCost({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheTokens: totalCacheTokens,
        totalTokens: grandTotalTokens
      }, modelId, { pricingDate, mode: 'all' });

      const calcRefMonth = calculateReferenceModelCost({
        inputTokens: currentMonthInput,
        outputTokens: currentMonthOutput,
        cacheTokens: currentMonthCache,
        totalTokens: monthTokens
      }, modelId, { pricingDate, mode: 'all' });

      referenceCost = {
        all: calcRefAll,
        currentMonth: calcRefMonth,
        hybrid: referenceCost?.hybrid || calcRefAll,
        currentMonthHybrid: referenceCost?.currentMonthHybrid || calcRefMonth
      };
    }

    return {
      schemaVersion: payload.schemaVersion || '0.8.2',
      version: payload.version || '0.8.2',
      updatedAt: payload.updatedAt || '',
      firstUseDate: summary.firstUseDate,
      currentPeriod: payload.currentPeriod || {
        key: currentMonthPrefix,
        label: `${currentMonthPrefix} (自然月)`,
        isCurrentMonth: true
      },
      planStatus: payload.planStatus || null,
      rawPlanStatus: payload.rawPlanStatus || payload.planStatus || null,
      customPlanSettings: payload.customPlanSettings || null,
      costEstimate: payload.costEstimate || null,
      costEstimateCurrentMonth: payload.costEstimateCurrentMonth || null,
      costEstimateBySource: payload.costEstimateBySource || null,
      recentModelUsage: Array.isArray(payload.recentModelUsage) ? payload.recentModelUsage : [],
      referenceCost,
      summary,
      dailyMap: normalizedMap,
      dailyMapBySource
    };
  }

  /**
   * 按周期统计级别映射热力图 5 档色阶 (0..4)
   * @param {number} value - 当前 Token 用量
   * @param {'day'|'week'|'month'} [kind='day'] - 统计周期
   * @param {number} [maxInWindow=0] - 本窗口最大值 (week/month 模式下用于相对分位计算)
   * @returns {number} 0..4 对应的档位索引
   *
   * 分位策略说明：
   * - day: 采用每日绝对阈值 (0, <3M, <15M, <60M, >=60M)，保障单日细粒度用量感知。
   * - week / month: 采用相对本窗口最大值分位 (0: 0, <=25%: 1, <=50%: 2, <=75%: 3, >75%: 4)，
   *   自适应对比不同周期用量，避免月/周用量套用日阈值造成全部打满峰值色阶。
   */
  function getLvlForRange(value, kind = 'day', maxInWindow = 0) {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    if (kind === 'day') {
      if (v < 3e6) return 1;
      if (v < 15e6) return 2;
      if (v < 60e6) return 3;
      return 4;
    }
    const max = Number(maxInWindow) || 0;
    if (max <= 0) return 1;
    const ratio = v / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.50) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  const _dailyCostCache = new Map();

  function clearDailyCostCache() {
    _dailyCostCache.clear();
  }

  function getDailyModelCost(dayRecord, dateKey, modelKey = 'gemini-3.8-flash', options = {}) {
    if (!dayRecord || (!dayRecord.total && !dayRecord.input && !dayRecord.output && !dayRecord.cache)) {
      return { costUSD: 0, inputCost: 0, cacheCost: 0, outputCost: 0 };
    }
    const mode = options.mode || 'ref';
    const pricingDate = options.pricingDate ? String(options.pricingDate).slice(0, 10) : '2026-11-08';
    const cacheKey = `${dateKey}:${modelKey}:${mode}:${pricingDate}:${dayRecord.input || 0}:${dayRecord.cache || 0}:${dayRecord.output || 0}:${dayRecord.total || 0}`;
    if (_dailyCostCache.has(cacheKey)) {
      return _dailyCostCache.get(cacheKey);
    }

    const calc = calculateReferenceModelCost({
      inputTokens: dayRecord.input || 0,
      cacheTokens: dayRecord.cache || 0,
      outputTokens: dayRecord.output || 0,
      totalTokens: dayRecord.total || 0
    }, modelKey, {
      pricingDate,
      mode: mode === 'hybrid' ? 'unpriced_only' : undefined
    });

    const res = {
      costUSD: calc.totalCostUSD || 0,
      inputCost: calc.inputCostUSD ?? calc.breakdownCostUSD?.input ?? 0,
      cacheCost: calc.cacheCostUSD ?? calc.breakdownCostUSD?.cache ?? 0,
      outputCost: calc.outputCostUSD ?? calc.breakdownCostUSD?.output ?? 0
    };
    _dailyCostCache.set(cacheKey, res);
    return res;
  }

  /**
   * 计算指定日期集合的聚合费用与指标
   * @param {Object} dailyMap - 每日记录映射
   * @param {string[]} dateKeys - 参与统计的日期键列表 (YYYY-MM-DD)
   * @param {string} [modelKey='gemini-3.8-flash'] - 参考模型标识
   * @param {Object} [options={}] - 配置参数 (mode, pricingDate, todayStr)
   */
  function calculateIntervalCost(dailyMap = {}, dateKeys = [], modelKey = 'gemini-3.8-flash', options = {}) {
    const todayStr = options.todayStr || (new Date().toISOString().slice(0, 10));
    let totalTokens = 0;
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let totalCostUSD = 0;
    let pastDays = 0;
    let activeDays = 0;

    for (const key of dateKeys) {
      const isFuture = key > todayStr;
      if (!isFuture) {
        pastDays++;
      }
      const rec = dailyMap[key];
      if (rec && rec.total > 0) {
        activeDays++;
        totalTokens += rec.total;
        inputTokens += (rec.input || 0);
        cacheTokens += (rec.cache || 0);
        outputTokens += (rec.output || 0);

        const cost = getDailyModelCost(rec, key, modelKey, options);
        totalCostUSD += cost.costUSD;
      }
    }

    const safePastDays = Math.max(1, pastDays);
    const dailyAverageUSD = Number((totalCostUSD / safePastDays).toFixed(4));
    const activeDailyAverageUSD = activeDays > 0 ? Number((totalCostUSD / activeDays).toFixed(4)) : 0;

    return {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      totalCostUSD: Number(totalCostUSD.toFixed(4)),
      pastDays,
      activeDays,
      dailyAverageUSD,
      activeDailyAverageUSD
    };
  }

  /**
   * 解析严格 v0.x.x 格式的语义化版本
   * 防御性要求：只接受 ^v0\.\d+\.\d+$，任何 v2.x 或其他前缀均返回 null
   */
  function parseSemver(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const m = tag.trim().match(/^v?0\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return { major: 0, minor: parseInt(m[1], 10), patch: parseInt(m[2], 10) };
  }

  /**
   * 语义化版本对比
   * @returns {number} 1 (vA > vB), -1 (vA < vB), 0 (相等或无法对比)
   */
  function compareVersions(vA, vB) {
    const a = parseSemver(vA);
    const b = parseSemver(vB);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
    if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
    return 0;
  }

  /**
   * 过滤并筛选可用更新 Release
   */
  function filterReleases(releasesList, currentVersion = '0.8.2') {
    if (!Array.isArray(releasesList)) return [];
    const valid = [];
    for (const rel of releasesList) {
      if (!rel || rel.draft || rel.prerelease) continue;
      const parsed = parseSemver(rel.tag_name);
      if (!parsed) continue; // 忽略非 v0.x 编号
      const verStr = `0.${parsed.minor}.${parsed.patch}`;
      if (compareVersions(verStr, currentVersion) > 0) {
        valid.push({
          tagName: rel.tag_name,
          version: verStr,
          htmlUrl: rel.html_url,
          body: rel.body || '',
          publishedAt: rel.published_at || '',
          assets: Array.isArray(rel.assets) ? rel.assets : []
        });
      }
    }
    valid.sort((a, b) => compareVersions(b.version, a.version));
    return valid;
  }

  /**
   * 在 Release 资产中按当前平台与架构寻找对应 ZIP 及校验文件
   */
  function findReleaseAsset(assets, platform, arch) {
    if (!Array.isArray(assets)) return { packageAsset: null, checksumAsset: null, targetOs: 'windows', targetArch: 'amd64' };
    const p = String(platform || '').toLowerCase();
    const a = String(arch || '').toLowerCase();
    const targetOs = (p === 'win32' || p === 'windows') ? 'windows' : ((p === 'darwin' || p === 'macos') ? 'darwin' : 'linux');
    const targetArch = (a === 'x64' || a === 'amd64') ? 'amd64' : 'arm64';

    let checksumAsset = null;
    let packageAsset = null;

    for (const item of assets) {
      const name = item.name || '';
      if (name === 'checksums.txt') {
        checksumAsset = item;
      } else if (name.endsWith('.zip') && name.includes(`_${targetOs}_${targetArch}`)) {
        packageAsset = item;
      }
    }

    return { packageAsset, checksumAsset, targetOs, targetArch };
  }

  /**
   * 严格校验外部链接是否属于官方白名单（官方仓库或作者署名主页）
   */
  function isValidExternalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'https:') return false;
      if (u.hostname === 'github.com') {
        const pathname = u.pathname.replace(/\/+$/, '');
        const repoPrefix = '/elviscjn-cjn/antigravity-context-viewer';
        return pathname === repoPrefix || pathname.startsWith(repoPrefix + '/');
      }
      if (u.hostname === 'linux.do') {
        const pathname = u.pathname.replace(/\/+$/, '');
        return (
          pathname === '/t/topic/3117832' ||
          pathname === '/t/3117832' ||
          pathname.startsWith('/t/topic/3117832/') ||
          pathname === '/u/23375/summary' ||
          pathname === '/u/23375'
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 将重置时间戳格式化为可读倒计时（如「2小时15分后」）
   */
  function formatResetCountdownZh(isoStr, nowMs = Date.now()) {
    if (!isoStr) return null;
    try {
      const target = new Date(isoStr).getTime();
      if (!Number.isFinite(target)) return null;
      const diffMs = target - Number(nowMs);
      if (diffMs <= 0) return '即将刷新';
      const totalMin = Math.ceil(diffMs / 60000);
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      if (days > 0) return `${days}天${hours > 0 ? `${hours}小时` : ''}后`;
      if (hours > 0) return `${hours}小时${mins > 0 ? `${mins}分` : ''}后`;
      return `${Math.max(1, mins)}分钟后`;
    } catch {
      return null;
    }
  }

  function formatApproxTokensZh(value) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
    const n = Math.round(Number(value));
    if (n === 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(n >= 10e6 ? 1 : 2))}M`;
    if (n >= 1000) return `${n >= 100000 ? Math.round(n / 1000) : parseFloat((n / 1000).toFixed(1))}K`;
    return String(n);
  }

  function inferQuotaCycleStartMs(resetTimeIso, nowMs = Date.now(), windowType = null) {
    if (!resetTimeIso) return null;
    const resetMs = new Date(resetTimeIso).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
    if (windowType === 'weekly') return resetMs - 7 * 86400000;
    if (windowType === '5h') return resetMs - 5 * 3600000;
    if (windowType === '24h') return resetMs - 24 * 3600000;
    const remMs = resetMs - nowMs;
    if (remMs <= 6 * 3600000) return resetMs - 5 * 3600000;
    if (remMs <= 26 * 3600000) return resetMs - 24 * 3600000;
    return resetMs - 7 * 86400000;
  }

  function readQuotaFraction(qi) {
    if (!qi || typeof qi !== 'object') return null;
    const rawFrac = qi.remainingFraction ?? qi.remaining_fraction ?? qi.fraction;
    if (typeof rawFrac === 'number' && Number.isFinite(rawFrac)) {
      return Math.max(0, Math.min(1, rawFrac));
    }
    if (rawFrac != null && rawFrac !== '' && Number.isFinite(Number(rawFrac))) {
      return Math.max(0, Math.min(1, Number(rawFrac)));
    }
    const rawPct = qi.remainingPct ?? qi.remainingPercent ?? qi.remaining_percent;
    if (rawPct != null && rawPct !== '' && Number.isFinite(Number(rawPct))) {
      return Math.max(0, Math.min(1, Number(rawPct) / 100));
    }
    if (qi.disabled === true) return null;
    const resetTime = qi.resetTime || qi.reset_time || null;
    const remAmount = qi.remainingAmount ?? qi.remaining_amount;
    if (resetTime || (remAmount != null && Number(remAmount) === 0)) {
      return 0;
    }
    return null;
  }

  function classifyQuotaWindow(source, resetTimeIso, nowMs = Date.now()) {
    const text = [
      source?.window,
      source?.windowType,
      source?.window_type,
      source?.cadence,
      source?.duration,
      source?.quotaWindow,
      source?.bucketId,
      source?.bucket_id,
      source?.id,
      source?.displayName,
      source?.display_name,
      source?.label
    ]
      .filter(Boolean)
      .map(s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
      .join(' ')
      .toLowerCase();
    if (/(?:^|[^a-z0-9])(weekly|week|1w|7d|7\s*days?|seven[_\s-]?days?|one[_\s-]?week|10080m)(?:$|[^a-z0-9])/.test(text) || /周/.test(text)) {
      return 'weekly';
    }
    if (/(?:^|[^a-z0-9])(5h|5\s*hours?|five[_\s-]?hours?|300m)(?:$|[^a-z0-9])/.test(text) || /5\s*小时/.test(text)) {
      return '5h';
    }
    if (/(?:^|[^a-z0-9])(24h|daily|1d|1440m)(?:$|[^a-z0-9])/.test(text)) {
      return '24h';
    }
    if (resetTimeIso) {
      const resetMs = new Date(resetTimeIso).getTime();
      if (Number.isFinite(resetMs) && resetMs - nowMs > 26 * 3600000) {
        return 'weekly';
      }
    }
    return '5h';
  }

  function classifyQuotaGroupKey(groupId = '', displayName = '', modelIds = []) {
    const combined = [
      groupId,
      displayName,
      ...(Array.isArray(modelIds) ? modelIds : [])
    ].filter(Boolean).join(' ').toLowerCase();
    if (combined.includes('argon')) return 'gemini-argon';
    if (combined.includes('gemini')) return 'gemini';
    if (/(3p|third[-_ ]?party|claude|gpt|opus|sonnet|haiku|openai|anthropic|oss)/.test(combined)) {
      return 'third-party';
    }
    const slug = String(groupId || displayName || 'other')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'other';
  }

  function getQuotaGroupDisplayName(groupKey, rawDisplayName = '') {
    if (groupKey === 'gemini') return 'Gemini 模型';
    if (groupKey === 'gemini-argon') return 'Gemini Argon';
    if (groupKey === 'third-party') return 'Claude & GPT 模型';
    return String(rawDisplayName || groupKey || '其他模型').trim();
  }

  function doesModelPoolBelongToGroup(poolKey = '', modelName = '', group = null) {
    const pk = String(poolKey || '').toLowerCase();
    const mn = String(modelName || '').toLowerCase();
    const groupKey = typeof group === 'string' ? group : (group?.groupKey || '');
    const modelIds = Array.isArray(group?.modelIds) ? group.modelIds : [];
    if (modelIds.length && mn) {
      for (const id of modelIds) {
        const lowId = String(id || '').toLowerCase();
        if (lowId && (lowId === mn || mn.includes(lowId) || lowId.includes(mn))) return true;
      }
    }
    if (groupKey === 'gemini-argon') {
      return pk.includes('argon') || mn.includes('argon');
    }
    if (groupKey === 'gemini') {
      if (pk.includes('argon') || mn.includes('argon')) return false;
      return pk.startsWith('gemini') || mn.includes('gemini');
    }
    if (groupKey === 'third-party') {
      return pk.startsWith('claude') || pk.startsWith('gpt') ||
        /(claude|opus|sonnet|haiku|gpt|openai|anthropic)/.test(`${pk} ${mn}`);
    }
    return Boolean(groupKey && (pk === groupKey || pk.includes(groupKey) || mn.includes(groupKey)));
  }

  function extractQuotaSummaryGroups(rawSummary) {
    if (!rawSummary || typeof rawSummary !== 'object') return [];
    if (Array.isArray(rawSummary)) return rawSummary;
    const candidates = [
      rawSummary.groups,
      rawSummary.modelGroups,
      rawSummary.model_groups,
      rawSummary.response?.groups,
      rawSummary.response?.modelGroups,
      rawSummary.response?.quotaSummary?.groups,
      rawSummary.quotaSummary?.groups,
      rawSummary.quotaSummary?.response?.groups,
      rawSummary.userQuotaSummary?.groups,
      rawSummary.userQuotaSummary?.response?.groups,
      rawSummary.userStatus?.quotaSummary?.groups,
      rawSummary.summary?.groups,
      rawSummary.data?.groups
    ];
    for (const arr of candidates) {
      if (Array.isArray(arr)) return arr;
    }
    return [];
  }

  function computePoolTokenEstimate(pool, options = {}) {
    const nowMs = Number(options.nowMs) || Date.now();
    const events = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const prev = options.calibrationEntry && typeof options.calibrationEntry === 'object' ? { ...options.calibrationEntry } : null;
    const frac = pool?.remainingFraction;
    const matchPoolKey = typeof options.matchPoolKey === 'function'
      ? options.matchPoolKey
      : (evPoolKey => evPoolKey === pool.poolKey);

    let calibratedTotal = (prev && Number.isFinite(Number(prev.calibratedTotalTokens)) && Number(prev.calibratedTotalTokens) > 0)
      ? Number(prev.calibratedTotalTokens)
      : null;
    let sampleCount = Number(prev?.sampleCount) || 0;
    let calSource = prev?.source || null;
    let resetObservedAt = Number(prev?.lastResetObservedAt) || 0;

    const resetMs = pool?.resetTime ? new Date(pool.resetTime).getTime() : NaN;
    const prevResetMs = prev?.lastResetTime ? new Date(prev.lastResetTime).getTime() : NaN;
    const resetShiftedForward = Number.isFinite(resetMs) && Number.isFinite(prevResetMs) && (resetMs - prevResetMs) > 600000;
    const jumpedUp = prev && typeof prev.lastFraction === 'number' && frac != null && (frac - prev.lastFraction) >= 0.05;
    if (jumpedUp || resetShiftedForward) {
      resetObservedAt = nowMs;
    }

    const cycleStartMs = inferQuotaCycleStartMs(pool?.resetTime, nowMs, pool?.windowType || null);
    const defaultWindowMs = pool?.windowType === 'weekly' ? 7 * 86400000 : (pool?.windowType === '24h' ? 24 * 3600000 : 5 * 3600000);
    const effectiveStartMs = cycleStartMs != null
      ? Math.max(cycleStartMs, resetObservedAt ? resetObservedAt - 60000 : 0)
      : (resetObservedAt ? resetObservedAt - 60000 : (nowMs - defaultWindowMs));

    let cycleTokensUsed = 0;
    for (const ev of events) {
      if (!ev || !matchPoolKey(ev.poolKey)) continue;
      const ts = Number(ev.ts ?? ev.timestamp);
      const tok = Number(ev.tok ?? ev.totalTokens ?? 0);
      if (!Number.isFinite(ts) || !Number.isFinite(tok) || tok <= 0) continue;
      if (ts >= effectiveStartMs && ts <= nowMs + 60000) {
        cycleTokensUsed += tok;
      }
    }

    if (frac == null) {
      return {
        estRemainingTokens: null,
        estRemainingZh: null,
        estTotalTokens: calibratedTotal ? Math.round(calibratedTotal) : null,
        estSource: calibratedTotal ? 'cached' : 'unknown',
        cycleTokensUsed: Math.round(cycleTokensUsed),
        nextCalibrationEntry: prev
      };
    }

    let anchorFraction = (prev && typeof prev.anchorFraction === 'number' && !jumpedUp && !resetShiftedForward)
      ? prev.anchorFraction
      : frac;
    let anchorCycleTokens = (prev && typeof prev.anchorCycleTokens === 'number' && !jumpedUp && !resetShiftedForward)
      ? prev.anchorCycleTokens
      : cycleTokensUsed;

    if (frac > anchorFraction && (frac - anchorFraction) < 0.05 && !resetShiftedForward) {
      anchorFraction = frac;
      anchorCycleTokens = cycleTokensUsed;
    }

    const deltaF = anchorFraction - frac;
    const deltaTok = cycleTokensUsed - anchorCycleTokens;
    if (deltaF >= 0.02 && deltaTok >= 1000) {
      const sampleTotal = deltaTok / deltaF;
      if (calibratedTotal && sampleCount >= 1) {
        const clamped = Math.max(calibratedTotal * 0.25, Math.min(calibratedTotal * 4, sampleTotal));
        calibratedTotal = sampleCount >= 2 ? (calibratedTotal * 0.6 + clamped * 0.4) : (calibratedTotal * 0.4 + clamped * 0.6);
      } else {
        calibratedTotal = sampleTotal;
      }
      sampleCount += 1;
      calSource = 'delta';
      anchorFraction = frac;
      anchorCycleTokens = cycleTokensUsed;
    }

    const usedFrac = 1 - frac;
    if (usedFrac >= 0.02 && cycleTokensUsed >= 1000) {
      const cycleTotal = cycleTokensUsed / usedFrac;
      if (!calibratedTotal || calSource !== 'delta') {
        calibratedTotal = calibratedTotal && calSource === 'cycle'
          ? (calibratedTotal * 0.35 + cycleTotal * 0.65)
          : cycleTotal;
        calSource = 'cycle';
      }
    }

    const estRemainingTokens = frac <= 0
      ? 0
      : (calibratedTotal && calibratedTotal > 0 ? Math.max(0, Math.round(calibratedTotal * frac)) : null);

    const nextCalibrationEntry = {
      calibratedTotalTokens: calibratedTotal ? Math.round(calibratedTotal) : null,
      sampleCount,
      source: calSource,
      lastFraction: frac,
      lastResetTime: pool.resetTime || null,
      lastResetObservedAt: resetObservedAt || null,
      anchorFraction,
      anchorCycleTokens: Math.round(anchorCycleTokens),
      updatedAt: nowMs
    };

    return {
      estRemainingTokens,
      estRemainingZh: estRemainingTokens != null ? formatApproxTokensZh(estRemainingTokens) : null,
      estTotalTokens: calibratedTotal ? Math.round(calibratedTotal) : null,
      estSource: frac <= 0 ? 'exhausted' : (estRemainingTokens != null ? (calSource || 'cached') : 'uncalibrated'),
      cycleTokensUsed: Math.round(cycleTokensUsed),
      nextCalibrationEntry
    };
  }

  /**
   * 汇总所有模型配额（同模型不同档位/分支合并，支持 5 小时 + 每周双周期），并结合近期消耗推算约剩 token
   */
  function summarizeModelQuotaPools(cascadeModelConfigs, currentModel = '', nowMs = Date.now(), options = {}) {
    const list = Array.isArray(cascadeModelConfigs) ? cascadeModelConfigs : [];
    const poolMap = new Map();
    const pools = [];
    const readCfgId = item => String(item?.modelOrAlias?.model || item?.modelId || item?.model || '').trim();

    function upsertMergedPool(map, targetArr, entryInput) {
      const {
        poolKey,
        groupKey,
        windowType,
        poolName,
        modelId,
        remainingFraction,
        resetTime,
        models,
        modelIds
      } = entryInput;
      const remainingPct = remainingFraction != null ? Math.round(remainingFraction * 100) : null;

      if (!map.has(poolKey)) {
        const entry = {
          poolKey,
          ...(groupKey ? { groupKey } : {}),
          windowType: windowType || '5h',
          poolName,
          modelId: modelId || null,
          label: poolName,
          remainingFraction,
          remainingPct,
          resetTime,
          resetTimeZh: resetTime ? formatResetTimeZh(resetTime) : null,
          resetInZh: resetTime ? formatResetCountdownZh(resetTime, nowMs) : null,
          models: Array.isArray(models) ? [...models] : [],
          ...(Array.isArray(modelIds) ? { modelIds: [...modelIds] } : {})
        };
        map.set(poolKey, entry);
        targetArr.push(entry);
        return entry;
      }

      const existing = map.get(poolKey);
      if (Array.isArray(models)) {
        for (const m of models) {
          if (m && !existing.models.includes(m)) existing.models.push(m);
        }
      }
      if (Array.isArray(modelIds)) {
        if (!Array.isArray(existing.modelIds)) existing.modelIds = [];
        for (const id of modelIds) {
          if (id && !existing.modelIds.includes(id)) existing.modelIds.push(id);
        }
      }
      if (existing.remainingFraction == null && remainingFraction != null) {
        existing.remainingFraction = remainingFraction;
        existing.remainingPct = remainingPct;
        if (resetTime) {
          existing.resetTime = resetTime;
          existing.resetTimeZh = formatResetTimeZh(resetTime);
          existing.resetInZh = formatResetCountdownZh(resetTime, nowMs);
        }
      } else if (existing.remainingFraction != null && remainingFraction != null && remainingFraction < existing.remainingFraction) {
        // 同模型/同配额组存在多个额度档位时合并为同一条，取更紧余量避免高估
        existing.remainingFraction = remainingFraction;
        existing.remainingPct = remainingPct;
        if (resetTime) {
          existing.resetTime = resetTime;
          existing.resetTimeZh = formatResetTimeZh(resetTime);
          existing.resetInZh = formatResetCountdownZh(resetTime, nowMs);
        }
      }
      if (!existing.resetTime && resetTime) {
        existing.resetTime = resetTime;
        existing.resetTimeZh = formatResetTimeZh(resetTime);
        existing.resetInZh = formatResetCountdownZh(resetTime, nowMs);
      }
      return existing;
    }

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const modelId = readCfgId(item);
      const rawLabel = String(item.label || item.displayName || modelId || '').trim();
      const qi = item.quotaInfo || item.quota_info || null;
      const resetTime = qi?.resetTime || qi?.reset_time || null;
      const remainingFraction = readQuotaFraction(qi);
      const rawCfgModelId = String(item.modelId || '').trim();
      if ((/disabled$/i.test(rawCfgModelId) || /disabled$/i.test(modelId) || qi?.disabled === true) && remainingFraction == null && !resetTime) continue;

      const poolKey = getModelPoolKey(modelId, rawLabel);
      const displayName = getPoolDisplayName(rawLabel, modelId, poolKey);
      const windowType = classifyQuotaWindow({ ...item, ...(qi || {}) }, resetTime, nowMs);

      upsertMergedPool(poolMap, pools, {
        poolKey,
        windowType,
        poolName: displayName,
        modelId,
        remainingFraction,
        resetTime,
        models: rawLabel ? [rawLabel] : []
      });
    }

    const rawQuotaSummary = options.quotaSummary || options.userStatus?.quotaSummary || options.userStatus?.userStatus?.quotaSummary || null;
    const summaryGroups = extractQuotaSummaryGroups(rawQuotaSummary);
    const weeklyPoolMap = new Map();
    const weeklyPools = [];
    const summaryShortMap = new Map();
    const summaryShortPools = [];

    for (const group of summaryGroups) {
      if (!group || typeof group !== 'object') continue;
      const groupId = String(group.id || group.groupId || group.group_id || group.groupKey || group.name || '').trim();
      const rawGroupName = String(group.displayName || group.display_name || group.label || group.title || group.name || groupId || '').trim();
      const rawModels = Array.isArray(group.modelIds)
        ? group.modelIds
        : (Array.isArray(group.model_ids) ? group.model_ids : (Array.isArray(group.models) ? group.models : []));
      const modelIds = [];
      const modelLabels = [];
      for (const m of rawModels) {
        if (typeof m === 'string') {
          const clean = m.trim();
          if (clean) {
            modelIds.push(clean);
            modelLabels.push(clean);
          }
        } else if (m && typeof m === 'object') {
          const id = readCfgId(m) || String(m.id || '').trim();
          const lbl = String(m.label || m.displayName || id || '').trim();
          if (id) modelIds.push(id);
          if (lbl) modelLabels.push(lbl);
        }
      }

      const groupKey = classifyQuotaGroupKey(groupId, rawGroupName, modelIds);
      const groupDisplayName = getQuotaGroupDisplayName(groupKey, rawGroupName);
      const rawBuckets = Array.isArray(group.buckets)
        ? group.buckets
        : (Array.isArray(group.quotaBuckets)
          ? group.quotaBuckets
          : (Array.isArray(group.quota_buckets)
            ? group.quota_buckets
            : (Array.isArray(group.windows)
              ? group.windows
              : (Array.isArray(group.quotas) ? group.quotas : [group]))));

      for (const bucket of rawBuckets) {
        if (!bucket || typeof bucket !== 'object') continue;
        const qi = bucket.quotaInfo || bucket.quota_info || null;
        const bq = qi && typeof qi === 'object' ? { ...bucket, ...qi } : bucket;
        const remainingFraction = readQuotaFraction(bq);
        const resetTime = bq.resetTime || bq.reset_time || null;
        if (remainingFraction == null && !resetTime) continue;

        const win = classifyQuotaWindow({ ...group, ...bq }, resetTime, nowMs);
        if (win === 'weekly') {
          upsertMergedPool(weeklyPoolMap, weeklyPools, {
            poolKey: `weekly:${groupKey}`,
            groupKey,
            windowType: 'weekly',
            poolName: groupDisplayName,
            modelId: modelIds[0] || groupId || null,
            remainingFraction,
            resetTime,
            models: modelLabels,
            modelIds
          });
        } else {
          upsertMergedPool(summaryShortMap, summaryShortPools, {
            poolKey: groupKey,
            groupKey,
            windowType: win,
            poolName: groupDisplayName,
            modelId: modelIds[0] || groupId || null,
            remainingFraction,
            resetTime,
            models: modelLabels,
            modelIds
          });
        }
      }
    }

    if (!pools.some(p => p.remainingFraction != null || p.resetTime != null) && summaryShortPools.length > 0) {
      for (const sp of summaryShortPools) {
        upsertMergedPool(poolMap, pools, sp);
      }
    }

    if (weeklyPools.length === 0) {
      for (const p of pools) {
        if (p.windowType !== 'weekly') continue;
        const gk = classifyQuotaGroupKey(p.poolKey, p.poolName, [p.modelId, ...(p.models || [])]);
        upsertMergedPool(weeklyPoolMap, weeklyPools, {
          poolKey: `weekly:${gk}`,
          groupKey: gk,
          windowType: 'weekly',
          poolName: getQuotaGroupDisplayName(gk, p.poolName),
          modelId: p.modelId,
          remainingFraction: p.remainingFraction,
          resetTime: p.resetTime,
          models: p.models,
          modelIds: p.modelId ? [p.modelId] : []
        });
      }
    }

    const groupPriority = { gemini: 0, 'gemini-argon': 1, 'third-party': 2 };
    weeklyPools.sort((a, b) => {
      const pa = Object.prototype.hasOwnProperty.call(groupPriority, a.groupKey) ? groupPriority[a.groupKey] : 99;
      const pb = Object.prototype.hasOwnProperty.call(groupPriority, b.groupKey) ? groupPriority[b.groupKey] : 99;
      return pa - pb;
    });

    const usageEvents = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const prevCalibration = options.calibrationMap && typeof options.calibrationMap === 'object' ? options.calibrationMap : {};
    const nextCalibration = { ...prevCalibration };

    for (const pool of pools) {
      const est = computePoolTokenEstimate(pool, {
        nowMs,
        usageEvents,
        calibrationEntry: prevCalibration[pool.poolKey] || null
      });
      pool.estRemainingTokens = est.estRemainingTokens;
      pool.estRemainingZh = est.estRemainingZh;
      pool.estTotalTokens = est.estTotalTokens;
      pool.estSource = est.estSource;
      pool.cycleTokensUsed = est.cycleTokensUsed;
      if (est.nextCalibrationEntry) {
        nextCalibration[pool.poolKey] = est.nextCalibrationEntry;
      }
    }

    for (const wPool of weeklyPools) {
      const est = computePoolTokenEstimate(wPool, {
        nowMs,
        usageEvents,
        calibrationEntry: prevCalibration[wPool.poolKey] || null,
        matchPoolKey: evPoolKey => doesModelPoolBelongToGroup(evPoolKey, '', wPool)
      });
      wPool.estRemainingTokens = est.estRemainingTokens;
      wPool.estRemainingZh = est.estRemainingZh;
      wPool.estTotalTokens = est.estTotalTokens;
      wPool.estSource = est.estSource;
      wPool.cycleTokensUsed = est.cycleTokensUsed;
      if (est.nextCalibrationEntry) {
        nextCalibration[wPool.poolKey] = est.nextCalibrationEntry;
      }
    }

    const cleanModel = String(currentModel || '').trim();
    let matchedPool = null;
    let activeLabel = '';
    if (cleanModel) {
      const targetPoolKey = getModelPoolKey(cleanModel);
      if (targetPoolKey !== 'unknown' && poolMap.has(targetPoolKey)) {
        matchedPool = poolMap.get(targetPoolKey);
      }
      if (!matchedPool) {
        const directMatch = resolveModelQuota(cleanModel, list);
        if (directMatch) {
          matchedPool = poolMap.get(directMatch.poolKey) || null;
          activeLabel = directMatch.baseName || directMatch.label || '';
        }
      }
      if (!matchedPool) {
        const lowQuery = cleanModel.toLowerCase();
        matchedPool = pools.find(p =>
          (p.modelId && p.modelId.toLowerCase() === lowQuery) ||
          (p.poolName && (p.poolName.toLowerCase().includes(lowQuery) || lowQuery.includes(p.poolName.toLowerCase()))) ||
          p.models.some(m => m.toLowerCase().includes(lowQuery) || lowQuery.includes(m.toLowerCase()))
        ) || null;
      }
      if (matchedPool && !activeLabel) {
        activeLabel = matchedPool.poolName;
      }
    }

    const matchedByModel = Boolean(matchedPool);
    const active = matchedPool || pools.find(p => p.remainingFraction != null) || pools[0] || null;
    const hasShortData = pools.some(p => p.remainingFraction != null || p.resetTime != null);

    let matchedWeekly = null;
    if (weeklyPools.length > 0 && cleanModel) {
      const targetPoolKey = matchedPool?.poolKey || getModelPoolKey(cleanModel);
      const effectivePoolKey = targetPoolKey === 'unknown' ? '' : targetPoolKey;
      matchedWeekly = weeklyPools.find(wp =>
        doesModelPoolBelongToGroup(effectivePoolKey, cleanModel || matchedPool?.modelId || '', wp)
      ) || null;
    }
    const weeklyMatchedByModel = Boolean(matchedWeekly);
    const activeWeekly = matchedWeekly || weeklyPools.find(w => w.remainingFraction != null) || weeklyPools[0] || null;
    const hasWeeklyData = weeklyPools.some(w => w.remainingFraction != null || w.resetTime != null);
    const hasData = hasShortData || hasWeeklyData;

    return {
      hasData,
      hasShortData,
      hasWeeklyData,
      matchedByModel,
      weeklyMatchedByModel,
      currentModel: cleanModel || null,
      active: active ? { ...active, activeLabel: activeLabel || active.poolName } : null,
      activeWeekly: activeWeekly ? { ...activeWeekly } : null,
      pools,
      weeklyPools,
      nextCalibration
    };
  }

  const api = {
    summarize,
    classifyRequestError,
    resolveModelQuota,
    getModelPoolKey,
    formatResetTimeZh,
    formatResetCountdownZh,
    formatApproxTokensZh,
    inferQuotaCycleStartMs,
    classifyQuotaWindow,
    extractQuotaSummaryGroups,
    summarizeModelQuotaPools,
    measure,
    add,
    empty,
    analyzeSteps,
    parseDurationSec,
    GEMINI_PRICING_TABLE,
    SUBSCRIPTION_ACQUISITION_PRESETS,
    SUBSCRIPTION_REGIONS_PRESET,
    findRegionPreset,
    convertToCNY,
    CURRENCY_SYMBOLS,
    normalizeModelId,
    calculateRequestApiCost,
    summarizeApiCost,
    calculateReferenceModelCost,
    resolveEffectivePlanStatus,
    parseUserPlanStatus,
    parseGeneratorCall,
    extractModelString,
    normalizeTokenHistoryPayload,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    clearDailyCostCache,
    parseSemver,
    compareVersions,
    filterReleases,
    findReleaseAsset,
    isValidExternalUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__AGContextMeterCore = api;
})(globalThis);
