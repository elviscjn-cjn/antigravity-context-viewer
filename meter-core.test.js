const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, analyzeSteps, measure } = require('./meter-core');
const entry = (usage, context = {}) => ({ chatModel: { usage, chatStartMetadata: { contextWindowMetadata: context } } });
const exceeded = 'INVALID_ARGUMENT (code 400): The input token count exceeds the maximum number of tokens allowed 1048576.';
test('cache counted once, thinking not counted twice, backend budget preserved', () => {
  const d = summarize(entry({ inputTokens: '1000', cacheReadTokens: '8000', outputTokens: '1000', thinkingOutputTokens: '500' }, { maxContextTokens: 256000 }));
  assert.equal(d.actual, 10000); assert.equal(d.budget, 256000); assert.equal(d.serviceLimit, null); assert.equal(d.percent, 10000 / 256000 * 100);
});
test('failed upload with 127117 estimate overrides a previous successful retry and suppresses percent', () => {
  const d = entry({ inputTokens: 9000 }, { estimatedTokensUsed: 127117, maxContextTokens: 256000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: exceeded, usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, true); assert.equal(s.actual, null); assert.equal(s.estimate, 127117); assert.equal(s.serviceLimit, 1048576); assert.equal(s.percent, null); assert.equal(s.status, 'exceeded');
});
test('estimated input never produces a safe remaining percent or invented million limit', () => {
  const s = summarize(entry({}, { estimatedTokensUsed: 127117 }));
  assert.equal(s.percent, null); assert.equal(s.budget, null); assert.equal(s.serviceLimit, null); assert.equal(s.status, 'estimated');
});
test('output only is not evidence for full input context', () => assert.equal(summarize(entry({ outputTokens: 100 })).actual, null));
test('model without chat metadata remains unknown', () => assert.equal(summarize({}), null));
test('canonical upload and inline preview are not counted as separate attachments', () => {
  const s = analyzeSteps([{ userInput: { userResponse: 'hello', items: [{ text: 'hello', media: { mimeType: 'image/png', inlineData: 'preview' } }], media: [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx', description: 'a.xlsx' }] } }]);
  assert.equal(s.media.length, 1); assert.equal(s.groups.user.chars, 5);
});
test('full history keeps old messages and repeated upload occurrences; duplicate rendered reply counted once', () => {
  const media = [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx' }];
  const s = analyzeSteps([{ userInput: { userResponse: 'one', media } }, { plannerResponse: { response: 'answer', modifiedResponse: 'answer', thinking: 'thought' } }, { checkpoint: { sessionSummary: 'summary' } }, { userInput: { userResponse: 'two', media } }, { generic: { result: 'tool output' } }]);
  assert.equal(s.groups.user.chars, 6); assert.equal(s.groups.assistant.chars, 6); assert.equal(s.media[0].references, 2); assert.equal(s.groups.summaries.chars, 7); assert.ok(s.groups.tools.chars > 0);
});
test('old error cleared after later user/assistant steps', () => {
  const error = { errorMessage: { error: { shortError: exceeded } } };
  assert.ok(analyzeSteps([{ userInput: { userResponse: 'a' } }, error]).currentError);
  assert.equal(analyzeSteps([error, { userInput: { userResponse: 'b' } }]).currentError, null);
});
test('Chinese and non-BMP Unicode characters measured without treating binary byte sizes as tokens', () => {
  const s = measure('中文😀0'); assert.equal(s.chars, 4); assert.equal(s.bytes, 11); assert.ok(s.high >= s.low);
});
