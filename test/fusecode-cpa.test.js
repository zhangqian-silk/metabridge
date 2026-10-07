'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readClaudeSettings, mergeFusecodeProvider } = require('../scripts/configure-fusecode-cpa');

test('reads FuseCode credential from settings file data, not environment', () => {
  assert.deepEqual(readClaudeSettings({ env: {
    ANTHROPIC_BASE_URL: 'https://www.fusecode.ai/',
    ANTHROPIC_AUTH_TOKEN: 'test-private-key',
  } }), { base: 'https://www.fusecode.ai', key: 'test-private-key' });
  for (const base of ['http://www.fusecode.ai', 'https://evil.example', 'https://www.fusecode.ai/v1',
    'https://www.fusecode.ai/?key=secret', 'https://user@www.fusecode.ai']) {
    assert.throws(() => readClaudeSettings({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'key' } }));
  }
  assert.throws(() => readClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'https://www.fusecode.ai' } }));
});

test('merges Claude models without changing other providers, plugins or management', () => {
  const original = { management: { secret: 'private' }, plugins: { enabled: true },
    'api-keys': { codex: [{ name: 'gateway' }], claude: [{ name: 'factory-anthropic' }] } };
  const snapshot = structuredClone(original);
  const credentials = { base: 'https://www.fusecode.ai', key: 'test-key' };
  const models = [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }];
  const next = mergeFusecodeProvider(original, credentials, models);
  assert.deepEqual(original, snapshot);
  const provider = next['api-keys'].claude.pop();
  assert.deepEqual(next, snapshot);
  assert.equal(provider.prefix, 'fusecode');
  assert.equal(provider['base-url'], credentials.base);
  assert.equal(provider.keys[0]['api-key'], credentials.key);
  assert.equal(provider.keys[0].cloak.mode, 'never');
  assert.equal(provider.models[0]['display-name'], 'fusecode · claude-sonnet-5-5');
  const once = mergeFusecodeProvider(original, credentials, models);
  assert.deepEqual(mergeFusecodeProvider(once, credentials, models), once);
});

test('rejects empty, duplicate, unsafe and non-Claude model catalogs', () => {
  const credentials = { base: 'https://www.fusecode.ai', key: 'test-key' };
  for (const models of [[], [{ id: 'gpt-test' }], [{ id: 'claude-x' }, { id: 'claude-x' }],
    [{ id: 'claude-x/../../' }]]) {
    assert.throws(() => mergeFusecodeProvider({}, credentials, models));
  }
});
