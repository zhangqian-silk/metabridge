'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('CPA migration stages file credentials and permitted models without changing live configuration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cpa-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = { cmd: 'private-command-fixture', gateway: 'private-gateway-fixture' };
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${req.url.startsWith('/cmd') ? secrets.cmd : secrets.gateway}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: req.url.startsWith('/cmd')
      ? [{ id: 'allowed' }, { id: 'blocked' }, { id: 'google/gemini-3.8-flash' }]
      : [{ id: 'gateway-model' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  fs.mkdirSync(path.join(dir, 'providers'));
  fs.writeFileSync(path.join(dir, 'cmd-key'), secrets.cmd);
  const config = { providerFiles: ['providers/cmd.json', 'providers/gateway.json'] };
  const write = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  write('config.json', config);
  write('providers/cmd.json', { name: 'cmd', protocol: 'command-code', base_url: `${base}/cmd/v1`,
    modelFilter: { allow: [{ regex: '^(allowed|google/gemini-3\\.8-flash)$' }], deny: ['blocked'] },
    reasoningRules: [{ match: 'allowed', levels: ['high'], default: 'high' }],
    auth: { type: 'keyfile', file: '../cmd-key' } });
  write('providers/gateway.json', { name: 'gateway', base_url: `${base}/gateway/v1`,
    auth: { type: 'static', key: secrets.gateway } });
  async function run(args = []) {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/migrate-to-cpa.js'), ...args], {
      env: { ...process.env, MB_CONFIG_FILE: path.join(dir, 'config.json'),
        CPA_CONFIG_DIR: path.join(dir, 'cpa') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    for (const secret of Object.values(secrets)) assert.equal(output.includes(secret), false);
    return { code, output };
  }
  const result = await run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))), config);
  const cpaPath = path.join(dir, 'cpa/config.json');
  const cpa = JSON.parse(fs.readFileSync(cpaPath));
  assert.equal(fs.statSync(cpaPath).mode & 0o777, 0o600);
  assert.equal(cpa.server.host, '127.0.0.1');
  assert.equal(cpa.routing['force-model-prefix'], true);
  const cmd = cpa['api-keys']['openai-compatibility'][0];
  assert.equal(cmd.prefix, 'cmd');
  assert.deepEqual(cmd.models.map(m => m.name), ['allowed', 'google/gemini-3.8-flash']);
  assert.deepEqual(cmd.models[0].thinking.levels, ['high']);
  assert.deepEqual(cpa.payload, require('../providers/cpa-gemini-payload.example.json'));
  assert.equal(cmd.keys[0]['api-key'], secrets.cmd);
  assert.equal(cpa['api-keys'].codex[0].keys[0]['api-key'], secrets.gateway);
  assert.equal((await run()).code, 1, 're-run must not overwrite existing credentials');
  assert.equal((await run(['--activate'])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).providerFiles,
    ['providers/openai-subscription.json', 'providers/cpa.json']);
});
