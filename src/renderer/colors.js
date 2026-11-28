// =========================================================================
// 模块 1: 0 级主题跟随、面板与菜单统一背景色、热力图 5 档色阶与自定义颜色选取器
// =========================================================================
const COLOR_SLOTS = {
  panelBg: '--ag-custom-panel-bg',
  ringUsed: '--ag-custom-ring-used',
  ringTrack: '--ag-custom-ring-track',
  contextText: '--ag-custom-context-text',
  speedText: '--ag-custom-speed',
  tokenTotal: '--ag-custom-token-total',
  tokenAccent: '--ag-custom-token-accent',
  heatLow: '--ag-custom-heat-low',
  heatHigh: '--ag-custom-heat-high',
  heatLvl0: '--ag-custom-heat-lvl-0',
  heatLvl1: '--ag-custom-heat-lvl-1',
  heatLvl2: '--ag-custom-heat-lvl-2',
  heatLvl3: '--ag-custom-heat-lvl-3',
  heatLvl4: '--ag-custom-heat-lvl-4'
};
const COLOR_STORAGE_KEY = 'ag_custom_colors_v1';
const HEAT_PRESET_STORAGE_KEY = 'ag_heat_preset_v1';
const customColors = {
  panelBg: '',
  ringUsed: '',
  ringTrack: '',
  contextText: '',
  speedText: '',
  tokenTotal: '',
  tokenAccent: '',
  heatLow: '',
  heatHigh: '',
  heatLvl0: '',
  heatLvl1: '',
  heatLvl2: '',
  heatLvl3: '',
  heatLvl4: ''
};
let heatPreset = 'blue';

const HEAT_PRESETS = {
  blue: {
    dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
    light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a']
  },
  purple: {
    dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
    light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a']
  },
  yellow: {
    dark: ['#27272a', '#713f12', '#a16207', '#eab308', '#fde047'],
    light: ['#e4e4e7', '#fef08a', '#facc15', '#ca8a04', '#854d0e']
  },
  green: {
    dark: ['#27272a', '#14532d', '#15803d', '#22c55e', '#86efac'],
    light: ['#e4e4e7', '#bbf7d0', '#4ade80', '#16a34a', '#14532d']
  },
  red: {
    dark: ['#27272a', '#7f1d1d', '#b91c1c', '#ef4444', '#fca5a5'],
    light: ['#e4e4e7', '#fecaca', '#f87171', '#dc2626', '#7f1d1d']
  }
};

try {
  const rawColors = typeof localStorage !== 'undefined' && localStorage.getItem(COLOR_STORAGE_KEY);
  if (rawColors) {
    const parsed = JSON.parse(rawColors);
    for (const k of Object.keys(COLOR_SLOTS)) {
      if (typeof parsed?.[k] === 'string') customColors[k] = parsed[k];
    }
    if (typeof parsed?.heatPreset === 'string' && HEAT_PRESETS[parsed.heatPreset]) {
      heatPreset = parsed.heatPreset;
    }
  }
  const savedPreset = typeof localStorage !== 'undefined' && localStorage.getItem(HEAT_PRESET_STORAGE_KEY);
  if (savedPreset && HEAT_PRESETS[savedPreset]) heatPreset = savedPreset;
} catch { }

function saveCustomColors() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify({ ...customColors, heatPreset }));
      localStorage.setItem(HEAT_PRESET_STORAGE_KEY, heatPreset);
    }
  } catch { }
}

function restoreAppearancePreferences(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  if (prefs.customColors && typeof prefs.customColors === 'object') {
    for (const key of Object.keys(COLOR_SLOTS)) customColors[key] = normalizeHex(prefs.customColors[key]) || '';
    if (HEAT_PRESETS[prefs.heatPreset]) heatPreset = prefs.heatPreset;
    applyCustomColors();
  }
  if (['auto', 'light', 'dark'].includes(prefs.themeMode) && prefs.themeMode !== currentThemeMode) {
    currentThemeMode = prefs.themeMode;
    applyTheme();
  }
}

// 色彩空间转换与格式化工具（HEX <-> RGB <-> HSV <-> HSL）
function clampNum(n, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function rgbToHex(r, g, b) {
  const to2 = v => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function hexToRgb(hexStr) {
  if (!hexStr || typeof hexStr !== 'string') return null;
  const clean = hexStr.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(clean)) return null;
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function hslToRgb(h, s, l) {
  const hn = ((Number(h) % 360) + 360) % 360;
  const sn = clampNum(Number(s), 0, 100) / 100;
  const ln = clampNum(Number(l), 0, 100) / 100;
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
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

function splitTopLevelCssArgs(expr) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function evalColorMixSrgb(input) {
  const m = String(input || '').trim().match(/^color-mix\(\s*in\s+srgb\s*,\s*([\s\S]+)\)$/i);
  if (!m) return null;
  const args = splitTopLevelCssArgs(m[1]);
  if (args.length !== 2) return null;
  const parseStop = (part) => {
    const pctMatch = part.match(/\s+([\d.]+)%\s*$/);
    const pct = pctMatch ? Number(pctMatch[1]) : null;
    const colorExpr = pctMatch ? part.slice(0, pctMatch.index).trim() : part.trim();
    const hex = normalizeHex(colorExpr);
    const rgb = hex ? hexToRgb(hex) : null;
    return rgb ? { rgb, pct } : null;
  };
  const s1 = parseStop(args[0]);
  const s2 = parseStop(args[1]);
  if (!s1 || !s2) return null;
  let w1 = s1.pct;
  let w2 = s2.pct;
  if (w1 == null && w2 == null) { w1 = 50; w2 = 50; }
  else if (w1 != null && w2 == null) { w2 = 100 - w1; }
  else if (w1 == null && w2 != null) { w1 = 100 - w2; }
  const sum = w1 + w2;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  const p1 = w1 / sum;
  const p2 = w2 / sum;
  return rgbToHex(
    s1.rgb.r * p1 + s2.rgb.r * p2,
    s1.rgb.g * p1 + s2.rgb.g * p2,
    s1.rgb.b * p1 + s2.rgb.b * p2
  );
}

function normalizeHex(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || /^transparent$/i.test(s)) return null;
  const direct = hexToRgb(s);
  if (direct) return rgbToHex(direct.r, direct.g, direct.b);
  if (/^color-mix\(/i.test(s)) {
    const mixed = evalColorMixSrgb(s);
    if (mixed) return mixed;
  }
  const mColorSrgb = s.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
  if (mColorSrgb) {
    if (mColorSrgb[4] !== undefined) {
      const alphaRaw = mColorSrgb[4].endsWith('%') ? Number(mColorSrgb[4].slice(0, -1)) / 100 : Number(mColorSrgb[4]);
      if (!Number.isNaN(alphaRaw) && alphaRaw <= 0.01) return null;
    }
    return rgbToHex(Number(mColorSrgb[1]) * 255, Number(mColorSrgb[2]) * 255, Number(mColorSrgb[3]) * 255);
  }
  const mRgb = s.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
  if (mRgb) {
    if (mRgb[4] !== undefined) {
      const alphaRaw = mRgb[4].endsWith('%') ? Number(mRgb[4].slice(0, -1)) / 100 : Number(mRgb[4]);
      if (!Number.isNaN(alphaRaw) && alphaRaw <= 0.01) return null;
    }
    return rgbToHex(Number(mRgb[1]), Number(mRgb[2]), Number(mRgb[3]));
  }
  const mHsl = s.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*[,/]\s*([\d.]+%?))?/i);
  if (mHsl) {
    if (mHsl[4] !== undefined) {
      const alphaRaw = mHsl[4].endsWith('%') ? Number(mHsl[4].slice(0, -1)) / 100 : Number(mHsl[4]);
      if (!Number.isNaN(alphaRaw) && alphaRaw <= 0.01) return null;
    }
    const rgb = hslToRgb(Number(mHsl[1]), Number(mHsl[2]), Number(mHsl[3]));
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }
  return null;
}

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
}

