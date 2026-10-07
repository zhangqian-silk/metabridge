'use strict';

// Command Code has no Responses endpoint. Keep this adapter isolated from
// native Responses backends: Claude uses Messages, everything else uses Chat.
// Provider model selection and reasoning profiles live in JSON, not this adapter.
const { randomUUID, createHash } = require('node:crypto');
const { commandCodeEffort } = require('./command-reasoning');
const { compileMatcher, providerApiUrl } = require('./provider-config');
const defaults = require('./providers/command-code.example.json');
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function wireToolName(name, namespace) {
  return namespace ? `ns_${createHash('sha256').update(`${namespace}.${name}`).digest('hex').slice(0, 40)}` : name;
}

function toolRegistry(tools = []) {
  const registry = new Map();
  function walk(list, namespace) {
    for (const t of list) {
      if (t.type === 'namespace') {
        walk(t.tools || [], t.name);
        continue;
      }
      if (!['function', 'custom'].includes(t.type)) {
        // Keep native/unknown definitions in order, including unnamed or repeated
        // tool types. The upstream, not this adapter, decides whether to accept.
        registry.set(Symbol(t.type), t);
        continue;
      }
      const wireName = wireToolName(t.name, namespace);
      registry.set(wireName, { ...t, namespace, wireName });
    }
  }
  walk(tools);
  return registry;
}

function parts(content, anthropic = false) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return (content || []).map(p => {
    if (['input_text', 'output_text', 'text'].includes(p.type)) return { type: 'text', text: p.text };
    if (p.type === 'input_image') {
      const url = p.image_url;
      if (!anthropic) return { type: 'image_url', image_url: { url } };
      const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return { type: 'image', source: data
        ? { type: 'base64', media_type: data[1], data: data[2] }
        : { type: 'url', url } };
    }
    throw invalid(`Unsupported Command Code content type: ${p.type}`);
  });
}

function commandRequest(payload, backend = defaults) {
  if (payload.previous_response_id) throw invalid('Command Code does not support previous_response_id; send the complete input history');
  const anthropic = (backend.messagesModels ?? defaults.messagesModels)
    .some(rule => compileMatcher(rule)(payload.model || ''));
  const registry = toolRegistry(payload.tools);
  const nativeName = item => {
    const found = [...registry.values()].find(t => t.name === item.name && t.namespace === item.namespace);
    // Compaction intentionally removes the tool definitions, but retains calls
    // in history. Derive the same wire name even without the current registry.
    return found?.wireName || wireToolName(item.name, item.namespace);
  };
  const messages = [];
  const systems = payload.instructions ? [payload.instructions] : [];
  const append = (role, content, extra = {}) => {
    // Anthropic expects adjacent tool results in a single user message.
    if (anthropic && messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content, ...extra });
  };
  const input = typeof payload.input === 'string' ? [{ role: 'user', content: payload.input }] : (payload.input || []);
  for (const item of input) {
    // Hosted search metadata is not a Chat/Anthropic input type. The search
    // sidecar persists real result text in accompanying assistant messages.
    if (item.type === 'web_search_call') continue;
    if (item.type === 'reasoning') continue; // Provider-private reasoning cannot cross protocols.
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments;
      if (anthropic) {
        append('assistant', [{ type: 'tool_use', id: item.call_id, name: nativeName(item), input: JSON.parse(args) }]);
      } else {
        const call = { id: item.call_id, type: 'function', function: { name: nativeName(item), arguments: args } };
        if (messages.at(-1)?.role === 'assistant') (messages.at(-1).tool_calls ||= []).push(call);
        else append('assistant', null, { tool_calls: [call] });
      }
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const output = typeof item.output === 'string' || Array.isArray(item.output) ? item.output : JSON.stringify(item.output);
      if (anthropic) append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: parts(output, true) }]);
      else append('tool', typeof output === 'string' ? output : parts(output), { tool_call_id: item.call_id });
    } else if (item.role && (!item.type || item.type === 'message')) {
      if (['system', 'developer'].includes(item.role)) {
        systems.push(parts(item.content).map(p => {
          if (p.type !== 'text') throw invalid('System messages must contain text');
          return p.text;
        }).join('\n'));
      } else {
        append(item.role, parts(item.content, anthropic));
      }
    } else {
      throw invalid(`Unsupported Command Code input type: ${item.type}`);
    }
  }
  const tools = [...registry.values()].map(t => {
    if (!['function', 'custom'].includes(t.type)) return t;
    const parameters = t.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string', description: 'The complete raw tool input' } }, required: ['input'], additionalProperties: false }
      : (t.parameters || { type: 'object', properties: {} });
    return anthropic
      ? { name: t.wireName, description: t.description || '', input_schema: parameters }
      : { type: 'function', function: { name: t.wireName, description: t.description || '', parameters } };
  });
  const body = { model: payload.model, messages, stream: payload.stream === true };
  const effort = commandCodeEffort(payload, backend);
  if (effort !== undefined) body.reasoning_effort = effort;
  if (anthropic) {
    if (systems.length) body.system = systems.join('\n\n');
    body.max_tokens = payload.max_output_tokens || 8192;
  } else {
    if (systems.length) messages.unshift({ role: 'system', content: systems.join('\n\n') });
    if (body.stream) body.stream_options = { include_usage: true };
    if (payload.max_output_tokens) body.max_completion_tokens = payload.max_output_tokens;
  }
  if (tools.length) body.tools = tools;
  if (payload.tool_choice) {
    const choice = payload.tool_choice;
    if (typeof choice === 'object') {
      if (['function', 'custom'].includes(choice.type)) {
        const name = nativeName(choice);
        body.tool_choice = anthropic ? { type: 'tool', name } : { type: 'function', function: { name } };
      } else {
        body.tool_choice = choice;
      }
    } else {
      body.tool_choice = anthropic ? { type: choice === 'required' ? 'any' : choice } : choice;
    }
  }
  for (const key of ['temperature', 'top_p']) if (payload[key] !== undefined) body[key] = payload[key];
  return { pathname: anthropic ? '/v1/messages' : '/v1/chat/completions', body, anthropic, registry };
}

