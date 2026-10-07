'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('personal gateway migration preserves topology and unrelated provider settings without printing keys', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-gateway-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = 'test-secret-not-for-logs';
  const command = { name: 'command-code', base: 'https://example.test/provider', prefix: 'cmd/',
    auth: { type: 'keyfile', file: '/fixture/key' }, modelAllowlist: ['allowed-model'],
    webSearch: { backend: 'gateway', model: 'helper' } };
  const original = { port: 8318, officialModels: { enabled: true }, backends: [
    command, { name: 'gateway', base: 'https://custom.example.test', prefix: '',
      auth: { type: 'gateway', key }, passthroughHeaders: true, sanitize: 'gateway' },
  ] };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(original));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/configure-gateway.js'), configFile],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(key), false);
  const receipt = JSON.parse(result.stdout);
  const root = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(root.providerFiles, ['providers/command-code.json', 'providers/gateway.json']);
  assert.equal(root.backends, undefined);
  assert.deepEqual(root.officialModels, original.officialModels);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, root.providerFiles[0]), 'utf8')), command);
  const gateway = JSON.parse(fs.readFileSync(path.join(dir, root.providerFiles[1]), 'utf8'));
  assert.deepEqual(gateway.auth, { type: 'static', key });
  assert.equal(gateway.prefix, '');
  assert.equal(gateway.base_url, 'https://custom.example.test/v1');
  assert.equal(gateway.via, 'direct');
  assert.equal(gateway.requestMode, 'passthrough');
  assert.deepEqual(gateway.compaction, { mode: 'passthrough' });
  assert.equal(gateway.passthroughHeaders, false);
  assert.equal(gateway.sanitize, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(receipt.backupDir, 'config.json'), 'utf8')), original);
  for (const file of [configFile, ...receipt.providerFiles, path.join(receipt.backupDir, 'config.json')]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
