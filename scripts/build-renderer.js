'use strict';
/**
 * 零依赖纯 Node.js 渲染层构建脚本 (build-renderer.js)
 *
 * 职责：
 * 将 src/renderer/ 下按职责拆分的子模块：
 *  - styles.css (纯 CSS 样式定义)
 *  - template.html (Shadow DOM 结构模板)
 *  - colors.js (色彩空间转换、色相/明度/饱和度算法与拾色器组件)
 *  - dropdown.js (自定义下拉菜单、国家/地区/货币搜索过滤与键盘高亮)
 *  - heatmap.js (热力图网格、周视图、累计视图与悬浮 Popover)
 *  - main.js (宿主挂载、状态机、数据轮询、布局响应式及生命周期销毁)
 * 组合输出至根目录的 meter-renderer.js；修改渲染层时以 src/renderer 为准。
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src', 'renderer');
const targetFile = path.join(rootDir, 'meter-renderer.js');

const TRUNCATION_PATTERN = /truncated for diff preview/i;

/**
 * 检查源码文件是否混入编辑器/工具预览截断标记；
 * 一旦发现立即抛出带准确文件路径与行号的错误中止构建，绝不自动覆盖源码或写入产物。
 */
function assertNoTruncationMarker(filePath, content) {
  const match = TRUNCATION_PATTERN.exec(content);
  if (!match) return;
  const idx = match.index;
  const prefix = content.slice(0, idx);
  const lines = prefix.split(/\r?\n/);
  const lineNum = lines.length;
  const colNum = lines[lines.length - 1].length + 1;
  const err = new Error(
    `[构建中止] 检测到源码截断标记 (truncated for diff preview): ${filePath}:${lineNum}:${colNum}。已保留现场文件与未提交修改，请先备份并比较后再执行独立恢复。`
  );
  err.code = 'ERR_SOURCE_TRUNCATED';
  err.filePath = filePath;
  err.line = lineNum;
  err.column = colNum;
  throw err;
}

function readVerifiedRendererSource(dir, fileName) {
  const fullPath = path.join(dir, fileName);
  const raw = fs.readFileSync(fullPath, 'utf8');
  assertNoTruncationMarker(fullPath, raw);
  return raw.replace(/\r\n/g, '\n');
}

