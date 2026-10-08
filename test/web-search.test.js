'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandSearchFetch, collectResponse, prepareSearch } = require('../src/adapters/command-code/search');

const backend = { base: 'https://cmd.test/provider' };
const search = { base: 'https://gateway.test', model: 'gpt-5.6-sol',
  headers: { authorization: 'Bearer codex-token', 'x-api-key': 'gateway-key' },
  maxSearches: 2, timeoutMs: 1000 };
const hosted = { type: 'web_search', external_web_access: false, filters: { allowed_domains: ['nodejs.org'] } };
const payload = { model: 'deepseek/deepseek-v4.1-flash', input: 'Find the fs docs', stream: true,
  tools: [hosted, { type: 'function', name: 'echo', parameters: { type: 'object' } }] };
function chat(content, calls = []) {
  return Response.json({ choices: [{ message: { content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } });
}
function call(name, query, id = 'search_call') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify({ query }) } };
}
function sse(events) {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function searchResult() {
  return sse([
    { type: 'response.output_item.done', output_index: 0, item: {
      id: 'ws_real', type: 'web_search_call', status: 'completed',
      action: { type: 'search', query: 'fs docs', sources: [{ type: 'url', url: 'https://nodejs.org/api/fs.html', title: 'Node fs' }] },
    } },
    { type: 'response.output_text.delta', item_id: 'msg_real', output_index: 1, content_index: 0, delta: 'Use fs.readFile.' },
    { type: 'response.output_text.annotation.added', item_id: 'msg_real', output_index: 1, content_index: 0,
      annotation: { type: 'url_citation', url: 'https://nodejs.org/api/fs.html', title: 'Node fs', start_index: 0, end_index: 4 } },
    // Actual gateway behavior: the terminal snapshot can omit the output items.
    { type: 'response.completed', response: { id: 'resp_search', status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 5 } } },
  ]);
}

test('collect gateway SSE output before an empty terminal snapshot, and fail closed on interruption', async () => {
  const r = await collectResponse(searchResult());
  assert.equal(r.output[0].type, 'web_search_call');
  assert.equal(r.output[1].content[0].text, 'Use fs.readFile.');
  assert.equal(r.output[1].content[0].annotations.length, 1);
  await assert.rejects(collectResponse(sse([{ type: 'response.output_text.delta', delta: 'partial' }])), /terminal|completed/i);
});

test('collect SSE even when the gateway labels its body application/json', async () => {
  const response = new Response(await searchResult().text(), { headers: { 'content-type': 'application/json' } });
  const result = await collectResponse(response);
  assert.equal(result.status, 'completed');
  assert.equal(result.output[0].type, 'web_search_call');
});

test('replace hosted tools without name collisions; forced search is guarded rather than forcing DeepSeek function choice', () => {
  const prepared = prepareSearch({ ...payload, tools: [...payload.tools, { type: 'function', name: 'mb_web_search' }],
    tool_choice: { type: 'web_search' } });
  assert.notEqual(prepared.name, 'mb_web_search');
  assert.ok(prepared.payload.tools.every(t => t.type === 'function'));
  assert.deepEqual(prepared.hosted, hosted);
  assert.equal(prepared.payload.tool_choice, 'auto');
  assert.equal(prepared.required, true);
  assert.deepEqual(payload.tools[0], hosted);
});

test('route search only to Sol, preserve auth boundaries, stream real search results, then return to original model', async () => {
  const requests = [];
  let mainCalls = 0;
  let syntheticName;
  const response = await commandSearchFetch(backend, { authorization: 'Bearer cmd-key' }, { ...payload, reasoning: { effort: 'max' } }, {
    search,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, headers: options.headers, body });
      if (url.endsWith('/v1/responses')) return searchResult();
      mainCalls++;
      if (mainCalls === 1) {
        syntheticName = body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name;
        return chat(null, [call(syntheticName, 'fs docs')]);
      }
      assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('Use fs.readFile')));
      return chat('See the Node.js docs.');
    },
  });
  const result = await collectResponse(response);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body.model, 'gpt-5.6-sol');
  assert.equal(requests[1].body.reasoning.effort, 'low');
  assert.equal(requests[0].body.reasoning_effort, 'max');
  assert.equal(requests[2].body.reasoning_effort, 'max');
  assert.deepEqual(requests[1].body.tools, [hosted]);
  assert.equal(JSON.stringify(requests[1].body).includes('Find the fs docs'), false, 'do not forward complete conversation');
  assert.equal(requests[1].headers.authorization, 'Bearer codex-token');
  assert.equal(requests[0].headers.authorization, 'Bearer cmd-key');
  assert.equal(requests[2].body.model, payload.model);
  assert.equal(requests[0].body.tools.some(t => t.type === 'web_search'), false);
  assert.ok(result.output.some(i => i.type === 'web_search_call' && i.status === 'completed'));
  assert.equal(result.output.some(i => i.type === 'function_call' && i.name === syntheticName), false);
  assert.ok(result.output.some(i => i.type === 'message' && i.content.some(p => p.annotations?.some(a => a.url.includes('nodejs.org')))));
  assert.equal(result.output.at(-1).content[0].text, 'See the Node.js docs.');
  // Replay doesn't leak synthetic tool calls or reject native web_search metadata.
  const { commandRequest } = require('../src/adapters/command-code/client');
  const replay = commandRequest({ ...payload, input: [...result.output, { role: 'user', content: 'continue' }] });
  assert.ok(JSON.stringify(replay.body.messages).includes('Use fs.readFile'));
});

