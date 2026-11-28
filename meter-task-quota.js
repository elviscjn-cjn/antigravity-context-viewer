(function (root) {
  'use strict';

  const AUTHORITATIVE_QUOTA_SOURCE = 'host_quota_summary';
  const DEFAULT_SYNC_WINDOW_MS = 90000;
  const DEFAULT_STALE_SNAPSHOT_MS = 180000;
  const RESET_TIME_SHIFT_TOLERANCE_MS = 30000;
  const FRACTION_EPSILON = 1e-7;

  const WINDOW_DISPLAY_MAP = Object.freeze({
    '5h': '5H',
    'weekly': '7D',
    '7d': '7D',
    'daily': '24H',
    '24h': '24H'
  });

  function formatQuotaWindowDisplayTag(raw) {
    if (raw && typeof raw === 'object') {
      const candidate = raw.windowDisplay || raw.windowShort || raw.windowKey || raw.window || '';
      return formatQuotaWindowDisplayTag(candidate);
    }
    const clean = String(raw || '').trim();
    if (!clean) return '';
    const low = clean.toLowerCase();
    if (WINDOW_DISPLAY_MAP[low]) return WINDOW_DISPLAY_MAP[low];
    if (/^\d+[hdw]$/i.test(clean)) return clean.toUpperCase();
    return clean;
  }

  function normalizeWindowKey(raw) {
    const low = String(raw || '').trim().toLowerCase();
    if (low === '5h' || low.includes('5h') || low.includes('five')) return '5h';
    if (low === 'weekly' || low === '7d' || low.includes('week') || low.includes('7d')) return 'weekly';
    return null;
  }

  function maskAccountIdentity(email) {
    const clean = String(email || '').trim().toLowerCase();
    if (!clean) return null;
    const atIdx = clean.indexOf('@');
    if (atIdx <= 0) return clean.length <= 4 ? '***' : `${clean.slice(0, 2)}***${clean.slice(-2)}`;
    const local = clean.slice(0, atIdx);
    const domain = clean.slice(atIdx + 1);
    const maskedLocal = local.length <= 4
      ? `${local.slice(0, 1)}***`
      : `${local.slice(0, 2)}***${local.slice(-2)}`;
    return `${maskedLocal}@${domain}`;
  }

  function inferPrecisionDecimals(fraction) {
    if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return 0;
    const pct = Number(fraction) * 100;
    const s = String(pct);
    const dot = s.indexOf('.');
    if (dot < 0) return 0;
    const fracPart = s.slice(dot + 1).replace(/0+$/, '');
    return Math.min(5, fracPart.length);
  }

  function roundDeltaPp(rawDelta, beforeFrac, afterFrac) {
    if (!Number.isFinite(rawDelta)) return null;
    const dec = Math.max(inferPrecisionDecimals(beforeFrac), inferPrecisionDecimals(afterFrac), 1);
    const clampedDec = Math.min(5, Math.max(1, dec));
    const factor = Math.pow(10, clampedDec);
    const rounded = Math.round(rawDelta * factor) / factor;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function formatPpNumber(val) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return '';
    const n = Number(val);
    if (Math.abs(n) < 1e-6) return '0';
    if (Math.abs(n - Math.round(n)) < 1e-4) return String(Math.round(n));
    if (Math.abs(n) >= 1) return Number(n.toFixed(1)).toString();
    if (Math.abs(n) >= 0.05) return Number(n.toFixed(2)).toString();
    return Number(n.toFixed(4)).toString();
  }

  function normalizePoolKey(rawPoolKey) {
    const clean = String(rawPoolKey || '').trim().toLowerCase();
    if (!clean) return null;
    if (clean === 'shared_gemini_main' || clean.includes('gemini-4-neon') || clean.includes('gemini-4-hydrogen') || clean.includes('gemini-4-carbon') || clean.includes('gemini-4-argon') || clean.includes('gemini-3.8-flash') || clean.includes('orchestrator')) {
      return 'shared_gemini_main';
    }
    if (clean === 'shared_3p_pool' || clean.includes('claude') || clean.includes('gpt') || clean.includes('3p')) {
      return 'shared_3p_pool';
    }
    return clean;
  }

  /**
   * 规范化宿主额度快照为共享契约 QuotaSnapshotSample
   * 严格区分 host_quota_summary (RetrieveUserQuotaSummary) 与 host_user_status (GetUserStatus)，防止跨源相减产生偏差
   */
  function normalizeHostQuotaSnapshot(hostQuotaResult, opts = {}) {
    if (!hostQuotaResult || typeof hostQuotaResult !== 'object') return null;
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const staleThresholdMs = Number.isFinite(Number(opts.staleThresholdMs))
      ? Number(opts.staleThresholdMs)
      : DEFAULT_STALE_SNAPSHOT_MS;

    const fetchedAtMs = Number.isFinite(Number(hostQuotaResult.fetchedAtMs))
      ? Number(hostQuotaResult.fetchedAtMs)
      : (Number.isFinite(Number(hostQuotaResult.snapshot?.fetchedAtMs))
        ? Number(hostQuotaResult.snapshot.fetchedAtMs)
        : nowMs);

    const accountScopeKey = String(
      opts.accountScopeKey
      || hostQuotaResult.accountScopeKey
      || ''
    ).trim() || null;

    const accountMasked = opts.accountMasked
      || hostQuotaResult.accountMasked
      || maskAccountIdentity(hostQuotaResult.email)
      || null;

    const isRejected = Boolean(
      hostQuotaResult.staleDiscarded === true
      || hostQuotaResult.accountIdentityMismatch === true
      || hostQuotaResult.identityVerified === false
      || hostQuotaResult.forceRefreshFallback === true
      || hostQuotaResult.dataFreshness === 'host_cache_fallback'
      || hostQuotaResult.dataFreshness === 'error_fallback'
      || hostQuotaResult.dataFreshness === 'stale_discarded'
      || hostQuotaResult.dataFreshness === 'account_mismatch'
      || hostQuotaResult.dataFreshness === 'unverified_identity'
      || hostQuotaResult.ok === false
    );

    const ageMs = Math.max(0, nowMs - fetchedAtMs);
    const isFresh = !isRejected && ageMs <= staleThresholdMs;

    const snap = hostQuotaResult.snapshot && typeof hostQuotaResult.snapshot === 'object'
      ? hostQuotaResult.snapshot
      : hostQuotaResult;

    const rawPools = Array.isArray(snap?.pools) ? snap.pools : [];
    const pools = {};
    let hasAuthoritativeSummary = false;

    for (const p of rawPools) {
      if (!p || typeof p !== 'object') continue;
      const poolKey = normalizePoolKey(p.poolKey) || String(p.poolKey || '').trim();
      if (!poolKey) continue;
      const sourceType = p.sourceType || opts.source || null;
      const poolSource = (sourceType === 'quota_summary_and_configs' || sourceType === AUTHORITATIVE_QUOTA_SOURCE)
        ? AUTHORITATIVE_QUOTA_SOURCE
        : (sourceType === 'model_configs_only' || sourceType === 'host_user_status'
          ? 'host_user_status'
          : (opts.source || AUTHORITATIVE_QUOTA_SOURCE));

      if (poolSource === AUTHORITATIVE_QUOTA_SOURCE) hasAuthoritativeSummary = true;

      const buckets = {};
      const bucketList = Array.isArray(p.buckets) ? p.buckets : [];
      for (const b of bucketList) {
        if (!b || typeof b !== 'object') continue;
        const wk = normalizeWindowKey(b.windowKey || b.windowShort || b.window || b.bucketId);
        if (!wk) continue;
        const hasFrac = b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction));
        const frac = hasFrac ? Math.max(0, Math.min(1, Number(b.remainingFraction))) : null;
        const pct = frac !== null ? Number((frac * 100).toFixed(6)) : null;
        const resetTimeIso = typeof (b.resetTimeIso || b.resetTime) === 'string' && (b.resetTimeIso || b.resetTime).trim()
          ? String(b.resetTimeIso || b.resetTime).trim()
          : null;
        const parsedResetMs = Number.isFinite(Number(b.resetAtMs))
          ? Number(b.resetAtMs)
          : (resetTimeIso ? Date.parse(resetTimeIso) : NaN);
        const resetAtMs = Number.isFinite(parsedResetMs) ? parsedResetMs : null;
        const bucketSource = b.fractionSource === 'client_config'
          ? 'host_user_status'
          : poolSource;

        buckets[wk] = {
          bucketId: b.bucketId || `${poolKey}:${wk}`,
          windowKey: wk,
          windowDisplay: formatQuotaWindowDisplayTag(wk),
          remainingFraction: frac,
          remainingPct: pct,
          precisionDecimals: inferPrecisionDecimals(frac),
          resetTimeIso,
          resetAtMs,
          source: bucketSource
        };
      }

      pools[poolKey] = {
        poolKey,
        title: p.title || poolKey,
        noPermission: Boolean(p.noPermission),
        source: poolSource,
        buckets
      };
    }

    const effectiveSource = opts.source
      || (isRejected && hostQuotaResult.dataFreshness === 'host_cache_fallback'
        ? 'host_cache_fallback'
        : (hasAuthoritativeSummary ? AUTHORITATIVE_QUOTA_SOURCE : 'host_user_status'));

    return {
      schemaVersion: 1,
      accountScopeKey,
      accountMasked,
      source: effectiveSource,
      dataFreshness: hostQuotaResult.dataFreshness || (isFresh ? 'host_default' : 'stale'),
      fetchedAtMs,
      isFresh,
      pools
    };
  }

  function makeBucketSnapRef(bucket, fetchedAtMs) {
    if (!bucket) return null;
    return {
      bucketId: bucket.bucketId || null,
      remainingFraction: bucket.remainingFraction,
      remainingPct: bucket.remainingPct,
      sampledAtMs: fetchedAtMs,
      resetTimeIso: bucket.resetTimeIso || null,
      resetAtMs: bucket.resetAtMs ?? null,
      source: bucket.source || null
    };
  }

  function evaluateSingleWindowDelta({
    windowKey,
    startSnap,
    endSnap,
    poolKey,
    taskStatus = 'completed',
    concurrentTaskIds = [],
    syncWindowDeadlineMs = null,
    nowMs = Date.now(),
    accountSwitched = false
  }) {
    const windowDisplay = formatQuotaWindowDisplayTag(windowKey);
    const base = {
      windowKey,
      windowDisplay,
      status: 'unavailable',
      attributionKind: 'unavailable',
      isApportionable: false,
      deltaPp: null,
      before: null,
      after: null,
      reasonCode: null,
      concurrentTaskIds: Array.isArray(concurrentTaskIds) ? concurrentTaskIds.slice() : [],
      syncWindowDeadlineMs: syncWindowDeadlineMs ?? null,
      settled: false
    };

    if (accountSwitched) {
      return {
        ...base,
        status: 'account_switched',
        reasonCode: 'account_changed_mid_task',
        settled: true
      };
    }

    if (!startSnap || !startSnap.pools || !poolKey) {
      return {
        ...base,
        status: 'missing_start',
        reasonCode: 'missing_pre_task_snapshot',
        settled: taskStatus !== 'running'
      };
    }

    const startPool = startSnap.pools[poolKey] || null;
    const startBucket = startPool?.buckets?.[windowKey] || null;
    if (startPool?.noPermission) {
      return {
        ...base,
        status: 'unavailable',
        reasonCode: 'pool_no_permission',
        settled: true
      };
    }
    if (!startBucket || startBucket.remainingFraction === null) {
      return {
        ...base,
        status: 'missing_start',
        reasonCode: 'missing_start_bucket',
        before: makeBucketSnapRef(startBucket, startSnap.fetchedAtMs),
        settled: taskStatus !== 'running'
      };
    }
    if (!startSnap.isFresh) {
      return {
        ...base,
        status: 'stale_snapshot',
        reasonCode: 'stale_start_snapshot',
        before: makeBucketSnapRef(startBucket, startSnap.fetchedAtMs),
        settled: taskStatus !== 'running'
      };
    }

    const beforeRef = makeBucketSnapRef(startBucket, startSnap.fetchedAtMs);

    if (!endSnap) {
      const withinSyncWindow = syncWindowDeadlineMs !== null && nowMs < syncWindowDeadlineMs;
      if (taskStatus === 'running' || withinSyncWindow) {
        return {
          ...base,
          status: 'pending_sync',
          reasonCode: 'awaiting_host_refresh',
          before: beforeRef,
          settled: false
        };
      }
      return {
        ...base,
        status: 'missing_end',
        reasonCode: 'window_expired_no_sample',
        before: beforeRef,
        settled: true
      };
    }

    if (startSnap.accountScopeKey && endSnap.accountScopeKey && startSnap.accountScopeKey !== endSnap.accountScopeKey) {
      return {
        ...base,
        status: 'account_switched',
        reasonCode: 'account_scope_mismatch',
        before: beforeRef,
        settled: true
      };
    }

    const endPool = endSnap.pools?.[poolKey] || null;
    const endBucket = endPool?.buckets?.[windowKey] || null;
    const afterRef = makeBucketSnapRef(endBucket, endSnap.fetchedAtMs);

    if (endPool?.noPermission) {
      return {
        ...base,
        status: 'unavailable',
        reasonCode: 'pool_no_permission',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }
    if (!endBucket || endBucket.remainingFraction === null) {
      return {
        ...base,
        status: 'missing_end',
        reasonCode: 'missing_end_bucket',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }
    if (!endSnap.isFresh) {
      return {
        ...base,
        status: 'stale_snapshot',
        reasonCode: 'stale_end_snapshot',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }
    if (endSnap.fetchedAtMs < startSnap.fetchedAtMs) {
      return {
        ...base,
        status: 'stale_snapshot',
        reasonCode: 'out_of_order_end_snapshot',
        before: beforeRef,
        after: afterRef,
        settled: false
      };
    }

    // 严禁跨源相减 (实证 GetUserStatus 与 RetrieveUserQuotaSummary 可偏差 >1.9pp)
    const startSrc = startBucket.source || startSnap.source;
    const endSrc = endBucket.source || endSnap.source;
    if (startSrc !== AUTHORITATIVE_QUOTA_SOURCE || endSrc !== AUTHORITATIVE_QUOTA_SOURCE) {
      return {
        ...base,
        status: 'source_mismatch',
        reasonCode: 'non_authoritative_or_mixed_source',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }

    // 周期重置判定：resetAtMs 向未来推进超过容差，或开始时间后原 resetAtMs 已过且余量回升
    const resetAdvanced = Boolean(
      beforeRef.resetAtMs !== null
      && afterRef.resetAtMs !== null
      && (afterRef.resetAtMs - beforeRef.resetAtMs) > RESET_TIME_SHIFT_TOLERANCE_MS
    );
    const resetPassedBetween = Boolean(
      beforeRef.resetAtMs !== null
      && beforeRef.resetAtMs > startSnap.fetchedAtMs
      && beforeRef.resetAtMs <= endSnap.fetchedAtMs
    );
    if (resetAdvanced || resetPassedBetween) {
      return {
        ...base,
        status: 'reset_crossed',
        reasonCode: resetAdvanced ? 'reset_time_advanced' : 'reset_boundary_crossed',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }

    const rawFracDiff = beforeRef.remainingFraction - afterRef.remainingFraction;
    if (rawFracDiff < -FRACTION_EPSILON) {
      return {
        ...base,
        status: 'rebounded',
        reasonCode: 'remaining_increased',
        before: beforeRef,
        after: afterRef,
        settled: true
      };
    }

    const rawPp = Math.max(0, rawFracDiff * 100);
    const deltaPp = roundDeltaPp(rawPp, beforeRef.remainingFraction, afterRef.remainingFraction);
    const hasConcurrent = Array.isArray(concurrentTaskIds) && concurrentTaskIds.length > 0;
    const isTerminalAbnormal = taskStatus === 'cancelled' || taskStatus === 'failed' || taskStatus === 'interrupted';

    if (hasConcurrent) {
      return {
        ...base,
        status: 'concurrent_ambiguous',
        attributionKind: 'observed',
        isApportionable: false,
        deltaPp,
        before: beforeRef,
        after: afterRef,
        reasonCode: 'concurrent_task_overlap',
        settled: true
      };
    }

    if (deltaPp === 0) {
      return {
        ...base,
        status: 'observed_zero',
        attributionKind: 'observed',
        isApportionable: false,
        deltaPp: 0,
        before: beforeRef,
        after: afterRef,
        reasonCode: isTerminalAbnormal ? `task_${taskStatus}_observed_zero` : 'valid_sample_no_change',
        settled: true
      };
    }

    return {
      ...base,
      status: 'observed',
      attributionKind: 'observed',
      isApportionable: false,
      deltaPp,
      before: beforeRef,
      after: afterRef,
      reasonCode: isTerminalAbnormal ? `task_${taskStatus}_with_observation` : 'shared_window_delta_observed',
      settled: true
    };
  }

  /**
   * 纯函数求值单次任务 5H / 7D 额度观测结果
   */
  function evaluateTaskQuotaDelta({
    startSnapshot = null,
    endSnapshot = null,
    taskMeta = {},
    concurrentTaskIds = [],
    accountSegments = null,
    nowMs = Date.now()
  } = {}) {
    const taskId = String(taskMeta.taskId || '').trim() || 'unknown_task';
    const sessionId = String(taskMeta.sessionId || taskMeta.cascadeId || '').trim() || null;
    const poolKey = normalizePoolKey(taskMeta.poolKey) || null;
    const modelIds = Array.isArray(taskMeta.modelIds)
      ? Array.from(new Set(taskMeta.modelIds.map(x => String(x || '').trim()).filter(Boolean)))
      : [];
    const taskStatus = String(taskMeta.taskStatus || 'completed').trim().toLowerCase();
    const syncWindowDeadlineMs = Number.isFinite(Number(taskMeta.syncWindowDeadlineMs))
      ? Number(taskMeta.syncWindowDeadlineMs)
      : null;

    // 切号分段：每个账号仅用自身配对的前后快照，绝不将旧账号前值与新账号后值相减
    if (Array.isArray(accountSegments) && accountSegments.length > 1) {
      const evaluatedSegments = accountSegments.map((seg, idx) => {
        const segPool = normalizePoolKey(seg.poolKey || poolKey) || poolKey;
        const segConcurrent = Array.isArray(seg.concurrentTaskIds) ? seg.concurrentTaskIds : concurrentTaskIds;
        return {
          segmentIndex: idx,
          accountScopeKey: seg.accountScopeKey || seg.startSnapshot?.accountScopeKey || seg.endSnapshot?.accountScopeKey || null,
          accountMasked: seg.accountMasked || seg.startSnapshot?.accountMasked || seg.endSnapshot?.accountMasked || null,
          startedAtMs: seg.startedAtMs ?? null,
          endedAtMs: seg.endedAtMs ?? null,
          poolKey: segPool,
          windows: {
            '5h': evaluateSingleWindowDelta({
              windowKey: '5h',
              startSnap: seg.startSnapshot || null,
              endSnap: seg.endSnapshot || null,
              poolKey: segPool,
              taskStatus,
              concurrentTaskIds: segConcurrent,
              syncWindowDeadlineMs,
              nowMs
            }),
            'weekly': evaluateSingleWindowDelta({
              windowKey: 'weekly',
              startSnap: seg.startSnapshot || null,
              endSnap: seg.endSnapshot || null,
              poolKey: segPool,
              taskStatus,
              concurrentTaskIds: segConcurrent,
              syncWindowDeadlineMs,
              nowMs
            })
          }
        };
      });

      return {
        schemaVersion: 1,
        taskId,
        sessionId,
        accountScopeKey: evaluatedSegments[evaluatedSegments.length - 1]?.accountScopeKey || null,
        accountMasked: evaluatedSegments[evaluatedSegments.length - 1]?.accountMasked || null,
        poolKey,
        modelIds,
        taskStatus,
        accountSwitched: true,
        accountSegments: evaluatedSegments,
        windows: {
          '5h': evaluateSingleWindowDelta({ windowKey: '5h', poolKey, taskStatus, accountSwitched: true, nowMs }),
          'weekly': evaluateSingleWindowDelta({ windowKey: 'weekly', poolKey, taskStatus, accountSwitched: true, nowMs })
        }
      };
    }

    const switchedBetweenSnaps = Boolean(
      startSnapshot?.accountScopeKey
      && endSnapshot?.accountScopeKey
      && startSnapshot.accountScopeKey !== endSnapshot.accountScopeKey
    );
    const accountScopeKey = taskMeta.accountScopeKey || startSnapshot?.accountScopeKey || endSnapshot?.accountScopeKey || null;
    const accountMasked = taskMeta.accountMasked || startSnapshot?.accountMasked || endSnapshot?.accountMasked || null;

    const w5h = evaluateSingleWindowDelta({
      windowKey: '5h',
      startSnap: startSnapshot,
      endSnap: endSnapshot,
      poolKey,
      taskStatus,
      concurrentTaskIds,
      syncWindowDeadlineMs,
      nowMs,
      accountSwitched: switchedBetweenSnaps
    });
    const w7d = evaluateSingleWindowDelta({
      windowKey: 'weekly',
      startSnap: startSnapshot,
      endSnap: endSnapshot,
      poolKey,
      taskStatus,
      concurrentTaskIds,
      syncWindowDeadlineMs,
      nowMs,
      accountSwitched: switchedBetweenSnaps
    });

    return {
      schemaVersion: 1,
      taskId,
      sessionId,
      accountScopeKey,
      accountMasked,
      poolKey,
      modelIds,
      taskStatus,
      accountSwitched: switchedBetweenSnaps,
      accountSegments: [
        {
          segmentIndex: 0,
          accountScopeKey,
          accountMasked,
          startedAtMs: taskMeta.startedAtMs ?? startSnapshot?.fetchedAtMs ?? null,
          endedAtMs: taskMeta.endedAtMs ?? endSnapshot?.fetchedAtMs ?? null,
          poolKey,
          windows: { '5h': w5h, 'weekly': w7d }
        }
      ],
      windows: {
        '5h': w5h,
        'weekly': w7d
      }
    };
  }

  /**
   * 同一任务渲染多条助手消息时，仅在任务终结回复挂载一次任务级额度摘要，避免重复计入每条回复
   */
  function attachTaskQuotaToReplies(taskObservation, replyIds = []) {
    const cleanIds = Array.isArray(replyIds)
      ? replyIds.map(id => String(id || '').trim()).filter(Boolean)
      : [];
    if (!cleanIds.length) return [];
    const terminalIdx = cleanIds.length - 1;
    return cleanIds.map((replyId, idx) => ({
      replyId,
      taskId: taskObservation?.taskId || null,
      isTaskTerminalReply: idx === terminalIdx,
      taskQuotaSummary: idx === terminalIdx ? taskObservation : null
    }));
  }

  /**
   * 有状态单任务额度观测跟踪器
   * - 零主动远端轮询：只读提交前最新有效快照，终结后被动等待宿主自然更新或手动点击返回
   * - 稳定幂等键 taskId::accountScopeKey::poolKey::windowKey，晚到补记最多写入一次
   */
  function createTaskQuotaTracker(options = {}) {
    const syncWindowMs = Number.isFinite(Number(options.syncWindowMs))
      ? Math.max(1000, Number(options.syncWindowMs))
      : DEFAULT_SYNC_WINDOW_MS;
    const staleThresholdMs = Number.isFinite(Number(options.staleThresholdMs))
      ? Math.max(5000, Number(options.staleThresholdMs))
      : DEFAULT_STALE_SNAPSHOT_MS;

    const latestSnapByAccount = new Map();
    const tasksById = new Map();
    const settledWriteKeys = new Set();

    function buildWriteKey(taskId, accountScopeKey, poolKey, windowKey) {
      return `${taskId}::${accountScopeKey || 'none'}::${poolKey || 'none'}::${windowKey}`;
    }

    function recordSnapshot(rawHostResult, opts = {}) {
      const snap = normalizeHostQuotaSnapshot(rawHostResult, { ...opts, staleThresholdMs });
      if (!snap || !snap.accountScopeKey) return snap;
      const prev = latestSnapByAccount.get(snap.accountScopeKey);
      if (snap.isFresh && (!prev || snap.fetchedAtMs >= prev.fetchedAtMs)) {
        latestSnapByAccount.set(snap.accountScopeKey, snap);
      }
      if (snap.isFresh) {
        reconcilePendingTasksWithSnapshot(snap, opts.nowMs ?? snap.fetchedAtMs);
      }
      return snap;
    }

    function findOverlappingTasks(task) {
      const overlapped = [];
      for (const other of tasksById.values()) {
        if (other.taskId === task.taskId) continue;
        if (other.accountScopeKey !== task.accountScopeKey) continue;
        if (other.poolKey && task.poolKey && other.poolKey !== task.poolKey) continue;
        const aStart = task.startedAtMs;
        const aEnd = task.endedAtMs ?? Infinity;
        const bStart = other.startedAtMs;
        const bEnd = other.endedAtMs ?? Infinity;
        if (aStart <= bEnd && bStart <= aEnd) {
          overlapped.push(other.taskId);
        }
      }
      return overlapped;
    }

    function recomputeTask(task, nowMs) {
      const overlapped = Array.from(new Set([...task.concurrentTaskIds, ...findOverlappingTasks(task)]));
      task.concurrentTaskIds = overlapped;
      const obs = evaluateTaskQuotaDelta({
        startSnapshot: task.startSnapshot,
        endSnapshot: task.endSnapshot,
        taskMeta: {
          taskId: task.taskId,
          sessionId: task.sessionId,
          accountScopeKey: task.accountScopeKey,
          accountMasked: task.accountMasked,
          poolKey: task.poolKey,
          modelIds: Array.from(task.modelIds),
          taskStatus: task.taskStatus,
          startedAtMs: task.startedAtMs,
          endedAtMs: task.endedAtMs,
          syncWindowDeadlineMs: task.syncWindowDeadlineMs
        },
        concurrentTaskIds: overlapped,
        accountSegments: task.segments.length > 1 ? task.segments : null,
        nowMs
      });
      task.observation = obs;
      return obs;
    }

    function beginTask({ taskId, sessionId = null, accountScopeKey = null, accountMasked = null, poolKey = null, modelId = null, startSnapshot = null, nowMs = Date.now() } = {}) {
      const cleanId = String(taskId || '').trim();
      if (!cleanId) throw new Error('taskId is required');
      if (tasksById.has(cleanId)) return tasksById.get(cleanId).observation;

      const resolvedStart = startSnapshot
        ? (startSnapshot.schemaVersion === 1 ? startSnapshot : normalizeHostQuotaSnapshot(startSnapshot, { nowMs, staleThresholdMs }))
        : (accountScopeKey ? (latestSnapByAccount.get(accountScopeKey) || null) : null);

      // 起点只能取提交前同一账号有效快照，严禁事后回填基线
      const validStart = (resolvedStart && (!accountScopeKey || resolvedStart.accountScopeKey === accountScopeKey) && resolvedStart.fetchedAtMs <= nowMs)
        ? resolvedStart
        : null;

      const effAccount = accountScopeKey || validStart?.accountScopeKey || null;
      const effMasked = accountMasked || validStart?.accountMasked || null;
      const effPool = normalizePoolKey(poolKey || modelId) || null;
      const modelIds = new Set();
      if (modelId) modelIds.add(String(modelId).trim());

      const task = {
        taskId: cleanId,
        sessionId: sessionId ? String(sessionId).trim() : null,
        accountScopeKey: effAccount,
        accountMasked: effMasked,
        poolKey: effPool,
        modelIds,
        taskStatus: 'running',
        startedAtMs: nowMs,
        endedAtMs: null,
        syncWindowDeadlineMs: null,
        startSnapshot: validStart,
        endSnapshot: null,
        concurrentTaskIds: [],
        segments: [
          {
            accountScopeKey: effAccount,
            accountMasked: effMasked,
            poolKey: effPool,
            startedAtMs: nowMs,
            endedAtMs: null,
            startSnapshot: validStart,
            endSnapshot: null,
            concurrentTaskIds: []
          }
        ],
        observation: null
      };

      // 登记同账号同池的在途并发任务互相标记
      for (const existing of tasksById.values()) {
        if (existing.taskStatus === 'running' && existing.accountScopeKey && existing.accountScopeKey === effAccount) {
          if (!effPool || !existing.poolKey || existing.poolKey === effPool) {
            existing.concurrentTaskIds.push(cleanId);
            task.concurrentTaskIds.push(existing.taskId);
          }
        }
      }

      tasksById.set(cleanId, task);
      return recomputeTask(task, nowMs);
    }

    function recordModelCall(taskId, { modelId = null, poolKey = null } = {}) {
      const task = tasksById.get(String(taskId || '').trim());
      if (!task) return null;
      if (modelId) task.modelIds.add(String(modelId).trim());
      const resolvedPool = normalizePoolKey(poolKey || modelId);
      if (!task.poolKey && resolvedPool) {
        task.poolKey = resolvedPool;
        if (task.segments.length > 0 && !task.segments[task.segments.length - 1].poolKey) {
          task.segments[task.segments.length - 1].poolKey = resolvedPool;
        }
      }
      return recomputeTask(task, Date.now());
    }

    function recordAccountSwitch(taskId, { nextAccountScopeKey, nextAccountMasked = null, prevAccountEndSnapshot = null, nextAccountStartSnapshot = null, nowMs = Date.now() } = {}) {
      const task = tasksById.get(String(taskId || '').trim());
      if (!task || !nextAccountScopeKey) return null;
      const curSeg = task.segments[task.segments.length - 1];
      if (curSeg && curSeg.accountScopeKey === nextAccountScopeKey) return task.observation;

      if (curSeg) {
        curSeg.endedAtMs = nowMs;
        if (prevAccountEndSnapshot) {
          const normPrevEnd = prevAccountEndSnapshot.schemaVersion === 1
            ? prevAccountEndSnapshot
            : normalizeHostQuotaSnapshot(prevAccountEndSnapshot, { nowMs, staleThresholdMs });
          if (normPrevEnd && normPrevEnd.accountScopeKey === curSeg.accountScopeKey) {
            curSeg.endSnapshot = normPrevEnd;
          }
        }
      }

      const normNextStart = nextAccountStartSnapshot
        ? (nextAccountStartSnapshot.schemaVersion === 1
          ? nextAccountStartSnapshot
          : normalizeHostQuotaSnapshot(nextAccountStartSnapshot, { nowMs, staleThresholdMs }))
        : (latestSnapByAccount.get(nextAccountScopeKey) || null);
      const validNextStart = (normNextStart && normNextStart.accountScopeKey === nextAccountScopeKey) ? normNextStart : null;

      task.segments.push({
        accountScopeKey: nextAccountScopeKey,
        accountMasked: nextAccountMasked || validNextStart?.accountMasked || null,
        poolKey: task.poolKey,
        startedAtMs: nowMs,
        endedAtMs: null,
        startSnapshot: validNextStart,
        endSnapshot: null,
        concurrentTaskIds: []
      });
      task.accountScopeKey = nextAccountScopeKey;
      task.accountMasked = nextAccountMasked || validNextStart?.accountMasked || task.accountMasked;
      return recomputeTask(task, nowMs);
    }

    function finishTask(taskId, { taskStatus = 'completed', endSnapshot = null, nowMs = Date.now() } = {}) {
      const task = tasksById.get(String(taskId || '').trim());
      if (!task) return null;
      task.taskStatus = String(taskStatus || 'completed').trim().toLowerCase();
      task.endedAtMs = nowMs;
      task.syncWindowDeadlineMs = nowMs + syncWindowMs;

      const curSeg = task.segments[task.segments.length - 1];
      if (curSeg) curSeg.endedAtMs = nowMs;

      if (endSnapshot) {
        const normEnd = endSnapshot.schemaVersion === 1
          ? endSnapshot
          : normalizeHostQuotaSnapshot(endSnapshot, { nowMs, staleThresholdMs });
        applyEndSnapshotToTask(task, normEnd, nowMs);
      } else {
        recomputeTask(task, nowMs);
      }
      return task.observation;
    }

    function applyEndSnapshotToTask(task, snap, nowMs) {
      if (!task || !snap || !snap.isFresh) return false;
      if (task.endedAtMs !== null && snap.fetchedAtMs < task.endedAtMs) return false;
      if (task.syncWindowDeadlineMs !== null && snap.fetchedAtMs > task.syncWindowDeadlineMs) {
        recomputeTask(task, nowMs);
        return false;
      }

      const targetSeg = task.segments[task.segments.length - 1];
      if (!targetSeg || targetSeg.accountScopeKey !== snap.accountScopeKey) return false;

      // 幂等补记校验：已落定的稳定键绝不重复覆写
      const key5h = buildWriteKey(task.taskId, targetSeg.accountScopeKey, targetSeg.poolKey || task.poolKey, '5h');
      const key7d = buildWriteKey(task.taskId, targetSeg.accountScopeKey, targetSeg.poolKey || task.poolKey, 'weekly');
      if (settledWriteKeys.has(key5h) && settledWriteKeys.has(key7d)) {
        return false;
      }

      if (task.segments.length === 1) {
        task.endSnapshot = snap;
      }
      targetSeg.endSnapshot = snap;
      const obs = recomputeTask(task, nowMs);

      const finalSeg = obs.accountSegments[obs.accountSegments.length - 1];
      if (finalSeg?.windows?.['5h']?.settled) settledWriteKeys.add(key5h);
      if (finalSeg?.windows?.['weekly']?.settled) settledWriteKeys.add(key7d);
      return true;
    }

    function reconcilePendingTasksWithSnapshot(snap, nowMs = Date.now()) {
      let updated = 0;
      for (const task of tasksById.values()) {
        if (task.taskStatus === 'running') continue;
        if (applyEndSnapshotToTask(task, snap, nowMs)) updated += 1;
      }
      return updated;
    }

    function getTaskObservation(taskId, nowMs = Date.now()) {
      const task = tasksById.get(String(taskId || '').trim());
      if (!task) return null;
      return recomputeTask(task, nowMs);
    }

    return {
      recordSnapshot,
      beginTask,
      recordModelCall,
      recordAccountSwitch,
      finishTask,
      getTaskObservation,
      getLatestSnapshot: (accountScopeKey) => latestSnapByAccount.get(accountScopeKey) || null,
      getSettledWriteCount: () => settledWriteKeys.size
    };
  }

  /**
   * 紧凑尾标单周期文案（严格三语零中英文括号，统一 5H/7D 大写）
   */
  function formatTaskQuotaWindowCompact(winObj, lang = 'zh-CN') {
    if (!winObj || typeof winObj !== 'object') return '';
    const tag = formatQuotaWindowDisplayTag(winObj.windowDisplay || winObj.windowKey);
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';

    const labels = {
      observed: isEn ? 'Obs' : (isTw ? '觀測' : '观测'),
      pending_sync: isEn ? 'Pending' : (isTw ? '待同步' : '待同步'),
      concurrent_ambiguous: isEn ? 'Concurrent' : (isTw ? '併發' : '并发'),
      reset_crossed: isEn ? 'Reset' : (isTw ? '已重設' : '已重置'),
      rebounded: isEn ? 'Rebounded' : (isTw ? '已回升' : '已回升'),
      account_switched: isEn ? 'Switched' : (isTw ? '已切號' : '已切号'),
      missing: isEn ? 'N/A' : (isTw ? '缺樣本' : '缺样本'),
      unavailable: isEn ? 'Unavailable' : (isTw ? '不可用' : '不可用')
    };

    switch (winObj.status) {
      case 'observed':
        return `${tag} −${formatPpNumber(winObj.deltaPp)}% ${labels.observed}`;
      case 'observed_zero':
        return `${tag} 0% ${labels.observed}`;
      case 'concurrent_ambiguous':
        return winObj.deltaPp !== null
          ? `${tag} −${formatPpNumber(winObj.deltaPp)}% ${labels.concurrent_ambiguous}`
          : `${tag} ${labels.concurrent_ambiguous}`;
      case 'pending_sync':
        return `${tag} ${labels.pending_sync}`;
      case 'reset_crossed':
        return `${tag} ${labels.reset_crossed}`;
      case 'rebounded':
        return `${tag} ${labels.rebounded}`;
      case 'account_switched':
        return `${tag} ${labels.account_switched}`;
      case 'missing_start':
      case 'missing_end':
      case 'stale_snapshot':
        return `${tag} ${labels.missing}`;
      default:
        return `${tag} ${labels.unavailable}`;
    }
  }

  function formatTaskQuotaCompact(taskObservation, lang = 'zh-CN') {
    if (!taskObservation || !taskObservation.windows) return '';
    const p5 = formatTaskQuotaWindowCompact(taskObservation.windows['5h'], lang);
    const p7 = formatTaskQuotaWindowCompact(taskObservation.windows['weekly'], lang);
    return [p5, p7].filter(Boolean).join(' · ');
  }

  function formatTaskQuotaDetail(taskObservation, lang = 'zh-CN') {
    if (!taskObservation) return null;
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';
    const unitLabel = isEn ? 'percentage points' : (isTw ? '百分點' : '百分点');
    const sourceLabel = isEn ? 'Host local quota snapshot' : (isTw ? '宿主本地額度快照' : '宿主本地额度快照');

    const summarizeWin = (w) => {
      if (!w) return null;
      const tag = formatQuotaWindowDisplayTag(w.windowDisplay || w.windowKey);
      const beforePct = w.before?.remainingPct != null ? `${formatPpNumber(w.before.remainingPct)}%` : '—';
      const afterPct = w.after?.remainingPct != null ? `${formatPpNumber(w.after.remainingPct)}%` : '—';
      const deltaText = w.deltaPp != null
        ? `${formatPpNumber(w.deltaPp)} ${unitLabel}`
        : formatTaskQuotaWindowCompact(w, lang);
      return {
        windowKey: w.windowKey,
        windowDisplay: tag,
        status: w.status,
        attributionKind: w.attributionKind,
        deltaPp: w.deltaPp,
        deltaText,
        rangeText: `${beforePct} -> ${afterPct}`,
        sourceLabel,
        reasonCode: w.reasonCode || null,
        beforeSampledAtMs: w.before?.sampledAtMs ?? null,
        afterSampledAtMs: w.after?.sampledAtMs ?? null
      };
    };

    return {
      taskId: taskObservation.taskId,
      sessionId: taskObservation.sessionId,
      accountMasked: taskObservation.accountMasked || null,
      poolKey: taskObservation.poolKey || null,
      modelIds: taskObservation.modelIds || [],
      taskStatus: taskObservation.taskStatus,
      accountSwitched: Boolean(taskObservation.accountSwitched),
      compactText: formatTaskQuotaCompact(taskObservation, lang),
      windows: {
        '5h': summarizeWin(taskObservation.windows?.['5h']),
        'weekly': summarizeWin(taskObservation.windows?.['weekly'])
      },
      accountSegments: (taskObservation.accountSegments || []).map(seg => ({
        segmentIndex: seg.segmentIndex,
        accountMasked: seg.accountMasked || null,
        poolKey: seg.poolKey || null,
        windows: {
          '5h': summarizeWin(seg.windows?.['5h']),
          'weekly': summarizeWin(seg.windows?.['weekly'])
        }
      }))
    };
  }

  const exportsObj = {
    AUTHORITATIVE_QUOTA_SOURCE,
    DEFAULT_SYNC_WINDOW_MS,
    DEFAULT_STALE_SNAPSHOT_MS,
    formatQuotaWindowDisplayTag,
    normalizeWindowKey,
    maskAccountIdentity,
    normalizeHostQuotaSnapshot,
    evaluateTaskQuotaDelta,
    attachTaskQuotaToReplies,
    createTaskQuotaTracker,
    formatTaskQuotaWindowCompact,
    formatTaskQuotaCompact,
    formatTaskQuotaDetail
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
  }
  if (root && typeof root === 'object') {
    root.__AGTaskQuota = exportsObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
