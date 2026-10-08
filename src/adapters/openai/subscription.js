'use strict';

// Native Codex OAuth passthrough, not Platform API-key authentication.
// Login and refresh remain owned by the Codex client. Never read auth.json here.
const BASE = 'https://chatgpt.com/backend-api/codex';
const HEADERS = new Set([
  'authorization', 'chatgpt-account-id', 'openai-beta', 'originator', 'user-agent',
  'session_id', 'session-id', 'thread-id', 'x-client-request-id',
  'x-codex-beta-features', 'x-codex-installation-id', 'x-codex-parent-thread-id',
  'x-codex-turn-metadata', 'x-codex-turn-state', 'x-codex-window-id',
  'x-oai-attestation', 'x-openai-subagent', 'x-responsesapi-include-timing-metrics',
  'x-codex-responses-lite',
]);

function subscriptionHeaders(incoming = {}) {
  return Object.fromEntries(Object.entries(incoming)
    .filter(([name, value]) => HEADERS.has(name.toLowerCase()) && typeof value === 'string')
    .map(([name, value]) => [name.toLowerCase(), value]));
}

function validateSubscriptionBackend(backend) {
  const url = new URL(backend.base);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (!local && backend.base.replace(/\/+$/, '') !== BASE) ||
      !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('codex-subscription 只允许官方 Codex HTTPS 端点或本地测试端点');
  }
  if (backend.auth?.type !== 'none' || backend.passthroughHeaders || backend.sanitize) {
    throw new Error('codex-subscription 使用受限鉴权透传；auth 必须是 none，不可设置 passthroughHeaders 或 sanitize');
  }
}

async function subscriptionFetch(backend, headers, pathname, payload, { signal, fetchImpl = fetch } = {}) {
  validateSubscriptionBackend(backend);
  if (!['/v1/responses', '/v1/responses/compact'].includes(pathname)) {
    throw Object.assign(new Error('订阅直连只支持 Responses 和原生 compact 端点'), { status: 400 });
  }
  const forwarded = subscriptionHeaders(headers);
  if (!/^Bearer\s+\S+$/i.test(forwarded.authorization || '') ||
      /^Bearer\s+sk-/i.test(forwarded.authorization || '') || !forwarded['chatgpt-account-id']) {
    throw Object.assign(new Error('订阅直连需要 Codex 客户端提供有效的订阅 Bearer token 与 chatgpt-account-id'), {
      status: 401,
    });
  }
  return fetchImpl(`${backend.base.replace(/\/+$/, '')}${pathname.slice(3)}`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json',
      accept: payload.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(payload),
    signal,
    // Do not let redirects carry subscription credentials to another destination.
    redirect: 'error',
  });
}

module.exports = { BASE, subscriptionHeaders, validateSubscriptionBackend, subscriptionFetch };