function hsvToRgb(h, s, v) {
  const hn = ((Number(h) % 360) + 360) % 360;
  const sn = clampNum(Number(s), 0, 100) / 100;
  const vn = clampNum(Number(v), 0, 100) / 100;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vn - c;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hn < 60) { r1 = c; g1 = x; }
  else if (hn < 120) { r1 = x; g1 = c; }
  else if (hn < 180) { g1 = c; b1 = x; }
  else if (hn < 240) { g1 = x; b1 = c; }
  else if (hn < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function interpolateHex(hexA, hexB, t) {
  const a = hexToRgb(hexA) || { r: 39, g: 39, b: 42 };
  const b = hexToRgb(hexB) || { r: 50, g: 116, b: 246 };
  const ratio = clampNum(t, 0, 1);
  return rgbToHex(
    a.r + (b.r - a.r) * ratio,
    a.g + (b.g - a.g) * ratio,
    a.b + (b.b - a.b) * ratio
  );
}

let currentThemeMode = 'auto';
try {
  currentThemeMode = (typeof localStorage !== 'undefined' && localStorage.getItem('ag_theme_mode')) || 'auto';
} catch { }

function parseRgbLuminance(colorStr) {
  if (!colorStr || typeof colorStr !== 'string') return null;
  const rgb = hexToRgb(normalizeHex(colorStr));
  if (rgb) return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return null;
}

function getHostZeroLevelBg(isLight) {
  const fallback = isLight ? '#ffffff' : '#181818';
  try {
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const rootEl = document.body || document.documentElement;
      if (rootEl) {
        const cs = window.getComputedStyle(rootEl);
        const candidates = [
          cs.getPropertyValue('--background')?.trim(),
          cs.backgroundColor?.trim()
        ].filter(Boolean);
        for (const raw of candidates) {
          const norm = normalizeHex(raw);
          if (!norm) continue;
          const lum = parseRgbLuminance(norm);
          const normIsLight = lum != null ? lum > 0.55 : Boolean(isLight);
          if (normIsLight === Boolean(isLight)) return norm;
          return fallback;
        }
      }
    }
  } catch { }
  return fallback;
}

function getSystemTheme() {
  try {
    const body = document.body;
    const doc = document.documentElement;
    if (body?.classList?.contains('theme-light') || body?.classList?.contains('light') || doc?.classList?.contains('light') || body?.classList?.contains('vscode-light')) return 'light';
    if (body?.classList?.contains('theme-dark') || body?.classList?.contains('dark') || doc?.classList?.contains('dark') || body?.classList?.contains('vscode-dark')) return 'dark';
    if (doc?.style?.colorScheme === 'light') return 'light';
    if (doc?.style?.colorScheme === 'dark') return 'dark';
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && (body || doc)) {
      const cs = window.getComputedStyle(body || doc);
      const bgVar = cs.getPropertyValue('--background') || cs.backgroundColor;
      const lum = parseRgbLuminance(bgVar);
      if (lum != null) return lum > 0.55 ? 'light' : 'dark';
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    }
  } catch { }
  return 'dark';
}

function resolveTheme() {
  if (currentThemeMode === 'light') return 'light';
  if (currentThemeMode === 'dark') return 'dark';
  return getSystemTheme();
}

function getPresetHeatmapScale() {
  const isLight = resolveTheme() === 'light';
  const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.blue;
  return (isLight ? presetObj.light : presetObj.dark).slice();
}

function getBaseHeatmapScale() {
  const base = getPresetHeatmapScale();
  const lowCustom = normalizeHex(customColors.heatLow);
  const highCustom = normalizeHex(customColors.heatHigh);
  if (lowCustom || highCustom) {
    const c0 = lowCustom || base[0];
    const c4 = highCustom || base[4];
    return [
      c0,
      interpolateHex(c0, c4, 0.25),
      interpolateHex(c0, c4, 0.5),
      interpolateHex(c0, c4, 0.75),
      c4
    ];
  }
  return base;
}

function getEffectiveHeatmapScale() {
  const scale = getBaseHeatmapScale();
  for (let i = 0; i < 5; i++) {
    const lvlCustom = normalizeHex(customColors[`heatLvl${i}`]);
    if (lvlCustom) scale[i] = lvlCustom;
  }
  return scale;
}

function getDefaultSlotColor(slotKey) {
  const isLight = resolveTheme() === 'light';
  const presetScale = getPresetHeatmapScale();
  const baseScale = getBaseHeatmapScale();
  switch (slotKey) {
    case 'panelBg': return getHostZeroLevelBg(isLight);
    case 'ringUsed': return isLight ? '#18181b' : '#e6e6eb';
    case 'ringTrack': return isLight ? '#b8b8c2' : '#52525b';
    case 'contextText': return isLight ? '#18181b' : '#ececef';
    case 'speedText': return isLight ? '#0284c7' : '#38bdf8';
    case 'tokenTotal': return resolveHostAccentColor() || (isLight ? '#1d4ed8' : '#60a5fa');
    case 'tokenAccent': return resolveHostAccentColor() || (isLight ? '#2563eb' : '#60a5fa');
    case 'heatLow': return presetScale[0];
    case 'heatHigh': return presetScale[4];
    case 'heatLvl0': return baseScale[0];
    case 'heatLvl1': return baseScale[1];
    case 'heatLvl2': return baseScale[2];
    case 'heatLvl3': return baseScale[3];
    case 'heatLvl4': return baseScale[4];
    default: return resolveHostAccentColor() || '#3274f6';
  }
}

function getEffectiveSlotColor(slotKey) {
  return normalizeHex(customColors[slotKey]) || getDefaultSlotColor(slotKey);
}

function applyHeatmapPalette() {
  const scale = getEffectiveHeatmapScale();
  for (let i = 0; i < 5; i++) {
    host.style.setProperty(`--ag-heat-lvl-${i}`, scale[i]);
    const legEl = el(`heat-leg-${i}`);
    if (legEl) {
      legEl.style.background = scale[i];
      legEl.style.setProperty('--swatch-color', scale[i]);
      legEl.setAttribute('data-custom', String(Boolean(customColors[`heatLvl${i}`])));
    }
  }
  const hasCustomHeat = Boolean(
    customColors.heatLow || customColors.heatHigh ||
    customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4
  );
  try {
    const group = el('heat-preset-group');
    if (group?.querySelectorAll) {
      const btns = group.querySelectorAll('[data-heat-preset]');
      for (const btn of btns) {
        const pName = btn.getAttribute('data-heat-preset');
        btn.setAttribute('data-active', String(!hasCustomHeat && pName === heatPreset));
      }
    }
  } catch { }
}

function syncSwatchAndResetButtons() {
  for (const key of Object.keys(COLOR_SLOTS)) {
    const val = customColors[key];
    const eff = getEffectiveSlotColor(key);
    const inputEl = el(`color-${key}`);
    if (inputEl) inputEl.value = eff;
    const swatchEl = el(`swatch-${key}`);
    if (swatchEl) {
      swatchEl.style.setProperty('--swatch-color', eff);
      swatchEl.style.background = eff;
    }
    const resetBtn = el(`reset-${key}`);
    if (resetBtn) {
      resetBtn.setAttribute('data-mode', val ? 'custom' : 'auto');
      if (key.startsWith('heatLvl')) {
        resetBtn.textContent = val ? t('colors.btn.restore') : t('colors.btn.preset');
      } else if (key === 'heatLow' || key === 'heatHigh') {
        resetBtn.textContent = val ? t('colors.btn.restorePreset') : t('colors.btn.preset');
      } else {
        resetBtn.textContent = val ? t('colors.btn.restoreDefault') : t('cp.followTheme');
      }
    }
  }
  const resetHeatLvlsBtn = el('reset-heat-lvls');
  if (resetHeatLvlsBtn) {
    const anyHeatLvl = Boolean(
      customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4 ||
      customColors.heatLow || customColors.heatHigh
    );
    resetHeatLvlsBtn.setAttribute('data-mode', anyHeatLvl ? 'custom' : 'auto');
  }
  // 面板 A 中的镜像色块按钮同步
  const mirrorMap = {
    'swatch-panelBg-tokens': 'panelBg',
    'swatch-tokenTotal-tokens': 'tokenTotal',
    'swatch-tokenAccent-tokens': 'tokenAccent'
  };
  for (const [id, slot] of Object.entries(mirrorMap)) {
    const sw = el(id);
    if (sw) {
      const eff = getEffectiveSlotColor(slot);
      sw.style.setProperty('--swatch-color', eff);
      sw.style.background = eff;
    }
  }
  const resetBgTokens = el('reset-panelBg-tokens');
  if (resetBgTokens) {
    const hasBg = Boolean(customColors.panelBg);
    resetBgTokens.setAttribute('data-mode', hasBg ? 'custom' : 'auto');
    resetBgTokens.textContent = hasBg ? t('colors.btn.restoreDefault') : t('cp.followTheme');
  }
}

