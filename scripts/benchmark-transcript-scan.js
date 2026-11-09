'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { collectTokenHistoryAsync } = require('../meter-collector');

async function runBenchmark() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bench-transcripts-'));
  const brainDir = path.join(tempDir, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });

  console.log('[基准测试] 正在生成大体量隔离 transcript 测试数据集...');
  const numSessions = 50;
  const eventsPerSession = 800; // 50 个会话，共 40,000 个事件
  let totalBytes = 0;

  for (let s = 0; s < numSessions; s++) {
    const sessionDir = path.join(brainDir, `session_${s}`, '.system_generated', 'logs');
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, 'transcript.jsonl');

    let content = '';
    for (let e = 0; e < eventsPerSession; e++) {
      const dayOffset = (s * 3 + Math.floor(e / 50)) % 180;
      const d = new Date(Date.now() - dayOffset * 86400000);
      const event = {
        step_index: e,
        callId: `call_sess_${s}_evt_${e}`,
        created_at: d.toISOString(),
        chatModel: {
          model: (e % 2 === 0) ? 'gemini-3.8-flash-high' : 'gemini-3.1-pro-preview',
          usage: {
            inputTokens: 1200 + (e % 500),
            outputTokens: 350 + (e % 200),
            cacheReadTokens: (e % 3 === 0) ? 800 : 0,
            thinkingOutputTokens: 64
          }
        },
        payload_preview: '这是一段典型的模拟上下文分析对话文本与工具调用参数...'.repeat(5)
      };
      content += JSON.stringify(event) + '\n';
    }
    fs.writeFileSync(filePath, content, 'utf8');
    totalBytes += Buffer.byteLength(content, 'utf8');
  }

  const mbSize = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`[基准测试] 数据集准备完毕: 会话数=${numSessions}, 总事件行数=${numSessions * eventsPerSession}, 总文件体积=${mbSize} MB`);

  // 监控事件循环延迟
  let maxLagMs = 0;
  let lastCheck = performance.now();
  const lagInterval = setInterval(() => {
    const now = performance.now();
    const lag = now - lastCheck - 5; // 预期 5ms
    if (lag > maxLagMs) maxLagMs = lag;
    lastCheck = now;
  }, 5);

  const memBefore = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  // 执行真实扫描
  const result = await collectTokenHistoryAsync({ agDir: tempDir, force: true });

  const durationMs = performance.now() - startTime;
  const memAfter = process.memoryUsage().heapUsed;
  clearInterval(lagInterval);

  const memDiffMb = ((memAfter - memBefore) / 1024 / 1024).toFixed(2);

  console.log('----------------------------------------------------');
  console.log(`[基准测试结果] 扫描耗时: ${durationMs.toFixed(2)} ms`);
  console.log(`[基准测试结果] 内存增长: ${memDiffMb} MB`);
  console.log(`[基准测试结果] 最大事件循环延迟: ${maxLagMs.toFixed(2)} ms`);
  console.log(`[基准测试结果] 累计统计 Token 总数: ${result.summary?.grandTotalTokens}`);
  console.log(`[基准测试结果] 活跃天数: ${result.summary?.activeDaysCount}`);
  console.log('----------------------------------------------------');

  // 清理隔离测试目录
  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    sessions: numSessions,
    totalEvents: numSessions * eventsPerSession,
    totalSizeMb: mbSize,
    durationMs,
    maxLagMs,
    memDiffMb
  };
}

runBenchmark().then(res => {
  fs.writeFileSync(path.join(__dirname, 'benchmark_result.json'), JSON.stringify(res, null, 2));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
