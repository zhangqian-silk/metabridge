'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { normalizeProviderPolicy, compileCompaction, compactionForModel, usesLocalCompaction } = require('../src/core/provider-config');

test('CPA Factory filter keeps only non-fast Opus 5.5 and Sonnet 5.5 without restricting other providers', () => {
  const { isModelAllowed } = require('../src/core/provider-config');
  const provider = { modelFilter: {
    deny: [{ regex: '^factory/(?!(?:claude-opus-5-5|claude-sonnet-5-5)$)' }],
  } };
  const catalog = require('../config/catalogs/factory-models.catalog.json');
  assert.deepEqual(catalog.filter(model => isModelAllowed(provider, `factory/${model.id}`))
    .map(model => model.id).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  for (const id of ['factory/claude-sonnet-5-5-fast', 'factory/claude-opus-5-5-fast',
    'factory/claude-opus-5-5-extra', 'factory/new-model']) {
    assert.equal(isModelAllowed(provider, id), false);
  }
  for (const id of ['fusecode/claude-opus-5-5-fast', 'relay/gpt-test', 'cmd/model']) {
    assert.equal(isModelAllowed(provider, id), true);
  }
});

test('explicit provider chains default to passthrough without inferring adaptations from prefixes', () => {
  for (const via of ['direct', 'cpa']) {
    const provider = { via, prefix: 'vendor/' };
    normalizeProviderPolicy(provider);
    compileCompaction(provider);
    assert.equal(provider.requestMode, 'passthrough');
    assert.deepEqual(provider.compaction, { mode: 'passthrough' });
    assert.equal(usesLocalCompaction(provider, 'model'), false);
  }
  const official = { via: 'direct', protocol: 'codex-subscription', requestMode: 'passthrough' };
  normalizeProviderPolicy(official);
  compileCompaction(official);
  assert.equal(usesLocalCompaction(official, 'gpt-test'), false);
  for (const provider of [
    { via: 'invalid' }, { via: 'cpa', protocol: 'codex-subscription' },
    { via: 'cpa', protocol: 'command-code' },
    { via: 'direct', protocol: 'codex-subscription', requestMode: 'adapt' },
  ]) assert.throws(() => normalizeProviderPolicy(provider));
});

test('local compaction can cover a whole provider independently of its connection chain', () => {
  for (const via of ['direct', 'cpa']) {
    const provider = { via, compaction: { mode: 'local', stripImages: true } };
    normalizeProviderPolicy(provider);
    compileCompaction(provider);
    assert.equal(compactionForModel(provider, 'any-model'), provider.compaction);
    assert.equal(usesLocalCompaction(provider, 'any-model'), true);
    assert.equal(provider.requestMode, 'passthrough');
  }
});

test('explicit compaction policy overrides legacy prefix defaults', () => {
  const legacy = { prefix: 'vendor/', requestMode: 'adapt' };
  assert.equal(usesLocalCompaction(legacy, 'model'), true);
  for (const compaction of [
    { mode: 'passthrough' },
    { mode: 'local', models: ['selected'] },
  ]) {
    const provider = { ...legacy, compaction };
    compileCompaction(provider);
    assert.equal(usesLocalCompaction(provider, 'other'), false);
  }
  assert.throws(() => compileCompaction({ compaction: { mode: 'passthrough', models: ['model'] } }));
  assert.throws(() => compileCompaction({ protocol: 'codex-subscription', compaction: { mode: 'local' } }));
  const invalid = { via: 'direct', compaction: null };
  normalizeProviderPolicy(invalid);
  assert.throws(() => compileCompaction(invalid));
});

test('compaction policy is explicit, scoped and never enabled for official subscriptions', () => {
  const provider = { protocol: 'responses', compaction: {
    mode: 'local', models: ['factory/claude-test', { regex: '^factory/claude-sonnet-' }], stripImages: true,
  } };
  compileCompaction(provider);
  assert.equal(compactionForModel(provider, 'factory/claude-test'), provider.compaction);
  assert.equal(compactionForModel(provider, 'factory/claude-sonnet-5-5'), provider.compaction);
  assert.equal(compactionForModel(provider, 'fusecode/claude-sonnet-5-5'), null);
  assert.equal(compactionForModel({}, 'factory/claude-test'), null);
  for (const changes of [{ models: [] }, { mode: 'unknown' }, { stripImages: 'true' },
    { models: [{ regex: '[' }] }, { unknown: true }]) {
    assert.throws(() => compileCompaction({ ...provider,
      compaction: { ...provider.compaction, ...changes } }));
  }
  assert.throws(() => compileCompaction({ ...provider, protocol: 'codex-subscription' }));
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function start(t, config, files = {}, setup = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-provider-config-'));
  for (const [name, value] of Object.entries({ 'config.json': config, ...files })) {
    const destination = path.join(dir, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(value));
  }
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // Isolate configuration and credentials from the user's machine.
    cwd: os.tmpdir(),
    env: { ...process.env, MB_CONFIG_FILE: path.join(dir, 'config.json'),
      MB_PORT: String(port), CODEX_HOME: path.join(dir, 'codex'), ...setup(dir) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exit;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) return { ready: false, logs, code: child.exitCode, base, dir };
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { ready: true, logs, base, dir };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`server did not settle: ${logs}`);
}

test('hybrid routing keeps CPA IDs and payloads intact and never falls back from official auth', async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (req.url.startsWith('/backend-api/codex/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'official unavailable' } }));
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end('event: response.completed\ndata: {"unchanged":true}\n\n');
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridge = await start(t, {
    officialModels: { enabled: false }, backends: [
      { name: 'official', base: `http://127.0.0.1:${port}/backend-api/codex`,
        via: 'direct', protocol: 'codex-subscription', auth: { type: 'none' },
        routeModels: [{ regex: '^gpt-' }], priority: 10,
        catalog: { source: 'static', models: [{ id: 'gpt-test' }] } },
      { name: 'cpa', base: `http://127.0.0.1:${port}`, displayPrefix: '',
        via: 'cpa',
        requestMode: 'passthrough', auth: { type: 'static', key: 'cpa-key' },
        catalog: { source: 'static', models: [
          { id: 'gpt-test' }, { id: 'cmd/vendor/model' }, { id: 'gateway/gpt-test' },
        ] } },
      { name: 'native-gateway', via: 'direct', base_url: `http://127.0.0.1:${port}/gateway/v1`,
        prefix: 'gateway/', auth: { type: 'static', key: 'gateway-key' },
        catalog: { source: 'static', models: [{ id: 'gpt-test' }] } },
    ],
  });
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.deepEqual(catalog.data.map(m => m.id), ['gpt-test', 'cmd/vendor/model', 'gateway/gpt-test']);
  const payload = { model: 'cmd/vendor/model', stream: true,
    input: [{ type: 'compaction', encrypted_content: 'opaque' }, { type: 'compaction_trigger' }],
    tools: [{ type: 'function', name: 'long_tool_name_'.repeat(10) }] };
  const response = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer native-oauth', 'chatgpt-account-id': 'account' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: response.completed\ndata: {"unchanged":true}\n\n');
  assert.deepEqual(calls[0].body, payload);
  assert.equal(calls[0].headers.authorization, 'Bearer cpa-key');
  assert.equal(calls[0].headers['chatgpt-account-id'], undefined);
  const unauthorized = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', body: JSON.stringify({ model: 'gpt-test', input: 'hi' }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 1);
  const unavailable = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer native-oauth', 'chatgpt-account-id': 'account' },
    body: JSON.stringify({ model: 'gpt-test', input: 'hi' }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/backend-api/codex/responses');
  assert.equal(calls[1].headers.authorization, 'Bearer native-oauth');
  const gatewayPayload = { ...payload, model: 'gateway/gpt-test' };
  const nativeGateway = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer native-oauth', 'chatgpt-account-id': 'account' },
    body: JSON.stringify(gatewayPayload),
  });
  assert.equal(nativeGateway.status, 200);
  await nativeGateway.text();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, '/gateway/v1/responses');
  assert.equal(calls[2].headers.authorization, 'Bearer gateway-key');
  assert.equal(calls[2].headers['chatgpt-account-id'], undefined);
  assert.deepEqual(calls[2].body, { ...gatewayPayload, model: 'gpt-test' });
});

