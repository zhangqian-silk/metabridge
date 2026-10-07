'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SERVER = path.join(__dirname, '..', 'server.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function jsonResponse(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function modelsResponse(id) {
  return {
    object: 'list',
    data: [{ id, object: 'model', owned_by: 'test', context_window: 1_000_000 }],
  };
}

async function reservePort() {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

/**
 * 每个用例都有独立的 CODEX_HOME，避免读到开发机上真实的 ~/.codex/config.toml
 * （里面很可能有真 gateway key，会让"没有凭据"的用例失真）。
 */
function makeWorkspace(t, { codexConfigToml } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-gateway-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  if (codexConfigToml) {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), codexConfigToml);
  }
  return { dir, codexHome };
}

function startBridge(t, { dir, codexHome, config, env = {} }) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MB_CONFIG_FILE: configPath,
      MB_LOG_LEVEL: 'info',
      CODEX_HOME: codexHome,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  return { child, output: () => output };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

function runImport(t, { dir, codexHome, config, args = [], env = {} }) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const child = spawn(process.execPath, [SERVER, '--import-gateway-key', ...args], {
    env: { ...process.env, MB_CONFIG_FILE: configPath, CODEX_HOME: codexHome, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  return waitForExit(child).then(code => ({
    code,
    output,
    config: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  }));
}

async function waitUntilReady(port, child) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`metabridge exited before becoming ready: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw lastError || new Error('metabridge did not become ready');
}

function prefixedBackend(port) {
  return {
    name: 'prefixed-test',
    base: `http://127.0.0.1:${port}`,
    prefix: 'ThirdParty/',
    auth: { type: 'none' },
    priority: 100,
    reasoning: 'full',
  };
}

test('legacy official catalog without a usable catch-all fails fast', async t => {
  const { dir, codexHome } = makeWorkspace(t);
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    config: {
      host: '127.0.0.1',
      port: await reservePort(),
      officialModels: { enabled: true },
      backends: [prefixedBackend(1)],
    },
  });

  assert.equal(await waitForExit(child), 1);
  assert.match(output(), /officialModels\.enabled=true/);
  assert.match(output(), /没有可用的 catch-all 后端/);
  assert.match(output(), /官方模型需要订阅直连或兼容网关路由/);
});

test('unfilled placeholder gateway key is treated as missing', async t => {
  const { dir, codexHome } = makeWorkspace(t);
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    config: {
      host: '127.0.0.1',
      port: await reservePort(),
      officialModels: { enabled: true },
      backends: [
        prefixedBackend(1),
        {
          name: 'gateway-test',
          base: 'http://127.0.0.1:1',
          prefix: '',
          auth: { type: 'gateway', key: 'plat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
          priority: 50,
        },
      ],
    },
  });

  assert.equal(await waitForExit(child), 1);
  assert.match(output(), /占位符/);
  assert.match(output(), /gateway 后端 "gateway-test" 因缺少 x-api-key 已被禁用/);
});

test('Prefixed-only setup starts and says compaction needs no gateway', async t => {
  const backend = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return jsonResponse(res, modelsResponse('gpt-test'));
    }
    jsonResponse(res, { error: 'not found' }, 404);
  });
  const backendPort = await listen(backend);
  t.after(() => close(backend));

  const bridgePort = await reservePort();
  const { dir, codexHome } = makeWorkspace(t);
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    config: {
      host: '127.0.0.1',
      port: bridgePort,
      catalogTtlMs: 60_000,
      officialModels: { enabled: false },
      backends: [prefixedBackend(backendPort)],
    },
  });

  await waitUntilReady(bridgePort, child);
  assert.match(output(), /没有 catch-all 后端/);
  assert.match(output(), /所有模型都必须带前缀路由/);
  assert.match(output(), /本地合成 compaction，不需要 gateway 兜底/);
});

async function assertGatewayKeyForwarded(t, {
  authKey = '',
  codexConfigToml,
  env = {},
  expectedKey,
  expectedSource,
}) {
  const received = [];
  const gateway = http.createServer((req, res) => {
    received.push(req.headers['x-api-key']);
    if (req.method === 'GET' && req.url === '/v1/models') {
      return jsonResponse(res, modelsResponse('gateway-model'));
    }
    jsonResponse(res, { error: 'not found' }, 404);
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const bridgePort = await reservePort();
  const { dir, codexHome } = makeWorkspace(t, { codexConfigToml });
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    env,
    config: {
      host: '127.0.0.1',
      port: bridgePort,
      catalogTtlMs: 60_000,
      officialModels: { enabled: false },
      backends: [{
        name: 'gateway-test',
        base: `http://127.0.0.1:${gatewayPort}`,
        prefix: '',
        auth: { type: 'gateway', key: authKey },
        priority: 50,
      }],
    },
  });

  await waitUntilReady(bridgePort, child);
  assert.ok(received.length > 0, 'gateway 后端应当被目录拉取访问到');
  assert.equal(received[0], expectedKey);
  // 日志只暴露 key 来源，不能出现 key 本身
  assert.match(output(), expectedSource);
  assert.ok(!output().includes(expectedKey), '启动日志不应打印 gateway key');
}

