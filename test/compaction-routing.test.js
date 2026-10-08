'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { decodeCompactionEnvelope, encodeMbCmp1 } = require('../src/core/compaction');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function modelsResponse(id) {
  return {
    object: 'list',
    data: [{ id, object: 'model', owned_by: 'test', context_window: 1_000_000 }],
  };
}

function completedResponse(model, output, extra = {}) {
  return {
    id: 'resp_upstream',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...extra,
  };
}

function assistantMessage(text) {
  return {
    type: 'message',
    id: 'msg_test',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function userMessage(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

function srCmp1(summary) {
  return `sr-cmp1:${Buffer.from(JSON.stringify({ v: 1, summary }), 'utf8').toString('base64')}`;
}

/** 解析 SSE 文本为 { type, data } 列表。 */
function parseSse(body) {
  const events = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find(line => line.startsWith('data:'));
    if (!dataLine) continue;
    const data = JSON.parse(dataLine.slice('data:'.length).trim());
    events.push({ type: data.type, data });
  }
  return events;
}

/** 起一个假后端：/v1/models 返回单模型目录，/v1/responses 交给 onResponses。 */
async function startBackend(t, modelId, onResponses) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return jsonResponse(res, modelsResponse(modelId));
    }
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const body = await readJson(req);
      requests.push(body);
      return onResponses(res, body);
    }
    jsonResponse(res, { error: 'not found' }, 404);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, requests };
}

async function waitUntilReady(port, child, logs) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`metabridge exited before becoming ready: ${child.exitCode}\n${logs()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw lastError || new Error('metabridge did not become ready');
}

/** 起 metabridge 子进程，返回 { post, logs }。 */
async function startBridge(t, backends, env = {}, extraConfig = {}) {
  const reservation = http.createServer();
  const bridgePort = await listen(reservation);
  await close(reservation);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-compaction-test-'));
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port: bridgePort,
    catalogTtlMs: 60_000,
    officialModels: { enabled: false },
    backends,
    ...extraConfig,
  }));

  let childLogs = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, MB_CONFIG_FILE: configPath, MB_LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { childLogs += chunk.toString(); });
  child.stderr.on('data', chunk => { childLogs += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const logs = () => childLogs;
  await waitUntilReady(bridgePort, child, logs);

  return {
    logs,
    port: bridgePort,
    post: (body) => fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

function prefixedBackend(port) {
  return {
    name: 'prefixed-test',
    base: `http://127.0.0.1:${port}`,
    prefix: 'ThirdParty/',
    auth: { type: 'none' },
    priority: 100,
    reasoning: 'full',
  };
}

function gatewayBackend(port) {
  return {
    name: 'gateway-test',
    base: `http://127.0.0.1:${port}`,
    prefix: '',
    auth: { type: 'none' },
    priority: 50,
    reasoning: 'full',
  };
}

for (const via of ['direct', 'cpa']) {
test(`${via} provider can locally compact every model without legacy adaptations`, async t => {
  const upstream = await startBackend(t, 'vendor/model', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('Complete provider checkpoint')])));
  const bridge = await startBridge(t, [{
    ...gatewayBackend(upstream.port), name: 'neutral-provider', via,
    compaction: { mode: 'local', stripImages: true },
  }]);
  const compact = await bridge.post({ model: 'vendor/model', input: [
    userMessage('old history'), { type: 'compaction_trigger' },
  ] });
  assert.equal(compact.status, 200);
  const item = (await compact.json()).output[0];
  assert.equal(item.type, 'compaction');
  assert.match(decodeCompactionEnvelope(item.encrypted_content), /Complete provider checkpoint/);
  assert.ok(!JSON.stringify(upstream.requests[0]).includes('compaction_trigger'));
  const tools = [{ type: 'function', name: 'long_tool_name_'.repeat(10) }];
  await (await bridge.post({ model: 'vendor/model', tools,
    input: [userMessage('old history'), item, userMessage('new turn')] })).text();
  assert.equal(upstream.requests[1].input.length, 2);
  assert.equal(upstream.requests[1].input[0].role, 'assistant');
  assert.deepEqual(upstream.requests[1].tools, tools);
  const health = await (await fetch(`http://127.0.0.1:${bridge.port}/healthz`)).json();
  assert.equal(health.backends['neutral-provider'].via, via);
  assert.equal(health.backends['neutral-provider'].requestMode, 'passthrough');
  assert.equal(health.backends['neutral-provider'].compaction.mode, 'local');
});
}