test('prefixed passthrough skips local compaction synthesis and opaque history materialization', async t => {
  let forwarded;
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    forwarded = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [] }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridge = await start(t, { officialModels: { enabled: false }, backends: [
    { name: 'proxy', base: `http://127.0.0.1:${port}`, prefix: 'proxy/',
      via: 'direct', auth: { type: 'none' }, catalog: { source: 'none' } },
  ] });
  assert.equal(bridge.ready, true, bridge.logs);
  const payload = { model: 'proxy/model',
    input: [{ type: 'compaction', encrypted_content: 'opaque' }, { type: 'compaction_trigger' }],
    tools: [{ type: 'function', name: 'long_tool_'.repeat(12) }] };
  const response = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, { ...payload, model: 'model' });
});

test('invalid hybrid routing and passthrough combinations fail at startup', async t => {
  for (const extra of [
    { routeModels: [] }, { routeModels: [{ regex: '[' }] },
    { routeModels: ['gpt-test'], prefix: 'extra/' },
    { requestMode: 'unknown' }, { requestMode: 'passthrough', sanitize: 'command-code' },
    { requestMode: 'passthrough', protocol: 'command-code', prefix: 'cmd/' },
    { via: 'invalid' }, { via: 'cpa', protocol: 'codex-subscription' },
    { via: 'cpa', protocol: 'command-code', prefix: 'cmd/' },
    { via: 'direct', protocol: 'codex-subscription', compaction: { mode: 'local' } },
  ]) {
    const bridge = await start(t, { officialModels: { enabled: false }, backends: [
      { name: 'bad', base: 'http://127.0.0.1:1', auth: { type: 'none' }, ...extra },
    ] });
    assert.equal(bridge.ready, false, JSON.stringify(extra));
  }
});

