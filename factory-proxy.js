'use strict';

// Native HTTP compatibility layer only. CPA owns protocol conversion/model routing.
// No Droid process, session creation, upstream retries, account fallback, or tool execution.
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateFactoryConfig, readBody } = require('./factory-api');
const { transformFactoryInstructions } = require('./factory-instructions');
const { createCPAQuotaReader } = require('./factory-quota-cpa');
const { optimizeAttachments, attachmentPolicy } = require('./factory-attachments');
const ORIGIN = 'https://api.factory.ai';
const ROUTES = {
  '/v1/responses': { protocol: 'responses', path: '/api/llm/o/v1/responses' },
  '/v1/messages': { protocol: 'messages', path: '/api/llm/a/v1/messages' },
  '/v1/chat/completions': { protocol: 'chat', path: '/api/llm/o/v1/chat/completions' },
};

function validateGateway(config) {
  validateFactoryConfig(config);
  const g = config.gateway;
  if (g) attachmentPolicy(g.attachment_optimization);
  if (!g || g.instruction_mode !== 'factory_prefix' ||
      typeof g.client_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(g.client_version) ||
      (g.host !== undefined && !['127.0.0.1', '::1'].includes(g.host)) ||
      (g.port !== undefined && (!Number.isInteger(g.port) || g.port < 1 || g.port > 65535)) ||
      !Array.isArray(g.models) || !g.models.length) {
    throw new Error('invalid Factory proxy configuration');
  }
  const ids = new Set();
  for (const model of g.models) {
    if (!model || typeof model.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(model.id) ||
        ids.has(model.id) || !['responses', 'messages', 'chat'].includes(model.protocol) ||
        typeof model.provider !== 'string' || !/^[a-z][a-z0-9-]*$/.test(model.provider)) {
      throw new Error('invalid Factory proxy model');
    }
    ids.add(model.id);
  }
  return g;
}

async function createFactoryServer(config, key, options = {}) {
  const gateway = validateGateway(config);
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) throw new Error('invalid Factory credential');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const identity = await fetchImpl(`${ORIGIN}/api/cli/whoami`, {
    headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!identity.ok) {
    await identity.body?.cancel().catch(() => {});
    throw new Error('Factory identity unavailable');
  }
  const who = await readBody(identity);
  if (typeof who.orgId !== 'string' || !who.orgId || /[\r\n]/.test(who.orgId)) {
    throw new Error('Factory identity unavailable');
  }
  const models = new Map(gateway.models.map(model => [model.id, model]));
  const readQuota = createCPAQuotaReader(config, key, { fetch: fetchImpl });
  const expectedAuth = Buffer.from(`Bearer ${key}`);
  function sendError(res, status, message) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    } else res.destroy();
  }
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'factory-proxy', models: models.size }));
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expectedAuth.length || !crypto.timingSafeEqual(supplied, expectedAuth)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/quota') {
      try {
        const quota = await readQuota();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(quota));
      } catch {
        sendError(res, 502, 'Factory billing quota unavailable');
      }
      return;
    }
    // CPA's Anthropic executor appends ?beta=true; never use caller query/host upstream.
    const route = ROUTES[req.url.split('?')[0]];
    if (req.method !== 'POST' || !route) {
      sendError(res, 404, 'Unsupported Factory endpoint');
      return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    req.on('aborted', () => abort.abort());
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(600000)]);
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        sendError(res, 400, 'Invalid JSON'); return;
      }
      const model = models.get(body?.model);
      if (!model || model.protocol !== route.protocol) {
        sendError(res, 400, 'Unsupported Factory model/protocol'); return;
      }
      let transformed;
      try { transformed = transformFactoryInstructions(route.protocol, body, gateway.instruction_mode); } catch {
        sendError(res, 400, 'Unsupported instruction content'); return;
      }
      const optimized = await optimizeAttachments(transformed, gateway.attachment_optimization, { signal });
      transformed = optimized.body;
      if (optimized.stats.images || optimized.stats.preservedAttachments) {
        // Counts and byte sizes only: never log attachment content or account identifiers.
        console.log('Factory attachments', JSON.stringify(optimized.stats));
      }
      const upstream = await fetchImpl(`${ORIGIN}${route.path}`, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          'User-Agent': 'metabridge-factory/0.2',
          'X-Factory-Client': 'cli', 'X-Client-Version': gateway.client_version,
          'X-Factory-Org-Id': who.orgId, 'x-api-provider': model.provider,
          'x-session-id': crypto.randomUUID(), 'x-assistant-message-id': crypto.randomUUID(),
          ...(route.protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(transformed),
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
        ...(upstream.headers.get('retry-after') ? { 'Retry-After': upstream.headers.get('retry-after') } : {}),
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal });
      else res.end();
    } catch {
      // No exception bodies, request bodies, account details or credentials in logs/errors.
      sendError(res, 502, 'Factory upstream request failed');
    }
  });
}

module.exports = { createFactoryServer, validateGateway };
