'use strict';

// Explicit, bounded inference verification only. Instruction folding is opt-in.
// Never impersonate the Droid client, retry a forbidden call, or launch an agent.
const crypto = require('node:crypto');
const { readBody } = require('./factory-api');
const { validateInstructionMode, transformFactoryInstructions } = require('./factory-instructions');
const ORIGIN = 'https://api.factory.ai';
const CASES = [
  { protocol: 'responses', path: '/api/llm/o/v1/responses', provider: 'openai',
    body: { model: 'gpt-6.1-sol', instructions: 'You are a helpful assistant. Follow the developer instructions precisely.',
      input: [{ role: 'developer', content: 'Reply with exactly OK.' }, { role: 'user', content: 'Hello.' }],
      max_output_tokens: 64, stream: false, store: false } },
  { protocol: 'messages', path: '/api/llm/a/v1/messages', provider: 'anthropic',
    body: { model: 'claude-sonnet-5-5', system: 'You are a helpful assistant. Follow the user instructions precisely.',
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 64, stream: false } },
  { protocol: 'chat', path: '/api/llm/o/v1/chat/completions', provider: 'fireworks',
    body: { model: 'glm-5.3', messages: [
      { role: 'system', content: 'You are a helpful assistant. Follow the user instructions precisely.' },
      { role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 64, stream: false } },
];

async function probeFactoryGateway(key, options = {}) {
  const instructionMode = validateInstructionMode(options.instructionMode);
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
    throw new Error('invalid credential');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json',
    'User-Agent': 'metabridge-factory/0.2',
    ...(options.clientVersion ? { 'X-Factory-Client': 'cli', 'X-Client-Version': options.clientVersion } : {}) };
  if (options.clientVersion && !/^\d+\.\d+\.\d+$/.test(options.clientVersion)) {
    throw new Error('invalid Factory client version');
  }
  const identity = await fetchImpl(`${ORIGIN}/api/cli/whoami`, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!identity.ok) {
    await identity.body?.cancel().catch(() => {});
    throw new Error('identity unavailable');
  }
  const who = await readBody(identity);
  if (typeof who.orgId !== 'string' || !who.orgId.trim() || /[\r\n]/.test(who.orgId)) {
    throw new Error('identity unavailable');
  }
  const results = [];
  for (const item of CASES) {
    try {
      const response = await fetchImpl(`${ORIGIN}${item.path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...headers, 'Content-Type': 'application/json',
          'X-Factory-Org-Id': who.orgId, 'x-api-provider': item.provider,
          'x-session-id': crypto.randomUUID(), 'x-assistant-message-id': crypto.randomUUID(),
          ...(item.protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}) },
        body: JSON.stringify(transformFactoryInstructions(item.protocol, item.body, instructionMode)),
      });
      // A 200 alone is not sufficient evidence of model output.
      let text = '';
      if (response.ok) {
        const body = await readBody(response);
        text = item.protocol === 'responses'
          ? (body.output || []).flatMap(x => x.content || []).map(x => x.text || '').join('')
          : item.protocol === 'messages'
            ? (body.content || []).map(x => x.text || '').join('')
            : body.choices?.[0]?.message?.content || '';
      } else {
        await response.body?.cancel().catch(() => {});
      }
      results.push({ protocol: item.protocol, model: item.body.model, status: response.status,
        verified: response.ok && typeof text === 'string' && text.trim() === 'OK',
        // This probe does not establish streaming, tools, or full Codex compatibility.
        compatibility: 'text_probe_only' });
    } catch {
      results.push({ protocol: item.protocol, model: item.body.model, status: 'unavailable', verified: false });
    }
  }
  return results;
}

module.exports = { probeFactoryGateway, transformFactoryInstructions };