test('CPA Codex catalog preserves upstream capabilities and display names', async t => {
  const info = { slug: 'cmd/vendor/model', display_name: 'cmd · model', context_window: 150000,
    supported_reasoning_levels: [{ effort: 'high', description: 'upstream policy' }],
    default_reasoning_level: 'high', supports_parallel_tool_calls: false,
    use_responses_lite: false, base_instructions: 'Upstream model instructions' };
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models?client_version=0.159.2');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [info] }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridge = await start(t, { officialModels: { enabled: false }, backends: [
    { name: 'cpa', base: `http://127.0.0.1:${port}`, auth: { type: 'none' },
      displayPrefix: '', priority: 45, requestMode: 'passthrough',
      catalog: { source: 'remote', format: 'codex', clientVersion: '0.159.2' } },
  ] });
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.deepEqual(catalog.models, [{ ...info, priority: 45 }]);
  assert.equal(catalog.data[0].display_name, info.display_name);
  assert.equal(catalog.data[0].base_instructions, undefined);
});

test('file providers share allow/deny regex policy between catalog and requests', async t => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [
        { id: 'vendor/Good' }, { id: 'vendor/beta' }, { id: 'other/model' },
      ] }));
    }
    requests.push(req.url);
    res.end(JSON.stringify({ output: [] }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridge = await start(t, {
    officialModels: { enabled: false }, providerFiles: ['providers/example.json'],
  }, {
    'providers/example.json': {
      name: 'example', base: `http://127.0.0.1:${port}`, prefix: 'ext/',
      auth: { type: 'none' }, reasoning: 'none',
      modelFilter: { allow: [{ regex: '^vendor/', flags: 'i' }], deny: [{ regex: 'beta$' }] },
    },
  });
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.deepEqual(catalog.data.map(m => m.id), ['ext/vendor/Good']);
  for (const endpoint of ['/v1/responses', '/v1/chat/completions']) {
    const blocked = await fetch(`${bridge.base}${endpoint}`, {
      method: 'POST', body: JSON.stringify({ model: 'ext/vendor/beta', input: 'hi' }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.type, 'model_not_allowed');
  }
  assert.equal(requests.length, 0, 'denied requests must never reach upstream');
  const allowed = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', body: JSON.stringify({ model: 'ext/vendor/Good', input: 'hi' }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(requests.length, 1);
});

test('malformed provider files fail at startup rather than silently disappearing', async t => {
  const result = await start(t, {
    officialModels: { enabled: false }, providerFiles: ['missing.json'],
  });
  assert.equal(result.ready, false);
  assert.match(result.logs, /missing\.json/);
});

test('invalid regex configuration fails before any catalog fetch', async t => {
  const result = await start(t, {
    officialModels: { enabled: false },
    backends: [{ name: 'bad', base: 'http://127.0.0.1:1', auth: { type: 'none' },
      modelFilter: { deny: [{ regex: '[' }] } }],
  });
  assert.equal(result.ready, false);
  assert.match(result.logs, /regex|正则/);
});

test('subscription and third-party catalogs coexist without gateway, with native compact and auth isolation', async t => {
  const officialRequests = [];
  const thirdPartyRequests = [];
  async function recorder(requests) {
    const server = http.createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ url: req.url, headers: req.headers, body });
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        return res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output: [] }));
    });
    const port = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${port}`;
  }
  const officialBase = await recorder(officialRequests);
  const externalBase = await recorder(thirdPartyRequests);
  const bridge = await start(t, {
    providerFiles: ['providers/official.json', 'providers/external.json'],
  }, {
    'providers/official.json': {
      name: 'subscription', base: `${officialBase}/backend-api/codex`,
      protocol: 'codex-subscription', auth: { type: 'none' },
      catalog: { source: 'static', models: [{ id: 'gpt-test' }] },
    },
    'providers/external.json': {
      name: 'external', base: externalBase, prefix: 'ext/',
      auth: { type: 'static', key: 'third-party-key' },
      catalog: { source: 'static', models: [{ id: 'other-model' }] },
    },
  });
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.deepEqual(new Set(catalog.data.map(m => m.id)), new Set(['gpt-test', 'ext/other-model']));
  const headers = { authorization: 'Bearer native-client-oauth', 'chatgpt-account-id': 'account',
    'x-api-key': 'must-not-leak' };
  for (const endpoint of ['/v1/responses', '/v1/responses/compact']) {
    const result = await fetch(`${bridge.base}${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'gpt-test',
        input: [{ type: 'compaction_trigger' }], stream: false }),
    });
    assert.equal(result.status, 200);
  }
  assert.deepEqual(officialRequests.map(r => r.url),
    ['/backend-api/codex/responses', '/backend-api/codex/responses/compact']);
  assert.equal(officialRequests[0].headers.authorization, headers.authorization);
  assert.equal(officialRequests[0].headers['x-api-key'], undefined);
  assert.equal(officialRequests[0].body.input[0].type, 'compaction_trigger');
  const longName = 'native_tool_'.repeat(12);
  const streaming = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'gpt-test', input: 'hi', stream: true,
      tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }] }),
  });
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get('content-type'), /text\/event-stream/);
  assert.match(await streaming.text(), /event: response.completed/);
  assert.equal(officialRequests[2].body.tools[0].name, longName, 'native tools must not be aliased');
  const unauthorized = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', body: JSON.stringify({ model: 'gpt-test', input: 'hi' }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(officialRequests.length, 3);
  const external = await fetch(`${bridge.base}/v1/responses`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'ext/other-model', input: 'hi' }),
  });
  assert.equal(external.status, 200);
  assert.equal(thirdPartyRequests[0].headers.authorization, 'Bearer third-party-key');
  assert.equal(thirdPartyRequests[0].headers['chatgpt-account-id'], undefined);
});