function getContinuousScaleStops() {
  const scale = getEffectiveHeatmapScale();
  return [scale[1], scale[2], scale[3], scale[4]].filter(Boolean);
}

function getContinuousHeatColor(value, modeOrAnchor = 'heat') {
  const v = Number(value) || 0;
  if (v <= 0) return null;
  const core = globalThis.__AGContextMeterCore || {};
  let resp = 0;
  if (typeof modeOrAnchor === 'string') {
    resp = typeof core.computeColorScaleResponse === 'function'
      ? core.computeColorScaleResponse(v, modeOrAnchor)
      : (typeof core.computeMixedScaleResponse === 'function' ? core.computeMixedScaleResponse(v, 100e6) : 0.5);
  } else {
    const anchor = Number(modeOrAnchor) || 100e6;
    resp = typeof core.computeMixedScaleResponse === 'function'
      ? core.computeMixedScaleResponse(v, anchor)
      : Math.max(0, Math.min(1, Math.pow(Math.min(v, anchor) / anchor, 0.42)));
    try {
      if (typeof syncHostSettingsThemeAttrs === 'function') syncHostSettingsThemeAttrs();
    } catch {}
  }
  const stops = getContinuousScaleStops();
  if (typeof core.interpolateScaleColorHsl === 'function') {
    return core.interpolateScaleColorHsl(resp, stops);
  }
  return stops[stops.length - 1] || '#3274f6';
}

let __chartsReady = false;

function refreshActiveChartViews() {
  if (!__chartsReady) return;
  if (activeHeatView === 'daily' && typeof renderHeatmapGrid === 'function') renderHeatmapGrid(true);
  else if (activeHeatView === 'weekly' && typeof renderHeatmapWeekly === 'function') renderHeatmapWeekly();
  else if (activeHeatView === 'monthly' && typeof renderHeatmapMonthly === 'function') renderHeatmapMonthly();
  else if (activeHeatView === 'yearly' && typeof renderHeatmapYearly === 'function') renderHeatmapYearly();
  else if (activeHeatView === 'cum' && typeof renderHeatmapCum === 'function') renderHeatmapCum();
  const modelViewEl = el('model-usage-view');
  if (modelViewEl && modelViewEl.style && modelViewEl.style.display === 'block' && typeof renderModelUsageView === 'function') {
    renderModelUsageView();
  }
}

function applyCustomColors() {
  for (const [key, cssVar] of Object.entries(COLOR_SLOTS)) {
    const val = customColors[key];
    if (val) {
      host.style.setProperty(cssVar, val);
    } else if (host.style.removeProperty) {
      host.style.removeProperty(cssVar);
    } else {
      host.style.setProperty(cssVar, '');
    }
  }
  if (customColors.panelBg) {
    const lum = parseRgbLuminance(customColors.panelBg);
    if (lum != null) {
      host.setAttribute('data-panel-tone', lum > 0.55 ? 'light' : 'dark');
    }
  } else {
    host.removeAttribute('data-panel-tone');
  }
  applyHeatmapPalette();
  syncSwatchAndResetButtons();
  refreshActiveChartViews();
  try {
    if (typeof syncQuotaBoardSurfaceTheme === 'function') syncQuotaBoardSurfaceTheme();
  } catch { }
  try {
    if (typeof syncHostSettingsUi === 'function') syncHostSettingsUi();
  } catch { }
}

function setCustomColor(key, value) {
  if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, key)) return;
  const raw = value ? String(value).trim() : '';
  const norm = raw ? (normalizeHex(raw) || raw) : '';
  customColors[key] = norm;
  if (key === 'heatLow' && norm) customColors.heatLvl0 = '';
  if (key === 'heatHigh' && norm) customColors.heatLvl4 = '';
  saveCustomColors();
  applyCustomColors();
}

function setHeatPreset(presetName) {
  if (!HEAT_PRESETS[presetName]) return;
  heatPreset = presetName;
  customColors.heatLow = '';
  customColors.heatHigh = '';
  for (let i = 0; i < 5; i++) {
    customColors[`heatLvl${i}`] = '';
  }
  saveCustomColors();
  applyCustomColors();
}

function resetHeatmapLevels() {
  customColors.heatLow = '';
  customColors.heatHigh = '';
  for (let i = 0; i < 5; i++) {
    customColors[`heatLvl${i}`] = '';
    try {
      if (typeof syncHostSettingsThemeAttrs === 'function') syncHostSettingsThemeAttrs();
    } catch {}
  }
  saveCustomColors();
  applyCustomColors();
}

function resetCustomColors() {
  for (const key of Object.keys(COLOR_SLOTS)) customColors[key] = '';
  heatPreset = 'blue';
  saveCustomColors();
  applyCustomColors();
}

let cachedHostThemeConfigAccent = { light: null, dark: null };
let lastAppliedHostAccentSig = '';

function computeSrgbRelativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const toLinear = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