for (const model of ['factory/claude-sonnet-5-5', 'fusecode/claude-sonnet-5-5']) {
test(`CPA passthrough synthesizes ${model} compaction and replays its checkpoint`, async t => {
  const upstream = await startBackend(t, model, (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('checkpoint: screenshot showed sidebar; test remains')])));
  const bridge = await startBridge(t, [{
    ...gatewayBackend(upstream.port), name: 'cpa', requestMode: 'passthrough',
    compaction: { mode: 'local', models: [
      { regex: '^factory/claude-' }, { regex: '^fusecode/claude-' },
    ], stripImages: true },
  }]);
  const history = [
    userMessage('Screenshot of the sidebar'),
    { type: 'function_call_output', call_id: 'view', output: [
      { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}` },
    ] },
    assistantMessage('Screenshot showed sidebar; test remains'),
  ];
  const compact = await bridge.post({ model, stream: true,
    input: [...history, { type: 'compaction_trigger' }], tools: [{ type: 'function', name: 'shell' }] });
  const events = parseSse(await compact.text());
  const item = events.find(e => e.type === 'response.completed')?.data.response.output[0];
  assert.equal(item?.type, 'compaction');
  assert.match(decodeCompactionEnvelope(item.encrypted_content), /sidebar/);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].model, model);
  assert.equal(upstream.requests[0].tools, undefined);
  assert.ok(!JSON.stringify(upstream.requests[0]).includes('base64,'));
  assert.ok(!JSON.stringify(upstream.requests[0]).includes('compaction_trigger'));
  assert.match(JSON.stringify(upstream.requests[0]), /Screenshot showed sidebar/);
  await (await bridge.post({ model,
    input: [...history, item, userMessage('Continue')] })).text();
  assert.equal(upstream.requests[1].input.length, 2);
  assert.equal(upstream.requests[1].input[0].role, 'assistant');
  assert.match(upstream.requests[1].input[0].content[0].text, /checkpoint/);
  const ordinary = { model, input: [userMessage('ordinary')],
    tools: [{ type: 'function', name: 'shell' }], reasoning: { effort: 'high' } };
  await (await bridge.post(ordinary)).text();
  assert.deepEqual(upstream.requests[2], ordinary);
  const unaffected = { model: 'factory/gpt-test', input: [{ type: 'compaction_trigger' }] };
  await (await bridge.post(unaffected)).text();
  assert.deepEqual(upstream.requests[3], unaffected);
});
}

test('CPA local compaction never emits a checkpoint when upstream summary fails', async t => {
  const upstream = await startBackend(t, 'factory/claude-test', res =>
    jsonResponse(res, { error: { message: 'upstream rejected' } }, 413));
  const bridge = await startBridge(t, [{
    ...gatewayBackend(upstream.port), requestMode: 'passthrough',
    compaction: { mode: 'local', models: [{ regex: '^factory/claude-' }], stripImages: true },
  }]);
  const response = await bridge.post({ model: 'factory/claude-test', stream: true,
    input: [userMessage('history'), { type: 'compaction_trigger' }] });
  const events = parseSse(await response.text());
  assert.ok(events.some(e => e.type === 'response.failed'));
  assert.ok(!events.some(e => e.type === 'response.completed' || e.type === 'response.output_item.done'));
});

test('压缩由带前缀后端本地合成，gateway 完全不参与', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('本地产出的交接摘要')])));
  const gateway = await startBackend(t, 'gateway-compactor', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('gateway 不该被调用')])));

  const bridge = await startBridge(t, [prefixedBackend(backend.port), gatewayBackend(gateway.port)]);

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    tools: [{ type: 'function', name: 'shell' }],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '老上下文' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      { type: 'compaction_trigger' },
    ],
  });

  assert.equal(response.status, 200, bridge.logs());
  const body = await response.json();

  // Codex 侧：恰好一条 compaction item，信封可解码
  assert.equal(body.status, 'completed');
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].type, 'compaction');
  assert.equal(decodeCompactionEnvelope(body.output[0].encrypted_content), '本地产出的交接摘要');
  assert.ok(body.usage.input_tokens_details, '严格客户端把 usage 明细当必填字段');

  // 后端侧：一次普通摘要请求，没有 compaction 概念，没有工具；图片原样保留
  assert.equal(gateway.requests.length, 0, 'gateway 不应参与压缩');
  assert.equal(backend.requests.length, 1);
  const summarization = backend.requests[0];
  assert.equal(summarization.model, 'gpt-test');
  assert.equal(summarization.tools, undefined);
  assert.ok(!summarization.input.some(item => item.type === 'compaction_trigger'));
  assert.ok(JSON.stringify(summarization).includes('base64,AAAA'), '图片应原样带给摘要模型');
  const last = summarization.input[summarization.input.length - 1];
  assert.match(last.content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
});

test('流式压缩返回 created / output_item.done / completed 三段事件', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '流式摘要' })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse(body.model, []) })}\n\n`);
    res.end();
  });

  const bridge = await startBridge(t, [prefixedBackend(backend.port)]);

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: true,
    input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
  });

  assert.equal(response.status, 200, bridge.logs());
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const events = parseSse(await response.text());
  const types = events.map(e => e.type);
  assert.deepEqual(
    types.filter(name => name !== 'response.heartbeat'),
    ['response.created', 'response.output_item.done', 'response.completed']
  );

  const itemEvent = events.find(e => e.type === 'response.output_item.done');
  assert.equal(itemEvent.data.item.type, 'compaction');
  assert.equal(decodeCompactionEnvelope(itemEvent.data.item.encrypted_content), '流式摘要');

  const completed = events.find(e => e.type === 'response.completed');
  assert.equal(completed.data.response.output.length, 1, 'Codex 要求恰好一条 compaction item');
  assert.equal(completed.data.response.output[0].id, itemEvent.data.item.id);
});