test('gateway key import updates only the referenced provider file', async t => {
  const root = { providerFiles: ['providers/gateway.json'] };
  const bridge = await start(t, root, {
    'providers/gateway.json': { name: 'gateway', base: 'https://gateway.example.test',
      auth: { type: 'gateway', key: '' }, catalog: { source: 'none' } },
  });
  const source = path.join(bridge.dir, 'codex-source.toml');
  const key = 'plat_private_fixture_never_print';
  fs.writeFileSync(source, `[model_providers.old]\nhttp_headers = { "x-api-key" = "${key}" }\n`);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'),
      '--import-gateway-key', '--from', source], {
      env: { ...process.env, MB_CONFIG_FILE: path.join(bridge.dir, 'config.json') },
    });
    let logs = '';
    child.stdout.on('data', b => { logs += b; });
    child.stderr.on('data', b => { logs += b; });
    child.on('exit', code => resolve({ code, logs }));
  });
  assert.equal(result.code, 0, result.logs);
  assert.equal(result.logs.includes(key), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bridge.dir, 'config.json'), 'utf8')), root);
  const destination = path.join(bridge.dir, 'providers', 'gateway.json');
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).auth.key, key);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test('subscription catalog uses bundled CLI models and provider filters without anonymous network requests', async t => {
  const result = await start(t, {
    providerFiles: ['official.json', 'external.json'],
  }, {
    'official.json': {
      name: 'subscription', base: 'http://127.0.0.1:1/backend-api/codex',
      protocol: 'codex-subscription', auth: { type: 'none' }, catalog: { source: 'codex' },
      modelFilter: { deny: [{ regex: '-hidden$' }] },
    },
    'external.json': {
      name: 'external', base: 'http://127.0.0.1:1', prefix: 'ext/',
      auth: { type: 'none' }, catalog: { source: 'static', models: [{ id: 'third-party' }] },
    },
  }, dir => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const executable = path.join(bin, 'codex');
    const models = [{ slug: 'gpt-test', context_window: 200000 },
      { slug: 'gpt-hidden' }, { slug: 'not/official' }];
    fs.writeFileSync(executable, `#!${process.execPath}\n` +
      `if (process.argv.slice(2).join(' ') !== 'debug models --bundled') process.exit(2);\n` +
      `console.log(${JSON.stringify(JSON.stringify({ models }))});\n`);
    fs.chmodSync(executable, 0o755);
    return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  });
  assert.equal(result.ready, true, result.logs);
  const health = await (await fetch(`${result.base}/healthz`)).json();
  assert.equal(health.backends.subscription.ok, true);
  const catalog = await (await fetch(`${result.base}/v1/models`)).json();
  assert.deepEqual(new Set(catalog.data.map(m => m.id)), new Set(['gpt-test', 'ext/third-party']));
  assert.equal(catalog.data.find(m => m.id === 'gpt-test').context_window, 200000);
});

