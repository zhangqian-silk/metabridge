#!/usr/bin/env node
'use strict';

// Run with NODE_USE_ENV_PROXY=1 if upstream access needs environment proxy settings.
// Stage first; activate only after checking the independent CPA service.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, resolveFile, compileModelFilter, providerApiUrl } = require('../src/core/provider-config');
const { commandCodeReasoning } = require('../src/adapters/command-code/reasoning');
const root = process.env.MB_CONFIG_FILE || path.join(os.homedir(), '.metabridge/config.json');
const cpaDir = process.env.CPA_CONFIG_DIR || path.join(os.homedir(), '.config/cliproxyapi');
const stage = path.join(path.dirname(root), 'config.hybrid.staged.json');
const cpaConfig = path.join(cpaDir, 'config.json');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
};
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
function proxyEnvironment() {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  write(path.join(cpaDir, 'proxy.env'), names
    .filter(name => process.env[name] && !/[\r\n]/.test(process.env[name]))
    .map(name => `${name}=${JSON.stringify(process.env[name])}`).join('\n') + '\n');
}

async function main() {
  if (process.argv.includes('--refresh-proxy-env')) {
    proxyEnvironment();
    console.log('Updated private CPA proxy environment file.');
    return;
  }
  if (process.argv.includes('--activate')) {
    const candidate = readJson(stage);
    if (!candidate.providerFiles?.includes('providers/cpa.json')) throw new Error('invalid staged configuration');
    json(root, candidate);
    console.log('Activated staged metabridge configuration; restart metabridge to apply.');
    return;
  }
  if (fs.existsSync(cpaConfig) || fs.existsSync(stage)) {
    throw new Error('CPA/staged configuration already exists; inspect it before migration');
  }
  for (const name of ['cpa-api-key', 'providers/cpa.json', 'providers/openai-subscription.json']) {
    if (fs.existsSync(path.join(path.dirname(root), name))) {
      throw new Error('destination exists; do not overwrite existing credentials/providers');
    }
  }
  const config = readJson(root);
  if (!Array.isArray(config.providerFiles)) throw new Error('migration requires providerFiles');
  const sources = config.providerFiles.map(file => {
    const filename = resolveFile(file, root);
    return { filename, provider: readJson(filename) };
  });
  const cmd = sources.find(s => s.provider.protocol === 'command-code');
  const gateway = sources.find(s => s.provider.name === 'gateway');
  if (!cmd || !gateway || sources.length !== 2 ||
      cmd.provider.enabled === false || gateway.provider.enabled === false) {
    throw new Error('expected exactly one active Command Code provider and one gateway provider');
  }
  function key(source) {
    const auth = source.provider.auth;
    if (auth?.type === 'static' && auth.key) return auth.key;
    if (auth?.type === 'keyfile') return fs.readFileSync(resolveFile(auth.file, source.filename), 'utf8').trim();
    throw new Error('migration supports file-backed Bearer credentials (static/keyfile)');
  }
  async function models(source) {
    const response = await fetch(providerApiUrl(source.provider, '/v1/models'), {
      headers: { authorization: `Bearer ${key(source)}` }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`upstream model discovery failed (${response.status})`);
    const body = await response.json();
    const allowed = compileModelFilter(source.provider);
    const list = (body.data || body.models || []).filter(m => allowed(m.id || m.slug));
    if (!list.length) throw new Error('empty permitted upstream catalog; leaving live configuration untouched');
    return list.map(m => {
      const id = m.id || m.slug;
      const reasoning = source === cmd ? commandCodeReasoning(id, source.provider) : null;
      return { name: id, alias: id,
        'display-name': `${source === cmd ? 'cmd' : 'gateway'} · ${m.display_name || id}`,
        ...(reasoning ? { thinking: { levels: reasoning.levels } } : {}),
        ...(m.context_window ? { 'max-context-length': m.context_window } : {}) };
    });
  }
  const [cmdModels, gatewayModels] = await Promise.all([models(cmd), models(gateway)]);
  const backup = path.join(path.dirname(root), 'backups', `before-cpa-${Date.now()}`);
  for (const filename of [root, ...sources.map(s => s.filename)]) {
    write(path.join(backup, path.basename(filename)), fs.readFileSync(filename));
  }
  const accessKey = crypto.randomBytes(32).toString('hex');
  const apiRoot = p => (p.base_url || `${p.base.replace(/\/+$/, '')}/v1`).replace(/\/+$/, '');
  // JSON is valid YAML and is accepted by the CPA v8 configuration loader.
  json(cpaConfig, {
    'config-version': 8,
    server: { host: '127.0.0.1', port: 8317 },
    management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
    access: { 'api-keys': [accessKey] },
    routing: { 'force-model-prefix': true },
    oauth: { 'auth-dir': path.join(cpaDir, 'auth') },
    ...(cmdModels.some(m => m.name === 'google/gemini-3.8-flash')
      ? { payload: readJson(path.join(__dirname, '../config/providers/cpa-gemini-payload.example.json')) } : {}),
    'api-keys': {
      'openai-compatibility': [{
        name: 'command-code', prefix: 'cmd', 'base-url': apiRoot(cmd.provider),
        keys: [{ 'api-key': key(cmd) }], models: cmdModels,
      }],
      codex: [{
        name: 'gateway', prefix: 'gateway', 'base-url': apiRoot(gateway.provider),
        keys: [{ 'api-key': key(gateway), 'disable-codex-cloaking': true, websockets: false }],
        models: gatewayModels,
      }],
    },
  });
  write(path.join(path.dirname(root), 'cpa-api-key'), `${accessKey}\n`);
  proxyEnvironment();
  const example = name => readJson(path.join(__dirname, '..', 'config', 'providers', name));
  json(path.join(path.dirname(root), 'providers/cpa.json'), example('cpa.example.json'));
  json(path.join(path.dirname(root), 'providers/openai-subscription.json'),
    example('openai-subscription.hybrid.example.json'));
  json(stage, { ...config, officialModels: { enabled: false },
    providerFiles: ['providers/openai-subscription.json', 'providers/cpa.json'] });
  console.log(JSON.stringify({ staged: stage, cpaConfig, backup,
    cmdModels: cmdModels.length, gatewayModels: gatewayModels.length,
    warning: 'Command Code metabridge webSearch sidecar is not migrated; verify CPA/upstream search separately.' }));
}

main().catch(() => {
  // Never print parser errors, response bodies, or objects containing API credentials.
  console.error('Migration failed; inspect connectivity/configuration. Existing live configuration was not changed.');
  process.exitCode = 1;
});
