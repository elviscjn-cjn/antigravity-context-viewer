'use strict';
/**
 * 07 第三层：左栏上下文洞察全页（含回归 #3 完整视觉对齐与主内容区全页路由接管）+ 会话四视角 + Orchestrator 两位小机器人编排分工组件
 *
 * 规格对齐（07 §9 + 回归 #3）：
 * 1. 左栏上下文洞察入口：
 *    - 锚定宿主左栏 Customizations / 自定义扩展（[data-testid="plugins-button"]）与 Projects 之间；
 *    - 100% 对齐上方官方导航项（新建会话 / 自动化 / 自定义扩展）：补齐同尺寸 16x16 线条图标、常规字重、
 *      文字色、行高、左内边距与悬停/选中胶囊底色（动态采集相邻未选中官方导航项的计算样式，适配深浅主题与宿主版本变化）；
 *    - 点击立刻在主内容区全屏展开完整上下文洞察大盘并互斥清除其余导航高亮；
 *    - 点击任意会话、新建会话、自动化、自定义扩展或设置时单帧无缝切回原生界面，无残留、无双高亮，
 *      完整保留原生会话滚动、草稿、焦点与 Browser；打开零新模型请求与远端额度探针。
 * 2. 会话四视角分段切换：「对话 · 轨迹 · 上下文 · 编队」，默认「对话」，按 paneId/sessionId 隔离。
 * 3. Orchestrator 编排分工可视化：左侧规划机器人、右侧执行机器人、真实事件驱动交接箭头与时间线。
 */
