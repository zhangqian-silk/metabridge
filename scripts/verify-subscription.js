#!/usr/bin/env node
'use strict';

// Opt-in live smoke test: one tiny inference request using the CLI's login.
// No auth.json reads, token copies, permanent configuration, or service restarts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-live-verify-'));
  const children = [];
  async function stop(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exit; } finally { clearTimeout(timer); }
  }
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void Promise.all(children.map(stop)).catch(() => {});
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const reserve = http.createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const config = {
      host: '127.0.0.1', port, logLevel: 'silent',
      providerFiles: ['subscription.json', 'mock-catalog.json'],
    };
    const official = { ...require('../providers/openai-subscription.example.json'), priority: 0 };
    const mock = {
      name: 'mock-catalog', prefix: 'mock/', displayPrefix: '验证目录',
      base: 'http://127.0.0.1:1', priority: 100, auth: { type: 'none' },
      catalog: { source: 'static', models: [{ id: 'not-a-real-model' }] },
    };
    for (const [name, value] of Object.entries({
      'config.json': config, 'subscription.json': official, 'mock-catalog.json': mock,
    })) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
    }
    const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: dir, env: { ...process.env, MB_CONFIG_FILE: path.join(dir, 'config.json'),
        MB_PORT: String(port), MB_HOST: '127.0.0.1', MB_LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(bridge);
    bridge.on('error', () => {});
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (cancelled) throw new Error('验证已取消');
      if (bridge.exitCode !== null) throw new Error('临时 bridge 启动失败');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (health.degraded) throw new Error(`目录不健康：${health.degraded}`);
        if (response.ok) { ready = true; break; }
      } catch (error) {
        if (error.message.startsWith('目录不健康')) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('临时 bridge 未在期限内就绪');
    const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const model = process.argv[2] || 'gpt-5.6-sol';
    if (!catalog.models.some(item => item.slug === model)) throw new Error(`目录不存在模型 ${model}`);
    const sample = catalog.models.find(item => item.slug === 'mock/not-a-real-model');
    if (sample?.display_name !== '验证目录 · not-a-real-model') throw new Error('合并目录展示验证失败');
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ models: catalog.models }), { mode: 0o600 });
    console.log(JSON.stringify({ stage: 'catalog', count: catalog.models.length,
      official: catalog.models.find(item => item.slug === model).display_name,
      mock: sample.display_name, mockIsCallable: false }));

    if (cancelled) throw new Error('验证已取消');
    const cli = spawn('codex', [
      'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--json', '--color', 'never',
      '-c', 'model_provider="metabridge-verify"',
      '-c', 'model_providers.metabridge-verify.name="OpenAI"',
      '-c', `model_providers.metabridge-verify.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.metabridge-verify.wire_api="responses"',
      '-c', 'model_providers.metabridge-verify.requires_openai_auth=true',
      '-c', 'model_providers.metabridge-verify.supports_websockets=false',
      '-c', `model_catalog_json=${JSON.stringify(path.join(dir, 'catalog.json'))}`,
      '-c', 'model_reasoning_effort="low"',
      '-m', model,
      'Reply exactly METABRIDGE_OK. Do not use tools, access files, or execute commands.',
    ], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(cli);
    let output = '';
    let diagnostic = '';
    cli.stdout.on('data', chunk => { output += chunk; });
    cli.stderr.on('data', chunk => { diagnostic += chunk; });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void stop(cli); }, 90000);
    let code;
    try { [code] = await once(cli, 'exit'); }
    finally { clearTimeout(timeout); }
    const events = output.trim().split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const answer = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
      .map(event => event.item.text).join('\n');
    const errors = events.filter(event => event.type === 'error' || event.type === 'turn.failed');
    console.log(JSON.stringify({ stage: 'inference', model, code, timedOut, answer,
      errors, diagnostic: code === 0 ? undefined : diagnostic.slice(-4000) }));
    if (timedOut || code !== 0 || answer.trim() !== 'METABRIDGE_OK') {
      throw new Error('真实订阅验证未通过，见上面的客户端诊断');
    }
  } finally {
    await Promise.all(children.map(stop));
    fs.rmSync(dir, { recursive: true, force: true });
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
