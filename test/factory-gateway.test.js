'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeFactoryGateway, transformFactoryInstructions } = require('../factory-gateway');

test('Factory prefix mode keeps native instruction priority and tool history', () => {
  const prefix = 'You are Droid, an AI software engineering agent built by Factory.';
  const body = { instructions: 'Codex rules', input: [{ role: 'developer', content: 'developer rules' }] };
  const result = transformFactoryInstructions('responses', body, 'factory_prefix');
  assert.equal(result.instructions, prefix + '\n\nCodex rules');
  assert.deepEqual(result.input, body.input);
  assert.equal(body.instructions, 'Codex rules');
  assert.deepEqual(transformFactoryInstructions('responses', result, 'factory_prefix'), result);
  const messages = { system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }], messages: [] };
  assert.deepEqual(transformFactoryInstructions('messages', messages, 'factory_prefix').system.slice(1), messages.system);
  const chat = { messages: [{ role: 'system', content: 'rules' }, { role: 'developer', content: 'd' }] };
  assert.equal(transformFactoryInstructions('chat', chat, 'factory_prefix').messages[0].content, prefix + '\n\nrules');
  assert.deepEqual(transformFactoryInstructions('chat', chat, 'factory_prefix').messages[1], chat.messages[1]);
});

test('Factory probe uses only explicitly configured compatibility version metadata', async () => {
  let requests = 0;
  await probeFactoryGateway('fixture', {
    instructionMode: 'factory_prefix', clientVersion: '0.162.1',
    fetch: async (url, opts) => {
      requests++;
      assert.equal(opts.headers['User-Agent'], 'metabridge-factory/0.2');
      assert.equal(opts.headers['X-Client-Version'], '0.162.1');
      if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
      return new Response('{}', { status: 403 });
    },
  });
  assert.equal(requests, 4);
  await assert.rejects(probeFactoryGateway('fixture', { clientVersion: 'bad\nvalue', fetch: async () => {
    throw new Error('must not be reached');
  } }), /client version/);
});

test('Factory instruction folding covers native protocols without mutating tools or multimodal content', () => {
  const image = { type: 'input_image', image_url: 'https://example.test/image.png' };
  const call = { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' };
  const output = { type: 'function_call_output', call_id: 'call-1', output: 'file content' };
  const body = {
    instructions: 'system rules',
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'question' }, image] }, call, output],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    stream: true,
  };
  const before = JSON.stringify(body);
  const folded = transformFactoryInstructions('responses', body, 'fold_system_into_user');
  assert.equal(folded.instructions, undefined);
  assert.equal(folded.input[0].role, 'user');
  assert.equal(folded.input[0].content[0].text, '<system>\nsystem rules\n\ndeveloper rules\n</system>\n\n');
  assert.deepEqual(folded.input[0].content.slice(1), body.input[1].content);
  assert.deepEqual(folded.input.slice(1), [call, output]);
  assert.deepEqual(folded.tools, body.tools);
  assert.equal(folded.stream, true);
  assert.equal(JSON.stringify(body), before);
  assert.deepEqual(transformFactoryInstructions('responses', folded, 'fold_system_into_user'), folded);

  const chat = transformFactoryInstructions('chat', {
    messages: [{ role: 'system', content: 's' }, { role: 'developer', content: 'd' },
      { role: 'assistant', tool_calls: [{ id: 'x' }] }, { role: 'tool', tool_call_id: 'x', content: 'result' }],
  }, 'fold_system_into_user');
  assert.deepEqual(chat.messages[0], { role: 'user', content: '<system>\ns\n\nd\n</system>\n\n' });
  assert.equal(chat.messages[1].role, 'assistant');
  assert.equal(chat.messages[2].role, 'tool');

  const messages = transformFactoryInstructions('messages', {
    system: [{ type: 'text', text: 's' }],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result' }] }],
  }, 'fold_system_into_user');
  assert.equal(messages.system, undefined);
  assert.equal(messages.messages[0].content[0].text, '<system>\ns\n</system>\n\n');
  assert.equal(messages.messages[0].content[1].type, 'tool_result');
});

