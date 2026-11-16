'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { getAppDataDir } = require('./asar-engine');

const LOOPBACK_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;

function normalizeLoopbackOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const parsed = new URL(rawOrigin.trim());
    const origin = parsed.origin;
    const m = origin.match(LOOPBACK_ORIGIN_RE);
    if (!m) return null;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return origin;
  } catch {
    return null;
  }
}

function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(
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
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(text)
            : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        );
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
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
  const config = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
  if (!config) throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
  const token = JSON.parse(config[1]).csrfToken;
  if (!token) throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  return {
    origin,
    page,
    origins: Array.isArray(origins) && origins.length ? origins : [origin],
    call: async (method, body) =>
      JSON.parse(
        await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token)
      )
  };
}

/**
 * 连接到本地 Antigravity LanguageServerService。
 * 支持直接传入已知 `options.origin` 免 CDP/DevToolsActivePort 直连，亦可通过 CDP 发现所有运行窗口原点。
 */
async function connect(options = {}) {
  if (options && options.origin !== undefined && options.origin !== null && String(options.origin).trim() !== '') {
    const explicitOrigin = normalizeLoopbackOrigin(options.origin);
    if (!explicitOrigin) {
      throw new Error('非法的本机回环页面地址');
    }
    return connectOrigin(explicitOrigin, null, [explicitOrigin]);
  }
  let port;
  try {
    const portFile = path.join(getAppDataDir(options), 'Antigravity', 'DevToolsActivePort');
    port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Antigravity 本地连接尚未就绪，请稍后重试');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Antigravity 本地连接信息无效，请重新打开客户端');
  }
  const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`));
  const matchedPages = (Array.isArray(pages) ? pages : []).filter(
    item => item && item.type === 'page' && Boolean(normalizeLoopbackOrigin(item.url))
  );
  const page = matchedPages[0];
  if (!page) throw new Error('未找到 Antigravity 主窗口，请等待窗口加载后重试');
  const origins = Array.from(new Set(matchedPages.map(item => normalizeLoopbackOrigin(item.url)).filter(Boolean)));
  const targetOrigin = normalizeLoopbackOrigin(page.url);
  return connectOrigin(targetOrigin, page, origins);
}

module.exports = { connect, connectOrigin, normalizeLoopbackOrigin, getAppDataDir };