// Decode complete SSE frames, including split UTF-8 and CRLF delimiters.
async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) {
        if (buffer.trim()) throw new Error('Unterminated upstream SSE frame');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class ResponseBuilder {
  constructor(payload, registry, emit = () => {}) {
    this.response = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      model: payload.model, status: 'in_progress', output: [], error: null, incomplete_details: null };
    this.registry = registry;
    this.emit = emit;
    this.calls = new Map();
    this.usage = {};
    this.reason = null;
    this.emit('response.created', { response: { ...this.response, output: [] } });
  }
  text(delta) {
    if (!delta) return;
    if (!this.message) {
      this.message = { id: id('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      this.textIndex = this.response.output.length;
      this.response.output.push(this.message);
      this.emit('response.output_item.added', { output_index: this.textIndex, item: { ...this.message, content: [] } });
      this.message.content.push({ type: 'output_text', text: '', annotations: [] });
      this.emit('response.content_part.added', { item_id: this.message.id, output_index: this.textIndex, content_index: 0, part: { ...this.message.content[0] } });
    }
    this.message.content[0].text += delta;
    this.emit('response.output_text.delta', { item_id: this.message.id, output_index: this.textIndex, content_index: 0, delta });
  }
  tool(index, callId, name, args) {
    const call = this.calls.get(index) || { id: callId, name: '', arguments: '' };
    if (callId) call.id = callId;
    if (name) call.name += name;
    if (args) call.arguments += args;
    this.calls.set(index, call);
  }
  finish() {
    if (!this.reason) throw new Error('Upstream response ended without a finish reason');
    const completed = ['stop', 'tool_calls', 'end_turn', 'tool_use', 'stop_sequence'].includes(this.reason);
    if (this.message) {
      this.message.status = completed ? 'completed' : 'incomplete';
      const fields = { item_id: this.message.id, output_index: this.textIndex, content_index: 0 };
      this.emit('response.output_text.done', { ...fields, text: this.message.content[0].text });
      this.emit('response.content_part.done', { ...fields, part: this.message.content[0] });
      this.emit('response.output_item.done', { output_index: this.textIndex, item: this.message });
    }
    for (const call of this.calls.values()) {
      if (!call.id || !call.name) throw new Error('Incomplete upstream tool call');
      const spec = this.registry.get(call.name);
      const custom = spec?.type === 'custom';
      let input;
      if (custom) {
        input = JSON.parse(call.arguments).input;
        if (typeof input !== 'string') throw new Error('Custom tool call is missing string input');
      }
      const item = { id: id(custom ? 'ctc' : 'fc'), type: custom ? 'custom_tool_call' : 'function_call',
        call_id: call.id, name: spec?.name || call.name, status: completed ? 'completed' : 'incomplete' };
      if (spec?.namespace) item.namespace = spec.namespace;
      const field = custom ? 'input' : 'arguments';
      item[field] = custom ? input : call.arguments;
      const output_index = this.response.output.length;
      this.response.output.push(item);
      this.emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', [field]: '' } });
      const event = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
      this.emit(`${event}.delta`, { output_index, item_id: item.id, delta: item[field] });
      this.emit(`${event}.done`, { output_index, item_id: item.id, [field]: item[field] });
      this.emit('response.output_item.done', { output_index, item });
    }
    const input = this.usage.prompt_tokens ?? this.usage.input_tokens ?? 0;
    const output = this.usage.completion_tokens ?? this.usage.output_tokens ?? 0;
    // Anthropic excludes cache reads/writes from input_tokens.
    const cached = this.usage.cache_read_input_tokens || 0;
    const totalInput = input + cached + (this.usage.cache_creation_input_tokens || 0);
    this.response.usage = { input_tokens: totalInput, output_tokens: output, total_tokens: totalInput + output,
      input_tokens_details: { cached_tokens: cached || this.usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: this.usage.completion_tokens_details?.reasoning_tokens || 0 } };
    this.response.status = completed ? 'completed' : 'incomplete';
    if (!completed) this.response.incomplete_details = { reason: ['length', 'max_tokens'].includes(this.reason) ? 'max_output_tokens' : this.reason };
    this.emit(`response.${this.response.status}`, { response: this.response });
    return this.response;
  }
}

async function consume(upstream, native, builder) {
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
    const json = await upstream.json();
    if (json.error) throw new Error(json.error.message || 'Upstream error');
    builder.usage = json.usage || {};
    if (native.anthropic) {
      for (const [index, block] of (json.content || []).entries()) {
        if (block.type === 'text') builder.text(block.text);
        if (block.type === 'tool_use') builder.tool(index, block.id, block.name, JSON.stringify(block.input));
      }
      builder.reason = json.stop_reason;
    } else {
      const choice = json.choices?.[0];
      builder.text(choice?.message?.content);
      for (const [index, call] of (choice?.message?.tool_calls || []).entries()) {
        builder.tool(index, call.id, call.function.name, call.function.arguments);
      }
      builder.reason = choice?.finish_reason;
    }
  } else {
    let stopped = false;
    for await (const event of readEvents(upstream.body)) {
      if (event.error || event.type === 'error') throw new Error(event.error?.message || 'Upstream stream error');
      if (native.anthropic) {
        if (event.type === 'message_start') Object.assign(builder.usage, event.message?.usage);
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'text') builder.text(block.text);
          if (block.type === 'tool_use') builder.tool(event.index, block.id, block.name, Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '');
        }
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') builder.text(event.delta.text);
          if (event.delta.type === 'input_json_delta') builder.tool(event.index, null, null, event.delta.partial_json);
        }
        if (event.type === 'content_block_stop') {
          const call = builder.calls.get(event.index);
          if (call && !call.arguments) call.arguments = '{}';
        }
        if (event.type === 'message_delta') {
          builder.reason = event.delta.stop_reason || builder.reason;
          Object.assign(builder.usage, event.usage);
        }
        if (event.type === 'message_stop') stopped = true;
      } else {
        const choice = event.choices?.[0];
        builder.text(choice?.delta?.content);
        for (const call of choice?.delta?.tool_calls || []) {
          builder.tool(call.index, call.id, call.function?.name, call.function?.arguments);
        }
        if (choice?.finish_reason) builder.reason = choice.finish_reason;
        if (event.usage) Object.assign(builder.usage, event.usage);
      }
    }
    if (native.anthropic && !stopped) throw new Error('Anthropic stream ended without message_stop');
  }
  return builder.finish();
}

