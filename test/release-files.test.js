'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forbiddenPath, containsCredential, audit } = require('../scripts/check-release-files');

test('release audit separates templates/catalogs from credentials and artifacts', () => {
  for (const file of ['config/bridge/config.example.json', 'config/bridge/config.hybrid.example.json', '.env.example',
    'config/providers/cpa.example.json', 'config/catalogs/factory-models.catalog.json',
    'src/adapters/command-code/defaults.json',
    'integrations/cpa/account-quota/go.mod', 'scripts/query-factory-quota.js']) {
    assert.equal(forbiddenPath(file), false, file);
  }
  for (const file of ['config.json', 'providers/cpa.json', 'config/providers/cpa.json',
    'config/catalogs/private.json', 'config/secrets.json', 'factory-api-key', 'cpa-api-key',
    '.env', '.env.local', 'base_instructions.txt', 'factory-quota.so',
    'static/management.html.quota-backup-123', 'auth/user.json', 'node_modules/sharp/package.json',
    '.metabridge/docs/deployment.md']) {
    assert.equal(forbiddenPath(file), true, file);
  }
});

test('release audit reports only paths, not credential contents', () => {
  const key = 'fk-' + 'A'.repeat(32);
  assert.equal(containsCredential(key), true);
  assert.equal(containsCredential('REPLACE_WITH_FACTORY_KEY'), false);
  const failures = audit(['providers/factory.example.json'], () => JSON.stringify({ key }));
  assert.equal(failures.length, 1);
  assert.equal(JSON.stringify(failures).includes(key), false);
});