test('a fresh setup with no existing gateway credential uses the key typed into config.json', async t => {
  // 之前没用过 gateway 的用户：Codex 配置里没有任何凭据，key 由用户提供后写进 auth.key
  await assertGatewayKeyForwarded(t, {
    authKey: 'plat_typed_by_user',
    expectedKey: 'plat_typed_by_user',
    expectedSource: /key:config\.json/,
  });
});

test('config.json wins and the Codex config is ignored at runtime', async t => {
  await assertGatewayKeyForwarded(t, {
    authKey: 'plat_from_metabridge_config',
    codexConfigToml: [
      '[model_providers.byteseed]',
      'http_headers = { "x-api-key" = "plat_from_codex_config" }',
      '',
    ].join('\n'),
    expectedKey: 'plat_from_metabridge_config',
    expectedSource: /key:config\.json/,
  });
});

test('a credential that only exists in the Codex config does not silently enable gateway', async t => {
  // config.toml 是导入来源，不是运行期兜底：没导入过就当作没凭据
  const backend = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return jsonResponse(res, modelsResponse('gpt-test'));
    }
    jsonResponse(res, { error: 'not found' }, 404);
  });
  const backendPort = await listen(backend);
  t.after(() => close(backend));

  const bridgePort = await reservePort();
  const { dir, codexHome } = makeWorkspace(t, {
    codexConfigToml: [
      '[model_providers.byteseed]',
      'http_headers = { "x-api-key" = "plat_present_but_not_imported" }',
      '',
    ].join('\n'),
  });
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    config: {
      host: '127.0.0.1',
      port: bridgePort,
      catalogTtlMs: 60_000,
      officialModels: { enabled: false },
      backends: [
        prefixedBackend(backendPort),
        {
          name: 'gateway-test',
          base: 'http://127.0.0.1:1',
          prefix: '',
          auth: { type: 'gateway', key: '' },
          priority: 50,
        },
      ],
    },
  });

  await waitUntilReady(bridgePort, child);
  assert.match(output(), /没有可用的 x-api-key/);
  assert.match(output(), /--import-gateway-key/);
  assert.ok(
    !output().includes('plat_present_but_not_imported'),
    '运行期不应该读取 Codex 配置里的凭据'
  );
});

test('--import-gateway-key copies the credential into the metabridge config', async t => {
  const { dir, codexHome } = makeWorkspace(t, {
    codexConfigToml: [
      '[model_providers.byteseed]',
      'name                 = "OpenAI"',
      'http_headers         = { "x-api-key" = "plat_imported_from_codex" }',
      '',
    ].join('\n'),
  });

  const result = await runImport(t, {
    dir,
    codexHome,
    config: {
      officialModels: { enabled: false },
      backends: [{
        name: 'gateway-test',
        base: 'http://127.0.0.1:1',
        prefix: '',
        auth: { type: 'gateway', key: '' },
      }],
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.config().backends[0].auth.key, 'plat_imported_from_codex');
  assert.ok(!result.output.includes('plat_imported_from_codex'), '导入输出不应打印明文 key');
  assert.equal(
    fs.statSync(path.join(dir, 'config.json')).mode & 0o777,
    0o600,
    '导入后配置文件应收紧到 600'
  );
});

test('--import-gateway-key resolves env_http_headers indirection', async t => {
  const { dir, codexHome } = makeWorkspace(t, {
    codexConfigToml: [
      '[model_providers.byteseed]',
      'env_http_headers     = { "x-api-key" = "MB_TEST_GATEWAY_KEY" }',
      '',
    ].join('\n'),
  });

  const result = await runImport(t, {
    dir,
    codexHome,
    env: { MB_TEST_GATEWAY_KEY: 'plat_imported_from_env' },
    config: {
      officialModels: { enabled: false },
      backends: [{
        name: 'gateway-test',
        base: 'http://127.0.0.1:1',
        prefix: '',
        auth: { type: 'gateway', key: '' },
      }],
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.config().backends[0].auth.key, 'plat_imported_from_env');
});

test('--import-gateway-key refuses to overwrite a different key without --force', async t => {
  const codexConfigToml = [
    '[model_providers.byteseed]',
    'http_headers = { "x-api-key" = "plat_incoming_key" }',
    '',
  ].join('\n');
  const config = {
    officialModels: { enabled: false },
    backends: [{
      name: 'gateway-test',
      base: 'http://127.0.0.1:1',
      prefix: '',
      auth: { type: 'gateway', key: 'plat_existing_key' },
    }],
  };

  const blocked = await runImport(t, { ...makeWorkspace(t, { codexConfigToml }), config });
  assert.equal(blocked.code, 1);
  assert.match(blocked.output, /--force/);
  assert.equal(blocked.config().backends[0].auth.key, 'plat_existing_key');

  const forced = await runImport(t, {
    ...makeWorkspace(t, { codexConfigToml }),
    config,
    args: ['--force'],
  });
  assert.equal(forced.code, 0);
  assert.equal(forced.config().backends[0].auth.key, 'plat_incoming_key');
});

test('missing backends fails instead of implicitly provisioning backends', async t => {
  const { dir, codexHome } = makeWorkspace(t);
  const { child, output } = startBridge(t, {
    dir,
    codexHome,
    env: { MB_PORT: String(await reservePort()) },
    config: {},
  });

  assert.equal(await waitForExit(child), 1);

  assert.match(output(), /backends 必须是非空数组/);
  assert.doesNotMatch(output(), /没有可用的 x-api-key/);
});