(function (rootScope) {
  const INSIGHTS_STYLE_ID = 'ag-insights-views-orch-style';
  const SIDEBAR_INSIGHTS_STYLE_ID = 'ag-sidebar-insights-host-style';
  const SIDEBAR_INSIGHTS_BTN_ID = 'ag-sidebar-insights-btn';
  const INSIGHTS_FULLPAGE_ID = 'ag-context-insights-page';
  const PROFILE_HOME_PAGE_ID = 'ag-profile-home-page';
  const FULLPAGE_Z_INDEX = 20;
  const SESSION_VIEW_KEYS = Object.freeze(['chat', 'trace', 'context', 'squad']);
  const HEATMAP_METRIC_KEYS = Object.freeze(['tokens', 'sessions', 'requests', 'cost']);
  const PROFILE_HEATMAP_MODES = Object.freeze(['daily', 'weekly', 'cumulative']);

  const INSIGHTS_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      sidebarNavLabel: '详细上下文',
      pageTitle: '详细上下文',
      pageSubtitle: '桌面与 CLI 本地合并账本 · 会话上下文、Token 消耗与活跃度总览',
      backToChat: '返回对话',
      refreshData: '刷新数据',
      openSettings: '插件设置',
      openProfileHome: '个人用量主页',
      dateRangeAll: '全部时间',
      dateRange7d: '近 7 天',
      dateRange30d: '近 30 天',
      sourceAll: '全部来源',
      sourceDesktop: '桌面端',
      sourceCli: 'CLI',
      allAccounts: '全部账号',
      includeArchived: '含已归档',
      searchPlaceholder: '搜索会话标题、项目或编号',
      kpiSessions: '全部会话',
      kpiArchivedSub: '已归档',
      kpiTokens: 'Token 消耗',
      kpiTurnsSub: '轮',
      kpiApiCost: '预估费用',
      kpiPricedSub: '已计价会话',
      kpiCacheHit: '缓存命中率',
      kpiComputedSub: '参与计算',
      kpiToolCalls: '工具调用',
      kpiActiveTime: '活跃时长',
      kpiModelCallsSub: '次模型调用',
      chart7dTitle: '近 7 天用量',
      chart30dTitle: '近 30 天用量',
      chartAllTitle: '每日用量趋势',
      chart7dEmpty: '暂无近 7 天消耗记录',
      chart7dTokensLegend: 'Token 用量',
      chart7dCostLegend: '估算费用',
      heatmapTitle: '活跃度',
      heatmapModeSessions: '会话',
      heatmapModeTokens: 'Token 消耗',
      heatmapClearDay: '取消日期筛选',
      heatmapDayDetail: '当日详情',
      heatmapLegendLess: '少',
      heatmapLegendMore: '多',
      tokenStatsTitle: 'Token 统计',
      timingStatsTitle: '耗时统计',
      timingWaitLabel: '首字等待',
      timingGenLabel: '模型生成',
      timingToolLabel: '工具执行',
      timingEmpty: '暂无可采集耗时记录',
      distTitle: 'Token 构成与耗时分布',
      distInput: '新增输入',
      distCache: '缓存读取',
      distOutput: '模型输出',
      distAvgTtft: '平均首字延迟',
      distAvgTps: '平均输出速度',
      distAvgDur: '平均请求耗时',
      distMaxDur: '最长请求耗时',
      rankProjectsTitle: '项目分布',
      rankSkillsTitle: '技能加载',
      rankToolsTitle: '工具调用',
      rankCommandsTitle: '命令执行',
      rankEmpty: '暂无相关记录',
      sessionsTitle: '会话列表',
      filterAllProjects: '全部',
      archiveAll: '全部会话',
      archiveActive: '仅活跃',
      archiveOnly: '仅已归档',
      sortRecent: '最近更新',
      sortTokens: 'Token 总用量',
      sortContext: '当前上下文',
      pagePrev: '上一页',
      pageNext: '下一页',
      emptySessions: '当前筛选条件下暂无本地会话记录',
      sessionCacheTag: '缓存命中',
      sessionCallsTag: '次调用',
      heatmapMetrics: Object.freeze({
        tokens: 'Token',
        sessions: '会话',
        requests: '请求',
        cost: '参考费用'
      }),
      profileTitle: '个人用量主页',
      profileGuest: '当前账号',
      profileUnbound: '本地账本聚合视图',
      profileStatTotal: '累计 Token 数',
      profileStatPeak: 'Token 使用峰值',
      profileStatLongestTask: '最长任务用时',
      profileStatLongestStreak: '最长连续使用天数',
      profileStatCurrentStreak: '当前连续使用天数',
      profileStreakUnit: '天',
      profileHeatmapTitle: 'Token 活动热力图',
      profileHeatmapModes: Object.freeze({
        daily: '每天',
        weekly: '每周',
        monthly: '每月',
        yearly: '今年',
        cumulative: '累计总量'
      }),
      profileSubtabs: Object.freeze({
        tokens: 'Token 统计',
        models: '按模型',
        cost: 'API 参考金额',
        requests: '实时请求'
      }),
      profilePeriodAll: '累计处理',
      profilePeriodToday: '今日使用',
      profilePeriodMonth: '本月使用',
      profilePeriodYear: '年度使用',
      profileDailyAvg: '日均',
      profilePlanCompareTitle: '套餐档位参考对比',
      profilePlanCompareToggle: '展开档位明细',
      profilePlanCompareCollapse: '收起档位明细',
      profileCacheTotalInput: '总输入含缓存',
      profileCacheOutput: '模型输出',
      profileCacheWriteShare: '缓存写入与新增输入占比',
      profileCacheNote: '口径统一自本机真实账本，含桌面端与 CLI 合并统计',
      profilePaletteTitle: '热力图色阶与面板外观自定义',
      profilePaletteReset: '恢复默认色阶',
      profileCsiTitle: '跨会话全局洞察大盘',
      profile7dTitle: '近 7 天用量与估算费用',
      profileReqEmpty: '暂无近期请求记录',
      profileModelEmpty: '暂无按模型消耗记录',
      profileHeatmapStart: '起点',
      profileHeatmapToday: '今日',
      profileCacheTitle: '全量缓存总览',
      profileCacheGlobalHit: '全局缓存命中率',
      profileCacheSessionHit: '当前会话命中率',
      profileCacheReadTokens: '累计缓存读取',
      profileCacheWriteInput: '新增非缓存输入',
      profileCacheSavedEst: '预估节省参考费用',
      profileCacheByModel: '按模型缓存命中表现',
      profileCacheNoModel: '暂无按模型缓存明细',
      profileInsightsTitle: '洞察',
      profileInsightTopModel: '常用模型占比',
      profileInsightEffort: '推理强度占比',
      profileInsightCachePerf: '缓存命中表现',
      profileInsightSkillsExplored: '已探索技能数',
      profileInsightSkillsTotal: '使用技能总数',
      profileInsightToolsTotal: '工具调用总数',
      profileInsightSourceSplit: '桌面端与 CLI 占比',
      profileInsightActiveDays: '活跃天数与会话数',
      profileUnrecorded: '未记录',
      views: Object.freeze({
        chat: '对话',
        trace: '轨迹',
        context: '上下文',
        squad: '编队'
      }),
      viewSwitcherAria: '会话视角切换',
      emptySquad: '当前会话无子智能体记录',
      orchPlanner: '规划',
      orchExecutor: '执行',
      orchConfiguredOnly: '已配置',
      orchNotRecorded: '运行分工未记录',
      orchIdle: '等待任务事件',
      orchDualBusy: '规划与执行并行处理中',
      orchToExecutor: '交接给执行',
      orchBackToPlanner: '交回规划审查',
      orchTimelineTitle: '编排交接时间线',
      orchLocateTrace: '在轨迹中定位',
      orchRoleCalls: '对应调用',
      orchModelUnrecorded: '未记录'
    }),
    'zh-TW': Object.freeze({
      sidebarNavLabel: '詳細上下文',
      pageTitle: '詳細上下文',
      pageSubtitle: '桌面與 CLI 本機合併帳本 · 工作階段上下文、Token 消耗與活躍度總覽',
      backToChat: '返回對話',
      refreshData: '重新整理',
      openSettings: '外掛設定',
      openProfileHome: '個人用量主頁',
      dateRangeAll: '全部時間',
      dateRange7d: '近 7 天',
      dateRange30d: '近 30 天',
      sourceAll: '全部來源',
      sourceDesktop: '桌面端',
      sourceCli: 'CLI',
      allAccounts: '全部帳號',
      includeArchived: '含已封存',
      searchPlaceholder: '搜尋工作階段標題、專案或編號',
      kpiSessions: '全部工作階段',
      kpiArchivedSub: '已封存',
      kpiTokens: 'Token 消耗',
      kpiTurnsSub: '輪',
      kpiApiCost: '預估費用',
      kpiPricedSub: '已計價工作階段',
      kpiCacheHit: '快取命中率',
      kpiComputedSub: '參與計算',
      kpiToolCalls: '工具呼叫',
      kpiActiveTime: '活躍時長',
      kpiModelCallsSub: '次模型呼叫',
      chart7dTitle: '近 7 天用量',
      chart30dTitle: '近 30 天用量',
      chartAllTitle: '每日用量趨勢',
      chart7dEmpty: '暫無近 7 天消耗記錄',
      chart7dTokensLegend: 'Token 用量',
      chart7dCostLegend: '估算費用',
      heatmapTitle: '活躍度',
      heatmapModeSessions: '工作階段',
      heatmapModeTokens: 'Token 消耗',
      heatmapClearDay: '取消日期篩選',
      heatmapDayDetail: '當日詳情',
      heatmapLegendLess: '少',
      heatmapLegendMore: '多',
      tokenStatsTitle: 'Token 統計',
      timingStatsTitle: '耗時統計',
      timingWaitLabel: '首字等待',
      timingGenLabel: '模型生成',
      timingToolLabel: '工具執行',
      timingEmpty: '暫無可採集耗時記錄',
      distTitle: 'Token 構成與耗時分布',
      distInput: '新增輸入',
      distCache: '快取讀取',
      distOutput: '模型輸出',
      distAvgTtft: '平均首字延遲',
      distAvgTps: '平均輸出速度',
      distAvgDur: '平均請求耗時',
      distMaxDur: '最長請求耗時',
      rankProjectsTitle: '專案分布',
      rankSkillsTitle: '技能載入',
      rankToolsTitle: '工具呼叫',
      rankCommandsTitle: '命令執行',
      rankEmpty: '暫無相關記錄',
      sessionsTitle: '工作階段清單',
      filterAllProjects: '全部',
      archiveAll: '全部工作階段',
      archiveActive: '僅活躍',
      archiveOnly: '僅已封存',
      sortRecent: '最近更新',
      sortTokens: 'Token 總用量',
      sortContext: '目前上下文',
      pagePrev: '上一頁',
      pageNext: '下一頁',
      emptySessions: '目前篩選條件下暫無本機工作階段記錄',
      sessionCacheTag: '快取命中',
      sessionCallsTag: '次呼叫',
      heatmapMetrics: Object.freeze({
        tokens: 'Token',
        sessions: '工作階段',
        requests: '請求',
        cost: '參考費用'
      }),
      profileTitle: '個人用量主頁',
      profileGuest: '目前帳號',
      profileUnbound: '本機帳本聚合檢視',
      profileStatTotal: '累計 Token 數',
      profileStatPeak: 'Token 使用峰值',
      profileStatLongestTask: '最長任務用時',
      profileStatLongestStreak: '最長連續使用天數',
      profileStatCurrentStreak: '當前連續使用天數',
      profileStreakUnit: '天',
      profileHeatmapTitle: 'Token 活動熱力圖',
      profileHeatmapModes: Object.freeze({
        daily: '每天',
        weekly: '每週',
        monthly: '每月',
        yearly: '今年',
        cumulative: '累計總量'
      }),
      profileSubtabs: Object.freeze({
        tokens: 'Token 統計',
        models: '依模型',
        cost: 'API 參考金額',
        requests: '即時請求'
      }),
      profilePeriodAll: '累計處理',
      profilePeriodToday: '今日使用',
      profilePeriodMonth: '本月使用',
      profilePeriodYear: '年度使用',
      profileDailyAvg: '日均',
      profilePlanCompareTitle: '方案檔位參考對比',
      profilePlanCompareToggle: '展開檔位明細',
      profilePlanCompareCollapse: '收起檔位明細',
      profileCacheTotalInput: '總輸入含快取',
      profileCacheOutput: '模型輸出',
      profileCacheWriteShare: '快取寫入與新增輸入占比',
      profileCacheNote: '口徑統一自本機真實帳本，含桌面端與 CLI 合併統計',
      profilePaletteTitle: '熱力圖色階與面板外觀自訂',
      profilePaletteReset: '恢復預設色階',
      profileCsiTitle: '跨工作階段全域洞察大盤',
      profile7dTitle: '近 7 天用量與估算費用',
      profileReqEmpty: '暫無近期請求記錄',
      profileModelEmpty: '暫無依模型消耗記錄',
      profileHeatmapStart: '起點',
      profileHeatmapToday: '今日',
      profileCacheTitle: '全量快取總覽',
      profileCacheGlobalHit: '全域快取命中率',
      profileCacheSessionHit: '目前工作階段命中率',
      profileCacheReadTokens: '累計快取讀取',
      profileCacheWriteInput: '新增非快取輸入',
      profileCacheSavedEst: '預估節省參考費用',
      profileCacheByModel: '依模型快取命中表現',
      profileCacheNoModel: '暫無依模型快取明細',
      profileInsightsTitle: '洞察',
      profileInsightTopModel: '常用模型占比',
      profileInsightEffort: '推理強度占比',
      profileInsightCachePerf: '快取命中表現',
      profileInsightSkillsExplored: '已探索技能數',
      profileInsightSkillsTotal: '使用技能總數',
      profileInsightToolsTotal: '工具呼叫總數',
      profileInsightSourceSplit: '桌面端與 CLI 占比',
      profileInsightActiveDays: '活躍天數與工作階段數',
      profileUnrecorded: '未記錄',
      views: Object.freeze({
        chat: '對話',
        trace: '軌跡',
        context: '上下文',
        squad: '編隊'
      }),
      viewSwitcherAria: '工作階段視角切換',
      emptySquad: '目前工作階段無子智能體記錄',
      orchPlanner: '規劃',
      orchExecutor: '執行',
      orchConfiguredOnly: '已設定',
      orchNotRecorded: '執行分工未記錄',
      orchIdle: '等待任務事件',
      orchDualBusy: '規劃與執行並行處理中',
      orchToExecutor: '交接給執行',
      orchBackToPlanner: '交回規劃審查',
      orchTimelineTitle: '編排交接時間線',
      orchLocateTrace: '在軌跡中定位',
      orchRoleCalls: '對應呼叫',
      orchModelUnrecorded: '未記錄'
    }),
    en: Object.freeze({
      sidebarNavLabel: 'Context Details',
      pageTitle: 'Context Details',
      pageSubtitle: 'Merged desktop and CLI ledger · Session context, token usage, and activity overview',
      backToChat: 'Back to Chat',
      refreshData: 'Refresh',
      openSettings: 'Settings',
      openProfileHome: 'Usage Profile',
      dateRangeAll: 'All Time',
      dateRange7d: 'Last 7 Days',
      dateRange30d: 'Last 30 Days',
      sourceAll: 'All Sources',
      sourceDesktop: 'Desktop',
      sourceCli: 'CLI',
      allAccounts: 'All Accounts',
      includeArchived: 'Include archived',
      searchPlaceholder: 'Filter sessions by title, project, or id',
      kpiSessions: 'All Sessions',
      kpiArchivedSub: 'archived',
      kpiTokens: 'Token Usage',
      kpiTurnsSub: 'turns',
      kpiApiCost: 'Est. Cost',
      kpiPricedSub: 'priced sessions',
      kpiCacheHit: 'Cache Hit Rate',
      kpiComputedSub: 'measured',
      kpiToolCalls: 'Tool Calls',
      kpiActiveTime: 'Active Time',
      kpiModelCallsSub: 'model calls',
      chart7dTitle: 'Last 7 Days Usage',
      chart30dTitle: 'Last 30 Days Usage',
      chartAllTitle: 'Daily Usage Trend',
      chart7dEmpty: 'No usage recorded in the last 7 days',
      chart7dTokensLegend: 'Tokens',
      chart7dCostLegend: 'Est. Cost',
      heatmapTitle: 'Activity',
      heatmapModeSessions: 'Sessions',
      heatmapModeTokens: 'Tokens',
      heatmapClearDay: 'Clear day filter',
      heatmapDayDetail: 'Day Details',
      heatmapLegendLess: 'Less',
      heatmapLegendMore: 'More',
      tokenStatsTitle: 'Token Stats',
      timingStatsTitle: 'Latency Stats',
      timingWaitLabel: 'TTFT Wait',
      timingGenLabel: 'Generation',
      timingToolLabel: 'Tool Exec',
      timingEmpty: 'No latency records yet',
      distTitle: 'Token Mix and Latency',
      distInput: 'Uncached Input',
      distCache: 'Cache Read',
      distOutput: 'Output',
      distAvgTtft: 'Avg TTFT',
      distAvgTps: 'Avg Output Speed',
      distAvgDur: 'Avg Request Time',
      distMaxDur: 'Max Request Time',
      rankProjectsTitle: 'Projects',
      rankSkillsTitle: 'Skills',
      rankToolsTitle: 'Tools',
      rankCommandsTitle: 'Commands',
      rankEmpty: 'No records yet',
      sessionsTitle: 'Sessions',
      filterAllProjects: 'All',
      archiveAll: 'All sessions',
      archiveActive: 'Active only',
      archiveOnly: 'Archived only',
      sortRecent: 'Recent',
      sortTokens: 'Total Tokens',
      sortContext: 'Context',
      pagePrev: 'Prev',
      pageNext: 'Next',
      emptySessions: 'No local sessions match current filters',
      sessionCacheTag: 'Cache',
      sessionCallsTag: 'calls',
      heatmapMetrics: Object.freeze({
        tokens: 'Tokens',
        sessions: 'Sessions',
        requests: 'Requests',
        cost: 'Ref Cost'
      }),
      profileTitle: 'Token Usage Profile',
      profileGuest: 'Active Account',
      profileUnbound: 'Local Ledger Overview',
      profileStatTotal: 'Total Tokens',
      profileStatPeak: 'Peak Usage',
      profileStatLongestTask: 'Longest Task',
      profileStatLongestStreak: 'Longest Streak',
      profileStatCurrentStreak: 'Current Streak',
      profileStreakUnit: 'd',
      profileHeatmapTitle: 'Token Activity Heatmap',
      profileHeatmapModes: Object.freeze({
        daily: 'Daily',
        weekly: 'Weekly',
        monthly: 'Monthly',
        yearly: 'This Year',
        cumulative: 'Cumulative'
      }),
      profileSubtabs: Object.freeze({
        tokens: 'Token Stats',
        models: 'By Model',
        cost: 'API Ref Cost',
        requests: 'Live Requests'
      }),
      profilePeriodAll: 'All Time',
      profilePeriodToday: 'Today',
      profilePeriodMonth: 'This Month',
      profilePeriodYear: 'This Year',
      profileDailyAvg: 'Avg/day',
      profilePlanCompareTitle: 'Plan Tier Comparison',
      profilePlanCompareToggle: 'Show tier details',
      profilePlanCompareCollapse: 'Hide tier details',
      profileCacheTotalInput: 'Total Input incl. Cache',
      profileCacheOutput: 'Model Output',
      profileCacheWriteShare: 'Cache Write and Uncached Share',
      profileCacheNote: 'Unified from local ledger combining desktop and CLI usage',
      profilePaletteTitle: 'Heatmap Palette and Appearance',
      profilePaletteReset: 'Reset Palette',
      profileCsiTitle: 'Cross-Session Insights Overview',
      profile7dTitle: 'Last 7 Days Usage and Est. Cost',
      profileReqEmpty: 'No recent request logs yet',
      profileModelEmpty: 'No per-model usage records yet',
      profileHeatmapStart: 'Start',
      profileHeatmapToday: 'Today',
      profileCacheTitle: 'Unified Cache Overview',
      profileCacheGlobalHit: 'Global Cache Hit',
      profileCacheSessionHit: 'Active Session Hit',
      profileCacheReadTokens: 'Total Cache Read',
      profileCacheWriteInput: 'Uncached Input',
      profileCacheSavedEst: 'Est. Cost Saved',
      profileCacheByModel: 'Cache Hit by Model',
      profileCacheNoModel: 'No per-model cache breakdown yet',
      profileInsightsTitle: 'Insights',
      profileInsightTopModel: 'Top Model',
      profileInsightEffort: 'Reasoning Effort Mix',
      profileInsightCachePerf: 'Cache Performance',
      profileInsightSkillsExplored: 'Skills Explored',
      profileInsightSkillsTotal: 'Total Skill Uses',
      profileInsightToolsTotal: 'Total Tool Calls',
      profileInsightSourceSplit: 'Desktop vs CLI Share',
      profileInsightActiveDays: 'Active Days and Sessions',
      profileUnrecorded: 'Unrecorded',
      views: Object.freeze({
        chat: 'Chat',
        trace: 'Trace',
        context: 'Context',
        squad: 'Squad'
      }),
      viewSwitcherAria: 'Session view switcher',
      emptySquad: 'No verified subagents in this session',
      orchPlanner: 'Planner',
      orchExecutor: 'Executor',
      orchConfiguredOnly: 'Configured',
      orchNotRecorded: 'Runtime split not recorded',
      orchIdle: 'Waiting for events',
      orchDualBusy: 'Planner and Executor active in parallel',
      orchToExecutor: 'Handed off to Executor',
      orchBackToPlanner: 'Returned to Planner for review',
      orchTimelineTitle: 'Orchestration Handoff Timeline',
      orchLocateTrace: 'Locate in Trace',
      orchRoleCalls: 'Calls',
      orchModelUnrecorded: 'Unrecorded'
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  function getInsightsCopy(lang) {
    return INSIGHTS_I18N[resolveLang(lang)] || INSIGHTS_I18N['zh-CN'];
  }

  const SIDEBAR_INSIGHTS_HOST_CSS = `
    #${SIDEBAR_INSIGHTS_BTN_ID} {
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      border: none !important;
      text-align: left !important;
      cursor: pointer !important;
      outline: none !important;
      background: transparent !important;
      color: var(--ag-si-inactive-color, var(--secondary-foreground, var(--foreground, inherit))) !important;
      opacity: var(--ag-si-inactive-opacity, 1) !important;
      transition: background-color 120ms ease, color 120ms ease !important;
      user-select: none !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID}:hover {
      background: var(--ag-si-hover-bg, var(--sidebar-muted, rgba(128, 128, 128, 0.12))) !important;
      color: var(--ag-si-active-color, var(--foreground, inherit)) !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID}:focus-visible {
      outline: 2px solid var(--primary, var(--ag-host-accent, #3274f6)) !important;
      outline-offset: -1px !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID}[data-active="true"],
    #${SIDEBAR_INSIGHTS_BTN_ID}[aria-current="page"] {
      background: var(--ag-si-active-bg, var(--sidebar-secondary, var(--secondary, rgba(128, 128, 128, 0.18)))) !important;
      color: var(--ag-si-active-color, var(--foreground, inherit)) !important;
      opacity: 1 !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID} .ag-sidebar-insights-icon-wrap {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex: 0 0 auto !important;
      pointer-events: none !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID} .ag-sidebar-insights-icon {
      display: block !important;
      flex: 0 0 auto !important;
      pointer-events: none !important;
    }
    #${SIDEBAR_INSIGHTS_BTN_ID} .ag-sidebar-insights-label {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      font: inherit !important;
      line-height: inherit !important;
      letter-spacing: inherit !important;
      color: inherit !important;
    }
    [data-ag-insights-active="true"] [data-ag-si-muted="true"] {
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
    }
    #${INSIGHTS_FULLPAGE_ID},
    #${PROFILE_HOME_PAGE_ID} {
      position: absolute !important;
      inset: 0 !important;
      z-index: ${FULLPAGE_Z_INDEX} !important;
      display: flex !important;
      flex-direction: column !important;
      box-sizing: border-box !important;
      width: 100% !important;
      max-width: 100% !important;
      height: 100% !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      container-type: inline-size !important;
      container-name: ag-ci-page !important;
      scroll-behavior: smooth !important;
      background-color: var(--ag-si-page-bg, var(--background, #151518)) !important;
      background: var(--ag-si-page-bg, var(--background, #151518)) !important;
      opacity: 1 !important;
      color: var(--foreground, #ececef) !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif !important;
      -webkit-font-smoothing: antialiased;
    }
    #${INSIGHTS_FULLPAGE_ID}[hidden],
    #${PROFILE_HOME_PAGE_ID}[hidden] {
      display: none !important;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-shell {
      width: 100%;
      max-width: 1360px;
      min-width: 0;
      margin: 0 auto;
      padding: 20px 22px 48px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-title {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--foreground, #f4f4f6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-subtitle {
      margin: 4px 0 0;
      font-size: 12.5px;
      color: var(--muted-foreground, #9a9aa6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-btn {
      height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
      background: var(--secondary, rgba(128, 128, 128, 0.12));
      color: var(--foreground, #ececef);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-btn:hover {
      background: var(--muted, rgba(128, 128, 128, 0.2));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-filters {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.06));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-seg {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--secondary, rgba(128, 128, 128, 0.08));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-seg-btn {
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--muted-foreground, #9a9aa6);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 5px 11px;
      cursor: pointer;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-seg-btn[aria-pressed="true"] {
      background: var(--background, rgba(255, 255, 255, 0.14));
      color: var(--foreground, #ffffff);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-search {
      height: 30px;
      min-width: 180px;
      flex: 1 1 200px;
      max-width: 300px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.26));
      background: var(--input, rgba(128, 128, 128, 0.08));
      color: var(--foreground, #ececef);
      font-family: inherit;
      font-size: 12.5px;
      outline: none;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-card {
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.06));
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-label {
      font-size: 11.5px;
      color: var(--muted-foreground, #9a9aa6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-val {
      font-size: 20px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--foreground, #f4f4f6);
      line-height: 1.25;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-card {
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.05));
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-card-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-card-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--foreground, #f4f4f6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heatmap-grid {
      display: grid;
      grid-template-columns: repeat(14, minmax(10px, 1fr));
      gap: 4px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cell {
      aspect-ratio: 1 / 1;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.14);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--primary, #3274f6) 28%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--primary, #3274f6) 52%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--primary, #3274f6) 76%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cell[data-level="4"] { background: var(--primary, #3274f6); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      border-radius: 9px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.16));
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
      width: 100%;
      font-family: inherit;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-row:hover {
      background: var(--secondary, rgba(128, 128, 128, 0.10));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 500;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-meta {
      flex: 0 0 auto;
      font-size: 12px;
      color: var(--muted-foreground, #9a9aa6);
      font-variant-numeric: tabular-nums;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-sub {
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 14px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-3 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-bars {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 10px;
      align-items: end;
      height: 126px;
      padding-top: 8px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      height: 100%;
      justify-content: flex-end;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-pair {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 86px;
      width: 100%;
      justify-content: center;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-bar-tok {
      width: 12px;
      border-radius: 4px 4px 2px 2px;
      background: var(--primary, var(--ag-host-accent, #3274f6));
      min-height: 3px;
      transition: height 180ms ease;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-bar-cost {
      width: 10px;
      border-radius: 4px 4px 2px 2px;
      background: color-mix(in srgb, var(--primary, #3274f6) 46%, #10b981);
      min-height: 3px;
      transition: height 180ms ease;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-7d-lbl {
      font-size: 10.5px;
      color: var(--muted-foreground, #9a9aa6);
      font-variant-numeric: tabular-nums;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-stack-bar,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-stack-bar {
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.16);
      overflow: hidden;
      display: flex;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-name {
      flex: 1 1 72px;
      min-width: 56px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-track {
      display: block;
      width: 56px;
      height: 5px;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.16);
      overflow: hidden;
      flex: 0 0 56px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-fill {
      display: block !important;
      height: 100% !important;
      min-height: 5px;
      border-radius: 999px;
      background: var(--ag-host-accent, var(--primary, #3274f6));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-4 {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      min-width: 0;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-row1-overview {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      align-items: stretch;
      min-width: 0;
    }
    @container ag-ci-page (max-width: 1020px) {
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-row1-overview {
        grid-template-columns: 1fr;
      }
    }
    @container ag-ci-page (max-width: 960px) {
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-4 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @container ag-ci-page (max-width: 720px) {
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-2 {
        grid-template-columns: 1fr;
      }
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-track {
        width: 44px;
        flex: 0 0 44px;
      }
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-shell {
        padding: 16px 14px 40px;
      }
    }
    @container ag-ci-page (max-width: 520px) {
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-grid-4 {
        grid-template-columns: 1fr;
      }
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-grid-2x3 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      min-width: 0;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-kpi-sub {
      font-size: 11px;
      color: var(--muted-foreground, #8e8e9c);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-range-bars {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 136px;
      padding-top: 8px;
      overflow-x: auto;
      min-width: 0;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-range-col {
      flex: 1 1 0;
      min-width: 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      height: 100%;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-range-pair {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 2px;
      height: 98px;
      width: 100%;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-heat-wrap {
      display: flex;
      align-items: stretch;
      gap: 3px;
      overflow-x: auto;
      padding: 4px 0 6px;
      min-height: 96px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-col {
      flex: 1 0 12px;
      min-width: 12px;
      max-width: 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn {
      appearance: none;
      border: 1px solid transparent;
      padding: 0;
      margin: 0;
      width: 100%;
      flex: 1 1 auto;
      min-height: 58px;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.14);
      cursor: pointer;
      display: block;
      transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn:hover {
      border-color: var(--ag-host-accent, var(--primary, #3274f6));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn[data-level="1"] { background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 26%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn[data-level="2"] { background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 50%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn[data-level="3"] { background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 74%, transparent); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn[data-level="4"] { background: var(--ag-host-accent, var(--primary, #3274f6)); }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-btn[data-selected="true"] {
      border-color: #ffffff;
      box-shadow: 0 0 0 2px var(--ag-host-accent, var(--primary, #3274f6));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-day-lbl {
      font-size: 9.5px;
      color: var(--muted-foreground, #8e8e9c);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-detail-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 40%, transparent);
      background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 10%, transparent);
      font-size: 11.5px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-donut-row {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-donut-svg {
      width: 96px;
      height: 96px;
      flex: 0 0 96px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-donut-legend {
      flex: 1 1 160px;
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px 12px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-legend-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 12px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-legend-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: 0 0 8px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-proj-pills {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-select {
      height: 30px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.26));
      background: var(--secondary, rgba(128, 128, 128, 0.1));
      color: var(--foreground, #ececef);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 10px;
    }
    @media (min-width: 1260px) {
      #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-grid {
        grid-template-columns: repeat(auto-fill, minmax(205px, 1fr));
      }
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-card {
      appearance: none;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      gap: 8px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
      background: var(--card, rgba(128, 128, 128, 0.05));
      color: inherit;
      text-align: left;
      cursor: pointer;
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-session-card:hover {
      border-color: var(--ag-host-accent, var(--primary, #3274f6));
      background: var(--secondary, rgba(128, 128, 128, 0.1));
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
      color: var(--foreground, #f4f4f6);
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      flex: 1 1 auto;
      min-width: 0;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-time {
      font-size: 11px;
      color: var(--muted-foreground, #8e8e9c);
      white-space: nowrap;
      flex: 0 0 auto;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-tag {
      display: inline-flex;
      align-items: center;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 14%, transparent);
      color: var(--foreground, #ececef);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      align-self: flex-start;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-body {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-ring-box {
      position: relative;
      width: 44px;
      height: 44px;
      flex: 0 0 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-ring-txt {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--foreground, #f4f4f6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-metrics {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
      font-variant-numeric: tabular-nums;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-sc-snippet {
      font-size: 11px;
      color: var(--muted-foreground, #8e8e9c);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-pagination {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding-top: 6px;
      font-size: 12px;
      color: var(--muted-foreground, #9a9aa6);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-rank-val {
      font-size: 11.5px;
      font-variant-numeric: tabular-nums;
      color: var(--muted-foreground, #9a9aa6);
      min-width: 34px;
      text-align: right;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-scroll,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-scroll {
      overflow-x: auto;
      padding-bottom: 4px;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-cols,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-cols {
      display: inline-flex;
      flex-direction: row;
      gap: 4px;
      min-width: 100%;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-week,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-week {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 0 0 auto;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot {
      width: 11px;
      height: 11px;
      border-radius: 3.5px;
      background: rgba(128, 128, 128, 0.14);
      display: block;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot[data-future="true"],
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot[data-future="true"] {
      opacity: 0.35;
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot[data-level="1"],
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot[data-level="1"] {
      background: color-mix(in srgb, var(--primary, var(--ag-host-accent, #3274f6)) 26%, transparent);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot[data-level="2"],
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot[data-level="2"] {
      background: color-mix(in srgb, var(--primary, var(--ag-host-accent, #3274f6)) 50%, transparent);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot[data-level="3"],
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot[data-level="3"] {
      background: color-mix(in srgb, var(--primary, var(--ag-host-accent, #3274f6)) 76%, transparent);
    }
    #${INSIGHTS_FULLPAGE_ID} .ag-ci-heat-dot[data-level="4"],
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-dot[data-level="4"] {
      background: var(--primary, var(--ag-host-accent, #3274f6));
    }

    /* 个人 Token 用量主页（仿 Codex 居中极简风，自适应深浅主题，支持容器查询防窄屏裁切） */
    #${PROFILE_HOME_PAGE_ID} .ag-ph-shell {
      width: 100%;
      max-width: 960px;
      min-width: 0;
      margin: 0 auto;
      padding: 18px 22px 56px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-ctrl-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      padding: 8px 12px;
      border-radius: 12px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.05));
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-select {
      height: 28px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.24));
      background: var(--secondary, rgba(128, 128, 128, 0.1));
      color: var(--foreground, #ececef);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-period-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    @container ag-ci-page (max-width: 760px) {
      #${PROFILE_HOME_PAGE_ID} .ag-ph-period-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      #${PROFILE_HOME_PAGE_ID} .ag-ph-shell {
        padding: 14px 14px 48px;
      }
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-period-card {
      padding: 11px 13px;
      border-radius: 10px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
      background: var(--card, rgba(128, 128, 128, 0.05));
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-period-lbl {
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-period-val {
      font-size: 18px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--foreground, #f4f4f6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-period-sub {
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
      font-variant-numeric: tabular-nums;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-palette-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-swatch-inp {
      width: 26px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-7d-bars {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
      align-items: end;
      height: 116px;
      padding-top: 6px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-7d-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      height: 100%;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-7d-pair {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 3px;
      height: 82px;
      width: 100%;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-7d-tok {
      width: 11px;
      border-radius: 4px 4px 2px 2px;
      background: var(--ag-host-accent, var(--primary, #3274f6));
      min-height: 3px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-7d-cost {
      width: 9px;
      border-radius: 4px 4px 2px 2px;
      background: #10b981;
      min-height: 3px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-table th,
    #${PROFILE_HOME_PAGE_ID} .ag-ph-table td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.14));
      text-align: left;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-table th {
      color: var(--muted-foreground, #9a9aa6);
      font-weight: 500;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-topbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-btn {
      height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.26));
      background: transparent;
      color: var(--foreground, #ececef);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color 140ms ease;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-btn:hover {
      background: var(--secondary, rgba(128, 128, 128, 0.14));
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      padding-top: 2px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-avatar {
      width: 68px;
      height: 68px;
      border-radius: 999px;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      font-weight: 700;
      color: #ffffff;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.24));
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-name {
      margin: 2px 0 0;
      font-size: 21px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--foreground, #f4f4f6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-handle {
      margin: 0;
      font-size: 12.5px;
      color: var(--muted-foreground, #9a9aa6);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-plan-pill {
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.24));
      background: var(--secondary, rgba(128, 128, 128, 0.12));
      color: var(--foreground, #ececef);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-capsule-strip {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      border-radius: 14px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.04));
      overflow: hidden;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-stat-cell {
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      border-right: 1px solid var(--border, rgba(128, 128, 128, 0.16));
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-stat-cell:last-child {
      border-right: none;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-stat-val {
      font-size: 16.5px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      color: var(--foreground, #f4f4f6);
      line-height: 1.25;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-stat-lbl {
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-card {
      padding: 15px 16px;
      border-radius: 14px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--card, rgba(128, 128, 128, 0.04));
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-card-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-card-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--foreground, #f4f4f6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-seg {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      background: var(--secondary, rgba(128, 128, 128, 0.08));
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-seg-btn {
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--muted-foreground, #9a9aa6);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      padding: 4px 10px;
      cursor: pointer;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-seg-btn[aria-pressed="true"] {
      background: var(--background, rgba(255, 255, 255, 0.14));
      color: var(--foreground, #ffffff);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
      gap: 8px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-heat-legend {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-bar-strip {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 84px;
      width: 100%;
      padding-top: 6px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-bar-item {
      flex: 1 1 0;
      min-width: 6px;
      max-width: 24px;
      border-radius: 4px 4px 2px 2px;
      background: var(--primary, var(--ag-host-accent, #3274f6));
      min-height: 3px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-cache-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-cache-metric {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-cache-val {
      font-size: 16px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--foreground, #f4f4f6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-cache-lbl {
      font-size: 11px;
      color: var(--muted-foreground, #9a9aa6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-kv-list {
      display: flex;
      flex-direction: column;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-kv-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 10px 2px;
      border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.14));
      font-size: 12.5px;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-kv-row:last-child {
      border-bottom: none;
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-kv-key {
      color: var(--muted-foreground, #9a9aa6);
    }
    #${PROFILE_HOME_PAGE_ID} .ag-ph-kv-val {
      color: var(--foreground, #f4f4f6);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    @media (max-width: 620px) {
      #${PROFILE_HOME_PAGE_ID} .ag-ph-capsule-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      #${PROFILE_HOME_PAGE_ID} .ag-ph-stat-cell {
        border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.14));
      }
    }
  `;

  const INSIGHTS_VIEWS_CSS = `
    .ag-session-views-bar {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 8px;
      background: var(--ag-btn-bg, rgba(128, 128, 128, 0.10));
      border: 1px solid var(--ag-border-subtle, rgba(128, 128, 128, 0.20));
      font-family: inherit;
    }
    .ag-session-view-tab {
      height: 24px;
      padding: 0 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--ag-text-secondary, #c8c8d0);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      transform: none !important;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .ag-session-view-tab:hover {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.08));
      color: var(--ag-text-primary, #ffffff);
    }
    .ag-session-view-tab:active {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.14));
      transform: none !important;
    }
    .ag-session-view-tab[aria-selected="true"] {
      background: var(--ag-aux-qs-active-bg, rgba(255, 255, 255, 0.14));
      border-color: var(--ag-border-card, rgba(255, 255, 255, 0.16));
      color: var(--ag-text-primary, #ffffff);
    }

    /* Orchestrator 两位小机器人编排可视化 */
    .ag-orch-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--ag-border-card, rgba(255, 255, 255, 0.10));
      background: var(--ag-bg-card, #18181b);
      color: var(--ag-text-primary, #ececef);
      font-family: inherit;
    }
    .ag-orch-stage {
      display: grid;
      grid-template-columns: minmax(112px, 1fr) minmax(120px, 1.3fr) minmax(112px, 1fr);
      align-items: center;
      gap: 10px;
    }
    .ag-orch-card[data-stacked="true"] .ag-orch-stage {
      grid-template-columns: 1fr;
      justify-items: center;
    }
    .ag-orch-bot-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--ag-border-subtle, rgba(255, 255, 255, 0.08));
      background: transparent;
      color: inherit;
      cursor: pointer;
      outline: none;
      transform: none !important;
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .ag-orch-bot-btn:hover {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.06));
    }
    .ag-orch-bot-btn:active {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.12));
      transform: none !important;
    }
    .ag-orch-bot-btn[data-active="true"] {
      border-color: var(--ag-host-accent, var(--primary, #3274f6));
      background: color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 12%, transparent);
    }
    .ag-orch-bot-svg {
      width: 44px;
      height: 44px;
      display: block;
    }
    .ag-orch-bot-role {
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.2;
    }
    .ag-orch-bot-model {
      font-size: 11px;
      color: var(--ag-text-muted, #8a8a94);
      text-align: center;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ag-orch-bridge {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .ag-orch-handoff-btn {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--ag-border-subtle, rgba(255, 255, 255, 0.10));
      background: transparent;
      color: inherit;
      cursor: pointer;
      max-width: 100%;
      transform: none !important;
      transition: background-color 120ms ease;
    }
    .ag-orch-handoff-btn:hover {
      background: var(--ag-btn-hover, rgba(255, 255, 255, 0.06));
    }
    .ag-orch-handoff-btn:active {
      background: var(--ag-btn-active, rgba(255, 255, 255, 0.12));
      transform: none !important;
    }
    .ag-orch-track {
      position: relative;
      width: 100%;
      min-width: 96px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ag-orch-task-chip {
      position: absolute;
      width: 14px;
      height: 10px;
      border-radius: 3px;
      background: var(--ag-token-accent-default, #3274f6);
      opacity: 0;
      pointer-events: none;
    }
    .ag-orch-card[data-reduced-motion="false"] .ag-orch-task-chip.is-sliding-right {
      animation: ag-orch-slide-right 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .ag-orch-card[data-reduced-motion="false"] .ag-orch-task-chip.is-sliding-left {
      animation: ag-orch-slide-left 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes ag-orch-slide-right {
      0% { transform: translateX(-34px); opacity: 0.2; }
      40% { opacity: 1; }
      100% { transform: translateX(34px); opacity: 0; }
    }
    @keyframes ag-orch-slide-left {
      0% { transform: translateX(34px); opacity: 0.2; }
      40% { opacity: 1; }
      100% { transform: translateX(-34px); opacity: 0; }
    }
    .ag-orch-action-text {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--ag-text-primary, #ececef);
      text-align: center;
    }
    .ag-orch-direction-text {
      font-size: 10.5px;
      color: var(--ag-text-muted, #8a8a94);
    }
    .ag-orch-detail-drawer {
      border-top: 1px solid var(--ag-border-subtle, rgba(255, 255, 255, 0.08));
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ag-orch-detail-drawer[hidden] {
      display: none !important;
    }
    .ag-orch-event-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(128, 128, 128, 0.08);
    }
    .ag-orch-locate-btn {
      border: 1px solid var(--ag-border-subtle, rgba(255, 255, 255, 0.14));
      border-radius: 5px;
      background: transparent;
      color: inherit;
      font-size: 11px;
      padding: 2px 7px;
      cursor: pointer;
    }
    @media (prefers-reduced-motion: reduce) {
      .ag-orch-task-chip {
        animation: none !important;
      }
    }
  `;

  function isSidebarBtnSelected(node) {
    if (!node) return false;
    if (node.getAttribute?.('aria-current') === 'page' || node.getAttribute?.('aria-selected') === 'true' || node.getAttribute?.('data-active') === 'true') {
      return true;
    }
    const cls = String(node.className || '');
    return /\b(bg-sidebar-secondary|bg-sidebar-accent|bg-accent|is-active|active|selected)\b/.test(cls);
  }

  function sanitizeSidebarBtnClass(refBtn) {
    return String(refBtn?.className || '')
      .replace(/\b(bg-sidebar-secondary|bg-sidebar-accent|bg-accent|is-active|active|selected|font-semibold|font-bold)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveSidebarContainer(anchorNode, rootEl) {
    let cur = anchorNode?.parentElement || null;
    let best = cur;
    let navFallback = null;
    let depth = 0;
    while (cur && cur !== rootEl && depth < 12) {
      const tag = String(cur.tagName || '').toUpperCase();
      const testId = String(cur.getAttribute?.('data-testid') || '').toLowerCase();
      const cls = String(cur.className || '');
      if (tag === 'ASIDE' || testId.includes('sidebar') || /\bbg-sidebar\b/.test(cls)) {
        return cur;
      }
      if (tag === 'NAV' && !navFallback) {
        navFallback = cur;
      }
      best = cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return navFallback || best || anchorNode?.parentElement || null;
  }

  /**
   * 1. 左栏锚点定位：兼容 Antigravity 2.35.2 data-testid（plugins-button / automations-button / new-conversation-button）
   *    与经典文本结构，在 Customizations 与 Projects 之间定位精确插入点与官方样式基准项。
   */
  function findSidebarInsightsAnchor(sidebarRoot) {
    if (!sidebarRoot || typeof sidebarRoot.querySelectorAll !== 'function') return null;
    const explicitPlugins = typeof sidebarRoot.querySelector === 'function'
      ? sidebarRoot.querySelector('[data-testid="plugins-button"]')
      : null;
    const explicitAutomations = typeof sidebarRoot.querySelector === 'function'
      ? sidebarRoot.querySelector('[data-testid="automations-button"]')
      : null;
    const explicitNewChat = typeof sidebarRoot.querySelector === 'function'
      ? sidebarRoot.querySelector('[data-testid="new-conversation-button"]')
      : null;

    const items = Array.from(sidebarRoot.querySelectorAll('button, a, [role="button"], [role="listitem"]') || [])
      .filter((n) => n && n.id !== SIDEBAR_INSIGHTS_BTN_ID && n.getAttribute?.('data-ag-sidebar-insights') !== 'true');

    let customizationsNode = explicitPlugins || null;
    let automationsNode = explicitAutomations || null;
    let newChatNode = explicitNewChat || null;
    let projectsNode = null;

    for (const node of items) {
      const txt = String(node.textContent || node.getAttribute?.('aria-label') || '').trim().toLowerCase();
      if (!customizationsNode && /customizations|自定义扩展|自定义|自訂擴展|自訂/.test(txt)) customizationsNode = node;
      if (!automationsNode && /^(automations?|自动化|自動化)$/.test(txt)) automationsNode = node;
      if (!newChatNode && /^(new conversation|new chat|新建会话|新對話)$/.test(txt)) newChatNode = node;
      if (!projectsNode && /^projects$|项目|專案/.test(txt)) projectsNode = node;
    }

    const officialNavBtns = [newChatNode, automationsNode, customizationsNode].filter(Boolean);
    const unselectedOfficial = officialNavBtns.find((b) => !isSidebarBtnSelected(b)) || customizationsNode || automationsNode || newChatNode || null;
    const activeOfficial = officialNavBtns.find((b) => isSidebarBtnSelected(b)) || null;

    const resolveInsertion = (targetNode, kind) => {
      if (!targetNode || !targetNode.parentElement) return null;
      const directParent = targetNode.parentElement;
      const grandParent = directParent.parentElement;
      let useRowWrapper = false;
      let parent = directParent;
      let referenceRow = targetNode;
      let insertBefore = kind === 'before-projects' ? targetNode : (targetNode.nextSibling || null);

      if (grandParent && officialNavBtns.length >= 2) {
        const directMatches = officialNavBtns.filter((b) => b.parentElement === directParent).length;
        const grandContainsAll = officialNavBtns.every((b) => (
          typeof grandParent.contains === 'function' ? grandParent.contains(b) : b.parentElement?.parentElement === grandParent
        ));
        if (directMatches === 1 && grandContainsAll) {
          useRowWrapper = true;
          parent = grandParent;
          referenceRow = directParent;
          insertBefore = kind === 'before-projects' ? directParent : (directParent.nextSibling || null);
        }
      }

      return {
        parent,
        insertBefore,
        anchorKind: kind,
        referenceBtn: unselectedOfficial || targetNode,
        activeReferenceBtn: activeOfficial,
        referenceRow,
        useRowWrapper,
        sidebarContainer: resolveSidebarContainer(targetNode, sidebarRoot),
        officialNavBtns
      };
    };

    if (customizationsNode) return resolveInsertion(customizationsNode, 'after-customizations');
    if (projectsNode) return resolveInsertion(projectsNode, 'before-projects');
    if (automationsNode) return resolveInsertion(automationsNode, 'after-automations');
    return null;
  }

  function createSidebarInsightsIconSvg(doc, iconSize = 16) {
    const NS = 'http://www.w3.org/2000/svg';
    const sz = Math.max(14, Math.min(18, Math.round(Number(iconSize) || 16)));
    const svg = typeof doc.createElementNS === 'function'
      ? doc.createElementNS(NS, 'svg')
      : doc.createElement('svg');
    svg.setAttribute('class', 'ag-sidebar-insights-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(sz));
    svg.setAttribute('height', String(sz));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => {
      const el = typeof doc.createElementNS === 'function' ? doc.createElementNS(NS, tag) : doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    };
    add('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 });
    add('path', { d: 'M7 15l3.2-3.5 2.8 2.4L17 9' });
    add('circle', { cx: 17, cy: 9, r: 1.2, fill: 'currentColor', stroke: 'none' });
    return svg;
  }

  function ensureSidebarInsightsHostStyle(doc) {
    if (!doc || !doc.head) return;
    if (doc.getElementById?.(SIDEBAR_INSIGHTS_STYLE_ID)) return;
    const st = doc.createElement('style');
    st.id = SIDEBAR_INSIGHTS_STYLE_ID;
    st.textContent = SIDEBAR_INSIGHTS_HOST_CSS;
    doc.head.appendChild(st);
  }

  function syncSidebarInsightsButtonStyle(btn, refBtn, win = (typeof window !== 'undefined' ? window : null), activeRefBtn = null) {
    if (!btn || !refBtn || !btn.style) return null;
    const getCS = typeof win?.getComputedStyle === 'function' ? (el) => {
      try { return win.getComputedStyle(el); } catch { return null; }
    } : () => null;

    const cs = getCS(refBtn);
    const refLabel = refBtn.querySelector?.('span.truncate, span:last-of-type') || null;
    const refLabelCs = refLabel ? getCS(refLabel) : null;
    const refSvg = refBtn.querySelector?.('svg') || null;
    const refSvgCs = refSvg ? getCS(refSvg) : null;

    const pick = (k) => (refLabelCs && refLabelCs[k]) || (cs && cs[k]) || refBtn.style?.[k] || '';
    const pickBox = (k) => (cs && cs[k]) || refBtn.style?.[k] || '';

    const metrics = {
      fontFamily: pick('fontFamily'),
      fontSize: pick('fontSize'),
      fontWeight: pick('fontWeight'),
      lineHeight: pick('lineHeight'),
      letterSpacing: pick('letterSpacing'),
      color: pick('color'),
      opacity: pickBox('opacity'),
      paddingTop: pickBox('paddingTop'),
      paddingRight: pickBox('paddingRight'),
      paddingBottom: pickBox('paddingBottom'),
      paddingLeft: pickBox('paddingLeft'),
      height: pickBox('height'),
      minHeight: pickBox('minHeight'),
      borderRadius: pickBox('borderRadius'),
      gap: pickBox('gap'),
      iconSize: Number.parseFloat(refSvgCs?.width || refSvg?.getAttribute?.('width') || '16') || 16
    };

    const setBoth = (camel, kebab, val, important = false) => {
      if (!val) return;
      try { btn.style[camel] = String(val); } catch { }
      if (important && typeof btn.style.setProperty === 'function') {
        try { btn.style.setProperty(kebab, String(val), 'important'); } catch { }
      }
    };

    setBoth('fontFamily', 'font-family', metrics.fontFamily, true);
    setBoth('fontSize', 'font-size', metrics.fontSize, true);
    setBoth('fontWeight', 'font-weight', metrics.fontWeight, true);
    setBoth('lineHeight', 'line-height', metrics.lineHeight, true);
    setBoth('letterSpacing', 'letter-spacing', metrics.letterSpacing, true);
    setBoth('paddingTop', 'padding-top', metrics.paddingTop, true);
    setBoth('paddingRight', 'padding-right', metrics.paddingRight, true);
    setBoth('paddingBottom', 'padding-bottom', metrics.paddingBottom, true);
    setBoth('paddingLeft', 'padding-left', metrics.paddingLeft, true);
    setBoth('borderRadius', 'border-radius', metrics.borderRadius, true);
    setBoth('gap', 'gap', metrics.gap || '8px', true);
    if (metrics.height && metrics.height !== 'auto' && Number.parseFloat(metrics.height) >= 24) {
      setBoth('minHeight', 'min-height', metrics.height, true);
    } else if (metrics.minHeight && metrics.minHeight !== '0px') {
      setBoth('minHeight', 'min-height', metrics.minHeight, true);
    }

    if (typeof btn.style.setProperty === 'function') {
      try {
        if (metrics.color) btn.style.setProperty('--ag-si-inactive-color', metrics.color);
        if (metrics.opacity) btn.style.setProperty('--ag-si-inactive-opacity', metrics.opacity);
        const activeCs = activeRefBtn ? getCS(activeRefBtn) : null;
        if (activeCs?.backgroundColor && activeCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && activeCs.backgroundColor !== 'transparent') {
          btn.style.setProperty('--ag-si-active-bg', activeCs.backgroundColor);
        }
        const activeLabel = activeRefBtn?.querySelector?.('span.truncate, span:last-of-type') || activeRefBtn;
        const activeLabelCs = activeLabel ? getCS(activeLabel) : null;
        if (activeLabelCs?.color) {
          btn.style.setProperty('--ag-si-active-color', activeLabelCs.color);
        }
      } catch { }
    }

    const svgEl = btn.querySelector?.('.ag-sidebar-insights-icon');
    if (svgEl) {
      const sz = Math.max(14, Math.min(18, Math.round(metrics.iconSize || 16)));
      svgEl.setAttribute('width', String(sz));
      svgEl.setAttribute('height', String(sz));
    }
    return metrics;
  }

  /**
   * 2. 左栏上下文洞察全页路由与筛选状态控制器（打开不发模型请求或远端探针）
   */
  function createContextInsightsPageController(deps = {}) {
    let lang = resolveLang(deps.lang);
    let active = false;
    let dateRange = String(deps.initialDateRange || '7d'); // '7d' | '30d' | 'all'
    let accountScope = String(deps.initialAccountScope || 'all');
    let projectFilter = String(deps.initialProjectFilter || 'all');
    let includeArchived = Boolean(deps.includeArchived);
    let searchQuery = '';
    let heatmapMetric = 'tokens';
    let savedConversationSnapshot = null;
    let networkRequestCountOnOpen = 0;

    function openPage(conversationContext = null) {
      if (!active) {
        savedConversationSnapshot = conversationContext ? { ...conversationContext } : null;
      }
      active = true;
      networkRequestCountOnOpen = 0;
      deps.onRouteChange?.({ route: 'insights', active: true, preservedConversation: savedConversationSnapshot });
      return { active, networkRequestCountOnOpen };
    }

    function closePage(closeOpts = {}) {
      if (!active) return { active: false, restoredConversation: null };
      active = false;
      const restored = savedConversationSnapshot;
      deps.onRouteChange?.({
        route: 'conversation',
        active: false,
        restoredConversation: restored,
        viaNativeNav: Boolean(closeOpts?.viaNativeNav)
      });
      return { active: false, restoredConversation: restored };
    }

    function setFilters(patch = {}) {
      if (patch.dateRange) dateRange = String(patch.dateRange);
      if (patch.accountScope !== undefined) accountScope = String(patch.accountScope || 'all');
      if (patch.projectFilter !== undefined) projectFilter = String(patch.projectFilter || 'all');
      if (typeof patch.includeArchived === 'boolean') includeArchived = patch.includeArchived;
      if (patch.searchQuery !== undefined) searchQuery = String(patch.searchQuery || '');
      if (patch.heatmapMetric && HEATMAP_METRIC_KEYS.includes(patch.heatmapMetric)) {
        heatmapMetric = patch.heatmapMetric;
      }
      if (patch.lang) lang = resolveLang(patch.lang);
      deps.onFiltersChanged?.(getState());
      return getState();
    }

    function filterSessions(sessions = []) {
      const q = searchQuery.trim().toLowerCase();
      return (Array.isArray(sessions) ? sessions : []).filter((s) => {
        if (!s) return false;
        if (!includeArchived && s.archived) return false;
        if (accountScope !== 'all' && String(s.accountScopeKey || '') !== accountScope) return false;
        if (projectFilter !== 'all' && String(s.project || '') !== projectFilter) return false;
        if (q && !String(s.title || s.sessionId || '').toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function getState() {
      return {
        active,
        lang,
        dateRange,
        accountScope,
        projectFilter,
        includeArchived,
        searchQuery,
        heatmapMetric,
        networkRequestCountOnOpen,
        copy: getInsightsCopy(lang)
      };
    }

    return { openPage, closePage, setFilters, filterSessions, getState };
  }

  function formatCompactCount(val) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function formatDurationCompact(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '--';
    if (n < 1000) return `${Math.round(n)}ms`;
    const sec = n / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const totalSec = Math.round(sec);
    const mins = Math.floor(totalSec / 60);
    const remSec = totalSec % 60;
    if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMin = mins % 60;
    return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
  }

  function formatUsdShort(usd) {
    const n = Number(usd || 0);
    if (!Number.isFinite(n) || n <= 0) return '$0.00';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  }

  function formatLocalYmdSafe(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseYmdLocal(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function addDaysLocal(dt, delta) {
    const out = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + delta);
    return out;
  }

  function startOfWeekMonday(dt) {
    const dow = dt.getDay(); // 0=Sun..6=Sat
    const diff = dow === 0 ? -6 : 1 - dow;
    return addDaysLocal(dt, diff);
  }

  function safeReadClosureTokenData() {
    try {
      if (typeof ANTIGRAVITY_TOKEN_DATA !== 'undefined' && ANTIGRAVITY_TOKEN_DATA && typeof ANTIGRAVITY_TOKEN_DATA === 'object') {
        return ANTIGRAVITY_TOKEN_DATA;
      }
    } catch { }
    try {
      if (typeof window !== 'undefined') {
        if (window.__AGContextMeterTokenData && typeof window.__AGContextMeterTokenData === 'object') return window.__AGContextMeterTokenData;
        if (window.__AGContextMeterHistory && typeof window.__AGContextMeterHistory === 'object') return window.__AGContextMeterHistory;
      }
    } catch { }
    return null;
  }

  function safeReadClosureState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch { }
    return null;
  }

  function safeReadClosureAccounts() {
    try {
      if (typeof accountsUiState !== 'undefined' && accountsUiState?.overview) {
        const list = Array.isArray(accountsUiState.overview.accounts) ? accountsUiState.overview.accounts : [];
        return { accounts: list, activeAccount: list.find((a) => a && a.isActive) || list[0] || null };
      }
    } catch { }
    try {
      if (typeof window !== 'undefined' && window.__AGContextMeterAccounts) {
        const raw = window.__AGContextMeterAccounts;
        const list = Array.isArray(raw.accounts) ? raw.accounts : (Array.isArray(raw) ? raw : []);
        return { accounts: list, activeAccount: raw.activeAccount || list.find((a) => a && a.isActive) || list[0] || null };
      }
    } catch { }
    return { accounts: [], activeAccount: null };
  }

  /**
   * 方向铁律：严格从左往右排列推进的热力图数据构建器。
   * - 第 1 列（index 0）永远代表用户最早有记录的起点所在周（或 52 周窗口的最早周），
   *   随着时间往右自然延展填充，绝不把当前日期放最右侧导致左侧出现大片空灰格子。
   */
  function buildLeftToRightHeatmapModel(dailyMap = {}, opts = {}) {
    const metric = HEATMAP_METRIC_KEYS.includes(opts.metric) ? opts.metric : 'tokens';
    const maxWeeks = Math.max(4, Math.min(52, Number(opts.maxWeeks) || 52));
    const minWeeks = Math.max(4, Math.min(maxWeeks, Number(opts.minWeeks) || 14));
    const todayDt = parseYmdLocal(opts.todayStr) || new Date();
    const todayNorm = new Date(todayDt.getFullYear(), todayDt.getMonth(), todayDt.getDate());
    const todayKey = formatLocalYmdSafe(todayNorm);

    const extractVal = (rec) => {
      if (!rec || typeof rec !== 'object') return 0;
      if (metric === 'sessions') return Number(rec.sessions || 0);
      if (metric === 'requests') return Number(rec.calls ?? rec.steps ?? 0);
      if (metric === 'cost') return Number(rec.costUSD || 0);
      return Number(rec.tokens ?? rec.total ?? 0);
    };

    const validEntries = [];
    for (const [dk, rec] of Object.entries(dailyMap || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !rec) continue;
      const val = extractVal(rec);
      validEntries.push({ date: dk, value: val, rec });
    }
    validEntries.sort((a, b) => a.date.localeCompare(b.date));

    const positiveEntries = validEntries.filter((e) => e.value > 0);
    const firstActiveKey = positiveEntries.length ? positiveEntries[0].date : '';
    const firstUseClean = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.firstUseDate || '')) ? String(opts.firstUseDate) : '';
    let earliestKey = firstActiveKey || firstUseClean || todayKey;
    if (firstUseClean && firstActiveKey && firstUseClean < firstActiveKey) {
      const diffDays = Math.round((parseYmdLocal(firstActiveKey) - parseYmdLocal(firstUseClean)) / 86400000);
      if (diffDays >= 0 && diffDays <= 14) earliestKey = firstUseClean;
    }

    const earliestDt = parseYmdLocal(earliestKey) || todayNorm;
    const anchorMonday = startOfWeekMonday(earliestDt);
    const todayMonday = startOfWeekMonday(todayNorm);
    const spanWeeksRaw = Math.floor((todayMonday.getTime() - anchorMonday.getTime()) / (7 * 86400000)) + 1;
    const clampedSpanWeeks = Math.max(1, spanWeeksRaw);

    let windowStartMonday = anchorMonday;
    let colCount = clampedSpanWeeks;
    if (clampedSpanWeeks > maxWeeks) {
      windowStartMonday = addDaysLocal(todayMonday, -(maxWeeks - 1) * 7);
      colCount = maxWeeks;
    } else if (clampedSpanWeeks < minWeeks) {
      // 向右延伸空白未来槽位，绝不向左侧填充空灰列
      colCount = minWeeks;
    }

    const positiveVals = positiveEntries.map((e) => e.value).sort((a, b) => a - b);
    const p95 = positiveVals.length
      ? positiveVals[Math.min(positiveVals.length - 1, Math.floor(positiveVals.length * 0.95))]
      : 0;
    const maxVal = positiveVals.length ? positiveVals[positiveVals.length - 1] : 0;
    const scaleTop = p95 > 0 ? p95 : maxVal;

    const toLevel = (v) => {
      if (!(v > 0) || !(scaleTop > 0)) return 0;
      const r = v / scaleTop;
      if (r >= 0.78) return 4;
      if (r >= 0.48) return 3;
      if (r >= 0.22) return 2;
      return 1;
    };

    const columns = [];
    const weeklyBars = [];
    const activeDaySeries = [];
    let runningCum = 0;

    for (let c = 0; c < colCount; c++) {
      const colStartDt = addDaysLocal(windowStartMonday, c * 7);
      const days = [];
      let weekTotal = 0;
      let weekHasPastOrToday = false;
      for (let r = 0; r < 7; r++) {
        const dt = addDaysLocal(colStartDt, r);
        const key = formatLocalYmdSafe(dt);
        const isFuture = dt.getTime() > todayNorm.getTime();
        if (!isFuture) weekHasPastOrToday = true;
        const rec = dailyMap?.[key] || null;
        const value = isFuture ? 0 : extractVal(rec);
        const level = isFuture ? 0 : toLevel(value);
        weekTotal += value;
        if (!isFuture && key >= earliestKey && key <= todayKey) {
          runningCum += value;
          activeDaySeries.push({
            date: key,
            dailyValue: value,
            cumulativeTotal: runningCum
          });
        }
        days.push({
          date: key,
          value,
          level,
          isFuture,
          isToday: key === todayKey,
          isEarliest: key === earliestKey
        });
      }
      columns.push({
        weekIndex: c,
        startDate: days[0].date,
        endDate: days[6].date,
        total: weekTotal,
        isFutureWeek: !weekHasPastOrToday,
        days
      });
      if (weekHasPastOrToday) {
        weeklyBars.push({
          weekIndex: c,
          startDate: days[0].date,
          endDate: days[6].date,
          total: weekTotal
        });
      }
    }

    const maxWeekTotal = Math.max(1, ...weeklyBars.map((w) => w.total));
    for (const wb of weeklyBars) {
      wb.ratio = wb.total > 0 ? Math.max(0.06, wb.total / maxWeekTotal) : 0;
      wb.level = wb.total <= 0 ? 0 : (wb.ratio >= 0.78 ? 4 : (wb.ratio >= 0.48 ? 3 : (wb.ratio >= 0.22 ? 2 : 1)));
    }

    // 累计曲线采样，保持首尾精确且严格从左往右递增
    let cumulativePoints = activeDaySeries;
    if (cumulativePoints.length > 42) {
      const sampled = [];
      const step = (cumulativePoints.length - 1) / 41;
      for (let i = 0; i < 42; i++) {
        sampled.push(cumulativePoints[Math.round(i * step)]);
      }
      cumulativePoints = sampled;
    }
    const maxCum = Math.max(1, cumulativePoints.length ? cumulativePoints[cumulativePoints.length - 1].cumulativeTotal : 0);
    cumulativePoints = cumulativePoints.map((pt) => ({
      ...pt,
      ratio: pt.cumulativeTotal > 0 ? Math.max(0.04, pt.cumulativeTotal / maxCum) : 0
    }));

    return {
      direction: 'ltr',
      metric,
      earliestDate: earliestKey,
      windowStartDate: columns[0]?.startDate || earliestKey,
      todayDate: todayKey,
      colCount,
      columns,
      weeklyBars,
      cumulativePoints,
      maxValue: maxVal
    };
  }

  /**
   * 统一读取本地真实账本（桌面 + CLI 合并数据、会话档案、实时上下文快照、请求日志与账号信息）。
   * 即使宿主传参中 state.tokenHistory 为空，也能直接从 ANTIGRAVITY_TOKEN_DATA 与实时状态完整打通，根治全 0 空壳。
   */
  function resolveUnifiedLedgerSnapshot(deps = {}, filterState = {}) {
    const nonEmptyObj = (o) => (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0 ? o : null);
    const nonEmptyArr = (a) => (Array.isArray(a) && a.length > 0 ? a : null);
    const extRaw = (typeof deps.getInsightsData === 'function' ? deps.getInsightsData(filterState) : null) || {};
    const closureTokenData = deps.tokenData || safeReadClosureTokenData() || {};
    const rawPayload = nonEmptyObj(closureTokenData.rawPayload) || nonEmptyObj(extRaw.rawPayload) || nonEmptyObj(closureTokenData) || {};
    const liveState = deps.liveState || safeReadClosureState() || {};
    const accountInfo = deps.accountState || safeReadClosureAccounts();

    const dateRange = String(filterState.dateRange || 'all');
    const sourceFilter = String(filterState.source || 'all');
    const accountScope = String(filterState.accountScope || 'all');

    // 选择来源映射（桌面 + CLI 合并或按来源过滤；严禁被空 {} 遮蔽真实账本）
    const bySource = nonEmptyObj(rawPayload.dailyMapBySource) || nonEmptyObj(closureTokenData.dailyMapBySource) || null;
    const baseDailyMap = (sourceFilter !== 'all' && bySource && nonEmptyObj(bySource[sourceFilter]))
      ? bySource[sourceFilter]
      : (nonEmptyObj(extRaw.dailyMap) || nonEmptyObj(closureTokenData.dailyMap) || nonEmptyObj(rawPayload.dailyMap) || nonEmptyObj(bySource?.all) || {});

    const rawCsi = nonEmptyObj(extRaw.crossSessionInsights)
      || nonEmptyObj(closureTokenData.crossSessionInsights)
      || nonEmptyObj(rawPayload.crossSessionInsights)
      || {};
    const rawDailyInsightsBySource = (rawCsi && rawCsi.dailyInsightsBySource && typeof rawCsi.dailyInsightsBySource === 'object') ? rawCsi.dailyInsightsBySource : null;
    const rawDailyInsights = (sourceFilter !== 'all' && rawDailyInsightsBySource?.[sourceFilter] && typeof rawDailyInsightsBySource[sourceFilter] === 'object')
      ? rawDailyInsightsBySource[sourceFilter]
      : ((rawCsi && rawCsi.dailyInsights && typeof rawCsi.dailyInsights === 'object') ? rawCsi.dailyInsights : {});

    // 合并 dailyMap 与 crossSessionInsights.dailyInsights（优先保留逐日精确 costUSD，保持与主账本 0 误差同口径）
    const mergedDaily = {};
    const allDateKeys = new Set([
      ...Object.keys(baseDailyMap || {}),
      ...Object.keys(rawDailyInsights || {})
    ]);
    for (const dk of allDateKeys) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
      const dRec = baseDailyMap?.[dk] || null;
      const iRec = rawDailyInsights?.[dk] || null;
      const input = Number(dRec?.input ?? iRec?.input ?? 0);
      const cache = Number(dRec?.cache ?? iRec?.cache ?? 0);
      const output = Number(dRec?.output ?? iRec?.output ?? 0);
      const total = Math.max(Number(dRec?.total ?? iRec?.tokens ?? 0), input + cache + output);
      const exactDayCost = Number(iRec?.costUSD ?? dRec?.costUSD ?? 0);
      mergedDaily[dk] = {
        total,
        tokens: total,
        input,
        cache,
        output,
        steps: Number(dRec?.steps ?? iRec?.calls ?? 0),
        calls: Number(iRec?.calls ?? dRec?.steps ?? 0),
        sessions: Number(iRec?.sessions ?? dRec?.sessions ?? 0),
        costUSD: Number.isFinite(exactDayCost) ? exactDayCost : 0
      };
    }

    const todayStr = String(filterState.todayStr || formatLocalYmdSafe(new Date()));
    const todayDt = parseYmdLocal(todayStr) || new Date();
    const cutoffStr = dateRange === '7d'
      ? formatLocalYmdSafe(addDaysLocal(todayDt, -6))
      : (dateRange === '30d' ? formatLocalYmdSafe(addDaysLocal(todayDt, -29)) : '');

    const filteredDaily = {};
    let totalTokens = 0;
    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    let totalCalls = 0;
    let totalCostFromDaily = 0;
    let dailySessionSum = 0;
    let activeDaysCount = 0;

    for (const [dk, rec] of Object.entries(mergedDaily)) {
      if (cutoffStr && dk < cutoffStr) continue;
      filteredDaily[dk] = rec;
      if (rec.total > 0) activeDaysCount += 1;
      totalTokens += rec.total;
      totalInput += rec.input;
      totalCache += rec.cache;
      totalOutput += rec.output;
      totalCalls += rec.calls || rec.steps || 0;
      totalCostFromDaily += rec.costUSD || 0;
      dailySessionSum += rec.sessions || 0;
    }

    // 会话列表归并：优先 extRaw.sessions（非空）-> rawCsi.sessionArchives -> 从 recentRequestLogs 聚合
    const recentLogs = Array.isArray(extRaw.recentRequestLogs) && extRaw.recentRequestLogs.length
      ? extRaw.recentRequestLogs
      : (Array.isArray(closureTokenData.recentRequestLogs) && closureTokenData.recentRequestLogs.length
        ? closureTokenData.recentRequestLogs
        : (Array.isArray(rawPayload.recentRequestLogs) ? rawPayload.recentRequestLogs : []));

    let sessions = Array.isArray(extRaw.sessions) && extRaw.sessions.length
      ? extRaw.sessions.slice()
      : (Array.isArray(rawCsi.sessionArchives) ? rawCsi.sessionArchives.slice() : []);

    if (!sessions.length && recentLogs.length) {
      const byCid = new Map();
      for (const log of recentLogs) {
        if (!log) continue;
        const cid = String(log.cascadeId || log.sessionId || 'session');
        const dk = String(log.date || (log.timestamp ? formatLocalYmdSafe(new Date(log.timestamp)) : todayStr));
        let cur = byCid.get(cid);
        if (!cur) {
          cur = {
            cascadeId: cid,
            sessionId: cid,
            title: String(log.title || log.sessionTitle || cid.slice(0, 12)),
            date: dk,
            updatedAt: Number(log.timestamp || 0),
            workspaceTag: String(log.workspaceTag || log.project || ''),
            modelLabel: String(log.modelLabel || log.model || ''),
            totalTokens: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            costUSD: 0,
            callCount: 0,
            source: log.source === 'cli' ? 'cli' : 'desktop'
          };
          byCid.set(cid, cur);
        }
        const inp = Number(log.inputTokens ?? log.input ?? 0);
        const cap = Number(log.cacheReadTokens ?? log.cache ?? 0);
        const out = Number(log.outputTokens ?? log.output ?? 0);
        cur.totalTokens += Math.max(Number(log.totalTokens ?? log.total ?? 0), inp + cap + out);
        cur.inputTokens += inp;
        cur.cacheReadTokens += cap;
        cur.outputTokens += out;
        cur.costUSD += Number(log.costUSD || 0);
        cur.callCount += 1;
        if (Number(log.timestamp || 0) >= cur.updatedAt) {
          cur.updatedAt = Number(log.timestamp || 0);
          cur.date = dk;
        }
      }
      sessions = Array.from(byCid.values()).map((s) => {
        const inpTot = s.inputTokens + s.cacheReadTokens;
        return {
          ...s,
          cacheReadPct: inpTot > 0 ? Number(((s.cacheReadTokens / inpTot) * 100).toFixed(1)) : 0
        };
      });
    }

    sessions = sessions.map((s) => ({
      ...s,
      sessionId: s.sessionId || s.cascadeId || '',
      cascadeId: s.cascadeId || s.sessionId || '',
      project: s.project || s.workspaceTag || ''
    })).filter((s) => {
      if (cutoffStr && s.date && s.date < cutoffStr) return false;
      if (sourceFilter !== 'all' && s.source && s.source !== sourceFilter) return false;
      if (accountScope !== 'all' && s.accountScopeKey && String(s.accountScopeKey) !== accountScope) return false;
      return true;
    });

    // 若日期聚合为空但 summary 有真实值（例如单测直接注入 summary），优雅回退到 summary
    const rawSum = (extRaw.summary && Object.keys(extRaw.summary).length ? extRaw.summary : null)
      || closureTokenData.summary
      || rawPayload.summary
      || {};
    if (totalTokens === 0 && Number(rawSum.grandTotalTokens || rawSum.totalTokens || 0) > 0 && dateRange === 'all') {
      totalTokens = Number(rawSum.grandTotalTokens || rawSum.totalTokens || 0);
      totalInput = Number(rawSum.totalInputTokens || 0);
      totalCache = Number(rawSum.totalCacheTokens || 0);
      totalOutput = Number(rawSum.totalOutputTokens || 0);
    }

    const costEst = closureTokenData.costEstimateBySource?.[sourceFilter]
      || closureTokenData.costEstimate
      || rawPayload.costEstimate
      || null;
    const refCost = closureTokenData.referenceCost?.all || rawPayload.referenceCost?.all || null;
    let apiCostUSD = totalCostFromDaily;
    if (!(apiCostUSD > 0) && dateRange === 'all') {
      apiCostUSD = Number(costEst?.pricedCostUSD || refCost?.totalCostUSD || rawSum.apiCostUSD || 0);
    } else if (!(apiCostUSD > 0) && sessions.length) {
      apiCostUSD = sessions.reduce((acc, s) => acc + Number(s.costUSD || 0), 0);
    }

    const totalInPlusCache = totalInput + totalCache;
    const cacheHitPct = totalInPlusCache > 0
      ? Number(((totalCache / totalInPlusCache) * 100).toFixed(1))
      : (rawSum.cacheReadStats?.cacheReadPct ?? null);

    // 工具 / 技能 / 项目排行（支持日期过滤）
    const filterRankedByDate = (arr) => (Array.isArray(arr) ? arr : []).map((it) => {
      if (!it) return null;
      let cnt = Number(it.count || 0);
      if (cutoffStr && it.byDate && typeof it.byDate === 'object') {
        cnt = Object.entries(it.byDate).reduce((s, [d, v]) => s + (d >= cutoffStr ? Number(v || 0) : 0), 0);
      }
      return { name: String(it.name || it.program || it.command || '--'), count: cnt };
    }).filter((x) => x && x.count > 0).sort((a, b) => b.count - a.count);

    const topTools = filterRankedByDate(rawCsi.topTools || extRaw.topTools);
    const topSkills = filterRankedByDate(rawCsi.topSkills || extRaw.topSkills);
    let topCommands = filterRankedByDate(rawCsi.topCommands || extRaw.topCommands);
    const toolCallsTotal = topTools.reduce((s, x) => s + x.count, 0) || Number(rawSum.toolCalls || 0);

    // 真实项目名多级聚合（会话 workspaceTag/project/cwd -> rawCsi.topProjects -> extRaw.topProjects）
    const extractProjectName = (s) => {
      const direct = String(s?.workspaceTag || s?.project || '').trim();
      if (direct) return direct;
      const rawPath = String(s?.workspacePath || s?.cwd || s?.repoRoot || '').trim();
      if (rawPath) {
        const segs = rawPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
        if (segs.length) return segs[segs.length - 1];
      }
      return '';
    };
    const projectMap = new Map();
    for (const s of sessions) {
      const pName = extractProjectName(s);
      if (!pName) continue;
      const prev = projectMap.get(pName) || { name: pName, count: 0, tokens: 0 };
      prev.count += 1;
      prev.tokens += Number(s.totalTokens || 0);
      projectMap.set(pName, prev);
    }
    let topProjects = Array.from(projectMap.values())
      .sort((a, b) => (b.tokens - a.tokens) || (b.count - a.count))
      .slice(0, 8);
    if (!topProjects.length) {
      const fallbackProjects = filterRankedByDate(rawCsi.topProjects || extRaw.topProjects);
      topProjects = fallbackProjects.map((it) => ({ ...it, tokens: Number(it.tokens || 0) })).slice(0, 8);
    }
    if (!topCommands.length) {
      const cmdCounts = new Map();
      for (const s of sessions) {
        for (const c of (Array.isArray(s?.commands) ? s.commands : (Array.isArray(s?.commandExecutions) ? s.commandExecutions : []))) {
          const prog = String(c?.program || c?.name || String(c?.command || '').trim().split(/\s+/)[0] || '').trim();
          if (prog) cmdCounts.set(prog, (cmdCounts.get(prog) || 0) + Number(c?.count || 1));
        }
      }
      topCommands = Array.from(cmdCounts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
    }

    // 耗时与速度统计（来自 speedRecords 与 recentRequestLogs；严禁编造宿主未导出维度）
    const speedRecords = Array.isArray(closureTokenData.speedRecords) && closureTokenData.speedRecords.length
      ? closureTokenData.speedRecords
      : (Array.isArray(rawPayload.speedRecords) ? rawPayload.speedRecords : []);
    const durationsMs = [];
    const ttftsMs = [];
    const tpsList = [];
    let toolExecMsTotal = 0;
    for (const sr of speedRecords) {
      if (!sr) continue;
      const dMs = Number(sr.durationMs ?? (sr.durationSec ? sr.durationSec * 1000 : 0));
      if (dMs > 0) durationsMs.push(dMs);
      const tMs = Number(sr.ttftMs ?? (sr.ttftSec ? sr.ttftSec * 1000 : 0));
      if (tMs > 0) ttftsMs.push(tMs);
      const tps = Number(sr.tps || sr.tokensPerSec || 0);
      if (tps > 0) tpsList.push(tps);
      if (Number(sr.toolDurationMs || 0) > 0) toolExecMsTotal += Number(sr.toolDurationMs);
    }
    for (const lg of recentLogs) {
      if (!lg) continue;
      const dMs = Number(lg.durationMs ?? lg.elapsedMs ?? (lg.durationSec ? lg.durationSec * 1000 : 0));
      if (dMs > 0 && !speedRecords.length) durationsMs.push(dMs);
      const tMs = Number(lg.ttftMs ?? (lg.ttftSec ? lg.ttftSec * 1000 : 0));
      if (tMs > 0 && !speedRecords.length) ttftsMs.push(tMs);
      const tps = Number(lg.tps || 0);
      if (tps > 0 && !speedRecords.length) tpsList.push(tps);
      if (Number(lg.toolDurationMs || 0) > 0) toolExecMsTotal += Number(lg.toolDurationMs);
    }
    const activeTimeMs = durationsMs.reduce((s, v) => s + v, 0);
    const totalTtftMs = ttftsMs.reduce((s, v) => s + v, 0);
    const maxLatencyMs = durationsMs.length ? Math.max(...durationsMs) : 0;
    const avgLatencyMs = durationsMs.length ? activeTimeMs / durationsMs.length : 0;
    const avgTtftMs = ttftsMs.length ? totalTtftMs / ttftsMs.length : 0;
    const avgTps = tpsList.length ? tpsList.reduce((s, v) => s + v, 0) / tpsList.length : 0;

    // 连续自然日序列：严格以今天（todayStr）为最后一列，缺日补零，绝不跳日
    const buildContinuousDays = (startDt, endDt) => {
      const out = [];
      const sNorm = new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate());
      const eNorm = new Date(endDt.getFullYear(), endDt.getMonth(), endDt.getDate());
      if (sNorm.getTime() > eNorm.getTime()) return [formatLocalYmdSafe(eNorm)];
      const cur = new Date(sNorm.getTime());
      while (cur.getTime() <= eNorm.getTime()) {
        out.push(formatLocalYmdSafe(cur));
        cur.setDate(cur.getDate() + 1);
      }
      return out;
    };
    const last7Dates = buildContinuousDays(addDaysLocal(todayDt, -6), todayDt);
    const dailySeries7d = last7Dates.map((dk) => ({
      date: dk,
      tokens: Number(mergedDaily[dk]?.total || 0),
      costUSD: Number(mergedDaily[dk]?.costUSD || 0),
      sessions: Number(mergedDaily[dk]?.sessions || 0)
    }));

    const rangeDates = (() => {
      if (dateRange === '7d') return last7Dates;
      if (dateRange === '30d') return buildContinuousDays(addDaysLocal(todayDt, -29), todayDt);
      const allKeysSorted = Object.keys(mergedDaily).filter((dk) => /^\d{4}-\d{2}-\d{2}$/.test(dk) && dk <= todayStr).sort();
      const firstCand = allKeysSorted[0] || String(rawPayload.firstUseDate || closureTokenData.firstUseDate || rawSum.firstUseDate || '');
      let startDt = parseYmdLocal(firstCand) || addDaysLocal(todayDt, -6);
      const min7Start = addDaysLocal(todayDt, -6);
      if (startDt.getTime() > min7Start.getTime()) startDt = min7Start;
      const maxSpanStart = addDaysLocal(todayDt, -89);
      if (startDt.getTime() < maxSpanStart.getTime()) startDt = maxSpanStart;
      return buildContinuousDays(startDt, todayDt);
    })();
    const dailySeriesRange = rangeDates.map((dk) => ({
      date: dk,
      tokens: Number(mergedDaily[dk]?.total || 0),
      costUSD: Number(mergedDaily[dk]?.costUSD || 0),
      sessions: Number(mergedDaily[dk]?.sessions || 0),
      calls: Number(mergedDaily[dk]?.calls || mergedDaily[dk]?.steps || 0)
    }));

    const sessionCount = sessions.length
      || (dateRange === 'all' ? Number(rawSum.totalConversations || 0) : 0)
      || dailySessionSum
      || Number(rawSum.sessionCount || 0);
    const archivedSessionCount = sessions.filter((s) => Boolean(s?.archived || s?.isArchived)).length;
    const pricedSessionCount = sessions.filter((s) => Number(s?.costUSD || 0) > 0 || s?.isPriced).length;
    const cacheMeasuredCount = sessions.filter((s) => Number(s?.cacheReadTokens || 0) > 0 || Number(s?.inputTokens || 0) > 0).length;
    const totalTurnsCount = sessions.reduce((acc, s) => acc + Number(s?.turnCount ?? s?.turns ?? s?.callCount ?? 0), 0) || totalCalls;

    const activeTimeLabel = activeTimeMs > 0
      ? formatDurationCompact(activeTimeMs)
      : (rawSum.activeTimeLabel || (activeDaysCount > 0 ? `${activeDaysCount}d` : '--'));

    // 来源占比（桌面 vs CLI）
    const desktopDaily = bySource?.desktop || {};
    const cliDaily = bySource?.cli || {};
    const desktopTokens = Object.values(desktopDaily).reduce((s, r) => s + Number(r?.total || 0), 0);
    const cliTokens = Object.values(cliDaily).reduce((s, r) => s + Number(r?.total || 0), 0);

    return {
      todayStr,
      dateRange,
      firstUseDate: rawPayload.firstUseDate || closureTokenData.firstUseDate || rawSum.firstUseDate || null,
      allDailyMap: mergedDaily,
      filteredDailyMap: filteredDaily,
      dailyModelMap: closureTokenData.dailyModelMap || rawPayload.dailyModelMap || rawPayload.dailyModelMapBySource?.all || {},
      modelMetaByKey: closureTokenData.modelMetaByKey || rawPayload.modelMetaByKey || {},
      costEstimate: costEst,
      referenceCost: refCost,
      liveLatest: liveState.latest || null,
      account: accountInfo.activeAccount || null,
      accounts: accountInfo.accounts || [],
      recentRequestLogs: recentLogs,
      speedRecords,
      sessions,
      topTools,
      topSkills,
      topCommands,
      topProjects,
      dailySeries7d,
      dailySeriesRange,
      sourceSplit: { desktopTokens, cliTokens },
      summary: {
        sessionCount,
        archivedSessionCount,
        pricedSessionCount,
        cacheMeasuredCount,
        totalTurnsCount,
        totalTokens,
        inputTokens: totalInput,
        cacheReadTokens: totalCache,
        outputTokens: totalOutput,
        totalCalls,
        activeDaysCount,
        apiCostUSD,
        apiCostLabel: rawSum.apiCostLabel && !(apiCostUSD > 0) ? rawSum.apiCostLabel : formatUsdShort(apiCostUSD),
        cacheHitPct,
        cacheHitLabel: cacheHitPct !== null ? `${cacheHitPct}%` : (rawSum.cacheHitLabel || '--'),
        toolCalls: toolCallsTotal,
        toolExecMsTotal,
        totalTtftMs,
        activeTimeMs,
        activeTimeLabel,
        avgTtftMs,
        avgTps,
        avgLatencyMs,
        maxLatencyMs
      }
    };
  }

  /**
   * 归拢全量缓存统计：全局命中率、当前会话命中率、累计缓存读取、新增非缓存输入占比、按模型缓存命中表现、预估节省费用。
   */
  function computeCacheOverviewMetrics(ledger) {
    const sum = ledger?.summary || {};
    const totalCacheRead = Number(sum.cacheReadTokens || 0);
    const totalUncachedInput = Number(sum.inputTokens || 0);
    const totalInput = totalCacheRead + totalUncachedInput;
    const globalHitPct = totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(1)) : sum.cacheHitPct;

    let sessionHitPct = null;
    if (ledger?.liveLatest && Number.isFinite(Number(ledger.liveLatest.cacheHitPct))) {
      sessionHitPct = Number(Number(ledger.liveLatest.cacheHitPct).toFixed(1));
    } else if (Array.isArray(ledger?.sessions) && ledger.sessions.length && Number.isFinite(Number(ledger.sessions[0].cacheReadPct))) {
      sessionHitPct = Number(Number(ledger.sessions[0].cacheReadPct).toFixed(1));
    }

    // 预估节省费用 = 缓存读取 Token * (标准输入单价 - 缓存读取单价)
    const tier = ledger?.referenceCost?.matchedTier || null;
    const inPerM = Number(tier?.inputPerMillion) > 0 ? Number(tier.inputPerMillion) : 1.25;
    const cachePerM = Number(tier?.cacheReadPerMillion) >= 0 && tier?.cacheReadPerMillion !== undefined
      ? Number(tier.cacheReadPerMillion)
      : inPerM * 0.1;
    const savedUsd = totalCacheRead > 0 ? Math.max(0, (totalCacheRead / 1e6) * Math.max(0, inPerM - cachePerM)) : 0;

    // 按模型聚合缓存命中表现
    const byModelMap = new Map();
    const ingestModelRec = (modelKey, inp, cap, out) => {
      const k = String(modelKey || '').trim();
      if (!k) return;
      const meta = ledger?.modelMetaByKey?.[k];
      const label = String(meta?.displayName || meta?.label || k);
      const cur = byModelMap.get(label) || { model: label, input: 0, cache: 0, output: 0, total: 0 };
      cur.input += Number(inp || 0);
      cur.cache += Number(cap || 0);
      cur.output += Number(out || 0);
      cur.total += Number(inp || 0) + Number(cap || 0) + Number(out || 0);
      byModelMap.set(label, cur);
    };

    for (const dayModels of Object.values(ledger?.dailyModelMap || {})) {
      if (!dayModels || typeof dayModels !== 'object') continue;
      for (const [mk, rec] of Object.entries(dayModels)) {
        if (!rec || typeof rec !== 'object') continue;
        ingestModelRec(mk, rec.input, rec.cache, rec.output);
      }
    }
    if (byModelMap.size === 0 && Array.isArray(ledger?.sessions)) {
      for (const s of ledger.sessions) {
        if (!s?.modelLabel) continue;
        ingestModelRec(s.modelLabel, s.inputTokens, s.cacheReadTokens, s.outputTokens);
      }
    }

    const byModel = Array.from(byModelMap.values())
      .map((m) => {
        const denom = m.input + m.cache;
        return {
          ...m,
          hitPct: denom > 0 ? Number(((m.cache / denom) * 100).toFixed(1)) : null
        };
      })
      .filter((m) => m.input + m.cache > 0)
      .sort((a, b) => (b.cache - a.cache) || (b.total - a.total))
      .slice(0, 6);

    return {
      globalHitPct,
      sessionHitPct,
      totalCacheRead,
      totalUncachedInput,
      totalInput,
      cacheSharePct: totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(1)) : 0,
      uncachedSharePct: totalInput > 0 ? Number(((totalUncachedInput / totalInput) * 100).toFixed(1)) : 0,
      savedUsd,
      savedUsdLabel: formatUsdShort(savedUsd),
      byModel
    };
  }

  /**
   * 计算个人 Token 用量主页全部真实指标（5 项核心数据条 + 缓存总览 + 底部洞察键值）。
   */
  function computeProfileHomeMetrics(ledger, opts = {}) {
    const allDaily = ledger?.allDailyMap || {};
    const todayStr = String(opts.todayStr || ledger?.todayStr || formatLocalYmdSafe(new Date()));
    const todayDt = parseYmdLocal(todayStr) || new Date();

    const activeDates = Object.entries(allDaily)
      .filter(([dk, r]) => /^\d{4}-\d{2}-\d{2}$/.test(dk) && Number(r?.total || 0) > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));

    let peakTokens = 0;
    let peakDate = '';
    for (const [dk, r] of activeDates) {
      const t = Number(r.total || 0);
      if (t > peakTokens) {
        peakTokens = t;
        peakDate = dk;
      }
    }
    if (peakTokens === 0 && Array.isArray(ledger?.sessions)) {
      for (const s of ledger.sessions) {
        if (Number(s.totalTokens || 0) > peakTokens) {
          peakTokens = Number(s.totalTokens || 0);
          peakDate = s.date || '';
        }
      }
    }

    // 连续使用天数（最长连续 + 当前连续）
    let longestStreak = 0;
    let runningStreak = 0;
    let prevDt = null;
    for (const [dk] of activeDates) {
      const dt = parseYmdLocal(dk);
      if (!dt) continue;
      if (prevDt) {
        const diff = Math.round((dt.getTime() - prevDt.getTime()) / 86400000);
        runningStreak = diff === 1 ? runningStreak + 1 : 1;
      } else {
        runningStreak = 1;
      }
      if (runningStreak > longestStreak) longestStreak = runningStreak;
      prevDt = dt;
    }

    let currentStreak = 0;
    const activeSet = new Set(activeDates.map(([dk]) => dk));
    const yesterdayStr = formatLocalYmdSafe(addDaysLocal(todayDt, -1));
    let cursorDt = activeSet.has(todayStr) ? todayDt : (activeSet.has(yesterdayStr) ? addDaysLocal(todayDt, -1) : null);
    while (cursorDt) {
      const k = formatLocalYmdSafe(cursorDt);
      if (!activeSet.has(k)) break;
      currentStreak += 1;
      cursorDt = addDaysLocal(cursorDt, -1);
    }

    // 最长任务用时
    const longestTaskMs = Number(ledger?.summary?.maxLatencyMs || 0);
    const longestTaskLabel = longestTaskMs > 0 ? formatDurationCompact(longestTaskMs) : '--';

    // 常用模型 & 推理强度占比
    const modelTotals = new Map();
    for (const dayModels of Object.values(ledger?.dailyModelMap || {})) {
      if (!dayModels || typeof dayModels !== 'object') continue;
      for (const [mk, rec] of Object.entries(dayModels)) {
        const meta = ledger?.modelMetaByKey?.[mk];
        const label = String(meta?.displayName || meta?.label || mk);
        const val = Number(rec?.total || 0) || (Number(rec?.input || 0) + Number(rec?.cache || 0) + Number(rec?.output || 0));
        if (val > 0) modelTotals.set(label, (modelTotals.get(label) || 0) + val);
      }
    }
    if (modelTotals.size === 0 && Array.isArray(ledger?.sessions)) {
      for (const s of ledger.sessions) {
        if (s?.modelLabel && Number(s.totalTokens || 0) > 0) {
          modelTotals.set(s.modelLabel, (modelTotals.get(s.modelLabel) || 0) + Number(s.totalTokens || 0));
        }
      }
    }
    const sortedModels = Array.from(modelTotals.entries()).sort((a, b) => b[1] - a[1]);
    const grandModelTok = sortedModels.reduce((s, [, v]) => s + v, 0);
    const topModel = sortedModels.length
      ? {
        name: sortedModels[0][0],
        tokens: sortedModels[0][1],
        sharePct: grandModelTok > 0 ? Number(((sortedModels[0][1] / grandModelTok) * 100).toFixed(1)) : 0
      }
      : null;

    const effortCounts = new Map();
    for (const lg of (ledger?.recentRequestLogs || [])) {
      const eff = String(lg?.reasoningEffort || lg?.thinkingEffort || lg?.effort || '').trim();
      if (eff) effortCounts.set(eff, (effortCounts.get(eff) || 0) + 1);
    }
    const totalEffort = Array.from(effortCounts.values()).reduce((s, v) => s + v, 0);
    const effortMix = Array.from(effortCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${Math.round((v / totalEffort) * 100)}%`)
      .join(' · ');

    const skills = Array.isArray(ledger?.topSkills) ? ledger.topSkills : [];
    const exploredSkillsCount = skills.length;
    const totalSkillUses = skills.reduce((s, x) => s + Number(x.count || 0), 0);
    const totalToolCalls = Number(ledger?.summary?.toolCalls || 0);

    const cacheOverview = computeCacheOverviewMetrics(ledger);
    const dTok = Number(ledger?.sourceSplit?.desktopTokens || 0);
    const cTok = Number(ledger?.sourceSplit?.cliTokens || 0);
    const srcTot = dTok + cTok;

    return {
      totalTokens: Number(ledger?.summary?.totalTokens || 0),
      peakTokens,
      peakDate,
      longestTaskMs,
      longestTaskLabel,
      longestStreakDays: longestStreak,
      currentStreakDays: currentStreak,
      activeDaysCount: activeDates.length,
      sessionCount: Number(ledger?.summary?.sessionCount || 0),
      topModel,
      effortMix,
      exploredSkillsCount,
      totalSkillUses,
      totalToolCalls,
      desktopSharePct: srcTot > 0 ? Number(((dTok / srcTot) * 100).toFixed(1)) : null,
      cliSharePct: srcTot > 0 ? Number(((cTok / srcTot) * 100).toFixed(1)) : null,
      cacheOverview
    };
  }

  function findMainContentHost(doc, sidebarContainer) {
    if (!doc) return null;
    const isExcluded = (node) => !node || node === sidebarContainer || node.contains?.(sidebarContainer) || sidebarContainer?.contains?.(node) || node.id === INSIGHTS_FULLPAGE_ID || node.id === PROFILE_HOME_PAGE_ID;
    const containsAuxSidebar = (node) => Boolean(node && typeof node.querySelector === 'function' && node.querySelector('[data-side-panel-open], [data-side-panel-focus-scope]'));
    // 优先定位不包含右侧辅助栏的主会话主列（如 .left-session-slot），避免并排模式右侧腰斩裁切与标题叠字
    if (typeof doc.querySelector === 'function') {
      const convView = doc.querySelector('[data-testid="conversation-view"]');
      if (convView && !isExcluded(convView)) {
        let col = convView.parentElement;
        while (col && col !== doc.body && containsAuxSidebar(col)) {
          col = null;
          break;
        }
        if (col && col !== doc.body && !isExcluded(col) && !containsAuxSidebar(col)) {
          return col;
        }
      }
      const explicitSlot = doc.querySelector('.left-session-slot, #left-session-slot');
      if (explicitSlot && !isExcluded(explicitSlot) && !containsAuxSidebar(explicitSlot)) {
        return explicitSlot;
      }
    }
    const isLikelyMainHost = (ch) => {
      if (!ch || isExcluded(ch)) return false;
      const tag = String(ch.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'ASIDE' || tag === 'NAV' || tag === 'HEADER') return false;
      const tid = String(ch.getAttribute?.('data-testid') || '').toLowerCase();
      const cls = String(ch.className || '');
      if (tid.includes('title-menu-bar') || tid.includes('sidebar') || /\bbg-sidebar\b/.test(cls)) return false;
      const rect = typeof ch.getBoundingClientRect === 'function' ? ch.getBoundingClientRect() : null;
      if (rect && rect.width > 0 && rect.width < 260) return false;
      return tag === 'MAIN'
        || tid.includes('main')
        || tid.includes('conversation')
        || /\bflex-1\b|\bflex-grow\b/.test(cls)
        || Boolean(ch.querySelector?.('main, [data-testid="main-content"], [data-testid="conversation-view"], .surface-composer, [contenteditable="true"]'));
    };
    const refineMainHostExcludingAux = (cand) => {
      if (!cand || !containsAuxSidebar(cand)) return cand;
      for (const child of Array.from(cand.children || [])) {
        if (!child || isExcluded(child) || containsAuxSidebar(child)) continue;
        if (child.getAttribute?.('data-side-panel-open') != null || child.getAttribute?.('data-side-panel-focus-scope') != null) continue;
        if (child.querySelector?.('[data-testid="conversation-view"], .surface-composer, [contenteditable="true"]') || /\bleft-session-slot\b/.test(String(child.className || ''))) {
          return child;
        }
      }
      return cand;
    };
    if (sidebarContainer) {
      let cur = sidebarContainer;
      let hop = 0;
      while (cur && cur.parentElement && cur.parentElement !== doc.body && hop < 8) {
        const siblings = Array.from(cur.parentElement.children || []).filter((ch) => (
          ch && ch !== cur && !isExcluded(ch) && ch.tagName !== 'SCRIPT' && ch.tagName !== 'STYLE'
        ));
        const mainCandidate = siblings.find(isLikelyMainHost) || null;
        if (mainCandidate) return refineMainHostExcludingAux(mainCandidate);
        cur = cur.parentElement;
        hop += 1;
      }
      if (doc.body && cur && cur.parentElement === doc.body) {
        const bodySiblings = Array.from(doc.body.children || []).filter((ch) => ch && ch !== cur && !isExcluded(ch));
        const bodyMain = bodySiblings.find(isLikelyMainHost) || null;
        if (bodyMain) return refineMainHostExcludingAux(bodyMain);
      }
    }
    if (typeof doc.querySelector === 'function') {
      const explicit = doc.querySelector('main, [data-testid="main-content"], [data-testid="conversation-view"]');
      if (explicit && !isExcluded(explicit)) return refineMainHostExcludingAux(explicit);
    }
    return doc.body || null;
  }

  /**
   * 2b. 左栏「详细上下文」与「个人 Token 用量主页」宿主集成控制器：
   *    - 同态对齐左栏官方导航项，更名为 详细上下文 / 詳細上下文 / Context Details
   *    - 接通插件真实本地账本（桌面 + CLI 合并数据、会话列表、实时快照与历史消耗）
   *    - 完整承载「个人 Token 用量主页」，挂载 window.__agContextMeterViews 并监听自定义事件
   *    - z-index 严格设为 20，仅覆盖右侧主内容区，严格低于左下角账号上拉菜单（2147483646）与顶层弹窗
   */
  function createSidebarInsightsHostController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    let disposed = false;
    let lang = resolveLang(deps.lang);
    let sourceFilter = 'all';
    let selectedHeatmapDate = '';
    let selectedProjectFilter = 'all';
    let archiveFilter = 'all';
    let sessionSortBy = 'default';
    let sessionPage = 1;
    let profileEnabled = true;
    let profileActive = false;
    let profileSubtab = 'tokens';
    let profileSourceFilter = 'all';
    let profileAccountScope = 'all';
    let profilePlanExpanded = false;
    let profileHeatmapMode = 'daily';
    let profileHeatmapRange = 'day';
    let profileHeatmapCtrl = null;
    let sidebarBtnEl = null;
    let sidebarRowEl = null;
    let boundSidebarContainer = null;
    let mainHostEl = null;
    let savedMainHostPos = null;
    let pageEl = null;
    let profileEl = null;
    let lastAnchor = null;
    let savedFocusEl = null;
    let fetchedTokenHistoryCache = null;

    const pageCtrl = createContextInsightsPageController({
      lang,
      initialDateRange: deps.initialDateRange || 'all',
      onRouteChange: (ev) => {
        if (ev?.active) {
          if (profileActive) closeProfileHome({ viaSwitch: true });
          presentFullPage();
        } else {
          hideFullPage({ viaNativeNav: Boolean(ev?.viaNativeNav) });
        }
        deps.onRouteChange?.(ev);
      },
      onFiltersChanged: () => {
        if (pageCtrl.getState().active) renderFullPage();
      }
    });

    function muteOtherSidebarItems() {
      if (!boundSidebarContainer) return;
      boundSidebarContainer.setAttribute?.('data-ag-insights-active', 'true');
      const items = Array.from(boundSidebarContainer.querySelectorAll?.('button, a, [role="button"], [role="listitem"]') || []);
      for (const item of items) {
        if (!item || item === sidebarBtnEl) continue;
        const hadAriaCurrent = item.getAttribute?.('aria-current');
        const hadAriaSelected = item.getAttribute?.('aria-selected');
        const hadDataActive = item.getAttribute?.('data-active');
        const activeClasses = ['bg-sidebar-secondary', 'bg-sidebar-accent', 'bg-accent', 'active', 'is-active', 'selected']
          .filter((c) => item.classList?.contains?.(c));
        if (hadAriaCurrent === 'page' || hadAriaSelected === 'true' || hadDataActive === 'true' || activeClasses.length > 0) {
          item.setAttribute?.('data-ag-si-muted', 'true');
          if (hadAriaCurrent) item.setAttribute?.('data-ag-si-prev-current', hadAriaCurrent);
          if (hadAriaSelected) item.setAttribute?.('data-ag-si-prev-selected', hadAriaSelected);
          if (hadDataActive) item.setAttribute?.('data-ag-si-prev-active', hadDataActive);
          if (activeClasses.length > 0) {
            item.setAttribute?.('data-ag-si-prev-cls', activeClasses.join(' '));
            for (const c of activeClasses) item.classList?.remove?.(c);
          }
          if (hadAriaCurrent === 'page') item.setAttribute?.('aria-current', 'false');
          if (hadAriaSelected === 'true') item.setAttribute?.('aria-selected', 'false');
          if (hadDataActive === 'true') item.setAttribute?.('data-active', 'false');
        }
      }
    }

    function restoreMutedSidebarItems(restorePreviousHighlight) {
      if (!boundSidebarContainer) return;
      boundSidebarContainer.removeAttribute?.('data-ag-insights-active');
      const muted = Array.from(boundSidebarContainer.querySelectorAll?.('[data-ag-si-muted="true"]') || []);
      for (const item of muted) {
        const prevCur = item.getAttribute?.('data-ag-si-prev-current');
        const prevSel = item.getAttribute?.('data-ag-si-prev-selected');
        const prevAct = item.getAttribute?.('data-ag-si-prev-active');
        const prevCls = item.getAttribute?.('data-ag-si-prev-cls') || '';
        item.removeAttribute?.('data-ag-si-muted');
        item.removeAttribute?.('data-ag-si-prev-current');
        item.removeAttribute?.('data-ag-si-prev-selected');
        item.removeAttribute?.('data-ag-si-prev-active');
        item.removeAttribute?.('data-ag-si-prev-cls');
        if (restorePreviousHighlight) {
          if (prevCur) item.setAttribute?.('aria-current', prevCur);
          if (prevSel) item.setAttribute?.('aria-selected', prevSel);
          if (prevAct) item.setAttribute?.('data-active', prevAct);
          for (const c of prevCls.split(/\s+/).filter(Boolean)) item.classList?.add?.(c);
        }
      }
    }

    function ensureOverlayHostPosition(pg) {
      if (!pg || !mainHostEl) return;
      if (mainHostEl.style) {
        const curPos = typeof win?.getComputedStyle === 'function'
          ? (win.getComputedStyle(mainHostEl)?.position || '')
          : (mainHostEl.style.position || '');
        if (!curPos || curPos === 'static') {
          if (savedMainHostPos === null) savedMainHostPos = mainHostEl.style.position || '';
          mainHostEl.style.position = 'relative';
        }
      }
      if (mainHostEl === doc?.body && boundSidebarContainer && typeof boundSidebarContainer.getBoundingClientRect === 'function') {
        try {
          const sbRect = boundSidebarContainer.getBoundingClientRect();
          if (sbRect && Number(sbRect.right) > 0 && pg.style) {
            pg.style.setProperty?.('left', `${Math.round(sbRect.right)}px`, 'important');
            pg.style.setProperty?.('width', `calc(100% - ${Math.round(sbRect.right)}px)`, 'important');
          }
        } catch { }
      } else if (pg.style) {
        try {
          pg.style.removeProperty?.('left');
          pg.style.removeProperty?.('width');
        } catch { }
      }
      if (typeof win?.getComputedStyle === 'function' && mainHostEl) {
        try {
          const hostBg = win.getComputedStyle(mainHostEl)?.backgroundColor;
          const isOpaqueSolid = hostBg && hostBg !== 'rgba(0, 0, 0, 0)' && hostBg !== 'transparent'
            && (!/^rgba\(/.test(hostBg) || /,\s*1\s*\)$/.test(hostBg));
          if (isOpaqueSolid) {
            pg.style.setProperty?.('--ag-si-page-bg', hostBg);
          } else {
            const isLight = doc?.documentElement?.getAttribute?.('data-theme') === 'light'
              || doc?.body?.getAttribute?.('data-theme') === 'light';
            pg.style.setProperty?.('--ag-si-page-bg', isLight ? '#ffffff' : '#151518');
          }
        } catch { }
      }
    }

    function releaseMainHostPositionIfIdle() {
      if (pageCtrl.getState().active || profileActive) return;
      if (mainHostEl && mainHostEl.style && savedMainHostPos !== null) {
        mainHostEl.style.position = savedMainHostPos;
        savedMainHostPos = null;
      }
    }

    function ensureFullPageContainer() {
      if (!doc) return null;
      const host = findMainContentHost(doc, boundSidebarContainer);
      if (!host) return null;
      mainHostEl = host;
      if (!pageEl) {
        pageEl = doc.createElement('section');
        pageEl.id = INSIGHTS_FULLPAGE_ID;
        pageEl.setAttribute('role', 'region');
        pageEl.setAttribute('data-ag-insights-page', 'true');
        pageEl.hidden = true;
      }
      if (pageEl.parentElement !== mainHostEl) {
        mainHostEl.appendChild(pageEl);
      }
      return pageEl;
    }

    function ensureProfilePageContainer() {
      if (!doc) return null;
      const host = findMainContentHost(doc, boundSidebarContainer);
      if (!host) return null;
      mainHostEl = host;
      if (!profileEl) {
        profileEl = doc.createElement('section');
        profileEl.id = PROFILE_HOME_PAGE_ID;
        profileEl.setAttribute('role', 'region');
        profileEl.setAttribute('data-ag-profile-home-page', 'true');
        profileEl.hidden = true;
      }
      if (profileEl.parentElement !== mainHostEl) {
        mainHostEl.appendChild(profileEl);
      }
      return profileEl;
    }

    function triggerLedgerRefresh(onDone) {
      const tasks = [];
      try {
        if (typeof win?.contextMeterAPI?.getTokenHistory === 'function') {
          tasks.push(
            Promise.resolve(win.contextMeterAPI.getTokenHistory())
              .then((res) => {
                if (res && typeof res === 'object' && (res.dailyMap || res.crossSessionInsights || res.summary)) {
                  fetchedTokenHistoryCache = res;
                }
              })
              .catch(() => { })
          );
        }
        if (typeof deps.onRefreshData === 'function') {
          tasks.push(Promise.resolve(deps.onRefreshData()).catch(() => { }));
        } else if (typeof syncTokenHistoryFromHost === 'function') {
          tasks.push(Promise.resolve(syncTokenHistoryFromHost(true)).catch(() => { }));
        }
      } catch { }
      if (tasks.length) {
        Promise.allSettled(tasks).finally(() => onDone?.());
        return;
      }
      onDone?.();
    }

    function renderRankCard(title, rows, emptyText, isProject = false) {
      const card = doc.createElement('div');
      card.className = 'ag-ci-card';
      const ttl = doc.createElement('div');
      ttl.className = 'ag-ci-card-title';
      ttl.textContent = title;
      card.appendChild(ttl);
      if (!rows || !rows.length) {
        const em = doc.createElement('div');
        em.className = 'ag-ci-subtitle';
        em.textContent = emptyText;
        card.appendChild(em);
        return card;
      }
      const topRows = rows.slice(0, 6);
      const maxVal = Math.max(1, ...topRows.map((r) => Number(isProject ? (r.tokens || r.count) : r.count) || 0));
      for (const r of topRows) {
        const row = doc.createElement('div');
        row.className = 'ag-ci-rank-row';
        const nm = doc.createElement('span');
        nm.className = 'ag-ci-rank-name';
        nm.textContent = r.name;
        nm.title = r.name;
        const track = doc.createElement('span');
        track.className = 'ag-ci-rank-track';
        const fill = doc.createElement('span');
        fill.className = 'ag-ci-rank-fill';
        const valNum = Number(isProject ? (r.tokens || r.count) : r.count) || 0;
        fill.style.width = `${Math.max(8, Math.round((valNum / maxVal) * 100))}%`;
        track.appendChild(fill);
        const val = doc.createElement('span');
        val.className = 'ag-ci-rank-val';
        val.textContent = isProject && r.tokens > 0 ? formatCompactCount(r.tokens) : String(r.count);
        row.appendChild(nm);
        row.appendChild(track);
        row.appendChild(val);
        card.appendChild(row);
      }
      return card;
    }

    function collectHostSidebarTitleMap() {
      const map = new Map();
      if (!doc || typeof doc.querySelectorAll !== 'function') return map;
      try {
        const nodes = doc.querySelectorAll('.left-nav-item[data-session-id], [data-testid="left-sidebar"] [data-session-id], [data-session-id]');
        for (const n of Array.from(nodes || [])) {
          if (!n || n.closest?.(`#${INSIGHTS_FULLPAGE_ID}, #${PROFILE_HOME_PAGE_ID}`)) continue;
          const sid = String(n.getAttribute?.('data-session-id') || '').trim();
          const txt = String(n.getAttribute?.('data-session-title') || n.textContent || '').replace(/\s+/g, ' ').trim();
          if (sid && txt) map.set(sid, txt);
        }
      } catch { }
      return map;
    }

    function formatRelativeTimeCompact(tsMs, dateStr, copy) {
      const n = Number(tsMs || 0);
      if (n > 0) {
        const diffMin = Math.max(0, Math.floor((Date.now() - n) / 60000));
        if (diffMin < 2) return lang === 'en' ? 'Just now' : (lang === 'zh-TW' ? '剛剛' : '刚刚');
        if (diffMin < 60) return lang === 'en' ? `${diffMin}m ago` : `${diffMin} 分钟前`.replace('分钟前', lang === 'zh-TW' ? '分鐘前' : '分钟前');
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return lang === 'en' ? `${diffH}h ago` : `${diffH} 小时前`.replace('小时前', lang === 'zh-TW' ? '小時前' : '小时前');
        const diffD = Math.floor(diffH / 24);
        if (diffD < 30) return lang === 'en' ? `${diffD}d ago` : `${diffD} 天前`;
      }
      return String(dateStr || '').slice(5) || '--';
    }

    function createDonutSvg(segments, centerText, centerSub) {
      const ns = 'http://www.w3.org/2000/svg';
      const mkSvg = (tag, attrs = {}) => {
        const el = typeof doc.createElementNS === 'function' ? doc.createElementNS(ns, tag) : doc.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
      };
      const svg = mkSvg('svg', { class: 'ag-ci-donut-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
      const r = 38;
      const circ = 2 * Math.PI * r;
      svg.appendChild(mkSvg('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'rgba(128,128,128,0.18)', 'stroke-width': 10 }));
      const total = segments.reduce((s, x) => s + Math.max(0, Number(x.value || 0)), 0);
      let offset = 0;
      if (total > 0) {
        for (const seg of segments) {
          const v = Math.max(0, Number(seg.value || 0));
          if (v <= 0) continue;
          const len = (v / total) * circ;
          svg.appendChild(mkSvg('circle', {
            cx: 50, cy: 50, r, fill: 'none',
            stroke: seg.color,
            'stroke-width': 10,
            'stroke-dasharray': `${len.toFixed(2)} ${(circ - len).toFixed(2)}`,
            'stroke-dashoffset': (-offset).toFixed(2),
            transform: 'rotate(-90 50 50)'
          }));
          offset += len;
        }
      }
      const txt = mkSvg('text', { x: 50, y: centerSub ? 47 : 54, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': '13', 'font-weight': '700' });
      txt.textContent = centerText || '--';
      svg.appendChild(txt);
      if (centerSub) {
        const subT = mkSvg('text', { x: 50, y: 62, 'text-anchor': 'middle', fill: 'currentColor', opacity: '0.62', 'font-size': '9.5' });
        subT.textContent = centerSub;
        svg.appendChild(subT);
      }
      return svg;
    }

    function createMiniContextRing(usedTok, budgetTok) {
      const ns = 'http://www.w3.org/2000/svg';
      const mkSvg = (tag, attrs = {}) => {
        const el = typeof doc.createElementNS === 'function' ? doc.createElementNS(ns, tag) : doc.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
      };
      const pct = budgetTok > 0 ? Math.min(100, Math.max(0, (usedTok / budgetTok) * 100)) : 0;
      const box = doc.createElement('div');
      box.className = 'ag-ci-sc-ring-box';
      const svg = mkSvg('svg', { viewBox: '0 0 40 40', width: 44, height: 44, 'aria-hidden': 'true' });
      const r = 16;
      const circ = 2 * Math.PI * r;
      svg.appendChild(mkSvg('circle', { cx: 20, cy: 20, r, fill: 'none', stroke: 'rgba(128,128,128,0.18)', 'stroke-width': 3.5 }));
      const strokeCol = pct >= 85 ? '#ef4444' : (pct >= 65 ? '#f59e0b' : 'var(--ag-host-accent, var(--primary, #3274f6))');
      svg.appendChild(mkSvg('circle', {
        cx: 20, cy: 20, r, fill: 'none', stroke: strokeCol, 'stroke-width': 3.5, 'stroke-linecap': 'round',
        'stroke-dasharray': circ.toFixed(2),
        'stroke-dashoffset': (circ * (1 - pct / 100)).toFixed(2),
        transform: 'rotate(-90 20 20)'
      }));
      const lbl = doc.createElement('span');
      lbl.className = 'ag-ci-sc-ring-txt';
      lbl.textContent = budgetTok > 0 ? `${pct.toFixed(pct >= 10 ? 0 : 1)}%` : '--';
      box.appendChild(svg);
      box.appendChild(lbl);
      return { box, pct };
    }

    function renderFullPage() {
      if (!pageEl || !doc) return;
      const st = pageCtrl.getState();
      const copy = st.copy;
      const ledger = resolveUnifiedLedgerSnapshot(
        fetchedTokenHistoryCache && !deps.tokenData ? { ...deps, tokenData: fetchedTokenHistoryCache } : deps,
        {
          ...st,
          source: sourceFilter
        }
      );
      const summary = ledger.summary;
      const sidebarTitleMap = collectHostSidebarTitleMap();

      // 真实标题优先级：宿主左栏真实标题 > displayTitle/sidebarTitle/realTitle > 非首条消息的 title > sessionId
      const enrichedSessions = ledger.sessions.map((s) => {
        const sid = String(s.sessionId || s.cascadeId || '').trim();
        const sidebarTitle = sidebarTitleMap.get(sid) || '';
        const explicitTitle = String(s.sidebarTitle || s.displayTitle || s.realTitle || '').trim();
        const fallbackTitle = String(s.title || '').trim();
        const firstMsg = String(s.firstUserMessage || '').trim();
        const resolvedTitle = sidebarTitle
          || explicitTitle
          || (fallbackTitle && fallbackTitle !== firstMsg ? fallbackTitle : fallbackTitle)
          || sid
          || '--';
        const proj = String(s.workspaceTag || s.project || '').trim();
        const ctxUsed = Number(s.contextUsed ?? s.currentContextTokens ?? s.lastContextTokens ?? s.inputTokens ?? 0);
        const ctxBudget = Number(s.contextBudget ?? s.contextLimit ?? s.serviceLimit ?? 1000000);
        return {
          ...s,
          sessionId: sid,
          resolvedTitle,
          resolvedProject: proj,
          ctxUsed,
          ctxBudget,
          lastSnippet: String(s.lastMessagePreview || s.lastAssistantPreview || s.firstUserMessage || '').trim()
        };
      });

      const rangeSeries = Array.isArray(ledger.dailySeriesRange) && ledger.dailySeriesRange.length
        ? ledger.dailySeriesRange
        : ledger.dailySeries7d;
      if (selectedHeatmapDate && !rangeSeries.some((d) => d.date === selectedHeatmapDate)) {
        selectedHeatmapDate = '';
      }

      const heatMetricMode = st.heatmapMetric === 'sessions' ? 'sessions' : 'tokens';
      const heatVals = rangeSeries.map((d) => heatMetricMode === 'sessions' ? Number(d.sessions || 0) : Number(d.tokens || 0));
      const positiveHeatVals = heatVals.filter((v) => v > 0).sort((a, b) => a - b);
      const heatTop = positiveHeatVals.length
        ? positiveHeatVals[Math.min(positiveHeatVals.length - 1, Math.floor(positiveHeatVals.length * 0.95))] || positiveHeatVals[positiveHeatVals.length - 1]
        : 0;
      const toHeatLevel = (v) => {
        if (!(v > 0) || !(heatTop > 0)) return 0;
        const r = v / heatTop;
        if (r >= 0.78) return 4;
        if (r >= 0.48) return 3;
        if (r >= 0.22) return 2;
        return 1;
      };

      pageEl.setAttribute('aria-label', copy.pageTitle);
      ensureOverlayHostPosition(pageEl);
      while (pageEl.firstChild) pageEl.removeChild(pageEl.firstChild);

      const shell = doc.createElement('div');
      shell.className = 'ag-ci-shell';

      // Header
      const header = doc.createElement('header');
      header.className = 'ag-ci-header';
      const titleBox = doc.createElement('div');
      const h1 = doc.createElement('h1');
      h1.className = 'ag-ci-title';
      h1.textContent = copy.pageTitle;
      const sub = doc.createElement('p');
      sub.className = 'ag-ci-subtitle';
      sub.textContent = copy.pageSubtitle;
      titleBox.appendChild(h1);
      titleBox.appendChild(sub);

      const actions = doc.createElement('div');
      actions.className = 'ag-ci-actions';

      const rangeSeg = doc.createElement('div');
      rangeSeg.className = 'ag-ci-seg';
      rangeSeg.setAttribute('role', 'group');
      for (const [rk, rLabel] of [['7d', copy.dateRange7d], ['30d', copy.dateRange30d], ['all', copy.dateRangeAll]]) {
        const rb = doc.createElement('button');
        rb.type = 'button';
        rb.className = 'ag-ci-seg-btn';
        rb.setAttribute('data-range', rk);
        rb.setAttribute('aria-pressed', st.dateRange === rk ? 'true' : 'false');
        rb.textContent = rLabel;
        rb.addEventListener('click', () => {
          selectedHeatmapDate = '';
          sessionPage = 1;
          pageCtrl.setFilters({ dateRange: rk });
        });
        rangeSeg.appendChild(rb);
      }

      const srcSeg = doc.createElement('div');
      srcSeg.className = 'ag-ci-seg';
      srcSeg.setAttribute('role', 'group');
      for (const [sk, sLabel] of [['all', copy.sourceAll], ['desktop', copy.sourceDesktop], ['cli', copy.sourceCli]]) {
        const sb = doc.createElement('button');
        sb.type = 'button';
        sb.className = 'ag-ci-seg-btn';
        sb.setAttribute('data-source', sk);
        sb.setAttribute('aria-pressed', sourceFilter === sk ? 'true' : 'false');
        sb.textContent = sLabel;
        sb.addEventListener('click', () => {
          sourceFilter = sk;
          sessionPage = 1;
          renderFullPage();
        });
        srcSeg.appendChild(sb);
      }

      const profileBtn = doc.createElement('button');
      profileBtn.type = 'button';
      profileBtn.className = 'ag-ci-btn';
      profileBtn.setAttribute('data-ag-ci-action', 'profile');
      profileBtn.setAttribute('data-om-profile-entry', 'detailed-context');
      profileBtn.textContent = copy.openProfileHome;
      profileBtn.hidden = !profileEnabled;
      profileBtn.addEventListener('click', () => openProfileHome({ source: 'context-details' }));

      const refreshBtn = doc.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'ag-ci-btn';
      refreshBtn.setAttribute('data-ag-ci-action', 'refresh');
      refreshBtn.textContent = copy.refreshData;
      refreshBtn.addEventListener('click', () => triggerLedgerRefresh(() => renderFullPage()));

      const settingsBtn = doc.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'ag-ci-btn';
      settingsBtn.setAttribute('data-ag-ci-action', 'settings');
      settingsBtn.textContent = copy.openSettings;
      settingsBtn.addEventListener('click', () => {
        pageCtrl.closePage({ viaNativeNav: true });
        deps.onOpenSettings?.();
      });

      const backBtn = doc.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ag-ci-btn';
      backBtn.setAttribute('data-ag-ci-action', 'back');
      backBtn.textContent = copy.backToChat;
      backBtn.addEventListener('click', () => {
        pageCtrl.closePage({ viaNativeNav: false });
      });

      actions.appendChild(rangeSeg);
      actions.appendChild(srcSeg);
      actions.appendChild(profileBtn);
      actions.appendChild(refreshBtn);
      actions.appendChild(settingsBtn);
      actions.appendChild(backBtn);
      header.appendChild(titleBox);
      header.appendChild(actions);
      shell.appendChild(header);

      // ================================================================
      // 第 1 行：三区总览（左 2x3 KPI 卡 | 中 连续自然日双柱图 | 右 自然日活跃度矩阵热力图）
      // ================================================================
      const row1 = doc.createElement('div');
      row1.className = 'ag-ci-row1-overview';
      row1.setAttribute('data-om-ci-row', '1');

      // 1A. 左 2x3 KPI 卡
      const kpiGrid = doc.createElement('div');
      kpiGrid.className = 'ag-ci-kpi-grid-2x3';
      const kpis = [
        ['sessions', copy.kpiSessions, String(summary.sessionCount ?? enrichedSessions.length), `${copy.kpiArchivedSub} ${summary.archivedSessionCount ?? 0}`],
        ['tokens', copy.kpiTokens, formatCompactCount(summary.totalTokens ?? 0), `${summary.totalTurnsCount ?? 0} ${copy.kpiTurnsSub}`],
        ['cost', copy.kpiApiCost, summary.apiCostLabel || '$0.00', `${summary.pricedSessionCount ?? 0} ${copy.kpiPricedSub}`],
        ['cache', copy.kpiCacheHit, summary.cacheHitLabel || '--', `${summary.cacheMeasuredCount ?? 0} ${copy.kpiComputedSub}`],
        ['tools', copy.kpiToolCalls, String(summary.toolCalls ?? 0), summary.toolExecMsTotal > 0 ? formatDurationCompact(summary.toolExecMsTotal) : '--'],
        ['active', copy.kpiActiveTime, summary.activeTimeLabel || '--', `${summary.totalCalls ?? 0} ${copy.kpiModelCallsSub}`]
      ];
      for (const [kKey, lbl, val, subTxt] of kpis) {
        const card = doc.createElement('div');
        card.className = 'ag-ci-kpi-card';
        card.setAttribute('data-kpi-key', kKey);
        const lEl = doc.createElement('span');
        lEl.className = 'ag-ci-kpi-label';
        lEl.textContent = lbl;
        const vEl = doc.createElement('span');
        vEl.className = 'ag-ci-kpi-val';
        vEl.textContent = val;
        const sEl = doc.createElement('span');
        sEl.className = 'ag-ci-kpi-sub';
        sEl.textContent = subTxt;
        card.appendChild(lEl);
        card.appendChild(vEl);
        card.appendChild(sEl);
        kpiGrid.appendChild(card);
      }
      row1.appendChild(kpiGrid);

      // 1B. 中 连续自然日双柱状图（含今天，绝不跳日）
      const chartCard = doc.createElement('div');
      chartCard.className = 'ag-ci-card';
      chartCard.setAttribute('data-ag-ci-7d-chart', 'true');
      chartCard.setAttribute('data-om-ci-range-chart', 'true');
      const chartHdr = doc.createElement('div');
      chartHdr.className = 'ag-ci-card-hdr';
      const chartTitle = doc.createElement('div');
      chartTitle.className = 'ag-ci-card-title';
      chartTitle.textContent = st.dateRange === '30d' ? copy.chart30dTitle : (st.dateRange === 'all' ? copy.chartAllTitle : copy.chart7dTitle);
      const chartLegend = doc.createElement('div');
      chartLegend.className = 'ag-ci-subtitle';
      chartLegend.textContent = `${copy.chart7dTokensLegend} · ${copy.chart7dCostLegend}`;
      chartHdr.appendChild(chartTitle);
      chartHdr.appendChild(chartLegend);
      chartCard.appendChild(chartHdr);

      const maxRangeTok = Math.max(1, ...rangeSeries.map((d) => d.tokens));
      const maxRangeCost = Math.max(0.01, ...rangeSeries.map((d) => d.costUSD));
      const barsWrap = doc.createElement('div');
      barsWrap.className = 'ag-ci-range-bars';
      barsWrap.setAttribute('data-bar-count', String(rangeSeries.length));
      const labelStep = rangeSeries.length > 14 ? Math.ceil(rangeSeries.length / 7) : 1;
      rangeSeries.forEach((item, idx) => {
        const col = doc.createElement('div');
        col.className = 'ag-ci-range-col ag-ci-7d-col';
        col.setAttribute('data-date', item.date);
        if (item.date === ledger.todayStr) col.setAttribute('data-today', 'true');
        col.title = `${item.date} · ${formatCompactCount(item.tokens)} · ${formatUsdShort(item.costUSD)}`;
        const pair = doc.createElement('div');
        pair.className = 'ag-ci-range-pair';
        const bTok = doc.createElement('span');
        bTok.className = 'ag-ci-7d-bar-tok';
        bTok.style.width = rangeSeries.length > 14 ? '5px' : '11px';
        bTok.style.height = `${item.tokens > 0 ? Math.max(8, Math.round((item.tokens / maxRangeTok) * 90)) : 3}px`;
        const bCost = doc.createElement('span');
        bCost.className = 'ag-ci-7d-bar-cost';
        bCost.style.width = rangeSeries.length > 14 ? '4px' : '9px';
        bCost.style.height = `${item.costUSD > 0 ? Math.max(6, Math.round((item.costUSD / maxRangeCost) * 90)) : 3}px`;
        pair.appendChild(bTok);
        pair.appendChild(bCost);
        const lbl = doc.createElement('span');
        lbl.className = 'ag-ci-7d-lbl';
        lbl.textContent = (idx % labelStep === 0 || idx === rangeSeries.length - 1) ? item.date.slice(5) : '';
        col.appendChild(pair);
        col.appendChild(lbl);
        barsWrap.appendChild(col);
      });
      chartCard.appendChild(barsWrap);
      row1.appendChild(chartCard);

      // 1C. 右 自然日活跃度矩阵热力图（列数 = 区间自然日数，最后一列 = 今天，点击锁定筛选当日详情）
      const heatCard = doc.createElement('div');
      heatCard.className = 'ag-ci-card';
      heatCard.setAttribute('data-om-ci-heatmap', 'true');
      heatCard.setAttribute('data-heatmap-direction', 'ltr');
      heatCard.setAttribute('data-heat-days', String(rangeSeries.length));
      const heatHdr = doc.createElement('div');
      heatHdr.className = 'ag-ci-card-hdr';
      const heatTitle = doc.createElement('div');
      heatTitle.className = 'ag-ci-card-title';
      heatTitle.textContent = `${copy.heatmapTitle} · ${rangeSeries[0]?.date || ledger.todayStr} → ${ledger.todayStr}`;
      const metricSeg = doc.createElement('div');
      metricSeg.className = 'ag-ci-seg';
      for (const [mk, mLbl] of [['sessions', copy.heatmapModeSessions], ['tokens', copy.heatmapModeTokens]]) {
        const mb = doc.createElement('button');
        mb.type = 'button';
        mb.className = 'ag-ci-seg-btn';
        mb.setAttribute('data-metric', mk);
        mb.setAttribute('aria-pressed', heatMetricMode === mk ? 'true' : 'false');
        mb.textContent = mLbl;
        mb.addEventListener('click', () => pageCtrl.setFilters({ heatmapMetric: mk }));
        metricSeg.appendChild(mb);
      }
      heatHdr.appendChild(heatTitle);
      heatHdr.appendChild(metricSeg);
      heatCard.appendChild(heatHdr);

      const dayHeatWrap = doc.createElement('div');
      dayHeatWrap.className = 'ag-ci-day-heat-wrap';
      rangeSeries.forEach((item, idx) => {
        const val = heatMetricMode === 'sessions' ? Number(item.sessions || 0) : Number(item.tokens || 0);
        const lvl = toHeatLevel(val);
        const dCol = doc.createElement('div');
        dCol.className = 'ag-ci-day-col';
        dCol.setAttribute('data-heat-col-date', item.date);
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-ci-day-btn ag-ci-heat-dot ag-ci-heat-cell';
        btn.setAttribute('data-date', item.date);
        btn.setAttribute('data-om-heat-date', item.date);
        btn.setAttribute('data-level', String(lvl));
        btn.setAttribute('data-selected', selectedHeatmapDate === item.date ? 'true' : 'false');
        btn.setAttribute('aria-pressed', selectedHeatmapDate === item.date ? 'true' : 'false');
        if (item.date === ledger.todayStr) btn.setAttribute('data-today', 'true');
        btn.title = `${item.date} · ${heatMetricMode === 'sessions' ? `${item.sessions} ${copy.heatmapModeSessions}` : `${formatCompactCount(item.tokens)} tok`} · ${formatUsdShort(item.costUSD)}`;
        btn.setAttribute('aria-label', btn.title);
        btn.addEventListener('click', () => {
          selectedHeatmapDate = selectedHeatmapDate === item.date ? '' : item.date;
          sessionPage = 1;
          renderFullPage();
        });
        const dLbl = doc.createElement('span');
        dLbl.className = 'ag-ci-day-lbl';
        dLbl.textContent = (idx === 0 || idx === rangeSeries.length - 1 || (rangeSeries.length <= 10)) ? item.date.slice(8) : '';
        dCol.appendChild(btn);
        dCol.appendChild(dLbl);
        dayHeatWrap.appendChild(dCol);
      });
      heatCard.appendChild(dayHeatWrap);

      if (selectedHeatmapDate) {
        const selRec = rangeSeries.find((d) => d.date === selectedHeatmapDate);
        const detailBar = doc.createElement('div');
        detailBar.className = 'ag-ci-heat-detail-bar';
        detailBar.setAttribute('data-om-selected-day', selectedHeatmapDate);
        const infoSp = doc.createElement('span');
        infoSp.textContent = `${copy.heatmapDayDetail} ${selectedHeatmapDate} · ${formatCompactCount(selRec?.tokens || 0)} tok · ${selRec?.sessions || 0} ${copy.heatmapModeSessions} · ${formatUsdShort(selRec?.costUSD || 0)}`;
        const clrBtn = doc.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'ag-ci-btn';
        clrBtn.style.height = '24px';
        clrBtn.textContent = copy.heatmapClearDay;
        clrBtn.addEventListener('click', () => {
          selectedHeatmapDate = '';
          sessionPage = 1;
          renderFullPage();
        });
        detailBar.appendChild(infoSp);
        detailBar.appendChild(clrBtn);
        heatCard.appendChild(detailBar);
      }
      row1.appendChild(heatCard);
      shell.appendChild(row1);

      // ================================================================
      // 第 2 行：等高双分析卡（左 Token 统计环形图 | 右 耗时统计环形图）
      // ================================================================
      const row2 = doc.createElement('div');
      row2.className = 'ag-ci-grid-2';
      row2.setAttribute('data-om-ci-row', '2');

      // 2A. Token 统计
      const tokCard = doc.createElement('div');
      tokCard.className = 'ag-ci-card';
      tokCard.setAttribute('data-om-ci-card', 'token-stats');
      const tokHdr = doc.createElement('div');
      tokHdr.className = 'ag-ci-card-hdr';
      const tokTitle = doc.createElement('div');
      tokTitle.className = 'ag-ci-card-title';
      tokTitle.textContent = copy.tokenStatsTitle;
      const tokBadge = doc.createElement('span');
      tokBadge.className = 'ag-ci-subtitle';
      tokBadge.textContent = `${copy.kpiCacheHit} ${summary.cacheHitLabel || '--'}`;
      tokHdr.appendChild(tokTitle);
      tokHdr.appendChild(tokBadge);
      tokCard.appendChild(tokHdr);

      const tokSegs = [
        { label: copy.distInput, value: summary.inputTokens, color: '#10b981' },
        { label: copy.distCache, value: summary.cacheReadTokens, color: '#06b6d4' },
        { label: copy.distOutput, value: summary.outputTokens, color: 'var(--ag-host-accent, var(--primary, #3274f6))' }
      ];
      const tokBody = doc.createElement('div');
      tokBody.className = 'ag-ci-donut-row';
      tokBody.appendChild(createDonutSvg(tokSegs, formatCompactCount(summary.totalTokens || 0), 'Token'));
      const tokLeg = doc.createElement('div');
      tokLeg.className = 'ag-ci-donut-legend';
      const totMix = Math.max(1, summary.inputTokens + summary.cacheReadTokens + summary.outputTokens);
      for (const s of tokSegs) {
        const it = doc.createElement('div');
        it.className = 'ag-ci-legend-item';
        const left = doc.createElement('span');
        left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        const dot = doc.createElement('i');
        dot.className = 'ag-ci-legend-dot';
        dot.style.background = s.color;
        const lblSp = doc.createElement('span');
        lblSp.textContent = s.label;
        left.appendChild(dot);
        left.appendChild(lblSp);
        const right = doc.createElement('strong');
        right.style.fontVariantNumeric = 'tabular-nums';
        right.textContent = `${formatCompactCount(s.value)} · ${Math.round((s.value / totMix) * 100)}%`;
        it.appendChild(left);
        it.appendChild(right);
        tokLeg.appendChild(it);
      }
      tokBody.appendChild(tokLeg);
      tokCard.appendChild(tokBody);
      row2.appendChild(tokCard);

      // 2B. 耗时统计（仅显示真实可采集维度，绝不编造）
      const timeCard = doc.createElement('div');
      timeCard.className = 'ag-ci-card';
      timeCard.setAttribute('data-om-ci-card', 'timing-stats');
      const timeHdr = doc.createElement('div');
      timeHdr.className = 'ag-ci-card-hdr';
      const timeTitle = doc.createElement('div');
      timeTitle.className = 'ag-ci-card-title';
      timeTitle.textContent = copy.timingStatsTitle;
      const tpsBadge = doc.createElement('span');
      tpsBadge.className = 'ag-ci-subtitle';
      tpsBadge.textContent = summary.avgTps > 0 ? `${summary.avgTps.toFixed(1)} tok/s` : '-- tok/s';
      timeHdr.appendChild(timeTitle);
      timeHdr.appendChild(tpsBadge);
      timeCard.appendChild(timeHdr);

      const genMs = Math.max(0, Number(summary.activeTimeMs || 0) - Number(summary.totalTtftMs || 0) - Number(summary.toolExecMsTotal || 0));
      const realTimeSegs = [
        { label: copy.timingWaitLabel, value: Number(summary.totalTtftMs || 0), color: '#f59e0b' },
        { label: copy.timingGenLabel, value: genMs, color: 'var(--ag-host-accent, var(--primary, #3274f6))' },
        { label: copy.timingToolLabel, value: Number(summary.toolExecMsTotal || 0), color: '#10b981' }
      ].filter((x) => x.value > 0);
      const timeBody = doc.createElement('div');
      timeBody.className = 'ag-ci-donut-row';
      timeBody.appendChild(createDonutSvg(realTimeSegs, summary.activeTimeMs > 0 ? formatDurationCompact(summary.activeTimeMs) : '--', ''));
      const timeLeg = doc.createElement('div');
      timeLeg.className = 'ag-ci-donut-legend';
      if (!realTimeSegs.length) {
        const em = doc.createElement('div');
        em.className = 'ag-ci-subtitle';
        em.textContent = copy.timingEmpty;
        timeLeg.appendChild(em);
      } else {
        for (const s of realTimeSegs) {
          const it = doc.createElement('div');
          it.className = 'ag-ci-legend-item';
          const left = doc.createElement('span');
          left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
          const dot = doc.createElement('i');
          dot.className = 'ag-ci-legend-dot';
          dot.style.background = s.color;
          const lblSp = doc.createElement('span');
          lblSp.textContent = s.label;
          left.appendChild(dot);
          left.appendChild(lblSp);
          const right = doc.createElement('strong');
          right.style.fontVariantNumeric = 'tabular-nums';
          right.textContent = formatDurationCompact(s.value);
          it.appendChild(left);
          it.appendChild(right);
          timeLeg.appendChild(it);
        }
        if (summary.avgTtftMs > 0) {
          const it = doc.createElement('div');
          it.className = 'ag-ci-legend-item';
          const lblSp = doc.createElement('span');
          lblSp.textContent = copy.distAvgTtft;
          it.appendChild(lblSp);
          const r = doc.createElement('strong');
          r.textContent = formatDurationCompact(summary.avgTtftMs);
          it.appendChild(r);
          timeLeg.appendChild(it);
        }
      }
      timeBody.appendChild(timeLeg);
      timeCard.appendChild(timeBody);
      row2.appendChild(timeCard);
      shell.appendChild(row2);

      // ================================================================
      // 第 3 行：等宽四列排行卡（项目分布 / 技能加载 / 工具调用 / 命令执行）
      // ================================================================
      const rankGrid = doc.createElement('div');
      rankGrid.className = 'ag-ci-grid-4';
      rankGrid.setAttribute('data-om-ci-row', '3');
      rankGrid.appendChild(renderRankCard(copy.rankProjectsTitle, ledger.topProjects, copy.rankEmpty, true));
      rankGrid.appendChild(renderRankCard(copy.rankSkillsTitle, ledger.topSkills, copy.rankEmpty, false));
      rankGrid.appendChild(renderRankCard(copy.rankToolsTitle, ledger.topTools, copy.rankEmpty, false));
      rankGrid.appendChild(renderRankCard(copy.rankCommandsTitle, ledger.topCommands, copy.rankEmpty, false));
      shell.appendChild(rankGrid);

      // ================================================================
      // 第 4 行：会话网格卡片区（工具条 + 3–6 列自适应卡片网格 + 底部分页）
      // ================================================================
      const sessCard = doc.createElement('div');
      sessCard.className = 'ag-ci-card';
      sessCard.setAttribute('data-om-ci-row', '4');

      // 过滤与排序
      const qLower = String(st.searchQuery || '').trim().toLowerCase();
      let gridSessions = enrichedSessions.filter((s) => {
        if (selectedHeatmapDate && s.date !== selectedHeatmapDate) return false;
        if (selectedProjectFilter !== 'all' && s.resolvedProject !== selectedProjectFilter) return false;
        if (archiveFilter === 'active' && (s.archived || s.isArchived)) return false;
        if (archiveFilter === 'archived' && !(s.archived || s.isArchived)) return false;
        if (qLower) {
          const hay = `${s.resolvedTitle} ${s.resolvedProject} ${s.sessionId} ${s.lastSnippet}`.toLowerCase();
          if (!hay.includes(qLower)) return false;
        }
        return true;
      });
      if (sessionSortBy === 'tokens') {
        gridSessions.sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0));
      } else if (sessionSortBy === 'context') {
        gridSessions.sort((a, b) => Number(b.ctxUsed || 0) - Number(a.ctxUsed || 0));
      } else if (sessionSortBy === 'recent') {
        gridSessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      }

      const sessToolbar = doc.createElement('div');
      sessToolbar.className = 'ag-ci-session-toolbar';
      const sessLeft = doc.createElement('div');
      sessLeft.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
      const sessTitle = doc.createElement('div');
      sessTitle.className = 'ag-ci-card-title';
      sessTitle.textContent = `${copy.sessionsTitle} · ${gridSessions.length}`;
      sessLeft.appendChild(sessTitle);

      // 项目筛选胶囊（全部 + 各真实项目）
      const projPills = doc.createElement('div');
      projPills.className = 'ag-ci-proj-pills';
      const projNames = ['all', ...ledger.topProjects.map((p) => p.name)];
      if (selectedProjectFilter !== 'all' && !projNames.includes(selectedProjectFilter)) selectedProjectFilter = 'all';
      for (const pn of projNames) {
        const pb = doc.createElement('button');
        pb.type = 'button';
        pb.className = 'ag-ci-seg-btn';
        pb.setAttribute('data-project-filter', pn);
        pb.setAttribute('aria-pressed', selectedProjectFilter === pn ? 'true' : 'false');
        pb.textContent = pn === 'all' ? copy.filterAllProjects : pn;
        pb.addEventListener('click', () => {
          selectedProjectFilter = pn;
          sessionPage = 1;
          renderFullPage();
        });
        projPills.appendChild(pb);
      }
      sessLeft.appendChild(projPills);

      const sessRight = doc.createElement('div');
      sessRight.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      const searchInp = doc.createElement('input');
      searchInp.type = 'search';
      searchInp.className = 'ag-ci-search';
      searchInp.placeholder = copy.searchPlaceholder;
      searchInp.value = st.searchQuery || '';
      searchInp.addEventListener('input', (ev) => {
        sessionPage = 1;
        pageCtrl.setFilters({ searchQuery: ev?.target?.value ?? '' });
      });

      const archSel = doc.createElement('select');
      archSel.className = 'ag-ci-select';
      archSel.setAttribute('data-archive-filter', 'true');
      for (const [ak, aLbl] of [['all', copy.archiveAll], ['active', copy.archiveActive], ['archived', copy.archiveOnly]]) {
        const opt = doc.createElement('option');
        opt.value = ak;
        opt.textContent = aLbl;
        if (archiveFilter === ak) opt.selected = true;
        archSel.appendChild(opt);
      }
      archSel.addEventListener('change', (ev) => {
        archiveFilter = String(ev?.target?.value || 'all');
        sessionPage = 1;
        renderFullPage();
      });

      const sortSeg = doc.createElement('div');
      sortSeg.className = 'ag-ci-seg';
      sortSeg.setAttribute('role', 'group');
      for (const [sk, sLbl] of [['recent', copy.sortRecent], ['tokens', copy.sortTokens], ['context', copy.sortContext]]) {
        const sb = doc.createElement('button');
        sb.type = 'button';
        sb.className = 'ag-ci-seg-btn';
        sb.setAttribute('data-sort-by', sk);
        sb.setAttribute('aria-pressed', sessionSortBy === sk ? 'true' : 'false');
        sb.textContent = sLbl;
        sb.addEventListener('click', () => {
          sessionSortBy = sk;
          sessionPage = 1;
          renderFullPage();
        });
        sortSeg.appendChild(sb);
      }

      sessRight.appendChild(searchInp);
      sessRight.appendChild(archSel);
      sessRight.appendChild(sortSeg);
      sessToolbar.appendChild(sessLeft);
      sessToolbar.appendChild(sessRight);
      sessCard.appendChild(sessToolbar);

      // 卡片网格 + 分页
      const PAGE_SIZE = 12;
      const totalPages = Math.max(1, Math.ceil(gridSessions.length / PAGE_SIZE));
      if (sessionPage > totalPages) sessionPage = totalPages;
      const pageSlice = gridSessions.slice((sessionPage - 1) * PAGE_SIZE, sessionPage * PAGE_SIZE);

      const gridWrap = doc.createElement('div');
      gridWrap.className = 'ag-ci-session-grid';
      gridWrap.setAttribute('data-om-session-grid', 'true');
      if (!pageSlice.length) {
        const empty = doc.createElement('div');
        empty.className = 'ag-ci-subtitle';
        empty.textContent = copy.emptySessions;
        gridWrap.appendChild(empty);
      } else {
        for (const s of pageSlice) {
          const cardBtn = doc.createElement('button');
          cardBtn.type = 'button';
          cardBtn.className = 'ag-ci-session-card ag-ci-session-row';
          cardBtn.setAttribute('data-om-session-card', 'true');
          cardBtn.setAttribute('data-session-id', s.sessionId);

          const top = doc.createElement('div');
          top.className = 'ag-ci-sc-top';
          const tEl = doc.createElement('div');
          tEl.className = 'ag-ci-sc-title ag-ci-session-title';
          tEl.setAttribute('data-om-session-title', 'true');
          tEl.textContent = s.resolvedTitle;
          const timeEl = doc.createElement('span');
          timeEl.className = 'ag-ci-sc-time';
          timeEl.textContent = formatRelativeTimeCompact(s.updatedAt, s.date, copy);
          top.appendChild(tEl);
          top.appendChild(timeEl);
          cardBtn.appendChild(top);

          if (s.resolvedProject) {
            const tag = doc.createElement('span');
            tag.className = 'ag-ci-sc-tag';
            tag.textContent = s.resolvedProject;
            cardBtn.appendChild(tag);
          }

          const body = doc.createElement('div');
          body.className = 'ag-ci-sc-body';
          const { box: ringBox } = createMiniContextRing(s.ctxUsed, s.ctxBudget);
          const metrics = doc.createElement('div');
          metrics.className = 'ag-ci-sc-metrics';
          const turnsNum = Number(s.turnCount ?? s.turns ?? s.callCount ?? 0);
          const stepsNum = Number(s.stepCount ?? s.steps ?? s.callCount ?? 0);
          const line1 = doc.createElement('div');
          line1.textContent = `${formatCompactCount(s.ctxUsed)} · ${turnsNum} ${copy.kpiTurnsSub} ${stepsNum} 步`.replace('步', lang === 'en' ? 'steps' : '步');
          const line2 = doc.createElement('div');
          line2.textContent = `${formatCompactCount(s.totalTokens || 0)} tok · ${formatUsdShort(s.costUSD || 0)}`;
          metrics.appendChild(line1);
          metrics.appendChild(line2);
          body.appendChild(ringBox);
          body.appendChild(metrics);
          cardBtn.appendChild(body);

          if (s.lastSnippet) {
            const snip = doc.createElement('div');
            snip.className = 'ag-ci-sc-snippet';
            snip.textContent = s.lastSnippet;
            cardBtn.appendChild(snip);
          }

          cardBtn.addEventListener('click', () => {
            pageCtrl.closePage({ viaNativeNav: true });
            deps.onOpenSession?.(s);
          });
          gridWrap.appendChild(cardBtn);
        }
      }
      sessCard.appendChild(gridWrap);

      if (totalPages > 1) {
        const pager = doc.createElement('div');
        pager.className = 'ag-ci-pagination';
        pager.setAttribute('data-om-session-pagination', 'true');
        const prevBtn = doc.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'ag-ci-btn';
        prevBtn.textContent = copy.pagePrev;
        prevBtn.disabled = sessionPage <= 1;
        prevBtn.addEventListener('click', () => { if (sessionPage > 1) { sessionPage -= 1; renderFullPage(); } });
        const info = doc.createElement('span');
        info.textContent = `${sessionPage} / ${totalPages}`;
        const nextBtn = doc.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'ag-ci-btn';
        nextBtn.textContent = copy.pageNext;
        nextBtn.disabled = sessionPage >= totalPages;
        nextBtn.addEventListener('click', () => { if (sessionPage < totalPages) { sessionPage += 1; renderFullPage(); } });
        pager.appendChild(prevBtn);
        pager.appendChild(info);
        pager.appendChild(nextBtn);
        sessCard.appendChild(pager);
      }
      shell.appendChild(sessCard);

      pageEl.appendChild(shell);
    }

    /**
     * 渲染「个人 Token 用量主页」（仿 Codex 居中极简风，完整承载 12 项功能、左起热力图、全量缓存总览与底部极简洞察）
     */
    function renderProfileHome() {
      if (!profileEl || !doc || !profileEnabled) return;
      const copy = getInsightsCopy(lang);
      const ledgerDeps = fetchedTokenHistoryCache && !deps.tokenData
        ? { ...deps, tokenData: fetchedTokenHistoryCache }
        : deps;
      const ledger = resolveUnifiedLedgerSnapshot(ledgerDeps, {
        dateRange: 'all',
        source: profileSourceFilter,
        accountScope: profileAccountScope
      });
      const metrics = computeProfileHomeMetrics(ledger);
      const cache = metrics.cacheOverview;
      const heatModel = buildLeftToRightHeatmapModel(ledger.allDailyMap, {
        firstUseDate: ledger.firstUseDate,
        todayStr: ledger.todayStr,
        metric: 'tokens',
        maxWeeks: 52,
        minWeeks: 16
      });

      // 统一精确口径四周期计算（累计 / 今日 / 本月 / 年度），与详细上下文完全一致
      const todayKey = ledger.todayStr;
      const monthPrefix = todayKey.slice(0, 7);
      const yearPrefix = todayKey.slice(0, 4);
      const allDailyEntries = Object.entries(ledger.allDailyMap || {}).filter(([dk]) => /^\d{4}-\d{2}-\d{2}$/.test(dk) && dk <= todayKey);
      const sumPeriod = (pred) => {
        let tok = 0;
        let usd = 0;
        let activeDays = 0;
        for (const [dk, rec] of allDailyEntries) {
          if (!pred(dk)) continue;
          const tVal = Number(rec?.total ?? rec?.tokens ?? 0);
          const cVal = Number(rec?.costUSD ?? 0);
          tok += tVal;
          usd += cVal;
          if (tVal > 0) activeDays += 1;
        }
        return { tokens: tok, costUSD: usd, activeDays: Math.max(1, activeDays) };
      };
      const periodAll = {
        tokens: ledger.summary.totalTokens || sumPeriod(() => true).tokens,
        costUSD: ledger.summary.apiCostUSD || sumPeriod(() => true).costUSD,
        activeDays: Math.max(1, ledger.summary.activeDaysCount || sumPeriod(() => true).activeDays)
      };
      const periodToday = sumPeriod((dk) => dk === todayKey);
      const periodMonth = sumPeriod((dk) => dk.startsWith(monthPrefix));
      const periodYear = sumPeriod((dk) => dk.startsWith(yearPrefix));

      profileEl.setAttribute('aria-label', copy.profileTitle);
      profileEl.setAttribute('data-om-profile-subtab', profileSubtab);
      ensureOverlayHostPosition(profileEl);
      if (profileHeatmapCtrl) {
        try { profileHeatmapCtrl.destroy?.(); } catch { }
        profileHeatmapCtrl = null;
      }
      while (profileEl.firstChild) profileEl.removeChild(profileEl.firstChild);

      const shell = doc.createElement('div');
      shell.className = 'ag-ph-shell';

      // Top-right minimal real actions ONLY: Refresh + Back to Chat (严禁编辑/私有/分享/精选作品/热门插件)
      const topbar = doc.createElement('div');
      topbar.className = 'ag-ph-topbar';
      const refreshBtn = doc.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'ag-ph-btn';
      refreshBtn.setAttribute('data-ag-ph-action', 'refresh');
      refreshBtn.textContent = copy.refreshData;
      refreshBtn.addEventListener('click', () => triggerLedgerRefresh(() => renderProfileHome()));
      const backBtn = doc.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ag-ph-btn';
      backBtn.setAttribute('data-ag-ph-action', 'back');
      backBtn.textContent = copy.backToChat;
      backBtn.addEventListener('click', () => closeProfileHome({ viaNativeNav: false }));
      topbar.appendChild(refreshBtn);
      topbar.appendChild(backBtn);
      shell.appendChild(topbar);

      // 首屏 1：居中圆形真实头像（无头像降级首字母）+ 用户名与账号标识
      const hero = doc.createElement('div');
      hero.className = 'ag-ph-hero';
      const acc = ledger.account || null;
      const displayName = String(acc?.name || acc?.email?.split?.('@')?.[0] || copy.profileGuest);
      const displayEmail = String(acc?.email || acc?.maskedEmail || copy.profileUnbound);
      const planLabel = String(acc?.planLabel || acc?.tierName || '').trim();
      const avatarUrl = typeof acc?.profilePictureUrl === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(acc.profilePictureUrl.trim())
        ? acc.profilePictureUrl.trim()
        : '';

      const avatarBox = doc.createElement('div');
      avatarBox.className = 'ag-ph-avatar';
      avatarBox.setAttribute('data-ag-ph-avatar', 'true');
      if (avatarUrl) {
        const img = doc.createElement('img');
        img.src = avatarUrl;
        img.alt = displayName;
        img.referrerPolicy = 'no-referrer';
        avatarBox.appendChild(img);
      } else {
        avatarBox.style.background = 'linear-gradient(135deg, var(--ag-host-accent, var(--primary, #3274f6)), #2563eb)';
        avatarBox.textContent = (displayName[0] || 'A').toUpperCase();
      }
      const nameEl = doc.createElement('h1');
      nameEl.className = 'ag-ph-name';
      nameEl.textContent = displayName;
      const handleEl = doc.createElement('p');
      handleEl.className = 'ag-ph-handle';
      const emailSpan = doc.createElement('span');
      emailSpan.textContent = displayEmail;
      handleEl.appendChild(emailSpan);
      if (planLabel && !/^unknown$/i.test(planLabel)) {
        const pill = doc.createElement('span');
        pill.className = 'ag-ph-plan-pill';
        pill.textContent = planLabel;
        handleEl.appendChild(pill);
      }
      hero.appendChild(avatarBox);
      hero.appendChild(nameEl);
      hero.appendChild(handleEl);
      shell.appendChild(hero);

      // 首屏 2：5 项核心圆角细边框数据胶囊横条
      const strip = doc.createElement('div');
      strip.className = 'ag-ph-capsule-strip';
      strip.setAttribute('data-ag-ph-core-strip', 'true');
      const coreStats = [
        ['totalTokens', formatCompactCount(metrics.totalTokens), copy.profileStatTotal],
        ['peakTokens', formatCompactCount(metrics.peakTokens), copy.profileStatPeak],
        ['longestTask', metrics.longestTaskLabel, copy.profileStatLongestTask],
        ['longestStreak', `${metrics.longestStreakDays} ${copy.profileStreakUnit}`, copy.profileStatLongestStreak],
        ['currentStreak', `${metrics.currentStreakDays} ${copy.profileStreakUnit}`, copy.profileStatCurrentStreak]
      ];
      for (const [k, val, lbl] of coreStats) {
        const cell = doc.createElement('div');
        cell.className = 'ag-ph-stat-cell';
        cell.setAttribute('data-stat-key', k);
        const vEl = doc.createElement('span');
        vEl.className = 'ag-ph-stat-val';
        vEl.textContent = val;
        const lEl = doc.createElement('span');
        lEl.className = 'ag-ph-stat-lbl';
        lEl.textContent = lbl;
        cell.appendChild(vEl);
        cell.appendChild(lEl);
        strip.appendChild(cell);
      }
      shell.appendChild(strip);

      // 迁移项 (1)(2)(3)：顶部四子页切换 + 来源切换 + 账本范围下拉
      const ctrlBar = doc.createElement('div');
      ctrlBar.className = 'ag-ph-ctrl-bar';
      const subTabs = doc.createElement('div');
      subTabs.className = 'ag-ph-seg';
      subTabs.setAttribute('data-om-ph-subtabs', 'true');
      for (const sk of ['tokens', 'models', 'cost', 'requests']) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'ag-ph-seg-btn';
        b.setAttribute('data-om-ph-subtab', sk);
        b.setAttribute('aria-pressed', profileSubtab === sk ? 'true' : 'false');
        b.textContent = copy.profileSubtabs?.[sk] || sk;
        b.addEventListener('click', () => { profileSubtab = sk; renderProfileHome(); });
        subTabs.appendChild(b);
      }
      const ctrlRight = doc.createElement('div');
      ctrlRight.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      const srcSeg = doc.createElement('div');
      srcSeg.className = 'ag-ph-seg';
      srcSeg.setAttribute('data-om-ph-source-seg', 'true');
      for (const [srcK, srcLbl] of [['all', copy.sourceAll], ['desktop', copy.sourceDesktop], ['cli', copy.sourceCli]]) {
        const sb = doc.createElement('button');
        sb.type = 'button';
        sb.className = 'ag-ph-seg-btn';
        sb.setAttribute('data-om-ph-source', srcK);
        sb.setAttribute('aria-pressed', profileSourceFilter === srcK ? 'true' : 'false');
        sb.textContent = srcLbl;
        sb.addEventListener('click', () => { profileSourceFilter = srcK; renderProfileHome(); });
        srcSeg.appendChild(sb);
      }
      const scopeSel = doc.createElement('select');
      scopeSel.className = 'ag-ph-select';
      scopeSel.setAttribute('data-om-ph-scope', 'true');
      const allOpt = doc.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = copy.allAccounts;
      if (profileAccountScope === 'all') allOpt.selected = true;
      scopeSel.appendChild(allOpt);
      for (const ac of (Array.isArray(ledger.accounts) ? ledger.accounts : [])) {
        const key = String(ac?.accountScopeKey || ac?.accountId || ac?.email || '').trim();
        if (!key) continue;
        const opt = doc.createElement('option');
        opt.value = key;
        opt.textContent = String(ac?.email || ac?.name || key);
        if (profileAccountScope === key) opt.selected = true;
        scopeSel.appendChild(opt);
      }
      scopeSel.addEventListener('change', (ev) => {
        profileAccountScope = String(ev?.target?.value || 'all');
        renderProfileHome();
      });
      ctrlRight.appendChild(srcSeg);
      ctrlRight.appendChild(scopeSel);
      ctrlBar.appendChild(subTabs);
      ctrlBar.appendChild(ctrlRight);
      shell.appendChild(ctrlBar);

      if (profileSubtab === 'models') {
        const mCard = doc.createElement('div');
        mCard.className = 'ag-ph-card';
        mCard.setAttribute('data-om-ph-subview', 'models');
        const mTitle = doc.createElement('div');
        mTitle.className = 'ag-ph-card-title';
        mTitle.textContent = copy.profileSubtabs.models;
        mCard.appendChild(mTitle);
        if (!cache.byModel.length) {
          const em = doc.createElement('div');
          em.className = 'ag-ph-kv-key';
          em.textContent = copy.profileModelEmpty;
          mCard.appendChild(em);
        } else {
          const tbl = doc.createElement('table');
          tbl.className = 'ag-ph-table';
          const thead = doc.createElement('thead');
          const hr = doc.createElement('tr');
          for (const h of [copy.profileInsightTopModel, copy.distInput, copy.distCache, copy.kpiCacheHit]) {
            const th = doc.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
          }
          thead.appendChild(hr);
          tbl.appendChild(thead);
          const tbody = doc.createElement('tbody');
          for (const m of cache.byModel) {
            const tr = doc.createElement('tr');
            for (const cVal of [m.model, formatCompactCount(m.input || 0), formatCompactCount(m.cache || 0), m.hitPct !== null ? `${m.hitPct}%` : '--']) {
              const td = doc.createElement('td');
              td.textContent = cVal;
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          tbl.appendChild(tbody);
          mCard.appendChild(tbl);
        }
        shell.appendChild(mCard);
      } else if (profileSubtab === 'cost') {
        const cCard = doc.createElement('div');
        cCard.className = 'ag-ph-card';
        cCard.setAttribute('data-om-ph-subview', 'cost');
        const cTitle = doc.createElement('div');
        cTitle.className = 'ag-ph-card-title';
        cTitle.textContent = `${copy.profileSubtabs.cost} · ${formatUsdShort(periodAll.costUSD)}`;
        cCard.appendChild(cTitle);
        const list = doc.createElement('div');
        list.className = 'ag-ph-kv-list';
        for (const [lbl, p] of [
          [copy.profilePeriodAll, periodAll],
          [copy.profilePeriodToday, periodToday],
          [copy.profilePeriodMonth, periodMonth],
          [copy.profilePeriodYear, periodYear]
        ]) {
          const row = doc.createElement('div');
          row.className = 'ag-ph-kv-row';
          const kEl = doc.createElement('span');
          kEl.className = 'ag-ph-kv-key';
          kEl.textContent = lbl;
          const vEl = doc.createElement('span');
          vEl.className = 'ag-ph-kv-val';
          vEl.textContent = `${formatUsdShort(p.costUSD)} · ${formatCompactCount(p.tokens)} tok`;
          row.appendChild(kEl);
          row.appendChild(vEl);
          list.appendChild(row);
        }
        cCard.appendChild(list);
        shell.appendChild(cCard);
      } else if (profileSubtab === 'requests') {
        const rCard = doc.createElement('div');
        rCard.className = 'ag-ph-card';
        rCard.setAttribute('data-om-ph-subview', 'requests');
        const rTitle = doc.createElement('div');
        rTitle.className = 'ag-ph-card-title';
        rTitle.textContent = copy.profileSubtabs.requests;
        rCard.appendChild(rTitle);
        const logs = Array.isArray(ledger.recentRequestLogs) ? ledger.recentRequestLogs.slice(0, 30) : [];
        if (!logs.length) {
          const em = doc.createElement('div');
          em.className = 'ag-ph-kv-key';
          em.textContent = copy.profileReqEmpty;
          rCard.appendChild(em);
        } else {
          const list = doc.createElement('div');
          list.className = 'ag-ph-kv-list';
          for (const lg of logs) {
            const row = doc.createElement('div');
            row.className = 'ag-ph-kv-row';
            const kEl = doc.createElement('span');
            kEl.className = 'ag-ph-kv-key';
            kEl.textContent = `${lg.modelLabel || lg.model || '--'} · ${lg.date || ''}`;
            const vEl = doc.createElement('span');
            vEl.className = 'ag-ph-kv-val';
            vEl.textContent = `${formatCompactCount(lg.totalTokens ?? lg.total ?? 0)} tok · ${formatUsdShort(lg.costUSD || 0)}`;
            row.appendChild(kEl);
            row.appendChild(vEl);
            list.appendChild(row);
          }
          rCard.appendChild(list);
        }
        shell.appendChild(rCard);
      } else {
        // ============================================================
        // 主子页：Token 统计（完整迁移 4–12 项）
        // ============================================================

        // 迁移项 (5)：四周期 KPI（累计处理 / 今日使用 / 本月使用 / 年度使用，同口径精确美元估价与日均）
        const periodGrid = doc.createElement('div');
        periodGrid.className = 'ag-ph-period-grid';
        periodGrid.setAttribute('data-om-ph-period-kpis', 'true');
        const periodSpecs = [
          ['all', copy.profilePeriodAll, periodAll],
          ['today', copy.profilePeriodToday, periodToday],
          ['month', copy.profilePeriodMonth, periodMonth],
          ['year', copy.profilePeriodYear, periodYear]
        ];
        for (const [pk, pLbl, pObj] of periodSpecs) {
          const pc = doc.createElement('div');
          pc.className = 'ag-ph-period-card';
          pc.setAttribute('data-om-period', pk);
          const lEl = doc.createElement('span');
          lEl.className = 'ag-ph-period-lbl';
          lEl.textContent = pLbl;
          const vEl = doc.createElement('span');
          vEl.className = 'ag-ph-period-val';
          vEl.textContent = `${formatCompactCount(pObj.tokens)} tok`;
          const sEl = doc.createElement('span');
          sEl.className = 'ag-ph-period-sub';
          sEl.setAttribute('data-om-period-cost', pk);
          const avgDay = pObj.costUSD / Math.max(1, pObj.activeDays);
          sEl.textContent = `${formatUsdShort(pObj.costUSD)} · ${copy.profileDailyAvg} ${formatUsdShort(avgDay)}`;
          pc.appendChild(lEl);
          pc.appendChild(vEl);
          pc.appendChild(sEl);
          periodGrid.appendChild(pc);
        }
        shell.appendChild(periodGrid);

        // 迁移项 (4)：套餐档位对比条与详情折叠
        const planCard = doc.createElement('div');
        planCard.className = 'ag-ph-card';
        planCard.setAttribute('data-om-ph-plan-compare', 'true');
        const planHdr = doc.createElement('div');
        planHdr.className = 'ag-ph-card-hdr';
        const planTitle = doc.createElement('div');
        planTitle.className = 'ag-ph-card-title';
        planTitle.textContent = `${copy.profilePlanCompareTitle} · ${formatUsdShort(periodAll.costUSD)}`;
        const planToggle = doc.createElement('button');
        planToggle.type = 'button';
        planToggle.className = 'ag-ph-btn';
        planToggle.setAttribute('data-om-plan-toggle', 'true');
        planToggle.textContent = profilePlanExpanded ? copy.profilePlanCompareCollapse : copy.profilePlanCompareToggle;
        planToggle.addEventListener('click', () => { profilePlanExpanded = !profilePlanExpanded; renderProfileHome(); });
        planHdr.appendChild(planTitle);
        planHdr.appendChild(planToggle);
        planCard.appendChild(planHdr);
        const planBar = doc.createElement('div');
        planBar.className = 'ag-ph-stack-bar';
        const planFill = doc.createElement('span');
        const proRatio = Math.min(100, Math.round((periodAll.costUSD / 200) * 100));
        planFill.style.cssText = `display:block;height:100%;width:${Math.max(4, proRatio)}%;background:var(--ag-host-accent, var(--primary, #3274f6));`;
        planBar.appendChild(planFill);
        planCard.appendChild(planBar);
        if (profilePlanExpanded) {
          const tiersList = doc.createElement('div');
          tiersList.className = 'ag-ph-kv-list';
          for (const [tName, tPrice] of [['Pro $20', 20], ['Max $100', 100], ['Ultra $250', 250]]) {
            const row = doc.createElement('div');
            row.className = 'ag-ph-kv-row';
            const kEl = doc.createElement('span');
            kEl.className = 'ag-ph-kv-key';
            kEl.textContent = tName;
            const vEl = doc.createElement('span');
            vEl.className = 'ag-ph-kv-val';
            vEl.textContent = `${(periodAll.costUSD / tPrice).toFixed(1)}x`;
            row.appendChild(kEl);
            row.appendChild(vEl);
            tiersList.appendChild(row);
          }
          planCard.appendChild(tiersList);
        }
        shell.appendChild(planCard);

        // 迁移项 (8)+(9)：Token 活动热力图（严格左起 + 5 档视图 + 全格点击锁定当日明细 + 5 档色阶自定义）
        const heatCard = doc.createElement('div');
        heatCard.className = 'ag-ph-card';
        heatCard.setAttribute('data-ag-ph-heatmap', 'true');
        heatCard.setAttribute('data-heatmap-direction', 'ltr');
        heatCard.setAttribute('data-heatmap-mode', profileHeatmapMode);

        const renderHeatmapFn = (typeof renderProfileHeatmapInto === 'function' ? renderProfileHeatmapInto : null)
          || (typeof win?.renderProfileHeatmapInto === 'function' ? win.renderProfileHeatmapInto : null);
        if (renderHeatmapFn) {
          const hmMount = doc.createElement('div');
          hmMount.id = 'ag-ph-hm-mount';
          heatCard.appendChild(hmMount);
          try {
            profileHeatmapCtrl = renderHeatmapFn(hmMount, {
              dailyMap: ledger.allDailyMap,
              dailyInsights: ledger.allDailyMap,
              dailyModelMap: ledger.dailyModelMap,
              modelMetaByKey: ledger.modelMetaByKey,
              firstUseDate: ledger.firstUseDate,
              todayStr: ledger.todayStr
            }, {
              lang,
              range: profileHeatmapRange,
              firstUseDate: ledger.firstUseDate,
              todayStr: ledger.todayStr,
              showPaletteEditor: true,
              onRangeChange: (nextRange) => { profileHeatmapRange = nextRange; }
            });
          } catch { }
        } else {
          // 离线纯单测兜底（未加载 heatmap.js 时保留旧三档交互兼容）
          const heatHdr = doc.createElement('div');
          heatHdr.className = 'ag-ph-card-hdr';
          const heatTitle = doc.createElement('div');
          heatTitle.className = 'ag-ph-card-title';
          heatTitle.textContent = copy.profileHeatmapTitle;
          const modeSeg = doc.createElement('div');
          modeSeg.className = 'ag-ph-seg';
          for (const mk of PROFILE_HEATMAP_MODES) {
            const mb = doc.createElement('button');
            mb.type = 'button';
            mb.className = 'ag-ph-seg-btn';
            mb.setAttribute('data-heat-mode', mk);
            mb.setAttribute('aria-pressed', profileHeatmapMode === mk ? 'true' : 'false');
            mb.textContent = copy.profileHeatmapModes[mk];
            mb.addEventListener('click', () => { profileHeatmapMode = mk; renderProfileHome(); });
            modeSeg.appendChild(mb);
          }
          heatHdr.appendChild(heatTitle);
          heatHdr.appendChild(modeSeg);
          heatCard.appendChild(heatHdr);
          if (profileHeatmapMode === 'daily') {
            const scroll = doc.createElement('div');
            scroll.className = 'ag-ph-heat-scroll';
            const cols = doc.createElement('div');
            cols.className = 'ag-ph-heat-cols';
            for (const col of heatModel.columns) {
              const wCol = doc.createElement('div');
              wCol.className = 'ag-ph-heat-week';
              wCol.setAttribute('data-week-index', String(col.weekIndex));
              wCol.setAttribute('data-week-start', col.startDate);
              for (const day of col.days) {
                const dot = doc.createElement('span');
                dot.className = 'ag-ph-heat-dot';
                dot.setAttribute('data-date', day.date);
                dot.setAttribute('data-level', String(day.level));
                if (day.isFuture) dot.setAttribute('data-future', 'true');
                dot.title = `${day.date} · ${formatCompactCount(day.value)} Tokens`;
                wCol.appendChild(dot);
              }
              cols.appendChild(wCol);
            }
            scroll.appendChild(cols);
            heatCard.appendChild(scroll);
          } else if (profileHeatmapMode === 'weekly') {
            const bars = doc.createElement('div');
            bars.className = 'ag-ph-bar-strip';
            bars.setAttribute('data-weekly-bars', 'true');
            for (const wb of heatModel.weeklyBars) {
              const b = doc.createElement('span');
              b.className = 'ag-ph-bar-item';
              b.setAttribute('data-week-start', wb.startDate);
              b.style.height = `${wb.total > 0 ? Math.max(8, Math.round(wb.ratio * 76)) : 3}px`;
              bars.appendChild(b);
            }
            heatCard.appendChild(bars);
          } else {
            const bars = doc.createElement('div');
            bars.className = 'ag-ph-bar-strip';
            bars.setAttribute('data-cumulative-bars', 'true');
            for (const pt of heatModel.cumulativePoints) {
              const b = doc.createElement('span');
              b.className = 'ag-ph-bar-item';
              b.setAttribute('data-date', pt.date);
              b.style.height = `${Math.max(5, Math.round(pt.ratio * 76))}px`;
              bars.appendChild(b);
            }
            heatCard.appendChild(bars);
          }
        }
        shell.appendChild(heatCard);

        // 迁移项 (6)+(7)：全量缓存统计 + 按模型缓存表现与预估节省
        const cacheCard = doc.createElement('div');
        cacheCard.className = 'ag-ph-card';
        cacheCard.setAttribute('data-ag-ph-cache', 'true');
        const cacheTitle = doc.createElement('div');
        cacheTitle.className = 'ag-ph-card-title';
        cacheTitle.textContent = copy.profileCacheTitle;
        cacheCard.appendChild(cacheTitle);

        const totalInputInclCache = Number(cache.totalUncachedInput || 0) + Number(cache.totalCacheRead || 0);
        const cacheGrid = doc.createElement('div');
        cacheGrid.className = 'ag-ph-cache-grid';
        const cacheItems = [
          ['globalHit', cache.globalHitPct !== null && cache.globalHitPct !== undefined ? `${cache.globalHitPct}%` : '--', copy.profileCacheGlobalHit],
          ['sessionHit', cache.sessionHitPct !== null && cache.sessionHitPct !== undefined ? `${cache.sessionHitPct}%` : '--', copy.profileCacheSessionHit],
          ['cacheRead', formatCompactCount(cache.totalCacheRead), copy.profileCacheReadTokens],
          ['uncachedInput', formatCompactCount(cache.totalUncachedInput), copy.profileCacheWriteInput],
          ['totalInputWithCache', formatCompactCount(totalInputInclCache), copy.profileCacheTotalInput],
          ['outputTokens', formatCompactCount(ledger.summary.outputTokens || 0), copy.profileCacheOutput],
          ['savedUsd', cache.savedUsdLabel, copy.profileCacheSavedEst]
        ];
        for (const [ck, val, lbl] of cacheItems) {
          const mBox = doc.createElement('div');
          mBox.className = 'ag-ph-cache-metric';
          mBox.setAttribute('data-cache-key', ck);
          const v = doc.createElement('span');
          v.className = 'ag-ph-cache-val';
          v.textContent = val;
          const l = doc.createElement('span');
          l.className = 'ag-ph-cache-lbl';
          l.textContent = lbl;
          mBox.appendChild(v);
          mBox.appendChild(l);
          cacheGrid.appendChild(mBox);
        }
        cacheCard.appendChild(cacheGrid);

        const cacheBar = doc.createElement('div');
        cacheBar.className = 'ag-ph-stack-bar';
        if (cache.cacheSharePct > 0) {
          const cSeg = doc.createElement('span');
          cSeg.style.cssText = `display:block;width:${cache.cacheSharePct}%;height:100%;background:var(--ag-host-accent, var(--primary, #3274f6));`;
          cacheBar.appendChild(cSeg);
        }
        if (cache.uncachedSharePct > 0) {
          const uSeg = doc.createElement('span');
          uSeg.style.cssText = `display:block;width:${cache.uncachedSharePct}%;height:100%;background:rgba(128,128,128,0.35);`;
          cacheBar.appendChild(uSeg);
        }
        cacheCard.appendChild(cacheBar);
        const cacheNote = doc.createElement('div');
        cacheNote.className = 'ag-ph-kv-key';
        cacheNote.textContent = copy.profileCacheNote;
        cacheCard.appendChild(cacheNote);

        if (cache.byModel.length > 0) {
          const modelList = doc.createElement('div');
          modelList.className = 'ag-ph-kv-list';
          modelList.setAttribute('data-om-ph-model-cache', 'true');
          for (const m of cache.byModel) {
            const row = doc.createElement('div');
            row.className = 'ag-ph-kv-row';
            const k = doc.createElement('span');
            k.className = 'ag-ph-kv-key';
            k.textContent = m.model;
            const v = doc.createElement('span');
            v.className = 'ag-ph-kv-val';
            v.textContent = `${m.hitPct !== null ? `${m.hitPct}%` : '--'} · ${formatCompactCount(m.cache)}`;
            row.appendChild(k);
            row.appendChild(v);
            modelList.appendChild(row);
          }
          cacheCard.appendChild(modelList);
        }
        shell.appendChild(cacheCard);

        // 迁移项 (10)+(11)：跨会话全局洞察大盘 + 近 7 天成对 Token 与估算费用双柱图
        const csiCard = doc.createElement('div');
        csiCard.className = 'ag-ph-card';
        csiCard.setAttribute('data-om-ph-csi-overview', 'true');
        const csiTitle = doc.createElement('div');
        csiTitle.className = 'ag-ph-card-title';
        csiTitle.textContent = copy.profileCsiTitle;
        csiCard.appendChild(csiTitle);

        const csiMeta = doc.createElement('div');
        csiMeta.className = 'ag-ph-kv-list';
        for (const [kTxt, vTxt] of [
          [copy.kpiSessions, String(ledger.summary.sessionCount || 0)],
          [copy.rankProjectsTitle, ledger.topProjects.slice(0, 3).map((p) => p.name).join(' · ') || copy.rankEmpty],
          [copy.rankToolsTitle, ledger.topTools.slice(0, 3).map((tItem) => `${tItem.name} ${tItem.count}`).join(' · ') || copy.rankEmpty]
        ]) {
          const row = doc.createElement('div');
          row.className = 'ag-ph-kv-row';
          const kEl = doc.createElement('span');
          kEl.className = 'ag-ph-kv-key';
          kEl.textContent = kTxt;
          const vEl = doc.createElement('span');
          vEl.className = 'ag-ph-kv-val';
          vEl.textContent = vTxt;
          row.appendChild(kEl);
          row.appendChild(vEl);
          csiMeta.appendChild(row);
        }
        csiCard.appendChild(csiMeta);

        const bar7Title = doc.createElement('div');
        bar7Title.className = 'ag-ph-card-title';
        bar7Title.style.marginTop = '6px';
        bar7Title.textContent = copy.profile7dTitle;
        csiCard.appendChild(bar7Title);
        const bars7 = doc.createElement('div');
        bars7.className = 'ag-ph-7d-bars';
        bars7.setAttribute('data-om-ph-7d-bars', 'true');
        const max7T = Math.max(1, ...ledger.dailySeries7d.map((d) => d.tokens));
        const max7C = Math.max(0.01, ...ledger.dailySeries7d.map((d) => d.costUSD));
        for (const item of ledger.dailySeries7d) {
          const col = doc.createElement('div');
          col.className = 'ag-ph-7d-col';
          col.setAttribute('data-date', item.date);
          col.title = `${item.date} · ${formatCompactCount(item.tokens)} tok · ${formatUsdShort(item.costUSD)}`;
          const pair = doc.createElement('div');
          pair.className = 'ag-ph-7d-pair';
          const bT = doc.createElement('span');
          bT.className = 'ag-ph-7d-tok';
          bT.style.height = `${item.tokens > 0 ? Math.max(8, Math.round((item.tokens / max7T) * 76)) : 3}px`;
          const bC = doc.createElement('span');
          bC.className = 'ag-ph-7d-cost';
          bC.style.height = `${item.costUSD > 0 ? Math.max(6, Math.round((item.costUSD / max7C) * 76)) : 3}px`;
          pair.appendChild(bT);
          pair.appendChild(bC);
          const lbl = doc.createElement('span');
          lbl.className = 'ag-ph-kv-key';
          lbl.style.fontSize = '10px';
          lbl.textContent = item.date.slice(5);
          col.appendChild(pair);
          col.appendChild(lbl);
          bars7.appendChild(col);
        }
        csiCard.appendChild(bars7);
        shell.appendChild(csiCard);

        // 迁移项 (12)：最底部极简「洞察」键值列表
        const insightsCard = doc.createElement('div');
        insightsCard.className = 'ag-ph-card';
        insightsCard.setAttribute('data-ag-ph-insights', 'true');
        const insTitle = doc.createElement('div');
        insTitle.className = 'ag-ph-card-title';
        insTitle.textContent = copy.profileInsightsTitle;
        insightsCard.appendChild(insTitle);

        const kvList = doc.createElement('div');
        kvList.className = 'ag-ph-kv-list';
        const kvRows = [
          [
            copy.profileInsightTopModel,
            metrics.topModel ? `${metrics.topModel.name} · ${metrics.topModel.sharePct}%` : copy.profileUnrecorded
          ],
          [
            copy.profileInsightEffort,
            metrics.effortMix || copy.profileUnrecorded
          ],
          [
            copy.profileInsightCachePerf,
            cache.globalHitPct !== null && cache.globalHitPct !== undefined
              ? `${cache.globalHitPct}% · ${formatCompactCount(cache.totalCacheRead)}`
              : copy.profileUnrecorded
          ],
          [copy.profileInsightSkillsExplored, String(metrics.exploredSkillsCount)],
          [copy.profileInsightSkillsTotal, String(metrics.totalSkillUses)],
          [copy.profileInsightToolsTotal, String(metrics.totalToolCalls)],
          [
            copy.profileInsightSourceSplit,
            metrics.desktopSharePct !== null
              ? `${copy.sourceDesktop} ${metrics.desktopSharePct}% · ${copy.sourceCli} ${metrics.cliSharePct}%`
              : copy.profileUnrecorded
          ],
          [
            copy.profileInsightActiveDays,
            `${metrics.activeDaysCount} ${copy.profileStreakUnit} · ${metrics.sessionCount}`
          ]
        ];
        for (const [k, v] of kvRows) {
          const row = doc.createElement('div');
          row.className = 'ag-ph-kv-row';
          const kEl = doc.createElement('span');
          kEl.className = 'ag-ph-kv-key';
          kEl.textContent = k;
          const vEl = doc.createElement('span');
          vEl.className = 'ag-ph-kv-val';
          vEl.textContent = v;
          row.appendChild(kEl);
          row.appendChild(vEl);
          kvList.appendChild(row);
        }
        insightsCard.appendChild(kvList);
        shell.appendChild(insightsCard);
      }

      profileEl.appendChild(shell);
    }

    function syncFullpageActiveAttr() {
      const active = Boolean(pageCtrl.getState().active || profileActive);
      try {
        doc?.documentElement?.setAttribute?.('data-om-fullpage-active', active ? 'true' : 'false');
      } catch { }
      return active;
    }

    function presentFullPage() {
      ensureSidebarInsightsHostStyle(doc);
      const pg = ensureFullPageContainer();
      if (!pg) return;
      savedFocusEl = doc?.activeElement || null;
      muteOtherSidebarItems();
      if (sidebarBtnEl) {
        sidebarBtnEl.setAttribute('data-active', 'true');
        sidebarBtnEl.setAttribute('aria-current', 'page');
      }
      renderFullPage();
      pg.hidden = false;
      syncFullpageActiveAttr();
      deps.onRouteChange?.({ route: 'detailed-context', active: true });
      triggerLedgerRefresh(() => {
        if (!disposed && pageCtrl.getState().active) renderFullPage();
      });
    }

    function hideFullPage(opts = {}) {
      if (pageEl) {
        pageEl.hidden = true;
      }
      releaseMainHostPositionIfIdle();
      if (sidebarBtnEl) {
        sidebarBtnEl.setAttribute('data-active', 'false');
        sidebarBtnEl.setAttribute('aria-current', 'false');
      }
      if (!profileActive) {
        restoreMutedSidebarItems(!opts.viaNativeNav);
        if (!opts.viaNativeNav && savedFocusEl && typeof savedFocusEl.focus === 'function' && savedFocusEl.isConnected !== false) {
          try { savedFocusEl.focus(); } catch { }
        }
        savedFocusEl = null;
      }
      syncFullpageActiveAttr();
      deps.onRouteChange?.({ route: profileActive ? 'profile-home' : 'conversation', active: profileActive });
    }

    function openProfileHome(detail = null) {
      if (disposed || !doc || !profileEnabled) return { active: false, disabled: !profileEnabled };
      const reqSubtab = String(detail?.subtab || '').trim();
      if (reqSubtab === 'tokens' || reqSubtab === 'models' || reqSubtab === 'cost' || reqSubtab === 'requests') {
        profileSubtab = reqSubtab;
      }
      if (pageCtrl.getState().active) {
        pageCtrl.closePage({ viaNativeNav: true });
      }
      ensureSidebarInsightsHostStyle(doc);
      const pg = ensureProfilePageContainer();
      if (!pg) return { active: false };
      if (!profileActive) savedFocusEl = doc?.activeElement || null;
      profileActive = true;
      muteOtherSidebarItems();
      if (sidebarBtnEl) {
        sidebarBtnEl.setAttribute('data-active', 'false');
        sidebarBtnEl.setAttribute('aria-current', 'false');
      }
      renderProfileHome();
      pg.hidden = false;
      syncFullpageActiveAttr();
      triggerLedgerRefresh(() => {
        if (!disposed && profileActive && profileEnabled) renderProfileHome();
      });
      deps.onRouteChange?.({ route: 'profile-home', active: true, detail });
      return { active: true, subtab: profileSubtab, heatmapRange: profileHeatmapRange };
    }

    function closeProfileHome(opts = {}) {
      if (profileHeatmapCtrl) {
        try { profileHeatmapCtrl.destroy?.(); } catch { }
        profileHeatmapCtrl = null;
      }
      if (!profileActive) {
        syncFullpageActiveAttr();
        return { active: false };
      }
      profileActive = false;
      if (profileEl) profileEl.hidden = true;
      releaseMainHostPositionIfIdle();
      if (!opts.viaSwitch) {
        restoreMutedSidebarItems(!opts.viaNativeNav);
        if (!opts.viaNativeNav && savedFocusEl && typeof savedFocusEl.focus === 'function' && savedFocusEl.isConnected !== false) {
          try { savedFocusEl.focus(); } catch { }
        }
        savedFocusEl = null;
      }
      syncFullpageActiveAttr();
      deps.onRouteChange?.({ route: 'conversation', active: false, viaNativeNav: Boolean(opts.viaNativeNav) });
      return { active: false };
    }

    function setProfileHomeEnabled(enabled) {
      const next = Boolean(enabled);
      if (profileEnabled === next && (next || (!profileActive && !profileEl))) {
        return profileEnabled;
      }
      profileEnabled = next;
      if (!profileEnabled) {
        if (profileActive) closeProfileHome({ viaNativeNav: true });
        if (profileHeatmapCtrl) {
          try { profileHeatmapCtrl.destroy?.(); } catch { }
          profileHeatmapCtrl = null;
        }
        if (profileEl) {
          try { profileEl.remove?.(); } catch { }
          profileEl = null;
        }
      }
      if (pageCtrl.getState().active) {
        renderFullPage();
      }
      return profileEnabled;
    }

    function getProfileHomeEnabled() {
      return profileEnabled;
    }

    function openContextDetails(ctx = null) {
      if (disposed) return { active: false };
      return pageCtrl.openPage(ctx || (typeof deps.getConversationSnapshot === 'function' ? deps.getConversationSnapshot() : null));
    }

    function closeContextDetails(opts = {}) {
      return pageCtrl.closePage(opts);
    }

    const onOpenProfileHomeEvent = (ev) => {
      if (disposed) return;
      openProfileHome(ev?.detail || null);
    };

    const onOpenContextDetailsEvent = (ev) => {
      if (disposed) return;
      openContextDetails(ev?.detail || null);
    };

    function registerGlobalViewsBridge() {
      if (!win) return;
      win.__agContextMeterViews = {
        openProfileHome,
        closeProfileHome,
        setProfileHomeEnabled,
        getProfileHomeEnabled,
        openContextDetails,
        closeContextDetails
      };
    }

    function isSidebarAccountOverlayEvent(ev, target) {
      const checkNode = (n) => {
        if (!n) return false;
        const id = String(n.id || '');
        if (id === 'ag-sidebar-account-host' || id === 'ag-sidebar-account-popover-host' || id === 'host-account-pill') return true;
        if (n.getAttribute?.('data-ag-sidebar-account') === 'true' || n.getAttribute?.('data-ag-sidebar-account-popover') === 'true') return true;
        if (n.getAttribute?.('data-testid') === 'sidebar-account-button') return true;
        return Boolean(typeof n.closest === 'function' && n.closest('#ag-sidebar-account-host, #ag-sidebar-account-popover-host, #host-account-pill, [data-testid="sidebar-account-button"], [data-ag-sidebar-account="true"], [data-ag-sidebar-account-popover="true"]'));
      };
      if (checkNode(target)) return true;
      const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : [];
      for (const node of path) {
        if (checkNode(node)) return true;
      }
      return false;
    }

    const onSidebarNativeClick = (ev) => {
      if (disposed || (!pageCtrl.getState().active && !profileActive)) return;
      const target = ev?.target;
      if (isSidebarAccountOverlayEvent(ev, target)) return;
      const hitInteractive = typeof target?.closest === 'function'
        ? target.closest('button, a, [role="button"], [role="listitem"], [data-testid]')
        : target;
      if (!hitInteractive) return;
      if (hitInteractive === boundSidebarContainer) return;
      if (isSidebarAccountOverlayEvent(ev, hitInteractive)) return;
      if (hitInteractive === sidebarBtnEl || sidebarBtnEl?.contains?.(hitInteractive)) return;
      if (pageEl?.contains?.(hitInteractive) || profileEl?.contains?.(hitInteractive)) return;
      if (pageCtrl.getState().active) pageCtrl.closePage({ viaNativeNav: true });
      if (profileActive) closeProfileHome({ viaNativeNav: true });
    };

    const onDocGlobalClick = (ev) => {
      if (disposed || (!pageCtrl.getState().active && !profileActive)) return;
      const target = ev?.target;
      if (isSidebarAccountOverlayEvent(ev, target)) return;
      const hitBtn = typeof target?.closest === 'function'
        ? target.closest('button, a, [role="button"]')
        : target;
      if (!hitBtn || hitBtn === boundSidebarContainer || hitBtn === sidebarBtnEl || sidebarBtnEl?.contains?.(hitBtn) || pageEl?.contains?.(hitBtn) || profileEl?.contains?.(hitBtn)) return;
      if (isSidebarAccountOverlayEvent(ev, hitBtn)) return;
      const tid = String(hitBtn.getAttribute?.('data-testid') || '').toLowerCase();
      const lbl = String(hitBtn.textContent || hitBtn.getAttribute?.('aria-label') || '').trim();
      if (
        tid.includes('settings')
        || tid === 'new-conversation-button'
        || tid === 'automations-button'
        || tid === 'plugins-button'
        || /^(settings|设置|設定|new conversation|new chat|新建会话|automations?|自动化|customizations|自定义扩展)$/i.test(lbl)
      ) {
        if (pageCtrl.getState().active) pageCtrl.closePage({ viaNativeNav: true });
        if (profileActive) closeProfileHome({ viaNativeNav: true });
      }
    };

    const onKeyDown = (ev) => {
      if (disposed) return;
      if (ev?.key === 'Escape') {
        if (pageCtrl.getState().active) pageCtrl.closePage({ viaNativeNav: false });
        else if (profileActive) closeProfileHome({ viaNativeNav: false });
      }
    };

    let globalListenersBound = false;
    function bindGlobalListeners() {
      if (globalListenersBound) return;
      globalListenersBound = true;
      doc?.addEventListener?.('click', onDocGlobalClick, true);
      doc?.addEventListener?.('keydown', onKeyDown);
      win?.addEventListener?.('ag-open-profile-home', onOpenProfileHomeEvent);
      win?.addEventListener?.('ag-open-context-details', onOpenContextDetailsEvent);
      registerGlobalViewsBridge();
    }

    bindGlobalListeners();

    function syncMount(nextLang) {
      if (disposed || !doc) return false;
      if (nextLang) {
        lang = resolveLang(nextLang);
        pageCtrl.setFilters({ lang });
      }
      registerGlobalViewsBridge();
      const anchor = findSidebarInsightsAnchor(doc);
      if (!anchor || !anchor.parent) return false;
      lastAnchor = anchor;
      ensureSidebarInsightsHostStyle(doc);
      bindGlobalListeners();

      if (anchor.sidebarContainer && anchor.sidebarContainer !== boundSidebarContainer) {
        if (boundSidebarContainer) {
          boundSidebarContainer.removeEventListener?.('click', onSidebarNativeClick, true);
        }
        boundSidebarContainer = anchor.sidebarContainer;
        boundSidebarContainer.addEventListener?.('click', onSidebarNativeClick, true);
      }

      const copy = getInsightsCopy(lang);
      const refBtn = anchor.referenceBtn || null;
      const baseCls = sanitizeSidebarBtnClass(refBtn);

      if (!sidebarBtnEl || sidebarBtnEl.isConnected === false) {
        const existing = doc.getElementById?.(SIDEBAR_INSIGHTS_BTN_ID);
        if (existing) {
          try { existing.remove?.(); } catch { }
        }
        const btn = doc.createElement('button');
        btn.id = SIDEBAR_INSIGHTS_BTN_ID;
        btn.type = 'button';
        btn.className = baseCls ? `${baseCls} ag-sidebar-insights-nav-btn` : 'ag-sidebar-insights-nav-btn';
        btn.setAttribute('data-ag-sidebar-insights', 'true');
        btn.setAttribute('data-active', pageCtrl.getState().active ? 'true' : 'false');
        btn.setAttribute('aria-current', pageCtrl.getState().active ? 'page' : 'false');

        const iconWrap = doc.createElement('span');
        iconWrap.className = 'flex shrink-0 ag-sidebar-insights-icon-wrap';
        iconWrap.setAttribute('aria-hidden', 'true');
        iconWrap.appendChild(createSidebarInsightsIconSvg(doc, 16));

        const labelSpan = doc.createElement('span');
        labelSpan.className = 'truncate ag-sidebar-insights-label';
        labelSpan.textContent = copy.sidebarNavLabel;

        btn.appendChild(iconWrap);
        btn.appendChild(labelSpan);

        btn.addEventListener('click', (ev) => {
          if (disposed) return;
          ev?.stopPropagation?.();
          ev?.preventDefault?.();
          const cur = pageCtrl.getState();
          if (cur.active) pageCtrl.closePage({ viaNativeNav: false });
          else openContextDetails();
        });
        sidebarBtnEl = btn;
      } else {
        const lbl = sidebarBtnEl.querySelector?.('.ag-sidebar-insights-label');
        if (lbl) lbl.textContent = copy.sidebarNavLabel;
      }

      let mountNode = sidebarBtnEl;
      if (anchor.useRowWrapper) {
        if (!sidebarRowEl || sidebarRowEl === sidebarBtnEl) {
          sidebarRowEl = doc.createElement('div');
          sidebarRowEl.setAttribute('data-ag-sidebar-insights-row', 'true');
        }
        const rowCls = String(anchor.referenceRow?.className || '').trim();
        if (rowCls && sidebarRowEl.className !== rowCls) sidebarRowEl.className = rowCls;
        if (sidebarBtnEl.parentElement !== sidebarRowEl) {
          sidebarRowEl.appendChild(sidebarBtnEl);
        }
        mountNode = sidebarRowEl;
      } else {
        sidebarRowEl = sidebarBtnEl;
      }

      if (mountNode.parentElement !== anchor.parent) {
        if (typeof anchor.parent.insertBefore === 'function') {
          anchor.parent.insertBefore(mountNode, anchor.insertBefore || null);
        } else {
          anchor.parent.appendChild?.(mountNode);
        }
      }

      if (refBtn) {
        syncSidebarInsightsButtonStyle(sidebarBtnEl, refBtn, win, anchor.activeReferenceBtn || null);
      }

      if (pageCtrl.getState().active) renderFullPage();
      if (profileActive) renderProfileHome();
      return true;
    }

    function notifyHostRouteChanged() {
      if (pageCtrl.getState().active) {
        pageCtrl.closePage({ viaNativeNav: true });
      }
      if (profileActive) {
        closeProfileHome({ viaNativeNav: true });
      }
    }

    function destroy() {
      disposed = true;
      try { pageCtrl.closePage({ viaNativeNav: true }); } catch { }
      try { closeProfileHome({ viaNativeNav: true }); } catch { }
      if (boundSidebarContainer) {
        boundSidebarContainer.removeEventListener?.('click', onSidebarNativeClick, true);
        boundSidebarContainer = null;
      }
      if (globalListenersBound) {
        doc?.removeEventListener?.('click', onDocGlobalClick, true);
        doc?.removeEventListener?.('keydown', onKeyDown);
        win?.removeEventListener?.('ag-open-profile-home', onOpenProfileHomeEvent);
        win?.removeEventListener?.('ag-open-context-details', onOpenContextDetailsEvent);
        globalListenersBound = false;
      }
      try { (sidebarRowEl || sidebarBtnEl)?.remove?.(); } catch { }
      try { sidebarBtnEl?.remove?.(); } catch { }
      try { pageEl?.remove?.(); } catch { }
      try { profileEl?.remove?.(); } catch { }
      sidebarBtnEl = null;
      sidebarRowEl = null;
      pageEl = null;
      profileEl = null;
      mainHostEl = null;
    }

    return {
      syncMount,
      openPage: openContextDetails,
      closePage: closeContextDetails,
      openContextDetails,
      closeContextDetails,
      openProfileHome,
      closeProfileHome,
      setProfileHomeEnabled,
      getProfileHomeEnabled,
      setFilters: (patch) => pageCtrl.setFilters(patch),
      filterSessions: (list) => pageCtrl.filterSessions(list),
      notifyHostRouteChanged,
      getState: () => ({
        ...pageCtrl.getState(),
        sourceFilter,
        profileEnabled,
        profileActive,
        profileSubtab,
        profileHeatmapRange,
        profileHeatmapMode,
        fullpageZIndex: FULLPAGE_Z_INDEX,
        buttonMounted: Boolean(sidebarBtnEl && sidebarBtnEl.parentElement),
        pageVisible: Boolean(pageEl && !pageEl.hidden),
        profileVisible: Boolean(profileEl && !profileEl.hidden),
        profileMounted: Boolean(profileEl && profileEl.isConnected !== false),
        anchorKind: lastAnchor?.anchorKind || null
      }),
      getButtonEl: () => sidebarBtnEl,
      getPageEl: () => pageEl,
      getProfilePageEl: () => profileEl,
      destroy
    };
  }

  /**
   * 3. 会话四视角（对话 · 轨迹 · 上下文 · 编队）独立控制器，按 paneId/sessionId 隔离并保留草稿与滚动
   */
  function createSessionFourViewsController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    let lang = resolveLang(deps.lang);
    const activeViewByPane = new Map();
    const preservedDraftByPane = new Map();

    function getView(paneId = 'pane-primary') {
      return activeViewByPane.get(String(paneId)) || 'chat';
    }

    function switchView(paneId, nextView, preservePayload = null) {
      const pid = String(paneId || 'pane-primary');
      const valid = SESSION_VIEW_KEYS.includes(nextView) ? nextView : 'chat';
      const prev = getView(pid);
      if (prev === 'chat' && valid !== 'chat' && preservePayload) {
        preservedDraftByPane.set(pid, { ...preservePayload });
      }
      activeViewByPane.set(pid, valid);
      const restored = valid === 'chat' ? (preservedDraftByPane.get(pid) || null) : null;
      deps.onViewChange?.({ paneId: pid, prevView: prev, view: valid, restoredChatState: restored });
      return { paneId: pid, view: valid, restoredChatState: restored };
    }

    function mountSwitcher(container, paneId = 'pane-primary') {
      if (!doc || !container) return null;
      const pid = String(paneId || 'pane-primary');
      const copy = getInsightsCopy(lang);
      const bar = doc.createElement('div');
      bar.className = 'ag-session-views-bar';
      bar.setAttribute('role', 'tablist');
      bar.setAttribute('aria-label', copy.viewSwitcherAria);
      bar.setAttribute('data-pane-id', pid);

      const syncTabs = () => {
        const cur = getView(pid);
        for (const btn of Array.from(bar.querySelectorAll('.ag-session-view-tab') || [])) {
          const k = btn.getAttribute('data-view-key');
          const sel = k === cur;
          btn.setAttribute('aria-selected', sel ? 'true' : 'false');
          btn.setAttribute('tabindex', sel ? '0' : '-1');
        }
      };

      for (const viewKey of SESSION_VIEW_KEYS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-session-view-tab';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('data-view-key', viewKey);
        btn.textContent = copy.views[viewKey];
        btn.addEventListener('click', () => {
          switchView(pid, viewKey);
          syncTabs();
        });
        bar.appendChild(btn);
      }

      bar.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        ev.preventDefault?.();
        const curIdx = SESSION_VIEW_KEYS.indexOf(getView(pid));
        const nextIdx = (curIdx + (ev.key === 'ArrowRight' ? 1 : -1) + SESSION_VIEW_KEYS.length) % SESSION_VIEW_KEYS.length;
        switchView(pid, SESSION_VIEW_KEYS[nextIdx]);
        syncTabs();
        bar.querySelector?.(`[data-view-key="${SESSION_VIEW_KEYS[nextIdx]}"]`)?.focus?.();
      });

      syncTabs();
      container.appendChild(bar);
      return { bar, syncTabs };
    }

    return {
      getView,
      switchView,
      mountSwitcher,
      setLang: (nextLang) => { lang = resolveLang(nextLang); }
    };
  }

  /**
   * 4. Orchestrator 两位小机器人编排分工可视化组件
   */
  function normalizeOrchestratorState(raw = {}, lang = 'zh-CN') {
    const copy = getInsightsCopy(lang);
    const events = Array.isArray(raw.events) ? raw.events.filter(Boolean) : [];
    const seenEventIds = new Set();
    const dedupedEvents = [];
    for (const ev of events) {
      const eid = String(ev.eventId || ev.requestId || '');
      if (eid && seenEventIds.has(eid)) continue;
      if (eid) seenEventIds.add(eid);
      dedupedEvents.push(ev);
    }

    const hasRuntimeEvidence = Boolean(
      dedupedEvents.length > 0
      || raw.plannerBusy === true
      || raw.executorBusy === true
      || (raw.confirmedActionText && raw.hasVerifiedRuntime === true)
    );

    const plannerBusy = hasRuntimeEvidence && Boolean(raw.plannerBusy);
    const executorBusy = hasRuntimeEvidence && Boolean(raw.executorBusy);
    const dualBusy = plannerBusy && executorBusy;

    let direction = 'none';
    if (hasRuntimeEvidence) {
      if (raw.handoffDirection === 'planner-to-executor' || raw.handoffDirection === 'executor-to-planner') {
        direction = raw.handoffDirection;
      } else {
        const lastHandoff = [...dedupedEvents].reverse().find(e => e.type === 'handoff');
        if (lastHandoff?.from === 'planner' && lastHandoff?.to === 'executor') direction = 'planner-to-executor';
        else if (lastHandoff?.from === 'executor' && lastHandoff?.to === 'planner') direction = 'executor-to-planner';
      }
    }

    let actionText = copy.orchNotRecorded;
    let directionText = copy.orchConfiguredOnly;
    if (hasRuntimeEvidence) {
      if (raw.confirmedActionText) actionText = String(raw.confirmedActionText);
      else if (dualBusy) actionText = copy.orchDualBusy;
      else actionText = copy.orchIdle;

      if (direction === 'planner-to-executor') directionText = copy.orchToExecutor;
      else if (direction === 'executor-to-planner') directionText = copy.orchBackToPlanner;
      else directionText = dualBusy ? copy.orchDualBusy : '';
    }

    return {
      hasRuntimeEvidence,
      statusBadge: hasRuntimeEvidence ? null : copy.orchConfiguredOnly,
      plannerModel: String(raw.plannerModel || copy.orchModelUnrecorded),
      executorModel: String(raw.executorModel || copy.orchModelUnrecorded),
      plannerBusy,
      executorBusy,
      dualBusy,
      direction,
      actionText,
      directionText,
      events: dedupedEvents,
      plannerCalls: dedupedEvents.filter(e => e.role === 'planner'),
      executorCalls: dedupedEvents.filter(e => e.role === 'executor')
    };
  }

  function createRobotSvg(doc, role) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ag-orch-bot-svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const add = (tag, attrs) => {
      const el = doc.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    };

    add('rect', { x: 11, y: 10, width: 22, height: 16, rx: 7 });
    add('circle', { cx: 18, cy: 18, r: 1.6, fill: 'currentColor' });
    add('circle', { cx: 26, cy: 18, r: 1.6, fill: 'currentColor' });
    add('line', { x1: 22, y1: 6, x2: 22, y2: 10 });
    add('rect', { x: 13, y: 27, width: 18, height: 13, rx: 5 });

    if (role === 'planner') {
      add('rect', { x: 32, y: 22, width: 10, height: 13, rx: 2 });
      add('line', { x1: 35, y1: 26, x2: 39, y2: 26 });
      add('line', { x1: 35, y1: 30, x2: 39, y2: 30 });
    } else {
      add('path', { d: 'M34 35 L41 26' });
      add('circle', { cx: 42, cy: 24.5, r: 2.3 });
    }
    return svg;
  }

  function createOrchestratorVisualController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    let lang = resolveLang(deps.lang);
    let reducedMotion = Boolean(deps.reducedMotion);
    let containerWidth = Number.isFinite(Number(deps.containerWidth)) ? Number(deps.containerWidth) : 480;
    let expandedDrawer = null;
    let lastEventCount = 0;
    let cardEl = null;
    let lastNormalized = null;
    let disposed = false;

    function ensureStyle(styleRoot) {
      if (!doc) return;
      const target = styleRoot && styleRoot.nodeType === 11 ? styleRoot : doc.head;
      if (!target) return;
      if (target.querySelector?.(`#${INSIGHTS_STYLE_ID}`) || doc.getElementById?.(INSIGHTS_STYLE_ID)) return;
      const st = doc.createElement('style');
      st.id = INSIGHTS_STYLE_ID;
      st.textContent = INSIGHTS_VIEWS_CSS;
      target.appendChild(st);
    }

    function render(rawState = {}) {
      if (disposed || !cardEl || !doc) return null;
      if (rawState.lang) lang = resolveLang(rawState.lang);
      if (typeof rawState.reducedMotion === 'boolean') reducedMotion = rawState.reducedMotion;
      if (Number.isFinite(Number(rawState.containerWidth))) containerWidth = Number(rawState.containerWidth);

      const copy = getInsightsCopy(lang);
      const norm = normalizeOrchestratorState(rawState, lang);
      const isNewHandoff = norm.hasRuntimeEvidence && norm.events.length > lastEventCount && norm.direction !== 'none';
      lastEventCount = norm.events.length;
      lastNormalized = norm;

      cardEl.setAttribute('data-stacked', containerWidth < 340 ? 'true' : 'false');
      cardEl.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
      cardEl.setAttribute('data-runtime-recorded', norm.hasRuntimeEvidence ? 'true' : 'false');
      cardEl.setAttribute('data-direction', norm.direction);

      while (cardEl.firstChild) cardEl.removeChild(cardEl.firstChild);

      const stage = doc.createElement('div');
      stage.className = 'ag-orch-stage';

      const buildBotBtn = (roleKey, roleTitle, modelName, busy) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-orch-bot-btn';
        btn.setAttribute('data-orch-role', roleKey);
        btn.setAttribute('data-active', busy ? 'true' : 'false');
        btn.appendChild(createRobotSvg(doc, roleKey));
        const rEl = doc.createElement('span');
        rEl.className = 'ag-orch-bot-role';
        rEl.textContent = roleTitle;
        const mEl = doc.createElement('span');
        mEl.className = 'ag-orch-bot-model';
        mEl.textContent = modelName;
        btn.appendChild(rEl);
        btn.appendChild(mEl);
        btn.addEventListener('click', () => {
          expandedDrawer = expandedDrawer === roleKey ? null : roleKey;
          deps.onSelectRole?.(roleKey, norm);
          render(rawState);
        });
        return btn;
      };

      const plannerBtn = buildBotBtn('planner', copy.orchPlanner, norm.plannerModel, norm.plannerBusy);
      const executorBtn = buildBotBtn('executor', copy.orchExecutor, norm.executorModel, norm.executorBusy);

      const bridge = doc.createElement('div');
      bridge.className = 'ag-orch-bridge';
      const handoffBtn = doc.createElement('button');
      handoffBtn.type = 'button';
      handoffBtn.className = 'ag-orch-handoff-btn';
      handoffBtn.setAttribute('data-orch-handoff', 'true');

      if (norm.hasRuntimeEvidence) {
        const track = doc.createElement('div');
        track.className = 'ag-orch-track';
        const arrowSpan = doc.createElement('span');
        arrowSpan.className = 'ag-orch-arrow';
        arrowSpan.textContent = norm.direction === 'executor-to-planner'
          ? '←'
          : (norm.direction === 'planner-to-executor' ? '→' : '↔');
        const chip = doc.createElement('span');
        chip.className = 'ag-orch-task-chip';
        if (isNewHandoff && !reducedMotion) {
          chip.classList.add(norm.direction === 'executor-to-planner' ? 'is-sliding-left' : 'is-sliding-right');
        }
        track.appendChild(arrowSpan);
        track.appendChild(chip);
        handoffBtn.appendChild(track);
      }

      const actionEl = doc.createElement('span');
      actionEl.className = 'ag-orch-action-text';
      actionEl.textContent = norm.actionText;
      handoffBtn.appendChild(actionEl);

      if (norm.directionText) {
        const dirEl = doc.createElement('span');
        dirEl.className = 'ag-orch-direction-text';
        dirEl.textContent = norm.directionText;
        handoffBtn.appendChild(dirEl);
      }

      handoffBtn.addEventListener('click', () => {
        expandedDrawer = expandedDrawer === 'timeline' ? null : 'timeline';
        render(rawState);
      });
      bridge.appendChild(handoffBtn);

      stage.appendChild(plannerBtn);
      stage.appendChild(bridge);
      stage.appendChild(executorBtn);
      cardEl.appendChild(stage);

      const drawer = doc.createElement('div');
      drawer.className = 'ag-orch-detail-drawer';
      drawer.hidden = !expandedDrawer;
      if (expandedDrawer) {
        const list = expandedDrawer === 'planner'
          ? norm.plannerCalls
          : (expandedDrawer === 'executor' ? norm.executorCalls : norm.events);
        const titleEl = doc.createElement('div');
        titleEl.className = 'ag-orch-direction-text';
        titleEl.textContent = expandedDrawer === 'timeline'
          ? copy.orchTimelineTitle
          : `${expandedDrawer === 'planner' ? copy.orchPlanner : copy.orchExecutor} · ${copy.orchRoleCalls}`;
        drawer.appendChild(titleEl);

        if (!list.length) {
          const empty = doc.createElement('div');
          empty.className = 'ag-orch-direction-text';
          empty.textContent = copy.orchNotRecorded;
          drawer.appendChild(empty);
        } else {
          for (const ev of list) {
            const row = doc.createElement('div');
            row.className = 'ag-orch-event-row';
            const summary = doc.createElement('span');
            summary.textContent = String(ev.summary || ev.action || ev.eventId || '');
            row.appendChild(summary);
            if (ev.traceEventId || ev.eventId) {
              const locBtn = doc.createElement('button');
              locBtn.type = 'button';
              locBtn.className = 'ag-orch-locate-btn';
              locBtn.textContent = copy.orchLocateTrace;
              locBtn.addEventListener('click', () => {
                deps.onLocateInTrace?.(ev.traceEventId || ev.eventId, ev);
              });
              row.appendChild(locBtn);
            }
            drawer.appendChild(row);
          }
        }
      }
      cardEl.appendChild(drawer);
      return norm;
    }

    function mount(container, styleRoot = null) {
      if (disposed || !doc || !container) return null;
      unmount();
      ensureStyle(styleRoot || (container.getRootNode ? container.getRootNode() : null));
      cardEl = doc.createElement('section');
      cardEl.className = 'ag-orch-card';
      cardEl.setAttribute('data-ag-orchestrator-card', 'true');
      container.appendChild(cardEl);
      return cardEl;
    }

    function unmount() {
      if (cardEl) try { cardEl.remove?.(); } catch { }
      cardEl = null;
      expandedDrawer = null;
    }

    function destroy() {
      disposed = true;
      unmount();
    }

    return {
      mount,
      render,
      getState: () => ({
        expandedDrawer,
        reducedMotion,
        stacked: containerWidth < 340,
        lastNormalized
      }),
      unmount,
      destroy
    };
  }

  const exported = {
    INSIGHTS_STYLE_ID,
    SIDEBAR_INSIGHTS_STYLE_ID,
    SIDEBAR_INSIGHTS_BTN_ID,
    INSIGHTS_FULLPAGE_ID,
    PROFILE_HOME_PAGE_ID,
    FULLPAGE_Z_INDEX,
    SESSION_VIEW_KEYS,
    HEATMAP_METRIC_KEYS,
    PROFILE_HEATMAP_MODES,
    INSIGHTS_I18N,
    INSIGHTS_VIEWS_CSS,
    SIDEBAR_INSIGHTS_HOST_CSS,
    getInsightsCopy,
    findSidebarInsightsAnchor,
    syncSidebarInsightsButtonStyle,
    buildLeftToRightHeatmapModel,
    resolveUnifiedLedgerSnapshot,
    computeCacheOverviewMetrics,
    computeProfileHomeMetrics,
    createContextInsightsPageController,
    createSidebarInsightsHostController,
    createSessionFourViewsController,
    normalizeOrchestratorState,
    createOrchestratorVisualController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGInsightsAndViews = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
