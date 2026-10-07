'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { commandRequest, commandFetch } = require('../command-code');

test('Command Code selects native endpoint and translates tool history, images and custom tools', () => {
  const payload = {
    model: 'claude-sonnet-4-6', instructions: 'System rules', stream: true,
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Fix' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** patch' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
    ],
  };
  const { pathname, body } = commandRequest(payload);
  assert.equal(pathname, '/v1/messages');
  assert.equal(body.system, 'System rules');
  assert.equal(body.messages[0].content[1].source.data, 'AAAA');
  assert.deepEqual(body.messages[1].content[0].input, { input: '*** patch' });
  assert.equal(body.messages[2].content[0].tool_use_id, 'call_1');
  assert.equal(body.tools[0].input_schema.properties.input.type, 'string');
  const chat = commandRequest({ ...payload, model: 'deepseek/deepseek-v4-flash' });
  assert.equal(chat.pathname, '/v1/chat/completions');
  assert.equal(chat.body.model, 'deepseek/deepseek-v4-flash');
  assert.equal(chat.body.messages[0].role, 'system');
  assert.equal(chat.body.messages[3].tool_call_id, 'call_1');
});

function upstreamSse(events) {
  const text = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(c) {
      // Split UTF-8 and SSE framing across chunks.
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

async function convert(payload, upstream) {
  let request;
  const res = await commandFetch({ base: 'https://example.test/provider' }, {}, payload, {
    fetchImpl: async (url, options) => { request = { url, ...options }; return upstream; },
  });
  return { res, request, text: await res.text() };
}

test('Chat stream becomes Responses text/tool events, preserves usage and custom input', async () => {
  const { text, request } = await convert({
    model: 'deepseek/deepseek-v4-flash', stream: true, input: 'hello',
    tools: [{ type: 'custom', name: 'apply_patch' }],
  }, upstreamSse([
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'apply_patch', arguments: '{"input":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"patch"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    '[DONE]',
  ]));
  assert.equal(request.url, 'https://example.test/provider/v1/chat/completions');
  const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
  assert.ok(events.some(e => e.type === 'response.output_text.delta' && e.delta === '你好'));
  const response = events.at(-1).response;
  assert.equal(response.status, 'completed');
  assert.equal(response.output[1].type, 'custom_tool_call');
  assert.equal(response.output[1].input, 'patch');
  assert.equal(response.usage.total_tokens, 17);
});

test('Anthropic stream becomes Responses function calls including namespace', async () => {
  const payload = { model: 'claude-sonnet-4-6', stream: true, input: 'go',
    tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }] }] };
  const native = commandRequest(payload);
  const name = native.body.tools[0].name;
  const { text } = await convert(payload, upstreamSse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_2', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]));
  const done = JSON.parse(text.trim().split('\ndata: ').at(-1));
  assert.equal(done.type, 'response.completed');
  assert.equal(done.response.output[0].namespace, 'functions');
  assert.equal(done.response.output[0].name, 'run');
  assert.equal(done.response.output[0].arguments, '{"x":1}');
  assert.equal(done.response.usage.total_tokens, 15);
});

test('non-stream response and truncation are normalized for compaction', async () => {
  const { text } = await convert({ model: 'gpt-5.4', input: 'summary', stream: false },
    Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
  assert.equal(JSON.parse(text).status, 'incomplete');
  assert.equal(JSON.parse(text).incomplete_details.reason, 'max_output_tokens');
});

test('broken stream fails closed; upstream HTTP errors remain errors', async () => {
  const { text } = await convert({ model: 'gpt-5.4', stream: true, input: 'hi' },
    upstreamSse([{ choices: [{ delta: { content: 'partial' } }] }]));
  assert.match(text, /response.failed/);
  assert.doesNotMatch(text, /response.completed/);
  const error = await convert({ model: 'gpt-5.4', input: 'hi' },
    Response.json({ error: { message: 'invalid key' } }, { status: 401 }));
  assert.equal(error.res.status, 401);
  assert.match(error.text, /invalid key/);
});

test('stateful requests still fail explicitly', () => {
  assert.throws(() => commandRequest({ model: 'gpt-5.4', previous_response_id: 'resp_old' }), /previous_response_id/);
});

test('extra tool types and tool choices pass through unchanged on both native endpoints', () => {
  for (const model of ['gpt-5.4', 'claude-sonnet-4-6']) {
    const search = { type: 'web_search', search_context_size: 'low', filters: { allowed_domains: ['example.com'] } };
    const other = { type: 'future_native_tool', options: { value: 42 } };
    const payload = { model, input: 'hi', tools: [
      search, { type: 'function', name: 'echo', parameters: { type: 'object' } },
      other, { type: 'web_search_preview' },
    ], tool_choice: { type: 'web_search' } };
    const before = structuredClone(payload);
    const request = commandRequest(payload);
    assert.deepEqual(request.body.tools[0], search);
    assert.deepEqual(request.body.tools[2], other);
    assert.deepEqual(request.body.tools[3], { type: 'web_search_preview' });
    assert.deepEqual(request.body.tool_choice, payload.tool_choice);
    assert.equal(request.body.tools.length, 4);
    assert.equal(model.startsWith('claude') ? request.body.tools[1].name : request.body.tools[1].function.name, 'echo');
    assert.deepEqual(payload, before);
  }
});

test('web_search reaches upstream; upstream rejection remains authoritative', async () => {
  let body;
  const response = await commandFetch({ base: 'https://example.test/provider' }, {},
    { model: 'gpt-5.4', input: 'hi', tools: [{ type: 'web_search' }] }, {
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return Response.json({ error: { message: 'Upstream does not accept this native tool' } }, { status: 400 });
      },
    });
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, 'Upstream does not accept this native tool');
});

