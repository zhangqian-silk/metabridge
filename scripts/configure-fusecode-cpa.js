#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readClaudeSettings(settings) {
  const env = settings?.env;
  const url = new URL(env?.ANTHROPIC_BASE_URL);
  if (url.protocol !== 'https:' || !['www.fusecode.ai', 'www.fusecode.cc'].includes(url.hostname) ||
      url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Unsupported FuseCode origin');
  }
  const key = env?.ANTHROPIC_AUTH_TOKEN;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new Error('Missing file credential');
  return { base: url.origin, key };
}

function mergeFusecodeProvider(cpa, credentials, models) {
  if (!Array.isArray(models) || !models.length || models.length > 200 ||
      models.some(m => typeof m?.id !== 'string' || !/^claude-[a-z0-9-]+$/.test(m.id)) ||
      new Set(models.map(m => m.id)).size !== models.length) throw new Error('Invalid Claude catalog');
  const result = structuredClone(cpa);
  result['api-keys'] ??= {};
  const group = result['api-keys'].claude ?? [];
  if (!Array.isArray(group)) throw new Error('Invalid Claude provider group');
  if (group.some(p => p.prefix === 'fusecode' && p.name !== 'fusecode')) {
    throw new Error('FuseCode prefix already owned by another provider');
  }
  result['api-keys'].claude = [...group.filter(p => p.name !== 'fusecode'), {
    name: 'fusecode', prefix: 'fusecode', 'base-url': credentials.base, 'request-retry': 0,
    keys: [{ 'api-key': credentials.key, cloak: { mode: 'never' } }],
    models: models.map(m => ({ name: m.id, alias: m.id, 'display-name': `fusecode · ${m.id}` })),
  }];
  return result;
}

async function main() {
  if (!process.argv.includes('--activate')) throw new Error('Requires explicit --activate');
  const credentials = readClaudeSettings(JSON.parse(fs.readFileSync(
    path.join(os.homedir(), '.claude/settings.json'), 'utf8')));
  const response = await fetch(`${credentials.base}/v1/models`, {
    headers: { Authorization: `Bearer ${credentials.key}` },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Oversized catalog');
  const models = JSON.parse(text).data;
  const filename = path.join(os.homedir(), '.config/cliproxyapi/config.json');
  const previousText = fs.readFileSync(filename, 'utf8');
  const current = JSON.parse(previousText);
  const next = mergeFusecodeProvider(current, credentials, models);
  if (JSON.stringify(next) === JSON.stringify(current)) {
    console.log(`FuseCode configuration unchanged; models=${models.length}`);
    return;
  }
  // Refuse to overwrite a configuration changed during discovery/validation.
  if (fs.readFileSync(filename, 'utf8') !== previousText) throw new Error('CPA configuration changed');
  const backup = `${filename}.fusecode-backup-${Date.now()}`;
  fs.writeFileSync(backup, previousText, { flag: 'wx', mode: 0o600 });
  const temporary = `${filename}.fusecode-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
  console.log(`FuseCode CPA configuration saved; private backup retained; models=${models.length}`);
}

if (require.main === module) main().catch(() => {
  console.error('FuseCode configuration failed; credential details are not logged');
  process.exitCode = 1;
});
module.exports = { readClaudeSettings, mergeFusecodeProvider };