for (const subscription of [false, true]) {
  test(`search helper uses ${subscription ? 'native subscription auth and path' : 'third-party credentials without OAuth leakage'}`, async t => {
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/command/v1/chat/completions') {
        const tool = body.tools?.find(tool => tool.function?.name.startsWith('mb_web_search'));
        if (tool && !body.messages.some(message => message.role === 'tool')) {
          return res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{
            id: 'call_search', type: 'function',
            function: { name: tool.function.name, arguments: '{"query":"Node documentation"}' },
          }] }, finish_reason: 'tool_calls' }] }));
        }
        return res.end(JSON.stringify({ choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] }));
      }
      res.end(JSON.stringify({ status: 'completed', output: [
        { id: 'ws', type: 'web_search_call', status: 'completed', action: { type: 'search' } },
        { id: 'msg', type: 'message', content: [{ type: 'output_text', text: 'Documentation', annotations: [] }] },
      ] }));
    });
    const port = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));
    const bridge = await start(t, { providerFiles: ['command.json', 'search.json'] }, {
      'command.json': {
        name: 'command', base: `http://127.0.0.1:${port}/command`, prefix: 'cmd/',
        protocol: 'command-code', auth: { type: 'static', key: 'command-key' },
        reasoning: 'none', catalog: { source: 'none' },
        webSearch: { backend: 'search', model: 'search-model', timeoutMs: 1000 },
      },
      'search.json': {
        name: 'search', base: `http://127.0.0.1:${port}/${subscription ? 'backend-api/codex' : 'search'}`,
        protocol: subscription ? 'codex-subscription' : 'responses',
        auth: subscription ? { type: 'none' } : { type: 'static', key: 'search-key' },
        catalog: { source: 'none' },
      },
    });
    assert.equal(bridge.ready, true, bridge.logs);
    const response = await fetch(`${bridge.base}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer client-oauth',
        'chatgpt-account-id': 'account', 'x-codex-turn-state': 'turn-state' },
      body: JSON.stringify({ model: 'cmd/test-model', input: 'Search', tools: [{ type: 'web_search' }] }),
    });
    assert.equal(response.status, 200, await response.text());
    const helper = requests.find(request => !request.url.startsWith('/command/'));
    assert.equal(helper.url, subscription ? '/backend-api/codex/responses' : '/search/v1/responses');
    assert.equal(helper.headers.authorization, subscription ? 'Bearer client-oauth' : 'Bearer search-key');
    assert.equal(helper.headers['chatgpt-account-id'], subscription ? 'account' : undefined);
    assert.equal(helper.headers['x-codex-turn-state'], subscription ? 'turn-state' : undefined);
  });
}

test('provider display prefixes use middle dots, IDs remain routable, and zero priority sorts first', async t => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body).model);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [] }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const provider = (name, prefix, priority, displayPrefix) => ({
    name, prefix, priority, ...(displayPrefix === undefined ? {} : { displayPrefix }),
    base: `http://127.0.0.1:${port}`, auth: { type: 'none' },
    catalog: { source: 'static', models: [{ id: 'vendor/model' }] },
  });
  const bridge = await start(t, { providerFiles: ['cmd.json', 'official.json', 'other.json', 'plain.json'] }, {
    'cmd.json': provider('command', 'cmd/', 45),
    'official.json': provider('official', '', 0, '官方'),
    'other.json': provider('external', 'ext/', 20, '第三方'),
    'plain.json': provider('plain', 'plain/', 20, ''),
  });
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.deepEqual(catalog.models.map(m => [m.slug, m.display_name, m.priority]), [
    ['vendor/model', '官方 · vendor/model', 0],
    ['ext/vendor/model', '第三方 · vendor/model', 20],
    ['plain/vendor/model', 'vendor/model', 20],
    ['cmd/vendor/model', 'cmd · vendor/model', 45],
  ]);
  assert.deepEqual(catalog.data.map(m => m.id), catalog.models.map(m => m.slug));
  assert.deepEqual(catalog.data.map(m => m.display_name), catalog.models.map(m => m.display_name));
  for (const { slug } of catalog.models) {
    const response = await fetch(`${bridge.base}/v1/responses`, {
      method: 'POST', body: JSON.stringify({ model: slug, input: 'hi' }),
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(received, Array(4).fill('vendor/model'));
});

test('invalid provider presentation settings fail during startup', async t => {
  for (const extra of [{ displayPrefix: 123 }, { prefix: {} }, { priority: 'first' }, { priority: -1 }, { priority: 0.5 }]) {
    const bridge = await start(t, { providerFiles: ['provider.json'] }, {
      'provider.json': { name: 'bad', base: 'http://127.0.0.1:1', auth: { type: 'none' },
        catalog: { source: 'none' }, ...extra },
    });
    assert.equal(bridge.ready, false, JSON.stringify(extra));
    assert.match(bridge.logs, /prefix|priority|displayPrefix/);
  }
});

test('full base_url, wire_api and file-backed Bearer auth work for catalog, inference and compaction', async t => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    received.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/gateway/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    res.end(JSON.stringify({ status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'A complete summary' }] },
    ] }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridge = await start(t, { providerFiles: ['gateway.json'] }, {
    'gateway.json': {
      name: 'gateway', base_url: `http://127.0.0.1:${port}/gateway/v1/`,
      wire_api: 'responses', prefix: 'gateway/', displayPrefix: 'gateway',
      auth: { type: 'static', key: 'file-config-secret' },
      http_headers: { 'X-Gateway-Feature': 'feature', Authorization: 'Bearer overridden-header' },
    },
  }, () => ({ GATEWAY_KEY: 'environment-must-not-be-used' }));
  assert.equal(bridge.ready, true, bridge.logs);
  const catalog = await (await fetch(`${bridge.base}/v1/models`)).json();
  assert.equal(catalog.models[0].slug, 'gateway/test-model');
  for (const input of ['hi', [{ type: 'compaction_trigger' }]]) {
    const response = await fetch(`${bridge.base}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer client-oauth', 'chatgpt-account-id': 'account' },
      body: JSON.stringify({ model: 'gateway/test-model', input }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  assert.ok(received.some(request => request.url === '/gateway/v1/models'));
  assert.equal(received.filter(request => request.url === '/gateway/v1/responses').length, 2);
  assert.ok(received.every(request => ['/gateway/v1/models', '/gateway/v1/responses'].includes(request.url)));
  for (const request of received) {
    assert.equal(request.headers.authorization, 'Bearer file-config-secret');
    assert.equal(request.headers['x-gateway-feature'], 'feature');
    assert.equal(request.headers['chatgpt-account-id'], undefined);
    assert.equal(request.headers['x-api-key'], undefined);
  }
  assert.equal(bridge.logs.includes('file-config-secret'), false);
});

test('complete API roots support arbitrary paths and Command Code native endpoints', async () => {
  const { providerApiUrl } = require('../src/core/provider-config');
  const { commandFetch } = require('../src/adapters/command-code/client');
  assert.equal(providerApiUrl({ base_url: 'https://example.test/api/custom/' }, '/v1/models'),
    'https://example.test/api/custom/models');
  assert.equal(providerApiUrl({ base: 'https://example.test/provider/' }, '/v1/models'),
    'https://example.test/provider/v1/models');
  for (const [model, endpoint] of [['generic-model', 'chat/completions'], ['claude-test', 'messages']]) {
    let url;
    await commandFetch({ base_url: 'https://example.test/provider/v1/', reasoning: 'none' }, {},
      { model, input: 'hi' }, { fetchImpl: async target => {
        url = target;
        return Response.json(model.startsWith('claude') ? { content: [], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
      } });
    assert.equal(url, `https://example.test/provider/v1/${endpoint}`);
  }
});

test('ambiguous or unsupported connection configuration fails explicitly', async t => {
  for (const extra of [
    { base: 'http://127.0.0.1:1', base_url: 'http://127.0.0.1:1/v1' },
    { base_url: 'http://127.0.0.1:1/v1', wire_api: 'chat' },
    { base_url: 'http://user:secret@127.0.0.1:1/v1' },
    { base_url: 'http://127.0.0.1:1/v1?key=secret' },
    { base_url: 'http://127.0.0.1:1/v1', http_headers: { 'X-Bad': 'line\r\ninjection' } },
  ]) {
    const bridge = await start(t, { providerFiles: ['provider.json'] }, {
      'provider.json': { name: 'bad', auth: { type: 'none' }, catalog: { source: 'none' }, ...extra },
    });
    assert.equal(bridge.ready, false);
    assert.equal(bridge.logs.includes('secret'), false);
  }
});