async function commandFetch(backend, headers, payload, { signal, fetchImpl = fetch } = {}) {
  const native = commandRequest(payload, backend.reasoningRules === undefined &&
    backend.reasoning === undefined ? { ...defaults, ...backend } : backend);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  let upstream;
  try {
    upstream = await fetchImpl(providerApiUrl(backend, native.pathname), {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json',
      ...(native.anthropic ? { 'anthropic-version': '2023-06-01' } : {}) },
    body: JSON.stringify(native.body), signal: abort.signal,
  });
  } catch (error) {
    cleanup();
    throw error;
  }
  if (!upstream.ok) {
    cleanup();
    return upstream;
  }
  if (!payload.stream) {
    try {
      return Response.json(await consume(upstream, native, new ResponseBuilder(payload, native.registry)));
    } finally {
      cleanup();
    }
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      let sequence = 0;
      const emit = (type, data) => {
        if (!cancelled) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`));
      };
      const builder = new ResponseBuilder(payload, native.registry, emit);
      const heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 10000);
      try {
        await consume(upstream, native, builder);
      } catch (error) {
        emit('response.failed', { response: { ...builder.response, status: 'failed',
          error: { type: 'upstream_error', message: error.message } } });
      } finally {
        clearInterval(heartbeat);
        cleanup();
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; abort.abort(); },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

module.exports = { commandRequest, commandFetch, readEvents };
