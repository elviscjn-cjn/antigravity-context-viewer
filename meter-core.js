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

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const text = typeof raw === 'object'
      ? [raw.modelId, raw.model, raw.label, raw.modelDisplayName, raw.modelOrAlias?.model, raw.poolKey].filter(Boolean).join(' ')
      : String(raw);
    const s = String(text || '').toLowerCase().trim();
    if (!s) return 'unknown';
    if (s.includes('carbon') || s.includes('gemini-4-carbon') || s.includes('m670')) {
      return 'gemini-4-carbon';
    }
    // 优先匹配 Argon / Orchestrator (Argon)，允许裸 gemini-pro-orchestrator 与已知变体但不吞并未知后缀
    if (s.includes('argon') || s.includes('gemini-4-argon') || s.includes('m668') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(s)) {
      return 'gemini-4-argon';
    }
    if (s.includes('neon') || s.includes('gemini-4-neon')) {
      return 'gemini-4-neon';
    }
    if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) {
      return 'gemini-4-hydrogen';
    }
    if (s.includes('flash') || s.includes('gemini-3.8-flash') || s.includes('gemini-3-flash') || s.includes('gemini-2.5-flash')) {
      return 'gemini-3.8-flash';
    }
    if (s.includes('pro') && (s.includes('gemini-3') || s.includes('gemini-4') || s.includes('high') || s.includes('low'))) {
      return 'gemini-4-hydrogen';
    }
    if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
    if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
    if (s.includes('claude')) return 'claude-sonnet-5-5';
    if (s.includes('gpt-oss') || s.includes('gpt')) return 'gpt-oss-120b';
    return s.replace(/[^a-z0-9_-]/g, '') || 'unknown';
  }

  function getSharedQuotaGroupKey(raw) {
    const pk = getModelPoolKey(raw);
    if (pk === 'gemini-4-neon' || pk === 'gemini-4-hydrogen' || pk === 'gemini-3.8-flash') return 'shared_gemini_main';
    if (pk === 'claude-opus-5-5' || pk === 'claude-sonnet-5-5' || pk === 'gpt-oss-120b') return 'shared_3p_pool';
    if (pk === 'gemini-4-argon') return 'shared_gemini_argon';
    if (pk === 'gemini-4-carbon') return 'shared_gemini_carbon';
    return pk && pk !== 'unknown' ? `shared_${pk}` : 'unknown';
  }

  function formatLocalDateStr(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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

  function parseQuotaFraction(rawQuota, options = {}) {
    if (!rawQuota || typeof rawQuota !== 'object') {
      return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
    }
    const candidates = [
      rawQuota.remainingFraction,
      rawQuota.remaining_fraction,
      rawQuota.fraction
    ];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        const clamped = Math.max(0, Math.min(1, c));
        return {
          fraction: clamped,
          hasValue: true,
          isExhausted: clamped === 0,
          source: 'fraction'
        };
      }
    }
    const amtCandidates = [rawQuota.remainingAmount, rawQuota.remaining_amount, rawQuota.remaining];
    for (const rawAmt of amtCandidates) {
      if (rawAmt === undefined || rawAmt === null || rawAmt === '') continue;
      // Protobuf int64 在 protojson 中常序列化为十进制数字字符串
      const amt = typeof rawAmt === 'number'
        ? rawAmt
        : (typeof rawAmt === 'string' && /^-?\d+(\.\d+)?$/.test(rawAmt.trim()) ? Number(rawAmt.trim()) : NaN);
      if (Number.isFinite(amt)) {
        if (amt <= 0) {
          return { fraction: 0, hasValue: true, isExhausted: true, source: 'amount_zero' };
        }
        const rawTotal = rawQuota.limit ?? rawQuota.totalAmount ?? rawQuota.total ?? null;
        const total = rawTotal === null || rawTotal === undefined || rawTotal === '' ? NaN : Number(rawTotal);
        if (Number.isFinite(total) && total > 0) {
          const clamped = Math.max(0, Math.min(1, amt / total));
          return { fraction: clamped, hasValue: true, isExhausted: clamped === 0, source: 'amount_ratio' };
        }
        // 正余量但缺少可靠的额度总量依据时，返回未知比例而非强行换算或落入零额度耗尽
        return { fraction: null, hasValue: false, isExhausted: false, source: 'amount_without_total' };
      }
    }
    // 仅在有明确协议依据的消息（exa.codeium_common_pb.QuotaInfo，普通 proto3 float + json omitempty）中，
    // 若非不可用/已禁用且存在有效 resetTime、同时无其它冲突字段时，才将省略的 remainingFraction 按 0 耗尽处理；
    // 对于 QuotaSummaryBucket（oneof remaining）或未指明契约的任意缺字段响应，证据不足一律视为未知。
    const canInferProto3ScalarZero = options.schemaKind === 'codeium_quota_info' || options.allowProto3ZeroDefault === true;
    const isExplicitlyDisabled = Boolean(options.unavailable || rawQuota.disabled === true);
    const hasResetStr = typeof (rawQuota.resetTime || rawQuota.reset_time) === 'string'
      && String(rawQuota.resetTime || rawQuota.reset_time).trim().length > 0
      && !isNaN(Date.parse(rawQuota.resetTime || rawQuota.reset_time));
    if (canInferProto3ScalarZero && !isExplicitlyDisabled && hasResetStr) {
      return { fraction: 0, hasValue: true, isExhausted: true, source: 'proto3_zero_with_reset' };
    }
    return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
  }

  function formatQuotaPercentText(fraction) {
    if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '未知';
    const f = Math.max(0, Math.min(1, Number(fraction)));
    if (f === 0) return '0%';
    const pct = f * 100;
    if (pct < 0.1) return '<0.1%';
    if (pct < 1) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
  }

  function formatQuotaResetMeta(resetTimeIso, nowMs = Date.now()) {
    if (!resetTimeIso || typeof resetTimeIso !== 'string') {
      return {
        hasResetTime: false,
        resetTimeIso: null,
        resetAtMs: null,
        resetTimeText: null,
        countdownText: null,
        countdownMs: null,
        isResetPassed: false
      };
    }
    const parsedMs = Date.parse(resetTimeIso);
    if (!Number.isFinite(parsedMs)) {
      return {
        hasResetTime: false,
        resetTimeIso: null,
        resetAtMs: null,
        resetTimeText: null,
        countdownText: null,
        countdownMs: null,
        isResetPassed: false
      };
    }
    const d = new Date(parsedMs);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const resetTimeText = `${mm}-${dd} ${hh}:${mi}`;
    const diffMs = parsedMs - nowMs;
    if (diffMs <= 0) {
      return {
        hasResetTime: true,
        resetTimeIso,
        resetAtMs: parsedMs,
        resetTimeText,
        countdownText: '已到重置时间（待确认）',
        countdownMs: 0,
        isResetPassed: true
      };
    }
    const totalSec = Math.ceil(diffMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    let countdownText;
    if (days > 0) countdownText = `${days}天${hours}小时`;
    else if (hours > 0) countdownText = `${hours}小时${mins}分`;
    else if (mins > 0) countdownText = `${mins}分`;
    else countdownText = `${Math.max(1, secs)}秒`;
    return {
      hasResetTime: true,
      resetTimeIso,
      resetAtMs: parsedMs,
      resetTimeText,
      countdownText,
      countdownMs: diffMs,
      isResetPassed: false
    };
  }

  const DECORATIVE_BADGE_TAG_RE = /^(new|beta|preview|alpha|experimental|recommended|updated|hot|popular|最新|预览|預覽|推荐|推薦)$/i;

  /**
   * 判断模型角标文本是否仅为装饰性标签，不能作为不可用或故障原因
   */
  function isDecorativeBadgeTagTitle(tagTitle) {
    return typeof tagTitle === 'string' && DECORATIVE_BADGE_TAG_RE.test(tagTitle.trim());
  }

  /**
   * 将账号套餐字段规范化为精确允许匹配的套餐标识集合，禁止宽泛子串误放行受限账号
   */
  function buildAllowedTierMatchSet(planStatus) {
    if (!planStatus || typeof planStatus !== 'object') return null;
    const rawTierKey = typeof planStatus.tierKey === 'string' ? planStatus.tierKey.trim().toLowerCase() : '';
    const rawTierId = typeof planStatus.tierId === 'string' ? planStatus.tierId.trim().toLowerCase() : '';
    const rawTeamsTier = typeof planStatus.teamsTier === 'string' ? planStatus.teamsTier.trim().toLowerCase() : '';

    // 套餐尚未识别且无任何具体层级标识时，不执行 allowedTiers 猜测拦截
    if (planStatus.status === 'unidentified' || ((!rawTierKey || rawTierKey === 'unknown') && !rawTierId && !rawTeamsTier)) {
      return null;
    }

    const tokens = new Set();
    if (rawTierId) tokens.add(rawTierId);
    if (rawTeamsTier) tokens.add(rawTeamsTier);
    if (rawTierKey && rawTierKey !== 'unknown' && rawTierKey !== 'custom') tokens.add(rawTierKey);

    const isUltraTier = rawTierKey === 'ultra' ||
      rawTierId === 'g1-ultra-tier' ||
      rawTeamsTier === 'teams_tier_pro_ultimate' ||
      rawTeamsTier === 'teams_tier_ultra';
    const isProTier = !isUltraTier && (
      rawTierKey === 'pro' ||
      rawTierId === 'g1-pro-tier' ||
      rawTeamsTier === 'teams_tier_pro'
    );
    const isPlusTier = rawTierKey === 'plus' ||
      rawTierId === 'g1-plus-tier' ||
      rawTeamsTier === 'teams_tier_plus';
    const isFreeTier = rawTierKey === 'free' ||
      rawTierId === 'free-tier' ||
      rawTeamsTier === 'teams_tier_free';

    if (isUltraTier) {
      // Ultra 账号向上覆盖 Ultimate，并兼容上游可能回传或缺失 TEAMS_TIER_PRO 的情况；不放行未声明的企业专享档位
      tokens.add('ultra');
      tokens.add('g1-ultra-tier');
      tokens.add('teams_tier_pro_ultimate');
      tokens.add('teams_tier_ultra');
      tokens.add('ultimate');
      tokens.add('teams_tier_pro');
      tokens.add('g1-pro-tier');
      tokens.add('pro');
    } else if (isProTier) {
      tokens.add('pro');
      tokens.add('g1-pro-tier');
      tokens.add('teams_tier_pro');
    } else if (isPlusTier) {
      tokens.add('plus');
      tokens.add('g1-plus-tier');
      tokens.add('teams_tier_plus');
    } else if (isFreeTier) {
      tokens.add('free');
      tokens.add('free-tier');
      tokens.add('teams_tier_free');
    }

    return tokens.size > 0 ? tokens : null;
  }

  function classifyModelQuotaAvailability(config, planStatus = null) {
    if (!config || typeof config !== 'object') {
      return { noPermission: false, unavailable: false, reason: null, noticeTitle: null, noticeText: null };
    }
    const tagTitle = typeof config.tagTitle === 'string' ? config.tagTitle.trim() : '';
    const tagDesc = typeof config.tagDescription === 'string' ? config.tagDescription.trim() : '';
    const isTagUnavailable = /^(unavailable|disabled|不可用|无权限|無權限)$/i.test(tagTitle) || /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
    const isDecorativeBadgeTag = isDecorativeBadgeTagTitle(tagTitle);
    const isExplicitNoticeTag = /^notice$/i.test(tagTitle);
    const isTagNotice = !isTagUnavailable && (Boolean(tagDesc) || isExplicitNoticeTag || (Boolean(tagTitle) && !isDecorativeBadgeTag));

    let tierBlocked = false;
    let tierReason = null;
    if (Array.isArray(config.allowedTiers) && config.allowedTiers.length > 0) {
      const allowedTokens = buildAllowedTierMatchSet(planStatus);
      if (allowedTokens) {
        const hit = config.allowedTiers.some(v => allowedTokens.has(String(v || '').trim().toLowerCase()));
        if (!hit) {
          tierBlocked = true;
          tierReason = `仅限 ${config.allowedTiers.join(' / ')} 套餐可用`;
        }
      }
    }

    const explicitlyDisabled = Boolean(
      config.disabled === true ||
      config.enabled === false ||
      config.unavailable === true ||
      config.isUnavailable === true ||
      config.status === 'unavailable' ||
      isTagUnavailable ||
      tierBlocked
    );

    const hasConfigNotice = typeof config.notice === 'string' && config.notice.trim() && !explicitlyDisabled;
    const noticeText = isTagNotice
      ? (tagDesc || (!isDecorativeBadgeTag ? tagTitle : null))
      : (hasConfigNotice ? config.notice.trim() : null);

    // 清洗服务端或上游缓存中可能被装饰角标污染的 reason，确保真实故障原因不被 New 等角标覆盖
    const rawConfigReason = typeof config.unavailabilityReason === 'string' ? config.unavailabilityReason.trim() : '';
    const cleanConfigReason = (rawConfigReason && !isDecorativeBadgeTagTitle(rawConfigReason)) ? rawConfigReason : '';
    const nonDecorativeTagTitle = (!isDecorativeBadgeTag && tagTitle) ? tagTitle : null;

    const unavailabilityReason = tierBlocked
      ? (cleanConfigReason || tierReason || tagDesc || nonDecorativeTagTitle || '当前套餐无权访问该模型')
      : (cleanConfigReason || tagDesc || nonDecorativeTagTitle || tierReason || '当前套餐无权访问该模型');

    return {
      noPermission: explicitlyDisabled,
      unavailable: explicitlyDisabled,
      reason: explicitlyDisabled ? unavailabilityReason : null,
      noticeTitle: (noticeText && (isTagNotice || hasConfigNotice)) ? (tagTitle || 'Notice') : null,
      noticeText: noticeText || null
    };
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs, options = {}) {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const rawStr = typeof modelIdOrName === 'object'
      ? String(modelIdOrName.modelId || modelIdOrName.modelOrAlias?.model || modelIdOrName.label || modelIdOrName.model || '')
      : String(modelIdOrName);
    const poolKey = getModelPoolKey(rawStr);
    const targetLower = rawStr.trim().toLowerCase();
    const targetStripped = targetLower.replace(/^model_/, '');

    // 1. 优先精准匹配 modelId / modelOrAlias.model / model / label（兼容 MODEL_ 前缀）
    let matched = cascadeModelConfigs.find(c => {
      if (!c || typeof c !== 'object') return false;
      const cands = [c.modelId, c.modelOrAlias?.model, c.model, c.label]
        .filter(v => typeof v === 'string' && v.trim())
        .map(v => v.trim().toLowerCase());
      return cands.some(v => v === targetLower || v.replace(/^model_/, '') === targetStripped);
    });

    // 2. 匹配同一产品组 / 配额池
    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(c);
        return cPool === poolKey;
      });
    }

    if (!matched) return null;

    const avail = classifyModelQuotaAvailability(matched, options?.planStatus || null);
    const qi = matched.quotaInfo || {};
    const parsed = parseQuotaFraction(qi, { unavailable: avail.noPermission, schemaKind: 'codeium_quota_info' });
    const poolNames = {
      'gemini-4-argon': 'Gemini 4 Argon 配额池（周限额）',
      'gemini-4-neon': 'Gemini 4 Neon / Hydrogen / 3.8 Flash 共享池',
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen / 3.8 Flash 共享池',
      'gemini-3.8-flash': 'Gemini 3.8 Flash / Hydrogen 共享池',
      'gemini-4-carbon': 'Gemini 4 Carbon 配额池',
      'claude-opus-5-5': 'Claude / GPT-OSS 第三方共享池',
      'claude-sonnet-5-5': 'Claude / GPT-OSS 第三方共享池',
      'gpt-oss-120b': 'Claude / GPT-OSS 第三方共享池'
    };

    return {
      modelId: matched.modelId || matched.modelOrAlias?.model || '',
      label: matched.label || rawStr,
      poolKey,
      sharedGroupKey: getSharedQuotaGroupKey(matched),
      poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额池` : '专属模型配额池'),
      remainingFraction: parsed.fraction,
      resetTime: qi.resetTime || null,
      isExhausted: parsed.isExhausted,
      noPermission: avail.noPermission,
      unavailabilityReason: avail.reason,
      noticeText: avail.noticeText
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

    // 取消只证明请求已中断，不证明由谁取消；普通 Go context 取消也属于此类。
    const canceledMatch = /(?:\bcontext cancel(?:l)?ed\b|\buser cancel(?:l)?ed\b|request was aborted|AbortError)/i.test(error);

    // 2. 模型或额度池耗尽 (Quota Exhausted)
    const explicitQuotaMatch = /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
    const quotaZeroEvidence = !canceledMatch && Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);

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

    // 4. 请求取消或中断 (Canceled)，不推断取消发起方或当前轮次状态。
    if (canceledMatch) {
      return {
        kind: 'canceled',
        title: '请求中断',
        badgeText: '已中断',
        detail: '最近一次生成请求已中断，无法仅凭此记录确定取消来源或当前请求状态',
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
    const modelRaw = String(m.model || m.modelOrAlias?.model || m.responseModel || m.modelDisplayName || options.currentModel || '').trim();
    const modelId = resolveStableModelId(m, options.cascadeModelConfigs || []) || resolveStableModelId(options.currentModel, options.cascadeModelConfigs || []) || null;

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
    if (output && streamingSec && streamingSec >= 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const speedInputTokens = hasInput ? ((input || 0) + (cached || 0)) : null;
    const speedExp = (!error && output != null && ttft != null && duration != null && streamingTps != null)
      ? calculateExperienceScore({
          outputTokens: output,
          totalInputTokens: speedInputTokens,
          ttftSec: ttft,
          streamingSec,
          totalDurationSec: duration,
          streamSpeed: streamingTps
        })
      : { available: false, score: null, grade: null, ruleVersion: ELV91_SCORE_RULE_VERSION };
    const speed = (tps !== null || duration !== null || output !== null || ttft !== null) ? {
      tps,
      streamingTps,
      streamSpeed: streamingTps,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      ttftRatio: (ttft !== null && duration !== null && duration > 0) ? Number(Math.min(100, Math.max(0, (ttft / duration) * 100)).toFixed(1)) : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0),
      totalInputTokens: speedInputTokens,
      eScore: speedExp.score,
      eGrade: speedExp.grade,
      scoreRuleVersion: ELV91_SCORE_RULE_VERSION
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
      modelId,
      modelRaw,
      status,
      speed
    };
  }
  function measure(text, outAcc = null) {
    text = String(text || '');
    const len = text.length;
    let chars = 0, bytes = 0, cjk = 0;
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      if (c <= 127) {
        chars++;
        bytes++;
      } else if (c <= 2047) {
        chars++;
        bytes += 2;
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
        const c2 = text.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          i++;
          chars++;
          bytes += 4;
          continue;
        }
        chars++;
        bytes += 3;
      } else {
        chars++;
        bytes += 3;
        if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
      }
    }
    if (outAcc) {
      outAcc.chars += chars;
      outAcc.bytes += bytes;
      outAcc.cjk += cjk;
      return outAcc;
    }
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
    // 直接按与原 content()+measure() 等价的逻辑流式累计 chars/bytes/cjk，避免分配巨型中间拼接字符串
    const toolAcc = { chars: 0, bytes: 0, cjk: 0 };
    function accumulateContent(value, acc) {
      if (typeof value === 'string') { measure(value, acc); return; }
      if (typeof value === 'number' || typeof value === 'boolean') { measure(String(value), acc); return; }
      if (!value) return;
      if (Array.isArray(value)) {
        for (let idx = 0; idx < value.length; idx++) {
          if (idx > 0) { acc.chars += 1; acc.bytes += 1; }
          accumulateContent(value[idx], acc);
        }
        return;
      }
      const keys = Object.keys(value);
      let wrote = false;
      for (let idx = 0; idx < keys.length; idx++) {
        const key = keys[idx];
        if (skip.has(key)) continue;
        if (wrote) { acc.chars += 1; acc.bytes += 1; }
        wrote = true;
        measure(key, acc);
        acc.chars += 2; // ': '
        acc.bytes += 2;
        accumulateContent(value[key], acc);
      }
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
        toolAcc.chars = 0; toolAcc.bytes = 0; toolAcc.cjk = 0;
        const stepKeys = Object.keys(s);
        let wroteStep = false;
        const withinToolStep = new Set();
        for (let kIdx = 0; kIdx < stepKeys.length; kIdx++) {
          const k = stepKeys[kIdx];
          if (k === 'type' || k === 'status' || k === 'metadata' || k === 'error') continue;
          if (!skip.has(k)) {
            if (wroteStep) { toolAcc.chars += 1; toolAcc.bytes += 1; }
            wroteStep = true;
            measure(k, toolAcc);
            toolAcc.chars += 2;
            toolAcc.bytes += 2;
            accumulateContent(s[k], toolAcc);
          }
          if (!skip.has(k) || k === 'media') {
            attachments(s[k], 'assistant', withinToolStep);
          }
        }
        if (toolAcc.chars > 0 || toolAcc.bytes > 0) {
          const middle = (toolAcc.chars - toolAcc.cjk) / 4 + toolAcc.cjk * 1.2;
          add(groups.tools, {
            chars: toolAcc.chars,
            bytes: toolAcc.bytes,
            low: Math.ceil(middle * .7),
            high: Math.ceil(Math.max(middle * 1.6, toolAcc.bytes / 2))
          });
        }
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    return { groups, total, media: [...media.values()], steps: steps.length, userMessages, assistantMessages, currentError };
  }

  // 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
  // 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
  // 来源: https://ai.google.dev/gemini-api/docs/pricing , https://aistudio.google.com/docs/pricing
  //       https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/
  //       https://platform.claude.com/docs/en/about-claude/pricing
  // 核对日期: 2026-11-16 (合入 PR #9，保留并校验 Gemini 4 Argon / Carbon / Hydrogen 与 Claude 5.5 官方公开费率)
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
    'gemini-4-hydrogen': [
      {
        inputPerMillion: 1.50,
        outputPerMillion: 7.50,
        cacheReadPerMillion: 0.075
      }
    ],
    'gemini-4-carbon': [
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
    ],
    'claude-opus-5-5': [
      {
        inputPerMillion: 4.00,
        outputPerMillion: 20.00,
        cacheReadPerMillion: 0.20
      }
    ],
    'claude-sonnet-5-5': [
      {
        inputPerMillion: 2.00,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.10
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
    if (str.includes('4-hydrogen') || str.includes('4 hydrogen') || str.includes('hydrogen')) return 'gemini-4-hydrogen';
    // 注：2.32.1 客户端已将 gemini-pro-orchestrator 明确归为 Orchestrator (Argon)，仅明确的 carbon / m670 归为 gemini-4-carbon；未知 orchestrator 后缀保持未计价
    if (str.includes('4-carbon') || str.includes('4 carbon') || str.includes('carbon') || str.includes('m670')) return 'gemini-4-carbon';
    if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?$/.test(str) || str.includes('m668')) return 'gemini-4-argon';
    if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
    if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
    if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
    if (/(?:opus[-_ ]5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])|5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])[-_ ]opus)/.test(str)) return 'claude-opus-5-5';
    if (/(?:sonnet[-_ ]5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])|5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])[-_ ]sonnet)/.test(str)) return 'claude-sonnet-5-5';
    return null;
  }

  /**
   * 解析准确模型标识用于按模型保存上下文偏好（不做计费家族归一化）
   * 优先级：精确 ID 字段 -> cascadeModelConfigs 精确 ID 匹配 -> 仅在无准确 ID 时按唯一 label 反查 -> 规范化原始标识
   */
  function resolveStableModelId(input, cascadeModelConfigs = []) {
    let idCandidates = [];
    let labelCandidates = [];

    if (typeof input === 'string') {
      const s = input.trim();
      if (!s) return null;
      idCandidates = [s];
      labelCandidates = [s];
    } else if (input && typeof input === 'object') {
      const cm = input.chatModel || input;
      const displaySet = new Set(
        [cm.modelDisplayName, cm.label]
          .filter(v => typeof v === 'string' && v.trim())
          .map(v => v.trim())
      );
      const rawIds = [
        cm.modelId,
        cm.modelOrAlias?.model,
        cm.modelRaw,
        cm.chatStartMetadata?.model,
        cm.responseModel,
        cm.model
      ];
      const seenId = new Set();
      for (const val of rawIds) {
        if (typeof val !== 'string') continue;
        const t = val.trim();
        if (!t || seenId.has(t)) continue;
        // summarize 结果里的 model 可能是纯显示名（与 modelDisplayName 相同），此时不应挤占准确 ID
        if (val === cm.model && displaySet.has(t) && (cm.modelId || cm.modelRaw || cm.modelOrAlias?.model)) {
          continue;
        }
        seenId.add(t);
        idCandidates.push(t);
      }
      labelCandidates = Array.from(displaySet);
    }

    if (!idCandidates.length && !labelCandidates.length) return null;

    const pickConfigCanonicalId = (cfg) => {
      const alias = String(cfg?.modelOrAlias?.model || '').trim();
      const mId = String(cfg?.modelId || '').trim();
      if (alias && mId) {
        // 若同一 alias 被多个不同 modelId（如 low/high 档位）共用，则以具体 modelId 区分档位；否则优先 alias
        const sameAliasCount = cascadeModelConfigs.filter(
          x => String(x?.modelOrAlias?.model || '').trim().toLowerCase() === alias.toLowerCase()
        ).length;
        return (sameAliasCount > 1 ? mId : alias).toLowerCase();
      }
      const chosen = alias || mId || String(cfg?.label || '').trim();
      return chosen ? chosen.toLowerCase() : null;
    };

    const stripModelPrefix = (v) => String(v || '').trim().toLowerCase().replace(/^model_/, '');

    if (Array.isArray(cascadeModelConfigs) && cascadeModelConfigs.length) {
      // 1. 优先按准确 ID 精确匹配（兼容 Protobuf MODEL_ 前缀，绝不受 label 文本影响）
      for (const cand of idCandidates) {
        const candLower = cand.toLowerCase();
        const candStripped = stripModelPrefix(cand);
        const matched = cascadeModelConfigs.find((c) => {
          const mId = String(c?.modelId || '').trim().toLowerCase();
          const aliasId = String(c?.modelOrAlias?.model || '').trim().toLowerCase();
          return (
            (mId && (mId === candLower || stripModelPrefix(mId) === candStripped)) ||
            (aliasId && (aliasId === candLower || stripModelPrefix(aliasId) === candStripped))
          );
        });
        if (matched) {
          return pickConfigCanonicalId(matched);
        }
      }

      // 2. 仅当没有任何可独立识别的准确 ID 时，才允许按唯一 label 反查
      const hasDistinctId = idCandidates.some(id => !labelCandidates.includes(id));
      if (!hasDistinctId) {
        for (const lblCand of labelCandidates) {
          const lblLower = lblCand.toLowerCase();
          const labelMatches = cascadeModelConfigs.filter(
            c => String(c?.label || '').trim().toLowerCase() === lblLower
          );
          if (labelMatches.length === 1) {
            return pickConfigCanonicalId(labelMatches[0]);
          }
        }
      }
    }

    const chosen = (idCandidates[0] || labelCandidates[0] || '').trim().toLowerCase();
    return chosen || null;
  }

  // 力度档位白名单（按长度降序排列，防止 Extra High / XHigh 被部分匹配为 High/Extra）
  const EFFORT_WHITELIST = ['Extra High', 'XHigh', 'Low', 'Medium', 'High', 'Extra', 'Minimal', 'Max'];
  // 预编译档位解析正则，避免 groupModelProduct 高频调用时重复编译 RegExp
  const EFFORT_REGEX_PARTS = EFFORT_WHITELIST.map(e => e.replace(/\s+/g, '\\s+')).join('|');
  const EFFORT_PAREN_RE = new RegExp(`^(.+?)\\s*[\\(（](${EFFORT_REGEX_PARTS})[\\)）]\\s*$`, 'i');
  const EFFORT_SUFFIX_RE = new RegExp(`^(.+?)\\s+(${EFFORT_REGEX_PARTS})\\s*$`, 'i');
  const EFFORT_LABEL_ZH = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };
  const EFFORT_LABEL_TW = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };

  function normalizeEffortValue(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    if (!s) return null;
    if (s === 'x high' || s === 'xhigh') return 'XHigh';
    for (const item of EFFORT_WHITELIST) {
      if (item.toLowerCase() === s) return item;
    }
    return null;
  }

  /**
   * 拆分模型展示名与尾部重复档位括号，确保产品名与思考档位分离且不重复拼接。
   * 例如 "Gemini 4 Hydrogen (High) (High)" -> { baseLabel: "Gemini 4 Hydrogen", effort: "High" }
   */
  function splitModelDisplayAndEffort(displayText, explicitEffort = null) {
    let baseLabel = String(displayText || '').trim();
    let extractedEffort = normalizeEffortValue(explicitEffort || '');
    for (let i = 0; i < 4 && baseLabel; i++) {
      const mParen = baseLabel.match(EFFORT_PAREN_RE);
      if (mParen) {
        baseLabel = mParen[1].trim();
        if (!extractedEffort) extractedEffort = normalizeEffortValue(mParen[2]);
        continue;
      }
      const mSuffix = baseLabel.match(EFFORT_SUFFIX_RE);
      if (mSuffix) {
        baseLabel = mSuffix[1].trim();
        if (!extractedEffort) extractedEffort = normalizeEffortValue(mSuffix[2]);
        continue;
      }
      break;
    }
    return {
      baseLabel,
      effort: extractedEffort || null
    };
  }

  /**
   * 核对 MODEL_PLACEHOLDER_* 原始 ID 与客户端配置/可用模型表的可靠映射关系：
   * 分别输出 rawPlaceholderId、stableModelId、displayName 与 effort；
   * 严禁把未映射的原始占位 ID 直接冒充为已验证的实际路由模型。
   */
  function resolvePlaceholderModelInfo(rawInput, cascadeModelConfigs = [], availableModels = null) {
    const rawStr = typeof rawInput === 'string'
      ? rawInput.trim()
      : String(rawInput?.modelId || rawInput?.modelOrAlias?.model || rawInput?.modelRaw || rawInput?.model || '').trim();
    const isPlaceholder = /^model_placeholder_/i.test(rawStr);
    const configs = Array.isArray(cascadeModelConfigs) ? cascadeModelConfigs : [];
    const stripPrefix = s => String(s || '').trim().toLowerCase().replace(/^model_/, '');

    let matchedCfg = null;
    if (rawStr && configs.length) {
      const low = rawStr.toLowerCase();
      const stripped = stripPrefix(rawStr);
      matchedCfg = configs.find(c => {
        const mId = String(c?.modelId || '').trim().toLowerCase();
        const alias = String(c?.modelOrAlias?.model || '').trim().toLowerCase();
        return (mId && (mId === low || stripPrefix(mId) === stripped))
          || (alias && (alias === low || stripPrefix(alias) === stripped));
      }) || null;
    }

    let matchedAvailKey = null;
    let matchedAvailObj = null;
    if (!matchedCfg && rawStr && availableModels && typeof availableModels === 'object') {
      const low = rawStr.toLowerCase();
      const stripped = stripPrefix(rawStr);
      for (const [k, v] of Object.entries(availableModels)) {
        const vk = String(v?.model || '').trim().toLowerCase();
        if (k.toLowerCase() === low || (vk && (vk === low || stripPrefix(vk) === stripped))) {
          matchedAvailKey = k;
          matchedAvailObj = v;
          break;
        }
      }
    }

    const explicitDisplay = (rawInput && typeof rawInput === 'object')
      ? String(rawInput.modelDisplayName || rawInput.modelLabel || '').trim()
      : '';
    const rawRespModel = (rawInput && typeof rawInput === 'object')
      ? String(rawInput.responseModel || rawInput.chatStartMetadata?.model || '').trim()
      : '';

    const rawDisplay = matchedCfg?.label
      || matchedAvailObj?.displayName
      || (explicitDisplay && !/^model_placeholder_/i.test(explicitDisplay) ? explicitDisplay : '')
      || '';
    const split = splitModelDisplayAndEffort(rawDisplay, (rawInput && typeof rawInput === 'object') ? rawInput.effort : null);

    const stableFromCfg = matchedCfg?.modelId
      ? String(matchedCfg.modelId).trim().toLowerCase()
      : (matchedAvailKey ? String(matchedAvailKey).trim().toLowerCase() : null);
    const nonPlaceholderCfgId = (stableFromCfg && !/^model_placeholder_/i.test(stableFromCfg)) ? stableFromCfg : null;
    const rawStrSlug = (!isPlaceholder && rawStr && /\s/.test(rawStr) && matchedCfg?.modelId && !/^model_placeholder_/i.test(matchedCfg.modelId))
      ? matchedCfg.modelId.toLowerCase()
      : null;
    const derivedSlug = split.baseLabel
      ? `${split.baseLabel}${split.effort ? `-${split.effort}` : ''}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
      : null;
    const cleanNonPlaceholderRaw = (!isPlaceholder && rawStr && !/\s/.test(rawStr)) ? rawStr.toLowerCase() : null;
    const hasReliableMapping = Boolean(
      (matchedCfg && (matchedCfg.label || (matchedCfg.modelId && !/^model_placeholder_/i.test(matchedCfg.modelId))))
      || (matchedAvailObj && matchedAvailObj.displayName)
      || (rawDisplay && !/^model_placeholder_/i.test(rawDisplay))
      || (rawRespModel && !/^model_placeholder_/i.test(rawRespModel))
    );

    const mappingSource = matchedCfg
      ? 'cascadeModelConfigs'
      : (matchedAvailObj ? 'availableModels' : ((rawDisplay || rawRespModel) ? 'explicit_response' : (isPlaceholder ? 'unmapped_placeholder' : 'direct_id')));

    return {
      rawPlaceholderId: isPlaceholder ? rawStr : null,
      rawId: rawStr || null,
      stableModelId: nonPlaceholderCfgId || rawStrSlug || cleanNonPlaceholderRaw || (hasReliableMapping ? derivedSlug : null),
      displayName: split.baseLabel || null,
      effort: split.effort || null,
      isPlaceholder,
      isMapped: hasReliableMapping,
      isRoutedModelVerified: Boolean((rawRespModel && !/^model_placeholder_/i.test(rawRespModel)) || hasReliableMapping),
      mappingSource
    };
  }

  /**
   * 档位展示映射：默认/英文返回标准英文名（如 Extra High），中文面板按繁简返回对照标签
   * @param {string} effort 原始力度值
   * @param {string} [lang='en'] 语言代码（'en' | 'zh-CN' | 'zh-TW'）
   */
  function formatEffortLabel(effort, lang = 'en') {
    if (!effort) return '';
    const norm = normalizeEffortValue(effort);
    if (!norm) return String(effort);
    const l = typeof lang === 'string' ? lang.trim().toLowerCase() : 'en';
    if (l === 'zh-cn' || l === 'zh-hans' || l === 'zh') {
      return EFFORT_LABEL_ZH[norm] || norm;
    }
    if (l === 'zh-tw' || l === 'zh-hant' || l === 'tw') {
      return EFFORT_LABEL_TW[norm] || norm;
    }
    return norm;
  }

  /**
   * 按名称或准确 ID 前缀识别厂商（不使用模糊子串匹配）
   */
  function detectModelVendor(productLabel, modelId) {
    const candidates = [productLabel, modelId]
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim().toLowerCase());
    for (const c of candidates) {
      if (c.startsWith('product:google:')) return 'Google';
      if (c.startsWith('product:anthropic:')) return 'Anthropic';
      if (c.startsWith('product:openai:')) return 'OpenAI';
      if (/^(?:models\/)?(?:gemini|google|gemma|imagen|veo)\b/.test(c)) return 'Google';
      if (/^(?:models\/)?(?:claude|anthropic)\b/.test(c)) return 'Anthropic';
      if (/^(?:models\/)?(?:gpt|openai|o1|o3|o4|chatgpt|codex)\b/.test(c)) return 'OpenAI';
    }
    return '其他';
  }

  /**
   * 模型产品分组纯函数：
   * 将同一产品的不同力度档位归为同一个 productKey；
   * Carbon/Argon 等产品后缀、版本号与代际保持独立，不进行模糊合并。
   */
  function groupModelProduct(config) {
    const obj = (config && typeof config === 'object') ? config : { label: typeof config === 'string' ? config : '' };
    const cm = obj.chatModel || obj;
    const rawId = String(cm.modelId || cm.modelOrAlias?.model || cm.modelRaw || (typeof config === 'string' ? config : '') || '').trim();
    const rawLabel = String(cm.label || cm.modelDisplayName || cm.model || '').trim();
    const explicitEffort = normalizeEffortValue(cm.effort || cm.thinkingEffort || cm.reasoningEffort || obj.effort || '');

    let effort = explicitEffort;
    let productLabel = rawLabel;

    // 仅当末尾括号（半角或全角）或后缀属于白名单档位词时才拆分为 effort（复用模块级预编译正则）
    const parenRe = EFFORT_PAREN_RE;
    const suffixRe = EFFORT_SUFFIX_RE;

    if (productLabel) {
      const mParen = productLabel.match(parenRe);
      if (mParen) {
        productLabel = mParen[1].trim();
        if (!effort) effort = normalizeEffortValue(mParen[2]);
      } else {
        const mSuffix = productLabel.match(suffixRe);
        if (mSuffix) {
          productLabel = mSuffix[1].trim();
          if (!effort) effort = normalizeEffortValue(mSuffix[2]);
        }
      }
    }

    if (!productLabel && rawId) {
      const idEffortRe = /^(.+?)[-_](extra[-_]?high|x[-_]?high|low|medium|high|extra|minimal|max)$/i;
      const mId = rawId.match(idEffortRe);
      if (mId) {
        productLabel = mId[1].trim();
        if (!effort) effort = normalizeEffortValue(mId[2]);
      } else {
        productLabel = rawId;
      }
    }

    if (!productLabel) productLabel = 'Unknown';
    const vendor = detectModelVendor(productLabel, rawId);
    const vendorSlugMap = { Google: 'google', Anthropic: 'anthropic', OpenAI: 'openai', 其他: 'other' };
    let slug = productLabel
      .toLowerCase()
      .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const pkMatch = rawId.toLowerCase().match(/^product:(google|anthropic|openai|other):(.+)$/);
    if (pkMatch && productLabel.toLowerCase() === rawId.toLowerCase()) {
      slug = pkMatch[2];
    }
    const productKey = `product:${vendorSlugMap[vendor] || 'other'}:${slug || rawId.toLowerCase() || 'unknown'}`;

    return {
      productKey,
      productLabel,
      vendor,
      effort: effort || null
    };
  }

  /**
   * 1000 进制 K 换算格式化，全项目统一口径（如 512000 -> 512K, 786432 -> 786.4K）
   */
  function formatTokensK(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const num = Number(v);
    if (num >= 1e6) return `${parseFloat((num / 1e6).toFixed(2))}M`;
    if (num >= 1000) return `${parseFloat((num / 1000).toFixed(1))}K`;
    return Math.round(num).toLocaleString('en-US');
  }

  /**
   * 判定单条记录是否为有效的实测速度样本
   */
  function isValidSpeedSample(call) {
    if (!call || typeof call !== 'object') return false;
    if (call.status !== 'final') return false;
    if (call.isEstimated === true || call.isSynthetic === true) return false;
    const out = Number(call.outputTokens);
    const dur = Number(call.durationSec);
    if (!Number.isFinite(out) || out <= 0) return false;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return true;
  }

  function computeMedian(values) {
    const clean = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!clean.length) return null;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  }

  const MAX_SPEED_SAMPLES_PER_MODEL = 200;

  /**
   * 按准确模型 ID（含档位）汇总速度对比统计（中位数、样本数、时间范围与折线序列）
   */
  function summarizeSpeedByModel(calls, options = {}) {
    const days = options.days;
    const originFilter = options.origin || 'all';
    const metric = options.metric || 'tps';
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const cutoffMs = (days === 7 || days === '7')
      ? nowMs - 7 * 86400000
      : (days === 30 || days === '30')
        ? nowMs - 30 * 86400000
        : null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

    const groups = new Map();
    for (const c of (Array.isArray(calls) ? calls : [])) {
      if (!isValidSpeedSample(c)) continue;
      if (originFilter !== 'all') {
        const recOrigin = c.origin === 'speed-test' ? 'speed-test' : 'chat';
        if (recOrigin !== originFilter) continue;
      }
      const ts = Number(c.timestamp) || (c.created_at ? Date.parse(c.created_at) : 0) || (c.date ? Date.parse(c.date) : 0) || 0;
      if (cutoffMs !== null && (!ts || ts < cutoffMs)) continue;

      const exactId = String(c.modelExactId || resolveStableModelId(c, cascadeConfigs) || c.model || '').trim().toLowerCase();
      if (!exactId) continue;

      const rawLabel = String(c.modelLabel || c.model || exactId).trim();
      const prod = groupModelProduct({ modelId: exactId, label: rawLabel, effort: c.effort });
      const outputTokens = Number(c.outputTokens);
      const durationSec = Number(c.durationSec);
      const tpsVal = Number.isFinite(Number(c.tps)) && Number(c.tps) > 0
        ? Number(c.tps)
        : Number((outputTokens / durationSec).toFixed(1));
      const ttftVal = (c.ttftSec !== undefined && c.ttftSec !== null && Number.isFinite(Number(c.ttftSec)) && Number(c.ttftSec) >= 0)
        ? Number(c.ttftSec)
        : null;
      const streamingVal = (c.streamingSec !== undefined && c.streamingSec !== null && Number.isFinite(Number(c.streamingSec)) && Number(c.streamingSec) >= 0)
        ? Number(c.streamingSec)
        : null;
      const inVal = (c.inputTokens != null || c.cacheReadTokens != null || c.cacheTokens != null)
        ? (Number(c.inputTokens) || 0) + (Number(c.cacheReadTokens ?? c.cacheTokens) || 0)
        : null;

      if (!groups.has(exactId)) {
        groups.set(exactId, {
          modelExactId: exactId,
          modelLabel: rawLabel,
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          effort: c.effort || prod.effort || null,
          records: []
        });
      }
      const g = groups.get(exactId);
      g.records.push({
        callId: c.callId || null,
        ts,
        tps: tpsVal,
        ttftSec: ttftVal,
        streamingSec: streamingVal,
        durationSec,
        outputTokens,
        inputTokens: inVal,
        origin: c.origin === 'speed-test' ? 'speed-test' : 'chat'
      });
    }

    const result = [];
    for (const g of groups.values()) {
      // 按时间降序截断保留最近 200 条
      g.records.sort((a, b) => b.ts - a.ts);
      const recent = g.records.slice(0, MAX_SPEED_SAMPLES_PER_MODEL);
      if (!recent.length) continue;

      const medTps = computeMedian(recent.map(r => r.tps));
      const ttftList = recent.map(r => r.ttftSec).filter(v => v !== null);
      const medTtft = ttftList.length ? computeMedian(ttftList) : null;
      const medDur = computeMedian(recent.map(r => r.durationSec));
      const medOut = computeMedian(recent.map(r => r.outputTokens));
      const inList = recent.map(r => r.inputTokens).filter(v => v !== null && v > 0);
      const medIn = inList.length ? computeMedian(inList) : null;

      const tsList = recent.map(r => r.ts).filter(t => t > 0);
      const minTs = tsList.length ? Math.min(...tsList) : null;
      const maxTs = tsList.length ? Math.max(...tsList) : null;

      // 折线图使用时间升序排列
      const samples = recent.slice().sort((a, b) => a.ts - b.ts);

      result.push({
        modelExactId: g.modelExactId,
        modelLabel: g.modelLabel,
        productKey: g.productKey,
        productLabel: g.productLabel,
        vendor: g.vendor,
        effort: g.effort,
        count: recent.length,
        lowSample: recent.length < 3,
        medianTps: medTps !== null ? Number(medTps.toFixed(1)) : null,
        medianTtft: medTtft !== null ? Number(medTtft.toFixed(2)) : null,
        medianDuration: medDur !== null ? Number(medDur.toFixed(2)) : null,
        medianOutputTokens: medOut !== null ? Math.round(medOut) : null,
        medianInputTokens: medIn !== null ? Math.round(medIn) : null,
        minTs,
        maxTs,
        samples
      });
    }

    result.sort((a, b) => {
      if (metric === 'ttft') {
        if (a.medianTtft == null && b.medianTtft == null) return 0;
        if (a.medianTtft == null) return 1;
        if (b.medianTtft == null) return -1;
        return a.medianTtft - b.medianTtft;
      }
      if (metric === 'duration') {
        if (a.medianDuration == null && b.medianDuration == null) return 0;
        if (a.medianDuration == null) return 1;
        if (b.medianDuration == null) return -1;
        return a.medianDuration - b.medianDuration;
      }
      if (a.medianTps == null && b.medianTps == null) return 0;
      if (a.medianTps == null) return 1;
      if (b.medianTps == null) return -1;
      return b.medianTps - a.medianTps;
    });

    return result;
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

    const reqDate = (() => {
      let d = '2026-11-08';
      const hasExplicitDate = req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date));
      const isProv = req.dateIsProvisional === true || req.dateSource === 'provisional';
      if (!isProv && req.created_at && (!hasExplicitDate || !req.dateSource || req.dateSource === 'created_at')) {
        const dt = new Date(req.created_at);
        if (!Number.isNaN(dt.getTime())) {
          d = formatLocalDateStr(dt);
        } else if (hasExplicitDate) {
          d = String(req.date).slice(0, 10);
        }
      } else if (hasExplicitDate) {
        d = String(req.date).slice(0, 10);
      } else if (req.created_at) {
        const dt = new Date(req.created_at);
        d = !Number.isNaN(dt.getTime()) ? formatLocalDateStr(dt) : String(req.created_at).slice(0, 10);
      }
      return d;
    })();
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
    const totalTok = pricedTokens + unpricedTokens;
    let coveragePercent = null;
    let tokenCoveragePercent = null;
    let requestCoveragePercent = null;
    let isPartialCoverage = false;

    if (totalRequests > 0 || unpricedTokens > 0) {
      if (totalRequests > 0) {
        requestCoveragePercent = Number(((pricedRequestsCount / totalRequests) * 100).toFixed(1));
      }
      if (totalTok > 0) {
        tokenCoveragePercent = Number(((pricedTokens / totalTok) * 100).toFixed(1));
      }
      if (pricedRequestsCount === 0) {
        coveragePercent = 0;
      } else if (unpricedRequestsCount > 0 || unpricedTokens > 0) {
        isPartialCoverage = true;
        // 当存在未计价历史记录或未知 token 未计时，不能虚假呈现 100% 覆盖
        if (unpricedTokens === 0) {
          coveragePercent = requestCoveragePercent;
        } else {
          const baseReqCov = requestCoveragePercent ?? 100;
          coveragePercent = Math.min(tokenCoveragePercent ?? baseReqCov, baseReqCov);
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

  function extractCallId(row, cascadeId = null, fallbackStepIndex = null) {
    if (!row || typeof row !== 'object') return '';
    const u = row.chatModel?.usage || row.usage || {};
    const explicit =
      u.responseId ||
      u.response_id ||
      row.response_id ||
      row.responseId ||
      u.messageId ||
      u.message_id ||
      row.message_id ||
      row.messageId ||
      row.callId ||
      row.call_id ||
      '';
    if (explicit) return String(explicit);
    const stepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index ?? fallbackStepIndex;
    if (cascadeId && stepIdx !== null && stepIdx !== undefined) {
      return `${cascadeId}#${stepIdx}`;
    }
    return '';
  }

  function parseGeneratorCall(row, cascadeId = null, source = 'desktop', options = {}) {
    if (!row || typeof row !== 'object') return null;
    const cm = row.chatModel || {};
    const u = cm.usage || {};
    const hasExplicitInput = u.inputTokens !== undefined || row.inputTokens !== undefined || row.input_tokens !== undefined;
    const hasExplicitCache = u.cacheReadTokens !== undefined || row.cacheTokens !== undefined || row.cacheReadTokens !== undefined || row.cache_read_tokens !== undefined;
    const hasExplicitOutput = u.outputTokens !== undefined || row.outputTokens !== undefined || row.output_tokens !== undefined;
    const hasInputCacheFields = Boolean(hasExplicitInput || hasExplicitCache);
    const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';
    const modelKey = normalizeModelId(model);
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
    const modelExactId = resolveStableModelId(row, cascadeConfigs) || resolveStableModelId(model, cascadeConfigs) || null;
    const modelLabelRaw = String(cm.modelDisplayName || row.modelLabel || model || modelExactId || '').trim();
    const productMeta = groupModelProduct({
      modelId: modelExactId || cm.modelId || cm.model || row.modelId,
      label: modelLabelRaw,
      effort: cm.effort || row.effort
    });

    const input = hasExplicitInput ? (Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens) || 0) : 0;
    const cached = hasExplicitCache ? (Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens) || 0) : 0;
    const output = hasExplicitOutput ? (Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens) || 0) : 0;
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? (output - thinking > 0 ? output - thinking : output));
    const totalTokens = input + cached + output;

    const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length ? cm.retryInfos[cm.retryInfos.length - 1] : null;
    const rawError = String(lastRetry?.error || cm.error || row.error || '').trim();
    const errorClassification = rawError
      ? classifyRequestError(rawError, {
        currentModel: modelLabelRaw || model,
        cascadeModelConfigs: cascadeConfigs,
        userStatus: options.userStatus || null
      })
      : null;

    const rawStepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index;
    const parsedStepIdx = rawStepIdx !== undefined && rawStepIdx !== null && rawStepIdx !== '' ? Number(rawStepIdx) : NaN;
    const stepIndex = Number.isInteger(parsedStepIdx) && parsedStepIdx >= 0 ? parsedStepIdx : null;

    const callId = extractCallId(row, cascadeId, stepIndex ?? 0);
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
    const hasUsage = totalTokens > 0;
    const status = hasExplicitFinish || (hasUsage && !row.isStreaming && row.status !== 'streaming') ? 'final' : 'streaming';
    const isEstimated = !hasUsage || output === 0;

    // 日期与时间戳：优先按真实创建时间转为本地日历日；RPC 缺失时间时显式标记 provisional 以便后续被权威时间校准覆盖
    let callDate = null;
    let callTimestamp = null;
    let dateSource = null;
    let dateIsProvisional = false;
    const rawCreatedAt = row.created_at || row.createdAt || row.timestamp;
    if (rawCreatedAt) {
      const dt = new Date(rawCreatedAt);
      if (!Number.isNaN(dt.getTime())) {
        callDate = formatLocalDateStr(dt);
        callTimestamp = dt.getTime();
        dateSource = 'created_at';
      }
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      callDate = String(row.date).slice(0, 10);
      callTimestamp = new Date(callDate).getTime();
      dateIsProvisional = Boolean(row.dateIsProvisional || row.dateSource === 'provisional');
      dateSource = dateIsProvisional ? 'provisional' : (row.dateSource || 'explicit_date');
    } else if (source === 'desktop' && typeof window !== 'undefined') {
      callTimestamp = Date.now();
      callDate = formatLocalDateStr(new Date(callTimestamp));
      dateSource = 'provisional';
      dateIsProvisional = true;
    } else {
      dateIsProvisional = true;
    }

    let sourceRevision = null;
    const rawRev = row.sourceRevision ?? row.revision ?? row.metadataRevision;
    if (rawRev !== undefined && rawRev !== null && rawRev !== '') {
      const revNum = Number(rawRev);
      if (Number.isFinite(revNum)) sourceRevision = revNum;
    } else {
      const rawUpdated = row.updated_at ?? row.sourceUpdatedAt;
      if (rawUpdated !== undefined && rawUpdated !== null && rawUpdated !== '') {
        const updTs = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
        if (Number.isFinite(updTs)) sourceRevision = updTs;
      }
    }

    const reqObj = {
      model,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      date: callDate,
      ...(dateSource ? { dateSource } : {}),
      dateIsProvisional
    };
    const costCalc = calculateRequestApiCost(reqObj);

    // 解析实测速度字段（绝不补零或估算缺失速度）
    const ttftSecRaw = parseDurationSec(cm.timeToFirstToken) ?? (row.ttftSec !== undefined && row.ttftSec !== null && Number.isFinite(Number(row.ttftSec)) && Number(row.ttftSec) >= 0 ? Number(row.ttftSec) : null);
    const streamingSecRaw = parseDurationSec(cm.streamingDuration) ?? (row.streamingSec !== undefined && row.streamingSec !== null && Number.isFinite(Number(row.streamingSec)) && Number(row.streamingSec) >= 0 ? Number(row.streamingSec) : null);
    let durationSecRaw = null;
    if (ttftSecRaw !== null && streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw + streamingSecRaw;
    } else if (ttftSecRaw !== null || streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw ?? streamingSecRaw;
    } else if (row.durationSec !== undefined && row.durationSec !== null && Number.isFinite(Number(row.durationSec)) && Number(row.durationSec) > 0) {
      durationSecRaw = Number(row.durationSec);
    }

    const speedFields = {};
    if (status === 'final' && !isEstimated && output > 0 && durationSecRaw !== null && durationSecRaw > 0) {
      if (ttftSecRaw !== null) speedFields.ttftSec = Number(ttftSecRaw.toFixed(2));
      if (streamingSecRaw !== null) speedFields.streamingSec = Number(streamingSecRaw.toFixed(2));
      speedFields.durationSec = Number(durationSecRaw.toFixed(2));
      speedFields.tps = (row.tps !== undefined && row.tps !== null && Number.isFinite(Number(row.tps)) && Number(row.tps) > 0)
        ? Number(Number(row.tps).toFixed(1))
        : Number((output / durationSecRaw).toFixed(1));
      if (streamingSecRaw !== null && streamingSecRaw > 0.05) {
        speedFields.streamingTps = Number((output / streamingSecRaw).toFixed(1));
      }
      speedFields.origin = row.origin === 'speed-test' ? 'speed-test' : 'chat';
    } else {
      if (ttftSecRaw !== null && ttftSecRaw >= 0) speedFields.ttftSec = Number(ttftSecRaw.toFixed(2));
      if (streamingSecRaw !== null && streamingSecRaw >= 0) speedFields.streamingSec = Number(streamingSecRaw.toFixed(2));
      if (durationSecRaw !== null && durationSecRaw > 0) speedFields.durationSec = Number(durationSecRaw.toFixed(2));
    }

    let outcomeStatus = status === 'streaming' ? 'streaming' : 'success';
    if (rawError) {
      outcomeStatus = (errorClassification && errorClassification.kind && errorClassification.kind !== 'none')
        ? errorClassification.kind
        : 'failed';
      if (outcomeStatus === 'context_overflow') outcomeStatus = 'exceeded';
      else if (outcomeStatus === 'network_error') outcomeStatus = 'network';
      else if (outcomeStatus === 'unknown') outcomeStatus = 'failed';
    }

    const callRecord = {
      callId,
      source,
      cascadeId,
      stepIndex,
      model,
      modelKey,
      modelExactId: modelExactId || undefined,
      modelLabel: (modelLabelRaw && modelLabelRaw !== model) ? modelLabelRaw : undefined,
      effort: productMeta.effort || undefined,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      totalTokens,
      hasInputCacheFields,
      status,
      outcomeStatus,
      ...(rawError ? { error: rawError, errorClassification } : {}),
      isEstimated,
      isPriced: costCalc.isPriced,
      costUSD: costCalc.costUSD ?? 0,
      date: callDate,
      ...(dateSource ? { dateSource } : {}),
      dateIsProvisional,
      created_at: rawCreatedAt ? String(rawCreatedAt) : null,
      timestamp: callTimestamp,
      ...(sourceRevision !== null ? { sourceRevision } : {}),
      ...speedFields
    };
    return callRecord;
  }

  function parseUserPlanStatus(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        teamsTier: null,
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

    // 只有具备明确权益证据时才识别套餐，避免空对象或缺省状态被当成 Free
    const hasTierEvidence = Boolean(
      rawTierName ||
      userTier.id ||
      planInfo.teamsTier ||
      planStatus.availablePromptCredits !== undefined ||
      planInfo.monthlyPromptCredits !== undefined
    );

    if (!hasTierEvidence) {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        teamsTier: null,
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
        pricingTableVerifiedDate: '2026-11-08',
        updatedAt: null
      };
    }

    let tierKey = 'unknown';
    let tierDisplayName = '未知';
    let officialPrice = null;
    let priceRange = null;
    const rawTeamsTier = typeof planInfo.teamsTier === 'string' ? planInfo.teamsTier.trim() : '';

    let multiplier = null;
    if (Number.isFinite(Number(userTier.multiplier)) && Number(userTier.multiplier) > 0) {
      multiplier = Number(userTier.multiplier);
    } else if (Number.isFinite(Number(planInfo.multiplier)) && Number(planInfo.multiplier) > 0) {
      multiplier = Number(planInfo.multiplier);
    } else if (Number.isFinite(Number(planStatus.quotaMultiplier)) && Number(planStatus.quotaMultiplier) > 0) {
      multiplier = Number(planStatus.quotaMultiplier);
    } else if (Number.isFinite(Number(userTier.tierMultiplier)) && Number(userTier.tierMultiplier) > 0) {
      multiplier = Number(userTier.tierMultiplier);
    }

    if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '') || /pro_ultimate|teams_tier_ultra/i.test(rawTeamsTier)) {
      tierKey = 'ultra';
      // 检查明确的倍率子档，如 5x / 20x / 5X / 20X
      let detectedMultiplierStr = null;
      const combinedMeta = `${rawTierName} ${userTier.id || ''} ${rawTeamsTier}`;
      const multStrMatch = combinedMeta.match(/(?:ultra)?[_\-\s]*(\d+x)\b/i);
      if (multStrMatch) {
        detectedMultiplierStr = multStrMatch[1].toLowerCase();
        if (!multiplier) multiplier = parseInt(detectedMultiplierStr, 10);
      } else if (multiplier) {
        detectedMultiplierStr = `${multiplier}x`;
      }

      const subTierMatch = rawTierName.match(/ultra\s*([0-9a-zA-Z\-_]+)/i);
      if (detectedMultiplierStr) {
        tierDisplayName = `Google AI Ultra (${detectedMultiplierStr})`;
        officialPrice = null;
        priceRange = `Google AI Ultra (${detectedMultiplierStr}) 子档`;
      } else if (subTierMatch && !['plan', 'tier'].includes(subTierMatch[1].toLowerCase())) {
        tierDisplayName = `Google AI Ultra (${subTierMatch[1]})`;
        officialPrice = null;
        priceRange = '子档定制费率未知';
      } else {
        tierDisplayName = 'Google AI Ultra（子档未知）';
        officialPrice = null;
        priceRange = '参考区间 $99.99 ~ $249.99/月（子档未知）';
      }
    } else if (/pro/i.test(rawTierName) || /pro/i.test(userTier.id || '') || /^teams_tier_pro$/i.test(rawTeamsTier)) {
      tierKey = 'pro';
      tierDisplayName = 'Google AI Pro';
      officialPrice = 19.99;
      priceRange = '$19.99/月（公开参考）';
    } else if (/plus/i.test(rawTierName) || /plus/i.test(userTier.id || '') || /^teams_tier_plus$/i.test(rawTeamsTier)) {
      tierKey = 'plus';
      tierDisplayName = 'Google AI Plus';
      officialPrice = 4.99;
      priceRange = '$4.99/月（公开参考）';
    } else if (/free/i.test(rawTierName) || /free/i.test(userTier.id || '') || /^teams_tier_free$/i.test(rawTeamsTier)) {
      tierKey = 'free';
      tierDisplayName = 'Free';
      officialPrice = 0;
      priceRange = '$0/月（公开参考）';
    } else {
      tierKey = 'custom';
      tierDisplayName = rawTierName || rawTeamsTier || '未知套餐';
      officialPrice = null;
      priceRange = '费率未知';
    }

    return {
      status: 'identified',
      tierKey,
      tierName: tierDisplayName,
      multiplier,
      tierId: userTier.id || null,
      teamsTier: planInfo.teamsTier || null,
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
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
      'gemini-4-carbon': 'Gemini 4 Carbon',
      'gemini-4-argon': 'Gemini 4 Argon',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5'
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
    { id: 'TW', name: '中国台湾', nameTw: '中國台灣', nameEn: 'Taiwan', flag: '🇹🇼', currency: 'TWD', symbol: 'NT$', monthlyPrice: 650, rateToCNY: 0.21, aliases: ['tw', 'ntd', 'twd', 'taiwan', '台湾', '台灣', '中国台湾', '中國台灣', '台区', '台區'] },
    { id: 'HK', name: '中国香港', nameTw: '中國香港', nameEn: 'Hong Kong', flag: '🇭🇰', currency: 'HKD', symbol: 'HK$', monthlyPrice: 158.00, rateToCNY: 0.857, aliases: ['hk', 'hong kong', '香港', '中国香港', '中國香港', '港区', '港區'] },
    { id: 'JP', name: '日本', nameTw: '日本', nameEn: 'Japan', flag: '🇯🇵', currency: 'JPY', symbol: '¥', monthlyPrice: 2900, rateToCNY: 0.0425, aliases: ['jp', 'japan', '日本', '日区', '日區'] },
    { id: 'KR', name: '韩国', nameTw: '韓國', nameEn: 'South Korea', flag: '🇰🇷', currency: 'KRW', symbol: '₩', monthlyPrice: 29000, rateToCNY: 0.0051, aliases: ['kr', 'korea', 'south korea', '韩国', '韓國', '韩区', '韓區'] },
    { id: 'AU', name: '澳大利亚 (澳区)', nameTw: '澳洲 (澳區)', nameEn: 'Australia', flag: '🇦🇺', currency: 'AUD', symbol: 'AU$', monthlyPrice: 32.99, rateToCNY: 4.45, aliases: ['au', 'aud', 'australia', '澳大利亚', '澳洲', '澳大利亞', '澳区', '澳區'] },
    { id: 'NZ', name: '新西兰', nameTw: '紐西蘭', nameEn: 'New Zealand', flag: '🇳🇿', currency: 'NZD', symbol: 'NZ$', monthlyPrice: 34.99, rateToCNY: 4.05, aliases: ['nz', 'nzd', 'new zealand', '新西兰', '紐西蘭'] },
    { id: 'SG', name: '新加坡', nameTw: '新加坡', nameEn: 'Singapore', flag: '🇸🇬', currency: 'SGD', symbol: 'S$', monthlyPrice: 27.99, rateToCNY: 5.12, aliases: ['sg', 'singapore', '新加坡', '星洲'] },
    { id: 'MY', name: '马来西亚', nameTw: '馬來西亞', nameEn: 'Malaysia', flag: '🇲🇾', currency: 'MYR', symbol: 'RM ', monthlyPrice: 97.99, rateToCNY: 1.55, aliases: ['my', 'myr', 'malaysia', '马来西亚', '馬來西亞', '大马', '大馬'] },
    { id: 'TH', name: '泰国', nameTw: '泰國', nameEn: 'Thailand', flag: '🇹🇭', currency: 'THB', symbol: '฿', monthlyPrice: 750, rateToCNY: 0.20, aliases: ['th', 'thb', 'thailand', '泰国', '泰國'] },
    { id: 'VN', name: '越南', nameTw: '越南', nameEn: 'Vietnam', flag: '🇻🇳', currency: 'VND', symbol: '₫', monthlyPrice: 489000, rateToCNY: 0.00028, aliases: ['vn', 'vnd', 'vietnam', '越南'] },
    { id: 'ID', name: '印度尼西亚', nameTw: '印度尼西亞', nameEn: 'Indonesia', flag: '🇮🇩', currency: 'IDR', symbol: 'Rp ', monthlyPrice: 309000, rateToCNY: 0.00044, aliases: ['id', 'idr', 'indonesia', '印度尼西亚', '印度尼西亞', '印尼'] },
    { id: 'PH', name: '菲律宾', nameTw: '菲律賓', nameEn: 'Philippines', flag: '🇵🇭', currency: 'PHP', symbol: '₱', monthlyPrice: 1100, rateToCNY: 0.117, aliases: ['ph', 'php', 'philippines', '菲律宾', '菲律賓'] },
    { id: 'IN', name: '印度', nameTw: '印度', nameEn: 'India', flag: '🇮🇳', currency: 'INR', symbol: '₹', monthlyPrice: 1950, rateToCNY: 0.076, aliases: ['in', 'inr', 'india', '印度', '印区', '印區'] },
    { id: 'PK', name: '巴基斯坦', nameTw: '巴基斯坦', nameEn: 'Pakistan', flag: '🇵🇰', currency: 'PKR', symbol: '₨ ', monthlyPrice: 5600, rateToCNY: 0.024, aliases: ['pk', 'pkr', 'pakistan', '巴基斯坦'] },

    // 北美与拉美
    { id: 'US', name: '美国', nameTw: '美國', nameEn: 'United States', flag: '🇺🇸', currency: 'USD', symbol: '$', monthlyPrice: 19.99, rateToCNY: 6.72, aliases: ['us', 'usa', 'united states', '美国', '美國', '美区', '美區'] },
    { id: 'CA', name: '加拿大', nameTw: '加拿大', nameEn: 'Canada', flag: '🇨🇦', currency: 'CAD', symbol: 'CA$', monthlyPrice: 26.99, rateToCNY: 4.88, aliases: ['ca', 'cad', 'canada', '加拿大'] },
    { id: 'MX', name: '墨西哥', nameTw: '墨西哥', nameEn: 'Mexico', flag: '🇲🇽', currency: 'MXN', symbol: '$', monthlyPrice: 395, rateToCNY: 0.36, aliases: ['mx', 'mxn', 'mexico', '墨西哥'] },
    { id: 'BR', name: '巴西', nameTw: '巴西', nameEn: 'Brazil', flag: '🇧🇷', currency: 'BRL', symbol: 'R$', monthlyPrice: 96.99, rateToCNY: 1.18, aliases: ['br', 'brl', 'brazil', '巴西'] },
    { id: 'TR', name: '土耳其', nameTw: '土耳其', nameEn: 'Turkey', flag: '🇹🇷', currency: 'TRY', symbol: '₺', monthlyPrice: 869.99, rateToCNY: 0.133, aliases: ['tr', 'try', 'turkey', '土耳其', '土区', '土區'] },
    { id: 'AR', name: '阿根廷', nameTw: '阿根廷', nameEn: 'Argentina', flag: '🇦🇷', currency: 'ARS', symbol: '$', monthlyPrice: 19999, rateToCNY: 0.0065, aliases: ['ar', 'ars', 'argentina', '阿根廷'] },
    { id: 'CL', name: '智利', nameTw: '智利', nameEn: 'Chile', flag: '🇨🇱', currency: 'CLP', symbol: '$', monthlyPrice: 18990, rateToCNY: 0.0072, aliases: ['cl', 'clp', 'chile', '智利'] },
    { id: 'CO', name: '哥伦比亚', nameTw: '哥倫比亞', nameEn: 'Colombia', flag: '🇨🇴', currency: 'COP', symbol: '$', monthlyPrice: 84900, rateToCNY: 0.0016, aliases: ['co', 'cop', 'colombia', '哥伦比亚', '哥倫比亞'] },
    { id: 'PE', name: '秘鲁', nameTw: '秘魯', nameEn: 'Peru', flag: '🇵🇪', currency: 'PEN', symbol: 'S/ ', monthlyPrice: 76.90, rateToCNY: 1.82, aliases: ['pe', 'pen', 'peru', '秘鲁', '秘魯'] },

    // 欧洲与欧亚
    { id: 'GB', name: '英国', nameTw: '英國', nameEn: 'United Kingdom', flag: '🇬🇧', currency: 'GBP', symbol: '£', monthlyPrice: 18.99, rateToCNY: 8.75, aliases: ['gb', 'uk', 'gbp', 'united kingdom', '英国', '英國', '英区', '英區'] },
    { id: 'EU', name: '欧洲/欧盟 (德法意西荷等)', nameTw: '歐洲/歐盟 (德法義西荷等)', nameEn: 'Europe / EU', flag: '🇪🇺', currency: 'EUR', symbol: '€', monthlyPrice: 21.99, rateToCNY: 7.52, aliases: ['eu', 'eur', 'euro', 'europe', 'europe / eu', '欧洲', '歐洲', '欧盟', '歐盟', '德国', '德國', '法国', '法國', '意大利', '義大利', '西班牙', '荷兰', '荷蘭'] },
    { id: 'CH', name: '瑞士', nameTw: '瑞士', nameEn: 'Switzerland', flag: '🇨🇭', currency: 'CHF', symbol: 'CHF ', monthlyPrice: 17.00, rateToCNY: 7.85, aliases: ['ch', 'chf', 'switzerland', '瑞士'] },
    { id: 'UA', name: '乌克兰', nameTw: '烏克蘭', nameEn: 'Ukraine', flag: '🇺🇦', currency: 'UAH', symbol: '₴', monthlyPrice: 900, rateToCNY: 0.162, aliases: ['ua', 'uah', 'ukraine', '乌克兰', '烏克蘭'] },
    { id: 'PL', name: '波兰', nameTw: '波蘭', nameEn: 'Poland', flag: '🇵🇱', currency: 'PLN', symbol: 'zł ', monthlyPrice: 97.99, rateToCNY: 1.72, aliases: ['pl', 'pln', 'poland', '波兰', '波蘭'] },
    { id: 'SE', name: '瑞典', nameTw: '瑞典', nameEn: 'Sweden', flag: '🇸🇪', currency: 'SEK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.65, aliases: ['se', 'sek', 'sweden', '瑞典'] },
    { id: 'NO', name: '挪威', nameTw: '挪威', nameEn: 'Norway', flag: '🇳🇴', currency: 'NOK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.63, aliases: ['no', 'nok', 'norway', '挪威'] },
    { id: 'DK', name: '丹麦', nameTw: '丹麥', nameEn: 'Denmark', flag: '🇩🇰', currency: 'DKK', symbol: 'kr ', monthlyPrice: 169, rateToCNY: 1.01, aliases: ['dk', 'dkk', 'denmark', '丹麦', '丹麥'] },
    { id: 'CZ', name: '捷克', nameTw: '捷克', nameEn: 'Czechia', flag: '🇨🇿', currency: 'CZK', symbol: 'Kč ', monthlyPrice: 529, rateToCNY: 0.30, aliases: ['cz', 'czk', 'czech', 'czechia', '捷克'] },
    { id: 'HU', name: '匈牙利', nameTw: '匈牙利', nameEn: 'Hungary', flag: '🇭🇺', currency: 'HUF', symbol: 'Ft ', monthlyPrice: 8990, rateToCNY: 0.0185, aliases: ['hu', 'huf', 'hungary', '匈牙利'] },
    { id: 'RO', name: '罗马尼亚', nameTw: '羅馬尼亞', nameEn: 'Romania', flag: '🇷🇴', currency: 'RON', symbol: 'lei ', monthlyPrice: 109.99, rateToCNY: 1.51, aliases: ['ro', 'ron', 'romania', '罗马尼亚', '羅馬尼亞'] },

    // 中东与非洲
    { id: 'NG', name: '尼日利亚', nameTw: '奈及利亞', nameEn: 'Nigeria', flag: '🇳🇬', currency: 'NGN', symbol: '₦', monthlyPrice: 28500, rateToCNY: 0.0042, aliases: ['ng', 'ngn', 'nigeria', '尼日利亚', '奈及利亞', '尼区', '尼區'] },
    { id: 'ZA', name: '南非', nameTw: '南非', nameEn: 'South Africa', flag: '🇿🇦', currency: 'ZAR', symbol: 'R ', monthlyPrice: 429.99, rateToCNY: 0.38, aliases: ['za', 'zar', 'south africa', '南非'] },
    { id: 'EG', name: '埃及', nameTw: '埃及', nameEn: 'Egypt', flag: '🇪🇬', currency: 'EGP', symbol: 'E£ ', monthlyPrice: 999, rateToCNY: 0.136, aliases: ['eg', 'egp', 'egypt', '埃及'] },
    { id: 'KE', name: '肯尼亚', nameTw: '肯亞', nameEn: 'Kenya', flag: '🇰🇪', currency: 'KES', symbol: 'KSh ', monthlyPrice: 2800, rateToCNY: 0.052, aliases: ['ke', 'kes', 'kenya', '肯尼亚', '肯亞'] },
    { id: 'AE', name: '阿联酋', nameTw: '阿聯酋', nameEn: 'United Arab Emirates', flag: '🇦🇪', currency: 'AED', symbol: 'AED ', monthlyPrice: 76.99, rateToCNY: 1.83, aliases: ['ae', 'aed', 'uae', 'emirates', 'united arab emirates', '阿联酋', '阿聯酋', '迪拜', '杜拜'] },
    { id: 'SA', name: '沙特阿拉伯', nameTw: '沙烏地阿拉伯', nameEn: 'Saudi Arabia', flag: '🇸🇦', currency: 'SAR', symbol: 'SAR ', monthlyPrice: 85.99, rateToCNY: 1.79, aliases: ['sa', 'sar', 'saudi', 'saudi arabia', '沙特', '沙特阿拉伯', '沙烏地阿拉伯'] },
    { id: 'IL', name: '以色列', nameTw: '以色列', nameEn: 'Israel', flag: '🇮🇱', currency: 'ILS', symbol: '₪ ', monthlyPrice: 79.90, rateToCNY: 1.85, aliases: ['il', 'ils', 'israel', '以色列'] },

    // 大中华区/人民币与自定义
    { id: 'CN', name: '中国大陆 (CNY)', nameTw: '中國大陸 (CNY)', nameEn: 'China Mainland', flag: '🇨🇳', currency: 'CNY', symbol: '¥', monthlyPrice: 140.00, rateToCNY: 1.0, aliases: ['cn', 'cny', 'china', 'china mainland', '中国', '中國', '中国大陆', '中國大陸', '人民币', '人民幣', '国内', '國內'] }
  ];

  function findRegionPreset(regionQuery) {
    if (!regionQuery || typeof regionQuery !== 'string') return null;
    const raw = regionQuery.trim();
    if (!raw) return null;
    const q = raw.toLowerCase();
    const stripped = raw.replace(/\s*\([A-Za-z]{2,4}\)\s*$/i, '').trim().toLowerCase();
    return SUBSCRIPTION_REGIONS_PRESET.find(r =>
      r.id.toLowerCase() === q ||
      r.name.toLowerCase() === q ||
      (r.nameTw && r.nameTw.toLowerCase() === q) ||
      (r.nameEn && r.nameEn.toLowerCase() === q) ||
      (stripped && (
        r.name.toLowerCase() === stripped ||
        (r.nameTw && r.nameTw.toLowerCase() === stripped) ||
        (r.nameEn && r.nameEn.toLowerCase() === stripped)
      )) ||
      r.aliases.some(a => a.toLowerCase() === q || q.includes(a.toLowerCase()))
    ) || null;
  }

  function resolveCurrencyRateToCNY(currency, regionQuery = null) {
    let cur = String(currency || '').toUpperCase();
    if (cur === 'NTD') cur = 'TWD';
    if (cur === 'CNY') return 1.0;
    let preset = findRegionPreset(regionQuery);
    if (!preset || (cur && preset.currency !== cur)) {
      preset = SUBSCRIPTION_REGIONS_PRESET.find(r => r.currency === cur);
    }
    if (preset && preset.rateToCNY) return preset.rateToCNY;
    if (cur === 'USD') return 6.72;
    if (cur === 'HKD') return 0.857;
    if (cur === 'TWD') return 0.21;
    if (cur === 'JPY') return 0.0425;
    if (cur === 'EUR') return 7.52;
    if (cur === 'GBP') return 8.75;
    return null;
  }

  function convertToCNY(amount, currency, regionQuery = null) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
    const num = Number(amount);
    if (num === 0) return 0;
    const rate = resolveCurrencyRateToCNY(currency, regionQuery);
    if (!rate) return null;
    return Number((num * rate).toFixed(2));
  }

  /**
   * 跨币种通用换算（依托 CNY 基准静态汇率，支持 USD / HKD / TWD / CNY 及全部预设地区币种）。
   */
  function convertCurrency(amount, fromCurrency, toCurrency, regionQuery = null) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
    const num = Number(amount);
    if (num === 0) return 0;
    let from = String(fromCurrency || 'USD').trim().toUpperCase();
    let to = String(toCurrency || 'USD').trim().toUpperCase();
    if (from === 'NTD') from = 'TWD';
    if (to === 'NTD') to = 'TWD';
    if (from === to) return Number(num.toFixed(2));
    const fromRate = resolveCurrencyRateToCNY(from, regionQuery);
    const toRate = resolveCurrencyRateToCNY(to, null);
    if (!fromRate || !toRate) return null;
    return Number(((num * fromRate) / toRate).toFixed(2));
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
    let teamsTier = null;
    let planName = '未知';
    let tierSource = 'unknown';
    let multiplier = rawLive?.multiplier || cachedLive?.multiplier || null;

    const rawTierOverride = effectiveCustom?.planTierOverride || effectiveCustom?.tierOverride || effectiveCustom?.planTier || null;
    const normTierOverride = (typeof rawTierOverride === 'string' && rawTierOverride.trim() && rawTierOverride.trim().toLowerCase() !== 'auto')
      ? rawTierOverride.trim()
      : null;

    if (normTierOverride) {
      status = (rawLive && rawLive.status === 'identified') ? 'identified' : 'custom';
      tierSource = 'custom';
      tierId = rawLive?.tierId || cachedLive?.tierId || null;
      teamsTier = rawLive?.teamsTier || cachedLive?.teamsTier || null;
      const lowerOverride = normTierOverride.toLowerCase();

      if (lowerOverride === 'free' || lowerOverride === 'teams_tier_free') {
        tierKey = 'free';
        tierName = 'Free';
        planName = 'Free';
        multiplier = null;
      } else if (lowerOverride === 'pro' || lowerOverride === 'teams_tier_pro') {
        tierKey = 'pro';
        tierName = 'Google AI Pro';
        planName = 'Google AI Pro';
        multiplier = null;
      } else if (lowerOverride === 'plus' || lowerOverride === 'teams_tier_plus') {
        tierKey = 'plus';
        tierName = 'Google AI Plus';
        planName = 'Google AI Plus';
        multiplier = null;
      } else if (lowerOverride === 'ultra_5x' || lowerOverride === 'ultra 5x' || lowerOverride === 'ultra-5x' || lowerOverride === '5x') {
        tierKey = 'ultra';
        tierName = 'Google AI Ultra (5x)';
        planName = 'Google AI Ultra (5x)';
        multiplier = 5;
      } else if (lowerOverride === 'ultra_20x' || lowerOverride === 'ultra 20x' || lowerOverride === 'ultra-20x' || lowerOverride === '20x') {
        tierKey = 'ultra';
        tierName = 'Google AI Ultra (20x)';
        planName = 'Google AI Ultra (20x)';
        multiplier = 20;
      } else if (lowerOverride === 'ultra' || lowerOverride === 'google ai ultra') {
        tierKey = 'ultra';
        tierName = 'Google AI Ultra';
        planName = 'Google AI Ultra';
        multiplier = null;
      } else {
        const multMatch = normTierOverride.match(/(\d+x)/i);
        if (/ultra/i.test(normTierOverride)) {
          tierKey = 'ultra';
          if (multMatch) {
            multiplier = parseInt(multMatch[1], 10);
            tierName = `Google AI Ultra (${multMatch[1].toLowerCase()})`;
          } else {
            tierName = normTierOverride;
          }
        } else {
          tierKey = 'custom';
          tierName = normTierOverride;
        }
        planName = tierName;
      }
    } else if (rawLive && rawLive.status === 'identified' && rawLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = rawLive.tierKey;
      tierName = rawLive.tierName;
      tierId = rawLive.tierId;
      teamsTier = rawLive.teamsTier || null;
      planName = rawLive.planName || rawLive.tierName;
      tierSource = 'live';
      multiplier = rawLive.multiplier || multiplier;
    } else if (effectiveCustom && effectiveCustom.tierName) {
      status = 'custom';
      tierKey = effectiveCustom.tierKey || 'custom';
      tierName = effectiveCustom.tierName;
      tierId = effectiveCustom.tierId || rawLive?.tierId || cachedLive?.tierId || null;
      teamsTier = effectiveCustom.teamsTier || rawLive?.teamsTier || cachedLive?.teamsTier || null;
      planName = effectiveCustom.tierName;
      tierSource = 'custom';
    } else if (cachedLive && cachedLive.status === 'identified' && cachedLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = cachedLive.tierKey;
      tierName = cachedLive.tierName;
      tierId = cachedLive.tierId;
      teamsTier = cachedLive.teamsTier || null;
      planName = cachedLive.planName || cachedLive.tierName;
      tierSource = 'cached_live';
      multiplier = cachedLive.multiplier || multiplier;
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
      // priceMode === 'preset' (跟随订阅国家参考价：仅 Pro 等单一公开标准价套餐套用地区参考表，Ultra 等不适用 Pro $19.99 参考价)
      priceMode = 'preset';
      const isUltraTier = tierKey === 'ultra';
      if (matchedRegionPreset && !isUltraTier) {
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
        isPriceEstimated = false;
        priceSource = 'unknown';
        billingCycle = isUltraTier ? (effectiveCustom?.billingCycle || '月付') : '未知';
        priceRangeNote = isUltraTier
          ? `${acquisitionSourceName} · Google AI Ultra 待设置实付月费`
          : `${acquisitionSourceName} · 待设置订阅国家与价格`;
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
    const actualPricePaidUSD = actualPricePaid !== null ? convertCurrency(actualPricePaid, currency, 'USD', rateRegion) : null;
    const cnyFormatted = actualPricePaidCNY !== null ? (currency === 'CNY' ? ('¥' + actualPricePaidCNY) : ('折合 ≈ ¥' + actualPricePaidCNY.toFixed(1) + ' CNY')) : null;

    if (actualPricePaidCNY !== null && actualPricePaid > 0 && currency !== 'CNY') {
      priceRangeNote += ' (' + cnyFormatted + ')';
    }

    return {
      status,
      tierKey,
      tierName,
      tierId,
      teamsTier,
      planName,
      planTierOverride: normTierOverride || 'auto',
      multiplier: multiplier || null,
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
      actualPricePaidUSD,
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
      hasCustomSettings: Boolean(effectiveCustom && (normTierOverride || effectiveCustom.country || effectiveCustom.region || effectiveCustom.subscriptionRegion || effectiveCustom.currency || effectiveCustom.actualPricePaid !== undefined || effectiveCustom.customNote || effectiveCustom.acquisitionSource)),
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
    const isScopedAccountView = Boolean(options.scopedAccountView || payload.scopedAccountView);
    if (source === 'all' && !isScopedAccountView) {
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
    if (refMonth && !isScopedAccountView) {
      if (refMonth.inputTokens && !currentMonthInput) currentMonthInput = Number(refMonth.inputTokens);
      if (refMonth.cacheTokens && !currentMonthCache) currentMonthCache = Number(refMonth.cacheTokens);
      if (refMonth.outputTokens && !currentMonthOutput) currentMonthOutput = Number(refMonth.outputTokens);
      if (refMonth.totalTokens && !monthTokens) monthTokens = Number(refMonth.totalTokens);
      else if (!monthTokens && (currentMonthInput || currentMonthOutput || currentMonthCache)) {
        monthTokens = currentMonthInput + currentMonthOutput + currentMonthCache;
      }
    }
    if (refAll && !isScopedAccountView) {
      if (refAll.inputTokens && !totalInputTokens) totalInputTokens = Number(refAll.inputTokens);
      if (refAll.cacheTokens && !totalCacheTokens) totalCacheTokens = Number(refAll.cacheTokens);
      if (refAll.outputTokens && !totalOutputTokens) totalOutputTokens = Number(refAll.outputTokens);
      if (refAll.totalTokens && !grandTotalTokens) grandTotalTokens = Number(refAll.totalTokens);
      else if (!grandTotalTokens && (totalInputTokens || totalOutputTokens || totalCacheTokens)) {
        grandTotalTokens = totalInputTokens + totalOutputTokens + totalCacheTokens;
      }
    }

    const allCacheStats = summarizeDailyMapCacheStats(normalizedMap);
    const monthCacheStats = summarizeDailyMapCacheStats(normalizedMap, currentMonthPrefix);
    const cacheReadStatsBySource = (payload.cacheReadStatsBySource && typeof payload.cacheReadStatsBySource === 'object')
      ? payload.cacheReadStatsBySource
      : {
          all: summarizeDailyMapCacheStats(dailyMapBySource.all || normalizedMap),
          desktop: summarizeDailyMapCacheStats(dailyMapBySource.desktop || {}),
          cli: summarizeDailyMapCacheStats(dailyMapBySource.cli || {})
        };

    const rawConvs = Object.prototype.hasOwnProperty.call(rawSum, 'totalConversations')
      ? Number(rawSum.totalConversations)
      : null;
    const activeKeysSorted = Object.keys(normalizedMap)
      .filter(k => normalizedMap[k] && normalizedMap[k].total > 0)
      .sort();
    const computedFirstUseDate = activeKeysSorted.length > 0 ? activeKeysSorted[0] : null;
    const declaredFirstUseDate = Object.prototype.hasOwnProperty.call(payload, 'firstUseDate')
      ? (payload.firstUseDate || null)
      : (rawSum.firstUseDate || null);
    // 切换账号或切换数据来源时，首次记录日期必须严格收敛到当前筛选范围的真实有效日期
    const effectiveFirstUseDate = (isScopedAccountView || source !== 'all')
      ? computedFirstUseDate
      : (declaredFirstUseDate && computedFirstUseDate
        ? (computedFirstUseDate < declaredFirstUseDate ? computedFirstUseDate : declaredFirstUseDate)
        : (declaredFirstUseDate || computedFirstUseDate || null));
    const effectiveConversations = (source !== 'all' && grandTotalTokens === 0 && activeDaysCount === 0)
      ? 0
      : ((rawConvs !== null && Number.isFinite(rawConvs)) ? rawConvs : activeDaysCount);
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
      totalConversations: effectiveConversations,
      firstUseDate: effectiveFirstUseDate,
      cacheReadStats: allCacheStats,
      currentMonthCacheReadStats: monthCacheStats
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

    const dailyModelMapBySource = payload.dailyModelMapBySource && typeof payload.dailyModelMapBySource === 'object'
      ? payload.dailyModelMapBySource
      : null;
    const dailyModelMap = dailyModelMapBySource
      ? (dailyModelMapBySource[source] || dailyModelMapBySource.all || {})
      : (payload.dailyModelMap || {});

    return {
      schemaVersion: payload.schemaVersion || '0.8.8',
      version: payload.version || '0.8.8',
      updatedAt: payload.updatedAt || '',
      firstUseDate: summary.firstUseDate,
      currentPeriod: payload.currentPeriod || {
        key: currentMonthPrefix,
        periodType: 'calendar_month',
        label: currentMonthPrefix,
        isCurrentMonth: true
      },
      planStatus: payload.planStatus || null,
      rawPlanStatus: payload.rawPlanStatus || payload.planStatus || null,
      customPlanSettings: payload.customPlanSettings || null,
      costEstimate: payload.costEstimate || null,
      costEstimateCurrentMonth: payload.costEstimateCurrentMonth || null,
      costEstimateBySource: payload.costEstimateBySource || null,
      referenceCost,
      summary,
      cacheReadStatsBySource,
      dailyMap: normalizedMap,
      dailyMapBySource,
      dailyModelMap,
      dailyModelMapBySource,
      modelMetaByKey: payload.modelMetaByKey || null
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

  /**
   * 计算 PDF v0.8.8 最终推荐的混合非线性响应 f(V, V_anchor) ∈ [0, 1]
   * 公式: f(V) = 0.35 * ((log10(max(c, 10)) - 1) / (log10(Va) - 1)) + 0.65 * (c / Va)^0.42
   * 其中 c = min(V, Va)
   */
  function computeMixedScaleResponse(value, anchor = 100e6) {
    const v = Number(value);
    const va = Number(anchor);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(va) || va <= 10) return 0;
    const c = Math.min(v, va);
    const denom = Math.log10(va) - 1;
    if (denom <= 0) return 0;
    const logTerm = Math.max(0, (Math.log10(Math.max(c, 10)) - 1) / denom);
    const powTerm = Math.pow(c / va, 0.42);
    const f = 0.35 * logTerm + 0.65 * powTerm;
    if (!Number.isFinite(f)) return 0;
    return Math.max(0, Math.min(1, f));
  }

  const YEARLY_BUBBLE_ANCHORS = [
    { anchor: 100e3, sizePx: 24 },
    { anchor: 1e6, sizePx: 32 },
    { anchor: 10e6, sizePx: 40 },
    { anchor: 100e6, sizePx: 49 },
    { anchor: 1e9, sizePx: 58 }
  ];

  const DAILY_BAR_ANCHORS = [
    { anchor: 100e3, ratio: 0.38 },
    { anchor: 1e6, ratio: 0.52 },
    { anchor: 10e6, ratio: 0.68 },
    { anchor: 100e6, ratio: 0.84 },
    { anchor: 500e6, ratio: 1.0 }
  ];

  const WEEKLY_BAR_ANCHORS = [
    { anchor: 400e3, ratio: 0.38 },
    { anchor: 4e6, ratio: 0.52 },
    { anchor: 40e6, ratio: 0.68 },
    { anchor: 400e6, ratio: 0.84 },
    { anchor: 2e9, ratio: 1.0 }
  ];

  /**
   * 跨档单调分锚点连续插值核心：
   * 保留 35% 对数 + 65% 幂律 (0.42 指数) 混合形态；每段均从上一个锚点尺寸平滑接起，
   * 不因窗口跨入更高包络而缩小自身或其它同值数据点，达到物理上限后封顶并标记 overflow。
   */
  function computePiecewiseAnchorScale(value, anchors, minPx, zeroPx = 0) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      return { size: zeroPx, response: 0, overflow: false };
    }
    const list = Array.isArray(anchors) && anchors.length ? anchors : [{ anchor: 1e9, size: 58 }];
    const topItem = list[list.length - 1];
    const topAnchor = topItem.anchor;
    const topSize = topItem.size;
    const overflow = v > topAnchor;
    const clamped = Math.min(v, topAnchor);

    let outSize = topSize;
    for (let i = 0; i < list.length; i++) {
      const curr = list[i];
      if (clamped <= curr.anchor) {
        const prevA = i === 0 ? 0 : list[i - 1].anchor;
        const prevY = i === 0 ? minPx : list[i - 1].size;
        let t = 0;
        if (i === 0) {
          const denom = Math.log10(curr.anchor) - 1;
          const lt = (clamped <= 10 || denom <= 0)
            ? 0
            : Math.max(0, (Math.log10(clamped) - 1) / denom);
          const pt = Math.pow(clamped / curr.anchor, 0.42);
          t = 0.35 * lt + 0.65 * pt;
        } else {
          const lt = (Math.log10(clamped) - Math.log10(prevA)) / (Math.log10(curr.anchor) - Math.log10(prevA));
          const pPrev = Math.pow(prevA, 0.42);
          const pCurr = Math.pow(curr.anchor, 0.42);
          const pt = (Math.pow(clamped, 0.42) - pPrev) / (pCurr - pPrev);
          t = 0.35 * lt + 0.65 * pt;
        }
        t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
        outSize = prevY + (curr.size - prevY) * t;
        break;
      }
    }
    const span = Math.max(1e-6, topSize - minPx);
    return {
      size: outSize,
      response: Math.max(0, Math.min(1, (outSize - minPx) / span)),
      overflow
    };
  }

  /**
   * 固定色彩插值响应 f ∈ [0, 1]（不随当前窗口最大包络变化而褪色或降档）
   */
  function computeColorScaleResponse(value, mode = 'heat') {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    if (mode === 'yearly') {
      const anchors = YEARLY_BUBBLE_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.sizePx }));
      return computePiecewiseAnchorScale(v, anchors, 8.0, 5.0).response;
    }
    if (mode === 'weekly') {
      const anchors = WEEKLY_BAR_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.ratio * 96 }));
      return computePiecewiseAnchorScale(v, anchors, 3.0, 0).response;
    }
    return computeMixedScaleResponse(v, 100e6);
  }

  /**
   * 按当前窗口最大值返回量级包络参数：
   * 包络决定参考圆、右侧刻度线与超量标识；图形尺寸与刻度线坐标均调用同一套连续分锚点映射。
   * mode: 'yearly' | 'dailyBar' | 'weekly' | 'heat'
   */
  function resolveScaleEnvelope(windowMax, mode = 'yearly') {
    const maxVal = Math.max(0, Number(windowMax) || 0);
    if (mode === 'heat') {
      return {
        mode: 'heat',
        tier: 'heat-100M',
        label: '100M',
        anchor: 100e6,
        dCap: 58,
        hCap: 1.0,
        overflow: maxVal > 100e6,
        overflowThreshold: 100e6,
        refTicks: [100e3, 1e6, 10e6, 100e6]
      };
    }

    if (mode === 'weekly') {
      if (maxVal <= 400e3) {
        return { mode: 'weekly', tier: '400K', label: '400K', anchor: 400e3, hCap: 0.38, overflow: false, overflowThreshold: 2e9, refTicks: [40e3, 400e3] };
      }
      if (maxVal <= 4e6) {
        return { mode: 'weekly', tier: '4M', label: '4M', anchor: 4e6, hCap: 0.52, overflow: false, overflowThreshold: 2e9, refTicks: [400e3, 4e6] };
      }
      if (maxVal <= 40e6) {
        return { mode: 'weekly', tier: '40M', label: '40M', anchor: 40e6, hCap: 0.68, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6] };
      }
      if (maxVal <= 400e6) {
        return { mode: 'weekly', tier: '400M', label: '400M', anchor: 400e6, hCap: 0.84, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6] };
      }
      if (maxVal <= 2e9) {
        return { mode: 'weekly', tier: '2B', label: '2B', anchor: 2e9, hCap: 1.0, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6, 2e9] };
      }
      return { mode: 'weekly', tier: '2B+', label: '2B+', anchor: 2e9, hCap: 1.0, overflow: true, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6, 2e9] };
    }

    if (mode === 'dailyBar') {
      if (maxVal <= 100e3) {
        return { mode: 'dailyBar', tier: '100K', label: '100K', anchor: 100e3, hCap: 0.38, overflow: false, overflowThreshold: 500e6, refTicks: [10e3, 100e3] };
      }
      if (maxVal <= 1e6) {
        return { mode: 'dailyBar', tier: '1M', label: '1M', anchor: 1e6, hCap: 0.52, overflow: false, overflowThreshold: 500e6, refTicks: [10e3, 100e3, 1e6] };
      }
      if (maxVal <= 10e6) {
        return { mode: 'dailyBar', tier: '10M', label: '10M', anchor: 10e6, hCap: 0.68, overflow: false, overflowThreshold: 500e6, refTicks: [100e3, 1e6, 10e6] };
      }
      if (maxVal <= 100e6) {
        return { mode: 'dailyBar', tier: '100M', label: '100M', anchor: 100e6, hCap: 0.84, overflow: false, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6] };
      }
      if (maxVal <= 500e6) {
        return { mode: 'dailyBar', tier: '500M', label: '500M', anchor: 500e6, hCap: 1.0, overflow: false, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6, 500e6] };
      }
      return { mode: 'dailyBar', tier: '500M+', label: '500M+', anchor: 500e6, hCap: 1.0, overflow: true, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6, 500e6] };
    }

    // 默认 'yearly'
    if (maxVal <= 100e3) {
      return { mode: 'yearly', tier: '100K', label: '100K', anchor: 100e3, dCap: 24, hCap: 0.38, overflow: false, overflowThreshold: 1e9, refRings: [100e3] };
    }
    if (maxVal <= 1e6) {
      return { mode: 'yearly', tier: '1M', label: '1M', anchor: 1e6, dCap: 32, hCap: 0.52, overflow: false, overflowThreshold: 1e9, refRings: [100e3, 1e6] };
    }
    if (maxVal <= 10e6) {
      return { mode: 'yearly', tier: '10M', label: '10M', anchor: 10e6, dCap: 40, hCap: 0.68, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6] };
    }
    if (maxVal <= 100e6) {
      return { mode: 'yearly', tier: '100M', label: '100M', anchor: 100e6, dCap: 49, hCap: 0.84, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6] };
    }
    if (maxVal <= 1e9) {
      return { mode: 'yearly', tier: '1B', label: '1B', anchor: 1e9, dCap: 58, hCap: 1.0, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6, 1e9] };
    }
    return { mode: 'yearly', tier: '1B+', label: '1B+', anchor: 1e9, dCap: 58, hCap: 1.0, overflow: true, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6, 1e9] };
  }

  /**
   * 映射今年月度气泡直径 (保留浮点精度，共用连续分锚点映射，跨包络不缩小)
   * V <= 0 返回 D = 5.0px (R = 2.5px)；V > 1B 封顶 D = 58.0px 并标记 overflow
   */
  function mapBubbleDiameter(value, _envelope) {
    const v = Number(value) || 0;
    if (v <= 0) {
      return { diameter: 5.0, radius: 2.5, response: 0, overflow: false };
    }
    const anchors = YEARLY_BUBBLE_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.sizePx }));
    const res = computePiecewiseAnchorScale(v, anchors, 8.0, 5.0);
    return {
      diameter: res.size,
      radius: res.size / 2,
      response: res.response,
      overflow: res.overflow
    };
  }

  /**
   * 映射每日/每周柱状图总像素高度 (保留浮点精度，共用连续分锚点映射，跨包络不缩小)
   * linear 模式: V > 0 -> minPx + (chartHeightPx - minPx) * clamp(V / linearMax, 0, 1)
   */
  function mapBarHeightPx(value, envelope, chartHeightPx = 140, options = {}) {
    const v = Number(value) || 0;
    const heightPx = Math.max(1, Number(chartHeightPx) || 140);
    const minPx = Number.isFinite(Number(options.minPx)) ? Number(options.minPx) : 4.0;
    const mode = options.mode === 'linear' ? 'linear' : 'mixed';
    if (v <= 0) {
      return { height: 0, response: 0, overflow: false };
    }
    if (mode === 'linear') {
      const linearMax = Math.max(1, Number(options.linearMax) || (envelope && envelope.anchor) || v);
      const response = Math.max(0, Math.min(1, v / linearMax));
      return {
        height: minPx + (heightPx - minPx) * response,
        response,
        overflow: false
      };
    }
    const isWeekly = options.scaleKind === 'weekly'
      || (envelope && envelope.mode === 'weekly')
      || (envelope && /^(400K|4M|40M|400M|2B\+?)$/.test(String(envelope.tier || '')));
    const rawAnchors = isWeekly ? WEEKLY_BAR_ANCHORS : DAILY_BAR_ANCHORS;
    const anchors = rawAnchors.map((x) => ({
      anchor: x.anchor,
      size: Math.max(minPx, x.ratio * heightPx)
    }));
    const res = computePiecewiseAnchorScale(v, anchors, minPx, 0);
    return {
      height: res.size,
      response: res.response,
      overflow: res.overflow
    };
  }

  /**
   * 计算堆叠柱内部各非零分段高度：
   * 非零最小保底 minSegPx (默认 1.5px)，且严格保证 sum(heightPx) === totalHeightPx，
   * 原始占比 rawRatio 始终按真实数值 value / sum 计算。
   */
  function allocateStackedSegmentHeights(segments, totalHeightPx, minSegPx = 1.5) {
    const list = Array.isArray(segments) ? segments : [];
    const targetH = Math.max(0, Number(totalHeightPx) || 0);
    const rawSum = list.reduce((acc, item) => acc + Math.max(0, Number(item && item.value) || 0), 0);
    if (rawSum <= 0 || targetH <= 0) {
      return list.map((item) => ({ ...item, heightPx: 0, rawRatio: 0, floored: false }));
    }

    const activeIdx = [];
    for (let i = 0; i < list.length; i++) {
      if ((Number(list[i] && list[i].value) || 0) > 0) activeIdx.push(i);
    }
    const n = activeIdx.length;
    const heights = new Array(list.length).fill(0);
    const flooredFlags = new Array(list.length).fill(false);

    if (n === 1) {
      heights[activeIdx[0]] = targetH;
    } else if (n > 1) {
      const effFloor = Math.min(Math.max(0, Number(minSegPx) || 0), targetH / n);
      const locked = new Set();
      let remPx = targetH;
      let remValSum = rawSum;
      let changed = true;

      while (changed) {
        changed = false;
        if (remValSum <= 0) break;
        for (const idx of activeIdx) {
          if (locked.has(idx)) continue;
          const v = Math.max(0, Number(list[idx].value) || 0);
          const est = (v / remValSum) * remPx;
          if (est < effFloor) {
            locked.add(idx);
            heights[idx] = effFloor;
            flooredFlags[idx] = true;
            remPx -= effFloor;
            remValSum -= v;
            changed = true;
          }
        }
      }

      if (remValSum > 0 && remPx > 0) {
        for (const idx of activeIdx) {
          if (locked.has(idx)) continue;
          const v = Math.max(0, Number(list[idx].value) || 0);
          heights[idx] = (v / remValSum) * remPx;
        }
      } else {
        const unlocked = activeIdx.filter((idx) => !locked.has(idx));
        if (unlocked.length > 0) {
          const share = Math.max(0, remPx) / unlocked.length;
          for (const idx of unlocked) heights[idx] = share;
        }
      }

      // 将浮点舍入误差微调回最高柱段，确保 sum === targetH
      const sumH = heights.reduce((a, b) => a + b, 0);
      const diff = targetH - sumH;
      if (Math.abs(diff) > 1e-12) {
        let maxIdx = activeIdx[0];
        for (const idx of activeIdx) {
          if (heights[idx] > heights[maxIdx]) maxIdx = idx;
        }
        heights[maxIdx] = Math.max(0, heights[maxIdx] + diff);
      }
    }

    return list.map((item, idx) => {
      const v = Math.max(0, Number(item && item.value) || 0);
      return {
        ...item,
        heightPx: heights[idx],
        rawRatio: v > 0 ? v / rawSum : 0,
        floored: flooredFlags[idx]
      };
    });
  }

  function _hexToRgbNorm(hex) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    let full = clean;
    if (clean.length === 3) {
      full = clean.split('').map((c) => c + c).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const n = parseInt(full, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  function _rgbNormToHsl({ r, g, b }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function _hslToHex({ h, s, l }) {
    const hh = (((Number(h) || 0) % 360) + 360) % 360;
    const ss = Math.max(0, Math.min(1, Number(s) || 0));
    const ll = Math.max(0, Math.min(1, Number(l) || 0));
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hh < 60) { r1 = c; g1 = x; }
    else if (hh < 120) { r1 = x; g1 = c; }
    else if (hh < 180) { g1 = c; b1 = x; }
    else if (hh < 240) { g1 = x; b1 = c; }
    else if (hh < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    const toByte = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, '0');
    return `#${toByte(r1)}${toByte(g1)}${toByte(b1)}`;
  }

  /**
   * HSL 色彩空间两点短弧插值
   */
  function interpolateHslHex(hexA, hexB, t) {
    const rgbA = _hexToRgbNorm(hexA);
    const rgbB = _hexToRgbNorm(hexB);
    if (!rgbA) return String(hexB || '#9333ea');
    if (!rgbB) return String(hexA || '#2e1a47');
    const ratio = Math.max(0, Math.min(1, Number(t) || 0));
    const hslA = _rgbNormToHsl(rgbA);
    const hslB = _rgbNormToHsl(rgbB);
    let hA = hslA.h;
    let hB = hslB.h;
    if (hslA.s < 0.01) hA = hB;
    else if (hslB.s < 0.01) hB = hA;
    let dh = hB - hA;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    return _hslToHex({
      h: hA + dh * ratio,
      s: hslA.s + (hslB.s - hslA.s) * ratio,
      l: hslA.l + (hslB.l - hslA.l) * ratio
    });
  }

  /**
   * 依据归一化响应 f ∈ [0, 1] 与连续色停靠点列表做连续 HSL 颜色映射
   */
  function interpolateScaleColorHsl(response, nonZeroStops) {
    const stops = Array.isArray(nonZeroStops) ? nonZeroStops.filter(Boolean) : [];
    if (stops.length === 0) return '#9333ea';
    if (stops.length === 1) return stops[0];
    const r = Math.max(0, Math.min(1, Number(response) || 0));
    const maxIdx = stops.length - 1;
    const pos = r * maxIdx;
    const idx = Math.min(maxIdx - 1, Math.floor(pos));
    const localT = pos - idx;
    return interpolateHslHex(stops[idx], stops[idx + 1], localT);
  }

  /**
   * 年图「峰值」高亮圈双门槛判定 (PDF 第 14、29 页):
   * 仅当当年至少有 2 个非零非未来月份，且最大非未来月用量 >= 10M 时才显示 Peak 圈
   */
  function shouldShowYearlyPeakBadge(nonFutureMonthTokens) {
    const arr = Array.isArray(nonFutureMonthTokens) ? nonFutureMonthTokens : [];
    let nonZeroCount = 0;
    let maxVal = 0;
    for (const raw of arr) {
      const v = Number(raw) || 0;
      if (v > 0) {
        nonZeroCount += 1;
        if (v > maxVal) maxVal = v;
      }
    }
    return nonZeroCount >= 2 && maxVal >= 10e6;
  }

  /**
   * 跨账号对数量级尺位置计算 ([10M, 100B])
   * status: 'zero' | 'below_min' | 'in_range' | 'above_max'
   */
  function computeLogRulerPosition(totalTokens) {
    const v = Math.max(0, Number(totalTokens) || 0);
    const ticks = [
      { value: 10e6, label: '10M', pct: 0 },
      { value: 100e6, label: '100M', pct: 25 },
      { value: 1e9, label: '1B', pct: 50 },
      { value: 10e9, label: '10B', pct: 75 },
      { value: 100e9, label: '100B', pct: 100 }
    ];
    if (v <= 0) {
      return { status: 'zero', pct: 0, value: 0, ticks };
    }
    if (v < 10e6) {
      return { status: 'below_min', pct: 0, value: v, ticks };
    }
    if (v > 100e9) {
      return { status: 'above_max', pct: 100, value: v, ticks };
    }
    const pct = Math.max(0, Math.min(100, ((Math.log10(v) - 7) / 4) * 100));
    return { status: 'in_range', pct, value: v, ticks };
  }

  function _parseYmdUtcMs(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function _formatUtcMsYmd(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * 计算「累计总量」A+C 视图完整汇总：
   * - 精确区间天数、活跃天数、0 用量天数、每日占比与截止累计
   * - 超过 90 天按起点每 7 天分周组，详情含展开的日列表
   * - 前 3 名峰值与相邻高峰合并
   * - 至少 50% 用量的最短连续日期区间（并列取最早，不足 7 天或总量为 0 省略）
   */
  function computeCumulativeStripSummary(dailyMap, startYmd, endYmd) {
    const map = dailyMap || {};
    const startMs = _parseYmdUtcMs(startYmd);
    const endMs = _parseYmdUtcMs(endYmd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return {
        startDate: startYmd || '',
        endDate: endYmd || '',
        totalDays: 0,
        activeDays: 0,
        zeroDays: 0,
        intervalTotal: 0,
        grouping: 'daily',
        dailyEntries: [],
        segments: [],
        topPeaks: [],
        mergedPeakSpans: [],
        peakDay: null,
        peakWeek: null,
        concentration: null,
        concentrationOmittedReason: 'empty',
        ruler: computeLogRulerPosition(0)
      };
    }

    const totalDays = Math.floor((endMs - startMs) / 86400000) + 1;
    const dailyEntries = [];
    let intervalTotal = 0;
    let activeDays = 0;

    for (let i = 0; i < totalDays; i++) {
      const dateStr = _formatUtcMsYmd(startMs + i * 86400000);
      const rec = map[dateStr];
      const tokens = Math.max(0, Number(rec && rec.total) || 0);
      const input = Math.max(0, Number(rec && rec.input) || 0);
      const cache = Math.max(0, Number(rec && rec.cache) || 0);
      const output = Math.max(0, Number(rec && rec.output) || 0);
      intervalTotal += tokens;
      if (tokens > 0) activeDays += 1;
      dailyEntries.push({
        idx: i,
        key: dateStr,
        date: dateStr,
        dayNumber: i + 1,
        tokens,
        input,
        cache,
        output,
        isZero: tokens === 0,
        cumulativeTokens: intervalTotal,
        sharePct: 0
      });
    }

    let peakDay = null;
    dailyEntries.forEach((d) => {
      d.sharePct = intervalTotal > 0 ? (d.tokens / intervalTotal) * 100 : 0;
      if (d.tokens > 0 && (!peakDay || d.tokens > peakDay.tokens)) {
        peakDay = { date: d.date, tokens: d.tokens, sharePct: d.sharePct, dayNumber: d.dayNumber };
      }
    });

    const zeroDays = totalDays - activeDays;
    const grouping = totalDays > 90 ? 'weekly' : 'daily';

    const rawItems = [];
    if (grouping === 'daily') {
      dailyEntries.forEach((d, idx) => {
        rawItems.push({
          idx,
          key: d.date,
          startDate: d.date,
          endDate: d.date,
          daysCount: 1,
          dayNumber: d.dayNumber,
          tokens: d.tokens,
          cumulativeTokens: d.cumulativeTokens,
          sharePct: d.sharePct,
          isZero: d.isZero,
          weekIdx: Math.floor(idx / 7),
          days: [d]
        });
      });
    } else {
      const weekCount = Math.ceil(totalDays / 7);
      for (let w = 0; w < weekCount; w++) {
        const slice = dailyEntries.slice(w * 7, Math.min((w + 1) * 7, totalDays));
        const weekTokens = slice.reduce((sum, x) => sum + x.tokens, 0);
        const lastDay = slice[slice.length - 1];
        const sharePct = intervalTotal > 0 ? (weekTokens / intervalTotal) * 100 : 0;
        rawItems.push({
          idx: w,
          key: slice[0].date,
          startDate: slice[0].date,
          endDate: lastDay.date,
          daysCount: slice.length,
          dayNumber: w + 1,
          tokens: weekTokens,
          cumulativeTokens: lastDay.cumulativeTokens,
          sharePct,
          isZero: weekTokens === 0,
          weekIdx: w,
          days: slice
        });
      }
    }

    let peakWeek = null;
    if (grouping === 'weekly') {
      rawItems.forEach((wItem) => {
        if (wItem.tokens > 0 && (!peakWeek || wItem.tokens > peakWeek.tokens)) {
          peakWeek = {
            startDate: wItem.startDate,
            endDate: wItem.endDate,
            tokens: wItem.tokens,
            sharePct: wItem.sharePct
          };
        }
      });
    }

    // 分配比例横带起止百分比 & 等距轴位置百分比
    const itemCount = rawItems.length;
    let accPct = 0;
    const segments = rawItems.map((item, idx) => {
      const equidistantPct = itemCount <= 1 ? 50 : ((idx + 0.5) / itemCount) * 100;
      const widthPct = intervalTotal > 0 && item.tokens > 0 ? (item.tokens / intervalTotal) * 100 : 0;
      const startPct = accPct;
      accPct += widthPct;
      const endPct = accPct;
      const centerPct = widthPct > 0 ? startPct + widthPct / 2 : equidistantPct;
      return {
        ...item,
        equidistantPct,
        stripWidthPct: widthPct,
        stripStartPct: startPct,
        stripEndPct: endPct,
        stripCenterPct: centerPct,
        isPeak: false,
        peakRank: 0
      };
    });

    // 选出前 3 名峰值并标记，按时间序合并相邻高峰
    const activeSorted = segments
      .filter((s) => s.tokens > 0)
      .slice()
      .sort((a, b) => (b.tokens - a.tokens) || (a.idx - b.idx));
    const topPeaks = activeSorted.slice(0, 3);
    topPeaks.forEach((p, rankIdx) => {
      segments[p.idx].isPeak = true;
      segments[p.idx].peakRank = rankIdx + 1;
    });

    const topChronological = topPeaks.slice().sort((a, b) => a.idx - b.idx);
    const mergedPeakSpans = [];
    for (const seg of topChronological) {
      const last = mergedPeakSpans[mergedPeakSpans.length - 1];
      if (last && seg.idx === last._lastIdx + 1) {
        last.endDate = seg.endDate;
        last.tokens += seg.tokens;
        last.sharePct = intervalTotal > 0 ? (last.tokens / intervalTotal) * 100 : 0;
        last.count += 1;
        last.isMerged = true;
        last.itemKeys.push(seg.key);
        last._lastIdx = seg.idx;
      } else {
        mergedPeakSpans.push({
          startDate: seg.startDate,
          endDate: seg.endDate,
          tokens: seg.tokens,
          sharePct: seg.sharePct,
          count: 1,
          isMerged: false,
          itemKeys: [seg.key],
          _lastIdx: seg.idx
        });
      }
    }
    mergedPeakSpans.forEach((sp) => delete sp._lastIdx);

    // 计算达到 >= 50% 区间总量的最短连续日期区间（并列取最早，不足 7 天省略）
    let concentration = null;
    let concentrationOmittedReason = null;
    if (intervalTotal <= 0) {
      concentrationOmittedReason = 'empty';
    } else if (totalDays < 7) {
      concentrationOmittedReason = 'insufficient_days';
    } else {
      const target = intervalTotal * 0.5;
      const eps = Math.max(1e-6, intervalTotal * 1e-12);
      let bestL = -1;
      let bestR = -1;
      let bestLen = Infinity;
      let bestSum = 0;
      let left = 0;
      let curSum = 0;

      for (let right = 0; right < dailyEntries.length; right++) {
        curSum += dailyEntries[right].tokens;
        while (left <= right && curSum + eps >= target) {
          const len = right - left + 1;
          if (len < bestLen) {
            bestLen = len;
            bestL = left;
            bestR = right;
            bestSum = curSum;
          }
          if (curSum - dailyEntries[left].tokens + eps >= target) {
            curSum -= dailyEntries[left].tokens;
            left += 1;
          } else {
            break;
          }
        }
      }

      if (bestL >= 0) {
        concentration = {
          startDate: dailyEntries[bestL].date,
          endDate: dailyEntries[bestR].date,
          daysCount: bestLen,
          tokens: bestSum,
          sharePct: (bestSum / intervalTotal) * 100
        };
      }
    }

    return {
      startDate: _formatUtcMsYmd(startMs),
      endDate: _formatUtcMsYmd(endMs),
      totalDays,
      activeDays,
      zeroDays,
      intervalTotal,
      grouping,
      dailyEntries,
      segments,
      topPeaks: topPeaks.map((p) => ({
        key: p.key,
        startDate: p.startDate,
        endDate: p.endDate,
        tokens: p.tokens,
        sharePct: p.sharePct,
        rank: p.peakRank
      })),
      mergedPeakSpans,
      peakDay,
      peakWeek,
      concentration,
      concentrationOmittedReason,
      ruler: computeLogRulerPosition(intervalTotal)
    };
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
   * 解析严格 v0.x.x(-prerelease) 格式的语义化版本
   * 防御性要求：只接受 ^v?0\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$，任何 v2.x 或其他前缀均返回 null
   */
  function parseSemver(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const m = tag.trim().match(/^v?0\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
    if (!m) return null;
    const parsed = { major: 0, minor: parseInt(m[1], 10), patch: parseInt(m[2], 10) };
    if (m[3]) parsed.prerelease = m[3];
    return parsed;
  }

  /**
   * 对比 SemVer 预发布标识符序列
   */
  function comparePrereleaseIdentifiers(preA, preB) {
    if (!preA && !preB) return 0;
    if (!preA && preB) return 1;
    if (preA && !preB) return -1;
    const partsA = String(preA).split('.');
    const partsB = String(preB).split('.');
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i += 1) {
      if (i >= partsA.length) return -1;
      if (i >= partsB.length) return 1;
      const a = partsA[i];
      const b = partsB[i];
      if (a === b) continue;
      const aNum = /^\d+$/.test(a);
      const bNum = /^\d+$/.test(b);
      if (aNum && bNum) {
        const diff = parseInt(a, 10) - parseInt(b, 10);
        if (diff !== 0) return diff > 0 ? 1 : -1;
      } else if (aNum !== bNum) {
        return aNum ? -1 : 1;
      } else {
        return a > b ? 1 : -1;
      }
    }
    return 0;
  }

  /**
   * 语义化版本对比（支持预发布后缀：0.8.8 < 0.8.9-beta.1 < 0.8.9-beta.2 < 0.8.9）
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
    return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
  }

  /**
   * 过滤并筛选可用更新 Release
   * - 正式版用户默认（allowBetaUpdates !== true）不推送预发布版本
   * - 预发布用户（如 0.8.9-beta.1）可识别并升级到后续 beta 或正式版（如 0.8.9）
   */
  function filterReleases(releasesList, currentVersion = '0.8.8', options = {}) {
    if (!Array.isArray(releasesList)) return [];
    const allowBetaUpdates = options?.allowBetaUpdates === true;
    const currentParsed = parseSemver(currentVersion);
    const isCurrentBeta = Boolean(currentParsed && currentParsed.prerelease);
    const acceptPrerelease = allowBetaUpdates || isCurrentBeta;
    const valid = [];
    for (const rel of releasesList) {
      if (!rel || rel.draft) continue;
      const parsed = parseSemver(rel.tag_name);
      if (!parsed) continue; // 忽略非 v0.x 编号
      const isRelPrerelease = Boolean(rel.prerelease || parsed.prerelease);
      if (isRelPrerelease && !acceptPrerelease) continue;
      const verStr = parsed.prerelease
        ? `0.${parsed.minor}.${parsed.patch}-${parsed.prerelease}`
        : `0.${parsed.minor}.${parsed.patch}`;
      if (compareVersions(verStr, currentVersion) > 0) {
        valid.push({
          tagName: rel.tag_name,
          version: verStr,
          prerelease: isRelPrerelease,
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

  function normalizeModelLookupName(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(low|medium|high|xhigh|extra\s*high)\b/gi, ' ')
      .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractModelsFromGroupDescription(desc) {
    if (!desc || typeof desc !== 'string') return [];
    const m = desc.match(/models\s+within\s+this\s+group\s*:\s*([^\n\r]+)/i);
    if (!m) return [];
    return m[1]
      .split(/[,，、;；]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function inferGroupBucketLabel(windowStr, bucketId = '') {
    const w = String(windowStr || bucketId || '').toLowerCase();
    if (w.includes('5h') || w.includes('hour')) return { key: '5h', short: '5h', label: '5小时限额' };
    if (w.includes('weekly') || w.includes('7d') || w.includes('week')) return { key: 'weekly', short: '7d', label: '每周限额' };
    if (w.includes('daily') || w.includes('24h') || w.includes('day')) return { key: 'daily', short: '24h', label: '每日限额' };
    return { key: w || 'quota', short: '', label: '周期限额' };
  }

  const QUOTA_WINDOW_TIE_ORDER = {
    '5h': 0,
    '24h': 1,
    daily: 1,
    '7d': 2,
    weekly: 2
  };

  function resolveQuotaBucketWindowRank(bucket) {
    if (!bucket || typeof bucket !== 'object') return 99;
    const short = String(bucket.windowShort || '').trim().toLowerCase();
    const key = String(bucket.windowKey || '').trim().toLowerCase();
    const id = String(bucket.bucketId || '').trim().toLowerCase();
    for (const candidate of [short, key]) {
      if (candidate in QUOTA_WINDOW_TIE_ORDER) return QUOTA_WINDOW_TIE_ORDER[candidate];
    }
    if (id.includes('5h') || id.includes('5_hour')) return 0;
    if (id.includes('24h') || id.includes('day') || id.includes('daily')) return 1;
    if (id.includes('7d') || id.includes('week') || id.includes('weekly')) return 2;
    return 10;
  }

  function resolveQuotaWindowBucketPair(buckets = []) {
    const list = Array.isArray(buckets) ? buckets.filter(Boolean) : [];
    const findWindow = (targetKey, targetShort) => {
      const candidates = list.filter(b => {
        const wk = String(b.windowKey || '').trim().toLowerCase();
        const ws = String(b.windowShort || '').trim().toLowerCase();
        return wk === targetKey || ws === targetShort;
      });
      if (!candidates.length) return null;
      const priced = candidates.filter(b => b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction)));
      if (priced.length) {
        return priced.slice().sort((a, b) => Number(a.remainingFraction) - Number(b.remainingFraction))[0];
      }
      return candidates[0];
    };
    return {
      bucket5h: findWindow('5h', '5h'),
      bucket7d: findWindow('weekly', '7d')
    };
  }

  /**
   * 统一选择主限额窗口（被 buildModelQuotaSnapshot 与顶栏徽章渲染共用）：
   * 1) 支持 preferredMode: 'auto' (最紧缩优先) | '5h' | 'weekly' | 'both'；
   * 2) 相同剩余量按 5h -> 24h/daily -> 7d/weekly -> 其他 确定性排序；
   * 3) 返回 { primaryBucket, selectionReason } 供悬浮详情解释选择依据。
   */
  function selectPrimaryQuotaBucket(buckets = [], preferredMode = 'auto') {
    const list = Array.isArray(buckets) ? buckets.filter(Boolean) : [];
    if (!list.length) return { primaryBucket: null, selectionReason: 'none' };
    const mode = String(preferredMode || 'auto').trim().toLowerCase();
    if (mode === '5h' || mode === 'weekly') {
      const pair = resolveQuotaWindowBucketPair(list);
      const picked = mode === '5h' ? pair.bucket5h : pair.bucket7d;
      if (picked && picked.remainingFraction !== null && picked.remainingFraction !== undefined && Number.isFinite(Number(picked.remainingFraction))) {
        return {
          primaryBucket: picked,
          selectionReason: list.length === 1 ? 'single_window' : (mode === '5h' ? 'user_5h' : 'user_weekly')
        };
      }
    }
    const priced = list.filter(b => b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction)));
    if (!priced.length) {
      return { primaryBucket: list[0], selectionReason: list.length === 1 ? 'single_window' : 'unpriced_fallback' };
    }
    const sorted = priced.slice().sort((a, b) => {
      const diff = Number(a.remainingFraction) - Number(b.remainingFraction);
      if (Math.abs(diff) > 1e-6) return diff;
      const rankDiff = resolveQuotaBucketWindowRank(a) - resolveQuotaBucketWindowRank(b);
      if (rankDiff !== 0) return rankDiff;
      return String(a.bucketId || '').localeCompare(String(b.bucketId || ''));
    });
    const best = sorted[0];
    if (priced.length === 1) return { primaryBucket: best, selectionReason: 'single_window' };
    const second = sorted[1];
    const isTie = Math.abs(Number(best.remainingFraction) - Number(second.remainingFraction)) <= 1e-6;
    return {
      primaryBucket: best,
      selectionReason: isTie ? 'tie_window' : 'tighter_window'
    };
  }

  /**
   * 聚合账号下各共享额度池、产品档位与当前会话模型额度状态（纯函数）
   * 严格区分：available / low / exhausted / no_permission / stale / error / unknown
   * 绝不把网络错误判为耗尽，绝不把 Notice 标记判为权限不足，绝不伪造重置倒计时或强行推算剩余 Token。
   */
  function buildModelQuotaSnapshot(input = {}) {
    const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
    const userStatusRoot = input.userStatusRes?.userStatus || input.userStatusRes || null;
    const rawConfigs = (Array.isArray(input.cascadeModelConfigs) && input.cascadeModelConfigs.length > 0)
      ? input.cascadeModelConfigs
      : (Array.isArray(userStatusRoot?.cascadeModelConfigData?.clientModelConfigs)
        ? userStatusRoot.cascadeModelConfigData.clientModelConfigs
        : []);
    const planStatus = input.planStatus || (userStatusRoot ? parseUserPlanStatus(input.userStatusRes) : null);

    const quotaSummaryRoot = input.quotaSummaryRes?.response || input.quotaSummaryRes || null;
    const rawGroups = Array.isArray(quotaSummaryRoot?.groups) ? quotaSummaryRoot.groups : [];

    const fetchMeta = input.fetchMeta && typeof input.fetchMeta === 'object' ? input.fetchMeta : {};
    const fetchedAtMs = Number.isFinite(Number(fetchMeta.fetchedAtMs)) ? Number(fetchMeta.fetchedAtMs) : null;
    const nextRefreshAtMs = Number.isFinite(Number(fetchMeta.nextRefreshAtMs)) ? Number(fetchMeta.nextRefreshAtMs) : null;
    const staleThresholdMs = Number.isFinite(Number(fetchMeta.staleThresholdMs)) ? Number(fetchMeta.staleThresholdMs) : 180000;
    const lastError = fetchMeta.error ? String(fetchMeta.error) : null;
    const errorKind = fetchMeta.errorKind || (lastError ? 'network' : null);

    // 1. 解析 RetrieveUserQuotaSummary 中的权威共享池组
    const parsedGroups = rawGroups.map((g, idx) => {
      const desc = typeof g.description === 'string' ? g.description.trim() : '';
      const explicitModelNames = Array.isArray(g.modelIds) && g.modelIds.length
        ? g.modelIds.map(String)
        : extractModelsFromGroupDescription(desc);
      const bucketList = Array.isArray(g.buckets) ? g.buckets : [];
      const buckets = bucketList.map((b, bIdx) => {
        const parsedFrac = parseQuotaFraction(b, { unavailable: Boolean(b && b.disabled), schemaKind: 'quota_summary_bucket' });
        const resetMeta = formatQuotaResetMeta(b.resetTime || b.reset_time || null, nowMs);
        const wMeta = inferGroupBucketLabel(b.window || '', b.bucketId || b.id || `bucket-${bIdx}`);
        return {
          bucketId: b.bucketId || b.id || `bucket-${bIdx}`,
          windowKey: wMeta.key,
          windowShort: wMeta.short,
          windowLabel: wMeta.label,
          remainingFraction: parsedFrac.fraction,
          percentText: formatQuotaPercentText(parsedFrac.fraction),
          isExhausted: parsedFrac.isExhausted,
          fractionSource: parsedFrac.source,
          hasResetTime: resetMeta.hasResetTime,
          resetTimeIso: resetMeta.resetTimeIso,
          resetAtMs: resetMeta.resetAtMs,
          resetTimeText: resetMeta.resetTimeText,
          countdownText: resetMeta.countdownText,
          isResetPassed: resetMeta.isResetPassed
        };
      });

      const title = String(g.displayName || g.name || g.groupId || `配额组 ${idx + 1}`).trim();
      let sharedKey = null;
      const joinedHints = [g.groupId, title, desc, ...explicitModelNames].filter(Boolean).join(' ').toLowerCase();
      if (joinedHints.includes('3p') || joinedHints.includes('claude') || joinedHints.includes('gpt-oss')) {
        sharedKey = 'shared_3p_pool';
      } else if (joinedHints.includes('hydrogen') || joinedHints.includes('neon') || joinedHints.includes('flash')) {
        sharedKey = 'shared_gemini_main';
      } else if (joinedHints.includes('argon')) {
        sharedKey = 'shared_gemini_argon';
      } else if (joinedHints.includes('carbon')) {
        sharedKey = 'shared_gemini_carbon';
      } else {
        sharedKey = `group_${g.groupId || normalizeModelLookupName(title) || idx}`;
      }

      return {
        groupId: g.groupId || `group-${idx}`,
        sharedKey,
        title,
        description: desc,
        explicitModelNames,
        normalizedExplicitNames: explicitModelNames.map(normalizeModelLookupName).filter(Boolean),
        buckets
      };
    });

    // 2. 将 clientModelConfigs 按产品折叠多挡位（如 Low/Medium/High/XHigh）
    const productMap = new Map();
    const fallbackGroupNames = {
      shared_gemini_main: 'Gemini 4 Hydrogen / Gemini 3.8 Flash',
      shared_3p_pool: 'Claude Opus/Sonnet 5.5 / GPT-OSS 120B (第三方共享池)',
      shared_gemini_argon: 'Gemini 4 Argon / Orchestrator',
      shared_gemini_carbon: 'Gemini 4 Carbon'
    };
    const CORE_SHARED_POOLS = new Set(Object.keys(fallbackGroupNames));

    for (const cfg of rawConfigs) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.isHistorical === true) continue;
      if (cfg.isInternal === true) continue;
      const rawMId = String(cfg.modelId || cfg.model || '').trim().toLowerCase();
      const rawMAlias = String(cfg.modelOrAlias?.model || '').trim().toLowerCase();
      if ((rawMId.startsWith('chat_') && /^chat_\d+$/.test(rawMId)) || (rawMAlias.startsWith('chat_') && /^chat_\d+$/.test(rawMAlias))) continue;
      if (rawMId.startsWith('tab_') || rawMAlias.startsWith('tab_')) continue;
      const gInfo = groupModelProduct(cfg);
      const avail = classifyModelQuotaAvailability(cfg, planStatus);
      const qi = cfg.quotaInfo || {};
      const parsedFrac = parseQuotaFraction(qi, { unavailable: avail.noPermission, schemaKind: 'codeium_quota_info' });
      const resetMeta = formatQuotaResetMeta(qi.resetTime || null, nowMs);
      const poolKey = getModelPoolKey(cfg);
      const defaultSharedKey = getSharedQuotaGroupKey(cfg);

      // 查找匹配的 quotaSummary group
      const cfgNorm = normalizeModelLookupName(gInfo.productLabel || cfg.label || cfg.modelId);
      const matchedSummaryGroup = parsedGroups.find(pg => {
        if (pg.normalizedExplicitNames.some(en => en && (cfgNorm === en || cfgNorm.includes(en) || en.includes(cfgNorm)))) {
          return true;
        }
        return pg.sharedKey === defaultSharedKey;
      }) || null;

      const resolvedSharedKey = matchedSummaryGroup ? matchedSummaryGroup.sharedKey : defaultSharedKey;
      if (!CORE_SHARED_POOLS.has(resolvedSharedKey)) continue;

      const pKey = `${resolvedSharedKey}::${gInfo.productKey}`;

      let prod = productMap.get(pKey);
      if (!prod) {
        prod = {
          productKey: gInfo.productKey,
          productLabel: gInfo.productLabel,
          vendor: gInfo.vendor,
          poolKey,
          sharedGroupKey: resolvedSharedKey,
          efforts: [],
          modelIds: [],
          aliases: [],
          rawConfigs: [],
          remainingFraction: null,
          isExhausted: false,
          noPermission: false,
          unavailabilityReason: null,
          noticeTitle: null,
          noticeText: null,
          hasResetTime: false,
          resetTimeIso: null,
          resetAtMs: null,
          resetTimeText: null,
          countdownText: null,
          isResetPassed: false
        };
        productMap.set(pKey, prod);
      }

      if (gInfo.effort && !prod.efforts.includes(gInfo.effort)) prod.efforts.push(gInfo.effort);
      const mId = String(cfg.modelId || cfg.model || '').trim();
      const aliasId = String(cfg.modelOrAlias?.model || '').trim();
      if (mId && !prod.modelIds.includes(mId)) prod.modelIds.push(mId);
      if (aliasId && !prod.aliases.includes(aliasId)) prod.aliases.push(aliasId);
      prod.rawConfigs.push(cfg);

      // 产品级权限状态：如果任意非推荐挡位没权限且全组都无可用挡位才算无权限；若新增可用挡位则解锁
      if (!avail.noPermission) {
        prod._hasAvailableMember = true;
      } else if (!prod.unavailabilityReason && avail.reason) {
        prod.unavailabilityReason = avail.reason;
      }
      if (avail.noticeText && !prod.noticeText) {
        prod.noticeTitle = avail.noticeTitle;
        prod.noticeText = avail.noticeText;
      }

      // 合并 config.quotaInfo
      if (parsedFrac.hasValue) {
        if (prod.remainingFraction === null || parsedFrac.fraction < prod.remainingFraction) {
          prod.remainingFraction = parsedFrac.fraction;
          prod.isExhausted = parsedFrac.isExhausted;
        }
      }
      if (resetMeta.hasResetTime) {
        if (!prod.hasResetTime || (prod.resetAtMs !== null && resetMeta.resetAtMs !== null && resetMeta.resetAtMs < prod.resetAtMs)) {
          prod.hasResetTime = true;
          prod.resetTimeIso = resetMeta.resetTimeIso;
          prod.resetAtMs = resetMeta.resetAtMs;
          prod.resetTimeText = resetMeta.resetTimeText;
          prod.countdownText = resetMeta.countdownText;
          prod.isResetPassed = resetMeta.isResetPassed;
        }
      }
    }

    for (const prod of productMap.values()) {
      prod.noPermission = !prod._hasAvailableMember;
      delete prod._hasAvailableMember;
      if (prod.noPermission) {
        // 无权限模型不将其缺失的 quota 标为耗尽
        prod.remainingFraction = null;
        prod.isExhausted = false;
      }
      prod.percentText = prod.noPermission ? '无权限' : formatQuotaPercentText(prod.remainingFraction);
    }

    // 3. 构建最终共享池卡片列表
    const poolMap = new Map();
    const ensurePool = (sKey, titleHint, summaryGroup = null) => {
      let pool = poolMap.get(sKey);
      if (!pool) {
        pool = {
          poolKey: sKey,
          title: summaryGroup?.title || fallbackGroupNames[sKey] || titleHint || sKey,
          description: summaryGroup?.description || '',
          sourceType: summaryGroup ? 'quota_summary_and_configs' : 'model_configs_only',
          buckets: summaryGroup ? summaryGroup.buckets.map(b => ({ ...b })) : [],
          models: [],
          status: 'unknown',
          statusLabel: '未知',
          primaryBucket: null,
          remainingFraction: null,
          percentText: '未知',
          isExhausted: false,
          noPermission: false,
          unavailabilityReason: null,
          hasResetTime: false,
          resetTimeIso: null,
          resetAtMs: null,
          resetTimeText: null,
          countdownText: null,
          isResetPassed: false
        };
        poolMap.set(sKey, pool);
      }
      return pool;
    };

    for (const pg of parsedGroups) {
      if (CORE_SHARED_POOLS.has(pg.sharedKey)) {
        ensurePool(pg.sharedKey, pg.title, pg);
      }
    }

    for (const prod of productMap.values()) {
      const sKey = prod.sharedGroupKey;
      if (!CORE_SHARED_POOLS.has(sKey)) continue;
      const summaryGroup = parsedGroups.find(pg => pg.sharedKey === sKey) || null;
      const pool = ensurePool(sKey, prod.productLabel, summaryGroup);
      pool.models.push({
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        efforts: prod.efforts,
        modelIds: prod.modelIds,
        aliases: prod.aliases,
        noPermission: prod.noPermission,
        unavailabilityReason: prod.unavailabilityReason,
        noticeTitle: prod.noticeTitle,
        noticeText: prod.noticeText,
        remainingFraction: prod.remainingFraction,
        percentText: prod.percentText,
        isExhausted: prod.isExhausted
      });
    }

    // 若 summary group 有 explicitModelNames 但还没对应 config 落入，补充可读模型名占位以便展示
    for (const pg of parsedGroups) {
      const pool = poolMap.get(pg.sharedKey);
      if (pool && pool.models.length === 0 && pg.explicitModelNames.length > 0) {
        for (const name of pg.explicitModelNames) {
          pool.models.push({
            productKey: `summary:${normalizeModelLookupName(name)}`,
            productLabel: name,
            vendor: detectModelVendor(name, name),
            efforts: [],
            modelIds: [],
            aliases: [],
            noPermission: false,
            unavailabilityReason: null,
            noticeTitle: null,
            noticeText: null,
            remainingFraction: null,
            percentText: '—',
            isExhausted: false
          });
        }
      }
    }

    // 为无 buckets 的 pool 从组内可用模型 config.quotaInfo 合成主窗口；并为有 buckets 的计算主限制
    for (const pool of poolMap.values()) {
      const allNoPerm = pool.models.length > 0 && pool.models.every(m => m.noPermission);
      if (allNoPerm) {
        pool.noPermission = true;
        pool.unavailabilityReason = pool.models.find(m => m.unavailabilityReason)?.unavailabilityReason || '当前账号套餐不支持该模型';
        pool.status = 'no_permission';
        pool.statusLabel = '权限不足';
        pool.percentText = '无权限';
        continue;
      }

      if (pool.buckets.length === 0) {
        // 仅由 clientModelConfigs 合成主导窗口
        const validFracs = [];
        let earliestReset = null;
        for (const prod of productMap.values()) {
          if (prod.sharedGroupKey !== pool.poolKey || prod.noPermission) continue;
          if (prod.remainingFraction !== null) validFracs.push(prod.remainingFraction);
          if (prod.hasResetTime && (!earliestReset || (prod.resetAtMs !== null && prod.resetAtMs < earliestReset.resetAtMs))) {
            earliestReset = prod;
          }
        }
        if (validFracs.length > 0 || earliestReset) {
          const minFrac = validFracs.length > 0 ? Math.min(...validFracs) : null;
          pool.buckets.push({
            bucketId: 'config-primary',
            windowKey: pool.poolKey === 'shared_gemini_argon' ? 'weekly' : 'quota',
            windowShort: pool.poolKey === 'shared_gemini_argon' ? '7d' : '',
            windowLabel: pool.poolKey === 'shared_gemini_argon' ? '每周限额' : '当前主限额',
            remainingFraction: minFrac,
            percentText: formatQuotaPercentText(minFrac),
            isExhausted: minFrac === 0,
            fractionSource: validFracs.length > 0 ? 'client_config' : 'missing',
            hasResetTime: Boolean(earliestReset?.hasResetTime),
            resetTimeIso: earliestReset?.resetTimeIso || null,
            resetAtMs: earliestReset?.resetAtMs || null,
            resetTimeText: earliestReset?.resetTimeText || null,
            countdownText: earliestReset?.countdownText || null,
            isResetPassed: Boolean(earliestReset?.isResetPassed)
          });
        }
      }

      // 从 buckets 中统一选出主窗口（更紧缩优先 + 5h/7d 确定性平局规则）
      const { primaryBucket: pb, selectionReason } = selectPrimaryQuotaBucket(pool.buckets);
      pool.selectionReason = selectionReason;
      if (pb && pb.remainingFraction !== null && pb.remainingFraction !== undefined) {
        pool.primaryBucket = pb;
        pool.remainingFraction = pb.remainingFraction;
        pool.percentText = pb.percentText;
        pool.isExhausted = pb.isExhausted;
        pool.hasResetTime = pb.hasResetTime;
        pool.resetTimeIso = pb.resetTimeIso;
        pool.resetAtMs = pb.resetAtMs;
        pool.resetTimeText = pb.resetTimeText;
        pool.countdownText = pb.countdownText;
        pool.isResetPassed = pb.isResetPassed;
        if (pb.isExhausted || pb.remainingFraction === 0) {
          pool.status = 'exhausted';
          pool.statusLabel = '额度耗尽';
        } else if (pb.remainingFraction <= 0.2) {
          pool.status = 'low';
          pool.statusLabel = '余量较低';
        } else {
          pool.status = 'available';
          pool.statusLabel = '正常可用';
        }
      } else if (pb) {
        pool.primaryBucket = pb;
        pool.hasResetTime = pb.hasResetTime;
        pool.resetTimeIso = pb.resetTimeIso;
        pool.resetAtMs = pb.resetAtMs;
        pool.resetTimeText = pb.resetTimeText;
        pool.countdownText = pb.countdownText;
        pool.isResetPassed = pb.isResetPassed;
        pool.status = 'unknown';
        pool.statusLabel = '未知';
        pool.percentText = '未知';
      }

      // 优化池标题：若池内模型名比 group description 更清晰则补充
      if (!summaryTitleLooksDescriptive(pool.title) && pool.models.length > 0) {
        pool.title = pool.models.map(m => m.productLabel).slice(0, 3).join(' / ');
      }
    }

    function summaryTitleLooksDescriptive(titleStr) {
      return typeof titleStr === 'string' && titleStr.trim().length > 0 && !titleStr.startsWith('group_') && !titleStr.startsWith('shared_');
    }

    const pools = Array.from(poolMap.values());

    // 4. 匹配当前会话模型与浏览查看池（浏览不修改 currentModel）
    const findMatchedForTarget = (targetInput) => {
      if (!targetInput) return { pool: null, model: null };
      const targetCandidates = typeof targetInput === 'object'
        ? [targetInput.modelId, targetInput.modelOrAlias?.model, targetInput.label, targetInput.model]
            .filter(v => typeof v === 'string' && v.trim())
        : [String(targetInput)].filter(v => v.trim());
      const targetProductKey = typeof targetInput === 'object' && targetInput.productKey
        ? String(targetInput.productKey).trim()
        : '';
      if (targetCandidates.length === 0 && !targetProductKey) return { pool: null, model: null };
      const targetLowers = targetCandidates.map(v => v.trim().toLowerCase());
      const targetStripped = targetLowers.map(v => v.replace(/^model_/, ''));
      const targetNorms = [...new Set(targetCandidates.map(normalizeModelLookupName).filter(Boolean))];

      for (const pool of pools) {
        for (const m of pool.models) {
          const allIds = [...m.modelIds, ...m.aliases].map(x => x.toLowerCase());
          if (allIds.some(id => targetLowers.includes(id) || targetStripped.includes(id.replace(/^model_/, '')))) {
            return { pool, model: m };
          }
          if (targetProductKey && m.productKey && m.productKey === targetProductKey) {
            return { pool, model: m };
          }
          const mNorm = normalizeModelLookupName(m.productLabel);
          if (mNorm && targetNorms.includes(mNorm)) {
            return { pool, model: m };
          }
        }
      }
      const fallbackGroup = getSharedQuotaGroupKey(targetInput);
      const byGroup = pools.find(p => p.poolKey === fallbackGroup);
      if (byGroup) {
        return { pool: byGroup, model: byGroup.models[0] || null };
      }
      return { pool: null, model: null };
    };

    const currentMatch = findMatchedForTarget(input.currentModel);
    const browsePool = input.browsePoolKey
      ? (pools.find(p => p.poolKey === input.browsePoolKey) || currentMatch.pool || pools[0] || null)
      : (currentMatch.pool || pools[0] || null);

    // 5. 数据新鲜度与刷新状态机
    const hasAnyPoolData = pools.length > 0 && pools.some(p => p.remainingFraction !== null || p.noPermission);
    const anyResetPassed = pools.some(p => p.isResetPassed && p.remainingFraction === 0);
    const ageMs = fetchedAtMs !== null ? Math.max(0, nowMs - fetchedAtMs) : null;
    const isAgeExpired = ageMs !== null && ageMs > staleThresholdMs;

    let syncState = 'unknown';
    if (!hasAnyPoolData && lastError) {
      syncState = 'error';
    } else if (hasAnyPoolData && (lastError || isAgeExpired || anyResetPassed)) {
      syncState = 'stale';
    } else if (hasAnyPoolData) {
      syncState = 'fresh';
    } else {
      syncState = 'unknown';
    }

    // 6. 顶栏与概览裁决（严禁仅凭网络错误显示耗尽；不只是颜色表达）
    let activeStatus = 'unknown';
    let activeStatusLabel = '未知';
    let badgeText = '未知';
    let badgeTag = '';
    let activeFraction = null;
    let activeResetMeta = formatQuotaResetMeta(null, nowMs);

    if (syncState === 'error') {
      activeStatus = 'error';
      activeStatusLabel = '刷新失败';
      badgeText = '失败';
      badgeTag = '重试';
    } else if (currentMatch.model?.noPermission || currentMatch.pool?.noPermission) {
      activeStatus = 'no_permission';
      activeStatusLabel = '权限不足';
      badgeText = '无权限';
      badgeTag = '';
    } else if (currentMatch.pool) {
      const p = currentMatch.pool;
      activeFraction = p.remainingFraction;
      activeResetMeta = {
        hasResetTime: p.hasResetTime,
        resetTimeIso: p.resetTimeIso,
        resetAtMs: p.resetAtMs,
        resetTimeText: p.resetTimeText,
        countdownText: p.countdownText,
        isResetPassed: p.isResetPassed
      };
      if (p.remainingFraction === null) {
        activeStatus = syncState === 'stale' ? 'stale' : 'unknown';
        activeStatusLabel = syncState === 'stale' ? '数据过期' : '未知';
        badgeText = syncState === 'stale' ? '过期' : '未知';
      } else if (p.isExhausted || p.remainingFraction === 0) {
        activeStatus = syncState === 'stale' ? 'stale' : 'exhausted';
        activeStatusLabel = syncState === 'stale' ? '数据过期（上次已耗尽）' : '额度耗尽';
        badgeText = '已耗尽';
        badgeTag = p.primaryBucket?.windowShort || '';
      } else {
        activeStatus = syncState === 'stale' ? 'stale' : (p.remainingFraction <= 0.2 ? 'low' : 'available');
        activeStatusLabel = syncState === 'stale' ? '数据过期' : (p.remainingFraction <= 0.2 ? '余量较低' : '正常可用');
        badgeText = p.percentText;
        badgeTag = syncState === 'stale' ? '过期' : (p.primaryBucket?.windowShort || '');
      }
    } else if (syncState === 'stale') {
      activeStatus = 'stale';
      activeStatusLabel = '数据过期';
      badgeText = '过期';
    } else if (hasAnyPoolData && !input.currentModel) {
      // 未确定当前模型但已获取池数据：取所有可用池中最紧缩的一个或明确标注未识别当前模型
      activeStatus = 'unknown';
      activeStatusLabel = '未匹配当前模型';
      badgeText = '未知';
    }

    return {
      schemaVersion: 1,
      syncState,
      fetchedAtMs,
      nextRefreshAtMs,
      staleThresholdMs,
      lastError,
      errorKind,
      currentModel: currentMatch.model
        ? {
            productKey: currentMatch.model.productKey,
            productLabel: currentMatch.model.productLabel,
            poolKey: currentMatch.pool.poolKey,
            poolTitle: currentMatch.pool.title,
            noPermission: currentMatch.model.noPermission,
            unavailabilityReason: currentMatch.model.unavailabilityReason,
            noticeText: currentMatch.model.noticeText
          }
        : (input.currentModel ? { productLabel: String(input.currentModel?.label || input.currentModel), poolKey: null, poolTitle: null } : null),
      activeStatus,
      activeStatusLabel,
      badge: {
        text: badgeText,
        tag: badgeTag,
        fraction: activeFraction,
        status: activeStatus,
        statusLabel: activeStatusLabel
      },
      activeReset: activeResetMeta,
      browsePoolKey: browsePool?.poolKey || null,
      planTierName: planStatus?.tierName || planStatus?.planName || null,
      planTierKey: planStatus?.tierKey || null,
      planTierId: planStatus?.tierId || null,
      planTeamsTier: planStatus?.teamsTier || null,
      pools,
      basisNote: '仅依据宿主接口返回的剩余比例与重置时间展示，不凭空换算剩余 Token 数量。'
    };
  }

  /**
   * 严格校验外部链接是否属于官方白名单（官方仓库或作者署名主页）
   */
  function formatApproxTokensShort(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return null;
    if (num >= 1000000000) return `${(num / 1000000000).toFixed(2)}B`;
    if (num >= 1000000) return `${(num / 1000000).toFixed(num >= 10000000 ? 1 : 2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(num >= 100000 ? 0 : 1)}K`;
    return String(Math.round(num));
  }

  function inferQuotaWindowDurationMs(windowKey, bucketId = '') {
    const k = String(windowKey || bucketId || '').toLowerCase();
    if (!k) return null;
    if (k === '5h' || k.includes('5hour') || k.includes('5_hour')) return 5 * 3600000;
    if (k === 'weekly' || k === '7d' || k.includes('week')) return 7 * 86400000;
    if (k === 'daily' || k === '24h' || k.includes('day')) return 24 * 3600000;
    return null;
  }

  const QUOTA_CAL_TTL_MS = {
    '5h': 7 * 86400000,
    weekly: 21 * 86400000,
    daily: 14 * 86400000,
    default: 14 * 86400000
  };

  function computeBucketTokenEstimate(pool, bucket, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const prev = options.calibrationEntry && typeof options.calibrationEntry === 'object'
      ? { ...options.calibrationEntry }
      : null;
    const events = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const rawCoverageStart = options.historyCoverageStartMs;
    const historyCoverageStartMs = (rawCoverageStart !== null && rawCoverageStart !== undefined && Number.isFinite(Number(rawCoverageStart)) && Number(rawCoverageStart) > 0)
      ? Number(rawCoverageStart)
      : null;
    const frac = (bucket && typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction))
      ? Math.max(0, Math.min(1, bucket.remainingFraction))
      : null;

    if (pool?.noPermission) {
      return {
        estRemainingTokens: null,
        estRemainingShort: null,
        estTotalTokens: null,
        estTotalShort: null,
        estSource: 'unavailable',
        estBasis: 'no_permission',
        isReliable: false,
        isStaleCalibration: false,
        invalidationReason: 'no_permission',
        hasFullCycleCoverage: false,
        mixedPoolModels: false,
        poolModelsUsed: [],
        tokenAccountingBasis: 'raw_input_cache_output',
        cycleInputTokens: 0,
        cycleCacheTokens: 0,
        cycleOutputTokens: 0,
        sampleCount: Number(prev?.sampleCount) || 0,
        cycleTokensUsed: 0,
        externalDivergence: false,
        nextCalibrationEntry: prev
      };
    }

    const poolModelKeys = new Set();
    if (Array.isArray(pool?.models)) {
      for (const m of pool.models) {
        for (const rawId of [...(m.modelIds || []), ...(m.aliases || []), m.productLabel]) {
          const pk = getModelPoolKey(rawId);
          if (pk && pk !== 'unknown') poolModelKeys.add(pk);
        }
      }
    }
    const poolSharedKey = pool?.poolKey || null;
    const windowMs = inferQuotaWindowDurationMs(bucket?.windowKey, bucket?.bucketId);
    const maxCalAgeMs = QUOTA_CAL_TTL_MS[bucket?.windowKey] || QUOTA_CAL_TTL_MS.default;
    const resetAtMs = (bucket?.hasResetTime && Number.isFinite(Number(bucket.resetAtMs))) ? Number(bucket.resetAtMs) : null;
    const prevResetMs = prev?.lastResetAtMs != null && Number.isFinite(Number(prev.lastResetAtMs))
      ? Number(prev.lastResetAtMs)
      : (prev?.lastResetTimeIso ? new Date(prev.lastResetTimeIso).getTime() : NaN);

    const resetShiftedForward = resetAtMs !== null && Number.isFinite(prevResetMs) && (resetAtMs - prevResetMs) > 600000;
    const jumpedUp = Boolean(prev && typeof prev.lastFraction === 'number' && frac !== null && (frac - prev.lastFraction) >= 0.04);
    const isNewCycle = Boolean(resetShiftedForward || jumpedUp);
    let resetObservedAt = Number(prev?.lastResetObservedAt) || 0;
    if (isNewCycle) {
      resetObservedAt = nowMs;
    }

    // 仅在存在重置时间且处于当前合理窗口内时推算理论周期起点；注意它本身不能证明本地覆盖全周期
    let cycleStartMs = null;
    if (resetAtMs !== null && windowMs !== null && !bucket?.isResetPassed && (resetAtMs - nowMs) <= windowMs + 300000) {
      cycleStartMs = resetAtMs - windowMs;
    }

    // 周期起点覆盖证明：要么本周期在本机监控期间发生过重置/满额基线观察，要么采集器明确给出了不晚于周期起点的历史记录时间
    const prevObservedFullSameCycle = Boolean(
      !isNewCycle &&
      prev?.observedCycleFromStart === true &&
      (resetAtMs === null || prev?.fullStartCycleResetMs === resetAtMs)
    );
    const currentObservedFull = Boolean(
      cycleStartMs !== null &&
      frac !== null &&
      ((isNewCycle && resetAtMs !== null) || (!prev && frac >= 0.98) || (prevObservedFullSameCycle))
    );
    const observedCycleFromStart = prevObservedFullSameCycle || currentObservedFull;
    const fullStartCycleResetMs = observedCycleFromStart ? (resetAtMs ?? prev?.fullStartCycleResetMs ?? null) : null;
    const withinHistoryRetention = cycleStartMs !== null && (nowMs - cycleStartMs) <= (8 * 86400000 + 300000);
    const hasCollectorCoverage = Boolean(
      cycleStartMs !== null &&
      withinHistoryRetention &&
      historyCoverageStartMs !== null &&
      historyCoverageStartMs <= cycleStartMs + 300000
    );
    const hasFullCycleCoverage = Boolean(cycleStartMs !== null && (observedCycleFromStart || hasCollectorCoverage));

    const effectiveStartMs = cycleStartMs !== null
      ? Math.max(cycleStartMs, resetObservedAt ? resetObservedAt - 60000 : 0)
      : (resetObservedAt ? resetObservedAt - 60000 : (windowMs !== null ? nowMs - windowMs : null));

    let cycleTokensUsed = 0;
    let cycleInputTokens = 0;
    let cycleCacheTokens = 0;
    let cycleOutputTokens = 0;
    const poolModelsSet = new Set();
    if (effectiveStartMs !== null) {
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const evShared = ev.sharedGroupKey || (ev.poolKey ? getSharedQuotaGroupKey(ev.poolKey) : null);
        const matchesPool = (poolSharedKey && evShared === poolSharedKey) || (ev.poolKey && poolModelKeys.has(ev.poolKey));
        if (!matchesPool) continue;
        const ts = Number(ev.ts ?? ev.timestamp);
        const inp = Math.max(0, Number(ev.inputTokens || 0));
        const cache = Math.max(0, Number(ev.cacheTokens ?? ev.cacheReadTokens ?? 0));
        const outp = Math.max(0, Number(ev.outputTokens || 0));
        const tok = Number(ev.totalTokens ?? ev.tok ?? (inp + cache + outp));
        if (!Number.isFinite(ts) || !Number.isFinite(tok) || tok <= 0) continue;
        if (ts >= effectiveStartMs && ts <= nowMs + 60000) {
          cycleTokensUsed += tok;
          cycleInputTokens += inp;
          cycleCacheTokens += cache;
          cycleOutputTokens += outp;
          if (ev.poolKey && ev.poolKey !== 'unknown') poolModelsSet.add(String(ev.poolKey));
        }
      }
    }
    const mixedPoolModels = poolModelsSet.size > 1;
    const poolModelsUsed = Array.from(poolModelsSet);

    // 校验历史校准合法性与有效期（缺失 calibratedAt 视作旧版未知时效缓存并过期失效）
    const rawPriorTotal = (prev && Number.isFinite(Number(prev.calibratedTotalTokens)) && Number(prev.calibratedTotalTokens) >= 15000 && Number(prev.calibratedTotalTokens) <= 1e11)
      ? Number(prev.calibratedTotalTokens)
      : null;
    const rawCalAt = (prev && Number.isFinite(Number(prev.calibratedAt)) && Number(prev.calibratedAt) > 0)
      ? Number(prev.calibratedAt)
      : (prev && Number.isFinite(Number(prev.updatedAt)) && rawPriorTotal !== null && prev.schemaVersion >= 2 ? Number(prev.updatedAt) : null);
    const isCalibrationExpired = rawPriorTotal !== null && (rawCalAt === null || (nowMs - rawCalAt) > maxCalAgeMs);

    let calibratedTotal = (!isCalibrationExpired && rawPriorTotal !== null) ? rawPriorTotal : null;
    let calibratedAt = calibratedTotal !== null ? rawCalAt : null;
    let calibratedResetAtMs = calibratedTotal !== null ? (prev?.calibratedResetAtMs ?? null) : null;
    let sampleCount = calibratedTotal !== null ? (Number(prev?.sampleCount) || 0) : 0;
    let calSource = calibratedTotal !== null ? (prev?.source || null) : null;

    // 独立的先验历史基线：仅当先验校准是在另一个周期或通过增量/完整历史建立且未过期、未被污染时，才可用于异常降级参考
    const priorIndependentTotal = (calibratedTotal !== null && !prev?.externalDivergenceInCycle && calSource !== 'cycle')
      ? calibratedTotal
      : null;

    let externalDivergence = false;
    let divergenceInCycle = isNewCycle ? false : Boolean(prev?.externalDivergenceInCycle);
    let invalidationReason = isNewCycle ? null : (prev?.cycleInvalidationReason || null);
    let calibratedThisStep = false;

    if (frac === null) {
      return {
        estRemainingTokens: null,
        estRemainingShort: null,
        estTotalTokens: calibratedTotal ? Math.round(calibratedTotal) : null,
        estTotalShort: calibratedTotal ? formatApproxTokensShort(calibratedTotal) : null,
        estSource: 'unknown',
        estBasis: 'fraction_missing',
        isReliable: false,
        isStaleCalibration: Boolean(calibratedTotal),
        invalidationReason: 'fraction_missing',
        hasFullCycleCoverage,
        mixedPoolModels,
        poolModelsUsed,
        tokenAccountingBasis: 'raw_input_cache_output',
        cycleInputTokens: Math.round(cycleInputTokens),
        cycleCacheTokens: Math.round(cycleCacheTokens),
        cycleOutputTokens: Math.round(cycleOutputTokens),
        sampleCount,
        cycleTokensUsed: Math.round(cycleTokensUsed),
        externalDivergence: divergenceInCycle,
        nextCalibrationEntry: prev
      };
    }

    let anchorFraction = (prev && typeof prev.anchorFraction === 'number' && !isNewCycle)
      ? prev.anchorFraction
      : frac;
    let anchorCycleTokens = (prev && typeof prev.anchorCycleTokens === 'number' && !isNewCycle)
      ? prev.anchorCycleTokens
      : cycleTokensUsed;

    // 同一周期内若余量微幅上浮（小于重置阈值），刷新高水位锚点
    if (frac > anchorFraction && (frac - anchorFraction) < 0.04 && !resetShiftedForward) {
      anchorFraction = frac;
      anchorCycleTokens = cycleTokensUsed;
    }

    const deltaF = anchorFraction - frac;
    const deltaTok = cycleTokensUsed - anchorCycleTokens;

    if (!divergenceInCycle) {
      // 方法 A（优先）：同周期相邻有效采样差值校准。要求余量降幅 >= 2% 且本机增耗 >= 2,000 Tokens
      if (deltaF >= 0.02 && deltaTok >= 2000) {
        const sampleTotal = deltaTok / deltaF;
        const outOfBounds = !Number.isFinite(sampleTotal) || sampleTotal < 15000 || sampleTotal > 1e11;
        const tooLowVsPrior = calibratedTotal !== null && sampleTotal < calibratedTotal * 0.25;
        const tooHighVsPrior = calibratedTotal !== null && sampleTotal > calibratedTotal * 4.5;
        if (!outOfBounds && !tooLowVsPrior && !tooHighVsPrior) {
          if (calibratedTotal !== null && sampleCount >= 1) {
            const clamped = Math.max(calibratedTotal * 0.35, Math.min(calibratedTotal * 3, sampleTotal));
            calibratedTotal = sampleCount >= 2 ? (calibratedTotal * 0.6 + clamped * 0.4) : (calibratedTotal * 0.4 + clamped * 0.6);
          } else {
            calibratedTotal = sampleTotal;
          }
          sampleCount += 1;
          calSource = 'delta';
          calibratedAt = nowMs;
          calibratedResetAtMs = resetAtMs;
          calibratedThisStep = true;
          invalidationReason = null;
          anchorFraction = frac;
          anchorCycleTokens = cycleTokensUsed;
        } else {
          externalDivergence = true;
          divergenceInCycle = true;
          invalidationReason = tooHighVsPrior ? 'calibration_ratio_drift' : (tooLowVsPrior ? 'external_divergence' : 'delta_out_of_bounds');
        }
      } else if ((deltaF >= 0.03 && deltaTok < 500) || (deltaF >= 0.15 && deltaTok < 2000)) {
        // 同周期可观测窗口内额度明显下降 (>=3% 且几乎零本地消耗，或 >=15% 且增量不足 2,000) -> 外部/他端消耗或漏采
        externalDivergence = true;
        divergenceInCycle = true;
        invalidationReason = 'external_divergence';
      }

      // 方法 B（次选）：必须同时具备周期起点覆盖证明 + 本机足量消耗 (>=3,000) + 无异常偏移，绝不单凭 resetAt - windowMs 强行反推
      const usedFrac = 1 - frac;
      if (usedFrac >= 0.03 && !externalDivergence && !divergenceInCycle) {
        if (hasFullCycleCoverage) {
          if (cycleTokensUsed >= 3000) {
            const cycleTotal = cycleTokensUsed / usedFrac;
            const outOfBounds = !Number.isFinite(cycleTotal) || cycleTotal < 15000 || cycleTotal > 1e11 || (usedFrac >= 0.1 && cycleTotal < 15000);
            const deviatesVsPrior = calibratedTotal !== null && (cycleTotal < calibratedTotal * 0.25 || cycleTotal > calibratedTotal * 4.5);
            if (!outOfBounds && !deviatesVsPrior) {
              if (calibratedTotal === null || calSource !== 'delta') {
                calibratedTotal = cycleTotal;
                calSource = 'cycle';
                calibratedAt = nowMs;
                calibratedResetAtMs = resetAtMs;
                calibratedThisStep = true;
                sampleCount = Math.max(sampleCount, 1);
              }
              invalidationReason = null;
            } else {
              externalDivergence = true;
              divergenceInCycle = true;
              invalidationReason = deviatesVsPrior ? 'external_divergence' : 'cycle_out_of_bounds';
            }
          } else if ((usedFrac >= 0.05 && cycleTokensUsed < 500) || (usedFrac >= 0.15 && cycleTokensUsed < 2000)) {
            externalDivergence = true;
            divergenceInCycle = true;
            invalidationReason = 'external_divergence';
          }
        } else if (usedFrac >= 0.15 && cycleTokensUsed < 500) {
          // 首次或缺失周期起点覆盖时若周期已消耗 >= 15% 但本地几乎零消耗：本轮标识为缺样本/他端消耗拦截，
          // 但仅在已存在前置对比且确认同区段发生外耗时才锁死后续增量法 A（防止首次半周期接入后永久阻塞增量校准）
          externalDivergence = true;
          invalidationReason = 'external_divergence';
        }
      }
    } else {
      externalDivergence = true;
    }

    // 状态判定严格互斥：耗尽 -> 外部消耗/异常降级 -> 校准过期 -> 正常本周期/历史参考 -> 等待或覆盖不足
    const isCurrentCycleCalibrated = Boolean(
      calibratedTotal !== null &&
      !divergenceInCycle &&
      (calibratedThisStep || (calibratedResetAtMs !== null && resetAtMs !== null && calibratedResetAtMs === resetAtMs))
    );
    const hasAnyInvalidation = Boolean(externalDivergence || divergenceInCycle);

    let estRemainingTokens = null;
    let estTotalTokensOut = calibratedTotal !== null ? Math.round(calibratedTotal) : null;
    let estSource = 'uncalibrated';
    let estBasis = 'waiting_samples';
    let isReliable = false;
    let isStaleCalibration = false;
    let finalReason = invalidationReason;

    if (frac === 0) {
      estRemainingTokens = 0;
      estSource = 'exhausted';
      estBasis = 'exhausted';
      isReliable = true;
      finalReason = null;
    } else if (hasAnyInvalidation) {
      // 检测到外部消耗或异常失真：绝不按正常有效校准展示；无独立有效历史基线时强制置空，存在时降级标为不可靠参考
      if (priorIndependentTotal !== null && !isCalibrationExpired) {
        estRemainingTokens = Math.max(0, Math.round(priorIndependentTotal * frac));
        estTotalTokensOut = Math.round(priorIndependentTotal);
        estSource = 'unreliable_cached';
        estBasis = 'stale_with_divergence';
        isReliable = false;
        isStaleCalibration = true;
        finalReason = finalReason || 'external_divergence';
      } else {
        estRemainingTokens = null;
        estTotalTokensOut = null;
        estSource = 'incomplete';
        estBasis = 'incomplete_samples';
        isReliable = false;
        isStaleCalibration = false;
        finalReason = finalReason || 'external_divergence';
      }
    } else if (isCalibrationExpired && calibratedTotal === null) {
      estRemainingTokens = null;
      estTotalTokensOut = null;
      estSource = 'expired';
      estBasis = 'calibration_expired';
      isReliable = false;
      isStaleCalibration = true;
      finalReason = 'calibration_expired';
    } else if (calibratedTotal !== null) {
      estRemainingTokens = Math.max(0, Math.round(calibratedTotal * frac));
      if (isCurrentCycleCalibrated && calSource === 'delta') {
        estSource = 'delta';
        estBasis = 'delta_calibrated';
        isReliable = true;
        finalReason = null;
        invalidationReason = null;
      } else if (isCurrentCycleCalibrated && calSource === 'cycle' && hasFullCycleCoverage) {
        estSource = 'cycle';
        estBasis = 'cycle_estimated';
        isReliable = true;
        finalReason = null;
        invalidationReason = null;
      } else {
        // 跨周期沿用未过期的历史校准且当期暂无新样本：保留数值但标记为非实时可靠的历史参考
        estSource = 'cached';
        estBasis = 'cached_calibration';
        isReliable = false;
        isStaleCalibration = true;
        finalReason = 'cross_cycle_unverified';
      }
    } else {
      estRemainingTokens = null;
      estSource = 'uncalibrated';
      estBasis = (!hasFullCycleCoverage && (1 - frac) >= 0.03) ? 'coverage_incomplete' : 'waiting_samples';
      isReliable = false;
    }

    const nextCalibrationEntry = {
      schemaVersion: 2,
      calibratedTotalTokens: calibratedTotal !== null ? Math.round(calibratedTotal) : null,
      calibratedAt: calibratedAt ?? null,
      calibratedResetAtMs: calibratedResetAtMs ?? null,
      sampleCount,
      source: calSource,
      lastFraction: frac,
      lastResetAtMs: resetAtMs,
      lastResetTimeIso: bucket?.resetTimeIso || null,
      lastResetObservedAt: resetObservedAt || null,
      observedCycleFromStart,
      fullStartCycleResetMs,
      externalDivergenceInCycle: divergenceInCycle,
      cycleInvalidationReason: invalidationReason,
      anchorFraction,
      anchorCycleTokens: Math.round(anchorCycleTokens),
      updatedAt: nowMs
    };

    return {
      estRemainingTokens,
      estRemainingShort: estRemainingTokens !== null ? formatApproxTokensShort(estRemainingTokens) : null,
      estTotalTokens: estTotalTokensOut,
      estTotalShort: estTotalTokensOut !== null ? formatApproxTokensShort(estTotalTokensOut) : null,
      estSource,
      estBasis,
      isReliable,
      isStaleCalibration,
      invalidationReason: finalReason || null,
      hasFullCycleCoverage,
      mixedPoolModels,
      poolModelsUsed,
      tokenAccountingBasis: 'raw_input_cache_output',
      cycleInputTokens: Math.round(cycleInputTokens),
      cycleCacheTokens: Math.round(cycleCacheTokens),
      cycleOutputTokens: Math.round(cycleOutputTokens),
      sampleCount,
      cycleTokensUsed: Math.round(cycleTokensUsed),
      externalDivergence: hasAnyInvalidation,
      nextCalibrationEntry
    };
  }

  function applyQuotaTokenEstimates(snapshot, options = {}) {
    if (!snapshot || !Array.isArray(snapshot.pools)) {
      return { snapshot, nextCalibrationMap: { ...(options.calibrationMap || {}) } };
    }
    const scopeKey = options.accountScopeKey || snapshot.accountScopeKey || 'anonymous';
    const prevMap = (options.calibrationMap && typeof options.calibrationMap === 'object') ? options.calibrationMap : {};
    const nextCalibrationMap = { ...prevMap };
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : (snapshot.fetchedAtMs || Date.now());
    const usageEvents = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const historyCoverageStartMs = options.historyCoverageStartMs ?? null;

    const nextPools = snapshot.pools.map(pool => {
      if (!pool || !Array.isArray(pool.buckets)) return pool;
      const nextBuckets = pool.buckets.map(bucket => {
        const entryKey = `${scopeKey}::${pool.poolKey}::${bucket.windowKey || bucket.bucketId || 'primary'}`;
        const est = computeBucketTokenEstimate(pool, bucket, {
          nowMs,
          usageEvents,
          historyCoverageStartMs,
          calibrationEntry: prevMap[entryKey] || null
        });
        if (est.nextCalibrationEntry) {
          nextCalibrationMap[entryKey] = est.nextCalibrationEntry;
        }
        return {
          ...bucket,
          tokenEstimate: {
            estRemainingTokens: est.estRemainingTokens,
            estRemainingShort: est.estRemainingShort,
            estTotalTokens: est.estTotalTokens,
            estTotalShort: est.estTotalShort,
            estSource: est.estSource,
            estBasis: est.estBasis,
            isReliable: est.isReliable,
            isStaleCalibration: est.isStaleCalibration,
            invalidationReason: est.invalidationReason,
            hasFullCycleCoverage: est.hasFullCycleCoverage,
            mixedPoolModels: est.mixedPoolModels,
            poolModelsUsed: est.poolModelsUsed,
            tokenAccountingBasis: est.tokenAccountingBasis,
            cycleInputTokens: est.cycleInputTokens,
            cycleCacheTokens: est.cycleCacheTokens,
            cycleOutputTokens: est.cycleOutputTokens,
            sampleCount: est.sampleCount,
            cycleTokensUsed: est.cycleTokensUsed,
            externalDivergence: est.externalDivergence
          }
        };
      });
      const nextPrimaryBucket = pool.primaryBucket
        ? (nextBuckets.find(b => b.bucketId === pool.primaryBucket.bucketId) || nextBuckets[0] || pool.primaryBucket)
        : (nextBuckets[0] || null);
      return {
        ...pool,
        buckets: nextBuckets,
        primaryBucket: nextPrimaryBucket,
        tokenEstimate: nextPrimaryBucket?.tokenEstimate || null
      };
    });

    return {
      snapshot: {
        ...snapshot,
        pools: nextPools
      },
      nextCalibrationMap
    };
  }

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

  const UNATTRIBUTED_MODEL_KEY = '__unattributed__';
  const MODEL_PRODUCT_DISPLAY_NAMES = {
    'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-4-carbon': 'Gemini 4 Carbon',
    'orchestrator': 'Orchestrator',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'gpt-oss-120b': 'GPT-OSS 120B'
  };
  const MODEL_FIXED_COLORS_DARK = {
    'gemini-4-hydrogen': '#a78bfa',
    'gemini-4-argon': '#6366f1',
    'gemini-3.8-flash': '#38bdf8',
    'gemini-4-carbon': '#e879f9',
    'orchestrator': '#f472b6',
    'claude-opus-5-5': '#f59e0b',
    'claude-sonnet-5-5': '#fbbf24',
    'gpt-oss-120b': '#10b981',
    'gemini-3.1-pro-preview': '#818cf8',
    'gemini-3.5-flash-lite': '#2dd4bf',
    'gemini-2.5-pro': '#8b5cf6',
    [UNATTRIBUTED_MODEL_KEY]: 'rgba(161, 161, 170, 0.28)'
  };
  const MODEL_FIXED_COLORS_LIGHT = {
    'gemini-4-hydrogen': '#7c3aed',
    'gemini-4-argon': '#4f46e5',
    'gemini-3.8-flash': '#0284c7',
    'gemini-4-carbon': '#c026d3',
    'orchestrator': '#db2777',
    'claude-opus-5-5': '#d97706',
    'claude-sonnet-5-5': '#b45309',
    'gpt-oss-120b': '#059669',
    'gemini-3.1-pro-preview': '#4338ca',
    'gemini-3.5-flash-lite': '#0d9488',
    'gemini-2.5-pro': '#6d28d9',
    [UNATTRIBUTED_MODEL_KEY]: 'rgba(113, 113, 122, 0.24)'
  };
  const MODEL_FALLBACK_PALETTE_DARK = ['#a78bfa', '#38bdf8', '#6366f1', '#2dd4bf', '#f59e0b', '#e879f9', '#10b981', '#f472b6'];
  const MODEL_FALLBACK_PALETTE_LIGHT = ['#7c3aed', '#0284c7', '#4f46e5', '#0d9488', '#d97706', '#c026d3', '#059669', '#db2777'];
  const MODEL_USAGE_ID_FALLBACK_LABELS = {
    'gemini-flash-worker-agy': 'Gemini 4 Hydrogen (Orchestrator)',
    'model_placeholder_m669': 'Gemini 4 Hydrogen (Orchestrator)',
    'placeholder-m669': 'Gemini 4 Hydrogen (Orchestrator)',
    'm669': 'Gemini 4 Hydrogen (Orchestrator)',
    'model_placeholder_m667': 'Orchestrator (Carbon)',
    'placeholder-m667': 'Orchestrator (Carbon)',
    'm667': 'Orchestrator (Carbon)',
    'model_placeholder_m681': 'Orchestrator (Argon)',
    'placeholder-m681': 'Orchestrator (Argon)',
    'm681': 'Orchestrator (Argon)',
    'model_placeholder_m668': 'Orchestrator (Argon)',
    'placeholder-m668': 'Orchestrator (Argon)',
    'm668': 'Orchestrator (Argon)',
    'model_placeholder_m670': 'Gemini 4 Carbon',
    'placeholder-m670': 'Gemini 4 Carbon',
    'm670': 'Gemini 4 Carbon',
    'gemini-4-hydrogen-sonar': 'Gemini 4 Hydrogen',
    'model_placeholder_m578': 'Gemini 4 Hydrogen',
    'm578': 'Gemini 4 Hydrogen',
    'gemini-4-hydrogen-tiered-high': 'Gemini 4 Hydrogen (High)',
    'model_placeholder_m530': 'Gemini 4 Hydrogen (High)',
    'm530': 'Gemini 4 Hydrogen (High)',
    'gemini-4-hydrogen-tiered-xhigh': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m531': 'Gemini 4 Hydrogen (XHigh)',
    'm531': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m525': 'Gemini 4 Hydrogen (High)',
    'm525': 'Gemini 4 Hydrogen (High)',
    'model_placeholder_m526': 'Gemini 4 Hydrogen (Medium)',
    'm526': 'Gemini 4 Hydrogen (Medium)',
    'model_placeholder_m527': 'Gemini 4 Hydrogen (Low)',
    'm527': 'Gemini 4 Hydrogen (Low)',
    'model_placeholder_m528': 'Gemini 4 Hydrogen (XHigh)',
    'm528': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m417': 'Gemini 4 Argon (High)',
    'm417': 'Gemini 4 Argon (High)',
    'model_placeholder_m418': 'Gemini 4 Argon (Medium)',
    'm418': 'Gemini 4 Argon (Medium)',
    'model_placeholder_m419': 'Gemini 4 Argon (Low)',
    'm419': 'Gemini 4 Argon (Low)',
    'model_placeholder_m427': 'Gemini 4 Carbon (High)',
    'm427': 'Gemini 4 Carbon (High)',
    'model_placeholder_m437': 'Gemini 4 Carbon (Medium)',
    'm437': 'Gemini 4 Carbon (Medium)',
    'model_placeholder_m438': 'Gemini 4 Carbon (Low)',
    'm438': 'Gemini 4 Carbon (Low)',
    'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
    'model_placeholder_m322': 'Gemini 3.8 Flash',
    'm322': 'Gemini 3.8 Flash',
    'model_placeholder_m318': 'Gemini 3.8 Flash (High)',
    'm318': 'Gemini 3.8 Flash (High)',
    'model_placeholder_m319': 'Gemini 3.8 Flash (Medium)',
    'm319': 'Gemini 3.8 Flash (Medium)',
    'model_placeholder_m320': 'Gemini 3.8 Flash (Low)',
    'm320': 'Gemini 3.8 Flash (Low)',
    'model_placeholder_m400': 'Claude Opus 5.5 (Low)',
    'm400': 'Claude Opus 5.5 (Low)',
    'model_placeholder_m401': 'Claude Opus 5.5 (Medium)',
    'm401': 'Claude Opus 5.5 (Medium)',
    'model_placeholder_m402': 'Claude Opus 5.5 (High)',
    'm402': 'Claude Opus 5.5 (High)',
    'model_placeholder_m403': 'Claude Sonnet 5.5 (Low)',
    'm403': 'Claude Sonnet 5.5 (Low)',
    'model_placeholder_m404': 'Claude Sonnet 5.5 (Medium)',
    'm404': 'Claude Sonnet 5.5 (Medium)',
    'model_placeholder_m405': 'Claude Sonnet 5.5 (High)',
    'm405': 'Claude Sonnet 5.5 (High)',
    'model_placeholder_m198': 'Gemini 3.5 Flash-Lite',
    'm198': 'Gemini 3.5 Flash-Lite',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
    'model_placeholder_m50': 'Gemini 3.1 Flash-Lite',
    'm50': 'Gemini 3.1 Flash-Lite',
    'gemini-3-flash': 'Gemini 3 Flash',
    'model_placeholder_m18': 'Gemini 3 Flash',
    'm18': 'Gemini 3 Flash'
  };

  function isOpaqueModelToken(raw) {
    const s = String(raw || '').trim();
    if (!s) return true;
    if (/^(?:model_placeholder_|placeholder[-_]|model_)/i.test(s)) return true;
    return !/[A-Z\s()]/.test(s);
  }

  function buildLookupKeysForModel(val) {
    const clean = String(val || '').trim().toLowerCase();
    if (!clean) return [];
    const stripped = clean.replace(/^model_/, '');
    const keys = [clean, stripped];
    const mPh = stripped.match(/placeholder[_-]?(m\d+)$/);
    if (mPh) keys.push(`model_placeholder_${mPh[1]}`, `placeholder-${mPh[1]}`, mPh[1]);
    return Array.from(new Set(keys));
  }

  function lookupModelDisplayLabel(call, cascadeModelConfigs = [], availableModelDetails = null) {
    const rawCandidates = [
      call?.modelExactId,
      call?.modelOrAlias?.model,
      call?.modelId,
      call?.chatModel?.modelId,
      call?.modelRaw,
      call?.model
    ].filter(v => typeof v === 'string' && v.trim());

    const candKeySet = new Set();
    for (const rc of rawCandidates) {
      for (const k of buildLookupKeysForModel(rc)) candKeySet.add(k);
    }
    if (candKeySet.size === 0) return '';

    if (Array.isArray(cascadeModelConfigs)) {
      for (const cfg of cascadeModelConfigs) {
        if (!cfg || typeof cfg !== 'object') continue;
        const lbl = String(cfg.label || cfg.displayName || '').trim();
        if (!lbl || isOpaqueModelToken(lbl)) continue;
        const cfgKeys = [
          ...buildLookupKeysForModel(cfg.modelId),
          ...buildLookupKeysForModel(cfg.modelOrAlias?.model),
          ...buildLookupKeysForModel(cfg.model)
        ];
        if (cfgKeys.some(k => candKeySet.has(k))) return lbl;
      }
    }

    if (availableModelDetails && typeof availableModelDetails === 'object') {
      for (const ck of candKeySet) {
        const direct = availableModelDetails[ck];
        const directName = String(direct?.displayName || direct?.label || '').trim();
        if (directName && !isOpaqueModelToken(directName)) return directName;
      }
      for (const [aKey, detail] of Object.entries(availableModelDetails)) {
        if (!detail || typeof detail !== 'object') continue;
        const dName = String(detail.displayName || detail.label || '').trim();
        if (!dName || isOpaqueModelToken(dName)) continue;
        const dKeys = [
          ...buildLookupKeysForModel(aKey),
          ...buildLookupKeysForModel(detail.modelId),
          ...buildLookupKeysForModel(detail.normalizedId)
        ];
        if (dKeys.some(k => candKeySet.has(k))) return dName;
      }
    }

    for (const ck of candKeySet) {
      if (MODEL_USAGE_ID_FALLBACK_LABELS[ck]) return MODEL_USAGE_ID_FALLBACK_LABELS[ck];
    }
    return '';
  }

  function resolveModelUsageBucket(call, cascadeModelConfigs = [], availableModelDetails = null) {
    if (!call || typeof call !== 'object') {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const rawStr = String(call.model || call.modelLabel || call.modelExactId || call.modelId || '').trim();
    if (!rawStr) {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const resolvedStable = resolveStableModelId(call, cascadeModelConfigs);
    const dynamicOrFallbackLabel = lookupModelDisplayLabel(
      { ...call, modelExactId: call.modelExactId || resolvedStable },
      cascadeModelConfigs,
      availableModelDetails
    );
    const explicitHumanLabel = (call.modelLabel && !isOpaqueModelToken(call.modelLabel))
      ? String(call.modelLabel).trim()
      : (call.chatModel?.modelDisplayName && !isOpaqueModelToken(call.chatModel.modelDisplayName))
        ? String(call.chatModel.modelDisplayName).trim()
        : '';
    const effectiveLabel = dynamicOrFallbackLabel || explicitHumanLabel || (!isOpaqueModelToken(rawStr) ? rawStr : '');
    const probeText = `${effectiveLabel} ${rawStr} ${resolvedStable || ''}`.trim();
    const probeLower = probeText.toLowerCase();

    // Orchestrator 与 Worker 子模型专用归属：
    // - gemini-flash-worker-agy / M669 / Gemini 4 Hydrogen (Orchestrator) 归入 Gemini 4 Hydrogen，档位标为 (Orchestrator)
    // - Orchestrator (Carbon / Argon) 归入独立 Orchestrator 模型家族，按档位展开 Carbon / Argon
    if (
      probeLower.includes('worker-agy') ||
      /\bm669\b/.test(probeLower) ||
      (probeLower.includes('hydrogen') && probeLower.includes('orchestrator'))
    ) {
      return {
        modelKey: 'gemini-4-hydrogen',
        modelLabel: 'Gemini 4 Hydrogen',
        variantKey: 'gemini-4-hydrogen:orchestrator',
        variantLabel: 'Gemini 4 Hydrogen (Orchestrator)',
        isAttributed: true
      };
    }

    if (
      probeLower.includes('orchestrator') ||
      /\b(?:model_placeholder_|placeholder[-_])?m(?:667|668|681)\b/.test(probeLower)
    ) {
      let tier = null;
      let tierLabel = null;
      const lblLower = effectiveLabel.toLowerCase();
      if (lblLower.includes('carbon') || probeLower.includes('carbon') || /\b(?:model_placeholder_|placeholder[-_])?m(?:667|670)\b/.test(probeLower)) {
        tier = 'carbon';
        tierLabel = 'Orchestrator (Carbon)';
      } else if (lblLower.includes('argon') || probeLower.includes('argon') || /\b(?:model_placeholder_|placeholder[-_])?m(?:668|681)\b/.test(probeLower)) {
        tier = 'argon';
        tierLabel = 'Orchestrator (Argon)';
      }
      return {
        modelKey: 'orchestrator',
        modelLabel: 'Orchestrator',
        variantKey: tier ? `orchestrator:${tier}` : 'orchestrator',
        variantLabel: tierLabel || 'Orchestrator',
        isAttributed: true
      };
    }

    let modelKey = (effectiveLabel ? normalizeModelId(effectiveLabel) : null) || normalizeModelId(rawStr) || normalizeModelId(probeText);
    if (!modelKey && probeLower.includes('gpt-oss')) {
      modelKey = 'gpt-oss-120b';
    }
    const prod = groupModelProduct({
      modelId: resolvedStable || call.modelExactId || call.modelId || rawStr,
      label: effectiveLabel,
      effort: call.effort
    });
    if (!modelKey) {
      const slug = String(prod.productLabel || effectiveLabel || resolvedStable || rawStr)
        .toLowerCase()
        .replace(/^model_/, '')
        .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
      modelKey = slug || UNATTRIBUTED_MODEL_KEY;
    }
    if (modelKey === UNATTRIBUTED_MODEL_KEY) {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const modelLabel = MODEL_PRODUCT_DISPLAY_NAMES[modelKey] || prod.productLabel || modelKey;
    let effort = prod.effort || null;
    if (!effort) {
      const effProbe = `${effectiveLabel} ${rawStr} ${resolvedStable || ''}`;
      const mEff = effProbe.match(/[:\-_\s(（](x[-_]?high|extra[-_]?high|low|medium|high|minimal|max)[)）]?(?=$|\s)/i);
      if (mEff) effort = formatEffortLabel(mEff[1]);
    }
    const variantKey = effort ? `${modelKey}:${effort.toLowerCase().replace(/\s+/g, '')}` : modelKey;
    const variantLabel = effort ? `${modelLabel} (${effort})` : modelLabel;
    return {
      modelKey,
      modelLabel,
      variantKey,
      variantLabel,
      isAttributed: true
    };
  }

  function shiftIsoDateDays(dateStr, deltaDays) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseHexRgb(hexStr) {
    const clean = String(hexStr || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
    const n = parseInt(clean, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function shiftHexShade(hexStr, amount) {
    const rgb = parseHexRgb(hexStr);
    if (!rgb) return hexStr;
    const amt = Math.max(-0.6, Math.min(0.6, Number(amount) || 0));
    const mix = (ch) => amt >= 0
      ? Math.round(ch + (255 - ch) * amt)
      : Math.round(ch * (1 + amt));
    const to2 = v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    return `#${to2(mix(rgb.r))}${to2(mix(rgb.g))}${to2(mix(rgb.b))}`;
  }

  function resolveBaseModelColor(baseKey, rankIdx = 0, options = {}) {
    const isLight = options.theme === 'light';
    const fixedTable = isLight ? MODEL_FIXED_COLORS_LIGHT : MODEL_FIXED_COLORS_DARK;
    const palette = isLight ? MODEL_FALLBACK_PALETTE_LIGHT : MODEL_FALLBACK_PALETTE_DARK;
    const accentHex = parseHexRgb(options.accentColor) ? String(options.accentColor).trim() : null;

    if (baseKey === 'gemini-4-hydrogen' && accentHex) {
      return accentHex;
    }
    if (fixedTable[baseKey]) return fixedTable[baseKey];
    if (baseKey.startsWith('claude-')) {
      return baseKey.includes('sonnet') ? fixedTable['claude-sonnet-5-5'] : fixedTable['claude-opus-5-5'];
    }
    if (baseKey.includes('gpt')) return fixedTable['gpt-oss-120b'];
    if (baseKey.includes('flash')) return fixedTable['gemini-3.8-flash'];
    if (baseKey.includes('argon')) return fixedTable['gemini-4-argon'];
    if (baseKey.includes('carbon')) return fixedTable['gemini-4-carbon'];
    if (baseKey.includes('orchestrator')) return fixedTable['orchestrator'];
    if (baseKey.includes('hydrogen')) return accentHex || fixedTable['gemini-4-hydrogen'];
    let hash = 0;
    for (let i = 0; i < baseKey.length; i++) {
      hash = (hash * 31 + baseKey.charCodeAt(i)) >>> 0;
    }
    return palette[(rankIdx + hash) % palette.length];
  }

  function getModelChartColor(key, rankIdx = 0, options = {}) {
    const isLight = options.theme === 'light';
    const fixedTable = isLight ? MODEL_FIXED_COLORS_LIGHT : MODEL_FIXED_COLORS_DARK;
    if (key === UNATTRIBUTED_MODEL_KEY) return fixedTable[UNATTRIBUTED_MODEL_KEY];

    const parts = String(key || '').split(':');
    const baseKey = parts[0] || String(key || '');
    const effortPart = (parts[1] || '').toLowerCase();
    const baseColor = resolveBaseModelColor(baseKey, rankIdx, options);

    if (!effortPart) return baseColor;
    // 同模型家族内按档位或特殊角色（如 Orchestrator）做同色系明度阶梯区分
    const shadeOffsetByEffort = isLight
      ? { xhigh: -0.24, extrahigh: -0.24, max: -0.24, orchestrator: -0.14, carbon: -0.14, high: -0.05, medium: 0.16, argon: 0.16, low: 0.34, minimal: 0.42 }
      : { xhigh: -0.22, extrahigh: -0.22, max: -0.22, orchestrator: -0.12, carbon: -0.14, high: -0.04, medium: 0.18, argon: 0.16, low: 0.34, minimal: 0.42 };
    const offset = shadeOffsetByEffort[effortPart];
    return offset !== undefined ? shiftHexShade(baseColor, offset) : baseColor;
  }

  /**
   * 按指定天窗 (7d/30d) 与分组粒度汇总按日按模型 Token 分布与图例占比
   */
  function summarizeModelUsageWindow(dailyModelMap = {}, options = {}) {
    const periodDays = Number(options.periodDays) === 30 ? 30 : 7;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.endDate || ''))
      ? String(options.endDate)
      : formatLocalDateKeyCompat(new Date());
    const startDate = shiftIsoDateDays(endDate, -(periodDays - 1));
    const groupBy = options.groupBy === 'variant' ? 'variant' : 'model';
    const metric = options.metric === 'noCache' ? 'noCache' : 'total';
    const hideUnattributed = Boolean(options.hideUnattributed);
    const metaMap = (options.modelMetaByKey && typeof options.modelMetaByKey === 'object') ? options.modelMetaByKey : {};

    const resolveMetricVal = (rec) => {
      if (!rec) return 0;
      const inp = Number(rec.input) || 0;
      const out = Number(rec.output) || 0;
      const cac = Number(rec.cache) || 0;
      const tot = Number(rec.total) || (inp + out + cac);
      return metric === 'noCache' ? Math.max(0, inp + out) : Math.max(0, tot);
    };

    const windowTotalsByGroup = new Map();
    const dayBucketsList = [];
    let unattributedTokens = 0;
    let windowTotalTokens = 0;
    let windowTotalSteps = 0;

    for (let i = 0; i < periodDays; i++) {
      const dStr = shiftIsoDateDays(startDate, i);
      const dayRaw = (dailyModelMap && dailyModelMap[dStr] && typeof dailyModelMap[dStr] === 'object') ? dailyModelMap[dStr] : {};
      const dayGrouped = new Map();
      let dayTotal = 0;

      for (const [rawKey, rec] of Object.entries(dayRaw)) {
        if (!rec || typeof rec !== 'object') continue;
        const val = resolveMetricVal(rec);
        const inp = Number(rec.input) || 0;
        const out = Number(rec.output) || 0;
        const cac = Number(rec.cache) || 0;
        const steps = Number(rec.steps) || 0;
        if (val <= 0 && steps <= 0) continue;

        const isUnattr = rawKey === UNATTRIBUTED_MODEL_KEY;
        if (isUnattr) unattributedTokens += val;
        if (isUnattr && hideUnattributed) continue;

        const meta = metaMap[rawKey] || null;
        let gKey = rawKey;
        let gLabel = rawKey;
        if (isUnattr) {
          gKey = UNATTRIBUTED_MODEL_KEY;
          gLabel = options.unattributedLabel || '未标明模型';
        } else if (groupBy === 'model') {
          gKey = meta?.modelKey || rawKey.split(':')[0] || rawKey;
          gLabel = meta?.modelLabel || MODEL_PRODUCT_DISPLAY_NAMES[gKey] || gKey;
        } else {
          gKey = rawKey;
          gLabel = meta?.variantLabel || meta?.modelLabel || rawKey;
        }

        const prevDay = dayGrouped.get(gKey) || { key: gKey, label: gLabel, tokens: 0, input: 0, output: 0, cache: 0, steps: 0 };
        prevDay.tokens += val;
        prevDay.input += inp;
        prevDay.output += out;
        prevDay.cache += cac;
        prevDay.steps += steps;
        dayGrouped.set(gKey, prevDay);
        dayTotal += val;

        const prevWin = windowTotalsByGroup.get(gKey) || { key: gKey, label: gLabel, tokens: 0, input: 0, output: 0, cache: 0, steps: 0 };
        prevWin.tokens += val;
        prevWin.input += inp;
        prevWin.output += out;
        prevWin.cache += cac;
        prevWin.steps += steps;
        windowTotalsByGroup.set(gKey, prevWin);
        windowTotalTokens += val;
        windowTotalSteps += steps;
      }

      dayBucketsList.push({ date: dStr, total: dayTotal, grouped: dayGrouped });
    }

    // 排序：已标明模型按窗口总用量降序，未标明模型固定置底
    const sortedWin = Array.from(windowTotalsByGroup.values()).sort((a, b) => {
      if (a.key === UNATTRIBUTED_MODEL_KEY && b.key !== UNATTRIBUTED_MODEL_KEY) return 1;
      if (b.key === UNATTRIBUTED_MODEL_KEY && a.key !== UNATTRIBUTED_MODEL_KEY) return -1;
      return b.tokens - a.tokens || a.label.localeCompare(b.label);
    });

    const colorByKey = new Map();
    const orderByKey = new Map();
    const usedColors = new Set();
    const themeOpt = options.theme === 'light' ? 'light' : 'dark';
    const fallbackPalette = themeOpt === 'light' ? MODEL_FALLBACK_PALETTE_LIGHT : MODEL_FALLBACK_PALETTE_DARK;
    const colorOpts = { theme: themeOpt, accentColor: options.accentColor || null };
    sortedWin.forEach((item, idx) => {
      orderByKey.set(item.key, idx);
      let color = getModelChartColor(item.key, idx, colorOpts);
      if (item.key !== UNATTRIBUTED_MODEL_KEY && usedColors.has(color)) {
        const isVariant = item.key.includes(':');
        if (isVariant) {
          color = shiftHexShade(color, themeOpt === 'light' ? 0.12 : -0.12);
        }
        if (usedColors.has(color)) {
          const alt = fallbackPalette.find(c => !usedColors.has(c));
          if (alt) color = alt;
        }
      }
      usedColors.add(color);
      colorByKey.set(item.key, color);
    });

    const formatPctLabel = (pct) => {
      if (pct <= 0) return '0%';
      if (pct < 0.1) return '<0.1%';
      const rounded = Math.round(pct * 10) / 10;
      return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
    };

    const legend = sortedWin.map(item => {
      const pct = windowTotalTokens > 0 ? (item.tokens / windowTotalTokens) * 100 : 0;
      const cacheStats = computeCacheReadStats({
        inputTokens: item.input,
        cacheReadTokens: item.cache,
        outputTokens: item.output,
        hasInputCacheFields: (item.input > 0 || item.cache > 0 || item.output > 0)
      });
      return {
        ...item,
        color: colorByKey.get(item.key) || '#71717a',
        pct,
        pctLabel: formatPctLabel(pct),
        cacheReadPct: cacheStats.cacheReadPct,
        cacheStatus: cacheStats.cacheStatus
      };
    });

    let maxDayTotal = 0;
    const days = dayBucketsList.map(d => {
      if (d.total > maxDayTotal) maxDayTotal = d.total;
      const segs = Array.from(d.grouped.values())
        .filter(s => s.tokens > 0)
        .sort((a, b) => (orderByKey.get(a.key) ?? 999) - (orderByKey.get(b.key) ?? 999))
        .map(s => {
          const segCache = computeCacheReadStats({
            inputTokens: s.input,
            cacheReadTokens: s.cache,
            outputTokens: s.output,
            hasInputCacheFields: (s.input > 0 || s.cache > 0 || s.output > 0)
          });
          return {
            ...s,
            color: colorByKey.get(s.key) || '#71717a',
            pct: d.total > 0 ? (s.tokens / d.total) * 100 : 0,
            cacheReadPct: segCache.cacheReadPct
          };
        });
      return {
        date: d.date,
        total: d.total,
        segments: segs
      };
    });

    return {
      periodDays,
      startDate,
      endDate,
      groupBy,
      metric,
      hideUnattributed,
      days,
      legend,
      maxDayTotal,
      windowTotalTokens,
      windowTotalSteps,
      hasUnattributed: unattributedTokens > 0,
      unattributedTokens
    };
  }

  function formatLocalDateKeyCompat(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  /**
   * 规范化单次调用或汇总对象的输入、缓存读取与输出 Token。
   * 已通过本地 transcript.jsonl、chatModel.usage 与 pricing_ledger 实测验证：
   * Antigravity 默认将 inputTokens/input_tokens 记为非缓存新增输入，cacheReadTokens/cache_read_tokens 记为缓存读取，
   * 二者为互斥分项，规范总输入 = uncachedInput + cacheRead。
   * 仅当显式标记 inputIncludesCache === true 时才从中扣除 cacheRead，避免重复计数。
   */
  function normalizeCallInputCacheTokens(rec) {
    if (!rec || typeof rec !== 'object') {
      return {
        hasInputCacheFields: false,
        uncachedInput: null,
        cacheRead: null,
        totalInput: null,
        output: null,
        totalTokens: null
      };
    }

    const rawInp = rec.inputTokens ?? rec.input_tokens ?? rec.input;
    const rawCap = rec.cacheReadTokens ?? rec.cacheTokens ?? rec.cache_read_tokens ?? rec.cached ?? rec.cache;
    const rawOut = rec.outputTokens ?? rec.output_tokens ?? rec.output;
    const explicitMissing = rec.hasInputCacheFields === false;

    const hasInp = !explicitMissing && rawInp !== undefined && rawInp !== null && Number.isFinite(Number(rawInp));
    const hasCap = !explicitMissing && rawCap !== undefined && rawCap !== null && Number.isFinite(Number(rawCap));
    const hasOut = rawOut !== undefined && rawOut !== null && Number.isFinite(Number(rawOut));

    // 当记录完全没有任何输入或缓存字段时，绝不将缺失伪造为 0
    if (!hasInp && !hasCap) {
      const rawTot = rec.totalTokens ?? rec.total;
      const totVal = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) ? Math.max(0, Number(rawTot)) : null;
      return {
        hasInputCacheFields: false,
        uncachedInput: null,
        cacheRead: null,
        totalInput: null,
        output: hasOut ? Math.max(0, Number(rawOut)) : null,
        totalTokens: totVal
      };
    }

    // Proto3 JSON 序列化会省略 0 值字段：当至少一个输入/缓存字段存在时，另一被省略字段按 0 处理
    const inpVal = hasInp ? Math.max(0, Number(rawInp)) : 0;
    const capVal = hasCap ? Math.max(0, Number(rawCap)) : 0;
    const outVal = hasOut ? Math.max(0, Number(rawOut)) : 0;

    let uncachedInput;
    let totalInput;
    if (rec.inputIncludesCache === true) {
      totalInput = Math.max(inpVal, capVal);
      uncachedInput = Math.max(0, totalInput - capVal);
    } else {
      uncachedInput = inpVal;
      totalInput = inpVal + capVal;
    }

    const rawTot = rec.totalTokens ?? rec.total;
    const computedTot = totalInput + outVal;
    const totalTokens = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) && Number(rawTot) > 0
      ? Math.max(Number(rawTot), computedTot)
      : computedTot;

    return {
      hasInputCacheFields: true,
      uncachedInput,
      cacheRead: capVal,
      totalInput,
      output: hasOut ? outVal : null,
      totalTokens
    };
  }

  /**
   * 计算单条调用或桶记录的缓存读取占比。
   * 缺失字段与分母为 0 时 cacheReadRatio / cacheReadPct 均返回 null，不伪造 0%。
   */
  function computeCacheReadStats(rec) {
    const norm = normalizeCallInputCacheTokens(rec);
    if (!norm.hasInputCacheFields || norm.totalInput === null || norm.cacheRead === null) {
      return {
        ...norm,
        cacheReadRatio: null,
        cacheReadPct: null,
        cacheStatus: 'missing'
      };
    }
    if (norm.totalInput <= 0) {
      return {
        ...norm,
        cacheReadRatio: null,
        cacheReadPct: null,
        cacheStatus: 'zero_input'
      };
    }
    const ratio = Math.max(0, Math.min(1, norm.cacheRead / norm.totalInput));
    const pct = Number((ratio * 100).toFixed(1));
    return {
      ...norm,
      cacheReadRatio: ratio,
      cacheReadPct: pct,
      cacheStatus: norm.cacheRead > 0 ? 'hit' : 'zero_cache'
    };
  }

  /**
   * 按可靠分母总量加权汇总缓存读取占比与请求缓存命中占比。
   * - cacheReadPct：sum(cacheRead) / sum(totalInput)，绝不直接平均每条百分比。
   * - requestHitPct：命中缓存请求数 / 可评估请求数（仅当分母 > 0 时有效）。
   */
  function summarizeCacheReadStats(records = []) {
    const list = Array.isArray(records) ? records : [];
    let totalUncachedInput = 0;
    let totalCacheRead = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let evaluatedRequestCount = 0;
    let cacheHitRequestCount = 0;
    let missingCount = 0;
    let zeroInputCount = 0;

    for (const r of list) {
      const st = computeCacheReadStats(r);
      if (st.output !== null) totalOutput += st.output;
      if (st.cacheStatus === 'missing') {
        missingCount++;
        continue;
      }
      if (st.cacheStatus === 'zero_input') {
        zeroInputCount++;
        continue;
      }
      evaluatedRequestCount++;
      totalUncachedInput += st.uncachedInput;
      totalCacheRead += st.cacheRead;
      totalInput += st.totalInput;
      if (st.cacheStatus === 'hit') {
        cacheHitRequestCount++;
      }
    }

    const cacheReadRatio = totalInput > 0 ? Math.max(0, Math.min(1, totalCacheRead / totalInput)) : null;
    const cacheReadPct = cacheReadRatio !== null ? Number((cacheReadRatio * 100).toFixed(1)) : null;
    const requestHitRatio = evaluatedRequestCount > 0 ? cacheHitRequestCount / evaluatedRequestCount : null;
    const requestHitPct = requestHitRatio !== null ? Number((requestHitRatio * 100).toFixed(1)) : null;
    const cacheStatus = totalInput > 0
      ? (totalCacheRead > 0 ? 'hit' : 'zero_cache')
      : (missingCount > 0 && zeroInputCount === 0 ? 'missing' : (zeroInputCount > 0 ? 'zero_input' : 'missing'));

    return {
      totalUncachedInput,
      totalCacheRead,
      totalInput,
      totalOutput,
      cacheReadRatio,
      cacheReadPct,
      cacheStatus,
      evaluatedRequestCount,
      cacheHitRequestCount,
      requestHitRatio,
      requestHitPct,
      missingCount,
      zeroInputCount
    };
  }

  /**
   * 按日汇总 Map 计算缓存读取占比（复用同一加权口径，历史无细分记录不计入分母）
   * @param {Object} dailyMap
   * @param {string} [datePrefix=''] - 日期前缀过滤（如 '2026-11'）
   */
  function summarizeDailyMapCacheStats(dailyMap = {}, datePrefix = '') {
    if (!dailyMap || typeof dailyMap !== 'object') {
      return summarizeCacheReadStats([]);
    }
    const items = [];
    for (const [k, rec] of Object.entries(dailyMap)) {
      if (datePrefix && !String(k).startsWith(datePrefix)) continue;
      if (!rec || typeof rec !== 'object') continue;
      const inp = Number(rec.input || 0);
      const cap = Number(rec.cache || 0);
      const out = Number(rec.output || 0);
      const tot = Number(rec.total || 0);
      const hasSplit = inp > 0 || cap > 0 || (tot > 0 && inp + cap + out === tot);
      items.push(hasSplit
        ? { inputTokens: inp, cacheReadTokens: cap, outputTokens: out, totalTokens: tot, hasInputCacheFields: true }
        : { totalTokens: tot, hasInputCacheFields: false }
      );
    }
    return summarizeCacheReadStats(items);
  }

  /**
   * 规范化单条会话调用记录（供最新调用卡片、轮次时间线与缓存统计统一复用）。
   */
  function normalizeSessionCallRecord(raw, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
    const callId = String(raw.callId || extractCallId(raw, raw.cascadeId || options.cascadeId || null, raw.stepIndex ?? null) || '').trim();
    if (!callId) return null;

    const availableModels = options.availableModels || options.userStatus?.availableModels || null;
    const phInfo = resolvePlaceholderModelInfo(raw, cascadeConfigs, availableModels);
    const bucket = resolveModelUsageBucket(raw, cascadeConfigs);
    const modelExactId = raw.modelExactId || resolveStableModelId(raw, cascadeConfigs) || null;
    const rawCandidateLabel = raw.modelLabel
      || phInfo.displayName
      || bucket.modelLabel
      || (raw.model && !/^model_/i.test(String(raw.model)) ? String(raw.model) : null)
      || (phInfo.isPlaceholder && !phInfo.isMapped ? null : modelExactId);
    const effortCandidate = raw.effort || phInfo.effort || (bucket.variantKey && bucket.variantKey.includes(':') ? bucket.variantKey.split(':')[1] : null);
    const splitDisp = splitModelDisplayAndEffort(rawCandidateLabel, effortCandidate);
    const modelLabel = (phInfo.isPlaceholder && !phInfo.isMapped)
      ? null
      : (splitDisp.baseLabel || bucket.modelLabel || modelExactId || null);
    const effort = splitDisp.effort ? formatEffortLabel(splitDisp.effort) : null;
    const cacheStats = computeCacheReadStats(raw);

    const rawError = String(raw.error || '').trim();
    const errorClassification = raw.errorClassification || (rawError
      ? classifyRequestError(rawError, {
        currentModel: modelLabel || raw.model || '',
        cascadeModelConfigs: cascadeConfigs,
        userStatus: options.userStatus || null
      })
      : null);

    let outcomeStatus = raw.outcomeStatus || (raw.status === 'streaming' ? 'streaming' : 'success');
    if (rawError && (!raw.outcomeStatus || raw.outcomeStatus === 'success')) {
      const k = errorClassification?.kind || 'failed';
      outcomeStatus = k === 'context_overflow' ? 'exceeded' : (k === 'network_error' ? 'network' : (k === 'unknown' || k === 'none' ? 'failed' : k));
    }

    const ttftSec = raw.ttftSec !== undefined && raw.ttftSec !== null && Number.isFinite(Number(raw.ttftSec))
      ? Number(Number(raw.ttftSec).toFixed(2))
      : null;
    const streamingSec = raw.streamingSec !== undefined && raw.streamingSec !== null && Number.isFinite(Number(raw.streamingSec))
      ? Number(Number(raw.streamingSec).toFixed(2))
      : null;
    let durationSec = raw.durationSec !== undefined && raw.durationSec !== null && Number.isFinite(Number(raw.durationSec))
      ? Number(Number(raw.durationSec).toFixed(2))
      : null;
    if (durationSec === null && (ttftSec !== null || streamingSec !== null)) {
      durationSec = Number(((ttftSec || 0) + (streamingSec || 0)).toFixed(2));
    }
    const outNum = cacheStats.output ?? 0;
    let tps = raw.tps !== undefined && raw.tps !== null && Number.isFinite(Number(raw.tps)) && Number(raw.tps) > 0
      ? Number(Number(raw.tps).toFixed(1))
      : null;
    if (tps === null && outNum > 0 && durationSec !== null && durationSec > 0) {
      tps = Number((outNum / durationSec).toFixed(1));
    }
    let streamingTps = raw.streamingTps !== undefined && raw.streamingTps !== null && Number.isFinite(Number(raw.streamingTps)) && Number(raw.streamingTps) > 0
      ? Number(Number(raw.streamingTps).toFixed(1))
      : null;
    if (streamingTps === null && outNum > 0 && streamingSec !== null && streamingSec > 0.05) {
      streamingTps = Number((outNum / streamingSec).toFixed(1));
    }

    let ts = Number(raw.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
      ts = raw.created_at ? Date.parse(raw.created_at) : NaN;
    }
    if (!Number.isFinite(ts) || ts <= 0) ts = null;

    const rawStep = raw.stepIndex ?? raw.step_index;
    const stepIndex = rawStep !== undefined && rawStep !== null && rawStep !== '' && Number.isInteger(Number(rawStep)) && Number(rawStep) >= 0
      ? Number(rawStep)
      : null;

    const thinkingTokens = raw.thinkingTokens !== undefined && raw.thinkingTokens !== null && Number.isFinite(Number(raw.thinkingTokens))
      ? Math.max(0, Number(raw.thinkingTokens))
      : null;

    const agentRole = raw.agentRole === 'subagent' || Boolean(raw.parentCascadeId)
      ? 'subagent'
      : (raw.agentRole === 'unknown' ? 'unknown' : 'main');
    const hasSessionEvidence = Boolean(raw.cascadeId || options.cascadeId || raw.parentCascadeId);
    const attributionConfidence = raw.attributionConfidence || (
      agentRole === 'subagent'
        ? (raw.parentStepIndex != null ? 'verified_tool_output' : (raw.parentCascadeId ? 'verified_db_meta' : 'unidentified'))
        : ((agentRole === 'unknown' || !hasSessionEvidence) ? 'unidentified' : 'main')
    );

    const streamingTpsRounded = streamingTps;
    const expScore = raw.status === 'streaming'
      ? { available: false, score: null, grade: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      : calculateExperienceScore({
          outputTokens: cacheStats.output,
          totalInputTokens: cacheStats.totalInput,
          inputTokens: cacheStats.uncachedInput,
          ttftSec,
          streamingSec,
          totalDurationSec: durationSec,
          streamSpeed: streamingTpsRounded
        });
    const stabInfo = computeStreamStability({
      chunkCount: raw.chunkCount != null ? Number(raw.chunkCount) : (Array.isArray(raw.chunkTimestamps) ? raw.chunkTimestamps.length : null),
      chunkIntervalsMs: Array.isArray(raw.chunkIntervalsMs) ? raw.chunkIntervalsMs : null,
      intervalCv: raw.intervalCv,
      streamingSec
    });
    const ttftRatioPct = (ttftSec !== null && durationSec !== null && durationSec > 0)
      ? Number(Math.min(100, Math.max(0, (ttftSec / durationSec) * 100)).toFixed(1))
      : null;

    return {
      callId,
      cascadeId: raw.cascadeId || options.cascadeId || null,
      parentCascadeId: raw.parentCascadeId || null,
      rootCascadeId: raw.rootCascadeId || null,
      parentStepIndex: raw.parentStepIndex !== undefined && raw.parentStepIndex !== null ? Number(raw.parentStepIndex) : null,
      agentRole,
      subagentType: raw.subagentType || null,
      subagentRole: raw.subagentRole || null,
      attributionConfidence,
      source: raw.source || 'desktop',
      stepIndex,
      model: raw.model || modelLabel || phInfo.rawPlaceholderId || modelExactId || '',
      modelKey: raw.modelKey || (bucket.isAttributed ? bucket.modelKey : null),
      rawModelId: raw.rawModelId || phInfo.rawId || null,
      rawPlaceholderId: raw.rawPlaceholderId || phInfo.rawPlaceholderId || null,
      stableModelId: raw.stableModelId || phInfo.stableModelId || null,
      isPlaceholderOnly: Boolean(raw.isPlaceholderOnly ?? (phInfo.isPlaceholder && !phInfo.isMapped)),
      isRoutedModelVerified: Boolean(raw.isRoutedModelVerified ?? phInfo.isRoutedModelVerified),
      modelMappingSource: raw.modelMappingSource || phInfo.mappingSource,
      modelExactId,
      modelLabel,
      effort,
      inputTokens: cacheStats.uncachedInput,
      cacheReadTokens: cacheStats.cacheRead,
      totalInputTokens: cacheStats.totalInput,
      outputTokens: cacheStats.output,
      thinkingTokens,
      totalTokens: cacheStats.totalTokens,
      hasInputCacheFields: cacheStats.hasInputCacheFields,
      cacheReadRatio: cacheStats.cacheReadRatio,
      cacheReadPct: cacheStats.cacheReadPct,
      cacheStatus: cacheStats.cacheStatus,
      ttftSec,
      streamingSec,
      durationSec,
      ttftRatioPct,
      tps,
      streamingTps,
      streamSpeed: streamingTps,
      chunkCount: stabInfo.chunks,
      chunkIntervalsMs: Array.isArray(raw.chunkIntervalsMs) ? raw.chunkIntervalsMs : null,
      intervalCv: stabInfo.intervalCv,
      isStableStream: stabInfo.isStable,
      scoreRuleVersion: expScore.ruleVersion || ELV91_SCORE_RULE_VERSION,
      eScore: raw.eScore !== undefined ? raw.eScore : expScore.score,
      eGrade: raw.eGrade !== undefined ? raw.eGrade : expScore.grade,
      status: raw.status === 'streaming' ? 'streaming' : 'final',
      outcomeStatus,
      ...(rawError ? { error: rawError, errorClassification } : {}),
      isEstimated: Boolean(raw.isEstimated),
      date: raw.date || (ts ? formatLocalDateKeyCompat(new Date(ts)) : null),
      dateIsProvisional: Boolean(raw.dateIsProvisional),
      created_at: raw.created_at || null,
      timestamp: ts
    };
  }

  /**
   * 清洗对话轮次标题预览中的 XML/系统包装标签（如 <USER_REQUEST>、<ADDITIONAL_METADATA>），
   * 仅作用于前端展示预览，不改动任何底层原始记录。
   */
  function sanitizeTurnPreviewText(rawText, maxLen = 120) {
    if (rawText == null) return '';
    let text = String(rawText);
    // 兼容 HTML 转义形式并移除成对及截断残留的系统元信息块
    text = text.replace(/&lt;\s*(\/?)\s*(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^&]*&gt;/gi, '<$1$2>');
    text = text.replace(/<\s*(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
    text = text.replace(/<\s*(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>[\s\S]*$/gi, ' ');
    text = text.replace(/<\s*\/?\s*(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>/gi, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 120;
    return text.slice(0, limit);
  }

  /**
   * 按用户轮次（Turn）将当前会话主代理调用与可验证的子代理调用分组汇总。
   * 绝不凭时间接近猜测父子归属：未关联到父步骤的子代理调用放入独立 unlinkedSubagentCalls 列表。
   */
  function groupSessionCallsByTurns(turnMarkers = [], calls = [], options = {}) {
    const cascadeId = options.cascadeId || null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

    // 1. 归一化全部调用并按 callId 去重（保留信息更完整的一条）
    const dedupMap = new Map();
    for (const raw of (Array.isArray(calls) ? calls : [])) {
      const norm = normalizeSessionCallRecord(raw, { cascadeId, cascadeModelConfigs: cascadeConfigs, userStatus: options.userStatus });
      if (!norm) continue;
      const prev = dedupMap.get(norm.callId);
      if (!prev) {
        dedupMap.set(norm.callId, norm);
      } else {
        const prevTot = prev.totalTokens ?? -1;
        const nextTot = norm.totalTokens ?? -1;
        const preferNext = (prev.status === 'streaming' && norm.status === 'final')
          || nextTot > prevTot
          || (nextTot === prevTot && !prev.modelExactId && Boolean(norm.modelExactId))
          || (nextTot === prevTot && prev.durationSec === null && norm.durationSec !== null);
        if (preferNext) {
          dedupMap.set(norm.callId, {
            ...prev,
            ...norm,
            modelExactId: norm.modelExactId || prev.modelExactId,
            modelLabel: norm.modelLabel || prev.modelLabel,
            effort: norm.effort || prev.effort,
            ttftSec: norm.ttftSec ?? prev.ttftSec,
            streamingSec: norm.streamingSec ?? prev.streamingSec,
            durationSec: norm.durationSec ?? prev.durationSec,
            tps: norm.tps ?? prev.tps,
            streamingTps: norm.streamingTps ?? prev.streamingTps,
            parentCascadeId: norm.parentCascadeId || prev.parentCascadeId,
            parentStepIndex: norm.parentStepIndex ?? prev.parentStepIndex,
            subagentType: norm.subagentType || prev.subagentType,
            subagentRole: norm.subagentRole || prev.subagentRole,
            attributionConfidence: norm.parentStepIndex != null ? norm.attributionConfidence : prev.attributionConfidence
          });
        }
      }
    }

    const allCalls = Array.from(dedupMap.values());
    allCalls.sort((a, b) => {
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      if (tsA !== tsB) return tsA - tsB;
      const sa = a.stepIndex ?? Number.MAX_SAFE_INTEGER;
      const sb = b.stepIndex ?? Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });

    // 2. 构建规范化用户轮次边界（按 stepIndex 升序）
    const sortedTurns = (Array.isArray(turnMarkers) ? turnMarkers : [])
      .filter(t => t && (Number.isInteger(Number(t.stepIndex)) || t.timestamp || t.created_at))
      .map((t, idx) => {
        const stepIdx = Number.isInteger(Number(t.stepIndex)) ? Number(t.stepIndex) : null;
        const ts = Number(t.timestamp) || (t.created_at ? Date.parse(t.created_at) : NaN);
        return {
          turnIndex: idx + 1,
          stepIndex: stepIdx,
          timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
          created_at: t.created_at || null,
          source: t.source || 'USER_EXPLICIT',
          preview: t.preview ? sanitizeTurnPreviewText(t.preview, 120) : ''
        };
      })
      .sort((a, b) => {
        if (a.stepIndex !== null && b.stepIndex !== null && a.stepIndex !== b.stepIndex) {
          return a.stepIndex - b.stepIndex;
        }
        return (a.timestamp || 0) - (b.timestamp || 0);
      })
      .map((t, idx) => ({ ...t, turnIndex: idx + 1 }));

    const buckets = sortedTurns.map(t => ({
      ...t,
      calls: [],
      isImplicitInitial: false
    }));
    const preTurnCalls = [];
    const unlinkedSubagentCalls = [];

    const findTurnByStep = (stepIdx) => {
      if (stepIdx === null || stepIdx === undefined || !buckets.length) return -1;
      let matchedIdx = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].stepIndex !== null && buckets[i].stepIndex <= stepIdx) {
          matchedIdx = i;
        }
      }
      return matchedIdx;
    };

    const findTurnByTimestamp = (ts) => {
      if (!ts || !buckets.length) return -1;
      let matchedIdx = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].timestamp && buckets[i].timestamp <= ts + 2000) {
          matchedIdx = i;
        }
      }
      return matchedIdx;
    };

    for (const c of allCalls) {
      if (c.agentRole === 'subagent') {
        if (c.parentStepIndex !== null && c.parentStepIndex !== undefined) {
          const tIdx = findTurnByStep(c.parentStepIndex);
          if (tIdx >= 0) {
            buckets[tIdx].calls.push(c);
            continue;
          }
        }
        unlinkedSubagentCalls.push(c);
        continue;
      }

      // 主代理调用：严格优先按 stepIndex 定位轮次
      let targetIdx = -1;
      if (c.stepIndex !== null && (!cascadeId || !c.cascadeId || String(c.cascadeId).toLowerCase() === String(cascadeId).toLowerCase())) {
        targetIdx = findTurnByStep(c.stepIndex);
      } else if (c.timestamp && !c.dateIsProvisional) {
        targetIdx = findTurnByTimestamp(c.timestamp);
      }
      if (targetIdx >= 0) {
        buckets[targetIdx].calls.push(c);
      } else {
        preTurnCalls.push(c);
      }
    }

    const finalizeTurnBucket = (b) => {
      const cacheSummary = summarizeCacheReadStats(b.calls);
      let mainCallCount = 0;
      let subagentCallCount = 0;
      let errorCount = 0;
      let totalTokens = 0;
      let hasTotalTokens = false;
      let latestTimestamp = b.timestamp || null;
      for (const c of b.calls) {
        if (c.agentRole === 'subagent') subagentCallCount++;
        else mainCallCount++;
        if (c.outcomeStatus && c.outcomeStatus !== 'success' && c.outcomeStatus !== 'streaming') {
          errorCount++;
        }
        if (c.totalTokens !== null && c.totalTokens !== undefined) {
          totalTokens += c.totalTokens;
          hasTotalTokens = true;
        }
        if (c.timestamp && (!latestTimestamp || c.timestamp > latestTimestamp)) {
          latestTimestamp = c.timestamp;
        }
      }
      return {
        turnIndex: b.turnIndex,
        stepIndex: b.stepIndex,
        timestamp: b.timestamp,
        created_at: b.created_at,
        latestTimestamp,
        preview: b.preview || '',
        isImplicitInitial: Boolean(b.isImplicitInitial),
        callCount: b.calls.length,
        mainCallCount,
        subagentCallCount,
        errorCount,
        inputTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalUncachedInput : null,
        cacheReadTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalCacheRead : null,
        totalInputTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalInput : null,
        outputTokens: b.calls.some(c => c.outputTokens !== null) ? cacheSummary.totalOutput : null,
        totalTokens: hasTotalTokens ? totalTokens : null,
        cacheReadRatio: cacheSummary.cacheReadRatio,
        cacheReadPct: cacheSummary.cacheReadPct,
        cacheStatus: cacheSummary.cacheStatus,
        calls: b.calls
      };
    };

    const resultTurns = [];
    if (preTurnCalls.length > 0) {
      resultTurns.push(finalizeTurnBucket({
        turnIndex: 0,
        stepIndex: 0,
        timestamp: preTurnCalls[0]?.timestamp || null,
        created_at: preTurnCalls[0]?.created_at || null,
        preview: '',
        isImplicitInitial: true,
        calls: preTurnCalls
      }));
    }
    for (const b of buckets) {
      resultTurns.push(finalizeTurnBucket(b));
    }

    const overallCacheSummary = summarizeCacheReadStats(allCalls);
    return {
      cascadeId,
      turns: resultTurns,
      unlinkedSubagentCalls,
      totalCalls: allCalls.length,
      mainCallsCount: allCalls.filter(c => c.agentRole !== 'subagent').length,
      subagentCallsCount: allCalls.filter(c => c.agentRole === 'subagent').length,
      cacheSummary: overallCacheSummary,
      latestCall: allCalls.length ? allCalls[allCalls.length - 1] : null
    };
  }

  // =========================================================================
  // ELV-91: 生成体验面板（纯流式速度 7 档 / TTFT 7 档 / 总耗时 7 档 / E 指数 6 档 / 三阶段）
  // 最高采用依据：ELV-91 维护者指定终极版与 Gemini 11 页会话最终决策（左闭右开区间）
  // =========================================================================

  const ELV91_SCORE_RULE_VERSION = 'elv91-v1';

  /**
   * 格式化人性化耗时（<60s 用秒；>=60s 进位分秒；>=3600s 进位时分）
   * 示例：138.65s -> 2 分 19 秒；4200s -> 1 小时 10 分；3599.6s -> 1 小时 0 分。
   */
  function formatHumanDuration(sec, lang = 'zh-CN') {
    if (sec === null || sec === undefined || sec === '') return '—';
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';
    if (n >= 3600) {
      const totalMin = Math.round(n / 60);
      const hrs = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      return isEn ? `${hrs}h ${mins}m` : (isTw ? `${hrs} 小時 ${mins} 分` : `${hrs} 小时 ${mins} 分`);
    }
    if (n >= 59.95) {
      const roundedSec = Math.round(n);
      if (roundedSec >= 3600) {
        const totalMin = Math.round(roundedSec / 60);
        const hrs = Math.floor(totalMin / 60);
        const mins = totalMin % 60;
        return isEn ? `${hrs}h ${mins}m` : (isTw ? `${hrs} 小時 ${mins} 分` : `${hrs} 小时 ${mins} 分`);
      }
      const mins = Math.floor(roundedSec / 60);
      const remSec = roundedSec % 60;
      return isEn ? `${mins}m ${remSec}s` : `${mins} 分 ${remSec} 秒`;
    }
    const fixedStr = n >= 10 ? n.toFixed(1) : n.toFixed(2);
    const trimmed = fixedStr.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    return `${trimmed}s`;
  }

  function pickI18nText(obj, lang) {
    if (!obj || typeof obj !== 'object') return String(obj || '');
    if (lang === 'en') return obj.en ?? obj['zh-CN'] ?? '';
    if (lang === 'zh-TW') return obj['zh-TW'] ?? obj['zh-CN'] ?? '';
    return obj['zh-CN'] ?? '';
  }

  const ELV91_STREAM_SPEED_TIERS = [
    {
      id: 'stalled',
      maxExclusive: 1,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '彻底停滞', 'zh-TW': '徹底停滯', en: 'Stalled' },
      comment: {
        'zh-CN': '按帧播放. 每秒连 1 个字都憋不出来. 别耽误干活了. 这边建议先去隔壁开个 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '逐幀播放. 每秒連 1 個字都憋不出來. 別耽誤工作了. 這邊建議先去隔壁開個 Claude、Codex 或豆包應急吧.',
        en: 'Frame-by-frame crawl (< 1 tok/s). Consider switching to Claude, Codex, or Doubao if urgent.'
      }
    },
    {
      id: 'crawling',
      maxExclusive: 10,
      color: '#EF4444',
      severity: 'danger',
      glyph: '!',
      title: { 'zh-CN': '濒临卡死', 'zh-TW': '瀕臨卡死', en: 'Near-Stall' },
      comment: {
        'zh-CN': '慢得批爆. 基本处于不可用状态. 一个字往外蹦看得人血压飙升.',
        'zh-TW': '慢得要命. 基本處於不可用狀態. 一個字往外蹦看得人血壓飆升.',
        en: 'Painfully slow trickle; virtually unusable for interactive reading.'
      }
    },
    {
      id: 'slow',
      maxExclusive: 30,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '⚡',
      title: { 'zh-CN': '慢于阅读', 'zh-TW': '慢於閱讀', en: 'Below Reading Pace' },
      comment: {
        'zh-CN': '挤牙膏中. 勉强能看但确实磨叽. 急性子可能有点难熬.',
        'zh-TW': '擠牙膏中. 勉強能看但確實磨蹭. 急性子可能有點難熬.',
        en: 'Squeezing out tokens slower than reading pace; long answers will test patience.'
      }
    },
    {
      id: 'smooth',
      maxExclusive: 80,
      color: '#10B981',
      severity: 'good',
      glyph: '⚡',
      title: { 'zh-CN': '流畅跟读', 'zh-TW': '流暢跟讀', en: 'Smooth Pace' },
      comment: {
        'zh-CN': '丝滑够用. 刚好跑赢你的眼睛. 属于比较舒服的节奏.',
        'zh-TW': '絲滑夠用. 剛好跑贏你的眼睛. 屬於比較舒服的節奏.',
        en: 'Silky and comfortable; easily keeps ahead of reading speed.'
      }
    },
    {
      id: 'fast',
      maxExclusive: 180,
      color: '#3B82F6',
      severity: 'fast',
      glyph: '⚡',
      title: { 'zh-CN': '高速输出', 'zh-TW': '高速輸出', en: 'High Throughput' },
      comment: {
        'zh-CN': '火力全开. 字数蹭蹭往上涨. 几乎不用干等.',
        'zh-TW': '火力全開. 字數飛快往上漲. 幾乎不用乾等.',
        en: 'Full throttle; output flies in with minimal waiting.'
      }
    },
    {
      id: 'rapid',
      maxExclusive: 300,
      color: '#06B6D4',
      severity: 'rapid',
      glyph: '⚡',
      title: { 'zh-CN': '疾速刷屏', 'zh-TW': '疾速刷屏', en: 'Blazing Stream' },
      comment: {
        'zh-CN': '手速冒烟. 屏幕直接刷出残影. 眼睛快跟不上了.',
        'zh-TW': '手速冒煙. 螢幕直接刷出殘影. 眼睛快跟不上了.',
        en: 'Screen-blurring token speed; faster than visual tracking.'
      }
    },
    {
      id: 'burst',
      maxExclusive: Infinity,
      color: '#8B5CF6',
      severity: 'epic',
      glyph: '⚡',
      title: { 'zh-CN': '瞬时爆发', 'zh-TW': '瞬時爆發', en: 'Instant Burst' },
      comment: {
        'zh-CN': '光速交卷. 刚回车就写完了. 甚至没看清过程.',
        'zh-TW': '光速交卷. 剛按完 Enter 就寫完了. 甚至沒看清過程.',
        en: 'Burst throughput (>= 300 tok/s); streaming finishes almost instantaneously.'
      }
    }
  ];

  const ELV91_TTFT_TIERS = [
    {
      id: 'instant',
      maxExclusive: 1,
      color: '#10B981',
      severity: 'good',
      glyph: '⚡',
      title: { 'zh-CN': '秒回响应', 'zh-TW': '秒回回應', en: 'Instant First Token' },
      comment: {
        'zh-CN': '几乎零延迟. 回车刚按下去就开始往外蹦字了.',
        'zh-TW': '幾乎零延遲. 剛送出就開始往外蹦字了.',
        en: 'Near-zero startup latency; tokens begin immediately.'
      }
    },
    {
      id: 'normal',
      maxExclusive: 10,
      color: '#10B981',
      severity: 'good',
      glyph: '⏳',
      title: { 'zh-CN': '正常等待', 'zh-TW': '正常等待', en: 'Normal Wait' },
      comment: {
        'zh-CN': '属于常规反应时间. 稍微喘口气就来了.',
        'zh-TW': '屬於常規反應時間. 稍微喘口氣就來了.',
        en: 'Standard startup latency; brief breath before output begins.'
      }
    },
    {
      id: 'thinking',
      maxExclusive: 30,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '⏳',
      title: { 'zh-CN': '思考较久', 'zh-TW': '思考較久', en: 'Extended Thinking' },
      comment: {
        'zh-CN': '正在酝酿情绪. 遇到长上下文或深度思考时挺常见的.',
        'zh-TW': '正在醞釀情緒. 遇到長上下文或深度思考時挺常見的.',
        en: 'Warming up; common with long context prefill or deep reasoning.'
      }
    },
    {
      id: 'sluggish',
      maxExclusive: 60,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '!',
      title: { 'zh-CN': '明显迟缓', 'zh-TW': '明顯遲緩', en: 'Noticeably Slow' },
      comment: {
        'zh-CN': '半分钟过去了还没动静. 手指已经开始忍不住想点取消了.',
        'zh-TW': '半分鐘過去了還沒動靜. 手指已經開始忍不住想點取消了.',
        en: 'Over 30 seconds without output; finger hovering over Cancel.'
      }
    },
    {
      id: 'agonizing',
      maxExclusive: 300,
      color: '#EF4444',
      severity: 'danger',
      glyph: '!',
      title: { 'zh-CN': '漫长煎熬', 'zh-TW': '漫長煎熬', en: 'Minute-Scale Wait' },
      comment: {
        'zh-CN': '等待时间正式跨入分钟级. 等得花都谢了. 别干盯着屏幕看了.',
        'zh-TW': '等待時間正式跨入分鐘級. 等得花都謝了. 別乾盯著螢幕看了.',
        en: 'Waiting has crossed into minutes; stop staring at the cursor.'
      }
    },
    {
      id: 'extreme',
      maxExclusive: 600,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '极度漫长', 'zh-TW': '極度漫長', en: 'Extreme Wait' },
      comment: {
        'zh-CN': '已经等了 {elapsed}. 进度条仿佛静止. 活还得干. 这边建议先去隔壁开个 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '已經等了 {elapsed}. 進度條彷彿靜止. 工作還得進行. 這邊建議先去隔壁開個 Claude、Codex 或豆包應急吧.',
        en: 'Waited {elapsed} with a frozen progress bar; consider switching to Claude, Codex, or Doubao if work cannot wait.'
      }
    },
    {
      id: 'century',
      maxExclusive: Infinity,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '世纪等待', 'zh-TW': '世紀等待', en: 'Over 10 Minutes' },
      comment: {
        'zh-CN': '突破十分钟大关. 已经分不清是在推理还是在挂机. 别耽误干活了. 赶紧去用 Claude、Codex 或豆包吧.',
        'zh-TW': '突破十分鐘大關. 已經分不清是在推理還是在掛機. 別耽誤工作了. 趕緊去用 Claude、Codex 或豆包吧.',
        en: 'Over 10 minutes without a first token; unclear if reasoning or idling. Consider using Claude, Codex, or Doubao.'
      }
    }
  ];

  const ELV91_DURATION_TIERS = [
    {
      id: 'flash',
      maxExclusive: 5,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': '瞬时完成', 'zh-TW': '瞬時完成', en: 'Instant Finish' },
      comment: {
        'zh-CN': '刚眨眼就搞定了. 适合轻量化问答或小片段补全.',
        'zh-TW': '剛眨眼就搞定了. 適合輕量化問答或小片段補全.',
        en: 'Finished in a blink; well-suited for quick Q&A or short edits.'
      }
    },
    {
      id: 'routine',
      maxExclusive: 30,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': '常规耗时', 'zh-TW': '常規耗時', en: 'Routine Turn' },
      comment: {
        'zh-CN': '喝口水的功夫. 日常写段代码或改个 Bug 的正常节奏.',
        'zh-TW': '喝口水的工夫. 日常寫段程式碼或修個 Bug 的正常節奏.',
        en: 'Time for a sip of water; normal cadence for daily coding or bug fixes.'
      }
    },
    {
      id: 'deep',
      maxExclusive: 120,
      color: '#3B82F6',
      severity: 'fast',
      title: { 'zh-CN': '深度处理', 'zh-TW': '深度處理', en: 'Deep Work' },
      comment: {
        'zh-CN': '开始动真格了. 通常是在做长文输出或复杂逻辑推理.',
        'zh-TW': '開始動真格了. 通常是在做長文輸出或複雜邏輯推理.',
        en: 'Substantial turn duration; typical of long outputs or multi-step reasoning.'
      }
    },
    {
      id: 'long_run',
      maxExclusive: 600,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': '长程运行', 'zh-TW': '長程運行', en: 'Long Run' },
      comment: {
        'zh-CN': '进入长线作战. 如果是大体量任务还算合理. 要是简单输出就有点磨叽了.',
        'zh-TW': '進入長線作戰. 如果是大體量任務還算合理. 要是簡單輸出就有點磨蹭了.',
        en: 'Multi-minute turn; reasonable for heavy tasks, sluggish if output was tiny.'
      }
    },
    {
      id: 'heavy',
      maxExclusive: 1800,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': '重度攻坚', 'zh-TW': '重度攻堅', en: 'Heavy Grind' },
      comment: {
        'zh-CN': '跑了十几分钟大工程. 希望最终产出对得起这度电和耐心.',
        'zh-TW': '跑了十幾分鐘大工程. 希望最終產出對得起這度電和耐心.',
        en: '10–30 minute marathon; hopefully the result justifies the patience.'
      }
    },
    {
      id: 'marathon',
      maxExclusive: 3600,
      color: '#EF4444',
      severity: 'danger',
      title: { 'zh-CN': '超长耐久', 'zh-TW': '超長耐久', en: 'Ultra-Long' },
      comment: {
        'zh-CN': '半小时起步的持久战. 这已经不是在聊天. 是在跑批处理任务了.',
        'zh-TW': '半小時起步的持久戰. 這已經不是在聊天. 是在跑批次處理任務了.',
        en: 'Over 30 minutes; feels more like a batch pipeline than chat.'
      }
    },
    {
      id: 'overtime',
      maxExclusive: Infinity,
      color: '#DC2626',
      severity: 'critical',
      title: { 'zh-CN': '跨时鏖战', 'zh-TW': '跨時鏖戰', en: 'Over an Hour' },
      comment: {
        'zh-CN': '干了一个多小时. 建议结合真实进度与产出检查是否出现无意义空转.',
        'zh-TW': '跑了一個多小時. 建議結合真實進度與產出檢查是否出現無意義空轉.',
        en: 'Exceeded 60 minutes; worth checking actual progress vs idle stalls.'
      }
    }
  ];

  const ELV91_EFFICIENCY_GRADES = [
    {
      grade: 'S',
      glyph: '★',
      minInclusive: 90,
      color: '#8B5CF6',
      severity: 'epic',
      title: { 'zh-CN': 'S 级 · 帕累托最优', 'zh-TW': 'S 級 · 柏拉圖最優', en: 'Grade S · Optimal' },
      comment: {
        'zh-CN': '响应、吞吐、体量全线拉满. 几乎零摩擦的高效生产力状态.',
        'zh-TW': '回應、吞吐、體量全線拉滿. 幾乎零摩擦的高效生產力狀態.',
        en: 'Top response speed, throughput, and scale efficiency with minimal friction.'
      }
    },
    {
      grade: 'A',
      glyph: '⚡',
      minInclusive: 75,
      color: '#3B82F6',
      severity: 'fast',
      title: { 'zh-CN': 'A 级 · 高效稳健', 'zh-TW': 'A 級 · 高效穩健', en: 'Grade A · High Efficiency' },
      comment: {
        'zh-CN': '发挥非常扎实. 时间和算力都花在了刀刃上. 干活很顺手.',
        'zh-TW': '發揮非常紮實. 時間和算力都花在了刀刃上. 做事很順手.',
        en: 'Solid responsiveness and throughput; compute well spent.'
      }
    },
    {
      grade: 'B',
      glyph: '●',
      minInclusive: 60,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': 'B 级 · 均衡达标', 'zh-TW': 'B 級 · 均衡達標', en: 'Grade B · Balanced' },
      comment: {
        'zh-CN': '整体表现中规中矩. 如果任务本身很重. 这个耗时完全在情理之中.',
        'zh-TW': '整體表現中規中矩. 如果任務本身很重. 這個耗時完全在情理之中.',
        en: 'Balanced overall; reasonable turnaround given task size.'
      }
    },
    {
      grade: 'C',
      glyph: '▲',
      minInclusive: 40,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': 'C 级 · 边际递减', 'zh-TW': 'C 級 · 邊際遞減', en: 'Grade C · Mediocre' },
      comment: {
        'zh-CN': '效率开始打折了. 要么是任务确实吃重. 要么是前期思考等待磨蹭了半天.',
        'zh-TW': '效率開始打折了. 要麼是任務確實吃重. 要麼是前期思考等待磨蹭了半天.',
        en: 'Noticeable friction from either heavy workload or long initial waiting.'
      }
    },
    {
      grade: 'D',
      glyph: '!',
      minInclusive: 20,
      color: '#EF4444',
      severity: 'danger',
      title: { 'zh-CN': 'D 级 · 低效失衡', 'zh-TW': 'D 級 · 低效失衡', en: 'Grade D · Inefficient' },
      comment: {
        'zh-CN': '投入产出比偏低. 明显感觉在空转等进度. 体感已经开始烦躁了.',
        'zh-TW': '投入產出比偏低. 明顯感覺在空轉等進度. 體感已經開始煩躁了.',
        en: 'Low efficiency relative to wait time; frustrating idle ratio.'
      }
    },
    {
      grade: 'F',
      glyph: '✕',
      minInclusive: 0,
      color: '#DC2626',
      severity: 'critical',
      title: { 'zh-CN': 'F 级 · 效能崩盘', 'zh-TW': 'F 級 · 效能崩盤', en: 'Grade F · Collapsed' },
      comment: {
        'zh-CN': '极其抽象的表现——活没干多少. 时间全耗在干等上了. 这边建议直接打开 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '極其抽象的表現——事沒幹多少. 時間全耗在乾等上了. 這邊建議直接打開 Claude、Codex 或豆包應急吧.',
        en: 'Severe wait-to-output imbalance; consider using Claude, Codex, or Doubao if stalled.'
      }
    }
  ];

  function pickLeftClosedTier(tiers, value, lang = 'zh-CN') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return null;
    for (const tier of tiers) {
      if (v < tier.maxExclusive) {
        return {
          id: tier.id,
          color: tier.color,
          severity: tier.severity,
          glyph: tier.glyph || '⚡',
          title: pickI18nText(tier.title, lang),
          comment: pickI18nText(tier.comment, lang)
        };
      }
    }
    const last = tiers[tiers.length - 1];
    return {
      id: last.id,
      color: last.color,
      severity: last.severity,
      glyph: last.glyph || '⚡',
      title: pickI18nText(last.title, lang),
      comment: pickI18nText(last.comment, lang)
    };
  }

  function classifyStreamSpeedTier(streamSpeed, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_STREAM_SPEED_TIERS, streamSpeed, lang);
  }

  function classifyTtftTier(ttftSec, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_TTFT_TIERS, ttftSec, lang);
  }

  function classifyDurationTier(durationSec, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_DURATION_TIERS, durationSec, lang);
  }

  function classifyEfficiencyGrade(score, lang = 'zh-CN') {
    const s = Number(score);
    if (!Number.isFinite(s) || s < 0) return null;
    for (const g of ELV91_EFFICIENCY_GRADES) {
      if (s >= g.minInclusive) {
        return {
          grade: g.grade,
          color: g.color,
          severity: g.severity,
          glyph: g.glyph || '⚡',
          title: pickI18nText(g.title, lang),
          comment: pickI18nText(g.comment, lang)
        };
      }
    }
    const last = ELV91_EFFICIENCY_GRADES[ELV91_EFFICIENCY_GRADES.length - 1];
    return {
      grade: last.grade,
      color: last.color,
      severity: last.severity,
      glyph: last.glyph || '✕',
      title: pickI18nText(last.title, lang),
      comment: pickI18nText(last.comment, lang)
    };
  }

  /**
   * 评估流式输出稳定性（必须同时满足采样点数 >= 15、纯流式耗时 > 2.0s 且真实间隔 CV <= 0.65）。
   * 若缺少实际间隔波动数据，严禁凭直觉或流式均速给出平稳勾选。
   */
  function computeStreamStability(input = {}) {
    if (input && (input.isSyntheticPoll === true || input.sampleSource === 'poll' || input.sampleSource === 'synthetic')) {
      const streamingSec = Number(input.streamingSec);
      return {
        isStable: false,
        chunks: 0,
        streamingSec: Number.isFinite(streamingSec) ? streamingSec : null,
        intervalCv: null,
        reason: 'synthetic_poll_unsupported'
      };
    }
    const chunks = Number(input.chunkCount ?? input.chunks ?? 0);
    const streamingSec = Number(input.streamingSec);
    let intervalCv = (input.intervalCv !== undefined && input.intervalCv !== null && Number.isFinite(Number(input.intervalCv)) && Number(input.intervalCv) >= 0)
      ? Number(input.intervalCv)
      : null;

    if (intervalCv === null && Array.isArray(input.chunkIntervalsMs)) {
      const valid = input.chunkIntervalsMs.map(Number).filter(v => Number.isFinite(v) && v >= 0);
      if (valid.length >= 14) {
        const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
        if (mean > 0) {
          const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
          intervalCv = Math.sqrt(variance) / mean;
        } else {
          intervalCv = 0;
        }
      }
    }

    if (!Number.isFinite(streamingSec) || streamingSec <= 2.0) {
      return {
        isStable: false,
        chunks: Number.isFinite(chunks) ? chunks : 0,
        streamingSec: Number.isFinite(streamingSec) ? streamingSec : null,
        intervalCv: intervalCv !== null ? Number(intervalCv.toFixed(3)) : null,
        reason: 'short_stream'
      };
    }
    if (!Number.isFinite(chunks) || chunks < 15) {
      return {
        isStable: false,
        chunks: Number.isFinite(chunks) ? chunks : 0,
        streamingSec,
        intervalCv: intervalCv !== null ? Number(intervalCv.toFixed(3)) : null,
        reason: 'insufficient_chunks'
      };
    }
    if (intervalCv === null) {
      return {
        isStable: false,
        chunks,
        streamingSec,
        intervalCv: null,
        reason: 'missing_interval_evidence'
      };
    }
    const isStable = intervalCv <= 0.65;
    return {
      isStable,
      chunks,
      streamingSec,
      intervalCv: Number(intervalCv.toFixed(3)),
      reason: isStable ? 'stable' : 'high_variance'
    };
  }

  /**
   * 计算 ELV-91 综合体验指数 E ∈ [0, 100]（Weber-Fechner + Hill Log-Logistic + Cobb-Douglas）。
   * 若缺少必需指标或满足极端小样本门槛（outputTokens < 15 && totalDurationSec < 2），不强行补造分数。
   */
  function calculateExperienceScore(input = {}, lang = 'zh-CN') {
    const outRaw = input.outputTokens;
    const outputTokens = (outRaw !== undefined && outRaw !== null && Number.isFinite(Number(outRaw))) ? Number(outRaw) : null;
    const inRaw = input.totalInputTokens ?? input.inputTokens;
    const inputTokens = (inRaw !== undefined && inRaw !== null && Number.isFinite(Number(inRaw)) && Number(inRaw) > 0) ? Number(inRaw) : null;
    const ttftRaw = input.ttftSec ?? input.ttft;
    const ttftSec = (ttftRaw !== undefined && ttftRaw !== null && Number.isFinite(Number(ttftRaw)) && Number(ttftRaw) >= 0) ? Number(ttftRaw) : null;
    const durRaw = input.totalDurationSec ?? input.durationSec ?? input.duration;
    const totalDurationSec = (durRaw !== undefined && durRaw !== null && Number.isFinite(Number(durRaw)) && Number(durRaw) > 0) ? Number(durRaw) : null;

    let streamSpeed = (input.streamSpeed !== undefined && input.streamSpeed !== null && Number.isFinite(Number(input.streamSpeed)) && Number(input.streamSpeed) > 0)
      ? Number(input.streamSpeed)
      : ((input.streamingTps !== undefined && input.streamingTps !== null && Number.isFinite(Number(input.streamingTps)) && Number(input.streamingTps) > 0)
        ? Number(input.streamingTps)
        : null);

    const streamSecRaw = input.streamingSec;
    let streamingSec = (streamSecRaw !== undefined && streamSecRaw !== null && Number.isFinite(Number(streamSecRaw)) && Number(streamSecRaw) > 0)
      ? Number(streamSecRaw)
      : ((totalDurationSec !== null && ttftSec !== null && totalDurationSec > ttftSec + 0.01) ? Number((totalDurationSec - ttftSec).toFixed(4)) : null);

    if (streamSpeed === null && outputTokens !== null && outputTokens > 0 && streamingSec !== null && streamingSec >= 0.05) {
      streamSpeed = outputTokens / streamingSec;
    }

    if ((outputTokens !== null && outputTokens < 15) || (streamingSec !== null && streamingSec < 0.5)) {
      return {
        available: false,
        skippedReason: 'insufficient_sample',
        score: null,
        grade: null,
        tier: null,
        ruleVersion: ELV91_SCORE_RULE_VERSION
      };
    }

    if (outputTokens === null || ttftSec === null || totalDurationSec === null || streamSpeed === null || !Number.isFinite(streamSpeed) || streamSpeed <= 0) {
      return {
        available: false,
        skippedReason: 'missing_metrics',
        score: null,
        grade: null,
        tier: null,
        ruleVersion: ELV91_SCORE_RULE_VERSION
      };
    }

    const N_work = inputTokens !== null
      ? Math.max(1, outputTokens + 0.15 * inputTokens)
      : Math.max(1, outputTokens);
    const C = Math.log10(1 + N_work);
    const gamma = 1 + 0.50 * Math.max(0, C - 2.3);
    const S_resp = 1 / (1 + Math.pow(ttftSec / (8 * gamma), 1.5));
    const S_speed = 1 / (1 + Math.pow(35 / Math.max(streamSpeed, 0.1), 1.4));
    const T_base = 5.0 + N_work / 25.0;
    const S_dur = 1 / (1 + Math.pow(totalDurationSec / (T_base * gamma), 1.2));
    const w1 = Math.min(0.40, Math.max(0.15, 0.40 - 0.10 * Math.max(0, C - 2.3)));
    const w2 = 0.35;
    const w3 = 1 - w1 - w2;
    const score = Math.round(100 * Math.pow(S_resp, w1) * Math.pow(S_speed, w2) * Math.pow(S_dur, w3) * 10) / 10;
    const clampedScore = Math.max(0, Math.min(100, score));
    const tier = classifyEfficiencyGrade(clampedScore, lang);

    return {
      available: true,
      skippedReason: null,
      score: clampedScore,
      grade: tier.grade,
      tier,
      ruleVersion: ELV91_SCORE_RULE_VERSION,
      basis: {
        N_work: Number(N_work.toFixed(1)),
        usedInputWeight: inputTokens !== null,
        C: Number(C.toFixed(4)),
        gamma: Number(gamma.toFixed(4)),
        S_resp: Number(S_resp.toFixed(4)),
        S_speed: Number(S_speed.toFixed(4)),
        T_base: Number(T_base.toFixed(2)),
        S_dur: Number(S_dur.toFixed(4)),
        w1: Number(w1.toFixed(4)),
        w2,
        w3: Number(w3.toFixed(4))
      }
    };
  }

  /**
   * ELV-91 三阶段生成体验综合判定器。
   * 覆盖：等待首字(waiting) / 流式生成中(streaming) / 已完成(final) / 异常(canceled, failed, exceeded, network, idle)。
   * 严格执行：左闭右开区间、TTFT > 30s 木桶优先警示、样本不足与缺失兜底、真实间隔方差平稳判定、防错因/重连承诺。
   */
  function evaluateGenerationExperience(rawInput = {}, lang = 'zh-CN') {
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const outcome = String(input.outcomeStatus || input.status || '').toLowerCase();

    const rawElapsed = input.elapsedSec ?? input.waitingSec;
    const elapsedSec = (rawElapsed !== undefined && rawElapsed !== null && Number.isFinite(Number(rawElapsed)) && Number(rawElapsed) >= 0) ? Number(rawElapsed) : null;
    const rawTtft = input.ttftSec ?? input.ttft;
    const ttftSec = (rawTtft !== undefined && rawTtft !== null && Number.isFinite(Number(rawTtft)) && Number(rawTtft) >= 0) ? Number(rawTtft) : null;
    const rawDur = input.totalDurationSec ?? input.durationSec ?? input.duration;
    const totalDurationSec = (rawDur !== undefined && rawDur !== null && Number.isFinite(Number(rawDur)) && Number(rawDur) > 0) ? Number(rawDur) : null;
    const rawOut = input.outputTokens;
    const outputTokens = (rawOut !== undefined && rawOut !== null && Number.isFinite(Number(rawOut)) && Number(rawOut) >= 0) ? Number(rawOut) : null;

    let streamingSec = (input.streamingSec !== undefined && input.streamingSec !== null && Number.isFinite(Number(input.streamingSec)) && Number(input.streamingSec) >= 0)
      ? Number(input.streamingSec)
      : ((totalDurationSec !== null && ttftSec !== null && totalDurationSec > ttftSec) ? Number((totalDurationSec - ttftSec).toFixed(4)) : null);

    let streamSpeed = (input.streamSpeed !== undefined && input.streamSpeed !== null && Number.isFinite(Number(input.streamSpeed)) && Number(input.streamSpeed) > 0)
      ? Number(Number(input.streamSpeed).toFixed(1))
      : ((input.streamingTps !== undefined && input.streamingTps !== null && Number.isFinite(Number(input.streamingTps)) && Number(input.streamingTps) > 0)
        ? Number(Number(input.streamingTps).toFixed(1))
        : null);
    if (streamSpeed === null && outputTokens !== null && outputTokens > 0 && streamingSec !== null && streamingSec >= 0.05) {
      streamSpeed = Number((outputTokens / streamingSec).toFixed(1));
    }

    const overallTps = (input.overallTps !== undefined && input.overallTps !== null && Number.isFinite(Number(input.overallTps)) && Number(input.overallTps) > 0)
      ? Number(Number(input.overallTps).toFixed(1))
      : ((outputTokens !== null && outputTokens > 0 && totalDurationSec !== null && totalDurationSec > 0) ? Number((outputTokens / totalDurationSec).toFixed(1)) : null);

    const ttftRatioPct = (ttftSec !== null && totalDurationSec !== null && totalDurationSec > 0)
      ? Number((Math.min(100, Math.max(0, (ttftSec / totalDurationSec) * 100))).toFixed(1))
      : null;

    const ttftFormatted = ttftSec !== null ? formatHumanDuration(ttftSec, lang) : '—';
    const durationFormatted = totalDurationSec !== null ? formatHumanDuration(totalDurationSec, lang) : '—';
    const elapsedFormatted = elapsedSec !== null ? formatHumanDuration(elapsedSec, lang) : '—';

    let phase = input.phase || '';
    if (!phase) {
      if (outcome === 'canceled') phase = 'canceled';
      else if (['failed', 'exceeded', 'network', 'quota_exhausted', 'rate_limited', 'auth_error', 'service_unavailable'].includes(outcome) || input.error) phase = 'failed';
      else if (outcome === 'waiting' || (elapsedSec !== null && ttftSec === null && !outputTokens)) phase = 'waiting';
      else if (outcome === 'streaming') phase = 'streaming';
      else if (ttftSec !== null || totalDurationSec !== null || streamSpeed !== null || (outputTokens !== null && outputTokens > 0)) phase = 'final';
      else phase = 'idle';
    }

    // 异常 / 取消 / 空闲状态处理（绝不制造评分或速率）
    if (phase === 'idle') {
      return {
        phase: 'idle',
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: {
          text: isEn ? 'Standby' : (isTw ? '待生成' : '待生成'),
          color: '#9CA3AF',
          severity: 'neutral',
          glyph: '⚡'
        },
        shortTitle: isEn ? 'Standby' : '待生成',
        comment: isEn
          ? 'Waiting for model output to evaluate first-token wait and streaming throughput.'
          : (isTw ? '等待首次模型輸出產生首字延遲與純流式速度評估.' : '等待首次模型输出产生首字延迟与纯流式速度评估.'),
        subLabel: isEn ? 'No data yet' : (isTw ? '暫無即時生成資料' : '暂无本次生成数据'),
        elapsedFormatted: '—',
        ttftFormatted: '—',
        durationFormatted: '—',
        ttftRatioPct: null,
        streamSpeed: null,
        overallTps: null,
        ttftTier: null,
        speedTier: null,
        durationTier: null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: 'idle', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    if (phase === 'canceled' || phase === 'failed') {
      const isCanc = phase === 'canceled';
      const baseColor = isCanc ? '#9CA3AF' : '#EF4444';
      const titleTxt = isCanc
        ? (isEn ? 'Interrupted' : (isTw ? '已中斷' : '已中断'))
        : (isEn ? 'Request Failed' : (isTw ? '請求失敗' : '请求失败'));
      const reasonTxt = input.error ? String(input.error).slice(0, 120) : '';
      return {
        phase,
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: { text: titleTxt, color: baseColor, severity: isCanc ? 'neutral' : 'danger', glyph: isCanc ? '⏸' : '✕' },
        shortTitle: titleTxt,
        comment: isCanc
          ? (isEn ? 'The request was canceled before normal completion; efficiency score is omitted.' : (isTw ? '本次請求未正常完成即中斷. 略過綜合評分.' : '本次请求未正常完成即中断. 跳过综合效率评分.'))
          : (reasonTxt || (isEn ? 'Request failed; throughput and efficiency score are omitted.' : (isTw ? '本次請求異常結束. 略過速度與綜合評分.' : '本次请求异常结束. 跳过速度与综合评分.'))),
        subLabel: ttftSec !== null
          ? (isEn ? `TTFT ${ttftFormatted} · Score omitted` : (isTw ? `首字 ${ttftFormatted} · 略過評分` : `首字 ${ttftFormatted} · 跳过综合评分`))
          : (isEn ? 'Score omitted' : (isTw ? '略過綜合評分' : '跳过综合评分')),
        elapsedFormatted,
        ttftFormatted,
        durationFormatted,
        ttftRatioPct,
        streamSpeed,
        overallTps,
        ttftTier: ttftSec !== null ? classifyTtftTier(ttftSec, lang) : null,
        speedTier: null,
        durationTier: totalDurationSec !== null ? classifyDurationTier(totalDurationSec, lang) : null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: phase, score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    // 阶段 1：仍在等待首字 (waiting)
    if (phase === 'waiting') {
      const waitSec = elapsedSec ?? 0;
      const waitFmt = formatHumanDuration(waitSec, lang);
      const tTier = classifyTtftTier(waitSec, lang);
      let color = '#9CA3AF';
      let severity = 'neutral';
      let glyph = '⏳';
      let shortTitle = isEn ? 'Awaiting First Token' : '等待首字';
      let comment = isEn
        ? `Waiting for response (${waitSec.toFixed(1)}s elapsed); rate evaluation paused.`
        : (isTw ? `正在等待回應. 已等待 ${waitSec.toFixed(1)}s. 尚未收到首個字元. 暫不評估速率.` : `正在等待响应. 已等待 ${waitSec.toFixed(1)}s. 尚未收到首个字符. 暂不评估速率.`);
      if (waitSec >= 10 && tTier) {
        color = tTier.color;
        severity = tTier.severity;
        glyph = tTier.glyph;
        shortTitle = tTier.title;
        const tplComment = tTier.comment.replace('{elapsed}', waitFmt);
        const suffix = isEn ? ` (${waitFmt} elapsed).` : (isTw ? ` 已累計等待 ${waitFmt}.` : ` 已累计等待 ${waitFmt}.`);
        comment = `${tplComment}${suffix}`;
      }
      return {
        phase: 'waiting',
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: { text: shortTitle, color, severity, glyph },
        shortTitle,
        comment,
        subLabel: isEn ? 'First token pending · Timing' : (isTw ? '首字未達 · 計時中' : '首字未达 · 计时中'),
        elapsedFormatted: waitFmt,
        ttftFormatted: waitFmt,
        durationFormatted: '—',
        ttftRatioPct: null,
        streamSpeed: null,
        overallTps: null,
        ttftTier: tTier,
        speedTier: null,
        durationTier: null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: 'waiting', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    // 已拿到首字之后（streaming 或 final）先算核心组件
    const ttftTier = ttftSec !== null ? classifyTtftTier(ttftSec, lang) : null;
    const speedTier = streamSpeed !== null ? classifyStreamSpeedTier(streamSpeed, lang) : null;
    const durationTier = totalDurationSec !== null ? classifyDurationTier(totalDurationSec, lang) : null;
    const stability = computeStreamStability({
      chunkCount: input.chunkCount ?? input.chunks,
      chunkIntervalsMs: input.chunkIntervalsMs,
      intervalCv: input.intervalCv,
      streamingSec,
      sampleSource: input.sampleSource,
      isSyntheticPoll: input.isSyntheticPoll
    });
    const efficiency = phase === 'final'
      ? calculateExperienceScore({
          outputTokens,
          inputTokens: input.totalInputTokens ?? input.inputTokens,
          ttftSec,
          streamingSec,
          totalDurationSec,
          streamSpeed
        }, lang)
      : { available: false, skippedReason: 'streaming', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION };

    // 按规则 2 / 3 / 4 判断实时速度与首字等待展示评价
    const isLongTtft = ttftSec !== null && ttftSec > 30;
    const lowStreamTokens = outputTokens !== null && outputTokens < 15;
    const shortStreamTime = streamingSec !== null && streamingSec < 0.5;
    const hasMissingSpeed = streamSpeed === null;
    const isShortStreamOnly = !lowStreamTokens && shortStreamTime;
    const isSampleSparse = lowStreamTokens || shortStreamTime;
    const isReliableSpeed = !(isSampleSparse || hasMissingSpeed);
    const shortWindowEstimateSpeed = (isSampleSparse && streamSpeed !== null) ? streamSpeed : null;

    let evalColor = '#9CA3AF';
    let evalSeverity = 'neutral';
    let evalGlyph = '⚡';
    let evalTitle = '';
    let evalComment = '';
    let subLabel = '';

    const ratioSuffix = ttftRatioPct !== null
      ? (isEn ? ` (${ttftRatioPct}% of turn)` : (isTw ? `佔總耗時 ${ttftRatioPct}%` : `占用了 ${ttftRatioPct}% 的时间`))
      : '';
    const stableSuffix = stability.isStable
      ? (isEn ? ' · Steady output' : (isTw ? ' · 輸出平穩' : ' · 输出平稳'))
      : '';

    if (isLongTtft) {
      // 规则 2：首字 > 30s 木桶优先警示规则（若流式样本过短或无有效速率，不把短窗口突发换算当作后续极快）
      evalColor = ttftTier.color;
      evalSeverity = ttftTier.severity;
      evalGlyph = ttftTier.glyph;
      const baseWaitComment = ttftTier.comment.replace('{elapsed}', ttftFormatted);
      if (hasMissingSpeed || isSampleSparse) {
        evalTitle = ttftTier.title;
        if (isShortStreamOnly && shortWindowEstimateSpeed !== null) {
          evalComment = isEn
            ? `${baseWaitComment} First token took ${ttftFormatted}${ratioSuffix ? ` (${ratioSuffix})` : ''}; streaming window too short (${streamingSec.toFixed(2)}s across ${outputTokens} tokens), short-window speed omitted.`
            : (isTw ? `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 流式持續時間過短（僅 ${streamingSec.toFixed(2)}s，共輸出 ${outputTokens} tokens），不作高速評級.` : `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 流式持续时间过短（仅 ${streamingSec.toFixed(2)}s，共输出 ${outputTokens} tokens），不作高速评级.`);
          subLabel = isEn
            ? `TTFT ${ttftFormatted} · Short stream (${streamingSec.toFixed(2)}s)`
            : (isTw ? `首字 ${ttftFormatted} · 短時窗樣本 (${streamingSec.toFixed(2)}s)` : `首字 ${ttftFormatted} · 短窗口样本 (${streamingSec.toFixed(2)}s)`);
        } else {
          evalComment = isEn
            ? `${baseWaitComment} First token took ${ttftFormatted}${ratioSuffix ? ` (${ratioSuffix})` : ''}; streaming throughput unavailable.`
            : (isTw ? `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 暫無有效後續流速資料.` : `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 暂无有效后续流速数据.`);
          subLabel = isEn
            ? `TTFT ${ttftFormatted} · Rate unavailable`
            : (isTw ? `首字 ${ttftFormatted} · 暫無有效流速` : `首字 ${ttftFormatted} · 暂无有效流速`);
        }
      } else if (streamSpeed >= 30) {
        const fastPhrase = streamSpeed >= 80
          ? (isEn ? 'Fast Stream' : (isTw ? '後續極快' : '后续极快'))
          : (isEn ? 'Steady Stream' : (isTw ? '後續流暢' : '后续流畅'));
        evalTitle = `${ttftTier.title} · ${fastPhrase}`;
        evalComment = isEn
          ? `${baseWaitComment} Though streaming reached ${streamSpeed} tok/s, waiting ${ttftFormatted} took ${ttftRatioPct != null ? ttftRatioPct + '%' : 'most'} of total time.`
          : (isTw ? `${baseWaitComment} 雖然開始吐字後速率達 ${streamSpeed} tok/s. 但首字苦等 ${ttftFormatted}${ratioSuffix ? ` ${ratioSuffix}` : ''}.` : `${baseWaitComment} 虽然开始吐字后速率达 ${streamSpeed} tok/s. 但首字苦等 ${ttftFormatted}${ratioSuffix ? ` ${ratioSuffix}` : ''}.`);
        subLabel = (isEn ? `TTFT ${ttftFormatted} · Stream ${streamSpeed} tok/s` : `首字 ${ttftFormatted} · 流式 ${streamSpeed} tok/s`) + stableSuffix;
      } else {
        const worseTitle = streamSpeed < 1 && speedTier ? speedTier.title : `${ttftTier.title} · ${isEn ? 'Slow Stream' : (isTw ? '後續也慢' : '后续也慢')}`;
        evalTitle = worseTitle;
        evalComment = isEn
          ? `${baseWaitComment} Subsequent streaming also crawled at ${streamSpeed} tok/s.`
          : (isTw ? `${baseWaitComment} 開始吐字後速率也僅有 ${streamSpeed} tok/s.` : `${baseWaitComment} 开始吐字后速率也仅有 ${streamSpeed} tok/s.`);
        subLabel = (isEn ? `TTFT ${ttftFormatted} · Stream ${streamSpeed} tok/s` : `首字 ${ttftFormatted} · 流式 ${streamSpeed} tok/s`) + stableSuffix;
      }
    } else if (isSampleSparse || hasMissingSpeed) {
      // 规则 3：样本/数据不足兜底（严格区分“仅输出字少”与“流式持续时间过短”）
      evalColor = '#9CA3AF';
      evalSeverity = 'neutral';
      evalGlyph = '⏳';
      evalTitle = isShortStreamOnly
        ? (isEn ? 'Short Stream Sample' : (isTw ? '流式時長過短' : '流式时长过短'))
        : (isEn ? 'Insufficient Sample' : (isTw ? '樣本過少' : '样本过少'));
      if (hasMissingSpeed) {
        evalComment = isEn
          ? `TTFT was ${ttftFormatted}; missing effective streaming window or token count to compute throughput.`
          : (isTw ? `本次首字耗時 ${ttftFormatted}. 缺少有效流式階段耗時或輸出量. 暫不計算流式速率.` : `本次首字耗时 ${ttftFormatted}. 缺少有效流式阶段耗时或输出量. 暂不计算流式速率.`);
      } else if (isShortStreamOnly) {
        evalComment = isEn
          ? `Streaming duration too short (${streamingSec.toFixed(2)}s across ${outputTokens} tokens); short-window speed is omitted from main display.`
          : (isTw ? `流式持續時間過短（僅 ${streamingSec.toFixed(2)}s，共輸出 ${outputTokens} tokens），短視窗速率易偏高，不作為主指標展示.` : `流式持续时间过短（仅 ${streamingSec.toFixed(2)}s，共输出 ${outputTokens} tokens），短窗口速率易偏高，不作为主指标展示.`);
      } else if (lowStreamTokens && !shortStreamTime) {
        evalComment = isEn
          ? `Too few output tokens (only ${outputTokens} tokens); speed metric is not representative.`
          : (isTw ? `字太少測不準. 本次僅輸出 ${outputTokens} tokens. 速率指標不具備參考價值.` : `字太少测不出. 本次仅输出 ${outputTokens} tokens. 速率指标不具备参考价值.`);
      } else {
        evalComment = isEn
          ? `Insufficient sample (only ${outputTokens} tokens & short ${streamingSec.toFixed(2)}s window); speed metric is not representative.`
          : (isTw ? `樣本過少測不準. 本次僅輸出 ${outputTokens} tokens 且流式耗時極短 (${streamingSec.toFixed(2)}s). 速率指標不具備參考價值.` : `样本不足测不出. 本次仅输出 ${outputTokens} tokens 且流式耗时极短 (${streamingSec.toFixed(2)}s). 速率指标不具备参考价值.`);
      }
      subLabel = ttftSec !== null
        ? (isEn ? `TTFT ${ttftFormatted} · Stability skipped` : (isTw ? `首字 ${ttftFormatted} · 略過穩定性評估` : `首字 ${ttftFormatted} · 跳过稳定性评估`))
        : (isEn ? 'Stability skipped' : (isTw ? '略過穩定性評估' : '跳过稳定性评估'));
    } else {
      // 规则 4：常规组合（TTFT <= 30s 且样本充足）
      evalColor = speedTier.color;
      evalSeverity = speedTier.severity;
      evalGlyph = speedTier.glyph;
      evalTitle = speedTier.title;
      const ttftExtra = (ttftSec !== null && ttftSec >= 10)
        ? (isEn ? ` (First token waited ${ttftFormatted}.)` : (isTw ? ` (首字等待了 ${ttftFormatted}.)` : ` (首字等待了 ${ttftFormatted}.)`))
        : '';
      evalComment = `${speedTier.comment}${ttftExtra}`;
      const ttftPart = ttftSec !== null ? `${isEn ? 'TTFT' : '首字'} ${ttftFormatted} · ` : '';
      subLabel = `${ttftPart}${isEn ? 'Stream' : '流式'} ${streamSpeed} tok/s${stableSuffix}`;
    }

    // 阶段 3 完成态主徽章：若 E 有效显示 E 分与等级；样本过少或缺失时显式兜底；流式进行中显示实时流速主档位
    let mainBadgeText = evalTitle;
    let mainBadgeColor = evalColor;
    let mainBadgeSeverity = evalSeverity;
    let mainBadgeGlyph = evalGlyph;
    let finalHeadline = evalTitle;
    let finalComment = evalComment;

    if (phase === 'final') {
      if (efficiency.available && efficiency.tier) {
        mainBadgeText = `${efficiency.score} ${isEn ? 'pts' : '分'} · ${efficiency.grade}`;
        mainBadgeColor = efficiency.tier.color;
        mainBadgeSeverity = efficiency.tier.severity;
        mainBadgeGlyph = efficiency.tier.glyph;
        finalHeadline = `${efficiency.score} ${isEn ? 'pts' : '分'} · ${efficiency.tier.title}`;
        finalComment = isLongTtft ? evalComment : efficiency.tier.comment;
      } else if (efficiency.skippedReason === 'insufficient_sample') {
        mainBadgeText = isShortStreamOnly
          ? (isEn ? 'Short Stream · No Score' : (isTw ? '時長過短 · 略過評分' : '流式过短 · 跳过综合评分'))
          : (isEn ? 'Sparse · No Score' : (isTw ? '樣本過少 · 略過評分' : '样本过少 · 跳过综合评分'));
        mainBadgeColor = isLongTtft ? evalColor : '#9CA3AF';
        mainBadgeSeverity = isLongTtft ? evalSeverity : 'neutral';
        mainBadgeGlyph = isLongTtft ? evalGlyph : '⏳';
        finalHeadline = mainBadgeText;
      } else {
        mainBadgeText = evalTitle;
      }
    }

    return {
      phase,
      scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
      badge: {
        text: mainBadgeText,
        color: mainBadgeColor,
        severity: mainBadgeSeverity,
        glyph: mainBadgeGlyph
      },
      shortTitle: finalHeadline,
      speedShortTitle: evalTitle,
      speedColor: evalColor,
      comment: finalComment,
      speedComment: evalComment,
      subLabel,
      elapsedFormatted,
      ttftFormatted,
      durationFormatted,
      ttftRatioPct,
      streamSpeed,
      overallTps,
      outputTokens,
      isSampleSparse,
      lowStreamTokens,
      shortStreamTime,
      isReliableSpeed,
      shortWindowEstimateSpeed,
      ttftTier,
      speedTier,
      durationTier,
      stability,
      efficiency
    };
  }

  const api = {
    summarize,
    classifyRequestError,
    resolveModelQuota,
    getModelPoolKey,
    getSharedQuotaGroupKey,
    normalizeModelLookupName,
    parseQuotaFraction,
    formatQuotaPercentText,
    formatQuotaResetMeta,
    classifyModelQuotaAvailability,
    isDecorativeBadgeTagTitle,
    selectPrimaryQuotaBucket,
    resolveQuotaWindowBucketPair,
    buildModelQuotaSnapshot,
    splitModelDisplayAndEffort,
    resolvePlaceholderModelInfo,
    formatApproxTokensShort,
    inferQuotaWindowDurationMs,
    QUOTA_CAL_TTL_MS,
    computeBucketTokenEstimate,
    applyQuotaTokenEstimates,
    formatResetTimeZh,
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
    convertCurrency,
    CURRENCY_SYMBOLS,
    normalizeModelId,
    resolveStableModelId,
    UNATTRIBUTED_MODEL_KEY,
    lookupModelDisplayLabel,
    resolveModelUsageBucket,
    getModelChartColor,
    summarizeModelUsageWindow,
    normalizeCallInputCacheTokens,
    computeCacheReadStats,
    summarizeCacheReadStats,
    summarizeDailyMapCacheStats,
    normalizeSessionCallRecord,
    sanitizeTurnPreviewText,
    groupSessionCallsByTurns,
    ELV91_SCORE_RULE_VERSION,
    formatHumanDuration,
    classifyStreamSpeedTier,
    classifyTtftTier,
    classifyDurationTier,
    classifyEfficiencyGrade,
    computeStreamStability,
    calculateExperienceScore,
    evaluateGenerationExperience,
    EFFORT_WHITELIST,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    MAX_SPEED_SAMPLES_PER_MODEL,
    calculateRequestApiCost,
    summarizeApiCost,
    calculateReferenceModelCost,
    resolveEffectivePlanStatus,
    parseUserPlanStatus,
    extractCallId,
    parseGeneratorCall,
    extractModelString,
    normalizeTokenHistoryPayload,
    getLvlForRange,
    computeMixedScaleResponse,
    computePiecewiseAnchorScale,
    computeColorScaleResponse,
    resolveScaleEnvelope,
    mapBubbleDiameter,
    mapBarHeightPx,
    allocateStackedSegmentHeights,
    interpolateHslHex,
    interpolateScaleColorHsl,
    shouldShowYearlyPeakBadge,
    computeLogRulerPosition,
    computeCumulativeStripSummary,
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
