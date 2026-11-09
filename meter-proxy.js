'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';

/**
 * 获取代理配置文件候选路径列表（动态探测，杜绝任何硬编码的机器私有绝对路径）
 */
function getProxyCandidatePaths(customPath = null) {
  const candidates = [];
  if (process.env.ANTIGRAVITY_PROXY_CONFIG) {
    candidates.push(path.resolve(process.env.ANTIGRAVITY_PROXY_CONFIG));
  }
  if (customPath && typeof customPath === 'string') {
    candidates.push(path.resolve(customPath));
  }
  const localBase = process.env.LOCALAPPDATA || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local')
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')));

  candidates.push(
    path.join(localBase, 'AntigravityContextMeter', 'proxy.json'),
    path.join(localBase, 'AntigravityProxyNoTun', 'config.json')
  );

  return candidates;
}

/**
 * 探测并解析代理配置（统一主进程与 CLI 语义，一致处理 enabled:false / 语法错误 / 空配置）
 */
function detectProxyConfig(options = {}) {
  const candidates = options.candidates || getProxyCandidatePaths(options.configPath);
  const fsImpl = options.fs || fs;

  for (const cfgPath of candidates) {
    try {
      if (!fsImpl.existsSync(cfgPath)) continue;
      const content = fsImpl.readFileSync(cfgPath, 'utf8');
      if (!content || !content.trim()) continue;
      const cfg = JSON.parse(content);
      if (!cfg || typeof cfg !== 'object') continue;

      // 明确处理 enabled: false：当用户显式禁用代理时停止探测并不应用代理
      if (cfg.enabled === false) {
        return {
          detected: true,
          enabled: false,
          configPath: cfgPath
        };
      }

      const httpProxy = cfg.httpProxy || cfg.proxyUrl || null;
      if (!httpProxy) continue;

      const noProxy = cfg.noProxy || cfg.bypassList || DEFAULT_NO_PROXY;
      const allProxy = cfg.allProxy || httpProxy;

      return {
        detected: true,
        enabled: true,
        configPath: cfgPath,
        httpProxy,
        allProxy,
        noProxy
      };
    } catch {
      // 遇到语法无效或读取错误的文件，跳过并尝试下一个候选
      continue;
    }
  }

  return {
    detected: false,
    enabled: false,
    configPath: null
  };
}

/**
 * 将探测到的代理配置应用到指定环境变量对象中（已有环境变量优先）
 */
function applyProxyEnvironment(targetEnv = process.env, options = {}) {
  const detected = detectProxyConfig(options);
  if (!detected.enabled || !detected.httpProxy) {
    return targetEnv;
  }

  const { httpProxy, allProxy, noProxy } = detected;

  // 保持已有环境变量高优先级：仅当 targetEnv 中该键未设或为空时注入
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    if (!targetEnv[k]) targetEnv[k] = httpProxy;
  }

  if (allProxy) {
    for (const k of ['ALL_PROXY', 'all_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = allProxy;
    }
  }

  if (noProxy) {
    for (const k of ['NO_PROXY', 'no_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = noProxy;
    }
  }

  return targetEnv;
}

/**
 * 为 CLI 子进程组装代理环境（剥离 Electron 运行时变量并确保终端色彩）
 */
function buildCliProxyEnv(baseEnv = process.env, options = {}) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;

  applyProxyEnvironment(env, options);

  // 恢复 Windows 交互式 CLI 子进程环境的原生彩虹渐变 Logo 与颜色能力
  if (process.platform === 'win32') {
    delete env.NO_COLOR;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
  }

  return env;
}

module.exports = {
  DEFAULT_NO_PROXY,
  getProxyCandidatePaths,
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv
};
