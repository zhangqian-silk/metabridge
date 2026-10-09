'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createFactoryServer, validateGateway } = require('../src/adapters/factory/server');
const { mergeFactoryProviders } = require('../scripts/configure-factory-cpa');

test('Factory accounts coexist and updating one preserves the other account', () => {
  const first = mergeFactoryProviders({}, config(), 'first-private');
  const secondConfig = config();
  secondConfig.gateway.port = 8320;
  const both = mergeFactoryProviders(first, secondConfig, 'second-private', 'factory-2');
  for (const group of ['codex', 'claude', 'openai-compatibility']) {
    assert.equal(both['api-keys'][group].length, 2);
    assert.deepEqual(both['api-keys'][group][0], first['api-keys'][group][0]);
    assert.equal(both['api-keys'][group][1].keys[0]['api-key'], 'second-private');
    assert.match(both['api-keys'][group][1]['base-url'], /:8320/);
  }
  assert.deepEqual(mergeFactoryProviders(both, secondConfig, 'second-private', 'factory-2'), both);
  assert.throws(() => mergeFactoryProviders(first, secondConfig, 'second-private', '../bad'));
});
const { mergeFactoryModels } = require('../scripts/configure-factory-models');
const sharp = require('sharp');
const config = () => ({
  name: 'factory', base_url: 'https://api.factory.ai', auth: { type: 'keyfile', file: 'fixture' },
  quota: { globalLimit: true, userLimits: false, personalUsage: false },
  gateway: { instruction_mode: 'factory_prefix', client_version: '0.162.1', models: [
    { id: 'gpt-6.1-sol', protocol: 'responses', provider: 'openai' },
    { id: 'claude-haiku-4-5-20251001', protocol: 'messages', provider: 'anthropic' },
    { id: 'glm-5.3', protocol: 'chat', provider: 'fireworks' },
  ] },
});
async function start(t, fetchImpl) {
  const server = await createFactoryServer(config(), 'fixture-private', { fetch: fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const auth = { Authorization: 'Bearer fixture-private', 'Content-Type': 'application/json' };

test('Factory catalog expansion preserves credential/quota configuration and rejects invalid models', () => {
  const original = config();
  const models = require('../config/catalogs/factory-models.catalog.json');
  const expanded = mergeFactoryModels(original, models);
  assert.deepEqual(expanded.auth, original.auth);
  assert.deepEqual(expanded.quota, original.quota);
  assert.equal(original.gateway.models.length, 3);
  const cpa = mergeFactoryProviders({}, expanded, 'fixture-private');
  const published = Object.values(cpa['api-keys']).flatMap(group => group.flatMap(p => p.models));
  assert.deepEqual(new Set(published.map(m => m.name)), new Set(models.map(m => m.id)));
  const mini = expanded.gateway.models.find(m => m.id === 'minimax-m3');
  assert.equal(mini.protocol, 'messages');
  assert.equal(mini.provider, 'fireworks');
  assert.throws(() => mergeFactoryModels(original, [{ id: '../invalid', protocol: 'chat', provider: 'fireworks' }]));
});

test('Factory proxy rejects non-loopback listeners and invalid model/header configurations before network access', async () => {
  for (const changes of [
    { host: '0.0.0.0' }, { host: 'remote.example' }, { client_version: '0.162.1\ninjected' },
    { port: 65536 }, { models: [{ id: 'x', protocol: 'responses', provider: 'openai\r\nbad' }] },
    { models: [config().gateway.models[0], config().gateway.models[0]] },
  ]) {
    const c = config();
    Object.assign(c.gateway, changes);
    assert.throws(() => validateGateway(c));
  }
  let calls = 0;
  await assert.rejects(createFactoryServer(config(), 'key\nbad', { fetch: async () => { calls++; } }));
  assert.equal(calls, 0);
});

test('Factory CPA configuration uses native path conventions and preserves unrelated providers', () => {
  const original = { payload: { keep: true }, 'api-keys': {
    codex: [{ name: 'gateway', keys: [{ 'api-key': 'gateway-private' }] }],
    'openai-compatibility': [{ name: 'cmd' }],
  } };
  const merged = mergeFactoryProviders(original, config(), 'fixture-private');
  assert.deepEqual(merged['api-keys'].codex[0], original['api-keys'].codex[0]);
  assert.deepEqual(merged.payload, original.payload);
  assert.equal(original['api-keys'].claude, undefined);
  assert.equal(merged['api-keys'].claude[0]['base-url'], 'http://127.0.0.1:8319');
  assert.equal(merged['api-keys'].codex[1]['base-url'], 'http://127.0.0.1:8319/v1');
  assert.deepEqual(mergeFactoryProviders(merged, config(), 'fixture-private'), merged);
});

test('Factory proxy routes native protocols, preserves SSE bytes/tools, and isolates caller headers', async t => {
  const calls = [];
  const sse = 'event: response.completed\ndata: {"type":"response.completed","output":[]}\n\n';
  const url = await start(t, async (url, options) => {
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    calls.push({ url, options });
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  for (const [protocol, model, field] of [
    ['responses', 'gpt-6.1-sol', 'input'], ['messages?beta=true', 'claude-haiku-4-5-20251001', 'messages'],
    ['chat/completions', 'glm-5.3', 'messages'],
  ]) {
    const body = { model, [field]: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read_file' }], stream: true };
    const r = await fetch(`${url}/v1/${protocol}`, { method: 'POST',
      headers: { ...auth, 'X-Factory-Org-Id': 'hostile-org', Cookie: 'private-cookie' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), sse);
    const call = calls.at(-1);
    assert.equal(new URL(call.url).origin, 'https://api.factory.ai');
    assert.equal(call.options.headers['X-Factory-Org-Id'], 'fixture-org');
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers['User-Agent'], 'metabridge-factory/0.2');
    assert.equal(call.options.headers['X-Client-Version'], '0.162.1');
    assert.deepEqual(JSON.parse(call.options.body).tools, body.tools);
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(calls.length, 3);
});

test('Factory proxy denies unauthorized, unknown models/protocols and preserves upstream failure status', async t => {
  let count = 0;
  const url = await start(t, async url => {
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    count++;
    return new Response('{"error":"rate limited"}', { status: 429 });
  });
  async function post(model, headers = auth, endpoint = 'responses') {
    return fetch(`${url}/v1/${endpoint}`, { method: 'POST', headers,
      body: JSON.stringify({ model, input: 'hello' }) });
  }
  assert.equal((await post('gpt-6.1-sol', {})).status, 401);
  assert.equal((await post('unknown')).status, 400);
  assert.equal((await post('glm-5.3')).status, 400);
  assert.equal((await post('gpt-6.1-sol', auth, 'not-supported')).status, 404);
  assert.equal(count, 0);
  const response = await post('gpt-6.1-sol');
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{"error":"rate limited"}');
  assert.equal(count, 1);
});

test('Factory proxy forwards large image requests without an additional body-size limit', async t => {
  const image = 'A'.repeat(6 * 1024 * 1024);
  let upstreamCalls = 0;
  const url = await start(t, async (url, options) => {
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    upstreamCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[0].source.data, image);
    return new Response('{"error":{"message":"upstream request size policy"}}', { status: 413 });
  });
  const response = await fetch(`${url}/v1/messages?beta=true`, {
    method: 'POST', headers: auth, body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: [{
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: image },
      }] }],
    }),
  });
  assert.equal(response.status, 413);
  assert.equal(await response.text(), '{"error":{"message":"upstream request size policy"}}');
  assert.equal(upstreamCalls, 1);
});

test('Factory proxy aborts upstream when the streaming caller disconnects', async t => {
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  const url = await start(t, async (url, options) => {
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    options.signal.addEventListener('abort', resolveAbort, { once: true });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await fetch(`${url}/v1/responses`, {
    method: 'POST', headers: auth, body: '{"model":"gpt-6.1-sol","input":"hello","stream":true}',
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([aborted, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream not aborted')), 2000);
    timer.unref();
  })]);
});

test('Factory proxy applies optimization at the final native upload boundary', async t => {
  const pixels = Buffer.alloc(2000 * 1400 * 3);
  let seed = 11;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 2000, height: 1400, channels: 3 } }).png().toBuffer();
  const original = { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
  ] }], tools: [{ name: 'read_file', input_schema: { type: 'object' } }] };
  let calls = 0;
  const url = await start(t, async (url, options) => {
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    calls++;
    assert.ok(Buffer.byteLength(options.body) < 4_000_000);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools, original.tools);
    const source = body.messages[0].content[0].source;
    assert.equal(source.media_type, 'image/jpeg');
    assert.ok((await sharp(Buffer.from(source.data, 'base64')).metadata()).width <= 1568);
    return new Response('data: {"type":"message_stop"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify(original) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"type":"message_stop"}\n\n');
  assert.equal(calls, 1);
});