test('HTTP integration: merged catalog, cmd routing, auth, gateway isolation and compaction', async t => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, authorization: req.headers.authorization,
      gatewayKey: req.headers['x-api-key'], account: req.headers['chatgpt-account-id'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-flash', context_length: 1000000 }, { id: 'claude-sonnet-4-6', context_length: 1000000 }, { id: 'deepseek/deepseek-v4.1-flash', context_length: 1000000 }, { id: 'blocked-model' }] }));
    } else if (req.url === '/provider/v1/chat/completions') {
      const synthetic = body.tools?.find(t => t.function?.name.startsWith('mb_web_search'));
      if (synthetic && !body.messages.some(m => m.role === 'tool')) {
        return res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{
          id: 'search_http', type: 'function', function: { name: synthetic.function.name, arguments: '{"query":"Node docs"}' },
        }] }, finish_reason: 'tool_calls' }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'Summary or answer' }, finish_reason: 'stop' }] }));
    } else if (req.url === '/provider/v1/messages') {
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Claude answer' }], stop_reason: 'end_turn' }));
    } else if (req.url === '/gateway/v1/responses' && body.model === 'gpt-5.6-sol') {
      res.end(JSON.stringify({ status: 'completed', output: [
        { id: 'ws_http', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Node docs' } },
        { id: 'msg_http', type: 'message', content: [{ type: 'output_text', text: 'Node documentation', annotations: [] }] },
      ] }));
    } else {
      res.end(JSON.stringify({ status: 'completed', output: [] }));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyfile = path.join(dir, 'key');
  fs.writeFileSync(keyfile, 'test-cmd-key\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1', port, officialModels: { enabled: false },
    backends: [
      { name: 'cmd', base: `http://127.0.0.1:${upstreamPort}/provider`, prefix: 'cmd/', protocol: 'command-code', reasoning: 'command-code', modelAllowlist: ['deepseek/deepseek-v4-flash', 'claude-sonnet-4-6', 'deepseek/deepseek-v4.1-flash'], auth: { type: 'keyfile', file: keyfile },
        webSearch: { backend: 'gateway', model: 'gpt-5.6-sol', maxSearches: 2, timeoutMs: 1000 } },
      { name: 'gateway', base: `http://127.0.0.1:${upstreamPort}/gateway`, prefix: '', auth: { type: 'gateway', key: 'test-gateway-key' } },
    ],
  }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, MB_CONFIG_FILE: configPath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, logs);
  const catalog = await (await fetch(`${base}/v1/models`)).json();
  const model = catalog.models.find(m => m.slug === 'cmd/deepseek/deepseek-v4-flash');
  assert.equal(model.context_window, 1000000);
  assert.ok(catalog.data.some(m => m.id === 'cmd/claude-sonnet-4-6'));
  assert.equal(catalog.models.filter(m => m.slug.startsWith('cmd/')).length, 3);
  assert.equal(catalog.data.filter(m => m.id.startsWith('cmd/')).length, 3);
  const reasoningModel = catalog.models.find(m => m.slug === 'cmd/deepseek/deepseek-v4.1-flash');
  assert.equal(reasoningModel.default_reasoning_level, 'high');
  assert.deepEqual(reasoningModel.supported_reasoning_levels.map(l => l.effort), ['low', 'high', 'max']);
  const beforeBlocked = requests.length;
  for (const pathname of ['/v1/responses', '/v1/chat/completions']) {
    for (const name of ['blocked-model', 'future-model', 'DEEPSEEK/deepseek-v4-flash']) {
      const denied = await fetch(`${base}${pathname}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `cmd/${name}`, input: [{ type: 'compaction_trigger' }] }),
      });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.type, 'model_not_allowed');
    }
  }
  assert.equal(requests.length, beforeBlocked, 'blocked requests must not reach cmd or fall back to gateway');
  const post = async body => {
    const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, logs);
    return res.json();
  };
  await post({ model: 'cmd/deepseek/deepseek-v4-flash', input: 'hello' });
  assert.equal(requests.at(-1).url, '/provider/v1/chat/completions');
  assert.equal(requests.at(-1).body.model, 'deepseek/deepseek-v4-flash');
  assert.equal(requests.at(-1).authorization, 'Bearer test-cmd-key');
  await post({ model: 'cmd/deepseek/deepseek-v4.1-flash', input: 'hello', reasoning: { effort: 'max' } });
  assert.equal(requests.at(-1).body.reasoning_effort, 'max');
  await post({ model: 'cmd/claude-sonnet-4-6', input: 'hello' });
  assert.equal(requests.at(-1).url, '/provider/v1/messages');
  const compact = await post({ model: 'cmd/deepseek/deepseek-v4-flash', input: [
    { role: 'user', content: 'history' },
    { type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'call_history', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_history', output: '/project' },
    { type: 'compaction_trigger' },
  ] });
  assert.equal(compact.output[0].type, 'compaction');
  await post({ model: 'cmd/claude-sonnet-4-6', input: [compact.output[0], { role: 'user', content: 'continue' }] });
  assert.match(JSON.stringify(requests.at(-1).body.messages), /Summary or answer/);
  assert.equal(requests.filter(r => r.body && r.url.startsWith('/gateway')).length, 0);
  await post({ model: 'gpt-gateway', input: 'hello' });
  assert.equal(requests.at(-1).url, '/gateway/v1/responses');
  const beforeSearch = requests.length;
  const searched = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer codex-user-token',
      'chatgpt-account-id': 'codex-account', 'x-private-context': 'must-not-be-forwarded' },
    body: JSON.stringify({ model: 'cmd/deepseek/deepseek-v4-flash', input: 'Find Node docs',
      tools: [{ type: 'web_search', external_web_access: false }], stream: false }),
  });
  assert.equal(searched.status, 200);
  const searchResponse = await searched.json();
  assert.ok(searchResponse.output.some(i => i.type === 'web_search_call' && i.status === 'completed'));
  const searchRequests = requests.slice(beforeSearch);
  assert.equal(searchRequests.length, 3);
  assert.equal(searchRequests[0].authorization, 'Bearer test-cmd-key');
  assert.equal(searchRequests[1].authorization, 'Bearer codex-user-token');
  assert.equal(searchRequests[1].gatewayKey, 'test-gateway-key');
  assert.equal(searchRequests[1].account, 'codex-account');
  assert.equal(searchRequests[1].body.model, 'gpt-5.6-sol');
  assert.equal(searchRequests[2].body.model, 'deepseek/deepseek-v4-flash');
});

test('cancelling converted SSE aborts the upstream request', async () => {
  let upstreamSignal;
  const res = await commandFetch({ base: 'https://example.test' }, {}, { model: 'gpt-5.4', stream: true, input: 'hi' }, {
    fetchImpl: async (_url, options) => {
      upstreamSignal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          upstreamSignal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstreamSignal.aborted, true);
});

test('custom tools restore long aliases in Responses events', () => {
  const { buildAliasMap, rewriteRequestPayload, makeRespRewriter } = require('../tool-names');
  const name = `mcp__long_connector__long_server__${'apply_patch_'.repeat(5)}`;
  const payload = { tools: [{ type: 'custom', name }] };
  const { fwd, rev } = buildAliasMap(payload.tools);
  rewriteRequestPayload(payload, fwd);
  assert.notEqual(payload.tools[0].name, name);
  const restored = JSON.parse(makeRespRewriter(rev)(JSON.stringify({
    type: 'custom_tool_call', name: payload.tools[0].name, input: 'patch',
  })));
  assert.equal(restored.name, name);
});
