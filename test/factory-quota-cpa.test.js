'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { toCPAQuota } = require('../src/adapters/factory/quota');
const { createCPAQuotaReader } = require('../src/adapters/factory/quota');
const { createFactoryServer } = require('../src/adapters/factory/server');
const { mergeQuotaPlugin } = require('../integrations/cpa/scripts/install-account-quota');

test('Quota installation only adds its plugin and protects the custom management asset', () => {
  const original = { 'api-keys': { codex: [{ name: 'gateway' }] },
    management: { 'secret-key': 'fixture-hash' },
    plugins: { dir: '/fixture/plugins', configs: { existing: { enabled: false } } } };
  const installed = mergeQuotaPlugin(original, '/other/plugins');
  assert.deepEqual(installed['api-keys'], original['api-keys']);
  assert.deepEqual(installed.plugins.configs.existing, original.plugins.configs.existing);
  assert.equal(installed.plugins.dir, '/fixture/plugins');
  assert.equal(installed.management['secret-key'], 'fixture-hash');
  assert.equal(installed.management['disable-auto-update-panel'], true);
  assert.equal(original.plugins.enabled, undefined);
  assert.deepEqual(mergeQuotaPlugin(installed, '/other/plugins'), installed);
});

test('CPA quota preserves unknown windows/resets, zero balance and real exhausted quota', () => {
  const quota = toCPAQuota({
    updatedAt: '2026-10-04T00:00:00.000Z',
    billingLimits: { status: 'available', groups: {
      standard: { fiveHour: { remainingFraction: 0, resetAt: null } },
      core: { weekly: { remainingFraction: 0.75, resetAt: '2026-10-05T00:00:00.000Z' } },
    }, extraUsageBalance: { value: 0, currency: 'USD' }, extraUsageAllowed: false },
  });
  assert.deepEqual(quota.groups[0].buckets, [{ window: '5h', remainingFraction: 0 }]);
  assert.equal(quota.groups[1].buckets[0].resetTime, '2026-10-05T00:00:00.000Z');
  assert.equal(quota.summary[0].value, 0);
  assert.equal(quota.extraUsageAllowed, false);
  assert.equal(quota.subscription, undefined);
  assert.equal(quota.groups[0].buckets.some(b => b.window === 'monthly'), false);
  assert.throws(() => toCPAQuota({ billingLimits: { status: 'unavailable' } }));
});

test('Failed or malformed billing queries do not become zero quota or a cached success', async () => {
  const config = { name: 'factory', base_url: 'https://api.factory.ai', auth: { type: 'keyfile', file: 'fixture' },
    quota: { billingLimits: true, globalLimit: false, userLimits: false, personalUsage: false } };
  let attempts = 0;
  const readQuota = createCPAQuotaReader(config, 'fixture-private', { fetch: async () => {
    attempts++;
    return attempts === 1 ? new Response('private error', { status: 403 })
      : attempts === 2 ? new Response('{"limits":{"standard":{"weekly":{"usedPercent":null}}}}')
        : new Response('{"limits":{"standard":{"weekly":{"usedPercent":100}}}}');
  } });
  await assert.rejects(readQuota(), /unavailable/);
  await assert.rejects(readQuota(), /unavailable/);
  const exhausted = await readQuota();
  assert.equal(exhausted.groups[0].buckets[0].remainingFraction, 0);
  assert.equal(attempts, 3);
});

test('Factory CPA quota endpoint is authenticated, read-only, cached and keeps upstream failure explicit', async t => {
  const config = { name: 'factory', base_url: 'https://api.factory.ai', auth: { type: 'keyfile', file: 'fixture' },
    quota: { billingLimits: true, globalLimit: true, userLimits: true, personalUsage: true },
    gateway: { instruction_mode: 'factory_prefix', client_version: '0.162.1', models: [
      { id: 'gpt-6.1-sol', protocol: 'responses', provider: 'openai' },
    ] } };
  let billingCalls = 0;
  const calls = [];
  const server = await createFactoryServer(config, 'fixture-private', { fetch: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer fixture-private');
    if (url.endsWith('/whoami')) return new Response('{"orgId":"fixture-org"}');
    assert.equal(url, 'https://api.factory.ai/api/billing/limits');
    billingCalls++;
    return new Response(JSON.stringify({ limits: { standard: { fiveHour: { usedPercent: 25 } } } }));
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/quota`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: 'Bearer fixture-private' };
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 404);
  const [first, second] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(billingCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal((await fetch(url, { headers })).headers.get('cache-control'), 'no-store');
});