function buildRenderer(options = {}) {
  const effRootDir = options.rootDir ? path.resolve(options.rootDir) : rootDir;
  const effSrcDir = options.srcDir ? path.resolve(options.srcDir) : path.join(effRootDir, 'src', 'renderer');
  const effTargetFile = options.targetFile ? path.resolve(options.targetFile) : path.join(effRootDir, 'meter-renderer.js');

  const pkg = JSON.parse(fs.readFileSync(path.join(effRootDir, 'package.json'), 'utf8'));
  const meterVersion = pkg.version || '0.8.5';
  const rawDisplay = typeof pkg.displayVersion === 'string' ? pkg.displayVersion.trim() : '';
  const displayVersion = rawDisplay || `v${meterVersion}`;

  const styles = readVerifiedRendererSource(effSrcDir, 'styles.css').trim();
  let template = readVerifiedRendererSource(effSrcDir, 'template.html').trim();
  template = template.replace(/(<span id="v"[^>]*>)[^<]*(<\/span>)/g, `$1${displayVersion}$2`);
  template = template.replace(/(<span id="v-tokens"[^>]*>)[^<]*(<\/span>)/g, `$1${displayVersion}$2`);
  template = template.replace(/<span id="up-pop-ver"[^>]*>[^<]*<\/span>/g, `<span id="up-pop-ver" class="key-pill pill-good" style="font-size:10px">${displayVersion}</span>`);

  const colors = readVerifiedRendererSource(effSrcDir, 'colors.js').trim();
  const i18n = readVerifiedRendererSource(effSrcDir, 'i18n.js').trim();
  const budgetEngine = readVerifiedRendererSource(effSrcDir, 'context-budget-engine.js').trim();
  const dropdown = readVerifiedRendererSource(effSrcDir, 'dropdown.js').trim();
  const heatmap = readVerifiedRendererSource(effSrcDir, 'heatmap.js').trim();
  const dashboardGrid = readVerifiedRendererSource(effSrcDir, 'dashboard-grid.js').trim();
  const trendPulse = readVerifiedRendererSource(effSrcDir, 'trend-pulse.js').trim();
  const contextInspector = readVerifiedRendererSource(effSrcDir, 'context-inspector.js').trim();
  const executionTrace = readVerifiedRendererSource(effSrcDir, 'execution-trace.js').trim();
  const agentCollabHub = readVerifiedRendererSource(effSrcDir, 'agent-collab-hub.js').trim();
  const auditWidgets = readVerifiedRendererSource(effSrcDir, 'audit-widgets.js').trim();
  const crossSessionInsights = readVerifiedRendererSource(effSrcDir, 'cross-session-insights.js').trim();
  let mainTemplate = readVerifiedRendererSource(effSrcDir, 'main.js');
  if (!mainTemplate.trim()) throw new Error('Renderer entry point is empty: ' + path.join(effSrcDir, 'main.js'));
  const effAntigravitySvgPath = path.join(effSrcDir, 'assets', 'antigravity-color.svg');
  const antigravitySvgPath = fs.existsSync(effAntigravitySvgPath) ? effAntigravitySvgPath : path.join(srcDir, 'assets', 'antigravity-color.svg');
  const antigravitySvgRaw = fs.readFileSync(antigravitySvgPath, 'utf8').trim();
  assertNoTruncationMarker(antigravitySvgPath, antigravitySvgRaw);
  if (!/^<svg[\s>]/i.test(antigravitySvgRaw) || /<script\b|on[a-z]+\s*=|javascript:/i.test(antigravitySvgRaw)) {
    throw new Error(`[构建中止] Antigravity 静态 SVG 资源校验失败（禁止脚本或非静态内容）: ${antigravitySvgPath}`);
  }
  const antigravitySvgDataUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(antigravitySvgRaw);

  // 注入或同步构建期版本常量
  const versionConst = `  const METER_VERSION = '${meterVersion}';\n`;
  if (mainTemplate.includes('const METER_VERSION =')) {
    mainTemplate = mainTemplate.replace(/const METER_VERSION = '[^']*';/, `const METER_VERSION = '${meterVersion}';`);
  } else {
    mainTemplate = mainTemplate.replace(/\(function \(\) \{/, `(function () {\n${versionConst}`);
  }
  if (mainTemplate.includes('const METER_DISPLAY_VERSION =')) {
    mainTemplate = mainTemplate.replace(/const METER_DISPLAY_VERSION = '[^']*';/, `const METER_DISPLAY_VERSION = '${displayVersion}';`);
  } else {
    mainTemplate = mainTemplate.replace(/const METER_VERSION = '[^']*';/, m => `${m}\n  const METER_DISPLAY_VERSION = '${displayVersion}';`);
  }

  const domString = `  shadow.innerHTML = \`<style>\n    ${styles.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\n  </style>\n\n  ${template.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;`;

  let output = mainTemplate
    .replace('  /* @INSERT_STYLES_AND_TEMPLATE */', () => domString)
    .replace('  /* @INSERT_I18N_MODULE */', () => i18n)
    .replace('  /* @INSERT_BUDGET_ENGINE_MODULE */', () => budgetEngine)
    .replace('  /* @INSERT_COLORS_MODULE */', () => colors)
    .replace('  /* @INSERT_DROPDOWN_MODULE */', () => dropdown)
    .replace('  /* @INSERT_DASHBOARD_GRID_MODULE */', () => dashboardGrid)
    .replace('  /* @INSERT_TREND_PULSE_MODULE */', () => trendPulse)
    .replace('  /* @INSERT_CONTEXT_INSPECTOR_MODULE */', () => contextInspector)
    .replace('  /* @INSERT_EXECUTION_TRACE_MODULE */', () => executionTrace)
    .replace('  /* @INSERT_AGENT_COLLAB_MODULE */', () => agentCollabHub)
    .replace('  /* @INSERT_AUDIT_WIDGETS_MODULE */', () => auditWidgets)
    .replace('  /* @INSERT_CROSS_SESSION_INSIGHTS_MODULE */', () => crossSessionInsights)
    .replace('  /* @INSERT_HEATMAP_MODULE */', () => heatmap)
    .replace('__AG_ANTIGRAVITY_COLOR_SVG_DATA_URI__', () => antigravitySvgDataUri);

  const buildId = require('node:crypto').createHash('sha256').update(output).digest('hex').slice(0, 16);
  output = output.replace('__AG_RENDER_BUILD_ID__', buildId);
  fs.writeFileSync(effTargetFile, output, 'utf8');
  console.log(`[构建成功] 渲染层构建完成: ${effTargetFile} (v${meterVersion}, ${Buffer.byteLength(output, 'utf8')} 字节)`);
}

if (require.main === module) {
  buildRenderer();
}

module.exports = { buildRenderer, assertNoTruncationMarker };
