'use strict';

// Factory's documented Public API is a management API, not a model inference provider.
// Keep this read-only integration separate from the Codex/CPA request path.
const fs = require('node:fs');
const { readJson, resolveFile } = require('../../core/provider-config');
const { validateInstructionMode } = require('./instructions');
const ORIGIN = 'https://api.factory.ai';
const DAY = 86400000;
const amount = value => Number.isFinite(value) && value >= 0;
const limit = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const unavailable = (reason, httpStatus) => ({
  status: 'unavailable', reason, ...(httpStatus ? { httpStatus } : {}),
});

function validateFactoryConfig(config) {
  let url;
  try { url = new URL(config.base_url); } catch { throw new Error('invalid Factory configuration'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash ||
      !['', '/'].includes(url.pathname) || config.name !== 'factory' ||
      config.auth?.type !== 'keyfile' || typeof config.auth.file !== 'string' || !config.auth.file.trim()) {
    throw new Error('Factory requires its canonical HTTPS origin and file-backed credential');
  }
  const quota = config.quota;
  if (!quota || typeof quota !== 'object' || Array.isArray(quota) ||
      ['globalLimit', 'userLimits', 'personalUsage'].some(k => typeof quota[k] !== 'boolean') ||
      (quota.billingLimits !== undefined && typeof quota.billingLimits !== 'boolean') ||
      !['globalLimit', 'userLimits', 'personalUsage', 'billingLimits'].some(k => quota[k]) ||
      (quota.userEmail !== undefined && (typeof quota.userEmail !== 'string' || !quota.userEmail.trim())) ||
      (quota.usage !== undefined && (!quota.usage || typeof quota.usage !== 'object' || Array.isArray(quota.usage)))) {
    throw new Error('invalid Factory quota configuration');
  }
  if (config.gateway !== undefined) {
    if (!config.gateway || typeof config.gateway !== 'object' || Array.isArray(config.gateway)) {
      throw new Error('invalid Factory gateway configuration');
    }
    validateInstructionMode(config.gateway.instruction_mode);
  }
  return config;
}

function normalizeBillingLimits(data) {
  const groups = {};
  for (const tier of ['standard', 'core']) {
    const group = {};
    for (const window of ['fiveHour', 'weekly', 'monthly']) {
      const row = data?.limits?.[tier]?.[window];
      if (row === undefined) continue;
      if (!amount(row?.usedPercent)) throw new Error('invalid billing utilization');
      let resetAt = null;
      if (row.windowEnd !== null && row.windowEnd !== undefined) {
        // Do not guess whether undocumented numeric timestamps are seconds or milliseconds.
        if (typeof row.windowEnd !== 'string' || !Number.isFinite(Date.parse(row.windowEnd))) {
          throw new Error('invalid billing reset');
        }
        resetAt = new Date(row.windowEnd).toISOString();
      }
      if (row.secondsRemaining !== null && row.secondsRemaining !== undefined && !amount(row.secondsRemaining)) {
        throw new Error('invalid reset interval');
      }
      group[window] = { usedPercent: row.usedPercent,
        remainingFraction: Math.max(0, 1 - row.usedPercent / 100), resetAt,
        secondsRemaining: row.secondsRemaining ?? null };
    }
    if (Object.keys(group).length) groups[tier] = group;
  }
  if (!Object.keys(groups).length) throw new Error('billing quota missing');
  return {
    source: 'factory_internal_billing_api', groups,
    ...(typeof data.usesTokenRateLimitsBilling === 'boolean'
      ? { usesTokenRateLimitsBilling: data.usesTokenRateLimitsBilling } : {}),
    ...(typeof data.extraUsageAllowed === 'boolean' ? { extraUsageAllowed: data.extraUsageAllowed } : {}),
    ...(Number.isSafeInteger(data.extraUsageBalanceCents)
      ? { extraUsageBalance: { value: data.extraUsageBalanceCents / 100, currency: 'USD',
        description: 'Extra usage balance only, not subscription credits' } } : {}),
  };
}

function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Factory analytics requires YYYY-MM-DD dates');
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error('invalid Factory analytics date');
  }
  return ms;
}

function analyticsRange(usage = {}, now = new Date()) {
  const today = dateMs(now.toISOString().slice(0, 10));
  const endDate = usage.endDate ?? new Date(today - DAY).toISOString().slice(0, 10);
  const startDate = usage.startDate ?? `${endDate.slice(0, 7)}-01`;
  const start = dateMs(startDate);
  const end = dateMs(endDate);
  if (start < dateMs('2026-01-14') || end >= today || end < start || (end - start) / DAY + 1 > 90) {
    throw new Error('Factory analytics range must be historical, through yesterday UTC, and at most 90 days');
  }
  return { startDate, endDate };
}

