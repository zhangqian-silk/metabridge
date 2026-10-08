'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE, subscriptionFetch, validateSubscriptionBackend, subscriptionHeaders,
} = require('../src/adapters/openai/subscription');
const backend = { base: BASE, auth: { type: 'none' } };
const auth = { authorization: 'Bearer fake-oauth-token', 'chatgpt-account-id': 'fake-account' };

test('subscription transport maps native paths and only forwards approved headers', async () => {
  for (const pathname of ['/v1/responses', '/v1/responses/compact']) {
    let request;
    const payload = { model: 'gpt-test', stream: true, store: false,
      input: [{ type: 'compaction_trigger' }] };
    const before = structuredClone(payload);
    await subscriptionFetch(backend, { ...auth, cookie: 'secret', 'x-api-key': 'other-secret',
      'x-codex-turn-state': 'state' }, pathname, payload, {
      fetchImpl: async (url, options) => { request = { url, ...options }; return Response.json({}); },
    });
    assert.equal(request.url, `${BASE}${pathname.slice(3)}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, auth.authorization);
    assert.equal(request.headers['x-codex-turn-state'], 'state');
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-api-key'], undefined);
    assert.deepEqual(JSON.parse(request.body), before, 'native Codex body must not be converted');
    assert.deepEqual(payload, before);
  }
});

test('subscription auth and unsupported endpoints fail before any request', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; return Response.json({}); } };
  for (const headers of [{}, { authorization: 'Bearer token' },
    { ...auth, authorization: 'Bearer sk-platform-key' }]) {
    await assert.rejects(subscriptionFetch(backend, headers, '/v1/responses', {}, options),
      error => error.status === 401);
  }
  await assert.rejects(subscriptionFetch(backend, auth, '/v1/chat/completions', {}, options),
    error => error.status === 400);
  assert.equal(calls, 0);
});

test('subscription credentials cannot be forwarded to arbitrary remote destinations', () => {
  for (const base of ['https://evil.example/backend-api/codex',
    'http://chatgpt.com/backend-api/codex', `${BASE}?redirect=1`,
    'https://chatgpt.com@evil.example/backend-api/codex']) {
    assert.throws(() => validateSubscriptionBackend({ ...backend, base }));
  }
  assert.throws(() => validateSubscriptionBackend({ ...backend, passthroughHeaders: true }));
  assert.deepEqual(subscriptionHeaders({ Cookie: 'secret', Authorization: 'Bearer token' }),
    { authorization: 'Bearer token' });
});
