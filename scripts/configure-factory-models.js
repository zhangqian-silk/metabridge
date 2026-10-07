#!/usr/bin/env node
'use strict';
// Update only the model allowlist, retaining file credentials and quota settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateGateway } = require('../factory-proxy');

function mergeFactoryModels(config, models) {
  const result = structuredClone(config);
  result.gateway.models = structuredClone(models);
  validateGateway(result);
  return result;
}

function main() {
  if (!process.argv.includes('--activate')) throw new Error('explicit --activate required');
  const filename = path.join(os.homedir(), '.config/cliproxyapi/quota/factory.json');
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const models = JSON.parse(fs.readFileSync(path.join(__dirname, '../providers/factory-models.catalog.json'), 'utf8'));
  const next = mergeFactoryModels(current, models);
  if (JSON.stringify(current) === JSON.stringify(next)) {
    console.log('Factory model configuration unchanged'); return;
  }
  const backup = `${filename}.models-backup-${Date.now()}`;
  fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  const temporary = `${filename}.models-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
  console.log(`Configured ${models.length} Factory models; no inference requests made`);
}
if (require.main === module) {
  try { main(); } catch {
    console.error('Factory model configuration failed; no private configuration is logged');
    process.exitCode = 1;
  }
}
module.exports = { mergeFactoryModels };
