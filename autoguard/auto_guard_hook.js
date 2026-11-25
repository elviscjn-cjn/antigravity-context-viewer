'use strict';
/**
 * Antigravity Auto Smart Approval PreToolUse Hook (autoguard/auto_guard_hook.js)
 * Works via Antigravity's official PreToolUse lifecycle hook protocol (~/.gemini/config/hooks.json):
 *   stdin:  { toolCall: { name, args }, workspacePaths, ... }
 *   stdout: { decision: "auto_approve" | "force_ask" | "deny" | "allow", reason }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content'
]);

const DEFAULT_RULES = {
  denyRules: [
    {
      id: 'deny-disk-wipe',
      label: '磁盘格式化 / 分区破坏 (format / diskpart / dd / mkfs)',
      pattern: '(^|[\\s;|&])(format\\s+[a-z]:|diskpart|cipher\\s+/w|dd\\s+if=|mkfs\\b)',
      enabled: true
    },
    {
      id: 'deny-root-wipe',
      label: '系统盘或根目录递归删除 (rm -rf / 或删盘符根目录)',
      pattern: '(rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+(/|[a-z]:\\\\?\\s*$)|rd\\s+/s\\s+/q\\s+[a-z]:\\\\\\s*$|Remove-Item\\b.*[a-z]:\\\\["\']?\\s+.*-Recurse)',
      enabled: true
    }
  ],
  askRules: [
    {
      id: 'ask-recursive-delete',
      label: '递归或强制删除文件/目录 (rm -rf / Remove-Item -Recurse / rd /s)',
      pattern: '(\\brm\\s+-[a-z]*[rf]|\\bRemove-Item\\b.*-(Recurse|Force)|\\brd\\s+/s|\\brmdir\\s+/s|\\bdel\\s+/[sfq])',
      enabled: true
    },
    {
      id: 'ask-git-destructive',
      label: '高危 Git 操作 (push --force / reset --hard / clean -f / branch -D / rebase)',
      pattern: '\\bgit\\s+(push\\s+.*(--force|-f\\b|--force-with-lease)|reset\\s+--hard|clean\\s+-[a-z]*f|branch\\s+-D|rebase\\b)',
      enabled: true
    },
    {
      id: 'ask-remote-pipe-exec',
      label: '远程脚本下载并直接执行 (irm/curl/wget | iex/bash/sh)',
      pattern: '(irm|Invoke-RestMethod|Invoke-WebRequest|curl|wget)\\b.*\\|\\s*(iex|Invoke-Expression|bash|sh|pwsh|powershell)',
      enabled: true
    },
    {
      id: 'ask-system-reg-proc',
      label: '注册表/系统服务/强制杀进程/关机网络配置',
      pattern: '(\\breg\\s+(add|delete|import)|\\btaskkill\\s+/f|\\bsc(\\.exe)?\\s+(delete|stop|config)|\\bshutdown\\b|\\bbcdedit\\b|\\bnetsh\\b|\\bSet-ExecutionPolicy\\b)',
      enabled: true
    },
    {
      id: 'ask-sensitive-paths',
      label: '敏感凭据路径 (.ssh / .aws / .git-credentials / .env / 私钥)',
      pattern: '(\\.ssh[/\\\\]|\\.aws[/\\\\]|\\.git-credentials|(^|[/\\\\\\s"\'])\\.env(\\b|\\.)|id_rsa|id_ed25519)',
      enabled: true
    },
    {
      id: 'ask-global-pkg',
      label: '全局软件包安装或卸载 (npm -g / winget / choco / scoop)',
      pattern: '(\\bnpm\\s+(install|i|uninstall|rm)\\s+.*(-g|--global)|\\bwinget\\s+(install|uninstall|upgrade)|\\bchoco\\s+(install|uninstall)|\\bscoop\\s+(install|uninstall))',
      enabled: true
    }
  ],
  allowRules: [
    {
      id: 'allow-git-readonly',
      label: '只读 Git 检查 (status / diff / log / branch / show / rev-parse)',
      pattern: '^\\s*git\\s+(status|diff|log|branch|show|rev-parse|remote\\s+-v|ls-files)\\b',
      enabled: true
    },
    {
      id: 'allow-dev-build-test',
      label: '常见开发构建与测试命令 (npm/pnpm/yarn/pytest/python/node/go/cargo/dotnet)',
      pattern: '^\\s*(npm|pnpm|yarn|npx|pytest|python|py|node|go|cargo|dotnet)\\s+(test|run|build|check|lint|fmt|typecheck|--version|-v|list)\\b',
      enabled: true
    },
    {
      id: 'allow-pwsh-readonly',
      label: 'PowerShell 只读查询 (Get-ChildItem / Get-Content / Test-Path / Select-String)',
      pattern: '^\\s*(Get-ChildItem|Get-Content|Test-Path|Select-String|Get-Command|Get-Item|Get-Process|Write-Output)\\b',
      enabled: true
    }
  ]
};

function resolveStateDir(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return path.resolve(options.stateDir.trim());
  }
  if (process.env.AG_METER_STATE_DIR && process.env.AG_METER_STATE_DIR.trim()) {
    return path.resolve(process.env.AG_METER_STATE_DIR.trim());
  }
  const home = options.homeDir || os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AntigravityContextMeter');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'AntigravityContextMeter');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'AntigravityContextMeter');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadEffectiveConfig(options = {}) {
  const stateDir = resolveStateDir(options);
  const modCfg = readJsonSafe(path.join(stateDir, 'modules.json'));
  const agCfg = modCfg && modCfg.modules && modCfg.modules.autoguard ? modCfg.modules.autoguard : {};
  const customRules = readJsonSafe(path.join(stateDir, 'autoguard_rules.json')) || {};
  const validModes = new Set(['smart', 'strict_auto', 'guard_only']);
  const mode = validModes.has(agCfg.mode) ? agCfg.mode : 'smart';
  return {
    stateDir,
    enabled: agCfg.enabled !== false,
    mode,
    protectOutsideWorkspace: agCfg.protectOutsideWorkspace !== false,
    denyRules: Array.isArray(customRules.denyRules) ? customRules.denyRules : DEFAULT_RULES.denyRules,
    askRules: Array.isArray(customRules.askRules) ? customRules.askRules : DEFAULT_RULES.askRules,
    allowRules: Array.isArray(customRules.allowRules) ? customRules.allowRules : DEFAULT_RULES.allowRules
  };
}

function extractToolTarget(toolCall) {
  const name = String(toolCall?.name || '').trim();
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  if (name === 'run_command') {
    const cmd = String(args.CommandLine ?? args.command ?? args.cmd ?? '').trim();
    return { kind: 'command', toolName: name, target: cmd };
  }
  if (FILE_WRITE_TOOLS.has(name)) {
    const filePath = String(args.Path ?? args.TargetFile ?? args.AbsolutePath ?? args.path ?? '').trim();
    return { kind: 'file', toolName: name, target: filePath };
  }
  return { kind: 'other', toolName: name, target: JSON.stringify(args).slice(0, 300) };
}

function normalizeForCompare(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p) return '';
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = p.replace(/^file:\/\/\/?/i, '');
    }
  }
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideWorkspaces(filePath, workspacePaths, homeDir = os.homedir()) {
  if (!filePath) return true;
  if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) return true;
  const targetNorm = normalizeForCompare(filePath);
  if (!targetNorm) return true;

  const safeRoots = [
    ...workspacePaths,
    path.join(homeDir, '.gemini', 'antigravity')
  ];

  for (const root of safeRoots) {
    const rootNorm = normalizeForCompare(root);
    if (!rootNorm) continue;
    if (targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function matchFirstRule(rules, targetText) {
  if (!targetText || !Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || rule.enabled === false || typeof rule.pattern !== 'string' || !rule.pattern.trim()) continue;
    try {
      const re = new RegExp(rule.pattern, 'i');
      if (re.test(targetText)) return rule;
    } catch {}
  }
  return null;
}

function evaluateToolCallPure(input, config = {}) {
  const { kind, toolName, target } = extractToolTarget(input?.toolCall);
  const workspacePaths = Array.isArray(input?.workspacePaths) ? input.workspacePaths : [];
  const cfg = {
    enabled: config.enabled !== false,
    mode: ['smart', 'strict_auto', 'guard_only'].includes(config.mode) ? config.mode : 'smart',
    protectOutsideWorkspace: config.protectOutsideWorkspace !== false,
    denyRules: Array.isArray(config.denyRules) ? config.denyRules : DEFAULT_RULES.denyRules,
    askRules: Array.isArray(config.askRules) ? config.askRules : DEFAULT_RULES.askRules,
    allowRules: Array.isArray(config.allowRules) ? config.allowRules : DEFAULT_RULES.allowRules
  };

  if (!cfg.enabled) {
    return {
      decision: 'allow',
      reason: 'Auto 智能审批已关闭，交由宿主默认策略处理',
      source: 'disabled',
      matchedRule: null,
      kind,
      toolName,
      target
    };
  }

  const denyMatch = matchFirstRule(cfg.denyRules, target);
  if (denyMatch) {
    return {
      decision: 'deny',
      reason: `[Auto Guard 硬拦截] 命中规则「${denyMatch.label || denyMatch.id}」`,
      source: 'deny_rule',
      matchedRule: denyMatch.label || denyMatch.id,
      kind,
      toolName,
      target
    };
  }

  const askMatch = matchFirstRule(cfg.askRules, target);
  if (askMatch) {
    return {
      decision: 'force_ask',
      reason: `[Auto Guard 风险确认] 命中高危规则「${askMatch.label || askMatch.id}」，请人工确认`,
      source: 'ask_rule',
      matchedRule: askMatch.label || askMatch.id,
      kind,
      toolName,
      target
    };
  }

  if (
    kind === 'file' &&
    cfg.protectOutsideWorkspace &&
    workspacePaths.length > 0 &&
    !isPathInsideWorkspaces(target, workspacePaths)
  ) {
    return {
      decision: 'force_ask',
      reason: `[Auto Guard 边界保护] 文件位于当前工作区外 (${target})，请人工确认`,
      source: 'outside_workspace',
      matchedRule: '工作区外文件修改保护',
      kind,
      toolName,
      target
    };
  }

  if (cfg.mode === 'guard_only') {
    return {
      decision: 'allow',
      reason: 'Auto Guard 仅高危护栏模式：未命中高危规则，交由宿主策略处理',
      source: 'guard_only',
      matchedRule: null,
      kind,
      toolName,
      target
    };
  }

  const allowMatch = matchFirstRule(cfg.allowRules, target);
  if (allowMatch) {
    return {
      decision: 'auto_approve',
      reason: `[Auto Guard 自动放行] 命中安全白名单「${allowMatch.label || allowMatch.id}」`,
      source: 'allow_rule',
      matchedRule: allowMatch.label || allowMatch.id,
      kind,
      toolName,
      target
    };
  }

  if (kind === 'file') {
    return {
      decision: 'auto_approve',
      reason: '[Auto Guard 自动放行] 工作区内文件编辑',
      source: 'workspace_file',
      matchedRule: '工作区内文件修改',
      kind,
      toolName,
      target
    };
  }

  if (cfg.mode === 'strict_auto') {
    return {
      decision: 'force_ask',
      reason: '[Auto Guard 严格白名单] 命令未匹配安全白名单，请人工确认',
      source: 'strict_fallback',
      matchedRule: null,
      kind,
      toolName,
      target
    };
  }

  return {
    decision: 'auto_approve',
    reason: '[Auto Guard 智能放行] 未命中高危或越界规则',
    source: 'smart_default',
    matchedRule: null,
    kind,
    toolName,
    target
  };
}

function appendAuditEntrySafe(stateDir, entry) {
  try {
    const auditPath = path.join(stateDir, 'autoguard_audit.json');
    const current = readJsonSafe(auditPath);
    const list = Array.isArray(current) ? current : [];
    list.unshift({
      ts: new Date().toISOString(),
      toolName: entry.toolName || '',
      decision: entry.decision || 'allow',
      source: entry.source || '',
      matchedRule: entry.matchedRule || null,
      target: String(entry.target || '').slice(0, 220)
    });
    if (list.length > 60) list.length = 60;
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${auditPath}.tmp_${process.pid}_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, auditPath);
  } catch {}
}

async function runCliHook() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'allow', reason: '' }));
    return;
  }

  let input = {};
  try {
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'Auto Guard: invalid JSON input ignored' }));
    return;
  }

  const cfg = loadEffectiveConfig();
  const res = evaluateToolCallPure(input, cfg);
  if (cfg.enabled) {
    appendAuditEntrySafe(cfg.stateDir, res);
  }
  process.stdout.write(JSON.stringify({
    decision: res.decision,
    reason: res.reason
  }));
}

if (require.main === module) {
  void runCliHook();
}

module.exports = {
  DEFAULT_RULES,
  resolveStateDir,
  loadEffectiveConfig,
  extractToolTarget,
  isPathInsideWorkspaces,
  evaluateToolCallPure,
  runCliHook
};
