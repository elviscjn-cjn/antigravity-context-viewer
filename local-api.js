'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const LOOPBACK_ORIGIN_RE = /^https:\/\/127\.0\.0\.1:\d+$/;

function getAppDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA;
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config');
}

function normalizeLoopbackOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const parsed = new URL(rawOrigin.trim());
    const origin = parsed.origin;
    return LOOPBACK_ORIGIN_RE.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { agent: false, rejectUnauthorized: false, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

/**
 * 解析并缓存或实时提取指定本地页面原点的 CSRF Token 并构造 RPC 客户端。
 */
async function connectOrigin(rawOrigin, page = null, origins = null) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) {
    throw new Error('非法的本机回环页面地址');
  }
  const html = await request(origin + '/');
  const m = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
  if (!m) throw new Error('未能提取宿主 CSRF 令牌');
  const token = JSON.parse(m[1]).csrfToken;
  return {
    origin,
    page,
    origins: Array.isArray(origins) && origins.length ? origins : [origin],
    call: async (method, body) => JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token))
  };
}

/**
 * 连接到本地 Antigravity LanguageServerService。
 * 支持直接传入已知 `options.origin` 免 CDP/DevToolsActivePort 直连，亦可通过 CDP 发现所有运行窗口原点。
 */
async function connect(options = {}) {
  const explicitOrigin = normalizeLoopbackOrigin(options?.origin);
  if (explicitOrigin) {
    return connectOrigin(explicitOrigin, null, [explicitOrigin]);
  }
  const portFile = path.join(getAppDataDir(), 'Antigravity', 'DevToolsActivePort');
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`));
  const matchedPages = pages.filter(item => item.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(item.url));
  const page = matchedPages[0];
  if (!page) throw new Error('Antigravity window not found');
  const origins = Array.from(new Set(matchedPages.map(item => normalizeLoopbackOrigin(item.url)).filter(Boolean)));
  const targetOrigin = normalizeLoopbackOrigin(page.url);
  return connectOrigin(targetOrigin, page, origins);
}

module.exports = { connect, connectOrigin, normalizeLoopbackOrigin, getAppDataDir };
