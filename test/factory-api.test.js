'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { queryFactoryQuota, validateFactoryConfig, analyticsRange, loadFactoryConfig } = require('../factory-api');

const config = () => ({
  name: 'factory',
  base_url: 'https://api.factory.ai',
  auth: { type: 'keyfile', file: './factory-api-key' },
  quota: { globalLimit: true, userLimits: true, personalUsage: true, userEmail: 'member@example.test' },
});
const now = new Date('2026-10-03T01:00:00Z');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('Factory file configuration validates explicit instruction mode while accepting legacy configs', () => {
  assert.equal(validateFactoryConfig(config()).gateway, undefined);
  const c = { ...config(), gateway: { instruction_mode: 'fold_system_into_user' } };
  assert.equal(validateFactoryConfig(c).gateway.instruction_mode, 'fold_system_into_user');
  assert.throws(() => validateFactoryConfig({ ...config(), gateway: { instruction_mode: 'typo' } }));
  assert.throws(() => validateFactoryConfig({ ...config(), gateway: [] }));
});

test('Factory queries official read-only endpoints with the file credential and UTC date range', async () => {
  const calls = [];
  const result = await queryFactoryQuota(config(), 'private-test-key', {
    now,
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer private-test-key');
      if (url.endsWith('/global')) return response({ limit: 1000 });
      if (url.endsWith('/users')) return response({
        globalLimit: 1000,
        userLimits: [{ email: 'member@example.test', limit: 0 }, { email: 'other@example.test', limit: 900 }],
      });
      return response({ data: [{ date: '2026-10-01', fsc: 12 }, { date: '2026-10-02', fsc: 8 }],
        meta: { start_date: '2026-10-01', end_date: '2026-10-02' } });
    },
  });
  assert.equal(calls.length, 3);
  assert.match(calls[2], /queryKey=headline_daily&startDate=2026-10-01&endDate=2026-10-02$/);
  assert.equal(result.globalLimit.limit, 1000);
  assert.equal(result.userLimits.selectedUser.effectiveLimit, 0);
  assert.equal(result.userLimits.selectedUser.source, 'override');
  assert.equal(result.personalUsage.consumed, 20);
  assert.equal(result.personalUsage.unit, 'Factory Standard Credits');
  assert.equal(result.realTimeBalance.status, 'unsupported');
  assert.equal('remaining' in result.personalUsage, false);
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  assert.equal(JSON.stringify(result).includes('other@example.test'), false);
});

test('Factory null limit means no configured policy, not unlimited subscription credits', async () => {
  const c = config();
  c.quota.personalUsage = false;
  const result = await queryFactoryQuota(c, 'fixture', { now, fetch: async url =>
    response(url.endsWith('/global') ? { limit: null } :
      { globalLimit: 700, userLimits: [{ email: c.quota.userEmail, limit: null }] }) });
  assert.equal(result.globalLimit.limit, null);
  assert.equal(result.globalLimit.configured, false);
  assert.equal(result.userLimits.selectedUser.effectiveLimit, 700);
  assert.equal(result.userLimits.selectedUser.source, 'global');
});

test('Factory failures and missing fields are unavailable, never zero; successful sections survive', async () => {
  const result = await queryFactoryQuota(config(), 'private-test-key', { now, fetch: async url => {
    if (url.endsWith('/global')) return response({ limit: 0 });
    if (url.endsWith('/users')) return response({ detail: 'private-test-key upstream error' }, 403);
    return response({ data: [{ date: '2026-10-02' }] });
  } });
  assert.equal(result.status, 'partial');
  assert.equal(result.globalLimit.limit, 0);
  assert.equal(result.userLimits.status, 'unavailable');
  assert.equal(result.userLimits.reason, 'permission_denied');
  assert.equal(result.personalUsage.status, 'unavailable');
  assert.equal('consumed' in result.personalUsage, false);
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
});

test('Factory protects credentials from alternate hosts, URL credentials and injected tokens', async () => {
  for (const base_url of ['https://api.factory.ai.evil.test', 'http://api.factory.ai',
    'https://api.factory.ai/v1', 'https://user@api.factory.ai', 'https://api.factory.ai?x=1']) {
    assert.throws(() => validateFactoryConfig({ ...config(), base_url }));
  }
  let called = false;
  await assert.rejects(queryFactoryQuota(config(), 'fixture\nbad', {
    fetch: async () => { called = true; },
  }));
  assert.equal(called, false);
});

