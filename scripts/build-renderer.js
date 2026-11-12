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

function buildRenderer() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const meterVersion = pkg.version || '0.8.1';

  const styles = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8').trim();
  let template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8').trim();
  template = template.replace(/<span id="v">v[^<]*<\/span>/g, `<span id="v">v${meterVersion}</span>`);
  template = template.replace(/<span id="up-pop-ver"[^>]*>v[^<]*<\/span>/g, `<span id="up-pop-ver" class="key-pill pill-good" style="font-size:10px">v${meterVersion}</span>`);

  const colors = fs.readFileSync(path.join(srcDir, 'colors.js'), 'utf8').trim();
  const dropdown = fs.readFileSync(path.join(srcDir, 'dropdown.js'), 'utf8').trim();
  const heatmap = fs.readFileSync(path.join(srcDir, 'heatmap.js'), 'utf8').trim();
  let mainTemplate = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');

  // 注入或同步构建期版本常量
  const versionConst = `  const METER_VERSION = '${meterVersion}';\n`;
  if (mainTemplate.includes('const METER_VERSION =')) {
    mainTemplate = mainTemplate.replace(/const METER_VERSION = '[^']*';/, `const METER_VERSION = '${meterVersion}';`);
  } else {
    mainTemplate = mainTemplate.replace(/\(function \(\) \{/, `(function () {\n${versionConst}`);
  }

  const domString = `  shadow.innerHTML = \`<style>\n    ${styles.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\n  </style>\n\n  ${template.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;`;

  let output = mainTemplate
    .replace('  /* @INSERT_STYLES_AND_TEMPLATE */', () => domString)
    .replace('  /* @INSERT_COLORS_MODULE */', () => colors)
    .replace('  /* @INSERT_DROPDOWN_MODULE */', () => dropdown)
    .replace('  /* @INSERT_HEATMAP_MODULE */', () => heatmap);

  fs.writeFileSync(targetFile, output, 'utf8');
  console.log(`[构建成功] 渲染层构建完成: ${targetFile} (v${meterVersion}, ${Buffer.byteLength(output, 'utf8')} 字节)`);
}

if (require.main === module) {
  buildRenderer();
}

module.exports = { buildRenderer };