function computeContrastRatio(hexA, hexB) {
  const la = computeSrgbRelativeLuminance(hexA);
  const lb = computeSrgbRelativeLuminance(hexB);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function computeAccentContrastTokens(accentHex, activeTheme = 'dark') {
  const safeAccent = normalizeHex(accentHex) || '#3274f6';
  const isLight = activeTheme === 'light';
  const lum = computeSrgbRelativeLuminance(safeAccent);
  const whiteContrast = computeContrastRatio(safeAccent, '#ffffff');
  const darkContrast = computeContrastRatio(safeAccent, '#111114');
  // 严格按 WCAG AA >= 4.5:1 对比度为强调色底选配前景色（白/深灰）
  const fg = whiteContrast >= 4.5 || whiteContrast >= darkContrast ? '#ffffff' : '#111114';
  const knob = lum > 0.68 ? '#18181b' : '#ffffff';

  // 极浅强调色在浅底或极暗强调色在深底时，自动补足描边可见度
  let border = safeAccent;
  if (isLight && lum > 0.76) {
    border = interpolateHex(safeAccent, '#18181b', 0.24);
  } else if (!isLight && lum < 0.14) {
    border = interpolateHex(safeAccent, '#ffffff', 0.28);
  }

  // 文字与徽标前景色严格满足 >= 4.5:1 对比度保护（避免白底浅字或黑底深字）
  let textColor = safeAccent;
  const surfaceBg = isLight ? '#ffffff' : '#181818';
  const targetMix = isLight ? '#111114' : '#ffffff';
  if (computeContrastRatio(textColor, surfaceBg) < 4.5) {
    for (let step = 1; step <= 10; step++) {
      const candidate = interpolateHex(safeAccent, targetMix, step * 0.1);
      textColor = candidate;
      if (computeContrastRatio(candidate, surfaceBg) >= 4.5) break;
    }
  }

  return { accent: safeAccent, fg, border, knob, text: textColor, lum };
}

function resolveHostAccentColor() {
  const resolveRawColor = (raw, varName = '') => {
    const str = String(raw || '').trim();
    if (!str || /^transparent$/i.test(str) || str === 'rgba(0, 0, 0, 0)') return '';
    return normalizeHex(str) || resolveCssColorToHex(str, 'color') || (varName ? resolveCssColorToHex(`var(${varName})`, 'color') : '');
  };
  const isValidHex = (hex) => Boolean(hex && /^#[0-9a-f]{6}$/i.test(hex));
  const isNeutralPure = (hex) => {
    if (!isValidHex(hex)) return true;
    const h = hex.toLowerCase();
    return h === '#000000' || h === '#ffffff';
  };
  const activeTheme = resolveTheme();
  try {
    if (typeof document !== 'undefined') {
      // 1. 最高优先级：Antigravity 外观设置实时写入 document.documentElement.style 的 --primary（原样保留极浅/极暗色如 #FEFDFF）
      const inlinePrimary = document.documentElement?.style?.getPropertyValue?.('--primary')
        || document.body?.style?.getPropertyValue?.('--primary')
        || '';
      const inlineHex = resolveRawColor(inlinePrimary, '--primary');
      if (isValidHex(inlineHex)) return inlineHex;

      // 2. 读取宿主根元素与原生设置容器的权威 CSS 变量（显式 --primary / --color-primary 严禁因低彩度过滤）
      if (typeof getComputedStyle === 'function') {
        const modalNode = typeof document.querySelector === 'function'
          ? document.querySelector('.settings-modal-container, [role="dialog"]')
          : null;
        const probeStyles = [
          document.documentElement ? getComputedStyle(document.documentElement) : null,
          document.body ? getComputedStyle(document.body) : null,
          modalNode && !modalNode.closest?.('#ag-context-meter, #ag-cm-host-settings-page') ? getComputedStyle(modalNode) : null
        ].filter(Boolean);

        const primaryVars = ['--ag-accent-override', '--primary', '--color-primary'];
        for (const st of probeStyles) {
          for (const vName of primaryVars) {
            const raw = st?.getPropertyValue?.(vName) || '';
            const hex = resolveRawColor(raw, vName);
            if (isValidHex(hex)) return hex;
          }
        }

        // 3. 若宿主 ~/.gemini/config/config.json 已读到当前明暗主题的自定义强调色种子，优先于通用回退
        const cfgSeed = activeTheme === 'light' ? cachedHostThemeConfigAccent.light : cachedHostThemeConfigAccent.dark;
        const cfgHex = resolveRawColor(cfgSeed);
        if (isValidHex(cfgHex)) return cfgHex;

        // 4. 次级宿主变量兜底
        const secondaryVars = [
          '--accent',
          '--color-accent',
          '--vscode-button-background',
          '--vscode-focusBorder',
          '--brand-accent',
          '--vscode-textLink-foreground',
          '--ring'
        ];
        for (const st of probeStyles) {
          for (const vName of secondaryVars) {
            const raw = st?.getPropertyValue?.(vName) || '';
            const hex = resolveRawColor(raw, vName);
            if (isValidHex(hex) && !isNeutralPure(hex)) return hex;
          }
        }

        // 5. 兜底从宿主原生可见的选中态开关提取强调色（与原生开关同源）
        if (typeof document.querySelectorAll === 'function') {
          const nativeToggles = document.querySelectorAll('button[role="switch"][aria-checked="true"], [role="switch"][aria-checked="true"], input[type="checkbox"]:checked, [data-testid*="settings"] button[aria-pressed="true"], .settings-modal-container button[aria-checked="true"]');
          for (const node of Array.from(nativeToggles || [])) {
            if (!node || node.id?.startsWith?.('ag-') || node.closest?.('#ag-context-meter, #ag-context-meter-radial-host, #ag-cm-host-settings-page, #ag-cm-host-accounts-page, #ag-sidebar-account-host')) continue;
            const st = getComputedStyle(node);
            const hex = resolveRawColor(st?.backgroundColor || '');
            if (isValidHex(hex)) return hex;
            const child = node.firstElementChild;
            if (child) {
              const cst = getComputedStyle(child);
              const cHex = resolveRawColor(cst?.backgroundColor || '');
              if (isValidHex(cHex)) return cHex;
            }
          }
        }
      }
    }
  } catch { }
  const cfgFallback = activeTheme === 'light' ? cachedHostThemeConfigAccent.light : cachedHostThemeConfigAccent.dark;
  const cfgFallbackHex = normalizeHex(cfgFallback || '');
  if (cfgFallbackHex) return cfgFallbackHex;
  return '#3274f6';
}

function syncHostAccentCssVar(opts = {}) {
  const activeTheme = resolveTheme();
  const accent = resolveHostAccentColor();
  const tokens = computeAccentContrastTokens(accent, activeTheme);
  const sig = `${activeTheme}|${tokens.accent}|${tokens.fg}|${tokens.border}|${tokens.knob}|${tokens.text}`;
  if (!opts.force && sig === lastAppliedHostAccentSig) return tokens.accent;
  lastAppliedHostAccentSig = sig;
  try {
    host?.style?.setProperty?.('--ag-host-accent', tokens.accent);
    host?.style?.setProperty?.('--ag-accent', tokens.accent);
    host?.style?.setProperty?.('--ag-host-accent-fg', tokens.fg);
    host?.style?.setProperty?.('--ag-host-accent-border', tokens.border);
    host?.style?.setProperty?.('--ag-host-accent-knob', tokens.knob);
    host?.style?.setProperty?.('--ag-host-accent-text', tokens.text);
    if (typeof syncHostSettingsThemeAttrs === 'function') {
      syncHostSettingsThemeAttrs();
    }
    if (typeof hostSettingsCtrl?.syncThemeToPageHost === 'function') {
      hostSettingsCtrl.syncThemeToPageHost();
    }
    if (typeof sidebarAccountCtrl?.syncTheme === 'function') {
      sidebarAccountCtrl.syncTheme();
    }
    if (typeof modalTopHost !== 'undefined' && modalTopHost && typeof syncHostSettingsThemeAttrs === 'function') {
      syncHostSettingsThemeAttrs(modalTopHost);
    }
  } catch { }
  return tokens.accent;
}

async function refreshHostAccentFromConfigBridge() {
  try {
    const res = await invokeHostThemeBridge({ action: 'get' });
    if (res && res.ok) {
      const nextLight = normalizeHex(res.accentLight || '') || null;
      const nextDark = normalizeHex(res.accentDark || '') || null;
      if (nextLight !== cachedHostThemeConfigAccent.light || nextDark !== cachedHostThemeConfigAccent.dark) {
        cachedHostThemeConfigAccent = { light: nextLight, dark: nextDark };
        syncHostAccentCssVar({ force: true });
      }
    }
  } catch { }
}

const PRE_TAKEOVER_THEME_KEY = 'ag_pre_takeover_host_theme';
const LAST_APPLIED_HOST_THEME_KEY = 'ag_last_applied_host_theme';
let preTakeoverHostThemeMode = null;
let lastAppliedHostThemeMode = null;
let themeSyncSeq = 0;
let themeSyncDebounceTimer = null;
let suppressHostThemeObserverUntil = 0;
let lastThemeSyncState = {
  ok: true,
  mode: currentThemeMode,
  hostMode: null,
  source: 'init',
  error: null,
  seq: 0,
  updatedAtMs: 0
};
try {
  if (typeof localStorage !== 'undefined') {
    const savedPre = localStorage.getItem(PRE_TAKEOVER_THEME_KEY);
    if (['auto', 'light', 'dark'].includes(savedPre)) preTakeoverHostThemeMode = savedPre;
    const savedApplied = localStorage.getItem(LAST_APPLIED_HOST_THEME_KEY);
    if (['light', 'dark'].includes(savedApplied)) lastAppliedHostThemeMode = savedApplied;
  }
} catch { }

function persistThemeTakeoverMeta() {
  try {
    if (typeof localStorage === 'undefined') return;
    if (preTakeoverHostThemeMode) localStorage.setItem(PRE_TAKEOVER_THEME_KEY, preTakeoverHostThemeMode);
    else localStorage.removeItem(PRE_TAKEOVER_THEME_KEY);
    if (lastAppliedHostThemeMode) localStorage.setItem(LAST_APPLIED_HOST_THEME_KEY, lastAppliedHostThemeMode);
    else localStorage.removeItem(LAST_APPLIED_HOST_THEME_KEY);
  } catch { }
}

async function invokeHostThemeBridge(payload = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.hostTheme === 'function') {
      return await window.contextMeterAPI.hostTheme(payload);
    }
    if (typeof hasLiveHttpBridge === 'function' && hasLiveHttpBridge() && typeof callLiveHttpRoute === 'function') {
      return await callLiveHttpRoute('/host-theme', payload);
    }
    return { ok: false, unsupported: true, error: 'host_theme_bridge_unavailable' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function getThemeSyncState() {
  return {
    ...lastThemeSyncState,
    themeMode: currentThemeMode,
    activeTheme: resolveTheme(),
    preTakeoverHostThemeMode,
    lastAppliedHostThemeMode
  };
}

/**
 * 全插件统一主题模式切换入口：
 * - 显式 light/dark：由插件主导，同步写入整个 Antigravity 客户端（JetboxWriteState）并记录接管前模式；
 * - 切回 auto（跟随宿主）：仅当宿主当前值仍等于插件上次主动覆盖值时恢复接管前模式，保留用户后续在原生外观页的修改。
 */
async function setPluginThemeMode(mode, opts = {}) {
  if (!['auto', 'light', 'dark'].includes(mode)) {
    return { ok: false, error: 'invalid_theme_mode', mode: currentThemeMode };
  }
  const source = opts.source || 'user';
  const shouldPersist = opts.persist !== false;
  const shouldSyncHost = opts.syncHost !== false;
  const prevMode = currentThemeMode;
  currentThemeMode = mode;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('ag_theme_mode', mode);
  } catch { }
  applyTheme();
  if (typeof renderQuotaBoard === 'function' && typeof lastComputedQuotaView !== 'undefined' && lastComputedQuotaView && !quotaBoardCtrl?.isAnimating?.()) {
    try { renderQuotaBoard(Date.now(), { animate: false, forceStatic: true }); } catch { }
  }
  if (shouldPersist && typeof saveSettingsPayloadBridge === 'function') {
    try { void saveSettingsPayloadBridge({ themeMode: mode }); } catch { }
  }
  if (typeof syncHostSettingsUi === 'function') {
    try { syncHostSettingsUi(); } catch { }
  }
  if (typeof sidebarAccountCtrl?.syncTheme === 'function') {
    try { sidebarAccountCtrl.syncTheme(); } catch { }
  }
  if (!shouldSyncHost) {
    lastThemeSyncState = { ok: true, mode, hostMode: null, source, error: null, seq: themeSyncSeq, updatedAtMs: Date.now() };
    return { ok: true, mode, localOnly: true };
  }

  const mySeq = ++themeSyncSeq;
  if (themeSyncDebounceTimer) {
    clearTimeout(themeSyncDebounceTimer);
    themeSyncDebounceTimer = null;
  }

  const executeSync = async () => {
    if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
    const readRes = await invokeHostThemeBridge({ action: 'get' });
    if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
    if (readRes?.unsupported) {
      lastThemeSyncState = { ok: false, unsupported: true, mode, hostMode: null, source, error: readRes.error || 'host_theme_bridge_unavailable', seq: mySeq, updatedAtMs: Date.now() };
      return lastThemeSyncState;
    }
    const currentHostMode = readRes?.ok && ['auto', 'light', 'dark'].includes(readRes.mode)
      ? readRes.mode
      : null;

    if (mode === 'light' || mode === 'dark') {
      // 首次从 auto 接管时记录接管前宿主模式（不覆写已有的接管前记录）
      if (!lastAppliedHostThemeMode && !preTakeoverHostThemeMode) {
        preTakeoverHostThemeMode = currentHostMode || 'auto';
      }
      // 幂等判等：宿主已等于目标模式时仅更新状态不重复写 RPC
      if (currentHostMode === mode) {
        lastAppliedHostThemeMode = mode;
        persistThemeTakeoverMeta();
        suppressHostThemeObserverUntil = Date.now() + 500;
        lastThemeSyncState = { ok: true, mode, hostMode: currentHostMode, source, idempotent: true, error: null, seq: mySeq, updatedAtMs: Date.now() };
        applyTheme();
        return lastThemeSyncState;
      }
      suppressHostThemeObserverUntil = Date.now() + 900;
      const writeRes = await invokeHostThemeBridge({ action: 'set', mode });
      if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
      if (writeRes?.ok) {
        lastAppliedHostThemeMode = mode;
        persistThemeTakeoverMeta();
        suppressHostThemeObserverUntil = Date.now() + 700;
        lastThemeSyncState = { ok: true, mode, hostMode: writeRes.mode || mode, source, error: null, seq: mySeq, updatedAtMs: Date.now() };
        applyTheme();
        if (typeof syncHostSettingsUi === 'function') { try { syncHostSettingsUi(); } catch { } }
        return lastThemeSyncState;
      }
      // 写入失败：回读宿主当前实际值并记录真实失败反馈，绝不伪报成功
      const rb = await invokeHostThemeBridge({ action: 'get' });
      if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
      const rbMode = rb?.ok && ['auto', 'light', 'dark'].includes(rb.mode) ? rb.mode : currentHostMode;
      lastThemeSyncState = {
        ok: false,
        mode,
        prevMode,
        hostMode: rbMode,
        source,
        error: writeRes?.error || 'host_theme_write_failed',
        seq: mySeq,
        updatedAtMs: Date.now()
      };
      if (typeof showNativeSettingsToast === 'function' && typeof t === 'function') {
        try { showNativeSettingsToast(t('theme.syncFailed', { err: lastThemeSyncState.error })); } catch { }
      }
      if (typeof syncHostSettingsUi === 'function') { try { syncHostSettingsUi(); } catch { } }
      return lastThemeSyncState;
    }

    // 切回跟随宿主 (auto)
    let restoredHost = false;
    let finalHostMode = currentHostMode;
    if (lastAppliedHostThemeMode && currentHostMode === lastAppliedHostThemeMode && preTakeoverHostThemeMode && preTakeoverHostThemeMode !== currentHostMode) {
      suppressHostThemeObserverUntil = Date.now() + 900;
      const restoreRes = await invokeHostThemeBridge({ action: 'set', mode: preTakeoverHostThemeMode });
      if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
      if (restoreRes?.ok) {
        restoredHost = true;
        finalHostMode = restoreRes.mode || preTakeoverHostThemeMode;
        suppressHostThemeObserverUntil = Date.now() + 700;
      } else {
        const rb = await invokeHostThemeBridge({ action: 'get' });
        if (mySeq !== themeSyncSeq) return { ok: true, stale: true, mode };
        finalHostMode = rb?.ok ? rb.mode : currentHostMode;
        lastThemeSyncState = {
          ok: false,
          mode: 'auto',
          hostMode: finalHostMode,
          source,
          error: restoreRes?.error || 'host_theme_restore_failed',
          seq: mySeq,
          updatedAtMs: Date.now()
        };
        applyTheme();
        return lastThemeSyncState;
      }
    }
    // 无论是否需要还原（若用户已手动改过宿主则保留用户选择），释放插件主动接管状态
    lastAppliedHostThemeMode = null;
    preTakeoverHostThemeMode = null;
    persistThemeTakeoverMeta();
    lastThemeSyncState = {
      ok: true,
      mode: 'auto',
      hostMode: finalHostMode,
      restoredHost,
      source,
      error: null,
      seq: mySeq,
      updatedAtMs: Date.now()
    };
    applyTheme();
    if (typeof syncHostSettingsUi === 'function') { try { syncHostSettingsUi(); } catch { } }
    return lastThemeSyncState;
  };

  const debounceMs = Number.isFinite(Number(opts.debounceMs)) ? Math.max(0, Number(opts.debounceMs)) : 0;
  if (debounceMs > 0) {
    return new Promise((resolve) => {
      themeSyncDebounceTimer = setTimeout(() => {
        themeSyncDebounceTimer = null;
        void executeSync().then(resolve);
      }, debounceMs);
    });
  }
  return executeSync();
}

function applyTheme() {
  const activeTheme = resolveTheme();
  host.setAttribute('data-theme', activeTheme);
  const hostBg = getHostZeroLevelBg(activeTheme === 'light');
  host.style.setProperty('--ag-host-bg', hostBg);
  syncHostAccentCssVar();
  const btns = [el('theme-toggle'), el('theme-toggle-tokens')].filter(Boolean);
  btns.forEach(btn => {
    if (currentThemeMode === 'auto') {
      btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
      btn.title = t('theme.autoTitle', { mode: activeTheme === 'light' ? t('theme.light') : t('theme.dark') });
    } else if (currentThemeMode === 'light') {
      btn.textContent = '☀️';
      btn.title = t('theme.lightTitle');
    } else {
      btn.textContent = '🌙';
      btn.title = t('theme.darkTitle');
    }
  });
  applyHeatmapPalette();
  syncSwatchAndResetButtons();
  refreshActiveChartViews();
  try {
    if (typeof syncQuotaBoardSurfaceTheme === 'function') syncQuotaBoardSurfaceTheme();
  } catch { }
  syncNativeOverlayTheme();
}

let lastSyncedOverlayKey = '';
let overlayColorProbeEl = null;
function resolveCssColorToHex(cssExpr, prop = 'color') {
  if (!cssExpr || typeof cssExpr !== 'string') return '';
  const trimmed = cssExpr.trim();
  if (!trimmed || trimmed === 'transparent' || trimmed === 'rgba(0, 0, 0, 0)') return '';
  const direct = normalizeHex(trimmed);
  if (direct) return direct;
  try {
    if (typeof document === 'undefined' || !document.body || typeof window?.getComputedStyle !== 'function') return '';
    if (!overlayColorProbeEl) {
      overlayColorProbeEl = document.createElement('div');
      if (overlayColorProbeEl.style) {
        overlayColorProbeEl.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
      }
      overlayColorProbeEl.setAttribute?.('aria-hidden', 'true');
    }
    if (!overlayColorProbeEl.isConnected && typeof document.body.appendChild === 'function') {
      document.body.appendChild(overlayColorProbeEl);
    }
    if (!overlayColorProbeEl.style) return '';
    overlayColorProbeEl.style[prop] = '';
    overlayColorProbeEl.style[prop] = trimmed;
    const computed = window.getComputedStyle(overlayColorProbeEl)?.[prop] || '';
    return normalizeHex(computed) || '';
  } catch {
    return '';
  }
}

function resolveNativeTitlebarOverlayColors() {
  const pickHex = (candidates, prop = 'color') => {
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'string') continue;
      const tVal = raw.trim();
      if (!tVal || tVal === 'transparent' || tVal === 'rgba(0, 0, 0, 0)') continue;
      const hex = normalizeHex(tVal) || resolveCssColorToHex(tVal, prop);
      if (hex) return hex;
    }
    return '';
  };
  // 严格读取宿主系统主题判断深浅色兜底值，避免插件自身切换主题时污染原生窗口控制按钮
  const hostIsLight = getSystemTheme() === 'light';
  try {
    const nativeStyle = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    const bodyStyle = typeof getComputedStyle === 'function' && document.body ? getComputedStyle(document.body) : null;
    const menuBarNode = typeof document.querySelector === 'function'
      ? document.querySelector('[data-testid="title-menu-bar"]')
      : null;
    const menuBarStyle = menuBarNode && typeof getComputedStyle === 'function' ? getComputedStyle(menuBarNode) : null;
    const barNode = typeof document.querySelector === 'function'
      ? (document.querySelector('[class*="@container/titlebar"]') || document.querySelector('header, nav, .titlebar'))
      : null;
    const barStyle = barNode && typeof getComputedStyle === 'function' ? getComputedStyle(barNode) : null;
    const sidebarVarRaw = nativeStyle?.getPropertyValue?.('--sidebar') || '';
    const secFgVarRaw = nativeStyle?.getPropertyValue?.('--secondary-foreground') || '';
    const bg = pickHex([
      menuBarStyle?.backgroundColor,
      nativeStyle?.getPropertyValue?.('--vscode-titleBar-activeBackground'),
      sidebarVarRaw,
      sidebarVarRaw ? 'var(--sidebar)' : '',
      barStyle?.backgroundColor,
      nativeStyle?.getPropertyValue?.('--background'),
      bodyStyle?.backgroundColor
    ], 'backgroundColor') || (hostIsLight ? '#fafafa' : '#131313');
    const fg = pickHex([
      nativeStyle?.getPropertyValue?.('--vscode-titleBar-activeForeground'),
      secFgVarRaw,
      secFgVarRaw ? 'var(--secondary-foreground)' : '',
      menuBarStyle?.color,
      barStyle?.color,
      nativeStyle?.getPropertyValue?.('--foreground'),
      bodyStyle?.color
    ], 'color') || (hostIsLight ? '#383a42' : '#fafafa');
    return { bg, fg };
  } catch {
    return { bg: hostIsLight ? '#fafafa' : '#131313', fg: hostIsLight ? '#383a42' : '#fafafa' };
  }
}