test('压缩等待期间发心跳，避免 Codex 空闲超时', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) => {
    setTimeout(() => {
      jsonResponse(res, completedResponse(body.model, [assistantMessage('慢摘要')]));
    }, 220);
  });

  const bridge = await startBridge(t, [prefixedBackend(backend.port)], {
    MB_COMPACTION_HEARTBEAT_MS: '40',
  });

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: true,
    input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
  });

  const events = parseSse(await response.text());
  assert.ok(
    events.filter(e => e.type === 'response.heartbeat').length >= 1,
    `等待期间应有心跳：${JSON.stringify(events.map(e => e.type))}`
  );
  assert.equal(events[events.length - 1].type, 'response.completed');
});

test('截断的摘要绝不能变成 compaction item', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('半截摘要')], {
      incomplete_details: { reason: 'max_output_tokens' },
    })));

  const bridge = await startBridge(t, [prefixedBackend(backend.port)]);

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
  });

  assert.equal(response.status, 502, bridge.logs());
  const body = await response.json();
  assert.equal(body.error.type, 'upstream_error');
  assert.match(body.error.message, /截断/);
  assert.equal(JSON.stringify(body).includes('compaction'), false);
});

test('流式压缩失败时用 response.failed 收口，不发出 compaction item', async t => {
  const backend = await startBackend(t, 'gpt-test', res =>
    jsonResponse(res, { error: { message: '上游炸了' } }, 500));

  const bridge = await startBridge(t, [prefixedBackend(backend.port)]);

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: true,
    input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
  });

  const events = parseSse(await response.text());
  const types = events.map(e => e.type).filter(name => name !== 'response.heartbeat');
  assert.deepEqual(types, ['response.created', 'response.failed']);
  const failed = events.find(e => e.type === 'response.failed');
  assert.match(failed.data.response.error.message, /上游炸了/);
});

test('纯第三方部署（没有 gateway）也能完成压缩', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('无 gateway 也能压缩')])));

  const bridge = await startBridge(t, [prefixedBackend(backend.port)]);

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
  });

  assert.equal(response.status, 200, bridge.logs());
  const body = await response.json();
  assert.equal(body.output[0].type, 'compaction');
  assert.equal(decodeCompactionEnvelope(body.output[0].encrypted_content), '无 gateway 也能压缩');
});