test('Factory folding supports input strings and fails closed on unsupported instruction content', () => {
  const body = { instructions: 's', input: 'question' };
  assert.equal(transformFactoryInstructions('responses', body), body);
  assert.equal(transformFactoryInstructions('responses', body, 'fold_system_into_user').input[0].content,
    '<system>\ns\n</system>\n\nquestion');
  assert.throws(() => transformFactoryInstructions('chat', {
    messages: [{ role: 'system', content: [{ type: 'image_url', image_url: 'x' }] }],
  }, 'fold_system_into_user'), /instruction content/);
  assert.throws(() => transformFactoryInstructions('responses', body, 'typo'), /instruction mode/);
});

test('Factory probe applies the explicitly chosen fold mode to all requests, keeping its own client identity', async () => {
  const calls = [];
  await probeFactoryGateway('fixture', { instructionMode: 'fold_system_into_user', fetch: async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.headers['User-Agent'], 'metabridge-factory/0.2');
    if (url.endsWith('/whoami')) return new Response(JSON.stringify({ orgId: 'fixture-org' }));
    return new Response('{}', { status: 403 });
  } });
  const responses = JSON.parse(calls[1].opts.body);
  assert.equal(responses.instructions, undefined);
  assert.ok(responses.input.every(x => !['system', 'developer'].includes(x.role)));
  assert.match(responses.input[0].content, /Reply with exactly OK/);
  assert.equal(JSON.parse(calls[2].opts.body).system, undefined);
  assert.equal(JSON.parse(calls[3].opts.body).messages[0].role, 'user');
  let count = 0;
  await assert.rejects(probeFactoryGateway('fixture', {
    instructionMode: 'typo', fetch: async () => { count++; },
  }), /instruction mode/);
  assert.equal(count, 0);
});

test('Factory probe preserves system/developer instructions and exposes failure without retries or fallback', async () => {
  const calls = [];
  const result = await probeFactoryGateway('fixture-private', { fetch: async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, 'Bearer fixture-private');
    assert.equal(opts.headers['User-Agent'], 'metabridge-factory/0.2');
    assert.equal(opts.headers['X-Factory-Client'], undefined);
    if (url.endsWith('/whoami')) return new Response(JSON.stringify({ orgId: 'fixture-org' }));
    return new Response(JSON.stringify({ message: 'fixture-private secret body' }), { status: 403 });
  } });
  assert.equal(calls.length, 4);
  const responses = JSON.parse(calls[1].opts.body);
  assert.match(responses.instructions, /helpful assistant/);
  assert.equal(responses.input[0].role, 'developer');
  assert.equal(responses.input[1].role, 'user');
  assert.ok(JSON.parse(calls[2].opts.body).system);
  assert.equal(JSON.parse(calls[3].opts.body).messages[0].role, 'system');
  assert.ok(result.every(r => r.status === 403 && !r.verified));
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
  assert.equal(JSON.stringify(result).includes('fixture-org'), false);
});

test('Factory probe validates identity and credentials before attempting inference', async () => {
  let count = 0;
  const options = { fetch: async () => {
    count++;
    return new Response(JSON.stringify({ orgId: null }));
  } };
  await assert.rejects(probeFactoryGateway('fixture\ninjected', options));
  assert.equal(count, 0);
  await assert.rejects(probeFactoryGateway('fixture', options));
  assert.equal(count, 1);
});

test('Factory CPA template keeps native protocols, prevents cloaking and separates official model IDs', () => {
  const providers = require('../providers/cpa-factory.example.json')['api-keys'];
  assert.equal(providers.codex[0].keys[0]['disable-codex-cloaking'], true);
  assert.equal(providers.claude[0].keys[0].cloak.mode, 'never');
  assert.equal(providers.claude[0].headers.Authorization, 'Bearer REPLACE_WITH_FACTORY_KEY');
  for (const provider of Object.values(providers).flat()) {
    assert.equal(provider.prefix, 'factory');
    assert.equal(provider['request-retry'], 0);
    assert.equal(new URL(provider['base-url']).origin, 'http://127.0.0.1:8319');
    assert.equal(provider.headers['X-Factory-Client'], undefined);
    assert.ok(provider.models.every(m => m['display-name'].startsWith('factory · ')));
  }
});