function syncNativeOverlayTheme() {
  try {
    if (typeof window === 'undefined') return;
    const { bg, fg } = resolveNativeTitlebarOverlayColors();
    if (!/^#[0-9a-f]{6}$/i.test(bg) || !/^#[0-9a-f]{6}$/i.test(fg)) return;
    const overlayKey = `${bg}|${fg}|30`;
    if (overlayKey === lastSyncedOverlayKey) return;
    lastSyncedOverlayKey = overlayKey;
    if (typeof window.contextMeterAPI?.syncOverlay === 'function') {
      void window.contextMeterAPI.syncOverlay({ color: bg, symbolColor: fg, height: 30, heightCssPx: 30 });
    } else if (typeof window.electronNative?.setTitleBarOverlay === 'function') {
      void window.electronNative.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 30 });
    }
  } catch { }
}

function cycleTheme() {
  const nextMode = currentThemeMode === 'auto'
    ? 'light'
    : (currentThemeMode === 'light' ? 'dark' : 'auto');
  void setPluginThemeMode(nextMode, { persist: true, syncHost: true, source: 'cycleTheme', debounceMs: 80 });
}

let themeObserver = null;
let headStyleObserver = null;
let headStyleDebounceTimer = null;
let accentPollTimer = null;
let overlayMediaCleanup = null;
const overlaySyncTimers = [];
try {
  if (typeof MutationObserver !== 'undefined' && document.body) {
    themeObserver = new MutationObserver(() => {
      syncHostAccentCssVar();
      if (Date.now() < suppressHostThemeObserverUntil) return;
      if (currentThemeMode === 'auto') applyTheme();
      else syncNativeOverlayTheme();
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-agy-theme'] });
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-agy-theme'] });
    }
    if (document.head) {
      headStyleObserver = new MutationObserver(() => {
        if (state.disposed) return;
        if (headStyleDebounceTimer) clearTimeout(headStyleDebounceTimer);
        headStyleDebounceTimer = setTimeout(() => {
          headStyleDebounceTimer = null;
          if (!state.disposed) syncHostAccentCssVar();
        }, 30);
      });
      headStyleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mqlDark = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => {
      if (state.disposed) return;
      if (currentThemeMode === 'auto') applyTheme();
      else syncNativeOverlayTheme();
    };
    if (typeof mqlDark?.addEventListener === 'function') {
      mqlDark.addEventListener('change', onSchemeChange);
      overlayMediaCleanup = () => { try { mqlDark.removeEventListener('change', onSchemeChange); } catch { } };
    } else if (typeof mqlDark?.addListener === 'function') {
      mqlDark.addListener(onSchemeChange);
      overlayMediaCleanup = () => { try { mqlDark.removeListener(onSchemeChange); } catch { } };
    }
  }
  for (const delayMs of [80, 600, 1800]) {
    const tid = setTimeout(() => {
      if (!state.disposed) {
        syncNativeOverlayTheme();
        syncHostAccentCssVar();
      }
    }, delayMs);
    overlaySyncTimers.push(tid);
  }
  // 首次加载同步宿主 config.json 强调色种子；窗口聚焦或可见时静默校对（无变更零 DOM 写入，不新增后台轮询）
  const initCfgTid = setTimeout(() => {
    if (!state.disposed) void refreshHostAccentFromConfigBridge();
  }, 160);
  overlaySyncTimers.push(initCfgTid);
  const onWindowFocusAccentSync = () => {
    if (state.disposed) return;
    syncHostAccentCssVar();
    void refreshHostAccentFromConfigBridge();
  };
  const onDocVisibilityAccentSync = () => {
    if (state.disposed || document?.visibilityState === 'hidden') return;
    syncHostAccentCssVar();
    void refreshHostAccentFromConfigBridge();
  };
  try { window.addEventListener?.('focus', onWindowFocusAccentSync); } catch { }
  try { document.addEventListener?.('visibilitychange', onDocVisibilityAccentSync); } catch { }
  if (typeof activeDisposers?.add === 'function') {
    activeDisposers.add(() => {
      if (themeSyncDebounceTimer) { clearTimeout(themeSyncDebounceTimer); themeSyncDebounceTimer = null; }
      if (headStyleDebounceTimer) { clearTimeout(headStyleDebounceTimer); headStyleDebounceTimer = null; }
      try { window.removeEventListener?.('focus', onWindowFocusAccentSync); } catch { }
      try { document.removeEventListener?.('visibilitychange', onDocVisibilityAccentSync); } catch { }
      try { themeObserver?.disconnect?.(); } catch { }
      try { headStyleObserver?.disconnect?.(); } catch { }
      for (const tid of overlaySyncTimers) clearTimeout(tid);
      overlaySyncTimers.length = 0;
      if (overlayMediaCleanup) { overlayMediaCleanup(); overlayMediaCleanup = null; }
      try { overlayColorProbeEl?.remove?.(); } catch { }
      overlayColorProbeEl = null;
    });
  }
} catch { }

applyTheme();
applyCustomColors();

// =========================================================================
// 自定义「颜色选取器」面板交互逻辑（吸管 + 预设圆点 + SV主色区 + 色相条 + HEX/RGB/HSL）
// =========================================================================
let activePickerSlot = null;
let activePickerAnchor = null;
let cpHsv = { h: 217, s: 80, v: 96 };

function syncPickerUiFromHsv(skipInputId = '', exactRgb = null) {
  const rgb = exactRgb || hsvToRgb(cpHsv.h, cpHsv.s, cpHsv.v);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  const svArea = el('cp-sv-area');
  const svThumb = el('cp-sv-thumb');
  const hueThumb = el('cp-hue-thumb');
  const sidePreview = el('cp-side-preview');
  if (svArea) svArea.style.backgroundColor = `hsl(${cpHsv.h}, 100%, 50%)`;
  if (svThumb) {
    svThumb.style.left = `${cpHsv.s}%`;
    svThumb.style.top = `${100 - cpHsv.v}%`;
  }
  if (hueThumb) {
    hueThumb.style.left = `${(cpHsv.h / 360) * 100}%`;
  }
  if (sidePreview) {
    sidePreview.style.background = hex;
  }

  const inHex = el('cp-input-hex');
  const inRgb = el('cp-input-rgb');
  const inHsl = el('cp-input-hsl');
  if (inHex && skipInputId !== 'cp-input-hex') inHex.value = hex;
  if (inRgb && skipInputId !== 'cp-input-rgb') inRgb.value = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  if (inHsl && skipInputId !== 'cp-input-hsl') inHsl.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
  return hex;
}

function applyPickerHex(hexStr, skipInputId = '') {
  const norm = normalizeHex(hexStr);
  if (!norm) return false;
  const rgb = hexToRgb(norm);
  if (!rgb) return false;
  cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const appliedHex = syncPickerUiFromHsv(skipInputId, rgb);
  if (activePickerSlot) {
    setCustomColor(activePickerSlot, appliedHex);
  }
  return true;
}

let pickerOpVersion = 0;

function positionColorPickerPopover() {
  const pop = el('color-picker-popover');
  if (!pop || pop.hidden) return;
  try {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const popW = 304;
    const popH = pop.offsetHeight > 0 ? pop.offsetHeight : 340;
    let minLeft = 12;
    if (typeof document.querySelector === 'function') {
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right < vw - 320) {
          minLeft = Math.ceil(nr.right + 12);
        }
      }
    }
    const snapPx = typeof snapToDevicePixel === 'function' ? snapToDevicePixel : Math.round;
    let left = snapPx((vw - popW) / 2);
    let top = 90;
    if (activePickerAnchor?.getBoundingClientRect) {
      const ar = activePickerAnchor.getBoundingClientRect();
      if (ar.width > 0 || ar.height > 0) {
        left = snapPx(ar.right - popW);
        top = snapPx(ar.bottom + 6);
        if (top + popH > vh - 12 && ar.top > popH + 12) {
          top = snapPx(ar.top - popH - 6);
        }
      }
    }
    left = snapPx(Math.max(minLeft, Math.min(vw - popW - 12, left)));
    top = snapPx(Math.max(42, Math.min(vh - popH - 12, top)));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  } catch { }
}