test('Factory uses yesterday UTC, clamps new-month defaults and rejects invalid/out-of-range dates', () => {
  assert.deepEqual(analyticsRange({}, new Date('2026-10-01T01:00:00Z')),
    { startDate: '2026-09-01', endDate: '2026-09-30' });
  for (const usage of [
    { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-10-01', endDate: '2026-10-03' },
    { startDate: '2026-01-13', endDate: '2026-01-14' },
    { startDate: '2026-01-14', endDate: '2026-10-02' },
    { startDate: '2026-10-02', endDate: '2026-10-01' },
  ]) assert.throws(() => analyticsRange(usage, now));
});

test('Factory empty valid analytics is zero, malformed or mismatched ranges are unavailable', async () => {
  const c = config();
  c.quota.globalLimit = c.quota.userLimits = false;
  for (const [payload, status] of [
    [{ data: [] }, 'available'],
    [{ data: [{ date: '2026-10-02', fsc: -1 }] }, 'unavailable'],
    [{ data: [{ date: '2026-10-02', fsc: '15' }] }, 'unavailable'],
    [{ data: [{ date: '2026-09-30', fsc: 15 }] }, 'unavailable'],
    [{ data: [], meta: { start_date: '2026-09-01', end_date: '2026-09-30' } }, 'unavailable'],
  ]) {
    const r = await queryFactoryQuota(c, 'fixture', { now, fetch: async () => response(payload) });
    assert.equal(r.personalUsage.status, status);
    if (status === 'available') assert.equal(r.personalUsage.consumed, 0);
  }
});

test('Factory resolves the current private key from its config file without using an environment credential', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-factory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'factory.json');
  const keyfile = path.join(dir, 'factory-api-key');
  fs.writeFileSync(file, JSON.stringify(config()));
  fs.writeFileSync(keyfile, 'fixture-first\n', { mode: 0o600 });
  assert.equal(loadFactoryConfig(file).key, 'fixture-first');
  fs.writeFileSync(keyfile, 'fixture-rotated\n');
  assert.equal(loadFactoryConfig(file).key, 'fixture-rotated');
  if (process.platform !== 'win32') {
    fs.chmodSync(keyfile, 0o644);
    assert.throws(() => loadFactoryConfig(file));
  }
  fs.writeFileSync(file, '{ "auth": "private-parser-fixture",');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/query-factory-quota.js'), '--config', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, 'unavailable');
  assert.equal((result.stdout + result.stderr).includes('private-parser-fixture'), false);
  assert.equal((result.stdout + result.stderr).includes('fixture-rotated'), false);
});

test('Factory billing windows preserve percentages, null resets and separate dollar overage balance', async () => {
  const c = config();
  c.quota = { globalLimit: false, userLimits: false, personalUsage: false, billingLimits: true };
  const r = await queryFactoryQuota(c, 'fixture', { now, fetch: async url => {
    assert.equal(url, 'https://api.factory.ai/api/billing/limits');
    return response({ usesTokenRateLimitsBilling: true, extraUsageBalanceCents: 1234,
      extraUsageAllowed: false, limits: {
        standard: { fiveHour: { usedPercent: 125, windowEnd: null, secondsRemaining: null },
          weekly: { usedPercent: 0, windowEnd: '2026-10-04T00:00:00Z', secondsRemaining: 3600 } },
        core: { monthly: { usedPercent: 20, windowEnd: null, secondsRemaining: null } },
      } });
  } });
  assert.equal(r.status, 'available');
  assert.equal(r.billingLimits.groups.standard.fiveHour.usedPercent, 125);
  assert.equal(r.billingLimits.groups.standard.fiveHour.remainingFraction, 0);
  assert.equal(r.billingLimits.groups.standard.fiveHour.resetAt, null);
  assert.equal(r.billingLimits.groups.standard.weekly.remainingFraction, 1);
  assert.equal(r.billingLimits.groups.core.monthly.remainingFraction, 0.8);
  assert.equal(r.billingLimits.extraUsageBalance.value, 12.34);
  assert.equal(r.billingLimits.extraUsageBalance.currency, 'USD');
  assert.equal(r.billingLimits.extraUsageAllowed, false);
  assert.equal(r.realTimeBalance.status, 'unsupported');
});

test('Factory billing malformed data or forbidden requests never become empty/zero quota', async () => {
  const c = config();
  c.quota = { globalLimit: false, userLimits: false, personalUsage: false, billingLimits: true };
  for (const fixture of [{ limits: {} }, { limits: { standard: { fiveHour: { usedPercent: '0' } } } },
    { limits: { core: { weekly: { usedPercent: -1 } } } }]) {
    const r = await queryFactoryQuota(c, 'fixture', { now, fetch: async () => response(fixture) });
    assert.equal(r.billingLimits.status, 'unavailable');
  }
  const r = await queryFactoryQuota(c, 'fixture', { now, fetch: async () => response({}, 403) });
  assert.equal(r.billingLimits.reason, 'permission_denied');
  assert.equal('groups' in r.billingLimits, false);
});
