  // =========================================================================
  // 模型额度看板核心引擎 (直接移植自 10.html · 10 阶动态色表 + ≤10% 红警 + 70px 总小时圆盘 + 三段式零残留动效)
  // =========================================================================
  const QB_SVG_NS = 'http://www.w3.org/2000/svg';
  const QB_CELL_COUNT = 20;
  const QB_MINI_R = 6.8;
  const QB_MINI_C = 2 * Math.PI * QB_MINI_R;
  const QB_DIAL_SIZE = 70;
  const QB_DIAL_CX = 35;
  const QB_DIAL_CY = 35;
  const QB_DIAL_R = 25.4;
  const QB_DIAL_C = 2 * Math.PI * QB_DIAL_R;

  // 固定生产节奏：沿用 10.html 默认推荐 0.3x 细腻观感
  const QB_PROD_SPEED = 0.3;
  const QB_PROD_SPEED_SCALE = 1 / QB_PROD_SPEED;

  // 统一 <=10% 临界红警规范 (直接复用 10.html RED_ALERT_SPEC)
  const RED_ALERT_HEX = '#EF4444';
  const RED_ALERT_SPEC = Object.freeze({
    step: 1,
    pctLabel: '10%',
    hex: RED_ALERT_HEX,
    isRedAlert: true,
    isUnknown: false,
    isNoPermission: false,
    dialStart: '#F87171',
    dialEnd: '#DC2626',
    tipDot: '#FECACA',
    digitColor: '#FCA5A5',
    orbitalStroke: 'rgba(239, 68, 68, 0.62)',
    baseRail: 'rgba(239, 68, 68, 0.36)',
    pillBg: 'rgba(239, 68, 68, 0.14)',
    pillBorder: 'rgba(239, 68, 68, 0.44)',
    pillText: '#FCA5A5'
  });

  // 未知与无权限独立视觉规范 (严禁被误判为红警或 0%)
  const QB_UNKNOWN_SPEC = Object.freeze({
    step: 0,
    pctLabel: '',
    hex: '#6E6E77',
    isRedAlert: false,
    isZero: false,
    isUnknown: true,
    isNoPermission: false,
    dialStart: '#6E6E77',
    dialEnd: '#4A4A52',
    tipDot: '#8A8A94',
    digitColor: '#8A8A94',
    orbitalStroke: 'rgba(138, 138, 148, 0.45)',
    baseRail: 'rgba(138, 138, 148, 0.22)',
    pillBg: 'rgba(138, 138, 148, 0.12)',
    pillBorder: 'rgba(138, 138, 148, 0.30)',
    pillText: '#A1A1AA'
  });

  const QB_NO_PERMISSION_SPEC = Object.freeze({
    step: 0,
    pctLabel: '',
    hex: '#3B82F6',
    isRedAlert: false,
    isZero: false,
    isUnknown: false,
    isNoPermission: true,
    dialStart: '#60A5FA',
    dialEnd: '#2563EB',
    tipDot: '#BFDBFE',
    digitColor: '#93C5FD',
    orbitalStroke: 'rgba(59, 130, 246, 0.50)',
    baseRail: 'rgba(59, 130, 246, 0.24)',
    pillBg: 'rgba(59, 130, 246, 0.14)',
    pillBorder: 'rgba(59, 130, 246, 0.36)',
    pillText: '#93C5FD'
  });

  // 完整四套 10 阶动态色表 (直接复制 10.html POOL_PALETTES，索引 0 为红警，1..9 为 20%..100%)
  const POOL_PALETTES = Object.freeze({
    'gemini-7d': Object.freeze({
      id: 'gemini-7d',
      shortName: 'Gemini 7D',
      segment0Hex: '#F2FDF9',
      steps: Object.freeze([
        RED_ALERT_HEX,
        '#E6FAF3',
        '#CCF4E6',
        '#B0EDD8',
        '#92E5C9',
        '#74DDB9',
        '#56D4A9',
        '#3CC999',
        '#27BA89',
        '#18A878'
      ])
    }),
    'gemini-5h': Object.freeze({
      id: 'gemini-5h',
      shortName: 'Gemini 5H',
      segment0Hex: '#DAF5EC',
      steps: Object.freeze([
        RED_ALERT_HEX,
        '#C2EEDF',
        '#A3E4CE',
        '#82D9BC',
        '#62CEA9',
        '#44C196',
        '#2DB284',
        '#1D9F72',
        '#148B62',
        '#0F7853'
      ])
    }),
    'shared-7d': Object.freeze({
      id: 'shared-7d',
      shortName: 'Claude / GPT 7D',
      segment0Hex: '#FFF8F5',
      steps: Object.freeze([
        RED_ALERT_HEX,
        '#FDF1EB',
        '#FBE4D8',
        '#F9D6C4',
        '#F6C7B0',
        '#F3B79B',
        '#EFA685',
        '#EB9570',
        '#E6845B',
        '#DF7348'
      ])
    }),
    'shared-5h': Object.freeze({
      id: 'shared-5h',
      shortName: 'Claude / GPT 5H',
      segment0Hex: '#FAE0D5',
      steps: Object.freeze([
        RED_ALERT_HEX,
        '#F5CEBE',
        '#EFBCA7',
        '#E9AA90',
        '#E39778',
        '#DC8461',
        '#D4714C',
        '#C95F39',
        '#BC4F29',
        '#AD411E'
      ])
    })
  });

  function qbFormatWindowDisplayTag(raw) {
    const clean = String(raw || '').trim();
    if (!clean) return '';
    const low = clean.toLowerCase();
    if (low === '5h') return '5H';
    if (low === '7d' || low === 'weekly') return '7D';
    if (low === '24h' || low === 'daily') return '24H';
    if (/^\d+[hdw]$/i.test(clean)) return clean.toUpperCase();
    return clean;
  }

  function qbClamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function qbEaseOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function qbPad2(n) {
    return String(Math.max(0, Math.floor(n))).padStart(2, '0');
  }

  function qbHexToRgb(hex) {
    const clean = String(hex || '#3CC999').replace('#', '');
    const full = clean.length === 3
      ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
      : clean;
    const num = parseInt(full, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  function qbRgbToHex(r, g, b) {
    const toHex = (c) => qbClamp(Math.round(c), 0, 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }

  function qbMixHex(hexA, hexB, weightB) {
    const a = qbHexToRgb(hexA);
    const b = qbHexToRgb(hexB);
    const w = qbClamp(weightB, 0, 1);
    return qbRgbToHex(
      a.r + (b.r - a.r) * w,
      a.g + (b.g - a.g) * w,
      a.b + (b.b - a.b) * w
    );
  }

  function qbRgbaStr(hex, alpha) {
    const { r, g, b } = qbHexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function qbRelativeLuminance(hex) {
    const { r, g, b } = qbHexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function qbRgbToHsl(r, g, b) {
    const rn = qbClamp(r, 0, 255) / 255;
    const gn = qbClamp(g, 0, 255) / 255;
    const bn = qbClamp(b, 0, 255) / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function qbHslToRgb(h, s, l) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = qbClamp(Number(s), 0, 100) / 100;
    const ln = qbClamp(Number(l), 0, 100) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = ln - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: (r1 + m) * 255,
      g: (g1 + m) * 255,
      b: (b1 + m) * 255
    };
  }

  /**
   * 浅色表面统一有效格明度派生规则 (整条随档 uniform 与条内逐段 progressive 共用同一规则)
   * - 严格保持原色相 H，对明度 L 做单调压深 (dL'/dL = 0.70 > 0)
   * - 保证四套色表各自十阶顺序与 7d/5h 同组层级完整保留，且白底 20%~40% 及逐段首对格清晰可辨
   */
  function deriveLightSurfaceFillHex(hex) {
    const { r, g, b } = qbHexToRgb(hex);
    const { h, s, l } = qbRgbToHsl(r, g, b);
    const drop = 5 + 0.30 * Math.max(0, l - 22);
    const nextL = qbClamp(l - drop, 18, 92);
    const nextS = qbClamp(s * 1.02, 0, 90);
    const rgb = qbHslToRgb(h, nextS, nextL);
    return qbRgbToHex(rgb.r, rgb.g, rgb.b);
  }

  /**
   * 浅色表面高对比文字与胶囊文字派生 (保持同色相，确保白底与淡色底胶囊达到清晰可读对比度)
   */
  function deriveLightReadableTextHex(hex) {
    const { r, g, b } = qbHexToRgb(hex);
    const { h, s, l } = qbRgbToHsl(r, g, b);
    const targetL = qbClamp(Math.min(l - 14, 32), 18, 32);
    const targetS = qbClamp(Math.max(s, 52), 45, 84);
    const rgb = qbHslToRgb(h, targetS, targetL);
    return qbRgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function qbToggleClass(node, className, active) {
    if (!node || !node.classList) return;
    if (active) node.classList.add(className);
    else node.classList.remove(className);
  }

  function qbCreateEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function qbCreateSvgEl(tag, attrs) {
    const node = typeof document.createElementNS === 'function'
      ? document.createElementNS(QB_SVG_NS, tag)
      : document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function qbClearChildren(node) {
    if (!node) return;
    if (typeof node.replaceChildren === 'function') {
      node.replaceChildren();
      return;
    }
    while (node.children && node.children.length > 0) {
      node.removeChild(node.children[node.children.length - 1]);
    }
  }

  function qbParseCssColorLuminance(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return null;
    if (typeof parseRgbLuminance === 'function') {
      const lum = parseRgbLuminance(s);
      if (lum !== null && Number.isFinite(lum)) return lum;
    }
    const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) return qbRelativeLuminance(s);
    const rgbMatch = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?/i);
    if (rgbMatch) {
      if (rgbMatch[4] !== undefined) {
        const a = rgbMatch[4].endsWith('%') ? Number(rgbMatch[4].slice(0, -1)) / 100 : Number(rgbMatch[4]);
        if (Number.isFinite(a) && a <= 0.01) return null;
      }
      return (0.299 * Number(rgbMatch[1]) + 0.587 * Number(rgbMatch[2]) + 0.114 * Number(rgbMatch[3])) / 255;
    }
    return null;
  }

  /**
   * 显式从实际看板表面解析明暗状态 ('light' | 'dark')
   * 优先级：显式参数 -> 看板/宿主 data-panel-tone -> data-theme -> 计算背景表面亮度
   */
  function resolveBoardSurfaceTone(targetEl = null, opts = {}) {
    if (opts && (opts.surface === 'light' || opts.surface === 'dark')) return opts.surface;
    if (opts && typeof opts.isLight === 'boolean') return opts.isLight ? 'light' : 'dark';
    try {
      const candidates = [];
      if (targetEl) {
        candidates.push(targetEl);
        if (typeof targetEl.closest === 'function') {
          const panelNode = targetEl.closest('#panel-quota, .quota-panel');
          if (panelNode && panelNode !== targetEl) candidates.push(panelNode);
        }
        const rootHost = targetEl.getRootNode?.()?.host;
        if (rootHost) candidates.push(rootHost);
      }
      if (typeof host !== 'undefined' && host && !candidates.includes(host)) {
        candidates.push(host);
      }

      for (const node of candidates) {
        const explicitTone = node?.getAttribute?.('data-panel-tone');
        if (explicitTone === 'light' || explicitTone === 'dark') return explicitTone;
      }
      for (const node of candidates) {
        const explicitTheme = node?.getAttribute?.('data-theme');
        if (explicitTheme === 'light' || explicitTheme === 'dark') return explicitTheme;
      }

      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const probeNodes = [targetEl, targetEl?.closest?.('#panel-quota')].filter(Boolean);
        for (const pNode of probeNodes) {
          const cs = window.getComputedStyle(pNode);
          const bgCandidates = [
            cs?.getPropertyValue?.('--qb-bg-canvas'),
            cs?.backgroundColor
          ];
          for (const rawBg of bgCandidates) {
            const lum = qbParseCssColorLuminance(rawBg);
            if (lum !== null) return lum > 0.55 ? 'light' : 'dark';
          }
        }
      }
    } catch { }
    return 'dark';
  }

  function qbIsLightSurface(targetEl = null, opts = {}) {
    return resolveBoardSurfaceTone(targetEl, opts) === 'light';
  }

  /**
   * 精确十阶档位映射 (按未四舍五入的真实百分比判断)：
   * - pct <= 10 -> 1 档 (统一红警 #EF4444)
   * - pct > 10  -> Math.min(10, Math.ceil(pct / 10)) (2..10 档 -> 20%..100%)
   */
  function getDecileStep(pct) {
    const clamped = qbClamp(Number(pct), 0, 100);
    if (clamped <= 10) return 1;
    return Math.min(10, Math.ceil(clamped / 10));
  }

  /**
   * 边界敏感百分比文案格式化：
   * - 真实 pct <= 10 触发红警；pct > 10 且 < 10.5 (如 10.1%) 即使上游 percentText 已被取整为 "10%"，也必须显示 10.1% 等有区别精度
   */
  function qbFormatBoundaryAwarePercent(pct, upstreamPercentText) {
    if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
      return t('quota.time.unknown');
    }
    const clamped = qbClamp(Number(pct), 0, 100);
    if (clamped <= 0) return '0%';
    if (clamped < 0.1) return '<0.1%';
    if (clamped < 1) return `${clamped.toFixed(1)}%`;
    if (clamped > 10 && clamped < 10.5) {
      const oneDec = clamped.toFixed(1);
      if (oneDec !== '10.0') return `${oneDec}%`;
      return `${Number(clamped.toFixed(2))}%`;
    }
    const cleanUpstream = typeof upstreamPercentText === 'string' ? upstreamPercentText.trim() : '';
    if (cleanUpstream && cleanUpstream !== '未知' && cleanUpstream !== 'Unknown' && cleanUpstream !== '—') {
      return cleanUpstream;
    }
    return `${Math.round(clamped)}%`;
  }

  /**
   * 规范化绝对重置时间文案：空值或占位「未知」视为缺失，避免拼出「未知 · 36分」
   */
  function qbNormalizeResetTimeText(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const low = trimmed.toLowerCase();
    if (trimmed === '未知' || trimmed === '—' || trimmed === '-' || low === 'unknown' || low === 'null' || low === 'undefined') {
      return '';
    }
    return trimmed;
  }

  /**
   * 解析指定主题行与真实百分比的完整十阶视觉色值 (与 10.html 严格对齐，浅色表面统一按 HSL 单调压深)
   */
  function resolveDecileSpec(paletteId, pct, opts = {}) {
    const isLight = qbIsLightSurface(opts.boardEl || null, opts);
    if (opts.noPermission) {
      if (isLight) {
        return { ...QB_NO_PERMISSION_SPEC, surfaceTone: 'light', digitColor: '#1D4ED8', pillText: '#1D4ED8', pillBg: 'rgba(37, 99, 235, 0.10)', pillBorder: 'rgba(37, 99, 235, 0.30)' };
      }
      return { ...QB_NO_PERMISSION_SPEC, surfaceTone: 'dark' };
    }
    if (opts.unknown || pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
      if (isLight) {
        return { ...QB_UNKNOWN_SPEC, surfaceTone: 'light', digitColor: '#52525B', pillText: '#52525B', pillBg: 'rgba(82, 82, 91, 0.08)', pillBorder: 'rgba(82, 82, 91, 0.22)' };
      }
      return { ...QB_UNKNOWN_SPEC, surfaceTone: 'dark' };
    }
    const clamped = qbClamp(Number(pct), 0, 100);
    const step = getDecileStep(clamped);

    if (step === 1) {
      return {
        ...RED_ALERT_SPEC,
        surfaceTone: isLight ? 'light' : 'dark',
        isZero: clamped <= 0,
        ...(isLight ? {
          dialStart: '#EF4444',
          dialEnd: '#B91C1C',
          tipDot: '#DC2626',
          digitColor: '#DC2626',
          orbitalStroke: 'rgba(220, 38, 38, 0.56)',
          baseRail: 'rgba(220, 38, 38, 0.30)',
          pillText: '#B91C1C',
          pillBg: 'rgba(239, 68, 68, 0.10)',
          pillBorder: 'rgba(220, 38, 38, 0.36)'
        } : {})
      };
    }

    const palette = POOL_PALETTES[paletteId] || POOL_PALETTES['gemini-7d'];
    const rawHex = palette.steps[step - 1];
    const hex = isLight ? deriveLightSurfaceFillHex(rawHex) : rawHex;
    const lum = qbRelativeLuminance(hex);

    const dialStart = isLight ? qbMixHex(hex, '#18181B', 0.08) : qbMixHex(hex, '#FFFFFF', 0.18);
    const dialEnd = isLight ? qbMixHex(hex, '#18181B', 0.24) : qbMixHex(hex, '#181818', 0.14);
    const tipDot = isLight ? deriveLightReadableTextHex(rawHex) : qbMixHex(hex, '#FFFFFF', 0.55);
    const darkDigitColor = lum < 0.56 ? qbMixHex(hex, '#FFFFFF', 0.34) : hex;
    const darkPillText = lum < 0.52 ? qbMixHex(hex, '#FFFFFF', 0.30) : hex;
    const lightTextHex = isLight ? deriveLightReadableTextHex(rawHex) : '';

    return {
      step,
      pctLabel: `${step * 10}%`,
      hex,
      rawHex,
      surfaceTone: isLight ? 'light' : 'dark',
      isRedAlert: false,
      isZero: false,
      isUnknown: false,
      isNoPermission: false,
      dialStart,
      dialEnd,
      tipDot,
      digitColor: isLight ? lightTextHex : darkDigitColor,
      orbitalStroke: qbRgbaStr(isLight ? lightTextHex : hex, isLight ? 0.56 : 0.60),
      baseRail: qbRgbaStr(isLight ? hex : hex, isLight ? 0.42 : 0.34),
      pillBg: qbRgbaStr(isLight ? lightTextHex : hex, isLight ? 0.10 : 0.13),
      pillBorder: qbRgbaStr(isLight ? lightTextHex : hex, isLight ? 0.32 : 0.40),
      pillText: isLight ? lightTextHex : darkPillText
    };
  }

  /**
   * 计算单格填充色 (支持整条随档位 uniform 与条内 10 阶逐段加深 progressive，浅色模式共用同一派生规则)
   */
  function resolveCellColor(paletteId, cellIndex, targetPct, colorMode, opts = {}) {
    const isLight = qbIsLightSurface(opts.boardEl || null, opts);
    const spec = resolveDecileSpec(paletteId, targetPct, { ...opts, isLight });
    if (spec.isUnknown || spec.isNoPermission) return 'transparent';
    if (spec.isRedAlert || colorMode !== 'progressive') {
      return spec.hex;
    }
    const palette = POOL_PALETTES[paletteId] || POOL_PALETTES['gemini-7d'];
    const segIdx = Math.floor(cellIndex / 2);
    const baseHex = segIdx === 0
      ? palette.segment0Hex
      : palette.steps[qbClamp(segIdx, 1, 9)];
    return isLight ? deriveLightSurfaceFillHex(baseHex) : baseHex;
  }

  /**
   * 精确 20 格分解 (78% -> 15 满格 + 第 16 格 60% 左对齐宽；极小非零保留至少 6% 可见宽)
   */
  function computeCellSpec(pct) {
    if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
      return { activeCells: 0, fullCells: 0, tailRatio: 0 };
    }
    const clamped = qbClamp(Number(pct), 0, 100);
    if (clamped <= 0) {
      return { activeCells: 0, fullCells: 0, tailRatio: 0 };
    }
    const exact = (clamped / 100) * QB_CELL_COUNT;
    const fullCells = Math.floor(exact);
    const remainder = Number((exact - fullCells).toFixed(4));
    const activeCells = remainder > 0.001
      ? Math.min(QB_CELL_COUNT, fullCells + 1)
      : Math.min(QB_CELL_COUNT, fullCells);
    const tailRatio = remainder > 0.001 ? qbClamp(remainder, 0.06, 0.99) : 1;
    return { activeCells, fullCells, tailRatio };
  }

  /**
   * 10.html 总小时与分钟转换 (5 天 4 小时 -> 124:00，7 天整 -> 168:00，4 小时 59 分 -> 04:59)
   */
  function splitDialTotalHours(remainSec) {
    const safe = Math.max(0, Math.floor(Number(remainSec) || 0));
    const totalHours = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const left = totalHours >= 100 ? String(totalHours) : qbPad2(totalHours);
    return { left, right: qbPad2(mins), totalHours };
  }

  /**
   * 悬停与无障碍提示文案 (三语严格零中英文括号)
   */
  function formatExactTotalHoursTooltip(remainSec, remainPct, resetAt) {
    const safe = Math.max(0, Math.floor(Number(remainSec) || 0));
    const totalHours = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    const elapsedPct = 100 - Math.round(qbClamp(remainPct, 0, 100));
    const remPctInt = Math.round(qbClamp(remainPct, 0, 100));
    const hoursStr = totalHours >= 100 ? String(totalHours) : qbPad2(totalHours);
    const resetLabel = qbNormalizeResetTimeText(resetAt);
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const resetTail = resetLabel
      ? (isEn ? ` · Reset ${resetLabel}` : (isTw ? ` · 重設 ${resetLabel}` : ` · 重置 ${resetLabel}`))
      : '';

    if (totalHours >= 24) {
      const days = Math.floor(totalHours / 24);
      const remHours = totalHours % 24;
      if (isEn) {
        return `Left ${hoursStr}h ${qbPad2(mins)}m ${qbPad2(secs)}s · ${days}d ${remHours}h · Elapsed ${elapsedPct}% · Left ${remPctInt}%${resetTail}`;
      }
      if (isTw) {
        return `剩餘 ${hoursStr}小時${qbPad2(mins)}分${qbPad2(secs)}秒 · ${days}天${remHours}小時 · 已過 ${elapsedPct}% · 剩餘 ${remPctInt}%${resetTail}`;
      }
      return `剩余 ${hoursStr}小时${qbPad2(mins)}分${qbPad2(secs)}秒 · ${days}天${remHours}小时 · 已过 ${elapsedPct}% · 剩余 ${remPctInt}%${resetTail}`;
    }
    if (isEn) {
      return `Left ${hoursStr}h ${qbPad2(mins)}m ${qbPad2(secs)}s · Elapsed ${elapsedPct}% · Left ${remPctInt}%${resetTail}`;
    }
    if (isTw) {
      return `剩餘 ${hoursStr}小時${qbPad2(mins)}分${qbPad2(secs)}秒 · 已過 ${elapsedPct}% · 剩餘 ${remPctInt}%${resetTail}`;
    }
    return `剩余 ${hoursStr}小时${qbPad2(mins)}分${qbPad2(secs)}秒 · 已过 ${elapsedPct}% · 剩余 ${remPctInt}%${resetTail}`;
  }

  /**
   * 去除展示文案中的中英文括号，统一以中点分隔保持干净排版
   */
  function qbStripParensForDisplay(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(/[（(]\s*/g, ' · ')
      .replace(/\s*[）)]/g, '')
      .replace(/(?:\s*·\s*){2,}/g, ' · ')
      .replace(/^\s*·\s*|\s*·\s*$/g, '')
      .trim();
  }

  /**
   * 根据真实余量与基准时间生成节奏胶囊文案 (三语严格零中英文括号)
   */
  function qbComputePaceLabel(pct, benchmarkPct, opts = {}) {
    if (opts.noPermission) return t('quota.state.no_permission');
    if (opts.unknown || pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
      return t('quota.state.unknown');
    }
    const rawPct = qbClamp(Number(pct), 0, 100);
    if (rawPct <= 0) return t('quota.board.paceExhausted');
    if (rawPct <= 10) return t('quota.board.paceRedAlert');
    if (benchmarkPct === null || benchmarkPct === undefined || !Number.isFinite(Number(benchmarkPct))) {
      return t('quota.board.paceNoBaseline');
    }
    const p = Math.round(rawPct);
    const b = Math.round(qbClamp(Number(benchmarkPct), 0, 100));
    const diff = p - b;
    if (diff >= 10) return `${t('quota.pace.surplus')} +${diff}%`;
    if (diff >= -4) return diff === 0 ? t('quota.pace.balanced') : `${t('quota.pace.balanced')} ${diff > 0 ? '+' : ''}${diff}%`;
    if (diff >= -20) return `${t('quota.pace.fast')} ${diff}%`;
    return `${t('quota.pace.overburn')} ${diff}%`;
  }

  /**
   * 构建 18px 左侧迷你圆环 SVG (直接移植自 10.html buildMiniRingSvg)
   */
  function buildMiniRingSvg() {
    const svg = qbCreateSvgEl('svg', {
      class: 'mini-ring',
      viewBox: '0 0 18 18',
      'aria-hidden': 'true'
    });
    const track = qbCreateSvgEl('circle', {
      class: 'mini-ring-track',
      cx: '9',
      cy: '9',
      r: String(QB_MINI_R)
    });
    const arc = qbCreateSvgEl('circle', {
      class: 'mini-ring-arc',
      cx: '9',
      cy: '9',
      r: String(QB_MINI_R),
      transform: 'rotate(-90 9 9)',
      'stroke-dasharray': QB_MINI_C.toFixed(3),
      'stroke-dashoffset': QB_MINI_C.toFixed(3)
    });
    const topDot = qbCreateSvgEl('circle', {
      class: 'mini-ring-dot',
      cx: '9',
      cy: '2.2',
      r: '1.1',
      fill: '#ffffff'
    });
    svg.appendChild(track);
    svg.appendChild(arc);
    svg.appendChild(topDot);
    return { svg, arc, topDot };
  }

  /**
   * 构建 70px 右侧圆形重置倒计时表盘 (直接移植自 10.html buildCircularDial，带唯一 Shadow DOM SVG gradId)
   */
  function buildCircularDial(uidPrefix, rowId, title) {
    const safeId = String(rowId || 'row').replace(/[^a-zA-Z0-9_-]/g, '_');
    const gradId = `agQbDialGrad_${uidPrefix}_${safeId}`;

    const zone = qbCreateEl('div', 'row-dial-zone');
    const wrapper = qbCreateEl('div', 'dial-wrapper');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', `${title} ${t('quota.dial.aria', { time: '--:--' })}`);

    const tooltip = qbCreateEl('div', 'dial-tooltip', t('quota.dial.pending'));
    tooltip.setAttribute('role', 'tooltip');

    const svg = qbCreateSvgEl('svg', {
      class: 'dial-svg',
      viewBox: `0 0 ${QB_DIAL_SIZE} ${QB_DIAL_SIZE}`,
      'aria-hidden': 'true'
    });

    const defs = qbCreateSvgEl('defs');
    const grad = qbCreateSvgEl('linearGradient', {
      id: gradId,
      x1: '0%',
      y1: '0%',
      x2: '100%',
      y2: '100%'
    });
    const stopStart = qbCreateSvgEl('stop', { offset: '0%', 'stop-color': '#3CC999' });
    const stopEnd = qbCreateSvgEl('stop', { offset: '100%', 'stop-color': '#18A878' });
    grad.appendChild(stopStart);
    grad.appendChild(stopEnd);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const ticksGroup = qbCreateSvgEl('g');
    for (let i = 0; i < 24; i += 1) {
      const isMajor = i % 6 === 0;
      const rad = ((i * 15 - 90) * Math.PI) / 180;
      const r1 = isMajor ? 30.2 : 31.2;
      const r2 = 33.6;
      const line = qbCreateSvgEl('line', {
        class: isMajor ? 'dial-tick dial-tick--major' : 'dial-tick',
        x1: (QB_DIAL_CX + r1 * Math.cos(rad)).toFixed(2),
        y1: (QB_DIAL_CY + r1 * Math.sin(rad)).toFixed(2),
        x2: (QB_DIAL_CX + r2 * Math.cos(rad)).toFixed(2),
        y2: (QB_DIAL_CY + r2 * Math.sin(rad)).toFixed(2),
        'stroke-width': isMajor ? '1.15' : '0.85',
        'stroke-linecap': 'round'
      });
      ticksGroup.appendChild(line);
    }
    svg.appendChild(ticksGroup);

    const orbital = qbCreateSvgEl('circle', {
      class: 'dial-orbital',
      cx: String(QB_DIAL_CX),
      cy: String(QB_DIAL_CY),
      r: '31.5',
      stroke: 'rgba(60, 201, 153, 0.58)'
    });

    const track = qbCreateSvgEl('circle', {
      class: 'dial-track',
      cx: String(QB_DIAL_CX),
      cy: String(QB_DIAL_CY),
      r: String(QB_DIAL_R)
    });

    const arc = qbCreateSvgEl('circle', {
      class: 'dial-arc',
      cx: String(QB_DIAL_CX),
      cy: String(QB_DIAL_CY),
      r: String(QB_DIAL_R),
      transform: `rotate(-90 ${QB_DIAL_CX} ${QB_DIAL_CY})`,
      stroke: `url(#${gradId})`,
      'stroke-dasharray': QB_DIAL_C.toFixed(3),
      'stroke-dashoffset': QB_DIAL_C.toFixed(3)
    });

    const tipDot = qbCreateSvgEl('circle', {
      class: 'dial-tip-dot',
      cx: String(QB_DIAL_CX),
      cy: String(QB_DIAL_CY - QB_DIAL_R),
      r: '2.25',
      fill: '#ffffff'
    });

    svg.appendChild(orbital);
    svg.appendChild(track);
    svg.appendChild(arc);
    svg.appendChild(tipDot);

    const digits = qbCreateEl('div', 'dial-digits');
    const leftSpan = qbCreateEl('span', 'dial-left', '--');
    const colonSpan = qbCreateEl('span', 'dial-colon', ':');
    const rightSpan = qbCreateEl('span', 'dial-right', '--');
    digits.appendChild(leftSpan);
    digits.appendChild(colonSpan);
    digits.appendChild(rightSpan);

    wrapper.appendChild(tooltip);
    wrapper.appendChild(svg);
    wrapper.appendChild(digits);
    zone.appendChild(wrapper);

    return {
      zone,
      wrapper,
      tooltip,
      stopStart,
      stopEnd,
      orbital,
      arc,
      tipDot,
      digits,
      leftSpan,
      colonSpan,
      rightSpan,
      gradId
    };
  }

  /**
   * 精确按真实池 ID 与窗口键将生产 QuotaView 映射为 10.html 双池四行 + 可选额外真实独立池
   * 严禁按数组顺序或模型名称猜测归属
   */
  function buildQuotaBoardItemsFromView(view, nowMs, opts = {}) {
    const pools = Array.isArray(view?.pools) ? view.pools.filter(Boolean) : [];
    const paceSuppressed = Boolean(opts.paceSuppressed);
    const coreRef = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : (globalThis.__AGContextMeterCore || null);

    const isGeminiPool = (p) => {
      const pk = String(p?.poolKey || '').toLowerCase();
      if (pk === 'shared_gemini_main' || pk.includes('gemini')) return true;
      return (p?.buckets || []).some(b => String(b?.bucketId || '').toLowerCase().includes('gemini'));
    };
    const isShared3pPool = (p) => {
      const pk = String(p?.poolKey || '').toLowerCase();
      if (pk === 'shared_3p_pool' || pk.includes('3p') || pk.includes('claude') || pk.includes('gpt')) return true;
      return (p?.buckets || []).some(b => {
        const bid = String(b?.bucketId || '').toLowerCase();
        return bid.includes('3p') || bid.includes('claude') || bid.includes('gpt');
      });
    };

    const geminiPool = pools.find(isGeminiPool) || null;
    const sharedPool = pools.find(p => p !== geminiPool && isShared3pPool(p)) || null;
    const extraPools = pools.filter(p => p !== geminiPool && p !== sharedPool);

    const findBucketByWindow = (pool, targetWin) => {
      if (!pool || !Array.isArray(pool.buckets)) return null;
      return pool.buckets.find(b => {
        const wk = String(b?.windowKey || '').toLowerCase();
        const ws = String(b?.windowShort || '').toLowerCase();
        const bid = String(b?.bucketId || '').toLowerCase();
        if (targetWin === 'weekly') return wk === 'weekly' || ws === '7d' || bid.includes('weekly') || bid.includes('7d');
        if (targetWin === '5h') return wk === '5h' || ws === '5h' || bid.includes('5h');
        return false;
      }) || null;
    };

    const buildRowItem = ({
      rowId,
      paletteId,
      groupId,
      groupTitle,
      groupSubtitle,
      title,
      windowTag,
      isShared,
      pool,
      bucket,
      defaultTotalSec,
      isCurrentPool
    }) => {
      const noPermission = Boolean(pool?.noPermission);
      const rawFrac = (!noPermission && bucket && bucket.remainingFraction !== null && bucket.remainingFraction !== undefined && Number.isFinite(Number(bucket.remainingFraction)))
        ? qbClamp(Number(bucket.remainingFraction), 0, 1)
        : null;
      const unknown = !noPermission && rawFrac === null;
      const pct = rawFrac === null ? null : rawFrac * 100;
      const percentText = noPermission
        ? t('quota.short.no_permission')
        : (unknown ? t('quota.time.unknown') : qbFormatBoundaryAwarePercent(pct, bucket?.percentText));

      const inferredDurationMs = bucket
        ? (coreRef?.inferQuotaWindowDurationMs
          ? coreRef.inferQuotaWindowDurationMs(bucket.windowKey, bucket.bucketId)
          : defaultTotalSec * 1000)
        : defaultTotalSec * 1000;
      const totalSec = Math.max(1, Math.round((Number(inferredDurationMs) || defaultTotalSec * 1000) / 1000));

      const hasResetTime = Boolean(!noPermission && bucket?.hasResetTime && Number.isFinite(Number(bucket.resetAtMs)));
      const resetAtMs = hasResetTime ? Number(bucket.resetAtMs) : null;
      const remainMs = hasResetTime ? Math.max(0, resetAtMs - nowMs) : null;
      const remainSec = remainMs === null ? null : Math.floor(remainMs / 1000);
      const cleanResetAt = hasResetTime ? qbNormalizeResetTimeText(bucket?.resetTimeText) : '';
      const resetAt = cleanResetAt || null;

      let benchmarkPct = null;
      if (!noPermission && !unknown && !paceSuppressed && hasResetTime && totalSec > 0) {
        if (bucket?.pace && bucket.pace.available && Number.isFinite(Number(bucket.pace.timeRemaining))) {
          benchmarkPct = qbClamp(Number(bucket.pace.timeRemaining) * 100, 0, 100);
        } else {
          benchmarkPct = qbClamp((remainSec / totalSec) * 100, 0, 100);
        }
      }

      const compactCountdown = hasResetTime
        ? (remainMs <= 0 ? t('quota.resetPassReason') : formatCountdownMsCompact(remainMs))
        : '';
      const totalHoursFloor = remainSec === null ? 0 : Math.floor(remainSec / 3600);

      let timeSummary = '';
      let resetSubtext = '';
      if (noPermission) {
        timeSummary = t('quota.state.no_permission');
        resetSubtext = qbStripParensForDisplay(pool?.unavailabilityReason || t('quota.board.noPermSubtext'));
      } else if (hasResetTime) {
        // 顶行压缩重复的总小时摘要；缺少绝对时间文案时省略缺失项与分隔符，避免拼出「未知 · 倒计时」
        const summaryParts = [];
        if (cleanResetAt) summaryParts.push(cleanResetAt);
        if (compactCountdown) summaryParts.push(compactCountdown);
        timeSummary = summaryParts.join(' · ') || t('quota.dial.pending');
        const remainPctInt = Math.round(qbClamp((remainSec / totalSec) * 100, 0, 100));
        if (remainMs <= 0) {
          resetSubtext = `${t('quota.resetPassReason')} · ${t('quota.pace.timeLeft', { pct: remainPctInt })}`;
        } else if (windowTag === '7d' && totalHoursFloor >= 1) {
          resetSubtext = t('quota.board.resetSubtextWeekly', {
            countdown: compactCountdown,
            hours: totalHoursFloor,
            pct: remainPctInt
          });
        } else {
          resetSubtext = t('quota.pace.resetIn', {
            countdown: compactCountdown,
            pct: remainPctInt
          });
        }
      } else if (unknown) {
        timeSummary = t('quota.dial.pending');
        resetSubtext = t('quota.board.unknownSubtext');
      } else {
        timeSummary = t('quota.dial.pending');
        resetSubtext = t('quota.dial.pending');
      }

      const rawTokenCaption = (!noPermission && bucket?.tokenEstimate && typeof formatBucketTokenEstimateLine === 'function')
        ? formatBucketTokenEstimateLine(bucket.tokenEstimate, { poolKey: pool?.poolKey || null, pool })
        : '';
      const tokenCaption = qbStripParensForDisplay(rawTokenCaption);

      // 清理所有行级「同池共用」徽标，仅保留大写 5H/7D 周期标签与当前使用标记，内部 windowKey 沿用原协议
      const displayWindowTag = qbFormatWindowDisplayTag(windowTag);
      const badges = [{ label: displayWindowTag, shared: false }];
      if (isCurrentPool) {
        badges.push({ label: t('quota.current.tag'), shared: false, isCurrent: true });
      }

      return {
        id: rowId,
        paletteId,
        groupId,
        groupTitle,
        groupSubtitle,
        poolKey: pool?.poolKey || null,
        bucketId: bucket?.bucketId || null,
        windowKey: windowTag === '7d' ? 'weekly' : '5h',
        title,
        badges,
        pct,
        percentText,
        unknown,
        noPermission,
        hasResetTime,
        resetAtMs,
        remainSec,
        totalSec,
        resetAt,
        benchmarkPct,
        timeSummary,
        resetSubtext,
        tokenCaption,
        paceSuppressed
      };
    };

    const currentPoolKey = view?.currentModel?.poolKey || null;
    const geminiIsShared = Boolean((geminiPool?.models || []).length > 1);
    const sharedIsShared = sharedPool ? Boolean((sharedPool.models || []).length !== 1) : true;

    const items = [
      buildRowItem({
        rowId: 'gemini-7d',
        paletteId: 'gemini-7d',
        groupId: 'gemini',
        groupTitle: 'GEMINI',
        groupSubtitle: t('quota.board.geminiSub'),
        title: t('quota.board.gemini7dTitle'),
        windowTag: '7d',
        isShared: geminiIsShared,
        pool: geminiPool,
        bucket: findBucketByWindow(geminiPool, 'weekly'),
        defaultTotalSec: 7 * 86400,
        isCurrentPool: Boolean(geminiPool && currentPoolKey && geminiPool.poolKey === currentPoolKey)
      }),
      buildRowItem({
        rowId: 'gemini-5h',
        paletteId: 'gemini-5h',
        groupId: 'gemini',
        groupTitle: 'GEMINI',
        groupSubtitle: t('quota.board.geminiSub'),
        title: t('quota.board.gemini5hTitle'),
        windowTag: '5h',
        isShared: geminiIsShared,
        pool: geminiPool,
        bucket: findBucketByWindow(geminiPool, '5h'),
        defaultTotalSec: 5 * 3600,
        isCurrentPool: Boolean(geminiPool && currentPoolKey && geminiPool.poolKey === currentPoolKey)
      }),
      buildRowItem({
        rowId: 'shared-7d',
        paletteId: 'shared-7d',
        groupId: 'shared',
        groupTitle: t('quota.board.sharedGroupTitle'),
        groupSubtitle: t('quota.board.sharedSub'),
        title: t('quota.board.shared7dTitle'),
        windowTag: '7d',
        isShared: sharedIsShared,
        pool: sharedPool,
        bucket: findBucketByWindow(sharedPool, 'weekly'),
        defaultTotalSec: 7 * 86400,
        isCurrentPool: Boolean(sharedPool && currentPoolKey && sharedPool.poolKey === currentPoolKey)
      }),
      buildRowItem({
        rowId: 'shared-5h',
        paletteId: 'shared-5h',
        groupId: 'shared',
        groupTitle: t('quota.board.sharedGroupTitle'),
        groupSubtitle: t('quota.board.sharedSub'),
        title: t('quota.board.shared5hTitle'),
        windowTag: '5h',
        isShared: sharedIsShared,
        pool: sharedPool,
        bucket: findBucketByWindow(sharedPool, '5h'),
        defaultTotalSec: 5 * 3600,
        isCurrentPool: Boolean(sharedPool && currentPoolKey && sharedPool.poolKey === currentPoolKey)
      })
    ];

    // 其他真实独立池继续保留可查看，按真实池键与窗口挂载
    for (let epIdx = 0; epIdx < extraPools.length; epIdx++) {
      const ep = extraPools[epIdx];
      const epBuckets = Array.isArray(ep.buckets) && ep.buckets.length ? ep.buckets : [null];
      const epGroupId = `extra-${ep.poolKey || epIdx}`;
      const epTitle = qbStripParensForDisplay(ep.title || ep.poolKey || t('quota.board.extraGroupTitle'));
      const epIsShared = Boolean((ep.models || []).length > 1);
      const sortedBuckets = [...epBuckets].sort((a, b) => {
        const order = w => (w === 'weekly' ? 0 : (w === '5h' ? 1 : 2));
        return order(a?.windowKey) - order(b?.windowKey);
      });
      for (let bIdx = 0; bIdx < sortedBuckets.length; bIdx++) {
        const b = sortedBuckets[bIdx];
        const isWeekly = b?.windowKey === 'weekly' || b?.windowShort === '7d';
        const winTag = b?.windowShort || (isWeekly ? '7d' : (b?.windowKey === '5h' ? '5h' : '24h'));
        const rowId = `${epGroupId}-${b?.bucketId || b?.windowKey || bIdx}`;
        items.push(buildRowItem({
          rowId,
          paletteId: isWeekly ? 'gemini-7d' : 'gemini-5h',
          groupId: epGroupId,
          groupTitle: epTitle.toUpperCase(),
          groupSubtitle: t('quota.board.extraSub'),
          title: `${epTitle} · ${formatQuotaWindowTitle(b || { windowKey: isWeekly ? 'weekly' : '5h' })}`,
          windowTag: winTag,
          isShared: epIsShared,
          pool: ep,
          bucket: b,
          defaultTotalSec: isWeekly ? 7 * 86400 : 5 * 3600,
          isCurrentPool: Boolean(currentPoolKey && ep.poolKey === currentPoolKey)
        }));
      }
    }

    return { items, extraPools };
  }

  let qbInstanceCounter = 0;

  /**
   * 生产级 10.html 模型额度看板控制器
   * - 管理纯平双池四行 DOM 复用、色阶模式切换、1 秒实时倒计时对齐与三段式零残留动效状态机
   */
  function createQuotaBoardController(boardEl, options = {}) {
    const uidPrefix = String(++qbInstanceCounter);
    const onRefreshIconSpin = typeof options.onRefreshIconSpin === 'function' ? options.onRefreshIconSpin : () => {};
    const onHeaderSoftened = typeof options.onHeaderSoftened === 'function' ? options.onHeaderSoftened : () => {};
    const isReducedMotionFn = typeof options.isReducedMotion === 'function' ? options.isReducedMotion : () => false;

    const ctrlState = {
      colorMode: 'uniform', // 默认首开为 10.html 的「整条随档位变色」
      surfaceTone: resolveBoardSurfaceTone(boardEl),
      runId: 0,
      phase: 'idle', // idle | drain | scan | pause | refill
      activeRafs: new Set(),
      activeTimers: new Set(),
      rows: [],
      rowMap: new Map(),
      structureSig: '',
      timeline: [],
      pendingResolveSignal: null,
      refreshCycleActive: false,
      refreshCycleRunId: 0,
      refreshCycleGeneration: 0,
      preRefreshItems: null,
      drainDonePromise: null,
      scanWaiter: null
    };

    function resolveCurrentSurfaceTone(forceTone = null) {
      const nextTone = (forceTone === 'light' || forceTone === 'dark')
        ? forceTone
        : resolveBoardSurfaceTone(boardEl);
      ctrlState.surfaceTone = nextTone;
      boardEl?.setAttribute?.('data-surface-tone', nextTone);
      return nextTone;
    }

    function getSurfaceOpts() {
      return { boardEl, surface: ctrlState.surfaceTone, isLight: ctrlState.surfaceTone === 'light' };
    }

    const nowPerf = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

    function recordEvent(stage, extra = null) {
      const ev = { stage, ts: Date.now(), perfMs: Math.round(nowPerf()), ...(extra && typeof extra === 'object' ? extra : {}) };
      ctrlState.timeline.push(ev);
      if (ctrlState.timeline.length > 60) ctrlState.timeline.shift();
      return ev;
    }

    function applyTimingVars() {
      if (!boardEl?.style?.setProperty) return;
      const popMs = qbClamp(Math.round(160 / Math.sqrt(QB_PROD_SPEED)), 140, 320);
      const drainPopMs = qbClamp(Math.round(115 / Math.sqrt(QB_PROD_SPEED)), 95, 220);
      boardEl.style.setProperty('--pop-duration', `${popMs}ms`);
      boardEl.style.setProperty('--drain-pop-duration', `${drainPopMs}ms`);
    }

    function scheduleRaf(fn) {
      if (typeof requestAnimationFrame === 'function') {
        const id = requestAnimationFrame((now) => {
          ctrlState.activeRafs.delete(id);
          fn(Number.isFinite(now) ? now : nowPerf());
        });
        ctrlState.activeRafs.add(id);
        return id;
      }
      const tid = setTimeout(() => {
        ctrlState.activeTimers.delete(tid);
        fn(nowPerf());
      }, 16);
      ctrlState.activeTimers.add(tid);
      return tid;
    }

    function scheduleTimer(fn, ms) {
      const id = setTimeout(() => {
        ctrlState.activeTimers.delete(id);
        fn();
      }, Math.max(0, Math.round(ms)));
      ctrlState.activeTimers.add(id);
      return id;
    }

    function cancelAllAnimations() {
      if (typeof cancelAnimationFrame === 'function') {
        ctrlState.activeRafs.forEach((id) => cancelAnimationFrame(id));
      }
      ctrlState.activeRafs.clear();
      ctrlState.activeTimers.forEach((id) => clearTimeout(id));
      ctrlState.activeTimers.clear();
      ctrlState.scanWaiter = null;
    }

    function setDialsFetching(active) {
      const show = active && !isReducedMotionFn();
      for (const row of ctrlState.rows) {
        qbToggleClass(row.dial.wrapper, 'is-fetching', show);
      }
    }

    function clearCellClasses(cellObj) {
      if (!cellObj?.el?.classList) return;
      cellObj.el.classList.remove('anim-drain');
      cellObj.el.classList.remove('anim-ignite');
      cellObj.el.classList.remove('scan-peak');
      cellObj.el.classList.remove('scan-mid');
    }

    function setCellEmpty(cellObj, withDrainAnim) {
      clearCellClasses(cellObj);
      if (cellObj.fillEl?.style) {
        cellObj.fillEl.style.width = '0%';
        cellObj.fillEl.style.opacity = '0';
        cellObj.fillEl.style.backgroundColor = 'transparent';
      }
      cellObj.fillEl?.removeAttribute?.('data-cell-active');
      if (withDrainAnim && !isReducedMotionFn()) {
        try { void cellObj.el.offsetWidth; } catch { }
        cellObj.el.classList?.add?.('anim-drain');
      }
    }

    function setCellLit(cellObj, colorHex, ratio, withIgniteAnim) {
      clearCellClasses(cellObj);
      if (cellObj.fillEl?.style) {
        cellObj.fillEl.style.backgroundColor = colorHex;
        cellObj.fillEl.style.width = `${(qbClamp(ratio, 0, 1) * 100).toFixed(2)}%`;
        cellObj.fillEl.style.opacity = '1';
      }
      cellObj.fillEl?.setAttribute?.('data-cell-active', 'true');
      if (withIgniteAnim && !isReducedMotionFn()) {
        try { void cellObj.el.offsetWidth; } catch { }
        cellObj.el.classList?.add?.('anim-ignite');
      }
    }

    function clearRowScan(row) {
      for (let i = 0; i < QB_CELL_COUNT; i += 1) {
        row.cells[i].el.classList?.remove?.('scan-peak');
        row.cells[i].el.classList?.remove?.('scan-mid');
      }
    }

    function setRingAndPct(row, pctValue, colorSpec, opts = {}) {
      const isPending = Boolean(opts.isPending);
      const isUnknown = Boolean(colorSpec?.isUnknown);
      const isNoPerm = Boolean(colorSpec?.isNoPermission);

      if (isPending) {
        row.ringArc.setAttribute('stroke-dashoffset', QB_MINI_C.toFixed(3));
        if (row.ringArc.style) row.ringArc.style.stroke = 'transparent';
        row.pctEl.textContent = '--%';
        qbToggleClass(row.pctEl, 'is-pending', true);
        qbToggleClass(row.pctEl, 'is-red-alert', false);
        return;
      }

      if (isUnknown || isNoPerm || pctValue === null || pctValue === undefined || !Number.isFinite(Number(pctValue))) {
        row.ringArc.setAttribute('stroke-dashoffset', QB_MINI_C.toFixed(3));
        if (row.ringArc.style) row.ringArc.style.stroke = isNoPerm ? colorSpec.hex : 'transparent';
        row.pctEl.textContent = opts.percentText || (isNoPerm ? t('quota.short.no_permission') : t('quota.time.unknown'));
        qbToggleClass(row.pctEl, 'is-pending', true);
        qbToggleClass(row.pctEl, 'is-red-alert', false);
        return;
      }

      const clamped = qbClamp(Number(pctValue), 0, 100);
      const arcStroke = clamped <= 0.01 ? (colorSpec.isZero ? RED_ALERT_HEX : 'transparent') : colorSpec.hex;
      const offset = clamped <= 0.01 && colorSpec.isZero ? QB_MINI_C * 0.96 : QB_MINI_C * (1 - clamped / 100);

      row.ringArc.setAttribute('stroke-dashoffset', offset.toFixed(3));
      if (row.ringArc.style) row.ringArc.style.stroke = arcStroke;

      row.pctEl.textContent = opts.percentText || `${Math.round(clamped)}%`;
      qbToggleClass(row.pctEl, 'is-pending', false);
      qbToggleClass(row.pctEl, 'is-red-alert', Boolean(colorSpec.isRedAlert));
    }

    function renderPacingRailFrame(row, pct, bench, markerOpacity, colorSpec) {
      const spec = colorSpec || row.visualSpec;
      if (spec.isUnknown || spec.isNoPermission || bench === null || bench === undefined || !Number.isFinite(Number(bench))) {
        setPacingRailEmpty(row);
        row.pacingRailWrap.setAttribute('data-rail-empty', 'true');
        return;
      }
      row.pacingRailWrap.removeAttribute('data-rail-empty');
      const safePct = qbClamp(Number(pct) || 0, 0, 100);
      const safeBench = qbClamp(Number(bench), 0, 100);
      const baseEnd = Math.min(safePct, safeBench);
      const deltaWidth = Math.abs(safeBench - safePct);

      if (row.pacingBaseFill.style) {
        row.pacingBaseFill.style.width = `${baseEnd.toFixed(2)}%`;
        row.pacingBaseFill.style.backgroundColor = spec.baseRail;
        row.pacingBaseFill.style.opacity = baseEnd > 0.05 ? '1' : '0';
      }
      if (row.pacingDeltaFill.style) {
        row.pacingDeltaFill.style.left = `${baseEnd.toFixed(2)}%`;
        row.pacingDeltaFill.style.width = `${deltaWidth.toFixed(2)}%`;
        row.pacingDeltaFill.style.backgroundColor = spec.hex;
        row.pacingDeltaFill.style.opacity = deltaWidth > 0.05 ? '1' : '0';
      }
      if (row.pacingMarker.style) {
        row.pacingMarker.style.left = `${qbClamp(safeBench, 0.8, 99.6).toFixed(2)}%`;
        row.pacingMarker.style.opacity = String(qbClamp(markerOpacity, 0, 1));
      }
      row.visualBenchPct = safeBench;
    }

    function setPacingRailEmpty(row) {
      if (row.pacingBaseFill.style) {
        row.pacingBaseFill.style.width = '0%';
        row.pacingBaseFill.style.opacity = '0';
      }
      if (row.pacingDeltaFill.style) {
        row.pacingDeltaFill.style.left = '0%';
        row.pacingDeltaFill.style.width = '0%';
        row.pacingDeltaFill.style.opacity = '0';
      }
      if (row.pacingMarker.style) {
        row.pacingMarker.style.opacity = '0';
      }
      row.visualBenchPct = 0;
    }

    function setMetaSoftened(row, softened) {
      qbToggleClass(row.pacePillEl, 'is-softened', softened);
      qbToggleClass(row.subtextEl, 'is-softened', softened);
      qbToggleClass(row.timeSummaryEl, 'is-softened', softened);
      qbToggleClass(row.tokenCaptionEl, 'is-softened', softened);
    }

    function renderCircularDial(row, dialPct, remainSec, resetAt, colorSpec, opts = {}) {
      const spec = colorSpec || row.visualSpec || resolveDecileSpec(row.paletteId, row.committed?.pct, getSurfaceOpts());
      const d = row.dial;
      const isPendingDial = Boolean(opts.pending || remainSec === null || remainSec === undefined || !Number.isFinite(Number(remainSec)));

      d.stopStart.setAttribute('stop-color', spec.dialStart);
      d.stopEnd.setAttribute('stop-color', spec.dialEnd);
      d.orbital.setAttribute('stroke', spec.orbitalStroke);
      d.arc.setAttribute('stroke', `url(#${d.gradId})`);

      if (isPendingDial) {
        d.wrapper.setAttribute('data-dial-pending', 'true');
        d.arc.setAttribute('stroke-dashoffset', QB_DIAL_C.toFixed(3));
        if (d.tipDot.style) d.tipDot.style.opacity = '0';
        d.leftSpan.textContent = '--';
        d.rightSpan.textContent = '--';
        if (d.digits.style) d.digits.style.color = spec.digitColor;
        qbToggleClass(d.digits, 'is-three-digits', false);
        const pendingTip = spec.isNoPermission ? t('quota.state.no_permission') : t('quota.dial.pending');
        d.tooltip.textContent = pendingTip;
        d.wrapper.title = pendingTip;
        d.wrapper.setAttribute('aria-label', `${row.committed?.title || ''} ${pendingTip}`);
        row.dialVisualPct = 0;
        return;
      }

      d.wrapper.removeAttribute('data-dial-pending');
      const clamped = qbClamp(Number(dialPct) || 0, 0, 100);
      d.arc.setAttribute('stroke-dashoffset', (QB_DIAL_C * (1 - clamped / 100)).toFixed(3));

      if (clamped <= 0.5) {
        if (d.tipDot.style) d.tipDot.style.opacity = '0';
      } else {
        const rad = (clamped / 100) * 2 * Math.PI - Math.PI / 2;
        d.tipDot.setAttribute('cx', (QB_DIAL_CX + QB_DIAL_R * Math.cos(rad)).toFixed(2));
        d.tipDot.setAttribute('cy', (QB_DIAL_CY + QB_DIAL_R * Math.sin(rad)).toFixed(2));
        d.tipDot.setAttribute('fill', spec.tipDot);
        if (d.tipDot.style) d.tipDot.style.opacity = '1';
      }

      const { left, right, totalHours } = splitDialTotalHours(remainSec);
      d.leftSpan.textContent = left;
      d.rightSpan.textContent = right;
      if (d.digits.style) d.digits.style.color = spec.digitColor;
      qbToggleClass(d.digits, 'is-three-digits', totalHours >= 100);

      const remPct = Math.round(clamped);
      const tipStr = formatExactTotalHoursTooltip(remainSec, remPct, resetAt);
      d.tooltip.textContent = tipStr;
      d.wrapper.title = tipStr;
      d.wrapper.setAttribute('aria-label', `${row.committed?.title || ''} ${t('quota.dial.aria', { time: `${left}:${right}` })} · ${tipStr}`);
      row.dialVisualPct = clamped;
    }

    function applyRowMetaAndBadges(row, data, colorSpec) {
      const spec = colorSpec || resolveDecileSpec(row.paletteId, data.pct, { unknown: data.unknown, noPermission: data.noPermission, ...getSurfaceOpts() });

      row.titleEl.textContent = data.title || '';
      const badgeSig = (data.badges || []).map(b => `${b.label}:${b.isCurrent ? 1 : 0}`).join('|');
      if (row.badgeList.getAttribute('data-badge-sig') !== badgeSig) {
        row.badgeList.setAttribute('data-badge-sig', badgeSig);
        qbClearChildren(row.badgeList);
        for (const b of (data.badges || [])) {
          const cls = b.isCurrent ? 'micro-badge is-current' : 'micro-badge';
          row.badgeList.appendChild(qbCreateEl('span', cls, b.label));
        }
      }

      row.timeSummaryEl.textContent = data.timeSummary || '';
      row.subtextEl.textContent = data.resetSubtext || '';

      const paceLabel = qbComputePaceLabel(data.pct, data.benchmarkPct, {
        unknown: data.unknown,
        noPermission: data.noPermission
      });
      row.pacePillEl.textContent = paceLabel;
      if (row.pacePillEl.style) {
        row.pacePillEl.style.backgroundColor = spec.pillBg;
        row.pacePillEl.style.borderColor = spec.pillBorder;
        row.pacePillEl.style.color = spec.pillText;
      }

      if (data.tokenCaption) {
        row.tokenCaptionEl.textContent = data.tokenCaption;
        if (row.tokenCaptionEl.style) row.tokenCaptionEl.style.display = '';
        row.tokenCaptionEl.hidden = false;
      } else {
        row.tokenCaptionEl.textContent = '';
        if (row.tokenCaptionEl.style) row.tokenCaptionEl.style.display = 'none';
        row.tokenCaptionEl.hidden = true;
      }

      row.segGrid.setAttribute('aria-valuenow', data.pct === null ? '0' : String(Math.round(data.pct)));
      row.segGrid.setAttribute('aria-label', data.title || '');
      row.el.setAttribute('data-quota-state', data.noPermission ? 'no_permission' : (data.unknown ? 'unknown' : (spec.isRedAlert ? 'alert' : 'normal')));
      row.el.setAttribute('data-decile-step', String(spec.step));
      row.el.setAttribute('data-red-alert', spec.isRedAlert ? 'true' : 'false');
    }

    function renderRowStatic(row, data) {
      const surfaceOpts = getSurfaceOpts();
      const colorSpec = resolveDecileSpec(row.paletteId, data.pct, { unknown: data.unknown, noPermission: data.noPermission, ...surfaceOpts });
      const cellSpec = (data.unknown || data.noPermission) ? { activeCells: 0, fullCells: 0, tailRatio: 0 } : computeCellSpec(data.pct);

      row.pacingRailWrap.classList?.remove?.('is-animating-rail');

      for (let i = 0; i < QB_CELL_COUNT; i += 1) {
        if (i < cellSpec.activeCells) {
          const isTail = i === cellSpec.activeCells - 1 && cellSpec.fullCells < cellSpec.activeCells;
          const cellHex = resolveCellColor(row.paletteId, i, data.pct, ctrlState.colorMode, surfaceOpts);
          setCellLit(row.cells[i], cellHex, isTail ? cellSpec.tailRatio : 1, false);
        } else {
          setCellEmpty(row.cells[i], false);
        }
      }

      setRingAndPct(row, data.pct, colorSpec, { isPending: false, percentText: data.percentText });
      renderPacingRailFrame(row, data.pct, data.benchmarkPct, 1, colorSpec);
      applyRowMetaAndBadges(row, data, colorSpec);
      setMetaSoftened(row, false);

      row.liveRemainSec = data.remainSec;
      const dialPct = (data.hasResetTime && data.remainSec !== null && data.totalSec > 0)
        ? qbClamp((data.remainSec / data.totalSec) * 100, 0, 100)
        : 0;
      renderCircularDial(row, dialPct, data.remainSec, data.resetAt, colorSpec, { pending: !data.hasResetTime || data.noPermission });

      row.visualPct = data.pct === null ? 0 : data.pct;
      row.visualLitCount = cellSpec.activeCells;
      row.visualSpec = colorSpec;
      row.committed = { ...data };
    }

    function buildRowController(item) {
      const rowEl = qbCreateEl('article', 'quota-row');
      rowEl.setAttribute('data-row-id', item.id);
      if (item.poolKey) rowEl.setAttribute('data-pool-key', item.poolKey);
      if (item.windowKey) rowEl.setAttribute('data-window-key', item.windowKey);

      const main = qbCreateEl('div', 'row-main');

      const top = qbCreateEl('div', 'row-top');
      const titleWrap = qbCreateEl('div', 'row-title-wrap');
      const miniRing = buildMiniRingSvg();
      const titleEl = qbCreateEl('h2', 'row-title', item.title);
      const badgeList = qbCreateEl('span', 'badge-list');
      titleWrap.appendChild(miniRing.svg);
      titleWrap.appendChild(titleEl);
      titleWrap.appendChild(badgeList);

      const summary = qbCreateEl('div', 'row-summary');
      const pctEl = qbCreateEl('span', 'row-pct', '--%');
      const sepEl = qbCreateEl('span', 'row-sep', '·');
      const timeSummaryEl = qbCreateEl('span', 'row-time-summary', '');

      summary.appendChild(pctEl);
      summary.appendChild(sepEl);
      summary.appendChild(timeSummaryEl);

      top.appendChild(titleWrap);
      top.appendChild(summary);

      // 纯平单实体 20 格电池条 (彻底零底层彩条、零连续盖层、零光影残留)
      const segBarWrap = qbCreateEl('div', 'seg-bar-wrap');
      const segGrid = qbCreateEl('div', 'seg-grid');
      segGrid.setAttribute('role', 'progressbar');
      segGrid.setAttribute('aria-valuemin', '0');
      segGrid.setAttribute('aria-valuemax', '100');
      segGrid.setAttribute('aria-valuenow', '0');
      segGrid.setAttribute('aria-label', item.title || '');

      const cells = [];
      for (let i = 0; i < QB_CELL_COUNT; i += 1) {
        const cellEl = qbCreateEl('div', 'seg-cell');
        const fillEl = qbCreateEl('span', 'seg-fill');
        cellEl.appendChild(fillEl);
        segGrid.appendChild(cellEl);
        cells.push({ el: cellEl, fillEl });
      }
      segBarWrap.appendChild(segGrid);

      // 4px 双色时间基准轨 + 2x12 白游标
      const pacingRailWrap = qbCreateEl('div', 'pacing-rail-wrap');
      const pacingTrack = qbCreateEl('div', 'pacing-track');
      const pacingBaseFill = qbCreateEl('div', 'pacing-base-fill');
      const pacingDeltaFill = qbCreateEl('div', 'pacing-delta-fill');
      pacingTrack.appendChild(pacingBaseFill);
      pacingTrack.appendChild(pacingDeltaFill);
      const pacingMarker = qbCreateEl('div', 'pacing-marker');
      pacingRailWrap.appendChild(pacingTrack);
      pacingRailWrap.appendChild(pacingMarker);

      const metaLine = qbCreateEl('div', 'row-meta-line');
      const subtextEl = qbCreateEl('span', 'row-subtext', '');
      const pacePillEl = qbCreateEl('span', 'pace-pill', '');
      metaLine.appendChild(subtextEl);
      metaLine.appendChild(pacePillEl);

      const tokenCaptionEl = qbCreateEl('div', 'row-token-caption', '');
      if (tokenCaptionEl.style) tokenCaptionEl.style.display = 'none';
      tokenCaptionEl.hidden = true;

      main.appendChild(top);
      main.appendChild(segBarWrap);
      main.appendChild(pacingRailWrap);
      main.appendChild(metaLine);
      main.appendChild(tokenCaptionEl);

      const dial = buildCircularDial(uidPrefix, item.id, item.title);
      rowEl.appendChild(main);
      rowEl.appendChild(dial.zone);

      return {
        id: item.id,
        paletteId: item.paletteId,
        el: rowEl,
        titleEl,
        badgeList,
        ringArc: miniRing.arc,
        pctEl,
        timeSummaryEl,
        segGrid,
        pacingRailWrap,
        pacingBaseFill,
        pacingDeltaFill,
        pacingMarker,
        subtextEl,
        pacePillEl,
        tokenCaptionEl,
        cells,
        dial,
        committed: { ...item },
        visualPct: item.pct === null ? 0 : item.pct,
        visualBenchPct: item.benchmarkPct === null ? 0 : item.benchmarkPct,
        visualLitCount: 0,
        visualSpec: resolveDecileSpec(item.paletteId, item.pct, { unknown: item.unknown, noPermission: item.noPermission, ...getSurfaceOpts() }),
        dialVisualPct: 0,
        liveRemainSec: item.remainSec
      };
    }

    function ensureBoardStructure(items) {
      if (!boardEl) return;
      applyTimingVars();
      const sig = items.map(it => `${it.groupId}:${it.id}`).join('|');
      if (ctrlState.structureSig === sig && ctrlState.rows.length === items.length) {
        // 原地更新分组头三语文本 (语言切换时同步更新)
        let lastG = null;
        let gIdx = 0;
        const headers = [];
        for (const ch of Array.from(boardEl.children || [])) {
          if (String(ch.className || '').includes('group-header')) headers.push(ch);
        }
        for (const it of items) {
          if (it.groupId !== lastG) {
            const h = headers[gIdx++];
            if (h && h.children && h.children.length >= 2) {
              const titleSpan = h.children[0]?.children?.[1];
              if (titleSpan) titleSpan.textContent = it.groupTitle;
              h.children[1].textContent = it.groupSubtitle;
            }
            lastG = it.groupId;
          }
        }
        return;
      }

      qbClearChildren(boardEl);
      ctrlState.rows = [];
      ctrlState.rowMap.clear();
      ctrlState.structureSig = sig;

      let lastGroupId = null;
      for (const item of items) {
        if (item.groupId !== lastGroupId) {
          const header = qbCreateEl('div', 'group-header');
          header.setAttribute('data-group-id', item.groupId);
          const left = qbCreateEl('span', 'group-header-left');
          const dotCls = item.groupId === 'shared' ? 'group-dot is-shared' : 'group-dot is-gemini';
          const dot = qbCreateEl('span', dotCls);
          const titleText = qbCreateEl('span', '', item.groupTitle);
          left.appendChild(dot);
          left.appendChild(titleText);

          const sub = qbCreateEl('span', 'group-subtitle', item.groupSubtitle);
          header.appendChild(left);
          header.appendChild(sub);
          boardEl.appendChild(header);
          lastGroupId = item.groupId;
        }
        const rowCtrl = buildRowController(item);
        boardEl.appendChild(rowCtrl.el);
        ctrlState.rows.push(rowCtrl);
        ctrlState.rowMap.set(rowCtrl.id, rowCtrl);
      }
    }

    function animateDialsToTarget(runId, targetItems) {
      resolveCurrentSurfaceTone();
      const surfaceOpts = getSurfaceOpts();
      const snaps = ctrlState.rows.map((row, idx) => {
        const target = targetItems[idx] || row.committed;
        const targetSpec = resolveDecileSpec(row.paletteId, target.pct, { unknown: target.unknown, noPermission: target.noPermission, ...surfaceOpts });
        const hasReset = Boolean(target.hasResetTime && target.remainSec !== null && !target.noPermission);
        const toPct = hasReset ? qbClamp((target.remainSec / Math.max(1, target.totalSec)) * 100, 0, 100) : 0;
        return {
          row,
          target,
          hasReset,
          fromPct: row.dialVisualPct,
          toPct,
          fromSec: Number.isFinite(Number(row.liveRemainSec)) ? Number(row.liveRemainSec) : (hasReset ? target.remainSec : 0),
          toSec: hasReset ? target.remainSec : 0,
          resetAt: target.resetAt,
          targetSpec
        };
      });

      if (isReducedMotionFn()) {
        for (const s of snaps) {
          s.row.liveRemainSec = s.hasReset ? s.toSec : null;
          renderCircularDial(s.row, s.toPct, s.row.liveRemainSec, s.resetAt, s.targetSpec, { pending: !s.hasReset });
        }
        return;
      }

      const duration = 380 * Math.min(QB_PROD_SPEED_SCALE, 2.2);
      const startTime = nowPerf();

      function tick(now) {
        if (ctrlState.runId !== runId) return;
        const p = qbClamp((now - startTime) / duration, 0, 1);
        const eased = qbEaseOutCubic(p);

        for (const s of snaps) {
          if (!s.hasReset) {
            renderCircularDial(s.row, 0, null, null, s.targetSpec, { pending: true });
            continue;
          }
          const curPct = s.fromPct + (s.toPct - s.fromPct) * eased;
          const curSec = s.fromSec + (s.toSec - s.fromSec) * eased;
          renderCircularDial(s.row, curPct, curSec, s.resetAt, s.targetSpec, { pending: false });
        }

        if (p < 1) {
          scheduleRaf(tick);
        } else {
          for (const s of snaps) {
            s.row.liveRemainSec = s.hasReset ? s.toSec : null;
            renderCircularDial(s.row, s.toPct, s.row.liveRemainSec, s.resetAt, s.targetSpec, { pending: !s.hasReset });
            s.row.dial.wrapper.classList?.remove?.('dial-settle-pulse');
            try { void s.row.dial.wrapper.offsetWidth; } catch { }
            s.row.dial.wrapper.classList?.add?.('dial-settle-pulse');
          }
        }
      }

      scheduleRaf(tick);
    }

    // 阶段 1：退潮归零 (直接移植自 10.html runStage1Drain)
    function runStage1Drain(runId) {
      return new Promise((resolve) => {
        ctrlState.phase = 'drain';
        boardEl?.setAttribute?.('data-board-phase', 'drain');
        onHeaderSoftened(true);
        recordEvent('drain_start', { rowCount: ctrlState.rows.length });

        const k = QB_PROD_SPEED_SCALE;
        const configs = ctrlState.rows.map((row) => {
          setMetaSoftened(row, true);
          clearRowScan(row);
          row.pacingRailWrap.classList?.add?.('is-animating-rail');

          const startLit = row.visualLitCount;
          const startPct = row.visualPct;
          const startBench = row.visualBenchPct;
          const startSpec = row.visualSpec;

          let duration = 0;
          if (startLit > 0 || startBench > 0) {
            const effCells = Math.max(startLit, 8);
            const basePerCell = qbClamp(Math.round(180 / effCells), 8, 14);
            const baseTotal = qbClamp(effCells * basePerCell, 150, 210);
            duration = baseTotal * k;
          }
          return { row, startLit, startPct, startBench, startSpec, duration };
        });

        const maxDuration = Math.max(...configs.map(c => c.duration), 0);
        if (maxDuration <= 0) {
          for (const { row, startSpec } of configs) {
            for (let i = 0; i < QB_CELL_COUNT; i += 1) setCellEmpty(row.cells[i], false);
            setPacingRailEmpty(row);
            setRingAndPct(row, 0, { ...startSpec, isZero: false }, { isPending: false });
            row.visualLitCount = 0;
            row.visualPct = 0;
          }
          recordEvent('drain_complete', { durationMs: 0 });
          return resolve(true);
        }

        const startTime = nowPerf();
        function tick(now) {
          if (ctrlState.runId !== runId) return resolve(false);
          const elapsed = now - startTime;
          let allDone = true;

          for (const cfg of configs) {
            const { row, startLit, startPct, startBench, startSpec, duration } = cfg;
            if (duration <= 0) continue;
            const progress = qbClamp(elapsed / duration, 0, 1);
            if (progress < 1) allDone = false;

            const targetLit = progress >= 1 ? 0 : Math.ceil(startLit * (1 - progress));
            while (row.visualLitCount > targetLit) {
              row.visualLitCount -= 1;
              setCellEmpty(row.cells[row.visualLitCount], true);
            }

            const curPct = startPct * (1 - progress);
            const curBench = startBench * (1 - progress);
            const markerOp = Math.max(0, 1 - progress * 1.45);
            row.visualPct = curPct;
            setRingAndPct(row, curPct, { ...startSpec, isZero: false }, { isPending: false });
            renderPacingRailFrame(row, curPct, curBench, markerOp, startSpec);
          }

          if (!allDone) {
            scheduleRaf(tick);
          } else {
            for (const cfg of configs) {
              for (let i = 0; i < QB_CELL_COUNT; i += 1) setCellEmpty(cfg.row.cells[i], false);
              setPacingRailEmpty(cfg.row);
              cfg.row.visualLitCount = 0;
              cfg.row.visualPct = 0;
              setRingAndPct(cfg.row, 0, { ...cfg.startSpec, isZero: false }, { isPending: false });
            }
            recordEvent('drain_complete', { durationMs: Math.round(now - startTime) });
            resolve(true);
          }
        }

        scheduleRaf(tick);
      });
    }

    // 慢回包等待：纯中性灰单格扫描 + --% 待定 + 圆盘加载环 (直接移植自 10.html runPendingNetworkScan)
    function startPendingNetworkScan(runId) {
      ctrlState.phase = 'scan';
      boardEl?.setAttribute?.('data-board-phase', 'scan');
      setDialsFetching(true);
      recordEvent('scan_start');

      const sweepCycle = 740 * Math.min(QB_PROD_SPEED_SCALE, 1.8);
      const startTime = nowPerf();

      for (const row of ctrlState.rows) {
        setRingAndPct(row, 0, { hex: 'transparent', isZero: false }, { isPending: true });
        setPacingRailEmpty(row);
      }

      let stopped = false;
      function tick(now) {
        if (stopped || ctrlState.runId !== runId) {
          setDialsFetching(false);
          return;
        }
        const elapsed = Math.max(0, now - startTime);
        const cyclePos = (elapsed % sweepCycle) / sweepCycle;
        const headIdx = Math.floor(cyclePos * (QB_CELL_COUNT + 4)) - 2;

        for (const row of ctrlState.rows) {
          for (let i = 0; i < QB_CELL_COUNT; i += 1) {
            const cellEl = row.cells[i].el;
            cellEl.classList?.remove?.('scan-peak');
            cellEl.classList?.remove?.('scan-mid');
            if (i === headIdx) cellEl.classList?.add?.('scan-peak');
            else if (i === headIdx - 1 || i === headIdx + 1) cellEl.classList?.add?.('scan-mid');
          }
        }
        scheduleRaf(tick);
      }

      scheduleRaf(tick);
      return () => {
        if (stopped) return;
        stopped = true;
        setDialsFetching(false);
        for (const row of ctrlState.rows) {
          clearRowScan(row);
          setRingAndPct(row, 0, { hex: 'transparent', isZero: false }, { isPending: false });
        }
        recordEvent('scan_stop', { durationMs: Math.round(nowPerf() - startTime) });
      };
    }

    // 全空换气停顿 (直接移植自 10.html runEmptyBreathPause：60ms * speedScale = 200ms)
    function runEmptyBreathPause(runId) {
      return new Promise((resolve) => {
        ctrlState.phase = 'pause';
        boardEl?.setAttribute?.('data-board-phase', 'pause');
        const pauseMs = Math.round(60 * QB_PROD_SPEED_SCALE);
        recordEvent('pause_start', { pauseMs });
        scheduleTimer(() => {
          if (ctrlState.runId !== runId) return resolve(false);
          recordEvent('pause_complete');
          resolve(true);
        }, pauseMs);
      });
    }

    // 阶段 2 & 3：逐格机械上电 + 3 合 1 rAF 锁步 + 4px 基准轨重建 + 70px 圆盘落稳 (直接移植自 10.html runStage2Refill)
    function runStage2Refill(runId, targetItems, opts = {}) {
      return new Promise((resolve) => {
        ctrlState.phase = 'refill';
        boardEl?.setAttribute?.('data-board-phase', 'refill');
        recordEvent('refill_start', { reason: opts.reason || 'success', rowCount: targetItems.length });

        ensureBoardStructure(targetItems);
        resolveCurrentSurfaceTone();
        const surfaceOpts = getSurfaceOpts();
        animateDialsToTarget(runId, targetItems);

        const k = QB_PROD_SPEED_SCALE;
        const configs = ctrlState.rows.map((row, idx) => {
          const target = targetItems[idx] || row.committed;
          const colorSpec = resolveDecileSpec(row.paletteId, target.pct, { unknown: target.unknown, noPermission: target.noPermission, ...surfaceOpts });
          const cellSpec = (target.unknown || target.noPermission) ? { activeCells: 0, fullCells: 0, tailRatio: 0 } : computeCellSpec(target.pct);

          row.pacingRailWrap.classList?.add?.('is-animating-rail');

          let stepMs = 0;
          let syncDuration = 0;
          if (cellSpec.activeCells > 0) {
            stepMs = qbClamp(Math.round(380 / cellSpec.activeCells), 20, 42) * k;
            syncDuration = cellSpec.activeCells * stepMs;
          } else {
            syncDuration = 320 * k;
          }
          return { row, target, colorSpec, cellSpec, stepMs, syncDuration, metaRevealed: false };
        });

        const startTime = nowPerf();

        function tick(now) {
          if (ctrlState.runId !== runId) return resolve(false);
          const elapsed = Math.max(0, now - startTime);
          let allDone = true;

          for (const cfg of configs) {
            const { row, target, colorSpec, cellSpec, stepMs, syncDuration } = cfg;
            const progress = syncDuration > 0 ? qbClamp(elapsed / syncDuration, 0, 1) : 1;
            if (progress < 1) allDone = false;

            if (cellSpec.activeCells === 0) {
              const eased = qbEaseOutCubic(progress);
              const curBench = target.benchmarkPct === null ? null : target.benchmarkPct * eased;
              const markerOp = qbClamp((progress - 0.15) / 0.5, 0, 1);
              renderPacingRailFrame(row, 0, curBench, markerOp, colorSpec);
              if (!cfg.metaRevealed && progress >= 0.82) {
                setRingAndPct(row, target.pct, colorSpec, { isPending: false, percentText: target.percentText });
                applyRowMetaAndBadges(row, target, colorSpec);
                setMetaSoftened(row, false);
                row.visualSpec = colorSpec;
                row.committed = { ...target };
                cfg.metaRevealed = true;
              }
              continue;
            }

            const expectedLit = progress >= 1
              ? cellSpec.activeCells
              : qbClamp(Math.floor(elapsed / stepMs) + 1, 0, cellSpec.activeCells);

            while (row.visualLitCount < expectedLit) {
              const idx = row.visualLitCount;
              const isTail = idx === cellSpec.activeCells - 1 && cellSpec.fullCells < cellSpec.activeCells;
              const cellHex = resolveCellColor(row.paletteId, idx, target.pct, ctrlState.colorMode, surfaceOpts);
              setCellLit(row.cells[idx], cellHex, isTail ? cellSpec.tailRatio : 1, true);
              row.visualLitCount += 1;
            }

            const curPct = progress >= 1 ? target.pct : target.pct * progress;
            const curBench = target.benchmarkPct === null
              ? null
              : (progress >= 1 ? target.benchmarkPct : target.benchmarkPct * qbEaseOutCubic(progress));
            const markerOp = qbClamp((progress - 0.12) / 0.48, 0, 1);

            row.visualPct = curPct;
            row.visualSpec = colorSpec;
            setRingAndPct(row, curPct, colorSpec, {
              isPending: false,
              percentText: progress >= 1 ? target.percentText : `${Math.round(curPct)}%`
            });
            renderPacingRailFrame(row, curPct, curBench, markerOp, colorSpec);

            if (!cfg.metaRevealed && progress >= 0.82) {
              applyRowMetaAndBadges(row, target, colorSpec);
              setMetaSoftened(row, false);
              cfg.metaRevealed = true;
            }
          }

          if (!allDone) {
            scheduleRaf(tick);
          } else {
            for (const cfg of configs) {
              const { row, target, colorSpec, cellSpec } = cfg;
              row.pacingRailWrap.classList?.remove?.('is-animating-rail');
              renderPacingRailFrame(row, target.pct, target.benchmarkPct, 1, colorSpec);
              applyRowMetaAndBadges(row, target, colorSpec);
              setMetaSoftened(row, false);
              setRingAndPct(row, target.pct, colorSpec, { isPending: false, percentText: target.percentText });
              row.visualPct = target.pct === null ? 0 : target.pct;
              row.visualLitCount = cellSpec.activeCells;
              row.visualSpec = colorSpec;
              row.committed = { ...target };
            }
            onHeaderSoftened(false);
            ctrlState.phase = 'idle';
            boardEl?.removeAttribute?.('data-board-phase');
            recordEvent('refill_complete', { durationMs: Math.round(now - startTime) });
            resolve(true);
          }
        }

        scheduleRaf(tick);
      });
    }

    /**
     * 静态原地同步（用于首屏、后台静默轮询、色阶模式切换、语言/主题切换）
     * 当手动刷新动画正在进行时，不会破坏正在播放的退潮/扫描/回充画面
     */
    function syncStatic(items, opts = {}) {
      if (!boardEl || !Array.isArray(items)) return;
      resolveCurrentSurfaceTone(opts.surfaceTone || null);
      if (ctrlState.refreshCycleActive && opts.forceStatic !== true) {
        return;
      }
      ensureBoardStructure(items);
      for (let i = 0; i < ctrlState.rows.length; i += 1) {
        renderRowStatic(ctrlState.rows[i], items[i]);
      }
    }

    /**
     * 实时 1 秒倒计时对齐（直接基于真实 resetAtMs - nowMs，绝无独立时钟漂移）
     */
    function tickLiveCountdowns(nowMs = Date.now()) {
      if (!ctrlState.rows.length) return;
      for (const row of ctrlState.rows) {
        const c = row.committed;
        if (!c || !c.hasResetTime || !Number.isFinite(Number(c.resetAtMs)) || c.noPermission) continue;
        const remainSec = Math.max(0, Math.floor((Number(c.resetAtMs) - nowMs) / 1000));
        row.liveRemainSec = remainSec;
        const dialPct = qbClamp((remainSec / Math.max(1, c.totalSec)) * 100, 0, 100);
        if (ctrlState.activeRafs.size === 0 && !ctrlState.refreshCycleActive) {
          renderCircularDial(row, dialPct, remainSec, c.resetAt, row.visualSpec, { pending: false });
        } else {
          const { left, right, totalHours } = splitDialTotalHours(remainSec);
          row.dial.leftSpan.textContent = left;
          row.dial.rightSpan.textContent = right;
          qbToggleClass(row.dial.digits, 'is-three-digits', totalHours >= 100);
        }
      }
    }

    /**
     * 开始一轮手动刷新展示层动效（并行执行 Stage 1 退潮；退潮后若真实回包未到自动进中性灰扫描）
     */
    function beginManualRefreshCycle(generation, fallbackItems) {
      ctrlState.runId += 1;
      const myRunId = ctrlState.runId;
      cancelAllAnimations();
      setDialsFetching(false);
      ctrlState.timeline = [];
      ctrlState.refreshCycleActive = true;
      ctrlState.refreshCycleRunId = myRunId;
      ctrlState.refreshCycleGeneration = generation;
      ctrlState.preRefreshItems = ctrlState.rows.length
        ? ctrlState.rows.map(r => ({ ...r.committed }))
        : (Array.isArray(fallbackItems) ? fallbackItems.map(it => ({ ...it })) : null);

      if (isReducedMotionFn() || !ctrlState.rows.length) {
        onRefreshIconSpin(true);
        ctrlState.drainDonePromise = Promise.resolve(true);
        return myRunId;
      }

      onRefreshIconSpin(true);
      let stopScanFn = null;
      let resolvedEarly = false;

      ctrlState.scanWaiter = {
        runId: myRunId,
        markRpcArrived() {
          resolvedEarly = true;
          if (typeof stopScanFn === 'function') {
            stopScanFn();
            stopScanFn = null;
          }
        }
      };

      ctrlState.drainDonePromise = runStage1Drain(myRunId).then((drained) => {
        if (!drained || ctrlState.runId !== myRunId) return false;
        if (!resolvedEarly && ctrlState.refreshCycleActive && ctrlState.refreshCycleRunId === myRunId) {
          stopScanFn = startPendingNetworkScan(myRunId);
        }
        return true;
      });

      return myRunId;
    }

    /**
     * 真实回包落定后收尾刷新动效（成功则回充新数据并在落稳后回调 onSettled；失败/仅缓存则回充恢复最后可信快照）
     */
    async function completeManualRefreshCycle(runId, targetItems, opts = {}) {
      const { kind = 'success', onSettled = null, skipPause = false } = opts;
      if (ctrlState.runId !== runId) return false;

      if (ctrlState.scanWaiter && ctrlState.scanWaiter.runId === runId) {
        ctrlState.scanWaiter.markRpcArrived();
      }

      const itemsToApply = (Array.isArray(targetItems) && targetItems.length)
        ? targetItems
        : ctrlState.preRefreshItems;

      if (isReducedMotionFn()) {
        ctrlState.refreshCycleActive = false;
        onRefreshIconSpin(false);
        onHeaderSoftened(false);
        if (itemsToApply) syncStatic(itemsToApply, { forceStatic: true });
        ctrlState.phase = 'idle';
        boardEl?.removeAttribute?.('data-board-phase');
        recordEvent('settled', { kind, reducedMotion: true });
        if (typeof onSettled === 'function') onSettled();
        return true;
      }

      if (ctrlState.drainDonePromise) {
        const drained = await ctrlState.drainDonePromise;
        if (!drained || ctrlState.runId !== runId) return false;
      }

      if (ctrlState.scanWaiter && ctrlState.scanWaiter.runId === runId) {
        ctrlState.scanWaiter.markRpcArrived();
      }

      if (!skipPause) {
        const paused = await runEmptyBreathPause(runId);
        if (!paused || ctrlState.runId !== runId) return false;
      }

      if (itemsToApply && itemsToApply.length) {
        const refilled = await runStage2Refill(runId, itemsToApply, { reason: kind });
        if (!refilled || ctrlState.runId !== runId) return false;
      }

      ctrlState.refreshCycleActive = false;
      onRefreshIconSpin(false);
      onHeaderSoftened(false);
      ctrlState.phase = 'idle';
      boardEl?.removeAttribute?.('data-board-phase');
      recordEvent('settled', { kind });
      if (typeof onSettled === 'function') onSettled();
      return true;
    }

    function abortManualRefreshCycle(restoreItems = null) {
      ctrlState.runId += 1;
      cancelAllAnimations();
      setDialsFetching(false);
      ctrlState.refreshCycleActive = false;
      ctrlState.phase = 'idle';
      boardEl?.removeAttribute?.('data-board-phase');
      onRefreshIconSpin(false);
      onHeaderSoftened(false);
      const toRestore = (Array.isArray(restoreItems) && restoreItems.length)
        ? restoreItems
        : ctrlState.preRefreshItems;
      if (toRestore && toRestore.length) {
        syncStatic(toRestore, { forceStatic: true });
      }
    }

    function setColorMode(mode) {
      const next = mode === 'progressive' ? 'progressive' : 'uniform';
      ctrlState.colorMode = next;
      boardEl?.setAttribute?.('data-color-mode', next);
      resolveCurrentSurfaceTone();
      if (!ctrlState.refreshCycleActive && ctrlState.rows.length) {
        for (const row of ctrlState.rows) {
          renderRowStatic(row, { ...row.committed, remainSec: row.liveRemainSec });
        }
      }
      return next;
    }

    function syncSurfaceTone(forceTone = null) {
      const nextTone = resolveCurrentSurfaceTone(forceTone);
      if (!ctrlState.refreshCycleActive && ctrlState.rows.length) {
        for (const row of ctrlState.rows) {
          renderRowStatic(row, { ...row.committed, remainSec: row.liveRemainSec });
        }
      }
      return nextTone;
    }

    function destroy() {
      ctrlState.runId += 1;
      cancelAllAnimations();
      setDialsFetching(false);
      ctrlState.refreshCycleActive = false;
      ctrlState.phase = 'idle';
      ctrlState.rows = [];
      ctrlState.rowMap.clear();
      ctrlState.structureSig = '';
    }

    function getDebugState() {
      return {
        colorMode: ctrlState.colorMode,
        surfaceTone: ctrlState.surfaceTone,
        phase: ctrlState.phase,
        runId: ctrlState.runId,
        refreshCycleActive: ctrlState.refreshCycleActive,
        activeRafCount: ctrlState.activeRafs.size,
        activeTimerCount: ctrlState.activeTimers.size,
        timeline: [...ctrlState.timeline],
        rows: ctrlState.rows.map(r => ({
          id: r.id,
          paletteId: r.paletteId,
          poolKey: r.committed?.poolKey || null,
          windowKey: r.committed?.windowKey || null,
          pct: r.committed?.pct ?? null,
          visualPct: r.visualPct,
          visualLitCount: r.visualLitCount,
          visualBenchPct: r.visualBenchPct,
          decileStep: r.visualSpec?.step ?? 0,
          isRedAlert: Boolean(r.visualSpec?.isRedAlert),
          isUnknown: Boolean(r.visualSpec?.isUnknown),
          isNoPermission: Boolean(r.visualSpec?.isNoPermission),
          colorHex: r.visualSpec?.hex || null,
          rawColorHex: r.visualSpec?.rawHex || r.visualSpec?.hex || null,
          cellColors: r.cells.slice(0, r.visualLitCount).map(c => c.fillEl?.style?.backgroundColor || null),
          dialText: `${r.dial.leftSpan.textContent}:${r.dial.rightSpan.textContent}`,
          dialThreeDigits: Boolean(r.dial.digits.classList?.contains?.('is-three-digits')),
          dialPending: r.dial.wrapper.getAttribute('data-dial-pending') === 'true',
          pctText: r.pctEl.textContent,
          timeSummary: r.timeSummaryEl.textContent,
          subtext: r.subtextEl.textContent,
          tokenCaption: r.tokenCaptionEl.textContent,
          badges: Array.from(r.badgeList?.children || []).map(b => b.textContent),
          pacePillText: r.pacePillEl.textContent
        }))
      };
    }

    return {
      syncStatic,
      syncSurfaceTone,
      refreshTheme: () => syncSurfaceTone(),
      tickLiveCountdowns,
      beginManualRefreshCycle,
      completeManualRefreshCycle,
      abortManualRefreshCycle,
      setColorMode,
      getColorMode: () => ctrlState.colorMode,
      getSurfaceTone: () => ctrlState.surfaceTone,
      isAnimating: () => ctrlState.refreshCycleActive,
      destroy,
      getDebugState
    };
  }
