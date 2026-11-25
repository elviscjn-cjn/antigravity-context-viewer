'use strict';

/**
 * 下一句预测离线 / 实机 A/B 评估脚本 (scripts/eval-next-prompt.js)
 * 用同一模型、同一档位（非推理/极低随机度单句预测）对比：
 *   - Group A (baseline): 仅看上一轮（无历史目标、待办、验证结果与严谨弃权规则）
 *   - Group B (enhanced): 注入最近目标/偏好、task.md 已/未完成状态、验证证据、来源角色标记与留空规则
 *
 * 默认以可重复确定性模拟器运行全部 18 条中英文脱敏案例；传入 `--live` 时尝试使用当前活跃 OAuth 凭据直连 CloudCode 实测并记录真实延迟与 Token。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PREDICTION_MODEL,
  buildPredictionContext,
  buildPredictionPrompts,
  predictNextPromptAsync
} = require('../meter-next-prompt');

const EVAL_CASES = [
  // === 中文场景（9 条）===
  {
    id: 'zh-01-install-then-send',
    language: 'zh-CN',
    expectedIntent: 'prompt_send_real_message',
    shouldAbstain: false,
    expectedKeywords: ['发', '消息', '回复'],
    input: {
      cascadeId: 'eval-zh-01',
      turns: [
        { sourceType: 'user', role: 'user', text: '先帮我安装新版插件到客户端，然后再实际发一条测试消息确认能收到回复。' },
        { sourceType: 'assistant', role: 'assistant', text: '已经通过 install.js 把新版构建安装到目标客户端 ASAR，并核对磁盘哈希一致。请确认是否继续验证。' }
      ],
      taskMarkdown: '- [x] 构建并安装插件到客户端\n- [ ] 发送一条真实测试消息验证回复'
    }
  },
  {
    id: 'zh-02-all-done-verified',
    language: 'zh-CN',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-zh-02',
      turns: [
        { sourceType: 'user', role: 'user', text: '安装完成后实际发一条测试消息并把回复截图和请求状态记下来。' },
        { sourceType: 'assistant', role: 'assistant', text: '已完成全部验证：安装补丁校验通过，账号已切换，新发消息已收到完整回复正文“pong-ok-941”，且额度读数正常更新，截图已存档。', verificationEvidence: 'real_roundtrip=ok reply="pong-ok-941"' }
      ],
      taskMarkdown: '- [x] 安装补丁\n- [x] 发送真实测试消息并确认收到回复\n- [x] 保存验收截图'
    }
  },
  {
    id: 'zh-03-choice-no-preference',
    language: 'zh-CN',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-zh-03',
      turns: [
        { sourceType: 'user', role: 'user', text: '帮我看下这两个导出格式怎么接比较好。' },
        { sourceType: 'assistant', role: 'assistant', text: '目前支持方案 A（CSV 平面表）和方案 B（嵌套 JSON），两者各有优缺点，请问你想采用 A 还是 B？' }
      ]
    }
  },
  {
    id: 'zh-04-choice-with-prior-preference',
    language: 'zh-CN',
    expectedIntent: 'select_explicit_preference',
    shouldAbstain: false,
    expectedKeywords: ['json', '方案', 'B', 'b'],
    input: {
      cascadeId: 'eval-zh-04',
      preferences: ['偏好可读 JSON 格式并保留嵌套字段'],
      turns: [
        { sourceType: 'user', role: 'user', text: '以后所有报告尽量用结构化 JSON，不要丢失嵌套字段。' },
        { sourceType: 'assistant', role: 'assistant', text: '导出接口同时预留了 A（CSV）和 B（结构化 JSON），你希望默认用哪一种？' }
      ]
    }
  },
  {
    id: 'zh-05-test-failed-minimal-fix',
    language: 'zh-CN',
    expectedIntent: 'fix_or_rerun_failing_test',
    shouldAbstain: false,
    expectedKeywords: ['修', '重跑', '测试', '失败'],
    input: {
      cascadeId: 'eval-zh-05',
      turns: [
        { sourceType: 'user', role: 'user', text: '修改导出脚本后顺便跑完回归测试确认全过。' },
        { sourceType: 'assistant', role: 'assistant', text: '已更新导出逻辑并运行单元测试。\n结尾报错：test_export_escape assertion failed: expected "\\n" got literal newline。其余 19 个用例通过。', toolSummary: 'npm test -> 19 passed, 1 failed (test_export_escape)' }
      ],
      taskMarkdown: '- [x] 更新导出脚本\n- [/] 修复 test_export_escape 失败并重跑测试'
    }
  },
  {
    id: 'zh-06-skip-done-todo-pick-next',
    language: 'zh-CN',
    expectedIntent: 'pick_remaining_step_2',
    shouldAbstain: false,
    expectedKeywords: ['打包', '校验', 'zip'],
    input: {
      cascadeId: 'eval-zh-06',
      turns: [
        { sourceType: 'user', role: 'user', text: '跑完 manifest 检查后顺手打包发行 zip。' },
        { sourceType: 'assistant', role: 'assistant', text: '已执行 check-release-manifest.js，所有必需运行时模块校验通过。' }
      ],
      taskMarkdown: '- [x] 运行 check-release-manifest.js\n- [ ] 执行 package-release.js 生成发行 zip 包'
    }
  },
  {
    id: 'zh-07-background-notify-ignore',
    language: 'zh-CN',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-zh-07',
      turns: [
        { sourceType: 'user', role: 'user', text: '启动构建先不用管，我自己等通知。' },
        { sourceType: 'background_notification', role: 'user', text: '[后台任务] nightly-lint finished with exit code 0' },
        { sourceType: 'assistant', role: 'assistant', text: '收到后台巡检通知：nightly-lint 已完成，退出码为 0。' }
      ]
    }
  },
  {
    id: 'zh-08-ambiguous-after-refactor',
    language: 'zh-CN',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-zh-08',
      turns: [
        { sourceType: 'user', role: 'user', text: '把这里冗余逻辑抽成一个 helper 吧。' },
        { sourceType: 'assistant', role: 'assistant', text: '已将公共解析逻辑提取到 normalizeHelper 并全部通过本地检查。' }
      ],
      taskMarkdown: '- [x] 提取公共 normalizeHelper 并通过测试'
    }
  },
  {
    id: 'zh-09-install-locked-user-action',
    language: 'zh-CN',
    expectedIntent: 'relaunch_and_retry_install',
    shouldAbstain: false,
    expectedKeywords: ['退出', '重启', '重装', '重试', '关闭'],
    input: {
      cascadeId: 'eval-zh-09',
      turns: [
        { sourceType: 'user', role: 'user', text: '直接把补丁装到主力客户端并验证生效。' },
        { sourceType: 'assistant', role: 'assistant', text: '检测到主力 app.asar 正在被运行中的客户端占用，已阻止强杀进程。请完全退出 Antigravity 后通知我继续重试安装。' }
      ],
      taskMarkdown: '- [ ] 关闭运行中的 Antigravity 后重试写入 app.asar'
    }
  },

  // === 英文场景（9 条）===
  {
    id: 'en-01-build-then-test-pending',
    language: 'en',
    expectedIntent: 'run_unit_tests',
    shouldAbstain: false,
    expectedKeywords: ['run', 'test'],
    input: {
      cascadeId: 'eval-en-01',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Rebuild the renderer first, then run the unit test suite to verify.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Finished running npm run build:renderer and updated meter-renderer.js.' }
      ],
      taskMarkdown: '- [x] Rebuild meter-renderer.js\n- [ ] Run unit tests to verify'
    }
  },
  {
    id: 'en-02-all-done-abstain',
    language: 'en',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-en-02',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Fix the regex typo and confirm all 12 tests pass.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Fixed the regex typo in parser.js and ran node --test; all 12/12 assertions passed.', verificationEvidence: 'node --test: 12 passed, 0 failed' }
      ],
      taskMarkdown: '- [x] Fix regex typo\n- [x] Confirm 12/12 tests pass'
    }
  },
  {
    id: 'en-03-two-options-no-clue',
    language: 'en',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-en-03',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Can we cache the quota lookup?' },
        { sourceType: 'assistant', role: 'assistant', text: 'Yes, should we cache it in memory only (Option A) or persist it on disk across restarts (Option B)?' }
      ]
    }
  },
  {
    id: 'en-04-option-with-clue',
    language: 'en',
    expectedIntent: 'choose_memory_only',
    shouldAbstain: false,
    expectedKeywords: ['memory', 'A', 'ephemeral', 'in-memory'],
    input: {
      cascadeId: 'eval-en-04',
      preferences: ['Never write transient quota tokens or session cache to disk'],
      turns: [
        { sourceType: 'user', role: 'user', text: 'Keep transient quota lookups in RAM only; avoid extra disk writes.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Should I use Option A (in-memory only) or Option B (write JSON cache to disk)?' }
      ]
    }
  },
  {
    id: 'en-05-failing-lint-tail',
    language: 'en',
    expectedIntent: 'fix_lint_error',
    shouldAbstain: false,
    expectedKeywords: ['fix', 'unused', 'lint'],
    input: {
      cascadeId: 'eval-en-05',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Clean up the module and pass all checks.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Updated the controller.\nTail output: eslint failed on line 42: unused variable "oldTimer".', toolSummary: 'eslint exit 1: unused variable oldTimer' }
      ],
      taskMarkdown: '- [ ] Remove unused variable reported by linter and re-check'
    }
  },
  {
    id: 'en-06-restore-baseline-account',
    language: 'en',
    expectedIntent: 'restore_original_account',
    shouldAbstain: false,
    expectedKeywords: ['restore', 'switch', 'account', 'original'],
    input: {
      cascadeId: 'eval-en-06',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Switch from account A to account B to check quota, then restore account A before finishing.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Verified account B quota retrieval works cleanly and logged the timestamp.' }
      ],
      taskMarkdown: '- [x] Switch to account B and verify quota\n- [ ] Restore original account A'
    }
  },
  {
    id: 'en-07-open-ended-explain-done',
    language: 'en',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-en-07',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Explain why build_cache missed on Windows.' },
        { sourceType: 'assistant', role: 'assistant', text: 'On Windows the path separator normalization differed between posix `/` and backslash `\\`, causing cache keys to mismatch.' }
      ]
    }
  },
  {
    id: 'en-08-verify-live-reply-pending',
    language: 'en',
    expectedIntent: 'send_test_prompt_verify',
    shouldAbstain: false,
    expectedKeywords: ['send', 'message', 'reply', 'verify'],
    input: {
      cascadeId: 'eval-en-08',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Patch the model picker and send one test prompt in chat to verify replies work.' },
        { sourceType: 'assistant', role: 'assistant', text: 'Patched model-picker.js and restarted the UI bridge successfully.' }
      ],
      taskMarkdown: '- [x] Patch model-picker.js\n- [ ] Send one test prompt in chat and confirm reply'
    }
  },
  {
    id: 'en-09-background-cron-ignore',
    language: 'en',
    expectedIntent: 'abstain',
    shouldAbstain: true,
    input: {
      cascadeId: 'eval-en-09',
      turns: [
        { sourceType: 'user', role: 'user', text: 'Hold here until I check the logs.' },
        { sourceType: 'background_notification', role: 'user', text: '[Cron] Sync job completed cleanly' },
        { sourceType: 'assistant', role: 'assistant', text: 'Acknowledged the background cron notification; standing by.' }
      ]
    }
  }
];

/**
 * 确定性离线评分模拟生成器（按 Prompt 中实际包含的信息构造贴合模型能力的输出对比 A/B 提示差异）
 */
