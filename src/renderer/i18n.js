// =========================================================================
// 模块 0: 插件面板三语言国际化 (简体中文 / 繁體中文 / English)
// =========================================================================
const VALID_PANEL_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);

/**
 * 读取用户显式保存的面板语言偏好；未曾主动设置时返回 null。
 */
function resolveExplicitPanelLanguagePref() {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const localLang = String(localStorage.getItem('ag_panel_language') || '').trim();
      if (VALID_PANEL_LANGUAGES.has(localLang)) return localLang;
    }
  } catch { }
  try {
    const hostSettings = (typeof window !== 'undefined' && window.__AGContextMeterSettings)
      || (typeof globalThis !== 'undefined' && globalThis.__AGContextMeterSettings);
    if (hostSettings && typeof hostSettings === 'object') {
      const uiLang = String(hostSettings.uiPreferences?.panelLanguage || '').trim();
      if (VALID_PANEL_LANGUAGES.has(uiLang)) return uiLang;
      if (hostSettings.panelLanguageExplicit === true) {
        const topLang = String(hostSettings.panelLanguage || '').trim();
        if (VALID_PANEL_LANGUAGES.has(topLang)) return topLang;
      }
    }
  } catch { }
  return null;
}

/**
 * 探测宿主/客户端当前运行语言信号，仅存在明确信号时返回目标面板语言。
 */
function resolveHostClientLanguageSignal() {
  try {
    const i18nCfg = (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__)
      || (typeof globalThis !== 'undefined' && globalThis.__AGY_I18N_CONFIG__);
    if (i18nCfg && typeof i18nCfg === 'object' && (typeof i18nCfg.enabled === 'boolean' || typeof i18nCfg.language === 'string')) {
      return (i18nCfg.enabled === true && String(i18nCfg.language || '').trim().toLowerCase() !== 'en')
        ? 'zh-CN'
        : 'en';
    }
  } catch { }
  try {
    const chCfg = (typeof window !== 'undefined' && window.__AGY_CHINESE_CONFIG__)
      || (typeof globalThis !== 'undefined' && globalThis.__AGY_CHINESE_CONFIG__);
    if (chCfg && typeof chCfg === 'object' && (typeof chCfg.enabled === 'boolean' || typeof chCfg.language === 'string')) {
      return (chCfg.enabled === true && String(chCfg.language || '').trim().toLowerCase() !== 'en')
        ? 'zh-CN'
        : 'en';
    }
  } catch { }
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    const docEl = doc?.documentElement;
    const rawDocLang = String(
      (typeof docEl?.getAttribute === 'function' ? docEl.getAttribute('lang') : '') || docEl?.lang || ''
    ).trim().toLowerCase();
    if (rawDocLang) {
      if (rawDocLang.startsWith('zh-tw') || rawDocLang.startsWith('zh-hant') || rawDocLang === 'tw') return 'zh-TW';
      if (rawDocLang.startsWith('zh')) return 'zh-CN';
      if (rawDocLang === 'en' || rawDocLang.startsWith('en-') || rawDocLang.startsWith('en_')) return 'en';
    }
  } catch { }
  return null;
}

function resolveInitialPanelLanguage() {
  return resolveExplicitPanelLanguagePref() || resolveHostClientLanguageSignal() || 'zh-CN';
}

let currentPanelLanguage = resolveInitialPanelLanguage();

function normalizePanelLanguage(lang) {
  if (typeof lang !== 'string') return 'zh-CN';
  const trimmed = lang.trim();
  if (VALID_PANEL_LANGUAGES.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'tw') return 'zh-TW';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return 'zh-CN';
}

function getPanelLanguage() {
  return currentPanelLanguage;
}

const PANEL_I18N = {
  // 顶部入口单元与气泡
  'badge.aria': { 'zh-CN': '会话与上下文统计', 'zh-TW': '對話與 Context 統計', en: 'Session and context statistics' },
  'badge.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
  'badge.speed.aria': { 'zh-CN': '当前会话平均生成速度与耗时统计', 'zh-TW': '目前工作階段平均生成速度與耗時統計', en: 'Session average output speed and latency' },
  'badge.tokens.aria': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量總覽', en: 'Token usage overview' },
  'badge.cli.aria': { 'zh-CN': '启动 CLI', 'zh-TW': '啟動 CLI', en: 'Launch CLI' },
  'badge.cli.title': { 'zh-CN': '一键启动 Antigravity CLI 终端并进入当前项目目录', 'zh-TW': '一鍵啟動 Antigravity CLI 終端機並進入目前專案目錄', en: 'Launch Antigravity CLI in the current workspace' },
  'badge.overflow.aria': { 'zh-CN': '更多统计指标', 'zh-TW': '更多統計指標', en: 'More metrics' },
  'tip.title.default': { 'zh-CN': '上下文窗口：', 'zh-TW': 'Context 視窗：', en: 'Context window:' },
  'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
  'tip.detail.loading': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前對話 Context 用量…', en: 'Reading current session context usage…' },
  'overflow.aria': { 'zh-CN': '切换统计面板菜单', 'zh-TW': '切換統計面板選單', en: 'Switch metrics panel menu' },
  'overflow.panelSwitcherAria': { 'zh-CN': '切换统计面板', 'zh-TW': '切換統計面板', en: 'Switch statistics panel' },
  'overflow.context': { 'zh-CN': '当前上下文', 'zh-TW': '目前 Context', en: 'Current context' },
  'overflow.contextDetail': { 'zh-CN': '上下文详情与历史', 'zh-TW': 'Context 詳情與歷史', en: 'Context & history' },
  'overflow.speed': { 'zh-CN': '输出速度对比', 'zh-TW': '輸出速度對比', en: 'Output speed' },
  'overflow.tokens': { 'zh-CN': 'Token 累计用量', 'zh-TW': 'Token 累計用量', en: 'Token usage' },
  'overflow.cacheHit': { 'zh-CN': '缓存命中率', 'zh-TW': '快取命中率', en: 'Cache hit rate' },
  'overflow.requests': { 'zh-CN': '实时请求明细', 'zh-TW': '即時請求明細', en: 'Live requests' },
  'overflow.cli': { 'zh-CN': '启动 CLI 终端', 'zh-TW': '啟動 CLI 終端機', en: 'Launch CLI' },
  'overflow.showRadialOrb': { 'zh-CN': '显示悬浮圆球', 'zh-TW': '顯示懸浮圓球', en: 'Show Floating Orb' },
  'overflow.showRadialOrbAction': { 'zh-CN': '恢复', 'zh-TW': '恢復', en: 'Show' },
  'radial.orb.aria': { 'zh-CN': '上下文悬浮圆环与快捷径向菜单', 'zh-TW': '上下文懸浮圓環與捷徑徑向選單', en: 'Floating context ring and radial quick menu' },
  'radial.orb.title': { 'zh-CN': '点击展开或收起径向菜单 · 拖动调位 · 右键隐藏', 'zh-TW': '點擊展開或收合徑向選單 · 拖曳調位 · 右鍵隱藏', en: 'Click to toggle radial menu · Drag to move · Right-click to hide' },
  'radial.orb.hiddenToast': { 'zh-CN': '已隐藏悬浮圆球，可从顶栏菜单或配置页随时恢复显示.', 'zh-TW': '已隱藏懸浮圓球，可從頂欄選單或設定頁隨時恢復顯示.', en: 'Floating orb hidden. Restore it anytime from the topbar menu or Settings.' },
  'radial.center.closeAria': { 'zh-CN': '收起径向菜单', 'zh-TW': '收合徑向選單', en: 'Close radial menu' },
  'radial.center.closeTitle': { 'zh-CN': '点击或按 Esc 收起', 'zh-TW': '點擊或按 Esc 收合', en: 'Click or press Esc to close' },
  'radial.item.context': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
  'radial.item.quota': { 'zh-CN': '模型额度', 'zh-TW': '模型額度', en: 'Quota' },
  'radial.item.tokens': { 'zh-CN': 'Token 统计', 'zh-TW': 'Token 統計', en: 'Tokens' },
  'radial.item.speed': { 'zh-CN': '速度对比', 'zh-TW': '速度對比', en: 'Speed' },
  'radial.item.requests': { 'zh-CN': '实时请求', 'zh-TW': '即時請求', en: 'Requests' },
  'radial.item.cli': { 'zh-CN': '启动 CLI', 'zh-TW': '啟動 CLI', en: 'Launch CLI' },
  'radial.item.cliRightHint': { 'zh-CN': '启动 CLI · 右键直达配置', 'zh-TW': '啟動 CLI · 右鍵直達設定', en: 'Launch CLI · Right-click for Settings' },
  'cli.launching': { 'zh-CN': '正在打开 Antigravity CLI…', 'zh-TW': '正在開啟 Antigravity CLI…', en: 'Opening Antigravity CLI…' },
  'cli.launched': { 'zh-CN': '已启动 CLI：{path}', 'zh-TW': '已啟動 CLI：{path}', en: 'CLI launched: {path}' },
  'cli.error': { 'zh-CN': '启动 CLI 失败：{err}', 'zh-TW': '啟動 CLI 失敗：{err}', en: 'Failed to launch CLI: {err}' },
  'cli.unavailable': { 'zh-CN': '当前环境不支持启动 CLI', 'zh-TW': '目前環境不支援啟動 CLI', en: 'CLI launch is unavailable in this environment' },

  // 上下文面板头部与分页
  'panel.ctx.aria': { 'zh-CN': '会话与上下文详情', 'zh-TW': '對話與 Context 詳細資訊', en: 'Session & Context Details' },
  'panel.ctx.title': { 'zh-CN': '💬 当前会话上下文', 'zh-TW': '💬 目前對話 Context', en: 'ACM' },
  'panel.ctx.fullName': { 'zh-CN': 'Antigravity Context Meter', 'zh-TW': 'Antigravity Context Meter', en: 'Antigravity Context Meter' },
  'panel.ctx.viewModel': { 'zh-CN': '查看模型', 'zh-TW': '檢視模型', en: 'Model' },
  'panel.ctx.viewModelTitle': { 'zh-CN': '按厂商查看不同模型的上下文设置', 'zh-TW': '依廠商檢視不同模型的上下文設定', en: 'Inspect context settings by vendor and model' },
  'panel.ctx.loadingModels': { 'zh-CN': '正在读取模型…', 'zh-TW': '正在讀取模型…', en: 'Loading models…' },
  'panel.ctx.backCurrent': { 'zh-CN': '回到当前模型', 'zh-TW': '回到目前模型', en: 'Back to current' },
  'panel.ctx.backCurrentTitle': { 'zh-CN': '回到当前会话正在使用的模型', 'zh-TW': '回到目前工作階段正在使用的模型', en: 'Switch back to the active session model' },
  'header.settings.aria': { 'zh-CN': '打开设置', 'zh-TW': '開啟設定', en: 'Open settings' },
  'header.settings.title': { 'zh-CN': '设置语言、代理与外观', 'zh-TW': '設定語言、代理與外觀', en: 'Language, proxy & appearance settings' },
  'header.github.aria': { 'zh-CN': '打开 GitHub 仓库', 'zh-TW': '開啟 GitHub 儲存庫', en: 'Open GitHub repository' },
  'header.update.aria': { 'zh-CN': '检查插件更新', 'zh-TW': '檢查外掛更新', en: 'Check for updates' },
  'header.palette.aria': { 'zh-CN': '外观与调色设置', 'zh-TW': '外觀與配色設定', en: 'Appearance & color settings' },
  'header.close.aria': { 'zh-CN': '收起详情', 'zh-TW': '收起詳細資訊', en: 'Close panel' },
  'tabs.aria': { 'zh-CN': '上下文面板分页', 'zh-TW': '上下文面板分頁', en: 'Context panel tabs' },
  'tab.session': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
  'tab.models': { 'zh-CN': '模型设置', 'zh-TW': '模型設定', en: 'Models' },
  'tab.speed': { 'zh-CN': '速度对比', 'zh-TW': '速度對比', en: 'Speed' },
  'tab.settings': { 'zh-CN': '配置', 'zh-TW': '配置', en: 'setting' },

  // 分页 1: 当前会话
  'session.costBar.title': { 'zh-CN': '当前模型调用的 API 等值参考金额，按已返回用量或实时生成估算', 'zh-TW': '目前模型呼叫的 API 等值參考金額，依已回傳用量或即時生成估算', en: 'Estimated API-equivalent cost for the current model (based on returned usage or live output)' },
  'session.roundCost': { 'zh-CN': '本轮估值：{val}', 'zh-TW': '本輪估值：{val}', en: 'This turn: {val}' },
  'session.sessionCost': { 'zh-CN': '当前会话合计：{val}', 'zh-TW': '目前工作階段合計：{val}', en: 'Session total: {val}' },
  'session.roundCost.dash': { 'zh-CN': '本轮估值：—', 'zh-TW': '本輪估算：—', en: 'This turn: —' },
  'session.sessionCost.dash': { 'zh-CN': '当前会话合计：—', 'zh-TW': '目前對話合計：—', en: 'Session total: —' },
  'session.keySummary.title': { 'zh-CN': '⭐ 核心用量速览', 'zh-TW': '⭐ 核心用量速覽', en: '⭐ Context Summary' },
  'session.badge.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Loading' },
  'session.stat.used': { 'zh-CN': '当前已用', 'zh-TW': '目前已用', en: 'Used' },
  'session.stat.limit': { 'zh-CN': '预算上限', 'zh-TW': '預算上限', en: 'Budget Limit' },
  'session.stat.remaining': { 'zh-CN': '剩余可用', 'zh-TW': '剩餘可用', en: 'Remaining' },
  'session.keyTakeaway.loading': { 'zh-CN': '正在计算核心指标…', 'zh-TW': '正在計算核心指標…', en: 'Calculating key metrics…' },
  'session.speedSummary.title': { 'zh-CN': '⚡ 最新生成速度与耗时', 'zh-TW': '⚡ 最新生成速度與耗時', en: '⚡ Latest Speed & Latency' },
  'session.speed.pending': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
  'session.speed.rate': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output Speed' },
  'session.speed.duration': { 'zh-CN': '生成耗时', 'zh-TW': '生成耗時', en: 'Duration' },
  'session.speed.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
  'session.speed.tokens': { 'zh-CN': '本次输出', 'zh-TW': '本次輸出', en: 'Output' },
  'session.speed.wait': { 'zh-CN': '等待首次模型输出产生速度统计…', 'zh-TW': '等待首次模型輸出產生速度統計…', en: 'Waiting for the first model response…' },
  'session.compact.title': { 'zh-CN': '上下文设置', 'zh-TW': '上下文設定', en: 'Context Settings' },
  'session.compact.savedLabel': { 'zh-CN': '本模型已保存：', 'zh-TW': '本模型已儲存：', en: 'Saved for model: ' },
  'session.compact.clientLabel': { 'zh-CN': '客户端当前使用：', 'zh-TW': '用戶端目前使用：', en: 'Client active: ' },
  'session.compact.gotoModels': { 'zh-CN': '去模型设置 ›', 'zh-TW': '前往模型設定 ›', en: 'Model settings ›' },
  'session.techDrawer.title': { 'zh-CN': '📋 底层技术参数与附件审计', 'zh-TW': '📋 底層技術參數與附件稽核', en: '📋 Technical Metrics & Attachment Audit' },
  'session.techDrawer.expand': { 'zh-CN': '▼ 点击展开明细', 'zh-TW': '▼ 點擊展開明細', en: '▼ Show details' },
  'session.techDrawer.collapse': { 'zh-CN': '▲ 点击收起明细', 'zh-TW': '▲ 點擊收起明細', en: '▲ Hide details' },
  'session.tech.checking': { 'zh-CN': '正在核对请求和附件…', 'zh-TW': '正在核對請求與附件…', en: 'Checking requests and attachments…' },
  'session.tech.latestReq': { 'zh-CN': '最近一次模型请求', 'zh-TW': '最近一次模型請求', en: 'Latest Model Request' },
  'session.tech.reqStatus': { 'zh-CN': '请求状态', 'zh-TW': '請求狀態', en: 'Request status' },
  'session.tech.actual': { 'zh-CN': '模型返回输入＋输出', 'zh-TW': '模型回傳輸入＋輸出', en: 'Returned input + output' },
  'session.tech.estimate': { 'zh-CN': '客户端估算，可能漏附件', 'zh-TW': '用戶端估算，可能漏附件', en: 'Client estimate' },
  'session.tech.budget': { 'zh-CN': '客户端预算字段', 'zh-TW': '用戶端預算欄位', en: 'Client budget field' },
  'session.tech.serviceLimit': { 'zh-CN': '该次报错的服务端限制', 'zh-TW': '該次報錯的伺服器端限制', en: 'Server limit from error' },
  'session.tech.percent': { 'zh-CN': '相对客户端预算', 'zh-TW': '相對用戶端預算', en: 'Share of client budget' },
  'session.tech.sessionHeading': { 'zh-CN': '整个会话累计内容 · 本地估算', 'zh-TW': '整段對話累計內容 · 本機估算', en: 'Cumulative Session Content · Local Estimate' },
  'session.tech.sessionTotal': { 'zh-CN': '可读取文本 token 估算', 'zh-TW': '可讀取文字 Token 估算', en: 'Readable text token est.' },
  'session.tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
  'session.tech.characters': { 'zh-CN': '实际读取文字字符数', 'zh-TW': '實際讀取文字字元數', en: 'Readable characters' },
  'session.tech.user': { 'zh-CN': '用户消息', 'zh-TW': '使用者訊息', en: 'User messages' },
  'session.tech.assistant': { 'zh-CN': '模型回复', 'zh-TW': '模型回覆', en: 'Assistant replies' },
  'session.tech.thinking': { 'zh-CN': '可见思考内容', 'zh-TW': '可見思考內容', en: 'Visible thinking' },
  'session.tech.tools': { 'zh-CN': '工具调用与工具输出', 'zh-TW': '工具呼叫與工具輸出', en: 'Tool calls & outputs' },
  'session.tech.summaries': { 'zh-CN': '历史压缩摘要', 'zh-TW': '歷史壓縮摘要', en: 'Compressed summaries' },
  'session.tech.system': { 'zh-CN': '当前系统提示与工具定义', 'zh-TW': '目前系統提示與工具定義', en: 'System prompt & tools' },
  'session.tech.injections': { 'zh-CN': '规则、恢复与系统注入', 'zh-TW': '規則、恢復與系統注入', en: 'Rules & context injections' },
  'session.tech.skills': { 'zh-CN': '技能文件指令加载', 'zh-TW': '技能檔案指令載入', en: 'Skill instructions loaded' },
  'session.tech.compositionGap': { 'zh-CN': '实报与本地估算差异', 'zh-TW': '實報與本機估算差異', en: 'Actual vs local est. delta' },
  'session.tech.gapVal': { 'zh-CN': '实报 {actual} vs 估算≈{est} ({diff})', 'zh-TW': '實報 {actual} vs 估算≈{est} ({diff})', en: 'Actual {actual} vs est. ≈{est} ({diff})' },
  'session.tech.subCount': { 'zh-CN': '{range} · {count} 次', 'zh-TW': '{range} · {count} 次', en: '{range} · {count}x' },
  'session.tech.attachments': { 'zh-CN': '上传／输出附件文本', 'zh-TW': '上傳／輸出附件文字', en: 'Attachment text' },
  'session.tech.steps': { 'zh-CN': '历史步骤完整性', 'zh-TW': '歷史步驟完整性', en: 'History completeness' },
  'session.tech.filesHeading': { 'zh-CN': '附件逐项检查', 'zh-TW': '附件逐項檢查', en: 'Attachment Inspection' },
  'session.tech.rescan': { 'zh-CN': '重新扫描整段会话与附件', 'zh-TW': '重新掃描整段對話與附件', en: 'Rescan session & attachments' },
  'session.tech.note': {
    'zh-CN': '会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。',
    'zh-TW': '工作階段累計包含可讀取的全部封存歷史；已壓縮內容仍計入累計。它不等於目前實際傳送給模型的上下文，不能用累計值除以 1M 判斷剩餘空間。附件原文與工具讀出的文字可能在歷史中分別出現，各按一次出現計入。尚未傳送的草稿與待上傳附件不在封存內，暫未計入；新上傳可能使下一次請求明顯增長。<br><br>本機 token 區間是文字啟發式估算，不是 Gemini 分詞結果，也不是嚴格上下界。影像、音視訊、加密檔案、無法存取檔案與未解析部分會明確列為未知。未知內容不按零處理；只有伺服器端回傳的用量才標為實際統計。此功能不向外部傳送檔案，不執行巨集或公式。',
    en: 'Cumulative session totals include all readable archived history (including compressed turns). They do not equal the active context sent to the model and must not be divided by 1M to judge remaining space. Attachment text and tool-read text may appear separately in history and are counted per occurrence. Unsent drafts and pending uploads are excluded.<br><br>Local token ranges are text heuristics, not exact Gemini tokenization or strict bounds. Images, audio/video, encrypted, inaccessible, or unparsed items are marked unknown (never zero). Only server-returned counts are labeled actual usage. No files are sent externally and no macros are executed.'
  },

  // 分页 2: 模型设置
  'models.list.aria': { 'zh-CN': '按厂商分组的模型产品列表', 'zh-TW': '依廠商分組的模型產品清單', en: 'Models grouped by vendor' },
  'models.list.empty': { 'zh-CN': '暂无已知模型，发一条消息或等待模型列表加载后显示。', 'zh-TW': '暫無已知模型，發送一則訊息或等待模型清單載入後顯示。', en: 'No models detected yet. Send a message or wait for the model list to load.' },
  'models.restartBtn': { 'zh-CN': '重启客户端使设置生效', 'zh-TW': '重新啟動用戶端使設定生效', en: 'Restart client to apply' },
  'models.btnRestartHost': { 'zh-CN': '重启客户端', 'zh-TW': '重新啟動用戶端', en: 'Restart Client' },
  'models.manualRestart': { 'zh-CN': '请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。', 'zh-TW': '請手動重新啟動：關閉所有 Antigravity 視窗（包含系統匣圖示中的「結束」），再重新開啟 Antigravity。', en: 'Please restart manually: close all Antigravity windows (including Quit from the tray icon) and reopen Antigravity.' },
  'models.restartConfirm.text': { 'zh-CN': '重启会中断正在运行的任务。请先保存未保存的内容。', 'zh-TW': '重新啟動會中斷正在執行的任務。請先儲存未儲存的內容。', en: 'Restarting will interrupt active tasks. Please save any unsaved work first.' },
  'models.restartConfirm.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'models.restartConfirm.go': { 'zh-CN': '重启', 'zh-TW': '重新啟動', en: 'Restart' },
  'models.restart.restarting': { 'zh-CN': '正在重启客户端…', 'zh-TW': '正在重新啟動用戶端…', en: 'Restarting client…' },
  'models.restart.notExited': { 'zh-CN': '客户端没有退出，可能被取消或正在等待。请手动重启。', 'zh-TW': '用戶端沒有結束，可能被取消或正在等待。請手動重新啟動。', en: 'The client did not exit (cancelled or busy). Please restart manually.' },
  'models.conflict.title': { 'zh-CN': '这个模型的不同档位保存过不同长度，请选一个统一值。', 'zh-TW': '此模型的不同檔位儲存過不同長度，請選一個統一值。', en: 'Different efforts of this model have different saved limits. Pick one unified value.' },
  'models.conflict.keep': { 'zh-CN': '保留此值', 'zh-TW': '保留此值', en: 'Use this' },
  'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
  'models.card.efforts': { 'zh-CN': '可用档位：{val}', 'zh-TW': '可用檔位：{val}', en: 'Efforts: {val}' },
  'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
  'models.card.sessionEffort': { 'zh-CN': '当前会话：{val}', 'zh-TW': '目前工作階段：{val}', en: 'Current session: {val}' },
  'models.card.unknownEffort': { 'zh-CN': '未知档位', 'zh-TW': '未知檔位', en: 'Unknown Effort' },
  'models.card.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
  'models.card.savedSide': { 'zh-CN': '为这个模型记下的长度', 'zh-TW': '為此模型記下的長度', en: 'Saved limit for this model' },
  'models.card.request': { 'zh-CN': '请求携带', 'zh-TW': '請求攜帶', en: 'Request Attached' },
  'models.card.requestDefault': { 'zh-CN': '恢复客户端默认', 'zh-TW': '還原用戶端預設', en: 'Client Default' },
  'models.mode.aria': { 'zh-CN': '上下文设置模式', 'zh-TW': '上下文設定模式', en: 'Context setting mode' },
  'models.mode.unifiedTitle': { 'zh-CN': '所有模型统一设置', 'zh-TW': '所有模型統一設定', en: 'Unified for All Models' },
  'models.mode.unifiedDesc': { 'zh-CN': '设置一次，所有模型使用相同的上下文长度。', 'zh-TW': '設定一次，所有模型使用相同的上下文長度。', en: 'Set once; all models use the same context length.' },
  'models.mode.perModelTitle': { 'zh-CN': '按模型分别设置', 'zh-TW': '依模型個別設定', en: 'Per-Model Separate Settings' },
  'models.mode.perModelDesc': { 'zh-CN': '每个模型分别保存，使用哪个模型，就采用它的上下文长度。', 'zh-TW': '每個模型分別儲存，使用哪個模型，就採用其上下文長度。', en: 'Each model saved separately; active model uses its own length.' },
  'models.summary.mode': { 'zh-CN': '当前模式', 'zh-TW': '目前模式', en: 'Active Mode' },
  'models.summary.model': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Active Model' },
  'models.summary.length': { 'zh-CN': '目标设置与状态', 'zh-TW': '目標設定與狀態', en: 'Target & Status' },
  'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
  'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
  'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
  'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
  'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
  'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
  'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
  'models.card.convoIdSide': { 'zh-CN': '发生调用的会话标识', 'zh-TW': '觸發呼叫的工作階段識別碼', en: 'Conversation ID of call' },
  'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
  'models.card.diagnosisSide': { 'zh-CN': '目标值与观测值比对结果', 'zh-TW': '目標值與觀測值比對結果', en: 'Target vs. observed comparison' },
  'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
  'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
  'models.summary.unconfirmed': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
  'models.summary.pendingRestart': { 'zh-CN': '待重启生效', 'zh-TW': '待重啟生效', en: 'Pending Restart' },
  'models.status.pendingRestart': { 'zh-CN': '待重启生效', 'zh-TW': '待重啟生效', en: 'Pending Restart' },
  'models.summary.modelDefault': { 'zh-CN': '使用模型默认值', 'zh-TW': '使用模型預設值', en: 'Use model default' },
  'models.summary.unifiedTarget': { 'zh-CN': '所有模型统一生效', 'zh-TW': '所有模型統一生效', en: 'All models unified' },
  'models.card.detailsToggle': { 'zh-CN': '详细信息（配置来源、请求参数与预算验证）', 'zh-TW': '詳細資訊（設定來源、請求參數與預算驗證）', en: 'Details (Source, request params & budget)' },
  'models.card.requestSide': { 'zh-CN': '本次请求发送给底座的参数', 'zh-TW': '本次請求發送給底座的參數', en: 'Limit sent in request' },
  'models.card.client': { 'zh-CN': '底座引擎', 'zh-TW': '底座引擎', en: 'Base Engine' },
  'models.card.clientSide': { 'zh-CN': '底座透传与门禁状态', 'zh-TW': '底座透傳與門禁狀態', en: 'Pass-through & gate status' },
  'models.card.observedBudget': { 'zh-CN': '实测预算', 'zh-TW': '實測預算', en: 'Observed Budget' },
  'models.card.observedBudgetNone': { 'zh-CN': '尚未观测', 'zh-TW': '尚未觀測', en: 'Not observed yet' },
  'models.card.observedBudgetSide': { 'zh-CN': '对话中实际分配', 'zh-TW': '對話中實際分配', en: 'Allocated in live turns' },
  'models.card.observedSpeed': { 'zh-CN': '实测速度', 'zh-TW': '實測速度', en: 'Observed Speed' },
  'models.card.observedSpeedNone': { 'zh-CN': '暂无实测数据', 'zh-TW': '暫無實測資料', en: 'No speed data yet' },
  'models.card.gotoSpeed': { 'zh-CN': '查看速度对比 ›', 'zh-TW': '檢視速度對比 ›', en: 'Compare speed ›' },
  'models.preset.aria': { 'zh-CN': '上下文长度预设', 'zh-TW': '上下文長度預設', en: 'Context length presets' },
  'models.preset.default': { 'zh-CN': '恢复客户端默认', 'zh-TW': '恢復用戶端預設', en: 'Restore Client Default' },
  'models.preset.defaultSub': { 'zh-CN': '清除请求覆盖，由当前底座策略决定', 'zh-TW': '清除請求覆寫，由目前底座策略決定', en: 'Clear request override; follow active host policy' },
  'models.preset.p128Sub': { 'zh-CN': '插件预设 · 128,000 tokens', 'zh-TW': '外掛預設 · 128,000 tokens', en: 'Plugin preset · 128,000 tokens' },
  'models.preset.p256Sub': { 'zh-CN': '插件预设 · 256,000 tokens', 'zh-TW': '外掛預設 · 256,000 tokens', en: 'Plugin preset · 256,000 tokens' },
  'models.preset.p512Sub': { 'zh-CN': '插件预设 · 512,000 tokens', 'zh-TW': '外掛預設 · 512,000 tokens', en: 'Plugin preset · 512,000 tokens' },
  'models.preset.modelMax': { 'zh-CN': '按模型最大可用', 'zh-TW': '依模型最大可用', en: 'Max Usable for Model' },
  'models.preset.modelMaxSub': { 'zh-CN': '总窗口 - 最大输出（需元数据）', 'zh-TW': '總視窗 - 最大輸出（需中繼資料）', en: 'Context window - max output (needs metadata)' },
  'models.preset.dynamic': { 'zh-CN': '动态跟随', 'zh-TW': '動態跟隨', en: 'Dynamic Follow' },
  'models.preset.dynamicSub': { 'zh-CN': '不固定数值，按底座动态计算', 'zh-TW': '不固定數值，依底座動態計算', en: 'No fixed cap; compute dynamically on host' },
  'models.cap.window': { 'zh-CN': '模型总窗口', 'zh-TW': '模型總視窗', en: 'Context Window' },
  'models.cap.output': { 'zh-CN': '最大输出', 'zh-TW': '最大輸出', en: 'Max Output' },
  'models.cap.modelMax': { 'zh-CN': '模型理论输入上限', 'zh-TW': '模型理論輸入上限', en: 'Model Theoretical Input Cap' },
  'models.cap.clientPolicy': { 'zh-CN': '当前客户端限制', 'zh-TW': '目前用戶端限制', en: 'Current Client Policy Limit' },
  'models.cap.defaultCap': { 'zh-CN': '当前策略默认预算', 'zh-TW': '目前策略預設預算', en: 'Current Strategy Default' },
  'models.cap.range': { 'zh-CN': '当前可采纳输入范围', 'zh-TW': '目前可採納輸入範圍', en: 'Adoptable Input Range' },
  'models.cap.formulaLbl': { 'zh-CN': '来源与计算说明', 'zh-TW': '來源與計算說明', en: 'Source & Formula' },
  'models.cap.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
  'models.cap.sent': { 'zh-CN': '最近请求携带', 'zh-TW': '最近請求攜帶', en: 'Last Request' },
  'models.cap.adopted': { 'zh-CN': '后端实际采用', 'zh-TW': '後端實際採用', en: 'Backend Adopted' },
  'models.card.tierCaps': { 'zh-CN': '档位能力', 'zh-TW': '檔位能力', en: 'Tier Capabilities' },
  'models.custom.label': { 'zh-CN': '自定义长度', 'zh-TW': '自訂長度', en: 'Custom limit' },
  'models.custom.placeholder': { 'zh-CN': '输入整数，例如 333333', 'zh-TW': '輸入整數，例如 333333', en: 'Enter integer, e.g. 333333' },
  'models.validation.defaultRange': { 'zh-CN': '可设置范围：16,384 – 2,097,152 tokens。', 'zh-TW': '可設定範圍：16,384 – 2,097,152 tokens。', en: 'Valid range: 16,384 – 2,097,152 tokens.' },
  'models.validation.empty': { 'zh-CN': '请输入 16,384 到 2,097,152 之间的整数。', 'zh-TW': '請輸入 16,384 到 2,097,152 之間的整數。', en: 'Enter an integer between 16,384 and 2,097,152.' },
  'models.validation.int': { 'zh-CN': '请输入整数（不要带小数或单位）。', 'zh-TW': '請輸入整數（不要帶小數或單位）。', en: 'Enter a whole integer without decimals or units.' },
  'models.validation.range': { 'zh-CN': '数值必须在 16,384 – 2,097,152 tokens 之间。', 'zh-TW': '數值必須在 16,384 – 2,097,152 tokens 之間。', en: 'Value must be between 16,384 and 2,097,152 tokens.' },
  'models.btn.save': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },
  'models.btn.saveApply': { 'zh-CN': '保存并应用', 'zh-TW': '儲存並套用', en: 'Save & Apply' },
  'models.btn.reset': { 'zh-CN': '恢复默认', 'zh-TW': '還原預設', en: 'Reset to Default' },
  'models.help.line1': { 'zh-CN': '保存：记住当前模型的设置。底座引擎：一次性解除 256K 限制并启用动态跟随。', 'zh-TW': '儲存：記住目前模型的設定。底座引擎：一次性解除 256K 限制並啟用動態跟隨。', en: 'Save: record limit for this model. Engine: unlock 256K limit and enable dynamic follow.' },
  'models.help.line2': { 'zh-CN': '各模型根据保存的设置独立生效，多会话与模型切换互不干扰。', 'zh-TW': '各模型依儲存的設定獨立生效，多工作階段與模型切換互不干擾。', en: 'Each model applies its saved setting independently without crosstalk across sessions or switches.' },
  'models.details.title': { 'zh-CN': '详细说明', 'zh-TW': '詳細說明', en: 'Details & Notes' },
  'models.details.li1': { 'zh-CN': '<strong>设置存在哪里</strong>：模型设置保存在插件的本地设置文件里，按模型产品记录。「应用」会把一种设置写入客户端的语言服务，重启后由新进程读取。', 'zh-TW': '<strong>設定儲存在哪裡</strong>：模型設定儲存在外掛的本機設定檔中，依模型產品記錄。「套用」會將設定寫入用戶端語言服務，重新啟動後由新行程讀取。', en: '<strong>Where settings live</strong>: Per-model preferences are stored in local plugin settings. "Apply" writes the selected limit to the client language server for the next restart.' },
  'models.details.li2': {
    'zh-CN': '<strong>几个数字的区别</strong>：<div>已保存：你为模型记下的目标。</div><div>请求携带：本次对话请求实际发送给底座的参数。</div><div>底座引擎：底座语言服务的动态跟随状态。</div><div>实测预算：对话请求中客户端实际分配的上下文预算。</div><div>服务端报错上限：只有服务端拒绝请求时才会出现。</div>',
    'zh-TW': '<strong>幾個數字的區別</strong>：<div>已儲存：你為模型記下的目標。</div><div>請求攜帶：本次對話請求實際發送給底座的參數。</div><div>底座引擎：底座語言服務的動態跟隨狀態。</div><div>實測預算：對話請求中用戶端實際分配的上下文預算。</div><div>伺服器端報錯上限：只有伺服器端拒絕請求時才會出現。</div>',
    en: '<strong>Understanding the numbers</strong>:<div>Saved: target limit for this model.</div><div>Request Attached: parameter sent in this turn.</div><div>Base Engine: follow state of the language server.</div><div>Observed budget: actual budget allocated in live turns.</div><div>Service limit: appears only when the server rejects a request.</div>'
  },
  'models.details.li3': { 'zh-CN': '<strong>影响范围</strong>：底座引擎采用动态跟随架构，每个对话请求按当前所选模型分别携带独立上下文参数，多会话与多模型并发隔离生效。', 'zh-TW': '<strong>影響範圍</strong>：底座引擎採用動態跟隨架構，每個對話請求按目前所選模型分別攜帶獨立上下文參數，多工作階段與多模型並發隔離生效。', en: '<strong>Scope</strong>: The base engine uses a dynamic follow architecture, where each request carries independent context limits per model with full multi-session isolation.' },
  'models.details.li4': {
    'zh-CN': '<strong>验证范围</strong>：<div>已验证：客户端重启后读到了新设置，并在之后的会话中观测到对应预算。</div><div>未验证：真实超长请求能否被服务端完整接受；账号风险未知。</div>',
    'zh-TW': '<strong>驗證範圍</strong>：<div>已驗證：用戶端重啟後讀到了新設定，並在之後的對話中觀測到對應預算。</div><div>未驗證：真實超長請求能否被伺服器端完整接受；帳號風險未知。</div>',
    en: '<strong>Verification scope</strong>:<div>Verified: client read the new setting after restart and live turns showed the updated budget.</div><div>Unverified: whether the server accepts full ultra-long requests; account risk is unknown.</div>'
  },
  'models.details.li5': { 'zh-CN': '<strong>精确数值</strong>：512K = 512,000 tokens；可设置范围 16,384 – 2,097,152 tokens；跟随模型不固定数值。', 'zh-TW': '<strong>精確數值</strong>：512K = 512,000 tokens；可設定範圍 16,384 – 2,097,152 tokens；跟隨模型不固定數值。', en: '<strong>Exact values</strong>: 512K = 512,000 tokens; allowed range 16,384 – 2,097,152 tokens; Follow Model has no fixed cap.' },
  'models.btn.restoreOriginal': { 'zh-CN': '客户端恢复原始设置', 'zh-TW': '用戶端恢復原始設定', en: 'Restore Client Default' },
  'models.btn.refreshStatus': { 'zh-CN': '刷新状态', 'zh-TW': '重新整理狀態', en: 'Refresh' },
  'models.status.detecting': { 'zh-CN': '正在检测当前 Antigravity 状态…', 'zh-TW': '正在偵測目前 Antigravity 狀態…', en: 'Detecting current Antigravity status…' },
  'models.meta.mode': { 'zh-CN': '当前配置 / 实测', 'zh-TW': '目前設定 / 實測', en: 'Config / Observed' },
  'models.meta.target': { 'zh-CN': '目标进程', 'zh-TW': '目標行程', en: 'Target Binary' },
  'models.meta.arch': { 'zh-CN': '系统架构', 'zh-TW': '系統架構', en: 'Architecture' },
  'models.meta.backup': { 'zh-CN': '原版备份状态', 'zh-TW': '原版備份狀態', en: 'Original Backup' },
  'models.credit.source': { 'zh-CN': '方案来源：', 'zh-TW': '方案來源：', en: 'Source:' },
  'models.credit.author': { 'zh-CN': '原作者帖子 (Linux.do @23375) ↗', 'zh-TW': '原作者文章 (Linux.do @23375) ↗', en: 'Original Post (Linux.do @23375) ↗' },
  'models.credit.authorTitle': { 'zh-CN': '点击在系统默认浏览器中打开原作者帖子', 'zh-TW': '點擊在系統預設瀏覽器中開啟原作者文章', en: 'Open original post in default browser' },
  'models.credit.copy': { 'zh-CN': '📋 复制链接', 'zh-TW': '📋 複製連結', en: '📋 Copy Link' },
  'models.credit.copyTitle': { 'zh-CN': '复制原作者帖子链接', 'zh-TW': '複製原作者文章連結', en: 'Copy original post link' },
  'models.credit.adapter': { 'zh-CN': '本项目负责 Node.js 适配与集成', 'zh-TW': '本專案負責 Node.js 適配與整合', en: 'Node.js adaptation & integration by this project' },

  // 状态与反馈通用
  'status.savedDefault': { 'zh-CN': '未单独设置 · 使用默认', 'zh-TW': '未單獨設定 · 使用預設', en: 'Default' },
  'status.savedShortDefault': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
  'status.badge.unavailable': { 'zh-CN': '暂时无法读取客户端状态', 'zh-TW': '暫時無法讀取用戶端狀態', en: 'Client status unavailable' },
  'status.badge.reading': { 'zh-CN': '状态读取中…', 'zh-TW': '狀態讀取中…', en: 'Reading status…' },
  'status.badge.pendingRestart': { 'zh-CN': '需要重启', 'zh-TW': '需要重新啟動', en: 'Restart Required' },
  'status.badge.notPatched': { 'zh-CN': '未修改 · 默认', 'zh-TW': '未修改 · 預設', en: 'Unmodified' },
  'status.badge.unconfirmed': { 'zh-CN': '状态未确认', 'zh-TW': '狀態未確認', en: 'Unconfirmed' },
  'status.badge.loaded': { 'zh-CN': '已加载', 'zh-TW': '已載入', en: 'Active' },
  'status.badge.failed': { 'zh-CN': '应用失败', 'zh-TW': '套用失敗', en: 'Apply Failed' },
  'status.client.reading': { 'zh-CN': '客户端设置：状态读取中…', 'zh-TW': '用戶端設定：狀態讀取中…', en: 'Client setting: reading…' },
  'status.client.pendingRestart': { 'zh-CN': '待重启：已设置为 {val}，重启后生效', 'zh-TW': '待重啟：已設定為 {val}，重啟後生效', en: 'Pending restart: set to {val}, restart client to apply' },
  'status.client.loadedFixed': { 'zh-CN': '当前已加载的设置：{val}', 'zh-TW': '目前已載入的設定：{val}', en: 'Active loaded setting: {val}' },
  'status.client.loadedDynamic': { 'zh-CN': '当前已加载的设置：跟随模型', 'zh-TW': '目前已載入的設定：跟隨模型', en: 'Active loaded setting: Follow Model' },
  'status.client.loadedDefault': { 'zh-CN': '当前已加载的设置：官方默认', 'zh-TW': '目前已載入的設定：官方預設', en: 'Active loaded setting: Official Default' },
  'status.client.unknown': { 'zh-CN': '当前已加载设置：未知', 'zh-TW': '目前已載入設定：未知', en: 'Active loaded setting: unknown' },
  'status.client.dynamic': { 'zh-CN': '客户端设置：跟随模型 · 按各模型自身上限', 'zh-TW': '用戶端設定：跟隨模型 · 依各模型自身上限', en: 'Client setting: Follow Model' },
  'status.client.fixed': { 'zh-CN': '客户端设置：{val} · 全局统一长度', 'zh-TW': '用戶端設定：{val} · 全域統一長度', en: 'Client setting: {val} · unified' },
  'msg.savedUnified': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為此模型儲存統一設定。', en: 'Saved unified setting for this model.' },
  'msg.saveUnifiedFail': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save unified setting: {err}' },
  'msg.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
  'msg.resetDefault': { 'zh-CN': '已恢复默认设置。', 'zh-TW': '已恢復預設設定。', en: 'Reset to default.' },
  'msg.resetStillUsing': { 'zh-CN': '客户端仍在使用 {val}。需要时请在「详细说明」里点「客户端恢复原始设置」。', 'zh-TW': '用戶端仍在使用 {val}。需要時請在「詳細說明」中點擊「用戶端恢復原始設定」。', en: 'Client is still using {val}. Use "Restore Client Default" in Details if needed.' },
  'msg.clearFail': { 'zh-CN': '清除设置失败：{err}', 'zh-TW': '清除設定失敗：{err}', en: 'Failed to clear setting: {err}' },
  'msg.appliedRestart': { 'zh-CN': '已应用。重启客户端后生效。', 'zh-TW': '已套用。重新啟動用戶端後生效。', en: 'Applied. Restart the client to take effect.' },
  'msg.alreadyClient': { 'zh-CN': '客户端已经是这个设置', 'zh-TW': '用戶端已經是此設定', en: 'Client is already using this setting.' },
  'msg.applied': { 'zh-CN': '已应用当前设置。', 'zh-TW': '已套用目前設定。', en: 'Setting applied.' },
  'msg.restoredRestart': { 'zh-CN': '客户端已恢复原始设置，重启客户端后生效。', 'zh-TW': '用戶端已恢復原始設定，重新啟動用戶端後生效。', en: 'Client restored to original default. Restart to take effect.' },
  'msg.restoreFail': { 'zh-CN': '恢复原始设置失败', 'zh-TW': '恢復原始設定失敗', en: 'Failed to restore client default' },
  'msg.writeBusy': { 'zh-CN': '客户端正在占用文件，写入失败。请关闭客户端后再试。', 'zh-TW': '用戶端正在佔用檔案，寫入失敗。請關閉用戶端後再試。', en: 'File is in use by the client. Close the client and try again.' },
  'msg.writeFail': { 'zh-CN': '写入失败：{err}', 'zh-TW': '寫入失敗：{err}', en: 'Write failed: {err}' },
  'msg.unknownErr': { 'zh-CN': '未知错误', 'zh-TW': '未知錯誤', en: 'Unknown error' },

  // 分页 3: 速度对比
  'speed.range.aria': { 'zh-CN': '时间范围', 'zh-TW': '時間範圍', en: 'Time range' },
  'speed.range.1d': { 'zh-CN': '今日', 'zh-TW': '今日', en: 'Today' },
  'speed.range.3d': { 'zh-CN': '近 3 天', 'zh-TW': '近 3 天', en: '3D' },
  'speed.range.5d': { 'zh-CN': '近 5 天', 'zh-TW': '近 5 天', en: '5D' },
  'speed.range.7d': { 'zh-CN': '近一周', 'zh-TW': '近一週', en: '1W' },
  'speed.range.30d': { 'zh-CN': '近 30 天', 'zh-TW': '近 30 天', en: '30D' },
  'speed.range.all': { 'zh-CN': '全量历史', 'zh-TW': '完整歷史', en: 'All history' },
  'speed.range.custom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
  'speed.range.start': { 'zh-CN': '开始日期', 'zh-TW': '開始日期', en: 'Start date' },
  'speed.range.end': { 'zh-CN': '结束日期', 'zh-TW': '結束日期', en: 'End date' },
  'speed.range.apply': { 'zh-CN': '应用', 'zh-TW': '套用', en: 'Apply' },
  'speed.range.invalid': { 'zh-CN': '请选择有效的起止日期', 'zh-TW': '請選擇有效的起訖日期', en: 'Choose a valid date range' },
  'speed.origin.aria': { 'zh-CN': '样本来源', 'zh-TW': '樣本來源', en: 'Sample origin' },
  'speed.origin.all': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All sources' },
  'speed.origin.chat': { 'zh-CN': '日常对话', 'zh-TW': '日常對話', en: 'Chat' },
  'speed.metric.aria': { 'zh-CN': '对比指标', 'zh-TW': '對比指標', en: 'Metric' },
  'speed.metric.tps': { 'zh-CN': '输出速度 tok/s', 'zh-TW': '輸出速度 tok/s', en: 'Output tok/s' },
  'speed.metric.ttft': { 'zh-CN': '首字延迟 TTFT', 'zh-TW': '首字延遲 TTFT', en: 'TTFT' },
  'speed.metric.duration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
  'speed.filter.source': { 'zh-CN': '数据源', 'zh-TW': '資料來源', en: 'Source' },
  'speed.filter.metric': { 'zh-CN': '对比指标', 'zh-TW': '對比指標', en: 'Metric' },
  'speed.hero.title': { 'zh-CN': '模型速度 PK 对比台', 'zh-TW': '模型速度 PK 對比台', en: 'Model Speed PK Board' },
  'speed.hero.selectedPrev': { 'zh-CN': '已选', 'zh-TW': '已選', en: 'Picked' },
  'speed.hero.selectedUnit': { 'zh-CN': '款', 'zh-TW': '款', en: 'models' },
  'speed.hero.addModel': { 'zh-CN': '+ 添加模型对比', 'zh-TW': '+ 新增模型對比', en: '+ Add model' },
  'speed.hero.clear': { 'zh-CN': '清空选择', 'zh-TW': '清空選擇', en: 'Clear' },
  'speed.algo.median': { 'zh-CN': '中位数', 'zh-TW': '中位數', en: 'Median' },
  'speed.algo.mean': { 'zh-CN': '均值', 'zh-TW': '均值', en: 'Mean' },
  'speed.algo.composite': { 'zh-CN': '综合效率', 'zh-TW': '綜合效率', en: 'Composite' },
  'speed.filter.algo': { 'zh-CN': '统计口径', 'zh-TW': '統計口徑', en: 'Statistic' },
  'speed.hero.champion': { 'zh-CN': '最快', 'zh-TW': '最快', en: 'Fastest' },
  'speed.hero.current': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Current' },
  'speed.hero.emptyPk': { 'zh-CN': '尚未选择对比模型 · 在下方排行中勾选即可', 'zh-TW': '尚未選擇對比模型 · 在下方排行中勾選即可', en: 'No model picked yet · tick models in the ranking below' },
  'speed.hero.emptyTrend': { 'zh-CN': '暂无对比曲线', 'zh-TW': '暫無對比曲線', en: 'No trend to plot' },
  'speed.hero.fastest': { 'zh-CN': '当前模型 · 最快', 'zh-TW': '目前模型 · 最快', en: 'Current · Fastest' },
  'speed.hero.base': { 'zh-CN': '基准 {x}x', 'zh-TW': '基準 {x}x', en: 'Base {x}x' },
  'speed.hero.slower': { 'zh-CN': '慢 {pct}%', 'zh-TW': '慢 {pct}%', en: '{pct}% slower' },
  'speed.hero.faster': { 'zh-CN': '快 {pct}%', 'zh-TW': '快 {pct}%', en: '{pct}% faster' },
  'speed.hero.rankN': { 'zh-CN': '对比项 #{n}', 'zh-TW': '對比項 #{n}', en: 'Compare #{n}' },
  'speed.hero.firstBest': { 'zh-CN': '首字最快', 'zh-TW': '首字最快', en: 'Fastest TTFT' },
  'speed.hero.ttft': { 'zh-CN': '首字延迟 TTFT', 'zh-TW': '首字延遲 TTFT', en: 'TTFT' },
  'speed.hero.medianOut': { 'zh-CN': '中位输出', 'zh-TW': '中位輸出', en: 'Median output' },
  'speed.hero.samples': { 'zh-CN': '统计样本', 'zh-TW': '統計樣本', en: 'Samples' },
  'speed.hero.lowSample': { 'zh-CN': '样本 {n} · 偏少', 'zh-TW': '樣本 {n} · 偏少', en: 'Samples {n} · low' },
  'speed.hero.sampleCount': { 'zh-CN': '{n} 次', 'zh-TW': '{n} 次', en: '{n}x' },
  'speed.trend.title': { 'zh-CN': '各模型速度走势 · tok/s', 'zh-TW': '各模型速度走勢 · tok/s', en: 'Speed by model · tok/s' },
  'speed.trend.titleTtft': { 'zh-CN': '各模型首字延迟走势 · s', 'zh-TW': '各模型首字延遲走勢 · s', en: 'TTFT by model · s' },
  'speed.trend.titleDuration': { 'zh-CN': '各模型总耗时走势 · s', 'zh-TW': '各模型總耗時走勢 · s', en: 'Request duration by model · s' },
  'speed.trend.stability': { 'zh-CN': '速度平稳度', 'zh-TW': '速度平穩度', en: 'Stability' },
  'speed.trend.granularity.day': { 'zh-CN': '按日聚合', 'zh-TW': '按日彙整', en: 'Grouped by day' },
  'speed.trend.granularity.week': { 'zh-CN': '按周聚合', 'zh-TW': '按週彙整', en: 'Grouped by week' },
  'speed.trend.granularity.hour': { 'zh-CN': '按小时聚合', 'zh-TW': '按小時彙整', en: 'Grouped by hour' },
  'speed.trend.granularity.sample': { 'zh-CN': '按采样序列', 'zh-TW': '按採樣序列', en: 'Individual samples' },
  'speed.trend.today': { 'zh-CN': '今日', 'zh-TW': '今日', en: 'Today' },
  'session.widget.magnetFit': { 'zh-CN': '并排边界', 'zh-TW': '並排邊界', en: 'Side-by-side limit' },
  'session.preset.saveNew': { 'zh-CN': '+ 保存为预设', 'zh-TW': '+ 儲存為預設', en: '+ Save as preset' },
  'session.preset.overwrite': { 'zh-CN': '覆盖保存', 'zh-TW': '覆寫儲存', en: 'Save changes' },
  'session.preset.rename': { 'zh-CN': '重命名', 'zh-TW': '重新命名', en: 'Rename' },
  'session.preset.delete': { 'zh-CN': '删除预设', 'zh-TW': '刪除預設', en: 'Delete preset' },
  'session.preset.name': { 'zh-CN': '预设名称', 'zh-TW': '預設名稱', en: 'Preset name' },
  'session.preset.submit': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },
  'session.preset.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'session.widget.requestCost': { 'zh-CN': '单次请求费用与缓存节省', 'zh-TW': '單次請求費用與快取節省', en: 'Request costs and cache savings' },
  'session.requestCost.empty': { 'zh-CN': '暂无已完成的请求', 'zh-TW': '暫無已完成的請求', en: 'No completed requests' },
  'session.requestCost.total': { 'zh-CN': '会话估算 {cost} · 缓存节省 {savings} · {percent}', 'zh-TW': '工作階段估算 {cost} · 快取節省 {savings} · {percent}', en: 'Session estimate {cost} · Cache saved {savings} · {percent}' },
  'session.requestCost.tokens': { 'zh-CN': '新增 {input} · 缓存 {cache} · 输出 {output}', 'zh-TW': '新增 {input} · 快取 {cache} · 輸出 {output}', en: 'Input {input} · Cached {cache} · Output {output}' },
  'session.requestCost.price': { 'zh-CN': '估算 {cost} · 节省 {savings}', 'zh-TW': '估算 {cost} · 節省 {savings}', en: 'Estimate {cost} · Saved {savings}' },
  'session.requestCost.unpriced': { 'zh-CN': '{n} 次无费率', 'zh-TW': '{n} 次無費率', en: '{n} requests without rates' },
  'speed.rank.title': { 'zh-CN': '全量模型统计排行 · 点击勾选加入对比', 'zh-TW': '全量模型統計排行 · 點擊勾選加入對比', en: 'All model ranking · tick to compare' },
  'speed.rank.countTotal': { 'zh-CN': '共 {n} 个已测模型', 'zh-TW': '共 {n} 個已測模型', en: '{n} measured models' },
  'speed.rank.searchPlaceholder': { 'zh-CN': '过滤模型名称或架构标签', 'zh-TW': '過濾模型名稱或架構標籤', en: 'Filter model or tag' },
  'speed.rank.sortAria': { 'zh-CN': '排序方式', 'zh-TW': '排序方式', en: 'Sort' },
  'speed.rank.sortTps': { 'zh-CN': '中位速度降序', 'zh-TW': '中位速度降序', en: 'Median speed desc' },
  'speed.rank.sortTtft': { 'zh-CN': '首字延迟升序', 'zh-TW': '首字延遲升序', en: 'TTFT asc' },
  'speed.rank.sortSamples': { 'zh-CN': '样本数降序', 'zh-TW': '樣本數降序', en: 'Samples desc' },
  'speed.rank.colPick': { 'zh-CN': '对比', 'zh-TW': '對比', en: 'Pick' },
  'speed.rank.colModel': { 'zh-CN': '模型规格与配置', 'zh-TW': '模型規格與設定', en: 'Model & config' },
  'speed.rank.colDist': { 'zh-CN': '吞吐速度分布 · tok/s', 'zh-TW': '吞吐速度分布 · tok/s', en: 'Throughput · tok/s' },
  'speed.rank.colMetric': { 'zh-CN': '核心实测指标 · 中位数', 'zh-TW': '核心實測指標 · 中位數', en: 'Core metrics · median' },
  'speed.rank.note': { 'zh-CN': '速率仅统计有效 Streaming 生成周期 · 已剔除首次网络握手耗时', 'zh-TW': '速率僅統計有效 Streaming 生成週期 · 已剔除首次網路握手耗時', en: 'Rate counts valid streaming cycles only · first handshake excluded' },
  'speed.rank.export': { 'zh-CN': '导出 CSV', 'zh-TW': '匯出 CSV', en: 'Export CSV' },
  'speed.rank.exportOk': { 'zh-CN': '已导出 {n} 行', 'zh-TW': '已匯出 {n} 行', en: 'Exported {n} rows' },
  'speed.rank.reset': { 'zh-CN': '重置筛选', 'zh-TW': '重置篩選', en: 'Reset filters' },
  'speed.rank.empty': { 'zh-CN': '没有匹配的模型', 'zh-TW': '沒有符合的模型', en: 'No matching model' },
  'speed.rank.current': { 'zh-CN': '· 当前使用', 'zh-TW': '· 目前使用', en: '· In use' },
  'speed.barTitle.tps': { 'zh-CN': '输出速度对比', 'zh-TW': '輸出速度對比', en: 'Output Speed Comparison' },
  'speed.barTitle.ttft': { 'zh-CN': '首字延迟对比', 'zh-TW': '首字延遲對比', en: 'First-Token Latency (TTFT)' },
  'speed.barTitle.duration': { 'zh-CN': '总耗时对比', 'zh-TW': '總耗時對比', en: 'Total Duration Comparison' },
  'speed.empty': { 'zh-CN': '还没有可用的速度记录。正常对话后会自动积累。', 'zh-TW': '還沒有可用的速度記錄。正常對話後會自動累積。', en: 'No speed samples yet. Samples are recorded automatically during normal chats.' },
  'speed.barNote': { 'zh-CN': '以各模型与档位的中位数统计；不足 3 条标注“样本少”。总耗时受输出长度影响，条件相近时才可比较。', 'zh-TW': '以各模型與檔位的中位數統計；不足 3 筆標註「樣本少」。總耗時受輸出長度影響，條件相近時才可比較。', en: 'Bars show median per model & effort; <3 samples are marked "Low n". Total duration depends on output length.' },
  'speed.lineTitle': { 'zh-CN': '单模型速度趋势', 'zh-TW': '單模型速度趨勢', en: 'Model Speed Trend' },
  'speed.linePickTitle': { 'zh-CN': '选择一个模型与档位查看速度变化', 'zh-TW': '選擇一個模型與檔位檢視速度變化', en: 'Select a model & effort to view speed trend' },
  'speed.lineNoModel': { 'zh-CN': '暂无模型记录', 'zh-TW': '暫無模型記錄', en: 'No model records' },
  'speed.activeTestNote': { 'zh-CN': '主动测试：未接通。目前没有可靠的指定模型调用入口，暂时只能使用日常对话的实测记录。', 'zh-TW': '主動測試：未接通。目前沒有可靠的指定模型呼叫入口，暫時只能使用日常對話的實測記錄。', en: 'Active benchmark: unavailable. No reliable per-model probe endpoint exists yet; showing live chat measurements only.' },
  'speed.lowSample': { 'zh-CN': '样本少', 'zh-TW': '樣本少', en: 'Low n' },
  'speed.samples': { 'zh-CN': '{n} 条', 'zh-TW': '{n} 筆', en: '{n} samples' },
  'speed.median': { 'zh-CN': '中位数：{val}', 'zh-TW': '中位數：{val}', en: 'Median: {val}' },
  'speed.avg': { 'zh-CN': '均值：{val}', 'zh-TW': '均值：{val}', en: 'Avg: {val}' },
  'speed.sampleCount': { 'zh-CN': '样本数：{n} 条', 'zh-TW': '樣本數：{n} 筆', en: 'Samples: {n}' },
  'speed.latestAt': { 'zh-CN': '最近：{time}', 'zh-TW': '最近：{time}', en: 'Latest: {time}' },

  // 齿轮设置页
  'settings.back': { 'zh-CN': '‹ 返回', 'zh-TW': '‹ 返回', en: '‹ Back' },
  'settings.title': { 'zh-CN': '设置语言、网络代理与外观', 'zh-TW': '設定語言、網路代理與外觀', en: 'Settings: Language, Proxy & Appearance' },
  'settings.panelLang.title': { 'zh-CN': '🌐 Context Meter 插件面板语言', 'zh-TW': '🌐 Context Meter 外掛面板語言', en: '🌐 Context Meter Panel Language' },
  'settings.panelLang.aria': { 'zh-CN': '插件面板语言', 'zh-TW': '外掛面板語言', en: 'Panel language' },
  'settings.panelLang.desc': { 'zh-CN': '控制 Context Meter 面板、按钮、图表与提示文字. 切换立即生效并保存，重启后保留；不改写上下文长度，不触发重启.', 'zh-TW': '控制 Context Meter 面板、按鈕、圖表與提示文字. 切換立即生效並儲存，重啟後保留；不改寫上下文長度，不觸發重啟.', en: 'Controls Context Meter UI, charts, and messages. Applies and saves immediately without changing context limits or restarting.' },
  'settings.panelLang.saved': { 'zh-CN': '已切换并保存', 'zh-TW': '已切換並儲存', en: 'Saved' },
  'settings.panelLang.saveLocal': { 'zh-CN': '已切换，仅本地生效', 'zh-TW': '已切換，僅本機生效', en: 'Applied locally' },
  'settings.clientLang.title': { 'zh-CN': '🖥️ Antigravity 客户端界面语言', 'zh-TW': '🖥️ Antigravity 用戶端介面語言', en: '🖥️ Antigravity Client UI Language' },
  'settings.clientLang.aria': { 'zh-CN': '客户端界面语言', 'zh-TW': '用戶端介面語言', en: 'Client UI language' },
  'settings.clientLang.statusLabel': { 'zh-CN': '客户端当前语言与生效方式', 'zh-TW': '用戶端目前語言與生效方式', en: 'Client language status & apply behavior' },
  'settings.clientLang.licenseNote': { 'zh-CN': '说明：此设置控制 Antigravity 客户端本身，与上方插件面板语言相互独立。切换客户端语言需重新安装/重启客户端后生效。由于上游客户端繁體中文词典（qqxpee/antigravity2-cn）未声明开源许可证，暂未内置客户端繁體中文选项。', 'zh-TW': '說明：此設定控制 Antigravity 用戶端本身，與上方外掛面板語言相互獨立。切換用戶端語言需重新安裝／重新啟動用戶端後生效。由於上游用戶端繁體中文詞典（qqxpee/antigravity2-cn）未聲明開源授權，暫未內建用戶端繁體中文選項。', en: 'Note: Controls Antigravity itself, independent from Panel Language. Changing client language requires reinstalling/restarting Antigravity. Traditional Chinese client dicts (upstream qqxpee/antigravity2-cn) have no declared license and are not bundled.' },
  'settings.clientLang.sourceLabel': { 'zh-CN': '汉化方案来源：', 'zh-TW': '中文化方案來源：', en: 'Localization source:' },
  'settings.clientLang.sourceValue': { 'zh-CN': 'AntigravityChinese (开源社区贡献)', 'zh-TW': 'AntigravityChinese（開源社群貢獻）', en: 'AntigravityChinese (Community)' },
  'settings.proxy.title': { 'zh-CN': '🌐 免 TUN 网络直连与本地代理', 'zh-TW': '🌐 免 TUN 網路直連與本機代理', en: '🌐 TUN-free Local Proxy' },
  'settings.proxy.statusLabel': { 'zh-CN': '代理直连配置与状态', 'zh-TW': '代理直連設定與狀態', en: 'Proxy configuration & status' },
  'settings.proxy.urlLabel': { 'zh-CN': '本地代理地址，如 http://127.0.0.1:7897：', 'zh-TW': '本機代理位址，如 http://127.0.0.1:7897：', en: 'Local proxy URL, e.g. http://127.0.0.1:7897:' },
  'settings.proxy.bypassLabel': { 'zh-CN': '绕过代理列表 NO_PROXY：', 'zh-TW': '略過代理清單 NO_PROXY：', en: 'Bypass list NO_PROXY:' },
  'settings.proxy.testBtn': { 'zh-CN': '🔍 测试代理连通性', 'zh-TW': '🔍 測試代理連通性', en: '🔍 Test Proxy' },
  'settings.colors.title': { 'zh-CN': '🎨 指标与背景颜色自定义', 'zh-TW': '🎨 指標與背景顏色自訂', en: '🎨 Metric & Background Colors' },
  'settings.colors.panelBg': { 'zh-CN': '面板与菜单统一背景色', 'zh-TW': '面板與選單統一背景色', en: 'Unified panel & menu background' },
  'settings.colors.ringUsed': { 'zh-CN': '圆环已用部分', 'zh-TW': '圓環已用部分', en: 'Ring used' },
  'settings.colors.ringTrack': { 'zh-CN': '圆环轨道', 'zh-TW': '圓環軌道', en: 'Ring track' },
  'settings.colors.contextText': { 'zh-CN': '上下文用量文字', 'zh-TW': 'Context 用量文字', en: 'Context text' },
  'settings.colors.speedText': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
  'settings.colors.tokenTotal': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 Token 用量', en: 'Total tokens' },
  'settings.colors.tokenAccent': { 'zh-CN': '其他 token 指标', 'zh-TW': '其他 Token 指標', en: 'Token accent' },
  'settings.colors.note': { 'zh-CN': '注：高占用与超限告警色独立保留，不被常态颜色覆盖。', 'zh-TW': '註：高佔用與超限警示色獨立保留，不被常態顏色覆蓋。', en: 'Note: High-usage and overflow alert colors remain independent.' },
  'settings.colors.resetAll': { 'zh-CN': '全部恢复跟随主题', 'zh-TW': '全部還原跟隨佈景主題', en: 'Reset all to theme' },
  'drawer.expand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
  'drawer.collapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
  'drawer.expandSettings': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
  'drawer.collapseSettings': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

  // 下拉菜单通用
  'dropdown.searchPlaceholder': { 'zh-CN': '🔍 搜索...', 'zh-TW': '🔍 搜尋...', en: '🔍 Search...' },
  'dropdown.empty': { 'zh-CN': '未找到匹配项', 'zh-TW': '找不到相符項目', en: 'No matching items' },
  'dropdown.modelSearch': { 'zh-CN': '🔍 搜索模型或厂商…', 'zh-TW': '🔍 搜尋模型或廠商…', en: '🔍 Search model or vendor…' },
  'dropdown.modelEmpty': { 'zh-CN': '未找到匹配的模型', 'zh-TW': '找不到符合的模型', en: 'No matching models' },
  'dropdown.speedSearch': { 'zh-CN': '🔍 搜索模型或档位…', 'zh-TW': '🔍 搜尋模型或檔位…', en: '🔍 Search model or effort…' },
  'dropdown.speedEmpty': { 'zh-CN': '未找到匹配的模型记录', 'zh-TW': '找不到符合的模型記錄', en: 'No matching speed records' },

  // Token 面板 & 颜色选择器 & 更新浮层
  'tokens.title': { 'zh-CN': '本机已记录用量', 'zh-TW': '本機已記錄用量', en: 'Local Recorded Usage' },
  'tokens.sourceLabel': { 'zh-CN': '来源:', 'zh-TW': '來源:', en: 'Source:' },
  'tokens.src.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'tokens.src.desktop': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },
  'tokens.src.cli': { 'zh-CN': 'CLI', 'zh-TW': 'CLI', en: 'CLI' },
  'tokens.view.tokens': { 'zh-CN': 'Token 统计', 'zh-TW': 'Token 統計', en: 'Token Stats' },
  'tokens.view.models': { 'zh-CN': '按模型', 'zh-TW': '依模型', en: 'By Model' },
  'tokens.view.cost': { 'zh-CN': 'API 参考金额', 'zh-TW': 'API 參考金額', en: 'API Est. Cost' },
  'tokens.view.requests': { 'zh-CN': '实时请求', 'zh-TW': '即時請求', en: 'Live Requests' },
  'tokens.titleModels': { 'zh-CN': '按模型 Token 用量', 'zh-TW': '依模型 Token 用量', en: 'Model Usage History' },
  'tokens.titleRequests': { 'zh-CN': '实时请求统计', 'zh-TW': '即時請求統計', en: 'Live Request Stats' },
  'reqLog.liveBadge': { 'zh-CN': '实时同步', 'zh-TW': '即時同步', en: 'Live' },
  'reqLog.summary': { 'zh-CN': '共 {total} 条请求 · 今日 {today} 条', 'zh-TW': '共 {total} 筆請求 · 今日 {today} 筆', en: '{total} requests · {today} today' },
  'reqLog.summaryFiltered': { 'zh-CN': '显示 {shown} / {total} 条', 'zh-TW': '顯示 {shown} / {total} 筆', en: 'Showing {shown} / {total}' },
  'reqLog.sourceDesktop': { 'zh-CN': 'Antigravity 桌面端', 'zh-TW': 'Antigravity 桌面端', en: 'Antigravity Desktop' },
  'reqLog.filterAll': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'reqLog.filterSuccess': { 'zh-CN': '成功', 'zh-TW': '成功', en: 'Success' },
  'reqLog.filterError': { 'zh-CN': '异常', 'zh-TW': '異常', en: 'Errors' },
  'reqLog.sortAria': { 'zh-CN': '请求排序方式', 'zh-TW': '請求排序方式', en: 'Sort requests by' },
  'reqLog.sortTime': { 'zh-CN': '时间', 'zh-TW': '時間', en: 'Time' },
  'reqLog.sortTokens': { 'zh-CN': 'Token', 'zh-TW': 'Token', en: 'Tokens' },
  'reqLog.sortCost': { 'zh-CN': '费用', 'zh-TW': '費用', en: 'Cost' },
  'reqLog.sortDuration': { 'zh-CN': '耗时', 'zh-TW': '耗時', en: 'Duration' },
  'reqLog.sortSpeed': { 'zh-CN': '速度', 'zh-TW': '速度', en: 'Speed' },
  'prefs.saveDefault': { 'zh-CN': '设为默认', 'zh-TW': '設為預設', en: 'Set Default' },
  'prefs.saveDefaultTitle': { 'zh-CN': '保存当前时间范围、趋势模式与排序方式为默认视图', 'zh-TW': '儲存目前時間範圍、趨勢模式與排序方式為預設檢視', en: 'Save current time range, trend mode, and sort order as default view' },
  'prefs.savedFeedback': { 'zh-CN': '✓ 已设为默认', 'zh-TW': '✓ 已設為預設', en: '✓ Saved Default' },
  'reqLog.refresh': { 'zh-CN': '刷新', 'zh-TW': '重新整理', en: 'Refresh' },
  'reqLog.refreshTitle': { 'zh-CN': '立即刷新请求记录', 'zh-TW': '立即重新整理請求紀錄', en: 'Refresh request logs now' },
  'reqLog.col.time': { 'zh-CN': '时间', 'zh-TW': '時間', en: 'Time' },
  'reqLog.col.agent': { 'zh-CN': 'AGENT', 'zh-TW': 'AGENT', en: 'AGENT' },
  'reqLog.col.reqModel': { 'zh-CN': '请求模型', 'zh-TW': '請求模型', en: 'Requested' },
  'reqLog.col.provider': { 'zh-CN': '供应商 · 账号', 'zh-TW': '供應商 · 帳號', en: 'Provider · Account' },
  'reqLog.col.actualModel': { 'zh-CN': '实际模型', 'zh-TW': '實際模型', en: 'Actual Model' },
  'reqLog.col.input': { 'zh-CN': '输入', 'zh-TW': '輸入', en: 'Input' },
  'reqLog.col.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'reqLog.col.cacheHit': { 'zh-CN': '缓存命中率', 'zh-TW': '快取命中率', en: 'Cache Hit' },
  'reqLog.col.cost': { 'zh-CN': '费用', 'zh-TW': '費用', en: 'Cost' },
  'reqLog.col.ttft': { 'zh-CN': '首字耗时', 'zh-TW': '首字耗時', en: 'TTFT' },
  'reqLog.col.duration': { 'zh-CN': '耗时', 'zh-TW': '耗時', en: 'Duration' },
  'reqLog.col.speed': { 'zh-CN': '速度', 'zh-TW': '速度', en: 'Speed' },
  'reqLog.col.status': { 'zh-CN': '状态', 'zh-TW': '狀態', en: 'Status' },
  'reqLog.provider.localSession': { 'zh-CN': '本地会话', 'zh-TW': '本機工作階段', en: 'Local Session' },
  'reqLog.unit.sec': { 'zh-CN': '≈{val} 秒', 'zh-TW': '≈{val} 秒', en: '≈{val}s' },
  'reqLog.unit.minSec': { 'zh-CN': '≈{m}分{s}秒', 'zh-TW': '≈{m}分{s}秒', en: '≈{m}m {s}s' },
  'reqLog.unit.tps': { 'zh-CN': '{val} token/秒', 'zh-TW': '{val} token/秒', en: '{val} tok/s' },
  'reqLog.status.success': { 'zh-CN': '成功', 'zh-TW': '成功', en: 'Success' },
  'reqLog.status.streaming': { 'zh-CN': '生成中', 'zh-TW': '生成中', en: 'Streaming' },
  'reqLog.status.failed': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'reqLog.status.exceeded': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Exceeded' },
  'reqLog.status.rateLimited': { 'zh-CN': '限流', 'zh-TW': '限流', en: 'Rate Limited' },
  'reqLog.status.quotaExhausted': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Quota Out' },
  'reqLog.status.network': { 'zh-CN': '网络异常', 'zh-TW': '網路異常', en: 'Network' },
  'reqLog.status.authError': { 'zh-CN': '鉴权失败', 'zh-TW': '驗證失敗', en: 'Auth Error' },
  'reqLog.status.canceled': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Canceled' },
  'reqLog.empty': { 'zh-CN': '当前筛选条件下暂无请求记录', 'zh-TW': '目前篩選條件下尚無請求紀錄', en: 'No request records match current filter' },
  'reqLog.loadMore': { 'zh-CN': '加载更多 ({n} 条剩余)', 'zh-TW': '載入更多 (剩餘 {n} 筆)', en: 'Load more ({n} remaining)' },
  'reqLog.tipInputBreakdown': { 'zh-CN': '未缓存输入 {inp} · 缓存读取 {cache} · 总输入 {total}', 'zh-TW': '未快取輸入 {inp} · 快取讀取 {cache} · 總輸入 {total}', en: 'Uncached {inp} · Cache read {cache} · Total in {total}' },
  'reqLog.tipOutputBreakdown': { 'zh-CN': '总输出 {out}（含思考 {think}）', 'zh-TW': '總輸出 {out}（含思考 {think}）', en: 'Output {out} (incl. thinking {think})' },
  'reqLog.tipSubagent': { 'zh-CN': '子代理调用', 'zh-TW': '子代理呼叫', en: 'Subagent call' },
  'reqLog.syncPricing': { 'zh-CN': '同步价格', 'zh-TW': '同步價格', en: 'Sync Prices' },
  'reqLog.syncPricingTitle': { 'zh-CN': '从 models.dev 与 LiteLLM 同步最新模型定价', 'zh-TW': '從 models.dev 與 LiteLLM 同步最新模型定價', en: 'Sync latest model prices from models.dev & LiteLLM' },
  'reqLog.syncPricingTitleUpdated': { 'zh-CN': '已同步 {count} 个模型（来源：{sources} · {time}），点击重新同步', 'zh-TW': '已同步 {count} 個模型（來源：{sources} · {time}），點擊重新同步', en: 'Synced {count} models ({sources} · {time}). Click to refresh' },
  'reqLog.syncingPricing': { 'zh-CN': '同步中…', 'zh-TW': '同步中…', en: 'Syncing…' },
  'reqLog.syncPricingDone': { 'zh-CN': '已同步 {count} 个模型', 'zh-TW': '已同步 {count} 個模型', en: 'Synced {count} models' },
  'reqLog.syncPricingDoneRepriced': { 'zh-CN': '已同步 {count} 个模型 · 补算 {repriced} 条', 'zh-TW': '已同步 {count} 個模型 · 補算 {repriced} 筆', en: 'Synced {count} models · {repriced} repriced' },
  'reqLog.syncPricingFailed': { 'zh-CN': '同步失败：{error}', 'zh-TW': '同步失敗：{error}', en: 'Sync failed: {error}' },
  'composer.speedTurns': { 'zh-CN': '{turns} 轮 {steps} 步 · {speed}', 'zh-TW': '{turns} 輪 {steps} 步 · {speed}', en: '{turns} turns {steps} steps · {speed}' },
  'composer.tokenCache': { 'zh-CN': '{tokens} · 缓存 {hit}', 'zh-TW': '{tokens} · 快取 {hit}', en: '{tokens} · Cache {hit}' },
  'composer.tokenCacheTitle': { 'zh-CN': '会话累计 {tokens} · 会话缓存命中率 {hit}（点击直达实时请求）', 'zh-TW': '會話累計 {tokens} · 會話快取命中率 {hit}（點擊直達即時請求）', en: 'Session total {tokens} · Session Cache Hit Rate {hit} (click for live requests)' },
  'turnFooter.scopeReq': { 'zh-CN': '本次请求', 'zh-TW': '本次請求', en: 'Req' },
  'turnFooter.scopeTurn': { 'zh-CN': '本轮汇总', 'zh-TW': '本輪彙總', en: 'Turn' },
  'turnFooter.cache': { 'zh-CN': '缓存', 'zh-TW': '快取', en: 'Cache' },
  'turnFooter.in': { 'zh-CN': '入', 'zh-TW': '入', en: 'In' },
  'turnFooter.out': { 'zh-CN': '出', 'zh-TW': '出', en: 'Out' },
  'composer.card.tokenUsage': { 'zh-CN': 'Token 用量', 'zh-TW': 'Token 用量', en: 'Token Usage' },
  'composer.card.cacheHit': { 'zh-CN': '缓存命中', 'zh-TW': '快取命中', en: 'Cache Hit' },
  'composer.card.uncachedInput': { 'zh-CN': '未缓存输入', 'zh-TW': '未快取輸入', en: 'Uncached Input' },
  'composer.card.cacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'composer.card.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'composer.card.pinHint': { 'zh-CN': '单击固定', 'zh-TW': '點擊釘選', en: 'Click to pin' },
  'composer.card.pinned': { 'zh-CN': '已固定', 'zh-TW': '已釘選', en: 'Pinned' },
  'composer.card.ctxSegments': { 'zh-CN': '上下文分段', 'zh-TW': '上下文分段', en: 'Context Breakdown' },
  'composer.card.segFresh': { 'zh-CN': '新增 {val}', 'zh-TW': '新增 {val}', en: 'Fresh {val}' },
  'composer.card.segWrite': { 'zh-CN': '写缓存 {val}', 'zh-TW': '寫快取 {val}', en: 'Cache Write {val}' },
  'composer.card.segRead': { 'zh-CN': '读缓存 {val}', 'zh-TW': '讀快取 {val}', en: 'Cache Read {val}' },
  'composer.card.segRemain': { 'zh-CN': '剩余 {val}', 'zh-TW': '剩餘 {val}', en: 'Rem {val}' },
  'composer.card.clickHint': { 'zh-CN': '点击查看实时请求', 'zh-TW': '點擊查看即時請求', en: 'Click to view requests' },
  'composer.card.speedHint': { 'zh-CN': '点击查看速度对比', 'zh-TW': '點擊查看速度對比', en: 'Click to view speed comparison' },
  'composer.card.tokensHint': { 'zh-CN': '点击查看实时请求', 'zh-TW': '點擊查看即時請求', en: 'Click to view real-time requests' },
  'composer.card.contextHint': { 'zh-CN': '点击查看当前会话', 'zh-TW': '點擊查看目前工作階段', en: 'Click to view current session' },
  'composer.card.quotaHint': { 'zh-CN': '点击查看模型额度', 'zh-TW': '點擊查看模型額度', en: 'Click to view model quota' },
  'composer.card.emptySessionHint': { 'zh-CN': '暂无会话数据 · 点击查看实时请求', 'zh-TW': '暫無工作階段資料 · 點擊查看即時請求', en: 'No session data yet · Click to view requests' },
  'composer.card.speedOutput': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
  'composer.card.speedTtft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'Time to first token' },
  'composer.card.speedDuration': { 'zh-CN': '本轮耗时', 'zh-TW': '本輪耗時', en: 'Turn duration' },
  'composer.card.quotaPoolMain': { 'zh-CN': '主模型池', 'zh-TW': '主模型池', en: 'Main pool' },
  'composer.card.quotaPoolOthers': { 'zh-CN': '其余模型池', 'zh-TW': '其餘模型池', en: 'Other pools' },
  'composer.card.quotaNormal': { 'zh-CN': '状态正常', 'zh-TW': '狀態正常', en: 'Status normal' },
  'composer.card.openTokensPanel': { 'zh-CN': '查看完整 Token 看板 ›', 'zh-TW': '檢視完整 Token 看板 ›', en: 'Open Full Token View ›' },
  'composer.card.ctxSegmentsTitle': { 'zh-CN': '上下文构成占比：新增输入 / 写缓存 / 读缓存', 'zh-TW': '上下文構成佔比：新增輸入 / 寫快取 / 讀快取', en: 'Context share: Fresh / Cache Write / Cache Read' },
  'composer.threshold.normal': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
  'composer.threshold.warning': { 'zh-CN': '预警', 'zh-TW': '預警', en: 'Warning' },
  'composer.threshold.critical': { 'zh-CN': '危急', 'zh-TW': '危急', en: 'Critical' },
  'composer.runtime.title': { 'zh-CN': '当前会话运行状态', 'zh-TW': '目前工作階段執行狀態', en: 'Current session runtime status' },
  'composer.runtime.idle': { 'zh-CN': '就绪', 'zh-TW': '就緒', en: 'Ready' },
  'composer.runtime.running': { 'zh-CN': '生成中', 'zh-TW': '生成中', en: 'Running' },
  'composer.runtime.slow': { 'zh-CN': '等待较慢', 'zh-TW': '等待較慢', en: 'Slow' },
  'composer.runtime.error': { 'zh-CN': '状态异常', 'zh-TW': '狀態異常', en: 'Error' },
  'composer.runtime.reason.ready': { 'zh-CN': '就绪', 'zh-TW': '就緒', en: 'Ready' },
  'composer.runtime.reason.generating': { 'zh-CN': '生成中', 'zh-TW': '生成中', en: 'Generating' },
  'composer.runtime.reason.compacting': { 'zh-CN': '压缩上下文中', 'zh-TW': '壓縮上下文中', en: 'Compacting' },
  'composer.runtime.reason.slow_wait': { 'zh-CN': '等待较慢', 'zh-TW': '等待較慢', en: 'Waiting slowly' },
  'composer.runtime.reason.compact_kv_recompute': { 'zh-CN': '跨模型压缩重算缓存', 'zh-TW': '跨模型壓縮重算快取', en: 'Cross-model compact KV recompute' },
  'composer.runtime.reason.retrying': { 'zh-CN': '自动重试中', 'zh-TW': '自動重試中', en: 'Retrying' },
  'composer.runtime.reason.reconnecting': { 'zh-CN': '连接抖动', 'zh-TW': '連線抖動', en: 'Reconnecting' },
  'composer.runtime.reason.disconnected': { 'zh-CN': '连接断开', 'zh-TW': '連線中斷', en: 'Disconnected' },
  'composer.runtime.reason.offline': { 'zh-CN': '网络离线', 'zh-TW': '網路離線', en: 'Offline' },
  'composer.runtime.reason.request_error': { 'zh-CN': '请求异常', 'zh-TW': '請求異常', en: 'Request error' },
  'composer.card.contextTooltip': { 'zh-CN': '已用 {used} / 上限 {limit} · 剩余 {remaining}', 'zh-TW': '已用 {used} / 上限 {limit} · 剩餘 {remaining}', en: 'Used {used} / Limit {limit} · Remaining {remaining}' },
  'composer.speedAria': { 'zh-CN': '速度与轮次详情', 'zh-TW': '速度與輪次詳情', en: 'Speed & turn details' },
  'composer.speedTip': { 'zh-CN': '点击查看速度详情', 'zh-TW': '點擊查看速度詳情', en: 'Click to view speed details' },
  'composer.tokensAria': { 'zh-CN': 'Token 用量与缓存统计', 'zh-TW': 'Token 用量與快取統計', en: 'Token usage & cache stats' },
  'composer.contextAria': { 'zh-CN': '上下文详情', 'zh-TW': '上下文詳情', en: 'Context details' },
  'composer.contextTip': { 'zh-CN': '点击查看上下文详情', 'zh-TW': '點擊查看上下文詳情', en: 'Click to view context details' },
  'composer.cardAria': { 'zh-CN': 'Token 用量与缓存明细', 'zh-TW': 'Token 用量與快取明細', en: 'Token usage & cache breakdown' },
  'composer.speedWaiting': { 'zh-CN': '等待首字…', 'zh-TW': '等待首字…', en: 'Waiting for TTFT…' },
  'modelsUsage.title': { 'zh-CN': '按模型 Token 用量', 'zh-TW': '依模型 Token 用量', en: 'Usage history' },
  'modelsUsage.subtitle': { 'zh-CN': '查看桌面端与 CLI 各模型每日 Token 消耗及占比分布。', 'zh-TW': '檢視桌面端與 CLI 各模型每日 Token 消耗及佔比分布。', en: 'Daily token consumption and share by model across Desktop and CLI.' },
  'modelsUsage.groupModel': { 'zh-CN': '按模型', 'zh-TW': '依模型', en: 'By model' },
  'modelsUsage.groupVariant': { 'zh-CN': '按档位', 'zh-TW': '依檔位', en: 'By variant' },
  'modelsUsage.metricTotal': { 'zh-CN': '含缓存', 'zh-TW': '含快取', en: 'All tokens' },
  'modelsUsage.metricNoCache': { 'zh-CN': '不含缓存', 'zh-TW': '不含快取', en: 'Excl. cache' },
  'modelsUsage.hideUnattr': { 'zh-CN': '隐藏未标明', 'zh-TW': '隱藏未標明', en: 'Hide unattributed' },
  'modelsUsage.showUnattr': { 'zh-CN': '仅已标明 ✓', 'zh-TW': '僅已標明 ✓', en: 'Attributed only ✓' },
  'modelsUsage.unattributed': { 'zh-CN': '未标明模型', 'zh-TW': '未標明模型', en: 'Unattributed' },
  'modelsUsage.prevTitle': { 'zh-CN': '查看更早时间段', 'zh-TW': '檢視更早時段', en: 'Previous period' },
  'modelsUsage.nextTitle': { 'zh-CN': '查看更新时间段', 'zh-TW': '檢視更新時段', en: 'Next period' },
  'modelsUsage.empty': { 'zh-CN': '当前时间窗暂无 Token 用量记录', 'zh-TW': '目前時間窗尚無 Token 用量紀錄', en: 'No token usage recorded in this period' },
  'modelsUsage.stepsSuffix': { 'zh-CN': '{n} 次', 'zh-TW': '{n} 次', en: '{n} reqs' },
  'modelsUsage.scaleMixed': { 'zh-CN': '量级刻度', 'zh-TW': '量級刻度', en: 'Log-Pow Scale' },
  'modelsUsage.scaleLinear': { 'zh-CN': '线性比例', 'zh-TW': '線性比例', en: 'Linear Scale' },
  'modelsUsage.otherSeries': { 'zh-CN': '其他模型/档位', 'zh-TW': '其他模型/檔位', en: 'Other' },
  'cost.card.shareFmt': { 'zh-CN': '占总费用 {pct}%', 'zh-TW': '佔總費用 {pct}%', en: '{pct}% of cost' },
  'tokens.card.total': { 'zh-CN': '累计处理 Token', 'zh-TW': '累計處理 Token', en: 'Total Tokens' },
  'tokens.card.includeCache': { 'zh-CN': '含缓存读取', 'zh-TW': '含快取讀取', en: 'Incl. cache reads' },
  'tokens.card.today': { 'zh-CN': '今日使用', 'zh-TW': '今日使用', en: 'Today' },
  'tokens.card.month': { 'zh-CN': '本月使用', 'zh-TW': '本月使用', en: 'This Month' },
  'tokens.card.year': { 'zh-CN': '年度使用', 'zh-TW': '年度使用', en: 'This Year' },
  'tokens.cache.uncachedInput': { 'zh-CN': '新输入未缓存', 'zh-TW': '新輸入未快取', en: 'Uncached In' },
  'tokens.cache.cacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'tokens.cache.totalInput': { 'zh-CN': '总输入含缓存', 'zh-TW': '總輸入含快取', en: 'Total Input' },
  'tokens.cache.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'tokens.cache.ratio': { 'zh-CN': '缓存读取占比', 'zh-TW': '快取讀取佔比', en: 'Cache Read Ratio' },
  'tokens.cache.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'tokens.cache.na': { 'zh-CN': '不适用', 'zh-TW': '不適用', en: 'N/A' },
  'tokens.cache.partialNote': { 'zh-CN': '按可拆分输入/缓存读取的 Token 总量加权计算；{n} 条历史缺失细分未计入分母。', 'zh-TW': '依可拆分輸入/快取讀取的 Token 總量加權計算；{n} 筆歷史缺少細分未計入分母。', en: 'Token-weighted over records with split input/cache fields; {n} legacy record(s) without split excluded.' },
  'tokens.cache.weightedNote': { 'zh-CN': '按当前来源总缓存读取 / 总输入（未命中缓存输入 + 缓存读取）加权计算。', 'zh-TW': '依目前來源總快取讀取 / 總輸入（未命中快取輸入 + 快取讀取）加權計算。', en: 'Token-weighted: cache read / total input (uncached input + cache read) for active source.' },
  'tokens.cache.missingNote': { 'zh-CN': '当前来源记录缺少输入/缓存细分字段，不作零缓存推断。', 'zh-TW': '目前來源紀錄缺少輸入/快取細分欄位，不作零快取推論。', en: 'Input/cache split fields unavailable for active source; not assumed 0%.' },
  'tokens.cache.zeroInputNote': { 'zh-CN': '当前来源总输入为 0，缓存读取占比不适用。', 'zh-TW': '目前來源總輸入為 0，快取讀取佔比不適用。', en: 'Total input is 0 for active source; cache ratio is N/A.' },

  // 生成体验面板多语标签
  'session.speedSummary.titleNoBolt': { 'zh-CN': '生成体验与速度统计', 'zh-TW': '生成體驗與速度統計', en: 'Generation Speed & Experience' },
  'session.speed.avgStreamRate': { 'zh-CN': '会话平均速率', 'zh-TW': '工作階段平均速率', en: 'Session Avg Speed' },
  'session.speed.avgTip': { 'zh-CN': '当前会话平均生成速度：{avgTps} tok/s{overallPart}（共 {count} 轮，累计 {totalTok} tokens / {totalDur}s）', 'zh-TW': '目前工作階段平均生成速度：{avgTps} tok/s{overallPart}（共 {count} 輪，累計 {totalTok} tokens / {totalDur}s）', en: 'Session average speed: {avgTps} tok/s{overallPart} ({count} turns, {totalTok} tokens / {totalDur}s)' },
  'session.speed.avgOverallPart': { 'zh-CN': '，整体含等待 {overallTps} tok/s', 'zh-TW': '，整體含等待 {overallTps} tok/s', en: ', overall {overallTps} tok/s' },
  'session.speed.streamRate': { 'zh-CN': '本轮纯流式', 'zh-TW': '本輪純串流', en: 'Latest Stream Speed' },
  'session.speed.breakdown.sessionAvg': { 'zh-CN': '当前会话平均速度', 'zh-TW': '目前工作階段平均速度', en: 'Session Average Speed' },
  'session.speed.shortSampleBadge': { 'zh-CN': '短样本', 'zh-TW': '短樣本', en: 'Short sample' },
  'session.speed.shortWindowEst': { 'zh-CN': '短窗口估算 (参考)', 'zh-TW': '短視窗估算 (參考)', en: 'Short-Window Est. (Ref)' },
  'session.speed.shortWindowNote': { 'zh-CN': '流式窗口过短（可能包含思考 Token 集中吐出），未作主速度高亮展示。', 'zh-TW': '流式視窗過短（可能含思考 Token 集中吐出），未作主速度高亮展示。', en: 'Short streaming window (may include buffered thinking tokens); omitted from headline speed.' },
  'session.speed.details': { 'zh-CN': '拆解', 'zh-TW': '拆解', en: 'Details' },
  'session.speed.hideDetails': { 'zh-CN': '收起', 'zh-TW': '收起', en: 'Hide' },
  'session.speed.breakdown.eScore': { 'zh-CN': '综合效率评分', 'zh-TW': '綜合效率評分', en: 'Efficiency E' },
  'session.speed.breakdown.ttft': { 'zh-CN': '首字延迟档位', 'zh-TW': '首字延遲檔位', en: 'TTFT Tier' },
  'session.speed.breakdown.stream': { 'zh-CN': '纯流式速度档位', 'zh-TW': '純流式速度檔位', en: 'Stream Speed Tier' },
  'session.speed.breakdown.overall': { 'zh-CN': '整体平均速率 (对照)', 'zh-TW': '整體平均速率 (對照)', en: 'Overall Avg (Ref)' },
  'session.speed.breakdown.duration': { 'zh-CN': '总生成耗时档位', 'zh-TW': '總生成耗時檔位', en: 'Total Duration Tier' },
  'session.speed.breakdown.stability': { 'zh-CN': '流式稳定性评估', 'zh-TW': '流式穩定性評估', en: 'Stream Stability' },
  'session.speed.breakdown.basis': { 'zh-CN': '体量调节依据', 'zh-TW': '體量調節依據', en: 'Scale Basis' },
  'session.speed.stabilityOk': { 'zh-CN': '输出平稳 ({n} 块 · CV {cv})', 'zh-TW': '輸出平穩 ({n} 塊 · CV {cv})', en: 'Steady ({n} chunks · CV {cv})' },
  'session.speed.stabilityHighVar': { 'zh-CN': '波动较大 ({n} 块 · CV {cv})', 'zh-TW': '波動較大 ({n} 塊 · CV {cv})', en: 'High variance ({n} chunks · CV {cv})' },
  'session.speed.stabilityUnverified': { 'zh-CN': '暂无法评估 (未采集到足够真实流式分块间隔)', 'zh-TW': '暫無法評估 (未採集到足夠真實流式分塊間隔)', en: 'Unable to evaluate (insufficient real chunk intervals)' },
  'session.speed.scoreSkippedSparse': { 'zh-CN': '样本不足 · 跳过综合评分', 'zh-TW': '樣本不足 · 略過綜合評分', en: 'Insufficient sample · Skipped' },
  'session.speed.scoreSkippedMissing': { 'zh-CN': '指标缺失 · 不补造评分', 'zh-TW': '指標缺失 · 不補造評分', en: 'Missing metrics · Skipped' },
  'session.speed.mockTag': { 'zh-CN': '模拟验收', 'zh-TW': '模擬驗收', en: 'Mock Verification' },
  'session.latestCall.unknownMappedModel': { 'zh-CN': '未知模型 (无映射 · 原始 {id})', 'zh-TW': '未知模型 (無對映 · 原始 {id})', en: 'Unknown Model (Unmapped · {id})' },
  'session.latestCall.rawIdNote': { 'zh-CN': '原始 ID: {id}', 'zh-TW': '原始 ID: {id}', en: 'Raw ID: {id}' },

  // 最新调用卡片与会话时间线
  'session.latestCall.title': { 'zh-CN': '最新调用', 'zh-TW': '最新呼叫', en: 'Latest Call' },
  'session.latestCall.newAvailable': { 'zh-CN': '有新调用完成 · 点击查看最新', 'zh-TW': '有新呼叫完成 · 點擊檢視最新', en: 'New call available · Click to view latest' },
  'session.latestCall.statusSuccess': { 'zh-CN': '成功', 'zh-TW': '成功', en: 'Done' },
  'session.latestCall.statusStreaming': { 'zh-CN': '生成中', 'zh-TW': '產生中', en: 'Streaming' },
  'session.latestCall.statusCanceled': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Canceled' },
  'session.latestCall.statusFailed': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'session.latestCall.statusUnknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'session.latestCall.agentMain': { 'zh-CN': '主代理', 'zh-TW': '主代理', en: 'Main' },
  'session.latestCall.agentSub': { 'zh-CN': '子代理', 'zh-TW': '子代理', en: 'Subagent' },
  'session.latestCall.agentUnknown': { 'zh-CN': '未知归属 (缺可靠身份字段)', 'zh-TW': '未知歸屬 (缺可靠身分欄位)', en: 'Unattributed (missing agent field)' },
  'session.latestCall.missingParentStep': { 'zh-CN': '缺可靠父步骤字段', 'zh-TW': '缺可靠父步驟欄位', en: 'missing parent step field' },
  'session.latestCall.inlineTokens': { 'zh-CN': '入 {inp} · 出 {out}', 'zh-TW': '入 {inp} · 出 {out}', en: 'In {inp} · Out {out}' },
  'session.latestCall.inlineCache': { 'zh-CN': '缓存 {val}', 'zh-TW': '快取 {val}', en: 'Cache {val}' },
  'session.latestCall.fieldTime': { 'zh-CN': '调用时间', 'zh-TW': '呼叫時間', en: 'Call Time' },
  'session.latestCall.fieldModelId': { 'zh-CN': '稳定模型标识', 'zh-TW': '穩定模型識別碼', en: 'Model ID' },
  'session.latestCall.fieldModelLabel': { 'zh-CN': '展示名与档位', 'zh-TW': '顯示名稱與檔位', en: 'Display & Effort' },
  'session.latestCall.fieldInput': { 'zh-CN': '未缓存新输入', 'zh-TW': '未快取新輸入', en: 'Input Uncached' },
  'session.latestCall.fieldCacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'session.latestCall.fieldTotalInput': { 'zh-CN': '总输入含缓存', 'zh-TW': '總輸入含快取', en: 'Total Input' },
  'session.latestCall.fieldOutput': { 'zh-CN': '输出含思考', 'zh-TW': '輸出含思考', en: 'Output incl. Thinking' },
  'session.latestCall.fieldCacheRatio': { 'zh-CN': '缓存读取占比', 'zh-TW': '快取讀取佔比', en: 'Cache Read Ratio' },
  'session.latestCall.fieldTtft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
  'session.latestCall.fieldDuration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
  'session.latestCall.fieldSpeed': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Speed' },
  'session.latestCall.fieldAgent': { 'zh-CN': '代理归属', 'zh-TW': '代理歸屬', en: 'Agent Attribution' },
  'session.latestCall.fieldStatus': { 'zh-CN': '调用状态', 'zh-TW': '呼叫狀態', en: 'Status' },
  'session.latestCall.unknownVal': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'session.latestCall.naVal': { 'zh-CN': '不适用', 'zh-TW': '不適用', en: 'N/A' },
  'session.timeline.viewHistory': { 'zh-CN': '查看历史', 'zh-TW': '檢視歷史', en: 'History' },
  'session.timeline.hideHistory': { 'zh-CN': '收起历史', 'zh-TW': '收合歷史', en: 'Hide History' },
  'session.timeline.loading': { 'zh-CN': '正在读取当前会话请求时间线…', 'zh-TW': '正在讀取目前工作階段請求時間線…', en: 'Loading session timeline…' },
  'session.timeline.empty': { 'zh-CN': '当前会话暂无可展示的历史请求记录。', 'zh-TW': '目前工作階段尚無可顯示的歷史請求紀錄。', en: 'No recorded calls found in this session yet.' },
  'session.timeline.loadMore': { 'zh-CN': '加载更早轮次 ({n})', 'zh-TW': '載入更早輪次 ({n})', en: 'Load earlier turns ({n})' },
  'session.timeline.summary': { 'zh-CN': '{turns} 轮 · {calls} 次调用（主 {main} / 子 {sub}） · 会话缓存占比 {cache}', 'zh-TW': '{turns} 輪 · {calls} 次呼叫（主 {main} / 子 {sub}） · 工作階段快取佔比 {cache}', en: '{turns} turn(s) · {calls} call(s) (main {main} / sub {sub}) · Session cache {cache}' },
  'session.timeline.windowNote': { 'zh-CN': '注：单次与整轮累计 Token 为处理量统计，不等同于当前上下文窗口占用。', 'zh-TW': '註：單次與整輪累計 Token 為處理量統計，不等同於目前上下文視窗佔用。', en: 'Note: Per-call & turn cumulative tokens measure usage, not active context window occupancy.' },
  'session.timeline.turnLabel': { 'zh-CN': '第 {n} 轮', 'zh-TW': '第 {n} 輪', en: 'Turn {n}' },
  'session.timeline.turnNoPrompt': { 'zh-CN': '（用户轮次记录）', 'zh-TW': '（使用者輪次紀錄）', en: '(User turn)' },
  'session.timeline.turnSummary': { 'zh-CN': '{calls} 次 · 入 {inp} / 缓 {cap} / 出 {out}', 'zh-TW': '{calls} 次 · 入 {inp} / 快 {cap} / 出 {out}', en: '{calls} · In {inp} / Cache {cap} / Out {out}' },
  'session.timeline.unlinkedTitle': { 'zh-CN': '未归属到具体轮次的调用 / 子代理 ({n})', 'zh-TW': '未歸屬至具體輪次的呼叫 / 子代理 ({n})', en: 'Unlinked / Unattributed Calls ({n})' },
  'session.timeline.dbMissingNote': { 'zh-CN': '缺可靠子代理库字段（{reason}），仅展示已确认调用。', 'zh-TW': '缺可靠子代理庫欄位（{reason}），僅顯示已確認呼叫。', en: 'Missing subagent DB evidence ({reason}); showing confirmed calls only.' },
  'session.timeline.eventsTitle': { 'zh-CN': '上下文变化事件 ({n})', 'zh-TW': '上下文變化事件 ({n})', en: 'Context Events ({n})' },
  'session.timeline.event.compaction': { 'zh-CN': '压缩', 'zh-TW': '壓縮', en: 'Compaction' },
  'session.timeline.event.prune': { 'zh-CN': '裁剪', 'zh-TW': '裁剪', en: 'Prune' },
  'session.timeline.event.inject': { 'zh-CN': '注入', 'zh-TW': '注入', en: 'Inject' },
  'session.timeline.event.model': { 'zh-CN': '切模型', 'zh-TW': '切模型', en: 'Model' },
  'session.timeline.event.mode': { 'zh-CN': '切模式', 'zh-TW': '切模式', en: 'Mode' },
  'session.timeline.tabTurns': { 'zh-CN': '轮次与 Δ', 'zh-TW': '輪次與 Δ', en: 'Turns & Δ' },
  'session.timeline.tabTiming': { 'zh-CN': '阶段耗时', 'zh-TW': '階段耗時', en: 'Timing' },
  'session.timeline.tabFiles': { 'zh-CN': '文件活动', 'zh-TW': '檔案活動', en: 'Files' },
  'session.timeline.tabCommands': { 'zh-CN': '命令执行', 'zh-TW': '命令執行', en: 'Commands' },
  'session.timeline.tabFleet': { 'zh-CN': 'Agent 家族', 'zh-TW': 'Agent 家族', en: 'Agents' },
  'session.timeline.deltaModeAll': { 'zh-CN': '全量+Δ', 'zh-TW': '全量+Δ', en: 'Full+Δ' },
  'session.timeline.deltaModeOnly': { 'zh-CN': '仅看增量 Δ', 'zh-TW': '僅看增量 Δ', en: 'Δ Only' },
  'session.timeline.sortAria': { 'zh-CN': '时间线排序方式', 'zh-TW': '時間軸排序方式', en: 'Timeline sort order' },
  'session.timeline.sortNewest': { 'zh-CN': '最新', 'zh-TW': '最新', en: 'Newest' },
  'session.timeline.sortOldest': { 'zh-CN': '最早', 'zh-TW': '最早', en: 'Oldest' },
  'session.timeline.sortDelta': { 'zh-CN': '按 Δ 最大', 'zh-TW': '依 Δ 最大', en: 'Max Δ' },
  'session.trend.title': { 'zh-CN': '上下文趋势', 'zh-TW': '上下文趨勢', en: 'Context Trend' },
  'session.trend.modeTotal': { 'zh-CN': '总量', 'zh-TW': '總量', en: 'Total' },
  'session.trend.modeDelta': { 'zh-CN': '增量 Δ', 'zh-TW': '增量 Δ', en: 'Delta Δ' },
  'session.trend.granStep': { 'zh-CN': '按步', 'zh-TW': '按步', en: 'Per Step' },
  'session.trend.granTurn': { 'zh-CN': '按轮', 'zh-TW': '按輪', en: 'Per Turn' },
  'session.trend.basisServer': { 'zh-CN': '服务端用量', 'zh-TW': '伺服器用量', en: 'Server Usage' },
  'session.trend.basisEstimate': { 'zh-CN': '本地估算', 'zh-TW': '本機估算', en: 'Local Estimate' },
  'session.trend.basisMixed': { 'zh-CN': '实测+估算', 'zh-TW': '實測+估算', en: 'Mixed Basis' },
  'session.trend.empty': { 'zh-CN': '当前会话暂无上下文趋势点，触发对话后自动生成.', 'zh-TW': '目前工作階段尚無上下文趨勢點，觸發對話後自動產生.', en: 'No context trend points recorded for this session yet.' },
  'session.trend.inspectHint': { 'zh-CN': '悬停或点击柱条核对当步上下文读数与下方请求明细.', 'zh-TW': '懸停或點擊長條核對當步上下文讀數與下方請求明細.', en: 'Hover or click a bar to inspect step tokens and sync with details below.' },
  'session.trend.inspectFmt': { 'zh-CN': '{label} · 上下文 {total} ({delta}) · 新输入 {inp} + 缓存 {cap}{model}', 'zh-TW': '{label} · 上下文 {total} ({delta}) · 新輸入 {inp} + 快取 {cap}{model}', en: '{label} · Context {total} ({delta}) · In {inp} + Cache {cap}{model}' },
  'session.trend.truncatedNote': { 'zh-CN': '仅展示最近 {shown}/{total} 步', 'zh-TW': '僅顯示最近 {shown}/{total} 步', en: 'Latest {shown}/{total}' },
  'session.trend.svgAria': { 'zh-CN': '上下文总量与增量趋势图', 'zh-TW': '上下文總量與增量趨勢圖', en: 'Context window total and delta trend chart' },
  'session.trend.legendInput': { 'zh-CN': '新增输入', 'zh-TW': '新增輸入', en: 'Input' },
  'session.trend.legendCache': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'session.trend.legendDeltaPos': { 'zh-CN': '净增长', 'zh-TW': '淨成長', en: 'Growth' },
  'session.trend.legendDeltaNeg': { 'zh-CN': '收缩/压缩', 'zh-TW': '收縮/壓縮', en: 'Shrink / Compact' },
  'session.timeline.maxJumpBadge': { 'zh-CN': '最大跃升', 'zh-TW': '最大躍升', en: 'Max Jump' },
  'session.timeline.deltaSummary': { 'zh-CN': '上下文净变化 {net} · 首帧 {init} → 最新 {latest}', 'zh-TW': '上下文淨變化 {net} · 首幀 {init} → 最新 {latest}', en: 'Context net {net} · Start {init} → Latest {latest}' },
  'session.timeline.timingEmpty': { 'zh-CN': '当前会话暂无可用的阶段耗时记录。', 'zh-TW': '目前工作階段暫無可用的階段耗時紀錄。', en: 'No phase timing metrics recorded for this session yet.' },
  'session.timeline.timingWall': { 'zh-CN': '累计活跃阶段耗时 {wall}（仅含推理与工具活跃窗口，不含人工空闲等待）', 'zh-TW': '累計活躍階段耗時 {wall}（僅含推論與工具活躍視窗，不含人工閒置等待）', en: 'Active phase total {wall} (inference & tool execution only; excludes idle gaps)' },
  'session.timeline.timingTtft': { 'zh-CN': '首字等待 TTFT', 'zh-TW': '首字等待 TTFT', en: 'Wait (TTFT)' },
  'session.timeline.timingStream': { 'zh-CN': '模型流式生成', 'zh-TW': '模型串流生成', en: 'Streaming Gen' },
  'session.timeline.timingTool': { 'zh-CN': '工具执行开销', 'zh-TW': '工具執行開銷', en: 'Tool Execution' },
  'session.timeline.filesEmpty': { 'zh-CN': '当前会话暂无可识别的文件读写或搜索工具记录。', 'zh-TW': '目前工作階段尚無可識別的檔案讀寫或搜尋工具紀錄。', en: 'No file read/write/search tool activity recorded yet.' },
  'session.timeline.filterAll': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'session.timeline.filterRead': { 'zh-CN': '读取', 'zh-TW': '讀取', en: 'Read' },
  'session.timeline.filterWrite': { 'zh-CN': '修改', 'zh-TW': '修改', en: 'Write' },
  'session.timeline.filterSearch': { 'zh-CN': '搜索', 'zh-TW': '搜尋', en: 'Search' },
  'session.timeline.fileSearchPh': { 'zh-CN': '按文件名或路径筛选…', 'zh-TW': '依檔名或路徑篩選…', en: 'Filter by path or filename…' },
  'session.timeline.commandsEmpty': { 'zh-CN': '当前会话暂无命令执行记录。', 'zh-TW': '目前工作階段尚無命令執行紀錄。', en: 'No command executions recorded yet.' },
  'session.timeline.filterFailed': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'session.timeline.filterSlow': { 'zh-CN': '慢命令(≥5s)', 'zh-TW': '慢命令(≥5s)', en: 'Slow(≥5s)' },
  'session.timeline.filterBg': { 'zh-CN': '后台', 'zh-TW': '背景', en: 'Background' },
  'session.timeline.cmdSearchPh': { 'zh-CN': '按程序或命令关键字筛选…', 'zh-TW': '依程式或命令關鍵字篩選…', en: 'Filter by program or command…' },
  'session.timeline.fleetSummary': { 'zh-CN': '主会话独占 {main} tok · 家族总计 {fleet} tok（已去重校验，绝不重复计算）', 'zh-TW': '主工作階段獨佔 {main} tok · 家族總計 {fleet} tok（已去重校驗，絕不重複計算）', en: 'Main only {main} tok · Fleet total {fleet} tok (deduplicated)' },
  'session.timeline.fleetMain': { 'zh-CN': '主会话自身', 'zh-TW': '主工作階段自身', en: 'Primary Session' },
  'session.timeline.fleetCollabTitle': { 'zh-CN': '主子协作时间线 ({n})', 'zh-TW': '主子協作時間線 ({n})', en: 'Agent Collaboration Timeline ({n})' },
  'session.timeline.fleetTasksTitle': { 'zh-CN': '任务与调度记录 ({n} · 宿主暂未提供任务依赖 DAG)', 'zh-TW': '任務與排程紀錄 ({n} · 宿主暫未提供任務依賴 DAG)', en: 'Tasks & Schedules ({n} · Host omits dependency DAG)' },
  'session.timeline.fleetTasksEmpty': { 'zh-CN': '当前会话暂无显式任务或调度工具记录。', 'zh-TW': '目前工作階段尚無顯式任務或排程工具紀錄。', en: 'No explicit task or schedule tool calls recorded.' },
  'session.timeline.fleetUnlinked': { 'zh-CN': '存在 {n} 次父级步骤不明确的子代理调用（已独立归类，未混入主会话或已归因列表）。', 'zh-TW': '存在 {n} 次父步驟不明確的子代理呼叫（已獨立歸類，未混入主工作階段或已歸因清單）。', en: '{n} unlinked subagent call(s) preserved separately without guessing parent.' },
  'session.timeline.modelBreakdownTitle': { 'zh-CN': '按实际执行模型汇总（已去重校验，与请求明细一致）', 'zh-TW': '依實際執行模型彙總（已去重校驗，與請求明細一致）', en: 'By Model (Deduplicated, Matches Call Log)' },
  'session.timeline.unknownModel': { 'zh-CN': '未知模型', 'zh-TW': '未知模型', en: 'Unknown Model' },
  'session.timeline.modelTotalsLine': { 'zh-CN': '会话合计 {calls} 次 · {total} tok（入 {inp} / 缓 {cap} / 出 {out}）', 'zh-TW': '工作階段合計 {calls} 次 · {total} tok（入 {inp} / 快 {cap} / 出 {out}）', en: 'Session total {calls} calls · {total} tok (In {inp} / Cache {cap} / Out {out})' },
  'tokens.heat.title': { 'zh-CN': 'Token 活动', 'zh-TW': 'Token 活動', en: 'Token Activity' },
  'tokens.heat.daily': { 'zh-CN': '每天', 'zh-TW': '每天', en: 'Daily' },
  'tokens.heat.weekly': { 'zh-CN': '每周', 'zh-TW': '每週', en: 'Weekly' },
  'tokens.heat.monthly': { 'zh-CN': '每月', 'zh-TW': '每月', en: 'Monthly' },
  'tokens.heat.yearly': { 'zh-CN': '今年', 'zh-TW': '今年', en: 'Year' },
  'tokens.heat.cum': { 'zh-CN': '累计总量', 'zh-TW': '累計總量', en: 'Cumulative' },
  'tokens.heat.sumTokens': { 'zh-CN': '区间合计:', 'zh-TW': '區間合計:', en: 'Range total:' },
  'tokens.heat.sumCost': { 'zh-CN': '预估费用:', 'zh-TW': '預估費用:', en: 'Est. cost:' },
  'tokens.heat.sumDailyAvg': { 'zh-CN': '折合每天:', 'zh-TW': '折合每天:', en: 'Daily avg:' },
  'tokens.heat.sumActiveAvg': { 'zh-CN': '活跃日均:', 'zh-TW': '活躍日均:', en: 'Active avg:' },
  'tokens.heat.sumSubRatio': { 'zh-CN': '订阅性价比:', 'zh-TW': '訂閱性價比:', en: 'Plan value:' },
  'tokens.heat.disclaimer': { 'zh-CN': '注：按日聚合按基础档估算，未拆分长上下文分档，结果偏下限。有逐请求记录时优先精确入账。', 'zh-TW': '註：按日彙總依基礎檔估算，未拆分長上下文分檔，結果偏下限。有逐請求記錄時優先精確入帳。', en: 'Note: Daily aggregates use base tier pricing (lower bound) unless per-request records are available.' },
  'tokens.heat.tip': { 'zh-CN': '点击或悬浮格子查看当日详细 Token 构成', 'zh-TW': '點擊或懸停格子查看當日詳細 Token 結構', en: 'Click or hover a cell to view daily token breakdown' },
  'tokens.heat.less': { 'zh-CN': '少', 'zh-TW': '少', en: 'Less' },
  'tokens.heat.more': { 'zh-CN': '多', 'zh-TW': '多', en: 'More' },
  'tokens.heat.unactivatedTip': { 'zh-CN': '未开启记录', 'zh-TW': '未開啟紀錄', en: 'Before first record' },
  'tokens.heat.futureTip': { 'zh-CN': '未来日期', 'zh-TW': '未來日期', en: 'Future' },
  'tokens.heat.peakBadge': { 'zh-CN': '峰值', 'zh-TW': '峰值', en: 'Peak' },
  'tokens.heat.cumDeltaLbl': { 'zh-CN': '当日增量', 'zh-TW': '當日增量', en: 'Daily' },
  'tokens.heat.cumTotalLbl': { 'zh-CN': '截止累计', 'zh-TW': '截止累計', en: 'Cumulative' },
  'tokens.cum.daysMeta': { 'zh-CN': '{start} – {end} · {total} 天', 'zh-TW': '{start} – {end} · {total} 天', en: '{start} – {end} · {total}d' },
  'tokens.cum.activeMeta': { 'zh-CN': '活跃 {active} 天 · 0 用量 {zero} 天', 'zh-TW': '活躍 {active} 天 · 0 用量 {zero} 天', en: '{active} active · {zero} zero' },
  'tokens.cum.recordDaysShort': { 'zh-CN': '记录 {total} 天', 'zh-TW': '紀錄 {total} 天', en: 'Recorded {total}d' },
  'tokens.cum.rulerLabel': { 'zh-CN': '跨账号量级尺', 'zh-TW': '跨帳號量級尺', en: 'Magnitude' },
  'tokens.cum.belowMin': { 'zh-CN': '<10M ({val})', 'zh-TW': '<10M ({val})', en: '<10M ({val})' },
  'tokens.cum.aboveMax': { 'zh-CN': '>100B ({val})', 'zh-TW': '>100B ({val})', en: '>100B ({val})' },
  'tokens.cum.zeroVal': { 'zh-CN': '0 用量', 'zh-TW': '0 用量', en: '0 Tokens' },
  'tokens.cum.zeroDayBadge': { 'zh-CN': '0 用量', 'zh-TW': '0 用量', en: '0 Tokens' },
  'tokens.cum.peakSpanFmt': { 'zh-CN': '高峰 {range} 占 {pct}%', 'zh-TW': '高峰 {range} 佔 {pct}%', en: 'Peak {range} ({pct}%)' },
  'tokens.cum.concLine': { 'zh-CN': '50% 用量集中在 {start} – {end}（{n} 天 · 占 {pct}%）', 'zh-TW': '50% 用量集中在 {start} – {end}（{n} 天 · 佔 {pct}%）', en: '50% usage in {start} – {end} ({n}d · {pct}%)' },
  'tokens.cum.concInsufficient': { 'zh-CN': '记录不足 7 天，暂不计算集中度', 'zh-TW': '紀錄不足 7 天，暫不計算集中度', en: 'Under 7 days; concentration omitted' },
  'tokens.cum.peakDayFmt': { 'zh-CN': '峰值 {date} {val} ({pct}%)', 'zh-TW': '峰值 {date} {val} ({pct}%)', en: 'Peak {date} {val} ({pct}%)' },
  'tokens.cum.peakWeekFmt': { 'zh-CN': '峰值周 {range} {val} ({pct}%)', 'zh-TW': '峰值週 {range} {val} ({pct}%)', en: 'Peak wk {range} {val} ({pct}%)' },
  'tokens.cum.emptyTitle': { 'zh-CN': '当前区间暂无 Token 用量记录', 'zh-TW': '目前區間尚無 Token 用量紀錄', en: 'No token usage in this interval' },
  'tokens.cum.emptySub': { 'zh-CN': '共 {days} 天 · 0 用量 {days} 天', 'zh-TW': '共 {days} 天 · 0 用量 {days} 天', en: '{days} days · {days} zero' },
  'tokens.cum.shareLbl': { 'zh-CN': '占比', 'zh-TW': '佔比', en: 'Share' },
  'tokens.cum.locateDaily': { 'zh-CN': '定位到「每天」', 'zh-TW': '定位至「每天」', en: 'Locate in Daily' },
  'tokens.cum.clearLock': { 'zh-CN': '取消 (Esc)', 'zh-TW': '取消 (Esc)', en: 'Clear (Esc)' },
  'tokens.cum.expandDays': { 'zh-CN': '展开日明细 ({n}天)', 'zh-TW': '展開日明細 ({n}天)', en: 'Show {n} days' },
  'tokens.cum.collapseDays': { 'zh-CN': '收起日明细', 'zh-TW': '收合日明細', en: 'Hide days' },
  'tokens.cum.weekGroupHint': { 'zh-CN': '按 7 天分组 ({n} 段)', 'zh-TW': '依 7 天分組 ({n} 段)', en: 'Grouped 7d ({n} segs)' },
  'tokens.cum.weekSumLbl': { 'zh-CN': '周增量', 'zh-TW': '週增量', en: 'Weekly' },
  'tokens.colors.title': { 'zh-CN': '🎨 热力图色阶与面板外观自定义', 'zh-TW': '🎨 熱力圖色階與面板外觀自訂', en: '🎨 Heatmap Palette & Panel Appearance' },
  'tokens.update.title': { 'zh-CN': '更新设置', 'zh-TW': '更新設定', en: 'Update Settings' },
  'tokens.update.auto': { 'zh-CN': '启动时自动检查更新但不自动安装', 'zh-TW': '啟動時自動檢查更新但不自動安裝', en: 'Check for updates on startup manually' },
  'tokens.update.allowBeta': { 'zh-CN': '接收 Beta 通道预发布版本推送', 'zh-TW': '接收 Beta 通道預發布版本推送', en: 'Receive Beta pre-release updates' },
  'header.versionBtn.title': { 'zh-CN': '点击跳转到版本更新与关于设置', 'zh-TW': '點擊跳轉到版本更新與關於設定', en: 'Click to open version updates & about settings' },
  'settings.appearance.title': { 'zh-CN': '🎨 外观、停靠位置与顶栏偏好', 'zh-TW': '🎨 外觀、停靠位置與頂欄偏好', en: '🎨 Appearance, Dock & Topbar Preferences' },
  'settings.quickMenu.label': { 'zh-CN': '上下文快捷菜单样式', 'zh-TW': '上下文捷徑選單樣式', en: 'Context Quick Menu Style' },
  'settings.quickMenu.aria': { 'zh-CN': '上下文快捷菜单样式', 'zh-TW': '上下文捷徑選單樣式', en: 'Context quick menu style' },
  'settings.quickMenu.floating': { 'zh-CN': '悬浮圆环', 'zh-TW': '懸浮圓環', en: 'Floating Orb' },
  'settings.quickMenu.floatingDesc': { 'zh-CN': '窗口内可拖拽上下文悬浮球，点击按外向内虚化汇聚展开 360° 六瓣径向菜单.', 'zh-TW': '視窗內可拖曳上下文懸浮球，點擊由外向內對焦匯聚展開 360° 六瓣徑向選單.', en: 'Draggable context orb with 360° six-petal inward blur-converging radial menu.' },
  'settings.quickMenu.topbar': { 'zh-CN': '顶栏贴边', 'zh-TW': '頂欄貼邊', en: 'Topbar Fan' },
  'settings.quickMenu.topbarDesc': { 'zh-CN': '挂载在顶栏上下文圆环，点击向下展开 180° 径向扇形入口.', 'zh-TW': '掛載於頂欄上下文圓環，點擊向下展開 180° 徑向扇形入口.', en: 'Anchored to the topbar context ring, expanding a downward 180° radial fan.' },
  'settings.quickMenu.bottombar': { 'zh-CN': '底栏贴边', 'zh-TW': '底欄貼邊', en: 'Bottom Fan' },
  'settings.quickMenu.bottombarDesc': { 'zh-CN': '挂载在输入框下方状态条，点击向上展开 180° 径向扇形入口.', 'zh-TW': '掛載於輸入框下方狀態列，點擊向上展開 180° 徑向扇形入口.', en: 'Anchored to the composer status bar, expanding an upward 180° radial fan.' },
  'settings.quickMenu.classic': { 'zh-CN': '经典列表', 'zh-TW': '經典清單', en: 'Classic List' },
  'settings.quickMenu.classicDesc': { 'zh-CN': '保留经典竖排切换列表与原位直开体验.', 'zh-TW': '保留經典直排切換清單與原位直開體驗.', en: 'Keeps the classic vertical switcher menu and direct click behavior.' },
  'settings.quickMenu.hideOrb': { 'zh-CN': '隐藏悬浮圆球', 'zh-TW': '隱藏懸浮圓球', en: 'Hide Floating Orb' },
  'settings.quickMenu.hideOrbDesc': { 'zh-CN': '隐藏窗口内的上下文悬浮圆球；也可右键悬浮球快捷隐藏，随时从顶栏菜单或此处恢复.', 'zh-TW': '隱藏視窗內的上下文懸浮圓球；亦可右鍵懸浮球快速隱藏，隨時從頂欄選單或此處恢復.', en: 'Hide the floating context orb; you can also right-click the orb to hide it and restore it anytime from the topbar menu or here.' },
  'settings.groups.openMode': { 'zh-CN': '看板打开方式', 'zh-TW': '看板開啟方式', en: 'How the dashboard opens' },
  'settings.groups.radial': { 'zh-CN': '径向快捷菜单 · 可多选共存', 'zh-TW': '徑向捷徑選單 · 可多選共存', en: 'Radial quick menu · combine freely' },
  'settings.groups.display': { 'zh-CN': '页面常驻显示', 'zh-TW': '頁面常駐顯示', en: 'Always-on page display' },
  'settings.groups.theme': { 'zh-CN': '主题与外观定制', 'zh-TW': '主題與外觀自訂', en: 'Theme and appearance' },
  'settings.quickActions.title': { 'zh-CN': '当前会话快捷操作条', 'zh-TW': '目前會話快捷操作列', en: 'Current session shortcut bar' },
  'settings.quickActions.desc': { 'zh-CN': '一行完成打开、复制与跳转，同一入口不再重复.', 'zh-TW': '一列完成開啟、複製與跳轉，同一入口不再重複.', en: 'Open, copy and jump in one compact row with no duplicate entry.' },
  'settings.radial.orb.title': { 'zh-CN': '悬浮圆环', 'zh-TW': '懸浮圓環', en: 'Floating orb' },
  'settings.radial.orb.desc': { 'zh-CN': '窗口顶层可拖拽悬浮球，点击展开 360° 六瓣花环.', 'zh-TW': '視窗頂層可拖曳懸浮球，點擊展開 360° 六瓣花環.', en: 'Draggable orb on the top layer; click to open the 360° six-petal ring.' },
  'settings.radial.topbar.title': { 'zh-CN': '顶栏径向展开', 'zh-TW': '頂欄徑向展開', en: 'Topbar radial fan' },
  'settings.radial.topbar.desc': { 'zh-CN': '点击顶栏上下文圆环原地收缩为正圆并向下展开 180° 扇形.', 'zh-TW': '點擊頂欄上下文圓環原地收縮為正圓並向下展開 180° 扇形.', en: 'Click the topbar context ring to collapse in place and fan out 180° downward.' },
  'settings.radial.bottombar.title': { 'zh-CN': '底栏径向展开', 'zh-TW': '底欄徑向展開', en: 'Bottom radial fan' },
  'settings.radial.bottombar.desc': { 'zh-CN': '点击输入框下方上下文入口原地收缩为正圆并向上展开 180° 扇形.', 'zh-TW': '點擊輸入框下方上下文入口原地收縮為正圓並向上展開 180° 扇形.', en: 'Click the context entry under the composer to collapse in place and fan out 180° upward.' },
  'settings.topbarMode.label': { 'zh-CN': '顶栏状态条', 'zh-TW': '頂欄狀態列', en: 'Topbar status bar' },
  'settings.topbarMode.full': { 'zh-CN': '完整显示', 'zh-TW': '完整顯示', en: 'Full' },
  'settings.topbarMode.fullDesc': { 'zh-CN': '会话顶栏完整显示上下文、额度、速度与 Token 状态入口.', 'zh-TW': '會話頂欄完整顯示上下文、額度、速度與 Token 狀態入口.', en: 'Full metrics entries displayed in conversation topbar.' },
  'settings.topbarMode.compact': { 'zh-CN': '精简圆环', 'zh-TW': '精簡圓環', en: 'Compact Ring' },
  'settings.topbarMode.compactDesc': { 'zh-CN': '会话顶栏仅显示精简圆环入口，节省空间.', 'zh-TW': '會話頂欄僅顯示精簡圓環入口，節省空間.', en: 'Compact ring entry displayed in conversation topbar.' },
  'settings.topbarMode.hidden': { 'zh-CN': '隐藏', 'zh-TW': '隱藏', en: 'Hidden' },
  'settings.topbarMode.hiddenDesc': { 'zh-CN': '顶栏不渲染常态入口，可通过悬浮球或底栏打开面板.', 'zh-TW': '頂欄不渲染常態入口，可透過懸浮球或底欄開啟面板.', en: 'Topbar entry hidden; open panels via floating orb or bottom bar.' },
  'settings.panelDockMode.label': { 'zh-CN': '面板显示位置', 'zh-TW': '面板顯示位置', en: 'Panel Display Position' },
  'settings.panelDockMode.popover': { 'zh-CN': '顶栏浮层', 'zh-TW': '頂欄浮層', en: 'Topbar Popover' },
  'settings.panelDockMode.popoverDesc': { 'zh-CN': '点击顶栏或悬浮球时以浮动弹窗展开详情面板.', 'zh-TW': '點擊頂欄或懸浮球時以浮動彈窗展開詳情面板.', en: 'Open details panel as floating popover window.' },
  'settings.panelDockMode.aux': { 'zh-CN': '右侧辅助栏', 'zh-TW': '右側輔助欄', en: 'Right Aux Panel' },
  'settings.panelDockMode.auxDesc': { 'zh-CN': '固定停靠在右侧辅助栏，与主编辑区并排并实时跟随.', 'zh-TW': '固定停靠在右側輔助欄，與主編輯區並排並即時跟隨.', en: 'Docked in right auxiliary panel alongside editor view.' },
  'settings.panelDockMode.page': { 'zh-CN': '独立页面', 'zh-TW': '獨立頁面', en: 'Standalone Page' },
  'settings.panelDockMode.pageDesc': { 'zh-CN': '以独立全宽页面展开详情面板，可一键返回聊天.', 'zh-TW': '以獨立全寬頁面展開詳情面板，可一鍵返回聊天.', en: 'Full-page standalone view, return to chat anytime.' },
  'settings.autoHideTopbarDocked.label': { 'zh-CN': '侧栏或独立页展开时收起顶栏', 'zh-TW': '側欄或獨立頁展開時收起頂欄', en: 'Hide topbar while the side panel or page is open' },
  'settings.autoHideTopbarDocked.desc': { 'zh-CN': '面板停靠在右侧栏或独立页时自动藏起顶栏入口，收起面板后恢复.', 'zh-TW': '面板停靠在右側欄或獨立頁時自動藏起頂欄入口，收起面板後恢復.', en: 'The topbar entry hides itself while the docked panel is open and returns once it closes.' },
  'settings.dock.label': { 'zh-CN': '面板与顶栏停靠位置', 'zh-TW': '面板與頂欄停靠位置', en: 'Panel & Topbar Dock Position' },
  'settings.dock.flow': { 'zh-CN': '常态', 'zh-TW': '常態', en: 'Standard' },
  'settings.dock.flowDesc': { 'zh-CN': '会话工具栏内完整显示上下文、额度、速度与 Token 状态入口.', 'zh-TW': '會話工具列內完整顯示上下文、額度、速度與 Token 狀態入口.', en: 'Full metrics entries displayed in conversation toolbar.' },
  'settings.dock.compact': { 'zh-CN': '缩略', 'zh-TW': '縮略', en: 'Compact' },
  'settings.dock.compactDesc': { 'zh-CN': '会话工具栏精简为额度圆环、上下文圆环与更多入口，靠在 ⋮ 左侧.', 'zh-TW': '會話工具列精簡為額度圓環、上下文圓環與更多入口，靠在 ⋮ 左側.', en: 'Three compact icons in conversation toolbar, left of ⋮.' },
  'settings.dock.aux': { 'zh-CN': '右侧辅助面板', 'zh-TW': '右側輔助面板', en: 'Aux Sidebar' },
  'settings.dock.auxDesc': { 'zh-CN': '在右侧辅助分栏中显示当前会话详情；未展开时平滑停靠工具栏.', 'zh-TW': '在右側輔助分欄中顯示當前會話詳情；未展開時平滑停靠工具列.', en: 'Display session details in auxiliary sidebar; dock in toolbar if collapsed.' },
  'settings.dock.page': { 'zh-CN': '独立页面', 'zh-TW': '獨立頁面', en: 'Standalone' },
  'settings.dock.pageDesc': { 'zh-CN': '完整整页独立监控看板，支持在编辑区或外部浏览器中打开.', 'zh-TW': '完整整頁獨立監控看板，支援在編輯區或外部瀏覽器中開啟.', en: 'Full-page standalone dashboard, openable in editor or browser.' },
  'settings.dock.exitPage': { 'zh-CN': '返回聊天', 'zh-TW': '返回聊天', en: 'Back to Chat' },
  'settings.dock.exitPageTitle': { 'zh-CN': '退出独立页面，返回常规聊天', 'zh-TW': '結束獨立頁面，返回常規聊天', en: 'Exit standalone page, return to chat' },
  'settings.dock.hideTopbar': { 'zh-CN': '隐藏顶栏主入口', 'zh-TW': '隱藏頂欄主入口', en: 'Hide Topbar Units' },
  'settings.dock.hideTopbarDesc': { 'zh-CN': '隐藏顶栏主入口并保留轻量唤醒按钮，底部状态条保持显示.', 'zh-TW': '隱藏頂欄主入口並保留輕量喚醒按鈕，底部狀態列維持顯示.', en: 'Hide topbar entries, keeping wake button only while composer bar stays visible.' },
  'settings.dock.openInBrowser': { 'zh-CN': '在浏览器打开', 'zh-TW': '在瀏覽器開啟', en: 'Open in Browser' },
  'settings.dock.openRightAria': { 'zh-CN': '在右侧打开当前会话', 'zh-TW': '在右側開啟目前工作階段', en: 'Open current session on right' },
  'settings.dock.openRightTitle': { 'zh-CN': '在右侧辅助栏打开当前会话并复制链接', 'zh-TW': '在右側輔助欄開啟目前工作階段並複製連結', en: 'Open current session in right sidebar and copy link' },
  'settings.dock.openRightBtn': { 'zh-CN': '在右侧打开', 'zh-TW': '在右側開啟', en: 'Open on Right' },
  'settings.dock.openExternalBtn': { 'zh-CN': '外部浏览器', 'zh-TW': '外部瀏覽器', en: 'External' },
  'settings.dock.pageHint': { 'zh-CN': '独立页面已开启，可使用顶部“返回聊天”切回常驻工具栏.', 'zh-TW': '獨立頁面已開啟，可使用頂部「返回聊天」切回常駐工具列.', en: 'Standalone view active; use top "Back to Chat" to return.' },
  'settings.turnFooter.label': { 'zh-CN': '每轮回复尾部统计', 'zh-TW': '每輪回覆尾部統計', en: 'Per-turn footer stats' },
  'settings.turnFooter.desc': { 'zh-CN': '在助手回复操作栏末尾显示本轮模型、用量与耗时微标.', 'zh-TW': '在助手回覆操作列末尾顯示本輪模型、用量與耗時微標.', en: 'Show this turn model, usage and duration chip at the end of the assistant action bar.' },
  'settings.composerQuota.label': { 'zh-CN': '输入框下方状态条', 'zh-TW': '輸入框下方狀態列', en: 'Status bar under the composer' },
  'settings.composerQuota.desc': { 'zh-CN': '在聊天输入框下方显示速度、Token、上下文与额度摘要.', 'zh-TW': '在聊天輸入框下方顯示速度、Token、上下文與額度摘要.', en: 'Show speed, tokens, context and quota summary below the chat composer.' },
  'composer.quotaAria': { 'zh-CN': '当前模型池额度与消耗节奏摘要', 'zh-TW': '目前模型池額度與消耗節奏摘要', en: 'Current pool quota & consumption pace summary' },
  'settings.dock.fallbackAux': { 'zh-CN': '右侧辅助栏当前未展开. 点击此处可立即展开并挂载.', 'zh-TW': '右側輔助欄目前未展開. 點擊此處可立即展開並掛載.', en: 'Auxiliary sidebar is currently collapsed. Click here to expand and mount.' },
  'settings.dock.fallbackPage': { 'zh-CN': '已在本地启动独立页面服务. 点击右侧按钮可在浏览器中打开.', 'zh-TW': '已在本地啟動獨立頁面服務. 點擊右側按鈕可在瀏覽器中開啟.', en: 'Standalone service active. Click button to open in browser.' },
  'settings.dock.auxBack': { 'zh-CN': '返回顶栏', 'zh-TW': '返回頂欄', en: 'Back to Topbar' },
  'settings.dock.auxBackTitle': { 'zh-CN': '退出右侧停靠，返回顶部工具栏', 'zh-TW': '結束右側停靠，返回頂部工具列', en: 'Undock right sidebar and return to top toolbar' },
  'settings.dock.auxCopyUrl': { 'zh-CN': '复制链接', 'zh-TW': '複製連結', en: 'Copy URL' },
  'settings.dock.auxExternal': { 'zh-CN': '外部浏览器', 'zh-TW': '外部瀏覽器', en: 'External' },
  'settings.dock.auxFollowing': { 'zh-CN': '已随焦点定位 · {role} {id}', 'zh-TW': '已隨焦點定位 · {role} {id}', en: 'Following {role} · {id}' },
  'settings.dock.auxUnresolved': { 'zh-CN': '未识别到当前会话 · 列表模式', 'zh-TW': '未識別到目前工作階段 · 清單模式', en: 'Session ID unavailable · List view' },
  'settings.dock.auxRoleMain': { 'zh-CN': '主会话', 'zh-TW': '主工作階段', en: 'Main' },
  'settings.dock.auxRoleSplit': { 'zh-CN': '分屏会话', 'zh-TW': '分屏工作階段', en: 'Split' },
  'settings.dock.auxRoleSideChat': { 'zh-CN': 'Side Chat', 'zh-TW': 'Side Chat', en: 'Side Chat' },
  'settings.dock.fbCopyUrl': { 'zh-CN': '复制链接', 'zh-TW': '複製連結', en: 'Copy Link' },
  'settings.dock.fbOpenExternal': { 'zh-CN': '在外部浏览器打开', 'zh-TW': '在外部瀏覽器開啟', en: 'Open External Browser' },
  'settings.dock.fbPage': { 'zh-CN': '独立页面', 'zh-TW': '獨立頁面', en: 'Standalone' },
  'settings.dock.openRightOk': { 'zh-CN': '已在右侧辅助栏定位 {role} · {id}，{copyNote}.', 'zh-TW': '已在右側輔助欄定位 {role} · {id}，{copyNote}.', en: 'Opened {role} · {id} in right sidebar; {copyNote}.' },
  'settings.dock.openRightFallback': { 'zh-CN': '右侧辅助栏未能展开，已保留悬浮详情，{copyNote}. 可用下方外部浏览器或独立页面查看.', 'zh-TW': '右側輔助欄未能展開，已保留懸浮詳情，{copyNote}. 可用下方外部瀏覽器或獨立頁面檢視.', en: 'Right sidebar failed to expand, kept floating panel; {copyNote}. Use External Browser or Standalone Page below.' },
  'settings.dock.openRightNoSession': { 'zh-CN': '未识别到当前会话，已打开看板列表，{copyNote}.', 'zh-TW': '未識別到目前工作階段，已開啟看板清單，{copyNote}.', en: 'Active session ID not resolved, opened dashboard list; {copyNote}.' },
  'settings.dock.openRightCopied': { 'zh-CN': '已复制链接', 'zh-TW': '已複製連結', en: 'link copied' },
  'settings.dock.openRightCopiedSession': { 'zh-CN': '会话链接已复制', 'zh-TW': '工作階段連結已複製', en: 'session link copied' },
  'settings.dock.openRightCopiedList': { 'zh-CN': '看板链接已复制', 'zh-TW': '看板連結已複製', en: 'dashboard link copied' },
  'settings.dock.openRightCopyFail': { 'zh-CN': '链接复制失败，请手动复制', 'zh-TW': '連結複製失敗，請手動複製', en: 'copy failed, please copy manually below' },
  'settings.dock.openRightManualCopyOk': { 'zh-CN': '会话链接已复制 · {url}', 'zh-TW': '工作階段連結已複製 · {url}', en: 'Session link copied · {url}' },
  'settings.dock.openRightManualListCopyOk': { 'zh-CN': '看板链接已复制 · {url}', 'zh-TW': '看板連結已複製 · {url}', en: 'Dashboard link copied · {url}' },
  'settings.dock.openRightManualCopyFail': { 'zh-CN': '链接复制失败：{url}', 'zh-TW': '連結複製失敗：{url}', en: 'Copy failed: {url}' },
  'settings.dock.openStandaloneNotReady': { 'zh-CN': '独立看板服务未就绪，无法打开外部浏览器.', 'zh-TW': '獨立看板服務未就緒，無法開啟外部瀏覽器.', en: 'Standalone dashboard service not ready; cannot open browser.' },
  'settings.dock.openStandaloneSessionOk': { 'zh-CN': '已在外部浏览器打开当前会话 · {id}', 'zh-TW': '已在外部瀏覽器開啟目前工作階段 · {id}', en: 'Opened current session in external browser · {id}' },
  'settings.dock.openStandaloneListOk': { 'zh-CN': '未识别到当前会话，已在外部浏览器打开看板列表.', 'zh-TW': '未識別到目前工作階段，已在外部瀏覽器開啟看板清單.', en: 'Session ID unavailable; opened dashboard list in external browser.' },
  'settings.dock.wakeAria': { 'zh-CN': '唤醒插件菜单与设置', 'zh-TW': '喚醒外掛選單與設定', en: 'Open extension menu and settings' },
  'settings.dock.wakeTitle': { 'zh-CN': '顶栏已隐藏 · 点击打开快捷菜单或恢复显示', 'zh-TW': '頂欄已隱藏 · 點擊開啟捷徑選單或恢復顯示', en: 'Topbar hidden · Click to open menu or restore' },
  'settings.quickSettings': { 'zh-CN': '⚙️ 配置', 'zh-TW': '⚙️ 設定', en: '⚙️ Settings' },
  'settings.backToSession': { 'zh-CN': '‹ 返回会话', 'zh-TW': '‹ 返回會話', en: '‹ Back to Session' },
  'settings.nav.appearance': { 'zh-CN': '🎨 外观与停靠', 'zh-TW': '🎨 外觀與停靠', en: '🎨 Appearance & Dock' },
  'settings.nav.preset': { 'zh-CN': '✨ 推荐配置', 'zh-TW': '✨ 推薦配置', en: '✨ Presets' },
  'settings.nav.rehydrate': { 'zh-CN': '🧠 压缩与恢复', 'zh-TW': '🧠 壓縮與恢復', en: '🧠 Rehydrate' },
  'settings.nav.proxy': { 'zh-CN': '🌐 免 TUN 代理', 'zh-TW': '🌐 免 TUN 代理', en: '🌐 Proxy' },
  'settings.nav.palette': { 'zh-CN': '🎨 主题调色', 'zh-TW': '🎨 佈景調色', en: '🎨 Palette' },
  'settings.nav.update': { 'zh-CN': '📦 版本通道', 'zh-TW': '📦 版本通道', en: '📦 Updates' },
  'badge.compactQuotaTip': { 'zh-CN': '模型剩余额度看板 · 点击打开', 'zh-TW': '模型剩餘額度看板 · 點擊開啟', en: 'Model Quota Dashboard · Click to open' },
  'badge.compactContextTip': { 'zh-CN': '会话上下文看板 · 点击打开', 'zh-TW': '會話上下文看板 · 點擊開啟', en: 'Context Dashboard · Click to open' },
  'badge.compactOverflowTip': { 'zh-CN': '插件快捷功能与设置 · 点击打开', 'zh-TW': '外掛捷徑功能與設定 · 點擊開啟', en: 'Plugin Menu & Settings · Click to open' },
  'settings.quotaBadgeMode.label': { 'zh-CN': '顶栏额度窗口', 'zh-TW': '頂欄額度視窗', en: 'Topbar quota window' },
  'settings.quotaBadgeMode.desc': { 'zh-CN': '支持右键或 Alt 加点击切换.', 'zh-TW': '支援右鍵或 Alt 加點擊切換.', en: 'Right-click or Alt plus click to cycle.' },
  'settings.quotaBadgeMode.auto': { 'zh-CN': '自动最紧缩', 'zh-TW': '自動最緊縮', en: 'Auto Tightest' },
  'settings.quotaBadgeMode.5h': { 'zh-CN': '5h 窗口', 'zh-TW': '5h 視窗', en: '5h Window' },
  'settings.quotaBadgeMode.weekly': { 'zh-CN': '周额度', 'zh-TW': '週額度', en: 'Weekly' },
  'settings.quotaBadgeMode.both': { 'zh-CN': '5h 与周双显', 'zh-TW': '5h 與週雙顯', en: 'Dual 5h and 7d' },
  'settings.langAndPalette.label': { 'zh-CN': '面板语言与主题调色', 'zh-TW': '面板語言與佈景調色', en: 'Panel Language & Palette' },
  'settings.palette.label': { 'zh-CN': '主题配色与外观定制', 'zh-TW': '主題配色與外觀自訂', en: 'Theme colors & appearance' },
  'settings.palette.desc': { 'zh-CN': '打开调色面板调整主色调、面板明暗与图表色阶.', 'zh-TW': '開啟調色面板調整主色調、面板明暗與圖表色階.', en: 'Open the palette to tune accent color, panel tone and chart scale.' },
  'settings.palette.openBtn': { 'zh-CN': '🎨 调色与外观', 'zh-TW': '🎨 調色與外觀', en: '🎨 Colors & Theme' },
  'settings.aboutUpdate.title': { 'zh-CN': '🔄 版本更新与项目链接', 'zh-TW': '🔄 版本更新與專案連結', en: '🔄 Updates & Project Links' },
  'settings.aboutUpdate.channelTitle': { 'zh-CN': '🔄 版本更新通道与设置', 'zh-TW': '🔄 版本更新通道與設定', en: '🔄 Update Channel & Preferences' },
  'settings.aboutUpdate.checkBtn': { 'zh-CN': '检查插件更新', 'zh-TW': '檢查外掛更新', en: 'Check Updates' },
  'settings.aboutUpdate.githubBtn': { 'zh-CN': '打开 GitHub 仓库', 'zh-TW': '開啟 GitHub 儲存庫', en: 'GitHub Repo' },
  'quota.modeTag.auto': { 'zh-CN': '自动最紧缩', 'zh-TW': '自動最緊縮', en: 'Auto Tightest' },
  'quota.modeTag.5h': { 'zh-CN': '固定 5h', 'zh-TW': '固定 5h', en: 'Fixed 5h' },
  'quota.modeTag.weekly': { 'zh-CN': '固定周额度', 'zh-TW': '固定週額度', en: 'Fixed Weekly' },
  'quota.modeTag.both': { 'zh-CN': '5h + 7d 双显', 'zh-TW': '5h + 7d 雙顯', en: 'Dual 5h + 7d' },
  'badge.speedWaitTitle': { 'zh-CN': '正在等待模型首字响应 · 已等待 {elapsed}', 'zh-TW': '正在等待模型首字回應 · 已等待 {elapsed}', en: 'Waiting for first token · {elapsed}' },
  'cp.title': { 'zh-CN': '🎨 颜色选取器', 'zh-TW': '🎨 顏色選擇器', en: '🎨 Color Picker' },
  'cp.eyedropper': { 'zh-CN': '🖊 取色', 'zh-TW': '🖊 滴管取色', en: '🖊 Pick' },
  'cp.moreFormats': { 'zh-CN': '更多格式 (RGB / HSL)', 'zh-TW': '更多格式 (RGB / HSL)', en: 'More formats (RGB / HSL)' },
  'cp.hint': { 'zh-CN': '支持直接输入或粘贴 HEX 色值', 'zh-TW': '支援直接輸入或貼上 HEX 色碼', en: 'Type or paste a HEX color value' },
  'cp.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨佈景主題', en: 'Follow Theme' },
  'colors.btn.restore': { 'zh-CN': '恢复', 'zh-TW': '還原', en: 'Reset' },
  'colors.btn.preset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
  'colors.btn.restorePreset': { 'zh-CN': '恢复预设', 'zh-TW': '還原預設', en: 'Reset Preset' },
  'colors.btn.restoreDefault': { 'zh-CN': '恢复默认', 'zh-TW': '還原預設', en: 'Default' },
  'theme.light': { 'zh-CN': '浅色', 'zh-TW': '淺色', en: 'Light' },
  'theme.dark': { 'zh-CN': '深色', 'zh-TW': '深色', en: 'Dark' },
  'theme.autoTitle': { 'zh-CN': '当前主题：跟随宿主 ({mode})\n点击切换为：浅色模式', 'zh-TW': '目前主題：跟隨宿主 ({mode})\n點擊切換為：淺色模式', en: 'Theme: Follow IDE ({mode})\nClick to switch to Light' },
  'theme.lightTitle': { 'zh-CN': '当前主题：浅色模式 (固定)\n点击切换为：深色模式', 'zh-TW': '目前主題：淺色模式 (固定)\n點擊切換為：深色模式', en: 'Theme: Light (Fixed)\nClick to switch to Dark' },
  'theme.darkTitle': { 'zh-CN': '当前主题：深色模式 (固定)\n点击切换为：跟随宿主', 'zh-TW': '目前主題：深色模式 (固定)\n點擊切換為：跟隨宿主', en: 'Theme: Dark (Fixed)\nClick to switch to Follow IDE' },

  // 本轮/会话估值
  'cost.streamingEst': { 'zh-CN': '生成中暂估', 'zh-TW': '生成中暫估', en: 'Streaming est.' },
  'cost.returnedEst': { 'zh-CN': '按已返回用量估算', 'zh-TW': '依已回應用量估算', en: 'Based on returned usage' },
  'cost.latestTurn': { 'zh-CN': '最近调用 {val} · {label}', 'zh-TW': '最近呼叫 {val} · {label}', en: 'Latest turn {val} · {label}' },
  'cost.unpriced': { 'zh-CN': '最近调用：模型费率未收录', 'zh-TW': '最近呼叫：模型費率未收錄', en: 'Latest turn: unpriced model' },
  'cost.latestDash': { 'zh-CN': '最近调用估值：—', 'zh-TW': '最近呼叫估值：—', en: 'Latest turn: —' },
  'cost.sessionTotal': { 'zh-CN': '当前会话合计约 ${val}', 'zh-TW': '目前工作階段合計約 ${val}', en: 'Session total ≈ ${val}' },
  'cost.modelTip': { 'zh-CN': '模型：{model}\n输入：{input} tok\n缓存：{cache} tok\n输出：{output} tok\n参考金额：${cost}', 'zh-TW': '模型：{model}\n輸入：{input} tok\n快取：{cache} tok\n輸出：{output} tok\n參考金額：${cost}', en: 'Model: {model}\nInput: {input} tok\nCache: {cache} tok\nOutput: {output} tok\nEst. cost: ${cost}' },
  'cost.unpricedTip': { 'zh-CN': '模型：{model}（公开费率未收录）', 'zh-TW': '模型：{model}（公開費率未收錄）', en: 'Model: {model} (public rate unavailable)' },
  'cost.missingModel': { 'zh-CN': '缺少模型信息', 'zh-TW': '缺少模型資訊', en: 'Missing model info' },

  // 模块状态（客户端语言 / 代理）
  'mod.readFail': { 'zh-CN': '⚠️ 读取失败', 'zh-TW': '⚠️ 讀取失敗', en: '⚠️ Read Failed' },
  'mod.readErr': { 'zh-CN': '⚠️ 读取异常', 'zh-TW': '⚠️ 讀取異常', en: '⚠️ Read Error' },
  'mod.processing': { 'zh-CN': '正在处理…', 'zh-TW': '正在處理…', en: 'Processing…' },
  'mod.zh.failDetect': { 'zh-CN': '检测汉化状态失败: {err}', 'zh-TW': '偵測中文化狀態失敗: {err}', en: 'Failed to detect client language status: {err}' },
  'mod.zh.errDetect': { 'zh-CN': '检测汉化状态异常: {err}', 'zh-TW': '偵測中文化狀態異常: {err}', en: 'Error detecting client language status: {err}' },
  'mod.zh.badgeRestartEn': { 'zh-CN': '⏳ 需重启恢复英文', 'zh-TW': '⏳ 需重啟恢復英文', en: '⏳ Restart for English' },
  'mod.zh.badgeOffReady': { 'zh-CN': '⚪ 已关闭 (官方英文)', 'zh-TW': '⚪ 已關閉 (官方英文)', en: '⚪ English (Active)' },
  'mod.zh.badgeNotInstalled': { 'zh-CN': '⚪ 官方英文 (未注入汉化)', 'zh-TW': '⚪ 官方英文 (未注入中文化)', en: '⚪ English (Default)' },
  'mod.zh.badgeActive': { 'zh-CN': '🟢 已翻译生效', 'zh-TW': '🟢 已翻譯生效', en: '🟢 zh-CN Active' },
  'mod.zh.badgeNotInjected': { 'zh-CN': '⚠️ 磁盘未注入', 'zh-TW': '⚠️ 磁碟未注入', en: '⚠️ Not Injected' },
  'mod.zh.badgePendingRestart': { 'zh-CN': '⏳ 待重启客户端生效', 'zh-TW': '⏳ 待重啟用戶端生效', en: '⏳ Restart Required' },
  'mod.zh.descRestartEn': { 'zh-CN': '已切换为官方英文；当前界面仍保留已加载的中文 DOM 缓存，需完全退出并重新打开 Antigravity 客户端后彻底生效。', 'zh-TW': '已切換為官方英文；目前介面仍保留已載入的中文 DOM 快取，需完全結束並重新開啟 Antigravity 用戶端後徹底生效。', en: 'Switched to English; current UI still retains loaded Chinese DOM cache. Fully quit and reopen Antigravity to apply.' },
  'mod.zh.descOffReady': { 'zh-CN': '客户端当前保持官方原生英文（磁盘已具备简体中文资源与配置门禁，切换为简体中文并重启即可生效）。', 'zh-TW': '用戶端目前保持官方原生英文（磁碟已具備簡體中文資源與設定門禁，切換為簡體中文並重啟即可生效）。', en: 'Client is running native English (zh-CN resources are staged on disk; switch to zh-CN and restart to apply).' },
  'mod.zh.descOffNotInstalled': { 'zh-CN': '客户端汉化处于未安装状态，保持官方原生英文界面。', 'zh-TW': '用戶端中文化處於未安裝狀態，保持官方原生英文介面。', en: 'Client localization is not installed; running native English.' },
  'mod.zh.descActive': { 'zh-CN': '客户端简体中文运行中：DOM 监听器正常工作，左侧边栏与核心菜单已翻译。', 'zh-TW': '用戶端簡體中文執行中：DOM 監聽器正常運作，左側邊欄與核心選單已翻譯。', en: 'Client zh-CN localization is active.' },
  'mod.zh.descNeedInject': { 'zh-CN': '配置已开启简体中文，但当前磁盘 ASAR 未注入汉化资源；需退出客户端后通过命令行运行 node cli.js chinese:enable 完成注入。', 'zh-TW': '設定已開啟簡體中文，但目前磁碟 ASAR 未注入中文化資源；需結束用戶端後執行 node cli.js chinese:enable 完成注入。', en: 'zh-CN is enabled in config, but ASAR lacks localization injection. Quit Antigravity and run: node cli.js chinese:enable' },
  'mod.zh.descPendingRestart': { 'zh-CN': '简体中文代码已注入且配置已开启；需完全退出并重新打开 Antigravity 客户端加载生效。', 'zh-TW': '簡體中文程式碼已注入且設定已開啟；需完全結束並重新開啟 Antigravity 用戶端載入生效。', en: 'zh-CN localization is injected and enabled; quit and reopen Antigravity to take effect.' },
  'mod.zh.descPartialInject': { 'zh-CN': '磁盘 ASAR 仅包含部分汉化代码但资源或门禁不完整（{reason}）；请彻底退出 Antigravity 后，在安装包目录运行 install.bat（macOS/Linux 执行 node cli.js chinese:enable）补装。', 'zh-TW': '磁碟 ASAR 僅包含部分漢化程式碼但資源或門禁不完整（{reason}）；請徹底結束 Antigravity 後，在安裝包目錄執行 install.bat（macOS/Linux 執行 node cli.js chinese:enable）補裝。', en: 'Localization module in app.asar is incomplete ({reason}). Fully quit Antigravity and run install.bat (or node cli.js chinese:enable on macOS/Linux) from the package directory.' },
  'mod.zh.savedEnableRestart': { 'zh-CN': '✔ 已开启客户端简体中文并保存配置，完全退出并重启 Antigravity 后生效。', 'zh-TW': '✔ 已開啟用戶端簡體中文並儲存設定，完全結束並重啟 Antigravity 後生效。', en: '✔ Simplified Chinese saved; quit and restart Antigravity to apply.' },
  'mod.zh.savedDisableRestart': { 'zh-CN': '✔ 已切换为官方英文并保存配置，完全退出并重启 Antigravity 后恢复英文。', 'zh-TW': '✔ 已切換為官方英文並儲存設定，完全結束並重啟 Antigravity 後恢復英文。', en: '✔ Native English saved; quit and restart Antigravity to restore English.' },
  'mod.zh.btnDisable': { 'zh-CN': '切换为官方英文 (需重启)', 'zh-TW': '切換為官方英文 (需重啟)', en: 'Switch to English (Restart)' },
  'mod.zh.btnEnable': { 'zh-CN': '切换为简体中文 (需重启)', 'zh-TW': '切換為簡體中文 (需重啟)', en: 'Switch to 简体中文 (Restart)' },
  'mod.zh.toggleFail': { 'zh-CN': '切换客户端语言失败', 'zh-TW': '切換用戶端語言失敗', en: 'Failed to switch client language' },
  'mod.proxy.failDetect': { 'zh-CN': '检测免 TUN 代理状态失败: {err}', 'zh-TW': '偵測免 TUN 代理狀態失敗: {err}', en: 'Failed to detect proxy status: {err}' },
  'mod.proxy.errDetect': { 'zh-CN': '检测免 TUN 代理状态异常: {err}', 'zh-TW': '偵測免 TUN 代理狀態異常: {err}', en: 'Error detecting proxy status: {err}' },
  'mod.proxy.badgeOk': { 'zh-CN': '🟢 直连已配置', 'zh-TW': '🟢 直連已設定', en: '🟢 Configured' },
  'mod.proxy.badgeNotInjected': { 'zh-CN': '⚠️ 磁盘未注入', 'zh-TW': '⚠️ 磁碟未注入', en: '⚠️ Not Injected' },
  'mod.proxy.badgeOff': { 'zh-CN': '⚪ 未启用', 'zh-TW': '⚪ 未啟用', en: '⚪ Disabled' },
  'mod.proxy.descOn': { 'zh-CN': '已启用本地网络直连（代理: {url}）。注意：模型请求连通性待实际在线对话验证，未验证前不代表公网直连必定成功。', 'zh-TW': '已啟用本機網路直連（代理: {url}）。注意：模型請求連通性待實際線上對話驗證。', en: 'Local proxy enabled ({url}). Connectivity should be verified with a live chat request.' },
  'mod.proxy.descNeedInject': { 'zh-CN': '配置已开启代理，但当前磁盘 ASAR 未注入代理拦截逻辑；需退出客户端后通过命令行运行 node cli.js proxy:enable 完成注入。', 'zh-TW': '設定已開啟代理，但目前磁碟 ASAR 未注入代理攔截邏輯；需結束用戶端後執行 node cli.js proxy:enable 完成注入。', en: 'Proxy enabled in config, but ASAR lacks proxy hook. Quit Antigravity and run: node cli.js proxy:enable' },
  'mod.proxy.descPartialInject': { 'zh-CN': '磁盘 ASAR 代理拦截组件不完整（{reason}）；请彻底退出 Antigravity 后，在安装包目录运行 install.bat（macOS/Linux 执行 node cli.js proxy:enable）补装。', 'zh-TW': '磁碟 ASAR 代理攔截元件不完整（{reason}）；請徹底結束 Antigravity 後，在安裝包目錄執行 install.bat（macOS/Linux 執行 node cli.js proxy:enable）補裝。', en: 'Proxy hook in app.asar is incomplete ({reason}). Fully quit Antigravity and run install.bat (or node cli.js proxy:enable on macOS/Linux) from the package directory.' },
  'mod.proxy.descOff': { 'zh-CN': '未启用本地网络直连，网络请求跟随系统默认/TUN 设置。', 'zh-TW': '未啟用本機網路直連，網路請求跟隨系統預設/TUN 設定。', en: 'Local proxy disabled; requests follow system/TUN settings.' },
  'mod.proxy.btnDisable': { 'zh-CN': '关闭免 TUN 直连', 'zh-TW': '關閉免 TUN 直連', en: 'Disable Local Proxy' },
  'mod.proxy.btnEnable': { 'zh-CN': '开启免 TUN 直连', 'zh-TW': '開啟免 TUN 直連', en: 'Enable Local Proxy' },
  'mod.proxy.btnSave': { 'zh-CN': '保存代理设置', 'zh-TW': '儲存代理設定', en: 'Save Proxy Config' },
  'mod.proxy.btnSaving': { 'zh-CN': '正在保存…', 'zh-TW': '正在儲存…', en: 'Saving…' },
  'mod.proxy.badgePendingRestart': { 'zh-CN': '⏳ 已配置 · 待重启生效', 'zh-TW': '⏳ 已設定 · 待重啟生效', en: '⏳ Saved · Restart Needed' },
  'mod.proxy.badgeActive': { 'zh-CN': '🟢 运行中已生效', 'zh-TW': '🟢 執行中已生效', en: '🟢 Active in Runtime' },
  'mod.proxy.badgePendingOff': { 'zh-CN': '⚪ 已关闭 · 待重启', 'zh-TW': '⚪ 已關閉 · 待重啟', en: '⚪ Disabled · Restart Needed' },
  'mod.proxy.descPendingRestart': { 'zh-CN': '已保存免 TUN 直连（{url}），完全退出并重启 Antigravity 客户端后在运行时生效；模型请求连通性待真实在线对话验证。', 'zh-TW': '已儲存免 TUN 直連（{url}），完全結束並重啟 Antigravity 用戶端後在執行時生效；模型請求連通性待真實線上對話驗證。', en: 'Local proxy saved ({url}). Quit and reopen Antigravity to activate; model connectivity requires a live chat request.' },
  'mod.proxy.descActive': { 'zh-CN': '免 TUN 直连已在运行时生效（代理: {url}）；如更改地址请保存并重启客户端。模型请求连通性待真实在线对话验证。', 'zh-TW': '免 TUN 直連已在執行時生效（代理: {url}）；如變更位址請儲存並重啟用戶端。模型請求連通性待真實線上對話驗證。', en: 'Local proxy is active in runtime ({url}). Save and restart client after address changes; model connectivity requires a live chat request.' },
  'mod.proxy.descPendingOff': { 'zh-CN': '配置已关闭，当前窗口仍沿用启动时的旧代理（{url}）；重启客户端后将停止使用。', 'zh-TW': '設定已關閉，目前視窗仍沿用啟動時的舊代理（{url}）；重啟用戶端後將停止使用。', en: 'Proxy disabled in config; previous proxy ({url}) stays active until client restart.' },
  'mod.proxy.savedPendingRestart': { 'zh-CN': '✔ 代理配置已保存（{url}），请重启 Antigravity 客户端后生效。', 'zh-TW': '✔ 代理設定已儲存（{url}），請重啟 Antigravity 用戶端後生效。', en: '✔ Proxy config saved ({url}). Restart Antigravity client to take effect.' },
  'mod.proxy.savedAlreadyActive': { 'zh-CN': '✔ 当前代理配置已写入并处于运行生效状态（{url}），无需重复重启。', 'zh-TW': '✔ 目前代理設定已寫入並處於執行生效狀態（{url}），無需重複重啟。', en: '✔ Proxy config saved and already active ({url}); no restart needed.' },
  'mod.proxy.disabledPendingRestart': { 'zh-CN': '✔ 免 TUN 直连已关闭并保存，完全退出重启客户端后停止使用旧代理。', 'zh-TW': '✔ 免 TUN 直連已關閉並儲存，完全結束重啟用戶端後停止使用舊代理。', en: '✔ Local proxy disabled and saved; restart Antigravity to stop using the old proxy.' },
  'mod.proxy.disabledSaved': { 'zh-CN': '✔ 免 TUN 直连已关闭并保存。', 'zh-TW': '✔ 免 TUN 直連已關閉並儲存。', en: '✔ Local proxy disabled and saved.' },
  'mod.proxy.testing': { 'zh-CN': '正在测试…', 'zh-TW': '正在測試…', en: 'Testing…' },
  'mod.proxy.testingDetail': { 'zh-CN': '正在发起本地与网络连通性测试…', 'zh-TW': '正在發起本機與網路連通性測試…', en: 'Testing local port and internet reachability…' },

  // 模型卡片与列表细节
  'models.list.currentTag': { 'zh-CN': '当前', 'zh-TW': '目前', en: 'Current' },
  'models.list.conflictPill': { 'zh-CN': '多档位冲突', 'zh-TW': '多檔位衝突', en: 'Conflict' },
  'models.card.savedConflict': { 'zh-CN': '多档位冲突（请统一）', 'zh-TW': '多檔位衝突（請統一）', en: 'Conflict (pick one)' },
  'models.card.savedCustom': { 'zh-CN': '自定义 {val}', 'zh-TW': '自訂 {val}', en: 'Custom {val}' },
  'models.card.savedShortCustom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
  'models.card.clientFollowing': { 'zh-CN': '跟随模型', 'zh-TW': '跟隨模型', en: 'Follow Model' },
  'models.card.clientDefault': { 'zh-CN': '默认（未修改）', 'zh-TW': '預設（未修改）', en: 'Default (Original)' },
  'models.card.preRestart': { 'zh-CN': '重启前已观测：{val}', 'zh-TW': '重啟前已觀測：{val}', en: 'Before restart: {val}' },
  'models.card.serviceLimit': { 'zh-CN': '服务端报错上限：{val}', 'zh-TW': '伺服器端報錯上限：{val}', en: 'Server error limit: {val}' },
  'models.card.hintDynamic': { 'zh-CN': '已应用跟随模型；正在使用的模型实际预算需由对话请求确认。', 'zh-TW': '已套用跟隨模型；正在使用的模型實際預算需由對話請求確認。', en: 'Follow Model is active; exact per-model budget is confirmed during live chat.' },
  'models.card.hintSavedDiff': { 'zh-CN': '已保存目标（{saved}）与客户端当前配置（{client}）不同；点击下方「保存并应用」写入客户端。', 'zh-TW': '已儲存目標（{saved}）與用戶端目前設定（{client}）不同；點擊下方「儲存並套用」寫入用戶端。', en: 'Saved target ({saved}) differs from client active ({client}); click "Save & Apply" to update.' },
  'models.card.hintRestartWait': { 'zh-CN': '新设置已写入客户端，重启后生效，目前对话仍使用旧设置。', 'zh-TW': '新設定已寫入用戶端，重啟後生效，目前對話仍使用舊設定。', en: 'New setting written to client; restart required before new chats use it.' },
  'models.card.speedLine': { 'zh-CN': '{effort}：中位 {tps} tok/s · {n} 条', 'zh-TW': '{effort}：中位 {tps} tok/s · {n} 筆', en: '{effort}: median {tps} tok/s · {n}' },
  'models.card.defaultEffort': { 'zh-CN': '标准', 'zh-TW': '標準', en: 'Standard' },
  'models.mismatch': { 'zh-CN': '客户端重启后读到的配置（{actual}）与目标不一致，请重新应用。', 'zh-TW': '用戶端重啟後讀到的設定（{actual}）與目標不一致，請重新套用。', en: 'Client loaded ({actual}) after restart, which differs from target. Please reapply.' },
  'models.meta.modeLine': { 'zh-CN': '配置 {cfg} / 实测 {obs}', 'zh-TW': '設定 {cfg} / 實測 {obs}', en: 'Config {cfg} / Observed {obs}' },
  'models.meta.unobserved': { 'zh-CN': '未观测', 'zh-TW': '未觀測', en: 'Unobserved' },
  'models.meta.backupOk': { 'zh-CN': '已备份完整', 'zh-TW': '已備份完整', en: 'Backed up' },
  'models.meta.backupNone': { 'zh-CN': '无（未修改原版）', 'zh-TW': '無（未修改原版）', en: 'None (original)' },
  'models.copyOk': { 'zh-CN': '已复制链接', 'zh-TW': '已複製連結', en: 'Link copied' },
  'models.linkOpened': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者文章', en: 'Opened original author post in default browser' },
  'models.linkCopyFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者文章連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; author post URL copied to clipboard.' },
  'models.copyFail': { 'zh-CN': '无法自动打开，请手动复制：{url}', 'zh-TW': '無法自動開啟，請手動複製：{url}', en: 'Could not open automatically. URL: {url}' },
  'models.validation.dynamicDesc': { 'zh-CN': '跟随模型：所有模型使用同一种方式，每个模型按自己支持的长度分配，实际预算可能不同。', 'zh-TW': '跟隨模型：所有模型使用同一種方式，每個模型依自身支援的長度分配，實際預算可能不同。', en: 'Follow Model: each model uses its own supported limit; active budgets may differ.' },
  'models.validation.defaultDesc': { 'zh-CN': '默认：使用客户端原本的长度。', 'zh-TW': '預設：使用用戶端原本的長度。', en: 'Default: uses the native client limit.' },
  'models.validation.outOfRange': { 'zh-CN': '超出可设置范围（{min} – {max}）', 'zh-TW': '超出可設定範圍（{min} – {max}）', en: 'Out of allowed range ({min} – {max})' },
  'models.validation.tooSmall': { 'zh-CN': '设置值 {val} 偏小，可能很快触发上下文压缩。', 'zh-TW': '設定值 {val} 偏小，可能很快觸發上下文壓縮。', en: 'Value {val} is small and may trigger early compression.' },
  'models.validation.aboveService': { 'zh-CN': '高于最近一次服务端报错上限（{val}）。', 'zh-TW': '高於最近一次伺服器端報錯上限（{val}）。', en: 'Above recent server error limit ({val}).' },
  'models.card.observedWaitRestart': { 'zh-CN': '重启后尚未观测，发一条消息后更新', 'zh-TW': '重啟後尚未觀測，發送一則訊息後更新', en: 'Not observed after restart; send a message to update' },
  'models.card.observedTitle': { 'zh-CN': '实际分配预算：{val} tokens', 'zh-TW': '實際分配預算：{val} tokens', en: 'Allocated budget: {val} tokens' },
  'models.card.preRestartTitle': { 'zh-CN': '重启前预算：{val} tokens', 'zh-TW': '重啟前預算：{val} tokens', en: 'Budget before restart: {val} tokens' },
  'models.card.serviceLimitTitle': { 'zh-CN': '服务端报错上限：{val} tokens', 'zh-TW': '伺服器端報錯上限：{val} tokens', en: 'Server error limit: {val} tokens' },
  'models.card.speedLineText': { 'zh-CN': '{prefix}{tps} tokens/秒 · 近 {count} 次中位数{low}{ts}', 'zh-TW': '{prefix}{tps} tokens/秒 · 近 {count} 次中位數{low}{ts}', en: '{prefix}{tps} tok/s · median of {count}{low}{ts}' },
  'models.card.lowSampleParen': { 'zh-CN': '（样本少）', 'zh-TW': '（樣本少）', en: ' (low n)' },
  'models.card.hintDiffClient': { 'zh-CN': '与客户端当前使用的长度不同。应用后，所有模型都会改用这个长度。', 'zh-TW': '與用戶端目前使用的長度不同。套用後，所有模型都會改用此長度。', en: 'Differs from current client setting. Applying will update all models.' },
  'models.card.hintBelowSet': { 'zh-CN': '实际分配低于设置值，可能受模型或服务端限制。', 'zh-TW': '實際分配低於設定值，可能受模型或伺服器端限制。', en: 'Allocated budget is lower than configured; may be capped by model or server.' },
  'models.conflict.useThis': { 'zh-CN': '用这个', 'zh-TW': '用這個', en: 'Use this' },
  'models.conflict.orCustom': { 'zh-CN': '或重新设定一个统一值', 'zh-TW': '或重新設定一個統一值', en: 'Or set a unified value' },
  'models.conflict.selfSet': { 'zh-CN': '自己设置', 'zh-TW': '自行設定', en: 'Set manually' },
  'models.dropdown.empty': { 'zh-CN': '暂无已知模型', 'zh-TW': '暫無已知模型', en: 'No models yet' },

  // 速度图内部与提示
  'speed.unitSec': { 'zh-CN': '{val} 秒', 'zh-TW': '{val} 秒', en: '{val} s' },
  'speed.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'speed.originProbe': { 'zh-CN': '主动测试', 'zh-TW': '主動測試', en: 'Probe' },
  'speed.tip.samples': { 'zh-CN': '样本数：{n}{low}', 'zh-TW': '樣本數：{n}{low}', en: 'Samples: {n}{low}' },
  'speed.tip.timeRange': { 'zh-CN': '时间范围：{range}', 'zh-TW': '時間範圍：{range}', en: 'Range: {range}' },
  'speed.tip.medOut': { 'zh-CN': '输出 tokens 中位数：{val}', 'zh-TW': '輸出 tokens 中位數：{val}', en: 'Median output tokens: {val}' },
  'speed.tip.medIn': { 'zh-CN': '输入 tokens 中位数：{val}', 'zh-TW': '輸入 tokens 中位數：{val}', en: 'Median input tokens: {val}' },
  'speed.tip.time': { 'zh-CN': '时间：{val}', 'zh-TW': '時間：{val}', en: 'Time: {val}' },
  'speed.tip.output': { 'zh-CN': '输出：{val} tokens', 'zh-TW': '輸出：{val} tokens', en: 'Output: {val} tokens' },
  'speed.tip.ttft': { 'zh-CN': '首字延迟：{val}', 'zh-TW': '首字延遲：{val}', en: 'TTFT: {val}' },
  'speed.tip.origin': { 'zh-CN': '来源：{val}', 'zh-TW': '來源：{val}', en: 'Source: {val}' },
  'speed.tip.tpsLine': { 'zh-CN': '#{idx} · {tps} tokens/秒', 'zh-TW': '#{idx} · {tps} tokens/秒', en: '#{idx} · {tps} tok/s' },

  // 悬停气泡与顶部胶囊
  'tip.title.normal': { 'zh-CN': '上下文窗口：', 'zh-TW': 'Context 視窗：', en: 'Context window:' },
  'tip.title.stale': { 'zh-CN': '上下文窗口（数据过期）：', 'zh-TW': '上下文視窗（資料過期）：', en: 'Context window (stale):' },
  'tip.title.high90': { 'zh-CN': '上下文窗口（高占用告警）：', 'zh-TW': '上下文視窗（高佔用警示）：', en: 'Context window (high usage):' },
  'tip.title.high75': { 'zh-CN': '上下文窗口（占用偏高）：', 'zh-TW': '上下文視窗（佔用偏高）：', en: 'Context window (elevated):' },
  'tip.title.est': { 'zh-CN': '上下文窗口（本地估算）：', 'zh-TW': '上下文視窗（本機估算）：', en: 'Context window (local est.):' },
  'tip.title.compacting': { 'zh-CN': '上下文窗口（正在压缩…）：', 'zh-TW': '上下文視窗（正在壓縮…）：', en: 'Context window (compacting…):' },
  'tip.title.compacted': { 'zh-CN': '上下文窗口（已压缩 · 预估）：', 'zh-TW': '上下文視窗（已壓縮 · 預估）：', en: 'Context window (compacted · est.):' },
  'tip.pct.compacting': { 'zh-CN': '正在生成压缩摘要，完成后自动更新', 'zh-TW': '正在產生壓縮摘要，完成後自動更新', en: 'Generating summary; updating shortly' },
  'tip.pct.compacted': { 'zh-CN': '约 {used}% 已用（剩余约 {rem}% · 已压缩）', 'zh-TW': '約 {used}% 已用（剩餘約 {rem}% · 已壓縮）', en: '~{used}% used (~{rem}% left · compacted)' },
  'tip.pct.staleVal': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 统计延迟）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 統計延遲）', en: '{used}% used ({rem}% left · delayed)' },
  'tip.pct.staleUnknown': { 'zh-CN': '统计读取延迟（剩余未知）', 'zh-TW': '統計讀取延遲（剩餘未知）', en: 'Stats delayed (remaining unknown)' },
  'tip.pct.high90': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 接近上限）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 接近上限）', en: '{used}% used ({rem}% left · near limit)' },
  'tip.pct.high75': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 占用偏高）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 佔用偏高）', en: '{used}% used ({rem}% left · elevated)' },
  'tip.pct.normal': { 'zh-CN': '{used}% 已用（剩余 {rem}%）', 'zh-TW': '{used}% 已用（剩餘 {rem}%）', en: '{used}% used ({rem}% left)' },
  'tip.pct.noBudget': { 'zh-CN': '容量未知（未返回上限）', 'zh-TW': '容量未知（未回傳上限）', en: 'Limit unknown (not returned)' },
  'tip.pct.estOnly': { 'zh-CN': '真实占比未知（仅估算）', 'zh-TW': '真實佔比未知（僅估算）', en: 'Actual % unknown (estimate only)' },
  'tip.pct.waitStats': { 'zh-CN': '等待请求统计（仅归档估算）', 'zh-TW': '等待請求統計（僅封存估算）', en: 'Waiting for stats (archive est.)' },
  'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
  'tip.detail.usedOfBudget': { 'zh-CN': '已用 {used} token，共 {budget}{inc}', 'zh-TW': '已用 {used} token，共 {budget}{inc}', en: '{used} / {budget} tokens used{inc}' },
  'tip.detail.usedNoBudget': { 'zh-CN': '已用 {used} token，总容量未知', 'zh-TW': '已用 {used} token，總容量未知', en: '{used} tokens used, limit unknown' },
  'tip.detail.estUsed': { 'zh-CN': '已用 ≈ {used} token{budget}', 'zh-TW': '已用 ≈ {used} token{budget}', en: 'Used ≈ {used} tokens{budget}' },
  'tip.detail.estBudgetPart': { 'zh-CN': '，共 {budget}', 'zh-TW': '，共 {budget}', en: ' of {budget}' },
  'tip.detail.estNoBudgetPart': { 'zh-CN': '，总容量未知', 'zh-TW': '，總容量未知', en: ', limit unknown' },
  'tip.detail.sessionEst': { 'zh-CN': '会话估算 ≈ {low}–{high} token', 'zh-TW': '工作階段估算 ≈ {low}–{high} token', en: 'Session est. ≈ {low}–{high} tokens' },
  'tip.detail.sessionCum': { 'zh-CN': '会话累计 ≈ {low}–{high} token', 'zh-TW': '工作階段累計 ≈ {low}–{high} token', en: 'Session cumulative ≈ {low}–{high} tokens' },
  'tip.detail.waitBg': { 'zh-CN': '正在等待后台更新统计数据', 'zh-TW': '正在等待背景更新統計資料', en: 'Waiting for background stats update' },
  'tip.detail.readingSession': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前對話 Context 用量…', en: 'Reading current session context usage…' },
  'tip.detail.incSuffix': { 'zh-CN': '（含未知附件）', 'zh-TW': '（含未知附件）', en: ' (incl. unknown files)' },
  'tip.detail.compacted': { 'zh-CN': '压缩后预估 ≈ {used} / {budget} token（发新消息后切换精确值）', 'zh-TW': '壓縮後預估 ≈ {used} / {budget} token（發新訊息後切換精確值）', en: 'Post-compact est. ≈ {used} / {budget} tokens (exact on next message)' },
  'tip.detail.compactedNoBudget': { 'zh-CN': '压缩后预估 ≈ {used} token（发新消息后切换精确值）', 'zh-TW': '壓縮後預估 ≈ {used} token（發新訊息後切換精確值）', en: 'Post-compact est. ≈ {used} tokens (exact on next message)' },
  'badge.noSession': { 'zh-CN': '未打开会话', 'zh-TW': '未打開對話', en: 'No active chat' },
  'badge.clickOpenCli': { 'zh-CN': ' · 点击查看或启动 CLI', 'zh-TW': ' · 點擊檢視或啟動 CLI', en: ' · Click to view or launch CLI' },
  'badge.contexts': { 'zh-CN': 'contexts', 'zh-TW': 'contexts', en: 'contexts' },
  'badge.delayed': { 'zh-CN': '统计延迟', 'zh-TW': '統計延遲', en: 'Delayed' },
  'badge.actualUnknown': { 'zh-CN': '真实量未知', 'zh-TW': '真實量未知', en: 'Actual unknown' },
  'badge.tokensTitle': { 'zh-CN': 'Token 用量一览（点击展开详情）', 'zh-TW': 'Token 用量總覽（點擊展開詳細資訊）', en: 'Token Usage Overview (click to open)' },
  'badge.speedCalc': { 'zh-CN': '计算中…', 'zh-TW': '計算中…', en: 'Calculating…' },
  'badge.speedHoverIdle': { 'zh-CN': ' · 待生成', 'zh-TW': ' · 待生成', en: ' · Idle' },
  'badge.speedTitleIdle': { 'zh-CN': '当前会话平均生成速度与耗时 (tok/s)', 'zh-TW': '目前工作階段平均生成速度與耗時 (tok/s)', en: 'Session average speed & latency (tok/s)' },
  'badge.speedTitleWait': { 'zh-CN': '正在等待模型返回或计算生成指标…', 'zh-TW': '正在等待模型回傳或計算生成指標…', en: 'Waiting for model response or metrics…' },
  'badge.speedTitleDetail': { 'zh-CN': '当前会话平均生成速度：{avgTps} tok/s（共 {count} 轮，累计 {totalOut} tokens / {totalDur}s）{latestPart}', 'zh-TW': '目前工作階段平均生成速度：{avgTps} tok/s（共 {count} 輪，累計 {totalOut} tokens / {totalDur}s）{latestPart}', en: 'Session average speed: {avgTps} tok/s ({count} turns, {totalOut} tokens / {totalDur}s){latestPart}' },
  'badge.speedLatestPart': { 'zh-CN': '\n最新一轮输出速度：{tps} tok/s{streaming}\n总耗时：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次产出：{output} tokens', 'zh-TW': '\n最新一輪輸出速度：{tps} tok/s{streaming}\n總耗時：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次產出：{output} tokens', en: '\nLatest turn speed: {tps} tok/s{streaming}\nTotal: {duration}s (TTFT {ttft}s + streaming {streamSec}s)\nOutput: {output} tokens' },
  'badge.speedStreamingPart': { 'zh-CN': ' (流式 {tps} tok/s)', 'zh-TW': ' (流式 {tps} tok/s)', en: ' (streaming {tps} tok/s)' },
  'badge.corpus.range': { 'zh-CN': '会话{range}{inc}', 'zh-TW': '工作階段{range}{inc}', en: 'Chat {range}{inc}' },
  'badge.corpus.incPlus': { 'zh-CN': '＋未知', 'zh-TW': '＋未知', en: '+unknown' },
  'badge.corpus.scanning': { 'zh-CN': '会话扫描中…', 'zh-TW': '對話掃描中…', en: 'Scanning chat…' },
  'badge.corpus.pending': { 'zh-CN': '会话待扫描', 'zh-TW': '對話待掃描', en: 'Chat scan pending' },
  'badge.status.stale': { 'zh-CN': '最近请求统计读取异常或延迟，不能判断剩余空间。', 'zh-TW': '最近請求統計讀取異常或延遲，不能判斷剩餘空間。', en: 'Latest request stats delayed or unavailable; remaining space cannot be determined.' },
  'badge.status.scanErr': { 'zh-CN': '全会话扫描未完成：{err}', 'zh-TW': '全工作階段掃描未完成：{err}', en: 'Session scan incomplete: {err}' },
  'badge.status.incomplete': { 'zh-CN': '存在 {count} 个附件含未知内容；会话总量仍未计全，不能据此保证不会超限。', 'zh-TW': '存在 {count} 個附件含未知內容；工作階段總量仍未計全，無法據此保證不會超限。', en: '{count} attachment(s) contain unreadable content; cumulative total is incomplete.' },
  'badge.status.estimated': { 'zh-CN': '只有客户端估算，附件等内容可能未计全；当前请求真实占用未知。', 'zh-TW': '僅有用戶端估算，附件等內容可能未計全；目前請求真實佔用未知。', en: 'Client estimate only; attachments may be omitted and actual usage is unknown.' },
  'badge.status.compacting': { 'zh-CN': '正在压缩会话上下文，完成后圆环与剩余空间将自动同步更新…', 'zh-TW': '正在壓縮工作階段上下文，完成後圓環與剩餘空間將自動同步更新…', en: 'Compacting conversation context; ring and headroom will update automatically…' },
  'badge.status.compacted': { 'zh-CN': '上下文已完成压缩；当前按压缩后窗口预估显示，发送下一条消息后切换为服务端精确统计。', 'zh-TW': '上下文已完成壓縮；目前按壓縮後視窗預估顯示，傳送下一則訊息後切換為伺服器端精確統計。', en: 'Context compacted; showing post-compaction estimate until the next message returns exact server stats.' },
  'badge.status.normal': { 'zh-CN': '请求用量与会话累计分别统计；会话 token 数始终为本地估算。', 'zh-TW': '請求用量與工作階段累計分別統計；工作階段 token 數始終為本機估算。', en: 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.' },
  'update.title': { 'zh-CN': '🚀 检查更新', 'zh-TW': '🚀 檢查更新', en: '🚀 Check for Updates' },
  'update.checking': { 'zh-CN': '正在检测最新版本…', 'zh-TW': '正在偵測最新版本…', en: 'Checking for the latest version…' },
  'update.viewRelease': { 'zh-CN': '查看发布页', 'zh-TW': '查看版本發布頁', en: 'Release Notes' },
  'update.later': { 'zh-CN': '稍后', 'zh-TW': '稍後', en: 'Later' },
  'update.applyNow': { 'zh-CN': '立即更新', 'zh-TW': '立即更新', en: 'Update Now' },
  'update.connecting': { 'zh-CN': '正在连接 GitHub 检测最新版本…', 'zh-TW': '正在連接 GitHub 檢測最新版本…', en: 'Connecting to GitHub to check for updates…' },
  'update.failedTitle': { 'zh-CN': '⚠️ 检查更新失败', 'zh-TW': '⚠️ 檢查更新失敗', en: '⚠️ Update Check Failed' },
  'update.failedVer': { 'zh-CN': '{ver} (检查失败)', 'zh-TW': '{ver} (檢查失敗)', en: '{ver} (Check failed)' },
  'update.failedFetch': { 'zh-CN': '未能获取有效的版本数据', 'zh-TW': '未能取得有效的版本資料', en: 'Failed to retrieve valid release metadata' },
  'update.failedBody': { 'zh-CN': '检查更新失败: {err}。请检查网络代理设置或前往 GitHub 查看。', 'zh-TW': '檢查更新失敗: {err}。請檢查網路代理設定或前往 GitHub 檢視。', en: 'Update check failed: {err}. Please check your proxy or visit GitHub.' },
  'update.failedNetBody': { 'zh-CN': '检查更新失败: {err}。请检查网络连接或稍后重试。', 'zh-TW': '檢查更新失敗: {err}。請檢查網路連線或稍後重試。', en: 'Update check failed: {err}. Please check your network and try again.' },
  'update.foundTitle': { 'zh-CN': '🚀 发现新版本', 'zh-TW': '🚀 發現新版本', en: '🚀 Update Available' },
  'update.foundBody': { 'zh-CN': '发现新版本 {ver}！\n\n更新说明：\n{notes}', 'zh-TW': '發現新版本 {ver}！\n\n更新說明：\n{notes}', en: 'Version {ver} is available!\n\nRelease notes:\n{notes}' },
  'update.defaultNotes': { 'zh-CN': '性能优化与体验改进', 'zh-TW': '效能最佳化與體驗改進', en: 'Performance and usability improvements' },
  'update.latestTitle': { 'zh-CN': '✅ 已是最新版本', 'zh-TW': '✅ 已是最新版本', en: '✅ Up to Date' },
  'update.latestVer': { 'zh-CN': '{ver} (已是最新)', 'zh-TW': '{ver} (已是最新)', en: '{ver} (Latest)' },
  'update.diskPending': { 'zh-CN': '已完成磁盘安装至最新版本 ({ver})，待重启客户端后主进程完整生效。', 'zh-TW': '已完成磁碟安裝至最新版本 ({ver})，待重新啟動用戶端後主行程完整生效。', en: '{ver} has been installed on disk. Restart the client for main-process changes to take effect.' },
  'update.latestBody': { 'zh-CN': '当前已是最新版本 ({ver})。已通过 GitHub Releases 确认。', 'zh-TW': '目前已是最新版本 ({ver})。已透過 GitHub Releases 確認。', en: 'You are on the latest version ({ver}), verified via GitHub Releases.' },
  'update.updatingBtn': { 'zh-CN': '正在更新...', 'zh-TW': '正在更新...', en: 'Updating…' },
  'update.downloading': { 'zh-CN': '正在下载安装包并校验 SHA-256...', 'zh-TW': '正在下載安裝套件並校驗 SHA-256...', en: 'Downloading package and verifying SHA-256…' },
  'update.noApi': { 'zh-CN': '更新接口不可用', 'zh-TW': '更新介面無法使用', en: 'Update API unavailable' },

  // CLI 启动提示
  'cli.busy': { 'zh-CN': 'CLI 正在启动中，请稍候…', 'zh-TW': 'CLI 正在啟動中，請稍候…', en: 'CLI is launching, please wait…' },
  'cli.noBridge': { 'zh-CN': '本地桥接服务未连接，请执行 node cli.js install 或重启客户端', 'zh-TW': '本機橋接服務未連線，請執行 node cli.js install 或重新啟動用戶端', en: 'Local bridge is not connected. Run `node cli.js install` or restart the client.' },
  'cli.defaultCwd': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
  'cli.launched': { 'zh-CN': '✔ 已启动 Antigravity CLI（目录：{cwd}）', 'zh-TW': '✔ 已啟動 Antigravity CLI（目錄：{cwd}）', en: '✔ Launched Antigravity CLI (cwd: {cwd})' },
  'cli.notFound': { 'zh-CN': '未检测到可用的 Antigravity CLI (agy)，请检查安装路径', 'zh-TW': '未偵測到可用的 Antigravity CLI (agy)，請檢查安裝路徑', en: 'Antigravity CLI (agy) was not found. Check your installation path.' },
  'cli.failed': { 'zh-CN': '✖ 启动 CLI 失败：{err}', 'zh-TW': '✖ 啟動 CLI 失敗：{err}', en: '✖ Failed to launch CLI: {err}' },
  'cli.exception': { 'zh-CN': '启动 CLI 发生异常', 'zh-TW': '啟動 CLI 發生異常', en: 'Unexpected error launching CLI' },

  // 折叠抽屉开关
  'drawer.colors.expand': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
  'drawer.colors.collapse': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

  // 会话关键摘要 & 技术明细
  'key.overflowUsed': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Exceeded' },
  'key.overflowRem': { 'zh-CN': '0 (已溢出)', 'zh-TW': '0 (已溢位)', en: '0 (Overflow)' },
  'key.estShort': { 'zh-CN': '约 {val} (估算)', 'zh-TW': '約 {val} (估算)', en: '~{val} (est.)' },
  'key.estPrefix': { 'zh-CN': '约 {val}', 'zh-TW': '約 {val}', en: '~{val}' },
  'key.pending': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
  'key.pill.tight': { 'zh-CN': '紧张', 'zh-TW': '緊張', en: 'Critical' },
  'key.pill.elevated': { 'zh-CN': '偏高', 'zh-TW': '偏高', en: 'High' },
  'key.pill.normal': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
  'key.pill.est': { 'zh-CN': '估算', 'zh-TW': '估算', en: 'Estimate' },
  'key.pill.compacting': { 'zh-CN': '压缩中…', 'zh-TW': '壓縮中…', en: 'Compacting…' },
  'badge.pct.compacting': { 'zh-CN': '压缩中…', 'zh-TW': '壓縮中…', en: 'Compact…' },
  'key.pill.compacted': { 'zh-CN': '已压缩 · 预估', 'zh-TW': '已壓縮 · 預估', en: 'Compacted · Est.' },
  'key.pill.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Reading' },
  'key.takeaway.90': { 'zh-CN': '⚠ 上下文已消耗 {pct}%，仅剩约 {rem} tokens，接近预算上限！建议清理冗余上下文。', 'zh-TW': '⚠ 上下文已消耗 {pct}%，僅剩約 {rem} tokens，接近預算上限！建議清理多餘上下文。', en: '⚠ Context usage is at {pct}% (~{rem} tokens left), near the limit. Consider trimming context.' },
  'key.takeaway.75': { 'zh-CN': '⚡ 已使用 {pct}%，剩余可用空间约 {rem} tokens，注意大文件或长输出。', 'zh-TW': '⚡ 已使用 {pct}%，剩餘可用空間約 {rem} tokens，注意大型檔案或長輸出。', en: '⚡ {pct}% used (~{rem} tokens left). Watch large files or long outputs.' },
  'key.takeaway.ok': { 'zh-CN': '✔ 当前用量健康（{pct}%），剩余可用空间充足（约 {rem} tokens），可正常继续对话。', 'zh-TW': '✔ 目前用量健康（{pct}%），剩餘可用空間充足（約 {rem} tokens），可正常繼續對話。', en: '✔ Healthy usage ({pct}%), plenty of room (~{rem} tokens left).' },
  'key.takeaway.compacting': { 'zh-CN': '⏳ 正在压缩上下文历史，完成后将立即更新剩余窗口空间…', 'zh-TW': '⏳ 正在壓縮上下文歷史，完成後將立即更新剩餘視窗空間…', en: '⏳ Compacting context history; remaining window space will update once complete…' },
  'key.takeaway.compacted': { 'zh-CN': '✔ 上下文已完成压缩（当前预估约 {pct}%，剩余约 {rem} tokens），发送下一条消息后自动校准为服务端精确统计。', 'zh-TW': '✔ 上下文已完成壓縮（目前預估約 {pct}%，剩餘約 {rem} tokens），傳送下一則訊息後自動校準為伺服器端精確統計。', en: '✔ Context compacted (~{pct}% est., ~{rem} tokens left). Exact server stats will resume on your next message.' },
  'key.takeaway.est': { 'zh-CN': 'ℹ 当前主要依赖本地估算或待服务端返回实际统计，暂不计算精确剩余空间。', 'zh-TW': 'ℹ 目前主要依賴本機估算或待伺服器端回傳實際統計，暫不計算精確剩餘空間。', en: 'ℹ Relying on local estimates or awaiting server stats; exact remaining space unavailable.' },
  'speed.pill.fast': { 'zh-CN': '极速', 'zh-TW': '極速', en: 'Fast' },
  'speed.pill.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'Smooth' },
  'speed.pill.good': { 'zh-CN': '良好', 'zh-TW': '良好', en: 'Good' },
  'speed.pill.slow': { 'zh-CN': '偏慢', 'zh-TW': '偏慢', en: 'Slow' },
  'speed.pill.calc': { 'zh-CN': '计算中', 'zh-TW': '計算中', en: 'Calculating' },
  'speed.pill.idle': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
  'speed.takeaway.ok': { 'zh-CN': '✔ 最新输出{tone}（{tps} tok/s{stream}），总耗时 {dur}s 内生成 {tok} tokens{model}{avgPart}。', 'zh-TW': '✔ 最新輸出{tone}（{tps} tok/s{stream}），總耗時 {dur}s 內產生 {tok} tokens{model}{avgPart}。', en: '✔ Latest output {tone} ({tps} tok/s{stream}), generated {tok} tokens in {dur}s{model}{avgPart}.' },
  'speed.avgPart': { 'zh-CN': '；会话平均 {avgTps} tok/s（共 {count} 轮，累计 {totalTok} tokens / {totalDur}s）', 'zh-TW': '；工作階段平均 {avgTps} tok/s（共 {count} 輪，累計 {totalTok} tokens / {totalDur}s）', en: '; session avg {avgTps} tok/s ({count} turns, {totalTok} tokens / {totalDur}s)' },
  'speed.takeaway.avgInline': { 'zh-CN': ' · 会话平均 {avgTps} tok/s（共 {count} 轮）', 'zh-TW': ' · 工作階段平均 {avgTps} tok/s（共 {count} 輪）', en: ' · Session avg {avgTps} tok/s ({count} turns)' },
  'speed.tone.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'smooth' },
  'speed.tone.steady': { 'zh-CN': '平稳', 'zh-TW': '平穩', en: 'steady' },
  'speed.streamPart': { 'zh-CN': '，纯流式传输达 {tps} tok/s', 'zh-TW': '，純串流傳輸達 {tps} tok/s', en: ', streaming {tps} tok/s' },
  'speed.takeaway.idle': { 'zh-CN': 'ℹ 等待当前或下一次模型输出完成，将自动计算精确输出速度 (tok/s)、首字延迟与总耗时。', 'zh-TW': 'ℹ 等待目前或下一次模型輸出完成，將自動計算精確輸出速度 (tok/s)、首字延遲與總耗時。', en: 'ℹ Waiting for the next model response to measure output speed (tok/s), TTFT, and duration.' },
  'tech.modelPlaceholder': { 'zh-CN': '模型标识：{id}', 'zh-TW': '模型識別：{id}', en: 'Model ID: {id}' },
  'tech.modelMissing': { 'zh-CN': '未返回模型信息', 'zh-TW': '未回傳模型資訊', en: 'No model info returned' },
  'tech.req.exceeded': { 'zh-CN': '输入超限（已失败）', 'zh-TW': '輸入超限（已失敗）', en: 'Input limit exceeded (failed)' },
  'tech.req.network': { 'zh-CN': '网络故障（非超限）', 'zh-TW': '網路故障（非超限）', en: 'Network error (not overflow)' },
  'tech.req.failed': { 'zh-CN': '已失败', 'zh-TW': '已失敗', en: 'Failed' },
  'tech.req.reported': { 'zh-CN': '已返回实际统计', 'zh-TW': '已回傳實際統計', en: 'Actual stats returned' },
  'tech.req.compacting': { 'zh-CN': '正在压缩上下文…', 'zh-TW': '正在壓縮上下文…', en: 'Compacting context…' },
  'tech.req.compacted': { 'zh-CN': '已压缩（待下一轮实测校准）', 'zh-TW': '已壓縮（待下一輪實測校準）', en: 'Compacted (awaiting next turn calibration)' },
  'tech.req.estimated': { 'zh-CN': '只有本地估算', 'zh-TW': '只有本機估算', en: 'Local estimate only' },
  'tech.req.waiting': { 'zh-CN': '等待统计，未确认执行状态', 'zh-TW': '等待統計，未確認執行狀態', en: 'Awaiting stats; status unconfirmed' },
  'tech.actual.exceeded': { 'zh-CN': '>{val}（实际总数未返回）', 'zh-TW': '>{val}（實際總數未回傳）', en: '>{val} (actual total not returned)' },
  'tech.actual.exceededNoLim': { 'zh-CN': '已超限；实际数值未知', 'zh-TW': '已超限；實際數值未知', en: 'Exceeded; actual count unknown' },
  'tech.actual.compacted': { 'zh-CN': '待压缩后首条消息返回', 'zh-TW': '待壓縮後首則訊息回傳', en: 'Pending first post-compact message' },
  'tech.actual.unknown': { 'zh-CN': '真实用量未知', 'zh-TW': '真實用量未知', en: 'Actual usage unknown' },
  'tech.est.val': { 'zh-CN': '约 {val} · {note}', 'zh-TW': '約 {val} · {note}', en: '~{val} · {note}' },
  'tech.est.under': { 'zh-CN': '已证实低估', 'zh-TW': '已證實低估', en: 'Confirmed underestimate' },
  'tech.est.compacted': { 'zh-CN': '压缩后窗口预估', 'zh-TW': '壓縮後視窗預估', en: 'Post-compact window est.' },
  'tech.est.ref': { 'zh-CN': '仅供参考', 'zh-TW': '僅供參考', en: 'For reference only' },
  'tech.est.none': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
  'tech.svcLim.val': { 'zh-CN': '{val}（仅该次错误证据）', 'zh-TW': '{val}（僅該次錯誤證據）', en: '{val} (from this error)' },
  'tech.svcLim.none': { 'zh-CN': '本次没有服务端限制证据', 'zh-TW': '本次沒有伺服器端限制證據', en: 'No server limit evidence' },
  'tech.pct.val': { 'zh-CN': '{pct}%（非 1M 总容量）', 'zh-TW': '{pct}%（非 1M 總容量）', en: '{pct}% (not 1M cap)' },
  'tech.pct.compactedVal': { 'zh-CN': '~{pct}%（按压缩后估算）', 'zh-TW': '~{pct}%（按壓縮後估算）', en: '~{pct}% (post-compact est.)' },
  'tech.pct.none': { 'zh-CN': '不提供安全余量百分比', 'zh-TW': '不提供安全餘量百分比', en: 'Headroom % unavailable' },
  'tech.summaries.withCheckpoints': { 'zh-CN': '{range} · 共 {count} 次压缩（最近 #{step}）', 'zh-TW': '{range} · 共 {count} 次壓縮（最近 #{step}）', en: '{range} · {count} compaction(s) (latest #{step})' },
  'tech.plusUnknown': { 'zh-CN': ' ＋ 未知内容', 'zh-TW': ' ＋ 未知內容', en: ' + unknown' },
  'tech.plusUnknownShort': { 'zh-CN': ' ＋ 未知', 'zh-TW': ' ＋ 未知', en: ' + unknown' },
  'tech.scanIncomplete': { 'zh-CN': '扫描未完成', 'zh-TW': '掃描未完成', en: 'Scan incomplete' },
  'tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
  'tech.stepsVal': { 'zh-CN': '{steps} 条；{user} 条用户消息／{assistant} 条回复', 'zh-TW': '{steps} 筆；{user} 則使用者訊息／{assistant} 則回覆', en: '{steps} steps; {user} user / {assistant} assistant' },
  'tech.stepsNone': { 'zh-CN': '尚未完成全量读取', 'zh-TW': '尚未完成全量讀取', en: 'Full history not loaded yet' },
  'tech.coverageVal': { 'zh-CN': '{total} 个附件条目（{user} 个上传、{assistant} 个模型/工具输出）；{read} 个已读到文本，{unknown} 个含未计内容。{rescan}{err}', 'zh-TW': '{total} 個附件項目（{user} 個上傳、{assistant} 個模型/工具輸出）；{read} 個已讀到文字，{unknown} 個含未計內容。{rescan}{err}', en: '{total} attachment(s) ({user} uploaded, {assistant} model/tool); {read} readable, {unknown} with unread content.{rescan}{err}' },
  'tech.coverageRescan': { 'zh-CN': ' 正在重新扫描…', 'zh-TW': ' 正在重新掃描…', en: ' Rescanning…' },
  'tech.coverageErr': { 'zh-CN': ' 最近重扫失败，当前为旧结果：{err}', 'zh-TW': ' 最近重掃失敗，目前為舊結果：{err}', en: ' Latest rescan failed (showing prior data): {err}' },
  'tech.coverageScanning': { 'zh-CN': '正在扫描整段归档，不依赖页面已加载的聊天条数。', 'zh-TW': '正在掃描整段封存，不依賴頁面已載入的聊天筆數。', en: 'Scanning full archive regardless of rendered chat items.' },
  'tech.updatedVal': { 'zh-CN': '请求统计 {req} · 全量扫描 {scan}', 'zh-TW': '請求統計 {req} · 全量掃描 {scan}', en: 'Request stats {req} · Full scan {scan}' },
  'tech.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
  'tech.unfinished': { 'zh-CN': '未完成', 'zh-TW': '未完成', en: 'Pending' },
  'files.reading': { 'zh-CN': '正在读取全量会话附件引用…', 'zh-TW': '正在讀取全量工作階段附件引用…', en: 'Reading session attachment references…' },
  'files.empty': { 'zh-CN': '归档中没有上传附件引用。', 'zh-TW': '封存中沒有上傳附件引用。', en: 'No attachment references in archive.' },
  'files.refs': { 'zh-CN': '（引用 {n} 次）', 'zh-TW': '（引用 {n} 次）', en: ' ({n} refs)' },
  'files.px': { 'zh-CN': '{w}×{h} 像素', 'zh-TW': '{w}×{h} 像素', en: '{w}×{h} px' },
  'files.chars': { 'zh-CN': '{n} 字符', 'zh-TW': '{n} 字元', en: '{n} chars' },
  'files.tokUnknown': { 'zh-CN': '内容 token 未知', 'zh-TW': '內容 token 未知', en: 'Token count unknown' },
  'files.assistantPrefix': { 'zh-CN': '模型输出附件 · ', 'zh-TW': '模型輸出附件 · ', en: 'Model/tool attachment · ' },
  'files.sheets': { 'zh-CN': ' · {sheets} 个工作表，{cells} 个单元格', 'zh-TW': ' · {sheets} 個工作表，{cells} 個儲存格', en: ' · {sheets} sheets, {cells} cells' },
  'files.hiddenSheets': { 'zh-CN': '（含 {n} 个隐藏表）', 'zh-TW': '（含 {n} 個隱藏工作表）', en: ' ({n} hidden)' },
  'files.unknownPrefix': { 'zh-CN': '未计全：{parts}', 'zh-TW': '未計全：{parts}', en: 'Partial: {parts}' },

  // 热力图与 Token 用量弹窗
  'heat.today': { 'zh-CN': '（今日）', 'zh-TW': '（今日）', en: ' (Today)' },
  'heat.firstUse': { 'zh-CN': '（首次使用）', 'zh-TW': '（首次使用）', en: ' (First use)' },
  'heat.future': { 'zh-CN': '未来日期（待产生记录）', 'zh-TW': '未來日期（尚無記錄）', en: 'Future date (no records yet)' },
  'heat.prompt': { 'zh-CN': '提示词', 'zh-TW': '提示詞', en: 'Prompt' },
  'heat.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'heat.cache': { 'zh-CN': '缓存', 'zh-TW': '快取', en: 'Cache' },
  'heat.weeklyTotal': { 'zh-CN': 'Weekly Total · 周累计 (折合日均 ${avg})', 'zh-TW': 'Weekly Total · 週累計 (折合日均 ${avg})', en: 'Weekly Total (daily avg ${avg})' },
  'heat.cumSuffix': { 'zh-CN': ' (累计)', 'zh-TW': ' (累計)', en: ' (Cumulative)' },
  'heat.cumTotal': { 'zh-CN': 'Cumulative Total · 截至当日累计 (折合日均 ${avg})', 'zh-TW': 'Cumulative Total · 截至當日累計 (折合日均 ${avg})', en: 'Cumulative Total to Date (daily avg ${avg})' },
  'heat.activeDays': { 'zh-CN': '${avg} ({days}天)', 'zh-TW': '${avg} ({days}天)', en: '${avg} ({days}d)' },
  'heat.roi': { 'zh-CN': '{ratio}x 回本', 'zh-TW': '{ratio}x 回本', en: '{ratio}x ROI' },
  'heat.peak': { 'zh-CN': '峰值', 'zh-TW': '尖峰', en: 'Peak' },

  // 模型卡片折叠详情、历史分组与按钮状态补齐
  'models.card.detailsToggle': { 'zh-CN': '实测预算、速度与内部详情', 'zh-TW': '實測預算、速度與內部詳情', en: 'Observed budget, speed & details' },
  'models.list.historyGroup': { 'zh-CN': '仅历史记录 / 本地设置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / Local Only' },
  'models.list.historyTag': { 'zh-CN': '仅历史', 'zh-TW': '僅歷史', en: 'History' },
  'models.btn.partialBlocked': { 'zh-CN': '需先还原后端', 'zh-TW': '需先還原後端', en: 'Restore backend first' },
  'models.btn.retryApply': { 'zh-CN': '重新检测并应用', 'zh-TW': '重新偵測並套用', en: 'Retry detect & apply' },
  'models.btn.unsupported': { 'zh-CN': '当前环境不可应用', 'zh-TW': '目前環境無法套用', en: 'Unsupported environment' },
  'header.theme.aria': { 'zh-CN': '切换浅色/深色主题', 'zh-TW': '切換淺色/深色主題', en: 'Toggle light/dark theme' },
  'header.theme.title': { 'zh-CN': '当前：跟随IDE（点击切换：浅色 / 深色 / 自动）', 'zh-TW': '目前：跟隨IDE（點擊切換：淺色 / 深色 / 自動）', en: 'Current: Follow IDE (click to cycle Light / Dark / Auto)' },

  // 订阅详情与地区/币种选择
  'plan.detail.toggleOpen': { 'zh-CN': '详情 ▼', 'zh-TW': '詳細資訊 ▼', en: 'Details ▼' },
  'plan.detail.toggleClose': { 'zh-CN': '详情收回 ▲', 'zh-TW': '收回詳細資訊 ▲', en: 'Hide ▲' },
  'plan.detail.title': { 'zh-CN': '💎 AI 订阅与额度详情', 'zh-TW': '💎 AI 訂閱與額度詳細資訊', en: '💎 AI Subscription & Credits' },
  'plan.summary.identified': { 'zh-CN': '自动识别', 'zh-TW': '自動識別', en: 'Auto-detected' },
  'plan.summary.custom': { 'zh-CN': '自定义套餐', 'zh-TW': '自訂方案', en: 'Custom plan' },
  'plan.summary.unknown': { 'zh-CN': '默认估算', 'zh-TW': '預設估算', en: 'Default estimate' },
  'plan.summary.justNow': { 'zh-CN': '刚刚更新', 'zh-TW': '剛剛更新', en: 'Just now' },
  'plan.summary.perMonth': { 'zh-CN': '/月', 'zh-TW': '/月', en: '/mo' },
  'plan.summary.freeWithPlan': { 'zh-CN': '随套餐免费', 'zh-TW': '隨方案免費', en: 'Included' },
  'plan.summary.priceUnsetShort': { 'zh-CN': '待选择档位', 'zh-TW': '待選擇檔位', en: 'Tier unset' },
  'plan.summary.priceUnsetCny': { 'zh-CN': '请选择 Ultra 倍率', 'zh-TW': '請選擇 Ultra 倍率', en: 'Select Ultra tier' },
  'plan.summary.priceBadgeTitle': { 'zh-CN': '当前订阅费用与最新汇率换算参考 · 点击展开或收起详情', 'zh-TW': '目前訂閱費用與最新匯率換算參考 · 點擊展開或收起詳細資訊', en: 'Current subscription fee and FX estimate · click to toggle details' },
  'plan.tier.aria': { 'zh-CN': '套餐规格与档位覆盖', 'zh-TW': '方案規格與檔位覆蓋', en: 'Plan tier override' },
  'plan.tier.title': { 'zh-CN': '套餐规格与档位覆盖 · 可手动指定 5x 或 20x 档位或自动检测', 'zh-TW': '方案規格與檔位覆蓋 · 可手動指定 5x 或 20x 檔位或自動檢測', en: 'Plan tier override · choose 5x, 20x or auto-detect' },
  'plan.tier.auto': { 'zh-CN': '✨ 自动检测', 'zh-TW': '✨ 自動檢測', en: '✨ Auto-detect' },
  'plan.tier.free': { 'zh-CN': '免费版', 'zh-TW': '免費版', en: 'Free' },
  'plan.tier.plus': { 'zh-CN': 'Google AI Plus', 'zh-TW': 'Google AI Plus', en: 'Google AI Plus' },
  'plan.tier.pro': { 'zh-CN': 'Google AI Pro', 'zh-TW': 'Google AI Pro', en: 'Google AI Pro' },
  'plan.tier.ultra': { 'zh-CN': 'Google AI Ultra', 'zh-TW': 'Google AI Ultra', en: 'Google AI Ultra' },
  'plan.tier.ultra5x': { 'zh-CN': 'Google AI Ultra 5x', 'zh-TW': 'Google AI Ultra 5x', en: 'Google AI Ultra 5x' },
  'plan.tier.ultra20x': { 'zh-CN': 'Google AI Ultra 20x', 'zh-TW': 'Google AI Ultra 20x', en: 'Google AI Ultra 20x' },
  'plan.dt.plan': { 'zh-CN': '当前套餐', 'zh-TW': '目前方案', en: 'Plan' },
  'plan.dt.account': { 'zh-CN': '当前账号', 'zh-TW': '目前帳號', en: 'Account' },
  'plan.dt.country': { 'zh-CN': '账号所在地区', 'zh-TW': '帳號所在地區', en: 'Account country' },
  'plan.dt.region': { 'zh-CN': '订阅国家', 'zh-TW': '訂閱國家', en: 'Billing country' },
  'plan.dt.currency': { 'zh-CN': '订阅币种', 'zh-TW': '訂閱幣別', en: 'Currency' },
  'plan.dt.acq': { 'zh-CN': '获取方式', 'zh-TW': '取得方式', en: 'Source' },
  'plan.dt.price': { 'zh-CN': '计费周期与价格', 'zh-TW': '計費週期與價格', en: 'Billing & price' },
  'plan.dt.specs': { 'zh-CN': '套餐权益', 'zh-TW': '方案權益', en: 'Plan specs' },
  'plan.dt.validity': { 'zh-CN': '权益有效期', 'zh-TW': '權益有效期限', en: 'Valid until' },
  'plan.dt.note': { 'zh-CN': '补充备注', 'zh-TW': '補充備註', en: 'Note' },
  'plan.dt.promptCredits': { 'zh-CN': 'Prompt 额度池', 'zh-TW': 'Prompt 額度池', en: 'Prompt credits' },
  'plan.dt.flowCredits': { 'zh-CN': 'Flow 额度池', 'zh-TW': 'Flow 額度池', en: 'Flow credits' },
  'plan.dt.updated': { 'zh-CN': '状态更新时间', 'zh-TW': '狀態更新時間', en: 'Updated' },
  'plan.account.unknown': { 'zh-CN': '未识别当前登录邮箱', 'zh-TW': '未識別目前登入信箱', en: 'Signed-in email not detected' },
  'plan.country.auto': { 'zh-CN': '🌐 未设置 / 自动', 'zh-TW': '🌐 未設定 / 自動', en: '🌐 Unset / Auto' },
  'plan.tag.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
  'plan.tag.custom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
  'plan.tag.promo': { 'zh-CN': '活动权益', 'zh-TW': '活動權益', en: 'Promo' },
  'plan.tag.manualFree': { 'zh-CN': '免费', 'zh-TW': '免費', en: 'Free' },
  'plan.tag.userPaid': { 'zh-CN': '用户实付', 'zh-TW': '用戶實付', en: 'Paid' },
  'plan.tag.official': { 'zh-CN': '官方定价', 'zh-TW': '官方定價', en: 'Official price' },
  'plan.tag.publicRef': { 'zh-CN': '官方参考价', 'zh-TW': '官方參考價', en: 'Official ref' },
  'plan.tag.regionRef': { 'zh-CN': '官方定价', 'zh-TW': '官方定價', en: 'Official price' },
  'plan.tag.unset': { 'zh-CN': '待选档位', 'zh-TW': '待選檔位', en: 'Tier unset' },
  'plan.source.autoDetected': { 'zh-CN': '自动识别', 'zh-TW': '自動識別', en: 'Auto-detected' },
  'plan.source.customPlan': { 'zh-CN': '自定义套餐', 'zh-TW': '自訂方案', en: 'Custom plan' },
  'plan.source.hostLive': { 'zh-CN': '宿主实报', 'zh-TW': '宿主實報', en: 'Host live' },
  'plan.source.planEstimate': { 'zh-CN': '套餐估算', 'zh-TW': '方案估算', en: 'Plan estimate' },
  'plan.source.officialBase': { 'zh-CN': '官方基准', 'zh-TW': '官方基準', en: 'Official ref' },
  'plan.credits.hostActualPrefix': { 'zh-CN': '账号实报 · ', 'zh-TW': '帳號實報 · ', en: 'Host live · ' },
  'plan.credits.officialFlowMonthly': { 'zh-CN': '官方 Flow +{n}/月', 'zh-TW': '官方 Flow +{n}/月', en: 'Official Flow +{n}/mo' },
  'plan.price.tableSnapshot': { 'zh-CN': '价表快照 {date}', 'zh-TW': '價表快照 {date}', en: 'Pricing snapshot {date}' },
  'plan.specs.windowMul': { 'zh-CN': '额度 {val}', 'zh-TW': '額度 {val}', en: 'Quota {val}' },
  'plan.specs.storage': { 'zh-CN': '存储 {val}', 'zh-TW': '空間 {val}', en: 'Storage {val}' },
  'plan.specs.cloudCredits': { 'zh-CN': 'Cloud Credits {val}', 'zh-TW': 'Cloud Credits {val}', en: 'Cloud Credits {val}' },
  'plan.ultraRangePrice': { 'zh-CN': '$99.99–$199.99/月', 'zh-TW': '$99.99–$199.99/月', en: '$99.99–$199.99/mo' },
  'plan.priceUnsetNote': { 'zh-CN': '待选择 Ultra 具体档位 · 不套用 Pro $19.99', 'zh-TW': '待選擇 Ultra 具體檔位 · 不套用 Pro $19.99', en: 'Select Ultra tier · Pro $19.99 ref not applied' },
  'plan.ultraSubtierUnknown': { 'zh-CN': 'Google AI Ultra', 'zh-TW': 'Google AI Ultra', en: 'Google AI Ultra' },
  'plan.acq.normal': { 'zh-CN': '正常付费订阅', 'zh-TW': '正常付費訂閱', en: 'Standard Paid Plan' },
  'plan.cycle.monthly': { 'zh-CN': '月付', 'zh-TW': '月繳', en: 'Monthly' },
  'plan.cycle.yearly': { 'zh-CN': '年付', 'zh-TW': '年繳', en: 'Yearly' },
  'plan.cycle.oneTime': { 'zh-CN': '单次', 'zh-TW': '單次', en: 'One-time' },
  'plan.cny.approx': { 'zh-CN': '≈ {val}', 'zh-TW': '≈ {val}', en: '≈ {val}' },
  'models.restartConfirm.title': { 'zh-CN': '重启 Antigravity 客户端', 'zh-TW': '重新啟動 Antigravity 用戶端', en: 'Restart Antigravity Client' },
  'plan.price.modePreset': { 'zh-CN': '跟随参考价', 'zh-TW': '跟隨參考價', en: 'Use reference' },
  'plan.price.modeCustom': { 'zh-CN': '自定义实付', 'zh-TW': '自訂實付', en: 'Custom paid' },
  'plan.btn.editCustom': { 'zh-CN': '自定义订阅设置', 'zh-TW': '自訂訂閱設定', en: 'Customize plan' },
  'plan.credits.avail': { 'zh-CN': '{avail} 可用 / {monthly} 月额度', 'zh-TW': '{avail} 可用 / {monthly} 月額度', en: '{avail} left / {monthly} monthly' },
  'plan.validity.expired': { 'zh-CN': '至 {date} · ⚠️ 权益已到期', 'zh-TW': '至 {date} · ⚠️ 權益已到期', en: 'Until {date} · ⚠️ Expired' },
  'plan.validity.active': { 'zh-CN': '至 {date} · 有效期内', 'zh-TW': '至 {date} · 有效期內', en: 'Until {date} · Active' },
  'plan.form.title': { 'zh-CN': '设置当前账号订阅信息', 'zh-TW': '設定目前帳號訂閱資訊', en: 'Configure Account Subscription' },
  'plan.form.acqLabel': { 'zh-CN': '获取方式 / 活动来源', 'zh-TW': '取得方式 / 活動來源', en: 'Acquisition / Promo Source' },
  'plan.form.acqCustomLabel': { 'zh-CN': '自定义活动 / 合作方名称', 'zh-TW': '自訂活動 / 合作夥伴名稱', en: 'Custom Promo / Partner Name' },
  'plan.form.acqCustomPh': { 'zh-CN': '选填，如 Pixel 11 Pro 赠送', 'zh-TW': '選填，如 Pixel 11 Pro 贈送', en: 'Optional, e.g. Pixel bundle' },
  'plan.form.zeroExtra': { 'zh-CN': '本权益期间无需另付订阅费', 'zh-TW': '本權益期間無需另付訂閱費', en: 'No extra subscription fee during this period' },
  'plan.form.presetLabel': { 'zh-CN': '预设订阅国家与汇率 · 可选快捷套用', 'zh-TW': '預設訂閱國家與匯率 · 可選快速套用', en: 'Region & FX Preset · optional' },
  'plan.form.countryLabel': { 'zh-CN': '账号所在地区 · 仅本地记录', 'zh-TW': '帳號所在地區 · 僅本機記錄', en: 'Account Country · local only' },
  'plan.form.regionLabel': { 'zh-CN': '订阅国家 · 购买与结算地区', 'zh-TW': '訂閱國家 · 購買與結算地區', en: 'Billing Country' },
  'plan.form.currencyLabel': { 'zh-CN': '订阅币种与实付金额', 'zh-TW': '訂閱幣別與實付金額', en: 'Currency & Paid Amount' },
  'plan.form.paidPh': { 'zh-CN': '实付金额', 'zh-TW': '實付金額', en: 'Amount' },
  'plan.form.cycleLabel': { 'zh-CN': '计费周期', 'zh-TW': '計費週期', en: 'Billing Cycle' },
  'plan.form.validEndLabel': { 'zh-CN': '权益到期日', 'zh-TW': '權益到期日', en: 'Expiration Date' },
  'plan.form.noteLabel': { 'zh-CN': '补充说明备注', 'zh-TW': '補充說明備註', en: 'Notes' },
  'plan.form.notePh': { 'zh-CN': '例如：Pixel 11 Pro 赠送 6 个月 / 家庭拼车', 'zh-TW': '例如：Pixel 11 Pro 贈送 6 個月 / 家庭共享', en: 'e.g. Device promo / family sharing' },
  'plan.form.clear': { 'zh-CN': '清除自定义', 'zh-TW': '清除自訂', en: 'Clear custom' },
  'plan.form.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'plan.form.save': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },

  // API 参考金额与展开详情
  'cost.title': { 'zh-CN': '💰 本期 API 参考金额', 'zh-TW': '💰 本期 API 參考金額', en: '💰 Period API Reference Cost' },
  'cost.periodTag': { 'zh-CN': '本月自然月', 'zh-TW': '本月自然月', en: 'This Calendar Month' },
  'cost.calendarMonth': { 'zh-CN': '自然月', 'zh-TW': '自然月', en: 'Calendar Month' },
  'cost.periodTagFmt': { 'zh-CN': '{ym} (自然月)', 'zh-TW': '{ym} (自然月)', en: '{ym} (Calendar Month)' },
  'cost.nonPaidBadge': { 'zh-CN': 'API折算 · 非实付', 'zh-TW': 'API換算 · 非實付', en: 'API Est. · Not Billed' },
  'cost.subUnknown': { 'zh-CN': '订阅实付：未填写', 'zh-TW': '訂閱實付：未填寫', en: 'Plan paid: Not set' },
  'cost.btnFill': { 'zh-CN': '补充', 'zh-TW': '補充', en: 'Edit' },
  'cost.btnExpand': { 'zh-CN': '展开详情 ▼', 'zh-TW': '展開詳細資訊 ▼', en: 'Show details ▼' },
  'cost.btnCollapse': { 'zh-CN': '收起详情 ▴', 'zh-TW': '收起詳細資訊 ▴', en: 'Hide details ▴' },
  'cost.scopeLabel': { 'zh-CN': '统计范围:', 'zh-TW': '統計範圍:', en: 'Scope:' },
  'cost.scopePeriod': { 'zh-CN': '本期', 'zh-TW': '本期', en: 'This period' },
  'cost.scopeAll': { 'zh-CN': '全量历史', 'zh-TW': '完整歷史紀錄', en: 'All history' },
  'cost.modeLabel': { 'zh-CN': '估值模式:', 'zh-TW': '估算模式:', en: 'Pricing mode:' },
  'cost.modeRef': { 'zh-CN': '参考模型估算', 'zh-TW': '參考模型估算', en: 'Reference model' },
  'cost.modeHybrid': { 'zh-CN': '混合模式', 'zh-TW': '混合模式', en: 'Hybrid' },
  'cost.modeIdentified': { 'zh-CN': '仅已识别模型', 'zh-TW': '僅已識別模型', en: 'Identified only' },
  'cost.card.input': { 'zh-CN': '输入 Token', 'zh-TW': '輸入 Token', en: 'Input Tokens' },
  'cost.card.cache': { 'zh-CN': '缓存读取 (优惠)', 'zh-TW': '快取讀取 (優惠)', en: 'Cache Read (discounted)' },
  'cost.card.output': { 'zh-CN': '输出 Token', 'zh-TW': '輸出 Token', en: 'Output Tokens' },
  'cost.analyzing': { 'zh-CN': '正在分析请求模型与计价覆盖率…', 'zh-TW': '正在分析請求模型與計價覆蓋率…', en: 'Analyzing model calls and pricing coverage…' },
  'cost.disclaimer': {
    'zh-CN': '注：此折算反映按公开零售价调用同等资源之费用，包月订阅/活动赠送与 API 零售非同类计费模式，该差额不等于真实节省现金；缓存读取按 10% 优惠计价；不含缓存存储费与搜索落地费用。缓存可在多次请求中重复读取相同上下文，该总量不代表独立文本量或用户输入字数。',
    'zh-TW': '註：此換算反映依公開零售價呼叫同等資源之費用，包月訂閱/活動贈送與 API 零售非同類計費模式，該差額不等於真實節省現金；快取讀取依 10% 優惠計價；不含快取儲存費與搜尋落地費用。快取可在多次請求中重複讀取相同上下文，該總量不代表獨立文字量或使用者輸入字數。',
    en: 'Note: Estimates reflect public API retail rates for equivalent usage. Subscriptions/promos differ from pay-as-you-go API billing; differences do not equal cash saved. Cache reads are priced at 10%; storage and grounding fees are excluded. Repeated cache reads do not represent unique text.'
  },

  // Token 统计与热力图控制
  'tokens.titleCost': { 'zh-CN': 'API 价格折算', 'zh-TW': 'API 價格換算', en: 'API Equivalent Cost' },
  'tokens.firstUse': { 'zh-CN': '首次使用：{date}', 'zh-TW': '首次使用：{date}', en: 'First use: {date}' },
  'tokens.heat.presetLabel': { 'zh-CN': '5 档色阶预设：', 'zh-TW': '5 檔色階預設：', en: '5-step presets:' },
  'tokens.heat.presetPurple': { 'zh-CN': '紫色系', 'zh-TW': '紫色系', en: 'Purple' },
  'tokens.heat.presetYellow': { 'zh-CN': '黄色系', 'zh-TW': '黃色系', en: 'Yellow' },
  'tokens.heat.presetGreen': { 'zh-CN': '绿色系', 'zh-TW': '綠色系', en: 'Green' },
  'tokens.heat.presetBlue': { 'zh-CN': '蓝色系', 'zh-TW': '藍色系', en: 'Blue' },
  'tokens.heat.presetRed': { 'zh-CN': '红色系', 'zh-TW': '紅色系', en: 'Red' },
  'tokens.heat.customTitle': { 'zh-CN': '5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：', 'zh-TW': '5 檔逐格獨立自訂（點擊任意一格或圖例「少 ▢▢▢▢▢ 多」單獨調色，可設 5 種不同顏色）：', en: 'Customize each of the 5 steps independently:' },
  'tokens.heat.resetLvls': { 'zh-CN': '恢复 5 档预设', 'zh-TW': '還原 5 檔預設', en: 'Reset 5 steps' },
  'tokens.heat.lvl0': { 'zh-CN': '1档 · 少/无', 'zh-TW': '1檔 · 少/無', en: 'L1 · None/Min' },
  'tokens.heat.lvl1': { 'zh-CN': '2档 · 低', 'zh-TW': '2檔 · 低', en: 'L2 · Low' },
  'tokens.heat.lvl2': { 'zh-CN': '3档 · 中', 'zh-TW': '3檔 · 中', en: 'L3 · Med' },
  'tokens.heat.lvl3': { 'zh-CN': '4档 · 高', 'zh-TW': '4檔 · 高', en: 'L4 · High' },
  'tokens.heat.lvl4': { 'zh-CN': '5档 · 多/峰', 'zh-TW': '5檔 · 多/尖峰', en: 'L5 · Peak' },
  'tokens.heat.btnPreset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
  'tokens.heat.lowEnd': { 'zh-CN': '色阶「少」端颜色（自动插值）', 'zh-TW': '色階「少」端顏色（自動插值）', en: 'Low end color (auto-interpolated)' },
  'tokens.heat.highEnd': { 'zh-CN': '色阶「多」端颜色（自动插值）', 'zh-TW': '色階「多」端顏色（自動插值）', en: 'High end color (auto-interpolated)' },
  'tokens.heat.panelBg': { 'zh-CN': '面板与菜单统一背景色', 'zh-TW': '面板與選單統一背景色', en: 'Unified panel background' },
  'tokens.heat.accentColors': { 'zh-CN': '累计与强调指标色', 'zh-TW': '累計與強調指標色', en: 'Total & accent colors' },
  'tokens.colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨佈景主題', en: 'Follow theme' },

  // 动态费用明细与 Token 卡片补齐
  'cost.titleAll': { 'zh-CN': '💰 全量 API 参考金额', 'zh-TW': '💰 全量 API 參考金額', en: '💰 All-Time API Reference Cost' },
  'cost.allHistory': { 'zh-CN': '全历史累计', 'zh-TW': '全歷史累計', en: 'All history' },
  'cost.approx': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },
  'cost.notReady': { 'zh-CN': '数据未就绪', 'zh-TW': '資料尚未就緒', en: 'Not ready' },
  'cost.noRecords': { 'zh-CN': '暂无记录', 'zh-TW': '暫無記錄', en: 'No records' },
  'cost.unpriced': { 'zh-CN': '暂无法估值', 'zh-TW': '暫無法估值', en: 'Unpriced' },
  'cost.refSub': { 'zh-CN': '统一按 {model} 估算 (输入 ${in} / 缓存 ${ca} / 输出 ${out} 每百万 Token)', 'zh-TW': '統一依 {model} 估算 (輸入 ${in} / 快取 ${ca} / 輸出 ${out} 每百萬 Token)', en: 'Estimated via {model} (In ${in} / Cache ${ca} / Out ${out} per 1M)' },
  'cost.hybridSub': { 'zh-CN': '混合模式：已识别 ${known} + 未知折算 ${res}', 'zh-TW': '混合模式：已識別 ${known} + 未知換算 ${res}', en: 'Hybrid: Identified ${known} + Residual ${res}' },
  'cost.hybridBadge': { 'zh-CN': '混合模式折算', 'zh-TW': '混合模式換算', en: 'Hybrid mode' },
  'cost.identSub': { 'zh-CN': '仅计入 {n} 条已知真实模型调用', 'zh-TW': '僅計入 {n} 筆已知真實模型呼叫', en: 'Only {n} identified model call(s) included' },
  'cost.identSubNone': { 'zh-CN': '当前范围内请求缺少模型型号（未按 $0 计入）', 'zh-TW': '目前範圍內請求缺少模型型號（未按 $0 計入）', en: 'Requests lack model IDs (not counted as $0)' },
  'cost.covPct': { 'zh-CN': '{pct}% 计价覆盖', 'zh-TW': '{pct}% 計價覆蓋', en: '{pct}% priced' },
  'cost.tokCacheDiscount': { 'zh-CN': '{tok} tok (优惠)', 'zh-TW': '{tok} tok (優惠)', en: '{tok} tok (disc.)' },
  'cost.tokResidual': { 'zh-CN': '剩余 {tok} tok', 'zh-TW': '剩餘 {tok} tok', en: 'Rem. {tok} tok' },
  'cost.usageSummary': { 'zh-CN': '累计处理 Token: {total} (含 {cache} 缓存读取)', 'zh-TW': '累計處理 Token: {total} (含 {cache} 快取讀取)', en: 'Total tokens: {total} (incl. {cache} cache)' },
  'cost.diffAll': { 'zh-CN': '全量累计不直接与单月费用做差额比较 · 避免跨月虚高', 'zh-TW': '全量累計不直接與單月費用做差額比較 · 避免跨月虛高', en: 'All-time totals are not compared against monthly fees' },
  'cost.diffFree': { 'zh-CN': '与此 API 方案参考差额 约 +${val} (免费权益使用中 · 不计算无限倍数)', 'zh-TW': '與此 API 方案參考差額 約 +${val} (免費權益使用中 · 不計算無限倍數)', en: 'Diff vs API: ~+${val} (free promo active)' },
  'cost.diffPaid': { 'zh-CN': '与此 API 方案参考差额 {sign}${val} (API折算 - 实际支出 · 仅供参考比较)', 'zh-TW': '與此 API 方案參考差額 {sign}${val} (API換算 - 實際支出 · 僅供參考比較)', en: 'Diff vs API: {sign}${val} (API est. - paid · reference only)' },
  'cost.diffUnknown': { 'zh-CN': '跨币种或实付未知 · 并列展示不计算差额', 'zh-TW': '跨幣別或實付未知 · 並列顯示不計算差額', en: 'Cross-currency or paid amount unknown' },
  'cost.subLineFree': { 'zh-CN': '订阅额外实付：{sym}0 ({src})', 'zh-TW': '訂閱額外實付：{sym}0 ({src})', en: 'Extra plan paid: {sym}0 ({src})' },
  'cost.subLinePaid': { 'zh-CN': '订阅实付：{sym}{val}{cny} ({cycle}{exp})', 'zh-TW': '訂閱實付：{sym}{val}{cny} ({cycle}{exp})', en: 'Plan paid: {sym}{val}{cny} ({cycle}{exp})' },
  'cost.breakdownPrefix': { 'zh-CN': '已识别真实模型明细：{details}{note}。', 'zh-TW': '已識別真實模型明細：{details}{note}。', en: 'Identified models: {details}{note}.' },
  'cost.breakdownNone': { 'zh-CN': '暂无已匹配真实模型', 'zh-TW': '暫無已匹配真實模型', en: 'No matched model calls yet' },
  'tokens.dailyAvg': { 'zh-CN': ' · 日均 ${val}', 'zh-TW': ' · 日均 ${val}', en: ' · Avg ${val}/d' },
  'tokens.firstUseNone': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
  'tokens.srcAllLabel': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All Sources' },
  'tokens.srcDesktopLabel': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },

  // 模型卡片/解锁/异常状态与动态文案补齐
  'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
  'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
  'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
  'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
  'panel.ctx.currentModelUnconfirmed': { 'zh-CN': '当前会话模型待确认，请在输入框选择模型或发送消息', 'zh-TW': '目前工作階段模型待確認，請在輸入框選擇模型或發送訊息', en: 'Active model pending confirmation; select a model or send a message' },
  'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
  'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
  'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
  'models.card.convoIdSide': { 'zh-CN': '发生调用的会话标识', 'zh-TW': '觸發呼叫的工作階段識別碼', en: 'Conversation ID of call' },
  'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
  'models.card.diagnosisSide': { 'zh-CN': '目标值与观测值比对结果', 'zh-TW': '目標值與觀測值比對結果', en: 'Target vs. observed comparison' },
  'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
  'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
  'models.pref.none': { 'zh-CN': '未单独设置（使用默认）', 'zh-TW': '未單獨設定（使用預設）', en: 'Not set (Default)' },
  'models.pref.noneShort': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
  'models.pref.inconsistent': { 'zh-CN': '档位设置不一致', 'zh-TW': '檔位設定不一致', en: 'Effort mismatch' },
  'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
  'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
  'models.card.effortsList': { 'zh-CN': '可用档位：{list}', 'zh-TW': '可用檔位：{list}', en: 'Efforts: {list}' },
  'models.card.effortStandard': { 'zh-CN': '可用档位：标准', 'zh-TW': '可用檔位：標準', en: 'Efforts: Standard' },
  'models.card.sessionEffort': { 'zh-CN': '当前会话：{effort}', 'zh-TW': '目前會話：{effort}', en: 'Session: {effort}' },
  'models.card.unknownEffort': { 'zh-CN': '未知档位', 'zh-TW': '未知檔位', en: 'Unknown Effort' },
  'models.toast.savedUniform': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為該模型儲存統一設定。', en: 'Saved uniform setting for this model.' },
  'models.toast.saveFailed': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save uniform setting: {err}' },
  'models.input.phFollow': { 'zh-CN': '当前为跟随模型（可点 512K 或输入整数）', 'zh-TW': '目前為跟隨模型（可點 512K 或輸入整數）', en: 'Follow model (click 512K or enter integer)' },
  'models.input.phDefault': { 'zh-CN': '当前为默认（可点 512K 或输入整数）', 'zh-TW': '目前為預設（可點 512K 或輸入整數）', en: 'Default (click 512K or enter integer)' },
  'models.input.validFixed': { 'zh-CN': '将设定固定长度：{short}（{full} tokens）', 'zh-TW': '將設定固定長度：{short}（{full} tokens）', en: 'Will set fixed limit: {short} ({full} tokens)' },
  'models.err.noSettingsBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Not connected to host settings bridge' },
  'models.err.noApplyBridge': { 'zh-CN': '未连接到客户端设置桥接', 'zh-TW': '未連線到用戶端設定橋接', en: 'Not connected to client settings bridge' },
  'models.err.noModels': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list.' },
  'models.err.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
  'models.status.line': { 'zh-CN': '当前状态：{badge} · 配置：{mode}', 'zh-TW': '目前狀態：{badge} · 設定：{mode}', en: 'Status: {badge} · Mode: {mode}' },
  'status.client.unavailable': { 'zh-CN': '当前环境无法读取客户端状态', 'zh-TW': '目前環境無法讀取用戶端狀態', en: 'Unable to read client status in this environment' },
  'models.status.restartMismatch': { 'zh-CN': '重启后读到的设置与目标不同（实际：{actual}）', 'zh-TW': '重啟後讀到的設定與目標不同（實際：{actual}）', en: 'Post-restart config differs from target (actual: {actual})' },
  'models.meta.targetDesktop': { 'zh-CN': '桌面端核心服务', 'zh-TW': '桌面端核心服務', en: 'Desktop Core Service' },
  'models.meta.targetDesktopArch': { 'zh-CN': '桌面端核心服务 ({arch})', 'zh-TW': '桌面端核心服務 ({arch})', en: 'Desktop Core Service ({arch})' },
  'models.meta.archUnknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'models.meta.backupStale': { 'zh-CN': '客户端已更新，历史备份已过期', 'zh-TW': '用戶端已更新，歷史備份已過期', en: 'Client updated; legacy backup expired' },
  'models.meta.backupReady': { 'zh-CN': '已自动备份原始文件', 'zh-TW': '已自動備份原始檔案', en: 'Original binary backed up' },
  'models.meta.backupNone': { 'zh-CN': '尚未产生备份（首次修改前自动备份）', 'zh-TW': '尚未產生備份（首次修改前自動備份）', en: 'No backup yet (created before first patch)' },
  'models.credit.openedBrowser': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者貼文', en: 'Opened author thread in default browser' },
  'models.credit.openFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者貼文連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; link copied to clipboard.' },
  'models.credit.copiedLink': { 'zh-CN': '已复制原作者帖子链接', 'zh-TW': '已複製原作者貼文連結', en: 'Author thread link copied' },

  // 异常诊断态
  'diag.ctx.badge': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Limit' },
  'diag.ctx.amount': { 'zh-CN': '服务端超限', 'zh-TW': '伺服器端超限', en: 'Server Limit' },
  'diag.ctx.keyBadge': { 'zh-CN': '已超限', 'zh-TW': '已超限', en: 'Exceeded' },
  'diag.ctx.hover': { 'zh-CN': ' · 100% 已溢出', 'zh-TW': ' · 100% 已超限', en: ' · 100% overflow' },
  'diag.ctx.tipTitle': { 'zh-CN': '上下文窗口（超限告警）：', 'zh-TW': 'Context 視窗（超限警示）：', en: 'Context Window (Exceeded):' },
  'diag.ctx.tipPct': { 'zh-CN': '100% 已用（已超出上限）', 'zh-TW': '100% 已用（已超出上限）', en: '100% used (exceeded)' },
  'diag.ctx.tipDetailLim': { 'zh-CN': '已超上限，共 {lim} token', 'zh-TW': '已超上限，共 {lim} token', en: 'Exceeded {lim} tokens' },
  'diag.ctx.tipDetailDef': { 'zh-CN': '服务端已拒绝输入（超出容量上限）', 'zh-TW': '伺服器端已拒絕輸入（超出容量上限）', en: 'Input rejected by server (over limit)' },
  'diag.ctx.status': { 'zh-CN': '服务端已拒绝：输入超限{lim}。本地估算不可靠，需精简或新建会话。', 'zh-TW': '伺服器端已拒絕：輸入超限{lim}。本機估算不可靠，需精簡或新建會話。', en: 'Server rejected: input exceeded{lim}. Trim context or start a new chat.' },
  'diag.ctx.statusLim': { 'zh-CN': '（上限 {lim} tokens）', 'zh-TW': '（上限 {lim} tokens）', en: ' (limit {lim} tokens)' },
  'diag.ctx.takeaway': { 'zh-CN': '✖ 已超出服务端最大限制{lim}，当前对话已被拒绝。需精简或新建会话。', 'zh-TW': '✖ 已超出伺服器端最大限制{lim}，目前對話已被拒絕。需精簡或新建會話。', en: '✖ Exceeded server max limit{lim}; current chat rejected. Trim or start new chat.' },
  'diag.quota.badge': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Quota' },
  'diag.quota.amount': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Out of Quota' },
  'diag.quota.hover': { 'zh-CN': ' · 模型额度用尽，可切换模型', 'zh-TW': ' · 模型配額用盡，可切換模型', en: ' · Model quota exhausted' },
  'diag.quota.tipTitle': { 'zh-CN': '模型额度（额度耗尽）：', 'zh-TW': '模型額度（額度耗盡）：', en: 'Model Quota (Exhausted):' },
  'diag.quota.tipPct': { 'zh-CN': '当前模型配额已用尽', 'zh-TW': '目前模型配額已用盡', en: 'Current model quota exhausted' },
  'diag.quota.reset': { 'zh-CN': '，预计将于 {time} 重置', 'zh-TW': '，預計將於 {time} 重置', en: ', resets around {time}' },
  'diag.quota.tipDetail': { 'zh-CN': '{pool}额度已耗尽{reset}。可手动切换至其他可用模型', 'zh-TW': '{pool}額度已耗盡{reset}。可手動切換至其他可用模型', en: '{pool} quota exhausted{reset}. Switch to another model.' },
  'diag.quota.status': { 'zh-CN': '模型额度耗尽：{pool}额度已耗尽{reset}。可手动切换至其他可用模型。', 'zh-TW': '模型額度耗盡：{pool}額度已耗盡{reset}。可手動切換至其他可用模型。', en: 'Quota exhausted: {pool} quota depleted{reset}. Switch to another model.' },
  'diag.quota.takeaway': { 'zh-CN': '✖ {pool}额度已耗尽{reset}。可手动切换至其他可用模型继续对话。', 'zh-TW': '✖ {pool}額度已耗盡{reset}。可手動切換至其他可用模型繼續對話。', en: '✖ {pool} quota exhausted{reset}. Switch to another model to continue.' },
  'diag.rate.badge': { 'zh-CN': '限流', 'zh-TW': '限流', en: '429' },
  'diag.rate.amount': { 'zh-CN': '请求限流', 'zh-TW': '請求限流', en: 'Rate Limited' },
  'diag.rate.hover': { 'zh-CN': ' · 触发频率限制，请稍候', 'zh-TW': ' · 已達速率限制，請稍候', en: ' · Rate limited, wait a moment' },
  'diag.rate.tipTitle': { 'zh-CN': '请求限制（请求过频）：', 'zh-TW': '請求限制（請求過頻）：', en: 'Rate Limit (Too Many Requests):' },
  'diag.rate.tipPct': { 'zh-CN': '触发服务端频率限制（429）', 'zh-TW': '觸發伺服器端頻率限制（429）', en: 'Server rate limit (429)' },
  'diag.rate.retry': { 'zh-CN': '（建议等待 {sec} 秒）', 'zh-TW': '（建議等待 {sec} 秒）', en: ' (retry in {sec}s)' },
  'diag.rate.tipDetail': { 'zh-CN': '请求过于频繁{retry}，请稍候重试', 'zh-TW': '請求過於頻繁{retry}，請稍候重試', en: 'Too many requests{retry}, try again later' },
  'diag.rate.status': { 'zh-CN': '请求频率限制：请求过于频繁，触发服务端限制（429）{retry}。稍候重试即可恢复。', 'zh-TW': '請求頻率限制：請求過於頻繁，觸發伺服器端限制（429）{retry}。稍候重試即可恢復。', en: 'Rate limited (429){retry}. Wait and retry.' },
  'diag.rate.takeaway': { 'zh-CN': '⚠ 触发服务端请求频率限制（HTTP 429）{retry}，短时间内发送请求过多，稍候重试即可恢复。', 'zh-TW': '⚠ 觸發伺服器端請求頻率限制（HTTP 429）{retry}，短時間內發送請求過多，稍候重試即可恢復。', en: '⚠ HTTP 429 rate limit{retry}. Wait briefly and retry.' },
  'diag.net.defDiag': { 'zh-CN': '连接中断或超时', 'zh-TW': '連線中斷或逾時', en: 'Connection dropped or timed out' },
  'diag.net.badge': { 'zh-CN': '网络', 'zh-TW': '網路', en: 'Network' },
  'diag.net.amount': { 'zh-CN': '网络故障', 'zh-TW': '網路故障', en: 'Network Error' },
  'diag.net.hover': { 'zh-CN': ' · 连接异常，请检查网络', 'zh-TW': ' · 連線異常，請檢查網路', en: ' · Connection error, check network' },
  'diag.net.tipTitle': { 'zh-CN': '网络连接（连接故障）：', 'zh-TW': '網路連線（連線故障）：', en: 'Network (Connection Failed):' },
  'diag.net.tipPct': { 'zh-CN': '网络连接失败或超时', 'zh-TW': '網路連線失敗或逾時', en: 'Connection failed or timed out' },
  'diag.net.tipDetail': { 'zh-CN': '连接异常（{diag}）。请检查本地网络代理与连接', 'zh-TW': '連線異常（{diag}）。請檢查本機網路代理與連線', en: 'Connection error ({diag}). Check proxy & network.' },
  'diag.net.status': { 'zh-CN': '网络连接异常：{diag}。请检查本地网络代理与网络链路设置。', 'zh-TW': '網路連線異常：{diag}。請檢查本機網路代理與網路鏈路設定。', en: 'Network error: {diag}. Check local proxy and network settings.' },
  'diag.net.takeaway': { 'zh-CN': '✖ 网络连接出现异常（{diag}）。请检查本地网络代理与链路状态。', 'zh-TW': '✖ 網路連線出現異常（{diag}）。請檢查本機網路代理與鏈路狀態。', en: '✖ Network error ({diag}). Check proxy and connection.' },
  'diag.auth.badge': { 'zh-CN': '认证', 'zh-TW': '認證', en: 'Auth' },
  'diag.auth.amount': { 'zh-CN': '认证失败', 'zh-TW': '認證失敗', en: 'Auth Failed' },
  'diag.auth.keyBadge': { 'zh-CN': '认证异常', 'zh-TW': '認證異常', en: 'Auth Error' },
  'diag.auth.hover': { 'zh-CN': ' · 权限不足或登录异常', 'zh-TW': ' · 權限不足或登入異常', en: ' · Unauthorized or session expired' },
  'diag.auth.tipTitle': { 'zh-CN': '账号权限（身份异常）：', 'zh-TW': '帳號權限（身分異常）：', en: 'Account Auth (Error):' },
  'diag.auth.tipPct': { 'zh-CN': '身份认证失败或缺少权限', 'zh-TW': '身分認證失敗或缺少權限', en: 'Authentication failed or unauthorized' },
  'diag.auth.tipDetail': { 'zh-CN': '身份认证失败或无权限访问，请检查账号登录状态', 'zh-TW': '身分認證失敗或無權限存取，請檢查帳號登入狀態', en: 'Auth failed or no access. Check sign-in status.' },
  'diag.auth.status': { 'zh-CN': '身份认证失败或无访问权限，请检查账号登录状态或订阅权限。', 'zh-TW': '身分認證失敗或無存取權限，請檢查帳號登入狀態或訂閱權限。', en: 'Authentication failed or unauthorized (401/403). Check account sign-in.' },
  'diag.auth.takeaway': { 'zh-CN': '✖ 身份认证失败或无访问权限（401/403）。请检查账号登录状态或订阅权限。', 'zh-TW': '✖ 身分認證失敗或無存取權限（401/403）。請檢查帳號登入狀態或訂閱權限。', en: '✖ Auth failed or forbidden (401/403). Check account sign-in or plan.' },
  'diag.svc.badge': { 'zh-CN': '服务异常', 'zh-TW': '服務異常', en: '503' },
  'diag.svc.amount': { 'zh-CN': '服务受限', 'zh-TW': '服務受限', en: 'Unavailable' },
  'diag.svc.hover': { 'zh-CN': ' · 服务端繁忙，请稍候', 'zh-TW': ' · 伺服器端繁忙，請稍候', en: ' · Server overloaded, wait briefly' },
  'diag.svc.tipTitle': { 'zh-CN': '服务端状态（服务受限）：', 'zh-TW': '伺服器端狀態（服務受限）：', en: 'Service Status (Unavailable):' },
  'diag.svc.tipPct': { 'zh-CN': '模型服务暂不可用或过载', 'zh-TW': '模型服務暫不可用或過載', en: 'Model service overloaded or unavailable' },
  'diag.svc.tipDetail': { 'zh-CN': '服务端暂时过载或维护中，请稍后重试', 'zh-TW': '伺服器端暫時過載或維護中，請稍後重試', en: 'Server overloaded or under maintenance. Retry later.' },
  'diag.svc.status': { 'zh-CN': '模型服务暂不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '模型服務暫無法使用或處於高負載（503/Overloaded），請稍後重試。', en: 'Model service unavailable or overloaded (503). Retry later.' },
  'diag.svc.takeaway': { 'zh-CN': '⚠ 服务端暂时不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '⚠ 伺服器端暫時不可用或處於高負載（503/Overloaded），請稍後重試。', en: '⚠ Service unavailable or overloaded (503). Retry later.' },
  'diag.cancel.badge': { 'zh-CN': '已中断', 'zh-TW': '已中斷', en: 'Interrupted' },
  'diag.cancel.amount': { 'zh-CN': '上次中断', 'zh-TW': '上次中斷', en: 'Interrupted' },
  'diag.cancel.hover': { 'zh-CN': ' · 最近一次请求已中断', 'zh-TW': ' · 最近一次請求已中斷', en: ' · Last recorded request interrupted' },
  'diag.cancel.tipTitle': { 'zh-CN': '最近一次请求（已中断）：', 'zh-TW': '最近一次請求（已中斷）：', en: 'Last recorded request (Interrupted):' },
  'diag.cancel.tipPct': { 'zh-CN': '该请求已中断或取消', 'zh-TW': '該請求已中斷或取消', en: 'That request was interrupted or cancelled' },
  'diag.cancel.tipDetail': { 'zh-CN': '仅凭此记录无法确定取消来源或当前请求状态。', 'zh-TW': '僅憑此記錄無法確定取消來源或目前請求狀態。', en: 'This record does not identify who cancelled the request or describe the current request.' },
  'diag.cancel.status': { 'zh-CN': '最近一次请求已中断；当前请求状态请以聊天界面为准。', 'zh-TW': '最近一次請求已中斷；目前請求狀態請以聊天介面為準。', en: 'Last recorded request interrupted; check the chat for the current request state.' },
  'diag.cancel.takeaway': { 'zh-CN': 'ℹ 最近一次记录为请求中断，不代表当前请求失败。', 'zh-TW': 'ℹ 最近一次記錄為請求中斷，不代表目前請求失敗。', en: 'ℹ A recorded request was interrupted; check the chat for the current request state.' },
  'diag.quota.defPool': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Current model' },
  'diag.unknown.badge': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Error' },
  'diag.unknown.amount': { 'zh-CN': '请求异常', 'zh-TW': '請求異常', en: 'Request Error' },
  'diag.unknown.keyBadge': { 'zh-CN': '原因待确认', 'zh-TW': '原因待確認', en: 'Unconfirmed' },
  'diag.unknown.hover': { 'zh-CN': ' · 失败原因待确认', 'zh-TW': ' · 失敗原因待確認', en: ' · Reason unconfirmed' },
  'diag.unknown.tipTitle': { 'zh-CN': '请求状态（原因待确认）：', 'zh-TW': '請求狀態（原因待確認）：', en: 'Request Status (Unconfirmed):' },
  'diag.unknown.tipPct': { 'zh-CN': '最近请求失败（原因未知）', 'zh-TW': '最近請求失敗（原因未知）', en: 'Recent request failed (unknown reason)' },
  'diag.unknown.tipDetail': { 'zh-CN': '当前无法确认具体原因（{diag}）', 'zh-TW': '目前無法確認具體原因（{diag}）', en: 'Cannot confirm exact reason ({diag})' },
  'diag.unknown.status': { 'zh-CN': '最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: 'Recent request failed; cannot confirm exact reason ({diag}).' },
  'diag.unknown.takeaway': { 'zh-CN': '✖ 最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '✖ 最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: '✖ Recent request failed; cannot confirm exact reason ({diag}).' },

  // Token 统计、热力图与成本细节补齐
  'tokens.badge.today': { 'zh-CN': ' · 今日 {val}', 'zh-TW': ' · 今日 {val}', en: ' · Today {val}' },
  'common.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'common.notProvided': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
  'common.loading': { 'zh-CN': '读取中...', 'zh-TW': '讀取中...', en: 'Loading...' },
  'common.noData': { 'zh-CN': '暂无数据', 'zh-TW': '暫無資料', en: 'No data' },
  'tokens.heat.firstUsePlaceholder': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
  'tokens.card.costPlaceholder': { 'zh-CN': '≈ $0.00 (¥0.00) · 日均 $0.00', 'zh-TW': '≈ $0.00 (HK$0 / NT$0) · 日均 $0.00', en: '≈ $0.00 · Avg $0.00/d' },
  'tokens.heat.costPlaceholder': { 'zh-CN': '≈ $0.00 (¥0.00)', 'zh-TW': '≈ $0.00 (HK$0 / NT$0)', en: '≈ $0.00' },
  'tokens.heat.activeAvgPlaceholder': { 'zh-CN': '$0.00 (0天)', 'zh-TW': '$0.00 (0天)', en: '$0.00 (0d)' },
  'tokens.card.todaySub': { 'zh-CN': '{n} 会话实时累加', 'zh-TW': '{n} 會話即時累加', en: '{n} chat(s) live' },
  'tokens.card.monthSub': { 'zh-CN': '日均约 {val}', 'zh-TW': '日均約 {val}', en: '~{val}/day avg' },
  'tokens.card.yearSub': { 'zh-CN': '{n} 天活动记录', 'zh-TW': '{n} 天活動記錄', en: '{n} active day(s)' },
  'tokens.range.month': { 'zh-CN': '{y}年{m}月', 'zh-TW': '{y}年{m}月', en: '{y}-{m}' },
  'tokens.range.year': { 'zh-CN': '{y}年', 'zh-TW': '{y}年', en: '{y}' },
  'tokens.range.yearToToday': { 'zh-CN': '{y}年（1月1日–今天）', 'zh-TW': '{y}年（1月1日–今天）', en: '{y} (Jan 1 – Today)' },
  'heatmap.pop.inProgress': { 'zh-CN': '（进行中）', 'zh-TW': '（進行中）', en: ' (Current)' },
  'heatmap.pop.peak': { 'zh-CN': '（年度峰值）', 'zh-TW': '（年度尖峰）', en: ' (Peak)' },
  'heatmap.pop.future': { 'zh-CN': '未来月份（尚未产生用量）', 'zh-TW': '未來月份（尚無用量）', en: 'Future month (no usage)' },
  'heatmap.pop.monthlyDet': { 'zh-CN': '月度合计 · 折合日均 ${avg} (活跃 {days} 天)', 'zh-TW': '月度合計 · 折合日均 ${avg} (活躍 {days} 天)', en: 'Monthly Total · Avg ${avg}/d ({days} active days)' },
  'cost.subSpendLabel': { 'zh-CN': '本人同期实际支出', 'zh-TW': '本人同期實際支出', en: 'Your Actual Spend' },
  'cost.freePromo': { 'zh-CN': '免费活动', 'zh-TW': '免費活動', en: 'Free promo' },
  'cost.subSpend': { 'zh-CN': '订阅支出', 'zh-TW': '訂閱支出', en: 'Plan spend' },
  'cost.paidLabel': { 'zh-CN': '实付', 'zh-TW': '實付', en: 'Paid' },
  'cost.paidUnknown': { 'zh-CN': '实付未知', 'zh-TW': '實付未知', en: 'Paid unknown' },
  'cost.publicRefMonthly': { 'zh-CN': '公开参考价 ${p}/月（实付未确认）', 'zh-TW': '公開參考價 ${p}/月（實付未確認）', en: 'Public ref ${p}/mo (paid unconfirmed)' },
  'cost.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'cost.noPlanData': { 'zh-CN': '未获取到套餐与实付数据', 'zh-TW': '未取得方案與實付資料', en: 'No plan or spend data available' },
  'cost.allNoCompare': { 'zh-CN': ' · 全量累计不直接对比单月支出', 'zh-TW': ' · 全量累計不直接對比單月支出', en: ' · All-time not compared to monthly spend' },
  'cost.expiredTag': { 'zh-CN': ' · ⚠️ 权益已到期', 'zh-TW': ' · ⚠️ 權益已到期', en: ' · ⚠️ Expired' },
  'cost.freeActive': { 'zh-CN': '{src} · 用户确认 · 免费权益使用中{extra}', 'zh-TW': '{src} · 使用者確認 · 免費權益使用中{extra}', en: '{src} · Confirmed · Free active{extra}' },
  'cost.covFull': { 'zh-CN': '100% 折算覆盖', 'zh-TW': '100% 換算覆蓋', en: '100% priced' },
  'cost.refApprox': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },

  // 调色板与下拉选择器
  'colors.resetLevel': { 'zh-CN': '恢复该档预设', 'zh-TW': '還原該檔預設', en: 'Reset step' },
  'colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨佈景主題', en: 'Follow theme' },
  'colors.lvl0': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Step 1 (None/Min)' },
  'colors.lvl1': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Step 2 (Low)' },
  'colors.lvl2': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Step 3 (Medium)' },
  'colors.lvl3': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Step 4 (High)' },
  'colors.lvl4': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/尖峰用量）', en: 'Step 5 (Peak)' },
  'colors.eyedropperPicked': { 'zh-CN': '已吸取 {hex}', 'zh-TW': '已吸取 {hex}', en: 'Picked {hex}' },
  'colors.eyedropperUnsupported': { 'zh-CN': '当前环境不支持原生吸管，可直接粘贴 HEX', 'zh-TW': '目前環境不支援原生滴管，可直接貼上 HEX 色碼', en: 'Eyedropper unsupported; paste HEX directly' },
  'colors.appliedHex': { 'zh-CN': '已应用 {hex}', 'zh-TW': '已套用 {hex}', en: 'Applied {hex}' },
  'colors.copied': { 'zh-CN': '✔ 已复制 {label}: {val}', 'zh-TW': '✔ 已複製 {label}: {val}', en: '✔ Copied {label}: {val}' },
  'dropdown.countrySearch': { 'zh-CN': '🔍 搜索账号所在地区或代码 · 如 美国 TW JP', 'zh-TW': '🔍 搜尋帳號所在地區或代碼 · 如 美國 TW JP', en: '🔍 Search country or code · e.g. US, TW, JP' },
  'dropdown.countryEmpty': { 'zh-CN': '未找到匹配的账号所在地区', 'zh-TW': '找不到相符的帳號所在地區', en: 'No matching country found' },
  'dropdown.tierSearch': { 'zh-CN': '🔍 搜索套餐规格或档位 · 如 Ultra 5x Pro', 'zh-TW': '🔍 搜尋方案規格或檔位 · 如 Ultra 5x Pro', en: '🔍 Search plan tier · e.g. Ultra, 5x, Pro' },
  'dropdown.tierEmpty': { 'zh-CN': '未找到匹配的套餐规格', 'zh-TW': '找不到相符的方案規格', en: 'No matching plan tier found' },
  'dropdown.regionSearch': { 'zh-CN': '🔍 搜索订阅国家、货币或缩写 · 如 台湾 澳 USD', 'zh-TW': '🔍 搜尋訂閱國家、幣別或縮寫 · 如 台灣 澳 USD', en: '🔍 Search billing region or currency · e.g. TW, USD' },
  'dropdown.regionEmpty': { 'zh-CN': '未找到匹配的订阅国家/地区', 'zh-TW': '找不到相符的訂閱國家/地區', en: 'No matching billing region found' },
  'dropdown.currencySearch': { 'zh-CN': '🔍 搜索币种名称或代码 · 如 USD NTD 人民币', 'zh-TW': '🔍 搜尋幣別名稱或代碼 · 如 USD NTD 台幣', en: '🔍 Search currency code or name · e.g. USD, CNY' },
  'dropdown.currencyEmpty': { 'zh-CN': '未找到匹配的币种', 'zh-TW': '未找到匹配的幣別', en: 'No matching currency found' },
  'dropdown.autoSaved': { 'zh-CN': '✔ 已自动保存', 'zh-TW': '✔ 已自動儲存', en: '✔ Auto-saved' },
  'dropdown.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
  'dropdown.saveFailedDetail': { 'zh-CN': '✖ 保存失败：{msg}', 'zh-TW': '✖ 儲存失敗：{msg}', en: '✖ Save failed: {msg}' },
  'dropdown.writeCfgFailed': { 'zh-CN': '无法写入配置文件', 'zh-TW': '無法寫入設定檔', en: 'Cannot write settings file' },
  'dropdown.noPersistBridge': { 'zh-CN': '未连接持久化服务，无法保存', 'zh-TW': '未連線至持久化服務，無法儲存', en: 'Persistence bridge unavailable' },
  'dropdown.persistErr': { 'zh-CN': '持久化异常', 'zh-TW': '持久化異常', en: 'Persistence error' },
  'dropdown.perMonth': { 'zh-CN': '/月', 'zh-TW': '/月', en: '/mo' },
  'dropdown.regionUnknownShort': { 'zh-CN': '🌏 未知 · 点击选择订阅国家与币种', 'zh-TW': '🌏 未知 · 點擊選擇訂閱國家與幣別', en: '🌏 Unknown · select billing country' },

  // 速度图表 Aria 与 设置/更新弹窗
  'speed.barSvg.aria': { 'zh-CN': '各模型与档位速度对比柱状图', 'zh-TW': '各模型與檔位速度對比長條圖', en: 'Model & effort speed comparison bar chart' },
  'speed.lineSvg.aria': { 'zh-CN': '所选模型与档位历史输出速度折线图', 'zh-TW': '所選模型與檔位歷史輸出速度折線圖', en: 'Selected model & effort speed trend line chart' },
  'settings.common.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
  'settings.clientLang.detecting': { 'zh-CN': '正在检测桌面端汉化运行状态…', 'zh-TW': '正在偵測桌面端漢化執行狀態…', en: 'Checking desktop localization status…' },
  'settings.clientLang.toggle': { 'zh-CN': '切换汉化状态', 'zh-TW': '切換漢化狀態', en: 'Toggle Localization' },
  'settings.proxy.checking': { 'zh-CN': '正在核对代理设置…', 'zh-TW': '正在核對代理設定…', en: 'Checking proxy settings…' },
  'settings.proxy.testBtn': { 'zh-CN': '🔍 测试代理连通性', 'zh-TW': '🔍 測試代理連通性', en: '🔍 Test Proxy Connectivity' },
  'settings.proxy.testing': { 'zh-CN': '正在测试…', 'zh-TW': '正在測試…', en: 'Testing…' },
  'settings.proxy.testingDetail': { 'zh-CN': '正在发起本地与网络连通性测试…', 'zh-TW': '正在發起本機與網路連通性測試…', en: 'Running local & network connectivity test…' },
  'settings.proxy.testFail': { 'zh-CN': '❌ 测试失败: {err}', 'zh-TW': '❌ 測試失敗: {err}', en: '❌ Test failed: {err}' },
  'settings.proxy.testErr': { 'zh-CN': '❌ 测试异常: {err}', 'zh-TW': '❌ 測試異常: {err}', en: '❌ Test error: {err}' },
  'settings.proxy.enableBtn': { 'zh-CN': '开启免 TUN 直连', 'zh-TW': '開啟免 TUN 直連', en: 'Enable No-TUN Direct' },
  'settings.proxy.resValid': { 'zh-CN': '✅ 合法', 'zh-TW': '✅ 合法', en: '✅ Valid' },
  'settings.proxy.resInvalid': { 'zh-CN': '❌ 无效', 'zh-TW': '❌ 無效', en: '❌ Invalid' },
  'settings.proxy.resReachable': { 'zh-CN': '✅ 可连接', 'zh-TW': '✅ 可連線', en: '✅ Reachable' },
  'settings.proxy.resUnreachable': { 'zh-CN': '❌ 无法连接', 'zh-TW': '❌ 無法連線', en: '❌ Unreachable' },
  'settings.proxy.resOnline': { 'zh-CN': '✅ 可访问', 'zh-TW': '✅ 可存取', en: '✅ Reachable' },
  'settings.proxy.resOffline': { 'zh-CN': '⚠️ 无法访问公网 (可能无境外连通)', 'zh-TW': '⚠️ 無法存取公網 (可能無境外連通)', en: '⚠️ Public internet unreachable' },
  'settings.proxy.resPending': { 'zh-CN': '待通过真实在线会话验证 (分层标定)', 'zh-TW': '待透過真實線上會話驗證 (分層標定)', en: 'Pending live chat verification' },
  'settings.proxy.resFmt': { 'zh-CN': '配置格式', 'zh-TW': '設定格式', en: 'Config format' },
  'settings.proxy.resPort': { 'zh-CN': '本地端口', 'zh-TW': '本機連接埠', en: 'Local port' },
  'settings.proxy.resNet': { 'zh-CN': '公网连通', 'zh-TW': '公網連通', en: 'Internet' },
  'settings.proxy.resModel': { 'zh-CN': '模型请求', 'zh-TW': '模型請求', en: 'Model request' },

  'update.unavailableTitle': { 'zh-CN': 'ℹ️ 更新不可用', 'zh-TW': 'ℹ️ 更新不可用', en: 'ℹ️ Update Unavailable' },
  'update.unavailableVer': { 'zh-CN': '{ver} (更新不可用)', 'zh-TW': '{ver} (更新不可用)', en: '{ver} (Unavailable)' },
  'update.unavailableBody': { 'zh-CN': '当前环境未提供更新桥接接口（如纯前端调试或免安装热挂载模式），无法在线检查更新。请前往 GitHub Releases 页面查看最新发布。', 'zh-TW': '目前環境未提供更新橋接介面（如純前端除錯或免安裝熱掛載模式），無法線上檢查更新。請前往 GitHub Releases 頁面查看最新發布。', en: 'Update bridge unavailable in this mode. Check GitHub Releases for the latest version.' },
  'update.checkingTitle': { 'zh-CN': '🔄 检查更新中', 'zh-TW': '🔄 檢查更新中', en: '🔄 Checking for Updates' },
  'update.checkingVer': { 'zh-CN': '{ver} (正在检查…)', 'zh-TW': '{ver} (正在檢查…)', en: '{ver} (Checking…)' },
  'update.doneTitle': { 'zh-CN': '🎉 更新已完成', 'zh-TW': '🎉 更新已完成', en: '🎉 Update Complete' },
  'update.doneVer': { 'zh-CN': '{ver} (已是最新)', 'zh-TW': '{ver} (已是最新)', en: '{ver} (Up to date)' },
  'update.doneHot': { 'zh-CN': '已成功在线更新至 {ver}。界面组件已完成热注入即时生效；主进程核心常驻模块待完全重启客户端后完整生效。', 'zh-TW': '已成功線上更新至 {ver}。介面元件已完成熱注入即時生效；主程序核心常駐模組待完全重啟用戶端後完整生效。', en: 'Updated to {ver}. UI hot-injected immediately; restart client for main-process changes.' },
  'update.doneHotFull': { 'zh-CN': '已成功在线更新至 {ver}。前端界面与新版后台服务已免重启热加载并完成接口核验。', 'zh-TW': '已成功線上更新至 {ver}。前端介面與新版後台服務已免重啟熱載入並完成介面核驗。', en: 'Updated to {ver}. Both UI and backend service hot-reloaded and verified without restart.' },
  'update.doneDisk': { 'zh-CN': '已成功完成 {ver} 磁盘更新，需完全重启 Antigravity 后生效。', 'zh-TW': '已成功完成 {ver} 磁碟更新，需完全重啟 Antigravity 後生效。', en: 'Disk update to {ver} complete. Restart Antigravity to apply.' },
  'update.restartBtn': { 'zh-CN': '重启客户端', 'zh-TW': '重新啟動用戶端', en: 'Restart Client' },
  'update.btnUpdated': { 'zh-CN': '已更新', 'zh-TW': '已更新', en: 'Updated' },
  'update.btnRetry': { 'zh-CN': '重试更新', 'zh-TW': '重試更新', en: 'Retry Update' },
  'update.failStatus': { 'zh-CN': '✖ 更新失败: {err}', 'zh-TW': '✖ 更新失敗: {err}', en: '✖ Update failed: {err}' },
  'update.errStatus': { 'zh-CN': '✖ 更新异常: {err}', 'zh-TW': '✖ 更新異常: {err}', en: '✖ Update error: {err}' },

  // 模型查看提示 & 状态扩展 & 重启交互
  'panel.ctx.viewModelHint': { 'zh-CN': '仅查看模型配置；在此切换不会改变发送模型', 'zh-TW': '僅檢視模型設定；在此切換不會改變發送模型', en: 'Inspect model config only; does not change active chat model' },
  'status.badge.partialMatch': { 'zh-CN': '特征未识别（部分匹配）', 'zh-TW': '特徵未識別（部分匹配）', en: 'Signature mismatch (partial)' },
  'client.restart.hostNotSupported': { 'zh-CN': '当前窗口为热注入或预览模式，不支持一键重启客户端，请手动完全退出后重新打开。', 'zh-TW': '目前視窗為熱注入或預覽模式，不支援一鍵重啟用戶端，請手動完全結束後重新開啟。', en: 'Current mode does not support one-click host restart. Fully quit and reopen Antigravity manually.' },
  'client.restart.triggering': { 'zh-CN': '正在通知客户端退出并重启…', 'zh-TW': '正在通知用戶端結束並重新啟動…', en: 'Requesting Antigravity restart…' },
  'client.restart.triggered': { 'zh-CN': '已触发客户端重启；若未自动拉起，请手动重新打开 Antigravity。', 'zh-TW': '已觸發用戶端重啟；若未自動拉起，請手動重新開啟 Antigravity。', en: 'Restart requested. Reopen Antigravity manually if it does not relaunch automatically.' },
  'client.restart.failed': { 'zh-CN': '无法自动重启：{err}，请手动完全退出后重新打开客户端。', 'zh-TW': '無法自動重啟：{err}，請手動完全結束後重新開啟用戶端。', en: 'Auto-restart failed: {err}. Please quit and reopen Antigravity manually.' },
  'client.restart.manualNote': { 'zh-CN': '请手动完全退出 Antigravity 并重新打开，然后刷新状态确认是否生效。', 'zh-TW': '請手動完全結束 Antigravity 並重新開啟，然後重新整理狀態確認是否生效。', en: 'Quit Antigravity completely and reopen it, then refresh status to verify.' },
  'msg.saveFail': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
  'msg.noHostBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
  'msg.noModelsDetected': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the model list to load.' },
  'models.btn.recheck': { 'zh-CN': '重新检测', 'zh-TW': '重新偵測', en: 'Re-detect' },
  'models.card.partialFailDetail': { 'zh-CN': '未定位到完整的上下文写入点，为保护二进制完整性已中止写入。{reason}', 'zh-TW': '未定位到完整的上下文寫入點，為保護二進位完整性已中止寫入。{reason}', en: 'Could not locate all required binary gates; aborted safely. {reason}' },

  // 推荐配置 / 提示词档位 / 品牌标题 / 增强设置
  'enhance.preset.title': { 'zh-CN': '✨ 推荐配置（按需主动应用）', 'zh-TW': '✨ 推薦設定（依需求主動套用）', en: '✨ Recommended Setup (Opt-In)' },
  'enhance.preset.desc': { 'zh-CN': '勾选为开，未勾选为关。安装默认全部关闭；只有磁盘上已经打开的项才会显示为开。确认前不会写入。', 'zh-TW': '勾選為開，未勾選為關。安裝預設全部關閉；只有磁碟上已經開啟的項才會顯示為開。確認前不會寫入。', en: 'Checked is on, unchecked is off. Install defaults to all off; only items already written on disk show as on. Nothing is written before confirmation.' },
  'enhance.preset.itemPrompt': { 'zh-CN': '精简防幻觉增强提示词 (4档)', 'zh-TW': '精簡防幻覺增強提示詞 (4檔)', en: 'Lean Anti-Hallucination Prompt (Tier 4)' },
  'enhance.preset.itemPromptSub': { 'zh-CN': '保留原生任务工具规范，注入工具契约与事实校验准则（写入验证，非保证模型不出错）', 'zh-TW': '保留原生任務工具規範，注入工具契約與事實校驗準則（寫入驗證，非保證模型不出錯）', en: 'Keeps native tools, adds verification & tool discipline (template write only; does not guarantee zero errors)' },
  'enhance.preset.itemTitle': { 'zh-CN': '自动中文会话标题', 'zh-TW': '自動中文工作階段標題', en: 'Auto Chinese Chat Titles' },
  'enhance.preset.itemTitleSub': { 'zh-CN': '让客户端为新对话生成简短简体中文标题（可单独开关恢复）', 'zh-TW': '讓用戶端為新對話產生簡短簡體中文標題（可單獨開關恢復）', en: 'Instructs the client to generate concise Chinese titles for new chats' },
  'enhance.preset.itemLang': { 'zh-CN': '客户端界面简体中文', 'zh-TW': '用戶端介面簡體中文', en: 'Client Simplified Chinese UI' },
  'enhance.preset.itemLangSub': { 'zh-CN': '切换 Antigravity 宿主本身为简体中文（可随时切回官方英文）', 'zh-TW': '切換 Antigravity 宿主本身為簡體中文（可隨時切回官方英文）', en: 'Switches Antigravity host UI to zh-CN (reversible to English)' },
  'enhance.preset.itemCtx': { 'zh-CN': '上下文跟随模型 (推荐上限释放)', 'zh-TW': '上下文跟隨模型 (推薦上限釋放)', en: 'Follow Model Context Limit' },
  'enhance.preset.itemCtxSub': { 'zh-CN': '解除前端硬编码上限，按当前模型原生能力透传真实预算', 'zh-TW': '解除前端寫死上限，依目前模型原生能力透傳真實預算', en: 'Lifts hardcoded client cap so each model uses its native limit' },
  'enhance.preset.itemRehydrate': { 'zh-CN': '改善 AGY 有损压缩', 'zh-TW': '改善 AGY 有損壓縮', en: 'Mitigate AGY Lossy Compaction' },
  'enhance.preset.itemRehydrateSub': { 'zh-CN': '压缩后自动把最初要求、最近几轮原话和刚改过的代码补回给 AI（不影响已有其他配置）', 'zh-TW': '壓縮後自動把最初要求、最近幾輪原話與剛改過的程式碼補回給 AI（不影響既有其他設定）', en: 'Automatically restores initial requests, recent verbatim turns, and active files after compaction (keeps existing configs)' },
  'enhance.preset.applyBtn': { 'zh-CN': '应用所选推荐配置…', 'zh-TW': '套用所選推薦設定…', en: 'Apply Selected Preset…' },
  'enhance.restoreAll.btn': { 'zh-CN': '全部恢复官方默认…', 'zh-TW': '全部恢復官方預設…', en: 'Restore All to Stock…' },
  'enhance.confirm.go': { 'zh-CN': '确认执行', 'zh-TW': '確認執行', en: 'Confirm' },
  'enhance.confirm.presetSummary': { 'zh-CN': '即将执行以下已勾选项：{items}；未勾选项目保持不变。变更后可能需要重启语言服务或 Antigravity 客户端加载生效。', 'zh-TW': '即將執行以下已勾選項：{items}；未勾選項目維持不變。變更後可能需要重啟語言服務或 Antigravity 用戶端載入生效。', en: 'About to apply checked items: {items}; unchecked items stay untouched. A language server or client restart may be required.' },
  'enhance.confirm.restoreSummary': { 'zh-CN': '「全部恢复官方默认」将还原以下 4 项：系统提示词(0档原版)、关闭中文会话标题、客户端英文界面及品牌(Antigravity)、宿主默认上下文行为。不会清除网络代理、面板语言及已保存的模型长度偏好。是否继续？', 'zh-TW': '「全部恢復官方預設」將還原以下 4 項：系統提示詞(0檔原版)、關閉中文工作階段標題、用戶端英文介面及品牌(Antigravity)、宿主預設上下文行為。不會清除網路代理、面板語言及已儲存的模型長度偏好。是否繼續？', en: '"Restore All to Stock" resets these 4 items: Tier 0 prompt, stock English titles, English host UI & brand (Antigravity), and native context behavior. Keeps proxy, panel language, and saved model preferences. Continue?' },
  'enhance.confirm.noneSelected': { 'zh-CN': '请至少勾选一项要应用的配置。', 'zh-TW': '請至少勾選一項要套用的設定。', en: 'Select at least one option first.' },
  'enhance.btn.restartLs': { 'zh-CN': '重启语言服务', 'zh-TW': '重啟語言服務', en: 'Restart Language Server' },
  'enhance.brand.label': { 'zh-CN': '左上角品牌文字显示（仅作用于左上角品牌位，不影响 Logo、菜单或代码）：', 'zh-TW': '左上角品牌文字顯示（僅作用於左上角品牌位，不影響 Logo、選單或程式碼）：', en: 'Header Brand Text (applies only to top-left brand slot; does not alter logo, menus, or code):' },
  'enhance.brand.aria': { 'zh-CN': '品牌显示模式', 'zh-TW': '品牌顯示模式', en: 'Brand display mode' },
  'enhance.brand.english': { 'zh-CN': 'Antigravity', 'zh-TW': 'Antigravity', en: 'Antigravity' },
  'enhance.brand.hidden': { 'zh-CN': '隐藏', 'zh-TW': '隱藏', en: 'Hide' },
  'enhance.brand.translated': { 'zh-CN': '反重力', 'zh-TW': '反重力', en: 'Translated Name' },
  'enhance.brand.applyBtn': { 'zh-CN': '保存品牌选择并应用', 'zh-TW': '儲存品牌選擇並套用', en: 'Save & Apply Brand' },
  'enhance.brand.hiddenValue': { 'zh-CN': '隐藏', 'zh-TW': '隱藏', en: 'Hide' },
  'enhance.brand.switched': { 'zh-CN': '已保存并应用：左上角品牌已更新为「{mode}」。', 'zh-TW': '已儲存並套用：左上角品牌已更新為「{mode}」。', en: 'Header name updated to "{mode}" (applied).' },
  'enhance.brand.appliedName': { 'zh-CN': '已保存并应用：左上角品牌已更新为「{mode}」。', 'zh-TW': '已儲存並套用：左上角品牌已更新為「{mode}」。', en: 'Header name updated to "{mode}" (applied).' },
  'enhance.brand.appliedHidden': { 'zh-CN': '已保存并应用：左上角品牌已隐藏。', 'zh-TW': '已儲存並套用：左上角品牌已隱藏。', en: 'Header name hidden (applied).' },
  'enhance.brand.savedNotFound': { 'zh-CN': '品牌设置已保存为「{mode}」，但当前窗口未检测到品牌元素，未能即时应用。', 'zh-TW': '品牌設定已儲存為「{mode}」，但目前視窗未偵測到品牌元素，未能即時套用。', en: 'Brand setting saved ({mode}), but header element was not found in this window (not applied live).' },
  'enhance.brand.savedApplyFailed': { 'zh-CN': '品牌设置已保存为「{mode}」，但当前窗口实时更新未生效。', 'zh-TW': '品牌設定已儲存為「{mode}」，但目前視窗即時更新未生效。', en: 'Brand setting saved ({mode}), but live update did not take effect.' },
  'enhance.brand.saveFailErr': { 'zh-CN': '保存品牌设置失败：{err}', 'zh-TW': '儲存品牌設定失敗：{err}', en: 'Failed to save brand setting: {err}' },
  'list.sep': { 'zh-CN': '、', 'zh-TW': '、', en: ', ' },
  'list.semiSep': { 'zh-CN': '；', 'zh-TW': '；', en: '; ' },
  'enhance.prompt.title': { 'zh-CN': '🧠 回答与工具使用规则', 'zh-TW': '🧠 回答與工具使用規則', en: '🧠 Response & Tool Usage Rules' },
  'enhance.prompt.plainIntro': { 'zh-CN': '调整客户端给 AI 的工作说明，让它更重视证据：没读过的文件不猜，没运行的测试不说通过。它不会升级模型底层能力，也不能保证回答永远正确。', 'zh-TW': '調整用戶端提供給 AI 的工作指引，促使其更重視證據：未讀取的檔案不臆測，未實際執行的測試不宣稱通過。此功能調整本機範本指引，不會提升模型底層能力，亦無法確保回答絕對無誤。', en: 'Adjusts client instructions to AI to emphasize evidence: never guess unread files, never claim untested code passed. It does not upgrade model intelligence or guarantee error-free output.' },
  'enhance.stat.prompt': { 'zh-CN': '当前检测档位', 'zh-TW': '目前檢測檔位', en: 'Detected Tier' },
  'enhance.stat.title': { 'zh-CN': '自动中文标题', 'zh-TW': '自動中文標題', en: 'Auto Chinese Title' },
  'enhance.stat.evidence': { 'zh-CN': '证据检测状态', 'zh-TW': '證據檢測狀態', en: 'Evidence Status' },
  'enhance.stat.slots': { 'zh-CN': '槽位状态', 'zh-TW': '槽位狀態', en: 'Prompt/Title Slots' },
  'enhance.stat.backup': { 'zh-CN': '原版内核备份', 'zh-TW': '原版核心備份', en: 'Stock Backup' },
  'enhance.prompt.aria': { 'zh-CN': '规则档位选择', 'zh-TW': '規則檔位選擇', en: 'Rule tier selection' },
  'enhance.tier.0.short': { 'zh-CN': '0档·官方原版', 'zh-TW': '0檔·官方原版', en: 'T0 · Stock' },
  'enhance.tier.1.short': { 'zh-CN': '1档·仅去推销', 'zh-TW': '1檔·僅去推銷', en: 'T1 · Clear Ads' },
  'enhance.tier.2.short': { 'zh-CN': '2档·原版精简', 'zh-TW': '2檔·原版精簡', en: 'T2 · Bloat Cleared' },
  'enhance.tier.3.short': { 'zh-CN': '3档·核心重写', 'zh-TW': '3檔·核心重寫', en: 'T3 · Core Rewritten' },
  'enhance.tier.4.short': { 'zh-CN': '4档·精简+防幻觉', 'zh-TW': '4檔·精簡+防幻覺', en: 'T4 · Guardrails' },
  'enhance.tier.0.desc': { 'zh-CN': '从原版备份完整还原所有官方系统提示词模板，未作任何改动。', 'zh-TW': '從原版備份完整還原所有官方系統提示詞範本，未作任何更動。', en: 'Restores all official system prompt templates from original backup without modifications.' },
  'enhance.tier.1.desc': { 'zh-CN': '仅清空插件市场与斜杠命令推销模板，其余保持官方原版。', 'zh-TW': '僅清空外掛市場與斜杠命令推銷範本，其餘保持官方原版。', en: 'Clears plugin marketplace and slash-command promotion templates; keeps all other templates stock.' },
  'enhance.tier.2.desc': { 'zh-CN': '清空工件、记忆与推销等 7 份辅助指引模板；身份定义与三份核心行为规则保持官方原版未修改。', 'zh-TW': '清空工件、記憶與推銷等 7 份輔助指引範本；身分定義與三份核心行為規則保持官方原版未更動。', en: 'Clears 7 auxiliary guidance templates (artifacts, memory, promotions); keeps identity and 3 core behavior rules stock.' },
  'enhance.tier.3.desc': { 'zh-CN': '在清空 7 份辅助模板的基础上，将三份核心行为规则重写为紧凑高密度的精简工程规范。', 'zh-TW': '在清空 7 份輔助範本的基礎上，將三份核心行為規則重寫為緊湊高密度的精簡工程規範。', en: 'Clears 7 auxiliary templates and rewrites the 3 core behavior rules into high-density concise engineering specifications.' },
  'enhance.tier.4.desc': { 'zh-CN': '在 3 档精简重写基础上注入防幻觉护栏：要求未读文件不猜、未跑测试不谎报通过、仅依据真实工具结果回答。', 'zh-TW': '在 3 檔精簡重寫基礎上注入防幻覺護欄：要求未讀檔案不猜、未跑測試不虛報通過、僅依據真實工具結果回答。', en: 'Injects anti-hallucination guardrails onto Tier 3: mandates no guessing unread files, no claiming unexecuted tests pass, and anchoring strictly to tool outputs.' },
  'enhance.tier.0.keeps': { 'zh-CN': '全部官方系统提示词模板与原生工具契约（100% 原始状态）', 'zh-TW': '全部官方系統提示詞範本與原生工具契約（100% 原始狀態）', en: 'All native system prompt templates and tool contracts (100% stock)' },
  'enhance.tier.0.clears': { 'zh-CN': '无', 'zh-TW': '無', en: 'None' },
  'enhance.tier.0.replaces': { 'zh-CN': '无', 'zh-TW': '無', en: 'None' },
  'enhance.tier.0.meaning': { 'zh-CN': '完全恢复官方原生体验，包含完整的斜杠命令示例、推销及工件引导。', 'zh-TW': '完全恢復官方原生體驗，包含完整的斜杠命令範例、推銷及工件引導。', en: 'Complete native experience, including standard slash commands, promotions, and artifact instructions.' },
  'enhance.tier.1.keeps': { 'zh-CN': '身份定义、三份核心行为规则、工件与会话记录等其余全部原版模板', 'zh-TW': '身分定義、三份核心行為規則、工件與對話記錄等其餘全部原版範本', en: 'Identity, all 3 core behavior rules, artifacts, transcripts, and all other stock templates' },
  'enhance.tier.1.clears': { 'zh-CN': 'slash_commands.tmpl, plugins.tmpl（共 2 份推销与命令示例模板）', 'zh-TW': 'slash_commands.tmpl, plugins.tmpl（共 2 份推銷與命令範例範本）', en: 'slash_commands.tmpl, plugins.tmpl (2 promotional/example templates)' },
  'enhance.tier.1.replaces': { 'zh-CN': '无（不替换任何规则）', 'zh-TW': '無（不替換任何規則）', en: 'None (no rules replaced)' },
  'enhance.tier.1.meaning': { 'zh-CN': '不再主动推销插件与斜杠命令；不改变编码准则与工具契约，其余能力全部保留。', 'zh-TW': '不再主動推銷外掛與斜杠命令；不改變編碼準則與工具契約，其餘能力全部保留。', en: 'Stops unsolicited promotions for plugins and slash commands; leaves coding standards and all other capabilities stock.' },
  'enhance.tier.2.keeps': { 'zh-CN': 'identity、guidelines、function_call、communication_style（4 份核心模板 100% 官方原版未修改）', 'zh-TW': 'identity、guidelines、function_call、communication_style（4 份核心範本 100% 官方原版未更動）', en: 'identity, guidelines, function_call, communication_style (4 core templates 100% unmodified stock)' },
  'enhance.tier.2.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助指引模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助指引範本）', en: '7 auxiliary templates: artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins' },
  'enhance.tier.2.replaces': { 'zh-CN': '无（核心行为规则完全保持官方原版）', 'zh-TW': '無（核心行為規則完全保持官方原版）', en: 'None (core behavioral rules remain strictly stock)' },
  'enhance.tier.2.meaning': { 'zh-CN': '精简约 7~8KB 提示词。这是删减关于工件与记忆的工作指引，不等于删除用户文件或工件功能；核心规范仍是官方原版。', 'zh-TW': '精簡約 7~8KB 提示詞。這是刪減關於工件與記憶的工作指引，不等於刪除使用者檔案或工件功能；核心規範仍為官方原版。', en: 'Saves ~7-8KB of prompt context. Trims workflow guidance for artifacts and memory without deleting user files or artifact tools; core rules remain stock.' },
  'enhance.tier.3.keeps': { 'zh-CN': 'identity.tmpl（官方原版身份未修改）、全部原生工具定义', 'zh-TW': 'identity.tmpl（官方原版身分未更動）、全部原生工具定義', en: 'identity.tmpl (official identity kept stock), all native tool contracts' },
  'enhance.tier.3.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助範本）', en: '7 auxiliary templates (artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins)' },
  'enhance.tier.3.replaces': { 'zh-CN': '重写 guidelines、function_call、communication_style（重写为精简工程规范：直接工具调用、并行读取+顺序编辑、edit_file 唯一锚点、真实工具实测验证）', 'zh-TW': '重寫 guidelines、function_call、communication_style（重寫為精簡工程規範：直接工具呼叫、並行讀取+循序編輯、edit_file 唯一錨點、真實工具實測驗證）', en: 'Rewrites guidelines, function_call, communication_style into concise engineering specs (clean tool turns, parallel reads, unique edit_file anchor, verified tool testing)' },
  'enhance.tier.3.meaning': { 'zh-CN': '大幅缩短系统提示词；重写核心规范使 AI 回复更直奔主题并强化工具规范。工件指引被精简，是否影响工件生成需实际验证。', 'zh-TW': '大幅縮短系統提示詞；重寫核心規範使 AI 回覆更直奔主題並強化工具規範。工件指引被精簡，是否影響工件產生需實際驗證。', en: 'Significantly reduces prompt tokens; rewritten core rules make responses more direct with strict tool execution. Practical impact on artifacts requires live testing.' },
  'enhance.tier.4.keeps': { 'zh-CN': 'identity.tmpl（官方原版身份未修改）、全部原生工具定义、核心格式要求（LaTeX与文件链接规范）', 'zh-TW': 'identity.tmpl（官方原版身分未更動）、全部原生工具定義、核心格式要求（LaTeX與檔案連結規範）', en: 'identity.tmpl (official identity kept stock), all native tool contracts, core formatting standards (LaTeX & file links)' },
  'enhance.tier.4.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助範本）', en: '7 auxiliary templates (artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins)' },
  'enhance.tier.4.replaces': { 'zh-CN': '重写 guidelines、function_call、communication_style（精简规范 + 未读禁猜 + edit_file 唯一锚点 + 真实工具实测验证护栏）', 'zh-TW': '重寫 guidelines、function_call、communication_style（精簡規範 + 未讀禁猜 + edit_file 唯一錨點 + 真實工具實測驗證護欄）', en: 'Rewrites guidelines, function_call, communication_style (concise specs + evidence-first + unique edit_file anchor + verified test guardrails)' },
  'enhance.tier.4.meaning': { 'zh-CN': '最少预设干预，强化基于事实作答。注意：这只是调整给 AI 的提示词规范，不升级底层模型智能，也不能保证绝对不犯错。', 'zh-TW': '最少預設干預，強化基於事實作答。注意：這只是調整給 AI 的提示詞規範，不升級底層模型智能，也不能保證絕對不犯錯。', en: 'Minimizes unrequested bloat and enforces fact-based answers. Note: prompt adjustments guide model behavior but cannot upgrade underlying model intelligence or guarantee zero errors.' },
  'enhance.matrix.keeps': { 'zh-CN': '保留', 'zh-TW': '保留', en: 'Keeps' },
  'enhance.matrix.clears': { 'zh-CN': '清空', 'zh-TW': '清空', en: 'Clears' },
  'enhance.matrix.replaces': { 'zh-CN': '替换', 'zh-TW': '替換', en: 'Injects' },
  'enhance.matrix.meaning': { 'zh-CN': '对你的影响', 'zh-TW': '對你的影響', en: 'User Impact' },
  'enhance.hallucinationNote': { 'zh-CN': '提示：规则档位通过调整本地提示词模板来引导 AI 行为，仅代表规则文本已写入磁盘程序。它不等于模型能力升级，亦无法确保模型绝对不犯错；高档位删减提示模板中的指引，不等于删除用户文件，实际表现需结合真实对话检验。', 'zh-TW': '提示：規則檔位透過調整本機提示詞範本來引導 AI 行為，僅代表規則文字已寫入磁碟程式。它不等於模型能力升級，亦無法確保模型絕對不出錯；高檔位刪減提示範本中的指引，不等於刪除使用者檔案，實際表現需結合真實對話檢驗。', en: 'Note: Rule tiers tune local prompt templates to guide AI behavior. This modifies text on disk; it does not upgrade underlying model intelligence or guarantee zero errors. Trimming guidance does not delete user files; live validation is recommended.' },
  'enhance.titlePatch.label': { 'zh-CN': '自动生成简短中文会话标题', 'zh-TW': '自動產生簡短中文工作階段標題', en: 'Generate concise Chinese chat titles' },
  'enhance.titlePatch.sub': { 'zh-CN': '修改对话总结指令为简体中文短标题（等长槽位替换，可随时恢复）', 'zh-TW': '修改對話總結指令為簡體中文短標題（等長槽位替換，可隨時恢復）', en: 'Fixed-length prompt slot update for concise Chinese titles (reversible)' },
  'enhance.btn.applyPrompt': { 'zh-CN': '应用提示词与标题设置', 'zh-TW': '套用提示詞與標題設定', en: 'Apply Prompt & Title Settings' },
  'enhance.btn.applyPromptBusy': { 'zh-CN': '正在写入提示词…', 'zh-TW': '正在寫入提示詞…', en: 'Writing prompt settings…' },
  'enhance.btn.applyPresetBusy': { 'zh-CN': '正在应用推荐配置…', 'zh-TW': '正在套用推薦設定…', en: 'Applying preset…' },
  'enhance.btn.restoreAllBusy': { 'zh-CN': '正在恢复全部默认…', 'zh-TW': '正在恢復全部預設…', en: 'Restoring stock…' },
  'enhance.details.toggle': { 'zh-CN': '原理说明与贡献来源', 'zh-TW': '原理說明與貢獻來源', en: 'Technical Details & Credits' },
  'enhance.details.collapse': { 'zh-CN': '▲ 收起说明', 'zh-TW': '▲ 收起說明', en: '▲ Hide Details' },
  'enhance.details.body': { 'zh-CN': '所有提示词与中文标题改动均采用等长槽位替换并保留原版备份，不改变文件体积，不会静默覆盖原有上下文配置。防幻觉档位已在融合前移除与本机工具不符、固定知识截止日与强制配色规则。', 'zh-TW': '所有提示詞與中文標題變更皆採用等長槽位替換並保留原版備份，不改變檔案體積，不會靜默覆蓋原有上下文設定。防幻覺檔位已在融合前移除與本機工具不符、固定知識截止日與強制配色規則。', en: 'Prompt and title changes use fixed-length slot replacement with stock backups so file size never shifts and context settings stay separate.' },
  'enhance.details.credit': { 'zh-CN': '增强与提示词档位思路源自开源贡献 PR #4 (Jia131313)，桌面端与 CLI 解锁逻辑融合自 PR #3 (anyu0804 / Linux.do @23375)，经本仓库适配器统一持久化链路与防幻觉契约。', 'zh-TW': '增強與提示詞檔位思路源自開源貢獻 PR #4 (Jia131313)，桌面端與 CLI 解鎖邏輯融合自 PR #3 (anyu0804 / Linux.do @23375)，經本專案適配器統一持久化鏈路與防幻覺契約。', en: 'Prompt tiers & enhance ideas adapted from PR #4 (Jia131313); context unlock adapted from PR #3 (anyu0804 / Linux.do @23375), unified in this project.' },
  'enhance.status.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
  'enhance.status.unsupportedPlatform': { 'zh-CN': '当前平台不支持', 'zh-TW': '目前平台不支援', en: 'Unsupported Platform' },
  'enhance.status.pendingRestartLs': { 'zh-CN': '已写入 · 待重启语言服务', 'zh-TW': '已寫入 · 待重啟語言服務', en: 'Written · LS Restart Needed' },
  'enhance.status.runtimeConfirmed': { 'zh-CN': '已写入 · 进程已重载', 'zh-TW': '已寫入 · 行程已重載', en: 'Written · LS Reloaded' },
  'enhance.status.patchedActive': { 'zh-CN': '已保存并写入', 'zh-TW': '已儲存並寫入', en: 'Saved & Written' },
  'enhance.status.clientUpdated': { 'zh-CN': '配置已保存 · 客户端更新待重写入', 'zh-TW': '設定已儲存 · 用戶端更新待重寫入', en: 'Saved · Client Updated (Reapply)' },
  'enhance.status.diskMismatch': { 'zh-CN': '配置已保存 · 磁盘待写入', 'zh-TW': '設定已儲存 · 磁碟待寫入', en: 'Saved · Disk Out of Sync' },
  'enhance.status.draftUnsaved': { 'zh-CN': '（有未应用修改）', 'zh-TW': '（有未套用修改）', en: ' (Unsaved Draft)' },
  'enhance.status.stock': { 'zh-CN': '官方原版', 'zh-TW': '官方原版', en: 'Stock' },
  'enhance.status.slotsInfo': { 'zh-CN': '提示词 {p} · 标题 {t}', 'zh-TW': '提示詞 {p} · 標題 {t}', en: 'Prompt {p} · Title {t}' },
  'enhance.status.backupYes': { 'zh-CN': '已备份', 'zh-TW': '已備份', en: 'Backed up' },
  'enhance.status.backupNo': { 'zh-CN': '无（未改写）', 'zh-TW': '無（未改寫）', en: 'None (stock)' },
  'enhance.titleState.on': { 'zh-CN': '已写入磁盘', 'zh-TW': '已寫入磁碟', en: 'Written on Disk' },
  'enhance.titleState.onConfirmed': { 'zh-CN': '已写入 · 进程已重载（效果需对话实测）', 'zh-TW': '已寫入 · 行程已重載（效果需對話實測）', en: 'Written · Process Reloaded (Verify in Chat)' },
  'enhance.titleState.onWritten': { 'zh-CN': '已写入磁盘（待重新加载）', 'zh-TW': '已寫入磁碟（待重新載入）', en: 'Written to disk (Reload needed)' },
  'enhance.titleState.off': { 'zh-CN': '原版英文', 'zh-TW': '原版英文', en: 'Stock English' },
  'enhance.titleState.conflict': { 'zh-CN': '状态不一致', 'zh-TW': '狀態不一致', en: 'Mismatch' },
  'enhance.result.appliedNeedRestartLs': { 'zh-CN': '✔ 提示词与标题配置已保存并写入磁盘（{tier} / 中文标题：{title}）。需重启后台语言服务或重开客户端以加载新指令；标题实际效果由模型生成，不保证必定中文。', 'zh-TW': '✔ 提示詞與標題設定已儲存並寫入磁碟（{tier} / 中文標題：{title}）。需重啟後台語言服務或重開用戶端以載入新指令；標題實際效果由模型生成，不保證必定中文。', en: '✔ Prompt & title settings written & saved ({tier} / Title: {title}). Language server or client restart required to reload. Title output depends on model.' },
  'enhance.result.alreadyApplied': { 'zh-CN': '✔ 当前已是目标状态（{tier} / 中文标题：{title}），配置已确认保存，无需重复写入或重启。', 'zh-TW': '✔ 目前已是目標狀態（{tier} / 中文標題：{title}），設定已確認儲存，無需重複寫入或重啟。', en: '✔ Already at target state ({tier} / Title: {title}). Settings verified and saved; no write or restart needed.' },
  'enhance.result.presetDone': { 'zh-CN': '✔ 所选推荐配置已写入（{summary}）。请重启语言服务或客户端让全部变更加载生效。', 'zh-TW': '✔ 所選推薦設定已寫入（{summary}）。請重啟語言服務或用戶端讓全部變更載入生效。', en: '✔ Selected preset applied ({summary}). Restart language server or client to load changes.' },
  'enhance.result.presetAlreadyApplied': { 'zh-CN': '✔ 所选推荐配置均已是目标状态（{summary}），无需重复写入。', 'zh-TW': '✔ 所選推薦設定均已是目標狀態（{summary}），無需重複寫入。', en: '✔ Selected presets are already active ({summary}); no write needed.' },
  'enhance.result.presetWorking': { 'zh-CN': '正在应用所选配置，请稍候…', 'zh-TW': '正在套用所選設定，請稍候…', en: 'Applying selected settings…' },
  'enhance.result.restoreWorking': { 'zh-CN': '正在恢复官方默认配置，请稍候…', 'zh-TW': '正在恢復官方預設設定，請稍候…', en: 'Restoring stock defaults…' },
  'enhance.result.clientUpdatedNotice': { 'zh-CN': '检测到客户端目标文件已恢复官方原版（可能因版本更新），已恢复显示上次保存偏好（{tier} / 中文标题：{title}），点击应用即可重新写入。', 'zh-TW': '偵測到用戶端目標檔案已恢復官方原版（可能因版本更新），已恢復顯示上次儲存偏好（{tier} / 中文標題：{title}），點擊套用即可重新寫入。', en: 'Client binaries appear reset (e.g. client update). Saved preference ({tier} / Title: {title}) is kept in draft; click Apply to re-patch.' },
  'enhance.btn.restartLsBusy': { 'zh-CN': '正在重启语言服务…', 'zh-TW': '正在重啟語言服務…', en: 'Restarting LS…' },
  'enhance.result.restoredDone': { 'zh-CN': '✔ 已恢复为官方默认状态（0档原版、关闭中文标题、官方英文与默认上下文）。请重启客户端完整生效。', 'zh-TW': '✔ 已恢復為官方預設狀態（0檔原版、關閉中文標題、官方英文與預設上下文）。請重啟用戶端完整生效。', en: '✔ Restored to stock defaults (Tier 0, original title & English UI, native context). Restart client to take effect.' },
  'enhance.result.partialFail': { 'zh-CN': '⚠ 部分完成，未全部成功。已成功：{done}；失败：{failed}。请处理异常项后重试。', 'zh-TW': '⚠ 部分完成，未全部成功。已成功：{done}；失敗：{failed}。請處理異常項後重試。', en: '⚠ Partial completion. Succeeded: {done}; Failed: {failed}. Please retry failed items.' },
  'enhance.result.lsRestarted': { 'zh-CN': '✔ 已通知语言服务重载（终止 {killed} 个旧进程），Antigravity 将自动拉起新版后端。', 'zh-TW': '✔ 已通知語言服務重載（終止 {killed} 個舊行程），Antigravity 將自動拉起新版後端。', en: '✔ Language server signaled to reload ({killed} process(es) cycled); Antigravity will respawn it.' },
  'enhance.result.lsRestartFail': { 'zh-CN': '重启语言服务失败：{err}', 'zh-TW': '重啟語言服務失敗：{err}', en: 'Failed to restart language server: {err}' },
  'enhance.result.noBridge': { 'zh-CN': '当前预览模式未连接到语言服务增强桥接，可通过 node cli.js enhance-status 查看或执行。', 'zh-TW': '目前預覽模式未連線到語言服務增強橋接，可透過 node cli.js enhance-status 檢視或執行。', en: 'Enhance bridge unavailable in this mode. Use `node cli.js enhance-status` via CLI.' },
  'enhance.result.fail': { 'zh-CN': '操作失败：{err}', 'zh-TW': '操作失敗：{err}', en: 'Action failed: {err}' },

  // 改善 AGY 有损压缩 (Post-Compact Rehydration Hook)
  'rehydrate.card.title': { 'zh-CN': '🩹 改善 AGY 有损压缩', 'zh-TW': '🩹 改善 AGY 有損壓縮', en: '🩹 Mitigate AGY Lossy Compaction' },
  'rehydrate.card.plainIntro': { 'zh-CN': 'AGY 自动压缩（或执行 /compact）只保留概括摘要，容易丢失细节。开启后会在压缩完成时自动从本地完整记录把最初要求、最近几轮原话和刚读写过的文件补回给 AI；未检测到新的压缩检查点时，不注入额外上下文。', 'zh-TW': 'AGY 自動壓縮（或執行 /compact）只保留概括摘要，容易遺失細節。開啟後會在壓縮完成時自動從本機完整記錄把最初要求、最近幾輪原話與剛讀寫過的檔案補回給 AI；未偵測到新的壓縮檢查點時，不注入額外上下文。', en: 'AGY compaction (/compact) leaves only a lossy summary. When enabled, this automatically restores bounded excerpts of your initial requests, recent verbatim turns, and recently used workspace files after compaction; when no new compaction checkpoint is detected, no extra context is injected.' },
  'rehydrate.stat.hook': { 'zh-CN': '当前状态', 'zh-TW': '目前狀態', en: 'Current Status' },
  'rehydrate.stat.script': { 'zh-CN': '恢复脚本', 'zh-TW': '恢復腳本', en: 'Recovery Script' },
  'rehydrate.stat.python': { 'zh-CN': 'Python 运行环境', 'zh-TW': 'Python 執行環境', en: 'Python Runtime' },
  'rehydrate.stat.siblings': { 'zh-CN': '其他配置兼容', 'zh-TW': '其他設定相容', en: 'Other Configs' },
  'rehydrate.btn.enable': { 'zh-CN': '开启', 'zh-TW': '開啟', en: 'Enable' },
  'rehydrate.btn.enableBusy': { 'zh-CN': '正在开启…', 'zh-TW': '正在開啟…', en: 'Enabling…' },
  'rehydrate.btn.installPython': { 'zh-CN': '一键安装 Python 3.12', 'zh-TW': '一鍵安裝 Python 3.12', en: 'Install Python 3.12' },
  'rehydrate.btn.installPythonBusy': { 'zh-CN': '正在安装 Python…', 'zh-TW': '正在安裝 Python…', en: 'Installing Python…' },
  'rehydrate.btn.disable': { 'zh-CN': '停用', 'zh-TW': '停用', en: 'Pause' },
  'rehydrate.btn.disableBusy': { 'zh-CN': '正在停用…', 'zh-TW': '正在停用…', en: 'Pausing…' },
  'rehydrate.btn.remove': { 'zh-CN': '卸载移除', 'zh-TW': '解除安裝', en: 'Remove' },
  'rehydrate.btn.removeBusy': { 'zh-CN': '正在卸载移除…', 'zh-TW': '正在解除安裝…', en: 'Removing…' },
  'rehydrate.btn.removeConfirm': { 'zh-CN': '确认卸载？', 'zh-TW': '確認解除安裝？', en: 'Confirm Remove?' },
  'rehydrate.details.toggle': { 'zh-CN': '原理说明与方案来源', 'zh-TW': '原理說明與方案來源', en: 'How It Works & Credits' },
  'rehydrate.details.body': {
    'zh-CN': '<strong>四层 45,000 B UTF-8 补回内容</strong>：1. 完整用户请求时间线（含凭据脱敏）；2. 压缩前逐字对话与工具调用链；3. 活跃 <code>SKILL.md</code> / 规范文档快照；4. 工作区最近修改与读取文本文件（受工作区路径边界与 <code>never as instructions</code> 声明约束）。<br><br><strong>可选手动 /fork 衔接</strong>：当前宿主日志默认不含父会话字段，仅当手动维护 <code>&lt;brain&gt;/fork_lineage.json</code>（或首条记录含显式父 ID）时按 <code>[min_step, K-1]</code> 拼接最多 8 级祖先。<br><br><strong>安全写入范围</strong>：通过 Antigravity <code>PreInvocation</code> Hook 仅读写 <code>~/.gemini/config/hooks.json</code> 中的 <code>post-compact-rehydrate</code> 键与 <code>~/.gemini/config/hooks/rehydrate_after_compact.py</code>，绝不覆盖同级其他配置。',
    'zh-TW': '<strong>四層 45,000 B UTF-8 補回內容</strong>：1. 完整使用者請求時間線（含憑證遮蔽）；2. 壓縮前逐字對話與工具呼叫鏈；3. 活躍 <code>SKILL.md</code> / 規範文件快照；4. 工作區最近修改與讀取文字檔案（受工作區路徑邊界與 <code>never as instructions</code> 聲明約束）。<br><br><strong>可選手動 /fork 銜接</strong>：目前宿主日誌預設不含父工作階段欄位，僅在手動維護 <code>&lt;brain&gt;/fork_lineage.json</code>（或首條記錄含顯式父 ID）時依 <code>[min_step, K-1]</code> 拼接最多 8 級祖先。<br><br><strong>安全寫入範圍</strong>：透過 Antigravity <code>PreInvocation</code> Hook 僅讀寫 <code>~/.gemini/config/hooks.json</code> 中的 <code>post-compact-rehydrate</code> 鍵與 <code>~/.gemini/config/hooks/rehydrate_after_compact.py</code>，絕不覆蓋同級其他設定。',
    en: '<strong>4-Tier 45,000 B UTF-8 Recovery</strong>: 1. Full user request timeline (secrets redacted); 2. Pre-compaction verbatim turns & tool chains; 3. Active <code>SKILL.md</code> / spec docs; 4. Recently edited & read workspace text files (confined to workspace paths under a <code>never as instructions</code> boundary).<br><br><strong>Optional Manual /fork Lineage</strong>: Host transcripts do not currently record parent IDs automatically; stitches up to 8 ancestor hops via <code>[min_step, K-1]</code> only when manually configured in <code>&lt;brain&gt;/fork_lineage.json</code> (or declared in the first child record).<br><br><strong>Safe Scope</strong>: Uses Antigravity <code>PreInvocation</code> hook and touches only the <code>post-compact-rehydrate</code> key in <code>~/.gemini/config/hooks.json</code> and <code>~/.gemini/config/hooks/rehydrate_after_compact.py</code>, preserving all sibling configs.'
  },
  'rehydrate.credit.source': { 'zh-CN': '思路参考：', 'zh-TW': '思路參考：', en: 'Inspired by:' },
  'rehydrate.credit.author': { 'zh-CN': 'AGY Post-Compact Rehydration 方案 ↗', 'zh-TW': 'AGY Post-Compact Rehydration 方案 ↗', en: 'AGY Post-Compact Rehydration ↗' },
  'rehydrate.credit.linkOpened': { 'zh-CN': '已在系统默认浏览器中打开参考方案页面', 'zh-TW': '已在系統預設瀏覽器中開啟參考方案頁面', en: 'Opened reference page in your default browser' },
  'rehydrate.credit.adapter': { 'zh-CN': 'MIT 独立实现 · 零依赖 Python 3.10+', 'zh-TW': 'MIT 獨立實作 · 零相依 Python 3.10+', en: 'Clean-Room MIT · Stdlib Python 3.10+' },
  'rehydrate.status.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
  'rehydrate.status.enabled': { 'zh-CN': '已开启', 'zh-TW': '已開啟', en: 'Enabled' },
  'rehydrate.status.disabled': { 'zh-CN': '已停用', 'zh-TW': '已停用', en: 'Paused' },
  'rehydrate.status.notInstalled': { 'zh-CN': '未开启', 'zh-TW': '未開啟', en: 'Off' },
  'rehydrate.status.broken': { 'zh-CN': '待修复', 'zh-TW': '待修復', en: 'Needs Setup' },
  'rehydrate.status.corrupt': { 'zh-CN': '配置文件异常', 'zh-TW': '設定檔異常', en: 'Config Error' },
  'rehydrate.state.hookEnabled': { 'zh-CN': '已开启', 'zh-TW': '已開啟', en: 'Enabled' },
  'rehydrate.state.hookDisabled': { 'zh-CN': '已停用', 'zh-TW': '已停用', en: 'Paused' },
  'rehydrate.state.hookNone': { 'zh-CN': '未开启', 'zh-TW': '未開啟', en: 'Off' },
  'rehydrate.state.scriptSynced': { 'zh-CN': '已安装（最新版）', 'zh-TW': '已安裝（最新版）', en: 'Installed · Up to date' },
  'rehydrate.state.scriptCustom': { 'zh-CN': '已安装（自定义修改版）', 'zh-TW': '已安裝（自訂修改版）', en: 'Installed · Customized' },
  'rehydrate.state.scriptMissing': { 'zh-CN': '未安装', 'zh-TW': '未安裝', en: 'Not Installed' },
  'rehydrate.state.pythonOk': { 'zh-CN': '✔ 已就绪 (Python {ver})', 'zh-TW': '✔ 已就緒 (Python {ver})', en: '✔ Ready (Python {ver})' },
  'rehydrate.state.pythonOld': { 'zh-CN': '版本过低 ({ver}，需 3.10+)', 'zh-TW': '版本過低 ({ver}，需 3.10+)', en: 'Too old ({ver}, needs 3.10+)' },
  'rehydrate.state.pythonMissing': { 'zh-CN': '未安装 Python 3.10+', 'zh-TW': '未安裝 Python 3.10+', en: 'Python 3.10+ Missing' },
  'rehydrate.state.siblingsList': { 'zh-CN': '无冲突（已保留 {names}）', 'zh-TW': '無衝突（已保留 {names}）', en: 'Compatible (kept {names})' },
  'rehydrate.state.siblingsNone': { 'zh-CN': '无冲突', 'zh-TW': '無衝突', en: 'No conflicts' },
  'rehydrate.state.siblingsBlocked': { 'zh-CN': '已保护（未修改原文件）', 'zh-TW': '已保護（未修改原檔案）', en: 'Protected (unchanged)' },
  'rehydrate.paths.summary': { 'zh-CN': '配置文件：{hooksJson} | 脚本路径：{script}', 'zh-TW': '設定檔案：{hooksJson} | 腳本路徑：{script}', en: 'Config: {hooksJson} | Script: {script}' },
  'rehydrate.result.enabled': { 'zh-CN': '✔ 已开启「改善 AGY 有损压缩」（配置已写入 {path}，其他配置均已保留），下次对话立即生效。', 'zh-TW': '✔ 已開啟「改善 AGY 有損壓縮」（設定已寫入 {path}，其他設定均已保留），下次對話立即生效。', en: '✔ Enabled Mitigate AGY Lossy Compaction ({path}; sibling configs preserved). Active on your next turn.' },
  'rehydrate.result.alreadyEnabled': { 'zh-CN': '✔「改善 AGY 有损压缩」已处于开启且最新状态，无需重复设置。', 'zh-TW': '✔「改善 AGY 有損壓縮」已處於開啟且最新狀態，無需重複設定。', en: '✔ Mitigate AGY Lossy Compaction is already enabled and up to date.' },
  'rehydrate.result.disabled': { 'zh-CN': '✔ 已停用「改善 AGY 有损压缩」，脚本与其他配置均已保留。', 'zh-TW': '✔ 已停用「改善 AGY 有損壓縮」，腳本與其他設定均已保留。', en: '✔ Paused Mitigate AGY Lossy Compaction; script and sibling configs preserved.' },
  'rehydrate.result.removed': { 'zh-CN': '✔ 已卸载移除「改善 AGY 有损压缩」并清理脚本，其他配置均已完整保留。', 'zh-TW': '✔ 已解除安裝「改善 AGY 有損壓縮」並清理腳本，其他設定均已完整保留。', en: '✔ Removed Mitigate AGY Lossy Compaction and cleaned up script; sibling configs preserved.' },
  'rehydrate.result.pythonInstalled': { 'zh-CN': '✔ 已成功安装 Python {ver} 运行环境，现在可点击“开启”。', 'zh-TW': '✔ 已成功安裝 Python {ver} 執行環境，現在可點擊「開啟」。', en: '✔ Installed Python {ver} runtime. You can now click Enable.' },
  'rehydrate.result.pythonAlreadyReady': { 'zh-CN': '✔ 检测到 Python {ver} 已就绪，无需重复安装。', 'zh-TW': '✔ 偵測到 Python {ver} 已就緒，無需重複安裝。', en: '✔ Python {ver} is already ready.' },
  'rehydrate.result.confirmRemoveHint': { 'zh-CN': '再次点击「确认卸载？」将从 hooks.json 移除该条目并清理恢复脚本（自定义脚本会自动备份为 .bak）。', 'zh-TW': '再次點擊「確認解除安裝？」將從 hooks.json 移除此項目並清理恢復腳本（自訂腳本會自動備份為 .bak）。', en: 'Click "Confirm Remove?" again to delete the hook entry and script (custom scripts are backed up to .bak).' },
  'rehydrate.result.fail': { 'zh-CN': '操作失败：{err}', 'zh-TW': '操作失敗：{err}', en: 'Operation failed: {err}' },
  'rehydrate.result.noBridge': { 'zh-CN': '当前预览模式未连接到本机配置桥接，可通过 node cli.js rehydrate-status 或 rehydrate:enable 管理。', 'zh-TW': '目前預覽模式未連線到本機設定橋接，可透過 node cli.js rehydrate-status 或 rehydrate:enable 管理。', en: 'Local config bridge unavailable in this mode. Manage via `node cli.js rehydrate-status` or `rehydrate:enable`.' },
  'rehydrate.err.noPython310': { 'zh-CN': '未检测到 Python 3.10+ 运行环境，请先安装 Python 3.10 或更高版本后再开启。', 'zh-TW': '未偵測到 Python 3.10+ 執行環境，請先安裝 Python 3.10 或更高版本後再開啟。', en: 'Python 3.10+ runtime not found. Please install Python 3.10+ before enabling.' },
  'rehydrate.err.installPythonFailed': { 'zh-CN': '自动安装 Python 3.10+ 失败，请检查网络连接或代理设置后重试，或手动安装 Python 3.10+。', 'zh-TW': '自動安裝 Python 3.10+ 失敗，請檢查網路連線或代理設定後重試，或手動安裝 Python 3.10+。', en: 'Automatic Python 3.10+ installation failed. Check your network/proxy and retry, or install Python 3.10+ manually.' },
  'rehydrate.err.corruptHooksJson': { 'zh-CN': '~/.gemini/config/hooks.json 格式损坏或非合法 JSON 对象，为保护已有配置已中止写入。', 'zh-TW': '~/.gemini/config/hooks.json 格式損壞或非合法 JSON 物件，為保護既有設定已中止寫入。', en: '~/.gemini/config/hooks.json is malformed or not a JSON object; write aborted safely to protect existing configs.' },
  'rehydrate.err.corruptModulesJson': { 'zh-CN': '插件配置文件 modules.json 已损坏，为避免重置其他设置已中止操作；请先修复或清理损坏的配置文件。', 'zh-TW': '外掛設定檔 modules.json 已損壞，為避免重設其他設定已中止操作；請先修復或清理損壞的設定檔。', en: 'Plugin config modules.json is corrupted; operation aborted to avoid resetting other settings. Repair or remove the corrupted config file first.' },
  'rehydrate.err.symlinkBlocked': { 'zh-CN': '检测到 ~/.gemini/config 目录或目标文件为符号链接，出于安全考虑已拒绝读写。', 'zh-TW': '偵測到 ~/.gemini/config 目錄或目標檔案為符號連結，出於安全考量已拒絕讀寫。', en: 'Symlink detected in ~/.gemini/config or target files; read/write blocked for safety.' },
  'rehydrate.err.missingScript': { 'zh-CN': '配置文件已开启该功能，但缺失恢复脚本 rehydrate_after_compact.py，请点击“开启”重新安装。', 'zh-TW': '設定檔已開啟此功能，但缺少恢復腳本 rehydrate_after_compact.py，請點擊「開啟」重新安裝。', en: 'Enabled in config, but rehydrate_after_compact.py is missing. Click Enable to reinstall it.' },
  'rehydrate.err.missingBundledScript': { 'zh-CN': '未找到随包附带的 rehydrate_after_compact.py 脚本资源。', 'zh-TW': '未找到隨包附帶的 rehydrate_after_compact.py 腳本資源。', en: 'Bundled rehydrate_after_compact.py script resource not found.' },
  'rehydrate.err.missingBackup': { 'zh-CN': '未找到开启前的原始脚本备份文件，为避免覆盖丢失已中止自动还原；如需直接清理可点击“卸载移除”。', 'zh-TW': '未找到開啟前的原始腳本備份檔案，為避免覆蓋遺失已中止自動還原；如需直接清理可點擊「解除安裝」。', en: 'Pre-existing script backup file is missing; automatic restore aborted safely. Click Remove if you want to uninstall directly.' },

  // 颜色与拾色器 & 更新弹窗补充
  'colors.swatchTitle': { 'zh-CN': '点击打开调色板', 'zh-TW': '點擊開啟調色盤', en: 'Click to pick color' },
  'colors.lvl0Title': { 'zh-CN': '热力图第1档：少/无用量（点击独立调色）', 'zh-TW': '熱力圖第1檔：少/無用量（點擊獨立調色）', en: 'Heatmap Level 1: None/Low (click to edit)' },
  'colors.lvl1Title': { 'zh-CN': '热力图第2档：低用量（点击独立调色）', 'zh-TW': '熱力圖第2檔：低用量（點擊獨立調色）', en: 'Heatmap Level 2: Light (click to edit)' },
  'colors.lvl2Title': { 'zh-CN': '热力图第3档：中等用量（点击独立调色）', 'zh-TW': '熱力圖第3檔：中等用量（點擊獨立調色）', en: 'Heatmap Level 3: Medium (click to edit)' },
  'colors.lvl3Title': { 'zh-CN': '热力图第4档：高用量（点击独立调色）', 'zh-TW': '熱力圖第4檔：高用量（點擊獨立調色）', en: 'Heatmap Level 4: High (click to edit)' },
  'colors.lvl4Title': { 'zh-CN': '热力图第5档：多/峰值用量（点击独立调色）', 'zh-TW': '熱力圖第5檔：多/峰值用量（點擊獨立調色）', en: 'Heatmap Level 5: Peak (click to edit)' },
  'colors.panelBgSwatch': { 'zh-CN': '面板与菜单背景色', 'zh-TW': '面板與選單背景色', en: 'Panel & Menu Background' },
  'cp.closeAria': { 'zh-CN': '关闭调色器', 'zh-TW': '關閉調色盤', en: 'Close color picker' },
  'cp.eyedropperTitle': { 'zh-CN': '屏幕取色器 (吸管)', 'zh-TW': '螢幕取色器 (吸管)', en: 'Eyedropper' },
  'cp.hexAria': { 'zh-CN': 'HEX 色值', 'zh-TW': 'HEX 色值', en: 'HEX value' },
  'cp.copyHex': { 'zh-CN': '复制 HEX', 'zh-TW': '複製 HEX', en: 'Copy HEX' },
  'cp.rgbAria': { 'zh-CN': 'RGB 色值', 'zh-TW': 'RGB 色值', en: 'RGB value' },
  'cp.copyRgb': { 'zh-CN': '复制 RGB', 'zh-TW': '複製 RGB', en: 'Copy RGB' },
  'cp.hslAria': { 'zh-CN': 'HSL 色值', 'zh-TW': 'HSL 色值', en: 'HSL value' },
  'cp.copyHsl': { 'zh-CN': '复制 HSL', 'zh-TW': '複製 HSL', en: 'Copy HSL' },
  'update.dialogAria': { 'zh-CN': '软件更新', 'zh-TW': '軟體更新', en: 'Software Update' },

  // 订阅表单、自定义日期选择器与热力图补充
  'plan.country.title': { 'zh-CN': '仅作为本地显示记录 · 不修改实际 Google 账号', 'zh-TW': '僅作為本機顯示記錄 · 不修改實際 Google 帳號', en: 'Local display record only · does not change your Google account' },
  'plan.region.title': { 'zh-CN': '实际购买或支付订阅所在的国家或地区', 'zh-TW': '實際購買或支付訂閱所在的國家或地區', en: 'Country or region where the subscription is billed' },
  'plan.currency.aria': { 'zh-CN': '选择订阅币种', 'zh-TW': '選擇訂閱幣別', en: 'Select subscription currency' },
  'plan.currency.title': { 'zh-CN': '订阅计价与结算币种', 'zh-TW': '訂閱計價與結算幣別', en: 'Subscription billing currency' },
  'plan.country.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'plan.region.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'plan.cnyApprox': { 'zh-CN': '≈ ¥{val} CNY/月', 'zh-TW': '約 ¥{val} CNY/月', en: '≈ ${val}/mo' },
  'plan.cnyShort': { 'zh-CN': '≈ ¥{val} CNY', 'zh-TW': '約 ¥{val} CNY', en: 'approx. ${val} USD' },
  'plan.usdApprox': { 'zh-CN': '≈ ${val} USD', 'zh-TW': '約 ${val} USD', en: 'approx. ${val} USD' },
  'plan.usdApproxMo': { 'zh-CN': '≈ ${val} USD/月', 'zh-TW': '約 ${val} USD/月', en: 'approx. ${val} USD/mo' },
  'datePicker.placeholder': { 'zh-CN': '年 / 月 / 日', 'zh-TW': '年 / 月 / 日', en: 'YYYY-MM-DD' },
  'datePicker.clear': { 'zh-CN': '清除', 'zh-TW': '清除', en: 'Clear' },
  'datePicker.today': { 'zh-CN': '今天', 'zh-TW': '今天', en: 'Today' },
  'datePicker.prevMonth': { 'zh-CN': '上个月', 'zh-TW': '上個月', en: 'Previous month' },
  'datePicker.nextMonth': { 'zh-CN': '下个月', 'zh-TW': '下個月', en: 'Next month' },
  'datePicker.weekdays': { 'zh-CN': '日,一,二,三,四,五,六', 'zh-TW': '日,一,二,三,四,五,六', en: 'Su,Mo,Tu,We,Th,Fr,Sa' },
  'datePicker.monthTitle': { 'zh-CN': '{y}年{m}月', 'zh-TW': '{y}年{m}月', en: '{monthEn} {y}' },
  'datePicker.ariaLabel': { 'zh-CN': '选择权益到期日期', 'zh-TW': '選擇權益到期日期', en: 'Choose expiration date' },
  'plan.acqOpt.normal_paid': { 'zh-CN': '正常官方付费订阅', 'zh-TW': '正常官方付費訂閱', en: 'Standard paid subscription' },
  'plan.acqOpt.student_offer': { 'zh-CN': '学生教育优惠 · Google AI Pro', 'zh-TW': '學生教育優惠 · Google AI Pro', en: 'Student discount · Google AI Pro' },
  'plan.acqOpt.pixel_bundle': { 'zh-CN': 'Pixel 手机购机赠送权益', 'zh-TW': 'Pixel 手機購機贈送權益', en: 'Pixel phone bundle perk' },
  'plan.acqOpt.chromebook_bundle': { 'zh-CN': 'Chromebook 购机赠送权益', 'zh-TW': 'Chromebook 購機贈送權益', en: 'Chromebook bundle perk' },
  'plan.acqOpt.samsung_galaxy': { 'zh-CN': 'Samsung Galaxy 手机赠送权益', 'zh-TW': 'Samsung Galaxy 手機贈送權益', en: 'Samsung Galaxy perk' },
  'plan.acqOpt.jio_offer': { 'zh-CN': 'Jio 运营商优惠活动', 'zh-TW': 'Jio 電信優惠活動', en: 'Jio carrier promotion' },
  'plan.acqOpt.partner_carrier': { 'zh-CN': '合作运营商 / 活动赠送', 'zh-TW': '合作電信商 / 活動贈送', en: 'Carrier / partner promotion' },
  'plan.acqOpt.family_sharing': { 'zh-CN': 'Google 家庭共享成员', 'zh-TW': 'Google 家庭共享成員', en: 'Google Family Sharing' },
  'plan.acqOpt.official_promo': { 'zh-CN': '官方试用 / 促销优惠', 'zh-TW': '官方試用 / 促銷優惠', en: 'Official trial / promo' },
  'plan.acqOpt.custom_source': { 'zh-CN': '其他自定义渠道', 'zh-TW': '其他自訂管道', en: 'Other custom source' },
  'plan.form.presetPlaceholder': { 'zh-CN': '选择预设地区 · 自动填入价格与汇率', 'zh-TW': '選擇預設地區 · 自動填入價格與匯率', en: 'Choose preset region · auto-fill price' },
  'plan.form.presetCustom': { 'zh-CN': '✎ 自定义输入地区', 'zh-TW': '✎ 自訂輸入地區', en: '✎ Custom region' },
  'plan.form.countryPh': { 'zh-CN': '例如 US 美国', 'zh-TW': '例如 US 美國', en: 'e.g. US United States' },
  'plan.form.regionPh': { 'zh-CN': '例如 KR 韩国 或 AU 澳大利亚', 'zh-TW': '例如 KR 韓國 或 AU 澳洲', en: 'e.g. KR South Korea or AU Australia' },
  'plan.form.presetLine': { 'zh-CN': '{flag} {id} {name} · {sym}{price}/月{conv}', 'zh-TW': '{flag} {id} {name} · {sym}{price}/月{conv}', en: '{flag} {id} {name} · {sym}{price}/mo{conv}' },
  'plan.form.presetLineCny': { 'zh-CN': '{flag} {id} {name} · ¥{price}/月{conv}', 'zh-TW': '{flag} {id} {name} · ¥{price}/月{conv}', en: '{flag} {id} {name} · ¥{price}/mo{conv}' },
  'plan.cycleOpt.monthly': { 'zh-CN': '月付', 'zh-TW': '月付', en: 'Monthly' },
  'plan.cycleOpt.yearly': { 'zh-CN': '年付', 'zh-TW': '年付', en: 'Yearly' },
  'plan.cycleOpt.free': { 'zh-CN': '免费 / 促销赠送', 'zh-TW': '免費 / 促銷贈送', en: 'Free / Promo' },
  'plan.cycleOpt.included': { 'zh-CN': '随套餐包含', 'zh-TW': '隨方案包含', en: 'Included in bundle' },
  'plan.cycleOpt.other': { 'zh-CN': '其他周期', 'zh-TW': '其他週期', en: 'Other cycle' },
  'tokens.heat.prevTitle': { 'zh-CN': '上一个周期', 'zh-TW': '上一個週期', en: 'Previous period' },
  'tokens.heat.nextTitle': { 'zh-CN': '下一个周期', 'zh-TW': '下一個週期', en: 'Next period' },
  'tokens.heat.tabsAria': { 'zh-CN': '热力图时间维度', 'zh-TW': '熱力圖時間維度', en: 'Heatmap time dimension' },
  'tokens.heat.legendTitle': { 'zh-CN': '点击任意档位色块即可单独自定义该档颜色', 'zh-TW': '點擊任意檔位色塊即可單獨自訂該檔顏色', en: 'Click any legend swatch to customize its color' },
  'tokens.heat.lvl0Aria': { 'zh-CN': '热力图第1档颜色', 'zh-TW': '熱力圖第1檔顏色', en: 'Heatmap level 1 color' },
  'tokens.heat.lvl0Swatch': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Heatmap Level 1 (None/Low)' },
  'tokens.heat.lvl1Aria': { 'zh-CN': '热力图第2档颜色', 'zh-TW': '熱力圖第2檔顏色', en: 'Heatmap level 2 color' },
  'tokens.heat.lvl1Swatch': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Heatmap Level 2 (Light)' },
  'tokens.heat.lvl2Aria': { 'zh-CN': '热力图第3档颜色', 'zh-TW': '熱力圖第3檔顏色', en: 'Heatmap level 3 color' },
  'tokens.heat.lvl2Swatch': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Heatmap Level 3 (Medium)' },
  'tokens.heat.lvl3Aria': { 'zh-CN': '热力图第4档颜色', 'zh-TW': '熱力圖第4檔顏色', en: 'Heatmap level 4 color' },
  'tokens.heat.lvl3Swatch': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Heatmap Level 4 (High)' },
  'tokens.heat.lvl4Aria': { 'zh-CN': '热力图第5档颜色', 'zh-TW': '熱力圖第5檔顏色', en: 'Heatmap level 5 color' },
  'tokens.heat.lvl4Swatch': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/尖峰用量）', en: 'Heatmap Level 5 (Peak)' },
  'tokens.heat.lowEndAria': { 'zh-CN': '热力图少端颜色', 'zh-TW': '熱力圖少端顏色', en: 'Heatmap low end color' },
  'tokens.heat.lowEndSwatch': { 'zh-CN': '热力图「少」端颜色', 'zh-TW': '熱力圖「少」端顏色', en: 'Heatmap Low Color' },
  'tokens.heat.highEndAria': { 'zh-CN': '热力图多端颜色', 'zh-TW': '熱力圖多端顏色', en: 'Heatmap high end color' },
  'tokens.heat.highEndSwatch': { 'zh-CN': '热力图「多」端颜色', 'zh-TW': '熱力圖「多」端顏色', en: 'Heatmap High Color' },
  'tokens.heat.totalSwatch': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 Token 用量', en: 'Total Tokens Color' },
  'tokens.heat.accentSwatch': { 'zh-CN': 'Token 強調色', 'zh-TW': 'Token 強調色', en: 'Token Accent Color' },

  // 其余散落文案
  'drawer.shortExpand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
  'drawer.shortCollapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
  'scan.failPrefix': { 'zh-CN': '读取会话失败：{err}', 'zh-TW': '讀取工作階段失敗：{err}', en: 'Failed to read session: {err}' },
  'scan.notLoadedPrefix': { 'zh-CN': '无法读取全量会话：{err}', 'zh-TW': '無法讀取全量工作階段：{err}', en: 'Failed to scan session: {err}' },
  'mod.proxy.emptyErr': { 'zh-CN': '请输入有效的代理地址', 'zh-TW': '請輸入有效的代理位址', en: 'Enter a valid proxy URL' },
  'mod.proxy.toggleFail': { 'zh-CN': '切换失败', 'zh-TW': '切換失敗', en: 'Toggle failed' },
  'mod.proxy.connOk': { 'zh-CN': '✔ 本地代理正常，Google 连通 ({ms}ms)', 'zh-TW': '✔ 本機代理正常，Google 連通 ({ms}ms)', en: '✔ Proxy healthy, Google reachable ({ms}ms)' },
  'mod.proxy.connFail': { 'zh-CN': '✖ 连通性测试失败：{detail}', 'zh-TW': '✖ 連通性測試失敗：{detail}', en: '✖ Connectivity test failed: {detail}' },

  // 模型额度看板 (ELV-34)
  'badge.quota.aria': { 'zh-CN': '模型剩余额度与重置状态', 'zh-TW': '模型剩餘額度與重設狀態', en: 'Model remaining quota and reset status' },
  'overflow.quota': { 'zh-CN': '模型额度', 'zh-TW': '模型額度', en: 'Model Quota' },
  'quota.panel.aria': { 'zh-CN': '模型额度看板', 'zh-TW': '模型額度看板', en: 'Model Quota Board' },
  'quota.panel.title': { 'zh-CN': '◔ 模型额度看板', 'zh-TW': '◔ 模型額度看板', en: '◔ Model Quota' },
  'quota.refresh.aria': { 'zh-CN': '手动刷新模型额度', 'zh-TW': '手動重新整理模型額度', en: 'Refresh model quota' },
  'quota.refresh.btn': { 'zh-CN': '刷新', 'zh-TW': '重新整理', en: 'Refresh' },
  'quota.refresh.busy': { 'zh-CN': '刷新中', 'zh-TW': '更新中', en: 'Syncing' },
  'quota.refresh.upToDate': { 'zh-CN': '已更新', 'zh-TW': '已更新', en: 'Up to date' },
  'quota.retry': { 'zh-CN': '重试', 'zh-TW': '重試', en: 'Retry' },
  'quota.time.updated': { 'zh-CN': '数据更新时间', 'zh-TW': '資料更新時間', en: 'Updated' },
  'quota.time.nextRefresh': { 'zh-CN': '下次自动刷新', 'zh-TW': '下次自動重新整理', en: 'Next Refresh' },
  'quota.time.reset': { 'zh-CN': '当前额度重置', 'zh-TW': '目前額度重設', en: 'Quota Reset' },
  'quota.time.paused': { 'zh-CN': '后台已暂停', 'zh-TW': '背景已暫停', en: 'Paused (bg)' },
  'quota.time.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.current.label': { 'zh-CN': '当前会话模型', 'zh-TW': '目前工作階段模型', en: 'Active Session Model' },
  'quota.current.unmatched': { 'zh-CN': '暂未识别当前模型', 'zh-TW': '暫未識別目前模型', en: 'Active model not detected' },
  'quota.current.tag': { 'zh-CN': '当前使用', 'zh-TW': '目前使用', en: 'Active' },
  'quota.pools.heading': { 'zh-CN': '共享额度池与模型分布', 'zh-TW': '共享額度池與模型分佈', en: 'Shared Quota Pools' },
  'quota.pools.othersHeading': { 'zh-CN': '其他共享额度池', 'zh-TW': '其他共享額度池', en: 'Other Shared Quota Pools' },
  'quota.pace.labelPrefix': { 'zh-CN': '节奏', 'zh-TW': '節奏', en: 'Pace' },
  'quota.pools.browseHint': { 'zh-CN': '点击可查看详情（不切换当前会话模型）', 'zh-TW': '點擊可檢視詳情（不切換目前工作階段模型）', en: 'Click to inspect (session model unchanged)' },
  'quota.pools.empty': { 'zh-CN': '暂未获取到共享额度池数据，请点击刷新。', 'zh-TW': '暫未取得共享額度池資料，請點擊重新整理。', en: 'No shared quota pool data yet. Click Refresh.' },
  'quota.basisNote': { 'zh-CN': '百分比与重置时间来自宿主接口；「约剩余 Token」按本机输入+缓存+输出原始 Token 统计，受服务端计费权重、同池模型混用、他端消耗及周期采样覆盖度影响；校准过期或样本不足时不按有效推算展示。', 'zh-TW': '百分比與重設時間來自宿主介面；「約剩餘 Token」按本機輸入+快取+輸出原始 Token 統計，受伺服端計費權重、同池模型混用、他端消耗及週期採樣覆蓋度影響；校準過期或樣本不足時不按有效推算顯示。', en: 'Percentages & reset times come from host APIs. Estimated tokens (~) sum raw local input+cache+output tokens; billing weights, mixed models in one pool, external devices, and cycle coverage affect accuracy. Expired or invalidated calibrations are never shown as reliable.' },
  'quota.usageTip': { 'zh-CN': '💡 用量提示：使用前可先查看各池剩余额度，优先选择余量充足且适合当前任务的模型。', 'zh-TW': '💡 用量提示：使用前可先檢視各池剩餘額度，優先選擇餘量充足且適合目前任務的模型。', en: '💡 Usage tip: Check pool headroom before starting heavy work and pick an available model that fits the task.' },
  'quota.est.approx': { 'zh-CN': '约剩余 {tokens} Token', 'zh-TW': '約剩餘 {tokens} Token', en: '~{tokens} tokens left' },
  'quota.est.exhausted': { 'zh-CN': '约剩余 0 Token · 额度已耗尽', 'zh-TW': '約剩餘 0 Token · 額度已耗盡', en: '0 tokens left · exhausted' },
  'quota.est.waiting': { 'zh-CN': '剩余 Token 暂无法估算，等待有效消耗样本', 'zh-TW': '剩餘 Token 暫無法估算，等待有效消耗樣本', en: 'Token estimate awaiting valid local samples' },
  'quota.est.incomplete': { 'zh-CN': '剩余 Token 暂无法估算，检测到未采集消耗或采样失真', 'zh-TW': '剩餘 Token 暫無法估算，偵測到未採集消耗或採樣失真', en: 'Token estimate unavailable due to external usage or sample distortion' },
  'quota.est.expired': { 'zh-CN': '剩余 Token 暂无法估算，历史校准已过期并等待新样本', 'zh-TW': '剩餘 Token 暫無法估算，歷史校準已過期並等待新樣本', en: 'Token estimate unavailable · calibration expired' },
  'quota.est.coverageIncomplete': { 'zh-CN': '剩余 Token 暂无法估算，缺少本周期完整覆盖记录', 'zh-TW': '剩餘 Token 暫無法估算，缺少本週期完整覆蓋記錄', en: 'Token estimate unavailable · incomplete cycle coverage' },
  'quota.est.basisDelta': { 'zh-CN': '实耗差值校准 · 估算值', 'zh-TW': '實耗差值校準 · 估算值', en: 'Delta calibrated · estimate' },
  'quota.est.basisCycle': { 'zh-CN': '本周期实耗推算 · 估算值', 'zh-TW': '本週期實耗推算 · 估算值', en: 'Cycle usage est. · estimate' },
  'quota.est.basisCached': { 'zh-CN': '沿用上周期校准参考，待本周期复核', 'zh-TW': '沿用上週期校準參考，待本週期覆核', en: 'Prior-cycle calibration ref · unverified' },
  'quota.est.basisStaleDivergence': { 'zh-CN': '历史校准不可靠（检测到未采集消耗）', 'zh-TW': '歷史校準不可靠（偵測到未採集消耗）', en: 'Stale calibration unreliable (external usage detected)' },

  // 多账号、自动切号、ELV-57 配额对照与 ELV-52 保活
  'accounts.filterLabel': { 'zh-CN': '账本范围:', 'zh-TW': '帳本範圍:', en: 'Account Scope:' },
  'accounts.filterAria': { 'zh-CN': '按账号筛选统计账本', 'zh-TW': '依帳號篩選統計帳本', en: 'Filter ledger by account' },
  'accounts.filterAll': { 'zh-CN': '全部已记用量（含未归属）', 'zh-TW': '全部已記用量（含未歸屬）', en: 'All Recorded (incl. Unattributed)' },
  'accounts.filterUnattributed': { 'zh-CN': '历史未归属（无可靠账号依据）', 'zh-TW': '歷史未歸屬（無可靠帳號依據）', en: 'Unattributed History (No Verified Account)' },
  'accounts.panelTitle': { 'zh-CN': '👤 多账号切换与阈值自动切号', 'zh-TW': '👤 多帳號切換與閾值自動切號', en: '👤 Accounts & Threshold Auto-Switch' },
  'accounts.importCurrent': { 'zh-CN': '导入当前', 'zh-TW': '匯入目前帳號', en: 'Import Current' },
  'accounts.importTools': { 'zh-CN': '导入 Tools', 'zh-TW': '匯入 Tools', en: 'Import Tools' },
  'accounts.oauthAdd': { 'zh-CN': '+ 登录添加', 'zh-TW': '+ 登入新增', en: '+ Google Sign-In' },
  'accounts.switchBtn': { 'zh-CN': '切号', 'zh-TW': '切號', en: 'Switch' },
  'accounts.activeTag': { 'zh-CN': '当前', 'zh-TW': '目前', en: 'Active' },
  'accounts.empty': { 'zh-CN': '暂无已登记账号，可点击“导入当前”或“登录添加”。', 'zh-TW': '暫無已登記帳號，可點擊「匯入目前帳號」或「登入新增」。', en: 'No accounts saved yet. Click Import Current or Google Sign-In.' },
  'accounts.autoSwitchEnable': { 'zh-CN': '启用阈值自动切号，默认关闭', 'zh-TW': '啟用閾值自動切號，預設關閉', en: 'Enable threshold auto-switch (Off by default)' },
  'accounts.poolLabel': { 'zh-CN': '监控共享池', 'zh-TW': '監控共享池', en: 'Target Pool' },
  'accounts.metricLabel': { 'zh-CN': '判断口径', 'zh-TW': '判斷口徑', en: 'Trigger Metric' },
  'accounts.modeRemaining': { 'zh-CN': '按剩余额度 <=', 'zh-TW': '依剩餘額度 <=', en: 'Remaining <=' },
  'accounts.modeUsed': { 'zh-CN': '按累计已用 >=', 'zh-TW': '依累計已用 >=', en: 'Used >=' },
  'accounts.windowLabel': { 'zh-CN': '限额窗口', 'zh-TW': '限額視窗', en: 'Window' },
  'accounts.winPrimary': { 'zh-CN': '主窗口最紧缩', 'zh-TW': '主視窗最緊縮', en: 'Primary Tightest' },
  'accounts.thresholdLabel': { 'zh-CN': '阈值 (%)', 'zh-TW': '閾值 (%)', en: 'Threshold (%)' },
  'accounts.candidatesLabel': { 'zh-CN': '允许切入的候选账号：', 'zh-TW': '允許切入的候選帳號：', en: 'Candidate accounts allowed:' },
  'accounts.saveRule': { 'zh-CN': '保存切号规则', 'zh-TW': '儲存切號規則', en: 'Save Rule' },
  'quota.compareTitle': { 'zh-CN': '📊 本机消耗与共享账号额度对照', 'zh-TW': '📊 本機消耗與共享帳號額度對照', en: '📊 Local Usage vs. Shared Quota Deltas' },
  'quota.compareDisclaimer': { 'zh-CN': '按同一账号与共享池统计。账面百分点下降受多设备使用、取整、重置与滚动恢复影响，不等同于本机单独消耗占比。', 'zh-TW': '依同一帳號與共享池統計。帳面百分點下降受多裝置使用、取整、重置與滾動恢復影響，不等同於本機單獨消耗佔比。', en: 'Scoped per account & pool. Quota percentage-point changes reflect shared multi-device usage, rounding, resets, and rolling recovery — not solely local consumption.' },
  'quota.compareEmpty': { 'zh-CN': '暂未累积同一账号前后两次配额采样对照区间（刷新配额后自动对比）。', 'zh-TW': '暫未累積同一帳號前後兩次配額採樣對照區間（重新整理配額後自動對比）。', en: 'No completed quota comparison intervals yet. Refresh quota to capture baseline & delta.' },
  'keepalive.title': { 'zh-CN': '🧊 模型缓存保活状态与协议核查', 'zh-TW': '🧊 模型快取保活狀態與協定核查', en: '🧊 Prompt Cache Keepalive & Protocol Check' },
  'keepalive.stopBtn': { 'zh-CN': '立即停止保活', 'zh-TW': '立即停止保活', en: 'Stop Keepalive Now' },
  'quota.est.mixedModels': { 'zh-CN': '同池混用模型', 'zh-TW': '同池混用模型', en: 'mixed pool models' },
  'quota.est.cycleUsed': { 'zh-CN': '本周期已记 {used}', 'zh-TW': '本週期已記 {used}', en: 'Cycle used {used}' },
  'quota.state.available': { 'zh-CN': '正常可用', 'zh-TW': '正常可用', en: 'Available' },
  'quota.state.low': { 'zh-CN': '余量较低', 'zh-TW': '餘量較低', en: 'Low' },
  'quota.state.exhausted': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Exhausted' },
  'quota.state.no_permission': { 'zh-CN': '权限不足', 'zh-TW': '權限不足', en: 'No Access' },
  'quota.state.stale': { 'zh-CN': '数据过期', 'zh-TW': '資料過期', en: 'Stale' },
  'quota.state.error': { 'zh-CN': '刷新失败', 'zh-TW': '重新整理失敗', en: 'Failed' },
  'quota.state.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.short.exhausted': { 'zh-CN': '耗尽', 'zh-TW': '耗盡', en: '0% Empty' },
  'quota.short.no_permission': { 'zh-CN': '无权限', 'zh-TW': '無權限', en: 'No Access' },
  'quota.short.error': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'quota.short.stale': { 'zh-CN': '过期', 'zh-TW': '過期', en: 'Stale' },
  'quota.short.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.staleBanner': { 'zh-CN': '当前展示历史缓存数据 · {reason}，请手动刷新确认最新额度.', 'zh-TW': '目前顯示歷史快取資料 · {reason}，請手動重新整理確認最新額度.', en: 'Showing cached data · {reason}. Refresh to verify latest quota.' },
  'quota.errorBanner': { 'zh-CN': '获取模型额度失败：{reason} · 这不代表额度已耗尽', 'zh-TW': '取得模型額度失敗：{reason} · 這不代表額度已耗盡', en: 'Quota fetch failed: {reason} · does not mean quota exhausted' },
  'quota.bridgeMissing': { 'zh-CN': '额度接口桥接尚未加载，如刚完成安装或更新请重启 Antigravity.', 'zh-TW': '額度介面橋接尚未載入，如剛完成安裝或更新請重新啟動 Antigravity.', en: 'Quota bridge is not loaded yet; restart Antigravity after install or update.' },
  'quota.pendingRestartBanner': { 'zh-CN': '主进程更新尚未重启生效，当前额度或套餐解析可能来自旧版本进程，请重启客户端完成加载。', 'zh-TW': '主程序更新尚未重新啟動生效，目前額度或方案解析可能來自舊版程序，請重新啟動用戶端完成載入。', en: 'Update pending restart: quota/plan parsing may reflect the previous main-process version. Restart client to complete.' },
  'quota.backendMismatchBanner': { 'zh-CN': '界面已热加载为 v{uiVer}，但实际后台仍由旧版 ({backendVer} / {source}) 处理；如需完整新版主进程能力，请重启客户端。', 'zh-TW': '介面已熱載入為 v{uiVer}，但實際後台仍由舊版 ({backendVer} / {source}) 處理；如需完整新版主程序能力，請重新啟動用戶端。', en: 'UI hot-reloaded to v{uiVer}, but backend still runs v{backendVer} ({source}). Restart client to complete upgrade.' },
  'quota.restartBtn': { 'zh-CN': '重启客户端', 'zh-TW': '重新啟動用戶端', en: 'Restart Client' },
  'quota.resetPassReason': { 'zh-CN': '已到重置时间待确认', 'zh-TW': '已到重設時間待確認', en: 'Reset window reached, pending verify' },
  'quota.ageExpiredReason': { 'zh-CN': '距上次获取已超过 3 分钟', 'zh-TW': '距上次取得已超過 3 分鐘', en: 'Cached over 3m ago' },
  'quota.modelChip.tooltip': { 'zh-CN': '{model} · 池: {pool} · {status} ({value})', 'zh-TW': '{model} · 池: {pool} · {status} ({value})', en: '{model} · Pool: {pool} · {status} ({value})' },
  'quota.modelChip.unpooled': { 'zh-CN': '未归属当前账号额度池', 'zh-TW': '未歸屬目前帳號額度池', en: 'Not in active quota pools' },
  'quota.modelChip.resetPart': { 'zh-CN': '重置: {reset}', 'zh-TW': '重設: {reset}', en: 'Reset: {reset}' },
  'quota.modelChip.historyHint': { 'zh-CN': '仅历史记录 / 本地配置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / local preference only' },
  'accounts.poolNoAccess': { 'zh-CN': '无模型权限', 'zh-TW': '無模型權限', en: 'No model access' },
  'accounts.poolUnknown': { 'zh-CN': '权限/额度未知', 'zh-TW': '權限/額度未知', en: 'Quota unknown' },
  'accounts.poolPending': { 'zh-CN': '额度暂不可用', 'zh-TW': '額度暫不可用', en: 'Quota unavailable' },
  'accounts.retryQuota': { 'zh-CN': '刷新/重试额度', 'zh-TW': '重試額度', en: 'Retry quota' },
  'accounts.reauthRequired': { 'zh-CN': '需重登授权', 'zh-TW': '需重新登入授權', en: 'Re-auth required' },
  'accounts.removeBtn': { 'zh-CN': '移除账号', 'zh-TW': '移除帳號', en: 'Remove' },
  'accounts.removeModal.title': { 'zh-CN': '移除账号', 'zh-TW': '移除帳號', en: 'Remove account' },
  'accounts.removeModal.body': {
    'zh-CN': '确定移除 {email} 吗？这会移除插件保存的登录凭据和自动切号候选，本机历史用量与原有账号归属会保留。',
    'zh-TW': '確定移除 {email} 嗎？這會移除外掛儲存的登入憑證與自動切號候選，本機歷史用量與原有帳號歸屬會保留。',
    en: 'Remove {email}? Stored plugin credentials and auto-switch candidacy will be removed. Local usage history and existing attribution are preserved.'
  },
  'accounts.removeModal.bodyActive': {
    'zh-CN': '确定移除当前活跃账号 {email} 吗？这会移除插件保存的登录凭据和自动切号候选，本机历史用量与原有账号归属会保留，不会自动切换其他账号。',
    'zh-TW': '確定移除目前使用中的帳號 {email} 嗎？這會移除外掛儲存的登入憑證與自動切號候選，本機歷史用量與原有帳號歸屬會保留，不會自動切換其他帳號。',
    en: 'Remove currently active account {email}? Stored plugin credentials and auto-switch candidacy will be removed. Local usage history and existing attribution are preserved without switching accounts.'
  },
  'accounts.removeModal.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'accounts.removeModal.confirm': { 'zh-CN': '确认移除', 'zh-TW': '確認移除', en: 'Confirm Remove' },
  'accounts.removeModal.removing': { 'zh-CN': '移除中…', 'zh-TW': '移除中…', en: 'Removing…' },
  'accounts.removeModal.failed': { 'zh-CN': '移除失败：{detail}', 'zh-TW': '移除失敗：{detail}', en: 'Remove failed: {detail}' },
  'accounts.removeSuccess': { 'zh-CN': '已移除 {email}，历史用量及归属已保留.', 'zh-TW': '已移除 {email}，歷史用量與歸屬已保留.', en: 'Removed {email}; historical usage and attribution preserved.' },
  'accounts.quotaStageErr': { 'zh-CN': '本次刷新失败 · 上次快照已保留：{detail}', 'zh-TW': '本次重新整理失敗 · 上次快照已保留：{detail}', en: 'Quota fetch failed, previous snapshot kept: {detail}' },
  'accounts.lastSnapshotTime': { 'zh-CN': '上次快照 {time}', 'zh-TW': '上次快照 {time}', en: 'Last snapshot {time}' },
  'accounts.status.disabled': { 'zh-CN': '已关闭', 'zh-TW': '已關閉', en: 'Off' },
  'accounts.status.watching': { 'zh-CN': '监控中', 'zh-TW': '監控中', en: 'Watching' },
  'accounts.status.pending_debounce': { 'zh-CN': '防抖确认中', 'zh-TW': '防抖確認中', en: 'Debouncing' },
  'accounts.status.waiting_idle': { 'zh-CN': '等待当前生成完成', 'zh-TW': '等待目前生成完成', en: 'Waiting idle' },
  'accounts.status.cooldown': { 'zh-CN': '冷却保护中', 'zh-TW': '冷卻保護中', en: 'Cooldown' },
  'accounts.status.switching': { 'zh-CN': '切号中', 'zh-TW': '切號中', en: 'Switching' },
  'accounts.status.all_candidates_exhausted': { 'zh-CN': '备选账号均不足', 'zh-TW': '備選帳號皆不足', en: 'All candidates exhausted' },
  'accounts.status.blocked_untrusted_quota': { 'zh-CN': '数据不可信已跳过', 'zh-TW': '資料不可信已跳過', en: 'Skipped (Stale/Error)' },
  'accounts.status.blocked_missing_pool': { 'zh-CN': '所选池不可用', 'zh-TW': '所選池無法使用', en: 'Pool unavailable' },
  'accounts.status.blocked_missing_account': { 'zh-CN': '未识别当前账号', 'zh-TW': '未識別目前帳號', en: 'Account unknown' },
  'accounts.status.error': { 'zh-CN': '失败已停用', 'zh-TW': '失敗已停用', en: 'Halted (Error)' },
  'accounts.blockedReason.no_permission': { 'zh-CN': '当前账号 {email} 对监控池 {pool} 无模型权限，请切换监测池或改用兼容账号', 'zh-TW': '目前帳號 {email} 對監控池 {pool} 無模型權限，請切換監測池或改用相容帳號', en: '{email} has no access to {pool}; switch pool or use a compatible account' },
  'accounts.blockedReason.missing_pool': { 'zh-CN': '当前账号 {email} 尚未返回监控池 {pool}，请刷新配额或改选其他共享池', 'zh-TW': '目前帳號 {email} 尚未回傳監控池 {pool}，請重新整理配額或改選其他池', en: '{email} has no {pool} data; refresh quota or pick another pool' },
  'accounts.blockedReason.missing_window': { 'zh-CN': '当前账号 {email} 的 {pool} 暂未返回所选限额窗口 {window}，建议改为“主窗口最紧缩”或刷新配额', 'zh-TW': '目前帳號 {email} 的 {pool} 尚未回傳所選視窗 {window}，建議改為「主視窗最緊縮」或重新整理配額', en: '{email} {pool} lacks {window} window data; use Primary Tightest or refresh quota' },
  'accounts.blockedReason.missing_value': { 'zh-CN': '当前账号 {email} 在 {pool} 缺少有效剩余额度数值，等待刷新确认', 'zh-TW': '目前帳號 {email} 在 {pool} 缺少有效剩餘額度數值，等待重新整理確認', en: '{email} lacks a valid fraction on {pool}; awaiting refresh' },
  'accounts.blockedReason.missing_active_account': { 'zh-CN': '未识别当前活跃账号，请点击“导入当前”或刷新配额', 'zh-TW': '未識別目前使用中帳號，請點擊「匯入目前帳號」或重新整理配額', en: 'Active account unresolved; click Import Current or refresh quota' },
  'accounts.blockedReason.all_candidates_exhausted': { 'zh-CN': '所有候选账号的 {pool} 额度也低于阈值，请补充候选账号或调低阈值', 'zh-TW': '所有候選帳號的 {pool} 額度亦低於閾值，請補充候選帳號或調低閾值', en: 'All candidates are also below threshold on {pool}; add candidates or lower threshold' },
  'accounts.blockedReason.untrusted_quota': { 'zh-CN': '当前配额快照过期或刷新失败，已暂停自动切号，刷新恢复后自动继续', 'zh-TW': '目前配額快照過期或重新整理失敗，已暫停自動切號，重新整理恢復後自動繼續', en: 'Quota snapshot stale or failed; auto-switch paused until a clean refresh' },
  'accounts.blockedReason.waiting_idle': { 'zh-CN': '已达切号阈值，正在等待当前对话生成结束后切换', 'zh-TW': '已達切號閾值，正在等待目前對話生成結束後切換', en: 'Threshold met; waiting for current generation to finish before switching' },
  'accounts.blockedReason.cooldown': { 'zh-CN': '处于切号冷却保护期内，稍后自动恢复监测', 'zh-TW': '處於切號冷卻保護期內，稍後自動恢復監測', en: 'In switch cooldown protection; monitoring will resume automatically' },
  'accounts.blockedReason.pending_debounce': { 'zh-CN': '已触发阈值 · 防抖确认中 ({count}/{target})', 'zh-TW': '已觸發閾值 · 防抖確認中 ({count}/{target})', en: 'Threshold met · Debouncing ({count}/{target})' },
  'accounts.lastSwitchedTo': { 'zh-CN': '上次切至 {email}', 'zh-TW': '上次切至 {email}', en: 'Last switched to {email}' },
  'accounts.lastSwitchRolledBack': { 'zh-CN': '已自动回滚：{detail}', 'zh-TW': '已自動回滾：{detail}', en: 'Rolled back: {detail}' },
  'accounts.actionBusy': { 'zh-CN': '正在处理…', 'zh-TW': '處理中…', en: 'Processing…' },
  'accounts.actionDone': { 'zh-CN': '操作已完成', 'zh-TW': '操作已完成', en: 'Completed' },
  'accounts.actionFail': { 'zh-CN': '操作失败', 'zh-TW': '操作失敗', en: 'Operation failed' },
  'accounts.filterNoData': { 'zh-CN': '该账号在本机尚无已归属 Token 记录。', 'zh-TW': '此帳號在本機尚無已歸屬 Token 記錄。', en: 'No attributed local usage records for this account.' },
  'accounts.keepaliveOff': { 'zh-CN': '默认关闭', 'zh-TW': '預設關閉', en: 'Off' },
  'accounts.filterKeepaliveNote': { 'zh-CN': '含独立保活消耗 {reqs} 次 ({tok})。', 'zh-TW': '含獨立保活消耗 {reqs} 次 ({tok})。', en: 'Includes {reqs} keepalive reqs ({tok}) tracked separately.' },
  'tokens.noAccountCost': { 'zh-CN': '暂无此账号记录', 'zh-TW': '暫無此帳號記錄', en: 'No records for account' },
  'quota.split.account_switched': { 'zh-CN': '已切号分段', 'zh-TW': '已切號分段', en: 'Account switched' },
  'quota.split.quota_reset': { 'zh-CN': '额度重置', 'zh-TW': '額度重設', en: 'Quota reset' },
  'quota.split.rolling_recovery': { 'zh-CN': '滚动恢复', 'zh-TW': '滾動恢復', en: 'Rolling recovery' },
  'quota.split.sampling_gap': { 'zh-CN': '采样缺口切分', 'zh-TW': '採樣缺口切分', en: 'Sampling gap' },
  'quota.pace.surplus': { 'zh-CN': '宽裕', 'zh-TW': '寬裕', en: 'Ahead' },
  'quota.pace.balanced': { 'zh-CN': '均衡', 'zh-TW': '均衡', en: 'On Pace' },
  'quota.pace.fast': { 'zh-CN': '偏快', 'zh-TW': '偏快', en: 'Fast' },
  'quota.pace.overburn': { 'zh-CN': '透支', 'zh-TW': '透支', en: 'Overburn' },
  'quota.pace.exhaustedTag': { 'zh-CN': '已耗尽', 'zh-TW': '已耗盡', en: 'Exhausted' },
  'quota.pace.timeLeft': { 'zh-CN': '剩余时间 {pct}%', 'zh-TW': '剩餘時間 {pct}%', en: 'Time left {pct}%' },
  'quota.pace.resetIn': { 'zh-CN': '{countdown}后重置 · 剩余时间 {pct}%', 'zh-TW': '{countdown}後重設 · 剩餘時間 {pct}%', en: 'Resets in {countdown} · Time left {pct}%' },
  'quota.pace.otherPoolsMore': { 'zh-CN': '另有 {count} 个额度池 (点击查看)', 'zh-TW': '另有 {count} 個額度池 (點擊檢視)', en: '+{count} other model pools (click to view)' },
  'quota.pace.tooltip': { 'zh-CN': '剩余额度 {quotaPct}% · 剩余时间 {timePct}% ({countdown} / {window}) · 节奏差值 {deltaStr} ({tierLabel})', 'zh-TW': '剩餘額度 {quotaPct}% · 剩餘時間 {timePct}% ({countdown} / {window}) · 節奏差值 {deltaStr} ({tierLabel})', en: 'Quota left {quotaPct}% · Time left {timePct}% ({countdown} / {window}) · Pace delta {deltaStr} ({tierLabel})' },
  'quota.pace.estRunout': { 'zh-CN': '按当前速率约 {eta} 后耗尽', 'zh-TW': '依目前速率約 {eta} 後耗盡', en: 'At current rate, runs out in ~{eta}' },
  'quota.pace.expandHint': { 'zh-CN': '展开', 'zh-TW': '展開', en: 'Expand' },
  'quota.pace.collapseHint': { 'zh-CN': '收起', 'zh-TW': '收合', en: 'Collapse' },
  'keepalive.protocolSummary': { 'zh-CN': '协议核查（Antigravity {ver}，已检查 {rpcs} 个 RPC）：在已检查的 RPC 与响应中未发现明确的服务端缓存续期或 TTL 接口，响应亦未见 cacheWriteTokens / cacheTtl；因此不展示虚构到期倒计时，缓存保活保持待验证与默认关闭。', 'zh-TW': '協定核查（Antigravity {ver}，已檢查 {rpcs} 個 RPC）：在已檢查的 RPC 與回應中未發現明確的伺服器端快取續期或 TTL 介面，回應亦未見 cacheWriteTokens / cacheTtl；因此不顯示虛構到期倒數，快取保活維持待驗證與預設關閉。', en: 'Protocol check (Antigravity {ver}, {rpcs} RPCs): No explicit server-side cache TTL or renewal endpoint was found in checked RPCs/responses, and cacheWriteTokens/cacheTtl are omitted; keepalive stays unverified & off.' },
  'keepalive.experimentSummary': { 'zh-CN': '待确认最小对照实验（{model}，合计 {reqs} 次请求，相同约 20K 只读无工具前缀）：对照组 2 次（0m / 6m）对比实验组 3 次（0m / 4m 仅发 "ok" / 6m），预计总输出 60~150 tok；逐次采集 cacheReadTokens 并在异常/限流/切号/达上限时终止，等待维护者确认。', 'zh-TW': '待確認最小對照實驗（{model}，合計 {reqs} 次請求，相同約 20K 唯讀無工具前綴）：對照組 2 次（0m / 6m）對比實驗組 3 次（0m / 4m 僅發 "ok" / 6m），預計總輸出 60~150 tok；逐次採集 cacheReadTokens 並於異常/限流/切號/達上限時終止，等待維護者確認。', en: 'Pending A/B plan ({reqs} total reqs on {model}, identical ~20K fixed non-tool prefix): Control (2 reqs, 0/6m) vs Keepalive (3 reqs, 0/4m "ok"/6m); collects per-call cacheReadTokens, stops on error/429/switch/limit; awaiting maintainer sign-off.' },
  'keepalive.blockedReason': { 'zh-CN': '拦截保护：{reason}', 'zh-TW': '攔截保護：{reason}', en: 'Blocked: {reason}' },
  'keepalive.stopReason': { 'zh-CN': '最近状态：{reason}', 'zh-TW': '最近狀態：{reason}', en: 'Last state: {reason}' },
  'keepalive.defaultNote': { 'zh-CN': '保活默认关闭，且切换账号/退出/达上限时自动终止。', 'zh-TW': '保活預設關閉，且切換帳號/結束/達上限時自動終止。', en: 'Keepalive disabled by default; stops on account switch, exit, or limit.' },
  'models.summary.pendingConfirm': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
  'models.cap.metaUnknown': { 'zh-CN': '未知（待获取元数据）', 'zh-TW': '未知（待取得中繼資料）', en: 'Unknown (pending metadata)' },
  'models.cap.policyUnknown': { 'zh-CN': '未知（待读取运行策略）', 'zh-TW': '未知（待讀取執行策略）', en: 'Unknown (pending policy)' },
  'models.cap.policyPendingRestart': { 'zh-CN': '待重启（磁盘={disk}）', 'zh-TW': '待重啟（磁碟={disk}）', en: 'Restart needed (disk={disk})' },
  'models.cap.policyUnconfirmed': { 'zh-CN': '进程未确认（磁盘={disk}）', 'zh-TW': '程序未確認（磁碟={disk}）', en: 'Unconfirmed (disk={disk})' },
  'models.cap.policyPartial': { 'zh-CN': '部分异常（运行限制未知）', 'zh-TW': '部分異常（執行限制未知）', en: 'Partial error (limit unknown)' },
  'models.cap.policyDynamic': { 'zh-CN': 'Dynamic 动态跟随（按模型上限）', 'zh-TW': 'Dynamic 動態跟隨（依模型上限）', en: 'Dynamic (follows model limit)' },
  'models.cap.policyFixed': { 'zh-CN': '固定限制 {limit} tokens', 'zh-TW': '固定限制 {limit} tokens', en: 'Fixed {limit} tokens' },
  'models.cap.policyDefault': { 'zh-CN': '默认限制 256,000 tokens', 'zh-TW': '預設限制 256,000 tokens', en: 'Default limit 256,000 tokens' },
  'models.cap.stratDynamic': { 'zh-CN': '（Dynamic 默认）', 'zh-TW': '（Dynamic 預設）', en: ' (Dynamic default)' },
  'models.cap.stratFixed': { 'zh-CN': '（受固定限制 {limit} 约束）', 'zh-TW': '（受固定限制 {limit} 約束）', en: ' (capped by fixed {limit})' },
  'models.cap.stratDefault': { 'zh-CN': '（受默认 256,000 约束）', 'zh-TW': '（受預設 256,000 約束）', en: ' (capped by 256,000 default)' },
  'models.cap.defaultUnknownPolicy': { 'zh-CN': '未知（运行策略待确认）', 'zh-TW': '未知（執行策略待確認）', en: 'Unknown (policy unconfirmed)' },
  'models.cap.rangeUnknownPolicyMax': { 'zh-CN': '运行策略未知（模型理论上限 {max}）', 'zh-TW': '執行策略未知（模型理論上限 {max}）', en: 'Policy unknown (model max {max})' },
  'models.cap.rangeUnknownPolicyEng': { 'zh-CN': '运行策略未知（工程范围 {min} – {max}）', 'zh-TW': '執行策略未知（工程範圍 {min} – {max}）', en: 'Policy unknown (range {min} – {max})' },
  'models.cap.rangeUnknownModelMax': { 'zh-CN': '{min} – {max}（模型上限未知）', 'zh-TW': '{min} – {max}（模型上限未知）', en: '{min} – {max} (model max unknown)' },
  'models.cap.noneVerified': { 'zh-CN': '尚无本次验证', 'zh-TW': '尚無本次驗證', en: 'Not verified yet' },
  'models.cap.clientPartialAlert': { 'zh-CN': '部分异常（请核对客户端状态）', 'zh-TW': '部分異常（請核對用戶端狀態）', en: 'Partial anomaly (check client state)' },
  'models.cap.clientDynamicOk': { 'zh-CN': '动态跟随已确认运行（各模型独立）', 'zh-TW': '動態跟隨已確認執行（各模型獨立）', en: 'Dynamic mode active (per model)' },
  'models.preset.unifiedDisabled': { 'zh-CN': '统一模式下各模型不同（已禁用）', 'zh-TW': '統一模式下各模型不同（已停用）', en: 'Varies by model in unified mode (disabled)' },
  'models.preset.envMax': { 'zh-CN': '当前环境最大可采纳：{val} tokens', 'zh-TW': '目前環境最大可採納：{val} tokens', en: 'Max effective here: {val} tokens' },
  'models.preset.policyUnconfirmed': { 'zh-CN': '运行策略未确认（模型理论上限 {val}，暂不可用）', 'zh-TW': '執行策略未確認（模型理論上限 {val}，暫不可用）', en: 'Policy unconfirmed (model max {val}, unavailable)' },
  'models.preset.metaPending': { 'zh-CN': '模型元数据待获取（暂不可用）', 'zh-TW': '模型中繼資料待取得（暫不可用）', en: 'Pending model metadata (unavailable)' },
  'models.validation.defaultDesc': { 'zh-CN': '恢复客户端默认：请求将清除 maxTokenLimit 覆盖，由当前语言服务全局模式决定（若已开 Dynamic 则按动态默认）。', 'zh-TW': '還原用戶端預設：請求將清除 maxTokenLimit 覆寫，由目前語言服務全域模式決定（若已開 Dynamic 則依動態預設）。', en: 'Restore client default: clears maxTokenLimit override and defers to global language-server policy (Dynamic default if unlocked).' },
  'models.unified.projTitle': { 'zh-CN': '统一模式各模型预计采用预算（预测值，非实机已确认）：', 'zh-TW': '統一模式各模型預計採用預算（預測值，非實機已確認）：', en: 'Projected per-model budgets in Unified mode (estimated, unverified):' },
  'models.cap.tierStandard': { 'zh-CN': '标准', 'zh-TW': '標準', en: 'Standard' },
  'models.cap.tierWin': { 'zh-CN': '窗口 {val}', 'zh-TW': '視窗 {val}', en: 'Window {val}' },
  'models.cap.tierWinUnk': { 'zh-CN': '窗口未知', 'zh-TW': '視窗未知', en: 'Window unknown' },
  'models.cap.tierOut': { 'zh-CN': '最大输出 {val}', 'zh-TW': '最大輸出 {val}', en: 'Max output {val}' },
  'models.cap.tierOutUnk': { 'zh-CN': '输出未知', 'zh-TW': '輸出未知', en: 'Output unknown' },
  'models.cap.tierAdj': { 'zh-CN': '可调上限 {val}', 'zh-TW': '可調上限 {val}', en: 'Max limit {val}' },
  'models.cap.tierAdjUnk': { 'zh-CN': '上限未知', 'zh-TW': '上限未知', en: 'Cap unknown' },
  'models.cap.diskPending': { 'zh-CN': '磁盘为 {disk}（待重启生效）', 'zh-TW': '磁碟為 {disk}（待重啟生效）', en: 'Disk: {disk} (restart pending)' },
  'models.cap.diskUnconfirmed': { 'zh-CN': '磁盘为 {disk}（运行态未确认）', 'zh-TW': '磁碟為 {disk}（執行態未確認）', en: 'Disk: {disk} (runtime unconfirmed)' },
  'models.cap.fixedAdvice': { 'zh-CN': '固定单一上限模式 ({val}，建议升级为动态跟随)', 'zh-TW': '固定單一上限模式 ({val}，建議升級為動態跟隨)', en: 'Fixed single limit ({val}, Dynamic mode recommended)' },

  // 同屏多会话视角切换（Split Right / Split Down / Side Chat）
  'scope.bar.aria': { 'zh-CN': '同屏会话视角切换', 'zh-TW': '同畫面對話視角切換', en: 'On-screen session view switcher' },
  'scope.pills.aria': { 'zh-CN': '同屏会话列表', 'zh-TW': '同畫面對話清單', en: 'On-screen sessions' },
  'scope.pane.single': { 'zh-CN': '主对话', 'zh-TW': '主對話', en: 'Main' },
  'scope.pane.indexed': { 'zh-CN': '窗格 {n}', 'zh-TW': '窗格 {n}', en: 'Pane {n}' },
  'scope.actions': { 'zh-CN': '窗格操作', 'zh-TW': '窗格操作', en: 'Pane actions' },
  'scope.focusPane': { 'zh-CN': '定位并聚焦窗格', 'zh-TW': '定位並聚焦窗格', en: 'Find and focus pane' },
  'scope.closePane': { 'zh-CN': '关闭此窗格', 'zh-TW': '關閉此窗格', en: 'Close this pane' },
  'scope.closeOthers': { 'zh-CN': '关闭其他窗格', 'zh-TW': '關閉其他窗格', en: 'Close other panes' },
  'scope.closeRight': { 'zh-CN': '关闭右侧窗格', 'zh-TW': '關閉右側窗格', en: 'Close panes to the right' },
  'scope.batch': { 'zh-CN': '批量关闭', 'zh-TW': '批次關閉', en: 'Select panes to close' },
  'scope.selectOthers': { 'zh-CN': '全选其他', 'zh-TW': '全選其他', en: 'Select all others' },
  'scope.closeSelected': { 'zh-CN': '关闭已选 {n} 个', 'zh-TW': '關閉已選 {n} 個', en: 'Close {n} selected' },
  'scope.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'scope.closeSkipped': { 'zh-CN': '已跳过无法关闭的窗格 · 至少保留一个', 'zh-TW': '已略過無法關閉的窗格 · 至少保留一個', en: 'Skipped unavailable panes · One pane must remain' },
  'scope.side.subagent': { 'zh-CN': 'Side Chat', 'zh-TW': 'Side Chat', en: 'Side Chat' },
  'scope.side.question': { 'zh-CN': '支线问答', 'zh-TW': '支線問答', en: 'Side Q&A' },
  'scope.side.browser': { 'zh-CN': '浏览器子代理', 'zh-TW': '瀏覽器子代理', en: 'Browser Subagent' },
  'scope.badge.sideShort': { 'zh-CN': '支线', 'zh-TW': '支線', en: 'Side' },
  'scope.badge.plusSide': { 'zh-CN': '+支线', 'zh-TW': '+支線', en: '+Side' },
  'scope.follow.auto': { 'zh-CN': '跟随焦点', 'zh-TW': '跟隨焦點', en: 'Following' },
  'scope.follow.locked': { 'zh-CN': '恢复跟随', 'zh-TW': '恢復跟隨', en: 'Follow Focus' },
  'scope.follow.title': { 'zh-CN': '仅切换面板查看视角，不切换客户端当前对话', 'zh-TW': '僅切換面板檢視視角，不切換用戶端目前對話', en: 'Switches monitor view only; does not change active client conversation' },
  'scope.follow.lockedTitle': { 'zh-CN': '当前已锁定查看视角，点击恢复自动跟随聚焦窗格', 'zh-TW': '目前已鎖定檢視視角，點擊恢復自動跟隨聚焦窗格', en: 'View pinned; click to resume following the focused pane' },
  'scope.pill.titleFocused': { 'zh-CN': '{label}（当前聚焦，ID: {id}）— 仅切换查看视角', 'zh-TW': '{label}（目前聚焦，ID: {id}）— 僅切換檢視視角', en: '{label} (Focused, ID: {id}) — view only' },
  'scope.pill.titleOther': { 'zh-CN': '{label}（ID: {id}）— 点击仅在面板中查看，不切换客户端对话', 'zh-TW': '{label}（ID: {id}）— 點擊僅於面板檢視，不切換用戶端對話', en: '{label} (ID: {id}) — click to inspect in panel without switching client focus' },
  'scope.pill.titleBlankFallback': { 'zh-CN': '当前聚焦空白新窗格，面板暂展示 {label}', 'zh-TW': '目前聚焦空白新窗格，面板暫時顯示 {label}', en: 'Blank new pane focused; showing {label}' },

  // 4 行 Bento 当前会话工作台与双轨分析面板
  'session.ov.noTitle': { 'zh-CN': '未命名会话', 'zh-TW': '未命名對話', en: 'Untitled Session' },
  'session.ov.turnsSteps': { 'zh-CN': '{turns} 轮 · {steps} 步', 'zh-TW': '{turns} 輪 · {steps} 步', en: '{turns} turns · {steps} steps' },
  'session.ov.turnsOnly': { 'zh-CN': '{turns} 轮', 'zh-TW': '{turns} 輪', en: '{turns} turns' },
  'session.ov.refresh': { 'zh-CN': '刷新', 'zh-TW': '重新整理', en: 'Refresh' },
  'session.ov.refreshing': { 'zh-CN': '刷新中…', 'zh-TW': '更新中…', en: 'Refreshing…' },
  'session.ov.returnLatest': { 'zh-CN': '返回最新', 'zh-TW': '返回最新', en: 'Latest' },
  'session.ov.pinnedTag': { 'zh-CN': '已固定历史步骤 · {label}', 'zh-TW': '已鎖定歷史步驟 · {label}', en: 'Pinned step · {label}' },
  'session.ov.lblCache': { 'zh-CN': '缓存命中 / 累计', 'zh-TW': '快取命中 / 累計', en: 'Step / Cum Cache' },
  'session.ov.cacheHitLabel': { 'zh-CN': '缓存命中', 'zh-TW': '快取命中', en: 'Cache hit' },
  'session.ov.costLabel': { 'zh-CN': '费用', 'zh-TW': '費用', en: 'Cost' },
  'session.ov.lblTotalUsed': { 'zh-CN': '会话累计 Token', 'zh-TW': '會話累計 Token', en: 'Session Cumulative' },
  'session.ov.scopeCurVsCum': { 'zh-CN': '当前占用为单次上下文，累计包含多轮请求输入与输出；配置预算独立于宿主窗口上限。', 'zh-TW': '目前佔用為單次上下文，累計包含多輪請求輸入與輸出；設定預算獨立於宿主視窗上限。', en: 'Current context is single-request footprint; cumulative sums all turn input/cache/output. Config pref is separate from host window.' },
  'session.ov.limitHost': { 'zh-CN': '{val} · 宿主窗口', 'zh-TW': '{val} · 宿主視窗', en: '{val} · Host' },
  'session.ov.limitPref': { 'zh-CN': '{val} · 配置预算', 'zh-TW': '{val} · 設定預算', en: '{val} · Config' },
  'session.ov.hostWindowCap': { 'zh-CN': '宿主上限 {val}', 'zh-TW': '宿主上限 {val}', en: 'Host Max {val}' },
  'session.ov.configBudget': { 'zh-CN': '预算上限 {val}', 'zh-TW': '預算上限 {val}', en: 'Budget {val}' },
  'session.ov.healthOk': { 'zh-CN': '安全余量充足 {pct}%', 'zh-TW': '安全餘量充足 {pct}%', en: 'Comfortable headroom {pct}%' },
  'session.ov.healthWarn': { 'zh-CN': '余量偏紧 {pct}%', 'zh-TW': '餘量偏緊 {pct}%', en: 'Getting tight {pct}%' },
  'session.ov.healthDanger': { 'zh-CN': '临近上限 {pct}%', 'zh-TW': '臨近上限 {pct}%', en: 'Near limit {pct}%' },
  'session.ov.tier.safe': { 'zh-CN': '安全余量充足 {pct}%', 'zh-TW': '安全餘量充足 {pct}%', en: 'Comfortable headroom {pct}%' },
  'session.ov.tier.moderate': { 'zh-CN': '占用平稳 {pct}%', 'zh-TW': '佔用平穩 {pct}%', en: 'Moderate usage {pct}%' },
  'session.ov.tier.warn': { 'zh-CN': '余量偏紧 {pct}%', 'zh-TW': '餘量偏緊 {pct}%', en: 'Getting tight {pct}%' },
  'session.ov.tier.danger': { 'zh-CN': '临近上限 {pct}%', 'zh-TW': '臨近上限 {pct}%', en: 'Near limit {pct}%' },
  'session.ov.tier.full': { 'zh-CN': '已触及上限', 'zh-TW': '已觸及上限', en: 'Limit reached' },

  'session.dual.title': { 'zh-CN': '上下文组成与双轨结构', 'zh-TW': '上下文組成與雙軌結構', en: 'Context Dual-Track & Composition' },
  'session.dual.subModeComp': { 'zh-CN': '已用构成 100%', 'zh-TW': '已用構成 100%', en: 'Used Mix 100%' },
  'session.dual.subModeCache': { 'zh-CN': '缓存结构', 'zh-TW': '快取結構', en: 'Cache Mix' },
  'session.dual.basisHostPlusEst': { 'zh-CN': '实报 {actual} · 可见估算 {est}', 'zh-TW': '實報 {actual} · 可見估算 {est}', en: 'Reported {actual} · Est {est}' },
  'session.dual.basisEstOnly': { 'zh-CN': '可见内容启发式估算', 'zh-TW': '可見內容啟發式估算', en: 'Visible Content Est.' },
  'session.dual.basisHostOnly': { 'zh-CN': '仅宿主实报总量', 'zh-TW': '僅宿主實報總量', en: 'Host Reported Only' },
  'session.dual.unaccounted': { 'zh-CN': '未归类 / 协议开销', 'zh-TW': '未歸類 / 協定開銷', en: 'Unaccounted / Overhead' },
  'session.dual.unaccountedTip': { 'zh-CN': '宿主实报输入总量高于本地可见文本估算的差额，不强制按比例平摊进具体类别', 'zh-TW': '宿主實報輸入總量高於本地可見文字估算的差額，不強制按比例平攤', en: 'Host-reported tokens minus visible text estimates; kept explicit without distortion' },
  'session.dual.zerosBtn': { 'zh-CN': '+{n} 项为 0', 'zh-TW': '+{n} 項為 0', en: '+{n} zero items' },
  'session.dual.zerosHide': { 'zh-CN': '收起 0 项', 'zh-TW': '收起 0 項', en: 'Hide zeros' },
  'session.dual.subTitleComp': { 'zh-CN': '副轨：已用内部构成放大至 100%', 'zh-TW': '副軌：已用內部構成放大至 100%', en: 'Sub-track: Used Composition 100%' },
  'session.dual.subTitleCache': { 'zh-CN': '副轨：本次请求缓存结构 · 新增 / 写 / 读', 'zh-TW': '副軌：本次請求快取結構 · 新增 / 寫 / 讀', en: 'Sub-track: Cache Mix · Fresh / Write / Read' },
  'session.dual.cacheFresh': { 'zh-CN': '新增输入', 'zh-TW': '新增輸入', en: 'Fresh Input' },
  'session.dual.cacheWrite': { 'zh-CN': '写入缓存', 'zh-TW': '寫入快取', en: 'Cache Write' },
  'session.dual.cacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },

  'session.comp.cat.system': { 'zh-CN': '系统提示', 'zh-TW': '系統提示', en: 'System' },
  'session.comp.cat.definitions': { 'zh-CN': '工具定义', 'zh-TW': '工具定義', en: 'Tools Schema' },
  'session.comp.cat.injections': { 'zh-CN': '系统注入', 'zh-TW': '系統注入', en: 'Injections' },
  'session.comp.cat.skills': { 'zh-CN': '技能加载', 'zh-TW': '技能載入', en: 'Skills' },
  'session.comp.cat.summaries': { 'zh-CN': '压缩摘要', 'zh-TW': '壓縮摘要', en: 'Summaries' },
  'session.comp.cat.user': { 'zh-CN': '用户消息', 'zh-TW': '使用者訊息', en: 'User' },
  'session.comp.cat.assistant': { 'zh-CN': '助手正文', 'zh-TW': '助手正文', en: 'Assistant' },
  'session.comp.cat.thinking': { 'zh-CN': '可见思考', 'zh-TW': '可見思考', en: 'Thinking' },
  'session.comp.cat.tools': { 'zh-CN': '工具调用与结果', 'zh-TW': '工具呼叫與結果', en: 'Tool Calls/Results' },

  'session.timing.title': { 'zh-CN': '会话耗时与并发拆解', 'zh-TW': '會話耗時與並行拆解', en: 'Timing & Concurrency Breakdown' },
  'session.timing.wallVsCum': { 'zh-CN': '活跃耗时 {wall} · 任务累计耗时 {cum}', 'zh-TW': '活躍耗時 {wall} · 任務累計耗時 {cum}', en: 'Active time {wall} · Total task time {cum}' },
  'session.timing.wallOnly': { 'zh-CN': '活跃耗时 {wall}', 'zh-TW': '活躍耗時 {wall}', en: 'Active time {wall}' },
  'session.timing.savedConcurrent': { 'zh-CN': '并发重叠节省 {saved}', 'zh-TW': '並行重疊節省 {saved}', en: 'Concurrency saved {saved}' },
  'session.timing.shortSample': { 'zh-CN': '短样本少于 3 次调用', 'zh-TW': '短樣本少於 3 次呼叫', en: 'Short sample under 3 calls' },
  'session.timing.missingTsNote': { 'zh-CN': '说明：Antigravity 当前未导出思考/正文/工具参数三段独立时间戳，因此不拆分该三项.', 'zh-TW': '說明：Antigravity 目前未匯出思考/正文/工具參數三段獨立時間戳，不強行拆分.', en: 'Note: Thinking/text/tool-arg sub-timestamps are unavailable from host; not fabricated.' },

  'session.stepCard.titlePinned': { 'zh-CN': '固定步骤详情', 'zh-TW': '鎖定步驟詳情', en: 'Pinned Step Detail' },
  'session.stepCard.titleLatest': { 'zh-CN': '当前步骤详情', 'zh-TW': '目前步驟詳情', en: 'Current Step Detail' },
  'session.stepCard.compareStep': { 'zh-CN': '比前一步', 'zh-TW': '比前一步', en: 'vs Prev Step' },
  'session.stepCard.compareTurn': { 'zh-CN': '比前一轮', 'zh-TW': '比前一輪', en: 'vs Prev Turn' },
  'session.stepCard.kbHint': { 'zh-CN': '支持 ←/→ 键盘切步 · Esc 返回最新', 'zh-TW': '支援 ←/→ 鍵盤切步 · Esc 返回最新', en: 'Use ←/→ keys to step · Esc to latest' },

  'session.tree.title': { 'zh-CN': '上下文组成明细树', 'zh-TW': '上下文組成明細樹', en: 'Composition Tree' },
  'session.tree.modeFull': { 'zh-CN': '全量', 'zh-TW': '全量', en: 'Total' },
  'session.tree.modeDelta': { 'zh-CN': 'Δ 变化', 'zh-TW': 'Δ 變化', en: 'Delta Δ' },
  'session.tree.scopeStepBounded': { 'zh-CN': '按 S{step} 前缀还原 + 当前系统/定义', 'zh-TW': '依 S{step} 前綴還原 + 目前系統/定義', en: 'Bounded up to S{step} + system/tools' },
  'session.tree.scopeSessionApprox': { 'zh-CN': '历史无分步组成快照 · 按全会话估算范围展示', 'zh-TW': '歷史無分步組成快照 · 依全工作階段估算展示', en: 'No per-step composition snapshot; showing session estimate' },
  'session.tree.scopeSessionFull': { 'zh-CN': '覆盖范围：可见文本估算', 'zh-TW': '涵蓋範圍：可見文字估算', en: 'Scope: visible text heuristic' },
  'session.tree.itemsCount': { 'zh-CN': '{n} 条', 'zh-TW': '{n} 條', en: '{n} items' },
  'session.tree.noEntries': { 'zh-CN': '该分类当前无逐条脱敏摘要或宿主未返回文本片段.', 'zh-TW': '該分類目前無逐條去識別摘要或宿主未回傳片段.', en: 'No per-item preview captured for this category.' },
  'session.tree.selectedHeader': { 'zh-CN': '选中明细：{name}', 'zh-TW': '選取明細：{name}', en: 'Selected: {name}' },
  'session.tree.previewCount': { 'zh-CN': '共 {n} tok · {count} 项', 'zh-TW': '共 {n} tok · {count} 項', en: '{n} tok · {count} items' },
  'session.tree.previewPlaceholder': { 'zh-CN': '点击左侧分类查看真实采集的脱敏构成片段.', 'zh-TW': '點擊左側分類檢視真實採集的去識別構成片段.', en: 'Select a category on the left to inspect sanitized entries.' },
  'session.audit.tabTree': { 'zh-CN': '组成明细树', 'zh-TW': '組成明細樹', en: 'Composition' },
  'session.timeline.event.unknown_drop': { 'zh-CN': '占用下降，原因未知', 'zh-TW': '佔用下降，原因未知', en: 'Context Drop (Reason Unknown)' },
  'session.audit.title': { 'zh-CN': '工作台审计与协作明细', 'zh-TW': '工作台稽核與協作明細', en: 'Session Audit Workbench' },
  'session.audit.jumpStep': { 'zh-CN': '定位 {label}', 'zh-TW': '定位 {label}', en: 'Jump {label}' },
  'session.audit.collapsedHint': { 'zh-CN': '暂无 {item} 记录，已自动收起', 'zh-TW': '暫無 {item} 紀錄，已自動收合', en: 'No {item} recorded · collapsed' },
  'session.audit.topPrograms': { 'zh-CN': '高频命令：{list}', 'zh-TW': '高頻命令：{list}', en: 'Top commands: {list}' },
  'session.audit.eventsShort': { 'zh-CN': '上下文事件', 'zh-TW': '上下文事件', en: 'Events' },
  'session.audit.filesShort': { 'zh-CN': '文件活动', 'zh-TW': '檔案活動', en: 'Files' },
  'session.audit.cmdsShort': { 'zh-CN': '命令执行', 'zh-TW': '命令執行', en: 'Commands' },
  'session.audit.fleetShort': { 'zh-CN': '子 Agent', 'zh-TW': '子 Agent', en: 'Subagents' },
  'session.audit.subUnknownRel': { 'zh-CN': '关系未知 / 待确认', 'zh-TW': '關係未知 / 待確認', en: 'Relation Unknown' },

  // 模块 2 & 模块 3：12 列驾驶舱预设、11 Widget、脉冲趋势、解剖台、执行轨迹、协作中枢、审计与跨会话洞察
  'session.preset.label': { 'zh-CN': '布局预设', 'zh-TW': '佈局預設', en: 'Layout preset' },
  'session.preset.cockpit': { 'zh-CN': '会话总览', 'zh-TW': '會話總覽', en: 'Session overview' },
  'session.preset.minimal': { 'zh-CN': '极简遥测', 'zh-TW': '極簡遙測', en: 'Minimal Telemetry' },
  'session.preset.debug': { 'zh-CN': '深度排障', 'zh-TW': '深度排障', en: 'Deep Debug' },
  'session.preset.speedCost': { 'zh-CN': '速度与成本', 'zh-TW': '速度與成本', en: 'Speed & Cost' },
  'session.preset.collab': { 'zh-CN': '多代理协作', 'zh-TW': '多代理協作', en: 'Multi-Agent Collab' },
  'session.preset.mgrBtn': { 'zh-CN': '模块管理', 'zh-TW': '模組管理', en: 'Widgets' },
  'session.preset.mgrTitle': { 'zh-CN': '显示或调整模块顺序', 'zh-TW': '顯示或調整模組順序', en: 'Show or reorder modules' },
  'session.preset.reset': { 'zh-CN': '重置当前预设', 'zh-TW': '重設目前預設', en: 'Reset preset' },

  'session.widget.overviewKpi': { 'zh-CN': '会话总览与关键指标', 'zh-TW': '會話總覽與關鍵指標', en: 'Session Overview & KPIs' },
  'session.widget.tokenBreakdown': { 'zh-CN': 'Token 构成与费用', 'zh-TW': 'Token 構成與費用', en: 'Token Mix & Cost' },
  'session.widget.timingSpeed': { 'zh-CN': '耗时与流式效率', 'zh-TW': '耗時與串流效率', en: 'Timing & Speed' },
  'session.widget.trendPulse': { 'zh-CN': '全景脉冲趋势', 'zh-TW': '全景脈衝趨勢', en: 'Trend Pulse' },
  'session.widget.contextInspector': { 'zh-CN': '上下文解剖台', 'zh-TW': '上下文解剖台', en: 'Context Inspector' },
  'session.widget.executionTrace': { 'zh-CN': '会话执行轨迹', 'zh-TW': '會話執行軌跡', en: 'Execution Trace' },
  'session.widget.contextEvents': { 'zh-CN': '上下文异动日志', 'zh-TW': '上下文異動日誌', en: 'Context Events' },
  'session.widget.fileRadar': { 'zh-CN': '文件变更雷达', 'zh-TW': '檔案變更雷達', en: 'File Radar' },
  'session.widget.commandAudit': { 'zh-CN': '终端命令审计', 'zh-TW': '終端命令稽核', en: 'Command Audit' },
  'session.widget.agentCollab': { 'zh-CN': '多代理协作中枢', 'zh-TW': '多代理協作中樞', en: 'Agent Collab Hub' },
  'session.widget.techDrawer': { 'zh-CN': '底层技术参数与附件审计', 'zh-TW': '底層技術參數與附件稽核', en: 'Technical & Attachments' },
  'session.widget.spanLabel': { 'zh-CN': '{n}列', 'zh-TW': '{n}欄', en: '{n}col' },
  'session.widget.spanTitle': { 'zh-CN': '切换卡片跨列宽度', 'zh-TW': '切換卡片跨欄寬度', en: 'Cycle widget column span' },
  'session.widget.heightTitle': { 'zh-CN': '切换卡片高度预设', 'zh-TW': '切換卡片高度預設', en: 'Cycle widget height preset' },
  'session.widget.dragAria': { 'zh-CN': '拖拽调整模块位置', 'zh-TW': '拖曳調整模組位置', en: 'Drag to reorder widget' },
  'session.widget.dragTitle': { 'zh-CN': '拖拽或方向键调整顺序', 'zh-TW': '拖曳或方向鍵調整順序', en: 'Drag or press arrow keys to reorder' },
  'session.widget.height.compact': { 'zh-CN': '紧凑', 'zh-TW': '緊湊', en: 'Compact' },
  'session.widget.height.standard': { 'zh-CN': '标准', 'zh-TW': '標準', en: 'Standard' },
  'session.widget.height.expanded': { 'zh-CN': '展开', 'zh-TW': '展開', en: 'Expanded' },
  'session.widget.moveUp': { 'zh-CN': '上移模块', 'zh-TW': '上移模組', en: 'Move up' },
  'session.widget.moveDown': { 'zh-CN': '下移模块', 'zh-TW': '下移模組', en: 'Move down' },
  'session.widget.holdToSort': { 'zh-CN': '长按拖动排序', 'zh-TW': '長按拖曳排序', en: 'Hold and drag to reorder' },
  'session.widget.dropHere': { 'zh-CN': '释放以放置到此网格位置', 'zh-TW': '釋放以放置到此網格位置', en: 'Drop to place here' },

  'session.timing.diagToggleOpen': { 'zh-CN': '详细诊断评分 ▼', 'zh-TW': '詳細診斷評分 ▼', en: 'Diagnostics ▼' },
  'session.timing.diagToggleClose': { 'zh-CN': '收起诊断评分 ▲', 'zh-TW': '收起診斷評分 ▲', en: 'Hide diagnostics ▲' },
  'session.breakdown.uncached': { 'zh-CN': '新增输入', 'zh-TW': '新增輸入', en: 'Fresh Input' },
  'session.breakdown.cacheWrite': { 'zh-CN': '写入缓存', 'zh-TW': '寫入快取', en: 'Cache Write' },
  'session.breakdown.cacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'session.breakdown.output': { 'zh-CN': '模型输出', 'zh-TW': '模型輸出', en: 'Output' },
  'session.breakdown.cacheHitLabel': { 'zh-CN': '当步 / 累计缓存命中', 'zh-TW': '當步 / 累計快取命中', en: 'Step / Session Cache Hit' },
  'session.breakdown.costLabel': { 'zh-CN': '当步 / 会话参考花费', 'zh-TW': '當步 / 工作階段參考花費', en: 'Step / Session Est. Cost' },

  'session.trend.compressAll': { 'zh-CN': '全景压缩带', 'zh-TW': '全景壓縮帶', en: 'Full Ribbon' },
  'session.trend.latencyOverlay': { 'zh-CN': '叠加耗时', 'zh-TW': '疊加耗時', en: 'Latency Line' },
  'session.trend.quickIntent': { 'zh-CN': '触发意图', 'zh-TW': '觸發意圖', en: 'Trigger Intent' },
  'session.trend.quickLoaded': { 'zh-CN': '新增载入', 'zh-TW': '新增載入', en: 'Loaded Context' },
  'session.trend.quickAction': { 'zh-CN': '模型动作', 'zh-TW': '模型動作', en: 'Model Action' },
  'session.trend.quickEmpty': { 'zh-CN': '悬停或点选上方趋势条查看步骤三行速览', 'zh-TW': '懸停或點選上方趨勢條檢視步驟三行速覽', en: 'Hover or click a bar to preview the 3-line step summary' },

  'session.inspector.viewTree': { 'zh-CN': '分类树', 'zh-TW': '分類樹', en: 'Category Tree' },
  'session.inspector.viewSlices': { 'zh-CN': '顺序切片视图', 'zh-TW': '順序切片檢視', en: 'Sequential Slices' },
  'session.inspector.searchPh': { 'zh-CN': '搜索分类、原文片段或工具…', 'zh-TW': '搜尋分類、原文片段或工具…', en: 'Search category, snippet or tool…' },
  'session.inspector.sortSize': { 'zh-CN': '按大小', 'zh-TW': '依大小', en: 'By size' },
  'session.inspector.sortOrder': { 'zh-CN': '按顺序', 'zh-TW': '依順序', en: 'By order' },
  'session.inspector.sortName': { 'zh-CN': '按名称', 'zh-TW': '依名稱', en: 'By name' },
  'session.inspector.asstAll': { 'zh-CN': '全部助手', 'zh-TW': '全部助手', en: 'All' },
  'session.inspector.asstThinking': { 'zh-CN': '思考', 'zh-TW': '思考', en: 'Thinking' },
  'session.inspector.asstTools': { 'zh-CN': '工具', 'zh-TW': '工具', en: 'Tools' },
  'session.inspector.asstText': { 'zh-CN': '正文', 'zh-TW': '正文', en: 'Text' },
  'session.inspector.viewRaw': { 'zh-CN': '原文', 'zh-TW': '原文', en: 'Raw' },
  'session.inspector.viewRender': { 'zh-CN': '渲染', 'zh-TW': '渲染', en: 'Rendered' },
  'session.inspector.copyBtn': { 'zh-CN': '复制', 'zh-TW': '複製', en: 'Copy' },
  'session.inspector.copiedBtn': { 'zh-CN': '已复制', 'zh-TW': '已複製', en: 'Copied' },
  'session.inspector.sourceBuiltin': { 'zh-CN': '内建', 'zh-TW': '內建', en: 'Built-in' },
  'session.inspector.sourceMcp': { 'zh-CN': 'MCP', 'zh-TW': 'MCP', en: 'MCP' },
  'session.inspector.sourceSkill': { 'zh-CN': '技能', 'zh-TW': '技能', en: 'Skill' },
  'session.inspector.attachmentsTitle': { 'zh-CN': '会话附件与媒体资产', 'zh-TW': '工作階段附件與媒體資產', en: 'Attachments & Media Assets' },

  'session.trace.modeDuration': { 'zh-CN': '时长', 'zh-TW': '時長', en: 'Duration' },
  'session.trace.modeTurn': { 'zh-CN': '轮次', 'zh-TW': '輪次', en: 'Turns' },
  'session.trace.modeCall': { 'zh-CN': '调用', 'zh-TW': '呼叫', en: 'Calls' },
  'session.trace.searchPh': { 'zh-CN': '筛选轨迹摘要、工具名或路径…', 'zh-TW': '篩選軌跡摘要、工具名或路徑…', en: 'Filter trace summary, tool or path…' },
  'session.trace.catAll': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'session.trace.catSystem': { 'zh-CN': '系统', 'zh-TW': '系統', en: 'System' },
  'session.trace.catUser': { 'zh-CN': '用户', 'zh-TW': '使用者', en: 'User' },
  'session.trace.catInject': { 'zh-CN': '注入', 'zh-TW': '注入', en: 'Injection' },
  'session.trace.catThinking': { 'zh-CN': '思考', 'zh-TW': '思考', en: 'Thinking' },
  'session.trace.catTool': { 'zh-CN': '工具', 'zh-TW': '工具', en: 'Tool' },
  'session.trace.catAssistant': { 'zh-CN': '助手', 'zh-TW': '助手', en: 'Assistant' },
  'session.trace.ganttTitle': { 'zh-CN': '多轨横向时间轴', 'zh-TW': '多軌橫向時間軸', en: 'Multi-Track Gantt Timeline' },
  'session.trace.empty': { 'zh-CN': '当前会话暂无可展示的执行轨迹节点', 'zh-TW': '目前工作階段暫無可顯示的執行軌跡節點', en: 'No execution trace nodes captured yet' },
  'session.trace.jumpInspector': { 'zh-CN': '跳转解剖台', 'zh-TW': '跳轉解剖台', en: 'Open in Inspector' },

  'session.collab.agentsTotal': { 'zh-CN': '代理总数', 'zh-TW': '代理總數', en: 'Agents' },
  'session.collab.agentsActive': { 'zh-CN': '运行中', 'zh-TW': '執行中', en: 'Active' },
  'session.collab.tasksTotal': { 'zh-CN': '委派任务', 'zh-TW': '委派任務', en: 'Delegated Tasks' },
  'session.collab.receiptsTotal': { 'zh-CN': '交互回执', 'zh-TW': '互動回執', en: 'Interactions' },
  'session.collab.emptyTitle': { 'zh-CN': '当前会话由主代理独立完成', 'zh-TW': '目前工作階段由主代理獨立完成', en: 'Single Main-Agent Session' },
  'session.collab.emptyDesc': { 'zh-CN': '尚未触发子代理委派或跨代理协作；触发多代理任务后将实时展示拓扑与回执流', 'zh-TW': '尚未觸發子代理委派或跨代理協作；觸發多代理任務後將即時顯示拓撲與回執流', en: 'No subagent delegation recorded; topology and interaction receipts appear here automatically' },
  'session.collab.swimlaneTitle': { 'zh-CN': '跨代理时间泳道', 'zh-TW': '跨代理時間泳道', en: 'Cross-Agent Swimlane' },
  'session.collab.tasksTitle': { 'zh-CN': '委派任务清单', 'zh-TW': '委派任務清單', en: 'Delegated Tasks' },
  'session.collab.receiptsTitle': { 'zh-CN': '交互回执检查器', 'zh-TW': '互動回執檢查器', en: 'Interaction Receipt Inspector' },
  'session.collab.receiptDetailEmpty': { 'zh-CN': '点击左侧交互回执查看完整委派与返回内容', 'zh-TW': '點擊左側互動回執檢視完整委派與回傳內容', en: 'Select a receipt on the left to inspect full details' },
  'session.collab.taskInProgress': { 'zh-CN': '进行中', 'zh-TW': '進行中', en: 'In progress' },
  'session.collab.taskPending': { 'zh-CN': '待处理', 'zh-TW': '待處理', en: 'Pending' },
  'session.collab.taskCompleted': { 'zh-CN': '已完成', 'zh-TW': '已完成', en: 'Completed' },

  'session.kpi.inputs': { 'zh-CN': '用户输入', 'zh-TW': '使用者輸入', en: 'User Inputs' },
  'session.kpi.files': { 'zh-CN': '文件操作', 'zh-TW': '檔案操作', en: 'Files' },
  'session.kpi.tools': { 'zh-CN': '工具调用', 'zh-TW': '工具呼叫', en: 'Tool Calls' },
  'session.kpi.commands': { 'zh-CN': '终端命令', 'zh-TW': '終端命令', en: 'Commands' },
  'session.kpi.events': { 'zh-CN': '异动事件', 'zh-TW': '異動事件', en: 'Events' },
  'session.kpi.subagents': { 'zh-CN': '子代理', 'zh-TW': '子代理', en: 'Subagents' },

  'session.radar.filterAll': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'session.radar.filterRead': { 'zh-CN': '读', 'zh-TW': '讀', en: 'Read' },
  'session.radar.filterWrite': { 'zh-CN': '写', 'zh-TW': '寫', en: 'Write' },
  'session.radar.filterSearch': { 'zh-CN': '搜', 'zh-TW': '搜', en: 'Search' },
  'session.radar.filterImage': { 'zh-CN': '图', 'zh-TW': '圖', en: 'Image' },
  'session.radar.searchPh': { 'zh-CN': '按文件路径或名称检索…', 'zh-TW': '依檔案路徑或名稱檢索…', en: 'Search file path or name…' },
  'session.radar.empty': { 'zh-CN': '当前会话暂无文件读写或检索记录', 'zh-TW': '目前工作階段暫無檔案讀寫或檢索紀錄', en: 'No file activity recorded yet' },

  'session.cmdAudit.totalLabel': { 'zh-CN': '执行总计', 'zh-TW': '執行總計', en: 'Total Runs' },
  'session.cmdAudit.failedLabel': { 'zh-CN': '非零退出', 'zh-TW': '非零退出', en: 'Non-zero Exit' },
  'session.cmdAudit.slowLabel': { 'zh-CN': '慢命令', 'zh-TW': '慢命令', en: 'Slow' },
  'session.cmdAudit.bgLabel': { 'zh-CN': '后台命令', 'zh-TW': '背景命令', en: 'Background' },
  'session.cmdAudit.programsTitle': { 'zh-CN': '程序频次分布 · 点击过滤', 'zh-TW': '程式頻次分佈 · 點擊過濾', en: 'Top Programs · Click to Filter' },
  'session.cmdAudit.clearFilter': { 'zh-CN': '清除筛选', 'zh-TW': '清除篩選', en: 'Clear' },
  'session.cmdAudit.searchPh': { 'zh-CN': '筛选命令、参数或程序名…', 'zh-TW': '篩選命令、參數或程式名…', en: 'Filter command, args or program…' },
  'session.cmdAudit.empty': { 'zh-CN': '当前会话暂无终端或脚本执行记录', 'zh-TW': '目前工作階段暫無終端或腳本執行紀錄', en: 'No terminal commands recorded yet' },

  'tokens.insights.title': { 'zh-CN': '跨会话全局洞察大盘', 'zh-TW': '跨會話全域洞察儀表板', en: 'Cross-Session Insights' },
  'tokens.insights.filteredDate': { 'zh-CN': '已筛选日期 {date}', 'zh-TW': '已篩選日期 {date}', en: 'Filtered Date {date}' },
  'tokens.insights.clearDate': { 'zh-CN': '显示全部日期', 'zh-TW': '顯示全部日期', en: 'Clear Date Filter' },
  'tokens.insights.chart7dTitle': { 'zh-CN': '近 7 天成对 Token 与估算费用', 'zh-TW': '近 7 天成對 Token 與估算費用', en: '7-Day Tokens & Est. Cost' },
  'tokens.insights.topTools': { 'zh-CN': '高频工具榜', 'zh-TW': '高頻工具榜', en: 'Top Tools' },
  'tokens.insights.topCommands': { 'zh-CN': '高频命令榜', 'zh-TW': '高頻命令榜', en: 'Top Commands' },
  'tokens.insights.topSkills': { 'zh-CN': '技能加载榜', 'zh-TW': '技能載入榜', en: 'Top Skills' },
  'tokens.insights.archivesTitle': { 'zh-CN': '会话档案卡片流', 'zh-TW': '會話檔案卡片流', en: 'Session Archives' },
  'tokens.insights.searchPh': { 'zh-CN': '搜索会话标题或工作区…', 'zh-TW': '搜尋會話標題或工作區…', en: 'Search session title or workspace…' },
  'tokens.insights.allWorkspaces': { 'zh-CN': '全部工作区', 'zh-TW': '全部工作區', en: 'All Workspaces' },
  'tokens.insights.sortRecent': { 'zh-CN': '按最近活跃', 'zh-TW': '依最近活躍', en: 'Most Recent' },
  'tokens.insights.sortTokens': { 'zh-CN': '按 Token 最多', 'zh-TW': '依 Token 最多', en: 'Most Tokens' },
  'tokens.insights.sortCost': { 'zh-CN': '按估算花费', 'zh-TW': '依估算花費', en: 'Highest Est. Cost' },
  'tokens.insights.empty': { 'zh-CN': '当前筛选条件下暂无归档洞察记录', 'zh-TW': '目前篩選條件下暫無歸檔洞察紀錄', en: 'No matching session archives found' }
};

function t(key, vars = null) {
  const entry = PANEL_I18N[key];
  let text = entry
    ? (entry[currentPanelLanguage] ?? entry['zh-CN'] ?? key)
    : key;
  if (vars && typeof vars === 'object') {
    text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
  }
  return text;
}

function applyStaticPanelTranslations(rootNode = shadow) {
  if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
  for (const node of rootNode.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-html]')) {
    const key = node.getAttribute('data-i18n-html');
    if (key) node.innerHTML = t(key);
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-aria]')) {
    const key = node.getAttribute('data-i18n-aria');
    if (key) node.setAttribute('aria-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-aria-label]')) {
    const key = node.getAttribute('data-i18n-aria-label');
    if (key) node.setAttribute('aria-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-color-label]')) {
    const key = node.getAttribute('data-i18n-color-label');
    if (key) node.setAttribute('data-color-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.getAttribute('data-i18n-placeholder');
    if (key) node.setAttribute('placeholder', t(key));
  }
}

const BACKEND_EXACT_TRANSLATIONS = {
  '未知错误': { 'zh-TW': '未知錯誤', en: 'Unknown error' },
  '无效的设置参数': { 'zh-TW': '無效的設定參數', en: 'Invalid settings payload' },
  '宿主暂不支持重启': { 'zh-TW': '宿主暫不支援重新啟動', en: 'Host restart is not supported' },
  '未检测到语言服务二进制文件': { 'zh-TW': '未偵測到語言服務二進位檔案', en: 'Language server binary not found' },
  '未检测到可用的语言服务目标文件': { 'zh-TW': '未偵測到可用的語言服務目標檔案', en: 'No language server binary target found' },
  '原版备份不存在': { 'zh-TW': '原版備份不存在', en: 'Original backup not found' },
  '当前已是原版，无需恢复': { 'zh-TW': '目前已經是原版，無需恢復', en: 'Already using the original binary' },
  '写入失败': { 'zh-TW': '寫入失敗', en: 'Write failed' },
  '未连接到宿主设置桥接': { 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
  '尚未检测到可选模型，请先开启对话或等待列表读取。': { 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list to load.' },
  '本地代理响应异常或目标不可达': { 'zh-TW': '本機代理回應異常或目標不可達', en: 'Local proxy error or target unreachable' },
  '代理状态检查失败': { 'zh-TW': '代理狀態檢查失敗', en: 'Failed to inspect proxy status' },
  '未找到可用的上下文写入模式或目标特征不完整': { 'zh-TW': '未找到可用的上下文寫入模式或目標特徵不完整', en: 'Context patch target signature is incomplete' },
  '当前架构暂不支持上下文补丁': { 'zh-TW': '目前架構暫不支援上下文修補', en: 'Context patching is unsupported on this architecture' },
  '提示词与标题槽位特征不完整': { 'zh-TW': '提示詞與標題槽位特徵不完整', en: 'Prompt/title binary slots not found or incomplete' },
  '后台尚未就绪': { 'zh-TW': '背景服務尚未就緒', en: 'Backend is not ready yet' },
  '读取超时': { 'zh-TW': '讀取逾時', en: 'Request timed out' },
  '完整重启 Antigravity 后启用附件扫描': { 'zh-TW': '完整重新啟動 Antigravity 後啟用附件掃描', en: 'Fully restart Antigravity to enable attachment scanning' },
  '扫描未返回有效结果': { 'zh-TW': '掃描未回傳有效結果', en: 'Scan returned no valid result' },
  '当前预览模式未连接到语言服务增强桥接，可通过 node cli.js enhance-status 查看或执行。': { 'zh-TW': '目前預覽模式未連線到語言服務增強橋接，可透過 node cli.js enhance-status 檢視或執行。', en: 'Enhance bridge unavailable in this mode. Use `node cli.js enhance-status` via CLI.' },
  '仅支持 Windows 平台重启后台语言服务': { 'zh-TW': '僅支援 Windows 平台重啟後台語言服務', en: 'Language server restart is only supported on Windows' },
  '当前操作系统或架构不支持 Windows PE64 内核原位补丁': { 'zh-TW': '目前作業系統或架構不支援 Windows PE64 核心原位修補', en: 'Windows PE64 in-place binary patching is unsupported on this OS/arch' },
  '未指定要应用的提示词档位、中文标题或上下文设置': { 'zh-TW': '未指定要套用的提示詞檔位、中文標題或上下文設定', en: 'No prompt tier, title mode, or context setting specified' },
  '未检测到本机已安装的 Antigravity 内核文件 (language_server.exe / agy.exe)': { 'zh-TW': '未偵測到本機已安裝的 Antigravity 核心檔案 (language_server.exe / agy.exe)', en: 'Local Antigravity binaries (language_server.exe / agy.exe) not found' },
  '未指定目标二进制文件路径，且未检测到默认安装目录。': { 'zh-TW': '未指定目標二進位檔案路徑，且未偵測到預設安裝目錄。', en: 'Target binary path not specified and default install directory not found' },
  '目标文件不存在，无法恢复': { 'zh-TW': '目標檔案不存在，無法恢復', en: 'Target file does not exist; cannot restore' },
  '原版备份文件已损坏或被篡改，无法执行还原。': { 'zh-TW': '原版備份檔案已損壞或遭竄改，無法執行還原。', en: 'Original backup checksum mismatch or corrupted; restore aborted' },
  '原版备份哈希校验不匹配，操作已中止。': { 'zh-TW': '原版備份雜湊校驗不匹配，操作已中止。', en: 'Original backup hash mismatch; operation aborted' },
  '未找到与当前版本匹配的原版备份或原始字节记录，为确保安全拒绝覆盖。': { 'zh-TW': '未找到與目前版本相符的原版備份或原始位元組記錄，為確保安全拒絕覆蓋。', en: 'No matching original backup or byte record found; overwrite aborted' },
  '缺少与当前版本匹配的原始字节记录或备份，无法安全切换回默认状态（已阻止盲写）。': { 'zh-TW': '缺少與目前版本相符的原始位元組記錄或備份，無法安全切換回預設狀態（已阻止盲寫）。', en: 'Missing matching original byte record or backup; safe restore aborted' },
  '当前客户端磁盘 ASAR 未注入汉化组件（或组件不完整）。由于客户端正在运行受系统文件保护，请完全退出 Antigravity 客户端后，在安装包目录运行 install.bat 完成注入。': {
    'zh-TW': '目前用戶端磁碟 ASAR 尚未注入漢化元件（或元件不完整）。由於用戶端執行中受系統檔案保護，請完全結束 Antigravity 用戶端後，在安裝包目錄執行 install.bat 完成注入。',
    en: 'Localization module is missing or incomplete in Antigravity app.asar. Because the running client locks its files, completely quit Antigravity and run install.bat from the package directory.'
  },
  '当前客户端磁盘 ASAR 未注入免 TUN 代理组件（或组件不完整）。由于客户端正在运行受系统文件保护，请完全退出 Antigravity 客户端后，在安装包目录运行 install.bat 完成注入。': {
    'zh-TW': '目前用戶端磁碟 ASAR 尚未注入免 TUN 代理元件（或元件不完整）。由於用戶端執行中受系統檔案保護，請完全結束 Antigravity 用戶端後，在安裝包目錄執行 install.bat 完成注入。',
    en: 'TUN-free proxy module is missing or incomplete in Antigravity app.asar. Because the running client locks its files, completely quit Antigravity and run install.bat from the package directory.'
  },
  '模块未注入，配置保持关闭': { 'zh-TW': '模組未注入，設定維持關閉', en: 'Module not injected; setting kept off' },
  '已更新并保存设置，重启客户端后生效': { 'zh-TW': '已更新並儲存設定，重啟用戶端後生效', en: 'Settings saved; restart Antigravity to take effect' },
  '已保存品牌标题设置，重启客户端后生效': { 'zh-TW': '已儲存品牌標題設定，重啟用戶端後生效', en: 'Brand title setting saved; restart Antigravity to take effect' },
  '已关闭配置，重启客户端后生效': { 'zh-TW': '已關閉設定，重啟用戶端後生效', en: 'Setting disabled; restart Antigravity to take effect' },
  '仅允许本机主聊天窗口': { 'zh-TW': '僅允許本機主聊天視窗', en: 'Local main chat window only' },
  '仅允许打开官方白名单链接（GitHub 仓库或作者署名主页）': { 'zh-TW': '僅允許開啟官方白名單連結（GitHub 倉庫或作者署名首頁）', en: 'Only allowlisted official links are allowed' },
  '入账失败': { 'zh-TW': '入帳失敗', en: 'Failed to record usage' },
  '代理地址为空或格式无效': { 'zh-TW': '代理位址為空或格式無效', en: 'Proxy URL is empty or invalid' },
  '代理端口可连接，但外网访问无响应，可能节点异常或未接通公网': { 'zh-TW': '代理連接埠可連線，但外網存取無回應，可能節點異常或未連通公網', en: 'Local proxy port is reachable, but public internet test timed out' },
  '未提供有效的目标二进制文件 (options.targets)': { 'zh-TW': '未提供有效的目標二進位檔案 (options.targets)', en: 'No valid target binary files provided (options.targets)' },
  '上下文长度必须为正安全整数（tokens）': { 'zh-TW': '上下文長度必須為正安全整數（tokens）', en: 'Context limit must be a positive safe integer (tokens)' },
  '上下文长度必须为纯正整数（tokens），不可包含小数或非数字字符': { 'zh-TW': '上下文長度必須為純正整數（tokens），不可包含小數或非數字字元', en: 'Context limit must contain digits only (positive integer tokens)' },
  '上下文长度超出安全整数范围': { 'zh-TW': '上下文長度超出安全整數範圍', en: 'Context limit exceeds safe integer range' },
  '无效的上下文长度输入类型': { 'zh-TW': '無效的上下文長度輸入類型', en: 'Invalid context limit input type' },
  '未知的模块标识': { 'zh-TW': '未知的模組識別碼', en: 'Unknown module identifier' },
  '不支持的代理协议': { 'zh-TW': '不支援的代理通訊協定', en: 'Unsupported proxy protocol' },
  '代理地址格式错误': { 'zh-TW': '代理位址格式錯誤', en: 'Invalid proxy URL format' },
  '本地代理端口检测异常': { 'zh-TW': '本機代理連接埠檢測異常', en: 'Local proxy port check error' },
  '外网连通性测试异常': { 'zh-TW': '外網連通性測試異常', en: 'Internet connectivity check error' },
  '无效的提示词档位参数': { 'zh-TW': '無效的提示詞檔位參數', en: 'Invalid prompt tier parameter' },
  '无效的中文标题补丁参数': { 'zh-TW': '無效的中文標題修補參數', en: 'Invalid Chinese title patch parameter' },
  '无效的上下文模式参数': { 'zh-TW': '無效的上下文模式參數', en: 'Invalid context mode parameter' },
  '指定的目标文件不存在': { 'zh-TW': '指定的目標檔案不存在', en: 'Target file does not exist' }
};

function localizeBillingCycleLabel(cycle) {
  if (!cycle) return t('plan.cycleOpt.monthly');
  const c = String(cycle).trim();
  if (c === '月付' || c === '月繳' || c === 'Monthly' || c === 'monthly') return t('plan.cycleOpt.monthly');
  if (c === '年付' || c === '年繳' || c === 'Yearly' || c === 'yearly') return t('plan.cycleOpt.yearly');
  if (c === '免费/赠送' || c === '随套餐赠送/免费' || c === 'Free / Promo' || c === 'free') {
    if (currentPanelLanguage === 'zh-CN') return '免费/赠送';
    if (currentPanelLanguage === 'zh-TW') return '免費/贈送';
    return 'Free / Promo';
  }
  if (c === '随套餐包含' || c === 'Included in bundle') return t('plan.cycleOpt.included');
  if (c === '单次' || c === '單次' || c === 'One-time' || c === 'one_time') return t('plan.cycle.oneTime');
  if (c === '其他周期' || c === 'Other cycle') return t('plan.cycleOpt.other');
  if (c === '未知' || c === 'Unknown') return t('speed.unknown');
  return c;
}

function localizeAcquisitionSource(val) {
  if (!val) return t('plan.acq.normal');
  const s = String(val).trim();
  const directKey = `plan.acqOpt.${s}`;
  const directHit = t(directKey);
  if (directHit && directHit !== directKey) return directHit;

  if (s.includes('学生') || s.includes('教育') || s.includes('Student')) return t('plan.acqOpt.student_offer');
  if (s.includes('Pixel')) return t('plan.acqOpt.pixel_bundle');
  if (s.includes('Chromebook')) return t('plan.acqOpt.chromebook_bundle');
  if (s.includes('Samsung') || s.includes('三星')) return t('plan.acqOpt.samsung_galaxy');
  if (s.includes('Jio')) return t('plan.acqOpt.jio_offer');
  if (s.includes('家庭') || s.includes('Family')) return t('plan.acqOpt.family_sharing');
  if (s.includes('促销') || s.includes('试用') || s.includes('Promo') || s.includes('Trial')) return t('plan.acqOpt.official_promo');
  if (s.includes('正常') || s.includes('付费') || s.includes('Standard') || s.includes('Paid')) return t('plan.acq.normal');
  if (s.includes('自定义') || s.includes('Custom')) return t('plan.acqOpt.custom_source');
  return s;
}

function localizeCnyFormatted(str) {
  if (!str) return '';
  const s = String(str).trim();
  const cleanVal = s.replace(/^[折合約\s≈()（）]+/, '').replace(/[()（）]/g, '').trim();
  if (!cleanVal) return '';
  return t('plan.cny.approx', { val: cleanVal });
}

function localizeUnknownLabel(val) {
  if (val === null || val === undefined || val === '') return t('speed.unknown');
  const s = String(val).trim();
  if (s === '未知' || s === 'Unknown' || s.includes('未在当前会话中获取')) return t('speed.unknown');
  return s;
}

function translateBackendText(text) {
  if (text === null || text === undefined) return '';
  const str = String(text);
  if (currentPanelLanguage === 'zh-CN') return str;
  const trimmed = str.trim();
  const hit = BACKEND_EXACT_TRANSLATIONS[trimmed];
  if (hit && hit[currentPanelLanguage]) return hit[currentPanelLanguage];

  // 模式化翻译：ASAR 未注入模块提示（兼容任意模块名称）
  const asarMissingMatch = trimmed.match(/^当前客户端磁盘\s*ASAR\s*未注入(.+?)组件（或组件不完整）。/);
  if (asarMissingMatch) {
    const modRaw = asarMissingMatch[1].trim();
    if (currentPanelLanguage === 'en') {
      const modEn = modRaw === '汉化'
        ? 'Localization'
        : (modRaw === '免 TUN 代理' ? 'TUN-free proxy' : modRaw);
      return `${modEn} module is missing or incomplete in Antigravity app.asar. Because the running client locks its files, completely quit Antigravity and run install.bat from the package directory.`;
    }
    const modTw = modRaw === '汉化' ? '漢化' : modRaw;
    return `目前用戶端磁碟 ASAR 尚未注入${modTw}元件（或元件不完整）。由於用戶端執行中受系統檔案保護，請完全結束 Antigravity 用戶端後，在安裝包目錄執行 install.bat 完成注入。`;
  }

  // 模式化翻译：本地代理端口无法连接
  const proxyUnreachMatch = trimmed.match(/^本地代理端口\s*\((.+?)\)\s*无法连接，请确认代理软件已启动$/);
  if (proxyUnreachMatch) {
    return currentPanelLanguage === 'en'
      ? `Local proxy port (${proxyUnreachMatch[1]}) is unreachable; ensure your proxy client is running`
      : `本機代理連接埠 (${proxyUnreachMatch[1]}) 無法連線，請確認代理軟體已啟動`;
  }

  // 模式化翻译：文件被运行中后台服务锁定
  const fileLockSwapMatch = trimmed.match(/^文件正被运行中的后台服务锁定且重命名替换失败（可点击「重启客户端」或退出后重试）[:：]\s*(.+)$/);
  if (fileLockSwapMatch) {
    return currentPanelLanguage === 'en'
      ? `Target binary is locked by a running background service and atomic swap failed (click Restart Antigravity or quit and retry): ${translateBackendText(fileLockSwapMatch[1])}`
      : `檔案正被執行中的背景服務鎖定且重新命名取代失敗（可點擊「重啟用戶端」或結束後重試）：${translateBackendText(fileLockSwapMatch[1])}`;
  }

  // 模式化翻译：上下文长度超限
  const ctxRangeMatch = trimmed.match(/^上下文长度超出工程可写范围\s*\((.+?)\)$/);
  if (ctxRangeMatch) {
    return currentPanelLanguage === 'en'
      ? `Context limit out of supported range (${ctxRangeMatch[1]})`
      : `上下文長度超出工程可寫範圍 (${ctxRangeMatch[1]})`;
  }

  // 模式化翻译：文件名/目标被占用或锁定
  const inUseMatch = trimmed.match(/^(.+?)\s*被占用$/);
  if (inUseMatch) {
    return currentPanelLanguage === 'en' ? `${inUseMatch[1]} is in use` : `${inUseMatch[1]} 正被佔用`;
  }
  const lockedMatch = trimmed.match(/^(.+?)\s*被锁定$/);
  if (lockedMatch) {
    return currentPanelLanguage === 'en' ? `${lockedMatch[1]} is locked` : `${lockedMatch[1]} 已被鎖定`;
  }
  const colonMatch = trimmed.match(/^([^:：]{2,40})[:：]\s*(.+)$/);
  if (colonMatch) {
    const prefix = colonMatch[1].trim();
    const rest = colonMatch[2].trim();
    const prefixHit = BACKEND_EXACT_TRANSLATIONS[prefix];
    if (prefixHit && prefixHit[currentPanelLanguage]) {
      const sep = currentPanelLanguage === 'en' ? ': ' : '：';
      return `${prefixHit[currentPanelLanguage]}${sep}${translateBackendText(rest)}`;
    }
  }
  // 模式化翻译：账号切换成功、验证未生效/回滚、刷新额度与客户端限制明细
  const switchOkMatch = trimmed.match(/^已切换至\s+(\S+?)，语言服务已重启并通过 GetUserStatus 核验生效。$/);
  if (switchOkMatch) {
    return currentPanelLanguage === 'en'
      ? `Switched to ${switchOkMatch[1]}; language server restarted and verified via GetUserStatus.`
      : `已切換至 ${switchOkMatch[1]}，語言服務已重啟並通過 GetUserStatus 核驗生效。`;
  }
  const switchCredMatch = trimmed.match(/^已写入\s+(\S+?)\s+凭据并通过生效校验（部分桌面扩展若仍显示旧缓存，建议重载窗口）。$/);
  if (switchCredMatch) {
    return currentPanelLanguage === 'en'
      ? `Credentials for ${switchCredMatch[1]} applied and verified (reload window if extensions still cache previous state).`
      : `已寫入 ${switchCredMatch[1]} 憑據並通過生效校驗（部分桌面擴充若仍顯示舊快取，建議重載視窗）。`;
  }
  const switchFailMatch = trimmed.match(/^凭据验证未生效，宿主暂未切换至\s+(\S+?)(?:（当前仍回报\s+(.+?)）)?(，已自动回滚原凭据)?。请重载或重启 Antigravity 客户端后重试。$/);
  if (switchFailMatch) {
    const targetEm = switchFailMatch[1];
    const obsEm = switchFailMatch[2];
    const hasRb = Boolean(switchFailMatch[3]);
    if (currentPanelLanguage === 'en') {
      return `Credential verification failed: host has not switched to ${targetEm}${obsEm ? ` (still reports ${obsEm})` : ''}${hasRb ? '; rolled back automatically' : ''}. Reload or restart Antigravity and retry.`;
    }
    return `憑據驗證未生效，宿主暫未切換至 ${targetEm}${obsEm ? `（目前仍回報 ${obsEm}）` : ''}${hasRb ? '，已自動回滾原憑據' : ''}。請重載或重啟 Antigravity 用戶端後重試。`;
  }
  const refreshAllMatch = trimmed.match(/^已刷新全部\s+(\d+)\s+个账号最新额度快照。$/);
  if (refreshAllMatch) {
    return currentPanelLanguage === 'en'
      ? `Refreshed latest quota snapshots for all ${refreshAllMatch[1]} account(s).`
      : `已重新整理全部 ${refreshAllMatch[1]} 個帳號最新額度快照。`;
  }
  const refreshOneMatch = trimmed.match(/^已刷新\s+(\S+?)\s+最新额度快照。$/);
  if (refreshOneMatch) {
    return currentPanelLanguage === 'en'
      ? `Refreshed latest quota snapshot for ${refreshOneMatch[1]}.`
      : `已重新整理 ${refreshOneMatch[1]} 最新額度快照。`;
  }
  const quotaRefreshPartialMatch = trimmed.match(/^额度刷新部分或全部失败（成功\s+(\d+)\s+\/\s+失败\s+(\d+)）：(.+)$/);
  if (quotaRefreshPartialMatch) {
    const [, okN, failN, detail] = quotaRefreshPartialMatch;
    const translatedDetail = translateBackendText(detail);
    return currentPanelLanguage === 'en'
      ? `Quota refresh failed (${okN} ok / ${failN} failed): ${translatedDetail}`
      : `額度重新整理部分或全部失敗（成功 ${okN} / 失敗 ${failN}）：${translatedDetail}`;
  }
  // 防止英文模式下未知中文后端文本泄漏造成中英混杂拼接
  if (currentPanelLanguage === 'en' && /[\u4e00-\u9fa5]/.test(trimmed)) {
    return 'Backend operation failed (see desktop log for details)';
  }
  return str;
}

function localizePlanTierName(name) {
  if (!name) return t('speed.unknown');
  const s = String(name).trim();
  if (/^Google AI Ultra\s*[（(]/i.test(s) && !/(?:5x|20x)/i.test(s)) {
    return 'Google AI Ultra';
  }
  if (/^Google AI Ultra\s*[（(](5x|20x)[）)]$/i.test(s)) {
    const m = s.match(/(5x|20x)/i);
    return `Google AI Ultra ${m[1].toLowerCase()}`;
  }
  if (s === 'Free' || s === '免费版' || s === '免費版' || s === 'Free (免费版)' || s === 'Free (免費版)') {
    return t('plan.tier.free');
  }
  if (s === 'Google AI Ultra (5x)') return t('plan.tier.ultra5x');
  if (s === 'Google AI Ultra (20x)') return t('plan.tier.ultra20x');
  if (s === '未知') return t('speed.unknown');
  return s;
}

function formatVendorLabel(vendor) {
  if (!vendor || vendor === '其他' || vendor === 'Other') {
    return currentPanelLanguage === 'en' ? 'Other' : '其他';
  }
  return vendor;
}

// =========================================================================
// 全局货币换算与三语差异化格式化中心 + 预设地区本地化映射
// =========================================================================
const FALLBACK_RATES_TO_CNY = {
  CNY: 1.0,
  USD: 6.72,
  HKD: 0.857,
  TWD: 0.21,
  NTD: 0.21,
  JPY: 0.0425,
  KRW: 0.0051,
  EUR: 7.52,
  GBP: 8.75,
  AUD: 4.45,
  CAD: 4.88,
  SGD: 5.12,
  MYR: 1.55,
  INR: 0.076,
  PHP: 0.117,
  TRY: 0.133,
  NGN: 0.0042,
  BRL: 1.18,
  EGP: 0.143
};

const EXTRA_COUNTRY_LOCALES = {
  DE: { name: '德国', nameTw: '德國', nameEn: 'Germany' },
  UK: { name: '英国', nameTw: '英國', nameEn: 'United Kingdom' },
  CN: { name: '中国大陆', nameTw: '中國大陸', nameEn: 'China Mainland' },
  EU: { name: '欧洲', nameTw: '歐洲', nameEn: 'Europe' },
  AU: { name: '澳大利亚', nameTw: '澳洲', nameEn: 'Australia' },
  EG: { name: '埃及', nameTw: '埃及', nameEn: 'Egypt' }
};

function convertCurrencyUi(amount, fromCurrency, toCurrency, regionQuery = null) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
  const num = Number(amount);
  if (num === 0) return 0;
  let from = String(fromCurrency || 'USD').trim().toUpperCase();
  let to = String(toCurrency || 'USD').trim().toUpperCase();
  if (from === 'NTD') from = 'TWD';
  if (to === 'NTD') to = 'TWD';
  if (from === to) return Number(num.toFixed(2));
  const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
  if (core && typeof core.convertCurrency === 'function') {
    const res = core.convertCurrency(num, from, to, regionQuery);
    if (res !== null && Number.isFinite(res)) return res;
  }
  const fromRate = FALLBACK_RATES_TO_CNY[from];
  const toRate = FALLBACK_RATES_TO_CNY[to];
  if (!fromRate || !toRate) return null;
  return Number(((num * fromRate) / toRate).toFixed(2));
}

function formatCompactRefNum(val, cur) {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return '0';
  if (cur === 'CNY') return num.toFixed(2);
  if (num === 0) return '0';
  if (Math.abs(num) < 10) return num.toFixed(2);
  if (Math.abs(num) < 100) return num.toFixed(1);
  return String(Math.round(num));
}

/**
 * 统一格式化 USD API 估算费用（三语差异化规则）：
 * - en: 纯 USD（不含任何 ¥ / CNY）
 * - zh-CN: USD + CNY（≈ $618.53 (¥4156.54)）
 * - zh-TW: 紧凑单行模式 USD + HKD/TWD（≈ $618.53 (HK$4850 / NT$19793)）；detail=true 完整四币种 USD+HKD+TWD+CNY
 */
function formatUsdMetricDisplay(usdAmount, options = {}) {
  const num = Number(usdAmount || 0);
  const safeUsd = Number.isFinite(num) ? num : 0;
  const prefix = options.withPrefix === false ? '' : '≈ ';
  const usdStr = `${prefix}$${safeUsd.toFixed(2)}`;
  const lang = options.lang || currentPanelLanguage;
  if (lang === 'en') {
    return usdStr;
  }
  if (lang === 'zh-TW') {
    const hkd = convertCurrencyUi(safeUsd, 'USD', 'HKD') ?? (safeUsd * 7.84);
    const twd = convertCurrencyUi(safeUsd, 'USD', 'TWD') ?? (safeUsd * 32.0);
    const cny = convertCurrencyUi(safeUsd, 'USD', 'CNY') ?? (safeUsd * 6.72);
    if (options.detail) {
      return `${usdStr} (HK$${formatCompactRefNum(hkd, 'HKD')} · NT$${formatCompactRefNum(twd, 'TWD')} · ¥${cny.toFixed(2)} CNY)`;
    }
    return `${usdStr} (HK$${formatCompactRefNum(hkd, 'HKD')} / NT$${formatCompactRefNum(twd, 'TWD')})`;
  }
  const cny = convertCurrencyUi(safeUsd, 'USD', 'CNY') ?? (safeUsd * 6.72);
  return `${usdStr} (¥${cny.toFixed(2)})`;
}

function formatUsdMetricTooltip(usdAmount) {
  const num = Number(usdAmount || 0);
  const safeUsd = Number.isFinite(num) ? num : 0;
  if (currentPanelLanguage === 'en') {
    return `USD $${safeUsd.toFixed(2)}`;
  }
  const hkd = convertCurrencyUi(safeUsd, 'USD', 'HKD') ?? (safeUsd * 7.84);
  const twd = convertCurrencyUi(safeUsd, 'USD', 'TWD') ?? (safeUsd * 32.0);
  const cny = convertCurrencyUi(safeUsd, 'USD', 'CNY') ?? (safeUsd * 6.72);
  if (currentPanelLanguage === 'zh-TW') {
    return `USD $${safeUsd.toFixed(2)} · HKD HK$${hkd.toFixed(1)} · TWD NT$${Math.round(twd)} · CNY ¥${cny.toFixed(2)}`;
  }
  return `USD $${safeUsd.toFixed(2)} · CNY ¥${cny.toFixed(2)}`;
}

/**
 * 统一格式化订阅价格的辅助换算文本（不含外层括号）：
 * - en: 默认 USD 返回 ''；非 USD 返回 "approx. $X.XX USD"（或带 /mo）
 * - zh-CN: CNY 返回 ''；非 CNY 返回 "折合 ≈ ¥X.X CNY" / "≈ ¥X.X CNY"
 * - zh-TW: detail=true 时返回完整四币种（跳过自身）对照；紧凑模式返回紧凑多币参考
 */
function formatSubscriptionSecondaryConversion(amount, currency, regionQuery = null, options = {}) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount)) || Number(amount) === 0) return '';
  let cur = String(currency || 'USD').trim().toUpperCase();
  if (cur === 'NTD') cur = 'TWD';
  const lang = options.lang || currentPanelLanguage;
  const suffixMo = options.perMonth ? t('plan.summary.perMonth') : '';

  if (lang === 'en') {
    if (cur === 'USD') return '';
    const usd = convertCurrencyUi(amount, cur, 'USD', regionQuery);
    if (usd === null) return '';
    return `approx. $${usd.toFixed(2)} USD${suffixMo}`;
  }

  if (lang === 'zh-TW') {
    const usd = cur === 'USD' ? Number(amount) : convertCurrencyUi(amount, cur, 'USD', regionQuery);
    const hkd = cur === 'HKD' ? Number(amount) : convertCurrencyUi(amount, cur, 'HKD', regionQuery);
    const twd = cur === 'TWD' ? Number(amount) : convertCurrencyUi(amount, cur, 'TWD', regionQuery);
    const cny = cur === 'CNY' ? Number(amount) : convertCurrencyUi(amount, cur, 'CNY', regionQuery);
    const parts = [];
    if (cur !== 'USD' && usd !== null) parts.push(`US$${usd.toFixed(2)}`);
    if (cur !== 'HKD' && hkd !== null) parts.push(`HK$${formatCompactRefNum(hkd, 'HKD')}`);
    if (cur !== 'TWD' && twd !== null) parts.push(`NT$${formatCompactRefNum(twd, 'TWD')}`);
    if (options.detail && cur !== 'CNY' && cny !== null) parts.push(`¥${cny.toFixed(1)} CNY`);
    else if (!options.detail && cur !== 'CNY' && parts.length < 2 && cny !== null) parts.push(`¥${cny.toFixed(1)} CNY`);
    if (!parts.length) return '';
    const joined = parts.join(' · ');
    return options.short ? `≈ ${joined}${suffixMo}` : `約合 ≈ ${joined}${suffixMo}`;
  }

  // zh-CN: USD + CNY 双币参考
  if (cur === 'CNY') return '';
  const cny = convertCurrencyUi(amount, cur, 'CNY', regionQuery);
  if (cny === null) return '';
  const cnyTxt = `${Number(cny).toFixed(1)} CNY`;
  if (options.perMonth) return t('plan.cnyApprox', { val: Number(cny).toFixed(1) });
  return options.short ? `≈ ¥${cnyTxt}` : `折合 ≈ ¥${cnyTxt}`;
}

function getLocalizedPresetName(presetOrCode, lang = currentPanelLanguage) {
  if (!presetOrCode) return '';
  const normLang = normalizePanelLanguage(lang);
  if (typeof presetOrCode === 'string') {
    const key = presetOrCode.trim().toUpperCase();
    const extra = EXTRA_COUNTRY_LOCALES[key];
    if (extra) {
      return normLang === 'en' ? extra.nameEn : (normLang === 'zh-TW' ? extra.nameTw : extra.name);
    }
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const matched = core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.id === key);
    if (matched) return getLocalizedPresetName(matched, normLang);
    return presetOrCode;
  }
  if (normLang === 'en') return presetOrCode.nameEn || presetOrCode.id || presetOrCode.name || '';
  if (normLang === 'zh-TW') return presetOrCode.nameTw || presetOrCode.name || '';
  return presetOrCode.name || '';
}

/**
 * 将任意已存储或输入框中的常见预设地区名称（含 "美国 (US)" / "美国 (USD)" / "澳大利亚" 等）
 * 映射转换为当前面板语言对应的本地化地区文本；无法识别的纯自定义输入保持原样。
 */
function localizeRegionDisplayValue(raw, lang = currentPanelLanguage) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '未知' || trimmed === 'Unknown' || trimmed.includes('未在当前会话中获取')) {
    return '';
  }
  const normLang = normalizePanelLanguage(lang);
  const leadCodeMatch = trimmed.match(/^([A-Z]{2,3})\s+(.+)$/);
  const parenMatch = trimmed.match(/^(.*?)\s*\(([A-Za-z0-9]{2,5})\)\s*$/);
  const suffixCode = parenMatch ? parenMatch[2].toUpperCase() : (leadCodeMatch ? leadCodeMatch[1].toUpperCase() : '');
  const baseText = parenMatch ? parenMatch[1].trim() : (leadCodeMatch ? leadCodeMatch[2].trim() : trimmed);
  const baseLower = baseText.toLowerCase();

  // 1. 优先查特例（含 英国 UK / 德国 DE / 埃及 EG / 中国大陆 CN / 欧洲 EU / 澳大利亚 AU）
  for (const [id, loc] of Object.entries(EXTRA_COUNTRY_LOCALES)) {
    const names = [loc.name.toLowerCase(), loc.nameTw.toLowerCase(), loc.nameEn.toLowerCase()];
    if (names.includes(baseLower) || id === suffixCode || (!parenMatch && !leadCodeMatch && id === trimmed.toUpperCase())) {
      const targetName = normLang === 'en' ? loc.nameEn : (normLang === 'zh-TW' ? loc.nameTw : loc.name);
      const dispCode = suffixCode || id;
      return dispCode ? `${dispCode === 'GB' ? 'UK' : dispCode} ${targetName}` : targetName;
    }
  }

  // 2. 查询 SUBSCRIPTION_REGIONS_PRESET
  const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
  const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
  let matched = presets.find(p => {
    const cleanCn = String(p.name || '').replace(/\s*\([^)]+\)\s*$/, '').toLowerCase();
    const cleanTw = String(p.nameTw || '').replace(/\s*\([^)]+\)\s*$/, '').toLowerCase();
    const cleanEn = String(p.nameEn || '').replace(/\s*\([^)]+\)\s*$/, '').toLowerCase();
    return (
      p.name.toLowerCase() === baseLower ||
      (p.nameTw && p.nameTw.toLowerCase() === baseLower) ||
      (p.nameEn && p.nameEn.toLowerCase() === baseLower) ||
      cleanCn === baseLower ||
      cleanTw === baseLower ||
      cleanEn === baseLower
    );
  });
  if (!matched && core?.findRegionPreset) {
    matched = core.findRegionPreset(baseText) || (suffixCode && ['US', 'JP', 'KR', 'TW', 'HK', 'AU', 'SG', 'CA', 'TR', 'NG', 'PH', 'IN', 'MY', 'BR', 'CN', 'GB', 'EU', 'UK'].includes(suffixCode)
      ? core.findRegionPreset(suffixCode === 'UK' ? 'GB' : suffixCode)
      : null);
  }
  if (matched) {
    let targetName = normLang === 'en' ? (matched.nameEn || matched.id) : (normLang === 'zh-TW' ? (matched.nameTw || matched.name) : matched.name);
    if (suffixCode) {
      targetName = targetName.replace(/\s*\((?:CNY|澳区|澳區|德法[意義]西荷等)\)\s*/gi, '').trim();
      const dispCode = suffixCode === 'GB' ? 'UK' : suffixCode;
      return `${dispCode} ${targetName}`;
    }
    return targetName;
  }

  return trimmed.replace(/^(.*?)\s*[（(]([A-Za-z0-9]{2,5})[)）]\s*$/, '$2 $1').trim();
}

function formatPresetRegionLineParts(preset, lang = currentPanelLanguage, tierSpecKey = 'pro') {
  if (!preset) return { left: '', right: '', full: '' };
  const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
  const specKey = (core && typeof core.resolvePlanSpecKey === 'function')
    ? core.resolvePlanSpecKey(tierSpecKey || 'pro')
    : (tierSpecKey || 'pro');
  const dispName = getLocalizedPresetName(preset, lang).replace(/\s*\(CNY\)\s*$/i, '').trim();
  const dispId = preset.id === 'GB' ? 'UK' : preset.id;
  const left = `${preset.flag || '🌏'} ${dispId} ${dispName}`;

  const lookup = (core && typeof core.getRegionPlanReferencePrice === 'function')
    ? core.getRegionPlanReferencePrice(preset, specKey)
    : null;
  if (lookup && lookup.available === false) {
    const unsetRight = t('plan.summary.priceUnsetShort');
    return { left, right: unsetRight, full: `${left} · ${unsetRight}` };
  }

  const refCur = lookup?.currency || preset.currency || 'USD';
  const refSym = lookup?.symbol || (refCur === 'CNY' ? '¥' : (preset.symbol || '$'));
  const refPrice = lookup?.monthlyPrice !== undefined && lookup?.monthlyPrice !== null
    ? lookup.monthlyPrice
    : preset.monthlyPrice;
  const perMo = lang === 'en' ? '/mo' : '/月';

  if (refPrice === 0 || specKey === 'free') {
    const freeLbl = lang === 'en' ? 'Included' : (lang === 'zh-TW' ? '免費' : '免费');
    const right = `${refSym}0${perMo} · ${freeLbl}`;
    return { left, right, full: `${left} · ${right}` };
  }

  const priceNum = Number(refPrice);
  const formattedNum = Number.isFinite(priceNum)
    ? (priceNum % 1 === 0 ? String(priceNum) : priceNum.toFixed(2).replace(/\.00$/, ''))
    : String(refPrice || '');
  const priceText = `${refSym}${formattedNum}${perMo}`;
  const sec = formatSubscriptionSecondaryConversion(refPrice, refCur, preset.name, { short: true, lang });
  const right = sec ? `${priceText} · ${sec}` : priceText;
  const full = `${left} · ${right}`;
  return { left, right, full };
}

function formatPeriodCalendarLabel(currentPeriod) {
  if (!currentPeriod) return t('cost.periodTag');
  const raw = String(currentPeriod.periodKey || currentPeriod.key || currentPeriod.label || '').trim();
  const ymMatch = raw.match(/^(\d{4}-\d{2})/);
  if (ymMatch) {
    return t('cost.periodTagFmt', { ym: ymMatch[1] });
  }
  if (!raw || raw.includes('自然月') || raw === '本月自然月') return t('cost.periodTag');
  return raw;
}

