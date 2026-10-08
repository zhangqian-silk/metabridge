'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : file.endsWith('.js') ? [file] : [];
  });
}

test('source dependency boundaries keep the core independent and CPA addons outside inference', () => {
  const source = path.join(root, 'src');
  const core = path.join(source, 'core');
  assert.ok(fs.existsSync(core), 'core modules must live under src/core');
  for (const file of javascriptFiles(source)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, dependency] of text.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!dependency.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), dependency);
      assert.ok(target.startsWith(`${source}${path.sep}`), `${file} imports code/templates outside src: ${dependency}`);
      if (file.startsWith(`${core}${path.sep}`)) {
        assert.ok(target.startsWith(`${core}${path.sep}`), `${file} depends on a higher layer: ${dependency}`);
      }
      if (file.includes(`${path.sep}adapters${path.sep}`)) {
        assert.ok(!target.includes(`${path.sep}bridge${path.sep}`), `${file} depends on bridge orchestration`);
      }
    }
  }
});

test('thin entrypoints preserve the catalog API and optional CPA installer API', () => {
  const entry = require('../sync-catalog');
  const catalog = require('../src/catalog/sync');
  assert.equal(entry.mergeCatalog, catalog.mergeCatalog);
  assert.equal(entry.syncCatalog, catalog.syncCatalog);
  const oldInstaller = require('../scripts/install-factory-quota');
  const installer = require('../integrations/cpa/scripts/install-account-quota');
  assert.equal(oldInstaller.mergeQuotaPlugin, installer.mergeQuotaPlugin);
});

test('deployment templates remain separate from private runtime provider paths', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/bridge/config.hybrid.example.json'), 'utf8'));
  assert.deepEqual(config.providerFiles, ['providers/openai-subscription.json', 'providers/cpa.json']);
  const provider = JSON.parse(fs.readFileSync(path.join(root, 'config/providers/cpa.example.json'), 'utf8'));
  assert.equal(provider.auth.file, '../cpa-api-key');
  assert.ok(fs.existsSync(path.join(root, 'config/catalogs/factory-models.catalog.json')));
  assert.ok(fs.existsSync(path.join(root, 'integrations/cpa/account-quota/go.mod')));
  assert.ok(fs.existsSync(path.join(root, 'integrations/cpa/quota-ui/FactoryQuotaSection.tsx')));
});