function openColorPicker(slotKey, anchorEl = null, labelText = '') {
  if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, slotKey)) return;
  const pop = el('color-picker-popover');
  if (!pop) return;
  if (typeof ensureColorPickerTopLayer === 'function') {
    try { ensureColorPickerTopLayer(); } catch { }
  }

  const op = ++pickerOpVersion;
  activePickerSlot = slotKey;
  activePickerAnchor = anchorEl;

  const lbl = el('cp-target-name');
  if (lbl) lbl.textContent = labelText ? `· ${labelText}` : `· ${slotKey}`;
  const cpResetBtn = el('cp-reset-slot');
  if (cpResetBtn) {
    cpResetBtn.textContent = slotKey.startsWith('heat') ? t('colors.resetLevel') : t('colors.followTheme');
  }
  const startHex = getEffectiveSlotColor(slotKey);
  const rgb = hexToRgb(startHex) || { r: 50, g: 116, b: 246 };
  cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  syncPickerUiFromHsv();

  pop.setAttribute?.('data-closing', 'false');
  pop.classList?.remove?.('is-closing');
  pop.classList?.add?.('is-opening');
  pop.hidden = false;
  positionColorPickerPopover();

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (pickerOpVersion === op) {
        pop.classList?.remove?.('is-opening');
      }
    });
  } else {
    pop.classList?.remove?.('is-opening');
  }
}

