'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeCatalog, syncCatalog } = require('../sync-catalog');
const catalogFetch = source => async url => Response.json(
  new URL(url).pathname === '/healthz' ? { ok: true, service: 'metabridge' } : source);

test('mirror remote membership and order while preserving context windows', () => {
  const local = { custom: true, models: [
    { slug: 'gpt-6-astra', context_window: 950000, max_context_window: 950000, priority: 1, custom: { value: 42 } },
    { slug: 'old-gateway', priority: 50 },
  ] };
  const source = { models: [
    { slug: 'gpt-6-astra', context_window: 272000, priority: 999, display_name: 'Updated GPT-6', supported_reasoning_levels: ['high'] },
    { slug: 'cmd/new', priority: 45 },
  ] };
  const original = structuredClone(local);
  const result = mergeCatalog(local, source);
  assert.deepEqual(result.added, ['cmd/new']);
  assert.deepEqual(result.updated, ['gpt-6-astra']);
  assert.deepEqual(result.removed, ['old-gateway']);
  assert.deepEqual(result.catalog.models.map(m => m.slug), source.models.map(m => m.slug));
  assert.deepEqual(result.catalog.models[0], {
    ...source.models[0], context_window: 950000, max_context_window: 950000,
  });
  assert.equal(result.catalog.custom, true);
  assert.deepEqual(local, original);
  assert.deepEqual(mergeCatalog(result.catalog, source).added, []);
  assert.equal(mergeCatalog(result.catalog, source).changed, false);
});

test('extra exemptions preserve only explicitly configured fields; missing local windows use upstream', () => {
  const local = { models: [{ slug: 'm', priority: 1, visibility: 'hide', custom: { x: 1 } }] };
  const source = { models: [{ slug: 'm', priority: 45, visibility: 'list', context_window: 1000 }] };
  const result = mergeCatalog(local, source, ['priority', 'custom']);
  assert.deepEqual(result.catalog.models[0], {
    ...source.models[0], priority: 1, custom: { x: 1 },
  });
  assert.equal(mergeCatalog(local, source).catalog.models[0].custom, undefined);
  assert.throws(() => mergeCatalog(local, source, ['']), /field/i);
});

test('equal-priority models follow remote order and missing models are removed', () => {
  const local = { models: [
    { slug: 'gateway/stale-1', priority: 50 },
    { slug: 'gateway/a', priority: 50, context_window: 950000 },
    { slug: 'gateway/stale-2', priority: 50 },
    { slug: 'gateway/b', priority: 50 },
    { slug: 'cmd/old', priority: 45 },
    { slug: 'official', priority: 1 },
  ] };
  const remote = { models: [
    { slug: 'official', priority: 1 },
    { slug: 'cmd/new', priority: 45 },
    { slug: 'cmd/old', priority: 45 },
    { slug: 'gateway/b', priority: 50 },
    { slug: 'gateway/new', priority: 50 },
    { slug: 'gateway/a', priority: 50, context_window: 272000 },
  ] };
  const result = mergeCatalog(local, remote);
  assert.deepEqual(result.catalog.models.map(m => m.slug),
    remote.models.map(m => m.slug));
  assert.deepEqual(result.removed, ['gateway/stale-1', 'gateway/stale-2']);
  assert.equal(result.catalog.models.find(m => m.slug === 'gateway/a').context_window, 950000);
  assert.equal(mergeCatalog(result.catalog, remote).changed, false);
});

test('order-only sync writes once even when no models were added or updated', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-order-sync-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'custom.json');
  const local = { models: [{ slug: 'gateway/a', priority: 50 }, { slug: 'gateway/b', priority: 50 }] };
  const original = JSON.stringify(local);
  await fs.writeFile(catalogPath, original);
  const remote = { models: local.models.slice().reverse() };
  const options = { catalogPath, url: 'http://localhost/v1/models', fetchImpl: catalogFetch(remote) };
  const first = await syncCatalog(options);
  assert.deepEqual(first, { added: [], updated: [], removed: [], changed: true, total: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, 'utf8')), remote);
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), original);
  assert.equal((await syncCatalog(options)).changed, false);
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), original);
});

test('reject malformed, duplicate and empty upstream catalogs', () => {
  for (const source of [{}, { models: [] }, { models: [null] },
    { models: [{ slug: 'x' }, { slug: 'x' }] }]) {
    assert.throws(() => mergeCatalog({ models: [] }, source));
  }
});

test('sync preserves GPT-6, backs up before additions, does not write on no-op or fetch failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-sync-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'custom.json');
  const original = JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 950000, priority: 1 }] });
  await fs.writeFile(catalogPath, original, { mode: 0o600 });
  const source = { models: [{ slug: 'gpt-6-astra', context_window: 272000, priority: 1 }, { slug: 'cmd/new', priority: 45 }] };
  const options = { catalogPath, url: 'http://127.0.0.1:8318/v1/models', fetchImpl: catalogFetch(source) };
  const first = await syncCatalog(options);
  assert.deepEqual(first.added, ['cmd/new']);
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), original);
  const after = await fs.readFile(catalogPath, 'utf8');
  assert.equal(JSON.parse(after).models[0].context_window, 950000);
  assert.equal((await fs.stat(catalogPath)).mode & 0o777, 0o600);
  const second = await syncCatalog(options);
  assert.deepEqual(second.added, []);
  assert.equal(await fs.readFile(catalogPath, 'utf8'), after);
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), original);
  source.models[0].display_name = 'Updated name without adding a model';
  const updateOnly = await syncCatalog(options);
  assert.deepEqual(updateOnly.added, []);
  assert.deepEqual(updateOnly.updated, ['gpt-6-astra']);
  const updated = await fs.readFile(catalogPath, 'utf8');
  assert.equal(JSON.parse(updated).models[0].display_name, source.models[0].display_name);
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), after);
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => Response.json({}, { status: 503 }),
    catalogFetch({ models: [] }),
    async () => Response.json({ ok: true, service: 'metabridge', degraded: 'gateway unavailable' }),
  ]) {
    await assert.rejects(syncCatalog({ ...options, fetchImpl }));
    assert.equal(await fs.readFile(catalogPath, 'utf8'), updated);
  }
});

test('removal-only sync keeps a recoverable backup and remains idempotent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-removal-sync-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'custom.json');
  const keep = { slug: 'keep', context_window: 950000 };
  const original = JSON.stringify({ models: [keep, { slug: 'gone' }] });
  await fs.writeFile(catalogPath, original);
  const options = { catalogPath, url: 'http://localhost/v1/models', fetchImpl: catalogFetch({ models: [keep] }) };
  assert.deepEqual(await syncCatalog(options), { added: [], updated: [], removed: ['gone'], changed: true, total: 1 });
  assert.equal(await fs.readFile(catalogPath + '.sync-backup', 'utf8'), original);
  assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, 'utf8')).models, [keep]);
  assert.equal((await syncCatalog(options)).changed, false);
});