test('mixed ordinary and search calls: execute only search and return ordinary tools to Codex', async () => {
  let mainCalls = 0;
  const response = await commandSearchFetch(backend, {}, { ...payload, stream: false }, {
    search,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/responses')) return searchResult();
      mainCalls++;
      const body = JSON.parse(options.body);
      const name = body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name;
      return chat(null, [call(name, 'fs docs'), call('echo', 'hello', 'ordinary_call')]);
    },
  });
  const r = await response.json();
  assert.equal(mainCalls, 1);
  assert.equal(r.status, 'completed');
  assert.ok(r.output.some(i => i.type === 'function_call' && i.name === 'echo'));
  assert.ok(r.output.some(i => i.type === 'message' && i.phase === 'commentary'));
});

test('a response with no actual search is not reported as successful web search', async () => {
  const r = await commandSearchFetch(backend, {}, { ...payload, stream: false }, {
    search,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/responses')) return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Guess' }] }] });
      const body = JSON.parse(options.body);
      return chat(null, [call(body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name, 'fs docs')]);
    },
  });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /actual|search/i);
});

test('search upstream HTTP errors fail explicitly without silently switching model or provider', async () => {
  let requests = 0;
  const response = await commandSearchFetch(backend, {}, payload, {
    search,
    fetchImpl: async (url, options) => {
      requests++;
      if (url.endsWith('/v1/responses')) return Response.json({ error: { message: 'Search unauthorized' } }, { status: 401 });
      const body = JSON.parse(options.body);
      return chat(null, [call(body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name, 'fs docs')]);
    },
  });
  const text = await response.text();
  assert.equal(requests, 2);
  assert.match(text, /response.failed/);
  assert.match(text, /401/);
  assert.doesNotMatch(text, /response.completed/);
});

test('search count is bounded and final pass drops synthetic tool', async () => {
  let count = 0, mainCalls = 0;
  const response = await commandSearchFetch(backend, {}, { ...payload, stream: false }, {
    search: { ...search, maxSearches: 1 },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/responses')) { count++; return searchResult(); }
      mainCalls++;
      const body = JSON.parse(options.body);
      const tool = body.tools?.find(t => t.function?.name.startsWith('mb_web_search'));
      return tool ? chat(null, [call(tool.function.name, 'fs docs')]) : chat('Final answer');
    },
  });
  assert.equal((await response.json()).status, 'completed');
  assert.equal(count, 1);
  assert.equal(mainCalls, 2);
});

test('client cancellation aborts the active Sol search request', async () => {
  let searchSignal, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = await commandSearchFetch(backend, {}, payload, {
    search,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/responses')) {
        searchSignal = options.signal;
        started();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort',
          () => reject(new Error('Cancelled')), { once: true }));
      }
      const body = JSON.parse(options.body);
      return chat(null, [call(body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name, 'fs docs')]);
    },
  });
  const reader = response.body.getReader();
  await reader.read();
  await waiting;
  await reader.cancel();
  assert.equal(searchSignal.aborted, true);
});

test('Sol timeout is surfaced as a failure, without retries or an ungrounded final answer', async () => {
  let count = 0;
  const response = await commandSearchFetch(backend, {}, { ...payload, stream: false }, {
    search: { ...search, timeoutMs: 10 },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/responses')) {
        count++;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort',
          () => reject(options.signal.reason), { once: true }));
      }
      const body = JSON.parse(options.body);
      return chat(null, [call(body.tools.find(t => t.function.name.startsWith('mb_web_search')).function.name, 'fs docs')]);
    },
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /timed out/);
  assert.equal(count, 1);
});
