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
    if (pk === 'gemini-4-hydrogen' || pk === 'gemini-3.8-flash') return 'shared_gemini_main';
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

    const input = Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0);
    const cached = Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0);
    const output = Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? (output - thinking > 0 ? output - thinking : output));
    const totalTokens = input + cached + output;

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
      speedFields.origin = row.origin === 'speed-test' ? 'speed-test' : 'chat';
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
      status,
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

    if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '') || /pro_ultimate|teams_tier_ultra/i.test(rawTeamsTier)) {
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
    let teamsTier = null;
    let planName = '未知';
    let tierSource = 'unknown';

    if (rawLive && rawLive.status === 'identified' && rawLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = rawLive.tierKey;
      tierName = rawLive.tierName;
      tierId = rawLive.tierId;
      teamsTier = rawLive.teamsTier || null;
      planName = rawLive.planName || rawLive.tierName;
      tierSource = 'live';
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
      teamsTier,
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
      schemaVersion: payload.schemaVersion || '0.8.8',
      version: payload.version || '0.8.8',
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
  function filterReleases(releasesList, currentVersion = '0.8.8') {
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
      } else if (joinedHints.includes('argon')) {
        sharedKey = 'shared_gemini_argon';
      } else if (joinedHints.includes('carbon')) {
        sharedKey = 'shared_gemini_carbon';
      } else if (joinedHints.includes('hydrogen') || joinedHints.includes('flash')) {
        sharedKey = 'shared_gemini_main';
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

    for (const cfg of rawConfigs) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.isHistorical === true) continue;
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
      ensurePool(pg.sharedKey, pg.title, pg);
    }

    for (const prod of productMap.values()) {
      const sKey = prod.sharedGroupKey;
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

      // 从 buckets 中选最紧缩（最小 remainingFraction）的作为 primaryBucket
      const pricedBuckets = pool.buckets.filter(b => b.remainingFraction !== null);
      if (pricedBuckets.length > 0) {
        pricedBuckets.sort((a, b) => a.remainingFraction - b.remainingFraction);
        const pb = pricedBuckets[0];
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
      } else if (pool.buckets.length > 0) {
        const pb = pool.buckets[0];
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
      const targetStr = typeof targetInput === 'object'
        ? String(targetInput.modelId || targetInput.modelOrAlias?.model || targetInput.label || targetInput.model || '')
        : String(targetInput);
      const tLower = targetStr.trim().toLowerCase();
      const tStripped = tLower.replace(/^model_/, '');
      const tNorm = normalizeModelLookupName(targetStr);

      for (const pool of pools) {
        for (const m of pool.models) {
          const allIds = [...m.modelIds, ...m.aliases].map(x => x.toLowerCase());
          if (allIds.some(id => id === tLower || id.replace(/^model_/, '') === tStripped)) {
            return { pool, model: m };
          }
          if (tNorm && normalizeModelLookupName(m.productLabel) === tNorm) {
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

  const api = {
    summarize,
    classifyRequestError,
    resolveModelQuota,
    getModelPoolKey,
    getSharedQuotaGroupKey,
    parseQuotaFraction,
    formatQuotaPercentText,
    formatQuotaResetMeta,
    classifyModelQuotaAvailability,
    isDecorativeBadgeTagTitle,
    buildModelQuotaSnapshot,
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
    CURRENCY_SYMBOLS,
    normalizeModelId,
    resolveStableModelId,
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