function closeColorPicker(immediate = false) {
  const pop = el('color-picker-popover');
  const isMock = !pop?.classList || typeof pop.classList.add !== 'function' || typeof pop.animate !== 'function';
  const isClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
  if (!pop || pop.hidden || isClosing) {
    activePickerSlot = null;
    activePickerAnchor = null;
    return;
  }
  const op = ++pickerOpVersion;
  activePickerSlot = null;
  activePickerAnchor = null;

  const isImmediate = typeof immediate === 'boolean' ? immediate : false;
  if (isImmediate || isMock || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) {
    pop.setAttribute?.('data-closing', 'false');
    pop.classList?.remove?.('is-opening', 'is-closing');
    pop.hidden = true;
    return;
  }

  pop.setAttribute?.('data-closing', 'true');
  pop.classList?.add?.('is-closing');
  setTimeout(() => {
    if (pickerOpVersion === op) {
      pop.setAttribute?.('data-closing', 'false');
      pop.classList?.remove?.('is-opening', 'is-closing');
      pop.hidden = true;
    }
  }, 130);
}

const getHeatLvlLabel = (idx) => t(`colors.lvl${idx}`);

// 绑定所有颜色色块与恢复按钮事件
for (const key of Object.keys(COLOR_SLOTS)) {
  const inputEl = el(`color-${key}`);
  const resetBtn = el(`reset-${key}`);
  const swatchBtn = el(`swatch-${key}`);
  inputEl?.addEventListener('input', e => setCustomColor(key, e.target?.value || ''));
  inputEl?.addEventListener('change', e => setCustomColor(key, e.target?.value || ''));
  resetBtn?.addEventListener('click', () => {
    setCustomColor(key, '');
    if (activePickerSlot === key) {
      const eff = getEffectiveSlotColor(key);
      const rgb = hexToRgb(eff) || { r: 50, g: 116, b: 246 };
      cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncPickerUiFromHsv();
    }
  });
  swatchBtn?.addEventListener('click', e => {
    e?.stopPropagation?.();
    openColorPicker(key, swatchBtn, swatchBtn.getAttribute('data-color-label') || key);
  });
}

