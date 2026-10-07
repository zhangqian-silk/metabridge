#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const WINDOW_FIELDS = ['context_window', 'max_context_window'];

function validateCatalog(catalog, label, requireNonempty = false) {
  if (!catalog || !Array.isArray(catalog.models) || (requireNonempty && !catalog.models.length)) {
    throw new Error(`${label}: expected a ${requireNonempty ? 'nonempty ' : ''}models array`);
  }
  const seen = new Set();
  for (const model of catalog.models) {
    if (!model || typeof model.slug !== 'string' || !model.slug.trim() || seen.has(model.slug)) {
      throw new Error(`${label}: invalid or duplicate model slug`);
    }
    if (model.priority !== undefined && !Number.isFinite(model.priority)) {
      throw new Error(`${label}: invalid model priority`);
    }
    seen.add(model.slug);
  }
}

function mergeCatalog(local, upstream, extraPreserveFields = []) {
  validateCatalog(local, 'local');
  validateCatalog(upstream, 'upstream', true);
  if (!Array.isArray(extraPreserveFields) ||
      extraPreserveFields.some(field => typeof field !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field))) {
    throw new Error('Extra preserve fields must be an array of top-level field names');
  }
  const preserved = new Set([...WINDOW_FIELDS, ...extraPreserveFields]);
  const existing = new Map(local.models.map(m => [m.slug, m]));
  const remote = new Map(upstream.models.map(m => [m.slug, m]));
  const added = [];
  const updated = [];
  const removed = local.models.filter(model => !remote.has(model.slug)).map(model => model.slug);
  // Source membership and order are authoritative. Only field exemptions survive.
  const models = upstream.models.map(source => {
    const model = existing.get(source.slug);
    const next = { ...source };
    if (!model) {
      added.push(source.slug);
      return next;
    }
    for (const field of preserved) {
      if (Object.hasOwn(model, field)) {
        Object.defineProperty(next, field, { value: model[field], enumerable: true, writable: true, configurable: true });
      }
    }
    if (!isDeepStrictEqual(next, model)) updated.push(model.slug);
    return next;
  });
  const catalog = { ...local, models };
  return { catalog, added, updated, removed, changed: !isDeepStrictEqual(catalog, local) };
}

async function syncCatalog({ catalogPath, url, fetchImpl = fetch, extraPreserveFields = [] }) {
  // A backend outage produces a partial catalog. Do not mistake that for removal.
  const healthResponse = await fetchImpl(new URL('/healthz', url).href, { signal: AbortSignal.timeout(30000) });
  if (!healthResponse.ok) throw new Error(`metabridge health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (health.service !== 'metabridge' || health.ok !== true || health.degraded) {
    throw new Error('metabridge is degraded or health is invalid; refusing catalog replacement');
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`metabridge returned HTTP ${response.status}`);
  const upstream = await response.json();
  // Read after fetching to avoid overwriting edits made during a slow fetch.
  // Fail closed if the configured local catalog is missing or malformed.
  const original = await fs.readFile(catalogPath, 'utf8');
  const result = mergeCatalog(JSON.parse(original), upstream, extraPreserveFields);
  const report = { added: result.added, updated: result.updated, removed: result.removed,
    changed: result.changed, total: result.catalog.models.length };
  if (!result.changed) return report;

  const stat = await fs.lstat(catalogPath);
  if (!stat.isFile()) throw new Error('Catalog must be a regular file, not a symlink');
  const temporary = `${catalogPath}.sync-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(result.catalog, null, 2) + '\n',
      { flag: 'wx', mode: stat.mode & 0o777 });
    if (await fs.readFile(catalogPath, 'utf8') !== original) {
      throw new Error('Local catalog changed during sync; refusing to overwrite');
    }
    // One rolling backup of the last changed version; no-op runs leave it alone.
    await fs.writeFile(`${catalogPath}.sync-backup`, original, { mode: 0o600 });
    await fs.rename(temporary, catalogPath);
  } finally {
    await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return report;
}

if (require.main === module) {
  const catalogPath = process.argv[2] ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'model-catalogs', 'custom.json');
  const url = process.argv[3] || 'http://127.0.0.1:8318/v1/models';
  const extraPreserveFields = (process.env.MB_CATALOG_EXTRA_PRESERVE_FIELDS || '')
    .split(',').map(field => field.trim()).filter(Boolean);
  syncCatalog({ catalogPath, url, extraPreserveFields }).then(result => {
    console.log(JSON.stringify({ event: 'catalog_sync', ...result }));
  }).catch(error => {
    console.error(`catalog sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { mergeCatalog, syncCatalog };
