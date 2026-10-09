#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadFactoryConfig } = require('../src/adapters/factory/api');
const { validateGateway } = require('../src/adapters/factory/server');

function mergeFactoryProviders(cpa, factory, key, account = 'factory') {
  if (!/^factory(?:-[a-z0-9]+)*$/.test(account)) throw new Error('invalid Factory account');
  const gateway = validateGateway(factory);
  const base = `http://${gateway.host === '::1' ? '[::1]' : '127.0.0.1'}:${gateway.port ?? 8319}/v1`;
  const groups = { responses: ['codex', 'factory-openai'],
    messages: ['claude', 'factory-anthropic'], chat: ['openai-compatibility', 'factory-core'] };
  const result = structuredClone(cpa);
  result['api-keys'] ??= {};
  for (const [protocol, [group, defaultName]] of Object.entries(groups)) {
    const name = defaultName.replace(/^factory/, account);
    const original = result['api-keys'][group] ?? [];
    const models = gateway.models.filter(model => model.protocol === protocol);
    if (!Array.isArray(original)) throw new Error('invalid CPA provider group');
    const provider = {
      name, prefix: 'factory', 'base-url': protocol === 'messages' ? base.slice(0, -3) : base, 'request-retry': 0,
      headers: protocol === 'messages' ? { Authorization: `Bearer ${key}` } : {},
      keys: [{ 'api-key': key, ...(protocol === 'responses'
        ? { 'disable-codex-cloaking': true, websockets: false }
        : protocol === 'messages' ? { cloak: { mode: 'never' } } : {}) }],
      models: models.map(model => ({ name: model.id, alias: model.id,
        'display-name': `factory · ${model.id}`,
        ...(protocol === 'responses' ? { thinking: { levels: ['low', 'medium', 'high', 'xhigh', 'max'] } } : {}),
      })),
    };
    result['api-keys'][group] = original.filter(item => item.name !== name);
    if (models.length) result['api-keys'][group].push(provider);
  }
  return result;
}

async function main() {
  if (!process.argv.includes('--activate')) throw new Error('requires explicit --activate');
  const directory = path.join(os.homedir(), '.config/cliproxyapi');
  const index = process.argv.indexOf('--account');
  const account = index === -1 ? 'factory' : process.argv[index + 1];
  if (!/^factory(?:-[a-z0-9]+)*$/.test(account ?? '')) throw new Error('invalid Factory account');
  const { config, key } = loadFactoryConfig(path.join(directory, `quota/${account}.json`));
  const gateway = validateGateway(config);
  const host = gateway.host === '::1' ? '[::1]' : '127.0.0.1';
  const health = await fetch(`http://${host}:${gateway.port ?? 8319}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok || !(await health.json()).ok) throw new Error('Factory proxy is not ready');
  const filename = path.join(directory, 'config.json');
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const next = mergeFactoryProviders(current, config, key, account);
  if (JSON.stringify(next) === JSON.stringify(current)) { console.log('Factory CPA configuration unchanged'); return; }
  const backup = `${filename}.factory-backup-${Date.now()}`;
  fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  const temporary = `${filename}.factory-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
  console.log(`Factory CPA configuration saved; original config backed up; models=${gateway.models.length}`);
}
if (require.main === module) main().catch(() => {
  console.error('Factory CPA configuration failed; no credential details are logged');
  process.exitCode = 1;
});
module.exports = { mergeFactoryProviders };