// 热力图右下角「少 ▢▢▢▢▢ 多」5 个小色块图例直接点击弹出颜色选取器单独调色
for (let i = 0; i < 5; i++) {
  const legBtn = el(`heat-leg-${i}`);
  const slotKey = `heatLvl${i}`;
  legBtn?.addEventListener('click', e => {
    e?.stopPropagation?.();
    toggleTokenColorsDrawer(true);
    const swatchBtn = el(`swatch-${slotKey}`) || legBtn;
    openColorPicker(slotKey, swatchBtn, getHeatLvlLabel(i));
  });
}
el('reset-heat-lvls')?.addEventListener('click', () => {
  resetHeatmapLevels();
  if (activePickerSlot?.startsWith('heat')) {
    const eff = getEffectiveSlotColor(activePickerSlot);
    const rgb = hexToRgb(eff) || { r: 50, g: 116, b: 246 };
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    syncPickerUiFromHsv();
  }
});

// 面板 A 镜像色块与预设按钮事件
['swatch-panelBg-tokens', 'swatch-tokenTotal-tokens', 'swatch-tokenAccent-tokens'].forEach(id => {
  const btn = el(id);
  btn?.addEventListener('click', e => {
    e?.stopPropagation?.();
    const slot = btn.getAttribute('data-color-slot');
    if (slot) openColorPicker(slot, btn, btn.getAttribute('data-color-label') || slot);
  });
});
el('reset-panelBg-tokens')?.addEventListener('click', () => setCustomColor('panelBg', ''));
el('reset-all-colors')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });
el('reset-all-colors-tokens')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });

try {
  const presetGroup = el('heat-preset-group');
  if (presetGroup?.querySelectorAll) {
    for (const btn of presetGroup.querySelectorAll('[data-heat-preset]')) {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-heat-preset');
        if (p) setHeatPreset(p);
      });
    }
  }
} catch { }

// 颜色选取器内部控件绑定（SV 拖拽、Hue 拖拽、预设圆点、吸管、HEX/RGB/HSL 输入与复制）
el('cp-close')?.addEventListener('click', () => closeColorPicker(false));
el('cp-reset-slot')?.addEventListener('click', () => {
  if (activePickerSlot) {
    setCustomColor(activePickerSlot, '');
    const eff = getEffectiveSlotColor(activePickerSlot);
    const rgb = hexToRgb(eff) || { r: 50, g: 116, b: 246 };
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    syncPickerUiFromHsv();
  }
});

try {
  const presetsWrap = el('cp-presets');
  if (presetsWrap?.querySelectorAll) {
    for (const dot of presetsWrap.querySelectorAll('[data-cp-hex]')) {
      dot.addEventListener('click', () => {
        const hex = dot.getAttribute('data-cp-hex');
        if (hex) applyPickerHex(hex);
      });
    }
  }
} catch { }

el('cp-eyedropper')?.addEventListener('click', async () => {
  const statusEl = el('cp-status-msg');
  try {
    if (typeof window !== 'undefined' && typeof window.EyeDropper === 'function') {
      const dropper = new window.EyeDropper();
      const res = await dropper.open();
      if (res?.sRGBHex) {
        applyPickerHex(res.sRGBHex);
        if (statusEl) statusEl.textContent = t('colors.eyedropperPicked', { hex: res.sRGBHex.toUpperCase() });
      }
    } else {
      el('cp-input-hex')?.focus?.();
      if (statusEl) statusEl.textContent = t('colors.eyedropperUnsupported');
    }
  } catch { }
});

el('cp-input-hex')?.addEventListener('input', e => {
  const raw = e.target?.value || '';
  const norm = normalizeHex(raw);
  if (norm) {
    applyPickerHex(norm, 'cp-input-hex');
    const statusEl = el('cp-status-msg');
    if (statusEl) statusEl.textContent = t('colors.appliedHex', { hex: norm.toUpperCase() });
  }
});
el('cp-input-hex')?.addEventListener('change', e => {
  const raw = e.target?.value || '';
  const norm = normalizeHex(raw);
  if (norm) applyPickerHex(norm);
});

el('cp-input-rgb')?.addEventListener('input', e => {
  const norm = normalizeHex(e.target?.value || '');
  if (norm) applyPickerHex(norm, 'cp-input-rgb');
});
el('cp-input-hsl')?.addEventListener('input', e => {
  const norm = normalizeHex(e.target?.value || '');
  if (norm) applyPickerHex(norm, 'cp-input-hsl');
});

function copyPickerText(inputId, label) {
  const input = el(inputId);
  const val = input?.value || '';
  if (!val) return;
  try {
    navigator?.clipboard?.writeText?.(val);
  } catch { }
  const statusEl = el('cp-status-msg');
  if (statusEl) statusEl.textContent = t('colors.copied', { label, val });
}
el('cp-copy-hex')?.addEventListener('click', () => copyPickerText('cp-input-hex', 'HEX'));
el('cp-copy-rgb')?.addEventListener('click', () => copyPickerText('cp-input-rgb', 'RGB'));
el('cp-copy-hsl')?.addEventListener('click', () => copyPickerText('cp-input-hsl', 'HSL'));

const svAreaEl = el('cp-sv-area');
const hueWrapEl = el('cp-hue-wrap');
let draggingSv = false;
let draggingHue = false;

function updateSvFromPointer(e) {
  if (!svAreaEl?.getBoundingClientRect) return;
  const r = svAreaEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const s = clampNum(((e.clientX - r.left) / r.width) * 100, 0, 100);
  const v = clampNum(100 - ((e.clientY - r.top) / r.height) * 100, 0, 100);
  cpHsv.s = Math.round(s);
  cpHsv.v = Math.round(v);
  const hex = syncPickerUiFromHsv();
  if (activePickerSlot) setCustomColor(activePickerSlot, hex);
}

function updateHueFromPointer(e) {
  if (!hueWrapEl?.getBoundingClientRect) return;
  const r = hueWrapEl.getBoundingClientRect();
  if (!r.width) return;
  const h = clampNum(((e.clientX - r.left) / r.width) * 360, 0, 360);
  cpHsv.h = Math.round(h);
  const hex = syncPickerUiFromHsv();
  if (activePickerSlot) setCustomColor(activePickerSlot, hex);
}

svAreaEl?.addEventListener('mousedown', e => {
  draggingSv = true;
  updateSvFromPointer(e);
});
hueWrapEl?.addEventListener('mousedown', e => {
  draggingHue = true;
  updateHueFromPointer(e);
});
const onPointerMove = e => {
  if (draggingSv) updateSvFromPointer(e);
  else if (draggingHue) updateHueFromPointer(e);
};
const onPointerUp = () => {
  draggingSv = false;
  draggingHue = false;
};
try {
  window.addEventListener?.('mousemove', onPointerMove);
  window.addEventListener?.('mouseup', onPointerUp);
} catch { }

