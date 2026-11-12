'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

function getDevToolsPortFile() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  return path.join(appData, 'Antigravity', 'DevToolsActivePort');
}

function request(url, body, token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const req = (isHttps ? https : http).request(
      url,
      {
        agent: false,
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': token
            }
          : {}
      },
      response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          if (response.statusCode === 200) resolve(text);
          else reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// 轻量检测客户端 CDP 调试端口与主窗口页面是否存活（不依赖 language_server 是否忙碌或重启中）
async function pingCdp() {
  const portFile = getDevToolsPortFile();
  if (!fs.existsSync(portFile)) return { alive: false, reason: 'no_port_file' };
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  if (!Number.isFinite(port) || port <= 0) return { alive: false, reason: 'invalid_port' };
  const raw = await request(`http://127.0.0.1:${port}/json/list`, null, null, 2500);
  const pages = JSON.parse(raw);
  const page = Array.isArray(pages)
    ? pages.find(item => item.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(item.url))
    : null;
  const origin = page ? new URL(page.url).origin : null;
  return { alive: true, port, pages, page, origin };
}

async function connect() {
  const cdp = await pingCdp();
  if (!cdp.alive || !cdp.page || !cdp.origin) {
    throw new Error('Antigravity window not found');
  }
  const { origin, page } = cdp;
  let token = '';
  try {
    const html = await request(origin + '/', null, null, 5000);
    const matched = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\});/);
    if (matched) token = JSON.parse(matched[1]).csrfToken || '';
  } catch {}
  return {
    origin,
    page,
    call: async (method, body) => {
      let csrf = token;
      if (!csrf) {
        const html = await request(origin + '/', null, null, 5000);
        csrf = JSON.parse(html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\});/)[1]).csrfToken;
        token = csrf;
      }
      return JSON.parse(
        await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, csrf)
      );
    }
  };
}

module.exports = { connect, pingCdp };
