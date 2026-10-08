#!/usr/bin/env node
'use strict';

// Explicit personal-config migration. Never print credentials or touch services.
// Generated JSON is written atomically with restrictive permissions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { readJson, loadProviders } = require('../src/core/provider-config');

function writePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main() {
  const configFile = path.resolve(process.argv[2] || process.env.MB_CONFIG_FILE ||
    path.join(os.homedir(), '.metabridge', 'config.json'));
  const original = fs.readFileSync(configFile, 'utf8');
  const config = readJson(configFile);
  const providers = loadProviders(config, configFile);
  const backendName = process.argv[3] || 'gateway';
  const matches = providers.filter(provider => provider.name === backendName);
  if (matches.length !== 1) throw new Error('需要配置中恰好存在一个指定名称的网关后端');
  const target = matches[0];
  if (typeof target.auth?.key !== 'string' || !target.auth.key.trim()) {
    throw new Error('现有 Gateway 配置没有可迁移的 auth.key');
  }
  const providerDir = path.join(path.dirname(configFile), 'providers');
  const edits = providers.map(provider => {
    if (!/^[A-Za-z0-9_-]+$/.test(provider.name)) throw new Error('provider name 不适合直接作为配置文件名');
    const destination = provider._sourceFile || path.join(providerDir, `${provider.name}.json`);
    const document = provider._sourceFile ? readJson(destination) : { ...provider };
    if (provider === target) {
      delete document.base;
      document.base_url = target.base_url ||
        `${target.base.replace(/\/+$/, '')}/v1`;
      document.wire_api = 'responses';
      document.via = 'direct';
      document.requestMode = 'passthrough';
      document.compaction ??= { mode: 'passthrough' };
      document.auth = { type: 'static', key: target.auth.key };
      document.displayPrefix ??= 'gateway';
      document.priority ??= 50;
      document.enabled = true;
      document.passthroughHeaders = false;
      delete document.sanitize;
      // Preserve existing prefix/catch-all topology and official model routing.
    } else if (document.auth?.file && !path.isAbsolute(document.auth.file) && !document.auth.file.startsWith('~/')) {
      // Legacy inline keyfiles were relative to process cwd, not the new file.
      if (!provider._sourceFile) {
        document.auth = { ...document.auth, file: path.resolve(document.auth.file) };
      }
    }
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (!provider._sourceFile && fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') !== text) {
      throw new Error(`目标 provider 文件已存在且内容不同，未覆盖：${destination}`);
    }
    return { destination, text };
  });
  const backupDir = path.join(path.dirname(configFile), `backup-${randomUUID()}`);
  fs.mkdirSync(backupDir, { mode: 0o700 });
  writePrivate(path.join(backupDir, 'config.json'), original);
  for (const [index, edit] of edits.entries()) {
    if (fs.existsSync(edit.destination)) {
      writePrivate(path.join(backupDir, `provider-${index}.json`), fs.readFileSync(edit.destination));
    }
  }
  fs.mkdirSync(providerDir, { recursive: true, mode: 0o700 });
  if (fs.readFileSync(configFile, 'utf8') !== original) throw new Error('配置已被其他进程修改，未迁移');
  for (const edit of edits) writePrivate(edit.destination, edit.text);
  delete config.backends;
  config.providerFiles = edits.map(edit => path.relative(path.dirname(configFile), edit.destination));
  writePrivate(configFile, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({ configFile, backupDir,
    providerFiles: edits.map(edit => edit.destination), credentialSource: 'existing configuration',
    gatewayAuth: 'Bearer', serviceRestarted: false }));
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