test('回放：mb-cmp1 与 sr-cmp1 都物化成 assistant checkpoint，opaque 则 fail closed', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('ok')])));

  const bridge = await startBridge(t, [prefixedBackend(backend.port)]);

  const envelopes = [
    ['mb-cmp1', encodeMbCmp1('历史 checkpoint')],
    ['sr-cmp1', srCmp1('历史 checkpoint')],
  ];
  for (const [label, envelope] of envelopes) {
    const response = await bridge.post({
      model: 'ThirdParty/gpt-test',
      stream: false,
      input: [
        userMessage('过期问题一'),
        userMessage('过期问题二'),
        { type: 'compaction', id: `cmp_${label}`, encrypted_content: envelope },
        userMessage('最新问题'),
      ],
    });
    assert.equal(response.status, 200, `${label}: ${bridge.logs()}`);

    const replayed = backend.requests[backend.requests.length - 1].input;
    assert.equal(replayed.length, 2, label);
    assert.equal(replayed[0].role, 'assistant', label);
    assert.match(replayed[0].content[0].text, /历史 checkpoint/);
    assert.deepEqual(replayed[1], userMessage('最新问题'));
    assert.doesNotMatch(JSON.stringify(replayed), /过期问题/);
  }

  const requestsBefore = backend.requests.length;
  const opaque = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    input: [
      { type: 'compaction', id: 'cmp_opaque', encrypted_content: 'gAAAAABm-official-fernet' },
      userMessage('最新问题'),
    ],
  });

  assert.equal(opaque.status, 400);
  assert.equal((await opaque.json()).error.type, 'unsupported_compaction_format');
  assert.equal(backend.requests.length, requestsBefore, '解不开的 checkpoint 不能继续发给后端');
});

test('客户端取消压缩后进程存活，心跳停止，上游被中止', async t => {
  let upstreamAborted = false;
  const backend = await startBackend(t, 'gpt-test', (res, body) => {
    // 连接在响应写完之前就关掉，说明 metabridge 中止了这次上游请求
    res.on('close', () => { if (!res.writableEnded) upstreamAborted = true; });
    setTimeout(() => {
      if (!res.writableEnded) jsonResponse(res, completedResponse(body.model, [assistantMessage('迟到的摘要')]));
    }, 400);
  });

  const bridge = await startBridge(t, [prefixedBackend(backend.port)], {
    MB_COMPACTION_HEARTBEAT_MS: '20',
  });

  const controller = new AbortController();
  const started = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'ThirdParty/gpt-test',
      stream: true,
      input: [userMessage('老上下文'), { type: 'compaction_trigger' }],
    }),
    signal: controller.signal,
  });

  // 头和 response.created 是立刻回的，所以 fetch 早已 resolve；取消要打在读 body 的过程中
  assert.equal(started.status, 200);
  const pending = started.text();
  await new Promise(resolve => setTimeout(resolve, 120));
  controller.abort();
  await assert.rejects(pending);

  // 心跳还在按 20ms 跑，取消后如果继续往已销毁的响应写，进程会被未监听的 error 事件带走
  await new Promise(resolve => setTimeout(resolve, 250));

  const health = await fetch(`http://127.0.0.1:${bridge.port}/healthz`);
  assert.equal(health.status, 200, `取消压缩后进程应存活：${bridge.logs()}`);
  assert.match(bridge.logs(), /compaction 被客户端取消/);
  assert.ok(upstreamAborted, '取消后上游摘要请求应被中止');
});

test('compactionStripImages=true 时摘要请求不带图片', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('剥图后的摘要')])));

  const bridge = await startBridge(t, [prefixedBackend(backend.port)], {}, {
    compactionStripImages: true,
  });

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '看这张图' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ] },
      { type: 'compaction_trigger' },
    ],
  });

  assert.equal(response.status, 200, bridge.logs());
  assert.equal((await response.json()).output[0].type, 'compaction');

  const summarization = backend.requests[0];
  assert.equal(JSON.stringify(summarization).includes('base64,AAAA'), false);
  assert.match(JSON.stringify(summarization), /image omitted for compaction/);
  assert.match(bridge.logs(), /剥离图片/);
});

test('MB_COMPACTION_STRIP_IMAGES 覆盖配置文件里的 false', async t => {
  const backend = await startBackend(t, 'gpt-test', (res, body) =>
    jsonResponse(res, completedResponse(body.model, [assistantMessage('摘要')])));

  const bridge = await startBridge(
    t,
    [prefixedBackend(backend.port)],
    { MB_COMPACTION_STRIP_IMAGES: '1' },
    { compactionStripImages: false }
  );

  const response = await bridge.post({
    model: 'ThirdParty/gpt-test',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '看这张图' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ] },
      { type: 'compaction_trigger' },
    ],
  });

  assert.equal(response.status, 200, bridge.logs());
  assert.equal(JSON.stringify(backend.requests[0]).includes('base64,AAAA'), false, '环境变量应覆盖配置文件');
});
