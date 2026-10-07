'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

/**
 * 起一个只提供模型目录的 bridge，用于断言 ModelInfo 里的窗口字段。
 */
async function startBridge(t, extraConfig) {
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return jsonResponse(res, {
        object: 'list',
        data: [
          { id: 'big-1m', object: 'model', owned_by: 'test', context_window: 936_000 },
          { id: 'small', object: 'model', owned_by: 'test', context_window: 240_000 },
        ],
      });
    }
    jsonResponse(res, { error: 'not found' }, 404);
  });

  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const reservation = http.createServer();
  const bridgePort = await listen(reservation);
  await close(reservation);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-ctx-window-test-'));
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port: bridgePort,
    catalogTtlMs: 60_000,
    officialModels: { enabled: false },
    backends: [{
      name: 'upstream-test',
      base: `http://127.0.0.1:${upstreamPort}`,
      prefix: '',
      auth: { type: 'none' },
      priority: 50,
      reasoning: 'full',
    }],
    ...extraConfig,
  }));

  let childLogs = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      MB_CONFIG_FILE: configPath,
      MB_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { childLogs += chunk.toString(); });
  child.stderr.on('data', chunk => { childLogs += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitUntilReady(bridgePort, child);

  async function modelInfo() {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`);
    assert.equal(response.status, 200, childLogs);
    const body = await response.json();
    return Object.fromEntries(body.models.map(m => [m.slug, m]));
  }

  return { modelInfo, logs: () => childLogs };
}

test('bridge 原样上报窗口，不再压制，也不发 effective_context_window_percent', async t => {
  const { modelInfo } = await startBridge(t, {});
  const models = await modelInfo();

  // 上游报多少就是多少，1M 系列不再被压到 750K
  assert.equal(models['big-1m'].context_window, 936_000);
  assert.equal(models['big-1m'].max_context_window, 936_000);
  assert.equal(models['small'].context_window, 240_000);

  // 字段完全不发：Codex 自己填默认值（实测省略时 Codex 用 95，与官方模型一致）
  assert.ok(
    !('effective_context_window_percent' in models['big-1m']),
    'bridge 不应上报 effective_context_window_percent'
  );
  assert.ok(!('effective_context_window_percent' in models['small']));
});

test('配置里残留的旧窗口键被完全无视', async t => {
  const { modelInfo } = await startBridge(t, {
    effectiveContextWindowPercent: 60,
    maxEffectiveContextTokens: 500_000,
  });
  const models = await modelInfo();

  assert.equal(models['big-1m'].context_window, 936_000, '旧键不能再压窗口');
  assert.ok(!('effective_context_window_percent' in models['big-1m']));
});