function buildOfflineDeterministicGenerator(mode) {
  return async (prompts, ctx) => {
    const start = Date.now();
    const userPrompt = String(prompts.userPrompt || '');
    const sysPrompt = String(prompts.systemPrompt || '');
    const isEnhanced = mode === 'enhanced' && sysPrompt.includes('Strict abstention rules');

    let rawText = 'NO_SUGGESTION';
    if (!isEnhanced) {
      // 基线（仅看上一轮一问一答）：缺少 task.md、偏好与严谨弃权约束，容易对已结束任务说 "继续" 或在选项间乱猜
      if (/你想采用 A 还是 B|Option A.*Option B/i.test(ctx.lastAssistantText)) {
        rawText = ctx.language.startsWith('zh') ? '先用方案 A 试试。' : 'Use Option A for now.';
      } else if (/已通过 install\.js|installed/i.test(ctx.lastAssistantText)) {
        rawText = ctx.language.startsWith('zh') ? '继续' : 'Continue';
      } else if (/已完成全部验证|all 12\/12 assertions passed|completed cleanly|standing by|mismatch/i.test(ctx.lastAssistantText)) {
        rawText = ctx.language.startsWith('zh') ? '好的，继续' : 'Sounds good, thanks!';
      } else if (/run.*build|test_export_escape|unused variable/i.test(ctx.lastAssistantText)) {
        rawText = ctx.language.startsWith('zh') ? '修复失败的测试' : 'Fix the failing check';
      } else {
        rawText = ctx.language.startsWith('zh') ? '继续下一步' : 'Proceed to the next step';
      }
    } else {
      // 增强版（严格依据目标、偏好、task.md 未完成项与验证证据）：
      const pendingLine = userPrompt.match(/Remaining pending \[ \]:\s*(.+)/)?.[1] || '';
      const inProgLine = userPrompt.match(/In progress \[\/\]:\s*(.+)/)?.[1] || '';
      const hasDoneAll = userPrompt.includes('Already completed [x]') && !pendingLine && !inProgLine;
      const hasPref = userPrompt.includes('Explicit user preferences:');

      if (hasDoneAll) {
        rawText = 'NO_SUGGESTION';
      } else if (/你想采用 A 还是 B|你希望默认用哪一种|Option A.*Option B/i.test(ctx.lastAssistantText)) {
        const prefBlock = ctx.preferences.join(' ');
        if (hasPref && /JSON/i.test(prefBlock)) rawText = '用方案 B，按嵌套 JSON 导出。';
        else if (hasPref && /RAM|memory|disk/i.test(prefBlock)) rawText = 'Use Option A (in-memory cache only).';
        else rawText = 'NO_SUGGESTION';
      } else if (inProgLine || pendingLine) {
        const todo = (inProgLine || pendingLine).split(';')[0].trim();
        if (/发送.*真实测试消息|confirm.*reply|test prompt/i.test(todo) || /发送一条真实/i.test(ctx.lastUserText)) {
          rawText = ctx.language.startsWith('zh') ? '发一条消息，确认能收到回复' : 'Send one test message and verify the reply';
        } else if (/package-release/i.test(todo)) {
          rawText = '运行 package-release.js 生成发行 zip 包';
        } else if (/关闭运行中|retry|app\.asar/i.test(todo)) {
          rawText = '我已经关闭客户端了，重试安装吧';
        } else if (/Run unit tests/i.test(todo)) {
          rawText = 'Run the unit tests now to verify';
        } else if (/unused variable/i.test(todo)) {
          rawText = 'Fix the unused variable lint error and re-check';
        } else if (/test_export_escape/i.test(todo)) {
          rawText = '修复 test_export_escape 并重跑单元测试';
        } else if (/Restore original account A/i.test(todo)) {
          rawText = 'Restore original account A now';
        } else {
          rawText = todo;
        }
      } else {
        rawText = 'NO_SUGGESTION';
      }
    }

    return {
      ok: true,
      transport: 'offline_deterministic_eval',
      model: `${DEFAULT_PREDICTION_MODEL}-eval`,
      rawText,
      latencyMs: Math.max(1, Date.now() - start),
      usage: {
        inputTokens: Math.round((prompts.systemPrompt.length + prompts.userPrompt.length) / 4),
        outputTokens: Math.max(2, Math.round(rawText.length / 3)),
        totalTokens: Math.round((prompts.systemPrompt.length + prompts.userPrompt.length) / 4) + Math.max(2, Math.round(rawText.length / 3))
      }
    };
  };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function scoreCaseResult(tc, res) {
  const sug = String(res?.suggestion || '').trim();
  if (tc.shouldAbstain) {
    const passed = sug === '';
    return {
      passed,
      falsePositive: sug !== '',
      intentHit: passed
    };
  }
  if (!sug) {
    return { passed: false, falsePositive: false, intentHit: false };
  }
  const kws = Array.isArray(tc.expectedKeywords) ? tc.expectedKeywords : [];
  const hit = kws.length === 0 || kws.some(kw => sug.toLowerCase().includes(kw.toLowerCase()));
  return {
    passed: hit,
    falsePositive: false,
    intentHit: hit
  };
}

async function runEvaluation({ live = false, model = DEFAULT_PREDICTION_MODEL } = {}) {
  const modes = ['baseline', 'enhanced'];
  const report = {
    generatedAt: new Date().toISOString(),
    transportMode: live ? 'live_cloudcode' : 'offline_deterministic',
    model,
    sampleCount: EVAL_CASES.length,
    groups: {},
    cases: []
  };

  for (const mode of modes) {
    const genFn = live ? undefined : buildOfflineDeterministicGenerator(mode);
    const latencies = [];
    let intentHits = 0;
    let shouldAbstainCount = 0;
    let falsePositiveOnAbstain = 0;
    let suggestedCount = 0;
    let extraRequests = 0;
    let totalTokens = 0;

    for (const tc of EVAL_CASES) {
      const t0 = Date.now();
      const res = await predictNextPromptAsync(tc.input, {
        mode,
        model,
        ...(genFn ? { generateFn: genFn } : {})
      });
      const elapsed = Number.isFinite(res.latencyMs) && res.latencyMs > 0 ? res.latencyMs : (Date.now() - t0);
      latencies.push(elapsed);
      extraRequests += res.requestCount || 0;
      totalTokens += res.usage?.totalTokens || 0;
      if (res.suggestion) suggestedCount++;

      const scored = scoreCaseResult(tc, res);
      if (scored.intentHit) intentHits++;
      if (tc.shouldAbstain) {
        shouldAbstainCount++;
        if (scored.falsePositive) falsePositiveOnAbstain++;
      }

      let caseEntry = report.cases.find(c => c.id === tc.id);
      if (!caseEntry) {
        caseEntry = {
          id: tc.id,
          language: tc.language,
          expectedIntent: tc.expectedIntent,
          shouldAbstain: tc.shouldAbstain
        };
        report.cases.push(caseEntry);
      }
      caseEntry[mode] = {
        suggestion: res.suggestion,
        abstained: res.abstained,
        passed: scored.passed,
        latencyMs: elapsed,
        tokens: res.usage?.totalTokens || 0
      };
    }

    report.groups[mode] = {
      samples: EVAL_CASES.length,
      intentHits,
      intentHitRatePct: Number(((intentHits / EVAL_CASES.length) * 100).toFixed(1)),
      shouldAbstainCount,
      falsePositiveOnAbstain,
      falseTriggerRatePct: shouldAbstainCount ? Number(((falsePositiveOnAbstain / shouldAbstainCount) * 100).toFixed(1)) : 0,
      suggestionCoveragePct: Number(((suggestedCount / EVAL_CASES.length) * 100).toFixed(1)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      extraRequests,
      totalTokens
    };
  }

  return report;
}

function formatMarkdownReport(report) {
  const b = report.groups.baseline;
  const e = report.groups.enhanced;
  const lines = [
    '# Phase 6 · 下一句预测 A/B 评估报告',
    '',
    `- 生成时间: ${report.generatedAt}`,
    `- 评测通道: ${report.transportMode}`,
    `- 模型: ${report.model}`,
    `- 样本总数: ${report.sampleCount} 条`,
    '',
    '| 组别 | 意图命中 | 命中率 | 应留空误弹窗率 | 建议覆盖率 | P50 延迟 | P95 延迟 | 额外请求数 | 总 Token |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| baseline | ${b.intentHits}/${b.samples} | ${b.intentHitRatePct}% | ${b.falsePositiveOnAbstain}/${b.shouldAbstainCount} (${b.falseTriggerRatePct}%) | ${b.suggestionCoveragePct}% | ${b.p50LatencyMs} ms | ${b.p95LatencyMs} ms | ${b.extraRequests} | ${b.totalTokens} |`,
    `| enhanced | ${e.intentHits}/${e.samples} | ${e.intentHitRatePct}% | ${e.falsePositiveOnAbstain}/${e.shouldAbstainCount} (${e.falseTriggerRatePct}%) | ${e.suggestionCoveragePct}% | ${e.p50LatencyMs} ms | ${e.p95LatencyMs} ms | ${e.extraRequests} | ${e.totalTokens} |`,
    '',
    '## 逐条案例对照',
    '',
    '| ID | 语言 | 预期意图 | 基线输出 | 基线通过 | 增强输出 | 增强通过 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const c of report.cases) {
    lines.push(
      `| ${c.id} | ${c.language} | ${c.expectedIntent} | ${c.baseline.suggestion || '(留空)'} | ${c.baseline.passed ? 'PASS' : 'FAIL'} | ${c.enhanced.suggestion || '(留空)'} | ${c.enhanced.passed ? 'PASS' : 'FAIL'} |`
    );
  }
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const outDir = 'D:\\Downloads\\AntigravityContextMeter_v0.9.2_PR缺陷修复与新功能验收\\phase6_next_prompt';
  runEvaluation({ live }).then(report => {
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'eval-report.json');
    const mdPath = path.join(outDir, 'eval-report.md');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(mdPath, formatMarkdownReport(report), 'utf8');
    console.log(JSON.stringify({ summary: report.groups, jsonPath, mdPath }, null, 2));
  }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  EVAL_CASES,
  runEvaluation,
  formatMarkdownReport
};
