#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { loadFactoryConfig, queryFactoryQuota } = require('../src/adapters/factory/api');

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) {
    console.error('Usage: node scripts/query-factory-quota.js [--config /path/to/factory.json]');
    process.exitCode = 2;
    return;
  }
  const filename = args[1] || path.join(os.homedir(), '.config/cliproxyapi/quota/factory.json');
  let input;
  try {
    input = loadFactoryConfig(filename);
  } catch {
    console.log(JSON.stringify({ provider: 'factory', status: 'unavailable',
      reason: 'configuration_or_private_key_file_unavailable' }, null, 2));
    process.exitCode = 2;
    return;
  }
  const result = await queryFactoryQuota(input.config, input.key);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'available') process.exitCode = 1;
}

main().catch(() => {
  console.log(JSON.stringify({ provider: 'factory', status: 'unavailable', reason: 'invalid_query_configuration' }));
  process.exitCode = 2;
});
