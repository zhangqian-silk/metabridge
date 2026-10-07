#!/usr/bin/env node
'use strict';
const os = require('node:os');
const path = require('node:path');
const { loadFactoryConfig } = require('../factory-api');
const { createFactoryServer } = require('../factory-proxy');
async function main() {
  const i = process.argv.indexOf('--config');
  const filename = i === -1 ? path.join(os.homedir(), '.config/cliproxyapi/quota/factory.json') : process.argv[i + 1];
  const { config, key } = loadFactoryConfig(filename);
  const server = await createFactoryServer(config, key);
  server.on('error', () => { console.error('Factory proxy listener unavailable'); process.exitCode = 1; });
  server.listen(config.gateway.port ?? 8319, config.gateway.host ?? '127.0.0.1', () => {
    console.log('Factory proxy ready (loopback, native protocols, no Droid agent)');
  });
  for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
main().catch(() => { console.error('Factory proxy configuration or identity unavailable'); process.exitCode = 1; });
