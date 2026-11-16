'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { getAppDataDir } = require('./asar-engine');
function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { rejectUnauthorized: false, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function connect(options = {}) {
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
  const page = pages.find(item => item.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(item.url));
  if (!page) throw new Error('未找到 Antigravity 主窗口，请等待窗口加载后重试');
  const origin = new URL(page.url).origin;
  const html = await request(origin + '/');
  const config = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
  if (!config) throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
  const token = JSON.parse(config[1]).csrfToken;
  if (!token) throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  return { origin, page, call: async (method, body) => JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token)) };
}
module.exports = { connect };
