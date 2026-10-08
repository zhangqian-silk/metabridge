'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandCodeReasoning } = require('../src/adapters/command-code/reasoning');
const { commandRequest } = require('../src/adapters/command-code/client');

const models = [
  ['zai-org/GLM-5.3', ['low', 'high', 'max'], 'high'],
  ['z-ai/glm-5.3-flash', ['low', 'high', 'max'], 'high'],
  ['deepseek/deepseek-v4.1-flash', ['low', 'high', 'max'], 'high'],
  ['google/gemini-3.8-flash', ['low', 'medium', 'high'], 'medium'],
];

for (const [model, levels, defaultEffort] of models) {
  test(`${model}: catalog levels and effective wire effort agree`, () => {
    const policy = commandCodeReasoning(model);
    assert.deepEqual(policy, { levels, default: defaultEffort });
    assert.equal(commandRequest({ model, input: 'hi' }).body.reasoning_effort, defaultEffort);
    for (const effort of levels) {
      const payload = { model, input: 'hi', reasoning: { effort, summary: 'auto' } };
      const request = commandRequest(payload);
      assert.equal(request.body.reasoning_effort, effort);
      assert.equal(request.pathname, '/v1/chat/completions');
      assert.equal(request.body.reasoning, undefined);
      assert.deepEqual(payload.reasoning, { effort, summary: 'auto' });
    }
    for (const effort of ['xhigh', 'ultra', 'invalid', ...(!levels.includes('medium') ? ['medium'] : ['max'])]) {
      assert.throws(() => commandRequest({ model, input: 'hi', reasoning: { effort } }),
        e => e.status === 400 && /reasoning effort/.test(e.message));
    }
  });
}

test('unknown models do not inherit an unverified effort ladder or default wire effort', () => {
  assert.equal(commandCodeReasoning('future/model'), null);
  assert.equal(commandRequest({ model: 'future/model', input: 'hi' }).body.reasoning_effort, undefined);
});
