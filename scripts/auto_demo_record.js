'use strict';
/**
 * Antigravity Context & Token Meter v0.8.0
 * 全自动 120 秒产品演示控制脚本 (专为 Recordly / 屏幕录制调校)
 * 
 * 原理：通过 CDP 连接当前运行的 Antigravity 宿主页面，
 * 注入平滑虚拟光标与真实交互事件，毫秒级严格控制运镜节奏与停顿。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCdpTarget() {
  const portFile = path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) {
    throw new Error('未找到 Antigravity 调试端口文件，请确保客户端正在运行');
  }
  const cdpPort = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
  const target = pages.find(x => x.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(x.url));
  if (!target) throw new Error('未找到 Antigravity 主聊天页面');
  return { target, cdpPort };
}

async function main() {
  console.log('======================================================');
  console.log('🎬 Antigravity Context Meter v0.8.0 全自动演示录制脚本');
  console.log('======================================================\n');
  
  const { target, cdpPort } = await getCdpTarget();
  console.log(`[1/3] 已连接 Antigravity 客户端 (端口: ${cdpPort}, ID: ${target.id.slice(0, 8)}...)`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let reqId = 1;
  function evaluate(expr) {
    return new Promise(resolve => {
      const curId = ++reqId;
      const onMsg = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id === curId) {
          ws.removeEventListener('message', onMsg);
          resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({
        id: curId,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true }
      }));
    });
  }

  // 注入光标与演示执行引擎
  await evaluate(`
    (function initDemoRunner() {
      window.__demoEngine = window.__demoEngine || {};
      const host = document.getElementById('ag-context-meter');
      if (!host || !host.shadowRoot) return false;
      const sr = host.shadowRoot;

      // 1. 创建优雅的演示虚拟光标
      let cursor = document.getElementById('ag-demo-cursor');
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'ag-demo-cursor';
        cursor.innerHTML = \`
          <svg viewBox="0 0 24 24" width="22" height="22" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,0.45));transform:rotate(-15deg);">
            <path d="M4 2l16 11-7.5 1.5L9 21z" fill="#3b82f6" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
          <div class="click-pulse" style="position:absolute;top:0;left:0;width:24px;height:24px;border-radius:50%;background:rgba(59,130,246,0.4);transform:scale(0);opacity:0;pointer-events:none;"></div>
        \`;
        cursor.style.cssText = 'position:fixed;top:50px;left:50px;z-index:2147483647;pointer-events:none;transition:top 0.45s cubic-bezier(0.2,0.8,0.2,1), left 0.45s cubic-bezier(0.2,0.8,0.2,1);display:block;';
        document.body.appendChild(cursor);
      }

      window.__demoEngine = {
        host, sr, cursor,
        moveTo(x, y) {
          cursor.style.left = x + 'px';
          cursor.style.top = y + 'px';
        },
        moveToEl(selector) {
          const el = typeof selector === 'string' ? sr.querySelector(selector) : selector;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          this.moveTo(cx, cy);
          return { cx, cy, el };
        },
        pulseClick() {
          const p = cursor.querySelector('.click-pulse');
          if (p) {
            p.style.transition = 'none';
            p.style.transform = 'scale(0.2)';
            p.style.opacity = '1';
            requestAnimationFrame(() => {
              p.style.transition = 'transform 0.4s ease-out, opacity 0.4s ease-out';
              p.style.transform = 'scale(2.2)';
              p.style.opacity = '0';
            });
          }
        },
        clickEl(selector) {
          const res = this.moveToEl(selector);
          if (res) {
            this.pulseClick();
            res.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        },
        hoverEl(selector) {
          const res = this.moveToEl(selector);
          if (res) {
            res.el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            res.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          }
        }
      };
      return true;
    })()
  `);

  console.log('[2/3] 演示引擎注入就绪！准备倒计时 3 秒开始录制...');
  console.log('👉 请确保已在 Recordly 中点击“开始录制”\n');
  
  for (let i = 3; i >= 1; i--) {
    console.log(`⏱️ ${i}...`);
    await sleep(1000);
  }
  console.log('🚀 演示正式开始！总时长约 120 秒\n');

  // =========================================================================
  // 片段 1 (00:00 - 00:20): 当前会话上下文与附件审计
  // =========================================================================
  console.log('▶ [00:00 - 00:20] 片段 1: 当前会话上下文、速度监控与附件审计');
  await evaluate(`window.__demoEngine.hoverEl('#badge')`);
  await sleep(2500);

  await evaluate(`window.__demoEngine.clickEl('#badge')`);
  await sleep(2500);

  // 移向速度卡片
  await evaluate(`window.__demoEngine.moveToEl('#speed-summary')`);
  await sleep(2500);

  // 展开附件审计抽屉
  await evaluate(`window.__demoEngine.clickEl('#btn-toggle-details')`);
  await sleep(3500);

  // 查看附件尺寸
  await evaluate(`
    const imgItem = window.__demoEngine.sr.querySelector('.file');
    if (imgItem) window.__demoEngine.moveToEl(imgItem);
  `);
  await sleep(3500);

  // 收起抽屉
  await evaluate(`window.__demoEngine.clickEl('#btn-toggle-details')`);
  await sleep(1500);

  // =========================================================================
  // 片段 2 (00:20 - 00:55): Token 看板与 5 大周期视图轮播
  // =========================================================================
  console.log('▶ [00:20 - 00:55] 片段 2: Token 用量看板与 5 大周期视图轮播');
  // 切换至 Token 面板
  await evaluate(`window.__demoEngine.clickEl('#badge-tokens')`);
  await sleep(3000);

  // 巡览四大用量卡片底部费用
  await evaluate(`window.__demoEngine.moveToEl('#t-total-cost')`);
  await sleep(2000);
  await evaluate(`window.__demoEngine.moveToEl('#t-month-cost')`);
  await sleep(2000);

  // 每天网格 Tooltip
  await evaluate(`
    const cells = window.__demoEngine.sr.querySelectorAll('.heat-cell');
    if (cells.length > 10) window.__demoEngine.hoverEl(cells[cells.length - 2]);
  `);
  await sleep(2500);

  // 切换：每周
  console.log('   - 切换视图: 每周');
  await evaluate(`window.__demoEngine.clickEl('#h-tab-weekly')`);
  await sleep(3500);

  // 切换：每月 (满幅正方形网格)
  console.log('   - 切换视图: 每月');
  await evaluate(`window.__demoEngine.clickEl('#h-tab-monthly')`);
  await sleep(2500);
  // 翻页测试 (上月 -> 本月)
  await evaluate(`window.__demoEngine.clickEl('#h-page-prev')`);
  await sleep(2000);
  await evaluate(`window.__demoEngine.clickEl('#h-page-next')`);
  await sleep(2500);

  // 切换：今年 (12 个月气泡图)
  console.log('   - 切换视图: 今年 (气泡图)');
  await evaluate(`window.__demoEngine.clickEl('#h-tab-yearly')`);
  await sleep(2000);
  // 悬停在气泡上
  await evaluate(`
    const bubbles = window.__demoEngine.sr.querySelectorAll('.heat-yearly-bubble-group');
    if (bubbles.length > 0) window.__demoEngine.hoverEl(bubbles[bubbles.length - 1]);
  `);
  await sleep(3000);

  // 切换：累计总量 (增长面积曲线)
  console.log('   - 切换视图: 累计总量');
  await evaluate(`window.__demoEngine.clickEl('#h-tab-cum')`);
  await sleep(2500);
  // 移动至底部汇总条订阅性价比
  await evaluate(`window.__demoEngine.moveToEl('#h-summary-bar')`);
  await sleep(3000);

  // =========================================================================
  // 片段 3 (00:55 - 01:15): 5 档色阶自由定制
  // =========================================================================
  console.log('▶ [00:55 - 01:15] 片段 3: 5 档色阶加法定制系统');
  // 切回每天网格
  await evaluate(`window.__demoEngine.clickEl('#h-tab-daily')`);
  await sleep(1500);

  // 展开调色抽屉
  await evaluate(`window.__demoEngine.clickEl('#btn-panel-tokens-palette')`);
  await sleep(2000);

  // 点击绿色预设
  await evaluate(`
    const greenBtn = window.__demoEngine.sr.querySelector('.heat-preset-btn[data-heat-preset="green"]');
    if (greenBtn) window.__demoEngine.clickEl(greenBtn);
  `);
  await sleep(2000);

  // 点击黄色预设
  await evaluate(`
    const amberBtn = window.__demoEngine.sr.querySelector('.heat-preset-btn[data-heat-preset="yellow"]');
    if (amberBtn) window.__demoEngine.clickEl(amberBtn);
  `);
  await sleep(2000);

  // 点击紫色预设 (复原)
  await evaluate(`
    const purpleBtn = window.__demoEngine.sr.querySelector('.heat-preset-btn[data-heat-preset="purple"]');
    if (purpleBtn) window.__demoEngine.clickEl(purpleBtn);
  `);
  await sleep(2000);

  // 点击右下角图例第 5 档格子唤起独立调色盘
  await evaluate(`
    const lvl4 = window.__demoEngine.sr.querySelector('#heat-leg-4');
    if (lvl4) window.__demoEngine.clickEl(lvl4);
  `);
  await sleep(2500);

  // 点击空白处收起调色盘与抽屉
  await evaluate(`window.__demoEngine.clickEl('#panel-tokens-title')`);
  await sleep(1500);
  await evaluate(`window.__demoEngine.clickEl('#btn-panel-tokens-palette')`);
  await sleep(1500);

  // =========================================================================
  // 片段 4 (01:15 - 01:35): 在线热更新与 GitHub 入口
  // =========================================================================
  console.log('▶ [01:15 - 01:35] 片段 4: 在线热更新与 GitHub 仓库');
  // 点击检查更新按钮弹出 Popover
  await evaluate(`window.__demoEngine.clickEl('#btn-check-update')`);
  await sleep(3500);

  // 点击查看 Release 详情页面（模拟）或关闭
  await evaluate(`window.__demoEngine.clickEl('#btn-close-update-pop')`);
  await sleep(2000);

  // 移向 GitHub 图标
  await evaluate(`window.__demoEngine.moveToEl('#btn-github-repo')`);
  await sleep(2000);

  // =========================================================================
  // 片段 5 (01:35 - 01:50): 浅色/深色双主题切换
  // =========================================================================
  console.log('▶ [01:35 - 01:50] 片段 5: 浅色/深色主题无缝切换');
  await evaluate(`window.__demoEngine.clickEl('#theme-toggle-tokens')`);
  await sleep(3000);

  await evaluate(`window.__demoEngine.clickEl('#theme-toggle-tokens')`);
  await sleep(3000);

  // =========================================================================
  // 片段 6 (01:50 - 02:00): 优雅收尾
  // =========================================================================
  console.log('▶ [01:50 - 02:00] 片段 6: 定格全貌与优雅收尾');
  // 光标平滑移出屏幕边缘
  await evaluate(`window.__demoEngine.moveTo(-50, -50)`);
  await sleep(4000);

  // 清除虚拟光标
  await evaluate(`
    const c = document.getElementById('ag-demo-cursor');
    if (c) c.remove();
  `);

  console.log('\n🎉 [录制完成] 120 秒全流程演示已执行完毕！');
  console.log('👉 请在 Recordly 中点击“停止录制”，即可保存成片。');
  ws.close();
}

main().catch(err => {
  console.error('❌ 执行失败:', err.message);
  process.exit(1);
});