async function readBody(response) {
  // Error bodies are never parsed or exposed. Bound successful responses too.
  if (!response.body) throw new Error('empty body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error('response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function queryFactoryQuota(config, key, options = {}) {
  validateFactoryConfig(config);
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
    throw new Error('Factory API credential missing or invalid');
  }
  const now = options.now ?? new Date();
  const q = config.quota;
  const range = q.personalUsage ? analyticsRange(q.usage, now) : null;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  async function get(path, normalize) {
    try {
      const response = await fetchImpl(`${ORIGIN}${path}`, {
        method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const reason = response.status === 401 ? 'invalid_credential'
          : response.status === 403 ? 'permission_denied'
            : response.status === 429 ? 'rate_limited' : 'upstream_error';
        return unavailable(reason, response.status);
      }
      return { status: 'available', ...normalize(await readBody(response)) };
    } catch {
      // Never propagate upstream bodies, exception text, URLs, or credential values.
      return unavailable('request_or_response_failed');
    }
  }
  const globalLimit = q.globalLimit ? await get('/api/v0/organization/usage/limits/global', data => {
    if (!limit(data?.limit)) throw new Error('invalid limit');
    return { unit: 'Factory Standard Credits', configured: data.limit !== null, limit: data.limit };
  }) : { status: 'disabled' };
  const userLimits = q.userLimits ? await get('/api/v0/organization/usage/limits/users', data => {
    if (!limit(data?.globalLimit) || !Array.isArray(data?.userLimits) ||
        data.userLimits.some(row => typeof row?.email !== 'string' || !row.email || !limit(row.limit))) {
      throw new Error('invalid user limits');
    }
    const matches = q.userEmail ? data.userLimits.filter(row =>
      row.email.toLowerCase() === q.userEmail.trim().toLowerCase()) : [];
    if (matches.length > 1) throw new Error('ambiguous user');
    const override = matches[0]?.limit;
    return {
      unit: 'Factory Standard Credits', globalLimit: data.globalLimit, overrideCount: data.userLimits.length,
      // Do not expose unrelated members or assume the selector identifies this key's owner.
      ...(q.userEmail ? { selectedUser: {
        email: q.userEmail.trim(),
        effectiveLimit: override ?? data.globalLimit,
        source: override !== null && override !== undefined ? 'override' : 'global',
      } } : {}),
    };
  }) : { status: 'disabled' };
  const params = range ? new URLSearchParams({ queryKey: 'headline_daily', ...range }) : null;
  const personalUsage = q.personalUsage ? await get(`/api/v1/analytics/cost/me/query?${params}`, data => {
    if (!Array.isArray(data?.data) ||
        (data.meta?.start_date !== undefined && data.meta.start_date !== range.startDate) ||
        (data.meta?.end_date !== undefined && data.meta.end_date !== range.endDate)) {
      throw new Error('invalid analytics envelope');
    }
    const seen = new Set();
    let consumed = 0;
    for (const row of data.data) {
      dateMs(row?.date);
      if (row.date < range.startDate || row.date > range.endDate || seen.has(row.date) || !amount(row.fsc)) {
        throw new Error('invalid analytics row');
      }
      seen.add(row.date);
      consumed += row.fsc;
      if (!amount(consumed)) throw new Error('invalid sum');
    }
    return { unit: 'Factory Standard Credits', consumed, ...range,
      scope: 'authenticated_user', freshness: 'through_yesterday_UTC' };
  }) : { status: 'disabled' };
  const billingLimits = q.billingLimits
    ? await get('/api/billing/limits', normalizeBillingLimits) : { status: 'disabled' };
  const sections = [globalLimit, userLimits, personalUsage, billingLimits].filter(s => s.status !== 'disabled');
  const available = sections.filter(s => s.status === 'available').length;
  return {
    provider: 'factory', updatedAt: now.toISOString(),
    status: available === sections.length ? 'available' : available ? 'partial' : 'unavailable',
    globalLimit, userLimits, personalUsage, billingLimits,
    // Public docs do not establish real-time balance, reset windows or an inference RPM/TPM quota API.
    realTimeBalance: { status: 'unsupported', reason: 'not_in_documented_public_api' },
    rateLimit: { status: 'unsupported', reason: 'plan_specific_limits_not_queryable_in_public_docs' },
  };
}

function loadFactoryConfig(filename) {
  const config = validateFactoryConfig(readJson(filename));
  const keyPath = resolveFile(config.auth.file, filename);
  const stat = fs.statSync(keyPath);
  if (!stat.isFile() || stat.size > 16384 ||
      (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('Factory key file must be private (0600)');
  }
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('Factory API credential missing or invalid');
  return { config, key };
}

module.exports = { validateFactoryConfig, analyticsRange, queryFactoryQuota, loadFactoryConfig, readBody };
