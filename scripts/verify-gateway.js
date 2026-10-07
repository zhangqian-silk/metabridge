#!/usr/bin/env node
'use strict';

// Live catalog + minimal Responses request through an isolated bridge.
// References the user's provider file; never copies or prints the API key.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readJson, loadProviders } = require('../provider-config');

async function main() {
  const configFile = path.resolve(process.argv[2] || process.env.MB_CONFIG_FILE ||
    path.join(os.homedir(), '.metabridge', 'config.json'));
  const backendName = process.argv[4] || 'gateway';
  const provider = loadProviders(readJson(configFile), configFile)
    .find(provider => provider.name === backendName);
  if (!provider?._sourceFile) throw new Error('需要已配置的独立网关 provider 文件');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-gateway-verify-'));
  let bridge;
  async function stop() {
    if (!bridge?.pid || bridge.exitCode !== null || bridge.signalCode !== null) return;
    const exit = once(bridge, 'exit');
    bridge.kill('SIGTERM');
    const timer = setTimeout(() => bridge.kill('SIGKILL'), 2000);
    try { await exit; } finally { clearTimeout(timer); }
  }
  let cancelled = false;
  const cancel = () => { cancelled = true; void stop().catch(() => {}); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const reserve = http.createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const config = { port, host: '127.0.0.1', logLevel: 'silent', officialModels: { enabled: false },
      providerFiles: [provider._sourceFile] };
    const temporaryConfig = path.join(dir, 'config.json');
    fs.writeFileSync(temporaryConfig, JSON.stringify(config), { mode: 0o600 });
    bridge = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      cwd: dir, env: { ...process.env, MB_CONFIG_FILE: temporaryConfig, MB_HOST: '127.0.0.1',
        MB_PORT: String(port), MB_LOG_LEVEL: 'silent' }, stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let i = 0; i < 120; i++) {
      if (cancelled || bridge.exitCode !== null) throw new Error('验证取消或临时 bridge 已退出');
      try {
        health = await (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).json();
        break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!health || health.degraded) {
      const redact = value => String(value || '').split(provider.auth?.key || '\0').join('[REDACTED]');
      console.log(JSON.stringify({ stage: 'health', degraded: redact(health?.degraded),
        backend: health?.backends?.[provider.name]?.ok, bridgeExit: bridge.exitCode }));
      throw new Error('临时 bridge 目录未就绪或上游不可用');
    }
    const catalog = await (await fetch(`${base}/v1/models`)).json();
    const preferred = process.argv[3];
    const expected = preferred ? `${provider.prefix || ''}${preferred}` : null;
    const selected = expected ? catalog.data.find(model => model.id === expected) : catalog.data[0];
    if (!selected) throw new Error('目录中不存在指定的测试模型');
    console.log(JSON.stringify({ stage: 'catalog', status: 200, count: catalog.data.length,
      model: selected.id, display: selected.display_name }));
    if (cancelled) throw new Error('验证已取消');
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: selected.id, store: false, stream: true,
        instructions: 'Reply exactly GATEWAY_OK. Do not call tools.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Connection test.' }] }] }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    const events = text.trim().startsWith('{') ? [JSON.parse(text)] : text.split('\n').flatMap(line => {
      if (!line.startsWith('data:')) return [];
      try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
    });
    const terminal = events.findLast(event => event.type === 'response.completed')?.response ||
      events.find(event => event.status === 'completed');
    const message = terminal?.output?.flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('') ||
      events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('');
    console.log(JSON.stringify({ stage: 'inference', status: response.status,
      completed: !!terminal, answer: message || '', upstreamError: events.some(event =>
        event.error || event.type === 'response.failed' || event.type === 'error') }));
    if (!response.ok || !terminal || message.trim() !== 'GATEWAY_OK') {
      throw new Error('真实 gateway 推理验证未通过；未输出上游错误正文，以免回显凭据');
    }
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
