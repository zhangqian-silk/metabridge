'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isModelAllowed, compileModelFilter, compileMatcher, loadProviders, readJson,
  compileReasoningRules, reasoningForModel,
} = require('../provider-config');
const { commandRequest } = require('../command-code');

test('allow rules are a union, deny wins, and exact IDs stay case sensitive', () => {
  const provider = { modelFilter: {
    allow: ['vendor/Exact', { regex: '^family/model-[0-9]+$', flags: 'i' }],
    deny: ['family/model-2', { regex: 'model-3$', flags: 'i' }],
  } };
  for (const [model, allowed] of [
    ['vendor/Exact', true], ['vendor/exact', false], ['family/model-1', true],
    ['FAMILY/MODEL-1', true], ['family/model-2', false], ['FAMILY/MODEL-3', false],
    ['unrelated/model-1', false], ['prefix/vendor/Exact', false],
  ]) assert.equal(isModelAllowed(provider, model), allowed, model);
  assert.equal(compileMatcher({ regex: 'model' })('prefix/model'), true, 'regex uses search semantics');
});

test('omitted allow means all, empty allow means none, blacklist-only is supported', () => {
  assert.equal(isModelAllowed({}, 'any/model'), true);
  assert.equal(isModelAllowed({ modelFilter: { allow: [] } }, 'any/model'), false);
  const provider = { modelFilter: { deny: [{ regex: '/preview$' }] } };
  assert.equal(isModelAllowed(provider, 'vendor/stable'), true);
  assert.equal(isModelAllowed(provider, 'vendor/preview'), false);
  for (const model of [undefined, null, '', 'x'.repeat(2049)]) {
    assert.equal(isModelAllowed({}, model), false);
  }
});

test('invalid or ambiguous filters fail closed, including stateful regex flags', () => {
  for (const modelFilter of [
    null, [], { whitelist: ['model'] }, { allow: null }, { deny: [''] },
    { allow: [{ regex: '[' }] }, { allow: [{ regex: 'model', flags: 'g' }] },
    { deny: [{ regex: 'model', flags: 'y' }] }, { allow: [{ regex: 'model', extra: true }] },
  ]) assert.throws(() => compileModelFilter({ modelFilter }));
  assert.throws(() => compileModelFilter({ modelAllowlist: ['a'], modelFilter: { deny: ['a'] } }));
  assert.throws(() => compileModelFilter({ modelAllowlist: [{ regex: '^model' }] }));
  assert.equal(isModelAllowed({ modelAllowlist: ['a'] }, 'a'), true);
  assert.equal(isModelAllowed({ modelAllowlist: [] }, 'a'), false);
});

test('provider files and keyfiles resolve relative to their declaring files, not cwd', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-file-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'providers'));
  const file = path.join(dir, 'providers', 'example.json');
  fs.writeFileSync(file, JSON.stringify({
    name: 'test', base: 'https://example.test', auth: { type: 'keyfile', file: '../key' },
  }));
  const root = path.join(dir, 'config.json');
  const [provider] = loadProviders({ providerFiles: ['providers/example.json'] }, root);
  assert.equal(provider.auth.file, path.join(dir, 'key'));
  assert.equal(provider._sourceFile, file);
  assert.equal(JSON.stringify(provider).includes('_sourceFile'), false);
  assert.throws(() => loadProviders({ providerFiles: ['providers/example.json', 'providers/../providers/example.json'] }, root),
    /重复引用/);
  assert.throws(() => loadProviders({ providerFiles: ['providers/example.json'], backends: [] }, root),
    /不能同时配置/);
  fs.writeFileSync(file, '{"auth":{"key":"DO_NOT_PRINT_THIS_SECRET"}');
  assert.throws(() => readJson(file), error => !error.message.includes('DO_NOT_PRINT_THIS_SECRET'));
});

test('reasoning profiles and Messages selection are configurable and agree with wire requests', () => {
  const provider = {
    reasoningRules: [
      { match: 'custom/special', levels: ['low', 'max'], default: 'max' },
      { match: { regex: '^custom/' }, levels: ['low', 'high'], default: 'high' },
    ],
    messagesModels: ['custom/special'],
  };
  assert.equal(reasoningForModel(provider, 'custom/special').default, 'max', 'first matching rule wins');
  const request = commandRequest({ model: 'custom/special', input: 'hi' }, provider);
  assert.equal(request.pathname, '/v1/messages');
  assert.equal(request.body.reasoning_effort, 'max');
  assert.equal(commandRequest({ model: 'custom/other', input: 'hi' }, provider).body.reasoning_effort, 'high');
  assert.throws(() => commandRequest({ model: 'custom/special', reasoning: { effort: 'medium' } }, provider),
    error => error.status === 400);
  assert.equal(commandRequest({ model: 'unknown', input: 'hi' }, provider).body.reasoning_effort, undefined);
  assert.equal(commandRequest({ model: 'claude-test', input: 'hi' }, { messagesModels: [], reasoningRules: [] }).pathname,
    '/v1/chat/completions');
  assert.throws(() => compileReasoningRules({ reasoningRules: [
    { match: 'model', levels: ['low'], default: 'high' },
  ] }));
});
